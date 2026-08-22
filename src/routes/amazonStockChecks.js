import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import pLimit from 'p-limit';
import { parseStringPromise } from 'xml2js';
import { requireAuth, requirePageAccess, requireFeatureAccess } from '../middleware/auth.js';

// Feature id used to gate who may run Estimate/Start on this page (superadmin
// always allowed; others must be explicitly granted via /feature-permissions).
export const AMAZON_STOCK_CHECK_RUN_FEATURE_ID = 'amazonStockCheck.run';

// Pages allowed to use these endpoints. SellerSkuStockCheck is the
// seller-scoped variant of the Amazon Stock Check page.
const STOCK_CHECK_PAGES = ['AmazonStockCheck', 'SellerSkuStockCheck'];
import SellerSkuIndex from '../models/SellerSkuIndex.js';
import TemplateListing from '../models/TemplateListing.js';
import Seller from '../models/Seller.js';
import Order from '../models/Order.js';
import AmazonStockCheckRun from '../models/AmazonStockCheckRun.js';
import AmazonStockCheckItem from '../models/AmazonStockCheckItem.js';
import AmazonStockSkuState from '../models/AmazonStockSkuState.js';
import AmazonStockActionLog from '../models/AmazonStockActionLog.js';
import EndListingLog from '../models/EndListingLog.js';
import ListingRevision from '../models/ListingRevision.js';
import SellerPricingConfig from '../models/SellerPricingConfig.js';
import { ensureValidToken } from './ebay.js';
import { getEffectiveTemplate } from '../utils/templateMerger.js';
import { hostImagesOnEbay, hostsAreUniform, IMAGE_LIST_SEPARATOR, splitImageList } from '../utils/overlayImage.js';
import {
  buildItemSpecifics,
  buildReviseUsageContext,
  generateListingFromAsin,
  regionForCurrency,
  resolveAvailableSku
} from '../utils/reviseListingGenerator.js';

const router = express.Router();
const activeRuns = new Set();

// postalCode pins the Amazon delivery location the scraper sees, so stock
// results are measured from a consistent place instead of a random datacenter
// location. Override per country via env if needed; set to '' to disable.
const COUNTRY_CONFIG = {
  USD: { currency: 'USD', country: 'United States', domain: 'com', scrapingdogCountry: 'us', credits: 1, postalCode: process.env.SCRAPINGDOG_POSTAL_USD ?? '82801' },
  AUD: { currency: 'AUD', country: 'Australia', domain: 'com.au', scrapingdogCountry: 'au', credits: 5, postalCode: process.env.SCRAPINGDOG_POSTAL_AUD ?? '2000' },
  CAD: { currency: 'CAD', country: 'Canada', domain: 'ca', scrapingdogCountry: 'ca', credits: 5, postalCode: process.env.SCRAPINGDOG_POSTAL_CAD ?? 'A1A 1A1' },
  GBP: { currency: 'GBP', country: 'United Kingdom', domain: 'co.uk', scrapingdogCountry: 'gb', credits: 5, postalCode: process.env.SCRAPINGDOG_POSTAL_GBP ?? 'SW1A 1AA' }
};

const PILOT_OPTION_B_LIMITS = {
  USD: 100,
  AUD: 10,
  CAD: 5,
  GBP: 4
};
const SCRAPINGDOG_CONCURRENT = Math.max(1, Number.parseInt(process.env.SCRAPINGDOG_CONCURRENT || '40', 10));
// Identifies which server instance owns/resumes stock check runs — same
// convention as auto-compat batches (ebay.js). Set RUNNER_ID=render in
// Render's env vars, leave unset (defaults to 'local') on dev machines.
const RUNNER_ID = (process.env.RUNNER_ID || 'local').trim().toLowerCase();
// Delay before the single retry attempt for "ambiguous" unknown_stock_text
// results (has a returns policy, but stock/price text didn't render) — gives
// Amazon's async buy-box widget a moment longer to populate on re-scrape.
const UNKNOWN_STOCK_RETRY_DELAY_MS = Math.max(500, Number.parseInt(process.env.AMAZON_STOCK_UNKNOWN_RETRY_DELAY_MS || '3000', 10));
// Delay before the single retry attempt for outright request failures
// (timeouts, 429, 5xx) that classifyStockCheckError marks retryable — these
// are transient Scrapingdog/Amazon infrastructure hiccups, not data-shape
// issues, so a plain re-request (no special parsing) is the fix.
const ERROR_RETRY_DELAY_MS = Math.max(500, Number.parseInt(process.env.AMAZON_STOCK_ERROR_RETRY_DELAY_MS || '3000', 10));
const EBAY_QUANTITY_CONCURRENT = Math.max(1, Number.parseInt(process.env.EBAY_QUANTITY_CONCURRENT || '5', 10));
const STOCK_PROCESS_BATCH_SIZE = Math.max(100, Number.parseInt(process.env.AMAZON_STOCK_PROCESS_BATCH_SIZE || '1000', 10));
const PREPARE_CHUNK_SIZE = Math.max(100, Number.parseInt(process.env.AMAZON_STOCK_PREPARE_CHUNK_SIZE || '1000', 10));
const RUN_ITEM_INSERT_BATCH_SIZE = Math.max(100, Number.parseInt(process.env.AMAZON_STOCK_ITEM_INSERT_BATCH_SIZE || '2000', 10));
const scrapingdogLimit = pLimit(SCRAPINGDOG_CONCURRENT);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stockCheckLog(stage, details = {}) {
  console.log(`[Amazon Stock Check] ${stage}`, {
    timestamp: new Date().toISOString(),
    ...details
  });
}

function stockCheckWarn(stage, details = {}) {
  console.warn(`[Amazon Stock Check] ${stage}`, {
    timestamp: new Date().toISOString(),
    ...details
  });
}

function getElapsedMs(startedAt) {
  return Date.now() - startedAt;
}

async function flushStockCheckItemBatch(batch) {
  if (!batch.length) return;
  await AmazonStockCheckItem.insertMany(batch, { ordered: false });
  batch.length = 0;
}

function isTransientMongoError(error) {
  const message = String(error?.message || '').toLowerCase();
  const name = String(error?.name || '').toLowerCase();
  return (
    name.includes('mongonetwork') ||
    name.includes('mongoserverselection') ||
    message.includes('timed out') ||
    message.includes('etimedout') ||
    message.includes('server selection') ||
    message.includes('replicasetnoprimary') ||
    message.includes('topology')
  );
}

async function withMongoRetry(label, operation, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientMongoError(error) || attempt === attempts) break;
      const delayMs = attempt * 5000;
      console.warn(`[Amazon Stock Check] ${label} failed on attempt ${attempt}/${attempts}: ${error.message}. Retrying in ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function normalizeCurrency(value) {
  const cur = String(value || '').trim().toUpperCase();
  if (cur === 'GB') return 'GBP';
  return cur;
}

export function getConfig(currency) {
  return COUNTRY_CONFIG[normalizeCurrency(currency)] || null;
}

// Raw currency values to match in the SKU index for a normalized currency.
// Legacy UK rows were synced with currency "GB" instead of "GBP"; the other
// currencies are stored consistently and need no alias.
function currencyAliases(currency) {
  const normalized = normalizeCurrency(currency);
  return normalized === 'GBP' ? ['GBP', 'GB'] : [normalized];
}

function cleanSku(value) {
  return String(value || '').trim();
}

function getBaseLabel(value) {
  return cleanSku(value).split('-')[0].trim();
}

function cleanAsin(value) {
  return String(value || '').trim().toUpperCase();
}

function isAmazonAsin(value) {
  return /^[A-Z0-9]{10}$/.test(cleanAsin(value)) && cleanAsin(value).startsWith('B0');
}

function estimateCredits(candidates) {
  return candidates.reduce((sum, row) => sum + (getConfig(row.currency)?.credits || 0), 0);
}

export function parseStockStatus(payload, threshold = 5) {
  const singleOffer = payload?.purchase_options?.single_offer || {};
  const text = String(singleOffer.stock || payload?.availability_status || '').trim();
  const normalized = text.toLowerCase();
  const qtyMatch = normalized.match(/only\s+(\d+)\s+left/);
  const stockQuantity = qtyMatch ? Number.parseInt(qtyMatch[1], 10) : null;

  if (stockQuantity != null) {
    return {
      status: stockQuantity < threshold ? 'low_stock' : 'in_stock',
      stockQuantity,
      availabilityText: text || `Only ${stockQuantity} left`
    };
  }

  if (
    normalized.includes('currently unavailable') ||
    normalized.includes('out of stock') ||
    normalized.includes('unavailable')
  ) {
    return { status: 'out_of_stock', stockQuantity: null, availabilityText: text || 'Unavailable' };
  }

  if (normalized.includes('in stock')) {
    return { status: 'in_stock', stockQuantity: null, availabilityText: text || 'In Stock' };
  }

  if (text) {
    return { status: 'in_stock', stockQuantity: null, availabilityText: text };
  }

  // No stock/availability text, but a real price is present — direct proof of
  // an active, purchasable offer (Scrapingdog doesn't always emit an explicit
  // stock string for every listing template, confirmed against production
  // data where price/delivery/variants were all populated but stock was not,
  // even after a retry). Kept as its own status rather than folded into
  // "in_stock" since it's inferred from price, not confirmed by Amazon's own
  // wording — no retry needed, this is a definite signal, not an ambiguous one.
  const singleOfferPrice = singleOffer.price || singleOffer.extracted_price || null;
  if (singleOfferPrice) {
    return {
      status: 'in_stock_unconfirmed',
      stockQuantity: null,
      availabilityText: `Price found (${singleOffer.price ?? singleOffer.extracted_price}) but no explicit stock text`
    };
  }

  // No stock/availability text and no price either. Amazon only renders a
  // returns/refund policy line when a listing has an active, purchasable
  // offer; a dead ("Currently unavailable") listing's purchase box shows only
  // the ships_from/sold_by headers with no returns entry at all. Confirmed
  // against several real listings (both dead and live) in production data.
  const features = singleOffer.features || null;
  const hasActiveOfferSignal = Boolean(features) && Object.prototype.hasOwnProperty.call(features, 'returns');

  if (features && !hasActiveOfferSignal) {
    return {
      status: 'out_of_stock',
      stockQuantity: null,
      availabilityText: 'No active offer detected (no returns policy shown)'
    };
  }

  return {
    status: 'unknown_stock_text',
    stockQuantity: null,
    availabilityText: 'No stock availability text found',
    hasActiveOfferSignal
  };
}

export function classifyStockCheckError(error) {
  const status = error?.response?.status || null;
  const message = error?.message || 'Stock check failed';
  if (status) {
    // axios's own message is just "Request failed with status code 404" —
    // Scrapingdog's response body usually explains the actual reason (invalid
    // ASIN, plan/credit limit, concurrent-request limit, etc.), so surface it
    // when present instead of discarding it.
    const body = error?.response?.data;
    const bodyText = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
    const detail = bodyText ? bodyText.slice(0, 300) : '';
    return {
      errorType: `scrapingdog_http_${status}`,
      errorSource: 'scrapingdog',
      retryable: status === 408 || status === 429 || status >= 500,
      message: detail ? `${message}: ${detail}` : message
    };
  }
  if (error?.code === 'ECONNABORTED' || /timeout/i.test(message)) {
    return {
      errorType: 'scrapingdog_timeout',
      errorSource: 'scrapingdog',
      retryable: true,
      message
    };
  }
  if (/SCRAPINGDOG_API_KEY/i.test(message)) {
    return {
      errorType: 'configuration',
      errorSource: 'server',
      retryable: false,
      message
    };
  }
  return {
    errorType: 'stock_check_failed',
    errorSource: 'server',
    retryable: true,
    message
  };
}

async function getRunStatus(runId) {
  const run = await AmazonStockCheckRun.findById(runId).select('status').lean();
  return run?.status || '';
}

// includePostalCode defaults to false: Scrapingdog confirmed passing
// postal_code was the root cause of a large, sustained wave of 400 errors
// (see amazonStockChecks.js processStockItem call sites) — opt back in
// explicitly only if deliberately testing with it again.
export async function fetchScrapingdogProduct({ asin, currency, timeoutMs = 45000, includePostalCode = false }) {
  const config = getConfig(currency);
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) {
    throw new Error('SCRAPINGDOG_API_KEY is not configured');
  }

  const response = await axios.get('https://api.scrapingdog.com/amazon/product', {
    params: {
      api_key: apiKey,
      domain: config.domain,
      country: config.scrapingdogCountry,
      ...(includePostalCode && config.postalCode ? { postal_code: config.postalCode } : {}),
      asin
    },
    timeout: timeoutMs
  });

  return {
    statusCode: response.status,
    data: response.data
  };
}

async function reviseInventoryQuantity({ sellerId, itemId, quantity, runId, itemDocId, sku, asin, requestedBy }) {
  const log = await AmazonStockActionLog.create({
    run: runId,
    item: itemDocId,
    sku,
    asin,
    seller: sellerId,
    itemId,
    actionType: quantity === 0 ? 'set_quantity_zero' : 'set_quantity_one',
    requestedBy,
    status: 'pending',
    requestPayload: { quantity }
  });

  try {
    const seller = await Seller.findById(sellerId);
    if (!seller) throw new Error('Seller not found');

    const accessToken = await ensureValidToken(seller);
    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${accessToken}</eBayAuthToken>
  </RequesterCredentials>
  <InventoryStatus>
    <ItemID>${itemId}</ItemID>
    <Quantity>${quantity}</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`;

    const tradingRes = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1271',
        'X-EBAY-API-CALL-NAME': 'ReviseInventoryStatus',
        'X-EBAY-API-IAF-TOKEN': accessToken,
        'Content-Type': 'text/xml'
      },
      timeout: 45000
    });

    const parsed = await parseStringPromise(tradingRes.data, { explicitArray: false });
    const ack = parsed?.ReviseInventoryStatusResponse?.Ack;
    if (ack !== 'Success' && ack !== 'Warning') {
      const errorMsg = parsed?.ReviseInventoryStatusResponse?.Errors?.ShortMessage || 'Unknown eBay quantity update error';
      throw new Error(errorMsg);
    }

    await AmazonStockActionLog.findByIdAndUpdate(log._id, {
      status: 'success',
      responseSummary: { ack }
    });
    return { ok: true };
  } catch (error) {
    await AmazonStockActionLog.findByIdAndUpdate(log._id, {
      status: 'failed',
      error: error.message || 'Quantity update failed'
    });
    return { ok: false, error: error.message || 'Quantity update failed' };
  }
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Revises title/price on eBay (ReviseFixedPriceItem) and logs the action —
// self-contained like reviseInventoryQuantity/end-item, not tied to a
// specific run or AmazonStockCheckItem, so it works the same regardless of
// which run/seller page triggered it.
async function reviseListingDetails({ sellerId, itemId, title, price, previousTitle, previousPrice, sku, asin, requestedBy }) {
  const log = await AmazonStockActionLog.create({
    sku: sku || '',
    asin: asin || '',
    seller: sellerId,
    itemId,
    actionType: 'revise_listing',
    requestedBy,
    status: 'pending',
    requestPayload: { title, price, previousTitle, previousPrice }
  });

  try {
    const seller = await Seller.findById(sellerId);
    if (!seller) throw new Error('Seller not found');

    const accessToken = await ensureValidToken(seller);
    let itemContent = `<ItemID>${itemId}</ItemID>`;
    if (title) itemContent += `<Title>${escapeXmlText(title)}</Title>`;
    if (price != null) itemContent += `<StartPrice>${Number(price).toFixed(2)}</StartPrice>`;

    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${accessToken}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>Low</WarningLevel>
  <Item>${itemContent}</Item>
</ReviseFixedPriceItemRequest>`;

    const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
        'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
        'Content-Type': 'text/xml'
      },
      timeout: 45000
    });

    const parsed = await parseStringPromise(response.data, { explicitArray: false });
    const ack = parsed?.ReviseFixedPriceItemResponse?.Ack;
    if (ack !== 'Success' && ack !== 'Warning') {
      const errors = parsed?.ReviseFixedPriceItemResponse?.Errors;
      const errorMsg = (Array.isArray(errors) ? errors[0]?.LongMessage : errors?.LongMessage) || 'Unknown eBay revise error';
      throw new Error(errorMsg);
    }

    await AmazonStockActionLog.findByIdAndUpdate(log._id, { status: 'success', responseSummary: { ack } });
    return { ok: true };
  } catch (error) {
    await AmazonStockActionLog.findByIdAndUpdate(log._id, {
      status: 'failed',
      error: error.message || 'Revise failed'
    });
    return { ok: false, error: error.message || 'Revise failed' };
  }
}

async function getSellerNameMap(sellerIds) {
  const sellers = await Seller.find({ _id: { $in: sellerIds } }).populate('user', 'username name email').lean();
  return new Map(sellers.map((seller) => [
    String(seller._id),
    seller.user?.username || seller.user?.name || seller.user?.email || String(seller._id)
  ]));
}

async function buildOrderSummaryMapForSellerItems(sellerItems) {
  const itemIds = [...new Set(sellerItems.map((row) => row.itemId).filter(Boolean))];
  if (!itemIds.length) return new Map();

  const startedAt = Date.now();
  const orders = await Order.aggregate([
    {
      $match: {
        $or: [
          { itemNumber: { $in: itemIds } },
          { 'lineItems.legacyItemId': { $in: itemIds } }
        ]
      }
    },
    {
      $project: {
        seller: 1,
        dateSold: 1,
        creationDate: 1,
        itemNumber: 1,
        lineItems: 1
      }
    }
  ]);
  stockCheckLog('enrichCandidates:orderLookupComplete', {
    sellerItemCount: sellerItems.length,
    itemIdCount: itemIds.length,
    orderCount: orders.length,
    elapsedMs: getElapsedMs(startedAt)
  });

  const since90 = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const orderMap = new Map();
  for (const order of orders) {
    const ids = new Set();
    if (order.itemNumber) ids.add(order.itemNumber);
    for (const lineItem of order.lineItems || []) {
      if (lineItem?.legacyItemId) ids.add(lineItem.legacyItemId);
    }
    for (const itemId of ids) {
      const key = `${String(order.seller)}:${itemId}`;
      const current = orderMap.get(key) || { count: 0, count90: 0, lastOrderDate: null };
      const orderDate = order.dateSold || order.creationDate || null;
      current.count += 1;
      if (orderDate && new Date(orderDate).getTime() >= since90) current.count90 += 1;
      if (orderDate && (!current.lastOrderDate || new Date(orderDate) > new Date(current.lastOrderDate))) {
        current.lastOrderDate = orderDate;
      }
      orderMap.set(key, current);
    }
  }

  return orderMap;
}

function attachOrderSummariesFromMap(sellerItems, orderMap) {
  return sellerItems.map((row) => {
    const summary = orderMap.get(`${String(row.sellerId)}:${row.itemId}`);
    return {
      ...row,
      orderCount: summary?.count || 0,
      orderCount90d: summary?.count90 || 0,
      lastOrderDate: summary?.lastOrderDate || null
    };
  });
}

async function buildCandidates({ currencies, mode, limit, sellerId }) {
  const startedAt = Date.now();
  stockCheckLog('buildCandidates:start', { currencies, mode, limit: limit || null, sellerId: sellerId ? String(sellerId) : null });
  const candidates = [];
  for (const currency of currencies) {
    const config = getConfig(currency);
    if (!config) continue;
    const runLimit = mode === 'pilot_option_b'
      ? PILOT_OPTION_B_LIMITS[config.currency]
      : Number.parseInt(limit, 10) || null;

    const currencyStartedAt = Date.now();
    const match = { currency: { $in: currencyAliases(config.currency) }, sku: { $ne: '' } };
    if (sellerId) match.seller = new mongoose.Types.ObjectId(String(sellerId));
    // One candidate per BASE SKU: variant listings like GRW25X-1 fold into
    // GRW25X so the same product is checked (and billed) once per currency.
    const rows = await SellerSkuIndex.aggregate([
      { $match: match },
      {
        $addFields: {
          groupKey: {
            $let: {
              vars: { base: { $ifNull: ['$baseSku', ''] } },
              in: { $cond: [{ $eq: ['$$base', ''] }, '$sku', '$$base'] }
            }
          }
        }
      },
      {
        $group: {
          _id: '$groupKey',
          currency: { $first: '$currency' },
          sellers: { $addToSet: '$seller' },
          itemCount: { $sum: 1 }
        }
      },
      { $project: { _id: 0, sku: '$_id', baseSku: '$_id', currency: 1, sellers: 1, itemCount: 1 } },
      { $sort: { sku: 1 } },
      ...(runLimit ? [{ $limit: runLimit }] : [])
    ]).allowDiskUse(true);
    stockCheckLog('buildCandidates:currencyComplete', {
      currency: config.currency,
      runLimit,
      rowCount: rows.length,
      elapsedMs: getElapsedMs(currencyStartedAt)
    });

    for (const row of rows) {
      candidates.push({
        sku: cleanSku(row.sku),
        baseSku: cleanSku(row.baseSku),
        sellers: row.sellers || [],
        currency: config.currency,
        country: config.country
      });
    }
  }
  stockCheckLog('buildCandidates:complete', {
    candidateCount: candidates.length,
    elapsedMs: getElapsedMs(startedAt)
  });
  return candidates;
}

async function enrichCandidates(candidates, { includeSellerItems = true } = {}) {
  const startedAt = Date.now();
  const skus = [...new Set(candidates.map((row) => row.sku).filter(Boolean))];
  const lookupLabels = [...new Set(candidates.map((row) => row.baseSku).map(getBaseLabel).filter(Boolean))];
  stockCheckLog('enrichCandidates:start', {
    candidateCount: candidates.length,
    skuCount: skus.length,
    lookupLabelCount: lookupLabels.length,
    includeSellerItems
  });

  const templateStartedAt = Date.now();
  const templateRows = [];
  const seenTemplateIds = new Set();
  const addTemplateRows = (rows) => {
    for (const row of rows) {
      const id = String(row._id);
      if (seenTemplateIds.has(id)) continue;
      seenTemplateIds.add(id);
      templateRows.push(row);
    }
  };

  if (lookupLabels.length) {
    const indexedLookupStartedAt = Date.now();
    const indexedRows = await TemplateListing.find({
      baseCustomLabel: { $in: lookupLabels },
      _asinReference: { $exists: true, $ne: '' }
    })
      .select('customLabel baseCustomLabel +_asinReference')
      .collation({ locale: 'en', strength: 2 })
      .lean();
    addTemplateRows(indexedRows);
    stockCheckLog('enrichCandidates:templateIndexedLookupComplete', {
      templateRowCount: indexedRows.length,
      elapsedMs: getElapsedMs(indexedLookupStartedAt)
    });
  }
  stockCheckLog('enrichCandidates:templateLookupComplete', {
    templateRowCount: templateRows.length,
    elapsedMs: getElapsedMs(templateStartedAt)
  });

  const asinByLabel = new Map();
  for (const row of templateRows) {
    const label = getBaseLabel(row.baseCustomLabel || row.customLabel).toUpperCase();
    const asin = cleanAsin(row._asinReference);
    if (!asinByLabel.has(label)) asinByLabel.set(label, asin);
  }

  if (!includeSellerItems) {
    const enriched = candidates.map((row) => {
      const baseSku = getBaseLabel(row.baseSku);
      const directAsin = isAmazonAsin(row.baseSku) ? cleanAsin(row.baseSku) : (isAmazonAsin(row.sku) ? cleanAsin(row.sku) : '');
      const asin = directAsin || (baseSku ? (asinByLabel.get(baseSku.toUpperCase()) || '') : '');
      return { ...row, asin, sellerItems: [] };
    });
    stockCheckLog('enrichCandidates:complete', {
      enrichedCount: enriched.length,
      asinFoundCount: enriched.filter((row) => row.asin).length,
      sellerItemCount: 0,
      skippedSellerItems: true,
      elapsedMs: getElapsedMs(startedAt)
    });
    return enriched;
  }

  const skuIndexStartedAt = Date.now();
  // Candidates are keyed by base SKU, so pull every index row whose base (or
  // exact, for legacy rows without a baseSku) matches.
  const skuIndexRows = await SellerSkuIndex.find({
    $or: [{ baseSku: { $in: skus } }, { sku: { $in: skus } }],
    currency: { $in: [...new Set(candidates.flatMap((row) => currencyAliases(row.currency)))] }
  }).lean();
  stockCheckLog('enrichCandidates:skuIndexLookupComplete', {
    skuIndexRowCount: skuIndexRows.length,
    elapsedMs: getElapsedMs(skuIndexStartedAt)
  });

  const sellerNameStartedAt = Date.now();
  const sellerNameMap = await getSellerNameMap([...new Set(skuIndexRows.map((row) => row.seller).filter(Boolean))]);
  stockCheckLog('enrichCandidates:sellerLookupComplete', {
    sellerCount: sellerNameMap.size,
    elapsedMs: getElapsedMs(sellerNameStartedAt)
  });

  const sellerItemsByKey = new Map();
  const allSellerItems = [];
  for (const row of skuIndexRows) {
    const sku = cleanSku(row.sku);
    const currency = normalizeCurrency(row.currency);
    const key = `${currency}:${cleanSku(row.baseSku) || sku}`;
    const arr = sellerItemsByKey.get(key) || [];
    const sellerItem = {
      sellerId: row.seller,
      sellerName: sellerNameMap.get(String(row.seller)) || String(row.seller),
      itemId: row.itemId,
      title: row.title || '',
      price: row.price ?? null,
      currency,
      quantityZeroStatus: 'not_needed',
      quantityZeroError: ''
    };
    arr.push(sellerItem);
    allSellerItems.push(sellerItem);
    sellerItemsByKey.set(key, arr);
  }

  const orderSummaryMap = await buildOrderSummaryMapForSellerItems(allSellerItems);

  const enriched = [];
  for (const row of candidates) {
    const baseSku = getBaseLabel(row.baseSku);
    const directAsin = isAmazonAsin(row.baseSku) ? cleanAsin(row.baseSku) : (isAmazonAsin(row.sku) ? cleanAsin(row.sku) : '');
    const asin = directAsin || (baseSku ? (asinByLabel.get(baseSku.toUpperCase()) || '') : '');
    const sellerItems = attachOrderSummariesFromMap(sellerItemsByKey.get(`${row.currency}:${row.sku}`) || [], orderSummaryMap);
    enriched.push({ ...row, asin, sellerItems });
  }
  stockCheckLog('enrichCandidates:complete', {
    enrichedCount: enriched.length,
    asinFoundCount: enriched.filter((row) => row.asin).length,
    sellerItemCount: allSellerItems.length,
    elapsedMs: getElapsedMs(startedAt)
  });
  return enriched;
}

async function processStockItem({ itemDoc, run, runId }) {
  const row = itemDoc;
  const claim = await AmazonStockCheckItem.updateOne(
    { _id: row._id, status: 'queued' },
    { $set: { status: 'processing' } }
  );
  if (claim.modifiedCount !== 1) return;

  // Tracked outside the try block so the catch handler can still record it
  // if the retry itself ends up failing too.
  let errorRetryAttempted = false;

  try {
    const previous = await AmazonStockSkuState.findOne({
      sku: row.sku,
      asin: row.asin,
      currency: row.currency
    }).lean();

    let scraper;
    try {
      scraper = await fetchScrapingdogProduct({ asin: row.asin, currency: row.currency, includePostalCode: false });
    } catch (fetchError) {
      const classified = classifyStockCheckError(fetchError);
      if (!classified.retryable) throw fetchError;

      // Transient Scrapingdog/Amazon failure (timeout, 429, 5xx) — retry once
      // after a short delay. If this also throws, it propagates to the outer
      // catch below exactly as an unretried failure would have.
      errorRetryAttempted = true;
      await sleep(ERROR_RETRY_DELAY_MS);
      scraper = await fetchScrapingdogProduct({ asin: row.asin, currency: row.currency, includePostalCode: false });
    }

    let parsed = parseStockStatus(scraper.data, run.threshold);
    let creditMultiplier = errorRetryAttempted ? 2 : 1;

    // Ambiguous case: no stock/availability text, but a returns policy is
    // present, meaning there's likely a live offer that just didn't fully
    // render. One retry after a short delay usually resolves this — if it
    // doesn't, we accept the extra credit and leave it as unknown_stock_text
    // rather than retry indefinitely or guess a status without evidence.
    if (parsed.status === 'unknown_stock_text' && parsed.hasActiveOfferSignal) {
      await sleep(UNKNOWN_STOCK_RETRY_DELAY_MS);
      try {
        const retryScraper = await fetchScrapingdogProduct({ asin: row.asin, currency: row.currency, includePostalCode: false });
        scraper = retryScraper;
        parsed = parseStockStatus(retryScraper.data, run.threshold);
        creditMultiplier += 1;
      } catch (retryError) {
        stockCheckWarn('processStockItem:retryFailed', {
          sku: row.sku,
          asin: row.asin,
          error: retryError.message
        });
      }
    }

    const becameAvailable = ['low_stock', 'out_of_stock'].includes(previous?.lastStatus)
      && ['in_stock', 'in_stock_unconfirmed'].includes(parsed.status);
    const sellerItems = row.sellerItems;

    await AmazonStockCheckRun.findByIdAndUpdate(runId, {
      $inc: {
        checkedCount: 1,
        creditsUsed: (getConfig(row.currency)?.credits || 0) * creditMultiplier,
        inStockCount: parsed.status === 'in_stock' ? 1 : 0,
        inStockUnconfirmedCount: parsed.status === 'in_stock_unconfirmed' ? 1 : 0,
        lowStockCount: parsed.status === 'low_stock' ? 1 : 0,
        outOfStockCount: parsed.status === 'out_of_stock' ? 1 : 0,
        unknownStockTextCount: parsed.status === 'unknown_stock_text' ? 1 : 0,
        becameAvailableCount: becameAvailable ? 1 : 0
      }
    });

    await AmazonStockCheckItem.findByIdAndUpdate(row._id, {
      status: parsed.status,
      stockQuantity: parsed.stockQuantity,
      availabilityText: parsed.availabilityText,
      scraperStatusCode: scraper.statusCode,
      scraperResponseSummary: {
        title: scraper.data?.title || '',
        availability_status: scraper.data?.availability_status || '',
        stock: scraper.data?.purchase_options?.single_offer?.stock || ''
      },
      retryAttempted: creditMultiplier > 1,
      previousStatus: previous?.lastStatus || '',
      becameAvailable,
      sellerItems,
      checkedAt: new Date()
    });

    await AmazonStockSkuState.findOneAndUpdate(
      { sku: row.sku, asin: row.asin, currency: row.currency },
      {
        sku: row.sku,
        asin: row.asin,
        currency: row.currency,
        country: row.country,
        lastStatus: parsed.status,
        lastStockQuantity: parsed.stockQuantity,
        lastAvailabilityText: parsed.availabilityText,
        lastRun: runId,
        lastCheckedAt: new Date()
      },
      { upsert: true }
    );
  } catch (error) {
    const classified = classifyStockCheckError(error);
    await AmazonStockCheckItem.findByIdAndUpdate(row._id, {
      status: 'error',
      error: classified.message,
      errorType: classified.errorType,
      errorSource: classified.errorSource,
      retryable: classified.retryable,
      retryAttempted: errorRetryAttempted,
      checkedAt: new Date()
    });
    await AmazonStockCheckRun.findByIdAndUpdate(runId, {
      $inc: { checkedCount: 1, errorCount: 1 }
    });
  }
}

async function processQueuedStockBatches({ run, runId, maxBatches = Infinity, startingBatch = 0 }) {
  let processedBatchCount = startingBatch;
  let queuedCount = await AmazonStockCheckItem.countDocuments({
    run: runId,
    status: 'queued',
    asin: { $exists: true, $ne: '' }
  });

  while (queuedCount > 0 && processedBatchCount - startingBatch < maxBatches) {
    const status = await getRunStatus(runId);
    if (status === 'paused' || status === 'cancelled') break;

    const batchStartedAt = Date.now();
    const queuedItems = await AmazonStockCheckItem.find({
      run: runId,
      status: 'queued',
      asin: { $exists: true, $ne: '' }
    })
      .sort({ sku: 1, _id: 1 })
      .limit(STOCK_PROCESS_BATCH_SIZE)
      .lean();

    if (!queuedItems.length) break;

    await Promise.all(queuedItems.map((itemDoc) => scrapingdogLimit(() => processStockItem({ itemDoc, run, runId }))));
    processedBatchCount += 1;
    queuedCount = await AmazonStockCheckItem.countDocuments({
      run: runId,
      status: 'queued',
      asin: { $exists: true, $ne: '' }
    });

    stockCheckLog('processRun:stockChecksBatchComplete', {
      runId: String(runId),
      batch: processedBatchCount,
      batchSize: queuedItems.length,
      queuedRemaining: queuedCount,
      elapsedMs: getElapsedMs(batchStartedAt)
    });
  }

  return { processedBatchCount, queuedCount };
}

async function initializeRunItems(run) {
  const runId = run._id;
  const existingItemCount = await AmazonStockCheckItem.countDocuments({ run: runId });
  if (existingItemCount > 0 && run.candidateBuildComplete) {
    const completedItemCount = await AmazonStockCheckItem.countDocuments({
      run: runId,
      status: { $nin: ['queued', 'no_asin'] }
    });
    if (run.totalSkus > 0 && existingItemCount < run.totalSkus && completedItemCount === 0) {
      stockCheckWarn('processRun:partialInitializationRebuild', {
        runId: String(runId),
        existingItemCount,
        expectedItemCount: run.totalSkus
      });
      await AmazonStockCheckItem.deleteMany({ run: runId });
    } else {
      stockCheckLog('processRun:itemsAlreadyInitialized', {
        runId: String(runId),
        existingItemCount,
        completedItemCount
      });
      return;
    }
  }

  const currencies = run.currencies.map(normalizeCurrency);
  const candidates = await withMongoRetry('Build SKU candidate list', () => buildCandidates({ currencies, mode: run.mode, sellerId: run.seller || null }));
  await AmazonStockCheckRun.findByIdAndUpdate(runId, {
    totalSkus: candidates.length,
    candidateBuildComplete: false
  });

  const existingKeys = new Set();
  if (existingItemCount > 0) {
    const existingRows = await AmazonStockCheckItem.find({ run: runId }).select('currency sku').lean();
    for (const row of existingRows) existingKeys.add(`${row.currency}:${row.sku}`);
  }

  let preparedCount = existingKeys.size;
  for (let offset = 0; offset < candidates.length; offset += PREPARE_CHUNK_SIZE) {
    const status = await getRunStatus(runId);
    if (status === 'cancelled' || status === 'paused') return;

    const chunkStartedAt = Date.now();
    const chunk = candidates.slice(offset, offset + PREPARE_CHUNK_SIZE)
      .filter((row) => !existingKeys.has(`${row.currency}:${row.sku}`));
    if (!chunk.length) continue;

    const enriched = await withMongoRetry('Map base SKUs to ASINs', () => enrichCandidates(chunk));
    const asinFoundCount = enriched.reduce((count, row) => count + (row.asin ? 1 : 0), 0);
    const noAsinCount = enriched.length - asinFoundCount;
    const creditsEstimated = enriched.reduce((sum, row) => sum + (row.asin ? (getConfig(row.currency)?.credits || 0) : 0), 0);

    const batch = [];
    for (const row of enriched) {
      existingKeys.add(`${row.currency}:${row.sku}`);
      const hasRecentOrder90d = (row.sellerItems || []).some((si) => (si.orderCount90d || 0) > 0);
      batch.push(row.asin
        ? {
            run: runId,
            sku: row.sku,
            asin: row.asin,
            currency: row.currency,
            country: row.country,
            status: 'queued',
            sellerItems: row.sellerItems,
            hasRecentOrder90d
          }
        : {
            run: runId,
            sku: row.sku,
            asin: '',
            currency: row.currency,
            country: row.country,
            status: 'no_asin',
            sellerItems: row.sellerItems,
            hasRecentOrder90d,
            error: 'No ASIN found from TemplateListing._asinReference',
            errorType: 'no_asin_found',
            errorSource: 'template_listing',
            retryable: false,
            checkedAt: new Date()
          });

      if (batch.length >= RUN_ITEM_INSERT_BATCH_SIZE) {
        await flushStockCheckItemBatch(batch);
      }
    }
    await flushStockCheckItemBatch(batch);
    preparedCount += enriched.length;

    await AmazonStockCheckRun.findByIdAndUpdate(runId, {
      $inc: {
        asinFoundCount,
        noAsinCount,
        creditsEstimated
      }
    });

    stockCheckLog('processRun:itemsChunkInitialized', {
      runId: String(runId),
      preparedCount,
      totalSkus: candidates.length,
      chunkSize: enriched.length,
      asinFoundCount,
      noAsinCount,
      elapsedMs: getElapsedMs(chunkStartedAt)
    });

    await processQueuedStockBatches({ run, runId, maxBatches: 1 });
  }

  const [finalItemCount, finalAsinFoundCount, finalNoAsinCount] = await Promise.all([
    AmazonStockCheckItem.countDocuments({ run: runId }),
    AmazonStockCheckItem.countDocuments({ run: runId, asin: { $exists: true, $ne: '' } }),
    AmazonStockCheckItem.countDocuments({ run: runId, status: 'no_asin' })
  ]);
  const finalCreditRows = await AmazonStockCheckItem.aggregate([
    { $match: { run: runId, asin: { $exists: true, $ne: '' } } },
    { $group: { _id: '$currency', count: { $sum: 1 } } }
  ]);
  const finalCreditsEstimated = finalCreditRows.reduce((sum, row) => sum + (row.count * (getConfig(row._id)?.credits || 0)), 0);

  await AmazonStockCheckRun.findByIdAndUpdate(runId, {
    totalSkus: finalItemCount,
    asinFoundCount: finalAsinFoundCount,
    noAsinCount: finalNoAsinCount,
    creditsEstimated: finalCreditsEstimated,
    candidateBuildComplete: true
  });

  stockCheckLog('processRun:itemsInitialized', {
    runId: String(runId),
    totalSkus: finalItemCount,
    preparedCount: finalItemCount,
    insertBatchSize: RUN_ITEM_INSERT_BATCH_SIZE
  });
}

async function processRun(runId) {
  if (activeRuns.has(String(runId))) return;
  activeRuns.add(String(runId));

  try {
    const run = await AmazonStockCheckRun.findById(runId);
    if (!run) return;
    if (run.status === 'cancelled' || run.status === 'paused') return;

    run.status = 'running';
    if (!run.startedAt) run.startedAt = new Date();
    await run.save();

    await initializeRunItems(run);
    let queuedCount = await AmazonStockCheckItem.countDocuments({
      run: runId,
      status: 'queued',
      asin: { $exists: true, $ne: '' }
    });

    stockCheckLog('processRun:stockChecksStart', {
      runId: String(runId),
      queuedCount,
      processBatchSize: STOCK_PROCESS_BATCH_SIZE,
      scrapingdogConcurrent: SCRAPINGDOG_CONCURRENT,
      ebayQuantityConcurrent: EBAY_QUANTITY_CONCURRENT
    });

    const result = await processQueuedStockBatches({ run, runId });
    queuedCount = result.queuedCount;

    stockCheckLog('processRun:stockChecksComplete', {
      runId: String(runId),
      batches: result.processedBatchCount,
      queuedRemaining: queuedCount
    });

    const latestStatus = await getRunStatus(runId);
    if (latestStatus === 'paused' || latestStatus === 'cancelled') return;

    await AmazonStockCheckRun.findByIdAndUpdate(runId, {
      status: 'completed',
      completedAt: new Date()
    });
  } catch (error) {
    const dbHint = isTransientMongoError(error)
      ? 'MongoDB connection timed out while preparing the run. No Scrapingdog credits were used before SKU preparation completed. '
      : '';
    await AmazonStockCheckRun.findByIdAndUpdate(runId, {
      status: 'failed',
      error: `${dbHint}${error.message || 'Run failed'}`,
      completedAt: new Date()
    });
  } finally {
    activeRuns.delete(String(runId));
  }
}

export async function resumeRunningAmazonStockCheckRuns() {
  // Boot-resume only adopts runs THIS server owns, so a restart on one server
  // can never steal a run being processed by the other. Runs with no runnerId
  // are legacy (created before ownership tracking) — only the Render runner
  // adopts those. Explicit Start/Resume clicks (processRun via the routes)
  // still work anywhere and take ownership of the run.
  const ownershipFilter = RUNNER_ID === 'render'
    ? { $or: [{ runnerId: { $in: [null, ''] } }, { runnerId: RUNNER_ID }] }
    : { runnerId: RUNNER_ID };

  const runs = await AmazonStockCheckRun.find({
    status: { $in: ['queued', 'running'] },
    ...ownershipFilter
  }).sort({ createdAt: 1 }).lean();

  stockCheckLog('resume:scan', { runnerId: RUNNER_ID, adoptableRunCount: runs.length });

  for (const run of runs) {
    await AmazonStockCheckItem.updateMany(
      {
        run: run._id,
        status: 'processing',
        asin: { $exists: true, $ne: '' }
      },
      { $set: { status: 'queued' } }
    );

    const queuedItemCount = await AmazonStockCheckItem.countDocuments({
      run: run._id,
      status: 'queued',
      asin: { $exists: true, $ne: '' }
    });
    const totalItemCount = await AmazonStockCheckItem.countDocuments({ run: run._id });

    if (totalItemCount > 0 && queuedItemCount === 0) {
      await AmazonStockCheckRun.findByIdAndUpdate(run._id, {
        status: 'completed',
        completedAt: new Date(),
        error: ''
      });
      continue;
    }

    stockCheckLog('resume:runQueued', {
      runId: String(run._id),
      status: run.status,
      totalItemCount,
      queuedItemCount
    });
    setTimeout(() => processRun(run._id), 0);
  }

  return runs.length;
}

function normalizeItemFilters(filter) {
  return String(filter || 'actionable')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function getItemFilterCondition(filter) {
  if (filter === 'in_stock') return { status: 'in_stock' };
  if (filter === 'in_stock_unconfirmed') return { status: 'in_stock_unconfirmed' };
  if (filter === 'low_stock') return { status: 'low_stock' };
  // $ne true (not a strict false check) so items checked before this field
  // existed — which simply lack it — still fall into the "no orders" bucket
  // instead of vanishing from both counts.
  if (filter === 'low_stock_no_orders') return { status: 'low_stock', hasRecentOrder90d: { $ne: true } };
  if (filter === 'low_stock_with_orders') return { status: 'low_stock', hasRecentOrder90d: true };
  if (filter === 'out_of_stock') return { status: 'out_of_stock' };
  if (filter === 'unknown_stock_text') return { status: 'unknown_stock_text' };
  if (filter === 'errors') return { status: 'error' };
  if (filter === 'no_asin') return { status: 'no_asin' };
  if (filter === 'restocked') return { becameAvailable: true };
  if (filter === 'qty_zero_success') return { 'sellerItems.quantityZeroStatus': 'success' };
  if (filter === 'qty_zero_failed') return { 'sellerItems.quantityZeroStatus': 'failed' };
  if (filter === 'has_orders') return { 'sellerItems.orderCount': { $gt: 0 } };
  if (filter === 'checked') return { status: { $nin: ['queued', 'processing', 'no_asin'] } };
  if (filter === 'actionable') return { status: { $in: ['low_stock', 'out_of_stock', 'unknown_stock_text'] } };
  return null;
}

function buildItemFilterQuery(runId, filter, sellerId) {
  const query = { run: runId };
  const conditions = normalizeItemFilters(filter)
    .filter((value) => value !== 'all')
    .map(getItemFilterCondition)
    .filter(Boolean);
  if (conditions.length === 1) {
    Object.assign(query, conditions[0]);
  } else if (conditions.length > 1) {
    query.$and = conditions;
  }
  if (sellerId && mongoose.Types.ObjectId.isValid(String(sellerId))) {
    query['sellerItems.sellerId'] = new mongoose.Types.ObjectId(String(sellerId));
  }
  return query;
}

async function getItemFilterCounts(runId, sellerId) {
  const [
    all,
    actionable,
    checked,
    inStock,
    inStockUnconfirmed,
    lowStockNoOrders,
    lowStockWithOrders,
    outOfStock,
    unknownStockText,
    errors,
    noAsin,
    restocked,
    qtyZeroSuccess,
    qtyZeroFailed,
    hasOrders
  ] = await Promise.all([
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'all', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'actionable', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'checked', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'in_stock', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'in_stock_unconfirmed', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'low_stock_no_orders', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'low_stock_with_orders', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'out_of_stock', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'unknown_stock_text', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'errors', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'no_asin', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'restocked', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'qty_zero_success', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'qty_zero_failed', sellerId)),
    AmazonStockCheckItem.countDocuments(buildItemFilterQuery(runId, 'has_orders', sellerId))
  ]);

  return {
    all,
    actionable,
    checked,
    in_stock: inStock,
    in_stock_unconfirmed: inStockUnconfirmed,
    low_stock: lowStockNoOrders + lowStockWithOrders,
    low_stock_no_orders: lowStockNoOrders,
    low_stock_with_orders: lowStockWithOrders,
    out_of_stock: outOfStock,
    unknown_stock_text: unknownStockText,
    errors,
    no_asin: noAsin,
    restocked,
    qty_zero_success: qtyZeroSuccess,
    qty_zero_failed: qtyZeroFailed,
    has_orders: hasOrders
  };
}

// GET /amazon-stock-checks/seller-summary?sellerId=...
// Per-currency SKU index summary for one seller: unique SKU count, listing
// count, and extra duplicate count (mirrors the SKU Index Dashboard math).
router.get('/seller-summary', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  try {
    const sellerId = String(req.query.sellerId || '');
    if (!mongoose.Types.ObjectId.isValid(sellerId)) {
      return res.status(400).json({ error: 'A valid sellerId is required.' });
    }

    const rows = await SellerSkuIndex.aggregate([
      { $match: { seller: new mongoose.Types.ObjectId(sellerId), sku: { $nin: ['', null] } } },
      {
        $addFields: {
          normalizedCurrency: {
            $let: {
              vars: { cur: { $toUpper: { $ifNull: ['$currency', 'UNKNOWN'] } } },
              in: { $cond: [{ $eq: ['$$cur', 'GB'] }, 'GBP', '$$cur'] }
            }
          }
        }
      },
      {
        $group: {
          _id: { currency: '$normalizedCurrency', sku: '$sku' },
          listingCount: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: '$_id.currency',
          uniqueSkuCount: { $sum: 1 },
          listingCount: { $sum: '$listingCount' },
          duplicateSkuCount: { $sum: { $cond: [{ $gt: ['$listingCount', 1] }, 1, 0] } },
          extraCount: { $sum: { $subtract: ['$listingCount', 1] } }
        }
      },
      { $sort: { listingCount: -1 } }
    ]);

    const currencies = rows.map((row) => {
      const config = getConfig(row._id);
      return {
        currency: row._id,
        country: config?.country || row._id,
        supported: Boolean(config),
        credits: config?.credits || 0,
        uniqueSkuCount: row.uniqueSkuCount,
        listingCount: row.listingCount,
        duplicateSkuCount: row.duplicateSkuCount,
        extraCount: row.extraCount
      };
    });

    const totals = currencies.reduce((acc, row) => {
      acc.uniqueSkuCount += row.uniqueSkuCount;
      acc.listingCount += row.listingCount;
      acc.duplicateSkuCount += row.duplicateSkuCount;
      acc.extraCount += row.extraCount;
      return acc;
    }, { uniqueSkuCount: 0, listingCount: 0, duplicateSkuCount: 0, extraCount: 0 });

    res.json({ sellerId, currencies, totals });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load seller SKU summary' });
  }
});

// GET /amazon-stock-checks/items/:itemId/verify
// Verification data for one checked SKU: the Amazon product URL for the
// item's country plus every seller's item IDs for this SKU/currency with
// their orders from the last 30 days.
router.get('/items/:itemId/verify', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  try {
    const item = await AmazonStockCheckItem.findById(req.params.itemId).lean();
    if (!item) return res.status(404).json({ error: 'Item result not found' });

    const run = await AmazonStockCheckRun.findById(item.run).select('seller').lean();
    const runSellerId = run?.seller ? String(run.seller) : null;
    const config = getConfig(item.currency);
    const amazonUrl = item.asin && config ? `https://www.amazon.${config.domain}/dp/${item.asin}` : '';

    // Gather item IDs live from the SKU index by BASE SKU (same currency), so
    // variant listings like GRW25X and GRW25X-1 are reviewed together and the
    // list reflects the current index rather than the run-time snapshot.
    const exactSku = cleanSku(item.sku);
    const baseLabel = getBaseLabel(item.sku);
    const baseCandidates = [...new Set([exactSku, baseLabel].filter(Boolean))];
    const currencyMatches = currencyAliases(item.currency);
    const indexRows = baseCandidates.length
      ? await SellerSkuIndex.find({
          currency: { $in: currencyMatches },
          $or: [{ baseSku: { $in: baseCandidates } }, { sku: exactSku }]
        }).lean()
      : [];

    let sellerItems;
    if (indexRows.length) {
      sellerItems = indexRows.map((row) => ({
        sellerId: row.seller,
        sellerName: String(row.seller), // replaced with the username below
        itemId: row.itemId,
        sku: cleanSku(row.sku),
        title: row.title || '',
        price: row.price ?? null,
        currency: normalizeCurrency(row.currency),
        quantityZeroStatus: 'not_needed'
      }));
    } else {
      // Index has no rows for this base SKU any more (e.g. everything was
      // ended and re-synced) — fall back to the snapshot stored on the run.
      sellerItems = (item.sellerItems || []).map((row) => ({ ...row, sku: item.sku }));
    }

    const itemIds = [...new Set(sellerItems.map((row) => row.itemId).filter(Boolean))];
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    // Seller names, prior end-listing actions, prior revisions, and order
    // history are independent lookups — run them in parallel.
    const [sellerNameMap, endLogs, reviseLogs, orders] = await Promise.all([
      indexRows.length
        ? getSellerNameMap([...new Set(indexRows.map((row) => row.seller).filter(Boolean))])
        : Promise.resolve(new Map()),
      itemIds.length
        ? EndListingLog.find({ itemId: { $in: itemIds } })
            .populate('endedBy', 'username name email')
            .sort({ endedAt: -1 })
            .lean()
        : Promise.resolve([]),
      itemIds.length
        ? AmazonStockActionLog.find({ itemId: { $in: itemIds }, actionType: 'revise_listing', status: 'success' })
            .populate('requestedBy', 'username name email')
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([]),
      itemIds.length
        ? Order.find({
            $or: [{ itemNumber: { $in: itemIds } }, { 'lineItems.legacyItemId': { $in: itemIds } }]
          })
            .select('seller orderId dateSold creationDate itemNumber lineItems quantity subtotal productName')
            .sort({ dateSold: -1, creationDate: -1 })
            .lean()
        : Promise.resolve([])
    ]);

    if (sellerNameMap.size) {
      for (const row of sellerItems) {
        row.sellerName = sellerNameMap.get(String(row.sellerId)) || row.sellerName;
      }
    }
    // Exact-SKU rows first, then variants, then by seller name for stable reading order.
    sellerItems.sort((a, b) => (
      (a.sku === item.sku ? 0 : 1) - (b.sku === item.sku ? 0 : 1)
      || String(a.sku).localeCompare(String(b.sku))
      || String(a.sellerName).localeCompare(String(b.sellerName))
    ));

    const endedByKey = new Map();
    for (const log of endLogs) {
      const key = `${String(log.seller)}:${log.itemId}`;
      if (endedByKey.has(key)) continue; // keep the most recent log per item
      endedByKey.set(key, {
        endedAt: log.endedAt,
        endedBy: log.endedBy?.username || log.endedBy?.name || log.endedBy?.email || null,
        source: log.source
      });
    }

    const revisedByKey = new Map();
    for (const log of reviseLogs) {
      const key = `${String(log.seller)}:${log.itemId}`;
      if (revisedByKey.has(key)) continue; // keep the most recent log per item
      revisedByKey.set(key, {
        revisedAt: log.createdAt,
        revisedBy: log.requestedBy?.username || log.requestedBy?.name || log.requestedBy?.email || null,
        previousTitle: log.requestPayload?.previousTitle || '',
        newTitle: log.requestPayload?.title || '',
        previousPrice: log.requestPayload?.previousPrice ?? null,
        newPrice: log.requestPayload?.price ?? null
      });
    }

    // Group orders by (seller, itemId); an order can reference an item id via
    // the denormalized itemNumber or any of its line items.
    const ordersByKey = new Map();
    for (const order of orders) {
      const orderDate = order.dateSold || order.creationDate || null;
      if (!orderDate) continue;
      const ids = new Set();
      if (order.itemNumber) ids.add(order.itemNumber);
      for (const lineItem of order.lineItems || []) {
        if (lineItem?.legacyItemId) ids.add(lineItem.legacyItemId);
      }
      for (const itemId of ids) {
        const key = `${String(order.seller)}:${itemId}`;
        const list = ordersByKey.get(key) || [];
        list.push({
          orderId: order.orderId,
          date: orderDate,
          quantity: order.quantity ?? null,
          subtotal: order.subtotal ?? null,
          productName: order.productName || ''
        });
        ordersByKey.set(key, list);
      }
    }

    // Last 12 calendar months (oldest first) for the per-item order sparkline.
    const monthKeys = [];
    const now = new Date();
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    const enrichedSellerItems = sellerItems.map((row) => {
      const key = `${String(row.sellerId)}:${row.itemId}`;
      const allOrders = (ordersByKey.get(key) || []).sort((a, b) => new Date(b.date) - new Date(a.date));
      const recentOrders = allOrders.filter((order) => new Date(order.date) >= since);
      const recentOrders90d = allOrders.filter((order) => new Date(order.date) >= since90);
      const countsByMonth = new Map();
      for (const order of allOrders) {
        const d = new Date(order.date);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        countsByMonth.set(monthKey, (countsByMonth.get(monthKey) || 0) + 1);
      }
      return {
        sellerId: row.sellerId,
        sellerName: row.sellerName,
        itemId: row.itemId,
        sku: row.sku || item.sku,
        title: row.title || '',
        price: row.price ?? null,
        currency: row.currency || item.currency,
        quantityZeroStatus: row.quantityZeroStatus || 'not_needed',
        isRunSeller: runSellerId ? String(row.sellerId) === runSellerId : false,
        orderCount30d: recentOrders.length,
        orderCount90d: recentOrders90d.length,
        orders: recentOrders.slice(0, 20),
        lifetimeOrderCount: allOrders.length,
        monthlyOrders: monthKeys.map((month) => ({ month, count: countsByMonth.get(month) || 0 })),
        endedInfo: endedByKey.get(key) || null,
        revisedInfo: revisedByKey.get(key) || null
      };
    });

    res.json({
      sku: item.sku,
      asin: item.asin,
      currency: item.currency,
      country: item.country,
      status: item.status,
      stockQuantity: item.stockQuantity,
      availabilityText: item.availabilityText,
      amazonUrl,
      runSellerId,
      // Live recompute (not the stored snapshot) so it reflects orders placed
      // since the run last checked this SKU — true if ANY seller listing has
      // sold in the last 90 days, used client-side to withhold auto-select.
      hasRecentOrder90d: enrichedSellerItems.some((row) => (row.orderCount90d || 0) > 0),
      sellerItems: enrichedSellerItems
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load verification data' });
  }
});

// POST /amazon-stock-checks/live-images
// Fetches current listing images straight from eBay (Trading GetItem) for the
// verify panel. Any connected seller's token can read public items; the panel
// passes its selected seller. Fetched lazily by the client so verify stays fast.
const liveImageLimit = pLimit(6);
router.post('/live-images', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  try {
    const sellerId = String(req.body?.sellerId || '');
    const itemIds = [...new Set((req.body?.itemIds || []).map((id) => String(id).trim()).filter(Boolean))].slice(0, 24);
    if (!mongoose.Types.ObjectId.isValid(sellerId) || !itemIds.length) {
      return res.status(400).json({ error: 'sellerId and itemIds are required.' });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found.' });
    const token = await ensureValidToken(seller);

    const entries = await Promise.all(itemIds.map((itemId) => liveImageLimit(async () => {
      try {
        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Item.ItemID</OutputSelector>
  <OutputSelector>Item.PictureDetails</OutputSelector>
</GetItemRequest>`;
        const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
          headers: {
            'X-EBAY-API-SITEID': '0',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
            'X-EBAY-API-CALL-NAME': 'GetItem',
            'Content-Type': 'text/xml'
          },
          timeout: 20000
        });
        const parsed = await parseStringPromise(response.data, { explicitArray: false });
        const pictureUrl = parsed?.GetItemResponse?.Item?.PictureDetails?.PictureURL;
        const url = Array.isArray(pictureUrl) ? pictureUrl[0] : pictureUrl;
        return url ? [itemId, url] : null;
      } catch {
        return null; // ended/unavailable items simply have no image
      }
    })));

    res.json({ images: Object.fromEntries(entries.filter(Boolean)) });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load listing images' });
  }
});

router.get('/estimate', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), requireFeatureAccess(AMAZON_STOCK_CHECK_RUN_FEATURE_ID), async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const sellerId = mongoose.Types.ObjectId.isValid(String(req.query.sellerId || '')) ? String(req.query.sellerId) : null;
    const mode = sellerId
      ? 'seller'
      : (req.query.mode === 'pilot_option_b' ? 'pilot_option_b' : (req.query.mode === 'full' ? 'full' : 'custom'));
    const currencies = mode === 'pilot_option_b'
      ? Object.keys(PILOT_OPTION_B_LIMITS)
      : (mode === 'full'
        ? Object.keys(COUNTRY_CONFIG)
        : String(req.query.currencies || 'USD').split(',').map(normalizeCurrency).filter((cur) => getConfig(cur)));
    stockCheckLog('estimate:start', {
      mode,
      currencies,
      sellerId,
      limit: req.query.limit || null,
      userId: req.user?.userId || null
    });
    const candidates = await buildCandidates({ currencies, mode, limit: req.query.limit, sellerId });
    const enriched = await enrichCandidates(candidates, { includeSellerItems: false });
    const withAsin = enriched.filter((row) => row.asin);
    stockCheckLog('estimate:complete', {
      mode,
      currencies,
      totalSkus: enriched.length,
      asinFoundCount: withAsin.length,
      noAsinCount: enriched.length - withAsin.length,
      creditsEstimated: estimateCredits(withAsin),
      elapsedMs: getElapsedMs(requestStartedAt)
    });

    res.json({
      mode,
      currencies,
      totalSkus: enriched.length,
      asinFoundCount: withAsin.length,
      noAsinCount: enriched.length - withAsin.length,
      creditsEstimated: estimateCredits(withAsin),
      plan: currencies.map((currency) => ({
        ...getConfig(currency),
        skuCount: enriched.filter((row) => row.currency === currency).length,
        asinFoundCount: withAsin.filter((row) => row.currency === currency).length
      }))
    });
  } catch (error) {
    stockCheckWarn('estimate:failed', {
      elapsedMs: getElapsedMs(requestStartedAt),
      errorName: error?.name || '',
      errorMessage: error?.message || 'Failed to estimate stock check',
      errorCode: error?.code || '',
      isTransientMongoError: isTransientMongoError(error)
    });
    res.status(500).json({ error: error.message || 'Failed to estimate stock check' });
  }
});

router.post('/runs', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), requireFeatureAccess(AMAZON_STOCK_CHECK_RUN_FEATURE_ID), async (req, res) => {
  try {
    const sellerId = mongoose.Types.ObjectId.isValid(String(req.body?.sellerId || '')) ? String(req.body.sellerId) : null;
    const mode = sellerId
      ? 'seller'
      : (req.body?.mode === 'pilot_option_b' ? 'pilot_option_b' : (req.body?.mode === 'full' ? 'full' : 'custom'));
    const currencies = mode === 'pilot_option_b'
      ? Object.keys(PILOT_OPTION_B_LIMITS)
      : (req.body?.currencies || ['USD']).map(normalizeCurrency).filter((cur) => getConfig(cur));

    if (!currencies.length) {
      return res.status(400).json({ error: 'Select at least one supported currency.' });
    }

    if (sellerId) {
      const sellerExists = await Seller.exists({ _id: sellerId });
      if (!sellerExists) return res.status(404).json({ error: 'Seller not found.' });
    }

    const run = await AmazonStockCheckRun.create({
      countries: currencies.map((currency) => getConfig(currency).country),
      currencies,
      status: 'queued',
      mode,
      seller: sellerId,
      threshold: Number.parseInt(req.body?.threshold, 10) || 5,
      requestedBy: req.user?.userId || null,
      runnerId: RUNNER_ID
    });

    setTimeout(() => processRun(run._id), 0);
    res.status(201).json({ run });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to start stock check run' });
  }
});

router.post('/runs/:runId/pause', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), requireFeatureAccess(AMAZON_STOCK_CHECK_RUN_FEATURE_ID), async (req, res) => {
  const run = await AmazonStockCheckRun.findById(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!['queued', 'running'].includes(run.status)) {
    return res.status(400).json({ error: `Run cannot be paused from status ${run.status}` });
  }

  run.status = 'paused';
  await run.save();
  await AmazonStockCheckItem.updateMany(
    { run: run._id, status: 'processing' },
    { $set: { status: 'queued' } }
  );
  res.json({ run, message: 'Run paused.' });
});

router.post('/runs/:runId/resume', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), requireFeatureAccess(AMAZON_STOCK_CHECK_RUN_FEATURE_ID), async (req, res) => {
  const run = await AmazonStockCheckRun.findById(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status !== 'paused') {
    return res.status(400).json({ error: `Run cannot be resumed from status ${run.status}` });
  }

  run.status = 'queued';
  run.completedAt = null;
  run.error = '';
  // Explicit resume transfers ownership: whichever server handles this click
  // becomes the run's processor (and the only one that auto-resumes it on boot).
  run.runnerId = RUNNER_ID;
  await run.save();
  await AmazonStockCheckItem.updateMany(
    { run: run._id, status: 'processing' },
    { $set: { status: 'queued' } }
  );
  setTimeout(() => processRun(run._id), 0);
  res.json({ run, message: 'Run resumed.' });
});

router.post('/runs/:runId/cancel', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), requireFeatureAccess(AMAZON_STOCK_CHECK_RUN_FEATURE_ID), async (req, res) => {
  const run = await AmazonStockCheckRun.findById(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (['completed', 'failed', 'cancelled'].includes(run.status)) {
    return res.status(400).json({ error: `Run cannot be cancelled from status ${run.status}` });
  }

  run.status = 'cancelled';
  run.completedAt = new Date();
  await run.save();
  await AmazonStockCheckItem.updateMany(
    { run: run._id, status: 'processing' },
    { $set: { status: 'queued' } }
  );
  res.json({ run, message: 'Run cancelled.' });
});

router.get('/runs', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
  const limit = Math.min(50, Math.max(5, Number.parseInt(req.query.limit || '20', 10)));
  const skip = (page - 1) * limit;
  const runQuery = {};
  if (mongoose.Types.ObjectId.isValid(String(req.query.sellerId || ''))) {
    runQuery.seller = String(req.query.sellerId);
  }
  const [runs, total] = await Promise.all([
    AmazonStockCheckRun.find(runQuery)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('requestedBy', 'username name email')
      .lean(),
    AmazonStockCheckRun.countDocuments(runQuery)
  ]);
  res.json({
    runs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit))
    }
  });
});

router.get('/runs/:runId', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  const run = await AmazonStockCheckRun.findById(req.params.runId).populate('requestedBy', 'username name email').lean();
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const itemCounts = await getItemFilterCounts(req.params.runId, req.query.sellerId);
  res.json({ run, itemCounts });
});

router.get('/runs/:runId/items', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  const filter = String(req.query.filter || 'actionable').trim();
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
  const limit = Math.min(500, Math.max(25, Number.parseInt(req.query.limit || '100', 10)));
  const query = buildItemFilterQuery(req.params.runId, filter, req.query.sellerId);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    AmazonStockCheckItem.find(query)
      // Raw scraper payload fields are never rendered by the UI; excluding
      // them keeps the list response small (they can be large per row).
      .select('-scraperResponseSummary -previousStatus -scraperStatusCode')
      .sort({ status: 1, sku: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AmazonStockCheckItem.countDocuments(query)
  ]);

  res.json({
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit))
    }
  });
});

router.post('/items/:itemId/set-quantity-zero', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  const item = await AmazonStockCheckItem.findById(req.params.itemId).lean();
  if (!item) return res.status(404).json({ error: 'Item result not found' });

  const sellerItem = item.sellerItems.find((row) => String(row.itemId) === String(req.body?.itemId));
  if (!sellerItem) return res.status(404).json({ error: 'Seller item not found on this result' });

  const result = await reviseInventoryQuantity({
    sellerId: sellerItem.sellerId,
    itemId: sellerItem.itemId,
    quantity: 0,
    runId: item.run,
    itemDocId: item._id,
    sku: item.sku,
    asin: item.asin,
    requestedBy: req.user?.userId || null
  });

  await AmazonStockCheckItem.updateOne(
    { _id: item._id, 'sellerItems.itemId': sellerItem.itemId },
    {
      $set: {
        'sellerItems.$.quantityZeroStatus': result.ok ? 'success' : 'failed',
        'sellerItems.$.quantityZeroError': result.error || ''
      }
    }
  );

  res.status(result.ok ? 200 : 500).json({
    ...result,
    message: result.ok
      ? `Quantity set to zero for item ${sellerItem.itemId}`
      : result.error || `Failed to set quantity to zero for item ${sellerItem.itemId}`
  });
});

router.post('/items/:itemId/set-quantity-one', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  const item = await AmazonStockCheckItem.findById(req.params.itemId).lean();
  if (!item) return res.status(404).json({ error: 'Item result not found' });

  const sellerItem = item.sellerItems.find((row) => String(row.itemId) === String(req.body?.itemId));
  if (!sellerItem) return res.status(404).json({ error: 'Seller item not found on this result' });

  const result = await reviseInventoryQuantity({
    sellerId: sellerItem.sellerId,
    itemId: sellerItem.itemId,
    quantity: 1,
    runId: item.run,
    itemDocId: item._id,
    sku: item.sku,
    asin: item.asin,
    requestedBy: req.user?.userId || null
  });

  if (result.ok) {
    await AmazonStockCheckItem.updateOne(
      { _id: item._id, 'sellerItems.itemId': sellerItem.itemId },
      {
        $set: {
          'sellerItems.$.quantityZeroStatus': 'not_needed',
          'sellerItems.$.quantityZeroError': ''
        }
      }
    );
  }

  res.status(result.ok ? 200 : 500).json({
    ...result,
    message: result.ok
      ? `Quantity set to one for item ${sellerItem.itemId}`
      : result.error || `Failed to set quantity to one for item ${sellerItem.itemId}`
  });
});

// POST /amazon-stock-checks/revise-listing
// Revises title/price for one item ID on eBay. Self-contained (not scoped to
// a specific AmazonStockCheckItem/run) so it works from the verify panel
// regardless of which run or seller the item was found under — same pattern
// as /ebay/end-item.
router.post('/revise-listing', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  try {
    const { sellerId, itemId, title, price, previousTitle, previousPrice, sku, asin } = req.body || {};
    if (!sellerId || !itemId) {
      return res.status(400).json({ error: 'sellerId and itemId are required.' });
    }

    const newTitle = typeof title === 'string' ? title.trim() : '';
    const newPrice = price !== undefined && price !== null && price !== '' ? Number(price) : null;
    if (!newTitle && newPrice == null) {
      return res.status(400).json({ error: 'Provide a title and/or price to revise.' });
    }
    if (newPrice != null && !Number.isFinite(newPrice)) {
      return res.status(400).json({ error: 'Price must be a number.' });
    }

    const result = await reviseListingDetails({
      sellerId,
      itemId,
      title: newTitle || undefined,
      price: newPrice,
      previousTitle: previousTitle || '',
      previousPrice: previousPrice ?? null,
      sku: sku || '',
      asin: asin || '',
      requestedBy: req.user?.userId || null
    });

    res.status(result.ok ? 200 : 500).json({
      ...result,
      message: result.ok ? `Revised item ${itemId}` : result.error || `Failed to revise item ${itemId}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to revise listing' });
  }
});

// ---------------------------------------------------------------------------
// Revise onto a new ASIN
//
// Repoints a live eBay listing at a different Amazon product: the ItemID never
// changes, but its SKU, title, description, price, pictures and item specifics
// are all replaced with template-generated content for the new ASIN.
//
// In the database this is a NEW listing, not an edit. The row describing the
// old ASIN is left exactly as it is — history — and a fresh templatelistings
// row is inserted for the new ASIN under its own ASIN-derived SKU. Nothing ties
// the two together in that collection (the system is keyed on SKU end to end);
// the link lives in ListingRevision.
// ---------------------------------------------------------------------------

const ASIN_PATTERN = /^B[0-9A-Z]{9}$/;

// Every core column on TemplateListing. The generated listing is copied field
// by field rather than spread wholesale: the payload comes from the browser
// after the user has edited it, and spreading it would let a crafted request
// set status, downloadBatchId, deletedAt or any other bookkeeping field.
const TEMPLATE_LISTING_CORE_FIELDS = [
  'action', 'categoryId', 'categoryName', 'title', 'relationship', 'relationshipDetails',
  'upc', 'epid', 'startPrice', 'quantity', 'itemPhotoUrl', 'videoId', 'conditionId',
  'description', 'format', 'duration', 'buyItNowPrice', 'bestOfferEnabled',
  'bestOfferAutoAcceptPrice', 'minimumBestOfferPrice', 'immediatePayRequired', 'location',
  'shippingService1Option', 'shippingService1Cost', 'shippingService1Priority',
  'shippingService2Option', 'shippingService2Cost', 'shippingService2Priority',
  'maxDispatchTime', 'returnsAcceptedOption', 'returnsWithinOption', 'refundOption',
  'returnShippingCostPaidBy', 'shippingProfileName', 'returnProfileName', 'paymentProfileName'
];

function asXmlArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// GetItem returns money and other attributed elements as { _: value, $: {...} }
// under explicitArray:false, but as a bare string when there are no attributes.
function readXmlValue(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'object') return node._ ?? '';
  return String(node);
}

/**
 * What is actually live on this listing right now.
 *
 * Read from eBay rather than from templatelistings because the two can differ —
 * a listing may have been revised by hand in Seller Hub — and a snapshot that
 * describes something other than what was overwritten is worse than none.
 */
async function getListingSnapshot(token, itemId) {
  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
  <OutputSelector>Item.ItemID</OutputSelector>
  <OutputSelector>Item.Title</OutputSelector>
  <OutputSelector>Item.SKU</OutputSelector>
  <OutputSelector>Item.StartPrice</OutputSelector>
  <OutputSelector>Item.Currency</OutputSelector>
  <OutputSelector>Item.Description</OutputSelector>
  <OutputSelector>Item.PictureDetails</OutputSelector>
  <OutputSelector>Item.PrimaryCategory</OutputSelector>
  <OutputSelector>Item.ItemSpecifics</OutputSelector>
</GetItemRequest>`;

  const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
    headers: {
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
      'X-EBAY-API-CALL-NAME': 'GetItem',
      'Content-Type': 'text/xml'
    },
    timeout: 45000
  });

  const parsed = await parseStringPromise(response.data, { explicitArray: false });
  const body = parsed?.GetItemResponse;
  if (body?.Ack === 'Failure') {
    const errors = asXmlArray(body.Errors);
    throw new Error(errors[0]?.LongMessage || 'GetItem failed');
  }

  const item = body?.Item || {};
  const rawPrice = readXmlValue(item.StartPrice);
  const parsedPrice = rawPrice === '' ? null : Number(rawPrice);

  return {
    sku: item.SKU || '',
    title: item.Title || '',
    price: Number.isFinite(parsedPrice) ? parsedPrice : null,
    currency: item.StartPrice?.$?.currencyID || item.Currency || '',
    description: item.Description || '',
    images: asXmlArray(item.PictureDetails?.PictureURL).filter(Boolean),
    itemSpecifics: asXmlArray(item.ItemSpecifics?.NameValueList).map((nv) => ({
      name: nv?.Name || '',
      value: asXmlArray(nv?.Value).filter(Boolean).join(', ')
    })).filter((nv) => nv.name),
    categoryId: item.PrimaryCategory?.CategoryID || '',
    categoryName: item.PrimaryCategory?.CategoryName || ''
  };
}

function buildItemSpecificsXml(specifics) {
  if (!specifics.length) return '';
  const entries = specifics
    .map((s) => `<NameValueList><Name>${escapeXmlText(s.name)}</Name><Value>${escapeXmlText(s.value)}</Value></NameValueList>`)
    .join('');
  return `<ItemSpecifics>${entries}</ItemSpecifics>`;
}

/**
 * Replace a live listing's content with the new ASIN's.
 *
 * The picture list is always sent whole: eBay treats a partial PictureDetails
 * as the complete new set anyway, and rejects one that mixes its own hosted
 * pictures with external URLs (20004). hostsAreUniform is the last line of
 * defence against sending such a list.
 */
async function reviseListingToNewAsin({ token, itemId, sku, title, price, description, images, specifics }) {
  if (images.length && !hostsAreUniform(images)) {
    throw new Error('Refusing to revise: the image list mixes eBay-hosted and external pictures, which eBay rejects (error 20004).');
  }

  let itemContent = `<ItemID>${itemId}</ItemID>`;
  if (sku) itemContent += `<SKU>${escapeXmlText(sku)}</SKU>`;
  if (title) itemContent += `<Title>${escapeXmlText(title)}</Title>`;
  if (price != null) itemContent += `<StartPrice>${Number(price).toFixed(2)}</StartPrice>`;
  if (description) {
    // CDATA keeps the generated HTML intact. A literal "]]>" inside the
    // description would close the section early and corrupt the request, so the
    // only sequence that can do that is neutralised.
    itemContent += `<Description><![CDATA[${String(description).replace(/]]>/g, ']]&gt;')}]]></Description>`;
  }
  if (images.length) {
    itemContent += `<PictureDetails>${images.map((url) => `<PictureURL>${escapeXmlText(url)}</PictureURL>`).join('')}</PictureDetails>`;
  }
  itemContent += buildItemSpecificsXml(specifics);

  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>${itemContent}</Item>
</ReviseFixedPriceItemRequest>`;

  const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
    headers: {
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
      'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
      'Content-Type': 'text/xml'
    },
    timeout: 90000
  });

  const parsed = await parseStringPromise(response.data, { explicitArray: false });
  const body = parsed?.ReviseFixedPriceItemResponse;
  const ack = body?.Ack;

  if (ack !== 'Success' && ack !== 'Warning') {
    const errors = asXmlArray(body?.Errors);
    throw new Error(errors.map((e) => e.LongMessage).filter(Boolean).join('; ') || 'ReviseFixedPriceItem failed');
  }

  return {
    ack,
    warnings: asXmlArray(body?.Errors).map((e) => e.LongMessage).filter(Boolean)
  };
}

/**
 * The templatelistings row that currently describes a live listing.
 *
 * SKU is the only link templatelistings has to eBay — it stores no item id — so
 * this is the lookup, and it is read-only: the row is history and the revise
 * never writes to it.
 *
 * Collated to match the customLabel index, because a SKU imported from eBay
 * need not carry the casing this flow generates, and sorted newest-first so a
 * label that appears under more than one template resolves the same way twice.
 */
async function findListingRowForSku(sellerId, sku) {
  if (!sku) return null;
  return TemplateListing.findOne({ sellerId, customLabel: sku, deletedAt: null })
    .select('+_asinReference')
    .collation({ locale: 'en', strength: 2 })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Shared setup for both halves of the flow: validate the request, load the
 * seller, the effective template and the seller's pricing config, and get a
 * token. Returns { error } for the caller to surface, or the loaded context.
 */
async function loadReviseContext({ sellerId, itemId, asin, templateId }) {
  if (!mongoose.Types.ObjectId.isValid(String(sellerId || '')) || !String(itemId || '').trim()) {
    return { error: 'sellerId and itemId are required.', status: 400 };
  }

  const cleanAsinValue = String(asin || '').trim().toUpperCase();
  if (!ASIN_PATTERN.test(cleanAsinValue)) {
    return { error: 'A valid 10-character ASIN is required.', status: 400 };
  }

  if (!mongoose.Types.ObjectId.isValid(String(templateId || ''))) {
    return { error: 'A template must be selected.', status: 400 };
  }

  const seller = await Seller.findById(sellerId);
  if (!seller) return { error: 'Seller not found.', status: 404 };

  const template = await getEffectiveTemplate(templateId, sellerId);
  if (!template) return { error: 'Template not found.', status: 404 };
  if (!template.asinAutomation?.enabled) {
    return { error: `ASIN automation is not enabled for template "${template.name}".`, status: 400 };
  }

  // Seller-specific pricing overrides the template default, same precedence as
  // the bulk listing pipeline.
  const sellerConfig = await SellerPricingConfig.findOne({ sellerId, templateId });
  const pricingConfig = sellerConfig ? sellerConfig.pricingConfig : template.pricingConfig;

  const token = await ensureValidToken(seller);

  return { seller, template, pricingConfig, token, asin: cleanAsinValue };
}

/**
 * POST /amazon-stock-checks/revise-listing/preview
 *
 * Generates what the listing would become, and reads what it is now. Writes
 * nothing anywhere — the user reviews and edits the result before any of it
 * reaches eBay.
 */
router.post('/revise-listing/preview', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  try {
    const { sellerId, itemId, asin, templateId, currency, overlayBadgeId = '' } = req.body || {};

    const context = await loadReviseContext({ sellerId, itemId, asin, templateId });
    if (context.error) return res.status(context.status).json({ error: context.error });

    const { seller, template, pricingConfig, token } = context;
    const region = regionForCurrency(currency);

    const [snapshot, generated, skuResult] = await Promise.all([
      getListingSnapshot(token, String(itemId).trim()),
      generateListingFromAsin({
        asin: context.asin,
        template,
        seller,
        pricingConfig,
        region,
        overlayBadgeId,
        usageContext: buildReviseUsageContext(req, templateId, sellerId),
        ensureValidToken
      }),
      resolveAvailableSku({ asin: context.asin, sellerId })
    ]);

    const previousListing = await findListingRowForSku(sellerId, snapshot.sku);

    const warnings = [...generated.warnings];
    if (skuResult.bumped) {
      warnings.push(`SKU ${skuResult.sku} was chosen because earlier suffixes are already in use.`);
    }
    // Stated rather than left implicit: a revise that leaves pictures on Amazon
    // depends on eBay fetching each one while the listing is live, and a fetch
    // that fails strands the previous product's photo on the listing.
    if (generated.generatedListing.itemPhotoUrl && !generated.imagesHosted) {
      warnings.push('Pictures are not hosted on eBay — they will be sent as Amazon URLs for eBay to fetch.');
    }
    if (template.categoryId && snapshot.categoryId && String(template.categoryId) !== String(snapshot.categoryId)) {
      warnings.push(`This listing sits in eBay category ${snapshot.categoryId} (${snapshot.categoryName || 'unnamed'}) but the template targets ${template.categoryId}. The category is not changed by a revise.`);
    }
    if (!previousListing) {
      warnings.push(`No listing row found for SKU "${snapshot.sku}" — the old details cannot be linked to this revision.`);
    }

    res.json({
      itemId: String(itemId).trim(),
      asin: context.asin,
      region,
      // Echoed back so the apply call is bound to the template this preview was
      // actually generated from, rather than whatever the picker holds by then.
      templateId,
      newSku: skuResult.sku,
      imagesHosted: generated.imagesHosted,
      before: {
        ...snapshot,
        asin: previousListing?._asinReference || '',
        listingId: previousListing?._id || null
      },
      after: generated.generatedListing,
      sourceData: generated.sourceData,
      pricingCalculation: generated.pricingCalculation,
      overlayApplied: generated.overlayApplied,
      templateColumns: (template.customColumns || []).map((col) => ({
        name: col.name,
        displayName: col.displayName,
        dataType: col.dataType
      })),
      warnings,
      errors: generated.errors
    });
  } catch (error) {
    console.error('[revise-listing/preview] failed:', error.message);
    res.status(500).json({ error: error.message || 'Failed to build revise preview' });
  }
});

/**
 * POST /amazon-stock-checks/revise-listing/apply
 *
 * Pushes the reviewed content onto the live listing, then records the new ASIN
 * as its own listing row.
 *
 * Ordering matters: the before-snapshot is persisted BEFORE the eBay call, so a
 * crash in between still leaves a record the listing can be restored from —
 * the same discipline ListingOverlayItem uses.
 */
router.post('/revise-listing/apply', requireAuth, requirePageAccess(STOCK_CHECK_PAGES), async (req, res) => {
  let revision = null;

  try {
    const { sellerId, itemId, asin, templateId, listing = {} } = req.body || {};

    const context = await loadReviseContext({ sellerId, itemId, asin, templateId });
    if (context.error) return res.status(context.status).json({ error: context.error });

    const { template, token } = context;
    const cleanItemId = String(itemId).trim();

    const title = String(listing.title || '').trim();
    const price = listing.startPrice === '' || listing.startPrice == null ? null : Number(listing.startPrice);
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    if (price == null || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'A valid start price is required.' });
    }
    if (title.length > 80) return res.status(400).json({ error: 'Title must be 80 characters or fewer.' });

    // Read the live state and re-resolve the SKU server-side. Both were shown in
    // the preview, but either may have moved since — a concurrent revise, or a
    // bulk save that claimed the SKU.
    const [snapshot, skuResult] = await Promise.all([
      getListingSnapshot(token, cleanItemId),
      resolveAvailableSku({ asin: context.asin, sellerId })
    ]);

    const previousListing = await findListingRowForSku(sellerId, snapshot.sku);

    // Last guarantee that the pictures are eBay-hosted. A pure no-op when the
    // preview already hosted them — hostImagesOnEbay returns early once every
    // URL is on ebayimg.com — so the happy path costs nothing, and the only
    // time it does work is when hosting failed during preview and the reviewer
    // went ahead regardless.
    const requestedImages = splitImageList(listing.itemPhotoUrl || '');
    const hostResult = await hostImagesOnEbay(requestedImages, { sellerId: context.seller._id, token });
    const images = hostResult.applied ? hostResult.images : requestedImages;

    // The description embeds these same URLs. If hosting only happened just
    // now, rewrite them there too, or the gallery would sit on EPS while the
    // description still pointed at Amazon. Positional because hostImagesOnEbay
    // preserves order one-for-one; a literal split/join avoids having to escape
    // the URLs into a regex.
    let description = listing.description || '';
    if (hostResult.applied) {
      requestedImages.forEach((originalUrl, index) => {
        const hostedUrl = hostResult.images[index];
        if (hostedUrl && hostedUrl !== originalUrl) {
          description = description.split(originalUrl).join(hostedUrl);
        }
      });
    }

    const specifics = buildItemSpecifics(listing.customFields || {}, template.customColumns || []);

    revision = await ListingRevision.create({
      seller: sellerId,
      itemId: cleanItemId,
      templateId,
      previousAsin: previousListing?._asinReference || '',
      previousSku: snapshot.sku || '',
      previousListing: previousListing?._id || null,
      newAsin: context.asin,
      newSku: skuResult.sku,
      before: snapshot,
      after: {
        sku: skuResult.sku,
        title,
        price,
        currency: snapshot.currency,
        description,
        images,
        itemSpecifics: specifics.map((s) => ({ name: s.name, value: s.value })),
        categoryId: snapshot.categoryId,
        categoryName: snapshot.categoryName
      },
      status: 'pending',
      requestedBy: req.user?.userId || null
    });

    let ebayResult;
    try {
      ebayResult = await reviseListingToNewAsin({
        token,
        itemId: cleanItemId,
        sku: skuResult.sku,
        title,
        price,
        description,
        images,
        specifics
      });
    } catch (ebayError) {
      await ListingRevision.findByIdAndUpdate(revision._id, {
        status: 'failed',
        error: ebayError.message || 'Revise failed'
      });
      await AmazonStockActionLog.create({
        sku: snapshot.sku || '',
        asin: context.asin,
        seller: sellerId,
        itemId: cleanItemId,
        actionType: 'revise_listing',
        requestedBy: req.user?.userId || null,
        status: 'failed',
        requestPayload: { mode: 'asin_swap', newAsin: context.asin, newSku: skuResult.sku, revisionId: String(revision._id) },
        error: ebayError.message || 'Revise failed'
      });
      return res.status(502).json({ error: ebayError.message || 'eBay rejected the revise.' });
    }

    // eBay is committed from here on. Anything that fails below leaves a live
    // listing whose database row is missing, so it is reported as a distinct
    // state rather than rolled into a plain failure — the revise itself worked.
    try {
      const newListing = new TemplateListing({
        templateId,
        sellerId,
        customLabel: skuResult.sku,
        customFields: new Map(Object.entries(listing.customFields || {})),
        status: 'active',
        createdBy: req.user?.userId || null,
        aiRunId: listing._aiRunId || null,
        _asinReference: context.asin,
        _amazonSourcePrice: listing._amazonSourcePrice || null,
        // Already live on eBay, so it must never reach the CSV exporter — an
        // export would re-list it as a second listing carrying the same SKU.
        // The Active Batch view uses this same filter, so it stays out of there
        // too, while remaining visible under All batches.
        downloadBatchId: `revise-${revision._id}`,
        downloadedAt: new Date(),
        pendingRedownload: false,
        downloadBatchNumber: null,
        scheduleTime: ''
      });

      for (const field of TEMPLATE_LISTING_CORE_FIELDS) {
        if (listing[field] !== undefined && listing[field] !== null && listing[field] !== '') {
          newListing[field] = listing[field];
        }
      }
      // What eBay was actually given, which is not necessarily what the browser
      // sent: the hosting step above may have moved the pictures to EPS and
      // rewritten the description to match. The row has to record what is live.
      newListing.title = title;
      newListing.startPrice = price;
      newListing.description = description;
      if (images.length) newListing.itemPhotoUrl = images.join(IMAGE_LIST_SEPARATOR);

      await newListing.save();

      await ListingRevision.findByIdAndUpdate(revision._id, {
        status: 'success',
        newListing: newListing._id,
        appliedAt: new Date()
      });

      await AmazonStockActionLog.create({
        sku: skuResult.sku,
        asin: context.asin,
        seller: sellerId,
        itemId: cleanItemId,
        actionType: 'revise_listing',
        requestedBy: req.user?.userId || null,
        status: 'success',
        requestPayload: {
          mode: 'asin_swap',
          title,
          price,
          previousTitle: snapshot.title,
          previousPrice: snapshot.price,
          previousAsin: previousListing?._asinReference || '',
          previousSku: snapshot.sku || '',
          newAsin: context.asin,
          newSku: skuResult.sku,
          revisionId: String(revision._id)
        },
        responseSummary: { ack: ebayResult.ack, warnings: ebayResult.warnings }
      });

      res.json({
        ok: true,
        itemId: cleanItemId,
        newSku: skuResult.sku,
        newAsin: context.asin,
        previousSku: snapshot.sku || '',
        previousAsin: previousListing?._asinReference || '',
        listingId: newListing._id,
        revisionId: revision._id,
        warnings: ebayResult.warnings,
        message: `Item ${cleanItemId} now lists ${context.asin} as ${skuResult.sku}`
      });
    } catch (bookkeepingError) {
      console.error('[revise-listing/apply] eBay revised but bookkeeping failed:', bookkeepingError.message);
      await ListingRevision.findByIdAndUpdate(revision._id, {
        status: 'success',
        appliedAt: new Date(),
        bookkeepingError: bookkeepingError.message || 'Failed to save the new listing row'
      });
      res.status(500).json({
        error: `eBay item ${cleanItemId} was revised to ${context.asin}, but saving the new listing row failed: ${bookkeepingError.message}. The listing is live — add the row manually or retry.`,
        ebayRevised: true,
        revisionId: revision._id
      });
    }
  } catch (error) {
    console.error('[revise-listing/apply] failed:', error.message);
    if (revision) {
      await ListingRevision.findByIdAndUpdate(revision._id, {
        status: 'failed',
        error: error.message || 'Revise failed'
      }).catch(() => {});
    }
    res.status(500).json({ error: error.message || 'Failed to revise listing' });
  }
});

export default router;

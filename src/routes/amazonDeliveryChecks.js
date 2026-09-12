import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import pLimit from 'p-limit';
import { parseStringPromise } from 'xml2js';
import { requireAuth, requirePageAccess, requireFeatureAccess } from '../middleware/auth.js';

// Feature id used to gate who may run Estimate/Start on this page (superadmin
// always allowed; others must be explicitly granted via /feature-permissions).
// Separate from amazonStockCheck.run so granting one never grants the other.
export const AMAZON_DELIVERY_CHECK_RUN_FEATURE_ID = 'amazonDeliveryCheck.run';

const DELIVERY_CHECK_PAGES = ['AmazonDeliveryDateCheck'];

import SellerSkuIndex from '../models/SellerSkuIndex.js';
import TemplateListing from '../models/TemplateListing.js';
import Seller from '../models/Seller.js';
import Order from '../models/Order.js';
import AmazonDeliveryCheckRun from '../models/AmazonDeliveryCheckRun.js';
import AmazonDeliveryCheckItem from '../models/AmazonDeliveryCheckItem.js';
import AmazonDeliverySkuState from '../models/AmazonDeliverySkuState.js';
import { evaluateDeliveryDate, getCutoffDate } from '../utils/amazonDeliveryDate.js';
import {
  COUNTRY_CONFIG,
  DEFAULT_MAX_DELIVERY_DAYS,
  PILOT_OPTION_B_LIMITS,
  currencyAliases,
  estimateCredits,
  getConfig,
  getTestPilotScanLimit,
  normalizeCurrency,
  normalizeMaxDeliveryDays,
  normalizeSkuLimit,
  resolveCurrencies,
  resolveMode
} from '../utils/amazonDeliveryRunConfig.js';
// The verify panel shows exactly the same seller-listing rows as the stock
// check's — orders, prior end/revise actions, the 12-month sparkline. These two
// helpers build that shape; importing them keeps one implementation of the
// order-history maths rather than a second copy that can drift.
import { loadListingHistory, attachListingHistory } from './amazonStockChecks.js';
import { ensureValidToken } from './ebay.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();
const activeRuns = new Set();

// Scrapingdog enforces a per-ACCOUNT concurrency cap, and the stock check
// already claims 40 of it. Defaulting low means a delivery run started while a
// stock run is going cannot push the account over that shared cap and start
// returning 429s to BOTH pages — raise it only when nothing else is running.
const SCRAPINGDOG_CONCURRENT = Math.max(1, Number.parseInt(process.env.AMAZON_DELIVERY_CONCURRENT || '10', 10));
// Identifies which server instance owns/resumes runs — same convention as the
// stock check. Set RUNNER_ID=render in Render's env vars.
const RUNNER_ID = (process.env.RUNNER_ID || 'local').trim().toLowerCase();
// Delay before the single retry for a priced product whose delivery widget did
// not render — gives Amazon's async buy-box a moment longer to populate.
const MISSING_DELIVERY_RETRY_DELAY_MS = Math.max(500, Number.parseInt(process.env.AMAZON_DELIVERY_MISSING_RETRY_DELAY_MS || '3000', 10));
// Delay before the single retry for outright request failures (timeouts, 429,
// 5xx) — transient infrastructure hiccups, fixed by a plain re-request.
const ERROR_RETRY_DELAY_MS = Math.max(500, Number.parseInt(process.env.AMAZON_DELIVERY_ERROR_RETRY_DELAY_MS || '3000', 10));
// Pin the marketplace postal code on every request so delivery quotes come
// from one fixed destination instead of wherever the scraper happened to land.
// See fetchDeliveryProduct for the fallback when Scrapingdog rejects it.
const USE_POSTAL_CODE = String(process.env.AMAZON_DELIVERY_USE_POSTAL_CODE ?? 'true').trim().toLowerCase() !== 'false';
const PROCESS_BATCH_SIZE = Math.max(100, Number.parseInt(process.env.AMAZON_DELIVERY_PROCESS_BATCH_SIZE || '1000', 10));
const PREPARE_CHUNK_SIZE = Math.max(100, Number.parseInt(process.env.AMAZON_DELIVERY_PREPARE_CHUNK_SIZE || '1000', 10));
const RUN_ITEM_INSERT_BATCH_SIZE = Math.max(100, Number.parseInt(process.env.AMAZON_DELIVERY_ITEM_INSERT_BATCH_SIZE || '2000', 10));
const scrapingdogLimit = pLimit(SCRAPINGDOG_CONCURRENT);

// Statuses that mean "this item has been checked" — used to keep the run's
// KPI counters in step when a single item is re-checked.
const COUNTER_FIELD_BY_STATUS = {
  within_range: 'withinRangeCount',
  flagged_late: 'flaggedLateCount',
  out_of_stock: 'outOfStockCount',
  no_delivery_date: 'noDeliveryDateCount',
  error: 'errorCount'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deliveryCheckLog(stage, details = {}) {
  console.log(`[Amazon Delivery Check] ${stage}`, {
    timestamp: new Date().toISOString(),
    ...details
  });
}

function deliveryCheckWarn(stage, details = {}) {
  console.warn(`[Amazon Delivery Check] ${stage}`, {
    timestamp: new Date().toISOString(),
    ...details
  });
}

function getElapsedMs(startedAt) {
  return Date.now() - startedAt;
}

async function flushDeliveryItemBatch(batch) {
  if (!batch.length) return;
  await AmazonDeliveryCheckItem.insertMany(batch, { ordered: false });
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
      deliveryCheckWarn('mongoRetry', { label, attempt, attempts, delayMs, error: error.message });
      await sleep(delayMs);
    }
  }
  throw lastError;
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

export function classifyDeliveryCheckError(error) {
  const status = error?.response?.status || null;
  const message = error?.message || 'Delivery check failed';
  if (status) {
    // axios's own message is just "Request failed with status code 404" —
    // Scrapingdog's response body usually explains the actual reason (invalid
    // ASIN, plan/credit limit, concurrent-request limit), so surface it.
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
    return { errorType: 'scrapingdog_timeout', errorSource: 'scrapingdog', retryable: true, message };
  }
  if (/SCRAPINGDOG_API_KEY/i.test(message)) {
    return { errorType: 'configuration', errorSource: 'server', retryable: false, message };
  }
  return { errorType: 'delivery_check_failed', errorSource: 'server', retryable: true, message };
}

async function getRunStatus(runId) {
  const run = await AmazonDeliveryCheckRun.findById(runId).select('status').lean();
  return run?.status || '';
}

/**
 * Fetch one product from Scrapingdog.
 *
 * includePostalCode defaults to false: Scrapingdog confirmed that passing
 * postal_code was the root cause of a large, sustained wave of 400 errors.
 * That matters more here than it does for stock, because a delivery estimate
 * genuinely depends on the destination — without a pinned postal code the
 * quote comes from whatever location Amazon infers for the datacenter, so
 * these dates are a consistent comparison against each other, not a promise
 * of what one specific buyer sees. Opt in only when deliberately testing.
 */
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

  return { statusCode: response.status, data: response.data };
}

/**
 * Fetch a product with the marketplace's postal code pinned, falling back to
 * an unpinned request if Scrapingdog rejects it.
 *
 * Unlike stock text, a delivery estimate is meaningless without a destination
 * — an unpinned request is quoted from whatever location Amazon infers for the
 * datacenter, which is why the same ASIN can come back with different dates on
 * consecutive runs. Scrapingdog has previously answered postal_code with a
 * sustained wave of 400s, so a rejection falls back rather than failing the
 * item; `postalCodeUsed` records which of the two actually produced the data.
 * Set AMAZON_DELIVERY_USE_POSTAL_CODE=false to turn the pinning off entirely.
 */
async function fetchDeliveryProduct({ asin, currency }) {
  const config = getConfig(currency);
  if (!USE_POSTAL_CODE || !config?.postalCode) {
    const response = await fetchScrapingdogProduct({ asin, currency, includePostalCode: false });
    return { ...response, postalCodeUsed: '' };
  }

  try {
    const response = await fetchScrapingdogProduct({ asin, currency, includePostalCode: true });
    return { ...response, postalCodeUsed: config.postalCode };
  } catch (error) {
    const status = error?.response?.status || null;
    // Only a rejection of the request shape is worth retrying without the
    // postal code — a timeout or 5xx is transient and handled by the caller.
    if (status !== 400 && status !== 422) throw error;
    deliveryCheckWarn('fetchDeliveryProduct:postalCodeRejected', {
      asin,
      currency,
      status,
      postalCode: config.postalCode
    });
    const response = await fetchScrapingdogProduct({ asin, currency, includePostalCode: false });
    return { ...response, postalCodeUsed: '' };
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
    { $project: { seller: 1, dateSold: 1, creationDate: 1, itemNumber: 1, lineItems: 1 } }
  ]);
  deliveryCheckLog('enrichCandidates:orderLookupComplete', {
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
  deliveryCheckLog('buildCandidates:start', { currencies, mode, limit: limit || null, sellerId: sellerId ? String(sellerId) : null });
  const candidates = [];
  for (const currency of currencies) {
    const config = getConfig(currency);
    if (!config) continue;
    let runLimit = Number.parseInt(limit, 10) || null;
    if (mode === 'pilot_option_b') runLimit = PILOT_OPTION_B_LIMITS[config.currency];
    // test_pilot counts CHECKABLE SKUs, not candidates, so it scans a wide
    // slice here and stops later once enough ASINs have been found.
    if (mode === 'test_pilot') runLimit = getTestPilotScanLimit(normalizeSkuLimit(limit));

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
    deliveryCheckLog('buildCandidates:currencyComplete', {
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
  deliveryCheckLog('buildCandidates:complete', { candidateCount: candidates.length, elapsedMs: getElapsedMs(startedAt) });
  return candidates;
}

async function enrichCandidates(candidates, { includeSellerItems = true } = {}) {
  const startedAt = Date.now();
  const skus = [...new Set(candidates.map((row) => row.sku).filter(Boolean))];
  const lookupLabels = [...new Set(candidates.map((row) => row.baseSku).map(getBaseLabel).filter(Boolean))];
  deliveryCheckLog('enrichCandidates:start', {
    candidateCount: candidates.length,
    skuCount: skus.length,
    lookupLabelCount: lookupLabels.length,
    includeSellerItems
  });

  const templateStartedAt = Date.now();
  const templateRows = [];
  if (lookupLabels.length) {
    const indexedRows = await TemplateListing.find({
      baseCustomLabel: { $in: lookupLabels },
      _asinReference: { $exists: true, $ne: '' }
    })
      .select('customLabel baseCustomLabel +_asinReference')
      .collation({ locale: 'en', strength: 2 })
      .lean();
    templateRows.push(...indexedRows);
  }
  deliveryCheckLog('enrichCandidates:templateLookupComplete', {
    templateRowCount: templateRows.length,
    elapsedMs: getElapsedMs(templateStartedAt)
  });

  const asinByLabel = new Map();
  for (const row of templateRows) {
    const label = getBaseLabel(row.baseCustomLabel || row.customLabel).toUpperCase();
    const asin = cleanAsin(row._asinReference);
    if (!asinByLabel.has(label)) asinByLabel.set(label, asin);
  }

  const resolveAsin = (row) => {
    const baseSku = getBaseLabel(row.baseSku);
    const directAsin = isAmazonAsin(row.baseSku)
      ? cleanAsin(row.baseSku)
      : (isAmazonAsin(row.sku) ? cleanAsin(row.sku) : '');
    return directAsin || (baseSku ? (asinByLabel.get(baseSku.toUpperCase()) || '') : '');
  };

  if (!includeSellerItems) {
    const enriched = candidates.map((row) => ({ ...row, asin: resolveAsin(row), sellerItems: [] }));
    deliveryCheckLog('enrichCandidates:complete', {
      enrichedCount: enriched.length,
      asinFoundCount: enriched.filter((row) => row.asin).length,
      skippedSellerItems: true,
      elapsedMs: getElapsedMs(startedAt)
    });
    return enriched;
  }

  // Candidates are keyed by base SKU, so pull every index row whose base (or
  // exact, for legacy rows without a baseSku) matches.
  const skuIndexRows = await SellerSkuIndex.find({
    $or: [{ baseSku: { $in: skus } }, { sku: { $in: skus } }],
    currency: { $in: [...new Set(candidates.flatMap((row) => currencyAliases(row.currency)))] }
  }).lean();

  const sellerNameMap = await getSellerNameMap([...new Set(skuIndexRows.map((row) => row.seller).filter(Boolean))]);

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
      currency
    };
    arr.push(sellerItem);
    allSellerItems.push(sellerItem);
    sellerItemsByKey.set(key, arr);
  }

  const orderSummaryMap = await buildOrderSummaryMapForSellerItems(allSellerItems);

  const enriched = candidates.map((row) => ({
    ...row,
    asin: resolveAsin(row),
    sellerItems: attachOrderSummariesFromMap(sellerItemsByKey.get(`${row.currency}:${row.sku}`) || [], orderSummaryMap)
  }));

  deliveryCheckLog('enrichCandidates:complete', {
    enrichedCount: enriched.length,
    asinFoundCount: enriched.filter((row) => row.asin).length,
    sellerItemCount: allSellerItems.length,
    elapsedMs: getElapsedMs(startedAt)
  });
  return enriched;
}

/**
 * Persist one evaluated result onto its item + SKU state, and fold it into the
 * run's counters. Shared by the batch runner and the single-item recheck.
 */
async function applyDeliveryResult({ row, runId, parsed, scraper, creditMultiplier, retryAttempted, previous, currency }) {
  // "Newly late" means it was genuinely inside the SLA last time and is not
  // now — the case worth chasing. A SKU coming back from out_of_stock or from
  // an unreadable date was never known to be fine, so it does not qualify.
  const becameLate = parsed.status === 'flagged_late' && previous?.lastStatus === 'within_range';
  const checkedAt = new Date();

  await AmazonDeliveryCheckItem.findByIdAndUpdate(row._id, {
    status: parsed.status,
    deliveryDate: parsed.deliveryDate || '',
    deliveryDays: parsed.deliveryDays,
    earliestDeliveryDate: parsed.earliestDeliveryDate || '',
    earliestDeliveryDays: parsed.earliestDeliveryDays,
    fastestDeliveryDate: parsed.fastestDeliveryDate || '',
    fastestDeliveryDays: parsed.fastestDeliveryDays,
    deliveryText: parsed.deliveryText || '',
    deliveryLines: parsed.deliveryLines || [],
    availabilityText: parsed.availabilityText || '',
    soldBy: parsed.soldBy || '',
    shipsFrom: parsed.shipsFrom || '',
    postalCodeUsed: scraper.postalCodeUsed || '',
    quoteLocation: parsed.quoteLocation || '',
    maxDeliveryDays: parsed.maxDeliveryDays,
    scraperStatusCode: scraper.statusCode,
    retryAttempted,
    previousStatus: previous?.lastStatus || '',
    previousDeliveryDays: previous?.lastDeliveryDays ?? null,
    becameLate,
    error: '',
    errorType: '',
    errorSource: '',
    retryable: false,
    checkedAt
  });

  await AmazonDeliverySkuState.findOneAndUpdate(
    { sku: row.sku, asin: row.asin, currency: row.currency },
    {
      sku: row.sku,
      asin: row.asin,
      currency: row.currency,
      country: row.country,
      lastStatus: parsed.status,
      lastDeliveryDate: parsed.deliveryDate || '',
      lastDeliveryDays: parsed.deliveryDays,
      lastMaxDeliveryDays: parsed.maxDeliveryDays,
      lastRun: runId,
      lastCheckedAt: checkedAt
    },
    { upsert: true }
  );

  return {
    becameLate,
    creditsUsed: (getConfig(currency)?.credits || 0) * creditMultiplier
  };
}

/**
 * Scrape one SKU's ASIN and judge its delivery date against the run's SLA.
 *
 * Retries once for a transient request failure, and once more when the
 * response carries a price but no delivery text at all — that combination
 * means the buy-box widget had not rendered, not that Amazon quotes no date.
 */
async function processDeliveryItem({ itemDoc, run, runId }) {
  const row = itemDoc;
  const claim = await AmazonDeliveryCheckItem.updateOne(
    { _id: row._id, status: 'queued' },
    { $set: { status: 'processing' } }
  );
  if (claim.modifiedCount !== 1) return;

  // Tracked outside the try so the catch handler can still record it if the
  // retry itself ends up failing too.
  let errorRetryAttempted = false;

  try {
    const previous = await AmazonDeliverySkuState.findOne({
      sku: row.sku,
      asin: row.asin,
      currency: row.currency
    }).lean();

    let scraper;
    try {
      scraper = await fetchDeliveryProduct({ asin: row.asin, currency: row.currency });
    } catch (fetchError) {
      const classified = classifyDeliveryCheckError(fetchError);
      if (!classified.retryable) throw fetchError;
      errorRetryAttempted = true;
      await sleep(ERROR_RETRY_DELAY_MS);
      scraper = await fetchDeliveryProduct({ asin: row.asin, currency: row.currency });
    }

    const maxDeliveryDays = run.maxDeliveryDays ?? DEFAULT_MAX_DELIVERY_DAYS;
    let parsed = evaluateDeliveryDate(scraper.data, { currency: row.currency, maxDeliveryDays });
    let creditMultiplier = errorRetryAttempted ? 2 : 1;

    // A missing delivery date is the one result worth paying to re-check.
    // Amazon's delivery widget renders asynchronously and often just hasn't
    // populated at capture time, so a second look usually turns a blank into a
    // real date. Retried whatever the offer looked like — the earlier
    // price-present condition skipped exactly the responses that came back
    // most empty, which were the ones that most needed another try.
    //
    // A late date is NOT re-checked: it is a real answer, not a missing one,
    // and re-scraping every late SKU spends credits to re-litigate a verdict
    // rather than to obtain one. Use Recheck on a row to confirm one by hand.
    if (parsed.status === 'no_delivery_date') {
      await sleep(MISSING_DELIVERY_RETRY_DELAY_MS);
      try {
        const retryScraper = await fetchDeliveryProduct({ asin: row.asin, currency: row.currency });
        const retryParsed = evaluateDeliveryDate(retryScraper.data, { currency: row.currency, maxDeliveryDays });
        creditMultiplier += 1;
        scraper = retryScraper;
        parsed = retryParsed;
        deliveryCheckLog('processDeliveryItem:missingDateRetried', {
          sku: row.sku,
          asin: row.asin,
          resolvedTo: retryParsed.status,
          deliveryDays: retryParsed.deliveryDays
        });
      } catch (retryError) {
        deliveryCheckWarn('processDeliveryItem:retryFailed', {
          sku: row.sku,
          asin: row.asin,
          error: retryError.message
        });
      }
    }

    const applied = await applyDeliveryResult({
      row,
      runId,
      parsed,
      scraper,
      creditMultiplier,
      retryAttempted: creditMultiplier > 1,
      previous,
      currency: row.currency
    });

    await AmazonDeliveryCheckRun.findByIdAndUpdate(runId, {
      $inc: {
        checkedCount: 1,
        creditsUsed: applied.creditsUsed,
        withinRangeCount: parsed.status === 'within_range' ? 1 : 0,
        flaggedLateCount: parsed.status === 'flagged_late' ? 1 : 0,
        outOfStockCount: parsed.status === 'out_of_stock' ? 1 : 0,
        noDeliveryDateCount: parsed.status === 'no_delivery_date' ? 1 : 0,
        becameLateCount: applied.becameLate ? 1 : 0
      }
    });
  } catch (error) {
    const classified = classifyDeliveryCheckError(error);
    await AmazonDeliveryCheckItem.findByIdAndUpdate(row._id, {
      status: 'error',
      error: classified.message,
      errorType: classified.errorType,
      errorSource: classified.errorSource,
      retryable: classified.retryable,
      retryAttempted: errorRetryAttempted,
      checkedAt: new Date()
    });
    await AmazonDeliveryCheckRun.findByIdAndUpdate(runId, { $inc: { checkedCount: 1, errorCount: 1 } });
  }
}

async function processQueuedDeliveryBatches({ run, runId, maxBatches = Infinity, startingBatch = 0 }) {
  let processedBatchCount = startingBatch;
  const queuedFilter = { run: runId, status: 'queued', asin: { $exists: true, $ne: '' } };
  let queuedCount = await AmazonDeliveryCheckItem.countDocuments(queuedFilter);

  while (queuedCount > 0 && processedBatchCount - startingBatch < maxBatches) {
    const status = await getRunStatus(runId);
    if (status === 'paused' || status === 'cancelled') break;

    const batchStartedAt = Date.now();
    const queuedItems = await AmazonDeliveryCheckItem.find(queuedFilter)
      .sort({ sku: 1, _id: 1 })
      .limit(PROCESS_BATCH_SIZE)
      .lean();

    if (!queuedItems.length) break;

    await Promise.all(queuedItems.map((itemDoc) => scrapingdogLimit(() => processDeliveryItem({ itemDoc, run, runId }))));
    processedBatchCount += 1;
    queuedCount = await AmazonDeliveryCheckItem.countDocuments(queuedFilter);

    deliveryCheckLog('processRun:batchComplete', {
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
  const existingItemCount = await AmazonDeliveryCheckItem.countDocuments({ run: runId });
  if (existingItemCount > 0 && run.candidateBuildComplete) {
    const completedItemCount = await AmazonDeliveryCheckItem.countDocuments({
      run: runId,
      status: { $nin: ['queued', 'no_asin'] }
    });
    if (run.totalSkus > 0 && existingItemCount < run.totalSkus && completedItemCount === 0) {
      deliveryCheckWarn('processRun:partialInitializationRebuild', {
        runId: String(runId),
        existingItemCount,
        expectedItemCount: run.totalSkus
      });
      await AmazonDeliveryCheckItem.deleteMany({ run: runId });
    } else {
      deliveryCheckLog('processRun:itemsAlreadyInitialized', { runId: String(runId), existingItemCount, completedItemCount });
      return;
    }
  }

  const currencies = run.currencies.map(normalizeCurrency);
  // test_pilot is capped by how many SKUs actually resolve to an ASIN, which
  // is only known after enrichment — so the quota is enforced in the chunk
  // loop below rather than by the candidate query.
  const isTestPilot = run.mode === 'test_pilot';
  const asinQuota = isTestPilot ? normalizeSkuLimit(run.skuLimit) : Infinity;
  const candidates = await withMongoRetry('Build SKU candidate list', () => buildCandidates({
    currencies,
    mode: run.mode,
    limit: isTestPilot ? asinQuota : null,
    sellerId: run.seller || null
  }));
  await AmazonDeliveryCheckRun.findByIdAndUpdate(runId, {
    totalSkus: isTestPilot ? Math.min(asinQuota, candidates.length) : candidates.length,
    candidateBuildComplete: false
  });

  const existingKeys = new Set();
  if (existingItemCount > 0) {
    const existingRows = await AmazonDeliveryCheckItem.find({ run: runId }).select('currency sku').lean();
    for (const row of existingRows) existingKeys.add(`${row.currency}:${row.sku}`);
  }

  let preparedCount = existingKeys.size;
  let asinInsertedCount = await AmazonDeliveryCheckItem.countDocuments({ run: runId, asin: { $exists: true, $ne: '' } });
  for (let offset = 0; offset < candidates.length; offset += PREPARE_CHUNK_SIZE) {
    if (asinInsertedCount >= asinQuota) break;

    const status = await getRunStatus(runId);
    if (status === 'cancelled' || status === 'paused') return;

    const chunkStartedAt = Date.now();
    const chunk = candidates.slice(offset, offset + PREPARE_CHUNK_SIZE)
      .filter((row) => !existingKeys.has(`${row.currency}:${row.sku}`));
    if (!chunk.length) continue;

    let enriched = await withMongoRetry('Map base SKUs to ASINs', () => enrichCandidates(chunk));
    if (isTestPilot) {
      // A test run of N SKUs means N real delivery checks: rows with no ASIN
      // are dropped instead of stored, so the KPI cards describe the test
      // rather than being swamped by unscrapeable SKUs.
      enriched = enriched.filter((row) => row.asin).slice(0, asinQuota - asinInsertedCount);
      if (!enriched.length) continue;
    }
    const asinFoundCount = enriched.reduce((count, row) => count + (row.asin ? 1 : 0), 0);
    const noAsinCount = enriched.length - asinFoundCount;
    const creditsEstimated = enriched.reduce((sum, row) => sum + (row.asin ? (getConfig(row.currency)?.credits || 0) : 0), 0);
    asinInsertedCount += asinFoundCount;

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
            maxDeliveryDays: run.maxDeliveryDays,
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
            maxDeliveryDays: run.maxDeliveryDays,
            sellerItems: row.sellerItems,
            hasRecentOrder90d,
            error: 'No ASIN found from TemplateListing._asinReference',
            errorType: 'no_asin_found',
            errorSource: 'template_listing',
            retryable: false,
            checkedAt: new Date()
          });

      if (batch.length >= RUN_ITEM_INSERT_BATCH_SIZE) {
        await flushDeliveryItemBatch(batch);
      }
    }
    await flushDeliveryItemBatch(batch);
    preparedCount += enriched.length;

    await AmazonDeliveryCheckRun.findByIdAndUpdate(runId, {
      $inc: { asinFoundCount, noAsinCount, creditsEstimated }
    });

    deliveryCheckLog('processRun:itemsChunkInitialized', {
      runId: String(runId),
      preparedCount,
      totalSkus: candidates.length,
      chunkSize: enriched.length,
      asinFoundCount,
      noAsinCount,
      elapsedMs: getElapsedMs(chunkStartedAt)
    });

    await processQueuedDeliveryBatches({ run, runId, maxBatches: 1 });
  }

  const [finalItemCount, finalAsinFoundCount, finalNoAsinCount] = await Promise.all([
    AmazonDeliveryCheckItem.countDocuments({ run: runId }),
    AmazonDeliveryCheckItem.countDocuments({ run: runId, asin: { $exists: true, $ne: '' } }),
    AmazonDeliveryCheckItem.countDocuments({ run: runId, status: 'no_asin' })
  ]);
  const finalCreditRows = await AmazonDeliveryCheckItem.aggregate([
    { $match: { run: runId, asin: { $exists: true, $ne: '' } } },
    { $group: { _id: '$currency', count: { $sum: 1 } } }
  ]);
  const finalCreditsEstimated = finalCreditRows.reduce((sum, row) => sum + (row.count * (getConfig(row._id)?.credits || 0)), 0);

  await AmazonDeliveryCheckRun.findByIdAndUpdate(runId, {
    totalSkus: finalItemCount,
    asinFoundCount: finalAsinFoundCount,
    noAsinCount: finalNoAsinCount,
    creditsEstimated: finalCreditsEstimated,
    candidateBuildComplete: true,
    // Ran out of candidates before filling the quota — the page says so
    // rather than silently checking fewer SKUs than were asked for.
    skuLimitUnmet: isTestPilot && finalAsinFoundCount < asinQuota
  });

  deliveryCheckLog('processRun:itemsInitialized', {
    runId: String(runId),
    totalSkus: finalItemCount,
    asinFoundCount: finalAsinFoundCount,
    asinQuota: isTestPilot ? asinQuota : null
  });
}

async function processRun(runId) {
  if (activeRuns.has(String(runId))) return;
  activeRuns.add(String(runId));

  try {
    const run = await AmazonDeliveryCheckRun.findById(runId);
    if (!run) return;
    if (run.status === 'cancelled' || run.status === 'paused') return;

    run.status = 'running';
    if (!run.startedAt) run.startedAt = new Date();
    await run.save();

    await initializeRunItems(run);

    deliveryCheckLog('processRun:checksStart', {
      runId: String(runId),
      maxDeliveryDays: run.maxDeliveryDays,
      scrapingdogConcurrent: SCRAPINGDOG_CONCURRENT
    });

    const result = await processQueuedDeliveryBatches({ run, runId });

    deliveryCheckLog('processRun:checksComplete', {
      runId: String(runId),
      batches: result.processedBatchCount,
      queuedRemaining: result.queuedCount
    });

    const latestStatus = await getRunStatus(runId);
    if (latestStatus === 'paused' || latestStatus === 'cancelled') return;

    await AmazonDeliveryCheckRun.findByIdAndUpdate(runId, { status: 'completed', completedAt: new Date() });
  } catch (error) {
    const dbHint = isTransientMongoError(error)
      ? 'MongoDB connection timed out while preparing the run. No Scrapingdog credits were used before SKU preparation completed. '
      : '';
    await AmazonDeliveryCheckRun.findByIdAndUpdate(runId, {
      status: 'failed',
      error: `${dbHint}${error.message || 'Run failed'}`,
      completedAt: new Date()
    });
  } finally {
    activeRuns.delete(String(runId));
  }
}

export async function resumeRunningAmazonDeliveryCheckRuns() {
  // Boot-resume only adopts runs THIS server owns, so a restart on one server
  // can never steal a run being processed by the other.
  const ownershipFilter = RUNNER_ID === 'render'
    ? { $or: [{ runnerId: { $in: [null, ''] } }, { runnerId: RUNNER_ID }] }
    : { runnerId: RUNNER_ID };

  const runs = await AmazonDeliveryCheckRun.find({
    status: { $in: ['queued', 'running'] },
    ...ownershipFilter
  }).sort({ createdAt: 1 }).lean();

  deliveryCheckLog('resume:scan', { runnerId: RUNNER_ID, adoptableRunCount: runs.length });

  for (const run of runs) {
    await AmazonDeliveryCheckItem.updateMany(
      { run: run._id, status: 'processing', asin: { $exists: true, $ne: '' } },
      { $set: { status: 'queued' } }
    );

    const queuedItemCount = await AmazonDeliveryCheckItem.countDocuments({
      run: run._id,
      status: 'queued',
      asin: { $exists: true, $ne: '' }
    });
    const totalItemCount = await AmazonDeliveryCheckItem.countDocuments({ run: run._id });

    if (totalItemCount > 0 && queuedItemCount === 0) {
      await AmazonDeliveryCheckRun.findByIdAndUpdate(run._id, {
        status: 'completed',
        completedAt: new Date(),
        error: ''
      });
      continue;
    }

    deliveryCheckLog('resume:runQueued', { runId: String(run._id), status: run.status, totalItemCount, queuedItemCount });
    setTimeout(() => processRun(run._id), 0);
  }

  return runs.length;
}

function normalizeItemFilters(filter) {
  return String(filter || 'flagged_late')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function getItemFilterCondition(filter) {
  if (filter === 'within_range') return { status: 'within_range' };
  if (filter === 'flagged_late') return { status: 'flagged_late' };
  // $ne true (not a strict false check) so items checked before this field
  // existed — which simply lack it — still fall into the "no orders" bucket
  // instead of vanishing from both counts.
  if (filter === 'flagged_late_no_orders') return { status: 'flagged_late', hasRecentOrder90d: { $ne: true } };
  if (filter === 'flagged_late_with_orders') return { status: 'flagged_late', hasRecentOrder90d: true };
  if (filter === 'out_of_stock') return { status: 'out_of_stock' };
  if (filter === 'no_delivery_date') return { status: 'no_delivery_date' };
  if (filter === 'errors') return { status: 'error' };
  if (filter === 'no_asin') return { status: 'no_asin' };
  if (filter === 'became_late') return { becameLate: true };
  if (filter === 'has_orders') return { 'sellerItems.orderCount': { $gt: 0 } };
  if (filter === 'checked') return { status: { $nin: ['queued', 'processing', 'no_asin'] } };
  // "Needs attention": a late date, or one we could not read at all.
  if (filter === 'actionable') return { status: { $in: ['flagged_late', 'no_delivery_date'] } };
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
  const filters = [
    'all',
    'actionable',
    'checked',
    'within_range',
    'flagged_late',
    'flagged_late_no_orders',
    'flagged_late_with_orders',
    'out_of_stock',
    'no_delivery_date',
    'errors',
    'no_asin',
    'became_late',
    'has_orders'
  ];

  const results = await Promise.all(filters.map((filter) => (
    AmazonDeliveryCheckItem.countDocuments(buildItemFilterQuery(runId, filter, sellerId))
  )));

  return Object.fromEntries(filters.map((filter, index) => [filter, results[index]]));
}

// GET /amazon-delivery-checks/seller-summary?sellerId=...
// Per-currency SKU index summary for one seller (mirrors the SKU Index
// Dashboard math) so the run panel can show what a seller-scoped run covers.
router.get('/seller-summary', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), asyncHandler(async (req, res) => {
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
    { $group: { _id: { currency: '$normalizedCurrency', sku: '$sku' }, listingCount: { $sum: 1 } } },
    {
      $group: {
        _id: '$_id.currency',
        uniqueSkuCount: { $sum: 1 },
        listingCount: { $sum: '$listingCount' }
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
      listingCount: row.listingCount
    };
  });

  res.json({ sellerId, currencies });
}));

// GET /amazon-delivery-checks/items/:itemId/verify
// Everything the split-screen verify panel needs for one checked SKU: the
// Amazon product URL for its marketplace, plus every seller listing carrying
// the base SKU with its order history and any prior end/revise actions.
router.get('/items/:itemId/verify', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.itemId))) {
    return res.status(400).json({ error: 'Invalid item id' });
  }
  const item = await AmazonDeliveryCheckItem.findById(req.params.itemId).lean();
  if (!item) return res.status(404).json({ error: 'Item result not found' });

  const run = await AmazonDeliveryCheckRun.findById(item.run).select('seller').lean();
  const runSellerId = run?.seller ? String(run.seller) : null;
  const config = getConfig(item.currency);
  const amazonUrl = item.asin && config ? `https://www.amazon.${config.domain}/dp/${item.asin}` : '';

  // Gather item IDs live from the SKU index by BASE SKU (same currency), so
  // variant listings like GRW25X and GRW25X-1 are reviewed together and the
  // list reflects the current index rather than the run-time snapshot.
  const exactSku = cleanSku(item.sku);
  const baseLabel = getBaseLabel(item.sku);
  const baseCandidates = [...new Set([exactSku, baseLabel].filter(Boolean))];
  const indexRows = baseCandidates.length
    ? await SellerSkuIndex.find({
        currency: { $in: currencyAliases(item.currency) },
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
      currency: normalizeCurrency(row.currency)
    }));
  } else {
    // Index has no rows for this base SKU any more (e.g. everything was ended
    // and re-synced) — fall back to the snapshot stored on the run.
    sellerItems = (item.sellerItems || []).map((row) => ({ ...row, sku: item.sku }));
  }

  const itemIds = [...new Set(sellerItems.map((row) => row.itemId).filter(Boolean))];
  const [sellerNameMap, history] = await Promise.all([
    indexRows.length
      ? getSellerNameMap([...new Set(indexRows.map((row) => row.seller).filter(Boolean))])
      : Promise.resolve(new Map()),
    loadListingHistory(itemIds)
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

  const enrichedSellerItems = attachListingHistory(sellerItems, history, {
    fallbackSku: item.sku,
    fallbackCurrency: item.currency,
    runSellerId
  });

  res.json({
    sku: item.sku,
    asin: item.asin,
    currency: item.currency,
    country: item.country,
    status: item.status,
    deliveryDate: item.deliveryDate,
    deliveryDays: item.deliveryDays,
    earliestDeliveryDate: item.earliestDeliveryDate,
    earliestDeliveryDays: item.earliestDeliveryDays,
    fastestDeliveryDays: item.fastestDeliveryDays,
    maxDeliveryDays: item.maxDeliveryDays,
    deliveryText: item.deliveryText,
    deliveryLines: item.deliveryLines || [],
    availabilityText: item.availabilityText,
    soldBy: item.soldBy,
    shipsFrom: item.shipsFrom,
    postalCodeUsed: item.postalCodeUsed,
    quoteLocation: item.quoteLocation,
    amazonUrl,
    runSellerId,
    // Live recompute (not the stored snapshot) so it reflects orders placed
    // since the run last checked this SKU.
    hasRecentOrder90d: enrichedSellerItems.some((row) => (row.orderCount90d || 0) > 0),
    sellerItems: enrichedSellerItems
  });
}));

// POST /amazon-delivery-checks/live-images
// Current listing images straight from eBay (Trading GetItem) for the verify
// panel. Any connected seller's token can read public items; the panel passes
// its selected seller. Fetched lazily by the client so verify stays fast.
const liveImageLimit = pLimit(6);
router.post('/live-images', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), asyncHandler(async (req, res) => {
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
}));

// GET /amazon-delivery-checks/estimate
// How many SKUs a run would cover and what it would cost, without spending a
// single credit — same two-phase candidate build the run itself uses.
router.get('/estimate', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), requireFeatureAccess(AMAZON_DELIVERY_CHECK_RUN_FEATURE_ID), asyncHandler(async (req, res) => {
  const requestStartedAt = Date.now();
  const sellerId = mongoose.Types.ObjectId.isValid(String(req.query.sellerId || '')) ? String(req.query.sellerId) : null;
  const mode = resolveMode(req.query.mode, sellerId);
  const currencies = resolveCurrencies(mode, req.query.currencies);
  const skuLimit = normalizeSkuLimit(req.query.skuLimit);
  const isTestPilot = mode === 'test_pilot';

  deliveryCheckLog('estimate:start', { mode, currencies, sellerId, skuLimit: isTestPilot ? skuLimit : null, userId: req.user?.userId || null });

  const candidates = await buildCandidates({
    currencies,
    mode,
    limit: isTestPilot ? skuLimit : req.query.limit,
    sellerId
  });
  const enriched = await enrichCandidates(candidates, { includeSellerItems: false });
  // A test pilot only ever checks SKUs that resolve to an ASIN, and stops at
  // skuLimit — so the estimate has to describe that slice, not the whole scan.
  const withAsin = isTestPilot
    ? enriched.filter((row) => row.asin).slice(0, skuLimit)
    : enriched.filter((row) => row.asin);
  const totalSkus = isTestPilot ? withAsin.length : enriched.length;
  const maxDeliveryDays = normalizeMaxDeliveryDays(req.query.maxDeliveryDays);

  deliveryCheckLog('estimate:complete', {
    mode,
    currencies,
    totalSkus,
    asinFoundCount: withAsin.length,
    creditsEstimated: estimateCredits(withAsin),
    elapsedMs: getElapsedMs(requestStartedAt)
  });

  res.json({
    mode,
    currencies,
    maxDeliveryDays,
    skuLimit: isTestPilot ? skuLimit : null,
    // True when the scan could not find as many checkable SKUs as were asked
    // for, so the page can warn before any credits are spent.
    skuLimitUnmet: isTestPilot && withAsin.length < skuLimit,
    totalSkus,
    asinFoundCount: withAsin.length,
    noAsinCount: isTestPilot ? 0 : enriched.length - withAsin.length,
    candidatesScanned: enriched.length,
    creditsEstimated: estimateCredits(withAsin),
    plan: currencies.map((currency) => ({
      ...getConfig(currency),
      cutoffDate: getCutoffDate(maxDeliveryDays, { currency }),
      skuCount: (isTestPilot ? withAsin : enriched).filter((row) => row.currency === currency).length,
      asinFoundCount: withAsin.filter((row) => row.currency === currency).length
    }))
  });
}));

router.post('/runs', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), requireFeatureAccess(AMAZON_DELIVERY_CHECK_RUN_FEATURE_ID), asyncHandler(async (req, res) => {
  const sellerId = mongoose.Types.ObjectId.isValid(String(req.body?.sellerId || '')) ? String(req.body.sellerId) : null;
  const mode = resolveMode(req.body?.mode, sellerId);
  const currencies = resolveCurrencies(mode, req.body?.currencies);

  if (!currencies.length) {
    return res.status(400).json({ error: 'Select at least one supported currency.' });
  }

  if (sellerId) {
    const sellerExists = await Seller.exists({ _id: sellerId });
    if (!sellerExists) return res.status(404).json({ error: 'Seller not found.' });
  }

  const run = await AmazonDeliveryCheckRun.create({
    countries: currencies.map((currency) => getConfig(currency).country),
    currencies,
    status: 'queued',
    mode,
    seller: sellerId,
    skuLimit: mode === 'test_pilot' ? normalizeSkuLimit(req.body?.skuLimit) : null,
    maxDeliveryDays: normalizeMaxDeliveryDays(req.body?.maxDeliveryDays),
    requestedBy: req.user?.userId || null,
    runnerId: RUNNER_ID
  });

  setTimeout(() => processRun(run._id), 0);
  res.status(201).json({ run });
}));

router.post('/runs/:runId/pause', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), requireFeatureAccess(AMAZON_DELIVERY_CHECK_RUN_FEATURE_ID), asyncHandler(async (req, res) => {
  const run = await AmazonDeliveryCheckRun.findById(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!['queued', 'running'].includes(run.status)) {
    return res.status(400).json({ error: `Run cannot be paused from status ${run.status}` });
  }

  run.status = 'paused';
  await run.save();
  await AmazonDeliveryCheckItem.updateMany({ run: run._id, status: 'processing' }, { $set: { status: 'queued' } });
  res.json({ run, message: 'Run paused.' });
}));

router.post('/runs/:runId/resume', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), requireFeatureAccess(AMAZON_DELIVERY_CHECK_RUN_FEATURE_ID), asyncHandler(async (req, res) => {
  const run = await AmazonDeliveryCheckRun.findById(req.params.runId);
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
  await AmazonDeliveryCheckItem.updateMany({ run: run._id, status: 'processing' }, { $set: { status: 'queued' } });
  setTimeout(() => processRun(run._id), 0);
  res.json({ run, message: 'Run resumed.' });
}));

router.post('/runs/:runId/cancel', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), requireFeatureAccess(AMAZON_DELIVERY_CHECK_RUN_FEATURE_ID), asyncHandler(async (req, res) => {
  const run = await AmazonDeliveryCheckRun.findById(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (['completed', 'failed', 'cancelled'].includes(run.status)) {
    return res.status(400).json({ error: `Run cannot be cancelled from status ${run.status}` });
  }

  run.status = 'cancelled';
  run.completedAt = new Date();
  await run.save();
  await AmazonDeliveryCheckItem.updateMany({ run: run._id, status: 'processing' }, { $set: { status: 'queued' } });
  res.json({ run, message: 'Run cancelled.' });
}));

router.get('/runs', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
  const limit = Math.min(50, Math.max(5, Number.parseInt(req.query.limit || '20', 10)));
  const skip = (page - 1) * limit;
  const runQuery = {};
  if (mongoose.Types.ObjectId.isValid(String(req.query.sellerId || ''))) {
    runQuery.seller = String(req.query.sellerId);
  }
  const [runs, total] = await Promise.all([
    AmazonDeliveryCheckRun.find(runQuery)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('requestedBy', 'username name email')
      .lean(),
    AmazonDeliveryCheckRun.countDocuments(runQuery)
  ]);
  res.json({
    runs,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  });
}));

router.get('/runs/:runId', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), asyncHandler(async (req, res) => {
  const run = await AmazonDeliveryCheckRun.findById(req.params.runId).populate('requestedBy', 'username name email').lean();
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const itemCounts = await getItemFilterCounts(req.params.runId, req.query.sellerId);
  // The cutoff is recomputed from today rather than the run date: it is shown
  // as "what this SLA means right now", and a run read a week later would
  // otherwise display a date already in the past.
  const cutoffDate = getCutoffDate(run.maxDeliveryDays ?? DEFAULT_MAX_DELIVERY_DAYS, { currency: run.currencies?.[0] || 'USD' });
  res.json({ run, itemCounts, cutoffDate });
}));

router.get('/runs/:runId/items', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), asyncHandler(async (req, res) => {
  const filter = String(req.query.filter || 'flagged_late').trim();
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
  const limit = Math.min(500, Math.max(25, Number.parseInt(req.query.limit || '100', 10)));
  const query = buildItemFilterQuery(req.params.runId, filter, req.query.sellerId);
  const skip = (page - 1) * limit;

  // Slowest first: the whole point of the page is the worst offenders. A null
  // deliveryDays (no date read) sorts after every number in a descending sort,
  // so unreadable rows trail the real results instead of leading the table.
  const [items, total] = await Promise.all([
    AmazonDeliveryCheckItem.find(query)
      .sort({ deliveryDays: -1, status: 1, sku: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AmazonDeliveryCheckItem.countDocuments(query)
  ]);

  res.json({
    items,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  });
}));

// POST /amazon-delivery-checks/items/:itemId/recheck
// Re-scrape one SKU against its run's SLA. The first thing anyone does with a
// flagged row is confirm it is still late, and without this the only way to do
// that is to start a whole new run. Costs one product credit per click.
router.post('/items/:itemId/recheck', requireAuth, requirePageAccess(DELIVERY_CHECK_PAGES), requireFeatureAccess(AMAZON_DELIVERY_CHECK_RUN_FEATURE_ID), asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.itemId))) {
    return res.status(400).json({ error: 'Invalid item id' });
  }
  const item = await AmazonDeliveryCheckItem.findById(req.params.itemId).lean();
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!item.asin) return res.status(400).json({ error: 'This SKU has no ASIN to check.' });
  // The run's own worker owns queued/processing rows. Rechecking one here
  // would race it — two scrapes billed, and whichever finishes last wins.
  if (['queued', 'processing'].includes(item.status)) {
    return res.status(409).json({ error: 'This SKU is still being checked by the run — wait for it to finish.' });
  }

  const run = await AmazonDeliveryCheckRun.findById(item.run).select('maxDeliveryDays').lean();
  const maxDeliveryDays = run?.maxDeliveryDays ?? item.maxDeliveryDays ?? DEFAULT_MAX_DELIVERY_DAYS;

  let scraper;
  try {
    scraper = await fetchDeliveryProduct({ asin: item.asin, currency: item.currency });
  } catch (error) {
    const classified = classifyDeliveryCheckError(error);
    return res.status(502).json({ error: classified.message, errorType: classified.errorType });
  }

  const previous = await AmazonDeliverySkuState.findOne({
    sku: item.sku,
    asin: item.asin,
    currency: item.currency
  }).lean();

  const parsed = evaluateDeliveryDate(scraper.data, { currency: item.currency, maxDeliveryDays });
  const applied = await applyDeliveryResult({
    row: item,
    runId: item.run,
    parsed,
    scraper,
    creditMultiplier: 1,
    retryAttempted: false,
    previous,
    currency: item.currency
  });

  // Move the run's KPI counters from the old status to the new one so the
  // cards keep matching the rows. checkedCount is untouched — this item was
  // already counted as checked by the run that produced it.
  const previousField = COUNTER_FIELD_BY_STATUS[item.status];
  const nextField = COUNTER_FIELD_BY_STATUS[parsed.status];
  const counterUpdate = { creditsUsed: applied.creditsUsed, becameLateCount: applied.becameLate ? 1 : 0 };
  if (previousField && previousField !== nextField) counterUpdate[previousField] = -1;
  if (nextField && previousField !== nextField) counterUpdate[nextField] = (counterUpdate[nextField] || 0) + 1;
  await AmazonDeliveryCheckRun.findByIdAndUpdate(item.run, { $inc: counterUpdate });

  const updated = await AmazonDeliveryCheckItem.findById(item._id).lean();
  res.json({ item: updated, message: `Rechecked ${item.sku}: ${parsed.status.replace(/_/g, ' ')}.` });
}));

export default router;

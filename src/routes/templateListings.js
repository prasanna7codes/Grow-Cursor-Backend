import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireAuthSSE, requirePageAccess } from '../middleware/auth.js';
import { requireObjectId } from '../middleware/objectId.js';
import TemplateListing from '../models/TemplateListing.js';
import ListingTemplate from '../models/ListingTemplate.js';
import Seller from '../models/Seller.js';
import Order from '../models/Order.js';
import SellerPricingConfig from '../models/SellerPricingConfig.js';
import { fetchAmazonData, applyFieldConfigs } from '../utils/asinAutofill.js';
import { calculateStartPrice } from '../utils/pricingCalculator.js';
import { generateWithGemini } from '../utils/gemini.js';
import { generateSKUFromASIN, generateSKUWithCount } from '../utils/skuGenerator.js';
import { getEffectiveTemplate } from '../utils/templateMerger.js';
import { applyOverlayMapping, resolveEffectiveBadgeKey, resolveSavedImageList, resolveTemplateOverlay, withOverlaidImages } from '../utils/overlayImage.js';
import { ensureValidToken } from './ebay.js';
import { getUsageStats, getFieldExtractionStats, getRecentErrors, checkQuotaStatus } from '../utils/apiUsageTracker.js';
import { getAsinCacheStats, clearAsinCache, invalidateAsinCache } from '../utils/asinCache.js';
import AsinDirectory from '../models/AsinDirectory.js';
import AsinPrecheckLog from '../models/AsinPrecheckLog.js';
import ApiUsage from '../models/ApiUsage.js';
import AiListingRun from '../models/AiListingRun.js';
import SellerSkuIndex from '../models/SellerSkuIndex.js';
import User from '../models/User.js';

const router = express.Router();
const EXCLUDED_CLIENT_USERNAME = 'Vergo';

async function getExcludedClientSellerIds() {
  const excludedUsers = await User.find({
    username: { $regex: new RegExp(`^${EXCLUDED_CLIENT_USERNAME}$`, 'i') },
  })
    .select('_id')
    .lean();

  if (excludedUsers.length === 0) return [];

  return Seller.find({
    user: { $in: excludedUsers.map(user => user._id) },
  }).distinct('_id');
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function getClientIpInfo(req) {
  const cfConnectingIp = firstHeaderValue(req.headers['cf-connecting-ip']).trim();
  if (cfConnectingIp) {
    return { ipAddress: cfConnectingIp, ipSource: 'cf-connecting-ip' };
  }

  const trueClientIp = firstHeaderValue(req.headers['true-client-ip']).trim();
  if (trueClientIp) {
    return { ipAddress: trueClientIp, ipSource: 'true-client-ip' };
  }

  const xRealIp = firstHeaderValue(req.headers['x-real-ip']).trim();
  if (xRealIp) {
    return { ipAddress: xRealIp, ipSource: 'x-real-ip' };
  }

  const forwardedFor = firstHeaderValue(req.headers['x-forwarded-for']);
  const firstForwardedIp = forwardedFor.split(',').map(ip => ip.trim()).find(Boolean);
  if (firstForwardedIp) {
    return { ipAddress: firstForwardedIp, ipSource: 'x-forwarded-for' };
  }

  return { ipAddress: req.ip, ipSource: 'req.ip' };
}

function createAiRunContext(prefix = 'listing') {
  const startedAt = new Date();
  return {
    aiRunId: `${prefix}-${startedAt.getTime()}-${new mongoose.Types.ObjectId().toString()}`,
    aiRunStartedAt: startedAt
  };
}

function buildAiUsageContext(req, templateId, sellerId, runContext = {}) {
  const ipInfo = getClientIpInfo(req);
  return {
    templateId,
    sellerId,
    userId: req.user?.userId,
    aiRunId: runContext.aiRunId,
    aiRunStartedAt: runContext.aiRunStartedAt,
    ipAddress: ipInfo.ipAddress,
    ipSource: ipInfo.ipSource,
    forwardedFor: req.headers['x-forwarded-for'] || '',
    userAgent: req.get('user-agent') || ''
  };
}

function getListingAiRunId(listingData = {}) {
  return listingData._aiRunId || listingData.aiRunId || listingData._runId || listingData.runId || null;
}

async function recordReviewSaveCounts({ listings = [], results = [], templateId, sellerId, userId, dismissedByRunId = [] }) {
  const savedStatuses = new Set(['created', 'updated', 'reactivated']);
  const countsByRunId = new Map();
  const updateableDuplicateCountsByRunId = new Map();
  const dismissedCountsByRunId = new Map();
  const dismissedNewCountsByRunId = new Map();
  const dismissedUpdateableDuplicateCountsByRunId = new Map();

  results.forEach((result, index) => {
    if (!savedStatuses.has(result.status)) return;
    const listingData = listings[index] || {};
    const aiRunId = getListingAiRunId(listingData);
    if (!aiRunId) return;
    countsByRunId.set(aiRunId, (countsByRunId.get(aiRunId) || 0) + 1);
    if (listingData._isDuplicateUpdate) {
      updateableDuplicateCountsByRunId.set(
        aiRunId,
        (updateableDuplicateCountsByRunId.get(aiRunId) || 0) + 1
      );
    }
  });

  dismissedByRunId.forEach((item) => {
    const aiRunId = item?.aiRunId;
    if (!aiRunId) return;
    dismissedCountsByRunId.set(
      aiRunId,
      (dismissedCountsByRunId.get(aiRunId) || 0) + Number(item.dismissedCount || 0)
    );
    dismissedNewCountsByRunId.set(
      aiRunId,
      (dismissedNewCountsByRunId.get(aiRunId) || 0) + Number(item.dismissedNewAsinCount || 0)
    );
    dismissedUpdateableDuplicateCountsByRunId.set(
      aiRunId,
      (dismissedUpdateableDuplicateCountsByRunId.get(aiRunId) || 0) + Number(item.dismissedUpdateableDuplicateCount || 0)
    );
  });

  const runIds = new Set([
    ...countsByRunId.keys(),
    ...dismissedCountsByRunId.keys()
  ]);

  await Promise.all([...runIds].map((aiRunId) => {
    const savedCount = countsByRunId.get(aiRunId) || 0;
    const dismissedCount = dismissedCountsByRunId.get(aiRunId) || 0;
    return (
    AiListingRun.findOneAndUpdate(
      { aiRunId },
      {
        $setOnInsert: { aiRunId },
        $set: {
          templateId,
          sellerId,
          userId,
          lastSavedFromReviewAt: new Date()
        },
        $inc: {
          savedFromReviewCount: savedCount,
          updateableDuplicateCount: updateableDuplicateCountsByRunId.get(aiRunId) || 0,
          dismissedFromReviewCount: dismissedCount,
          dismissedNewAsinCount: dismissedNewCountsByRunId.get(aiRunId) || 0,
          dismissedUpdateableDuplicateCount: dismissedUpdateableDuplicateCountsByRunId.get(aiRunId) || 0,
          reviewSaveAttempts: 1
        }
      },
      { upsert: true, new: true }
    )
    );
  }));

  return [...runIds].map((aiRunId) => ({
    aiRunId,
    savedCount: countsByRunId.get(aiRunId) || 0,
    updateableDuplicateCount: updateableDuplicateCountsByRunId.get(aiRunId) || 0,
    dismissedCount: dismissedCountsByRunId.get(aiRunId) || 0,
    dismissedNewAsinCount: dismissedNewCountsByRunId.get(aiRunId) || 0,
    dismissedUpdateableDuplicateCount: dismissedUpdateableDuplicateCountsByRunId.get(aiRunId) || 0
  }));
}

function buildDirectorySourceData(doc, priceOverride = null) {
  if (!doc) return null;

  return {
    title: doc.title || '',
    brand: doc.brand || '',
    price: priceOverride ?? doc.price ?? '',
    description: doc.description || '',
    images: doc.images || [],
    color: doc.color || '',
    compatibility: doc.compatibility || ''
  };
}

function buildAmazonSourceData(amazonData) {
  return {
    title: amazonData.title,
    brand: amazonData.brand,
    price: amazonData.price,
    description: amazonData.description,
    images: amazonData.images,
    color: amazonData.color,
    compatibility: amazonData.compatibility,
    productInfo: amazonData.productInfo || null
  };
}

/**
 * Resolve the overlay badge for a batch, plus the eBay token needed to host the
 * composites, once per request instead of once per ASIN.
 *
 * When the caller doesn't name a badge, the template's default is used. That is
 * what lets paths with no picker of their own — the ASIN List page's directory
 * stream, and any future entry point — apply the overlay without each one
 * having to plumb a parameter through. Whether a template badges its listings
 * is decided once, in Manage Templates, rather than per batch.
 *
 * A batch that wants no overlay despite the default says so with NO_OVERLAY.
 * The batch picker needs that: a template whose default badge suits most of its
 * ASINs but not this batch's has no other way to say so.
 *
 * Returns null whenever the overlay can't be applied — opted out, no badge
 * requested and no default, unknown badge, badge not enabled on the template,
 * or no usable seller token — so the preview runs exactly as it did before
 * rather than failing.
 */
async function prepareOverlayContext(template, seller, badgeKey, source = 'listing') {
  const { badgeKey: effectiveKey, usingDefault, optedOut } = resolveEffectiveBadgeKey(template, badgeKey);

  // Log every outcome, including "nothing requested". An overlay that quietly
  // doesn't apply looks identical to one that was never asked for, and the CSV
  // only reveals it after export.
  //
  // Opting out is logged apart from the rest precisely because it isn't a
  // problem — routing it through the "unavailable" warning below would put a
  // misconfiguration-shaped line in the log every time someone deliberately
  // turned the badge off, and this log is how overlay problems get diagnosed.
  if (optedOut) {
    console.log(`🏷️ [${source}] Overlay turned off for this batch`);
    return null;
  }

  if (!effectiveKey) {
    console.log(`🏷️ [${source}] No overlay requested and no template default`);
    return null;
  }

  const overlay = resolveTemplateOverlay(template, effectiveKey);
  if (!overlay) {
    console.warn(`🏷️ [${source}] Overlay "${effectiveKey}" unavailable (not enabled on this template, or not registered) — continuing without it`);
    return null;
  }

  try {
    const token = await ensureValidToken(seller);
    console.log(`🏷️ [${source}] Overlay "${effectiveKey}"${usingDefault ? ' (template default)' : ''} active (${Math.round(overlay.placement.scale * 100)}% ${overlay.placement.anchor})`);
    return { overlay, ctx: { sellerId: seller._id, token } };
  } catch (error) {
    console.error(`🏷️ [${source}] Overlay "${effectiveKey}" skipped — no eBay token for seller ${seller._id}: ${error.message}`);
    return null;
  }
}

/**
 * Apply the batch's overlay to amazonData's images, if one is active. Badges
 * the primary and moves every image onto eBay Picture Services, since eBay
 * rejects listings that mix its own hosted pictures with external URLs.
 *
 * Always returns a usable object — never throws — so a badge failure can't
 * take down a preview.
 */
async function applyBatchOverlay(amazonData, overlayContext) {
  if (!overlayContext) return { data: amazonData, applied: false };
  return withOverlaidImages(amazonData, overlayContext.overlay, overlayContext.ctx);
}

function calculatePricingOnly(asin, amazonPrice, pricingConfig) {
  if (!pricingConfig?.enabled) return null;

  if (!amazonPrice || String(amazonPrice).trim() === '') {
    console.warn(`[ASIN: ${asin}] ⚠️ duplicate pricing: Amazon price not available — cannot calculate startPrice`);
    return {
      enabled: true,
      error: 'Amazon price not available'
    };
  }

  try {
    const amazonCost = parseFloat(String(amazonPrice).replace(/[^0-9.]/g, ''));

    if (!isNaN(amazonCost) && amazonCost > 0) {
      const result = calculateStartPrice(pricingConfig, amazonCost);
      const pricingCalculation = {
        enabled: true,
        amazonCost: amazonPrice,
        calculatedStartPrice: result.price.toFixed(2),
        breakdown: result.breakdown
      };

      if (result.breakdown.profitTier?.enabled) {
        console.log(`[ASIN: ${asin}] 💰 duplicate pricing: ${amazonPrice} → $${result.price.toFixed(2)} (tier: ${result.breakdown.profitTier.costRange}, +₹${result.breakdown.profitTier.profit})`);
      } else {
        console.log(`[ASIN: ${asin}] 💰 duplicate pricing: ${amazonPrice} → $${result.price.toFixed(2)}`);
      }

      return pricingCalculation;
    }

    console.warn(`[ASIN: ${asin}] ⚠️ duplicate pricing: invalid price "${amazonPrice}" (parsed: ${amazonCost})`);
    return {
      enabled: true,
      error: `Invalid price value: ${amazonPrice}`
    };
  } catch (error) {
    console.error(`[ASIN: ${asin}] ❌ duplicate pricing error: ${error.message}`);
    return {
      enabled: true,
      error: error.message
    };
  }
}

async function runWithConcurrency(items, concurrency, worker, shouldContinue = () => true) {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length && shouldContinue()) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (!shouldContinue()) break;
      await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.allSettled(workers);
}

function getBaseSku(sku = '') {
  const cleanSku = String(sku || '').trim();
  return cleanSku.replace(/-\d+$/, '');
}

function parseNumericPrice(value) {
  const price = parseFloat(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(price) ? price : null;
}

// Scrapingdog returns counts as comma-grouped strings ("109,583") —
// Number() alone would yield NaN and ?? does not fall through on NaN.
function toNumeric(value) {
  if (typeof value === 'string') return Number(value.replace(/,/g, '').trim());
  return Number(value);
}

const MARKETPLACE_TIMEZONES = {
  US: 'America/Los_Angeles',
  UK: 'Europe/London',
  CA: 'America/Toronto',
  AU: 'Australia/Sydney'
};

const MONTH_INDEX = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};

function getMarketplaceLocalDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(date);

  return {
    year: Number(parts.find(part => part.type === 'year')?.value),
    month: Number(parts.find(part => part.type === 'month')?.value) - 1,
    day: Number(parts.find(part => part.type === 'day')?.value)
  };
}

function parseShippingDate(shippingValue, scrapedAt, timezone) {
  const raw = String(shippingValue || '').trim();
  const match = raw.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!match) return { deliveryDate: null, deliveryDays: null };

  const scrapedLocal = getMarketplaceLocalDateParts(scrapedAt, timezone);
  const month = MONTH_INDEX[match[1].toLowerCase()];
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : scrapedLocal.year;

  let deliveryUtc = Date.UTC(year, month, day);
  const scrapedUtc = Date.UTC(scrapedLocal.year, scrapedLocal.month, scrapedLocal.day);

  if (!match[3] && deliveryUtc < scrapedUtc) {
    year += 1;
    deliveryUtc = Date.UTC(year, month, day);
  }

  const deliveryDays = Math.round((deliveryUtc - scrapedUtc) / 86400000);
  return {
    deliveryDate: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    deliveryDays: Number.isFinite(deliveryDays) ? deliveryDays : null
  };
}

function getPrecheckEnrichment(amazonData = {}, region = 'US', scrapedAt = new Date()) {
  const rawData = amazonData.rawData?.rawData || amazonData.rawData || {};
  const customerReviews = rawData.product_information?.customer_reviews || {};
  const rating = toNumeric(rawData.average_rating ?? customerReviews.stars ?? 0);
  const reviewCount = toNumeric(rawData.total_reviews ?? rawData.total_ratings ?? customerReviews.ratings_count ?? 0);
  const availabilityStatus = String(rawData.availability_status || '').trim();
  // shipping_time is ScraperAPI's name; Scrapingdog exposes the same info as
  // shipping_info (string) and delivery (array of strings). Keep the old name
  // first so cached ScraperAPI-shape entries and rollback mode still resolve.
  const deliveryLines = Array.isArray(rawData.delivery) ? rawData.delivery.filter(Boolean).map(String) : [];
  const shippingTime = String(rawData.shipping_time || rawData.shipping_info || deliveryLines[0] || '').trim();
  const shippingCondition = String(rawData.shipping_condition || '').trim();
  const marketplaceTimezone = MARKETPLACE_TIMEZONES[region] || MARKETPLACE_TIMEZONES.US;
  const delivery = parseShippingDate(shippingTime || shippingCondition, scrapedAt, marketplaceTimezone);
  const availabilityLower = availabilityStatus.toLowerCase();
  let inStock = null;
  if (availabilityStatus) {
    if (availabilityLower.includes('out of stock') || availabilityLower.includes('unavailable')) {
      inStock = false;
    } else if (availabilityLower.includes('in stock') || availabilityLower.includes('available')) {
      inStock = true;
    }
  }

  return {
    price: amazonData.price || '',
    priceNumber: parseNumericPrice(amazonData.price),
    availabilityStatus,
    inStock,
    rating: Number.isFinite(rating) && rating > 0 ? rating : null,
    reviewCount: Number.isFinite(reviewCount) && reviewCount > 0 ? reviewCount : null,
    shippingTime,
    shippingCondition,
    marketplaceTimezone,
    scrapedAt: scrapedAt.toISOString(),
    deliveryDate: delivery.deliveryDate,
    deliveryDays: delivery.deliveryDays
  };
}

function parseJsonObject(text = '') {
  const raw = String(text || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

function detectVehicleYearText(title = '') {
  const yearPattern = /\b(?:19[5-9]\d|20[0-4]\d)(?:\s*[-–/]\s*(?:\d{2}|19[5-9]\d|20[0-4]\d))?\b/g;
  return [...new Set(String(title || '').match(yearPattern) || [])].slice(0, 8);
}

function detectUniversalPhrase(title = '') {
  const match = String(title || '').match(/\b(universal(?:\s+fit)?|fits\s+most\s+(?:cars|vehicles|trucks|motorcycles)|for\s+most\s+(?:cars|vehicles|trucks|motorcycles))\b/i);
  return match ? match[0] : '';
}

function detectKnownVehicleModelPhrase(title = '') {
  const text = String(title || '');
  const knownModelPattern = /\b(?:Harley\s+Davidson|Sportster|Softail|Dyna|Electra\s+Glide|Road\s+King|Fatboy|Touring|Chevy|Chevrolet|Silverado|Colorado|Ford|F-?150|F-?250|F-?350|Ram|Dodge|Jeep|Wrangler|Toyota|Tacoma|Tundra|Camry|Corolla|Honda|Civic|Accord|BMW|Mercedes|Audi|Nissan|Altima|Sentra|Subaru|Outback|Forester|Yamaha|Kawasaki|Suzuki|Polaris|Can-Am)\b/i;
  const match = text.match(knownModelPattern);
  return match ? match[0] : '';
}

async function classifyEbayMotorsTitle(title, asin, usageContext = {}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) {
    return {
      eligible: false,
      reason: 'No title found',
      signals: { hasModel: false, hasYear: false, isUniversal: false },
      detected: { modelNames: [], years: [], universalPhrase: '' }
    };
  }

  const prompt = `
You are checking if an Amazon product title is suitable for an eBay Motors listing precheck.

Pass rule:
- eligible=true if the title contains BOTH a vehicle model name and a year/year range.
- Otherwise eligible=false.

Definitions:
- eBay Motors includes cars, trucks, motorcycles, powersports, ATV/UTV, and their parts.
- A vehicle model name can be a real vehicle make/model/trim/platform/family such as Silverado, Colorado, F-150, Civic, Wrangler, X5, G05, Camry, Tacoma, Harley Davidson Sportster, Dyna, Softail, Yamaha YZF, Polaris Ranger, etc.
- A year/year range means a model year like 2024, or a range like 2019-2024, 2023 2024 2025, 1999-06.
- Universal fit does NOT pass by itself. Universal products must still be excluded unless the title also has BOTH a vehicle model name and a year/year range.
- Do not require the exact word "model"; detect actual vehicle model names from the title.
- Engine sizes or product part numbers alone are not vehicle model names.

Return only valid JSON:
{
  "eligible": boolean,
  "reason": "short reason",
  "signals": {
    "hasModel": boolean,
    "hasYear": boolean,
    "isUniversal": boolean
  },
  "detected": {
    "modelNames": ["detected vehicle model names"],
    "years": ["detected years or year ranges"],
    "universalPhrase": "detected universal phrase or empty string"
  }
}

Examples:
- "27490-96 Carburetor for Harley Davidson Sportster 883 Sportster 1200 1988-2007" => eligible=true, hasModel=true, hasYear=true.
- "Universal Mud Flaps for Cars Trucks SUV" => eligible=false, isUniversal=true, because model and year are missing.
- "Carburetor for Predator 4000 Champion Honda 3500 Generator" => eligible=false because vehicle model and year are missing.

Title: ${cleanTitle}
`.trim();

  try {
    const response = await generateWithGemini(prompt, {
      maxTokens: 180,
      asin,
      fieldName: 'ebay_motors_title_eligibility',
      fieldType: 'precheck',
      // Dedicated key for ASIN precheck AI; falls back to OPENAI_API_KEY if unset
      apiKey: process.env.OPENAI_PRECHECK_API_KEY,
      ...usageContext
    });
    const parsed = parseJsonObject(response);
    if (!parsed || typeof parsed.eligible !== 'boolean') {
      throw new Error('Invalid eligibility response');
    }

    const signals = parsed.signals || {};
    const detected = parsed.detected || {};
    const modelNames = normalizeStringArray(detected.modelNames);
    const years = normalizeStringArray(detected.years);
    const universalPhrase = String(detected.universalPhrase || '').trim();
    const fallbackYears = detectVehicleYearText(cleanTitle);
    const fallbackUniversalPhrase = detectUniversalPhrase(cleanTitle);
    const fallbackModelPhrase = detectKnownVehicleModelPhrase(cleanTitle);
    const hasModel = Boolean(signals.hasModel) || modelNames.length > 0 || Boolean(fallbackModelPhrase);
    const hasYear = Boolean(signals.hasYear) || years.length > 0 || fallbackYears.length > 0;
    const isUniversal = Boolean(signals.isUniversal) || Boolean(universalPhrase) || Boolean(fallbackUniversalPhrase);
    const eligible = hasModel && hasYear;
    const normalizedDetected = {
      modelNames: modelNames.length > 0 ? modelNames : (fallbackModelPhrase ? [fallbackModelPhrase] : []),
      years: years.length > 0 ? years : fallbackYears,
      universalPhrase: universalPhrase || fallbackUniversalPhrase
    };
    const reason = eligible
      ? String(parsed.reason || 'Contains vehicle model and year fitment').slice(0, 180)
      : String(
          isUniversal
            ? 'Universal product excluded; model name and year are required'
            : parsed.reason || 'Missing vehicle model name or year'
        ).slice(0, 180);

    return {
      eligible,
      reason,
      signals: {
        hasModel,
        hasYear,
        isUniversal
      },
      detected: normalizedDetected
    };
  } catch (error) {
    console.warn(`[ASIN Precheck] eBay Motors title check failed for ${asin}:`, error.message);
    return {
      eligible: false,
      reason: 'Could not verify eBay Motors fitment from title',
      signals: { hasModel: false, hasYear: false, isUniversal: false },
      detected: { modelNames: [], years: [], universalPhrase: '' }
    };
  }
}

function getSkuLookupValues(sku = '') {
  return [...new Set([String(sku || '').trim(), getBaseSku(sku)].filter(Boolean))];
}

function toObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

function normalizeMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function getPTDayBoundsUTC(dateStr) {
  function getPTHour(d) {
    return parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: 'numeric',
        hour12: false,
        hourCycle: 'h23',
      }).format(d),
      10,
    );
  }

  function getPTDateStr(d) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }

  function findMidnightUTC(ds) {
    const pst = new Date(`${ds}T08:00:00.000Z`);
    if (getPTDateStr(pst) === ds && getPTHour(pst) === 0) return pst;
    const pdt = new Date(`${ds}T07:00:00.000Z`);
    if (getPTDateStr(pdt) === ds && getPTHour(pdt) === 0) return pdt;
    return pst;
  }

  const start = findMidnightUTC(dateStr);
  const tmp = new Date(`${dateStr}T12:00:00.000Z`);
  tmp.setUTCDate(tmp.getUTCDate() + 1);
  const nextStart = findMidnightUTC(tmp.toISOString().split('T')[0]);
  return { start, end: new Date(nextStart.getTime() - 1) };
}

router.get('/asin-precheck-stream', requireAuthSSE, async (req, res) => {
  let heartbeat = null;

  try {
    const { templateId, sellerId, asins: asinsParam, region = 'US' } = req.query;
    const ebayMotorsMode = String(req.query.ebayMotorsMode || '').toLowerCase() === 'true';

    if (!templateId || !sellerId || !asinsParam) {
      return res.status(400).json({ error: 'Template ID, Seller ID, and ASINs are required' });
    }

    const asins = [
      ...new Set(
        String(asinsParam)
          .split(',')
          .map(a => a.trim().toUpperCase())
          .filter(Boolean)
      )
    ];

    if (asins.length === 0) {
      return res.status(400).json({ error: 'At least one ASIN is required' });
    }

    if (asins.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 ASINs allowed per batch' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    let streamClosed = false;
    const sendSse = (payload) => {
      if (streamClosed) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    };
    const sendDone = () => {
      if (streamClosed) return;
      res.write('data: [DONE]\n\n');
      if (typeof res.flush === 'function') res.flush();
    };

    heartbeat = setInterval(() => {
      sendSse({ type: 'ping', timestamp: Date.now() });
    }, 15000);

    req.on('close', () => {
      streamClosed = true;
      if (heartbeat) clearInterval(heartbeat);
    });

    const [seller, template] = await Promise.all([
      Seller.findById(sellerId).select('_id').lean(),
      getEffectiveTemplate(templateId, sellerId)
    ]);

    if (!seller || !template) {
      sendSse({ type: 'error', error: 'Seller or template not found' });
      sendDone();
      if (heartbeat) clearInterval(heartbeat);
      return res.end();
    }

    // Log this batch for the Precheck Stats page (counts by country/date/user/
    // seller). Fire-and-forget: a failed log never blocks the precheck. The
    // doc is kept so per-item retry counters can be added to it below.
    const precheckLogPromise = AsinPrecheckLog.create({
      user: req.user?.userId || null,
      seller: sellerId,
      template: templateId,
      region: ['US', 'UK', 'CA', 'AU'].includes(region) ? region : 'US',
      asins,
      asinCount: asins.length
    }).catch((error) => {
      console.error('[ASIN Precheck] Failed to log precheck batch:', error.message);
      return null;
    });

    const generatedRows = asins.map(asin => {
      const sku = generateSKUFromASIN(asin);
      return { asin, sku, baseSku: getBaseSku(sku) };
    });

    const skuValues = [...new Set(generatedRows.flatMap(row => [row.sku, row.baseSku]).filter(Boolean))];
    const activeRecords = skuValues.length > 0
      ? await SellerSkuIndex.find({
          seller: sellerId,
          $or: [
            { sku: { $in: skuValues } },
            { baseSku: { $in: skuValues } }
          ]
        }).select('sku baseSku').lean()
      : [];

    const activeSkuSet = new Set();
    activeRecords.forEach(record => {
      if (record.sku) activeSkuSet.add(record.sku);
      if (record.baseSku) activeSkuSet.add(record.baseSku);
    });

    const streamConcurrency = parseInt(process.env.ASIN_PRECHECK_CONCURRENCY, 10)
      || parseInt(process.env.SCRAPER_API_CONCURRENT, 10)
      || 10;
    const rowByAsin = new Map(generatedRows.map(row => [row.asin, row]));
    let completed = 0;

    const usageContext = buildAiUsageContext(req, templateId, sellerId);

    sendSse({
      type: 'started',
      total: asins.length,
      concurrency: Math.min(streamConcurrency, asins.length),
      ebayMotorsMode
    });

    await runWithConcurrency(asins, streamConcurrency, async (asin) => {
      if (streamClosed) return;

      const generated = rowByAsin.get(asin) || {
        sku: generateSKUFromASIN(asin),
        baseSku: getBaseSku(generateSKUFromASIN(asin))
      };

      try {
        sendSse({
          type: 'item_started',
          asin,
          id: `asin-precheck-${asin}`,
          progressStage: 'fetching'
        });

        const scrapedAt = new Date();
        const amazonData = await fetchAmazonData(asin, region);

        // Count the missing-stock-info re-fetch (fresh fetches only — cache
        // hits carry availabilityRetry: null) on this batch's stats log.
        if (amazonData.availabilityRetry?.attempted) {
          const retrySucceeded = Boolean(amazonData.availabilityRetry.succeeded);
          precheckLogPromise.then((logDoc) => {
            if (!logDoc) return;
            AsinPrecheckLog.updateOne(
              { _id: logDoc._id },
              { $inc: { availabilityRetryCount: 1, availabilityRetrySuccessCount: retrySucceeded ? 1 : 0 } }
            ).catch((err) => console.error('[ASIN Precheck] Failed to log retry:', err.message));
          });
        }

        const sourceData = buildAmazonSourceData(amazonData);
        const active = activeSkuSet.has(generated.sku) || activeSkuSet.has(generated.baseSku);
        const enrichment = getPrecheckEnrichment(amazonData, region, scrapedAt);
        const ebayMotorsEligibility = ebayMotorsMode
          ? await classifyEbayMotorsTitle(amazonData.title || '', asin, usageContext)
          : null;

        sendSse({
          type: 'item',
          item: {
            id: `asin-precheck-${asin}`,
            asin,
            sku: generated.sku,
            baseSku: generated.baseSku,
            active,
            activeStatus: active ? 'active' : 'inactive',
            title: amazonData.title || '',
            image: Array.isArray(amazonData.images) ? amazonData.images[0] || '' : '',
            ...enrichment,
            ebayMotorsMode,
            ebayMotorsEligible: ebayMotorsEligibility?.eligible ?? null,
            ebayMotorsReason: ebayMotorsEligibility?.reason || '',
            ebayMotorsSignals: ebayMotorsEligibility?.signals || null,
            ebayMotorsDetected: ebayMotorsEligibility?.detected || null,
            intent: ebayMotorsEligibility && !ebayMotorsEligibility.eligible ? 'excluded' : 'neutral',
            sourceData,
            status: 'success',
            progressStage: 'complete',
            errors: []
          },
          progress: ++completed,
          total: asins.length
        });
      } catch (error) {
        console.error(`[ASIN Precheck] Error processing ${asin}:`, error.message);
        const active = activeSkuSet.has(generated.sku) || activeSkuSet.has(generated.baseSku);

        sendSse({
          type: 'item',
          item: {
            id: `asin-precheck-${asin}`,
            asin,
            sku: generated.sku,
            baseSku: generated.baseSku,
            active,
            activeStatus: active ? 'active' : 'inactive',
            title: '',
            image: '',
            price: '',
            priceNumber: null,
            availabilityStatus: '',
            inStock: null,
            rating: null,
            reviewCount: null,
            shippingTime: '',
            shippingCondition: '',
            marketplaceTimezone: MARKETPLACE_TIMEZONES[region] || MARKETPLACE_TIMEZONES.US,
            scrapedAt: new Date().toISOString(),
            deliveryDate: null,
            deliveryDays: null,
            ebayMotorsMode,
            ebayMotorsEligible: ebayMotorsMode ? false : null,
            ebayMotorsReason: ebayMotorsMode ? 'Could not check title eligibility' : '',
            ebayMotorsSignals: ebayMotorsMode ? { hasModel: false, hasYear: false, isUniversal: false } : null,
            ebayMotorsDetected: ebayMotorsMode ? { modelNames: [], years: [], universalPhrase: '' } : null,
            intent: ebayMotorsMode ? 'excluded' : 'neutral',
            sourceData: null,
            status: 'error',
            progressStage: 'complete',
            errors: [error.message]
          },
          progress: ++completed,
          total: asins.length
        });
      }
    }, () => !streamClosed);

    sendSse({ type: 'complete', total: completed });
    sendDone();
    if (heartbeat) clearInterval(heartbeat);
    res.end();
  } catch (error) {
    console.error('[ASIN Precheck] Stream error:', error);
    if (heartbeat) clearInterval(heartbeat);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to run ASIN precheck', details: error.message });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

router.get('/sku-seller-order-profit', requireAuth, requirePageAccess('SkuSellerOrderProfit'), async (req, res) => {
  try {
    const {
      search = '',
      sellerId = '',
      page = 1,
      limit = 50,
      orderFrom = '',
      orderTo = '',
      createdFrom = '',
      createdTo = '',
      marketplace = '',
      searchMarketplace = '',
      excludeClient = '',
      excludeLowValue = '',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const sellerObjectId = sellerId && sellerId !== 'all' ? toObjectId(sellerId) : null;
    const trimmedSearch = String(search || '').trim();
    const fromValue = orderFrom || createdFrom;
    const toValue = orderTo || createdTo;
    const marketplaceValue = marketplace || searchMarketplace;

    if (sellerId && sellerId !== 'all' && !sellerObjectId) {
      return res.status(400).json({ error: 'Invalid sellerId' });
    }
    if (!fromValue || !toValue) {
      return res.status(400).json({ error: 'Order From and Order To are required.' });
    }

    const { start: fromDate } = getPTDayBoundsUTC(fromValue);
    const { end: toDate } = getPTDayBoundsUTC(toValue);
    if (Number.isNaN(fromDate.getTime())) return res.status(400).json({ error: 'Invalid orderFrom date' });
    if (Number.isNaN(toDate.getTime())) return res.status(400).json({ error: 'Invalid orderTo date' });
    if (fromDate > toDate) return res.status(400).json({ error: 'Order From must be before Order To' });

    const orderMatch = {
      dateSold: { $gte: fromDate, $lte: toDate },
    };
    if (sellerObjectId) orderMatch.seller = sellerObjectId;
    if (marketplaceValue) {
      orderMatch.purchaseMarketplaceId = marketplaceValue === 'EBAY_ENCA' ? 'EBAY_CA' : marketplaceValue;
    }
    const orderAndConditions = [];
    if (excludeClient === 'true') {
      const excludedSellerIds = await getExcludedClientSellerIds();
      if (excludedSellerIds.length > 0) {
        orderAndConditions.push({ seller: { $nin: excludedSellerIds } });
      }
    }
    if (excludeLowValue === 'true') {
      orderAndConditions.push({
        $or: [
          { subtotalUSD: { $gte: 3 } },
          { subtotal: { $gte: 3 } },
        ],
      });
    }
    if (orderAndConditions.length > 0) {
      orderMatch.$and = orderAndConditions;
    }

    const skuSetExpression = {
      $setUnion: [
        {
          $cond: [
            { $and: [{ $ne: ['$sku', null] }, { $ne: ['$sku', ''] }] },
            [{ $toString: '$sku' }],
            [],
          ],
        },
        {
          $map: {
            input: { $ifNull: ['$lineItems', []] },
            as: 'item',
            in: {
              $toString: {
                $ifNull: [
                  '$$item.sku',
                  { $ifNull: ['$$item.SKU', { $ifNull: ['$$item.sellerSku', ''] }] },
                ],
              },
            },
          },
        },
      ],
    };

    const orderPipeline = [
      { $match: orderMatch },
      {
        $project: {
          orderId: 1,
          seller: 1,
          dateSold: 1,
          creationDate: 1,
          purchaseMarketplaceId: 1,
          productName: 1,
          subtotal: 1,
          subtotalUSD: 1,
          profit: 1,
          quantity: 1,
          skuCandidates: skuSetExpression,
        },
      },
      { $unwind: '$skuCandidates' },
      { $set: { sku: { $trim: { input: { $toString: { $ifNull: ['$skuCandidates', ''] } } } } } },
      { $match: { sku: { $regex: /\S/ } } },
      { $match: { sku: { $nin: ['null', 'undefined'] } } },
    ];

    if (trimmedSearch) {
      const searchRegex = new RegExp(trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      orderPipeline.push({
        $match: {
          $or: [
            { sku: searchRegex },
            { productName: searchRegex },
            { orderId: searchRegex },
          ],
        },
      });
    }

    const groupedOrderStages = [
      { $sort: { dateSold: -1, creationDate: -1, _id: -1 } },
      {
        $group: {
          _id: '$sku',
          orderCount: { $sum: 1 },
          totalSubtotal: { $sum: { $ifNull: ['$subtotal', 0] } },
          totalProfit: { $sum: { $ifNull: ['$profit', 0] } },
          lastOrderDate: { $max: '$dateSold' },
          orders: {
            $push: {
              orderId: '$orderId',
              sku: '$sku',
              seller: '$seller',
              dateSold: '$dateSold',
              creationDate: '$creationDate',
              purchaseMarketplaceId: '$purchaseMarketplaceId',
              productName: '$productName',
              subtotal: '$subtotal',
              subtotalUSD: '$subtotalUSD',
              profit: '$profit',
              quantity: '$quantity',
            },
          },
        },
      },
    ];

    const [aggregationResult = {}] = await Order.aggregate([
      { $match: orderMatch },
      {
        $facet: {
          rawSummary: [
            { $count: 'totalFilteredOrders' },
          ],
          rows: [
            ...orderPipeline.slice(1),
            ...groupedOrderStages,
            { $sort: { lastOrderDate: -1, _id: 1 } },
            { $skip: (pageNum - 1) * limitNum },
            { $limit: limitNum },
            {
              $project: {
                orderCount: 1,
                totalSubtotal: 1,
                totalProfit: 1,
                lastOrderDate: 1,
                orders: 1,
              },
            },
          ],
          summary: [
            ...orderPipeline.slice(1),
            ...groupedOrderStages,
            {
              $group: {
                _id: null,
                totalSkus: { $sum: 1 },
                totalOrders: { $sum: '$orderCount' },
              },
            },
          ],
        },
      },
    ])
      .option({ allowDiskUse: true, maxTimeMS: 60000 });

    const pageOrderRows = aggregationResult.rows || [];
    const summary = aggregationResult.summary?.[0] || {};
    const rawSummary = aggregationResult.rawSummary?.[0] || {};
    const total = summary.totalSkus || 0;
    const totalOrders = summary.totalOrders || 0;
    const totalFilteredOrders = rawSummary.totalFilteredOrders || 0;
    const pages = total > 0 ? Math.ceil(total / limitNum) : 0;
    const hasNextPage = pageNum < pages;
    const skus = pageOrderRows.map(row => row._id).filter(Boolean);

    const listings = skus.length > 0
      ? await TemplateListing.find({
          deletedAt: null,
          customLabel: { $in: skus },
        })
          .select('_id customLabel sellerId templateId title startPrice createdAt amazonLink +_asinReference')
          .sort({ customLabel: 1, sellerId: 1, _id: 1 })
          .lean()
      : [];

    const listingsBySku = new Map();
    const skuIndexPairs = [];
    listings.forEach((listing) => {
      const sku = String(listing.customLabel || '').trim();
      if (!sku) return;
      if (!listingsBySku.has(sku)) listingsBySku.set(sku, []);
      listingsBySku.get(sku).push(listing);
      if (listing.sellerId) {
        skuIndexPairs.push({
          seller: listing.sellerId,
          sku,
        });
      }
    });

    const skuIndexOr = skuIndexPairs
      .filter(pair => pair.seller && pair.sku)
      .map(pair => ({
        seller: pair.seller,
        sku: pair.sku,
      }));
    const skuIndexRecords = skuIndexOr.length > 0
      ? await SellerSkuIndex.find({ $or: skuIndexOr })
          .select('seller baseSku sku itemId syncedAt title')
          .lean()
      : [];
    const skuIndexBySellerAndSku = new Map();
    const skuIndexBySku = new Map();
    skuIndexRecords.forEach((record) => {
      const value = String(record.sku || '').trim();
      if (!value) return;
      const key = `${String(record.seller)}::${value}`;
      if (!skuIndexBySellerAndSku.has(key)) skuIndexBySellerAndSku.set(key, []);
      skuIndexBySellerAndSku.get(key).push(record);
    });
    const skuLookupValues = [...new Set(skus.map(sku => String(sku || '').trim()).filter(Boolean))];
    const allSkuIndexRecords = skuLookupValues.length > 0
      ? await SellerSkuIndex.find({
          sku: { $in: skuLookupValues },
        })
          .select('seller baseSku sku itemId syncedAt title')
          .lean()
      : [];
    allSkuIndexRecords.forEach((record) => {
      const value = String(record.sku || '').trim();
      if (!value) return;
      if (!skuIndexBySku.has(value)) skuIndexBySku.set(value, []);
      skuIndexBySku.get(value).push(record);
    });

    const sellerIdsFromListings = [
      ...new Set(listings.map(listing => String(listing.sellerId)).filter(Boolean)),
    ];
    const sellerIdsFromOrders = [
      ...new Set(pageOrderRows.flatMap(row => (row.orders || []).map(order => String(order.seller)).filter(Boolean))),
    ];
    const sellerIdsFromSkuIndex = [
      ...new Set(allSkuIndexRecords.map(record => String(record.seller)).filter(Boolean)),
    ];
    const allSellerIds = [...new Set([...sellerIdsFromListings, ...sellerIdsFromOrders, ...sellerIdsFromSkuIndex])];
    const sellerDocs = allSellerIds.length > 0
      ? await Seller.find({ _id: { $in: allSellerIds } }).populate('user', 'username email').lean()
      : [];
    const sellerNameById = new Map(sellerDocs.map(seller => [
      String(seller._id),
      seller.user?.username || seller.user?.email || String(seller._id),
    ]));

    const templateIds = [
      ...new Set(listings.map(listing => String(listing.templateId)).filter(Boolean)),
    ];
    const templateDocs = templateIds.length > 0
      ? await ListingTemplate.find({ _id: { $in: templateIds } }).select('name').lean()
      : [];
    const templateNameById = new Map(templateDocs.map(template => [String(template._id), template.name || 'Template']));

    const formattedRows = pageOrderRows.map((orderRow) => {
      const rowListings = listingsBySku.get(orderRow._id) || [];
      const sellerIds = new Set(rowListings.map(listing => String(listing.sellerId)).filter(Boolean));
      const skuIndexRows = skuIndexBySku.get(String(orderRow._id || '').trim()) || [];
      const skuIndexSellerIds = new Set(skuIndexRows.map(record => String(record.seller)).filter(Boolean));
      let minTemplatePrice = null;
      let maxTemplatePrice = null;
      let priceTotal = 0;
      let priceCount = 0;

      rowListings.forEach((listing) => {
        const price = Number(listing.startPrice);
        if (Number.isFinite(price)) {
          minTemplatePrice = minTemplatePrice == null ? price : Math.min(minTemplatePrice, price);
          maxTemplatePrice = maxTemplatePrice == null ? price : Math.max(maxTemplatePrice, price);
          priceTotal += price;
          priceCount += 1;
        }
      });

      return {
        sku: orderRow._id,
        listingCount: rowListings.length,
        sellerCount: sellerIds.size,
        skuIndexCount: skuIndexRows.length,
        skuIndexSellerCount: skuIndexSellerIds.size,
        minTemplatePrice: normalizeMoney(minTemplatePrice),
        maxTemplatePrice: normalizeMoney(maxTemplatePrice),
        avgTemplatePrice: normalizeMoney(priceCount > 0 ? priceTotal / priceCount : null),
        orderCount: orderRow.orderCount || 0,
        totalSubtotal: normalizeMoney(orderRow.totalSubtotal || 0),
        totalProfit: normalizeMoney(orderRow.totalProfit || 0),
        listings: rowListings.map(listing => ({
          id: listing._id,
          sellerId: listing.sellerId,
          sellerName: sellerNameById.get(String(listing.sellerId)) || String(listing.sellerId || ''),
          templateId: listing.templateId,
          templateName: templateNameById.get(String(listing.templateId)) || 'Template',
          title: listing.title || '',
          startPrice: normalizeMoney(listing.startPrice),
          createdAt: listing.createdAt,
          asin: listing._asinReference || '',
          amazonLink: listing.amazonLink || (listing._asinReference ? `https://www.amazon.com/dp/${listing._asinReference}` : ''),
          skuSyncIndex: (() => {
            const records = skuIndexBySellerAndSku.get(`${String(listing.sellerId)}::${String(listing.customLabel || '').trim()}`) || [];
            return {
              present: records.length > 0,
              count: records.length,
              itemIds: records.map(record => record.itemId).filter(Boolean),
              syncedAt: records[0]?.syncedAt || null,
            };
          })(),
        })).sort((a, b) => a.sellerName.localeCompare(b.sellerName)),
        orders: (orderRow.orders || []).map(order => ({
          orderId: order.orderId,
          sku: order.sku || orderRow._id,
          sellerName: sellerNameById.get(String(order.seller)) || String(order.seller || ''),
          marketplace: order.purchaseMarketplaceId || '',
          dateSold: order.dateSold || order.creationDate || null,
          productName: order.productName || '',
          subtotal: normalizeMoney(order.subtotal),
          subtotalUSD: normalizeMoney(order.subtotalUSD),
          profit: normalizeMoney(order.profit),
          quantity: order.quantity || 0,
        })),
        syncRecords: skuIndexRows
          .map(record => ({
            id: record._id,
            sellerId: record.seller,
            sellerName: sellerNameById.get(String(record.seller)) || String(record.seller || ''),
            itemId: record.itemId || '',
            sku: record.sku || '',
            baseSku: record.baseSku || '',
            syncedAt: record.syncedAt || null,
            title: record.title || '',
          }))
          .sort((a, b) => a.sellerName.localeCompare(b.sellerName) || String(a.itemId).localeCompare(String(b.itemId))),
      };
    });

    return res.json({
      rows: formattedRows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages,
        totalOrders,
        totalFilteredOrders,
        ordersWithoutUsableSku: Math.max(0, totalFilteredOrders - totalOrders),
        hasNextPage,
        scannedListings: null,
        source: 'orders',
      },
    });
  } catch (err) {
    console.error('[SKU Seller Order Profit] Error:', err);
    res.status(500).json({ error: 'Failed to fetch SKU seller order profit report' });
  }
});

router.get('/sku-seller-order-profit-listing-driven', requireAuth, requirePageAccess('SkuSellerOrderProfit'), async (req, res) => {
  try {
    const {
      search = '',
      sellerId = '',
      page = 1,
      limit = 25,
      ordersPerSku = 5,
      createdFrom = '',
      createdTo = '',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const ordersLimit = Math.min(25, Math.max(1, parseInt(ordersPerSku, 10) || 5));
    const sellerObjectId = sellerId && sellerId !== 'all' ? toObjectId(sellerId) : null;
    const trimmedSearch = String(search || '').trim();
    const createdAtRange = {};
    if (createdFrom) {
      const fromDate = new Date(`${createdFrom}T00:00:00.000Z`);
      if (Number.isNaN(fromDate.getTime())) return res.status(400).json({ error: 'Invalid createdFrom date' });
      createdAtRange.$gte = fromDate;
    }
    if (createdTo) {
      const toDate = new Date(`${createdTo}T23:59:59.999Z`);
      if (Number.isNaN(toDate.getTime())) return res.status(400).json({ error: 'Invalid createdTo date' });
      createdAtRange.$lte = toDate;
    }
    if (createdAtRange.$gte && createdAtRange.$lte && createdAtRange.$gte > createdAtRange.$lte) {
      return res.status(400).json({ error: 'Created From must be before Created To' });
    }

    if (sellerId && sellerId !== 'all' && !sellerObjectId) {
      return res.status(400).json({ error: 'Invalid sellerId' });
    }

    const listingQuery = {
      deletedAt: null,
      customLabel: { $nin: [null, ''] },
    };
    if (Object.keys(createdAtRange).length > 0) {
      listingQuery.createdAt = createdAtRange;
    }
    if (trimmedSearch) {
      listingQuery.$or = [
        { customLabel: { $regex: trimmedSearch, $options: 'i' } },
        { title: { $regex: trimmedSearch, $options: 'i' } },
      ];
    }

    const targetCount = pageNum * limitNum + 1;
    const groupedRows = [];
    let currentSku = null;
    let currentGroup = null;
    let scannedListings = 0;

    const pushGroupIfMatch = (group) => {
      if (!group) return;
      const sellerIds = [...group.sellerIds];
      if (sellerIds.length <= 1) return;
      if (sellerObjectId && !group.sellerIds.has(String(sellerObjectId))) return;
      groupedRows.push({
        sku: group.sku,
        listingCount: group.listingCount,
        sellerIds,
        minTemplatePrice: group.minTemplatePrice,
        maxTemplatePrice: group.maxTemplatePrice,
        avgTemplatePrice: group.priceCount > 0 ? group.priceTotal / group.priceCount : null,
        listings: group.listings,
      });
    };

    if (sellerObjectId) {
      const neededRows = pageNum * limitNum + 1;
      const pageRows = [];
      const candidateBatch = [];
      const seenCandidateSkus = new Set();
      let skippedMatches = 0;
      let scannedListings = 0;
      let lastSellerSku = null;
      let hasNextPage = false;

      const buildGroupFromListings = (sku, listings) => {
        const sellerIds = new Set();
        let minTemplatePrice = null;
        let maxTemplatePrice = null;
        let priceTotal = 0;
        let priceCount = 0;

        listings.forEach((listing) => {
          if (listing.sellerId) sellerIds.add(String(listing.sellerId));
          const price = Number(listing.startPrice);
          if (Number.isFinite(price)) {
            minTemplatePrice = minTemplatePrice == null ? price : Math.min(minTemplatePrice, price);
            maxTemplatePrice = maxTemplatePrice == null ? price : Math.max(maxTemplatePrice, price);
            priceTotal += price;
            priceCount += 1;
          }
        });

        return {
          sku,
          listingCount: listings.length,
          sellerIds: [...sellerIds],
          minTemplatePrice,
          maxTemplatePrice,
          avgTemplatePrice: priceCount > 0 ? priceTotal / priceCount : null,
          listings: listings.map(listing => ({
            id: listing._id,
            sellerId: listing.sellerId,
            templateId: listing.templateId,
            title: listing.title,
            startPrice: listing.startPrice,
            status: listing.status,
            createdAt: listing.createdAt,
          })),
        };
      };

      const flushCandidates = async () => {
        if (candidateBatch.length === 0 || pageRows.length >= neededRows) return;
        const skusToCheck = candidateBatch.splice(0, candidateBatch.length);
        const listings = await TemplateListing.find({
          deletedAt: null,
          customLabel: { $in: skusToCheck },
          ...(Object.keys(createdAtRange).length > 0 ? { createdAt: createdAtRange } : {}),
        })
          .select('_id customLabel sellerId templateId title startPrice status createdAt')
          .sort({ customLabel: 1, sellerId: 1, _id: 1 })
          .lean();

        const bySku = new Map();
        listings.forEach((listing) => {
          const sku = String(listing.customLabel || '').trim();
          if (!sku) return;
          if (!bySku.has(sku)) bySku.set(sku, []);
          bySku.get(sku).push(listing);
        });

        for (const sku of skusToCheck) {
          const groupListings = bySku.get(sku) || [];
          const sellerIds = new Set(groupListings.map(listing => String(listing.sellerId)).filter(Boolean));
          if (sellerIds.size <= 1 || !sellerIds.has(String(sellerObjectId))) continue;

          if (skippedMatches < (pageNum - 1) * limitNum) {
            skippedMatches += 1;
            continue;
          }

          pageRows.push(buildGroupFromListings(sku, groupListings));
          if (pageRows.length >= neededRows) {
            hasNextPage = true;
            break;
          }
        }
      };

      const sellerCursor = TemplateListing.find({
        ...listingQuery,
        sellerId: sellerObjectId,
      })
        .select('customLabel')
        .sort({ customLabel: 1, _id: 1 })
        .lean()
        .cursor({ batchSize: 1000 });

      try {
        for await (const listing of sellerCursor) {
          scannedListings += 1;
          const sku = String(listing.customLabel || '').trim();
          if (!sku || sku === lastSellerSku || seenCandidateSkus.has(sku)) continue;
          lastSellerSku = sku;
          seenCandidateSkus.add(sku);
          candidateBatch.push(sku);

          if (candidateBatch.length >= 100) {
            await flushCandidates();
            if (pageRows.length >= neededRows) break;
          }
        }
        await flushCandidates();
      } finally {
        await sellerCursor.close();
      }

      const responseRows = pageRows.slice(0, limitNum);
      const skus = responseRows.map(row => row.sku);
      const orderRows = skus.length > 0
        ? await Order.aggregate([
            {
              $match: {
                $or: [
                  { sku: { $in: skus } },
                  { 'lineItems.sku': { $in: skus } },
                  { 'lineItems.SKU': { $in: skus } },
                  { 'lineItems.sellerSku': { $in: skus } },
                ],
              },
            },
            {
              $addFields: {
                matchedSku: {
                  $let: {
                    vars: {
                      matchedLineItem: {
                        $arrayElemAt: [
                          {
                            $filter: {
                              input: { $ifNull: ['$lineItems', []] },
                              as: 'item',
                              cond: {
                                $in: [
                                  { $ifNull: ['$$item.sku', { $ifNull: ['$$item.SKU', '$$item.sellerSku'] }] },
                                  skus,
                                ],
                              },
                            },
                          },
                          0,
                        ],
                      },
                    },
                    in: {
                      $ifNull: [
                        '$sku',
                        { $ifNull: ['$$matchedLineItem.sku', { $ifNull: ['$$matchedLineItem.SKU', '$$matchedLineItem.sellerSku'] }] },
                      ],
                    },
                  },
                },
              },
            },
            { $match: { matchedSku: { $in: skus } } },
            { $sort: { dateSold: -1, creationDate: -1, createdAt: -1 } },
            {
              $group: {
                _id: '$matchedSku',
                orderCount: { $sum: 1 },
                totalSubtotal: { $sum: { $ifNull: ['$subtotal', 0] } },
                totalProfit: { $sum: { $ifNull: ['$profit', 0] } },
                orders: {
                  $push: {
                    orderId: '$orderId',
                    seller: '$seller',
                    dateSold: '$dateSold',
                    creationDate: '$creationDate',
                    productName: '$productName',
                    subtotal: '$subtotal',
                    subtotalUSD: '$subtotalUSD',
                    profit: '$profit',
                    quantity: '$quantity',
                  },
                },
              },
            },
            { $project: { orderCount: 1, totalSubtotal: 1, totalProfit: 1, orders: { $slice: ['$orders', ordersLimit] } } },
          ]).allowDiskUse(true)
        : [];

      const sellerIdsFromListings = [
        ...new Set(responseRows.flatMap(row => row.sellerIds).filter(Boolean)),
      ];
      const sellerIdsFromOrders = [
        ...new Set(orderRows.flatMap(row => (row.orders || []).map(order => String(order.seller)).filter(Boolean))),
      ];
      const allSellerIds = [...new Set([...sellerIdsFromListings, ...sellerIdsFromOrders])];
      const sellerDocs = allSellerIds.length > 0
        ? await Seller.find({ _id: { $in: allSellerIds } }).populate('user', 'username email').lean()
        : [];
      const sellerNameById = new Map(sellerDocs.map(seller => [
        String(seller._id),
        seller.user?.username || seller.user?.email || String(seller._id),
      ]));

      const templateIds = [
        ...new Set(responseRows.flatMap(row => row.listings.map(listing => String(listing.templateId)).filter(Boolean))),
      ];
      const templateDocs = templateIds.length > 0
        ? await ListingTemplate.find({ _id: { $in: templateIds } }).select('name').lean()
        : [];
      const templateNameById = new Map(templateDocs.map(template => [String(template._id), template.name || 'Template']));
      const ordersBySku = new Map(orderRows.map(row => [row._id, row]));

      const formattedRows = responseRows.map((row) => {
        const orderSummary = ordersBySku.get(row.sku) || {};
        return {
          sku: row.sku,
          listingCount: row.listingCount,
          sellerCount: row.sellerIds.length,
          minTemplatePrice: normalizeMoney(row.minTemplatePrice),
          maxTemplatePrice: normalizeMoney(row.maxTemplatePrice),
          avgTemplatePrice: normalizeMoney(row.avgTemplatePrice),
          orderCount: orderSummary.orderCount || 0,
          totalSubtotal: normalizeMoney(orderSummary.totalSubtotal || 0),
          totalProfit: normalizeMoney(orderSummary.totalProfit || 0),
          listings: (row.listings || []).map(listing => ({
            id: listing.id,
            sellerId: listing.sellerId,
            sellerName: sellerNameById.get(String(listing.sellerId)) || String(listing.sellerId),
            templateId: listing.templateId,
            templateName: templateNameById.get(String(listing.templateId)) || 'Template',
            title: listing.title || '',
            startPrice: normalizeMoney(listing.startPrice),
            status: listing.status || '',
            createdAt: listing.createdAt,
          })).sort((a, b) => a.sellerName.localeCompare(b.sellerName)),
          orders: (orderSummary.orders || []).map(order => ({
            orderId: order.orderId,
            sellerName: sellerNameById.get(String(order.seller)) || String(order.seller || ''),
            dateSold: order.dateSold || order.creationDate || null,
            productName: order.productName || '',
            subtotal: normalizeMoney(order.subtotal),
            subtotalUSD: normalizeMoney(order.subtotalUSD),
            profit: normalizeMoney(order.profit),
            quantity: order.quantity || 0,
          })),
        };
      });

      return res.json({
        rows: formattedRows,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: null,
          pages: null,
          hasNextPage,
          scannedListings,
        },
      });
    }

    if (Object.keys(createdAtRange).length > 0) {
      const aggregateRows = await TemplateListing.aggregate([
        { $match: listingQuery },
        {
          $group: {
            _id: '$customLabel',
            listingCount: { $sum: 1 },
            sellerIds: { $addToSet: '$sellerId' },
            minTemplatePrice: { $min: '$startPrice' },
            maxTemplatePrice: { $max: '$startPrice' },
            avgTemplatePrice: { $avg: '$startPrice' },
            listings: {
              $push: {
                id: '$_id',
                sellerId: '$sellerId',
                templateId: '$templateId',
                title: '$title',
                startPrice: '$startPrice',
                status: '$status',
                createdAt: '$createdAt',
              },
            },
          },
        },
        { $match: { $expr: { $gt: [{ $size: '$sellerIds' }, 1] } } },
        { $sort: { _id: 1 } },
        { $limit: targetCount },
      ])
        .option({
          allowDiskUse: true,
          maxTimeMS: 60000,
          hint: { deletedAt: 1, createdAt: -1, customLabel: 1, sellerId: 1 },
        });

      aggregateRows.forEach((row) => {
        groupedRows.push({
          sku: row._id,
          listingCount: row.listingCount,
          sellerIds: (row.sellerIds || []).map(id => String(id)),
          minTemplatePrice: row.minTemplatePrice,
          maxTemplatePrice: row.maxTemplatePrice,
          avgTemplatePrice: row.avgTemplatePrice,
          listings: row.listings || [],
        });
      });
      scannedListings = null;
    } else {
      const cursor = TemplateListing.find(listingQuery)
        .select('_id customLabel sellerId templateId title startPrice status createdAt')
        .sort({ customLabel: 1, sellerId: 1, _id: 1 })
        .lean()
        .cursor({ batchSize: 1000 });

      try {
        for await (const listing of cursor) {
          scannedListings += 1;
          const sku = String(listing.customLabel || '').trim();
          if (!sku) continue;

          if (currentSku !== sku) {
            pushGroupIfMatch(currentGroup);
            if (groupedRows.length >= targetCount) break;
            currentSku = sku;
            currentGroup = {
              sku,
              listingCount: 0,
              sellerIds: new Set(),
              minTemplatePrice: null,
              maxTemplatePrice: null,
              priceTotal: 0,
              priceCount: 0,
              listings: [],
            };
          }

          currentGroup.listingCount += 1;
          if (listing.sellerId) currentGroup.sellerIds.add(String(listing.sellerId));

          const price = Number(listing.startPrice);
          if (Number.isFinite(price)) {
            currentGroup.minTemplatePrice = currentGroup.minTemplatePrice == null ? price : Math.min(currentGroup.minTemplatePrice, price);
            currentGroup.maxTemplatePrice = currentGroup.maxTemplatePrice == null ? price : Math.max(currentGroup.maxTemplatePrice, price);
            currentGroup.priceTotal += price;
            currentGroup.priceCount += 1;
          }

          currentGroup.listings.push({
            id: listing._id,
            sellerId: listing.sellerId,
            templateId: listing.templateId,
            title: listing.title,
            startPrice: listing.startPrice,
            status: listing.status,
            createdAt: listing.createdAt,
          });
        }

        if (groupedRows.length < targetCount) {
          pushGroupIfMatch(currentGroup);
        }
      } finally {
        await cursor.close();
      }
    }

    const start = (pageNum - 1) * limitNum;
    const pageRows = groupedRows.slice(start, start + limitNum);
    const hasNextPage = groupedRows.length > start + limitNum;
    const skus = pageRows.map(row => row.sku);

    const orderRows = skus.length > 0
      ? await Order.aggregate([
          {
            $match: {
              $or: [
                { sku: { $in: skus } },
                { 'lineItems.sku': { $in: skus } },
                { 'lineItems.SKU': { $in: skus } },
                { 'lineItems.sellerSku': { $in: skus } },
              ],
            },
          },
          {
            $addFields: {
              matchedSku: {
                $let: {
                  vars: {
                    matchedLineItem: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: { $ifNull: ['$lineItems', []] },
                            as: 'item',
                            cond: {
                              $in: [
                                { $ifNull: ['$$item.sku', { $ifNull: ['$$item.SKU', '$$item.sellerSku'] }] },
                                skus,
                              ],
                            },
                          },
                        },
                        0,
                      ],
                    },
                  },
                  in: {
                    $ifNull: [
                      '$sku',
                      { $ifNull: ['$$matchedLineItem.sku', { $ifNull: ['$$matchedLineItem.SKU', '$$matchedLineItem.sellerSku'] }] },
                    ],
                  },
                },
              },
            },
          },
          { $match: { matchedSku: { $in: skus } } },
          { $sort: { dateSold: -1, creationDate: -1, createdAt: -1 } },
          {
            $group: {
              _id: '$matchedSku',
              orderCount: { $sum: 1 },
              totalSubtotal: { $sum: { $ifNull: ['$subtotal', 0] } },
              totalProfit: { $sum: { $ifNull: ['$profit', 0] } },
              orders: {
                $push: {
                  orderId: '$orderId',
                  seller: '$seller',
                  dateSold: '$dateSold',
                  creationDate: '$creationDate',
                  productName: '$productName',
                  subtotal: '$subtotal',
                  subtotalUSD: '$subtotalUSD',
                  profit: '$profit',
                  quantity: '$quantity',
                },
              },
            },
          },
          { $project: { orderCount: 1, totalSubtotal: 1, totalProfit: 1, orders: { $slice: ['$orders', ordersLimit] } } },
        ]).allowDiskUse(true)
      : [];

    const sellerIdsFromListings = [
      ...new Set(pageRows.flatMap(row => row.sellerIds).filter(Boolean)),
    ];
    const sellerIdsFromOrders = [
      ...new Set(orderRows.flatMap(row => (row.orders || []).map(order => String(order.seller)).filter(Boolean))),
    ];
    const allSellerIds = [...new Set([...sellerIdsFromListings, ...sellerIdsFromOrders])];
    const sellerDocs = allSellerIds.length > 0
      ? await Seller.find({ _id: { $in: allSellerIds } }).populate('user', 'username email').lean()
      : [];
    const sellerNameById = new Map(sellerDocs.map(seller => [
      String(seller._id),
      seller.user?.username || seller.user?.email || String(seller._id),
    ]));

    const templateIds = [
      ...new Set(pageRows.flatMap(row => row.listings.map(listing => String(listing.templateId)).filter(Boolean))),
    ];
    const templateDocs = templateIds.length > 0
      ? await ListingTemplate.find({ _id: { $in: templateIds } }).select('name').lean()
      : [];
    const templateNameById = new Map(templateDocs.map(template => [String(template._id), template.name || 'Template']));
    const ordersBySku = new Map(orderRows.map(row => [row._id, row]));

    const formattedRows = pageRows.map((row) => {
      const orderSummary = ordersBySku.get(row.sku) || {};

      return {
        sku: row.sku,
        listingCount: row.listingCount,
        sellerCount: row.sellerIds.length,
        minTemplatePrice: normalizeMoney(row.minTemplatePrice),
        maxTemplatePrice: normalizeMoney(row.maxTemplatePrice),
        avgTemplatePrice: normalizeMoney(row.avgTemplatePrice),
        orderCount: orderSummary.orderCount || 0,
        totalSubtotal: normalizeMoney(orderSummary.totalSubtotal || 0),
        totalProfit: normalizeMoney(orderSummary.totalProfit || 0),
        listings: (row.listings || []).map(listing => ({
          id: listing.id,
          sellerId: listing.sellerId,
          sellerName: sellerNameById.get(String(listing.sellerId)) || String(listing.sellerId),
          templateId: listing.templateId,
          templateName: templateNameById.get(String(listing.templateId)) || 'Template',
          title: listing.title || '',
          startPrice: normalizeMoney(listing.startPrice),
          status: listing.status || '',
          createdAt: listing.createdAt,
        })).sort((a, b) => a.sellerName.localeCompare(b.sellerName)),
        orders: (orderSummary.orders || []).map(order => ({
          orderId: order.orderId,
          sellerName: sellerNameById.get(String(order.seller)) || String(order.seller || ''),
          dateSold: order.dateSold || order.creationDate || null,
          productName: order.productName || '',
          subtotal: normalizeMoney(order.subtotal),
          subtotalUSD: normalizeMoney(order.subtotalUSD),
          profit: normalizeMoney(order.profit),
          quantity: order.quantity || 0,
        })),
      };
    });

    res.json({
      rows: formattedRows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: null,
        pages: null,
        hasNextPage,
        scannedListings,
      },
    });
  } catch (err) {
    console.error('[SKU Seller Order Profit] Error:', err);
    res.status(500).json({ error: 'Failed to fetch SKU seller order profit report' });
  }
});

router.get('/sku-seller-order-profit-full-scan', requireAuth, requirePageAccess('SkuSellerOrderProfit'), async (req, res) => {
  try {
    const {
      search = '',
      sellerId = '',
      page = 1,
      limit = 25,
      ordersPerSku = 5,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const ordersLimit = Math.min(25, Math.max(1, parseInt(ordersPerSku, 10) || 5));
    const sellerObjectId = sellerId && sellerId !== 'all' ? toObjectId(sellerId) : null;
    const trimmedSearch = String(search || '').trim();

    if (sellerId && sellerId !== 'all' && !sellerObjectId) {
      return res.status(400).json({ error: 'Invalid sellerId' });
    }

    const matchStage = {
      deletedAt: null,
      customLabel: { $nin: [null, ''] },
    };
    if (trimmedSearch) {
      matchStage.$or = [
        { customLabel: { $regex: trimmedSearch, $options: 'i' } },
        { title: { $regex: trimmedSearch, $options: 'i' } },
      ];
    }

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: '$customLabel',
          listingCount: { $sum: 1 },
          sellerIds: { $addToSet: '$sellerId' },
          minTemplatePrice: { $min: '$startPrice' },
          maxTemplatePrice: { $max: '$startPrice' },
          avgTemplatePrice: { $avg: '$startPrice' },
          listings: {
            $push: {
              id: '$_id',
              sellerId: '$sellerId',
              templateId: '$templateId',
              title: '$title',
              startPrice: '$startPrice',
              status: '$status',
              createdAt: '$createdAt',
            },
          },
        },
      },
      {
        $match: {
          $expr: { $gt: [{ $size: '$sellerIds' }, 1] },
          ...(sellerObjectId ? { sellerIds: sellerObjectId } : {}),
        },
      },
      { $sort: { listingCount: -1, _id: 1 } },
      {
        $facet: {
          rows: [
            { $skip: (pageNum - 1) * limitNum },
            { $limit: limitNum },
            {
              $lookup: {
                from: 'sellers',
                localField: 'sellerIds',
                foreignField: '_id',
                as: 'sellerDocs',
              },
            },
            {
              $lookup: {
                from: 'users',
                localField: 'sellerDocs.user',
                foreignField: '_id',
                as: 'sellerUsers',
              },
            },
            {
              $lookup: {
                from: 'listingtemplates',
                localField: 'listings.templateId',
                foreignField: '_id',
                as: 'templateDocs',
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await TemplateListing.aggregate(pipeline).allowDiskUse(true);
    const rows = result?.rows || [];
    const total = result?.total?.[0]?.count || 0;
    const skus = rows.map(row => row._id);

    const orderRows = skus.length > 0
      ? await Order.aggregate([
          {
            $match: {
              $or: [
                { sku: { $in: skus } },
                { 'lineItems.sku': { $in: skus } },
                { 'lineItems.SKU': { $in: skus } },
                { 'lineItems.sellerSku': { $in: skus } },
              ],
            },
          },
          {
            $addFields: {
              matchedSku: {
                $let: {
                  vars: {
                    matchedLineItem: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: { $ifNull: ['$lineItems', []] },
                            as: 'item',
                            cond: {
                              $in: [
                                { $ifNull: ['$$item.sku', { $ifNull: ['$$item.SKU', '$$item.sellerSku'] }] },
                                skus,
                              ],
                            },
                          },
                        },
                        0,
                      ],
                    },
                  },
                  in: {
                    $ifNull: [
                      '$sku',
                      { $ifNull: ['$$matchedLineItem.sku', { $ifNull: ['$$matchedLineItem.SKU', '$$matchedLineItem.sellerSku'] }] },
                    ],
                  },
                },
              },
            },
          },
          { $match: { matchedSku: { $in: skus } } },
          { $sort: { dateSold: -1, creationDate: -1, createdAt: -1 } },
          {
            $group: {
              _id: '$matchedSku',
              orderCount: { $sum: 1 },
              totalSubtotal: { $sum: { $ifNull: ['$subtotal', 0] } },
              totalProfit: { $sum: { $ifNull: ['$profit', 0] } },
              orders: {
                $push: {
                  orderId: '$orderId',
                  seller: '$seller',
                  dateSold: '$dateSold',
                  creationDate: '$creationDate',
                  productName: '$productName',
                  subtotal: '$subtotal',
                  subtotalUSD: '$subtotalUSD',
                  profit: '$profit',
                  quantity: '$quantity',
                },
              },
            },
          },
          { $project: { orderCount: 1, totalSubtotal: 1, totalProfit: 1, orders: { $slice: ['$orders', ordersLimit] } } },
        ]).allowDiskUse(true)
      : [];

    const sellerIdsFromOrders = [
      ...new Set(orderRows.flatMap(row => (row.orders || []).map(order => String(order.seller)).filter(Boolean))),
    ];
    const orderSellers = sellerIdsFromOrders.length > 0
      ? await Seller.find({ _id: { $in: sellerIdsFromOrders } }).populate('user', 'username email').lean()
      : [];
    const orderSellerNameById = new Map(orderSellers.map(seller => [
      String(seller._id),
      seller.user?.username || seller.user?.email || String(seller._id),
    ]));
    const ordersBySku = new Map(orderRows.map(row => [row._id, row]));

    const formattedRows = rows.map((row) => {
      const sellerUserById = new Map((row.sellerUsers || []).map(user => [String(user._id), user]));
      const sellerNameById = new Map((row.sellerDocs || []).map((seller) => {
        const user = sellerUserById.get(String(seller.user));
        return [String(seller._id), user?.username || user?.email || String(seller._id)];
      }));
      const templateNameById = new Map((row.templateDocs || []).map(template => [String(template._id), template.name || 'Template']));
      const orderSummary = ordersBySku.get(row._id) || {};

      return {
        sku: row._id,
        listingCount: row.listingCount,
        sellerCount: row.sellerIds.length,
        minTemplatePrice: normalizeMoney(row.minTemplatePrice),
        maxTemplatePrice: normalizeMoney(row.maxTemplatePrice),
        avgTemplatePrice: normalizeMoney(row.avgTemplatePrice),
        orderCount: orderSummary.orderCount || 0,
        totalSubtotal: normalizeMoney(orderSummary.totalSubtotal || 0),
        totalProfit: normalizeMoney(orderSummary.totalProfit || 0),
        listings: (row.listings || []).map(listing => ({
          id: listing.id,
          sellerId: listing.sellerId,
          sellerName: sellerNameById.get(String(listing.sellerId)) || String(listing.sellerId),
          templateId: listing.templateId,
          templateName: templateNameById.get(String(listing.templateId)) || 'Template',
          title: listing.title || '',
          startPrice: normalizeMoney(listing.startPrice),
          status: listing.status || '',
          createdAt: listing.createdAt,
        })).sort((a, b) => a.sellerName.localeCompare(b.sellerName)),
        orders: (orderSummary.orders || []).map(order => ({
          orderId: order.orderId,
          sellerName: orderSellerNameById.get(String(order.seller)) || String(order.seller || ''),
          dateSold: order.dateSold || order.creationDate || null,
          productName: order.productName || '',
          subtotal: normalizeMoney(order.subtotal),
          subtotalUSD: normalizeMoney(order.subtotalUSD),
          profit: normalizeMoney(order.profit),
          quantity: order.quantity || 0,
        })),
      };
    });

    res.json({
      rows: formattedRows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('[SKU Seller Order Profit] Error:', err);
    res.status(500).json({ error: 'Failed to fetch SKU seller order profit report' });
  }
});

/**
 * @swagger
 * /template-listings/counts:
 *   get:
 *     tags: [Template Listings]
 *     summary: Batch listing counts
 *     description: "Returns { templateId: count } for one or more template IDs in a single round-trip. Useful for populating per-tab badges in the UI."
 *     parameters:
 *       - in: query
 *         name: templateIds
 *         required: true
 *         schema: { type: string }
 *         description: Comma-separated template IDs
 *         example: "665abc123def456789012345,665abc123def456789012346"
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *         description: Restrict count to a specific seller
 *       - in: query
 *         name: status
 *         schema: { type: string, default: active }
 *         description: Listing status filter. Pass `all` to count all statuses.
 *     responses:
 *       200:
 *         description: Map of templateId → listing count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: { type: integer }
 *               example: { "665abc123def456789012345": 42 }
 *       400: { description: templateIds query param missing }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Batch listing counts — returns { [templateId]: count } for multiple templates in one query
router.get('/counts', requireAuth, async (req, res) => {
  try {
    const { templateIds, sellerId, status = 'active' } = req.query;
    if (!templateIds) return res.status(400).json({ error: 'templateIds is required' });

    const ids = templateIds.split(',').map(id => id.trim()).filter(Boolean);
    if (ids.length === 0) return res.json({});

    const matchStage = { templateId: { $in: ids } };
    if (sellerId) matchStage.sellerId = sellerId;
    if (status && status !== 'all') matchStage.status = status;

    const rows = await TemplateListing.aggregate([
      { $match: matchStage },
      { $group: { _id: '$templateId', count: { $sum: 1 } } },
    ]);

    const result = {};
    // Initialize all requested ids to 0 so missing ones don't cause UI gaps
    for (const id of ids) result[id] = 0;
    for (const row of rows) result[row._id] = row.count;

    return res.json(result);
  } catch (err) {
    console.error('Error fetching template listing counts:', err);
    return res.status(500).json({ error: 'Failed to fetch listing counts' });
  }
});

/**
 * @swagger
 * /template-listings/:
 *   get:
 *     tags: [Template Listings]
 *     summary: List template listings (paginated)
 *     description: Returns paginated listings for a given template with optional seller, status, price range, batch, and full-text search filters.
 *     parameters:
 *       - in: query
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *         description: Template ID
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *         description: Filter by seller
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: batchFilter
 *         schema: { type: string, default: active }
 *         description: "`active` = not-yet-downloaded, `downloaded` = already downloaded, `batch` = specific batch"
 *       - in: query
 *         name: batchId
 *         schema: { type: string }
 *         description: Filter by downloadBatchId (used when batchFilter=batch)
 *       - in: query
 *         name: status
 *         schema: { type: string, default: active }
 *       - in: query
 *         name: minPrice
 *         schema: { type: number }
 *       - in: query
 *         name: maxPrice
 *         schema: { type: number }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search across title, SKU, and ASIN
 *     responses:
 *       200:
 *         description: Paginated listings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 listings:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/TemplateListing' }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 *                     pages: { type: integer }
 *       400: { description: templateId is required }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Get all listings for a template
router.get('/', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, page = 1, limit = 50, batchFilter = 'active', batchId, status = 'active', minPrice, maxPrice, search } = req.query;

    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build filter with optional seller filtering
    const filter = { templateId };
    if (sellerId) {
      filter.sellerId = sellerId;
    }

    // Filter by status (default to 'active' to only show active listings)
    if (status && status !== 'all') {
      filter.status = status;
    }

    // Price range filter
    if (minPrice || maxPrice) {
      filter.startPrice = {};
      if (minPrice) filter.startPrice.$gte = parseFloat(minPrice);
      if (maxPrice) filter.startPrice.$lte = parseFloat(maxPrice);
    }

    // Keyword / ASIN search
    if (search && search.trim()) {
      const rx = { $regex: search.trim(), $options: 'i' };
      filter.$or = [{ title: rx }, { customLabel: rx }];
    }

    // Apply batch filtering
    if (batchId) {
      // Specific batch
      filter.downloadBatchId = batchId;
    } else if (batchFilter === 'active') {
      // Active batch: not yet downloaded OR flagged for re-download after duplicate update
      filter.$or = [{ downloadBatchId: null }, { pendingRedownload: true }];
    } else if (batchFilter === 'all') {
      // All batches (no filter on downloadBatchId)
    }

    const [listings, total] = await Promise.all([
      TemplateListing.find(filter)
        .select('+_asinReference +_amazonSourcePrice')
        .populate('createdBy', 'name email')
        .populate({
          path: 'sellerId',
          populate: {
            path: 'user',
            select: 'username email'
          }
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TemplateListing.countDocuments(filter)
    ]);

    res.json({
      listings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching listings:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/database-view:
 *   get:
 *     tags: [Template Listings]
 *     summary: Database view — cross-template listing browser
 *     description: Paginated listing browser without a required templateId. Supports cross-seller and cross-template queries with full-text search across title, SKU, and ASIN.
 *     parameters:
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *       - in: query
 *         name: templateId
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: draft | active | inactive | sold | ended
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Full-text search across title, customLabel, and ASIN
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Paginated listings with populated seller and template references
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 listings:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/TemplateListing' }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 *                     pages: { type: integer }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Database view endpoint with comprehensive filters (MUST be before /:id route)
router.get('/database-view', requireAuth, async (req, res) => {
  try {
    const {
      sellerId,
      templateId,
      status,
      search,
      page = 1,
      limit = 50
    } = req.query;

    // Build query - exclude soft-deleted items
    const query = { deletedAt: null };

    if (sellerId) query.sellerId = sellerId;
    if (templateId) query.templateId = templateId;
    if (status) query.status = status;

    // Search across ASIN, SKU (customLabel), and Title
    if (search && search.trim()) {
      const trimmed = search.trim();
      // ASINs are always exactly 10 chars starting with B0 — use fast exact match
      const isAsin = /^[Bb]0[A-Za-z0-9]{8}$/.test(trimmed);
      if (isAsin) {
        query._asinReference = trimmed.toUpperCase();
      } else {
        // Use MongoDB text index for title/customLabel (fast), and prefix regex for ASIN
        query.$and = [
          {
            $or: [
              { $text: { $search: trimmed } },
              { _asinReference: { $regex: `^${trimmed}`, $options: 'i' } },
            ]
          }
        ];
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Fetch with populated fields
    const [listings, total] = await Promise.all([
      TemplateListing.find(query)
        .select('+_asinReference') // Include ASIN in results
        .populate({
          path: 'sellerId',
          populate: {
            path: 'user',
            select: 'username email'
          }
        })
        .populate('templateId', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TemplateListing.countDocuments(query)
    ]);

    res.json({
      listings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Database view error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/database-stats:
 *   get:
 *     tags: [Template Listings]
 *     summary: Aggregate database statistics
 *     description: Returns high-level counts across all non-deleted listings (total, unique sellers, unique templates, and per-status counts).
 *     responses:
 *       200:
 *         description: Aggregate stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:     { type: integer, example: 1240 }
 *                 sellers:   { type: integer, example: 5 }
 *                 templates: { type: integer, example: 12 }
 *                 draft:     { type: integer, example: 30 }
 *                 active:    { type: integer, example: 900 }
 *                 inactive:  { type: integer, example: 310 }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Database statistics endpoint (MUST be before /:id route)
router.get('/database-stats', requireAuth, async (req, res) => {
  try {
    // Indexed counts + distincts instead of a single $group over every
    // non-deleted document (~700k full-doc reads, 30s+, and it evicted the
    // working set from cache each run). The status counts are pure COUNT_SCANs
    // on { deletedAt, status }. distinct() with a filter refuses the fast
    // index path (as does $match+$group with a null predicate), so we take
    // the unfiltered distinct (fast DISTINCT_SCAN) and verify each id still
    // has at least one non-deleted listing via indexed point lookups.
    const [total, draft, active, inactive, sellerIds, templateIds] = await Promise.all([
      TemplateListing.countDocuments({ deletedAt: null }),
      TemplateListing.countDocuments({ deletedAt: null, status: 'draft' }),
      TemplateListing.countDocuments({ deletedAt: null, status: 'active' }),
      TemplateListing.countDocuments({ deletedAt: null, status: 'inactive' }),
      TemplateListing.distinct('sellerId'),
      TemplateListing.distinct('templateId')
    ]);

    const [sellerFlags, templateFlags] = await Promise.all([
      Promise.all(sellerIds.map((id) => TemplateListing.exists({ sellerId: id, deletedAt: null }))),
      Promise.all(templateIds.map((id) => TemplateListing.exists({ templateId: id, deletedAt: null })))
    ]);

    res.json({
      total,
      sellers: sellerFlags.filter(Boolean).length,
      templates: templateFlags.filter(Boolean).length,
      draft,
      active,
      inactive
    });
  } catch (error) {
    console.error('Database stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/stats:
 *   get:
 *     tags: [Template Listings]
 *     summary: Listing creation stats (today / week / month / total)
 *     parameters:
 *       - in: query
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Listing creation counts grouped by time window
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 today:     { type: integer, example: 12 }
 *                 thisWeek:  { type: integer, example: 58 }
 *                 thisMonth: { type: integer, example: 201 }
 *                 total:     { type: integer, example: 840 }
 *       400: { description: templateId is required }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Get statistics for template listings (today, week, month, total)
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId } = req.query;

    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    const filter = { templateId };
    if (sellerId) {
      filter.sellerId = sellerId;
    }

    // Calculate date ranges
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

    // Run queries in parallel
    const [todayCount, weekCount, monthCount, totalCount] = await Promise.all([
      TemplateListing.countDocuments({
        ...filter,
        status: 'active',
        createdAt: { $gte: todayStart, $lte: todayEnd }
      }),
      TemplateListing.countDocuments({
        ...filter,
        status: 'active',
        createdAt: { $gte: weekStart }
      }),
      TemplateListing.countDocuments({
        ...filter,
        status: 'active',
        createdAt: { $gte: monthStart }
      }),
      TemplateListing.countDocuments({
        ...filter,
        status: 'active'
      })
    ]);

    res.json({
      today: todayCount,
      thisWeek: weekCount,
      thisMonth: monthCount,
      total: totalCount
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/analytics:
 *   get:
 *     tags: [Template Listings]
 *     summary: Detailed listing analytics with daily & user breakdown
 *     description: Returns paginated listings plus a per-day and per-user creation breakdown for the given template (optionally filtered by seller, date range, and user).
 *     parameters:
 *       - in: query
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *         example: "2024-01-01"
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *         example: "2024-12-31"
 *       - in: query
 *         name: userId
 *         schema: { type: string }
 *         description: Filter by creator. Pass `all` or omit to include everyone.
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *     responses:
 *       200:
 *         description: Paginated listings with dailyBreakdown, userBreakdown, and summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 listings:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/TemplateListing' }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 *                     pages: { type: integer }
 *                 dailyBreakdown:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       date: { type: string, example: "2024-06-01" }
 *                       total: { type: integer }
 *                       users:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             userId: { type: string }
 *                             username: { type: string }
 *                             count: { type: integer }
 *                 userBreakdown:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       userId: { type: string }
 *                       username: { type: string }
 *                       role: { type: string }
 *                       count: { type: integer }
 *                 summary:
 *                   type: object
 *                   properties:
 *                     totalInPeriod: { type: integer }
 *                     uniqueUsers: { type: integer }
 *       400: { description: templateId is required }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Get detailed analytics for template listings
router.get('/analytics', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, startDate, endDate, userId, page = 1, limit = 100 } = req.query;

    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    const filter = { templateId };
    if (sellerId) {
      filter.sellerId = sellerId;
    }

    // Apply date range filter
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.createdAt.$lte = new Date(endDate);
      }
    }

    // Apply user filter
    if (userId && userId !== 'all') {
      filter.createdBy = userId;
    }

    // Get paginated listings
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [listings, total] = await Promise.all([
      TemplateListing.find(filter)
        .populate('createdBy', 'username email role')
        .select('customLabel title _asinReference createdBy createdAt status')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TemplateListing.countDocuments(filter)
    ]);

    // Get daily breakdown using aggregation
    const dailyBreakdown = await TemplateListing.aggregate([
      {
        $match: filter
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            userId: "$createdBy"
          },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: "$_id.date",
          total: { $sum: "$count" },
          users: {
            $push: {
              userId: "$_id.userId",
              count: "$count"
            }
          }
        }
      },
      {
        $sort: { _id: -1 }
      },
      {
        $limit: 30 // Last 30 days
      }
    ]);

    // Populate user details in daily breakdown
    const userIds = [...new Set(dailyBreakdown.flatMap(d => d.users.map(u => u.userId)))].filter(Boolean);
    const users = await TemplateListing.model('User').find({ _id: { $in: userIds } }).select('username email role');
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    // Enrich daily breakdown with user details
    const enrichedDailyBreakdown = dailyBreakdown.map(day => ({
      date: day._id,
      total: day.total,
      users: day.users
        .filter(u => u.userId)
        .map(u => ({
          userId: u.userId,
          username: userMap.get(u.userId.toString())?.username || 'Unknown',
          count: u.count
        }))
    }));

    // Get user breakdown
    const userBreakdown = await TemplateListing.aggregate([
      {
        $match: filter
      },
      {
        $group: {
          _id: "$createdBy",
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);

    // Populate user details in user breakdown
    const enrichedUserBreakdown = await Promise.all(
      userBreakdown
        .filter(u => u._id)
        .map(async (u) => {
          const user = userMap.get(u._id.toString());
          return {
            userId: u._id,
            username: user?.username || 'Unknown',
            role: user?.role || 'N/A',
            count: u.count
          };
        })
    );

    res.json({
      listings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      dailyBreakdown: enrichedDailyBreakdown,
      userBreakdown: enrichedUserBreakdown,
      summary: {
        totalInPeriod: total,
        uniqueUsers: enrichedUserBreakdown.length
      }
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/bulk-preview-stream:
 *   get:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: Bulk ASIN preview — SSE stream (live scraping)
 *     description: |
 *       Fetches and AI-processes up to 100 ASINs in real-time and streams results as Server-Sent Events.
 *       Uses `requireAuthSSE` middleware (passes the JWT via `?token=` query param).
 *
 *       **Event types emitted:**
 *       - `started` — stream begins, includes `total` count
 *       - `item` — one preview result, includes `item`, `progress`, and `total`
 *       - `complete` — stream finished
 *       - `error` — fatal error (stream closes after this)
 *     parameters:
 *       - in: query
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: asins
 *         required: true
 *         schema: { type: string }
 *         description: Comma-separated ASIN list (max 100)
 *         example: "B01N5IB20Q,B07K1RZWMC"
 *       - in: query
 *         name: region
 *         schema: { type: string, default: US }
 *         description: Amazon marketplace region
 *       - in: query
 *         name: overlayBadgeId
 *         schema: { type: string }
 *         description: >
 *           Overlay badge composited onto each ASIN's primary image for this batch.
 *           Must be one of the template's configured `overlayOptions`; an unknown or
 *           disabled key is ignored and the preview runs without an overlay.
 *           Omit to use the template's default badge, if it has one. Send `none`
 *           to suppress the overlay for this batch even when a default is set.
 *         example: case-only
 *       - in: query
 *         name: token
 *         schema: { type: string }
 *         description: JWT token (used instead of Authorization header for EventSource)
 *     responses:
 *       200:
 *         description: Server-Sent Events stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: "data: {\"type\":\"item\",\"item\":{...},\"progress\":1,\"total\":10}\n\n"
 *       400: { description: Missing required parameters or too many ASINs }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Bulk preview with SSE streaming (real-time updates) - MUST be before /:id route
router.get('/bulk-preview-stream', requireAuthSSE, async (req, res) => {
  try {
    const { templateId, sellerId, asins: asinsParam, region = 'US' } = req.query;
    const preferCachedAmazonData = req.query.preferCachedAmazonData === 'true';
    // Overlay badge chosen by the user for this batch. Validated against the
    // template's overlayOptions before it can reach the filesystem.
    const overlayBadgeId = typeof req.query.overlayBadgeId === 'string' ? req.query.overlayBadgeId : '';

    if (!templateId || !sellerId || !asinsParam) {
      return res.status(400).json({ error: 'Template ID, Seller ID, and ASINs are required' });
    }

    const asins = asinsParam.split(',').map(a => a.trim()).filter(Boolean);

    if (asins.length === 0) {
      return res.status(400).json({ error: 'At least one ASIN is required' });
    }

    if (asins.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 ASINs allowed per batch' });
    }

    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });

    let streamClosed = false;
    const sendSse = (payload) => {
      if (streamClosed) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    };
    const sendDone = () => {
      if (streamClosed) return;
      res.write('data: [DONE]\n\n');
      if (typeof res.flush === 'function') res.flush();
    };
    const heartbeat = setInterval(() => {
      sendSse({ type: 'ping', timestamp: Date.now() });
    }, 15000);
    req.on('close', () => {
      streamClosed = true;
      clearInterval(heartbeat);
    });

    console.log(`📡 [SSE Stream] Starting for ${asins.length} ASINs...`);

    // Send initial event
    const streamConcurrency = parseInt(process.env.BULK_PREVIEW_CONCURRENCY, 10) || 15;
    sendSse({ type: 'started', total: asins.length, concurrency: Math.min(streamConcurrency, asins.length) });

    // Validate seller and template
    const [seller, template] = await Promise.all([
      Seller.findById(sellerId),
      getEffectiveTemplate(templateId, sellerId)
    ]);

    if (!seller || !template) {
      sendSse({ type: 'error', error: 'Seller or template not found' });
      sendDone();
      clearInterval(heartbeat);
      return res.end();
    }

    // Get pricing config
    let pricingConfig = template.pricingConfig;
    const sellerConfig = await SellerPricingConfig.findOne({ sellerId, templateId });
    if (sellerConfig) {
      pricingConfig = sellerConfig.pricingConfig;
    }
    const aiRunContext = createAiRunContext('bulk-preview-stream');

    const overlayContext = await prepareOverlayContext(template, seller, overlayBadgeId, 'bulk-preview-stream');

    // Check for existing ASINs and SKUs (same as bulk-preview)
    const existingAsinListings = await TemplateListing.find({
      sellerId,
      _asinReference: { $in: asins },
      status: 'active'
    }).select('+_asinReference +_amazonSourcePrice').lean();

    const asinInCurrentTemplate = new Map(); // Changed to Map to store full listing data
    const asinInOtherTemplates = new Map();

    existingAsinListings.forEach(listing => {
      if (listing.templateId.toString() === templateId.toString()) {
        asinInCurrentTemplate.set(listing._asinReference, listing); // Store full listing
      } else {
        asinInOtherTemplates.set(listing._asinReference, listing.templateId);
      }
    });

    // Pre-fetch template names for cross-template ASINs (for user-friendly warnings)
    const otherTemplateIds1 = [...new Set([...asinInOtherTemplates.values()].map(id => id.toString()))];
    const otherTemplateNameMap1 = new Map();
    if (otherTemplateIds1.length > 0) {
      const otherTpls = await ListingTemplate.find({ _id: { $in: otherTemplateIds1 } }).select('name').lean();
      otherTpls.forEach(t => otherTemplateNameMap1.set(t._id.toString(), t.name));
    }

    // Pre-generate SKUs and check conflicts
    const generatedSKUs = asins.map(asin => ({
      asin,
      sku: generateSKUFromASIN(asin)
    }));

    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: generatedSKUs.map(item => item.sku) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id').lean();

    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, {
        id: listing._id,
        asin: listing._asinReference
      }])
    );

    // Process ASINs with controlled concurrency and stream results as they complete.
    let completed = 0;

    await runWithConcurrency(asins, streamConcurrency, async (asin) => {
      if (streamClosed) return;
      try {
        sendSse({
          type: 'item_started',
          asin,
          id: `preview-${asin}`,
          progressStage: 'fetching'
        });

        // If ASIN exists in another template, note warning but continue with generation
        const crossTemplateWarning1 = asinInOtherTemplates.has(asin)
          ? `This ASIN also exists in template "${otherTemplateNameMap1.get(asinInOtherTemplates.get(asin)?.toString()) || 'another template'}"`
          : null;

        // Check if ASIN exists in current template (duplicate_updateable case)
        // This must be checked BEFORE SKU conflict check because duplicate ASINs
        // will have the same SKU and should be updateable, not blocked
        if (asinInCurrentTemplate.has(asin)) {
          const existingListing = asinInCurrentTemplate.get(asin);
          const existingCustomFields = existingListing.customFields || {};

          const asinDoc = await AsinDirectory.findOne({ asin }).lean();
          const futureSKU = generateSKUWithCount(asin, asinDoc?.listingCount || 0);

          let sourceData = null;
          let pricingCalculation = null;
          let freshAmazonSourcePrice = null;
          let overlayMappings = null;
          let overlayHostedImages = null;
          let duplicateImages = Array.isArray(asinDoc?.images) ? asinDoc.images : [];
          const needsLiveAmazonData = true;

          if (needsLiveAmazonData) {
            // Always refresh duplicate ASIN previews so price/source data stays current.
            try {
              console.log(`[duplicate_updateable] Fetching fresh Amazon data for ${asin}`);
              const amazonData = await fetchAmazonData(asin, region, { forceRefresh: !preferCachedAmazonData });
              if (amazonData) {
                // Same badge as the new-listing path, so a re-listed ASIN's
                // preview matches what a first-time listing would produce.
                const { data: stagedData, mappings } = await applyBatchOverlay(amazonData, overlayContext);
                overlayMappings = mappings || null;
                overlayHostedImages = Array.isArray(stagedData.images) ? stagedData.images : null;
                duplicateImages = Array.isArray(stagedData.images) ? stagedData.images : duplicateImages;
                sourceData = buildAmazonSourceData(stagedData);
                sendSse({
                  type: 'amazon_loaded',
                  asin,
                  id: `preview-${asin}`,
                  sourceData,
                  progressStage: 'generating'
                });
                freshAmazonSourcePrice = amazonData.price ? String(amazonData.price) : freshAmazonSourcePrice;
                pricingCalculation = calculatePricingOnly(asin, amazonData.price, pricingConfig);
              }
            } catch (fetchErr) {
              // Non-fatal: chip won't render but the rest of the modal works fine
              console.warn(`[duplicate_updateable] Option B failed for ${asin}:`, fetchErr.message);
            }
          }

          // Return existing listing data for editing (generatedListing = user's current saved data)
          // _amazonSourcePrice is included so the save endpoint stores it automatically
          const freshStartPrice = pricingCalculation?.calculatedStartPrice ?? existingListing.startPrice;
          const photoList = resolveSavedImageList(existingListing.itemPhotoUrl, overlayMappings, overlayHostedImages);
          const item = {
            id: `preview-${asin}`,
            asin,
            sku: futureSKU,
            status: 'duplicate_updateable',
            sourceData,
            pricingCalculation,
            generatedListing: {
              title: existingListing.title,
              // The saved fields are reused verbatim for editing, so the hosted
              // images have to be swapped into them directly — otherwise the
              // modal previews badged images while saving the original URLs.
              description: applyOverlayMapping(existingListing.description, overlayMappings),
              startPrice: freshStartPrice,
              quantity: existingListing.quantity,
              itemPhotoUrl: photoList.value,
              conditionId: existingListing.conditionId || '',
              format: existingListing.format || '',
              duration: existingListing.duration || '',
              location: existingListing.location || '',
              customLabel: futureSKU,
              customFields: existingCustomFields,
              _asinReference: asin,
              _aiRunId: aiRunContext.aiRunId,
              _existingListingId: existingListing._id,
              // Pass the refreshed Amazon price through so the save endpoint can persist it.
              ...(freshAmazonSourcePrice ? { _amazonSourcePrice: freshAmazonSourcePrice } : {})
            },
            progressStage: 'complete',
            warnings: [
              `This ASIN already exists in this template.`,
              existingListing.duplicateCount > 0
                ? `Previously updated ${existingListing.duplicateCount} time(s).`
                : `First time editing this ASIN.`,
              // Rewriting a saved listing's images should never be silent.
              ...(overlayMappings?.length ? ['Main image badged; all images moved to eBay hosting.'] : []),
              ...(photoList.replaced
                ? ['Saved image list was out of date — replaced with the current Amazon images.']
                : [])
            ],
            errors: []
          };

          sendSse({ type: 'item', item, progress: ++completed, total: asins.length });
          return;
        }



        // Check for SKU conflicts (only for new ASINs, not duplicates)
        const sku = generateSKUFromASIN(asin);
        const existingSKU = existingSKUMap.get(sku);

        if (existingSKU) {
          const item = {
            id: `preview-${asin}`,
            asin,
            sku,
            status: 'blocked',
            progressStage: 'complete',
            blockedReason: 'sku_conflict',
            errors: [`SKU ${sku} already exists`]
          };
          sendSse({ type: 'item', item, progress: ++completed, total: asins.length });
          return;
        }

        // Fetch and process ASIN (new listing case)
        const amazonData = await fetchAmazonData(asin, region);
        // Badge the primary image before anything reads images[0]: one swap
        // covers itemPhotoUrl, {image_main} in the description, and the modal.
        const overlayResult = await applyBatchOverlay(amazonData, overlayContext);
        const stagedData = overlayResult.data;
        const sourceData = buildAmazonSourceData(stagedData);
        sendSse({
          type: 'amazon_loaded',
          asin,
          id: `preview-${asin}`,
          sourceData,
          overlayApplied: overlayResult.applied,
          overlayWarning: overlayResult.warning || null,
          progressStage: 'generating'
        });
        const { coreFields, customFields, pricingCalculation } =
          await applyFieldConfigs(stagedData, template.asinAutomation.fieldConfigs, pricingConfig, buildAiUsageContext(req, templateId, sellerId, aiRunContext));

        const mergedCoreFields = {
          ...(template.coreFieldDefaults || {}),
          ...coreFields
        };

        if (template?.customColumns && template.customColumns.length > 0) {
          template.customColumns.forEach(col => {
            if (col.defaultValue && !customFields[col.name]) {
              customFields[col.name] = col.defaultValue;
            }
          });
        }

        const warnings = [];
        if (crossTemplateWarning1) warnings.push(crossTemplateWarning1);
        const validationErrors = [];

        if (!mergedCoreFields.title) {
          validationErrors.push('Missing required field: title');
        }

        if (mergedCoreFields.startPrice === undefined || mergedCoreFields.startPrice === null || mergedCoreFields.startPrice === '') {
          validationErrors.push('Missing required field: startPrice');
        }

        if (!mergedCoreFields.description) {
          warnings.push('Missing description');
        }

        // Compute count-based SKU for new listing preview
        const countDoc = await AsinDirectory.findOne({ asin }).select('listingCount').lean();
        const finalSKU = generateSKUWithCount(asin, countDoc?.listingCount || 0);

        const item = {
          id: `preview-${asin}`,
          asin,
          sku: finalSKU,
          sourceData,
          generatedListing: {
            ...mergedCoreFields,
            customLabel: finalSKU,
            customFields,
            _asinReference: asin,
            _aiRunId: aiRunContext.aiRunId,
            _amazonSourcePrice: amazonData.price ? String(amazonData.price) : null
          },
          pricingCalculation,
          warnings,
          errors: validationErrors,
          progressStage: 'complete',
          status: validationErrors.length > 0 ? 'error' : (warnings.length > 0 ? 'warning' : 'success')
        };

        // Stream the completed item
        sendSse({ type: 'item', item, progress: ++completed, total: asins.length });

      } catch (error) {
        console.error(`❌ Error processing ASIN ${asin}:`, error);
        const item = {
          id: `preview-${asin}`,
          asin,
          sku: generateSKUFromASIN(asin),
          status: 'error',
          progressStage: 'complete',
          errors: [error.message]
        };
        sendSse({ type: 'item', item, progress: ++completed, total: asins.length });
      }
    }, () => !streamClosed);

    // Send completion event
    sendSse({ type: 'complete', total: completed });
    sendDone();

    console.log(`📡 [SSE Stream] Completed: ${completed}/${asins.length} ASINs`);
    clearInterval(heartbeat);
    res.end();

  } catch (error) {
    console.error('SSE Stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

/**
 * @swagger
 * /template-listings/bulk-preview-from-directory-stream:
 *   get:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: Bulk ASIN preview from ASIN Directory — SSE stream (no scraping)
 *     description: |
 *       Like `bulk-preview-stream` but reads from the locally stored ASIN Directory instead of
 *       scraping Amazon live. Much faster and does not consume ScraperAPI quota.
 *
 *       **Event types emitted:** same as `bulk-preview-stream` (`started`, `item`, `complete`, `error`).
 *     parameters:
 *       - in: query
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: asins
 *         required: true
 *         schema: { type: string }
 *         description: Comma-separated ASIN list (max 100)
 *         example: "B01N5IB20Q,B07K1RZWMC"
 *       - in: query
 *         name: overlayBadgeId
 *         schema: { type: string }
 *         description: >
 *           Overlay badge composited onto each ASIN's primary image for this batch.
 *           Must be one of the template's configured `overlayOptions`.
 *         example: case-only
 *       - in: query
 *         name: token
 *         schema: { type: string }
 *         description: JWT token (used instead of Authorization header for EventSource)
 *     responses:
 *       200:
 *         description: Server-Sent Events stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: "data: {\"type\":\"item\",\"item\":{...},\"progress\":1,\"total\":10}\n\n"
 *       400: { description: Missing required parameters or too many ASINs }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Bulk preview from ASIN Directory (no scraping — reads stored data) with SSE streaming
router.get('/bulk-preview-from-directory-stream', requireAuthSSE, async (req, res) => {
  try {
    const { templateId, sellerId, asins: asinsParam } = req.query;
    const overlayBadgeId = typeof req.query.overlayBadgeId === 'string' ? req.query.overlayBadgeId : '';

    if (!templateId || !sellerId || !asinsParam) {
      return res.status(400).json({ error: 'Template ID, Seller ID, and ASINs are required' });
    }

    const asins = asinsParam.split(',').map(a => a.trim()).filter(Boolean);

    if (asins.length === 0) {
      return res.status(400).json({ error: 'At least one ASIN is required' });
    }

    if (asins.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 ASINs allowed per batch' });
    }

    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    console.log(`📂 [Directory SSE] Starting for ${asins.length} ASINs...`);
    res.write(`data: ${JSON.stringify({ type: 'started', total: asins.length })}\n\n`);

    // Validate seller and template
    const [seller, template] = await Promise.all([
      Seller.findById(sellerId),
      getEffectiveTemplate(templateId, sellerId)
    ]);

    if (!seller || !template) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Seller or template not found' })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Get pricing config (seller override takes priority)
    let pricingConfig = template.pricingConfig;
    const sellerConfig = await SellerPricingConfig.findOne({ sellerId, templateId });
    if (sellerConfig) {
      pricingConfig = sellerConfig.pricingConfig;
    }

    const overlayContext = await prepareOverlayContext(template, seller, overlayBadgeId, 'directory-stream');

    // Check for existing ASINs and SKU conflicts
    const existingAsinListings = await TemplateListing.find({
      sellerId,
      _asinReference: { $in: asins },
      status: 'active'
    }).select('+_asinReference').lean();

    const asinInCurrentTemplate = new Map();
    const asinInOtherTemplates = new Map();

    existingAsinListings.forEach(listing => {
      if (listing.templateId.toString() === templateId.toString()) {
        asinInCurrentTemplate.set(listing._asinReference, listing);
      } else {
        asinInOtherTemplates.set(listing._asinReference, listing.templateId);
      }
    });

    // Pre-fetch template names for cross-template ASINs (for user-friendly warnings)
    const otherTemplateIds2 = [...new Set([...asinInOtherTemplates.values()].map(id => id.toString()))];
    const otherTemplateNameMap2 = new Map();
    if (otherTemplateIds2.length > 0) {
      const otherTpls2 = await ListingTemplate.find({ _id: { $in: otherTemplateIds2 } }).select('name').lean();
      otherTpls2.forEach(t => otherTemplateNameMap2.set(t._id.toString(), t.name));
    }

    const generatedSKUs = asins.map(asin => ({ asin, sku: generateSKUFromASIN(asin) }));
    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: generatedSKUs.map(item => item.sku) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id').lean();

    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, { id: listing._id, asin: listing._asinReference }])
    );

    const aiRunContext = createAiRunContext('bulk-preview-directory-stream');
    let completed = 0;

    const processPromises = asins.map(async (asin) => {
      try {
        // If ASIN exists in another template, note warning but continue with generation
        const crossTemplateWarning2 = asinInOtherTemplates.has(asin)
          ? `This ASIN also exists in template "${otherTemplateNameMap2.get(asinInOtherTemplates.get(asin)?.toString()) || 'another template'}"`
          : null;

        // Duplicate in current template — updateable
        if (asinInCurrentTemplate.has(asin)) {
          const existingListing = asinInCurrentTemplate.get(asin);

          // Use directory only for listing count metadata; duplicate source details come fresh from ScraperAPI.
          const doc = await AsinDirectory.findOne({ asin }).select('listingCount').lean();
          const futureSKU = generateSKUWithCount(asin, doc?.listingCount || 0);

          let sourceData = null;
          let pricingCalculation = null;
          let overlayMappings = null;
          let overlayHostedImages = null;

          try {
            const amazonData = await fetchAmazonData(asin, region, { forceRefresh: true });
            const { data: stagedData, mappings } = await applyBatchOverlay(amazonData, overlayContext);
            overlayMappings = mappings || null;
            overlayHostedImages = Array.isArray(stagedData.images) ? stagedData.images : null;
            sourceData = buildAmazonSourceData(stagedData);
            pricingCalculation = calculatePricingOnly(asin, amazonData.price, pricingConfig);
          } catch (fetchErr) {
            console.warn(`[directory duplicate_updateable] Fresh ScraperAPI fetch failed for ${asin}:`, fetchErr.message);
          }

          const freshStartPrice = pricingCalculation?.calculatedStartPrice ?? existingListing.startPrice;
          const photoList = resolveSavedImageList(existingListing.itemPhotoUrl, overlayMappings, overlayHostedImages);

          const item = {
            id: `preview-${asin}`, asin,
            sku: futureSKU,
            status: 'duplicate_updateable',
            sourceData,
            pricingCalculation,
            generatedListing: {
              title: existingListing.title,
              // See the bulk-preview-stream duplicate branch: saved fields are
              // reused as-is, so the hosted images are swapped in rather than
              // regenerated.
              description: applyOverlayMapping(existingListing.description, overlayMappings),
              startPrice: freshStartPrice,
              quantity: existingListing.quantity,
              itemPhotoUrl: photoList.value,
              conditionId: existingListing.conditionId || '',
              format: existingListing.format || '',
              duration: existingListing.duration || '',
              location: existingListing.location || '',
              customLabel: futureSKU,
              customFields: existingListing.customFields || {},
              _asinReference: asin,
              _aiRunId: aiRunContext.aiRunId,
              _existingListingId: existingListing._id
            },
            warnings: [
              'This ASIN already exists in this template.',
              existingListing.duplicateCount > 0
                ? `Previously updated ${existingListing.duplicateCount} time(s).`
                : 'First time editing this ASIN.',
              ...(overlayMappings?.length ? ['Main image badged; all images moved to eBay hosting.'] : []),
              ...(photoList.replaced
                ? ['Saved image list was out of date — replaced with the current Amazon images.']
                : [])
            ],
            errors: []
          };
          res.write(`data: ${JSON.stringify({ type: 'item', item, progress: ++completed, total: asins.length })}\n\n`);
          return;
        }

        // SKU conflict
        const sku = generateSKUFromASIN(asin);
        if (existingSKUMap.has(sku)) {
          const item = {
            id: `preview-${asin}`, asin, sku,
            status: 'blocked', blockedReason: 'sku_conflict',
            errors: [`SKU ${sku} already exists`]
          };
          res.write(`data: ${JSON.stringify({ type: 'item', item, progress: ++completed, total: asins.length })}\n\n`);
          return;
        }

        // Look up ASIN in the directory
        res.write(`data: ${JSON.stringify({ type: 'progress', id: `preview-${asin}`, stage: 'fetching' })}\n\n`);
        const doc = await AsinDirectory.findOne({ asin }).lean();

        // Build amazonData from stored document (no scraping).
        // Shape must match fetchAmazonData() output so applyFieldConfigs works identically,
        // including the `asin` property used in AI prompt placeholders ({{asin}}).
        const amazonData = doc ? {
          asin,
          title: doc.title || '',
          brand: doc.brand || '',
          price: doc.price || '',
          description: doc.description || '',
          images: doc.images || [],
          color: doc.color || '',
          compatibility: doc.compatibility || '',
          model: doc.model || '',
          material: doc.material || '',
          specialFeatures: doc.specialFeatures || '',
          size: doc.size || ''
        } : {
          asin,
          title: '', brand: '', price: '', description: '',
          images: [], color: '', compatibility: '',
          model: '', material: '', specialFeatures: '', size: ''
        };

        res.write(`data: ${JSON.stringify({ type: 'progress', id: `preview-${asin}`, stage: 'generating' })}\n\n`);
        const { data: stagedData } = await applyBatchOverlay(amazonData, overlayContext);
        const { coreFields, customFields, pricingCalculation } =
          await applyFieldConfigs(stagedData, template.asinAutomation.fieldConfigs, pricingConfig, buildAiUsageContext(req, templateId, sellerId, aiRunContext));

        const mergedCoreFields = {
          ...(template.coreFieldDefaults || {}),
          ...coreFields
        };

        if (template?.customColumns && template.customColumns.length > 0) {
          template.customColumns.forEach(col => {
            if (col.defaultValue && !customFields[col.name]) {
              customFields[col.name] = col.defaultValue;
            }
          });
        }

        const warnings = [];
        if (crossTemplateWarning2) warnings.push(crossTemplateWarning2);
        const validationErrors = [];

        // Warn if ASIN was never scraped or not found in directory
        if (!doc) {
          warnings.push('ASIN not found in directory — fields may be empty');
        } else if (!doc.scraped) {
          warnings.push('ASIN has not been scraped yet — some fields may be missing');
        }

        if (!mergedCoreFields.title) validationErrors.push('Missing required field: title');
        if (mergedCoreFields.startPrice === undefined || mergedCoreFields.startPrice === null || mergedCoreFields.startPrice === '') {
          validationErrors.push('Missing required field: startPrice');
        }
        if (!mergedCoreFields.description) warnings.push('Missing description');

        // Compute count-based SKU using the already-fetched directory doc
        const finalSKU = generateSKUWithCount(asin, doc?.listingCount || 0);

        const item = {
          id: `preview-${asin}`,
          asin,
          sku: finalSKU,
          sourceData: {
            title: amazonData.title,
            brand: amazonData.brand,
            price: amazonData.price,
            description: amazonData.description,
            images: amazonData.images,
            color: amazonData.color,
            compatibility: amazonData.compatibility,
            productInfo: amazonData.productInfo || null
          },
          generatedListing: {
            ...mergedCoreFields,
            customLabel: finalSKU,
            customFields,
            _asinReference: asin,
            _aiRunId: aiRunContext.aiRunId
          },
          pricingCalculation,
          warnings,
          errors: validationErrors,
          status: validationErrors.length > 0 ? 'error' : (warnings.length > 0 ? 'warning' : 'success')
        };

        res.write(`data: ${JSON.stringify({ type: 'item', item, progress: ++completed, total: asins.length })}\n\n`);

      } catch (error) {
        console.error(`❌ Error processing ASIN ${asin} from directory:`, error);
        const item = {
          id: `preview-${asin}`, asin, sku: generateSKUFromASIN(asin),
          status: 'error', errors: [error.message]
        };
        res.write(`data: ${JSON.stringify({ type: 'item', item, progress: ++completed, total: asins.length })}\n\n`);
      }
    });

    await Promise.allSettled(processPromises);

    res.write(`data: ${JSON.stringify({ type: 'complete', total: completed })}\n\n`);
    res.write('data: [DONE]\n\n');
    console.log(`📂 [Directory SSE] Completed: ${completed}/${asins.length} ASINs`);
    res.end();

  } catch (error) {
    console.error('Directory SSE Stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

/**
 * @swagger
 * /template-listings/{id}:
 *   get:
 *     tags: [Template Listings]
 *     summary: Get a single listing by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Listing document ID
 *     responses:
 *       200:
 *         description: Listing document with populated createdBy and templateId
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/TemplateListing' }
 *       401: { description: Unauthorized }
 *       404: { description: Listing not found }
 *       500: { description: Server error }
 */
// ── Precheck-stats date helpers ──────────────────────────────────────────────
// The stats page groups days in America/Los_Angeles (PDT/PST), so explicit
// date filters must use that timezone's midnight as the day boundary. The
// two-pass offset technique stays correct across the DST switch.
const PRECHECK_STATS_TIMEZONE = 'America/Los_Angeles';

function zoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return asUtc - date.getTime();
}

function zonedMidnightUtc(dateStr, timeZone) {
  const naive = new Date(`${dateStr}T00:00:00Z`);
  const offset = zoneOffsetMs(naive, timeZone);
  let utc = new Date(naive.getTime() - offset);
  const refined = zoneOffsetMs(utc, timeZone);
  if (refined !== offset) utc = new Date(naive.getTime() - refined);
  return utc;
}

function nextDateStr(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * GET /template-listings/precheck-stats
 * Aggregated counts of prechecked ASINs (from AsinPrecheckLog) for the
 * Precheck Stats page: totals + breakdowns by country, day, user, and
 * seller/template.
 * Query: either startDate/endDate (YYYY-MM-DD, PDT days — endDate defaults to
 * startDate for a single day) or days (1-365 rolling window, default 30);
 * plus optional region (US|UK|CA|AU). Explicit dates keep the query bounded
 * so a single-day lookup only scans that day's documents (createdAt index).
 * NOTE: must be registered BEFORE the generic GET /:id below, or Express
 * routes "precheck-stats" into the :id param and this is never reached.
 */
router.get('/precheck-stats', requireAuth, async (req, res) => {
  try {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const startDateParam = dateRe.test(String(req.query.startDate || '')) ? String(req.query.startDate) : null;
    const endDateParam = dateRe.test(String(req.query.endDate || '')) ? String(req.query.endDate) : startDateParam;

    let match;
    let rangeInfo;
    if (startDateParam) {
      const from = zonedMidnightUtc(startDateParam, PRECHECK_STATS_TIMEZONE);
      const toExclusive = zonedMidnightUtc(nextDateStr(endDateParam), PRECHECK_STATS_TIMEZONE);
      if (toExclusive <= from) {
        return res.status(400).json({ error: 'endDate must be on or after startDate' });
      }
      match = { createdAt: { $gte: from, $lt: toExclusive } };
      rangeInfo = { mode: 'range', startDate: startDateParam, endDate: endDateParam };
    } else {
      const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      match = { createdAt: { $gte: since } };
      rangeInfo = { mode: 'rolling', days, since: since.toISOString() };
    }
    if (['US', 'UK', 'CA', 'AU'].includes(req.query.region)) {
      match.region = req.query.region;
    }

    const [totals, byRegion, byDay, byUser, bySellerTemplate] = await Promise.all([
      AsinPrecheckLog.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            asinCount: { $sum: '$asinCount' },
            batchCount: { $sum: 1 },
            availabilityRetryCount: { $sum: '$availabilityRetryCount' },
            availabilityRetrySuccessCount: { $sum: '$availabilityRetrySuccessCount' }
          }
        }
      ]),
      AsinPrecheckLog.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$region',
            asinCount: { $sum: '$asinCount' },
            batchCount: { $sum: 1 },
            availabilityRetryCount: { $sum: '$availabilityRetryCount' },
            availabilityRetrySuccessCount: { $sum: '$availabilityRetrySuccessCount' }
          }
        },
        { $sort: { asinCount: -1 } }
      ]),
      AsinPrecheckLog.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: PRECHECK_STATS_TIMEZONE } },
              region: '$region'
            },
            asinCount: { $sum: '$asinCount' }
          }
        },
        { $sort: { '_id.day': -1 } }
      ]),
      AsinPrecheckLog.aggregate([
        { $match: match },
        { $group: { _id: '$user', asinCount: { $sum: '$asinCount' }, batchCount: { $sum: 1 } } },
        { $sort: { asinCount: -1 } }
      ]),
      AsinPrecheckLog.aggregate([
        { $match: match },
        {
          $group: {
            _id: { seller: '$seller', template: '$template' },
            asinCount: { $sum: '$asinCount' },
            batchCount: { $sum: 1 }
          }
        },
        { $sort: { asinCount: -1 } },
        { $limit: 100 }
      ])
    ]);

    // Resolve ids to display names in one query per collection
    const userIds = byUser.map((row) => row._id).filter(Boolean);
    const sellerIds = bySellerTemplate.map((row) => row._id.seller).filter(Boolean);
    const templateIds = bySellerTemplate.map((row) => row._id.template).filter(Boolean);

    const [users, sellers, templates] = await Promise.all([
      userIds.length
        ? User.find({ _id: { $in: userIds } }).select('username email').lean()
        : [],
      sellerIds.length
        ? Seller.find({ _id: { $in: sellerIds } }).populate('user', 'username email').lean()
        : [],
      templateIds.length
        ? ListingTemplate.find({ _id: { $in: templateIds } }).select('name').lean()
        : []
    ]);

    const userNameById = new Map(users.map((u) => [String(u._id), u.username || u.email || String(u._id)]));
    const sellerNameById = new Map(sellers.map((s) => [String(s._id), s.user?.username || s.user?.email || String(s._id)]));
    const templateNameById = new Map(templates.map((t) => [String(t._id), t.name || String(t._id)]));

    res.json({
      ...rangeInfo,
      totals: totals[0]
        ? {
            asinCount: totals[0].asinCount,
            batchCount: totals[0].batchCount,
            availabilityRetryCount: totals[0].availabilityRetryCount || 0,
            availabilityRetrySuccessCount: totals[0].availabilityRetrySuccessCount || 0
          }
        : { asinCount: 0, batchCount: 0, availabilityRetryCount: 0, availabilityRetrySuccessCount: 0 },
      byRegion: byRegion.map((row) => ({
        region: row._id,
        asinCount: row.asinCount,
        batchCount: row.batchCount,
        availabilityRetryCount: row.availabilityRetryCount || 0,
        availabilityRetrySuccessCount: row.availabilityRetrySuccessCount || 0
      })),
      byDay: byDay.map((row) => ({ day: row._id.day, region: row._id.region, asinCount: row.asinCount })),
      byUser: byUser.map((row) => ({
        userId: row._id ? String(row._id) : null,
        userName: row._id ? (userNameById.get(String(row._id)) || String(row._id)) : 'Unknown',
        asinCount: row.asinCount,
        batchCount: row.batchCount
      })),
      bySellerTemplate: bySellerTemplate.map((row) => ({
        sellerId: row._id.seller ? String(row._id.seller) : null,
        sellerName: row._id.seller ? (sellerNameById.get(String(row._id.seller)) || String(row._id.seller)) : 'Unknown',
        templateId: row._id.template ? String(row._id.template) : null,
        templateName: row._id.template ? (templateNameById.get(String(row._id.template)) || String(row._id.template)) : 'Unknown',
        asinCount: row.asinCount,
        batchCount: row.batchCount
      }))
    });
  } catch (error) {
    console.error('[Precheck Stats] Failed:', error);
    res.status(500).json({ error: error.message || 'Failed to load precheck stats' });
  }
});

// Get single listing by ID.
//
// requireObjectId sits after requireAuth so an unauthenticated request still
// answers 401 rather than falling through and revealing which paths exist.
// Anything that is not an id — /cache-stats and every literal GET added below
// this line in future — passes on to its own route instead of being cast to an
// ObjectId here and reported as a 500.
router.get('/:id', requireAuth, requireObjectId(), async (req, res) => {
  try {
    const listing = await TemplateListing.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('templateId');

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    res.json(listing);
  } catch (error) {
    console.error('Error fetching listing:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/:
 *   post:
 *     tags: [Template Listings]
 *     summary: Create a new listing
 *     description: |
 *       Creates a new active listing for a template. If an inactive listing with the same SKU
 *       already exists it is reactivated instead. Returns `409` if an active listing with the
 *       same SKU already exists.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, sellerId, customLabel, title, startPrice]
 *             properties:
 *               templateId: { type: string }
 *               sellerId: { type: string }
 *               customLabel: { type: string, description: eBay SKU }
 *               title: { type: string }
 *               startPrice: { type: number }
 *               description: { type: string }
 *               quantity: { type: integer, default: 1 }
 *               categoryId: { type: string }
 *               categoryName: { type: string }
 *               conditionId: { type: string }
 *               itemPhotoUrl: { type: string }
 *               customFields: { type: object, additionalProperties: { type: string } }
 *     responses:
 *       201:
 *         description: Created or reactivated listing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 listing: { $ref: '#/components/schemas/TemplateListing' }
 *                 wasReactivated: { type: boolean }
 *       400: { description: Missing required fields }
 *       401: { description: Unauthorized }
 *       404: { description: Seller not found }
 *       409: { description: Active listing with this SKU already exists }
 *       500: { description: Server error }
 */
// Create new listing
router.post('/', requireAuth, async (req, res) => {
  try {
    const listingData = req.body;

    if (!listingData.templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    if (!listingData.sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }

    // Validate seller exists
    const seller = await Seller.findById(listingData.sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    if (!listingData.customLabel) {
      return res.status(400).json({ error: 'SKU (Custom label) is required' });
    }

    if (!listingData.title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    if (!listingData.startPrice && listingData.startPrice !== 0) {
      return res.status(400).json({ error: 'Start price is required' });
    }

    // Convert customFields object to Map
    if (listingData.customFields && typeof listingData.customFields === 'object') {
      listingData.customFields = new Map(Object.entries(listingData.customFields));
    }

    // Check if SKU exists as active (block duplicate)
    const activeExists = await TemplateListing.findOne({
      templateId: listingData.templateId,
      sellerId: listingData.sellerId,
      customLabel: listingData.customLabel,
      status: 'active'
    });

    if (activeExists) {
      return res.status(409).json({
        error: 'An active listing with this SKU already exists'
      });
    }

    // Check if SKU exists as inactive (reactivate instead of creating new)
    const inactiveExists = await TemplateListing.findOne({
      templateId: listingData.templateId,
      sellerId: listingData.sellerId,
      customLabel: listingData.customLabel,
      status: 'inactive'
    });

    let listing;
    let wasReactivated = false;

    if (inactiveExists) {
      // Reactivate existing inactive listing and update with new data
      Object.assign(inactiveExists, {
        ...listingData,
        customFields: listingData.customFields,
        status: 'active',
        updatedAt: Date.now()
      });

      await inactiveExists.save();
      listing = inactiveExists;
      wasReactivated = true;

      console.log(`✅ Reactivated inactive listing: ${listingData.customLabel}`);
    } else {
      // Create new listing
      listing = new TemplateListing({
        ...listingData,
        status: 'active',
        createdBy: req.user.userId
      });

      await listing.save();
    }

    await listing.populate([
      { path: 'createdBy', select: 'name email' },
      {
        path: 'sellerId',
        populate: {
          path: 'user',
          select: 'username email'
        }
      }
    ]);

    res.status(201).json({
      listing,
      wasReactivated
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A listing with this SKU already exists in this template' });
    }
    console.error('Error creating listing:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/bulk-apply-schedule:
 *   post:
 *     tags: [Template Listings – Admin]
 *     summary: Assign sequential schedule times to listings
 *     description: |
 *       Assigns sequential `scheduleTime` values (IST wall-clock, format `YYYY-MM-DD HH:MM:SS`) to all
 *       matched listings, spaced by `stepMinutes`. Listings are ordered by `createdAt ASC`.
 *       Optionally scoped to a specific batch or row range.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, sellerId, startDateTime, stepMinutes]
 *             properties:
 *               templateId:    { type: string }
 *               sellerId:      { type: string }
 *               startDateTime: { type: string, example: "2024-06-01 08:00:00", description: "YYYY-MM-DD HH:MM:SS" }
 *               stepMinutes:   { type: integer, example: 5 }
 *               batchFilter:   { type: string, description: active | downloaded | batch }
 *               batchId:       { type: string, description: Filter to a specific download batch }
 *               fromRow:       { type: integer, description: 1-based start row (inclusive) }
 *               toRow:         { type: integer, description: 1-based end row (inclusive) }
 *     responses:
 *       200:
 *         description: Schedule applied
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 updated:   { type: integer, example: 48 }
 *                 firstTime: { type: string, example: "2024-06-01 08:00:00" }
 *                 lastTime:  { type: string, example: "2024-06-01 11:55:00" }
 *       400: { description: Missing required fields or invalid stepMinutes / date format }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// ============================================
// BULK APPLY SCHEDULE TIMES
// POST /template-listings/bulk-apply-schedule
// Body: { templateId, sellerId, startDateTime (YYYY-MM-DD HH:MM:SS), stepMinutes }
// Assigns sequential scheduleTime values to all listings for the template+seller,
// ordered by createdAt ASC, spaced by stepMinutes.
// ============================================
router.post('/bulk-apply-schedule', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, startDateTime, stepMinutes, batchFilter, batchId, fromRow, toRow } = req.body;

    if (!templateId || !sellerId || !startDateTime || stepMinutes == null) {
      return res.status(400).json({ error: 'templateId, sellerId, startDateTime, and stepMinutes are required' });
    }

    const step = parseInt(stepMinutes, 10);
    if (isNaN(step) || step < 1) {
      return res.status(400).json({ error: 'stepMinutes must be a positive integer' });
    }

    // Parse "YYYY-MM-DD HH:MM:SS" — pure string arithmetic, no Date objects.
    // This ensures the stored value exactly matches what the user entered (IST wall-clock).
    const dtMatch = startDateTime.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!dtMatch) {
      return res.status(400).json({ error: 'Invalid startDateTime format. Expected YYYY-MM-DD HH:MM:SS' });
    }
    const baseYear = parseInt(dtMatch[1]);
    const baseMonth = parseInt(dtMatch[2]);
    const baseDay = parseInt(dtMatch[3]);
    const baseHour = parseInt(dtMatch[4]);
    const baseMinute = parseInt(dtMatch[5]);
    const baseSec = parseInt(dtMatch[6]);

    // Fetch listings matching the same filter the user is currently viewing
    const listingFilter = { templateId, sellerId };
    if (batchId) {
      listingFilter.downloadBatchId = batchId;
    } else if (!batchFilter || batchFilter === 'active') {
      listingFilter.$or = [{ downloadBatchId: null }, { pendingRedownload: true }];
    }
    // batchFilter === 'all' → no additional filter

    // Fetch all listings for this template + seller, sorted by creation order
    const listings = await TemplateListing.find(listingFilter)
      .sort({ createdAt: 1 })
      .select('_id')
      .lean();

    if (listings.length === 0) {
      return res.json({ updated: 0, firstTime: null, lastTime: null });
    }

    // Optional row range (1-based, inclusive). Defaults to the full list.
    const from = fromRow && parseInt(fromRow) >= 1 ? parseInt(fromRow) - 1 : 0;
    const to = toRow && parseInt(toRow) >= 1 ? parseInt(toRow) : listings.length;
    const targetListings = listings.slice(from, to);

    if (targetListings.length === 0) {
      return res.json({ updated: 0, firstTime: null, lastTime: null });
    }

    // Pure arithmetic: add totalMinutes to the base time and return "YYYY-MM-DD HH:MM:SS"
    const pad = n => String(n).padStart(2, '0');
    const daysInMonth = (y, m) => new Date(y, m, 0).getDate(); // m is 1-based

    function addMinutesAndFormat(addMin) {
      let totalMin = baseHour * 60 + baseMinute + addMin;
      let extraDays = Math.floor(totalMin / 1440); // 1440 = 24*60
      totalMin = totalMin % 1440;
      if (totalMin < 0) { totalMin += 1440; extraDays--; }

      const hh = Math.floor(totalMin / 60);
      const mm = totalMin % 60;

      // Add extra days to date
      let y = baseYear, m = baseMonth, d = baseDay + extraDays;
      while (d > daysInMonth(y, m)) {
        d -= daysInMonth(y, m);
        m++;
        if (m > 12) { m = 1; y++; }
      }
      while (d < 1) {
        m--;
        if (m < 1) { m = 12; y--; }
        d += daysInMonth(y, m);
      }

      return `${y}-${pad(m)}-${pad(d)} ${pad(hh)}:${pad(mm)}:${pad(baseSec)}`;
    }

    const bulkOps = targetListings.map((listing, i) => ({
      updateOne: {
        filter: { _id: listing._id },
        update: { $set: { scheduleTime: addMinutesAndFormat(i * step) } }
      }
    }));

    await TemplateListing.bulkWrite(bulkOps);

    res.json({
      updated: targetListings.length,
      firstTime: addMinutesAndFormat(0),
      lastTime: addMinutesAndFormat((targetListings.length - 1) * step)
    });
  } catch (error) {
    console.error('[Bulk Apply Schedule] Error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to apply schedule times' });
  }
});

/**
 * @swagger
 * /template-listings/clear-schedule:
 *   post:
 *     tags: [Template Listings – Admin]
 *     summary: Clear schedule times for listings
 *     description: Sets `scheduleTime` to an empty string for all matched listings. Scope can be narrowed by batchId or batchFilter.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, sellerId]
 *             properties:
 *               templateId:  { type: string }
 *               sellerId:    { type: string }
 *               batchFilter: { type: string, description: active | downloaded | batch }
 *               batchId:     { type: string, description: Target a specific download batch }
 *     responses:
 *       200:
 *         description: Number of cleared listings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cleared: { type: integer, example: 24 }
 *       400: { description: templateId and sellerId are required }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// ============================================
// CLEAR SCHEDULE TIMES
// POST /template-listings/clear-schedule
// Clears scheduleTime for all active-batch listings
// ============================================
router.post('/clear-schedule', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, batchFilter, batchId } = req.body;

    if (!templateId || !sellerId) {
      return res.status(400).json({ error: 'templateId and sellerId are required' });
    }

    const filter = { templateId, sellerId };
    if (batchId) {
      filter.downloadBatchId = batchId;
    } else if (!batchFilter || batchFilter === 'active') {
      filter.$or = [{ downloadBatchId: null }, { pendingRedownload: true }];
    }

    const result = await TemplateListing.updateMany(filter, { $set: { scheduleTime: '' } });

    res.json({ cleared: result.modifiedCount });
  } catch (error) {
    console.error('[Clear Schedule] Error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to clear schedule times' });
  }
});

/**
 * @swagger
 * /template-listings/bulk-update:
 *   put:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: Bulk update listing fields
 *     description: Applies partial field updates to multiple listings at once. Only editable fields are patched; unknown fields are ignored.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listings]
 *             properties:
 *               listings:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     _id: { type: string, description: Listing ID (or _existingListingId) }
 *                     _existingListingId: { type: string }
 *                     title: { type: string }
 *                     startPrice: { type: number }
 *                     scheduleTime: { type: string }
 *                     customFields: { type: object }
 *     responses:
 *       200:
 *         description: Number of successfully updated listings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 updated: { type: integer, example: 5 }
 *       400: { description: listings array is required }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Bulk update listings
router.put('/bulk-update', requireAuth, async (req, res) => {
  try {
    const { listings } = req.body;

    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({ error: 'Listings array is required' });
    }

    const EDITABLE_FIELDS = [
      'action', 'customLabel', 'title', 'startPrice',
      'categoryId', 'categoryName', 'relationship', 'relationshipDetails',
      'scheduleTime', 'customFields', 'description', 'condition',
      'conditionDescription', 'quantity', 'format', 'duration',
    ];

    let updated = 0;
    for (const listing of listings) {
      const id = listing._existingListingId || listing._id;
      if (!id) continue;

      const patch = {};
      for (const field of EDITABLE_FIELDS) {
        if (listing[field] !== undefined) patch[field] = listing[field];
      }

      if (Object.keys(patch).length > 0) {
        await TemplateListing.findByIdAndUpdate(id, { $set: patch });
        updated++;
      }
    }

    res.json({ updated });
  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk update listings' });
  }
});

/**
 * @swagger
 * /template-listings/{id}:
 *   put:
 *     tags: [Template Listings]
 *     summary: Update a single listing
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/TemplateListing' }
 *     responses:
 *       200:
 *         description: Updated listing
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/TemplateListing' }
 *       401: { description: Unauthorized }
 *       404: { description: Listing not found }
 *       409: { description: SKU conflict }
 *       500: { description: Server error }
 *   delete:
 *     tags: [Template Listings]
 *     summary: Delete a single listing
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: Listing deleted successfully }
 *       401: { description: Unauthorized }
 *       404: { description: Listing not found }
 *       500: { description: Server error }
 */
// Update listing
router.put('/:id', requireAuth, requireObjectId(), async (req, res) => {
  try {
    const listingData = req.body;

    // Convert customFields object to Map
    if (listingData.customFields && typeof listingData.customFields === 'object') {
      listingData.customFields = new Map(Object.entries(listingData.customFields));
    }

    listingData.updatedAt = Date.now();

    const listing = await TemplateListing.findByIdAndUpdate(
      req.params.id,
      listingData,
      { new: true, runValidators: true }
    )
      .populate('createdBy', 'name email')
      .populate('templateId');

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    res.json(listing);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A listing with this SKU already exists in this template' });
    }
    console.error('Error updating listing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete listing
router.delete('/:id', requireAuth, requireObjectId(), async (req, res) => {
  try {
    const listing = await TemplateListing.findByIdAndDelete(req.params.id);

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    res.json({ message: 'Listing deleted successfully' });
  } catch (error) {
    console.error('Error deleting listing:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/autofill-from-asin:
 *   post:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: ASIN autofill — single ASIN
 *     description: Fetches Amazon product data for one ASIN, applies the template's field configs and pricing rules, and returns the generated field values without persisting anything.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [asin, templateId]
 *             properties:
 *               asin:       { type: string, example: B01N5IB20Q }
 *               templateId: { type: string }
 *               sellerId:   { type: string }
 *               region:     { type: string, default: US }
 *     responses:
 *       200:
 *         description: Autofilled field data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:            { type: boolean }
 *                 asin:               { type: string }
 *                 autoFilledData:
 *                   type: object
 *                   properties:
 *                     coreFields:   { type: object }
 *                     customFields: { type: object }
 *                 amazonSource:
 *                   type: object
 *                   properties:
 *                     title:      { type: string }
 *                     brand:      { type: string }
 *                     price:      { type: number }
 *                     imageCount: { type: integer }
 *                 pricingCalculation: { type: object, nullable: true }
 *       400: { description: ASIN and templateId are required or automation not enabled }
 *       401: { description: Unauthorized }
 *       404: { description: Template not found }
 *       500: { description: Server error }
 */
// ASIN Autofill endpoint
router.post('/autofill-from-asin', requireAuth, async (req, res) => {
  try {
    const { asin, templateId, sellerId, region = 'US', overlayBadgeId = '' } = req.body;

    if (!asin || !templateId) {
      return res.status(400).json({
        error: 'ASIN and Template ID are required'
      });
    }

    // 1. Fetch effective template with automation config (includes seller overrides)
    const template = await getEffectiveTemplate(templateId, sellerId);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (!template.asinAutomation?.enabled) {
      return res.status(400).json({
        error: 'ASIN automation is not enabled for this template'
      });
    }

    // 1.5. Get seller-specific pricing config if sellerId is provided
    let pricingConfig = template.pricingConfig;
    if (sellerId) {
      const sellerConfig = await SellerPricingConfig.findOne({
        sellerId,
        templateId
      });
      if (sellerConfig) {
        pricingConfig = sellerConfig.pricingConfig;
      }
    }

    // 2. Fetch fresh Amazon data
    console.log(`Fetching Amazon data for ASIN: ${asin} (${region})`);
    const amazonData = await fetchAmazonData(asin, region);

    // 2.5. Badge the primary image. Needs a seller for the eBay picture upload,
    // so an autofill without sellerId simply keeps the original image.
    const seller = sellerId ? await Seller.findById(sellerId) : null;
    const overlayContext = seller ? await prepareOverlayContext(template, seller, overlayBadgeId, 'autofill-single') : null;
    const { data: stagedData, applied: overlayApplied } = await applyBatchOverlay(amazonData, overlayContext);

    // 3. Apply field configurations (AI + direct mappings)
    console.log(`Processing ${template.asinAutomation.fieldConfigs.length} field configs`);
    const aiRunContext = createAiRunContext('autofill-single');
    const { coreFields, customFields, pricingCalculation } = await applyFieldConfigs(
      stagedData,
      template.asinAutomation.fieldConfigs,
      pricingConfig,  // Use seller-specific or template default pricing config
      buildAiUsageContext(req, templateId, sellerId, aiRunContext)
    );

    // 4. Return auto-filled data (separated by type)
    res.json({
      success: true,
      asin,
      autoFilledData: {
        coreFields,
        customFields
      },
      overlayApplied,
      amazonSource: {
        title: amazonData.title,
        brand: amazonData.brand,
        price: amazonData.price,
        imageCount: amazonData.images ? amazonData.images.split(' | ').filter(url => url.trim()).length : 0
      },
      pricingCalculation: pricingCalculation || null
    });

  } catch (error) {
    console.error('ASIN autofill error:', error);
    res.status(500).json({
      error: error.message || 'Failed to fetch and process ASIN data'
    });
  }
});

/**
 * @swagger
 * /template-listings/bulk-autofill-from-asins:
 *   post:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: ASIN autofill — batch (up to 100 ASINs)
 *     description: |
 *       Processes up to 100 ASINs in parallel batches. Each result has a `status` of:
 *       - `success` — autofill data generated
 *       - `duplicate_updateable` — ASIN already in this template (returns existing data for editing)
 *       - `blocked` — ASIN in another seller template, or SKU conflict
 *       - `error` — scraping or AI processing failed
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [asins, templateId, sellerId]
 *             properties:
 *               asins:      { type: array, items: { type: string }, example: ["B01N5IB20Q", "B07K1RZWMC"] }
 *               templateId: { type: string }
 *               sellerId:   { type: string }
 *               region:     { type: string, default: US }
 *     responses:
 *       200:
 *         description: Batch autofill results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:        { type: boolean }
 *                 total:          { type: integer }
 *                 successful:     { type: integer }
 *                 failed:         { type: integer }
 *                 duplicates:     { type: integer }
 *                 blocked:        { type: integer }
 *                 processingTime: { type: string, example: "4.2s" }
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       asin:   { type: string }
 *                       status: { type: string, enum: [success, duplicate_updateable, blocked, error] }
 *                       autoFilledData: { type: object, nullable: true }
 *                       pricingCalculation: { type: object, nullable: true }
 *                       error:  { type: string, nullable: true }
 *       400: { description: Validation error or automation not enabled }
 *       401: { description: Unauthorized }
 *       404: { description: Template not found }
 *       500: { description: Server error }
 */
// Bulk auto-fill from multiple ASINs
router.post('/bulk-autofill-from-asins', requireAuth, async (req, res) => {
  try {
    const { asins, templateId, sellerId, region = 'US', overlayBadgeId = '' } = req.body;

    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      return res.status(400).json({
        error: 'ASINs array is required and must not be empty'
      });
    }

    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }

    // Validate batch size
    if (asins.length > 100) {
      return res.status(400).json({
        error: 'Maximum 100 ASINs allowed per batch'
      });
    }

    // Fetch effective template with automation config (includes seller overrides)
    const template = await getEffectiveTemplate(templateId, sellerId);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (!template.asinAutomation?.enabled) {
      return res.status(400).json({
        error: 'ASIN automation is not enabled for this template'
      });
    }

    // Get seller-specific pricing config if available
    let pricingConfig = template.pricingConfig;
    const sellerConfig = await SellerPricingConfig.findOne({
      sellerId,
      templateId
    });
    if (sellerConfig) {
      pricingConfig = sellerConfig.pricingConfig;
    }

    // Clean and deduplicate ASINs
    const cleanedAsins = [...new Set(
      asins.map(asin => asin.trim().toUpperCase()).filter(asin => asin.length > 0)
    )];

    console.log(`\n========== BULK AUTOFILL: ${cleanedAsins.length} ASINs ==========`);
    console.log(`Template: ${template.name || templateId}`);
    console.log(`Seller: ${sellerId}`);
    console.log(`AI Fields: ${template.asinAutomation.fieldConfigs.filter(c => c.source === 'ai' && c.enabled).length}`);

    // Check for existing ACTIVE listings with these ASINs across ALL templates for this seller
    const existingListings = await TemplateListing.find({
      sellerId,  // Check across all templates for this seller
      _asinReference: { $in: cleanedAsins },
      status: 'active'
    }).select('+_asinReference').lean();

    // Create maps for both current template and cross-template duplicates
    const existingInCurrentTemplate = new Map(); // Changed to Map to store full listing data
    const existingInOtherTemplates = new Map();

    existingListings.forEach(listing => {
      if (listing.templateId.toString() === templateId.toString()) {
        existingInCurrentTemplate.set(listing._asinReference, listing); // Store full listing
      } else {
        existingInOtherTemplates.set(listing._asinReference, listing.templateId);
      }
    });

    console.log(`Found ${existingInCurrentTemplate.size} ASINs in current template (will update)`);
    console.log(`Found ${existingInOtherTemplates.size} ASINs in other templates (will block)\n`);

    const overlaySeller = await Seller.findById(sellerId);
    const overlayContext = overlaySeller ? await prepareOverlayContext(template, overlaySeller, overlayBadgeId, 'bulk-autofill') : null;

    // Pre-generate all SKUs and check for collisions with existing SKUs
    const generatedSKUs = cleanedAsins.map(asin => ({
      asin,
      sku: generateSKUFromASIN(asin)
    }));

    // Check if any generated SKUs already exist (from both ASIN imports and SKU imports)
    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: generatedSKUs.map(item => item.sku) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id');

    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, {
        id: listing._id,
        asin: listing._asinReference
      }])
    );

    console.log(`Found ${existingSKUMap.size} SKU conflicts (will block)\n`);

    const startTime = Date.now();
    const results = [];

    // Process ASINs in batches of 20 (parallel within batch, parallel between batches)
    const batchSize = parseInt(process.env.BACKEND_BATCH_SIZE) || 20;
    const batches = [];
    for (let i = 0; i < cleanedAsins.length; i += batchSize) {
      batches.push(cleanedAsins.slice(i, i + batchSize));
    }

    console.log(`🚀 Processing ${batches.length} batches in parallel (${batchSize} ASINs per batch)...`);

    const aiRunContext = createAiRunContext('bulk-autofill');

    // Process all batches in parallel
    const batchPromises = batches.map(async (batch, batchIndex) => {
      const batchNum = batchIndex + 1;
      console.log(`  ⏳ Batch ${batchNum}/${batches.length}: Starting ${batch.length} ASINs...`);

      const batchPromises = batch.map(async (asin) => {
        // Check if ASIN exists in OTHER templates for this seller (block)
        if (existingInOtherTemplates.has(asin)) {
          return {
            asin,
            status: 'blocked',
            existingTemplateId: existingInOtherTemplates.get(asin).toString(),
            error: 'ASIN already exists for this seller in another template. Each ASIN can only be used once per seller.'
          };
        }

        // Check if ASIN already exists in CURRENT template (duplicate_updateable)
        if (existingInCurrentTemplate.has(asin)) {
          const existingListing = existingInCurrentTemplate.get(asin);
          const generatedSKU = generateSKUFromASIN(asin);

          const amazonData = await fetchAmazonData(asin, region, { forceRefresh: true });
          const { data: stagedData, mappings: overlayMappings } = await applyBatchOverlay(amazonData, overlayContext);
          const pricingCalculation = calculatePricingOnly(asin, amazonData.price, pricingConfig);
          const photoList = resolveSavedImageList(
            existingListing.itemPhotoUrl,
            overlayMappings,
            Array.isArray(stagedData?.images) ? stagedData.images : null
          );

          return {
            asin,
            status: 'duplicate_updateable',
            autoFilledData: {
              coreFields: {
                title: existingListing.title,
                // Saved fields reused as-is; swap the hosted images in directly.
                description: applyOverlayMapping(existingListing.description, overlayMappings),
                startPrice: pricingCalculation?.calculatedStartPrice ?? existingListing.startPrice,
                quantity: existingListing.quantity,
                itemPhotoUrl: photoList.value,
                conditionId: existingListing.conditionId || '',
                format: existingListing.format || '',
                duration: existingListing.duration || '',
                location: existingListing.location || ''
              },
              customFields: existingListing.customFields || {}
            },
            amazonSource: {
              title: amazonData.title,
              brand: amazonData.brand,
              price: amazonData.price,
              imageCount: Array.isArray(amazonData.images) ? amazonData.images.length : 0
            },
            pricingCalculation: pricingCalculation || null,
            sku: existingListing.customLabel || generatedSKU,
            _existingListingId: existingListing._id, // Track which listing to update
            warnings: [
              `This ASIN already exists in this template.`,
              existingListing.duplicateCount > 0
                ? `Previously updated ${existingListing.duplicateCount} time(s).`
                : `First time editing this ASIN.`,
              ...(overlayMappings?.length ? ['Main image badged; all images moved to eBay hosting.'] : []),
              ...(photoList.replaced
                ? ['Saved image list was out of date — replaced with the current Amazon images.']
                : [])
            ]
          };
        }

        // Check if generated SKU already exists (from ASIN imports or SKU imports)
        const generatedSKU = generateSKUFromASIN(asin);
        const existingSKU = existingSKUMap.get(generatedSKU);
        if (existingSKU) {
          return {
            asin,
            sku: generatedSKU,
            status: 'blocked',
            blockedReason: 'sku_conflict',
            existingListingId: existingSKU.id.toString(),
            error: existingSKU.asin
              ? `SKU ${generatedSKU} already exists for ASIN ${existingSKU.asin} in this template`
              : `SKU ${generatedSKU} already exists in this template (imported via SKU import)`
          };
        }

        try {
          // Fetch Amazon data
          const amazonData = await fetchAmazonData(asin, region);
          const { data: stagedData } = await applyBatchOverlay(amazonData, overlayContext);

          // Apply field configurations
          const { coreFields, customFields, pricingCalculation } = await applyFieldConfigs(
            stagedData,
            template.asinAutomation.fieldConfigs,
            pricingConfig,  // Use seller-specific or template default pricing config
            buildAiUsageContext(req, templateId, sellerId, aiRunContext)
          );

          return {
            asin,
            status: 'success',
            autoFilledData: {
              coreFields,
              customFields
            },
            amazonSource: {
              title: amazonData.title,
              brand: amazonData.brand,
              price: amazonData.price,
              imageCount: amazonData.images ? amazonData.images.split(' | ').filter(url => url.trim()).length : 0
            },
            pricingCalculation: pricingCalculation || null
          };
        } catch (error) {
          console.error(`\n❌ ERROR processing ASIN ${asin}:`);
          console.error(`   Message: ${error.message}`);
          console.error(`   Stack: ${error.stack?.split('\n').slice(0, 3).join('\n   ')}`);
          return {
            asin,
            status: 'error',
            error: error.message || 'Failed to fetch or process ASIN data'
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      console.log(`  ✅ Batch ${batchNum}/${batches.length}: Completed`);
      return batchResults;
    });

    // Wait for all batches to complete (use allSettled for resilience)
    const allBatchResults = await Promise.allSettled(batchPromises);

    // Flatten and collect all results
    allBatchResults.forEach((batchResult, batchIndex) => {
      if (batchResult.status === 'fulfilled') {
        results.push(...batchResult.value);
      } else {
        // Entire batch failed (rare) - mark all ASINs in batch as failed
        const batch = batches[batchIndex];
        console.error(`❌ Batch ${batchIndex + 1} completely failed:`, batchResult.reason);
        batch.forEach(asin => {
          results.push({
            asin,
            status: 'error',
            error: `Batch processing failed: ${batchResult.reason?.message || 'Unknown error'}`
          });
        });
      }
    });

    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const successful = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'error').length;
    const duplicates = results.filter(r => r.status === 'duplicate').length;
    const blocked = results.filter(r => r.status === 'blocked').length;

    console.log(`\n========== BULK AUTOFILL COMPLETE ==========`);
    console.log(`✅ Successful: ${successful}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`⏭️  Duplicates: ${duplicates}`);
    console.log(`🚫 Blocked: ${blocked}`);
    console.log(`⏱️  Total Time: ${processingTime}s`);
    console.log(`⚡ Avg per ASIN: ${(parseFloat(processingTime) / cleanedAsins.length).toFixed(2)}s`);
    console.log(`==========================================\n`);

    res.json({
      success: true,
      total: cleanedAsins.length,
      successful,
      failed,
      duplicates,
      blocked,
      results,
      processingTime: `${processingTime}s`
    });

  } catch (error) {
    console.error('Bulk ASIN autofill error:', error);
    res.status(500).json({
      error: error.message || 'Failed to process bulk ASIN autofill'
    });
  }
});

/**
 * @swagger
 * /template-listings/bulk-delete:
 *   post:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: Permanently delete multiple listings
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listingIds]
 *             properties:
 *               listingIds:
 *                 type: array
 *                 items: { type: string }
 *                 example: ["665abc...", "665def..."]
 *     responses:
 *       200:
 *         description: Delete result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:      { type: string, example: Listings deleted successfully }
 *                 deletedCount: { type: integer, example: 3 }
 *       400: { description: listingIds array is required }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Bulk update existing listings (used by Proof Read → List Directly flow)
// Bulk delete listings
router.post('/bulk-delete', requireAuth, async (req, res) => {
  try {
    const { listingIds } = req.body;

    if (!listingIds || !Array.isArray(listingIds) || listingIds.length === 0) {
      return res.status(400).json({ error: 'Listing IDs array is required' });
    }

    const result = await TemplateListing.deleteMany({
      _id: { $in: listingIds }
    });

    res.json({
      message: 'Listings deleted successfully',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error bulk deleting listings:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/bulk-create:
 *   post:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: Bulk create listings from autofill results (max 50)
 *     description: |
 *       Creates or reactivates up to 50 listings at once. Per-listing result status:
 *       - `created` — new listing saved
 *       - `reactivated` — existing inactive listing updated and reactivated
 *       - `skipped` — active duplicate (when skipDuplicates=true)
 *       - `blocked` — SKU conflict with existing active/draft listing
 *       - `failed` — validation or DB error
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, sellerId, listings]
 *             properties:
 *               templateId: { type: string }
 *               sellerId:   { type: string }
 *               listings:
 *                 type: array
 *                 items: { $ref: '#/components/schemas/TemplateListing' }
 *               options:
 *                 type: object
 *                 properties:
 *                   autoGenerateSKU: { type: boolean, default: true }
 *                   skipDuplicates:  { type: boolean, default: true }
 *     responses:
 *       200:
 *         description: Bulk create summary with per-listing results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:     { type: boolean }
 *                 total:       { type: integer }
 *                 created:     { type: integer }
 *                 reactivated: { type: integer }
 *                 failed:      { type: integer }
 *                 skipped:     { type: integer }
 *                 results:     { type: array, items: { type: object } }
 *                 errors:      { type: array, items: { type: object } }
 *       400: { description: Validation error or too many listings }
 *       401: { description: Unauthorized }
 *       404: { description: Seller or Template not found }
 *       500: { description: Server error }
 */
// Bulk create listings from auto-fill results
router.post('/bulk-create', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, listings, options = {}, reviewStats = {} } = req.body;

    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }

    // Validate seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({ error: 'Listings array is required' });
    }

    // Validate batch size
    if (listings.length > 50) {
      return res.status(400).json({
        error: 'Maximum 50 listings allowed per batch'
      });
    }

    const {
      autoGenerateSKU = true,
      skipDuplicates = true
    } = options;

    // Fetch effective template to get next SKU counter (includes seller overrides)
    const template = await getEffectiveTemplate(templateId, sellerId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const results = [];
    const errors = [];
    let skippedCount = 0;

    // Get existing ACTIVE SKUs to avoid duplicates
    const existingActiveSKUs = await TemplateListing.find({
      templateId,
      sellerId,
      status: 'active'
    }).distinct('customLabel');

    // Get existing INACTIVE listings for potential reactivation
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      status: 'inactive'
    }).select('+_asinReference');

    const inactiveMap = new Map(
      inactiveListings.map(l => [l.customLabel, l])
    );

    const skuSet = new Set(existingActiveSKUs);
    let skuCounter = Date.now();

    console.log(`📊 Pre-check: ${existingActiveSKUs.length} active SKUs, ${inactiveListings.length} inactive listings`);
    console.log(`📋 Inactive SKUs: ${Array.from(inactiveMap.keys()).join(', ')}`);

    // Pre-check for SKU conflicts with existing listings (including drafts from SKU imports)
    const potentialSKUs = listings
      .map(l => l.customLabel || (l._asinReference ? generateSKUFromASIN(l._asinReference) : null))
      .filter(sku => sku);

    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: potentialSKUs },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id').lean();

    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, {
        id: listing._id,
        asin: listing._asinReference
      }])
    );

    console.log(`🔍 SKU pre-check: ${existingSKUMap.size} SKU conflicts detected`);

    // Process each listing
    for (const listingData of listings) {
      try {
        // Validate required fields
        if (!listingData.title) {
          errors.push({
            asin: listingData._asinReference,
            error: 'Title is required',
            details: 'Missing required field: title'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'Title is required'
          });
          continue;
        }

        if (listingData.startPrice === undefined || listingData.startPrice === null) {
          errors.push({
            asin: listingData._asinReference,
            error: 'Start price is required',
            details: 'Missing required field: startPrice'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'Start price is required'
          });
          continue;
        }

        // Generate SKU if not provided
        let sku = listingData.customLabel;
        if (!sku && autoGenerateSKU) {
          // Generate SKU using GRW25 + last 5 chars of ASIN
          if (listingData._asinReference) {
            sku = generateSKUFromASIN(listingData._asinReference);
          } else {
            sku = `SKU-${skuCounter++}`;
          }

          // Check if generated SKU conflicts with existing (from ASIN or SKU imports)
          const existingSKU = existingSKUMap.get(sku);
          if (existingSKU) {
            errors.push({
              asin: listingData._asinReference,
              sku,
              error: existingSKU.asin
                ? `Generated SKU ${sku} already exists for ASIN ${existingSKU.asin}`
                : `Generated SKU ${sku} already exists (imported via SKU import)`,
              details: 'SKU conflict detected'
            });
            results.push({
              status: 'blocked',
              asin: listingData._asinReference,
              sku,
              blockedReason: 'sku_conflict',
              error: existingSKU.asin
                ? `SKU already exists for ASIN ${existingSKU.asin}`
                : `SKU already exists (imported via SKU import)`
            });
            console.log(`🚫 Blocked SKU conflict: ${sku}`);
            continue;
          }

          // Ensure uniqueness within current batch
          while (skuSet.has(sku)) {
            // If collision within batch, append timestamp suffix
            sku = `${generateSKUFromASIN(listingData._asinReference)}-${skuCounter++}`;
          }
        }

        if (!sku) {
          errors.push({
            asin: listingData._asinReference,
            error: 'SKU (Custom label) is required',
            details: 'No SKU provided and auto-generation disabled'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'SKU is required'
          });
          continue;
        }

        console.log(`🔍 Processing SKU: ${sku}, inInactiveMap: ${inactiveMap.has(sku)}, inActiveSet: ${skuSet.has(sku)}`);

        // Check if SKU exists as inactive - reactivate instead of create
        const inactiveListing = inactiveMap.get(sku);

        if (inactiveListing) {
          // Found an inactive listing with this SKU - reactivate it
          // Convert customFields object to Map
          const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
            ? new Map(Object.entries(listingData.customFields))
            : new Map();

          // Update existing inactive listing
          Object.assign(inactiveListing, {
            ...listingData,
            customLabel: sku,
            customFields: customFieldsMap,
            templateId,
            sellerId,
            status: 'active',
            updatedAt: Date.now()
          });

          await inactiveListing.save();
          skuSet.add(sku);

          results.push({
            status: 'reactivated',
            listing: inactiveListing.toObject(),
            asin: listingData._asinReference,
            sku
          });

          console.log(`✅ Reactivated: ${sku}`);
          continue;
        }

        // Check for duplicate SKU in active listings (within this batch or existing)
        if (skuSet.has(sku)) {
          if (skipDuplicates) {
            skippedCount++;
            results.push({
              status: 'skipped',
              asin: listingData._asinReference,
              sku,
              error: 'Duplicate SKU (active listing exists)'
            });
            console.log(`⏭️ Skipped duplicate: ${sku}`);
            continue;
          } else {
            // Make SKU unique by appending suffix
            const baseSKU = sku;
            let suffix = 1;

            do {
              sku = `${baseSKU}-${suffix++}`;
            } while (skuSet.has(sku) || inactiveMap.has(sku));

            console.log(`SKU collision detected: ${baseSKU} → ${sku}`);
          }
        }

        // Convert customFields object to Map
        const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
          ? new Map(Object.entries(listingData.customFields))
          : new Map();

        // Create new listing
        const listing = new TemplateListing({
          ...listingData,
          customLabel: sku,
          customFields: customFieldsMap,
          templateId,
          sellerId,
          status: 'active',
          createdBy: req.user.userId
        });

        await listing.save();
        skuSet.add(sku);

        results.push({
          status: 'created',
          listing: listing.toObject(),
          asin: listingData._asinReference,
          sku
        });

      } catch (error) {
        console.error('Error creating listing:', error);

        if (error.code === 11000) {
          // Duplicate key error
          skippedCount++;
          results.push({
            status: 'skipped',
            asin: listingData._asinReference,
            error: 'Duplicate SKU'
          });
        } else {
          errors.push({
            asin: listingData._asinReference,
            error: error.message,
            details: error.toString()
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: error.message
          });
        }
      }
    }

    const created = results.filter(r => r.status === 'created').length;
    const reactivated = results.filter(r => r.status === 'reactivated').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const savedFromReview = created + updated + reactivated;
    const savedRunCounts = await recordReviewSaveCounts({
      listings,
      results,
      templateId,
      sellerId,
      userId: req.user.userId,
      dismissedByRunId: Array.isArray(reviewStats.dismissedByRunId) ? reviewStats.dismissedByRunId : []
    });

    console.log(`Bulk create completed: ${created} created, ${reactivated} reactivated, ${failed} failed, ${skippedCount} skipped`);

    res.json({
      success: true,
      total: listings.length,
      created,
      reactivated,
      failed,
      skipped: skippedCount,
      savedFromReview,
      savedRunCounts,
      results,
      errors
    });

  } catch (error) {
    console.error('Bulk create error:', error);
    res.status(500).json({
      error: error.message || 'Failed to bulk create listings'
    });
  }
});

/**
 * @swagger
 * /template-listings/bulk-preview:
 *   post:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: Bulk ASIN preview — REST (non-streaming)
 *     description: Synchronous version of `bulk-preview-stream`. Processes up to 100 ASINs and returns all results at once (no SSE). Suitable for small batches or environments where SSE is unavailable.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, sellerId, asins]
 *             properties:
 *               templateId: { type: string }
 *               sellerId:   { type: string }
 *               asins:
 *                 type: array
 *                 items: { type: string }
 *                 example: ["B01N5IB20Q", "B07K1RZWMC"]
 *               region: { type: string, default: US }
 *     responses:
 *       200:
 *         description: Array of preview items
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 *       400: { description: Validation error or too many ASINs }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Bulk preview: Process ASINs and return preview data (no save to database)
router.post('/bulk-preview', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, asins, region = 'US', overlayBadgeId = '' } = req.body;

    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }

    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      return res.status(400).json({ error: 'ASINs array is required' });
    }

    // Validate batch size
    if (asins.length > 100) {
      return res.status(400).json({
        error: 'Maximum 100 ASINs allowed per batch'
      });
    }

    // Validate seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    // Fetch effective template (includes seller overrides)
    const template = await getEffectiveTemplate(templateId, sellerId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (!template.asinAutomation?.enabled) {
      return res.status(400).json({
        error: 'ASIN automation is not enabled for this template'
      });
    }

    // Get seller-specific pricing config if available
    let pricingConfig = template.pricingConfig;
    if (sellerId) {
      const sellerConfig = await SellerPricingConfig.findOne({
        sellerId,
        templateId
      });
      if (sellerConfig) {
        pricingConfig = sellerConfig.pricingConfig;
      }
    }

    console.log(`💰 Pricing config enabled: ${pricingConfig?.enabled}, multiplier: ${pricingConfig?.multiplier}`);
    if (pricingConfig?.enabled) {
      console.log(`   Desired profit: ${pricingConfig.desiredProfit} INR`);
      console.log(`   Profit tiers: ${pricingConfig.profitTiers?.length || 0} configured`);
      if (pricingConfig.profitTiers?.length > 0) {
        pricingConfig.profitTiers.forEach((tier, idx) => {
          console.log(`     Tier ${idx + 1}: $${tier.minCost}-$${tier.maxCost} → +${tier.profit} INR`);
        });
      }
    }
    console.log(`📋 Field configs: ${template.asinAutomation.fieldConfigs.length} total`);

    // Log field config breakdown
    const coreConfigs = template.asinAutomation.fieldConfigs.filter(c => c.fieldType === 'core');
    const customConfigs = template.asinAutomation.fieldConfigs.filter(c => c.fieldType === 'custom');
    const aiConfigs = template.asinAutomation.fieldConfigs.filter(c => c.source === 'ai');
    const directConfigs = template.asinAutomation.fieldConfigs.filter(c => c.source === 'direct');

    console.log(`   Core: ${coreConfigs.length}, Custom: ${customConfigs.length}`);
    console.log(`   AI: ${aiConfigs.length}, Direct: ${directConfigs.length}`);
    console.log(`   Custom field names: ${customConfigs.map(c => c.ebayField).join(', ')}`);

    const previewItems = [];
    const errors = [];

    // Get existing ACTIVE SKUs to detect duplicates (ONCE per request, not per ASIN)
    const existingActiveSKUs = await TemplateListing.find({
      templateId,
      sellerId,
      status: 'active'
    }).lean().distinct('customLabel');

    const skuSet = new Set(existingActiveSKUs);

    // Check for existing ASINs across ALL templates for this seller
    const existingAsinListings = await TemplateListing.find({
      sellerId,
      _asinReference: { $in: asins },
      status: 'active'
    }).select('_asinReference templateId').lean();

    // Create maps for both current template and cross-template ASIN duplicates
    const asinInCurrentTemplate = new Set();
    const asinInOtherTemplates = new Map(); // ASIN -> templateId

    existingAsinListings.forEach(listing => {
      if (listing.templateId.toString() === templateId.toString()) {
        asinInCurrentTemplate.add(listing._asinReference);
      } else {
        asinInOtherTemplates.set(listing._asinReference, listing.templateId);
      }
    });

    // Pre-fetch template names for cross-template ASINs (for user-friendly warnings)
    const otherTemplateIds3 = [...new Set([...asinInOtherTemplates.values()].map(id => id.toString()))];
    const otherTemplateNameMap3 = new Map();
    if (otherTemplateIds3.length > 0) {
      const otherTpls3 = await ListingTemplate.find({ _id: { $in: otherTemplateIds3 } }).select('name').lean();
      otherTpls3.forEach(t => otherTemplateNameMap3.set(t._id.toString(), t.name));
    }

    console.log(`🔍 ASIN Check: ${asinInCurrentTemplate.size} in current template, ${asinInOtherTemplates.size} in other templates`);

    // Pre-generate all SKUs and check for SKU collisions
    const generatedSKUs = asins.map(asin => ({
      asin,
      sku: generateSKUFromASIN(asin)
    }));

    // Check if any generated SKUs already exist (from both ASIN imports and SKU imports)
    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: generatedSKUs.map(item => item.sku) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id').lean();

    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, {
        id: listing._id,
        asin: listing._asinReference
      }])
    );

    console.log(`🔍 SKU Check: ${existingSKUMap.size} SKU conflicts detected`);

    console.log(`🚀 Processing ${asins.length} ASINs in parallel...`);

    const aiRunContext = createAiRunContext('bulk-preview');
    const overlayContext = await prepareOverlayContext(template, seller, overlayBadgeId, 'bulk-preview');

    // Process ALL ASINs in parallel using Promise.allSettled
    const asinPromises = asins.map(async (asin) => {
      try {
        console.log(`📦 Processing ASIN for preview: ${asin}`);

        // If ASIN exists in another template, note warning but continue with generation
        const crossTemplateWarning3 = asinInOtherTemplates.has(asin)
          ? `This ASIN also exists in template "${otherTemplateNameMap3.get(asinInOtherTemplates.get(asin)?.toString()) || 'another template'}"`
          : null;

        // Generate SKU early for collision check
        const sku = generateSKUFromASIN(asin);

        // Check if generated SKU already exists (from ASIN imports or SKU imports)
        const existingSKU = existingSKUMap.get(sku);
        if (existingSKU) {
          const errorItem = {
            id: `preview-${asin}`,
            asin,
            sku,
            sourceData: null,
            generatedListing: null,
            pricingCalculation: null,
            warnings: [],
            errors: [existingSKU.asin
              ? `SKU ${sku} already exists for ASIN ${existingSKU.asin} in this template`
              : `SKU ${sku} already exists in this template (imported via SKU import)`
            ],
            status: 'blocked',
            blockedReason: 'sku_conflict',
            existingListingId: existingSKU.id.toString()
          };

          return {
            success: false,
            item: errorItem,
            error: `SKU conflict`
          };
        }

        // Fetch Amazon data
        const amazonData = await fetchAmazonData(asin, region);
        const { data: stagedData } = await applyBatchOverlay(amazonData, overlayContext);

        // Apply field configurations
        const { coreFields, customFields, pricingCalculation } =
          await applyFieldConfigs(stagedData, template.asinAutomation.fieldConfigs, pricingConfig, buildAiUsageContext(req, templateId, sellerId, aiRunContext));

        // Apply template core field defaults as base layer (autofilled fields override these)
        const mergedCoreFields = {
          ...(template.coreFieldDefaults || {}),
          ...coreFields
        };

        // Apply custom column default values for missing fields
        if (template?.customColumns && template.customColumns.length > 0) {
          template.customColumns.forEach(col => {
            if (col.defaultValue && !customFields[col.name]) {
              customFields[col.name] = col.defaultValue;
              console.log(`✨ Applied column default for ${col.name}: ${col.defaultValue}`);
            }
          });
        }

        console.log(`✅ Generated fields for ${asin}:`);
        console.log(`   Core fields: ${Object.keys(mergedCoreFields).join(', ')}`);
        console.log(`   Custom fields: ${Object.keys(customFields).join(', ')}`);

        // SKU already generated earlier for collision check

        // Check for warnings
        const warnings = [];
        if (crossTemplateWarning3) warnings.push(crossTemplateWarning3);
        const validationErrors = [];

        if (!mergedCoreFields.title) {
          validationErrors.push('Missing required field: title');
        }

        if (mergedCoreFields.startPrice === undefined || mergedCoreFields.startPrice === null || mergedCoreFields.startPrice === '') {
          if (pricingConfig?.enabled) {
            if (pricingCalculation?.error) {
              validationErrors.push(`Failed to calculate startPrice: ${pricingCalculation.error}`);
            } else {
              validationErrors.push('Pricing calculator enabled but startPrice not generated');
            }
          } else {
            validationErrors.push('Missing required field: startPrice (no pricing config or field mapping)');
          }
          console.error(`❌ [ASIN: ${asin}] startPrice validation failed. Value: ${mergedCoreFields.startPrice}, Pricing Config Enabled: ${pricingConfig?.enabled}, Error: ${pricingCalculation?.error || 'none'}`);
        } else {
          console.log(`✅ [ASIN: ${asin}] startPrice validated: $${mergedCoreFields.startPrice}`);
        }

        if (skuSet.has(sku)) {
          warnings.push('Duplicate SKU - will be skipped or replace existing');
        }

        // Check if ASIN already exists in CURRENT template (warning only)
        if (asinInCurrentTemplate.has(asin)) {
          warnings.push('ASIN already exists in this template - will be skipped during save');
        }

        // Check for missing important fields
        if (!mergedCoreFields.description) {
          warnings.push('Missing description');
        }

        previewItems.push({
          id: `preview-${asin}`,
          asin,
          sku,
          sourceData: {
            title: amazonData.title,
            brand: amazonData.brand,
            price: amazonData.price,
            description: amazonData.description,
            images: amazonData.images,
            color: amazonData.color,
            compatibility: amazonData.compatibility,
            productInfo: amazonData.productInfo || null,
            rawData: amazonData.rawData
          },
          generatedListing: {
            ...mergedCoreFields,
            customLabel: sku,
            customFields,
            _asinReference: asin,
            _aiRunId: aiRunContext.aiRunId
          },
          pricingCalculation,
          warnings,
          errors: validationErrors,
          status: validationErrors.length > 0 ? 'error' : (warnings.length > 0 ? 'warning' : 'success')
        });

        return {
          success: true,
          item: previewItems[previewItems.length - 1]
        };

      } catch (error) {
        console.error(`❌ Error processing ASIN ${asin}:`, error);

        const errorItem = {
          id: `preview-${asin}`,
          asin,
          sku: generateSKUFromASIN(asin),
          sourceData: null,
          generatedListing: null,
          pricingCalculation: null,
          warnings: [],
          errors: [error.message],
          status: 'error'
        };

        return {
          success: false,
          item: errorItem,
          error: error.message
        };
      }
    });

    // Wait for all ASINs to complete (parallel processing)
    const results = await Promise.allSettled(asinPromises);

    // Collect all items from results
    const finalItems = [];
    const finalErrors = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        finalItems.push(result.value.item);
        if (!result.value.success) {
          finalErrors.push({
            asin: asins[index],
            error: result.value.error
          });
        }
      } else {
        // Promise rejected (shouldn't happen with try/catch, but handle it)
        const asin = asins[index];
        finalErrors.push({
          asin,
          error: result.reason?.message || 'Unknown error'
        });
        finalItems.push({
          id: `preview-${asin}`,
          asin,
          sku: generateSKUFromASIN(asin),
          sourceData: null,
          generatedListing: null,
          pricingCalculation: null,
          warnings: [],
          errors: [result.reason?.message || 'Unknown error'],
          status: 'error'
        });
      }
    });

    console.log(`✅ Parallel processing complete: ${finalItems.length} items processed`);

    res.json({
      success: true,
      items: finalItems,
      errors: finalErrors,
      summary: {
        total: asins.length,
        successful: finalItems.filter(i => i.status !== 'error').length,
        failed: finalErrors.length,
        warnings: finalItems.filter(i => i.status === 'warning').length
      }
    });

  } catch (error) {
    console.error('Bulk preview error:', error);
    res.status(500).json({
      error: error.message || 'Failed to generate preview'
    });
  }
});

/**
 * @swagger
 * /template-listings/bulk-save:
 *   post:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: Bulk save reviewed/edited preview listings to the database
 *     description: Persists an array of reviewed listing objects. Applies the same deduplication and reactivation logic as `bulk-create`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, sellerId, listings]
 *             properties:
 *               templateId: { type: string }
 *               sellerId:   { type: string }
 *               listings:
 *                 type: array
 *                 items: { $ref: '#/components/schemas/TemplateListing' }
 *               options: { type: object }
 *     responses:
 *       200:
 *         description: Bulk save summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:     { type: boolean }
 *                 total:       { type: integer }
 *                 created:     { type: integer }
 *                 reactivated: { type: integer }
 *                 failed:      { type: integer }
 *                 skipped:     { type: integer }
 *                 results:     { type: array, items: { type: object } }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Bulk save: Save reviewed/edited listings to database
router.post('/bulk-save', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, listings, options = {}, reviewStats = {} } = req.body;

    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }

    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({ error: 'Listings array is required' });
    }

    // Validate seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    const {
      skipDuplicates = true
    } = options;

    const results = [];
    const errors = [];
    let skippedCount = 0;

    // Get existing ACTIVE SKUs
    const existingActiveSKUs = await TemplateListing.find({
      templateId,
      sellerId,
      status: 'active'
    }).distinct('customLabel');

    // Get existing INACTIVE listings for potential reactivation
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      status: 'inactive'
    }).select('+_asinReference');

    const inactiveMap = new Map(
      inactiveListings.map(l => [l.customLabel, l])
    );

    const skuSet = new Set(existingActiveSKUs);

    console.log(`📊 Bulk save: ${existingActiveSKUs.length} active SKUs, ${inactiveListings.length} inactive listings`);

    // Check for cross-template ASIN duplicates
    const asinsToSave = listings
      .map(l => l._asinReference)
      .filter(asin => asin && asin.trim());

    const crossTemplateAsins = await TemplateListing.find({
      sellerId,
      templateId: { $ne: templateId }, // Different template
      _asinReference: { $in: asinsToSave },
      status: 'active'
    }).select('_asinReference templateId').lean();

    const crossTemplateAsinMap = new Map(
      crossTemplateAsins.map(l => [l._asinReference, l.templateId])
    );

    console.log(`🚫 Found ${crossTemplateAsinMap.size} ASINs already in other templates`);

    // Pre-check all SKUs for collisions (including those from SKU imports)
    const skusToSave = listings
      .map(l => l.customLabel)
      .filter(sku => sku && sku.trim());

    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skusToSave },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id').lean();

    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, {
        id: listing._id,
        asin: listing._asinReference
      }])
    );

    console.log(`🔍 SKU pre-check: ${existingSKUMap.size} SKU conflicts detected`);

    // Process each listing
    for (const listingData of listings) {
      try {
        // Cross-template ASIN duplicates are allowed; user was notified via warning during preview

        // Check if this is a duplicate update request
        if (listingData._isDuplicateUpdate && listingData._existingListingId) {
          const existingListing = await TemplateListing.findById(listingData._existingListingId).select('+_asinReference');

          if (!existingListing) {
            errors.push({
              asin: listingData._asinReference,
              error: 'Existing listing not found for update'
            });
            results.push({
              status: 'failed',
              asin: listingData._asinReference,
              error: 'Existing listing not found'
            });
            continue;
          }

          // Convert customFields
          const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
            ? new Map(Object.entries(listingData.customFields))
            : new Map();

          // Compute new count-based SKU fresh at save time
          const dupAsinDoc = await AsinDirectory.findOne({ asin: listingData._asinReference }).select('listingCount').lean();
          const newSKU = generateSKUWithCount(listingData._asinReference, dupAsinDoc?.listingCount || 0);

          // Update existing listing with new data
          // Build update object - only overwrite fields that are explicitly provided
          // (guards against undefined wiping values that weren't sent from the frontend)
          const updateData = {
            customLabel: newSKU,
            customFields: customFieldsMap,
            pendingRedownload: true,
            duplicateCount: (existingListing.duplicateCount || 0) + 1,
            lastDuplicateAttempt: Date.now(),
            scheduleTime: '',
            updatedAt: Date.now(),
            aiRunId: listingData.aiRunId || listingData._aiRunId
          };
          // Persist fresh Amazon source price if supplied (Option B ran) so next duplication uses Option A
          if (listingData._amazonSourcePrice) {
            updateData._amazonSourcePrice = listingData._amazonSourcePrice;
          }
          const overwritableFields = ['title', 'description', 'startPrice', 'quantity', 'itemPhotoUrl', 'conditionId', 'format', 'duration', 'location'];
          for (const field of overwritableFields) {
            if (listingData[field] !== undefined && listingData[field] !== null && listingData[field] !== '') {
              updateData[field] = listingData[field];
            }
          }
          Object.assign(existingListing, updateData);

          await existingListing.save();

          // Increment AsinDirectory listing count
          await AsinDirectory.updateOne({ asin: listingData._asinReference }, { $inc: { listingCount: 1 } });

          results.push({
            status: 'updated',
            listing: existingListing.toObject(),
            asin: listingData._asinReference,
            sku: newSKU,
            duplicateCount: existingListing.duplicateCount
          });

          console.log(`✅ Updated duplicate ASIN ${listingData._asinReference} (count: ${existingListing.duplicateCount}, newSKU: ${newSKU})`);
          continue;
        }

        // Validate required fields
        if (!listingData.title) {
          errors.push({
            asin: listingData._asinReference,
            error: 'Title is required'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'Title is required'
          });
          continue;
        }

        if (listingData.startPrice === undefined || listingData.startPrice === null) {
          errors.push({
            asin: listingData._asinReference,
            error: 'Start price is required'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'Start price is required'
          });
          continue;
        }

        // Compute count-based SKU fresh at save time
        let sku = listingData.customLabel;
        if (listingData._asinReference) {
          const newAsinDoc = await AsinDirectory.findOne({ asin: listingData._asinReference }).select('listingCount').lean();
          sku = generateSKUWithCount(listingData._asinReference, newAsinDoc?.listingCount || 0);
        }

        if (!sku) {
          errors.push({
            asin: listingData._asinReference,
            error: 'SKU (Custom label) is required'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'SKU is required'
          });
          continue;
        }

        console.log(`🔍 Saving SKU: ${sku}`);

        // Check if SKU already exists (from ASIN imports or SKU imports)
        const existingSKU = existingSKUMap.get(sku);
        if (existingSKU && existingSKU.id) {
          errors.push({
            asin: listingData._asinReference,
            sku,
            error: existingSKU.asin
              ? `SKU ${sku} already exists for ASIN ${existingSKU.asin}`
              : `SKU ${sku} already exists (imported via SKU import)`
          });
          results.push({
            status: 'blocked',
            asin: listingData._asinReference,
            sku,
            blockedReason: 'sku_conflict',
            existingListingId: existingSKU.id.toString(),
            error: existingSKU.asin
              ? `SKU already exists for ASIN ${existingSKU.asin}`
              : `SKU already exists (imported via SKU import)`
          });
          console.log(`🚫 Blocked SKU conflict: ${sku}`);
          continue;
        }

        // Check if SKU exists as inactive - reactivate
        const inactiveListing = inactiveMap.get(sku);

        if (inactiveListing) {
          const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
            ? new Map(Object.entries(listingData.customFields))
            : new Map();

          Object.assign(inactiveListing, {
            ...listingData,
            customLabel: sku,
            customFields: customFieldsMap,
            templateId,
            sellerId,
            status: 'active',
            updatedAt: Date.now(),
            aiRunId: listingData.aiRunId || listingData._aiRunId
          });

          await inactiveListing.save();
          skuSet.add(sku);

          results.push({
            status: 'reactivated',
            listing: inactiveListing.toObject(),
            asin: listingData._asinReference,
            sku
          });

          console.log(`✅ Reactivated: ${sku}`);
          continue;
        }

        // Check for duplicate SKU
        if (skuSet.has(sku)) {
          if (skipDuplicates) {
            skippedCount++;
            results.push({
              status: 'skipped',
              asin: listingData._asinReference,
              sku,
              reason: 'Duplicate SKU'
            });
            console.log(`⏭️ Skipped duplicate: ${sku}`);
            continue;
          } else {
            errors.push({
              asin: listingData._asinReference,
              error: 'Duplicate SKU',
              sku
            });
            results.push({
              status: 'failed',
              asin: listingData._asinReference,
              error: 'Duplicate SKU'
            });
            continue;
          }
        }

        // Convert customFields object to Map
        const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
          ? new Map(Object.entries(listingData.customFields))
          : new Map();

        // Create new listing
        const listing = new TemplateListing({
          ...listingData,
          customLabel: sku,
          customFields: customFieldsMap,
          templateId,
          sellerId,
          status: 'active',
          createdBy: req.user.userId,
          aiRunId: listingData.aiRunId || listingData._aiRunId
        });

        await listing.save();
        skuSet.add(sku);

        // Increment AsinDirectory listing count
        if (listingData._asinReference) {
          await AsinDirectory.updateOne({ asin: listingData._asinReference }, { $inc: { listingCount: 1 } });
        }

        results.push({
          status: 'created',
          listing: listing.toObject(),
          asin: listingData._asinReference,
          sku
        });

        console.log(`✅ Created: ${sku}`);

      } catch (error) {
        console.error('Error saving listing:', error);

        if (error.code === 11000) {
          skippedCount++;
          results.push({
            status: 'skipped',
            asin: listingData._asinReference,
            error: 'Duplicate SKU'
          });
        } else {
          errors.push({
            asin: listingData._asinReference,
            error: error.message
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: error.message
          });
        }
      }
    }

    const created = results.filter(r => r.status === 'created').length;
    const updated = results.filter(r => r.status === 'updated').length;
    const reactivated = results.filter(r => r.status === 'reactivated').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const savedFromReview = created + updated + reactivated;
    const savedRunCounts = await recordReviewSaveCounts({
      listings,
      results,
      templateId,
      sellerId,
      userId: req.user.userId,
      dismissedByRunId: Array.isArray(reviewStats.dismissedByRunId) ? reviewStats.dismissedByRunId : []
    });

    console.log(`✅ Bulk save completed: ${created} created, ${updated} updated, ${reactivated} reactivated, ${failed} failed, ${skippedCount} skipped`);

    res.json({
      success: true,
      total: listings.length,
      created,
      updated,
      reactivated,
      failed,
      skipped: skippedCount,
      results,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('Bulk save error:', error);
    res.status(500).json({
      error: error.message || 'Failed to bulk save listings'
    });
  }
});

/**
 * @swagger
 * /template-listings/bulk-import-asins:
 *   post:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: Quick ASIN import (no Amazon data fetch)
 *     description: Creates draft `TemplateListing` stubs for each ASIN without scraping Amazon. Useful for pre-loading a batch before running autofill later.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, sellerId, asins]
 *             properties:
 *               templateId: { type: string }
 *               sellerId:   { type: string }
 *               asins:
 *                 type: array
 *                 items: { type: string }
 *                 example: ["B01N5IB20Q", "B07K1RZWMC"]
 *     responses:
 *       200:
 *         description: Import result summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:  { type: boolean }
 *                 total:    { type: integer }
 *                 imported: { type: integer }
 *                 skipped:  { type: integer }
 *                 results:  { type: array, items: { type: object } }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       404: { description: Template or Seller not found }
 *       500: { description: Server error }
 */
// Bulk import ASINs (quick import without fetching Amazon data)
router.post('/bulk-import-asins', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, asins } = req.body;

    // Validate required fields
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }

    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      return res.status(400).json({ error: 'ASINs array is required and must not be empty' });
    }

    console.log('📦 Bulk import request:', { templateId, sellerId, asinCount: asins.length });

    // Validate template (with seller overrides) and seller exist
    const [template, seller] = await Promise.all([
      getEffectiveTemplate(templateId, sellerId),
      Seller.findById(sellerId)
    ]);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    // Get existing SKUs for this seller to avoid duplicates
    const existingSKUs = await TemplateListing.find({
      templateId,
      sellerId,
      status: { $in: ['active', 'draft'] }
    }).distinct('customLabel');

    const skuSet = new Set(existingSKUs);
    let skuCounter = Date.now();

    // Process ASINs and generate SKUs
    const listingsToCreate = [];
    const skippedASINs = [];

    for (const asin of asins) {
      const cleanASIN = asin.trim().toUpperCase();

      // Basic ASIN validation (should start with B0 and be 10 chars)
      if (!cleanASIN || cleanASIN.length !== 10 || !cleanASIN.startsWith('B0')) {
        skippedASINs.push({
          asin: cleanASIN,
          reason: 'Invalid ASIN format'
        });
        continue;
      }

      // Generate SKU using GRW25 + last 5 chars
      let sku = generateSKUFromASIN(cleanASIN);

      // Check for duplicates and make unique
      if (skuSet.has(sku)) {
        // If collision, append timestamp suffix
        const baseSKU = sku;
        let suffix = 1;

        do {
          sku = `${baseSKU}-${suffix++}`;
        } while (skuSet.has(sku));

        console.log(`SKU collision detected: ${baseSKU} → ${sku}`);
      }

      skuSet.add(sku);

      // Create minimal listing object
      listingsToCreate.push({
        templateId,
        sellerId,
        _asinReference: cleanASIN,
        customLabel: sku,
        amazonLink: `https://www.amazon.com/dp/${cleanASIN}`,
        title: `Imported Product - ${cleanASIN}`,
        startPrice: 0.01, // Minimum placeholder
        quantity: 1,
        status: 'active',
        conditionId: '1000-New',
        format: 'FixedPrice',
        duration: 'GTC',
        location: 'UnitedStates',
        createdBy: req.user.userId
      });
    }

    console.log(`📊 Prepared ${listingsToCreate.length} listings, ${skippedASINs.length} skipped (validation)`);

    // Check for existing listings with same ASINs in active/draft status
    const existingByASIN = await TemplateListing.find({
      templateId,
      sellerId,
      _asinReference: { $in: listingsToCreate.map(l => l._asinReference) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference');

    const existingASINs = new Set(existingByASIN.map(l => l._asinReference));

    console.log(`🔍 Found ${existingASINs.size} existing active/draft ASINs in database`);

    // Check for inactive listings that can be reactivated
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      _asinReference: { $in: listingsToCreate.map(l => l._asinReference) },
      status: 'inactive'
    }).select('customLabel _asinReference');

    const inactiveASINMap = new Map(inactiveListings.map(l => [l._asinReference, l]));

    console.log(`🔄 Found ${inactiveASINMap.size} inactive ASINs that can be reactivated`);

    // Separate listings into: reactivate, skip (already active), or create new
    const listingsToReactivate = [];
    const newListings = [];

    for (const listing of listingsToCreate) {
      if (existingASINs.has(listing._asinReference)) {
        // Already exists as active/draft - skip
        const existing = existingByASIN.find(e => e._asinReference === listing._asinReference);
        skippedASINs.push({
          asin: listing._asinReference,
          sku: listing.customLabel,
          reason: `Already exists in database (SKU: ${existing.customLabel})`
        });
      } else if (inactiveASINMap.has(listing._asinReference)) {
        // Exists as inactive - reactivate
        listingsToReactivate.push({
          existing: inactiveASINMap.get(listing._asinReference),
          newData: listing
        });
      } else {
        // Doesn't exist - create new
        newListings.push(listing);
      }
    }

    console.log(`✅ ${newListings.length} new listings to insert, ${listingsToReactivate.length} to reactivate`);

    // Reactivate inactive listings
    let reactivatedCount = 0;
    if (listingsToReactivate.length > 0) {
      const reactivateOps = listingsToReactivate.map(({ existing, newData }) => ({
        updateOne: {
          filter: { _id: existing._id },
          update: {
            $set: {
              ...newData,
              status: 'active',
              scheduleTime: '',
              downloadBatchId: null,
              downloadedAt: null,
              downloadBatchNumber: null,
              pendingRedownload: false,
              updatedAt: Date.now()
            }
          }
        }
      }));

      const reactivateResult = await TemplateListing.bulkWrite(reactivateOps);
      reactivatedCount = reactivateResult.modifiedCount || 0;
      console.log(`🔄 Reactivated ${reactivatedCount} inactive listings`);
    }

    // Bulk insert new listings
    let importedCount = 0;
    let insertErrors = [];

    if (newListings.length > 0) {
      try {
        const result = await TemplateListing.insertMany(newListings, {
          ordered: false, // Continue on error
          rawResult: true
        });

        importedCount = result.insertedCount || newListings.length;

        // Handle any write errors
        if (result.writeErrors && result.writeErrors.length > 0) {
          result.writeErrors.forEach(err => {
            const listing = newListings[err.index];
            if (err.code === 11000) {
              skippedASINs.push({
                asin: listing._asinReference,
                sku: listing.customLabel,
                reason: 'Duplicate key error'
              });
            } else {
              insertErrors.push({
                asin: listing._asinReference,
                sku: listing.customLabel,
                error: err.errmsg
              });
            }
          });
        }
      } catch (error) {
        // Handle bulk insert errors
        if (error.code === 11000 && error.writeErrors) {
          importedCount = error.insertedDocs ? error.insertedDocs.length : 0;

          error.writeErrors.forEach(err => {
            const listing = newListings[err.index];
            skippedASINs.push({
              asin: listing._asinReference,
              sku: listing.customLabel,
              reason: 'Duplicate key error'
            });
          });
        } else {
          throw error;
        }
      }
    }

    console.log(`🎉 Import complete: ${importedCount} new, ${reactivatedCount} reactivated, ${skippedASINs.length} skipped`);

    res.json({
      total: asins.length,
      imported: importedCount,
      reactivated: reactivatedCount,
      skipped: skippedASINs.length,
      skippedDetails: skippedASINs,
      errors: insertErrors.length > 0 ? insertErrors : undefined
    });

  } catch (error) {
    console.error('❌ Bulk import error:', error);
    res.status(500).json({
      error: error.message || 'Failed to bulk import ASINs'
    });
  }
});

/**
 * @swagger
 * /template-listings/bulk-import-skus:
 *   post:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: Quick SKU import (no Amazon data fetch)
 *     description: Creates draft `TemplateListing` stubs for each SKU string without scraping Amazon. Useful for importing eBay SKU lists that need data filled later.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, sellerId, skus]
 *             properties:
 *               templateId: { type: string }
 *               sellerId:   { type: string }
 *               skus:
 *                 type: array
 *                 items: { type: string }
 *                 example: ["GRW25B20Q", "GRW25K1RZ"]
 *     responses:
 *       200:
 *         description: Import result summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:  { type: boolean }
 *                 total:    { type: integer }
 *                 imported: { type: integer }
 *                 skipped:  { type: integer }
 *                 results:  { type: array, items: { type: object } }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       404: { description: Template or Seller not found }
 *       500: { description: Server error }
 */
// Bulk import SKUs (quick import with SKUs directly)
router.post('/bulk-import-skus', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, skus } = req.body;

    // Validate required fields
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }

    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'SKUs array is required and must not be empty' });
    }

    console.log('📦 Bulk SKU import request:', { templateId, sellerId, skuCount: skus.length });

    // Validate template (with seller overrides) and seller exist
    const [template, seller] = await Promise.all([
      getEffectiveTemplate(templateId, sellerId),
      Seller.findById(sellerId)
    ]);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    // Process SKUs
    const listingsToCreate = [];
    const skippedSKUs = [];
    const processedSKUs = new Set();

    for (const sku of skus) {
      const cleanSKU = sku.trim();

      // Basic SKU validation (not empty, reasonable length)
      if (!cleanSKU || cleanSKU.length === 0) {
        skippedSKUs.push({
          sku: cleanSKU,
          reason: 'Empty SKU'
        });
        continue;
      }

      if (cleanSKU.length > 100) {
        skippedSKUs.push({
          sku: cleanSKU,
          reason: 'SKU too long (max 100 characters)'
        });
        continue;
      }

      // Check for duplicates in current batch
      if (processedSKUs.has(cleanSKU)) {
        skippedSKUs.push({
          sku: cleanSKU,
          reason: 'Duplicate SKU in import batch'
        });
        continue;
      }

      processedSKUs.add(cleanSKU);

      // Create minimal listing object
      listingsToCreate.push({
        templateId,
        sellerId,
        customLabel: cleanSKU,
        title: `Product - ${cleanSKU}`,
        startPrice: 0.01, // Minimum placeholder
        quantity: 1,
        status: 'active',
        conditionId: '1000-New',
        format: 'FixedPrice',
        duration: 'GTC',
        location: 'UnitedStates',
        createdBy: req.user.userId
      });
    }

    console.log(`📊 Prepared ${listingsToCreate.length} listings, ${skippedSKUs.length} skipped (validation)`);

    // Check for existing SKUs across ALL templates for this seller (cross-template validation)
    const crossTemplateSkus = await TemplateListing.find({
      sellerId,
      templateId: { $ne: templateId }, // Different templates
      customLabel: { $in: listingsToCreate.map(l => l.customLabel) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel templateId _asinReference');

    const crossTemplateSKUMap = new Map(
      crossTemplateSkus.map(l => [l.customLabel, { templateId: l.templateId, asin: l._asinReference }])
    );

    console.log(`🚫 Found ${crossTemplateSKUMap.size} SKUs in other templates`);

    // Filter out SKUs that exist in other templates
    const skusNotInOtherTemplates = listingsToCreate.filter(listing => {
      if (crossTemplateSKUMap.has(listing.customLabel)) {
        const existing = crossTemplateSKUMap.get(listing.customLabel);
        skippedSKUs.push({
          sku: listing.customLabel,
          reason: existing.asin
            ? `SKU already exists in another template for ASIN ${existing.asin}`
            : `SKU already exists in another template`
        });
        return false;
      }
      return true;
    });

    // Check for existing listings with same SKUs in active/draft status (current template)
    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skusNotInOtherTemplates.map(l => l.customLabel) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference');

    const existingSKUs = new Set(existingBySKU.map(l => l.customLabel));

    console.log(`🔍 Found ${existingSKUs.size} existing active/draft SKUs in database`);

    // Check for inactive listings that can be reactivated
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skusNotInOtherTemplates.map(l => l.customLabel) },
      status: 'inactive'
    }).select('customLabel _asinReference');

    const inactiveSKUMap = new Map(inactiveListings.map(l => [l.customLabel, l]));

    console.log(`🔄 Found ${inactiveSKUMap.size} inactive SKUs that can be reactivated`);

    // Separate listings into: reactivate, skip (already active), or create new
    const listingsToReactivate = [];
    const newListings = [];

    for (const listing of skusNotInOtherTemplates) {
      if (existingSKUs.has(listing.customLabel)) {
        // Already exists as active/draft - skip
        const existing = existingBySKU.find(e => e.customLabel === listing.customLabel);
        skippedSKUs.push({
          sku: listing.customLabel,
          reason: `Already exists in database${existing._asinReference ? ` (ASIN: ${existing._asinReference})` : ''}`
        });
      } else if (inactiveSKUMap.has(listing.customLabel)) {
        // Exists as inactive - reactivate
        listingsToReactivate.push({
          existing: inactiveSKUMap.get(listing.customLabel),
          newData: listing
        });
      } else {
        // Doesn't exist - create new
        newListings.push(listing);
      }
    }

    console.log(`✅ ${newListings.length} new listings to insert, ${listingsToReactivate.length} to reactivate`);

    // Reactivate inactive listings
    let reactivatedCount = 0;
    if (listingsToReactivate.length > 0) {
      const reactivateOps = listingsToReactivate.map(({ existing, newData }) => ({
        updateOne: {
          filter: { _id: existing._id },
          update: {
            $set: {
              ...newData,
              status: 'active',
              scheduleTime: '',
              downloadBatchId: null,
              downloadedAt: null,
              downloadBatchNumber: null,
              pendingRedownload: false,
              updatedAt: Date.now()
            }
          }
        }
      }));

      const reactivateResult = await TemplateListing.bulkWrite(reactivateOps);
      reactivatedCount = reactivateResult.modifiedCount || 0;
      console.log(`🔄 Reactivated ${reactivatedCount} inactive listings`);
    }

    // Bulk insert new listings
    let importedCount = 0;
    let insertErrors = [];

    if (newListings.length > 0) {
      try {
        const result = await TemplateListing.insertMany(newListings, {
          ordered: false, // Continue on error
          rawResult: true
        });

        importedCount = result.insertedCount || newListings.length;

        // Handle any write errors
        if (result.writeErrors && result.writeErrors.length > 0) {
          result.writeErrors.forEach(err => {
            const listing = newListings[err.index];
            if (err.code === 11000) {
              skippedSKUs.push({
                sku: listing.customLabel,
                reason: 'Duplicate key error'
              });
            } else {
              insertErrors.push({
                sku: listing.customLabel,
                error: err.errmsg
              });
            }
          });
        }
      } catch (error) {
        // Handle bulk insert errors
        if (error.code === 11000 && error.writeErrors) {
          importedCount = error.insertedDocs ? error.insertedDocs.length : 0;

          error.writeErrors.forEach(err => {
            const listing = newListings[err.index];
            skippedSKUs.push({
              sku: listing.customLabel,
              reason: 'Duplicate key error'
            });
          });
        } else {
          throw error;
        }
      }
    }

    console.log(`🎉 SKU Import complete: ${importedCount} new, ${reactivatedCount} reactivated, ${skippedSKUs.length} skipped`);

    res.json({
      total: skus.length,
      imported: importedCount,
      reactivated: reactivatedCount,
      skipped: skippedSKUs.length,
      skippedDetails: skippedSKUs,
      errors: insertErrors.length > 0 ? insertErrors : undefined
    });

  } catch (error) {
    console.error('❌ Bulk SKU import error:', error);
    res.status(500).json({
      error: error.message || 'Failed to bulk import SKUs'
    });
  }
});

/**
 * @swagger
 * /template-listings/bulk-import:
 *   post:
 *     tags: [Template Listings – Bulk Ops]
 *     summary: Raw listing import (CSV parse result array)
 *     description: Inserts an array of pre-built listing objects directly using `insertMany`. Intended for the CSV import flow. Duplicate key errors return HTTP 207 with partial results.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, listings]
 *             properties:
 *               templateId: { type: string }
 *               listings:
 *                 type: array
 *                 items: { $ref: '#/components/schemas/TemplateListing' }
 *     responses:
 *       200:
 *         description: All listings imported successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:       { type: string, example: Listings imported successfully }
 *                 importedCount: { type: integer, example: 25 }
 *       207:
 *         description: Import completed with some duplicates skipped
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:       { type: string }
 *                 importedCount: { type: integer }
 *                 errors:        { type: array, items: { type: object } }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Bulk import from CSV
router.post('/bulk-import', requireAuth, async (req, res) => {
  try {
    const { templateId, listings } = req.body;

    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({ error: 'Listings array is required' });
    }

    // Add metadata to each listing
    const listingsToInsert = listings.map(listing => ({
      ...listing,
      templateId,
      createdBy: req.user.userId,
      customFields: listing.customFields
        ? new Map(Object.entries(listing.customFields))
        : new Map()
    }));

    const result = await TemplateListing.insertMany(listingsToInsert, {
      ordered: false // Continue on error
    });

    res.json({
      message: 'Listings imported successfully',
      importedCount: result.length
    });
  } catch (error) {
    if (error.code === 11000) {
      // Some duplicates were found
      const insertedCount = error.insertedDocs ? error.insertedDocs.length : 0;
      return res.status(207).json({
        message: 'Import completed with some duplicates skipped',
        importedCount: insertedCount,
        errors: error.writeErrors || []
      });
    }
    console.error('Error bulk importing listings:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/export-csv/{templateId}:
 *   get:
 *     tags: [Template Listings – CSV]
 *     summary: Export active listings as eBay-format CSV
 *     description: |
 *       Generates and downloads an eBay bulk-upload CSV file.
 *
 *       **Default behaviour** (no `listingIds`): exports all `active` listings that have not
 *       yet been downloaded (i.e. `downloadBatchId` is null or `pendingRedownload` is true).
 *
 *       When `listingIds` is provided the status/batch filter is bypassed and only the
 *       explicitly listed IDs are exported.
 *
 *       On success the matched listings are marked with a `downloadBatchId`, `downloadBatchNumber`,
 *       and `downloadedAt` timestamp. A fire-and-forget seller-snapshot upsert also runs.
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *       - in: query
 *         name: listingIds
 *         schema: { type: string }
 *         description: Comma-separated listing IDs to export (bypasses status filter)
 *     responses:
 *       200:
 *         description: CSV file download
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *               format: binary
 *       400: { description: No active listings to download }
 *       401: { description: Unauthorized }
 *       404: { description: Template not found }
 *       500: { description: Server error }
 */
// Export listings as eBay CSV
router.get('/export-csv/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId, listingIds } = req.query;

    // When specific listingIds are provided, filter only by those IDs —
    // status, downloadBatchId, and sellerId filters are skipped since the
    // user has explicitly chosen which listings to export.
    // Otherwise, filter for ACTIVE listings that haven't been downloaded yet.
    let filter;
    if (listingIds) {
      const ids = listingIds.split(',').map(id => id.trim()).filter(Boolean);
      filter = { _id: { $in: ids } };
    } else {
      filter = {
        templateId,
        $or: [{ downloadBatchId: null }, { pendingRedownload: true }], // not downloaded yet OR flagged for re-download
        status: 'active',       // Only active listings (exclude inactive/draft/sold/ended)
      };
      if (sellerId) {
        filter.sellerId = sellerId;
      }
    }

    // Fetch effective template (includes seller overrides), seller, and filtered listings
    const [template, seller, listings] = await Promise.all([
      getEffectiveTemplate(templateId, sellerId),
      sellerId ? Seller.findById(sellerId).populate('user', 'username email') : null,
      TemplateListing.find(filter).select('+_asinReference').sort({ createdAt: -1 })
    ]);

    console.log('📊 Export CSV - Seller info:', seller?.user?.username || seller?.user?.email || 'No seller');
    console.log('📊 Export CSV - Listings count:', listings.length);
    console.log('📥 Exporting active listings only (excluded inactive/draft)');

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (listings.length === 0) {
      return res.status(400).json({ error: 'No active listings to download' });
    }

    // Generate batch ID and get next batch number
    const crypto = await import('crypto');
    const batchId = crypto.randomUUID();

    // Get next batch number for this template + seller combination
    const latestBatch = await TemplateListing.findOne({
      templateId,
      sellerId: sellerId || { $exists: true },
      downloadBatchNumber: { $ne: null }
    }).sort({ downloadBatchNumber: -1 });

    const batchNumber = (latestBatch?.downloadBatchNumber || 0) + 1;

    console.log('🔢 Batch number:', batchNumber);
    console.log('🆔 Batch ID:', batchId);

    // Get custom Action field from template
    const actionField = template.customActionField || '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)';

    // Mark listings as downloaded (also clears pendingRedownload flag)
    const updateResult = await TemplateListing.updateMany(
      filter,
      {
        downloadBatchId: batchId,
        downloadedAt: new Date(),
        downloadBatchNumber: batchNumber,
        downloadedActionField: actionField,
        pendingRedownload: false
      }
    );

    console.log('✅ Updated listings:', updateResult.modifiedCount);
    console.log('📝 Using Action field:', actionField);

    // Build core headers (38 columns)
    const coreHeaders = [
      actionField,
      'Custom label (SKU)',
      'Category ID',
      'Category name',
      'Title',
      'Relationship',
      'Relationship details',
      'Schedule Time',
      'P:UPC',
      'P:EPID',
      'Start price',
      'Quantity',
      'Item photo URL',
      'VideoID',
      'Condition ID',
      'Description',
      'Format',
      'Duration',
      'Buy It Now price',
      'Best Offer Enabled',
      'Best Offer Auto Accept Price',
      'Minimum Best Offer Price',
      'Immediate pay required',
      'Location',
      'Shipping service 1 option',
      'Shipping service 1 cost',
      'Shipping service 1 priority',
      'Shipping service 2 option',
      'Shipping service 2 cost',
      'Shipping service 2 priority',
      'Max dispatch time',
      'Returns accepted option',
      'Returns within option',
      'Refund option',
      'Return shipping cost paid by',
      'Shipping profile name',
      'Return profile name',
      'Payment profile name'
    ];

    // Add custom column headers
    const customHeaders = template.customColumns
      .sort((a, b) => a.order - b.order)
      .map(col => col.name);

    const allHeaders = [...coreHeaders, ...customHeaders];
    const columnCount = allHeaders.length;

    // Generate #INFO lines (must match column count exactly)
    const emptyRow = new Array(columnCount).fill('');

    // INFO Line 1: Created timestamp + required field indicator
    const infoLine1 = ['#INFO', `Created=${Date.now()}`, '', '', '', '',
      ' Indicates missing required fields', '', '', '', '',
      ' Indicates missing field that will be required soon',
      ...new Array(columnCount - 12).fill('')];

    // INFO Line 2: Version + recommended field indicator  
    const infoLine2 = ['#INFO', 'Version=1.0', '',
      'Template=fx_category_template_EBAY_US', '', '',
      ' Indicates missing recommended field', '', '', '', '',
      ' Indicates field does not apply to this item/category',
      ...new Array(columnCount - 12).fill('')];

    // INFO Line 3: All empty commas
    const infoLine3 = new Array(columnCount).fill('')
    infoLine3[0] = '#INFO';

    // Map listings to CSV rows
    const dataRows = listings.map(listing => {
      // Add leading slash to category name if not present
      let categoryName = listing.categoryName || '';
      if (categoryName && !categoryName.startsWith('/')) {
        categoryName = '/' + categoryName;
      }

      const coreValues = [
        listing.action || 'Add',
        listing.customLabel || '',
        listing.categoryId || '',
        categoryName,
        listing.title || '',
        listing.relationship || '',
        listing.relationshipDetails || '',
        listing.scheduleTime || '',
        listing.upc || '',
        listing.epid || '',
        listing.startPrice || '',
        listing.quantity || '',
        listing.itemPhotoUrl || '',
        listing.videoId || '',
        listing.conditionId || '1000-New',
        listing.description || '',
        listing.format || 'FixedPrice',
        listing.duration || 'GTC',
        listing.buyItNowPrice || '',
        listing.bestOfferEnabled || '',
        listing.bestOfferAutoAcceptPrice || '',
        listing.minimumBestOfferPrice || '',
        listing.immediatePayRequired || '',
        listing.location || 'UnitedStates',
        listing.shippingService1Option || '',
        listing.shippingService1Cost || '',
        listing.shippingService1Priority || '',
        listing.shippingService2Option || '',
        listing.shippingService2Cost || '',
        listing.shippingService2Priority || '',
        listing.maxDispatchTime || '',
        listing.returnsAcceptedOption || '',
        listing.returnsWithinOption || '',
        listing.refundOption || '',
        listing.returnShippingCostPaidBy || '',
        listing.shippingProfileName || '',
        listing.returnProfileName || '',
        listing.paymentProfileName || ''
      ];

      // Get custom field values in order
      const customValues = template.customColumns
        .sort((a, b) => a.order - b.order)
        .map(col => listing.customFields.get(col.name) || '');

      return [...coreValues, ...customValues];
    });

    // Combine all rows
    const allRows = [infoLine1, infoLine2, infoLine3, allHeaders, ...dataRows];

    // Convert to CSV string with proper escaping
    const csvContent = allRows.map(row =>
      row.map(cell => {
        const value = String(cell || '');
        // Escape quotes and wrap in quotes if contains comma/quote/newline
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',')
    ).join('\n');

    // Send as downloadable file with template, seller, batch number and date
    const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const sellerName = seller?.user?.username || seller?.user?.email || 'seller';
    const templateName = template.name.replace(/\s+/g, '_');
    const filename = `${templateName}_${sellerName}_batch_${batchNumber}_${dateStr}.csv`;

    console.log('📁 Generated filename:', filename);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);

    // Snapshot: if this is a real (non-Testing) seller, upsert TemplateListing records
    // for that seller so Template Directory can show what was listed for them.
    // Fire-and-forget — any failure must not affect the already-sent CSV response.
    try {
      const isTestingSeller = seller?.user?.username?.toLowerCase() === 'growmentality';
      if (sellerId && !isTestingSeller) {
        const upsertOps = listings.map(listing => ({
          updateOne: {
            filter: { templateId, sellerId, customLabel: listing.customLabel },
            update: {
              $set: {
                templateId,
                sellerId,
                action: listing.action || 'Add',
                customLabel: listing.customLabel,
                categoryId: listing.categoryId,
                categoryName: listing.categoryName,
                title: listing.title,
                relationship: listing.relationship,
                relationshipDetails: listing.relationshipDetails,
                scheduleTime: listing.scheduleTime,
                upc: listing.upc,
                epid: listing.epid,
                startPrice: listing.startPrice,
                quantity: listing.quantity,
                itemPhotoUrl: listing.itemPhotoUrl,
                videoId: listing.videoId,
                conditionId: listing.conditionId,
                description: listing.description,
                format: listing.format,
                duration: listing.duration,
                buyItNowPrice: listing.buyItNowPrice,
                bestOfferEnabled: listing.bestOfferEnabled,
                bestOfferAutoAcceptPrice: listing.bestOfferAutoAcceptPrice,
                minimumBestOfferPrice: listing.minimumBestOfferPrice,
                immediatePayRequired: listing.immediatePayRequired,
                location: listing.location,
                shippingService1Option: listing.shippingService1Option,
                shippingService1Cost: listing.shippingService1Cost,
                shippingService1Priority: listing.shippingService1Priority,
                shippingService2Option: listing.shippingService2Option,
                shippingService2Cost: listing.shippingService2Cost,
                shippingService2Priority: listing.shippingService2Priority,
                maxDispatchTime: listing.maxDispatchTime,
                returnsAcceptedOption: listing.returnsAcceptedOption,
                returnsWithinOption: listing.returnsWithinOption,
                refundOption: listing.refundOption,
                returnShippingCostPaidBy: listing.returnShippingCostPaidBy,
                shippingProfileName: listing.shippingProfileName,
                returnProfileName: listing.returnProfileName,
                paymentProfileName: listing.paymentProfileName,
                customFields: listing.customFields,
                amazonLink: listing.amazonLink,
                _asinReference: listing._asinReference,
                status: 'active',
                updatedAt: new Date(),
              },
              $setOnInsert: { createdAt: new Date(), downloadBatchId: null, pendingRedownload: false },
            },
            upsert: true,
          },
        }));
        await TemplateListing.bulkWrite(upsertOps, { ordered: false });
        console.log(`📋 Snapshot: upserted ${upsertOps.length} listing(s) for seller ${seller?.user?.username}`);
      }
    } catch (snapshotErr) {
      console.error('Snapshot upsert failed (non-fatal):', snapshotErr.message);
    }

  } catch (error) {
    console.error('Error exporting CSV:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/export-csv-direct/{templateId}:
 *   post:
 *     tags: [Template Listings – CSV]
 *     summary: Export CSV from inline data (“List Directly” flow)
 *     description: |
 *       Generates an eBay CSV using the listing array supplied in the request body rather than
 *       reading from the database. Edits made in the review modal are captured without needing
 *       a prior save. Does NOT update `downloadBatchId` on DB records.
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listings]
 *             properties:
 *               sellerId: { type: string }
 *               listings:
 *                 type: array
 *                 items: { $ref: '#/components/schemas/TemplateListing' }
 *     responses:
 *       200:
 *         description: CSV file download
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *               format: binary
 *       400: { description: listings array is required or template not found }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Export CSV using inline listing data (no DB read for field values — used by Proof Read → List Directly)
// Edits made in the review modal are carried into the CSV without being persisted to the database.
router.post('/export-csv-direct/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId, listings } = req.body;

    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({ error: 'listings array is required' });
    }

    const [template, seller] = await Promise.all([
      getEffectiveTemplate(templateId, sellerId),
      sellerId ? Seller.findById(sellerId).populate('user', 'username email') : null,
    ]);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Generate batch ID and get next batch number
    const crypto = await import('crypto');
    const batchId = crypto.randomUUID();

    const latestBatch = await TemplateListing.findOne({
      templateId,
      sellerId: sellerId || { $exists: true },
      downloadBatchNumber: { $ne: null }
    }).sort({ downloadBatchNumber: -1 });

    const batchNumber = (latestBatch?.downloadBatchNumber || 0) + 1;

    // Build CSV — identical structure to GET /export-csv
    const actionField = template.customActionField || '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)';

    // Mark the underlying TemplateListing docs as downloaded (batch tracking only — field values are NOT updated)
    const existingIds = listings.map(l => l._existingListingId).filter(Boolean);
    if (existingIds.length > 0) {
      await TemplateListing.updateMany(
        { _id: { $in: existingIds } },
        {
          downloadBatchId: batchId,
          downloadedAt: new Date(),
          downloadBatchNumber: batchNumber,
          downloadedActionField: actionField,
          pendingRedownload: false
        }
      );
    }

    const coreHeaders = [
      actionField, 'Custom label (SKU)', 'Category ID', 'Category name', 'Title',
      'Relationship', 'Relationship details', 'Schedule Time', 'P:UPC', 'P:EPID',
      'Start price', 'Quantity', 'Item photo URL', 'VideoID', 'Condition ID',
      'Description', 'Format', 'Duration', 'Buy It Now price', 'Best Offer Enabled',
      'Best Offer Auto Accept Price', 'Minimum Best Offer Price', 'Immediate pay required',
      'Location', 'Shipping service 1 option', 'Shipping service 1 cost',
      'Shipping service 1 priority', 'Shipping service 2 option', 'Shipping service 2 cost',
      'Shipping service 2 priority', 'Max dispatch time', 'Returns accepted option',
      'Returns within option', 'Refund option', 'Return shipping cost paid by',
      'Shipping profile name', 'Return profile name', 'Payment profile name'
    ];

    const customHeaders = template.customColumns
      .sort((a, b) => a.order - b.order)
      .map(col => col.name);

    const allHeaders = [...coreHeaders, ...customHeaders];
    const columnCount = allHeaders.length;

    const infoLine1 = ['#INFO', `Created=${Date.now()}`, '', '', '', '',
      ' Indicates missing required fields', '', '', '', '',
      ' Indicates missing field that will be required soon',
      ...new Array(columnCount - 12).fill('')];

    const infoLine2 = ['#INFO', 'Version=1.0', '',
      'Template=fx_category_template_EBAY_US', '', '',
      ' Indicates missing recommended field', '', '', '', '',
      ' Indicates field does not apply to this item/category',
      ...new Array(columnCount - 12).fill('')];

    const infoLine3 = new Array(columnCount).fill('');
    infoLine3[0] = '#INFO';

    const dataRows = listings.map(listing => {
      let categoryName = listing.categoryName || '';
      if (categoryName && !categoryName.startsWith('/')) {
        categoryName = '/' + categoryName;
      }

      // customFields may be a plain object (from frontend) or a Map (from DB doc)
      const getCustomField = (name) => {
        if (!listing.customFields) return '';
        if (typeof listing.customFields.get === 'function') return listing.customFields.get(name) || '';
        return listing.customFields[name] || '';
      };

      const coreValues = [
        listing.action || 'Add', listing.customLabel || '', listing.categoryId || '',
        categoryName, listing.title || '', listing.relationship || '',
        listing.relationshipDetails || '', listing.scheduleTime || '',
        listing.upc || '', listing.epid || '', listing.startPrice || '',
        listing.quantity || '', listing.itemPhotoUrl || '', listing.videoId || '',
        listing.conditionId || '1000-New', listing.description || '',
        listing.format || 'FixedPrice', listing.duration || 'GTC',
        listing.buyItNowPrice || '', listing.bestOfferEnabled || '',
        listing.bestOfferAutoAcceptPrice || '', listing.minimumBestOfferPrice || '',
        listing.immediatePayRequired || '', listing.location || 'UnitedStates',
        listing.shippingService1Option || '', listing.shippingService1Cost || '',
        listing.shippingService1Priority || '', listing.shippingService2Option || '',
        listing.shippingService2Cost || '', listing.shippingService2Priority || '',
        listing.maxDispatchTime || '', listing.returnsAcceptedOption || '',
        listing.returnsWithinOption || '', listing.refundOption || '',
        listing.returnShippingCostPaidBy || '', listing.shippingProfileName || '',
        listing.returnProfileName || '', listing.paymentProfileName || ''
      ];

      const customValues = template.customColumns
        .sort((a, b) => a.order - b.order)
        .map(col => getCustomField(col.name));

      return [...coreValues, ...customValues];
    });

    const allRows = [infoLine1, infoLine2, infoLine3, allHeaders, ...dataRows];

    const csvContent = allRows.map(row =>
      row.map(cell => {
        const value = String(cell || '');
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',')
    ).join('\n');

    const dateStr = new Date().toISOString().split('T')[0];
    const sellerName = seller?.user?.username || seller?.user?.email || 'seller';
    const templateName = template.name.replace(/\s+/g, '_');
    const filename = `${templateName}_${sellerName}_batch_${batchNumber}_${dateStr}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);

    // Snapshot: upsert TemplateListing records for the chosen real seller.
    // Uses inline-edited field values (what actually went into the CSV).
    try {
      const isTestingSeller = seller?.user?.username?.toLowerCase() === 'growmentality';
      if (sellerId && !isTestingSeller) {
        const upsertOps = listings.map(listing => {
          const getField = (name) => {
            if (!listing.customFields) return undefined;
            if (typeof listing.customFields.get === 'function') return listing.customFields.get(name);
            return listing.customFields[name];
          };
          // Rebuild customFields as a plain object for storage
          const customFieldsObj = {};
          if (listing.customFields) {
            if (typeof listing.customFields.get === 'function') {
              for (const [k, v] of listing.customFields) customFieldsObj[k] = v;
            } else {
              Object.assign(customFieldsObj, listing.customFields);
            }
          }
          return {
            updateOne: {
              filter: { templateId, sellerId, customLabel: listing.customLabel },
              update: {
                $set: {
                  templateId,
                  sellerId,
                  action: listing.action || 'Add',
                  customLabel: listing.customLabel,
                  categoryId: listing.categoryId,
                  categoryName: listing.categoryName,
                  title: listing.title,
                  relationship: listing.relationship,
                  relationshipDetails: listing.relationshipDetails,
                  scheduleTime: listing.scheduleTime,
                  upc: listing.upc,
                  epid: listing.epid,
                  startPrice: listing.startPrice,
                  quantity: listing.quantity,
                  itemPhotoUrl: listing.itemPhotoUrl,
                  videoId: listing.videoId,
                  conditionId: listing.conditionId,
                  description: listing.description,
                  format: listing.format,
                  duration: listing.duration,
                  buyItNowPrice: listing.buyItNowPrice,
                  bestOfferEnabled: listing.bestOfferEnabled,
                  bestOfferAutoAcceptPrice: listing.bestOfferAutoAcceptPrice,
                  minimumBestOfferPrice: listing.minimumBestOfferPrice,
                  immediatePayRequired: listing.immediatePayRequired,
                  location: listing.location,
                  shippingService1Option: listing.shippingService1Option,
                  shippingService1Cost: listing.shippingService1Cost,
                  shippingService1Priority: listing.shippingService1Priority,
                  shippingService2Option: listing.shippingService2Option,
                  shippingService2Cost: listing.shippingService2Cost,
                  shippingService2Priority: listing.shippingService2Priority,
                  maxDispatchTime: listing.maxDispatchTime,
                  returnsAcceptedOption: listing.returnsAcceptedOption,
                  returnsWithinOption: listing.returnsWithinOption,
                  refundOption: listing.refundOption,
                  returnShippingCostPaidBy: listing.returnShippingCostPaidBy,
                  shippingProfileName: listing.shippingProfileName,
                  returnProfileName: listing.returnProfileName,
                  paymentProfileName: listing.paymentProfileName,
                  customFields: customFieldsObj,
                  amazonLink: listing.amazonLink,
                  _asinReference: listing._asinReference,
                  status: 'active',
                  updatedAt: new Date(),
                },
                $setOnInsert: { createdAt: new Date(), downloadBatchId: null, pendingRedownload: false },
              },
              upsert: true,
            },
          };
        });
        await TemplateListing.bulkWrite(upsertOps, { ordered: false });
        console.log(`📋 Snapshot (direct): upserted ${upsertOps.length} listing(s) for seller ${seller?.user?.username}`);
      }
    } catch (snapshotErr) {
      console.error('Snapshot upsert (direct) failed (non-fatal):', snapshotErr.message);
    }

  } catch (error) {
    console.error('Error exporting CSV (direct):', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/download-history/{templateId}:
 *   get:
 *     tags: [Template Listings – CSV]
 *     summary: Get download batch history for a template
 *     description: Returns all distinct download batches for a template (and optional seller), ordered by batch number. Each batch includes the count of exported listings.
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of batch history objects
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   batchId:      { type: string }
 *                   batchNumber:  { type: integer }
 *                   downloadedAt: { type: string, format: date-time }
 *                   listingCount: { type: integer }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Get download history for a template/seller
router.get('/download-history/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId } = req.query;

    console.log('📜 Download history request - Template:', templateId, 'Seller:', sellerId);

    // Convert string IDs to ObjectIds for aggregation
    const mongoose = await import('mongoose');
    const filter = {
      templateId: new mongoose.default.Types.ObjectId(templateId),
      downloadBatchId: { $ne: null }
    };

    if (sellerId) {
      filter.sellerId = new mongoose.default.Types.ObjectId(sellerId);
    }

    console.log('🔍 Filter:', JSON.stringify(filter));

    // First, let's check ALL listings for this template/seller
    const allListings = await TemplateListing.find({
      templateId,
      sellerId: sellerId || { $exists: true }
    }).select('downloadBatchId downloadBatchNumber downloadedAt customLabel');

    console.log('📋 Total listings found:', allListings.length);
    console.log('📊 All listings batch info:', allListings.map(l => ({
      sku: l.customLabel,
      batchId: l.downloadBatchId,
      batchNumber: l.downloadBatchNumber,
      downloadedAt: l.downloadedAt
    })));

    // Get unique batches with their metadata
    const batches = await TemplateListing.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$downloadBatchId',
          batchNumber: { $first: '$downloadBatchNumber' },
          downloadedAt: { $first: '$downloadedAt' },
          listingCount: { $sum: 1 }
        }
      },
      { $sort: { batchNumber: 1 } }
    ]);

    console.log('📊 Aggregation result:', batches);

    // Format response
    const history = batches.map(batch => ({
      batchId: batch._id,
      batchNumber: batch.batchNumber,
      downloadedAt: batch.downloadedAt,
      listingCount: batch.listingCount
    }));

    console.log('✅ Sending history:', history);

    res.json(history);
  } catch (error) {
    console.error('Error fetching download history:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/re-download-batch/{templateId}/{batchId}:
 *   get:
 *     tags: [Template Listings – CSV]
 *     summary: Re-download a previously exported batch as CSV
 *     description: Regenerates the eBay CSV for a specific `downloadBatchId`. Uses the `downloadedActionField` stored at original download time so the Action column is preserved exactly.
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: batchId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: CSV file download for the specified batch
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *               format: binary
 *       401: { description: Unauthorized }
 *       404: { description: Template not found or batch not found }
 *       500: { description: Server error }
 */
// Re-download a specific batch
router.get('/re-download-batch/:templateId/:batchId', requireAuth, async (req, res) => {
  try {
    const { templateId, batchId } = req.params;
    const { sellerId } = req.query;

    // Build filter for specific batch
    const filter = {
      templateId,
      downloadBatchId: batchId
    };
    if (sellerId) {
      filter.sellerId = sellerId;
    }

    // Fetch effective template (includes seller overrides), seller, and batch listings
    const [template, seller, listings] = await Promise.all([
      getEffectiveTemplate(templateId, sellerId),
      sellerId ? Seller.findById(sellerId).populate('user', 'username email') : null,
      TemplateListing.find(filter).sort({ createdAt: -1 })
    ]);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    if (listings.length === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    const batchNumber = listings[0].downloadBatchNumber;

    // Use the action field that was saved at download time; fall back to current template value
    const actionField = listings[0].downloadedActionField || template.customActionField || '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)';
    console.log('📝 Using Action field:', actionField);

    // Build core headers (38 columns)
    const coreHeaders = [
      actionField,
      'Custom label (SKU)',
      'Category ID',
      'Category name',
      'Title',
      'Relationship',
      'Relationship details',
      'Schedule Time',
      'P:UPC',
      'P:EPID',
      'Start price',
      'Quantity',
      'Item photo URL',
      'VideoID',
      'Condition ID',
      'Description',
      'Format',
      'Duration',
      'Buy It Now price',
      'Best offer enabled',
      'Best offer: Auto accept price',
      'Minimum best offer price',
      'Immediate pay required',
      'Location',
      'Shipping service 1: option',
      'Shipping service 1: cost',
      'Shipping service 1: priority',
      'Shipping service 2: option',
      'Shipping service 2: cost',
      'Shipping service 2: priority',
      'Max dispatch time',
      'Returns accepted option',
      'Returns within option',
      'Refund option',
      'Return shipping cost paid by',
      'Shipping profile name',
      'Return profile name',
      'Payment profile name'
    ];

    // Add custom column headers
    const customHeaders = template.customColumns
      .sort((a, b) => a.order - b.order)
      .map(col => col.name);

    const allHeaders = [...coreHeaders, ...customHeaders];
    const columnCount = allHeaders.length;

    // Generate #INFO lines (must match column count exactly)
    const emptyRow = new Array(columnCount).fill('');

    // INFO Line 1: Created timestamp + required field indicator
    const infoLine1 = ['#INFO', `Created=${Date.now()}`, '', '', '', '',
      ' Indicates missing required fields', '', '', '', '',
      ' Indicates missing field that will be required soon',
      ...new Array(columnCount - 12).fill('')];

    // INFO Line 2: Version + recommended field indicator  
    const infoLine2 = ['#INFO', 'Version=1.0', '',
      'Template=fx_category_template_EBAY_US', '', '',
      ' Indicates missing recommended field', '', '', '', '',
      ' Indicates field does not apply to this item/category',
      ...new Array(columnCount - 12).fill('')];

    // INFO Line 3: All empty commas
    const infoLine3 = new Array(columnCount).fill('')
    infoLine3[0] = '#INFO';

    // Map listings to CSV rows
    const dataRows = listings.map(listing => {
      // Add leading slash to category name if not present
      let categoryName = listing.categoryName || '';
      if (categoryName && !categoryName.startsWith('/')) {
        categoryName = '/' + categoryName;
      }

      const coreValues = [
        listing.action || 'Add',
        listing.customLabel || '',
        listing.categoryId || '',
        categoryName,
        listing.title || '',
        listing.relationship || '',
        listing.relationshipDetails || '',
        listing.scheduleTime || '',
        listing.upc || '',
        listing.epid || '',
        listing.startPrice || '',
        listing.quantity || '',
        listing.itemPhotoUrl || '',
        listing.videoId || '',
        listing.conditionId || '1000-New',
        listing.description || '',
        listing.format || 'FixedPrice',
        listing.duration || 'GTC',
        listing.buyItNowPrice || '',
        listing.bestOfferEnabled || '',
        listing.bestOfferAutoAcceptPrice || '',
        listing.minimumBestOfferPrice || '',
        listing.immediatePayRequired || '',
        listing.location || 'UnitedStates',
        listing.shippingService1Option || '',
        listing.shippingService1Cost || '',
        listing.shippingService1Priority || '',
        listing.shippingService2Option || '',
        listing.shippingService2Cost || '',
        listing.shippingService2Priority || '',
        listing.maxDispatchTime || '',
        listing.returnsAcceptedOption || '',
        listing.returnsWithinOption || '',
        listing.refundOption || '',
        listing.returnShippingCostPaidBy || '',
        listing.shippingProfileName || '',
        listing.returnProfileName || '',
        listing.paymentProfileName || ''
      ];

      // Get custom field values in order
      const customValues = template.customColumns
        .sort((a, b) => a.order - b.order)
        .map(col => listing.customFields.get(col.name) || '');

      return [...coreValues, ...customValues];
    });

    // Combine all rows
    const allRows = [infoLine1, infoLine2, infoLine3, allHeaders, ...dataRows];

    // Convert to CSV string with proper escaping
    const csvContent = allRows.map(row =>
      row.map(cell => {
        const value = String(cell || '');
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',')
    ).join('\n');

    // Send as downloadable file with template, seller, batch number and date
    const dateStr = new Date().toISOString().split('T')[0];
    const sellerName = seller?.user?.username || seller?.user?.email || 'seller';
    const templateName = template.name.replace(/\s+/g, '_');
    const filename = `${templateName}_${sellerName}_batch_${batchNumber}_${dateStr}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);

  } catch (error) {
    console.error('Error re-downloading batch:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/search-inactive-skus:
 *   post:
 *     tags: [Template Listings – Admin]
 *     summary: Search for inactive listings by SKU array
 *     description: Looks up a list of SKUs and partitions them into `found` (inactive), `alreadyActive`, and `notFound` categories. Used before bulk-reactivate to preview what will happen.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, sellerId, skus]
 *             properties:
 *               templateId: { type: string }
 *               sellerId:   { type: string }
 *               skus:
 *                 type: array
 *                 items: { type: string }
 *                 example: ["GRW25B20Q", "GRW25K1RZ"]
 *     responses:
 *       200:
 *         description: Partitioned SKU lookup results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 found:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/TemplateListing' }
 *                   description: Inactive listings that can be reactivated
 *                 notFound:
 *                   type: array
 *                   items: { type: string }
 *                   description: SKUs not found in the database
 *                 alreadyActive:
 *                   type: array
 *                   items: { type: string }
 *                   description: SKUs that are already active
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Search for inactive listings by SKU
router.post('/search-inactive-skus', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, skus } = req.body;

    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }

    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'SKUs array is required' });
    }

    // Find inactive listings
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'inactive'
    }).select('+_asinReference');

    // Find already active listings
    const activeListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'active'
    }).select('customLabel');

    const foundSKUs = new Set(inactiveListings.map(l => l.customLabel));
    const activeSKUs = activeListings.map(l => l.customLabel);
    const notFoundSKUs = skus.filter(sku => !foundSKUs.has(sku) && !activeSKUs.includes(sku));

    console.log(`🔍 Search inactive SKUs: ${inactiveListings.length} found, ${activeSKUs.length} already active, ${notFoundSKUs.length} not found`);

    res.json({
      found: inactiveListings,
      notFound: notFoundSKUs,
      alreadyActive: activeSKUs
    });
  } catch (error) {
    console.error('Error searching inactive SKUs:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/bulk-reactivate:
 *   post:
 *     tags: [Template Listings – Admin]
 *     summary: Reactivate inactive listings by ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listingIds]
 *             properties:
 *               listingIds:
 *                 type: array
 *                 items: { type: string }
 *                 example: ["665abc...", "665def..."]
 *     responses:
 *       200:
 *         description: Reactivation summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:     { type: boolean }
 *                 reactivated: { type: integer, example: 5 }
 *                 details:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       customLabel: { type: string }
 *                       title:       { type: string }
 *       400: { description: listingIds array is required }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Bulk reactivate inactive listings
router.post('/bulk-reactivate', requireAuth, async (req, res) => {
  try {
    const { listingIds } = req.body;

    if (!listingIds || !Array.isArray(listingIds) || listingIds.length === 0) {
      return res.status(400).json({ error: 'listingIds array is required' });
    }

    // Update status to active
    const result = await TemplateListing.updateMany(
      {
        _id: { $in: listingIds },
        status: 'inactive'
      },
      {
        $set: {
          status: 'active',
          updatedAt: Date.now()
        }
      }
    );

    // Get updated listings for response
    const reactivatedListings = await TemplateListing.find({
      _id: { $in: listingIds },
      status: 'active'
    }).select('customLabel title _asinReference');

    console.log(`✅ Reactivated ${result.modifiedCount} listings`);

    res.json({
      success: true,
      reactivated: result.modifiedCount,
      details: reactivatedListings
    });
  } catch (error) {
    console.error('Error reactivating listings:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /template-listings/bulk-deactivate:
 *   post:
 *     tags: [Template Listings – Admin]
 *     summary: Deactivate active listings by SKU array
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, sellerId, skus]
 *             properties:
 *               templateId: { type: string }
 *               sellerId:   { type: string }
 *               skus:
 *                 type: array
 *                 items: { type: string }
 *                 example: ["GRW25B20Q", "GRW25K1RZ"]
 *     responses:
 *       200:
 *         description: Deactivation summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 summary:
 *                   type: object
 *                   properties:
 *                     total:           { type: integer }
 *                     deactivated:     { type: integer }
 *                     notFound:        { type: integer }
 *                     alreadyInactive: { type: integer }
 *                 details:
 *                   type: object
 *                   properties:
 *                     deactivated:     { type: array, items: { type: object } }
 *                     notFound:        { type: array, items: { type: string } }
 *                     alreadyInactive: { type: array, items: { type: string } }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
// Bulk deactivate active listings
router.post('/bulk-deactivate', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, skus } = req.body;

    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }

    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }

    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'SKUs array is required' });
    }

    // Find active listings
    const activeListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'active'
    }).select('customLabel title _asinReference');

    // Find already inactive
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'inactive'
    }).select('customLabel');

    const foundSKUs = new Set(activeListings.map(l => l.customLabel));
    const alreadyInactiveSKUs = inactiveListings.map(l => l.customLabel);
    const notFoundSKUs = skus.filter(sku =>
      !foundSKUs.has(sku) && !alreadyInactiveSKUs.includes(sku)
    );

    // Deactivate
    const result = await TemplateListing.updateMany(
      {
        templateId,
        sellerId,
        customLabel: { $in: Array.from(foundSKUs) },
        status: 'active'
      },
      {
        $set: {
          status: 'inactive',
          updatedAt: Date.now()
        }
      }
    );

    console.log(`⏸️ Deactivated ${result.modifiedCount} listings`);

    res.json({
      success: true,
      summary: {
        total: skus.length,
        deactivated: result.modifiedCount,
        notFound: notFoundSKUs.length,
        alreadyInactive: alreadyInactiveSKUs.length
      },
      details: {
        deactivated: activeListings,
        notFound: notFoundSKUs,
        alreadyInactive: alreadyInactiveSKUs
      }
    });
  } catch (error) {
    console.error('Error deactivating listings:', error);
    res.status(500).json({ error: error.message });
  }
});

const IST_OFFSET_MINUTES = 330;

const parseIstDateBoundary = (dateValue, isEndOfDay = false) => {
  const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date(dateValue);

  const [, year, month, day] = match.map(Number);
  const utcTime = Date.UTC(
    year,
    month - 1,
    day,
    isEndOfDay ? 23 : 0,
    isEndOfDay ? 59 : 0,
    isEndOfDay ? 59 : 0,
    isEndOfDay ? 999 : 0
  );
  return new Date(utcTime - IST_OFFSET_MINUTES * 60 * 1000);
};

const parseIstDateTime = (dateTimeValue) => {
  const match = String(dateTimeValue || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return new Date(dateTimeValue);

  const [, year, month, day, hour, minute, second = '0'] = match;
  const utcTime = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    0
  );
  return new Date(utcTime - IST_OFFSET_MINUTES * 60 * 1000);
};

router.get('/api/openai-usage-summary', requireAuth, async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      startDateTime,
      endDateTime,
      userId,
      sellerId,
      templateId,
      ipAddress,
      limit = 500
    } = req.query;

    const match = { service: 'OpenAI' };
    const optionMatch = { service: 'OpenAI' };
    let listingRunDateRange = null;

    if (startDateTime || endDateTime) {
      match.timestamp = {};
      optionMatch.timestamp = optionMatch.timestamp || {};
      listingRunDateRange = {};
      if (startDateTime) {
        const start = parseIstDateTime(startDateTime);
        match.timestamp.$gte = start;
        optionMatch.timestamp.$gte = start;
        listingRunDateRange.$gte = start;
      }
      if (endDateTime) {
        const end = parseIstDateTime(endDateTime);
        match.timestamp.$lte = end;
        optionMatch.timestamp.$lte = end;
        listingRunDateRange.$lte = end;
      }
    } else if (startDate || endDate) {
      match.timestamp = {};
      listingRunDateRange = {};
      if (startDate) {
        const start = parseIstDateBoundary(startDate);
        match.timestamp.$gte = start;
        optionMatch.timestamp = optionMatch.timestamp || {};
        optionMatch.timestamp.$gte = start;
        listingRunDateRange.$gte = start;
      }
      if (endDate) {
        const end = parseIstDateBoundary(endDate, true);
        match.timestamp.$lte = end;
        optionMatch.timestamp = optionMatch.timestamp || {};
        optionMatch.timestamp.$lte = end;
        listingRunDateRange.$lte = end;
      }
    }

    if (userId && userId !== 'all' && mongoose.Types.ObjectId.isValid(userId)) {
      match.userId = new mongoose.Types.ObjectId(userId);
    }
    if (sellerId && sellerId !== 'all' && mongoose.Types.ObjectId.isValid(sellerId)) {
      match.sellerId = new mongoose.Types.ObjectId(sellerId);
    }
    if (templateId && templateId !== 'all' && mongoose.Types.ObjectId.isValid(templateId)) {
      match.templateId = new mongoose.Types.ObjectId(templateId);
    }
    if (ipAddress && ipAddress !== 'all') {
      match.ipAddress = ipAddress;
    }

    const maxRows = Math.min(parseInt(limit, 10) || 500, 2000);

    const [rows, fieldBreakdown, fieldAsinBreakdown, asinCallBreakdown, ipBreakdown, totalsAgg, filterOptionsAgg] = await Promise.all([
      ApiUsage.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              userId: '$userId',
              sellerId: '$sellerId',
              templateId: '$templateId',
              ipAddress: '$ipAddress',
              ipSource: '$ipSource',
              aiRunId: '$aiRunId'
            },
            aiCalls: { $sum: 1 },
            successfulCalls: { $sum: { $cond: ['$success', 1, 0] } },
            failedCalls: { $sum: { $cond: ['$success', 0, 1] } },
            successfulAsins: {
              $addToSet: {
                $cond: [
                  { $and: ['$success', { $ne: ['$asin', null] }, { $ne: ['$asin', ''] }] },
                  '$asin',
                  '$$REMOVE'
                ]
              }
            },
            successfulAsinRuns: {
              $push: {
                $cond: [
                  { $and: ['$success', { $ne: ['$asin', null] }, { $ne: ['$asin', ''] }] },
                  {
                    asin: '$asin',
                    fieldName: '$fieldName',
                    timestamp: '$timestamp'
                  },
                  '$$REMOVE'
                ]
              }
            },
            totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
            promptTokens: { $sum: { $ifNull: ['$promptTokens', 0] } },
            completionTokens: { $sum: { $ifNull: ['$completionTokens', 0] } },
            avgResponseTime: { $avg: '$responseTime' },
            userAgents: {
              $addToSet: {
                $cond: [
                  { $and: [{ $ne: ['$userAgent', null] }, { $ne: ['$userAgent', ''] }] },
                  '$userAgent',
                  '$$REMOVE'
                ]
              }
            },
            firstUsedAt: { $min: '$timestamp' },
            aiRunStartedAt: { $min: { $ifNull: ['$aiRunStartedAt', '$timestamp'] } },
            lastUsedAt: { $max: '$timestamp' }
          }
        },
        { $sort: { lastUsedAt: -1, totalTokens: -1, aiCalls: -1 } },
        { $limit: maxRows },
        {
          $lookup: {
            from: 'users',
            localField: '_id.userId',
            foreignField: '_id',
            as: 'user'
          }
        },
        {
          $lookup: {
            from: 'sellers',
            localField: '_id.sellerId',
            foreignField: '_id',
            as: 'seller'
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: 'seller.user',
            foreignField: '_id',
            as: 'sellerUser'
          }
        },
        {
          $lookup: {
            from: 'listingtemplates',
            localField: '_id.templateId',
            foreignField: '_id',
            as: 'template'
          }
        },
        {
          $lookup: {
            from: 'ailistingruns',
            localField: '_id.aiRunId',
            foreignField: 'aiRunId',
            as: 'listingRun'
          }
        },
        {
          $project: {
            _id: 0,
            userId: '$_id.userId',
            sellerId: '$_id.sellerId',
            templateId: '$_id.templateId',
            aiRunId: { $ifNull: ['$_id.aiRunId', 'legacy-usage'] },
            aiRunStartedAt: 1,
            ipAddress: { $ifNull: ['$_id.ipAddress', 'Unknown IP'] },
            ipSource: { $ifNull: ['$_id.ipSource', 'unknown'] },
            username: { $ifNull: [{ $arrayElemAt: ['$user.username', 0] }, 'Unknown user'] },
            userEmail: { $arrayElemAt: ['$user.email', 0] },
            userRole: { $arrayElemAt: ['$user.role', 0] },
            sellerName: { $ifNull: [{ $arrayElemAt: ['$sellerUser.username', 0] }, 'Unknown seller'] },
            sellerEmail: { $arrayElemAt: ['$sellerUser.email', 0] },
            templateName: { $ifNull: [{ $arrayElemAt: ['$template.name', 0] }, 'Unknown template'] },
            aiCalls: 1,
            successfulCalls: 1,
            failedCalls: 1,
            savedFromReviewCount: {
              $ifNull: [{ $arrayElemAt: ['$listingRun.savedFromReviewCount', 0] }, 0]
            },
            updateableDuplicateCount: {
              $ifNull: [{ $arrayElemAt: ['$listingRun.updateableDuplicateCount', 0] }, 0]
            },
            dismissedFromReviewCount: {
              $ifNull: [{ $arrayElemAt: ['$listingRun.dismissedFromReviewCount', 0] }, 0]
            },
            dismissedNewAsinCount: {
              $ifNull: [{ $arrayElemAt: ['$listingRun.dismissedNewAsinCount', 0] }, 0]
            },
            dismissedUpdateableDuplicateCount: {
              $ifNull: [{ $arrayElemAt: ['$listingRun.dismissedUpdateableDuplicateCount', 0] }, 0]
            },
            reviewSaveAttempts: {
              $ifNull: [{ $arrayElemAt: ['$listingRun.reviewSaveAttempts', 0] }, 0]
            },
            lastSavedFromReviewAt: { $arrayElemAt: ['$listingRun.lastSavedFromReviewAt', 0] },
            successfulAsinCount: { $size: '$successfulAsins' },
            successfulAsinRunCount: { $size: '$successfulAsinRuns' },
            successfulAsinRuns: 1,
            totalTokens: 1,
            promptTokens: 1,
            completionTokens: 1,
            avgResponseTime: { $round: ['$avgResponseTime', 1] },
            userAgents: 1,
            firstUsedAt: 1,
            lastUsedAt: 1
          }
        }
      ]),
      ApiUsage.aggregate([
        { $match: match },
        {
          $addFields: {
            normalizedFieldName: {
              $cond: [
                { $or: [{ $eq: ['$fieldName', null] }, { $eq: ['$fieldName', ''] }] },
                'Unknown field',
                '$fieldName'
              ]
            }
          }
        },
        {
          $group: {
            _id: '$normalizedFieldName',
            aiCalls: { $sum: 1 },
            successfulAsins: {
              $addToSet: {
                $cond: [
                  { $and: ['$success', { $ne: ['$asin', null] }, { $ne: ['$asin', ''] }] },
                  '$asin',
                  '$$REMOVE'
                ]
              }
            },
            totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
            promptTokens: { $sum: { $ifNull: ['$promptTokens', 0] } },
            completionTokens: { $sum: { $ifNull: ['$completionTokens', 0] } }
          }
        },
        { $sort: { totalTokens: -1 } },
        {
          $project: {
            _id: 0,
            fieldName: { $ifNull: ['$_id', 'unknown'] },
            aiCalls: 1,
            successfulAsinCount: { $size: '$successfulAsins' },
            totalTokens: 1,
            promptTokens: 1,
            completionTokens: 1
          }
        }
      ]),
      ApiUsage.aggregate([
        { $match: match },
        {
          $addFields: {
            normalizedFieldName: {
              $cond: [
                { $or: [{ $eq: ['$fieldName', null] }, { $eq: ['$fieldName', ''] }] },
                'Unknown field',
                '$fieldName'
              ]
            },
            normalizedAsin: {
              $cond: [
                { $or: [{ $eq: ['$asin', null] }, { $eq: ['$asin', ''] }] },
                'Unknown ASIN',
                '$asin'
              ]
            }
          }
        },
        {
          $group: {
            _id: {
              fieldName: '$normalizedFieldName',
              asin: '$normalizedAsin'
            },
            aiCalls: { $sum: 1 },
            successfulCalls: { $sum: { $cond: ['$success', 1, 0] } },
            failedCalls: { $sum: { $cond: ['$success', 0, 1] } },
            totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
            promptTokens: { $sum: { $ifNull: ['$promptTokens', 0] } },
            completionTokens: { $sum: { $ifNull: ['$completionTokens', 0] } },
            firstUsedAt: { $min: '$timestamp' },
            lastUsedAt: { $max: '$timestamp' }
          }
        },
        { $match: { aiCalls: { $gt: 1 } } },
        { $sort: { aiCalls: -1, totalTokens: -1 } },
        { $limit: 500 },
        {
          $project: {
            _id: 0,
            fieldName: '$_id.fieldName',
            asin: '$_id.asin',
            aiCalls: 1,
            successfulCalls: 1,
            failedCalls: 1,
            totalTokens: 1,
            promptTokens: 1,
            completionTokens: 1,
            firstUsedAt: 1,
            lastUsedAt: 1
          }
        }
      ]),
      ApiUsage.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              sellerId: '$sellerId',
              templateId: '$templateId',
              asin: '$asin'
            },
            aiCalls: { $sum: 1 },
            successfulCalls: { $sum: { $cond: ['$success', 1, 0] } },
            failedCalls: { $sum: { $cond: ['$success', 0, 1] } },
            fields: {
              $addToSet: {
                $cond: [
                  { $and: [{ $ne: ['$fieldName', null] }, { $ne: ['$fieldName', ''] }] },
                  '$fieldName',
                  '$$REMOVE'
                ]
              }
            },
            totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
            promptTokens: { $sum: { $ifNull: ['$promptTokens', 0] } },
            completionTokens: { $sum: { $ifNull: ['$completionTokens', 0] } },
            firstUsedAt: { $min: '$timestamp' },
            lastUsedAt: { $max: '$timestamp' }
          }
        },
        {
          $lookup: {
            from: 'sellers',
            localField: '_id.sellerId',
            foreignField: '_id',
            as: 'seller'
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: 'seller.user',
            foreignField: '_id',
            as: 'sellerUser'
          }
        },
        {
          $lookup: {
            from: 'listingtemplates',
            localField: '_id.templateId',
            foreignField: '_id',
            as: 'template'
          }
        },
        { $sort: { aiCalls: -1, totalTokens: -1 } },
        { $limit: 1000 },
        {
          $project: {
            _id: 0,
            sellerId: '$_id.sellerId',
            templateId: '$_id.templateId',
            asin: { $ifNull: ['$_id.asin', 'Unknown ASIN'] },
            sellerName: { $ifNull: [{ $arrayElemAt: ['$sellerUser.username', 0] }, 'Unknown seller'] },
            templateName: { $ifNull: [{ $arrayElemAt: ['$template.name', 0] }, 'Unknown template'] },
            aiCalls: 1,
            successfulCalls: 1,
            failedCalls: 1,
            fields: 1,
            fieldCount: { $size: '$fields' },
            totalTokens: 1,
            promptTokens: 1,
            completionTokens: 1,
            firstUsedAt: 1,
            lastUsedAt: 1
          }
        }
      ]),
      ApiUsage.aggregate([
        {
          $match: {
            ...match,
            ipAddress: match.ipAddress || { $nin: [null, ''] },
            ipSource: { $nin: [null, ''] }
          }
        },
        {
          $group: {
            _id: '$ipAddress',
            users: {
              $addToSet: {
                $cond: [{ $ne: ['$userId', null] }, '$userId', '$$REMOVE']
              }
            },
            sellers: {
              $addToSet: {
                $cond: [{ $ne: ['$sellerId', null] }, '$sellerId', '$$REMOVE']
              }
            },
            templates: {
              $addToSet: {
                $cond: [{ $ne: ['$templateId', null] }, '$templateId', '$$REMOVE']
              }
            },
            aiCalls: { $sum: 1 },
            successfulAsins: {
              $addToSet: {
                $cond: [
                  { $and: ['$success', { $ne: ['$asin', null] }, { $ne: ['$asin', ''] }] },
                  '$asin',
                  '$$REMOVE'
                ]
              }
            },
            totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
            promptTokens: { $sum: { $ifNull: ['$promptTokens', 0] } },
            completionTokens: { $sum: { $ifNull: ['$completionTokens', 0] } },
            firstUsedAt: { $min: '$timestamp' },
            lastUsedAt: { $max: '$timestamp' },
            ipSources: {
              $addToSet: {
                $cond: [
                  { $and: [{ $ne: ['$ipSource', null] }, { $ne: ['$ipSource', ''] }] },
                  '$ipSource',
                  '$$REMOVE'
                ]
              }
            }
          }
        },
        { $sort: { lastUsedAt: -1, totalTokens: -1, aiCalls: -1 } },
        {
          $project: {
            _id: 0,
            ipAddress: { $ifNull: ['$_id', 'Unknown IP'] },
            userCount: { $size: '$users' },
            sellerCount: { $size: '$sellers' },
            templateCount: { $size: '$templates' },
            successfulAsinCount: { $size: '$successfulAsins' },
            aiCalls: 1,
            totalTokens: 1,
            promptTokens: 1,
            completionTokens: 1,
            firstUsedAt: 1,
            lastUsedAt: 1,
            ipSources: 1
          }
        }
      ]),
      ApiUsage.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            aiCalls: { $sum: 1 },
            successfulCalls: { $sum: { $cond: ['$success', 1, 0] } },
            failedCalls: { $sum: { $cond: ['$success', 0, 1] } },
            uniqueIps: {
              $addToSet: {
                $cond: [
                  { $and: [{ $ne: ['$ipAddress', null] }, { $ne: ['$ipAddress', ''] }, { $ne: ['$ipSource', null] }, { $ne: ['$ipSource', ''] }] },
                  '$ipAddress',
                  '$$REMOVE'
                ]
              }
            },
            successfulAsins: {
              $addToSet: {
                $cond: [
                  { $and: ['$success', { $ne: ['$asin', null] }, { $ne: ['$asin', ''] }] },
                  '$asin',
                  '$$REMOVE'
                ]
              }
            },
            totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
            promptTokens: { $sum: { $ifNull: ['$promptTokens', 0] } },
            completionTokens: { $sum: { $ifNull: ['$completionTokens', 0] } }
          }
        },
        {
          $project: {
            _id: 0,
            aiCalls: 1,
            successfulCalls: 1,
            failedCalls: 1,
            uniqueIpCount: { $size: '$uniqueIps' },
            successfulAsinCount: { $size: '$successfulAsins' },
            totalTokens: 1,
            promptTokens: 1,
            completionTokens: 1
          }
        }
      ]),
      ApiUsage.aggregate([
        { $match: optionMatch },
        {
          $facet: {
            users: [
              { $match: { userId: { $ne: null } } },
              { $group: { _id: '$userId', count: { $sum: 1 }, lastUsedAt: { $max: '$timestamp' } } },
              { $sort: { count: -1 } },
              { $limit: 500 },
              { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
              {
                $project: {
                  _id: 0,
                  id: { $toString: '$_id' },
                  label: { $ifNull: [{ $arrayElemAt: ['$user.username', 0] }, 'Unknown user'] },
                  secondary: { $ifNull: [{ $arrayElemAt: ['$user.email', 0] }, { $arrayElemAt: ['$user.role', 0] }] },
                  count: 1,
                  lastUsedAt: 1
                }
              }
            ],
            sellers: [
              { $match: { sellerId: { $ne: null } } },
              { $group: { _id: '$sellerId', count: { $sum: 1 }, lastUsedAt: { $max: '$timestamp' } } },
              { $sort: { count: -1 } },
              { $limit: 500 },
              { $lookup: { from: 'sellers', localField: '_id', foreignField: '_id', as: 'seller' } },
              { $lookup: { from: 'users', localField: 'seller.user', foreignField: '_id', as: 'sellerUser' } },
              {
                $project: {
                  _id: 0,
                  id: { $toString: '$_id' },
                  label: { $ifNull: [{ $arrayElemAt: ['$sellerUser.username', 0] }, 'Unknown seller'] },
                  secondary: { $arrayElemAt: ['$sellerUser.email', 0] },
                  count: 1,
                  lastUsedAt: 1
                }
              }
            ],
            templates: [
              { $match: { templateId: { $ne: null } } },
              { $group: { _id: '$templateId', count: { $sum: 1 }, lastUsedAt: { $max: '$timestamp' } } },
              { $sort: { count: -1 } },
              { $limit: 500 },
              { $lookup: { from: 'listingtemplates', localField: '_id', foreignField: '_id', as: 'template' } },
              {
                $project: {
                  _id: 0,
                  id: { $toString: '$_id' },
                  label: { $ifNull: [{ $arrayElemAt: ['$template.name', 0] }, 'Unknown template'] },
                  count: 1,
                  lastUsedAt: 1
                }
              }
            ],
            ips: [
              { $match: { ipAddress: { $nin: [null, ''] }, ipSource: { $nin: [null, ''] } } },
              { $group: { _id: '$ipAddress', count: { $sum: 1 }, userIds: { $addToSet: '$userId' }, lastUsedAt: { $max: '$timestamp' } } },
              { $sort: { count: -1 } },
              { $limit: 500 },
              {
                $project: {
                  _id: 0,
                  id: '$_id',
                  label: '$_id',
                  count: 1,
                  userCount: { $size: '$userIds' },
                  lastUsedAt: 1
                }
              }
            ]
          }
        }
      ])
    ]);

    const filterOptions = filterOptionsAgg[0] || { users: [], sellers: [], templates: [], ips: [] };
    const rowsWithUsage = rows;
    let zeroCallRunRows = [];

    if (!ipAddress || ipAddress === 'all') {
      const runIdsWithUsage = rowsWithUsage
        .map(row => row.aiRunId)
        .filter(runId => runId && runId !== 'legacy-usage');
      const listingRunMatch = {};

      if (runIdsWithUsage.length > 0) {
        listingRunMatch.aiRunId = { $nin: runIdsWithUsage };
      }
      if (listingRunDateRange) {
        listingRunMatch.lastSavedFromReviewAt = listingRunDateRange;
      }
      if (userId && userId !== 'all' && mongoose.Types.ObjectId.isValid(userId)) {
        listingRunMatch.userId = new mongoose.Types.ObjectId(userId);
      }
      if (sellerId && sellerId !== 'all' && mongoose.Types.ObjectId.isValid(sellerId)) {
        listingRunMatch.sellerId = new mongoose.Types.ObjectId(sellerId);
      }
      if (templateId && templateId !== 'all' && mongoose.Types.ObjectId.isValid(templateId)) {
        listingRunMatch.templateId = new mongoose.Types.ObjectId(templateId);
      }

      zeroCallRunRows = await AiListingRun.aggregate([
        { $match: listingRunMatch },
        { $sort: { lastSavedFromReviewAt: -1, updatedAt: -1 } },
        { $limit: maxRows },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            as: 'user'
          }
        },
        {
          $lookup: {
            from: 'sellers',
            localField: 'sellerId',
            foreignField: '_id',
            as: 'seller'
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: 'seller.user',
            foreignField: '_id',
            as: 'sellerUser'
          }
        },
        {
          $lookup: {
            from: 'listingtemplates',
            localField: 'templateId',
            foreignField: '_id',
            as: 'template'
          }
        },
        {
          $project: {
            _id: 0,
            userId: 1,
            sellerId: 1,
            templateId: 1,
            aiRunId: 1,
            aiRunStartedAt: { $ifNull: ['$createdAt', '$lastSavedFromReviewAt'] },
            ipAddress: 'No OpenAI calls',
            ipSource: 'duplicate-skip',
            username: { $ifNull: [{ $arrayElemAt: ['$user.username', 0] }, 'Unknown user'] },
            userEmail: { $arrayElemAt: ['$user.email', 0] },
            userRole: { $arrayElemAt: ['$user.role', 0] },
            sellerName: { $ifNull: [{ $arrayElemAt: ['$sellerUser.username', 0] }, 'Unknown seller'] },
            sellerEmail: { $arrayElemAt: ['$sellerUser.email', 0] },
            templateName: { $ifNull: [{ $arrayElemAt: ['$template.name', 0] }, 'Unknown template'] },
            aiCalls: { $literal: 0 },
            successfulCalls: { $literal: 0 },
            failedCalls: { $literal: 0 },
            savedFromReviewCount: { $ifNull: ['$savedFromReviewCount', 0] },
            updateableDuplicateCount: { $ifNull: ['$updateableDuplicateCount', 0] },
            dismissedFromReviewCount: { $ifNull: ['$dismissedFromReviewCount', 0] },
            dismissedNewAsinCount: { $ifNull: ['$dismissedNewAsinCount', 0] },
            dismissedUpdateableDuplicateCount: { $ifNull: ['$dismissedUpdateableDuplicateCount', 0] },
            reviewSaveAttempts: { $ifNull: ['$reviewSaveAttempts', 0] },
            lastSavedFromReviewAt: 1,
            successfulAsinCount: { $literal: 0 },
            successfulAsinRunCount: { $literal: 0 },
            successfulAsinRuns: { $literal: [] },
            totalTokens: { $literal: 0 },
            promptTokens: { $literal: 0 },
            completionTokens: { $literal: 0 },
            avgResponseTime: { $literal: null },
            userAgents: { $literal: [] },
            firstUsedAt: '$lastSavedFromReviewAt',
            lastUsedAt: '$lastSavedFromReviewAt'
          }
        }
      ]);
    }

    const combinedRows = [...rowsWithUsage, ...zeroCallRunRows]
      .sort((a, b) => new Date(b.lastUsedAt || b.lastSavedFromReviewAt || 0) - new Date(a.lastUsedAt || a.lastSavedFromReviewAt || 0))
      .slice(0, maxRows);

    const expectedAiFieldCountByPair = new Map();
    const pairInputs = [
      ...combinedRows.map((row) => ({ sellerId: row.sellerId, templateId: row.templateId })),
      ...asinCallBreakdown.map((row) => ({ sellerId: row.sellerId, templateId: row.templateId }))
    ];

    await Promise.all(pairInputs.map(async ({ sellerId: pairSellerId, templateId: pairTemplateId }) => {
      if (!pairSellerId || !pairTemplateId) return;
      const key = `${pairSellerId}-${pairTemplateId}`;
      if (expectedAiFieldCountByPair.has(key)) return;
      expectedAiFieldCountByPair.set(key, 0);
      try {
        const effectiveTemplate = await getEffectiveTemplate(pairTemplateId, pairSellerId);
        const expectedAiFields = (effectiveTemplate.asinAutomation?.fieldConfigs || [])
          .filter((config) => config.enabled && config.source === 'ai')
          .map((config) => config.ebayField);
        expectedAiFieldCountByPair.set(key, expectedAiFields.length);
      } catch (err) {
        console.warn('[OpenAI Usage Summary] Failed to resolve expected AI fields:', err.message);
      }
    }));

    const savedCounts = await TemplateListing.aggregate([
      { $match: { aiRunId: { $ne: null } } },
      {
        $group: {
          _id: '$aiRunId',
          savedCount: { $sum: 1 }
        }
      }
    ]);

    const savedCountsMap = new Map();
    savedCounts.forEach(item => {
      if (item._id) {
        savedCountsMap.set(item._id, item.savedCount);
      }
    });

    const rowsWithExpected = combinedRows.map((row) => {
      const expectedAiFieldCount = expectedAiFieldCountByPair.get(`${row.sellerId}-${row.templateId}`) || 0;
      const savedCount = Math.max(
        Number(savedCountsMap.get(row.aiRunId) || 0),
        Number(row.savedFromReviewCount || 0)
      );
      return {
        ...row,
        expectedAiFieldCount,
        expectedAiCalls: expectedAiFieldCount * (row.successfulAsinCount || 0),
        overExpectedCalls: Math.max(0, (row.aiCalls || 0) - (expectedAiFieldCount * (row.successfulAsinCount || 0))),
        savedCount
      };
    });

    const asinCallBreakdownWithExpected = asinCallBreakdown.map((row) => {
      const expectedAiFieldCount = expectedAiFieldCountByPair.get(`${row.sellerId}-${row.templateId}`) || 0;
      return {
        ...row,
        expectedAiFieldCount,
        overExpectedCalls: Math.max(0, (row.aiCalls || 0) - expectedAiFieldCount)
      };
    }).filter((row) => row.overExpectedCalls > 0);
    const totals = totalsAgg[0] || {
      aiCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      uniqueIpCount: 0,
      successfulAsinCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0
    };
    totals.savedFromReviewCount = rowsWithExpected.reduce(
      (sum, row) => sum + Number(row.savedFromReviewCount || 0),
      0
    );

    res.json({
      success: true,
      rows: rowsWithExpected,
      fieldBreakdown,
      fieldAsinBreakdown,
      asinCallBreakdown: asinCallBreakdownWithExpected,
      ipBreakdown,
      filterOptions,
      totals
    });
  } catch (error) {
    console.error('[OpenAI Usage Summary] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch OpenAI usage summary' });
  }
});

// ASIN Precheck AI usage (eBay Motors title eligibility checks) — kept separate
// from the Add Template Listings usage above (that endpoint excludes fieldType 'precheck').
router.get('/api/precheck-usage-summary', requireAuth, async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      startDateTime,
      endDateTime,
      userId,
      sellerId,
      templateId,
      limit = 500
    } = req.query;

    const match = { service: 'OpenAI', fieldType: 'precheck' };

    if (startDateTime || endDateTime) {
      match.timestamp = {};
      if (startDateTime) match.timestamp.$gte = parseIstDateTime(startDateTime);
      if (endDateTime) match.timestamp.$lte = parseIstDateTime(endDateTime);
    } else if (startDate || endDate) {
      match.timestamp = {};
      if (startDate) match.timestamp.$gte = parseIstDateBoundary(startDate);
      if (endDate) match.timestamp.$lte = parseIstDateBoundary(endDate, true);
    }

    if (userId && userId !== 'all' && mongoose.Types.ObjectId.isValid(userId)) {
      match.userId = new mongoose.Types.ObjectId(userId);
    }
    if (sellerId && sellerId !== 'all' && mongoose.Types.ObjectId.isValid(sellerId)) {
      match.sellerId = new mongoose.Types.ObjectId(sellerId);
    }
    if (templateId && templateId !== 'all' && mongoose.Types.ObjectId.isValid(templateId)) {
      match.templateId = new mongoose.Types.ObjectId(templateId);
    }

    const maxRows = Math.min(parseInt(limit, 10) || 500, 2000);

    const [rows, totalsAgg, filterOptionsAgg] = await Promise.all([
      ApiUsage.aggregate([
        { $match: match },
        {
          $group: {
            _id: { userId: '$userId', sellerId: '$sellerId', templateId: '$templateId' },
            aiCalls: { $sum: 1 },
            successfulCalls: { $sum: { $cond: ['$success', 1, 0] } },
            failedCalls: { $sum: { $cond: ['$success', 0, 1] } },
            asins: {
              $addToSet: {
                $cond: [{ $and: [{ $ne: ['$asin', null] }, { $ne: ['$asin', ''] }] }, '$asin', '$$REMOVE']
              }
            },
            totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
            promptTokens: { $sum: { $ifNull: ['$promptTokens', 0] } },
            completionTokens: { $sum: { $ifNull: ['$completionTokens', 0] } },
            firstUsedAt: { $min: '$timestamp' },
            lastUsedAt: { $max: '$timestamp' }
          }
        },
        { $lookup: { from: 'users', localField: '_id.userId', foreignField: '_id', as: 'user' } },
        { $lookup: { from: 'sellers', localField: '_id.sellerId', foreignField: '_id', as: 'seller' } },
        { $lookup: { from: 'users', localField: 'seller.user', foreignField: '_id', as: 'sellerUser' } },
        { $lookup: { from: 'listingtemplates', localField: '_id.templateId', foreignField: '_id', as: 'template' } },
        { $sort: { lastUsedAt: -1 } },
        { $limit: maxRows },
        {
          $project: {
            _id: 0,
            userId: '$_id.userId',
            sellerId: '$_id.sellerId',
            templateId: '$_id.templateId',
            username: { $ifNull: [{ $arrayElemAt: ['$user.username', 0] }, 'Unknown user'] },
            userEmail: { $arrayElemAt: ['$user.email', 0] },
            sellerName: { $ifNull: [{ $arrayElemAt: ['$sellerUser.username', 0] }, 'Unknown seller'] },
            templateName: { $ifNull: [{ $arrayElemAt: ['$template.name', 0] }, 'Unknown template'] },
            asinCount: { $size: '$asins' },
            aiCalls: 1,
            successfulCalls: 1,
            failedCalls: 1,
            totalTokens: 1,
            promptTokens: 1,
            completionTokens: 1,
            firstUsedAt: 1,
            lastUsedAt: 1
          }
        }
      ]),
      ApiUsage.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            aiCalls: { $sum: 1 },
            successfulCalls: { $sum: { $cond: ['$success', 1, 0] } },
            failedCalls: { $sum: { $cond: ['$success', 0, 1] } },
            asins: {
              $addToSet: {
                $cond: [{ $and: [{ $ne: ['$asin', null] }, { $ne: ['$asin', ''] }] }, '$asin', '$$REMOVE']
              }
            },
            users: { $addToSet: '$userId' },
            templates: { $addToSet: '$templateId' },
            totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
            promptTokens: { $sum: { $ifNull: ['$promptTokens', 0] } },
            completionTokens: { $sum: { $ifNull: ['$completionTokens', 0] } }
          }
        },
        {
          $project: {
            _id: 0,
            aiCalls: 1,
            successfulCalls: 1,
            failedCalls: 1,
            asinCount: { $size: '$asins' },
            userCount: { $size: '$users' },
            templateCount: { $size: '$templates' },
            totalTokens: 1,
            promptTokens: 1,
            completionTokens: 1
          }
        }
      ]),
      ApiUsage.aggregate([
        { $match: match },
        {
          $facet: {
            users: [
              { $match: { userId: { $ne: null } } },
              { $group: { _id: '$userId', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 500 },
              { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
              {
                $project: {
                  _id: 0,
                  id: { $toString: '$_id' },
                  label: { $ifNull: [{ $arrayElemAt: ['$user.username', 0] }, 'Unknown user'] },
                  secondary: { $arrayElemAt: ['$user.email', 0] },
                  count: 1
                }
              }
            ],
            sellers: [
              { $match: { sellerId: { $ne: null } } },
              { $group: { _id: '$sellerId', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 500 },
              { $lookup: { from: 'sellers', localField: '_id', foreignField: '_id', as: 'seller' } },
              { $lookup: { from: 'users', localField: 'seller.user', foreignField: '_id', as: 'sellerUser' } },
              {
                $project: {
                  _id: 0,
                  id: { $toString: '$_id' },
                  label: { $ifNull: [{ $arrayElemAt: ['$sellerUser.username', 0] }, 'Unknown seller'] },
                  secondary: { $arrayElemAt: ['$sellerUser.email', 0] },
                  count: 1
                }
              }
            ],
            templates: [
              { $match: { templateId: { $ne: null } } },
              { $group: { _id: '$templateId', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 500 },
              { $lookup: { from: 'listingtemplates', localField: '_id', foreignField: '_id', as: 'template' } },
              {
                $project: {
                  _id: 0,
                  id: { $toString: '$_id' },
                  label: { $ifNull: [{ $arrayElemAt: ['$template.name', 0] }, 'Unknown template'] },
                  count: 1
                }
              }
            ]
          }
        }
      ])
    ]);

    const totals = totalsAgg[0] || {
      aiCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      asinCount: 0,
      userCount: 0,
      templateCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0
    };

    res.json({
      success: true,
      rows,
      totals,
      filterOptions: filterOptionsAgg[0] || { users: [], sellers: [], templates: [] }
    });
  } catch (error) {
    console.error('[Precheck Usage Summary] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch precheck usage summary' });
  }
});

/**
 * @swagger
 * /template-listings/api/seller/{sellerId}/template-listings/api-usage-stats:
 *   get:
 *     tags: [Template Listings – Admin]
 *     summary: API usage statistics (ScraperAPI / PAAPI / Gemini)
 *     description: Returns monthly usage totals per service. Optionally filter by service name, year, and month.
 *     parameters:
 *       - in: path
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: service
 *         schema: { type: string }
 *         description: scraperapi | paapi | gemini
 *       - in: query
 *         name: year
 *         schema: { type: integer, example: 2024 }
 *       - in: query
 *         name: month
 *         schema: { type: integer, example: 6 }
 *     responses:
 *       200:
 *         description: Usage statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 stats:   { type: object }
 *                 message: { type: string }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
router.get('/api/seller/:sellerId/template-listings/api-usage-stats', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { service, year, month } = req.query;

    // Build query
    const query = {};
    if (service) query.service = service;
    if (year) query.year = parseInt(year);
    if (month) query.month = parseInt(month);

    const stats = await getUsageStats(query);

    res.json({
      success: true,
      stats,
      message: `Retrieved usage statistics${service ? ` for ${service}` : ''}`
    });
  } catch (error) {
    console.error('[API Usage Stats] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /template-listings/api/seller/{sellerId}/template-listings/api-usage-field-stats:
 *   get:
 *     tags: [Template Listings – Admin]
 *     summary: Field extraction statistics for a service
 *     description: Returns per-field extraction success/failure counts for the given service and period.
 *     parameters:
 *       - in: path
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: service
 *         required: true
 *         schema: { type: string }
 *         description: scraperapi | paapi | gemini
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Field extraction statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 stats:   { type: object }
 *                 message: { type: string }
 *       400: { description: service parameter is required }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
router.get('/api/seller/:sellerId/template-listings/api-usage-field-stats', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { service, year, month } = req.query;

    if (!service) {
      return res.status(400).json({
        success: false,
        message: 'Service parameter is required'
      });
    }

    const query = { service };
    if (year) query.year = parseInt(year);
    if (month) query.month = parseInt(month);

    const stats = await getFieldExtractionStats(query);

    res.json({
      success: true,
      stats,
      message: `Retrieved field extraction statistics for ${service}`
    });
  } catch (error) {
    console.error('[API Field Stats] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /template-listings/api/seller/{sellerId}/template-listings/api-usage-errors:
 *   get:
 *     tags: [Template Listings – Admin]
 *     summary: Recent API errors for a service
 *     parameters:
 *       - in: path
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: service
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Recent error records
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 errors:  { type: array, items: { type: object } }
 *                 count:   { type: integer }
 *                 message: { type: string }
 *       400: { description: service parameter is required }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
router.get('/api/seller/:sellerId/template-listings/api-usage-errors', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { service, limit = 50 } = req.query;

    if (!service) {
      return res.status(400).json({
        success: false,
        message: 'Service parameter is required'
      });
    }

    const errors = await getRecentErrors(service, parseInt(limit));

    res.json({
      success: true,
      errors,
      count: errors.length,
      message: `Retrieved ${errors.length} recent errors for ${service}`
    });
  } catch (error) {
    console.error('[API Errors] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /template-listings/api/seller/{sellerId}/template-listings/api-quota-status:
 *   get:
 *     tags: [Template Listings – Admin]
 *     summary: Quota status for a service
 *     description: Checks current period usage against the specified quota and returns a status of `ok`, `warning`, or `exceeded`.
 *     parameters:
 *       - in: path
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: service
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: quota
 *         schema: { type: integer, default: 5000 }
 *         description: Monthly quota limit to check against
 *     responses:
 *       200:
 *         description: Quota status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:     { type: boolean }
 *                 quotaStatus:
 *                   type: object
 *                   properties:
 *                     status:      { type: string, enum: [ok, warning, exceeded] }
 *                     percentUsed: { type: number }
 *                     used:        { type: integer }
 *                     limit:       { type: integer }
 *                 message: { type: string }
 *       400: { description: service parameter is required }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
router.get('/api/seller/:sellerId/template-listings/api-quota-status', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { service, quota = 5000 } = req.query;

    if (!service) {
      return res.status(400).json({
        success: false,
        message: 'Service parameter is required'
      });
    }

    const status = await checkQuotaStatus(service, parseInt(quota));

    res.json({
      success: true,
      quotaStatus: status,
      message: `Quota status: ${status.status.toUpperCase()} - ${status.percentUsed}% used`
    });
  } catch (error) {
    console.error('[Quota Status] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /template-listings/cache-stats:
 *   get:
 *     tags: [Template Listings – Admin]
 *     summary: ASIN cache statistics
 *     description: Returns NodeCache stats for the in-memory ASIN cache (hit rate, key count, enabled state) alongside process memory usage.
 *     responses:
 *       200:
 *         description: Cache statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 cache:
 *                   type: object
 *                   properties:
 *                     enabled: { type: boolean }
 *                     keys:    { type: integer, example: 42 }
 *                     hitRate: { type: number, example: 78.5 }
 *                 memory:
 *                   description: Process memory in MB, plus uptime in minutes.
 *                   type: object
 *                   properties:
 *                     rss:           { type: integer, example: 1642 }
 *                     heapUsed:      { type: integer, example: 412 }
 *                     heapTotal:     { type: integer, example: 520 }
 *                     external:      { type: integer, example: 980 }
 *                     arrayBuffers:  { type: integer, example: 910 }
 *                     uptimeMinutes: { type: integer, example: 3140 }
 *                 message: { type: string }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
router.get('/cache-stats', requireAuth, async (req, res) => {
  try {
    const stats = getAsinCacheStats();
    const mem = process.memoryUsage();
    const mb = (bytes) => Math.round(bytes / 1024 / 1024);

    res.json({
      success: true,
      cache: stats,
      // node-cache's own `vsize` counts a flat 80 bytes per top-level key and
      // does not recurse, so it tracks entry count rather than bytes. These are
      // the numbers that actually show whether memory is growing, and where:
      // heapUsed rising with cache.keys points at the cache; rss and external
      // rising while heapUsed stays flat points off-heap (sharp decode buffers),
      // which --max-old-space-size does not bound and Render still kills on.
      memory: {
        rss: mb(mem.rss),
        heapUsed: mb(mem.heapUsed),
        heapTotal: mb(mem.heapTotal),
        external: mb(mem.external),
        arrayBuffers: mb(mem.arrayBuffers),
        uptimeMinutes: Math.round(process.uptime() / 60)
      },
      message: `Cache ${stats.enabled ? 'enabled' : 'disabled'} - ${stats.keys} ASINs cached, ${stats.hitRate}% hit rate | rss ${mb(mem.rss)}MB, heap ${mb(mem.heapUsed)}MB`
    });
  } catch (error) {
    console.error('[Cache Stats] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /template-listings/cache-clear:
 *   post:
 *     tags: [Template Listings – Admin]
 *     summary: Clear the ASIN cache
 *     description: Flushes the entire in-memory NodeCache for ASINs. Useful after updating ASIN data or troubleshooting stale results.
 *     responses:
 *       200:
 *         description: Cache cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string, example: ASIN cache cleared successfully }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
router.post('/cache-clear', requireAuth, async (req, res) => {
  try {
    clearAsinCache();

    res.json({
      success: true,
      message: 'ASIN cache cleared successfully'
    });
  } catch (error) {
    console.error('[Cache Clear] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * POST /template-listings/cache-invalidate/:asin
 * Invalidate specific ASIN from cache
 */
router.post('/cache-invalidate/:asin', requireAuth, async (req, res) => {
  try {
    const { asin } = req.params;
    const invalidated = invalidateAsinCache(asin);

    res.json({
      success: true,
      invalidated,
      message: invalidated ? `ASIN ${asin} removed from cache` : `ASIN ${asin} not found in cache`
    });
  } catch (error) {
    console.error('[Cache Invalidate] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Last in the file, so it only sees requests that matched no route above it.
//
// Before requireObjectId, a malformed id was caught by the /:id handler and
// answered with a 500. Now it falls through to here, and the app has no 404
// handler of its own — without this the reply would be Express's default HTML
// page, which an API client parsing JSON handles worse than the 500 it replaces.
//
// baseUrl + path, not req.path, which is mount-relative and so reports a bare
// '/garbage'. Not req.originalUrl either: that carries the query string, and
// tokens travel in query strings on this app — the full path is the useful part
// for whoever is debugging, the credentials are not.
router.use((req, res) => {
  res.status(404).json({ error: `No such template-listings route: ${req.method} ${req.baseUrl}${req.path}` });
});

export default router;

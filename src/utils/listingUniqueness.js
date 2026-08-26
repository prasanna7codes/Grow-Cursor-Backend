import TemplateListing from '../models/TemplateListing.js';
import SellerSkuIndex from '../models/SellerSkuIndex.js';
import { generateSKUFromASIN } from './skuGenerator.js';
import { makeUniquenessRephraser } from './titleRephraser.js';

/**
 * Cross-seller title and price uniqueness.
 *
 * WHAT COUNTS AS A COLLISION
 * --------------------------
 * The review modal's "Same SKU exists in N synced listings / Other sellers: N /
 * Title different / Price different" panel is the operator's source of truth,
 * and it matches on BASE SKU against SellerSkuIndex — the locally synced index
 * of listings that are actually live on eBay. Base SKU is GRW25 + the last five
 * characters of the ASIN, so every seller listing the same ASIN shares one.
 *
 * This module deliberately uses the same key, because a guarantee the operator
 * cannot see in that panel is not worth much. It also unions in TemplateListing
 * rows for the same ASIN: those are listings this tool has generated that may
 * not have been synced to the index yet, and they collide just as hard.
 *
 * WHY BOTH FIELDS
 * ---------------
 *   TITLE — generated from the same Amazon source through the same template
 *           field configs, so two sellers land on the same or near enough.
 *   PRICE — calculateStartPrice() is a pure function of pricingConfig and the
 *           Amazon cost. Same ASIN + same template = a byte-identical price for
 *           every seller, every time.
 *
 * The review modal already steps a colliding price upward in 20-cent
 * increments client-side. This module uses the SAME step so that the server's
 * save-time guard and the modal never disagree about what a clean price is.
 */

// Matches the modal's getNextNonMatchingPrice(..., 20) default so the two
// layers land on the same figure for the same inputs.
export const DEFAULT_PRICE_STEP_CENTS = 20;

// A price cannot climb forever looking for a gap.
const MAX_PRICE_STEPS = 100;

/**
 * Comparison form for titles.
 *
 * The modal normalizes case and whitespace only. This also strips punctuation,
 * which makes it a strict superset: everything the modal flags is flagged here,
 * plus near-misses like "Case, Black" against "Case Black" that eBay would
 * still read as the same listing. It can never leave a collision the operator
 * can see unresolved.
 */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Matches the modal's getComparablePrice: strip currency, two decimals. */
function toComparablePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function toCents(value) {
  const price = toComparablePrice(value);
  return price === null ? null : Math.round(price * 100);
}

/** The shared key: GRW25 + last 5 of the ASIN, as the SKU index stores it. */
export function baseSkuForAsin(asin) {
  return generateSKUFromASIN(String(asin || '').toUpperCase());
}

/**
 * Every OTHER seller's listing that shares a base SKU with these ASINs.
 *
 * Reads two sources and unions them:
 *   SellerSkuIndex  — live on eBay, matched by baseSku. This is what the review
 *                     modal shows, so it is the one that must not be missed.
 *   TemplateListing — generated here, matched by ASIN. Catches anything saved
 *                     but not yet synced into the index.
 *
 * @param {string[]} asins
 * @param {Object}   [opts]
 * @param {string}   [opts.excludeSellerId] - the seller being listed for; their
 *   own listings are not a cross-seller collision
 * @param {string}   [opts.excludeListingId]
 * @returns {Promise<Map<string, {titles: string[], prices: number[], liveCount: number}>>}
 *   keyed by uppercased ASIN
 */
export async function loadAsinSiblings(asins, { excludeSellerId = null, excludeListingId = null } = {}) {
  const wanted = [...new Set((asins || []).map(a => String(a).toUpperCase()).filter(Boolean))];
  const siblings = new Map(wanted.map(asin => [asin, { titles: [], prices: [], liveCount: 0 }]));

  if (wanted.length === 0) return siblings;

  // baseSku -> ASIN, so index rows can be attributed back.
  const asinByBaseSku = new Map();
  for (const asin of wanted) {
    const baseSku = baseSkuForAsin(asin);
    if (baseSku) asinByBaseSku.set(baseSku, asin);
  }
  const baseSkus = [...asinByBaseSku.keys()];

  const skuIndexQuery = { baseSku: { $in: baseSkus } };
  if (excludeSellerId) skuIndexQuery.seller = { $ne: excludeSellerId };

  const listingQuery = {
    _asinReference: { $in: wanted },
    status: { $in: ['active', 'draft'] }
  };
  if (excludeSellerId) listingQuery.sellerId = { $ne: excludeSellerId };
  if (excludeListingId) listingQuery._id = { $ne: excludeListingId };

  const [liveRecords, generatedRecords] = await Promise.all([
    baseSkus.length > 0
      ? SellerSkuIndex.find(skuIndexQuery).select('baseSku title price').lean()
      : [],
    TemplateListing.find(listingQuery).select('+_asinReference title startPrice').lean()
  ]);

  for (const record of liveRecords) {
    const asin = asinByBaseSku.get(record.baseSku);
    const entry = asin && siblings.get(asin);
    if (!entry) continue;

    entry.liveCount += 1;
    if (record.title) entry.titles.push(record.title);
    const price = toComparablePrice(record.price);
    if (price !== null && price > 0) entry.prices.push(price);
  }

  for (const listing of generatedRecords) {
    const entry = siblings.get(String(listing._asinReference || '').toUpperCase());
    if (!entry) continue;

    if (listing.title) entry.titles.push(listing.title);
    const price = toComparablePrice(listing.startPrice);
    if (price !== null && price > 0) entry.prices.push(price);
  }

  return siblings;
}

/**
 * A price no other seller is using for this base SKU.
 *
 * Steps upward, never down: a downward offset eats margin and a profit tier can
 * sit right on a floor. Same algorithm and default step as the review modal, so
 * both layers agree.
 *
 * @returns {{price, adjusted, steps, exhausted}}
 */
export function resolveUniquePrice({
  basePrice,
  siblingPrices = [],
  stepCents = DEFAULT_PRICE_STEP_CENTS
}) {
  const startCents = toCents(basePrice);

  if (startCents === null || startCents <= 0) {
    return { price: basePrice, adjusted: false, steps: 0, exhausted: false };
  }

  const step = Math.max(1, Math.round(Number(stepCents) || DEFAULT_PRICE_STEP_CENTS));
  const taken = new Set(siblingPrices.map(toCents).filter(cents => cents !== null));

  if (!taken.has(startCents)) {
    return { price: Number((startCents / 100).toFixed(2)), adjusted: false, steps: 0, exhausted: false };
  }

  let cents = startCents;
  for (let attempt = 1; attempt <= MAX_PRICE_STEPS; attempt++) {
    cents += step;
    if (!taken.has(cents)) {
      return { price: Number((cents / 100).toFixed(2)), adjusted: true, steps: attempt, exhausted: false };
    }
  }

  // Nothing clear within reach. Report it rather than returning a known clash.
  return {
    price: Number((cents / 100).toFixed(2)),
    adjusted: true,
    steps: MAX_PRICE_STEPS,
    exhausted: true
  };
}

/**
 * A title no other seller is using for this base SKU.
 *
 * `rephrase` is injected rather than imported so this stays testable without an
 * OpenAI key, and so the caller controls which usage context the spend lands in.
 *
 * @returns {Promise<{title, adjusted, unique, attempts, warning}>}
 */
export async function resolveUniqueTitle({
  title,
  siblingTitles = [],
  rephrase,
  maxAttempts = 3
}) {
  const taken = new Set(siblingTitles.map(normalizeTitle).filter(Boolean));

  if (!taken.has(normalizeTitle(title))) {
    return { title, adjusted: false, unique: true, attempts: 0, warning: null };
  }

  if (typeof rephrase !== 'function') {
    return {
      title,
      adjusted: false,
      unique: false,
      attempts: 0,
      warning: 'Title matches another seller\'s listing for this SKU and could not be rephrased automatically.'
    };
  }

  let current = title;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let candidate;
    try {
      candidate = await rephrase(current, attempt);
    } catch (error) {
      return {
        title: current,
        adjusted: current !== title,
        unique: false,
        attempts: attempt,
        warning: `Automatic rephrase failed (${error.message}) — title may match another seller's listing.`
      };
    }

    candidate = String(candidate || '').trim();
    if (!candidate) continue;

    current = candidate;
    if (!taken.has(normalizeTitle(candidate))) {
      return { title: candidate, adjusted: true, unique: true, attempts: attempt, warning: null };
    }
  }

  // Surfaced to the review UI rather than silently saved — the operator can
  // still edit the title by hand before it goes out.
  return {
    title: current,
    adjusted: current !== title,
    unique: false,
    attempts: maxAttempts,
    warning: `Title still matches another seller's listing for this SKU after ${maxAttempts} rephrase attempts — edit it before saving.`
  };
}

/**
 * Both checks for one listing.
 */
export async function applyUniqueness({
  title,
  price,
  siblings = { titles: [], prices: [] },
  rephrase,
  stepCents = DEFAULT_PRICE_STEP_CENTS,
  maxAttempts = 3
}) {
  const titleOutcome = await resolveUniqueTitle({
    title,
    siblingTitles: siblings.titles,
    rephrase,
    maxAttempts
  });

  const priceOutcome = resolveUniquePrice({
    basePrice: price,
    siblingPrices: siblings.prices,
    stepCents
  });

  const warnings = [];
  if (titleOutcome.warning) warnings.push(titleOutcome.warning);
  if (priceOutcome.exhausted) {
    warnings.push('Could not find a price no other seller is using for this SKU — check the price before saving.');
  }

  return {
    title: titleOutcome.title,
    price: priceOutcome.price,
    titleAdjusted: titleOutcome.adjusted,
    priceAdjusted: priceOutcome.adjusted,
    priceSteps: priceOutcome.steps,
    rephraseAttempts: titleOutcome.attempts,
    warnings
  };
}

/**
 * The pipeline's entry point: read the template's settings, build a rephraser
 * bound to this run's AI usage context, and resolve both fields.
 *
 * Returns the inputs untouched when the template opts out or nothing collides,
 * so a template that has not enabled this behaves exactly as it did before.
 */
export async function applyListingUniqueness({
  asin,
  sellerId,
  title,
  price,
  siblings,
  pricingConfig = {},
  sourceData = {},
  usageContext = null
}) {
  const enabled = pricingConfig.enforceCrossSellerUniqueness !== false;
  const stepCents = pricingConfig.priceUniquenessStepCents ?? DEFAULT_PRICE_STEP_CENTS;

  const entry = siblings || { titles: [], prices: [] };
  const nothingToCollideWith = entry.titles.length === 0 && entry.prices.length === 0;

  if (!enabled || nothingToCollideWith) {
    return {
      title,
      price,
      titleAdjusted: false,
      priceAdjusted: false,
      priceSteps: 0,
      rephraseAttempts: 0,
      warnings: []
    };
  }

  const outcome = await applyUniqueness({
    title,
    price,
    siblings: entry,
    rephrase: makeUniquenessRephraser({ sourceData, usageContext }),
    stepCents
  });

  return {
    ...outcome,
    // startPrice travels as a string in some pipeline paths; give back the same
    // type that came in so nothing downstream has to change.
    price: typeof price === 'string' ? outcome.price.toFixed(2) : outcome.price
  };
}

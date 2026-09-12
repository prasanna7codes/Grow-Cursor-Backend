/**
 * Marketplace tables and run-configuration rules for the Amazon Delivery Date
 * Check.
 *
 * Kept apart from the route module purely so it can be unit-tested: importing
 * the route pulls in ebay.js, which starts background intervals and would hang
 * the test runner. Everything here is pure.
 *
 * These are private copies of the marketplace values rather than imports from
 * amazonStockChecks.js — the delivery check has its own postal-code policy
 * (delivery estimates are location-dependent in a way stock text is not), so
 * the two configs need room to diverge without either page changing the other.
 */

/**
 * Delivery destinations, one per marketplace.
 *
 * These are the addresses every delivery quote is priced for, and the choice
 * is load-bearing: an unpinned request is quoted from wherever the scraper
 * lands and reproducibly returns a slower offer than a pinned one (measured on
 * B00KF05JV0 — pinned 9 days via one seller, unpinned 11 days via another,
 * identical across repeat runs). US is Casper WY 82601 to match the delivery
 * address on the account these listings are checked against.
 *
 * The env vars are AMAZON_DELIVERY_POSTAL_* rather than the SCRAPINGDOG_POSTAL_*
 * pair the stock check declares: the stock check never sends a postal code, and
 * sharing the name would let a value set for it silently re-point this page's
 * delivery quotes somewhere else.
 */
export const COUNTRY_CONFIG = {
  USD: { currency: 'USD', country: 'United States', domain: 'com', scrapingdogCountry: 'us', credits: 1, postalCode: process.env.AMAZON_DELIVERY_POSTAL_USD ?? '82601' },
  AUD: { currency: 'AUD', country: 'Australia', domain: 'com.au', scrapingdogCountry: 'au', credits: 5, postalCode: process.env.AMAZON_DELIVERY_POSTAL_AUD ?? '2000' },
  CAD: { currency: 'CAD', country: 'Canada', domain: 'ca', scrapingdogCountry: 'ca', credits: 5, postalCode: process.env.AMAZON_DELIVERY_POSTAL_CAD ?? 'A1A 1A1' },
  GBP: { currency: 'GBP', country: 'United Kingdom', domain: 'co.uk', scrapingdogCountry: 'gb', credits: 5, postalCode: process.env.AMAZON_DELIVERY_POSTAL_GBP ?? 'SW1A 1AA' }
};

export const PILOT_OPTION_B_LIMITS = {
  USD: 100,
  AUD: 10,
  CAD: 5,
  GBP: 4
};

export const DEFAULT_MAX_DELIVERY_DAYS = 9;
export const DEFAULT_TEST_PILOT_SKUS = 25;
export const MAX_TEST_PILOT_SKUS = 500;

// test_pilot: how many index rows to scan per checkable SKU asked for. Only a
// minority of base SKUs resolve to an ASIN (most of the index has no template
// reference), so a run for 25 checkable SKUs has to look at far more than 25
// candidates. The ceiling stops a large test from becoming a full-collection
// scan; if it is hit, the run reports skuLimitUnmet.
const TEST_PILOT_SCAN_MULTIPLIER = Math.max(2, Number.parseInt(process.env.AMAZON_DELIVERY_TEST_SCAN_MULTIPLIER || '50', 10));
const TEST_PILOT_SCAN_CEILING = Math.max(500, Number.parseInt(process.env.AMAZON_DELIVERY_TEST_SCAN_CEILING || '20000', 10));

const RUN_MODES = ['test_pilot', 'pilot_option_b', 'full', 'custom'];

export function normalizeCurrency(value) {
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
export function currencyAliases(currency) {
  const normalized = normalizeCurrency(currency);
  return normalized === 'GBP' ? ['GBP', 'GB'] : [normalized];
}

/** A seller-scoped request is always 'seller'; otherwise take a known mode. */
export function resolveMode(rawMode, sellerId) {
  if (sellerId) return 'seller';
  const mode = String(rawMode || '').trim();
  return RUN_MODES.includes(mode) ? mode : 'custom';
}

/**
 * Currencies for a mode. Accepts the query-string form ("USD,GBP") and the
 * JSON body form (["USD"]). test_pilot is deliberately single-region: it
 * exists to try the check against one marketplace before committing.
 */
export function resolveCurrencies(mode, rawCurrencies) {
  if (mode === 'pilot_option_b') return Object.keys(PILOT_OPTION_B_LIMITS);
  if (mode === 'full') return Object.keys(COUNTRY_CONFIG);

  const list = (Array.isArray(rawCurrencies) ? rawCurrencies : String(rawCurrencies || '').split(','))
    .map(normalizeCurrency)
    .filter((cur) => getConfig(cur));

  if (mode === 'test_pilot') return [list[0] || 'USD'];
  return list.length ? list : ['USD'];
}

/** Clamp a requested test-pilot size to something a test run should be. */
export function normalizeSkuLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TEST_PILOT_SKUS;
  return Math.min(MAX_TEST_PILOT_SKUS, parsed);
}

/** How many candidate rows to pull to stand a good chance of finding `skuLimit` ASINs. */
export function getTestPilotScanLimit(skuLimit) {
  return Math.min(TEST_PILOT_SCAN_CEILING, normalizeSkuLimit(skuLimit) * TEST_PILOT_SCAN_MULTIPLIER);
}

export function normalizeMaxDeliveryDays(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_DELIVERY_DAYS;
  // 0 is meaningful (same-day only); the upper bound just stops a typo from
  // creating a run where nothing can ever be flagged.
  return Math.min(365, Math.max(0, parsed));
}

/** Credits one run would spend, given the rows that resolved to an ASIN. */
export function estimateCredits(candidates) {
  return candidates.reduce((sum, row) => sum + (getConfig(row.currency)?.credits || 0), 0);
}

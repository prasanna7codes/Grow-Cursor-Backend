import axios from 'axios';
import pLimit from 'p-limit';
import { trackApiUsage } from './apiUsageTracker.js';

/**
 * Scrapingdog - Amazon Search (ASIN sourcing)
 *
 * Sibling to scrapingdogProduct.js. Where that client turns one ASIN into a
 * full product record, this one turns a keyword into a page of ASINs, which is
 * what replaces the manual "browse Amazon and copy 100 ASINs" step.
 *
 * The API is deliberately thin: query + page + domain + country, and nothing
 * else. There is NO category/browse-node parameter, NO price filter and NO
 * sort. That shapes the whole design here:
 *
 *   - "Category" is a saved keyword set on the ASIN list taxonomy, not a real
 *     Amazon node (see utils/searchQueries.js).
 *   - The price band is applied HERE, on the search response, because every
 *     result already carries a price. Filtering at this layer means we never
 *     spend a product-detail credit on an ASIN that was never eligible.
 *
 * Concurrency: the Scrapingdog account cap is shared across every flow, but
 * stock checks are run deliberately, never alongside listing work, so sourcing
 * only ever contends with the product-details pool. This matches
 * SCRAPINGDOG_PRODUCT_CONCURRENT at 40. Lower it if that stops being true.
 */

const SCRAPINGDOG_SEARCH_BASE = 'https://api.scrapingdog.com/amazon/search';

const CONCURRENT_REQUESTS = parseInt(process.env.SCRAPINGDOG_SEARCH_CONCURRENT) || 40;
const limit = pLimit(CONCURRENT_REQUESTS);

console.log(`[Scrapingdog Search] 🔎 Initialized with ${CONCURRENT_REQUESTS} concurrent request limit`);

// Same table as scrapingdogProduct.js — Scrapingdog keys requests by
// domain + country, and bills 1 credit for the US, 5 everywhere else.
const REGION_CONFIG = {
  US: { domain: 'com', country: 'us', credits: 1 },
  UK: { domain: 'co.uk', country: 'gb', credits: 5 },
  CA: { domain: 'ca', country: 'ca', credits: 5 },
  AU: { domain: 'com.au', country: 'au', credits: 5 }
};

// Short timeouts proved to cause false failures at scale on the other two
// clients; keep the same generous default.
const SEARCH_TIMEOUT_MS = parseInt(process.env.SCRAPINGDOG_SEARCH_TIMEOUT_MS) || 45000;

// Relevance decays fast on deep pages when there is no category to anchor the
// query. Preferring more keywords over deeper paging is what keeps a sourcing
// run on-topic, so per-query depth is capped.
const DEFAULT_MAX_PAGES_PER_QUERY = parseInt(process.env.SCRAPINGDOG_SEARCH_MAX_PAGES) || 12;

// How many failures in a row retire a keyword. Transient blips deserve another
// page; a keyword failing three times running is broken for this run.
const MAX_CONSECUTIVE_ERRORS = 3;

const ASIN_PATTERN = /^B[0-9A-Z]{9}$/;

function getApiKey() {
  const key = process.env.SCRAPINGDOG_API_KEY;
  if (!key) {
    throw new Error('SCRAPINGDOG_API_KEY environment variable not set. Please add it to .env file.');
  }
  return key;
}

/**
 * Search rows carry a display string ("$16.94") alongside Scrapingdog's own
 * extracted_price. On the product endpoint that extracted value is actively
 * wrong for savings-badge products ("$16.94 with 15 percent savings" becomes
 * 16.9415); search rows are cleaner, but the same defensive first-token parse
 * is used anyway so one polluted row cannot smuggle a $16.94 item into a
 * "1000-2000" band.
 *
 * @returns {number|null} null when there is no usable price (out of stock,
 *                        "See options", price-on-add-to-cart)
 */
function extractResultPrice(result) {
  const candidates = [result.price_string, result.price, result.extracted_price];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') continue;
    const match = String(candidate).match(/\d[\d,]*(?:\.\d{1,2})?/);
    if (!match) continue;
    const value = parseFloat(match[0].replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0) return value;
  }

  return null;
}

/**
 * total_reviews arrives comma-formatted ("1,234") on the product endpoint;
 * treat search rows the same way rather than trusting the declared type.
 */
function toNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One search request. Returns the raw rows plus the credits it cost, so the
 * caller keeps an accurate running total even across failures — a failed
 * request is still billed.
 */
async function fetchSearchPage({ query, page, regionConfig, region }) {
  const startTime = Date.now();
  const apiKey = getApiKey();

  try {
    // NEVER send postal_code. It was the confirmed root cause of a mass 400
    // wave on the stock check flow and Scrapingdog support advised removing
    // it; both existing clients omit it and so does this one.
    const response = await axios.get(SCRAPINGDOG_SEARCH_BASE, {
      params: {
        api_key: apiKey,
        domain: regionConfig.domain,
        country: regionConfig.country,
        query,
        page: String(page)
      },
      timeout: SEARCH_TIMEOUT_MS
    });

    if (response.status !== 200) {
      throw new Error(`Scrapingdog returned status ${response.status}`);
    }

    // The endpoint has been observed returning both a bare array and a
    // { results } envelope depending on the query; accept either.
    const body = response.data;
    const results = Array.isArray(body)
      ? body
      : (Array.isArray(body?.results) ? body.results : []);

    const responseTime = Date.now() - startTime;

    trackApiUsage({
      service: 'Scrapingdog',
      creditsUsed: regionConfig.credits,
      success: true,
      responseTime,
      extractedFields: ['search_results']
    }).catch(err => console.error('[Usage Tracker] Failed to track:', err.message));

    console.log(`[Scrapingdog Search] ✅ "${query}" p${page} (${region}) ${responseTime}ms | ${results.length} results`);

    return { results, credits: regionConfig.credits, error: null };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const status = error.response?.status;

    trackApiUsage({
      service: 'Scrapingdog',
      creditsUsed: regionConfig.credits,
      success: false,
      errorMessage: `search "${query}" p${page}: ${error.message}`,
      responseTime,
      extractedFields: []
    }).catch(err => console.error('[Usage Tracker] Failed to track:', err.message));

    console.error(`[Scrapingdog Search] ❌ "${query}" p${page} failed (${status || 'no status'}): ${error.message}`);

    // 429 means the shared account cap is saturated — retrying only burns
    // more credits, so it retires this keyword for the rest of the run.
    return {
      results: [],
      credits: regionConfig.credits,
      error: { message: error.message, status, fatal: status === 429 }
    };
  }
}

/**
 * Source ASINs for a set of keywords, filtered to a price band.
 *
 * Walks the keywords round-robin — page 1 of every keyword, then page 2 of
 * every keyword — so a three-keyword category returns a spread rather than 100
 * ASINs from whichever keyword happened to be listed first.
 *
 * @param {Object}   opts
 * @param {string[]} opts.queries              - keywords to search (required, non-empty)
 * @param {number}   opts.target               - how many ASINs to return
 * @param {number}   [opts.priceMin]           - inclusive lower bound, region currency
 * @param {number}   [opts.priceMax]           - inclusive upper bound
 * @param {string}   [opts.region='US']
 * @param {Set<string>|string[]} [opts.excludeAsins] - already served/discarded/listed
 * @param {Object}   [opts.startPages]         - { [query]: lastPageConsumed } to resume
 * @param {number}   [opts.minRating]          - drop rows below this star rating
 * @param {number}   [opts.minReviews]         - drop rows below this review count
 * @param {boolean}  [opts.includeSponsored=false]
 * @param {number}   [opts.maxPagesPerQuery]
 * @param {Function} [opts.onProgress]         - called after each round with a snapshot
 * @returns {Promise<Object>} { asins, results, pageCursor, creditsSpent, stats, exhausted, errors }
 */
export async function searchAsins({
  queries,
  target,
  priceMin = null,
  priceMax = null,
  region = 'US',
  excludeAsins = [],
  startPages = {},
  minRating = null,
  minReviews = null,
  includeSponsored = false,
  maxPagesPerQuery = DEFAULT_MAX_PAGES_PER_QUERY,
  onProgress = null
} = {}) {
  const keywords = (Array.isArray(queries) ? queries : []).filter(Boolean);
  if (keywords.length === 0) throw new Error('At least one search keyword is required');

  const wanted = Math.max(1, parseInt(target, 10) || 0);
  const regionConfig = REGION_CONFIG[region] || REGION_CONFIG.US;
  const excluded = excludeAsins instanceof Set
    ? excludeAsins
    : new Set((excludeAsins || []).map(a => String(a).toUpperCase()));

  const hasMin = priceMin !== null && priceMin !== '' && Number.isFinite(Number(priceMin));
  const hasMax = priceMax !== null && priceMax !== '' && Number.isFinite(Number(priceMax));
  const hasMinRating = minRating !== null && minRating !== '' && Number.isFinite(Number(minRating));
  const hasMinReviews = minReviews !== null && minReviews !== '' && Number.isFinite(Number(minReviews));

  // Page cursor per keyword, carried in from a previous run so a top-up
  // resumes where the last one stopped instead of re-buying page 1.
  const pageCursor = {};
  const exhausted = new Set();
  for (const query of keywords) {
    pageCursor[query] = parseInt(startPages?.[query], 10) || 0;
    if (pageCursor[query] >= maxPagesPerQuery) exhausted.add(query);
  }

  const found = [];
  const seen = new Set();
  const errors = [];
  const consecutiveErrors = {};
  // Exhaustion has two very different causes and the fix differs for each:
  // a dry keyword needs a broader term, a ceiling hit needs a higher limit.
  const dryQueries = new Set();
  const ceilingQueries = new Set();
  const stats = {
    pagesFetched: 0,
    resultsSeen: 0,
    rejectedSponsored: 0,
    rejectedPrice: 0,
    rejectedNoPrice: 0,
    rejectedRating: 0,
    rejectedReviews: 0,
    rejectedExcluded: 0,
    rejectedDuplicate: 0,
    rejectedInvalidAsin: 0
  };
  let creditsSpent = 0;

  while (found.length < wanted && exhausted.size < keywords.length) {
    const active = keywords.filter(q => !exhausted.has(q));

    // One page from each still-live keyword, in parallel but pool-limited.
    const pages = await Promise.all(active.map(query => limit(async () => {
      const page = pageCursor[query] + 1;
      const outcome = await fetchSearchPage({ query, page, regionConfig, region });
      return { query, page, ...outcome };
    })));

    for (const { query, page, results, credits, error } of pages) {
      creditsSpent += credits;
      stats.pagesFetched += 1;
      pageCursor[query] = page;

      // The depth ceiling applies on EVERY path, failures included. Checking it
      // only after a successful page let a keyword that 500s or times out on
      // every request page forever, buying a credit each time.
      if (page >= maxPagesPerQuery) {
        exhausted.add(query);
        ceilingQueries.add(query);
      }

      if (error) {
        errors.push({ query, page, message: error.message, status: error.status });
        consecutiveErrors[query] = (consecutiveErrors[query] || 0) + 1;
        // 429 is the shared account cap, and a keyword failing repeatedly is
        // not going to start working inside this run — retire it either way
        // rather than spending the rest of its ceiling on errors.
        if (error.fatal || consecutiveErrors[query] >= MAX_CONSECUTIVE_ERRORS) {
          exhausted.add(query);
        }
        continue;
      }
      consecutiveErrors[query] = 0;

      // No rows back means Amazon has run out of results for this keyword.
      if (results.length === 0) {
        exhausted.add(query);
        dryQueries.add(query);
        continue;
      }

      for (const result of results) {
        stats.resultsSeen += 1;

        const asin = String(result.asin || '').toUpperCase().trim();
        if (!ASIN_PATTERN.test(asin)) { stats.rejectedInvalidAsin += 1; continue; }

        // Sponsored rows are ads and frequently off-topic for the keyword.
        if (!includeSponsored && result.sponsored === true) { stats.rejectedSponsored += 1; continue; }

        if (seen.has(asin)) { stats.rejectedDuplicate += 1; continue; }
        if (excluded.has(asin)) { stats.rejectedExcluded += 1; continue; }

        const price = extractResultPrice(result);
        if (price === null) { stats.rejectedNoPrice += 1; continue; }
        if (hasMin && price < Number(priceMin)) { stats.rejectedPrice += 1; continue; }
        if (hasMax && price > Number(priceMax)) { stats.rejectedPrice += 1; continue; }

        const rating = toNumber(result.stars);
        if (hasMinRating && (rating === null || rating < Number(minRating))) {
          stats.rejectedRating += 1;
          continue;
        }

        const reviews = toNumber(result.total_reviews);
        if (hasMinReviews && (reviews === null || reviews < Number(minReviews))) {
          stats.rejectedReviews += 1;
          continue;
        }

        seen.add(asin);
        found.push({
          asin,
          title: String(result.title || '').trim(),
          price,
          currency: result.currency || '',
          image: result.image || '',
          rating,
          reviews,
          hasPrime: result.has_prime === true,
          query,
          page
        });

        if (found.length >= wanted) break;
      }

      if (found.length >= wanted) break;
    }

    if (typeof onProgress === 'function') {
      onProgress({
        found: found.length,
        target: wanted,
        pagesFetched: stats.pagesFetched,
        creditsSpent,
        exhaustedQueries: exhausted.size,
        totalQueries: keywords.length
      });
    }
  }

  const trimmed = found.slice(0, wanted);

  // Why the loop ended, so a short run can be diagnosed instead of guessed at.
  // 'keyword_dry' means Amazon returned an empty page — the usual cause of a
  // short batch, and quite different from a band that filtered everything out.
  let stopReason = 'target_met';
  if (trimmed.length < wanted) {
    if (errors.length > 0 && dryQueries.size === 0 && ceilingQueries.size === 0) stopReason = 'errors';
    else if (ceilingQueries.size > 0 && dryQueries.size === 0) stopReason = 'page_ceiling';
    else stopReason = 'keyword_dry';
  }

  console.log(
    `[Scrapingdog Search] 📦 ${trimmed.length}/${wanted} ASINs from ${stats.pagesFetched} pages `
    + `(${creditsSpent} credits, ${stats.resultsSeen} rows seen, `
    + `${stats.rejectedPrice} out of price band)`
  );

  return {
    asins: trimmed.map(r => r.asin),
    results: trimmed,
    pageCursor,
    creditsSpent,
    stats,
    // True when every keyword ran dry or hit its page ceiling before the target
    // was met — the caller must report "found 34, not 100" honestly rather than
    // silently returning short.
    exhausted: trimmed.length < wanted,
    stopReason,
    dryQueries: [...dryQueries],
    // Every keyword has been paged to its depth limit, so a top-up on this run
    // would buy nothing at all. The caller needs to say so rather than let the
    // operator click "find more" and get an instant empty result.
    atCeiling: keywords.every(query => (pageCursor[query] || 0) >= maxPagesPerQuery),
    errors
  };
}

export { REGION_CONFIG as SEARCH_REGION_CONFIG, DEFAULT_MAX_PAGES_PER_QUERY };

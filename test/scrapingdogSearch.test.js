import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import axios from 'axios';

process.env.SCRAPINGDOG_API_KEY = 'test-key';
// Keep the page ceiling low so an exhaustion test cannot spin for 12 rounds.
process.env.SCRAPINGDOG_SEARCH_MAX_PAGES = '3';
process.env.ENABLE_API_USAGE_TRACKING = 'false';

const { searchAsins } = await import('../src/utils/scrapingdogSearch.js');

const realAdapter = axios.defaults.adapter;

/** Requests the stub saw, in order — lets a test assert on paging behaviour. */
let calls = [];

/**
 * Install a fake Scrapingdog. `handler` receives the parsed request params and
 * returns either an array of result rows or { status } to simulate a failure.
 */
function stubScrapingdog(handler) {
  axios.defaults.adapter = async (config) => {
    const params = config.params || {};
    calls.push({ query: params.query, page: Number(params.page), country: params.country });

    const outcome = handler(params);

    if (outcome && outcome.status && outcome.status !== 200) {
      const error = new Error(`Request failed with status code ${outcome.status}`);
      error.response = { status: outcome.status, data: {}, config };
      error.config = config;
      throw error;
    }

    return { data: outcome, status: 200, statusText: 'OK', headers: {}, config };
  };
}

/**
 * A keyword whose results run out after page 1. Without this the stub would
 * serve the same rows on every page until the ceiling, and the rejection
 * counters — which are cumulative across pages by design — would multiply.
 */
function stubSinglePage(rows) {
  stubScrapingdog(({ page }) => (Number(page) === 1 ? rows : []));
}

/** A minimal search row in Scrapingdog's shape. */
function row(asin, price, extra = {}) {
  return {
    asin,
    title: `Product ${asin}`,
    price_string: typeof price === 'string' ? price : `$${price}`,
    extracted_price: typeof price === 'number' ? price : undefined,
    stars: 4.5,
    total_reviews: '1,200',
    sponsored: false,
    organic_position: 1,
    ...extra
  };
}

/** Deterministic 10-char ASIN from a seed number. */
function asin(n) {
  return 'B' + String(n).padStart(9, '0');
}

beforeEach(() => { calls = []; });
afterEach(() => { axios.defaults.adapter = realAdapter; });

test('keeps only results inside the price band', async () => {
  stubSinglePage([
    row(asin(1), 9.99),    // below
    row(asin(2), 20.00),   // in
    row(asin(3), 39.99),   // in
    row(asin(4), 80.00)    // above
  ]);

  const out = await searchAsins({
    queries: ['phone case'],
    target: 10,
    priceMin: 15,
    priceMax: 40
  });

  assert.deepEqual(out.asins, [asin(2), asin(3)]);
  assert.equal(out.stats.rejectedPrice, 2);
  // Ran short of the target, and says so rather than pretending otherwise.
  assert.equal(out.exhausted, true);
});

test('bounds are inclusive', async () => {
  stubScrapingdog(() => [row(asin(1), 15.00), row(asin(2), 40.00)]);

  const out = await searchAsins({ queries: ['q'], target: 10, priceMin: 15, priceMax: 40 });

  assert.deepEqual(out.asins, [asin(1), asin(2)]);
});

test('a polluted price string is read from its first token only', async () => {
  // The product endpoint returns "$16.94 with 15 percent savings" and even its
  // own extracted_price globs the 15 into 16.9415. A band of 15-20 must accept
  // this row at 16.94, and a band of 100-200 must not.
  stubScrapingdog(() => [row(asin(1), '$16.94 with 15 percent savings')]);

  const inBand = await searchAsins({ queries: ['q'], target: 5, priceMin: 15, priceMax: 20 });
  assert.deepEqual(inBand.asins, [asin(1)]);

  calls = [];
  const outOfBand = await searchAsins({ queries: ['q'], target: 5, priceMin: 100, priceMax: 200 });
  assert.deepEqual(outOfBand.asins, []);
});

test('drops sponsored rows, priceless rows, and malformed ASINs', async () => {
  stubSinglePage([
    row(asin(1), 20, { sponsored: true }),
    row(asin(2), 20),
    { asin: asin(3), title: 'No price', price_string: '', sponsored: false },
    { asin: 'NOT-AN-ASIN', title: 'Junk', price_string: '$20', sponsored: false }
  ]);

  const out = await searchAsins({ queries: ['q'], target: 10, priceMin: 1, priceMax: 100 });

  assert.deepEqual(out.asins, [asin(2)]);
  assert.equal(out.stats.rejectedSponsored, 1);
  assert.equal(out.stats.rejectedNoPrice, 1);
  assert.equal(out.stats.rejectedInvalidAsin, 1);
});

test('excludes already-seen ASINs and de-duplicates within the run', async () => {
  // asin(1) is excluded by the caller; asin(2) appears on both pages.
  stubScrapingdog(({ page }) => (Number(page) === 1
    ? [row(asin(1), 20), row(asin(2), 20)]
    : [row(asin(2), 20), row(asin(3), 20)]));

  const out = await searchAsins({
    queries: ['q'],
    target: 2,
    priceMin: 1,
    priceMax: 100,
    excludeAsins: [asin(1)]
  });

  assert.deepEqual(out.asins, [asin(2), asin(3)]);
  assert.equal(out.stats.rejectedExcluded, 1);
  assert.equal(out.stats.rejectedDuplicate, 1);
});

test('exclusion is case-insensitive', async () => {
  stubScrapingdog(() => [row(asin(1), 20)]);

  const out = await searchAsins({
    queries: ['q'],
    target: 5,
    excludeAsins: [asin(1).toLowerCase()]
  });

  assert.deepEqual(out.asins, []);
});

test('walks keywords round-robin rather than draining the first', async () => {
  // Each keyword has plenty of stock, so a target of 4 across two keywords
  // must come from both, not four deep pages of the first.
  let n = 0;
  stubScrapingdog(({ query }) => [row(`B${query === 'alpha' ? 'A' : 'Z'}${String(n++).padStart(8, '0')}`, 20)]);

  const out = await searchAsins({ queries: ['alpha', 'beta'], target: 4, priceMin: 1, priceMax: 100 });

  assert.equal(out.asins.length, 4);
  const fromAlpha = out.results.filter(r => r.query === 'alpha').length;
  const fromBeta = out.results.filter(r => r.query === 'beta').length;
  assert.equal(fromAlpha, 2);
  assert.equal(fromBeta, 2);

  // Round 1 asked both keywords for page 1 before either saw page 2.
  assert.deepEqual(calls.slice(0, 2).map(c => c.page), [1, 1]);
});

test('resumes from a stored page cursor instead of re-buying page 1', async () => {
  stubScrapingdog(({ page }) => [row(asin(100 + Number(page)), 20)]);

  const out = await searchAsins({
    queries: ['q'],
    target: 1,
    startPages: { q: 4 },
    // The ceiling is cumulative across top-ups, so it has to sit above the
    // stored cursor for this case to be about resuming rather than exhaustion.
    maxPagesPerQuery: 10
  });

  assert.equal(calls[0].page, 5, 'first request should continue after the stored cursor');
  assert.equal(out.pageCursor.q, 5, 'cursor advances for the next top-up');
  assert.deepEqual(out.asins, [asin(105)]);
});

test('an empty page retires the keyword instead of paging forever', async () => {
  stubScrapingdog(() => []);

  const out = await searchAsins({ queries: ['q'], target: 50 });

  assert.equal(out.asins.length, 0);
  assert.equal(out.exhausted, true);
  assert.equal(calls.length, 1, 'must not keep requesting after a dry page');
});

test('stops at the per-query page ceiling', async () => {
  // Every page yields one out-of-band result, so the target is never met and
  // only the ceiling (3, set at the top of this file) can stop the loop.
  stubScrapingdog(() => [row(asin(1), 5)]);

  const out = await searchAsins({ queries: ['q'], target: 50, priceMin: 100, priceMax: 200 });

  assert.equal(calls.length, 3);
  assert.equal(out.pageCursor.q, 3);
  assert.equal(out.exhausted, true);
});

test('a 429 retires that keyword rather than retrying into the cap', async () => {
  // 429 is the shared account concurrency/credit cap. Retrying burns credits.
  stubScrapingdog(({ query }) => (query === 'capped'
    ? { status: 429 }
    : [row(asin(7), 20)]));

  const out = await searchAsins({ queries: ['capped', 'fine'], target: 1, priceMin: 1, priceMax: 100 });

  assert.deepEqual(out.asins, [asin(7)]);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].status, 429);
  assert.equal(calls.filter(c => c.query === 'capped').length, 1);
});

test('a keyword that keeps failing is retired instead of paging forever', async () => {
  // Regression: the depth ceiling was only checked after a SUCCESSFUL page, so
  // a keyword returning 500 every time paged without limit, buying a credit
  // each round until the process was killed.
  stubScrapingdog(() => ({ status: 500 }));

  const out = await searchAsins({ queries: ['q'], target: 50, maxPagesPerQuery: 25 });

  assert.equal(calls.length, 3, 'three consecutive failures should retire the keyword');
  assert.equal(out.exhausted, true);
  assert.equal(out.errors.length, 3);
});

test('a keyword recovering from a blip keeps going', async () => {
  // One failure must not retire a keyword — only three in a row.
  stubScrapingdog(({ page }) => (Number(page) === 1
    ? { status: 500 }
    : [row(asin(Number(page)), 20)]));

  const out = await searchAsins({ queries: ['q'], target: 2, priceMin: 1, priceMax: 100, maxPagesPerQuery: 10 });

  assert.deepEqual(out.asins, [asin(2), asin(3)]);
  assert.equal(out.errors.length, 1);
});

test('failed requests still count against credits', async () => {
  // Scrapingdog bills the request, not the outcome — under-reporting spend
  // would make the run look cheaper than it was.
  stubScrapingdog(() => ({ status: 500 }));

  const out = await searchAsins({ queries: ['q'], target: 5 });

  assert.equal(out.creditsSpent, 3);
});

test('non-US regions bill 5 credits per page and use the right domain', async () => {
  stubScrapingdog(() => [row(asin(1), 20)]);

  const out = await searchAsins({ queries: ['q'], target: 1, region: 'UK' });

  assert.equal(out.creditsSpent, 5);
  assert.equal(calls[0].country, 'gb');
});

test('never sends postal_code', async () => {
  // A confirmed cause of mass 400s on the stock check flow.
  let sawPostalCode = false;
  axios.defaults.adapter = async (config) => {
    if ('postal_code' in (config.params || {})) sawPostalCode = true;
    return { data: [row(asin(1), 20)], status: 200, statusText: 'OK', headers: {}, config };
  };

  await searchAsins({ queries: ['q'], target: 1 });

  assert.equal(sawPostalCode, false);
});

test('accepts both the bare-array and { results } response shapes', async () => {
  stubScrapingdog(({ page }) => (Number(page) === 1
    ? [row(asin(1), 20)]
    : { results: [row(asin(2), 20)] }));

  const out = await searchAsins({ queries: ['q'], target: 2, priceMin: 1, priceMax: 100 });

  assert.deepEqual(out.asins, [asin(1), asin(2)]);
});

test('rating and review floors are applied', async () => {
  stubSinglePage([
    row(asin(1), 20, { stars: 3.2, total_reviews: '5,000' }),
    row(asin(2), 20, { stars: 4.8, total_reviews: '12' }),
    row(asin(3), 20, { stars: 4.6, total_reviews: '3,400' })
  ]);

  const out = await searchAsins({
    queries: ['q'],
    target: 10,
    minRating: 4.0,
    minReviews: 100
  });

  assert.deepEqual(out.asins, [asin(3)]);
  assert.equal(out.stats.rejectedRating, 1);
  assert.equal(out.stats.rejectedReviews, 1);
});

test('rejects a run with no keywords', async () => {
  await assert.rejects(
    () => searchAsins({ queries: [], target: 10 }),
    /At least one search keyword is required/
  );
});

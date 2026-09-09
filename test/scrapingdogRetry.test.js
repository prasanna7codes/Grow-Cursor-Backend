import assert from 'node:assert/strict';
import test from 'node:test';

// Set before the module loads: scrapingdogProduct reads its pool size and retry
// budgets at import time. A pool of 2 makes the slot-release test observable
// with a handful of ASINs instead of dozens.
process.env.SCRAPINGDOG_API_KEY = 'test-key';
// No Mongo here, and the tracker is fire-and-forget: without this every
// assertion waits out a 10s insert buffering timeout.
process.env.ENABLE_API_USAGE_TRACKING = 'false';
process.env.SCRAPINGDOG_PRODUCT_CONCURRENT = '2';
process.env.SCRAPINGDOG_PRODUCT_MAX_RETRIES_TRANSIENT = '4';
process.env.SCRAPINGDOG_PRODUCT_MAX_RETRIES_BAD_SCRAPE = '2';
process.env.SCRAPINGDOG_PRODUCT_RETRY_BASE_MS = '250';
process.env.SCRAPINGDOG_PRODUCT_RETRY_MAX_MS = '400';

const axios = (await import('axios')).default;
const { scrapeAmazonProductWithScrapingdog } = await import('../src/utils/scrapingdogProduct.js');

/** A response shaped like a complete Scrapingdog product hit. */
function goodProduct(asin) {
  return {
    status: 200,
    data: {
      title: `Product ${asin}`,
      brand: 'Acme',
      price: '$16.94 with 15 percent savings',
      feature_bullets: ['bullet one'],
      images_of_specified_asin: ['https://img/1.jpg'],
      availability_status: 'In Stock',
      shipping_info: 'FREE delivery Tuesday, 16 September'
    }
  };
}

function httpError(status) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status };
  return error;
}

/** Swap axios.get for `impl` and restore it afterwards. */
async function withAxios(impl, fn) {
  const original = axios.get;
  axios.get = impl;
  try {
    return await fn();
  } finally {
    axios.get = original;
  }
}

test('a transient 502 is retried up to the transient budget, then succeeds', async () => {
  let calls = 0;
  const result = await withAxios(async () => {
    calls += 1;
    if (calls < 3) throw httpError(502);
    return goodProduct('B001');
  }, () => scrapeAmazonProductWithScrapingdog('B001', 'US'));

  assert.equal(calls, 3, 'should have retried twice before the success');
  assert.equal(result.asin, 'B001');
  // extractPrice must take only the first currency token out of the polluted string
  assert.equal(result.price, '16.94');
});

test('a transient error exhausts the transient budget and then throws', async () => {
  let calls = 0;
  await assert.rejects(
    withAxios(async () => { calls += 1; throw httpError(503); },
      () => scrapeAmazonProductWithScrapingdog('B002', 'US')),
    /status code 503/
  );
  assert.equal(calls, 4, 'transient budget is 4 attempts');
});

test('404 is permanent and is never retried', async () => {
  let calls = 0;
  await assert.rejects(
    withAxios(async () => { calls += 1; throw httpError(404); },
      () => scrapeAmazonProductWithScrapingdog('B003', 'US')),
    /status code 404/
  );
  assert.equal(calls, 1, '404 must not burn extra credits');
});

test('400 is treated as a failed scrape and gets the small budget', async () => {
  let calls = 0;
  await assert.rejects(
    withAxios(async () => { calls += 1; throw httpError(400); },
      () => scrapeAmazonProductWithScrapingdog('B004', 'US')),
    /status code 400/
  );
  assert.equal(calls, 2, '400 retries once, unlike the old permanent policy');
});

test('a priced-but-empty response fails as NO_PRICE_FOUND on the small budget', async () => {
  let calls = 0;
  await assert.rejects(
    withAxios(async () => {
      calls += 1;
      return { status: 200, data: { title: 'No price here', feature_bullets: ['x'] } };
    }, () => scrapeAmazonProductWithScrapingdog('B005', 'US')),
    /NO_PRICE_FOUND/
  );
  assert.equal(calls, 2, 'price misses must not spend the full transient ladder');
});

test('backoff does not hold a concurrency slot', async () => {
  // Pool is 2. Three ASINs: two fail transiently (and so spend most of their
  // life in backoff), one succeeds. If backoff held its slot, the successful
  // ASIN could not start until a failing one finished its whole ladder.
  let succeededAt = null;
  const startedAt = Date.now();
  let inFlight = 0;
  let maxInFlight = 0;

  await withAxios(async (_url, config) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise(r => setTimeout(r, 20));
      if (config.params.asin === 'GOOD') return goodProduct('GOOD');
      throw httpError(502);
    } finally {
      inFlight -= 1;
    }
  }, async () => {
    const failing = ['BAD1', 'BAD2'].map(a =>
      scrapeAmazonProductWithScrapingdog(a, 'US').catch(() => 'failed'));
    // Give the two failures time to occupy both slots and enter backoff.
    await new Promise(r => setTimeout(r, 40));
    const good = scrapeAmazonProductWithScrapingdog('GOOD', 'US')
      .then(v => { succeededAt = Date.now(); return v; });
    await Promise.all([...failing, good]);
  });

  assert.ok(maxInFlight <= 2, `pool cap must hold, saw ${maxInFlight} in flight`);
  // The two failing ASINs each run a 4-attempt ladder with 250-400ms gaps, so
  // well over 750ms. The good ASIN must not have waited for that.
  const elapsed = succeededAt - startedAt;
  assert.ok(elapsed < 600, `good ASIN waited ${elapsed}ms — a slot was held during backoff`);
});

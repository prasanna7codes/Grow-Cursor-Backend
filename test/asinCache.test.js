import assert from 'node:assert/strict';
import test from 'node:test';

// Set before the module loads: asinCache reads its limits at import time, and a
// small cap lets these tests cross the watermark with a handful of entries
// instead of ten thousand. 10 gives HIGH_WATER 7 and EVICT_BATCH 1.
process.env.ASIN_CACHE_MAX_KEYS = '10';

const {
  default: asinCache,
  EVICT_BATCH,
  HIGH_WATER,
  MAX_KEYS,
  clearAsinCache,
  evictOldest,
  getCachedAsinData,
  setCachedAsinData,
} = await import('../src/utils/asinCache.js');

const REGION = 'US';

/** Store `count` entries under predictable ASINs, oldest first. */
function fill(count) {
  for (let i = 0; i < count; i += 1) {
    setCachedAsinData(`ASIN${String(i).padStart(4, '0')}`, { asin: i }, REGION);
  }
}

const cachedAsins = () => asinCache.keys().map(key => key.replace(/^asin:/, '').replace(`_${REGION}`, ''));

test.beforeEach(() => clearAsinCache());

// ── The watermarks ───────────────────────────────────────────────────────────

test('the watermarks stay inside the cap they protect', () => {
  assert.equal(MAX_KEYS, 10);
  assert.ok(HIGH_WATER < MAX_KEYS, 'evicting at or above the cap would never prevent an ECACHEFULL');
  assert.ok(EVICT_BATCH >= 1, 'an eviction that frees nothing would spin on every write');
  assert.ok(EVICT_BATCH <= HIGH_WATER);
});

test('eviction is a no-op below the high-water mark', () => {
  fill(HIGH_WATER - 1);

  assert.equal(evictOldest(), 0);
  assert.equal(asinCache.keys().length, HIGH_WATER - 1);
});

test('crossing the high-water mark drops the oldest entries and keeps the newest', () => {
  fill(HIGH_WATER);
  const oldest = cachedAsins()[0];
  const newest = cachedAsins()[HIGH_WATER - 1];

  assert.equal(evictOldest(), EVICT_BATCH);

  const remaining = cachedAsins();
  assert.equal(remaining.length, HIGH_WATER - EVICT_BATCH);
  assert.equal(remaining.includes(oldest), false, 'the oldest entry should have been the one dropped');
  assert.equal(remaining.includes(newest), true, 'a flush would have taken the warm entries too');
});

test('sustained writes settle at the watermark instead of reaching the cap', () => {
  // The scenario the eviction exists for: far more distinct ASINs in one TTL
  // window than the cache can hold. It must absorb them without ever throwing.
  fill(MAX_KEYS * 3);

  assert.ok(asinCache.keys().length <= HIGH_WATER, `expected <= ${HIGH_WATER}, got ${asinCache.keys().length}`);
  // The most recent write always survives, so a batch re-reading what it just
  // cached still hits.
  assert.notEqual(getCachedAsinData(`ASIN${String(MAX_KEYS * 3 - 1).padStart(4, '0')}`, REGION), null);
});

// ── A write that fails anyway ────────────────────────────────────────────────

test('node-cache throws at the cap rather than evicting', () => {
  // Documents the upstream behaviour the try/catch and the eviction both exist
  // for. If a node-cache upgrade ever switched to real LRU eviction, this test
  // failing is the signal that the workaround can go.
  for (let i = 0; i < MAX_KEYS; i += 1) asinCache.set(`raw:${i}`, i);

  assert.throws(() => asinCache.set('raw:overflow', 1), { errorcode: 'ECACHEFULL' });
});

test('a failed write degrades to a cache miss instead of throwing', () => {
  // Reached only if eviction itself fails, so force the failure directly rather
  // than trying to out-run the eviction.
  const realSet = asinCache.set;
  asinCache.set = () => { throw Object.assign(new Error('Cache max keys amount exceeded'), { errorcode: 'ECACHEFULL' }); };

  try {
    // The contract that matters: fetchAmazonData calls this after a paid scrape
    // and rethrows anything that escapes, which would turn a successful scrape
    // into a failed ASIN row in the preview.
    assert.doesNotThrow(() => setCachedAsinData('B01N5IB20Q', { asin: 'B01N5IB20Q' }, REGION));
  } finally {
    asinCache.set = realSet;
  }

  assert.equal(getCachedAsinData('B01N5IB20Q', REGION), null, 'the entry is simply absent — the next request re-scrapes');
});

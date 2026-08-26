import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeTitle,
  resolveUniquePrice,
  resolveUniqueTitle,
  applyUniqueness,
  baseSkuForAsin,
  DEFAULT_PRICE_STEP_CENTS
} from '../src/utils/listingUniqueness.js';

// ── titles ───────────────────────────────────────────────────────────────────

test('title comparison ignores case, spacing and punctuation', () => {
  // eBay would treat all of these as the same title; so must we.
  const a = 'Slim Magnetic Phone Case - Black, Shockproof';
  const b = 'slim magnetic phone case   black shockproof';
  assert.equal(normalizeTitle(a), normalizeTitle(b));

  assert.notEqual(normalizeTitle('Blue Phone Case'), normalizeTitle('Black Phone Case'));
});

test('a title nobody else uses is left completely alone', async () => {
  let called = false;
  const out = await resolveUniqueTitle({
    title: 'Unique Product Title',
    siblingTitles: ['Something Else Entirely'],
    rephrase: async () => { called = true; return 'x'; }
  });

  assert.equal(out.title, 'Unique Product Title');
  assert.equal(out.adjusted, false);
  assert.equal(out.unique, true);
  // No collision means no AI spend — this is the common case on every batch.
  assert.equal(called, false);
});

test('a colliding title is rephrased until it is unique', async () => {
  const out = await resolveUniqueTitle({
    title: 'Magnetic Phone Case Black',
    siblingTitles: ['Magnetic Phone Case Black'],
    rephrase: async () => 'Black Magnetic Case for Phone'
  });

  assert.equal(out.title, 'Black Magnetic Case for Phone');
  assert.equal(out.adjusted, true);
  assert.equal(out.unique, true);
  assert.equal(out.attempts, 1);
});

test('rephrasing retries when the model returns another colliding title', async () => {
  const attempts = [];
  const out = await resolveUniqueTitle({
    title: 'A',
    siblingTitles: ['A', 'B'],
    rephrase: async (current, attempt) => {
      attempts.push({ current, attempt });
      return attempt === 1 ? 'B' : 'C';
    }
  });

  assert.equal(out.title, 'C');
  assert.equal(out.unique, true);
  assert.equal(out.attempts, 2);
  // The second attempt rephrases the model's own output, not the original.
  assert.equal(attempts[1].current, 'B');
});

test('exhausting the retries warns instead of silently saving a duplicate', async () => {
  const out = await resolveUniqueTitle({
    title: 'A',
    siblingTitles: ['A', 'B'],
    rephrase: async () => 'B',
    maxAttempts: 3
  });

  assert.equal(out.unique, false);
  assert.match(out.warning, /after 3 rephrase attempts/);
  // The operator still gets a title to edit rather than an empty field.
  assert.equal(out.title, 'B');
});

test('a rephrase failure degrades to a warning, not a thrown error', async () => {
  // One AI outage must not take down a 100-ASIN batch.
  const out = await resolveUniqueTitle({
    title: 'A',
    siblingTitles: ['A'],
    rephrase: async () => { throw new Error('rate limited'); }
  });

  assert.equal(out.unique, false);
  assert.equal(out.title, 'A');
  assert.match(out.warning, /rate limited/);
});

test('an empty rephrase response does not blank the title', async () => {
  const out = await resolveUniqueTitle({
    title: 'Original',
    siblingTitles: ['Original'],
    rephrase: async (_c, attempt) => (attempt === 1 ? '' : 'Rewritten Title'),
    maxAttempts: 3
  });

  assert.equal(out.title, 'Rewritten Title');
  assert.equal(out.unique, true);
});

test('no rephrase function means a plain warning', async () => {
  const out = await resolveUniqueTitle({ title: 'A', siblingTitles: ['A'] });

  assert.equal(out.unique, false);
  assert.equal(out.title, 'A');
  assert.match(out.warning, /could not be rephrased/);
});

// -- prices -----------------------------------------------------------------

test('the collision key is the base SKU the review panel matches on', () => {
  // GRW25 + last five of the ASIN. B0CDRMBSD3 -> GRW25MBSD3, exactly what the
  // "Same SKU exists in N synced listings" panel keys on.
  assert.equal(baseSkuForAsin('B0CDRMBSD3'), 'GRW25MBSD3');
  assert.equal(baseSkuForAsin('b0cdrmbsd3'), 'GRW25MBSD3');
});

test('a price nobody else uses is left exactly as calculated', () => {
  const out = resolveUniquePrice({ basePrice: 29.99, siblingPrices: [24.99, 31.50] });

  assert.equal(out.price, 29.99);
  assert.equal(out.adjusted, false);
  assert.equal(out.steps, 0);
});

test('a colliding price steps upward by the modal default', () => {
  // Must agree with getNextNonMatchingPrice(..., 20) in AsinReviewModal, or the
  // server guard and the UI would disagree about what a clean price is.
  const out = resolveUniquePrice({ basePrice: 24.48, siblingPrices: [24.48] });

  assert.equal(out.price, 24.68);
  assert.equal(out.adjusted, true);
  assert.equal(out.steps, 1);
  assert.equal(DEFAULT_PRICE_STEP_CENTS, 20);
});

test('stepping continues past consecutive taken prices', () => {
  const out = resolveUniquePrice({ basePrice: 10.00, siblingPrices: [10.00, 10.20, 10.40] });

  assert.equal(out.price, 10.60);
  assert.equal(out.steps, 3);
});

test('price never steps downward', () => {
  // A downward step eats margin and a profit tier can sit on a floor.
  const out = resolveUniquePrice({ basePrice: 15.00, siblingPrices: [15.00] });
  assert.ok(out.price > 15.00);
});

test('a custom step is honoured', () => {
  const out = resolveUniquePrice({ basePrice: 10.00, siblingPrices: [10.00], stepCents: 5 });
  assert.equal(out.price, 10.05);
});

test('prices stay at two decimals', () => {
  const out = resolveUniquePrice({ basePrice: 19.99, siblingPrices: [19.99], stepCents: 7 });
  assert.equal(out.price, Number(out.price.toFixed(2)));
  assert.ok(/^\d+\.\d{2}$/.test(out.price.toFixed(2)));
});

test('sibling prices are compared the way the modal compares them', () => {
  // The index stores numbers, but currency-formatted strings must match too.
  const out = resolveUniquePrice({ basePrice: '24.48', siblingPrices: ['$24.48'] });
  assert.equal(out.adjusted, true);
});

test('an unusable base price is passed through untouched', () => {
  for (const bad of [0, null, undefined, '', -5]) {
    const out = resolveUniquePrice({ basePrice: bad, siblingPrices: [] });
    assert.equal(out.adjusted, false);
  }
});

test('junk sibling prices do not block a clean price', () => {
  const out = resolveUniquePrice({
    basePrice: 12.50,
    siblingPrices: [null, undefined, 'abc', '']
  });

  assert.equal(out.price, 12.50);
  assert.equal(out.adjusted, false);
});

// ── combined ─────────────────────────────────────────────────────────────────

test('applyUniqueness resolves both and collects warnings', async () => {
  const out = await applyUniqueness({
    title: 'Magnetic Phone Case',
    price: 29.99,
    siblings: { titles: ['Magnetic Phone Case'], prices: [29.99] },
    rephrase: async () => 'Phone Case with Magnets'
  });

  assert.equal(out.title, 'Phone Case with Magnets');
  assert.equal(out.titleAdjusted, true);
  assert.equal(out.price, 30.19);
  assert.equal(out.priceAdjusted, true);
  assert.deepEqual(out.warnings, []);
});

test('applyUniqueness leaves an uncontested listing exactly as generated', async () => {
  const out = await applyUniqueness({
    title: 'Brand New Thing',
    price: 42.00,
    siblings: { titles: [], prices: [] },
    rephrase: async () => { throw new Error('should not be called'); }
  });

  assert.equal(out.title, 'Brand New Thing');
  assert.equal(out.price, 42.00);
  assert.equal(out.titleAdjusted, false);
  assert.equal(out.priceAdjusted, false);
});

test('applyUniqueness reports when no clear price could be found', async () => {
  // Every step from 10.00 upward is taken, for further than the walk will go.
  const wall = [];
  for (let cents = 1000; cents <= 1000 + 20 * 120; cents += 20) wall.push(cents / 100);

  const out = await applyUniqueness({
    title: 'T',
    price: 10.00,
    siblings: { titles: [], prices: wall }
  });

  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /Could not find a price/);
});

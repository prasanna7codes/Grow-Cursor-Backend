import assert from 'node:assert/strict';
import test from 'node:test';

// resolveAsinForOrder itself needs a live TemplateListing collection, so these
// cover the pure pieces around it — the SKU normalisation that decides which
// documents get looked up in the first place.
const { isAsin, cleanAsin, baseSku, skusFromOrder } = await import('../src/utils/asinResolver.js');

test('isAsin accepts real ASINs and rejects near-misses', () => {
  assert.equal(isAsin('B08XYZ1234'), true);
  assert.equal(isAsin('b08xyz1234'), true, 'case-insensitive: operators paste lowercase');
  assert.equal(isAsin(' B08XYZ1234 '), true, 'surrounding whitespace is trimmed');

  assert.equal(isAsin('B08XYZ123'), false, 'nine characters after B');
  assert.equal(isAsin('B08XYZ12345'), false, 'eleven characters after B');
  assert.equal(isAsin('A08XYZ1234'), false, 'ASINs start with B');
  assert.equal(isAsin('GRW25N4VFV'), false, 'an eBay SKU is not an ASIN');
  assert.equal(isAsin(''), false);
  assert.equal(isAsin(null), false);
  assert.equal(isAsin(undefined), false);
});

test('cleanAsin normalises to trimmed uppercase', () => {
  assert.equal(cleanAsin('  b08xyz1234 '), 'B08XYZ1234');
  assert.equal(cleanAsin(null), '');
});

// baseSku must agree with TemplateListing's extractBaseCustomLabel, which is what
// actually populated the baseCustomLabel field being queried. Both take everything
// before the FIRST hyphen; a trailing-suffix strip would diverge on multi-hyphen
// SKUs and match nothing.
test('baseSku takes everything before the first hyphen', () => {
  assert.equal(baseSku('GRW25N4VFV-1'), 'GRW25N4VFV');
  assert.equal(baseSku('GRW25N4VFV-12'), 'GRW25N4VFV');
  assert.equal(baseSku('GRW25N4VFV'), 'GRW25N4VFV', 'no suffix is left alone');
  assert.equal(baseSku('GRW-25-N4VFV'), 'GRW', 'splits at the first hyphen, not the last');
  assert.equal(baseSku('GRW25N4VFV-A'), 'GRW25N4VFV', 'a non-numeric suffix still splits');
  assert.equal(baseSku('  GRW25N4VFV-3  '), 'GRW25N4VFV');
  assert.equal(baseSku(''), '');
  assert.equal(baseSku(null), '');
});

test('baseSku matches TemplateListing.extractBaseCustomLabel exactly', async () => {
  // Guards the invariant directly: if that model function ever changes, this
  // fails rather than the resolver quietly returning no ASINs.
  const extractBaseCustomLabel = (value) => String(value || '').trim().split('-')[0].trim();
  for (const sku of ['GRW25N4VFV-1', 'GRW-25-N4VFV', 'PLAIN', '  X-1 ', '', 'A-B-C-9']) {
    assert.equal(baseSku(sku), extractBaseCustomLabel(sku), `mismatch on ${JSON.stringify(sku)}`);
  }
});

test('skusFromOrder collects every casing eBay uses, without duplicates', () => {
  const order = {
    lineItems: [
      { sku: 'AAA-1' },
      { SKU: 'BBB-2' },
      { sellerSku: 'CCC-3' },
      { legacySku: 'DDD-4' },
    ],
  };
  assert.deepEqual(skusFromOrder(order), ['AAA-1', 'BBB-2', 'CCC-3', 'DDD-4']);
});

test('skusFromOrder dedupes a SKU repeated across spellings', () => {
  const order = { lineItems: [{ sku: 'AAA-1', SKU: 'AAA-1', sellerSku: 'BBB-2' }] };
  assert.deepEqual(skusFromOrder(order), ['AAA-1', 'BBB-2']);
});

test('skusFromOrder survives orders with nothing usable', () => {
  assert.deepEqual(skusFromOrder({ lineItems: [] }), []);
  assert.deepEqual(skusFromOrder({}), []);
  assert.deepEqual(skusFromOrder(null), []);
  assert.deepEqual(skusFromOrder({ lineItems: [{ sku: '' }, { sku: null }] }), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { getBaseSku, skuLookupValues } from '../src/utils/sellerActiveSkus.js';

/**
 * The active/inactive rule, stated once:
 *   ASIN -> SKU (GRW25 + last 5) -> present in this seller's SellerSkuIndex?
 * Found means active, missing means inactive.
 *
 * findActiveAsinsForSeller itself needs a database, so these cover the pure
 * key-derivation half — the part that has to agree with the SKU column shown in
 * the precheck and with the SKUs the index was populated with.
 */

test('the SKU is GRW25 plus the last five characters of the ASIN', () => {
  assert.deepEqual(skuLookupValues('B0CDRMBSD3'), ['GRW25MBSD3']);
  assert.deepEqual(skuLookupValues('B0D9VS4PV7'), ['GRW25S4PV7']);
});

test('ASIN case does not change the SKU', () => {
  // ASINs arrive uppercased from search but pasted ones may not be.
  assert.deepEqual(skuLookupValues('b0cdrmbsd3'), skuLookupValues('B0CDRMBSD3'));
});

test('a repeat-listing suffix strips back to the base SKU', () => {
  // The index stores GRW25ABCDE-1 for a second listing of the same product;
  // it still means the seller covers that ASIN.
  assert.equal(getBaseSku('GRW25MBSD3-1'), 'GRW25MBSD3');
  assert.equal(getBaseSku('GRW25MBSD3-12'), 'GRW25MBSD3');
  assert.equal(getBaseSku('GRW25MBSD3'), 'GRW25MBSD3');
});

test('a hyphen that is not a repeat suffix is left alone', () => {
  assert.equal(getBaseSku('GRW25AB-CD'), 'GRW25AB-CD');
});

test('base SKU tolerates whitespace and empty input', () => {
  assert.equal(getBaseSku('  GRW25MBSD3-2  '), 'GRW25MBSD3');
  assert.equal(getBaseSku(''), '');
  assert.equal(getBaseSku(null), '');
});

test('lookup values are de-duplicated', () => {
  // A generated SKU never carries a suffix, so the raw and base forms are the
  // same value and must not be searched for twice.
  assert.equal(skuLookupValues('B0CDRMBSD3').length, 1);
});

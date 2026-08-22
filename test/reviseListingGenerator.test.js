import assert from 'node:assert/strict';
import test from 'node:test';

import { buildItemSpecifics, regionForCurrency } from '../src/utils/reviseListingGenerator.js';

/**
 * The Amazon Stock Check "revise onto a new ASIN" flow overwrites a live
 * listing, so the two mappings it can get silently wrong are covered here.
 *
 * Item specifics are the sharper of the two: send the wrong names and the
 * listing describes the new product with the old product's attributes, which
 * looks fine in the database and wrong only on eBay.
 */

test('regionForCurrency maps each stock-check currency to its Amazon region', () => {
  assert.equal(regionForCurrency('USD'), 'US');
  assert.equal(regionForCurrency('GBP'), 'UK');
  assert.equal(regionForCurrency('CAD'), 'CA');
  assert.equal(regionForCurrency('AUD'), 'AU');
});

test('regionForCurrency is case-insensitive and falls back to US', () => {
  assert.equal(regionForCurrency('gbp'), 'UK');
  assert.equal(regionForCurrency(''), 'US');
  assert.equal(regionForCurrency(undefined), 'US');
  assert.equal(regionForCurrency('EUR'), 'US');
});

test('buildItemSpecifics strips the File Exchange C: prefix', () => {
  // Custom column names double as CSV headers, where item specifics carry the
  // prefix. The Trading API wants the bare name.
  const specifics = buildItemSpecifics(
    { 'C:Brand': 'Music City Metals', 'C:Material': 'Porcelain Steel' },
    [{ name: 'C:Brand' }, { name: 'C:Material' }]
  );

  assert.deepEqual(specifics, [
    { name: 'Brand', value: 'Music City Metals' },
    { name: 'Material', value: 'Porcelain Steel' }
  ]);
});

test('buildItemSpecifics accepts columns written without a prefix', () => {
  const specifics = buildItemSpecifics({ Brand: 'Weber' }, [{ name: 'Brand' }]);
  assert.deepEqual(specifics, [{ name: 'Brand', value: 'Weber' }]);
});

test('buildItemSpecifics follows column order, not field order', () => {
  const specifics = buildItemSpecifics(
    { Material: 'Steel', Brand: 'Weber' },
    [{ name: 'Brand' }, { name: 'Material' }]
  );

  assert.deepEqual(specifics.map((s) => s.name), ['Brand', 'Material']);
});

test('buildItemSpecifics skips empty, missing and whitespace-only values', () => {
  // eBay rejects an empty specific value, so these must never reach the request.
  const specifics = buildItemSpecifics(
    { Brand: 'Weber', Material: '', Colour: '   ', Size: null, Finish: undefined },
    [{ name: 'Brand' }, { name: 'Material' }, { name: 'Colour' }, { name: 'Size' }, { name: 'Finish' }]
  );

  assert.deepEqual(specifics, [{ name: 'Brand', value: 'Weber' }]);
});

test('buildItemSpecifics trims values', () => {
  const specifics = buildItemSpecifics({ Brand: '  Weber  ' }, [{ name: 'Brand' }]);
  assert.deepEqual(specifics, [{ name: 'Brand', value: 'Weber' }]);
});

test('buildItemSpecifics drops a name a previous column already claimed', () => {
  // 'C:Brand' and 'Brand' both reduce to 'Brand'; eBay rejects the duplicate.
  const specifics = buildItemSpecifics(
    { 'C:Brand': 'Weber', Brand: 'Music City Metals' },
    [{ name: 'C:Brand' }, { name: 'Brand' }]
  );

  assert.deepEqual(specifics, [{ name: 'Brand', value: 'Weber' }]);
});

test('buildItemSpecifics falls back to field keys when the template declares no columns', () => {
  const specifics = buildItemSpecifics({ 'C:Brand': 'Weber' }, []);
  assert.deepEqual(specifics, [{ name: 'Brand', value: 'Weber' }]);
});

test('buildItemSpecifics ignores fields with no matching column', () => {
  // A field left over from a previous template version must not be sent.
  const specifics = buildItemSpecifics(
    { Brand: 'Weber', Retired: 'old value' },
    [{ name: 'Brand' }]
  );

  assert.deepEqual(specifics, [{ name: 'Brand', value: 'Weber' }]);
});

test('buildItemSpecifics returns an empty list when there is nothing to send', () => {
  assert.deepEqual(buildItemSpecifics({}, []), []);
  assert.deepEqual(buildItemSpecifics(undefined, undefined), []);
});

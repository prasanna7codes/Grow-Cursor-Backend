import assert from 'node:assert/strict';
import test from 'node:test';
import { parseItemIds } from '../src/routes/quantityUpdateExclusions.js';
import { normalizeItemId } from '../src/utils/quantityUpdateExclusions.js';

// ── Pasted input handling ────────────────────────────────────────────────────
// The admin page lets users paste a block of ItemIDs straight out of a
// spreadsheet or chat message, so the parser has to cope with mixed separators.

test('splits a pasted blob on newlines, commas and spaces', () => {
  const { valid, invalid } = parseItemIds('128020622416\n128020636554, 128020645292 128020676938');
  assert.deepEqual(valid, ['128020622416', '128020636554', '128020645292', '128020676938']);
  assert.deepEqual(invalid, []);
});

test('accepts an array of ItemIDs', () => {
  const { valid } = parseItemIds(['128020622416', ' 128020636554 ']);
  assert.deepEqual(valid, ['128020622416', '128020636554']);
});

test('de-duplicates within a single paste', () => {
  const { valid } = parseItemIds('128020622416 128020622416\n128020636554');
  assert.deepEqual(valid, ['128020622416', '128020636554']);
});

test('separates non-numeric or wrong-length tokens instead of storing them', () => {
  const { valid, invalid } = parseItemIds('128020622416, not-an-id, 123, 12345678901234567890');
  assert.deepEqual(valid, ['128020622416']);
  assert.deepEqual(invalid, ['not-an-id', '123', '12345678901234567890']);
});

test('empty input yields nothing rather than throwing', () => {
  assert.deepEqual(parseItemIds('   \n , ; '), { valid: [], invalid: [] });
  assert.deepEqual(parseItemIds(undefined), { valid: [], invalid: [] });
});

test('accepts the 12-digit ItemIDs actually in use', () => {
  const { valid, invalid } = parseItemIds(['127311585410', '800446939643', '128020683128']);
  assert.deepEqual(invalid, []);
  assert.equal(valid.length, 3);
});

// ── Lookup normalisation ─────────────────────────────────────────────────────
// eBay line items hand us `legacyItemId` as a string, but the comparison has to
// survive stray whitespace and non-string values from either side.

test('normalizeItemId trims and stringifies', () => {
  assert.equal(normalizeItemId('  128020622416 '), '128020622416');
  assert.equal(normalizeItemId(128020622416), '128020622416');
  assert.equal(normalizeItemId(null), '');
  assert.equal(normalizeItemId(undefined), '');
});

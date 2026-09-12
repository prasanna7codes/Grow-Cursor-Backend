import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COUNTRY_CONFIG,
  MAX_TEST_PILOT_SKUS,
  currencyAliases,
  estimateCredits,
  getConfig,
  getTestPilotScanLimit,
  normalizeMaxDeliveryDays,
  normalizeSkuLimit,
  resolveCurrencies,
  resolveMode
} from '../src/utils/amazonDeliveryRunConfig.js';

/**
 * The test pilot exists so a run can be tried against one region at a chosen
 * size before committing credits, so the rules that turn a form into a run
 * config are worth pinning down: a mistake here either spends credits on the
 * wrong marketplace or silently runs far larger than was asked for.
 */

test('a seller-scoped request is always the seller mode', () => {
  assert.equal(resolveMode('test_pilot', 'someSellerId'), 'seller');
  assert.equal(resolveMode('full', 'someSellerId'), 'seller');
});

test('known modes pass through and unknown ones fall back to custom', () => {
  assert.equal(resolveMode('test_pilot', null), 'test_pilot');
  assert.equal(resolveMode('full', null), 'full');
  assert.equal(resolveMode('pilot_option_b', null), 'pilot_option_b');
  assert.equal(resolveMode('', null), 'custom');
  assert.equal(resolveMode(undefined, null), 'custom');
  // Never trust a mode straight off the query string.
  assert.equal(resolveMode('__proto__', null), 'custom');
  assert.equal(resolveMode('seller', null), 'custom');
});

test('a test pilot is single-region even when several are offered', () => {
  assert.deepEqual(resolveCurrencies('test_pilot', ['GBP', 'USD', 'CAD']), ['GBP']);
  assert.deepEqual(resolveCurrencies('test_pilot', 'CAD,USD'), ['CAD']);
});

test('a test pilot with no usable region falls back to USD', () => {
  assert.deepEqual(resolveCurrencies('test_pilot', []), ['USD']);
  assert.deepEqual(resolveCurrencies('test_pilot', 'JPY'), ['USD']);
  assert.deepEqual(resolveCurrencies('test_pilot', undefined), ['USD']);
});

test('legacy GB rows resolve to GBP wherever a region is chosen', () => {
  assert.deepEqual(resolveCurrencies('test_pilot', ['GB']), ['GBP']);
  assert.deepEqual(resolveCurrencies('custom', 'GB,USD'), ['GBP', 'USD']);
  assert.deepEqual(currencyAliases('GBP'), ['GBP', 'GB']);
  assert.deepEqual(currencyAliases('USD'), ['USD']);
});

test('the wide modes ignore whatever regions were posted', () => {
  assert.deepEqual(resolveCurrencies('full', ['GBP']), ['USD', 'AUD', 'CAD', 'GBP']);
  assert.deepEqual(resolveCurrencies('pilot_option_b', ['GBP']), ['USD', 'AUD', 'CAD', 'GBP']);
});

test('a custom run keeps every supported region it was given', () => {
  assert.deepEqual(resolveCurrencies('custom', 'USD,CAD'), ['USD', 'CAD']);
  assert.deepEqual(resolveCurrencies('custom', ['AUD', 'JPY']), ['AUD']);
  assert.deepEqual(resolveCurrencies('custom', ''), ['USD']);
});

test('the requested test size is clamped to a sane range', () => {
  assert.equal(normalizeSkuLimit(50), 50);
  assert.equal(normalizeSkuLimit('50'), 50);
  assert.equal(normalizeSkuLimit(1), 1);
  // Junk, blank and non-positive values fall back to the default rather than
  // becoming an unbounded run.
  assert.equal(normalizeSkuLimit(0), 25);
  assert.equal(normalizeSkuLimit(-5), 25);
  assert.equal(normalizeSkuLimit(''), 25);
  assert.equal(normalizeSkuLimit(undefined), 25);
  assert.equal(normalizeSkuLimit('abc'), 25);
  assert.equal(normalizeSkuLimit(99999), MAX_TEST_PILOT_SKUS);
});

test('the scan window is a multiple of the test size but stays bounded', () => {
  // Most base SKUs have no ASIN, so finding N checkable ones means scanning
  // well past N — while never turning into a whole-collection scan.
  assert.ok(getTestPilotScanLimit(25) > 25);
  assert.equal(getTestPilotScanLimit(25), 1250);
  assert.ok(getTestPilotScanLimit(MAX_TEST_PILOT_SKUS) <= 20000);
});

test('the delivery SLA is clamped, and zero stays meaningful', () => {
  assert.equal(normalizeMaxDeliveryDays(9), 9);
  assert.equal(normalizeMaxDeliveryDays('9'), 9);
  // Same-day-only is a legitimate setting, so 0 must survive.
  assert.equal(normalizeMaxDeliveryDays(0), 0);
  assert.equal(normalizeMaxDeliveryDays(-5), 0);
  assert.equal(normalizeMaxDeliveryDays(9999), 365);
  assert.equal(normalizeMaxDeliveryDays('abc'), 9);
  assert.equal(normalizeMaxDeliveryDays(undefined), 9);
});

test('credits follow the per-marketplace rate', () => {
  assert.equal(getConfig('USD').credits, 1);
  assert.equal(getConfig('GB').country, 'United Kingdom');
  assert.equal(getConfig('JPY'), null);
  // A 25-SKU US test pilot is 25 credits; the same test on .co.uk is 125.
  assert.equal(estimateCredits(Array.from({ length: 25 }, () => ({ currency: 'USD' }))), 25);
  assert.equal(estimateCredits(Array.from({ length: 25 }, () => ({ currency: 'GBP' }))), 125);
  // Unsupported currencies contribute nothing rather than NaN.
  assert.equal(estimateCredits([{ currency: 'JPY' }, { currency: 'USD' }]), 1);
});

test('every marketplace has a delivery destination pinned', () => {
  // An unpinned request is quoted from wherever the scraper lands and comes
  // back reproducibly slower, so a blank postal code here would silently
  // reintroduce false "too slow" flags.
  for (const [currency, config] of Object.entries(COUNTRY_CONFIG)) {
    assert.ok(config.postalCode, `${currency} has no postal code pinned`);
  }
  // US quotes are priced for Casper WY, matching the account's own address.
  assert.equal(COUNTRY_CONFIG.USD.postalCode, '82601');
});

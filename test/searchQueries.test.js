import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSearchQueries,
  mergeSearchQueries,
  withNameFallback,
  SEARCH_QUERY_LIMITS
} from '../src/utils/searchQueries.js';

test('trims, collapses whitespace and drops empties', () => {
  assert.deepEqual(
    normalizeSearchQueries(['  magsafe   case ', '', '   ', 'phone grip']),
    ['magsafe case', 'phone grip']
  );
});

test('de-duplicates case-insensitively but keeps the first spelling', () => {
  // The operator typed "MagSafe Case"; that is what should show in the UI.
  assert.deepEqual(
    normalizeSearchQueries(['MagSafe Case', 'magsafe case', 'MAGSAFE CASE']),
    ['MagSafe Case']
  );
});

test('ignores non-arrays and non-string entries', () => {
  assert.deepEqual(normalizeSearchQueries(null), []);
  assert.deepEqual(normalizeSearchQueries('phone case'), []);
  assert.deepEqual(normalizeSearchQueries(undefined), []);
  assert.deepEqual(normalizeSearchQueries([null, undefined, 'ok']), ['ok']);
});

test('caps keyword count and length', () => {
  const many = Array.from({ length: 40 }, (_, i) => `keyword ${i}`);
  assert.equal(normalizeSearchQueries(many).length, SEARCH_QUERY_LIMITS.MAX_QUERIES_PER_NODE);

  // A very long string is a paste accident, not a keyword.
  const long = 'x'.repeat(500);
  assert.equal(normalizeSearchQueries([long])[0].length, SEARCH_QUERY_LIMITS.MAX_QUERY_LENGTH);
});

test('merging preserves order and de-duplicates across sources', () => {
  // Order matters: the most specific node's keywords are searched first, which
  // decides what a run finds when it stops at its page ceiling.
  assert.deepEqual(
    mergeSearchQueries(['product kw'], ['range kw', 'PRODUCT KW'], ['category kw']),
    ['product kw', 'range kw', 'category kw']
  );
});

test('merging tolerates missing and malformed lists', () => {
  assert.deepEqual(mergeSearchQueries(undefined, ['a'], null, 'nope'), ['a']);
  assert.deepEqual(mergeSearchQueries(), []);
});

test('an unconfigured node falls back to its own name', () => {
  // A category nobody has added keywords to must still be searchable.
  assert.deepEqual(withNameFallback([], 'Phone Accessories'), ['Phone Accessories']);
  assert.deepEqual(withNameFallback([], '  Watch  Straps '), ['Watch Straps']);
});

test('a configured node keeps its keywords and ignores the name', () => {
  assert.deepEqual(
    withNameFallback(['magsafe case'], 'Phone Accessories'),
    ['magsafe case']
  );
});

test('an unconfigured node with no usable name yields nothing to search', () => {
  // The route treats this as "no keywords" and reports it rather than
  // firing a search for an empty string.
  assert.deepEqual(withNameFallback([], ''), []);
  assert.deepEqual(withNameFallback([], '   '), []);
});

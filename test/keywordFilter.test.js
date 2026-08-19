import assert from 'node:assert/strict';
import test from 'node:test';
import { parseKeywordQuery, matchesKeywords } from '../src/utils/keywordFilter.js';

const match = (haystack, query) =>
  matchesKeywords(haystack.toLowerCase(), parseKeywordQuery(query));

test('space-separated words are ANDed, in any order and position', () => {
  // The case that motivated this: plain substring required "phone case" to be
  // adjacent, eBay's own search ORs the words. Both are wrong for badging.
  assert.equal(match('Slim Magnetic Phone Cover Case for Samsung', 'phone case'), true);
  assert.equal(match('Case with Screen Protector for Phone', 'phone case'), true);

  assert.equal(match('Slim Magnetic Phone Cover for Samsung', 'phone case'), false);
  assert.equal(match('Watch Case for Apple Watch', 'phone case'), false);
});

test('comma-separated terms are alternatives', () => {
  // Real inventory titles split the same product across "Band" and "Strap".
  assert.equal(match('Silicone Sport Bands for Apple Watch', 'strap,band'), true);
  assert.equal(match('Slim Silicone Strap Compatible with Apple Watch', 'strap,band'), true);
  assert.equal(match('Watch Case for Apple Watch Ultra', 'strap,band'), false);
});

test('AND within each OR alternative', () => {
  const query = 'apple strap,apple band';

  assert.equal(match('Nylon Strap for Apple Watch', query), true);
  assert.equal(match('Sport Band for Apple Watch', query), true);
  // Has "strap" but not "apple" — neither alternative fully satisfied.
  assert.equal(match('Nylon Strap for Garmin', query), false);
});

test('empty and whitespace-only queries match everything', () => {
  assert.equal(match('anything at all', ''), true);
  assert.equal(match('anything at all', '  '), true);
  assert.equal(match('anything at all', ' , ,'), true);
  assert.deepEqual(parseKeywordQuery(null), []);
});

test('matching is case-insensitive and tolerates messy separators', () => {
  assert.equal(match('SLIM PHONE CASE', 'Phone  Case'), true);
  assert.deepEqual(parseKeywordQuery(' Phone  Case , STRAP '), [['phone', 'case'], ['strap']]);
});

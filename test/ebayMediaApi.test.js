import assert from 'node:assert/strict';
import test from 'node:test';
import { extractImageId } from '../src/utils/ebayMediaApi.js';

// ── Location header parsing ──────────────────────────────────────────────────
//
// create_image_from_file returns 201 with an empty body, so this header is the
// only route to the image id. Misparsing it loses a picture that was already
// uploaded and paid for in rate-limit budget.

test('the image id is read from the documented Location URI', () => {
  assert.equal(
    extractImageId('https://apim.ebay.com/commerce/media/v1_beta/image/1********0'),
    '1********0'
  );
});

test('a bare image id is accepted', () => {
  // The docs invite callers to persist either the full URI or the id alone, so
  // a response carrying the short form is not obviously out of contract.
  assert.equal(extractImageId('1********0'), '1********0');
});

test('surrounding whitespace and a trailing slash do not corrupt the id', () => {
  assert.equal(
    extractImageId('  https://apim.ebay.com/commerce/media/v1_beta/image/abc123/  '),
    'abc123'
  );
});

test('a missing or unusable Location header yields null rather than a bad id', () => {
  // Returning '' or 'undefined' here would send a GET to .../image/undefined
  // and surface as a confusing 404 instead of a clear upload failure.
  for (const bad of [undefined, null, '', '   ', '/', '///', 42, {}]) {
    assert.equal(extractImageId(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

const { buildAmazonUrl, isAssociateTag } = await import('../src/utils/amazonLink.js');

test('builds the affiliate URL in the required format', () => {
  assert.equal(
    buildAmazonUrl('B0FSXQRTGC', 'shreejagann0f-20'),
    'https://www.amazon.com/dp/B0FSXQRTGC?tag=shreejagann0f-20'
  );
});

test('normalises the ASIN', () => {
  assert.equal(
    buildAmazonUrl('  b0fsxqrtgc  ', 'shreejagann0f-20'),
    'https://www.amazon.com/dp/B0FSXQRTGC?tag=shreejagann0f-20'
  );
});

test('omits the tag rather than emitting an empty one', () => {
  const untagged = 'https://www.amazon.com/dp/B0FSXQRTGC';
  assert.equal(buildAmazonUrl('B0FSXQRTGC', ''), untagged);
  assert.equal(buildAmazonUrl('B0FSXQRTGC', null), untagged);
  assert.equal(buildAmazonUrl('B0FSXQRTGC', undefined), untagged);
  // A malformed tag is dropped too, so the misconfiguration is visible in the
  // panel instead of being silently sent to Amazon and ignored.
  assert.equal(buildAmazonUrl('B0FSXQRTGC', 'not a tag'), untagged);
});

test('returns null when there is no ASIN to link to', () => {
  assert.equal(buildAmazonUrl('', 'shreejagann0f-20'), null);
  assert.equal(buildAmazonUrl(null, 'shreejagann0f-20'), null);
});

test('isAssociateTag recognises the store-id-NN shape', () => {
  assert.equal(isAssociateTag('shreejagann0f-20'), true);
  assert.equal(isAssociateTag('mystore-21'), true);
  assert.equal(isAssociateTag('a-20'), true, 'single-character store ids exist');

  assert.equal(isAssociateTag('shreejagann0f'), false, 'no numeric suffix');
  assert.equal(isAssociateTag('shreejagann0f-2'), false, 'suffix is two digits');
  assert.equal(isAssociateTag('shreejagann0f-200'), false, 'suffix is two digits');
  assert.equal(isAssociateTag('-20'), false);
  assert.equal(isAssociateTag(''), false);
});

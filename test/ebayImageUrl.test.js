import assert from 'node:assert/strict';
import test from 'node:test';
import { upsizeEbayImageUrl } from '../src/utils/ebayImageUrl.js';

// The SKU index only stores the gallery thumbnail; reverse-image search on a
// 140px picture misses matches a 1600px one finds, so the upsizing is what
// makes the audit's eBay-side check worth running at all.

test('modern eBay picture URLs are rewritten to the 1600px variant', () => {
  assert.equal(
    upsizeEbayImageUrl('https://i.ebayimg.com/images/g/abcDEF/s-l225.jpg'),
    'https://i.ebayimg.com/images/g/abcDEF/s-l1600.jpg'
  );
  assert.equal(
    upsizeEbayImageUrl('https://i.ebayimg.com/thumbs/images/g/abc/s-l140.webp'),
    'https://i.ebayimg.com/thumbs/images/g/abc/s-l1600.webp'
  );
});

test('legacy $_N picture URLs are rewritten to the $_57 variant and keep their query', () => {
  assert.equal(
    upsizeEbayImageUrl('https://i.ebayimg.com/00/s/MTYwMFgxNjAw/z/abc/$_1.JPG?set_id=880000500F'),
    'https://i.ebayimg.com/00/s/MTYwMFgxNjAw/z/abc/$_57.JPG?set_id=880000500F'
  );
});

test('non-eBay and empty URLs pass through untouched', () => {
  assert.equal(upsizeEbayImageUrl('https://m.media-amazon.com/images/I/x/s-l225.jpg'), 'https://m.media-amazon.com/images/I/x/s-l225.jpg');
  assert.equal(upsizeEbayImageUrl(''), '');
  assert.equal(upsizeEbayImageUrl(null), '');
});

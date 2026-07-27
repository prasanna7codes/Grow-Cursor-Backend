import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOverlayMapping,
  buildCacheKey,
  buildOverlayResult,
  isAlreadyOverlaid,
  replacePrimaryImage,
  resolveTemplateOverlay,
  withOverlaidPrimary,
} from '../src/utils/overlayImage.js';
import { resolveBadge, listBadges } from '../src/config/overlayBadges.js';

const SELLER_ID = '507f1f77bcf86cd799439011';

const BASE_KEY_INPUT = {
  sourceUrl: 'https://m.media-amazon.com/images/I/abc.jpg',
  badgeKey: 'case-only',
  badgeVersion: 1,
  scale: 0.26,
  anchor: 'bottom-right',
  margin: 0.015,
  sellerId: SELLER_ID,
};

// ── Badge registry ───────────────────────────────────────────────────────────

test('registered badges resolve to a path inside the badge directory', () => {
  const badge = resolveBadge('case-only');

  assert.ok(badge);
  assert.equal(badge.key, 'case-only');
  assert.ok(badge.filePath.endsWith('public/uploads/overlay-badges/case-only-overlay.png'));
  assert.equal(typeof badge.version, 'number');
});

test('unknown or path-like badge keys resolve to nothing', () => {
  assert.equal(resolveBadge('does-not-exist'), null);
  assert.equal(resolveBadge('../../../etc/passwd'), null);
  assert.equal(resolveBadge(''), null);
  assert.equal(resolveBadge(null), null);
  assert.equal(resolveBadge({ toString: () => 'case-only' }), null);
});

test('the badge catalogue exposes no filesystem paths', () => {
  for (const badge of listBadges()) {
    assert.deepEqual(Object.keys(badge).sort(), ['key', 'label', 'version']);
  }
});

// ── Cache key ────────────────────────────────────────────────────────────────

test('cache key is stable for identical inputs', () => {
  assert.equal(buildCacheKey(BASE_KEY_INPUT), buildCacheKey({ ...BASE_KEY_INPUT }));
});

test('every input that changes the rendered image changes the key', () => {
  const base = buildCacheKey(BASE_KEY_INPUT);

  const variants = {
    sourceUrl: 'https://m.media-amazon.com/images/I/other.jpg',
    badgeKey: 'another-badge',
    // Bumping the artwork version must invalidate previous composites,
    // otherwise updated artwork never reaches existing listings.
    badgeVersion: 2,
    scale: 0.3,
    anchor: 'top-left',
    margin: 0.02,
    // EPS pictures are account-scoped, so sellers must not share a composite.
    sellerId: '507f1f77bcf86cd799439012',
  };

  for (const [field, value] of Object.entries(variants)) {
    assert.notEqual(
      buildCacheKey({ ...BASE_KEY_INPUT, [field]: value }),
      base,
      `${field} does not affect the cache key`
    );
  }
});

// ── Idempotency guard ────────────────────────────────────────────────────────

test('already-hosted images are recognised so they are never double-badged', () => {
  assert.equal(isAlreadyOverlaid('https://i.ebayimg.com/images/g/abc/s-l1600.jpg'), true);
  assert.equal(isAlreadyOverlaid('https://galleryplus.ebayimg.com/ws/web/123'), true);

  assert.equal(isAlreadyOverlaid('https://m.media-amazon.com/images/I/abc.jpg'), false);
  assert.equal(isAlreadyOverlaid('not a url'), false);
  assert.equal(isAlreadyOverlaid(''), false);
  assert.equal(isAlreadyOverlaid(null), false);
  // Must match on hostname, not a substring anywhere in the URL.
  assert.equal(isAlreadyOverlaid('https://evil.example.com/?x=i.ebayimg.com'), false);
});

// ── Template allowlist ───────────────────────────────────────────────────────

test('a badge is only honoured when the template offers it', () => {
  const template = {
    _id: 'template-1',
    overlayOptions: [{ badgeKey: 'case-only', scale: 0.3, anchor: 'top-left', margin: 0.02 }],
  };

  const resolved = resolveTemplateOverlay(template, 'case-only');
  assert.ok(resolved);
  assert.equal(resolved.badge.key, 'case-only');
  assert.deepEqual(resolved.placement, { scale: 0.3, anchor: 'top-left', margin: 0.02 });

  // Registered, but not enabled on this template.
  assert.equal(resolveTemplateOverlay({ _id: 'template-2', overlayOptions: [] }, 'case-only'), null);
  // Enabled, but not registered anywhere.
  assert.equal(
    resolveTemplateOverlay({ _id: 'template-3', overlayOptions: [{ badgeKey: 'ghost' }] }, 'ghost'),
    null
  );
  // No badge requested.
  assert.equal(resolveTemplateOverlay(template, ''), null);
  assert.equal(resolveTemplateOverlay(template, null), null);
  // Template with no overlay configuration at all.
  assert.equal(resolveTemplateOverlay({}, 'case-only'), null);
});

test('template placement is normalised, so bad stored config cannot break rendering', () => {
  const template = {
    overlayOptions: [{ badgeKey: 'case-only', scale: 50, anchor: 'diagonal', margin: -1 }],
  };

  assert.deepEqual(resolveTemplateOverlay(template, 'case-only').placement, {
    scale: 1,
    anchor: 'bottom-right',
    margin: 0,
  });
});

// ── The no-mutation contract ─────────────────────────────────────────────────
// asinCache runs with useClones:false, so fetchAmazonData hands back the live
// cached object. Writing to it would push the badge into the shared cache and
// leak it into every other template, plus the compatibility/directory/stock
// callers. These tests pin that contract on the paths that need no network.

test('swapping the primary image never writes to the cached object', () => {
  const originalImages = [
    'https://m.media-amazon.com/images/I/primary.jpg',
    'https://m.media-amazon.com/images/I/second.jpg',
    'https://m.media-amazon.com/images/I/third.jpg',
  ];
  // Stand-in for the live asinCache entry fetchAmazonData hands back.
  const cached = { asin: 'B001', title: 'Phone case', images: originalImages };

  const result = replacePrimaryImage(cached, 'https://i.ebayimg.com/images/g/x/s-l1600.jpg');

  // The caller gets the badge...
  assert.equal(result.images[0], 'https://i.ebayimg.com/images/g/x/s-l1600.jpg');
  assert.deepEqual(result.images.slice(1), originalImages.slice(1));
  assert.equal(result.title, 'Phone case');

  // ...and the cache entry is byte-for-byte what it was. If this ever fails,
  // the badge is leaking into every other template that shares the ASIN.
  assert.notEqual(result, cached);
  assert.notEqual(result.images, cached.images);
  assert.deepEqual(cached.images, originalImages);
  assert.equal(cached.images[0], 'https://m.media-amazon.com/images/I/primary.jpg');
});

test('swapping the primary image copes with a single image and with none', () => {
  assert.deepEqual(replacePrimaryImage({ images: ['a'] }, 'new').images, ['new']);
  assert.deepEqual(replacePrimaryImage({ images: [] }, 'new').images, ['new']);
  assert.deepEqual(replacePrimaryImage({}, 'new').images, ['new']);
});

// ── Swapping the badge into already-saved fields ─────────────────────────────
// A duplicate update hands back the listing's saved itemPhotoUrl and
// description for editing rather than regenerating them. Without the swap the
// modal previews a badged image while the CSV exports the original Amazon URLs.

const RAW_PRIMARY = 'https://m.media-amazon.com/images/I/71L6TNwtQJL._AC_SL1500_.jpg';
const BADGED = 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg';
const MAPPING = { from: RAW_PRIMARY, to: BADGED };

test('the primary image is swapped in a pipe-separated itemPhotoUrl', () => {
  const saved = [RAW_PRIMARY, 'https://m.media-amazon.com/images/I/second.jpg'].join(' | ');

  const result = applyOverlayMapping(saved, MAPPING);

  assert.equal(result, `${BADGED} | https://m.media-amazon.com/images/I/second.jpg`);
  assert.equal(result.includes(RAW_PRIMARY), false);
});

test('the primary image is swapped everywhere it appears in description HTML', () => {
  // The same URL is the hero image and can recur in the gallery table.
  const html = `<img src='${RAW_PRIMARY}' width='100%'><td><img src='${RAW_PRIMARY}'></td>`;

  const result = applyOverlayMapping(html, MAPPING);

  assert.equal(result, `<img src='${BADGED}' width='100%'><td><img src='${BADGED}'></td>`);
});

test('secondary images are never touched by the swap', () => {
  const saved = [
    'https://m.media-amazon.com/images/I/other.jpg',
    'https://m.media-amazon.com/images/I/more.jpg',
  ].join(' | ');

  assert.equal(applyOverlayMapping(saved, MAPPING), saved);
});

test('no mapping, or hand-edited images, leaves saved fields exactly as they were', () => {
  const saved = `${RAW_PRIMARY} | https://m.media-amazon.com/images/I/second.jpg`;

  // Overlay not applied (no badge selected, token failure, source too small).
  assert.equal(applyOverlayMapping(saved, null), saved);
  assert.equal(applyOverlayMapping(saved, undefined), saved);
  assert.equal(applyOverlayMapping(saved, { from: '', to: BADGED }), saved);
  assert.equal(applyOverlayMapping(saved, { from: RAW_PRIMARY }), saved);

  // Images replaced by hand: the original primary is gone, so nothing matches.
  assert.equal(applyOverlayMapping('https://example.com/custom.jpg', MAPPING), 'https://example.com/custom.jpg');

  // Empty and non-string inputs must not throw.
  assert.equal(applyOverlayMapping('', MAPPING), '');
  assert.equal(applyOverlayMapping(null, MAPPING), null);
  assert.equal(applyOverlayMapping(undefined, MAPPING), undefined);
});

test('an applied overlay reports the mapping its callers need', () => {
  // Pins the contract the duplicate-update branches depend on. Without
  // `mapping` they silently fall back to the saved raw URLs, which is exactly
  // how a badged preview ended up exporting unbadged images.
  const result = buildOverlayResult({ asin: 'B001', images: [RAW_PRIMARY, 'b.jpg'] }, RAW_PRIMARY, BADGED);

  assert.equal(result.applied, true);
  assert.deepEqual(result.mapping, { from: RAW_PRIMARY, to: BADGED });
  assert.equal(result.data.images[0], BADGED);

  // And the mapping it reports must be the one that fixes a saved field.
  assert.equal(applyOverlayMapping(`${RAW_PRIMARY} | b.jpg`, result.mapping), `${BADGED} | b.jpg`);
});

test('no overlay requested leaves the data object untouched and identical', async () => {
  const amazonData = { asin: 'B001', images: ['https://m.media-amazon.com/images/I/a.jpg'] };
  const result = await withOverlaidPrimary(amazonData, null, { sellerId: SELLER_ID, token: 't' });

  assert.equal(result.applied, false);
  assert.equal(result.data, amazonData);
  assert.deepEqual(amazonData.images, ['https://m.media-amazon.com/images/I/a.jpg']);
});

test('a missing token or seller skips the overlay instead of throwing', async () => {
  const amazonData = { asin: 'B001', images: ['https://m.media-amazon.com/images/I/a.jpg'] };
  const overlay = { badge: resolveBadge('case-only'), placement: { scale: 0.26, anchor: 'bottom-right', margin: 0.015 } };

  assert.equal((await withOverlaidPrimary(amazonData, overlay, { sellerId: SELLER_ID })).applied, false);
  assert.equal((await withOverlaidPrimary(amazonData, overlay, { token: 't' })).applied, false);
  assert.equal((await withOverlaidPrimary(amazonData, overlay, {})).applied, false);
});

test('an image already hosted on eBay is left alone', async () => {
  const amazonData = { asin: 'B001', images: ['https://i.ebayimg.com/images/g/abc/s-l1600.jpg'] };
  const overlay = { badge: resolveBadge('case-only'), placement: { scale: 0.26, anchor: 'bottom-right', margin: 0.015 } };

  const result = await withOverlaidPrimary(amazonData, overlay, { sellerId: SELLER_ID, token: 't' });

  assert.equal(result.applied, false);
  assert.equal(result.data, amazonData);
});

test('an empty image list is handled without touching the input', async () => {
  const overlay = { badge: resolveBadge('case-only'), placement: { scale: 0.26, anchor: 'bottom-right', margin: 0.015 } };

  assert.equal((await withOverlaidPrimary({ asin: 'B001', images: [] }, overlay, { sellerId: SELLER_ID, token: 't' })).applied, false);
  assert.equal((await withOverlaidPrimary({ asin: 'B001' }, overlay, { sellerId: SELLER_ID, token: 't' })).applied, false);
  assert.equal((await withOverlaidPrimary(null, overlay, { sellerId: SELLER_ID, token: 't' })).applied, false);
});

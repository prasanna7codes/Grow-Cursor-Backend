import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOverlayMapping,
  buildCacheKey,
  canReuseCachedImage,
  buildOverlayResult,
  hostsAreUniform,
  isAlreadyOverlaid,
  isExpiring,
  NO_OVERLAY,
  refreshExpiredImages,
  replaceImages,
  resolveEffectiveBadgeKey,
  resolveSavedImageList,
  resolveTemplateOverlay,
  splitImageList,
  toLargestEbayVariant,
  withOverlaidImages,
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
  // Separators normalised: path.join yields backslashes on Windows.
  assert.ok(badge.filePath.replace(/\\/g, '/').endsWith('public/uploads/overlay-badges/case-only-overlay.png'));
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

// ── Template default badge ───────────────────────────────────────────────────
// Whether a template badges its listings is configured once in Manage
// Templates. Entry points with no picker of their own — the ASIN List page's
// directory stream — rely on this to apply the overlay at all.

test('the template default is used when a batch names no badge', () => {
  const template = {
    overlayOptions: [
      { badgeKey: 'other-badge' },
      { badgeKey: 'case-only', isDefault: true },
    ],
  };

  const expected = { badgeKey: 'case-only', usingDefault: true, optedOut: false };

  assert.deepEqual(resolveEffectiveBadgeKey(template, ''), expected);
  assert.deepEqual(resolveEffectiveBadgeKey(template, null), expected);
  assert.deepEqual(resolveEffectiveBadgeKey(template, undefined), expected);
});

test('an explicitly requested badge beats the default', () => {
  const template = { overlayOptions: [{ badgeKey: 'case-only', isDefault: true }] };

  assert.deepEqual(resolveEffectiveBadgeKey(template, 'other-badge'), {
    badgeKey: 'other-badge',
    usingDefault: false,
    optedOut: false,
  });
});

test('no default means no overlay, which is how it is switched off', () => {
  // Unchecking the box in Manage Templates has to actually stop the badge,
  // even though the badge is still offered by the template.
  const offeredButNotDefault = { overlayOptions: [{ badgeKey: 'case-only', isDefault: false }] };
  const off = { badgeKey: '', usingDefault: false, optedOut: false };

  assert.deepEqual(resolveEffectiveBadgeKey(offeredButNotDefault, ''), off);
  assert.deepEqual(resolveEffectiveBadgeKey({ overlayOptions: [] }, ''), off);
  assert.deepEqual(resolveEffectiveBadgeKey({}, ''), off);
  assert.deepEqual(resolveEffectiveBadgeKey(null, ''), off);
});

// ── Opting a single batch out ────────────────────────────────────────────────
// The default has to be overridable per batch: a template whose badge suits
// most of its ASINs but not this batch's needs a way to say so. "Said nothing"
// and "said no" cannot be the same value, or the picker's None option silently
// badges the batch anyway — which is what it did before NO_OVERLAY existed.

test('an explicit opt-out beats the template default', () => {
  const template = { overlayOptions: [{ badgeKey: 'case-only', isDefault: true }] };

  assert.deepEqual(resolveEffectiveBadgeKey(template, NO_OVERLAY), {
    badgeKey: '',
    usingDefault: false,
    optedOut: true,
  });
});

test('opting out is distinguishable from saying nothing', () => {
  // The whole point of the sentinel. If these two ever return the same thing,
  // the batch picker has no way to express "not on this batch".
  const template = { overlayOptions: [{ badgeKey: 'case-only', isDefault: true }] };

  const silent = resolveEffectiveBadgeKey(template, '');
  const refused = resolveEffectiveBadgeKey(template, NO_OVERLAY);

  assert.equal(silent.badgeKey, 'case-only');
  assert.equal(refused.badgeKey, '');
  assert.equal(refused.optedOut, true);
  assert.equal(silent.optedOut, false);
});

test('opting out is harmless on a template with no default', () => {
  assert.deepEqual(resolveEffectiveBadgeKey({ overlayOptions: [] }, NO_OVERLAY), {
    badgeKey: '',
    usingDefault: false,
    optedOut: true,
  });
});

test('the opt-out sentinel can never collide with a real badge', () => {
  // NO_OVERLAY is only safe because no badge is named it. If one ever were,
  // selecting that badge would silently mean "no overlay" instead.
  assert.equal(resolveBadge(NO_OVERLAY), null);
  assert.equal(listBadges().some(badge => badge.key === NO_OVERLAY), false);
});

test('a default flagged on an option with no badgeKey is ignored', () => {
  const template = { overlayOptions: [{ isDefault: true }, { badgeKey: 'case-only', isDefault: true }] };

  // Falls through to the first usable one rather than returning an empty key
  // that would read as "overlays off".
  assert.equal(resolveEffectiveBadgeKey(template, '').badgeKey, 'case-only');
});

test('the default is still checked against the template allowlist', () => {
  // resolveEffectiveBadgeKey only picks a name; resolveTemplateOverlay decides
  // whether it is allowed. A default is a flag on an existing option, so it is
  // in the allowlist by construction — but an unregistered badge must still be
  // refused rather than reaching the filesystem.
  const template = { _id: 't1', overlayOptions: [{ badgeKey: 'ghost', isDefault: true }] };
  const { badgeKey } = resolveEffectiveBadgeKey(template, '');

  assert.equal(badgeKey, 'ghost');
  assert.equal(resolveTemplateOverlay(template, badgeKey), null);
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

test('swapping the images never writes to the cached object', () => {
  const originalImages = [
    'https://m.media-amazon.com/images/I/primary.jpg',
    'https://m.media-amazon.com/images/I/second.jpg',
    'https://m.media-amazon.com/images/I/third.jpg',
  ];
  // Stand-in for the live asinCache entry fetchAmazonData hands back.
  const cached = { asin: 'B001', title: 'Phone case', images: originalImages };
  const hosted = [
    'https://i.ebayimg.com/images/g/x/s-l1600.jpg',
    'https://i.ebayimg.com/images/g/y/s-l1600.jpg',
    'https://i.ebayimg.com/images/g/z/s-l1600.jpg',
  ];

  const result = replaceImages(cached, hosted);

  // The caller gets the hosted list...
  assert.deepEqual(result.images, hosted);
  assert.equal(result.title, 'Phone case');

  // ...and the cache entry is byte-for-byte what it was. If this ever fails,
  // the badge is leaking into every other template that shares the ASIN.
  assert.notEqual(result, cached);
  assert.notEqual(result.images, cached.images);
  assert.deepEqual(cached.images, originalImages);
  assert.equal(cached.images[0], 'https://m.media-amazon.com/images/I/primary.jpg');
});

test('swapping the images copes with a single image and with none', () => {
  assert.deepEqual(replaceImages({ images: ['a'] }, ['new']).images, ['new']);
  assert.deepEqual(replaceImages({ images: [] }, ['new']).images, ['new']);
  assert.deepEqual(replaceImages({}, ['new']).images, ['new']);
});

// ── The never-mix-hosts contract ─────────────────────────────────────────────
// eBay rejects a listing whose pictures are split across EPS and external URLs:
//   20004 - A mixture of Self Hosted and EPS pictures are not allowed.
// Badging the primary moves it to EPS, so every other image has to move too.

test('a list is uniform only when every image shares a host', () => {
  const amazon = ['https://m.media-amazon.com/images/I/a.jpg', 'https://m.media-amazon.com/images/I/b.jpg'];
  const eps = ['https://i.ebayimg.com/images/g/a/s-l1600.jpg', 'https://i.ebayimg.com/images/g/b/s-l1600.jpg'];

  assert.equal(hostsAreUniform(amazon), true);
  assert.equal(hostsAreUniform(eps), true);
  assert.equal(hostsAreUniform([]), true);

  // The exact shape that produced the 20004 failures: badged primary on EPS,
  // the rest still on Amazon.
  assert.equal(hostsAreUniform([eps[0], ...amazon]), false);
  assert.equal(hostsAreUniform([...amazon, eps[0]]), false);
});

test('an applied overlay never emits a mixed-host image list', () => {
  const originals = [
    'https://m.media-amazon.com/images/I/primary.jpg',
    'https://m.media-amazon.com/images/I/second.jpg',
    'https://m.media-amazon.com/images/I/third.jpg',
  ];
  const hosted = [
    'https://i.ebayimg.com/images/g/x/s-l1600.jpg',
    'https://i.ebayimg.com/images/g/y/s-l1600.jpg',
    'https://i.ebayimg.com/images/g/z/s-l1600.jpg',
  ];

  const result = buildOverlayResult({ asin: 'B001', images: originals }, originals, hosted);

  assert.equal(hostsAreUniform(result.data.images), true);
  assert.equal(result.data.images.some((url) => url.includes('media-amazon.com')), false);
});

// ── Swapping the badge into already-saved fields ─────────────────────────────
// A duplicate update hands back the listing's saved itemPhotoUrl and
// description for editing rather than regenerating them. Without the swap the
// modal previews a badged image while the CSV exports the original Amazon URLs.

const RAW_PRIMARY = 'https://m.media-amazon.com/images/I/71L6TNwtQJL._AC_SL1500_.jpg';
const RAW_SECOND = 'https://m.media-amazon.com/images/I/second.jpg';
const BADGED = 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg';
const HOSTED_SECOND = 'https://i.ebayimg.com/images/g/def/s-l1600.jpg';
const MAPPINGS = [
  { from: RAW_PRIMARY, to: BADGED },
  { from: RAW_SECOND, to: HOSTED_SECOND },
];

test('every image is swapped in a pipe-separated itemPhotoUrl', () => {
  const saved = [RAW_PRIMARY, RAW_SECOND].join(' | ');

  const result = applyOverlayMapping(saved, MAPPINGS);

  // Swapping only the primary here is what produced the 20004 errors: the
  // saved field kept the Amazon URLs for images 2-N alongside an EPS primary.
  assert.equal(result, `${BADGED} | ${HOSTED_SECOND}`);
  assert.equal(result.includes('media-amazon.com'), false);
  assert.equal(hostsAreUniform(result.split(' | ')), true);
});

test('the primary image is swapped everywhere it appears in description HTML', () => {
  // The same URL is the hero image and can recur in the gallery table.
  const html = `<img src='${RAW_PRIMARY}' width='100%'><td><img src='${RAW_PRIMARY}'></td>`;

  const result = applyOverlayMapping(html, MAPPINGS);

  assert.equal(result, `<img src='${BADGED}' width='100%'><td><img src='${BADGED}'></td>`);
});

test('images outside the mapping list are left alone', () => {
  const saved = [
    'https://m.media-amazon.com/images/I/other.jpg',
    'https://m.media-amazon.com/images/I/more.jpg',
  ].join(' | ');

  assert.equal(applyOverlayMapping(saved, MAPPINGS), saved);
});

test('a single mapping object is still accepted', () => {
  assert.equal(applyOverlayMapping(RAW_PRIMARY, { from: RAW_PRIMARY, to: BADGED }), BADGED);
});

test('no mappings, or hand-edited images, leaves saved fields exactly as they were', () => {
  const saved = `${RAW_PRIMARY} | ${RAW_SECOND}`;

  // Overlay not applied (no badge selected, token failure, source too small).
  assert.equal(applyOverlayMapping(saved, null), saved);
  assert.equal(applyOverlayMapping(saved, undefined), saved);
  assert.equal(applyOverlayMapping(saved, []), saved);
  assert.equal(applyOverlayMapping(saved, [{ from: '', to: BADGED }]), saved);
  assert.equal(applyOverlayMapping(saved, [{ from: RAW_PRIMARY }]), saved);

  // Images replaced by hand: the originals are gone, so nothing matches.
  assert.equal(applyOverlayMapping('https://example.com/custom.jpg', MAPPINGS), 'https://example.com/custom.jpg');

  // Empty and non-string inputs must not throw.
  assert.equal(applyOverlayMapping('', MAPPINGS), '');
  assert.equal(applyOverlayMapping(null, MAPPINGS), null);
  assert.equal(applyOverlayMapping(undefined, MAPPINGS), undefined);
});

test('an applied overlay reports the mappings its callers need', () => {
  // Pins the contract the duplicate-update branches depend on. If this reported
  // only the primary, a saved listing would keep Amazon URLs for images 2-N and
  // fail upload with 20004 — the original bug.
  const originals = [RAW_PRIMARY, RAW_SECOND];
  const result = buildOverlayResult({ asin: 'B001', images: originals }, originals, [BADGED, HOSTED_SECOND]);

  assert.equal(result.applied, true);
  assert.deepEqual(result.mappings, MAPPINGS);
  assert.deepEqual(result.data.images, [BADGED, HOSTED_SECOND]);

  // And the mappings it reports must be the ones that fix a saved field.
  assert.equal(applyOverlayMapping(originals.join(' | '), result.mappings), `${BADGED} | ${HOSTED_SECOND}`);
});

test('an image that did not move produces no mapping entry', () => {
  // Already on EPS from a previous run: nothing to rewrite in saved fields.
  const originals = [RAW_PRIMARY, HOSTED_SECOND];
  const result = buildOverlayResult({ images: originals }, originals, [BADGED, HOSTED_SECOND]);

  assert.deepEqual(result.mappings, [{ from: RAW_PRIMARY, to: BADGED }]);
});

// ── Drifted saved image lists ────────────────────────────────────────────────
// The substitution matches on the Amazon URL as it looks today. If a saved
// listing's URLs have drifted — Amazon replaced a photo, or the scraper
// returned a different set — only the still-matching ones move to EPS, and the
// half-rewritten result is the mixed-host list eBay rejects with 20004.

const DRIFTED = 'https://m.media-amazon.com/images/I/oldPhoto.jpg';
const HOSTED_LIST = [BADGED, HOSTED_SECOND, 'https://i.ebayimg.com/images/g/ghi/s-l1600.jpg'];

test('a saved list is split on the pipe regardless of spacing', () => {
  assert.deepEqual(splitImageList(`${RAW_PRIMARY} | ${RAW_SECOND}`), [RAW_PRIMARY, RAW_SECOND]);
  assert.deepEqual(splitImageList(`${RAW_PRIMARY}|${RAW_SECOND}`), [RAW_PRIMARY, RAW_SECOND]);
  assert.deepEqual(splitImageList(''), []);
  assert.deepEqual(splitImageList(null), []);
});

test('a fully-matching saved list keeps the saved order and manual edits', () => {
  // Nothing drifted: the gentle substitution wins, so any hand-picked ordering
  // in the saved field survives untouched.
  const saved = [RAW_SECOND, RAW_PRIMARY].join(' | ');

  const result = resolveSavedImageList(saved, MAPPINGS, HOSTED_LIST);

  assert.equal(result.replaced, false);
  assert.equal(result.value, `${HOSTED_SECOND} | ${BADGED}`);
});

test('a half-matching saved list falls back to the freshly hosted images', () => {
  // The exact 20004 shape: one image drifted, so substitution would leave it on
  // Amazon while the others moved to EPS.
  const saved = [RAW_PRIMARY, DRIFTED].join(' | ');

  const result = resolveSavedImageList(saved, MAPPINGS, HOSTED_LIST);

  assert.equal(result.replaced, true);
  assert.equal(result.value, HOSTED_LIST.join(' | '));
  assert.equal(hostsAreUniform(splitImageList(result.value)), true);
});

test('the fallback never produces a mixed list', () => {
  const saved = [RAW_PRIMARY, DRIFTED, RAW_SECOND].join(' | ');

  const result = resolveSavedImageList(saved, MAPPINGS, HOSTED_LIST);

  assert.equal(hostsAreUniform(splitImageList(result.value)), true);
  assert.equal(result.value.includes('media-amazon.com'), false);
});

test('with no overlay the saved list is returned untouched', () => {
  // No badge selected, or the overlay bailed out. A saved list that was already
  // mixed is left exactly as it was — this only owns damage the overlay could
  // have caused, and silently rewriting images nobody asked to change would be
  // worse than leaving them.
  const mixed = [BADGED, RAW_SECOND].join(' | ');

  assert.deepEqual(resolveSavedImageList(mixed, null, HOSTED_LIST), { value: mixed, replaced: false });
  assert.deepEqual(resolveSavedImageList(mixed, [], HOSTED_LIST), { value: mixed, replaced: false });
});

test('a missing hosted list disables the fallback rather than emptying the field', () => {
  // The overlay reported mappings but no usable image list. Falling back to
  // nothing would wipe the listing's photos, which is worse than a failed row.
  const saved = [RAW_PRIMARY, DRIFTED].join(' | ');

  assert.equal(resolveSavedImageList(saved, MAPPINGS, null).replaced, false);
  assert.equal(resolveSavedImageList(saved, MAPPINGS, []).replaced, false);
  assert.equal(resolveSavedImageList(saved, MAPPINGS, null).value.includes(DRIFTED), true);
});

test('an empty saved field does not invent images', () => {
  assert.deepEqual(resolveSavedImageList('', MAPPINGS, HOSTED_LIST), { value: '', replaced: false });
  assert.deepEqual(resolveSavedImageList(null, MAPPINGS, HOSTED_LIST), { value: '', replaced: false });
});

test('no overlay requested leaves the data object untouched and identical', async () => {
  const amazonData = { asin: 'B001', images: ['https://m.media-amazon.com/images/I/a.jpg'] };
  const result = await withOverlaidImages(amazonData, null, { sellerId: SELLER_ID, token: 't' });

  assert.equal(result.applied, false);
  assert.equal(result.data, amazonData);
  assert.deepEqual(amazonData.images, ['https://m.media-amazon.com/images/I/a.jpg']);
});

test('a missing token or seller skips the overlay instead of throwing', async () => {
  const amazonData = { asin: 'B001', images: ['https://m.media-amazon.com/images/I/a.jpg'] };
  const overlay = { badge: resolveBadge('case-only'), placement: { scale: 0.26, anchor: 'bottom-right', margin: 0.015 } };

  assert.equal((await withOverlaidImages(amazonData, overlay, { sellerId: SELLER_ID })).applied, false);
  assert.equal((await withOverlaidImages(amazonData, overlay, { token: 't' })).applied, false);
  assert.equal((await withOverlaidImages(amazonData, overlay, {})).applied, false);
});

test('a list already entirely hosted on eBay is left alone', async () => {
  const amazonData = { asin: 'B001', images: [BADGED, HOSTED_SECOND] };
  const overlay = { badge: resolveBadge('case-only'), placement: { scale: 0.26, anchor: 'bottom-right', margin: 0.015 } };

  const result = await withOverlaidImages(amazonData, overlay, { sellerId: SELLER_ID, token: 't' });

  assert.equal(result.applied, false);
  assert.equal(result.data, amazonData);
});

test('an empty image list is handled without touching the input', async () => {
  const overlay = { badge: resolveBadge('case-only'), placement: { scale: 0.26, anchor: 'bottom-right', margin: 0.015 } };

  assert.equal((await withOverlaidImages({ asin: 'B001', images: [] }, overlay, { sellerId: SELLER_ID, token: 't' })).applied, false);
  assert.equal((await withOverlaidImages({ asin: 'B001' }, overlay, { sellerId: SELLER_ID, token: 't' })).applied, false);
  assert.equal((await withOverlaidImages(null, overlay, { sellerId: SELLER_ID, token: 't' })).applied, false);
});

// ── eBay size variants (bulk overlay of existing listings) ───────────────────

test('eBay picture URLs are rewritten to the largest variant', () => {
  // The compositor drops anything under 500px as source_too_small, so a
  // thumbnail variant would silently fail to badge.
  assert.equal(
    toLargestEbayVariant('https://i.ebayimg.com/images/g/abc/s-l64.jpg'),
    'https://i.ebayimg.com/images/g/abc/s-l1600.jpg'
  );
  assert.equal(
    toLargestEbayVariant('https://i.ebayimg.com/images/g/abc/s-l500.webp'),
    'https://i.ebayimg.com/images/g/abc/s-l1600.webp'
  );
  // Already largest — unchanged.
  assert.equal(
    toLargestEbayVariant('https://i.ebayimg.com/images/g/abc/s-l1600.jpg'),
    'https://i.ebayimg.com/images/g/abc/s-l1600.jpg'
  );
});

test('non-eBay and malformed URLs pass through the variant rewriter untouched', () => {
  const amazon = 'https://m.media-amazon.com/images/I/s-l64.jpg';
  assert.equal(toLargestEbayVariant(amazon), amazon);
  assert.equal(toLargestEbayVariant('not a url'), 'not a url');
  assert.equal(toLargestEbayVariant(''), '');
  assert.equal(toLargestEbayVariant(null), null);
});

test('rewriting a variant keeps the list uniformly eBay-hosted', () => {
  // The 20004 invariant still has to hold after rewriting.
  const rewritten = [
    'https://i.ebayimg.com/images/g/a/s-l64.jpg',
    'https://i.ebayimg.com/images/g/b/s-l500.jpg',
  ].map(toLargestEbayVariant);

  assert.equal(hostsAreUniform(rewritten), true);
  assert.ok(rewritten.every((u) => u.includes('s-l1600')));
});

test('legacy eBay picture URLs are rewritten to the full-size rendition', () => {
  // Real URL from a live listing. The base64 segment decodes to "1500X1432",
  // so the picture is large — but the $_1 rendition downloads at 382x400 and
  // is dropped by the 500px floor. $_57 is the full-size one.
  const legacy = 'https://i.ebayimg.com/00/s/MTUwMFgxNDMy/z/0QEAAeSw1bNqV6hn/$_1.JPG?set_id=8800005007';

  assert.equal(
    toLargestEbayVariant(legacy),
    'https://i.ebayimg.com/00/s/MTUwMFgxNDMy/z/0QEAAeSw1bNqV6hn/$_57.JPG?set_id=8800005007'
  );
  // Already full-size — unchanged.
  assert.equal(
    toLargestEbayVariant('https://i.ebayimg.com/00/s/x/z/y/$_57.JPG'),
    'https://i.ebayimg.com/00/s/x/z/y/$_57.JPG'
  );
});

test('an eBay URL matching neither variant scheme is left alone', () => {
  const odd = 'https://i.ebayimg.com/images/g/abc/custom.jpg';
  assert.equal(toLargestEbayVariant(odd), odd);
});

// ── Cache expiry ─────────────────────────────────────────────────────────────
//
// EPS drops a picture that no live listing references. A cache hit on a dropped
// picture hands a dead URL into a listing's image list, and hostAllImages()
// treats one bad image as poisoning the whole listing — so getting this wrong
// is a listing failure, not a slow path.

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-27T12:00:00Z');

test('a picture with plenty of runway is reused', () => {
  assert.equal(isExpiring(new Date(NOW + 5 * 24 * HOUR), NOW), false);
});

test('a picture already past its expiry is not reused', () => {
  assert.equal(isExpiring(new Date(NOW - HOUR), NOW), true);
});

test('a picture expiring inside the safety margin is not reused', () => {
  // The gap that matters is preview → CSV export → upload, which routinely
  // spans a working day. Twelve hours of runway is not enough to survive it.
  assert.equal(isExpiring(new Date(NOW + 12 * HOUR), NOW), true);
  assert.equal(isExpiring(new Date(NOW + 25 * HOUR), NOW), false);
});

test('pre-migration rows with no expiry are re-hosted rather than trusted', () => {
  // UploadSiteHostedPictures returned no expiry and offered no way to query
  // one, so these rows have an unknown deadline. Re-hosting once is the only
  // way to get back to a picture whose lifetime is known.
  assert.equal(isExpiring(null, NOW), true);
  assert.equal(isExpiring(undefined, NOW), true);
});

test('an unparseable expiry is treated as expired', () => {
  assert.equal(isExpiring('not a date', NOW), true);
});

test('an ISO string expiry is accepted, not just a Date', () => {
  // Mongo hands back Dates, but .lean() results and any JSON round trip do not.
  assert.equal(isExpiring('2026-09-05T12:00:00Z', NOW), false);
  assert.equal(isExpiring('2026-08-27T18:00:00Z', NOW), true);
});

// ── Cache reuse window ───────────────────────────────────────────────────────
//
// The stored expiry describes the picture at upload time, while it was still
// unattached. Once a listing uses it the real lifetime becomes that listing's,
// and eBay drops the picture days after the listing ENDS — an event this system
// never observes. So a row can hold an expiry that outlives its own picture,
// and age is the second, independent guard against trusting it.

const FRESH = {
  hostedUrl: 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg',
  expiresAt: new Date(NOW + 5 * 24 * HOUR),
  hostedAt: new Date(NOW - HOUR),
};

test('a freshly hosted picture with runway is reused', () => {
  assert.equal(canReuseCachedImage(FRESH, NOW), true);
});

test('a row older than the trust window is re-hosted even with a valid expiry', () => {
  // The ended-listing case: relisting the same ASIN weeks later must not serve
  // a URL whose picture eBay reclaimed when the first listing ended.
  assert.equal(
    canReuseCachedImage({ ...FRESH, hostedAt: new Date(NOW - 30 * 24 * HOUR) }, NOW),
    false
  );
});

test('the trust window brackets a week, not a fortnight', () => {
  // Seven days. Wide enough that re-exporting a batch days later reuses its
  // pictures instead of re-uploading them, and still far short of the 30-day
  // retention that measurement (scripts/checkEpsImages.js) confirmed.
  assert.equal(canReuseCachedImage({ ...FRESH, hostedAt: new Date(NOW - 6 * 24 * HOUR) }, NOW), true);
  assert.equal(canReuseCachedImage({ ...FRESH, hostedAt: new Date(NOW - 8 * 24 * HOUR) }, NOW), false);
});

test('a young row whose picture is expiring is still refused', () => {
  // Age and expiry are independent reasons to refuse; neither rescues the other.
  assert.equal(
    canReuseCachedImage({ ...FRESH, expiresAt: new Date(NOW + 2 * HOUR) }, NOW),
    false
  );
});

test('rows missing the fields this depends on are never reused', () => {
  assert.equal(canReuseCachedImage(null, NOW), false);
  assert.equal(canReuseCachedImage({}, NOW), false);
  // Pre-migration rows: no expiry, no hostedAt.
  assert.equal(canReuseCachedImage({ hostedUrl: 'https://i.ebayimg.com/x.jpg' }, NOW), false);
  // Hosted recently, but the row carries no URL to hand back.
  assert.equal(canReuseCachedImage({ ...FRESH, hostedUrl: '' }, NOW), false);
});

// The export path prefetches every listing's ledger rows in one query and hands
// the result down through ctx.recipes. These pin that the prefetched map is
// actually used: there is no database connection in this suite, so anything
// that fell back to querying per listing would hang or throw rather than pass.
test('a prefetched recipe map is used instead of a per-listing query', async () => {
  const url = 'https://i.ebayimg.com/images/g/prefetched/s-l1600.jpg';

  const recipes = new Map([
    [
      url,
      {
        hostedUrl: url,
        sourceUrl: 'https://m.media-amazon.com/images/I/abc.jpg',
        badgeKey: 'case-only',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        hostedAt: new Date(),
      },
    ],
  ]);

  const result = await refreshExpiredImages([url], {
    sellerId: SELLER_ID,
    token: 'token',
    recipes,
  });

  // Fresh expiry and freshly hosted, so nothing to rebuild.
  assert.equal(result.refreshed, false);
  assert.deepEqual(result.images, [url]);
  assert.equal(result.warning, undefined);
});

test('a picture missing from the prefetched map is reported, not re-queried', async () => {
  const known = 'https://i.ebayimg.com/images/g/known/s-l1600.jpg';
  const unknown = 'https://i.ebayimg.com/images/g/unknown/s-l1600.jpg';

  const recipes = new Map([
    [
      known,
      {
        hostedUrl: known,
        sourceUrl: 'https://m.media-amazon.com/images/I/abc.jpg',
        badgeKey: 'case-only',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        hostedAt: new Date(),
      },
    ],
  ]);

  const result = await refreshExpiredImages([known, unknown], {
    sellerId: SELLER_ID,
    token: 'token',
    recipes,
  });

  // The prefetch covers every URL in the batch, so absent means no row exists —
  // there is no recipe to rebuild from, and the list is exported untouched.
  assert.equal(result.refreshed, false);
  assert.deepEqual(result.images, [known, unknown]);
  assert.match(result.warning, /cannot be rebuilt automatically/);
});

test('images with no EPS pictures skip the lookup entirely', async () => {
  const amazonOnly = [
    'https://m.media-amazon.com/images/I/one.jpg',
    'https://m.media-amazon.com/images/I/two.jpg',
  ];

  // No recipes passed and no database available: reaching a query would fail.
  const result = await refreshExpiredImages(amazonOnly, {
    sellerId: SELLER_ID,
    token: 'token',
  });

  assert.equal(result.refreshed, false);
  assert.deepEqual(result.images, amazonOnly);
});

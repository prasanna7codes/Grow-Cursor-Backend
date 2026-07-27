import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  ANCHORS,
  DEFAULT_PLACEMENT,
  MIN_SOURCE_EDGE,
  WORK_EDGE,
  compositeBadge,
  computeBadgeBox,
  normalizePlacement,
} from '../src/utils/overlayCompositor.js';

// A solid-white product photo and an opaque red badge. Red is chosen because it
// never occurs in the base image, so "did the badge land here?" is a colour test.
function productImage(width, height) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).jpeg().toBuffer();
}

function badgeImage(size = 600) {
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
}

async function pixelAt(buffer, x, y) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

const isRed = ({ r, g, b }) => r > 180 && g < 80 && b < 80;
const isWhite = ({ r, g, b }) => r > 230 && g > 230 && b > 230;

// ── Placement maths ──────────────────────────────────────────────────────────

test('default placement is 26% bottom-right, the size verified against the artwork', () => {
  assert.equal(DEFAULT_PLACEMENT.scale, 0.26);
  assert.equal(DEFAULT_PLACEMENT.anchor, 'bottom-right');

  const box = computeBadgeBox(1600, 1600, DEFAULT_PLACEMENT);
  assert.equal(box.badgeEdge, 416);
  assert.equal(box.marginPx, 24);
  assert.equal(box.left, 1600 - 416 - 24);
  assert.equal(box.top, 1600 - 416 - 24);
});

test('badge is sized from the longest edge so tall and wide photos match', () => {
  const tall = computeBadgeBox(800, 1600, { scale: 0.26, anchor: 'bottom-right', margin: 0.015 });
  const wide = computeBadgeBox(1600, 800, { scale: 0.26, anchor: 'bottom-right', margin: 0.015 });

  assert.equal(tall.badgeEdge, wide.badgeEdge);
});

test('every anchor puts the badge in its own corner', () => {
  const placements = ANCHORS.map(anchor => ({
    anchor,
    box: computeBadgeBox(1600, 1600, { scale: 0.26, anchor, margin: 0.015 }),
  }));

  const byAnchor = Object.fromEntries(placements.map(p => [p.anchor, p.box]));

  assert.equal(byAnchor['top-left'].top, byAnchor['top-right'].top);
  assert.equal(byAnchor['top-left'].left, byAnchor['bottom-left'].left);
  assert.ok(byAnchor['bottom-right'].top > byAnchor['top-right'].top);
  assert.ok(byAnchor['bottom-right'].left > byAnchor['bottom-left'].left);
});

test('a badge that cannot fit is clamped instead of overflowing the image', () => {
  // Very narrow photo: 26% of the 1600px long edge is wider than the 300px axis.
  const box = computeBadgeBox(300, 1600, { scale: 0.26, anchor: 'bottom-right', margin: 0.015 });

  assert.ok(box.badgeEdge <= 300);
  assert.ok(box.left >= 0);
  assert.ok(box.top >= 0);
  assert.ok(box.left + box.badgeEdge <= 300);
});

test('placement values are clamped and bad anchors fall back to the default', () => {
  assert.deepEqual(normalizePlacement({ scale: 99, anchor: 'nowhere', margin: -5 }), {
    scale: 1,
    anchor: 'bottom-right',
    margin: 0,
  });

  assert.deepEqual(normalizePlacement({}), DEFAULT_PLACEMENT);
  // A NaN from a malformed query param must not become a NaN-sized badge.
  assert.equal(normalizePlacement({ scale: Number.NaN }).scale, DEFAULT_PLACEMENT.scale);
});

// ── Compositing ──────────────────────────────────────────────────────────────

test('badge is composited into the requested corner and nowhere else', async () => {
  const result = await compositeBadge(await productImage(2000, 2000), await badgeImage(), DEFAULT_PLACEMENT);

  assert.equal(result.skipped, false);
  // Downscaled to eBay's recommended working size.
  assert.equal(result.width, WORK_EDGE);
  assert.equal(result.height, WORK_EDGE);

  const { top, left, badgeEdge } = result.box;
  const inside = await pixelAt(result.buffer, left + Math.floor(badgeEdge / 2), top + Math.floor(badgeEdge / 2));
  assert.ok(isRed(inside), `expected badge pixel, got ${JSON.stringify(inside)}`);

  // Opposite corner must be untouched product.
  const opposite = await pixelAt(result.buffer, 40, 40);
  assert.ok(isWhite(opposite), `expected clean product pixel, got ${JSON.stringify(opposite)}`);
});

test('a top-left anchor moves the badge, proving anchor is honoured end to end', async () => {
  const result = await compositeBadge(await productImage(1600, 1600), await badgeImage(), {
    scale: 0.26,
    anchor: 'top-left',
    margin: 0.015,
  });

  const topLeft = await pixelAt(result.buffer, 120, 120);
  assert.ok(isRed(topLeft));

  const bottomRight = await pixelAt(result.buffer, 1500, 1500);
  assert.ok(isWhite(bottomRight));
});

test('images below eBay minimum are skipped rather than upscaled', async () => {
  const result = await compositeBadge(await productImage(320, 320), await badgeImage(), DEFAULT_PLACEMENT);

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'source_too_small');
  assert.equal(result.buffer, undefined);
  assert.ok(MIN_SOURCE_EDGE > 320);
});

test('small-but-acceptable images are not enlarged past their own size', async () => {
  const result = await compositeBadge(await productImage(600, 600), await badgeImage(), DEFAULT_PLACEMENT);

  assert.equal(result.skipped, false);
  assert.equal(result.width, 600);
  assert.equal(result.height, 600);
});

test('the real case-only artwork composites without covering the product', async () => {
  const result = await compositeBadge(
    await productImage(1600, 1600),
    'public/uploads/overlay-badges/case-only-overlay.png',
    DEFAULT_PLACEMENT
  );

  assert.equal(result.skipped, false);

  // Count non-white pixels: the badge must mark the image, but the 26% setting
  // should leave the great majority of the frame as product.
  const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
  let marked = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) marked++;
  }
  const coverage = marked / (info.width * info.height);

  assert.ok(coverage > 0.005, `badge did not render (coverage ${coverage})`);
  assert.ok(coverage < 0.06, `badge covers too much of the frame (coverage ${coverage})`);
});

// A square badge can't tell 'contain' from 'cover' — they render identically
// into a square box. A wide badge can: 'contain' letterboxes it and keeps the
// aspect ratio, 'cover' fills the box and crops. Cropping the artwork is the
// defect that made the earlier prototype unusable, so it needs its own test.
test('a non-square badge keeps its aspect ratio instead of being cropped', async () => {
  const wideBadge = await sharp({
    create: { width: 800, height: 400, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();

  const result = await compositeBadge(await productImage(1600, 1600), wideBadge, DEFAULT_PLACEMENT);
  const { top, left, badgeEdge } = result.box;

  const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
  const redAt = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return isRed({ r: data[i], g: data[i + 1], b: data[i + 2] });
  };

  // Count red rows down the middle of the badge's box.
  const midX = left + Math.floor(badgeEdge / 2);
  let redRows = 0;
  for (let y = top; y < top + badgeEdge; y++) {
    if (redAt(midX, y)) redRows++;
  }

  // 2:1 artwork in a square box: roughly half the box height, not all of it.
  const ratio = redRows / badgeEdge;
  assert.ok(ratio > 0.4 && ratio < 0.6, `expected letterboxed badge, got ${ratio.toFixed(2)} of the box filled`);

  // The letterboxed strips must stay product, not badge.
  assert.equal(redAt(midX, top + 2), false, 'badge was stretched or cropped to fill the box');
  assert.equal(redAt(midX, top + badgeEdge - 3), false, 'badge was stretched or cropped to fill the box');
});

test('output is JPEG with no alpha channel, which is what eBay accepts', async () => {
  const result = await compositeBadge(await productImage(1600, 1600), await badgeImage(), DEFAULT_PLACEMENT);
  const meta = await sharp(result.buffer).metadata();

  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.hasAlpha, false);
});

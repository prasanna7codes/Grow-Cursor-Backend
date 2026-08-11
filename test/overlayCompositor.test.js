import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {
  ANCHORS,
  BADGE_CACHE_LIMIT,
  DEFAULT_PLACEMENT,
  MIN_SOURCE_EDGE,
  WORK_EDGE,
  clearBadgeCache,
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

// ── Badge memoization ────────────────────────────────────────────────────────
//
// The artwork is decoded once per (file, mtime, size) instead of once per image.
// The property that matters is that this is invisible: the composite has to be
// byte-identical to what an uncached decode produced.

/** A badge file of a given solid colour, in a directory cleaned up afterwards. */
async function badgeFile(t, colour) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'badge-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'badge.png');
  await write(file, colour, STAMP);
  return file;
}

/**
 * Write the badge and stamp it with an explicit mtime.
 *
 * The timestamp is pinned rather than left to the clock because these tests
 * drive the cache key by hand. A natural mtime is no good for that: stat reports
 * it with a sub-millisecond fraction (…537.7754) that utimes, which takes
 * millisecond Dates, cannot write back — so "restore the mtime I just read"
 * silently changes the key. A value set explicitly round-trips exactly.
 */
async function write(file, colour, mtime) {
  await fs.writeFile(
    file,
    await sharp({ create: { width: 600, height: 600, channels: 4, background: { ...colour, alpha: 1 } } })
      .png()
      .toBuffer()
  );
  await fs.utimes(file, mtime, mtime);
}

const STAMP = new Date(1700000000000);
const LATER_STAMP = new Date(1800000000000);

const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };
const isBlue = ({ r, g, b }) => b > 180 && r < 80 && g < 80;

/** The pixel at the centre of wherever the badge landed. */
async function badgePixel(result) {
  const { top, left, badgeEdge } = result.box;
  return pixelAt(result.buffer, left + Math.floor(badgeEdge / 2), top + Math.floor(badgeEdge / 2));
}

/**
 * How many pixels wide the badge actually rendered, along the row through its
 * middle. Sampling a single centre pixel cannot tell a correctly-sized badge
 * from an oversized one clipped by the frame — both are red in the middle.
 */
async function badgeWidth(result) {
  const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
  const y = result.box.top + Math.floor(result.box.badgeEdge / 2);

  let width = 0;
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if (isRed({ r: data[i], g: data[i + 1], b: data[i + 2] })) width++;
  }
  return width;
}

test('a memoized badge composites byte-identically to a cold one', async t => {
  const file = await badgeFile(t, RED);

  clearBadgeCache();
  const cold = await compositeBadge(await productImage(1600, 1600), file, DEFAULT_PLACEMENT);
  const warm = await compositeBadge(await productImage(1600, 1600), file, DEFAULT_PLACEMENT);

  assert.deepEqual(warm.box, cold.box);
  assert.ok(cold.buffer.equals(warm.buffer), 'the cached decode changed the output');
});

test('the artwork is decoded once, not once per image', async t => {
  // Proving a cache hit without instrumenting sharp: swap the file's contents
  // for a different colour but keep its mtime, so the key is unchanged. A cache
  // hit still draws the old red badge; a re-read would draw the new blue.
  const file = await badgeFile(t, RED);

  clearBadgeCache();
  const first = await compositeBadge(await productImage(1600, 1600), file, DEFAULT_PLACEMENT);
  assert.ok(isRed(await badgePixel(first)));

  await write(file, BLUE, STAMP);

  const second = await compositeBadge(await productImage(1600, 1600), file, DEFAULT_PLACEMENT);
  assert.ok(isRed(await badgePixel(second)), 'the badge was re-decoded instead of being reused');
});

test('replacing the artwork on disk takes effect without a restart', async t => {
  const file = await badgeFile(t, RED);

  clearBadgeCache();
  const before = await compositeBadge(await productImage(1600, 1600), file, DEFAULT_PLACEMENT);
  assert.ok(isRed(await badgePixel(before)));

  // A real deployment writes a new file, which moves mtime and so the cache key.
  await write(file, BLUE, LATER_STAMP);

  const after = await compositeBadge(await productImage(1600, 1600), file, DEFAULT_PLACEMENT);
  assert.ok(isBlue(await badgePixel(after)), 'stale artwork survived a file replacement');
});

test('one badge at two sizes does not collide in the cache', async t => {
  // badgeEdge is part of the key. Were it not, the second call would composite
  // the first call's buffer at the wrong size.
  const file = await badgeFile(t, RED);

  clearBadgeCache();
  const big = await compositeBadge(await productImage(1600, 1600), file, DEFAULT_PLACEMENT);
  const small = await compositeBadge(await productImage(600, 600), file, DEFAULT_PLACEMENT);

  assert.notEqual(small.box.badgeEdge, big.box.badgeEdge);

  // Measured, not sampled: reusing the 1600px render on the 600px image would
  // still be red in the middle — it would simply overflow its box and be
  // clipped by the frame. Only the rendered width shows that.
  for (const result of [big, small]) {
    const width = await badgeWidth(result);
    assert.ok(
      Math.abs(width - result.box.badgeEdge) <= 2,
      `badge rendered ${width}px wide into a ${result.box.badgeEdge}px box`
    );
  }
});

test('concurrent composites of one badge agree', async t => {
  // A bulk run hits this in parallel; the shared in-flight promise must hand
  // every caller the same artwork, and no caller a half-written one.
  const file = await badgeFile(t, RED);

  clearBadgeCache();
  const results = await Promise.all(
    Array.from({ length: 8 }, async () =>
      compositeBadge(await productImage(1600, 1600), file, DEFAULT_PLACEMENT)
    )
  );

  for (const result of results) {
    assert.equal(result.skipped, false);
    assert.ok(result.buffer.equals(results[0].buffer));
  }
});

test('eviction drops the least recently used entry, not the oldest', async t => {
  // Distinct base sizes give distinct badgeEdges, and so distinct cache keys.
  // 4px apart is enough to separate them once scaled by 0.26, and all are above
  // MIN_SOURCE_EDGE so none is skipped.
  const sizes = Array.from({ length: BADGE_CACHE_LIMIT + 1 }, (_, i) => 500 + i * 4);
  const edges = sizes.map(size => computeBadgeBox(size, size, DEFAULT_PLACEMENT).badgeEdge);
  assert.equal(new Set(edges).size, sizes.length, 'test needs one distinct cache key per size');

  const file = await badgeFile(t, RED);
  const composite = async size => compositeBadge(await productImage(size, size), file, DEFAULT_PLACEMENT);

  clearBadgeCache();
  for (const size of sizes.slice(0, BADGE_CACHE_LIMIT)) await composite(size);

  // Touch the oldest entry. Under LRU this makes it the newest; under FIFO it
  // stays first in line and the next insert evicts it.
  await composite(sizes[0]);

  // Same mtime, so the keys are untouched — but anything decoded from here on
  // comes back blue, which is how a survivor is told from an evicted entry.
  await write(file, BLUE, STAMP);

  // Overflow by one. Exactly one entry is evicted.
  await composite(sizes[BADGE_CACHE_LIMIT]);

  assert.ok(
    isRed(await badgePixel(await composite(sizes[0]))),
    'the most recently used entry was evicted, so eviction is FIFO not LRU'
  );
  assert.ok(
    isBlue(await badgePixel(await composite(sizes[1]))),
    'expected the genuinely least recently used entry to have been evicted'
  );
});

test('an unreadable badge path still reports the failure', async () => {
  clearBadgeCache();
  await assert.rejects(
    compositeBadge(await productImage(1600, 1600), 'public/uploads/overlay-badges/no-such-badge.png', DEFAULT_PLACEMENT)
  );
});

test('a Buffer badge is not cached against another of the same size', async () => {
  // Buffers carry no identity to key on, so they bypass the cache entirely.
  // If they were ever keyed by size alone, the blue badge would come back red.
  const red = await sharp({ create: { width: 600, height: 600, channels: 4, background: { ...RED, alpha: 1 } } }).png().toBuffer();
  const blue = await sharp({ create: { width: 600, height: 600, channels: 4, background: { ...BLUE, alpha: 1 } } }).png().toBuffer();

  clearBadgeCache();
  assert.ok(isRed(await badgePixel(await compositeBadge(await productImage(1600, 1600), red, DEFAULT_PLACEMENT))));
  assert.ok(isBlue(await badgePixel(await compositeBadge(await productImage(1600, 1600), blue, DEFAULT_PLACEMENT))));
});

import sharp from 'sharp';

/**
 * Pure image compositing for listing overlay badges.
 *
 * No network, no database, no configuration lookups — buffers in, buffer out —
 * so the placement maths can be unit tested without touching eBay or Mongo.
 */

// eBay recommends 1600px on the longest edge; below 500px it rejects the picture.
export const WORK_EDGE = 1600;
export const MIN_SOURCE_EDGE = 500;

export const ANCHORS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

// Verified against the case-only artwork at 1600px: 26% keeps "CASE ONLY"
// legible at eBay's ~225px search thumbnail while covering under 7% of the frame.
export const DEFAULT_PLACEMENT = {
  scale: 0.26,
  anchor: 'bottom-right',
  margin: 0.015,
};

/**
 * Clamp caller-supplied placement into a range that can't produce a badge
 * larger than the image or negative offsets.
 */
export function normalizePlacement(placement = {}) {
  const scale = Number.isFinite(placement.scale)
    ? Math.min(Math.max(placement.scale, 0.05), 1)
    : DEFAULT_PLACEMENT.scale;

  const margin = Number.isFinite(placement.margin)
    ? Math.min(Math.max(placement.margin, 0), 0.2)
    : DEFAULT_PLACEMENT.margin;

  const anchor = ANCHORS.includes(placement.anchor)
    ? placement.anchor
    : DEFAULT_PLACEMENT.anchor;

  return { scale, anchor, margin };
}

/**
 * Work out where the badge sits on the base image.
 *
 * Kept separate from the sharp pipeline so the geometry is directly assertable.
 * The badge is sized from the *longest* edge so a tall product photo and a wide
 * one get a visually comparable badge.
 *
 * @returns {{badgeEdge: number, top: number, left: number, marginPx: number}}
 */
export function computeBadgeBox(baseWidth, baseHeight, placement) {
  const { scale, anchor, margin } = normalizePlacement(placement);

  const longestEdge = Math.max(baseWidth, baseHeight);
  const marginPx = Math.round(longestEdge * margin);

  // Never let the badge plus its margins exceed either axis — a very narrow
  // product photo would otherwise get a badge wider than the image.
  const maxEdge = Math.max(1, Math.min(baseWidth, baseHeight) - marginPx * 2);
  const badgeEdge = Math.max(1, Math.min(Math.round(longestEdge * scale), maxEdge));

  const top = anchor.startsWith('top')
    ? marginPx
    : Math.max(0, baseHeight - badgeEdge - marginPx);

  const left = anchor.endsWith('left')
    ? marginPx
    : Math.max(0, baseWidth - badgeEdge - marginPx);

  return { badgeEdge, top, left, marginPx };
}

/**
 * Composite a badge onto a product image.
 *
 * @param {Buffer} productBuffer - Source product image
 * @param {string|Buffer} badge - Path to (or buffer of) the badge artwork
 * @param {object} [placement] - { scale, anchor, margin }
 * @returns {Promise<{skipped: boolean, reason?: string, buffer?: Buffer, width?: number, height?: number, box?: object}>}
 */
export async function compositeBadge(productBuffer, badge, placement = DEFAULT_PLACEMENT) {
  // .rotate() with no argument applies the EXIF orientation, matching the eBay
  // picture uploader in routes/ebay.js.
  const source = sharp(productBuffer).rotate();
  const metadata = await source.metadata();

  if (!metadata.width || !metadata.height) {
    return { skipped: true, reason: 'unreadable_source' };
  }

  // Badging a picture eBay would reject anyway just wastes an upload.
  if (Math.max(metadata.width, metadata.height) < MIN_SOURCE_EDGE) {
    return { skipped: true, reason: 'source_too_small' };
  }

  const baseBuffer = await source
    .resize(WORK_EDGE, WORK_EDGE, { fit: 'inside', withoutEnlargement: true })
    .toBuffer();

  const baseMeta = await sharp(baseBuffer).metadata();
  const box = computeBadgeBox(baseMeta.width, baseMeta.height, placement);

  const badgeBuffer = await sharp(badge)
    .resize(box.badgeEdge, box.badgeEdge, {
      // 'contain' keeps the artwork's aspect ratio. 'cover' would crop the badge
      // on any non-square target, which is what the earlier prototype did.
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  let pipeline = sharp(baseBuffer);

  // Amazon serves JPEGs, so this is normally a no-op. It matters only if a
  // source ever arrives as a PNG with alpha: JPEG has no alpha channel, and
  // without flattening the transparent areas take whatever RGB sits under them.
  if (baseMeta.hasAlpha) {
    pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
  }

  const buffer = await pipeline
    .composite([{ input: badgeBuffer, top: box.top, left: box.left }])
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return {
    skipped: false,
    buffer,
    width: baseMeta.width,
    height: baseMeta.height,
    box,
  };
}

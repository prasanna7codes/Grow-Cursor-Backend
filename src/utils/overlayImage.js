import axios from 'axios';
import crypto from 'crypto';
import FormData from 'form-data';
import { parseStringPromise } from 'xml2js';
import OverlayImage from '../models/OverlayImage.js';
import { resolveBadge } from '../config/overlayBadges.js';
import { compositeBadge, normalizeForUpload, normalizePlacement } from './overlayCompositor.js';

/**
 * Applies an overlay badge to a listing's primary image and hosts every image
 * on eBay Picture Services.
 *
 * Sits between fetchAmazonData() and applyFieldConfigs() so the swapped URLs
 * reach all three consumers of amazonData.images: the CSV "Item photo URL"
 * column, {image_main} in the description HTML, and the review modal preview.
 *
 * WHY EVERY IMAGE AND NOT JUST THE BADGED ONE
 * eBay rejects a listing whose pictures are split across EPS and external URLs:
 *
 *   20004 - A mixture of Self Hosted and EPS pictures are not allowed.|PICTURE_URL|
 *
 * Badging image 1 necessarily moves it to EPS, so images 2-N have to follow or
 * the whole row fails at upload. That makes uniformity a correctness property,
 * not an optimisation: this module must return an image list that is entirely
 * EPS-hosted or entirely untouched, and never a blend of the two.
 */

// A pseudo-badge for the secondary images: same upload and cache machinery, no
// artwork composited. The key namespaces their cache rows away from badged
// composites of the same source URL, which would otherwise collide.
const PLAIN_BADGE = { key: '__plain__', version: 0 };
const PLAIN_PLACEMENT = { scale: 0, anchor: 'none', margin: 0 };

// What a batch sends to say "no overlay on this one", as opposed to saying
// nothing and inheriting the template default. Any string works as long as the
// badge registry can never contain it; 'none' reads clearly in a URL and in a
// log line. Asserted against the registry in the tests.
export const NO_OVERLAY = 'none';

// Anything already on eBay's CDN has been through here before. Guards against
// double-badging on re-preview and duplicate-update flows.
const HOSTED_PATTERN = /(^|\.)ebayimg\.com/i;

/**
 * @param {string} url
 * @returns {boolean} true if the URL is already a composited, hosted image
 */
export function isAlreadyOverlaid(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    return HOSTED_PATTERN.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Stable cache key. Every input that changes the rendered pixels — or the
 * account the picture is hosted under — has to be in here, or a config change
 * would silently keep serving the previous composite.
 */
export function buildCacheKey({ sourceUrl, badgeKey, badgeVersion, scale, anchor, margin, sellerId }) {
  return crypto
    .createHash('sha1')
    .update([sourceUrl, badgeKey, badgeVersion, scale, anchor, margin, String(sellerId)].join('|'))
    .digest('hex');
}

/**
 * True when an image list is safe to send to eBay — every picture on EPS, or
 * none of them.
 *
 * This is the invariant the 20004 error enforces. Exported so it can be
 * asserted in tests and re-checked before anything is handed to a caller.
 *
 * @param {string[]} images
 * @returns {boolean}
 */
export function hostsAreUniform(images) {
  if (!Array.isArray(images) || images.length === 0) return true;
  const hosted = images.map(isAlreadyOverlaid);
  return hosted.every(Boolean) || hosted.every((h) => !h);
}

/**
 * Return a copy of amazonData carrying a new image list.
 *
 * Extracted so the copy semantics can be tested without a network round trip.
 * This is the function that must never write to its input: asinCache runs with
 * useClones:false, so the object here is the live cache entry.
 *
 * @param {object} amazonData
 * @param {string[]} hostedUrls
 * @returns {object} a new object; the input is left exactly as it was
 */
export function replaceImages(amazonData, hostedUrls) {
  return { ...amazonData, images: [...hostedUrls] };
}

/**
 * Swap every occurrence of the original primary image for the badged one.
 *
 * Used on flows that don't regenerate fields from scratch — a duplicate update
 * hands back the listing's *saved* title/description/itemPhotoUrl for editing,
 * so the only safe way to badge it is an exact substitution that leaves every
 * other edit the user has made intact.
 *
 * A no-op when the original URL isn't present, which is the right answer if the
 * images were changed by hand.
 *
 * @param {string} text - e.g. a pipe-separated itemPhotoUrl, or description HTML
 * @param {Array<{from: string, to: string}>|{from: string, to: string}|null} mappings
 * @returns {string} text with every hosted image swapped in
 */
/**
 * Assemble the success result of an overlay.
 *
 * Extracted from withOverlaidImages so the shape callers rely on — including
 * `mappings`, which the duplicate-update branches need to rewrite already-saved
 * fields — is pinned by a test that doesn't need eBay or Mongo.
 *
 * One mapping per image that actually moved. Secondary images are in here too:
 * a saved itemPhotoUrl lists all six URLs, so swapping only the primary would
 * leave the stored listing in exactly the mixed-host state eBay rejects.
 *
 * @param {object} amazonData
 * @param {string[]} originalImages
 * @param {string[]} hostedImages
 */
export function buildOverlayResult(amazonData, originalImages, hostedImages) {
  const mappings = [];

  originalImages.forEach((from, i) => {
    const to = hostedImages[i];
    if (to && to !== from) mappings.push({ from, to });
  });

  return {
    data: replaceImages(amazonData, hostedImages),
    applied: true,
    mappings,
  };
}

export function applyOverlayMapping(text, mappings) {
  if (!text || typeof text !== 'string' || !mappings) return text;

  const list = Array.isArray(mappings) ? mappings : [mappings];

  return list.reduce(
    (acc, mapping) => (mapping?.from && mapping?.to ? acc.split(mapping.from).join(mapping.to) : acc),
    text
  );
}

// How eBay's Item photo URL column separates pictures. Matches the
// 'pipeSeparated' transform in asinAutofill.js.
export const IMAGE_LIST_SEPARATOR = ' | ';

/**
 * Split a saved Item photo URL field back into individual images.
 *
 * Tolerant of spacing, because the value may have been hand-edited. eBay uses
 * the pipe as its separator, so a URL cannot legitimately contain one.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitImageList(text) {
  if (!text || typeof text !== 'string') return [];
  return text.split('|').map((part) => part.trim()).filter(Boolean);
}

/**
 * Work out the Item photo URL for a duplicate update.
 *
 * Duplicate branches reuse the listing's *saved* image list rather than
 * regenerating it, and rewrite it by exact substitution so manual edits
 * survive. That substitution can half-succeed: it matches on the Amazon URL as
 * it looks *today*, so if some of the saved URLs have drifted — Amazon replaced
 * a photo, or the scraper returned a different set — only the still-matching
 * ones move to EPS and the result is the mixed-host list eBay rejects with
 * 20004.
 *
 * So the gentle path runs first and is then checked. `hostedImages` is uniform
 * by construction (see withOverlaidImages), which makes it a safe fallback
 * whenever the substitution lands somewhere invalid.
 *
 * @param {string} savedItemPhotoUrl - the listing's stored pipe-separated value
 * @param {Array<{from: string, to: string}>|null} mappings - from withOverlaidImages
 * @param {string[]|null} hostedImages - the freshly hosted list
 * @returns {{value: string, replaced: boolean}} `replaced` is true when the
 *   saved list was discarded, which the caller must surface to the user.
 */
export function resolveSavedImageList(savedItemPhotoUrl, mappings, hostedImages) {
  const swapped = applyOverlayMapping(savedItemPhotoUrl || '', mappings);

  // No overlay ran, so nothing was rewritten and there is nothing to validate.
  // A saved list that was already mixed is left alone rather than "fixed" here:
  // this function only owns damage the overlay itself could have done.
  if (!mappings?.length || !Array.isArray(hostedImages) || !hostedImages.length) {
    return { value: swapped, replaced: false };
  }

  if (hostsAreUniform(splitImageList(swapped))) {
    return { value: swapped, replaced: false };
  }

  return { value: hostedImages.join(IMAGE_LIST_SEPARATOR), replaced: true };
}

async function downloadImage(imageUrl) {
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: 25 * 1024 * 1024,
  });
  return Buffer.from(response.data);
}

/**
 * Upload a composited buffer to eBay Picture Services.
 *
 * Deliberately duplicates the multipart shape of uploadImageToEbay() in
 * routes/ebay.js rather than importing it: that function takes a file path and
 * serves the buyer-messaging flow, and this feature shouldn't be able to
 * regress it. Kept in sync by hand if eBay's contract changes.
 *
 * @returns {Promise<string>} the hosted i.ebayimg.com URL
 */
export async function uploadBufferToEbayPictureService(token, buffer, fileName) {
  const form = new FormData();

  const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <PictureName>${fileName}</PictureName>
  <PictureSet>Standard</PictureSet>
</UploadSiteHostedPicturesRequest>`;

  form.append('XML Payload', xmlPayload, { contentType: 'text/xml; charset=utf-8' });
  form.append(fileName, buffer, { filename: fileName, contentType: 'image/jpeg' });

  const response = await axios.post('https://api.ebay.com/ws/api.dll', form, {
    headers: {
      ...form.getHeaders(),
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
      'X-EBAY-API-CALL-NAME': 'UploadSiteHostedPictures',
    },
    timeout: 30000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const result = await parseStringPromise(response.data);
  const ack = result.UploadSiteHostedPicturesResponse.Ack[0];

  if (ack !== 'Success' && ack !== 'Warning') {
    const errors = result.UploadSiteHostedPicturesResponse.Errors;
    throw new Error(`eBay picture upload failed: ${errors?.[0]?.LongMessage?.[0] || ack}`);
  }

  return result.UploadSiteHostedPicturesResponse.SiteHostedPictureDetails[0].FullURL[0];
}

/**
 * Decide which badge a batch should use.
 *
 * Three inputs, three different meanings, and they must not collapse into each
 * other:
 *
 *   'case-only'  an explicit choice, which always wins
 *   NO_OVERLAY   an explicit refusal, which beats the template default
 *   '' / null    no opinion, so the template default fills the gap
 *
 * The default is what lets entry points with no picker of their own — the ASIN
 * List page's directory stream — badge their listings at all, so "no opinion"
 * has to mean "use the default". That is exactly why the refusal needs its own
 * value: without one, a lister choosing "None" in the picker is indistinguish-
 * able from a lister who never opened it, and the default badges the batch
 * anyway.
 *
 * Returns the key only; it is still checked against the template's allowlist by
 * resolveTemplateOverlay(). A default is stored as a flag on an existing
 * overlayOption, so it is always in that allowlist by construction.
 *
 * @param {object} template - effective template (may carry overlayOptions)
 * @param {string} badgeKey - explicitly requested badge, NO_OVERLAY, or nothing
 * @returns {{badgeKey: string, usingDefault: boolean, optedOut: boolean}}
 */
export function resolveEffectiveBadgeKey(template, badgeKey) {
  if (badgeKey === NO_OVERLAY) return { badgeKey: '', usingDefault: false, optedOut: true };
  if (badgeKey) return { badgeKey, usingDefault: false, optedOut: false };

  const options = Array.isArray(template?.overlayOptions) ? template.overlayOptions : [];
  // First wins if somehow several are flagged. The save-time validation rejects
  // that, but a document written before the rule existed must still behave
  // predictably rather than picking by chance.
  const defaultOption = options.find((option) => option?.isDefault && option?.badgeKey);

  return {
    badgeKey: defaultOption?.badgeKey || '',
    usingDefault: Boolean(defaultOption?.badgeKey),
    optedOut: false,
  };
}

/**
 * Resolve a caller-supplied badge key against a template's configured options.
 *
 * The key arrives as a query parameter, so it is only honoured when the
 * template actually offers it — otherwise any client could pick any badge.
 *
 * @param {object} template - effective template (may carry overlayOptions)
 * @param {string} badgeKey - requested badge key ('' / null means no overlay)
 * @returns {{badge: object, placement: object}|null}
 */
export function resolveTemplateOverlay(template, badgeKey) {
  if (!badgeKey) return null;

  const options = Array.isArray(template?.overlayOptions) ? template.overlayOptions : [];
  const option = options.find(o => o.badgeKey === badgeKey);
  if (!option) {
    console.warn(`[Overlay] Badge "${badgeKey}" is not enabled on template ${template?._id}`);
    return null;
  }

  const badge = resolveBadge(badgeKey);
  if (!badge) {
    console.warn(`[Overlay] Badge "${badgeKey}" is configured on template ${template?._id} but not registered`);
    return null;
  }

  return {
    badge,
    placement: normalizePlacement({
      scale: option.scale,
      anchor: option.anchor,
      margin: option.margin,
    }),
  };
}

/**
 * Composite (optionally) + host one image, reusing a previous result when possible.
 *
 * A badge without a `filePath` — i.e. PLAIN_BADGE — means "upload this image
 * unchanged", which is what images 2-N need.
 *
 * @returns {Promise<string|null>} hosted URL, or null if this image could not be
 *   hosted (source too small or unreadable)
 */
async function getOrCreateHostedImage({ sourceUrl, badge, placement, sellerId, token }) {
  const cacheKey = buildCacheKey({
    sourceUrl,
    badgeKey: badge.key,
    badgeVersion: badge.version,
    scale: placement.scale,
    anchor: placement.anchor,
    margin: placement.margin,
    sellerId,
  });

  const cached = await OverlayImage.findOne({ cacheKey }).lean();
  if (cached) return cached.hostedUrl;

  const productBuffer = await downloadImage(sourceUrl);
  const result = badge.filePath
    ? await compositeBadge(productBuffer, badge.filePath, placement)
    : await normalizeForUpload(productBuffer);

  if (result.skipped) {
    console.warn(`[Overlay] Skipped ${sourceUrl}: ${result.reason}`);
    return null;
  }

  const fileName = `overlay-${badge.key}-${cacheKey.slice(0, 12)}.jpg`;
  const hostedUrl = await uploadBufferToEbayPictureService(token, result.buffer, fileName);

  // Concurrent previews of the same ASIN can race here; the unique index makes
  // the loser a no-op rather than an error.
  await OverlayImage.updateOne(
    { cacheKey },
    {
      $setOnInsert: {
        cacheKey,
        sourceUrl,
        hostedUrl,
        badgeKey: badge.key,
        badgeVersion: badge.version,
        scale: placement.scale,
        anchor: placement.anchor,
        margin: placement.margin,
        sellerId,
        host: 'eps',
      },
    },
    { upsert: true }
  );

  return hostedUrl;
}

/**
 * Host every image in the list on EPS, badging the first one.
 *
 * Sequential on purpose. The bulk preview already runs BULK_PREVIEW_CONCURRENCY
 * (default 15) ASINs at once; uploading a listing's six images in parallel too
 * would put ~90 concurrent uploads on eBay's picture endpoint. Going one at a
 * time keeps the in-flight count roughly where it was before this change.
 *
 * @returns {Promise<string[]|null>} the hosted list, or null if any image could
 *   not be hosted — in which case the caller must discard the partial results.
 */
async function hostAllImages(images, overlay, ctx) {
  const hosted = [];

  for (const [index, sourceUrl] of images.entries()) {
    // Re-preview of an already-processed listing: leave it where it is.
    if (isAlreadyOverlaid(sourceUrl)) {
      hosted.push(sourceUrl);
      continue;
    }

    const isPrimary = index === 0;
    const hostedUrl = await getOrCreateHostedImage({
      sourceUrl,
      badge: isPrimary ? overlay.badge : PLAIN_BADGE,
      placement: isPrimary ? overlay.placement : PLAIN_PLACEMENT,
      sellerId: ctx.sellerId,
      token: ctx.token,
    });

    // One failure poisons the whole listing: a list where this image stayed on
    // Amazon and the others moved to EPS is precisely what eBay rejects. Bail
    // out and let the caller fall back to the untouched originals.
    if (!hostedUrl) return null;

    hosted.push(hostedUrl);
  }

  return hosted;
}

/**
 * Return a copy of amazonData whose primary image carries the overlay badge and
 * whose every image is hosted on eBay Picture Services.
 *
 * IMPORTANT: never mutates the input. asinCache is configured with
 * useClones:false, so fetchAmazonData() hands back the live cached object —
 * writing to it would push the badge into the shared cache and leak it into
 * every other template, plus the compatibility, directory and stock-check
 * callers.
 *
 * Failure is non-fatal and all-or-nothing: a listing with unbadged Amazon
 * images uploads fine, a listing with a mix of hosts does not. So any problem
 * anywhere in the list discards the whole attempt rather than emitting a
 * partially-hosted array.
 *
 * @param {object} amazonData - result of fetchAmazonData()
 * @param {{badge: object, placement: object}|null} overlay - from resolveTemplateOverlay()
 * @param {{sellerId: string, token: string}} ctx
 * @returns {Promise<{data: object, applied: boolean, mappings?: Array, warning?: string}>}
 */
export async function withOverlaidImages(amazonData, overlay, ctx = {}) {
  const images = Array.isArray(amazonData?.images) ? amazonData.images : [];

  if (!overlay || !images.length || !ctx.token || !ctx.sellerId) {
    return { data: amazonData, applied: false };
  }

  // Everything is already on EPS — a re-preview of a listing this ran on before.
  if (images.every(isAlreadyOverlaid)) {
    return { data: amazonData, applied: false };
  }

  try {
    const hosted = await hostAllImages(images, overlay, ctx);

    if (!hosted) {
      return {
        data: amazonData,
        applied: false,
        warning: 'Overlay skipped: not every image could be hosted on eBay, and a listing cannot mix eBay-hosted and external pictures.',
      };
    }

    // Belt and braces. hostAllImages already guarantees this, but the cost of
    // being wrong is a failed CSV upload the seller only discovers hours later,
    // so the invariant is re-checked before the list escapes this module.
    if (!hostsAreUniform(hosted)) {
      console.error(`[Overlay] Refusing mixed-host image list for ${amazonData?.asin}`);
      return { data: amazonData, applied: false, warning: 'Overlay skipped: mixed image hosts.' };
    }

    // Shallow copy, fresh array — the cached object stays untouched. `mappings`
    // lets callers that work on already-saved text (duplicate updates) apply
    // the same swaps without regenerating the whole listing.
    return buildOverlayResult(amazonData, images, hosted);
  } catch (error) {
    console.error(`[Overlay] Failed for ${amazonData?.asin}: ${error.message}`);
    return {
      data: amazonData,
      applied: false,
      warning: `Overlay could not be applied: ${error.message}`,
    };
  }
}

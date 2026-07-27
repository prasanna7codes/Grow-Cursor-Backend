import axios from 'axios';
import crypto from 'crypto';
import FormData from 'form-data';
import { parseStringPromise } from 'xml2js';
import OverlayImage from '../models/OverlayImage.js';
import { resolveBadge } from '../config/overlayBadges.js';
import { compositeBadge, normalizePlacement } from './overlayCompositor.js';

/**
 * Applies an overlay badge to a listing's primary image and hosts the result on
 * eBay Picture Services.
 *
 * Sits between fetchAmazonData() and applyFieldConfigs() so a single swapped URL
 * reaches all three consumers of amazonData.images[0]: the CSV "Item photo URL"
 * column, {image_main} in the description HTML, and the review modal preview.
 */

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
 * Return a copy of amazonData with a new primary image.
 *
 * Extracted so the copy semantics can be tested without a network round trip.
 * This is the function that must never write to its input: asinCache runs with
 * useClones:false, so the object here is the live cache entry.
 *
 * @param {object} amazonData
 * @param {string} hostedUrl
 * @returns {object} a new object; the input is left exactly as it was
 */
export function replacePrimaryImage(amazonData, hostedUrl) {
  const images = Array.isArray(amazonData?.images) ? amazonData.images : [];
  return { ...amazonData, images: [hostedUrl, ...images.slice(1)] };
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
 * @param {{from: string, to: string}|null} mapping
 * @returns {string} text with the primary image swapped
 */
/**
 * Assemble the success result of an overlay.
 *
 * Extracted from withOverlaidPrimary so the shape callers rely on — including
 * `mapping`, which the duplicate-update branches need to badge already-saved
 * fields — is pinned by a test that doesn't need eBay or Mongo.
 *
 * @param {object} amazonData
 * @param {string} originalPrimary
 * @param {string} hostedUrl
 */
export function buildOverlayResult(amazonData, originalPrimary, hostedUrl) {
  return {
    data: replacePrimaryImage(amazonData, hostedUrl),
    applied: true,
    mapping: { from: originalPrimary, to: hostedUrl },
  };
}

export function applyOverlayMapping(text, mapping) {
  if (!text || typeof text !== 'string' || !mapping?.from || !mapping?.to) return text;
  return text.split(mapping.from).join(mapping.to);
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
 * Composite + host one image, reusing a previous result when possible.
 *
 * @returns {Promise<string|null>} hosted URL, or null if the caller should keep
 *   the original image (source too small, or a badge-key mismatch)
 */
async function getOrCreateOverlaidImage({ sourceUrl, badge, placement, sellerId, token }) {
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
  const result = await compositeBadge(productBuffer, badge.filePath, placement);

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
 * Return a copy of amazonData whose primary image carries the overlay badge.
 *
 * IMPORTANT: never mutates the input. asinCache is configured with
 * useClones:false, so fetchAmazonData() hands back the live cached object —
 * writing to it would push the badge into the shared cache and leak it into
 * every other template, plus the compatibility, directory and stock-check
 * callers.
 *
 * Failure is non-fatal by design: a listing with an unbadged image is fine, a
 * blocked preview is not.
 *
 * @param {object} amazonData - result of fetchAmazonData()
 * @param {{badge: object, placement: object}|null} overlay - from resolveTemplateOverlay()
 * @param {{sellerId: string, token: string}} ctx
 * @returns {Promise<{data: object, applied: boolean, warning?: string}>}
 */
export async function withOverlaidPrimary(amazonData, overlay, ctx = {}) {
  const images = Array.isArray(amazonData?.images) ? amazonData.images : [];

  if (!overlay || !images.length || !ctx.token || !ctx.sellerId) {
    return { data: amazonData, applied: false };
  }

  const primary = images[0];
  if (!primary || isAlreadyOverlaid(primary)) {
    return { data: amazonData, applied: false };
  }

  try {
    const hostedUrl = await getOrCreateOverlaidImage({
      sourceUrl: primary,
      badge: overlay.badge,
      placement: overlay.placement,
      sellerId: ctx.sellerId,
      token: ctx.token,
    });

    if (!hostedUrl) return { data: amazonData, applied: false };

    // Shallow copy, fresh array — the cached object stays untouched. `mapping`
    // lets callers that work on already-saved text (duplicate updates) apply
    // the same swap without regenerating the whole listing.
    return buildOverlayResult(amazonData, primary, hostedUrl);
  } catch (error) {
    console.error(`[Overlay] Failed for ${amazonData?.asin}: ${error.message}`);
    return {
      data: amazonData,
      applied: false,
      warning: `Overlay could not be applied: ${error.message}`,
    };
  }
}

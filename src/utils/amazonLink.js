// utils/amazonLink.js
//
// Builds the product URL the extension navigates to:
//
//   https://www.amazon.com/dp/<ASIN>?tag=<associate-tag>
//
// The tag comes from the buyer account's associateTag, falling back to the
// AMAZON_ASSOCIATE_TAG environment variable. With no tag configured the URL is
// emitted untagged rather than with an empty tag= parameter.

const BASE = 'https://www.amazon.com/dp';

/** Amazon associate tags look like "shreejagann0f-20". */
const TAG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,48}[A-Za-z0-9])?-\d{2}$/;

export function isAssociateTag(value) {
  return TAG_RE.test(String(value || '').trim());
}

/**
 * @param {string} asin
 * @param {string} [tag] associate tag; omitted from the URL when blank/invalid
 * @returns {string|null} null when there is no ASIN to link to
 */
export function buildAmazonUrl(asin, tag) {
  const clean = String(asin || '').trim().toUpperCase();
  if (!clean) return null;

  const cleanTag = String(tag || '').trim();
  // A malformed tag would just be ignored by Amazon, but silently emitting one
  // hides a misconfiguration — leave it off so it is visible in the panel.
  return isAssociateTag(cleanTag) ? `${BASE}/${clean}?tag=${cleanTag}` : `${BASE}/${clean}`;
}

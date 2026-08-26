import SellerSkuIndex from '../models/SellerSkuIndex.js';
import { generateSKUFromASIN } from './skuGenerator.js';

/**
 * Is an ASIN already live for a seller?
 *
 * One rule, used everywhere:
 *
 *   1. Generate the SKU from the ASIN  (GRW25 + last 5 chars)
 *   2. Look it up in SellerSkuIndex for THAT seller
 *   3. Found -> active.  Not found -> inactive.
 *
 * SellerSkuIndex is the locally synced index of listings actually live on eBay,
 * so this answers "does this seller already sell this product", which is the
 * only question that matters when deciding whether an ASIN is worth listing.
 *
 * It deliberately does NOT consult TemplateListing. A listing generated in this
 * tool but never uploaded is not live, so the ASIN is still listable — treating
 * it as taken would lock that product away behind unfinished work.
 *
 * This lives in one place because three separate call sites need the identical
 * answer — the precheck's Active column, the "inactive only" rule, and the
 * sourcing exclusion. They drifted apart once already.
 */

/** Strip a repeat-listing suffix: GRW25ABCDE-2 -> GRW25ABCDE. */
export function getBaseSku(sku = '') {
  return String(sku || '').trim().replace(/-\d+$/, '');
}

/**
 * The SKU values to look for, given one ASIN. generateSKUFromASIN never emits a
 * suffix, so these collapse to a single value — kept as a pair so a caller
 * passing an already-suffixed SKU still matches.
 */
export function skuLookupValues(asin) {
  const sku = generateSKUFromASIN(asin);
  return [...new Set([sku, getBaseSku(sku)].filter(Boolean))];
}

/**
 * Which of these ASINs are already live for this seller.
 *
 * Matches on both the raw `sku` and the stripped `baseSku` columns, so a
 * repeat listing stored as GRW25ABCDE-1 still counts as covering GRW25ABCDE.
 *
 * @param {string|ObjectId} sellerId
 * @param {string[]} asins
 * @returns {Promise<Set<string>>} uppercased ASINs that are active
 */
export async function findActiveAsinsForSeller(sellerId, asins) {
  const wanted = [...new Set((asins || []).map(a => String(a).toUpperCase()).filter(Boolean))];
  if (wanted.length === 0 || !sellerId) return new Set();

  // SKU -> ASIN, so an index hit can be attributed back to the ASIN that
  // produced it.
  const asinBySku = new Map();
  for (const asin of wanted) {
    for (const sku of skuLookupValues(asin)) {
      asinBySku.set(sku, asin);
    }
  }

  const skuValues = [...asinBySku.keys()];
  if (skuValues.length === 0) return new Set();

  const records = await SellerSkuIndex.find({
    seller: sellerId,
    $or: [
      { sku: { $in: skuValues } },
      { baseSku: { $in: skuValues } }
    ]
  }).select('sku baseSku').lean();

  const active = new Set();
  for (const record of records) {
    const asin = asinBySku.get(record.baseSku) || asinBySku.get(record.sku);
    if (asin) active.add(asin);
  }

  return active;
}

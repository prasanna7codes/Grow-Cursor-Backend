import QuantityUpdateExclusion from '../models/QuantityUpdateExclusion.js';

/**
 * Read-side helper for the "quantity update excluded items" list.
 *
 * The list used to be a hard-coded Set in routes/ebay.js. It now lives in the
 * QuantityUpdateExclusion collection and is edited from the admin UI, so every
 * incoming order checks its ItemIDs against the database — nothing is cached,
 * which means an ID added in the UI protects the very next order that arrives.
 */

/** Normalise an eBay ItemID to the string form used for comparisons. */
export function normalizeItemId(itemId) {
  return String(itemId ?? '').trim();
}

/**
 * Given the ItemIDs on an order, return the subset that is excluded from the
 * on-order quantity reset. One indexed lookup against the unique `itemId` index,
 * scoped to just those IDs, so the cost does not grow with the size of the list.
 *
 * If the lookup fails, this returns an empty set rather than throwing, so the
 * caller falls through to its normal behaviour and sets the quantity to 1. The
 * quantity reset is the default action; a failed lookup must not leave a sold
 * listing sitting at its old quantity. The trade-off is that an excluded
 * listing could be reset during a database outage — the error is logged loudly
 * so that is visible when it happens.
 *
 * @param {Array<string|number>} itemIds ItemIDs appearing on the order
 * @returns {Promise<Set<string>>} the excluded ones among `itemIds`
 */
export async function getExcludedItemIdsFrom(itemIds) {
  const lookupIds = [...new Set((itemIds || []).map(normalizeItemId).filter(Boolean))];
  if (lookupIds.length === 0) return new Set();

  try {
    const docs = await QuantityUpdateExclusion.find({ itemId: { $in: lookupIds } })
      .select('itemId')
      .lean();
    return new Set(docs.map((doc) => normalizeItemId(doc.itemId)));
  } catch (error) {
    console.error(
      `[Quantity Update] ❌ Exclusion lookup failed for ItemID(s) ${lookupIds.join(', ')} — treating them as NOT excluded and setting quantity to 1:`,
      error.message
    );
    return new Set();
  }
}

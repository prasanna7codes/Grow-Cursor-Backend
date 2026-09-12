import express from 'express';
import mongoose from 'mongoose';

import Seller from '../models/Seller.js';
import SellerSkuIndex from '../models/SellerSkuIndex.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { parseKeywordQuery, matchesKeywords } from '../utils/keywordFilter.js';
import {
  attachListingHistory,
  cleanAsin,
  getBaseLabel,
  isAmazonAsin,
  loadAsinByBaseLabel,
  loadListingHistory,
  normalizeCurrency
} from './amazonStockChecks.js';

const router = express.Router();
const PAGE_ID = 'KeywordEndListing';

// Every returned row is enriched with its full order history, so the result is
// capped rather than unbounded. A keyword broad enough to match more than this
// is a keyword worth narrowing before anything gets ended — the response still
// reports the true match count so the operator can see how far off they are.
const MAX_RESULTS = 1000;

// The category box is free text, so a stray '(' or '*' would otherwise throw
// inside the regex query rather than simply matching nothing.
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GET /keyword-end-listing/index-status
 *
 * Per-seller indexed listing counts and last sync time, read straight from
 * SellerSkuIndex, so the page can say how fresh the rows it searches are.
 * Read-only: the daily SKU Index Sync is what keeps these rows current.
 */
router.get('/index-status', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const rows = await SellerSkuIndex.aggregate([
      { $group: { _id: '$seller', count: { $sum: 1 }, syncedAt: { $max: '$syncedAt' } } },
    ]);

    res.json({
      sellers: rows.map((row) => ({
        sellerId: String(row._id),
        count: row.count,
        syncedAt: row.syncedAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /keyword-end-listing/search?sellerId=&search=&category=
 *
 * One seller's indexed listings whose TITLE matches the keyword query, with
 * the same order counts and ended/revised badges the SKU Listing Manager shows
 * beside each row — the 90-day order count is what decides whether a listing
 * is safe to end.
 *
 * The keyword grammar is the Listing Overlays one (space = AND, comma = OR),
 * but it is matched against the title alone: this page exists to end batches
 * of listings by what they are called, and a token that happens to sit inside
 * a SKU or item id would only add rows nobody asked for. The category narrows
 * the query in the database; the keywords then run in memory over a cursor,
 * keeping one implementation of the search semantics.
 */
router.get('/search', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const sellerId = String(req.query.sellerId || '');
    if (!mongoose.Types.ObjectId.isValid(sellerId)) {
      return res.status(400).json({ error: 'A valid sellerId is required.' });
    }

    const keywordGroups = parseKeywordQuery(req.query.search);
    const categoryFilter = String(req.query.category || '').trim();
    // A blank search would return the seller's whole index (capped), which is
    // not a batch anyone means to end.
    if (!keywordGroups.length && !categoryFilter) {
      return res.status(400).json({ error: 'Enter a keyword or a category to search for.' });
    }

    const seller = await Seller.findById(sellerId).populate('user', 'username name email').lean();
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    const sellerName = seller.user?.username || seller.user?.name || seller.user?.email || String(seller._id);

    const query = { seller: seller._id };
    if (categoryFilter) {
      query.categoryName = { $regex: escapeRegex(categoryFilter), $options: 'i' };
    }

    const cursor = SellerSkuIndex.find(query)
      .select('itemId sku baseSku title categoryName imageUrl price currency syncedAt')
      .lean()
      .cursor();

    let scanned = 0;
    let matched = 0;
    let syncedAt = null;
    const matchedRows = [];

    for await (const doc of cursor) {
      scanned += 1;
      if (!syncedAt || doc.syncedAt > syncedAt) syncedAt = doc.syncedAt;

      if (keywordGroups.length && !matchesKeywords(String(doc.title || '').toLowerCase(), keywordGroups)) {
        continue;
      }

      // Past the cap the scan carries on counting but stops collecting, so the
      // page can report "showing 1,000 of 3,412" rather than a bare "more".
      matched += 1;
      if (matchedRows.length < MAX_RESULTS) matchedRows.push(doc);
    }

    // Alphabetical by title so the variants of one product sit together, which
    // is how a keyword batch is reviewed before ending it.
    matchedRows.sort((a, b) => (
      String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' })
      || String(a.itemId).localeCompare(String(b.itemId))
    ));

    const itemIds = [...new Set(matchedRows.map((row) => row.itemId).filter(Boolean))];
    const labels = [...new Set(matchedRows.map((row) => getBaseLabel(row.baseSku || row.sku)).filter(Boolean))];
    // Order history and the ASIN each SKU points at are independent lookups —
    // run them together.
    const [history, asinByLabel] = await Promise.all([
      loadListingHistory(itemIds),
      loadAsinByBaseLabel(labels)
    ]);
    const asinForRow = (row) => {
      if (isAmazonAsin(row.sku)) return cleanAsin(row.sku);
      return asinByLabel.get(getBaseLabel(row.baseSku || row.sku).toUpperCase()) || '';
    };

    const listings = attachListingHistory(matchedRows.map((row) => ({
      sellerId: seller._id,
      sellerName,
      itemId: row.itemId,
      sku: row.sku || '',
      title: row.title || '',
      price: row.price ?? null,
      currency: normalizeCurrency(row.currency),
      imageUrl: row.imageUrl || '',
      syncedAt: row.syncedAt,
    })), history);
    // attachListingHistory returns a fixed row shape, so carry the category
    // and ASIN across from the index row each one was built from.
    listings.forEach((row, index) => {
      row.categoryName = matchedRows[index].categoryName || '';
      row.asin = asinForRow(matchedRows[index]);
    });

    res.json({
      sellerId: String(seller._id),
      sellerName,
      scanned,
      matched,
      returned: listings.length,
      truncated: matched > listings.length,
      indexEmpty: scanned === 0,
      syncedAt,
      totals: {
        orderCount90d: listings.reduce((sum, row) => sum + (row.orderCount90d || 0), 0),
        lifetimeOrderCount: listings.reduce((sum, row) => sum + (row.lifetimeOrderCount || 0), 0),
      },
      listings,
    });
  } catch (error) {
    console.error('[KeywordEndListing] search error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to search listings' });
  }
});

export default router;

import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePageAccess, requireRole } from '../middleware/auth.js';
import Seller from '../models/Seller.js';
import User from '../models/User.js';
import UserSellerAssignment from '../models/UserSellerAssignment.js';
import SellerSkuIndex from '../models/SellerSkuIndex.js';
import Order from '../models/Order.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

const currencyCountryLabels = {
  USD: 'United States',
  GBP: 'United Kingdom',
  GB: 'United Kingdom',
  AUD: 'Australia',
  CAD: 'Canada',
  EUR: 'Europe',
};

// Maps the short country vocabulary used by the Duplicate SKUs page (and
// EndListingLog) back to the currency codes stored on each SellerSkuIndex row,
// so the page can filter duplicates down to a single country.
const COUNTRY_TO_CURRENCIES = {
  US: ['USD'],
  UK: ['GBP', 'GB'],
  AU: ['AUD'],
  CANADA: ['CAD'],
};

function currenciesForCountry(country) {
  if (!country) return null;
  return COUNTRY_TO_CURRENCIES[String(country).trim().toUpperCase()] || null;
}

function formatCurrencyCountry(currency) {
  if (!currency) return 'Unknown';
  const normalized = String(currency).trim().toUpperCase();
  if (currencyCountryLabels[normalized]) return currencyCountryLabels[normalized];
  return normalized
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * @swagger
 * tags:
 *   name: Sellers
 *   description: Seller profile management and eBay marketplace connections
 */

/**
 * @swagger
 * /sellers/all:
 *   get:
 *     tags: [Sellers]
 *     summary: List all sellers (role-filtered)
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Superadmin sees all sellers. Other authenticated users see only their assigned sellers
 *       (via UserSellerAssignment).
 *     responses:
 *       200: { description: Array of seller objects (with populated user) }
 *       401: { description: Unauthorized }
 */
// List all sellers (for admin dashboard)
// Superadmin sees all; other users see only their assigned sellers
router.get('/all', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'superadmin') {
      // Superadmin sees all sellers
      const sellers = await Seller.find().populate('user', 'username email').lean();
      return res.json(sellers);
    }

    // For non-superadmin: get their seller assignments
    const assignments = await UserSellerAssignment.find({ user: req.user.userId }).select('seller').lean();
    const assignedSellerIds = assignments.map(a => a.seller);

    if (assignedSellerIds.length === 0) {
      // No assignments — return all sellers (backward compat for roles that had full access before)
      // This preserves existing behavior for users who haven't been explicitly assigned sellers
      const sellers = await Seller.find().populate('user', 'username email').lean();
      return res.json(sellers);
    }

    // Filter to only assigned sellers
    const sellers = await Seller.find({ _id: { $in: assignedSellerIds } }).populate('user', 'username email').lean();
    res.json(sellers);
  } catch (err) {
    console.error('Error fetching sellers:', err);
    res.status(500).json({ error: 'Failed to fetch sellers' });
  }
});

// List all sellers without filtering (for Fulfillment Dashboard)
// All authenticated users can see all sellers
/**
 * @swagger
 * /sellers/all-unfiltered:
 *   get:
 *     tags: [Sellers]
 *     summary: List all sellers without role filtering
 *     security:
 *       - bearerAuth: []
 *     description: Returns every seller regardless of UserSellerAssignment. Restricted to superadmin.
 *     responses:
 *       200: { description: Array of all seller objects }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/all-unfiltered', requireAuth, async (req, res) => {
  try {
    const sellers = await Seller.find().populate('user', 'username email').lean();
    res.json(sellers);
  } catch (err) {
    console.error('Error fetching sellers:', err);
    res.status(500).json({ error: 'Failed to fetch sellers' });
  }
});

// Get current seller profile and eBay marketplaces
/**
 * @swagger
 * /sellers/me:
 *   get:
 *     tags: [Sellers]
 *     summary: Get the current seller's own profile
 *     security:
 *       - bearerAuth: []
 *     description: Returns the seller document linked to the authenticated seller user.
 *     responses:
 *       200: { description: Seller profile object }
 *       401: { description: Unauthorized }
 *       403: { description: Requires seller role }
 *       404: { description: Seller not found }
 */
router.get('/me', requireAuth, requireRole('seller'), async (req, res) => {
  try {
    console.log('Fetching seller for user:', req.user);
    const seller = await Seller.findOne({ user: req.user.userId });
    if (!seller) {
      console.log('Seller not found for userId:', req.user.userId);
      return res.status(404).json({ error: 'Seller not found' });
    }
    console.log('Seller found:', seller);
    res.json(seller);
  } catch (error) {
    console.error('Error fetching seller profile:', error);
    res.status(500).json({ error: 'Failed to fetch seller profile' });
  }
});

// Add an eBay marketplace region (e.g., EBAY_US, EBAY_UK)
/**
 * @swagger
 * /sellers/marketplaces:
 *   post:
 *     tags: [Sellers]
 *     summary: Add a marketplace to the seller's profile
 *     security:
 *       - bearerAuth: []
 *     description: Adds a new marketplace entry (region + credentials) to the seller. Requires seller role.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [region]
 *             properties:
 *               region: { type: string, example: EBAY_US }
 *     responses:
 *       200: { description: Updated seller with new marketplace }
 *       400: { description: Marketplace already exists }
 *       401: { description: Unauthorized }
 *       403: { description: Requires seller role }
 *       404: { description: Seller not found }
 */
router.post('/marketplaces', requireAuth, requireRole('seller'), asyncHandler(async (req, res) => {
  const { region } = req.body;
  if (!region) return res.status(400).json({ error: 'Marketplace region required' });
  const seller = await Seller.findOne({ user: req.user.userId });
  if (!seller) return res.status(404).json({ error: 'Seller not found' });
  if (seller.ebayMarketplaces.includes(region)) {
    return res.status(409).json({ error: 'Marketplace region already exists' });
  }
  seller.ebayMarketplaces.push(region);
  await seller.save();
  res.json(seller);
}));

// Remove an eBay marketplace region
/**
 * @swagger
 * /sellers/marketplaces/{region}:
 *   delete:
 *     tags: [Sellers]
 *     summary: Remove a marketplace from the seller's profile
 *     security:
 *       - bearerAuth: []
 *     description: Removes the marketplace entry matching the given region. Requires seller role.
 *     parameters:
 *       - { in: path, name: region, required: true, schema: { type: string, example: EBAY_US } }
 *     responses:
 *       200: { description: Updated seller after marketplace removal }
 *       401: { description: Unauthorized }
 *       403: { description: Requires seller role }
 *       404: { description: Seller or marketplace not found }
 */
router.delete('/marketplaces/:region', requireAuth, requireRole('seller'), asyncHandler(async (req, res) => {
  const { region } = req.params;
  const seller = await Seller.findOne({ user: req.user.userId });
  if (!seller) return res.status(404).json({ error: 'Seller not found' });
  seller.ebayMarketplaces = seller.ebayMarketplaces.filter(r => r !== region);
  await seller.save();
  res.json(seller);
}));

// Disconnect eBay account (clear tokens) - allows re-authorization with new scopes
/**
 * @swagger
 * /sellers/disconnect-ebay:
 *   delete:
 *     tags: [Sellers]
 *     summary: Disconnect eBay from the seller's account
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Clears the eBay OAuth tokens and account link from the seller profile.
 *       Requires seller role.
 *     responses:
 *       200: { description: Confirmation that eBay was disconnected }
 *       401: { description: Unauthorized }
 *       403: { description: Requires seller role }
 *       404: { description: Seller not found }
 */
router.delete('/disconnect-ebay', requireAuth, requireRole('seller'), async (req, res) => {
  try {
    const seller = await Seller.findOne({ user: req.user.userId });
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    
    // Clear the eBay tokens
    seller.ebayTokens = {};
    await seller.save();
    
    console.log(`eBay disconnected for seller ${seller._id}`);
    res.json({ message: 'eBay account disconnected successfully. You can now reconnect with updated permissions.' });
  } catch (error) {
    console.error('Error disconnecting eBay:', error);
    res.status(500).json({ error: 'Failed to disconnect eBay account' });
  }
});

// GET /sellers/sku-duplicates?sellerId=xxx&page=1&limit=25&country=US
// Returns SKUs that appear on more than one itemId for the given seller in the SellerSkuIndex collection.
// When `country` is supplied, only listings from that country's currencies are considered, so a SKU is
// treated as a duplicate only when it repeats within the selected country.
router.get('/sku-duplicates', requireAuth, requirePageAccess('DuplicateSkus'), async (req, res) => {
  const { sellerId, country } = req.query;
  if (!sellerId || !mongoose.Types.ObjectId.isValid(sellerId)) {
    return res.status(400).json({ error: 'Valid sellerId query param is required.' });
  }
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const skip  = (page - 1) * limit;

  const countryCurrencies = currenciesForCountry(country);
  if (country && !countryCurrencies) {
    return res.status(400).json({ error: `Unknown country filter: ${country}` });
  }

  try {
    const [facet] = await SellerSkuIndex.aggregate([
      { $match: { seller: new mongoose.Types.ObjectId(sellerId) } },
      ...(countryCurrencies ? [
        { $addFields: { _normCurrency: { $toUpper: { $ifNull: ['$currency', ''] } } } },
        { $match: { _normCurrency: { $in: countryCurrencies } } },
      ] : []),
      {
        $group: {
          _id: '$sku',
          count: { $sum: 1 },
          itemIds: { $push: '$itemId' },
          titles: { $push: '$title' },
          currencies: { $push: '$currency' },
        },
      },
      { $match: { _id: { $ne: '' }, count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      {
        $facet: {
          total: [{ $count: 'n' }],
          data: [
            { $skip: skip },
            { $limit: limit },
            { $project: { _id: 0, sku: '$_id', count: 1, itemIds: 1, titles: 1, currencies: 1 } },
          ],
        },
      },
    ]);

    const total      = facet?.total?.[0]?.n ?? 0;
    const duplicates = facet?.data ?? [];

    // Count orders only for the current page's item IDs
    const pageItemIds = duplicates.flatMap(d => d.itemIds);
    const orderCounts = pageItemIds.length ? await Order.aggregate([
      { $match: { seller: new mongoose.Types.ObjectId(sellerId), itemNumber: { $in: pageItemIds } } },
      { $group: { _id: '$itemNumber', orderCount: { $sum: 1 } } },
    ]) : [];
    const orderCountMap = Object.fromEntries(orderCounts.map(o => [o._id, o.orderCount]));

    const duplicatesWithOrders = duplicates.map(d => ({
      ...d,
      orderCounts: d.itemIds.map(id => orderCountMap[id] ?? 0),
    }));

    res.json({
      duplicates: duplicatesWithOrders,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      limit,
    });
  } catch (err) {
    console.error('Error fetching SKU duplicates:', err);
    res.status(500).json({ error: 'Failed to fetch SKU duplicates.' });
  }
});

// GET /sellers/sku-duplicates-by-country
// Summarizes the SellerSkuIndex collection by currency-derived country.
// A SKU that appears once contributes 1 unique SKU and 0 extra duplicates.
// A SKU that appears twice contributes 1 unique SKU and 1 extra duplicate.
router.get('/sku-duplicates-by-country', requireAuth, requirePageAccess(['DuplicateSkus', 'SkuIndexDashboard']), async (req, res) => {
  try {
    const sellerSkuRows = await SellerSkuIndex.aggregate([
      { $match: { sku: { $nin: ['', null] } } },
      {
        $addFields: {
          normalizedCurrency: { $toUpper: { $ifNull: ['$currency', 'UNKNOWN'] } },
        },
      },
      {
        $group: {
          _id: { currency: '$normalizedCurrency', seller: '$seller', sku: '$sku' },
          listingCount: { $sum: 1 },
          sampleTitles: { $push: '$title' },
        },
      },
      {
        $lookup: {
          from: 'sellers',
          localField: '_id.seller',
          foreignField: '_id',
          as: 'sellerDoc',
        },
      },
      { $unwind: { path: '$sellerDoc', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'users',
          localField: 'sellerDoc.user',
          foreignField: '_id',
          as: 'userDoc',
        },
      },
      { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          currency: '$_id.currency',
          sellerId: '$_id.seller',
          sellerName: {
            $ifNull: [
              '$userDoc.username',
              { $ifNull: ['$userDoc.email', { $toString: '$_id.seller' }] },
            ],
          },
          sku: '$_id.sku',
          listingCount: 1,
          extraCount: { $max: [{ $subtract: ['$listingCount', 1] }, 0] },
          sampleTitle: { $arrayElemAt: ['$sampleTitles', 0] },
        },
      },
    ]);

    const countryMap = new Map();
    for (const row of sellerSkuRows) {
      const country = formatCurrencyCountry(row.currency);
      if (!countryMap.has(country)) {
        countryMap.set(country, {
          country,
          currencies: new Set(),
          listingCount: 0,
          skus: new Map(),
          sellers: new Map(),
        });
      }

      const summary = countryMap.get(country);
      summary.currencies.add(row.currency || 'UNKNOWN');
      summary.listingCount += row.listingCount;

      const skuSummary = summary.skus.get(row.sku) || {
        sku: row.sku,
        listingCount: 0,
        sellers: new Set(),
        sampleTitle: row.sampleTitle || '',
      };
      skuSummary.listingCount += row.listingCount;
      skuSummary.sellers.add(String(row.sellerId || 'unknown'));
      if (!skuSummary.sampleTitle && row.sampleTitle) skuSummary.sampleTitle = row.sampleTitle;
      summary.skus.set(row.sku, skuSummary);

      const sellerKey = String(row.sellerId || row.sellerName || 'unknown');
      const sellerSummary = summary.sellers.get(sellerKey) || {
        sellerId: sellerKey,
        sellerName: row.sellerName || sellerKey,
        uniqueSkuCount: 0,
        listingCount: 0,
        duplicateSkuCount: 0,
        extraCount: 0,
      };
      sellerSummary.uniqueSkuCount += 1;
      sellerSummary.listingCount += row.listingCount;
      sellerSummary.extraCount += row.extraCount;
      if (row.extraCount > 0) sellerSummary.duplicateSkuCount += 1;
      summary.sellers.set(sellerKey, sellerSummary);
    }

    const countries = Array.from(countryMap.values())
      .map((country) => {
        const skuRows = Array.from(country.skus.values()).map((skuRow) => ({
          sku: skuRow.sku,
          listingCount: skuRow.listingCount,
          extraCount: Math.max(skuRow.listingCount - 1, 0),
          sellerCount: skuRow.sellers.size,
          sampleTitle: skuRow.sampleTitle || '',
        }));

        return {
          country: country.country,
          currencies: Array.from(country.currencies).sort(),
          uniqueSkuCount: skuRows.length,
          listingCount: country.listingCount,
          duplicateSkuCount: skuRows.filter((skuRow) => skuRow.extraCount > 0).length,
          extraCount: skuRows.reduce((sum, skuRow) => sum + skuRow.extraCount, 0),
          sellerBreakdown: Array.from(country.sellers.values())
            .sort((a, b) => b.extraCount - a.extraCount || b.listingCount - a.listingCount || a.sellerName.localeCompare(b.sellerName))
            .slice(0, 12),
          topDuplicates: skuRows
            .filter((skuRow) => skuRow.extraCount > 0)
            .sort((a, b) => b.extraCount - a.extraCount || b.listingCount - a.listingCount || a.sku.localeCompare(b.sku))
            .slice(0, 10),
        };
      })
      .sort((a, b) => b.extraCount - a.extraCount || b.uniqueSkuCount - a.uniqueSkuCount || a.country.localeCompare(b.country));

    const totals = countries.reduce((acc, row) => {
      acc.uniqueSkuCount += row.uniqueSkuCount;
      acc.listingCount += row.listingCount;
      acc.duplicateSkuCount += row.duplicateSkuCount;
      acc.extraCount += row.extraCount;
      return acc;
    }, { uniqueSkuCount: 0, listingCount: 0, duplicateSkuCount: 0, extraCount: 0 });

    res.json({ countries, totals });
  } catch (err) {
    console.error('Error fetching SKU duplicate country summary:', err);
    res.status(500).json({ error: 'Failed to fetch SKU duplicate country summary.' });
  }
});

// GET /sellers/skus-in-multiple-currencies
// Finds SKU names that appear in more than one normalized currency group.
router.get('/skus-in-multiple-currencies', requireAuth, requirePageAccess(['DuplicateSkus', 'SkuIndexDashboard']), async (req, res) => {
  try {
    const rows = await SellerSkuIndex.aggregate([
      { $match: { sku: { $nin: ['', null] } } },
      {
        $addFields: {
          normalizedCurrency: { $toUpper: { $ifNull: ['$currency', 'UNKNOWN'] } },
        },
      },
      {
        $group: {
          _id: { sku: '$sku', currency: '$normalizedCurrency' },
          listingCount: { $sum: 1 },
          sellers: { $addToSet: '$seller' },
          sampleTitles: { $push: '$title' },
        },
      },
      {
        $group: {
          _id: '$_id.sku',
          currencyCount: { $sum: 1 },
          totalListings: { $sum: '$listingCount' },
          currencyRows: {
            $push: {
              currency: '$_id.currency',
              country: '$_id.currency',
              listingCount: '$listingCount',
              sellerCount: { $size: '$sellers' },
              sampleTitle: { $arrayElemAt: ['$sampleTitles', 0] },
            },
          },
        },
      },
      { $match: { currencyCount: { $gt: 1 } } },
      { $sort: { currencyCount: -1, totalListings: -1, _id: 1 } },
      {
        $project: {
          _id: 0,
          sku: '$_id',
          currencyCount: 1,
          totalListings: 1,
          currencyRows: 1,
        },
      },
    ]);

    const data = rows.map((row) => ({
      ...row,
      currencyRows: row.currencyRows
        .map((currencyRow) => ({
          ...currencyRow,
          country: formatCurrencyCountry(currencyRow.currency),
        }))
        .sort((a, b) => b.listingCount - a.listingCount || a.currency.localeCompare(b.currency)),
    }));

    res.json({
      skus: data,
      total: data.length,
      extraCount: data.reduce((sum, row) => sum + Math.max((row.currencyCount || 0) - 1, 0), 0),
    });
  } catch (err) {
    console.error('Error fetching SKUs in multiple currencies:', err);
    res.status(500).json({ error: 'Failed to fetch SKUs in multiple currencies.' });
  }
});

export default router;

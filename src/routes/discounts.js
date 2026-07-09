/**
 * Discounts (Promotions) routes — eBay Sell Marketing API
 *
 * GET /api/ebay/discounts         — getPromotions (list of one seller's discounts)
 * GET /api/ebay/discounts/all     — discounts for every seller visible to the user
 * GET /api/ebay/discounts/detail  — full discount details via its promotionHref
 *
 * Mounted at /api/ebay in server/src/index.js.
 * Note: eBay renamed "promotions" to "discounts" in Seller Hub (Jul 2024);
 * the API interface still uses /promotion.
 */

import express from 'express';
import axios from 'axios';
import { requireAuth } from '../middleware/auth.js';
import Seller from '../models/Seller.js';
import UserSellerAssignment from '../models/UserSellerAssignment.js';
import { ensureValidToken } from './ebay.js';

const router = express.Router();

const MARKETING_BASE = 'https://api.ebay.com/sell/marketing/v1';

const VALID_STATUSES = ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'ENDED'];
const VALID_TYPES = ['CODED_COUPON', 'MARKDOWN_SALE', 'ORDER_DISCOUNT', 'VOLUME_DISCOUNT'];

// Flatten one PromotionDetail node into the shape the frontend table expects
function mapPromotion(p) {
  return {
    promotionId: p.promotionId,
    name: p.name || '',
    description: p.description || '',
    promotionType: p.promotionType || '',
    promotionStatus: p.promotionStatus || '',
    priority: p.priority || '',
    startDate: p.startDate || null,
    endDate: p.endDate || null,
    marketplaceId: p.marketplaceId || '',
    promotionHref: p.promotionHref || '',
    promotionImageUrl: p.promotionImageUrl || '',
    // getPromotions returns couponCode at the top level; the single-promotion
    // detail response nests it under couponConfiguration
    couponCode: p.couponCode || p.couponConfiguration?.couponCode || '',
    couponType: p.couponType || p.couponConfiguration?.couponType || '',
    maxCouponRedemptionPerUser: p.couponConfiguration?.maxCouponRedemptionPerUser ?? null,
    budget: p.budget?.value
      ? { value: p.budget.value, currency: p.budget.currency || 'USD' }
      : null,
  };
}

// Build getPromotions query params from the request filters
function buildPromotionParams({ marketplaceId, status, type, q, sort }) {
  const params = { marketplace_id: marketplaceId, limit: 200 };
  if (status && VALID_STATUSES.includes(status)) params.promotion_status = status;
  if (type && VALID_TYPES.includes(type)) params.promotion_type = type;
  if (q) params.q = q;
  if (sort) params.sort = sort;
  return params;
}

// Fetch all discounts for one seller, paging through getPromotions
// (200 per call, capped at 1000 total). Throws on token/API failure.
async function fetchSellerDiscounts(seller, filters) {
  const token = await ensureValidToken(seller);
  const marketplaceId = seller.ebayMarketplaces?.[0] ?? 'EBAY_US';
  const params = buildPromotionParams({ marketplaceId, ...filters });

  const promotions = [];
  let total = 0;
  let offset = 0;
  do {
    const { data } = await axios.get(`${MARKETING_BASE}/promotion`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      params: { ...params, offset },
    });
    total = data.total ?? 0;
    promotions.push(...(data.promotions ?? []));
    offset += 200;
  } while (promotions.length < total && offset < 1000);

  return { discounts: promotions.map(mapPromotion), total, marketplaceId };
}

// Extract a readable message from an eBay/axios error
const ebayErrorMessage = (err) =>
  err.response?.data?.errors?.[0]?.message ?? err.message ?? 'Unknown error';

// Sellers the requesting user may see — mirrors GET /sellers/all:
// superadmin sees everyone; others see their assignments (or everyone when
// they have no explicit assignments, for backward compatibility).
async function getVisibleSellers(user) {
  if (user.role === 'superadmin') {
    return Seller.find().populate('user', 'username email');
  }
  const assignments = await UserSellerAssignment.find({ user: user.userId }).select('seller').lean();
  const assignedSellerIds = assignments.map((a) => a.seller);
  if (assignedSellerIds.length === 0) {
    return Seller.find().populate('user', 'username email');
  }
  return Seller.find({ _id: { $in: assignedSellerIds } }).populate('user', 'username email');
}

// =============================================================================
// GET /discounts
// Query: sellerId (required), status, type, q, sort
// =============================================================================
/**
 * @swagger
 * /ebay/discounts:
 *   get:
 *     tags: [Discounts]
 *     summary: List a seller's discounts (promotions) via eBay Sell Marketing API
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ALL, DRAFT, SCHEDULED, RUNNING, PAUSED, ENDED] }
 *         description: Filter by discount state (RUNNING = "Active" in Seller Hub)
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [ALL, CODED_COUPON, MARKDOWN_SALE, ORDER_DISCOUNT, VOLUME_DISCOUNT] }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Keywords matched against the discount title
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [START_DATE, END_DATE, -START_DATE, -END_DATE] }
 *     responses:
 *       200:
 *         description: List of discounts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:       { type: boolean }
 *                 discounts:     { type: array, items: { type: object } }
 *                 total:         { type: integer }
 *                 marketplaceId: { type: string }
 *       400:
 *         description: Missing sellerId or eBay API error
 *       404:
 *         description: Seller not found
 *       500:
 *         description: Internal server error
 */
router.get('/discounts', requireAuth, async (req, res) => {
  try {
    const { sellerId, status, type, q, sort } = req.query;
    if (!sellerId) return res.status(400).json({ error: 'Missing sellerId' });

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const { discounts, total, marketplaceId } = await fetchSellerDiscounts(seller, { status, type, q, sort });

    console.log(`[Discounts] fetched ${discounts.length}/${total} discount(s) for seller ${sellerId}`);

    return res.json({ success: true, discounts, total, marketplaceId });
  } catch (err) {
    console.error('[Discounts] getPromotions error:', err.response?.data ?? err.message);
    return res
      .status(err.response?.status ?? 500)
      .json({ error: 'Failed to fetch discounts', details: ebayErrorMessage(err) });
  }
});

// =============================================================================
// GET /discounts/all
// Query: status, type, q, sort
// Fetches discounts for every seller visible to the requesting user
// (5 sellers at a time). One seller failing does not fail the request —
// each result carries its own error message instead.
// =============================================================================
/**
 * @swagger
 * /ebay/discounts/all:
 *   get:
 *     tags: [Discounts]
 *     summary: List discounts for all sellers visible to the user, with per-seller errors
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ALL, DRAFT, SCHEDULED, RUNNING, PAUSED, ENDED] }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [ALL, CODED_COUPON, MARKDOWN_SALE, ORDER_DISCOUNT, VOLUME_DISCOUNT] }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [START_DATE, END_DATE, -START_DATE, -END_DATE] }
 *     responses:
 *       200:
 *         description: Per-seller discount results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:   { type: boolean }
 *                 fetchedAt: { type: string, format: date-time }
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sellerId:   { type: string }
 *                       sellerName: { type: string }
 *                       discounts:  { type: array, items: { type: object } }
 *                       total:      { type: integer }
 *                       error:      { type: string, nullable: true }
 *       500:
 *         description: Internal server error
 */
router.get('/discounts/all', requireAuth, async (req, res) => {
  try {
    const { status, type, q, sort } = req.query;
    const sellers = await getVisibleSellers(req.user);

    const results = new Array(sellers.length);
    const CONCURRENCY = 5;
    let cursor = 0;

    async function worker() {
      while (cursor < sellers.length) {
        const idx = cursor++;
        const seller = sellers[idx];
        const base = {
          sellerId: seller._id,
          sellerName: seller.user?.username || String(seller._id),
        };
        try {
          const { discounts, total } = await fetchSellerDiscounts(seller, { status, type, q, sort });
          results[idx] = { ...base, discounts, total, error: null };
        } catch (err) {
          console.error(`[Discounts] fetch failed for seller ${base.sellerName}:`, err.response?.data ?? err.message);
          results[idx] = { ...base, discounts: [], total: 0, error: ebayErrorMessage(err) };
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sellers.length) }, worker));

    const ok = results.filter((r) => !r.error).length;
    console.log(`[Discounts] all-sellers fetch: ${ok}/${results.length} seller(s) succeeded`);

    return res.json({ success: true, fetchedAt: new Date().toISOString(), results });
  } catch (err) {
    console.error('[Discounts] all-sellers error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch discounts for all sellers', details: err.message });
  }
});

// =============================================================================
// GET /discounts/detail
// Query: sellerId, href (the promotionHref returned by getPromotions)
// The list call omits discountRules / inventoryCriterion — following the
// promotionHref returns the complete discount definition.
// =============================================================================
/**
 * @swagger
 * /ebay/discounts/detail:
 *   get:
 *     tags: [Discounts]
 *     summary: Fetch full discount details (rules, inventory criteria) via its promotionHref
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: href
 *         required: true
 *         schema: { type: string }
 *         description: The promotionHref returned by the discounts list endpoint
 *     responses:
 *       200:
 *         description: Full discount definition
 *       400:
 *         description: Missing/invalid parameters or eBay API error
 *       404:
 *         description: Seller not found
 *       500:
 *         description: Internal server error
 */
router.get('/discounts/detail', requireAuth, async (req, res) => {
  try {
    const { sellerId, href } = req.query;
    if (!sellerId || !href) {
      return res.status(400).json({ error: 'Missing required fields: sellerId, href' });
    }

    // Only allow following hrefs into the eBay Marketing API (guards against SSRF)
    if (!String(href).startsWith(`${MARKETING_BASE}/`)) {
      return res.status(400).json({ error: 'Invalid href — must be an eBay Sell Marketing API URL' });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);

    const { data } = await axios.get(href, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    return res.json({ success: true, discount: data });
  } catch (err) {
    const ebayError = err.response?.data?.errors?.[0]?.message ?? err.message;
    console.error('[Discounts] detail error:', err.response?.data ?? err.message);
    return res
      .status(err.response?.status ?? 500)
      .json({ error: 'Failed to fetch discount details', details: ebayError });
  }
});

export default router;

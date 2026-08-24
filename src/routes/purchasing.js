// routes/purchasing.js
//
// Backs the Grow Fulfil Chrome extension: pins eBay orders to an Amazon buyer
// account, hands them out one at a time, holds a claim while an operator buys,
// and records the Amazon order number that comes back.
//
// The Order collection is never written to. All purchasing state lives in the
// AmazonPurchase sidecar, and no prices, taxes or derived financials are stored
// — the only thing kept from the confirmation page is the Amazon order id.
//
// Buyer accounts are AmazonBuyerAccount rows. The separate AmazonAccount model is
// the existing admin address book and is deliberately untouched by any of this.

import { Router } from 'express';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import User from '../models/User.js';
import AmazonBuyerAccount from '../models/AmazonBuyerAccount.js';
import AmazonPurchase from '../models/AmazonPurchase.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { resolveAsinForOrder, isAsin, cleanAsin } from '../utils/asinResolver.js';
import { buildAmazonUrl, isAssociateTag } from '../utils/amazonLink.js';
import {
  MAX_ORDERS_PER_AMAZON_ACCOUNT,
  buildDayRange,
  getPlatformDayString,
} from '../utils/platformDay.js';

const router = Router();

// A claim is a soft lock. If a browser is closed mid-order the row would be
// stranded, so anything held longer than this is reclaimable by anyone.
const CLAIM_TTL_MS = 30 * 60 * 1000;

const guard = [requireAuth, requirePageAccess('Fulfillment')];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const staleClaimCutoff = () => new Date(Date.now() - CLAIM_TTL_MS);

// requireAuth puts the raw JWT payload on req.user — { userId, role, ... } — so
// there is no _id or username on it. Anything needing a display name must read
// the User document.
const actorId = (req) => req.user?.userId || null;

async function actorName(req) {
  const user = await User.findById(actorId(req)).select('username email').lean();
  return user?.username || user?.email || '';
}

function shipTo(order) {
  return {
    name: order.shippingFullName || '',
    line1: order.shippingAddressLine1 || '',
    line2: order.shippingAddressLine2 || '',
    city: order.shippingCity || '',
    state: order.shippingState || '',
    postalCode: order.shippingPostalCode || '',
    country: order.shippingCountry || 'US',
    phone: order.shippingPhone || '',
  };
}

/**
 * Per-order checks the operator needs before buying.
 * `blocking: true` means the panel must not let them open Amazon yet.
 */
function orderWarnings(order, asin) {
  const w = [];
  const ship = shipTo(order);

  if (!asin) {
    w.push({ code: 'NO_ASIN', blocking: true, message: 'No ASIN for this SKU — enter one manually' });
  }
  if (!ship.line1 || !ship.city || !ship.postalCode) {
    w.push({ code: 'NO_ADDRESS', blocking: true, message: 'Shipping address is incomplete' });
  }
  // Buying against a cancel request is the single most expensive mistake here:
  // the money is spent and the eBay sale is gone.
  const cancelState = order.cancelState || order.cancelStatus?.cancelState;
  if (cancelState && cancelState !== 'NONE_REQUESTED') {
    w.push({ code: 'CANCEL_REQUESTED', blocking: true, message: `eBay cancel state: ${cancelState} — do not buy` });
  }
  if ((order.lineItems?.length || 0) > 1) {
    w.push({ code: 'MULTI_LINE_ITEM', blocking: false, message: `${order.lineItems.length} line items — only the first ASIN is resolved` });
  }
  if ((order.quantity || 1) > 1) {
    w.push({ code: 'QTY_GT_1', blocking: false, message: `Quantity ${order.quantity} — set it on the Amazon page` });
  }
  return w;
}

/** Associate tag for an account, falling back to the platform-wide one. */
function tagFor(account) {
  return account?.associateTag || process.env.AMAZON_ASSOCIATE_TAG || '';
}

/**
 * Shapes one queue entry. `purchase` is the AmazonPurchase row; `order` the eBay
 * order it points at.
 */
function toItem(purchase, order, tag) {
  const asin = purchase.asin || '';
  return {
    id: String(purchase._id),
    orderRef: String(order._id),
    orderId: order.orderId,
    dateSold: order.dateSold,
    productName: order.productName || '',
    itemNumber: order.itemNumber || '',
    quantity: order.quantity || 1,
    buyerAccount: purchase.buyerAccount,

    asin,
    asinSource: purchase.asinSource,
    amazonUrl: buildAmazonUrl(asin, tag),

    ship: shipTo(order),

    status: purchase.status,
    claimedByName: purchase.claimedByName || '',
    claimedAt: purchase.claimedAt,
    azOrderId: purchase.azOrderId || '',
    error: purchase.error || '',
    attempts: purchase.attempts || 0,

    warnings: orderWarnings(order, asin),
  };
}

/** Orders already placed on this account today, for the daily-cap check. */
function placedToday(accountName, day) {
  const { start, end } = buildDayRange(day);
  return AmazonPurchase.countDocuments({
    buyerAccount: accountName,
    status: 'placed',
    placedAt: { $gte: start, $lte: end },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Buyer accounts
//
// AmazonBuyerAccount rows — the logins orders are actually placed from. Distinct
// from the AmazonAccount address book, which this feature never touches.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /purchasing/accounts:
 *   get:
 *     tags: [Purchasing]
 *     summary: Amazon buyer accounts available for purchasing
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: all, schema: { type: boolean }, description: Include inactive accounts }
 *     responses:
 *       200:
 *         description: Accounts with today's order count against the daily cap
 */
router.get('/accounts', guard, async (req, res) => {
  try {
    const day = getPlatformDayString(new Date());
    const filter = String(req.query.all) === 'true' ? {} : { active: { $ne: false } };
    const accounts = await AmazonBuyerAccount.find(filter).sort({ label: 1 }).lean();

    const rows = await Promise.all(accounts.map(async (acc) => {
      const cap = acc.dailyOrderCap || MAX_ORDERS_PER_AMAZON_ACCOUNT;
      const used = await placedToday(acc.label, day);
      return {
        id: String(acc._id),
        label: acc.label,
        email: acc.email || '',
        chromeProfile: acc.chromeProfile || '',
        amazonProfileLabel: acc.amazonProfileLabel || '',
        associateTag: tagFor(acc),
        active: acc.active !== false,
        placedToday: used,
        dailyOrderCap: cap,
        capReached: used >= cap,
      };
    }));

    res.json({ date: day, accounts: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/accounts:
 *   post:
 *     tags: [Purchasing]
 *     summary: Register an Amazon buyer account
 *     description: Records that the account exists. No credentials are stored or accepted.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [label]
 *             properties:
 *               label:         { type: string, example: amz-us-04 }
 *               email:         { type: string }
 *               chromeProfile: { type: string }
 *               associateTag:  { type: string, example: shreejagann0f-20 }
 *               dailyOrderCap: { type: integer }
 *               notes:         { type: string }
 *     responses:
 *       201:
 *         description: Created
 *       409:
 *         description: Label already in use
 */
router.post('/accounts', guard, async (req, res) => {
  try {
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label is required' });

    const tag = String(req.body?.associateTag || '').trim();
    if (tag && !isAssociateTag(tag)) {
      return res.status(400).json({ error: `'${tag}' is not a valid associate tag (expected e.g. mystore-20)` });
    }

    const account = await AmazonBuyerAccount.create({
      label,
      email: String(req.body?.email || '').trim(),
      chromeProfile: String(req.body?.chromeProfile || '').trim(),
      associateTag: tag,
      dailyOrderCap: Number(req.body?.dailyOrderCap) || 0,
      notes: String(req.body?.notes || '').trim(),
    });

    res.status(201).json({ success: true, account });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'A buyer account with that label already exists' });
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/accounts/{label}:
 *   patch:
 *     tags: [Purchasing]
 *     summary: Update a buyer account
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: label, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Updated
 */
router.patch('/accounts/:label', guard, async (req, res) => {
  try {
    const set = {};
    for (const key of ['email', 'chromeProfile', 'notes', 'amazonProfileLabel']) {
      if (req.body?.[key] !== undefined) set[key] = String(req.body[key]).trim();
    }
    if (req.body?.associateTag !== undefined) {
      const tag = String(req.body.associateTag).trim();
      if (tag && !isAssociateTag(tag)) return res.status(400).json({ error: `'${tag}' is not a valid associate tag` });
      set.associateTag = tag;
    }
    if (req.body?.dailyOrderCap !== undefined) set.dailyOrderCap = Number(req.body.dailyOrderCap) || 0;
    if (req.body?.active !== undefined) set.active = Boolean(req.body.active);

    const account = await AmazonBuyerAccount.findOneAndUpdate(
      { label: req.params.label }, { $set: set }, { new: true }
    ).lean();
    if (!account) return res.status(404).json({ error: 'Buyer account not found' });

    res.json({ success: true, account });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/accounts/{label}/profile-label:
 *   patch:
 *     tags: [Purchasing]
 *     summary: Bind a buyer account to the display name its Chrome profile shows
 *     description: >
 *       Recorded on first use from the Amazon nav bar ("Hello, X"). Every later
 *       order checks the live page against it so an operator cannot buy on the
 *       wrong signed-in account.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: label, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amazonProfileLabel]
 *             properties:
 *               amazonProfileLabel: { type: string, example: Prasanna }
 *     responses:
 *       200:
 *         description: Binding stored
 */
router.patch('/accounts/:label/profile-label', guard, async (req, res) => {
  try {
    const value = String(req.body?.amazonProfileLabel || '').trim().slice(0, 120);
    if (!value) return res.status(400).json({ error: 'amazonProfileLabel is required' });

    const account = await AmazonBuyerAccount.findOneAndUpdate(
      { label: req.params.label },
      { $set: { amazonProfileLabel: value } },
      { new: true }
    ).lean();
    if (!account) return res.status(404).json({ error: 'Buyer account not found' });

    res.json({ success: true, label: account.label, amazonProfileLabel: account.amazonProfileLabel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Assignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /purchasing/unassigned:
 *   get:
 *     tags: [Purchasing]
 *     summary: eBay orders not yet pinned to any Amazon account
 *     description: The pool to assign from — orders with no AmazonPurchase row yet.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: limit,  schema: { type: integer, default: 50 } }
 *       - { in: query, name: search, schema: { type: string, description: 'Match an eBay order id' } }
 *     responses:
 *       200:
 *         description: Assignable orders, oldest first
 */
router.get('/unassigned', guard, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const search = String(req.query.search || '').trim();

    // Everything already pinned, so those orders can be excluded.
    const taken = await AmazonPurchase.find().select('order').lean();
    const takenIds = taken.map(p => p.order);

    const query = {
      _id: { $nin: takenIds },
      // Anything with an Amazon order number recorded was already bought,
      // whether by this tool or by hand.
      $or: [{ azOrderId: { $in: [null, ''] } }, { azOrderId: { $exists: false } }],
    };
    if (search) query.orderId = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

    const orders = await Order.find(query).sort({ dateSold: 1 }).limit(limit).lean();

    // These are not assigned yet, so there is no account and no tag — resolve the
    // ASIN only so the operator can see what they would be buying.
    const items = await Promise.all(orders.map(async (order) => {
      const resolved = await resolveAsinForOrder(order);
      return {
        orderRef: String(order._id),
        orderId: order.orderId,
        dateSold: order.dateSold,
        productName: order.productName || '',
        quantity: order.quantity || 1,
        asin: resolved.asin,
        asinReason: resolved.reason,
        ship: shipTo(order),
        warnings: orderWarnings(order, resolved.asin),
      };
    }));

    res.json({ count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/assign:
 *   post:
 *     tags: [Purchasing]
 *     summary: Pin eBay orders to one Amazon buyer account
 *     description: >
 *       Creates an AmazonPurchase row per order. Only that account's queue will
 *       offer them afterwards. The unique index on `order` means a second
 *       assignment of the same order to another account fails rather than
 *       creating a duplicate.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderRefs, buyerAccount]
 *             properties:
 *               orderRefs:     { type: array, items: { type: string }, description: Order _id values }
 *               buyerAccount: { type: string, description: AmazonBuyerAccount label }
 *     responses:
 *       200:
 *         description: Per-order outcome
 *       400:
 *         description: Missing or unknown account
 */
router.post('/assign', guard, async (req, res) => {
  try {
    const { orderRefs, buyerAccount } = req.body || {};
    const accountName = String(buyerAccount || '').trim();

    if (!accountName) return res.status(400).json({ error: 'buyerAccount is required' });
    if (!Array.isArray(orderRefs) || !orderRefs.length) {
      return res.status(400).json({ error: 'orderRefs must be a non-empty array' });
    }

    // Assigning to an account that does not exist would create rows no queue
    // could ever surface.
    const account = await AmazonBuyerAccount.findOne({ label: accountName }).lean();
    if (!account) return res.status(400).json({ error: `No Amazon account named '${accountName}'` });
    if (account.active === false) return res.status(400).json({ error: `Account '${accountName}' is inactive` });

    const assigned = [];
    const skipped = [];

    for (const ref of orderRefs) {
      if (!mongoose.isValidObjectId(ref)) { skipped.push({ ref, reason: 'Invalid id' }); continue; }

      const order = await Order.findById(ref).select('orderId azOrderId lineItems').lean();
      if (!order) { skipped.push({ ref, reason: 'Order not found' }); continue; }
      if (order.azOrderId) { skipped.push({ ref, orderId: order.orderId, reason: `Already bought (${order.azOrderId})` }); continue; }

      const existing = await AmazonPurchase.findOne({ order: ref }).select('buyerAccount status').lean();
      if (existing) {
        skipped.push({ ref, orderId: order.orderId, reason: `Already assigned to ${existing.buyerAccount} (${existing.status})` });
        continue;
      }

      // Resolve the ASIN once, at assignment. The operator can override later.
      const resolved = await resolveAsinForOrder(order);

      try {
        await AmazonPurchase.create({
          order: ref,
          orderId: order.orderId,
          buyerAccount: accountName,
          asin: resolved.asin,
          asinSource: resolved.source,
          assignedBy: actorId(req),
        });
        assigned.push({ ref, orderId: order.orderId, asin: resolved.asin });
      } catch (e) {
        // Duplicate key: another admin assigned the same order in parallel.
        const reason = e.code === 11000 ? 'Assigned by someone else just now' : e.message;
        skipped.push({ ref, orderId: order.orderId, reason });
      }
    }

    res.json({ success: true, buyerAccount: accountName, assignedCount: assigned.length, assigned, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/assignments/{id}:
 *   delete:
 *     tags: [Purchasing]
 *     summary: Unpin an order, returning it to the unassigned pool
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Assignment removed
 *       409:
 *         description: Already placed — kept as a record
 */
router.delete('/assignments/:id', guard, async (req, res) => {
  try {
    const purchase = await AmazonPurchase.findById(req.params.id).lean();
    if (!purchase) return res.status(404).json({ error: 'Assignment not found' });
    if (purchase.status === 'placed') {
      return res.status(409).json({ error: `Already placed as ${purchase.azOrderId} — not removing the record` });
    }

    await AmazonPurchase.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /purchasing/queue:
 *   get:
 *     tags: [Purchasing]
 *     summary: Orders pinned to one Amazon account and still to be bought
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: buyerAccount, required: true, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, default: 25 } }
 *     responses:
 *       200:
 *         description: Queue items with ASIN, affiliate-tagged URL, address and warnings
 *       400:
 *         description: buyerAccount is required
 */
router.get('/queue', guard, async (req, res) => {
  try {
    const accountName = String(req.query.buyerAccount || '').trim();
    if (!accountName) return res.status(400).json({ error: 'buyerAccount is required' });

    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const account = await AmazonBuyerAccount.findOne({ label: accountName }).lean();
    const tag = tagFor(account);

    const purchases = await AmazonPurchase.find({
      buyerAccount: accountName,
      $or: [
        { status: { $in: ['pending', 'failed'] } },
        // Reclaim rows a crashed or closed browser left held.
        { status: 'claimed', claimedAt: { $lt: staleClaimCutoff() } },
        // Always show the caller their own live claim so a panel reload resumes.
        { status: 'claimed', claimedBy: actorId(req) },
      ],
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .populate('order')
      .lean();

    const items = purchases
      .filter(p => p.order) // an order deleted out from under us
      .map(p => toItem(p, p.order, tag));

    res.json({ buyerAccount: accountName, associateTag: tag, count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/{id}/claim:
 *   post:
 *     tags: [Purchasing]
 *     summary: Take an exclusive hold before buying
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Claim granted
 *       409:
 *         description: Another operator holds this order
 */
router.post('/:id/claim', guard, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });

    // Atomic: of two concurrent claims only one can match this filter.
    const purchase = await AmazonPurchase.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { status: { $in: ['pending', 'failed'] } },
          { status: 'claimed', claimedAt: { $lt: staleClaimCutoff() } },
          { status: 'claimed', claimedBy: actorId(req) },
        ],
      },
      {
        $set: {
          status: 'claimed',
          claimedBy: actorId(req),
          claimedByName: await actorName(req),
          claimedAt: new Date(),
          error: '',
        },
      },
      { new: true }
    ).populate('order').lean();

    if (!purchase) {
      const existing = await AmazonPurchase.findById(id).select('status claimedByName azOrderId').lean();
      if (!existing) return res.status(404).json({ error: 'Assignment not found' });
      if (existing.status === 'placed') return res.status(409).json({ error: `Already placed as ${existing.azOrderId}` });
      return res.status(409).json({ error: `Held by ${existing.claimedByName || 'another operator'}` });
    }

    const account = await AmazonBuyerAccount.findOne({ label: purchase.buyerAccount }).lean();
    res.json({ success: true, item: toItem(purchase, purchase.order, tagFor(account)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/{id}/release:
 *   post:
 *     tags: [Purchasing]
 *     summary: Give up a claim without buying
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Claim released
 */
router.post('/:id/release', guard, async (req, res) => {
  try {
    const purchase = await AmazonPurchase.findOneAndUpdate(
      { _id: req.params.id, status: 'claimed', claimedBy: actorId(req) },
      { $set: { status: 'pending', claimedBy: null, claimedByName: '', claimedAt: null } },
      { new: true }
    ).lean();
    if (!purchase) return res.status(404).json({ error: 'No claim of yours on this order' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/{id}/asin:
 *   patch:
 *     tags: [Purchasing]
 *     summary: Override the ASIN
 *     description: >
 *       For when the SKU maps to nothing, or the mapped product is unavailable
 *       and the operator sourced an alternative. Accepts a bare ASIN or a URL.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [asin]
 *             properties:
 *               asin: { type: string, example: B0FSXQRTGC }
 *     responses:
 *       200:
 *         description: Updated item
 *       400:
 *         description: Malformed ASIN
 */
router.patch('/:id/asin', guard, async (req, res) => {
  try {
    const raw = String(req.body?.asin || '').trim();
    // Accept a pasted product URL as well as a bare ASIN — operators copy the
    // address bar far more often than they read the ASIN off the page.
    const fromUrl = raw.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    const asin = cleanAsin(fromUrl ? fromUrl[1] : raw);

    if (!isAsin(asin)) return res.status(400).json({ error: `'${raw}' is not a valid ASIN` });

    const purchase = await AmazonPurchase.findByIdAndUpdate(
      req.params.id,
      { $set: { asin, asinSource: 'manual' } },
      { new: true }
    ).populate('order').lean();
    if (!purchase) return res.status(404).json({ error: 'Assignment not found' });

    const account = await AmazonBuyerAccount.findOne({ label: purchase.buyerAccount }).lean();
    res.json({ success: true, item: toItem(purchase, purchase.order, tagFor(account)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/{id}/placed:
 *   post:
 *     tags: [Purchasing]
 *     summary: Record the Amazon order number from the confirmation page
 *     description: Stores the order id only — no prices, tax or derived financials.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [azOrderId]
 *             properties:
 *               azOrderId: { type: string, example: '112-1234567-1234567' }
 *     responses:
 *       200:
 *         description: Recorded
 *       409:
 *         description: A different Amazon order id is already recorded
 */
router.post('/:id/placed', guard, async (req, res) => {
  try {
    const azOrderId = String(req.body?.azOrderId || '').trim();
    if (!azOrderId) return res.status(400).json({ error: 'azOrderId is required' });

    const purchase = await AmazonPurchase.findById(req.params.id);
    if (!purchase) return res.status(404).json({ error: 'Assignment not found' });

    // The confirmation page can be submitted twice (operator refreshes it). Same
    // id is a harmless replay; a different one means something went wrong.
    if (purchase.azOrderId && purchase.azOrderId !== azOrderId) {
      return res.status(409).json({ error: `Already recorded as ${purchase.azOrderId}` });
    }

    purchase.azOrderId = azOrderId;
    purchase.status = 'placed';
    purchase.placedAt = new Date();
    purchase.error = '';
    purchase.claimedBy = null;
    purchase.claimedByName = '';
    purchase.claimedAt = null;
    await purchase.save();

    res.json({ success: true, orderId: purchase.orderId, azOrderId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/{id}/fail:
 *   post:
 *     tags: [Purchasing]
 *     summary: Record a failed attempt and return the order to the queue
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Failure recorded
 */
router.post('/:id/fail', guard, async (req, res) => {
  try {
    const message = String(req.body?.error || 'Unknown failure').slice(0, 500);
    const purchase = await AmazonPurchase.findByIdAndUpdate(
      req.params.id,
      {
        $set: { status: 'failed', error: message, claimedBy: null, claimedByName: '', claimedAt: null },
        $inc: { attempts: 1 },
      },
      { new: true }
    ).lean();
    if (!purchase) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ success: true, attempts: purchase.attempts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /purchasing/{id}/skip:
 *   post:
 *     tags: [Purchasing]
 *     summary: Take an order out of the queue without deleting the assignment
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Skipped
 */
router.post('/:id/skip', guard, async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').slice(0, 500);
    const purchase = await AmazonPurchase.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'skipped', error: reason, claimedBy: null, claimedByName: '', claimedAt: null } },
      { new: true }
    ).lean();
    if (!purchase) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

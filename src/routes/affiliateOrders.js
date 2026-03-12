import express from 'express';
import Order from '../models/Order.js';
import AmazonAccount from '../models/AmazonAccount.js';
import AmazonAccountDailyBalance from '../models/AmazonAccountDailyBalance.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const MAX_ORDERS_PER_AMAZON_ACCOUNT_PER_DAY = 9;

// All routes require authentication
router.use(requireAuth);

// PST offset used throughout the platform
const PST_OFFSET_HOURS = 8;

/**
 * Builds a UTC date range for a given YYYY-MM-DD string (PST day boundaries)
 */
function buildDayRange(dateStr) {
    const start = new Date(dateStr);
    start.setUTCHours(PST_OFFSET_HOURS, 0, 0, 0);

    const end = new Date(dateStr);
    end.setDate(end.getDate() + 1);
    end.setUTCHours(PST_OFFSET_HOURS - 1, 59, 59, 999);

    return { start, end };
}

// ---------------------------------------------------------------------------
// TAB 1 — Daily Orders
// GET /api/affiliate-orders/daily?date=YYYY-MM-DD
// Returns all orders sold on that date, with seller name populated
// ---------------------------------------------------------------------------
router.get('/daily', async (req, res) => {
    try {
        const { date, excludeLowValue } = req.query;
        if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

        const { start, end } = buildDayRange(date);

        const query = { dateSold: { $gte: start, $lte: end } };

        // Exclude low value orders (less than $3)
        if (excludeLowValue === 'true') {
            query.$and = query.$and || [];
            query.$and.push({
                $or: [
                    { beforeTaxUSD: { $gte: 3 } },
                    { beforeTaxUSD: { $exists: false } },
                    { beforeTaxUSD: null }
                ]
            });
        }

        const orders = await Order.find(query)
            .populate({ path: 'seller', populate: { path: 'user', select: 'username' } })
            .sort({ dateSold: 1 })
            .lean();

        res.json(orders);
    } catch (err) {
        console.error('GET /affiliate-orders/daily error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/affiliate-orders/:id/sourcing
// Update the sourcing-specific fields on an order
// ---------------------------------------------------------------------------
router.patch('/:id/sourcing', async (req, res) => {
    try {
        const ALLOWED_FIELDS = [
            'affiliateLink',
            'affiliateLinks',
            'sourcingStatus',
            'purchaser',
            'sourcingMessageStatus',
            'amazonAccount',
            'arrivingDate',
            'beforeTax',
            'estimatedTax',
            'azOrderId',
            'beforeTaxUSD',
            'fulfillmentNotes',
        ];

        const update = {};
        for (const field of ALLOWED_FIELDS) {
            if (req.body[field] !== undefined) {
                update[field] = req.body[field];
            }
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ error: 'No valid fields provided' });
        }

        const existingOrder = await Order.findById(req.params.id).select('dateSold amazonAccount').lean();
        if (!existingOrder) return res.status(404).json({ error: 'Order not found' });

        // Enforce daily cap when assigning/changing amazon account.
        if (update.amazonAccount !== undefined && update.amazonAccount !== null && update.amazonAccount !== '') {
            const soldDate = existingOrder.dateSold;
            const normalizedDate = soldDate instanceof Date
                ? soldDate.toISOString().slice(0, 10)
                : new Date(soldDate).toISOString().slice(0, 10);
            const { start, end } = buildDayRange(normalizedDate);

            const assignedCount = await Order.countDocuments({
                _id: { $ne: req.params.id },
                dateSold: { $gte: start, $lte: end },
                amazonAccount: update.amazonAccount,
            });

            if (assignedCount >= MAX_ORDERS_PER_AMAZON_ACCOUNT_PER_DAY) {
                return res.status(400).json({
                    error: `Cannot assign more than ${MAX_ORDERS_PER_AMAZON_ACCOUNT_PER_DAY} orders to ${update.amazonAccount} for this day`,
                });
            }
        }

        const order = await Order.findByIdAndUpdate(
            req.params.id,
            { $set: update },
            { new: true, runValidators: true }
        ).lean();

        res.json(order);
    } catch (err) {
        console.error('PATCH /affiliate-orders/:id/sourcing error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// TAB 2 — Gift Card Balances
// GET /api/affiliate-orders/balances?date=YYYY-MM-DD
// Returns one row per Amazon account with totalExpense (auto-calculated from orders)
// and the editable balance fields (upserted on first access)
// ---------------------------------------------------------------------------
router.get('/balances', async (req, res) => {
    try {
        const { date, excludeLowValue } = req.query;
        if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

        const { start, end } = buildDayRange(date);

        // All Amazon accounts
        const accounts = await AmazonAccount.find().sort({ name: 1 }).lean();

        // Build match query for orders
        const matchQuery = { dateSold: { $gte: start, $lte: end }, amazonAccount: { $exists: true, $ne: '' } };
        if (excludeLowValue === 'true') {
            matchQuery.$and = [
                {
                    $or: [
                        { beforeTaxUSD: { $gte: 3 } },
                        { beforeTaxUSD: { $exists: false } },
                        { beforeTaxUSD: null }
                    ]
                }
            ];
        }

        // Aggregate expense per account for this day from orders
        const expenseAgg = await Order.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: '$amazonAccount',
                    totalExpense: {
                        $sum: {
                            $multiply: [
                                { $ifNull: ['$beforeTaxUSD', 0] },
                                1.1,
                            ],
                        },
                    },
                    orderCount: { $sum: 1 },
                },
            },
        ]);

        const expenseMap = {};
        for (const row of expenseAgg) {
            if (row._id) expenseMap[row._id] = { totalExpense: row.totalExpense, orderCount: row.orderCount };
        }

        // Fetch existing balance records for this date
        const existingBalances = await AmazonAccountDailyBalance.find({ date }).lean();
        const balanceMap = {};
        for (const b of existingBalances) {
            balanceMap[b.amazonAccountName] = b;
        }

        // Build combined response — one entry per account
        const rows = accounts.map((acc) => {
            const bal = balanceMap[acc.name] || {};
            const exp = expenseMap[acc.name] || { totalExpense: 0, orderCount: 0 };
            const availableBalance = Number(bal.availableBalance ?? 0);
            const addedBalance = Number(bal.addedBalance ?? 0);
            const totalExpense = Number(exp.totalExpense ?? 0);
            const difference = availableBalance + addedBalance - totalExpense;

            return {
                _id: bal._id || null,
                amazonAccountName: acc.name,
                date,
                totalExpense,
                orderCount: exp.orderCount,
                availableBalance,
                addedBalance,
                // Auto-driven status: checked when this account has positive remaining balance.
                giftCardStatus: difference > 0,
                note: bal.note ?? '',
                difference,
            };
        });

        res.json(rows);
    } catch (err) {
        console.error('GET /affiliate-orders/balances error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/affiliate-orders/balances
// Upsert a daily balance record for one Amazon account
// Body: { amazonAccountName, date, availableBalance, addedBalance, giftCardStatus, note }
// ---------------------------------------------------------------------------
router.put('/balances', async (req, res) => {
    try {
        const { amazonAccountName, date, availableBalance, addedBalance, giftCardStatus, note } = req.body;
        if (!amazonAccountName || !date) {
            return res.status(400).json({ error: 'amazonAccountName and date are required' });
        }

        const update = {};
        if (availableBalance !== undefined) update.availableBalance = availableBalance;
        if (addedBalance !== undefined) update.addedBalance = addedBalance;
        if (giftCardStatus !== undefined) update.giftCardStatus = giftCardStatus;
        if (note !== undefined) update.note = note;

        const record = await AmazonAccountDailyBalance.findOneAndUpdate(
            { amazonAccountName, date },
            { $set: update },
            { new: true, upsert: true, runValidators: true }
        ).lean();

        res.json(record);
    } catch (err) {
        console.error('PUT /affiliate-orders/balances error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// TAB 3 — Daily Summary
// GET /api/affiliate-orders/summary?date=YYYY-MM-DD
// Returns per-purchaser counts and overall day totals
// ---------------------------------------------------------------------------
router.get('/summary', async (req, res) => {
    try {
        const { date, excludeLowValue } = req.query;
        if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

        const { start, end } = buildDayRange(date);

        // Build query
        const dayQuery = { dateSold: { $gte: start, $lte: end } };
        const query = { ...dayQuery };
        if (excludeLowValue === 'true') {
            query.$and = [
                {
                    $or: [
                        { beforeTaxUSD: { $gte: 3 } },
                        { beforeTaxUSD: { $exists: false } },
                        { beforeTaxUSD: null }
                    ]
                }
            ];
        }

        // All orders that day
        const orders = await Order.find(query)
            .select('purchaser sourcingStatus beforeTaxUSD amazonExchangeRate amazonAccount')
            .lean();

        const totalOrders = orders.length;
        const totalUSD = orders.reduce((s, o) => s + (o.beforeTaxUSD || 0), 0);
        const ordersDone = orders.filter((o) => o.sourcingStatus === 'Done').length;
        const ordersNotDone = totalOrders - ordersDone;

        // INR: use the most recent amazonExchangeRate stored on any order that day, or 0
        const rateOrder = orders.find((o) => o.amazonExchangeRate);
        const exchangeRate = rateOrder?.amazonExchangeRate || 0;
        const totalINR = totalUSD * exchangeRate;

        // Per-purchaser breakdown
        const purchaserMap = {};
        for (const o of orders) {
            const name = o.purchaser || '(Unassigned)';
            purchaserMap[name] = (purchaserMap[name] || 0) + 1;
        }
        const byPurchaser = Object.entries(purchaserMap).map(([name, count]) => ({ name, count }));

        // Per-Amazon-account assignment counts (always full day, independent of low-value filter).
        const accountOrders = await Order.find(dayQuery).select('amazonAccount').lean();
        const accountMap = {};
        for (const o of accountOrders) {
            const accountName = o.amazonAccount || '(Unassigned)';
            accountMap[accountName] = (accountMap[accountName] || 0) + 1;
        }

        const accounts = await AmazonAccount.find().select('name').sort({ name: 1 }).lean();
        const byAmazonAccount = accounts.map((acc) => {
            const count = accountMap[acc.name] || 0;
            return {
                name: acc.name,
                count,
                max: MAX_ORDERS_PER_AMAZON_ACCOUNT_PER_DAY,
                remaining: Math.max(0, MAX_ORDERS_PER_AMAZON_ACCOUNT_PER_DAY - count),
                isFull: count >= MAX_ORDERS_PER_AMAZON_ACCOUNT_PER_DAY,
            };
        });

        if (accountMap['(Unassigned)']) {
            byAmazonAccount.push({
                name: '(Unassigned)',
                count: accountMap['(Unassigned)'],
                max: null,
                remaining: null,
                isFull: false,
            });
        }

        // Total added balance across all accounts that day
        const balances = await AmazonAccountDailyBalance.find({ date }).lean();
        const totalAmountAdded = balances.reduce((s, b) => s + (b.addedBalance || 0), 0);

        res.json({
            totalOrders,
            totalUSD,
            totalINR,
            exchangeRate,
            ordersDone,
            ordersNotDone,
            totalAmountAdded,
            byPurchaser,
            byAmazonAccount,
            maxOrdersPerAmazonAccount: MAX_ORDERS_PER_AMAZON_ACCOUNT_PER_DAY,
        });
    } catch (err) {
        console.error('GET /affiliate-orders/summary error:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;

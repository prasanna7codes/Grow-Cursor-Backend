import express from 'express';
import mongoose from 'mongoose';
import PayoneerRecord from '../models/PayoneerRecord.js';
import Transaction from '../models/Transaction.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import {
  payoneerListQuerySchema,
  createPayoneerRecordSchema,
  updatePayoneerRecordSchema,
  idParamsSchema
} from '../schemas/index.js';

const router = express.Router();

// Helper to calculate fields
const calculateFields = (amount, exchangeRate) => {
    const amountNum = parseFloat(amount);
    const rateNum = parseFloat(exchangeRate);

    // Actual Exchange Rate = Rate + (Rate * 0.02)
    const actualExchangeRate = rateNum + (rateNum * 0.02);

    // Bank Deposit = Amount * Exchange Rate (NOT Actual Rate)
    const bankDeposit = amountNum * rateNum;

    return {
        amount: amountNum,
        exchangeRate: rateNum,
        actualExchangeRate: parseFloat(actualExchangeRate.toFixed(4)), // Keep decent precision
        bankDeposit: parseFloat(bankDeposit.toFixed(2)) // Currency usually 2 decimals
    };
};

// GET /api/payoneer - List all records with pagination and filtering
/**
 * @swagger
 * /payoneer:
 *   get:
 *     tags: [Payoneer]
 *     summary: List Payoneer records (paginated)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: store
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated records with totals
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 records:         { type: array, items: { $ref: '#/components/schemas/PayoneerRecord' } }
 *                 totalRecords:    { type: integer }
 *                 totalPages:      { type: integer }
 *                 currentPage:     { type: integer }
 *                 totalAmount:     { type: number }
 *                 totalBankDeposit:{ type: number }
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, requirePageAccess('Payoneer'), validate(payoneerListQuerySchema, 'query'), async (req, res) => {
    try {
        const { page = 1, limit = 50, startDate, endDate, store } = req.query;

        const query = {};

        // Store Filter (cast to ObjectId so aggregation $match works correctly)
        if (store) {
            query.store = new mongoose.Types.ObjectId(store);
        }

        // Date Filter
        // Note: new Date("YYYY-MM-DD") parses as UTC midnight — always use setUTCHours
        // so the end-of-day boundary is also UTC-based, regardless of server timezone.
        if (startDate || endDate) {
            query.paymentDate = {};
            if (startDate) {
                const start = new Date(startDate);
                start.setUTCHours(0, 0, 0, 0);
                query.paymentDate.$gte = start;
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setUTCHours(23, 59, 59, 999);
                query.paymentDate.$lte = end;
            }
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [records, totalRecords, totalsAgg] = await Promise.all([
            PayoneerRecord.find(query)
                .populate({
                    path: 'store',
                    select: 'user',
                    populate: {
                        path: 'user',
                        select: 'username'
                    }
                })
                .populate('bankAccount', 'name')
                .sort({ paymentDate: -1 })
                .skip(skip)
                .limit(parseInt(limit)),
            PayoneerRecord.countDocuments(query),
            PayoneerRecord.aggregate([
                { $match: query },
                {
                    $group: {
                        _id: null,
                        totalAmount: { $sum: '$amount' },
                        totalBankDeposit: { $sum: '$bankDeposit' }
                    }
                }
            ])
        ]);

        const totals = totalsAgg[0] || { totalAmount: 0, totalBankDeposit: 0 };

        res.json({
            records,
            totalRecords,
            totalPages: Math.ceil(totalRecords / parseInt(limit)),
            currentPage: parseInt(page),
            totalAmount: totals.totalAmount,
            totalBankDeposit: totals.totalBankDeposit
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/payoneer - Create new record
/**
 * @swagger
 * /payoneer:
 *   post:
 *     tags: [Payoneer]
 *     summary: Create a Payoneer record (auto-creates a Transaction)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bankAccount, paymentDate, amount, exchangeRate, store]
 *             properties:
 *               bankAccount:  { type: string }
 *               paymentDate:  { type: string, format: date-time }
 *               amount:       { type: number }
 *               exchangeRate: { type: number }
 *               store:        { type: string }
 *               periodStart:  { type: string, format: date-time }
 *               periodEnd:    { type: string, format: date-time }
 *               profit:       { type: number }
 *     responses:
 *       201:
 *         description: Created record with computed actualExchangeRate and bankDeposit
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PayoneerRecord'
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Internal server error
 */
router.post('/', requireAuth, requirePageAccess('Payoneer'), validate(createPayoneerRecordSchema), async (req, res) => {
    try {
        const { bankAccount, paymentDate, amount, exchangeRate, store, periodStart, periodEnd, profit } = req.body;

        const calcs = calculateFields(amount, exchangeRate);

        const newRecord = new PayoneerRecord({
            bankAccount,
            paymentDate,
            store,
            ...calcs,
            ...(periodStart && { periodStart }),
            ...(periodEnd && { periodEnd }),
            ...(profit !== undefined && profit !== '' && { profit: parseFloat(profit) })
        });

        await newRecord.save();

        // Populate return data
        await newRecord.populate([
            {
                path: 'store',
                select: 'user',
                populate: {
                    path: 'user',
                    select: 'username'
                }
            },
            { path: 'bankAccount', select: 'name' }
        ]);

        // --- SYNC WITH TRANSACTION ---
        try {
            await Transaction.create({
                date: newRecord.paymentDate,
                bankAccount: newRecord.bankAccount._id, // Direct ID
                transactionType: 'Credit',
                amount: newRecord.bankDeposit,
                remark: 'Payoneer',
                source: 'PAYONEER',
                sourceId: newRecord._id
            });
        } catch (syncErr) {
            console.error('Failed to sync Payoneer to Transaction:', syncErr);
        }

        res.status(201).json(newRecord);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/payoneer/:id - Update record
/**
 * @swagger
 * /payoneer/{id}:
 *   put:
 *     tags: [Payoneer]
 *     summary: Update a Payoneer record (syncs the linked Transaction)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bankAccount:  { type: string }
 *               paymentDate:  { type: string, format: date-time }
 *               amount:       { type: number }
 *               exchangeRate: { type: number }
 *               store:        { type: string }
 *               periodStart:  { type: string, format: date-time }
 *               periodEnd:    { type: string, format: date-time }
 *               profit:       { type: number }
 *     responses:
 *       200:
 *         description: Updated record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PayoneerRecord'
 *       404:
 *         description: Record not found
 *       500:
 *         description: Internal server error
 */
router.put(
    '/:id',
    requireAuth,
    requirePageAccess('Payoneer'),
    validate(idParamsSchema, 'params'),
    validate(updatePayoneerRecordSchema),
    async (req, res) => {
    try {
        const { id } = req.params;
        const { bankAccount, paymentDate, amount, exchangeRate, store, periodStart, periodEnd, profit } = req.body;

        const record = await PayoneerRecord.findById(id);
        if (!record) return res.status(404).json({ error: 'Record not found' });

        // Update basic fields if provided
        if (bankAccount) record.bankAccount = bankAccount;
        if (paymentDate) record.paymentDate = paymentDate;
        if (store) record.store = store;
        if (periodStart !== undefined) record.periodStart = periodStart || null;
        if (periodEnd !== undefined) record.periodEnd = periodEnd || null;
        if (profit !== undefined) record.profit = profit !== '' ? parseFloat(profit) : null;

        // Recalculate if amount or rate changes
        const newAmount = amount !== undefined ? amount : record.amount;
        const newRate = exchangeRate !== undefined ? exchangeRate : record.exchangeRate;

        const calcs = calculateFields(newAmount, newRate);

        record.amount = calcs.amount;
        record.exchangeRate = calcs.exchangeRate;
        record.actualExchangeRate = calcs.actualExchangeRate;
        record.bankDeposit = calcs.bankDeposit;

        await record.save();

        await record.populate([
            {
                path: 'store',
                select: 'user',
                populate: {
                    path: 'user',
                    select: 'username'
                }
            },
            { path: 'bankAccount', select: 'name' }
        ]);

        // --- SYNC UPDATE TRANSACTION ---
        try {
            await Transaction.findOneAndUpdate(
                { source: 'PAYONEER', sourceId: record._id },
                {
                    date: record.paymentDate,
                    bankAccount: record.bankAccount._id, // Direct ID
                    amount: record.bankDeposit
                },
                { upsert: true }
            );
        } catch (syncErr) {
            console.error('Failed to sync update to Transaction:', syncErr);
        }

        res.json(record);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/payoneer/:id - Delete record
/**
 * @swagger
 * /payoneer/{id}:
 *   delete:
 *     tags: [Payoneer]
 *     summary: Delete a Payoneer record (also deletes the linked Transaction)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Record deleted
 *       500:
 *         description: Internal server error
 */
router.delete('/:id', requireAuth, requirePageAccess('Payoneer'), validate(idParamsSchema, 'params'), async (req, res) => {
    try {
        const { id } = req.params;
        await PayoneerRecord.findByIdAndDelete(id);

        // --- SYNC DELETE TRANSACTION ---
        await Transaction.findOneAndDelete({ source: 'PAYONEER', sourceId: id });

        res.json({ message: 'Record deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

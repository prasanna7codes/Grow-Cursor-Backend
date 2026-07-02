import express from 'express';
import PaymentAccount from '../models/PaymentAccount.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createPaymentAccountSchema } from '../schemas/index.js';

const router = express.Router();

// GET /api/payment-accounts - List all
/**
 * @swagger
 * /payment-accounts:
 *   get:
 *     tags: [Payment Accounts]
 *     summary: List all payment accounts
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sorted array of payment accounts with populated bankAccount.name
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PaymentAccount'
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, requirePageAccess('BankAccounts'), async (req, res) => {
    try {
        const accounts = await PaymentAccount.find()
            .populate('bankAccount', 'name')
            .sort({ name: 1 })
            .lean();
        res.json(accounts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/payment-accounts - Create
/**
 * @swagger
 * /payment-accounts:
 *   post:
 *     tags: [Payment Accounts]
 *     summary: Create a payment account
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, bankAccount]
 *             properties:
 *               name:        { type: string }
 *               bankAccount: { type: string, description: BankAccount ObjectId }
 *     responses:
 *       201:
 *         description: Created account with populated bankAccount
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaymentAccount'
 *       400:
 *         description: Missing fields or duplicate name
 *       500:
 *         description: Internal server error
 */
router.post('/', requireAuth, requirePageAccess('BankAccounts'), validate(createPaymentAccountSchema), async (req, res) => {
    try {
        const { name, bankAccount } = req.body;
        if (!name || !bankAccount) {
            return res.status(400).json({ error: 'Name and Bank Account are required' });
        }
        const newAccount = new PaymentAccount({ name, bankAccount });
        await newAccount.save();
        await newAccount.populate('bankAccount', 'name');
        res.status(201).json(newAccount);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ error: 'Account name must be unique' });
        }
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/payment-accounts/:id - Update
/**
 * @swagger
 * /payment-accounts/{id}:
 *   put:
 *     tags: [Payment Accounts]
 *     summary: Update a payment account
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
 *               name:        { type: string }
 *               bankAccount: { type: string }
 *     responses:
 *       200:
 *         description: Updated account
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaymentAccount'
 *       500:
 *         description: Internal server error
 */
router.put('/:id', requireAuth, requirePageAccess('BankAccounts'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, bankAccount } = req.body;
        const account = await PaymentAccount.findByIdAndUpdate(
            id,
            { name, bankAccount },
            { new: true }
        ).populate('bankAccount', 'name');
        res.json(account);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/payment-accounts/:id - Delete
/**
 * @swagger
 * /payment-accounts/{id}:
 *   delete:
 *     tags: [Payment Accounts]
 *     summary: Delete a payment account
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deleted successfully
 *       500:
 *         description: Internal server error
 */
router.delete('/:id', requireAuth, requirePageAccess('BankAccounts'), async (req, res) => {
    try {
        const { id } = req.params;
        await PaymentAccount.findByIdAndDelete(id);
        res.json({ message: 'Deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

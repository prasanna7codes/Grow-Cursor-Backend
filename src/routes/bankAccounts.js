import express from 'express';
import BankAccount from '../models/BankAccount.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createBankAccountSchema } from '../schemas/index.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: BankAccounts
 *   description: Bank account reference data
 */

/**
 * @swagger
 * /bank-accounts:
 *   get:
 *     tags: [BankAccounts]
 *     summary: List all bank accounts
 *     security:
 *       - bearerAuth: []
 *     description: Accessible from BankAccounts, Transactions, and Payoneer pages.
 *     responses:
 *       200: { description: Array of bank account records sorted by name }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/', requireAuth, requirePageAccess(['BankAccounts', 'Transactions','Payoneer']), async (req, res) => {
    try {
        const accounts = await BankAccount.find().sort({ name: 1 }).lean();
        res.json(accounts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/bank-accounts - Create
/**
 * @swagger
 * /bank-accounts:
 *   post:
 *     tags: [BankAccounts]
 *     summary: Create a bank account
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               accountNumber: { type: string }
 *               bankName: { type: string }
 *               currency: { type: string }
 *     responses:
 *       201: { description: Created bank account }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.post('/', requireAuth, requirePageAccess('BankAccounts'), validate(createBankAccountSchema), async (req, res) => {
    try {
        const { name, accountNumber, ifscCode } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        const newAccount = new BankAccount({ name, accountNumber, ifscCode });
        await newAccount.save();
        res.status(201).json(newAccount);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ error: 'Account name must be unique' });
        }
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/bank-accounts/:id - Update
/**
 * @swagger
 * /bank-accounts/{id}:
 *   put:
 *     tags: [BankAccounts]
 *     summary: Update a bank account
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Updated bank account }
 *       404: { description: Bank account not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.put('/:id', requireAuth, requirePageAccess('BankAccounts'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, accountNumber, ifscCode } = req.body;
        const account = await BankAccount.findByIdAndUpdate(
            id,
            { name, accountNumber, ifscCode },
            { new: true }
        );
        res.json(account);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/bank-accounts/:id - Delete
/**
 * @swagger
 * /bank-accounts/{id}:
 *   delete:
 *     tags: [BankAccounts]
 *     summary: Delete a bank account
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deletion confirmation }
 *       404: { description: Bank account not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.delete('/:id', requireAuth, requirePageAccess('BankAccounts'), async (req, res) => {
    try {
        const { id } = req.params;
        await BankAccount.findByIdAndDelete(id);
        res.json({ message: 'Deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

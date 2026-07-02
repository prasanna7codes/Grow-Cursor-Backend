import express from 'express';
import ExtraExpense from '../models/ExtraExpense.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createExtraExpenseSchema } from '../schemas/index.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: ExtraExpenses
 *   description: Miscellaneous expense records
 */

/**
 * @swagger
 * /extra-expenses:
 *   get:
 *     tags: [ExtraExpenses]
 *     summary: List all extra expenses
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Array of expense records sorted by date descending }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/', requireAuth, requirePageAccess('ExtraExpenses'), async (req, res) => {
    try {
        const expenses = await ExtraExpense.find().sort({ date: -1 }).lean();
        res.json(expenses);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/extra-expenses - Create
/**
 * @swagger
 * /extra-expenses:
 *   post:
 *     tags: [ExtraExpenses]
 *     summary: Create an extra expense record
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description, amount, date]
 *             properties:
 *               description: { type: string }
 *               amount: { type: number }
 *               date: { type: string, format: date }
 *               category: { type: string }
 *               paidTo: { type: string }
 *     responses:
 *       201: { description: Created expense }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.post('/', requireAuth, requirePageAccess('ExtraExpenses'), validate(createExtraExpenseSchema), async (req, res) => {
    try {
        const { date, name, amount, paidBy } = req.body;

        if (!date || !name || !amount || !paidBy) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const expense = new ExtraExpense({ date, name, amount, paidBy });
        await expense.save();
        res.status(201).json(expense);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/extra-expenses/:id - Update
/**
 * @swagger
 * /extra-expenses/{id}:
 *   put:
 *     tags: [ExtraExpenses]
 *     summary: Update an extra expense
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Updated expense }
 *       404: { description: Expense not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.put('/:id', requireAuth, requirePageAccess('ExtraExpenses'), async (req, res) => {
    try {
        const { id } = req.params;
        const { date, name, amount, paidBy } = req.body;

        const expense = await ExtraExpense.findById(id);
        if (!expense) return res.status(404).json({ error: 'Expense not found' });

        if (date) expense.date = date;
        if (name) expense.name = name;
        if (amount !== undefined) expense.amount = amount;
        if (paidBy) expense.paidBy = paidBy;

        await expense.save();
        res.json(expense);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/extra-expenses/:id - Delete
/**
 * @swagger
 * /extra-expenses/{id}:
 *   delete:
 *     tags: [ExtraExpenses]
 *     summary: Delete an extra expense
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deletion confirmation }
 *       404: { description: Expense not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.delete('/:id', requireAuth, requirePageAccess('ExtraExpenses'), async (req, res) => {
    try {
        const { id } = req.params;
        const expense = await ExtraExpense.findById(id);
        if (!expense) return res.status(404).json({ error: 'Expense not found' });

        await ExtraExpense.findByIdAndDelete(id);
        res.json({ message: 'Expense deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

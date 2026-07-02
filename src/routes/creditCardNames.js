import express from 'express';
import CreditCardName from '../models/CreditCardName.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { creditCardNameSchema } from '../schemas/index.js';

const router = express.Router();

/**
 * @swagger
 * /credit-card-names:
 *   get:
 *     tags: [Credit Card Names]
 *     summary: List all credit card names
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sorted array of credit card names
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/CreditCardName'
 *       500:
 *         description: Internal server error
 */
// Get all credit card names
router.get('/', requireAuth, async (req, res) => {
    try {
        const cards = await CreditCardName.find().sort({ name: 1 }).lean();
        res.json(cards);
    } catch (error) {
        console.error('Error fetching credit card names:', error);
        res.status(500).json({ error: 'Failed to fetch credit card names' });
    }
});

/**
 * @swagger
 * /credit-card-names:
 *   post:
 *     tags: [Credit Card Names]
 *     summary: Create a new credit card name
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
 *               name:
 *                 type: string
 *     responses:
 *       201:
 *         description: Created credit card name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CreditCardName'
 *       400:
 *         description: Missing name or duplicate
 *       500:
 *         description: Internal server error
 */
// Create a new credit card name
router.post('/', requireAuth, requirePageAccess('CreditCardNames'), validate(creditCardNameSchema), async (req, res) => {
    try {
        const { name } = req.body;

        const card = new CreditCardName({ name });
        await card.save();
        res.status(201).json(card);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ error: 'A credit card with this name already exists' });
        }
        console.error('Error creating credit card name:', error);
        res.status(500).json({ error: 'Failed to create credit card name' });
    }
});

/**
 * @swagger
 * /credit-card-names/{id}:
 *   delete:
 *     tags: [Credit Card Names]
 *     summary: Delete a credit card name
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Deleted successfully
 *       404:
 *         description: Credit card name not found
 *       500:
 *         description: Internal server error
 */
// Delete a credit card name
router.delete('/:id', requireAuth, requirePageAccess('CreditCardNames'), async (req, res) => {
    try {
        const card = await CreditCardName.findByIdAndDelete(req.params.id);
        if (!card) {
            return res.status(404).json({ error: 'Credit card name not found' });
        }
        res.json({ message: 'Credit card name deleted successfully' });
    } catch (error) {
        console.error('Error deleting credit card name:', error);
        res.status(500).json({ error: 'Failed to delete credit card name' });
    }
});

export default router;

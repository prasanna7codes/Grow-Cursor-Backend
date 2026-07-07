import express from 'express';
import CreditCard from '../models/CreditCard.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createCreditCardSchema } from '../schemas/index.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: CreditCards
 *   description: Credit card reference data
 */

/**
 * @swagger
 * /credit-cards:
 *   get:
 *     tags: [CreditCards]
 *     summary: List all credit cards
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Array of credit card records sorted by name }
 *       401: { description: Unauthorized }
 */
// Get all credit cards
router.get('/', requireAuth, async (req, res) => {
  try {
    const cards = await CreditCard.find().sort({ name: 1 }).lean();
    res.json(cards);
  } catch (error) {
    console.error('Error fetching credit cards:', error);
    res.status(500).json({ error: 'Failed to fetch credit cards' });
  }
});

// Create a new credit card
/**
 * @swagger
 * /credit-cards:
 *   post:
 *     tags: [CreditCards]
 *     summary: Create a credit card record
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
 *               lastFourDigits: { type: string }
 *               bankName: { type: string }
 *               currency: { type: string }
 *     responses:
 *       201: { description: Created credit card }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.post('/', requireAuth, requirePageAccess('CreditCards'), validate(createCreditCardSchema), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Card name is required' });
    }

    const card = new CreditCard({ name: name.trim() });
    await card.save();
    res.status(201).json(card);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'A credit card with this name already exists' });
    }
    console.error('Error creating credit card:', error);
    res.status(500).json({ error: 'Failed to create credit card' });
  }
});

// Delete a credit card
/**
 * @swagger
 * /credit-cards/{id}:
 *   delete:
 *     tags: [CreditCards]
 *     summary: Delete a credit card record
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deletion confirmation }
 *       404: { description: Credit card not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.delete('/:id', requireAuth, requirePageAccess('CreditCards'), async (req, res) => {
  try {
    const card = await CreditCard.findByIdAndDelete(req.params.id);
    if (!card) {
      return res.status(404).json({ error: 'Credit card not found' });
    }
    res.json({ message: 'Credit card deleted successfully' });
  } catch (error) {
    console.error('Error deleting credit card:', error);
    res.status(500).json({ error: 'Failed to delete credit card' });
  }
});

export default router;

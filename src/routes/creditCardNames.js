import express from 'express';
import CreditCardName from '../models/CreditCardName.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Get all credit card names
router.get('/', requireAuth, requireRole('superadmin'), async (req, res) => {
    try {
        const cards = await CreditCardName.find().sort({ name: 1 });
        res.json(cards);
    } catch (error) {
        console.error('Error fetching credit card names:', error);
        res.status(500).json({ error: 'Failed to fetch credit card names' });
    }
});

// Create a new credit card name
router.post('/', requireAuth, requireRole('superadmin', 'hoc', 'compliance_manager', 'fulfillment_admin'), async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Card name is required' });
        }

        const card = new CreditCardName({ name: name.trim() });
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

// Delete a credit card name
router.delete('/:id', requireAuth, requireRole('superadmin', 'hoc', 'compliance_manager', 'fulfillment_admin'), async (req, res) => {
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

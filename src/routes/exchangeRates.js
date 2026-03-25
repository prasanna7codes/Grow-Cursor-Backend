import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import ExchangeRate from '../models/ExchangeRate.js';

const router = express.Router();

// Get current exchange rate
router.get('/current', requireAuth, async (req, res) => {
  try {
    const { marketplace = 'EBAY' } = req.query;
    
    const currentRate = await ExchangeRate.findOne({ marketplace })
      .sort({ effectiveDate: -1 })
      .limit(1);
    
    if (!currentRate) {
      return res.json({ rate: 82, effectiveDate: new Date(), marketplace }); // Default
    }
    
    res.json(currentRate);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get rate history
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { marketplace = 'EBAY', limit = 50 } = req.query;
    
    const history = await ExchangeRate.find({ marketplace })
      .sort({ effectiveDate: -1 })
      .limit(parseInt(limit));
    
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get rate for a specific date
router.get('/for-date', requireAuth, async (req, res) => {
  try {
    const { date, marketplace = 'EBAY' } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }
    
    const targetDate = new Date(date);
    
    // Find the most recent rate that was effective on or before the target date
    const rate = await ExchangeRate.findOne({
      marketplace,
      effectiveDate: { $lte: targetDate }
    })
      .sort({ effectiveDate: -1 })
      .limit(1);
    
    if (!rate) {
      return res.json({ rate: 82, effectiveDate: targetDate, marketplace }); // Default
    }
    
    res.json(rate);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set new exchange rate
router.post('/', requireAuth, requireRole('superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { rate, effectiveDate, marketplace = 'EBAY', notes } = req.body;
    
    if (!rate || !effectiveDate) {
      return res.status(400).json({ error: 'Rate and effectiveDate are required' });
    }
    
    // Check if a rate already exists for this exact date and marketplace
    const existing = await ExchangeRate.findOne({
      effectiveDate: new Date(effectiveDate),
      marketplace
    });
    
    if (existing) {
      // Update existing rate
      existing.rate = rate;
      existing.notes = notes;
      existing.createdBy = req.user?.username || 'system';
      await existing.save();
      return res.json({ message: 'Rate updated', rate: existing });
    }
    
    // Create new rate entry
    const newRate = new ExchangeRate({
      rate,
      effectiveDate: new Date(effectiveDate),
      marketplace,
      notes,
      createdBy: req.user?.username || 'system'
    });
    
    await newRate.save();
    res.json({ message: 'Rate created', rate: newRate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete exchange rate entry
router.delete('/:id', requireAuth, requireRole('superadmin', 'fulfillmentadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const rate = await ExchangeRate.findByIdAndDelete(id);
    
    if (!rate) {
      return res.status(404).json({ error: 'Rate not found' });
    }
    
    res.json({ message: 'Rate deleted', rate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import ExchangeRate from '../models/ExchangeRate.js';
import Order from '../models/Order.js';
import {
  calculateOrderAmazonFinancials,
  calculateOrderEbayFinancials,
  clearExchangeRateRecordCache,
  getCurrentExchangeRateRecord,
  getExchangeRateDefaultValue,
  getExchangeRateRecordForDate,
  getPacificDayBounds,
  getPurchaseMarketplaceQueryForRateMarketplace,
  isAmazonRateMarketplace
} from '../utils/exchangeRateUtils.js';
import { validate } from '../utils/validate.js';
import {
  exchangeRateCurrentQuerySchema,
  exchangeRateHistoryQuerySchema,
  exchangeRateForDateQuerySchema,
  createExchangeRateSchema,
  idParamsSchema
} from '../schemas/index.js';

const router = express.Router();

// Get current exchange rate
/**
 * @swagger
 * /exchange-rates/current:
 *   get:
 *     tags: [Exchange Rates]
 *     summary: Get the current exchange rate for a marketplace
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: marketplace
 *         schema: { type: string, default: EBAY_US }
 *     responses:
 *       200:
 *         description: Current exchange rate record (or default if none set)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ExchangeRate'
 *       500:
 *         description: Internal server error
 */
router.get('/current', requireAuth, validate(exchangeRateCurrentQuerySchema, 'query'), async (req, res) => {
  try {
    const { marketplace = 'EBAY_US' } = req.query;
    const currentRate = await getCurrentExchangeRateRecord(marketplace);
    
    if (!currentRate) {
      return res.json({
        rate: getExchangeRateDefaultValue(marketplace),
        effectiveDate: new Date(),
        marketplace,
        applicationMode: 'effective'
      });
    }
    
    res.json(currentRate);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get rate history
/**
 * @swagger
 * /exchange-rates/history:
 *   get:
 *     tags: [Exchange Rates]
 *     summary: Get exchange rate history for a marketplace
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: marketplace
 *         schema: { type: string, default: EBAY_US }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Array of exchange rate records sorted newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ExchangeRate'
 *       500:
 *         description: Internal server error
 */
router.get('/history', requireAuth, validate(exchangeRateHistoryQuerySchema, 'query'), async (req, res) => {
  try {
    const { marketplace = 'EBAY_US', limit = 50 } = req.query;

    const history = await ExchangeRate.find({ marketplace })
      .sort({ effectiveDate: -1 })
      .limit(limit)
      .lean();
    
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get rate for a specific date
/**
 * @swagger
 * /exchange-rates/for-date:
 *   get:
 *     tags: [Exchange Rates]
 *     summary: Get the exchange rate effective on a specific date
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date
 *         required: true
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: marketplace
 *         schema: { type: string, default: EBAY_US }
 *     responses:
 *       200:
 *         description: Exchange rate for that date (or default fallback)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ExchangeRate'
 *       400:
 *         description: Date parameter is required
 *       500:
 *         description: Internal server error
 */
router.get('/for-date', requireAuth, validate(exchangeRateForDateQuerySchema, 'query'), async (req, res) => {
  try {
    const { date, marketplace = 'EBAY_US' } = req.query;

    const rate = await getExchangeRateRecordForDate(date, marketplace);
    
    if (!rate) {
      return res.json({
        rate: getExchangeRateDefaultValue(marketplace),
        effectiveDate: new Date(date),
        marketplace,
        applicationMode: 'effective'
      });
    }
    
    res.json(rate);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set new exchange rate
/**
 * @swagger
 * /exchange-rates:
 *   post:
 *     tags: [Exchange Rates]
 *     summary: Set or update an exchange rate (optionally back-fills orders)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rate, effectiveDate]
 *             properties:
 *               rate:                 { type: number }
 *               effectiveDate:        { type: string, format: date-time }
 *               marketplace:          { type: string, default: EBAY_US }
 *               notes:                { type: string }
 *               applicationMode:      { type: string, enum: ['effective','specific-date'], default: 'effective' }
 *               updateExistingOrders: { type: boolean, default: true }
 *     responses:
 *       200:
 *         description: Rate created/updated with count of orders recalculated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:           { type: string }
 *                 rate:              { $ref: '#/components/schemas/ExchangeRate' }
 *                 updatedOrders:     { type: integer }
 *                 persistedToDatabase: { type: boolean }
 *       400:
 *         description: Missing rate/effectiveDate or invalid applicationMode
 *       500:
 *         description: Internal server error
 */
router.post('/', requireAuth, validate(createExchangeRateSchema), async (req, res) => {
  try {
    const {
      rate,
      effectiveDate,
      marketplace = 'EBAY_US',
      notes,
      applicationMode = 'effective',
      updateExistingOrders = true
    } = req.body;

    const parsedEffectiveDate = new Date(effectiveDate);
    const normalizedEffectiveDate = applicationMode === 'specific-date'
      ? getPacificDayBounds(parsedEffectiveDate).start
      : parsedEffectiveDate;

    let existing;
    if (applicationMode === 'specific-date') {
      const { start, end } = getPacificDayBounds(normalizedEffectiveDate);
      existing = await ExchangeRate.findOne({
        marketplace,
        applicationMode,
        effectiveDate: { $gte: start, $lte: end }
      });
    } else {
      existing = await ExchangeRate.findOne({
        marketplace,
        applicationMode,
        effectiveDate: parsedEffectiveDate
      });
    }

    const wasExisting = Boolean(existing);
    
    if (existing) {
      existing.rate = rate;
      existing.notes = notes;
      existing.applicationMode = applicationMode;
      existing.effectiveDate = normalizedEffectiveDate;
      existing.createdBy = req.user?.username || 'system';
      await existing.save();
    } else {
      existing = new ExchangeRate({
        rate,
        effectiveDate: normalizedEffectiveDate,
        marketplace,
        applicationMode,
        notes,
        createdBy: req.user?.username || 'system'
      });

      await existing.save();
    }

    clearExchangeRateRecordCache(marketplace);

    const persistedRate = await ExchangeRate.findById(existing._id).lean();
    if (!persistedRate) {
      throw new Error('Exchange rate was not persisted to database');
    }

    let updatedOrders = 0;

    if (updateExistingOrders) {
      const orderDateExpression = { $ifNull: ['$dateSold', '$creationDate'] };
      const orderQuery = {
        purchaseMarketplaceId: getPurchaseMarketplaceQueryForRateMarketplace(marketplace)
      };

      if (applicationMode === 'specific-date') {
        const { start, end } = getPacificDayBounds(normalizedEffectiveDate);
        orderQuery.$expr = {
          $and: [
            { $gte: [orderDateExpression, start] },
            { $lte: [orderDateExpression, end] }
          ]
        };
      } else {
        orderQuery.$expr = {
          $gte: [orderDateExpression, normalizedEffectiveDate]
        };
      }

      const cursor = Order.find(orderQuery).cursor();

      for (let order = await cursor.next(); order != null; order = await cursor.next()) {
        if (isAmazonRateMarketplace(marketplace)) {
          Object.assign(order, await calculateOrderAmazonFinancials(order, rate));
        } else {
          Object.assign(order, await calculateOrderEbayFinancials(order, rate));
        }

        await order.save();
        updatedOrders += 1;
      }
    }

    res.json({
      message: wasExisting ? 'Rate updated' : 'Rate created',
      rate: persistedRate,
      updatedOrders,
      persistedToDatabase: true
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete exchange rate entry
/**
 * @swagger
 * /exchange-rates/{id}:
 *   delete:
 *     tags: [Exchange Rates]
 *     summary: Delete an exchange rate entry
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Rate deleted
 *       404:
 *         description: Rate not found
 *       500:
 *         description: Internal server error
 */
router.delete('/:id', requireAuth, validate(idParamsSchema, 'params'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const rate = await ExchangeRate.findByIdAndDelete(id);
    
    if (!rate) {
      return res.status(404).json({ error: 'Rate not found' });
    }

    clearExchangeRateRecordCache(rate.marketplace);
    
    res.json({ message: 'Rate deleted', rate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

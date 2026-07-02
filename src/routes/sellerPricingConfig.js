import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import SellerPricingConfig from '../models/SellerPricingConfig.js';
import ListingTemplate from '../models/ListingTemplate.js';
import { validateProfitTiers } from '../utils/pricingCalculator.js';
import { validate } from '../utils/validate.js';
import { sellerPricingConfigQuerySchema, sellerPricingConfigBodySchema } from '../schemas/index.js';

const router = express.Router();

/**
 * @swagger
 * /seller-pricing-config:
 *   get:
 *     tags: [Seller Pricing Config]
 *     summary: Get pricing config for a seller+template pair
 *     description: Returns the seller-specific override if one exists, otherwise falls back to the template's default config.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: templateId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Pricing config with isCustom flag
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pricingConfig:
 *                   type: object
 *                   description: "Config fields: enabled, spentRate, payoutRate, desiredProfit, fixedFee, saleTax, ebayFee, adsFee, tdsFee, shippingCost, taxRate, profitTiers"
 *                 isCustom:
 *                   type: boolean
 *                   description: true if a seller-specific override exists
 *       400:
 *         description: Missing sellerId or templateId
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, validate(sellerPricingConfigQuerySchema, 'query'), async (req, res) => {
  try {
    const { sellerId, templateId } = req.query;

    // Try to find seller-specific config
    const sellerConfig = await SellerPricingConfig.findOne({ 
      sellerId, 
      templateId 
    });

    if (sellerConfig) {
      return res.json({
        pricingConfig: sellerConfig.pricingConfig,
        isCustom: true
      });
    }

    // Fallback to template's default config
    const template = await ListingTemplate.findById(templateId);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json({
      pricingConfig: template.pricingConfig || {
        enabled: false,
        spentRate: null,
        payoutRate: null,
        desiredProfit: null,
        fixedFee: 0,
        saleTax: 0,
        ebayFee: 12.9,
        adsFee: 3,
        tdsFee: 1,
        shippingCost: 0,
        taxRate: 10
      },
      isCustom: false
    });
  } catch (error) {
    console.error('Error fetching pricing config:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /seller-pricing-config:
 *   post:
 *     tags: [Seller Pricing Config]
 *     summary: Create or update a seller pricing config (upsert)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sellerId, templateId, pricingConfig]
 *             properties:
 *               sellerId:
 *                 type: string
 *               templateId:
 *                 type: string
 *               pricingConfig:
 *                 type: object
 *                 description: Pricing config object (spentRate, payoutRate, desiredProfit, fees, profitTiers, etc.)
 *     responses:
 *       200:
 *         description: Upserted config
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 config:
 *                   type: object
 *       400:
 *         description: Bad request or invalid profit tiers
 *       500:
 *         description: Internal server error
 */
// Create or update pricing config for seller+template
router.post('/', requireAuth, validate(sellerPricingConfigBodySchema), async (req, res) => {
  try {
    const { sellerId, templateId, pricingConfig } = req.body;

    // Validate profit tiers if enabled
    if (pricingConfig.profitTiers?.enabled) {
      try {
        validateProfitTiers(pricingConfig.profitTiers.tiers);
      } catch (validationError) {
        return res.status(400).json({ 
          error: `Invalid profit tiers: ${validationError.message}` 
        });
      }
    }

    // Upsert: create if not exists, update if exists
    const config = await SellerPricingConfig.findOneAndUpdate(
      { sellerId, templateId },
      { 
        pricingConfig,
        createdBy: req.user.userId
      },
      { 
        upsert: true, 
        new: true,
        runValidators: true
      }
    );

    res.json({
      success: true,
      config
    });
  } catch (error) {
    console.error('Error saving pricing config:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /seller-pricing-config:
 *   delete:
 *     tags: [Seller Pricing Config]
 *     summary: Delete a seller pricing config (revert to template default)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: templateId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Config deleted, reverted to template default
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing sellerId or templateId
 *       500:
 *         description: Internal server error
 */
// Delete pricing config (revert to template default)
router.delete('/', requireAuth, validate(sellerPricingConfigQuerySchema, 'query'), async (req, res) => {
  try {
    const { sellerId, templateId } = req.query;

    await SellerPricingConfig.findOneAndDelete({
      sellerId, 
      templateId 
    });

    res.json({
      success: true,
      message: 'Pricing config deleted, reverted to template default'
    });
  } catch (error) {
    console.error('Error deleting pricing config:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

import express from 'express';
import AsinListProduct from '../models/AsinListProduct.js';
import AsinDirectory from '../models/AsinDirectory.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { normalizeSearchQueries } from '../utils/searchQueries.js';
import {
  createAsinListProductSchema,
  renameAsinListProductSchema,
  moveAsinsSchema,
  copyProductsToRangeSchema,
} from '../schemas/index.js';

const router = express.Router();

// Get all products under a range (or all products when ?all=true)
/**
 * @swagger
 * /asin-list-products:
 *   get:
 *     tags: [ASIN List Products]
 *     summary: List products for a range, or all products
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: rangeId
 *         schema: { type: string }
 *         description: Required unless all=true
 *       - in: query
 *         name: all
 *         schema: { type: boolean }
 *         description: Return all products across all ranges
 *     responses:
 *       200:
 *         description: Array of product documents
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AsinListProduct'
 *       400:
 *         description: rangeId is required (when all is not true)
 *       500:
 *         description: Internal server error
 *   post:
 *     tags: [ASIN List Products]
 *     summary: Create a new product under a range
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, rangeId, categoryId]
 *             properties:
 *               name:       { type: string }
 *               rangeId:    { type: string }
 *               categoryId: { type: string }
 *     responses:
 *       201:
 *         description: Created product
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AsinListProduct'
 *       400:
 *         description: Validation error
 *       409:
 *         description: Product already exists in this range
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rangeId, all } = req.query;

    if (all === 'true') {
      const products = await AsinListProduct.find({}).sort({ name: 1 }).lean();
      return res.json(products);
    }

    if (!rangeId) {
      return res.status(400).json({ error: 'rangeId query param is required' });
    }

    const products = await AsinListProduct.find({ rangeId }).sort({ name: 1 }).lean();
    res.json(products);
  } catch (error) {
    console.error('Error fetching asin list products:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Create a new product under a range
router.post('/', requireAuth, validate(createAsinListProductSchema), async (req, res) => {
  try {
    const { name, rangeId, categoryId, searchQueries } = req.body;

    const product = await AsinListProduct.create({
      name,
      rangeId,
      categoryId,
      searchQueries: normalizeSearchQueries(searchQueries)
    });
    res.status(201).json(product);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Product already exists in this range' });
    }
    console.error('Error creating asin list product:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Move selected ASINs to a product list
/**
 * @swagger
 * /asin-list-products/move:
 *   post:
 *     tags: [ASIN List Products]
 *     summary: Move selected ASINs into a product list
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [asinIds, productId]
 *             properties:
 *               asinIds:   { type: array, items: { type: string } }
 *               productId: { type: string }
 *     responses:
 *       200:
 *         description: Move result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 movedCount:  { type: integer }
 *                 productId:   { type: string }
 *                 productName: { type: string }
 *       400:
 *         description: Missing asinIds or productId
 *       404:
 *         description: Product not found
 *       500:
 *         description: Internal server error
 */
router.post('/move', requireAuth, validate(moveAsinsSchema), async (req, res) => {
  try {
    const { asinIds, productId } = req.body;

    // Verify product exists
    const product = await AsinListProduct.findById(productId).lean();
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const result = await AsinDirectory.updateMany(
      { _id: { $in: asinIds } },
      { listProductId: productId, movedAt: new Date() }
    );

    console.log(`✅ Moved ${result.modifiedCount} ASINs to product ${product.name} (${productId})`);

    res.json({
      movedCount: result.modifiedCount,
      productId,
      productName: product.name
    });
  } catch (error) {
    console.error('Error moving ASINs to product list:', error);
    res.status(500).json({ error: 'Failed to move ASINs' });
  }
});

// Rename a product
/**
 * @swagger
 * /asin-list-products/{id}:
 *   put:
 *     tags: [ASIN List Products]
 *     summary: Rename a product
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *     responses:
 *       200:
 *         description: Updated product
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AsinListProduct'
 *       400:
 *         description: Name is required
 *       404:
 *         description: Product not found
 *       409:
 *         description: Duplicate name in this range
 *       500:
 *         description: Internal server error
 *   delete:
 *     tags: [ASIN List Products]
 *     summary: Delete a product and unassign its ASINs
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deletion confirmed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *       500:
 *         description: Internal server error
 */
router.put('/:id', requireAuth, validate(renameAsinListProductSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, searchQueries } = req.body;

    // Only touch what was actually sent — a keyword edit must not blank the
    // name, and a rename must not blank the keywords.
    const update = {};
    if (name !== undefined) update.name = name;
    if (searchQueries !== undefined) update.searchQueries = normalizeSearchQueries(searchQueries);

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const updated = await AsinListProduct.findByIdAndUpdate(
      id,
      update,
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ error: 'Product not found' });
    res.json(updated);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A product with that name already exists in this range' });
    }
    console.error('Error renaming product:', error);
    res.status(500).json({ error: 'Failed to rename product' });
  }
});

// Copy selected products (by id) into a target range
/**
 * @swagger
 * /asin-list-products/copy-to-range:
 *   post:
 *     tags: [ASIN List Products]
 *     summary: Copy products into one or more target ranges
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productIds]
 *             properties:
 *               productIds:    { type: array, items: { type: string } }
 *               targetRangeId:
 *                 type: string
 *                 description: Single target range (legacy)
 *               targetRangeIds:
 *                 type: array
 *                 items: { type: string }
 *                 description: Multiple target ranges
 *     responses:
 *       200:
 *         description: Copy results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 copied:          { type: integer }
 *                 skipped:         { type: integer }
 *                 skippedNames:    { type: array, items: { type: string } }
 *                 rangesProcessed: { type: integer }
 *       400:
 *         description: Missing productIds or target range
 *       500:
 *         description: Internal server error
 */
router.post('/copy-to-range', requireAuth, validate(copyProductsToRangeSchema), async (req, res) => {
  try {
    const { productIds, targetRangeId, targetRangeIds } = req.body;

    // Support both singular (legacy) and plural form
    const rangeIds = targetRangeIds && targetRangeIds.length > 0
      ? targetRangeIds
      : targetRangeId ? [targetRangeId] : [];
    if (rangeIds.length === 0) {
      return res.status(400).json({ error: 'targetRangeId or targetRangeIds is required' });
    }

    const AsinListRange = (await import('../models/AsinListRange.js')).default;
    const sourceProducts = await AsinListProduct.find({ _id: { $in: productIds } }).lean();

    let copied = 0;
    const skippedNames = [];

    for (const rangeId of rangeIds) {
      const targetRange = await AsinListRange.findById(rangeId).lean();
      if (!targetRange) continue;

      for (const src of sourceProducts) {
        try {
          await AsinListProduct.create({
            name: src.name,
            rangeId,
            categoryId: targetRange.categoryId
          });
          copied++;
        } catch (err) {
          if (err.code === 11000) {
            skippedNames.push(src.name);
          } else {
            throw err;
          }
        }
      }
    }

    res.json({ copied, skipped: skippedNames.length, skippedNames, rangesProcessed: rangeIds.length });
  } catch (error) {
    console.error('Error copying products to range:', error);
    res.status(500).json({ error: 'Failed to copy products' });
  }
});

// Delete a product and orphan its assigned ASINs
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    await AsinDirectory.updateMany(
      { listProductId: id },
      { $unset: { listProductId: '' } }
    );

    await AsinListProduct.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting asin list product:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

export default router;

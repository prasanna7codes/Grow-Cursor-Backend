import express from 'express';
import AsinListRange from '../models/AsinListRange.js';
import AsinListProduct from '../models/AsinListProduct.js';
import AsinDirectory from '../models/AsinDirectory.js';
import AsinListCategory from '../models/AsinListCategory.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { normalizeSearchQueries } from '../utils/searchQueries.js';
import { createAsinListRangeSchema, renameAsinListRangeSchema } from '../schemas/index.js';

const router = express.Router();

// Get ranges — filtered by categoryId, or all ranges when ?all=true
/**
 * @swagger
 * /asin-list-ranges:
 *   get:
 *     tags: [ASIN List Ranges]
 *     summary: List ranges for a category, or all ranges
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: categoryId
 *         schema: { type: string }
 *         description: Required unless all=true
 *       - in: query
 *         name: all
 *         schema: { type: boolean }
 *         description: Return all ranges across all categories with categoryName attached
 *     responses:
 *       200:
 *         description: Array of range documents
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AsinListRange'
 *       400:
 *         description: categoryId is required (when all is not true)
 *       500:
 *         description: Internal server error
 *   post:
 *     tags: [ASIN List Ranges]
 *     summary: Create a new range under a category
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, categoryId]
 *             properties:
 *               name:       { type: string }
 *               categoryId: { type: string }
 *     responses:
 *       201:
 *         description: Created range
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AsinListRange'
 *       400:
 *         description: Validation error
 *       409:
 *         description: Range already exists in this category
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { categoryId, all } = req.query;

    if (all === 'true') {
      // Return all ranges across all categories, with categoryName attached
      const [ranges, categories] = await Promise.all([
        AsinListRange.find({}).sort({ name: 1 }).lean(),
        AsinListCategory.find({}, '_id name').lean()
      ]);
      const catMap = Object.fromEntries(categories.map(c => [c._id.toString(), c.name]));
      const enriched = ranges.map(r => ({
        ...r,
        categoryName: catMap[r.categoryId?.toString()] || ''
      }));
      return res.json(enriched);
    }

    if (!categoryId) {
      return res.status(400).json({ error: 'categoryId query param is required' });
    }

    const ranges = await AsinListRange.find({ categoryId }).sort({ name: 1 }).lean();
    res.json(ranges);
  } catch (error) {
    console.error('Error fetching asin list ranges:', error);
    res.status(500).json({ error: 'Failed to fetch ranges' });
  }
});

// Create a new range under a category
router.post('/', requireAuth, validate(createAsinListRangeSchema), async (req, res) => {
  try {
    const { name, categoryId, searchQueries } = req.body;

    const range = await AsinListRange.create({
      name,
      categoryId,
      searchQueries: normalizeSearchQueries(searchQueries)
    });
    res.status(201).json(range);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Range already exists in this category' });
    }
    console.error('Error creating asin list range:', error);
    res.status(500).json({ error: 'Failed to create range' });
  }
});

// Rename a range
/**
 * @swagger
 * /asin-list-ranges/{id}:
 *   put:
 *     tags: [ASIN List Ranges]
 *     summary: Rename a range
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
 *         description: Updated range
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AsinListRange'
 *       400:
 *         description: Name is required
 *       404:
 *         description: Range not found
 *       409:
 *         description: Duplicate name in this category
 *       500:
 *         description: Internal server error
 *   delete:
 *     tags: [ASIN List Ranges]
 *     summary: Delete a range and cascade-delete its products; unassigns associated ASINs
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
router.put('/:id', requireAuth, validate(renameAsinListRangeSchema), async (req, res) => {
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

    const range = await AsinListRange.findByIdAndUpdate(
      id,
      update,
      { new: true, runValidators: true }
    );
    if (!range) return res.status(404).json({ error: 'Range not found' });
    res.json(range);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Range already exists in this category' });
    }
    console.error('Error renaming asin list range:', error);
    res.status(500).json({ error: 'Failed to rename range' });
  }
});

// Shallow duplicate a range (same category, no products copied)
/**
 * @swagger
 * /asin-list-ranges/duplicate:
 *   post:
 *     tags: [ASIN List Ranges]
 *     summary: Shallow-duplicate a range into the same category (no products copied)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sourceRangeId, name]
 *             properties:
 *               sourceRangeId: { type: string }
 *               name:          { type: string }
 *     responses:
 *       201:
 *         description: Created duplicate range
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AsinListRange'
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: Source range not found
 *       409:
 *         description: Range name already exists in this category
 *       500:
 *         description: Internal server error
 */
router.post('/duplicate', requireAuth, async (req, res) => {
  try {
    const { sourceRangeId, name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Range name is required' });
    }
    if (!sourceRangeId) {
      return res.status(400).json({ error: 'sourceRangeId is required' });
    }
    const source = await AsinListRange.findById(sourceRangeId).lean();
    if (!source) return res.status(404).json({ error: 'Source range not found' });
    const range = await AsinListRange.create({ name: name.trim(), categoryId: source.categoryId });
    res.status(201).json(range);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Range already exists in this category' });
    }
    console.error('Error duplicating asin list range:', error);
    res.status(500).json({ error: 'Failed to duplicate range' });
  }
});

// Delete a range and cascade-delete its products and orphan assigned ASINs
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const products = await AsinListProduct.find({ rangeId: id }, '_id').lean();
    const productIds = products.map(p => p._id);

    if (productIds.length > 0) {
      await AsinDirectory.updateMany(
        { listProductId: { $in: productIds } },
        { $unset: { listProductId: '' } }
      );
      await AsinListProduct.deleteMany({ _id: { $in: productIds } });
    }

    await AsinListRange.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting asin list range:', error);
    res.status(500).json({ error: 'Failed to delete range' });
  }
});

export default router;

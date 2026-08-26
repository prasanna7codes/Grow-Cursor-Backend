import express from 'express';
import AsinListCategory from '../models/AsinListCategory.js';
import AsinListRange from '../models/AsinListRange.js';
import AsinListProduct from '../models/AsinListProduct.js';
import AsinDirectory from '../models/AsinDirectory.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createAsinListCategorySchema, updateAsinListCategorySchema } from '../schemas/index.js';
import { normalizeSearchQueries } from '../utils/searchQueries.js';

const router = express.Router();

// Get all categories
/**
 * @swagger
 * /asin-list-categories:
 *   get:
 *     tags: [ASIN List Categories]
 *     summary: List all ASIN list categories
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of category documents
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AsinListCategory'
 *       500:
 *         description: Internal server error
 *   post:
 *     tags: [ASIN List Categories]
 *     summary: Create a new ASIN list category
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
 *     responses:
 *       201:
 *         description: Created category
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AsinListCategory'
 *       400:
 *         description: Name is required
 *       409:
 *         description: Category already exists
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const categories = await AsinListCategory.find().sort({ name: 1 }).lean();
    res.json(categories);
  } catch (error) {
    console.error('Error fetching asin list categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Create a new category
router.post('/', requireAuth, validate(createAsinListCategorySchema), async (req, res) => {
  try {
    const { name, searchQueries } = req.body;

    const category = await AsinListCategory.create({
      name,
      searchQueries: normalizeSearchQueries(searchQueries)
    });
    res.status(201).json(category);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Category already exists' });
    }
    console.error('Error creating asin list category:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// Update a category's name and/or its sourcing keywords
/**
 * @swagger
 * /asin-list-categories/{id}:
 *   put:
 *     tags: [ASIN List Categories]
 *     summary: Rename a category and/or set the search keywords used to source ASINs for it
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
 *             properties:
 *               name:          { type: string }
 *               searchQueries: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Updated category
 *       404:
 *         description: Category not found
 *       409:
 *         description: Duplicate category name
 *       500:
 *         description: Internal server error
 */
router.put('/:id', requireAuth, validate(updateAsinListCategorySchema), async (req, res) => {
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

    const category = await AsinListCategory.findByIdAndUpdate(
      id,
      update,
      { new: true, runValidators: true }
    );
    if (!category) return res.status(404).json({ error: 'Category not found' });
    res.json(category);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Category already exists' });
    }
    console.error('Error updating asin list category:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// Delete a category and cascade-delete its ranges, products, and orphan assigned ASINs
/**
 * @swagger
 * /asin-list-categories/{id}:
 *   delete:
 *     tags: [ASIN List Categories]
 *     summary: Delete a category and cascade-delete all child ranges, products, and unassign ASINs
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
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Find all ranges under this category
    const ranges = await AsinListRange.find({ categoryId: id }, '_id').lean();
    const rangeIds = ranges.map(r => r._id);

    if (rangeIds.length > 0) {
      // Find all products under those ranges
      const products = await AsinListProduct.find({ rangeId: { $in: rangeIds } }, '_id').lean();
      const productIds = products.map(p => p._id);

      if (productIds.length > 0) {
        // Orphan any ASINs assigned to those products
        await AsinDirectory.updateMany(
          { listProductId: { $in: productIds } },
          { $unset: { listProductId: '' } }
        );
        await AsinListProduct.deleteMany({ _id: { $in: productIds } });
      }

      await AsinListRange.deleteMany({ _id: { $in: rangeIds } });
    }

    await AsinListCategory.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting asin list category:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

export default router;

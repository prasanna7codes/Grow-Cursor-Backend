import { Router } from 'express';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createSubcategorySchema } from '../schemas/index.js';
import Subcategory from '../models/Subcategory.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Subcategories
 *   description: Listing subcategory reference data
 */

/**
 * @swagger
 * /subcategories:
 *   post:
 *     tags: [Subcategories]
 *     summary: Create a subcategory
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
 *               name: { type: string }
 *               categoryId: { type: string, description: Parent category ObjectId }
 *     responses:
 *       200: { description: Created subcategory (populated with category) }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.post('/', requireAuth, requirePageAccess('ManageCategories'), validate(createSubcategorySchema), async (req, res) => {
  const { name, categoryId } = req.body || {};
  if (!name || !categoryId) return res.status(400).json({ error: 'name and categoryId required' });
  try {
    const subcategory = await Subcategory.create({ name, category: categoryId });
    await subcategory.populate('category');
    res.json(subcategory);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * @swagger
 * /subcategories:
 *   get:
 *     tags: [Subcategories]
 *     summary: List all subcategories, optionally filtered by category
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: categoryId, schema: { type: string }, description: Filter by parent category ObjectId }
 *     responses:
 *       200: { description: Array of subcategories (populated with category) sorted by name }
 *       401: { description: Unauthorized }
 */
router.get('/', requireAuth, async (req, res) => {
  const { categoryId } = req.query || {};
  const query = categoryId ? { category: categoryId } : {};
  const items = await Subcategory.find(query).populate('category').sort({ name: 1 }).lean();
  res.json(items);
});

export default router;


import { Router } from 'express';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createCategorySchema } from '../schemas/index.js';
import Category from '../models/Category.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Categories
 *   description: Listing category reference data
 */

/**
 * @swagger
 * /categories:
 *   post:
 *     tags: [Categories]
 *     summary: Create a category
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
 *       200: { description: Created category }
 *       400: { description: Validation error or duplicate name }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.post('/', requireAuth, requirePageAccess('ManageCategories'), validate(createCategorySchema), async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const category = await Category.create({ name });
    res.json(category);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * @swagger
 * /categories:
 *   get:
 *     tags: [Categories]
 *     summary: List all categories
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Array of categories sorted by name }
 *       401: { description: Unauthorized }
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const items = await Category.find().sort({ name: 1 }).lean();
  res.json(items);
}));

export default router;

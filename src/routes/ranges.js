import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createRangeSchema } from '../schemas/index.js';
import Range from '../models/Range.js';
import Category from '../models/Category.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Ranges
 *   description: Listing range reference data
 */

/**
 * @swagger
 * /ranges:
 *   post:
 *     tags: [Ranges]
 *     summary: Create a range
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
 *       200: { description: Created range (populated with category) }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.post('/', requireAuth, requirePageAccess('ManageRanges'), validate(createRangeSchema), async (req, res) => {
  const { name, categoryId } = req.body || {};
  if (!name || !categoryId) return res.status(400).json({ error: 'name and categoryId required' });
  try {
    const range = await Range.create({ name, category: categoryId });
    await range.populate('category');
    res.json(range);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * @swagger
 * /ranges:
 *   get:
 *     tags: [Ranges]
 *     summary: List all ranges, optionally filtered by category
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: categoryId, schema: { type: string }, description: Filter by parent category ObjectId }
 *     responses:
 *       200: { description: Array of ranges (populated with category) sorted by name }
 *       401: { description: Unauthorized }
 */
router.get('/', requireAuth, async (req, res) => {
  const { categoryId } = req.query || {};
  
  let query = {};
  
  if (categoryId) {
    query.category = categoryId;
  }
  
  const items = await Range.find(query).populate('category').sort({ name: 1 }).lean();
  res.json(items);
});

export default router;

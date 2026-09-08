import { Router } from 'express';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createStoreSchema } from '../schemas/index.js';
import Store from '../models/Store.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

/**
 * @swagger
 * /stores:
 *   post:
 *     tags: [Stores]
 *     summary: Create a store
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, platformId]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Grow eBay Store
 *               platformId:
 *                 type: string
 *                 example: 665abc123def456789000001
 *     responses:
 *       200:
 *         description: Created store
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Store'
 *       400:
 *         description: Bad request
 */
router.post('/', requireAuth, requirePageAccess('ManageStores'), validate(createStoreSchema), async (req, res) => {
  const { name, platformId } = req.body || {};
  if (!name || !platformId) return res.status(400).json({ error: 'name and platformId required' });
  try {
    const store = await Store.create({ name, platform: platformId });
    res.json(store);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * @swagger
 * /stores:
 *   get:
 *     tags: [Stores]
 *     summary: List all stores
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: platformId
 *         schema:
 *           type: string
 *         description: Filter by platform ID
 *     responses:
 *       200:
 *         description: Array of stores with populated platform
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Store'
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { platformId } = req.query || {};
  const query = platformId ? { platform: platformId } : {};
  const items = await Store.find(query).populate('platform').sort({ name: 1 }).lean();
  res.json(items);
}));

export default router;



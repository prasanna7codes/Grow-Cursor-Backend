import { Router } from 'express';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createPlatformSchema } from '../schemas/index.js';
import Platform from '../models/Platform.js';

const router = Router();

/**
 * @swagger
 * /platforms:
 *   post:
 *     tags: [Platforms]
 *     summary: Create a platform
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, type]
 *             properties:
 *               name:
 *                 type: string
 *                 example: eBay
 *               type:
 *                 type: string
 *                 enum: [source, listing]
 *                 example: listing
 *     responses:
 *       200:
 *         description: Created platform
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Platform'
 *       400:
 *         description: Bad request
 */
router.post('/', requireAuth, requirePageAccess('ManagePlatforms'), validate(createPlatformSchema), async (req, res) => {
  const { name, type } = req.body || {};
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  try {
    const platform = await Platform.create({ name, type });
    res.json(platform);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * @swagger
 * /platforms:
 *   get:
 *     tags: [Platforms]
 *     summary: List all platforms
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [source, listing]
 *         description: Filter by platform type
 *     responses:
 *       200:
 *         description: Array of platforms
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Platform'
 */
router.get('/', requireAuth, async (req, res) => {
  const { type } = req.query;
  const query = type ? { type } : {};
  const items = await Platform.find(query).sort({ name: 1 }).lean();
  res.json(items);
});

export default router;



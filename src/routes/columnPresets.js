import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createColumnPresetSchema } from '../schemas/index.js';
import ColumnPreset from '../models/ColumnPreset.js';

const router = Router();

// GET all presets (shared across all users), optionally filtered by page
/**
 * @swagger
 * /column-presets:
 *   get:
 *     tags: [Column Presets]
 *     summary: List column presets
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: string
 *         description: Filter by page identifier (e.g. templateListings)
 *     responses:
 *       200:
 *         description: Array of column presets
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ColumnPreset'
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { page } = req.query;
    const query = {};
    if (page) query.page = page;
    
    const presets = await ColumnPreset.find(query).sort({ name: 1 }).lean();
    res.json(presets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CREATE a new preset
/**
 * @swagger
 * /column-presets:
 *   post:
 *     tags: [Column Presets]
 *     summary: Create a column preset
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, columns]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Default View
 *               columns:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: [title, price, quantity]
 *               page:
 *                 type: string
 *                 default: dashboard
 *                 example: templateListings
 *     responses:
 *       200:
 *         description: Created preset
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ColumnPreset'
 *       400:
 *         description: Bad request
 */
router.post('/', requireAuth, validate(createColumnPresetSchema), async (req, res) => {
  const { name, columns, page = 'dashboard' } = req.body || {};
  if (!name || !columns) {
    return res.status(400).json({ error: 'name and columns required' });
  }
  try {
    const preset = await ColumnPreset.create({
      name,
      columns,
      page,
      createdBy: req.user._id
    });
    res.json(preset);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE a preset
/**
 * @swagger
 * /column-presets/{id}:
 *   delete:
 *     tags: [Column Presets]
 *     summary: Delete a column preset
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Preset document ID
 *     responses:
 *       200:
 *         description: Deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Bad request
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await ColumnPreset.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;

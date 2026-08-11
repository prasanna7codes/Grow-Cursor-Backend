import { Router } from 'express';
import mongoose from 'mongoose';
import QuantityUpdateExclusion from '../models/QuantityUpdateExclusion.js';
import User from '../models/User.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { quantityUpdateExclusionSchema } from '../schemas/index.js';
import { normalizeItemId } from '../utils/quantityUpdateExclusions.js';

const router = Router();

// eBay legacy ItemIDs are numeric; the ones in use are 12 digits, but the range
// is kept loose so older/newer ID lengths are not rejected.
const ITEM_ID_PATTERN = /^\d{9,18}$/;

/** Split a pasted blob (or array) of ItemIDs into clean, de-duplicated tokens. */
export function parseItemIds(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/);
  const seen = new Set();
  const valid = [];
  const invalid = [];

  for (const token of raw) {
    const itemId = normalizeItemId(token);
    if (!itemId) continue;
    if (!ITEM_ID_PATTERN.test(itemId)) {
      if (!invalid.includes(itemId)) invalid.push(itemId);
      continue;
    }
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    valid.push(itemId);
  }

  return { valid, invalid };
}

/**
 * @swagger
 * /quantity-update-exclusions:
 *   get:
 *     tags: [Quantity Update Exclusions]
 *     summary: List eBay ItemIDs excluded from the on-order quantity reset
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Exclusions, newest first
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const exclusions = await QuantityUpdateExclusion.find({})
      .sort({ createdAt: -1, itemId: 1 })
      .lean();
    res.json(exclusions);
  } catch (error) {
    console.error('Error fetching quantity update exclusions:', error);
    res.status(500).json({ error: 'Failed to fetch quantity update exclusions' });
  }
});

/**
 * @swagger
 * /quantity-update-exclusions:
 *   post:
 *     tags: [Quantity Update Exclusions]
 *     summary: Add one or more ItemIDs to the exclusion list
 *     description: Accepts a single ItemID, an array, or a pasted blob separated by newlines/commas/spaces. Already-excluded IDs are reported as skipped rather than failing the request.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [itemIds]
 *             properties:
 *               itemIds:
 *                 oneOf:
 *                   - type: string
 *                   - type: array
 *                     items:
 *                       type: string
 *               note:
 *                 type: string
 *     responses:
 *       200:
 *         description: Summary of what was added, skipped and rejected
 *       400:
 *         description: No valid ItemIDs supplied
 *       500:
 *         description: Internal server error
 */
router.post(
  '/',
  requireAuth,
  requirePageAccess('QuantityUpdateExclusions'),
  validate(quantityUpdateExclusionSchema),
  async (req, res) => {
    try {
      const { valid, invalid } = parseItemIds(req.body.itemIds);
      const note = String(req.body.note || '').trim();

      if (valid.length === 0) {
        return res.status(400).json({
          error: invalid.length
            ? `No valid ItemIDs found. Rejected: ${invalid.slice(0, 10).join(', ')}`
            : 'No valid ItemIDs found'
        });
      }

      const existing = await QuantityUpdateExclusion.find({ itemId: { $in: valid } })
        .select('itemId')
        .lean();
      const existingIds = new Set(existing.map((doc) => doc.itemId));
      const toInsert = valid.filter((itemId) => !existingIds.has(itemId));

      let addedCount = 0;
      if (toInsert.length > 0) {
        const actor = await User.findById(req.user.userId).select('username').lean();
        const docs = toInsert.map((itemId) => ({
          itemId,
          note,
          source: 'manual',
          createdBy: req.user.userId,
          createdByName: actor?.username || ''
        }));

        try {
          const inserted = await QuantityUpdateExclusion.insertMany(docs, { ordered: false });
          addedCount = inserted.length;
        } catch (error) {
          // A concurrent add can duplicate an ItemID; the unique index rejects
          // just that document and the rest still land.
          if (error?.code !== 11000 && !error?.writeErrors) throw error;
          addedCount = error?.insertedDocs?.length ?? 0;
        }
      }

      res.json({
        success: true,
        added: addedCount,
        skipped: valid.length - toInsert.length,
        invalid
      });
    } catch (error) {
      console.error('Error adding quantity update exclusions:', error);
      res.status(500).json({ error: 'Failed to add quantity update exclusions' });
    }
  }
);

/**
 * @swagger
 * /quantity-update-exclusions/{id}:
 *   delete:
 *     tags: [Quantity Update Exclusions]
 *     summary: Remove an ItemID from the exclusion list
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Deleted successfully
 *       404:
 *         description: Exclusion not found
 *       500:
 *         description: Internal server error
 */
router.delete('/:id', requireAuth, requirePageAccess('QuantityUpdateExclusions'), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Exclusion not found' });
    }

    const deleted = await QuantityUpdateExclusion.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Exclusion not found' });
    }

    res.json({ success: true, itemId: deleted.itemId });
  } catch (error) {
    console.error('Error deleting quantity update exclusion:', error);
    res.status(500).json({ error: 'Failed to delete quantity update exclusion' });
  }
});

export default router;

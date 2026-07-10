import { Router } from 'express';
import { requireAuth, requirePageAccess, requireRole } from '../middleware/auth.js';
import Seller from '../models/Seller.js';
import User from '../models/User.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: SellersAdmin
 *   description: Admin-only seller selection endpoint
 */

/**
 * @swagger
 * /sellers-admin/all:
 *   get:
 *     tags: [SellersAdmin]
 *     summary: List all sellers for admin selection
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Returns all sellers populated with user info. Used by the SelectSeller admin page.
 *       **Requires SelectSeller page access.**
 *     responses:
 *       200: { description: Array of all seller objects with user }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
// List all sellers (for admin dashboard)
router.get('/all', requireAuth, requirePageAccess('SelectSeller'), async (req, res) => {
  const sellers = await Seller.find().populate('user', 'username email').lean();
  res.json(sellers);
});

export default router;

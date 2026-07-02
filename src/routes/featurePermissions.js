import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import FeaturePermission from '../models/FeaturePermission.js';

const router = Router();

// GET /:featureId - list of users allowed access to a feature (superadmin only)
router.get('/:featureId', requireAuth, async (req, res) => {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const permission = await FeaturePermission.findOne({ featureId: req.params.featureId })
      .populate('allowedUserIds', 'username email role');
    res.json({ featureId: req.params.featureId, allowedUserIds: permission?.allowedUserIds || [] });
  } catch (err) {
    console.error('Error fetching feature permission:', err);
    res.status(500).json({ error: 'Error fetching feature permission' });
  }
});

// PUT /:featureId - set the list of users allowed access to a feature (superadmin only)
router.put('/:featureId', requireAuth, async (req, res) => {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { allowedUserIds } = req.body;
  if (!Array.isArray(allowedUserIds) || !allowedUserIds.every((id) => mongoose.Types.ObjectId.isValid(id))) {
    return res.status(400).json({ error: 'allowedUserIds must be an array of valid user IDs' });
  }
  try {
    const permission = await FeaturePermission.findOneAndUpdate(
      { featureId: req.params.featureId },
      { allowedUserIds },
      { upsert: true, new: true }
    ).populate('allowedUserIds', 'username email role');
    res.json({ featureId: req.params.featureId, allowedUserIds: permission.allowedUserIds });
  } catch (err) {
    console.error('Error updating feature permission:', err);
    res.status(500).json({ error: 'Error updating feature permission' });
  }
});

// GET /:featureId/check - does the current user have access to this feature?
router.get('/:featureId/check', requireAuth, async (req, res) => {
  if (req.user.role === 'superadmin') {
    return res.json({ allowed: true });
  }
  try {
    const permission = await FeaturePermission.findOne({ featureId: req.params.featureId }).lean();
    const allowedUserIds = permission?.allowedUserIds || [];
    const allowed = allowedUserIds.some((id) => id.toString() === req.user.userId);
    res.json({ allowed });
  } catch (err) {
    console.error('Error checking feature permission:', err);
    res.status(500).json({ error: 'Error checking feature permission' });
  }
});

export default router;

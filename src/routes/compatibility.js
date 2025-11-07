import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Assignment from '../models/Assignment.js';
import CompatibilityAssignment from '../models/CompatibilityAssignment.js';
import Range from '../models/Range.js';

const router = Router();

// Get eligible completed listing assignments for compatibility admin
// Conditions: Category = "Ebay Motors" AND Pending Quantity = 0 (completedQuantity >= quantity)
router.get('/eligible', requireAuth, requireRole('superadmin', 'compatibilityadmin'), async (req, res) => {
  try {
    // Fetch assignments where category is "Ebay Motors" and pending quantity is 0
    const assignments = await Assignment.find({
      $expr: { $gte: ['$completedQuantity', '$quantity'] }, // completedQuantity >= quantity (no pending work)
      quantity: { $gt: 0 }
    })
      .populate([
        { path: 'task', populate: [{ path: 'sourcePlatform category subcategory', select: 'name' }] },
        { path: 'listingPlatform store', select: 'name' },
        { path: 'lister', select: 'username' },
        { path: 'createdBy', select: 'username' },
        { path: 'rangeQuantities.range', select: 'name' }
      ])
      .sort({ createdAt: -1 });

    // Filter for "Ebay Motors" category only
    const filtered = assignments.filter(a => a.task?.category?.name === 'Ebay Motors');

    res.json(filtered);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch eligible compatibility items.' });
  }
});

// Create a compatibility assignment for an editor
router.post('/assign', requireAuth, requireRole('superadmin', 'compatibilityadmin'), async (req, res) => {
  try {
    const { sourceAssignmentId, editorId, rangeQuantities, notes } = req.body || {};
    if (!sourceAssignmentId || !editorId || !rangeQuantities || !Array.isArray(rangeQuantities) || rangeQuantities.length === 0) {
      return res.status(400).json({ message: 'sourceAssignmentId, editorId and rangeQuantities array are required' });
    }

    const source = await Assignment.findById(sourceAssignmentId).populate('task');
    if (!source) return res.status(404).json({ message: 'Source assignment not found' });

    const creatorId = req.user?.userId || req.user?.id;

    // Calculate total quantity from rangeQuantities
    const totalQuantity = rangeQuantities.reduce((sum, rq) => sum + (rq.quantity || 0), 0);

    const doc = await CompatibilityAssignment.create({
      sourceAssignment: source._id,
      task: source.task?._id || source.task,
      admin: creatorId,
      editor: editorId,
      quantity: totalQuantity,
      assignedRangeQuantities: rangeQuantities.map(rq => ({ range: rq.rangeId, quantity: rq.quantity })),
      completedRangeQuantities: [], // Empty initially
      notes: notes || '',
      createdBy: creatorId,
    });

    const populated = await doc.populate([
      { path: 'task', populate: [{ path: 'sourcePlatform category subcategory', select: 'name' }] },
      { path: 'admin', select: 'username' },
      { path: 'editor', select: 'username' },
      { path: 'assignedRangeQuantities.range', select: 'name' },
    ]);

    res.status(201).json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to create compatibility assignment.' });
  }
});

// Get progress of compatibility assignments (for admin tracking)
router.get('/progress', requireAuth, requireRole('superadmin', 'compatibilityadmin'), async (req, res) => {
  try {
    const me = req.user?.userId || req.user?.id;
    // For superadmin, show all; for compatibility admin, show only their assignments
    const query = req.user?.role === 'superadmin' ? {} : { admin: me };
    
    const items = await CompatibilityAssignment.find(query)
      .populate([
        { path: 'task', populate: [{ path: 'sourcePlatform category subcategory', select: 'name' }] },
        { path: 'sourceAssignment', select: 'listingPlatform store', populate: [{ path: 'listingPlatform store', select: 'name' }] },
        { path: 'editor', select: 'username' },
        { path: 'admin', select: 'username' },
        { path: 'assignedRangeQuantities.range', select: 'name' },
        { path: 'completedRangeQuantities.range', select: 'name' },
      ])
      .sort({ createdAt: -1 });
    
    res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch compatibility progress.' });
  }
});

// Editor: list my compatibility assignments
router.get('/mine', requireAuth, requireRole('superadmin', 'compatibilityeditor'), async (req, res) => {
  try {
    const me = req.user?.userId || req.user?.id;
    const items = await CompatibilityAssignment.find({ editor: me })
      .populate([
        { path: 'task', populate: [{ path: 'category subcategory', select: 'name' }] },
        { path: 'sourceAssignment', select: 'listingPlatform store rangeQuantities quantity', populate: [{ path: 'listingPlatform store', select: 'name' }, { path: 'rangeQuantities.range', select: 'name' }] },
        { path: 'assignedRangeQuantities.range', select: 'name' },
        { path: 'completedRangeQuantities.range', select: 'name' },
      ])
      .sort({ createdAt: -1 });
    res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch my compatibility assignments.' });
  }
});

// Editor: add/update range quantity for compatibility work
router.post('/:id/complete-range', requireAuth, requireRole('superadmin', 'compatibilityeditor'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rangeId, quantity } = req.body || {};
    if (!rangeId || quantity == null || quantity < 0) {
      return res.status(400).json({ message: 'rangeId and quantity (>= 0) required' });
    }

    const doc = await CompatibilityAssignment.findById(id).populate('task', 'category subcategory');
    if (!doc) return res.status(404).json({ message: 'Compatibility assignment not found' });

    // validate range belongs to the task.category (ranges now per-category)
    const range = await Range.findById(rangeId).populate('category');
    if (!range) return res.status(404).json({ message: 'Range not found' });
    if (String(range.category?._id) !== String(doc.task.category)) {
      return res.status(400).json({ message: 'Range does not belong to task category' });
    }

    const idx = (doc.completedRangeQuantities || []).findIndex(rq => String(rq.range) === String(rangeId));
    if (idx >= 0) doc.completedRangeQuantities[idx].quantity = quantity; else doc.completedRangeQuantities.push({ range: rangeId, quantity });

    const total = (doc.completedRangeQuantities || []).reduce((s, rq) => s + (rq.quantity || 0), 0);
    doc.completedQuantity = Math.min(total, doc.quantity);
    if (total >= doc.quantity && !doc.completedAt) doc.completedAt = new Date();

    await doc.save();

    const populated = await doc.populate([{ path: 'completedRangeQuantities.range', select: 'name' }]);
    res.json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to update range quantity.' });
  }
});

export default router;

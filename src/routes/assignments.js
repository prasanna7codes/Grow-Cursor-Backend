// routes/assignments.js
import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Assignment from '../models/Assignment.js';
import Task from '../models/Task.js';

const IST_TZ = '+05:30';

const router = express.Router();

/* -------------------- CREATE / LIST -------------------- */

router.post('/', requireAuth, requireRole('superadmin', 'listingadmin'), async (req, res) => {
  try {
    const { taskId, listerId, quantity, listingPlatformId, storeId } = req.body || {};
    if (!taskId || !listerId || !quantity || !listingPlatformId || !storeId) {
      return res.status(400).json({ message: 'All fields are required.' });
    }

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found.' });

    const creatorId = (req.user && (req.user.userId || req.user.id)) || task.createdBy;
    if (!creatorId) return res.status(401).json({ message: 'Unauthorized: creator not resolved' });

    const doc = await Assignment.create({
      task: taskId,
      lister: listerId,
      quantity,
      listingPlatform: listingPlatformId,
      store: storeId,
      createdBy: creatorId,
    });

    const populated = await doc.populate([
      { path: 'task', populate: [{ path: 'sourcePlatform createdBy', select: 'name username' }] },
      { path: 'lister', select: 'username email' },
      { path: 'listingPlatform', select: 'name' },
      { path: 'store', select: 'name' },
      { path: 'createdBy', select: 'username' },
    ]);

    res.status(201).json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to create assignment.' });
  }
});

router.get('/', requireAuth, requireRole('superadmin', 'listingadmin', 'productadmin'), async (req, res) => {
  try {
    const { taskId, listerId, platformId, storeId } = req.query;
    const { page, limit, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const q = {};
    if (taskId) q.task = taskId;
    if (listerId) q.lister = listerId;
    if (platformId) q.listingPlatform = platformId;
    if (storeId) q.store = storeId;

    const cursor = Assignment.find(q)
      .populate([
        { path: 'task', populate: [{ path: 'sourcePlatform createdBy', select: 'name username' }] },
        { path: 'lister', select: 'username email' },
        { path: 'listingPlatform', select: 'name' },
        { path: 'store', select: 'name' },
        { path: 'createdBy', select: 'username' },
      ])
      .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 });

    if (page === undefined && limit === undefined) {
      const items = await cursor;
      return res.json(items);
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Number(limit) || 50);
    const [items, total] = await Promise.all([
      cursor.skip((pageNum - 1) * limitNum).limit(limitNum),
      Assignment.countDocuments(q),
    ]);

    res.json({ items, total, page: pageNum, limit: limitNum });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch assignments.' });
  }
});


/* -------------------- LISTER FLOWS (FIXED) -------------------- */

// List assignments for the logged-in lister
router.get('/mine',
  requireAuth,
  requireRole('superadmin', 'listingadmin', 'lister'),
  async (req, res) => {
    try {
      const me = req.user?.userId || req.user?.id;
      if (!me) return res.status(401).json({ message: 'Unauthorized' });

      // Cast to ObjectId if it looks like one; Mongoose will also cast strings, but this is explicit.
      const meObjId = mongoose.Types.ObjectId.isValid(me) ? new mongoose.Types.ObjectId(me) : me;

      const items = await Assignment.find({ lister: meObjId })
        .populate([
          { path: 'task', populate: [{ path: 'sourcePlatform createdBy', select: 'name username' }] },
          { path: 'listingPlatform', select: 'name' },
          { path: 'store', select: 'name' },
        ])
        .sort({ createdAt: -1 });

      res.json(items);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to fetch my assignments.' });
    }
  }
);

// Lister/admin completes an assignment
router.post('/:id/complete',
  requireAuth,
  requireRole('superadmin', 'listingadmin', 'lister'),
  async (req, res) => {
    const { id } = req.params;
    const { completedQuantity } = req.body || {};
    if (completedQuantity == null || completedQuantity < 0) {
      return res.status(400).json({ message: 'completedQuantity is required and must be >= 0' });
    }

    const doc = await Assignment.findById(id);
    if (!doc) return res.status(404).json({ message: 'Assignment not found' });

    const me = req.user?.userId || req.user?.id;
    const isAdmin = ['superadmin', 'listingadmin'].includes(req.user?.role);
    if (!isAdmin && String(doc.lister) !== String(me)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const newQty = Math.min(Number(completedQuantity), doc.quantity);
    const completedAt = newQty >= doc.quantity ? new Date() : null;

    doc.completedQuantity = newQty;
    doc.completedAt = completedAt;
    await doc.save();

    const populated = await doc.populate([
      { path: 'task', populate: [{ path: 'sourcePlatform createdBy', select: 'name username' }] },
      { path: 'listingPlatform', select: 'name' },
      { path: 'store', select: 'name' },
    ]);

    res.json(populated);
  }
);

/* -------------------- ANALYTICS (unchanged from your working state) -------------------- */

router.get('/analytics/admin-lister',
  requireAuth,
  requireRole('superadmin', 'listingadmin', 'productadmin'),
  async (req, res) => {
    try {
      const rows = await Assignment.aggregate([
        {
          $project: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: IST_TZ } },

            adminId: "$createdBy",
            listerId: "$lister",
            quantity: 1,
            completedQuantity: { $ifNull: ["$completedQuantity", 0] }
          }
        },
        {
          $group: {
            _id: { date: "$date", adminId: "$adminId", listerId: "$listerId" },
            tasksCount: { $sum: 1 },
            quantityTotal: { $sum: "$quantity" },
            completedCount: { $sum: { $cond: [{ $gte: ["$completedQuantity", "$quantity"] }, 1, 0] } },
            completedQty: { $sum: "$completedQuantity" }
          }
        },
        {
          $project: {
            _id: 0, date: "$_id.date", adminId: "$_id.adminId", listerId: "$_id.listerId",
            tasksCount: 1, quantityTotal: 1, completedCount: 1, completedQty: 1
          }
        },
        { $lookup: { from: "users", localField: "adminId", foreignField: "_id", as: "adminUser" } },
        { $unwind: { path: "$adminUser", preserveNullAndEmptyArrays: true } },
        { $lookup: { from: "users", localField: "listerId", foreignField: "_id", as: "listerUser" } },
        { $unwind: { path: "$listerUser", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            date: 1, adminId: 1, listerId: 1, tasksCount: 1, quantityTotal: 1, completedCount: 1, completedQty: 1,
            adminName: { $ifNull: ["$adminUser.username", "Unassigned"] },
            listerName: { $ifNull: ["$listerUser.username", "Unknown"] }
          }
        },
        { $sort: { date: -1, adminName: 1, listerName: 1 } }
      ]);

      res.json(rows);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to compute admin-lister analytics.' });
    }
  }
);

router.get('/analytics/listings-summary',
  requireAuth,
  requireRole('superadmin', 'listingadmin', 'productadmin'),
  async (req, res) => {
    try {
      const { platformId, storeId } = req.query;

      const rows = await Assignment.aggregate([
        ...(platformId ? [{ $match: { listingPlatform: new mongoose.Types.ObjectId(platformId) } }] : []),
        ...(storeId ? [{ $match: { store: new mongoose.Types.ObjectId(storeId) } }] : []),

        { $lookup: { from: "tasks", localField: "task", foreignField: "_id", as: "task" } },
        { $unwind: "$task" },

        {
          $project: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: IST_TZ } },

            platformId: "$listingPlatform",
            storeId: "$store",
            listerId: "$lister",
            quantity: 1,
            completedQuantity: { $ifNull: ["$completedQuantity", 0] },
            range: "$task.range",
            category: "$task.category"
          }
        },
        {
          $group: {
            _id: { date: "$date", platformId: "$platformId", storeId: "$storeId" },
            totalQuantity: { $sum: "$quantity" },
            assignmentsCount: { $sum: 1 },
            completedQty: { $sum: "$completedQuantity" },
            listers: { $addToSet: "$listerId" },
            ranges: { $addToSet: "$range" },
            categories: { $addToSet: "$category" }
          }
        },
        {
          $project: {
            _id: 0,
            date: "$_id.date",
            platformId: "$_id.platformId",
            storeId: "$_id.storeId",
            totalQuantity: 1,
            assignmentsCount: 1,
            completedQty: 1,
            numListers: { $size: "$listers" },
            numRanges: { $size: "$ranges" },
            numCategories: { $size: "$categories" }
          }
        },
        { $lookup: { from: "platforms", localField: "platformId", foreignField: "_id", as: "platformDoc" } },
        { $unwind: { path: "$platformDoc", preserveNullAndEmptyArrays: true } },
        { $lookup: { from: "stores", localField: "storeId", foreignField: "_id", as: "storeDoc" } },
        { $unwind: { path: "$storeDoc", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            date: 1,
            platform: { $ifNull: ["$platformDoc.name", null] },
            store: { $ifNull: ["$storeDoc.name", null] },
            totalQuantity: 1,
            assignmentsCount: 1,
            completedQty: 1,
            numListers: 1,
            numRanges: 1,
            numCategories: 1
          }
        },
        { $sort: { date: -1, platform: 1, store: 1 } }
      ]);

      res.json(rows);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to compute listings summary.' });
    }
  }
);

export default router;

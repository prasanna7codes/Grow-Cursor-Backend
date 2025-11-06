// routes/assignments.js
import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Assignment from '../models/Assignment.js';
import Task from '../models/Task.js';
import Range from '../models/Range.js'

const IST_TZ = '+05:30';

const router = express.Router();

/* -------------------- CREATE / LIST -------------------- */

router.post('/', requireAuth, requireRole('superadmin', 'listingadmin'), async (req, res) => {
  try {
    const { taskId, listerId, quantity, listingPlatformId, storeId, notes } = req.body || {};
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
      notes: notes || '',
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
        { path: 'task', populate: [{ path: 'sourcePlatform createdBy category subcategory range', select: 'name username' }] },
        { path: 'lister', select: 'username email' },
        { path: 'listingPlatform', select: 'name' },
        { path: 'store', select: 'name' },
        { path: 'createdBy', select: 'username' },
        { path: 'rangeQuantities.range', select: 'name' },
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
          { path: 'task', populate: [{ path: 'sourcePlatform createdBy category subcategory range', select: 'name username' }] },
          { path: 'listingPlatform', select: 'name' },
          { path: 'store', select: 'name' },
          { path: 'rangeQuantities.range', select: 'name' },
        ])
        .sort({ createdAt: -1 });

      res.json(items);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to fetch my assignments.' });
    }
  }
);
router.get('/mine/with-status',
  requireAuth,
  requireRole('superadmin', 'listingadmin', 'lister'),
  async (req, res) => {
    try {
      const me = req.user?.userId || req.user?.id;
      if (!me) return res.status(401).json({ message: 'Unauthorized' });

      const meObjId = mongoose.Types.ObjectId.isValid(me) ? new mongoose.Types.ObjectId(me) : me;

      const allAssignments = await Assignment.find({ lister: meObjId })
        .populate([
          { path: 'task', populate: [{ path: 'sourcePlatform createdBy category subcategory range', select: 'name username' }] },
          { path: 'listingPlatform', select: 'name' },
          { path: 'store', select: 'name' },
          { path: 'rangeQuantities.range', select: 'name' },
        ])
        .sort({ createdAt: -1 });

      const today = new Date();
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

      const todaysTasks = [];
      const pendingTasks = [];
      const completedTasks = [];

      for (const a of allAssignments) {
        // Check completion based on rangeQuantities sum or completedQuantity
        const rangeQuantitiesSum = (a.rangeQuantities || []).reduce((sum, rq) => sum + (rq.quantity || 0), 0);
        const isCompleted = rangeQuantitiesSum >= a.quantity || (a.completedQuantity || 0) >= a.quantity;
        const createdAt = new Date(a.createdAt);
        const isToday = createdAt >= startOfToday && createdAt < endOfToday;

        if (isCompleted) {
          completedTasks.push(a);
        } else if (isToday) {
          todaysTasks.push(a);
        } else {
          pendingTasks.push(a);
        }
      }

      res.json({ todaysTasks, pendingTasks, completedTasks });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to fetch categorized assignments.' });
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
            categoryId: "$task.category",
            subcategoryId: "$task.subcategory",
            rangeQuantities: { $ifNull: ["$rangeQuantities", []] }
          }
        },
        // Store assignment-level data before unwinding
        {
          $addFields: {
            assignmentId: "$_id",
            assignmentQuantity: "$quantity",
            assignmentCompletedQty: "$completedQuantity"
          }
        },
        // Unwind rangeQuantities to get individual ranges
        { $unwind: { path: "$rangeQuantities", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { date: "$date", platformId: "$platformId", storeId: "$storeId" },
            // Use $addToSet to get unique assignment quantities (each assignment counted once)
            assignmentQuantities: { $addToSet: "$assignmentQuantity" },
            assignmentCompletedQuantities: { $addToSet: "$assignmentCompletedQty" },
            // Count unique assignments (not ranges)
            assignmentIds: { $addToSet: "$assignmentId" },
            listers: { $addToSet: "$listerId" },
            categories: { $addToSet: "$categoryId" },
            subcategories: { $addToSet: "$subcategoryId" },
            ranges: { $addToSet: "$rangeQuantities.range" }
          }
        },
        {
          $project: {
            _id: 0,
            date: "$_id.date",
            platformId: "$_id.platformId",
            storeId: "$_id.storeId",
            totalQuantity: { $sum: "$assignmentQuantities" },
            assignmentsCount: { $size: "$assignmentIds" },
            completedQty: { $sum: "$assignmentCompletedQuantities" },
            numListers: { $size: "$listers" },
            numCategories: { $size: "$categories" },
            numSubcategories: { $size: "$subcategories" },
            numRanges: { $size: { $filter: { input: "$ranges", as: "r", cond: { $ne: ["$$r", null] } } } }
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

// ===== STOCK LEDGER: totals by (platform, store, category, range) =====
router.get(
  '/analytics/stock-ledger',
  requireAuth,
  requireRole('superadmin', 'listingadmin', 'productadmin'),
  async (req, res) => {
    try {
      const { platformId, storeId, categoryId, subcategoryId } = req.query || {};
      const match = {};
      if (platformId) match.listingPlatform = new mongoose.Types.ObjectId(platformId);
      if (storeId) match.store = new mongoose.Types.ObjectId(storeId);

      // We need category & subcategory from the linked Task, and ranges from rangeQuantities
      const pipeline = [
        ...(platformId ? [{ $match: { listingPlatform: new mongoose.Types.ObjectId(platformId) } }] : []),
        ...(storeId ? [{ $match: { store: new mongoose.Types.ObjectId(storeId) } }] : []),

        // Pull category & subcategory off the Task
        { $lookup: { from: 'tasks', localField: 'task', foreignField: '_id', as: 'task' } },
        { $unwind: '$task' },

        // (Optional) filters for category/subcategory after join
        ...(categoryId ? [{ $match: { 'task.category': new mongoose.Types.ObjectId(categoryId) } }] : []),
        ...(subcategoryId ? [{ $match: { 'task.subcategory': new mongoose.Types.ObjectId(subcategoryId) } }] : []),

        // Unwind rangeQuantities to get individual range-quantity pairs
        { $unwind: { path: '$rangeQuantities', preserveNullAndEmptyArrays: false } },

        // Filter out entries with quantity 0
        { $match: { 'rangeQuantities.quantity': { $gt: 0 } } },

        {
          $project: {
            platformId: '$listingPlatform',
            storeId: '$store',
            categoryId: '$task.category',
            subcategoryId: '$task.subcategory',
            rangeId: '$rangeQuantities.range',
            rangeQuantity: { $ifNull: ['$rangeQuantities.quantity', 0] },
            // Store assignment quantity and assignment ID for proper grouping
            assignmentId: '$_id',
            assignmentQuantity: '$quantity'
          }
        },
        {
          $group: {
            _id: {
              platformId: '$platformId',
              storeId: '$storeId',
              categoryId: '$categoryId',
              subcategoryId: '$subcategoryId',
              rangeId: '$rangeId'
            },
            // For assigned: sum the assignment quantity, but only count each assignment once
            assignmentIds: { $addToSet: '$assignmentId' },
            assignmentQuantities: { $addToSet: '$assignmentQuantity' },
            totalCompleted: { $sum: '$rangeQuantity' } // Sum of distributed quantities
          }
        },
        {
          // Calculate totalAssigned from assignment quantities (each assignment counted once)
          $project: {
            _id: 0,
            platformId: '$_id.platformId',
            storeId: '$_id.storeId',
            categoryId: '$_id.categoryId',
            subcategoryId: '$_id.subcategoryId',
            rangeId: '$_id.rangeId',
            // Sum unique assignment quantities (each assignment contributes its full quantity)
            totalAssigned: { $sum: '$assignmentQuantities' },
            totalCompleted: 1,
            pending: {
              $cond: [
                { $gt: [{ $subtract: [{ $sum: '$assignmentQuantities' }, '$totalCompleted'] }, 0] },
                { $subtract: [{ $sum: '$assignmentQuantities' }, '$totalCompleted'] },
                0
              ]
            }
          }
        },
        // Look up names
        { $lookup: { from: 'platforms', localField: 'platformId', foreignField: '_id', as: 'platformDoc' } },
        { $unwind: { path: '$platformDoc', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'stores', localField: 'storeId', foreignField: '_id', as: 'storeDoc' } },
        { $unwind: { path: '$storeDoc', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'categories', localField: 'categoryId', foreignField: '_id', as: 'categoryDoc' } },
        { $unwind: { path: '$categoryDoc', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'subcategories', localField: 'subcategoryId', foreignField: '_id', as: 'subcategoryDoc' } },
        { $unwind: { path: '$subcategoryDoc', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'ranges', localField: 'rangeId', foreignField: '_id', as: 'rangeDoc' } },
        { $unwind: { path: '$rangeDoc', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            platformId: 1,
            platform: { $ifNull: ['$platformDoc.name', null] },
            storeId: 1,
            store: { $ifNull: ['$storeDoc.name', null] },
            categoryId: 1,
            category: { $ifNull: ['$categoryDoc.name', null] },
            subcategoryId: 1,
            subcategory: { $ifNull: ['$subcategoryDoc.name', null] },
            rangeId: 1,
            range: { $ifNull: ['$rangeDoc.name', null] },
            totalAssigned: 1,
            totalCompleted: 1,
            pending: 1
          }
        },
        { $sort: { platform: 1, store: 1, category: 1, subcategory: 1, range: 1 } }
      ];

      const rows = await Assignment.aggregate(pipeline);
      res.json(rows);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to compute stock ledger.' });
    }
  }
);

/* -------------------- RANGE QUANTITY DISTRIBUTION -------------------- */

// Get range quantity distribution for an assignment
router.get('/:id/ranges',
  requireAuth,
  requireRole('superadmin', 'listingadmin', 'lister'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const doc = await Assignment.findById(id)
        .populate('rangeQuantities.range', 'name')
        .populate('task', 'category subcategory');
      
      if (!doc) return res.status(404).json({ message: 'Assignment not found' });

      const me = req.user?.userId || req.user?.id;
      const isAdmin = ['superadmin', 'listingadmin'].includes(req.user?.role);
      
      // Lister can only view their own assignments
      if (!isAdmin && String(doc.lister) !== String(me)) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      res.json(doc.rangeQuantities || []);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to fetch range quantities.' });
    }
  }
);

// Add or update range quantity for an assignment
router.post('/:id/complete-range',
  requireAuth,
  requireRole('superadmin', 'listingadmin', 'lister'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { rangeId, quantity } = req.body || {};
      
      if (!rangeId || quantity == null || quantity < 0) {
        return res.status(400).json({ message: 'rangeId and quantity (>= 0) required' });
      }

      const doc = await Assignment.findById(id).populate('task', 'category subcategory');
      if (!doc) return res.status(404).json({ message: 'Assignment not found' });

      const me = req.user?.userId || req.user?.id;
      const isAdmin = ['superadmin', 'listingadmin'].includes(req.user?.role);
      
      // Lister can only update their own assignments
      if (!isAdmin && String(doc.lister) !== String(me)) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      // Validate that range belongs to the task's category
      
      const range = await Range.findById(rangeId).populate('category');
      if (!range) return res.status(404).json({ message: 'Range not found' });
      
      if (String(range.category._id) !== String(doc.task.category)) {
        return res.status(400).json({ message: 'Range does not belong to task category' });
      }

      // Update or add range quantity
      const existingIndex = doc.rangeQuantities.findIndex(
        rq => String(rq.range) === String(rangeId)
      );

      if (existingIndex >= 0) {
        // Update existing
        doc.rangeQuantities[existingIndex].quantity = quantity;
      } else {
        // Add new
        doc.rangeQuantities.push({ range: rangeId, quantity });
      }

      // Calculate total distributed quantity
      const totalDistributed = doc.rangeQuantities.reduce((sum, rq) => sum + (rq.quantity || 0), 0);
      
      // Update completedQuantity
      doc.completedQuantity = Math.min(totalDistributed, doc.quantity);
      
      // Auto-complete assignment when total distributed equals or exceeds assigned quantity
      if (totalDistributed >= doc.quantity && !doc.completedAt) {
        doc.completedAt = new Date();
      }

      await doc.save();

      const populated = await doc.populate([
        { path: 'task', populate: [{ path: 'sourcePlatform createdBy category subcategory range', select: 'name username' }] },
        { path: 'listingPlatform', select: 'name' },
        { path: 'store', select: 'name' },
        { path: 'rangeQuantities.range', select: 'name' },
      ]);

      res.json(populated);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to update range quantity.' });
    }
  }
);

// Submit assignment (mark as complete)
router.post('/:id/submit',
  requireAuth,
  requireRole('superadmin', 'listingadmin', 'lister'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const doc = await Assignment.findById(id).populate('task', 'category subcategory');
      
      if (!doc) return res.status(404).json({ message: 'Assignment not found' });

      const me = req.user?.userId || req.user?.id;
      const isAdmin = ['superadmin', 'listingadmin'].includes(req.user?.role);
      
      // Lister can only submit their own assignments
      if (!isAdmin && String(doc.lister) !== String(me)) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      // Calculate total distributed quantity
      const totalDistributed = doc.rangeQuantities.reduce((sum, rq) => sum + (rq.quantity || 0), 0);
      
      // Validate that total distributed equals assigned quantity
      if (totalDistributed < doc.quantity) {
        return res.status(400).json({ 
          message: `Cannot submit: distributed quantity (${totalDistributed}) is less than assigned quantity (${doc.quantity})` 
        });
      }

      // Mark assignment as complete
      doc.completedQuantity = doc.quantity;
      doc.completedAt = new Date();

      await doc.save();

      const populated = await doc.populate([
        { path: 'task', populate: [{ path: 'sourcePlatform createdBy category subcategory range', select: 'name username' }] },
        { path: 'listingPlatform', select: 'name' },
        { path: 'store', select: 'name' },
        { path: 'rangeQuantities.range', select: 'name' },
      ]);

      res.json(populated);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to submit assignment.' });
    }
  }
);

export default router;

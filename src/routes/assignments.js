// routes/assignments.js
import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createAssignmentSchema } from '../schemas/index.js';
import Assignment from '../models/Assignment.js';
import Task from '../models/Task.js';
import Range from '../models/Range.js';
import ListingCompletion from '../models/ListingCompletion.js';

const IST_TZ = '+05:30';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Assignments
 *   description: Lister assignment management, completion, and analytics
 */

/* -------------------- CREATE / LIST -------------------- */

/**
 * @swagger
 * /assignments/filter-options:
 *   get:
 *     tags: [Assignments]
 *     summary: Get all available assignment filter options
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Returns distinct values for platforms, stores, categories, subcategories, listers,
 *       assigners, task creators, source platforms, and marketplaces. Used to populate
 *       filter dropdowns in the Assignments page.
 *       **Requires Assignments page access.**
 *     responses:
 *       200:
 *         description: Filter options object
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
// Get all available filter options
router.get('/filter-options', requireAuth, requirePageAccess('Assignments'), async (req, res) => {
  try {
    const [
      platforms,
      stores,
      categories,
      subcategories,
      listers,
      assigners
    ] = await Promise.all([
      Assignment.distinct('listingPlatform').then(ids =>
        mongoose.model('Platform').find({ _id: { $in: ids } }).select('name').lean()
      ),
      Assignment.distinct('store').then(ids =>
        mongoose.model('Store').find({ _id: { $in: ids } }).select('name').lean()
      ),
      // Fetch ALL categories from database, not just ones in assignments
      mongoose.model('Category').find({}).select('name').lean(),
      // Fetch ALL subcategories from database, not just ones in assignments
      mongoose.model('Subcategory').find({}).select('name').lean(),
      Assignment.distinct('lister').then(ids =>
        mongoose.model('User').find({ _id: { $in: ids } }).select('username').lean()
      ),
      Assignment.distinct('createdBy').then(ids =>
        mongoose.model('User').find({ _id: { $in: ids } }).select('username').lean()
      )
    ]);

    // Define all available marketplaces from enum
    const allMarketplaces = ['EBAY_US', 'EBAY_AUS', 'EBAY_CANADA'];

    // Get source platforms and task creators from tasks linked to assignments
    const [sourcePlatforms, taskCreators] = await Promise.all([
      Assignment.aggregate([
        { $lookup: { from: 'tasks', localField: 'task', foreignField: '_id', as: 'taskData' } },
        { $unwind: '$taskData' },
        { $group: { _id: '$taskData.sourcePlatform' } },
        { $lookup: { from: 'platforms', localField: '_id', foreignField: '_id', as: 'platform' } },
        { $unwind: '$platform' },
        { $project: { _id: '$platform._id', name: '$platform.name' } }
      ]),
      Assignment.aggregate([
        { $lookup: { from: 'tasks', localField: 'task', foreignField: '_id', as: 'taskData' } },
        { $unwind: '$taskData' },
        { $group: { _id: '$taskData.createdBy' } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        { $unwind: '$user' },
        { $project: { _id: '$user._id', username: '$user.username' } }
      ])
    ]);

    res.json({
      sourcePlatforms: sourcePlatforms.map(p => ({ _id: p._id, name: p.name })),
      listingPlatforms: platforms.map(p => ({ _id: p._id, name: p.name })),
      stores: stores.map(s => ({ _id: s._id, name: s.name })),
      categories: categories.map(c => ({ _id: c._id, name: c.name })),
      subcategories: subcategories.map(s => ({ _id: s._id, name: s.name })),
      listers: listers.map(l => ({ _id: l._id, username: l.username })),
      assigners: assigners.map(a => ({ _id: a._id, username: a.username })),
      taskCreators: taskCreators.map(t => ({ _id: t._id, username: t.username })),
      marketplaces: allMarketplaces // Return all available marketplaces
    });
  } catch (e) {
    console.error('Failed to fetch filter options:', e);
    res.status(500).json({ message: 'Failed to fetch filter options.' });
  }
});

/**
 * @swagger
 * /assignments:
 *   post:
 *     tags: [Assignments]
 *     summary: Create a single assignment
 *     security:
 *       - bearerAuth: []
 *     description: Assigns a task to a lister. **Requires Assignments page access.**
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [taskId, listerId, quantity, listingPlatformId, storeId]
 *             properties:
 *               taskId: { type: string }
 *               listerId: { type: string }
 *               quantity: { type: integer }
 *               listingPlatformId: { type: string }
 *               storeId: { type: string }
 *               notes: { type: string }
 *               scheduledDate: { type: string, format: date-time }
 *     responses:
 *       201: { description: Created assignment (populated) }
 *       400: { description: Missing fields or invalid task }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Task not found }
 */
router.post('/', requireAuth, requirePageAccess('Assignments'), validate(createAssignmentSchema), async (req, res) => {
  try {
    const { taskId, listerId, quantity, listingPlatformId, storeId, notes, scheduledDate } = req.body || {};
    if (!taskId || !listerId || !quantity || !listingPlatformId || !storeId) {
      return res.status(400).json({ message: 'All fields are required.' });
    }

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found.' });

    // Get marketplace from the task
    if (!task.marketplace) {
      return res.status(400).json({ message: 'Task does not have a marketplace assigned.' });
    }

    const creatorId = (req.user && (req.user.userId || req.user.id)) || task.createdBy;
    if (!creatorId) return res.status(401).json({ message: 'Unauthorized: creator not resolved' });

    // Parse scheduledDate or default to now
    const schedDate = scheduledDate ? new Date(scheduledDate) : new Date();

    const doc = await Assignment.create({
      task: taskId,
      lister: listerId,
      quantity,
      listingPlatform: listingPlatformId,
      store: storeId,
      marketplace: task.marketplace,
      createdBy: creatorId,
      notes: notes || '',
      scheduledDate: schedDate,
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



/**
 * @swagger
 * /assignments:
 *   get:
 *     tags: [Assignments]
 *     summary: List assignments with full filtering
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Supports extensive filtering (taskId, listerId, platformId, storeId, marketplace,
 *       productTitle, created date range/single, scheduled date range/single, source platform,
 *       category, subcategory, creator, lister username, sharedBy) and optional pagination.
 *       **Requires Assignments page access.**
 *     parameters:
 *       - { in: query, name: taskId, schema: { type: string } }
 *       - { in: query, name: listerId, schema: { type: string } }
 *       - { in: query, name: platformId, schema: { type: string } }
 *       - { in: query, name: storeId, schema: { type: string } }
 *       - { in: query, name: marketplace, schema: { type: string } }
 *       - { in: query, name: productTitle, schema: { type: string } }
 *       - { in: query, name: dateMode, schema: { type: string, enum: [single, range] } }
 *       - { in: query, name: dateSingle, schema: { type: string, format: date } }
 *       - { in: query, name: dateFrom, schema: { type: string, format: date } }
 *       - { in: query, name: dateTo, schema: { type: string, format: date } }
 *       - { in: query, name: scheduledDateMode, schema: { type: string, enum: [single, range] } }
 *       - { in: query, name: scheduledDateSingle, schema: { type: string, format: date } }
 *       - { in: query, name: scheduledDateFrom, schema: { type: string, format: date } }
 *       - { in: query, name: scheduledDateTo, schema: { type: string, format: date } }
 *       - { in: query, name: category, schema: { type: string } }
 *       - { in: query, name: subcategory, schema: { type: string } }
 *       - { in: query, name: sourcePlatform, schema: { type: string } }
 *       - { in: query, name: createdByTask, schema: { type: string } }
 *       - { in: query, name: listerUsername, schema: { type: string } }
 *       - { in: query, name: sharedBy, schema: { type: string } }
 *       - { in: query, name: sortBy, schema: { type: string, default: createdAt } }
 *       - { in: query, name: sortOrder, schema: { type: string, enum: [asc, desc], default: desc } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: Array of assignments or paginated wrapper when page/limit provided
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/', requireAuth, requirePageAccess('Assignments'), async (req, res) => {
  try {
    const {
      taskId, listerId, platformId, storeId,
      // New filter parameters
      marketplace, productTitle,
      dateFrom, dateTo, dateMode, dateSingle,
      scheduledDateFrom, scheduledDateTo, scheduledDateMode, scheduledDateSingle
    } = req.query;
    const { page, limit, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const q = {};
    if (taskId) q.task = taskId;
    if (listerId) q.lister = listerId;
    if (platformId) q.listingPlatform = platformId;
    if (storeId) q.store = storeId;
    if (marketplace) q.marketplace = marketplace;

    // Date filtering (IST timezone) - Created Date
    if (dateMode === 'single' && dateSingle) {
      const startDate = new Date(dateSingle + 'T00:00:00+05:30');
      const endDate = new Date(dateSingle + 'T23:59:59+05:30');
      q.createdAt = { $gte: startDate, $lte: endDate };
    } else if (dateMode === 'range') {
      if (dateFrom || dateTo) {
        q.createdAt = {};
        if (dateFrom) q.createdAt.$gte = new Date(dateFrom + 'T00:00:00+05:30');
        if (dateTo) q.createdAt.$lte = new Date(dateTo + 'T23:59:59+05:30');
      }
    }

    // Scheduled Date filtering (IST timezone)
    if (scheduledDateMode === 'single' && scheduledDateSingle) {
      const startDate = new Date(scheduledDateSingle + 'T00:00:00+05:30');
      const endDate = new Date(scheduledDateSingle + 'T23:59:59+05:30');
      q.scheduledDate = { $gte: startDate, $lte: endDate };
    } else if (scheduledDateMode === 'range') {
      if (scheduledDateFrom || scheduledDateTo) {
        q.scheduledDate = {};
        if (scheduledDateFrom) q.scheduledDate.$gte = new Date(scheduledDateFrom + 'T00:00:00+05:30');
        if (scheduledDateTo) q.scheduledDate.$lte = new Date(scheduledDateTo + 'T23:59:59+05:30');
      }
    }

    // First get assignments with basic filters
    let items = await Assignment.find(q)
      .populate([
        { path: 'task', populate: [{ path: 'sourcePlatform createdBy category subcategory range', select: 'name username' }] },
        { path: 'lister', select: 'username email' },
        { path: 'listingPlatform', select: 'name' },
        { path: 'store', select: 'name' },
        { path: 'createdBy', select: 'username' },
        { path: 'rangeQuantities.range', select: 'name' },
      ])
      .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
      .lean();

    // Apply additional filters that require populated data
    const {
      sourcePlatform, category, subcategory, createdByTask,
      listerUsername, sharedBy
    } = req.query;

    if (sourcePlatform) {
      const platforms = sourcePlatform.split(',');
      items = items.filter(item => platforms.includes(item.task?.sourcePlatform?.name));
    }
    if (category) {
      const categories = category.split(',');
      items = items.filter(item => categories.includes(item.task?.category?.name));
    }
    if (subcategory) {
      const subcategories = subcategory.split(',');
      items = items.filter(item => subcategories.includes(item.task?.subcategory?.name));
    }
    if (createdByTask) {
      const creators = createdByTask.split(',');
      items = items.filter(item => creators.includes(item.task?.createdBy?.username));
    }
    if (listerUsername) {
      const listers = listerUsername.split(',');
      items = items.filter(item => listers.includes(item.lister?.username));
    }
    if (sharedBy) {
      const sharers = sharedBy.split(',');
      items = items.filter(item => sharers.includes(item.createdBy?.username));
    }
    if (productTitle) {
      const titleLower = productTitle.toLowerCase();
      items = items.filter(item =>
        item.task?.productTitle?.toLowerCase().includes(titleLower)
      );
    }

    const total = items.length;

    if (page === undefined && limit === undefined) {
      return res.json(items);
    }

    // Apply pagination
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Number(limit) || 50);
    const paginatedItems = items.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({ items: paginatedItems, total, page: pageNum, limit: limitNum });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch assignments.' });
  }
});

/* -------------------- DELETE (CASCADE) -------------------- */
/**
 * @swagger
 * /assignments/{id}:
 *   delete:
 *     tags: [Assignments]
 *     summary: Delete an assignment (cascade)
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Deletes the assignment and cascades to:
 *       CompatibilityAssignments (sourceAssignment) and ListingCompletions (assignment).
 *       **Requires Assignments page access.**
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deletion confirmation }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Assignment not found }
 */
// Delete an assignment and cascade delete any related compatibility assignments and listing completions
router.delete('/:id', requireAuth, requirePageAccess('Assignments'), async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await Assignment.findById(id);
    if (!doc) return res.status(404).json({ message: 'Assignment not found.' });

    // Delete compatibility assignments derived from this assignment
    const CompatibilityAssignment = (await import('../models/CompatibilityAssignment.js')).default;
    await CompatibilityAssignment.deleteMany({ sourceAssignment: id });

    // Delete listing completions related to this assignment
    const ListingCompletion = (await import('../models/ListingCompletion.js')).default;
    await ListingCompletion.deleteMany({ assignment: id });

    // Finally delete the assignment itself
    await Assignment.findByIdAndDelete(id);

    res.json({ message: 'Assignment and related data deleted successfully.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to delete assignment.' });
  }
});


/* -------------------- LISTER FLOWS (FIXED) -------------------- */

/**
 * @swagger
 * /assignments/mine:
 *   get:
 *     tags: [Assignments]
 *     summary: Get current lister's assignments
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Returns all assignments where the lister field matches the logged-in user.
 *       Accessible to listers, listingadmin, and superadmin with Assignments page access.
 *     responses:
 *       200: { description: Array of populated assignment objects }
 *       401: { description: Unauthorized }
 */
// List assignments for the logged-in lister
router.get('/mine',
  requireAuth,
  requirePageAccess('Assignments', ['superadmin', 'listingadmin', 'lister']),
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
        .sort({ createdAt: -1 })
        .lean();

      res.json(items);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to fetch my assignments.' });
    }
  }
);
/**
 * @swagger
 * /assignments/mine/with-status:
 *   get:
 *     tags: [Assignments]
 *     summary: Get current lister's assignments with today's completion status
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Returns today's (and overdue) assignments for the logged-in lister,
 *       enriched with completion status. Accessible to listers, listingadmin, superadmin.
 *     responses:
 *       200: { description: Array of assignments with status fields }
 *       401: { description: Unauthorized }
 */
router.get('/mine/with-status',
  requireAuth,
  requirePageAccess('Assignments', ['superadmin', 'listingadmin', 'lister']),
  async (req, res) => {
    try {
      const me = req.user?.userId || req.user?.id;
      if (!me) return res.status(401).json({ message: 'Unauthorized' });

      const meObjId = mongoose.Types.ObjectId.isValid(me) ? new mongoose.Types.ObjectId(me) : me;

      const today = new Date();
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

      // Only fetch assignments where scheduledDate <= today
      const allAssignments = await Assignment.find({
        lister: meObjId,
        scheduledDate: { $lte: endOfToday }
      })
        .populate([
          { path: 'task', populate: [{ path: 'sourcePlatform createdBy category subcategory range', select: 'name username' }] },
          { path: 'listingPlatform', select: 'name' },
          { path: 'store', select: 'name' },
          { path: 'rangeQuantities.range', select: 'name' },
        ])
        .sort({ scheduledDate: -1, createdAt: -1 });

      const todaysTasks = [];
      const pendingTasks = [];
      const completedTasks = [];

      for (const a of allAssignments) {
        // An assignment is only "completed" when explicitly submitted (completedAt is set)
        // Not when ranges are just added
        const isCompleted = !!a.completedAt;

        // Use scheduledDate instead of createdAt to categorize
        const scheduledAt = new Date(a.scheduledDate);
        const isToday = scheduledAt >= startOfToday && scheduledAt < endOfToday;

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
/**
 * @swagger
 * /assignments/{id}/complete:
 *   post:
 *     tags: [Assignments]
 *     summary: Mark assignment as complete (simple quantity method)
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Sets `completedQuantity` on the assignment. Listers can only complete their own.
 *       Admins can complete any.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [completedQuantity]
 *             properties:
 *               completedQuantity: { type: integer, minimum: 0 }
 *     responses:
 *       200: { description: Updated assignment }
 *       400: { description: Invalid completedQuantity }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Assignment not found }
 */
router.post('/:id/complete',
  requireAuth,
  requirePageAccess('Assignments', ['superadmin', 'listingadmin', 'lister']),
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

/**
 * @swagger
 * /assignments/analytics/admin-lister:
 *   get:
 *     tags: [Assignments]
 *     summary: Admin-lister assignment analytics
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Groups assignments by (IST date, assigning admin, lister) with quantity totals and
 *       completion counts. Requires Assignments page access (superadmin / listingadmin / productadmin).
 *     responses:
 *       200: { description: Array of per-day per-admin-lister rows }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/analytics/admin-lister',
  requireAuth,
  requirePageAccess('Assignments', ['superadmin', 'listingadmin', 'productadmin']),
  async (req, res) => {
    try {
      const rows = await Assignment.aggregate([
        {
          $project: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$scheduledDate", timezone: IST_TZ } },

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

/**
 * @swagger
 * /assignments/analytics/listings-summary:
 *   get:
 *     tags: [Assignments]
 *     summary: Listings summary by day, platform, and store
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Aggregates assignment quantities grouped by (IST scheduled date, platform, store).
 *       Supports dateMode/dateSingle/dateFrom/dateTo, platformId, storeId filters.
 *       Requires Assignments page access (superadmin / listingadmin / productadmin).
 *     parameters:
 *       - { in: query, name: platformId, schema: { type: string } }
 *       - { in: query, name: storeId, schema: { type: string } }
 *       - { in: query, name: dateMode, schema: { type: string, enum: [single, range] } }
 *       - { in: query, name: dateSingle, schema: { type: string, format: date } }
 *       - { in: query, name: dateFrom, schema: { type: string, format: date } }
 *       - { in: query, name: dateTo, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Array of listings summary rows }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/analytics/listings-summary',
  requireAuth,
  requirePageAccess('Assignments', ['superadmin', 'listingadmin', 'productadmin']),
  async (req, res) => {
    try {
      const { platformId, storeId, dateMode, dateSingle, dateFrom, dateTo } = req.query;

      // Build match conditions
      const matchConditions = [];
      if (platformId) matchConditions.push({ $match: { listingPlatform: new mongoose.Types.ObjectId(platformId) } });
      if (storeId) matchConditions.push({ $match: { store: new mongoose.Types.ObjectId(storeId) } });

      // Date filtering (IST timezone)
      if (dateMode === 'single' && dateSingle) {
        const startDate = new Date(dateSingle + 'T00:00:00+05:30');
        const endDate = new Date(dateSingle + 'T23:59:59+05:30');
        matchConditions.push({ $match: { scheduledDate: { $gte: startDate, $lte: endDate } } });
      } else if (dateMode === 'range') {
        const dateMatch = {};
        if (dateFrom) dateMatch.$gte = new Date(dateFrom + 'T00:00:00+05:30');
        if (dateTo) dateMatch.$lte = new Date(dateTo + 'T23:59:59+05:30');
        if (Object.keys(dateMatch).length > 0) {
          matchConditions.push({ $match: { scheduledDate: dateMatch } });
        }
      }

      const rows = await Assignment.aggregate([
        ...matchConditions,

        { $lookup: { from: "tasks", localField: "task", foreignField: "_id", as: "task" } },
        { $unwind: "$task" },

        {
          $project: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$scheduledDate", timezone: IST_TZ } },

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
        // First, group by assignment to ensure each assignment is counted only once
        // even if it has multiple ranges
        {
          $group: {
            _id: "$_id", // Group by assignment ID
            date: { $first: "$date" },
            platformId: { $first: "$platformId" },
            storeId: { $first: "$storeId" },
            listerId: { $first: "$listerId" },
            quantity: { $first: "$quantity" },
            completedQuantity: { $first: "$completedQuantity" },
            categoryId: { $first: "$categoryId" },
            subcategoryId: { $first: "$subcategoryId" },
            rangeQuantities: { $first: "$rangeQuantities" }
          }
        },
        // Now group by date, platform, and store
        {
          $group: {
            _id: { date: "$date", platformId: "$platformId", storeId: "$storeId" },
            // Sum all assignment quantities (each assignment counted once)
            totalQuantity: { $sum: "$quantity" },
            totalCompletedQty: { $sum: "$completedQuantity" },
            // Count unique values
            assignmentIds: { $addToSet: "$_id" },
            listers: { $addToSet: "$listerId" },
            categories: { $addToSet: "$categoryId" },
            subcategories: { $addToSet: "$subcategoryId" },
            // Collect all rangeQuantities arrays
            allRangeQuantities: { $push: "$rangeQuantities" }
          }
        },
        {
          $project: {
            _id: 0,
            date: "$_id.date",
            platformId: "$_id.platformId",
            storeId: "$_id.storeId",
            totalQuantity: 1,
            assignmentsCount: { $size: "$assignmentIds" },
            completedQty: "$totalCompletedQty",
            numListers: { $size: "$listers" },
            numCategories: { $size: "$categories" },
            numSubcategories: { $size: "$subcategories" },
            numRanges: {
              $size: {
                $reduce: {
                  input: "$allRangeQuantities",
                  initialValue: [],
                  in: {
                    $setUnion: [
                      "$$value",
                      {
                        $map: {
                          input: { $filter: { input: "$$this", as: "rq", cond: { $ne: ["$$rq.range", null] } } },
                          as: "rq",
                          in: "$$rq.range"
                        }
                      }
                    ]
                  }
                }
              }
            }
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
/**
 * @swagger
 * /assignments/analytics/stock-ledger:
 *   get:
 *     tags: [Assignments]
 *     summary: Stock ledger — assigned vs completed totals by platform, store, category, range
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Aggregates rangeQuantities from assignments to produce a per-(platform, store, category, range)
 *       stock ledger with totalAssigned, totalCompleted, and pending counts.
 *       Requires Assignments page access (superadmin / listingadmin / productadmin).
 *     parameters:
 *       - { in: query, name: platformId, schema: { type: string } }
 *       - { in: query, name: storeId, schema: { type: string } }
 *       - { in: query, name: categoryId, schema: { type: string } }
 *       - { in: query, name: subcategoryId, schema: { type: string } }
 *       - { in: query, name: category, schema: { type: string, description: Filter by category name (comma-separated) } }
 *       - { in: query, name: range, schema: { type: string, description: Filter by range name (comma-separated) } }
 *     responses:
 *       200: { description: Array of stock ledger rows }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get(
  '/analytics/stock-ledger',
  requireAuth,
  requirePageAccess('Assignments', ['superadmin', 'listingadmin', 'productadmin']),
  async (req, res) => {
    try {
      const { platformId, storeId, categoryId, subcategoryId, category, range } = req.query || {};
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

        // (Optional) filters for category/subcategory after join (by ID)
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

      // Apply filters by name (after lookups)
      if (category) {
        const categories = category.split(',');
        pipeline.push({ $match: { category: { $in: categories } } });
      }
      if (range) {
        const ranges = range.split(',');
        pipeline.push({ $match: { range: { $in: ranges } } });
      }

      const rows = await Assignment.aggregate(pipeline);
      res.json(rows);
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to compute stock ledger.' });
    }
  }
);

/* -------------------- RANGE QUANTITY DISTRIBUTION -------------------- */

/**
 * @swagger
 * /assignments/{id}/ranges:
 *   get:
 *     tags: [Assignments]
 *     summary: Get range quantity distribution for an assignment
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Returns the rangeQuantities array for the given assignment.
 *       Listers can only view their own; admins can view any.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of range-quantity objects }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Assignment not found }
 */
// Get range quantity distribution for an assignment
router.get('/:id/ranges',
  requireAuth,
  requirePageAccess('Assignments', ['superadmin', 'listingadmin', 'lister']),
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
/**
 * @swagger
 * /assignments/{id}/complete-range:
 *   post:
 *     tags: [Assignments]
 *     summary: Add or update a range-level quantity on an assignment
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Sets or adds `quantity` for a specific `rangeId` in the assignment's rangeQuantities array.
 *       Automatically updates `completedQuantity` and sets `completedAt` when total distributed
 *       meets the assigned quantity. Listers can only update their own assignments.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rangeId, quantity]
 *             properties:
 *               rangeId: { type: string }
 *               quantity: { type: integer, minimum: 0 }
 *               mode: { type: string, enum: [set, add], default: set }
 *     responses:
 *       200: { description: Updated assignment (populated) }
 *       400: { description: Invalid rangeId/quantity or range not in task category }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Assignment or range not found }
 */
router.post('/:id/complete-range',
  requireAuth,
  requirePageAccess('Assignments', ['superadmin', 'listingadmin', 'lister', 'advancelister', 'trainee']),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { rangeId, quantity, mode = 'set' } = req.body || {};
      // mode: 'set' = replace quantity, 'add' = add to existing quantity

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

      if (quantity === 0 && mode === 'set') {
        // Remove the range if quantity is 0 (only in set mode)
        if (existingIndex >= 0) {
          doc.rangeQuantities.splice(existingIndex, 1);
        }
      } else {
        // Update or add range
        if (existingIndex >= 0) {
          // Update existing - either set or add based on mode
          if (mode === 'add') {
            doc.rangeQuantities[existingIndex].quantity += quantity;
          } else {
            doc.rangeQuantities[existingIndex].quantity = quantity;
          }
        } else {
          // Add new
          doc.rangeQuantities.push({ range: rangeId, quantity });
        }
      }

      // Calculate total distributed quantity
      const totalDistributed = doc.rangeQuantities.reduce((sum, rq) => sum + (rq.quantity || 0), 0);

      // Update completedQuantity
      doc.completedQuantity = Math.min(totalDistributed, doc.quantity);

      // Auto-complete assignment when total distributed equals or exceeds assigned quantity
      if (totalDistributed >= doc.quantity && !doc.completedAt) {
        doc.completedAt = new Date();
      }

      // Reset completedAt if user removes ranges and falls below required quantity
      if (totalDistributed < doc.quantity && doc.completedAt) {
        doc.completedAt = null;
      }

      await doc.save();

      // NOTE: ListingCompletion is NOT created here anymore
      // It will only be created when lister explicitly presses "Submit Assignment"
      // This prevents accidental/incomplete work from showing up in Listing Sheet

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
/**
 * @swagger
 * /assignments/{id}/submit:
 *   post:
 *     tags: [Assignments]
 *     summary: Submit an assignment as fully complete
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Validates total distributed quantity equals the assigned quantity, then marks the
 *       assignment complete and creates or updates the ListingCompletion record.
 *       Listers can only submit their own; admins can submit any.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Completed assignment (populated) }
 *       400: { description: Distributed quantity less than assigned quantity }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Assignment not found }
 */
router.post('/:id/submit',
  requireAuth,
  requirePageAccess('Assignments', ['superadmin', 'listingadmin', 'lister']),
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

      // Update or create ListingCompletion record
      const existingCompletion = await ListingCompletion.findOne({ assignment: doc._id });

      const completionData = {
        date: new Date(),
        assignment: doc._id,
        task: doc.task._id,
        lister: doc.lister,
        listingPlatform: doc.listingPlatform,
        store: doc.store,
        marketplace: doc.marketplace,
        category: doc.task.category,
        subcategory: doc.task.subcategory,
        rangeCompletions: doc.rangeQuantities
          .filter(rq => rq.quantity > 0)
          .map(rq => ({ range: rq.range, quantity: rq.quantity })),
        totalQuantity: totalDistributed,
      };

      if (existingCompletion) {
        Object.assign(existingCompletion, completionData);
        await existingCompletion.save();
      } else {
        await ListingCompletion.create(completionData);
      }

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

// --- NEW ROUTE: BULK ASSIGNMENT ---
/**
 * @swagger
 * /assignments/bulk:
 *   post:
 *     tags: [Assignments]
 *     summary: Create multiple assignments in one request
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Creates one assignment per item in the `assignments` array, all assigned to the same lister
 *       and listing platform. Each item may specify its own `storeId`; falls back to `storeId`
 *       at the top level. Returns successfully created assignments plus an `errors` array.
 *       **Requires Assignments page access.**
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listerId, listingPlatformId, assignments]
 *             properties:
 *               listerId: { type: string }
 *               listingPlatformId: { type: string }
 *               storeId: { type: string, description: Default store — used when an item has no storeId }
 *               notes: { type: string }
 *               scheduledDate: { type: string, format: date-time }
 *               assignments:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [taskId, quantity]
 *                   properties:
 *                     taskId: { type: string }
 *                     quantity: { type: integer }
 *                     storeId: { type: string }
 *     responses:
 *       201:
 *         description: Object with created assignments array and errors array
 *       400: { description: Missing required fields }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.post('/bulk', requireAuth, requirePageAccess('Assignments'), async (req, res) => {
  try {
    const {
      listerId,
      listingPlatformId,
      storeId: defaultStoreId, // Renamed to clarify it's a fallback
      notes,
      scheduledDate,
      assignments // Array of { taskId, quantity, storeId }
    } = req.body || {};

    if (!listerId || !listingPlatformId || !assignments || !Array.isArray(assignments) || assignments.length === 0) {
      return res.status(400).json({ message: 'Missing required fields or assignments list.' });
    }

    const creatorId = (req.user && (req.user.userId || req.user.id));
    const schedDate = scheduledDate ? new Date(scheduledDate) : new Date();

    const createdAssignments = [];
    const errors = [];

    for (const item of assignments) {
      const { taskId, quantity, storeId } = item;

      // Use specific storeId if provided, otherwise fallback to default
      const finalStoreId = storeId || defaultStoreId;

      if (!finalStoreId) {
        errors.push(`Task ${taskId} missing Store ID`);
        continue;
      }

      try {
        const task = await Task.findById(taskId);
        if (!task) {
          errors.push(`Task ${taskId} not found`);
          continue;
        }

        if (!task.marketplace) {
          errors.push(`Task ${task.productTitle} missing marketplace`);
          continue;
        }

        const doc = await Assignment.create({
          task: taskId,
          lister: listerId,
          quantity: Number(quantity),
          listingPlatform: listingPlatformId,
          store: finalStoreId, // Uses the resolved store ID
          marketplace: task.marketplace,
          createdBy: creatorId,
          notes: notes || '',
          scheduledDate: schedDate,
        });

        createdAssignments.push(doc);
      } catch (err) {
        console.error(`Failed to assign task ${taskId}:`, err);
        errors.push(`Failed to assign task ${taskId}`);
      }
    }

    res.status(201).json({
      success: true,
      count: createdAssignments.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (e) {
    console.error('Bulk assign error:', e);
    res.status(500).json({ message: 'Failed to process bulk assignments.' });
  }
});
export default router;

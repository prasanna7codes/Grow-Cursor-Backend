import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createTaskSchema, createAssignmentSchema } from '../schemas/index.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import { parsePagination } from '../utils/paginate.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Tasks
 *   description: Product research tasks and listing analytics
 */

/**
 * @swagger
 * /tasks:
 *   post:
 *     tags: [Tasks]
 *     summary: Create a product research task
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Creates a new task (product research entry). Requires TaskList or ProductResearch page access.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productTitle, supplierLink, sourcePrice, sellingPrice, marketplace]
 *             properties:
 *               productTitle: { type: string }
 *               supplierLink: { type: string }
 *               sourcePrice: { type: number }
 *               sellingPrice: { type: number }
 *               quantity: { type: integer }
 *               marketplace: { type: string, example: EBAY_US }
 *               categoryId: { type: string }
 *               subcategoryId: { type: string }
 *               rangeId: { type: string }
 *               listingPlatformId: { type: string }
 *               storeId: { type: string }
 *               assignedListerId: { type: string }
 *               date: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Created task object
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
// Create a product research entry (productadmin or superadmin or users with ProductResearch permission)
router.post('/', requireAuth, requirePageAccess(['TaskList', 'ProductResearch']), validate(createTaskSchema), async (req, res) => {
  const body = req.body || {};
  try {
    // normalize legacy field names and defaults
    if (!body.supplierLink && body.link) body.supplierLink = body.link;
    
    // Validate marketplace
    if (!body.marketplace) {
      return res.status(400).json({ error: 'marketplace is required' });
    }
    
    // createdBy is derived from auth; date defaults if not provided
    const task = await Task.create({
      date: body.date ? new Date(body.date) : new Date(),
      productTitle: body.productTitle,
      supplierLink: body.supplierLink,
      sourcePrice: body.sourcePrice,
      sellingPrice: body.sellingPrice,
      quantity: body.quantity || null,
      completedQuantity: 0,
      sourcePlatform: body.sourcePlatformId,
      marketplace: body.marketplace,
      category: body.categoryId,
      subcategory: body.subcategoryId,
      range: body.rangeId || null,
      listingPlatform: body.listingPlatformId || null,
      store: body.storeId || null,
      assignedLister: body.assignedListerId || null,
      status: 'draft',
      createdBy: req.user.userId
    });
    await task.populate(['category', 'subcategory', 'range', 'sourcePlatform']);
    res.json(task);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * @swagger
 * /tasks:
 *   get:
 *     tags: [Tasks]
 *     summary: List tasks
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       productadmin and listingadmin see all tasks.
 *       Listers see only tasks assigned to them unless they have the ProductResearch permission.
 *     parameters:
 *       - { in: query, name: platformId, schema: { type: string } }
 *       - { in: query, name: storeId, schema: { type: string } }
 *       - { in: query, name: listerId, schema: { type: string } }
 *       - { in: query, name: date, schema: { type: string, format: date } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: sortBy, schema: { type: string, default: date } }
 *       - { in: query, name: sortOrder, schema: { type: string, enum: [asc, desc], default: desc } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: Array of task objects (or paginated wrapper when page/limit supplied)
 *       401: { description: Unauthorized }
 */
// List tasks (productadmin see all; listingadmin see all; listers see assigned to them UNLESS they have ProductResearch permission)
router.get('/', requireAuth, async (req, res) => {
  const { role, userId } = req.user;
  const { platformId, storeId, listerId, date, sortBy = 'date', sortOrder = 'desc', search } = req.query || {};
  const { page, limit } = req.query; // <-- no defaults here

  try {
    // Fetch user's custom permissions from database
    const user = await User.findById(userId).select('pagePermissions useCustomPermissions').lean();
    
    // Check if lister has custom permission for ProductResearch
    const hasProductResearchAccess = user && 
      user.useCustomPermissions && 
      user.pagePermissions && 
      user.pagePermissions.includes('ProductResearch');

    // Listers can only see their assigned tasks UNLESS they have ProductResearch permission
    const query = (role === 'lister' && !hasProductResearchAccess) 
      ? { assignedLister: userId } 
      : {};

    if (role !== 'lister' || hasProductResearchAccess) {
      if (platformId) query.listingPlatform = platformId;
      if (storeId) query.store = storeId;
      if (listerId) query.assignedLister = listerId;
      if (date) {
        const d = new Date(date);
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        query.date = { $gte: start, $lt: end };
      }
    }

    if (search) {
      query.$or = [
        { productTitle: { $regex: search, $options: 'i' } },
        { supplierLink: { $regex: search, $options: 'i' } }
      ];
    }

    const sortOptions = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
    const base = Task.find(query)
      .sort(sortOptions)
      .populate('sourcePlatform')
      .populate('category')
      .populate('subcategory')
      .populate('range')
      .populate('listingPlatform')
      .populate('store')
      .populate('assignedLister', 'email username')
      .populate('createdBy', 'username');

    // If the client did NOT request pagination, return ALL results.
    if (page === undefined && limit === undefined) {
      const tasks = await base;
      return res.json(tasks);
    }

    // Otherwise, do normal pagination.
    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query, { defaultLimit: 10, maxLimit: 500 });
    const [total, tasks] = await Promise.all([
      Task.countDocuments(query),
      base.skip(skip).limit(limitNum)
    ]);

    res.json({
      tasks,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum)
    });
  } catch (e) {
    console.error('Error fetching tasks:', e);
    res.status(500).json({ error: e.message });
  }
});


/**
 * @swagger
 * /tasks/{id}/assign:
 *   post:
 *     tags: [Tasks]
 *     summary: Assign a task to a lister
 *     security:
 *       - bearerAuth: []
 *     description: Requires Assignments page access (listingadmin / superadmin).
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listerId, quantity, listingPlatformId, storeId]
 *             properties:
 *               listerId: { type: string }
 *               quantity: { type: integer }
 *               listingPlatformId: { type: string }
 *               storeId: { type: string }
 *     responses:
 *       200: { description: Updated task }
 *       400: { description: Missing required fields }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Task not found }
 */
// Assign a task to a lister (listingadmin or superadmin)
router.post('/:id/assign', requireAuth, requirePageAccess('Assignments'), asyncHandler(async (req, res) => {
  const { listerId, quantity, listingPlatformId, storeId } = req.body || {};
  if (!listerId) return res.status(400).json({ error: 'listerId required' });
  if (!quantity) return res.status(400).json({ error: 'quantity required' });
  if (!listingPlatformId) return res.status(400).json({ error: 'listingPlatformId required' });
  if (!storeId) return res.status(400).json({ error: 'storeId required' });
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  task.assignedLister = listerId;
  task.quantity = quantity;
  task.listingPlatform = listingPlatformId;
  task.store = storeId;
  task.status = 'assigned';
  task.assignedBy = req.user.userId;
  task.assignedAt = new Date();
  await task.save();
  res.json(task);
}));

/**
 * @swagger
 * /tasks/{id}:
 *   put:
 *     tags: [Tasks]
 *     summary: Update task fields
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       productadmin can edit product research fields.
 *       listingadmin can reassign the lister, platform, or store.
 *       Requires TaskList or ProductResearch page access.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: Updated task }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Task not found }
 */
// Update task fields (productadmin edits product fields; listingadmin can reassign)
router.put('/:id', requireAuth, requirePageAccess(['TaskList', 'ProductResearch']), async (req, res) => {
  const { role, userId } = req.user;
  const updates = req.body || {};
  
  try {
    // Fetch user's custom permissions
    const user = await User.findById(userId).select('pagePermissions useCustomPermissions').lean();
    const hasProductResearchAccess = user && 
      user.useCustomPermissions && 
      user.pagePermissions && 
      user.pagePermissions.includes('ProductResearch');
    
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    
    if (role === 'productadmin' || role === 'superadmin' || hasProductResearchAccess) {
      // Product admin or users with ProductResearch permission can edit product fields
      if (updates.date !== undefined) task.date = new Date(updates.date);
      if (updates.productTitle !== undefined) task.productTitle = updates.productTitle;
      if (updates.supplierLink !== undefined) task.supplierLink = updates.supplierLink;
      if (updates.sourcePrice !== undefined) task.sourcePrice = updates.sourcePrice;
      if (updates.sellingPrice !== undefined) task.sellingPrice = updates.sellingPrice;
      if (updates.sourcePlatformId !== undefined) task.sourcePlatform = updates.sourcePlatformId;
      if (updates.categoryId !== undefined) task.category = updates.categoryId;
      if (updates.subcategoryId !== undefined) task.subcategory = updates.subcategoryId;
      if (updates.rangeId !== undefined) task.range = updates.rangeId;
    } else if (role === 'listingadmin') {
      // Listing admin can reassign lister, update quantity, listing platform, store
      if (updates.listerId !== undefined) task.assignedLister = updates.listerId;
      if (updates.quantity !== undefined) task.quantity = updates.quantity;
      if (updates.listingPlatformId !== undefined) task.listingPlatform = updates.listingPlatformId;
      if (updates.storeId !== undefined) task.store = updates.storeId;
    }
    await task.save();
    await task.populate(['category', 'subcategory', 'range', 'sourcePlatform', 'listingPlatform', 'store', 'assignedLister', 'createdBy']);
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lister marks completed
/**
 * @swagger
 * /tasks/{id}/complete:
 *   post:
 *     tags: [Tasks]
 *     summary: Mark a task as complete
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Lister marks their own assigned task as complete by submitting the actual completed quantity.
 *       Requires TaskList page access and lister role.
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
 *       200: { description: Updated task }
 *       400: { description: Invalid quantity }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Task not found }
 */
router.post('/:id/complete', requireAuth, requirePageAccess('TaskList', ['lister']), asyncHandler(async (req, res) => {
  const { userId } = req.user;
  const { completedQuantity } = req.body || {};
  const task = await Task.findOne({ _id: req.params.id, assignedLister: userId });
  if (!task) return res.status(404).json({ error: 'Not found' });
  const qty = Math.max(0, Math.min(Number(completedQuantity ?? task.quantity), task.quantity));
  task.completedQuantity = qty;
  if (task.completedQuantity >= task.quantity) {
    task.status = 'completed';
    task.completedAt = new Date();
  } else {
    task.status = 'assigned';
    task.completedAt = undefined;
  }
  await task.save();
  res.json(task);
}));

/**
 * @swagger
 * /tasks/analytics:
 *   get:
 *     tags: [Tasks]
 *     summary: Admin-side task analytics summary
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Returns aggregated totals (totalListings, completedQty, numListers, numStores, numCategories).
 *       Requires ListingsSummary page access.
 *     parameters:
 *       - { in: query, name: platformId, schema: { type: string } }
 *       - { in: query, name: storeId, schema: { type: string } }
 *       - { in: query, name: listerId, schema: { type: string } }
 *       - { in: query, name: date, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Aggregated totals object }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
// Admin-side analytics (platform/store/lister/date filters)
router.get('/analytics', requireAuth, requirePageAccess('ListingsSummary'), asyncHandler(async (req, res) => {
  const { platformId, storeId, listerId, date } = req.query || {};
  const match = {};
  if (platformId) match.listingPlatform = platformId;
  if (storeId) match.store = storeId;
  if (listerId) match.assignedLister = listerId;
  if (date) {
    const d = new Date(date);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    match.date = { $gte: start, $lt: end };
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        totalListings: { $sum: '$quantity' },
        numListers: { $addToSet: '$assignedLister' },
        numStores: { $addToSet: '$store' },
        categories: { $addToSet: '$category' },
        subcategories: { $addToSet: '$subcategory' },
        completedQty: { $sum: { $ifNull: ['$completedQuantity', 0] } },
      }
    },
    {
      $project: {
        _id: 0,
        totalListings: 1,
        completedQty: 1,
        numListers: { $size: '$numListers' },
        numStores: { $size: '$numStores' },
        numCategories: { $size: '$categories' },
        numSubcategories: { $size: '$subcategories' }
      }
    }
  ];

  const [result] = await Task.aggregate(pipeline);
  res.json(result || { totalListings: 0, numListers: 0, numStores: 0, numCategories: 0, numSubcategories: 0 });
}));

/**
 * @swagger
 * /tasks/analytics/admin-lister:
 *   get:
 *     tags: [Tasks]
 *     summary: Admin-lister task assignment summary
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Groups tasks by (day, assigning admin, lister) with task counts and completed quantities.
 *       Requires ListerInfo page access.
 *     parameters:
 *       - { in: query, name: platformId, schema: { type: string } }
 *       - { in: query, name: storeId, schema: { type: string } }
 *       - { in: query, name: listerId, schema: { type: string } }
 *       - { in: query, name: date, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Array of per-day per-admin-lister rows }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
// Superadmin/listingadmin: admin-lister assignment summary
router.get('/analytics/admin-lister', requireAuth, requirePageAccess('ListerInfo'), asyncHandler(async (req, res) => {
  const { platformId, storeId, listerId, date } = req.query || {};
  const match = {};
  if (platformId) match.listingPlatform = platformId;
  if (storeId) match.store = storeId;
  if (listerId) match.assignedLister = listerId;
  if (date) {
    const d = new Date(date);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    match.date = { $gte: start, $lt: end };
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, admin: '$assignedBy', lister: '$assignedLister' },
        tasksCount: { $sum: 1 },
        quantityTotal: { $sum: { $ifNull: ['$quantity', 0] } },
        completedCount: { $sum: { $cond: [{ $gt: ['$completedQuantity', 0] }, 1, 0] } },
        completedQty: { $sum: { $ifNull: ['$completedQuantity', 0] } }
      }
    },
    {
      $lookup: { from: 'users', localField: '_id.admin', foreignField: '_id', as: 'admin' }
    },
    { $unwind: { path: '$admin', preserveNullAndEmptyArrays: true } },
    {
      $lookup: { from: 'users', localField: '_id.lister', foreignField: '_id', as: 'lister' }
    },
    { $unwind: { path: '$lister', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        date: '$_id.day',
        adminId: '$_id.admin',
        listerId: '$_id.lister',
        adminName: '$admin.username',
        listerName: '$lister.username',
        tasksCount: 1,
        quantityTotal: 1,
        completedCount: 1,
        completedQty: 1
      }
    },
    { $sort: { date: -1, adminName: 1, listerName: 1 } }
  ];

  const rows = await Task.aggregate(pipeline);
  res.json(rows);
}));

/**
 * @swagger
 * /tasks/analytics/daily:
 *   get:
 *     tags: [Tasks]
 *     summary: Daily task totals
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Groups all tasks by day and returns totalQuantity, numListers, numStores, numCategories per day.
 *       Requires StoreDailyTasks page access.
 *     parameters:
 *       - { in: query, name: platformId, schema: { type: string } }
 *       - { in: query, name: storeId, schema: { type: string } }
 *       - { in: query, name: listerId, schema: { type: string } }
 *     responses:
 *       200: { description: Array of daily aggregate rows sorted by date desc }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
// Daily totals (optionally filtered by platform/store/lister)
router.get('/analytics/daily', requireAuth, requirePageAccess('StoreDailyTasks'), asyncHandler(async (req, res) => {
  const { platformId, storeId, listerId } = req.query || {};
  const match = {};
  if (platformId) match.listingPlatform = platformId;
  if (storeId) match.store = storeId;
  if (listerId) match.assignedLister = listerId;

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } } },
        totalQuantity: { $sum: '$quantity' },
        numListers: { $addToSet: '$assignedLister' },
        numStores: { $addToSet: '$store' },
        categories: { $addToSet: '$category' },
        subcategories: { $addToSet: '$subcategory' }
      }
    },
    {
      $project: {
        _id: 0,
        date: '$_id.day',
        totalQuantity: 1,
        numListers: { $size: '$numListers' },
        numStores: { $size: '$numStores' },
        numCategories: { $size: '$categories' },
        numSubcategories: { $size: '$subcategories' }
      }
    },
    { $sort: { date: -1 } }
  ];

  const rows = await Task.aggregate(pipeline);
  res.json(rows);
}));

/**
 * @swagger
 * /tasks/analytics/lister-daily:
 *   get:
 *     tags: [Tasks]
 *     summary: Per-lister daily breakdown
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Groups tasks by (day, platform, store) for a specific lister with completion stats.
 *       Requires ListerInfo page access.
 *     parameters:
 *       - { in: query, name: listerId, schema: { type: string } }
 *       - { in: query, name: platformId, schema: { type: string } }
 *       - { in: query, name: storeId, schema: { type: string } }
 *     responses:
 *       200: { description: Array of per-day per-platform rows }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
// Per-lister per day with platform/store breakdown
router.get('/analytics/lister-daily', requireAuth, requirePageAccess('ListerInfo'), asyncHandler(async (req, res) => {
  const { listerId, platformId, storeId } = req.query || {};
  const match = {};
  if (listerId) match.assignedLister = listerId;
  if (platformId) match.listingPlatform = platformId;
  if (storeId) match.store = storeId;

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          platform: '$listingPlatform',
          store: '$store'
        },
        tasksCount: { $sum: 1 },
        quantityTotal: { $sum: '$quantity' },
        completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        completedQty: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$quantity', 0] } },
        ranges: { $addToSet: '$range' },
        categories: { $addToSet: '$category' }
      }
    },
    { $lookup: { from: 'platforms', localField: '_id.platform', foreignField: '_id', as: 'platform' } },
    { $unwind: { path: '$platform', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'stores', localField: '_id.store', foreignField: '_id', as: 'store' } },
    { $unwind: { path: '$store', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        date: '$_id.day',
        platform: '$platform.name',
        store: '$store.name',
        tasksCount: 1,
        quantityTotal: 1,
        completedCount: 1,
        completedQty: 1,
        numCategories: { $size: '$categories' },
        numSubcategories: { $size: '$subcategories' }
      }
    },
    { $sort: { date: -1, platform: 1, store: 1 } }
  ];

  const rows = await Task.aggregate(pipeline);
  res.json(rows);
}));

/**
 * @swagger
 * /tasks/analytics/listings-summary:
 *   get:
 *     tags: [Tasks]
 *     summary: Listings summary grouped by day, platform, and store
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Returns assignment-based summary rows (totalQuantity, numListers, numCategories, assignmentsCount)
 *       grouped by (day, platform, store). Requires ListingsSummary page access.
 *     parameters:
 *       - { in: query, name: platformId, schema: { type: string } }
 *       - { in: query, name: storeId, schema: { type: string } }
 *     responses:
 *       200: { description: Array of listing summary rows }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
// Listings summary grouped by assignment-day, platform and store (optional filters: platformId, storeId)
router.get('/analytics/listings-summary', requireAuth, requirePageAccess('ListingsSummary'), asyncHandler(async (req, res) => {
  const { platformId, storeId } = req.query || {};
  const match = {};
  if (platformId) match.listingPlatform = new mongoose.Types.ObjectId(platformId);
  if (storeId) match.store = new mongoose.Types.ObjectId(storeId);

  // Include both assigned and completed tasks
  match.status = { $in: ['assigned', 'completed'] };
  
  const pipeline = [
    { $match: match },
    // Look up platform first to ensure we only get listing platforms
    { $lookup: { from: 'platforms', localField: 'listingPlatform', foreignField: '_id', as: 'platformData' } },
    { $unwind: '$platformData' },
    // Only include tasks for listing platforms
    { $match: { 'platformData.type': 'listing' } },
    // Look up store
    { $lookup: { from: 'stores', localField: 'store', foreignField: '_id', as: 'storeData' } },
    { $unwind: { path: '$storeData', preserveNullAndEmptyArrays: true } },
    // Group by day, platform, and store
    {
      $group: {
        _id: {
          day: { $dateToString: { format: '%Y-%m-%d', date: { $ifNull: ['$assignedAt', '$date'] } } },
          platform: '$listingPlatform',
          platformName: '$platformData.name',
          store: '$store',
          storeName: '$storeData.name'
        },
        totalQuantity: { $sum: { $ifNull: ['$quantity', 0] } },
        listers: { $addToSet: '$assignedLister' },
        ranges: { $addToSet: '$range' },
        categories: { $addToSet: '$category' },
        assignmentsCount: { $sum: 1 }
      }
    },
    {
      $project: {
        _id: 0,
        date: '$_id.day',
        platformId: '$_id.platform',
        platform: '$_id.platformName',
        storeId: '$_id.store',
        store: '$_id.storeName',
        totalQuantity: 1,
        numListers: { $size: '$listers' },
        numCategories: { $size: '$categories' },
        numSubcategories: { $size: '$subcategories' },
        assignmentsCount: 1
      }
    },
    { $sort: { date: -1, platform: 1, store: 1 } }
  ];

  const rows = await Task.aggregate(pipeline);
  res.json(rows);
}));

/**
 * @swagger
 * /tasks/{id}:
 *   delete:
 *     tags: [Tasks]
 *     summary: Delete a task (cascade)
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Deletes the task and cascades to: all Assignments, CompatibilityAssignments, and ListingCompletions
 *       that reference this task. Requires TaskList or ProductResearch page access.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deletion confirmation message }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Task not found }
 */
// Delete a task and cascade to assignments and compatibility assignments
router.delete('/:id', requireAuth, requirePageAccess(['TaskList', 'ProductResearch']), async (req, res) => {
  try {
    const taskId = req.params.id;
    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Import models for cascade delete
    const Assignment = (await import('../models/Assignment.js')).default;
    const CompatibilityAssignment = (await import('../models/CompatibilityAssignment.js')).default;
    const ListingCompletion = (await import('../models/ListingCompletion.js')).default;

    // Find all assignments related to this task
    const assignments = await Assignment.find({ task: taskId });
    const assignmentIds = assignments.map(a => a._id);

    // Delete all compatibility assignments that reference these assignments
    await CompatibilityAssignment.deleteMany({ sourceAssignment: { $in: assignmentIds } });

    // Delete all compatibility assignments that reference this task directly
    await CompatibilityAssignment.deleteMany({ task: taskId });

    // Delete all listing completions related to this task
    await ListingCompletion.deleteMany({ task: taskId });

    // Delete all listing completions related to assignments
    await ListingCompletion.deleteMany({ assignment: { $in: assignmentIds } });

    // Delete all assignments related to this task
    await Assignment.deleteMany({ task: taskId });

    // Delete the task itself
    await Task.findByIdAndDelete(taskId);

    res.json({ message: 'Task and all related data deleted successfully' });
  } catch (e) {
    console.error('Error deleting task:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;



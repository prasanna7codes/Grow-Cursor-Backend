import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Task from '../models/Task.js';

const router = Router();

// Create a product research entry (productadmin or superadmin)
router.post('/', requireAuth, requireRole('superadmin', 'productadmin'), async (req, res) => {
  const body = req.body || {};
  try {
    // normalize legacy field names and defaults
    if (!body.supplierLink && body.link) body.supplierLink = body.link;
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
      range: body.range,
      category: body.category,
      listingPlatform: body.listingPlatformId || null,
      store: body.storeId || null,
      assignedLister: body.assignedListerId || null,
      status: 'draft',
      createdBy: req.user.userId
    });
    res.json(task);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// List tasks (productadmin see all; listingadmin see all; listers see assigned to them)
// List tasks (productadmin see all; listingadmin see all; listers see assigned to them)
router.get('/', requireAuth, async (req, res) => {
  const { role, userId } = req.user;
  const { platformId, storeId, listerId, date, sortBy = 'date', sortOrder = 'desc', search } = req.query || {};
  const { page, limit } = req.query; // <-- no defaults here

  const query = role === 'lister' ? { assignedLister: userId } : {};

  if (role !== 'lister') {
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

  try {
    const sortOptions = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
    const base = Task.find(query)
      .sort(sortOptions)
      .populate('sourcePlatform')
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
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Number(limit) || 10);
    const [total, tasks] = await Promise.all([
      Task.countDocuments(query),
      base.skip((pageNum - 1) * limitNum).limit(limitNum)
    ]);

    res.json({
      tasks,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Assign a task to a lister (listingadmin or superadmin)
router.post('/:id/assign', requireAuth, requireRole('superadmin', 'listingadmin'), async (req, res) => {
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
});

// Update task fields (productadmin edits product fields; listingadmin can reassign)
router.put('/:id', requireAuth, requireRole('superadmin', 'productadmin', 'listingadmin'), async (req, res) => {
  const { role } = req.user;
  const updates = req.body || {};
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (role === 'productadmin') {
    // Product admin can only edit product fields (not listing fields)
    const editable = ['date','productTitle','supplierLink','sourcePrice','sellingPrice','range','category','sourcePlatform'];
    for (const k of editable) {
      if (updates[k] !== undefined) {
        if (k === 'sourcePlatform') task.sourcePlatform = updates[k];
        else task[k] = updates[k];
      }
    }
  } else if (role === 'listingadmin' || role === 'superadmin') {
    // Listing admin can reassign lister, update quantity, listing platform, store
    if (updates.listerId !== undefined) task.assignedLister = updates.listerId;
    if (updates.quantity !== undefined) task.quantity = updates.quantity;
    if (updates.listingPlatformId !== undefined) task.listingPlatform = updates.listingPlatformId;
    if (updates.storeId !== undefined) task.store = updates.storeId;
  }
  await task.save();
  res.json(task);
});

// Lister marks completed
router.post('/:id/complete', requireAuth, requireRole('lister'), async (req, res) => {
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
});

// Admin-side analytics (platform/store/lister/date filters)
router.get('/analytics', requireAuth, requireRole('superadmin', 'productadmin', 'listingadmin'), async (req, res) => {
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
        ranges: { $addToSet: '$range' },
        categories: { $addToSet: '$category' },
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
        numRanges: { $size: '$ranges' },
        numCategories: { $size: '$categories' }
      }
    }
  ];

  const [result] = await Task.aggregate(pipeline);
  res.json(result || { totalListings: 0, numListers: 0, numStores: 0, numRanges: 0, numCategories: 0 });
});

// Superadmin/listingadmin: admin-lister assignment summary
router.get('/analytics/admin-lister', requireAuth, requireRole('superadmin', 'listingadmin'), async (req, res) => {
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
});

// Daily totals (optionally filtered by platform/store/lister)
router.get('/analytics/daily', requireAuth, requireRole('superadmin', 'productadmin', 'listingadmin'), async (req, res) => {
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
        ranges: { $addToSet: '$range' },
        categories: { $addToSet: '$category' }
      }
    },
    {
      $project: {
        _id: 0,
        date: '$_id.day',
        totalQuantity: 1,
        numListers: { $size: '$numListers' },
        numStores: { $size: '$numStores' },
        numRanges: { $size: '$ranges' },
        numCategories: { $size: '$categories' }
      }
    },
    { $sort: { date: -1 } }
  ];

  const rows = await Task.aggregate(pipeline);
  res.json(rows);
});

// Per-lister per day with platform/store breakdown
router.get('/analytics/lister-daily', requireAuth, requireRole('superadmin', 'listingadmin'), async (req, res) => {
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
        numRanges: { $size: '$ranges' },
        numCategories: { $size: '$categories' }
      }
    },
    { $sort: { date: -1, platform: 1, store: 1 } }
  ];

  const rows = await Task.aggregate(pipeline);
  res.json(rows);
});

// Listings summary grouped by assignment-day, platform and store (optional filters: platformId, storeId)
router.get('/analytics/listings-summary', requireAuth, requireRole('superadmin', 'listingadmin', 'productadmin'), async (req, res) => {
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
        numRanges: { $size: '$ranges' },
        numCategories: { $size: '$categories' },
        assignmentsCount: 1
      }
    },
    { $sort: { date: -1, platform: 1, store: 1 } }
  ];

  const rows = await Task.aggregate(pipeline);
  res.json(rows);
});

export default router;



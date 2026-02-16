import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import TemplateListing from '../models/TemplateListing.js';
import ListingTemplate from '../models/ListingTemplate.js';
import Seller from '../models/Seller.js';
import SellerPricingConfig from '../models/SellerPricingConfig.js';
import { fetchAmazonData, applyFieldConfigs } from '../utils/asinAutofill.js';
import { generateSKUFromASIN } from '../utils/skuGenerator.js';
import { getEffectiveTemplate } from '../utils/templateMerger.js';
import { getUsageStats, getFieldExtractionStats, getRecentErrors, checkQuotaStatus } from '../utils/apiUsageTracker.js';
import { getAsinCacheStats, clearAsinCache, invalidateAsinCache } from '../utils/asinCache.js';

const router = express.Router();

// Get all listings for a template
router.get('/', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, page = 1, limit = 50, batchFilter = 'active', batchId, status = 'active' } = req.query;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build filter with optional seller filtering
    const filter = { templateId };
    if (sellerId) {
      filter.sellerId = sellerId;
    }
    
    // Filter by status (default to 'active' to only show active listings)
    if (status && status !== 'all') {
      filter.status = status;
    }
    
    // Apply batch filtering
    if (batchId) {
      // Specific batch
      filter.downloadBatchId = batchId;
    } else if (batchFilter === 'active') {
      // Active batch only (not downloaded)
      filter.downloadBatchId = null;
    } else if (batchFilter === 'all') {
      // All batches (no filter on downloadBatchId)
    }
    
    const [listings, total] = await Promise.all([
      TemplateListing.find(filter)
        .populate('createdBy', 'name email')
        .populate({
          path: 'sellerId',
          populate: {
            path: 'user',
            select: 'username email'
          }
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TemplateListing.countDocuments(filter)
    ]);
    
    res.json({
      listings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching listings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Database view endpoint with comprehensive filters (MUST be before /:id route)
router.get('/database-view', requireAuth, async (req, res) => {
  try {
    const { 
      sellerId, 
      templateId, 
      status, 
      search, 
      page = 1, 
      limit = 50 
    } = req.query;
    
    // Build query - exclude soft-deleted items
    const query = { deletedAt: null };
    
    if (sellerId) query.sellerId = sellerId;
    if (templateId) query.templateId = templateId;
    if (status) query.status = status;
    
    // Search across ASIN, SKU (customLabel), and Title
    if (search) {
      query.$or = [
        { _asinReference: new RegExp(search, 'i') },
        { customLabel: new RegExp(search, 'i') },
        { title: new RegExp(search, 'i') }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Fetch with populated fields
    const [listings, total] = await Promise.all([
      TemplateListing.find(query)
        .select('+_asinReference') // Include ASIN in results
        .populate({
          path: 'sellerId',
          populate: {
            path: 'user',
            select: 'username email'
          }
        })
        .populate('templateId', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TemplateListing.countDocuments(query)
    ]);
    
    res.json({
      listings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Database view error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Database statistics endpoint (MUST be before /:id route)
router.get('/database-stats', requireAuth, async (req, res) => {
  try {
    const stats = await TemplateListing.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: null,
          totalListings: { $sum: 1 },
          uniqueSellers: { $addToSet: '$sellerId' },
          uniqueTemplates: { $addToSet: '$templateId' },
          draftCount: {
            $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] }
          },
          activeCount: {
            $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
          },
          inactiveCount: {
            $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0] }
          }
        }
      }
    ]);
    
    res.json({
      total: stats[0]?.totalListings || 0,
      sellers: stats[0]?.uniqueSellers?.length || 0,
      templates: stats[0]?.uniqueTemplates?.length || 0,
      draft: stats[0]?.draftCount || 0,
      active: stats[0]?.activeCount || 0,
      inactive: stats[0]?.inactiveCount || 0
    });
  } catch (error) {
    console.error('Database stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get statistics for template listings (today, week, month, total)
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId } = req.query;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    const filter = { templateId };
    if (sellerId) {
      filter.sellerId = sellerId;
    }
    
    // Calculate date ranges
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);
    
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    
    // Run queries in parallel
    const [todayCount, weekCount, monthCount, totalCount] = await Promise.all([
      TemplateListing.countDocuments({
        ...filter,
        status: 'active',
        createdAt: { $gte: todayStart, $lte: todayEnd }
      }),
      TemplateListing.countDocuments({
        ...filter,
        status: 'active',
        createdAt: { $gte: weekStart }
      }),
      TemplateListing.countDocuments({
        ...filter,
        status: 'active',
        createdAt: { $gte: monthStart }
      }),
      TemplateListing.countDocuments({
        ...filter,
        status: 'active'
      })
    ]);
    
    res.json({
      today: todayCount,
      thisWeek: weekCount,
      thisMonth: monthCount,
      total: totalCount
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get detailed analytics for template listings
router.get('/analytics', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, startDate, endDate, userId, page = 1, limit = 100 } = req.query;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    const filter = { templateId };
    if (sellerId) {
      filter.sellerId = sellerId;
    }
    
    // Apply date range filter
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.createdAt.$lte = new Date(endDate);
      }
    }
    
    // Apply user filter
    if (userId && userId !== 'all') {
      filter.createdBy = userId;
    }
    
    // Get paginated listings
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [listings, total] = await Promise.all([
      TemplateListing.find(filter)
        .populate('createdBy', 'username email role')
        .select('customLabel title _asinReference createdBy createdAt status')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TemplateListing.countDocuments(filter)
    ]);
    
    // Get daily breakdown using aggregation
    const dailyBreakdown = await TemplateListing.aggregate([
      {
        $match: filter
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            userId: "$createdBy"
          },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: "$_id.date",
          total: { $sum: "$count" },
          users: {
            $push: {
              userId: "$_id.userId",
              count: "$count"
            }
          }
        }
      },
      {
        $sort: { _id: -1 }
      },
      {
        $limit: 30 // Last 30 days
      }
    ]);
    
    // Populate user details in daily breakdown
    const userIds = [...new Set(dailyBreakdown.flatMap(d => d.users.map(u => u.userId)))].filter(Boolean);
    const users = await TemplateListing.model('User').find({ _id: { $in: userIds } }).select('username email role');
    const userMap = new Map(users.map(u => [u._id.toString(), u]));
    
    // Enrich daily breakdown with user details
    const enrichedDailyBreakdown = dailyBreakdown.map(day => ({
      date: day._id,
      total: day.total,
      users: day.users
        .filter(u => u.userId)
        .map(u => ({
          userId: u.userId,
          username: userMap.get(u.userId.toString())?.username || 'Unknown',
          count: u.count
        }))
    }));
    
    // Get user breakdown
    const userBreakdown = await TemplateListing.aggregate([
      {
        $match: filter
      },
      {
        $group: {
          _id: "$createdBy",
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);
    
    // Populate user details in user breakdown
    const enrichedUserBreakdown = await Promise.all(
      userBreakdown
        .filter(u => u._id)
        .map(async (u) => {
          const user = userMap.get(u._id.toString());
          return {
            userId: u._id,
            username: user?.username || 'Unknown',
            role: user?.role || 'N/A',
            count: u.count
          };
        })
    );
    
    res.json({
      listings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      dailyBreakdown: enrichedDailyBreakdown,
      userBreakdown: enrichedUserBreakdown,
      summary: {
        totalInPeriod: total,
        uniqueUsers: enrichedUserBreakdown.length
      }
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk preview with SSE streaming (real-time updates) - MUST be before /:id route
router.get('/bulk-preview-stream', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, asins: asinsParam } = req.query;
    
    if (!templateId || !sellerId || !asinsParam) {
      return res.status(400).json({ error: 'Template ID, Seller ID, and ASINs are required' });
    }
    
    const asins = asinsParam.split(',').map(a => a.trim()).filter(Boolean);
    
    if (asins.length === 0) {
      return res.status(400).json({ error: 'At least one ASIN is required' });
    }
    
    if (asins.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 ASINs allowed per batch' });
    }
    
    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });
    
    console.log(`📡 [SSE Stream] Starting for ${asins.length} ASINs...`);
    
    // Send initial event
    res.write(`data: ${JSON.stringify({ type: 'started', total: asins.length })}\n\n`);
    
    // Validate seller and template
    const [seller, template] = await Promise.all([
      Seller.findById(sellerId),
      getEffectiveTemplate(templateId, sellerId)
    ]);
    
    if (!seller || !template) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Seller or template not found' })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    
    // Get pricing config
    let pricingConfig = template.pricingConfig;
    const sellerConfig = await SellerPricingConfig.findOne({ sellerId, templateId });
    if (sellerConfig) {
      pricingConfig = sellerConfig.pricingConfig;
    }
    
    // Check for existing ASINs and SKUs (same as bulk-preview)
    const existingAsinListings = await TemplateListing.find({
      sellerId,
      _asinReference: { $in: asins },
      status: 'active'
    }).select('_asinReference templateId').lean();
    
    const asinInCurrentTemplate = new Set();
    const asinInOtherTemplates = new Map();
    
    existingAsinListings.forEach(listing => {
      if (listing.templateId.toString() === templateId.toString()) {
        asinInCurrentTemplate.add(listing._asinReference);
      } else {
        asinInOtherTemplates.set(listing._asinReference, listing.templateId);
      }
    });
    
    // Pre-generate SKUs and check conflicts
    const generatedSKUs = asins.map(asin => ({
      asin,
      sku: generateSKUFromASIN(asin)
    }));
    
    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: generatedSKUs.map(item => item.sku) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id').lean();
    
    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, {
        id: listing._id,
        asin: listing._asinReference
      }])
    );
    
    // Process ASINs in parallel and stream results as they complete
    let completed = 0;
    
    const processPromises = asins.map(async (asin) => {
      try {
        // Check for blocking conditions
        if (asinInOtherTemplates.has(asin)) {
          const item = {
            id: `preview-${asin}`,
            asin,
            sku: generateSKUFromASIN(asin),
            status: 'blocked',
            blockedReason: 'cross_template_duplicate',
            errors: [`ASIN exists in another template`]
          };
          res.write(`data: ${JSON.stringify({ type: 'item', item, progress: ++completed, total: asins.length })}\n\n`);
          return;
        }
        
        const sku = generateSKUFromASIN(asin);
        const existingSKU = existingSKUMap.get(sku);
        
        if (existingSKU) {
          const item = {
            id: `preview-${asin}`,
            asin,
            sku,
            status: 'blocked',
            blockedReason: 'sku_conflict',
            errors: [`SKU ${sku} already exists`]
          };
          res.write(`data: ${JSON.stringify({ type: 'item', item, progress: ++completed, total: asins.length })}\n\n`);
          return;
        }
        
        // Fetch and process ASIN
        const amazonData = await fetchAmazonData(asin);
        const { coreFields, customFields, pricingCalculation } = 
          await applyFieldConfigs(amazonData, template.asinAutomation.fieldConfigs, pricingConfig);
        
        const mergedCoreFields = {
          ...(template.coreFieldDefaults || {}),
          ...coreFields
        };
        
        if (template?.customColumns && template.customColumns.length > 0) {
          template.customColumns.forEach(col => {
            if (col.defaultValue && !customFields[col.name]) {
              customFields[col.name] = col.defaultValue;
            }
          });
        }
        
        const warnings = [];
        const validationErrors = [];
        
        if (!mergedCoreFields.title) {
          validationErrors.push('Missing required field: title');
        }
        
        if (mergedCoreFields.startPrice === undefined || mergedCoreFields.startPrice === null || mergedCoreFields.startPrice === '') {
          validationErrors.push('Missing required field: startPrice');
        }
        
        if (asinInCurrentTemplate.has(asin)) {
          warnings.push('ASIN already exists in this template');
        }
        
        if (!mergedCoreFields.description) {
          warnings.push('Missing description');
        }
        
        const item = {
          id: `preview-${asin}`,
          asin,
          sku,
          sourceData: {
            title: amazonData.title,
            brand: amazonData.brand,
            price: amazonData.price,
            description: amazonData.description,
            images: amazonData.images
          },
          generatedListing: {
            ...mergedCoreFields,
            customLabel: sku,
            customFields,
            _asinReference: asin
          },
          pricingCalculation,
          warnings,
          errors: validationErrors,
          status: validationErrors.length > 0 ? 'error' : (warnings.length > 0 ? 'warning' : 'success')
        };
        
        // Stream the completed item
        res.write(`data: ${JSON.stringify({ type: 'item', item, progress: ++completed, total: asins.length })}\n\n`);
        
      } catch (error) {
        console.error(`❌ Error processing ASIN ${asin}:`, error);
        const item = {
          id: `preview-${asin}`,
          asin,
          sku: generateSKUFromASIN(asin),
          status: 'error',
          errors: [error.message]
        };
        res.write(`data: ${JSON.stringify({ type: 'item', item, progress: ++completed, total: asins.length })}\n\n`);
      }
    });
    
    // Wait for all to complete
    await Promise.allSettled(processPromises);
    
    // Send completion event
    res.write(`data: ${JSON.stringify({ type: 'complete', total: completed })}\n\n`);
    res.write('data: [DONE]\n\n');
    
    console.log(`📡 [SSE Stream] Completed: ${completed}/${asins.length} ASINs`);
    res.end();
    
  } catch (error) {
    console.error('SSE Stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// Get single listing by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const listing = await TemplateListing.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('templateId');
    
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    res.json(listing);
  } catch (error) {
    console.error('Error fetching listing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new listing
router.post('/', requireAuth, async (req, res) => {
  try {
    const listingData = req.body;
    
    if (!listingData.templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!listingData.sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    // Validate seller exists
    const seller = await Seller.findById(listingData.sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }
    
    if (!listingData.customLabel) {
      return res.status(400).json({ error: 'SKU (Custom label) is required' });
    }
    
    if (!listingData.title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    if (!listingData.startPrice && listingData.startPrice !== 0) {
      return res.status(400).json({ error: 'Start price is required' });
    }
    
    // Convert customFields object to Map
    if (listingData.customFields && typeof listingData.customFields === 'object') {
      listingData.customFields = new Map(Object.entries(listingData.customFields));
    }
    
    // Check if SKU exists as active (block duplicate)
    const activeExists = await TemplateListing.findOne({
      templateId: listingData.templateId,
      sellerId: listingData.sellerId,
      customLabel: listingData.customLabel,
      status: 'active'
    });
    
    if (activeExists) {
      return res.status(409).json({ 
        error: 'An active listing with this SKU already exists' 
      });
    }
    
    // Check if SKU exists as inactive (reactivate instead of creating new)
    const inactiveExists = await TemplateListing.findOne({
      templateId: listingData.templateId,
      sellerId: listingData.sellerId,
      customLabel: listingData.customLabel,
      status: 'inactive'
    });
    
    let listing;
    let wasReactivated = false;
    
    if (inactiveExists) {
      // Reactivate existing inactive listing and update with new data
      Object.assign(inactiveExists, {
        ...listingData,
        customFields: listingData.customFields,
        status: 'active',
        updatedAt: Date.now()
      });
      
      await inactiveExists.save();
      listing = inactiveExists;
      wasReactivated = true;
      
      console.log(`✅ Reactivated inactive listing: ${listingData.customLabel}`);
    } else {
      // Create new listing
      listing = new TemplateListing({
        ...listingData,
        status: 'active',
        createdBy: req.user.userId
      });
      
      await listing.save();
    }
    
    await listing.populate([
      { path: 'createdBy', select: 'name email' },
      { 
        path: 'sellerId',
        populate: {
          path: 'user',
          select: 'username email'
        }
      }
    ]);
    
    res.status(201).json({
      listing,
      wasReactivated
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A listing with this SKU already exists in this template' });
    }
    console.error('Error creating listing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update listing
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const listingData = req.body;
    
    // Convert customFields object to Map
    if (listingData.customFields && typeof listingData.customFields === 'object') {
      listingData.customFields = new Map(Object.entries(listingData.customFields));
    }
    
    listingData.updatedAt = Date.now();
    
    const listing = await TemplateListing.findByIdAndUpdate(
      req.params.id,
      listingData,
      { new: true, runValidators: true }
    )
      .populate('createdBy', 'name email')
      .populate('templateId');
    
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    res.json(listing);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A listing with this SKU already exists in this template' });
    }
    console.error('Error updating listing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete listing
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const listing = await TemplateListing.findByIdAndDelete(req.params.id);
    
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    res.json({ message: 'Listing deleted successfully' });
  } catch (error) {
    console.error('Error deleting listing:', error);
    res.status(500).json({ error: error.message });
  }
});

// ASIN Autofill endpoint
router.post('/autofill-from-asin', requireAuth, async (req, res) => {
  try {
    const { asin, templateId, sellerId } = req.body;
    
    if (!asin || !templateId) {
      return res.status(400).json({ 
        error: 'ASIN and Template ID are required' 
      });
    }
    
    // 1. Fetch effective template with automation config (includes seller overrides)
    const template = await getEffectiveTemplate(templateId, sellerId);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (!template.asinAutomation?.enabled) {
      return res.status(400).json({ 
        error: 'ASIN automation is not enabled for this template' 
      });
    }
    
    // 1.5. Get seller-specific pricing config if sellerId is provided
    let pricingConfig = template.pricingConfig;
    if (sellerId) {
      const sellerConfig = await SellerPricingConfig.findOne({
        sellerId,
        templateId
      });
      if (sellerConfig) {
        pricingConfig = sellerConfig.pricingConfig;
      }
    }
    
    // 2. Fetch fresh Amazon data
    console.log(`Fetching Amazon data for ASIN: ${asin}`);
    const amazonData = await fetchAmazonData(asin);
    
    // 3. Apply field configurations (AI + direct mappings)
    console.log(`Processing ${template.asinAutomation.fieldConfigs.length} field configs`);
    const { coreFields, customFields, pricingCalculation } = await applyFieldConfigs(
      amazonData,
      template.asinAutomation.fieldConfigs,
      pricingConfig  // Use seller-specific or template default pricing config
    );
    
    // 4. Return auto-filled data (separated by type)
    res.json({
      success: true,
      asin,
      autoFilledData: {
        coreFields,
        customFields
      },
      amazonSource: {
        title: amazonData.title,
        brand: amazonData.brand,
        price: amazonData.price,
        imageCount: amazonData.images ? amazonData.images.split(' | ').filter(url => url.trim()).length : 0
      },
      pricingCalculation: pricingCalculation || null
    });
    
  } catch (error) {
    console.error('ASIN autofill error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to fetch and process ASIN data' 
    });
  }
});

// Bulk auto-fill from multiple ASINs
router.post('/bulk-autofill-from-asins', requireAuth, async (req, res) => {
  try {
    const { asins, templateId, sellerId } = req.body;
    
    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      return res.status(400).json({ 
        error: 'ASINs array is required and must not be empty' 
      });
    }
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    // Validate batch size
    if (asins.length > 100) {
      return res.status(400).json({ 
        error: 'Maximum 100 ASINs allowed per batch' 
      });
    }
    
    // Fetch effective template with automation config (includes seller overrides)
    const template = await getEffectiveTemplate(templateId, sellerId);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (!template.asinAutomation?.enabled) {
      return res.status(400).json({ 
        error: 'ASIN automation is not enabled for this template' 
      });
    }
    
    // Get seller-specific pricing config if available
    let pricingConfig = template.pricingConfig;
    const sellerConfig = await SellerPricingConfig.findOne({
      sellerId,
      templateId
    });
    if (sellerConfig) {
      pricingConfig = sellerConfig.pricingConfig;
    }
    
    // Clean and deduplicate ASINs
    const cleanedAsins = [...new Set(
      asins.map(asin => asin.trim().toUpperCase()).filter(asin => asin.length > 0)
    )];
    
    console.log(`\n========== BULK AUTOFILL: ${cleanedAsins.length} ASINs ==========`);
    console.log(`Template: ${template.name || templateId}`);
    console.log(`Seller: ${sellerId}`);
    console.log(`AI Fields: ${template.asinAutomation.fieldConfigs.filter(c => c.source === 'ai' && c.enabled).length}`);
    
    // Check for existing ACTIVE listings with these ASINs across ALL templates for this seller
    const existingListings = await TemplateListing.find({
      sellerId,  // Check across all templates for this seller
      _asinReference: { $in: cleanedAsins },
      status: 'active'
    }).select('_asinReference _id templateId');
    
    // Create maps for both current template and cross-template duplicates
    const existingInCurrentTemplate = new Map();
    const existingInOtherTemplates = new Map();
    
    existingListings.forEach(listing => {
      if (listing.templateId.toString() === templateId.toString()) {
        existingInCurrentTemplate.set(listing._asinReference, listing._id);
      } else {
        existingInOtherTemplates.set(listing._asinReference, listing.templateId);
      }
    });
    
    console.log(`Found ${existingInCurrentTemplate.size} ASINs in current template (will skip)`);
    console.log(`Found ${existingInOtherTemplates.size} ASINs in other templates (will block)\n`);
    
    // Pre-generate all SKUs and check for collisions with existing SKUs
    const generatedSKUs = cleanedAsins.map(asin => ({
      asin,
      sku: generateSKUFromASIN(asin)
    }));
    
    // Check if any generated SKUs already exist (from both ASIN imports and SKU imports)
    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: generatedSKUs.map(item => item.sku) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id');
    
    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, {
        id: listing._id,
        asin: listing._asinReference
      }])
    );
    
    console.log(`Found ${existingSKUMap.size} SKU conflicts (will block)\n`);
    
    const startTime = Date.now();
    const results = [];
    
    // Process ASINs in batches of 20 (parallel within batch, parallel between batches)
    const batchSize = parseInt(process.env.BACKEND_BATCH_SIZE) || 20;
    const batches = [];
    for (let i = 0; i < cleanedAsins.length; i += batchSize) {
      batches.push(cleanedAsins.slice(i, i + batchSize));
    }
    
    console.log(`🚀 Processing ${batches.length} batches in parallel (${batchSize} ASINs per batch)...`);
    
    // Process all batches in parallel
    const batchPromises = batches.map(async (batch, batchIndex) => {
      const batchNum = batchIndex + 1;
      console.log(`  ⏳ Batch ${batchNum}/${batches.length}: Starting ${batch.length} ASINs...`);
      
      const batchPromises = batch.map(async (asin) => {
        // Check if ASIN exists in OTHER templates for this seller (block)
        if (existingInOtherTemplates.has(asin)) {
          return {
            asin,
            status: 'blocked',
            existingTemplateId: existingInOtherTemplates.get(asin).toString(),
            error: 'ASIN already exists for this seller in another template. Each ASIN can only be used once per seller.'
          };
        }
        
        // Check if ASIN already exists in CURRENT template (skip)
        if (existingInCurrentTemplate.has(asin)) {
          return {
            asin,
            status: 'duplicate',
            existingListingId: existingInCurrentTemplate.get(asin).toString(),
            error: 'ASIN already exists in this template'
          };
        }
        
        // Check if generated SKU already exists (from ASIN imports or SKU imports)
        const generatedSKU = generateSKUFromASIN(asin);
        const existingSKU = existingSKUMap.get(generatedSKU);
        if (existingSKU) {
          return {
            asin,
            sku: generatedSKU,
            status: 'blocked',
            blockedReason: 'sku_conflict',
            existingListingId: existingSKU.id.toString(),
            error: existingSKU.asin 
              ? `SKU ${generatedSKU} already exists for ASIN ${existingSKU.asin} in this template`
              : `SKU ${generatedSKU} already exists in this template (imported via SKU import)`
          };
        }
        
        try {
          // Fetch Amazon data
          const amazonData = await fetchAmazonData(asin);
          
          // Apply field configurations
          const { coreFields, customFields, pricingCalculation } = await applyFieldConfigs(
            amazonData,
            template.asinAutomation.fieldConfigs,
            pricingConfig  // Use seller-specific or template default pricing config
          );
          
          return {
            asin,
            status: 'success',
            autoFilledData: {
              coreFields,
              customFields
            },
            amazonSource: {
              title: amazonData.title,
              brand: amazonData.brand,
              price: amazonData.price,
              imageCount: amazonData.images ? amazonData.images.split(' | ').filter(url => url.trim()).length : 0
            },
            pricingCalculation: pricingCalculation || null
          };
        } catch (error) {
          console.error(`\n❌ ERROR processing ASIN ${asin}:`);
          console.error(`   Message: ${error.message}`);
          console.error(`   Stack: ${error.stack?.split('\n').slice(0, 3).join('\n   ')}`);
          return {
            asin,
            status: 'error',
            error: error.message || 'Failed to fetch or process ASIN data'
          };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      console.log(`  ✅ Batch ${batchNum}/${batches.length}: Completed`);
      return batchResults;
    });
    
    // Wait for all batches to complete (use allSettled for resilience)
    const allBatchResults = await Promise.allSettled(batchPromises);
    
    // Flatten and collect all results
    allBatchResults.forEach((batchResult, batchIndex) => {
      if (batchResult.status === 'fulfilled') {
        results.push(...batchResult.value);
      } else {
        // Entire batch failed (rare) - mark all ASINs in batch as failed
        const batch = batches[batchIndex];
        console.error(`❌ Batch ${batchIndex + 1} completely failed:`, batchResult.reason);
        batch.forEach(asin => {
          results.push({
            asin,
            status: 'error',
            error: `Batch processing failed: ${batchResult.reason?.message || 'Unknown error'}`
          });
        });
      }
    });
    
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const successful = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'error').length;
    const duplicates = results.filter(r => r.status === 'duplicate').length;
    const blocked = results.filter(r => r.status === 'blocked').length;
    
    console.log(`\n========== BULK AUTOFILL COMPLETE ==========`);
    console.log(`✅ Successful: ${successful}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`⏭️  Duplicates: ${duplicates}`);
    console.log(`🚫 Blocked: ${blocked}`);
    console.log(`⏱️  Total Time: ${processingTime}s`);
    console.log(`⚡ Avg per ASIN: ${(parseFloat(processingTime) / cleanedAsins.length).toFixed(2)}s`);
    console.log(`==========================================\n`);
    
    res.json({
      success: true,
      total: cleanedAsins.length,
      successful,
      failed,
      duplicates,
      blocked,
      results,
      processingTime: `${processingTime}s`
    });
    
  } catch (error) {
    console.error('Bulk ASIN autofill error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to process bulk ASIN autofill' 
    });
  }
});

// Bulk delete listings
router.post('/bulk-delete', requireAuth, async (req, res) => {
  try {
    const { listingIds } = req.body;
    
    if (!listingIds || !Array.isArray(listingIds) || listingIds.length === 0) {
      return res.status(400).json({ error: 'Listing IDs array is required' });
    }
    
    const result = await TemplateListing.deleteMany({
      _id: { $in: listingIds }
    });
    
    res.json({ 
      message: 'Listings deleted successfully',
      deletedCount: result.deletedCount 
    });
  } catch (error) {
    console.error('Error bulk deleting listings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk create listings from auto-fill results
router.post('/bulk-create', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, listings, options = {} } = req.body;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    // Validate seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }
    
    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({ error: 'Listings array is required' });
    }
    
    // Validate batch size
    if (listings.length > 50) {
      return res.status(400).json({ 
        error: 'Maximum 50 listings allowed per batch' 
      });
    }
    
    const {
      autoGenerateSKU = true,
      skipDuplicates = true
    } = options;
    
    // Fetch effective template to get next SKU counter (includes seller overrides)
    const template = await getEffectiveTemplate(templateId, sellerId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const results = [];
    const errors = [];
    let skippedCount = 0;
    
    // Get existing ACTIVE SKUs to avoid duplicates
    const existingActiveSKUs = await TemplateListing.find({ 
      templateId,
      sellerId,
      status: 'active'
    }).distinct('customLabel');
    
    // Get existing INACTIVE listings for potential reactivation
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      status: 'inactive'
    }).select('+_asinReference');
    
    const inactiveMap = new Map(
      inactiveListings.map(l => [l.customLabel, l])
    );
    
    const skuSet = new Set(existingActiveSKUs);
    let skuCounter = Date.now();
    
    console.log(`📊 Pre-check: ${existingActiveSKUs.length} active SKUs, ${inactiveListings.length} inactive listings`);
    console.log(`📋 Inactive SKUs: ${Array.from(inactiveMap.keys()).join(', ')}`);
    
    // Pre-check for SKU conflicts with existing listings (including drafts from SKU imports)
    const potentialSKUs = listings
      .map(l => l.customLabel || (l._asinReference ? generateSKUFromASIN(l._asinReference) : null))
      .filter(sku => sku);
    
    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: potentialSKUs },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id').lean();
    
    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, {
        id: listing._id,
        asin: listing._asinReference
      }])
    );
    
    console.log(`🔍 SKU pre-check: ${existingSKUMap.size} SKU conflicts detected`);
    
    // Process each listing
    for (const listingData of listings) {
      try {
        // Validate required fields
        if (!listingData.title) {
          errors.push({
            asin: listingData._asinReference,
            error: 'Title is required',
            details: 'Missing required field: title'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'Title is required'
          });
          continue;
        }
        
        if (listingData.startPrice === undefined || listingData.startPrice === null) {
          errors.push({
            asin: listingData._asinReference,
            error: 'Start price is required',
            details: 'Missing required field: startPrice'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'Start price is required'
          });
          continue;
        }
        
        // Generate SKU if not provided
        let sku = listingData.customLabel;
        if (!sku && autoGenerateSKU) {
          // Generate SKU using GRW25 + last 5 chars of ASIN
          if (listingData._asinReference) {
            sku = generateSKUFromASIN(listingData._asinReference);
          } else {
            sku = `SKU-${skuCounter++}`;
          }
          
          // Check if generated SKU conflicts with existing (from ASIN or SKU imports)
          const existingSKU = existingSKUMap.get(sku);
          if (existingSKU) {
            errors.push({
              asin: listingData._asinReference,
              sku,
              error: existingSKU.asin 
                ? `Generated SKU ${sku} already exists for ASIN ${existingSKU.asin}`
                : `Generated SKU ${sku} already exists (imported via SKU import)`,
              details: 'SKU conflict detected'
            });
            results.push({
              status: 'blocked',
              asin: listingData._asinReference,
              sku,
              blockedReason: 'sku_conflict',
              error: existingSKU.asin 
                ? `SKU already exists for ASIN ${existingSKU.asin}`
                : `SKU already exists (imported via SKU import)`
            });
            console.log(`🚫 Blocked SKU conflict: ${sku}`);
            continue;
          }
          
          // Ensure uniqueness within current batch
          while (skuSet.has(sku)) {
            // If collision within batch, append timestamp suffix
            sku = `${generateSKUFromASIN(listingData._asinReference)}-${skuCounter++}`;
          }
        }
        
        if (!sku) {
          errors.push({
            asin: listingData._asinReference,
            error: 'SKU (Custom label) is required',
            details: 'No SKU provided and auto-generation disabled'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'SKU is required'
          });
          continue;
        }
        
        console.log(`🔍 Processing SKU: ${sku}, inInactiveMap: ${inactiveMap.has(sku)}, inActiveSet: ${skuSet.has(sku)}`);
        
        // Check if SKU exists as inactive - reactivate instead of create
        const inactiveListing = inactiveMap.get(sku);
        
        if (inactiveListing) {
          // Found an inactive listing with this SKU - reactivate it
          // Convert customFields object to Map
          const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
            ? new Map(Object.entries(listingData.customFields))
            : new Map();
          
          // Update existing inactive listing
          Object.assign(inactiveListing, {
            ...listingData,
            customLabel: sku,
            customFields: customFieldsMap,
            templateId,
            sellerId,
            status: 'active',
            updatedAt: Date.now()
          });
          
          await inactiveListing.save();
          skuSet.add(sku);
          
          results.push({
            status: 'reactivated',
            listing: inactiveListing.toObject(),
            asin: listingData._asinReference,
            sku
          });
          
          console.log(`✅ Reactivated: ${sku}`);
          continue;
        }
        
        // Check for duplicate SKU in active listings (within this batch or existing)
        if (skuSet.has(sku)) {
          if (skipDuplicates) {
            skippedCount++;
            results.push({
              status: 'skipped',
              asin: listingData._asinReference,
              sku,
              error: 'Duplicate SKU (active listing exists)'
            });
            console.log(`⏭️ Skipped duplicate: ${sku}`);
            continue;
          } else {
            // Make SKU unique by appending suffix
            const baseSKU = sku;
            let suffix = 1;
            
            do {
              sku = `${baseSKU}-${suffix++}`;
            } while (skuSet.has(sku) || inactiveMap.has(sku));
            
            console.log(`SKU collision detected: ${baseSKU} → ${sku}`);
          }
        }
        
        // Convert customFields object to Map
        const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
          ? new Map(Object.entries(listingData.customFields))
          : new Map();
        
        // Create new listing
        const listing = new TemplateListing({
          ...listingData,
          customLabel: sku,
          customFields: customFieldsMap,
          templateId,
          sellerId,
          status: 'active',
          createdBy: req.user.userId
        });
        
        await listing.save();
        skuSet.add(sku);
        
        results.push({
          status: 'created',
          listing: listing.toObject(),
          asin: listingData._asinReference,
          sku
        });
        
      } catch (error) {
        console.error('Error creating listing:', error);
        
        if (error.code === 11000) {
          // Duplicate key error
          skippedCount++;
          results.push({
            status: 'skipped',
            asin: listingData._asinReference,
            error: 'Duplicate SKU'
          });
        } else {
          errors.push({
            asin: listingData._asinReference,
            error: error.message,
            details: error.toString()
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: error.message
          });
        }
      }
    }
    
    const created = results.filter(r => r.status === 'created').length;
    const reactivated = results.filter(r => r.status === 'reactivated').length;
    const failed = results.filter(r => r.status === 'failed').length;
    
    console.log(`Bulk create completed: ${created} created, ${reactivated} reactivated, ${failed} failed, ${skippedCount} skipped`);
    
    res.json({
      success: true,
      total: listings.length,
      created,
      reactivated,
      failed,
      skipped: skippedCount,
      results,
      errors
    });
    
  } catch (error) {
    console.error('Bulk create error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to bulk create listings' 
    });
  }
});

// Bulk preview: Process ASINs and return preview data (no save to database)
router.post('/bulk-preview', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, asins } = req.body;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      return res.status(400).json({ error: 'ASINs array is required' });
    }
    
    // Validate batch size
    if (asins.length > 100) {
      return res.status(400).json({ 
        error: 'Maximum 100 ASINs allowed per batch' 
      });
    }
    
    // Validate seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }
    
    // Fetch effective template (includes seller overrides)
    const template = await getEffectiveTemplate(templateId, sellerId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (!template.asinAutomation?.enabled) {
      return res.status(400).json({ 
        error: 'ASIN automation is not enabled for this template' 
      });
    }
    
    // Get seller-specific pricing config if available
    let pricingConfig = template.pricingConfig;
    if (sellerId) {
      const sellerConfig = await SellerPricingConfig.findOne({
        sellerId,
        templateId
      });
      if (sellerConfig) {
        pricingConfig = sellerConfig.pricingConfig;
      }
    }
    
    console.log(`💰 Pricing config enabled: ${pricingConfig?.enabled}, multiplier: ${pricingConfig?.multiplier}`);
    if (pricingConfig?.enabled) {
      console.log(`   Desired profit: ${pricingConfig.desiredProfit} INR`);
      console.log(`   Profit tiers: ${pricingConfig.profitTiers?.length || 0} configured`);
      if (pricingConfig.profitTiers?.length > 0) {
        pricingConfig.profitTiers.forEach((tier, idx) => {
          console.log(`     Tier ${idx + 1}: $${tier.minCost}-$${tier.maxCost} → +${tier.profit} INR`);
        });
      }
    }
    console.log(`📋 Field configs: ${template.asinAutomation.fieldConfigs.length} total`);
    
    // Log field config breakdown
    const coreConfigs = template.asinAutomation.fieldConfigs.filter(c => c.fieldType === 'core');
    const customConfigs = template.asinAutomation.fieldConfigs.filter(c => c.fieldType === 'custom');
    const aiConfigs = template.asinAutomation.fieldConfigs.filter(c => c.source === 'ai');
    const directConfigs = template.asinAutomation.fieldConfigs.filter(c => c.source === 'direct');
    
    console.log(`   Core: ${coreConfigs.length}, Custom: ${customConfigs.length}`);
    console.log(`   AI: ${aiConfigs.length}, Direct: ${directConfigs.length}`);
    console.log(`   Custom field names: ${customConfigs.map(c => c.ebayField).join(', ')}`);
    
    const previewItems = [];
    const errors = [];
    
    // Get existing ACTIVE SKUs to detect duplicates (ONCE per request, not per ASIN)
    const existingActiveSKUs = await TemplateListing.find({ 
      templateId,
      sellerId,
      status: 'active'
    }).lean().distinct('customLabel');
    
    const skuSet = new Set(existingActiveSKUs);
    
    // Check for existing ASINs across ALL templates for this seller
    const existingAsinListings = await TemplateListing.find({
      sellerId,
      _asinReference: { $in: asins },
      status: 'active'
    }).select('_asinReference templateId').lean();
    
    // Create maps for both current template and cross-template ASIN duplicates
    const asinInCurrentTemplate = new Set();
    const asinInOtherTemplates = new Map(); // ASIN -> templateId
    
    existingAsinListings.forEach(listing => {
      if (listing.templateId.toString() === templateId.toString()) {
        asinInCurrentTemplate.add(listing._asinReference);
      } else {
        asinInOtherTemplates.set(listing._asinReference, listing.templateId);
      }
    });
    
    console.log(`🔍 ASIN Check: ${asinInCurrentTemplate.size} in current template, ${asinInOtherTemplates.size} in other templates`);
    
    // Pre-generate all SKUs and check for SKU collisions
    const generatedSKUs = asins.map(asin => ({
      asin,
      sku: generateSKUFromASIN(asin)
    }));
    
    // Check if any generated SKUs already exist (from both ASIN imports and SKU imports)
    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: generatedSKUs.map(item => item.sku) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id').lean();
    
    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, {
        id: listing._id,
        asin: listing._asinReference
      }])
    );
    
    console.log(`🔍 SKU Check: ${existingSKUMap.size} SKU conflicts detected`);
    
    console.log(`🚀 Processing ${asins.length} ASINs in parallel...`);
    
    // Process ALL ASINs in parallel using Promise.allSettled
    const asinPromises = asins.map(async (asin) => {
      try {
        console.log(`📦 Processing ASIN for preview: ${asin}`);
        
        // Check if ASIN exists in OTHER templates for this seller (blocking error)
        if (asinInOtherTemplates.has(asin)) {
          const otherTemplateId = asinInOtherTemplates.get(asin);
          const errorItem = {
            id: `preview-${asin}`,
            asin,
            sku: generateSKUFromASIN(asin),
            sourceData: null,
            generatedListing: null,
            pricingCalculation: null,
            warnings: [],
            errors: [`ASIN already exists for this seller in template ${otherTemplateId}. Each ASIN can only be used once per seller.`],
            status: 'blocked',
            blockedReason: 'cross_template_duplicate',
            existingTemplateId: otherTemplateId.toString()
          };
          
          return {
            success: false,
            item: errorItem,
            error: `ASIN exists in another template`
          };
        }
        
        // Generate SKU early for collision check
        const sku = generateSKUFromASIN(asin);
        
        // Check if generated SKU already exists (from ASIN imports or SKU imports)
        const existingSKU = existingSKUMap.get(sku);
        if (existingSKU) {
          const errorItem = {
            id: `preview-${asin}`,
            asin,
            sku,
            sourceData: null,
            generatedListing: null,
            pricingCalculation: null,
            warnings: [],
            errors: [existingSKU.asin 
              ? `SKU ${sku} already exists for ASIN ${existingSKU.asin} in this template`
              : `SKU ${sku} already exists in this template (imported via SKU import)`
            ],
            status: 'blocked',
            blockedReason: 'sku_conflict',
            existingListingId: existingSKU.id.toString()
          };
          
          return {
            success: false,
            item: errorItem,
            error: `SKU conflict`
          };
        }
        
        // Fetch Amazon data
        const amazonData = await fetchAmazonData(asin);
        
        // Apply field configurations
        const { coreFields, customFields, pricingCalculation } = 
          await applyFieldConfigs(amazonData, template.asinAutomation.fieldConfigs, pricingConfig);
        
        // Apply template core field defaults as base layer (autofilled fields override these)
        const mergedCoreFields = {
          ...(template.coreFieldDefaults || {}),
          ...coreFields
        };
        
        // Apply custom column default values for missing fields
        if (template?.customColumns && template.customColumns.length > 0) {
          template.customColumns.forEach(col => {
            if (col.defaultValue && !customFields[col.name]) {
              customFields[col.name] = col.defaultValue;
              console.log(`✨ Applied column default for ${col.name}: ${col.defaultValue}`);
            }
          });
        }
        
        console.log(`✅ Generated fields for ${asin}:`);
        console.log(`   Core fields: ${Object.keys(mergedCoreFields).join(', ')}`);
        console.log(`   Custom fields: ${Object.keys(customFields).join(', ')}`);
        
        // SKU already generated earlier for collision check
        
        // Check for warnings
        const warnings = [];
        const validationErrors = [];
        
        if (!mergedCoreFields.title) {
          validationErrors.push('Missing required field: title');
        }
        
        if (mergedCoreFields.startPrice === undefined || mergedCoreFields.startPrice === null || mergedCoreFields.startPrice === '') {
          if (pricingConfig?.enabled) {
            if (pricingCalculation?.error) {
              validationErrors.push(`Failed to calculate startPrice: ${pricingCalculation.error}`);
            } else {
              validationErrors.push('Pricing calculator enabled but startPrice not generated');
            }
          } else {
            validationErrors.push('Missing required field: startPrice (no pricing config or field mapping)');
          }
          console.error(`❌ [ASIN: ${asin}] startPrice validation failed. Value: ${mergedCoreFields.startPrice}, Pricing Config Enabled: ${pricingConfig?.enabled}, Error: ${pricingCalculation?.error || 'none'}`);
        } else {
          console.log(`✅ [ASIN: ${asin}] startPrice validated: $${mergedCoreFields.startPrice}`);
        }
        
        if (skuSet.has(sku)) {
          warnings.push('Duplicate SKU - will be skipped or replace existing');
        }
        
        // Check if ASIN already exists in CURRENT template (warning only)
        if (asinInCurrentTemplate.has(asin)) {
          warnings.push('ASIN already exists in this template - will be skipped during save');
        }
        
        // Check for missing important fields
        if (!mergedCoreFields.description) {
          warnings.push('Missing description');
        }
        
        previewItems.push({
          id: `preview-${asin}`,
          asin,
          sku,
          sourceData: {
            title: amazonData.title,
            brand: amazonData.brand,
            price: amazonData.price,
            description: amazonData.description,
            images: amazonData.images,
            rawData: amazonData.rawData
          },
          generatedListing: {
            ...mergedCoreFields,
            customLabel: sku,
            customFields,
            _asinReference: asin
          },
          pricingCalculation,
          warnings,
          errors: validationErrors,
          status: validationErrors.length > 0 ? 'error' : (warnings.length > 0 ? 'warning' : 'success')
        });
        
        return {
          success: true,
          item: previewItems[previewItems.length - 1]
        };
        
      } catch (error) {
        console.error(`❌ Error processing ASIN ${asin}:`, error);
        
        const errorItem = {
          id: `preview-${asin}`,
          asin,
          sku: generateSKUFromASIN(asin),
          sourceData: null,
          generatedListing: null,
          pricingCalculation: null,
          warnings: [],
          errors: [error.message],
          status: 'error'
        };
        
        return {
          success: false,
          item: errorItem,
          error: error.message
        };
      }
    });
    
    // Wait for all ASINs to complete (parallel processing)
    const results = await Promise.allSettled(asinPromises);
    
    // Collect all items from results
    const finalItems = [];
    const finalErrors = [];
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        finalItems.push(result.value.item);
        if (!result.value.success) {
          finalErrors.push({
            asin: asins[index],
            error: result.value.error
          });
        }
      } else {
        // Promise rejected (shouldn't happen with try/catch, but handle it)
        const asin = asins[index];
        finalErrors.push({
          asin,
          error: result.reason?.message || 'Unknown error'
        });
        finalItems.push({
          id: `preview-${asin}`,
          asin,
          sku: generateSKUFromASIN(asin),
          sourceData: null,
          generatedListing: null,
          pricingCalculation: null,
          warnings: [],
          errors: [result.reason?.message || 'Unknown error'],
          status: 'error'
        });
      }
    });
    
    console.log(`✅ Parallel processing complete: ${finalItems.length} items processed`);
    
    res.json({
      success: true,
      items: finalItems,
      errors: finalErrors,
      summary: {
        total: asins.length,
        successful: finalItems.filter(i => i.status !== 'error').length,
        failed: finalErrors.length,
        warnings: finalItems.filter(i => i.status === 'warning').length
      }
    });
    
  } catch (error) {
    console.error('Bulk preview error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to generate preview' 
    });
  }
});

// Bulk save: Save reviewed/edited listings to database
router.post('/bulk-save', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, listings, options = {} } = req.body;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({ error: 'Listings array is required' });
    }
    
    // Validate seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }
    
    const {
      skipDuplicates = true
    } = options;
    
    const results = [];
    const errors = [];
    let skippedCount = 0;
    
    // Get existing ACTIVE SKUs
    const existingActiveSKUs = await TemplateListing.find({ 
      templateId,
      sellerId,
      status: 'active'
    }).distinct('customLabel');
    
    // Get existing INACTIVE listings for potential reactivation
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      status: 'inactive'
    }).select('+_asinReference');
    
    const inactiveMap = new Map(
      inactiveListings.map(l => [l.customLabel, l])
    );
    
    const skuSet = new Set(existingActiveSKUs);
    
    console.log(`📊 Bulk save: ${existingActiveSKUs.length} active SKUs, ${inactiveListings.length} inactive listings`);
    
    // Check for cross-template ASIN duplicates
    const asinsToSave = listings
      .map(l => l._asinReference)
      .filter(asin => asin && asin.trim());
    
    const crossTemplateAsins = await TemplateListing.find({
      sellerId,
      templateId: { $ne: templateId }, // Different template
      _asinReference: { $in: asinsToSave },
      status: 'active'
    }).select('_asinReference templateId').lean();
    
    const crossTemplateAsinMap = new Map(
      crossTemplateAsins.map(l => [l._asinReference, l.templateId])
    );
    
    console.log(`🚫 Found ${crossTemplateAsinMap.size} ASINs already in other templates`);
    
    // Pre-check all SKUs for collisions (including those from SKU imports)
    const skusToSave = listings
      .map(l => l.customLabel)
      .filter(sku => sku && sku.trim());
    
    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skusToSave },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference _id').lean();
    
    const existingSKUMap = new Map(
      existingBySKU.map(listing => [listing.customLabel, {
        id: listing._id,
        asin: listing._asinReference
      }])
    );
    
    console.log(`🔍 SKU pre-check: ${existingSKUMap.size} SKU conflicts detected`);
    
    // Process each listing
    for (const listingData of listings) {
      try {
        // Check for cross-template ASIN duplicate FIRST
        if (listingData._asinReference && crossTemplateAsinMap.has(listingData._asinReference)) {
          const existingTemplateId = crossTemplateAsinMap.get(listingData._asinReference);
          errors.push({
            asin: listingData._asinReference,
            error: `ASIN already exists in template ${existingTemplateId} for this seller`
          });
          results.push({
            status: 'blocked',
            asin: listingData._asinReference,
            error: `ASIN already exists in another template for this seller`,
            existingTemplateId: existingTemplateId.toString()
          });
          console.log(`🚫 Blocked duplicate ASIN ${listingData._asinReference} (exists in template ${existingTemplateId})`);
          continue;
        }
        
        // Validate required fields
        if (!listingData.title) {
          errors.push({
            asin: listingData._asinReference,
            error: 'Title is required'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'Title is required'
          });
          continue;
        }
        
        if (listingData.startPrice === undefined || listingData.startPrice === null) {
          errors.push({
            asin: listingData._asinReference,
            error: 'Start price is required'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'Start price is required'
          });
          continue;
        }
        
        const sku = listingData.customLabel;
        
        if (!sku) {
          errors.push({
            asin: listingData._asinReference,
            error: 'SKU (Custom label) is required'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'SKU is required'
          });
          continue;
        }
        
        console.log(`🔍 Saving SKU: ${sku}`);
        
        // Check if SKU already exists (from ASIN imports or SKU imports)
        const existingSKU = existingSKUMap.get(sku);
        if (existingSKU && existingSKU.id) {
          errors.push({
            asin: listingData._asinReference,
            sku,
            error: existingSKU.asin 
              ? `SKU ${sku} already exists for ASIN ${existingSKU.asin}`
              : `SKU ${sku} already exists (imported via SKU import)`
          });
          results.push({
            status: 'blocked',
            asin: listingData._asinReference,
            sku,
            blockedReason: 'sku_conflict',
            existingListingId: existingSKU.id.toString(),
            error: existingSKU.asin 
              ? `SKU already exists for ASIN ${existingSKU.asin}`
              : `SKU already exists (imported via SKU import)`
          });
          console.log(`🚫 Blocked SKU conflict: ${sku}`);
          continue;
        }
        
        // Check if SKU exists as inactive - reactivate
        const inactiveListing = inactiveMap.get(sku);
        
        if (inactiveListing) {
          const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
            ? new Map(Object.entries(listingData.customFields))
            : new Map();
          
          Object.assign(inactiveListing, {
            ...listingData,
            customLabel: sku,
            customFields: customFieldsMap,
            templateId,
            sellerId,
            status: 'active',
            updatedAt: Date.now()
          });
          
          await inactiveListing.save();
          skuSet.add(sku);
          
          results.push({
            status: 'reactivated',
            listing: inactiveListing.toObject(),
            asin: listingData._asinReference,
            sku
          });
          
          console.log(`✅ Reactivated: ${sku}`);
          continue;
        }
        
        // Check for duplicate SKU
        if (skuSet.has(sku)) {
          if (skipDuplicates) {
            skippedCount++;
            results.push({
              status: 'skipped',
              asin: listingData._asinReference,
              sku,
              reason: 'Duplicate SKU'
            });
            console.log(`⏭️ Skipped duplicate: ${sku}`);
            continue;
          } else {
            errors.push({
              asin: listingData._asinReference,
              error: 'Duplicate SKU',
              sku
            });
            results.push({
              status: 'failed',
              asin: listingData._asinReference,
              error: 'Duplicate SKU'
            });
            continue;
          }
        }
        
        // Convert customFields object to Map
        const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
          ? new Map(Object.entries(listingData.customFields))
          : new Map();
        
        // Create new listing
        const listing = new TemplateListing({
          ...listingData,
          customLabel: sku,
          customFields: customFieldsMap,
          templateId,
          sellerId,
          status: 'active',
          createdBy: req.user.userId
        });
        
        await listing.save();
        skuSet.add(sku);
        
        results.push({
          status: 'created',
          listing: listing.toObject(),
          asin: listingData._asinReference,
          sku
        });
        
        console.log(`✅ Created: ${sku}`);
        
      } catch (error) {
        console.error('Error saving listing:', error);
        
        if (error.code === 11000) {
          skippedCount++;
          results.push({
            status: 'skipped',
            asin: listingData._asinReference,
            error: 'Duplicate SKU'
          });
        } else {
          errors.push({
            asin: listingData._asinReference,
            error: error.message
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: error.message
          });
        }
      }
    }
    
    const created = results.filter(r => r.status === 'created').length;
    const reactivated = results.filter(r => r.status === 'reactivated').length;
    const failed = results.filter(r => r.status === 'failed').length;
    
    console.log(`✅ Bulk save completed: ${created} created, ${reactivated} reactivated, ${failed} failed, ${skippedCount} skipped`);
    
    res.json({
      success: true,
      total: listings.length,
      created,
      reactivated,
      failed,
      skipped: skippedCount,
      results,
      errors: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    console.error('Bulk save error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to bulk save listings' 
    });
  }
});

// Bulk import ASINs (quick import without fetching Amazon data)
router.post('/bulk-import-asins', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, asins } = req.body;
    
    // Validate required fields
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      return res.status(400).json({ error: 'ASINs array is required and must not be empty' });
    }
    
    console.log('📦 Bulk import request:', { templateId, sellerId, asinCount: asins.length });
    
    // Validate template (with seller overrides) and seller exist
    const [template, seller] = await Promise.all([
      getEffectiveTemplate(templateId, sellerId),
      Seller.findById(sellerId)
    ]);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }
    
    // Get existing SKUs for this seller to avoid duplicates
    const existingSKUs = await TemplateListing.find({ 
      templateId,
      sellerId,
      status: { $in: ['active', 'draft'] }
    }).distinct('customLabel');
    
    const skuSet = new Set(existingSKUs);
    let skuCounter = Date.now();
    
    // Process ASINs and generate SKUs
    const listingsToCreate = [];
    const skippedASINs = [];
    
    for (const asin of asins) {
      const cleanASIN = asin.trim().toUpperCase();
      
      // Basic ASIN validation (should start with B0 and be 10 chars)
      if (!cleanASIN || cleanASIN.length !== 10 || !cleanASIN.startsWith('B0')) {
        skippedASINs.push({
          asin: cleanASIN,
          reason: 'Invalid ASIN format'
        });
        continue;
      }
      
      // Generate SKU using GRW25 + last 5 chars
      let sku = generateSKUFromASIN(cleanASIN);
      
      // Check for duplicates and make unique
      if (skuSet.has(sku)) {
        // If collision, append timestamp suffix
        const baseSKU = sku;
        let suffix = 1;
        
        do {
          sku = `${baseSKU}-${suffix++}`;
        } while (skuSet.has(sku));
        
        console.log(`SKU collision detected: ${baseSKU} → ${sku}`);
      }
      
      skuSet.add(sku);
      
      // Create minimal listing object
      listingsToCreate.push({
        templateId,
        sellerId,
        _asinReference: cleanASIN,
        customLabel: sku,
        amazonLink: `https://www.amazon.com/dp/${cleanASIN}`,
        title: `Imported Product - ${cleanASIN}`,
        startPrice: 0.01, // Minimum placeholder
        quantity: 1,
        status: 'active',
        conditionId: '1000-New',
        format: 'FixedPrice',
        duration: 'GTC',
        location: 'UnitedStates',
        createdBy: req.user.userId
      });
    }
    
    console.log(`📊 Prepared ${listingsToCreate.length} listings, ${skippedASINs.length} skipped (validation)`);
    
    // Check for existing listings with same ASINs in active/draft status
    const existingByASIN = await TemplateListing.find({
      templateId,
      sellerId,
      _asinReference: { $in: listingsToCreate.map(l => l._asinReference) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference');
    
    const existingASINs = new Set(existingByASIN.map(l => l._asinReference));
    
    console.log(`🔍 Found ${existingASINs.size} existing active/draft ASINs in database`);
    
    // Check for inactive listings that can be reactivated
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      _asinReference: { $in: listingsToCreate.map(l => l._asinReference) },
      status: 'inactive'
    }).select('customLabel _asinReference');
    
    const inactiveASINMap = new Map(inactiveListings.map(l => [l._asinReference, l]));
    
    console.log(`🔄 Found ${inactiveASINMap.size} inactive ASINs that can be reactivated`);
    
    // Separate listings into: reactivate, skip (already active), or create new
    const listingsToReactivate = [];
    const newListings = [];
    
    for (const listing of listingsToCreate) {
      if (existingASINs.has(listing._asinReference)) {
        // Already exists as active/draft - skip
        const existing = existingByASIN.find(e => e._asinReference === listing._asinReference);
        skippedASINs.push({
          asin: listing._asinReference,
          sku: listing.customLabel,
          reason: `Already exists in database (SKU: ${existing.customLabel})`
        });
      } else if (inactiveASINMap.has(listing._asinReference)) {
        // Exists as inactive - reactivate
        listingsToReactivate.push({
          existing: inactiveASINMap.get(listing._asinReference),
          newData: listing
        });
      } else {
        // Doesn't exist - create new
        newListings.push(listing);
      }
    }
    
    console.log(`✅ ${newListings.length} new listings to insert, ${listingsToReactivate.length} to reactivate`);
    
    // Reactivate inactive listings
    let reactivatedCount = 0;
    if (listingsToReactivate.length > 0) {
      const reactivateOps = listingsToReactivate.map(({ existing, newData }) => ({
        updateOne: {
          filter: { _id: existing._id },
          update: {
            $set: {
              ...newData,
              status: 'active',
              updatedAt: Date.now()
            }
          }
        }
      }));
      
      const reactivateResult = await TemplateListing.bulkWrite(reactivateOps);
      reactivatedCount = reactivateResult.modifiedCount || 0;
      console.log(`🔄 Reactivated ${reactivatedCount} inactive listings`);
    }
    
    // Bulk insert new listings
    let importedCount = 0;
    let insertErrors = [];
    
    if (newListings.length > 0) {
      try {
        const result = await TemplateListing.insertMany(newListings, {
          ordered: false, // Continue on error
          rawResult: true
        });
        
        importedCount = result.insertedCount || newListings.length;
        
        // Handle any write errors
        if (result.writeErrors && result.writeErrors.length > 0) {
          result.writeErrors.forEach(err => {
            const listing = newListings[err.index];
            if (err.code === 11000) {
              skippedASINs.push({
                asin: listing._asinReference,
                sku: listing.customLabel,
                reason: 'Duplicate key error'
              });
            } else {
              insertErrors.push({
                asin: listing._asinReference,
                sku: listing.customLabel,
                error: err.errmsg
              });
            }
          });
        }
      } catch (error) {
        // Handle bulk insert errors
        if (error.code === 11000 && error.writeErrors) {
          importedCount = error.insertedDocs ? error.insertedDocs.length : 0;
          
          error.writeErrors.forEach(err => {
            const listing = newListings[err.index];
            skippedASINs.push({
              asin: listing._asinReference,
              sku: listing.customLabel,
              reason: 'Duplicate key error'
            });
          });
        } else {
          throw error;
        }
      }
    }
    
    console.log(`🎉 Import complete: ${importedCount} new, ${reactivatedCount} reactivated, ${skippedASINs.length} skipped`);
    
    res.json({
      total: asins.length,
      imported: importedCount,
      reactivated: reactivatedCount,
      skipped: skippedASINs.length,
      skippedDetails: skippedASINs,
      errors: insertErrors.length > 0 ? insertErrors : undefined
    });
    
  } catch (error) {
    console.error('❌ Bulk import error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to bulk import ASINs' 
    });
  }
});

// Bulk import SKUs (quick import with SKUs directly)
router.post('/bulk-import-skus', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, skus } = req.body;
    
    // Validate required fields
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'SKUs array is required and must not be empty' });
    }
    
    console.log('📦 Bulk SKU import request:', { templateId, sellerId, skuCount: skus.length });
    
    // Validate template (with seller overrides) and seller exist
    const [template, seller] = await Promise.all([
      getEffectiveTemplate(templateId, sellerId),
      Seller.findById(sellerId)
    ]);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }
    
    // Process SKUs
    const listingsToCreate = [];
    const skippedSKUs = [];
    const processedSKUs = new Set();
    
    for (const sku of skus) {
      const cleanSKU = sku.trim();
      
      // Basic SKU validation (not empty, reasonable length)
      if (!cleanSKU || cleanSKU.length === 0) {
        skippedSKUs.push({
          sku: cleanSKU,
          reason: 'Empty SKU'
        });
        continue;
      }
      
      if (cleanSKU.length > 100) {
        skippedSKUs.push({
          sku: cleanSKU,
          reason: 'SKU too long (max 100 characters)'
        });
        continue;
      }
      
      // Check for duplicates in current batch
      if (processedSKUs.has(cleanSKU)) {
        skippedSKUs.push({
          sku: cleanSKU,
          reason: 'Duplicate SKU in import batch'
        });
        continue;
      }
      
      processedSKUs.add(cleanSKU);
      
      // Create minimal listing object
      listingsToCreate.push({
        templateId,
        sellerId,
        customLabel: cleanSKU,
        title: `Product - ${cleanSKU}`,
        startPrice: 0.01, // Minimum placeholder
        quantity: 1,
        status: 'active',
        conditionId: '1000-New',
        format: 'FixedPrice',
        duration: 'GTC',
        location: 'UnitedStates',
        createdBy: req.user.userId
      });
    }
    
    console.log(`📊 Prepared ${listingsToCreate.length} listings, ${skippedSKUs.length} skipped (validation)`);
    
    // Check for existing SKUs across ALL templates for this seller (cross-template validation)
    const crossTemplateSkus = await TemplateListing.find({
      sellerId,
      templateId: { $ne: templateId }, // Different templates
      customLabel: { $in: listingsToCreate.map(l => l.customLabel) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel templateId _asinReference');
    
    const crossTemplateSKUMap = new Map(
      crossTemplateSkus.map(l => [l.customLabel, { templateId: l.templateId, asin: l._asinReference }])
    );
    
    console.log(`🚫 Found ${crossTemplateSKUMap.size} SKUs in other templates`);
    
    // Filter out SKUs that exist in other templates
    const skusNotInOtherTemplates = listingsToCreate.filter(listing => {
      if (crossTemplateSKUMap.has(listing.customLabel)) {
        const existing = crossTemplateSKUMap.get(listing.customLabel);
        skippedSKUs.push({
          sku: listing.customLabel,
          reason: existing.asin
            ? `SKU already exists in another template for ASIN ${existing.asin}`
            : `SKU already exists in another template`
        });
        return false;
      }
      return true;
    });
    
    // Check for existing listings with same SKUs in active/draft status (current template)
    const existingBySKU = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skusNotInOtherTemplates.map(l => l.customLabel) },
      status: { $in: ['active', 'draft'] }
    }).select('customLabel _asinReference');
    
    const existingSKUs = new Set(existingBySKU.map(l => l.customLabel));
    
    console.log(`🔍 Found ${existingSKUs.size} existing active/draft SKUs in database`);
    
    // Check for inactive listings that can be reactivated
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skusNotInOtherTemplates.map(l => l.customLabel) },
      status: 'inactive'
    }).select('customLabel _asinReference');
    
    const inactiveSKUMap = new Map(inactiveListings.map(l => [l.customLabel, l]));
    
    console.log(`🔄 Found ${inactiveSKUMap.size} inactive SKUs that can be reactivated`);
    
    // Separate listings into: reactivate, skip (already active), or create new
    const listingsToReactivate = [];
    const newListings = [];
    
    for (const listing of skusNotInOtherTemplates) {
      if (existingSKUs.has(listing.customLabel)) {
        // Already exists as active/draft - skip
        const existing = existingBySKU.find(e => e.customLabel === listing.customLabel);
        skippedSKUs.push({
          sku: listing.customLabel,
          reason: `Already exists in database${existing._asinReference ? ` (ASIN: ${existing._asinReference})` : ''}`
        });
      } else if (inactiveSKUMap.has(listing.customLabel)) {
        // Exists as inactive - reactivate
        listingsToReactivate.push({
          existing: inactiveSKUMap.get(listing.customLabel),
          newData: listing
        });
      } else {
        // Doesn't exist - create new
        newListings.push(listing);
      }
    }
    
    console.log(`✅ ${newListings.length} new listings to insert, ${listingsToReactivate.length} to reactivate`);
    
    // Reactivate inactive listings
    let reactivatedCount = 0;
    if (listingsToReactivate.length > 0) {
      const reactivateOps = listingsToReactivate.map(({ existing, newData }) => ({
        updateOne: {
          filter: { _id: existing._id },
          update: {
            $set: {
              ...newData,
              status: 'active',
              updatedAt: Date.now()
            }
          }
        }
      }));
      
      const reactivateResult = await TemplateListing.bulkWrite(reactivateOps);
      reactivatedCount = reactivateResult.modifiedCount || 0;
      console.log(`🔄 Reactivated ${reactivatedCount} inactive listings`);
    }
    
    // Bulk insert new listings
    let importedCount = 0;
    let insertErrors = [];
    
    if (newListings.length > 0) {
      try {
        const result = await TemplateListing.insertMany(newListings, {
          ordered: false, // Continue on error
          rawResult: true
        });
        
        importedCount = result.insertedCount || newListings.length;
        
        // Handle any write errors
        if (result.writeErrors && result.writeErrors.length > 0) {
          result.writeErrors.forEach(err => {
            const listing = newListings[err.index];
            if (err.code === 11000) {
              skippedSKUs.push({
                sku: listing.customLabel,
                reason: 'Duplicate key error'
              });
            } else {
              insertErrors.push({
                sku: listing.customLabel,
                error: err.errmsg
              });
            }
          });
        }
      } catch (error) {
        // Handle bulk insert errors
        if (error.code === 11000 && error.writeErrors) {
          importedCount = error.insertedDocs ? error.insertedDocs.length : 0;
          
          error.writeErrors.forEach(err => {
            const listing = newListings[err.index];
            skippedSKUs.push({
              sku: listing.customLabel,
              reason: 'Duplicate key error'
            });
          });
        } else {
          throw error;
        }
      }
    }
    
    console.log(`🎉 SKU Import complete: ${importedCount} new, ${reactivatedCount} reactivated, ${skippedSKUs.length} skipped`);
    
    res.json({
      total: skus.length,
      imported: importedCount,
      reactivated: reactivatedCount,
      skipped: skippedSKUs.length,
      skippedDetails: skippedSKUs,
      errors: insertErrors.length > 0 ? insertErrors : undefined
    });
    
  } catch (error) {
    console.error('❌ Bulk SKU import error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to bulk import SKUs' 
    });
  }
});

// Bulk import from CSV
router.post('/bulk-import', requireAuth, async (req, res) => {
  try {
    const { templateId, listings } = req.body;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({ error: 'Listings array is required' });
    }
    
    // Add metadata to each listing
    const listingsToInsert = listings.map(listing => ({
      ...listing,
      templateId,
      createdBy: req.user.userId,
      customFields: listing.customFields 
        ? new Map(Object.entries(listing.customFields))
        : new Map()
    }));
    
    const result = await TemplateListing.insertMany(listingsToInsert, { 
      ordered: false // Continue on error
    });
    
    res.json({ 
      message: 'Listings imported successfully',
      importedCount: result.length 
    });
  } catch (error) {
    if (error.code === 11000) {
      // Some duplicates were found
      const insertedCount = error.insertedDocs ? error.insertedDocs.length : 0;
      return res.status(207).json({ 
        message: 'Import completed with some duplicates skipped',
        importedCount: insertedCount,
        errors: error.writeErrors || []
      });
    }
    console.error('Error bulk importing listings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export listings as eBay CSV
router.get('/export-csv/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId } = req.query;
    
    // Build filter for ACTIVE listings only that haven't been downloaded yet
    // Inactive listings (deactivated by user) are excluded from CSV downloads
    // even if they have downloadBatchId=null, ensuring consistency with UI
    const filter = { 
      templateId,
      downloadBatchId: null, // Only active batch (not yet downloaded)
      status: 'active'       // Only active listings (exclude inactive/draft/sold/ended)
    };
    if (sellerId) {
      filter.sellerId = sellerId;
    }
    
    // Fetch effective template (includes seller overrides), seller, and filtered listings
    const [template, seller, listings] = await Promise.all([
      getEffectiveTemplate(templateId, sellerId),
      sellerId ? Seller.findById(sellerId).populate('user', 'username email') : null,
      TemplateListing.find(filter).sort({ createdAt: -1 })
    ]);
    
    console.log('📊 Export CSV - Seller info:', seller?.user?.username || seller?.user?.email || 'No seller');
    console.log('📊 Export CSV - Listings count:', listings.length);
    console.log('📥 Exporting active listings only (excluded inactive/draft)');
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (listings.length === 0) {
      return res.status(400).json({ error: 'No active listings to download' });
    }
    
    // Generate batch ID and get next batch number
    const crypto = await import('crypto');
    const batchId = crypto.randomUUID();
    
    // Get next batch number for this template + seller combination
    const latestBatch = await TemplateListing.findOne({
      templateId,
      sellerId: sellerId || { $exists: true },
      downloadBatchNumber: { $ne: null }
    }).sort({ downloadBatchNumber: -1 });
    
    const batchNumber = (latestBatch?.downloadBatchNumber || 0) + 1;
    
    console.log('🔢 Batch number:', batchNumber);
    console.log('🆔 Batch ID:', batchId);
    
    // Mark listings as downloaded
    const updateResult = await TemplateListing.updateMany(
      filter,
      {
        downloadBatchId: batchId,
        downloadedAt: new Date(),
        downloadBatchNumber: batchNumber
      }
    );
    
    console.log('✅ Updated listings:', updateResult.modifiedCount);
    
    // Get custom Action field from template
    const actionField = template.customActionField || '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)';
    console.log('📝 Using Action field:', actionField);
    
    // Build core headers (38 columns)
    const coreHeaders = [
      actionField,
      'Custom label (SKU)',
      'Category ID',
      'Category name',
      'Title',
      'Relationship',
      'Relationship details',
      'Schedule Time',
      'P:UPC',
      'P:EPID',
      'Start price',
      'Quantity',
      'Item photo URL',
      'VideoID',
      'Condition ID',
      'Description',
      'Format',
      'Duration',
      'Buy It Now price',
      'Best Offer Enabled',
      'Best Offer Auto Accept Price',
      'Minimum Best Offer Price',
      'Immediate pay required',
      'Location',
      'Shipping service 1 option',
      'Shipping service 1 cost',
      'Shipping service 1 priority',
      'Shipping service 2 option',
      'Shipping service 2 cost',
      'Shipping service 2 priority',
      'Max dispatch time',
      'Returns accepted option',
      'Returns within option',
      'Refund option',
      'Return shipping cost paid by',
      'Shipping profile name',
      'Return profile name',
      'Payment profile name'
    ];
    
    // Add custom column headers
    const customHeaders = template.customColumns
      .sort((a, b) => a.order - b.order)
      .map(col => col.name);
    
    const allHeaders = [...coreHeaders, ...customHeaders];
    const columnCount = allHeaders.length;
    
    // Generate #INFO lines (must match column count exactly)
    const emptyRow = new Array(columnCount).fill('');
    
    // INFO Line 1: Created timestamp + required field indicator
    const infoLine1 = ['#INFO', `Created=${Date.now()}`, '', '', '', '', 
                       ' Indicates missing required fields', '', '', '', '',
                       ' Indicates missing field that will be required soon',
                       ...new Array(columnCount - 12).fill('')];
    
    // INFO Line 2: Version + recommended field indicator  
    const infoLine2 = ['#INFO', 'Version=1.0', '', 
                       'Template=fx_category_template_EBAY_US', '', '',
                       ' Indicates missing recommended field', '', '', '', '',
                       ' Indicates field does not apply to this item/category',
                       ...new Array(columnCount - 12).fill('')];
    
    // INFO Line 3: All empty commas
    const infoLine3 = new Array(columnCount).fill('')
    infoLine3[0] = '#INFO';
    
    // Map listings to CSV rows
    const dataRows = listings.map(listing => {
      // Add leading slash to category name if not present
      let categoryName = listing.categoryName || '';
      if (categoryName && !categoryName.startsWith('/')) {
        categoryName = '/' + categoryName;
      }
      
      const coreValues = [
        listing.action || 'Add',
        listing.customLabel || '',
        listing.categoryId || '',
        categoryName,
        listing.title || '',
        listing.relationship || '',
        listing.relationshipDetails || '',
        listing.scheduleTime || '',
        listing.upc || '',
        listing.epid || '',
        listing.startPrice || '',
        listing.quantity || '',
        listing.itemPhotoUrl || '',
        listing.videoId || '',
        listing.conditionId || '1000-New',
        listing.description || '',
        listing.format || 'FixedPrice',
        listing.duration || 'GTC',
        listing.buyItNowPrice || '',
        listing.bestOfferEnabled || '',
        listing.bestOfferAutoAcceptPrice || '',
        listing.minimumBestOfferPrice || '',
        listing.immediatePayRequired || '',
        listing.location || 'UnitedStates',
        listing.shippingService1Option || '',
        listing.shippingService1Cost || '',
        listing.shippingService1Priority || '',
        listing.shippingService2Option || '',
        listing.shippingService2Cost || '',
        listing.shippingService2Priority || '',
        listing.maxDispatchTime || '',
        listing.returnsAcceptedOption || '',
        listing.returnsWithinOption || '',
        listing.refundOption || '',
        listing.returnShippingCostPaidBy || '',
        listing.shippingProfileName || '',
        listing.returnProfileName || '',
        listing.paymentProfileName || ''
      ];
      
      // Get custom field values in order
      const customValues = template.customColumns
        .sort((a, b) => a.order - b.order)
        .map(col => listing.customFields.get(col.name) || '');
      
      return [...coreValues, ...customValues];
    });
    
    // Combine all rows
    const allRows = [infoLine1, infoLine2, infoLine3, allHeaders, ...dataRows];
    
    // Convert to CSV string with proper escaping
    const csvContent = allRows.map(row => 
      row.map(cell => {
        const value = String(cell || '');
        // Escape quotes and wrap in quotes if contains comma/quote/newline
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',')
    ).join('\n');
    
    // Send as downloadable file with template, seller, batch number and date
    const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const sellerName = seller?.user?.username || seller?.user?.email || 'seller';
    const templateName = template.name.replace(/\s+/g, '_');
    const filename = `${templateName}_${sellerName}_batch_${batchNumber}_${dateStr}.csv`;
    
    console.log('📁 Generated filename:', filename);
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
    
  } catch (error) {
    console.error('Error exporting CSV:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get download history for a template/seller
router.get('/download-history/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId } = req.query;
    
    console.log('📜 Download history request - Template:', templateId, 'Seller:', sellerId);
    
    // Convert string IDs to ObjectIds for aggregation
    const mongoose = await import('mongoose');
    const filter = {
      templateId: new mongoose.default.Types.ObjectId(templateId),
      downloadBatchId: { $ne: null }
    };
    
    if (sellerId) {
      filter.sellerId = new mongoose.default.Types.ObjectId(sellerId);
    }
    
    console.log('🔍 Filter:', JSON.stringify(filter));
    
    // First, let's check ALL listings for this template/seller
    const allListings = await TemplateListing.find({
      templateId,
      sellerId: sellerId || { $exists: true }
    }).select('downloadBatchId downloadBatchNumber downloadedAt customLabel');
    
    console.log('📋 Total listings found:', allListings.length);
    console.log('📊 All listings batch info:', allListings.map(l => ({
      sku: l.customLabel,
      batchId: l.downloadBatchId,
      batchNumber: l.downloadBatchNumber,
      downloadedAt: l.downloadedAt
    })));
    
    // Get unique batches with their metadata
    const batches = await TemplateListing.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$downloadBatchId',
          batchNumber: { $first: '$downloadBatchNumber' },
          downloadedAt: { $first: '$downloadedAt' },
          listingCount: { $sum: 1 }
        }
      },
      { $sort: { batchNumber: 1 } }
    ]);
    
    console.log('📊 Aggregation result:', batches);
    
    // Format response
    const history = batches.map(batch => ({
      batchId: batch._id,
      batchNumber: batch.batchNumber,
      downloadedAt: batch.downloadedAt,
      listingCount: batch.listingCount
    }));
    
    console.log('✅ Sending history:', history);
    
    res.json(history);
  } catch (error) {
    console.error('Error fetching download history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Re-download a specific batch
router.get('/re-download-batch/:templateId/:batchId', requireAuth, async (req, res) => {
  try {
    const { templateId, batchId } = req.params;
    const { sellerId } = req.query;
    
    // Build filter for specific batch
    const filter = { 
      templateId,
      downloadBatchId: batchId
    };
    if (sellerId) {
      filter.sellerId = sellerId;
    }
    
    // Fetch effective template (includes seller overrides), seller, and batch listings
    const [template, seller, listings] = await Promise.all([
      getEffectiveTemplate(templateId, sellerId),
      sellerId ? Seller.findById(sellerId).populate('user', 'username email') : null,
      TemplateListing.find(filter).sort({ createdAt: -1 })
    ]);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (listings.length === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    const batchNumber = listings[0].downloadBatchNumber;
    
    // Get custom Action field from template
    const actionField = template.customActionField || '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)';
    console.log('📝 Using Action field:', actionField);
    
    // Build core headers (38 columns)
    const coreHeaders = [
      actionField,
      'Custom label (SKU)',
      'Category ID',
      'Category name',
      'Title',
      'Relationship',
      'Relationship details',
      'Schedule Time',
      'P:UPC',
      'P:EPID',
      'Start price',
      'Quantity',
      'Item photo URL',
      'VideoID',
      'Condition ID',
      'Description',
      'Format',
      'Duration',
      'Buy It Now price',
      'Best offer enabled',
      'Best offer: Auto accept price',
      'Minimum best offer price',
      'Immediate pay required',
      'Location',
      'Shipping service 1: option',
      'Shipping service 1: cost',
      'Shipping service 1: priority',
      'Shipping service 2: option',
      'Shipping service 2: cost',
      'Shipping service 2: priority',
      'Max dispatch time',
      'Returns accepted option',
      'Returns within option',
      'Refund option',
      'Return shipping cost paid by',
      'Shipping profile name',
      'Return profile name',
      'Payment profile name'
    ];
    
    // Add custom column headers
    const customHeaders = template.customColumns
      .sort((a, b) => a.order - b.order)
      .map(col => col.name);
    
    const allHeaders = [...coreHeaders, ...customHeaders];
    const columnCount = allHeaders.length;
    
    // Generate #INFO lines (must match column count exactly)
    const emptyRow = new Array(columnCount).fill('');
    
    // INFO Line 1: Created timestamp + required field indicator
    const infoLine1 = ['#INFO', `Created=${Date.now()}`, '', '', '', '', 
                       ' Indicates missing required fields', '', '', '', '',
                       ' Indicates missing field that will be required soon',
                       ...new Array(columnCount - 12).fill('')];
    
    // INFO Line 2: Version + recommended field indicator  
    const infoLine2 = ['#INFO', 'Version=1.0', '', 
                       'Template=fx_category_template_EBAY_US', '', '',
                       ' Indicates missing recommended field', '', '', '', '',
                       ' Indicates field does not apply to this item/category',
                       ...new Array(columnCount - 12).fill('')];
    
    // INFO Line 3: All empty commas
    const infoLine3 = new Array(columnCount).fill('')
    infoLine3[0] = '#INFO';
    
    // Map listings to CSV rows
    const dataRows = listings.map(listing => {
      // Add leading slash to category name if not present
      let categoryName = listing.categoryName || '';
      if (categoryName && !categoryName.startsWith('/')) {
        categoryName = '/' + categoryName;
      }
      
      const coreValues = [
        listing.action || 'Add',
        listing.customLabel || '',
        listing.categoryId || '',
        categoryName,
        listing.title || '',
        listing.relationship || '',
        listing.relationshipDetails || '',
        listing.scheduleTime || '',
        listing.upc || '',
        listing.epid || '',
        listing.startPrice || '',
        listing.quantity || '',
        listing.itemPhotoUrl || '',
        listing.videoId || '',
        listing.conditionId || '1000-New',
        listing.description || '',
        listing.format || 'FixedPrice',
        listing.duration || 'GTC',
        listing.buyItNowPrice || '',
        listing.bestOfferEnabled || '',
        listing.bestOfferAutoAcceptPrice || '',
        listing.minimumBestOfferPrice || '',
        listing.immediatePayRequired || '',
        listing.location || 'UnitedStates',
        listing.shippingService1Option || '',
        listing.shippingService1Cost || '',
        listing.shippingService1Priority || '',
        listing.shippingService2Option || '',
        listing.shippingService2Cost || '',
        listing.shippingService2Priority || '',
        listing.maxDispatchTime || '',
        listing.returnsAcceptedOption || '',
        listing.returnsWithinOption || '',
        listing.refundOption || '',
        listing.returnShippingCostPaidBy || '',
        listing.shippingProfileName || '',
        listing.returnProfileName || '',
        listing.paymentProfileName || ''
      ];
      
      // Get custom field values in order
      const customValues = template.customColumns
        .sort((a, b) => a.order - b.order)
        .map(col => listing.customFields.get(col.name) || '');
      
      return [...coreValues, ...customValues];
    });
    
    // Combine all rows
    const allRows = [infoLine1, infoLine2, infoLine3, allHeaders, ...dataRows];
    
    // Convert to CSV string with proper escaping
    const csvContent = allRows.map(row => 
      row.map(cell => {
        const value = String(cell || '');
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',')
    ).join('\n');
    
    // Send as downloadable file with template, seller, batch number and date
    const dateStr = new Date().toISOString().split('T')[0];
    const sellerName = seller?.user?.username || seller?.user?.email || 'seller';
    const templateName = template.name.replace(/\s+/g, '_');
    const filename = `${templateName}_${sellerName}_batch_${batchNumber}_${dateStr}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
    
  } catch (error) {
    console.error('Error re-downloading batch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search for inactive listings by SKU
router.post('/search-inactive-skus', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, skus } = req.body;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'SKUs array is required' });
    }
    
    // Find inactive listings
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'inactive'
    }).select('+_asinReference');
    
    // Find already active listings
    const activeListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'active'
    }).select('customLabel');
    
    const foundSKUs = new Set(inactiveListings.map(l => l.customLabel));
    const activeSKUs = activeListings.map(l => l.customLabel);
    const notFoundSKUs = skus.filter(sku => !foundSKUs.has(sku) && !activeSKUs.includes(sku));
    
    console.log(`🔍 Search inactive SKUs: ${inactiveListings.length} found, ${activeSKUs.length} already active, ${notFoundSKUs.length} not found`);
    
    res.json({
      found: inactiveListings,
      notFound: notFoundSKUs,
      alreadyActive: activeSKUs
    });
  } catch (error) {
    console.error('Error searching inactive SKUs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk reactivate inactive listings
router.post('/bulk-reactivate', requireAuth, async (req, res) => {
  try {
    const { listingIds } = req.body;
    
    if (!listingIds || !Array.isArray(listingIds) || listingIds.length === 0) {
      return res.status(400).json({ error: 'listingIds array is required' });
    }
    
    // Update status to active
    const result = await TemplateListing.updateMany(
      {
        _id: { $in: listingIds },
        status: 'inactive'
      },
      {
        $set: {
          status: 'active',
          updatedAt: Date.now()
        }
      }
    );
    
    // Get updated listings for response
    const reactivatedListings = await TemplateListing.find({
      _id: { $in: listingIds },
      status: 'active'
    }).select('customLabel title _asinReference');
    
    console.log(`✅ Reactivated ${result.modifiedCount} listings`);
    
    res.json({
      success: true,
      reactivated: result.modifiedCount,
      details: reactivatedListings
    });
  } catch (error) {
    console.error('Error reactivating listings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk deactivate active listings
router.post('/bulk-deactivate', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, skus } = req.body;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'SKUs array is required' });
    }
    
    // Find active listings
    const activeListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'active'
    }).select('customLabel title _asinReference');
    
    // Find already inactive
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'inactive'
    }).select('customLabel');
    
    const foundSKUs = new Set(activeListings.map(l => l.customLabel));
    const alreadyInactiveSKUs = inactiveListings.map(l => l.customLabel);
    const notFoundSKUs = skus.filter(sku => 
      !foundSKUs.has(sku) && !alreadyInactiveSKUs.includes(sku)
    );
    
    // Deactivate
    const result = await TemplateListing.updateMany(
      {
        templateId,
        sellerId,
        customLabel: { $in: Array.from(foundSKUs) },
        status: 'active'
      },
      {
        $set: {
          status: 'inactive',
          updatedAt: Date.now()
        }
      }
    );
    
    console.log(`⏸️ Deactivated ${result.modifiedCount} listings`);
    
    res.json({
      success: true,
      summary: {
        total: skus.length,
        deactivated: result.modifiedCount,
        notFound: notFoundSKUs.length,
        alreadyInactive: alreadyInactiveSKUs.length
      },
      details: {
        deactivated: activeListings,
        notFound: notFoundSKUs,
        alreadyInactive: alreadyInactiveSKUs
      }
    });
  } catch (error) {
    console.error('Error deactivating listings:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/seller/:sellerId/template-listings/api-usage-stats
 * Get API usage statistics (ScraperAPI, PAAPI, Gemini)
 */
router.get('/api/seller/:sellerId/template-listings/api-usage-stats', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { service, year, month } = req.query;
    
    // Build query
    const query = {};
    if (service) query.service = service;
    if (year) query.year = parseInt(year);
    if (month) query.month = parseInt(month);
    
    const stats = await getUsageStats(query);
    
    res.json({
      success: true,
      stats,
      message: `Retrieved usage statistics${service ? ` for ${service}` : ''}`
    });
  } catch (error) {
    console.error('[API Usage Stats] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/seller/:sellerId/template-listings/api-usage-field-stats
 * Get field extraction statistics for a specific service
 */
router.get('/api/seller/:sellerId/template-listings/api-usage-field-stats', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { service, year, month } = req.query;
    
    if (!service) {
      return res.status(400).json({
        success: false,
        message: 'Service parameter is required'
      });
    }
    
    const query = { service };
    if (year) query.year = parseInt(year);
    if (month) query.month = parseInt(month);
    
    const stats = await getFieldExtractionStats(query);
    
    res.json({
      success: true,
      stats,
      message: `Retrieved field extraction statistics for ${service}`
    });
  } catch (error) {
    console.error('[API Field Stats] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/seller/:sellerId/template-listings/api-usage-errors
 * Get recent API errors for debugging
 */
router.get('/api/seller/:sellerId/template-listings/api-usage-errors', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { service, limit = 50 } = req.query;
    
    if (!service) {
      return res.status(400).json({
        success: false,
        message: 'Service parameter is required'
      });
    }
    
    const errors = await getRecentErrors(service, parseInt(limit));
    
    res.json({
      success: true,
      errors,
      count: errors.length,
      message: `Retrieved ${errors.length} recent errors for ${service}`
    });
  } catch (error) {
    console.error('[API Errors] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/seller/:sellerId/template-listings/api-quota-status
 * Check quota status for a service
 */
router.get('/api/seller/:sellerId/template-listings/api-quota-status', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { service, quota = 5000 } = req.query;
    
    if (!service) {
      return res.status(400).json({
        success: false,
        message: 'Service parameter is required'
      });
    }
    
    const status = await checkQuotaStatus(service, parseInt(quota));
    
    res.json({
      success: true,
      quotaStatus: status,
      message: `Quota status: ${status.status.toUpperCase()} - ${status.percentUsed}% used`
    });
  } catch (error) {
    console.error('[Quota Status] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /template-listings/cache-stats
 * Get ASIN cache statistics
 */
router.get('/cache-stats', requireAuth, async (req, res) => {
  try {
    const stats = getAsinCacheStats();
    
    res.json({
      success: true,
      cache: stats,
      message: `Cache ${stats.enabled ? 'enabled' : 'disabled'} - ${stats.keys} ASINs cached, ${stats.hitRate}% hit rate`
    });
  } catch (error) {
    console.error('[Cache Stats] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * POST /template-listings/cache-clear
 * Clear ASIN cache
 */
router.post('/cache-clear', requireAuth, async (req, res) => {
  try {
    clearAsinCache();
    
    res.json({
      success: true,
      message: 'ASIN cache cleared successfully'
    });
  } catch (error) {
    console.error('[Cache Clear] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * POST /template-listings/cache-invalidate/:asin
 * Invalidate specific ASIN from cache
 */
router.post('/cache-invalidate/:asin', requireAuth, async (req, res) => {
  try {
    const { asin } = req.params;
    const invalidated = invalidateAsinCache(asin);
    
    res.json({
      success: true,
      invalidated,
      message: invalidated ? `ASIN ${asin} removed from cache` : `ASIN ${asin} not found in cache`
    });
  } catch (error) {
    console.error('[Cache Invalidate] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

export default router;


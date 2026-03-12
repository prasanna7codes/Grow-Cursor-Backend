import express from 'express';
import AsinDirectory from '../models/AsinDirectory.js';
import { requireAuth } from '../middleware/auth.js';
import { fetchAmazonData } from '../utils/asinAutofill.js';

// Scrape a batch of ASINs in parallel (max 5 at a time) and return enrichment map
async function scrapeAsinsBatched(asinList, region = 'US', batchSize = 5) {
  const enrichmentMap = new Map();
  for (let i = 0; i < asinList.length; i += batchSize) {
    const batch = asinList.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(asin => fetchAmazonData(asin, region)));
    results.forEach((result, idx) => {
      const asin = batch[idx];
      if (result.status === 'fulfilled') {
        enrichmentMap.set(asin, { ok: true, data: result.value });
      } else {
        enrichmentMap.set(asin, { ok: false, error: result.reason?.message || 'Scrape failed' });
      }
    });
  }
  return enrichmentMap;
}

const router = express.Router();

// Get all ASINs with pagination and search
router.get('/', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy || '-addedAt'; // Default: newest first
    const listProductId = req.query.listProductId || '';

    const skip = (page - 1) * limit;

    // Build query
    let query = {};
    if (search) {
      query.$or = [
        { asin: { $regex: search, $options: 'i' } },
        { title: { $regex: search, $options: 'i' } },
      ];
    }
    if (listProductId) {
      query.listProductId = listProductId;
    } else if (req.query.showMoved !== 'true') {
      // Default: hide ASINs already moved to a list
      query.listProductId = null;
    }

    const region = req.query.region || '';
    if (region) query.region = region;

    // Get total count
    const total = await AsinDirectory.countDocuments(query);

    // Get paginated results
    const asins = await AsinDirectory.find(query)
      .sort(sortBy)
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({
      asins,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching ASINs:', error);
    res.status(500).json({ error: 'Failed to fetch ASINs' });
  }
});

// Get multiple ASINs by exact ASIN list (used by Proof Read flow)
router.get('/by-asins', requireAuth, async (req, res) => {
  try {
    const { asins } = req.query; // comma-separated ASIN strings
    if (!asins) return res.status(400).json({ error: 'asins query param required' });
    const asinList = asins.split(',').map(a => a.trim().toUpperCase()).filter(Boolean);
    const docs = await AsinDirectory.find({ asin: { $in: asinList } }).lean();
    res.json(docs);
  } catch (error) {
    console.error('Error fetching ASINs by list:', error);
    res.status(500).json({ error: 'Failed to fetch ASINs' });
  }
});

// Get statistics
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const total = await AsinDirectory.countDocuments();
    const unassigned = await AsinDirectory.countDocuments({ listProductId: null });

    const now = new Date();
    const todayStart = new Date(now.setHours(0, 0, 0, 0));
    const weekStart = new Date(now.setDate(now.getDate() - now.getDay()));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const today = await AsinDirectory.countDocuments({ addedAt: { $gte: todayStart } });
    const thisWeek = await AsinDirectory.countDocuments({ addedAt: { $gte: weekStart } });
    const thisMonth = await AsinDirectory.countDocuments({ addedAt: { $gte: monthStart } });

    res.json({
      total,
      unassigned,
      assigned: total - unassigned,
      recentlyAdded: {
        today,
        thisWeek,
        thisMonth
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Bulk add ASINs manually
router.post('/bulk-manual', requireAuth, async (req, res) => {
  try {
    const { asins, region = 'US' } = req.body;

    if (!asins || !Array.isArray(asins)) {
      return res.status(400).json({ error: 'ASINs array is required' });
    }

    const results = {
      added: 0,
      duplicates: 0,
      errors: []
    };

    // Validate ASINs
    const validAsins = [];
    const asinRegex = /^B[0-9A-Z]{9}$/;

    for (const asin of asins) {
      const cleanAsin = asin.trim().toUpperCase();
      
      if (!asinRegex.test(cleanAsin)) {
        results.errors.push({ asin, reason: 'Invalid ASIN format' });
        continue;
      }

      validAsins.push(cleanAsin);
    }

    // Scrape all valid ASINs in parallel batches
    console.log(`🔍 Scraping ${validAsins.length} ASINs for directory enrichment (${region})...`);
    const enrichmentMap = await scrapeAsinsBatched(validAsins, region);

    // Insert ASINs with enrichment data
    for (const asin of validAsins) {
      try {
        const enrichment = enrichmentMap.get(asin);
        const doc = { asin };

        if (enrichment?.ok) {
          const d = enrichment.data;
          doc.title = d.title || '';
          doc.brand = d.brand || '';
          doc.price = d.price ? String(d.price) : '';
          doc.images = Array.isArray(d.images) ? d.images : [];
          doc.description = d.description || '';
          doc.color = d.color || '';
          doc.compatibility = d.compatibility || '';
          doc.model = d.model || '';
          doc.material = d.material || '';
          doc.specialFeatures = d.specialFeatures || '';
          doc.size = d.size || '';
          doc.scraped = true;
          doc.scrapedAt = new Date();
          doc.scrapeError = null;
        } else {
          doc.scraped = false;
          doc.scrapeError = enrichment?.error || 'Scrape failed';
        }
        doc.region = region;

        await AsinDirectory.create(doc);
        results.added++;
      } catch (error) {
        if (error.code === 11000) {
          // Duplicate key error
          results.duplicates++;
        } else {
          results.errors.push({ asin, reason: error.message });
        }
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Error bulk adding ASINs:', error);
    res.status(500).json({ error: 'Failed to add ASINs' });
  }
});

// Bulk add from CSV
router.post('/bulk-csv', requireAuth, async (req, res) => {
  try {
    const { csvData, region = 'US' } = req.body;

    if (!csvData) {
      return res.status(400).json({ error: 'CSV data is required' });
    }

    const results = {
      added: 0,
      duplicates: 0,
      errors: []
    };

    const asins = [];
    const asinRegex = /^B[0-9A-Z]{9}$/;

    // Parse CSV data manually
    const lines = csvData.trim().split('\n');
    
    if (lines.length === 0) {
      return res.json(results);
    }

    // Parse header to find ASIN column
    const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    let asinColumnIndex = header.findIndex(h => h.toUpperCase() === 'ASIN');
    
    // If no ASIN column found, assume first column
    if (asinColumnIndex === -1) {
      asinColumnIndex = 0;
    }

    // Parse data rows (skip header)
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',').map(cell => cell.trim().replace(/"/g, ''));
      const asinValue = row[asinColumnIndex];

      if (!asinValue || !asinValue.trim()) {
        continue; // Skip empty rows
      }

      const cleanAsin = asinValue.trim().toUpperCase();

      if (!asinRegex.test(cleanAsin)) {
        results.errors.push({ row: i + 1, asin: asinValue, reason: 'Invalid ASIN format' });
        continue;
      }

      asins.push({ asin: cleanAsin, row: i + 1 });
    }

    // Scrape all valid ASINs in parallel batches
    const asinStrings = asins.map(a => a.asin);
    console.log(`🔍 Scraping ${asinStrings.length} ASINs for directory enrichment (${region})...`);
    const enrichmentMap = await scrapeAsinsBatched(asinStrings, region);

    // Insert ASINs with enrichment data
    for (const { asin, row } of asins) {
      try {
        const enrichment = enrichmentMap.get(asin);
        const doc = { asin };

        if (enrichment?.ok) {
          const d = enrichment.data;
          doc.title = d.title || '';
          doc.brand = d.brand || '';
          doc.price = d.price ? String(d.price) : '';
          doc.images = Array.isArray(d.images) ? d.images : [];
          doc.description = d.description || '';
          doc.color = d.color || '';
          doc.compatibility = d.compatibility || '';
          doc.model = d.model || '';
          doc.material = d.material || '';
          doc.specialFeatures = d.specialFeatures || '';
          doc.size = d.size || '';
          doc.scraped = true;
          doc.scrapedAt = new Date();
          doc.scrapeError = null;
        } else {
          doc.scraped = false;
          doc.scrapeError = enrichment?.error || 'Scrape failed';
        }
        doc.region = region;

        await AsinDirectory.create(doc);
        results.added++;
      } catch (error) {
        if (error.code === 11000) {
          results.duplicates++;
        } else {
          results.errors.push({ row, asin, reason: error.message });
        }
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Error importing CSV:', error);
    res.status(500).json({ error: 'Failed to import CSV' });
  }
});

// Export ASINs to CSV
router.get('/export-csv', requireAuth, async (req, res) => {
  try {
    const search = req.query.search || '';

    let query = {};
    if (search) {
      query.asin = { $regex: search.toUpperCase(), $options: 'i' };
    }

    const asins = await AsinDirectory.find(query).sort({ asin: 1 }).lean();

    // Generate CSV
    let csv = 'ASIN\n';
    asins.forEach(item => {
      csv += `${item.asin}\n`;
    });

    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=asin-directory-${date}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting CSV:', error);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// Manually update price and/or description for a single ASIN
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { price, description } = req.body;

    if (price === undefined && description === undefined) {
      return res.status(400).json({ error: 'At least one of price or description must be provided' });
    }

    const update = { manuallyEdited: true, manuallyEditedAt: new Date() };
    if (price !== undefined) update.price = String(price).trim();
    if (description !== undefined) update.description = String(description).trim();

    const doc = await AsinDirectory.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: false }
    );

    if (!doc) {
      return res.status(404).json({ error: 'ASIN not found' });
    }

    console.log(`✏️ [ASIN Directory] Manually edited ${doc.asin} (price: ${update.price ?? '—'}, description: ${description !== undefined ? 'updated' : '—'})`);
    res.json(doc);
  } catch (error) {
    console.error('Error updating ASIN:', error);
    res.status(500).json({ error: 'Failed to update ASIN' });
  }
});

// Delete single ASIN
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await AsinDirectory.findByIdAndDelete(id);

    if (!result) {
      return res.status(404).json({ error: 'ASIN not found' });
    }

    res.json({ message: 'ASIN deleted successfully' });
  } catch (error) {
    console.error('Error deleting ASIN:', error);
    res.status(500).json({ error: 'Failed to delete ASIN' });
  }
});

// Bulk delete ASINs
router.post('/bulk-delete', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: 'IDs array is required' });
    }

    const result = await AsinDirectory.deleteMany({ _id: { $in: ids } });

    res.json({
      message: 'ASINs deleted successfully',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error bulk deleting ASINs:', error);
    res.status(500).json({ error: 'Failed to delete ASINs' });
  }
});

export default router;

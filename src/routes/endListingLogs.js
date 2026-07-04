import express from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import EndListingLog from '../models/EndListingLog.js';
import { validate } from '../utils/validate.js';
import { endListingStatsQuerySchema } from '../schemas/index.js';

const router = express.Router();
const PT_TIMEZONE = 'America/Los_Angeles';

function getPTDayBoundsUTC(dateStr) {
  function findMidnightUTC(ds) {
    const pdt = new Date(`${ds}T07:00:00.000Z`);
    const ptStr = new Intl.DateTimeFormat('en-CA', { timeZone: PT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(pdt);
    const ptHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: PT_TIMEZONE, hour: 'numeric', hour12: false, hourCycle: 'h23' }).format(pdt), 10);
    if (ptStr === ds && ptHour === 0) return pdt;
    return new Date(`${ds}T08:00:00.000Z`);
  }

  const start = findMidnightUTC(dateStr);
  const tmp = new Date(`${dateStr}T12:00:00.000Z`);
  tmp.setUTCDate(tmp.getUTCDate() + 1);
  const nextDateStr = tmp.toISOString().split('T')[0];
  const end = new Date(findMidnightUTC(nextDateStr).getTime() - 1);
  return { start, end };
}

/**
 * GET /end-listing-logs/stats
 * Returns per-seller end-listing counts grouped by source (duplicate_sku / expiry_listing)
 * and country,
 * optionally filtered by sellerId and date range.
 *
 * Query params:
 *   sellerId   - optional, filter to one seller
 *   startDate  - optional, YYYY-MM-DD (Pacific time)
 *   endDate    - optional, YYYY-MM-DD (Pacific time)
 */
router.get('/stats', requireAuth, validate(endListingStatsQuerySchema, 'query'), async (req, res) => {
  try {
    const { sellerId, startDate, endDate } = req.query;

    // This page reports only the duplicate-SKU / expiry sources; ends logged
    // from the stock-check verify flow are excluded so totals stay consistent.
    const matchCriteria = { source: { $in: ['duplicate_sku', 'expiry_listing'] } };

    if (sellerId) {
      if (!mongoose.Types.ObjectId.isValid(sellerId)) {
        return res.status(400).json({ error: 'Invalid sellerId' });
      }
      matchCriteria.seller = new mongoose.Types.ObjectId(sellerId);
    }

    if (startDate || endDate) {
      matchCriteria.endedAt = {};
      if (startDate) {
        matchCriteria.endedAt.$gte = getPTDayBoundsUTC(startDate).start;
      }
      if (endDate) {
        matchCriteria.endedAt.$lte = getPTDayBoundsUTC(endDate).end;
      }
    }

    const rows = await EndListingLog.aggregate([
      { $match: matchCriteria },
      {
        $group: {
          _id: {
            seller: '$seller',
            source: '$source',
            country: { $ifNull: ['$country', 'Unknown'] },
          },
          count: { $sum: 1 },
        },
      },
      // Pivot sources into separate fields per seller
      {
        $group: {
          _id: '$_id.seller',
          sources: {
            $push: { source: '$_id.source', country: '$_id.country', count: '$count' },
          },
        },
      },
      {
        $lookup: {
          from: 'sellers',
          localField: '_id',
          foreignField: '_id',
          as: 'sellerInfo',
        },
      },
      { $unwind: { path: '$sellerInfo', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'users',
          localField: 'sellerInfo.user',
          foreignField: '_id',
          as: 'userInfo',
        },
      },
      { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          sellerId: '$_id',
          sellerName: '$userInfo.username',
          sources: 1,
        },
      },
      { $sort: { sellerName: 1 } },
    ]);

    // Flatten sources array into named fields
    const result = rows.map(row => {
      const duplicateSkuCount = row.sources
        .filter(s => s.source === 'duplicate_sku')
        .reduce((sum, s) => sum + (s.count || 0), 0);
      const expiryListingCount = row.sources
        .filter(s => s.source === 'expiry_listing')
        .reduce((sum, s) => sum + (s.count || 0), 0);
      const countryMap = new Map();

      for (const sourceRow of row.sources) {
        const country = sourceRow.country || 'Unknown';
        const existing = countryMap.get(country) || {
          country,
          duplicateSkuCount: 0,
          expiryListingCount: 0,
          total: 0,
        };
        if (sourceRow.source === 'duplicate_sku') {
          existing.duplicateSkuCount += sourceRow.count || 0;
        } else if (sourceRow.source === 'expiry_listing') {
          existing.expiryListingCount += sourceRow.count || 0;
        }
        existing.total += sourceRow.count || 0;
        countryMap.set(country, existing);
      }

      return {
        sellerId: row.sellerId,
        sellerName: row.sellerName || 'Unknown',
        duplicateSkuCount,
        expiryListingCount,
        total: duplicateSkuCount + expiryListingCount,
        countryBreakdown: Array.from(countryMap.values())
          .sort((a, b) => b.total - a.total || a.country.localeCompare(b.country)),
      };
    });

    res.json(result);
  } catch (error) {
    console.error('[EndListingLogs] Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch end-listing stats' });
  }
});

export default router;

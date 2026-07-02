import express from 'express';
import Listing from '../models/Listing.js';
import Seller from '../models/Seller.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { listingStatsDayWiseQuerySchema, listingStatsSummaryQuerySchema } from '../schemas/index.js';

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
 * @swagger
 * /listing-stats/day-wise-counts:
 *   get:
 *     summary: Get day-wise listing counts per seller
 *     description: Returns the count of listings per seller per day based on startTime in PST timezone
 *     tags: [Listing Stats]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date in PST (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: End date in PST (YYYY-MM-DD)
 *       - in: query
 *         name: sellerId
 *         schema:
 *           type: string
 *         description: Filter by specific seller ID
 *     responses:
 *       200:
 *         description: Day-wise listing counts
 *       500:
 *         description: Server error
 */
router.get('/day-wise-counts', requireAuth, validate(listingStatsDayWiseQuerySchema, 'query'), async (req, res) => {
  try {
    const { startDate, endDate, sellerId } = req.query;

    // Build match criteria
    const matchCriteria = {};
    
    if (sellerId) {
      matchCriteria.seller = sellerId;
    }

    // Filter by date range if provided (using startTime in PST)
    if (startDate || endDate) {
      matchCriteria.startTime = {};
      if (startDate) {
        // Pacific midnight converted to UTC.
        matchCriteria.startTime.$gte = getPTDayBoundsUTC(startDate).start;
      }
      if (endDate) {
        // Pacific end of day converted to UTC.
        matchCriteria.startTime.$lte = getPTDayBoundsUTC(endDate).end;
      }
    }

    // Aggregate listings by seller and day
    const stats = await Listing.aggregate([
      { $match: matchCriteria },
      {
        $group: {
          _id: {
            seller: '$seller',
            date: {
              $dateToString: { 
                format: '%Y-%m-%d', 
                date: '$startTime',
                timezone: PT_TIMEZONE
              }
            }
          },
          count: { $sum: 1 },
          emptyCompatibilityCount: {
            $sum: {
              $cond: [
                { $or: [
                  { $eq: [{ $size: { $ifNull: ['$compatibility', []] } }, 0] },
                  { $eq: ['$compatibility', null] }
                ]},
                1,
                0
              ]
            }
          }
        }
      },
      {
        $lookup: {
          from: 'sellers',
          localField: '_id.seller',
          foreignField: '_id',
          as: 'sellerInfo'
        }
      },
      {
        $unwind: {
          path: '$sellerInfo',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'sellerInfo.user',
          foreignField: '_id',
          as: 'userInfo'
        }
      },
      {
        $unwind: {
          path: '$userInfo',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          _id: 0,
          sellerId: '$_id.seller',
          sellerName: '$userInfo.username',
          date: '$_id.date',
          count: 1,
          emptyCompatibilityCount: 1
        }
      },
      {
        $sort: { date: -1, sellerName: 1 }
      }
    ]);

    res.json(stats);
  } catch (error) {
    console.error('Error fetching day-wise listing counts:', error);
    res.status(500).json({ error: 'Failed to fetch listing statistics' });
  }
});

/**
 * @swagger
 * /listing-stats/summary:
 *   get:
 *     summary: Get summary statistics for listings
 *     description: Returns overall summary of listing counts per seller based on startTime in PST timezone
 *     tags: [Listing Stats]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date in PST (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: End date in PST (YYYY-MM-DD)
 *     responses:
 *       200:
 *         description: Summary statistics
 *       500:
 *         description: Server error
 */
router.get('/summary', requireAuth, validate(listingStatsSummaryQuerySchema, 'query'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const matchCriteria = {};

    if (startDate || endDate) {
      matchCriteria.startTime = {};
      if (startDate) {
        // Convert Pacific date to UTC for query.
        matchCriteria.startTime.$gte = getPTDayBoundsUTC(startDate).start;
      }
      if (endDate) {
        matchCriteria.startTime.$lte = getPTDayBoundsUTC(endDate).end;
      }
    }

    const summary = await Listing.aggregate([
      { $match: matchCriteria },
      {
        $group: {
          _id: '$seller',
          totalListings: { $sum: 1 },
          activeListings: {
            $sum: { $cond: [{ $eq: ['$listingStatus', 'Active'] }, 1, 0] }
          }
        }
      },
      {
        $lookup: {
          from: 'sellers',
          localField: '_id',
          foreignField: '_id',
          as: 'sellerInfo'
        }
      },
      {
        $unwind: {
          path: '$sellerInfo',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'sellerInfo.user',
          foreignField: '_id',
          as: 'userInfo'
        }
      },
      {
        $unwind: {
          path: '$userInfo',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          _id: 0,
          sellerId: '$_id',
          sellerName: '$userInfo.username',
          totalListings: 1,
          activeListings: 1
        }
      },
      {
        $sort: { totalListings: -1 }
      }
    ]);

    res.json(summary);
  } catch (error) {
    console.error('Error fetching listing summary:', error);
    res.status(500).json({ error: 'Failed to fetch listing summary' });
  }
});

export default router;

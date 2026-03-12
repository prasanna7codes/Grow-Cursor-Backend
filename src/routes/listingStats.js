import express from 'express';
import Listing from '../models/Listing.js';
import Seller from '../models/Seller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * /api/listing-stats/day-wise-counts:
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
router.get('/day-wise-counts', requireAuth, async (req, res) => {
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
        // Convert PST date to UTC for query
        // Create date in PST by using a date string that will be interpreted correctly
        const pstDate = new Date(startDate + 'T00:00:00.000Z');
        // Adjust for PST offset (we need to shift the UTC date to represent PST midnight)
        // Since PST is UTC-8, midnight PST is 8am UTC the same day
        pstDate.setUTCHours(8, 0, 0, 0);
        matchCriteria.startTime.$gte = pstDate;
      }
      if (endDate) {
        // Add one day to include the entire end date, convert PST to UTC
        const pstDate = new Date(endDate + 'T23:59:59.999Z');
        // Adjust for PST offset - end of day PST is 7:59:59.999 UTC next day
        pstDate.setUTCHours(7, 59, 59, 999);
        pstDate.setUTCDate(pstDate.getUTCDate() + 1);
        matchCriteria.startTime.$lte = pstDate;
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
                timezone: 'America/Los_Angeles'
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
 * /api/listing-stats/summary:
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
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const matchCriteria = {};

    if (startDate || endDate) {
      matchCriteria.startTime = {};
      if (startDate) {
        // Convert PST date to UTC for query
        const startDateUTC = new Date(startDate + 'T00:00:00-08:00');
        matchCriteria.startTime.$gte = startDateUTC;
      }
      if (endDate) {
        // Add one day to include the entire end date, convert PST to UTC
        const endDateUTC = new Date(endDate + 'T23:59:59-08:00');
        matchCriteria.startTime.$lte = endDateUTC;
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

import express from 'express';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import PriceChangeLog from '../models/PriceChangeLog.js';
import Order from '../models/Order.js';

const router = express.Router();

function buildPriceChangeLogQuery(queryParams, options = {}) {
  const {
    legacyItemId,
    orderId,
    userId,
    sellerId,
    startDate,
    endDate,
    successOnly,
    failedOnly
  } = queryParams;

  const query = {};

  if (options.onlyAllOrdersSheet) {
    query.changeSource = 'all_orders_sheet';
  }

  if (options.forceSuccess === true) {
    query.success = true;
  } else {
    if (successOnly === 'true') query.success = true;
    if (failedOnly === 'true') query.success = false;
  }

  if (legacyItemId) query.legacyItemId = String(legacyItemId).trim();
  if (orderId) query.orderId = String(orderId).trim();
  if (userId) query.user = userId;
  if (sellerId) query.seller = sellerId;

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  return query;
}

function buildOrderCheckPipeline(queryParams) {
  const query = buildPriceChangeLogQuery(queryParams, {
    onlyAllOrdersSheet: true,
    forceSuccess: true
  });

  const pipeline = [
    { $match: query },
    {
      $lookup: {
        from: Order.collection.name,
        let: {
          changedItemId: '$legacyItemId',
          changedAt: '$createdAt',
          changedSellerId: '$seller'
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$seller', '$$changedSellerId'] },
                  {
                    $or: [
                      { $eq: ['$itemNumber', '$$changedItemId'] },
                      {
                        $in: [
                          '$$changedItemId',
                          { $ifNull: ['$lineItems.legacyItemId', []] }
                        ]
                      }
                    ]
                  },
                  {
                    $gt: [
                      {
                        $ifNull: [
                          '$creationDate',
                          { $ifNull: ['$dateSold', '$createdAt'] }
                        ]
                      },
                      '$$changedAt'
                    ]
                  }
                ]
              }
            }
          },
          {
            $project: {
              _id: 1,
              orderId: 1,
              productName: 1,
              itemNumber: 1,
              orderDate: {
                $ifNull: ['$creationDate', { $ifNull: ['$dateSold', '$createdAt'] }]
              }
            }
          },
          { $sort: { orderDate: 1 } }
        ],
        as: 'matchedOrders'
      }
    },
    {
      $addFields: {
        matchedOrderCount: { $size: '$matchedOrders' },
        firstMatchedOrder: { $arrayElemAt: ['$matchedOrders', 0] },
        latestMatchedOrder: { $arrayElemAt: ['$matchedOrders', -1] },
        matchedOrdersPreview: { $slice: ['$matchedOrders', 5] }
      }
    }
  ];

  if (queryParams.matchedOnly === 'true') {
    pipeline.push({ $match: { matchedOrderCount: { $gt: 0 } } });
  } else if (queryParams.unmatchedOnly === 'true') {
    pipeline.push({ $match: { matchedOrderCount: 0 } });
  }

  return pipeline;
}

// GET /api/price-change-logs — Get price change history with filters
router.get('/', requireAuth, requirePageAccess('PriceChangeHistory'), async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const query = buildPriceChangeLogQuery(req.query);
    const numericPage = parseInt(page, 10);
    const numericLimit = parseInt(limit, 10);
    const skip = (numericPage - 1) * numericLimit;

    const [logs, total] = await Promise.all([
      PriceChangeLog.find(query)
        .populate('user', 'username email')
        .populate('seller', 'user')
        .populate({
          path: 'seller',
          populate: { path: 'user', select: 'username' }
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(numericLimit)
        .lean(),
      PriceChangeLog.countDocuments(query)
    ]);

    res.json({
      logs,
      pagination: {
        total,
        page: numericPage,
        limit: numericLimit,
        totalPages: Math.ceil(total / numericLimit)
      }
    });
  } catch (err) {
    console.error('[Price Change Logs] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/price-change-logs/order-checks — successful price changes followed by later orders for the same item
router.get('/order-checks', requireAuth, requirePageAccess('PriceChangeOrderCheck'), async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const numericPage = parseInt(page, 10);
    const numericLimit = parseInt(limit, 10);
    const skip = (numericPage - 1) * numericLimit;

    const reportPipeline = buildOrderCheckPipeline(req.query);

    const [rows, countResult] = await Promise.all([
      PriceChangeLog.aggregate([
        ...reportPipeline,
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: numericLimit },
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            as: 'userData'
          }
        },
        {
          $lookup: {
            from: 'sellers',
            localField: 'seller',
            foreignField: '_id',
            as: 'sellerData'
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: 'sellerData.user',
            foreignField: '_id',
            as: 'sellerUsers'
          }
        },
        {
          $addFields: {
            user: {
              _id: { $arrayElemAt: ['$userData._id', 0] },
              username: { $arrayElemAt: ['$userData.username', 0] },
              email: { $arrayElemAt: ['$userData.email', 0] }
            },
            seller: {
              _id: { $arrayElemAt: ['$sellerData._id', 0] },
              user: {
                _id: { $arrayElemAt: ['$sellerUsers._id', 0] },
                username: { $arrayElemAt: ['$sellerUsers.username', 0] }
              }
            }
          }
        },
        {
          $project: {
            userData: 0,
            sellerData: 0,
            sellerUsers: 0,
            matchedOrders: 0,
            __v: 0
          }
        }
      ]),
      PriceChangeLog.aggregate([
        ...reportPipeline,
        { $count: 'total' }
      ])
    ]);

    const total = countResult[0]?.total || 0;

    res.json({
      rows,
      pagination: {
        total,
        page: numericPage,
        limit: numericLimit,
        totalPages: Math.ceil(total / numericLimit)
      }
    });
  } catch (err) {
    console.error('[Price Change Order Checks] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

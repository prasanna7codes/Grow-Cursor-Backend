import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Order from '../models/Order.js';
import Seller from '../models/Seller.js';
import Return from '../models/Return.js';
import Case from '../models/Case.js';
import PaymentDispute from '../models/PaymentDispute.js';
import Message from '../models/Message.js';
import MarketMetric from '../models/MarketMetric.js';

const router = Router();

const PT_TIMEZONE = 'America/Los_Angeles';
const SNAD_RETURN_REASONS = [
  'NOT_AS_DESCRIBED',
  'DEFECTIVE_ITEM',
  'WRONG_ITEM',
  'MISSING_PARTS',
  'ARRIVED_DAMAGED',
  'DOESNT_MATCH',
  'NOT_AUTHENTIC',
  'DOES_NOT_FIT'
];

function getPtDateString(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

function getPtDayRange(dateStr) {
  const PST_OFFSET_HOURS = 8;
  const start = new Date(dateStr);
  start.setUTCHours(PST_OFFSET_HOURS, 0, 0, 0);

  const end = new Date(dateStr);
  end.setDate(end.getDate() + 1);
  end.setUTCHours(PST_OFFSET_HOURS - 1, 59, 59, 999);
  return { start, end };
}

function getMonthUtcRange(monthStr) {
  const [yearText, monthText] = String(monthStr).split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
  return { start, end };
}

function getPreviousMonth(monthStr) {
  const [yearText, monthText] = String(monthStr).split('-');
  const d = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function getCurrentAccountHealthWindow() {
  const now = new Date();
  const currentWindowEnd = new Date(now);
  const dayOfWeek = currentWindowEnd.getDay();
  if (dayOfWeek !== 0) {
    currentWindowEnd.setDate(currentWindowEnd.getDate() - dayOfWeek);
  }
  currentWindowEnd.setHours(23, 59, 59, 999);

  const calculationEnd = new Date(currentWindowEnd);
  calculationEnd.setDate(calculationEnd.getDate() - 1);
  calculationEnd.setHours(23, 59, 59, 999);

  const windowStart = new Date(calculationEnd);
  windowStart.setDate(windowStart.getDate() - 83);
  windowStart.setHours(0, 0, 0, 0);

  return { windowStart, calculationEnd };
}

async function getCurrentNonCompliantSellerSet(optionalSellerId) {
  const { windowStart, calculationEnd } = getCurrentAccountHealthWindow();
  const sellerMatch = optionalSellerId ? { seller: new mongoose.Types.ObjectId(optionalSellerId) } : {};

  const [latestMarketMetric, salesBySeller, snadCasesBySeller, snadReturnsBySeller] = await Promise.all([
    MarketMetric.findOne({
      type: 'bbe_market_avg',
      $or: [{ seller: { $exists: false } }, { seller: null }]
    }).sort({ effectiveDate: -1 }).lean(),
    Order.aggregate([
      { $match: { ...sellerMatch, dateSold: { $gte: windowStart, $lte: calculationEnd } } },
      { $group: { _id: '$seller', totalSales: { $sum: 1 } } }
    ]),
    Case.aggregate([
      { $match: { ...sellerMatch, caseType: 'SNAD', creationDate: { $gte: windowStart, $lte: calculationEnd } } },
      { $group: { _id: '$seller', snadCases: { $sum: 1 } } }
    ]),
    Return.aggregate([
      {
        $match: {
          ...sellerMatch,
          returnReason: { $in: SNAD_RETURN_REASONS },
          creationDate: { $gte: windowStart, $lte: calculationEnd }
        }
      },
      { $group: { _id: '$seller', snadReturns: { $sum: 1 } } }
    ])
  ]);

  const marketAvg = Number(latestMarketMetric?.value) || 1.1;
  const map = new Map();

  salesBySeller.forEach((row) => {
    map.set(String(row._id), {
      sellerId: String(row._id),
      totalSales: row.totalSales || 0,
      snadCount: 0
    });
  });
  snadCasesBySeller.forEach((row) => {
    const key = String(row._id);
    const current = map.get(key) || { sellerId: key, totalSales: 0, snadCount: 0 };
    current.snadCount += row.snadCases || 0;
    map.set(key, current);
  });
  snadReturnsBySeller.forEach((row) => {
    const key = String(row._id);
    const current = map.get(key) || { sellerId: key, totalSales: 0, snadCount: 0 };
    current.snadCount += row.snadReturns || 0;
    map.set(key, current);
  });

  const nonCompliant = new Map();
  for (const entry of map.values()) {
    const bbeRate = entry.totalSales > 0 ? (entry.snadCount / entry.totalSales) * 100 : 0;
    if (bbeRate > marketAvg) {
      nonCompliant.set(entry.sellerId, {
        ...entry,
        bbeRate: Number(bbeRate.toFixed(2)),
        marketAvg: Number(marketAvg.toFixed(2))
      });
    }
  }

  return nonCompliant;
}

router.get('/dashboard/monthly-delta', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const month = req.query.month || getPtDateString(new Date()).slice(0, 7);
    const previousMonth = getPreviousMonth(month);
    const { sellerId } = req.query;

    const currentRange = getMonthUtcRange(month);
    const previousRange = getMonthUtcRange(previousMonth);

    const sellerMatch = sellerId ? { seller: new mongoose.Types.ObjectId(sellerId) } : {};
    const baseMatch = req.query.excludeLowValue === 'true'
      ? {
          ...sellerMatch,
          $or: [{ subtotalUSD: { $gte: 3 } }, { subtotal: { $gte: 3 } }]
        }
      : sellerMatch;

    const [currentRows, previousRows, sellers] = await Promise.all([
      Order.aggregate([
        {
          $match: {
            ...baseMatch,
            dateSold: { $gte: currentRange.start, $lte: currentRange.end }
          }
        },
        { $group: { _id: '$seller', count: { $sum: 1 } } }
      ]),
      Order.aggregate([
        {
          $match: {
            ...baseMatch,
            dateSold: { $gte: previousRange.start, $lte: previousRange.end }
          }
        },
        { $group: { _id: '$seller', count: { $sum: 1 } } }
      ]),
      Seller.find(sellerId ? { _id: new mongoose.Types.ObjectId(sellerId) } : {})
        .populate('user', 'username email')
        .lean()
    ]);

    const sellerNameMap = new Map(
      sellers.map((s) => [String(s._id), s.user?.username || s.user?.email || 'Unknown'])
    );
    const currentMap = new Map(currentRows.map((r) => [String(r._id), r.count || 0]));
    const previousMap = new Map(previousRows.map((r) => [String(r._id), r.count || 0]));
    const sellerIds = new Set([...currentMap.keys(), ...previousMap.keys()]);

    const rows = Array.from(sellerIds).map((id) => {
      const currentMonthOrders = currentMap.get(id) || 0;
      const previousMonthOrders = previousMap.get(id) || 0;
      const delta = currentMonthOrders - previousMonthOrders;
      const deltaPct = previousMonthOrders > 0 ? (delta / previousMonthOrders) * 100 : (currentMonthOrders > 0 ? 100 : 0);
      return {
        sellerId: id,
        sellerName: sellerNameMap.get(id) || 'Unknown',
        currentMonthOrders,
        previousMonthOrders,
        delta,
        deltaPct: Number(deltaPct.toFixed(2))
      };
    }).sort((a, b) => b.currentMonthOrders - a.currentMonthOrders);

    return res.json({ month, previousMonth, rows });
  } catch (error) {
    console.error('Error fetching monthly delta dashboard data:', error);
    return res.status(500).json({ error: 'Failed to fetch monthly delta data' });
  }
});

router.get('/dashboard/overview', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const date = req.query.date || getPtDateString(new Date());
    const { sellerId } = req.query;
    const { start, end } = getPtDayRange(date);
    const sellerMatch = sellerId ? { seller: new mongoose.Types.ObjectId(sellerId) } : {};
    const lowValueClause = req.query.excludeLowValue === 'true'
      ? { $or: [{ subtotalUSD: { $gte: 3 } }, { subtotal: { $gte: 3 } }] }
      : {};
    const maybeAnd = (...parts) => {
      const active = parts.filter((p) => p && Object.keys(p).length > 0);
      if (active.length === 0) return {};
      if (active.length === 1) return active[0];
      return { $and: active };
    };

    const todayOrdersMatch = maybeAnd(
      sellerMatch,
      { dateSold: { $gte: start, $lte: end } },
      lowValueClause
    );

    const awaitingMatch = maybeAnd(
      sellerMatch,
      {
        shipByDate: { $gte: start, $lte: end },
        cancelState: { $in: ['NONE_REQUESTED', 'IN_PROGRESS', null, ''] }
      },
      { $or: [{ trackingNumber: { $exists: false } }, { trackingNumber: null }, { trackingNumber: '' }] },
      lowValueClause
    );

    const arrivalsMatch = maybeAnd(
      sellerMatch,
      { arrivingDate: date },
      lowValueClause
    );

    const [todayOrdersCount, awaitingCount, arrivalsCount, unreadMessagesCount, todayOrdersTable, topSellersRaw, awaitingBySellerRaw, arrivalsBySellerRaw, unreadBySellerRaw, nonCompliantSet] = await Promise.all([
      Order.countDocuments(todayOrdersMatch),
      Order.countDocuments(awaitingMatch),
      Order.countDocuments(arrivalsMatch),
      Message.countDocuments({
        ...sellerMatch,
        sender: 'BUYER',
        read: false,
        messageDate: { $gte: start, $lte: end }
      }),
      Order.find(todayOrdersMatch)
        .populate({ path: 'seller', populate: { path: 'user', select: 'username email' } })
        .sort({ dateSold: -1 })
        .limit(25)
        .lean(),
      Order.aggregate([
        { $match: todayOrdersMatch },
        { $group: { _id: '$seller', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      Order.aggregate([
        { $match: awaitingMatch },
        { $group: { _id: '$seller', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Order.aggregate([
        { $match: arrivalsMatch },
        { $group: { _id: '$seller', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Message.aggregate([
        {
          $match: {
            ...sellerMatch,
            sender: 'BUYER',
            read: false,
            messageDate: { $gte: start, $lte: end }
          }
        },
        { $group: { _id: '$seller', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      getCurrentNonCompliantSellerSet(sellerId)
    ]);

    const allSellerIds = new Set([
      ...topSellersRaw.map((r) => String(r._id)),
      ...awaitingBySellerRaw.map((r) => String(r._id)),
      ...arrivalsBySellerRaw.map((r) => String(r._id)),
      ...unreadBySellerRaw.map((r) => String(r._id)),
      ...Array.from(nonCompliantSet.keys())
    ]);

    const sellerDocs = await Seller.find({ _id: { $in: Array.from(allSellerIds).map((id) => new mongoose.Types.ObjectId(id)) } })
      .populate('user', 'username email')
      .lean();
    const sellerNameMap = new Map(
      sellerDocs.map((s) => [String(s._id), s.user?.username || s.user?.email || 'Unknown'])
    );

    const toSellerRows = (rows) =>
      rows.map((row) => ({
        sellerId: String(row._id),
        sellerName: sellerNameMap.get(String(row._id)) || 'Unknown',
        count: row.count || 0
      }));

    const nonCompliantSellerList = Array.from(nonCompliantSet.values()).map((row) => ({
      sellerId: row.sellerId,
      sellerName: sellerNameMap.get(row.sellerId) || 'Unknown',
      bbeRate: row.bbeRate,
      marketAvg: row.marketAvg
    })).sort((a, b) => b.bbeRate - a.bbeRate);

    const awaitingRows = toSellerRows(awaitingBySellerRaw);
    const unreadRows = toSellerRows(unreadBySellerRaw);
    const topBlockerMap = new Map();
    awaitingRows.forEach((r) => {
      topBlockerMap.set(r.sellerId, { sellerId: r.sellerId, sellerName: r.sellerName, awaiting: r.count, unread: 0 });
    });
    unreadRows.forEach((r) => {
      const current = topBlockerMap.get(r.sellerId) || { sellerId: r.sellerId, sellerName: r.sellerName, awaiting: 0, unread: 0 };
      current.unread = r.count;
      topBlockerMap.set(r.sellerId, current);
    });
    const topBlockers = Array.from(topBlockerMap.values())
      .sort((a, b) => (b.awaiting + b.unread) - (a.awaiting + a.unread))
      .slice(0, 5);

    const month = date.slice(0, 7);
    const previousMonth = getPreviousMonth(month);
    const currentRange = getMonthUtcRange(month);
    const previousRange = getMonthUtcRange(previousMonth);
    const [currentMonthCount, previousMonthCount] = await Promise.all([
      Order.countDocuments(maybeAnd(sellerMatch, { dateSold: { $gte: currentRange.start, $lte: currentRange.end } }, lowValueClause)),
      Order.countDocuments(maybeAnd(sellerMatch, { dateSold: { $gte: previousRange.start, $lte: previousRange.end } }, lowValueClause))
    ]);

    res.json({
      date,
      timezone: PT_TIMEZONE,
      kpis: {
        todayOrders: todayOrdersCount,
        monthlyDeltaNet: currentMonthCount - previousMonthCount,
        awaitingToday: awaitingCount,
        arrivalsToday: arrivalsCount,
        unreadBuyerMessagesToday: unreadMessagesCount,
        nonCompliantAccounts: nonCompliantSet.size
      },
      topSellers: toSellerRows(topSellersRaw),
      todayOrdersTable: todayOrdersTable.map((o) => ({
        id: o._id,
        sellerId: o.seller?._id ? String(o.seller._id) : String(o.seller),
        sellerName: o.seller?.user?.username || o.seller?.user?.email || 'Unknown',
        orderId: o.orderId,
        dateSold: o.dateSold,
        purchaseMarketplaceId: o.purchaseMarketplaceId,
        shipByDate: o.shipByDate,
        trackingNumber: o.trackingNumber || o.manualTrackingNumber || ''
      })),
      riskQueues: {
        nonCompliantSellerList,
        unreadBySeller: toSellerRows(unreadBySellerRaw),
        awaitingBySeller: awaitingRows,
        arrivalsBySeller: toSellerRows(arrivalsBySellerRaw),
        topBlockers
      },
      quickLinksMeta: {
        fulfillment: '/admin/fulfillment',
        awaitingSheet: `/admin/awaiting-sheet?date=${date}`,
        amazonArrivals: `/admin/amazon-arrivals?arrivalDateFrom=${date}&arrivalDateTo=${date}`,
        accountHealth: '/admin/account-health',
        buyerMessages: '/admin/message-received'
      }
    });
  } catch (error) {
    console.error('Error fetching orders dashboard overview:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard overview' });
  }
});

// Get daily order statistics for all sellers
router.get('/daily-statistics', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { startDate, endDate, sellerId } = req.query;

    // Build the query - NO CANCELSTATE FILTER (matches FulfillmentDashboard)
    const query = {};

    // Add date filter if provided
    // Use the SAME timezone logic as FulfillmentDashboard (PST - UTC-8)
    if (startDate || endDate) {
      query.dateSold = {}; // Use dateSold field, not creationDate
      const PST_OFFSET_HOURS = 8;

      if (startDate) {
        const start = new Date(startDate);
        start.setUTCHours(PST_OFFSET_HOURS, 0, 0, 0);
        query.dateSold.$gte = start;
      }

      if (endDate) {
        const end = new Date(endDate);
        end.setDate(end.getDate() + 1);
        end.setUTCHours(PST_OFFSET_HOURS - 1, 59, 59, 999);
        query.dateSold.$lte = end;
      }
    }

    // Add seller filter if provided
    if (sellerId) {
      query.seller = sellerId;
    }

    // Filter out low value orders if requested (< $3)
    if (req.query.excludeLowValue === 'true') {
      query.subtotalUSD = { $gte: 3 };
    }

    // Aggregate orders by seller, date, and marketplace
    const statistics = await Order.aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'sellers',
          localField: 'seller',
          foreignField: '_id',
          as: 'sellerInfo'
        }
      },
      { $unwind: '$sellerInfo' },
      {
        $lookup: {
          from: 'users',
          localField: 'sellerInfo.user',
          foreignField: '_id',
          as: 'userInfo'
        }
      },
      { $unwind: '$userInfo' },
      {
        $project: {
          seller: '$seller',
          sellerUsername: '$userInfo.username',
          orderDate: {
            // Convert UTC date to PST date string (matching FulfillmentDashboard)
            $dateToString: { 
              format: '%Y-%m-%d', 
              date: '$dateSold', // Use dateSold field
              timezone: 'America/Los_Angeles' // PST/PDT timezone
            }
          },
          marketplace: { $ifNull: ['$purchaseMarketplaceId', 'Unknown'] }
        }
      },
      {
        $group: {
          _id: {
            seller: '$seller',
            sellerUsername: '$sellerUsername',
            date: '$orderDate',
            marketplace: '$marketplace'
          },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: {
            seller: '$_id.seller',
            sellerUsername: '$_id.sellerUsername',
            date: '$_id.date'
          },
          totalOrders: { $sum: '$count' },
          marketplaceBreakdown: {
            $push: {
              marketplace: '$_id.marketplace',
              count: '$count'
            }
          }
        }
      },
      {
        $sort: { '_id.date': -1, '_id.sellerUsername': 1 }
      }
    ]);

    // Transform the data for easier consumption on the frontend
    const formattedStatistics = statistics.map(stat => ({
      seller: {
        id: stat._id.seller,
        username: stat._id.sellerUsername
      },
      date: stat._id.date,
      totalOrders: stat.totalOrders,
      marketplaceBreakdown: stat.marketplaceBreakdown
    }));

    res.json(formattedStatistics);
  } catch (error) {
    console.error('Error fetching daily order statistics:', error);
    res.status(500).json({ error: 'Failed to fetch order statistics' });
  }
});

// Get worksheet statistics for cancellations, returns, INR/disputes, and inquiries
router.get('/worksheet-statistics', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { startDate, endDate, sellerId } = req.query;

    // Build seller filter if sellerId is provided
    const sellerMatch = sellerId ? { seller: new mongoose.Types.ObjectId(sellerId) } : {};

    // Use UTC boundaries for filtering (matches frontend local date selection)
    const buildDateRangeMatch = (field) => {
      if (!startDate && !endDate) return {};
      const range = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setUTCHours(0, 0, 0, 0); // Start of day in UTC
        range.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setUTCHours(23, 59, 59, 999); // End of day in UTC
        range.$lte = end;
      }
      return { [field]: range };
    };

    // Project date in UTC (for grouping - matches frontend selection)
    const utcDateProjection = (field) => ({
      $dateToString: {
        format: '%Y-%m-%d',
        date: field,
        timezone: 'UTC'
      }
    });

    // Project date in PST (for database reference)
    const pstDateProjection = (field) => ({
      $dateToString: {
        format: '%Y-%m-%d',
        date: field,
        timezone: 'America/Los_Angeles'
      }
    });

    const cancellationStates = ['CANCEL_REQUESTED', 'IN_PROGRESS', 'CANCELED', 'CANCELLED'];
    const cancellationPipeline = [
      { $addFields: { worksheetDate: { $ifNull: ['$dateSold', '$creationDate'] } } },
      {
        $match: {
          ...sellerMatch,
          cancelState: { $in: cancellationStates },
          ...buildDateRangeMatch('worksheetDate')
        }
      },
      {
        $project: {
          worksheetStatus: { $ifNull: ['$worksheetStatus', 'open'] },
          date: utcDateProjection('$worksheetDate'),
          pstDate: pstDateProjection('$worksheetDate')
        }
      },
      {
        $group: {
          _id: { date: '$date', status: '$worksheetStatus' },
          pstDate: { $first: '$pstDate' },
          count: { $sum: 1 }
        }
      }
    ];

    const returnsPipeline = [
      { $match: { ...sellerMatch, ...buildDateRangeMatch('creationDate') } },
      {
        $project: {
          worksheetStatus: { $ifNull: ['$worksheetStatus', 'open'] },
          date: utcDateProjection('$creationDate'),
          pstDate: pstDateProjection('$creationDate')
        }
      },
      {
        $group: {
          _id: { date: '$date', status: '$worksheetStatus' },
          pstDate: { $first: '$pstDate' },
          count: { $sum: 1 }
        }
      }
    ];

    const casesPipeline = [
      { $match: { ...sellerMatch, ...buildDateRangeMatch('creationDate') } },
      {
        $project: {
          status: '$status',
          date: utcDateProjection('$creationDate'),
          pstDate: pstDateProjection('$creationDate')
        }
      },
      {
        $group: {
          _id: { date: '$date', status: '$status' },
          pstDate: { $first: '$pstDate' },
          count: { $sum: 1 }
        }
      }
    ];

    const disputesPipeline = [
      { $addFields: { worksheetDate: { $ifNull: ['$openDate', '$createdAt'] } } },
      { $match: { ...sellerMatch, ...buildDateRangeMatch('worksheetDate') } },
      {
        $project: {
          status: '$paymentDisputeStatus',
          date: utcDateProjection('$worksheetDate'),
          pstDate: pstDateProjection('$worksheetDate')
        }
      },
      {
        $group: {
          _id: { date: '$date', status: '$status' },
          pstDate: { $first: '$pstDate' },
          count: { $sum: 1 }
        }
      }
    ];

    // Inquiries: count buyer inquiry messages per day
    // messageType != 'ORDER' AND no orderId (matches chat INQUIRY filter)
    const inquiriesPipeline = [
      {
        $match: {
          ...sellerMatch,
          sender: 'BUYER',
          messageType: { $ne: 'ORDER' },
          $or: [{ orderId: null }, { orderId: { $exists: false } }, { orderId: '' }],
          ...buildDateRangeMatch('messageDate')
        }
      },
      {
        $project: {
          date: utcDateProjection('$messageDate'),
          pstDate: pstDateProjection('$messageDate')
        }
      },
      {
        $group: {
          _id: { date: '$date' },
          pstDate: { $first: '$pstDate' },
          count: { $sum: 1 }
        }
      }
    ];

    const [
      cancellationStats,
      returnStats,
      caseStats,
      disputeStats,
      inquiryStats
    ] = await Promise.all([
      Order.aggregate(cancellationPipeline),
      Return.aggregate(returnsPipeline),
      Case.aggregate(casesPipeline),
      PaymentDispute.aggregate(disputesPipeline),
      Message.aggregate(inquiriesPipeline)
    ]);

    const dateMap = new Map();
    const pstDateMap = new Map(); // Track PST dates for each UTC date
    
    const ensureDate = (date, pstDate) => {
      if (!dateMap.has(date)) {
        dateMap.set(date, {
          date,
          pstDate: pstDate || date, // PST date for database reference
          cancellations: { open: 0, attended: 0, resolved: 0 },
          returns: { open: 0, attended: 0, resolved: 0 },
          inrDisputes: { open: 0, attended: 0, resolved: 0 },
          inquiries: { total: 0 }
        });
      } else if (pstDate && !dateMap.get(date).pstDate) {
        // Update PST date if we have one
        dateMap.get(date).pstDate = pstDate;
      }
      return dateMap.get(date);
    };

    const addCount = (date, pstDate, category, bucket, count) => {
      const entry = ensureDate(date, pstDate);
      entry[category][bucket] += count;
    };

    const caseOpen = new Set(['OPEN', 'WAITING_SELLER_RESPONSE', 'WAITING_FOR_SELLER']);
    const caseAttended = new Set(['ON_HOLD', 'WAITING_BUYER_RESPONSE', 'WAITING_FOR_BUYER']);
    const caseResolved = new Set(['CLOSED', 'RESOLVED']);

    const disputeOpen = new Set(['OPEN', 'WAITING_FOR_SELLER_RESPONSE']);
    const disputeAttended = new Set(['UNDER_REVIEW']);
    const disputeResolved = new Set(['RESOLVED_BUYER_FAVOUR', 'RESOLVED_SELLER_FAVOUR', 'CLOSED']);

    // Cancellations use manual worksheetStatus
    cancellationStats.forEach((stat) => {
      const { date, status } = stat._id;
      addCount(date, stat.pstDate, 'cancellations', status, stat.count);
    });

    // Returns use manual worksheetStatus
    returnStats.forEach((stat) => {
      const { date, status } = stat._id;
      addCount(date, stat.pstDate, 'returns', status, stat.count);
    });

    // Cases use automatic status logic
    caseStats.forEach((stat) => {
      const { date, status } = stat._id;
      if (caseOpen.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'open', stat.count);
      } else if (caseAttended.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'attended', stat.count);
      } else if (caseResolved.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'resolved', stat.count);
      } else {
        addCount(date, stat.pstDate, 'inrDisputes', 'attended', stat.count);
      }
    });

    // Disputes use automatic status logic
    disputeStats.forEach((stat) => {
      const { date, status } = stat._id;
      if (disputeOpen.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'open', stat.count);
      } else if (disputeAttended.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'attended', stat.count);
      } else if (disputeResolved.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'resolved', stat.count);
      } else {
        addCount(date, stat.pstDate, 'inrDisputes', 'attended', stat.count);
      }
    });

    inquiryStats.forEach((stat) => {
      const date = stat._id.date;
      const entry = ensureDate(date, stat.pstDate);
      entry.inquiries.total += stat.count;
    });

    const worksheetStats = Array.from(dateMap.values()).sort((a, b) =>
      a.date < b.date ? 1 : -1
    );

    res.json(worksheetStats);
  } catch (error) {
    console.error('Error fetching worksheet statistics:', error);
    res.status(500).json({ error: 'Failed to fetch worksheet statistics' });
  }
});

// Worksheet summary for cards (totals + open counts + totalOrders) based on the same filter as worksheet-statistics
router.get('/worksheet-summary', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Use UTC boundaries for filtering (matches frontend local date selection)
    const buildDateRangeMatch = (field) => {
      if (!startDate && !endDate) return {};
      const range = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setUTCHours(0, 0, 0, 0); // Start of day in UTC
        range.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setUTCHours(23, 59, 59, 999); // End of day in UTC
        range.$lte = end;
      }
      return { [field]: range };
    };

    // Total orders denominator (uses dateSold like order analytics)
    const totalOrdersQuery = {
      ...buildDateRangeMatch('dateSold')
    };

    // Define status mappings first (needed for overall open counts)
    const caseOpen = new Set(['OPEN', 'WAITING_SELLER_RESPONSE', 'WAITING_FOR_SELLER']);
    const caseAttended = new Set(['ON_HOLD', 'WAITING_BUYER_RESPONSE', 'WAITING_FOR_BUYER']);
    const caseResolved = new Set(['CLOSED', 'RESOLVED']);

    const disputeOpen = new Set(['OPEN', 'WAITING_FOR_SELLER_RESPONSE']);
    const disputeAttended = new Set(['UNDER_REVIEW']);
    const disputeResolved = new Set(['RESOLVED_BUYER_FAVOUR', 'RESOLVED_SELLER_FAVOUR', 'CLOSED']);

    // Cancellations: orders with cancelState in list, date is worksheetDate (dateSold || creationDate)
    const cancellationStates = ['CANCEL_REQUESTED', 'IN_PROGRESS', 'CANCELED', 'CANCELLED'];
    const cancellationsMatchStage = {
      $match: {
        cancelState: { $in: cancellationStates }
      }
    };

    const cancellationsPipeline = [
      { $addFields: { worksheetDate: { $ifNull: ['$dateSold', '$creationDate'] } } },
      cancellationsMatchStage,
      ...(startDate || endDate ? [{ $match: buildDateRangeMatch('worksheetDate') }] : []),
      {
        $project: {
          worksheetStatus: { $ifNull: ['$worksheetStatus', 'open'] }
        }
      },
      {
        $group: {
          _id: '$worksheetStatus',
          count: { $sum: 1 }
        }
      }
    ];

    // Returns: Return.creationDate, manual worksheetStatus default open
    const returnsPipeline = [
      ...(startDate || endDate ? [{ $match: buildDateRangeMatch('creationDate') }] : []),
      {
        $project: {
          worksheetStatus: { $ifNull: ['$worksheetStatus', 'open'] }
        }
      },
      {
        $group: {
          _id: '$worksheetStatus',
          count: { $sum: 1 }
        }
      }
    ];

    // INR: Case.creationDate, automatic status based on Case.status (same mapping as worksheet table)
    const inrPipeline = [
      ...(startDate || endDate ? [{ $match: buildDateRangeMatch('creationDate') }] : []),
      {
        $project: {
          status: '$status'
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ];

    // Disputes: PaymentDispute.openDate || createdAt, automatic status based on paymentDisputeStatus (same mapping as worksheet table)
    const disputesPipeline = [
      { $addFields: { worksheetDate: { $ifNull: ['$openDate', '$createdAt'] } } },
      ...(startDate || endDate ? [{ $match: buildDateRangeMatch('worksheetDate') }] : []),
      {
        $project: {
          status: '$paymentDisputeStatus'
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ];

    // Open counts on cards should be overall (ignore date filter).
    // Rates (based on totals + totalOrders) should still respect date filter.
    const [totalOrders, cancellationsByStatus, returnsByStatus, inrByStatus, disputesByStatus, cancellationsOpenOverall, returnsOpenOverall, inrOpenOverall, disputesOpenOverall] = await Promise.all([
      Order.countDocuments(totalOrdersQuery),
      Order.aggregate(cancellationsPipeline),
      Return.aggregate(returnsPipeline),
      Case.aggregate(inrPipeline),
      PaymentDispute.aggregate(disputesPipeline),
      Order.countDocuments({
        cancelState: { $in: cancellationStates },
        $or: [{ worksheetStatus: 'open' }, { worksheetStatus: { $exists: false } }, { worksheetStatus: null }]
      }),
      Return.countDocuments({
        $or: [{ worksheetStatus: 'open' }, { worksheetStatus: { $exists: false } }, { worksheetStatus: null }]
      }),
      Case.countDocuments({ status: { $in: Array.from(caseOpen) } }),
      PaymentDispute.countDocuments({ paymentDisputeStatus: { $in: Array.from(disputeOpen) } })
    ]);

    const toWorksheetBuckets = (rows) => {
      const base = { open: 0, attended: 0, resolved: 0, total: 0 };
      rows.forEach((r) => {
        const key = r._id;
        const count = r.count || 0;
        if (key === 'open' || key === 'attended' || key === 'resolved') {
          base[key] += count;
          base.total += count;
        }
      });
      return base;
    };

    const cancellations = toWorksheetBuckets(cancellationsByStatus);
    const returns = toWorksheetBuckets(returnsByStatus);
    cancellations.open = cancellationsOpenOverall || 0;
    returns.open = returnsOpenOverall || 0;

    const inr = { open: 0, attended: 0, resolved: 0, total: 0 };
    inrByStatus.forEach((r) => {
      const status = r._id;
      const count = r.count || 0;
      if (caseOpen.has(status)) inr.open += count;
      else if (caseResolved.has(status)) inr.resolved += count;
      else if (caseAttended.has(status)) inr.attended += count;
      else inr.attended += count;
      inr.total += count;
    });
    inr.open = inrOpenOverall || 0;

    const disputes = { open: 0, attended: 0, resolved: 0, total: 0 };
    disputesByStatus.forEach((r) => {
      const status = r._id;
      const count = r.count || 0;
      if (disputeOpen.has(status)) disputes.open += count;
      else if (disputeAttended.has(status)) disputes.attended += count;
      else if (disputeResolved.has(status)) disputes.resolved += count;
      else disputes.attended += count;
      disputes.total += count;
    });
    disputes.open = disputesOpenOverall || 0;

    res.json({
      totalOrders,
      cancellations,
      returns,
      inr,
      disputes
    });
  } catch (error) {
    console.error('Error fetching worksheet summary:', error);
    res.status(500).json({ error: 'Failed to fetch worksheet summary' });
  }
});

export default router;

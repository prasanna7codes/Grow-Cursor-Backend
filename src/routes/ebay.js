import express from 'express';
import axios from 'axios';
import qs from 'qs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import FormData from 'form-data';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Seller from '../models/Seller.js';
import Order from '../models/Order.js';
import Return from '../models/Return.js';
import Case from '../models/Case.js';
import PaymentDispute from '../models/PaymentDispute.js';
import Message from '../models/Message.js';
import Listing from '../models/Listing.js';
import ActiveListing from '../models/ActiveListing.js';
import FitmentCache from '../models/FitmentCache.js';
import ConversationMeta from '../models/ConversationMeta.js';
import ExchangeRate from '../models/ExchangeRate.js';
import { parseStringPromise } from 'xml2js';
import imageCache from '../lib/imageCache.js';
import multer from 'multer';
import FeedUpload from '../models/FeedUpload.js';

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

// ============================================
// UPLOAD FEED TO EBAY
// ============================================
router.post('/feed/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { sellerId, feedType = 'FX_LISTING', schemaVersion = '1.0' } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!sellerId) {
      return res.status(400).json({ error: 'Missing sellerId' });
    }

    console.log(`[Feed Upload] Starting upload for seller ${sellerId}, feedType=${feedType}`);

    // 1. Get Seller & Token
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    const accessToken = await ensureValidToken(seller);

    // 2. Create Task
    // POST https://api.ebay.com/sell/feed/v1/task
    console.log(`[Feed Upload] Creating task...`);
    const createTaskRes = await axios.post(
      'https://api.ebay.com/sell/feed/v1/task',
      {
        feedType: feedType,
        schemaVersion: schemaVersion
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' // Default to US, make configurable if needed
        }
      }
    );

    // Task location is in "location" header, but ID is usually part of the URL
    // The response body is empty for 202, but some docs say it returns ID in location header
    // The documentation says: "The location response header contains the URL to the newly created task. The URL includes the eBay-assigned task ID"
    const locationHeader = createTaskRes.headers.location;
    if (!locationHeader) {
      throw new Error('Failed to get task location from eBay');
    }

    const taskId = locationHeader.split('/').pop();
    console.log(`[Feed Upload] Task created with ID: ${taskId}`);

    // 3. Upload File
    // POST https://api.ebay.com/sell/feed/v1/task/{task_id}/upload_file
    console.log(`[Feed Upload] Uploading file to task ${taskId}...`);

    const formData = new FormData();
    // 'file' is the required key name for the file content
    formData.append('file', file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });
    // 'fileName', 'name', 'type' might be required as extra fields based on some examples,
    // but the official docs say: "This call does not have a JSON Request payload but uploads the file as form-data."
    // and "key-value pair name: 'file'".
    // The user's example showed payload = {"fileName": ..., "name": "file", "type": "form-data"}
    // valid form-data keys: fileName, name, type.
    formData.append('fileName', file.originalname);
    formData.append('name', 'file');
    formData.append('type', 'form-data');


    const uploadRes = await axios.post(
      `https://api.ebay.com/sell/feed/v1/task/${taskId}/upload_file`,
      formData,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...formData.getHeaders()
        }
      }
    );

    console.log(`[Feed Upload] File uploaded successfully. Status: ${uploadRes.status}`);

    // Create local record
    await FeedUpload.create({
      seller: seller._id,
      taskId: taskId,
      fileName: file.originalname,
      feedType: feedType,
      schemaVersion: schemaVersion,
      status: 'CREATED' // Initial status
    });

    res.json({
      success: true,
      taskId: taskId,
      message: 'File uploaded and processing started',
      uploadStatus: uploadRes.status
    });

  } catch (error) {
    console.error('[Feed Upload] Error:', error.message);
    if (error.response) {
      console.error('[Feed Upload] eBay Response:', error.response.data);
      console.error('[Feed Upload] eBay Status:', error.response.status);
    }
    res.status(500).json({
      error: 'Failed to upload feed',
      details: error.response?.data || error.message
    });
  }
});

// ============================================
// GET FEED TASKS STATUS
// ============================================
router.get('/feed/tasks', requireAuth, async (req, res) => {
  try {
    const { sellerId, limit = 10, offset = 0 } = req.query;

    if (!sellerId) {
      return res.status(400).json({ error: 'Missing sellerId' });
    }

    // 1. Get Seller & Token
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    const accessToken = await ensureValidToken(seller);

    // 2. Fetch Tasks from eBay
    // GET https://api.ebay.com/sell/feed/v1/task
    // 2. Fetch Tasks from Local DB
    console.log(`[Feed Tasks] Fetching tasks for seller ${sellerId} from DB...`);

    // Calculate skip based on offset/limit
    const skip = parseInt(offset) || 0;
    const limitNum = parseInt(limit) || 10;

    const dbTasks = await FeedUpload.find({ seller: sellerId })
      .sort({ creationDate: -1 })
      .skip(skip)
      .limit(limitNum);

    const total = await FeedUpload.countDocuments({ seller: sellerId });

    // 3. Sync Status with eBay for Incomplete Tasks
    // We only need to check status if it's not COMPLETED or FAILURE
    const tasksToSync = dbTasks.filter(t =>
      t.status !== 'COMPLETED' &&
      t.status !== 'COMPLETED_WITH_ERROR' &&
      t.status !== 'FAILURE'
    );

    if (tasksToSync.length > 0) {
      console.log(`[Feed Tasks] Syncing ${tasksToSync.length} tasks with eBay...`);

      for (const task of tasksToSync) {
        try {
          // GET https://api.ebay.com/sell/feed/v1/task/{task_id}
          const taskRes = await axios.get(
            `https://api.ebay.com/sell/feed/v1/task/${task.taskId}`,
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
              }
            }
          );

          const ebayTask = taskRes.data;

          // Update local DB if status changed
          if (ebayTask.status !== task.status || ebayTask.uploadSummary) {
            task.status = ebayTask.status;
            if (ebayTask.uploadSummary) {
              task.uploadSummary = {
                successCount: ebayTask.uploadSummary.successCount,
                failureCount: ebayTask.uploadSummary.failureCount
              };
            }
            task.lastUpdated = new Date();
            await task.save();
          }
        } catch (err) {
          console.error(`[Feed Tasks] Failed to sync task ${task.taskId}:`, err.message);
        }
      }
    }

    res.json({
      success: true,
      tasks: dbTasks,
      total: total
    });

  } catch (error) {
    console.error('[Feed Tasks] Error:', error.message);
    if (error.response) {
      console.error('[Feed Tasks] eBay Response:', error.response.data);
    }
    res.status(500).json({
      error: 'Failed to fetch feed tasks',
      details: error.response?.data || error.message
    });
  }
});

// ============================================
// EBAY OAUTH SCOPES - Single source of truth
// Used in both initial authorization AND token refresh
// ============================================
const EBAY_OAUTH_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.payment.dispute',
  'https://api.ebay.com/oauth/api_scope/sell.finances',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly'
].join(' ');

// ============================================
// IMAGE CACHE INITIALIZATION
// ============================================
// Start automatic cleanup of expired cache entries (runs every 10 minutes)
imageCache.startAutoCleanup();

// ============================================
// HELPER: Recalculate USD Fields
// ============================================
function recalculateUSDFields(order) {
  // Get conversion rate (default to 1 for US orders)
  let conversionRate = 1;

  if (order.purchaseMarketplaceId !== 'EBAY_US') {
    const totalDueSeller = order.paymentSummary?.totalDueSeller;
    if (totalDueSeller?.value && totalDueSeller?.convertedFromValue) {
      const usdValue = parseFloat(totalDueSeller.value);
      const originalValue = parseFloat(totalDueSeller.convertedFromValue);
      if (usdValue > 0 && originalValue > 0) {
        conversionRate = usdValue / originalValue;
      }
    }
  }

  // Recalculate all USD fields
  const updates = {
    conversionRate: parseFloat(conversionRate.toFixed(5))
  };

  // Convert monetary fields
  const monetaryFields = [
    'subtotal', 'shipping', 'salesTax', 'discount',
    'transactionFees', 'beforeTax', 'estimatedTax'
  ];

  monetaryFields.forEach(field => {
    if (order[field] !== undefined && order[field] !== null && order[field] !== '') {
      const value = parseFloat(order[field]);
      if (!isNaN(value)) {
        updates[`${field}USD`] = parseFloat((value * conversionRate).toFixed(2));
      }
    } else {
      // If field is null/empty, clear the USD field
      updates[`${field}USD`] = null;
    }
  });

  // Calculate refunds
  if (order.refunds && Array.isArray(order.refunds)) {
    const totalRefund = order.refunds.reduce((sum, r) => {
      const amt = parseFloat(r.amount?.value || 0);
      return sum + (isNaN(amt) ? 0 : amt);
    }, 0);
    updates.refundTotalUSD = parseFloat((totalRefund * conversionRate).toFixed(2));
  } else if (order.paymentSummary?.refunds && Array.isArray(order.paymentSummary.refunds)) {
    const totalRefund = order.paymentSummary.refunds.reduce((sum, r) => {
      const amt = parseFloat(r.amount?.value || 0);
      return sum + (isNaN(amt) ? 0 : amt);
    }, 0);
    updates.refundTotalUSD = parseFloat((totalRefund * conversionRate).toFixed(2));
  }

  return updates;
}

// ============================================
// HELPER: Calculate Financial Fields (All Orders Sheet)
// ============================================
// Calculates TDS, TID, NET, and P.Balance INR based on orderEarnings
async function calculateFinancials(order, marketplace = 'EBAY') {
  const updates = {
    tid: 0.24 // Fixed Transaction ID
  };

  // If orderEarnings is null or undefined, set all financial fields to null
  if (order.orderEarnings === null || order.orderEarnings === undefined) {
    updates.tds = null;
    updates.net = null;
    updates.pBalanceINR = null;
    updates.ebayExchangeRate = null;
    return updates;
  }

  const earnings = parseFloat(order.orderEarnings) || 0;

  // TDS = 1% of orderEarnings
  updates.tds = parseFloat((earnings * 0.01).toFixed(2));

  // NET = orderEarnings - tds - tid
  updates.net = parseFloat((earnings - updates.tds - updates.tid).toFixed(2));

  // P.Balance INR = net × eBay exchangeRate (USD to INR)
  // ALWAYS use EBAY marketplace (USD to INR) regardless of order marketplace
  // Because orderEarnings is already in USD after conversion
  try {
    const exchangeRate = await ExchangeRate.findOne({ marketplace: 'EBAY' }).sort({ effectiveDate: -1 });
    if (exchangeRate && exchangeRate.rate) {
      updates.ebayExchangeRate = exchangeRate.rate; // Store the eBay exchange rate used
      updates.pBalanceINR = parseFloat((updates.net * exchangeRate.rate).toFixed(2));
    } else {
      updates.ebayExchangeRate = null;
      updates.pBalanceINR = null; // No exchange rate available
    }
  } catch (err) {
    console.error('[Calculate Financials] Error fetching exchange rate:', err);
    updates.ebayExchangeRate = null;
    updates.pBalanceINR = null;
  }

  // Calculate and store profit per order
  // Profit = P.Balance (INR) - A_total-inr - Total_CC
  const pBalanceINR = updates.pBalanceINR !== undefined ? updates.pBalanceINR : (order.pBalanceINR || 0);
  const amazonTotalINR = order.amazonTotalINR || 0;
  const totalCC = order.totalCC || 0;
  updates.profit = parseFloat((pBalanceINR - amazonTotalINR - totalCC).toFixed(2));

  return updates;
}

// Calculate Amazon-side financial fields
async function calculateAmazonFinancials(order) {
  const updates = {};

  // For US orders, if USD fields are missing, fall back to base currency fields
  const isUSOrder = order.purchaseMarketplaceId === 'EBAY_US' || order.conversionRate === 1;
  let beforeTaxUSD = parseFloat(order.beforeTaxUSD);
  let estimatedTaxUSD = parseFloat(order.estimatedTaxUSD);

  if (isUSOrder) {
    if (!beforeTaxUSD && order.beforeTax !== undefined) {
      beforeTaxUSD = parseFloat(order.beforeTax) || 0;
      updates.beforeTaxUSD = beforeTaxUSD; // Update the missing field
    }
    if (!estimatedTaxUSD && order.estimatedTax !== undefined) {
      estimatedTaxUSD = parseFloat(order.estimatedTax) || 0;
      updates.estimatedTaxUSD = estimatedTaxUSD; // Update the missing field
    }
  }

  const beforeTax = beforeTaxUSD || 0;
  const estimatedTax = estimatedTaxUSD || 0;

  // Amazon Total = Before Tax + Estimated Tax
  updates.amazonTotal = parseFloat((beforeTax + estimatedTax).toFixed(2));

  // Check if order is FULLY_REFUNDED or PARTIALLY_REFUNDED
  const paymentStatus = order.paymentSummary?.payments?.[0]?.paymentStatus;
  const isRefunded = paymentStatus === 'FULLY_REFUNDED' || paymentStatus === 'PARTIALLY_REFUNDED';

  // IGST=0 logic only applies to orders from Nov 28, 2025 onwards
  const orderDate = new Date(order.creationDate || order.dateSold);
  const nov28_2025 = new Date('2025-11-28T00:00:00.000Z');
  const applyIGSTZeroForRefunds = orderDate >= nov28_2025;

  // Fetch latest Amazon exchange rate
  try {
    const exchangeRate = await ExchangeRate.findOne({ marketplace: 'AMAZON' }).sort({ effectiveDate: -1 });
    if (exchangeRate && exchangeRate.rate) {
      updates.amazonExchangeRate = exchangeRate.rate; // Store the Amazon exchange rate used
      updates.amazonTotalINR = parseFloat((updates.amazonTotal * exchangeRate.rate).toFixed(2));

      // Marketplace Fee = 4% of amazonTotalINR
      updates.marketplaceFee = parseFloat((updates.amazonTotalINR * 0.04).toFixed(2));

      // IGST = 18% of marketplace fee, BUT 0 if order is refunded AND from Nov 28, 2025 onwards
      updates.igst = (isRefunded && applyIGSTZeroForRefunds) ? 0 : parseFloat((updates.marketplaceFee * 0.18).toFixed(2));

      // Total CC = Marketplace Fee + IGST
      updates.totalCC = parseFloat((updates.marketplaceFee + updates.igst).toFixed(2));
    } else {
      // No exchange rate available, set to null
      updates.amazonExchangeRate = null;
      updates.amazonTotalINR = null;
      updates.marketplaceFee = null;
      updates.igst = null;
      updates.totalCC = null;
    }
  } catch (err) {
    console.error('[Calculate Amazon Financials] Error fetching exchange rate:', err);
    updates.amazonExchangeRate = null;
    updates.amazonTotalINR = null;
    updates.marketplaceFee = null;
    updates.igst = null;
    updates.totalCC = null;
  }

  // Recalculate profit after Amazon financials update
  // Profit = P.Balance (INR) - A_total-inr - Total_CC
  const pBalanceINR = order.pBalanceINR || 0;
  const amazonTotalINR = updates.amazonTotalINR !== undefined ? updates.amazonTotalINR : (order.amazonTotalINR || 0);
  const totalCC = updates.totalCC !== undefined ? updates.totalCC : (order.totalCC || 0);
  updates.profit = parseFloat((pBalanceINR - amazonTotalINR - totalCC).toFixed(2));

  return updates;
}

// HELPER: Ensure Seller Token is Valid (Refreshes if < 2 mins left)
async function ensureValidToken(seller, retries = 3) {
  const now = Date.now();
  const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
  const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
  const bufferTime = 2 * 60 * 1000; // 2 minutes buffer

  // If token is valid, return it
  if (fetchedAt && (now - fetchedAt < expiresInMs - bufferTime)) {
    return seller.ebayTokens.access_token;
  }

  console.log(`[Token Refresh] Refreshing token for ${seller.user?.username || seller._id}`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const refreshRes = await axios.post(
        'https://api.ebay.com/identity/v1/oauth2/token',
        qs.stringify({
          grant_type: 'refresh_token',
          refresh_token: seller.ebayTokens.refresh_token,
          scope: EBAY_OAUTH_SCOPES // Using centralized scopes constant
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
          },
          timeout: 10000 // 10 second timeout
        }
      );

      // Update Seller
      seller.ebayTokens.access_token = refreshRes.data.access_token;
      seller.ebayTokens.expires_in = refreshRes.data.expires_in;
      seller.ebayTokens.fetchedAt = new Date();
      await seller.save();

      if (attempt > 1) {
        console.log(`[Token Refresh] ✅ Succeeded on attempt ${attempt} for ${seller.user?.username || seller._id}`);
      }

      return refreshRes.data.access_token;
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 503 || status === 429 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';

      if (isRetryable && attempt < retries) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff: 1s, 2s, 4s (max 5s)
        console.log(`[Token Refresh] ⚠️ Attempt ${attempt} failed with ${status || err.code}, retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      console.error(`[Token Refresh] ❌ Failed for ${seller._id} after ${attempt} attempts:`, err.message);
      throw new Error(`Failed to refresh eBay token: ${err.response?.status || err.message}`);
    }
  }
}

// ============================================
// HELPER: Fetch ALL Ad Fees from Finances API
// ============================================
// Returns a Map of orderId -> adFee amount
// This is more efficient than fetching per-order
async function fetchAllAdFees(accessToken, sinceDate = null) {
  const adFeeMap = new Map();
  let offset = 0;
  const limit = 200;
  let hasMore = true;

  console.log(`[Finances API] Fetching all AD_FEE transactions...`);

  try {
    while (hasMore) {
      // Build URL with filter - use proper encoding
      const baseUrl = 'https://apiz.ebay.com/sell/finances/v1/transaction';
      const filterValue = 'transactionType:{NON_SALE_CHARGE}';

      console.log(`[Finances API] Calling: ${baseUrl} with filter=${filterValue}, offset=${offset}`);

      const response = await axios.get(baseUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
        },
        params: {
          filter: filterValue,
          limit: limit,
          offset: offset
        }
      });

      const transactions = response.data?.transactions || [];
      console.log(`[Finances API] Fetched ${transactions.length} NON_SALE_CHARGE transactions at offset ${offset}`);

      for (const txn of transactions) {
        // Check if this is an AD_FEE transaction
        if (txn.feeType === 'AD_FEE' && txn.references) {
          // Find the ORDER_ID reference
          const orderRef = txn.references.find(ref => ref.referenceType === 'ORDER_ID');

          if (orderRef) {
            const orderId = orderRef.referenceId;
            const feeAmount = Math.abs(parseFloat(txn.amount?.value || 0));

            // Handle CREDIT (refund) vs DEBIT (charge)
            // DEBIT = charged, CREDIT = refunded
            const existingFee = adFeeMap.get(orderId) || 0;
            if (txn.bookingEntry === 'CREDIT') {
              // This is a refund of ad fee (subtract from total)
              adFeeMap.set(orderId, existingFee - feeAmount);
            } else {
              // This is a charge (add to total)
              adFeeMap.set(orderId, existingFee + feeAmount);
            }
          }
        }
      }

      // Check if there are more transactions
      if (transactions.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
        // Safety limit - don't fetch more than 10000 transactions
        if (offset >= 10000) {
          console.log(`[Finances API] Reached safety limit at offset ${offset}`);
          hasMore = false;
        }
      }
    }

    console.log(`[Finances API] Built ad fee map with ${adFeeMap.size} orders`);
    return { success: true, adFeeMap };

  } catch (error) {
    if (error.response?.status === 403) {
      console.log(`[Finances API] Missing sell.finances scope`);
      return { success: false, error: 'missing_scope', adFeeMap: new Map() };
    }
    // Log detailed error info for debugging
    console.error(`[Finances API] Error fetching ad fees:`, error.message);
    console.error(`[Finances API] Status:`, error.response?.status);
    console.error(`[Finances API] Response:`, JSON.stringify(error.response?.data, null, 2));
    return { success: false, error: error.message, adFeeMap: new Map() };
  }
}

// Single order lookup (used when ad fee map is not available)
async function fetchOrderAdFee(accessToken, orderId, adFeeMap = null) {
  // If we have a pre-built map, use it
  if (adFeeMap) {
    const adFee = adFeeMap.get(orderId) || 0;
    return { success: true, adFeeGeneral: adFee };
  }

  // Otherwise, we need to search through transactions
  // This is less efficient but works for single lookups
  try {
    const response = await axios.get(
      `https://apiz.ebay.com/sell/finances/v1/transaction`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
        },
        params: {
          filter: `transactionType:{NON_SALE_CHARGE}`,
          limit: 200
        }
      }
    );

    const transactions = response.data?.transactions || [];
    let adFeeTotal = 0;

    for (const txn of transactions) {
      if (txn.feeType === 'AD_FEE' && txn.references) {
        const matchingRef = txn.references.find(
          ref => ref.referenceType === 'ORDER_ID' && ref.referenceId === orderId
        );

        if (matchingRef) {
          const feeAmount = Math.abs(parseFloat(txn.amount?.value || 0));
          if (txn.bookingEntry === 'CREDIT') {
            adFeeTotal -= feeAmount;
          } else {
            adFeeTotal += feeAmount;
          }
        }
      }
    }

    return { success: true, adFeeGeneral: Math.max(0, adFeeTotal) };
  } catch (error) {
    if (error.response?.status === 403) {
      return { success: false, error: 'missing_scope', adFeeGeneral: null };
    }
    console.error(`[Finances API] Error fetching ad fee for ${orderId}:`, error.message);
    return { success: false, error: error.message, adFeeGeneral: null };
  }
}

// ============================================
// HELPER: Handle Order Payment Status Change
// ============================================
/**
 * Handles refund processing when orderPaymentStatus changes
 * FULLY_REFUNDED: Set earnings to $0
 * PARTIALLY_REFUNDED: Set earnings to null (user will manually enter)
 * @param {Object} existingOrder - The order document from DB
 * @param {String} newPaymentStatus - The new payment status from eBay
 * @param {String} accessToken - Valid eBay access token
 * @param {ObjectId} sellerId - The seller ID
 * @returns {Object} - Updated order data or null if no action needed
 */
async function handleOrderPaymentStatusChange(existingOrder, newPaymentStatus, accessToken, sellerId) {
  const oldStatus = existingOrder.orderPaymentStatus;

  // Only process if status actually changed
  if (oldStatus === newPaymentStatus) {
    return null;
  }

  console.log(`[Refund Handler] Status change detected for ${existingOrder.orderId}: ${oldStatus} → ${newPaymentStatus}`);

  if (newPaymentStatus === 'FULLY_REFUNDED') {
    // ========== FULLY REFUNDED: Set earnings to $0 ==========
    console.log(`[Refund Handler] FULLY_REFUNDED: Setting earnings to $0 for ${existingOrder.orderId}`);

    // Calculate financial fields with $0 earnings
    const marketplace = existingOrder.purchaseMarketplaceId === 'EBAY_ENCA' ? 'EBAY_CA' :
      existingOrder.purchaseMarketplaceId === 'EBAY_AU' ? 'EBAY_AU' : 'EBAY';
    const financials = await calculateFinancials({ orderEarnings: 0 }, marketplace);

    return {
      subtotal: 0,
      subtotalUSD: 0,
      shipping: 0,
      shippingUSD: 0,
      salesTax: 0,
      salesTaxUSD: 0,
      discount: 0,
      discountUSD: 0,
      transactionFees: 0,
      transactionFeesUSD: 0,
      adFeeGeneral: 0,
      orderEarnings: 0,
      ...financials
    };

  } else if (newPaymentStatus === 'PARTIALLY_REFUNDED') {
    // ========== PARTIALLY REFUNDED: Set earnings to null (user will manually enter) ==========
    console.log(`[Refund Handler] PARTIALLY_REFUNDED: Setting earnings to null for ${existingOrder.orderId}`);

    try {
      // Fetch updated ad fee from Finances API
      const adFeeResult = await fetchOrderAdFee(accessToken, existingOrder.orderId);
      const adFeeGeneral = adFeeResult.success ? adFeeResult.adFeeGeneral : existingOrder.adFeeGeneral;

      // Calculate financial fields with null earnings
      const marketplace = existingOrder.purchaseMarketplaceId === 'EBAY_ENCA' ? 'EBAY_CA' :
        existingOrder.purchaseMarketplaceId === 'EBAY_AU' ? 'EBAY_AU' : 'EBAY';
      const financials = await calculateFinancials({ orderEarnings: null }, marketplace);

      return {
        adFeeGeneral,
        orderEarnings: null, // User must manually enter earnings
        ...financials
      };

    } catch (error) {
      console.error(`[Refund Handler] Error fetching ad fee for ${existingOrder.orderId}:`, error.message);

      // Calculate financial fields with null earnings
      const marketplace = existingOrder.purchaseMarketplaceId === 'EBAY_ENCA' ? 'EBAY_CA' :
        existingOrder.purchaseMarketplaceId === 'EBAY_AU' ? 'EBAY_AU' : 'EBAY';
      const financials = await calculateFinancials({ orderEarnings: null }, marketplace);

      return {
        orderEarnings: null, // User must manually enter earnings
        ...financials
      };
    }
  }

  // No action needed for other statuses
  return null;
}

// ============================================
// HELPER: Calculate Order Earnings (Not needed anymore - kept for compatibility)
// ============================================
/**
 * Simple function that returns $0 for FULLY_REFUNDED orders
 * Not actively used - earnings are calculated in buildOrderData() for PAID orders
 * @returns {Object} - { orderEarnings: 0 }
 */
function calculateOrderEarnings() {
  // FULLY_REFUNDED orders always show $0 earnings
  return {
    orderEarnings: 0
  };
}


// --- NEW CONFIG: AUTOMATED WELCOME MESSAGE ---
const ENABLE_AUTO_WELCOME = true; // Set to false to disable
const WELCOME_TEMPLATE = `Hello {BUYER_NAME},

Thank you for your recent purchase!

Orders are typically shipped within 12–24 hours. We will keep you updated, and once your order is shipped, the tracking details will be available on your eBay order page.

If you need any assistance, please feel free to message us at any time. Wishing you a wonderful day!`;

// --- HELPER: Send Auto Welcome Message ---
async function sendAutoWelcomeMessage(seller, order) {
  if (!ENABLE_AUTO_WELCOME) return;

  try {
    const buyerUsername = order.buyer?.username;
    const buyerName = order.buyer?.buyerRegistrationAddress?.fullName || buyerUsername;

    // 1. Get First Item Details
    const lineItem = order.lineItems?.[0];
    const itemId = lineItem?.legacyItemId;
    let itemTitle = lineItem?.title;

    // 2. CHECK FOR MULTIPLE ITEMS
    const itemCount = order.lineItems?.length || 0;
    if (itemCount > 1) {
      // Append count to title: "iPad Case (+ 1 other)"
      itemTitle = `${itemTitle} (+ ${itemCount - 1} other${itemCount - 1 > 1 ? 's' : ''})`;
    }

    if (!buyerUsername || !itemId) return;

    // 1. Prepare the Message Body
    const sellerName = seller.user?.username || "The Team";
    const body = WELCOME_TEMPLATE
      .replace('{BUYER_NAME}', buyerName.split(' ')[0]) // Use First Name only for a personal touch
      .replace('{SELLER_NAME}', sellerName);

    // 2. Get Token
    const token = await ensureValidToken(seller);

    // 3. XML Request (Same as your send-message route)
    const xmlRequest = `
      <?xml version="1.0" encoding="utf-8"?>
      <AddMemberMessageAAQToPartnerRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
        <ItemID>${itemId}</ItemID>
        <MemberMessage>
          <Body>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Body>
          <Subject>Thanks for your order! #${order.orderId}</Subject>
          <QuestionType>General</QuestionType>
          <RecipientID>${buyerUsername}</RecipientID>
        </MemberMessage>
      </AddMemberMessageAAQToPartnerRequest>
    `;

    // 4. Send to eBay
    await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
        'X-EBAY-API-CALL-NAME': 'AddMemberMessageAAQToPartner',
        'Content-Type': 'text/xml'
      }
    });

    console.log(`[Auto-Welcome] Sent to ${buyerUsername} for Order ${order.orderId}`);

    // 5. Save to DB so it shows in your chat window immediately
    await Message.create({
      seller: seller._id,
      orderId: order.orderId,
      itemId: itemId,
      itemTitle: itemTitle,
      buyerUsername: buyerUsername,
      sender: 'SELLER',
      subject: `Thanks for your order! #${order.orderId}`,
      body: body,
      read: true,
      messageType: 'ORDER',
      messageDate: new Date()
    });

  } catch (err) {
    console.error(`[Auto-Welcome] Failed for ${order.orderId}:`, err.message);
    // Don't throw error here, so we don't stop the polling process
  }
}

// HELPER: Process a single eBay XML Message and save to DB
async function processEbayMessage(msg, seller) {
  try {
    const question = msg.Question?.[0];
    if (!question) return false;

    const msgID = question.MessageID?.[0];
    const senderID = question.SenderID?.[0];
    const senderEmail = question.SenderEmail?.[0];
    const body = question.Body?.[0];
    const subject = question.Subject?.[0];
    const itemID = msg.Item?.[0]?.ItemID?.[0];
    const itemTitle = msg.Item?.[0]?.Title?.[0];

    // --- EXTRACT IMAGES (NEW) ---
    const mediaUrls = [];
    // Check if MessageMedia exists and is an array
    if (msg.MessageMedia && Array.isArray(msg.MessageMedia)) {
      msg.MessageMedia.forEach(media => {
        if (media.MediaURL && media.MediaURL[0]) {
          mediaUrls.push(media.MediaURL[0]);
        }
      });
    }
    // Sometimes it's inside the Question tag as well
    if (question.MessageMedia && Array.isArray(question.MessageMedia)) {
      question.MessageMedia.forEach(media => {
        if (media.MediaURL && media.MediaURL[0]) {
          mediaUrls.push(media.MediaURL[0]);
        }
      });
    }
    // ----------------------------

    // --- DATE PARSING ---
    const rawDate = question.CreationDate?.[0];
    let messageDate = new Date();
    if (rawDate) {
      const parsedDate = new Date(rawDate);
      if (!isNaN(parsedDate.getTime())) messageDate = parsedDate;
    }

    // 1. Prevent Duplicates
    const exists = await Message.findOne({ externalMessageId: msgID });
    if (exists) return false;

    // 2. Determine Message Type (ORDER, INQUIRY, or DIRECT)
    let orderId = null;
    let messageType = 'INQUIRY'; // Default
    let finalItemId = itemID;
    let finalItemTitle = itemTitle;

    if (itemID && senderID) {
      // HAS ITEM: Check if it's an order or inquiry
      const order = await Order.findOne({
        'lineItems.legacyItemId': itemID,
        'buyer.username': senderID
      });
      if (order) {
        orderId = order.orderId;
        messageType = 'ORDER';
        console.log(`[Message] ORDER message for item ${itemID} from ${senderID}`);
      } else {
        messageType = 'INQUIRY';
        console.log(`[Message] INQUIRY about item ${itemID} from ${senderID}`);
      }
    } else if (!itemID && senderID) {
      // NO ITEM: Direct message to seller account
      messageType = 'DIRECT';
      finalItemId = 'DIRECT_MESSAGE';
      finalItemTitle = 'Direct Message (No Item)';
      console.log(`[Message] DIRECT message from ${senderID}: ${subject}`);
    }

    // 3. Save to DB
    await Message.create({
      seller: seller._id,
      orderId,
      itemId: finalItemId,
      itemTitle: finalItemTitle,
      buyerUsername: senderID,
      externalMessageId: msgID,
      sender: 'BUYER',
      subject: subject,
      body: body,
      mediaUrls: mediaUrls,
      read: false,
      messageType,
      messageDate: messageDate
    });

    return true;
  } catch (err) {
    console.error('Error processing message:', err.message);
    return false;
  }
}


// Helper function to extract tracking number from fulfillmentHrefs
async function extractTrackingNumber(fulfillmentHrefs, accessToken) {
  if (!fulfillmentHrefs || fulfillmentHrefs.length === 0) return null;
  try {
    // fulfillmentHrefs contains URLs to fulfillment details
    // Example: "https://api.ebay.com/sell/fulfillment/v1/order/00-00000-00000/fulfillment/00000000000000"
    const fulfillmentUrl = fulfillmentHrefs[0];
    const response = await axios.get(fulfillmentUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    // Extract tracking number from the fulfillment response
    // Check multiple possible locations in the response
    const trackingNumber = response.data?.shipmentTrackingNumber ||
      response.data?.lineItems?.[0]?.shipmentTrackingNumber ||
      response.data?.shippingCarrierCode && response.data?.trackingNumber ||
      null;

    if (!trackingNumber) {
      console.log(`  ⚠️ Fulfillment response has no tracking. Keys: ${Object.keys(response.data || {}).join(', ')}`);
    }
    return trackingNumber;
  } catch (err) {
    console.error(`  ❌ Failed to extract tracking number: ${err.message} (status: ${err.response?.status})`);
    return null;
  }
}

// 1. Start OAuth: Redirect to eBay
router.get('/connect', (req, res) => {
  console.log('========================================');
  console.log('[eBay OAuth] /connect endpoint HIT!');
  console.log('========================================');

  const { token } = req.query; // Get JWT from query param
  if (!token) return res.status(400).send('Missing authentication token');

  const clientId = process.env.EBAY_CLIENT_ID;
  const ruName = process.env.EBAY_RU_NAME;

  // Pass the user's JWT as state parameter so we can identify them in callback
  const state = encodeURIComponent(token);
  const redirectUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(ruName)}&response_type=code&scope=${encodeURIComponent(EBAY_OAUTH_SCOPES)}&state=${state}`;

  console.log('[eBay OAuth] Scopes requested:', EBAY_OAUTH_SCOPES);
  console.log('[eBay OAuth] Full redirect URL:', redirectUrl);
  res.redirect(redirectUrl);
});

// 2. OAuth Callback: Exchange code for tokens and save to seller
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing code');
  if (!state) return res.status(400).send('Missing state parameter');

  try {
    // Decode the JWT from state to identify the seller
    const token = decodeURIComponent(state);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;

    // Exchange code for tokens
    const tokenRes = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      qs.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.EBAY_RU_NAME,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
        },
      }
    );

    // Save tokens to seller
    const seller = await Seller.findOne({ user: userId });
    if (!seller) return res.status(404).send('Seller not found');

    // Log the full token response for debugging
    console.log(`[eBay OAuth] Full token response keys:`, Object.keys(tokenRes.data));
    console.log(`[eBay OAuth] Seller connected. Scope granted by eBay: ${tokenRes.data.scope}`);

    // Check if payment dispute scope was granted
    const grantedScope = tokenRes.data.scope || '';
    if (!grantedScope.includes('sell.payment.dispute')) {
      console.warn(`[eBay OAuth] WARNING: sell.payment.dispute scope NOT granted! Seller will not be able to fetch payment disputes.`);
      console.warn(`[eBay OAuth] Make sure the scope is enabled in your eBay Developer Portal app settings.`);
      console.warn(`[eBay OAuth] Granted scopes were: ${grantedScope || 'NONE'}`);
    } else {
      console.log(`[eBay OAuth] SUCCESS: sell.payment.dispute scope was granted!`);
    }

    seller.ebayTokens = {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
      expires_in: tokenRes.data.expires_in,
      refresh_token_expires_in: tokenRes.data.refresh_token_expires_in,
      token_type: tokenRes.data.token_type,
      scope: tokenRes.data.scope,
      fetchedAt: new Date()
    };
    await seller.save();

    // Fetch first 5 orders for new seller
    try {
      const ordersRes = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
        headers: {
          Authorization: `Bearer ${tokenRes.data.access_token}`,
          'Content-Type': 'application/json',
        },
        params: {
          limit: 15
        },
      });

      const ebayOrders = ordersRes.data.orders || [];

      // Save initial orders in database
      for (const order of ebayOrders) {
        const lineItem = order.lineItems?.[0] || {};
        const fulfillmentInstr = order.fulfillmentStartInstructions?.[0] || {};
        const shipTo = fulfillmentInstr.shippingStep?.shipTo || {};
        const buyerAddr = `${shipTo.contactAddress?.addressLine1 || ''}, ${shipTo.contactAddress?.city || ''}, ${shipTo.contactAddress?.stateOrProvince || ''}, ${shipTo.contactAddress?.postalCode || ''}, ${shipTo.contactAddress?.countryCode || ''}`.trim();

        // Extract tracking number if fulfillmentHrefs exists
        const trackingNumber = await extractTrackingNumber(order.fulfillmentHrefs, tokenRes.data.access_token);

        // Extract purchaseMarketplaceId from lineItems
        const purchaseMarketplaceId = lineItem.purchaseMarketplaceId || '';

        await Order.findOneAndUpdate(
          { orderId: order.orderId },
          {
            seller: seller._id,
            orderId: order.orderId,
            legacyOrderId: order.legacyOrderId,
            creationDate: order.creationDate,
            lastModifiedDate: order.lastModifiedDate,
            orderFulfillmentStatus: order.orderFulfillmentStatus,
            orderPaymentStatus: order.orderPaymentStatus,
            sellerId: order.sellerId,
            buyer: order.buyer,
            buyerCheckoutNotes: order.buyerCheckoutNotes,
            pricingSummary: order.pricingSummary,
            cancelStatus: order.cancelStatus,
            paymentSummary: order.paymentSummary,
            fulfillmentStartInstructions: order.fulfillmentStartInstructions,
            lineItems: order.lineItems,
            ebayCollectAndRemitTax: order.ebayCollectAndRemitTax,
            salesRecordReference: order.salesRecordReference,
            totalFeeBasisAmount: order.totalFeeBasisAmount,
            totalMarketplaceFee: order.totalMarketplaceFee,
            dateSold: order.creationDate,
            shipByDate: lineItem.lineItemFulfillmentInstructions?.shipByDate,
            estimatedDelivery: lineItem.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate,
            productName: lineItem.title,
            itemNumber: lineItem.legacyItemId,
            buyerAddress: buyerAddr,
            shippingFullName: shipTo.fullName || '',
            shippingAddressLine1: shipTo.contactAddress?.addressLine1 || '',
            shippingAddressLine2: shipTo.contactAddress?.addressLine2 || '',
            shippingCity: shipTo.contactAddress?.city || '',
            shippingState: shipTo.contactAddress?.stateOrProvince || '',
            shippingPostalCode: shipTo.contactAddress?.postalCode || '',
            shippingCountry: shipTo.contactAddress?.countryCode || '',
            shippingPhone: '0000000000',
            quantity: lineItem.quantity,
            subtotal: parseFloat(order.pricingSummary?.priceSubtotal?.value || 0),
            salesTax: parseFloat(lineItem.ebayCollectAndRemitTaxes?.[0]?.amount?.value || 0),
            discount: parseFloat(order.pricingSummary?.priceDiscount?.value || 0),
            shipping: parseFloat(order.pricingSummary?.deliveryCost?.value || 0),
            transactionFees: parseFloat(order.totalMarketplaceFee?.value || 0),
            adFee: parseFloat(lineItem.appliedPromotions?.[0]?.discountAmount?.value || 0),
            cancelState: order.cancelStatus?.cancelState || 'NONE_REQUESTED',
            refunds: order.paymentSummary?.refunds || [],
            trackingNumber: trackingNumber,
            purchaseMarketplaceId: purchaseMarketplaceId
          },
          { upsert: true, new: true }
        );
      }
    } catch (orderErr) {
      console.error('Failed to fetch initial orders:', orderErr.message);
    }

    // Redirect back to seller profile with success message
    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    res.redirect(`${clientOrigin}/seller-ebay?connected=true`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Fetch Orders (for polling) by sellerId, region(s), with token refresh
router.get('/orders', async (req, res) => {
  const { sellerId, region } = req.query;
  if (!sellerId) return res.status(400).json({ error: 'Missing sellerId' });
  try {
    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    if (!seller.ebayTokens || !seller.ebayTokens.access_token) {
      return res.status(400).json({ error: 'Seller does not have a connected eBay account' });
    }
    // Check token expiry (expires_in is in seconds, fetchedAt is Date)
    const now = Date.now();
    const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
    const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
    // Refresh if less than 2 minutes left
    let accessToken = seller.ebayTokens.access_token;
    if (fetchedAt && (now - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
      // Refresh token
      try {
        const refreshRes = await axios.post(
          'https://api.ebay.com/identity/v1/oauth2/token',
          qs.stringify({
            grant_type: 'refresh_token',
            refresh_token: seller.ebayTokens.refresh_token,
            scope: EBAY_OAUTH_SCOPES, // Using centralized scopes constant
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
            },
          }
        );
        seller.ebayTokens.access_token = refreshRes.data.access_token;
        seller.ebayTokens.expires_in = refreshRes.data.expires_in;
        seller.ebayTokens.fetchedAt = new Date();
        await seller.save();
        accessToken = refreshRes.data.access_token;
      } catch (refreshErr) {
        return res.status(401).json({ error: 'Failed to refresh eBay token', details: refreshErr.message });
      }
    }

    // Get the last modified date from our database to fetch only new/updated orders
    const orderCount = await Order.countDocuments({ seller: seller._id });
    const lastOrder = await Order.findOne({ seller: seller._id }).sort({ lastModifiedDate: -1 });
    const lastModifiedDate = lastOrder ? lastOrder.lastModifiedDate : null;

    // Build eBay API params
    const params = {
      limit: orderCount === 0 ? 15 : 200 // If no orders exist, fetch only 5, else fetch all new/updated
    };

    // If we have orders already, only fetch orders modified after the last one
    if (lastModifiedDate) {
      params.filter = `lastmodifieddate:[${new Date(lastModifiedDate).toISOString()}..${new Date().toISOString()}]`;
    }

    // Fetch orders from eBay API
    const ordersRes = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      params
    });

    const ebayOrders = ordersRes.data.orders || [];

    // Save/update orders in database
    for (const order of ebayOrders) {
      const lineItem = order.lineItems?.[0] || {};
      const fulfillmentInstr = order.fulfillmentStartInstructions?.[0] || {};
      const shipTo = fulfillmentInstr.shippingStep?.shipTo || {};
      const buyerAddr = `${shipTo.contactAddress?.addressLine1 || ''}, ${shipTo.contactAddress?.city || ''}, ${shipTo.contactAddress?.stateOrProvince || ''}, ${shipTo.contactAddress?.postalCode || ''}, ${shipTo.contactAddress?.countryCode || ''}`.trim();

      // Extract tracking number if fulfillmentHrefs exists
      const trackingNumber = await extractTrackingNumber(order.fulfillmentHrefs, accessToken);

      // Extract purchaseMarketplaceId from lineItems
      const purchaseMarketplaceId = lineItem.purchaseMarketplaceId || '';

      await Order.findOneAndUpdate(
        { orderId: order.orderId },
        {
          seller: seller._id,
          orderId: order.orderId,
          legacyOrderId: order.legacyOrderId,
          creationDate: order.creationDate,
          lastModifiedDate: order.lastModifiedDate,
          orderFulfillmentStatus: order.orderFulfillmentStatus,
          orderPaymentStatus: order.orderPaymentStatus,
          sellerId: order.sellerId,
          buyer: order.buyer,
          buyerCheckoutNotes: order.buyerCheckoutNotes,
          pricingSummary: order.pricingSummary,
          cancelStatus: order.cancelStatus,
          paymentSummary: order.paymentSummary,
          fulfillmentStartInstructions: order.fulfillmentStartInstructions,
          lineItems: order.lineItems,
          ebayCollectAndRemitTax: order.ebayCollectAndRemitTax,
          salesRecordReference: order.salesRecordReference,
          totalFeeBasisAmount: order.totalFeeBasisAmount,
          totalMarketplaceFee: order.totalMarketplaceFee,
          // Denormalized fields
          dateSold: order.creationDate,
          shipByDate: lineItem.lineItemFulfillmentInstructions?.shipByDate,
          estimatedDelivery: lineItem.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate,
          productName: lineItem.title,
          itemNumber: lineItem.legacyItemId,
          buyerAddress: buyerAddr,
          shippingFullName: shipTo.fullName || '',
          shippingAddressLine1: shipTo.contactAddress?.addressLine1 || '',
          shippingAddressLine2: shipTo.contactAddress?.addressLine2 || '',
          shippingCity: shipTo.contactAddress?.city || '',
          shippingState: shipTo.contactAddress?.stateOrProvince || '',
          shippingPostalCode: shipTo.contactAddress?.postalCode || '',
          shippingCountry: shipTo.contactAddress?.countryCode || '',
          shippingPhone: '0000000000',
          quantity: lineItem.quantity,
          subtotal: parseFloat(order.pricingSummary?.priceSubtotal?.value || 0),
          salesTax: parseFloat(lineItem.ebayCollectAndRemitTaxes?.[0]?.amount?.value || 0),
          discount: parseFloat(order.pricingSummary?.priceDiscount?.value || 0),
          shipping: parseFloat(order.pricingSummary?.deliveryCost?.value || 0),
          transactionFees: parseFloat(order.totalMarketplaceFee?.value || 0),
          adFee: parseFloat(lineItem.appliedPromotions?.[0]?.discountAmount?.value || 0),
          cancelState: order.cancelStatus?.cancelState || 'NONE_REQUESTED',
          refunds: order.paymentSummary?.refunds || [],
          trackingNumber: trackingNumber,
          purchaseMarketplaceId: purchaseMarketplaceId
        },
        { upsert: true, new: true }
      );
    }

    // Return orders from database
    const dbOrders = await Order.find({ seller: seller._id }).sort({ creationDate: -1 }).limit(200);
    res.json({ orders: dbOrders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New endpoint: Get orders with any cancellation status
router.get('/cancelled-orders', async (req, res) => {
  try {
    const { startDate, endDate, sellerId, marketplace, page = 1, limit = 50 } = req.query;

    console.log(`[Cancelled Orders] Fetching all cancellation orders`);

    // Build query for cancellation states
    const query = {
      cancelState: { $in: ['CANCEL_REQUESTED', 'IN_PROGRESS', 'CANCELED', 'CANCELLED'] }
    };

    // Add filters
    if (sellerId) {
      query.seller = sellerId;
    }

    if (marketplace) {
      // Handle the Canada edge case if consistent with other endpoints, otherwise exact match
      query.purchaseMarketplaceId = marketplace;
    }

    // Add date filter if provided (using PST timezone logic like other endpoints)
    if (startDate || endDate) {
      query.dateSold = {};
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

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Get total count for pagination
    const totalCount = await Order.countDocuments(query);
    const totalPages = Math.ceil(totalCount / limitNum);

    const cancelledOrders = await Order.find(query)
      .populate({
        path: 'seller',
        populate: {
          path: 'user',
          select: 'username email'
        }
      })
      .sort({ creationDate: -1 })
      .skip(skip)
      .limit(limitNum);

    console.log(`[Cancelled Orders] Found ${cancelledOrders.length} cancellation orders (page ${pageNum}/${totalPages})`);

    res.json({
      orders: cancelledOrders,
      totalOrders: totalCount,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalOrders: totalCount,
        limit: limitNum
      }
    });
  } catch (err) {
    console.error('[Cancelled Orders] Error:', err);
    res.status(500).json({ error: err.message });
  }
});




// Get a single order by orderId
router.get('/order/:orderId', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  const { orderId } = req.params;

  try {
    const order = await Order.findOne({ orderId })
      .populate({
        path: 'seller',
        populate: {
          path: 'user',
          select: 'username email'
        }
      });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(order);
  } catch (err) {
    console.error('[Get Order] Error:', err);
    res.status(500).json({ error: err.message });
  }
});


// Get stored orders from database with pagination support
router.get('/stored-orders', async (req, res) => {
  const { sellerId, page = 1, limit = 50, searchOrderId, searchBuyerName, searchItemId, searchMarketplace, paymentStatus, startDate, endDate, awaitingShipment, hasFulfillmentNotes, amazonArriving, arrivalSort, amazonAccount, arrivalStartDate, arrivalEndDate } = req.query;

  try {
    let query = {};
    if (sellerId) {
      query.seller = sellerId;
    }

    // --- Awaiting Shipment Filter ---
    if (awaitingShipment === 'true') {
      // Condition 1: Must NOT have a tracking number
      query.$or = [
        { trackingNumber: { $exists: false } },
        { trackingNumber: null },
        { trackingNumber: '' }
      ];

      // Condition 2: Include orders with no cancellation OR with IN_PROGRESS cancellation
      // IN_PROGRESS means buyer requested cancel but seller hasn't responded yet
      // These still need attention (either ship or cancel)
      query.cancelState = { $in: ['NONE_REQUESTED', 'IN_PROGRESS', null, ''] };
    }

    // --- Has Fulfillment Notes Filter ---
    if (hasFulfillmentNotes === 'true') {
      query.fulfillmentNotes = { $exists: true, $nin: ['', null] };
    }

    // --- Amazon Arrivals Filter ---
    if (amazonArriving === 'true') {
      // Only show orders with arrivingDate in ISO format (YYYY-MM-DD)
      query.arrivingDate = {
        $exists: true,
        $ne: null,
        $ne: '',
        $regex: /^\d{4}-\d{2}-\d{2}/ // Only ISO formatted dates
      };

      // Optional arrival date range filter (string compare is safe for YYYY-MM-DD)
      if (arrivalStartDate || arrivalEndDate) {
        if (arrivalStartDate) query.arrivingDate.$gte = arrivalStartDate;
        if (arrivalEndDate) query.arrivingDate.$lte = arrivalEndDate;
      }
    }

    // Amazon Account Filter
    if (amazonAccount && amazonAccount !== '') {
      query.amazonAccount = amazonAccount;
    }

    // Apply search filters
    if (searchOrderId) {
      // Strict Order ID search (ignores legacyOrderId)
      query.orderId = { $regex: searchOrderId, $options: 'i' };
    }

    if (searchBuyerName) {
      query['buyer.buyerRegistrationAddress.fullName'] = { $regex: searchBuyerName, $options: 'i' };
    }

    // Item ID search (searches both lineItems.legacyItemId and itemNumber)
    if (searchItemId) {
      query.$or = [
        { 'lineItems.legacyItemId': { $regex: searchItemId, $options: 'i' } },
        { itemNumber: { $regex: searchItemId, $options: 'i' } }
      ];
    }

    // Timezone-Aware Date Range Logic
    if (startDate || endDate) {
      query.dateSold = {};
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

    if (searchMarketplace && searchMarketplace !== '') {
      query.purchaseMarketplaceId = searchMarketplace === 'EBAY_ENCA' ? 'EBAY_CA' : searchMarketplace;
    }

    // Payment Status Filter
    if (paymentStatus && paymentStatus !== '') {
      query.orderPaymentStatus = paymentStatus;
    }

    // Ship By Date Filter
    if (req.query.shipByDate) {
      const shipByDate = req.query.shipByDate;
      const PST_OFFSET_HOURS = 8;

      // Start of ship-by date in UTC (midnight PST = 8am UTC)
      const startOfDay = new Date(shipByDate);
      startOfDay.setUTCHours(PST_OFFSET_HOURS, 0, 0, 0);

      // End of ship-by date in UTC (11:59:59 PM PST = 7:59:59 AM UTC next day)
      const endOfDay = new Date(shipByDate);
      endOfDay.setDate(endOfDay.getDate() + 1);
      endOfDay.setUTCHours(PST_OFFSET_HOURS - 1, 59, 59, 999);

      query.shipByDate = { $gte: startOfDay, $lte: endOfDay };
    }

    // Exclude Low Value Orders (less than $3)
    if (req.query.excludeLowValue === 'true') {
      // Filter orders where subtotal or subtotalUSD is >= 3
      // Check both fields since some orders may have one or the other
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { subtotalUSD: { $gte: 3 } },
          { subtotal: { $gte: 3 } }
        ]
      });
    }

    // Calculate pagination
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const totalOrders = await Order.countDocuments(query);
    const totalPages = Math.ceil(totalOrders / limitNum);

    const orders = await Order.find(query)
      .populate({
        path: 'seller',
        populate: {
          path: 'user',
          select: 'username email'
        }
      })
      // Sorting: ShipBy Date for awaiting (Oldest First), Arriving Date for Amazon Arrivals, Creation Date otherwise (Newest First)
      .sort(
        awaitingShipment === 'true'
          ? { shipByDate: 1 }
          : amazonArriving === 'true'
            ? { arrivingDate: arrivalSort === 'desc' ? -1 : 1 }
            : { creationDate: -1 }
      )
      .skip(skip)
      .limit(limitNum);

    console.log(`[Stored Orders] Query: ${JSON.stringify(query)}, Page: ${pageNum}/${totalPages}, Found ${orders.length}/${totalOrders} orders`);

    res.json({
      orders,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalOrders,
        ordersPerPage: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// HELPER: Get Exchange Rate for Date
// ============================================
async function getExchangeRateForDate(date, marketplace = 'EBAY') {
  try {
    const targetDate = new Date(date);

    // Find the most recent rate that was effective on or before the target date
    const rate = await ExchangeRate.findOne({
      marketplace,
      effectiveDate: { $lte: targetDate }
    })
      .sort({ effectiveDate: -1 })
      .limit(1);

    // Default to 82 if no rate found
    return rate ? rate.rate : 82;
  } catch (err) {
    console.error('Error fetching exchange rate:', err);
    return 82; // Default fallback
  }
}

// NEW ENDPOINT: All Orders with USD conversion
router.get('/all-orders-usd', async (req, res) => {
  const { sellerId, page = 1, limit = 50, searchOrderId, searchBuyerName, searchMarketplace, startDate, endDate, excludeCancelled } = req.query;

  try {
    let query = {};
    if (sellerId) {
      query.seller = sellerId;
    }

    // Exclude cancelled orders if requested
    if (excludeCancelled === 'true') {
      query.$and = [
        {
          $or: [
            { cancelState: { $exists: false } },
            { cancelState: null },
            { cancelState: { $nin: ['CANCELED', 'CANCELLED'] } }
          ]
        },
        {
          $or: [
            { 'cancelStatus.cancelState': { $exists: false } },
            { 'cancelStatus.cancelState': null },
            { 'cancelStatus.cancelState': { $nin: ['CANCELED', 'CANCELLED'] } }
          ]
        }
      ];
    }

    // Apply search filters
    if (searchOrderId) {
      query.orderId = { $regex: searchOrderId, $options: 'i' };
    }

    if (searchBuyerName) {
      query['buyer.buyerRegistrationAddress.fullName'] = { $regex: searchBuyerName, $options: 'i' };
    }

    // Timezone-Aware Date Range Logic
    if (startDate || endDate) {
      query.dateSold = {};
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

    if (searchMarketplace && searchMarketplace !== '') {
      query.purchaseMarketplaceId = searchMarketplace === 'EBAY_ENCA' ? 'EBAY_CA' : searchMarketplace;
    }

    // Calculate pagination
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const totalOrders = await Order.countDocuments(query);
    const totalPages = Math.ceil(totalOrders / limitNum);

    const orders = await Order.find(query)
      .populate({
        path: 'seller',
        populate: {
          path: 'user',
          select: 'username email'
        }
      })
      .sort({ creationDate: -1 })
      .skip(skip)
      .limit(limitNum);

    // Fallback: Calculate USD values on-the-fly if missing, and add exchange rate + P.Balance
    const ordersWithUSD = await Promise.all(orders.map(async order => {
      const orderObj = order.toObject();

      // If USD values don't exist, calculate them
      if (orderObj.subtotalUSD === undefined || orderObj.subtotalUSD === null) {
        const marketplace = orderObj.purchaseMarketplaceId;

        if (marketplace === 'EBAY_US') {
          // US orders - already in USD
          orderObj.subtotalUSD = orderObj.subtotal || 0;
          orderObj.shippingUSD = orderObj.shipping || 0;
          orderObj.salesTaxUSD = orderObj.salesTax || 0;
          orderObj.discountUSD = orderObj.discount || 0;
          orderObj.transactionFeesUSD = orderObj.transactionFees || 0;
          orderObj.conversionRate = 1;
        } else {
          // Non-US orders - calculate from paymentSummary
          let conversionRate = 0;

          if (orderObj.paymentSummary?.totalDueSeller?.convertedFromValue &&
            orderObj.paymentSummary?.totalDueSeller?.value) {
            const originalValue = parseFloat(orderObj.paymentSummary.totalDueSeller.convertedFromValue);
            const usdValue = parseFloat(orderObj.paymentSummary.totalDueSeller.value);
            if (originalValue > 0) {
              conversionRate = usdValue / originalValue;
            }
          }

          // Apply conversion with proper rounding (2 decimal places)
          orderObj.subtotalUSD = conversionRate ? parseFloat(((orderObj.subtotal || 0) * conversionRate).toFixed(2)) : 0;
          orderObj.shippingUSD = conversionRate ? parseFloat(((orderObj.shipping || 0) * conversionRate).toFixed(2)) : 0;
          orderObj.salesTaxUSD = conversionRate ? parseFloat(((orderObj.salesTax || 0) * conversionRate).toFixed(2)) : 0;
          orderObj.discountUSD = conversionRate ? parseFloat(((orderObj.discount || 0) * conversionRate).toFixed(2)) : 0;
          orderObj.transactionFeesUSD = conversionRate ? parseFloat(((orderObj.transactionFees || 0) * conversionRate).toFixed(2)) : 0;
          orderObj.conversionRate = parseFloat(conversionRate.toFixed(5));
        }
      }

      // ALWAYS recalculate refunds from paymentSummary.refunds (in case refunds were added after initial sync)
      let refundTotal = 0;
      if (orderObj.paymentSummary?.refunds && Array.isArray(orderObj.paymentSummary.refunds)) {
        refundTotal = orderObj.paymentSummary.refunds.reduce((sum, refund) => {
          return sum + parseFloat(refund.amount?.value || 0);
        }, 0);
      }
      const conversionRate = orderObj.conversionRate || 1;
      orderObj.refundTotalUSD = parseFloat((refundTotal * conversionRate).toFixed(2));

      // Get exchange rates for order's date (USD to INR)
      const ebayExchangeRate = await getExchangeRateForDate(orderObj.dateSold || orderObj.creationDate, 'EBAY');
      const amazonExchangeRate = await getExchangeRateForDate(orderObj.dateSold || orderObj.creationDate, 'AMAZON');
      orderObj.exchangeRate = ebayExchangeRate;
      orderObj.amazonExchangeRate = amazonExchangeRate;

      // Calculate NET and P.Balance
      // NET = Subtotal - TransactionFees - AdFeeGeneral - Refunds - TDS - T.ID + Discount
      const total = (orderObj.subtotalUSD || 0) + (orderObj.salesTaxUSD || 0);
      const tds = total * 0.01; // 1% of Total
      const tid = 0.24;
      const net = (orderObj.subtotalUSD || 0)
        - (orderObj.transactionFeesUSD || 0)
        - (orderObj.adFeeGeneral || 0)
        - orderObj.refundTotalUSD
        - tds
        - tid
        + (orderObj.discountUSD || 0);

      orderObj.pBalance = parseFloat((net * orderObj.exchangeRate).toFixed(2));

      return orderObj;
    }));

    console.log(`[All Orders USD] Query: ${JSON.stringify(query)}, Page: ${pageNum}/${totalPages}, Found ${orders.length}/${totalOrders} orders`);

    res.json({
      orders: ordersWithUSD,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalOrders,
        ordersPerPage: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1
      }
    });
  } catch (err) {
    console.error('[All Orders USD] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Test endpoint to check Finances API basic connectivity (no filter)
router.get('/test-finances-basic', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  const { sellerId } = req.query;

  if (!sellerId) {
    return res.status(400).json({ error: 'sellerId query param is required' });
  }

  try {
    const seller = await Seller.findById(sellerId);
    if (!seller || !seller.ebayTokens?.access_token) {
      return res.status(400).json({ error: 'Seller not found or not connected to eBay' });
    }

    const accessToken = await ensureValidToken(seller);

    console.log(`[Test Finances Basic] Testing API without filter...`);

    // Try WITHOUT any filter first
    const response = await axios.get(
      `https://apiz.ebay.com/sell/finances/v1/transaction`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
        },
        params: {
          limit: 10
        }
      }
    );

    console.log(`[Test Finances Basic] Success! Found ${response.data?.transactions?.length || 0} transactions`);

    // Show first transaction for debugging
    const firstTxn = response.data?.transactions?.[0];

    res.json({
      success: true,
      total: response.data?.total || 0,
      transactionCount: response.data?.transactions?.length || 0,
      firstTransaction: firstTxn,
      allTransactionTypes: [...new Set((response.data?.transactions || []).map(t => t.transactionType))]
    });

  } catch (error) {
    console.error(`[Test Finances Basic] Error:`, error.response?.data || error.message);
    console.error(`[Test Finances Basic] Status:`, error.response?.status);
    res.status(error.response?.status || 500).json({
      error: error.message,
      ebayError: error.response?.data,
      status: error.response?.status
    });
  }
});

// Test endpoint to check Finances API for a single order
router.get('/test-finances/:orderId', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  const { orderId } = req.params;
  const { sellerId } = req.query;

  if (!sellerId) {
    return res.status(400).json({ error: 'sellerId query param is required' });
  }

  try {
    const seller = await Seller.findById(sellerId);
    if (!seller || !seller.ebayTokens?.access_token) {
      return res.status(400).json({ error: 'Seller not found or not connected to eBay' });
    }

    const accessToken = await ensureValidToken(seller);

    // Make direct API call to see raw response
    const filterValue = `orderId:{${orderId}}`;
    console.log(`[Test Finances] Testing order: ${orderId}`);
    console.log(`[Test Finances] Filter: ${filterValue}`);

    const response = await axios.get(
      `https://apiz.ebay.com/sell/finances/v1/transaction`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
        },
        params: {
          filter: filterValue,
          limit: 50
        }
      }
    );

    console.log(`[Test Finances] Full response:`, JSON.stringify(response.data, null, 2));

    res.json({
      orderId,
      filter: filterValue,
      rawResponse: response.data,
      transactionCount: response.data?.transactions?.length || 0
    });

  } catch (error) {
    console.error(`[Test Finances] Error:`, error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: error.message,
      ebayError: error.response?.data,
      status: error.response?.status
    });
  }
});

// Update ad fee general for an order
router.patch('/orders/:orderId/ad-fee-general', async (req, res) => {
  const { orderId } = req.params;
  const { adFeeGeneral } = req.body;

  if (adFeeGeneral === undefined || adFeeGeneral === null) {
    return res.status(400).json({ error: 'Missing adFeeGeneral value' });
  }

  try {
    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update ad fee
    order.adFeeGeneral = parseFloat(adFeeGeneral);

    // Recalculate earnings if not FULLY_REFUNDED or PARTIALLY_REFUNDED
    const paymentStatus = order.paymentSummary?.payments?.[0]?.paymentStatus;
    if (paymentStatus !== 'FULLY_REFUNDED' && paymentStatus !== 'PARTIALLY_REFUNDED') {
      // Recalculate earnings: Subtotal + Shipping - Transaction Fees - Ad Fees
      const subtotal = parseFloat(order.subtotalUSD) || 0;
      const shipping = parseFloat(order.shippingUSD) || 0;
      const transactionFees = parseFloat(order.transactionFeesUSD) || 0;
      const adFee = parseFloat(adFeeGeneral) || 0;

      order.orderEarnings = parseFloat((subtotal + shipping - transactionFees - adFee).toFixed(2));

      // Recalculate financial fields based on new earnings
      const marketplace = order.purchaseMarketplaceId === 'EBAY_ENCA' ? 'EBAY_CA' :
        order.purchaseMarketplaceId === 'EBAY_AU' ? 'EBAY_AU' : 'EBAY';
      const financials = await calculateFinancials(order, marketplace);

      // Update financial fields
      Object.assign(order, financials);
    }

    // Recalculate Amazon financials
    const amazonFinancials = await calculateAmazonFinancials(order);
    Object.assign(order, amazonFinancials);

    await order.save();

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get count of orders needing ad fee backfill
router.get('/backfill-ad-fees/count', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  const { sellerId, sinceDate } = req.query;

  if (!sellerId) {
    return res.status(400).json({ error: 'sellerId is required' });
  }

  try {
    let query = { seller: sellerId };

    if (sinceDate) {
      query.creationDate = { $gte: new Date(sinceDate) };
    }

    // Count orders without adFeeGeneral
    const needsBackfill = await Order.countDocuments({
      ...query,
      $or: [
        { adFeeGeneral: { $exists: false } },
        { adFeeGeneral: null },
        { adFeeGeneral: 0 }
      ]
    });

    const totalOrders = await Order.countDocuments(query);
    const alreadyHasAdFee = totalOrders - needsBackfill;

    res.json({
      totalOrders,
      needsBackfill,
      alreadyHasAdFee
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update order earnings for partially refunded orders
router.post('/orders/:orderId/update-earnings', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { orderEarnings } = req.body;

    if (orderEarnings === undefined || orderEarnings === null) {
      return res.status(400).json({ error: 'orderEarnings is required' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update order earnings
    order.orderEarnings = parseFloat(orderEarnings);

    // Recalculate financial fields (TDS, TID, NET, P.Balance INR)
    const marketplace = order.purchaseMarketplaceId === 'EBAY_ENCA' ? 'EBAY_CA' :
      order.purchaseMarketplaceId === 'EBAY_AU' ? 'EBAY_AU' : 'EBAY';
    const financials = await calculateFinancials({ orderEarnings: order.orderEarnings }, marketplace);

    // Apply financial calculations
    order.tds = financials.tds;
    order.tid = financials.tid;
    order.net = financials.net;
    order.pBalanceINR = financials.pBalanceINR;
    order.ebayExchangeRate = financials.ebayExchangeRate;

    await order.save();

    res.json({
      success: true,
      orderId,
      orderEarnings: order.orderEarnings,
      tds: order.tds,
      tid: order.tid,
      net: order.net,
      pBalanceINR: order.pBalanceINR,
      ebayExchangeRate: order.ebayExchangeRate
    });
  } catch (err) {
    console.error('Error updating order earnings:', err);
    res.status(500).json({ error: err.message });
  }
});

// Handle Amazon refund received - zero out Amazon costs
router.post('/orders/:orderId/amazon-refund-received', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc'), async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Zero out Amazon costs
    order.beforeTaxUSD = 0;
    order.estimatedTaxUSD = 0;

    // Recalculate Amazon financial fields (will all become 0)
    const amazonFinancials = await calculateAmazonFinancials(order);
    order.amazonTotal = amazonFinancials.amazonTotal;
    order.amazonTotalINR = amazonFinancials.amazonTotalINR;
    order.marketplaceFee = amazonFinancials.marketplaceFee;
    order.igst = amazonFinancials.igst;
    order.totalCC = amazonFinancials.totalCC;
    order.amazonExchangeRate = amazonFinancials.amazonExchangeRate;

    await order.save();

    res.json({
      success: true,
      orderId,
      beforeTaxUSD: order.beforeTaxUSD,
      estimatedTaxUSD: order.estimatedTaxUSD,
      amazonTotal: order.amazonTotal,
      amazonTotalINR: order.amazonTotalINR,
      marketplaceFee: order.marketplaceFee,
      igst: order.igst,
      totalCC: order.totalCC,
      amazonExchangeRate: order.amazonExchangeRate
    });
  } catch (err) {
    console.error('Error handling Amazon refund received:', err);
    res.status(500).json({ error: err.message });
  }
});

// Backfill ad fees from eBay Finances API for orders since a given date
router.post('/backfill-ad-fees', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  const { sellerId, sinceDate, skipAlreadySet = true } = req.body;

  if (!sellerId) {
    return res.status(400).json({ error: 'sellerId is required' });
  }

  try {
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    if (!seller.ebayTokens || !seller.ebayTokens.access_token) {
      return res.status(400).json({ error: 'Seller not connected to eBay' });
    }

    // Ensure we have a valid token
    const accessToken = await ensureValidToken(seller);

    // Build query for orders
    let query = { seller: sellerId };
    const effectiveSinceDate = sinceDate ? new Date(sinceDate) : new Date('2025-11-01');
    query.creationDate = { $gte: effectiveSinceDate };

    // Optionally skip orders that already have adFeeGeneral set
    if (skipAlreadySet) {
      query.$or = [
        { adFeeGeneral: { $exists: false } },
        { adFeeGeneral: null },
        { adFeeGeneral: 0 }
      ];
    }

    // Get ALL orders to process (no limit)
    const orders = await Order.find(query).sort({ creationDate: -1 });

    console.log(`[Backfill Ad Fees] Found ${orders.length} orders to process for seller ${seller.username || seller._id}`);

    if (orders.length === 0) {
      return res.json({
        message: 'No orders found to backfill',
        results: { total: 0, success: 0, failed: 0, skipped: 0, errors: [] }
      });
    }

    // STEP 1: Fetch ALL ad fees from eBay in one batch (much more efficient!)
    console.log(`[Backfill Ad Fees] Fetching all ad fees since ${effectiveSinceDate.toISOString()}...`);
    const adFeeResult = await fetchAllAdFees(accessToken, effectiveSinceDate);

    if (!adFeeResult.success) {
      return res.status(500).json({ error: `Failed to fetch ad fees: ${adFeeResult.error}` });
    }

    const adFeeMap = adFeeResult.adFeeMap;
    console.log(`[Backfill Ad Fees] Found ${adFeeMap.size} ad fee transactions from eBay`);

    const results = {
      total: orders.length,
      success: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };

    // STEP 2: Match orders to ad fees and update
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      try {
        const adFee = adFeeMap.get(order.orderId);

        if (adFee && adFee > 0) {
          // Update ad fee and recalculate earnings if it's a PAID order
          const updates = { adFeeGeneral: adFee };

          if (order.orderPaymentStatus === 'PAID') {
            // Recalculate earnings with new ad fee
            const subtotal = parseFloat(order.subtotalUSD || 0);
            const discount = parseFloat(order.discountUSD || 0);
            const salesTax = parseFloat(order.salesTaxUSD || 0);
            const transactionFees = parseFloat(order.transactionFeesUSD || 0);
            const shipping = parseFloat(order.shippingUSD || 0);

            const newEarnings = parseFloat((subtotal + discount - salesTax - transactionFees - adFee - shipping).toFixed(2));
            updates.orderEarnings = newEarnings;

            // Recalculate financial fields
            const marketplace = order.purchaseMarketplaceId === 'EBAY_ENCA' ? 'EBAY_CA' :
              order.purchaseMarketplaceId === 'EBAY_AU' ? 'EBAY_AU' : 'EBAY';
            const financials = await calculateFinancials({ orderEarnings: newEarnings }, marketplace);
            Object.assign(updates, financials);
          }

          await Order.findByIdAndUpdate(order._id, updates);
          results.success++;
          console.log(`[Backfill ${i + 1}/${orders.length}] Order ${order.orderId}: Ad Fee = $${adFee}`);
        } else {
          results.skipped++;
          console.log(`[Backfill ${i + 1}/${orders.length}] Order ${order.orderId}: No ad fee found`);
        }
      } catch (orderErr) {
        results.failed++;
        if (results.errors.length < 10) {
          results.errors.push({ orderId: order.orderId, error: orderErr.message });
        }
        console.log(`[Backfill ${i + 1}/${orders.length}] Order ${order.orderId}: Exception - ${orderErr.message}`);
      }
    }

    res.json({
      message: `Backfill complete: ${results.success} updated, ${results.skipped} no ad fee, ${results.failed} failed`,
      results
    });

  } catch (err) {
    console.error('[Backfill Ad Fees] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update manual tracking number for an order (does NOT affect fulfillment tracking)
router.patch('/orders/:orderId/manual-tracking', async (req, res) => {
  const { orderId } = req.params;
  const { manualTrackingNumber } = req.body;

  if (manualTrackingNumber === undefined || manualTrackingNumber === null) {
    return res.status(400).json({ error: 'Missing manualTrackingNumber value' });
  }

  try {
    const order = await Order.findByIdAndUpdate(
      orderId,
      { manualTrackingNumber: String(manualTrackingNumber) },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload tracking number to eBay and mark order as shipped
router.post('/orders/:orderId/upload-tracking', async (req, res) => {
  const { orderId } = req.params;
  const { trackingNumber, shippingCarrier = 'USPS' } = req.body;

  if (!trackingNumber || !trackingNumber.trim()) {
    return res.status(400).json({ error: 'Missing tracking number' });
  }

  try {
    // Find the order in our database
    const order = await Order.findById(orderId).populate('seller');

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!order.seller) {
      return res.status(400).json({ error: 'Seller not found for this order' });
    }

    // Ensure seller has valid eBay token
    await ensureValidToken(order.seller);

    if (!order.seller.ebayTokens?.access_token) {
      return res.status(400).json({ error: 'Seller does not have valid eBay access token' });
    }

    // Get the eBay orderId (not our MongoDB _id)
    const ebayOrderId = order.orderId || order.legacyOrderId;
    if (!ebayOrderId) {
      return res.status(400).json({ error: 'Order missing eBay order ID' });
    }

    // Get the line item ID (eBay requires this for fulfillment)
    const lineItemId = order.lineItems?.[0]?.lineItemId;
    if (!lineItemId) {
      return res.status(400).json({ error: 'Order missing line item ID' });
    }

    // Prepare the fulfillment payload
    const fulfillmentPayload = {
      lineItems: [
        {
          lineItemId: lineItemId,
          quantity: order.lineItems[0].quantity || 1
        }
      ],
      shippedDate: new Date().toISOString(),
      shippingCarrierCode: shippingCarrier.toUpperCase(),
      trackingNumber: trackingNumber.trim()
    };

    console.log(`[Upload Tracking] Uploading tracking for order ${ebayOrderId}:`, fulfillmentPayload);

    // Upload tracking to eBay Fulfillment API
    const fulfillmentResponse = await axios.post(
      `https://api.ebay.com/sell/fulfillment/v1/order/${ebayOrderId}/shipping_fulfillment`,
      fulfillmentPayload,
      {
        headers: {
          'Authorization': `Bearer ${order.seller.ebayTokens.access_token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    console.log(`[Upload Tracking] ✅ eBay API accepted tracking upload:`, fulfillmentResponse.data);

    // 4. CHECK FOR WARNINGS (Early Detection)
    if (fulfillmentResponse.data?.warnings?.length > 0) {
      console.warn(`[Upload Tracking] ⚠️ eBay returned warnings:`, JSON.stringify(fulfillmentResponse.data.warnings));
      // If warning indicates a problem (but not an error), we should proceed with verification CAREFULLY
    }

    // 5. SMART POLLING VERIFICATION (Speed Upgrade)
    // Instead of waiting 7 seconds blindly, we check immediately and then retry a few times.
    console.log(`[Upload Tracking] Verifying tracking was applied (Smart Polling)...`);

    let isVerified = false;
    let verifiedOrder = null;

    // Polling Schedule: 0s, 1s, 2s, 4s, 7s (Total ~7-8s max wait, but usually instant)
    const delays = [100, 1000, 1000, 2000, 3000];

    for (const delay of delays) {
      if (delay > 100) await new Promise(r => setTimeout(r, delay));

      try {
        const verifyRes = await axios.get(
          `https://api.ebay.com/sell/fulfillment/v1/order/${ebayOrderId}`,
          {
            headers: {
              'Authorization': `Bearer ${order.seller.ebayTokens.access_token}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            }
          }
        );

        const data = verifyRes.data;
        const hasFulfillmentHrefs = data.fulfillmentHrefs && data.fulfillmentHrefs.length > 0;
        const isFulfilled = data.orderFulfillmentStatus === 'FULFILLED';

        // Check specifically if OUR tracking number is present
        // (Sometimes order is fulfilled but with an old tracking number)
        // We verify if fulfillmentHrefs are present, which implies SOME tracking exists.
        // Deep verification of the exact number is hard without following the hrefs, 
        // but status=FULFILLED + hasHrefs is usually strong enough.

        if (isFulfilled && hasFulfillmentHrefs) {
          verifiedOrder = data;
          isVerified = true;
          console.log(`[Upload Tracking] ✅ Verified successfully after ~${delay}ms`);
          break; // Exit loop immediately on success
        }
      } catch (err) {
        console.warn(`[Upload Tracking] Verification attempt failed: ${err.message}`);
      }
    }

    // STRICT VALIDATION: Only save to DB if eBay confirmed tracking was applied
    if (!isVerified || !verifiedOrder) {
      console.error(`[Upload Tracking] ⚠️ Tracking NOT applied after polling attempts!`);

      // REJECT - Do NOT update database
      return res.status(400).json({
        error: 'Tracking number was rejected by eBay (Verification Failed). This tracking number may already be in use for another order.',
        errorType: 'TRACKING_NOT_APPLIED',
        details: {
          suggestion: 'Please verify the tracking number is correct and not a duplicate.'
        }
      });
    }

    console.log(`[Upload Tracking] ✅ VERIFIED: Tracking successfully applied to eBay order`);

    // UPDATE DATABASE: Only save when eBay confirms success
    order.trackingNumber = trackingNumber.trim();
    order.manualTrackingNumber = trackingNumber.trim();
    order.orderFulfillmentStatus = 'FULFILLED';

    await order.save();

    console.log(`[Upload Tracking] 💾 Database updated successfully for order ${ebayOrderId}`);

    res.json({
      success: true,
      message: `Tracking uploaded to eBay via ${shippingCarrier}! Order marked as shipped.`,
      order,
      ebayResponse: fulfillmentResponse.data
    });

  } catch (err) {
    console.error('[Upload Tracking] ❌ Error:', err.response?.data || err.message);

    // Provide detailed error message with specific handling for common issues
    let errorMessage = 'Failed to upload tracking to eBay';
    let errorType = 'UPLOAD_ERROR';

    if (err.response?.data?.errors) {
      const errors = err.response.data.errors;
      errorMessage = errors.map(e => e.message).join(', ');

      // Check for specific error types
      const errorString = JSON.stringify(errors).toLowerCase();
      if (errorString.includes('tracking') || errorString.includes('invalid')) {
        errorType = 'INVALID_TRACKING';
        errorMessage = '❌ ' + errorMessage + '\n\nPlease verify:\n- Tracking number format is correct\n- Carrier selection matches the tracking number\n- Tracking number is not already used for another order';
      } else if (errorString.includes('already') || errorString.includes('fulfilled')) {
        errorType = 'ALREADY_FULFILLED';
        errorMessage = 'This order is already marked as fulfilled on eBay';
      } else if (errorString.includes('authorization') || errorString.includes('token')) {
        errorType = 'AUTH_ERROR';
        errorMessage = 'eBay authorization error. Please reconnect your eBay account';
      }
    } else if (err.response?.data?.message) {
      errorMessage = err.response.data.message;
    } else if (err.message) {
      errorMessage = err.message;
    }

    // Log detailed error for debugging
    console.error('[Upload Tracking] Error Details:', {
      errorType,
      errorMessage,
      ebayResponse: err.response?.data,
      statusCode: err.response?.status
    });

    res.status(err.response?.status || 500).json({
      error: errorMessage,
      errorType,
      details: err.response?.data || err.message,
      statusCode: err.response?.status
    });
  }
});

// Upload multiple tracking numbers to eBay (for orders with multiple different items)
router.post('/orders/:orderId/upload-tracking-multiple', async (req, res) => {
  const { orderId } = req.params;
  const { trackingData, shippingCarrier = 'USPS' } = req.body;
  // trackingData format: [{ itemId: '12345', trackingNumber: 'ABC123', carrier: 'USPS' }, ...]

  if (!trackingData || !Array.isArray(trackingData) || trackingData.length === 0) {
    return res.status(400).json({ error: 'Missing tracking data array' });
  }

  // Validate all tracking numbers are provided
  const missingTracking = trackingData.some(item => !item.trackingNumber?.trim());
  if (missingTracking) {
    return res.status(400).json({ error: 'All items must have tracking numbers' });
  }

  try {
    // Find the order in our database
    const order = await Order.findById(orderId).populate('seller');

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!order.seller) {
      return res.status(400).json({ error: 'Seller not found for this order' });
    }

    // Ensure seller has valid eBay token
    await ensureValidToken(order.seller);

    if (!order.seller.ebayTokens?.access_token) {
      return res.status(400).json({ error: 'Seller does not have valid eBay access token' });
    }

    // Get the eBay orderId
    const ebayOrderId = order.orderId || order.legacyOrderId;
    if (!ebayOrderId) {
      return res.status(400).json({ error: 'Order missing eBay order ID' });
    }

    console.log(`[Upload Multiple Tracking] Processing ${trackingData.length} tracking numbers for order ${ebayOrderId}`);

    // Group line items by tracking number
    // eBay allows one fulfillment per tracking number, so we create separate fulfillments
    const fulfillmentResults = [];
    const errors = [];

    for (let i = 0; i < trackingData.length; i++) {
      const { itemId, trackingNumber, carrier } = trackingData[i];

      // Find matching line item(s) with this itemId
      const matchingLineItems = order.lineItems.filter(li => li.legacyItemId === itemId);

      if (matchingLineItems.length === 0) {
        errors.push(`Item ${itemId} not found in order`);
        continue;
      }

      // Create fulfillment payload for this tracking number
      const fulfillmentPayload = {
        lineItems: matchingLineItems.map(li => ({
          lineItemId: li.lineItemId,
          quantity: li.quantity || 1
        })),
        shippedDate: new Date().toISOString(),
        shippingCarrierCode: (carrier || shippingCarrier).toUpperCase(),
        trackingNumber: trackingNumber.trim()
      };

      console.log(`[Upload Multiple Tracking] Uploading tracking #${i + 1}:`, fulfillmentPayload);

      try {
        // Upload to eBay
        const fulfillmentResponse = await axios.post(
          `https://api.ebay.com/sell/fulfillment/v1/order/${ebayOrderId}/shipping_fulfillment`,
          fulfillmentPayload,
          {
            headers: {
              'Authorization': `Bearer ${order.seller.ebayTokens.access_token}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            }
          }
        );

        console.log(`[Upload Multiple Tracking] ✅ Tracking #${i + 1} accepted by eBay`);
        fulfillmentResults.push({
          itemId,
          trackingNumber: trackingNumber.trim(),
          status: 'success',
          response: fulfillmentResponse.data
        });

      } catch (err) {
        console.error(`[Upload Multiple Tracking] ❌ Error uploading tracking #${i + 1}:`, err.response?.data || err.message);

        const errorMsg = err.response?.data?.errors?.map(e => e.message).join(', ') || err.message;
        errors.push(`Item ${itemId}: ${errorMsg}`);

        fulfillmentResults.push({
          itemId,
          trackingNumber: trackingNumber.trim(),
          status: 'error',
          error: errorMsg
        });
      }
    }

    // If ALL uploads failed, return error
    if (errors.length === trackingData.length) {
      return res.status(400).json({
        error: 'All tracking uploads failed',
        details: errors,
        results: fulfillmentResults
      });
    }

    // Verify fulfillment status after uploads
    console.log(`[Upload Multiple Tracking] Verifying order status...`);
    await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds for eBay to process

    try {
      const verifyRes = await axios.get(
        `https://api.ebay.com/sell/fulfillment/v1/order/${ebayOrderId}`,
        {
          headers: {
            'Authorization': `Bearer ${order.seller.ebayTokens.access_token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      const verifiedOrder = verifyRes.data;
      const isFulfilled = verifiedOrder.orderFulfillmentStatus === 'FULFILLED';

      // Update database with first tracking number (for display purposes)
      // Store all tracking numbers in a comma-separated format or JSON
      const allTrackingNumbers = trackingData.map(t => t.trackingNumber.trim()).join(', ');

      order.trackingNumber = allTrackingNumbers;
      order.manualTrackingNumber = allTrackingNumbers;
      order.orderFulfillmentStatus = isFulfilled ? 'FULFILLED' : order.orderFulfillmentStatus;

      await order.save();

      console.log(`[Upload Multiple Tracking] 💾 Database updated with ${trackingData.length} tracking numbers`);

      res.json({
        success: true,
        message: `${fulfillmentResults.filter(r => r.status === 'success').length} tracking numbers uploaded successfully`,
        partialSuccess: errors.length > 0,
        results: fulfillmentResults,
        errors: errors.length > 0 ? errors : undefined,
        order
      });

    } catch (verifyErr) {
      console.warn(`[Upload Multiple Tracking] ⚠️ Verification failed:`, verifyErr.message);

      // Still update DB even if verification fails (tracking was uploaded)
      const allTrackingNumbers = trackingData.map(t => t.trackingNumber.trim()).join(', ');
      order.trackingNumber = allTrackingNumbers;
      order.manualTrackingNumber = allTrackingNumbers;
      await order.save();

      res.json({
        success: true,
        message: `${fulfillmentResults.filter(r => r.status === 'success').length} tracking numbers uploaded (verification pending)`,
        partialSuccess: errors.length > 0,
        results: fulfillmentResults,
        errors: errors.length > 0 ? errors : undefined,
        verificationWarning: 'Could not verify order status immediately',
        order
      });
    }

  } catch (err) {
    console.error('[Upload Multiple Tracking] ❌ Fatal Error:', err.response?.data || err.message);

    res.status(err.response?.status || 500).json({
      error: 'Failed to upload tracking numbers',
      details: err.response?.data || err.message,
      statusCode: err.response?.status
    });
  }
});

// Poll all sellers for new/updated orders with smart detection (PARALLEL + UTC-based)
router.post('/poll-all-sellers', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'compliancemanager', 'hoc'), async (req, res) => {
  try {
    // Helper function to normalize dates for comparison (ignore milliseconds/format)
    function normalizeDateForComparison(date) {
      if (!date) return null;
      if (date instanceof Date) {
        return Math.floor(date.getTime() / 1000); // Unix timestamp in seconds
      }
      if (typeof date === 'string') {
        return Math.floor(new Date(date).getTime() / 1000);
      }
      return null;
    }

    // Helper function to check if field actually changed
    function hasFieldChanged(oldValue, newValue, fieldName) {
      // Skip system fields
      const systemFields = ['_id', '__v', 'seller', 'updatedAt', 'createdAt'];
      if (systemFields.includes(fieldName)) return false;

      // Date fields - compare Unix timestamps (ignore milliseconds)
      const dateFields = ['creationDate', 'lastModifiedDate', 'dateSold', 'shipByDate', 'estimatedDelivery'];
      if (dateFields.includes(fieldName)) {
        const oldTime = normalizeDateForComparison(oldValue);
        const newTime = normalizeDateForComparison(newValue);
        return oldTime !== newTime;
      }

      // Null/undefined checks
      if (oldValue === null || oldValue === undefined) {
        return newValue !== null && newValue !== undefined;
      }

      // Objects/Arrays - deep comparison
      if (typeof newValue === 'object' && newValue !== null) {
        return JSON.stringify(oldValue) !== JSON.stringify(newValue);
      }

      // Primitives - direct comparison
      return oldValue !== newValue;
    }

    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true, $ne: null } })
      .populate('user', 'username email');

    if (sellers.length === 0) {
      return res.json({
        message: 'No sellers with connected eBay accounts found',
        pollResults: [],
        totalPolled: 0,
        totalNewOrders: 0,
        totalUpdatedOrders: 0
      });
    }

    // Calculate 30 days ago in UTC
    const nowUTC = Date.now();
    const thirtyDaysAgoMs = 30 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = new Date(nowUTC - thirtyDaysAgoMs);

    console.log(`\n========== POLLING ${sellers.length} SELLERS IN PARALLEL ==========`);
    console.log(`UTC Time: ${new Date(nowUTC).toISOString()}`);
    console.log(`30-day window starts: ${thirtyDaysAgo.toISOString()}`);

    // Process all sellers in parallel using Promise.allSettled
    const pollingPromises = sellers.map(async (seller) => {
      const sellerName = seller.user?.username || seller.user?.email || seller._id.toString();

      try {
        console.log(`\n[${sellerName}] Starting poll...`);

        // ========== TOKEN REFRESH CHECK ==========
        const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
        const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
        let accessToken = seller.ebayTokens.access_token;

        if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
          console.log(`[${sellerName}] Token expired, refreshing...`);
          try {
            const refreshRes = await axios.post(
              'https://api.ebay.com/identity/v1/oauth2/token',
              qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: seller.ebayTokens.refresh_token,
                scope: EBAY_OAUTH_SCOPES, // Using centralized scopes constant
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
                },
              }
            );
            seller.ebayTokens.access_token = refreshRes.data.access_token;
            seller.ebayTokens.expires_in = refreshRes.data.expires_in;
            seller.ebayTokens.fetchedAt = new Date(nowUTC);
            await seller.save();
            accessToken = refreshRes.data.access_token;
            console.log(`[${sellerName}] Token refreshed`);
          } catch (refreshErr) {
            console.error(`[${sellerName}] Token refresh failed:`, refreshErr.message);
            return {
              sellerId: seller._id,
              sellerName,
              success: false,
              error: 'Failed to refresh token'
            };
          }
        }

        // ========== DETERMINE POLLING STRATEGY ==========
        const orderCount = await Order.countDocuments({ seller: seller._id });
        const latestOrder = await Order.findOne({ seller: seller._id }).sort({ creationDate: -1 });
        const latestCreationDate = latestOrder ? latestOrder.creationDate : null;
        const lastPolledAt = seller.lastPolledAt || null;
        // Default initial sync date: Nov 1, 2025 00:00:00 UTC
        const initialSyncDate = seller.initialSyncDate || new Date(Date.UTC(2025, 10, 1, 0, 0, 0, 0));

        console.log(`[${sellerName}] Orders in DB: ${orderCount}, Latest: ${latestCreationDate?.toISOString() || 'NONE'}, LastPolled: ${lastPolledAt?.toISOString() || 'NEVER'}`);

        const newOrders = [];
        const updatedOrders = [];
        // Use 5-second buffer for clock skew (UTC-based)
        const currentTimeUTC = new Date(nowUTC - 5000);

        // ========== PHASE 1: FETCH NEW ORDERS ==========
        let newOrdersFilter = null;
        let newOrdersLimit = 15;

        if (orderCount === 0) {
          // First sync: get orders from Oct 17, 2025 onwards (UTC)
          newOrdersFilter = `creationdate:[${initialSyncDate.toISOString()}..${currentTimeUTC.toISOString()}]`;
          newOrdersLimit = 200;
          console.log(`[${sellerName}] PHASE 1: Initial sync from ${initialSyncDate.toISOString()}`);
        } else if (latestCreationDate) {
          // Subsequent syncs: fetch orders created after our latest order
          const afterLatestMs = new Date(latestCreationDate).getTime() + 1000; // +1 sec
          const afterLatest = new Date(afterLatestMs);
          const timeDiffMinutes = (currentTimeUTC.getTime() - afterLatestMs) / (1000 * 60);

          if (timeDiffMinutes >= 1) {
            newOrdersFilter = `creationdate:[${afterLatest.toISOString()}..${currentTimeUTC.toISOString()}]`;
            newOrdersLimit = 200;
            console.log(`[${sellerName}] PHASE 1: New orders after ${afterLatest.toISOString()}`);
          } else {
            console.log(`[${sellerName}] PHASE 1: Skipped (too recent: ${timeDiffMinutes.toFixed(2)} min)`);
          }
        }

        // Fetch new orders if filter is set
        if (newOrdersFilter) {
          try {
            // Use pagination to fetch ALL orders (handles >200 orders)
            const ebayNewOrders = await fetchAllOrdersWithPagination(accessToken, newOrdersFilter, sellerName);
            console.log(`[${sellerName}] PHASE 1: Got ${ebayNewOrders.length} new orders from eBay`);

            // Insert new orders
            for (const ebayOrder of ebayNewOrders) {
              const existingOrder = await Order.findOne({ orderId: ebayOrder.orderId });

              if (!existingOrder) {
                const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);
                const policyEligibleAt = getPolicyEligibilityDate(orderData.creationDate);
                if (policyEligibleAt) {
                  orderData.policyMessageEligibleAt = policyEligibleAt;
                }
                const newOrder = await Order.create(orderData);
                newOrders.push(newOrder);
                console.log(`  🆕 NEW: ${ebayOrder.orderId}`);
                await sendAutoWelcomeMessage(seller, newOrder);
              } else {
                // Order exists, check if needs update
                const ebayModTime = new Date(ebayOrder.lastModifiedDate).getTime();
                const dbModTime = new Date(existingOrder.lastModifiedDate).getTime();

                if (ebayModTime > dbModTime) {
                  let orderData = await buildOrderData(ebayOrder, seller._id, accessToken);

                  // ========== HANDLE REFUND STATUS CHANGES ==========
                  const refundData = await handleOrderPaymentStatusChange(
                    existingOrder,
                    ebayOrder.orderPaymentStatus,
                    accessToken,
                    seller._id
                  );

                  // If refund handling returned data, merge it
                  if (refundData) {
                    orderData = { ...orderData, ...refundData };

                    // Also calculate and add refund breakdown for partially refunded orders
                    if (ebayOrder.orderPaymentStatus === 'PARTIALLY_REFUNDED') {
                      const refundBreakdown = calculateRefundBreakdown(ebayOrder);
                      orderData.refundItemAmount = refundBreakdown.refundItemAmount;
                      orderData.refundTaxAmount = refundBreakdown.refundTaxAmount;
                      orderData.refundTotalToBuyer = refundBreakdown.refundTotalToBuyer;
                      orderData.ebayPaidTaxRefund = refundBreakdown.ebayPaidTaxRefund;
                    }
                  }

                  Object.assign(existingOrder, orderData);
                  await existingOrder.save();
                  updatedOrders.push(existingOrder);
                  console.log(`  🔄 UPDATED: ${ebayOrder.orderId}`);
                }
              }
            }
          } catch (phase1Err) {
            console.error(`[${sellerName}] PHASE 1 error:`, phase1Err.message);
          }
        }

        // ========== PHASE 2: CHECK FOR UPDATES ON RECENT ORDERS ==========
        console.log(`[${sellerName}] PHASE 2: Checking orders < 30 days old`);

        const recentOrders = await Order.find({
          seller: seller._id,
          creationDate: { $gte: thirtyDaysAgo }
        }).select('orderId lastModifiedDate creationDate');

        console.log(`[${sellerName}] PHASE 2: ${recentOrders.length} orders < 30 days old`);

        if (recentOrders.length > 0) {
          const checkFromDate = lastPolledAt || thirtyDaysAgo;
          const modifiedFilter = `lastmodifieddate:[${checkFromDate.toISOString()}..${currentTimeUTC.toISOString()}]`;

          console.log(`[${sellerName}] PHASE 2: Checking mods since ${checkFromDate.toISOString()}`);

          let offset = 0;
          const batchSize = 100;
          let hasMore = true;
          const recentOrderIdSet = new Set(recentOrders.map(o => o.orderId));

          while (hasMore) {
            try {
              const phase2Res = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                },
                params: {
                  filter: modifiedFilter,
                  limit: batchSize,
                  offset: offset > 0 ? offset : undefined
                }
              });

              const batchOrders = phase2Res.data.orders || [];
              console.log(`[${sellerName}] PHASE 2: Got ${batchOrders.length} orders at offset ${offset}`);

              const relevantOrders = batchOrders.filter(o => recentOrderIdSet.has(o.orderId));
              console.log(`[${sellerName}] PHASE 2: ${relevantOrders.length} relevant`);

              for (const ebayOrder of relevantOrders) {
                const existingOrder = await Order.findOne({
                  orderId: ebayOrder.orderId,
                  seller: seller._id
                });

                if (existingOrder) {
                  const ebayModTime = new Date(ebayOrder.lastModifiedDate).getTime();
                  const dbModTime = new Date(existingOrder.lastModifiedDate).getTime();

                  // OPTIMIZATION: Skip if not actually modified
                  if (ebayModTime <= dbModTime) {
                    continue; // No changes, skip this order
                  }

                  // ONLY NOW fetch full order data (includes expensive tracking lookup)
                  let orderData = await buildOrderData(ebayOrder, seller._id, accessToken);

                  // ========== HANDLE REFUND STATUS CHANGES ==========
                  // Check if payment status changed to FULLY_REFUNDED or PARTIALLY_REFUNDED
                  const refundData = await handleOrderPaymentStatusChange(
                    existingOrder,
                    ebayOrder.orderPaymentStatus,
                    accessToken,
                    seller._id
                  );

                  // If refund handling returned data, merge it with orderData
                  if (refundData) {
                    orderData = { ...orderData, ...refundData };

                    // Also calculate and add refund breakdown for partially refunded orders
                    if (ebayOrder.orderPaymentStatus === 'PARTIALLY_REFUNDED') {
                      const refundBreakdown = calculateRefundBreakdown(ebayOrder);
                      orderData.refundItemAmount = refundBreakdown.refundItemAmount;
                      orderData.refundTaxAmount = refundBreakdown.refundTaxAmount;
                      orderData.refundTotalToBuyer = refundBreakdown.refundTotalToBuyer;
                      orderData.ebayPaidTaxRefund = refundBreakdown.ebayPaidTaxRefund;
                    }
                  }

                  // Define fields that should trigger notifications
                  const notifiableFields = [
                    'cancelState',
                    'orderPaymentStatus',
                    'refunds',
                    'orderFulfillmentStatus',
                    'trackingNumber',
                    'shippingFullName',
                    'shippingAddressLine1',
                    'shippingAddressLine2',
                    'shippingCity',
                    'shippingState',
                    'shippingPostalCode',
                    'shippingCountry'
                    // NOTE: buyerCheckoutNotes is NOT included - updates DB silently
                  ];

                  // Detect changed fields with smart comparison
                  const changedFields = [];
                  for (const key of Object.keys(orderData)) {
                    if (hasFieldChanged(existingOrder[key], orderData[key], key)) {
                      changedFields.push(key);
                    }
                  }

                  // Filter to only notifiable fields (exclude lastModifiedDate)
                  const notifiableChanges = changedFields.filter(f =>
                    notifiableFields.includes(f) && f !== 'lastModifiedDate'
                  );

                  // Always save ALL changes to DB (even non-notifiable)
                  Object.assign(existingOrder, orderData);
                  await existingOrder.save();

                  // Only add to notification list if there are notifiable changes
                  if (notifiableChanges.length > 0) {
                    // Check if shipping address changed
                    const shippingFields = ['shippingFullName', 'shippingAddressLine1', 'shippingCity', 'shippingState', 'shippingPostalCode'];
                    const shippingChanged = notifiableChanges.some(f => shippingFields.includes(f));

                    if (shippingChanged) {
                      console.log(`  🏠 SHIPPING ADDRESS CHANGED: ${ebayOrder.orderId}`);
                    }

                    updatedOrders.push({
                      orderId: existingOrder.orderId,
                      changedFields: notifiableChanges
                    });
                    console.log(`  🔔 NOTIFY: ${ebayOrder.orderId} - ${notifiableChanges.join(', ')}`);
                  } else {
                    // Changes were made but not notifiable (e.g., buyerCheckoutNotes, dates, etc.)
                    console.log(`  ✅ UPDATED (silent): ${ebayOrder.orderId} - ${changedFields.join(', ')}`);
                  }
                }
              }

              // EARLY EXIT
              if (batchOrders.length < batchSize) {
                hasMore = false;
                console.log(`[${sellerName}] PHASE 2: Early exit`);
              } else {
                offset += batchSize;
              }
            } catch (phase2Err) {
              console.error(`[${sellerName}] PHASE 2 error:`, phase2Err.message);
              hasMore = false;
            }
          }
        }

        // ========== UPDATE SELLER METADATA ==========
        seller.lastPolledAt = new Date(nowUTC);
        await seller.save();
        console.log(`[${sellerName}] ✅ Complete: ${newOrders.length} new, ${updatedOrders.length} updated`);

        return {
          sellerId: seller._id,
          sellerName,
          success: true,
          newOrders: newOrders.map(o => o.orderId),
          updatedOrders, // Now contains { orderId, changedFields }
          totalNew: newOrders.length,
          totalUpdated: updatedOrders.length
        };

      } catch (sellerErr) {
        console.error(`[${sellerName}] ❌ Error:`, sellerErr.message);
        return {
          sellerId: seller._id,
          sellerName,
          success: false,
          error: sellerErr.message
        };
      }
    });

    // Wait for all sellers to complete (parallel execution)
    const results = await Promise.allSettled(pollingPromises);

    // Process results
    const pollResults = results.map(result => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          success: false,
          error: result.reason?.message || 'Unknown error'
        };
      }
    });

    const totalNewOrders = pollResults.reduce((sum, r) => sum + (r.totalNew || 0), 0);
    const totalUpdatedOrders = pollResults.reduce((sum, r) => sum + (r.totalUpdated || 0), 0);

    res.json({
      message: 'Polling complete',
      pollResults,
      totalPolled: sellers.length,
      totalNewOrders,
      totalUpdatedOrders
    });

    // Trigger delayed policy messaging in background after polling
    processPendingPolicyMessages(50)
      .then((r) => {
        if (r.processed > 0) {
          console.log(`[PolicyMessage] Background run: processed=${r.processed}, sent=${r.sent}, failed=${r.failed}`);
        }
      })
      .catch((e) => console.error('[PolicyMessage] Background run failed:', e.message));

    console.log('\n========== POLLING SUMMARY ==========');
    console.log(`Total sellers polled: ${sellers.length}`);
    console.log(`Total new orders: ${totalNewOrders}`);
    console.log(`Total updated orders: ${totalUpdatedOrders}`);

  } catch (err) {
    console.error('Error polling all sellers:', err);
    res.status(500).json({ error: err.message });
  }
});

// Poll all sellers for NEW ORDERS ONLY (Phase 1)
router.post('/poll-new-orders', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'compliancemanager', 'hoc'), async (req, res) => {
  try {
    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true, $ne: null } })
      .populate('user', 'username email');

    if (sellers.length === 0) {
      return res.json({
        message: 'No sellers with connected eBay accounts found',
        pollResults: [],
        totalPolled: 0,
        totalNewOrders: 0
      });
    }

    const nowUTC = Date.now();
    console.log(`\n========== POLLING NEW ORDERS FOR ${sellers.length} SELLERS ==========`);
    console.log(`UTC Time: ${new Date(nowUTC).toISOString()}`);

    const pollingPromises = sellers.map(async (seller) => {
      const sellerName = seller.user?.username || seller.user?.email || seller._id.toString();

      try {
        console.log(`\n[${sellerName}] Checking for new orders...`);

        // Token refresh
        const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
        const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
        let accessToken = seller.ebayTokens.access_token;

        if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
          console.log(`[${sellerName}] Refreshing token...`);
          const refreshRes = await axios.post(
            'https://api.ebay.com/identity/v1/oauth2/token',
            qs.stringify({
              grant_type: 'refresh_token',
              refresh_token: seller.ebayTokens.refresh_token,
              scope: EBAY_OAUTH_SCOPES, // Using centralized scopes constant
            }),
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
              },
            }
          );
          seller.ebayTokens.access_token = refreshRes.data.access_token;
          seller.ebayTokens.expires_in = refreshRes.data.expires_in;
          seller.ebayTokens.fetchedAt = new Date(nowUTC);
          await seller.save();
          accessToken = refreshRes.data.access_token;
        }

        const orderCount = await Order.countDocuments({ seller: seller._id });
        const latestOrder = await Order.findOne({ seller: seller._id }).sort({ creationDate: -1 });
        const latestCreationDate = latestOrder ? latestOrder.creationDate : null;
        // Default initial sync date: Nov 1, 2025 00:00:00 UTC
        const initialSyncDate = seller.initialSyncDate || new Date(Date.UTC(2025, 10, 1, 0, 0, 0, 0));
        // Use current time without buffer - Render's servers have accurate NTP sync
        const currentTimeUTC = new Date(nowUTC);

        const newOrders = [];
        let newOrdersFilter = null;
        let newOrdersLimit = 15;

        if (orderCount === 0) {
          newOrdersFilter = `creationdate:[${initialSyncDate.toISOString()}..${currentTimeUTC.toISOString()}]`;
          newOrdersLimit = 200;
          console.log(`[${sellerName}] Initial sync from ${initialSyncDate.toISOString()}`);
        } else if (latestCreationDate) {
          const afterLatestMs = new Date(latestCreationDate).getTime() + 1000;
          const afterLatest = new Date(afterLatestMs);
          const timeDiffMinutes = (currentTimeUTC.getTime() - afterLatestMs) / (1000 * 60);

          if (timeDiffMinutes >= 1) {
            newOrdersFilter = `creationdate:[${afterLatest.toISOString()}..${currentTimeUTC.toISOString()}]`;
            newOrdersLimit = 200;
            console.log(`[${sellerName}] Checking new orders after ${afterLatest.toISOString()}`);
          } else {
            console.log(`[${sellerName}] Skipped (too recent: ${timeDiffMinutes.toFixed(2)} min)`);
          }
        }

        if (newOrdersFilter) {
          // Use pagination to fetch ALL orders (handles >200 orders)
          const ebayNewOrders = await fetchAllOrdersWithPagination(accessToken, newOrdersFilter, sellerName);
          console.log(`[${sellerName}] Found ${ebayNewOrders.length} new orders`);

          for (const ebayOrder of ebayNewOrders) {
            const existingOrder = await Order.findOne({ orderId: ebayOrder.orderId });

            if (!existingOrder) {
              const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);
              const policyEligibleAt = getPolicyEligibilityDate(orderData.creationDate);
              if (policyEligibleAt) {
                orderData.policyMessageEligibleAt = policyEligibleAt;
              }
              const newOrder = await Order.create(orderData);
              newOrders.push(newOrder);
              console.log(`  🆕 NEW: ${ebayOrder.orderId}`);
              await sendAutoWelcomeMessage(seller, newOrder);

              // Fetch ad fee from eBay Finances API
              try {
                const adFeeResult = await fetchOrderAdFee(accessToken, ebayOrder.orderId);
                if (adFeeResult.success && adFeeResult.adFeeGeneral > 0) {
                  await Order.findByIdAndUpdate(newOrder._id, { adFeeGeneral: adFeeResult.adFeeGeneral });
                  console.log(`  💰 Ad Fee: $${adFeeResult.adFeeGeneral} for ${ebayOrder.orderId}`);
                }
              } catch (adFeeErr) {
                console.log(`  ⚠️ Ad fee fetch failed for ${ebayOrder.orderId}: ${adFeeErr.message}`);
              }
            }
          }
        }

        console.log(`[${sellerName}] ✅ Complete: ${newOrders.length} new orders`);

        return {
          sellerId: seller._id,
          sellerName,
          success: true,
          newOrders: newOrders.map(o => o.orderId),
          totalNew: newOrders.length
        };

      } catch (sellerErr) {
        console.error(`[${sellerName}] ❌ Error:`, sellerErr.message);
        return {
          sellerId: seller._id,
          sellerName,
          success: false,
          error: sellerErr.message
        };
      }
    });

    const results = await Promise.allSettled(pollingPromises);
    const pollResults = results.map(result => result.status === 'fulfilled' ? result.value : { success: false, error: result.reason?.message || 'Unknown error' });
    const totalNewOrders = pollResults.reduce((sum, r) => sum + (r.totalNew || 0), 0);

    res.json({
      message: 'New orders polling complete',
      pollResults,
      totalPolled: sellers.length,
      totalNewOrders
    });

    // Trigger delayed policy messaging in background after polling
    processPendingPolicyMessages(50)
      .then((r) => {
        if (r.processed > 0) {
          console.log(`[PolicyMessage] Background run: processed=${r.processed}, sent=${r.sent}, failed=${r.failed}`);
        }
      })
      .catch((e) => console.error('[PolicyMessage] Background run failed:', e.message));

    console.log(`\n========== NEW ORDERS SUMMARY ==========`);
    console.log(`Total new orders: ${totalNewOrders}`);

  } catch (err) {
    console.error('Error polling new orders:', err);
    res.status(500).json({ error: err.message });
  }
});

// ONE-TIME RESYNC: Re-fetch orders from Dec 1, 2025 8AM UTC with USD conversion
router.post('/resync-from-dec1', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  try {
    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true, $ne: null } })
      .populate('user', 'username email');

    if (!sellers || sellers.length === 0) {
      return res.status(404).json({ error: 'No sellers found with eBay tokens' });
    }

    console.log(`\n========== RESYNC FROM DEC 1, 2025 FOR ${sellers.length} SELLERS ==========`);

    const resyncStartDate = new Date('2025-12-01T08:00:00.000Z');
    const currentTimeUTC = new Date();

    const results = {
      totalOrders: 0,
      newOrders: 0,
      updatedOrders: 0,
      errors: [],
      sellerResults: []
    };

    for (const seller of sellers) {
      const sellerName = seller.user?.username || seller.businessName || seller._id;

      try {
        console.log(`\n[${sellerName}] Starting resync from Dec 1, 2025...`);

        const accessToken = await ensureValidToken(seller);

        // Fetch orders from Dec 1, 2025 8AM UTC to now
        const filter = `creationdate:[${resyncStartDate.toISOString()}..${currentTimeUTC.toISOString()}]`;
        console.log(`[${sellerName}] Filter: ${filter}`);

        const ebayOrders = await fetchAllOrdersWithPagination(accessToken, filter, sellerName);
        console.log(`[${sellerName}] Fetched ${ebayOrders.length} orders from eBay`);

        let newCount = 0;
        let updateCount = 0;

        for (const ebayOrder of ebayOrders) {
          try {
            // Build order data with USD conversion
            const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);

            // Check if order exists in DB
            const existingOrder = await Order.findOne({ orderId: ebayOrder.orderId });

            if (existingOrder) {
              // Update existing order, preserve Amazon details
              await Order.updateOne(
                { orderId: ebayOrder.orderId },
                {
                  $set: {
                    // Update eBay data
                    lastModifiedDate: orderData.lastModifiedDate,
                    orderFulfillmentStatus: orderData.orderFulfillmentStatus,
                    orderPaymentStatus: orderData.orderPaymentStatus,
                    pricingSummary: orderData.pricingSummary,
                    cancelStatus: orderData.cancelStatus,
                    paymentSummary: orderData.paymentSummary,
                    lineItems: orderData.lineItems,
                    fulfillmentHrefs: orderData.fulfillmentHrefs,
                    // Update USD fields
                    subtotalUSD: orderData.subtotalUSD,
                    salesTaxUSD: orderData.salesTaxUSD,
                    discountUSD: orderData.discountUSD,
                    shippingUSD: orderData.shippingUSD,
                    transactionFeesUSD: orderData.transactionFeesUSD,
                    refundTotalUSD: orderData.refundTotalUSD,
                    // Update denormalized fields
                    subtotal: orderData.subtotal,
                    salesTax: orderData.salesTax,
                    discount: orderData.discount,
                    shipping: orderData.shipping,
                    transactionFees: orderData.transactionFees,
                    cancelState: orderData.cancelState,
                    refunds: orderData.refunds,
                    trackingNumber: orderData.trackingNumber || existingOrder.trackingNumber
                    // Amazon fields NOT updated (amazonAccount, beforeTax, etc.)
                  }
                }
              );
              updateCount++;
            } else {
              // Create new order
              await Order.create(orderData);
              newCount++;
            }
          } catch (err) {
            console.error(`[${sellerName}] Error processing order ${ebayOrder.orderId}:`, err.message);
            results.errors.push({ seller: sellerName, orderId: ebayOrder.orderId, error: err.message });
          }
        }

        console.log(`[${sellerName}] ✅ New: ${newCount}, Updated: ${updateCount}`);

        results.totalOrders += ebayOrders.length;
        results.newOrders += newCount;
        results.updatedOrders += updateCount;
        results.sellerResults.push({
          seller: sellerName,
          total: ebayOrders.length,
          new: newCount,
          updated: updateCount
        });

      } catch (err) {
        console.error(`[${sellerName}] ❌ Error:`, err.message);
        results.errors.push({ seller: sellerName, error: err.message });
      }
    }

    console.log('\n========== RESYNC COMPLETE ==========');
    console.log(`Total Orders Processed: ${results.totalOrders}`);
    console.log(`New Orders: ${results.newOrders}`);
    console.log(`Updated Orders: ${results.updatedOrders}`);
    console.log(`Errors: ${results.errors.length}`);

    res.json({
      success: true,
      message: 'Resync from Dec 1, 2025 completed',
      results
    });

  } catch (err) {
    console.error('Error in resync:', err);
    res.status(500).json({ error: err.message });
  }
});

// Poll all sellers for ORDER UPDATES ONLY (Phase 2)
router.post('/poll-order-updates', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'compliancemanager', 'hoc'), async (req, res) => {
  try {
    // Helper function to normalize dates for comparison (ignore milliseconds/format)
    function normalizeDateForComparison(date) {
      if (!date) return null;
      if (date instanceof Date) {
        return Math.floor(date.getTime() / 1000); // Unix timestamp in seconds
      }
      if (typeof date === 'string') {
        return Math.floor(new Date(date).getTime() / 1000);
      }
      return null;
    }

    // Helper function to check if field actually changed
    function hasFieldChanged(oldValue, newValue, fieldName) {
      // Skip system fields
      const systemFields = ['_id', '__v', 'seller', 'updatedAt', 'createdAt'];
      if (systemFields.includes(fieldName)) return false;

      // Date fields - compare Unix timestamps (ignore milliseconds)
      const dateFields = ['creationDate', 'lastModifiedDate', 'dateSold', 'shipByDate', 'estimatedDelivery'];
      if (dateFields.includes(fieldName)) {
        const oldTime = normalizeDateForComparison(oldValue);
        const newTime = normalizeDateForComparison(newValue);
        return oldTime !== newTime;
      }

      // Null/undefined checks
      if (oldValue === null || oldValue === undefined) {
        return newValue !== null && newValue !== undefined;
      }

      // Objects/Arrays - deep comparison
      if (typeof newValue === 'object' && newValue !== null) {
        return JSON.stringify(oldValue) !== JSON.stringify(newValue);
      }

      // Primitives - direct comparison
      return oldValue !== newValue;
    }

    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true, $ne: null } })
      .populate('user', 'username email');

    if (sellers.length === 0) {
      return res.json({
        message: 'No sellers with connected eBay accounts found',
        pollResults: [],
        totalPolled: 0,
        totalUpdatedOrders: 0
      });
    }

    const nowUTC = Date.now();
    const thirtyDaysAgoMs = 30 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = new Date(nowUTC - thirtyDaysAgoMs);

    console.log(`\n========== POLLING ORDER UPDATES FOR ${sellers.length} SELLERS ==========`);
    console.log(`UTC Time: ${new Date(nowUTC).toISOString()}`);
    console.log(`Checking orders from: ${thirtyDaysAgo.toISOString()}`);

    const pollingPromises = sellers.map(async (seller) => {
      const sellerName = seller.user?.username || seller.user?.email || seller._id.toString();

      try {
        console.log(`\n[${sellerName}] Checking for order updates...`);

        // ✅ STEP 1: Find latest lastModifiedDate from DB for THIS SELLER
        const latestOrder = await Order.findOne({
          seller: seller._id,
          lastModifiedDate: { $exists: true, $ne: null }
        })
          .sort({ lastModifiedDate: -1 })
          .select('lastModifiedDate orderId')
          .lean();

        let sinceDate;

        if (latestOrder && latestOrder.lastModifiedDate) {
          // Use latest lastModifiedDate from DB
          sinceDate = new Date(latestOrder.lastModifiedDate);
          console.log(`[${sellerName}] Latest order: ${latestOrder.orderId}`);
          console.log(`[${sellerName}] Latest lastModifiedDate: ${sinceDate.toISOString()}`);
        } else {
          // No orders yet - use initialSyncDate or 30 days ago
          sinceDate = seller.initialSyncDate || thirtyDaysAgo;
          console.log(`[${sellerName}] No existing orders - using: ${sinceDate.toISOString()}`);
        }

        // Ensure we don't go beyond 30 days
        if (sinceDate < thirtyDaysAgo) {
          sinceDate = thirtyDaysAgo;
          console.log(`[${sellerName}] Capped to 30-day limit`);
        }

        // Token refresh
        const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
        const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
        let accessToken = seller.ebayTokens.access_token;

        if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
          console.log(`[${sellerName}] Refreshing token...`);
          const refreshRes = await axios.post(
            'https://api.ebay.com/identity/v1/oauth2/token',
            qs.stringify({
              grant_type: 'refresh_token',
              refresh_token: seller.ebayTokens.refresh_token,
              scope: EBAY_OAUTH_SCOPES, // Using centralized scopes constant
            }),
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
              },
            }
          );
          seller.ebayTokens.access_token = refreshRes.data.access_token;
          seller.ebayTokens.expires_in = refreshRes.data.expires_in;
          seller.ebayTokens.fetchedAt = new Date(nowUTC);
          await seller.save();
          accessToken = refreshRes.data.access_token;
        }

        // ✅ STEP 2: Fetch orders from eBay with lastModifiedDate >= sinceDate
        const toDate = new Date(nowUTC);
        const modifiedFilter = `lastmodifieddate:[${sinceDate.toISOString()}..${toDate.toISOString()}]`;

        console.log(`[${sellerName}] Filter: ${modifiedFilter}`);
        const updatedOrders = [];

        const recentOrders = await Order.find({
          seller: seller._id,
          creationDate: { $gte: thirtyDaysAgo }
        }).select('orderId lastModifiedDate creationDate');

        console.log(`[${sellerName}] ${recentOrders.length} orders < 30 days old`);

        if (recentOrders.length > 0) {

          let offset = 0;
          const batchSize = 100;
          let hasMore = true;
          const recentOrderIdSet = new Set(recentOrders.map(o => o.orderId));

          while (hasMore) {
            const phase2Res = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              params: {
                filter: modifiedFilter,
                limit: batchSize,
                offset: offset > 0 ? offset : undefined
              }
            });

            const batchOrders = phase2Res.data.orders || [];
            console.log(`[${sellerName}] Got ${batchOrders.length} orders at offset ${offset}`);

            const relevantOrders = batchOrders.filter(o => recentOrderIdSet.has(o.orderId));

            for (const ebayOrder of relevantOrders) {
              const existingOrder = await Order.findOne({
                orderId: ebayOrder.orderId,
                seller: seller._id
              });

              if (existingOrder) {
                const ebayModTime = new Date(ebayOrder.lastModifiedDate).getTime();
                const dbModTime = new Date(existingOrder.lastModifiedDate).getTime();

                // OPTIMIZATION: Skip if not actually modified
                if (ebayModTime <= dbModTime) {
                  continue; // No changes, skip this order
                }

                // ONLY NOW fetch full order data (includes expensive tracking lookup)
                const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);



                // Detect changed fields with smart comparison
                const changedFields = [];
                for (const key of Object.keys(orderData)) {
                  if (hasFieldChanged(existingOrder[key], orderData[key], key)) {
                    changedFields.push(key);
                  }
                }



                // Always save ALL changes to DB (even non-notifiable)
                Object.assign(existingOrder, orderData);
                await existingOrder.save();

                // Fetch ad fee if not already set
                if (!existingOrder.adFeeGeneral || existingOrder.adFeeGeneral === 0) {
                  try {
                    const adFeeResult = await fetchOrderAdFee(accessToken, ebayOrder.orderId);
                    if (adFeeResult.success && adFeeResult.adFeeGeneral > 0) {
                      existingOrder.adFeeGeneral = adFeeResult.adFeeGeneral;
                      existingOrder.adFeeGeneralUSD = parseFloat((adFeeResult.adFeeGeneral * (existingOrder.conversionRate || 1)).toFixed(2));

                      // Recalculate orderEarnings if this is a PAID order
                      if (existingOrder.orderPaymentStatus === 'PAID') {
                        const subtotal = parseFloat(existingOrder.subtotalUSD || 0);
                        const discount = parseFloat(existingOrder.discountUSD || 0);
                        const salesTax = parseFloat(existingOrder.salesTaxUSD || 0);
                        const transactionFees = parseFloat(existingOrder.transactionFeesUSD || 0);
                        const adFee = parseFloat(existingOrder.adFeeGeneralUSD || 0);
                        const shipping = parseFloat(existingOrder.shippingUSD || 0);
                        existingOrder.orderEarnings = parseFloat((subtotal + discount - salesTax - transactionFees - adFee - shipping).toFixed(2));

                        // Recalculate financial fields (TDS, TID, NET, P.Balance INR)
                        const marketplace = existingOrder.purchaseMarketplaceId === 'EBAY_ENCA' ? 'EBAY_CA' :
                          existingOrder.purchaseMarketplaceId === 'EBAY_AU' ? 'EBAY_AU' : 'EBAY';
                        const financials = await calculateFinancials({ orderEarnings: existingOrder.orderEarnings }, marketplace);
                        existingOrder.tds = financials.tds;
                        existingOrder.tid = financials.tid;
                        existingOrder.net = financials.net;
                        existingOrder.pBalanceINR = financials.pBalanceINR;

                        console.log(`  💰 Ad Fee: $${adFeeResult.adFeeGeneral} - Recalculated earnings: $${existingOrder.orderEarnings}`);
                      } else {
                        console.log(`  💰 Ad Fee: $${adFeeResult.adFeeGeneral} for ${ebayOrder.orderId}`);
                      }

                      await existingOrder.save();
                    }
                  } catch (adFeeErr) {
                    console.log(`  ⚠️ Ad fee fetch failed for ${ebayOrder.orderId}: ${adFeeErr.message}`);
                  }
                }

                // Add to list if there are ANY changes
                if (changedFields.length > 0) {
                  // Check if shipping address changed
                  const shippingFields = ['shippingFullName', 'shippingAddressLine1', 'shippingCity', 'shippingState', 'shippingPostalCode'];
                  const shippingChanged = changedFields.some(f => shippingFields.includes(f));

                  if (shippingChanged) {
                    console.log(`  🏠 SHIPPING ADDRESS CHANGED: ${ebayOrder.orderId}`);
                  }

                  updatedOrders.push({
                    orderId: existingOrder.orderId,
                    changedFields: changedFields
                  });
                  console.log(`  🔔 NOTIFY: ${ebayOrder.orderId} - ${changedFields.join(', ')}`);
                }
              }
            }

            if (batchOrders.length < batchSize) {
              hasMore = false;
            } else {
              offset += batchSize;
            }
          }
        }

        console.log(`[${sellerName}] ✅ Complete: ${updatedOrders.length} updated`);

        return {
          sellerId: seller._id,
          sellerName,
          success: true,
          updatedOrders, // Now contains { orderId, changedFields }
          totalUpdated: updatedOrders.length
        };

      } catch (sellerErr) {
        console.error(`[${sellerName}] ❌ Error:`, sellerErr.message);
        return {
          sellerId: seller._id,
          sellerName,
          success: false,
          error: sellerErr.message
        };
      }
    });

    const results = await Promise.allSettled(pollingPromises);
    const pollResults = results.map(result => result.status === 'fulfilled' ? result.value : { success: false, error: result.reason?.message || 'Unknown error' });
    const totalUpdatedOrders = pollResults.reduce((sum, r) => sum + (r.totalUpdated || 0), 0);

    res.json({
      message: 'Order updates polling complete',
      pollResults,
      totalPolled: sellers.length,
      totalUpdatedOrders
    });

    console.log(`\n========== ORDER UPDATES SUMMARY ==========`);
    console.log(`Total updated orders: ${totalUpdatedOrders}`);

  } catch (err) {
    console.error('Error polling order updates:', err);
    res.status(500).json({ error: err.message });
  }
});

// Resync recent orders (last 10 days) - catches silent eBay changes where lastModifiedDate wasn't updated
router.post('/resync-recent', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'compliancemanager', 'hoc'), async (req, res) => {
  try {
    // Fields that should NOT be overwritten (manually set by team)
    const MANUAL_FIELDS = new Set([
      'amazonAccount', 'beforeTax', 'estimatedTax', 'beforeTaxUSD', 'estimatedTaxUSD',
      'amazonTotal', 'amazonTotalINR', 'marketplaceFee', 'igst', 'totalCC', 'amazonExchangeRate',
      'fulfillmentNotes', 'remark', 'messagingStatus', 'itemStatus', 'resolvedFrom',
      'arrivingDate', 'adFeeGeneral', 'adFeeGeneralUSD',
      'orderEarnings', 'tds', 'tid', 'net', 'pBalanceINR', 'ebayExchangeRate',
      '_id', '__v', 'createdAt', 'updatedAt'
    ]);

    // Helper to normalize dates for comparison (ignore milliseconds)
    function normalizeDateForComparison(date) {
      if (!date) return null;
      return Math.floor(new Date(date).getTime() / 1000);
    }

    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true, $ne: null } })
      .populate('user', 'username email');

    if (sellers.length === 0) {
      return res.json({
        message: 'No sellers with connected eBay accounts found',
        pollResults: [],
        totalPolled: 0,
        totalUpdated: 0,
        totalNew: 0
      });
    }

    const nowUTC = Date.now();
    const days = Math.min(Math.max(parseInt(req.body.days) || 10, 1), 30); // Default 10, max 30
    const sinceDate = new Date(nowUTC - days * 24 * 60 * 60 * 1000);

    console.log(`\n========== RESYNC RECENT ORDERS (${days} DAYS) FOR ${sellers.length} SELLERS ==========`);
    console.log(`UTC Time: ${new Date(nowUTC).toISOString()}`);
    console.log(`Checking orders created since: ${sinceDate.toISOString()}`);

    const pollingPromises = sellers.map(async (seller) => {
      const sellerName = seller.user?.username || seller.user?.email || seller._id.toString();

      try {
        console.log(`\n[${sellerName}] Starting resync...`);

        // Token refresh
        const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
        const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
        let accessToken = seller.ebayTokens.access_token;

        if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
          console.log(`[${sellerName}] Refreshing token...`);
          const refreshRes = await axios.post(
            'https://api.ebay.com/identity/v1/oauth2/token',
            qs.stringify({
              grant_type: 'refresh_token',
              refresh_token: seller.ebayTokens.refresh_token,
              scope: EBAY_OAUTH_SCOPES,
            }),
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
              },
            }
          );
          seller.ebayTokens.access_token = refreshRes.data.access_token;
          seller.ebayTokens.expires_in = refreshRes.data.expires_in;
          seller.ebayTokens.fetchedAt = new Date(nowUTC);
          await seller.save();
          accessToken = refreshRes.data.access_token;
        }

        // Fetch all orders created in last 10 days
        const currentTimeUTC = new Date(nowUTC);
        const filter = `creationdate:[${sinceDate.toISOString()}..${currentTimeUTC.toISOString()}]`;
        console.log(`[${sellerName}] Filter: ${filter}`);

        const ebayOrders = await fetchAllOrdersWithPagination(accessToken, filter, sellerName);
        console.log(`[${sellerName}] Fetched ${ebayOrders.length} orders from eBay`);

        const updatedOrders = [];
        const newOrders = [];

        for (const ebayOrder of ebayOrders) {
          const existingOrder = await Order.findOne({
            orderId: ebayOrder.orderId,
            seller: seller._id
          });

          if (existingOrder) {
            // Build fresh order data from eBay
            const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);

            // Only apply eBay-sourced fields (skip manual fields)
            let hasChanges = false;
            const changedFields = [];

            for (const [key, value] of Object.entries(orderData)) {
              if (MANUAL_FIELDS.has(key)) continue;
              if (key === 'seller') continue;

              // Compare values
              const oldVal = existingOrder[key];
              const newVal = value;
              let changed = false;

              if (oldVal === null || oldVal === undefined) {
                changed = newVal !== null && newVal !== undefined;
              } else if (key === 'creationDate' || key === 'lastModifiedDate' || key === 'dateSold' || key === 'shipByDate' || key === 'estimatedDelivery') {
                // Date comparison - normalize to seconds
                changed = normalizeDateForComparison(oldVal) !== normalizeDateForComparison(newVal);
              } else if (typeof newVal === 'object' && newVal !== null) {
                changed = JSON.stringify(oldVal) !== JSON.stringify(newVal);
              } else {
                changed = oldVal !== newVal;
              }

              if (changed) {
                existingOrder[key] = value;
                hasChanges = true;
                changedFields.push(key);
              }
            }

            if (hasChanges) {
              await existingOrder.save();
              updatedOrders.push({
                orderId: existingOrder.orderId,
                changedFields
              });
              console.log(`  🔄 RESYNCED: ${ebayOrder.orderId} - ${changedFields.join(', ')}`);
            }
          } else {
            // New order not in DB - create it
            const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);
            const newOrder = await Order.create(orderData);
            newOrders.push(newOrder.orderId);
            console.log(`  🆕 NEW (resync): ${ebayOrder.orderId}`);
          }
        }

        console.log(`[${sellerName}] ✅ Resync complete: ${updatedOrders.length} updated, ${newOrders.length} new`);

        return {
          sellerId: seller._id,
          sellerName,
          success: true,
          totalFetched: ebayOrders.length,
          updatedOrders,
          newOrders,
          totalUpdated: updatedOrders.length,
          totalNew: newOrders.length
        };

      } catch (sellerErr) {
        console.error(`[${sellerName}] ❌ Resync error:`, sellerErr.message);
        return {
          sellerId: seller._id,
          sellerName,
          success: false,
          error: sellerErr.message
        };
      }
    });

    const results = await Promise.allSettled(pollingPromises);
    const pollResults = results.map(result =>
      result.status === 'fulfilled' ? result.value : { success: false, error: result.reason?.message || 'Unknown error' }
    );

    const totalUpdated = pollResults.reduce((sum, r) => sum + (r.totalUpdated || 0), 0);
    const totalNew = pollResults.reduce((sum, r) => sum + (r.totalNew || 0), 0);

    res.json({
      message: 'Resync complete',
      pollResults,
      totalPolled: sellers.length,
      totalUpdated,
      totalNew
    });

    console.log('\n========== RESYNC SUMMARY ==========');
    console.log(`Total sellers: ${sellers.length}`);
    console.log(`Total updated: ${totalUpdated}`);
    console.log(`Total new: ${totalNew}`);

  } catch (err) {
    console.error('Error in resync:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Helper function to fetch ALL orders with pagination
// ============================================
// This fetches orders in batches of 200 (eBay max) until all orders are retrieved
async function fetchAllOrdersWithPagination(accessToken, filter, sellerName) {
  const allOrders = [];
  let offset = 0;
  const limit = 200; // eBay max per request
  let hasMore = true;
  let totalOrders = 0;

  console.log(`[${sellerName}] Starting paginated fetch...`);

  while (hasMore) {
    let attempt = 1;
    const maxRetries = 3;
    let success = false;

    while (attempt <= maxRetries && !success) {
      try {
        const params = {
          filter: filter,
          limit: limit
        };

        // Only add offset if it's greater than 0
        if (offset > 0) {
          params.offset = offset;
        }

        const response = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          params,
          timeout: 15000 // 15 second timeout
        });

        const orders = response.data.orders || [];
        totalOrders = response.data.total || orders.length;

        allOrders.push(...orders);

        console.log(`[${sellerName}] Fetched ${orders.length} orders at offset ${offset} (total so far: ${allOrders.length}/${totalOrders})`);

        // Check if there are more orders to fetch
        if (allOrders.length >= totalOrders || orders.length < limit) {
          hasMore = false;
        } else {
          offset += limit;
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        success = true; // Mark as successful
      } catch (err) {
        const status = err.response?.status;
        const isRetryable = status === 503 || status === 429 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';

        if (isRetryable && attempt < maxRetries) {
          const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 1s, 2s, 4s (max 5s)
          console.log(`[${sellerName}] ⚠️ Pagination attempt ${attempt} at offset ${offset} failed with ${status || err.code}, retrying in ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          attempt++;
        } else {
          console.error(`[${sellerName}] ❌ Pagination error at offset ${offset} after ${attempt} attempts:`, err.message);
          hasMore = false; // Stop on error after retries exhausted
          success = true; // Exit retry loop
        }
      }
    }
  }

  console.log(`[${sellerName}] ✅ Pagination complete: ${allOrders.length} orders`);
  return allOrders;
}

// Helper function to build order data object for insert/update
async function buildOrderData(ebayOrder, sellerId, accessToken) {
  const lineItem = ebayOrder.lineItems?.[0] || {};
  const fulfillmentInstr = ebayOrder.fulfillmentStartInstructions?.[0] || {};
  const shipTo = fulfillmentInstr.shippingStep?.shipTo || {};
  const buyerAddr = `${shipTo.contactAddress?.addressLine1 || ''}, ${shipTo.contactAddress?.city || ''}, ${shipTo.contactAddress?.stateOrProvince || ''}, ${shipTo.contactAddress?.postalCode || ''}, ${shipTo.contactAddress?.countryCode || ''}`.trim();

  const trackingNumber = await extractTrackingNumber(ebayOrder.fulfillmentHrefs, accessToken);
  const purchaseMarketplaceId = lineItem.purchaseMarketplaceId || '';

  // Build base order data
  const orderData = {
    seller: sellerId,
    orderId: ebayOrder.orderId,
    legacyOrderId: ebayOrder.legacyOrderId,
    creationDate: ebayOrder.creationDate,
    lastModifiedDate: ebayOrder.lastModifiedDate,
    orderFulfillmentStatus: ebayOrder.orderFulfillmentStatus,
    orderPaymentStatus: ebayOrder.orderPaymentStatus,
    sellerId: ebayOrder.sellerId,
    buyer: ebayOrder.buyer,
    buyerCheckoutNotes: ebayOrder.buyerCheckoutNotes,
    pricingSummary: ebayOrder.pricingSummary,
    cancelStatus: ebayOrder.cancelStatus,
    paymentSummary: ebayOrder.paymentSummary,
    fulfillmentStartInstructions: ebayOrder.fulfillmentStartInstructions,
    lineItems: ebayOrder.lineItems,
    ebayCollectAndRemitTax: ebayOrder.ebayCollectAndRemitTax,
    salesRecordReference: ebayOrder.salesRecordReference,
    totalFeeBasisAmount: ebayOrder.totalFeeBasisAmount,
    totalMarketplaceFee: ebayOrder.totalMarketplaceFee,
    fulfillmentHrefs: ebayOrder.fulfillmentHrefs,
    // Denormalized fields
    dateSold: ebayOrder.creationDate,
    shipByDate: lineItem.lineItemFulfillmentInstructions?.shipByDate,
    estimatedDelivery: lineItem.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate,
    productName: lineItem.title,
    itemNumber: lineItem.legacyItemId,
    buyerAddress: buyerAddr,
    shippingFullName: shipTo.fullName || '',
    shippingAddressLine1: shipTo.contactAddress?.addressLine1 || '',
    shippingAddressLine2: shipTo.contactAddress?.addressLine2 || '',
    shippingCity: shipTo.contactAddress?.city || '',
    shippingState: shipTo.contactAddress?.stateOrProvince || '',
    shippingPostalCode: shipTo.contactAddress?.postalCode || '',
    shippingCountry: shipTo.contactAddress?.countryCode || '',
    shippingPhone: shipTo.primaryPhone?.phoneNumber || '0000000000',
    quantity: lineItem.quantity,
    subtotal: parseFloat(ebayOrder.pricingSummary?.priceSubtotal?.value || 0),
    salesTax: parseFloat(lineItem.ebayCollectAndRemitTaxes?.[0]?.amount?.value || 0),
    discount: parseFloat(ebayOrder.pricingSummary?.priceDiscount?.value || 0),
    shipping: parseFloat(ebayOrder.pricingSummary?.deliveryCost?.value || 0),
    transactionFees: parseFloat(ebayOrder.totalMarketplaceFee?.value || 0),
    adFee: parseFloat(lineItem.appliedPromotions?.[0]?.discountAmount?.value || 0),
    refunds: ebayOrder.paymentSummary?.refunds || [],
    trackingNumber,
    purchaseMarketplaceId
  };

  // Enhanced cancel state extraction with multiple fallbacks
  let cancelState = 'NONE_REQUESTED';
  if (ebayOrder.cancelStatus) {
    // Try different possible property names from eBay API
    cancelState = ebayOrder.cancelStatus.cancelState ||
      ebayOrder.cancelStatus.state ||
      ebayOrder.cancelStatus.status ||
      (ebayOrder.cancelStatus.cancelled ? 'CANCELED' : 'NONE_REQUESTED');
  }
  orderData.cancelState = cancelState;

  // Calculate total refunds
  let refundTotal = 0;
  if (ebayOrder.paymentSummary?.refunds && Array.isArray(ebayOrder.paymentSummary.refunds)) {
    refundTotal = ebayOrder.paymentSummary.refunds.reduce((sum, refund) => {
      return sum + parseFloat(refund.amount?.value || 0);
    }, 0);
  }

  // Calculate and add USD conversion fields
  if (purchaseMarketplaceId === 'EBAY_US') {
    // US orders are already in USD
    orderData.subtotalUSD = orderData.subtotal;
    orderData.shippingUSD = orderData.shipping;
    orderData.salesTaxUSD = orderData.salesTax;
    orderData.discountUSD = orderData.discount;
    orderData.transactionFeesUSD = orderData.transactionFees;
    orderData.refundTotalUSD = refundTotal;
    // Only set USD values for beforeTax/estimatedTax if they exist (manual fields)
    if (orderData.beforeTax !== undefined && orderData.beforeTax !== null) {
      orderData.beforeTaxUSD = orderData.beforeTax;
    }
    if (orderData.estimatedTax !== undefined && orderData.estimatedTax !== null) {
      orderData.estimatedTaxUSD = orderData.estimatedTax;
    }
    orderData.conversionRate = 1;
  } else {
    // For non-US orders, calculate conversion rate from paymentSummary
    let conversionRate = 0;

    if (ebayOrder.paymentSummary?.totalDueSeller?.convertedFromValue &&
      ebayOrder.paymentSummary?.totalDueSeller?.value) {
      const originalValue = parseFloat(ebayOrder.paymentSummary.totalDueSeller.convertedFromValue);
      const usdValue = parseFloat(ebayOrder.paymentSummary.totalDueSeller.value);
      if (originalValue > 0) {
        conversionRate = usdValue / originalValue;
      }
    }

    // Apply conversion rate to all monetary fields with proper rounding (2 decimal places)
    orderData.subtotalUSD = conversionRate ? parseFloat((orderData.subtotal * conversionRate).toFixed(2)) : 0;
    orderData.shippingUSD = conversionRate ? parseFloat((orderData.shipping * conversionRate).toFixed(2)) : 0;
    orderData.salesTaxUSD = conversionRate ? parseFloat((orderData.salesTax * conversionRate).toFixed(2)) : 0;
    orderData.discountUSD = conversionRate ? parseFloat((orderData.discount * conversionRate).toFixed(2)) : 0;
    orderData.transactionFeesUSD = conversionRate ? parseFloat((orderData.transactionFees * conversionRate).toFixed(2)) : 0;
    orderData.refundTotalUSD = conversionRate ? parseFloat((refundTotal * conversionRate).toFixed(2)) : 0;
    orderData.beforeTaxUSD = conversionRate ? parseFloat(((orderData.beforeTax || 0) * conversionRate).toFixed(2)) : 0;
    orderData.estimatedTaxUSD = conversionRate ? parseFloat(((orderData.estimatedTax || 0) * conversionRate).toFixed(2)) : 0;
    orderData.conversionRate = parseFloat(conversionRate.toFixed(5)); // Store rate with 5 decimal precision
  }

  // Auto-calculate orderEarnings for normal (non-refunded) orders
  // For PAID orders, calculate: subtotal + discount - salesTax - transactionFees - adFee - shipping
  if (orderData.orderPaymentStatus === 'PAID') {
    const subtotal = parseFloat(orderData.subtotalUSD || 0);
    const discount = parseFloat(orderData.discountUSD || 0); // Already negative
    const salesTax = parseFloat(orderData.salesTaxUSD || 0);
    const transactionFees = parseFloat(orderData.transactionFeesUSD || 0);
    const adFee = parseFloat(orderData.adFeeGeneralUSD || orderData.adFee || 0);
    const shipping = parseFloat(orderData.shippingUSD || 0);

    // Order earnings = subtotal + discount - salesTax - transactionFees - adFee - shipping
    orderData.orderEarnings = parseFloat((subtotal + discount - salesTax - transactionFees - adFee - shipping).toFixed(2));

    // Calculate financial fields (TDS, TID, NET, P.Balance INR)
    const marketplace = purchaseMarketplaceId === 'EBAY_ENCA' ? 'EBAY_CA' :
      purchaseMarketplaceId === 'EBAY_AU' ? 'EBAY_AU' : 'EBAY';
    const financials = await calculateFinancials({ orderEarnings: orderData.orderEarnings }, marketplace);
    Object.assign(orderData, financials);

    // Calculate Amazon-side financial fields
    const amazonFinancials = await calculateAmazonFinancials(orderData);
    Object.assign(orderData, amazonFinancials);
  }

  return orderData;
}

// Update messaging status for an order
router.patch('/orders/:orderId/messaging-status', async (req, res) => {
  const { orderId } = req.params;
  const { messagingStatus } = req.body;

  if (!messagingStatus) {
    return res.status(400).json({ error: 'Missing messagingStatus value' });
  }

  // Validate enum values
  const validStatuses = ['Not Yet Started', 'Ongoing Conversation', 'Resolved'];
  if (!validStatuses.includes(messagingStatus)) {
    return res.status(400).json({ error: 'Invalid messagingStatus value' });
  }

  try {
    const order = await Order.findByIdAndUpdate(
      orderId,
      { messagingStatus },
      { new: true }
    ).populate({
      path: 'seller',
      populate: {
        path: 'user',
        select: 'username email'
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update item status for an order
router.patch('/orders/:orderId/item-status', async (req, res) => {
  const { orderId } = req.params;
  const { itemStatus, resolvedFrom } = req.body;

  if (!itemStatus) return res.status(400).json({ error: 'Missing itemStatus' });

  const validStatuses = ['None', 'Out of Stock', 'Delayed Delivery', 'Label Created', 'Other'];

  // Validate enum values
  if (!validStatuses.includes(itemStatus)) {
    return res.status(400).json({ error: 'Invalid itemStatus value' });
  }

  try {
    const updateData = { itemStatus };

    // If resolving, save the resolvedFrom field
    if (itemStatus === 'Resolved' && resolvedFrom) {
      updateData.resolvedFrom = resolvedFrom;
    }

    const order = await Order.findByIdAndUpdate(
      orderId,
      updateData,
      { new: true }
    ).populate({
      path: 'seller',
      populate: {
        path: 'user',
        select: 'username email'
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update notes for an order from awaiting shipment page 
router.patch('/orders/:orderId/notes', async (req, res) => {
  const { orderId } = req.params;
  const { notes } = req.body;

  if (notes === undefined || notes === null) {
    return res.status(400).json({ error: 'Missing notes value' });
  }

  try {
    const order = await Order.findByIdAndUpdate(
      orderId,
      { notes: String(notes) },
      { new: true }
    ).populate({
      path: 'seller',
      populate: {
        path: 'user',
        select: 'username email'
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- NEW ROUTE: Update Fulfillment Notes ---
router.patch('/orders/:orderId/fulfillment-notes', async (req, res) => {
  const { orderId } = req.params;
  const { fulfillmentNotes } = req.body;

  try {
    const order = await Order.findByIdAndUpdate(
      orderId,
      { fulfillmentNotes: String(fulfillmentNotes || '') }, // Update the new field
      { new: true }
    );

    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss order from Amazon Arrivals (soft delete - clears arrivingDate)
router.patch('/orders/:orderId/dismiss-arrival', requireAuth, async (req, res) => {
  const { orderId } = req.params;

  try {
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Clear the arriving date (soft delete)
    order.arrivingDate = null;
    await order.save();

    // Populate seller info for response
    await order.populate({
      path: 'seller',
      populate: {
        path: 'user',
        select: 'username email'
      }
    });

    res.json({
      success: true,
      message: 'Order dismissed from Amazon Arrivals',
      order
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== RETURN REQUESTS ENDPOINTS =====

// Fetch return requests from eBay Post-Order API and store in DB

// Fetch return requests from eBay Post-Order API and store in DB
router.post('/fetch-returns', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true } })
      .populate('user', 'username');

    if (sellers.length === 0) {
      return res.json({ message: 'No sellers with eBay tokens found', totalReturns: 0 });
    }

    let totalNewReturns = 0;
    let totalUpdatedReturns = 0;
    const errors = [];

    console.log(`[Fetch Returns] Starting for ${sellers.length} sellers`);

    const results = await Promise.allSettled(
      sellers.map(async (seller) => {
        const sellerName = seller.user?.username || 'Unknown Seller';

        try {
          // Token refresh logic (Standard)
          const nowUTC = Date.now();
          const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
          const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
          let accessToken = seller.ebayTokens.access_token;

          if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
            console.log(`[Fetch Returns] Refreshing token for seller ${sellerName}`);
            const refreshRes = await axios.post(
              'https://api.ebay.com/identity/v1/oauth2/token',
              qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: seller.ebayTokens.refresh_token,
                scope: EBAY_OAUTH_SCOPES // Using centralized scopes constant
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
                },
              }
            );
            accessToken = refreshRes.data.access_token;
            seller.ebayTokens.access_token = accessToken;
            seller.ebayTokens.expires_in = refreshRes.data.expires_in;
            seller.ebayTokens.fetchedAt = new Date(nowUTC);
            await seller.save();
          }

          // Fetch return requests
          const returnUrl = 'https://api.ebay.com/post-order/v2/return/search';
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

          const returnRes = await axios.get(returnUrl, {
            headers: {
              'Authorization': `IAF ${accessToken}`,
              'Content-Type': 'application/json',
              'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
            },
            params: {
              'creation_date_range_from': thirtyDaysAgo,
              'limit': 200
            }
          });

          const returns = returnRes.data.members || [];
          console.log(`[Fetch Returns] Seller ${sellerName}: Found ${returns.length} returns`);

          let newReturns = 0;
          let updatedReturns = 0;
          let updateDetails = []; // Track updates for frontend snackbar

          for (const ebayReturn of returns) {
            // 1. Safe Extraction
            const creationInfo = ebayReturn.creationInfo || {};
            const itemInfo = creationInfo.item || {};
            const sellerRefund = ebayReturn.sellerTotalRefund?.estimatedRefundAmount || {};

            // 2. Build Data Object (CASTING TO MATCH SCHEMA)
            const returnData = {
              seller: seller._id,
              returnId: ebayReturn.returnId,
              orderId: ebayReturn.orderId || ebayReturn.orderNumber,
              legacyOrderId: ebayReturn.legacyOrderId,
              buyerUsername: ebayReturn.buyerLoginName,
              returnReason: creationInfo.reason,
              returnStatus: ebayReturn.state || ebayReturn.status,
              returnType: creationInfo.type,
              itemId: itemInfo.itemId,
              itemTitle: itemInfo.title || itemInfo.itemId,
              returnQuantity: itemInfo.returnQuantity,
              refundAmount: {
                // FIX 1: Force String to match Mongoose Schema "String"
                value: String(sellerRefund.value || 0),
                currency: sellerRefund.currency
              },
              creationDate: creationInfo.creationDate?.value ? new Date(creationInfo.creationDate.value) : null,
              responseDate: ebayReturn.sellerResponseDue?.respondByDate?.value ? new Date(ebayReturn.sellerResponseDue.respondByDate.value) : null,
              rmaNumber: ebayReturn.RMANumber,
              buyerComments: creationInfo.comments?.content,
              rawData: ebayReturn
            };

            const existing = await Return.findOne({ returnId: ebayReturn.returnId });

            if (existing) {
              // --- HELPER FUNCTIONS FOR COMPARISON ---
              // Convert to seconds (ignore milliseconds)
              const getUnix = (d) => d ? Math.floor(new Date(d).getTime() / 1000) : 0;
              // Convert to string to handle "63.95" vs 63.95 mismatch
              const safeStr = (v) => (v === undefined || v === null) ? '' : String(v);

              // --- COMPARISON LOGIC ---
              const statusChanged = existing.returnStatus !== returnData.returnStatus;

              // FIX 2: Compare as Strings
              const refundChanged = safeStr(existing.refundAmount?.value) !== safeStr(returnData.refundAmount?.value);

              // FIX 3: Compare as Unix Timestamps (seconds)
              const responseDateChanged = getUnix(existing.responseDate) !== getUnix(returnData.responseDate);
              const creationDateChanged = getUnix(existing.creationDate) !== getUnix(returnData.creationDate);

              if (statusChanged || refundChanged || responseDateChanged || creationDateChanged) {

                // DIAGNOSTIC LOG: This will show you exactly what changed in your terminal
                console.log(`[Update Triggered] Return ${ebayReturn.returnId}:`);
                if (statusChanged) console.log(`   - Status: ${existing.returnStatus} -> ${returnData.returnStatus}`);
                if (refundChanged) console.log(`   - Refund: ${existing.refundAmount?.value} -> ${returnData.refundAmount?.value}`);
                if (responseDateChanged) console.log(`   - RespDate: ${existing.responseDate} -> ${returnData.responseDate}`);
                if (creationDateChanged) console.log(`   - CreateDate: ${existing.creationDate} -> ${returnData.creationDate}`);

                // Use .set() to update fields
                existing.set(returnData);
                await existing.save();
                updatedReturns++;

                // Track update details for frontend snackbar
                if (!updateDetails) updateDetails = [];
                updateDetails.push({
                  returnId: ebayReturn.returnId,
                  orderId: returnData.orderId,
                  changes: {
                    ...(statusChanged && { status: { from: existing.returnStatus, to: returnData.returnStatus } }),
                    ...(refundChanged && { refund: { from: existing.refundAmount?.value, to: returnData.refundAmount?.value } })
                  }
                });
              }
            } else {
              await Return.create(returnData);
              newReturns++;
            }
          }

          return {
            sellerName: sellerName,
            newReturns,
            updatedReturns,
            updateDetails, // Include update details for frontend snackbar
            totalReturns: returns.length
          };

        } catch (err) {
          console.error(`[Fetch Returns] Error for seller ${sellerName}:`, err.message);
          throw new Error(`${sellerName}: ${err.message}`);
        }
      })
    );

    const successResults = [];
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        successResults.push(result.value);
        totalNewReturns += result.value.newReturns;
        totalUpdatedReturns += result.value.updatedReturns;
      } else {
        errors.push(result.reason.message);
      }
    });

    res.json({
      message: `Fetched returns for ${successResults.length} sellers`,
      totalNewReturns,
      totalUpdatedReturns,
      results: successResults,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error('[Fetch Returns] Error:', err);
    res.status(500).json({ error: err.message });
  }
});
// Get stored returns from database

router.get('/stored-returns', async (req, res) => {
  const { sellerId, status, reason, startDate, endDate, urgentOnly, page = 1, limit = 50 } = req.query;

  try {
    let query = {};
    if (sellerId) query.seller = sellerId;
    if (status) query.returnStatus = status;
    // Support multiple reasons (comma-separated) with OR logic using $in
    if (reason) {
      const reasons = reason.split(',').map(r => r.trim()).filter(r => r);
      if (reasons.length === 1) {
        query.returnReason = reasons[0];
      } else if (reasons.length > 1) {
        query.returnReason = { $in: reasons };
      }
    }

    // Date range filter on creationDate
    if (startDate || endDate) {
      query.creationDate = {};
      if (startDate) query.creationDate.$gte = new Date(startDate);
      if (endDate) {
        // Include the entire end date (end of day)
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        query.creationDate.$lte = endOfDay;
      }
    }

    // Urgent filter - response due within next 2 days (48 hours) to match the URGENT chip
    if (urgentOnly === 'true') {
      const now = new Date();
      // Calculate 48 hours (2 days) from now - matches isResponseUrgent in frontend
      const in48Hours = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
      // Show entries where response is due between now and 48 hours from now
      // Also include entries that are already overdue (responseDate < now)
      query.responseDate = {
        $lte: in48Hours
      };
      // Exclude CLOSED returns since they don't show URGENT chip
      query.returnStatus = { $ne: 'CLOSED' };
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const returns = await Return.find(query)
      .populate({
        path: 'seller',
        select: 'user', // Select the 'user' field from Seller.js
        populate: {
          path: 'user', // Follow the link to User.js
          select: 'username' // Get the 'username' from User.js
        }
      })
      .sort({ creationDate: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(); // Use lean for faster queries and to allow modification

    // Lookup product names and order dates from Orders collection
    const orderIds = returns.map(r => r.orderId).filter(Boolean);
    const orders = await Order.find({ orderId: { $in: orderIds } }, { orderId: 1, productName: 1, creationDate: 1 }).lean();
    const orderMap = {};
    orders.forEach(o => {
      orderMap[o.orderId] = {
        productName: o.productName,
        dateSold: o.creationDate
      };
    });

    // Attach productName and dateSold to each return
    const returnsWithOrderData = returns.map(r => ({
      ...r,
      productName: orderMap[r.orderId]?.productName || null,
      dateSold: orderMap[r.orderId]?.dateSold || null
    }));

    // Get total count for the query
    const totalCount = await Return.countDocuments(query);
    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      returns: returnsWithOrderData,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalReturns: totalCount,
        limit: limitNum
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ===== INR CASES ENDPOINTS =====

// Fetch INR cases from eBay Post-Order API and store in DB
router.post('/fetch-inr-cases', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true } })
      .populate('user', 'username');

    if (sellers.length === 0) {
      return res.json({ message: 'No sellers with eBay tokens found', totalCases: 0 });
    }

    let totalNewCases = 0;
    let totalUpdatedCases = 0;
    const errors = [];

    console.log(`[Fetch INR Cases] Starting for ${sellers.length} sellers`);

    const results = await Promise.allSettled(
      sellers.map(async (seller) => {
        const sellerName = seller.user?.username || 'Unknown Seller';

        try {
          // Token refresh logic
          const nowUTC = Date.now();
          const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
          const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
          let accessToken = seller.ebayTokens.access_token;

          if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
            console.log(`[Fetch INR Cases] Refreshing token for seller ${sellerName}`);
            const refreshRes = await axios.post(
              'https://api.ebay.com/identity/v1/oauth2/token',
              qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: seller.ebayTokens.refresh_token,
                scope: EBAY_OAUTH_SCOPES // Using centralized scopes constant
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
                },
              }
            );
            accessToken = refreshRes.data.access_token;
            seller.ebayTokens.access_token = accessToken;
            seller.ebayTokens.expires_in = refreshRes.data.expires_in;
            seller.ebayTokens.fetchedAt = new Date(nowUTC);
            await seller.save();
          }

          // Fetch INR cases from Post-Order API
          const inquiryUrl = 'https://api.ebay.com/post-order/v2/inquiry/search';
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

          const inquiryRes = await axios.get(inquiryUrl, {
            headers: {
              'Authorization': `IAF ${accessToken}`,
              'Content-Type': 'application/json',
              'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
            },
            params: {
              'creation_date_range_from': thirtyDaysAgo,
              'limit': 200
            }
          });

          const cases = inquiryRes.data.members || [];
          console.log(`[Fetch INR Cases] Seller ${sellerName}: Found ${cases.length} INR cases`);

          let newCases = 0;
          let updatedCases = 0;
          let updateDetails = [];

          for (const ebayCase of cases) {
            // Determine case type
            const inquiryType = ebayCase.inquiryType || 'INR';
            let caseType = 'INR';
            if (inquiryType === 'SNAD' || inquiryType === 'SIGNIFICANTLY_NOT_AS_DESCRIBED') {
              caseType = 'SNAD';
            } else if (inquiryType !== 'INR' && inquiryType !== 'ITEM_NOT_RECEIVED') {
              caseType = 'OTHER';
            }

            // Try to get orderId from eBay response, or look it up in Order collection
            let orderId = ebayCase.orderId || ebayCase.orderNumber;

            // If no orderId from eBay, try to find it using lineItemId or transactionId
            if (!orderId && (ebayCase.lineItemId || ebayCase.transactionId || ebayCase.itemId)) {
              try {
                // Try to find order with matching lineItem
                const orderQuery = {};
                if (ebayCase.lineItemId) {
                  orderQuery['lineItems.lineItemId'] = ebayCase.lineItemId;
                } else if (ebayCase.transactionId) {
                  orderQuery['lineItems.legacyItemId'] = ebayCase.itemId;
                }

                if (Object.keys(orderQuery).length > 0) {
                  orderQuery.seller = seller._id;
                  const matchingOrder = await Order.findOne(orderQuery).select('orderId');
                  if (matchingOrder) {
                    orderId = matchingOrder.orderId;
                    console.log(`[Fetch INR Cases] Found orderId ${orderId} for case ${ebayCase.inquiryId}`);
                  }
                }
              } catch (lookupErr) {
                console.log(`[Fetch INR Cases] Could not lookup orderId for case ${ebayCase.inquiryId}:`, lookupErr.message);
              }
            }

            const caseData = {
              seller: seller._id,
              caseId: ebayCase.inquiryId,
              caseType,
              orderId: orderId,
              buyerUsername: ebayCase.buyer || ebayCase.buyerLoginName,
              // FIX: eBay returns 'inquiryStatusEnum' not 'state' or 'status'
              status: ebayCase.inquiryStatusEnum || ebayCase.state || ebayCase.status || 'OPEN',

              // Dates
              creationDate: ebayCase.creationDate?.value ? new Date(ebayCase.creationDate.value) : null,
              // FIX: eBay returns 'respondByDate' directly, not nested under 'sellerResponseDue'
              sellerResponseDueDate: ebayCase.respondByDate?.value
                ? new Date(ebayCase.respondByDate.value)
                : (ebayCase.sellerResponseDue?.respondByDate?.value ? new Date(ebayCase.sellerResponseDue.respondByDate.value) : null),
              escalationDate: ebayCase.escalationDate?.value ? new Date(ebayCase.escalationDate.value) : null,
              closedDate: ebayCase.closedDate?.value ? new Date(ebayCase.closedDate.value) : null,
              // FIX: Also store lastModifiedDate from eBay
              lastModifiedDate: ebayCase.lastModifiedDate?.value ? new Date(ebayCase.lastModifiedDate.value) : null,

              // Item Info
              itemId: ebayCase.itemId,
              itemTitle: ebayCase.itemTitle,

              // Amount
              claimAmount: {
                value: String(ebayCase.claimAmount?.value || 0),
                currency: ebayCase.claimAmount?.currency || 'USD'
              },

              // Resolution
              resolution: ebayCase.resolution || null,
              sellerResponse: ebayCase.sellerResponse || null,

              rawData: ebayCase
            };

            const existing = await Case.findOne({ caseId: ebayCase.inquiryId });

            if (existing) {
              // Compare for changes
              const statusChanged = existing.status !== caseData.status;
              const dueDateChanged = (existing.sellerResponseDueDate?.getTime() || 0) !==
                (caseData.sellerResponseDueDate?.getTime() || 0);

              if (statusChanged || dueDateChanged) {
                console.log(`[Update] Case ${ebayCase.inquiryId}: Status ${existing.status} -> ${caseData.status}`);
                existing.set(caseData);
                await existing.save();
                updatedCases++;

                updateDetails.push({
                  caseId: ebayCase.inquiryId,
                  orderId: caseData.orderId,
                  changes: {
                    ...(statusChanged && { status: { from: existing.status, to: caseData.status } })
                  }
                });
              }
            } else {
              await Case.create(caseData);
              newCases++;
            }
          }

          return {
            sellerName: sellerName,
            newCases,
            updatedCases,
            updateDetails,
            totalCases: cases.length
          };

        } catch (err) {
          console.error(`[Fetch INR Cases] Error for seller ${sellerName}:`, err.message);
          throw new Error(`${sellerName}: ${err.message}`);
        }
      })
    );

    const successResults = [];
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        successResults.push(result.value);
        totalNewCases += result.value.newCases;
        totalUpdatedCases += result.value.updatedCases;
      } else {
        errors.push(result.reason.message);
      }
    });

    res.json({
      message: `Fetched INR cases for ${successResults.length} sellers`,
      totalNewCases,
      totalUpdatedCases,
      results: successResults,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error('[Fetch INR Cases] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get stored INR cases from database
router.get('/stored-inr-cases', async (req, res) => {
  const { sellerId, status, caseType, limit = 200 } = req.query;

  try {
    let query = {};
    if (sellerId) query.seller = sellerId;
    if (status) query.status = status;
    if (caseType) query.caseType = caseType;

    const cases = await Case.find(query)
      .populate({
        path: 'seller',
        select: 'user',
        populate: {
          path: 'user',
          select: 'username'
        }
      })
      .sort({ creationDate: -1 })
      .limit(parseInt(limit));

    const totalCount = await Case.countDocuments(query);

    res.json({ cases, totalCases: cases.length, totalCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ===== PAYMENT DISPUTES ENDPOINTS =====

// Fetch Payment Disputes from eBay Fulfillment API and store in DB
router.post('/fetch-payment-disputes', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true } })
      .populate('user', 'username');

    if (sellers.length === 0) {
      return res.json({ message: 'No sellers with eBay tokens found', totalDisputes: 0 });
    }

    let totalNewDisputes = 0;
    let totalUpdatedDisputes = 0;
    const errors = [];

    console.log(`[Fetch Payment Disputes] Starting for ${sellers.length} sellers`);

    const results = await Promise.allSettled(
      sellers.map(async (seller) => {
        const sellerName = seller.user?.username || 'Unknown Seller';

        try {
          // Token refresh logic
          const nowUTC = Date.now();
          const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
          const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
          let accessToken = seller.ebayTokens.access_token;

          if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
            console.log(`[Fetch Payment Disputes] Refreshing token for seller ${sellerName}`);
            const refreshRes = await axios.post(
              'https://api.ebay.com/identity/v1/oauth2/token',
              qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: seller.ebayTokens.refresh_token,
                scope: EBAY_OAUTH_SCOPES // Using centralized scopes constant
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
                },
              }
            );
            accessToken = refreshRes.data.access_token;
            seller.ebayTokens.access_token = accessToken;
            seller.ebayTokens.expires_in = refreshRes.data.expires_in;
            seller.ebayTokens.fetchedAt = new Date(nowUTC);
            await seller.save();
          }

          // Fetch Payment Disputes from Fulfillment API
          // Uses Bearer token and the payment_dispute_summary endpoint
          // IMPORTANT: Requires sell.payment.dispute scope (different from sell.fulfillment)
          // Docs: https://developer.ebay.com/api-docs/sell/fulfillment/resources/payment_dispute/methods/getPaymentDisputeSummaries
          const disputeUrl = 'https://apiz.ebay.com/sell/fulfillment/v1/payment_dispute_summary';

          let disputes = [];
          try {
            const disputeRes = await axios.get(disputeUrl, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              },
              params: {
                'limit': 200
              }
            });
            disputes = disputeRes.data.paymentDisputeSummaries || [];
            console.log(`[Fetch Payment Disputes] Seller ${sellerName}: Found ${disputes.length} disputes`);
          } catch (apiErr) {
            // Log the actual error for debugging
            const errMsg = apiErr.response?.data?.errors?.[0]?.message || apiErr.message;
            const errCode = apiErr.response?.status;
            console.log(`[Fetch Payment Disputes] Seller ${sellerName}: API Error - ${errCode} ${errMsg}`);

            // 404 might mean no disputes, 403 means missing scope
            if (errCode === 404) {
              disputes = [];
            } else if (errCode === 403) {
              // Missing sell.payment.dispute scope - seller needs to re-authorize
              console.log(`[Fetch Payment Disputes] Seller ${sellerName}: Missing sell.payment.dispute scope - needs re-authorization`);
              throw new Error(`Missing payment dispute scope - seller needs to re-connect eBay account`);
            } else {
              // Re-throw other errors
              throw apiErr;
            }
          }

          let newDisputes = 0;
          let updatedDisputes = 0;
          let updateDetails = [];

          for (const ebayDispute of disputes) {
            const disputeData = {
              seller: seller._id,
              paymentDisputeId: ebayDispute.paymentDisputeId,
              orderId: ebayDispute.orderId,
              buyerUsername: ebayDispute.buyerUsername,

              // Status & Reason
              paymentDisputeStatus: ebayDispute.paymentDisputeStatus,
              reason: ebayDispute.reason,

              // Dates
              openDate: ebayDispute.openDate ? new Date(ebayDispute.openDate) : null,
              respondByDate: ebayDispute.respondByDate ? new Date(ebayDispute.respondByDate) : null,
              closedDate: ebayDispute.closedDate ? new Date(ebayDispute.closedDate) : null,

              // Amounts
              amount: {
                value: String(ebayDispute.amount?.value || 0),
                currency: ebayDispute.amount?.currency || 'USD'
              },

              // Resolution
              sellerProtectionDecision: ebayDispute.sellerResponse?.sellerProtectionDecision || null,
              resolution: ebayDispute.resolution?.resolutionType || null,

              // Evidence
              evidenceDeadline: ebayDispute.evidenceDeadline ? new Date(ebayDispute.evidenceDeadline) : null,

              rawData: ebayDispute
            };

            const existing = await PaymentDispute.findOne({ paymentDisputeId: ebayDispute.paymentDisputeId });

            if (existing) {
              // Compare for changes
              const statusChanged = existing.paymentDisputeStatus !== disputeData.paymentDisputeStatus;
              const dueDateChanged = (existing.respondByDate?.getTime() || 0) !==
                (disputeData.respondByDate?.getTime() || 0);

              if (statusChanged || dueDateChanged) {
                console.log(`[Update] Dispute ${ebayDispute.paymentDisputeId}: Status ${existing.paymentDisputeStatus} -> ${disputeData.paymentDisputeStatus}`);
                existing.set(disputeData);
                await existing.save();
                updatedDisputes++;

                updateDetails.push({
                  paymentDisputeId: ebayDispute.paymentDisputeId,
                  orderId: disputeData.orderId,
                  changes: {
                    ...(statusChanged && { status: { from: existing.paymentDisputeStatus, to: disputeData.paymentDisputeStatus } })
                  }
                });
              }
            } else {
              await PaymentDispute.create(disputeData);
              newDisputes++;
            }
          }

          return {
            sellerName: sellerName,
            newDisputes,
            updatedDisputes,
            updateDetails,
            totalDisputes: disputes.length
          };

        } catch (err) {
          console.error(`[Fetch Payment Disputes] Error for seller ${sellerName}:`, err.message);
          throw new Error(`${sellerName}: ${err.message}`);
        }
      })
    );

    const successResults = [];
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        successResults.push(result.value);
        totalNewDisputes += result.value.newDisputes;
        totalUpdatedDisputes += result.value.updatedDisputes;
      } else {
        errors.push(result.reason.message);
      }
    });

    res.json({
      message: `Fetched payment disputes for ${successResults.length} sellers`,
      totalNewDisputes,
      totalUpdatedDisputes,
      results: successResults,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error('[Fetch Payment Disputes] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get stored Payment Disputes from database
router.get('/stored-payment-disputes', async (req, res) => {
  const { sellerId, status, reason, limit = 200 } = req.query;

  try {
    let query = {};
    if (sellerId) query.seller = sellerId;
    if (status) query.paymentDisputeStatus = status;
    if (reason) query.reason = reason;

    const disputes = await PaymentDispute.find(query)
      .populate({
        path: 'seller',
        select: 'user',
        populate: {
          path: 'user',
          select: 'username'
        }
      })
      .sort({ openDate: -1 })
      .limit(parseInt(limit));

    const totalCount = await PaymentDispute.countDocuments(query);

    res.json({ disputes, totalDisputes: disputes.length, totalCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// 1. HEAVY SYNC: Fetch Inbox (Manual Trigger)
// 1. HEAVY SYNC: Fetch Inbox (Smart Polling)
router.post('/sync-inbox', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    console.log('[Sync Inbox] Starting smart message sync...');
    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true } }).populate('user', 'username email');
    let totalNew = 0;
    const syncResults = []; // Track per-seller results

    for (const seller of sellers) {
      const sellerName = seller.user?.username || seller.user?.email || seller._id;
      try {
        // 1. Ensure Token is Valid
        const token = await ensureValidToken(seller);

        // 2. Determine Time Window (Smart Polling)
        const now = new Date();
        let startTime;

        if (seller.lastMessagePolledAt) {
          // INCREMENTAL SYNC: Fetch from last poll time
          // We subtract 15 minutes overlap to ensure no messages are missed due to server latency
          startTime = new Date(new Date(seller.lastMessagePolledAt).getTime() - 15 * 60 * 1000);
          console.log(`[${sellerName}] Incremental sync from: ${startTime.toISOString()}`);
        } else {
          // INITIAL SYNC: Fetch last 12 Days
          startTime = new Date(now.getTime() - 12 * 24 * 60 * 60 * 1000);
          console.log(`[${sellerName}] First-time sync from: ${startTime.toISOString()} (Last 10 Days)`);
        }

        const startTimeStr = startTime.toISOString();
        const endTimeStr = now.toISOString();

        // 3. XML Request
        const xmlRequest = `
          <?xml version="1.0" encoding="utf-8"?>
          <GetMemberMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
            <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
            
            <MailMessageType>All</MailMessageType>
            
            <StartCreationTime>${startTimeStr}</StartCreationTime>
            <EndCreationTime>${endTimeStr}</EndCreationTime>
            
            <Pagination>
              <EntriesPerPage>200</EntriesPerPage>
              <PageNumber>1</PageNumber>
            </Pagination>
          </GetMemberMessagesRequest>
        `;

        const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
          headers: {
            'X-EBAY-API-SITEID': '0',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
            'X-EBAY-API-CALL-NAME': 'GetMemberMessages',
            'Content-Type': 'text/xml'
          }
        });

        const result = await parseStringPromise(response.data);

        if (result.GetMemberMessagesResponse.Ack[0] === 'Failure') {
          const error = result.GetMemberMessagesResponse.Errors?.[0]?.LongMessage?.[0];
          console.error(`eBay API Failure for seller ${seller._id}:`, error);
          syncResults.push({ sellerName, newMessages: 0, error: error });
          continue;
        }

        const messages = result.GetMemberMessagesResponse.MemberMessage?.[0]?.MemberMessageExchange || [];

        // 4. Process Messages
        let newForThisSeller = 0;
        for (const msg of messages) {
          const isNew = await processEbayMessage(msg, seller);
          if (isNew) {
            newForThisSeller++;
            totalNew++;
          }
        }

        console.log(`[Sync Inbox] Seller ${sellerName}: Fetched ${messages.length}. Saved ${newForThisSeller} new.`);
        syncResults.push({ sellerName, newMessages: newForThisSeller, fetched: messages.length });

        // 5. Update Polling Timestamp (Only on success)
        seller.lastMessagePolledAt = now;
        await seller.save();

      } catch (err) {
        console.error(`Sync error for seller ${seller._id}:`, err.message);
        syncResults.push({ sellerName, newMessages: 0, error: err.message });
      }
    }

    res.json({ success: true, totalNewMessages: totalNew, syncResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});




//LIGHT SYNC: Active Thread Poll (Auto Interval)
// Filters by SenderID to be lightweight
// 2. LIGHT SYNC: Active Thread Poll
router.post('/sync-thread', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  const { sellerId, buyerUsername, itemId } = req.body;

  if (!sellerId || !buyerUsername) return res.status(400).json({ error: 'Missing identifiers' });

  try {
    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    // 1. Ensure Token is Valid
    const token = await ensureValidToken(seller);

    // 2. Time Filters
    const now = new Date();
    const startTime = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const endTime = now.toISOString();

    const xmlRequest = `
      <?xml version="1.0" encoding="utf-8"?>
      <GetMemberMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
        
        <MailMessageType>All</MailMessageType>
        
        <SenderID>${buyerUsername}</SenderID>
        
        <StartCreationTime>${startTime}</StartCreationTime>
        <EndCreationTime>${endTime}</EndCreationTime>
        
        ${itemId ? `<ItemID>${itemId}</ItemID>` : ''}
        
        <Pagination><EntriesPerPage>50</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
      </GetMemberMessagesRequest>
    `;

    const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
        'X-EBAY-API-CALL-NAME': 'GetMemberMessages',
        'Content-Type': 'text/xml'
      }
    });

    const result = await parseStringPromise(response.data);
    const messages = result.GetMemberMessagesResponse.MemberMessage?.[0]?.MemberMessageExchange || [];

    let hasNew = false;
    for (const msg of messages) {
      const isNew = await processEbayMessage(msg, seller);
      if (isNew) hasNew = true;
    }

    res.json({ success: true, newMessagesFound: hasNew });
  } catch (err) {
    console.error('Thread sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Helper: Upload Image to eBay Picture Services (EPS)
// Buyers use the exact same process - they upload via eBay's UI which calls UploadSiteHostedPictures
// The MediaURL we receive from buyers is also from i.ebayimg.com domain
async function uploadImageToEbay(token, filePath) {
  try {
    console.log('[eBay Upload] Processing image:', filePath);

    // Step 1: Process image with Sharp
    const metadata = await sharp(filePath).metadata();
    console.log('[eBay Upload] Original format:', metadata.format, `${metadata.width}x${metadata.height}`);

    // Step 2: Convert to JPEG with optimal settings for eBay
    let processedBuffer = await sharp(filePath)
      .rotate() // Auto-rotate based on EXIF
      .resize(1600, 1600, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } }) // Remove transparency
      .jpeg({
        quality: 95,
        chromaSubsampling: '4:4:4', // No chroma subsampling for better quality
        force: true
      })
      .toBuffer();

    // Check file size
    let fileSizeMB = processedBuffer.length / (1024 * 1024);
    if (fileSizeMB > 7) {
      console.log('[eBay Upload] Image too large, recompressing...');
      processedBuffer = await sharp(processedBuffer)
        .jpeg({ quality: 85 })
        .toBuffer();
      fileSizeMB = processedBuffer.length / (1024 * 1024);
    }

    console.log(`[eBay Upload] Processed: ${fileSizeMB.toFixed(2)}MB JPEG`);

    const fileName = path.basename(filePath).replace(/\.[^/.]+$/, '.jpg');

    // Step 3: Use multipart/form-data (eBay's recommended method)
    const form = new FormData();

    // Add XML payload as first part
    const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <PictureName>${fileName}</PictureName>
  <PictureSet>Standard</PictureSet>
</UploadSiteHostedPicturesRequest>`;

    form.append('XML Payload', xmlPayload, {
      contentType: 'text/xml; charset=utf-8'
    });

    // Add binary image as second part
    form.append(fileName, processedBuffer, {
      filename: fileName,
      contentType: 'image/jpeg'
    });

    // Step 4: Upload to eBay Picture Services
    const response = await axios.post('https://api.ebay.com/ws/api.dll', form, {
      headers: {
        ...form.getHeaders(),
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
        'X-EBAY-API-CALL-NAME': 'UploadSiteHostedPictures'
      },
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    const result = await parseStringPromise(response.data);
    const ack = result.UploadSiteHostedPicturesResponse.Ack[0];

    if (ack === 'Success' || ack === 'Warning') {
      const fullUrl = result.UploadSiteHostedPicturesResponse.SiteHostedPictureDetails[0].FullURL[0];
      console.log('[eBay Upload] ✅ Success:', fullUrl);
      return fullUrl;
    } else {
      const errors = result.UploadSiteHostedPicturesResponse.Errors;
      const errorMsg = errors[0].LongMessage[0];
      const errorCode = errors[0].ErrorCode?.[0];
      console.error('[eBay Upload] ❌ Failed:', errorCode, errorMsg);
      throw new Error(`eBay Upload Failed: ${errorMsg}`);
    }
  } catch (error) {
    console.error('[eBay Upload] Error:', error.message);
    if (error.response?.data) {
      console.error('[eBay Upload] Response:', error.response.data.substring(0, 500));
    }
    throw error;
  }
}

// 3. SEND MESSAGE (Chat Window)
router.post('/send-message', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  const { orderId, buyerUsername, itemId, body, subject, mediaUrls } = req.body;

  try {
    let seller = null;
    let finalItemId = itemId;
    let finalBuyer = buyerUsername;
    let isTransaction = false;
    let isDirect = false;
    let parentMessageId = null;

    // Check if this is a DIRECT message (no item)
    if (itemId === 'DIRECT_MESSAGE' || !itemId) {
      isDirect = true;
    }

    // Determine if this is a transaction (ORDER), inquiry (INQUIRY), or direct (DIRECT)
    if (orderId) {
      const order = await Order.findOne({ orderId }).populate('seller');
      if (!order) return res.status(404).json({ error: 'Order not found' });
      seller = order.seller;
      finalItemId = order.lineItems?.[0]?.legacyItemId;
      finalBuyer = order.buyer.username;
      isTransaction = true; // This is a real transaction
    } else {
      // Get the most recent message from this buyer
      const query = isDirect
        ? { buyerUsername, itemId: 'DIRECT_MESSAGE', sender: 'BUYER' }
        : { buyerUsername, itemId, sender: 'BUYER' };

      const prevMsg = await Message.findOne(query)
        .sort({ messageDate: -1 })
        .populate('seller');

      if (prevMsg) {
        seller = prevMsg.seller;
        parentMessageId = prevMsg.externalMessageId; // eBay's message ID

        // Check if this inquiry is related to an order
        if (prevMsg.orderId) {
          isTransaction = true;
        } else if (prevMsg.messageType === 'DIRECT') {
          isDirect = true;
        } else {
          isTransaction = false; // Pre-sale inquiry
        }
      }
    }

    if (!seller) return res.status(400).json({ error: 'Could not determine seller context' });

    // DIRECT messages: Cannot reply via API (eBay limitation)
    if (isDirect) {
      return res.status(400).json({
        error: 'Cannot reply to direct messages via API. These are account-level messages that must be replied to through eBay\'s messaging center.',
        hint: 'Direct messages (without item context) cannot be replied to programmatically.'
      });
    }

    if (!finalItemId || finalItemId === 'DIRECT_MESSAGE') {
      return res.status(400).json({ error: 'ItemID required to send message' });
    }

    // For inquiries (RTQ), we need the parent message ID
    if (!isTransaction && !parentMessageId) {
      return res.status(400).json({ error: 'Cannot reply to inquiry: Original message ID not found' });
    }

    // Ensure Token is Valid
    const token = await ensureValidToken(seller);

    let xmlRequest;
    let callName;

    // Construct Media XML if images are present
    let finalMediaUrls = [];
    if (mediaUrls && mediaUrls.length > 0) {
      console.log(`[Send Message] Processing ${mediaUrls.length} images...`);

      // Convert local URLs to file paths and upload to eBay
      for (const url of mediaUrls) {
        try {
          // Extract filename from URL (e.g., http://localhost:5000/uploads/123.jpg -> 123.jpg)
          const filename = url.split('/').pop();
          const filePath = path.join(process.cwd(), 'public/uploads', filename);

          if (fs.existsSync(filePath)) {
            console.log(`[Send Message] Uploading ${filename} to eBay...`);
            const ebayUrl = await uploadImageToEbay(token, filePath);
            console.log(`[Send Message] Uploaded: ${ebayUrl}`);
            finalMediaUrls.push(ebayUrl);
          } else {
            console.warn(`[Send Message] File not found: ${filePath}`);
          }
        } catch (err) {
          console.error(`[Send Message] Failed to upload image: ${err.message}`);
          // Continue with other images if one fails
        }
      }
    }

    // Prepare message body with image URLs (eBay APIs don't support MessageMedia for sending)
    // Always escape the original message body first
    let finalBody = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (finalMediaUrls.length > 0) {
      // Format image URLs as clickable links
      // Try multiple formats to ensure maximum compatibility:
      // 1. Plain URL (eBay should auto-detect)
      // 2. With descriptive text
      const imageLinks = finalMediaUrls.map((url, index) => {
        return `Image ${index + 1}: ${url}`;
      }).join('\n');

      finalBody += '\n\n---\nAttached Image(s):\n' + imageLinks;
      console.log('[Send Message] ⚠️ eBay APIs do not support MessageMedia for outgoing messages. Added URLs to message body.');
    }

    // CASE 1: Transaction Message (Use AddMemberMessageAAQToPartner)
    if (isTransaction) {
      callName = 'AddMemberMessageAAQToPartner';

      xmlRequest = `
        <?xml version="1.0" encoding="utf-8"?>
        <AddMemberMessageAAQToPartnerRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
          <ItemID>${finalItemId}</ItemID>
          <MemberMessage>
            <Body>${finalBody}</Body>
            <Subject>${subject || 'Regarding your order'}</Subject>
            <QuestionType>General</QuestionType>
            <RecipientID>${finalBuyer}</RecipientID>
          </MemberMessage>
        </AddMemberMessageAAQToPartnerRequest>
      `;
    }
    // CASE 2: Inquiry Message (Use AddMemberMessageRTQ - Respond To Question)
    else {
      callName = 'AddMemberMessageRTQ';

      xmlRequest = `
        <?xml version="1.0" encoding="utf-8"?>
        <AddMemberMessageRTQRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
          <ItemID>${finalItemId}</ItemID>
          <MemberMessage>
            <Body>${finalBody}</Body>
            <ParentMessageID>${parentMessageId}</ParentMessageID>
            <RecipientID>${finalBuyer}</RecipientID>
          </MemberMessage>
        </AddMemberMessageRTQRequest>
      `;
    }

    console.log(`[Send Message] Using ${callName} for ${isTransaction ? 'transaction' : 'inquiry'} (Item: ${finalItemId}, Buyer: ${finalBuyer})`);

    const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
        'X-EBAY-API-CALL-NAME': callName,
        'Content-Type': 'text/xml'
      }
    });

    const result = await parseStringPromise(response.data);
    const responseKey = `${callName}Response`;
    const ack = result[responseKey].Ack[0];

    if (ack === 'Success' || ack === 'Warning') {
      // Save to database
      const newMsg = await Message.create({
        seller: seller._id,
        orderId: orderId || null,
        itemId: finalItemId,
        buyerUsername: finalBuyer,
        sender: 'SELLER',
        subject: subject || 'Reply',
        body: body,
        mediaUrls: finalMediaUrls || [],
        read: true,
        messageType: isTransaction ? 'ORDER' : 'INQUIRY',
        messageDate: new Date()
      });

      console.log(`[Send Message] ✅ Message sent successfully using ${callName}`);
      return res.json({ success: true, message: newMsg });
    } else {
      const errMsg = result[responseKey].Errors?.[0]?.LongMessage?.[0] || 'eBay API Error';
      throw new Error(errMsg);
    }

  } catch (err) {
    console.error('Send Message Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. GET THREADS (Sidebar List)

// 4. GET THREADS (With Pagination & Search)
router.get('/chat/threads', requireAuth, async (req, res) => {
  try {
    const { sellerId, page = 1, limit = 20, search = '', filterType = 'ALL', filterMarketplace = '', showUnreadOnly = 'false' } = req.query;


    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build the aggregation pipeline
    const pipeline = [];

    // 1. FILTER BY SELLER
    if (sellerId) {
      pipeline.push({
        $match: { seller: new mongoose.Types.ObjectId(sellerId) }
      });
    }

    // 2. Sort by date (Process latest messages first)
    pipeline.push({ $sort: { messageDate: -1 } });

    // 3. Group by conversation
    pipeline.push({
      $group: {
        _id: {
          orderId: "$orderId",
          buyer: "$buyerUsername",
          item: "$itemId"
        },
        sellerId: { $first: "$seller" },
        lastMessage: { $first: "$body" },
        lastDate: { $first: "$messageDate" },
        sender: { $first: "$sender" },
        itemTitle: { $first: "$itemTitle" },
        messageType: { $first: "$messageType" },
        unreadCount: {
          $sum: { $cond: [{ $and: [{ $eq: ["$read", false] }, { $eq: ["$sender", "BUYER"] }] }, 1, 0] }
        }
      }
    });

    // 4. LOOKUP ORDER DETAILS (For Buyer Name)
    pipeline.push({
      $lookup: {
        from: 'orders',
        localField: '_id.orderId',
        foreignField: 'orderId',
        as: 'orderDetails'
      }
    });

    // 5. FLATTEN & FORMAT
    pipeline.push({
      $project: {
        orderId: "$_id.orderId",
        buyerUsername: "$_id.buyer",
        itemId: "$_id.item",
        sellerId: 1,
        lastMessage: 1,
        lastDate: 1,
        sender: 1,
        itemTitle: 1,
        messageType: 1,
        unreadCount: 1,
        buyerName: { $arrayElemAt: ["$orderDetails.buyer.buyerRegistrationAddress.fullName", 0] },
        // NEW: Get Marketplace ID from Order
        orderMarketplaceId: { $arrayElemAt: ["$orderDetails.purchaseMarketplaceId", 0] }
      }
    });

    // 5.0 LOOKUP LISTING DETAILS (For Currency -> Marketplace fallback)
    pipeline.push({
      $lookup: {
        from: 'listings',
        localField: 'itemId',
        foreignField: 'itemId',
        as: 'listingDetails'
      }
    });

    // 5.1 COMPUTE MARKETPLACE ID
    pipeline.push({
      $addFields: {
        listingCurrency: { $arrayElemAt: ["$listingDetails.currency", 0] }
      }
    });

    pipeline.push({
      $addFields: {
        computedMarketplaceId: {
          $switch: {
            branches: [
              // Case 1: Order exists
              {
                case: { $ifNull: ["$orderMarketplaceId", false] },
                then: "$orderMarketplaceId"
              },
              // Case 2: Listing Currency Map
              { case: { $eq: ["$listingCurrency", "USD"] }, then: "EBAY_US" },
              { case: { $eq: ["$listingCurrency", "CAD"] }, then: "EBAY_CA" },
              { case: { $eq: ["$listingCurrency", "AUD"] }, then: "EBAY_AU" },
              { case: { $eq: ["$listingCurrency", "GBP"] }, then: "EBAY_GB" },
              { case: { $eq: ["$listingCurrency", "EUR"] }, then: "EBAY_DE" },
              // Case 3: Inferred from Item ItemID (basic assumption, can be refined)
              // If we really wanted to we could check site ID here but currency is best proxy
            ],
            default: "Unknown"
          }
        }
      }
    });

    // 5.2. FILTER BY TYPE
    if (filterType === 'ORDER') {
      pipeline.push({
        $match: {
          $or: [
            { messageType: 'ORDER' },
            { orderId: { $ne: null } }
          ]
        }
      });
    } else if (filterType === 'INQUIRY') {
      pipeline.push({
        $match: {
          $and: [
            { messageType: { $ne: 'ORDER' } },
            { orderId: null }
          ]
        }
      });
    }

    // 5.3 FILTER BY MARKETPLACE (NEW)
    if (filterMarketplace && filterMarketplace !== '') {
      // If filtering by specific marketplace
      pipeline.push({
        $match: { computedMarketplaceId: filterMarketplace }
      });
    }

    // 5.4 FILTER BY UNREAD STATUS (NEW)
    if (showUnreadOnly === 'true') {
      pipeline.push({
        $match: { unreadCount: { $gt: 0 } }
      });
    }

    // 6. SEARCH FILTER (Applied AFTER grouping so we search distinct threads)
    if (search && search.trim() !== '') {
      const regex = new RegExp(search.trim(), 'i'); // Case-insensitive
      pipeline.push({
        $match: {
          $or: [
            { orderId: regex },
            { buyerUsername: regex },
            { buyerName: regex },
            { itemId: regex }
          ]
        }
      });
    }

    // 7. FINAL SORT & PAGINATION
    pipeline.push({ $sort: { lastDate: -1 } });

    // Get Total Count (for frontend to know when to stop loading)
    // We use $facet to get both data and count in one query
    const facetedPipeline = [
      ...pipeline,
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [{ $skip: skip }, { $limit: limitNum }]
        }
      }
    ];

    const result = await Message.aggregate(facetedPipeline);

    const threads = result[0].data;
    const total = result[0].metadata[0] ? result[0].metadata[0].total : 0;

    // --- NEW: MARKETPLACE RESOLUTION LOGIC ---
    // Process threads to add 'marketplaceId'
    // 1. Order -> purchaseMarketplaceId
    // 2. Listing currency -> Inferred Marketplace
    // 3. API -> GetItem -> Site -> Marketplace

    // Currency Map
    const currencyToMarketplace = {
      'USD': 'EBAY_US',
      'CAD': 'EBAY_CA',
      'AUD': 'EBAY_AU',
      'GBP': 'EBAY_GB',
      'EUR': 'EBAY_DE' // Defaulting EUR to DE as it's most common, but could be others. 
      // Ideally we want specific site ID from API if inconsistent.
    };

    // Helper to get Site ID from API
    async function fetchItemSiteFromApi(itemId, sellerId) {
      try {
        const seller = await Seller.findById(sellerId);
        if (!seller) return null;

        const token = await ensureValidToken(seller);

        const xmlRequest = `
          <?xml version="1.0" encoding="utf-8"?>
          <GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
            <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
            <ErrorLanguage>en_US</ErrorLanguage>
            <WarningLevel>High</WarningLevel>
            <ItemID>${itemId}</ItemID>
            <DetailLevel>ItemReturnDescription</DetailLevel>
            <IncludeItemSpecifics>false</IncludeItemSpecifics>
          </GetItemRequest>
        `;

        const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
          headers: {
            'X-EBAY-API-SITEID': '0',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
            'X-EBAY-API-CALL-NAME': 'GetItem',
            'Content-Type': 'text/xml'
          }
        });

        const result = await parseStringPromise(response.data);
        if (result.GetItemResponse.Ack[0] === 'Failure') return null;

        const item = result.GetItemResponse.Item[0];
        const site = item.Site[0]; // e.g. "US", "Canada", "Australia"
        const currency = item.Currency[0]; // e.g., "USD"

        // Map Site to ID
        const siteMap = {
          'US': 'EBAY_US',
          'Canada': 'EBAY_CA',
          'Australia': 'EBAY_AU',
          'UK': 'EBAY_GB',
          'Germany': 'EBAY_DE',
          'France': 'EBAY_FR',
          'Italy': 'EBAY_IT',
          'Spain': 'EBAY_ES'
        };

        return {
          marketplaceId: siteMap[site] || 'EBAY_US', // Default to US if unknown
          currency: currency
        };

      } catch (err) {
        console.error(`[Fetch Item Site] Failed for ${itemId}:`, err.message);
        return null;
      }
    }

    // Process in parallel
    await Promise.all(threads.map(async (thread) => {
      // Use computed value from aggregation if available and valid
      if (thread.computedMarketplaceId && thread.computedMarketplaceId !== 'Unknown') {
        thread.marketplaceId = thread.computedMarketplaceId;
        return;
      }

      // Fallback: Check if we have valid IDs to check API (Only if computed was Unknown)
      if (thread.itemId && thread.itemId !== 'DIRECT_MESSAGE') {
        const apiResult = await fetchItemSiteFromApi(thread.itemId, thread.sellerId);
        if (apiResult) {
          thread.marketplaceId = apiResult.marketplaceId;

          // Save to Listing DB so next time it's fast
          try {
            await Listing.findOneAndUpdate(
              { itemId: thread.itemId },
              {
                seller: thread.sellerId,
                itemId: thread.itemId,
                currency: apiResult.currency,
              },
              { upsert: true, setDefaultsOnInsert: true }
            );
          } catch (e) {
            console.error('Failed to cache listing marketplace', e);
          }
        } else {
          thread.marketplaceId = 'Unknown';
        }
      } else {
        thread.marketplaceId = 'System'; // Direct messages
      }
    }));

    res.json({ threads, total, page: pageNum, pages: Math.ceil(total / limitNum) });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});




// 5. GET MESSAGES (Chat Window)
router.get('/chat/messages', requireAuth, async (req, res) => {
  const { orderId, buyerUsername, itemId } = req.query;

  try {
    let query = {};
    if (orderId) {
      query.orderId = orderId;
    } else if (buyerUsername && itemId) {
      query.buyerUsername = buyerUsername;
      query.itemId = itemId;
    } else {
      return res.status(400).json({ error: 'Invalid query params' });
    }

    const messages = await Message.find(query).sort({ messageDate: 1 });

    // Mark as read
    await Message.updateMany(
      { ...query, sender: 'BUYER', read: false },
      { read: true }
    );

    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. SEARCH ORDER FOR NEW CHAT

router.get('/chat/search-order', requireAuth, async (req, res) => {
  const { orderId } = req.query;
  try {
    const order = await Order.findOne({ orderId }).populate('seller');
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Get Full Name
    const fullName = order.shippingFullName || order.buyer?.buyerRegistrationAddress?.fullName || order.buyer?.username;

    const threadData = {
      orderId: order.orderId,
      buyerUsername: order.buyer.username,
      buyerName: fullName,
      itemId: order.lineItems?.[0]?.legacyItemId,
      itemTitle: order.productName,
      sellerId: order.seller._id,
      lastMessage: 'Start a new conversation...',
      lastDate: new Date(),
      sender: 'SYSTEM',
      unreadCount: 0,
      messageType: 'ORDER',
      isNew: true
    };

    res.json(threadData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. MARK CONVERSATION AS UNREAD
router.post('/chat/mark-unread', requireAuth, async (req, res) => {
  const { orderId, buyerUsername, itemId } = req.body;

  try {
    let query = {};
    if (orderId) {
      query.orderId = orderId;
    } else if (buyerUsername && itemId) {
      query.buyerUsername = buyerUsername;
      query.itemId = itemId;
    } else {
      return res.status(400).json({ error: 'Invalid query params' });
    }

    // Mark buyer messages as unread
    const result = await Message.updateMany(
      { ...query, sender: 'BUYER' },
      { read: false }
    );

    res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== BUYER MESSAGES ENDPOINTS =====

// Fetch buyer messages/inquiries from eBay Post-Order API and store in DB
// Fetch buyer messages/inquiries from eBay Post-Order API and store in DB
router.post('/fetch-messages', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true } })
      .populate('user', 'username');

    if (sellers.length === 0) {
      return res.json({ message: 'No sellers with eBay tokens found', totalMessages: 0 });
    }

    let totalNewMessages = 0;
    let totalUpdatedMessages = 0;
    const errors = [];

    console.log(`[Fetch Messages] Starting for ${sellers.length} sellers`);

    const results = await Promise.allSettled(
      sellers.map(async (seller) => {
        const sellerName = seller.user?.username || 'Unknown Seller';

        try {
          // Token refresh logic
          const nowUTC = Date.now();
          const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
          const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
          let accessToken = seller.ebayTokens.access_token;

          if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
            console.log(`[Fetch Messages] Refreshing token for seller ${sellerName}`);
            const refreshRes = await axios.post(
              'https://api.ebay.com/identity/v1/oauth2/token',
              qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: seller.ebayTokens.refresh_token,
                scope: EBAY_OAUTH_SCOPES // Using centralized scopes constant
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
                },
              }
            );
            accessToken = refreshRes.data.access_token;
            seller.ebayTokens.access_token = accessToken;
            seller.ebayTokens.expires_in = refreshRes.data.expires_in;
            seller.ebayTokens.fetchedAt = new Date(nowUTC);
            await seller.save();
          }

          // Fetch inquiries
          const inquiryUrl = 'https://api.ebay.com/post-order/v2/inquiry/search';
          const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

          const inquiryRes = await axios.get(inquiryUrl, {
            headers: {
              'Authorization': `IAF ${accessToken}`,
              'Content-Type': 'application/json',
              'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
            },
            params: {
              'creation_date_range_from': ninetyDaysAgo,
              'limit': 200
            }
          });

          const inquiries = inquiryRes.data.members || [];
          console.log(`[Fetch Messages] Seller ${sellerName}: Found ${inquiries.length} inquiries`);

          let newMessages = 0;
          let updatedMessages = 0;

          for (const inquiry of inquiries) {
            // FIX: Access nested .value for dates and use correct field names
            const messageData = {
              seller: seller._id,
              messageId: inquiry.inquiryId,
              orderId: inquiry.orderId || inquiry.orderNumber,
              legacyOrderId: inquiry.legacyOrderId,
              buyerUsername: inquiry.buyerLoginName, // Fixed field name
              subject: inquiry.inquirySubject,
              messageText: inquiry.initialInquiryText || inquiry.message, // Check both
              messageType: 'INQUIRY',
              inquiryStatus: inquiry.state || inquiry.status, // API uses 'state' usually
              itemId: inquiry.itemId,
              itemTitle: inquiry.itemTitle,
              isResolved: ['CLOSED', 'SELLER_CLOSED'].includes(inquiry.state),
              // FIX: Dates are objects { value: "..." }
              creationDate: inquiry.creationDate?.value ? new Date(inquiry.creationDate.value) : null,
              responseDate: inquiry.sellerResponseDue?.respondByDate?.value ? new Date(inquiry.sellerResponseDue.respondByDate.value) : null,
              lastMessageDate: inquiry.lastMessageDate?.value ? new Date(inquiry.lastMessageDate.value) : null,
              rawData: inquiry
            };

            const existing = await Message.findOne({ messageId: inquiry.inquiryId });
            if (existing) {
              Object.assign(existing, messageData);
              await existing.save();
              updatedMessages++;
            } else {
              await Message.create(messageData);
              newMessages++;
            }
          }

          return {
            sellerName: sellerName,
            newMessages,
            updatedMessages,
            totalMessages: inquiries.length
          };

        } catch (err) {
          console.error(`[Fetch Messages] Error for seller ${sellerName}:`, err.message);
          throw new Error(`${sellerName}: ${err.message}`);
        }
      })
    );

    const successResults = [];
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        successResults.push(result.value);
        totalNewMessages += result.value.newMessages;
        totalUpdatedMessages += result.value.updatedMessages;
      } else {
        errors.push(result.reason.message);
      }
    });

    res.json({
      message: `Fetched messages for ${successResults.length} sellers`,
      totalNewMessages,
      totalUpdatedMessages,
      results: successResults,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error('[Fetch Messages] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get stored messages from database
router.get('/stored-messages', async (req, res) => {
  const { sellerId, isResolved, limit = 100 } = req.query;

  try {
    let query = {};
    if (sellerId) {
      query.seller = sellerId;
    }
    if (isResolved !== undefined && isResolved !== '') {
      query.isResolved = isResolved === 'true';
    }

    const messages = await Message.find(query)
      .populate('seller', 'username ebayUserId')
      .sort({ creationDate: -1 })
      .limit(parseInt(limit));

    res.json({
      messages,
      totalMessages: messages.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// Mark message as resolved
router.patch('/messages/:messageId/resolve', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  const { messageId } = req.params;
  const { isResolved } = req.body;

  if (isResolved === undefined || isResolved === null) {
    return res.status(400).json({ error: 'isResolved field is required' });
  }

  try {
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    message.isResolved = isResolved;
    if (isResolved) {
      message.resolvedAt = new Date();
      message.resolvedBy = req.user?.username || 'admin';
    } else {
      message.resolvedAt = null;
      message.resolvedBy = null;
    }

    await message.save();

    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- HELPER: Robust Description Extractor ---
function extractCleanDescription(fullHtml) {
  if (!fullHtml || typeof fullHtml !== 'string') return '';

  // 1. Perfect Match (Title H3 + Description Div)
  const perfectMatch = fullHtml.match(/(<h3[^>]*>[\s\S]*?<\/h3>[\s\S]*?<div class="product-description">[\s\S]*?<\/div>)/i);
  if (perfectMatch && perfectMatch[0]) return perfectMatch[0];

  // 2. Just the Description Div
  const divMatch = fullHtml.match(/(<div class="product-description">[\s\S]*?<\/div>)/i);
  if (divMatch && divMatch[0]) return divMatch[0];

  // 3. Fallback: Return Full HTML (This ensures you see SOMETHING)
  return fullHtml;
}

// 1. POLL ACTIVE LISTINGS (With Pagination Loop)
router.post('/sync-listings', requireAuth, async (req, res) => {
  const { sellerId } = req.body;

  try {
    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: "Seller not found" });

    const token = await ensureValidToken(seller);

    // --- DATE LOGIC ---
    // Req: Nov 27, 2025 at 5:00 AM IST -> Nov 26, 23:30 UTC
    const hardStartDate = new Date('2025-11-26T23:30:00Z');
    const nov11StartDate = new Date('2025-11-11T09:00:00Z');

    // 1. Calculate count (This is correct now!)
    const listingCount = await Listing.countDocuments({ seller: sellerId, listingStatus: 'Active' });

    let startTimeFrom;

    if (listingCount === 0) {
      // CASE A: NEW SELLER (Zero Listings)
      console.log(`[Sync Listings] New seller detected (0 listings). Starting sync from Nov 11 (PST).`);
      startTimeFrom = nov11StartDate;
    } else {
      // CASE B: EXISTING SELLER
      // FIX: Use 'hardStartDate' variable name here
      startTimeFrom = seller.lastListingPolledAt || hardStartDate;

      // Safety: If their last poll was somehow older than the old default
      if (new Date(startTimeFrom) < hardStartDate) {
        startTimeFrom = hardStartDate;
      }
    }

    const startTimeTo = new Date();
    let page = 1;
    let totalPages = 1;
    let processedCount = 0;
    let skippedCount = 0;

    const VALID_MOTORS_CATEGORIES = ["eBay Motors", "Parts & Accessories", "Automotive Tools", "Tools & Supplies"];

    do {
      console.log(`Fetching Page ${page} (Filter: Motors Only)...`);

      const xmlRequest = `
          <?xml version="1.0" encoding="utf-8"?>
          <GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
            <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
            <ErrorLanguage>en_US</ErrorLanguage>
            <WarningLevel>High</WarningLevel>
            <DetailLevel>ItemReturnDescription</DetailLevel> 
            <StartTimeFrom>${new Date(startTimeFrom).toISOString()}</StartTimeFrom>
            <StartTimeTo>${startTimeTo.toISOString()}</StartTimeTo>
            <IncludeWatchCount>true</IncludeWatchCount>
            <Pagination>
              <EntriesPerPage>100</EntriesPerPage>
              <PageNumber>${page}</PageNumber>
            </Pagination>
            <OutputSelector>ItemArray.Item.ItemID</OutputSelector>
            <OutputSelector>ItemArray.Item.Title</OutputSelector>
            <OutputSelector>ItemArray.Item.SKU</OutputSelector>
            <OutputSelector>ItemArray.Item.SellingStatus</OutputSelector>
            <OutputSelector>ItemArray.Item.ListingStatus</OutputSelector>
            <OutputSelector>ItemArray.Item.Description</OutputSelector>
            <OutputSelector>ItemArray.Item.PictureDetails</OutputSelector>
            <OutputSelector>ItemArray.Item.ItemCompatibilityList</OutputSelector>
            <OutputSelector>ItemArray.Item.PrimaryCategory</OutputSelector> 
            <OutputSelector>ItemArray.Item.ListingDetails</OutputSelector>
            <OutputSelector>PaginationResult</OutputSelector>
          </GetSellerListRequest>
        `;

      const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
        headers: {
          'X-EBAY-API-SITEID': '100',
          'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
          'X-EBAY-API-CALL-NAME': 'GetSellerList',
          'Content-Type': 'text/xml'
        }
      });

      const result = await parseStringPromise(response.data);
      if (result.GetSellerListResponse.Ack[0] === 'Failure') {
        throw new Error(result.GetSellerListResponse.Errors[0].LongMessage[0]);
      }

      const pagination = result.GetSellerListResponse.PaginationResult[0];
      totalPages = parseInt(pagination.TotalNumberOfPages[0]);
      const items = result.GetSellerListResponse.ItemArray?.[0]?.Item || [];

      for (const item of items) {
        const status = item.SellingStatus?.[0]?.ListingStatus?.[0];
        if (status !== 'Active') continue;

        // Filter by Category
        const categoryName = item.PrimaryCategory?.[0]?.CategoryName?.[0] || '';
        const isMotorsItem = VALID_MOTORS_CATEGORIES.some(keyword => categoryName.includes(keyword));
        if (!isMotorsItem) {
          skippedCount++;
          continue;
        }

        const rawHtml = item.Description ? item.Description[0] : '';
        const cleanHtml = extractCleanDescription(rawHtml);

        // Extract EXISTING Compatibility from eBay
        let parsedCompatibility = [];
        if (item.ItemCompatibilityList && item.ItemCompatibilityList[0].Compatibility) {
          parsedCompatibility = item.ItemCompatibilityList[0].Compatibility.map(comp => ({
            notes: comp.CompatibilityNotes ? comp.CompatibilityNotes[0] : '',
            nameValueList: comp.NameValueList.map(nv => ({
              name: nv.Name[0],
              value: nv.Value[0]
            }))
          }));
        }

        // Upsert to DB (Updates existing if found, Creates new if not)
        await Listing.findOneAndUpdate(
          { itemId: item.ItemID[0] },
          {
            seller: seller._id,
            title: item.Title[0],
            sku: item.SKU ? item.SKU[0] : '',
            currentPrice: parseFloat(item.SellingStatus[0].CurrentPrice[0]._),
            currency: item.SellingStatus[0].CurrentPrice[0].$.currencyID,
            listingStatus: status,
            mainImageUrl: item.PictureDetails?.[0]?.PictureURL?.[0] || '',
            categoryName: categoryName, // Store category for filtering
            descriptionPreview: cleanHtml,
            compatibility: parsedCompatibility,
            // Save the START TIME for sorting
            startTime: item.ListingDetails?.[0]?.StartTime?.[0]
          },
          { upsert: true }
        );
        processedCount++;
      }
      page++;
    } while (page <= totalPages);

    seller.lastListingPolledAt = startTimeTo;
    await seller.save();

    res.json({
      success: true,
      message: `Synced ${processedCount} Motors listings. (Skipped ${skippedCount} others).`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. GET LISTINGS (With Search & Sort) - For Compatibility Dashboard (Uses Listing collection)
router.get('/listings', requireAuth, async (req, res) => {
  const { sellerId, page = 1, limit = 50, search } = req.query;
  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Base Query
    let query = { seller: sellerId, listingStatus: 'Active' };

    // --- SEARCH LOGIC ---
    if (search && search.trim() !== '') {
      const searchRegex = { $regex: search.trim(), $options: 'i' };
      query.$or = [
        { title: searchRegex },
        { sku: searchRegex },
        { itemId: searchRegex }
      ];
    }

    const totalDocs = await Listing.countDocuments(query);

    const listings = await Listing.find(query)
      .sort({ startTime: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      listings,
      pagination: {
        total: totalDocs,
        page: pageNum,
        pages: Math.ceil(totalDocs / limitNum)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. REFRESH SINGLE ITEM (GetItem)
router.post('/refresh-item', requireAuth, async (req, res) => {
  const { sellerId, itemId } = req.body;

  try {
    const seller = await Seller.findById(sellerId);
    const token = await ensureValidToken(seller);

    const xmlRequest = `
        <?xml version="1.0" encoding="utf-8"?>
        <GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
          <ErrorLanguage>en_US</ErrorLanguage>
          <WarningLevel>High</WarningLevel>
          <ItemID>${itemId}</ItemID>
          <DetailLevel>ItemReturnDescription</DetailLevel>
          <IncludeItemSpecifics>true</IncludeItemSpecifics>
        </GetItemRequest>
      `;

    const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
      headers: {
        'X-EBAY-API-SITEID': '100',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'Content-Type': 'text/xml'
      }
    });

    const result = await parseStringPromise(response.data);
    const item = result.GetItemResponse.Item[0];

    const rawHtml = item.Description ? item.Description[0] : '';
    const cleanHtml = extractCleanDescription(rawHtml);

    let parsedCompatibility = [];
    if (item.ItemCompatibilityList && item.ItemCompatibilityList[0].Compatibility) {
      parsedCompatibility = item.ItemCompatibilityList[0].Compatibility.map(comp => ({
        notes: comp.CompatibilityNotes ? comp.CompatibilityNotes[0] : '',
        nameValueList: comp.NameValueList.map(nv => ({
          name: nv.Name[0],
          value: nv.Value[0]
        }))
      }));
    }

    const updatedListing = await Listing.findOneAndUpdate(
      { itemId: itemId },
      {
        seller: seller._id,
        title: item.Title[0],
        sku: item.SKU ? item.SKU[0] : '',
        descriptionPreview: cleanHtml,
        compatibility: parsedCompatibility,
        mainImageUrl: item.PictureDetails?.[0]?.PictureURL?.[0] || '',
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, listing: updatedListing });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to clean text for XML (turns "&" into "&amp;")
const escapeXml = (unsafe) => {
  if (!unsafe) return '';
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
};

// ============================================
// API USAGE STATS CACHE (5-minute TTL)
// ============================================
const apiUsageCache = new Map();

// Helper: Fetch eBay API usage stats using modern Analytics API (REST/JSON)
async function fetchApiUsageStats(token) {
  try {
    // Use the modern Analytics API (REST-based, JSON response)
    const response = await axios.get(
      'https://api.ebay.com/developer/analytics/v1_beta/rate_limit/',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        params: {
          api_name: 'TradingAPI',
          api_context: 'TradingAPI'
        }
      }
    );

    const rateLimits = response.data?.rateLimits || [];

    // Find the TradingAPI context
    const tradingAPI = rateLimits.find(
      api => api.apiContext === 'TradingAPI' || api.apiName === 'TradingAPI'
    );

    if (!tradingAPI || !tradingAPI.resources) {
      // Return default if no data found
      return {
        success: true,
        used: 0,
        limit: 5000,
        remaining: 5000,
        resetTime: new Date(Date.now() + 86400000).toISOString(), // 24 hours from now
        hoursUntilReset: 24
      };
    }

    // Find ReviseFixedPriceItem resource
    const reviseResource = tradingAPI.resources.find(
      r => r.name === 'ReviseFixedPriceItem'
    );

    if (!reviseResource || !reviseResource.rates || reviseResource.rates.length === 0) {
      // Return default if specific resource not found
      return {
        success: true,
        used: 0,
        limit: 5000,
        remaining: 5000,
        resetTime: new Date(Date.now() + 86400000).toISOString(),
        hoursUntilReset: 24
      };
    }

    // Get the daily rate limit (timeWindow = 86400 seconds = 1 day)
    const dailyRate = reviseResource.rates.find(r => r.timeWindow === 86400) || reviseResource.rates[0];

    const used = dailyRate.count || 0;
    const limit = dailyRate.limit || 5000;
    const remaining = dailyRate.remaining || (limit - used);
    const resetTime = dailyRate.reset || new Date(Date.now() + 86400000).toISOString();

    // Calculate hours until reset
    const resetDate = new Date(resetTime);
    const now = new Date();
    const diffMs = resetDate - now;
    const hoursUntilReset = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60)));

    return {
      success: true,
      used: used,
      limit: limit,
      remaining: remaining,
      resetTime: resetTime,
      hoursUntilReset: hoursUntilReset
    };
  } catch (err) {
    console.error('Error fetching API usage stats:', err.message);

    // If error response contains rate limit data, try to parse it
    if (err.response?.data) {
      console.error('API Response:', JSON.stringify(err.response.data, null, 2));
    }

    throw err;
  }
}

// Helper: Get cached or fresh usage stats
async function getCachedUsageStats(sellerId, token) {
  const cacheKey = `usage_${sellerId}`;
  const cached = apiUsageCache.get(cacheKey);

  // Return cached if less than 5 minutes old
  if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000)) {
    return cached.data;
  }

  // Fetch fresh data
  const freshData = await fetchApiUsageStats(token);
  apiUsageCache.set(cacheKey, {
    data: freshData,
    timestamp: Date.now()
  });

  return freshData;
}

// 4. UPDATE COMPATIBILITY (Using ReplaceAll Strategy)
router.post('/update-compatibility', requireAuth, async (req, res) => {
  const { sellerId, itemId, compatibilityList } = req.body;
  try {
    const seller = await Seller.findById(sellerId);
    const token = await ensureValidToken(seller);

    let itemInnerContent = `<ItemID>${itemId}</ItemID>`;

    // CASE 1: Clearing all vehicles (Send Empty List with ReplaceAll)
    if (!compatibilityList || compatibilityList.length === 0) {
      // This tells eBay: "Here is the list. It is empty. Replace everything with this empty list."
      itemInnerContent += `
                <ItemCompatibilityList>
                    <ReplaceAll>true</ReplaceAll>
                </ItemCompatibilityList>
            `;
    }
    // CASE 2: Sending a specific list (Overwrite old list)
    else {
      let compatXml = '<ItemCompatibilityList>';

      // --- THE FIX: This magic tag forces eBay to wipe old data first ---
      compatXml += '<ReplaceAll>true</ReplaceAll>';
      // -----------------------------------------------------------------

      compatibilityList.forEach(c => {
        compatXml += '<Compatibility>';
        // Escape Notes (Fixes "&" error)
        if (c.notes) compatXml += `<CompatibilityNotes>${escapeXml(c.notes)}</CompatibilityNotes>`;

        c.nameValueList.forEach(nv => {
          // Escape Name and Value (Fixes "Town & Country" error)
          compatXml += `<NameValueList><Name>${escapeXml(nv.name)}</Name><Value>${escapeXml(nv.value)}</Value></NameValueList>`;
        });
        compatXml += '</Compatibility>';
      });
      compatXml += '</ItemCompatibilityList>';

      itemInnerContent += compatXml;
    }

    const xmlRequest = `
            <?xml version="1.0" encoding="utf-8"?>
            <ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
                <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
                <ErrorLanguage>en_US</ErrorLanguage>
                <WarningLevel>High</WarningLevel>
                
                <Item>
                    ${itemInnerContent}
                </Item>

            </ReviseFixedPriceItemRequest>
        `;

    const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
      headers: { 'X-EBAY-API-SITEID': '100', 'X-EBAY-API-COMPATIBILITY-LEVEL': '1423', 'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem', 'Content-Type': 'text/xml' }
    });

    const result = await parseStringPromise(response.data);
    const ack = result.ReviseFixedPriceItemResponse.Ack[0];

    // 1. Handle Failures
    if (ack === 'Failure') {
      const errors = result.ReviseFixedPriceItemResponse.Errors || [];
      const errorMessage = errors.map(e => e.LongMessage[0]).join('; ');

      // Check if it's a rate limit error
      const isRateLimitError = errorMessage.includes('exceeded usage limit') ||
        errorMessage.includes('call limit') ||
        errorMessage.includes('Developer Analytics API');

      if (isRateLimitError) {
        try {
          // Fetch usage stats
          const usageStats = await getCachedUsageStats(sellerId, token);
          return res.status(429).json({
            error: errorMessage,
            rateLimitInfo: {
              used: usageStats.used,
              limit: usageStats.limit,
              remaining: usageStats.remaining,
              resetTime: usageStats.resetTime,
              hoursUntilReset: usageStats.hoursUntilReset
            }
          });
        } catch (statsError) {
          // If stats fetch fails, still return rate limit error
          console.error('Failed to fetch usage stats:', statsError.message);
          return res.status(429).json({ error: errorMessage });
        }
      }

      throw new Error(`eBay Failed: ${errorMessage}`);
    }

    // 2. Handle Warnings
    let warningMessage = null;
    if (ack === 'Warning') {
      const warnings = result.ReviseFixedPriceItemResponse.Errors || [];

      const meaningfulWarnings = warnings.filter(err => {
        const msg = err.LongMessage[0];
        if (msg.includes("If this item sells by a Best Offer")) return false;
        if (msg.includes("Funds from your sales may be unavailable")) return false; // <--- ADD THIS
        return true;
      });

      if (meaningfulWarnings.length > 0) {
        warningMessage = meaningfulWarnings.map(e => e.LongMessage[0]).join('; ');
        console.warn(`eBay Update Warning: ${warningMessage}`);
      }
    }

    // 3. Update DB
    await Listing.findOneAndUpdate(
      { itemId: itemId },
      { compatibility: compatibilityList }
    );

    res.json({ success: true, warning: warningMessage });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// EDIT ACTIVE LISTINGS - SYNC ALL LISTINGS
// ============================================
// Syncs ALL active listings (not just Motors) for editing title/description/price
router.post('/sync-all-listings', requireAuth, async (req, res) => {
  const { sellerId } = req.body;

  try {
    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: "Seller not found" });

    const token = await ensureValidToken(seller);

    // Use a fixed start date for initial sync (Feb 3, 2026)
    const defaultStartDate = new Date('2026-02-03T00:00:00Z');
    const startTimeFrom = seller.lastAllListingsPolledAt || defaultStartDate;
    const startTimeTo = new Date();

    let page = 1;
    let totalPages = 1;
    let processedCount = 0;

    do {
      console.log(`[Sync All Listings] Fetching Page ${page}...`);

      const xmlRequest = `
        <?xml version="1.0" encoding="utf-8"?>
        <GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
          <ErrorLanguage>en_US</ErrorLanguage>
          <WarningLevel>High</WarningLevel>
          <DetailLevel>ItemReturnDescription</DetailLevel>
          <StartTimeFrom>${new Date(startTimeFrom).toISOString()}</StartTimeFrom>
          <StartTimeTo>${startTimeTo.toISOString()}</StartTimeTo>
          <IncludeWatchCount>true</IncludeWatchCount>
          <Pagination>
            <EntriesPerPage>100</EntriesPerPage>
            <PageNumber>${page}</PageNumber>
          </Pagination>
          <OutputSelector>ItemArray.Item.ItemID</OutputSelector>
          <OutputSelector>ItemArray.Item.Title</OutputSelector>
          <OutputSelector>ItemArray.Item.SKU</OutputSelector>
          <OutputSelector>ItemArray.Item.SellingStatus</OutputSelector>
          <OutputSelector>ItemArray.Item.ListingStatus</OutputSelector>
          <OutputSelector>ItemArray.Item.Description</OutputSelector>
          <OutputSelector>ItemArray.Item.PictureDetails</OutputSelector>
          <OutputSelector>ItemArray.Item.PrimaryCategory</OutputSelector>
          <OutputSelector>ItemArray.Item.ListingDetails</OutputSelector>
          <OutputSelector>PaginationResult</OutputSelector>
        </GetSellerListRequest>
      `;

      const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
        headers: {
          'X-EBAY-API-SITEID': '0', // Use SiteID 0 for all listings (not just Motors)
          'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
          'X-EBAY-API-CALL-NAME': 'GetSellerList',
          'Content-Type': 'text/xml'
        }
      });

      const result = await parseStringPromise(response.data);
      if (result.GetSellerListResponse.Ack[0] === 'Failure') {
        throw new Error(result.GetSellerListResponse.Errors[0].LongMessage[0]);
      }

      const pagination = result.GetSellerListResponse.PaginationResult[0];
      totalPages = parseInt(pagination.TotalNumberOfPages[0]);
      const items = result.GetSellerListResponse.ItemArray?.[0]?.Item || [];

      for (const item of items) {
        const status = item.SellingStatus?.[0]?.ListingStatus?.[0];
        if (status !== 'Active') continue;

        const categoryName = item.PrimaryCategory?.[0]?.CategoryName?.[0] || '';
        const rawHtml = item.Description ? item.Description[0] : '';
        const cleanHtml = extractCleanDescription(rawHtml);

        // Upsert to ActiveListing collection (separate from Motors Listing collection)
        await ActiveListing.findOneAndUpdate(
          { itemId: item.ItemID[0] },
          {
            seller: seller._id,
            title: item.Title[0],
            sku: item.SKU ? item.SKU[0] : '',
            currentPrice: parseFloat(item.SellingStatus[0].CurrentPrice[0]._),
            currency: item.SellingStatus[0].CurrentPrice[0].$.currencyID,
            listingStatus: status,
            mainImageUrl: item.PictureDetails?.[0]?.PictureURL?.[0] || '',
            categoryName: categoryName,
            descriptionPreview: cleanHtml,
            startTime: item.ListingDetails?.[0]?.StartTime?.[0]
          },
          { upsert: true }
        );
        processedCount++;
      }
      page++;
    } while (page <= totalPages);

    // Update last polled timestamp
    seller.lastAllListingsPolledAt = startTimeTo;
    await seller.save();

    res.json({
      success: true,
      message: `Synced ${processedCount} active listings.`
    });

  } catch (err) {
    console.error('[Sync All Listings] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET ALL LISTINGS (Without Motors filter)
router.get('/all-listings', requireAuth, async (req, res) => {
  const { sellerId, page = 1, limit = 50, search } = req.query;
  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Base Query - no category filter
    let query = { seller: sellerId, listingStatus: 'Active' };

    // Search Logic
    if (search && search.trim() !== '') {
      const searchRegex = { $regex: search.trim(), $options: 'i' };
      query.$or = [
        { title: searchRegex },
        { sku: searchRegex },
        { itemId: searchRegex }
      ];
    }

    const totalDocs = await ActiveListing.countDocuments(query);
    const listings = await ActiveListing.find(query)
      .sort({ startTime: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      listings,
      pagination: {
        total: totalDocs,
        page: pageNum,
        pages: Math.ceil(totalDocs / limitNum)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE LISTING (Title, Description, Price)
router.post('/update-listing', requireAuth, async (req, res) => {
  const { sellerId, itemId, title, description, price } = req.body;

  try {
    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);

    // Build Item XML content
    let itemContent = `<ItemID>${itemId}</ItemID>`;

    if (title) {
      itemContent += `<Title>${escapeXml(title)}</Title>`;
    }

    if (description !== undefined) {
      // Wrap description in CDATA to preserve HTML
      itemContent += `<Description><![CDATA[${description}]]></Description>`;
    }

    if (price !== undefined && price !== null) {
      itemContent += `<StartPrice>${parseFloat(price).toFixed(2)}</StartPrice>`;
    }

    const xmlRequest = `
      <?xml version="1.0" encoding="utf-8"?>
      <ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
        <ErrorLanguage>en_US</ErrorLanguage>
        <WarningLevel>Low</WarningLevel>
        <Item>
          ${itemContent}
        </Item>
      </ReviseFixedPriceItemRequest>
    `;

    const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
        'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
        'Content-Type': 'text/xml'
      }
    });

    const result = await parseStringPromise(response.data);
    const ack = result.ReviseFixedPriceItemResponse.Ack[0];

    // Handle Failures - show all errors to user
    if (ack === 'Failure') {
      const errors = result.ReviseFixedPriceItemResponse.Errors || [];
      const errorMessage = errors.map(e => e.LongMessage?.[0]).join('; ');
      throw new Error(`eBay Error: ${errorMessage}`);
    }

    // Handle Warnings - show all warnings to user
    let warningMessage = null;
    if (ack === 'Warning') {
      const warnings = result.ReviseFixedPriceItemResponse.Errors || [];
      warningMessage = warnings.map(e => e.LongMessage?.[0]).join('; ');
    }

    console.log(`[Update Listing] Success! ItemID: ${result.ReviseFixedPriceItemResponse.ItemID?.[0]}`);

    // Update local DB
    const updateFields = {};
    if (title) updateFields.title = title;
    if (description !== undefined) updateFields.descriptionPreview = extractCleanDescription(description);
    if (price !== undefined && price !== null) updateFields.currentPrice = parseFloat(price);

    if (Object.keys(updateFields).length > 0) {
      await ActiveListing.findOneAndUpdate(
        { itemId: itemId },
        updateFields
      );
    }

    res.json({ success: true, warning: warningMessage });

  } catch (err) {
    console.error('[Update Listing] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// 4.5. GET EBAY API USAGE STATS
router.get('/api-usage-stats', requireAuth, async (req, res) => {
  const { sellerId } = req.query;

  if (!sellerId) {
    return res.status(400).json({ error: 'sellerId is required' });
  }

  try {
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    const token = await ensureValidToken(seller);
    const stats = await getCachedUsageStats(sellerId, token);

    res.json(stats);
  } catch (err) {
    console.error('Error fetching API usage stats:', err.message);
    res.status(500).json({
      error: 'Failed to fetch API usage stats',
      success: false
    });
  }
});

// 5. GET COMPATIBILITY METADATA (REST API Version)
router.post('/compatibility/values', requireAuth, async (req, res) => {
  const { sellerId, propertyName, constraints } = req.body;

  try {
    // 1. GENERATE CACHE KEY
    // Unique key based on all constraints (e.g. "Year_Make_Nissan_Model_370Z")
    let cacheKey = propertyName;
    if (constraints && constraints.length > 0) {
      const sortedParams = constraints
        .map(c => `${c.name}_${c.value}`)
        .sort()
        .join('_');
      cacheKey = `${propertyName}_${sortedParams}`;
    }

    // 2. CHECK DB CACHE
    const cachedData = await FitmentCache.findOne({ cacheKey });
    if (cachedData) {
      return res.json({ values: cachedData.values });
    }

    // 3. FETCH FROM EBAY (REST Taxonomy API)
    const seller = await Seller.findById(sellerId);
    const token = await ensureValidToken(seller);

    // Build Filter String for REST API
    // FIX: Process ALL constraints, not just the first one.
    // Format: "Make:Nissan,Model:370Z"
    let filterParam = '';
    if (constraints && constraints.length > 0) {
      const filters = constraints.map(c => {
        // Remove quotes and escape commas within the value itself
        const cleanValue = String(c.value).replace(/,/g, '\\,');
        return `${c.name}:${cleanValue}`;
      });
      filterParam = filters.join(',');
    }

    console.log(`[Fitment] Fetching ${propertyName} from eBay (Cat: 33559)... Filter: ${filterParam}`);

    const response = await axios.get(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/100/get_compatibility_property_values`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
        },
        params: {
          category_id: '33559',
          compatibility_property: propertyName,
          filter: filterParam || undefined
        }
      }
    );

    // Extract Values
    const rawValues = response.data.compatibilityPropertyValues || [];
    const values = rawValues.map(item => item.value);

    // 4. SAVE TO DB
    if (values.length > 0) {
      await FitmentCache.create({ cacheKey, values });
    }

    res.json({ values });

  } catch (err) {
    console.error("Metadata Fetch Error:", JSON.stringify(err.response?.data || err.message, null, 2));
    res.json({ values: [] });
  }
});



// --- NEW ROUTE 1: UPSERT CONVERSATION TAGS (Called from BuyerChatPage) ---
// 
router.post('/conversation-meta', requireAuth, async (req, res) => {
  const { sellerId, buyerUsername, orderId, itemId, category, caseStatus } = req.body;

  if (!category || !caseStatus) {
    return res.status(400).json({ error: 'Category and Case Status are required' });
  }

  try {
    let query = { seller: sellerId };

    if (orderId) {
      query.orderId = orderId;
    } else {
      query.buyerUsername = buyerUsername;
      query.itemId = itemId;
      query.orderId = null;
    }

    const meta = await ConversationMeta.findOneAndUpdate(
      query,
      {
        seller: sellerId,
        buyerUsername,
        orderId: orderId || null,
        itemId,
        category,
        caseStatus,

        // --- THE LOGIC FIX ---
        // If the seller clicks "Save" in the chat window, we assume they are working on it.
        // So we force it back to 'Open' and clear the resolution data.
        status: 'Open',
        resolvedAt: null,
        resolvedBy: null
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, meta });
  } catch (err) {
    console.error('Meta Save Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- NEW ROUTE 2: FETCH TAGS FOR THREAD (Called from BuyerChatPage) ---
router.get('/conversation-meta/single', requireAuth, async (req, res) => {
  const { sellerId, buyerUsername, orderId, itemId } = req.query;

  try {
    let query = { seller: sellerId };
    if (orderId) {
      query.orderId = orderId;
    } else {
      query.buyerUsername = buyerUsername;
      query.itemId = itemId;
      query.orderId = null;
    }

    const meta = await ConversationMeta.findOne(query);
    res.json(meta || {}); // Return empty object if not found (cleaner for frontend)
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- NEW ROUTE 3: GET MANAGEMENT LIST (Called from ConversationManagementPage) ---
// 
router.get('/conversation-management/list', requireAuth, async (req, res) => {
  const { status } = req.query;

  try {
    let query = {};
    if (status) query.status = status;

    const list = await ConversationMeta.aggregate([
      { $match: query },
      { $sort: { updatedAt: -1 } },

      // 1. LOOKUP SELLER (ConversationMeta -> Seller)
      {
        $lookup: {
          from: 'sellers',
          localField: 'seller',
          foreignField: '_id',
          as: 'sellerDoc'
        }
      },
      // Unwind allows us to access the fields inside sellerDoc directly
      { $unwind: { path: '$sellerDoc', preserveNullAndEmptyArrays: true } },

      // 2. LOOKUP USER (Seller -> User) - THIS WAS MISSING
      {
        $lookup: {
          from: 'users', // The collection name for 'User' model is usually lowercase plural 'users'
          localField: 'sellerDoc.user',
          foreignField: '_id',
          as: 'userDoc'
        }
      },
      { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },

      // 3. LOOKUP ORDER (To get Buyer Real Name)
      {
        $lookup: {
          from: 'orders',
          localField: 'orderId',
          foreignField: 'orderId',
          as: 'orderInfo'
        }
      },

      // 4. PROJECT FINAL SHAPE
      {
        $project: {
          _id: 1,
          sellerId: '$sellerDoc._id',
          // NOW WE PULL USERNAME FROM THE USER DOC
          sellerName: { $ifNull: ['$userDoc.username', 'Unknown'] },
          buyerUsername: 1,
          orderId: 1,
          itemId: 1,
          category: 1,
          caseStatus: 1,
          status: 1,
          notes: 1,
          updatedAt: 1,
          buyerName: {
            $ifNull: [
              { $arrayElemAt: ["$orderInfo.buyer.buyerRegistrationAddress.fullName", 0] },
              "$buyerUsername"
            ]
          }
        }
      }
    ]);

    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- NEW ROUTE 4: RESOLVE CONVERSATION (Called from Management Modal) ---
router.patch('/conversation-management/:id/resolve', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { notes, status } = req.body;

  try {
    const meta = await ConversationMeta.findByIdAndUpdate(
      id,
      {
        notes,
        status,
        resolvedAt: status === 'Resolved' ? new Date() : null,
        resolvedBy: req.user.username
      },
      { new: true }
    );
    res.json({ success: true, meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



//Manual fields to upadte for amazon 
router.patch('/orders/:orderId/manual-fields', requireAuth, async (req, res) => {
  const { orderId } = req.params;
  const updates = req.body;

  const allowedFields = ['amazonAccount', 'arrivingDate', 'beforeTax', 'estimatedTax', 'azOrderId', 'amazonRefund', 'cardName', 'remark', 'alreadyInUse'];
  const updateData = {};

  Object.keys(updates).forEach(key => {
    if (allowedFields.includes(key)) {
      updateData[key] = updates[key];
    }
  });

  try {
    // Find the order first to get full data for USD recalculation
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Apply manual updates to order object
    Object.keys(updateData).forEach(key => {
      order[key] = updateData[key];
    });

    // Check if any monetary fields were updated
    const monetaryFields = ['beforeTax', 'estimatedTax', 'amazonRefund'];
    const updatedMonetaryField = Object.keys(updates).some(key => monetaryFields.includes(key));

    // Recalculate USD values if monetary fields were updated
    if (updatedMonetaryField) {
      const usdUpdates = recalculateUSDFields(order);
      Object.keys(usdUpdates).forEach(key => {
        order[key] = usdUpdates[key];
      });

      // If beforeTaxUSD or estimatedTaxUSD changed, recalculate Amazon financials
      if (updates.beforeTax !== undefined || updates.estimatedTax !== undefined) {
        const amazonFinancials = await calculateAmazonFinancials(order);
        Object.keys(amazonFinancials).forEach(key => {
          order[key] = amazonFinancials[key];
        });
      }
    }

    // Save the updated order
    await order.save();

    // Populate seller info for response
    await order.populate({
      path: 'seller',
      populate: {
        path: 'user',
        select: 'username email'
      }
    });

    res.json({
      success: true,
      order,
      recalculated: updatedMonetaryField ? 'USD values recalculated' : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get item images from eBay Trading API (with caching)
router.get('/item-images/:itemId', requireAuth, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { sellerId, thumbnail } = req.query; // Add thumbnail parameter

    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }

    // ============================================
    // STEP 1: CREATE CACHE KEY
    // ============================================
    const cacheKey = `${itemId}_${sellerId}_${thumbnail || 'full'}`;

    // ============================================
    // STEP 2: CHECK CACHE FIRST
    // ============================================
    const cachedData = imageCache.get(cacheKey);
    if (cachedData) {
      console.log(`[ImageCache] ✅ HIT: ${cacheKey}`);
      res.set({
        'X-Cache': 'HIT',
        'Cache-Control': 'public, max-age=3600' // Browser cache: 1 hour
      });
      return res.json(cachedData);
    }

    console.log(`[ImageCache] ❌ MISS: ${cacheKey} - Fetching from eBay...`);

    // ============================================
    // STEP 3: CACHE MISS - FETCH FROM EBAY
    // ============================================
    // Get seller with valid token
    const seller = await Seller.findById(sellerId).populate('user');
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }

    await ensureValidToken(seller);

    // Use Trading API to get item details (GetItem call)
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${seller.ebayTokens.access_token}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;

    const response = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-SITEID': '0',
        'Content-Type': 'text/xml'
      },
      body: xmlBody
    });

    const xmlText = await response.text();

    // Parse XML to extract image URLs
    const pictureURLRegex = /<PictureURL>(.*?)<\/PictureURL>/g;
    const images = [];
    let match;

    while ((match = pictureURLRegex.exec(xmlText)) !== null) {
      images.push(match[1]);
    }

    if (images.length === 0) {
      // Try to get gallery URL as fallback
      const galleryMatch = xmlText.match(/<GalleryURL>(.*?)<\/GalleryURL>/);
      if (galleryMatch) {
        images.push(galleryMatch[1]);
      }
    }

    // ============================================
    // STEP 4: PREPARE RESPONSE DATA
    // ============================================
    const responseData = thumbnail === 'true' && images.length > 0
      ? { images: [images[0]], total: images.length }
      : { images, total: images.length };

    // ============================================
    // STEP 5: STORE IN CACHE (1 hour TTL)
    // ============================================
    imageCache.set(cacheKey, responseData);
    console.log(`[ImageCache] 💾 STORED: ${cacheKey} (${images.length} images)`);

    // ============================================
    // STEP 6: SET HTTP CACHE HEADERS
    // ============================================
    res.set({
      'X-Cache': 'MISS',
      'Cache-Control': 'public, max-age=3600' // Browser cache: 1 hour
    });

    res.json(responseData);
  } catch (error) {
    console.error('Error fetching item images:', error);
    res.status(500).json({ error: 'Failed to fetch item images' });
  }
});

// ============================================
// CACHE MANAGEMENT ENDPOINTS
// ============================================

// Get cache statistics (Admin only)
router.get('/cache/stats', requireAuth, requireRole('superadmin', 'fulfillmentadmin'), (req, res) => {
  try {
    const stats = imageCache.getStats();
    const sizeInfo = imageCache.getSizeInfo();

    res.json({
      ...stats,
      storage: sizeInfo,
      message: 'Cache statistics retrieved successfully'
    });
  } catch (error) {
    console.error('Error getting cache stats:', error);
    res.status(500).json({ error: 'Failed to get cache statistics' });
  }
});

// Clear cache (Admin only)
router.post('/cache/clear', requireAuth, requireRole('superadmin'), (req, res) => {
  try {
    imageCache.clear();
    res.json({
      success: true,
      message: 'Image cache cleared successfully'
    });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Seller Analytics - Aggregated data by day/week/month
router.get('/seller-analytics', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc'), async (req, res) => {
  try {
    const { sellerId, groupBy = 'day', startDate, endDate, marketplace } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }

    // Build match query with timezone-aware date filtering (same as stored-orders)
    const matchQuery = {
      // Exclude cancelled orders
      $and: [
        {
          $or: [
            { cancelState: { $exists: false } },
            { cancelState: null },
            { cancelState: { $nin: ['CANCELED', 'CANCELLED'] } }
          ]
        },
        {
          $or: [
            { 'cancelStatus.cancelState': { $exists: false } },
            { 'cancelStatus.cancelState': null },
            { 'cancelStatus.cancelState': { $nin: ['CANCELED', 'CANCELLED'] } }
          ]
        }
      ]
    };

    // Timezone-Aware Date Range Logic (PST - same as FulfillmentDashboard)
    const PST_OFFSET_HOURS = 8;
    matchQuery.dateSold = {};

    const start = new Date(startDate);
    start.setUTCHours(PST_OFFSET_HOURS, 0, 0, 0);
    matchQuery.dateSold.$gte = start;

    const end = new Date(endDate);
    end.setDate(end.getDate() + 1);
    end.setUTCHours(PST_OFFSET_HOURS - 1, 59, 59, 999);
    matchQuery.dateSold.$lte = end;

    if (sellerId) {
      matchQuery.seller = new mongoose.Types.ObjectId(sellerId);
    }

    if (marketplace) {
      // Handle Canada marketplace mapping: EBAY_ENCA → EBAY_CA
      const marketplaceId = marketplace === 'EBAY_ENCA' ? 'EBAY_CA' : marketplace;
      matchQuery.purchaseMarketplaceId = marketplaceId;
    }

    // Determine grouping format with PST timezone
    let dateGroupFormat;
    if (groupBy === 'day') {
      dateGroupFormat = { $dateToString: { format: '%Y-%m-%d', date: '$dateSold', timezone: 'America/Los_Angeles' } };
    } else if (groupBy === 'week') {
      dateGroupFormat = { $dateToString: { format: '%Y-W%V', date: '$dateSold', timezone: 'America/Los_Angeles' } };
    } else if (groupBy === 'month') {
      dateGroupFormat = { $dateToString: { format: '%Y-%m', date: '$dateSold', timezone: 'America/Los_Angeles' } };
    } else {
      return res.status(400).json({ error: 'Invalid groupBy parameter. Use day, week, or month.' });
    }

    // Aggregation pipeline
    const analytics = await Order.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: dateGroupFormat,
          totalOrders: { $sum: 1 },
          totalSubtotal: { $sum: { $ifNull: ['$subtotalUSD', 0] } },
          totalShipping: { $sum: { $ifNull: ['$shippingUSD', 0] } },
          totalSalesTax: { $sum: { $ifNull: ['$salesTaxUSD', 0] } },
          totalDiscount: { $sum: { $ifNull: ['$discountUSD', 0] } },
          totalTransactionFees: { $sum: { $ifNull: ['$transactionFeesUSD', 0] } },
          totalAdFees: { $sum: { $ifNull: ['$adFeeGeneral', 0] } },
          totalEarnings: { $sum: { $ifNull: ['$orderEarnings', 0] } },
          totalPBalanceINR: { $sum: { $ifNull: ['$pBalanceINR', 0] } },
          totalAmazonCosts: { $sum: { $ifNull: ['$amazonTotalINR', 0] } },
          totalCreditCardFees: { $sum: { $ifNull: ['$totalCC', 0] } },
          totalProfit: { $sum: { $ifNull: ['$profit', 0] } }
        }
      },
      {
        $project: {
          period: '$_id',
          totalOrders: 1,
          totalSubtotal: { $round: ['$totalSubtotal', 2] },
          totalShipping: { $round: ['$totalShipping', 2] },
          totalSalesTax: { $round: ['$totalSalesTax', 2] },
          totalDiscount: { $round: ['$totalDiscount', 2] },
          totalTransactionFees: { $round: ['$totalTransactionFees', 2] },
          totalAdFees: { $round: ['$totalAdFees', 2] },
          totalEarnings: { $round: ['$totalEarnings', 2] },
          totalPBalanceINR: { $round: ['$totalPBalanceINR', 2] },
          totalAmazonCosts: { $round: ['$totalAmazonCosts', 2] },
          totalCreditCardFees: { $round: ['$totalCreditCardFees', 2] },
          totalProfit: { $round: ['$totalProfit', 2] },
          _id: 0
        }
      },
      { $sort: { period: 1 } }
    ]);

    // Calculate overall summary
    const summary = analytics.reduce((acc, row) => {
      acc.totalOrders += row.totalOrders;
      acc.totalEarnings += row.totalEarnings;
      acc.totalProfit += row.totalProfit;
      return acc;
    }, { totalOrders: 0, totalEarnings: 0, totalProfit: 0 });

    summary.avgOrderValue = summary.totalOrders > 0
      ? parseFloat((summary.totalEarnings / summary.totalOrders).toFixed(2))
      : 0;

    res.json({ analytics, summary });
  } catch (err) {
    console.error('Error fetching seller analytics:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update worksheet status for an order (cancellation)
router.patch('/orders/:orderId/worksheet-status', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { worksheetStatus } = req.body;

    if (!['open', 'attended', 'resolved'].includes(worksheetStatus)) {
      return res.status(400).json({ error: 'Invalid worksheet status' });
    }

    const order = await Order.findOneAndUpdate(
      { orderId },
      { worksheetStatus },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error('Error updating order worksheet status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update worksheet status for a return
router.patch('/returns/:returnId/worksheet-status', requireAuth, async (req, res) => {
  try {
    const { returnId } = req.params;
    const { worksheetStatus } = req.body;

    if (!['open', 'attended', 'resolved'].includes(worksheetStatus)) {
      return res.status(400).json({ error: 'Invalid worksheet status' });
    }

    const returnDoc = await Return.findOneAndUpdate(
      { returnId },
      { worksheetStatus },
      { new: true }
    );

    if (!returnDoc) {
      return res.status(404).json({ error: 'Return not found' });
    }

    res.json({ success: true, return: returnDoc });
  } catch (err) {
    console.error('Error updating return worksheet status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update worksheet status for a case (INR)
router.patch('/cases/:caseId/worksheet-status', requireAuth, async (req, res) => {
  try {
    const { caseId } = req.params;
    const { worksheetStatus } = req.body;

    if (!['open', 'attended', 'resolved'].includes(worksheetStatus)) {
      return res.status(400).json({ error: 'Invalid worksheet status' });
    }

    const caseDoc = await Case.findOneAndUpdate(
      { caseId },
      { worksheetStatus },
      { new: true }
    );

    if (!caseDoc) {
      return res.status(404).json({ error: 'Case not found' });
    }

    res.json({ success: true, case: caseDoc });
  } catch (err) {
    console.error('Error updating case worksheet status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update logs for a case (INR)
router.patch('/cases/:caseId/logs', requireAuth, async (req, res) => {
  try {
    const { caseId } = req.params;
    const { logs } = req.body;

    const caseDoc = await Case.findOneAndUpdate(
      { caseId },
      { logs: logs || '' },
      { new: true }
    );

    if (!caseDoc) {
      return res.status(404).json({ error: 'Case not found' });
    }

    res.json({ success: true, case: caseDoc });
  } catch (err) {
    console.error('Error updating case logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update logs for a return
router.patch('/returns/:returnId/logs', requireAuth, async (req, res) => {
  try {
    const { returnId } = req.params;
    const { logs } = req.body;

    const returnDoc = await Return.findOneAndUpdate(
      { returnId },
      { logs: logs || '' },
      { new: true }
    );

    if (!returnDoc) {
      return res.status(404).json({ error: 'Return not found' });
    }

    res.json({ success: true, return: returnDoc });
  } catch (err) {
    console.error('Error updating return logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update logs for an order (Cancellation)
router.patch('/orders/:orderId/logs', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { logs } = req.body;

    const order = await Order.findOneAndUpdate(
      { orderId },
      { logs: logs || '' },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error('Error updating order logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// POLICY MESSAGE FEATURE (20-minute follow-up message)
// =====================================================

const POLICY_MESSAGE_TEMPLATE = `If you have any questions or concerns, please contact us directly through eBay messages. We’re always happy to help and resolve issues quickly.

Please note that once an order is processed, cancellation may not be possible. Also, before opening any cases such as INR, returns, or payment disputes, we kindly request you to message us first. We genuinely want to assist you and make things right.

As a small business, your support means a lot to us. Thank you for your understanding!`;

const POLICY_MESSAGE_DELAY_MS = 20 * 60 * 1000; // 20 minutes

function getPolicyEligibilityDate(creationDate) {
  const createdAt = creationDate ? new Date(creationDate) : new Date();
  const now = Date.now();
  // If order is already older than 20 minutes when ingested, skip scheduling.
  if (now - createdAt.getTime() > POLICY_MESSAGE_DELAY_MS) {
    return null;
  }
  return new Date(createdAt.getTime() + POLICY_MESSAGE_DELAY_MS);
}

function getPolicyMessageQuery(now = new Date()) {
  return {
    policyMessageEligibleAt: { $lte: now, $exists: true },
    policyMessageSent: { $ne: true },
    policyMessageDisabled: { $ne: true },
    // keep behavior aligned with prior delayed-message logic
    orderFulfillmentStatus: { $ne: 'FULFILLED' },
    $or: [
      { cancelState: { $exists: false } },
      { cancelState: null },
      { cancelState: { $nin: ['CANCELED', 'CANCELLED'] } }
    ]
  };
}

// Compatibility endpoint kept for existing UI wiring
router.patch('/orders/:orderId/auto-message-toggle', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { disabled } = req.body;

    const order = await Order.findOneAndUpdate(
      { orderId },
      { policyMessageDisabled: disabled },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error('Error toggling policy message:', err);
    res.status(500).json({ error: err.message });
  }
});

// Compatibility endpoint kept for existing UI wiring
router.get('/orders/auto-message-stats', requireAuth, async (req, res) => {
  try {
    const pending = await Order.countDocuments(getPolicyMessageQuery(new Date()));
    const sent = await Order.countDocuments({ policyMessageSent: true });
    const disabled = await Order.countDocuments({ policyMessageDisabled: true });

    res.json({ pending, sent, disabled });
  } catch (err) {
    console.error('Error getting policy message stats:', err);
    res.status(500).json({ error: err.message });
  }
});

async function sendPolicyMessage(order, seller) {
  const token = await ensureValidToken(seller);
  const itemId = order.lineItems?.[0]?.legacyItemId || order.itemNumber;
  const itemTitle = order.lineItems?.[0]?.title || order.productName;
  const buyerUsername = order.buyer?.username;

  if (!itemId || !buyerUsername) {
    console.log(`[PolicyMessage] Skip order ${order.orderId}: Missing itemId or buyerUsername`);
    return { success: false, reason: 'Missing itemId or buyerUsername' };
  }

  const escapedBody = POLICY_MESSAGE_TEMPLATE
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
    <AddMemberMessageAAQToPartnerRequest xmlns="urn:ebay:apis:eBLBaseComponents">
      <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
      <ItemID>${itemId}</ItemID>
      <MemberMessage>
        <Subject>Order Policy - #${order.orderId}</Subject>
        <Body>${escapedBody}</Body>
        <QuestionType>General</QuestionType>
        <RecipientID>${buyerUsername}</RecipientID>
      </MemberMessage>
    </AddMemberMessageAAQToPartnerRequest>`;

  try {
    const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
      headers: {
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'AddMemberMessageAAQToPartner',
        'X-EBAY-API-SITEID': '0',
        'Content-Type': 'text/xml'
      }
    });

    if (response.data.includes('<Ack>Success</Ack>') || response.data.includes('<Ack>Warning</Ack>')) {
      await Order.findByIdAndUpdate(order._id, {
        policyMessageSent: true,
        policyMessageSentAt: new Date()
      });

      await Message.create({
        seller: seller._id,
        orderId: order.orderId,
        itemId,
        itemTitle,
        buyerUsername,
        sender: 'SELLER',
        subject: `Order Policy - #${order.orderId}`,
        body: POLICY_MESSAGE_TEMPLATE,
        read: true,
        messageType: 'ORDER',
        messageDate: new Date()
      });

      console.log(`[PolicyMessage] Success: Order ${order.orderId}`);
      return { success: true };
    }

    console.error(`[PolicyMessage] Failed: Order ${order.orderId}`, response.data);
    return { success: false, reason: 'eBay returned error' };
  } catch (err) {
    console.error(`[PolicyMessage] Error: Order ${order.orderId}`, err.message);
    return { success: false, reason: err.message };
  }
}

async function processPendingPolicyMessages(limit = 50) {
  const orders = await Order.find(getPolicyMessageQuery(new Date()))
    .populate({
      path: 'seller',
      populate: { path: 'user' }
    })
    .limit(limit);

  let successCount = 0;
  let failCount = 0;

  for (const order of orders) {
    if (!order.seller) {
      failCount++;
      continue;
    }

    const result = await sendPolicyMessage(order, order.seller);
    if (result.success) successCount++;
    else failCount++;

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return { processed: orders.length, sent: successCount, failed: failCount };
}

// Compatibility endpoint path kept to avoid breaking existing UI button
router.post('/orders/send-auto-messages', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  try {
    const result = await processPendingPolicyMessages(50);
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('Error sending policy messages:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// AWAITING SHEET SUMMARY - Order counts by seller (no tracking)
// =====================================================
router.get('/awaiting-sheet-summary', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { date, marketplace } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Date is required (YYYY-MM-DD format)' });
    }

    // Build date range for the selected day (PST timezone like other endpoints)
    const PST_OFFSET_HOURS = 8;
    const startOfDay = new Date(date);
    startOfDay.setUTCHours(PST_OFFSET_HOURS, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setDate(endOfDay.getDate() + 1);
    endOfDay.setUTCHours(PST_OFFSET_HOURS - 1, 59, 59, 999);

    // Base match conditions for the date and cancel state
    const baseMatch = {
      shipByDate: { $gte: startOfDay, $lte: endOfDay },
      cancelState: { $in: ['NONE_REQUESTED', 'IN_PROGRESS', null, ''] }
    };

    // Add marketplace filter if provided
    if (marketplace && marketplace !== '') {
      baseMatch.purchaseMarketplaceId = marketplace === 'EBAY_CA' ? { $in: ['EBAY_CA', 'EBAY_ENCA'] } : marketplace;
    }

    // Aggregation pipeline - group by seller with conditional counts
    const summary = await Order.aggregate([
      {
        $match: baseMatch
      },
      // Group by seller with conditional counts
      {
        $group: {
          _id: '$seller',
          // Count orders without tracking number
          trackingIdCount: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: [{ $ifNull: ['$trackingNumber', ''] }, ''] },
                    { $eq: ['$trackingNumber', null] }
                  ]
                },
                1,
                0
              ]
            }
          },
          // Count orders with remark = 'Delivered'
          deliveredCount: {
            $sum: {
              $cond: [{ $eq: ['$remark', 'Delivered'] }, 1, 0]
            }
          },
          // Count orders with remark = 'In-transit'
          inTransitCount: {
            $sum: {
              $cond: [{ $eq: ['$remark', 'In-transit'] }, 1, 0]
            }
          },
          // Count orders with remark = 'Not yet shipped' and no tracking number
          notYetShippedCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$remark', 'Not yet shipped'] },
                    {
                      $or: [
                        { $eq: [{ $ifNull: ['$trackingNumber', ''] }, ''] },
                        { $eq: ['$trackingNumber', null] }
                      ]
                    }
                  ]
                },
                1,
                0
              ]
            }
          },
          // Total orders count (for Upload Tracking column)
          uploadTrackingCount: { $sum: 1 },
          // Count orders with alreadyInUse = 'Yes' and no tracking number
          alreadyInUseCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$alreadyInUse', 'Yes'] },
                    {
                      $or: [
                        { $eq: [{ $ifNull: ['$trackingNumber', ''] }, ''] },
                        { $eq: ['$trackingNumber', null] }
                      ]
                    }
                  ]
                },
                1,
                0
              ]
            }
          },
          // Count orders where notes contains 'amazon' (case insensitive) and no tracking
          amazonCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    {
                      $or: [
                        { $eq: [{ $ifNull: ['$trackingNumber', ''] }, ''] },
                        { $eq: ['$trackingNumber', null] }
                      ]
                    },
                    {
                      $regexMatch: { input: { $ifNull: ['$notes', ''] }, regex: /amazon/i }
                    }
                  ]
                },
                1,
                0
              ]
            }
          },
          // Count orders where notes starts with '1z' or '9' and no tracking
          upsUspsCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    {
                      $or: [
                        { $eq: [{ $ifNull: ['$trackingNumber', ''] }, ''] },
                        { $eq: ['$trackingNumber', null] }
                      ]
                    },
                    {
                      $or: [
                        { $regexMatch: { input: { $ifNull: ['$notes', ''] }, regex: /^1z/i } },
                        { $regexMatch: { input: { $ifNull: ['$notes', ''] }, regex: /^9/ } }
                      ]
                    }
                  ]
                },
                1,
                0
              ]
            }
          },
          // Count orders where notes is blank/null and no tracking
          blankCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    {
                      $or: [
                        { $eq: [{ $ifNull: ['$trackingNumber', ''] }, ''] },
                        { $eq: ['$trackingNumber', null] }
                      ]
                    },
                    {
                      $or: [
                        { $eq: [{ $ifNull: ['$notes', ''] }, ''] },
                        { $eq: ['$notes', null] }
                      ]
                    }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      },
      // Lookup seller info
      {
        $lookup: {
          from: 'sellers',
          localField: '_id',
          foreignField: '_id',
          as: 'sellerDoc'
        }
      },
      { $unwind: { path: '$sellerDoc', preserveNullAndEmptyArrays: true } },
      // Lookup user for username
      {
        $lookup: {
          from: 'users',
          localField: 'sellerDoc.user',
          foreignField: '_id',
          as: 'userDoc'
        }
      },
      { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          sellerId: '$_id',
          sellerName: { $ifNull: ['$userDoc.username', '$userDoc.email', 'Unknown'] },
          trackingIdCount: 1,
          deliveredCount: 1,
          inTransitCount: 1,
          uploadTrackingCount: 1,
          alreadyInUseCount: 1,
          amazonCount: 1,
          upsUspsCount: 1,
          blankCount: 1,
          notYetShippedCount: 1,
          _id: 0
        }
      },
      { $sort: { trackingIdCount: -1 } } // Sort by tracking ID count descending
    ]);

    // Calculate totals
    const totals = summary.reduce((acc, item) => ({
      trackingId: acc.trackingId + item.trackingIdCount,
      delivered: acc.delivered + item.deliveredCount,
      inTransit: acc.inTransit + item.inTransitCount,
      notYetShipped: acc.notYetShipped + item.notYetShippedCount,
      uploadTracking: acc.uploadTracking + item.uploadTrackingCount,
      alreadyInUse: acc.alreadyInUse + item.alreadyInUseCount,
      amazon: acc.amazon + item.amazonCount,
      upsUsps: acc.upsUsps + item.upsUspsCount,
      blank: acc.blank + item.blankCount
    }), { trackingId: 0, delivered: 0, inTransit: 0, notYetShipped: 0, uploadTracking: 0, alreadyInUse: 0, amazon: 0, upsUsps: 0, blank: 0 });

    res.json({
      date,
      summary,
      totals,
      totalSellers: summary.length
    });
  } catch (err) {
    console.error('Error fetching awaiting sheet summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// Export for optional external schedulers
export { sendPolicyMessage, processPendingPolicyMessages, getPolicyEligibilityDate };

export default router;


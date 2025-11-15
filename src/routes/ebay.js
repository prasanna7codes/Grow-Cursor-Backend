import express from 'express';
import axios from 'axios';
import qs from 'qs';
import jwt from 'jsonwebtoken';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Seller from '../models/Seller.js';
import Order from '../models/Order.js';
const router = express.Router();

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
    const trackingNumber = response.data?.shipmentTrackingNumber || 
                          response.data?.lineItems?.[0]?.shipmentTrackingNumber ||
                          null;
    return trackingNumber;
  } catch (err) {
    console.error('Failed to extract tracking number:', err.message);
    return null;
  }
}

// 1. Start OAuth: Redirect to eBay
router.get('/connect', (req, res) => {
  const { token } = req.query; // Get JWT from query param
  if (!token) return res.status(400).send('Missing authentication token');
  
  const clientId = process.env.EBAY_CLIENT_ID;
  const ruName = process.env.EBAY_RU_NAME;
  const scope = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly';
  
  // Pass the user's JWT as state parameter so we can identify them in callback
  const state = encodeURIComponent(token);
  const redirectUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(ruName)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
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
          limit: 5
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
            scope: 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
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
      limit: orderCount === 0 ? 5 : 200 // If no orders exist, fetch only 5, else fetch all new/updated
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

// New endpoint: Get stored orders from database
router.get('/stored-orders', async (req, res) => {
  const { sellerId } = req.query;
  
  try {
    let query = {};
    if (sellerId) {
      query.seller = sellerId;
    }
    
    const orders = await Order.find(query)
      .populate({
        path: 'seller',
        populate: {
          path: 'user',
          select: 'username email'
        }
      })
      .sort({ creationDate: -1 })
      .limit(500);
    
    console.log(`[Stored Orders] Query: ${JSON.stringify(query)}, Found ${orders.length} orders`);
    if (!sellerId) {
      // Log order count per seller when showing all
      const sellerCounts = {};
      orders.forEach(order => {
        const sellerKey = order.seller?.user?.username || order.seller?._id || 'Unknown';
        sellerCounts[sellerKey] = (sellerCounts[sellerKey] || 0) + 1;
      });
      console.log('[Stored Orders] Breakdown by seller:', sellerCounts);
    }
    
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const order = await Order.findByIdAndUpdate(
      orderId,
      { adFeeGeneral: parseFloat(adFeeGeneral) },
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

// Poll all sellers for new/updated orders
router.post('/poll-all-sellers', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  try {
    // Properly populate user data upfront
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

    const pollResults = [];
    let totalNewOrders = 0;
    let totalUpdatedOrders = 0;

    for (const seller of sellers) {
      try {
        const sellerName = seller.user?.username || seller.user?.email || seller._id.toString();
        console.log(`\n========== Processing Seller: ${sellerName} ==========`);
        
        // Check token expiry and refresh if needed
        const now = Date.now();
        const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
        const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
        let accessToken = seller.ebayTokens.access_token;

        if (fetchedAt && (now - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
          console.log(`[Seller ${sellerName}] Token expired, refreshing...`);
          // Refresh token
          try {
            const refreshRes = await axios.post(
              'https://api.ebay.com/identity/v1/oauth2/token',
              qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: seller.ebayTokens.refresh_token,
                scope: 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
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
            console.log(`[Seller ${sellerName}] Token refreshed successfully`);
          } catch (refreshErr) {
            console.error(`[Seller ${sellerName}] Failed to refresh token:`, refreshErr.message);
            pollResults.push({
              sellerId: seller._id,
              sellerName,
              success: false,
              error: 'Failed to refresh token'
            });
            continue;
          }
        }

        // ========== PHASE 1: FETCH NEW ORDERS (by creationdate) ==========
        const orderCount = await Order.countDocuments({ seller: seller._id });
        const newestOrder = await Order.findOne({ seller: seller._id }).sort({ creationDate: -1 });
        const newestCreationDate = newestOrder ? newestOrder.creationDate : null;
        
        // Get oldest order for Phase 2 date range
        const oldestOrder = await Order.findOne({ seller: seller._id }).sort({ creationDate: 1 });
        const oldestCreationDate = oldestOrder ? oldestOrder.creationDate : null;

        const newOrdersParams = {
          limit: orderCount === 0 ? 5 : 200
        };

        // Fetch orders created AFTER the newest order in database
        let skipPhase1 = false;
        if (newestCreationDate) {
          // Add 1 second to exclude the newest order we already have
          const exclusiveStartDate = new Date(new Date(newestCreationDate).getTime() + 1000);
          // Subtract 10 seconds from current time to avoid "future date" errors due to clock drift
          const currentDate = new Date(Date.now() - 10000);
          const timeDiffMinutes = (currentDate - exclusiveStartDate) / (1000 * 60);
          
          // Only fetch if there's at least a 1 minute gap (eBay might not like very narrow date ranges)
          if (timeDiffMinutes >= 1) {
            newOrdersParams.filter = `creationdate:[${exclusiveStartDate.toISOString()}..${currentDate.toISOString()}]`;
            console.log(`[Seller ${sellerName}] PHASE 1: Fetching NEW orders created after: ${exclusiveStartDate.toISOString()}`);
          } else {
            // Too recent, skip Phase 1 to avoid 400 error
            console.log(`[Seller ${sellerName}] PHASE 1: Newest order too recent (${timeDiffMinutes.toFixed(2)} min ago), skipping new order fetch`);
            skipPhase1 = true;
          }
        } else {
          console.log(`[Seller ${sellerName}] PHASE 1: First time fetch - getting initial 5 orders`);
        }

        const newOrders = [];
        const updatedOrders = [];
        let newEbayOrders = [];

        // API CALL #1: Fetch new orders from eBay (skip if too recent)
        if (!skipPhase1) {
          try {
            console.log(`[Seller ${sellerName}] PHASE 1: Params:`, JSON.stringify(newOrdersParams));
            const newOrdersRes = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              params: newOrdersParams
            });

            newEbayOrders = newOrdersRes.data.orders || [];
            console.log(`[Seller ${sellerName}] PHASE 1: eBay returned ${newEbayOrders.length} NEW orders`);
          } catch (phase1Err) {
            console.error(`[Seller ${sellerName}] PHASE 1 error:`, phase1Err.message);
            if (phase1Err.response?.data) {
              console.error(`[Seller ${sellerName}] eBay API error details:`, JSON.stringify(phase1Err.response.data));
            }
            // Continue to Phase 2 even if Phase 1 fails
          }
        } else {
          console.log(`[Seller ${sellerName}] PHASE 1: Skipped (too recent)`);
        }

        // Process Phase 1 new orders
        for (const ebayOrder of newEbayOrders) {
          const existingOrder = await Order.findOne({ 
            orderId: ebayOrder.orderId,
            seller: seller._id 
          });

          // Extract new fields
          const cancelState = ebayOrder.cancelStatus?.cancelState || null;
          const refunds = ebayOrder.paymentSummary?.refunds || [];
          const trackingNumber = await extractTrackingNumber(
            ebayOrder.fulfillmentStartInstructions?.[0]?.fulfillmentInstructionsType === 'SHIP_TO' 
              ? ebayOrder.fulfillmentHrefs 
              : null,
            accessToken
          );

          // Extract denormalized fields for dashboard
          const lineItem = ebayOrder.lineItems?.[0] || {};
          const fulfillmentInstr = ebayOrder.fulfillmentStartInstructions?.[0] || {};
          const shipTo = fulfillmentInstr.shippingStep?.shipTo || {};
          const buyerAddr = `${shipTo.contactAddress?.addressLine1 || ''}, ${shipTo.contactAddress?.city || ''}, ${shipTo.contactAddress?.stateOrProvince || ''}, ${shipTo.contactAddress?.postalCode || ''}, ${shipTo.contactAddress?.countryCode || ''}`.trim();
          
          // Extract purchaseMarketplaceId from lineItems
          const purchaseMarketplaceId = lineItem.purchaseMarketplaceId || '';

          // Always upsert with all fields, so new and updated orders are consistent
          const upsertedOrder = await Order.findOneAndUpdate(
            { orderId: ebayOrder.orderId },
            {
              orderId: ebayOrder.orderId,
              seller: seller._id,
              orderFulfillmentStatus: ebayOrder.orderFulfillmentStatus,
              creationDate: ebayOrder.creationDate,
              lastModifiedDate: ebayOrder.lastModifiedDate,
              pricingSummary: ebayOrder.pricingSummary,
              buyer: ebayOrder.buyer,
              lineItems: ebayOrder.lineItems,
              paymentSummary: ebayOrder.paymentSummary,
              fulfillmentStartInstructions: ebayOrder.fulfillmentStartInstructions,
              orderPaymentStatus: ebayOrder.orderPaymentStatus,
              salesRecordReference: ebayOrder.salesRecordReference,
              totalFeeBasisAmount: ebayOrder.totalFeeBasisAmount,
              totalMarketplaceFee: ebayOrder.totalMarketplaceFee,
              fulfillmentHrefs: ebayOrder.fulfillmentHrefs,
              cancelState,
              refunds,
              trackingNumber,
              purchaseMarketplaceId,
              // Denormalized fields for dashboard
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
              shippingPhone: '0000000000',
              quantity: lineItem.quantity,
              subtotal: parseFloat(ebayOrder.pricingSummary?.priceSubtotal?.value || 0),
              salesTax: parseFloat(lineItem.ebayCollectAndRemitTaxes?.[0]?.amount?.value || 0),
              discount: parseFloat(ebayOrder.pricingSummary?.priceDiscount?.value || 0),
              shipping: parseFloat(ebayOrder.pricingSummary?.deliveryCost?.value || 0),
              transactionFees: parseFloat(ebayOrder.totalMarketplaceFee?.value || 0),
              adFee: parseFloat(lineItem.appliedPromotions?.[0]?.discountAmount?.value || 0)
            },
            { upsert: true, new: true }
          );
          newOrders.push(upsertedOrder);
          console.log(`  🆕 NEW/UPSERTED: ${ebayOrder.orderId}`);
        }

        // ========== PHASE 2: CHECK FOR UPDATES TO EXISTING ORDERS ==========
        // Get all existing order IDs from database to filter locally
        const existingOrderIds = await Order.find({ seller: seller._id }).distinct('orderId');
        const existingOrderIdSet = new Set(existingOrderIds);
        console.log(`[Seller ${sellerName}] PHASE 2: Found ${existingOrderIds.length} existing orders in database`);

        if (existingOrderIds.length > 0) {
          // Get the oldest order to determine how far back to check
          // This ensures we catch updates to ALL orders, not just recent ones
          const oldestOrderInDb = await Order.findOne({ seller: seller._id }).sort({ creationDate: 1 });
          
          // Subtract 10 seconds from current time to avoid "future date" errors due to clock drift
          const currentDate = new Date(Date.now() - 10000);
          
          // Check from 1 day BEFORE oldest order (to catch any edge cases)
          let sinceDate;
          if (oldestOrderInDb && oldestOrderInDb.creationDate) {
            sinceDate = new Date(oldestOrderInDb.creationDate);
            sinceDate.setDate(sinceDate.getDate() - 1); // 1 day before oldest order
            
            const daysCovered = Math.ceil((currentDate - sinceDate) / (1000 * 60 * 60 * 24));
            console.log(`[Seller ${sellerName}] PHASE 2: Checking orders from ${sinceDate.toISOString()} to ${currentDate.toISOString()}`);
            console.log(`[Seller ${sellerName}] PHASE 2: Date range covers ${daysCovered} days (all orders)`);
          } else {
            // Fallback to 30 days if no oldest order found (shouldn't happen but safety check)
            sinceDate = new Date(currentDate.getTime() - (30 * 24 * 60 * 60 * 1000));
            console.log(`[Seller ${sellerName}] PHASE 2: Checking for updates in last 30 days (fallback)`);
          }
          
          let offset = 0;
          const batchSize = 100;
          let hasMoreBatches = true;
          let phase2UpdateCount = 0;

          while (hasMoreBatches) {
            try {
              const filterString = `lastmodifieddate:[${sinceDate.toISOString()}..${currentDate.toISOString()}]`;
              console.log(`[Seller ${sellerName}] PHASE 2: Fetching batch at offset ${offset}`);
              console.log(`[Seller ${sellerName}] PHASE 2: Filter: ${filterString}`);
              
              // API CALL: Fetch orders with lastmodifieddate filter
              const phase2Params = {
                filter: filterString,
                limit: batchSize
              };
              
              // Only add offset if it's not 0 (some APIs don't like offset with filters)
              if (offset > 0) {
                phase2Params.offset = offset;
              }
              
              const phase2Res = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                },
                params: phase2Params
              });
              
              const batchOrders = phase2Res.data.orders || [];
              console.log(`[Seller ${sellerName}] PHASE 2: eBay returned ${batchOrders.length} orders in this batch`);
              
              // Filter locally: only process orders that exist in our database
              const relevantOrders = batchOrders.filter(order => existingOrderIdSet.has(order.orderId));
              console.log(`[Seller ${sellerName}] PHASE 2: ${relevantOrders.length} orders match our database`);
              
              // Process relevant orders
              for (const ebayOrder of relevantOrders) {
                const existingOrder = await Order.findOne({ 
                  orderId: ebayOrder.orderId,
                  seller: seller._id 
                });

                if (existingOrder) {
                  // Check if actually modified
                  const ebayModTime = new Date(ebayOrder.lastModifiedDate).getTime();
                  const dbModTime = new Date(existingOrder.lastModifiedDate).getTime();
                  
                  if (ebayModTime > dbModTime) {
                    // Extract new fields
                    const cancelState = ebayOrder.cancelStatus?.cancelState || null;
                    const refunds = ebayOrder.paymentSummary?.refunds || [];
                    const trackingNumber = await extractTrackingNumber(
                      ebayOrder.fulfillmentStartInstructions?.[0]?.fulfillmentInstructionsType === 'SHIP_TO' 
                        ? ebayOrder.fulfillmentHrefs 
                        : null,
                      accessToken
                    );

                    // Extract denormalized fields for dashboard
                    const lineItem = ebayOrder.lineItems?.[0] || {};
                    const fulfillmentInstr = ebayOrder.fulfillmentStartInstructions?.[0] || {};
                    const shipTo = fulfillmentInstr.shippingStep?.shipTo || {};
                    const buyerAddr = `${shipTo.contactAddress?.addressLine1 || ''}, ${shipTo.contactAddress?.city || ''}, ${shipTo.contactAddress?.stateOrProvince || ''}, ${shipTo.contactAddress?.postalCode || ''}, ${shipTo.contactAddress?.countryCode || ''}`.trim();
                    
                    // Extract purchaseMarketplaceId from lineItems
                    const purchaseMarketplaceId = lineItem.purchaseMarketplaceId || '';

                    // Update order
                    existingOrder.orderFulfillmentStatus = ebayOrder.orderFulfillmentStatus;
                    existingOrder.lastModifiedDate = ebayOrder.lastModifiedDate;
                    existingOrder.pricingSummary = ebayOrder.pricingSummary;
                    existingOrder.buyer = ebayOrder.buyer;
                    existingOrder.lineItems = ebayOrder.lineItems;
                    existingOrder.paymentSummary = ebayOrder.paymentSummary;
                    existingOrder.fulfillmentStartInstructions = ebayOrder.fulfillmentStartInstructions;
                    existingOrder.orderPaymentStatus = ebayOrder.orderPaymentStatus;
                    existingOrder.salesRecordReference = ebayOrder.salesRecordReference;
                    existingOrder.totalFeeBasisAmount = ebayOrder.totalFeeBasisAmount;
                    existingOrder.totalMarketplaceFee = ebayOrder.totalMarketplaceFee;
                    existingOrder.fulfillmentHrefs = ebayOrder.fulfillmentHrefs;
                    existingOrder.cancelState = cancelState;
                    existingOrder.refunds = refunds;
                    existingOrder.trackingNumber = trackingNumber;
                    existingOrder.purchaseMarketplaceId = purchaseMarketplaceId;
                    // Update denormalized fields
                    existingOrder.dateSold = ebayOrder.creationDate;
                    existingOrder.shipByDate = lineItem.lineItemFulfillmentInstructions?.shipByDate;
                    existingOrder.estimatedDelivery = lineItem.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate;
                    existingOrder.productName = lineItem.title;
                    existingOrder.itemNumber = lineItem.legacyItemId;
                    existingOrder.buyerAddress = buyerAddr;
                    existingOrder.shippingFullName = shipTo.fullName || '';
                    existingOrder.shippingAddressLine1 = shipTo.contactAddress?.addressLine1 || '';
                    existingOrder.shippingAddressLine2 = shipTo.contactAddress?.addressLine2 || '';
                    existingOrder.shippingCity = shipTo.contactAddress?.city || '';
                    existingOrder.shippingState = shipTo.contactAddress?.stateOrProvince || '';
                    existingOrder.shippingPostalCode = shipTo.contactAddress?.postalCode || '';
                    existingOrder.shippingCountry = shipTo.contactAddress?.countryCode || '';
                    existingOrder.shippingPhone = '0000000000';
                    existingOrder.quantity = lineItem.quantity;
                    existingOrder.subtotal = parseFloat(ebayOrder.pricingSummary?.priceSubtotal?.value || 0);
                    existingOrder.salesTax = parseFloat(lineItem.ebayCollectAndRemitTaxes?.[0]?.amount?.value || 0);
                    existingOrder.discount = parseFloat(ebayOrder.pricingSummary?.priceDiscount?.value || 0);
                    existingOrder.shipping = parseFloat(ebayOrder.pricingSummary?.deliveryCost?.value || 0);
                    existingOrder.transactionFees = parseFloat(ebayOrder.totalMarketplaceFee?.value || 0);
                    existingOrder.adFee = parseFloat(lineItem.appliedPromotions?.[0]?.discountAmount?.value || 0);
                    
                    await existingOrder.save();
                    updatedOrders.push(existingOrder);
                    phase2UpdateCount++;
                    console.log(`  🔄 UPDATED (Phase 2): ${ebayOrder.orderId}`);
                  } else {
                    console.log(`  ⏭️  No changes: ${ebayOrder.orderId}`);
                  }
                }
              }
              
              // Check if there are more batches
              if (batchOrders.length < batchSize) {
                hasMoreBatches = false;
              } else {
                offset += batchSize;
              }
            } catch (fetchErr) {
              console.error(`[Seller ${sellerName}] PHASE 2 batch fetch error:`, fetchErr.message);
              if (fetchErr.response?.data) {
                console.error(`[Seller ${sellerName}] eBay API error details:`, JSON.stringify(fetchErr.response.data));
              }
              if (fetchErr.response?.status) {
                console.error(`[Seller ${sellerName}] HTTP Status:`, fetchErr.response.status);
              }
              hasMoreBatches = false;
            }
          }
          
          console.log(`[Seller ${sellerName}] PHASE 2 COMPLETE: ${phase2UpdateCount} orders updated`);
        }

        // Populate seller user data for summary
        await seller.populate('user', 'username email');

        pollResults.push({
          sellerId: seller._id,
          sellerName: sellerName,
          success: true,
          newOrders: newOrders.map(o => o.orderId),
          updatedOrders: updatedOrders.map(o => o.orderId),
          totalNew: newOrders.length,
          totalUpdated: updatedOrders.length
        });

        totalNewOrders += newOrders.length;
        totalUpdatedOrders += updatedOrders.length;

      } catch (sellerErr) {
        // Ensure seller.user is populated for error logging
        if (!seller.user) {
          await seller.populate('user', 'username email');
        }
        const sellerNameForError = seller.user?.username || seller.user?.email || seller._id.toString();
        console.error(`Error polling seller ${sellerNameForError}:`, sellerErr.message);
        
        pollResults.push({
          sellerId: seller._id,
          sellerName: sellerNameForError,
          success: false,
          error: sellerErr.message
        });
      }
    }

    res.json({
      message: 'Polling complete',
      pollResults,
      totalPolled: sellers.length,
      totalNewOrders,
      totalUpdatedOrders
    });
    
    console.log('Poll all sellers complete:', {
      totalPolled: sellers.length,
      totalNewOrders,
      totalUpdatedOrders,
      resultsCount: pollResults.length
    });

  } catch (err) {
    console.error('Error polling all sellers:', err);
    res.status(500).json({ error: err.message });
  }
});

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

  if (!itemStatus) {
    return res.status(400).json({ error: 'Missing itemStatus value' });
  }

  // Validate enum values
  const validStatuses = ['None', 'Return', 'Replace', 'INR', 'Resolved'];
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

// Update notes for an order
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

export default router;


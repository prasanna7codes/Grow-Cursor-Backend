import express from 'express';
import axios from 'axios';
import qs from 'qs';
import { parseStringPromise } from 'xml2js';
import Seller from '../models/Seller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// ============================================
// EBAY OAUTH SCOPES (Copied from ebay.js)
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
// HELPER: Ensure Seller Token is Valid
// ============================================
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
                    scope: EBAY_OAUTH_SCOPES
                }),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
                    },
                    timeout: 10000
                }
            );

            // Update Seller
            seller.ebayTokens.access_token = refreshRes.data.access_token;
            seller.ebayTokens.expires_in = refreshRes.data.expires_in;
            seller.ebayTokens.fetchedAt = new Date();
            await seller.save();

            return refreshRes.data.access_token;
        } catch (err) {
            const status = err.response?.status;
            const isRetryable = status === 503 || status === 429 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';

            if (isRetryable && attempt < retries) {
                const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            console.error(`[Token Refresh] ❌ Failed for ${seller._id}:`, err.message);
            throw new Error(`Failed to refresh eBay token: ${err.response?.status || err.message}`);
        }
    }
}

// ============================================
// ROUTE: Get Seller Limits
// ============================================
router.get('/', requireAuth, async (req, res) => {
    try {
        // 1. Fetch all sellers with populated user details
        const sellers = await Seller.find({}).populate('user', 'username email');

        const results = [];

        // 2. Iterate through each seller
        for (const seller of sellers) {
            try {
                // Ensure token is valid
                // Ensure token is valid
                let token;
                try {
                    token = await ensureValidToken(seller);
                } catch (tokenErr) {
                    console.error(`Token error for ${seller.user?.username}:`, tokenErr.message);
                    results.push({
                        sellerId: seller._id,
                        username: seller.user?.username || 'Unknown',
                        status: 'Error',
                        error: 'Token Refresh Failed (Relogin Required)'
                    });
                    continue; // Skip to next seller
                }

                // 3. Prepare XML Request for Trading API
                console.log(`[Seller Limits] Fetching data for: ${seller.user?.username || 'Unknown'}`);

                const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">    
     <ErrorLanguage>en_US</ErrorLanguage>
     <WarningLevel>High</WarningLevel>
     <SellingSummary>
         <Include>true</Include>
      </SellingSummary>
</GetMyeBaySellingRequest>`;

                // 4. Call GetMyeBaySelling
                const response = await axios.post('https://api.ebay.com/ws/api.dll', xmlRequest, {
                    headers: {
                        'X-EBAY-API-SITEID': '0', // US Site
                        'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
                        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
                        'X-EBAY-API-IAF-TOKEN': token, // Use IAF token (OAuth)
                        'Content-Type': 'text/xml'
                    }
                });

                // 5. Parse XML Response
                const result = await parseStringPromise(response.data);

                // Check for Ack Success/Warning
                const ack = result.GetMyeBaySellingResponse?.Ack?.[0];

                if (ack === 'Success' || ack === 'Warning') {
                    const summary = result.GetMyeBaySellingResponse?.Summary?.[0];

                    const quantityLimitRemaining = summary?.QuantityLimitRemaining?.[0] || 'N/A';
                    const amountLimitRemaining = summary?.AmountLimitRemaining?.[0]?.['_'] || 'N/A';
                    const amountCurrency = summary?.AmountLimitRemaining?.[0]?.['$']?.currencyID || 'USD';

                    // Also getting Total Active Listings for context if available, though not strictly limits
                    const activeAuction = parseInt(summary?.ActiveAuctionCount?.[0] || '0');
                    // Summary doesn't always have total active fixed price count unless ActiveList is requested.
                    // But user just wanted limits.

                    results.push({
                        sellerId: seller._id,
                        username: seller.user?.username || 'Unknown',
                        quantityLimitRemaining,
                        amountLimitRemaining,
                        amountCurrency,
                        status: 'Success'
                    });
                    console.log(`[Seller Limits] ✅ Success for: ${seller.user?.username}`);

                } else {
                    const errors = result.GetMyeBaySellingResponse?.Errors?.map(e => e.LongMessage?.[0]).join(', ');
                    console.error(`[Seller Limits] ❌ API Error for ${seller.user?.username}: ${errors}`);
                    results.push({
                        sellerId: seller._id,
                        username: seller.user?.username || 'Unknown',
                        status: 'Error',
                        error: errors || 'eBay Call Failed'
                    });
                }

            } catch (err) {
                console.error(`[Seller Limits] ❌ Exception for seller ${seller.user?.username}:`, err.message);
                results.push({
                    sellerId: seller._id,
                    username: seller.user?.username || 'Unknown',
                    status: 'Error',
                    error: err.message
                });
            }
        }

        res.json(results);

    } catch (error) {
        console.error('SERVER ERROR fetching seller limits:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;

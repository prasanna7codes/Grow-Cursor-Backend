/**
 * Best Offers routes — eBay Trading API
 *
 * GET  /api/ebay/best-offers            — GetBestOffers
 * POST /api/ebay/best-offers/respond    — RespondToBestOffer
 *
 * Mounted at /api/ebay in server/src/index.js so the URL prefix
 * remains identical to what the frontend expects.
 */

import express from 'express';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { requireAuth } from '../middleware/auth.js';
import Seller from '../models/Seller.js';
import TemplateListing from '../models/TemplateListing.js';
import { ensureValidToken } from './ebay.js';

const router = express.Router();

const EBAY_TRADING_URL = 'https://api.ebay.com/ws/api.dll';

// eBay site IDs mapped from marketplace slugs stored on the Seller document
const MARKETPLACE_SITEID = {
  EBAY_US: '0',
  EBAY_GB: '3',
  EBAY_DE: '77',
  EBAY_AU: '15',
  EBAY_CA: '2',
  EBAY_FR: '71',
  EBAY_IT: '101',
  EBAY_ES: '186',
};
const getSiteId = (seller) => MARKETPLACE_SITEID[seller.ebayMarketplaces?.[0]] ?? '0';

const tradingHeaders = (callName, siteId = '0') => ({
  'X-EBAY-API-SITEID': siteId,
  'X-EBAY-API-COMPATIBILITY-LEVEL': '1453',
  'X-EBAY-API-CALL-NAME': callName,
  'Content-Type': 'text/xml',
});

// ─── Sanitise values injected into XML ────────────────────────────────────────
const escapeXml = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// ─── Normalise single-item eBay responses to arrays ───────────────────────────
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ─── Run an async mapper over ids with a bounded number of in-flight calls ───
// GetBestOffers can return hundreds of offers and find_eligible_items is capped
// at 200 listings; firing that many GetItem calls at once trips eBay throttling.
const GETITEM_CONCURRENCY = 8;

async function mapWithConcurrency(items, worker, limit = GETITEM_CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

// ─── Fetch the full item stub for a single listing via GetItem ───────────────
// Neither GetBestOffers nor the Negotiation API's find_eligible_items returns
// anything beyond IDs, so one GetItem per unique listing supplies the SKU,
// title, price, gallery photo, and Best Offer flag that both tabs render.
const EMPTY_ITEM_DETAILS = {
  sku: '',
  title: '',
  imageUrl: '',
  currentPrice: null,
  currentPriceCurrency: 'USD',
  bestOfferEnabled: null,
  listingStatus: '',
};

async function fetchItemDetails(token, siteId, itemId) {
  try {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${escapeXml(itemId)}</ItemID>
  <IncludeItemSpecifics>false</IncludeItemSpecifics>
</GetItemRequest>`;
    const resp = await axios.post(EBAY_TRADING_URL, xml, {
      headers: tradingHeaders('GetItem', siteId),
    });
    const parsed = await parseStringPromise(resp.data, { explicitArray: false });
    const item = parsed?.GetItemResponse?.Item;
    if (!item) return { ...EMPTY_ITEM_DETAILS };

    // GetItem returns the current price under SellingStatus; BuyItNowPrice is
    // only populated for auction-format listings.
    const price = item.SellingStatus?.CurrentPrice ?? item.BuyItNowPrice;
    const bestOffer = item.BestOfferDetails?.BestOfferEnabled;

    return {
      sku: item.SKU ?? '',
      title: item.Title ?? '',
      imageUrl: item.PictureDetails?.GalleryURL ?? '',
      currentPrice: price?._ ?? price ?? null,
      currentPriceCurrency: price?.['$']?.currencyID ?? item.Currency ?? 'USD',
      bestOfferEnabled: bestOffer == null ? null : bestOffer === 'true' || bestOffer === true,
      listingStatus: item.SellingStatus?.ListingStatus ?? '',
    };
  } catch {
    return { ...EMPTY_ITEM_DETAILS };
  }
}

// ─── SKU → ASIN enrichment from the Template Listings database ───────────────
// eBay knows nothing about ASINs; the SKU ↔ ASIN mapping lives on
// TemplateListing._asinReference. Mirrors the lookup in amazonStockChecks.js:
//   - _asinReference is `select: false`, so it must be requested with a leading +
//   - SKUs are matched on baseCustomLabel (the part before the first "-") under
//     an en/strength-2 collation, which is what the baseCustomLabel_asin_ci_lookup
//     index is built for.
const cleanAsin = (v) => String(v || '').trim().toUpperCase();
const getBaseLabel = (v) => String(v || '').trim().split('-')[0].trim();
const isAmazonAsin = (v) => /^B0[A-Z0-9]{8}$/.test(cleanAsin(v));

// itemPhotoUrl stores every image for the listing as a pipe-separated list;
// the first entry is the primary photo.
const firstPhotoUrl = (v) => String(v || '').split('|')[0].trim();

async function buildAsinLookup(offers, sellerId) {
  const labels = [
    ...new Set(offers.map((o) => getBaseLabel(o.sku)).filter(Boolean)),
  ];
  if (labels.length === 0) return new Map();

  const rows = await TemplateListing.find({
    baseCustomLabel: { $in: labels },
    _asinReference: { $exists: true, $ne: '' },
  })
    .select('customLabel baseCustomLabel sellerId deletedAt itemPhotoUrl amazonLink +_asinReference')
    .collation({ locale: 'en', strength: 2 })
    .lean();

  // A SKU can exist under several sellers (and under soft-deleted rows). Rank
  // candidates so the offer's own seller wins, then any live row, rather than
  // letting whichever document Mongo returned first decide.
  const best = new Map();
  for (const row of rows) {
    const label = getBaseLabel(row.baseCustomLabel || row.customLabel).toUpperCase();
    if (!label) continue;
    const score =
      (String(row.sellerId) === String(sellerId) ? 2 : 0) + (row.deletedAt ? 0 : 1);
    const current = best.get(label);
    if (current && current.score >= score) continue;

    const asin = cleanAsin(row._asinReference);
    best.set(label, {
      score,
      asin,
      amazonLink: row.amazonLink || `https://www.amazon.com/dp/${asin}`,
      imageUrl: firstPhotoUrl(row.itemPhotoUrl),
    });
  }
  return best;
}

// ─── Normalise one eBay BestOffer node into a clean object ───────────────────
// Works for both ItemBestOffersArray.ItemBestOffers.Item (no ItemID call) and
// the top-level Item returned when an ItemID is supplied.
function parseOffer(item, offer) {
  // BuyItNowPrice is the listing price in both response shapes
  const listPrice = item.BuyItNowPrice?._ ?? item.BuyItNowPrice ?? null;
  const listCurrency = item.BuyItNowPrice?.['$']?.currencyID ?? item.Currency ?? 'USD';

  return {
    sku: item.SKU ?? '',
    bestOfferId: offer.BestOfferID,
    itemId: item.ItemID,
    title: item.Title ?? `Item ${item.ItemID}`,
    listingPrice: listPrice,
    listingCurrency: listCurrency,
    listingEndTime: item.ListingDetails?.EndTime ?? null,
    offerPrice: offer.Price?._ ?? offer.Price ?? null,
    offerCurrency: offer.Price?.['$']?.currencyID ?? 'USD',
    quantity: offer.Quantity ?? 1,
    status: offer.Status,
    buyerMessage: offer.BuyerMessage ?? '',
    sellerMessage: offer.SellerMessage ?? '',
    expirationTime: offer.ExpirationTime ?? null,
    offerType: offer.BestOfferCodeType ?? 'BuyerBestOffer',
    buyerId: offer.Buyer?.UserID ?? '',
    buyerFeedbackScore: offer.Buyer?.FeedbackScore ?? 0,
    buyerEmail: offer.Buyer?.Email ?? '',
    // Filled in below by the GetItem / TemplateListing enrichment passes.
    imageUrl: '',
    asin: '',
    amazonLink: '',
  };
}

// =============================================================================
// GET /best-offers
// Query: sellerId, status (Active|Accepted|Declined|Expired|All)
//
// Per eBay Trading API docs (v1453):
//   - Omit both ItemID and BestOfferID → eBay returns ALL active seller offers
//     in ItemBestOffersArray (up to 10,000 IDs for sellers).
//   - Supplying an ItemID → returns BestOfferArray for that specific listing,
//     and the BestOfferStatus filter is honoured (including "All").
//   - Note: when no ItemID is given, the status filter is effectively always
//     "Active" regardless of what is passed (eBay API limitation).
// =============================================================================
/**
 * @swagger
 * /ebay/best-offers:
 *   get:
 *     tags: [Best Offers]
 *     summary: Fetch active best offers for a seller via eBay Trading API
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [Active, Accepted, Declined, Expired, All], default: Active }
 *         description: Status filter — only honoured when an ItemID is also supplied (eBay API limitation)
 *     responses:
 *       200:
 *         description: List of offers enriched with SKU
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:      { type: boolean }
 *                 offers:       { type: array, items: { type: object } }
 *                 totalEntries: { type: integer }
 *                 totalPages:   { type: integer }
 *                 currentPage:  { type: integer }
 *       400:
 *         description: Missing sellerId or eBay API error
 *       404:
 *         description: Seller not found
 *       500:
 *         description: Internal server error
 */
router.get('/best-offers', requireAuth, async (req, res) => {
  try {
    const { sellerId, status = 'Active' } = req.query;

    if (!sellerId) return res.status(400).json({ error: 'Missing sellerId' });

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);
    const siteId = getSiteId(seller);

    // When no ItemID is supplied eBay defaults to Active — the "All" filter
    // only works together with an ItemID per the docs.
    // We omit <BestOfferStatus> entirely so eBay uses its default (Active),
    // which is the same behaviour the seller sees in Seller Hub.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetBestOffersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>
</GetBestOffersRequest>`;

    const response = await axios.post(EBAY_TRADING_URL, xml, {
      headers: tradingHeaders('GetBestOffers', siteId),
    });

    const parsed = await parseStringPromise(response.data, { explicitArray: false });
    const root = parsed?.GetBestOffersResponse;

    if (root?.Ack === 'Failure') {
      const errs = toArray(root?.Errors);
      return res.status(400).json({
        error: 'eBay API error',
        details: errs.map((e) => e.LongMessage).join('; '),
      });
    }

    // eBay returns results in ItemBestOffersArray when no ItemID is given.
    // Each entry groups one item with all its offers.
    const offers = [];
    for (const entry of toArray(root?.ItemBestOffersArray?.ItemBestOffers)) {
      const item = entry?.Item ?? {};
      for (const offer of toArray(entry?.BestOfferArray?.BestOffer)) {
        offers.push(parseOffer(item, offer));
      }
    }

    // ── Enrich with SKU + photo via GetItem (parallel, one per unique item) ──
    // GetBestOffers does not return Item.SKU in its item stub; GetItem does.
    if (offers.length > 0) {
      const uniqueItemIds = [...new Set(offers.map(o => o.itemId).filter(Boolean))];
      const detailResults = await mapWithConcurrency(
        uniqueItemIds,
        id => fetchItemDetails(token, siteId, id).then(d => [id, d])
      );
      const detailMap = new Map(detailResults);
      for (const offer of offers) {
        const details = detailMap.get(offer.itemId);
        if (!details) continue;
        if (details.sku) offer.sku = details.sku;
        if (details.imageUrl) offer.imageUrl = details.imageUrl;
      }

      // ── Enrich with ASIN from the Template Listings DB (one batched query) ──
      // Resolved after the SKU pass above, since the SKU is the join key.
      const asinByLabel = await buildAsinLookup(offers, sellerId);
      for (const offer of offers) {
        // Some sellers use the ASIN itself as the custom label — no lookup needed.
        if (isAmazonAsin(offer.sku)) {
          offer.asin = cleanAsin(offer.sku);
          offer.amazonLink = `https://www.amazon.com/dp/${offer.asin}`;
          continue;
        }
        const match = asinByLabel.get(getBaseLabel(offer.sku).toUpperCase());
        if (!match) continue;
        offer.asin = match.asin;
        offer.amazonLink = match.amazonLink;
        if (!offer.imageUrl) offer.imageUrl = match.imageUrl;
      }
    }

    console.log(
      `[BestOffers] fetched ${offers.length} offer(s) via single GetBestOffers call; ` +
      `${offers.filter(o => o.asin).length} resolved to an ASIN`
    );

    const pagination = root?.PaginationResult ?? {};
    return res.json({
      success: true,
      offers,
      totalEntries: parseInt(pagination.TotalNumberOfEntries) || offers.length,
      totalPages: parseInt(pagination.TotalNumberOfPages) || 1,
      currentPage: 1,
    });
  } catch (err) {
    console.error('[BestOffers] error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch best offers', details: err.message });
  }
});

// =============================================================================
// POST /best-offers/respond
// Body: { sellerId, itemId, bestOfferId, action, counterPrice?, counterQuantity?, sellerResponse? }
// action: 'Accept' | 'Decline' | 'Counter'
// =============================================================================
/**
 * @swagger
 * /ebay/best-offers/respond:
 *   post:
 *     tags: [Best Offers]
 *     summary: Accept, decline, or counter a buyer's best offer
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sellerId, itemId, bestOfferId, action]
 *             properties:
 *               sellerId:       { type: string }
 *               itemId:         { type: string }
 *               bestOfferId:    { type: string }
 *               action:         { type: string, enum: [Accept, Decline, Counter] }
 *               counterPrice:   { type: number, description: Required when action is Counter }
 *               counterQuantity:{ type: integer }
 *               sellerResponse: { type: string }
 *     responses:
 *       200:
 *         description: Action applied successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 ack:     { type: string }
 *                 message: { type: string }
 *       400:
 *         description: Missing fields, invalid action, or eBay API error
 *       404:
 *         description: Seller not found
 *       500:
 *         description: Internal server error
 */
router.post('/best-offers/respond', requireAuth, async (req, res) => {
  try {
    const {
      sellerId,
      itemId,
      bestOfferId,
      action,
      counterPrice,
      counterQuantity,
      sellerResponse,
    } = req.body;

    if (!sellerId || !itemId || !bestOfferId || !action) {
      return res.status(400).json({
        error: 'Missing required fields: sellerId, itemId, bestOfferId, action',
      });
    }

    const VALID_ACTIONS = ['Accept', 'Decline', 'Counter'];
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({
        error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}`,
      });
    }

    if (action === 'Counter' && !counterPrice) {
      return res.status(400).json({ error: 'counterPrice is required when action is Counter' });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);
    const siteId = getSiteId(seller);

    const counterBlock =
      action === 'Counter'
        ? `<CounterOfferPrice currencyID="USD">${parseFloat(counterPrice).toFixed(2)}</CounterOfferPrice>
         <CounterOfferQuantity>${parseInt(counterQuantity) || 1}</CounterOfferQuantity>`
        : '';

    const sellerResponseBlock = sellerResponse
      ? `<SellerResponse>${escapeXml(sellerResponse)}</SellerResponse>`
      : '';

    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<RespondToBestOfferRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <ItemID>${escapeXml(itemId)}</ItemID>
  <BestOfferID>${escapeXml(bestOfferId)}</BestOfferID>
  <Action>${escapeXml(action)}</Action>
  ${counterBlock}
  ${sellerResponseBlock}
</RespondToBestOfferRequest>`;

    const response = await axios.post(EBAY_TRADING_URL, xmlRequest, {
      headers: tradingHeaders('RespondToBestOffer', siteId),
    });

    const parsed = await parseStringPromise(response.data, { explicitArray: false });
    const root = parsed.RespondToBestOfferResponse;
    const ack = root?.Ack;

    if (ack === 'Failure') {
      const errors = toArray(root?.Errors);
      return res.status(400).json({
        error: 'eBay API error',
        details: errors.map((e) => e.LongMessage).join('; '),
      });
    }

    return res.json({
      success: true,
      ack,
      message: `Offer ${action.toLowerCase()}ed successfully`,
    });
  } catch (err) {
    console.error('[BestOffers] RespondToBestOffer error:', err.message);
    return res.status(500).json({ error: 'Failed to respond to offer', details: err.message });
  }
});

// =============================================================================
// GET /eligible-offers
// Uses eBay Negotiation REST API — finds listings eligible for seller-initiated
// offers to interested buyers (watchers/viewers), matching the "Eligible to
// send offers" count shown in eBay Seller Hub.
// Query: sellerId
// =============================================================================
/**
 * @swagger
 * /ebay/eligible-offers:
 *   get:
 *     tags: [Best Offers]
 *     summary: Find listings eligible for seller-initiated offers (eBay Negotiation API)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Listings with interestedBuyers count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 items:   { type: array, items: { type: object } }
 *                 total:   { type: integer }
 *       400:
 *         description: Missing sellerId
 *       404:
 *         description: Seller not found
 *       500:
 *         description: Internal server error
 */
router.get('/eligible-offers', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.query;
    if (!sellerId) return res.status(400).json({ error: 'Missing sellerId' });

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);
    const marketplaceId = seller.ebayMarketplaces?.[0] ?? 'EBAY_US';

    const response = await axios.get(
      'https://api.ebay.com/sell/negotiation/v1/find_eligible_items',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
          'Content-Type': 'application/json',
        },
        params: { limit: 200, offset: 0 },
      }
    );

    // find_eligible_items returns ONLY listingId per entry (see EligibleItem in
    // the Negotiation API docs) — no title, price, photo, or buyer count. The
    // listingId is the same value as the Trading API's ItemID, so GetItem fills
    // in everything the table renders.
    const eligibleItems = response.data.eligibleItems ?? [];
    const siteId = getSiteId(seller);

    const items = await mapWithConcurrency(eligibleItems, async (i) => {
      const listingId = i.listingId;
      const details = await fetchItemDetails(token, siteId, listingId);
      return {
        listingId,
        itemId: listingId,
        title: details.title || listingId,
        imageUrl: details.imageUrl,
        currentPrice: details.currentPrice,
        currentPriceCurrency: details.currentPriceCurrency,
        bestOfferEnabled: details.bestOfferEnabled,
        listingStatus: details.listingStatus || 'ACTIVE',
        // eBay does not expose a minimum offer price or a per-listing buyer
        // count on this endpoint; both stay null/0 until a richer source exists.
        minimumOfferPrice: null,
        minimumOfferCurrency: 'USD',
        interestedBuyers: 0,
      };
    });

    console.log(
      `[BestOffers] ${items.length} eligible listing(s); ` +
      `${items.filter(i => i.imageUrl).length} enriched with a photo`
    );

    return res.json({ success: true, items, total: response.data.total ?? items.length });
  } catch (err) {
    const ebayError = err.response?.data?.errors?.[0]?.message ?? err.message;
    console.error('[BestOffers] find_eligible_items error:', err.response?.data ?? err.message);
    return res.status(err.response?.status ?? 500).json({ error: 'Failed to fetch eligible items', details: ebayError });
  }
});

// =============================================================================
// POST /eligible-offers/send
// Uses eBay Negotiation REST API — sends a seller-initiated offer to all
// interested buyers on a listing.
// Body: { sellerId, listingId, price, currency?, quantity?, message?, allowCounter? }
// =============================================================================
/**
 * @swagger
 * /ebay/eligible-offers/send:
 *   post:
 *     tags: [Best Offers]
 *     summary: Send a seller-initiated offer to all interested buyers on a listing
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sellerId, listingId, price]
 *             properties:
 *               sellerId:     { type: string }
 *               listingId:    { type: string }
 *               price:        { type: number }
 *               currency:     { type: string, default: USD }
 *               quantity:     { type: integer, default: 1 }
 *               message:      { type: string }
 *               allowCounter: { type: boolean, default: true }
 *     responses:
 *       200:
 *         description: Offer sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *       400:
 *         description: Missing required fields or eBay API error
 *       404:
 *         description: Seller not found
 *       500:
 *         description: Internal server error
 */
router.post('/eligible-offers/send', requireAuth, async (req, res) => {
  try {
    const { sellerId, listingId, price, currency, quantity, message, allowCounter = true } = req.body;

    if (!sellerId || !listingId || !price) {
      return res.status(400).json({ error: 'Missing required fields: sellerId, listingId, price' });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);
    const marketplaceId = seller.ebayMarketplaces?.[0] ?? 'EBAY_US';

    await axios.post(
      'https://api.ebay.com/sell/negotiation/v1/send_offer_to_interested_buyers',
      {
        allowCounterOffer: Boolean(allowCounter),
        message: message || undefined,
        offeredItems: [{
          listingId,
          price: { currency: currency || 'USD', value: parseFloat(price).toFixed(2) },
          quantity: parseInt(quantity) || 1,
        }],
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
          'Content-Type': 'application/json',
        },
      }
    );

    return res.json({ success: true, message: 'Offer sent to interested buyers' });
  } catch (err) {
    const ebayError = err.response?.data?.errors?.[0]?.message ?? err.message;
    console.error('[BestOffers] send_offer_to_interested_buyers error:', err.response?.data ?? err.message);
    return res.status(err.response?.status ?? 500).json({ error: 'Failed to send offer', details: ebayError });
  }
});

export default router;

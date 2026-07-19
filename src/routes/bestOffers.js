/**
 * Best Offers routes — eBay Trading API + Negotiation REST API
 *
 * GET  /api/ebay/best-offers            — GetBestOffers (Trading API)
 * POST /api/ebay/best-offers/respond    — RespondToBestOffer (Trading API)
 * GET  /api/ebay/eligible-offers        — find_eligible_items (Negotiation API)
 * POST /api/ebay/eligible-offers/send   — send_offer_to_interested_buyers (Negotiation API)
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

// ─── Base SKU (everything before the first hyphen) ────────────────────────────
// Matches TemplateListing's own baseCustomLabel derivation (TemplateListing.js),
// so this lines up with the value already indexed in that field.
const getBaseCustomLabel = (sku) => String(sku || '').trim().split('-')[0].trim();

// ─── Run async work over a list with a max number of in-flight calls ─────────
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

// ─── Fetch live title/image/price for a single item via GetItem ──────────────
// Used to enrich buyer offers and eligible-offers listings with real-time eBay
// data instead of a locally cached collection, which can be stale or missing
// entries.
async function fetchItemLiveDetails(token, siteId, itemId) {
  try {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${escapeXml(itemId)}</ItemID>
  <IncludeItemSpecifics>false</IncludeItemSpecifics>
  <DetailLevel>ReturnAll</DetailLevel>
  <OutputSelector>Title</OutputSelector>
  <OutputSelector>PictureDetails</OutputSelector>
  <OutputSelector>SellingStatus</OutputSelector>
  <OutputSelector>SKU</OutputSelector>
  <OutputSelector>BestOfferDetails</OutputSelector>
</GetItemRequest>`;
    const resp = await axios.post(EBAY_TRADING_URL, xml, {
      headers: tradingHeaders('GetItem', siteId),
    });
    const parsed = await parseStringPromise(resp.data, { explicitArray: false });
    const item = parsed?.GetItemResponse?.Item;
    if (!item) return null;

    const pictureUrls = toArray(item.PictureDetails?.PictureURL);

    return {
      title: item.Title ?? '',
      sku: item.SKU ?? '',
      imageUrl: pictureUrls[0] ?? '',
      currentPrice: item.SellingStatus?.CurrentPrice?._ ?? item.SellingStatus?.CurrentPrice ?? null,
      currentPriceCurrency: item.SellingStatus?.CurrentPrice?.['$']?.currencyID ?? 'USD',
      // Counteroffers on a proactive send are only accepted by eBay when the
      // listing itself has Best Offer enabled (Item.BestOfferDetails.BestOfferEnabled).
      bestOfferEnabled: item.BestOfferDetails?.BestOfferEnabled === 'true',
    };
  } catch {
    return null;
  }
}

// ─── Fetch a single page of GetBestOffers ─────────────────────────────────────
async function fetchBestOffersPage(token, siteId, pageNumber) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetBestOffersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>${pageNumber}</PageNumber>
  </Pagination>
</GetBestOffersRequest>`;

  const response = await axios.post(EBAY_TRADING_URL, xml, {
    headers: tradingHeaders('GetBestOffers', siteId),
  });

  const parsed = await parseStringPromise(response.data, { explicitArray: false });
  return parsed?.GetBestOffersResponse;
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
    const { sellerId } = req.query;

    if (!sellerId) return res.status(400).json({ error: 'Missing sellerId' });

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);
    const siteId = getSiteId(seller);

    // When no ItemID is supplied eBay defaults to Active — the "All" filter
    // only works together with an ItemID per the docs.
    // We omit <BestOfferStatus> entirely so eBay uses its default (Active),
    // which is the same behaviour the seller sees in Seller Hub.
    //
    // eBay caps this account-wide call at 10,000 offer IDs for a seller, which
    // at 200 entries/page is a max of 50 pages — we loop until TotalNumberOfPages
    // is exhausted (or that cap) so sellers with >200 active offers aren't
    // silently truncated to just the first page.
    const MAX_PAGES = 50;
    const offers = [];
    let totalEntries = 0;
    let totalPages = 1;

    for (let pageNumber = 1; pageNumber <= totalPages && pageNumber <= MAX_PAGES; pageNumber++) {
      const root = await fetchBestOffersPage(token, siteId, pageNumber);

      if (root?.Ack === 'Failure') {
        const errs = toArray(root?.Errors);
        return res.status(400).json({
          error: 'eBay API error',
          details: errs.map((e) => e.LongMessage).join('; '),
        });
      }

      // eBay returns results in ItemBestOffersArray when no ItemID is given.
      // Each entry groups one item with all its offers.
      for (const entry of toArray(root?.ItemBestOffersArray?.ItemBestOffers)) {
        const item = entry?.Item ?? {};
        for (const offer of toArray(entry?.BestOfferArray?.BestOffer)) {
          offers.push(parseOffer(item, offer));
        }
      }

      const pagination = root?.PaginationResult ?? {};
      totalEntries = parseInt(pagination.TotalNumberOfEntries) || offers.length;
      totalPages = parseInt(pagination.TotalNumberOfPages) || 1;
    }

    // ── Enrich with SKU + image via GetItem (bounded concurrency, one call per unique item ID) ──
    // GetBestOffers does not return Item.SKU or pictures in its item stub;
    // GetItem does. Capped at 10 in flight so large sellers (now that
    // pagination is uncapped above) don't blow through eBay's Trading API
    // rate limits in one burst.
    if (offers.length > 0) {
      const uniqueItemIds = [...new Set(offers.map(o => o.itemId).filter(Boolean))];
      const detailResults = await mapWithConcurrency(uniqueItemIds, 10, (id) =>
        fetchItemLiveDetails(token, siteId, id).then((details) => [id, details])
      );
      const detailMap = Object.fromEntries(detailResults);
      for (const offer of offers) {
        const details = detailMap[offer.itemId];
        if (details?.sku) offer.sku = details.sku;
        offer.imageUrl = details?.imageUrl ?? '';
      }
    }

    // ── Enrich with ASIN/Amazon link via TemplateListing, matched on base SKU ──
    // eBay SKUs often carry a variant/quantity suffix (e.g. ABC123-1) that the
    // template's own customLabel doesn't have, so match on the part before the
    // first hyphen — the same baseCustomLabel the model already indexes.
    if (offers.length > 0) {
      const baseSkus = [...new Set(offers.map(o => getBaseCustomLabel(o.sku)).filter(Boolean))];
      if (baseSkus.length > 0) {
        const templates = await TemplateListing.find(
          { sellerId, baseCustomLabel: { $in: baseSkus } },
          { baseCustomLabel: 1, amazonLink: 1 }
        )
          .select('+_asinReference')
          .collation({ locale: 'en', strength: 2 })
          .lean();

        // The Mongo query matches case-insensitively (collation strength 2),
        // so key the in-memory map case-insensitively too or offers whose SKU
        // casing differs from the stored customLabel would silently miss.
        const asinMap = {};
        for (const t of templates) {
          const key = String(t.baseCustomLabel || '').toUpperCase();
          if (!t._asinReference || !key || asinMap[key]) continue;
          asinMap[key] = { asin: t._asinReference, amazonLink: t.amazonLink || `https://www.amazon.com/dp/${t._asinReference}` };
        }
        for (const offer of offers) {
          const match = asinMap[getBaseCustomLabel(offer.sku).toUpperCase()];
          offer.asin = match?.asin ?? null;
          offer.amazonLink = match?.amazonLink ?? null;
        }
      }
    }

    console.log(`[BestOffers] fetched ${offers.length} offer(s) via ${Math.min(totalPages, MAX_PAGES)} GetBestOffers page(s)`);

    return res.json({
      success: true,
      offers,
      totalEntries,
      totalPages: 1,
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
    const siteId = getSiteId(seller);

    // find_eligible_items is offset-paginated; loop until every page is
    // fetched (capped so a very large catalog can't spin forever).
    const PAGE_SIZE = 200;
    const MAX_PAGES = 50;
    const rawItems = [];
    let total = 0;

    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const offset = pageIndex * PAGE_SIZE;
      const response = await axios.get(
        'https://api.ebay.com/sell/negotiation/v1/find_eligible_items',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
            'Content-Type': 'application/json',
          },
          params: { limit: PAGE_SIZE, offset },
        }
      );

      rawItems.push(...(response.data.eligibleItems ?? []));
      total = response.data.total ?? rawItems.length;

      if (rawItems.length >= total || !response.data.eligibleItems?.length) break;
    }

    // find_eligible_items doesn't return image/title/current price — pull
    // those live from eBay via GetItem (bounded concurrency), one call per
    // unique item, rather than relying on a locally cached collection.
    const uniqueItemIds = [...new Set(rawItems.map((i) => i.itemId ?? i.listingId).filter(Boolean))];
    const detailResults = await mapWithConcurrency(uniqueItemIds, 10, (id) =>
      fetchItemLiveDetails(token, siteId, id).then((details) => [id, details])
    );
    const detailMap = Object.fromEntries(detailResults);

    const items = rawItems.map((i) => {
      const details = detailMap[i.itemId ?? i.listingId];
      return {
        listingId: i.listingId,
        itemId: i.itemId,
        title: details?.title || i.listingTitle || i.listingId,
        sku: details?.sku ?? '',
        imageUrl: details?.imageUrl ?? '',
        currentPrice: details?.currentPrice ?? null,
        currentPriceCurrency: details?.currentPriceCurrency ?? 'USD',
        // null when GetItem failed for this item — treat as "unknown" in the UI,
        // not as "disabled".
        bestOfferEnabled: details ? Boolean(details.bestOfferEnabled) : null,
        listingStatus: i.listingStatus ?? 'ACTIVE',
        minimumOfferPrice: i.minimumOfferPrice?.value ?? null,
        minimumOfferCurrency: i.minimumOfferPrice?.currency ?? 'USD',
        interestedBuyers: i.eligibleCounterPartiesCount ?? 0,
      };
    });

    return res.json({ success: true, items, total });
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
// Body: { sellerId, listingId, discountType, discountValue, currency?, quantity?, message?, allowCounter? }
// discountType: 'PERCENTAGE' (5-90, sent as offeredItems[].discountPercentage)
//             | 'AMOUNT_OFF'  (dollar amount off current price, converted to an absolute price)
//             | 'PRICE'       (discountValue is the exact final offer price)
// Per eBay's OfferedItem schema, price and discountPercentage are mutually
// exclusive — only one of them is ever sent to eBay.
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
 *             required: [sellerId, listingId, discountType, discountValue]
 *             properties:
 *               sellerId:      { type: string }
 *               listingId:     { type: string }
 *               discountType:  { type: string, enum: [PERCENTAGE, AMOUNT_OFF, PRICE] }
 *               discountValue: { type: number, description: Percent (5-90) for PERCENTAGE, dollar amount for AMOUNT_OFF, final price for PRICE }
 *               currentPrice:  { type: number, description: Required for AMOUNT_OFF to compute the resulting offer price }
 *               currency:      { type: string, default: USD }
 *               quantity:      { type: integer, default: 1 }
 *               message:       { type: string }
 *               allowCounter:  { type: boolean, default: false, description: If eBay rejects counteroffers for the listing, the send is retried automatically without them }
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
    const {
      sellerId,
      listingId,
      discountType,
      discountValue,
      currentPrice,
      currency,
      quantity,
      message,
      // Defaults to false (not true): eBay rejects allowCounterOffer:true for
      // listings where it isn't supported, so an omitted/undefined value from
      // the client should never silently opt into the request that's more
      // likely to fail.
      allowCounter = false,
    } = req.body;

    if (!sellerId || !listingId || !discountType || discountValue == null) {
      return res.status(400).json({
        error: 'Missing required fields: sellerId, listingId, discountType, discountValue',
      });
    }

    const VALID_DISCOUNT_TYPES = ['PERCENTAGE', 'AMOUNT_OFF', 'PRICE'];
    if (!VALID_DISCOUNT_TYPES.includes(discountType)) {
      return res.status(400).json({
        error: `Invalid discountType. Must be one of: ${VALID_DISCOUNT_TYPES.join(', ')}`,
      });
    }

    if (discountType === 'PERCENTAGE' && (discountValue < 5 || discountValue > 90)) {
      return res.status(400).json({ error: 'discountValue for PERCENTAGE must be between 5 and 90' });
    }

    if (discountType === 'AMOUNT_OFF' && !currentPrice) {
      return res.status(400).json({ error: 'currentPrice is required when discountType is AMOUNT_OFF' });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const token = await ensureValidToken(seller);
    const marketplaceId = seller.ebayMarketplaces?.[0] ?? 'EBAY_US';
    const offerCurrency = currency || 'USD';

    // Per eBay's OfferedItem schema, price and discountPercentage are
    // mutually exclusive — build exactly one of them.
    const offeredItem = {
      listingId,
      quantity: parseInt(quantity) || 1,
    };
    if (discountType === 'PERCENTAGE') {
      offeredItem.discountPercentage = String(discountValue);
    } else {
      const finalPrice =
        discountType === 'AMOUNT_OFF'
          ? Math.max(0, parseFloat(currentPrice) - parseFloat(discountValue))
          : parseFloat(discountValue);
      offeredItem.price = { currency: offerCurrency, value: finalPrice.toFixed(2) };
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
      'Content-Type': 'application/json',
    };
    const sendUrl = 'https://api.ebay.com/sell/negotiation/v1/send_offer_to_interested_buyers';

    let counterOfferDisabledByEbay = false;
    try {
      await axios.post(
        sendUrl,
        {
          allowCounterOffer: Boolean(allowCounter),
          message: message || undefined,
          offeredItems: [offeredItem],
        },
        { headers }
      );
    } catch (err) {
      // eBay rejects allowCounterOffer:true for some listings (errorId 150009)
      // for reasons not fully covered by our own bestOfferEnabled detection —
      // rather than failing the whole send, retry once without it.
      const errs = err.response?.data?.errors ?? [];
      const isCounterOfferRejection =
        allowCounter && errs.some((e) => e.errorId === 150009 || /allowCounterOffer/i.test(e.message ?? ''));

      if (!isCounterOfferRejection) throw err;

      counterOfferDisabledByEbay = true;
      await axios.post(
        sendUrl,
        {
          allowCounterOffer: false,
          message: message || undefined,
          offeredItems: [offeredItem],
        },
        { headers }
      );
    }

    // The counteroffer status of the offer that actually went out — true only
    // when the first attempt (with allowCounter as requested) succeeded as-is.
    const allowCounterOfferSent = Boolean(allowCounter) && !counterOfferDisabledByEbay;

    let sendMessage;
    if (allowCounterOfferSent) {
      sendMessage = 'Offer sent to interested buyers. Buyers can send a counteroffer.';
    } else if (counterOfferDisabledByEbay) {
      sendMessage = "Offer sent — eBay doesn't allow counteroffers for this listing, so it was sent without that option.";
    } else {
      sendMessage = 'Offer sent to interested buyers. Counteroffers are off for this offer.';
    }

    return res.json({
      success: true,
      message: sendMessage,
      allowCounterOfferSent,
      counterOfferDisabledByEbay,
    });
  } catch (err) {
    const ebayError = err.response?.data?.errors?.[0]?.message ?? err.message;
    console.error('[BestOffers] send_offer_to_interested_buyers error:', err.response?.data ?? err.message);
    return res.status(err.response?.status ?? 500).json({ error: 'Failed to send offer', details: ebayError });
  }
});

export default router;

import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import pLimit from 'p-limit';
import { parseStringPromise } from 'xml2js';

import Seller from '../models/Seller.js';
import ListingOverlayRun from '../models/ListingOverlayRun.js';
import ListingOverlayItem from '../models/ListingOverlayItem.js';
import OverlayListingSnapshot from '../models/OverlayListingSnapshot.js';
import { requireAuth, requireAuthSSE, requirePageAccess } from '../middleware/auth.js';
import { ensureValidToken } from './ebay.js';
import { resolveBadge } from '../config/overlayBadges.js';
import { overlayListingImages } from '../utils/overlayImage.js';
import { normalizePlacement } from '../utils/overlayCompositor.js';
import { parseKeywordQuery, matchesKeywords } from '../utils/keywordFilter.js';

const router = express.Router();
const PAGE_ID = 'ListingOverlays';

const EBAY_API = 'https://api.ebay.com/ws/api.dll';

// SiteID 0 throughout: these calls read/write item data rather than prices in a
// site currency, and 0 is what the existing seller-wide crawls use.
function tradingHeaders(callName) {
  return {
    'X-EBAY-API-SITEID': '0',
    'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
    'X-EBAY-API-CALL-NAME': callName,
    'Content-Type': 'text/xml',
  };
}

// The category box is free text, so a stray '(' or '*' would otherwise throw
// inside the regex query rather than simply matching nothing.
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Syncing crawls a seller's entire inventory and deleting throws the snapshot
// away, so both are superadmin-only. The page can be granted to other roles,
// and hiding a button is presentation, not permission — this is the actual gate.
function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only a superadmin can sync or delete stored listings.' });
  }
  next();
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * SSE plumbing shared by both streams: headers, heartbeat, and a closed flag so
 * a long eBay crawl stops as soon as the operator navigates away.
 */
function openSseStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const state = { closed: false };

  const send = (payload) => {
    if (state.closed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  const heartbeat = setInterval(() => send({ type: 'ping', timestamp: Date.now() }), 15000);

  const close = () => {
    if (state.closed) return;
    state.closed = true;
    clearInterval(heartbeat);
  };

  req.on('close', close);

  return {
    send,
    close,
    finish: () => {
      if (!state.closed) {
        res.write('data: [DONE]\n\n');
        if (typeof res.flush === 'function') res.flush();
      }
      close();
      res.end();
    },
    isOpen: () => !state.closed,
  };
}

/**
 * Every currently-active listing for a seller, straight from eBay.
 *
 * Uses the END-time window rather than the start-time window that
 * /ebay/sync-all-listings uses: that endpoint is an incremental sync and
 * deliberately looks at listings created since the last poll, which here would
 * silently omit everything older. Every live listing has an end time in the
 * future, so EndTimeFrom=now covers the lot — the same trick runSkuIndexSync
 * already relies on.
 */
async function* crawlSellerListings(seller, stream) {
  const now = new Date();
  const endTimeFrom = now.toISOString();
  const endTimeTo = new Date(now.getTime() + 120 * 24 * 60 * 60 * 1000).toISOString();

  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && stream.isOpen()) {
    // Re-checked every page: a multi-thousand-listing crawl can outlive a token.
    const token = await ensureValidToken(seller);

    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <GranularityLevel>Coarse</GranularityLevel>
  <EndTimeFrom>${endTimeFrom}</EndTimeFrom>
  <EndTimeTo>${endTimeTo}</EndTimeTo>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
  <OutputSelector>ItemArray.Item.ItemID</OutputSelector>
  <OutputSelector>ItemArray.Item.Title</OutputSelector>
  <OutputSelector>ItemArray.Item.SKU</OutputSelector>
  <OutputSelector>ItemArray.Item.PrimaryCategory</OutputSelector>
  <OutputSelector>ItemArray.Item.PictureDetails</OutputSelector>
  <OutputSelector>ItemArray.Item.SellingStatus.ListingStatus</OutputSelector>
  <OutputSelector>PaginationResult</OutputSelector>
</GetSellerListRequest>`;

    const response = await axios.post(EBAY_API, xmlRequest, {
      headers: tradingHeaders('GetSellerList'),
      timeout: 60000,
    });

    const parsed = await parseStringPromise(response.data, { explicitArray: false });
    const body = parsed?.GetSellerListResponse;

    if (body?.Ack === 'Failure') {
      const errors = asArray(body.Errors);
      throw new Error(errors[0]?.LongMessage || 'GetSellerList failed');
    }

    totalPages = parseInt(body?.PaginationResult?.TotalNumberOfPages, 10) || 1;

    for (const item of asArray(body?.ItemArray?.Item)) {
      if (item?.SellingStatus?.ListingStatus !== 'Active') continue;

      yield {
        itemId: item.ItemID,
        title: item.Title || '',
        sku: item.SKU || '',
        categoryId: item.PrimaryCategory?.CategoryID || '',
        categoryName: item.PrimaryCategory?.CategoryName || '',
        // Gallery image only — enough for the table. The authoritative full
        // picture set is fetched per selected listing at preview time.
        image: asArray(item.PictureDetails?.PictureURL)[0] || '',
      };
    }

    yield { __progress: { page, totalPages } };
    page += 1;
  }
}

/**
 * A listing's complete picture list. GetSellerList's PictureDetails is not
 * guaranteed to carry every picture, and the revise call has to send the whole
 * set, so the authoritative read happens here — once per SELECTED listing.
 */
async function fetchListingPictures(token, itemId) {
  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Item.ItemID</OutputSelector>
  <OutputSelector>Item.Title</OutputSelector>
  <OutputSelector>Item.SKU</OutputSelector>
  <OutputSelector>Item.PictureDetails</OutputSelector>
</GetItemRequest>`;

  const response = await axios.post(EBAY_API, xmlRequest, {
    headers: tradingHeaders('GetItem'),
    timeout: 30000,
  });

  const parsed = await parseStringPromise(response.data, { explicitArray: false });
  const body = parsed?.GetItemResponse;

  if (body?.Ack === 'Failure') {
    const errors = asArray(body.Errors);
    throw new Error(errors[0]?.LongMessage || 'GetItem failed');
  }

  return {
    title: body?.Item?.Title || '',
    sku: body?.Item?.SKU || '',
    images: asArray(body?.Item?.PictureDetails?.PictureURL).filter(Boolean),
  };
}

/**
 * Replace a live listing's pictures. The full list is always sent: eBay rejects
 * a mixture of EPS-hosted and external pictures (20004), and a partial
 * PictureDetails is interpreted as the complete new set anyway.
 */
async function reviseListingPictures(token, itemId, images) {
  const pictureXml = images.map((url) => `<PictureURL>${url}</PictureURL>`).join('');

  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <ItemID>${itemId}</ItemID>
    <PictureDetails>${pictureXml}</PictureDetails>
  </Item>
</ReviseFixedPriceItemRequest>`;

  const response = await axios.post(EBAY_API, xmlRequest, {
    headers: tradingHeaders('ReviseFixedPriceItem'),
    timeout: 60000,
  });

  const parsed = await parseStringPromise(response.data, { explicitArray: false });
  const body = parsed?.ReviseFixedPriceItemResponse;

  if (body?.Ack === 'Failure') {
    const errors = asArray(body.Errors);
    throw new Error(errors.map((e) => e.LongMessage).filter(Boolean).join('; ') || 'ReviseFixedPriceItem failed');
  }

  return true;
}

async function loadSeller(sellerId) {
  if (!mongoose.Types.ObjectId.isValid(String(sellerId || ''))) return null;
  return Seller.findById(sellerId);
}

// ── Crawl cache ──────────────────────────────────────────────────────────────
// A full GetSellerList crawl of a large seller is ~127 pages and takes minutes,
// and the inventory does not change meaningfully inside a few minutes. So the
// UNFILTERED scan is kept in process memory per seller, and each new search
// filters the cached list instantly instead of re-paging eBay.
//
// Only crawls that ran to the last page are cached: a scan the operator
// stopped early is a partial inventory, and serving it as if complete would
// silently hide listings from the next search. `refresh=true` bypasses the
// cache for an operator who has just changed listings on eBay.
const CRAWL_CACHE_TTL_MS = (parseInt(process.env.LISTING_CRAWL_CACHE_TTL_SECONDS, 10) || 300) * 1000;
// ~25k listings ≈ 8MB, so a handful of sellers is the sensible ceiling.
const MAX_CACHED_SELLERS = 3;
const crawlCache = new Map(); // sellerId -> { fetchedAt, listings: [] }

function getCachedCrawl(sellerId) {
  const entry = crawlCache.get(sellerId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CRAWL_CACHE_TTL_MS) {
    crawlCache.delete(sellerId);
    return null;
  }
  return entry;
}

function setCachedCrawl(sellerId, listings) {
  if (crawlCache.size >= MAX_CACHED_SELLERS && !crawlCache.has(sellerId)) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, value] of crawlCache) {
      if (value.fetchedAt < oldestAt) {
        oldestAt = value.fetchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) crawlCache.delete(oldestKey);
  }
  crawlCache.set(sellerId, { fetchedAt: Date.now(), listings });
}

/**
 * GET /listing-overlays/snapshot/sync-stream?sellerId=
 *
 * Crawls the seller once and stores the result, so the badging pass can be
 * searched over and over — different keywords, page refreshes, days apart —
 * without re-paging eBay each time.
 */
router.get('/snapshot/sync-stream', requireAuthSSE, requirePageAccess(PAGE_ID), requireSuperAdmin, async (req, res) => {
  const { sellerId } = req.query;

  const seller = await loadSeller(sellerId);
  if (!seller) return res.status(404).json({ error: 'Seller not found' });

  const stream = openSseStream(req, res);
  const syncStart = new Date();

  try {
    let stored = 0;
    let batch = [];

    stream.send({ type: 'started' });

    // Written in batches rather than one-by-one: a 36k-listing seller is 36k
    // round trips otherwise, which dwarfs the crawl itself.
    const flush = async () => {
      if (!batch.length) return;
      await OverlayListingSnapshot.bulkWrite(batch, { ordered: false });
      stored += batch.length;
      batch = [];
    };

    for await (const entry of crawlSellerListings(seller, stream)) {
      if (!stream.isOpen()) break;

      if (entry.__progress) {
        await flush();
        stream.send({ type: 'progress', ...entry.__progress, stored });
        continue;
      }

      batch.push({
        updateOne: {
          filter: { seller: seller._id, itemId: entry.itemId },
          update: {
            $set: {
              sku: entry.sku,
              title: entry.title,
              categoryId: entry.categoryId,
              categoryName: entry.categoryName,
              imageUrl: entry.image,
              syncedAt: syncStart,
            },
          },
          upsert: true,
        },
      });

      if (batch.length >= 500) await flush();
    }

    await flush();

    // Only a crawl that reached the last page may prune. A pass stopped early
    // has not seen the whole inventory, so every listing it did not reach still
    // carries an older stamp and would be deleted as if it had ended.
    let removed = 0;
    if (stream.isOpen()) {
      const cleanup = await OverlayListingSnapshot.deleteMany({
        seller: seller._id,
        syncedAt: { $lt: syncStart },
      });
      removed = cleanup.deletedCount || 0;
    }

    const total = await OverlayListingSnapshot.countDocuments({ seller: seller._id });

    stream.send({
      type: 'complete',
      stored,
      removed,
      total,
      partial: !stream.isOpen(),
    });
    stream.finish();
  } catch (error) {
    console.error('[ListingOverlays] snapshot sync error:', error.message);
    stream.send({ type: 'error', error: error.message });
    stream.finish();
  }
});

/**
 * GET /listing-overlays/snapshot/status
 * Per-seller row counts and sync times, for the page's sync panel.
 */
router.get('/snapshot/status', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const rows = await OverlayListingSnapshot.aggregate([
      {
        $group: {
          _id: '$seller',
          count: { $sum: 1 },
          syncedAt: { $max: '$syncedAt' },
        },
      },
    ]);

    res.json({
      snapshots: rows.map((row) => ({
        sellerId: String(row._id),
        count: row.count,
        syncedAt: row.syncedAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /listing-overlays/snapshot?sellerId=  (omit sellerId to clear all)
 * The snapshot is scratch data for a one-off badging pass; this is how it gets
 * thrown away once the pass is done.
 */
router.delete('/snapshot', requireAuth, requirePageAccess(PAGE_ID), requireSuperAdmin, async (req, res) => {
  try {
    const { sellerId } = req.query;
    const filter = {};

    if (sellerId) {
      if (!mongoose.Types.ObjectId.isValid(String(sellerId))) {
        return res.status(400).json({ error: 'Invalid sellerId' });
      }
      filter.seller = sellerId;
    }

    const result = await OverlayListingSnapshot.deleteMany(filter);
    res.json({ deletedCount: result.deletedCount || 0, scope: sellerId ? 'seller' : 'all' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /listing-overlays/listings-stream
 * Searches the stored snapshot by default; `source=live` re-crawls eBay.
 * Either way the pictures that get badged are read live at preview time, so
 * stale rows can only surface an ended listing, never a wrong image.
 */
router.get('/listings-stream', requireAuthSSE, requirePageAccess(PAGE_ID), async (req, res) => {
  const {
    sellerId, category = '', search = '', refresh = '',
    includeBadged: includeBadgedParam = '', source = 'stored',
  } = req.query;
  const includeBadged = String(includeBadgedParam).toLowerCase() === 'true';
  const useLive = String(source).toLowerCase() === 'live';

  const seller = await loadSeller(sellerId);
  if (!seller) return res.status(404).json({ error: 'Seller not found' });

  const stream = openSseStream(req, res);
  const categoryFilter = String(category).trim().toLowerCase();
  const keywordGroups = parseKeywordQuery(search);
  const wantRefresh = String(refresh).toLowerCase() === 'true';

  const matchesFilters = (entry) => {
    if (categoryFilter && !String(entry.categoryName).toLowerCase().includes(categoryFilter)) return false;
    if (keywordGroups.length) {
      const haystack = `${entry.title} ${entry.sku} ${entry.itemId}`.toLowerCase();
      if (!matchesKeywords(haystack, keywordGroups)) return false;
    }
    return true;
  };

  try {
    let matched = 0;
    let scanned = 0;
    let hiddenBadged = 0;

    // Listings whose badge is live right now, so they are kept out of the table
    // and cannot be badged a second time. Status matters, not just the item id:
    // a REVERTED listing is back to its original picture and must be badgeable
    // again, and a previewed-but-never-submitted one never changed on eBay.
    //
    // Loaded fresh on every request rather than cached with the inventory —
    // otherwise listings submitted a minute ago would keep reappearing for as
    // long as the crawl cache lived.
    const badgedItemIds = new Set();
    if (!includeBadged) {
      const runIds = await ListingOverlayRun.find({ seller: seller._id }).distinct('_id');
      if (runIds.length) {
        const ids = await ListingOverlayItem
          .find({ run: { $in: runIds }, status: 'submitted' })
          .distinct('itemId');
        ids.forEach((id) => badgedItemIds.add(String(id)));
      }
    }

    // Counted only against listings that otherwise matched, so the number reads
    // as "of your results, this many are already done".
    const keep = (entry) => {
      if (!matchesFilters(entry)) return false;
      if (badgedItemIds.has(String(entry.itemId))) {
        hiddenBadged += 1;
        return false;
      }
      return true;
    };

    // Default path: search the stored snapshot. The category narrows the query
    // in the database; the keyword grammar then runs in memory so stored and
    // live searches behave identically rather than drifting apart.
    if (!useLive) {
      const query = { seller: seller._id };
      if (categoryFilter) {
        query.categoryName = { $regex: escapeRegex(categoryFilter), $options: 'i' };
      }

      const cursor = OverlayListingSnapshot.find(query)
        .select('itemId sku title categoryId categoryName imageUrl syncedAt')
        .lean()
        .cursor();

      let syncedAt = null;

      for await (const doc of cursor) {
        if (!stream.isOpen()) break;

        const entry = {
          itemId: doc.itemId,
          title: doc.title || '',
          sku: doc.sku || '',
          categoryId: doc.categoryId || '',
          categoryName: doc.categoryName || '',
          image: doc.imageUrl || '',
        };

        if (!syncedAt) syncedAt = doc.syncedAt;
        scanned += 1;
        if (!keep(entry)) continue;
        matched += 1;
        stream.send({ type: 'item', item: entry });
      }

      stream.send({
        type: 'complete',
        scanned,
        matched,
        hiddenBadged,
        fromSnapshot: true,
        snapshotEmpty: scanned === 0,
        syncedAt,
      });
      stream.finish();
      return;
    }

    // Served from the recent-crawl cache: filter in memory, no eBay calls.
    const cached = wantRefresh ? null : getCachedCrawl(String(sellerId));
    if (cached) {
      stream.send({ type: 'started', fromCache: true });

      for (const entry of cached.listings) {
        if (!stream.isOpen()) break;
        scanned += 1;
        if (!keep(entry)) continue;
        matched += 1;
        stream.send({ type: 'item', item: entry });
      }

      stream.send({
        type: 'complete',
        scanned,
        matched,
        hiddenBadged,
        fromCache: true,
        cacheAgeSeconds: Math.round((Date.now() - cached.fetchedAt) / 1000),
      });
      stream.finish();
      return;
    }

    stream.send({ type: 'started' });

    // Everything scanned is collected, matches or not — the cache has to hold
    // the whole inventory for a DIFFERENT filter to be answerable from it.
    const inventory = [];

    for await (const entry of crawlSellerListings(seller, stream)) {
      if (!stream.isOpen()) break;

      if (entry.__progress) {
        stream.send({ type: 'progress', ...entry.__progress, scanned, matched });
        continue;
      }

      scanned += 1;
      inventory.push(entry);

      if (!keep(entry)) continue;

      matched += 1;
      stream.send({ type: 'item', item: entry });
    }

    // Still open here means the crawl reached the last page rather than being
    // stopped by the operator or a dropped connection — the only state in
    // which the collected inventory is complete enough to cache.
    if (stream.isOpen()) {
      setCachedCrawl(String(sellerId), inventory);
    }

    stream.send({ type: 'complete', scanned, matched, hiddenBadged });
    stream.finish();
  } catch (error) {
    console.error('[ListingOverlays] listings-stream error:', error.message);
    stream.send({ type: 'error', error: error.message });
    stream.finish();
  }
});

/**
 * GET /listing-overlays/preview-stream
 * Composites the badge for each selected listing and hosts the result on EPS,
 * so the review step shows the real picture rather than a mock-up. Creates the
 * run and its item rows; nothing is revised on eBay yet.
 */
router.get('/preview-stream', requireAuthSSE, requirePageAccess(PAGE_ID), async (req, res) => {
  const { sellerId, badgeKey, itemIds = '', scale, anchor, margin } = req.query;

  const seller = await loadSeller(sellerId);
  if (!seller) return res.status(404).json({ error: 'Seller not found' });

  const badge = resolveBadge(badgeKey);
  if (!badge) return res.status(400).json({ error: `Unknown overlay badge: ${badgeKey}` });

  const ids = [...new Set(String(itemIds).split(',').map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ error: 'At least one itemId is required' });

  const placement = normalizePlacement({
    scale: scale !== undefined ? Number(scale) : undefined,
    anchor: anchor || undefined,
    margin: margin !== undefined ? Number(margin) : undefined,
  });

  const stream = openSseStream(req, res);

  let run;
  try {
    const token = await ensureValidToken(seller);

    run = await ListingOverlayRun.create({
      seller: seller._id,
      badgeKey: badge.key,
      filters: { category: req.query.category || '', search: req.query.search || '' },
      status: 'previewing',
      totalItems: ids.length,
      createdBy: req.user?.userId || null,
    });

    stream.send({ type: 'started', runId: run._id, total: ids.length });

    const limit = pLimit(parseInt(process.env.LISTING_OVERLAY_CONCURRENCY, 10) || 4);
    let completed = 0;

    await Promise.all(ids.map((itemId) => limit(async () => {
      if (!stream.isOpen()) return;

      try {
        const { title, sku, images } = await fetchListingPictures(token, itemId);

        if (!images.length) throw new Error('Listing has no pictures');

        const result = await overlayListingImages(images, { badge, placement }, {
          sellerId: String(seller._id),
          token,
        });

        if (!result.applied) throw new Error(result.warning || 'Overlay could not be applied');

        // Written before any revise happens, so the original set is already
        // recoverable if the submit stage dies partway through.
        await ListingOverlayItem.updateOne(
          { run: run._id, itemId },
          {
            $set: {
              sku,
              title,
              badgeKey: badge.key,
              originalImages: images,
              newImages: result.images,
              status: 'previewed',
              error: '',
            },
          },
          { upsert: true }
        );

        stream.send({
          type: 'item',
          item: {
            itemId, sku, title,
            originalImages: images,
            newImages: result.images,
            status: 'previewed',
            error: '',
          },
          progress: ++completed,
          total: ids.length,
        });
      } catch (error) {
        await ListingOverlayItem.updateOne(
          { run: run._id, itemId },
          { $set: { status: 'failed', error: error.message } },
          { upsert: true }
        );

        stream.send({
          type: 'item',
          item: { itemId, originalImages: [], newImages: [], status: 'failed', error: error.message },
          progress: ++completed,
          total: ids.length,
        });
      }
    })));

    stream.send({ type: 'complete', runId: run._id, total: completed });
    stream.finish();
  } catch (error) {
    console.error('[ListingOverlays] preview-stream error:', error.message);
    if (run) await ListingOverlayRun.updateOne({ _id: run._id }, { $set: { status: 'failed' } });
    stream.send({ type: 'error', error: error.message });
    stream.finish();
  }
});

/**
 * POST /listing-overlays/runs/:runId/submit
 * Pushes the previewed images to eBay. Only rows the operator kept are sent.
 */
router.post('/runs/:runId/submit', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const { runId } = req.params;
    const keepItemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(String) : null;

    const run = await ListingOverlayRun.findById(runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const seller = await Seller.findById(run.seller);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const query = { run: run._id, status: 'previewed' };
    if (keepItemIds) query.itemId = { $in: keepItemIds };

    const candidates = await ListingOverlayItem.find(query);
    if (!candidates.length) return res.status(400).json({ error: 'No previewed items to submit' });

    // Last line of defence against double-badging. The listings table already
    // hides items with a live badge, but a tab left open since before an
    // earlier submit would still be holding a run that predates it. Re-checked
    // here against the database rather than trusted from the request.
    const alreadyBadged = new Set(
      await ListingOverlayItem
        .find({
          itemId: { $in: candidates.map((item) => item.itemId) },
          status: 'submitted',
          run: { $ne: run._id },
        })
        .distinct('itemId')
    );

    const items = candidates.filter((item) => !alreadyBadged.has(item.itemId));
    const skippedAlreadyBadged = candidates.length - items.length;

    if (!items.length) {
      return res.status(400).json({
        error: 'Every selected listing already carries a live badge. Revert the earlier run before badging them again.',
        skippedAlreadyBadged,
      });
    }

    const token = await ensureValidToken(seller);
    await ListingOverlayRun.updateOne({ _id: run._id }, { $set: { status: 'submitting' } });

    const limit = pLimit(parseInt(process.env.LISTING_OVERLAY_CONCURRENCY, 10) || 4);
    let successCount = 0;
    let failedCount = 0;

    const results = await Promise.all(items.map((item) => limit(async () => {
      try {
        await reviseListingPictures(token, item.itemId, item.newImages);
        await ListingOverlayItem.updateOne(
          { _id: item._id },
          { $set: { status: 'submitted', submittedAt: new Date(), error: '' } }
        );
        successCount += 1;
        return { itemId: item.itemId, status: 'submitted' };
      } catch (error) {
        await ListingOverlayItem.updateOne(
          { _id: item._id },
          { $set: { status: 'failed', error: error.message } }
        );
        failedCount += 1;
        return { itemId: item.itemId, status: 'failed', error: error.message };
      }
    })));

    await ListingOverlayRun.updateOne(
      { _id: run._id },
      { $set: { status: 'completed', successCount, failedCount, completedAt: new Date() } }
    );

    res.json({ runId: run._id, successCount, failedCount, skippedAlreadyBadged, results });
  } catch (error) {
    console.error('[ListingOverlays] submit error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /listing-overlays/runs/:runId/revert
 * Restores each submitted listing's original picture list.
 */
router.post('/runs/:runId/revert', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const { runId } = req.params;

    const run = await ListingOverlayRun.findById(runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const seller = await Seller.findById(run.seller);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const items = await ListingOverlayItem.find({ run: run._id, status: 'submitted' });
    if (!items.length) return res.status(400).json({ error: 'No submitted items to revert' });

    const token = await ensureValidToken(seller);
    await ListingOverlayRun.updateOne({ _id: run._id }, { $set: { status: 'reverting' } });

    const limit = pLimit(parseInt(process.env.LISTING_OVERLAY_CONCURRENCY, 10) || 4);
    let revertedCount = 0;
    let failedCount = 0;

    const results = await Promise.all(items.map((item) => limit(async () => {
      // A row with no stored original cannot be restored; skip rather than
      // sending an empty PictureDetails, which would strip the listing's images.
      if (!item.originalImages?.length) {
        failedCount += 1;
        return { itemId: item.itemId, status: 'failed', error: 'No original images recorded' };
      }

      try {
        await reviseListingPictures(token, item.itemId, item.originalImages);
        await ListingOverlayItem.updateOne(
          { _id: item._id },
          { $set: { status: 'reverted', revertedAt: new Date(), error: '' } }
        );
        revertedCount += 1;
        return { itemId: item.itemId, status: 'reverted' };
      } catch (error) {
        await ListingOverlayItem.updateOne({ _id: item._id }, { $set: { error: error.message } });
        failedCount += 1;
        return { itemId: item.itemId, status: 'failed', error: error.message };
      }
    })));

    await ListingOverlayRun.updateOne(
      { _id: run._id },
      { $set: { status: 'reverted', revertedCount, revertedAt: new Date() } }
    );

    res.json({ runId: run._id, revertedCount, failedCount, results });
  } catch (error) {
    console.error('[ListingOverlays] revert error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /listing-overlays/runs?sellerId=
 * Recent runs, for the history panel and its revert action.
 */
router.get('/runs', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const query = {};
    if (req.query.sellerId && mongoose.Types.ObjectId.isValid(String(req.query.sellerId))) {
      query.seller = req.query.sellerId;
    }

    const runs = await ListingOverlayRun.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(parseInt(req.query.limit, 10) || 20, 100))
      .populate('seller', 'name')
      .populate('createdBy', 'name email')
      .lean();

    res.json({ runs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /listing-overlays/runs/:runId — a run's item rows.
 */
router.get('/runs/:runId', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const run = await ListingOverlayRun.findById(req.params.runId)
      .populate('seller', 'name')
      .lean();
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const items = await ListingOverlayItem.find({ run: run._id }).lean();
    res.json({ run, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

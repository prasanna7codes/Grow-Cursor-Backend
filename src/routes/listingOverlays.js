import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import pLimit from 'p-limit';
import { parseStringPromise } from 'xml2js';

import Seller from '../models/Seller.js';
import ListingOverlayRun from '../models/ListingOverlayRun.js';
import ListingOverlayItem from '../models/ListingOverlayItem.js';
import SellerSkuIndex from '../models/SellerSkuIndex.js';
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
    const message = errors.map((e) => e.LongMessage).filter(Boolean).join('; ') || 'ReviseFixedPriceItem failed';
    const failure = new Error(message);
    // eBay's numeric codes are stable where the prose is not, so the ended-listing
    // check below keys off them first and only falls back to matching text.
    failure.ebayErrorCodes = errors.map((e) => String(e.ErrorCode || '')).filter(Boolean);
    throw failure;
  }

  return true;
}

// A listing that ended between the snapshot sync and the submit can never be
// revised, so it is pruned rather than left to fail again on every future pass.
const ENDED_LISTING_CODES = new Set(['21916635', '21917091', '291']);

function isEndedListingError(error) {
  const codes = error?.ebayErrorCodes || [];
  if (codes.some((code) => ENDED_LISTING_CODES.has(code))) return true;
  return /ended listing|listing has ended|auction has ended|already ended/i.test(error?.message || '');
}

async function loadSeller(sellerId) {
  if (!mongoose.Types.ObjectId.isValid(String(sellerId || ''))) return null;
  return Seller.findById(sellerId);
}

/**
 * GET /listing-overlays/index-status
 *
 * Per-seller counts and last sync time, read straight from SellerSkuIndex.
 * Read-only: this page no longer runs a crawl of its own — the daily SKU Index
 * Sync is what keeps these rows current.
 */
router.get('/index-status', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const rows = await SellerSkuIndex.aggregate([
      { $group: { _id: '$seller', count: { $sum: 1 }, syncedAt: { $max: '$syncedAt' } } },
    ]);

    res.json({
      sellers: rows.map((row) => ({
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
 * GET /listing-overlays/listings-stream
 *
 * Searches SellerSkuIndex, which the daily SKU Index Sync already maintains for
 * every seller. There is deliberately no crawl of its own here: a second pass
 * over the same ~425k listings would double the eBay cost to collect fields
 * that one call already returns.
 *
 * Discovery reads from the database while the pictures that actually get badged
 * are still fetched live at preview time, so a row up to a day stale can at
 * worst surface a listing that has since ended — the revise then fails visibly
 * — and can never cause the wrong image to be composited.
 */
router.get('/listings-stream', requireAuthSSE, requirePageAccess(PAGE_ID), async (req, res) => {
  const { sellerId, category = '', search = '', includeBadged: includeBadgedParam = '' } = req.query;
  const includeBadged = String(includeBadgedParam).toLowerCase() === 'true';

  const seller = await loadSeller(sellerId);
  if (!seller) return res.status(404).json({ error: 'Seller not found' });

  const stream = openSseStream(req, res);
  const categoryFilter = String(category).trim().toLowerCase();
  const keywordGroups = parseKeywordQuery(search);

  try {
    let matched = 0;
    let scanned = 0;
    let hiddenBadged = 0;
    let hiddenEnded = 0;

    // Listings whose badge is live right now, so they are kept out of the table
    // and cannot be badged a second time. Status matters, not just the item id:
    // a REVERTED listing is back to its original picture and must be badgeable
    // again, and a previewed-but-never-submitted one never changed on eBay.
    //
    // Loaded fresh on every request, so a listing submitted a minute ago
    // disappears from the very next search.
    const badgedItemIds = new Set();
    // Listings eBay refused as ended. They can never be revised, so offering
    // them again just wastes a preview. Remembered here rather than by deleting
    // the index row, because SellerSkuIndex is shared with the stock checks and
    // SKU profit report — this page must not remove listings from their view.
    // The daily sync clears genuinely ended rows on its next complete pass.
    const endedItemIds = new Set();

    const runIds = await ListingOverlayRun.find({ seller: seller._id }).distinct('_id');
    if (runIds.length) {
      const [badged, ended] = await Promise.all([
        includeBadged
          ? Promise.resolve([])
          : ListingOverlayItem.find({ run: { $in: runIds }, status: 'submitted' }).distinct('itemId'),
        ListingOverlayItem.find({ run: { $in: runIds }, listingEnded: true }).distinct('itemId'),
      ]);
      badged.forEach((id) => badgedItemIds.add(String(id)));
      ended.forEach((id) => endedItemIds.add(String(id)));
    }

    // The category narrows the query in the database; the keyword grammar then
    // runs in memory, keeping one implementation of the search semantics.
    const query = { seller: seller._id };
    if (categoryFilter) {
      query.categoryName = { $regex: escapeRegex(categoryFilter), $options: 'i' };
    }

    stream.send({ type: 'started' });

    const cursor = SellerSkuIndex.find(query)
      .select('itemId sku title categoryName imageUrl syncedAt')
      .lean()
      .cursor();

    let syncedAt = null;

    for await (const doc of cursor) {
      if (!stream.isOpen()) break;

      scanned += 1;
      if (!syncedAt) syncedAt = doc.syncedAt;

      if (keywordGroups.length) {
        const haystack = `${doc.title} ${doc.sku} ${doc.itemId}`.toLowerCase();
        if (!matchesKeywords(haystack, keywordGroups)) continue;
      }

      // Counted only against listings that otherwise matched, so the number
      // reads as "of your results, this many are already done".
      if (badgedItemIds.has(String(doc.itemId))) {
        hiddenBadged += 1;
        continue;
      }

      // Not counted as "already badged" — it was never badged, it is just dead.
      if (endedItemIds.has(String(doc.itemId))) {
        hiddenEnded += 1;
        continue;
      }

      matched += 1;
      stream.send({
        type: 'item',
        item: {
          itemId: doc.itemId,
          title: doc.title || '',
          sku: doc.sku || '',
          categoryName: doc.categoryName || '',
          image: doc.imageUrl || '',
        },
      });
    }

    stream.send({
      type: 'complete',
      scanned,
      matched,
      hiddenBadged,
      hiddenEnded,
      indexEmpty: scanned === 0,
      syncedAt,
    });
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

    const endedItemIds = [];

    const results = await Promise.all(items.map((item) => limit(async () => {
      try {
        await reviseListingPictures(token, item.itemId, item.newImages);
        await ListingOverlayItem.updateOne(
          { _id: item._id },
          { $set: { status: 'submitted', submittedAt: new Date(), error: '' } }
        );
        successCount += 1;
        return { itemId: item.itemId, title: item.title, status: 'submitted' };
      } catch (error) {
        const ended = isEndedListingError(error);
        if (ended) endedItemIds.push(item.itemId);

        await ListingOverlayItem.updateOne(
          { _id: item._id },
          { $set: { status: 'failed', error: error.message, listingEnded: ended } }
        );
        failedCount += 1;
        return {
          itemId: item.itemId,
          title: item.title,
          status: 'failed',
          ended,
          error: error.message,
        };
      }
    })));

    // Ended listings are NOT deleted from SellerSkuIndex. That collection is
    // shared with the stock checks, SKU profit report and active-SKU lookups,
    // so removing rows here would take listings out of their view too. The
    // daily sync's own cleanup already drops ended listings on its next
    // complete pass; until then they are filtered out of this page's search by
    // the listingEnded flag on the run item, which lives in our own collection.
    if (endedItemIds.length) {
      console.log(`[ListingOverlays] ${endedItemIds.length} ended listing(s) flagged, index left untouched`);
    }

    await ListingOverlayRun.updateOne(
      { _id: run._id },
      { $set: { status: 'completed', successCount, failedCount, completedAt: new Date() } }
    );

    res.json({
      runId: run._id,
      successCount,
      failedCount,
      skippedAlreadyBadged,
      endedItemIds,
      results,
    });
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

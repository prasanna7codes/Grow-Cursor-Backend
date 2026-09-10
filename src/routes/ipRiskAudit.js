import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import pLimit from 'p-limit';
import { parseStringPromise } from 'xml2js';

import Seller from '../models/Seller.js';
import SellerSkuIndex from '../models/SellerSkuIndex.js';
import TemplateListing from '../models/TemplateListing.js';
import AsinDirectory from '../models/AsinDirectory.js';
import Listing from '../models/Listing.js';
import ListingIpRisk from '../models/ListingIpRisk.js';
import EndListingLog from '../models/EndListingLog.js';
import { requireAuth, requireAuthSSE, requirePageAccess } from '../middleware/auth.js';
import { ensureValidToken } from './ebay.js';
import { parseKeywordQuery, matchesKeywords } from '../utils/keywordFilter.js';
import {
  assessImageSet,
  getCachedAsinIpRisk,
  getIpRiskConfig,
  isIpRiskCheckEnabled,
  saveAsinIpRisk
} from '../utils/reverseImageCheck.js';
import { upsizeEbayImageUrl } from '../utils/ebayImageUrl.js';

/**
 * IP Risk Audit — reverse-image check for listings that are ALREADY live.
 *
 * The ASIN precheck stops risky products before they are listed; this walks a
 * seller's existing catalogue (from SellerSkuIndex, which the daily SKU sync
 * maintains) and scores each listing's photos the same way, then lets the
 * operator end the ones that come back high.
 *
 * Photos checked, in order: the listing's own eBay picture (what a rights
 * owner's crawler actually sees), then the Amazon originals from
 * AsinDirectory when the SKU maps back to an ASIN. A product whose ASIN was
 * already scored — by the precheck, or by this audit under another account —
 * reuses that verdict and costs no new Vision calls.
 */
const router = express.Router();
const PAGE_ID = 'IpRiskAudit';
const EBAY_API = 'https://api.ebay.com/ws/api.dll';

// Listings sent to Vision per run. Bounded so one click cannot bill a whole
// 50k-listing catalogue; the page reports how many remain and the next run
// picks up where this one left off, since checked rows are skipped.
const DEFAULT_RUN_LIMIT = 300;
const MAX_RUN_LIMIT = 5000;
const RESULTS_LIMIT_MAX = 5000;
const END_BATCH_MAX = 200;

const ENDING_REASONS = new Set(['NotAvailable', 'Incorrect', 'LostOrBroken', 'OtherListingError']);

function tradingHeaders(callName) {
  return {
    'X-EBAY-API-SITEID': '0',
    'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
    'X-EBAY-API-CALL-NAME': callName,
    'Content-Type': 'text/xml',
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function getBaseSku(sku = '') {
  return String(sku || '').trim().replace(/-\d+$/, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function loadSeller(sellerId) {
  if (!mongoose.Types.ObjectId.isValid(String(sellerId || ''))) return null;
  return Seller.findById(sellerId);
}

function openSseStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const state = { closed: false, finished: false };

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
    isOpen: () => !state.closed,
    finish: () => {
      if (state.finished) return;
      state.finished = true;
      if (!state.closed) {
        res.write('data: [DONE]\n\n');
        if (typeof res.flush === 'function') res.flush();
      }
      close();
      res.end();
    },
  };
}

// Only needed when the index row carries no thumbnail and the SKU maps to no
// ASIN — otherwise the audit never spends an eBay call per listing.
async function fetchListingPictures(token, itemId) {
  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Item.ItemID</OutputSelector>
  <OutputSelector>Item.Title</OutputSelector>
  <OutputSelector>Item.PictureDetails</OutputSelector>
</GetItemRequest>`;

  const response = await axios.post(EBAY_API, xmlRequest, { headers: tradingHeaders('GetItem'), timeout: 30000 });
  const parsed = await parseStringPromise(response.data, { explicitArray: false });
  const body = parsed?.GetItemResponse;

  if (body?.Ack === 'Failure') {
    const errors = asArray(body.Errors);
    throw new Error(errors[0]?.LongMessage || 'GetItem failed');
  }

  return {
    title: body?.Item?.Title || '',
    images: asArray(body?.Item?.PictureDetails?.PictureURL).filter(Boolean),
  };
}

async function endListingOnEbay(token, itemId, endingReason) {
  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <EndingReason>${endingReason}</EndingReason>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</EndItemRequest>`;

  const response = await axios.post(EBAY_API, xmlRequest, { headers: tradingHeaders('EndItem'), timeout: 30000 });
  const parsed = await parseStringPromise(response.data, { explicitArray: false });
  const body = parsed?.EndItemResponse;

  if (body?.Ack === 'Failure') {
    const errors = asArray(body.Errors);
    const message = errors.map((e) => e.LongMessage).filter(Boolean).join('; ') || 'EndItem failed';
    const codes = errors.map((e) => String(e.ErrorCode || ''));
    // A listing that ended on its own since the sync is the outcome we wanted.
    if (codes.includes('1047') || /already (been )?(ended|closed)|has been closed|auction has ended|listing has ended/i.test(message)) {
      return { alreadyEnded: true, endTime: null };
    }
    throw new Error(message);
  }

  return { alreadyEnded: false, endTime: body?.EndTime || null };
}

// SKU → ASIN through the template listing that created it. The SKU's last
// five characters come from the ASIN but do not identify it, so the template
// record is the only reliable link.
async function resolveAsin(sku, baseSku) {
  const candidates = unique([sku, baseSku]);
  if (candidates.length === 0) return '';
  const listing = await TemplateListing.findOne({ customLabel: { $in: candidates } })
    .select('+_asinReference')
    .lean();
  const asin = String(listing?._asinReference || '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : '';
}

function toRow(doc) {
  return {
    itemId: String(doc.itemId),
    sku: doc.sku || '',
    baseSku: doc.baseSku || '',
    asin: doc.asin || '',
    title: doc.title || '',
    categoryName: doc.categoryName || '',
    imageUrl: doc.imageUrl || '',
    amazonBrand: doc.amazonBrand || '',
    level: doc.level,
    reasons: doc.reasons || [],
    matchedDomains: doc.matchedDomains || [],
    brandHits: doc.brandHits || [],
    bestGuessLabels: (doc.bestGuessLabels || []).slice(0, 5),
    imagesChecked: doc.imagesChecked || 0,
    source: doc.source || 'vision',
    checkedAt: doc.checkedAt || null,
    endedAt: doc.endedAt || null,
    endError: doc.endError || '',
  };
}

/**
 * Score one listing and persist the result. Never throws: a failure is a row
 * with level 'error' so the stream keeps its count.
 */
async function auditListing({ seller, doc, recheck, config, usage, getToken }) {
  const itemId = String(doc.itemId);
  const sku = String(doc.sku || '').trim();
  const baseSku = String(doc.baseSku || getBaseSku(sku));
  const base = {
    itemId,
    sku,
    baseSku,
    title: doc.title || '',
    categoryName: doc.categoryName || '',
    imageUrl: doc.imageUrl || '',
  };

  try {
    const asin = await resolveAsin(sku, baseSku);
    const amazon = asin
      ? await AsinDirectory.findOne({ asin }).select('brand images title').lean()
      : null;
    const amazonBrand = amazon?.brand || '';

    let verdict = null;
    let source = 'vision';
    let imagesChecked = 0;
    let imageResults = [];

    if (asin && !recheck) {
      const cached = await getCachedAsinIpRisk(asin, { cacheDays: config.cacheDays });
      if (cached) {
        verdict = cached;
        source = 'asin-cache';
        imagesChecked = cached.imagesChecked || 0;
        imageResults = (cached.images || []).map((image) => ({
          url: image.url || '',
          level: image.level || 'low',
          matchedDomains: image.matchedDomains || [],
          error: image.error || '',
        }));
      }
    }

    if (!verdict) {
      // What is on eBay first, then the Amazon originals to fill the budget.
      let images = [];
      if (doc.imageUrl) images.push(upsizeEbayImageUrl(doc.imageUrl));
      if (Array.isArray(amazon?.images)) images.push(...amazon.images);

      if (images.length === 0) {
        const live = await fetchListingPictures(await getToken(), itemId);
        images = live.images;
        if (!base.title && live.title) base.title = live.title;
        if (!base.imageUrl && live.images[0]) base.imageUrl = live.images[0];
      }

      const assessment = await assessImageSet({
        images,
        amazonBrand,
        label: asin || `item ${itemId}`,
        usage,
      });

      verdict = assessment.combined;
      imagesChecked = assessment.succeeded;
      imageResults = assessment.imageResults.map((image) => ({
        url: image.url,
        level: image.level,
        matchedDomains: image.matchedDomains || [],
        error: image.error || '',
      }));

      if (asin && !['error', 'unchecked'].includes(verdict.level)) {
        await saveAsinIpRisk(asin, { ...assessment, amazonBrand, title: base.title || amazon?.title || '' });
      }
    }

    const row = {
      ...base,
      asin,
      amazonBrand,
      level: verdict.level,
      reasons: verdict.reasons || [],
      matchedDomains: verdict.matchedDomains || [],
      brandHits: verdict.brandHits || [],
      bestGuessLabels: (verdict.bestGuessLabels || []).slice(0, 5),
      imagesChecked,
      source,
      checkedAt: new Date(),
      endedAt: null,
      endError: '',
    };

    await ListingIpRisk.findOneAndUpdate(
      { seller: seller._id, itemId },
      { $set: { ...row, seller: seller._id, images: imageResults } },
      { upsert: true }
    );

    return row;
  } catch (error) {
    console.warn(`[IP Risk Audit] ${itemId} failed:`, error.message);
    const row = {
      ...base,
      asin: '',
      amazonBrand: '',
      level: 'error',
      reasons: [error.message],
      matchedDomains: [],
      brandHits: [],
      bestGuessLabels: [],
      imagesChecked: 0,
      source: 'vision',
      checkedAt: new Date(),
      endedAt: null,
      endError: '',
    };
    await ListingIpRisk.findOneAndUpdate(
      { seller: seller._id, itemId },
      { $set: { ...row, seller: seller._id, images: [] } },
      { upsert: true }
    ).catch(() => {});
    return row;
  }
}

/**
 * GET /ip-risk-audit/status
 *
 * Whether the check is configured, plus per-seller counts of stored results so
 * the seller picker can show where the risk sits before a run.
 */
router.get('/status', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const rows = await ListingIpRisk.aggregate([
      // $ifNull rather than $ne against null, so a row with the field missing
      // altogether (none should exist, but schema defaults are not enforced
      // on old documents) still counts as not ended.
      { $group: { _id: { seller: '$seller', level: '$level', ended: { $cond: [{ $ifNull: ['$endedAt', false] }, true, false] } }, count: { $sum: 1 } } },
    ]);

    const bySeller = {};
    rows.forEach((row) => {
      const sellerId = String(row._id.seller);
      if (!bySeller[sellerId]) bySeller[sellerId] = { high: 0, medium: 0, low: 0, error: 0, unchecked: 0, ended: 0, total: 0 };
      if (row._id.ended) {
        bySeller[sellerId].ended += row.count;
      } else {
        bySeller[sellerId][row._id.level] = (bySeller[sellerId][row._id.level] || 0) + row.count;
      }
      bySeller[sellerId].total += row.count;
    });

    const indexRows = await SellerSkuIndex.aggregate([
      { $group: { _id: '$seller', count: { $sum: 1 }, syncedAt: { $max: '$syncedAt' } } },
    ]);
    const indexBySeller = {};
    indexRows.forEach((row) => {
      indexBySeller[String(row._id)] = { count: row.count, syncedAt: row.syncedAt };
    });

    const config = getIpRiskConfig();
    res.json({
      enabled: isIpRiskCheckEnabled(),
      provider: config.provider,
      imagesPerListing: config.imagesPerAsin,
      creditsPerImage: config.creditsPerImage,
      bySeller,
      indexBySeller,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /ip-risk-audit/stream
 *
 * Walks the seller's SKU index (optionally narrowed by category and keyword),
 * reverse-image checks up to `limit` listings that have no fresh result yet,
 * and streams one row per listing. Rows with a fresh result are skipped unless
 * includeChecked=true (then they are streamed from the database at no cost);
 * recheck=true ignores stored results and re-scores everything it touches.
 */
router.get('/stream', requireAuthSSE, requirePageAccess(PAGE_ID), async (req, res) => {
  const {
    sellerId,
    category = '',
    search = '',
    limit: limitParam,
    recheck: recheckParam = '',
    includeChecked: includeCheckedParam = '',
  } = req.query;
  const recheck = String(recheckParam).toLowerCase() === 'true';
  const includeChecked = String(includeCheckedParam).toLowerCase() === 'true';
  const runLimit = Math.min(MAX_RUN_LIMIT, Math.max(1, parseInt(limitParam, 10) || DEFAULT_RUN_LIMIT));

  const seller = await loadSeller(sellerId);
  if (!seller) return res.status(404).json({ error: 'Seller not found' });
  if (!isIpRiskCheckEnabled()) {
    return res.status(503).json({ error: 'Reverse-image check is not configured (set SCRAPINGDOG_API_KEY or GOOGLE_VISION_API_KEY)' });
  }

  const stream = openSseStream(req, res);
  const config = getIpRiskConfig();
  const categoryFilter = String(category).trim().toLowerCase();
  const keywordGroups = parseKeywordQuery(search);
  const usage = { sellerId: seller._id, userId: req.user?.userId, fieldType: 'audit' };

  try {
    const priorDocs = await ListingIpRisk.find({ seller: seller._id })
      .select('itemId sku baseSku asin title categoryName imageUrl amazonBrand level reasons matchedDomains brandHits bestGuessLabels imagesChecked source checkedAt endedAt endError')
      .lean();
    const prior = new Map(priorDocs.map((doc) => [String(doc.itemId), doc]));
    const freshMs = config.cacheDays * 86400000;

    const query = { seller: seller._id };
    if (categoryFilter) query.categoryName = { $regex: escapeRegex(categoryFilter), $options: 'i' };

    const cursor = SellerSkuIndex.find(query)
      .select('itemId sku baseSku title categoryName imageUrl')
      .lean()
      .cursor();

    const candidates = [];
    const cachedRows = [];
    let scanned = 0;
    let matched = 0;
    let skippedFresh = 0;
    let skippedEnded = 0;
    let remaining = 0;

    for await (const doc of cursor) {
      if (!stream.isOpen()) break;
      scanned += 1;

      if (keywordGroups.length) {
        const haystack = `${doc.title} ${doc.sku} ${doc.itemId}`.toLowerCase();
        if (!matchesKeywords(haystack, keywordGroups)) continue;
      }
      matched += 1;

      const existing = prior.get(String(doc.itemId));
      if (existing?.endedAt) {
        skippedEnded += 1;
        continue;
      }

      const fresh = existing
        && !recheck
        && !['error', 'unchecked'].includes(existing.level)
        && Date.now() - new Date(existing.checkedAt).getTime() < freshMs;

      if (fresh) {
        skippedFresh += 1;
        if (includeChecked) cachedRows.push(existing);
        continue;
      }

      if (candidates.length < runLimit) candidates.push(doc);
      else remaining += 1;
    }

    const total = candidates.length + cachedRows.length;
    stream.send({
      type: 'started',
      total,
      toCheck: candidates.length,
      scanned,
      matched,
      skippedFresh,
      skippedEnded,
      remaining,
      indexEmpty: scanned === 0,
    });

    let progress = 0;
    const counts = { high: 0, medium: 0, low: 0, error: 0, unchecked: 0 };

    for (const doc of cachedRows) {
      if (!stream.isOpen()) break;
      const row = toRow(doc);
      counts[row.level] = (counts[row.level] || 0) + 1;
      stream.send({ type: 'item', item: { ...row, fromCache: true }, progress: ++progress, total });
    }

    if (scanned > 0 && candidates.length > 0 && stream.isOpen()) {
      let token = null;
      const getToken = async () => {
        if (!token) token = await ensureValidToken(seller);
        return token;
      };

      // Listings in flight at once. Each one fans out into up to
      // IP_RISK_IMAGES_PER_ASIN Vision calls, which the checker's own
      // process-wide limiter caps, so this mostly bounds database work.
      const listingLimit = pLimit(Math.max(1, parseInt(process.env.IP_RISK_AUDIT_CONCURRENCY, 10) || 4));

      await Promise.all(candidates.map((doc) => listingLimit(async () => {
        if (!stream.isOpen()) return;
        const row = await auditListing({ seller, doc, recheck, config, usage, getToken });
        counts[row.level] = (counts[row.level] || 0) + 1;
        stream.send({ type: 'item', item: row, progress: ++progress, total });
      })));
    }

    stream.send({
      type: 'complete',
      scanned,
      matched,
      checked: candidates.length,
      skippedFresh,
      skippedEnded,
      remaining,
      indexEmpty: scanned === 0,
      counts,
    });
  } catch (error) {
    console.error('[IP Risk Audit] Stream failed:', error.message);
    stream.send({ type: 'error', error: error.message });
  } finally {
    stream.finish();
  }
});

/**
 * GET /ip-risk-audit/results?sellerId=&level=&includeEnded=&limit=
 *
 * Stored results for a seller, so the page can show the last audit without
 * re-running it. Ended listings are hidden unless asked for.
 */
router.get('/results', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const { sellerId, level = '', includeEnded = '' } = req.query;
    const seller = await loadSeller(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const limit = Math.min(RESULTS_LIMIT_MAX, Math.max(1, parseInt(req.query.limit, 10) || RESULTS_LIMIT_MAX));
    const query = { seller: seller._id };
    if (['high', 'medium', 'low', 'error', 'unchecked'].includes(level)) query.level = level;
    if (String(includeEnded).toLowerCase() !== 'true') query.endedAt = null;

    const [rows, countRows, ended] = await Promise.all([
      ListingIpRisk.find(query).sort({ checkedAt: -1 }).limit(limit).lean(),
      ListingIpRisk.aggregate([
        { $match: { seller: seller._id, endedAt: null } },
        { $group: { _id: '$level', count: { $sum: 1 } } },
      ]),
      ListingIpRisk.countDocuments({ seller: seller._id, endedAt: { $ne: null } }),
    ]);

    const counts = { high: 0, medium: 0, low: 0, error: 0, unchecked: 0 };
    countRows.forEach((row) => { counts[row._id] = row.count; });

    res.json({ rows: rows.map(toRow), counts, ended });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /ip-risk-audit/end
 *
 * Ends the given listings on eBay for one seller and records each end in
 * EndListingLog (source ip_risk_audit) and on the audit row. Per-item
 * outcomes are returned rather than failing the batch on the first error.
 */
router.post('/end', requireAuth, requirePageAccess(PAGE_ID), async (req, res) => {
  try {
    const { sellerId } = req.body || {};
    const endingReason = ENDING_REASONS.has(req.body?.endingReason) ? req.body.endingReason : 'NotAvailable';
    const itemIds = unique(asArray(req.body?.itemIds).map((value) => String(value || '').trim()));

    const seller = await loadSeller(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    if (itemIds.length === 0) return res.status(400).json({ error: 'At least one itemId is required' });
    if (itemIds.length > END_BATCH_MAX) {
      return res.status(400).json({ error: `Maximum ${END_BATCH_MAX} listings per request` });
    }

    const token = await ensureValidToken(seller);
    const endedBy = req.user?.userId || null;
    const limit = pLimit(3);

    const results = await Promise.all(itemIds.map((itemId) => limit(async () => {
      try {
        const outcome = await endListingOnEbay(token, itemId, endingReason);

        const risk = await ListingIpRisk.findOneAndUpdate(
          { seller: seller._id, itemId },
          { $set: { endedAt: new Date(), endedBy, endError: '' } },
          { new: true }
        ).lean();

        await EndListingLog.create({
          seller: seller._id,
          itemId,
          sku: risk?.sku || null,
          source: 'ip_risk_audit',
          endedBy,
        }).catch((error) => console.error('[IP Risk Audit] EndListingLog write failed:', error.message));

        await Listing.updateOne(
          { seller: seller._id, itemId },
          { $set: { listingStatus: 'Ended', endTime: new Date() } }
        ).catch(() => {});

        return { itemId, success: true, alreadyEnded: outcome.alreadyEnded };
      } catch (error) {
        await ListingIpRisk.updateOne(
          { seller: seller._id, itemId },
          { $set: { endError: error.message } }
        ).catch(() => {});
        return { itemId, success: false, error: error.message };
      }
    })));

    const ended = results.filter((result) => result.success).length;
    res.json({ results, ended, failed: results.length - ended, endingReason });
  } catch (error) {
    console.error('[IP Risk Audit] End failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;

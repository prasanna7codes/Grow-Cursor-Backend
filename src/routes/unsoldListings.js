import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import { parseStringPromise } from 'xml2js';
import { requireAuth } from '../middleware/auth.js';
import { ensureValidToken } from './ebay.js';
import Seller from '../models/Seller.js';
import UserSellerAssignment from '../models/UserSellerAssignment.js';
import SellerUnsoldListing from '../models/SellerUnsoldListing.js';
import EbayCategoryCache from '../models/EbayCategoryCache.js';
import TemplateListing from '../models/TemplateListing.js';

const router = express.Router();

const EBAY_API_URL = 'https://api.ebay.com/ws/api.dll';
const ENTRIES_PER_PAGE = 200;
// GetMyeBaySelling cannot paginate beyond 25,000 entries.
const MAX_ENTRIES = 25000;
const MAX_PAGES = Math.floor(MAX_ENTRIES / ENTRIES_PER_PAGE);
// eBay rejects DurationInDays > 60 for UnsoldList.
const DURATION_IN_DAYS = 60;
const PAGE_RETRY_DELAYS_MS = [60_000, 180_000, 300_000];

// sellerId → { status, startedAt, totalCount, lastSyncAt, progress, error }
const unsoldSyncStatus = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const toArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

// Matches TemplateListing.baseCustomLabel, which is customLabel.split('-')[0].
const extractBaseSku = (sku) => String(sku || '').trim().split('-')[0].trim();

// UnsoldList items carry no PrimaryCategory; the id only appears in the natural-search URL.
const extractCategoryId = (url) => (/[?&]category=(\d+)/.exec(String(url || '')) || [])[1] || '';

const toNumber = (value) => {
    if (value == null || value === '') return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const toInt = (value) => {
    if (value == null || value === '') return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
};

const toDate = (value) => (value ? new Date(value) : null);

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isTransientError(error) {
    const message = String(error?.message || '').toLowerCase();
    const code = String(error?.code || '').toUpperCase();
    const status = error?.response?.status;

    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(code)) return true;
    if (status === 408 || status === 429 || (status >= 500 && status < 600)) return true;
    return (
        message.includes('system error') ||
        message.includes('try again later') ||
        message.includes('temporarily unavailable') ||
        message.includes('timeout') ||
        message.includes('socket hang up')
    );
}

async function withPageRetry({ sellerId, page, action }) {
    for (let attempt = 0; attempt <= PAGE_RETRY_DELAYS_MS.length; attempt++) {
        try {
            return await action();
        } catch (error) {
            const canRetry = attempt < PAGE_RETRY_DELAYS_MS.length && isTransientError(error);
            if (!canRetry) throw error;

            const delayMs = PAGE_RETRY_DELAYS_MS[attempt];
            console.warn(
                `[sync-unsold] seller=${sellerId} page=${page} transient error: ${error.message}. ` +
                `Retrying in ${Math.round(delayMs / 1000)}s (${attempt + 1}/${PAGE_RETRY_DELAYS_MS.length})`
            );
            await sleep(delayMs);
        }
    }
}

function buildUnsoldRequest(token, page) {
    return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <UnsoldList>
    <Include>true</Include>
    <DurationInDays>${DURATION_IN_DAYS}</DurationInDays>
    <Sort>EndTime</Sort>
    <Pagination>
      <EntriesPerPage>${ENTRIES_PER_PAGE}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </UnsoldList>
</GetMyeBaySellingRequest>`;
}

function mapItemToUpsert(seller, item, syncStart) {
    const itemId = item.ItemID;
    if (!itemId) return null;

    const sellingStatus = item.SellingStatus || {};
    const listingDetails = item.ListingDetails || {};
    const current = sellingStatus.CurrentPrice;
    const converted = sellingStatus.ConvertedCurrentPrice;
    const price = toNumber(current?._);
    const currency = current?.$?.currencyID || '';
    const naturalUrl = listingDetails.ViewItemURLForNaturalSearch || '';
    const sku = item.SKU || '';

    return {
        updateOne: {
            filter: { seller: seller._id, itemId: String(itemId) },
            update: {
                $set: {
                    title: item.Title || '',
                    sku,
                    baseSku: extractBaseSku(sku),
                    price,
                    currency,
                    priceUSD: toNumber(converted?._) ?? (currency === 'USD' ? price : null),
                    quantity: toInt(item.Quantity),
                    quantityAvailable: toInt(item.QuantityAvailable),
                    startTime: toDate(listingDetails.StartTime),
                    endTime: toDate(listingDetails.EndTime),
                    viewItemURL: listingDetails.ViewItemURL || naturalUrl || '',
                    galleryURL: item.PictureDetails?.GalleryURL || '',
                    listingType: item.ListingType || '',
                    categoryId: extractCategoryId(naturalUrl),
                    syncedAt: syncStart,
                },
            },
            upsert: true,
        },
    };
}

// Resolve category names for ids we have never seen before. One GetItem per unknown id.
async function resolveCategoryNames(seller, send) {
    const sellerId = seller._id.toString();
    const ids = (await SellerUnsoldListing.distinct('categoryId', { seller: seller._id })).filter(Boolean);
    if (ids.length === 0) return 0;

    const cached = await EbayCategoryCache.find({ categoryId: { $in: ids } }).select('categoryId').lean();
    const known = new Set(cached.map(row => row.categoryId));
    const missing = ids.filter(id => !known.has(id));

    let resolved = 0;
    for (const categoryId of missing) {
        try {
            const sample = await SellerUnsoldListing
                .findOne({ seller: seller._id, categoryId })
                .select('itemId')
                .lean();
            if (!sample?.itemId) continue;

            const token = await ensureValidToken(seller);
            const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <ItemID>${sample.itemId}</ItemID>
  <OutputSelector>Item.PrimaryCategory</OutputSelector>
</GetItemRequest>`;

            const response = await axios.post(EBAY_API_URL, xmlRequest, {
                headers: {
                    'X-EBAY-API-CALL-NAME': 'GetItem',
                    'X-EBAY-API-SITEID': '0',
                    'X-EBAY-API-COMPATIBILITY-LEVEL': '1423',
                    'Content-Type': 'text/xml',
                },
            });

            const parsed = await parseStringPromise(response.data, { explicitArray: false });
            const primaryCategory = parsed?.GetItemResponse?.Item?.PrimaryCategory;
            if (!primaryCategory?.CategoryID) continue;

            await EbayCategoryCache.updateOne(
                { categoryId: String(primaryCategory.CategoryID) },
                {
                    $set: {
                        categoryName: primaryCategory.CategoryName || '',
                        resolvedAt: new Date(),
                        sourceItemId: String(sample.itemId),
                    },
                },
                { upsert: true }
            );
            resolved++;
        } catch (error) {
            // Category names are cosmetic — never fail the sync over one lookup.
            console.warn(`[sync-unsold] seller=${sellerId} category=${categoryId} name lookup failed: ${error.message}`);
        }

        if (send) {
            send({ type: 'progress', phase: 'categories', resolved, totalToResolve: missing.length });
        }
    }

    return resolved;
}

async function runUnsoldSync(seller, send = null) {
    const syncStart = new Date();
    const sellerId = seller._id.toString();

    let page = 1;
    let totalPages = 1;
    let totalCount = 0;
    let totalEntries = 0;
    let capWarned = false;

    while (page <= totalPages) {
        // Re-check the token every page — a full crawl can outlive the token.
        const token = await ensureValidToken(seller);
        const xmlRequest = buildUnsoldRequest(token, page);

        const unsoldList = await withPageRetry({
            sellerId,
            page,
            action: async () => {
                const response = await axios.post(EBAY_API_URL, xmlRequest, {
                    headers: {
                        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
                        'X-EBAY-API-SITEID': '0',
                        'X-EBAY-API-COMPATIBILITY-LEVEL': '1173',
                        'Content-Type': 'text/xml',
                    },
                });

                const parsed = await parseStringPromise(response.data, { explicitArray: false });
                const body = parsed?.GetMyeBaySellingResponse;

                if (body?.Ack === 'Failure') {
                    const firstError = toArray(body.Errors)[0];
                    const message = firstError?.LongMessage || firstError?.ShortMessage || 'eBay API failure';
                    throw new Error(`eBay error on page ${page}: ${message}`);
                }

                return body?.UnsoldList || null;
            },
        });

        const pagination = unsoldList?.PaginationResult;
        totalPages = Math.max(1, toInt(pagination?.TotalNumberOfPages) || 1);
        totalEntries = toInt(pagination?.TotalNumberOfEntries) || 0;

        if (totalEntries > MAX_ENTRIES && !capWarned) {
            capWarned = true;
            const message = `Seller has ${totalEntries.toLocaleString()} unsold listings; eBay only returns the first ${MAX_ENTRIES.toLocaleString()}. Oldest listings will be missing.`;
            console.warn(`[sync-unsold] seller=${sellerId} ${message}`);
            if (send) send({ type: 'warning', message });
        }
        if (totalPages > MAX_PAGES) totalPages = MAX_PAGES;

        const items = toArray(unsoldList?.ItemArray?.Item);
        const ops = items
            .map(item => mapItemToUpsert(seller, item, syncStart))
            .filter(Boolean);

        if (ops.length > 0) {
            await SellerUnsoldListing.bulkWrite(ops);
            totalCount += ops.length;
        }

        console.log(`[sync-unsold] seller=${sellerId} page=${page}/${totalPages} totalEntries=${totalEntries} inPage=${items.length}`);

        const progress = { phase: 'items', page, totalPages, totalEntries, count: totalCount };
        unsoldSyncStatus.set(sellerId, {
            ...(unsoldSyncStatus.get(sellerId) || {}),
            status: 'running',
            totalCount,
            progress,
        });
        if (send) send({ type: 'progress', ...progress });

        page++;
    }

    // Only runs when every page succeeded — a throw above skips it so a partial
    // crawl can never delete good rows.
    const cleanup = await SellerUnsoldListing.deleteMany({
        seller: seller._id,
        syncedAt: { $lt: syncStart },
    });

    const categoriesResolved = await resolveCategoryNames(seller, send);
    const finalDbCount = await SellerUnsoldListing.countDocuments({ seller: seller._id });

    console.log(
        `[sync-unsold] seller=${sellerId} DONE - processed=${totalCount} ` +
        `cleanupDeleted=${cleanup.deletedCount || 0} categoriesResolved=${categoriesResolved} finalDbCount=${finalDbCount}`
    );

    return { totalCount: finalDbCount, categoriesResolved, syncedAt: syncStart };
}

// Attach the ASIN for each row's baseSku. Resolved at read time so template edits
// show up immediately, and it is a single indexed query per page of results.
async function attachAsins(rows) {
    const baseSkus = [...new Set(rows.map(row => row.baseSku).filter(Boolean))];
    if (baseSkus.length === 0) return rows.map(row => ({ ...row, asin: '' }));

    const templateRows = await TemplateListing.find({
        baseCustomLabel: { $in: baseSkus },
        _asinReference: { $exists: true, $ne: '' },
    })
        .select('baseCustomLabel +_asinReference')
        .collation({ locale: 'en', strength: 2 })
        .lean();

    const asinByBaseSku = new Map();
    for (const row of templateRows) {
        const key = String(row.baseCustomLabel || '').toUpperCase();
        if (!asinByBaseSku.has(key)) asinByBaseSku.set(key, row._asinReference);
    }

    return rows.map(row => ({
        ...row,
        asin: asinByBaseSku.get(String(row.baseSku || '').toUpperCase()) || '',
    }));
}

// Sellers this user may see. Returns null when unrestricted (superadmin, or a user
// with no explicit assignments) — mirrors GET /sellers/all so the "All sellers"
// view can never show more than the seller dropdown offers.
async function accessibleSellerIds(req) {
    if (req.user.role === 'superadmin') return null;
    const assignments = await UserSellerAssignment.find({ user: req.user.userId }).select('seller').lean();
    if (assignments.length === 0) return null;
    return assignments.map(a => a.seller);
}

// Builds the seller portion of a $match: one seller, or every accessible seller.
async function buildSellerMatch(req, sellerId) {
    if (sellerId && sellerId !== 'all') {
        const allowed = await accessibleSellerIds(req);
        const id = new mongoose.Types.ObjectId(String(sellerId));
        if (allowed && !allowed.some(a => String(a) === String(sellerId))) return null;
        return { seller: id };
    }
    const allowed = await accessibleSellerIds(req);
    return allowed ? { seller: { $in: allowed } } : {};
}

async function attachSellerNames(rows) {
    const sellerIds = [...new Set(rows.map(row => String(row.seller)).filter(Boolean))];
    if (sellerIds.length === 0) return rows;

    const sellers = await Seller.find({ _id: { $in: sellerIds } })
        .populate('user', 'username email')
        .select('user')
        .lean();
    const nameById = new Map(sellers.map(s => [
        String(s._id),
        s.user?.username || s.user?.email || String(s._id),
    ]));

    return rows.map(row => ({ ...row, sellerName: nameById.get(String(row.seller)) || '' }));
}

async function attachCategoryNames(rows) {
    const categoryIds = [...new Set(rows.map(row => row.categoryId).filter(Boolean))];
    if (categoryIds.length === 0) return rows.map(row => ({ ...row, categoryName: '' }));

    const cached = await EbayCategoryCache.find({ categoryId: { $in: categoryIds } })
        .select('categoryId categoryName')
        .lean();
    const nameById = new Map(cached.map(row => [row.categoryId, row.categoryName]));

    return rows.map(row => ({ ...row, categoryName: nameById.get(row.categoryId) || '' }));
}

// GET /unsold-listings/sync/stream?sellerId=... — SSE progress then done
router.get('/sync/stream', requireAuth, async (req, res) => {
    const { sellerId } = req.query;
    if (!sellerId) return res.status(400).json({ error: 'sellerId is required' });

    const current = unsoldSyncStatus.get(String(sellerId));
    if (current?.status === 'running') {
        return res.status(409).json({ error: 'Sync already in progress for this seller' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
        const seller = await Seller.findById(sellerId).populate('user', 'username');
        if (!seller) { send({ type: 'error', error: 'Seller not found' }); return res.end(); }
        if (!seller.ebayTokens?.access_token) {
            send({ type: 'error', error: 'Seller has no connected eBay account' });
            return res.end();
        }

        const startedAt = new Date();
        unsoldSyncStatus.set(String(sellerId), { status: 'running', startedAt, totalCount: 0 });

        const { totalCount, categoriesResolved, syncedAt } = await runUnsoldSync(seller, send);

        unsoldSyncStatus.set(String(sellerId), { status: 'completed', startedAt, totalCount, lastSyncAt: syncedAt });
        send({ type: 'done', totalCount, categoriesResolved, syncedAt });
    } catch (error) {
        console.error('[sync-unsold/stream] Error:', error.message);
        unsoldSyncStatus.set(String(sellerId), { status: 'failed', error: error.message });
        send({ type: 'error', error: error.message, status: 'failed' });
    } finally {
        res.end();
    }
});

// GET /unsold-listings/sync/status/:sellerId
router.get('/sync/status/:sellerId', requireAuth, async (req, res) => {
    try {
        const { sellerId } = req.params;
        const memory = unsoldSyncStatus.get(String(sellerId)) || { status: 'idle' };
        const dbCount = await SellerUnsoldListing.countDocuments({ seller: sellerId });
        const latest = await SellerUnsoldListing.findOne({ seller: sellerId })
            .sort({ syncedAt: -1 })
            .select('syncedAt')
            .lean();

        // A completed sync stamps every row with the same syncedAt and deletes the rest,
        // so mixed timestamps mean the last run never finished (e.g. the server restarted).
        // Without this the UI would report "Synced" after an interrupted run.
        let staleCount = 0;
        if (latest?.syncedAt) {
            staleCount = await SellerUnsoldListing.countDocuments({
                seller: sellerId,
                syncedAt: { $lt: latest.syncedAt },
            });
        }

        return res.json({
            ...memory,
            dbCount,
            syncedAt: latest?.syncedAt || null,
            staleCount,
            partial: staleCount > 0,
        });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch sync status', details: error.message });
    }
});

// GET /unsold-listings?sellerId=...&page=1&limit=50&categoryId=&search=
// One row per ASIN (baseSku): the latest-ended listing represents the group.
router.get('/', requireAuth, async (req, res) => {
    try {
        const { sellerId, categoryId, search } = req.query;

        const page = Math.max(1, toInt(req.query.page) || 1);
        const limit = Math.min(200, Math.max(1, toInt(req.query.limit) || 50));

        const sellerMatch = await buildSellerMatch(req, sellerId);
        if (sellerMatch === null) return res.status(403).json({ error: 'No access to this seller' });

        const match = { ...sellerMatch };
        if (categoryId) match.categoryId = String(categoryId);
        if (search) {
            const term = String(search).trim();
            if (term) {
                const regex = new RegExp(escapeRegex(term), 'i');
                match.$or = [{ title: regex }, { sku: regex }, { itemId: term }];
            }
        }

        const [result] = await SellerUnsoldListing.aggregate([
            { $match: match },
            { $sort: { endTime: -1 } },
            {
                $group: {
                    // Grouped per seller so the same ASIN listed by two sellers stays
                    // two rows in the all-sellers view.
                    _id: {
                        seller: '$seller',
                        key: {
                            $cond: [
                                { $in: ['$baseSku', ['', null]] },
                                { $concat: ['item:', '$itemId'] },
                                '$baseSku',
                            ],
                        },
                    },
                    doc: { $first: '$$ROOT' },
                    listingCount: { $sum: 1 },
                    itemIds: { $push: '$itemId' },
                },
            },
            { $sort: { 'doc.endTime': -1 } },
            {
                $facet: {
                    rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
                    total: [{ $count: 'count' }],
                },
            },
        ]);

        const groups = result?.rows || [];
        const total = result?.total?.[0]?.count || 0;

        let items = groups.map(group => ({
            ...group.doc,
            listingCount: group.listingCount,
            itemIds: group.itemIds,
        }));
        items = await attachAsins(items);
        items = await attachCategoryNames(items);
        items = await attachSellerNames(items);

        return res.json({ items, total, page, limit });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch unsold listings', details: error.message });
    }
});

// GET /unsold-listings/categories?sellerId=... — filter dropdown options
router.get('/categories', requireAuth, async (req, res) => {
    try {
        const { sellerId } = req.query;
        const sellerMatch = await buildSellerMatch(req, sellerId);
        if (sellerMatch === null) return res.status(403).json({ error: 'No access to this seller' });

        const grouped = await SellerUnsoldListing.aggregate([
            { $match: { ...sellerMatch, categoryId: { $ne: '' } } },
            { $group: { _id: '$categoryId', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);

        const ids = grouped.map(row => row._id);
        const cached = await EbayCategoryCache.find({ categoryId: { $in: ids } })
            .select('categoryId categoryName')
            .lean();
        const nameById = new Map(cached.map(row => [row.categoryId, row.categoryName]));

        return res.json(grouped.map(row => ({
            categoryId: row._id,
            categoryName: nameById.get(row._id) || '',
            count: row.count,
        })));
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch categories', details: error.message });
    }
});

// POST /unsold-listings/remove — drop selected rows; they return on the next sync.
router.post('/remove', requireAuth, async (req, res) => {
    try {
        const { sellerId, itemIds } = req.body || {};
        if (!Array.isArray(itemIds) || itemIds.length === 0) {
            return res.status(400).json({ error: 'itemIds must be a non-empty array' });
        }
        if (itemIds.length > 5000) {
            return res.status(400).json({ error: 'Cannot remove more than 5000 listings at once' });
        }

        // In the all-sellers view a selection can span sellers, so scope by whatever
        // the user may access rather than requiring a single sellerId.
        const sellerMatch = await buildSellerMatch(req, sellerId);
        if (sellerMatch === null) return res.status(403).json({ error: 'No access to this seller' });

        const result = await SellerUnsoldListing.deleteMany({
            ...sellerMatch,
            itemId: { $in: itemIds.map(String) },
        });

        return res.json({ deleted: result.deletedCount || 0 });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to remove listings', details: error.message });
    }
});

export default router;

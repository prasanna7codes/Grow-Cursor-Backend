import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireAuthSSE } from '../middleware/auth.js';
import { requireObjectId } from '../middleware/objectId.js';
import AsinSourcingRun from '../models/AsinSourcingRun.js';
import AsinListCategory from '../models/AsinListCategory.js';
import AsinListRange from '../models/AsinListRange.js';
import AsinListProduct from '../models/AsinListProduct.js';
import AsinDirectory from '../models/AsinDirectory.js';
import TemplateListing from '../models/TemplateListing.js';
import SellerSkuIndex from '../models/SellerSkuIndex.js';
import { findActiveAsinsForSeller } from '../utils/sellerActiveSkus.js';
import Seller from '../models/Seller.js';
import ListingTemplate from '../models/ListingTemplate.js';
import { searchAsins } from '../utils/scrapingdogSearch.js';
import { mergeSearchQueries, normalizeSearchQueries, withNameFallback } from '../utils/searchQueries.js';
import { validate } from '../utils/validate.js';
import { recordDiscardedAsinsSchema, recordContinuedAsinsSchema } from '../schemas/index.js';

const router = express.Router();

// The listing preview/precheck streams cap a batch at 100 ASINs, so sourcing
// more than that in one go would hand back a list the next step cannot take.
const MAX_TARGET = 100;

// Safety cap on search -> filter -> re-search rounds.
//
// Set to match the per-keyword page ceiling so that the CEILING is what stops a
// run, not this counter. The earlier value of 4 gave up while a keyword still
// had two-thirds of its pages untouched: when most of what the search finds is
// already listed for the seller, every round returns candidates that are then
// filtered away, and the only way to reach fresh stock is to keep paging. That
// looked like "the keyword ran out" when the keyword had plenty left.
//
// Credits stay bounded regardless: searchAsins will not page a keyword past
// SCRAPINGDOG_SEARCH_MAX_PAGES, so the ceiling caps total spend either way.
const MAX_SOURCING_ROUNDS = parseInt(process.env.SCRAPINGDOG_SEARCH_MAX_PAGES) || 12;

/**
 * Resolve the keyword set for a taxonomy selection.
 *
 * Picking a node means "search everything under here": the node's own keywords
 * plus every descendant's, de-duplicated. A node nobody has configured yet
 * falls back to its own name, so a fresh category is still usable.
 */
async function resolveQueries({ keywords, categoryId, rangeId, productId }) {
  // Typing a keyword is the primary way to source. The taxonomy path below
  // exists for saved, reusable keyword sets, but nothing requires it.
  const typed = normalizeSearchQueries(String(keywords || '').split(','));
  if (typed.length > 0) {
    return { queries: typed, scopeName: typed.join(', ') };
  }

  if (productId) {
    const product = await AsinListProduct.findById(productId).lean();
    if (!product) throw new Error('Product not found');
    return {
      queries: withNameFallback(mergeSearchQueries(product.searchQueries), product.name),
      scopeName: product.name
    };
  }

  if (rangeId) {
    const [range, products] = await Promise.all([
      AsinListRange.findById(rangeId).lean(),
      AsinListProduct.find({ rangeId }).select('searchQueries name').lean()
    ]);
    if (!range) throw new Error('Range not found');
    const queries = mergeSearchQueries(
      range.searchQueries,
      ...products.map(p => p.searchQueries)
    );
    return { queries: withNameFallback(queries, range.name), scopeName: range.name };
  }

  if (categoryId) {
    const [category, ranges, products] = await Promise.all([
      AsinListCategory.findById(categoryId).lean(),
      AsinListRange.find({ categoryId }).select('searchQueries').lean(),
      AsinListProduct.find({ categoryId }).select('searchQueries').lean()
    ]);
    if (!category) throw new Error('Category not found');
    const queries = mergeSearchQueries(
      category.searchQueries,
      ...ranges.map(r => r.searchQueries),
      ...products.map(p => p.searchQueries)
    );
    return { queries: withNameFallback(queries, category.name), scopeName: category.name };
  }

  throw new Error('A search keyword, or a category to take keywords from, is required');
}

/**
 * Split a candidate batch by whether the seller already sells the product.
 *
 * ACTIVE is decided by one rule only, shared with the precheck's Active column
 * via utils/sellerActiveSkus.js: generate the SKU from the ASIN, look it up in
 * this seller's synced SKU index, found means active. Only active ASINs are
 * excluded from sourcing.
 *
 * TemplateListing rows are counted but NOT excluded. A listing generated here
 * and never uploaded is not live, so the ASIN is still worth listing; blocking
 * it would lock a product away behind unfinished work. The count is reported so
 * a pile of unfinished drafts is visible rather than silently shaping results.
 *
 * Scoped to the seller, not globally: listing one ASIN across several sellers is
 * the normal business, which is why cross-seller title and price uniqueness is
 * enforced separately.
 *
 * @returns {Promise<{active: Set<string>, generated: Set<string>}>} by ASIN
 */
async function findAlreadyListed(sellerId, asins) {
  if (asins.length === 0) return { active: new Set(), generated: new Set() };

  const [active, generatedRows] = await Promise.all([
    findActiveAsinsForSeller(sellerId, asins),
    TemplateListing.find({
      sellerId,
      _asinReference: { $in: asins },
      status: { $in: ['active', 'draft'] }
    }).select('+_asinReference').lean()
  ]);

  return {
    active,
    generated: new Set(generatedRows.map(l => String(l._asinReference).toUpperCase()))
  };
}

/**
 * ASINs listed so many times across the business that another listing is
 * unlikely to be worth the credits. Off unless a ceiling is supplied.
 */
async function findOverListed(asins, maxListingCount) {
  if (!maxListingCount || asins.length === 0) return new Set();

  const docs = await AsinDirectory.find({
    asin: { $in: asins },
    listingCount: { $gte: maxListingCount }
  }).select('asin').lean();

  return new Set(docs.map(d => String(d.asin).toUpperCase()));
}

/**
 * Source `want` fresh ASINs, re-searching to cover ASINs the database rejects.
 *
 * The search API cannot know what this seller has already listed, so filtering
 * happens after the fact — which means a batch can come back short and has to
 * be topped up. Rejected ASINs join the exclusion set so the next round does
 * not simply find them again.
 */
async function sourceFreshAsins({ run, want, excluded, maxListingCount, onProgress }) {
  const collected = [];
  const cursor = run.getPageCursorMap();
  let creditsSpent = 0;
  let exhausted = false;
  const errors = [];
  const totals = { alreadyListed: 0, liveOnEbay: 0, overListed: 0 };
  const stats = {
    pagesFetched: 0, resultsSeen: 0,
    rejectedSponsored: 0, rejectedPrice: 0, rejectedNoPrice: 0,
    rejectedRating: 0, rejectedReviews: 0,
    rejectedDuplicate: 0, rejectedExcluded: 0, rejectedInvalidAsin: 0
  };
  let stopReason = 'target_met';
  let atCeiling = false;

  for (let round = 0; round < MAX_SOURCING_ROUNDS && collected.length < want; round++) {
    const shortfall = want - collected.length;

    const outcome = await searchAsins({
      queries: run.queries,
      target: shortfall,
      priceMin: run.priceMin,
      priceMax: run.priceMax,
      minRating: run.minRating,
      minReviews: run.minReviews,
      region: run.region,
      excludeAsins: excluded,
      startPages: cursor,
      onProgress: onProgress
        ? (snapshot) => onProgress({ ...snapshot, found: collected.length + snapshot.found, target: want })
        : null
    });

    creditsSpent += outcome.creditsSpent;
    errors.push(...outcome.errors);
    Object.assign(cursor, outcome.pageCursor);
    for (const key of Object.keys(stats)) stats[key] += outcome.stats?.[key] || 0;
    stopReason = outcome.stopReason || stopReason;
    atCeiling = Boolean(outcome.atCeiling);

    // Whatever the search returned is now spent, whether or not we keep it.
    for (const asin of outcome.asins) excluded.add(asin);

    const [alreadyListed, overListed] = await Promise.all([
      findAlreadyListed(run.sellerId, outcome.asins),
      findOverListed(outcome.asins, maxListingCount)
    ]);

    for (const result of outcome.results) {
      // Active means the seller already sells it. That is the only exclusion.
      if (alreadyListed.active.has(result.asin)) { totals.liveOnEbay += 1; continue; }
      if (overListed.has(result.asin)) { totals.overListed += 1; continue; }

      // Generated here but never uploaded: still listable, just worth counting.
      if (alreadyListed.generated.has(result.asin)) totals.alreadyListed += 1;

      collected.push(result);
      if (collected.length >= want) break;
    }

    // Nothing left to page: every keyword is dry or at its ceiling, so another
    // round would buy nothing. Checked on pages consumed rather than on ASINs
    // returned, because a round CAN legitimately return zero new ASINs (all
    // already listed) while pages remain worth reading.
    if ((outcome.stats?.pagesFetched || 0) === 0) {
      exhausted = true;
      break;
    }
  }

  // Name the cause that actually dominated. "Already listed" outweighing what
  // survived is by far the most common reason a run comes back short, and it
  // needs a different fix from a dry keyword or a narrow price band — so it
  // takes priority over whatever the search layer reported.
  if (collected.length < want) {
    if (totals.liveOnEbay > collected.length) stopReason = 'already_listed';
    else if (stopReason === 'target_met') stopReason = 'rounds';
  }

  return {
    results: collected.slice(0, want),
    cursor,
    creditsSpent,
    exhausted: exhausted || collected.length < want,
    errors,
    totals,
    stats,
    stopReason,
    atCeiling
  };
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @swagger
 * /asin-sourcing/stream:
 *   get:
 *     tags: [ASIN Sourcing]
 *     summary: Source ASINs from Amazon search for a category and price band (SSE)
 *     description: >
 *       Starts a new sourcing run, or tops up an existing one when runId is
 *       supplied. Streams progress events and finishes with a `complete` event
 *       carrying the ASINs. Scrapingdog's search API has no category or price
 *       parameter, so the category resolves to a saved keyword set and the
 *       price band is applied to the search results.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: runId
 *         schema: { type: string }
 *         description: Top up this run instead of starting a new one
 *       - in: query
 *         name: categoryId
 *         schema: { type: string }
 *       - in: query
 *         name: rangeId
 *         schema: { type: string }
 *       - in: query
 *         name: productId
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *       - in: query
 *         name: templateId
 *         schema: { type: string }
 *       - in: query
 *         name: targetCount
 *         schema: { type: integer, maximum: 100 }
 *       - in: query
 *         name: priceMin
 *         schema: { type: number }
 *       - in: query
 *         name: priceMax
 *         schema: { type: number }
 *       - in: query
 *         name: region
 *         schema: { type: string, enum: [US, UK, CA, AU] }
 *     responses:
 *       200:
 *         description: SSE stream of started / progress / complete events
 *       400:
 *         description: Missing or invalid parameters
 */
router.get('/stream', requireAuthSSE, async (req, res) => {
  let heartbeat = null;

  try {
    const {
      runId,
      keywords,
      categoryId,
      rangeId,
      productId,
      sellerId,
      templateId,
      region = 'US'
    } = req.query;

    const targetCount = Math.min(
      MAX_TARGET,
      Math.max(1, parseInt(req.query.targetCount, 10) || 0)
    );

    if (!targetCount) {
      return res.status(400).json({ error: 'targetCount is required' });
    }
    if (!runId && (!sellerId || !templateId)) {
      return res.status(400).json({ error: 'Seller ID and Template ID are required' });
    }
    if (!runId && !keywords && !categoryId && !rangeId && !productId) {
      return res.status(400).json({ error: 'A search keyword is required' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    let streamClosed = false;
    const sendSse = (payload) => {
      if (streamClosed) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    };
    const sendDone = () => {
      if (streamClosed) return;
      res.write('data: [DONE]\n\n');
      if (typeof res.flush === 'function') res.flush();
    };

    heartbeat = setInterval(() => sendSse({ type: 'ping', timestamp: Date.now() }), 15000);
    req.on('close', () => {
      streamClosed = true;
      if (heartbeat) clearInterval(heartbeat);
    });

    // ── Load or create the run ────────────────────────────────────────────
    let run;

    if (runId) {
      if (!mongoose.Types.ObjectId.isValid(runId)) {
        sendSse({ type: 'error', error: 'Invalid run ID' });
        sendDone();
        clearInterval(heartbeat);
        return res.end();
      }
      run = await AsinSourcingRun.findById(runId);
      if (!run) {
        sendSse({ type: 'error', error: 'Sourcing run not found' });
        sendDone();
        clearInterval(heartbeat);
        return res.end();
      }

      // A run carries the operator's own discard history and spends their
      // credits; topping up someone else's is not theirs to do.
      if (run.createdBy && String(run.createdBy) !== String(req.user?.userId)) {
        sendSse({ type: 'error', error: 'This sourcing run belongs to another user' });
        sendDone();
        clearInterval(heartbeat);
        return res.end();
      }
    } else {
      const [seller, template] = await Promise.all([
        Seller.findById(sellerId).select('_id').lean(),
        ListingTemplate.findById(templateId).select('_id').lean()
      ]);

      if (!seller || !template) {
        sendSse({ type: 'error', error: 'Seller or template not found' });
        sendDone();
        clearInterval(heartbeat);
        return res.end();
      }

      let resolved;
      try {
        resolved = await resolveQueries({ keywords, categoryId, rangeId, productId });
      } catch (resolveError) {
        sendSse({ type: 'error', error: resolveError.message });
        sendDone();
        clearInterval(heartbeat);
        return res.end();
      }

      // withNameFallback returns nothing only when the node has neither
      // keywords nor a usable name — searching for an empty string would just
      // buy a page of unrelated results.
      if (resolved.queries.length === 0) {
        sendSse({
          type: 'error',
          error: 'No usable search keyword. Type one, or add keywords to the category.'
        });
        sendDone();
        clearInterval(heartbeat);
        return res.end();
      }

      run = new AsinSourcingRun({
        categoryId: categoryId || null,
        rangeId: rangeId || null,
        productId: productId || null,
        queries: resolved.queries,
        sellerId,
        templateId,
        region,
        priceMin: parseNumber(req.query.priceMin),
        priceMax: parseNumber(req.query.priceMax),
        minRating: parseNumber(req.query.minRating),
        minReviews: parseNumber(req.query.minReviews),
        targetCount,
        createdBy: req.user?.userId || null
      });
    }

    // A per-request knob, not run state: how many times an ASIN may already
    // have been listed business-wide before we skip it.
    const maxListingCount = parseNumber(req.query.maxListingCount);

    sendSse({
      type: 'started',
      runId: run._id.toString(),
      target: targetCount,
      queries: run.queries,
      isTopUp: Boolean(runId),
      alreadyServed: (run.servedAsins || []).length
    });

    // ── Source ────────────────────────────────────────────────────────────
    const excluded = run.getExcludedAsins();

    const outcome = await sourceFreshAsins({
      run,
      want: targetCount,
      excluded,
      maxListingCount,
      onProgress: (snapshot) => sendSse({ type: 'progress', ...snapshot })
    });

    // ── Persist ───────────────────────────────────────────────────────────
    run.setPageCursorMap(outcome.cursor);
    run.servedAsins = [...(run.servedAsins || []), ...outcome.results.map(r => r.asin)];
    run.creditsSpent = (run.creditsSpent || 0) + outcome.creditsSpent;
    run.status = outcome.exhausted ? 'exhausted' : 'active';
    run.lastStats = {
      ...outcome.stats,
      skippedAlreadyListed: outcome.totals.alreadyListed,
      skippedLiveOnEbay: outcome.totals.liveOnEbay,
      skippedOverListed: outcome.totals.overListed,
      stopReason: outcome.stopReason
    };
    run.lastError = outcome.errors.length > 0 ? outcome.errors[0].message : null;
    await run.save();

    sendSse({
      type: 'complete',
      runId: run._id.toString(),
      asins: outcome.results.map(r => r.asin),
      results: outcome.results,
      requested: targetCount,
      found: outcome.results.length,
      // Short of the target: every keyword ran dry or hit its page ceiling.
      // Reported plainly so the operator knows to widen the band or add
      // keywords rather than assuming the category is empty.
      exhausted: outcome.exhausted,
      creditsSpent: outcome.creditsSpent,
      totalCreditsSpent: run.creditsSpent,
      skipped: outcome.totals,
      stats: outcome.stats,
      stopReason: outcome.stopReason,
      // True when every keyword is paged out: "find more" cannot help, only a
      // new keyword can.
      atCeiling: outcome.atCeiling,
      errors: outcome.errors.slice(0, 5),
      totalServed: run.servedAsins.length
    });

    sendDone();
    clearInterval(heartbeat);
    return res.end();
  } catch (error) {
    console.error('[ASIN Sourcing] Stream failed:', error);
    if (heartbeat) clearInterval(heartbeat);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to source ASINs' });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
});

/**
 * @swagger
 * /asin-sourcing/{id}/discard:
 *   post:
 *     tags: [ASIN Sourcing]
 *     summary: Record ASINs the operator discarded in review
 *     description: >
 *       Discarded ASINs are excluded from every later top-up of this run, so
 *       asking for more never returns something already rejected.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [asins]
 *             properties:
 *               asins: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Updated discard totals
 *       404:
 *         description: Run not found
 */
router.post('/:id/discard', requireAuth, requireObjectId(), validate(recordDiscardedAsinsSchema), async (req, res) => {
  try {
    const { asins } = req.body;
    const normalized = [...new Set(asins.map(a => String(a).toUpperCase().trim()).filter(Boolean))];

    const existing = await AsinSourcingRun.findById(req.params.id).select('createdBy').lean();
    if (!existing) return res.status(404).json({ error: 'Sourcing run not found' });
    if (existing.createdBy && String(existing.createdBy) !== String(req.user?.userId)) {
      return res.status(403).json({ error: 'This sourcing run belongs to another user' });
    }

    const run = await AsinSourcingRun.findByIdAndUpdate(
      req.params.id,
      { $addToSet: { discardedAsins: { $each: normalized } }, $set: { updatedAt: new Date() } },
      { new: true }
    ).lean();

    if (!run) return res.status(404).json({ error: 'Sourcing run not found' });

    res.json({
      runId: run._id,
      discardedCount: run.discardedAsins.length,
      servedCount: run.servedAsins.length
    });
  } catch (error) {
    console.error('[ASIN Sourcing] Failed to record discards:', error);
    res.status(500).json({ error: 'Failed to record discarded ASINs' });
  }
});

/**
 * @swagger
 * /asin-sourcing/{id}/continued:
 *   post:
 *     tags: [ASIN Sourcing]
 *     summary: Record which sourced ASINs went on to listing generation
 *     description: >
 *       Sourcing hands over a batch; the precheck filters and the inactive-only
 *       rule then cut it down. This records what actually survived, so a run can
 *       be audited for how many of the ASINs it bought were genuinely usable.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [asins]
 *             properties:
 *               asins: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Updated totals
 *       403:
 *         description: Run belongs to another user
 *       404:
 *         description: Run not found
 */
router.post('/:id/continued', requireAuth, requireObjectId(), validate(recordContinuedAsinsSchema), async (req, res) => {
  try {
    const { asins, dropped = {}, served = 0 } = req.body;
    const normalized = [...new Set(asins.map(a => String(a).toUpperCase().trim()).filter(Boolean))];

    const existing = await AsinSourcingRun.findById(req.params.id).select('createdBy').lean();
    if (!existing) return res.status(404).json({ error: 'Sourcing run not found' });
    if (existing.createdBy && String(existing.createdBy) !== String(req.user?.userId)) {
      return res.status(403).json({ error: 'This sourcing run belongs to another user' });
    }

    const run = await AsinSourcingRun.findByIdAndUpdate(
      req.params.id,
      {
        $addToSet: { continuedAsins: { $each: normalized } },
        $set: {
          continuedAt: new Date(),
          updatedAt: new Date(),
          precheckStats: {
            served: Number(served) || 0,
            continued: normalized.length,
            droppedError: Number(dropped.error) || 0,
            droppedActive: Number(dropped.active) || 0,
            droppedPrice: Number(dropped.price) || 0,
            droppedRating: Number(dropped.rating) || 0,
            droppedDelivery: Number(dropped.delivery) || 0,
            droppedStock: Number(dropped.stock) || 0,
            droppedKeyword: Number(dropped.keyword) || 0,
            droppedExcluded: Number(dropped.excluded) || 0,
            droppedMotors: Number(dropped.motors) || 0
          }
        }
      },
      { new: true }
    ).lean();

    res.json({
      runId: run._id,
      servedCount: run.servedAsins.length,
      continuedCount: run.continuedAsins.length,
      discardedCount: run.discardedAsins.length
    });
  } catch (error) {
    console.error('[ASIN Sourcing] Failed to record continued ASINs:', error);
    res.status(500).json({ error: 'Failed to record continued ASINs' });
  }
});

/**
 * @swagger
 * /asin-sourcing:
 *   get:
 *     tags: [ASIN Sourcing]
 *     summary: List the current user's recent sourcing runs
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Recent runs, newest first
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const filter = { createdBy: req.user?.userId || null };
    if (req.query.sellerId && mongoose.Types.ObjectId.isValid(req.query.sellerId)) {
      filter.sellerId = req.query.sellerId;
    }

    const runs = await AsinSourcingRun.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('categoryId', 'name')
      .populate('rangeId', 'name')
      .populate('productId', 'name')
      .populate('sellerId', 'name')
      .lean();

    res.json(runs.map(run => ({
      ...run,
      servedCount: (run.servedAsins || []).length,
      continuedCount: (run.continuedAsins || []).length,
      discardedCount: (run.discardedAsins || []).length
    })));
  } catch (error) {
    console.error('[ASIN Sourcing] Failed to list runs:', error);
    res.status(500).json({ error: 'Failed to list sourcing runs' });
  }
});

/**
 * @swagger
 * /asin-sourcing/{id}:
 *   get:
 *     tags: [ASIN Sourcing]
 *     summary: Fetch one sourcing run
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The run
 *       404:
 *         description: Run not found
 */
router.get('/:id', requireAuth, requireObjectId(), async (req, res) => {
  try {
    const run = await AsinSourcingRun.findById(req.params.id)
      .populate('categoryId', 'name')
      .populate('rangeId', 'name')
      .populate('productId', 'name')
      .lean();

    if (!run) return res.status(404).json({ error: 'Sourcing run not found' });

    res.json({
      ...run,
      servedCount: (run.servedAsins || []).length,
      continuedCount: (run.continuedAsins || []).length,
      discardedCount: (run.discardedAsins || []).length
    });
  } catch (error) {
    console.error('[ASIN Sourcing] Failed to fetch run:', error);
    res.status(500).json({ error: 'Failed to fetch sourcing run' });
  }
});

export default router;

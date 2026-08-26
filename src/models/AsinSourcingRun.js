import mongoose from 'mongoose';

/**
 * One automated ASIN sourcing run.
 *
 * This exists for one reason: the operator discards a lot. They ask for 100
 * ASINs, throw away 60 in review, and then want 60 more *of the same kind* —
 * without being shown any of the ASINs they already saw or rejected.
 *
 * A stateless search cannot do that. Scrapingdog's search API has no cursor of
 * its own, so resuming means remembering two things ourselves:
 *
 *   1. pageCursor — how deep we already paged each keyword, so a top-up starts
 *      at page N+1 instead of re-buying page 1 and re-filtering the same rows.
 *   2. servedAsins + discardedAsins — everything already offered, so nothing
 *      is ever offered twice across top-ups.
 */

// Keywords can contain dots and other characters that are awkward as document
// keys, so the cursor is stored as an array of pairs rather than a map.
const pageCursorEntrySchema = new mongoose.Schema({
  query: { type: String, required: true },
  page: { type: Number, required: true, min: 0 }
}, { _id: false });

const asinSourcingRunSchema = new mongoose.Schema({
  // Where the keywords came from. All three are optional because a run can be
  // scoped at any level of the taxonomy; queries below is the resolved truth.
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'AsinListCategory', default: null, index: true },
  rangeId: { type: mongoose.Schema.Types.ObjectId, ref: 'AsinListRange', default: null },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'AsinListProduct', default: null },

  // Resolved at start and then frozen. Editing a category's keywords must not
  // silently change what a half-finished run is paging through.
  queries: { type: [String], default: [] },

  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true, index: true },
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'ListingTemplate', required: true },
  region: { type: String, default: 'US', enum: ['US', 'UK', 'CA', 'AU'] },

  priceMin: { type: Number, default: null },
  priceMax: { type: Number, default: null },
  minRating: { type: Number, default: null },
  minReviews: { type: Number, default: null },

  // What the first request asked for. Top-ups add to servedAsins without
  // changing this, so it stays a record of the original intent.
  targetCount: { type: Number, required: true, min: 1 },

  pageCursor: { type: [pageCursorEntrySchema], default: [] },

  // Every ASIN this run has handed to the operator, across all top-ups.
  servedAsins: { type: [String], default: [] },

  // Rejected in review. Kept separate from servedAsins so the UI can report
  // "you discarded 60 of 100" and so a future run could learn from it; both
  // sets are excluded when sourcing more.
  discardedAsins: { type: [String], default: [] },

  // What actually went on to listing generation after the precheck filters had
  // their say. Always a subset of servedAsins, and usually a smaller one:
  // sourcing hands over 50, the price/rating/stock filters and the
  // inactive-only rule cut it to whatever was genuinely listable. Without this
  // the run only records what was offered, not what was used.
  continuedAsins: { type: [String], default: [] },
  continuedAt: { type: Date, default: null },

  // Why a run came back short. Without this the record shows "asked 20, got 9"
  // with no way to tell whether the price band was too narrow, the keyword ran
  // out of pages, or everything was already listed — which are three completely
  // different fixes.
  lastStats: {
    pagesFetched: { type: Number, default: 0 },
    resultsSeen: { type: Number, default: 0 },
    rejectedSponsored: { type: Number, default: 0 },
    rejectedPrice: { type: Number, default: 0 },
    rejectedNoPrice: { type: Number, default: 0 },
    rejectedRating: { type: Number, default: 0 },
    rejectedReviews: { type: Number, default: 0 },
    rejectedDuplicate: { type: Number, default: 0 },
    rejectedExcluded: { type: Number, default: 0 },
    rejectedInvalidAsin: { type: Number, default: 0 },
    // Already generated in this tool for this seller (TemplateListing, by ASIN).
    skippedAlreadyListed: { type: Number, default: 0 },
    // Already live on eBay for this seller (SellerSkuIndex, by base SKU) - the
    // same signal the precheck's Active badge uses.
    skippedLiveOnEbay: { type: Number, default: 0 },
    skippedOverListed: { type: Number, default: 0 },
    // 'target_met' | 'keyword_dry' | 'page_ceiling' | 'errors' | 'rounds'
    stopReason: { type: String, default: '' }
  },

  // Why the precheck dropped what it dropped, between sourcing and generation.
  // lastStats explains why SOURCING came back short; this explains why a full
  // batch still produced few listings, which is a different question with a
  // different fix and was previously invisible.
  precheckStats: {
    served: { type: Number, default: 0 },
    continued: { type: Number, default: 0 },
    droppedError: { type: Number, default: 0 },
    droppedActive: { type: Number, default: 0 },
    droppedPrice: { type: Number, default: 0 },
    droppedRating: { type: Number, default: 0 },
    droppedDelivery: { type: Number, default: 0 },
    droppedStock: { type: Number, default: 0 },
    droppedKeyword: { type: Number, default: 0 },
    droppedExcluded: { type: Number, default: 0 },
    droppedMotors: { type: Number, default: 0 }
  },

  creditsSpent: { type: Number, default: 0 },

  // 'exhausted' means the keywords ran dry or hit their page ceiling before the
  // target was met — an honest short return, not a failure.
  status: {
    type: String,
    enum: ['active', 'exhausted', 'completed', 'failed'],
    default: 'active',
    index: true
  },
  lastError: { type: String, default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// The sourcing page lists a user's recent runs so they can resume one.
asinSourcingRunSchema.index({ createdBy: 1, createdAt: -1 });
asinSourcingRunSchema.index({ sellerId: 1, templateId: 1, createdAt: -1 });

asinSourcingRunSchema.pre('save', function markUpdated(next) {
  this.updatedAt = new Date();
  next();
});

/** Cursor array -> { [query]: page }, the shape searchAsins() takes. */
asinSourcingRunSchema.methods.getPageCursorMap = function getPageCursorMap() {
  const map = {};
  for (const entry of this.pageCursor || []) {
    map[entry.query] = entry.page;
  }
  return map;
};

/** { [query]: page } -> cursor array. */
asinSourcingRunSchema.methods.setPageCursorMap = function setPageCursorMap(map) {
  this.pageCursor = Object.entries(map || {}).map(([query, page]) => ({ query, page }));
};

/**
 * Everything this run must not offer again: already served, already discarded.
 * Uppercased because ASINs are compared case-insensitively everywhere else.
 */
asinSourcingRunSchema.methods.getExcludedAsins = function getExcludedAsins() {
  return new Set([
    ...(this.servedAsins || []),
    ...(this.discardedAsins || [])
  ].map(a => String(a).toUpperCase()));
};

export default mongoose.model('AsinSourcingRun', asinSourcingRunSchema);

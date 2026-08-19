import mongoose from 'mongoose';

/**
 * One bulk-overlay run: a batch of live eBay listings that had an overlay badge
 * composited onto their primary picture and were then revised on eBay.
 *
 * Kept as a parent/child pair with ListingOverlayItem (mirroring
 * AutoCompatibilityBatch/Item) because the child rows carry each listing's
 * ORIGINAL picture list — the only record of what to restore. These are live
 * listings with sales history, so a run has to be undoable.
 */
const listingOverlayRunSchema = new mongoose.Schema({
  seller: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    required: true,
    index: true
  },

  // Badge applied to the batch. Individual items may differ when a row was
  // overridden during review, so the item rows remain the source of truth.
  badgeKey: { type: String, default: '' },

  // What the operator filtered on, so a run can be understood after the fact.
  filters: {
    category: { type: String, default: '' },
    search: { type: String, default: '' }
  },

  status: {
    type: String,
    enum: ['previewing', 'submitting', 'completed', 'failed', 'reverting', 'reverted'],
    default: 'previewing',
    index: true
  },

  totalItems: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  revertedCount: { type: Number, default: 0 },

  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  revertedAt: { type: Date, default: null },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, { timestamps: true });

listingOverlayRunSchema.index({ seller: 1, createdAt: -1 });

export default mongoose.model('ListingOverlayRun', listingOverlayRunSchema);

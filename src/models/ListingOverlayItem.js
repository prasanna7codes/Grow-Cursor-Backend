import mongoose from 'mongoose';

/**
 * One listing within a bulk-overlay run.
 *
 * `originalImages` is written BEFORE the ReviseFixedPriceItem call, never after,
 * so a crash between the revise and the bookkeeping still leaves a row that can
 * restore the listing. Without that ordering a half-finished run would be
 * unrevertible precisely when reverting matters most.
 */
const listingOverlayItemSchema = new mongoose.Schema({
  run: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ListingOverlayRun',
    required: true,
    index: true
  },

  itemId: { type: String, required: true },
  sku: { type: String, default: '' },
  title: { type: String, default: '' },
  badgeKey: { type: String, default: '' },

  // Full picture lists, primary first. eBay rejects a listing that mixes
  // EPS-hosted and external pictures (error 20004), so both are stored whole
  // rather than just the primary that visibly changed.
  originalImages: { type: [String], default: [] },
  newImages: { type: [String], default: [] },

  status: {
    type: String,
    enum: ['previewed', 'submitted', 'failed', 'skipped', 'reverted'],
    default: 'previewed',
    index: true
  },

  error: { type: String, default: '' },

  submittedAt: { type: Date, default: null },
  revertedAt: { type: Date, default: null }
}, { timestamps: true });

// One row per listing per run; also serves the run detail view.
listingOverlayItemSchema.index({ run: 1, itemId: 1 }, { unique: true });
// "Has this listing been badged before?" — the idempotency check that replaces
// the hostname heuristic, which is meaningless when the source is eBay itself.
listingOverlayItemSchema.index({ itemId: 1, status: 1 });

export default mongoose.model('ListingOverlayItem', listingOverlayItemSchema);

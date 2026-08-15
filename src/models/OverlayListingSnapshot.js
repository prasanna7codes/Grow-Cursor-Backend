import mongoose from 'mongoose';

/**
 * A disposable snapshot of a seller's active listings, taken purely so the
 * Listing Overlays page can be searched repeatedly without re-crawling eBay.
 *
 * WHY THIS IS SEPARATE FROM SellerSkuIndex
 * That collection is fed by a daily cron several other features depend on
 * (stock checks, SKU profit, active-SKU lookups). This one exists for a one-off
 * badging pass: once every listing that needs an overlay has one, the whole
 * collection can be dropped without touching anything else. Keeping them apart
 * means the throwaway data is genuinely throwaway.
 *
 * DELIBERATELY NOT AUTHORITATIVE
 * Only listing DISCOVERY reads from here — searching, filtering, the table.
 * The pictures that actually get badged are always fetched live with GetItem at
 * preview time, so a stale row can at worst surface a listing that has since
 * ended (the revise then fails visibly). It can never cause the wrong image to
 * be composited.
 */
const overlayListingSnapshotSchema = new mongoose.Schema({
  seller: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    required: true,
    index: true
  },

  // eBay item ids are unique across all of eBay, so this alone identifies a row.
  itemId: { type: String, required: true },

  sku: { type: String, default: '' },
  title: { type: String, default: '' },
  categoryId: { type: String, default: '' },
  categoryName: { type: String, default: '' },
  // Gallery thumbnail only. The full picture set is never stored — it is read
  // live from GetItem when a listing is actually badged.
  imageUrl: { type: String, default: '' },

  // Stamped on every write of a sync pass. Rows carrying an older stamp after a
  // completed pass are listings that have ended, and get deleted.
  syncedAt: { type: Date, required: true, index: true }
}, { timestamps: true });

overlayListingSnapshotSchema.index({ seller: 1, itemId: 1 }, { unique: true });
// Serves the category filter, which is applied in the database before the
// keyword match narrows things further in memory.
overlayListingSnapshotSchema.index({ seller: 1, categoryName: 1 });

export default mongoose.model('OverlayListingSnapshot', overlayListingSnapshotSchema);

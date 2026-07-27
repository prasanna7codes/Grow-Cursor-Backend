import mongoose from 'mongoose';

/**
 * Composite cache: one row per (source image, badge, placement, seller).
 *
 * Persisted rather than held in memory because the expensive part is the eBay
 * Picture Services upload — an in-process cache would re-upload every image
 * after each deploy and leak EPS pictures.
 */
const overlayImageSchema = new mongoose.Schema({
  // sha1 of source URL + badge key/version + placement + seller. See
  // utils/overlayImage.js buildCacheKey().
  cacheKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  sourceUrl: { type: String, required: true },
  hostedUrl: { type: String, required: true },

  badgeKey: { type: String, required: true },
  badgeVersion: { type: Number, required: true },

  scale: Number,
  anchor: String,
  margin: Number,

  // EPS pictures are account-scoped, so a composite is not shared across
  // sellers — otherwise one suspended account could break another's listings.
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    required: true,
    index: true
  },

  host: { type: String, default: 'eps' },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('OverlayImage', overlayImageSchema);

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

  // Indexed because the refresh path looks rows up BACKWARDS: a CSV export
  // holds only the hosted URLs, and has to recover each picture's recipe to
  // rebuild it. See utils/overlayImage.js refreshExpiredImages().
  hostedUrl: { type: String, required: true, index: true },

  // The Media API's handle for this picture. Kept alongside hostedUrl because
  // it is the only thing that can be asked about later: getImage(imageId)
  // answers 404 once EPS has dropped the image, whereas the URL alone can only
  // be discovered as broken by a listing failing.
  //
  // Absent on rows written before the UploadSiteHostedPictures migration —
  // that call returned a URL and nothing else.
  imageId: { type: String },

  // When EPS will drop this picture if no live listing references it. Null on
  // pre-migration rows, which utils/overlayImage.js isExpiring() treats as
  // stale for exactly that reason.
  expiresAt: { type: Date, default: null },

  // When hostedUrl was last uploaded. Distinct from createdAt, which records
  // when the composite was FIRST hosted and never moves: a row whose picture
  // expired and was re-hosted is new again, and ageing it against createdAt
  // would retire it immediately. canReuseCachedImage() measures against this.
  hostedAt: { type: Date, default: null },

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

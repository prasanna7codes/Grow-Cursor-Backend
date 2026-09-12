import mongoose from 'mongoose';

// One Amazon delivery-date SLA check. Mirrors AmazonStockCheckRun's shape and
// lifecycle deliberately (same statuses, same runner ownership, same resume
// rules) but is a separate collection so a delivery run and a stock run never
// share progress counters or interfere with each other's pause/cancel.
const AmazonDeliveryCheckRunSchema = new mongoose.Schema(
  {
    countries: [{ type: String, required: true }],
    currencies: [{ type: String, required: true }],
    status: {
      type: String,
      enum: ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'],
      default: 'queued',
      index: true
    },
    mode: {
      type: String,
      enum: ['test_pilot', 'pilot_option_b', 'custom', 'full', 'seller'],
      default: 'test_pilot'
    },
    // test_pilot only: how many CHECKABLE SKUs (ones that resolve to an ASIN)
    // the run should stop at. SKUs with no ASIN are skipped rather than
    // stored, so asking for 25 gives 25 real delivery checks instead of 25
    // rows of which only a handful can be scraped.
    skuLimit: { type: Number, default: null },
    // test_pilot only: true when the scan hit its candidate ceiling before
    // finding skuLimit ASINs, so the page can say why it checked fewer.
    skuLimitUnmet: { type: Boolean, default: false },
    // Optional seller scope: when set, only this seller's SKU index rows are checked.
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', default: null, index: true },
    // The slowest delivery still acceptable. A quote of exactly this many days
    // passes; one day more is flagged.
    maxDeliveryDays: { type: Number, default: 9 },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Which server instance owns/processes this run ('render' | 'local'), same
    // convention as AmazonStockCheckRun. Empty/missing = legacy run created
    // before ownership tracking — only the Render runner adopts those on boot.
    runnerId: { type: String, default: '' },
    totalSkus: { type: Number, default: 0 },
    asinFoundCount: { type: Number, default: 0 },
    noAsinCount: { type: Number, default: 0 },
    checkedCount: { type: Number, default: 0 },
    withinRangeCount: { type: Number, default: 0 },
    flaggedLateCount: { type: Number, default: 0 },
    // Amazon shows no delivery date for a dead listing, so these are tracked
    // apart from noDeliveryDateCount — one is explained, the other is not.
    outOfStockCount: { type: Number, default: 0 },
    noDeliveryDateCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    // SKUs that were inside the SLA on their previous run and are now late.
    becameLateCount: { type: Number, default: 0 },
    creditsEstimated: { type: Number, default: 0 },
    creditsUsed: { type: Number, default: 0 },
    candidateBuildComplete: { type: Boolean, default: false },
    error: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AmazonDeliveryCheckRunSchema.index({ createdAt: -1 });

export default mongoose.model('AmazonDeliveryCheckRun', AmazonDeliveryCheckRunSchema);

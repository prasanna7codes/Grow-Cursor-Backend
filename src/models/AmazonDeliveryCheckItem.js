import mongoose from 'mongoose';

// The eBay listings carrying this SKU. Read-only context for the delivery
// page — unlike the stock check's equivalent there are no quantity/end action
// fields here, because a late delivery date is a flag for a human to judge,
// not something this page acts on automatically.
const SellerItemSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller' },
    sellerName: { type: String, default: '' },
    itemId: { type: String, default: '' },
    title: { type: String, default: '' },
    price: { type: Number, default: null },
    currency: { type: String, default: '' },
    orderCount: { type: Number, default: 0 },
    orderCount90d: { type: Number, default: 0 },
    lastOrderDate: { type: Date, default: null }
  },
  { _id: false }
);

const AmazonDeliveryCheckItemSchema = new mongoose.Schema(
  {
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'AmazonDeliveryCheckRun', required: true },
    sku: { type: String, required: true, index: true },
    asin: { type: String, default: '', index: true },
    currency: { type: String, required: true },
    country: { type: String, required: true },
    status: {
      type: String,
      enum: [
        'queued',
        'processing',
        'within_range',
        'flagged_late',
        'out_of_stock',
        'no_delivery_date',
        'no_asin',
        'error'
      ],
      default: 'queued',
      index: true
    },
    // Worst case of the standard delivery quote — the end of the range when
    // Amazon gives one ("September 16 - 20" stores the 20th). This is the
    // value compared against the SLA.
    deliveryDate: { type: String, default: '' },
    deliveryDays: { type: Number, default: null },
    // Near end of that same quote, kept so a range is visible as a range.
    earliestDeliveryDate: { type: String, default: '' },
    earliestDeliveryDays: { type: Number, default: null },
    // Amazon's paid express option, recorded for context only — it never
    // decides the status (see evaluateDeliveryDate).
    fastestDeliveryDate: { type: String, default: '' },
    fastestDeliveryDays: { type: Number, default: null },
    // The exact line the verdict was read from, plus the rest, so a
    // misclassification can be diagnosed without re-scraping.
    deliveryText: { type: String, default: '' },
    deliveryLines: { type: [String], default: [] },
    availabilityText: { type: String, default: '' },
    // Which offer the quote came from. Amazon rotates the buy box between
    // sellers who ship from different places at different speeds, so a stored
    // date that disagrees with what someone sees in their browser is usually
    // a different seller rather than a bad parse.
    soldBy: { type: String, default: '' },
    shipsFrom: { type: String, default: '' },
    // The postal code we ASKED Scrapingdog for. Kept separate from
    // quoteLocation because the two rarely agree: measured over ~20 calls the
    // postal_code parameter was honoured 0 times.
    postalCodeUsed: { type: String, default: '' },
    // Where Amazon actually priced this quote, read back from the response's
    // own `location` field ("Nashville 37217"). This is the destination the
    // delivery date belongs to, and it changes with Scrapingdog's rotating
    // exit IP — the same ASIN returned 4 to 11 days across locations in one
    // minute. Never compare two rows' day counts without comparing this too.
    quoteLocation: { type: String, default: '', index: true },
    // The SLA in force when this row was checked. Snapshotted because the run
    // it belongs to can be re-read long after, and a row must always explain
    // the threshold it was judged against.
    maxDeliveryDays: { type: Number, default: null },
    scraperStatusCode: { type: Number, default: null },
    // True when the no_delivery_date or transient-failure retry ran for this item.
    retryAttempted: { type: Boolean, default: false },
    sellerItems: { type: [SellerItemSchema], default: [] },
    // True when any seller carrying this SKU sold at least one unit in the
    // last 90 days — a late SKU that is actually selling is the urgent case.
    hasRecentOrder90d: { type: Boolean, default: false, index: true },
    previousStatus: { type: String, default: '' },
    previousDeliveryDays: { type: Number, default: null },
    becameLate: { type: Boolean, default: false, index: true },
    error: { type: String, default: '' },
    errorType: { type: String, default: '', index: true },
    errorSource: { type: String, default: '' },
    retryable: { type: Boolean, default: false },
    checkedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AmazonDeliveryCheckItemSchema.index({ run: 1, status: 1, hasRecentOrder90d: 1 });
AmazonDeliveryCheckItemSchema.index({ run: 1, status: 1, asin: 1 });
AmazonDeliveryCheckItemSchema.index({ run: 1, becameLate: 1 });
AmazonDeliveryCheckItemSchema.index({ run: 1, deliveryDays: -1 });
AmazonDeliveryCheckItemSchema.index({ run: 1, 'sellerItems.sellerId': 1 });
AmazonDeliveryCheckItemSchema.index({ run: 1, 'sellerItems.orderCount': 1 });
AmazonDeliveryCheckItemSchema.index({ currency: 1, sku: 1, asin: 1 });

export default mongoose.model('AmazonDeliveryCheckItem', AmazonDeliveryCheckItemSchema);

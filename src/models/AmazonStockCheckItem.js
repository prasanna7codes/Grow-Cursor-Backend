import mongoose from 'mongoose';

const SellerItemSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller' },
    sellerName: { type: String, default: '' },
    itemId: { type: String, default: '' },
    title: { type: String, default: '' },
    price: { type: Number, default: null },
    currency: { type: String, default: '' },
    orderCount: { type: Number, default: 0 },
    lastOrderDate: { type: Date, default: null },
    quantityZeroStatus: {
      type: String,
      enum: ['not_needed', 'pending', 'success', 'failed', 'skipped'],
      default: 'not_needed'
    },
    quantityZeroError: { type: String, default: '' },
    quantityOneStatus: {
      type: String,
      enum: ['not_needed', 'pending', 'success', 'failed', 'skipped'],
      default: 'not_needed'
    },
    quantityOneError: { type: String, default: '' }
  },
  { _id: false }
);

const AmazonStockCheckItemSchema = new mongoose.Schema(
  {
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'AmazonStockCheckRun', required: true, index: true },
    sku: { type: String, required: true, index: true },
    asin: { type: String, default: '', index: true },
    currency: { type: String, required: true, index: true },
    country: { type: String, required: true },
    status: {
      type: String,
      enum: ['queued', 'processing', 'in_stock', 'in_stock_unconfirmed', 'low_stock', 'out_of_stock', 'unknown_stock_text', 'no_asin', 'error'],
      default: 'queued',
      index: true
    },
    stockQuantity: { type: Number, default: null },
    availabilityText: { type: String, default: '' },
    scraperStatusCode: { type: Number, default: null },
    scraperResponseSummary: { type: Object, default: {} },
    // Full raw Scrapingdog payload — saved ONLY when status is
    // unknown_stock_text, so the actual response shape can be inspected to
    // diagnose why no recognizable stock text was found (e.g. a differently
    // structured purchase-options block, or a degraded response under load).
    // Left unset otherwise to avoid bloating the ~95% of items that parse fine.
    rawScraperResponse: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // True when the ambiguous unknown_stock_text retry ran for this item
    // (see parseStockStatus's returns-policy fallback in the route).
    retryAttempted: { type: Boolean, default: false },
    sellerItems: { type: [SellerItemSchema], default: [] },
    previousStatus: { type: String, default: '' },
    becameAvailable: { type: Boolean, default: false, index: true },
    error: { type: String, default: '' },
    errorType: { type: String, default: '', index: true },
    errorSource: { type: String, default: '' },
    retryable: { type: Boolean, default: false },
    checkedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AmazonStockCheckItemSchema.index({ run: 1, status: 1 });
AmazonStockCheckItemSchema.index({ run: 1, status: 1, asin: 1 });
AmazonStockCheckItemSchema.index({ run: 1, becameAvailable: 1 });
AmazonStockCheckItemSchema.index({ run: 1, 'sellerItems.quantityZeroStatus': 1 });
AmazonStockCheckItemSchema.index({ run: 1, 'sellerItems.quantityOneStatus': 1 });
AmazonStockCheckItemSchema.index({ run: 1, 'sellerItems.orderCount': 1 });
AmazonStockCheckItemSchema.index({ currency: 1, sku: 1, asin: 1 });

export default mongoose.model('AmazonStockCheckItem', AmazonStockCheckItemSchema);

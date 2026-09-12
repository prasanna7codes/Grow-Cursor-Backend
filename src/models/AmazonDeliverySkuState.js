import mongoose from 'mongoose';

// Last known delivery verdict per SKU/ASIN/currency, carried across runs so a
// run can tell "was inside the SLA last time, is late now" (becameLate) from
// "has always been late". Same role AmazonStockSkuState plays for the stock
// check, kept separate so neither can overwrite the other's history.
const AmazonDeliverySkuStateSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true },
    asin: { type: String, required: true },
    currency: { type: String, required: true },
    country: { type: String, required: true },
    lastStatus: { type: String, default: '' },
    lastDeliveryDate: { type: String, default: '' },
    lastDeliveryDays: { type: Number, default: null },
    lastMaxDeliveryDays: { type: Number, default: null },
    lastRun: { type: mongoose.Schema.Types.ObjectId, ref: 'AmazonDeliveryCheckRun', default: null },
    lastCheckedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

AmazonDeliverySkuStateSchema.index({ currency: 1, sku: 1, asin: 1 }, { unique: true });

export default mongoose.model('AmazonDeliverySkuState', AmazonDeliverySkuStateSchema);

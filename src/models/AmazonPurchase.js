// models/AmazonPurchase.js
//
// One row per eBay order that is being (or has been) bought on Amazon.
//
// Deliberately a sidecar rather than fields on Order: the Order document is the
// eBay record and stays untouched by the purchasing workflow. Everything the
// extension needs — which buyer account owns the order, who is holding it, which
// ASIN, which Amazon order number came back — lives only here. Deleting this
// collection would leave the eBay side exactly as it was.

import mongoose from 'mongoose';

const AmazonPurchaseSchema = new mongoose.Schema(
  {
    // The eBay order being fulfilled. Unique: an order is bought once.
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      unique: true,
      index: true,
    },
    // Denormalised eBay order id so the queue can be read and searched without
    // joining back to Order.
    orderId: { type: String, required: true, index: true },

    // Which Amazon buyer account this order is pinned to — an
    // AmazonBuyerAccount.label, NOT the unrelated AmazonAccount address book.
    // Existence of this row IS the assignment; no other account's queue offers it.
    buyerAccount: { type: String, required: true, index: true },

    status: {
      type: String,
      enum: ['pending', 'claimed', 'placed', 'failed', 'skipped'],
      default: 'pending',
      index: true,
    },

    // Soft lock while an operator works the order. A claim abandoned by a closed
    // browser is reclaimable after the TTL in routes/purchasing.js.
    claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    claimedByName: { type: String, default: '' },
    claimedAt: { type: Date, default: null },

    // Resolved from the SKU at assignment time, or typed in by the operator when
    // the SKU maps to nothing / the mapped product is unavailable.
    asin: { type: String, default: '' },
    asinSource: { type: String, enum: ['sku', 'manual', null], default: null },

    // What came back from the Amazon confirmation page. Intentionally the only
    // thing recorded from it — no prices, no tax, no derived financials.
    azOrderId: { type: String, default: '' },
    placedAt: { type: Date, default: null },

    error: { type: String, default: '' },
    attempts: { type: Number, default: 0 },

    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// The queue read: one account's outstanding work, oldest first.
AmazonPurchaseSchema.index({ buyerAccount: 1, status: 1, createdAt: 1 });

export default mongoose.model('AmazonPurchase', AmazonPurchaseSchema);

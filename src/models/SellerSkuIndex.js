import mongoose from 'mongoose';

// Lightweight collection for fast SKU-active checks.
// Populated by the manual "Sync SKU Index" action (POST /ebay/sync-sku-index).
// Both the raw sku from eBay and a baseSku (suffix stripped) are stored so that
// listings with variants like GRW25N4VFV-1 can be matched by the base GRW25N4VFV.
const SellerSkuIndexSchema = new mongoose.Schema({
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    itemId: { type: String, required: true },
    sku:    { type: String, default: '' },
    baseSku:{ type: String, default: '' }, // sku with trailing -<number> stripped
    title:  { type: String, default: '' },
    price: { type: Number, default: null },
    currency: { type: String, default: '' },
    syncedAt: { type: Date, required: true },
});

// Unique constraint: one record per (seller, itemId)
SellerSkuIndexSchema.index({ seller: 1, itemId: 1 }, { unique: true });
// Fast lookup by baseSku (the field used by check-sku-active)
SellerSkuIndexSchema.index({ seller: 1, baseSku: 1 });
// Fast exact-SKU lookups used by SKU Seller Profit.
SellerSkuIndexSchema.index({ seller: 1, sku: 1 });
SellerSkuIndexSchema.index({ sku: 1 });
// Base-SKU grouping for Amazon stock checks (candidates + verify panel).
SellerSkuIndexSchema.index({ baseSku: 1 });

export default mongoose.model('SellerSkuIndex', SellerSkuIndexSchema);

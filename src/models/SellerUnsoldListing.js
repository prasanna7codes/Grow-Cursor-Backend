import mongoose from 'mongoose';

// Unsold (inactive) eBay listings per seller, populated by the manual
// "Unsold Sync" action which paginates GetMyeBaySelling <UnsoldList>.
// eBay caps that call's DurationInDays at 60, so this is a rolling 60-day window.
const SellerUnsoldListingSchema = new mongoose.Schema({
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    itemId: { type: String, required: true },
    title: { type: String, default: '' },
    sku: { type: String, default: '' },
    baseSku: { type: String, default: '' }, // sku before the first '-', matches TemplateListing.baseCustomLabel
    price: { type: Number, default: null },
    currency: { type: String, default: '' },
    priceUSD: { type: Number, default: null },
    quantity: { type: Number, default: null },
    quantityAvailable: { type: Number, default: null },
    startTime: { type: Date, default: null },
    endTime: { type: Date, default: null },
    viewItemURL: { type: String, default: '' },
    galleryURL: { type: String, default: '' },
    listingType: { type: String, default: '' },
    categoryId: { type: String, default: '' }, // parsed out of ViewItemURLForNaturalSearch
    syncedAt: { type: Date, required: true },
});

SellerUnsoldListingSchema.index({ seller: 1, itemId: 1 }, { unique: true });
SellerUnsoldListingSchema.index({ seller: 1, categoryId: 1, endTime: -1 });
SellerUnsoldListingSchema.index({ seller: 1, endTime: -1 });
SellerUnsoldListingSchema.index({ seller: 1, syncedAt: 1 });
SellerUnsoldListingSchema.index({ seller: 1, baseSku: 1 });

export default mongoose.model('SellerUnsoldListing', SellerUnsoldListingSchema);

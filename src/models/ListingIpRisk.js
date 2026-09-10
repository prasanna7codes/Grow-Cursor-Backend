import mongoose from 'mongoose';

// One document per live eBay listing that the IP Risk Audit has assessed:
// which photos were reverse-image searched, what level they scored, and
// whether the operator has since ended the listing from the audit page.
//
// Keyed by (seller, itemId) rather than ASIN because the same product listed
// under several accounts is several listings to end, each with its own item
// id. The per-ASIN verdict itself is shared through AsinIpRisk, so the second
// account's listing of a product costs no new Vision calls.
const imageResultSchema = new mongoose.Schema(
  {
    url: { type: String, default: '' },
    level: { type: String, default: 'low' },
    matchedDomains: { type: [String], default: [] },
    error: { type: String, default: '' }
  },
  { _id: false }
);

const ListingIpRiskSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true, index: true },
    itemId: { type: String, required: true },
    sku: { type: String, default: '' },
    baseSku: { type: String, default: '' },
    asin: { type: String, default: '' },
    title: { type: String, default: '' },
    categoryName: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    amazonBrand: { type: String, default: '' },

    level: { type: String, enum: ['high', 'medium', 'low', 'unchecked', 'error'], required: true },
    reasons: { type: [String], default: [] },
    matchedDomains: { type: [String], default: [] },
    brandHits: { type: [String], default: [] },
    bestGuessLabels: { type: [String], default: [] },
    imagesChecked: { type: Number, default: 0 },
    images: { type: [imageResultSchema], default: [] },
    // 'vision' = photos were sent to Google for this listing; 'asin-cache' =
    // the verdict came from an earlier check of the same ASIN.
    source: { type: String, enum: ['vision', 'asin-cache'], default: 'vision' },
    checkedAt: { type: Date, default: Date.now },

    // Set when the listing is ended from the audit page. Rows with endedAt are
    // hidden from the results table but kept as the record of what was pulled.
    endedAt: { type: Date, default: null },
    endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    endError: { type: String, default: '' }
  },
  { timestamps: true }
);

ListingIpRiskSchema.index({ seller: 1, itemId: 1 }, { unique: true });
ListingIpRiskSchema.index({ seller: 1, level: 1, endedAt: 1 });
ListingIpRiskSchema.index({ seller: 1, checkedAt: -1 });
ListingIpRiskSchema.index({ asin: 1 });

export default mongoose.model('ListingIpRisk', ListingIpRiskSchema);

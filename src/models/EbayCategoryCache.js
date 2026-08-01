import mongoose from 'mongoose';

// eBay categoryId → categoryName, resolved lazily via GetItem during the unsold sync.
// Global (not per-seller): every Trading API call in this app uses SITEID 0.
const EbayCategoryCacheSchema = new mongoose.Schema({
    categoryId: { type: String, required: true, unique: true },
    categoryName: { type: String, default: '' },
    resolvedAt: { type: Date, default: Date.now },
    sourceItemId: { type: String, default: '' },
});

export default mongoose.model('EbayCategoryCache', EbayCategoryCacheSchema);

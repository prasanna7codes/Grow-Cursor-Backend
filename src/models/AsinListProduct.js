import mongoose from 'mongoose';
import { normalizeSearchQueries } from '../utils/searchQueries.js';

const asinListProductSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  rangeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AsinListRange',
    required: true,
    index: true
  },
  // Denormalized for easy top-level filtering
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AsinListCategory',
    required: true,
    index: true
  },
  // Keywords this node is searched by in the automated ASIN sourcing flow.
  // Scrapingdog's search API has no category parameter, so a saved keyword
  // set is what stands in for an Amazon browse node. Empty falls back to the
  // node's own name (see utils/searchQueries.js).
  searchQueries: {
    type: [String],
    default: [],
    set: normalizeSearchQueries
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Unique name per range
asinListProductSchema.index({ name: 1, rangeId: 1 }, { unique: true });

export default mongoose.model('AsinListProduct', asinListProductSchema);

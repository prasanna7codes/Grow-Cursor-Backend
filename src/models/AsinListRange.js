import mongoose from 'mongoose';
import { normalizeSearchQueries } from '../utils/searchQueries.js';

const asinListRangeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
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

// Unique name per category
asinListRangeSchema.index({ name: 1, categoryId: 1 }, { unique: true });

export default mongoose.model('AsinListRange', asinListRangeSchema);

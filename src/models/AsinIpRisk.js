import mongoose from 'mongoose';

// One document per ASIN: the most recent reverse-image IP risk assessment of
// its Amazon listing photos (see utils/reverseImageCheck.js).
//
// Cached here rather than on AsinDirectory because the directory is only
// populated by some flows and its readers treat a title-less document as
// "never seen"; an upsert from the precheck would break that. Keyed by ASIN,
// not seller, so a photo scanned for one account is never billed again when
// another account prechecks the same product.
const pageMatchSchema = new mongoose.Schema(
  {
    url: { type: String, default: '' },
    title: { type: String, default: '' },
    host: { type: String, default: '' },
    // 'full' = the exact photo was found on the page; 'partial' = a crop of it.
    kind: { type: String, enum: ['full', 'partial'], default: 'full' }
  },
  { _id: false }
);

const imageResultSchema = new mongoose.Schema(
  {
    url: { type: String, default: '' },
    level: { type: String, default: 'low' },
    reasons: { type: [String], default: [] },
    matchedDomains: { type: [String], default: [] },
    brandHits: { type: [String], default: [] },
    bestGuessLabels: { type: [String], default: [] },
    webEntities: { type: [String], default: [] },
    pageMatches: { type: [pageMatchSchema], default: [] },
    error: { type: String, default: '' }
  },
  { _id: false }
);

export const IP_RISK_LEVELS = ['high', 'medium', 'low', 'unchecked', 'error'];

const AsinIpRiskSchema = new mongoose.Schema(
  {
    asin: { type: String, required: true, unique: true, uppercase: true, trim: true },
    level: { type: String, enum: IP_RISK_LEVELS, required: true, index: true },
    reasons: { type: [String], default: [] },
    matchedDomains: { type: [String], default: [] },
    brandHits: { type: [String], default: [] },
    bestGuessLabels: { type: [String], default: [] },
    amazonBrand: { type: String, default: '' },
    title: { type: String, default: '' },
    imagesChecked: { type: Number, default: 0 },
    images: { type: [imageResultSchema], default: [] },
    provider: { type: String, default: 'google-vision' },
    checkedAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

AsinIpRiskSchema.index({ level: 1, checkedAt: -1 });

export default mongoose.model('AsinIpRisk', AsinIpRiskSchema);

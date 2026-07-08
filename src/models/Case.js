import mongoose from 'mongoose';

const CaseSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
  caseId: { type: String, required: true, unique: true },
  caseType: { type: String, enum: ['INR', 'SNAD', 'OTHER'], default: 'INR' },
  orderId: String,
  buyerUsername: String,
  status: { type: String, default: 'OPEN' }, // OPEN, CLOSED, WAITING_BUYER_RESPONSE, WAITING_SELLER_RESPONSE, ON_HOLD
  worksheetStatus: { 
    type: String, 
    enum: ['open', 'attended', 'resolved'],
    default: 'open'
  }, // Manual status for worksheet tracking
  
  // Dates
  creationDate: Date,
  // Fixed seller-facing "resolve by" deadline (expirationDate from GET /inquiry/{id}).
  // Does NOT move when the case flips to waiting-on-buyer — matches eBay's seller page.
  caseDeadline: Date,
  // Always mirrors caseDeadline when known (safe to display as the seller deadline).
  sellerResponseDueDate: Date,
  // eBay's respondByDate is the deadline for whoever must act next, NOT always the
  // seller: it applies to the buyer when status is WAITING_BUYER_RESPONSE.
  nextActionBy: { type: String, enum: ['SELLER', 'BUYER', 'NONE'], default: 'NONE' },
  nextActionDue: Date,
  escalationDate: Date,
  closedDate: Date,
  lastModifiedDate: Date,
  
  // Item Info
  itemId: String,
  itemTitle: String,
  
  // Amount
  claimAmount: {
    value: String,
    currency: { type: String, default: 'USD' }
  },
  
  // Resolution
  resolution: String,
  sellerResponse: String,
  
  // Raw eBay data for reference
  rawData: Object,
  
  // Manual logs field for internal notes
  logs: { type: String, default: '' }
}, { timestamps: true });

// Index for faster queries (caseId already indexed via unique: true)
CaseSchema.index({ seller: 1, status: 1 });
CaseSchema.index({ creationDate: -1 });

export default mongoose.model('Case', CaseSchema);

import mongoose from 'mongoose';

const MessageSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    orderId: String, 
    itemId: String,
    itemTitle: String,
    buyerUsername: { type: String, required: true },
    
    externalMessageId: { type: String, unique: true, sparse: true },
    sender: { type: String, enum: ['SELLER', 'BUYER'], required: true },
    subject: String,
    body: String,
    
    // NEW: Array to store image links
    mediaUrls: [{ type: String }], 

    read: { type: Boolean, default: false },
    messageType: { type: String, enum: ['ORDER', 'INQUIRY', 'DIRECT'], default: 'ORDER' },
    
    messageDate: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

MessageSchema.index({ seller: 1, orderId: 1 });
MessageSchema.index({ seller: 1, buyerUsername: 1 });
MessageSchema.index({ messageDate: -1 });

// --- Query-targeting indexes for live read paths (Equality -> Sort/Range order) ---
// Dashboard unread count/aggregation: { sender:'BUYER', read:false, messageDate:{range} }
// (runs org-wide with no seller filter, so cannot be served by the seller-prefixed indexes)
MessageSchema.index({ sender: 1, read: 1, messageDate: -1 });
// Inquiries-per-day analytics: { sender:'BUYER', messageType:{$ne}, orderId:null-ish, messageDate:{range} }
MessageSchema.index({ sender: 1, messageDate: -1 });
// Chat window + mark read/unread by order: { orderId } sort messageDate
MessageSchema.index({ orderId: 1, messageDate: 1 });
// Chat window + mark read/unread + new-chat lookup by buyer+item: { buyerUsername, itemId[, sender] } sort messageDate
MessageSchema.index({ buyerUsername: 1, itemId: 1, messageDate: -1 });
// Conversation Management pipeline (seller-scoped): { seller, messageDate:{>=cutoff} } sort messageDate
MessageSchema.index({ seller: 1, messageDate: -1 });

export default mongoose.model('Message', MessageSchema);
// models/AmazonBuyerAccount.js
//
// The Amazon accounts orders are actually BOUGHT from — one row per buyer login,
// each expected to live in its own Chrome profile.
//
// Deliberately separate from models/AmazonAccount.js, which is the existing
// admin-managed address book and has nothing to do with buyer logins. Nothing
// here references it.
//
// No credentials are stored. Signing in happens on amazon.com in the operator's
// own browser profile; this collection only records which accounts exist and how
// to recognise the right one.

import mongoose from 'mongoose';

const AmazonBuyerAccountSchema = new mongoose.Schema(
  {
    // Operator-facing name, e.g. 'amz-us-04'. Used as the key everywhere else.
    label: { type: String, required: true, unique: true, trim: true },

    // The login email, so an operator knows which account to sign into. Optional,
    // and an identifier only — never a password.
    email: { type: String, default: '', trim: true },

    // The name Amazon's nav bar greets this account with ("Hello, X"), captured
    // on first use. The extension compares the live page against it so an
    // operator running several profiles cannot buy on the wrong account.
    amazonProfileLabel: { type: String, default: '' },

    // Free-text reminder of which Chrome profile holds this login.
    chromeProfile: { type: String, default: '' },

    // Associate tag appended to product URLs bought on this account, e.g.
    // 'shreejagann0f-20'. Falls back to process.env.AMAZON_ASSOCIATE_TAG.
    associateTag: { type: String, default: '' },

    // Soft ceiling on orders per platform day. 0 uses the platform default.
    dailyOrderCap: { type: Number, default: 0, min: 0 },

    // Inactive accounts stay for historical rows but are not offered as a target.
    active: { type: Boolean, default: true },

    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model('AmazonBuyerAccount', AmazonBuyerAccountSchema);

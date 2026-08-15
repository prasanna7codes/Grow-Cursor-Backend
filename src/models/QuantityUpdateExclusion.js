import mongoose from 'mongoose';

/**
 * eBay ItemIDs whose listing quantity must NOT be reset to 1 when an order
 * arrives. Managed from the "Quantity Update Exclusions" admin page so new IDs
 * can be added without a code change / redeploy.
 */
const QuantityUpdateExclusionSchema = new mongoose.Schema(
  {
    itemId: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    note: {
      type: String,
      trim: true,
      default: ''
    },
    // 'seed' for the IDs imported from the old hard-coded list, 'manual' for
    // anything added through the UI.
    source: {
      type: String,
      enum: ['seed', 'manual'],
      default: 'manual'
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    createdByName: {
      type: String,
      default: ''
    }
  },
  { timestamps: true }
);

export default mongoose.model('QuantityUpdateExclusion', QuantityUpdateExclusionSchema);

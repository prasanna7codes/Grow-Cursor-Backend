import mongoose from 'mongoose';

const asinDirectorySchema = new mongoose.Schema({
  asin: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
    minlength: 10,
    maxlength: 10,
    validate: {
      validator: function(v) {
        return /^B[0-9A-Z]{9}$/.test(v);
      },
      message: props => `${props.value} is not a valid ASIN format!`
    }
  },
  addedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes
asinDirectorySchema.index({ addedAt: -1 });

export default mongoose.model('AsinDirectory', asinDirectorySchema);

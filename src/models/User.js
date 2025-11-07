import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    passwordHash: { type: String, required: true },
  role: { type: String, enum: ['superadmin', 'productadmin', 'listingadmin', 'lister', 'compatibilityadmin', 'compatibilityeditor'], required: true },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export default mongoose.model('User', UserSchema);



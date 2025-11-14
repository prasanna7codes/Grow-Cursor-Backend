import mongoose from 'mongoose';

const EmployeeProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
    name: { type: String, trim: true },
    phoneNumber: { type: String, trim: true },
    dateOfBirth: { type: Date },
    dateOfJoining: { type: Date },
    gender: { type: String, enum: ['male', 'female', 'other', 'prefer_not_to_say'], trim: true },
    address: { type: String, trim: true },
    email: { type: String, trim: true },
    bankAccountNumber: { type: String, trim: true },
    bankIFSC: { type: String, trim: true },
    bankName: { type: String, trim: true },
    workingMode: { type: String, enum: ['remote', 'office', 'hybrid'], trim: true },
    workingHours: { type: String, trim: true },
    aadharNumber: { type: String, trim: true },
    panNumber: { type: String, trim: true },
    // File URLs for profile photo and documents (all images now)
    profilePicUrl: { type: String },
    aadharImageUrl: { type: String },
    panImageUrl: { type: String }
  },
  { timestamps: true }
);

export default mongoose.model('EmployeeProfile', EmployeeProfileSchema);

import mongoose from 'mongoose';

const AnnouncementSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ['company-wide', 'individual'],
            required: true,
            index: true
        },
        title: {
            type: String,
            required: true,
            trim: true
        },
        message: {
            type: String,
            required: true
        },
        priority: {
            type: String,
            enum: ['normal', 'important', 'urgent'],
            default: 'normal'
        },
        createdBy: {
            type: String,
            required: true
        },
        createdByUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        targetUsers: {
            type: [String],
            default: [],
            validate: {
                validator: function (v) {
                    // For individual announcements, targetUsers must not be empty
                    if (this.type === 'individual') {
                        return v && v.length > 0;
                    }
                    return true;
                },
                message: 'Individual announcements must have at least one target user'
            }
        },
        expiresAt: {
            type: Date,
            required: false
        },
        active: {
            type: Boolean,
            default: true
        }
    },
    { timestamps: true }
);

// Indexes for efficient querying
AnnouncementSchema.index({ type: 1, createdAt: -1 });
AnnouncementSchema.index({ targetUsers: 1 });
AnnouncementSchema.index({ active: 1, createdAt: -1 });
AnnouncementSchema.index({ expiresAt: 1 });

// Virtual to check if announcement is expired
AnnouncementSchema.virtual('isExpired').get(function () {
    if (!this.expiresAt) return false;
    return new Date() > this.expiresAt;
});

// Method to check if user can view this announcement
AnnouncementSchema.methods.canViewBy = function (username) {
    if (!this.active) return false;
    if (this.isExpired) return false;

    if (this.type === 'company-wide') return true;
    if (this.type === 'individual') {
        return this.targetUsers.includes(username);
    }
    return false;
};

export default mongoose.model('Announcement', AnnouncementSchema);

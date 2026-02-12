import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Announcement from '../models/Announcement.js';
import User from '../models/User.js';
import { sendAnnouncementEmail } from '../lib/email.js';

const router = express.Router();

// Admin roles that can create announcements
const ADMIN_ROLES = [
    'superadmin',
    'productadmin',
    'listingadmin',
    'compatibilityadmin',
    'fulfillmentadmin',
    'hradmin',
    'operationhead',
    'hoc',
    'compliancemanager'
];

// Subset of admin roles that are per-department admins
const DEPARTMENT_ADMIN_ROLES = [
    'productadmin',
    'listingadmin',
    'compatibilityadmin',
    'fulfillmentadmin',
    'compliancemanager'
];

// Reuse shared auth middleware
// `requireAuth` populates `req.user`; `requireRole(...roles)` enforces allowed roles
const requireAdmin = requireRole(...ADMIN_ROLES);

// GET /api/announcements - Get announcements visible to the current user
router.get('/', requireAuth, async (req, res) => {
    try {
        const { page = 1, limit = 20, type } = req.query;
        const username = req.user.username;
        const userRole = req.user.role;

        // Build query for announcements visible to this user
        // Rules:
        // 1. Company-wide announcements: visible to everyone
        // 2. Individual announcements: visible to:
        //    - Target users
        //    - hradmin (can see all individual announcements)
        //    - The creator of the announcement

        const query = {
            active: true
        };

        // Build visibility conditions
        const visibilityConditions = [
            { type: 'company-wide' } // Everyone sees company-wide
        ];

        // Individual announcements visibility
        const individualConditions = [];

        // Target users can see their individual announcements
        individualConditions.push({ type: 'individual', targetUsers: username });

        // hradmin can see all individual announcements
        if (userRole === 'hradmin') {
            individualConditions.push({ type: 'individual' });
        }

        // Creators can see the individual announcements they created
        individualConditions.push({ type: 'individual', createdBy: username });

        // Combine individual conditions with OR
        if (individualConditions.length > 0) {
            visibilityConditions.push({ $or: individualConditions });
        }

        query.$or = visibilityConditions;

        // Add type filter if specified
        if (type && ['company-wide', 'individual'].includes(type)) {
            // Keep the visibility rules but filter by type
            if (type === 'company-wide') {
                query.$or = [{ type: 'company-wide' }];
            } else {
                // For individual, still apply visibility rules
                query.$or = individualConditions.length > 0 ? individualConditions : [{ type: 'individual', targetUsers: username }];
            }
        }

        // Filter out expired announcements
        query.$and = [
            {
                $or: [
                    { expiresAt: { $exists: false } },
                    { expiresAt: null },
                    { expiresAt: { $gt: new Date() } }
                ]
            }
        ];

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const announcements = await Announcement.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .skip(skip)
            .populate('createdByUserId', 'username department role')
            .lean();

        const total = await Announcement.countDocuments(query);

        res.json({
            announcements,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit)),
            limit: parseInt(limit)
        });
    } catch (err) {
        console.error('Error fetching announcements:', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper: check if a user is a department admin
function isDepartmentAdminRole(role) {
    return DEPARTMENT_ADMIN_ROLES.includes(role);
}

// Helper: determine if req.user can manage (edit/delete) an announcement
async function canManageAnnouncement(reqUser, announcement) {
    if (!reqUser || !announcement) return false;

    // superadmin can do everything
    if (reqUser.role === 'superadmin') return true;

    // Creator can manage
    if (announcement.createdBy === reqUser.username) return true;

    // Department admins can manage announcements created by users in their department
    if (isDepartmentAdminRole(reqUser.role)) {
        try {
            const creator = await User.findById(announcement.createdByUserId).select('department username');
            if (creator && creator.department && reqUser.department && creator.department === reqUser.department) {
                return true;
            }
        } catch (e) {
            console.error('Failed to fetch creator for permission check', e);
        }
    }

    return false;
}

// PATCH /api/announcements/:id - Update announcement
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const announcement = await Announcement.findById(req.params.id);

        if (!announcement) {
            return res.status(404).json({ error: 'Announcement not found' });
        }

        // Permission check
        const allowed = await canManageAnnouncement(req.user, announcement);
        if (!allowed) {
            return res.status(403).json({ error: 'Only creator, superadmin, or department admin of the same department can edit this announcement' });
        }

        // Require full payload for updates: title, message, priority, expiresAt (and targetUsers for individual)
        const { title, message, priority, targetUsers, expiresAt, active } = req.body;

        if (!title || !message) return res.status(400).json({ error: 'Title and message are required for update' });
        if (!priority || !['normal', 'important', 'urgent'].includes(priority)) return res.status(400).json({ error: 'Priority is required and must be one of normal, important, urgent' });
        if (!expiresAt) return res.status(400).json({ error: 'expiresAt is required for update' });
        const expiresDate = new Date(expiresAt);
        if (isNaN(expiresDate.getTime())) return res.status(400).json({ error: 'expiresAt must be a valid date string' });

        announcement.title = title;
        announcement.message = message;
        announcement.priority = priority;
        if (typeof active === 'boolean') announcement.active = active;

        if (announcement.type === 'individual') {
            if (!targetUsers || !Array.isArray(targetUsers) || targetUsers.length === 0) {
                return res.status(400).json({ error: 'Individual announcements must have at least one target user' });
            }
            const users = await User.find({ username: { $in: targetUsers } });
            const foundUsernames = users.map(u => u.username);
            const invalidUsers = targetUsers.filter(u => !foundUsernames.includes(u));
            if (invalidUsers.length > 0) {
                return res.status(400).json({ error: `Invalid users: ${invalidUsers.join(', ')}` });
            }
            announcement.targetUsers = targetUsers;
        } else {
            announcement.targetUsers = [];
        }

        announcement.expiresAt = expiresDate;

        await announcement.save();

        res.json(announcement);
    } catch (err) {
        console.error('Error updating announcement:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/announcements - Create new announcement
router.post('/', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { type, title, message, priority, targetUsers, expiresAt } = req.body;

        // Validation
        if (!type || !['company-wide', 'individual'].includes(type)) {
            return res.status(400).json({
                error: 'Invalid announcement type. Must be "company-wide" or "individual"'
            });
        }

        if (!title || !message) {
            return res.status(400).json({
                error: 'Title and message are required'
            });
        }

        // Priority required
        if (!priority || !['normal', 'important', 'urgent'].includes(priority)) {
            return res.status(400).json({ error: 'Priority is required and must be one of normal, important, urgent' });
        }

        // ExpiresAt required and must be a valid future date (or at least a valid date)
        if (!expiresAt) {
            return res.status(400).json({ error: 'expiresAt is required' });
        }
        const expiresDate = new Date(expiresAt);
        if (isNaN(expiresDate.getTime())) {
            return res.status(400).json({ error: 'expiresAt must be a valid date string' });
        }

        if (type === 'individual' && (!targetUsers || targetUsers.length === 0)) {
            return res.status(400).json({
                error: 'Individual announcements must have at least one target user'
            });
        }

        // Verify target users exist (if individual announcement)
        if (type === 'individual') {
            const users = await User.find({ username: { $in: targetUsers } });
            const foundUsernames = users.map(u => u.username);
            const invalidUsers = targetUsers.filter(u => !foundUsernames.includes(u));

            if (invalidUsers.length > 0) {
                return res.status(400).json({
                    error: `Invalid users: ${invalidUsers.join(', ')}`
                });
            }
        }

        // Create announcement
        const announcement = await Announcement.create({
            type,
            title,
            message,
            priority: priority,
            createdBy: req.user.username,
            createdByUserId: req.user.userId,
            targetUsers: type === 'individual' ? targetUsers : [],
            expiresAt: expiresDate
        });

        // Send email notifications
        try {
            let recipients = [];
            if (type === 'company-wide') {
                // Get all users with email
                const users = await User.find({ email: { $exists: true, $ne: null } }).select('email');
                recipients = users.map(u => u.email);
            } else if (type === 'individual' && targetUsers && targetUsers.length > 0) {
                // Get target users' emails
                const users = await User.find({ username: { $in: targetUsers } }).select('email');
                recipients = users.map(u => u.email);
            }

            if (recipients.length > 0) {
                // Send asynchronously without blocking response
                sendAnnouncementEmail(announcement, recipients).catch(console.error);
            }
        } catch (emailErr) {
            console.error('Failed to prepare email recipients:', emailErr);
        }

        res.status(201).json(announcement);
    } catch (err) {
        console.error('Error creating announcement:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/announcements/:id - Delete announcement
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const announcement = await Announcement.findById(req.params.id);

        if (!announcement) {
            return res.status(404).json({ error: 'Announcement not found' });
        }

        // Permission check (creator, superadmin, or department admin of same department)
        const allowed = await canManageAnnouncement(req.user, announcement);
        if (!allowed) {
            return res.status(403).json({
                error: 'Only the creator, superadmin, or department admin of the same department can delete this announcement'
            });
        }

        await Announcement.findByIdAndDelete(req.params.id);
        res.json({ message: 'Announcement deleted successfully' });
    } catch (err) {
        console.error('Error deleting announcement:', err);
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/announcements/:id/deactivate - Soft delete (deactivate)
router.patch('/:id/deactivate', requireAuth, requireAdmin, async (req, res) => {
    try {
        const announcement = await Announcement.findById(req.params.id);

        if (!announcement) {
            return res.status(404).json({ error: 'Announcement not found' });
        }

        // Permission check (creator, superadmin, or department admin of same department)
        const allowed = await canManageAnnouncement(req.user, announcement);
        if (!allowed) {
            return res.status(403).json({
                error: 'Only the creator, superadmin, or department admin of the same department can deactivate this announcement'
            });
        }

        announcement.active = false;
        await announcement.save();

        res.json({ message: 'Announcement deactivated successfully', announcement });
    } catch (err) {
        console.error('Error deactivating announcement:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;

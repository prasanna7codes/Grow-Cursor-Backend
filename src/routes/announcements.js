import express from 'express';
import jwt from 'jsonwebtoken';
import Announcement from '../models/Announcement.js';
import User from '../models/User.js';

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

// Middleware to verify JWT and extract user
const authenticateUser = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'No authorization token provided' });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// Middleware to check if user is admin
const requireAdmin = (req, res, next) => {
    if (!req.user || !ADMIN_ROLES.includes(req.user.role)) {
        return res.status(403).json({
            error: 'Access denied. Only administrators can perform this action.'
        });
    }
    next();
};

// GET /api/announcements - Get announcements visible to the current user
router.get('/', authenticateUser, async (req, res) => {
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

// POST /api/announcements - Create new announcement
router.post('/', authenticateUser, requireAdmin, async (req, res) => {
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
            priority: priority || 'normal',
            createdBy: req.user.username,
            createdByUserId: req.user.userId,
            targetUsers: type === 'individual' ? targetUsers : [],
            expiresAt: expiresAt || null
        });

        res.status(201).json(announcement);
    } catch (err) {
        console.error('Error creating announcement:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/announcements/:id - Delete announcement
router.delete('/:id', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const announcement = await Announcement.findById(req.params.id);

        if (!announcement) {
            return res.status(404).json({ error: 'Announcement not found' });
        }

        // Only the creator or superadmin can delete
        if (req.user.role !== 'superadmin' &&
            announcement.createdBy !== req.user.username) {
            return res.status(403).json({
                error: 'Only the creator or superadmin can delete this announcement'
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
router.patch('/:id/deactivate', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const announcement = await Announcement.findById(req.params.id);

        if (!announcement) {
            return res.status(404).json({ error: 'Announcement not found' });
        }

        // Only the creator or superadmin can deactivate
        if (req.user.role !== 'superadmin' &&
            announcement.createdBy !== req.user.username) {
            return res.status(403).json({
                error: 'Only the creator or superadmin can deactivate this announcement'
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

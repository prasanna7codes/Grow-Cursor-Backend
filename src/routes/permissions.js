import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import User from '../models/User.js';
import {
    PERMISSIONS,
    PERMISSION_LABELS,
    PERMISSION_GROUPS,
    DEFAULT_ROLE_PERMISSIONS
} from '../constants/permissionConstants.js';

const router = Router();

/**
 * GET /api/permissions/available
 * Returns the full permission catalog (groups, labels, etc.) for the UI.
 * Superadmin only.
 */
router.get('/available', requireAuth, requireRole('superadmin'), (req, res) => {
    res.json({
        permissions: PERMISSIONS,
        labels: PERMISSION_LABELS,
        groups: PERMISSION_GROUPS,
    });
});

/**
 * GET /api/permissions/all-users
 * List all users (excluding superadmin) with their current permissions.
 * Superadmin only.
 */
router.get('/all-users', requireAuth, requireRole('superadmin'), async (req, res) => {
    try {
        const users = await User.find({ role: { $ne: 'superadmin' }, active: true })
            .select('username email role permissions department')
            .sort({ role: 1, username: 1 })
            .lean();
        res.json(users);
    } catch (error) {
        console.error('Error fetching users for permissions:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

/**
 * PUT /api/permissions/:userId
 * Update a user's permissions array.
 * Superadmin only.
 */
router.put('/:userId', requireAuth, requireRole('superadmin'), async (req, res) => {
    try {
        const { userId } = req.params;
        const { permissions } = req.body;

        if (!Array.isArray(permissions)) {
            return res.status(400).json({ error: 'permissions must be an array' });
        }

        // Validate all permission values
        const validPermissions = Object.values(PERMISSIONS);
        const invalidPerms = permissions.filter(p => !validPermissions.includes(p));
        if (invalidPerms.length > 0) {
            return res.status(400).json({ error: `Invalid permissions: ${invalidPerms.join(', ')}` });
        }

        const user = await User.findByIdAndUpdate(
            userId,
            { permissions },
            { new: true, select: 'username email role permissions' }
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            message: `Permissions updated for ${user.username}`,
            user
        });
    } catch (error) {
        console.error('Error updating permissions:', error);
        res.status(500).json({ error: 'Failed to update permissions' });
    }
});

/**
 * POST /api/permissions/migrate
 * One-time migration: populate all users' permissions based on their current role defaults.
 * Superadmin only.
 */
router.post('/migrate', requireAuth, requireRole('superadmin'), async (req, res) => {
    try {
        const users = await User.find({ role: { $ne: 'superadmin' } });
        let updatedCount = 0;

        for (const user of users) {
            const defaultPerms = DEFAULT_ROLE_PERMISSIONS[user.role] || [];
            // Only set if user doesn't already have permissions assigned
            if (!user.permissions || user.permissions.length === 0) {
                user.permissions = defaultPerms;
                await user.save();
                updatedCount++;
            }
        }

        res.json({
            message: `Migration complete. Updated ${updatedCount} out of ${users.length} users.`,
            updatedCount,
            totalUsers: users.length
        });
    } catch (error) {
        console.error('Error during permission migration:', error);
        res.status(500).json({ error: 'Failed to migrate permissions' });
    }
});

export default router;

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createUserSchema } from '../schemas/index.js';
import User from '../models/User.js';
import Seller from '../models/Seller.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import Attendance from '../models/Attendance.js';
import PageAccessAuditLog from '../models/PageAccessAuditLog.js';
import {
  buildPermissionSnapshot,
  createPageAccessAuditLog,
  diffPermissionSnapshots,
  getRequestMetadata,
  normalizePagePermissions,
} from '../lib/pageAccessAudit.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: User account management
 */

// Superadmin creates all (productadmin, listingadmin, lister); Listing Admin creates listers only
/**
 * @swagger
 * /users:
 *   post:
 *     tags: [Users]
 *     summary: Create a new user account
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Creates a new user and an associated EmployeeProfile.
 *       If the new user's role is `seller`, a Seller document is also created.
 *       Role-based creation rules are enforced:
 *       - Listers/productadmin/compatibilityeditor cannot create users.
 *       - listingadmin can only create listers.
 *       - compatibilityadmin can only create compatibilityeditors.
 *       - Only superadmin/hradmin/operationhead can create admin-level roles.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password, newUserRole]
 *             properties:
 *               username: { type: string, example: jane_lister }
 *               password: { type: string, format: password }
 *               email: { type: string, format: email }
 *               newUserRole:
 *                 type: string
 *                 enum: [productadmin, listingadmin, lister, advancelister, compatibilityadmin,
 *                   compatibilityeditor, seller, fulfillmentadmin, hradmin, hr,
 *                   operationhead, trainee, hoc, compliancemanager]
 *               department: { type: string, example: Listing }
 *     responses:
 *       200:
 *         description: User created — returns id, email, username, role
 *       400:
 *         description: Missing fields or invalid role
 *       403:
 *         description: Caller role not permitted to create this user role
 *       409:
 *         description: Email or username already in use
 */
router.post('/', requireAuth, validate(createUserSchema), async (req, res) => {
  const { role } = req.user;
  const { email, username, password, newUserRole, department } = req.body || {};
  if (!username || !password || !newUserRole) {
    return res.status(400).json({ error: 'username, password, newUserRole required' });
  }

  // --- FIX IS HERE: Added 'hoc' and 'compliancemanager' ---
  const allowedRoles = [
    'productadmin',
    'listingadmin',
    'lister',
    'advancelister',
    'compatibilityadmin',
    'compatibilityeditor',
    'seller',
    'fulfillmentadmin',
    'hradmin',
    'hr',
    'operationhead',
    'trainee',
    'hoc',
    'compliancemanager'
  ];

  if (!allowedRoles.includes(newUserRole)) return res.status(400).json({ error: 'Invalid newUserRole' });

  // Forbidden base roles (cannot create users)
  if (role === 'lister' || role === 'productadmin' || role === 'compatibilityeditor') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Only superadmin can create high-level admins (productadmin, listingadmin, compatibilityadmin, fulfillmentadmin)
  // Added 'hoc' and 'compliancemanager' to the list of roles that require high privileges
  if (['productadmin', 'listingadmin', 'compatibilityadmin', 'seller', 'fulfillmentadmin', 'hradmin', 'operationhead', 'hoc', 'compliancemanager'].includes(newUserRole) && !['superadmin', 'hradmin', 'operationhead'].includes(role)) {
    return res.status(403).json({ error: 'Only superadmin, hradmin or operationhead can create admin roles or sellers' });
  }

  // Listing admin can only create listers
  if (role === 'listingadmin' && newUserRole !== 'lister') {
    return res.status(403).json({ error: 'Listing Admins can only create listers' });
  }

  // Compatibility admin can only create compatibility editors
  if (role === 'compatibilityadmin' && newUserRole !== 'compatibilityeditor') {
    return res.status(403).json({ error: 'Compatibility Admins can only create compatibility editors' });
  }

  // Check both email and username uniqueness
  if (email) {
    const existingEmail = await User.findOne({ email });
    if (existingEmail) return res.status(409).json({ error: 'Email already in use' });
  }

  const existingUsername = await User.findOne({ username });
  if (existingUsername) return res.status(409).json({ error: 'Username already in use' });
  const passwordHash = await bcrypt.hash(password, 10);

  // Compute department rules
  let finalDepartment = department || '';
  // Listing admins add to Listing department
  if (role === 'listingadmin') finalDepartment = 'Listing';
  // Compatibility admins and creating compatibility editors default to Compatibility
  if (role === 'compatibilityadmin' || newUserRole === 'compatibilityeditor') finalDepartment = 'Compatibility';

  const user = await User.create({
    email,
    username,
    passwordHash,
    role: newUserRole,
    department: finalDepartment,
    isStrictTimer: false
  });

  // Create an EmployeeProfile for the new user so they appear on admin pages immediately
  await EmployeeProfile.create({ user: user._id, email: user.email });

  // If creating a seller, also create a Seller document
  if (newUserRole === 'seller') {
    await Seller.create({ user: user._id, ebayMarketplaces: [] });
  }

  try {
    const actorUser = await User.findById(req.user.userId).select('username email role').lean();
    const afterSnapshot = buildPermissionSnapshot(user);
    await createPageAccessAuditLog({
      actor: actorUser || { id: req.user.userId, username: 'Unknown', role: req.user.role },
      target: user,
      before: null,
      after: afterSnapshot,
      diff: diffPermissionSnapshots(null, afterSnapshot),
      eventType: 'user_created',
      source: 'user_creation',
      sessionInvalidated: false,
      metadata: getRequestMetadata(req),
    });
  } catch (auditError) {
    console.error('Failed to write page access audit log for user creation:', auditError);
  }

  if (['superadmin', 'hradmin', 'operationhead'].includes(role)) {
    // Return user info for superadmin record-keeping (password NOT included — displayed from local state on frontend)
    res.json({
      id: user._id,
      email: user.email,
      username: user.username,
      role: user.role,
      department: user.department
    });
  } else {
    res.json({ id: user._id, email: user.email, username: user.username, role: user.role });
  }
});

/**
 * @swagger
 * /users/listers:
 *   get:
 *     tags: [Users]
 *     summary: List all active listers
 *     security:
 *       - bearerAuth: []
 *     description: Returns active users with role `lister`. **Requires AddUser page access.**
 *     responses:
 *       200:
 *         description: Array of lister users (username, email, role)
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/listers', requireAuth, requirePageAccess('AddUser'), async (req, res) => {
  const listers = await User.find({ role: 'lister', active: true }).select('email username role').lean();
  res.json(listers);
});

// List compatibility editors (for superadmin or compatibilityadmin)
/**
 * @swagger
 * /users/compatibility-editors:
 *   get:
 *     tags: [Users]
 *     summary: List all active compatibility editors
 *     security:
 *       - bearerAuth: []
 *     description: Returns active users with role `compatibilityeditor`. **Requires AddCompatibilityEditor page access.**
 *     responses:
 *       200:
 *         description: Array of compatibility editor users
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/compatibility-editors', requireAuth, requirePageAccess('AddCompatibilityEditor'), async (req, res) => {
  const editors = await User.find({ role: 'compatibilityeditor', active: true }).select('email username role').lean();
  res.json(editors);
});

// Check if email or username already exists (requires auth to prevent user enumeration)
/**
 * @swagger
 * /users/check-exists:
 *   get:
 *     tags: [Users]
 *     summary: Check if a username or email is already taken
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Returns `{ exists: boolean }`. Auth required to prevent unauthenticated user enumeration.
 *     parameters:
 *       - in: query
 *         name: email
 *         schema: { type: string }
 *         description: Email to check (provide either email or username, not both)
 *       - in: query
 *         name: username
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Returns an object with a single boolean field indicating whether the value is taken
 *       401: { description: Unauthorized }
 */
router.get('/check-exists', requireAuth, async (req, res) => {
  const { email, username } = req.query;
  try {
    let exists = false;
    if (email) {
      const user = await User.findOne({ email });
      exists = !!user;
    } else if (username) {
      const user = await User.findOne({ username });
      exists = !!user;
    }
    res.json({ exists });
  } catch (e) {
    res.status(500).json({ error: 'Error checking existence' });
  }
});

// GET / - fetch all active users
/**
 * @swagger
 * /users:
 *   get:
 *     tags: [Users]
 *     summary: List all active users
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Returns all users where active is true with username, email, role, department, and page permission fields.
 *     responses:
 *       200:
 *         description: Array of user objects
 *       401: { description: Unauthorized }
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const users = await User.find({ active: true }).select('username email role department pagePermissions useCustomPermissions').lean();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// GET /page-access-audit-logs - Fetch page access audit history
/**
 * @swagger
 * /users/page-access-audit-logs:
 *   get:
 *     tags: [Users]
 *     summary: Fetch page access audit history
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Paginated log of all page permission changes across all users.
 *       Supports filtering by actor, target user, page ID, event type, and date range.
 *       **Requires PageAccessAuditLog page access.**
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, default: 50, maximum: 100 } }
 *       - { in: query, name: targetUserId, schema: { type: string }, description: Filter by target user ObjectId }
 *       - { in: query, name: actorUserId, schema: { type: string }, description: Filter by actor user ObjectId }
 *       - { in: query, name: pageId, schema: { type: string }, description: Filter by specific page ID }
 *       - { in: query, name: eventType, schema: { type: string, default: all }, description: "all | user_created | page_permissions_updated" }
 *       - { in: query, name: effectiveChangesOnly, schema: { type: string, enum: ['true','false'], default: 'false' } }
 *       - { in: query, name: fromDate, schema: { type: string, format: date-time } }
 *       - { in: query, name: toDate, schema: { type: string, format: date-time } }
 *     responses:
 *       200:
 *         description: Paginated audit log
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 logs: { type: array, items: { type: object } }
 *                 total: { type: integer }
 *                 page: { type: integer }
 *                 totalPages: { type: integer }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/page-access-audit-logs', requireAuth, requirePageAccess('PageAccessAuditLog'), async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      targetUserId,
      actorUserId,
      pageId,
      eventType = 'all',
      effectiveChangesOnly = 'false',
      fromDate,
      toDate,
    } = req.query;

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const skip = (safePage - 1) * safeLimit;
    const query = {};

    if (targetUserId) {
      query['target.id'] = targetUserId;
    }

    if (actorUserId) {
      query['actor.id'] = actorUserId;
    }

    if (pageId) {
      query.affectedPageIds = pageId;
    }

    if (eventType && eventType !== 'all') {
      query.eventType = eventType;
    }

    if (effectiveChangesOnly === 'true') {
      query.effectiveAccessChanged = true;
    }

    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) {
        query.createdAt.$gte = new Date(fromDate);
      }
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const [logs, total] = await Promise.all([
      PageAccessAuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      PageAccessAuditLog.countDocuments(query),
    ]);

    res.json({
      logs,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    });
  } catch (err) {
    console.error('Error fetching page access audit logs:', err);
    res.status(500).json({ error: 'Failed to fetch page access audit logs' });
  }
});

// PUT /:id/strict-timer - Toggle strict timer for a user (Superadmin only)
/**
 * @swagger
 * /users/{id}/strict-timer:
 *   put:
 *     tags: [Users]
 *     summary: Enable or disable strict timer for a user
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Toggles `isStrictTimer` on the user. If disabling, any active timer session
 *       for that user is automatically stopped. **Requires Attendance page access.**
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isStrictTimer]
 *             properties:
 *               isStrictTimer: { type: boolean }
 *     responses:
 *       200:
 *         description: Timer setting updated
 *       400:
 *         description: isStrictTimer must be a boolean
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: User not found }
 */
router.put('/:id/strict-timer', requireAuth, requirePageAccess('Attendance'), async (req, res) => {
  try {
    const { id } = req.params;
    const { isStrictTimer } = req.body;

    if (typeof isStrictTimer !== 'boolean') {
      return res.status(400).json({ error: 'isStrictTimer must be a boolean' });
    }

    // New logic: If disabling strict timer, stop any active timer for this user
    if (isStrictTimer === false) {
      const activeAttendance = await Attendance.findOne({ user: id, status: 'active' });

      if (activeAttendance) {
        if (activeAttendance.sessions.length > 0) {
          const lastSession = activeAttendance.sessions[activeAttendance.sessions.length - 1];
          if (!lastSession.endTime) {
            lastSession.endTime = new Date();
          }
        }
        activeAttendance.status = 'completed'; // Changed from 'stopped' to 'completed' to match enum
        activeAttendance.calculateTotalWorkTime();
        await activeAttendance.save();
        console.log(`Auto-stopped timer for user ${id} because strict timer was disabled`);
      }
    }

    const user = await User.findByIdAndUpdate(
      id,
      { isStrictTimer },
      { new: true, select: 'username email role isStrictTimer' }
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: `Strict timer ${isStrictTimer ? 'enabled' : 'disabled'} for ${user.username}`,
      user
    });
  } catch (error) {
    console.error('Error updating strict timer:', error);
    res.status(500).json({ error: 'Failed to update strict timer setting' });
  }
});

// ============================================
// PAGE ACCESS MANAGEMENT (Superadmin only)
// ============================================

// GET /:id/page-permissions - Get a user's page permissions
/**
 * @swagger
 * /users/{id}/page-permissions:
 *   get:
 *     tags: [Users]
 *     summary: Get a user's page permissions
 *     security:
 *       - bearerAuth: []
 *     description: Returns the user's `pagePermissions`, `useCustomPermissions`, and role. **Requires PageAccessManagement page access.**
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: User permission details
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: User not found }
 */
router.get('/:id/page-permissions', requireAuth, requirePageAccess('PageAccessManagement'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('username role pagePermissions useCustomPermissions');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      userId: user._id,
      username: user.username,
      role: user.role,
      pagePermissions: user.pagePermissions || [],
      useCustomPermissions: user.useCustomPermissions || false
    });
  } catch (err) {
    console.error('Error fetching page permissions:', err);
    res.status(500).json({ error: 'Failed to fetch page permissions' });
  }
});

// PUT /:id/page-permissions - Set a user's page permissions
/**
 * @swagger
 * /users/{id}/page-permissions:
 *   put:
 *     tags: [Users]
 *     summary: Update a user's page permissions
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Updates `pagePermissions` and `useCustomPermissions` for a user.
 *       If effective access changes, increments `permissionsVersion` to invalidate active sessions.
 *       All changes are recorded in the PageAccessAuditLog.
 *       **Requires PageAccessManagement page access.**
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pagePermissions, useCustomPermissions]
 *             properties:
 *               pagePermissions:
 *                 type: array
 *                 items: { type: string }
 *                 description: Array of page ID strings
 *               useCustomPermissions: { type: boolean }
 *     responses:
 *       200:
 *         description: Permissions updated (or no-op if unchanged)
 *       400:
 *         description: Invalid input
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: User not found }
 */
router.put('/:id/page-permissions', requireAuth, requirePageAccess('PageAccessManagement'), async (req, res) => {
  try {
    const { pagePermissions, useCustomPermissions } = req.body;

    if (!Array.isArray(pagePermissions)) {
      return res.status(400).json({ error: 'pagePermissions must be an array of page IDs' });
    }
    if (typeof useCustomPermissions !== 'boolean') {
      return res.status(400).json({ error: 'useCustomPermissions must be a boolean' });
    }

    const normalizedPagePermissions = normalizePagePermissions(pagePermissions);

    const [currentUser, actorUser] = await Promise.all([
      User.findById(req.params.id).select('username email role pagePermissions useCustomPermissions permissionsVersion'),
      User.findById(req.user.userId).select('username email role').lean(),
    ]);

    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const beforeSnapshot = buildPermissionSnapshot(currentUser);
    const provisionalAfterSnapshot = buildPermissionSnapshot({
      role: currentUser.role,
      pagePermissions: normalizedPagePermissions,
      useCustomPermissions,
      permissionsVersion: beforeSnapshot.permissionsVersion,
    });

    let diff = diffPermissionSnapshots(beforeSnapshot, provisionalAfterSnapshot);

    if (!diff.configurationChanged) {
      return res.json({
        message: `No permission changes detected for ${currentUser.username}`,
        userId: currentUser._id,
        username: currentUser.username,
        role: currentUser.role,
        pagePermissions: beforeSnapshot.pagePermissions,
        useCustomPermissions: beforeSnapshot.useCustomPermissions,
        permissionsVersion: beforeSnapshot.permissionsVersion,
        effectiveAccessChanged: false,
      });
    }

    const nextPermissionsVersion = beforeSnapshot.permissionsVersion + (diff.effectiveAccessChanged ? 1 : 0);
    const afterSnapshot = buildPermissionSnapshot({
      role: currentUser.role,
      pagePermissions: normalizedPagePermissions,
      useCustomPermissions,
      permissionsVersion: nextPermissionsVersion,
    });

    diff = diffPermissionSnapshots(beforeSnapshot, afterSnapshot);

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { 
        pagePermissions: afterSnapshot.pagePermissions,
        useCustomPermissions: afterSnapshot.useCustomPermissions,
        permissionsVersion: afterSnapshot.permissionsVersion,
      },
      { new: true, select: 'username email role pagePermissions useCustomPermissions permissionsVersion' }
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    try {
      await createPageAccessAuditLog({
        actor: actorUser || { id: req.user.userId, username: 'Unknown', role: req.user.role },
        target: user,
        before: beforeSnapshot,
        after: afterSnapshot,
        diff,
        eventType: 'page_permissions_updated',
        source: 'page_access_management',
        sessionInvalidated: diff.effectiveAccessChanged,
        metadata: getRequestMetadata(req),
      });
    } catch (auditError) {
      console.error('Failed to write page access audit log for permission update:', auditError);
    }

    res.json({
      message: `Page permissions updated for ${user.username}`,
      userId: user._id,
      username: user.username,
      role: user.role,
      pagePermissions: user.pagePermissions,
      useCustomPermissions: user.useCustomPermissions,
      permissionsVersion: user.permissionsVersion,
      effectiveAccessChanged: diff.effectiveAccessChanged,
      useCustomPermissionsChanged: diff.useCustomPermissionsChanged,
      addedStoredPermissions: diff.addedStoredPermissions,
      removedStoredPermissions: diff.removedStoredPermissions,
      grantedEffectivePermissions: diff.grantedEffectivePermissions,
      revokedEffectivePermissions: diff.revokedEffectivePermissions,
    });
  } catch (err) {
    console.error('Error updating page permissions:', err);
    res.status(500).json({ error: 'Failed to update page permissions' });
  }
});

// ============================================
// PASSWORD MANAGEMENT (Superadmin only)
// ============================================

// PUT /:id/password - Change a user's password (Superadmin only)
/**
 * @swagger
 * /users/{id}/password:
 *   put:
 *     tags: [Users]
 *     summary: Change a user's password (admin)
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Hashes the new password and increments `tokenVersion` to invalidate all
 *       existing sessions for that user. **Requires UserPasswordManagement page access.**
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [newPassword]
 *             properties:
 *               newPassword: { type: string, minLength: 6, format: password }
 *     responses:
 *       200:
 *         description: Password updated and all sessions invalidated
 *       400:
 *         description: newPassword missing or too short
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: User not found }
 */
router.put('/:id/password', requireAuth, requirePageAccess('UserPasswordManagement'), async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'newPassword is required and must be a string' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const user = await User.findById(req.params.id).select('username email role');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Hash the new password
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update the password AND increment tokenVersion to invalidate all existing sessions
    const currentUser = await User.findById(req.params.id).select('tokenVersion');
    const newTokenVersion = (currentUser.tokenVersion || 1) + 1;
    
    await User.findByIdAndUpdate(req.params.id, { 
      passwordHash,
      tokenVersion: newTokenVersion 
    });

    res.json({
      message: `Password updated successfully for ${user.username}`,
      userId: user._id,
      username: user.username
    });
  } catch (err) {
    console.error('Error changing user password:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

export default router;

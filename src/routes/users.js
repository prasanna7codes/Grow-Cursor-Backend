import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth, requireRole } from '../middleware/auth.js';
import User from '../models/User.js';
import Seller from '../models/Seller.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import Attendance from '../models/Attendance.js';

const router = Router();

// Superadmin creates all (productadmin, listingadmin, lister); Listing Admin creates listers only
router.post('/', requireAuth, async (req, res) => {
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

  // Set isStrictTimer to false for superadmin, true for all others
  const isStrictTimer = newUserRole !== 'superadmin';

  const user = await User.create({
    email,
    username,
    passwordHash,
    role: newUserRole,
    department: finalDepartment,
    isStrictTimer
  });

  // Create an EmployeeProfile for the new user so they appear on admin pages immediately
  await EmployeeProfile.create({ user: user._id, email: user.email });

  // If creating a seller, also create a Seller document
  if (newUserRole === 'seller') {
    await Seller.create({ user: user._id, ebayMarketplaces: [] });
  }

  if (['superadmin', 'hradmin', 'operationhead'].includes(role)) {
    // Return credentials for superadmin record-keeping
    res.json({
      id: user._id,
      email: user.email,
      username: user.username,
      role: user.role,
      credentials: {
        email: user.email,
        username: user.username,
        password: password,
        role: user.role,
        createdAt: new Date()
      }
    });
  } else {
    res.json({ id: user._id, email: user.email, username: user.username, role: user.role });
  }
});

router.get('/listers', requireAuth, requireRole('superadmin', 'listingadmin'), async (req, res) => {
  const listers = await User.find({ role: 'lister', active: true }).select('email username role');
  res.json(listers);
});

// List compatibility editors (for superadmin or compatibilityadmin)
router.get('/compatibility-editors', requireAuth, requireRole('superadmin', 'compatibilityadmin'), async (req, res) => {
  const editors = await User.find({ role: 'compatibilityeditor', active: true }).select('email username role');
  res.json(editors);
});

// Get all active users (for announcements and other features)
router.get('/', requireAuth, async (req, res) => {
  try {
    const users = await User.find({ active: true })
      .select('username email role department')
      .sort({ username: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Check if email or username already exists
router.get('/check-exists', async (req, res) => {
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
router.get('/', requireAuth, async (req, res) => {
  try {
    const users = await User.find({ active: true }).select('username email role department');
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// PUT /:id/strict-timer - Toggle strict timer for a user (Superadmin only)
router.put('/:id/strict-timer', requireAuth, requireRole('superadmin'), async (req, res) => {
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

export default router;
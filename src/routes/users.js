import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth, requireRole } from '../middleware/auth.js';
import User from '../models/User.js';

const router = Router();

// Superadmin creates all (productadmin, listingadmin, lister); Listing Admin creates listers only
router.post('/', requireAuth, async (req, res) => {
  const { role } = req.user;
  const { email, username, password, newUserRole } = req.body || {};
  if (!email || !username || !password || !newUserRole) {
    return res.status(400).json({ error: 'email, username, password, newUserRole required' });
  }
  const allowedRoles = ['productadmin', 'listingadmin', 'lister', 'compatibilityadmin', 'compatibilityeditor'];
  if (!allowedRoles.includes(newUserRole)) return res.status(400).json({ error: 'Invalid newUserRole' });

  // Forbidden base roles
  if (role === 'lister' || role === 'productadmin' || role === 'compatibilityeditor') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Only superadmin can create high-level admins (productadmin, listingadmin, compatibilityadmin)
  if (['productadmin', 'listingadmin', 'compatibilityadmin'].includes(newUserRole) && role !== 'superadmin') {
    return res.status(403).json({ error: 'Only superadmin can create admin roles' });
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
  const existingEmail = await User.findOne({ email });
  if (existingEmail) return res.status(409).json({ error: 'Email already in use' });

  const existingUsername = await User.findOne({ username });
  if (existingUsername) return res.status(409).json({ error: 'Username already in use' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, username, passwordHash, role: newUserRole });

  if (role === 'superadmin') {
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

export default router;



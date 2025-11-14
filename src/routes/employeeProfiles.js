import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import EmployeeProfile from '../models/EmployeeProfile.js';

const router = Router();

function pickProfile(body) {
  const allowed = [
    'name',
    'phoneNumber',
    'dateOfBirth',
    'dateOfJoining',
    'gender',
    'address',
    'email',
    'bankAccountNumber',
    'bankIFSC',
    'bankName',
    'aadharNumber',
    'panNumber',
    'profilePicUrl',
    'aadharImageUrl',
    'panImageUrl'
  ];
  const out = {};
  for (const k of allowed) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

// GET /api/employee-profiles/me - fetch my profile (create if not exists)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id || req.user.id;
    let profile = await EmployeeProfile.findOne({ user: userId });
    if (!profile) {
      profile = await EmployeeProfile.create({ user: userId });
    }
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile', details: err.message });
  }
});

// PUT /api/employee-profiles/me - upsert my profile
router.put('/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id || req.user.id;
    const data = pickProfile(req.body || {});
    const profile = await EmployeeProfile.findOneAndUpdate(
      { user: userId },
      { $set: data, $setOnInsert: { user: userId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile', details: err.message });
  }
});

// GET /api/employee-profiles - list all (superadmin, hradmin, operationhead only)
router.get('/', requireAuth, async (req, res) => {
  try {
    if (!['superadmin', 'hradmin', 'operationhead'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const list = await EmployeeProfile.find({}).populate('user', 'username role email department');
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list profiles', details: err.message });
  }
});

// PUT /api/employee-profiles/:id - update user role and department (superadmin only)
router.put('/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { role, department } = req.body;
    const profile = await EmployeeProfile.findById(req.params.id).populate('user');
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    // Import User model
    const User = profile.user.constructor;
    
    // Update user role and department
    if (role !== undefined) profile.user.role = role;
    if (department !== undefined) profile.user.department = department;
    
    await profile.user.save();
    
    // Re-populate and return
    await profile.populate('user', 'username role email department');
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile', details: err.message });
  }
});

// PUT /api/employee-profiles/:id/admin-fields - update workingMode and workingHours (superadmin, hradmin, operationhead only)
router.put('/:id/admin-fields', requireAuth, async (req, res) => {
  try {
    if (!['superadmin', 'hradmin', 'operationhead'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { workingMode, workingHours } = req.body;
    const update = {};
    if (workingMode !== undefined) update.workingMode = workingMode;
    if (workingHours !== undefined) update.workingHours = workingHours;
    
    const profile = await EmployeeProfile.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    ).populate('user', 'username role email department');
    
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update admin fields', details: err.message });
  }
});

export default router;

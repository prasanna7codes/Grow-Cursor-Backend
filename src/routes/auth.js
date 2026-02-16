import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const router = Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = await User.findOne({ username });
  if (!user) return res.status(404).json({ error: 'Username not found' });
  if (!user.active) return res.status(401).json({ error: 'Account is not active' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });
  const token = jwt.sign({
    userId: user._id.toString(),
    username: user.username,
    role: user.role,
    department: user.department
  }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user._id, email: user.email, username: user.username, role: user.role, department: user.department } });
});

// Seed superadmin if none exists (development helper)
router.post('/seed-superadmin', async (req, res) => {
  const { email, username, password } = req.body || {};
  if (!email || !username || !password) return res.status(400).json({ error: 'email, username, password required' });
  const exists = await User.findOne({ role: 'superadmin' });
  if (exists) return res.status(400).json({ error: 'Superadmin already exists' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, username, passwordHash, role: 'superadmin' });
  res.json({ id: user._id });
});

export default router;



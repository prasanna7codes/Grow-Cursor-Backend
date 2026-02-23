import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // Fallback: check query param for token (e.g., for eBay OAuth redirects)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Load fresh permissions from DB so changes take effect without re-login
    const userDoc = await User.findById(payload.userId).select('permissions role').lean();
    req.user = {
      ...payload,
      permissions: userDoc?.permissions || [],
      role: userDoc?.role || payload.role
    };
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

/**
 * Permission-based middleware.
 * Superadmin always passes. For all other users, checks if the user's
 * permissions array includes at least one of the required permissions.
 */
export function requirePermission(...permissions) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    // Superadmin bypasses all permission checks
    if (req.user.role === 'superadmin') return next();
    const userPerms = req.user.permissions || [];
    const hasPermission = permissions.some(p => userPerms.includes(p));
    if (!hasPermission) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

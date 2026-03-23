import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  // Fallback: check query param for token (e.g., for eBay OAuth redirects)
  if (!token && req.query.token) {
    token = req.query.token;
  }
  
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { userId, role }
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(...roles) {
  return async function (req, res, next) {
    if (!req.user) return res.status(403).json({ error: 'Forbidden' });

    // If the user's role is in the allowed list, allow immediately
    if (roles.includes(req.user.role)) return next();

    // Otherwise, check if the user has ANY pagePermission with 'read' or 'update' access.
    // This allows superadmin-granted overrides to bypass role checks on the backend.
    try {
      const user = await User.findById(req.user.userId).select('pagePermissions').lean();
      if (user && user.pagePermissions && user.pagePermissions.length > 0) {
        const hasOverride = user.pagePermissions.some(
          p => p.accessLevel === 'read' || p.accessLevel === 'update'
        );
        if (hasOverride) return next();
      }
    } catch (err) {
      // If DB lookup fails, fall through to forbidden
    }

    return res.status(403).json({ error: 'Forbidden' });
  };
}

/**
 * requirePageAccess(pageId)
 * A focused middleware that checks if the user has explicit access to a specific page.
 * Use this for new routes where you want page-level permission checking.
 */
export function requirePageAccess(pageId) {
  return async function (req, res, next) {
    if (!req.user) return res.status(403).json({ error: 'Forbidden' });

    // Superadmin always has access
    if (req.user.role === 'superadmin') return next();

    try {
      const user = await User.findById(req.user.userId).select('pagePermissions').lean();
      if (user && user.pagePermissions) {
        const perm = user.pagePermissions.find(p => p.page === pageId);
        if (perm && (perm.accessLevel === 'read' || perm.accessLevel === 'update')) {
          return next();
        }
      }
    } catch (err) {
      // Fall through to forbidden
    }

    return res.status(403).json({ error: 'Forbidden' });
  };
}

import express from 'express';
import Idea from '../models/Idea.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { sendIssueCreatedEmail } from '../lib/email.js';

const router = express.Router();

// Roles that map to a specific department (department admins)
const ROLE_DEPARTMENT_MAP = {
  'hradmin': 'HR',
  'operationhead': 'Operations',
  'listingadmin': 'Listing',
  'productadmin': 'Product Research',
  'compatibilityadmin': 'Compatibility',
  'fulfillmentadmin': 'Operations',
  'hoc': 'Compliance',
  'compliancemanager': 'Compliance'
};

// Roles that can see ALL departments
const SUPER_ROLES = ['superadmin', 'hradmin'];

// All admin-level roles (can change status, delete within their scope)
const ADMIN_ROLES = [
  'superadmin', 'productadmin', 'listingadmin', 'compatibilityadmin', 'fulfillmentadmin',
  'hradmin', 'operationhead', 'hoc', 'compliancemanager'
];

/**
 * Determine the department scope for a user:
 *   - superadmin / hradmin  → null  (means "no restriction, see all")
 *   - other admin roles     → their mapped department
 *   - normal users          → their own username (used to filter createdBy)
 */
function getUserScope(user) {
  if (SUPER_ROLES.includes(user.role)) return { type: 'all' };
  if (ADMIN_ROLES.includes(user.role)) {
    const dept = ROLE_DEPARTMENT_MAP[user.role] || user.department || null;
    return { type: 'department', department: dept };
  }
  return { type: 'own', username: user.username };
}

// Apply auth to all routes
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────
// GET /api/ideas  — list with filters, pagination, role-based visibility
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      status,
      priority,
      type,
      department,   // optional filter (only honored if user has access to that dept)
      source,       // 'ideas' | 'department' — isolates pages from each other
      sortBy = 'createdAt',
      sortOrder = 'desc',
      startDate,
      endDate
    } = req.query;

    const query = {};
    const conditions = []; // all conditions go here, combined as $and at the end

    // ── Source filter — strictly isolates Ideas page from Department Issues page ──
    if (source === 'ideas') {
      // Match records explicitly tagged 'ideas' OR legacy records with no source field
      conditions.push({ $or: [{ source: 'ideas' }, { source: { $exists: false } }] });
    } else if (source === 'department') {
      // Strictly only department-tagged records
      conditions.push({ source: 'department' });
    }
    // If no source param: no restriction (e.g. stats endpoint, internal calls)

    // ── Status / priority / type filters ──
    if (status) conditions.push({ status });
    if (priority) conditions.push({ priority });
    if (type) conditions.push({ type });

    // ── Date filter ──
    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateFilter.$lte = end;
      }
      conditions.push({ createdAt: dateFilter });
    }

    // ── Role-based visibility ──
    const scope = getUserScope(req.user);

    if (scope.type === 'all') {
      // superadmin / hradmin – no visibility restriction
      // But still allow optional department filter from query
      if (department) conditions.push({ department });
    } else if (scope.type === 'department') {
      // Department admins: issues in their dept OR ones they created themselves
      if (scope.department) {
        conditions.push({ $or: [{ department: scope.department }, { createdBy: req.user.username }] });
      } else {
        conditions.push({ createdBy: req.user.username });
      }
    } else {
      // Normal users: only their own issues
      conditions.push({ createdBy: req.user.username });
    }

    // Apply all conditions
    if (conditions.length > 0) {
      query.$and = conditions;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOptions = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const [ideas, total] = await Promise.all([
      Idea.find(query).sort(sortOptions).limit(parseInt(limit)).skip(skip).lean(),
      Idea.countDocuments(query)
    ]);

    res.json({
      ideas,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      limit: parseInt(limit)
    });
  } catch (err) {
    console.error('Error fetching ideas:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/ideas/stats/summary  — aggregate counts (visible to user's scope)
// ─────────────────────────────────────────────────────────────
router.get('/stats/summary', async (req, res) => {
  try {
    const scope = getUserScope(req.user);
    const baseQuery = {};

    if (scope.type === 'department') baseQuery.department = scope.department;
    else if (scope.type === 'own') baseQuery.createdBy = scope.username;

    const [total, open, inProgress, completed, byDepartment] = await Promise.all([
      Idea.countDocuments(baseQuery),
      Idea.countDocuments({ ...baseQuery, status: 'open' }),
      Idea.countDocuments({ ...baseQuery, status: 'in-progress' }),
      Idea.countDocuments({ ...baseQuery, status: 'completed' }),
      // Department breakdown only for super roles
      scope.type === 'all'
        ? Idea.aggregate([{ $group: { _id: '$department', count: { $sum: 1 } } }])
        : Promise.resolve([])
    ]);

    res.json({
      total,
      byStatus: { open, inProgress, completed },
      byDepartment
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/ideas/:id  — single issue (visibility-checked)
// ─────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id).lean();
    if (!idea) return res.status(404).json({ error: 'Issue not found' });

    const scope = getUserScope(req.user);
    if (scope.type === 'department') {
      if ((idea.department || '').toLowerCase() !== (scope.department || '').toLowerCase()) {
        return res.status(403).json({ error: 'Not authorized to view this issue' });
      }
    } else if (scope.type === 'own') {
      if (idea.createdBy !== scope.username) {
        return res.status(403).json({ error: 'Not authorized to view this issue' });
      }
    }

    res.json(idea);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ideas  — create new issue (all authenticated users)
// ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { title, description, priority, completeByDate, source = 'ideas' } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }

    // Auto-fill creator from JWT
    const createdBy = req.user.username;
    const scope = getUserScope(req.user);

    // Department is only required for department-sourced issues
    let department = req.body.department || undefined;

    if (source === 'department') {
      // Resolve department: client value → role mapping → user profile
      department =
        req.body.department ||
        (scope.type === 'department' ? scope.department : null) ||
        req.user.department ||
        undefined;

      if (!department) {
        return res.status(400).json({ error: 'Department is required. Please select a department.' });
      }
    }

    const newIdea = await Idea.create({
      title,
      description,
      type: source === 'department' ? 'issue' : (req.body.type || 'idea'),
      priority: priority || 'medium',
      createdBy,
      status: 'open',
      completeByDate: completeByDate || undefined,
      department,
      source
    });

    // ── Async email notification ──
    try {
      const recipients = new Set();
      const superadmins = await User.find({ role: 'superadmin', email: { $exists: true, $ne: null } }).select('email');
      superadmins.forEach(u => recipients.add(u.email));

      if (department) {
        const allAdmins = await User.find({
          role: { $in: Object.keys(ROLE_DEPARTMENT_MAP) },
          email: { $exists: true, $ne: null }
        });
        allAdmins.forEach(admin => {
          const adminDept = ROLE_DEPARTMENT_MAP[admin.role] || admin.department;
          if (adminDept && adminDept.toLowerCase() === department.toLowerCase()) {
            recipients.add(admin.email);
          }
        });
      }

      if (recipients.size > 0) {
        sendIssueCreatedEmail(newIdea, Array.from(recipients)).catch(console.error);
      }
    } catch (emailErr) {
      console.error('Failed to send issue email:', emailErr);
    }

    res.status(201).json(newIdea);
  } catch (err) {
    console.error('Error creating idea:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/ideas/:id  — update status / notes
//   • source='ideas'      → any authenticated user can update (original behaviour)
//   • source='department' → admins only, within their department scope
// ─────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Issue not found' });

    const isDepartmentIssue = idea.source === 'department';

    if (isDepartmentIssue) {
      // ── Department issues: admin-only, scoped to their department ──
      if (!ADMIN_ROLES.includes(req.user.role)) {
        return res.status(403).json({ error: 'Only admins can update department issues' });
      }

      const scope = getUserScope(req.user);
      if (scope.type === 'department') {
        const allowed = (scope.department || '').trim().toLowerCase();
        const issueD = (idea.department || '').trim().toLowerCase();
        if (!allowed || allowed !== issueD) {
          return res.status(403).json({ error: `Not authorized: your department is "${scope.department}", issue department is "${idea.department}"` });
        }
      }
    }
    // else: source='ideas' — any authenticated user can update (no extra checks needed)

    const { status, priority, assignedTo, pickedUpBy, resolvedBy, completeByDate, notes, department } = req.body;
    const scope = getUserScope(req.user);
    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (priority !== undefined) updateData.priority = priority;
    if (assignedTo !== undefined) updateData.assignedTo = assignedTo;
    if (pickedUpBy !== undefined) updateData.pickedUpBy = pickedUpBy || null;
    if (completeByDate !== undefined) updateData.completeByDate = completeByDate;
    if (notes !== undefined) updateData.notes = notes;
    if (department !== undefined && scope.type === 'all') updateData.department = department;
    if (status === 'completed' && !req.body.resolvedAt) {
      updateData.resolvedAt = new Date();
      if (resolvedBy) updateData.resolvedBy = resolvedBy;
    }

    const updated = await Idea.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    res.json(updated);
  } catch (err) {
    console.error('Error updating idea:', err);
    res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// DELETE /api/ideas/:id  — delete (admins only within scope)
// ─────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Only admins can delete issues' });
    }

    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Issue not found' });

    const scope = getUserScope(req.user);
    if (scope.type === 'department') {
      const allowed = (scope.department || '').trim().toLowerCase();
      const issueD = (idea.department || '').trim().toLowerCase();
      if (!allowed || allowed !== issueD) {
        return res.status(403).json({ error: `Not authorized to delete issues outside your department` });
      }
    }

    await Idea.findByIdAndDelete(req.params.id);
    res.json({ message: 'Issue deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ideas/:id/comments
// ─────────────────────────────────────────────────────────────
router.post('/:id/comments', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Comment text is required' });

    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Issue not found' });

    idea.comments.push({ text, commentedBy: req.user.username, commentedAt: new Date() });
    await idea.save();
    res.json(idea);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

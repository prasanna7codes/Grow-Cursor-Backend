import express from 'express';
import Idea from '../models/Idea.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

// Helper function to map admin roles to departments
const getRoleDepartment = (role) => {
  const mapping = {
    'hradmin': 'HR',
    'operationhead': 'Operations',
    'listingadmin': 'Listing',
    'productadmin': 'Product Research',
    'compatibilityadmin': 'Compatibility',
    'fulfillmentadmin': 'Operations',
    'hoc': 'Compliance',
    'compliancemanager': 'Compliance'
  };
  return mapping[role] || null;
};

// Get all ideas/tickets with pagination and filters
// PUBLIC ROUTE - No authentication required
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      status,
      priority,
      type,
      department,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = {};
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (type) query.type = type;
    if (department) query.department = department;

    // STRICT AUTHENTICATION REQUIRED
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let user = null;
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user = decoded;
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Role-based visibility filtering
    // 1. Superadmin: Sees ALL issues
    // 2. Department Heads/Admins: See issues in their specific department
    // 3. Normal Users: See ONLY issues they created

    const adminRoles = [
      'superadmin', 'productadmin', 'listingadmin', 'compatibilityadmin', 'fulfillmentadmin',
      'hradmin', 'operationhead', 'hoc', 'compliancemanager'
    ];

    if (user.role === 'superadmin' || user.role === 'hradmin') {
      // No filter needed, sees everything
    } else if (adminRoles.includes(user.role)) {
      // Department heads see their department's issues
      const userDepartment = getRoleDepartment(user.role);

      if (userDepartment) {
        query.department = userDepartment;
      } else if (user.department) {
        // Fallback to user.department property if role mapping doesn't exist
        query.department = user.department;
      } else {
        // If an admin has no department mapping and no department field, 
        // fallback to seeing only their own issues to be safe, or maybe nothing?
        // For now, let's treat them like normal users if we can't determine department
        query.createdBy = user.username;
      }
    } else {
      // Normal users: STRICTLY only their own issues
      query.createdBy = user.username;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOptions = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const ideas = await Idea.find(query)
      .sort(sortOptions)
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    const total = await Idea.countDocuments(query);

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

// Get single idea by ID
// PUBLIC ROUTE
router.get('/:id', async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id).lean();
    if (!idea) {
      return res.status(404).json({ error: 'Idea not found' });
    }
    res.json(idea);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new idea/ticket
// PUBLIC ROUTE - Anyone can submit
router.post('/', async (req, res) => {
  try {
    const { title, description, type, priority, createdBy, completeByDate, department } = req.body;

    if (!title || !description || !createdBy) {
      return res.status(400).json({
        error: 'Title, description, and createdBy are required'
      });
    }

    const newIdea = await Idea.create({
      title,
      description,
      type: type || 'idea',
      priority: priority || 'medium',
      createdBy,
      status: 'open',
      completeByDate: completeByDate || undefined,
      department: department || undefined
    });

    res.status(201).json(newIdea);
  } catch (err) {
    console.error('Error creating idea:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update idea (status, priority, assignee, etc.)
// PUBLIC ROUTE - But you might want to restrict this later
router.patch('/:id', async (req, res) => {
  try {
    // Auth check
    let user = null;
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        user = decoded;
        console.log('✅ JWT decoded successfully:', { username: user.username, role: user.role, department: user.department });
      } catch (jwtError) {
        console.error('❌ JWT verification failed:', jwtError.message);
      }
    } else {
      console.log('⚠️ No authorization header found');
    }

    const adminRoles = [
      'superadmin', 'productadmin', 'listingadmin', 'compatibilityadmin', 'fulfillmentadmin',
      'hradmin', 'operationhead', 'hoc', 'compliancemanager'
    ];

    console.log('Authorization check:', {
      hasUser: !!user,
      userRole: user?.role,
      isInAdminRoles: user ? adminRoles.includes(user.role) : false,
      isSuperadmin: user?.role === 'superadmin'
    });

    if (!user || (!adminRoles.includes(user.role) && user.role !== 'superadmin')) {
      return res.status(403).json({ error: 'Not authorized to update issues. Only admins and department heads can update issue status.' });
    }

    // Fetch the idea to check department
    const idea = await Idea.findById(req.params.id);
    if (!idea) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    // Only superadmin AND hradmin can update all issues, department heads only their department
    if (user.role !== 'superadmin' && user.role !== 'hradmin') {
      const userDepartment = getRoleDepartment(user.role);
      const allowedDepartment = (userDepartment || user.department || '').trim().toLowerCase();
      const issueDepartment = (idea.department || '').trim().toLowerCase();
      console.log('[DEPT CHECK] PATCH:', {
        username: user.username,
        userRole: user.role,
        allowedDepartment,
        issueDepartment,
        originalUserDept: user.department,
        originalIssueDept: idea.department
      });
      if (!allowedDepartment || allowedDepartment !== issueDepartment) {
        return res.status(403).json({
          error: `Not authorized to update issues outside your department. Your department: ${allowedDepartment || 'Unknown'}, Issue department: ${issueDepartment}`
        });
      }
    }

    const { status, priority, assignedTo, pickedUpBy, resolvedBy, completeByDate, notes, department } = req.body;
    console.log('PATCH /ideas/:id', { id: req.params.id, pickedUpBy });
    const updateData = {};
    if (status) updateData.status = status;
    if (priority) updateData.priority = priority;
    if (assignedTo) updateData.assignedTo = assignedTo;
    if (pickedUpBy !== undefined) updateData.pickedUpBy = pickedUpBy || null;
    if (completeByDate !== undefined) updateData.completeByDate = completeByDate;
    if (notes !== undefined) updateData.notes = notes;
    if (department !== undefined) updateData.department = department;
    console.log('Update data:', updateData);
    if (status === 'completed' && !req.body.resolvedAt) {
      updateData.resolvedAt = new Date();
      if (resolvedBy) updateData.resolvedBy = resolvedBy;
    }
    const updatedIdea = await Idea.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    console.log('Updated idea pickedUpBy:', updatedIdea.pickedUpBy);
    res.json(updatedIdea);
  } catch (err) {
    console.error('Error updating idea:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add comment to an idea
// PUBLIC ROUTE
router.post('/:id/comments', async (req, res) => {
  try {
    const { text, commentedBy } = req.body;

    if (!text || !commentedBy) {
      return res.status(400).json({ error: 'Text and commentedBy are required' });
    }

    const idea = await Idea.findById(req.params.id);
    if (!idea) {
      return res.status(404).json({ error: 'Idea not found' });
    }

    idea.comments.push({
      text,
      commentedBy,
      commentedAt: new Date()
    });

    await idea.save();
    res.json(idea);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete idea
// PUBLIC ROUTE - But you might want to restrict this to admins only
router.delete('/:id', async (req, res) => {
  try {
    // Auth check
    let user = null;
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        user = decoded;
      } catch { }
    }
    const adminRoles = [
      'superadmin', 'productadmin', 'listingadmin', 'compatibilityadmin', 'fulfillmentadmin',
      'hradmin', 'operationhead', 'hoc', 'compliancemanager'
    ];
    if (!user || (!adminRoles.includes(user.role) && user.role !== 'superadmin')) {
      return res.status(403).json({ error: 'Not authorized to delete issues. Only admins and department heads can delete issues.' });
    }
    // Fetch the idea to check department
    const idea = await Idea.findById(req.params.id);
    if (!idea) {
      return res.status(404).json({ error: 'Idea not found' });
    }
    // Only superadmin AND hradmin can delete all, others only their department
    if (user.role !== 'superadmin' && user.role !== 'hradmin') {
      const getRoleDepartment = (role) => {
        const mapping = {
          'hradmin': 'HR',
          'operationhead': 'Operations',
          'listingadmin': 'Listing',
          'productadmin': 'Product Research',
          'compatibilityadmin': 'Compatibility',
          'fulfillmentadmin': 'Operations',
          'hoc': 'Compliance',
          'compliancemanager': 'Compliance'
        };
        return mapping[role] || null;
      };
      const userDepartment = getRoleDepartment(user.role);
      const allowedDepartment = (userDepartment || user.department || '').trim().toLowerCase();
      const issueDepartment = (idea.department || '').trim().toLowerCase();
      console.log('[DEPT CHECK] DELETE:', {
        username: user.username,
        userRole: user.role,
        allowedDepartment,
        issueDepartment,
        originalUserDept: user.department,
        originalIssueDept: idea.department
      });
      if (!allowedDepartment || allowedDepartment !== issueDepartment) {
        return res.status(403).json({
          error: `Not authorized to delete issues outside your department. Your department: ${allowedDepartment || 'Unknown'}, Issue department: ${issueDepartment}`
        });
      }
    }
    await Idea.findByIdAndDelete(req.params.id);
    res.json({ message: 'Idea deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get statistics
// PUBLIC ROUTE
router.get('/stats/summary', async (req, res) => {
  try {
    const [total, open, inProgress, completed, byPriority] = await Promise.all([
      Idea.countDocuments(),
      Idea.countDocuments({ status: 'open' }),
      Idea.countDocuments({ status: 'in-progress' }),
      Idea.countDocuments({ status: 'completed' }),
      Idea.aggregate([
        { $group: { _id: '$priority', count: { $sum: 1 } } }
      ])
    ]);

    const priorityMap = byPriority.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    res.json({
      total,
      byStatus: { open, inProgress, completed },
      byPriority: {
        low: priorityMap.low || 0,
        medium: priorityMap.medium || 0,
        high: priorityMap.high || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

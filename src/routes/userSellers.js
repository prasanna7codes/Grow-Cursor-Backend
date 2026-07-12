import express from 'express';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import UserSellerAssignment from '../models/UserSellerAssignment.js';
import UserDailyQuantity from '../models/UserDailyQuantity.js';
import { validate } from '../utils/validate.js';
import {
    createUserSellerAssignmentSchema,
    idParamsSchema,
    updatePerformanceRemarksSchema,
    updateUserSellerTargetSchema
} from '../schemas/index.js';

const router = express.Router();

// ============================================
// ASSIGNMENTS
// ============================================

/**
 * @swagger
 * /user-sellers/assignments:
 *   get:
 *     tags: [User Sellers]
 *     summary: List all user-seller assignments
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of assignments with populated user and seller
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/UserSellerAssignment'
 *       500:
 *         description: Internal server error
 */
// Get all assignments
router.get('/assignments', requireAuth, requirePageAccess('UserSellerAssignments'), async (req, res) => {
    try {
        const assignments = await UserSellerAssignment.find()
            .populate('user', 'username email role department')
            .populate({
                path: 'seller',
                select: 'ebayMarketplaces user',
                populate: { path: 'user', select: 'username email' }
            })
            .sort({ createdAt: -1 })
            .lean();

        res.json(assignments);
    } catch (err) {
        console.error('Error fetching assignments:', err);
        res.status(500).json({ error: 'Server error fetching assignments' });
    }
});

/**
 * @swagger
 * /user-sellers/assignments:
 *   post:
 *     tags: [User Sellers]
 *     summary: Assign a seller to a user
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, sellerId]
 *             properties:
 *               userId:
 *                 type: string
 *               sellerId:
 *                 type: string
 *               dailyTarget:
 *                 type: integer
 *                 default: 0
 *     responses:
 *       201:
 *         description: Assignment created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 assignment:
 *                   $ref: '#/components/schemas/UserSellerAssignment'
 *       400:
 *         description: Missing fields or duplicate assignment
 *       500:
 *         description: Internal server error
 */
// Assign seller to user
router.post('/assignments', requireAuth, requirePageAccess('UserSellerAssignments'), validate(createUserSellerAssignmentSchema), async (req, res) => {
    try {
        const { userId, sellerId, dailyTarget } = req.body;

        if (!userId || !sellerId) {
            return res.status(400).json({ error: 'User ID and Seller ID are required' });
        }

        // Check if this specific user-seller pair already exists
        const existing = await UserSellerAssignment.findOne({ user: userId, seller: sellerId });
        if (existing) {
            return res.status(400).json({ error: 'This user is already assigned to this seller.' });
        }

        const assignment = new UserSellerAssignment({
            user: userId,
            seller: sellerId,
            dailyTarget: dailyTarget || 0
        });

        await assignment.save();

        res.status(201).json({ message: 'Assignment created successfully', assignment });
    } catch (err) {
        console.error('Error creating assignment:', err);
        res.status(500).json({ error: 'Server error creating assignment' });
    }
});

/**
 * @swagger
 * /user-sellers/assignments/{id}/target:
 *   patch:
 *     tags: [User Sellers]
 *     summary: Update the daily listing target for an assignment
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [dailyTarget]
 *             properties:
 *               dailyTarget:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Target updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 assignment:
 *                   $ref: '#/components/schemas/UserSellerAssignment'
 *       400:
 *         description: Invalid daily target
 *       404:
 *         description: Assignment not found
 *       500:
 *         description: Internal server error
 */
// Update assignment daily target
router.patch(
    '/assignments/:id/target',
    requireAuth,
    requirePageAccess('UserSellerAssignments'),
    validate(idParamsSchema, 'params'),
    validate(updateUserSellerTargetSchema),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { dailyTarget } = req.body;

            if (dailyTarget === undefined || isNaN(dailyTarget)) {
                return res.status(400).json({ error: 'Valid daily target is required' });
            }

            const assignment = await UserSellerAssignment.findByIdAndUpdate(
                id,
                { dailyTarget: Number(dailyTarget) },
                { new: true }
            );

            if (!assignment) {
                return res.status(404).json({ error: 'Assignment not found' });
            }

            res.json({ message: 'Target updated successfully', assignment });
        } catch (err) {
            console.error('Error updating assignment target:', err);
            res.status(500).json({ error: 'Server error updating assignment target' });
        }
    }
);

/**
 * @swagger
 * /user-sellers/assignments/{id}:
 *   delete:
 *     tags: [User Sellers]
 *     summary: Unassign a seller from a user
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Unassigned successfully
 *       404:
 *         description: Assignment not found
 *       500:
 *         description: Internal server error
 */
// Unassign seller
router.delete('/assignments/:id', requireAuth, requirePageAccess('UserSellerAssignments'), validate(idParamsSchema, 'params'), async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await UserSellerAssignment.findByIdAndDelete(id);
        if (!deleted) {
            return res.status(404).json({ error: 'Assignment not found' });
        }
        res.json({ message: 'Unassigned successfully' });
    } catch (err) {
        console.error('Error deleting assignment:', err);
        res.status(500).json({ error: 'Server error deleting assignment' });
    }
});

// ============================================
// PERFORMANCE TRACKING
// ============================================

import { syncDailyQuantities } from '../utils/performanceSync.js';

/**
 * @swagger
 * /user-sellers/performance:
 *   get:
 *     tags: [User Sellers]
 *     summary: Get daily performance records
 *     description: "Syncs daily quantities before returning. Non-manager roles only see their own records."
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of daily performance records
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/UserDailyQuantity'
 *       500:
 *         description: Internal server error
 */
// Get performance records
router.get('/performance', requireAuth, async (req, res) => {
    try {
        // Sync daily quantities before fetching to ensure today is created and carry-forwards are up to date
        await syncDailyQuantities();

        let query = {};

        // If user is not HR/Superadmin, they can only see their own performance
        const isManager = ['hr', 'hradmin', 'superadmin'].includes(req.user.role);

        if (!isManager) {
            query.user = req.user._id;
        }

        const records = await UserDailyQuantity.find(query)
            .populate('user', 'username email department')
            .populate({
                path: 'seller',
                populate: { path: 'user', select: 'username' }
            })
            .sort({ dateString: -1, createdAt: -1 });

        res.json(records);
    } catch (err) {
        console.error('Error fetching performance:', err);
        res.status(500).json({ error: 'Server error fetching performance' });
    }
});

/**
 * @swagger
 * /user-sellers/performance/{id}/remarks:
 *   patch:
 *     tags: [User Sellers]
 *     summary: Update remarks on a daily performance record
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [remarks]
 *             properties:
 *               remarks:
 *                 type: string
 *                 enum: ['Good', 'Average', 'Need for improvement', '']
 *     responses:
 *       200:
 *         description: Remarks updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 record:
 *                   $ref: '#/components/schemas/UserDailyQuantity'
 *       400:
 *         description: Invalid remark value
 *       404:
 *         description: Performance record not found
 *       500:
 *         description: Internal server error
 */
// Update remarks
router.patch(
    '/performance/:id/remarks',
    requireAuth,
    requirePageAccess('UserSellerAssignments'),
    validate(idParamsSchema, 'params'),
    validate(updatePerformanceRemarksSchema),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { remarks } = req.body;

            const validRemarks = ['Good', 'Average', 'Need for improvement', ''];
            if (!validRemarks.includes(remarks)) {
                return res.status(400).json({ error: 'Invalid remark value' });
            }

            const record = await UserDailyQuantity.findByIdAndUpdate(
                id,
                { remarks },
                { new: true }
            );

            if (!record) {
                return res.status(404).json({ error: 'Performance record not found' });
            }

            res.json({ message: 'Remarks updated successfully', record });
        } catch (err) {
            console.error('Error updating remarks:', err);
            res.status(500).json({ error: 'Server error updating remarks' });
        }
    }
);

export default router;

import express from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import CsvStorage from '../models/CsvStorage.js';
import FeedUpload from '../models/FeedUpload.js';


const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ============================================
// GET /csv-storage — Paginated list with filters
// ============================================
/**
 * @swagger
 * /csv-storage:
 *   get:
 *     tags: [CSV Storage]
 *     summary: List CSV records (paginated)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *       - in: query
 *         name: keyword
 *         schema: { type: string }
 *         description: Case-insensitive name search
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: categoryId
 *         schema: { type: string }
 *       - in: query
 *         name: rangeId
 *         schema: { type: string }
 *       - in: query
 *         name: productId
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated records (csvData field excluded)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 records:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/CsvStorageRecord'
 *                 total:
 *                   type: integer
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const {
            sellerId,
            keyword,
            dateFrom,
            dateTo,
            categoryId,
            rangeId,
            productId,
            limit = 10,
            offset = 0
        } = req.query;

        const filter = {};

        if (sellerId) filter.seller = sellerId;
        if (categoryId) filter.categoryId = categoryId;
        if (rangeId) filter.rangeId = rangeId;
        if (productId) filter.productId = productId;

        if (keyword) {
            filter.name = { $regex: keyword, $options: 'i' };
        }

        if (dateFrom || dateTo) {
            filter.createdAt = {};
            if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
            if (dateTo) {
                const end = new Date(dateTo);
                end.setHours(23, 59, 59, 999);
                filter.createdAt.$lte = end;
            }
        }

        const skip = parseInt(offset) || 0;
        const limitNum = parseInt(limit) || 10;

        const records = await CsvStorage.find(filter)
            .select('-csvData') // Exclude binary data from list response
            .populate({ path: 'seller', select: 'storeName user', populate: { path: 'user', select: 'username' } })
            .populate('feedUploadId', 'status uploadSummary taskId')
            .populate('scheduledSellerId', 'storeName')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum);

        // With no filter, countDocuments({}) is a full COLLSCAN that reads every
        // ~40KB+ document (the raw CSV lives inside each doc) just to count them —
        // ~1.3GB off disk and ~22s. estimatedDocumentCount() returns the total from
        // collection metadata instantly. Fall back to an exact count only when an
        // actual filter is present.
        const total = Object.keys(filter).length === 0
            ? await CsvStorage.estimatedDocumentCount()
            : await CsvStorage.countDocuments(filter);

        res.json({ records, total });
    } catch (err) {
        console.error('[CSV Storage] GET Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch CSV records', details: err.message });
    }
});

// ============================================
// POST /csv-storage — Save a new CSV record
// ============================================
/**
 * @swagger
 * /csv-storage:
 *   post:
 *     tags: [CSV Storage]
 *     summary: Upload and save a CSV record
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [csvFile, sellerId]
 *             properties:
 *               csvFile:
 *                 type: string
 *                 format: binary
 *               sellerId:
 *                 type: string
 *               templateId:
 *                 type: string
 *               listingCount:
 *                 type: integer
 *               categoryId:
 *                 type: string
 *               categoryName:
 *                 type: string
 *               rangeId:
 *                 type: string
 *               rangeName:
 *                 type: string
 *               productId:
 *                 type: string
 *               productName:
 *                 type: string
 *               source:
 *                 type: string
 *               country:
 *                 type: string
 *     responses:
 *       200:
 *         description: Saved record summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 _id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 fileName:
 *                   type: string
 *       400:
 *         description: No CSV file or missing sellerId
 *       500:
 *         description: Internal server error
 */
router.post('/', requireAuth, upload.single('csvFile'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: 'No CSV file provided' });
        }

        const {
            sellerId,
            templateId,
            listingCount,
            categoryId,
            categoryName,
            rangeId,
            rangeName,
            productId,
            productName,
            source,
            country
        } = req.body;

        if (!sellerId) {
            return res.status(400).json({ error: 'Missing sellerId' });
        }

        const name = file.originalname.replace(/\.csv$/i, '');

        const record = await CsvStorage.create({
            name,
            fileName: file.originalname,
            csvData: file.buffer,
            mimeType: file.mimetype || 'text/csv',
            seller: sellerId,
            templateId: templateId || null,
            listingCount: parseInt(listingCount) || 0,
            categoryId: categoryId || null,
            categoryName: categoryName || '',
            rangeId: rangeId || null,
            rangeName: rangeName || '',
            productId: productId || null,
            productName: productName || '',
            source: source || null,
            country: country || null,
            createdBy: req.user?._id || null
        });

        res.json({ _id: record._id, name: record.name, fileName: record.fileName });
    } catch (err) {
        console.error('[CSV Storage] POST Error:', err.message);
        res.status(500).json({ error: 'Failed to save CSV record', details: err.message });
    }
});

// ============================================
// PATCH /csv-storage/:id/link-upload — Link FeedUpload by taskId
// ============================================
/**
 * @swagger
 * /csv-storage/{id}/link-upload:
 *   patch:
 *     tags: [CSV Storage]
 *     summary: Link a FeedUpload record to a CSV by taskId
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
 *             required: [taskId]
 *             properties:
 *               taskId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Record with feedUploadId linked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 record:
 *                   $ref: '#/components/schemas/CsvStorageRecord'
 *       400:
 *         description: Missing taskId
 *       404:
 *         description: CSV record or FeedUpload not found
 *       500:
 *         description: Internal server error
 */
router.patch('/:id/link-upload', requireAuth, async (req, res) => {
    try {
        const { taskId } = req.body;
        if (!taskId) {
            return res.status(400).json({ error: 'Missing taskId' });
        }

        const feedUpload = await FeedUpload.findOne({ taskId });
        if (!feedUpload) {
            return res.status(404).json({ error: 'FeedUpload record not found for this taskId' });
        }

        const record = await CsvStorage.findByIdAndUpdate(
            req.params.id,
            { feedUploadId: feedUpload._id },
            { new: true }
        ).select('-csvData');

        if (!record) {
            return res.status(404).json({ error: 'CSV Storage record not found' });
        }

        res.json({ success: true, record });
    } catch (err) {
        console.error('[CSV Storage] PATCH link-upload Error:', err.message);
        res.status(500).json({ error: 'Failed to link upload', details: err.message });
    }
});

// ============================================
// GET /csv-storage/:id/download — Stream CSV from DB
// ============================================
/**
 * @swagger
 * /csv-storage/{id}/download:
 *   get:
 *     tags: [CSV Storage]
 *     summary: Download a stored CSV file
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
 *         description: Raw CSV file stream
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: CSV record not found
 *       500:
 *         description: Internal server error
 */
router.get('/:id/download', requireAuth, async (req, res) => {
    try {
        const record = await CsvStorage.findById(req.params.id);
        if (!record) {
            return res.status(404).json({ error: 'CSV record not found' });
        }

        res.setHeader('Content-Type', record.mimeType || 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${record.fileName}"`);
        res.send(record.csvData);
    } catch (err) {
        console.error('[CSV Storage] Download Error:', err.message);
        res.status(500).json({ error: 'Failed to download CSV', details: err.message });
    }
});

// ============================================
// POST /csv-storage/:id/schedule-upload — Set or update scheduled auto-upload
// ============================================
/**
 * @swagger
 * /csv-storage/{id}/schedule-upload:
 *   post:
 *     tags: [CSV Storage]
 *     summary: Schedule an auto-upload for a CSV record
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
 *             required: [scheduledAt, sellerId]
 *             properties:
 *               scheduledAt:
 *                 type: string
 *                 format: date-time
 *               sellerId:
 *                 type: string
 *               country:
 *                 type: string
 *               categoryId:
 *                 type: string
 *               rangeId:
 *                 type: string
 *               productId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Schedule set
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 record:
 *                   $ref: '#/components/schemas/CsvStorageRecord'
 *       400:
 *         description: Missing scheduledAt/sellerId or date in the past
 *       404:
 *         description: CSV record not found
 *       500:
 *         description: Internal server error
 */
router.post('/:id/schedule-upload', requireAuth, async (req, res) => {
    try {
        const { scheduledAt, sellerId, country, categoryId, rangeId, productId } = req.body;
        if (!scheduledAt) return res.status(400).json({ error: 'Missing scheduledAt' });
        if (!sellerId) return res.status(400).json({ error: 'Missing sellerId' });

        const scheduledDate = new Date(scheduledAt);
        if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: 'Invalid scheduledAt date' });
        if (scheduledDate <= new Date()) return res.status(400).json({ error: 'Scheduled time must be in the future' });

        const updateFields = {
            scheduledUploadAt: scheduledDate,
            scheduledSellerId: sellerId,
            scheduledUploadStatus: 'pending'
        };
        // Persist optional metadata so the cron job can forward them to FeedUpload
        if (country) updateFields.country = country;
        if (categoryId) updateFields.categoryId = categoryId;
        if (rangeId) updateFields.rangeId = rangeId;
        if (productId) updateFields.productId = productId;

        const record = await CsvStorage.findByIdAndUpdate(
            req.params.id,
            updateFields,
            { new: true }
        ).select('-csvData').populate('seller', 'storeName').populate('feedUploadId', 'status uploadSummary taskId');

        if (!record) return res.status(404).json({ error: 'CSV record not found' });
        res.json({ success: true, record });
    } catch (err) {
        console.error('[CSV Storage] schedule-upload Error:', err.message);
        res.status(500).json({ error: 'Failed to schedule upload', details: err.message });
    }
});

// ============================================
// DELETE /csv-storage/:id/schedule-upload — Cancel scheduled auto-upload
// ============================================
/**
 * @swagger
 * /csv-storage/{id}/schedule-upload:
 *   delete:
 *     tags: [CSV Storage]
 *     summary: Cancel a scheduled auto-upload
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
 *         description: Schedule cancelled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 record:
 *                   $ref: '#/components/schemas/CsvStorageRecord'
 *       400:
 *         description: Cannot cancel — upload is already processing
 *       404:
 *         description: CSV record not found
 *       500:
 *         description: Internal server error
 */
router.delete('/:id/schedule-upload', requireAuth, async (req, res) => {
    try {
        const existing = await CsvStorage.findById(req.params.id).select('scheduledUploadStatus');
        if (!existing) return res.status(404).json({ error: 'CSV record not found' });
        if (existing.scheduledUploadStatus === 'processing') {
            return res.status(400).json({ error: 'Cannot cancel — upload is already processing' });
        }

        const record = await CsvStorage.findByIdAndUpdate(
            req.params.id,
            { scheduledUploadAt: null, scheduledSellerId: null, scheduledUploadStatus: null },
            { new: true }
        ).select('-csvData').populate('seller', 'storeName').populate('feedUploadId', 'status uploadSummary taskId');

        res.json({ success: true, record });
    } catch (err) {
        console.error('[CSV Storage] cancel schedule-upload Error:', err.message);
        res.status(500).json({ error: 'Failed to cancel scheduled upload', details: err.message });
    }
});

// ============================================
// DELETE /csv-storage/:id — Remove record
// ============================================
/**
 * @swagger
 * /csv-storage/{id}:
 *   delete:
 *     tags: [CSV Storage]
 *     summary: Delete a CSV storage record
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
 *         description: Deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       404:
 *         description: CSV record not found
 *       500:
 *         description: Internal server error
 */
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const record = await CsvStorage.findByIdAndDelete(req.params.id);
        if (!record) {
            return res.status(404).json({ error: 'CSV record not found' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[CSV Storage] DELETE Error:', err.message);
        res.status(500).json({ error: 'Failed to delete CSV record', details: err.message });
    }
});

export default router;

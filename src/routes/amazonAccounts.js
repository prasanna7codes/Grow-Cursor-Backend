// routes/amazonAccounts.js
import { Router } from 'express';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createAmazonAccountSchema } from '../schemas/index.js';
import AmazonAccount from '../models/AmazonAccount.js';

const router = Router();

// GET: Fetch all Amazon Accounts (Accessible by authenticated users so Dashboard can read it)
/**
 * @swagger
 * /amazon-accounts:
 *   get:
 *     tags: [Amazon Accounts]
 *     summary: List all Amazon accounts
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of account documents
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AmazonAccount'
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const accounts = await AmazonAccount.find().sort({ name: 1 }).lean();
    res.json(accounts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST: Add new Amazon Account (Restricted to specific roles)
/**
 * @swagger
 * /amazon-accounts:
 *   post:
 *     tags: [Amazon Accounts]
 *     summary: Create a new Amazon account
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string }
 *               addressLine1:{ type: string }
 *               addressLine2:{ type: string }
 *               city:        { type: string }
 *               state:       { type: string }
 *               postalCode:  { type: string }
 *               country:     { type: string }
 *               phoneNumber: { type: string }
 *               notes:       { type: string }
 *     responses:
 *       200:
 *         description: Created account document
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AmazonAccount'
 *       400:
 *         description: Validation error or duplicate name
 */
router.post('/', requireAuth, requirePageAccess('AmazonAccounts'), validate(createAmazonAccountSchema), async (req, res) => {
  const { name, addressLine1, addressLine2, city, state, postalCode, country, phoneNumber, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Account name is required' });
  
  try {
    const account = await AmazonAccount.create({ 
      name, 
      addressLine1: addressLine1 || '', 
      addressLine2: addressLine2 || '', 
      city: city || '', 
      state: state || '', 
      postalCode: postalCode || '', 
      country: country || '', 
      phoneNumber: phoneNumber || '', 
      notes: notes || '' 
    });
    res.json(account);
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({ error: 'Account name already exists' });
    }
    res.status(400).json({ error: e.message });
  }
});

// PATCH: Update an account
/**
 * @swagger
 * /amazon-accounts/{id}:
 *   patch:
 *     tags: [Amazon Accounts]
 *     summary: Update an Amazon account
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AmazonAccount'
 *     responses:
 *       200:
 *         description: Updated account document
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AmazonAccount'
 *       400:
 *         description: Duplicate name
 *       404:
 *         description: Account not found
 *   delete:
 *     tags: [Amazon Accounts]
 *     summary: Delete an Amazon account
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deletion confirmed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *       500:
 *         description: Internal server error
 */
router.patch('/:id', requireAuth, requirePageAccess('AmazonAccounts'), async (req, res) => {
  const { name, addressLine1, addressLine2, city, state, postalCode, country, phoneNumber, notes } = req.body;
  
  try {
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (addressLine1 !== undefined) updateData.addressLine1 = addressLine1;
    if (addressLine2 !== undefined) updateData.addressLine2 = addressLine2;
    if (city !== undefined) updateData.city = city;
    if (state !== undefined) updateData.state = state;
    if (postalCode !== undefined) updateData.postalCode = postalCode;
    if (country !== undefined) updateData.country = country;
    if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber;
    if (notes !== undefined) updateData.notes = notes;

    const account = await AmazonAccount.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    res.json(account);
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({ error: 'Account name already exists' });
    }
    res.status(400).json({ error: e.message });
  }
});

// DELETE: Remove an account (Optional, but good to have)
router.delete('/:id', requireAuth, requirePageAccess('AmazonAccounts'), async (req, res) => {
    try {
      await AmazonAccount.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

export default router;
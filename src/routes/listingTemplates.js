import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import ListingTemplate from '../models/ListingTemplate.js';
import TemplateOverride from '../models/TemplateOverride.js';
import SellerPricingConfig from '../models/SellerPricingConfig.js';
import { listBadges, resolveBadge } from '../config/overlayBadges.js';
import { ANCHORS } from '../utils/overlayCompositor.js';

const router = express.Router();

/**
 * Reject overlay options that reference unregistered artwork or out-of-range
 * placement. Without this a template could be saved with a badge key that
 * silently does nothing at preview time.
 * @returns {string|null} error message, or null when valid
 */
function validateOverlayOptions(overlayOptions) {
  if (overlayOptions === undefined || overlayOptions === null) return null;
  if (!Array.isArray(overlayOptions)) return 'overlayOptions must be an array';

  for (const option of overlayOptions) {
    if (!option || !resolveBadge(option.badgeKey)) {
      return `Unknown overlay badge: ${option?.badgeKey}`;
    }
    if (option.anchor !== undefined && !ANCHORS.includes(option.anchor)) {
      return `Invalid overlay anchor: ${option.anchor}`;
    }
    if (option.scale !== undefined && !(option.scale >= 0.05 && option.scale <= 1)) {
      return `Overlay scale must be between 0.05 and 1 (got ${option.scale})`;
    }
    if (option.margin !== undefined && !(option.margin >= 0 && option.margin <= 0.2)) {
      return `Overlay margin must be between 0 and 0.2 (got ${option.margin})`;
    }
  }

  return null;
}

/**
 * @swagger
 * /listing-templates/overlay-badges:
 *   get:
 *     tags: [Listing Templates]
 *     summary: List overlay badges available for template image overlays
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Registered badges
 */
router.get('/overlay-badges', requireAuth, (req, res) => {
  res.json({ badges: listBadges() });
});

// Get custom Action field for template
/**
 * @swagger
 * /listing-templates/action-field/{templateId}:
 *   get:
 *     tags: [Listing Templates]
 *     summary: Get the effective custom Action field for a template (seller override if set)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Action field value and source
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 actionField: { type: string }
 *                 source:      { type: string, enum: [template, seller-override] }
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 *   put:
 *     tags: [Listing Templates]
 *     summary: Update the custom Action field (base template or seller override)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [actionField]
 *             properties:
 *               actionField: { type: string }
 *               sellerId:    { type: string, description: Omit to update base template }
 *     responses:
 *       200:
 *         description: Updated action field value and source
 *       400:
 *         description: Action field cannot be empty
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 */
router.get('/action-field/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId } = req.query;
    
    // Check for seller override first
    if (sellerId) {
      const override = await TemplateOverride.findOne({
        baseTemplateId: templateId,
        sellerId: sellerId
      });
      
      if (override?.overrides.customActionField && override.customActionField) {
        return res.json({
          actionField: override.customActionField,
          source: 'seller-override'
        });
      }
    }
    
    // Fallback to base template
    const template = await ListingTemplate.findById(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json({ 
      actionField: template.customActionField || '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)',
      source: 'template'
    });
  } catch (error) {
    console.error('Error fetching action field:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update custom Action field for template
router.put('/action-field/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { actionField, sellerId } = req.body;
    
    // Basic validation - just check it's not empty
    if (!actionField || !actionField.trim()) {
      return res.status(400).json({ error: 'Action field cannot be empty' });
    }
    
    // If no sellerId provided, update base template (admin action)
    if (!sellerId) {
      const template = await ListingTemplate.findByIdAndUpdate(
        templateId,
        { 
          customActionField: actionField.trim(),
          updatedAt: Date.now()
        },
        { new: true }
      );
      
      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }
      
      return res.json({ 
        actionField: template.customActionField,
        source: 'template'
      });
    }
    
    // Create/update seller override
    const override = await TemplateOverride.findOneAndUpdate(
      { baseTemplateId: templateId, sellerId: sellerId },
      {
        $set: {
          'overrides.customActionField': true,
          customActionField: actionField.trim(),
          updatedAt: Date.now()
        }
      },
      { new: true, upsert: true }
    );
    
    res.json({
      actionField: override.customActionField,
      source: 'seller-override'
    });
  } catch (error) {
    console.error('Error updating action field:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk reset overrides for a template (apply base template to all sellers)
/**
 * @swagger
 * /listing-templates/{id}/bulk-reset-overrides:
 *   delete:
 *     tags: [Listing Templates]
 *     summary: Delete all seller overrides and pricing configs for a template
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Reset summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:         { type: boolean }
 *                 deletedCount:    { type: integer }
 *                 affectedSellers: { type: array, items: { type: string } }
 *                 templateName:    { type: string }
 *                 message:         { type: string }
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 */
router.delete('/:id/bulk-reset-overrides', requireAuth, async (req, res) => {
  try {
    const { id: templateId } = req.params;
    
    // Verify template exists
    const template = await ListingTemplate.findById(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Get affected sellers before deletion for logging
    const [affectedOverrides, affectedPricingConfigs] = await Promise.all([
      TemplateOverride.find({ baseTemplateId: templateId }).select('sellerId').lean(),
      SellerPricingConfig.find({ templateId }).select('sellerId').lean()
    ]);

    const affectedSellerSet = new Set([
      ...affectedOverrides.map(o => o.sellerId.toString()),
      ...affectedPricingConfigs.map(p => p.sellerId.toString())
    ]);
    const affectedSellerIds = [...affectedSellerSet];

    // Perform bulk deletion of both override layers
    const [overrideResult, pricingResult] = await Promise.all([
      TemplateOverride.deleteMany({ baseTemplateId: templateId }),
      SellerPricingConfig.deleteMany({ templateId })
    ]);

    console.log(`[BULK RESET] Template "${template.name}" (${templateId}): Deleted ${overrideResult.deletedCount} overrides + ${pricingResult.deletedCount} pricing configs for sellers:`, affectedSellerIds);

    res.json({
      success: true,
      deletedCount: affectedSellerIds.length,
      affectedSellers: affectedSellerIds,
      templateName: template.name,
      message: `Successfully reset ${affectedSellerIds.length} seller customizations. All sellers will now use the base template.`
    });
  } catch (error) {
    console.error('Error in bulk reset overrides:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all templates
/**
 * @swagger
 * /listing-templates:
 *   get:
 *     tags: [Listing Templates]
 *     summary: List all listing templates
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: rangeId
 *         schema: { type: string }
 *       - in: query
 *         name: listProductId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Array of template documents
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ListingTemplate'
 *       500:
 *         description: Internal server error
 *   post:
 *     tags: [Listing Templates]
 *     summary: Create a new listing template
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
 *               name:              { type: string }
 *               description:       { type: string }
 *               category:          { type: string }
 *               ebayCategory:      { type: string }
 *               customColumns:     { type: array, items: { type: object } }
 *               asinAutomation:    { type: object }
 *               pricingConfig:     { type: object }
 *               coreFieldDefaults: { type: object }
 *               rangeId:           { type: string }
 *               listProductId:     { type: string }
 *     responses:
 *       201:
 *         description: Created template
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListingTemplate'
 *       400:
 *         description: Template name is required
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { listProductId, rangeId } = req.query;
    const filter = {};
    if (rangeId) filter.rangeId = rangeId;
    if (listProductId) filter.listProductId = listProductId;
    const templates = await ListingTemplate.find(filter)
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });
    
    res.json(templates);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single template by ID
/**
 * @swagger
 * /listing-templates/{id}:
 *   get:
 *     tags: [Listing Templates]
 *     summary: Get a single template by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Template document
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListingTemplate'
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 *   put:
 *     tags: [Listing Templates]
 *     summary: Replace a template's configuration
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ListingTemplate'
 *     responses:
 *       200:
 *         description: Updated template
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListingTemplate'
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 *   delete:
 *     tags: [Listing Templates]
 *     summary: Delete a template
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
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const template = await ListingTemplate.findById(req.params.id)
      .populate('createdBy', 'name email');
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json(template);
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new template
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description, category, ebayCategory, customColumns, asinAutomation, pricingConfig, coreFieldDefaults, overlayOptions, rangeId, listProductId } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Template name is required' });
    }

    const overlayError = validateOverlayOptions(overlayOptions);
    if (overlayError) {
      return res.status(400).json({ error: overlayError });
    }

    const templateData = {
      name,
      description,
      category,
      ebayCategory,
      customColumns: customColumns || [],
      asinAutomation: asinAutomation || { enabled: false, fieldConfigs: [] },
      pricingConfig: pricingConfig || { enabled: false },
      overlayOptions: overlayOptions || [],
      createdBy: req.user.userId
    };
    
    // Add coreFieldDefaults if provided
    if (coreFieldDefaults !== undefined) {
      templateData.coreFieldDefaults = coreFieldDefaults;
    }

    // Add hierarchy assignment if provided
    if (rangeId) templateData.rangeId = rangeId;
    if (listProductId) templateData.listProductId = listProductId;
    
    const template = new ListingTemplate(templateData);
    
    await template.save();
    await template.populate('createdBy', 'name email');
    
    res.status(201).json(template);
  } catch (error) {
    console.error('Error creating template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Duplicate template
/**
 * @swagger
 * /listing-templates/{id}/duplicate:
 *   post:
 *     tags: [Listing Templates]
 *     summary: Duplicate a template (auto-generates a unique name)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       201:
 *         description: Duplicated template
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListingTemplate'
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 */
router.post('/:id/duplicate', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find the source template
    const sourceTemplate = await ListingTemplate.findById(id);
    
    if (!sourceTemplate) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Generate unique name with (Copy) suffix
    let duplicateName = `${sourceTemplate.name} (Copy)`;
    let copyNumber = 2;
    
    // Check if name already exists and increment counter
    while (await ListingTemplate.findOne({ name: duplicateName })) {
      duplicateName = `${sourceTemplate.name} (Copy ${copyNumber})`;
      copyNumber++;
    }
    
    // Create duplicate with all configurations
    const duplicateData = {
      name: duplicateName,
      description: sourceTemplate.description,
      category: sourceTemplate.category,
      ebayCategory: sourceTemplate.ebayCategory,
      customColumns: sourceTemplate.customColumns ? JSON.parse(JSON.stringify(sourceTemplate.customColumns)) : [],
      overlayOptions: sourceTemplate.overlayOptions ? JSON.parse(JSON.stringify(sourceTemplate.overlayOptions)) : [],
      asinAutomation: sourceTemplate.asinAutomation ? {
        enabled: sourceTemplate.asinAutomation.enabled,
        fieldConfigs: sourceTemplate.asinAutomation.fieldConfigs ? 
          JSON.parse(JSON.stringify(sourceTemplate.asinAutomation.fieldConfigs)) : []
      } : { enabled: false, fieldConfigs: [] },
      pricingConfig: sourceTemplate.pricingConfig ? {
        enabled: sourceTemplate.pricingConfig.enabled,
        spentRate: sourceTemplate.pricingConfig.spentRate,
        payoutRate: sourceTemplate.pricingConfig.payoutRate,
        desiredProfit: sourceTemplate.pricingConfig.desiredProfit,
        fixedFee: sourceTemplate.pricingConfig.fixedFee,
        saleTax: sourceTemplate.pricingConfig.saleTax,
        ebayFee: sourceTemplate.pricingConfig.ebayFee,
        adsFee: sourceTemplate.pricingConfig.adsFee,
        tdsFee: sourceTemplate.pricingConfig.tdsFee,
        shippingCost: sourceTemplate.pricingConfig.shippingCost,
        taxRate: sourceTemplate.pricingConfig.taxRate,
        profitTiers: sourceTemplate.pricingConfig.profitTiers ? {
          enabled: sourceTemplate.pricingConfig.profitTiers.enabled,
          tiers: sourceTemplate.pricingConfig.profitTiers.tiers ? 
            JSON.parse(JSON.stringify(sourceTemplate.pricingConfig.profitTiers.tiers)) : []
        } : { enabled: false, tiers: [] }
      } : { enabled: false },
      coreFieldDefaults: sourceTemplate.coreFieldDefaults ? 
        JSON.parse(JSON.stringify(sourceTemplate.coreFieldDefaults)) : {},
      customActionField: sourceTemplate.customActionField,
      createdBy: req.user.userId
    };
    
    const duplicateTemplate = new ListingTemplate(duplicateData);
    await duplicateTemplate.save();
    await duplicateTemplate.populate('createdBy', 'name email');
    
    res.status(201).json(duplicateTemplate);
  } catch (error) {
    console.error('Error duplicating template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update template
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, description, category, ebayCategory, customColumns, asinAutomation, pricingConfig, coreFieldDefaults, customActionField, overlayOptions, rangeId, listProductId } = req.body;

    const overlayError = validateOverlayOptions(overlayOptions);
    if (overlayError) {
      return res.status(400).json({ error: overlayError });
    }

    const updateData = {
      name,
      description,
      category,
      ebayCategory,
      customColumns: customColumns || [],
      asinAutomation: asinAutomation || { enabled: false, fieldConfigs: [] },
      pricingConfig: pricingConfig || { enabled: false },
      updatedAt: Date.now()
    };

    // Only touch overlayOptions when the client sends them, so older clients
    // that don't know about the field can't silently clear a template's badges.
    if (overlayOptions !== undefined) {
      updateData.overlayOptions = overlayOptions || [];
    }
    
    // Add coreFieldDefaults if provided
    if (coreFieldDefaults !== undefined) {
      updateData.coreFieldDefaults = coreFieldDefaults;
    }

    // Add customActionField if provided
    if (customActionField !== undefined) {
      updateData.customActionField = customActionField;
    }

    // Add hierarchy assignment (allow explicit null to clear)
    if (rangeId !== undefined) updateData.rangeId = rangeId || null;
    if (listProductId !== undefined) updateData.listProductId = listProductId || null;
    
    const template = await ListingTemplate.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name email');
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json(template);
  } catch (error) {
    console.error('Error updating template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete template
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const template = await ListingTemplate.findByIdAndDelete(req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Note: You might want to also delete associated listings
    // await TemplateListing.deleteMany({ templateId: req.params.id });
    
    res.json({ message: 'Template deleted successfully' });
  } catch (error) {
    console.error('Error deleting template:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add custom column to template
/**
 * @swagger
 * /listing-templates/{id}/columns:
 *   post:
 *     tags: [Listing Templates]
 *     summary: Add a custom column to a template
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, displayName]
 *             properties:
 *               name:         { type: string }
 *               displayName:  { type: string }
 *               dataType:     { type: string, default: text }
 *               defaultValue: { type: string }
 *               isRequired:   { type: boolean }
 *               placeholder:  { type: string }
 *     responses:
 *       200:
 *         description: Updated template with new column
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListingTemplate'
 *       400:
 *         description: name and displayName are required
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 */
router.post('/:id/columns', requireAuth, async (req, res) => {
  try {
    const { name, displayName, dataType, defaultValue, isRequired, placeholder } = req.body;
    
    if (!name || !displayName) {
      return res.status(400).json({ error: 'Column name and display name are required' });
    }
    
    const template = await ListingTemplate.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Calculate next order number
    const maxOrder = template.customColumns.length > 0 
      ? Math.max(...template.customColumns.map(col => col.order))
      : 38;
    
    template.customColumns.push({
      name,
      displayName,
      dataType: dataType || 'text',
      defaultValue: defaultValue || '',
      isRequired: isRequired || false,
      order: maxOrder + 1,
      placeholder: placeholder || ''
    });
    
    await template.save();
    await template.populate('createdBy', 'name email');
    
    res.json(template);
  } catch (error) {
    console.error('Error adding column:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update custom column
/**
 * @swagger
 * /listing-templates/{id}/columns/{columnName}:
 *   put:
 *     tags: [Listing Templates]
 *     summary: Update a custom column definition
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: columnName
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName:  { type: string }
 *               dataType:     { type: string }
 *               defaultValue: { type: string }
 *               isRequired:   { type: boolean }
 *               placeholder:  { type: string }
 *     responses:
 *       200:
 *         description: Updated template
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListingTemplate'
 *       404:
 *         description: Template or column not found
 *       500:
 *         description: Internal server error
 *   delete:
 *     tags: [Listing Templates]
 *     summary: Remove a custom column from a template
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: columnName
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated template with column removed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListingTemplate'
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 */
router.put('/:id/columns/:columnName', requireAuth, async (req, res) => {
  try {
    const { displayName, dataType, defaultValue, isRequired, placeholder } = req.body;
    
    const template = await ListingTemplate.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const columnIndex = template.customColumns.findIndex(
      col => col.name === req.params.columnName
    );
    
    if (columnIndex === -1) {
      return res.status(404).json({ error: 'Column not found' });
    }
    
    if (displayName) template.customColumns[columnIndex].displayName = displayName;
    if (dataType) template.customColumns[columnIndex].dataType = dataType;
    if (defaultValue !== undefined) template.customColumns[columnIndex].defaultValue = defaultValue;
    if (isRequired !== undefined) template.customColumns[columnIndex].isRequired = isRequired;
    if (placeholder !== undefined) template.customColumns[columnIndex].placeholder = placeholder;
    
    await template.save();
    await template.populate('createdBy', 'name email');
    
    res.json(template);
  } catch (error) {
    console.error('Error updating column:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete custom column
router.delete('/:id/columns/:columnName', requireAuth, async (req, res) => {
  try {
    const template = await ListingTemplate.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    template.customColumns = template.customColumns.filter(
      col => col.name !== req.params.columnName
    );
    
    await template.save();
    await template.populate('createdBy', 'name email');
    
    res.json(template);
  } catch (error) {
    console.error('Error deleting column:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reorder custom columns
/**
 * @swagger
 * /listing-templates/{id}/columns/reorder:
 *   post:
 *     tags: [Listing Templates]
 *     summary: Reorder custom columns on a template
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [columnOrders]
 *             properties:
 *               columnOrders:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:  { type: string }
 *                     order: { type: integer }
 *     responses:
 *       200:
 *         description: Updated template with new column order
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListingTemplate'
 *       404:
 *         description: Template not found
 *       500:
 *         description: Internal server error
 */
router.post('/:id/columns/reorder', requireAuth, async (req, res) => {
  try {
    const { columnOrders } = req.body; // Array of { name, order }
    
    const template = await ListingTemplate.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    columnOrders.forEach(({ name, order }) => {
      const column = template.customColumns.find(col => col.name === name);
      if (column) {
        column.order = order;
      }
    });
    
    await template.save();
    await template.populate('createdBy', 'name email');
    
    res.json(template);
  } catch (error) {
    console.error('Error reordering columns:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

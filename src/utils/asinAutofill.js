import { generateWithGemini, replacePlaceholders } from './gemini.js';
import { calculateStartPrice } from './pricingCalculator.js';
import { processImagePlaceholders } from './imageReplacer.js';
import { scrapeAmazonProductWithScraperAPI } from './scraperApiProduct.js';
import { scrapeAmazonProductWithScrapingdog } from './scrapingdogProduct.js';
import { trackApiUsage } from './apiUsageTracker.js';
import { getCachedAsinData, setCachedAsinData } from './asinCache.js';

/**
 * Fetch Amazon product data by ASIN
 * Uses ScraperAPI for ALL product data (Title, Brand, Description, Images, Price)
 * Replaces PAAPI entirely
 */
export async function fetchAmazonData(asin, region = 'US', options = {}) {
  const startTime = Date.now();
  const { forceRefresh = false } = options;
  
  try {
    console.log(`[fetchAmazonData] 🔍 Fetching product data for ASIN: ${asin} (${region})`);
    
    // Check cache first
    if (!forceRefresh) {
      const cached = getCachedAsinData(asin, region);
      if (cached) {
        const cacheTime = Date.now() - startTime;
        console.log(`[fetchAmazonData] ⚡ Cache hit for ${asin} (${region}, ${cacheTime}ms)`);
        return cached;
      }
    } else {
      console.log(`[fetchAmazonData] 🔄 Force refresh enabled for ${asin} (${region})`);
    }
    
    // Single provider call for ALL data. Provider is env-switchable so a bad
    // rollout can be reverted by flipping AMAZON_PRODUCT_PROVIDER on Render —
    // no code change needed. Both clients return the identical object shape.
    const provider = (process.env.AMAZON_PRODUCT_PROVIDER || 'scraperapi').toLowerCase();
    const scrapedData = provider === 'scrapingdog'
      ? await scrapeAmazonProductWithScrapingdog(asin, region)
      : await scrapeAmazonProductWithScraperAPI(asin, region);
    
    const responseTime = Date.now() - startTime;
    
    // Extract fields
    let { title, brand, price, description, images, color, compatibility, model, material, specialFeatures, size } = scrapedData;
    
    // Remove brand from title (maintain existing behavior)
    if (brand && brand !== 'Unbranded' && title.toLowerCase().includes(brand.toLowerCase())) {
      title = title.replace(new RegExp(brand, 'ig'), '').trim();
    }
    
    // Keep images as array (same as PAAPI format)
    const imagesArray = Array.isArray(images) ? images : [];
    
    console.log(`[fetchAmazonData] ✅ ${asin} (${region}) ${responseTime}ms | "${title.substring(0, 40)}..." | ${brand} | ${price} | ${imagesArray.length} imgs${color ? ` | color: ${color}` : ''}${compatibility ? ` | compat: ${compatibility.substring(0, 30)}` : ''}`);
    
    const result = {
      asin,
      title,
      price,
      brand,
      description,
      images: imagesArray, // Return as array (same as PAAPI)
      color: color || '',
      compatibility: compatibility || '',
      model: model || '',
      material: material || '',
      specialFeatures: specialFeatures || '',
      size: size || '',
      productInfo: scrapedData.rawData?.product_information || null,
      // Set only on a fresh Scrapingdog fetch that re-tried for missing
      // stock/delivery info; nulled when served from cache (no fetch = no retry)
      availabilityRetry: scrapedData.availabilityRetry || null,
      rawData: scrapedData // Store scraped data for debugging
    };
    
    // Cache the result — skip if description is empty, OR if the raw response
    // carries no stock/delivery info at all (buy-box widgets not rendered), so
    // the next request triggers a fresh scrape instead of serving a stale
    // incomplete entry (a cached info-less result would pin the precheck's
    // Stock/Delivery columns to "Unknown" for the whole cache TTL).
    const raw = scrapedData.rawData || {};
    // Complete = stock text present AND delivery info present (delivery not
    // required for out-of-stock products — Amazon shows none for those).
    const stockText = String(raw.availability_status || raw.purchase_options?.single_offer?.stock || '').trim().toLowerCase();
    const outOfStock = stockText.includes('unavailable') || stockText.includes('out of stock');
    const hasDeliveryInfo = Boolean(
      raw.shipping_time || raw.shipping_condition // ScraperAPI names
      || raw.shipping_info // Scrapingdog name
      || (Array.isArray(raw.delivery) && raw.delivery.length > 0)
      || (Array.isArray(raw.purchase_options?.single_offer?.delivery) && raw.purchase_options.single_offer.delivery.length > 0)
    );
    const hasAvailabilityInfo = Boolean(stockText) && (outOfStock || hasDeliveryInfo);
    if (result.description && hasAvailabilityInfo) {
      // Strip the retry marker before caching: a cache hit made no fetch, so
      // it must not re-report the original fetch's retry to the stats.
      setCachedAsinData(asin, { ...result, availabilityRetry: null }, region);
    } else if (!result.description) {
      console.log(`[fetchAmazonData] ⚠️ Skipping cache for ${asin} (no description) — will retry on next request`);
    } else {
      console.log(`[fetchAmazonData] ⚠️ Skipping cache for ${asin} (no stock/delivery info) — will retry on next request`);
    }
    
    return result;
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    console.error(`[fetchAmazonData] ❌ Failed to fetch data for ${asin}:`, error.message);
    throw error;
  }
}

/**
 * Apply field configurations to generate auto-fill data
 * Separates core eBay fields and custom columns
 * @param {Object} amazonData - Fetched Amazon product data
 * @param {Array} fieldConfigs - Field configuration array from template
 * @param {Object} pricingConfig - Optional pricing configuration for startPrice calculation
 * @param {Object} trackingContext - Optional usage metadata such as templateId and sellerId
 * @returns {Object} { coreFields, customFields, pricingCalculation }
 */
export async function applyFieldConfigs(amazonData, fieldConfigs, pricingConfig = null, trackingContext = {}) {
  const coreFields = {};
  const customFields = {};
  let pricingCalculation = null;

  // Placeholder data for AI prompts
  const placeholderData = {
    title: amazonData.title,
    brand: amazonData.brand,
    description: amazonData.description,
    price: amazonData.price,
    asin: amazonData.asin,
    product_information: amazonData.productInfo
      ? Object.entries(amazonData.productInfo)
          .filter(([, v]) => v !== null && v !== '' && v !== undefined)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\n')
      : ''
  };

  // Images are already an array (same as PAAPI format)
  const imagesArray = Array.isArray(amazonData.images) ? amazonData.images : [];

  // Separate configs by processing type for parallel execution
  const directConfigs = [];
  const aiConfigs = [];
  const disabledConfigs = [];

  for (const config of fieldConfigs) {
    if (!config.enabled) {
      disabledConfigs.push(config);
    } else if (config.source === 'direct') {
      // Process ALL direct mappings (both core and custom fields)
      directConfigs.push(config);
    } else if (config.source === 'ai') {
      // Process ALL AI configs (both core and custom fields)
      aiConfigs.push(config);
    }
  }

  // Compact summary: direct | AI | disabled field names
  console.log(`[ASIN: ${amazonData.asin}] direct: [${directConfigs.map(c => c.ebayField).join(', ')}] | AI: [${aiConfigs.map(c => c.ebayField).join(', ')}] | disabled: ${disabledConfigs.length}`);

  // Check if pricing calculator will override startPrice field config
  const startPriceConfig = fieldConfigs.find(c => c.ebayField === 'startPrice' && c.enabled);
  if (pricingConfig?.enabled && startPriceConfig) {
    console.log(`[ASIN: ${amazonData.asin}] pricing calc will override startPrice (was: ${startPriceConfig.source})`);
  }

  // Process disabled configs (apply default values immediately)
  for (const config of disabledConfigs) {
    if (config.defaultValue) {
      const targetObject = config.fieldType === 'custom' ? customFields : coreFields;
      targetObject[config.ebayField] = config.defaultValue;
    }
  }

  // Process direct mapping configs (fast, no API calls)
  for (const config of directConfigs) {
    const targetObject = config.fieldType === 'custom' ? customFields : coreFields;

    try {
      let value = amazonData[config.amazonField];

      // Apply transformations
      value = applyTransform(value, config.transform);

      // Apply image placeholder replacement for description field
      if (config.ebayField === 'description' && typeof value === 'string') {
        value = processImagePlaceholders(value, imagesArray);
      }

      targetObject[config.ebayField] = value;

      // Fallback to default value if mapping resulted in empty value
      if (!targetObject[config.ebayField] && config.defaultValue) {
        targetObject[config.ebayField] = config.defaultValue;
      }

    } catch (error) {
      console.error(`[ASIN: ${amazonData.asin}] Error processing direct mapping for ${config.ebayField}:`, error);
      targetObject[config.ebayField] = config.defaultValue || '';
    }
  }

  // Process AI configs in parallel for maximum speed
  if (aiConfigs.length > 0) {
    const aiPromises = aiConfigs.map(async (config) => {
      try {
        const processedPrompt = replacePlaceholders(
          config.promptTemplate,
          placeholderData
        );

        // Use higher token limit for description field to avoid truncation
        const maxTokens = config.ebayField === 'description' ? 2000 : 150;

        let generatedValue = await generateWithGemini(processedPrompt, {
          maxTokens,
          asin: amazonData.asin,
          fieldName: config.ebayField,
          fieldType: config.fieldType,
          aiRunId: trackingContext.aiRunId,
          aiRunStartedAt: trackingContext.aiRunStartedAt,
          templateId: trackingContext.templateId,
          sellerId: trackingContext.sellerId,
          userId: trackingContext.userId,
          ipAddress: trackingContext.ipAddress,
          ipSource: trackingContext.ipSource,
          forwardedFor: trackingContext.forwardedFor,
          userAgent: trackingContext.userAgent
        });

        // Auto-truncate based on field type:
        // - Title: 80 characters
        // - Description: No limit (full HTML content)
        // - All other fields (core + custom): 60 characters
        if (config.ebayField === 'title' && generatedValue.length > 80) {
          generatedValue = generatedValue.substring(0, 80);
        } else if (config.ebayField !== 'description' && config.ebayField !== 'title' && generatedValue.length > 60) {
          generatedValue = generatedValue.substring(0, 60);
        }

        // Apply image placeholder replacement for description field and description-like custom fields
        if ((config.ebayField === 'description' || config.ebayField.toLowerCase().includes('description')) && typeof generatedValue === 'string') {
          generatedValue = processImagePlaceholders(generatedValue, imagesArray);
        }

        return {
          config,
          value: generatedValue,
          success: true
        };

      } catch (error) {
        console.error(`[ASIN: ${amazonData.asin}] ❌ AI field "${config.ebayField}" failed: ${error.message} — using default "${config.defaultValue || ''}"`);
        return {
          config,
          value: config.defaultValue || '',
          success: false,
          error: error.message
        };
      }
    });

    // Wait for all AI generations to complete in parallel
    const aiResults = await Promise.all(aiPromises);

    // Apply AI results to target objects
    for (const result of aiResults) {
      const targetObject = result.config.fieldType === 'custom' ? customFields : coreFields;
      targetObject[result.config.ebayField] = result.value;

      // Critical check for title field (required for listing creation)
      if (result.config.ebayField === 'title' && !result.value) {
        console.error(`❌ CRITICAL [ASIN: ${amazonData.asin}]: Title generation failed - listing cannot be created`);
      }

      // Fallback to default value if generation resulted in empty value
      if (!targetObject[result.config.ebayField] && result.config.defaultValue) {
        targetObject[result.config.ebayField] = result.config.defaultValue;
      }
    }

    // Compact AI summary — one line showing per-field outcome
    const successCount = aiResults.filter(r => r.success).length;
    const failCount = aiResults.filter(r => !r.success).length;
    const fieldSummary = aiResults
      .map(r => `${r.config.ebayField}(${r.success ? String(r.value).length + 'ch' : 'FAIL'})`)
      .join(' | ');
    console.log(`[ASIN: ${amazonData.asin}] 🤖 AI ${successCount}/${aiResults.length} → ${fieldSummary}${failCount > 0 ? ` | FAILED: [${aiResults.filter(r => !r.success).map(r => r.config.ebayField).join(', ')}]` : ''}`);
  }

  // PRIORITY: If pricing config enabled, calculate startPrice (overrides field config)
  if (pricingConfig?.enabled) {
    if (!amazonData.price || amazonData.price.trim() === '') {
      console.warn(`[ASIN: ${amazonData.asin}] ⚠️ pricing: Amazon price not available — cannot calculate startPrice`);
      pricingCalculation = {
        enabled: true,
        error: 'Amazon price not available'
      };
    } else {
      try {
        // Extract numeric cost from Amazon price string (e.g., "$49.99" -> 49.99)
        const amazonCost = parseFloat(amazonData.price.replace(/[^0-9.]/g, ''));

        if (!isNaN(amazonCost) && amazonCost > 0) {
          const result = calculateStartPrice(pricingConfig, amazonCost);

          // Override startPrice regardless of field configs
          coreFields.startPrice = result.price.toFixed(2);

          pricingCalculation = {
            enabled: true,
            amazonCost: amazonData.price,
            calculatedStartPrice: result.price.toFixed(2),
            breakdown: result.breakdown
          };

          // Compact pricing log with tier info if applicable
          if (result.breakdown.profitTier?.enabled) {
            console.log(`[ASIN: ${amazonData.asin}] 💰 pricing: ${amazonData.price} → $${result.price.toFixed(2)} (tier: ${result.breakdown.profitTier.costRange}, +₹${result.breakdown.profitTier.profit})`);
          } else {
            console.log(`[ASIN: ${amazonData.asin}] 💰 pricing: ${amazonData.price} → $${result.price.toFixed(2)}`);
          }
        } else {
          console.warn(`[ASIN: ${amazonData.asin}] ⚠️ pricing: invalid price "${amazonData.price}" (parsed: ${amazonCost})`);
          pricingCalculation = {
            enabled: true,
            error: `Invalid price value: ${amazonData.price}`
          };
        }
      } catch (error) {
        console.error(`[ASIN: ${amazonData.asin}] ❌ pricing error: ${error.message}`);
        // Fall back to regular field config processing for startPrice
        pricingCalculation = {
          enabled: true,
          error: error.message
        };
      }
    }
  }

  // Compact final summary
  console.log(`[ASIN: ${amazonData.asin}] ✅ done — core: ${Object.keys(coreFields).length} [${Object.keys(coreFields).join(', ')}] | custom: ${Object.keys(customFields).length}${Object.keys(customFields).length > 0 ? ` [${Object.keys(customFields).join(', ')}]` : ''} | pricing: ${pricingCalculation ? 'on' : 'off'}`);

  return { coreFields, customFields, pricingCalculation };
}

/**
 * Apply transformations to values
 */
function applyTransform(value, transform) {
  if (!value) return '';
  
  switch (transform) {
    case 'pipeSeparated':
      return Array.isArray(value) ? value.join(' | ') : value;
      
    case 'removeSymbol':
      return typeof value === 'string' ? value.replace(/[$€£¥]/g, '') : value;
      
    case 'truncate80':
      return typeof value === 'string' ? value.substring(0, 80) : value;
      
    case 'truncate60':
      return typeof value === 'string' ? value.substring(0, 60) : value;
      
    case 'htmlFormat':
      // Convert plain text to simple HTML
      if (typeof value === 'string') {
        const lines = value.split('\n').filter(l => l.trim());
        return `<ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>`;
      }
      return value;
      
    case 'none':
    default:
      return value;
  }
}

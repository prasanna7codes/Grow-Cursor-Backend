// utils/asinResolver.js
//
// Resolves an eBay order line item to the Amazon ASIN it should be bought from.
//
// The chain is  order.lineItems[].sku → TemplateListing.customLabel → _asinReference,
// matched case-insensitively via the customLabel_asin_ci_lookup / baseCustomLabel_asin_ci_lookup
// indexes (both carry the en/strength-2 collation, so the query must supply it too
// or Mongo silently falls back to a collection scan).
//
// Variant SKUs carry a -<n> suffix (GRW25N4VFV-1), so an exact-label miss retries
// against baseCustomLabel. A SKU that is itself an ASIN short-circuits both lookups.

import TemplateListing from '../models/TemplateListing.js';

const ASIN_RE = /^B[0-9A-Z]{9}$/i;
const CI = { locale: 'en', strength: 2 };

export function isAsin(value) {
  return ASIN_RE.test(String(value || '').trim());
}

export function cleanAsin(value) {
  return String(value || '').trim().toUpperCase();
}

/**
 * Must produce exactly what TemplateListing's extractBaseCustomLabel stored in
 * baseCustomLabel, or the $in lookup below silently matches nothing. That is
 * everything before the FIRST hyphen — not a trailing-suffix strip, which would
 * diverge on any SKU containing more than one hyphen. routes/amazonStockChecks.js
 * getBaseLabel does the same thing for the same reason.
 */
export function baseSku(value) {
  return String(value || '').trim().split('-')[0].trim();
}

/**
 * Pulls every candidate SKU off an order, most specific first. eBay is inconsistent
 * about the casing of this field across the Fulfillment and Trading APIs, hence the
 * four spellings — the same set routes/ebay.js indexes on.
 */
export function skusFromOrder(order) {
  const out = [];
  for (const li of order?.lineItems || []) {
    for (const key of ['sku', 'SKU', 'sellerSku', 'legacySku']) {
      const v = li?.[key];
      if (v && !out.includes(v)) out.push(String(v).trim());
    }
  }
  return out;
}

/**
 * @returns {Promise<{ asin: string, source: 'sku'|null, sku: string, reason?: string }>}
 *          asin is '' when nothing matched; reason explains why for the operator.
 */
export async function resolveAsinForOrder(order) {
  const skus = skusFromOrder(order);
  if (!skus.length) {
    return { asin: '', source: null, sku: '', reason: 'Order has no SKU on any line item' };
  }

  // A SKU that is already an ASIN needs no lookup.
  for (const sku of skus) {
    if (isAsin(sku)) return { asin: cleanAsin(sku), source: 'sku', sku };
  }

  const rows = await TemplateListing.find({
    $or: [
      { customLabel: { $in: skus } },
      { baseCustomLabel: { $in: skus.map(baseSku) } }
    ],
    _asinReference: { $exists: true, $ne: '' }
  })
    .select('customLabel baseCustomLabel +_asinReference')
    .collation(CI)
    .lean();

  if (!rows.length) {
    return {
      asin: '', source: null, sku: skus[0],
      reason: `No TemplateListing with an ASIN for SKU ${skus[0]}`
    };
  }

  // Prefer an exact customLabel hit over a base-label hit: a variant SKU that
  // still has its own listing row points at the right variant's ASIN.
  const lower = skus.map(s => s.toLowerCase());
  const exact = rows.find(r => lower.includes(String(r.customLabel || '').toLowerCase()));
  const hit = exact || rows[0];

  return { asin: cleanAsin(hit._asinReference), source: 'sku', sku: hit.customLabel || skus[0] };
}

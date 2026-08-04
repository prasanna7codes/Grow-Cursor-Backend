import NodeCache from 'node-cache';

/**
 * ASIN Data Cache
 * Caches Amazon product data to avoid redundant ScraperAPI calls
 * 
 * Benefits:
 * - Instant results for repeated ASINs
 * - Reduces ScraperAPI quota usage
 * - Improves performance during testing/revisions
 */

// Cache TTL from environment (default: 1 hour = 3600 seconds)
const CACHE_TTL = parseInt(process.env.ASIN_CACHE_TTL) || 3600;
const CACHE_ENABLED = process.env.ENABLE_ASIN_CACHE !== 'false'; // Enabled by default

// The hard cap, and the point at which we start making room for it. node-cache
// does not evict: set() throws ECACHEFULL once maxKeys is reached, and keeps
// throwing until keys expire out. So we prune before getting there.
//
// The watermarks are percentages of the cap rather than separate literals —
// lowering the cap must not leave the watermark stranded above it. Overridable
// so the tests can reach the thresholds without inserting 10k entries.
export const MAX_KEYS = parseInt(process.env.ASIN_CACHE_MAX_KEYS) || 10000;
export const HIGH_WATER = Math.floor(MAX_KEYS * 0.7);
export const EVICT_BATCH = Math.max(1, Math.floor(MAX_KEYS * 0.1));

// Initialize cache
const asinCache = new NodeCache({
  stdTTL: CACHE_TTL,           // Standard TTL for all keys
  checkperiod: 120,             // Check for expired keys every 2 minutes
  useClones: false,             // Don't clone objects (faster for large data)
  maxKeys: MAX_KEYS
});

console.log(`[ASIN Cache] 🗄️ Initialized: ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'} (TTL: ${CACHE_TTL}s, Max: ${MAX_KEYS} ASINs, evicting ${EVICT_BATCH} at ${HIGH_WATER})`);

/**
 * Get cached ASIN data
 * @param {string} asin - Amazon ASIN
 * @param {string} [region='US'] - Marketplace region
 * @returns {Object|null} - Cached data or null if not found
 */
export function getCachedAsinData(asin, region = 'US') {
  if (!CACHE_ENABLED) return null;
  
  const key = `asin:${asin}_${region}`;
  const cached = asinCache.get(key);
  if (cached) {
    console.log(`[ASIN Cache] ✅ HIT: ${asin} (${region})`);
  }
  return cached || null;
}

/**
 * Drop the oldest entries once the key count crosses HIGH_WATER, so a write
 * never has to meet a full cache.
 *
 * "Oldest" is read off the expiry timestamp, which is a valid stand-in for
 * insertion order only because every key is written with the same stdTTL —
 * passing a per-key ttl to set() anywhere would silently scramble this ordering.
 * Ties (same-millisecond writes) keep insertion order, since keys() returns
 * insertion order and Array.sort is stable.
 *
 * A batch eviction rather than a flush: the entries closest to expiring are the
 * ones with the least value left, and crossing the watermark means heavy use —
 * exactly when a batch still in flight is about to re-request the warm entries a
 * flush would have thrown away. Amortized to one pass per EVICT_BATCH writes.
 *
 * @returns {number} - How many entries were evicted
 */
export function evictOldest() {
  const keys = asinCache.keys();
  if (keys.length < HIGH_WATER) return 0;

  const oldest = keys
    .map(key => [key, asinCache.getTtl(key) || 0])
    .sort((a, b) => a[1] - b[1])
    .slice(0, EVICT_BATCH)
    .map(([key]) => key);

  asinCache.del(oldest);
  console.log(`[ASIN Cache] ♻️ EVICTED: ${oldest.length} oldest of ${keys.length} (high water: ${HIGH_WATER})`);
  return oldest.length;
}

/**
 * Store ASIN data in cache
 * @param {string} asin - Amazon ASIN
 * @param {Object} data - Product data to cache
 * @param {string} [region='US'] - Marketplace region
 */
export function setCachedAsinData(asin, data, region = 'US') {
  if (!CACHE_ENABLED) return;

  evictOldest();

  const key = `asin:${asin}_${region}`;
  try {
    if (asinCache.set(key, data)) {
      console.log(`[ASIN Cache] 💾 STORED: ${asin} (${region})`);
    }
  } catch (error) {
    // node-cache throws ECACHEFULL instead of evicting, and the throw would
    // otherwise travel out of fetchAmazonData and surface as a failed ASIN row —
    // discarding a scrape that has already been paid for. The caller's result is
    // perfectly usable without a cache entry, so a failed write degrades to a
    // cache miss. Eviction above should keep us clear of the cap, so this
    // running at all means something upstream of it went wrong: log loudly.
    console.error(`[ASIN Cache] ⚠️ WRITE FAILED: ${asin} (${region}) at ${asinCache.keys().length}/${MAX_KEYS} keys — continuing uncached (${error.errorcode || error.name}: ${error.message})`);
  }
}

/**
 * Invalidate cache for specific ASIN (all regions)
 * @param {string} asin - Amazon ASIN
 */
export function invalidateAsinCache(asin) {
  const regions = ['US', 'UK', 'CA', 'AU'];
  let deleted = 0;
  regions.forEach(region => {
    deleted += asinCache.del(`asin:${asin}_${region}`);
  });
  if (deleted) {
    console.log(`[ASIN Cache] 🗑️ INVALIDATED: ${asin} (${deleted} region(s))`);
  }
  return deleted > 0;
}

/**
 * Clear entire cache
 */
export function clearAsinCache() {
  asinCache.flushAll();
  console.log(`[ASIN Cache] 🧹 CLEARED: All cached data removed`);
}

/**
 * Get cache statistics
 * @returns {Object} - Cache stats
 */
export function getAsinCacheStats() {
  const stats = asinCache.getStats();
  const keys = asinCache.keys();
  
  return {
    enabled: CACHE_ENABLED,
    ttl: CACHE_TTL,
    keys: keys.length,
    maxKeys: MAX_KEYS,
    highWater: HIGH_WATER,
    hits: stats.hits,
    misses: stats.misses,
    hitRate: stats.hits > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2) : 0,
    ksize: stats.ksize,
    vsize: stats.vsize
  };
}

/**
 * Warm cache with commonly used ASINs (optional)
 * @param {Array<{asin: string, data: Object}>} asinDataList
 */
export function warmAsinCache(asinDataList) {
  if (!CACHE_ENABLED) return;
  
  let warmed = 0;
  asinDataList.forEach(({ asin, data }) => {
    if (asinCache.set(`asin:${asin}`, data)) {
      warmed++;
    }
  });
  
  console.log(`[ASIN Cache] 🔥 WARMED: ${warmed} ASINs preloaded`);
  return warmed;
}

// Export cache instance for advanced usage
export default asinCache;

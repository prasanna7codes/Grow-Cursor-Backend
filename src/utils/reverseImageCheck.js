import axios from 'axios';
import pLimit from 'p-limit';
import AsinIpRisk from '../models/AsinIpRisk.js';
import { OEM_BRANDS, OEM_EMBLEM_WORDS, PRECHECK_BLOCKED_BRANDS, WATCH_BRANDS } from '../config/blockedBrands.js';
import { trackApiUsage } from './apiUsageTracker.js';

/**
 * Reverse-image IP risk check for listing photos.
 *
 * Brand owners find infringing listings with reverse-image search against
 * their own photo catalogues, not by reading titles. This runs the same kind
 * of search ourselves, before a listing exists (ASIN precheck) or against
 * listings already live (IP Risk Audit), and scores what comes back into:
 *
 *   high    – the photo is associated with a blocked or watch-listed brand,
 *             with an automaker's emblem, or with the Amazon brand outside
 *             Amazon itself; or (Vision only) it is a branded product whose
 *             exact photo is hosted on a site we do not recognise.
 *   medium  – strongly associated with an automaker name (worth a look for
 *             logos); or (Vision only) an unbranded product's exact photo is
 *             hosted on sites we do not recognise.
 *   low     – nothing ties the photo to a brand.
 *   unchecked / error – the check did not run or did not complete.
 *
 * Two providers, chosen by IP_RISK_PROVIDER (default auto):
 *
 *   scrapingdog – Google Lens through the Scrapingdog key already used for
 *                 Amazon data. Returns visually SIMILAR results (other shops'
 *                 listings of the same or a look-alike product), so the
 *                 evidence is what those results are titled, not where they
 *                 are hosted. 5 Scrapingdog credits per photo.
 *   vision      – Google Cloud Vision WEB_DETECTION. Returns pages carrying
 *                 EXACT copies of the photo, so hosting alone is evidence.
 *                 Needs a Google Cloud project with billing.
 *
 * Both are normalised into one shape and scored by the same pure function
 * (scoreWebDetection), whose `mode` — 'exact' or 'similar' — decides whether
 * host-based rules apply. Per-ASIN results are cached in AsinIpRisk and shared
 * by every flow, so a product is billed once no matter how many accounts list it.
 */

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
const SCRAPINGDOG_LENS_ENDPOINT = 'https://api.scrapingdog.com/google_lens';
const SCRAPINGDOG_LENS_CREDITS_PER_IMAGE = 5;
const REQUEST_TIMEOUT_MS = 20000;
const LENS_TIMEOUT_MS = 90000;
const LENS_MAX_ATTEMPTS = 3;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_IMAGE_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MIN_ENTITY_SCORE = 0.2;
// Lens hands back ~60 similar results; the tail is look-alikes from unrelated
// shops, so only the head is treated as describing THIS product.
const LENS_TOP_RESULTS = 15;
// Inside that head, the first few results are the ones Google considers the
// closest visual match, so a single naming there is evidence on its own.
const SIMILAR_STRONG_POSITIONS = 5;

export const LEVEL_RANK = { low: 0, unchecked: 0, error: 0, medium: 1, high: 2 };
export const PROVIDERS = ['scrapingdog', 'vision'];

// Hostnames where finding the photo says nothing about who owns it: the big
// marketplaces (a photo on Amazon is where we got it from), their image CDNs,
// social networks, search engines, and price trackers that mirror Amazon.
// Matched per hostname label so amazon.co.uk, amazon.de and m.media-amazon.com
// all count without listing every TLD.
const NEUTRAL_HOST_LABELS = new Set([
  'amazon', 'media-amazon', 'ssl-images-amazon', 'images-amazon', 'amazonaws',
  'ebay', 'ebayimg', 'ebaystatic', 'ebaydesc', 'picclick',
  'walmart', 'walmartimages',
  'aliexpress', 'alibaba', 'alicdn', '1688', 'temu', 'shein', 'wish', 'dhgate',
  'shopee', 'lazada', 'mercadolibre', 'mlstatic', 'rakuten', 'flipkart',
  'etsy', 'etsystatic', 'newegg', 'target', 'bestbuy', 'homedepot', 'lowes',
  'wayfair', 'overstock', 'costco', 'kijiji', 'craigslist',
  'pinterest', 'pinimg', 'facebook', 'fbcdn', 'instagram', 'cdninstagram',
  'twitter', 'twimg', 'tiktok', 'youtube', 'ytimg', 'reddit', 'redd', 'redditmedia',
  'google', 'googleusercontent', 'gstatic', 'bing', 'yahoo', 'yimg', 'duckduckgo',
  'wikipedia', 'wikimedia', 'imgur',
  'camelcamelcamel', 'keepa', 'fakespot', 'pricepulse', 'idealo', 'pricerunner',
  'pricespy', 'slickdeals', 'dealnews', 'pcpartpicker'
]);

const AMAZON_HOST_LABELS = new Set(['amazon', 'media-amazon', 'ssl-images-amazon', 'images-amazon']);

// Amazon "brand" values that name nobody.
const GENERIC_BRAND_TOKENS = new Set([
  '', 'generic', 'unbranded', 'no brand', 'nobrand', 'no-brand', 'n/a', 'na',
  'none', 'unknown', 'oem', 'universal', 'brand', 'other'
]);

let disabledWarningLogged = false;

function parseIntEnv(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseListEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Which provider a check would use right now, or null when none is usable.
 * 'auto' prefers Vision when its key exists (exact-copy evidence is stronger)
 * and otherwise falls back to the Scrapingdog key the app already has.
 */
export function resolveProvider(env = process.env) {
  const requested = String(env.IP_RISK_PROVIDER || 'auto').toLowerCase();
  if (requested === 'off' || requested === 'none') return null;
  if (requested === 'vision') return env.GOOGLE_VISION_API_KEY ? 'vision' : null;
  if (requested === 'scrapingdog') return env.SCRAPINGDOG_API_KEY ? 'scrapingdog' : null;
  if (env.GOOGLE_VISION_API_KEY) return 'vision';
  if (env.SCRAPINGDOG_API_KEY) return 'scrapingdog';
  return null;
}

export function isIpRiskCheckEnabled() {
  if (String(process.env.IP_RISK_CHECK_ENABLED || '').toLowerCase() === 'false') return false;
  return resolveProvider() !== null;
}

export function getIpRiskConfig(env = process.env) {
  const provider = resolveProvider(env);
  // Lens costs 5 credits a photo against the same Scrapingdog balance the
  // product scrapes draw on, so it defaults to the main image only.
  const defaultImages = provider === 'scrapingdog' ? 1 : 3;
  const parsedImages = parseInt(env.IP_RISK_IMAGES_PER_ASIN, 10);
  return {
    provider,
    apiKey: provider === 'vision' ? env.GOOGLE_VISION_API_KEY || '' : env.SCRAPINGDOG_API_KEY || '',
    imagesPerAsin: Number.isFinite(parsedImages) && parsedImages >= 0 ? parsedImages : defaultImages,
    creditsPerImage: provider === 'scrapingdog' ? SCRAPINGDOG_LENS_CREDITS_PER_IMAGE : 1,
    concurrency: Math.max(1, parseIntEnv('IP_RISK_CONCURRENCY', 6)),
    cacheDays: parseIntEnv('IP_RISK_CACHE_DAYS', 30),
    neutralDomains: parseListEnv('IP_RISK_NEUTRAL_DOMAINS'),
    watchBrands: [...WATCH_BRANDS, ...parseListEnv('IP_RISK_WATCH_BRANDS')],
    oemBrands: [...OEM_BRANDS, ...parseListEnv('IP_RISK_OEM_BRANDS')]
  };
}

// Process-wide limiter so several precheck batches and an audit cannot stack
// up against the provider quota at once. Sized lazily from env on first use.
let requestLimit = null;
function getRequestLimit() {
  if (!requestLimit) requestLimit = pLimit(getIpRiskConfig().concurrency);
  return requestLimit;
}

// ── Text and host helpers (pure) ─────────────────────────────────────────────

export function normalizeBrand(brand) {
  return String(brand || '')
    .toLowerCase()
    .replace(/[®™©]/g, ' ')
    .replace(/^\s*brand\s*:\s*/, '')
    .replace(/^\s*visit\s+the\s+/, '')
    .replace(/\s+store\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isNamedBrand(brand) {
  const value = normalizeBrand(brand);
  return value.length >= 2 && !GENERIC_BRAND_TOKENS.has(value);
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractHost(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hostLabels(host) {
  return String(host || '').toLowerCase().split('.').filter(Boolean);
}

export function isNeutralHost(host, extraNeutralDomains = []) {
  if (!host) return true;
  const labels = hostLabels(host);
  if (labels.some(label => NEUTRAL_HOST_LABELS.has(label))) return true;
  return extraNeutralDomains.some(entry => (
    host === entry || host.endsWith(`.${entry}`) || labels.includes(entry)
  ));
}

export function isAmazonHost(host) {
  return hostLabels(host).some(label => AMAZON_HOST_LABELS.has(label));
}

// Whole-word match for names of three or more characters; shorter names only
// ever match a hostname label exactly (see hostMatchesBrand), since "ap" or
// "3m" as a substring of prose proves nothing.
export function textContainsBrand(text, brand) {
  const needle = normalizeBrand(brand);
  if (needle.length < 3) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(needle).replace(/\s+/g, '\\s*')}([^a-z0-9]|$)`, 'i');
  return pattern.test(String(text || ''));
}

// apbands.com for "AP Bands", shop.spigen.com for "Spigen". The brand must be
// a whole hostname label, not a substring of one, so "otter" would not match
// "otterproducts" and "ap" would not match "apple".
export function hostMatchesBrand(host, brand) {
  const needle = compact(normalizeBrand(brand));
  if (needle.length < 2) return false;
  return hostLabels(host).some(label => compact(label) === needle);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function countTitlesWithBrand(titles, brand) {
  return titles.filter(title => textContainsBrand(title, brand)).length;
}

const EMBLEM_PATTERN = new RegExp(`(^|[^a-z0-9])(${OEM_EMBLEM_WORDS.map(escapeRegex).join('|')})([^a-z0-9]|$)`, 'i');

// ── Provider adapters ────────────────────────────────────────────────────────

/**
 * Normalise a Scrapingdog Google Lens response into the Vision-like shape the
 * scorer reads. Lens results are similar products, so every one is recorded
 * as a partial match, and the related searches — Google's own words for what
 * it saw — stand in for Vision's web entities.
 */
export function lensToWebDetection(data = {}) {
  const results = Array.isArray(data.lensResults || data.lens_results) ? (data.lensResults || data.lens_results) : [];
  const related = Array.isArray(data.related_searches) ? data.related_searches : [];

  return {
    mode: 'similar',
    pagesWithMatchingImages: results
      .filter(item => item && (item.link || item.source || item.title))
      .map(item => {
        // `source` is sometimes a display name ("eBay", "RealTruck") rather
        // than a hostname; the link is the reliable host.
        const host = extractHost(item.link) || (String(item.source || '').includes('.') ? String(item.source).toLowerCase().replace(/^www\./, '') : '');
        return {
          url: item.link || (host ? `https://${host}/` : ''),
          pageTitle: String(item.title || ''),
          partialMatchingImages: [{ url: item.original_thumbnail || item.thumbnail || '' }],
          position: Number(item.position) || 0
        };
      }),
    webEntities: related
      .filter(item => item?.title)
      .map(item => ({ description: String(item.title), score: 0.5 })),
    bestGuessLabels: []
  };
}

// ── Scoring (pure) ───────────────────────────────────────────────────────────

/**
 * Turn one reverse-image result into a risk assessment for that photo.
 *
 * @param {object} webDetection Vision `webDetection`, or lensToWebDetection() output
 * @param {object} options
 * @param {string} options.amazonBrand the listing's Amazon brand field
 * @param {'exact'|'similar'} [options.mode] defaults to webDetection.mode, then 'exact'
 * @param {string[]} [options.blockedBrands] brands that are never listed
 * @param {string[]} [options.watchBrands] rights owners known to enforce
 * @param {string[]} [options.oemBrands] automakers and device makers
 * @param {string[]} [options.neutralDomains] extra hosts to treat as marketplaces
 */
export function scoreWebDetection(webDetection = {}, options = {}) {
  const {
    amazonBrand = '',
    blockedBrands = PRECHECK_BLOCKED_BRANDS,
    watchBrands = WATCH_BRANDS,
    oemBrands = OEM_BRANDS,
    neutralDomains = []
  } = options;
  const mode = options.mode || webDetection.mode || 'exact';
  const similar = mode === 'similar';

  const bestGuessLabels = unique((webDetection.bestGuessLabels || []).map(item => String(item?.label || '').trim()));
  const webEntities = unique(
    (webDetection.webEntities || [])
      .filter(item => item?.description && (item.score == null || Number(item.score) >= MIN_ENTITY_SCORE))
      .map(item => String(item.description).trim())
  );

  let pageMatches = (webDetection.pagesWithMatchingImages || [])
    .filter(page => page?.url || page?.pageTitle)
    .map(page => ({
      url: String(page.url || ''),
      title: String(page.pageTitle || '').replace(/<[^>]+>/g, '').trim(),
      host: extractHost(page.url),
      kind: Array.isArray(page.fullMatchingImages) && page.fullMatchingImages.length > 0 ? 'full' : 'partial',
      position: Number(page.position) || 0
    }));
  if (similar) pageMatches = pageMatches.slice(0, LENS_TOP_RESULTS);

  const imageMatches = similar ? [] : [
    ...(webDetection.fullMatchingImages || []).map(item => ({ url: item?.url, kind: 'full' })),
    ...(webDetection.partialMatchingImages || []).map(item => ({ url: item?.url, kind: 'partial' }))
  ]
    .filter(item => item.url)
    .map(item => ({ ...item, host: extractHost(item.url) }));

  const allHosts = unique([...pageMatches, ...imageMatches].map(item => item.host));
  const externalHosts = allHosts.filter(host => !isNeutralHost(host, neutralDomains));
  const allTitles = pageMatches.map(page => page.title).filter(Boolean);
  const nonAmazonTitles = pageMatches.filter(page => page.title && !isAmazonHost(page.host)).map(page => page.title);
  const externalTitles = pageMatches.filter(page => page.title && !isNeutralHost(page.host, neutralDomains)).map(page => page.title);
  const labels = [...bestGuessLabels, ...webEntities];
  const labelText = labels.join('\n');
  const allText = [...labels, ...allTitles].join('\n');

  const reasons = [];
  let level = 'low';
  const raise = (next, reason) => {
    if (LEVEL_RANK[next] > LEVEL_RANK[level]) level = next;
    reasons.push(reason);
  };

  // Positions of the matching results, so similar mode can tell a closest
  // visual match from a look-alike further down the list.
  const titleIndexesFor = (brand) => pageMatches
    .map((page, index) => (page.title && textContainsBrand(page.title, brand) ? index : -1))
    .filter(index => index >= 0);

  // Blocked brands count wherever they show up, Amazon page titles included:
  // these are never listable, so any association is worth surfacing.
  const blockedHits = unique(blockedBrands.filter(brand => (
    textContainsBrand(allText, brand) || allHosts.some(host => hostMatchesBrand(host, brand))
  )));
  if (blockedHits.length > 0) raise('high', `Photo associated with blocked brand: ${blockedHits.join(', ')}`);

  // Watch-listed rights owners. In similar mode the tail of the result list is
  // other shops' look-alikes — a competitor brand named once down there says
  // nothing about THIS product — so it takes a closest-match result, two
  // separate titles, or Google's own words for the image.
  const watchHits = unique(watchBrands.filter(brand => {
    if (blockedHits.includes(brand)) return false;
    if (allHosts.some(host => hostMatchesBrand(host, brand))) return true;
    if (textContainsBrand(labelText, brand)) return true;
    const indexes = titleIndexesFor(brand);
    if (!similar) return indexes.length > 0;
    return indexes.length >= 2 || indexes.some(index => index < SIMILAR_STRONG_POSITIONS);
  }));
  if (watchHits.length > 0) raise('high', `Photo associated with rights owner: ${watchHits.join(', ')}`);

  // Automakers and device makers: a mention alone is how compatible
  // accessories are described, so it takes an emblem word or repetition.
  const oemHits = [];
  oemBrands.forEach(brand => {
    const matchingTitles = allTitles.filter(title => textContainsBrand(title, brand));
    const inLabels = textContainsBrand(labelText, brand);
    if (matchingTitles.length === 0 && !inLabels) return;
    const emblemTitle = matchingTitles.find(title => EMBLEM_PATTERN.test(title));
    if (emblemTitle) {
      oemHits.push(brand);
      raise('high', `Matching results describe a ${brand} emblem/logo product: "${emblemTitle.slice(0, 80)}"`);
    } else if (matchingTitles.length >= 3 || (inLabels && matchingTitles.length >= 1)) {
      oemHits.push(brand);
      raise('medium', `Strongly associated with ${brand} (${matchingTitles.length} matching titles${inLabels ? ', Google label' : ''}); check the photos for logos`);
    }
  });

  // The Amazon brand only counts outside Amazon's own pages, whose titles
  // always carry it; otherwise every branded product would score high on
  // nothing more than its own listing. Similar-product results are noisier
  // than exact copies, so they need two independent titles.
  const brandNamed = isNamedBrand(amazonBrand);
  const brand = normalizeBrand(amazonBrand);
  if (brandNamed) {
    const brandHosts = externalHosts.filter(host => hostMatchesBrand(host, brand));
    const titlePool = similar ? nonAmazonTitles : externalTitles;
    const titleHits = countTitlesWithBrand(titlePool, brand);
    if (brandHosts.length > 0) {
      raise('high', `Photo hosted on the brand's own site: ${brandHosts.join(', ')}`);
    } else if (titleHits >= (similar ? 2 : 1)) {
      raise('high', `Photo matches ${titleHits} listing(s) elsewhere titled with the Amazon brand "${amazonBrand}"`);
    } else if (textContainsBrand(labelText, brand)) {
      raise('high', `Google associates this photo with the Amazon brand "${amazonBrand}"`);
    }
  }

  // Exact copies hosted off-marketplace mean somebody owns this photo. Similar
  // results are other shops' look-alikes and prove nothing about ownership.
  if (!similar && externalHosts.length > 0) {
    if (brandNamed) {
      raise('high', `Branded product ("${amazonBrand}") whose photo is also hosted on: ${externalHosts.slice(0, 5).join(', ')}`);
    } else if (LEVEL_RANK[level] < LEVEL_RANK.medium) {
      raise('medium', `Photo also hosted on: ${externalHosts.slice(0, 5).join(', ')}`);
    }
  }

  if (level === 'low') {
    reasons.push(
      pageMatches.length > 0 || allHosts.length > 0
        ? (similar ? 'Similar listings found; none tie the photo to a brand' : 'Photo only found on marketplaces; no brand association detected')
        : 'No matching results for this photo'
    );
    if (brandNamed) reasons.push(`Amazon brand is "${amazonBrand}"; treat as brand-owned photos if that seller enforces`);
  }

  return {
    level,
    mode,
    reasons,
    matchedDomains: similar ? [] : externalHosts,
    allDomains: allHosts,
    brandHits: unique([...blockedHits, ...watchHits, ...oemHits]),
    bestGuessLabels,
    webEntities,
    pageMatches
  };
}

/**
 * Fold per-image assessments into one for the ASIN: the worst level wins and
 * the evidence is unioned so the operator sees everything that fired.
 */
export function combineImageAssessments(imageResults = []) {
  const scored = imageResults.filter(result => result && result.level && result.level !== 'error');
  const failed = imageResults.filter(result => result && result.level === 'error');

  if (scored.length === 0) {
    return {
      level: failed.length > 0 ? 'error' : 'unchecked',
      reasons: failed.length > 0 ? unique(failed.map(result => result.error)) : ['No images to check'],
      matchedDomains: [],
      brandHits: [],
      bestGuessLabels: []
    };
  }

  const level = scored.reduce((worst, result) => (
    LEVEL_RANK[result.level] > LEVEL_RANK[worst] ? result.level : worst
  ), 'low');

  // Only keep the reasons that explain the final level, so a low-risk photo's
  // "nothing found" does not sit next to another photo's brand match.
  const reasons = unique(
    scored
      .filter(result => result.level === level)
      .flatMap(result => result.reasons || [])
  );
  if (failed.length > 0) {
    reasons.push(`${failed.length} image(s) could not be checked`);
  }

  return {
    level,
    reasons,
    matchedDomains: unique(scored.flatMap(result => result.matchedDomains || [])),
    brandHits: unique(scored.flatMap(result => result.brandHits || [])),
    bestGuessLabels: unique(scored.flatMap(result => result.bestGuessLabels || []))
  };
}

// ── Google Cloud Vision client ───────────────────────────────────────────────

function describeVisionError(error) {
  const status = error.response?.status;
  const detail = error.response?.data?.error?.message || error.message;
  if (status === 400) return `Google Vision rejected the request: ${detail}`;
  if (status === 403) return `Google Vision refused the key (API not enabled, billing off, or key restricted): ${detail}`;
  if (status === 429) return 'Google Vision quota exceeded';
  if (error.code === 'ECONNABORTED') return 'Google Vision request timed out';
  return `Google Vision ${status || 'request'} failed: ${detail}`;
}

async function annotate(apiKey, image) {
  let response;
  try {
    response = await axios.post(
      `${VISION_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
      {
        requests: [{
          image,
          features: [{ type: 'WEB_DETECTION', maxResults: 25 }]
        }]
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
  } catch (error) {
    throw new Error(describeVisionError(error));
  }

  const result = response.data?.responses?.[0] || {};
  if (result.error) {
    // A per-image error inside a 200 means the request was fine but Google
    // could not use this picture (usually: could not fetch the URL).
    const error = new Error(result.error.message || 'Google Vision could not process the image');
    error.perImage = true;
    throw error;
  }
  return { ...(result.webDetection || {}), mode: 'exact' };
}

async function downloadImageBase64(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: IMAGE_DOWNLOAD_TIMEOUT_MS,
    maxContentLength: MAX_IMAGE_DOWNLOAD_BYTES,
    maxBodyLength: MAX_IMAGE_DOWNLOAD_BYTES,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ip-risk-check/1.0)' }
  });
  return Buffer.from(response.data).toString('base64');
}

async function detectWithVision(imageUrl, apiKey) {
  try {
    return await annotate(apiKey, { source: { imageUri: imageUrl } });
  } catch (error) {
    if (!error.perImage) throw error;
    const content = await downloadImageBase64(imageUrl);
    return annotate(apiKey, { content });
  }
}

// ── Scrapingdog Google Lens client ───────────────────────────────────────────

function describeLensError(error) {
  const status = error.response?.status;
  const detail = error.response?.data?.message || error.response?.data?.error || error.message;
  if (status === 401 || status === 403) return `Scrapingdog refused the key for Google Lens: ${detail}`;
  if (status === 429) return 'Scrapingdog concurrency or credit limit hit';
  if (error.code === 'ECONNABORTED') return 'Scrapingdog Google Lens request timed out';
  return `Scrapingdog Google Lens ${status || 'request'} failed: ${detail}`;
}

function isRetryableLensError(error) {
  const status = error.response?.status;
  return error.code === 'ECONNABORTED' || status === 429 || status === 408 || (status >= 500 && status < 600);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function detectWithScrapingdog(imageUrl, apiKey) {
  let lastError = null;
  for (let attempt = 1; attempt <= LENS_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await axios.get(SCRAPINGDOG_LENS_ENDPOINT, {
        params: { api_key: apiKey, url: imageUrl },
        timeout: LENS_TIMEOUT_MS
      });
      const data = response.data;
      if (!data || typeof data !== 'object') throw new Error('Scrapingdog Google Lens returned no JSON');
      if (!Array.isArray(data.lens_results)) {
        const message = data.message || data.error;
        if (message) throw new Error(`Scrapingdog Google Lens: ${message}`);
      }
      return lensToWebDetection(data);
    } catch (error) {
      lastError = error;
      if (!isRetryableLensError(error) || attempt === LENS_MAX_ATTEMPTS) break;
      // Scrapingdog's transient failures come in short bursts; a jittered
      // pause outlives most of them without holding a request slot.
      await sleep(Math.round(2000 * attempt * (0.6 + Math.random() * 0.8)));
    }
  }
  throw new Error(describeLensError(lastError));
}

/**
 * Run the reverse-image search for one photo with the configured provider.
 */
export async function detectWebMatches(imageUrl, { provider, apiKey } = {}) {
  const config = getIpRiskConfig();
  const chosen = provider || config.provider;
  const key = apiKey || (chosen === config.provider ? config.apiKey : '');

  if (chosen === 'vision') {
    if (!key) throw new Error('GOOGLE_VISION_API_KEY is not set');
    return detectWithVision(imageUrl, key);
  }
  if (chosen === 'scrapingdog') {
    if (!key) throw new Error('SCRAPINGDOG_API_KEY is not set');
    return detectWithScrapingdog(imageUrl, key);
  }
  throw new Error('No reverse-image provider configured');
}

// ── Orchestration ────────────────────────────────────────────────────────────

function toPublicResult(doc, cached) {
  return {
    asin: doc.asin,
    level: doc.level,
    reasons: doc.reasons || [],
    matchedDomains: doc.matchedDomains || [],
    brandHits: doc.brandHits || [],
    bestGuessLabels: doc.bestGuessLabels || [],
    amazonBrand: doc.amazonBrand || '',
    imagesChecked: doc.imagesChecked || 0,
    images: doc.images || [],
    provider: doc.provider || '',
    checkedAt: doc.checkedAt,
    cached: Boolean(cached)
  };
}

export function normalizeImageList(images) {
  if (!Array.isArray(images)) return [];
  return unique(images.map(value => String(value || '').trim()).filter(value => /^https?:\/\//i.test(value)));
}

function disabledResult(asin) {
  if (!disabledWarningLogged) {
    disabledWarningLogged = true;
    console.warn('[IP Risk] Reverse-image check disabled: no provider (set SCRAPINGDOG_API_KEY or GOOGLE_VISION_API_KEY; IP_RISK_CHECK_ENABLED / IP_RISK_PROVIDER may also be off)');
  }
  return {
    asin,
    level: 'unchecked',
    reasons: ['Reverse-image check not configured'],
    matchedDomains: [],
    brandHits: [],
    bestGuessLabels: [],
    imagesChecked: 0,
    images: [],
    provider: '',
    cached: false
  };
}

/**
 * Read a fresh cached verdict for an ASIN, or null. Shared by the precheck
 * (which checks before spending provider calls) and the audit (which reuses a
 * product's verdict for every account that lists it).
 */
export async function getCachedAsinIpRisk(asin, { cacheDays } = {}) {
  const cleanAsin = String(asin || '').trim().toUpperCase();
  if (!cleanAsin) return null;
  const days = Number.isFinite(cacheDays) ? cacheDays : getIpRiskConfig().cacheDays;

  try {
    const cached = await AsinIpRisk.findOne({ asin: cleanAsin }).lean();
    if (!cached || ['error', 'unchecked'].includes(cached.level)) return null;
    const freshUntil = new Date(cached.checkedAt).getTime() + days * 86400000;
    if (Date.now() >= freshUntil) return null;
    return toPublicResult(cached, true);
  } catch (error) {
    console.warn(`[IP Risk] Cache lookup failed for ${cleanAsin}:`, error.message);
    return null;
  }
}

/**
 * Send a set of photos through the provider and fold the answers into one
 * verdict. No caching here: callers decide what the verdict is keyed by (an
 * ASIN for the precheck, a listing for the audit). Never throws for a single
 * photo's failure; only a total failure surfaces as level 'error'.
 *
 * @param {object} params
 * @param {string[]} params.images photo URLs, most important first
 * @param {string} params.amazonBrand
 * @param {string} [params.label] used in logs (an ASIN or item id)
 * @param {number} [params.maxImages] defaults to the provider's IP_RISK_IMAGES_PER_ASIN
 * @param {object} [params.usage] usage-tracking context
 */
export async function assessImageSet({ images, amazonBrand = '', label = '', maxImages, usage = {} } = {}) {
  const config = getIpRiskConfig();
  const cap = Number.isFinite(maxImages) ? maxImages : config.imagesPerAsin;
  const imageUrls = normalizeImageList(images).slice(0, cap);
  const startTime = Date.now();
  const limit = getRequestLimit();
  const scoreOptions = {
    amazonBrand,
    neutralDomains: config.neutralDomains,
    watchBrands: config.watchBrands,
    oemBrands: config.oemBrands
  };

  const imageResults = await Promise.all(imageUrls.map(url => limit(async () => {
    try {
      const webDetection = await detectWebMatches(url, { provider: config.provider, apiKey: config.apiKey });
      const scored = scoreWebDetection(webDetection, scoreOptions);
      return {
        url,
        level: scored.level,
        reasons: scored.reasons,
        matchedDomains: scored.matchedDomains,
        brandHits: scored.brandHits,
        bestGuessLabels: scored.bestGuessLabels,
        webEntities: scored.webEntities.slice(0, 15),
        pageMatches: scored.pageMatches.slice(0, 10).map(page => ({ url: page.url, title: page.title, host: page.host, kind: page.kind })),
        error: ''
      };
    } catch (error) {
      console.warn(`[IP Risk] ${label || 'image'} check failed (${url}):`, error.message);
      return { url, level: 'error', reasons: [], matchedDomains: [], brandHits: [], bestGuessLabels: [], webEntities: [], pageMatches: [], error: error.message };
    }
  })));

  const combined = combineImageAssessments(imageResults);
  const succeeded = imageResults.filter(result => result.level !== 'error').length;
  const durationMs = Date.now() - startTime;

  if (imageUrls.length > 0) {
    trackApiUsage({
      service: config.provider === 'scrapingdog' ? 'Scrapingdog' : 'GoogleVision',
      asin: /^[A-Z0-9]{10}$/.test(String(label || '').toUpperCase()) ? String(label).toUpperCase() : undefined,
      creditsUsed: imageUrls.length * config.creditsPerImage,
      success: combined.level !== 'error',
      errorMessage: combined.level === 'error' ? combined.reasons.join('; ') : undefined,
      responseTime: durationMs,
      extractedFields: ['webDetection'],
      fieldName: 'ip_risk_reverse_image',
      fieldType: usage.fieldType || 'precheck',
      model: config.provider === 'scrapingdog' ? 'google_lens' : 'vision_web_detection',
      ...usage
    }).catch(error => console.error('[IP Risk] Usage tracking failed:', error.message));
  }

  console.log(`[IP Risk] ${label || 'images'} → ${combined.level} via ${config.provider} (${succeeded}/${imageUrls.length} images, ${durationMs}ms)${combined.brandHits.length ? ` brands: ${combined.brandHits.slice(0, 3).join(', ')}` : ''}${combined.matchedDomains.length ? ` hosts: ${combined.matchedDomains.slice(0, 3).join(', ')}` : ''}`);

  return { combined, imageResults, imageUrls, succeeded, durationMs, provider: config.provider };
}

/**
 * Persist a verdict against an ASIN so every later flow reuses it.
 */
export async function saveAsinIpRisk(asin, { combined, imageResults = [], succeeded = 0, amazonBrand = '', title = '', provider = '' }) {
  const cleanAsin = String(asin || '').trim().toUpperCase();
  const doc = {
    asin: cleanAsin,
    level: combined.level,
    reasons: combined.reasons,
    matchedDomains: combined.matchedDomains,
    brandHits: combined.brandHits,
    bestGuessLabels: combined.bestGuessLabels,
    amazonBrand: String(amazonBrand || ''),
    title: String(title || '').slice(0, 300),
    imagesChecked: succeeded,
    images: imageResults,
    provider: provider === 'scrapingdog' ? 'scrapingdog-lens' : 'google-vision',
    checkedAt: new Date()
  };

  try {
    await AsinIpRisk.findOneAndUpdate({ asin: cleanAsin }, { $set: doc }, { upsert: true, new: true });
  } catch (error) {
    console.warn(`[IP Risk] Failed to cache result for ${cleanAsin}:`, error.message);
  }

  return toPublicResult(doc, false);
}

/**
 * Assess one ASIN from its Amazon photos, reusing a fresh cached verdict when
 * there is one. Never throws: a failed check comes back as level 'error' so a
 * precheck row is still emitted.
 *
 * @param {object} params
 * @param {string} params.asin
 * @param {string[]} params.images Amazon photo URLs, main image first
 * @param {string} params.amazonBrand
 * @param {string} [params.title]
 * @param {boolean} [params.force] re-check even if a fresh cached result exists
 * @param {object} [params.usage] usage-tracking context (templateId, sellerId, userId, …)
 */
export async function assessAsinIpRisk({ asin, images, amazonBrand = '', title = '', force = false, usage = {} } = {}) {
  const cleanAsin = String(asin || '').trim().toUpperCase();

  if (!isIpRiskCheckEnabled()) return disabledResult(cleanAsin);

  if (!force) {
    const cached = await getCachedAsinIpRisk(cleanAsin);
    if (cached) return cached;
  }

  const assessment = await assessImageSet({ images, amazonBrand, label: cleanAsin, usage });
  return saveAsinIpRisk(cleanAsin, { ...assessment, amazonBrand, title });
}

/**
 * The subset of an assessment the precheck row carries to the client.
 */
export function toClientIpRisk(result) {
  if (!result) return null;
  return {
    level: result.level,
    reasons: result.reasons || [],
    matchedDomains: result.matchedDomains || [],
    brandHits: result.brandHits || [],
    bestGuessLabels: (result.bestGuessLabels || []).slice(0, 5),
    imagesChecked: result.imagesChecked || 0,
    cached: Boolean(result.cached)
  };
}

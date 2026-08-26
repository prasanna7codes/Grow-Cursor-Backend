import OpenAI from 'openai';
import { trackApiUsage } from './apiUsageTracker.js';

/**
 * Title rephrasing, shared by the Rephrase button in ASIN Review
 * (routes/ai.js) and the automatic cross-seller uniqueness pass
 * (utils/listingUniqueness.js, called from the bulk pipeline).
 *
 * It lives here so both paths use one prompt. When the operator clicks
 * Rephrase by hand and when the pipeline rephrases a colliding title, the
 * result should come out of the same instructions — otherwise the automatic
 * pass would drift away from what the operator has learned to expect.
 */

const MODEL = 'gpt-4o-mini';
const MAX_TITLE_LENGTH = 80;

// Lazy singleton — instantiated on first use so dotenv has already run.
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_FITMENT_API_KEY });
  }
  return _openai;
}

/**
 * @param {Object} opts
 * @param {string} opts.currentTitle - the title to rewrite (required)
 * @param {string} [opts.sourceTitle] - Amazon title, context only
 * @param {string} [opts.brand]
 * @param {string} [opts.color]
 * @param {string} [opts.compatibility]
 * @param {string} [opts.vehicleMentions] - verified models to work in
 * @param {number} [opts.temperature] - raised on retries so a second attempt
 *                                      does not reproduce the first
 * @param {Object} [opts.usageContext] - templateId/sellerId/userId etc. for the
 *                                       AI usage report; omitted for ad-hoc calls
 * @returns {Promise<string>} the rephrased title, never longer than 80 chars
 */
export async function rephraseTitle({
  currentTitle = '',
  sourceTitle = '',
  brand = '',
  color = '',
  compatibility = '',
  vehicleMentions = '',
  temperature = 0.7,
  usageContext = null
}) {
  if (!currentTitle) throw new Error('currentTitle is required');

  const vehicleSection = vehicleMentions
    ? `\nVerified vehicle compatibility (from customer reviews): ${vehicleMentions}\nYou MUST include 1–2 of these models/years in the rephrased title. Shorten other parts of the title if needed to stay within the character limit.`
    : '';

  const prompt = `You are an eBay listing SEO expert.
Rephrase the following eBay product title. The rephrased title must:
- Convey the same product and key attributes
- Use different word order or synonyms compared to the original
- Be strictly between 75 and 80 characters (including spaces) — not shorter, not longer
- Contain no markdown, quotes, or extra commentary — return only the plain title text

Amazon product title (context only): ${sourceTitle}
Brand: ${brand}
Color: ${color}
Compatibility: ${compatibility}${vehicleSection}

eBay title to rephrase: ${currentTitle}`;

  const startedAt = Date.now();
  const completion = await getOpenAI().chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: MODEL,
    temperature,
    max_tokens: 60
  });

  let rephrased = completion.choices[0]?.message?.content?.trim() || '';
  // Strip any surrounding quotes the model may add
  rephrased = rephrased.replace(/^["']|["']$/g, '').trim();
  // Hard safety truncation
  if (rephrased.length > MAX_TITLE_LENGTH) {
    rephrased = rephrased.substring(0, MAX_TITLE_LENGTH);
  }

  // The automatic pass can fire many times per batch, so its spend has to land
  // in the same report as every other AI call rather than going unattributed.
  if (usageContext) {
    trackApiUsage({
      service: 'OpenAI',
      model: MODEL,
      success: true,
      responseTime: Date.now() - startedAt,
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens,
      fieldName: 'title',
      fieldType: 'rephrase',
      ...usageContext
    }).catch(err => console.error('[Usage Tracker] Failed to track rephrase:', err.message));
  }

  return rephrased;
}

/**
 * A rephrase function shaped for resolveUniqueTitle(), which calls it as
 * (currentTitle, attempt). Temperature climbs with each attempt so a retry
 * explores instead of returning the same colliding rewrite again.
 */
export function makeUniquenessRephraser({ sourceData = {}, usageContext = null } = {}) {
  return async (currentTitle, attempt) => rephraseTitle({
    currentTitle,
    sourceTitle: sourceData.title || '',
    brand: sourceData.brand || '',
    color: sourceData.color || '',
    compatibility: sourceData.compatibility || '',
    temperature: Math.min(1.0, 0.7 + (attempt - 1) * 0.15),
    usageContext
  });
}

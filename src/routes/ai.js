

import express from 'express';
import OpenAI from 'openai';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import AiFitmentUsage from '../models/AiFitmentUsage.js';
import User from '../models/User.js';
import ListingTemplate from '../models/ListingTemplate.js';
import { generateWithGemini, replacePlaceholders } from '../utils/gemini.js';

const router = express.Router();

// Lazy singleton — instantiated on first request so dotenv has already run
let _openai = null;
function getOpenAI() {
    if (!_openai) {
        // Use a dedicated key for fitment AI if configured, else fall back to the default
        const apiKey = process.env.OPENAI_FITMENT_API_KEY;
        _openai = new OpenAI({ apiKey });
    }
    return _openai;
}

// ============================================
// AI SUGGEST FITMENT
// POST /api/ai/suggest-fitment
// Body: { title: string, description: string }
// Returns: { make, model, startYear, endYear, allFitments }
// ============================================
/**
 * @swagger
 * /ai/suggest-fitment:
 *   post:
 *     tags: [AI]
 *     summary: Suggest vehicle fitments from a product listing
 *     description: "Sends the product title and description to GPT-4o-mini and extracts all vehicle make/model/year/trim/engine fitments. Tracks usage in AiFitmentUsage."
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *                 description: Raw HTML or plain text product description
 *     responses:
 *       200:
 *         description: Best fitment plus full array
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AiFitmentSuggestion'
 *       400:
 *         description: title or description is required
 *       500:
 *         description: AI request failed or parse error
 */
router.post('/suggest-fitment', requireAuth, async (req, res) => {
    try {
        const { title = '', description = '' } = req.body;

        if (!title && !description) {
            return res.status(400).json({ error: 'title or description is required' });
        }

        // Strip HTML tags, then cut at boilerplate phrases that appear mid-description
        // (shipping promos, seller banners, store links — all irrelevant for fitment)
        const BOILERPLATE_SIGNALS = [
            'Top Seller', 'Fast, Reliable Shipping', 'Always Free', '1-Day Processing',
            'Questions?', "We're Happy to Help", 'Buy with Confidence',
            'Ship from USA', 'Free & Fast Shipping', '30 Days Return',
            'PLEASE VISIT OUR STORE', 'Thank you for shopping',
            'All communication is handled', 'eBay\'s messaging platform',
            'Orders ship within', 'carefully inspected before shipping',
        ];
        let rawText = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        // Find the earliest boilerplate cut point
        let cutAt = rawText.length;
        for (const signal of BOILERPLATE_SIGNALS) {
            const idx = rawText.indexOf(signal);
            if (idx !== -1 && idx < cutAt) cutAt = idx;
        }
        const cleanDescription = rawText.slice(0, cutAt).trim().slice(0, 500);

        const prompt = `You are an automotive parts expert. Extract all vehicle fitments from this eBay listing.

IMPORTANT: Focus PRIMARILY on the Description for extracting fitment data. The Title may contain SEO keywords that are not actual fitment info. Use the Title only as supplementary context when the Description lacks detail.

Description: ${cleanDescription}
Title: ${title}

Return ONLY a valid JSON array (no markdown, no explanation) where each object has:
- "make": string (e.g. "Toyota")
- "model": string (e.g. "Camry")
- "startYear": string or null (e.g. "2010")
- "endYear": string or null (same as startYear if only one year)
- "suggestedTrims": array of strings (e.g. ["XLE", "XSE"]). Specific trim levels explicitly mentioned as COMPATIBLE in the title and description. Do NOT include trims that are explicitly excluded.
- "excludedTrims": array of strings (e.g. ["LE", "Limited"]). Specific trim levels explicitly mentioned as NOT COMPATIBLE or EXCLUDED (e.g., using words like "except", "not", "exclude", "does not fit").
- "suggestedEngines": array of strings (e.g. ["2.0L", "2.5L", "3.3L"]). Specific engines explicitly mentioned as COMPATIBLE in the title and description. Do NOT include engines that are explicitly excluded.
- "excludedEngines": array of strings (e.g. ["1.6L"]). Specific engines explicitly mentioned as NOT COMPATIBLE or EXCLUDED.

Rules:
- If a year range is EXPLICITLY stated like "2008-2013", use startYear="2008" endYear="2013"
- If a single year is EXPLICITLY stated like "2005", use startYear="2005" endYear="2005"
- CRITICAL: If NO year is explicitly mentioned in the description or title for a fitment, you MUST set startYear and endYear to null. Do NOT guess, infer, or assume years based on the vehicle generation or your knowledge.
- Only include make and model entries where you are confident based on the text
- Do not invent or assume any data not explicitly present in the description or title
- Use the most specific model name mentioned (e.g. "F-150" not just "F-Series")
- If the description lists a compatibility/fitment table, extract all entries from it

Example output: [{"make":"Lexus","model":"IS F","startYear":"2008","endYear":"2013","suggestedTrims":[],"excludedTrims":[],"suggestedEngines":[],"excludedEngines":[]},{"make":"Toyota","model":"Camry","startYear":null,"endYear":null,"suggestedTrims":["XLE"],"excludedTrims":["LE"],"suggestedEngines":["2.5L"],"excludedEngines":["3.5L"]}]`;

        const completion = await getOpenAI().chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: 3000
        });

        const raw = completion.choices[0]?.message?.content?.trim() || '[]';

        let allFitments = [];
        try {
            // Strip any accidental markdown code fences
            let cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();

            // In case the model accidentally outputs extra characters at the end
            const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
            if (arrayMatch) {
                cleaned = arrayMatch[0];
            }

            allFitments = JSON.parse(cleaned);
            if (!Array.isArray(allFitments)) allFitments = [];
        } catch (parseErr) {
            console.error('[AI Suggest Fitment] Failed to parse OpenAI response:', raw);
            return res.status(500).json({ error: 'AI returned unexpected format', raw });
        }

        // Track AI usage
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        AiFitmentUsage.create({
            userId: req.user.userId,
            action: 'ai_suggest',
            itemCount: 1,
            hadData: allFitments.length > 0,
            date: dateStr,
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            day: now.getDate()
        }).catch(err => console.error('[AI Usage Track] Error:', err.message));

        if (allFitments.length === 0) {
                return res.json({
                    make: null,
                    model: null,
                    startYear: null,
                    endYear: null,
                    suggestedTrims: [],
                    excludedTrims: [],
                    suggestedEngines: [],
                    excludedEngines: [],
                    allFitments: []
                });
        }

        // Pick the fitment with the longest year gap
        const best = allFitments.reduce((prev, curr) => {
            const prevGap = Number(prev.endYear) - Number(prev.startYear);
            const currGap = Number(curr.endYear) - Number(curr.startYear);
            return currGap > prevGap ? curr : prev;
        });

        res.json({
            make: best.make,
            model: best.model,
            startYear: best.startYear,
            endYear: best.endYear,
            suggestedTrims: best.suggestedTrims || [],
            excludedTrims: best.excludedTrims || [],
            suggestedEngines: best.suggestedEngines || [],
            excludedEngines: best.excludedEngines || [],
            allFitments
        });

    } catch (error) {
        console.error('[AI Suggest Fitment] Error:', error.message);
        res.status(500).json({ error: 'AI request failed', details: error.message });
    }
});

// ============================================
// TRACK SAVE & NEXT ACTION
// POST /api/ai/track-save-next
// Body: { hadData: boolean }
// ============================================
/**
 * @swagger
 * /ai/track-save-next:
 *   post:
 *     tags: [AI]
 *     summary: Track a "save and move to next" action
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hadData:
 *                 type: boolean
 *                 description: Whether the fitment had data when saved
 *                 default: false
 *     responses:
 *       200:
 *         description: Tracked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *       500:
 *         description: Failed to track action
 */
router.post('/track-save-next', requireAuth, async (req, res) => {
    try {
        const { hadData = false } = req.body;
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        await AiFitmentUsage.create({
            userId: req.user.userId,
            action: 'save_next',
            itemCount: 1,
            hadData,
            date: dateStr,
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            day: now.getDate()
        });
        res.json({ ok: true });
    } catch (error) {
        console.error('[Track Save Next] Error:', error.message);
        res.status(500).json({ error: 'Failed to track action' });
    }
});

// ============================================
// REPHRASE TITLE
// POST /api/ai/rephrase-title
// Body: { currentTitle, sourceTitle, brand, color, compatibility }
// Returns: { rephrasedTitle }
// ============================================
/**
 * @swagger
 * /ai/rephrase-title:
 *   post:
 *     tags: [AI]
 *     summary: Rephrase an eBay product title for SEO
 *     description: "Uses GPT-4o-mini to reword the title. The template's own AI title prompt is the authoritative rule set, so the rephrase obeys exactly the same conditions as the original generation. There is no generic fallback: if the template's title rules cannot be resolved the request is refused with an explanation rather than producing a title that may break them. Optionally injects verified vehicle compatibility."
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentTitle]
 *             properties:
 *               currentTitle:
 *                 type: string
 *               sourceTitle:
 *                 type: string
 *                 description: Amazon source title for context
 *               brand:
 *                 type: string
 *               color:
 *                 type: string
 *               compatibility:
 *                 type: string
 *               vehicleMentions:
 *                 type: string
 *                 description: Verified vehicle models from reviews to include
 *               templateId:
 *                 type: string
 *                 description: Listing template whose AI title rules the rephrase must obey. Without it a generic rephrase is used.
 *               asin:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: string
 *               productInfo:
 *                 type: object
 *                 description: Amazon product information map, used for the {product_information} placeholder
 *     responses:
 *       200:
 *         description: Rephrased title
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rephrasedTitle:
 *                   type: string
 *       400:
 *         description: currentTitle is required, or no templateId was supplied / the template could not be loaded
 *       404:
 *         description: Template not found
 *       422:
 *         description: Template has no AI title prompt, so there are no rules the rephrase could follow
 *       500:
 *         description: AI request failed
 */
router.post('/rephrase-title', requireAuth, async (req, res) => {
    try {
        const {
            currentTitle = '',
            sourceTitle = '',
            brand = '',
            color = '',
            compatibility = '',
            vehicleMentions = '',
            templateId = '',
            asin = '',
            description = '',
            price = '',
            productInfo = null
        } = req.body;

        if (!currentTitle) {
            return res.status(400).json({ error: 'currentTitle is required' });
        }

        const vehicleSection = vehicleMentions
            ? `\nVerified vehicle compatibility (from customer reviews): ${vehicleMentions}\nYou MUST include 1–2 of these models/years in the rephrased title. Shorten other parts of the title if needed to stay within the character limit.`
            : '';

        // The template's own title rules are the ONLY rules a rephrase may use.
        // There is deliberately no generic fallback: a rephrase that doesn't know
        // the template's conditions would silently break them (nearly every
        // template mandates brand removal and its own character range), so if the
        // rules can't be loaded we tell the user instead of guessing.
        if (!templateId) {
            return res.status(400).json({
                error: 'Cannot rephrase without a template',
                reason: 'no_template_id',
                details: 'No template was supplied for this listing, so the title rules it must follow are unknown. Rephrasing was skipped to avoid producing a title that breaks the template rules.'
            });
        }

        let template;
        try {
            template = await ListingTemplate.findById(templateId).select('name asinAutomation');
        } catch (err) {
            console.warn(`[AI Rephrase Title] Could not load template ${templateId}: ${err.message}`);
            return res.status(400).json({
                error: 'Cannot rephrase — template could not be loaded',
                reason: 'template_load_failed',
                details: `The listing template (${templateId}) could not be read, so its title rules are unavailable. Rephrasing was skipped rather than risk breaking those rules.`
            });
        }

        if (!template) {
            return res.status(404).json({
                error: 'Cannot rephrase — template not found',
                reason: 'template_not_found',
                details: `No listing template exists with id ${templateId}, so its title rules are unavailable. Rephrasing was skipped.`
            });
        }

        const titleConfig = template.asinAutomation?.fieldConfigs?.find(c => c.ebayField === 'title');
        const titlePromptTemplate = (titleConfig?.enabled && titleConfig?.source === 'ai')
            ? (titleConfig.promptTemplate || '')
            : '';

        if (!titlePromptTemplate) {
            let why;
            if (!titleConfig) {
                why = 'has no title field configured';
            } else if (!titleConfig.enabled) {
                why = 'has its title field disabled';
            } else if (titleConfig.source !== 'ai') {
                why = `maps the title directly from Amazon (source: ${titleConfig.source}) rather than generating it with AI`;
            } else {
                why = 'has an empty AI title prompt';
            }
            console.warn(`[AI Rephrase Title] Template "${template.name}" (${templateId}) ${why} — rephrase refused`);
            return res.status(422).json({
                error: 'Cannot rephrase — this template has no AI title rules',
                reason: 'no_ai_title_prompt',
                details: `Template "${template.name}" ${why}, so there are no title rules to follow. Rephrasing was skipped — edit the title manually, or add an AI title prompt to this template.`
            });
        }

        // Same placeholder shape as applyFieldConfigs() in utils/asinAutofill.js,
        // so {title}, {brand}, {product_information} etc. resolve identically.
        const placeholderData = {
            title: sourceTitle,
            brand,
            description,
            price,
            asin,
            color,
            compatibility,
            product_information: productInfo && typeof productInfo === 'object'
                ? Object.entries(productInfo)
                    .filter(([, v]) => v !== null && v !== '' && v !== undefined)
                    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
                    .join('\n')
                : ''
        };

        const templateRules = replacePlaceholders(titlePromptTemplate, placeholderData);

        const prompt = `${templateRules}

--- ADDITIONAL REQUIREMENT: REPHRASE ---
A title was already produced from the instructions above:
${currentTitle}

Produce a DIFFERENT wording of that title — vary the word order and use synonyms so the result is not identical to the one above.
Every rule in the instructions above still applies in full and OVERRIDES this rephrase requirement. If rephrasing would break any rule above, follow the rule and rephrase only as much as the rules allow.${vehicleSection}

Return only the plain title text — no quotes, markdown, or commentary.`;

        // Routed through the shared helper so rephrase gets the same model,
        // temperature, markdown stripping, concurrency limit and usage tracking
        // as the normal generation run.
        let rephrasedTitle = await generateWithGemini(prompt, {
            maxTokens: 150,
            asin,
            fieldName: 'title',
            fieldType: 'core',
            templateId: templateId || undefined,
            userId: req.user?.userId,
            apiKey: process.env.OPENAI_FITMENT_API_KEY
        });

        // Strip any surrounding quotes the model may add
        rephrasedTitle = rephrasedTitle.replace(/^["']|["']$/g, '').trim();
        // Hard safety truncation to 80 chars (matches applyFieldConfigs)
        if (rephrasedTitle.length > 80) {
            rephrasedTitle = rephrasedTitle.substring(0, 80);
        }

        res.json({ rephrasedTitle });
    } catch (error) {
        console.error('[AI Rephrase Title] Error:', error.message);
        res.status(500).json({ error: 'AI request failed', details: error.message });
    }
});

// ============================================
// AI FITMENT USAGE STATS
// GET /api/ai/fitment-usage-stats?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Returns day-wise, user-wise stats
// ============================================
/**
 * @swagger
 * /ai/fitment-usage-stats:
 *   get:
 *     tags: [AI]
 *     summary: Get AI fitment usage stats (admin)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         example: '2024-06-01'
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         example: '2024-06-30'
 *     responses:
 *       200:
 *         description: Per-user per-day action counts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AiFitmentUsageStat'
 *       500:
 *         description: Failed to fetch usage stats
 */
router.get('/fitment-usage-stats', requireAuth, requirePageAccess('AiFitmentUsage'), async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const matchStage = {};
        if (startDate) matchStage.date = { $gte: startDate };
        if (endDate) matchStage.date = { ...matchStage.date, $lte: endDate };

        const stats = await AiFitmentUsage.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: { userId: '$userId', date: '$date', action: '$action' },
                    totalCount: { $sum: '$itemCount' },
                    withDataCount: { $sum: { $cond: ['$hadData', '$itemCount', 0] } }
                }
            },
            {
                $group: {
                    _id: { userId: '$_id.userId', date: '$_id.date' },
                    actions: {
                        $push: {
                            action: '$_id.action',
                            totalCount: '$totalCount',
                            withDataCount: '$withDataCount'
                        }
                    }
                }
            },
            { $sort: { '_id.date': -1 } }
        ]);

        // Collect unique user IDs and fetch names
        const userIds = [...new Set(stats.map(s => s._id.userId.toString()))];
        const users = await User.find(
            { _id: { $in: userIds } },
            { username: 1, name: 1, role: 1 }
        ).lean();
        const userMap = {};
        users.forEach(u => { userMap[u._id.toString()] = { username: u.username, name: u.name, role: u.role }; });

        // Reshape into a friendly format
        const result = stats.map(s => {
            const uid = s._id.userId.toString();
            const row = {
                userId: uid,
                username: userMap[uid]?.username || 'Unknown',
                name: userMap[uid]?.name || '',
                role: userMap[uid]?.role || '',
                date: s._id.date,
                aiSuggestCount: 0,
                saveNextCount: 0,
                saveNextWithDataCount: 0
            };
            s.actions.forEach(a => {
                if (a.action === 'ai_suggest') row.aiSuggestCount = a.totalCount;
                if (a.action === 'save_next') {
                    row.saveNextCount = a.totalCount;
                    row.saveNextWithDataCount = a.withDataCount;
                }
            });
            return row;
        });

        res.json(result);
    } catch (error) {
        console.error('[AI Fitment Usage Stats] Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch usage stats' });
    }
});

export default router;

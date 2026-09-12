/**
 * Amazon delivery-date parsing for the Amazon Delivery Date Check page.
 *
 * Deliberately standalone rather than shared with templateListings.js's
 * parseShippingDate(): that one only understands the US "September 16" order
 * and reads a single line, while a delivery-date SLA check has to cope with
 * every marketplace this app sells on ("16 September" on co.uk/com.au), with
 * ranges ("September 16 - 20"), and with picking the right line out of several.
 * Changing the precheck's parser to do all that would alter ASIN precheck
 * results, so this lives on its own and nothing in the stock check or the
 * precheck imports it.
 */

// Delivery estimates are rendered in the marketplace's local timezone, so
// "today" for the day-count has to be measured there too — using the server's
// own date would shift every result by a day for part of each day.
export const MARKETPLACE_TIMEZONES = {
  USD: 'America/Los_Angeles',
  GBP: 'Europe/London',
  CAD: 'America/Toronto',
  AUD: 'Australia/Sydney'
};

const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

// Matches both marketplace orderings in one pass so tokens come back in the
// order they appear in the text: "September 16" (.com) and "16 September"
// (.co.uk / .com.au). Groups 1-3 are the month-first form, 4-6 day-first.
const DATE_TOKEN = new RegExp(
  `(?:\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?)`
  + `|(?:\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?(?:,?\\s*(\\d{4}))?)`,
  'gi'
);

// "September 16 - 20" / "16 - 20 September": the second day of a same-month
// range carries no month of its own, so it is picked up relative to the token
// that precedes it.
const TRAILING_RANGE_DAY = /^\s*(?:[-–—]|to)\s*(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:am|pm|:))/i;

const MS_PER_DAY = 86400000;
// Delivery text is a handful of short lines; anything past this is a sign the
// payload shape changed, and storing it per item would bloat the collection.
const MAX_DELIVERY_LINES = 6;

export function getMarketplaceTimezone(currency) {
  return MARKETPLACE_TIMEZONES[String(currency || '').toUpperCase()] || MARKETPLACE_TIMEZONES.USD;
}

/** Calendar Y/M/D of `date` as seen in `timezone`, not on the server. */
function getLocalDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value) - 1,
    day: Number(parts.find((part) => part.type === 'day')?.value)
  };
}

function toIsoDate(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Every month/day (and optional year) in `text`, in the order written. */
function scanDateTokens(text) {
  const tokens = [];
  DATE_TOKEN.lastIndex = 0;
  let match = DATE_TOKEN.exec(text);
  while (match !== null) {
    const monthName = String(match[1] || match[5] || '').toLowerCase().slice(0, 3);
    const day = Number(match[2] ?? match[4]);
    const year = match[3] ? Number(match[3]) : (match[6] ? Number(match[6]) : null);
    const month = MONTH_INDEX[monthName];
    if (month != null && Number.isFinite(day) && day >= 1 && day <= 31) {
      tokens.push({ month, day, year, endIndex: DATE_TOKEN.lastIndex });
    }
    match = DATE_TOKEN.exec(text);
  }
  return tokens;
}

/**
 * Resolve a written month/day against the scrape date. Amazon omits the year,
 * so a date that has already passed belongs to next year (a run on Dec 28
 * reading "January 3" must not report -359 days).
 */
function resolveToken(token, scrapedParts) {
  const scrapedUtc = Date.UTC(scrapedParts.year, scrapedParts.month, scrapedParts.day);
  let year = token.year ?? scrapedParts.year;
  let deliveryUtc = Date.UTC(year, token.month, token.day);

  if (!token.year && deliveryUtc < scrapedUtc) {
    year += 1;
    deliveryUtc = Date.UTC(year, token.month, token.day);
  }

  // Date.UTC normalizes overflow (month 12 rolls to January, day 32 to the
  // 1st), so read the resolved parts back rather than re-using the inputs.
  const resolved = new Date(deliveryUtc);
  return {
    date: toIsoDate(resolved.getUTCFullYear(), resolved.getUTCMonth(), resolved.getUTCDate()),
    days: Math.round((deliveryUtc - scrapedUtc) / MS_PER_DAY)
  };
}

/**
 * Parse one delivery line into its earliest and latest dates.
 *
 * A range ("arrives September 16 - 20") returns both ends; a single date
 * returns the same value for each. Callers that care about an SLA breach
 * should read `latest` — that is the worst case the buyer is quoted.
 * Returns null when the line carries no date at all.
 */
export function parseDeliveryLine(line, { scrapedAt = new Date(), timezone = MARKETPLACE_TIMEZONES.USD } = {}) {
  const text = String(line || '').trim();
  if (!text) return null;

  const scrapedParts = getLocalDateParts(scrapedAt, timezone);
  const tokens = scanDateTokens(text);

  if (!tokens.length) {
    // Same-week deliveries are sometimes written with no date at all.
    const normalized = text.toLowerCase();
    if (/\btomorrow\b/.test(normalized)) {
      const resolved = resolveToken(
        { month: scrapedParts.month, day: scrapedParts.day + 1, year: scrapedParts.year },
        scrapedParts
      );
      return { text, earliest: resolved, latest: resolved };
    }
    if (/\btoday\b/.test(normalized)) {
      const resolved = { date: toIsoDate(scrapedParts.year, scrapedParts.month, scrapedParts.day), days: 0 };
      return { text, earliest: resolved, latest: resolved };
    }
    return null;
  }

  const resolved = tokens.map((token) => resolveToken(token, scrapedParts));

  // A bare day directly after the last token closes a same-month range.
  const lastToken = tokens[tokens.length - 1];
  const rangeMatch = text.slice(lastToken.endIndex).match(TRAILING_RANGE_DAY);
  if (rangeMatch) {
    const rangeDay = Number(rangeMatch[1]);
    if (Number.isFinite(rangeDay) && rangeDay >= 1 && rangeDay <= 31) {
      // A range that wraps to a lower number crosses into the next month
      // ("October 30 - 2" means November 2).
      const wrapsMonth = rangeDay < lastToken.day;
      resolved.push(resolveToken(
        {
          month: wrapsMonth ? lastToken.month + 1 : lastToken.month,
          day: rangeDay,
          year: lastToken.year
        },
        scrapedParts
      ));
    }
  }

  let earliest = resolved[0];
  let latest = resolved[0];
  for (const entry of resolved) {
    if (entry.days < earliest.days) earliest = entry;
    if (entry.days > latest.days) latest = entry;
  }

  return { text, earliest, latest };
}

/**
 * Every delivery/shipping string Scrapingdog exposes, most authoritative
 * first. `shipping_info` and `delivery` are the Scrapingdog names,
 * `shipping_time` the ScraperAPI one — kept so a response captured under the
 * other provider still parses (see AMAZON_PRODUCT_PROVIDER).
 */
export function collectDeliveryLines(payload) {
  const singleOffer = payload?.purchase_options?.single_offer || {};
  const raw = [
    payload?.shipping_info,
    payload?.shipping_time,
    ...(Array.isArray(payload?.delivery) ? payload.delivery : []),
    ...(Array.isArray(singleOffer.delivery) ? singleOffer.delivery : []),
    singleOffer.delivery_message,
    payload?.shipping_condition
  ];

  const seen = new Set();
  const lines = [];
  for (const entry of raw) {
    const text = String(entry || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
    if (lines.length >= MAX_DELIVERY_LINES) break;
  }
  return lines;
}

/**
 * Pull a plain string out of a Scrapingdog offer field that may be a bare
 * string, a `{ text }` object, or a `{ details: { content } }` object.
 */
function readOfferText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  return String(value.text || value.details?.content || '').trim();
}

/**
 * Who is actually behind the buy box. Amazon rotates this between sellers, and
 * a different seller ships from a different place at a different speed — which
 * is the single biggest reason a scraped delivery date can disagree with what
 * a person sees in their own browser. Recorded so that disagreement is
 * diagnosable instead of looking like a parsing bug.
 */
export function getOfferSeller(payload) {
  const singleOffer = payload?.purchase_options?.single_offer || {};
  const features = singleOffer.features || {};
  return {
    soldBy: readOfferText(singleOffer.sold_by ?? features.sold_by),
    shipsFrom: readOfferText(singleOffer.ships_from ?? features.ships_from)
  };
}

/**
 * The delivery address Amazon actually quoted for, e.g. "Nashville 37217".
 *
 * This is NOT necessarily the postal code we asked for. Measured over ~20
 * calls, Scrapingdog's `postal_code` parameter was honoured 0 times: the
 * destination is whatever city the rotating proxy exits from, and the quote
 * swings with it (one ASIN returned 4 to 11 days across locations in a single
 * minute). A delivery date is meaningless without the destination it was
 * priced for, so it is recorded on every row.
 */
export function getQuoteLocation(payload) {
  return String(payload?.location || '')
    .replace(/^Delivering to\s*/i, '')
    // Amazon pads this string with zero-width marks; strip them by codepoint
    // so the value compares and displays cleanly.
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .trim();
}


/** True when Amazon says the product cannot be bought right now. */
function isOutOfStock(payload) {
  const text = String(
    payload?.purchase_options?.single_offer?.stock || payload?.availability_status || ''
  ).trim().toLowerCase();
  if (!text) return false;
  return text.includes('currently unavailable')
    || text.includes('out of stock')
    || text.includes('unavailable');
}

/**
 * Classify one Scrapingdog product response against the delivery SLA.
 *
 * `maxDeliveryDays` is the slowest delivery still considered acceptable, so a
 * quote of exactly that many days passes and one day more is flagged.
 *
 * Statuses:
 *   within_range      — a date was quoted and it lands on or before the cutoff
 *   flagged_late      — a date was quoted and it lands after the cutoff
 *   out_of_stock      — Amazon shows no date because there is no live offer
 *   no_delivery_date  — no date and no out-of-stock reason (see hasOfferSignal:
 *                       when true the buy-box simply had not rendered, which is
 *                       worth one re-fetch before believing it)
 */
export function evaluateDeliveryDate(payload, { currency = 'USD', scrapedAt = new Date(), maxDeliveryDays = 9 } = {}) {
  const timezone = getMarketplaceTimezone(currency);
  const deliveryLines = collectDeliveryLines(payload);
  const availabilityText = String(
    payload?.purchase_options?.single_offer?.stock || payload?.availability_status || ''
  ).trim();

  const parsedLines = deliveryLines
    .map((line) => parseDeliveryLine(line, { scrapedAt, timezone }))
    .filter(Boolean);

  const { soldBy, shipsFrom } = getOfferSeller(payload);
  const base = {
    deliveryLines,
    availabilityText,
    // Where this quote was actually priced for — see getQuoteLocation.
    quoteLocation: getQuoteLocation(payload),
    // Which offer the quote came from — see getOfferSeller.
    soldBy,
    shipsFrom,
    deliveryText: '',
    deliveryDate: null,
    deliveryDays: null,
    earliestDeliveryDate: null,
    earliestDeliveryDays: null,
    fastestDeliveryDate: null,
    fastestDeliveryDays: null,
    maxDeliveryDays
  };

  if (!parsedLines.length) {
    if (isOutOfStock(payload)) {
      return { ...base, status: 'out_of_stock', hasOfferSignal: false };
    }
    // A price means there IS a live offer whose delivery widget did not render
    // — the same ambiguity the stock check retries on. Without one there is
    // nothing to re-fetch for.
    const singleOffer = payload?.purchase_options?.single_offer || {};
    const hasOfferSignal = Boolean(payload?.price || singleOffer.price || singleOffer.extracted_price);
    return { ...base, status: 'no_delivery_date', hasOfferSignal };
  }

  // The first line that carries a date is Amazon's standard/free option, which
  // is the one an eBay buyer effectively gets — the "fastest delivery" line
  // below it is a paid upgrade and must not decide the verdict. Within that
  // line the LATEST end of any range is used, because a quote of "16 - 20" can
  // land on the 20th.
  const primary = parsedLines[0];
  const fastest = parsedLines.reduce(
    (best, entry) => (entry.earliest.days < best.earliest.days ? entry : best),
    parsedLines[0]
  );

  return {
    ...base,
    status: primary.latest.days > maxDeliveryDays ? 'flagged_late' : 'within_range',
    deliveryText: primary.text,
    deliveryDate: primary.latest.date,
    deliveryDays: primary.latest.days,
    earliestDeliveryDate: primary.earliest.date,
    earliestDeliveryDays: primary.earliest.days,
    fastestDeliveryDate: fastest.earliest.date,
    fastestDeliveryDays: fastest.earliest.days,
    hasOfferSignal: true
  };
}

/** ISO date of the last acceptable delivery day, for display beside a run. */
export function getCutoffDate(maxDeliveryDays, { currency = 'USD', from = new Date() } = {}) {
  const parts = getLocalDateParts(from, getMarketplaceTimezone(currency));
  const cutoff = new Date(Date.UTC(parts.year, parts.month, parts.day) + (Number(maxDeliveryDays) || 0) * MS_PER_DAY);
  return toIsoDate(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate());
}

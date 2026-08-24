// utils/platformDay.js
//
// The platform books everything against a PST day, not UTC — an order sold at
// 23:00 UTC belongs to the previous PST day. Extracted from routes/affiliateOrders.js
// so the purchasing queue buckets gift-card balances and per-account daily caps
// against exactly the same day boundary the Affiliate Orders page reports on.

export const PST_OFFSET_HOURS = 8;
export const DAY_IN_MS = 24 * 60 * 60 * 1000;

// Soft ceiling on how many orders one Amazon account should place per platform day.
export const MAX_ORDERS_PER_AMAZON_ACCOUNT = 9;

/** Builds a UTC date range covering the PST day named by a YYYY-MM-DD string. */
export function buildDayRange(dateStr) {
    const start = new Date(dateStr);
    start.setUTCHours(PST_OFFSET_HOURS, 0, 0, 0);

    const end = new Date(dateStr);
    end.setDate(end.getDate() + 1);
    end.setUTCHours(PST_OFFSET_HOURS - 1, 59, 59, 999);

    return { start, end };
}

/** The YYYY-MM-DD platform day a timestamp falls in. */
export function getPlatformDayString(dateValue) {
    const shifted = new Date(new Date(dateValue).getTime() - PST_OFFSET_HOURS * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
}

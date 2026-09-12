import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectDeliveryLines,
  evaluateDeliveryDate,
  getCutoffDate,
  parseDeliveryLine
} from '../src/utils/amazonDeliveryDate.js';

/**
 * The delivery SLA check is only as good as this parser: a line it fails to
 * read becomes a "no delivery date" row a human has to chase, and a line it
 * misreads either hides a late listing or flags a fine one. Every string below
 * is a real Amazon delivery phrasing from one of the four marketplaces.
 *
 * A fixed scrape instant keeps the day-counts deterministic. 2026-09-11T18:00Z
 * is 2026-09-11 in every marketplace timezone used here.
 */
const SCRAPED_AT = new Date('2026-09-11T18:00:00Z');
const US = { scrapedAt: SCRAPED_AT, timezone: 'America/Los_Angeles' };
const UK = { scrapedAt: SCRAPED_AT, timezone: 'Europe/London' };

test('parses the US month-first format', () => {
  const parsed = parseDeliveryLine('FREE delivery Tuesday, September 16', US);
  assert.equal(parsed.latest.date, '2026-09-16');
  assert.equal(parsed.latest.days, 5);
});

test('parses the UK/AU day-first format', () => {
  const parsed = parseDeliveryLine('FREE delivery Tuesday, 16 September', UK);
  assert.equal(parsed.latest.date, '2026-09-16');
  assert.equal(parsed.latest.days, 5);
});

test('parses abbreviated month names', () => {
  assert.equal(parseDeliveryLine('FREE delivery Sept 16', US).latest.date, '2026-09-16');
  assert.equal(parseDeliveryLine('FREE delivery Sep. 16', US).latest.date, '2026-09-16');
  assert.equal(parseDeliveryLine('Delivery 16 Oct', UK).latest.date, '2026-10-16');
});

test('a same-month range reports both ends, worst case last', () => {
  const parsed = parseDeliveryLine('FREE delivery September 16 - 20', US);
  assert.equal(parsed.earliest.date, '2026-09-16');
  assert.equal(parsed.earliest.days, 5);
  assert.equal(parsed.latest.date, '2026-09-20');
  assert.equal(parsed.latest.days, 9);
});

test('a range spelling both months reports both ends', () => {
  const parsed = parseDeliveryLine('FREE delivery September 16 - October 2', US);
  assert.equal(parsed.earliest.date, '2026-09-16');
  assert.equal(parsed.latest.date, '2026-10-02');
  assert.equal(parsed.latest.days, 21);
});

test('a range whose second day is lower crosses into the next month', () => {
  const parsed = parseDeliveryLine('FREE delivery October 30 - 2', US);
  assert.equal(parsed.earliest.date, '2026-10-30');
  assert.equal(parsed.latest.date, '2026-11-02');
});

test('handles Today and Tomorrow with no date written', () => {
  assert.equal(parseDeliveryLine('FREE delivery Today', US).latest.days, 0);
  assert.equal(parseDeliveryLine('Or fastest delivery Tomorrow', US).latest.days, 1);
  assert.equal(parseDeliveryLine('Or fastest delivery Tomorrow', US).latest.date, '2026-09-12');
});

test('a month-end Tomorrow rolls into the next month', () => {
  const parsed = parseDeliveryLine('FREE delivery Tomorrow', {
    scrapedAt: new Date('2026-09-30T18:00:00Z'),
    timezone: 'America/Los_Angeles'
  });
  assert.equal(parsed.latest.date, '2026-10-01');
  assert.equal(parsed.latest.days, 1);
});

test('a date already past belongs to next year', () => {
  const parsed = parseDeliveryLine('FREE delivery January 3', {
    scrapedAt: new Date('2026-12-28T18:00:00Z'),
    timezone: 'America/Los_Angeles'
  });
  assert.equal(parsed.latest.date, '2027-01-03');
  assert.equal(parsed.latest.days, 6);
});

test('an explicit year is trusted as written', () => {
  const parsed = parseDeliveryLine('Delivery September 16, 2026', US);
  assert.equal(parsed.latest.date, '2026-09-16');
});

test('returns null for a line with no date at all', () => {
  assert.equal(parseDeliveryLine('FREE Returns', US), null);
  assert.equal(parseDeliveryLine('', US), null);
  assert.equal(parseDeliveryLine(null, US), null);
});

test('a delivery time of day is not mistaken for a range', () => {
  const parsed = parseDeliveryLine('FREE delivery September 16 - order within 4 hrs', US);
  assert.equal(parsed.latest.date, '2026-09-16');
});

test('collects delivery lines from every field Scrapingdog uses', () => {
  const lines = collectDeliveryLines({
    shipping_info: 'FREE delivery September 16',
    delivery: ['FREE delivery September 16', 'Or fastest delivery September 13'],
    purchase_options: { single_offer: { delivery: ['Arrives September 20'] } }
  });
  // Duplicates collapse, order is most-authoritative first.
  assert.deepEqual(lines, [
    'FREE delivery September 16',
    'Or fastest delivery September 13',
    'Arrives September 20'
  ]);
});

test('within the SLA passes, one day past it is flagged', () => {
  const within = evaluateDeliveryDate(
    { shipping_info: 'FREE delivery September 20' },
    { currency: 'USD', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 }
  );
  assert.equal(within.status, 'within_range');
  assert.equal(within.deliveryDays, 9);

  const late = evaluateDeliveryDate(
    { shipping_info: 'FREE delivery September 21' },
    { currency: 'USD', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 }
  );
  assert.equal(late.status, 'flagged_late');
  assert.equal(late.deliveryDays, 10);
});

test('the standard line decides the verdict, not the paid fastest one', () => {
  const result = evaluateDeliveryDate(
    {
      delivery: ['FREE delivery September 25', 'Or fastest delivery September 13'],
      price: '$16.94'
    },
    { currency: 'USD', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 }
  );
  assert.equal(result.status, 'flagged_late');
  assert.equal(result.deliveryDays, 14);
  // The fastest option is still reported, just not used to judge.
  assert.equal(result.fastestDeliveryDays, 2);
});

test('the worst end of a range decides the verdict', () => {
  const result = evaluateDeliveryDate(
    { shipping_info: 'FREE delivery September 16 - 25' },
    { currency: 'USD', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 }
  );
  assert.equal(result.status, 'flagged_late');
  assert.equal(result.earliestDeliveryDays, 5);
  assert.equal(result.deliveryDays, 14);
});

test('an unavailable product is out_of_stock, not a missing date', () => {
  const result = evaluateDeliveryDate(
    { availability_status: 'Currently unavailable.' },
    { currency: 'USD', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 }
  );
  assert.equal(result.status, 'out_of_stock');
  assert.equal(result.hasOfferSignal, false);
});

test('a priced product with no delivery text is retryable', () => {
  const result = evaluateDeliveryDate(
    { purchase_options: { single_offer: { price: '$16.94', stock: 'In Stock' } } },
    { currency: 'USD', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 }
  );
  assert.equal(result.status, 'no_delivery_date');
  assert.equal(result.hasOfferSignal, true);
});

test('an empty response is a non-retryable missing date', () => {
  const result = evaluateDeliveryDate({}, { currency: 'USD', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 });
  assert.equal(result.status, 'no_delivery_date');
  assert.equal(result.hasOfferSignal, false);
});

test('UK payloads are read in the UK format and timezone', () => {
  const result = evaluateDeliveryDate(
    { shipping_info: 'FREE delivery Tuesday, 22 September' },
    { currency: 'GBP', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 }
  );
  assert.equal(result.status, 'flagged_late');
  assert.equal(result.deliveryDate, '2026-09-22');
  assert.equal(result.deliveryDays, 11);
});

test('the cutoff date is the last acceptable delivery day', () => {
  assert.equal(getCutoffDate(9, { currency: 'USD', from: SCRAPED_AT }), '2026-09-20');
  assert.equal(getCutoffDate(0, { currency: 'USD', from: SCRAPED_AT }), '2026-09-11');
});

test('the buy-box seller is recorded alongside the quote', () => {
  // Real Scrapingdog shape: sold_by is an object, not a string. Recorded
  // because a different buy-box winner is the usual reason a stored date
  // disagrees with what a person sees in their own browser.
  const result = evaluateDeliveryDate(
    {
      shipping_info: 'FREE Friday, September 18',
      purchase_options: {
        single_offer: {
          sold_by: { text: "Cutler's", details: { heading: 'Shipper / Seller', content: "Cutler's" } }
        }
      }
    },
    { currency: 'USD', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 }
  );
  assert.equal(result.soldBy, "Cutler's");
  assert.equal(result.deliveryDate, '2026-09-18');
});

test('a bare-string or missing seller does not break the quote', () => {
  const asString = evaluateDeliveryDate(
    { shipping_info: 'FREE September 18', purchase_options: { single_offer: { sold_by: 'Amazon.com' } } },
    { currency: 'USD', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 }
  );
  assert.equal(asString.soldBy, 'Amazon.com');

  const missing = evaluateDeliveryDate(
    { shipping_info: 'FREE September 18' },
    { currency: 'USD', scrapedAt: SCRAPED_AT, maxDeliveryDays: 9 }
  );
  assert.equal(missing.soldBy, '');
  assert.equal(missing.shipsFrom, '');
});

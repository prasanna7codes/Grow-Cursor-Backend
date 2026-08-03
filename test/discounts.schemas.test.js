import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from '../src/utils/validate.js';
import {
  discountsListQuerySchema,
  discountsAllQuerySchema,
  discountsCachedQuerySchema,
  discountsEndingSoonQuerySchema,
  discountsDetailQuerySchema,
} from '../src/schemas/index.js';

const SELLER_ID = '507f1f77bcf86cd799439011';

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

// Runs a query schema through the middleware the way Express would.
// Returns { passed, query, res } so tests can assert on both outcomes.
function runQuery(schema, query) {
  const req = { query };
  const res = createResponse();
  let passed = false;

  validate(schema, 'query')(req, res, () => {
    passed = true;
  });

  return { passed, query: req.query, res };
}

// ── Real call sites must keep working ────────────────────────────────────────
// These mirror the exact params sent by DiscountsPage.jsx and
// DiscountAlertsBell.jsx. If one of these ever fails, the Discounts page or the
// header bell is broken in production.

test('DiscountsPage /discounts/all params survive validation unchanged', () => {
  const { passed, query } = runQuery(discountsAllQuerySchema, {
    status: 'ENDED',
    types: 'CODED_COUPON,MARKDOWN_SALE',
    sort: '-START_DATE',
  });

  assert.equal(passed, true);
  assert.deepEqual(query, {
    status: 'ENDED',
    types: 'CODED_COUPON,MARKDOWN_SALE',
    sort: '-START_DATE',
  });
});

test('DiscountsPage omits status when filtering by ALL', () => {
  const { passed, query } = runQuery(discountsAllQuerySchema, {
    types: 'CODED_COUPON,MARKDOWN_SALE',
    sort: '-START_DATE',
  });

  assert.equal(passed, true);
  assert.deepEqual(query, { types: 'CODED_COUPON,MARKDOWN_SALE', sort: '-START_DATE' });
});

test('DiscountAlertsBell /discounts/ending-soon params survive validation', () => {
  const { passed, query } = runQuery(discountsEndingSoonQuerySchema, {
    days: '3',
    refresh: 'true',
  });

  assert.equal(passed, true);
  assert.deepEqual(query, { days: '3', refresh: 'true' });
});

test('/discounts/cached accepts a refresh flag and an empty query', () => {
  const withRefresh = runQuery(discountsCachedQuerySchema, { refresh: 'true' });
  assert.equal(withRefresh.passed, true);
  assert.deepEqual(withRefresh.query, { refresh: 'true' });

  const empty = runQuery(discountsCachedQuerySchema, {});
  assert.equal(empty.passed, true);
  assert.deepEqual(empty.query, {});
});

test('/discounts and /discounts/detail accept their real params', () => {
  const list = runQuery(discountsListQuerySchema, {
    sellerId: SELLER_ID,
    status: 'RUNNING',
    sort: '-START_DATE',
  });
  assert.equal(list.passed, true);
  assert.deepEqual(list.query, { sellerId: SELLER_ID, status: 'RUNNING', sort: '-START_DATE' });

  const detail = runQuery(discountsDetailQuerySchema, {
    sellerId: SELLER_ID,
    href: 'https://api.ebay.com/sell/marketing/v1/promotion/123',
  });
  assert.equal(detail.passed, true);
  assert.deepEqual(detail.query, {
    sellerId: SELLER_ID,
    href: 'https://api.ebay.com/sell/marketing/v1/promotion/123',
  });
});

// `validate` strips keys the schema does not declare, so a param that a handler
// reads but the schema forgot would silently arrive as undefined. `types` is the
// dangerous one: dropping it would quietly disable type filtering on /all.
test('declared params are kept while unknown keys are stripped', () => {
  const { passed, query } = runQuery(discountsAllQuerySchema, {
    types: 'CODED_COUPON,MARKDOWN_SALE',
    unexpected: 'dropped',
  });

  assert.equal(passed, true);
  assert.equal(query.types, 'CODED_COUPON,MARKDOWN_SALE');
  assert.equal('unexpected' in query, false);
});

// ── Crafted input is rejected before the handler runs ────────────────────────
// Express parses ?status[$ne]=x into an object, so without a type guard these
// values reach the handlers (and, for href, an outbound axios request).

test('rejects object-valued query params', () => {
  const { passed, res } = runQuery(discountsListQuerySchema, {
    sellerId: SELLER_ID,
    status: { $ne: 'x' },
  });

  assert.equal(passed, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.equal(res.body.details[0].field, 'status');
});

test('rejects array-valued and malformed seller IDs', () => {
  const asArray = runQuery(discountsListQuerySchema, { sellerId: [SELLER_ID, SELLER_ID] });
  assert.equal(asArray.passed, false);
  assert.equal(asArray.res.statusCode, 400);

  const malformed = runQuery(discountsListQuerySchema, { sellerId: 'not-an-object-id' });
  assert.equal(malformed.passed, false);
  assert.equal(malformed.res.statusCode, 400);
  assert.equal(malformed.res.body.details[0].message, 'Invalid ObjectId');
});

test('rejects a non-string href before it reaches the eBay request', () => {
  const { passed, res } = runQuery(discountsDetailQuerySchema, {
    sellerId: SELLER_ID,
    href: ['https://evil.example.com'],
  });

  assert.equal(passed, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.details[0].field, 'href');
});

// ── Behaviour parity with the pre-validation routes ──────────────────────────
// The handlers filter unrecognised values rather than rejecting them, and own
// their required-field errors. Validation must not turn those into 400s.

test('unrecognised filter values are still accepted, not rejected', () => {
  // Handler ignores it via `VALID_STATUSES.includes(status)`
  assert.equal(runQuery(discountsListQuerySchema, { sellerId: SELLER_ID, status: 'BOGUS' }).passed, true);
  assert.equal(runQuery(discountsAllQuerySchema, { sort: 'WHATEVER' }).passed, true);
  // Handler falls back to 3 via `parseInt(...) || 3`
  assert.equal(runQuery(discountsEndingSoonQuerySchema, { days: 'abc' }).passed, true);
  // Anything other than 'true' simply means "serve from cache"
  assert.equal(runQuery(discountsCachedQuerySchema, { refresh: '1' }).passed, true);
});

test('missing required fields pass validation so handlers keep their own errors', () => {
  // The handler answers with { error: 'Missing sellerId' }, not a generic
  // validation failure — keep that message intact.
  const list = runQuery(discountsListQuerySchema, {});
  assert.equal(list.passed, true);
  assert.equal(list.res.statusCode, null);

  // Likewise /detail owns 'Missing required fields: sellerId, href' and the
  // eBay Marketing API prefix check on href.
  const detail = runQuery(discountsDetailQuerySchema, {});
  assert.equal(detail.passed, true);
  assert.equal(detail.res.statusCode, null);
});

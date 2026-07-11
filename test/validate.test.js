import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from '../src/utils/validate.js';
import {
  featurePermissionParamsSchema,
  updateFeaturePermissionSchema,
} from '../src/schemas/index.js';

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

test('accepts a feature permission update and strips unknown body fields', () => {
  const req = {
    body: {
      allowedUserIds: [],
      ignored: 'value',
    },
  };
  const res = createResponse();
  let nextCalled = false;

  validate(updateFeaturePermissionSchema)(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.body, { allowedUserIds: [] });
  assert.equal(res.statusCode, null);
});

test('accepts a non-empty feature permission ID parameter', () => {
  const req = { params: { featureId: 'bulk-edit' } };
  const res = createResponse();
  let nextCalled = false;

  validate(featurePermissionParamsSchema, 'params')(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.params, { featureId: 'bulk-edit' });
  assert.equal(res.statusCode, null);
});

test('rejects invalid user IDs before the route handler runs', () => {
  const req = { body: { allowedUserIds: ['invalid-id'] } };
  const res = createResponse();
  let nextCalled = false;

  validate(updateFeaturePermissionSchema)(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    error: 'Validation failed',
    details: [{ field: 'allowedUserIds.0', message: 'Invalid ObjectId' }],
  });
});

test('rejects an empty feature permission ID parameter', () => {
  const req = { params: { featureId: '' } };
  const res = createResponse();
  let nextCalled = false;

  validate(featurePermissionParamsSchema, 'params')(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    error: 'Validation failed',
    details: [{ field: 'featureId', message: 'Feature ID is required' }],
  });
});

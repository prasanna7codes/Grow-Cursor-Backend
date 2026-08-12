import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { requireObjectId } from '../src/middleware/objectId.js';

/**
 * Records which of Express's two continuations the guard chose: next() carries
 * on into the route handler, next('route') abandons the route and resumes
 * matching. Everything this middleware does is that choice.
 */
function run(id, param = 'id') {
  const calls = [];
  requireObjectId(param)({ params: { [param]: id } }, {}, arg => calls.push(arg));
  return {
    handled: calls.length === 1 && calls[0] === undefined,
    passedOn: calls.length === 1 && calls[0] === 'route',
  };
}

test('a real ObjectId reaches the route handler', () => {
  assert.equal(run('507f1f77bcf86cd799439011').handled, true);
  assert.equal(run('AAAAAAAAAAAAAAAAAAAAAAAA').handled, true, 'hex is case-insensitive');
});

test('a literal route name is passed on to the route that owns it', () => {
  // The bug this exists for: /cache-stats registers 5,500 lines after /:id, so
  // Express matched it here and reported the failed cast as a 500. The
  // 12-character names are the ones a length-based check would wave through.
  for (const name of ['cache-stats', 'cache-status', 'databaseview', 'precheck-stats']) {
    assert.equal(run(name).passedOn, true, `expected ${name} to reach its own route`);
  }
});

test('a malformed id falls through rather than reaching Mongoose', () => {
  // These match no later route, so they end at the router's 404 — where a bad
  // id belongs — instead of throwing a CastError out of findById.
  for (const bad of ['507f1f77bcf86cd79943901', '507f1f77bcf86cd7994390111', 'zzzf1f77bcf86cd799439011', '']) {
    assert.equal(run(bad).passedOn, true, `expected ${JSON.stringify(bad)} to be passed on`);
  }
});

test('a missing parameter does not throw', () => {
  const calls = [];
  requireObjectId()({ params: {} }, {}, arg => calls.push(arg));

  assert.deepEqual(calls, ['route']);
});

test('the guarded parameter name is configurable', () => {
  assert.equal(run('507f1f77bcf86cd799439011', 'templateId').handled, true);
  assert.equal(run('export-csv', 'templateId').passedOn, true);
});

// ── Against a real router ────────────────────────────────────────────────────

test('a literal path registered after /:id is reachable through a real router', async () => {
  // The tests above assert which continuation the guard picks; only Express can
  // say what that continuation does. This mirrors templateListings' shape — the
  // parameter route first, the literal one after it — and drives it over HTTP,
  // so the fix is pinned to observable routing rather than to a `next('route')`
  // call whose effect is assumed.
  const router = express.Router();
  router.get('/:id', requireObjectId(), (req, res) => res.json({ route: 'id', id: req.params.id }));
  router.get('/cache-stats', (req, res) => res.json({ route: 'cache-stats' }));
  // Mirrors the catch-all in routes/templateListings.js, message included, so
  // the assertions below pin what a client actually receives.
  router.use((req, res) => {
    res.status(404).json({ route: '404', error: `No such route: ${req.method} ${req.baseUrl}${req.path}` });
  });

  const app = express();
  app.use('/api/template-listings', router);
  const server = app.listen(0);
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/template-listings`;
    const get = async path => {
      const res = await fetch(base + path);
      return { status: res.status, body: await res.json() };
    };

    assert.deepEqual(await get('/cache-stats'), { status: 200, body: { route: 'cache-stats' } });

    const id = '507f1f77bcf86cd799439011';
    assert.deepEqual(await get(`/${id}`), { status: 200, body: { route: 'id', id } });

    // Previously a 500 carrying Mongoose's "Cast to ObjectId failed" message.
    const missing = await get('/garbage');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.route, '404');

    // The message names the path the client actually asked for. req.path alone
    // is mount-relative and would say only '/garbage'.
    assert.equal(missing.body.error, 'No such route: GET /api/template-listings/garbage');

    // ...and stops at the path. This app puts tokens in query strings, so
    // req.originalUrl would echo one back into an error body and the logs.
    const withQuery = await get('/garbage?token=secret-value&page=2');
    assert.equal(withQuery.status, 404);
    assert.ok(
      !withQuery.body.error.includes('secret-value'),
      `query string leaked into the 404: ${withQuery.body.error}`
    );
    assert.equal(withQuery.body.error, 'No such route: GET /api/template-listings/garbage');
  } finally {
    server.close();
  }
});

test('the same ordering on PATCH lets /reorder through', async () => {
  // routes/chatTemplates.js registers PATCH /:id at :382 and PATCH /reorder at
  // :568. The literal reached findByIdAndUpdate as an id and the cast threw, so
  // a documented endpoint answered 500 and could never run. Same shape here.
  const router = express.Router();
  router.patch('/:id', requireObjectId(), (req, res) => res.json({ route: 'id', id: req.params.id }));
  router.patch('/reorder', (req, res) => res.json({ route: 'reorder' }));
  router.use((req, res) => res.status(404).json({ route: '404' }));

  const app = express();
  app.use('/api/chat-templates', router);
  const server = app.listen(0);
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/chat-templates`;
    const patch = async path => {
      const res = await fetch(base + path, { method: 'PATCH' });
      return { status: res.status, body: await res.json() };
    };

    assert.deepEqual(await patch('/reorder'), { status: 200, body: { route: 'reorder' } });

    const id = '507f1f77bcf86cd799439011';
    assert.deepEqual(await patch(`/${id}`), { status: 200, body: { route: 'id', id } });
    assert.deepEqual(await patch('/garbage'), { status: 404, body: { route: '404' } });
  } finally {
    server.close();
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Catch the next `/:id` route that swallows a literal path.
 *
 * Express matches in registration order with no notion of a literal segment
 * being more specific than a parameter, so `router.get('/:id')` shadows every
 * single-segment path registered after it. Two of these had already shipped —
 * GET /cache-stats and PATCH /reorder — and both presented as a 500 naming
 * Mongoose's ObjectId cast, which points at the database rather than the router.
 *
 * The check is on the source text rather than on an imported router, because
 * importing every route module hangs: some of them open connections at load.
 * That makes this a lint, not a runtime assertion — it reads the registration
 * order that Express will later follow, and it is deliberately narrow. The
 * guard-detection self-check below fails loudly if the parsing stops working.
 */

const ROUTES_DIR = 'src/routes';

// `router.get('/path', ...` at the start of a line, which is how every route in
// this repo is registered. Group 3 is the rest of the line, where the
// middleware list lives.
const ROUTE_PATTERN = /^router\.(get|post|put|patch|delete)\(\s*'([^']+)'([^\n]*)/gm;

/** A single-segment literal path — '/cache-stats', not '/:id' or '/a/b'. */
const LITERAL_SEGMENT = /^\/[^/:]+$/;

function parseRoutes(source) {
  return [...source.matchAll(ROUTE_PATTERN)].map(match => ({
    method: match[1],
    path: match[2],
    middleware: match[3],
    line: source.slice(0, match.index).split('\n').length,
  }));
}

/** Param routes whose pattern shadows a literal path registered further down. */
function findShadowing(routes) {
  const shadowing = [];

  routes.forEach((route, i) => {
    const segments = route.path.split('/').filter(Boolean);
    if (segments.length !== 1 || !segments[0].startsWith(':')) return;

    const shadowed = routes
      .slice(i + 1)
      .filter(later => later.method === route.method && LITERAL_SEGMENT.test(later.path));

    if (shadowed.length) shadowing.push({ route, shadowed });
  });

  return shadowing;
}

function scanRouteFiles() {
  return fs
    .readdirSync(ROUTES_DIR)
    .filter(file => file.endsWith('.js'))
    .sort()
    .flatMap(file => {
      const routes = parseRoutes(fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8'));
      return findShadowing(routes).map(entry => ({ file, ...entry }));
    });
}

test('every route pattern that shadows a literal path carries requireObjectId', () => {
  const unguarded = scanRouteFiles().filter(
    entry => !entry.route.middleware.includes('requireObjectId')
  );

  const report = unguarded
    .map(({ file, route, shadowed }) => {
      const names = shadowed.map(s => `${s.method.toUpperCase()} ${s.path} (:${s.line})`).join(', ');
      return `  ${file}:${route.line} ${route.method.toUpperCase()} ${route.path} shadows ${names}`;
    })
    .join('\n');

  assert.equal(
    unguarded.length,
    0,
    `route patterns shadow literal paths registered after them.\n${report}\n` +
      'Add requireObjectId() after the auth middleware on the pattern route, ' +
      'so the literal falls through to the route that owns it.'
  );
});

test('the scan still recognises the two routes it was written for', () => {
  // Without this, a change that quietly breaks the parsing — a reformatted
  // registration, a renamed import — turns the test above into one that passes
  // by finding nothing at all.
  const found = scanRouteFiles().map(({ file, route }) => `${file} ${route.method} ${route.path}`);

  assert.deepEqual(found.sort(), [
    'chatTemplates.js patch /:id',
    'templateListings.js get /:id',
  ]);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Catch the next async route handler that can take the process down.
 *
 * Express 4 does not await route handlers, so a promise rejected inside an
 * unwrapped `async (req, res) => {}` never reaches the global error handler in
 * src/index.js. It surfaces as an unhandled rejection, and Node's default since
 * v15 is to rethrow that as an uncaught exception and exit. Sentry.init() does
 * not change this — the process still dies with code 1, which on Render looks
 * the same in the dashboard as an out-of-memory kill.
 *
 * The invariant enforced here is that every async handler is either wrapped in
 * asyncHandler() or contains a try block, so none of them is completely
 * unprotected. Wrapping is the better of the two — a try block that leaves an
 * await outside it still crashes — so the long-term goal is to require
 * asyncHandler() everywhere and drop the try escape hatch.
 *
 * Like routeShadowing.test.js this reads the source text rather than importing
 * the routers, because importing them hangs: some open connections at load.
 * That makes it a lint, and the self-check at the bottom fails loudly if the
 * parsing ever stops working.
 */

const ROUTES_DIR = 'src/routes';

/**
 * Walk JS source from `start`, yielding [index, char] for code positions only.
 * Strings, template literals, comments and regex literals are skipped whole, so
 * a brace in a comment or an apostrophe in `// don't` cannot throw off the
 * depth counting below.
 */
function* codePositions(source, start) {
  let i = start;
  let prev = '';
  while (i < source.length) {
    const c = source[i];
    const two = source.slice(i, i + 2);

    if (two === '//') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1;
      }
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '`') {
      // Track ${ } so a backtick nested in an interpolation ends the right template.
      let j = i + 1;
      let interpolation = 0;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source.startsWith('${', j)) { interpolation += 1; j += 2; continue; }
        if (interpolation && source[j] === '}') { interpolation -= 1; j += 1; continue; }
        if (source[j] === '`' && interpolation === 0) break;
        j += 1;
      }
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '/' && '(,=:[!&|?{};+-*%~^<>'.includes(prev)) {
      let j = i + 1;
      let inClass = false;
      let ok = true;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        else if (source[j] === '\n') { ok = false; break; }
        j += 1;
      }
      if (ok) { i = j + 1; prev = '/'; continue; }
    }

    yield [i, c];
    if (c.trim()) prev = c;
    i += 1;
  }
}

/** Index of the delimiter closing the one at `start`, or -1. */
function matchDelimiter(source, start, open, close) {
  let depth = 0;
  for (const [i, c] of codePositions(source, start)) {
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Start index of the final argument of the call opening at `openParen`.
 *
 * Argument commas sit at paren depth 1 with no open brace or bracket. Both
 * conditions are needed: `const { a, b } = req.query` inside a handler body is
 * still at paren depth 1, and would otherwise read as an argument separator.
 */
function lastArgumentStart(source, openParen) {
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let lastComma = null;

  for (const [i, c] of codePositions(source, openParen)) {
    if (c === '(') paren += 1;
    else if (c === ')') { paren -= 1; if (paren === 0) break; }
    else if (c === '{') brace += 1;
    else if (c === '}') brace -= 1;
    else if (c === '[') bracket += 1;
    else if (c === ']') bracket -= 1;
    else if (c === ',' && paren === 1 && brace === 0 && bracket === 0) lastComma = i;
  }

  let start = lastComma === null ? openParen + 1 : lastComma + 1;
  while (start < source.length && !source[start].trim()) start += 1;
  return start;
}

const ROUTE_START = /^router\.(get|post|put|patch|delete|all)\s*\(/gm;
const WRAPPED = /^asyncHandler\s*\(\s*async\s*\(/;
const BARE = /^async\s*\(/;

/** Every async route handler in one file, with how it is protected. */
function parseHandlers(source, file) {
  const handlers = [];

  for (const match of source.matchAll(ROUTE_START)) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = matchDelimiter(source, openParen, '(', ')');
    if (closeParen === -1) continue;

    const argStart = lastArgumentStart(source, openParen);
    const wrapped = WRAPPED.test(source.slice(argStart, argStart + 40));
    if (!wrapped && !BARE.test(source.slice(argStart, argStart + 20))) continue;

    // Step over the wrapper explicitly. Searching for 'async' would find the
    // one at the front of 'asyncHandler' and walk past the wrapper's own
    // closing paren, landing the body scan on the *next* route in the file.
    const wrapperPrefix = wrapped ? /^asyncHandler\s*\(\s*/.exec(source.slice(argStart))[0].length : 0;
    const asyncAt = argStart + wrapperPrefix;

    const paramsOpen = source.indexOf('(', asyncAt + 'async'.length);
    const paramsClose = paramsOpen === -1 ? -1 : matchDelimiter(source, paramsOpen, '(', ')');
    if (paramsClose === -1) continue;

    const bodyOpen = source.indexOf('{', paramsClose);
    const bodyClose = bodyOpen === -1 ? -1 : matchDelimiter(source, bodyOpen, '{', '}');
    if (bodyClose === -1) continue;

    handlers.push({
      file,
      line: source.slice(0, match.index).split('\n').length,
      method: match[1],
      wrapped,
      hasTry: /\btry\s*\{/.test(source.slice(bodyOpen, bodyClose + 1)),
    });
  }

  return handlers;
}

function scanRouteFiles() {
  return fs
    .readdirSync(ROUTES_DIR)
    .filter(file => file.endsWith('.js'))
    .sort()
    .flatMap(file =>
      parseHandlers(fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8'), file)
    );
}

test('every async route handler is wrapped in asyncHandler or catches its own errors', () => {
  const unprotected = scanRouteFiles().filter(h => !h.wrapped && !h.hasTry);

  const report = unprotected
    .map(h => `  ${h.file}:${h.line} ${h.method.toUpperCase()}`)
    .join('\n');

  assert.equal(
    unprotected.length,
    0,
    `async route handlers with no error handling at all.\n${report}\n` +
      "Wrap the handler in asyncHandler() from src/utils/asyncHandler.js so a " +
      'rejected promise reaches the global error handler instead of exiting the process.'
  );
});

test('the scan still recognises both handler shapes', () => {
  // Without this, a reformatted registration or a renamed wrapper turns the
  // test above into one that passes by parsing nothing at all.
  const fixture = `
router.get('/wrapped', requireAuth, asyncHandler(async (req, res) => {
  const { a, b } = req.query;      // a comma at paren depth 1, inside braces
  res.json(await load(a, b));
}));

router.post('/bare', requireAuth, async (req, res) => {
  res.json({ ok: true });          // don't let this apostrophe eat the file
});

router.put('/caught', async (req, res) => {
  try { res.json(await load()); } catch (e) { res.status(500).json({ e }); }
});

router.get('/nested', asyncHandler(async (req, res) => {
  const rows = await Promise.all(ids.map(async (id) => fetch(id)));
  res.json(rows);
}));
`;

  assert.deepEqual(
    parseHandlers(fixture, 'fixture.js').map(h => `${h.method} wrapped=${h.wrapped} try=${h.hasTry}`),
    [
      'get wrapped=true try=false',
      'post wrapped=false try=false',
      'put wrapped=false try=true',
      'get wrapped=true try=false',
    ]
  );

  // And that it still sees the real route files, so a parser that silently
  // returns nothing cannot make the guard above vacuous.
  const real = scanRouteFiles();
  assert.ok(real.length > 400, `expected the scan to find the route handlers, got ${real.length}`);
  assert.ok(real.some(h => h.wrapped), 'expected at least one asyncHandler-wrapped route');
});

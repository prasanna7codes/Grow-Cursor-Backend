import assert from 'node:assert/strict';
import test from 'node:test';
import { locateImageColumns, parseCsv, toCsv } from '../src/utils/feedCsv.js';

// ── Round trip ───────────────────────────────────────────────────────────────
//
// A feed file is rewritten in place and sent to eBay, so anything this parser
// mangles becomes a malformed listing rather than a visible error. The
// description cell is the dangerous one: it carries HTML full of commas,
// apostrophes and quotes.

test('a quoted cell containing commas survives a round trip', () => {
  const cell = 'For iPhone 17 Pro Case with Crystal Clear, Upgraded Anti-Yellowing, 6.3"';
  const rows = parseCsv(toCsv([['Title', 'Description'], [cell, 'x']]));

  assert.equal(rows[1][0], cell);
});

test('embedded double quotes are unescaped correctly', () => {
  // Written by eBay as "" inside a quoted field.
  const rows = parseCsv('a,"he said ""hi""",c');
  assert.deepEqual(rows[0], ['a', 'he said "hi"', 'c']);
});

test('newlines inside a quoted cell stay inside that cell', () => {
  const rows = parseCsv('a,"line one\nline two",c\nnext,row,here');

  assert.equal(rows.length, 2);
  assert.equal(rows[0][1], 'line one\nline two');
  assert.deepEqual(rows[1], ['next', 'row', 'here']);
});

test('CRLF line endings do not leave stray carriage returns', () => {
  const rows = parseCsv('a,b\r\nc,d\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['c', 'd']]);
});

test('a description cell of real listing HTML round trips byte for byte', () => {
  const html =
    "<div style='max-width:1000px;'> <img src='https://i.ebayimg.com/00/s/x/z/y/$_1.JPG?set_id=8800005007' width='100%'> " +
    '<span>Free &amp; Fast, 1-Day Handling</span> <a href=\'{store_url}\'>VISIT</a> </div>';

  const rows = parseCsv(toCsv([['Description'], [html]]));
  assert.equal(rows[1][0], html);
});

test('empty trailing cells are preserved, not trimmed away', () => {
  // Feed rows end in long runs of empty optional columns; losing them shifts
  // every value left and silently rewrites the listing.
  const rows = parseCsv('a,b,,,');
  assert.deepEqual(rows[0], ['a', 'b', '', '', '']);
});

test('a UTF-8 BOM does not become part of the first header name', () => {
  const rows = parseCsv('\uFEFFAction,Custom label (SKU)');
  assert.equal(rows[0][0], 'Action');
});

// ── Column location ──────────────────────────────────────────────────────────

const FEED_ROWS = [
  ['#INFO', 'Created=1787774982293', ''],
  ['#INFO', 'Version=1.0', ''],
  ['#INFO', '', ''],
  ['*Action(SiteID=US|Country=US|Currency=USD|Version=1193)', 'Custom label (SKU)', 'Item photo URL', 'Description'],
  ['Add', 'GRW25514QH', 'https://i.ebayimg.com/x.jpg', '<div>hi</div>'],
];

test('the header row is found past the #INFO preamble', () => {
  const columns = locateImageColumns(FEED_ROWS);

  assert.equal(columns.headerIndex, 3);
  assert.equal(columns.photo, 2);
  assert.equal(columns.description, 3);
});

test('column names are matched despite case and padding from Excel', () => {
  const columns = locateImageColumns([['  ITEM PHOTO URL ', 'DESCRIPTION']]);

  assert.equal(columns.photo, 0);
  assert.equal(columns.description, 1);
});

test('a feed with no photo column is reported rather than guessed at', () => {
  // Inventory and order feeds go through the same upload route and must pass
  // through untouched.
  assert.equal(locateImageColumns([['SKU', 'Quantity'], ['A1', '5']]), null);
  assert.equal(locateImageColumns([]), null);
});

test('a missing description column is reported as -1, not as absent', () => {
  const columns = locateImageColumns([['Item photo URL', 'Quantity']]);

  assert.equal(columns.photo, 0);
  assert.equal(columns.description, -1);
});

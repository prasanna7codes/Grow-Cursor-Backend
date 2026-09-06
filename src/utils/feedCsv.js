/**
 * Minimal RFC 4180 CSV reader/writer for eBay feed files.
 *
 * Written rather than pulled in because the feed format needs exactly two
 * things and both are small: read a file back into rows, and write those rows
 * out again byte-compatibly with what the export routes already produce.
 *
 * The quoting rules here mirror the serializer inlined in routes/
 * templateListings.js — quote when the value holds a comma, quote or newline,
 * and double any embedded quote. A description cell carries HTML with commas,
 * single quotes and apostrophes in it, so getting this wrong corrupts the file
 * rather than merely rearranging it.
 */

/**
 * @param {string} text
 * @returns {string[][]} rows of raw cell values, quotes already resolved
 */
export function parseCsv(text) {
  // A BOM survives a round trip through Excel and would otherwise become part
  // of the first header's name, which is how "Action" stops matching.
  const source = String(text || '').replace(/^﻿/, '');

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        // "" inside a quoted field is a literal quote, not the end of it.
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      // Newlines inside quotes belong to the value — descriptions contain them.
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }

    // Bare CR is a line ending's first half; the LF below closes the row.
    if (char === '\r') {
      i += 1;
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  // A file not ending in a newline still has one row left in hand.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * @param {string[][]} rows
 * @returns {string} CSV text, newline-separated
 */
export function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? '');
          return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(',')
    )
    .join('\n');
}

/**
 * Find the row holding the column names, and the columns we need to rewrite.
 *
 * eBay feed files open with several `#INFO` lines before the real header, and
 * the first column's name carries the whole SiteID/Currency/Version blob, so
 * the header cannot be assumed to be row 0 nor matched on its first cell.
 * Locating it by a column we actually need is both simpler and self-checking.
 *
 * Matching is case- and space-insensitive because these files are routinely
 * opened and re-saved in Excel on the way through.
 *
 * @param {string[][]} rows
 * @returns {{headerIndex: number, photo: number, description: number}|null}
 *   null when there is no recognisable photo column, i.e. not a listing feed
 */
export function locateImageColumns(rows) {
  const normalise = (value) => String(value || '').trim().toLowerCase();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const photo = row.findIndex((cell) => normalise(cell) === 'item photo url');

    if (photo !== -1) {
      return {
        headerIndex: index,
        photo,
        description: row.findIndex((cell) => normalise(cell) === 'description'),
      };
    }
  }

  return null;
}

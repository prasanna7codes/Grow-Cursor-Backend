/**
 * Search-keyword helpers shared by the ASIN list taxonomy
 * (AsinListCategory -> AsinListRange -> AsinListProduct).
 *
 * Scrapingdog's Amazon Search API takes a keyword and a page number and
 * nothing else — no browse node, no price filter, no sort. So a "category"
 * in the sourcing flow is a saved set of keywords hanging off the taxonomy
 * we already had for organising the ASIN directory, and these helpers are
 * what keep those sets clean on the way in and usable on the way out.
 *
 * Pure by design: the models import this, so it must never import a model.
 */

// Amazon's own search box stops being useful well before this; a longer
// string is a paste accident rather than a keyword.
const MAX_QUERY_LENGTH = 120;
const MAX_QUERIES_PER_NODE = 25;

/**
 * Trim, drop empties, collapse inner whitespace, and de-duplicate
 * case-insensitively while keeping the first spelling the user typed
 * (so "MagSafe Case" survives rather than being flattened to lowercase).
 *
 * @param {unknown} value - anything; non-arrays become []
 * @returns {string[]}
 */
export function normalizeSearchQueries(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const out = [];

  for (const raw of value) {
    const query = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
    if (!query) continue;

    const key = query.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(query);
    if (out.length >= MAX_QUERIES_PER_NODE) break;
  }

  return out;
}

/**
 * Merge keyword sets from several taxonomy nodes into one de-duplicated list.
 * Order is preserved so the most specific node's keywords get searched first,
 * which matters when a run hits its page ceiling before its target count.
 *
 * @param {...(string[]|undefined)} lists
 * @returns {string[]}
 */
export function mergeSearchQueries(...lists) {
  return normalizeSearchQueries(lists.flatMap(list => (Array.isArray(list) ? list : [])));
}

/**
 * A node with no keywords of its own still has to be searchable, or a
 * category nobody has configured yet would silently return zero ASINs.
 * Its name is the honest default — it is what the operator called the thing.
 *
 * @param {string[]} queries - already-normalized keywords
 * @param {string} name - the node's own name
 * @returns {string[]} never empty unless the name is empty too
 */
export function withNameFallback(queries, name) {
  if (queries.length > 0) return queries;
  return normalizeSearchQueries([name]);
}

export const SEARCH_QUERY_LIMITS = { MAX_QUERY_LENGTH, MAX_QUERIES_PER_NODE };

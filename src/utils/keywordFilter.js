/**
 * Keyword grammar for the Listing Overlays search.
 *
 * Space-separated words must ALL appear, in any order and any position —
 * "phone case" matches "Slim Magnetic Phone Cover Case". Comma-separated
 * terms are alternatives — "strap,band" matches either, and
 * "apple strap,apple band" means (apple AND strap) OR (apple AND band).
 *
 * eBay's own search ORs the words, which is the opposite of what an operator
 * badging a batch wants: every match receives the same badge, so precision
 * beats recall. Plain substring matching (the first version here) was too
 * strict the other way — it required the words to be adjacent and in order.
 */

/**
 * @param {string} raw - e.g. "phone case, watch strap"
 * @returns {string[][]} OR-groups of AND-words, lowercased; [] when empty
 */
export function parseKeywordQuery(raw) {
  return String(raw || '')
    .toLowerCase()
    .split(',')
    .map((term) => term.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

/**
 * @param {string} haystack - lowercased text to search in
 * @param {string[][]} groups - output of parseKeywordQuery()
 * @returns {boolean} true when any group has all of its words present
 */
export function matchesKeywords(haystack, groups) {
  if (!groups.length) return true;
  return groups.some((words) => words.every((word) => haystack.includes(word)));
}

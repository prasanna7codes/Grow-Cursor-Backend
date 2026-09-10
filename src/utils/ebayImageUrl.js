/**
 * The SKU index stores each listing's gallery thumbnail, which eBay serves at
 * 140–225px. Reverse-image search wants the largest copy available, and eBay's
 * picture URLs encode the size in the path, so the full-size variant is a
 * string substitution away rather than another GetItem call.
 *
 *   https://i.ebayimg.com/images/g/abc/s-l225.jpg   → …/s-l1600.jpg
 *   https://i.ebayimg.com/00/s/…/z/abc/$_1.JPG?…     → …/$_57.JPG?…
 *
 * Anything else is returned untouched.
 */
export function upsizeEbayImageUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (!/ebayimg\.com/i.test(value)) return value;

  return value
    .replace(/\/s-l\d+(\.[a-z]+)/i, '/s-l1600$1')
    .replace(/\/\$_\d+(\.[a-z]+)/i, '/$_57$1');
}

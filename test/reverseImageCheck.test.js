import assert from 'node:assert/strict';
import test from 'node:test';
import {
  combineImageAssessments,
  extractHost,
  getIpRiskConfig,
  hostMatchesBrand,
  isAmazonHost,
  isNamedBrand,
  isNeutralHost,
  lensToWebDetection,
  normalizeBrand,
  resolveProvider,
  scoreWebDetection,
  textContainsBrand
} from '../src/utils/reverseImageCheck.js';

// ── Brand normalisation ──────────────────────────────────────────────────────
//
// Amazon's brand field arrives in several shapes; every one of them must map
// to the same name or the Amazon-brand rules silently never fire.

test('the Amazon brand field is normalised to a bare name', () => {
  assert.equal(normalizeBrand('Visit the Spigen Store'), 'spigen');
  assert.equal(normalizeBrand('Brand: OtterBox'), 'otterbox');
  assert.equal(normalizeBrand('  AP Bands™ '), 'ap bands');
});

test('generic brand values do not count as a named brand', () => {
  for (const value of ['', 'Generic', 'Unbranded', 'No Brand', 'N/A', 'Unknown', 'OEM']) {
    assert.equal(isNamedBrand(value), false, `"${value}" should be generic`);
  }
  assert.equal(isNamedBrand('Spigen'), true);
  assert.equal(isNamedBrand('btootos'), true);
});

// ── Host handling ────────────────────────────────────────────────────────────

test('hosts are extracted without the www prefix and bad URLs give an empty host', () => {
  assert.equal(extractHost('https://www.spigen.com/products/rugged-armor'), 'spigen.com');
  assert.equal(extractHost('https://m.media-amazon.com/images/I/abc.jpg'), 'm.media-amazon.com');
  assert.equal(extractHost('not a url'), '');
});

test('marketplaces, their CDNs and social sites are neutral regardless of TLD', () => {
  for (const host of [
    'amazon.com', 'amazon.co.uk', 'amazon.de', 'm.media-amazon.com',
    'images-na.ssl-images-amazon.com', 'i.ebayimg.com', 'ebay.com.au',
    'aliexpress.us', 'i.pinimg.com', 'camelcamelcamel.com'
  ]) {
    assert.equal(isNeutralHost(host), true, `${host} should be neutral`);
  }
  for (const host of ['spigen.com', 'apbands.com', 'weathertech.com', 'shop.example.myshopify.com']) {
    assert.equal(isNeutralHost(host), false, `${host} should not be neutral`);
  }
});

test('Amazon hosts are told apart from other marketplaces', () => {
  assert.equal(isAmazonHost('amazon.ae'), true);
  assert.equal(isAmazonHost('m.media-amazon.com'), true);
  assert.equal(isAmazonHost('walmart.com'), false);
});

test('operator-supplied neutral domains match as suffix or label', () => {
  assert.equal(isNeutralHost('www.desertcart.com', ['desertcart.com']), true);
  assert.equal(isNeutralHost('uae.desertcart.com', ['desertcart.com']), true);
  assert.equal(isNeutralHost('fruugo.co.uk', ['fruugo']), true);
  assert.equal(isNeutralHost('fruugostore.com', ['fruugo']), false);
});

// ── Brand matching ───────────────────────────────────────────────────────────

test('brand names match as whole words only', () => {
  assert.equal(textContainsBrand('Spigen Rugged Armor iPhone case', 'spigen'), true);
  assert.equal(textContainsBrand('Apple iPhone 15 Pro case', 'ap'), false, 'two-letter brands never match prose');
  assert.equal(textContainsBrand('Otterproducts wholesale', 'otter'), false, 'substring of a longer word is not a hit');
  assert.equal(textContainsBrand('AP Bands magnetic strap', 'ap bands'), true);
  assert.equal(textContainsBrand('APBands magnetic strap', 'ap bands'), true, 'internal whitespace is optional');
});

test('a brand matches a hostname only as a whole label', () => {
  assert.equal(hostMatchesBrand('apbands.com', 'AP Bands'), true);
  assert.equal(hostMatchesBrand('shop.spigen.com', 'Spigen'), true);
  assert.equal(hostMatchesBrand('apple.com', 'ap'), false);
  assert.equal(hostMatchesBrand('otterproducts.com', 'otter'), false);
});

// ── Provider resolution ──────────────────────────────────────────────────────

test('auto provider prefers Vision, then Scrapingdog, then nothing', () => {
  assert.equal(resolveProvider({ GOOGLE_VISION_API_KEY: 'g', SCRAPINGDOG_API_KEY: 's' }), 'vision');
  assert.equal(resolveProvider({ SCRAPINGDOG_API_KEY: 's' }), 'scrapingdog');
  assert.equal(resolveProvider({}), null);
  assert.equal(resolveProvider({ IP_RISK_PROVIDER: 'scrapingdog', GOOGLE_VISION_API_KEY: 'g', SCRAPINGDOG_API_KEY: 's' }), 'scrapingdog');
  assert.equal(resolveProvider({ IP_RISK_PROVIDER: 'vision', SCRAPINGDOG_API_KEY: 's' }), null, 'an explicit provider without its key is off, not silently swapped');
  assert.equal(resolveProvider({ IP_RISK_PROVIDER: 'off', SCRAPINGDOG_API_KEY: 's' }), null);
});

test('the per-photo defaults follow the provider', () => {
  const lens = getIpRiskConfig({ SCRAPINGDOG_API_KEY: 's' });
  assert.equal(lens.provider, 'scrapingdog');
  assert.equal(lens.imagesPerAsin, 1, 'Lens defaults to the main photo only');
  assert.equal(lens.creditsPerImage, 5);

  const vision = getIpRiskConfig({ GOOGLE_VISION_API_KEY: 'g' });
  assert.equal(vision.imagesPerAsin, 3);
  assert.equal(vision.creditsPerImage, 1);

  assert.equal(getIpRiskConfig({ SCRAPINGDOG_API_KEY: 's', IP_RISK_IMAGES_PER_ASIN: '2' }).imagesPerAsin, 2, 'env overrides the default');
});

// ── Lens adapter ─────────────────────────────────────────────────────────────

test('Scrapingdog Lens results become partial page matches in similar mode', () => {
  // Shape as returned by the live endpoint on 2026-09-10.
  const detection = lensToWebDetection({
    lens_results: [
      { title: 'Spigen Cases', link: 'https://www.walmart.com/c/kp/spigen-cases?page=3', source: 'www.walmart.com', thumbnail: 't1', original_thumbnail: 'o1', position: 1 },
      { title: 'CAT Mud Flaps | eBay', link: 'https://www.ebay.com/itm/1', source: 'eBay', thumbnail: 't2', position: 2 }
    ],
    related_searches: [{ title: 'Samsung Galaxy', link: '/search?q=x', thumbnail: 'data:...' }]
  });

  assert.equal(detection.mode, 'similar');
  assert.equal(detection.pagesWithMatchingImages.length, 2);
  assert.equal(detection.pagesWithMatchingImages[0].pageTitle, 'Spigen Cases');
  assert.equal(detection.pagesWithMatchingImages[0].partialMatchingImages[0].url, 'o1');
  assert.equal(extractHost(detection.pagesWithMatchingImages[1].url), 'ebay.com');
  assert.deepEqual(detection.webEntities, [{ description: 'Samsung Galaxy', score: 0.5 }]);
});

// ── Scoring: exact mode (Vision) ─────────────────────────────────────────────
//
// Each case is a WebDetection shape Google actually returns, trimmed to the
// fields the scorer reads.

test('a blocked brand in Google\'s own entities is high risk even with no page matches', () => {
  const result = scoreWebDetection({
    webEntities: [{ description: 'Spigen', score: 0.9 }, { description: 'Mobile phone case', score: 0.7 }],
    bestGuessLabels: [{ label: 'spigen rugged armor iphone 17 pro' }]
  }, { amazonBrand: 'Unbranded' });

  assert.equal(result.level, 'high');
  assert.ok(result.brandHits.includes('spigen'));
  assert.match(result.reasons[0], /blocked brand: spigen/);
  // "Rugged Armor" is a Spigen product line on the watch list, so the label
  // names the rights owner twice over.
  assert.ok(result.brandHits.includes('rugged armor'));
});

test('a blocked brand in an Amazon page title still counts', () => {
  const result = scoreWebDetection({
    pagesWithMatchingImages: [{
      url: 'https://www.amazon.com/dp/B0FD285J4D',
      pageTitle: 'Amazon.com: <b>Spigen</b> Rugged Armor Case',
      fullMatchingImages: [{ url: 'https://m.media-amazon.com/images/I/x.jpg' }]
    }]
  }, { amazonBrand: 'Generic' });

  assert.equal(result.level, 'high');
  assert.ok(result.brandHits.includes('spigen'));
  assert.deepEqual(result.matchedDomains, [], 'Amazon is not an external host');
});

test('the Amazon brand\'s own site hosting the photo is high risk', () => {
  const result = scoreWebDetection({
    pagesWithMatchingImages: [
      { url: 'https://www.amazon.com/dp/B0DKFN7NX1', pageTitle: 'Amazon.com: AP Bands strap', fullMatchingImages: [{ url: 'x' }] },
      { url: 'https://www.apbands.com/products/ultra-strap', pageTitle: 'Ultra Strap', fullMatchingImages: [{ url: 'y' }] }
    ]
  }, { amazonBrand: 'Visit the AP Bands Store', watchBrands: [] });

  assert.equal(result.level, 'high');
  assert.deepEqual(result.matchedDomains, ['apbands.com']);
  assert.match(result.reasons[0], /brand's own site: apbands.com/);
});

test('the Amazon brand in its own Amazon page title alone is NOT a brand hit', () => {
  const result = scoreWebDetection({
    pagesWithMatchingImages: [
      { url: 'https://www.amazon.com/dp/B0FHWGB7FW', pageTitle: 'Amazon.com: btootos Wireless Earbuds', fullMatchingImages: [{ url: 'x' }] }
    ],
    webEntities: [{ description: 'Headphones', score: 0.8 }]
  }, { amazonBrand: 'btootos' });

  assert.equal(result.level, 'low');
  assert.match(result.reasons[0], /only found on marketplaces/);
  assert.match(result.reasons[1], /Amazon brand is "btootos"/);
});

test('the Amazon brand in Google\'s best-guess label is high risk', () => {
  const result = scoreWebDetection({
    bestGuessLabels: [{ label: 'btootos wireless earbuds' }]
  }, { amazonBrand: 'btootos' });

  assert.equal(result.level, 'high');
  assert.match(result.reasons[0], /Google associates this photo with the Amazon brand "btootos"/);
});

test('a branded product whose exact photo lives on an unrecognised site is high risk', () => {
  const result = scoreWebDetection({
    partialMatchingImages: [{ url: 'https://cdn.shopify.com/s/files/1/strap.jpg' }],
    pagesWithMatchingImages: [{ url: 'https://coolstraps.io/p/1', pageTitle: 'Magnetic strap', partialMatchingImages: [{ url: 'z' }] }]
  }, { amazonBrand: 'Acme Straps' });

  assert.equal(result.level, 'high');
  assert.deepEqual(result.matchedDomains.sort(), ['cdn.shopify.com', 'coolstraps.io']);
  assert.match(result.reasons[0], /Branded product \("Acme Straps"\)/);
});

test('an unbranded product whose exact photo lives on unrecognised sites is only medium', () => {
  const result = scoreWebDetection({
    pagesWithMatchingImages: [
      { url: 'https://randomdropshipper.com/p/1', pageTitle: 'Valve caps', fullMatchingImages: [{ url: 'a' }] },
      { url: 'https://www.amazon.com/dp/X', pageTitle: 'Amazon.com: valve caps', fullMatchingImages: [{ url: 'b' }] }
    ]
  }, { amazonBrand: 'Generic' });

  assert.equal(result.level, 'medium');
  assert.deepEqual(result.matchedDomains, ['randomdropshipper.com']);
});

test('extra neutral domains from config demote an exact match to low', () => {
  const detection = {
    pagesWithMatchingImages: [
      { url: 'https://www.desertcart.com/products/1', pageTitle: 'Valve caps', fullMatchingImages: [{ url: 'a' }] }
    ]
  };
  assert.equal(scoreWebDetection(detection, { amazonBrand: 'Generic' }).level, 'medium');
  assert.equal(scoreWebDetection(detection, { amazonBrand: 'Generic', neutralDomains: ['desertcart.com'] }).level, 'low');
});

test('an empty detection is low risk with an explanatory reason', () => {
  const result = scoreWebDetection({}, { amazonBrand: '' });
  assert.equal(result.level, 'low');
  assert.match(result.reasons[0], /No matching results/);
});

test('low-score entities are ignored so noise cannot trigger a brand hit', () => {
  const result = scoreWebDetection({
    webEntities: [{ description: 'Spigen', score: 0.05 }]
  }, { amazonBrand: 'Generic' });
  assert.equal(result.level, 'low');
});

// ── Scoring: similar mode (Google Lens via Scrapingdog) ──────────────────────
//
// Lens returns look-alike listings from other shops, so hosting is not
// evidence; what the results are TITLED is. These mirror the live probes.

const lens = (results, related = []) => lensToWebDetection({
  lens_results: results.map((item, index) => ({ position: index + 1, ...item })),
  related_searches: related.map(title => ({ title }))
});

test('similar mode: many unrecognised shops with no brand in their titles is low, not medium', () => {
  const result = scoreWebDetection(lens([
    { title: 'Truck Hardware Gatorback Mud Flaps GM1223CUTRV | RealTruck', link: 'https://realtruck.com/p/1' },
    { title: 'Gatorback 10"x18" Mud Flaps - SharpTruck.com', link: 'https://www.sharptruck.com/p/2' },
    { title: 'Shop - Page 9 of 164 - The Truck Outfitters', link: 'https://thetruckoutfitters.com/shop' }
  ]), { amazonBrand: 'Unbranded' });

  assert.equal(result.level, 'low');
  assert.deepEqual(result.matchedDomains, []);
  assert.match(result.reasons[0], /Similar listings found; none tie the photo to a brand/);
});

test('similar mode: a watch-listed rights owner in result titles is high even when Amazon says Unbranded', () => {
  // The live probe: a Cat® mud flap listed on Amazon as "Unbranded".
  const result = scoreWebDetection(lens([
    { title: 'Amazon.com: Cat® Mud Flaps for Trucks - Heavy Duty Rubber', link: 'https://www.amazon.com/dp/B08Q38Y3HX' },
    { title: 'CAT Mud Flaps Splash Guards for Front or Rear Tires | eBay', link: 'https://www.ebay.com/itm/1' },
    { title: 'Amazon.com: Caterpillar Heavy Duty Splash Guards Pro Mud Flaps', link: 'https://www.amazon.com/dp/X' }
  ], ['CAT']), { amazonBrand: 'Unbranded' });

  assert.equal(result.level, 'high');
  assert.ok(result.brandHits.includes('caterpillar'));
  assert.match(result.reasons[0], /rights owner: caterpillar/);
});

test('similar mode: a rights owner named once far down the list is a look-alike, not evidence', () => {
  // Straight from the live Cat® mud flap probe: Husky Liners is a competing
  // product at position 6, while Caterpillar owns the top of the list.
  const filler = (title, index) => ({ title, link: `https://shop${index}.com/p` });
  const results = [
    filler('Heavy Duty Rubber Truck Mud Flaps', 1),
    filler('Universal Splash Guards 24x24', 2),
    filler('Rubber Mudflaps Black', 3),
    filler('Truck Wheel Liner Set', 4),
    filler('Mud Flaps Front or Rear', 5),
    { title: 'Husky Liners Universal MudDog Mud Flaps | Rubber Front', link: 'https://www.amazon.ae/dp/X' }
  ];

  const tailOnly = scoreWebDetection(lens(results), { amazonBrand: 'Unbranded' });
  assert.equal(tailOnly.level, 'low');
  assert.deepEqual(tailOnly.brandHits, []);

  // The same name twice, or once at the head, is a different story.
  const twice = scoreWebDetection(lens([...results, filler('Husky Liners MudDog flaps', 7)]), { amazonBrand: 'Unbranded' });
  assert.equal(twice.level, 'high');
  assert.ok(twice.brandHits.includes('husky liners'));

  const atHead = scoreWebDetection(lens([results[5], ...results.slice(0, 5)]), { amazonBrand: 'Unbranded' });
  assert.equal(atHead.level, 'high');
  assert.ok(atHead.brandHits.includes('husky liners'));
});

test('similar mode: a blocked brand in a marketplace result title is high', () => {
  // The live probe for a Spigen case: first result is Walmart's Spigen page.
  const result = scoreWebDetection(lens([
    { title: 'Spigen Cases', link: 'https://www.walmart.com/c/kp/spigen-cases' }
  ]), { amazonBrand: 'Unbranded' });

  assert.equal(result.level, 'high');
  assert.ok(result.brandHits.includes('spigen'));
});

test('similar mode: an automaker with an emblem word in a matching title is high', () => {
  const result = scoreWebDetection(lens([
    { title: 'Honda Logo Tire Valve Stem Caps 4 Pack Black | eBay', link: 'https://www.ebay.com/itm/2' },
    { title: 'Valve caps for Honda CR-V', link: 'https://www.walmart.com/ip/3' }
  ]), { amazonBrand: 'Generic' });

  assert.equal(result.level, 'high');
  assert.ok(result.brandHits.includes('honda'));
  assert.match(result.reasons[0], /honda emblem\/logo product/);
});

test('similar mode: an automaker mentioned as a fitment target only reaches medium, and once is nothing', () => {
  const repeated = scoreWebDetection(lens([
    { title: 'Mud Flaps for 2019-2025 Toyota RAV4 Front Rear', link: 'https://www.walmart.com/ip/1' },
    { title: 'Toyota RAV4 Splash Guards Set | eBay', link: 'https://www.ebay.com/itm/2' },
    { title: 'RAV4 2019+ mud flaps by Toyota fitment', link: 'https://realtruck.com/p/3' }
  ]), { amazonBrand: 'Generic' });
  assert.equal(repeated.level, 'medium');
  assert.match(repeated.reasons[0], /Strongly associated with toyota/);

  const once = scoreWebDetection(lens([
    { title: 'Mud Flaps for 2019-2025 Toyota RAV4 Front Rear', link: 'https://www.walmart.com/ip/1' },
    { title: 'Universal mud flaps', link: 'https://www.ebay.com/itm/2' }
  ]), { amazonBrand: 'Generic' });
  assert.equal(once.level, 'low');
});

test('similar mode: the Amazon brand needs two non-Amazon result titles, and Amazon-only titles do not count', () => {
  const amazonOnly = scoreWebDetection(lens([
    { title: 'Amazon.com: btootos Wireless Earbuds', link: 'https://www.amazon.com/dp/1' },
    { title: 'Amazon.ca: btootos Earbuds', link: 'https://www.amazon.ca/dp/1' }
  ]), { amazonBrand: 'btootos' });
  assert.equal(amazonOnly.level, 'low');

  const oneElsewhere = scoreWebDetection(lens([
    { title: 'Amazon.com: btootos Wireless Earbuds', link: 'https://www.amazon.com/dp/1' },
    { title: 'btootos earbuds | eBay', link: 'https://www.ebay.com/itm/1' }
  ]), { amazonBrand: 'btootos' });
  assert.equal(oneElsewhere.level, 'low', 'one look-alike title is not enough in similar mode');

  const twoElsewhere = scoreWebDetection(lens([
    { title: 'btootos earbuds | eBay', link: 'https://www.ebay.com/itm/1' },
    { title: 'btootos Wireless Earbuds - Walmart.com', link: 'https://www.walmart.com/ip/2' }
  ]), { amazonBrand: 'btootos' });
  assert.equal(twoElsewhere.level, 'high');
  assert.match(twoElsewhere.reasons[0], /2 listing\(s\) elsewhere titled with the Amazon brand "btootos"/);
});

test('similar mode: a Google related search naming the Amazon brand is high', () => {
  const result = scoreWebDetection(lens([
    { title: 'Magnetic watch strap', link: 'https://www.ebay.com/itm/1' }
  ], ['AP Bands']), { amazonBrand: 'AP Bands', watchBrands: [] });

  assert.equal(result.level, 'high');
  assert.match(result.reasons[0], /Google associates this photo with the Amazon brand "AP Bands"/);
});

test('similar mode only reads the head of the result list', () => {
  const filler = Array.from({ length: 20 }, (_, index) => ({ title: `Generic case ${index}`, link: `https://shop${index}.com/p` }));
  const result = scoreWebDetection(lens([
    ...filler,
    { title: 'Spigen Tough Armor', link: 'https://www.walmart.com/ip/late' }
  ]), { amazonBrand: 'Unbranded' });

  assert.equal(result.level, 'low', 'a brand name buried at position 21 is a look-alike, not this product');
});

// ── Combining per-image results ──────────────────────────────────────────────

test('the ASIN takes the worst image level and only that level\'s reasons', () => {
  const combined = combineImageAssessments([
    { level: 'low', reasons: ['No matching copies'], matchedDomains: [], brandHits: [], bestGuessLabels: ['case'] },
    { level: 'high', reasons: ['Photo associated with blocked brand: spigen'], matchedDomains: ['spigen.com'], brandHits: ['spigen'], bestGuessLabels: ['spigen case'] },
    { level: 'medium', reasons: ['Photo also hosted on: x.com'], matchedDomains: ['x.com'], brandHits: [], bestGuessLabels: [] }
  ]);

  assert.equal(combined.level, 'high');
  assert.deepEqual(combined.reasons, ['Photo associated with blocked brand: spigen']);
  assert.deepEqual(combined.matchedDomains.sort(), ['spigen.com', 'x.com']);
  assert.deepEqual(combined.brandHits, ['spigen']);
});

test('a failed image is reported alongside the scored ones, and all-failed is an error', () => {
  const partial = combineImageAssessments([
    { level: 'low', reasons: ['No matching copies'], matchedDomains: [], brandHits: [], bestGuessLabels: [] },
    { level: 'error', error: 'Google Vision request timed out' }
  ]);
  assert.equal(partial.level, 'low');
  assert.ok(partial.reasons.includes('1 image(s) could not be checked'));

  const failed = combineImageAssessments([{ level: 'error', error: 'Google Vision quota exceeded' }]);
  assert.equal(failed.level, 'error');
  assert.deepEqual(failed.reasons, ['Google Vision quota exceeded']);

  assert.equal(combineImageAssessments([]).level, 'unchecked');
});

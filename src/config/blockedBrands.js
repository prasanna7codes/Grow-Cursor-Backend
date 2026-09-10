// Brand lists shared by the ASIN precheck and the reverse-image IP risk check.
// All lower-case; matched as whole words against lower-cased text, or as a
// whole hostname label (apbands.com, shop.spigen.com).

// Brands the ASIN precheck never surfaces. A hit anywhere in the Amazon title,
// brand, or description drops the ASIN from the stream entirely rather than
// returning it as an excluded row, so these never reach the results table.
export const PRECHECK_BLOCKED_BRANDS = ['spigen', 'otterbox'];

// Rights owners known to file VeRO reports against resellers of their products
// or users of their photos. Seeded from the September 2026 policy-violation
// export. A reverse-image result that names one of these — a matching page
// title, Google's own label, or the brand's host — rates the photo high risk,
// even when the Amazon brand field says "Unbranded" (a Cat® mud flap listed
// as Unbranded was the first probe that proved this list necessary).
//
// Product brands only. Companies that are mostly a *compatibility target*
// ("strap for Samsung Galaxy Watch") live in OEM_BRANDS instead, where a bare
// mention is not enough on its own.
export const WATCH_BRANDS = [
  'spigen', 'otterbox', 'weathertech', 'caterpillar', 'cupfone', 'icarcover',
  'curt manufacturing', 'resmed', 'nilight', 'xprite', 'ap bands', 'apbands',
  'husky liners', 'grim reaper', 'stemco', 'thule', 'yakima', 'k&n', 'airaid',
  'covercraft', 'ultra hybrid', 'rugged armor', 'tough armor', 'liquid air',
  'symmetry series', 'commuter series', 'defender series', 'climate line',
  'climateline', 'airsense', 'aircurve'
];

// Vehicle makes and big consumer-electronics marks. Their names legitimately
// appear on compatible accessories, so a mention alone only rates medium;
// paired with "logo", "emblem", "badge", "genuine" or "oem" in a matching
// title it rates high, because that is how logo-bearing center caps, valve
// caps and hubcaps describe themselves.
export const OEM_BRANDS = [
  'honda', 'acura', 'toyota', 'lexus', 'nissan', 'infiniti', 'ford', 'lincoln',
  'chevrolet', 'chevy', 'gmc', 'cadillac', 'buick', 'dodge', 'ram trucks',
  'jeep', 'chrysler', 'mopar', 'tesla', 'bmw', 'mercedes', 'mercedes-benz',
  'audi', 'volkswagen', 'porsche', 'subaru', 'mazda', 'hyundai', 'kia',
  'genesis', 'jaguar', 'land rover', 'range rover', 'volvo', 'mini cooper',
  'mitsubishi', 'harley-davidson', 'harley davidson', 'ducati', 'yamaha',
  'kawasaki', 'polaris', 'can-am',
  'apple', 'samsung', 'sony', 'garmin', 'fitbit', 'bose', 'beats'
];

// Words that, next to an OEM brand in a matching title, mean the product
// carries the mark itself rather than merely fitting the vehicle.
export const OEM_EMBLEM_WORDS = ['logo', 'emblem', 'badge', 'genuine', 'oem', 'official', 'licensed'];

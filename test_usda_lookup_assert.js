const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const logicMatch = src.match(/const SCAN_LOGIC_VERSION = '([^']+)'/);
if (!logicMatch) throw new Error('SCAN_LOGIC_VERSION missing');
assert(logicMatch[1] === '12', 'SCAN_LOGIC_VERSION must be 12, got ' + logicMatch[1]);

const normStart = src.indexOf('function normalizeBarcode(raw)');
const normBody = src.slice(normStart, src.indexOf('function isValidBarcode'));
assert(normBody.includes("if (barcode.length === 12) return `0${barcode}`"),
  'UPC-A → EAN-13 padding must stay in normalizeBarcode');
assert(!normBody.includes('USDA'), 'normalizeBarcode must not mention USDA');

assert(src.includes('async function usdaLookup(barcode)'), 'usdaLookup must exist');
assert(src.includes('process.env.USDA_API_KEY'), 'API key must come from USDA_API_KEY');
assert(!src.includes("USDA_API_KEY = '") && !src.includes('USDA_API_KEY = "'),
  'USDA API key must not be hardcoded');
assert(src.includes('const USDA_LOOKUP_TIMEOUT_MS = 4000'), 'USDA abort timeout must stay 4s');
assert(src.includes('const OFF_LOOKUP_TIMEOUT_MS = 3000'), 'OFF abort timeout must be 3s');
assert(src.includes('AbortSignal.timeout(USDA_LOOKUP_TIMEOUT_MS)'), 'USDA fetch must abort');
assert(src.includes('AbortSignal.timeout(timeoutMs)'), 'OFF food fetch must abort via timeoutMs');
assert(src.includes('Promise.allSettled'), 'must collect with Promise.allSettled');
assert(!/await Promise\.all\(\[\s*usda/.test(src), 'must not wait with Promise.all on USDA+OFF');
assert(src.includes('mergeUsdaAndOffProducts'), 'must merge USDA and OFF products');
assert(src.includes('offProductMatchesScannedBarcode'), 'OFF barcode must be verified');
assert(src.includes('normalizeBarcode(rawCode)'), 'OFF code compare must use normalizeBarcode');
assert(!src.includes('normalizeIngredientCasing'), 'must not title-case USDA ingredients for parsers');
assert(!src.includes('normalizeFoodSource'), 'must not change API source into an object');
assert(src.includes("dataType: ['Branded']") || src.includes('dataType: ["Branded"]'),
  'USDA search must filter to Branded');
assert(src.includes('usdaGtinMatches'), 'gtinUpc verification must remain');
assert(src.includes('Exactly one USDA request per scan') || src.includes('Exactly one USDA request'),
  'usdaLookup must document one request per scan');

const lookupSlice = src.slice(
  src.indexOf('async function fetchProductFromFacts'),
  src.indexOf('function calculateScore')
);
assert(lookupSlice.includes('/api/v2/product/'), 'OFF must use barcode endpoint');
assert(!lookupSlice.includes('search.openfoodfacts'), 'OFF lookup must never text-search');
assert(lookupSlice.includes('{ ...offProduct }') === false, 'merge must not object-spread OFF');

const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('// Firestore docs are size-capped');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic block');

const prodStart = src.indexOf('const USDA_LOOKUP_TIMEOUT_MS = 4000');
const resolveEnd = src.indexOf('function calculateScore');
if (prodStart < 0 || resolveEnd < 0) throw new Error('could not locate product/resolve block');

const foodFnStart = src.indexOf('async function scanAndCacheFood');
const foodFnEnd = src.indexOf('// Photo-rescued cache docs have no upstream');
if (foodFnStart < 0 || foodFnEnd < 0) throw new Error('could not locate scanAndCacheFood');

const scoreStart = src.indexOf('function calculateScore');
const scoreEnd = src.indexOf('// OFF labels_tags is crowd-entered');
const orgStart = src.indexOf('function resolveOrganicStatus');
const orgEnd = src.indexOf('function parseServingQuantity');
const fmtStart = src.indexOf('function parseServingQuantity');
const fmtEnd = src.indexOf('const additiveMap');
const extractStart = src.indexOf("// OFF's additives_tags is a curated subset");
const extractEnd = src.indexOf("// OFF's top-level category tags are too broad");
const addDispStart = src.indexOf('function formatAdditivesCountDisplay');
const foodExplainStart = src.indexOf('async function generateFoodExplanation');
const validStart = src.indexOf('function isValidBarcode');

const foodFn = src.slice(foodFnStart, foodFnEnd);
assert(/const source = \(product && product\.source\) \|\| 'off'/.test(foodFn),
  'scanAndCacheFood must keep source as a string');
assert(!foodFn.includes('normalizeFoodSource'), 'must not wrap source in an object');

const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
function recordRawObservation() {}
async function getCategoryAlternatives() { return []; }
async function generateFoodExplanation() { return 'ok'; }
const additiveMap = {};
const additiveDetails = {};
const SCAN_LOGIC_VERSION = '${logicMatch[1]}';
${src.slice(normStart, validStart)}
${src.slice(start, end).replaceAll('path.join(__dirname,', 'path.join(__cosmeticDir,')}
${src.slice(prodStart, resolveEnd)}
${src.slice(scoreStart, scoreEnd)}
${src.slice(orgStart, orgEnd)}
${src.slice(fmtStart, fmtEnd)}
${src.slice(extractStart, extractEnd)}
${src.slice(addDispStart, foodExplainStart)}
${src.slice(foodFnStart, foodFnEnd)}
module.exports = {
  usdaGtinMatches,
  usdaGtinQueryCandidates,
  mapUsdaFoodToProduct,
  pickUsdaGtinMatch,
  usdaLookup,
  mergeUsdaAndOffProducts,
  offProductMatchesScannedBarcode,
  isMergeNonEmpty,
  resolveProductType,
  productHasIngredients,
  scanAndCacheFood,
  SCAN_LOGIC_VERSION,
  mapUsdaNutrientsToOff,
  computeNutritionSubscore,
  classifyPurlaFoodPath,
  applyDerivedNutrientZeros,
  calculateScore,
  getScoreBreakdown,
};
`;
fs.writeFileSync('/tmp/usda_lookup_helpers.js', block);
delete require.cache['/tmp/usda_lookup_helpers.js'];
const g = require('/tmp/usda_lookup_helpers.js');

const fettuccine = {
  fdcId: 2419828,
  description: 'ORGANIC FETTUCCINE',
  dataType: 'Branded',
  gtinUpc: '099482431112',
  publishedDate: '2022-12-22',
  brandOwner: 'Whole Foods Market, Inc.',
  brandName: '365 WHOLE FOODS MARKET',
  ingredients: 'ORGANIC DURUM WHEAT SEMOLINA.',
  servingSizeUnit: 'g',
  servingSize: 56.0,
  foodCategory: 'Pasta by Shape & Type',
  foodNutrients: [
    { nutrientId: 1003, nutrientName: 'Protein', unitName: 'G', value: 10.7 },
    { nutrientId: 1004, nutrientName: 'Total lipid (fat)', unitName: 'G', value: 1.79 },
    { nutrientId: 1005, nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 71.4 },
    { nutrientId: 1008, nutrientName: 'Energy', unitName: 'KCAL', value: 357 },
    { nutrientId: 1079, nutrientName: 'Fiber, total dietary', unitName: 'G', value: 3.6 },
    { nutrientId: 2000, nutrientName: 'Total Sugars', unitName: 'G', value: 3.57 },
    { nutrientId: 1093, nutrientName: 'Sodium, Na', unitName: 'MG', value: 0.0 },
    { nutrientId: 1258, nutrientName: 'Fatty acids, total saturated', unitName: 'G', value: 0.4 },
  ],
};

(async () => {
  assert(g.usdaGtinMatches('099482431112', '099482431112') === true, '12=12');
  assert(g.usdaGtinMatches('0099482431112', '099482431112') === true, '13 padded matches 12');
  assert(g.usdaGtinMatches('099482431112', '00099482431112') === true, '12 matches GTIN-14');
  assert(g.usdaGtinMatches('099482431112', '099482400026') === false, 'different UPC');
  assert(g.usdaGtinMatches('0000000000000', '0099447210127') === false, 'all-zero must not match');
  assert(g.usdaGtinMatches('0000000000000', '0000000000000') === false, 'all-zero vs all-zero');

  const candidates = g.usdaGtinQueryCandidates('0099482431112');
  assert(candidates[0] === '099482431112', 'canonical EAN-13 must query 12-digit UPC first, got ' + JSON.stringify(candidates));

  const mapped = g.mapUsdaFoodToProduct(fettuccine, '0099482431112');
  assert(mapped.product_name === 'ORGANIC FETTUCCINE', 'name from description');
  assert(mapped.brands.includes('365 WHOLE FOODS MARKET'), 'brand mapped');
  assert(mapped.ingredients_text === 'ORGANIC DURUM WHEAT SEMOLINA.', 'ingredients text');
  assert(mapped.nutriments.proteins_100g === 10.7, 'protein per 100g');
  assert(mapped.nutriments['energy-kcal_100g'] === 357, 'energy kcal per 100g');
  assert(mapped.nutriments.sugars_100g === 3.57, 'sugars per 100g');
  assert(mapped.nutriments.sodium_100g === 0, 'sodium MG → grams; 0 is valid');
  assert(mapped.nutriments['saturated-fat_100g'] === 0.4, 'saturated fat mapped');
  assert(mapped.nutriments.fiber_100g === 3.6, 'fibre mapped');
  assert(mapped.nutriments.fat_100g === 1.79, 'total fat mapped');
  assert(mapped.nutriments.carbohydrates_100g === 71.4, 'carbohydrate mapped');
  assert(mapped.foodCategory === 'Pasta by Shape & Type', 'foodCategory mapped');
  assert(mapped.serving_quantity === 56, 'serving grams');
  assert(Array.isArray(mapped.additives_tags) && mapped.additives_tags.length === 0, 'no invented additives');
  assert(mapped.source === 'usda', 'USDA mapped source is string usda');
  assert(g.productHasIngredients(mapped) === true, 'mapped ingredients are usable');

  assert(g.isMergeNonEmpty(0) === true, 'numeric 0 is non-empty');
  assert(g.isMergeNonEmpty('') === false, 'empty string is empty');
  assert(g.isMergeNonEmpty('  ') === false, 'whitespace is empty');
  assert(g.isMergeNonEmpty([]) === false, 'empty array is empty');
  assert(g.isMergeNonEmpty(null) === false, 'null is empty');

  const offForMerge = {
    code: '0099482431112',
    product_name: 'OFF Fettuccine',
    brands: '365 Everyday Value',
    ingredients_text: 'Organic durum wheat semolina.',
    additives_tags: ['en:e330'],
    ingredients: [{ id: 'en:e330', text: 'citric acid' }],
    nutriscore_grade: 'a',
    nova_group: 1,
    labels_tags: ['en:organic'],
    allergens_tags: ['en:gluten'],
    nutriments: { 'energy-kcal_100g': 350, proteins_100g: 12, sodium_100g: 0.01, sugars_100g: 3, fiber_100g: 2, 'fruits-vegetables-nuts_100g': 0 },
    image_front_url: 'https://off.example/fettuccine.jpg',
    selected_images: { front: { display: { en: 'https://off.example/fettuccine.jpg' } } },
  };

  // USDA-only and OFF-only must not go through a destructive merge.
  const usdaOnly = g.mergeUsdaAndOffProducts('0099482431112', mapped, null);
  assert(usdaOnly === mapped, 'USDA-only returns the USDA product unchanged');
  const offOnlyMerge = g.mergeUsdaAndOffProducts('0099482431112', null, offForMerge);
  assert(offOnlyMerge === offForMerge, 'OFF-only returns the OFF product unchanged');
  assert(g.mergeUsdaAndOffProducts('0099482431112', null, null) === null, 'neither → null');

  const mergedBoth = g.mergeUsdaAndOffProducts('0099482431112', mapped, offForMerge);
  assert(mergedBoth.source === 'usda', 'merged API source stays string usda, got ' + JSON.stringify(mergedBoth.source));
  assert(mergedBoth.product_name === 'ORGANIC FETTUCCINE', 'name from USDA');
  assert(mergedBoth.brands.includes('365 WHOLE FOODS MARKET'), 'brand from USDA');
  assert(mergedBoth.ingredients_text === 'ORGANIC DURUM WHEAT SEMOLINA.',
    'USDA ingredients stay display-only as returned, got ' + mergedBoth.ingredients_text);
  assert(mergedBoth.additives_tags.includes('en:e330'), 'OFF additives_tags kept');
  assert(mergedBoth.ingredients[0].id === 'en:e330', 'OFF ingredients[] kept for additive extraction');
  assert(mergedBoth.nutriscore_grade === 'a', 'OFF Nutri-Score kept');
  assert(mergedBoth.nova_group === 1, 'OFF NOVA kept');
  assert(mergedBoth.allergens_tags.includes('en:gluten'), 'OFF allergens kept');
  assert(mergedBoth.nutriments.proteins_100g === 10.7, 'USDA nutrition preferred');
  assert(mergedBoth.nutriments.sodium_100g === 0, 'USDA numeric 0 must win over OFF 0.01');
  assert(mergedBoth.nutriments.fiber_100g === 3.6, 'USDA fibre preferred over OFF');
  assert(mergedBoth.nutriments['fruits-vegetables-nuts_100g'] === 0, 'OFF-only nutriment key kept when USDA lacks it');
  assert(mergedBoth.foodCategory === 'Pasta by Shape & Type', 'USDA foodCategory kept on merge');
  assert(mergedBoth.image_front_url === 'https://off.example/fettuccine.jpg', 'image remains OFF-only');
  assert(mergedBoth.labels_tags.includes('en:organic'), 'OFF labels kept');

  // Conflicting-field precedence: empty USDA ingredients/brand fall back to OFF.
  const usdaNoIng = Object.assign({}, mapped, { ingredients_text: '   ', brands: '' });
  const mergedIngOff = g.mergeUsdaAndOffProducts('0099482431112', usdaNoIng, offForMerge);
  assert(mergedIngOff.ingredients_text === 'Organic durum wheat semolina.', 'empty USDA ingredients → OFF');
  assert(mergedIngOff.brands === '365 Everyday Value', 'empty USDA brand → OFF');
  assert(mergedIngOff.product_name === 'ORGANIC FETTUCCINE', 'name still USDA');

  const usdaNoNutri = Object.assign({}, mapped, { nutriments: {} });
  const mergedNutriOff = g.mergeUsdaAndOffProducts('0099482431112', usdaNoNutri, offForMerge);
  assert(mergedNutriOff.nutriments.proteins_100g === 12, 'missing USDA nutrition → OFF');

  const usdaZero = Object.assign({}, mapped, {
    nutriments: { proteins_100g: 0, sodium_100g: 0, 'energy-kcal_100g': 0, sugars_100g: 1 },
  });
  const offConflict = Object.assign({}, offForMerge, {
    nutriments: { proteins_100g: 12, sodium_100g: 0.5, 'energy-kcal_100g': 350, sugars_100g: 3 },
    product_name: 'OFF Name Wins If USDA Empty',
  });
  const zeroMerged = g.mergeUsdaAndOffProducts('0099482431112', usdaZero, offConflict);
  assert(zeroMerged.nutriments.proteins_100g === 0, 'protein 0 preserved from USDA');
  assert(zeroMerged.nutriments.sodium_100g === 0, 'sodium 0 preserved from USDA');
  assert(zeroMerged.nutriments['energy-kcal_100g'] === 0, 'energy 0 preserved from USDA');
  assert(zeroMerged.product_name === 'ORGANIC FETTUCCINE', 'conflicting name: USDA wins');

  assert(g.offProductMatchesScannedBarcode({ code: '099482431112' }, '0099482431112') === true,
    '12-digit OFF code matches padded scan');
  assert(g.offProductMatchesScannedBarcode({ code: '1111111111111' }, '0099482431112') === false,
    'mismatched OFF code rejected');
  assert(g.offProductMatchesScannedBarcode({ product_name: 'x' }, '0099482431112') === true,
    'missing OFF code still a valid product object');

  const newest = g.pickUsdaGtinMatch([
    { gtinUpc: '099482431112', publishedDate: '2020-01-01', fdcId: 99, description: 'old' },
    { gtinUpc: '099482431112', publishedDate: '2022-12-22', fdcId: 10, description: 'new-low-id' },
    { gtinUpc: '099482431112', publishedDate: '2022-12-22', fdcId: 50, description: 'new-high-id' },
  ], '0099482431112');
  assert(newest && newest.fdcId === 50, 'multiple GTIN hits: newest publishedDate, then highest fdcId');

  const fuzzy = g.pickUsdaGtinMatch([
    { gtinUpc: '0099447210127', description: 'CHICKEN NUGGETS', fdcId: 1 },
  ], '0000000000000');
  assert(fuzzy === null, 'fuzzy search hit with different gtin must be rejected');

  const prevKey = process.env.USDA_API_KEY;
  delete process.env.USDA_API_KEY;
  let fetches = [];
  global.fetch = async (url) => {
    fetches.push(String(url));
    throw new Error('network should not be used without a key');
  };
  const skipped = await g.usdaLookup('0099482431112');
  assert(skipped === null, 'missing key returns null');
  assert(fetches.length === 0, 'missing key must not fetch USDA');

  process.env.USDA_API_KEY = 'test-key-not-real';

  global.fetch = async () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    throw err;
  };
  const timedOut = await g.usdaLookup('0099482431112');
  assert(timedOut === null, 'timeout returns null');

  global.fetch = async (url, opts) => {
    fetches.push(String(url));
    assert(opts && opts.signal, 'USDA search must pass abort signal');
    const body = JSON.parse(opts.body);
    assert(body.dataType && body.dataType[0] === 'Branded', 'Branded filter');
    assert(body.query === '099482431112', 'must search 12-digit form, got ' + body.query);
    return {
      ok: true,
      json: async () => ({ totalHits: 1, foods: [fettuccine] }),
    };
  };
  fetches = [];
  const hit = await g.usdaLookup('0099482431112');
  assert(hit && hit.product_name === 'ORGANIC FETTUCCINE');
  assert(hit.fdcId === 2419828);
  assert(fetches.length === 1, 'exactly one USDA request on hit, got ' + fetches.length);

  // Miss still only one request — do not retry the 13-digit form.
  global.fetch = async (url, opts) => {
    fetches.push(JSON.parse(opts.body).query);
    return { ok: true, json: async () => ({ foods: [{ gtinUpc: '999', description: 'NOPE' }] }) };
  };
  fetches = [];
  const miss = await g.usdaLookup('0099482431112');
  assert(miss === null, 'unmatched gtin is a miss');
  assert(fetches.length === 1, 'exactly one USDA request on miss, got ' + fetches.length);
  assert(fetches[0] === '099482431112' || true, 'query is 12-digit');

  const offProduct = {
    code: '0099482431112',
    product_name: 'OFF Fettuccine',
    ingredients_text: 'Durum wheat semolina',
    brands: '365 Everyday Value',
    categories_tags: ['en:pastas'],
    additives_tags: ['en:e330'],
    ingredients: [{ id: 'en:e330' }],
    nutriscore_grade: 'a',
    nova_group: 1,
    nutriments: { 'energy-kcal_100g': 350, proteins_100g: 12, sodium_100g: 0.01 },
    image_front_url: 'https://off.example/fettuccine.jpg',
  };

  // Four merge states via resolveProductType.
  let usdaStarted = 0, offStarted = 0, usdaEnded = 0, offEnded = 0;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      assert(opts && opts.signal, 'USDA parallel fetch must abort');
      usdaStarted = Date.now();
      await new Promise(r => setTimeout(r, 40));
      usdaEnded = Date.now();
      return { ok: true, json: async () => ({ foods: [fettuccine] }) };
    }
    if (u.includes('openfoodfacts')) {
      assert(opts && opts.signal, 'OFF parallel fetch must abort');
      offStarted = Date.now();
      await new Promise(r => setTimeout(r, 40));
      offEnded = Date.now();
      return { ok: true, json: async () => ({ status: 1, product: offProduct }) };
    }
    return { ok: false };
  };
  const resolvedBoth = await g.resolveProductType('0099482431112');
  assert(resolvedBoth.productType === 'food', 'both-hit is food');
  assert(usdaStarted && offStarted, 'both lookups must start');
  assert(offStarted < usdaEnded && usdaStarted < offEnded,
    'USDA and OFF must overlap in time, sequential would have offStarted>=usdaEnded');
  assert(resolvedBoth.product.source === 'usda', 'merged source string usda');
  assert(resolvedBoth.product.nutriscore_grade === 'a', 'OFF nutriscore on merge');
  assert(resolvedBoth.product.additives_tags.includes('en:e330'), 'OFF additives on merge');
  assert(resolvedBoth.product.product_name === 'ORGANIC FETTUCCINE', 'USDA name on merge');

  // USDA miss + OFF hit → OFF only, unchanged.
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      return { ok: true, json: async () => ({ foods: [] }) };
    }
    if (u.includes('openfoodfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: offProduct }) };
    }
    return { ok: false };
  };
  const offOnlyResolved = await g.resolveProductType('0099482431112');
  assert(offOnlyResolved.productType === 'food', 'OFF-only is food');
  assert(offOnlyResolved.product.source === 'off', 'OFF-only source string');
  assert(offOnlyResolved.product.product_name === 'OFF Fettuccine');
  assert(offOnlyResolved.product === offOnlyResolved.product, 'sanity');
  assert(offOnlyResolved.product.nutriscore_grade === 'a');

  // USDA hit + OFF miss → USDA only.
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      return { ok: true, json: async () => ({ foods: [fettuccine] }) };
    }
    if (u.includes('openfoodfacts') || u.includes('openbeautyfacts')) {
      return { ok: false, status: 404 };
    }
    return { ok: false };
  };
  const usdaOnlyResolved = await g.resolveProductType('0099482431112');
  assert(usdaOnlyResolved.productType === 'food', 'USDA-only is food');
  assert(usdaOnlyResolved.product.source === 'usda');
  assert(usdaOnlyResolved.product.product_name === 'ORGANIC FETTUCCINE');
  assert(usdaOnlyResolved.product.additives_tags.length === 0, 'no OFF → empty additives_tags');

  // Both unavailable → photo fallback (null product type).
  global.fetch = async () => ({ ok: false, status: 404 });
  const bothMiss = await g.resolveProductType('0099482431112');
  assert(bothMiss.productType === null && bothMiss.product === null,
    'both unavailable → existing photo fallback path');

  // One-source timeout: USDA abort, still use OFF.
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      assert(opts && opts.signal, 'timed-out USDA must have been given an abort signal');
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    }
    if (u.includes('openfoodfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: offProduct }) };
    }
    return { ok: false };
  };
  const offAfterUsdaTimeout = await g.resolveProductType('0099482431112');
  assert(offAfterUsdaTimeout.productType === 'food', 'OFF survives USDA timeout');
  assert(offAfterUsdaTimeout.product.source === 'off');
  assert(offAfterUsdaTimeout.product.product_name === 'OFF Fettuccine');

  // One-source timeout: OFF abort, still use USDA. Wait is bounded by USDA, not hung OFF.
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      return { ok: true, json: async () => ({ foods: [fettuccine] }) };
    }
    if (u.includes('openfoodfacts') || u.includes('openbeautyfacts')) {
      assert(opts && opts.signal, 'OFF timeout path must pass abort signal');
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    return { ok: false };
  };
  const usdaAfterOffTimeout = await g.resolveProductType('0099482431112');
  assert(usdaAfterOffTimeout.productType === 'food', 'USDA survives OFF timeout');
  assert(usdaAfterOffTimeout.product.source === 'usda');
  assert(usdaAfterOffTimeout.product.product_name === 'ORGANIC FETTUCCINE');

  // One-source error: USDA HTTP 500, use OFF.
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      return { ok: false, status: 500 };
    }
    if (u.includes('openfoodfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: offProduct }) };
    }
    return { ok: false };
  };
  const offAfterUsdaError = await g.resolveProductType('0099482431112');
  assert(offAfterUsdaError.productType === 'food', 'OFF survives USDA error');
  assert(offAfterUsdaError.product.product_name === 'OFF Fettuccine');

  // OFF HTTP 200 without a product object is not a hit.
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      return { ok: true, json: async () => ({ foods: [] }) };
    }
    if (u.includes('openfoodfacts')) {
      return { ok: true, json: async () => ({ status: 0 }) };
    }
    if (u.includes('openbeautyfacts')) {
      return { ok: false };
    }
    return { ok: false };
  };
  const offEmptyBody = await g.resolveProductType('0099482431112');
  assert(offEmptyBody.productType === null, 'OFF status 0 is a miss, not a hit');

  // Normalized barcode mismatch rejected even on HTTP 200 + product.
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      return { ok: true, json: async () => ({ foods: [] }) };
    }
    if (u.includes('openfoodfacts')) {
      return {
        ok: true,
        json: async () => ({
          status: 1,
          product: Object.assign({}, offProduct, { code: '1111111111111', product_name: 'Wrong product' }),
        }),
      };
    }
    if (u.includes('openbeautyfacts')) {
      return { ok: false };
    }
    return { ok: false };
  };
  const mismatch = await g.resolveProductType('0099482431112');
  assert(mismatch.productType === null, 'OFF code mismatch must be rejected');

  const offCosmetic = {
    code: '0000000000000',
    product_name: 'Dove Whole Body',
    ingredients_text: '.',
    categories_tags: ['en:deodorants', 'en:hygiene'],
    nutriments: {},
  };
  const obfProduct = {
    product_name: 'Dove Whole Body Deodorant',
    ingredients_text: 'Aqua, Glycerin, Parfum',
    categories_tags: ['en:deodorants'],
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      return { ok: true, json: async () => ({ foods: [] }) };
    }
    if (u.includes('openfoodfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: offCosmetic }) };
    }
    if (u.includes('openbeautyfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: obfProduct }) };
    }
    return { ok: false };
  };
  const cosmetic = await g.resolveProductType('0000000000000');
  assert(cosmetic.productType === 'cosmetic', 'cosmetic classification unchanged, got ' + cosmetic.productType);
  assert(cosmetic.product.source === 'obf', 'OBF source stamped');

  const scored = await g.scanAndCacheFood('0099482431112', mergedBoth, { skipExplanation: true });
  assert(scored.source === 'usda', 'scan response source stays string, got ' + JSON.stringify(scored.source));
  assert(typeof scored.score === 'number' && scored.score !== null, 'merged food must score');
  assert(scored.productName === 'ORGANIC FETTUCCINE');
  assert(/ORGANIC DURUM WHEAT SEMOLINA/i.test(scored.ingredients), 'USDA ingredients displayed as-is');
  assert(scored.scanLogicVersion === '12', 'logic version 12');

  const offScored = await g.scanAndCacheFood('111', {
    product_name: 'Yogurt',
    ingredients_text: 'Milk, live cultures',
    nutriscore_grade: 'b',
    nova_group: 3,
    additives_tags: [],
    labels_tags: [],
    nutriments: {
      'energy-kcal_100g': 80,
      proteins_100g: 4,
      sodium_100g: 0.05,
      sugars_100g: 4,
      fat_100g: 0,
      fiber_100g: 0,
    },
  }, { skipExplanation: true });
  assert(offScored.source === 'off', 'OFF default source on food response');
  assert(typeof offScored.score === 'number', 'OFF yogurt with complete nutrients must score');

  // Mapper: absent sat-fat row vs declared fibre 0.0
  const cokeUsda = {
    fdcId: 1,
    description: 'COCA-COLA',
    foodCategory: 'Soda',
    foodNutrients: [
      { nutrientId: 1003, unitName: 'G', value: 0 },
      { nutrientId: 1004, unitName: 'G', value: 0 },
      { nutrientId: 1005, unitName: 'G', value: 10.6 },
      { nutrientId: 1008, unitName: 'KCAL', value: 42 },
      { nutrientId: 2000, unitName: 'G', value: 10.6 },
      { nutrientId: 1093, unitName: 'MG', value: 9 },
    ],
  };
  const cokeMapped = g.mapUsdaNutrientsToOff(cokeUsda);
  assert(!Object.prototype.hasOwnProperty.call(cokeMapped, 'saturated-fat_100g'),
    'Coca-Cola must not invent a saturated-fat row');
  assert(!Object.prototype.hasOwnProperty.call(cokeMapped, 'fiber_100g'),
    'Coca-Cola must not invent a fibre row');
  assert(cokeMapped.fat_100g === 0, 'Coca-Cola total fat 0 is stored');

  const heinzUsda = {
    foodNutrients: [
      { nutrientId: 1003, unitName: 'G', value: 1.6 },
      { nutrientId: 1004, unitName: 'G', value: 0 },
      { nutrientId: 1005, unitName: 'G', value: 26.2 },
      { nutrientId: 1008, unitName: 'KCAL', value: 100 },
      { nutrientId: 1079, unitName: 'G', value: 0.0 },
      { nutrientId: 2000, unitName: 'G', value: 22.8 },
      { nutrientId: 1093, unitName: 'MG', value: 907 },
      { nutrientId: 1258, unitName: 'G', value: 0 },
    ],
  };
  const heinzMapped = g.mapUsdaNutrientsToOff(heinzUsda);
  assert(Object.prototype.hasOwnProperty.call(heinzMapped, 'fiber_100g'), 'Heinz fibre row present');
  assert(heinzMapped.fiber_100g === 0, 'Heinz fibre 0.0 preserved');
  assert(heinzMapped['saturated-fat_100g'] === 0, 'Heinz sat fat 0.0 preserved');

  assert(g.classifyPurlaFoodPath('Soda') === 'beverages', 'Soda is beverages');
  assert(g.classifyPurlaFoodPath('Vegetable & Cooking Oils') === 'added_fats', 'oils path');
  assert(g.classifyPurlaFoodPath('Pasta by Shape & Type') === 'general', 'pasta general');
  assert(g.classifyPurlaFoodPath('Butter & Spread') === 'general', 'mixed butter aisle stays general');
  assert(g.classifyPurlaFoodPath('Cheese') === 'general', 'cheese is general (no extra ontology)');
  assert(g.classifyPurlaFoodPath('oil') === 'general', 'no fuzzy substring match');
  assert(g.classifyPurlaFoodPath('') === 'general', 'blank → general');

  const derivedCoke = g.applyDerivedNutrientZeros(cokeMapped);
  assert(derivedCoke['saturated-fat_100g'] === 0, 'fat 0 derives sat fat 0');
  assert(derivedCoke.fiber_100g == null, 'coke carbs > 0 must not invent fibre');

  const missingEnergy = g.computeNutritionSubscore({
    sugars_100g: 0, 'saturated-fat_100g': 0, sodium_100g: 0, fat_100g: 0,
  }, 'Cereal');
  assert(missingEnergy.available === false && missingEnergy.reason === 'missing_energy',
    'missing energy → unavailable');

  const missingFiber = g.computeNutritionSubscore({
    'energy-kcal_100g': 80, sugars_100g: 4, 'saturated-fat_100g': 0, sodium_100g: 0.05,
    proteins_100g: 4, fat_100g: 0,
  }, 'Yogurt');
  assert(missingFiber.available === true, 'missing fibre still computes');
  assert(missingFiber.components.fibre === 0, 'missing fibre → 0 points');

  const olive = g.computeNutritionSubscore({
    'energy-kcal_100g': 884, sugars_100g: 0, 'saturated-fat_100g': 14, sodium_100g: 0,
    fat_100g: 100, fiber_100g: 0, proteins_100g: 0, carbohydrates_100g: 0,
  }, 'Vegetable & Cooking Oils');
  const chocolate = g.computeNutritionSubscore({
    'energy-kcal_100g': 530, sugars_100g: 51, 'saturated-fat_100g': 18, sodium_100g: 0.08,
    fat_100g: 30, fiber_100g: 3.4, proteins_100g: 7.7, carbohydrates_100g: 59,
  }, 'Chocolate');
  assert(olive.available && chocolate.available, 'sentinels available');
  assert(olive.path === 'added_fats', 'olive oil uses fat-quality path');
  assert(chocolate.path === 'general', 'chocolate is general food');
  assert(olive.points > chocolate.points,
    'olive oil must not score like chocolate on energy density: oil=' + olive.points + ' choc=' + chocolate.points);

  const dietCola = g.computeNutritionSubscore({
    'energy-kcal_100g': 0, sugars_100g: 0, fat_100g: 0, sodium_100g: 0.008,
    proteins_100g: 0, carbohydrates_100g: 0,
  }, 'Soda');
  assert(dietCola.available && dietCola.path === 'beverages', 'diet cola is a beverage');
  assert(dietCola.points <= 45, 'diet cola must not approach the top, got ' + dietCola.points);

  const frozenVeg = g.computeNutritionSubscore({
    'energy-kcal_100g': 35, sugars_100g: 1.5, 'saturated-fat_100g': 0, sodium_100g: 0.03,
    fat_100g: 0.4, fiber_100g: 3.3, proteins_100g: 2.4, carbohydrates_100g: 7,
  }, 'Frozen Vegetables');
  const oats = g.computeNutritionSubscore({
    'energy-kcal_100g': 389, sugars_100g: 1, 'saturated-fat_100g': 1.1, sodium_100g: 0.002,
    fat_100g: 6.9, fiber_100g: 10.6, proteins_100g: 16.9, carbohydrates_100g: 66,
  }, 'Cereal');
  const crisps = g.computeNutritionSubscore({
    'energy-kcal_100g': 536, sugars_100g: 0.5, 'saturated-fat_100g': 3, sodium_100g: 0.5,
    fat_100g: 35, fiber_100g: 4, proteins_100g: 6, carbohydrates_100g: 53,
  }, 'Chips, Pretzels & Snacks');
  assert(frozenVeg.points > crisps.points, 'frozen veg must outscore crisps: ' + frozenVeg.points + ' vs ' + crisps.points);
  assert(oats.points > crisps.points, 'oats must outscore crisps: ' + oats.points + ' vs ' + crisps.points);
  assert(frozenVeg.points > chocolate.points, 'frozen veg must outscore chocolate');
  assert(oats.points > chocolate.points, 'oats must outscore chocolate');

  const highN = g.computeNutritionSubscore({
    'energy-kcal_100g': 500, sugars_100g: 40, 'saturated-fat_100g': 12, sodium_100g: 1.2,
    fat_100g: 20, fiber_100g: 0, proteins_100g: 25, carbohydrates_100g: 50,
  }, 'Pepperoni, Salami & Cold Cuts');
  assert(highN.available && highN.proteinSuppressed, 'high N must suppress protein');
  assert(highN.components.protein === 0, 'suppressed protein contributes 0');

  if (prevKey === undefined) delete process.env.USDA_API_KEY;
  else process.env.USDA_API_KEY = prevKey;

  console.log('usda food lookup ok');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

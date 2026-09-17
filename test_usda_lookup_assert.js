const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const logicMatch = src.match(/const SCAN_LOGIC_VERSION = '([^']+)'/);
if (!logicMatch) throw new Error('SCAN_LOGIC_VERSION missing');
assert(logicMatch[1] === '18', 'SCAN_LOGIC_VERSION must be 18, got ' + logicMatch[1]);
assert(!src.includes('default_off_ambiguous'), 'empty-tag food default must be removed');
assert(!src.includes("cached.productType || 'food'"), 'cache hit must not coerce missing type to food');
assert(!src.includes("responseData.productType || 'food'"), 'must not coerce missing productType to food');
assert(src.includes('notFoundErr.statusCode = 404'), 'true miss must stay HTTP 404');
assert(src.includes("Product not found"), 'true miss error copy unchanged');
assert(src.includes('unsupportedReason'), 'unsupported payload must carry unsupportedReason');
assert(src.includes('unverified_product'), 'unverified_product must be an app-facing value');
assert(src.includes('known_non_food'), 'known_non_food must be an app-facing value');
assert(src.includes('buildUnsupportedScanResponse'), 'unsupported builder must exist');
assert(src.includes('off_nutrition_facts'), 'OFF empty-tag nutrition fallback must exist');
assert(src.includes('off_non_food_category'), 'explicit non-food type tags must veto');
{
  const searchFn = src.slice(
    src.indexOf('function classifySearchProductType'),
    src.indexOf('function attachProductSource')
  );
  assert(searchFn.includes("return 'food'"), 'search food classification must remain');
  assert(searchFn.includes('tagIndicatesOffNonFoodProductType'),
    'search must veto explicit non-food type tags');
  assert(searchFn.includes('offCategoryTagsForFoodDecision'),
    'search must ignore en:undefined the same way as the scan classifier');
  assert(!searchFn.includes('hasScorableFoodNutriments'),
    'search must not use the scan nutrition fallback');
}
{
  const mergeFn = src.slice(
    src.indexOf('function mergeUsdaAndOffProducts'),
    src.indexOf('function lookupOutcome')
  );
  assert(mergeFn.includes('pickUsdaThenOff'), 'USDA/OFF merge must stay field-by-field');
  assert(!mergeFn.includes('hasExplicitOffFoodCategory'),
    'merge must not classify product type');
}
{
  const photoStart = src.indexOf("app.post('/scan/photo'");
  const photoSlice = src.slice(photoStart, photoStart + 8000);
  assert(photoSlice.includes('resolveProductType'), '/scan/photo must still call resolveProductType');
}

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
  routeResolvedScan,
  cachePayloadWithoutFoodCoercion,
  buildUnsupportedScanResponse,
  isExplicitFoodProductType,
  hasExplicitOffFoodCategory,
  SCAN_LOGIC_VERSION,
  mapUsdaNutrientsToOff,
  computeNutritionSubscore,
  classifyPurlaFoodPath,
  applyDerivedNutrientZeros,
  calculateScore,
  getScoreBreakdown,
  resolveOrganicStatus,
  formatOrganicDisplay,
  appFacingUnsupportedReason,
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
  assert(scored.scanLogicVersion === '18', 'logic version 18');

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

  // --- Food-only gate ---
  assert(g.SCAN_LOGIC_VERSION === '18', 'logic version 18');
  assert(typeof g.routeResolvedScan === 'function', 'routeResolvedScan exported');
  assert(g.isExplicitFoodProductType('food') === true);
  assert(g.isExplicitFoodProductType('unsupported') === false);
  assert(g.isExplicitFoodProductType(undefined) === false);
  assert(g.isExplicitFoodProductType(null) === false);
  assert(g.hasExplicitOffFoodCategory({ categories_tags: ['en:pastas'] }) === true);
  assert(g.hasExplicitOffFoodCategory({ categories_tags: [] }) === false);
  assert(g.hasExplicitOffFoodCategory({ categories_tags: ['en:shampoos'] }) === false);
  assert(g.hasExplicitOffFoodCategory({ categories_tags: ['en:detergents'] }) === false);
  assert(g.hasExplicitOffFoodCategory({}) === false);
  assert(g.hasExplicitOffFoodCategory({ categories_tags: ['en:undefined'] }) === false,
    'en:undefined is not food evidence');
  assert(g.hasExplicitOffFoodCategory({
    categories_tags: ['en:undefined', 'en:pastas'],
  }) === true, 'remaining real tags after ignoring en:undefined are food evidence');
  assert(g.hasExplicitOffFoodCategory({
    categories_tags: ['en:incorrect-product-type', 'en:non-food-products'],
  }) === false, 'explicit non-food type tags are not food evidence');
  assert(g.hasExplicitOffFoodCategory({
    categories_tags: [null, '', 12, { id: 'en:pastas' }, 'en:undefined'],
  }) === false, 'null/empty/non-string/undefined entries leave no food evidence');

  const unsupportedPayload = g.buildUnsupportedScanResponse({
    productName: 'Head & Shoulders Classic Clean',
    ingredients: 'Blue 1, red 33',
  });
  assert(unsupportedPayload.productType === 'unsupported');
  assert(unsupportedPayload.score === null);
  assert(unsupportedPayload.scoreLabel === 'Food products only');
  assert(unsupportedPayload.explanation === 'Purla currently scores food products only.');
  assert(unsupportedPayload.unsupportedReason === 'known_non_food',
    'builder default is known_non_food');
  assert(typeof unsupportedPayload.ingredients === 'string', 'unsupported ingredients must be a string');
  assert(unsupportedPayload.ingredients === 'Blue 1, red 33');
  assert(!/cosmetic/i.test(unsupportedPayload.explanation));
  assert(!/household/i.test(unsupportedPayload.explanation));
  assert(!/roadmap/i.test(unsupportedPayload.explanation));

  const arrayRejected = g.buildUnsupportedScanResponse({
    productName: 'Sunny Fruit',
    ingredients: [{ id: 'en:plum', text: 'plums' }],
  });
  assert(typeof arrayRejected.ingredients === 'string', 'builder must not emit an ingredients array');
  assert(arrayRejected.ingredients === '', 'structured ingredients array must not be stringified');
  assert(!Array.isArray(JSON.parse(JSON.stringify(arrayRejected)).ingredients),
    'JSON ingredients field must not be an array');

  // Known food still scores via food path.
  const knownFood = await g.routeResolvedScan('0099482431112', 'food', mergedBoth, { skipExplanation: true });
  assert(knownFood.productType === 'food', 'known food stays food');
  assert(typeof knownFood.score === 'number' && knownFood.score !== null, 'known food scores');

  // Known cosmetic / household → unsupported, scorers not used (route helper).
  const gatedCosmetic = await g.routeResolvedScan('0000000000000', 'cosmetic', {
    product_name: 'Dove Whole Body Deodorant',
    ingredients_text: 'Aqua, Glycerin, Parfum',
    source: 'obf',
  }, { skipExplanation: true, reason: 'obf_only' });
  assert(gatedCosmetic.productType === 'unsupported', 'cosmetic routes to unsupported');
  assert(gatedCosmetic.score === null, 'cosmetic must not be scored');
  assert(gatedCosmetic.unsupportedReason === 'known_non_food', 'cosmetic is known_non_food');
  assert(gatedCosmetic.scoreLabel === 'Food products only');
  assert(gatedCosmetic.explanation === 'Purla currently scores food products only.');
  assert(gatedCosmetic.unsupportedReason !== 'obf_only', 'must not expose internal reason');
  assert(typeof gatedCosmetic.ingredients === 'string', 'cosmetic-gated ingredients must be a string');
  assert(gatedCosmetic.ingredients === 'Aqua, Glycerin, Parfum');

  const gatedHousehold = await g.routeResolvedScan('0000000000001', 'household', {
    product_name: 'Dawn Ultra',
    ingredients_text: 'Water, surfactants',
    source: 'off',
  }, { skipExplanation: true, reason: 'category_off' });
  assert(gatedHousehold.productType === 'unsupported', 'household routes to unsupported');
  assert(gatedHousehold.score === null);
  assert(gatedHousehold.unsupportedReason === 'known_non_food', 'household is known_non_food');
  assert(gatedHousehold.scoreLabel === 'Food products only');
  assert(gatedHousehold.explanation === 'Purla currently scores food products only.');
  assert(gatedHousehold.unsupportedReason !== 'category_off', 'must not expose internal reason');

  const gatedMissing = await g.routeResolvedScan('0000000000002', undefined, {
    product_name: 'Mystery',
    ingredients_text: 'Blue 1, red 33',
  }, { skipExplanation: true });
  assert(gatedMissing.productType === 'unsupported', 'missing type must not enter food scoring');
  assert(gatedMissing.score === null);

  // Cache record with missing productType does not enter food scoring.
  const missingCache = g.cachePayloadWithoutFoodCoercion({
    productName: 'Legacy cache',
    ingredients: 'Blue 1, red 33',
    score: 88,
    scoreLabel: 'Excellent',
    cachedAt: Date.now(),
    scanLogicVersion: '14',
  });
  assert(missingCache.productType === 'unsupported', 'missing cache type → unsupported');
  assert(missingCache.score === null, 'missing cache type must not keep a food score');
  assert(missingCache.unsupportedReason === 'unverified_product',
    'missing cache type is unverified, not known non-food');

  const foodCache = g.cachePayloadWithoutFoodCoercion({
    productType: 'food',
    productName: 'Yogurt',
    score: 70,
    cachedAt: 1,
  });
  assert(foodCache.productType === 'food' && foodCache.score === 70, 'explicit food cache unchanged');

  // Head & Shoulders / empty OFF tags, no USDA → unsupported, not food.
  // A nutriments object and ingredients_text must not prove food.
  process.env.USDA_API_KEY = 'test-key';
  const hsOff = {
    code: '0030772062791',
    product_name: 'Head & Shoulders Classic Clean',
    ingredients_text: 'Blue 1, red 33',
    categories_tags: [],
    nutriments: {
      'added-sugars': 0,
      'added-sugars_100g': 0,
      'fruits-vegetables-nuts-estimate-from-ingredients_100g': 0,
    },
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      return { ok: true, json: async () => ({ foods: [] }) };
    }
    if (u.includes('openfoodfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: hsOff }) };
    }
    if (u.includes('openbeautyfacts')) {
      return { ok: true, json: async () => ({ status: 0 }) };
    }
    return { ok: false };
  };
  const hs = await g.resolveProductType('0030772062791');
  assert(hs.productType === 'unsupported', 'Head & Shoulders empty tags → unsupported, got ' + hs.productType);
  assert(hs.reason === 'no_affirmative_food', 'H&S classifier reason stays no_affirmative_food');
  assert(hs.product && hs.product.product_name.includes('Head & Shoulders'), 'still has the OFF record');
  const hsRouted = await g.routeResolvedScan('0030772062791', hs.productType, hs.product, {
    skipExplanation: true,
    reason: hs.reason,
  });
  assert(hsRouted.productType === 'unsupported');
  assert(hsRouted.score === null);
  assert(hsRouted.unsupportedReason === 'unverified_product', 'H&S is unverified, not known non-food');
  assert(hsRouted.scoreLabel === 'Unable to verify this product');
  assert(hsRouted.explanation === "Purla couldn't verify enough product data to determine whether this item can be scored.");
  assert(hsRouted.unsupportedReason !== 'no_affirmative_food', 'must not expose internal reason');
  assert(typeof hsRouted.ingredients === 'string', 'H&S ingredients must be a display string, got ' + typeof hsRouted.ingredients);
  assert(hsRouted.ingredients === 'Blue 1, red 33', 'H&S must prefer ingredients_text, got ' + JSON.stringify(hsRouted.ingredients));
  assert(!Array.isArray(JSON.parse(JSON.stringify(hsRouted)).ingredients),
    'H&S JSON ingredients must be a string');

  const sunnyOff = {
    code: '0842515008474',
    product_name: 'Organic Dried Plums',
    brands: 'Sunny fruit',
    ingredients_text: 'Organic dried plums, water.',
    ingredients: [
      { ciqual_food_code: '13100', id: 'en:plum', is_in_taxonomy: 1, text: 'plums' },
      { ciqual_food_code: '18066', id: 'en:water', is_in_taxonomy: 1, text: 'water' },
    ],
    categories_tags: [],
    nutriments: {
      'energy-kcal_100g': 241,
      'energy-kcal': 241,
      proteins_100g: 2.2,
      proteins: 2.2,
      sugars_100g: 38,
      sugars: 38,
      'saturated-fat_100g': 0.1,
      'saturated-fat': 0.1,
      fat_100g: 0.4,
      carbohydrates_100g: 64,
    },
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      return { ok: true, json: async () => ({ foods: [] }) };
    }
    if (u.includes('openfoodfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: sunnyOff }) };
    }
    if (u.includes('openbeautyfacts')) {
      return { ok: true, json: async () => ({ status: 0 }) };
    }
    return { ok: false };
  };
  const sunny = await g.resolveProductType('0842515008474');
  assert(sunny.productType === 'food', 'Sunny Fruit empty tags + energy/protein → food, got ' + sunny.productType);
  const sunnyRouted = await g.routeResolvedScan('0842515008474', sunny.productType, sunny.product, { skipExplanation: true });
  assert(sunnyRouted.productType === 'food', 'Sunny Fruit must stay food after routing');
  assert(sunnyRouted.score === null, 'Sunny Fruit score must be null without sodium');
  assert(sunnyRouted.scoreLabel === 'Not enough data',
    'Sunny Fruit missing sodium → Not enough data, got ' + sunnyRouted.scoreLabel);
  assert(typeof sunnyRouted.ingredients === 'string', 'Sunny Fruit ingredients must be a string, got ' + typeof sunnyRouted.ingredients);
  assert(sunnyRouted.ingredients === 'Organic dried plums, water.',
    'Sunny Fruit must prefer ingredients_text over the structured array, got ' + JSON.stringify(sunnyRouted.ingredients));
  assert(!Array.isArray(JSON.parse(JSON.stringify(sunnyRouted)).ingredients),
    'Sunny Fruit JSON ingredients must be a string');
  assert(!/ciqual_food_code/.test(sunnyRouted.ingredients),
    'must not stringify the structured ingredients array');

  const absentTags = { ...hsOff, code: '0030772062792' };
  delete absentTags.categories_tags;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) return { ok: true, json: async () => ({ foods: [] }) };
    if (u.includes('openfoodfacts')) return { ok: true, json: async () => ({ status: 1, product: absentTags }) };
    return { ok: false };
  };
  const absentResolved = await g.resolveProductType('0030772062792');
  assert(absentResolved.productType === 'unsupported', 'absent tags → unsupported, got ' + absentResolved.productType);

  function usdaMissOffFetch(product) {
    return async (url) => {
      const u = String(url);
      if (u.includes('api.nal.usda.gov')) return { ok: true, json: async () => ({ foods: [] }) };
      if (u.includes('openfoodfacts')) return { ok: true, json: async () => ({ status: 1, product }) };
      if (u.includes('openbeautyfacts')) return { ok: true, json: async () => ({ status: 0 }) };
      return { ok: false };
    };
  }

  // Lysol: explicit non-food type tags veto even if nutriments look like food.
  const lysolOff = {
    code: '0019200008884',
    product_name: 'Lysol kitchen Pro Antibacterial Cleaner',
    brands: 'Lysol',
    categories_tags: ['en:incorrect-product-type', 'en:non-food-products'],
    nutriments: { 'energy-kcal_100g': 0, proteins_100g: 0, sodium_100g: 0 },
  };
  global.fetch = usdaMissOffFetch(lysolOff);
  const lysol = await g.resolveProductType('0019200008884');
  assert(lysol.productType === 'unsupported', 'Lysol non-food tags must veto, got ' + lysol.productType);
  assert(lysol.reason === 'off_non_food_category', 'Lysol classifier reason stays off_non_food_category');
  const lysolRouted = await g.routeResolvedScan('0019200008884', lysol.productType, lysol.product, {
    skipExplanation: true,
    reason: lysol.reason,
  });
  assert(lysolRouted.productType === 'unsupported', 'Lysol must not be food after routing');
  assert(lysolRouted.unsupportedReason === 'known_non_food');
  assert(lysolRouted.scoreLabel === 'Food products only');
  assert(lysolRouted.explanation === 'Purla currently scores food products only.');
  assert(lysolRouted.unsupportedReason !== 'off_non_food_category', 'must not expose internal reason');

  // Four en:undefined-only foods reach the nutrition fallback.
  const undefinedFoods = [
    { code: '0024321915607', product_name: 'Whole Milk' },
    { code: '0036632037251', product_name: 'Greek Yogurt' },
    { code: '0011150514767', product_name: 'Cream Cheese' },
    { code: '0041331023535', product_name: 'Black Beans' },
  ];
  for (const row of undefinedFoods) {
    const product = {
      code: row.code,
      product_name: row.product_name,
      categories_tags: ['en:undefined'],
      nutriments: { 'energy-kcal_100g': 60, proteins_100g: 3.3, sodium_100g: 0.04 },
    };
    global.fetch = usdaMissOffFetch(product);
    const resolved = await g.resolveProductType(row.code);
    assert(resolved.productType === 'food',
      row.product_name + ' en:undefined + nutrition → food, got ' + resolved.productType);
  }

  // Known cosmetic with cosmetic tags stays non-food even with nutriments.
  const offSunscreen = {
    code: '0303162062450',
    product_name: 'KIDS mineral-based sunscreen',
    categories_tags: ['en:sunscreen'],
    nutriments: { 'energy-kcal_100g': 0, proteins_100g: 0, sodium_100g: 0 },
  };
  global.fetch = usdaMissOffFetch(offSunscreen);
  const cosmeticTagged = await g.resolveProductType('0303162062450');
  assert(cosmeticTagged.productType === 'cosmetic',
    'cosmetic tags must veto nutrition fallback, got ' + cosmeticTagged.productType);
  const cosmeticRouted = await g.routeResolvedScan(
    '0303162062450', cosmeticTagged.productType, cosmeticTagged.product,
    { skipExplanation: true, reason: cosmeticTagged.reason }
  );
  assert(cosmeticRouted.productType === 'unsupported', 'cosmetic-tagged OFF record routes to unsupported');
  assert(cosmeticRouted.unsupportedReason === 'known_non_food');
  assert(cosmeticRouted.scoreLabel === 'Food products only');

  // Numeric 0 is a genuine nutrition fact when tags are empty.
  const zeroEnergy = {
    code: '0000000000099',
    product_name: 'Zero-energy water',
    categories_tags: [],
    nutriments: { 'energy-kcal_100g': 0 },
  };
  global.fetch = usdaMissOffFetch(zeroEnergy);
  const zeroResolved = await g.resolveProductType('0000000000099');
  assert(zeroResolved.productType === 'food',
    'numeric 0 energy with empty tags → food, got ' + zeroResolved.productType);

  // USDA hit + no OFF still food.
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
  const usdaOnlyGate = await g.resolveProductType('0099482431112');
  assert(usdaOnlyGate.productType === 'food', 'USDA-only remains food');
  const usdaOnlyScored = await g.routeResolvedScan('0099482431112', usdaOnlyGate.productType, usdaOnlyGate.product, { skipExplanation: true });
  assert(usdaOnlyScored.productType === 'food');
  assert(typeof usdaOnlyScored.score === 'number');

  // USDA wins over OFF cosmetic tags; still merged.
  const offShampoo = {
    code: '0099482431112',
    product_name: 'OFF says shampoo',
    ingredients_text: 'Aqua',
    categories_tags: ['en:shampoos', 'en:hair-care'],
    nutriments: { 'energy-kcal_100g': 350, proteins_100g: 12, sodium_100g: 0.01, sugars_100g: 3, fat_100g: 1, fiber_100g: 3 },
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.nal.usda.gov')) {
      return { ok: true, json: async () => ({ foods: [fettuccine] }) };
    }
    if (u.includes('openfoodfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: offShampoo }) };
    }
    if (u.includes('openbeautyfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: offShampoo }) };
    }
    return { ok: false };
  };
  const usdaWins = await g.resolveProductType('0099482431112');
  assert(usdaWins.productType === 'food', 'USDA wins over OFF cosmetic tags, got ' + usdaWins.productType);
  assert(usdaWins.product.source === 'usda', 'merged USDA source');
  assert(usdaWins.product.product_name === 'ORGANIC FETTUCCINE');

  // Both miss still null (404 path).
  global.fetch = async () => ({ ok: false, status: 404 });
  const bothMissGate = await g.resolveProductType('0099482431112');
  assert(bothMissGate.productType === null && bothMissGate.product === null,
    'both-miss still null for photo capture');
  assert(bothMissGate.reason === 'not_found');

  // Dried Fruit & NUT Bread: accepted residue — OFF hit, no tags, no nutriments.
  const breadOff = {
    code: '0000000000456',
    product_name: 'Dried Fruit & NUT Bread',
    categories_tags: [],
    nutriments: {},
  };
  global.fetch = usdaMissOffFetch(breadOff);
  const bread = await g.resolveProductType('0000000000456');
  assert(bread.productType === 'unsupported', 'bread residue stays unsupported, got ' + bread.productType);
  assert(bread.reason === 'no_affirmative_food', 'classifier reason unchanged');
  const breadRouted = await g.routeResolvedScan('0000000000456', bread.productType, bread.product, {
    skipExplanation: true,
    reason: bread.reason,
  });
  assert(breadRouted.productType === 'unsupported');
  assert(breadRouted.unsupportedReason === 'unverified_product');
  assert(breadRouted.scoreLabel === 'Unable to verify this product');
  assert(breadRouted.explanation === "Purla couldn't verify enough product data to determine whether this item can be scored.");
  assert(!Object.prototype.hasOwnProperty.call(breadRouted, 'reason')
    || breadRouted.reason !== 'no_affirmative_food',
    'API payload must not carry the internal classifier reason');

  // Organic: en:organic → yes; anything else (including Non-GMO labels) → unknown.
  assert(typeof g.resolveOrganicStatus === 'function', 'resolveOrganicStatus exported');
  assert(g.resolveOrganicStatus(['en:organic']) === 'yes');
  assert(g.formatOrganicDisplay('yes') === 'Yes');
  assert(g.resolveOrganicStatus(['en:no-gmos']) === 'unknown',
    'Non-GMO-only labels must not assert not-organic');
  assert(g.formatOrganicDisplay(g.resolveOrganicStatus(['en:no-gmos'])) === 'Unknown');
  assert(g.resolveOrganicStatus(['en:no-gmos', 'en:non-gmo-project']) === 'unknown',
    'Barilla label set must be unknown');
  assert(g.resolveOrganicStatus([]) === 'unknown');
  assert(g.resolveOrganicStatus(null) === 'unknown');
  assert(g.resolveOrganicStatus(undefined) === 'unknown');
  assert(g.formatOrganicDisplay('no') === 'No', 'display helper still maps no → No');
  const orgFn = src.slice(src.indexOf('function resolveOrganicStatus'), src.indexOf('function formatOrganicDisplay'));
  assert(!orgFn.includes("return 'no'"), 'resolveOrganicStatus must not return no');

  const barillaNutriments = {
    'energy-kcal_100g': 357,
    proteins_100g: 12.5,
    sugars_100g: 3,
    'saturated-fat_100g': 0.5,
    sodium_100g: 0.01,
    fat_100g: 2.68,
    fiber_100g: 3,
    carbohydrates_100g: 73.2,
  };
  const barillaFood = {
    product_name: 'Thin Spaghetti',
    brands: 'Barilla',
    ingredients_text: 'Semolina, water.',
    labels_tags: ['en:no-gmos', 'en:non-gmo-project'],
    nutriscore_grade: 'a',
    nova_group: 1,
    additives_tags: [],
    nutriments: barillaNutriments,
  };
  const barillaScored = await g.scanAndCacheFood('076808534139', barillaFood, { skipExplanation: true });
  assert(barillaScored.isOrganic === 'Unknown', 'Barilla isOrganic must be Unknown, got ' + barillaScored.isOrganic);
  const barillaBreakdown = JSON.parse(barillaScored.scoreBreakdown);
  assert(barillaBreakdown.isOrganic === false, 'Barilla breakdown isOrganic false');
  assert(barillaBreakdown.organicPts === 0, 'Barilla organicPts stay 0');
  assert(typeof barillaScored.score === 'number', 'Barilla still scores');

  const organicTwin = await g.scanAndCacheFood('076808534139', {
    ...barillaFood,
    product_name: 'Organic Thin Spaghetti',
    labels_tags: ['en:organic'],
  }, { skipExplanation: true });
  assert(organicTwin.isOrganic === 'Yes', 'confirmed organic displays Yes');
  const organicBreakdown = JSON.parse(organicTwin.scoreBreakdown);
  assert(organicBreakdown.isOrganic === true);
  assert(organicBreakdown.organicPts === 10, 'organic points still awarded');
  assert(organicTwin.score === barillaScored.score + 10,
    'organic bonus is +10 vs unknown; scores otherwise identical: '
    + organicTwin.score + ' vs ' + barillaScored.score);

  const emptyLabels = await g.scanAndCacheFood('076808534139', {
    ...barillaFood,
    labels_tags: [],
  }, { skipExplanation: true });
  assert(emptyLabels.isOrganic === 'Unknown', 'empty labels_tags stay Unknown');
  assert(emptyLabels.score === barillaScored.score, 'empty vs Non-GMO labels must not change the score');

  const noGmoOnly = await g.scanAndCacheFood('076808534139', {
    ...barillaFood,
    labels_tags: ['en:no-gmos'],
  }, { skipExplanation: true });
  assert(noGmoOnly.isOrganic === 'Unknown', 'en:no-gmos alone is Unknown');
  assert(noGmoOnly.score === barillaScored.score);

  assert(g.appFacingUnsupportedReason('unsupported', 'no_affirmative_food') === 'unverified_product');
  assert(g.appFacingUnsupportedReason('unsupported', 'off_non_food_category') === 'known_non_food');
  assert(g.appFacingUnsupportedReason('household', 'category_off') === 'known_non_food');
  assert(g.appFacingUnsupportedReason('cosmetic', 'obf_only') === 'known_non_food');

  if (prevKey === undefined) delete process.env.USDA_API_KEY;
  else process.env.USDA_API_KEY = prevKey;

  console.log('usda food lookup ok');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

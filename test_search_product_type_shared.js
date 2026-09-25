'use strict';

// Proves the extracted classifier is what /search uses, and that its
// outputs match the pre-extract behaviour (frozen golden vectors).

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  classifySearchProductType,
} = require('./lib/search_product_type');

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

assert.match(src, /require\('\.\/lib\/search_product_type'\)/,
  'index.js must import lib/search_product_type');
assert.match(src, /classifySearchProductType/,
  'index.js must still bind classifySearchProductType');

const searchStart = src.indexOf("app.get('/search'");
const searchEnd = src.indexOf('const PRESCORE_SECRET');
assert.ok(searchStart >= 0 && searchEnd > searchStart, 'locate /search');
const searchBody = src.slice(searchStart, searchEnd);
assert.ok(searchBody.includes("classifySearchProductType(p.categories_tags) === 'food'"),
  '/search must still keep only affirmative food rows via classifySearchProductType');
assert.ok(searchBody.includes('countries_tags:"en:united-states"'),
  '/search US filter unchanged');
assert.ok(searchBody.includes('categories_tags:*'),
  '/search category exists-filter unchanged');
assert.ok(!searchBody.includes('image-mirror'),
  '/search must not mention the image-mirror job');
assert.match(src, /const SCAN_LOGIC_VERSION = '24'/,
  'SCAN_LOGIC_VERSION must stay 24');

// Golden vectors: the same decisions /search made before the extract.
const golden = [
  { tags: ['en:toothpastes', 'en:oral-care'], expect: 'cosmetic' },
  { tags: ['en:shampoos'], expect: 'cosmetic' },
  { tags: ['en:dishwashing', 'en:cleaning-products'], expect: 'household' },
  { tags: ['en:detergents'], expect: 'household' },
  { tags: ['en:breads', 'en:plant-based-foods'], expect: 'food' },
  { tags: ['en:undefined'], expect: null },
  { tags: [], expect: null },
  { tags: undefined, expect: null },
  { tags: null, expect: null },
  { tags: ['en:undefined', 'en:yogurts'], expect: 'food' },
  { tags: ['en:yogurts', 'en:non-food-products'], expect: 'unsupported' },
  { tags: ['en:incorrect-product-type', 'en:non-food-products'], expect: 'unsupported' },
  { tags: ['en:soaps', 'en:dishwashing'], expect: 'household' },
  { tags: ['en:soapberry'], expect: 'food' },
];

for (const row of golden) {
  const got = classifySearchProductType(row.tags);
  assert.strictEqual(got, row.expect,
    `classifySearchProductType(${JSON.stringify(row.tags)}) === ${row.expect}, got ${got}`);
}

console.log('test_search_product_type_shared.js: ok');

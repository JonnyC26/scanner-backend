'use strict';

// Shared OFF search-universe classification. Used by /search and by the
// image-mirror job. Behaviour must stay identical to the functions that
// previously lived inline in index.js.

// Explicit beauty/hygiene category fragments. Matched as whole hyphen-delimited
// segments of categories_tags — not fuzzy substrings (so "soap" ≠ "soapberry").
const COSMETIC_CATEGORY_FRAGMENTS = [
  'cosmetics', 'cosmetic', 'beauty', 'hygiene',
  'toothpaste', 'toothpastes',
  'soap', 'soaps',
  'shampoo', 'shampoos',
  'deodorant', 'deodorants',
  'skin-care', 'skincare',
  'hair-care', 'haircare',
  'lip-balm', 'lip-balms', 'lipbalm',
  'sunscreen', 'sunscreens',
  'make-up', 'makeup',
  'mouthwash', 'mouthwashes',
  'dental-care', 'oral-care',
  'body-care', 'facial-care', 'face-care',
  'personal-care',
  'conditioner', 'conditioners',
  'shower-gel', 'shower-gels',
  'bath-and-shower',
  'aftershaves', 'aftershave',
  'perfume', 'perfumes', 'fragrance', 'fragrances',
  'nail-polish', 'nail-care',
  'shaving', 'shaving-cream', 'shaving-foam',
  'hand-cream', 'body-lotion', 'face-cream',
  'exfoliant', 'exfoliants', 'toner', 'toners', 'serum', 'serums',
];

function tagIndicatesCosmetic(tag) {
  const t = String(tag || '').replace(/^[a-z]{2}:/, '').toLowerCase();
  if (!t) return false;
  return COSMETIC_CATEGORY_FRAGMENTS.some(frag => {
    if (t === frag) return true;
    if (t.startsWith(frag + '-')) return true;
    if (t.endsWith('-' + frag)) return true;
    if (t.includes('-' + frag + '-')) return true;
    return false;
  });
}

function hasCosmeticCategory(product) {
  const tags = (product && product.categories_tags) || [];
  return tags.some(tagIndicatesCosmetic);
}

// Explicit household/cleaning category fragments. Matched as whole hyphen-delimited
// segments — compound only (no bare "soap") so cosmetic soaps stay cosmetic.
const HOUSEHOLD_CATEGORY_FRAGMENTS = [
  'cleaning-products', 'cleaning',
  'detergents', 'detergent',
  'dishwashing', 'dish-soap',
  'laundry', 'laundry-detergent',
  'household', 'household-cleaners',
  'surface-cleaners',
  'bleach',
  'disinfectants',
  'air-fresheners',
];

function tagIndicatesHousehold(tag) {
  const t = String(tag || '').replace(/^[a-z]{2}:/, '').toLowerCase();
  if (!t) return false;
  return HOUSEHOLD_CATEGORY_FRAGMENTS.some(frag => {
    if (t === frag) return true;
    if (t.startsWith(frag + '-')) return true;
    if (t.endsWith('-' + frag)) return true;
    if (t.includes('-' + frag + '-')) return true;
    return false;
  });
}

function hasHouseholdCategory(product) {
  const tags = (product && product.categories_tags) || [];
  return tags.some(tagIndicatesHousehold);
}

// OFF product-type tags that are explicit non-food, not missing taxonomy.
function tagIndicatesOffNonFoodProductType(tag) {
  const t = String(tag || '').replace(/^[a-z]{2}:/, '').toLowerCase();
  return t === 'non-food-products' || t === 'incorrect-product-type';
}

function hasOffNonFoodProductTypeCategory(product) {
  const tags = (product && product.categories_tags) || [];
  return tags.some(tagIndicatesOffNonFoodProductType);
}

// For the OFF food-category decision only: drop en:undefined (confirmed
// non-evidence) and null / empty / non-string entries. Do not expand this list.
function offCategoryTagsForFoodDecision(product) {
  const tags = product && product.categories_tags;
  if (!Array.isArray(tags)) return [];
  const remaining = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const bare = trimmed.replace(/^[a-z]{2}:/, '').toLowerCase();
    if (bare === 'undefined') continue;
    remaining.push(trimmed);
  }
  return remaining;
}

// Affirmative OFF food evidence after non-food vetoes: at least one remaining
// category tag that is not household, cosmetic, or an explicit non-food type.
// Absent, empty, or en:undefined-only tags are not food evidence.
function hasExplicitOffFoodCategory(product) {
  const tags = offCategoryTagsForFoodDecision(product);
  if (tags.length === 0) return false;
  if (tags.some(tagIndicatesHousehold)) return false;
  if (tags.some(tagIndicatesCosmetic)) return false;
  if (tags.some(tagIndicatesOffNonFoodProductType)) return false;
  return true;
}

// Search candidates: classify from OFF category tags only (no upstream fetch,
// no nutrition fallback). Household wins over cosmetic, matching
// resolveProductType. Explicit non-food type tags are not food. en:undefined
// is ignored as category evidence; if nothing meaningful remains, omit.
function classifySearchProductType(categoriesTags) {
  const raw = Array.isArray(categoriesTags) ? categoriesTags : [];
  if (raw.some(tagIndicatesHousehold)) return 'household';
  if (raw.some(tagIndicatesCosmetic)) return 'cosmetic';
  if (raw.some(tagIndicatesOffNonFoodProductType)) return 'unsupported';
  const tags = offCategoryTagsForFoodDecision({ categories_tags: raw });
  if (tags.length === 0) return null;
  return 'food';
}

module.exports = {
  COSMETIC_CATEGORY_FRAGMENTS,
  HOUSEHOLD_CATEGORY_FRAGMENTS,
  tagIndicatesCosmetic,
  hasCosmeticCategory,
  tagIndicatesHousehold,
  hasHouseholdCategory,
  tagIndicatesOffNonFoodProductType,
  hasOffNonFoodProductTypeCategory,
  offCategoryTagsForFoodDecision,
  hasExplicitOffFoodCategory,
  classifySearchProductType,
};

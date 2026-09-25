'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  pickFront,
  extractFronts,
  isSearchUniverse,
  sourcePlan,
  hasUsableCrop,
  hasLegacyGeometryOnly,
  hasNormalizeOrWhiteMagic,
  coordinateSpace,
  barcodePath,
  normalizeImgid,
  offSourceUrl,
} = require('../src/select');

function front(lc, extra = {}) {
  return { lc, imgid: extra.imgid || '1', rev: extra.rev || '1', generation: extra.generation || {} };
}

describe('language rule', () => {
  it('prefers front_en over product.lang', () => {
    const chosen = pickFront([front('fr'), front('en'), front('de')], 'fr');
    assert.equal(chosen.lc, 'en');
  });

  it('falls back to product.lang when en is absent', () => {
    const chosen = pickFront([front('fr'), front('de')], 'fr');
    assert.equal(chosen.lc, 'fr');
  });

  it('otherwise picks the remaining front with the sorted language code', () => {
    const chosen = pickFront([front('zh'), front('de'), front('it')], 'sv');
    assert.equal(chosen.lc, 'de');
  });

  it('reads new images.selected.front.{lc} schema', () => {
    const fronts = extractFronts({
      selected: {
        front: {
          en: { imgid: '3', rev: 8, generation: { x1: 1, y1: 2, x2: 3, y2: 4 } },
        },
      },
    });
    assert.equal(fronts.length, 1);
    assert.equal(fronts[0].lc, 'en');
    assert.equal(fronts[0].imgid, '3');
    assert.equal(fronts[0].rev, '8');
    assert.equal(fronts[0].schema, 'new');
  });

  it('reads old images.front_{lc} schema', () => {
    const fronts = extractFronts({
      front_en: { imgid: '2.0', rev: '4', x1: 10, y1: 20, x2: 30, y2: 40 },
      ingredients_en: { imgid: '9' },
    });
    assert.equal(fronts.length, 1);
    assert.equal(fronts[0].lc, 'en');
    assert.equal(fronts[0].imgid, '2');
    assert.equal(fronts[0].generation.x1, 10);
  });
});

describe('search universe filter', () => {
  const food = {
    countries_tags: ['en:united-states'],
    categories_tags: ['en:breakfast-cereals', 'en:plant-based-foods'],
  };
  it('keeps US food with categories', () => {
    assert.equal(isSearchUniverse(food), true);
  });
  it('rejects non-US', () => {
    assert.equal(isSearchUniverse({ ...food, countries_tags: ['en:france'] }), false);
  });
  it('rejects empty categories', () => {
    assert.equal(isSearchUniverse({ ...food, categories_tags: [] }), false);
  });
  it('rejects cosmetics via classifySearchProductType', () => {
    assert.equal(isSearchUniverse({ ...food, categories_tags: ['en:toothpastes'] }), false);
  });
});

describe('skip rules (selection)', () => {
  it('skips normalize', () => {
    assert.equal(hasNormalizeOrWhiteMagic({ normalize: true }), true);
    assert.equal(sourcePlan({ generation: { normalize: '1' } }).skip, 'normalize_or_white_magic');
  });
  it('skips white_magic', () => {
    assert.equal(hasNormalizeOrWhiteMagic({ white_magic: 'true' }), true);
    assert.equal(sourcePlan({ generation: { white_magic: 1 } }).skip, 'normalize_or_white_magic');
  });
  it('does not skip normalize=false', () => {
    assert.equal(hasNormalizeOrWhiteMagic({ normalize: false, white_magic: '0' }), false);
  });
  it('skips legacy geometry without x1,y1,x2,y2', () => {
    const gen = { geometry: '120x80-10-12' };
    assert.equal(hasUsableCrop(gen), false);
    assert.equal(hasLegacyGeometryOnly(gen), true);
    assert.equal(sourcePlan({ generation: gen }).skip, 'legacy_geometry_only');
  });
  it('does not treat 0x0-0-0 as a crop', () => {
    const gen = { geometry: '0x0-0-0' };
    assert.equal(hasLegacyGeometryOnly(gen), false);
    assert.equal(sourcePlan({ generation: gen }).skip, null);
    assert.equal(sourcePlan({ generation: gen }).sourceKind, 'uncropped');
  });
  it('skips crop when coordinate space cannot be mapped', () => {
    const gen = { x1: 0, y1: 0, x2: 100, y2: 100 };
    assert.equal(coordinateSpace(gen), null);
    assert.equal(sourcePlan({ generation: gen }).skip, 'unmapped_coordinate_space');
  });
  it('skips unknown coordinates_image_size values', () => {
    const gen = { x1: 0, y1: 0, x2: 100, y2: 100, coordinates_image_size: '200' };
    assert.equal(sourcePlan({ generation: gen }).skip, 'unmapped_coordinate_space');
  });
});

describe('source selection', () => {
  it('uses {imgid}.400.jpg when crop coordinates are in the 400px space', () => {
    const plan = sourcePlan({
      imgid: '7',
      generation: { x1: 10, y1: 10, x2: 200, y2: 200, coordinates_image_size: '400' },
    });
    assert.equal(plan.skip, null);
    assert.equal(plan.sourceKind, '400');
    assert.equal(plan.applyCrop, true);
    assert.match(offSourceUrl('0012345678905', '7', '400'), /\/001\/234\/567\/8905\/7\.400\.jpg$/);
  });
  it('uses {imgid}.jpg when crop coordinates are in the full space', () => {
    const plan = sourcePlan({
      imgid: '7',
      generation: { x1: 10, y1: 10, x2: 800, y2: 800, coordinates_image_size: 'full' },
    });
    assert.equal(plan.sourceKind, 'full');
    assert.equal(plan.applyCrop, true);
    assert.match(offSourceUrl('0012345678905', '7', 'full'), /\/001\/234\/567\/8905\/7\.jpg$/);
  });
  it('accepts 400px as 400 space', () => {
    const plan = sourcePlan({
      generation: { x1: 0, y1: 0, x2: 10, y2: 10, coordinates_image_size: '400px' },
    });
    assert.equal(plan.sourceKind, '400');
  });
  it('marks uncropped when there is no usable crop', () => {
    const plan = sourcePlan({ generation: {} });
    assert.equal(plan.sourceKind, 'uncropped');
    assert.equal(plan.applyCrop, false);
  });
  it('pads numeric barcodes shorter than 13 digits', () => {
    assert.equal(barcodePath('123'), '000/000/000/0123');
    assert.equal(barcodePath('0012345678905'), '001/234/567/8905');
  });
  it('normalizes imgid 1.0 to 1', () => {
    assert.equal(normalizeImgid('1.0'), '1');
    assert.equal(normalizeImgid(2), '2');
  });
});

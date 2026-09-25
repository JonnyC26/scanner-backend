'use strict';

const { classifySearchProductType } = require('../../../lib/search_product_type');
const { SCOPE_SEARCH, SCOPE_ALL_US_FRONT } = require('./constants');

function normalizeScope(scope) {
  return scope === SCOPE_ALL_US_FRONT ? SCOPE_ALL_US_FRONT : SCOPE_SEARCH;
}

function isUnitedStates(product) {
  const countries = product && product.countries_tags;
  return Array.isArray(countries) && countries.includes('en:united-states');
}

function isSearchUniverse(product) {
  if (!isUnitedStates(product)) return false;
  const cats = product.categories_tags;
  if (!Array.isArray(cats) || cats.length === 0) return false;
  return classifySearchProductType(cats) === 'food';
}

function extractFronts(images) {
  const fronts = [];
  if (!images || typeof images !== 'object') return fronts;
  const selected = images.selected;
  if (selected && typeof selected === 'object' && selected.front && typeof selected.front === 'object') {
    for (const [lc, info] of Object.entries(selected.front)) {
      if (!info || typeof info !== 'object') continue;
      fronts.push({
        lc,
        imgid: normalizeImgid(info.imgid),
        rev: info.rev == null ? '' : String(info.rev),
        generation: normalizeGeneration(info.generation && typeof info.generation === 'object' ? info.generation : {}),
        uploadedSizes: null,
        schema: 'new',
      });
    }
    return fronts;
  }
  for (const [key, info] of Object.entries(images)) {
    if (!/^front_[a-z]{2}$/.test(key) || !info || typeof info !== 'object') continue;
    const gen = info.generation && typeof info.generation === 'object'
      ? info.generation
      : {
        x1: info.x1,
        y1: info.y1,
        x2: info.x2,
        y2: info.y2,
        angle: info.angle,
        coordinates_image_size: info.coordinates_image_size,
        normalize: info.normalize,
        white_magic: info.white_magic,
        geometry: info.geometry,
      };
    fronts.push({
      lc: key.slice(6),
      imgid: normalizeImgid(info.imgid),
      rev: info.rev == null ? '' : String(info.rev),
      generation: normalizeGeneration(gen),
      uploadedSizes: null,
      schema: 'old',
    });
  }
  return fronts;
}

function uploadedSizesFor(images, imgid) {
  if (!images || !imgid) return null;
  const uploaded = images.uploaded && typeof images.uploaded === 'object' ? images.uploaded : images;
  const info = uploaded[imgid] || uploaded[String(imgid)];
  if (!info || typeof info !== 'object') return null;
  return info.sizes || null;
}

function pickFront(fronts, productLang) {
  if (!fronts || fronts.length === 0) return null;
  const byLc = new Map();
  for (const f of fronts) {
    if (f && f.lc) byLc.set(f.lc, f);
  }
  const lang = productLang && String(productLang).trim();
  for (const cand of ['en', lang, 'en']) {
    if (cand && byLc.has(cand)) return byLc.get(cand);
  }
  const rest = [...byLc.keys()].sort();
  if (rest.length) return byLc.get(rest[0]);
  return fronts[0];
}

function normalizeImgid(imgid) {
  if (imgid == null || imgid === '') return '';
  const s = String(imgid).trim();
  if (/^\d+\.0+$/.test(s)) return String(parseInt(s, 10));
  return s;
}

function isAffirmativeFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1';
  }
  return false;
}

function numericOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeGeneration(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  return {
    x1: numericOrNull(g.x1),
    y1: numericOrNull(g.y1),
    x2: numericOrNull(g.x2),
    y2: numericOrNull(g.y2),
    angle: numericOrNull(g.angle),
    coordinates_image_size: g.coordinates_image_size == null || g.coordinates_image_size === ''
      ? null
      : String(g.coordinates_image_size),
    normalize: g.normalize,
    white_magic: g.white_magic,
    geometry: g.geometry == null ? null : String(g.geometry),
  };
}

function hasUsableCrop(generation) {
  const g = generation || {};
  const { x1, y1, x2, y2 } = g;
  if ([x1, y1, x2, y2].some(v => v == null)) return false;
  if (x1 === x2 || y1 === y2) return false;
  return true;
}

function geometryImpliesCrop(geometry) {
  if (!geometry || typeof geometry !== 'string') return false;
  const g = geometry.trim();
  if (!g || g === '0x0-0-0' || g === '0x0--1--1') return false;
  const m = g.match(/^(\d+)x(\d+)/);
  if (!m) return false;
  return Number(m[1]) > 0 && Number(m[2]) > 0;
}

function hasLegacyGeometryOnly(generation) {
  const g = generation || {};
  if (hasUsableCrop(g)) return false;
  return geometryImpliesCrop(g.geometry);
}

function hasNormalizeOrWhiteMagic(generation) {
  const g = generation || {};
  return isAffirmativeFlag(g.normalize) || isAffirmativeFlag(g.white_magic);
}

function coordinateSpace(generation) {
  const raw = generation && generation.coordinates_image_size;
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === '400' || s === '400px') return '400';
  if (s === 'full') return 'full';
  return null;
}

function barcodePath(code) {
  let c = String(code || '');
  if (/^\d+$/.test(c) && c.length < 13) c = c.padStart(13, '0');
  if (c.length <= 8) return c;
  const m = c.match(/^(...)(...)(...)(.*)$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}/${m[4]}` : c;
}

function rotationAngle(generation) {
  const a = generation && generation.angle;
  if (a == null || !Number.isFinite(a)) return 0;
  const n = ((a % 360) + 360) % 360;
  return n === 0 ? 0 : n;
}

function selectCandidate(product, scope) {
  const normalized = normalizeScope(scope);
  if (normalized === SCOPE_SEARCH) {
    if (!isSearchUniverse(product)) return null;
  } else if (!isUnitedStates(product)) {
    return null;
  }
  const fronts = extractFronts(product.images);
  const chosen = pickFront(fronts, product.lang || product.lc);
  if (!chosen || !chosen.imgid) return null;
  chosen.uploadedSizes = uploadedSizesFor(product.images, chosen.imgid);
  return {
    code: String(product.code || ''),
    productName: product.product_name || product.product_name_en || '',
    lang: product.lang || product.lc || '',
    chosen,
  };
}

function sourcePlan(chosen) {
  const gen = chosen.generation || normalizeGeneration({});
  if (hasNormalizeOrWhiteMagic(gen)) {
    return { skip: 'normalize_or_white_magic' };
  }
  if (hasLegacyGeometryOnly(gen)) {
    return { skip: 'legacy_geometry_only' };
  }
  if (hasUsableCrop(gen)) {
    const space = coordinateSpace(gen);
    if (!space) return { skip: 'unmapped_coordinate_space' };
    return {
      skip: null,
      sourceKind: space === '400' ? '400' : 'full',
      applyCrop: true,
      applyRotate: rotationAngle(gen) !== 0,
      generation: gen,
    };
  }
  return {
    skip: null,
    sourceKind: 'uncropped',
    applyCrop: false,
    applyRotate: rotationAngle(gen) !== 0,
    generation: gen,
  };
}

function offSourceUrl(code, imgid, kind) {
  const name = kind === '400' ? `${imgid}.400.jpg` : `${imgid}.jpg`;
  return `${require('./constants').OFF_IMAGE_BUCKET}/${barcodePath(code)}/${name}`;
}

function offThumbUrl(code, lc, rev) {
  return `https://images.openfoodfacts.org/images/products/${barcodePath(code)}/front_${lc}.${rev}.100.jpg`;
}

module.exports = {
  normalizeScope,
  isUnitedStates,
  isSearchUniverse,
  extractFronts,
  pickFront,
  normalizeImgid,
  normalizeGeneration,
  hasUsableCrop,
  hasLegacyGeometryOnly,
  hasNormalizeOrWhiteMagic,
  coordinateSpace,
  barcodePath,
  rotationAngle,
  selectCandidate,
  sourcePlan,
  offSourceUrl,
  offThumbUrl,
  isAffirmativeFlag,
};

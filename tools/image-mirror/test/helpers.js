'use strict';

const zlib = require('zlib');
const { Readable } = require('stream');
const sharp = require('sharp');
const { encodeManifest, emptyManifest } = require('../src/manifest');

function usFood(overrides = {}) {
  const images = overrides.images !== undefined ? overrides.images : {
    selected: {
      front: {
        en: {
          imgid: '1',
          rev: '12',
          generation: {},
        },
      },
    },
  };
  return {
    code: '0012345678905',
    product_name: 'Test Cereal',
    lang: 'en',
    countries_tags: ['en:united-states'],
    categories_tags: ['en:breakfast-cereals', 'en:plant-based-foods'],
    ...overrides,
    images,
  };
}

async function patch(width, height, background) {
  return sharp({
    create: { width, height, channels: 3, background },
  }).png().toBuffer();
}

async function solidJpeg(width, height, background = { r: 40, g: 120, b: 200 }) {
  const innerW = Math.max(1, width - 24);
  const innerH = Math.max(1, height - 24);
  const inner = await patch(innerW, innerH, {
    r: Math.min(255, background.r + 90),
    g: Math.min(255, background.g + 40),
    b: Math.max(0, background.b - 20),
  });
  return sharp({
    create: { width, height, channels: 3, background },
  })
    .composite([{ input: inner, left: 12, top: 12 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function gradientJpeg(width, height, { leftRgb = [40, 120, 200], rightRgb = null } = {}) {
  const buf = Buffer.alloc(width * height * 3);
  const mid = rightRgb ? Math.floor(width / 2) : width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const rgb = rightRgb && x >= mid ? rightRgb : leftRgb;
      buf[i] = Math.min(255, rgb[0] + Math.floor(50 * x / width));
      buf[i + 1] = Math.min(255, rgb[1] + Math.floor(50 * y / height));
      buf[i + 2] = rgb[2];
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

async function splitJpeg(width, height) {
  const left = Math.floor(width / 2);
  const right = width - left;
  const mark = Math.max(8, Math.floor(Math.min(left, height) / 5));
  const L = await patch(left, height, { r: 220, g: 20, b: 20 });
  const R = await patch(right, height, { r: 20, g: 40, b: 220 });
  const spot = await patch(mark, mark, { r: 250, g: 240, b: 20 });
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      { input: L, left: 0, top: 0 },
      { input: R, left, top: 0 },
      { input: spot, left: Math.floor(left / 2 - mark / 2), top: Math.floor(height / 2 - mark / 2) },
      { input: spot, left: left + Math.floor(right / 2 - mark / 2), top: Math.floor(height / 2 - mark / 2) },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function gzipDump(products) {
  const body = products.map((p) => JSON.stringify(p)).join('\n') + '\n';
  return zlib.gzipSync(Buffer.from(body, 'utf8'));
}

function memoryStore(initialManifest) {
  const objects = new Map();
  if (initialManifest) {
    objects.set('manifest/v1.json.gz', encodeManifest(initialManifest));
  }
  const puts = [];
  return {
    objects,
    puts,
    async getObject(key) {
      return objects.has(key) ? objects.get(key) : null;
    },
    async putObject({ key, body, contentType, cacheControl }) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      objects.set(key, buf);
      puts.push({ key, bytes: buf.length, contentType, cacheControl });
    },
  };
}

function dumpAndImages({ products, images = {}, missing = new Set() }) {
  const gz = gzipDump(products);
  return async function fetchImpl(url) {
    if (url.includes('openfoodfacts-products') || url.endsWith('.jsonl.gz') || url === 'https://dump.test/products.jsonl.gz') {
      return {
        ok: true,
        status: 200,
        body: Readable.toWeb(Readable.from([gz])),
      };
    }
    if (missing.has(url) || missing.has('*')) {
      return { ok: false, status: 404 };
    }
    for (const [suffix, buf] of Object.entries(images)) {
      if (url.endsWith(suffix) || url.includes(suffix)) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => buf,
        };
      }
    }
    if (images['*']) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => images['*'],
      };
    }
    return { ok: false, status: 404 };
  };
}

module.exports = {
  usFood,
  solidJpeg,
  gradientJpeg,
  splitJpeg,
  gzipDump,
  memoryStore,
  dumpAndImages,
  emptyManifest,
};

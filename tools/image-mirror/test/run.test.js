'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseManifest, addEntry, emptyManifest, shouldSkip } = require('../src/manifest');
const { runMirror, reservoirSample, resolveSourceBuffer } = require('../src/run');
const { usFood, solidJpeg, memoryStore, dumpAndImages } = require('./helpers');
const { MANIFEST_KEY } = require('../src/constants');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'image-mirror-'));
}

describe('manifest resume and PUT failure', () => {
  it('shouldSkip is true only when the fingerprint matches', () => {
    const manifest = emptyManifest();
    addEntry(manifest, '001', { lc: 'en', rev: '1', imgid: '1', sourceFingerprint: 'aaa', key: 'front/001/en.1.aaa.p1.jpg' });
    assert.equal(shouldSkip(manifest, '001', 'aaa'), true);
    assert.equal(shouldSkip(manifest, '001', 'bbb'), false);
    assert.equal(shouldSkip(manifest, '002', 'aaa'), false);
  });

  it('resume skips barcodes whose sourceFingerprint already matches', async () => {
    const product = usFood();
    const jpeg = await solidJpeg(400, 400);
    const store = memoryStore();
    const fetchImpl = dumpAndImages({ products: [product], images: { '*': jpeg } });
    const first = await runMirror({
      dumpUrl: 'https://dump.test/products.jsonl.gz',
      limit: 0,
      sampleSeed: '1',
      dryRun: false,
      writeCap: 100,
      concurrency: 1,
      store,
      fetchImpl,
      artifactDir: tmpDir(),
      log: () => {},
    });
    assert.equal(first.summary.mirrored, 1);
    const imagePutsAfterFirst = store.puts.filter((p) => p.key.startsWith('front/')).length;
    const second = await runMirror({
      dumpUrl: 'https://dump.test/products.jsonl.gz',
      limit: 0,
      sampleSeed: '1',
      dryRun: false,
      writeCap: 100,
      concurrency: 1,
      store,
      fetchImpl,
      artifactDir: tmpDir(),
      log: () => {},
    });
    assert.equal(second.summary.mirrored, 0);
    assert.equal(second.summary.skippedByReason.already_mirrored, 1);
    assert.equal(store.puts.filter((p) => p.key.startsWith('front/')).length, imagePutsAfterFirst);
  });

  it('writes a new object when the fingerprint changes and leaves the old object', async () => {
    const plain = usFood();
    const cropped = usFood({
      images: {
        selected: {
          front: {
            en: {
              imgid: '1',
              rev: '12',
              generation: { x1: 0, y1: 0, x2: 400, y2: 400, coordinates_image_size: '400' },
            },
          },
        },
      },
    });
    const jpeg = await solidJpeg(400, 400);
    const store = memoryStore();
    await runMirror({
      dumpUrl: 'https://dump.test/products.jsonl.gz',
      limit: 0,
      sampleSeed: '1',
      dryRun: false,
      writeCap: 100,
      concurrency: 1,
      store,
      fetchImpl: dumpAndImages({ products: [plain], images: { '*': jpeg } }),
      artifactDir: tmpDir(),
      log: () => {},
    });
    const keysAfterFirst = store.puts.filter((p) => p.key.startsWith('front/')).map((p) => p.key);
    await runMirror({
      dumpUrl: 'https://dump.test/products.jsonl.gz',
      limit: 0,
      sampleSeed: '1',
      dryRun: false,
      writeCap: 100,
      concurrency: 1,
      store,
      fetchImpl: dumpAndImages({ products: [cropped], images: { '*': jpeg } }),
      artifactDir: tmpDir(),
      log: () => {},
    });
    const imageKeys = store.puts.filter((p) => p.key.startsWith('front/')).map((p) => p.key);
    assert.equal(keysAfterFirst.length, 1);
    assert.equal(imageKeys.length, 2);
    assert.notEqual(imageKeys[1], imageKeys[0]);
    assert.ok(store.objects.has(keysAfterFirst[0]));
    const saved = parseManifest(await store.getObject(MANIFEST_KEY));
    assert.equal(saved.entries[plain.code].key, imageKeys[1]);
  });

  it('never writes a manifest entry when the image PUT fails', async () => {
    const product = usFood();
    const jpeg = await solidJpeg(400, 400);
    const objects = new Map();
    const store = {
      async getObject() { return null; },
      async putObject({ key, body }) {
        if (key.startsWith('front/')) throw new Error('injected PUT failure');
        objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
      },
    };
    const artifactDir = tmpDir();
    const { summary } = await runMirror({
      dumpUrl: 'https://dump.test/products.jsonl.gz',
      limit: 0,
      sampleSeed: '1',
      dryRun: false,
      writeCap: 100,
      concurrency: 1,
      store,
      fetchImpl: dumpAndImages({ products: [product], images: { '*': jpeg } }),
      artifactDir,
      log: () => {},
    });
    assert.equal(summary.mirrored, 0);
    assert.equal(summary.skippedByReason.put_failed, 1);
    assert.equal(objects.has(MANIFEST_KEY), true);
    const saved = parseManifest(objects.get(MANIFEST_KEY));
    assert.deepEqual(saved.entries, {});
  });

  it('PUTs the image with jpeg / immutable headers, then records the manifest entry', async () => {
    const product = usFood();
    const jpeg = await solidJpeg(400, 400);
    const store = memoryStore();
    const artifactDir = tmpDir();
    const { summary, mirrored } = await runMirror({
      dumpUrl: 'https://dump.test/products.jsonl.gz',
      limit: 0,
      sampleSeed: '1',
      dryRun: false,
      writeCap: 100,
      concurrency: 1,
      store,
      fetchImpl: dumpAndImages({ products: [product], images: { '*': jpeg } }),
      artifactDir,
      log: () => {},
    });
    assert.equal(summary.mirrored, 1);
    const imagePuts = store.puts.filter((p) => p.key.startsWith('front/'));
    assert.equal(imagePuts.length, 1);
    assert.equal(imagePuts[0].contentType, 'image/jpeg');
    assert.equal(imagePuts[0].cacheControl, 'public, max-age=31536000, immutable');
    const imagePutIndex = store.puts.findIndex((p) => p.key.startsWith('front/'));
    const firstManifestIndex = store.puts.findIndex((p) => p.key === MANIFEST_KEY);
    assert.ok(imagePutIndex >= 0 && firstManifestIndex > imagePutIndex);
    const saved = parseManifest(await store.getObject(MANIFEST_KEY));
    const entry = saved.entries[product.code];
    assert.ok(entry);
    assert.equal(entry.lc, 'en');
    assert.equal(entry.rev, '12');
    assert.equal(entry.imgid, '1');
    assert.equal(entry.key, mirrored[0].key);
    assert.equal(entry.sourceFingerprint, mirrored[0].fingerprint);
  });

  it('counts source_missing when the AWS object is absent', async () => {
    const product = usFood();
    const store = memoryStore();
    const artifactDir = tmpDir();
    const { summary } = await runMirror({
      dumpUrl: 'https://dump.test/products.jsonl.gz',
      limit: 0,
      sampleSeed: '1',
      dryRun: false,
      writeCap: 100,
      concurrency: 1,
      store,
      fetchImpl: dumpAndImages({ products: [product], missing: new Set(['*']) }),
      artifactDir,
      log: () => {},
    });
    assert.equal(summary.skippedByReason.source_missing, 1);
    assert.equal(store.puts.filter((p) => p.key.startsWith('front/')).length, 0);
  });

  it('dry_run processes but writes nothing to the store', async () => {
    const product = usFood();
    const jpeg = await solidJpeg(400, 400);
    const store = memoryStore();
    const artifactDir = tmpDir();
    const { summary } = await runMirror({
      dumpUrl: 'https://dump.test/products.jsonl.gz',
      limit: 0,
      sampleSeed: '1',
      dryRun: true,
      writeCap: 100,
      concurrency: 1,
      store,
      fetchImpl: dumpAndImages({ products: [product], images: { '*': jpeg } }),
      artifactDir,
      log: () => {},
    });
    assert.equal(summary.mirrored, 1);
    assert.equal(summary.dryRun, true);
    assert.equal(store.puts.length, 0);
  });
});

describe('uncropped source selection', () => {
  it('uses {imgid}.400.jpg when its shorter side is at least 200px', async () => {
    const jpeg400 = await solidJpeg(400, 300);
    const jpegFull = await solidJpeg(800, 600);
    const fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => (url.endsWith('.400.jpg') ? jpeg400 : jpegFull),
    });
    const out = await resolveSourceBuffer(
      { code: '0012345678905', chosen: { imgid: '1' } },
      { sourceKind: 'uncropped' },
      fetchImpl,
    );
    assert.equal(out.sourceKind, '400');
  });

  it('falls back to {imgid}.jpg when the 400px file is too small', async () => {
    const jpeg400 = await solidJpeg(150, 150);
    const jpegFull = await solidJpeg(800, 600);
    const fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => (url.endsWith('.400.jpg') ? jpeg400 : jpegFull),
    });
    const out = await resolveSourceBuffer(
      { code: '0012345678905', chosen: { imgid: '1' } },
      { sourceKind: 'uncropped' },
      fetchImpl,
    );
    assert.equal(out.sourceKind, 'full');
  });
});

describe('reservoir sample', () => {
  it('is deterministic for a seed and not merely the first N', () => {
    const a = reservoirSample(3, '20260924');
    const b = reservoirSample(3, '20260924');
    const c = reservoirSample(3, 'other');
    for (let i = 0; i < 50; i++) {
      a.push(i);
      b.push(i);
      c.push(i);
    }
    assert.deepEqual(a.items, b.items);
    assert.equal(a.seen, 50);
    assert.notDeepEqual(a.items, [0, 1, 2]);
    assert.notDeepEqual(a.items, c.items);
  });
});

describe('contact sheet', () => {
  it('references the OFF thumb as a remote img src and does not fetch it', async () => {
    const product = usFood({ product_name: 'Sheet Cereal' });
    const jpeg = await solidJpeg(400, 400);
    const fetched = [];
    const baseFetch = dumpAndImages({ products: [product], images: { '*': jpeg } });
    const fetchImpl = async (url) => {
      fetched.push(url);
      return baseFetch(url);
    };
    const artifactDir = tmpDir();
    await runMirror({
      dumpUrl: 'https://dump.test/products.jsonl.gz',
      limit: 0,
      sampleSeed: '1',
      dryRun: true,
      writeCap: 100,
      concurrency: 1,
      store: null,
      fetchImpl,
      artifactDir,
      log: () => {},
    });
    assert.ok(fetched.every((u) => !u.includes('images.openfoodfacts.org')));
    const html = fs.readFileSync(path.join(artifactDir, 'index.html'), 'utf8');
    assert.match(html, /src="https:\/\/images\.openfoodfacts\.org\/images\/products\/001\/234\/567\/8905\/front_en\.12\.100\.jpg"/);
    assert.match(html, /0012345678905/);
    assert.match(html, /Sheet Cereal/);
    assert.ok(fs.existsSync(path.join(artifactDir, 'ours', '0012345678905.jpg')));
  });
});

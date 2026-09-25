'use strict';

const zlib = require('zlib');
const { MANIFEST_KEY, PIPELINE_VERSION } = require('./constants');

function emptyManifest() {
  return {
    version: 1,
    pipelineVersion: PIPELINE_VERSION,
    updatedAt: null,
    entries: {},
  };
}

function parseManifest(buf) {
  if (!buf || !buf.length) return emptyManifest();
  const json = zlib.gunzipSync(buf);
  const data = JSON.parse(json.toString('utf8'));
  if (!data || typeof data !== 'object') return emptyManifest();
  if (!data.entries || typeof data.entries !== 'object') data.entries = {};
  return data;
}

function encodeManifest(manifest) {
  const body = JSON.stringify({
    version: 1,
    pipelineVersion: PIPELINE_VERSION,
    updatedAt: new Date().toISOString(),
    entries: manifest.entries || {},
  });
  return zlib.gzipSync(Buffer.from(body, 'utf8'));
}

function shouldSkip(manifest, barcode, fingerprint) {
  const entry = manifest.entries && manifest.entries[barcode];
  return !!(entry && entry.sourceFingerprint === fingerprint);
}

function addEntry(manifest, barcode, entry) {
  if (!manifest.entries) manifest.entries = {};
  manifest.entries[barcode] = {
    lc: entry.lc,
    rev: entry.rev,
    imgid: entry.imgid,
    sourceFingerprint: entry.sourceFingerprint,
    key: entry.key,
  };
}

async function loadManifest(store) {
  const buf = await store.getObject(MANIFEST_KEY);
  if (!buf) return emptyManifest();
  return parseManifest(buf);
}

async function saveManifest(store, manifest) {
  const serializeStarted = Date.now();
  const body = encodeManifest(manifest);
  const serializeMs = Date.now() - serializeStarted;
  const putStarted = Date.now();
  await store.putObject({
    key: MANIFEST_KEY,
    body,
    contentType: 'application/gzip',
    cacheControl: 'no-store',
  });
  const putMs = Date.now() - putStarted;
  return {
    bytes: body.length,
    serializeMs,
    putMs,
    entryCount: Object.keys((manifest && manifest.entries) || {}).length,
  };
}

module.exports = {
  emptyManifest,
  parseManifest,
  encodeManifest,
  shouldSkip,
  addEntry,
  loadManifest,
  saveManifest,
  MANIFEST_KEY,
};

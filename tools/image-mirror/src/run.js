'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { Readable } = require('stream');
const {
  OFF_DUMP_URL,
  USER_AGENT,
  DEFAULT_CONCURRENCY,
  DEFAULT_WRITE_CAP,
  MANIFEST_CHECKPOINT_EVERY,
  OUTPUT_SIZE,
  CONTACT_SHEET_RANDOM,
  CONTACT_SHEET_TRANSFORM_CAP,
} = require('./constants');
const { mulberry32, seedFrom } = require('./prng');
const {
  selectCandidate,
  sourcePlan,
  offSourceUrl,
  rotationAngle,
  normalizeScope,
} = require('./select');
const { processToSquare, sourceShorterSide } = require('./process');
const { sourceFingerprint } = require('./fingerprint');
const { objectKey } = require('./keys');
const {
  emptyManifest,
  shouldSkip,
  addEntry,
  loadManifest,
  saveManifest,
} = require('./manifest');
const { writeContactSheet } = require('./contactSheet');

async function* iterateDumpLines(url = OFF_DUMP_URL, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`OFF dump HTTP ${res.status}`);
  const gunzip = zlib.createGunzip();
  const nodeStream = Readable.fromWeb(res.body).pipe(gunzip);
  const rl = readline.createInterface({ input: nodeStream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line) yield line;
  }
}

function parseProduct(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function timingStats(values) {
  if (!values.length) return { median: 0, max: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    median: sorted[Math.floor((sorted.length - 1) / 2)],
    max: sorted[sorted.length - 1],
  };
}

function reservoirSample(limit, seed) {
  const rng = mulberry32(seedFrom(seed));
  const sample = [];
  let seen = 0;
  return {
    push(item) {
      seen += 1;
      if (sample.length < limit) {
        sample.push(item);
        return;
      }
      const j = Math.floor(rng() * seen);
      if (j < limit) sample[j] = item;
    },
    get items() { return sample; },
    get seen() { return seen; },
  };
}

async function fetchSource(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`source HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resolveSourceBuffer(candidate, plan, fetchImpl) {
  const { code, chosen } = candidate;
  if (plan.sourceKind === '400' || plan.sourceKind === 'full') {
    const url = offSourceUrl(code, chosen.imgid, plan.sourceKind);
    const buf = await fetchSource(url, fetchImpl);
    if (!buf) return { skip: 'source_missing', sourceKind: plan.sourceKind };
    return { buffer: buf, sourceKind: plan.sourceKind };
  }
  const url400 = offSourceUrl(code, chosen.imgid, '400');
  const buf400 = await fetchSource(url400, fetchImpl);
  if (buf400) {
    const shorter = await sourceShorterSide(buf400);
    if (shorter >= OUTPUT_SIZE) return { buffer: buf400, sourceKind: '400' };
  }
  const urlFull = offSourceUrl(code, chosen.imgid, 'full');
  const bufFull = await fetchSource(urlFull, fetchImpl);
  if (!bufFull) return { skip: 'source_missing', sourceKind: buf400 ? 'full' : '400' };
  return { buffer: bufFull, sourceKind: 'full' };
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function collectCandidates({ dumpUrl, limit, sampleSeed, offset, fetchImpl, onProgress, scope }) {
  const reservoir = limit > 0 ? reservoirSample(limit, sampleSeed) : null;
  const sequential = [];
  let eligible = 0;
  let scanned = 0;
  for await (const line of iterateDumpLines(dumpUrl, fetchImpl)) {
    scanned += 1;
    if (onProgress && scanned % 200000 === 0) onProgress({ scanned, eligible });
    const product = parseProduct(line);
    if (!product) continue;
    const candidate = selectCandidate(product, scope);
    if (!candidate || !candidate.code) continue;
    eligible += 1;
    if (reservoir) {
      reservoir.push(candidate);
    } else if (eligible > offset) {
      sequential.push(candidate);
    }
  }
  let items = reservoir ? reservoir.items.slice() : sequential;
  if (reservoir && offset > 0) items = items.slice(offset);
  return { items, scanned, eligible };
}

async function processCandidate(candidate, { fetchImpl, manifest }) {
  const plan = sourcePlan(candidate.chosen);
  if (plan.skip) {
    return { status: 'skipped', reason: plan.skip, candidate };
  }
  const fingerprint = sourceFingerprint({
    imgid: candidate.chosen.imgid,
    generation: plan.generation,
    sourceKind: plan.sourceKind,
  });
  const key = objectKey({
    barcode: candidate.code,
    lc: candidate.chosen.lc,
    rev: candidate.chosen.rev,
    fingerprint,
  });
  if (manifest && shouldSkip(manifest, candidate.code, fingerprint)) {
    return { status: 'skipped', reason: 'already_mirrored', candidate, fingerprint, key };
  }
  let source;
  try {
    source = await resolveSourceBuffer(candidate, plan, fetchImpl);
  } catch (err) {
    return { status: 'skipped', reason: 'source_missing', candidate, error: err.message };
  }
  if (source.skip) {
    return { status: 'skipped', reason: source.skip, candidate };
  }
  const processed = await processToSquare({
    sourceBuffer: source.buffer,
    generation: plan.generation,
    uploadedSizes: candidate.chosen.uploadedSizes,
    sourceKind: source.sourceKind,
  });
  // Drop the raw source immediately.
  source.buffer = null;
  if (processed.skip) {
    return { status: 'skipped', reason: processed.skip, candidate };
  }
  return {
    status: 'ready',
    candidate,
    buffer: processed.buffer,
    fingerprint,
    key,
    sourceKind: source.sourceKind,
    applyCrop: plan.applyCrop,
    applyRotate: plan.applyRotate,
    angle: rotationAngle(plan.generation),
  };
}

async function runMirror(opts) {
  const {
    dumpUrl = OFF_DUMP_URL,
    limit = 0,
    sampleSeed = '20260924',
    offset = 0,
    dryRun = false,
    writeCap = DEFAULT_WRITE_CAP,
    concurrency = DEFAULT_CONCURRENCY,
    store = null,
    fetchImpl = fetch,
    artifactDir = path.join(process.cwd(), 'artifact'),
    log = console.log,
    scope: scopeInput,
  } = opts;
  const scope = normalizeScope(scopeInput);

  const started = Date.now();
  const skipCounts = {};
  const bumpSkip = (reason) => {
    skipCounts[reason] = (skipCounts[reason] || 0) + 1;
  };

  log(`collecting candidates limit=${limit || 'none'} seed=${sampleSeed} offset=${offset} scope=${scope}`);
  const { items, scanned, eligible } = await collectCandidates({
    dumpUrl,
    limit,
    sampleSeed,
    offset,
    fetchImpl,
    scope,
    onProgress: (p) => log(`dump scanned=${p.scanned} eligible=${p.eligible}`),
  });
  log(`dump done scanned=${scanned} eligible=${eligible} selected=${items.length}`);

  let manifest = emptyManifest();
  if (!dryRun) {
    if (!store) throw new Error('R2 store is required unless dry_run');
    manifest = await loadManifest(store);
  }

  const mirrored = [];
  const sheetTransforms = [];
  const sheetRandom = [];
  const sheetRng = mulberry32(seedFrom(sampleSeed) ^ 0x9e3779b9);
  let sheetRandomSeen = 0;
  let imagePuts = 0;
  let manifestPuts = 0;
  let bytes = 0;
  const sizes = [];
  let writeCapHit = false;
  let writeLock = Promise.resolve();
  const checkpointTimings = [];
  let lastManifestSave = null;

  const reserveFinalManifest = dryRun ? 0 : 1;
  const canImagePut = () => dryRun || (imagePuts + manifestPuts + 1 + reserveFinalManifest) <= writeCap;

  function keepForContactSheet(row) {
    const isTransform = row.applyCrop || row.applyRotate;
    if (isTransform && sheetTransforms.length < CONTACT_SHEET_TRANSFORM_CAP) {
      sheetTransforms.push(row);
      return;
    }
    if (isTransform) {
      row.buffer = null;
      return;
    }
    sheetRandomSeen += 1;
    if (sheetRandom.length < CONTACT_SHEET_RANDOM) {
      sheetRandom.push(row);
      return;
    }
    const j = Math.floor(sheetRng() * sheetRandomSeen);
    if (j < CONTACT_SHEET_RANDOM) {
      sheetRandom[j].buffer = null;
      sheetRandom[j] = row;
    } else {
      row.buffer = null;
    }
  }

  function withWriteLock(fn) {
    const run = writeLock.then(fn, fn);
    writeLock = run.catch(() => {});
    return run;
  }

  await mapPool(items, concurrency, async (candidate) => {
    if (writeCapHit) {
      bumpSkip('write_cap');
      return;
    }
    const result = await processCandidate(candidate, { fetchImpl, manifest: dryRun ? null : manifest });
    if (result.status === 'skipped') {
      bumpSkip(result.reason);
      return;
    }
    await withWriteLock(async () => {
      if (!canImagePut()) {
        writeCapHit = true;
        bumpSkip('write_cap');
        result.buffer = null;
        return;
      }
      if (!dryRun) {
        try {
          await store.putObject({
            key: result.key,
            body: result.buffer,
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=31536000, immutable',
          });
        } catch (err) {
          bumpSkip('put_failed');
          log(`PUT failed ${candidate.code}: ${err.message}`);
          result.buffer = null;
          return;
        }
        imagePuts += 1;
        addEntry(manifest, candidate.code, {
          lc: candidate.chosen.lc,
          rev: candidate.chosen.rev,
          imgid: candidate.chosen.imgid,
          sourceFingerprint: result.fingerprint,
          key: result.key,
        });
        if (imagePuts % MANIFEST_CHECKPOINT_EVERY === 0) {
          lastManifestSave = await saveManifest(store, manifest);
          checkpointTimings.push(lastManifestSave);
          manifestPuts += 1;
        }
      }
      bytes += result.buffer.length;
      sizes.push(result.buffer.length);
      const row = {
        code: candidate.code,
        productName: candidate.productName,
        lc: candidate.chosen.lc,
        rev: candidate.chosen.rev,
        imgid: candidate.chosen.imgid,
        key: result.key,
        fingerprint: result.fingerprint,
        applyCrop: result.applyCrop,
        applyRotate: result.applyRotate,
        angle: result.angle,
        buffer: result.buffer,
      };
      mirrored.push(row);
      keepForContactSheet(row);
    });
  });

  if (!dryRun) {
    lastManifestSave = await saveManifest(store, manifest);
    checkpointTimings.push(lastManifestSave);
    manifestPuts += 1;
  }

  const skipped = Object.values(skipCounts).reduce((a, b) => a + b, 0);
  const cropCases = mirrored.filter(r => r.applyCrop).length;
  const rotationCases = mirrored.filter(r => r.applyRotate).length;
  sizes.sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : 0;
  const wallMs = Date.now() - started;
  const summary = {
    sampleSeed: String(sampleSeed),
    limit: limit || null,
    offset,
    dryRun,
    dumpScanned: scanned,
    eligibleUniverse: eligible,
    selected: items.length,
    mirrored: mirrored.length,
    skipped,
    skippedByReason: skipCounts,
    cropCases,
    rotationCases,
    r2ImagePuts: imagePuts,
    r2ManifestPuts: manifestPuts,
    r2Writes: imagePuts + manifestPuts,
    totalBytes: bytes,
    medianObjectBytes: median,
    wallMs,
    wallSeconds: Math.round(wallMs / 100) / 10,
    throughputPerMinute: wallMs > 0 ? Math.round(mirrored.length / (wallMs / 60000) * 10) / 10 : 0,
    writeCapHit,
    scope,
    manifestCompressedBytes: lastManifestSave ? lastManifestSave.bytes : 0,
    manifestEntryCount: Object.keys((manifest && manifest.entries) || {}).length,
    manifestCheckpoints: checkpointTimings.length,
    manifestSerializeMs: timingStats(checkpointTimings.map((t) => t.serializeMs)),
    manifestPutMs: timingStats(checkpointTimings.map((t) => t.putMs)),
  };

  fs.mkdirSync(artifactDir, { recursive: true });
  const sheetRows = [...sheetTransforms, ...sheetRandom].filter(r => r && r.buffer);
  writeContactSheet({ outDir: artifactDir, mirrored: sheetRows, seed: sampleSeed, summary });
  fs.writeFileSync(path.join(artifactDir, 'run-summary.json'), JSON.stringify(summary, null, 2));
  log(JSON.stringify(summary, null, 2));
  return { summary, mirrored };
}

module.exports = {
  runMirror,
  iterateDumpLines,
  collectCandidates,
  processCandidate,
  reservoirSample,
  resolveSourceBuffer,
};

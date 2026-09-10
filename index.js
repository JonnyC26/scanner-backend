const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
// Trust exactly one proxy hop (Railway). Err low: too high re-opens XFF spoofing.
app.set('trust proxy', 1);
// Keep the default 100kb JSON limit globally. /scan/photo and POST /image/:barcode
// attach their own 8mb parser — skip the global one there so large photos are not
// rejected early.
app.use((req, res, next) => {
  if (req.method === 'POST') {
    const pathOnly = (req.path || '').split('?')[0];
    const urlPath = (req.url || '').split('?')[0];
    if (
      pathOnly === '/scan/photo' || urlPath === '/scan/photo' ||
      urlPath.startsWith('/scan/photo') ||
      pathOnly.startsWith('/image/') || urlPath.startsWith('/image/')
    ) {
      return next();
    }
  }
  return express.json()(req, res, next);
});
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Firebase Admin — used to read/write a server-side product cache in Firestore.
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();
const CACHE_COLLECTION = 'productCache';
const RAW_COLLECTION = 'rawObservations';
const RAW_LATEST_COLLECTION = 'rawLatest';
const PRODUCT_IMAGES_COLLECTION = 'productImages';
const FAILED_WRITES_COLLECTION = 'failedWrites';
const IMAGE_REPORTS_COLLECTION = 'imageReports';
const IMAGE_SUPPRESS_REPORT_THRESHOLD = 2;
// Firestore docs cap at 1MB; leave headroom and skip oversize rather than truncate.
const RAW_PAYLOAD_MAX_BYTES = 800 * 1024;
const FAILED_WRITES_PAYLOAD_MAX_BYTES = 800 * 1024;
// Front-of-pack images stored in productImages — app must send something small.
const PRODUCT_IMAGE_MAX_BYTES = 200 * 1024;
const CACHE_WRITE_RETRY_DELAY_MS = 300;
// Cached entries older than this are treated as stale and get re-scanned,
// so a product's data doesn't go permanently out of date if OFF updates it.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Any change to classification, food scoring, or explanation copy requires a
// SCAN_LOGIC_VERSION bump, or it will not reach previously scanned products.
const SCAN_LOGIC_VERSION = '12';   // bump whenever classification or food scoring changes

// ── Request guards (rate limits + vision bill backstop) ─────────────────────
// In-memory only — fine for a single Railway instance. No npm dependency.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_PHOTO_PER_UID = 20;
const RATE_LIMIT_PHOTO_PER_IP = 60;
const RATE_LIMIT_SCAN_SEARCH_PER_IP = 300;
const RATE_LIMIT_ADMIN_PER_IP = 10;
const RATE_LIMIT_IMAGE_PER_IP = 600; // public /image — generous; Cache-Control means one fetch per client
const RATE_LIMIT_IMAGE_REPORT_PER_UID = 10;
// Hard daily ceiling on Anthropic vision calls across the whole service (UTC day).
const VISION_DAILY_CAP = 500;
const VISION_CAP_WARNING_RATIO = 0.8; // log once when used first crosses this fraction

const rateLimitBuckets = new Map(); // key -> { count, resetAt }
let visionDayKey = ''; // YYYY-MM-DD UTC
let visionDayCount = 0;
let visionCapWarningLoggedForDay = ''; // UTC day we already logged the 80% warning

function parseBearerToken(authHeader) {
  if (typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(\S+)/i);
  return match ? match[1] : null;
}

function checkRateLimit(key, limit, now = Date.now(), windowMs = RATE_LIMIT_WINDOW_MS) {
  let entry = rateLimitBuckets.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    rateLimitBuckets.set(key, entry);
  }
  if (entry.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { allowed: false, retryAfter, remaining: 0 };
  }
  entry.count += 1;
  return {
    allowed: true,
    retryAfter: 0,
    remaining: Math.max(0, limit - entry.count),
  };
}

function sweepRateLimitBuckets(now = Date.now()) {
  for (const [key, entry] of rateLimitBuckets) {
    if (!entry || now >= entry.resetAt) {
      rateLimitBuckets.delete(key);
    }
  }
}

function utcDayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// Consume one vision slot for the current UTC day. Returns false when capped.
function tryConsumeVisionSlot(now = Date.now()) {
  const day = utcDayKey(now);
  if (day !== visionDayKey) {
    visionDayKey = day;
    visionDayCount = 0;
  }
  if (visionDayCount >= VISION_DAILY_CAP) {
    return false;
  }
  visionDayCount += 1;
  const warnAt = Math.ceil(VISION_DAILY_CAP * VISION_CAP_WARNING_RATIO);
  if (visionDayCount >= warnAt && visionCapWarningLoggedForDay !== day) {
    visionCapWarningLoggedForDay = day;
    console.log(`[VISION CAP WARNING] used=${visionDayCount} cap=${VISION_DAILY_CAP}`);
  }
  return true;
}

// Current UTC day's vision call count (0 if no calls yet today on this instance).
function getVisionCallsToday(now = Date.now()) {
  const day = utcDayKey(now);
  if (day !== visionDayKey) return 0;
  return visionDayCount;
}

function sendRateLimited(res, route, key, retryAfter) {
  console.log(`[RATE LIMIT] route=${route} key=${key}`);
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({ error: 'Too many requests', retryAfter });
}

function enforceIpRateLimit(req, res, route, limit) {
  const ip = req.ip || 'unknown';
  // Opt-in only — logging every client IP on every request is noisy and a privacy issue.
  if (process.env.LOG_CLIENT_IP === '1') {
    console.log(`[IP] resolved=${ip}`);
  }
  const result = checkRateLimit(`${route}:ip:${ip}`, limit);
  if (!result.allowed) {
    sendRateLimited(res, route, `ip:${ip}`, result.retryAfter);
    return false;
  }
  return true;
}

function startRateLimitSweeper(intervalMs = 10 * 60 * 1000) {
  const id = setInterval(() => sweepRateLimitBuckets(), intervalMs);
  if (id && typeof id.unref === 'function') id.unref();
  return id;
}

// Barcodes used as Firestore doc ids / URL params — digits only, OFF/OBF lengths.
function normalizeBarcode(raw) {
  const barcode = String(raw == null ? '' : raw).trim();
  if (!/^\d{4,18}$/.test(barcode)) return null;
  // UPC-A (12 digits) → EAN-13 by left-padding one zero (OFF canonical form).
  // Do not pad EAN-8 or any other length; do not strip leading zeros.
  if (barcode.length === 12) return `0${barcode}`;
  return barcode;
}

function isValidBarcode(raw) {
  return normalizeBarcode(raw) != null;
}

// Legacy unpadded key for a canonical 13-digit code that starts with 0
// (the pre-Batch-3 UPC-A form). Null when there is no legacy counterpart.
function legacyUnpaddedBarcode(canonical) {
  if (typeof canonical !== 'string') return null;
  if (canonical.length === 13 && canonical.charAt(0) === '0') {
    return canonical.slice(1);
  }
  return null;
}

// Read productCache / productImages by canonical key. On a miss only, look for
// a legacy 12-digit doc, copy it forward, delete the old key, and return the
// migrated snapshot. Cache hits never touch the legacy key.
async function getDocWithBarcodeMigration(collectionName, canonical) {
  const canonicalRef = db.collection(collectionName).doc(canonical);
  const canonicalDoc = await canonicalRef.get();
  if (canonicalDoc.exists) return canonicalDoc;

  const legacy = legacyUnpaddedBarcode(canonical);
  if (!legacy) return canonicalDoc;

  const legacyRef = db.collection(collectionName).doc(legacy);
  const legacyDoc = await legacyRef.get();
  if (!legacyDoc.exists) return canonicalDoc;

  const data = legacyDoc.data();
  await canonicalRef.set(data);
  await legacyRef.delete();
  console.log(
    `[BARCODE MIGRATE] legacy=${legacy} canonical=${canonical} collection=${collectionName}`
  );
  return canonicalRef.get();
}

function stripDataUrlBase64(imageBase64) {
  return String(imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
}

// Only PUBLIC_BASE_URL — never host/proto from request headers (client-controlled).
function resolvePublicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
}

// Prefer brand + product name; either alone is fine; null when nothing usable.
// Reject names from non-packaging photos (isProductPackaging must be true).
function composeFrontProductName(front) {
  if (!front || front.readable === false) return null;
  if (front.isProductPackaging !== true) return null;
  const brand = front.brand != null ? String(front.brand).trim() : '';
  const name = front.productName != null ? String(front.productName).trim() : '';
  if (brand && name) return `${brand} ${name}`;
  if (name) return name;
  if (brand) return brand;
  return null;
}

// Write when missing/empty OR suppressed (troll image must be replaceable).
function shouldWriteProductImage(existing) {
  if (!existing) return true;
  if (existing.suppressed === true) return true;
  const bytes = typeof existing.bytes === 'number' ? existing.bytes : 0;
  const data = existing.data;
  if (!data || bytes <= 0) return true;
  return false;
}

function isFrontProductPackaging(front) {
  return !!(front && front.isProductPackaging === true);
}

// Placeholder / missing cache names that a front-of-pack read may repair.
function isRepairableProductName(name) {
  if (name == null) return true;
  const trimmed = String(name).trim();
  if (!trimmed) return true;
  return (
    trimmed === 'null' ||
    trimmed === 'Scanned label' ||
    trimmed === 'Unknown Product'
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Cap a payload string for failedWrites. Returns { payload, truncated }.
function capFailedWritePayload(payload) {
  let payloadStr;
  try {
    payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload === undefined ? null : payload);
  } catch (_) {
    return { payload: null, truncated: false };
  }
  if (payloadStr == null) return { payload: null, truncated: false };
  const bytes = Buffer.byteLength(payloadStr, 'utf8');
  if (bytes <= FAILED_WRITES_PAYLOAD_MAX_BYTES) {
    return { payload: payloadStr, truncated: false };
  }
  const sliced = Buffer.from(payloadStr, 'utf8').subarray(0, FAILED_WRITES_PAYLOAD_MAX_BYTES).toString('utf8');
  return { payload: sliced, truncated: true };
}

// Append-only dead-letter for failed Firestore writes. Never throws to callers.
function recordFailedWrite({ collection, barcode, payload, error, capturedBy }) {
  (async () => {
    try {
      const capped = capFailedWritePayload(payload);
      await db.collection(FAILED_WRITES_COLLECTION).add({
        collection: collection || 'unknown',
        barcode: barcode ? String(barcode) : null,
        payload: capped.payload,
        truncated: capped.truncated,
        error: String(error || 'unknown'),
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        capturedBy: capturedBy || null,
      });
    } catch (err) {
      console.log(`[FAILED WRITES ERROR] collection=${collection || 'unknown'} ${err.message}`);
    }
  })();
}

// productCache set with one retry. Returns true on success.
async function writeProductCacheWithRetry(docRef, cachePayload, { barcode, capturedBy }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await docRef.set(cachePayload);
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt === 1) {
        await sleep(CACHE_WRITE_RETRY_DELAY_MS);
      }
    }
  }
  console.log(`[CACHE WRITE FAILED barcode=${barcode} attempts=2]`);
  recordFailedWrite({
    collection: 'productCache',
    barcode,
    payload: cachePayload,
    error: lastErr ? lastErr.message : 'unknown',
    capturedBy,
  });
  return false;
}

// ── Cosmetic ingredient table (Open Beauty Facts path) ──────────────────────
const cosmeticTable = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'purla_cosmetic_ingredients.json'), 'utf8')
);
const cosmeticIngredients = cosmeticTable.ingredients;

// Recognised-only CosIng names — display + functions, NO risk grade.
// Must never count toward the coverage numerator. Guard: missing/corrupt
// file degrades to an empty map so this layer cannot take the scanner down.
function loadCosingNamesFromFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const version =
      parsed._meta && parsed._meta.version != null
        ? String(parsed._meta.version)
        : 'none';
    const map = new Map();
    for (const [key, val] of Object.entries(parsed.names || {})) {
      map.set(key, val);
    }
    return { map, version };
  } catch (err) {
    console.log(`[COSING NAMES] load failed — continuing with empty map: ${err.message}`);
    return { map: new Map(), version: 'none' };
  }
}

const _cosingLoaded = loadCosingNamesFromFile(
  path.join(__dirname, 'purla_cosing_names.json')
);
let cosingNamesMap = _cosingLoaded.map;
const COSING_NAMES_VERSION = _cosingLoaded.version;
// Fold into table version so cached rows refresh once when this layer ships.
const COSMETIC_TABLE_VERSION = `${cosmeticTable._meta.version}+cosing:${COSING_NAMES_VERSION}`;

function normalizeInci(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-') // unicode dashes → hyphen
    .replace(/[\u2044\u2215\uFF0F]/g, '/') // unicode slashes → /
    .replace(/\u201A/g, ',') // single low-9 quotation mark → comma (OCR)
    .replace(/\s*-\s*/g, '-')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

// Indexes for matching. Order at lookup time: declare_as → inci → covers_inci
// → synonym → recognised (CosIng names with no grade — never shadows a hazard hit).
// For declare_as collisions, prefer the parent (no member_of) so grouped labels
// resolve to the scorable entry rather than an alias.
const cosmeticByInci = new Map();
const cosmeticByDeclareAs = new Map();
const cosmeticByCovers = new Map();
const cosmeticBySynonym = new Map();

for (const entry of cosmeticIngredients) {
  if (entry.inci) cosmeticByInci.set(normalizeInci(entry.inci), entry);
}
for (const entry of cosmeticIngredients) {
  if (!entry.declare_as) continue;
  const key = normalizeInci(entry.declare_as);
  const existing = cosmeticByDeclareAs.get(key);
  if (!existing || (existing.member_of && !entry.member_of)) {
    cosmeticByDeclareAs.set(key, entry);
  }
}
for (const entry of cosmeticIngredients) {
  if (!Array.isArray(entry.covers_inci)) continue;
  for (const covered of entry.covers_inci) {
    const key = normalizeInci(covered);
    if (!cosmeticByCovers.has(key)) cosmeticByCovers.set(key, entry);
  }
}

const synonymTable = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'purla_inci_synonyms.json'), 'utf8')
);
for (const [commonName, inciTarget] of Object.entries(synonymTable.synonyms || {})) {
  const target = cosmeticByInci.get(normalizeInci(inciTarget));
  if (!target) {
    console.log(`[SYNONYM SKIP] target missing for "${commonName}" -> "${inciTarget}"`);
    continue;
  }
  cosmeticBySynonym.set(normalizeInci(commonName), target);
}

// Health check: reference maps must be non-empty. Counts only what we load at boot.
function getReferenceEntryCounts() {
  return {
    hazardCount: Array.isArray(cosmeticIngredients) ? cosmeticIngredients.length : 0,
    synonymCount: Object.keys((synonymTable && synonymTable.synonyms) || {}).length,
    cosingCount: cosingNamesMap ? cosingNamesMap.size : 0,
  };
}

// Pure evaluator — unit-tested. Does not touch Firestore or third parties.
function evaluateHealthStatus({
  firestoreOk,
  hazardCount,
  synonymCount,
  cosingCount,
  uptimeSeconds,
  tableVersion,
  cosingNamesVersion,
}) {
  if (!firestoreOk) {
    return { status: 503, body: { ok: false, reason: 'firestore unreachable' } };
  }
  if (!(hazardCount > 0) || !(synonymCount > 0) || !(cosingCount > 0)) {
    return { status: 503, body: { ok: false, reason: 'reference data not loaded' } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      uptimeSeconds,
      tableVersion,
      cosingNamesVersion,
      entryCount: hazardCount,
    },
  };
}

async function pingFirestore() {
  // Minimal read — confirms credentials + network, not product data.
  await db.collection(CACHE_COLLECTION).limit(1).get();
  return true;
}

function resolveCosmeticEntry(entry) {
  if (!entry) return null;
  if (entry.member_of) {
    const parent = cosmeticByInci.get(normalizeInci(entry.member_of));
    if (parent) return parent;
  }
  return entry;
}

// declare_as → inci → covers_inci → synonym. No slash splitting — used as the
// inner step so multilingual "Aqua/Water/Eau" segments do not recurse.
// Recognised CosIng names are intentionally NOT here — they run after every
// assessing lookup (including slash-segment consensus) has already missed.
function lookupCosmeticIngredientDirect(rawName) {
  const key = normalizeInci(rawName);
  if (!key) return null;
  const hit =
    cosmeticByDeclareAs.get(key) ||
    cosmeticByInci.get(key) ||
    cosmeticByCovers.get(key) ||
    cosmeticBySynonym.get(key) ||
    null;
  return resolveCosmeticEntry(hit);
}

function lookupRecognisedName(rawName) {
  const key = normalizeInci(rawName);
  if (!key) return null;
  const hit = cosingNamesMap.get(key);
  if (!hit) return null;
  return {
    inci: hit.name,
    recognised: true,
    assessed: false,
    risk: null,
    functions: Array.isArray(hit.fn) ? hit.fn.slice() : [],
    penalty: 0,
  };
}

function lookupCosmeticIngredient(rawName) {
  // Always try the whole name first — many legitimate INCIs contain slashes
  // (Caprylic/Capric Triglyceride, Flower/Leaf/Stem extracts, etc.).
  const whole = lookupCosmeticIngredientDirect(rawName);
  if (whole) return whole;

  const key = normalizeInci(rawName);
  if (key && key.includes('/')) {
    // Last resort for assessing: EU multilingual labels join aliases with "/".
    // Try each segment through the assessing lookup order; require unanimous
    // agreement if several hit.
    const segments = key.split('/').map(s => s.trim()).filter(s => s.length >= 3);
    const resolved = [];
    for (const segment of segments) {
      const hit = lookupCosmeticIngredientDirect(segment);
      if (hit) resolved.push(hit);
    }
    if (resolved.length > 0) {
      const firstKey = normalizeInci(resolved[0].inci);
      const ambiguous = resolved.some(entry => normalizeInci(entry.inci) !== firstKey);
      if (ambiguous) {
        console.log(`[SLASH AMBIGUOUS] name=${String(rawName || '').trim()}`);
        return null;
      }
      return resolved[0];
    }
  }

  // LAST: recognised-only CosIng name. Never shadows a hazard / synonym hit.
  return lookupRecognisedName(rawName);
}

function stripCosmeticAnnotations(fragment) {
  // Remove parenthetical notes except (nano), which is regulatory and must survive.
  return fragment
    .replace(/\((?!nano\b)[^)]*\)/gi, '')
    .replace(/^[*]+|[*]+$/g, '')
    .trim();
}

function tidyParsedIngredientName(name) {
  return String(name || '')
    .replace(/[.;]+\s*$/, '') // trailing period / semicolon
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingIngredientLabelPrefix(text) {
  // Only at the very start: "Ingredients:", "Ingrédients -", "INCI:", etc.
  return String(text || '').replace(
    /^\s*(?:ingredients|ingr[eé]dients|inci)\s*[:\-–—]?\s*/i,
    ''
  );
}

// When warning/marketing copy precedes the list, jump to the Ingredients:/INCI
// header so stripLeadingIngredientLabelPrefix can remove it. Require a colon or
// dash so "Ingredients Extract" mid-list is not treated as a section header.
function extractFromIngredientLabel(text) {
  const s = String(text || '');
  const re = /(?:^|[\n.;!?,]\s*|\s+)((?:ingredients|ingr[eé]dients|inci)\s*[:\-–—]\s*)/i;
  const m = s.match(re);
  if (!m || m.index == null) return s;
  // Start at the label itself (group 1), not the leading boundary punctuation.
  const labelOffset = m[0].lastIndexOf(m[1]);
  const labelStart = m.index + (labelOffset >= 0 ? labelOffset : 0);
  return s.slice(labelStart).trim();
}

// OTC Drug Facts / warning panels scraped into ingredients_text. Truncate at the
// first section marker (same idea as may-contain). Markers must start a segment
// so mid-sentence "uses" / "directions" / "caution" do not fire.
const DRUG_FACTS_MARKERS = [
  'drug facts',
  'warnings',
  'warning:',
  'directions',
  'uses:',
  'caution',
  'keep out of reach of children',
  'if swallowed',
  'stop use',
  'ask a doctor',
  'other information',
  'questions?',
];

function isDrugFactsSegmentStart(text, index) {
  if (index <= 0) return true;
  let i = index - 1;
  while (i >= 0 && /[ \t\r]/.test(text[i])) i--;
  if (i < 0) return true;
  return /[\n.;!?]/.test(text[i]);
}

function truncateDrugFactsAndWarnings(text) {
  const s = String(text || '');
  if (!s) return { text: '', marker: null };

  const lower = s.toLowerCase();
  let bestIdx = -1;
  let bestMarker = null;

  for (const marker of DRUG_FACTS_MARKERS) {
    const needle = marker.toLowerCase();
    let from = 0;
    while (from <= lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) break;
      if (isDrugFactsSegmentStart(s, idx)) {
        // Prefer the earliest marker in the string.
        if (bestIdx < 0 || idx < bestIdx) {
          bestIdx = idx;
          bestMarker = marker;
        }
        break;
      }
      from = idx + 1;
    }
  }

  if (bestIdx < 0) return { text: s.trim(), marker: null };
  return { text: s.slice(0, bestIdx).trim(), marker: bestMarker };
}

function splitMayContainSections(text) {
  // "May Contain (+/-): …" / "+/-" / "±" introduce conditional colorants.
  // Consume an optional (+/-) that immediately follows "may contain".
  const re = /\bmay\s+contain\b(?:\s*\(\s*\+\/\-\s*\))?|\(\s*\+\/\-\s*\)|\+\/\-|\±/i;
  const m = String(text || '').match(re);
  if (!m || m.index == null) {
    return { main: String(text || '').trim(), conditional: '' };
  }
  const main = text.slice(0, m.index).trim();
  const conditional = text
    .slice(m.index + m[0].length)
    .replace(/^[\s:\-–—]+/, '')
    .trim();
  return { main, conditional };
}

function splitCosmeticIngredientText(text) {
  // Split on bullets and on commas that are NOT between two digits and NOT
  // inside parentheses (botanical "Helianthus Annuus (Sunflower, Corn) Seed Oil").
  // Unbalanced "(" must not swallow the rest of the label: only suppress commas
  // when a closing ")" still lies ahead.
  const raw = String(text || '');
  const parts = [];
  let buf = '';
  let depth = 0;
  const bullet = /[•·●‣⁃∙⋅]/;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const prev = i > 0 ? raw[i - 1] : '';
    const next = i + 1 < raw.length ? raw[i + 1] : '';

    if (ch === '(') {
      depth += 1;
      buf += ch;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth -= 1;
      buf += ch;
      continue;
    }
    if (bullet.test(ch)) {
      if (buf.trim()) parts.push(buf);
      buf = '';
      // Bullets reset depth so a stray "(" cannot poison later segments.
      depth = 0;
      continue;
    }
    if (ch === ',') {
      const closingAhead = depth > 0 && raw.indexOf(')', i + 1) !== -1;
      if (closingAhead) {
        buf += ch;
        continue;
      }
      // Digit-locant: keep "1,2-Hexanediol" intact.
      if (/\d/.test(prev) && /\d/.test(next)) {
        buf += ch;
        continue;
      }
      if (buf.trim()) parts.push(buf);
      buf = '';
      depth = 0;
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

function cleanParsedIngredientFragment(fragment) {
  const cleaned = tidyParsedIngredientName(stripCosmeticAnnotations(fragment));
  return cleaned.length >= 3 ? cleaned : '';
}

// Packaging / address / URL / non-Latin junk scraped into ingredients_text.
// Conservative: a false positive silently drops a real ingredient from coverage.
function isUnparseableIngredientName(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  // a) no Latin letters at all (Arabic, CJK, digit-only noise)
  if (!/[A-Za-z]/.test(s)) return true;
  // b) longer than any legitimate hazard-table INCI (longest is 57 chars)
  if (s.length > 70) return true;
  // c) URL or email markers
  if (/http|www\.|\.com|@/i.test(s)) return true;
  // d) 4+ consecutive digits — barcodes/phones — unless CI colorant code
  if (/\d{4}/.test(s) && !/^CI\s/i.test(s)) return true;
  return false;
}

// Returns [{ name, mayContain, unparseable }]. mayContain and unparseable rows
// are kept in ingredientList for display but excluded from coverage, scoring,
// and the unmatchedInci tally.
//
// Prefer ingredients_text whenever it is present and usable. OFF's structured
// ingredients array is built by a food taxonomy and often splits botanical
// binomials ("cocos nucifera" / "oil"); the free-text path runs through
// splitCosmeticIngredientText which keeps those intact.
//
// Intentional: may-contain / +/- / ± splitting applies only to ingredients_text.
// The structured product.ingredients array fallback returns mayContain:false on
// every row — OFF/OBF parsed arrays are already tokenised and do not carry the
// free-text "May Contain (+/-):" marker, so marker-based splitting does not apply.
//
// Also returns { items, drugFactsMarker } so callers can log truncation.

// OFF/OBF often store ingredients_text as "." or other punctuation-only junk.
// Require at least 3 letters so those do not count as a real ingredient list.
function hasUsableIngredientText(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const letters = (t.match(/[A-Za-z\u00C0-\u024F]/g) || []).length;
  return letters >= 3;
}

function parseCosmeticIngredientList(product) {
  const parsed = [];

  const push = (cleaned, mayContain) => {
    if (!cleaned) return;
    // Lone "INGREDIENTS" / "INCI" tokens from OBF scrapes are not ingredients.
    if (/^(ingredients|ingr[eé]dients|inci)$/i.test(cleaned)) return;
    parsed.push({
      name: cleaned,
      mayContain: !!mayContain,
      unparseable: isUnparseableIngredientName(cleaned),
    });
  };

  // Prefer free-text when usable — structured array is a fallback only.
  const hasIngredientsText = hasUsableIngredientText(product.ingredients_text);
  if (hasIngredientsText) {
    // Prefer the Ingredients:/INCI: section when warning copy precedes it, then
    // drop Drug Facts / warning panels that follow the list.
    let text = extractFromIngredientLabel(product.ingredients_text || '');
    const truncated = truncateDrugFactsAndWarnings(text);
    text = stripLeadingIngredientLabelPrefix(truncated.text);
    const { main, conditional } = splitMayContainSections(text);

    for (const part of splitCosmeticIngredientText(main)) {
      push(cleanParsedIngredientFragment(part), false);
    }
    if (conditional) {
      for (const part of splitCosmeticIngredientText(conditional)) {
        push(cleanParsedIngredientFragment(part), true);
      }
    }

    return { items: parsed, drugFactsMarker: truncated.marker };
  }

  if (Array.isArray(product.ingredients) && product.ingredients.length > 0) {
    for (const item of product.ingredients) {
      const raw = (item.text || item.id || item.ingredient_id || '').toString();
      // OFF/OBF ids look like "en:aqua" — turn into displayable text when needed.
      const text = raw.startsWith('en:') ? raw.slice(3).replace(/-/g, ' ') : raw;
      push(cleanParsedIngredientFragment(text), false);
    }
    return { items: parsed, drugFactsMarker: null };
  }

  return { items: parsed, drugFactsMarker: null };
}

// True when lookup hit a real hazard-table entry (scorable). Recognised-only
// CosIng hits are NOT assessed — they must not block comma-split rejoins.
function isAssessedCosmeticHit(entry) {
  return !!(entry && !entry.recognised);
}

// Post-parse pass: some source labels insert commas inside a single INCI name
// ("SODIUM, COCOYL GLYCINATE", "DISODIUM, EDTA"). Merge adjacent pairs when
// neither half is ASSESSED and the joined name resolves (hazard table OR
// recognised-only CosIng). Only pairwise — no three-way joins.
function rejoinAdjacentUnmatchedFragments(items) {
  const result = [];
  let i = 0;
  while (i < items.length) {
    const a = items[i];
    const b = items[i + 1];
    if (
      b &&
      !a.unparseable &&
      !b.unparseable &&
      !!a.mayContain === !!b.mayContain &&
      !isAssessedCosmeticHit(lookupCosmeticIngredient(a.name)) &&
      !isAssessedCosmeticHit(lookupCosmeticIngredient(b.name))
    ) {
      const joinedName = `${a.name} ${b.name}`;
      // Any resolve counts — including a recognised-only CosIng name.
      if (lookupCosmeticIngredient(joinedName)) {
        result.push({
          name: joinedName,
          mayContain: !!a.mayContain,
          unparseable: isUnparseableIngredientName(joinedName),
        });
        i += 2;
        continue;
      }
    }
    result.push(a);
    i += 1;
  }
  return result;
}

function isFragranceAllergen(entry) {
  return !!(entry && entry.declaration_threshold && typeof entry.declaration_threshold === 'object');
}

function isPureAnnexII(entry) {
  const annex = entry && entry.eu_annex;
  return Array.isArray(annex) && annex.length === 1 && annex[0] === 'II';
}

function cosmeticPenaltyForRisk(risk) {
  if (risk === 'high') return 25;
  if (risk === 'moderate') return 10;
  if (risk === 'low') return 3;
  return 0;
}

// Fixed copy for EPA/pesticide-style household cleaners. Never call the LLM.
const HOUSEHOLD_EXPLANATION =
  "This is a household cleaning product. Most of its ingredients aren't disclosed by law, so nobody can assess it — including us.";

// Detect EPA-registered / pesticide-labelled household products from raw
// ingredient text.
//
// Signals split into pesticide-EXCLUSIVE vs SHARED with US OTC Drug Facts
// (sunscreens, acne washes, fluoride toothpaste, antiperspirants). Those OTC
// labels routinely carry "Active ingredients", a %, and "Keep out of reach of
// children" — any two of which would misclassify them if counted alone.
// "INACTIVE ingredients" on OTC labels must NOT count as "other"/"inert".
//
// Fire only when: ≥1 exclusive signal AND ≥2 signals total.
function looksLikeHouseholdProduct(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;

  let exclusive = 0;
  let shared = 0;

  // ── Pesticide-exclusive ──────────────────────────────────────────────────
  // EPA registration / establishment number
  if (/\bEPA\s+Reg\.?\s*No\.?\b/i.test(raw) || /\bEPA\s+Est\.?\b/i.test(raw)) {
    exclusive += 1;
  }

  // "Other ingredients" or "inert ingredients" — NOT OTC "Inactive ingredients"
  if (/\b(?:other|inert)\s+ingredients?\b/i.test(raw)) {
    exclusive += 1;
  }

  // Hazards to humans / domestic animals (pesticide precautionary block)
  if (/\bhazards?\s+to\s+humans\b/i.test(raw) || /\bdomestic\s+animals\b/i.test(raw)) {
    exclusive += 1;
  }

  // ── Shared with US OTC Drug Facts ────────────────────────────────────────
  // Active ingredient(s) heading (\b prevents matching inside "Inactive")
  if (/\bactive\s+ingredients?\b/i.test(raw)) {
    shared += 1;
  }

  // Percentage figure attached to a named ingredient (e.g. "Ethanol 58.00%", "0.10%")
  if (/(?:[A-Za-z][A-Za-z0-9\s\-\/\.,()]{1,80}?\s+)?\d+(?:\.\d+)?\s*%/.test(raw)) {
    shared += 1;
  }

  // Keep out of reach of children
  if (/\bkeep\s+out\s+of\s+reach\s+of\s+children\b/i.test(raw)) {
    shared += 1;
  }

  const total = exclusive + shared;
  return exclusive >= 1 && total >= 2;
}

function buildHouseholdScanResponse({
  productName = 'Unknown Product',
  imageUrl = '',
  ingredients = '',
  extras = {},
} = {}) {
  return {
    productType: 'household',
    productName,
    additiveNames: null,
    additiveList: JSON.stringify([]),
    ingredients,
    nutriScore: null,
    novaGroup: null,
    additivesCount: null,
    isOrganic: null,
    protein: null,
    sugar: null,
    sodium: null,
    sugarTier: null,
    sodiumTier: null,
    proteinTier: null,
    score: null,
    scoreBreakdown: JSON.stringify({
      start: 100,
      penalties: [],
      categoryCaps: { high: 0, moderate: 0, low: 0 },
      allergenPenalty: 0,
      allergenCapApplied: false,
      annexIICapApplied: false,
      rawScore: null,
      finalScore: null,
      coverageMatched: 0,
      coverageTotal: 0,
      assessedCount: 0,
      recognisedCount: 0,
      totalCount: 0,
      coverage: 0,
    }),
    alternatives: JSON.stringify([]),
    explanation: HOUSEHOLD_EXPLANATION,
    scoreColor: '#9E9E9E',
    imageUrl,
    scoreLabel: 'Not enough data',
    coverageMatched: 0,
    coverageTotal: 0,
    assessedCount: 0,
    recognisedCount: 0,
    totalCount: 0,
    noIngredientData: false,
    ingredientFindings: JSON.stringify([]),
    ingredientList: JSON.stringify([]),
    tableVersion: COSMETIC_TABLE_VERSION,
    scanLogicVersion: SCAN_LOGIC_VERSION,
    ...extras,
  };
}

// Fixed copy when a food label is photographed — ingredients alone cannot score food.
const FOOD_PHOTO_EXPLANATION =
  "We read the ingredients from your photo, but we can't score a food product from its label alone — we need nutrition information too.";

function buildFoodPhotoScanResponse({
  productName = 'Scanned label',
  imageUrl = '',
  ingredients = '',
  extras = {},
} = {}) {
  return {
    productType: 'food',
    productName,
    additiveNames: null,
    additiveList: JSON.stringify([]),
    ingredients,
    nutriScore: null,
    novaGroup: null,
    additivesCount: null,
    isOrganic: null,
    protein: null,
    sugar: null,
    sodium: null,
    sugarTier: null,
    sodiumTier: null,
    proteinTier: null,
    score: null,
    scoreBreakdown: JSON.stringify({}),
    alternatives: JSON.stringify([]),
    explanation: FOOD_PHOTO_EXPLANATION,
    scoreColor: '#9E9E9E',
    imageUrl,
    scoreLabel: 'Not enough data',
    coverageMatched: 0,
    coverageTotal: 0,
    assessedCount: 0,
    recognisedCount: 0,
    totalCount: 0,
    noIngredientData: false,
    ingredientFindings: JSON.stringify([]),
    ingredientList: JSON.stringify([]),
    tableVersion: COSMETIC_TABLE_VERSION,
    scanLogicVersion: SCAN_LOGIC_VERSION,
    ...extras,
  };
}

function scoreCosmeticProduct(product) {
  const { items: rawParsedItems, drugFactsMarker } = parseCosmeticIngredientList(product);
  // Rejoin comma-split INCI fragments before coverage is counted.
  const parsedItems = rejoinAdjacentUnmatchedFragments(rawParsedItems);
  // may-contain / +/- and unparseable packaging junk are listed for display
  // but do not inflate coverage or participate in scoring.
  const coverageItems = parsedItems.filter(item => !item.mayContain && !item.unparseable);
  const coverageTotal = coverageItems.length;
  const unparseableCount = parsedItems.filter(item => item.unparseable).length;

  const findings = [];
  const ingredientList = [];
  const scoredEntries = []; // unique parents that contribute to the score
  const seenInci = new Set();
  // INCI names that did not hit the hazard table — used for table-gap logging.
  // Recognised-only names are included (flagged) so the research signal stays alive.
  // Unparseable rows are excluded so packaging junk does not pollute the tally.
  const unmatchedNames = [];
  const seenUnmatched = new Set();
  let recognisedCount = 0;

  parsedItems.forEach((item, index) => {
    const displayName = item.name;
    const mayContain = !!item.mayContain;
    const unparseable = !!item.unparseable;
    const position = index + 1;

    if (unparseable) {
      ingredientList.push({
        name: displayName,
        position,
        matched: false,
        inci: null,
        risk: null,
        riskType: null,
        reason: null,
        disputed: false,
        countsTowardScore: false,
        mayContain,
        unparseable: true,
        assessed: false,
        recognised: false,
      });
      return;
    }

    const entry = lookupCosmeticIngredient(displayName);

    if (mayContain) {
      const isRecognised = !!(entry && entry.recognised);
      ingredientList.push({
        name: displayName,
        position,
        matched: !!(entry && !isRecognised),
        inci: entry ? entry.inci : null,
        risk: entry && !isRecognised ? (entry.risk ?? null) : null,
        riskType: entry && !isRecognised ? (entry.risk_type || 'health') : null,
        reason: entry && !isRecognised ? (entry.reason || null) : null,
        disputed: entry && !isRecognised ? !!entry.disputed : false,
        countsTowardScore: false,
        mayContain: true,
        unparseable: false,
        assessed: !!(entry && !isRecognised),
        recognised: isRecognised,
        ...(isRecognised
          ? { functions: entry.functions || [], penalty: 0 }
          : {}),
      });
      return;
    }

    // Recognised-only: known name, no grade. Not assessed — does not enter
    // findings / coverage numerator / penalty sum. Still logged to unmatchedInci.
    if (entry && entry.recognised) {
      const missKey = normalizeInci(displayName);
      if (missKey && !seenUnmatched.has(missKey)) {
        seenUnmatched.add(missKey);
        unmatchedNames.push({ name: displayName, recognised: true });
      }
      recognisedCount++;
      ingredientList.push({
        name: displayName,
        position,
        matched: false,
        inci: entry.inci,
        recognised: true,
        assessed: false,
        risk: null,
        functions: entry.functions || [],
        penalty: 0,
        riskType: null,
        reason: null,
        disputed: false,
        countsTowardScore: false,
        mayContain: false,
        unparseable: false,
      });
      return;
    }

    if (!entry) {
      const missKey = normalizeInci(displayName);
      if (missKey && !seenUnmatched.has(missKey)) {
        seenUnmatched.add(missKey);
        unmatchedNames.push(displayName);
      }
      ingredientList.push({
        name: displayName,
        position,
        matched: false,
        inci: null,
        risk: null,
        riskType: null,
        reason: null,
        disputed: false,
        countsTowardScore: false,
        mayContain: false,
        unparseable: false,
        assessed: false,
        recognised: false,
      });
      return;
    }

    const finding = {
      inci: entry.inci,
      risk: entry.risk,
      riskType: entry.risk_type || 'health',
      reason: entry.reason || '',
      basis: entry.basis || [],
      doseDependent: !!entry.dose_dependent,
      disputed: !!entry.disputed,
      disputeNote: entry.dispute_note || null,
      position,
      assessed: true,
      recognised: false,
    };
    findings.push(finding);

    // Environmental entries count as matched for coverage but never penalize.
    // Duplicates of an already-scored INCI also do not contribute again.
    let countsTowardScore = false;
    if (entry.risk_type !== 'environmental') {
      const key = normalizeInci(entry.inci);
      if (!seenInci.has(key)) {
        seenInci.add(key);
        scoredEntries.push({ entry, finding });
        countsTowardScore = true;
      }
    }

    ingredientList.push({
      name: displayName,
      position,
      matched: true,
      inci: entry.inci,
      risk: entry.risk ?? null,
      riskType: entry.risk_type || 'health',
      reason: entry.reason || null,
      disputed: !!entry.disputed,
      countsTowardScore,
      mayContain: false,
      unparseable: false,
      assessed: true,
      recognised: false,
    });
  });

  // assessedCount is the coverage numerator — recognised-only names must NOT
  // inflate it. coverageTotal is every parsed coverage row (totalCount).
  const assessedCount = findings.length;
  const coverageMatched = assessedCount;
  const totalCount = coverageTotal;
  const coverage = coverageTotal > 0 ? assessedCount / totalCount : 0;

  if (coverageTotal === 0 || coverage < 0.40) {
    return {
      score: null,
      scoreLabel: 'Not enough data',
      scoreColor: '#9E9E9E',
      coverageMatched,
      coverageTotal,
      assessedCount,
      recognisedCount,
      totalCount,
      coverage,
      noIngredientData: coverageTotal === 0,
      unparseableCount,
      drugFactsMarker: drugFactsMarker || null,
      ingredientFindings: findings,
      ingredientList,
      unmatchedNames,
      scoreBreakdown: {
        start: 100,
        penalties: [],
        categoryCaps: { high: 0, moderate: 0, low: 0 },
        allergenPenalty: 0,
        allergenCapApplied: false,
        annexIICapApplied: false,
        rawScore: null,
        finalScore: null,
        coverageMatched,
        coverageTotal,
        assessedCount,
        recognisedCount,
        totalCount,
        coverage,
      },
    };
  }

  const RISK_CAPS = { high: 50, moderate: 30, low: 15 };
  const categoryTotals = { high: 0, moderate: 0, low: 0 };
  const penalties = [];
  let allergenPenalty = 0;
  const ALLERGEN_CAP = 15;
  let hasPureAnnexII = false;

  for (const { entry } of scoredEntries) {
    if (isPureAnnexII(entry)) hasPureAnnexII = true;

    let penalty = cosmeticPenaltyForRisk(entry.risk);
    if (penalty === 0) continue;

    const allergen = isFragranceAllergen(entry);
    // Halve dose-dependent penalties except for declared fragrance allergens —
    // their presence on the label already confirms they exceed the threshold.
    if (entry.dose_dependent && !allergen) {
      penalty = penalty / 2;
    }

    if (allergen) {
      allergenPenalty += penalty;
      penalties.push({
        inci: entry.inci,
        risk: entry.risk,
        penalty,
        allergen: true,
        doseDependent: !!entry.dose_dependent,
        halved: false,
      });
      continue;
    }

    const risk = entry.risk;
    if (risk === 'high' || risk === 'moderate' || risk === 'low') {
      const remaining = RISK_CAPS[risk] - categoryTotals[risk];
      const applied = Math.min(penalty, Math.max(0, remaining));
      categoryTotals[risk] += applied;
      penalties.push({
        inci: entry.inci,
        risk,
        penalty: applied,
        allergen: false,
        doseDependent: !!entry.dose_dependent,
        halved: !!(entry.dose_dependent && applied < cosmeticPenaltyForRisk(risk)),
        categoryCapped: applied < penalty,
      });
    }
  }

  const allergenCapApplied = allergenPenalty > ALLERGEN_CAP;
  const allergenApplied = Math.min(allergenPenalty, ALLERGEN_CAP);
  const categoryPenalty =
    categoryTotals.high + categoryTotals.moderate + categoryTotals.low;
  let rawScore = 100 - categoryPenalty - allergenApplied;
  let annexIICapApplied = false;
  if (hasPureAnnexII && rawScore > 20) {
    rawScore = 20;
    annexIICapApplied = true;
  }
  const finalScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  const scoreLabel =
    finalScore >= 75 ? 'Excellent' :
    finalScore >= 50 ? 'Good' :
    finalScore >= 25 ? 'Poor' : 'Bad';
  const scoreColor =
    finalScore >= 75 ? '#2E7D32' :
    finalScore >= 50 ? '#8BC34A' :
    finalScore >= 25 ? '#FF9800' : '#F44336';

  return {
    score: finalScore,
    scoreLabel,
    scoreColor,
    coverageMatched,
    coverageTotal,
    assessedCount,
    recognisedCount,
    totalCount,
    coverage,
    noIngredientData: false,
    unparseableCount,
    drugFactsMarker: drugFactsMarker || null,
    ingredientFindings: findings,
    ingredientList,
    unmatchedNames,
    scoreBreakdown: {
      start: 100,
      penalties,
      categoryCaps: { ...categoryTotals },
      allergenPenalty: allergenApplied,
      allergenPenaltyRaw: allergenPenalty,
      allergenCapApplied,
      annexIICapApplied,
      rawScore,
      finalScore,
      coverageMatched,
      coverageTotal,
      assessedCount,
      recognisedCount,
      totalCount,
      coverage,
    },
  };
}

function unmatchedNameLabel(item) {
  return typeof item === 'string' ? item : (item && item.name) || '';
}

function unmatchedNameRecognised(item) {
  return !!(item && typeof item === 'object' && item.recognised);
}

// Firestore docs are size-capped; keep full ingredientList in the HTTP
// response but store [] in productCache when the payload is too large.
const INGREDIENT_LIST_CACHE_MAX_BYTES = 200 * 1024;

function stringifyIngredientListForCache(ingredientList, barcode) {
  const full = JSON.stringify(ingredientList || []);
  const bytes = Buffer.byteLength(full, 'utf8');
  if (bytes > INGREDIENT_LIST_CACHE_MAX_BYTES) {
    console.log(`[INGREDIENT LIST CACHE SKIPPED] barcode=${barcode || 'none'} bytes=${bytes}`);
    return '[]';
  }
  return full;
}

// Firestore doc IDs cannot contain "/" and have a 1500-byte max; keep a
// comfortable headroom for multi-byte characters.
const UNMATCHED_INCI_DOC_ID_MAX = 700;

function unmatchedInciDocId(name) {
  return normalizeInci(name).replace(/\//g, '').slice(0, UNMATCHED_INCI_DOC_ID_MAX);
}

// Fire-and-forget tally of unmatched INCI names for table expansion.
// Recognised-only names are included with recognised: true so the research
// signal stays alive (tranche queue) without polluting the true miss queue.
// Never awaited on the request path; failures are swallowed.
function recordUnmatchedInci(barcode, unmatchedNames) {
  if (!unmatchedNames || unmatchedNames.length === 0) return;
  // Junk parses (e.g. mangled OCR) produce huge miss lists — skip those.
  if (unmatchedNames.length > 60) return;

  (async () => {
    try {
      const col = db.collection('unmatchedInci');
      for (const item of unmatchedNames) {
        const name = unmatchedNameLabel(item);
        const docId = unmatchedInciDocId(name);
        if (!docId) continue;
        const payload = {
          name,
          count: admin.firestore.FieldValue.increment(1),
          lastSeen: admin.firestore.FieldValue.serverTimestamp(),
          tableVersion: COSMETIC_TABLE_VERSION,
        };
        if (unmatchedNameRecognised(item)) payload.recognised = true;
        // Only record a real barcode — never a sentinel like "photo".
        if (barcode) payload.sampleBarcode = barcode;
        await col.doc(docId).set(payload, { merge: true });
      }
    } catch (err) {
      console.log(`[UNMATCHED INCI WRITE ERROR] barcode=${barcode || 'none'} ${err.message}`);
    }
  })();
}

// Append-only raw source log. Fire-and-forget; never blocks a scan.
// One document per observation (auto-ID). Never updated, never expired.
// Dedupe via rawLatest/{barcode} (doc-id read — no composite index).
function recordRawObservation({ barcode, productType, source, payload, tableVersion, photoCapturedBy }) {
  (async () => {
    let payloadStr;
    try {
      try {
        payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
      } catch (serErr) {
        console.log(`[RAW WRITE ERROR] barcode=${barcode || 'none'} serialize: ${serErr.message}`);
        recordFailedWrite({
          collection: 'rawObservations',
          barcode,
          payload: null,
          error: `serialize: ${serErr.message}`,
          capturedBy: photoCapturedBy,
        });
        return;
      }

      const bytes = Buffer.byteLength(payloadStr, 'utf8');
      if (bytes > RAW_PAYLOAD_MAX_BYTES) {
        console.log(`[RAW SKIPPED oversize] barcode=${barcode || 'none'} bytes=${bytes}`);
        return;
      }

      const payloadHash = crypto.createHash('sha256').update(payloadStr).digest('hex');
      let isNew = true;

      // Dedupe by single-doc read on rawLatest — no composite index required.
      // If the read fails, fail open and write the observation (duplicate > data loss).
      if (barcode) {
        try {
          const latestDoc = await db.collection(RAW_LATEST_COLLECTION).doc(String(barcode)).get();
          if (latestDoc.exists && latestDoc.data().payloadHash === payloadHash) {
            isNew = false;
          }
        } catch (dedupeErr) {
          console.log(`[RAW DEDUPE ERROR] barcode=${barcode} ${dedupeErr.message}`);
        }
      }

      if (!isNew) {
        const sourceLog = typeof source === 'object' && source ? JSON.stringify(source) : source;
        console.log(`[RAW] barcode=${barcode || 'none'} source=${sourceLog} bytes=${bytes} new=false`);
        return;
      }

      const doc = {
        barcode: barcode ? String(barcode) : null,
        productType,
        source,
        observedAt: admin.firestore.FieldValue.serverTimestamp(),
        payload: payloadStr,
        payloadHash,
        tableVersion: tableVersion == null ? null : tableVersion,
      };
      // Photo observations always record the verified uid (required auth).
      if (source === 'photo') {
        doc.photoCapturedBy = photoCapturedBy || null;
      }
      await db.collection(RAW_COLLECTION).add(doc);
      console.log(`[RAW] barcode=${barcode || 'none'} source=${typeof source === 'object' && source ? JSON.stringify(source) : source} bytes=${bytes} new=true`);

      if (barcode) {
        try {
          await db.collection(RAW_LATEST_COLLECTION).doc(String(barcode)).set({
            payloadHash,
            observedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (latestErr) {
          // Observation is already archived; latest pointer can lag without data loss.
          console.log(`[RAW LATEST WRITE ERROR] barcode=${barcode} ${latestErr.message}`);
        }
      }
    } catch (err) {
      console.log(`[RAW WRITE ERROR] barcode=${barcode || 'none'} ${err.message}`);
      recordFailedWrite({
        collection: 'rawObservations',
        barcode,
        payload: payloadStr || payload,
        error: err.message,
        capturedBy: photoCapturedBy,
      });
    }
  })();
}

const USDA_LOOKUP_TIMEOUT_MS = 4000; // abort USDA search; must not wait on OFF
const OFF_LOOKUP_TIMEOUT_MS = 3000;  // abort the parallel food OFF barcode fetch only

async function fetchProductFromFacts(baseUrl, barcode, timeoutMs) {
  const opts = {
    headers: { 'User-Agent': 'DontWorryFoodScanner/1.0 (contact: app developer)' },
  };
  // Timeout only when the caller asks (parallel food OFF). OBF stays unbounded.
  if (timeoutMs != null) {
    opts.signal = AbortSignal.timeout(timeoutMs);
  }
  const res = await fetch(`${baseUrl}/api/v2/product/${barcode}.json`, opts);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status === 0 || !data.product) return null;
  return data.product;
}

// USDA FoodData Central — queried in parallel with OFF, then merged field-by-field.
// Search is fuzzy and will happily return an unrelated branded food, so every
// hit MUST have a verified gtinUpc (leading zeros ignored). US records store
// UPC-A as 12 digits; our cache key is the padded EAN-13, so the search
// query strips that one leading zero. normalizeBarcode itself is unchanged.
const USDA_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const USDA_USER_AGENT = 'DontWorryFoodScanner/1.0 (contact: app developer)';
let usdaApiKeyMissingLogged = false;

function digitsOnly(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

function stripLeadingZeros(digits) {
  const d = digitsOnly(digits);
  const stripped = d.replace(/^0+/, '');
  return stripped;
}

function usdaGtinMatches(barcode, gtinUpc) {
  const a = stripLeadingZeros(barcode);
  const b = stripLeadingZeros(gtinUpc);
  // All-zero / empty after strip must never match a fuzzy search hit.
  if (!a || !b) return false;
  return a === b;
}

// Prefer the 12-digit UPC-A USDA actually indexes. Canonical 13-digit
// (0 + UPC-A) is tried second so a 13-digit stored GTIN can still hit.
function usdaGtinQueryCandidates(barcode) {
  const digits = digitsOnly(barcode);
  const candidates = [];
  const add = (q) => {
    if (q && !candidates.includes(q)) candidates.push(q);
  };
  if (digits.length === 13 && digits.charAt(0) === '0') {
    add(digits.slice(1));
    add(digits);
  } else {
    add(digits);
    if (digits.length === 12) add(`0${digits}`);
  }
  return candidates;
}

function usdaNutrientId(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.nutrientId != null) return Number(entry.nutrientId);
  if (entry.nutrient && entry.nutrient.id != null) return Number(entry.nutrient.id);
  return null;
}

function usdaNutrientAmount(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.value === 'number' && Number.isFinite(entry.value)) return entry.value;
  if (typeof entry.amount === 'number' && Number.isFinite(entry.amount)) return entry.amount;
  return null;
}

function usdaNutrientUnit(entry) {
  const raw = (entry && (entry.unitName || (entry.nutrient && entry.nutrient.unitName))) || '';
  return String(raw).trim().toUpperCase();
}

function usdaAmountToGrams(amount, unit) {
  if (amount == null) return null;
  if (unit === 'MG' || unit === 'MILLIGRAM') return amount / 1000;
  return amount;
}

function mapUsdaNutrientsToOff(food) {
  const nutriments = {};
  const list = (food && food.foodNutrients) || [];
  for (const entry of list) {
    const id = usdaNutrientId(entry);
    const amount = usdaNutrientAmount(entry);
    if (id == null || amount == null) continue;
    const unit = usdaNutrientUnit(entry);
    if (id === 1008) {
      // Energy, kcal per 100g (skip kJ sibling 1062).
      if (unit && unit !== 'KCAL' && unit !== 'KCALS') continue;
      nutriments['energy-kcal_100g'] = amount;
      nutriments['energy-kcal'] = amount;
    } else if (id === 1003) {
      nutriments.proteins_100g = amount;
      nutriments.proteins = amount;
    } else if (id === 2000 || id === 1063) {
      if (nutriments.sugars_100g == null || id === 2000) {
        nutriments.sugars_100g = amount;
        nutriments.sugars = amount;
      }
    } else if (id === 1093) {
      const grams = usdaAmountToGrams(amount, unit || 'MG');
      nutriments.sodium_100g = grams;
      nutriments.sodium = grams;
    } else if (id === 1258) {
      // Fatty acids, total saturated. Absent row ≠ 0 (Coca-Cola has no row;
      // a declared 0.0 must still be stored).
      const grams = usdaAmountToGrams(amount, unit || 'G');
      nutriments['saturated-fat_100g'] = grams;
      nutriments['saturated-fat'] = grams;
    } else if (id === 1079) {
      const grams = usdaAmountToGrams(amount, unit || 'G');
      nutriments.fiber_100g = grams;
      nutriments.fiber = grams;
    } else if (id === 1004) {
      const grams = usdaAmountToGrams(amount, unit || 'G');
      nutriments.fat_100g = grams;
      nutriments.fat = grams;
    } else if (id === 1005) {
      const grams = usdaAmountToGrams(amount, unit || 'G');
      nutriments.carbohydrates_100g = grams;
      nutriments.carbohydrates = grams;
    }
  }
  return nutriments;
}

function mapUsdaServingQuantity(food) {
  if (!food || food.servingSize == null) return null;
  const size = parseFloat(food.servingSize);
  if (!Number.isFinite(size) || size <= 0) return null;
  const unit = String(food.servingSizeUnit || '').trim().toLowerCase();
  if (unit === 'g' || unit === 'grm' || unit === 'gram' || unit === 'grams') return size;
  if (unit === 'ml' || unit === 'mlt' || unit === 'milliliter' || unit === 'millilitre') return size;
  return null;
}

function mapUsdaFoodToProduct(food, barcode) {
  if (!food) return null;
  const brandName = String(food.brandName || '').trim();
  const brandOwner = String(food.brandOwner || '').trim();
  const brands = [brandName, brandOwner].filter(Boolean).join(', ');
  const ingredientsText = String(food.ingredients || '').trim();
  return {
    code: String(barcode || ''),
    product_name: String(food.description || '').trim() || 'Unknown Product',
    brands,
    ingredients_text: ingredientsText,
    ingredients: [],
    additives_tags: [],
    labels_tags: [],
    allergens_tags: [],
    traces_tags: [],
    categories_tags: [],
    nutriments: mapUsdaNutrientsToOff(food),
    serving_quantity: mapUsdaServingQuantity(food),
    foodCategory: String(food.foodCategory || food.brandedFoodCategory || '').trim(),
    nutriscore_grade: null,
    nova_group: null,
    image_front_url: '',
    image_url: '',
    source: 'usda',
    fdcId: food.fdcId != null ? food.fdcId : null,
  };
}

function pickUsdaGtinMatch(foods, barcode) {
  const matches = (Array.isArray(foods) ? foods : []).filter(
    (food) => food && usdaGtinMatches(barcode, food.gtinUpc)
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const dateA = String(a.publishedDate || '');
    const dateB = String(b.publishedDate || '');
    if (dateA !== dateB) return dateB.localeCompare(dateA);
    return (Number(b.fdcId) || 0) - (Number(a.fdcId) || 0);
  });
  return matches[0];
}

async function usdaSearchBranded(query, apiKey) {
  const url = `${USDA_SEARCH_URL}?${new URLSearchParams({ api_key: apiKey }).toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USDA_USER_AGENT,
    },
    body: JSON.stringify({
      query,
      dataType: ['Branded'],
      pageSize: 25,
      pageNumber: 1,
    }),
    signal: AbortSignal.timeout(USDA_LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`USDA search HTTP ${res.status}`);
    err.statusCode = res.status;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data && data.foods) ? data.foods : [];
}

async function usdaLookup(barcode) {
  const apiKey = process.env.USDA_API_KEY;
  if (!apiKey) {
    if (!usdaApiKeyMissingLogged) {
      usdaApiKeyMissingLogged = true;
      console.log('[USDA SKIP] USDA_API_KEY is not set — Open Food Facts only');
    }
    return null;
  }
  // Exactly one USDA request per scan. Candidates[0] is the 12-digit UPC
  // USDA indexes; do not retry the 13-digit form.
  const query = usdaGtinQueryCandidates(barcode)[0];
  if (!query) return null;

  try {
    const foods = await usdaSearchBranded(query, apiKey);
    const match = pickUsdaGtinMatch(foods, barcode);
    if (match) {
      const product = mapUsdaFoodToProduct(match, barcode);
      console.log(
        `[USDA HIT] barcode=${barcode} fdcId=${product.fdcId} query=${query} gtin=${match.gtinUpc}`
      );
      return product;
    }
    console.log(`[USDA MISS] barcode=${barcode} query=${query} foods=${foods.length}`);
    return null;
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (timedOut) {
      console.log(`[USDA TIMEOUT] barcode=${barcode} query=${query}`);
      return null;
    }
    console.log(`[USDA LOOKUP] barcode=${barcode} query=${query} ${err.message}`);
    return null;
  }
}

function productHasIngredients(product) {
  if (!product) return false;
  if (Array.isArray(product.ingredients) && product.ingredients.length > 0) return true;
  return hasUsableIngredientText(product.ingredients_text);
}

function productHasNutriments(product) {
  const n = product && product.nutriments;
  return !!(n && typeof n === 'object' && Object.keys(n).length > 0);
}

// Presence = key exists with a finite numeric value (0 counts). Missing key or
// non-numeric value counts as absent. Used to refuse food scores when OFF has
// a non-empty nutriments object that still lacks anything scoreable (Dawn Ultra
// ships saturated-fat:0 + sugars:0 only — productHasNutriments is true).
function hasNumericNutriment(nutriments, keys) {
  if (!nutriments || typeof nutriments !== 'object') return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(nutriments, key)) continue;
    const v = nutriments[key];
    if (typeof v === 'number' && Number.isFinite(v)) return true;
  }
  return false;
}

const FOOD_ENERGY_NUTRIMENT_KEYS = [
  'energy-kcal_100g', 'energy-kcal',
  'energy_100g', 'energy',
  'energy-kj_100g', 'energy-kj',
];
const FOOD_PROTEIN_NUTRIMENT_KEYS = ['proteins_100g', 'proteins'];
const FOOD_SODIUM_SALT_NUTRIMENT_KEYS = [
  'sodium_100g', 'sodium',
  'salt_100g', 'salt',
];

// True when at least one of energy / proteins / sodium|salt is present.
function hasScorableFoodNutriments(nutriments) {
  return hasNumericNutriment(nutriments, FOOD_ENERGY_NUTRIMENT_KEYS)
    || hasNumericNutriment(nutriments, FOOD_PROTEIN_NUTRIMENT_KEYS)
    || hasNumericNutriment(nutriments, FOOD_SODIUM_SALT_NUTRIMENT_KEYS);
}

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

// Search candidates: classify from OFF category tags only (no upstream fetch).
// Household wins over cosmetic, matching resolveProductType. No tags → food.
function classifySearchProductType(categoriesTags) {
  const tags = Array.isArray(categoriesTags) ? categoriesTags : [];
  if (tags.some(tagIndicatesHousehold)) return 'household';
  if (tags.some(tagIndicatesCosmetic)) return 'cosmetic';
  return 'food';
}

function attachProductSource(product, source) {
  if (!product || typeof product !== 'object') return product;
  if (!product.source) product.source = source;
  return product;
}

// Non-empty for merge precedence: not null, undefined, empty string,
// whitespace-only, or empty array. Numeric 0 is valid.
function isMergeNonEmpty(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

function pickUsdaThenOff(usdaValue, offValue) {
  if (isMergeNonEmpty(usdaValue)) return { value: usdaValue, source: 'usda' };
  if (isMergeNonEmpty(offValue)) return { value: offValue, source: 'off' };
  return { value: isMergeNonEmpty(usdaValue) ? usdaValue : (offValue == null ? '' : offValue), source: null };
}

// OFF barcode endpoint only. After a valid product object, compare product.code
// to the scanned barcode via normalizeBarcode. Reject on mismatch.
function offProductMatchesScannedBarcode(product, barcode) {
  if (!product) return false;
  const rawCode = product.code;
  if (rawCode == null || String(rawCode).trim() === '') return true;
  const returned = normalizeBarcode(rawCode);
  const scanned = normalizeBarcode(barcode);
  if (!returned || !scanned) return false;
  return returned === scanned;
}

async function fetchOffFoodProduct(barcode) {
  const product = await fetchProductFromFacts(
    'https://world.openfoodfacts.org',
    barcode,
    OFF_LOOKUP_TIMEOUT_MS
  );
  if (!product) return null;
  if (!offProductMatchesScannedBarcode(product, barcode)) {
    console.log(`[OFF CODE MISMATCH] barcode=${barcode} product.code=${product.code}`);
    return null;
  }
  return attachProductSource(product, 'off');
}

function mergeNutrimentMaps(usdaNutriments, offNutriments) {
  const usda = usdaNutriments && typeof usdaNutriments === 'object' ? usdaNutriments : {};
  const off = offNutriments && typeof offNutriments === 'object' ? offNutriments : {};
  const merged = {};
  let usedUsda = false;
  let usedOff = false;
  const keys = new Set([...Object.keys(off), ...Object.keys(usda)]);
  for (const key of keys) {
    if (isMergeNonEmpty(usda[key])) {
      merged[key] = usda[key];
      usedUsda = true;
    } else if (isMergeNonEmpty(off[key])) {
      merged[key] = off[key];
      usedOff = true;
    }
  }
  return { nutriments: merged, source: usedUsda ? 'usda' : (usedOff ? 'off' : null) };
}

// Merge USDA identity/nutrition with OFF additives / allergens / Nutri-Score / NOVA.
// Never object-spread. USDA ingredients_text is DISPLAY ONLY — scoring still reads
// nutriments (proteins/sugars/sodium/energy), nutriscore_grade, nova_group,
// extractAdditiveCodes(additives_tags + ingredients[].id), and labels_tags.
// Do not parse USDA ingredient strings for additives or allergens.
function mergeUsdaAndOffProducts(barcode, usdaProduct, offProduct) {
  if (usdaProduct && !offProduct) return usdaProduct;
  if (!usdaProduct && offProduct) return offProduct;
  if (!usdaProduct && !offProduct) return null;

  const namePick = pickUsdaThenOff(usdaProduct.product_name, offProduct.product_name);
  const brandPick = pickUsdaThenOff(usdaProduct.brands, offProduct.brands);
  const ingPick = pickUsdaThenOff(usdaProduct.ingredients_text, offProduct.ingredients_text);
  const nutriPick = mergeNutrimentMaps(usdaProduct.nutriments, offProduct.nutriments);
  const servingPick = pickUsdaThenOff(usdaProduct.serving_quantity, offProduct.serving_quantity);

  const merged = {
    code: String(barcode || ''),
    product_name: namePick.value || 'Unknown Product',
    brands: brandPick.value || '',
    ingredients_text: ingPick.value || '',
    ingredients: Array.isArray(offProduct.ingredients) ? offProduct.ingredients : [],
    additives_tags: Array.isArray(offProduct.additives_tags) ? offProduct.additives_tags : [],
    labels_tags: Array.isArray(offProduct.labels_tags) ? offProduct.labels_tags : [],
    allergens: offProduct.allergens,
    allergens_tags: Array.isArray(offProduct.allergens_tags) ? offProduct.allergens_tags : [],
    allergens_from_ingredients: offProduct.allergens_from_ingredients,
    traces: offProduct.traces,
    traces_tags: Array.isArray(offProduct.traces_tags) ? offProduct.traces_tags : [],
    categories_tags: Array.isArray(offProduct.categories_tags) ? offProduct.categories_tags : [],
    nutriments: nutriPick.nutriments,
    serving_quantity: servingPick.source ? servingPick.value : (usdaProduct.serving_quantity != null ? usdaProduct.serving_quantity : offProduct.serving_quantity),
    foodCategory: usdaProduct.foodCategory || '',
    nutriscore_grade: offProduct.nutriscore_grade == null ? null : offProduct.nutriscore_grade,
    nutriscore_score: offProduct.nutriscore_score,
    nutrition_grade_fr: offProduct.nutrition_grade_fr,
    nutrition_grades: offProduct.nutrition_grades,
    nova_group: offProduct.nova_group == null ? null : offProduct.nova_group,
    selected_images: offProduct.selected_images,
    image_front_url: offProduct.image_front_url || '',
    image_url: offProduct.image_url || '',
    image_front_small_url: offProduct.image_front_small_url,
    image_front_thumb_url: offProduct.image_front_thumb_url,
    source: 'usda',
    fdcId: usdaProduct.fdcId != null ? usdaProduct.fdcId : null,
  };

  const provenance = {
    name: namePick.source,
    brand: brandPick.source,
    ingredients: ingPick.source,
    nutrition: nutriPick.source,
    additives: 'off',
    allergens: 'off',
    nutriscore: 'off',
    nova: 'off',
    image: 'off',
  };
  console.log(
    `[LOOKUP FIELDS] barcode=${barcode} name=${provenance.name} brand=${provenance.brand} ingredients=${provenance.ingredients} nutrition=${provenance.nutrition} additives=${provenance.additives} allergens=${provenance.allergens} nutriscore=${provenance.nutriscore} nova=${provenance.nova} image=${provenance.image}`
  );
  return merged;
}

function lookupOutcome(settled, msFallback) {
  if (!settled) return { product: null, ms: msFallback, error: null, timedOut: false };
  if (settled.status === 'fulfilled') {
    const value = settled.value || {};
    return {
      product: value.product || null,
      ms: value.ms != null ? value.ms : msFallback,
      error: null,
      timedOut: false,
    };
  }
  const err = settled.reason;
  const timedOut = !!(err && (err.name === 'TimeoutError' || err.name === 'AbortError'));
  return { product: null, ms: msFallback, error: err, timedOut };
}

async function resolveProductType(barcode) {
  // Classify by category (and OBF), not merely by which database answered first.
  // Toothpaste/soap/etc. often exist in OFF with ingredients and would otherwise
  // be scored as food. Dish soap / laundry detergent categories must win before
  // the food default (looksLikeHouseholdProduct only covers EPA pesticide labels).
  let foodProduct = null;
  let cosmeticProduct = null;

  // USDA (4s abort) and OFF barcode (3s abort) in parallel. Timeouts must
  // abort the request; allSettled only collects. Provider wait ≤ 4s.
  const lookupStarted = Date.now();
  const usdaStarted = Date.now();
  const usdaPromise = usdaLookup(barcode).then((product) => ({
    product,
    ms: Date.now() - usdaStarted,
  }));
  const offStarted = Date.now();
  const offPromise = fetchOffFoodProduct(barcode).then((product) => ({
    product,
    ms: Date.now() - offStarted,
  }));
  const [usdaSettled, offSettled] = await Promise.allSettled([usdaPromise, offPromise]);
  const totalMs = Date.now() - lookupStarted;
  const usdaOut = lookupOutcome(usdaSettled, Date.now() - usdaStarted);
  const offOut = lookupOutcome(offSettled, Date.now() - offStarted);
  const usdaProduct = usdaOut.product;
  const offFetched = offOut.product;

  if (usdaOut.error) {
    console.log(`[USDA LOOKUP] barcode=${barcode} ${usdaOut.error.message}`);
  }
  if (offOut.error) {
    console.log(`[OFF FETCH ERROR] barcode=${barcode} ${offOut.error.message}`);
  }
  console.log(
    `[LOOKUP MERGE] barcode=${barcode} usda=${usdaProduct ? 'hit' : (usdaOut.timedOut ? 'timeout' : (usdaOut.error ? 'error' : 'miss'))} off=${offFetched ? 'hit' : (offOut.timedOut ? 'timeout' : (offOut.error ? 'error' : 'miss'))} usdaMs=${usdaOut.ms} offMs=${offOut.ms} totalMs=${totalMs}`
  );

  foodProduct = offFetched;

  if (!foodProduct) {
    // USDA hit + OFF miss → USDA only. Do not walk OBF when USDA already matched.
    if (usdaProduct) {
      console.log(
        `[LOOKUP FIELDS] barcode=${barcode} name=usda brand=usda ingredients=usda nutrition=usda additives=none allergens=none nutriscore=none nova=none image=none`
      );
      console.log(`[PRODUCT TYPE] barcode=${barcode} type=food reason=usda`);
      return { productType: 'food', product: usdaProduct };
    }
    try {
      cosmeticProduct = attachProductSource(
        await fetchProductFromFacts('https://world.openbeautyfacts.org', barcode),
        'obf'
      );
    } catch (err) {
      console.log(`[OBF FETCH ERROR] barcode=${barcode} ${err.message}`);
    }
    if (cosmeticProduct) {
      console.log(`[PRODUCT TYPE] barcode=${barcode} type=cosmetic reason=obf_only`);
      return { productType: 'cosmetic', product: cosmeticProduct };
    }
    console.log(`[PRODUCT TYPE] barcode=${barcode} type=null reason=not_found`);
    return { productType: null, product: null };
  }

  // Household cleaning categories beat food and cosmetic (Dawn Ultra etc.).
  // Do not overlay USDA food data onto a household OFF record.
  if (hasHouseholdCategory(foodProduct)) {
    console.log(`[PRODUCT TYPE] barcode=${barcode} type=household reason=category_off`);
    return { productType: 'household', product: foodProduct };
  }

  const offCosmeticCategory = hasCosmeticCategory(foodProduct);
  const offHasIngredients = productHasIngredients(foodProduct);
  const offHasNutriments = productHasNutriments(foodProduct);

  // Category says beauty/hygiene (optionally reinforced by missing nutriments).
  if (offCosmeticCategory) {
    try {
      cosmeticProduct = attachProductSource(
        await fetchProductFromFacts('https://world.openbeautyfacts.org', barcode),
        'obf'
      );
    } catch (err) {
      console.log(`[OBF FETCH ERROR] barcode=${barcode} ${err.message}`);
    }
    if (cosmeticProduct && productHasIngredients(cosmeticProduct)) {
      const reason = !offHasNutriments
        ? 'category_no_nutriments_obf_ingredients'
        : 'category_obf_ingredients';
      console.log(`[PRODUCT TYPE] barcode=${barcode} type=cosmetic reason=${reason}`);
      return { productType: 'cosmetic', product: cosmeticProduct };
    }
    // Prefer OBF when present even without ingredients; else score OFF via cosmetic path.
    if (cosmeticProduct) {
      console.log(`[PRODUCT TYPE] barcode=${barcode} type=cosmetic reason=category_obf_record`);
      return { productType: 'cosmetic', product: cosmeticProduct };
    }
    console.log(`[PRODUCT TYPE] barcode=${barcode} type=cosmetic reason=category_off_as_cosmetic`);
    return { productType: 'cosmetic', product: foodProduct };
  }

  // OFF has no ingredients — try OBF (genuine beauty product missing from OFF text).
  if (!offHasIngredients) {
    try {
      cosmeticProduct = attachProductSource(
        await fetchProductFromFacts('https://world.openbeautyfacts.org', barcode),
        'obf'
      );
    } catch (err) {
      console.log(`[OBF FETCH ERROR] barcode=${barcode} ${err.message}`);
    }
    if (cosmeticProduct && productHasIngredients(cosmeticProduct)) {
      console.log(`[PRODUCT TYPE] barcode=${barcode} type=cosmetic reason=off_empty_obf_ingredients`);
      return { productType: 'cosmetic', product: cosmeticProduct };
    }
    if (cosmeticProduct) {
      console.log(`[PRODUCT TYPE] barcode=${barcode} type=cosmetic reason=off_empty_obf_hit`);
      return { productType: 'cosmetic', product: cosmeticProduct };
    }
  }

  // USDA miss + OFF food hit → OFF only, unchanged. Both hits → merge.
  if (!usdaProduct) {
    console.log(
      `[LOOKUP FIELDS] barcode=${barcode} name=off brand=off ingredients=off nutrition=off additives=off allergens=off nutriscore=off nova=off image=off`
    );
    console.log(`[PRODUCT TYPE] barcode=${barcode} type=food reason=default_off_ambiguous`);
    return { productType: 'food', product: foodProduct };
  }
  const merged = mergeUsdaAndOffProducts(barcode, usdaProduct, foodProduct);
  console.log(`[PRODUCT TYPE] barcode=${barcode} type=food reason=usda_off_merge`);
  return { productType: 'food', product: merged };
}

function calculateScore(nutriScore, novaGroup, additivesCount, isOrganic, protein, sugar, sodium, additiveList, barcode, nutriments, foodCategory) {
  // 60% Purla nutrition subscore from per-100g nutrients (not OFF Nutri-Score).
  const nutrition = computeNutritionSubscore(nutriments, foodCategory);
  if (!nutrition.available && barcode != null) {
    console.log(`[NUTRITION SUBSCORE UNAVAILABLE] barcode=${barcode} reason=${nutrition.reason || 'missing_unfavourable'}`);
  }

  // 30% Additives — risk-weighted, not count-based
  let additivePts = 30;
  if (additiveList && additiveList.length > 0) {
    const hasHigh = additiveList.some(a => a.riskLevel === 'high');
    const hasLimited = additiveList.some(a => a.riskLevel === 'limited');
    if (hasHigh) additivePts = 5;
    else if (hasLimited) additivePts = 15;
    else additivePts = 25; // all safe
  }

  // 10% Organic — only a confirmed organic label earns points
  const organicPts = isOrganic ? 10 : 0;

  if (!nutrition.available) return null;
  return Math.max(0, Math.min(100, Math.round(nutrition.points + additivePts + organicPts)));
}

function getScoreBreakdown(nutriScore, novaGroup, additivesCount, isOrganic, protein, sugar, sodium, additiveList, nutriments, foodCategory) {
  const nutrition = computeNutritionSubscore(nutriments, foodCategory);

  let additivePts = 30;
  let additiveRisk = 'none';
  if (additiveList && additiveList.length > 0) {
    const hasHigh = additiveList.some(a => a.riskLevel === 'high');
    const hasLimited = additiveList.some(a => a.riskLevel === 'limited');
    if (hasHigh) { additivePts = 5; additiveRisk = 'high'; }
    else if (hasLimited) { additivePts = 15; additiveRisk = 'limited'; }
    else { additivePts = 25; additiveRisk = 'safe'; }
  }

  const organicPts = isOrganic ? 10 : 0;

  return {
    nutriScoreGrade: (nutriScore || 'unknown').toUpperCase(),
    nutriScoreKnown: !!nutriScore,
    nutriPts: nutrition.available ? nutrition.points : null,
    nutriMax: 60,
    nutritionAvailable: nutrition.available,
    nutritionPath: nutrition.path,
    nutritionReason: nutrition.available ? null : (nutrition.reason || 'missing_unfavourable'),
    proteinSuppressed: !!nutrition.proteinSuppressed,
    nutritionComponents: nutrition.components || null,
    additivesCount: additiveList ? additiveList.length : 0,
    additiveRisk,
    additivePts, additiveMax: 30,
    isOrganic: !!isOrganic,
    organicPts, organicMax: 10,
  };
}

// Published Nutri-Score 2023 per-100g cut points (Santé publique France /
// Open Food Facts Nutriscore.pm). Mapped onto Purla's 60-point allocation;
// thresholds are not tuned.
const NS2023_THRESHOLDS = {
  energy: [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350],
  energy_beverages: [30, 90, 150, 210, 240, 270, 300, 330, 360, 390],
  sugars: [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51],
  sugars_beverages: [0.5, 2, 3.5, 5, 6, 7, 8, 9, 10, 11],
  saturated_fat: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  salt: [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4],
  energy_from_saturated_fat: [120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200],
  saturated_fat_ratio: [10, 16, 22, 28, 34, 40, 46, 52, 58, 64],
  fiber: [3.0, 4.1, 5.2, 6.3, 7.4],
  proteins: [2.4, 4.8, 7.2, 9.6, 12, 14, 17],
  proteins_beverages: [1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0],
};

const KJ_PER_KCAL = 4.184;
const SALT_PER_SODIUM = 2.5;
const SAT_FAT_KJ_PER_G = 37;

// Exact USDA branded foodCategory strings observed in the coverage sample.
// No substring matching — anything else is general food.
const PURLA_BEVERAGE_FOOD_CATEGORIES = new Set([
  'Soda',
  'Water',
  'Plant Based Water',
  'Iced & Bottle Tea',
  'Fruit & Vegetable Juice, Nectars & Fruit Drinks',
  'Other Drinks',
  'Sport Drinks',
  'Non Alcoholic Beverages - Ready to Drink',
  'Non Alcoholic Beverages  Ready to Drink',
  'Plant Based Milk',
  'Milk',
  'Milk/Milk Substitutes',
]);

const PURLA_ADDED_FATS_FOOD_CATEGORIES = new Set([
  'Vegetable & Cooking Oils',
]);

const FOOD_SUGAR_NUTRIMENT_KEYS = ['sugars_100g', 'sugars'];
const FOOD_SAT_FAT_NUTRIMENT_KEYS = ['saturated-fat_100g', 'saturated-fat'];
const FOOD_FIBER_NUTRIMENT_KEYS = ['fiber_100g', 'fiber'];
const FOOD_FAT_NUTRIMENT_KEYS = ['fat_100g', 'fat'];
const FOOD_CARB_NUTRIMENT_KEYS = ['carbohydrates_100g', 'carbohydrates'];

function classifyPurlaFoodPath(foodCategory) {
  const cat = String(foodCategory == null ? '' : foodCategory);
  if (PURLA_BEVERAGE_FOOD_CATEGORIES.has(cat)) return 'beverages';
  if (PURLA_ADDED_FATS_FOOD_CATEGORIES.has(cat)) return 'added_fats';
  return 'general';
}

function getNumericNutrimentValue(nutriments, keys) {
  if (!nutriments || typeof nutriments !== 'object') return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(nutriments, key)) continue;
    const v = nutriments[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function nsThresholdPoints(value, thresholds, { gte = false } = {}) {
  if (value == null || !Number.isFinite(value) || !Array.isArray(thresholds)) return null;
  let pts = 0;
  for (const t of thresholds) {
    if (gte ? value >= t : value > t) pts += 1;
  }
  return pts;
}

function mapNsPointsToPurla(nsPoints, nsMax, purlaMax, invert) {
  if (nsMax <= 0) return 0;
  const frac = Math.max(0, Math.min(1, nsPoints / nsMax));
  return invert ? purlaMax * (1 - frac) : purlaMax * frac;
}

// Arithmetic identities only — not assumptions about unreported nutrients.
function applyDerivedNutrientZeros(nutriments) {
  const src = nutriments && typeof nutriments === 'object' ? nutriments : {};
  const out = Object.assign({}, src);
  const fat = getNumericNutrimentValue(src, FOOD_FAT_NUTRIMENT_KEYS);
  const sat = getNumericNutrimentValue(src, FOOD_SAT_FAT_NUTRIMENT_KEYS);
  const carbs = getNumericNutrimentValue(src, FOOD_CARB_NUTRIMENT_KEYS);
  const sugars = getNumericNutrimentValue(src, FOOD_SUGAR_NUTRIMENT_KEYS);
  const fiber = getNumericNutrimentValue(src, FOOD_FIBER_NUTRIMENT_KEYS);
  if (sat == null && fat === 0) {
    out['saturated-fat_100g'] = 0;
    out['saturated-fat'] = 0;
  }
  if (sugars == null && carbs === 0) {
    out.sugars_100g = 0;
    out.sugars = 0;
  }
  if (fiber == null && carbs === 0) {
    out.fiber_100g = 0;
    out.fiber = 0;
  }
  return out;
}

function computeNutritionSubscore(nutriments, foodCategory) {
  const path = classifyPurlaFoodPath(foodCategory);
  const derived = applyDerivedNutrientZeros(nutriments);

  const energyKcal = getNumericNutrimentValue(derived, ['energy-kcal_100g', 'energy-kcal']);
  const sugars = getNumericNutrimentValue(derived, FOOD_SUGAR_NUTRIMENT_KEYS);
  const satFat = getNumericNutrimentValue(derived, FOOD_SAT_FAT_NUTRIMENT_KEYS);
  const sodiumG = getNumericNutrimentValue(derived, ['sodium_100g', 'sodium']);
  const fiber = getNumericNutrimentValue(derived, FOOD_FIBER_NUTRIMENT_KEYS);
  const protein = getNumericNutrimentValue(derived, ['proteins_100g', 'proteins']);
  const fat = getNumericNutrimentValue(derived, FOOD_FAT_NUTRIMENT_KEYS);

  const unavailable = (reason) => ({
    available: false,
    points: null,
    path,
    reason,
    proteinSuppressed: false,
    components: null,
  });

  if (energyKcal == null) return unavailable('missing_energy');
  if (sugars == null) return unavailable('missing_sugars');
  if (path === 'added_fats' && fat == null) return unavailable('missing_total_fat');
  if (satFat == null) return unavailable('missing_saturated_fat');
  if (sodiumG == null) return unavailable('missing_sodium');

  const energyKj = energyKcal * KJ_PER_KCAL;
  const saltG = sodiumG * SALT_PER_SODIUM;

  const sugarsTable = path === 'beverages' ? NS2023_THRESHOLDS.sugars_beverages : NS2023_THRESHOLDS.sugars;
  const energyTable = path === 'beverages' ? NS2023_THRESHOLDS.energy_beverages : NS2023_THRESHOLDS.energy;
  const proteinTable = path === 'beverages' ? NS2023_THRESHOLDS.proteins_beverages : NS2023_THRESHOLDS.proteins;

  const sugarsNs = nsThresholdPoints(sugars, sugarsTable);
  const saltNs = nsThresholdPoints(saltG, NS2023_THRESHOLDS.salt);
  const fiberNs = fiber == null ? 0 : nsThresholdPoints(fiber, NS2023_THRESHOLDS.fiber);
  const proteinNs = protein == null ? 0 : nsThresholdPoints(protein, proteinTable);

  let energyPts;
  let satPts;
  let fatQualityPts = null;
  let energyNs;
  let satNs;
  let ratioNs = null;
  let energyFromSatNs = null;
  let nPoints;

  if (path === 'added_fats') {
    const ratioPct = fat === 0 ? 0 : (100 * satFat / fat);
    if (!Number.isFinite(ratioPct)) return unavailable('missing_saturated_fat');
    ratioNs = nsThresholdPoints(ratioPct, NS2023_THRESHOLDS.saturated_fat_ratio, { gte: true });
    fatQualityPts = mapNsPointsToPurla(ratioNs, NS2023_THRESHOLDS.saturated_fat_ratio.length, 20, true);
    energyPts = 0;
    satPts = 0;
    energyFromSatNs = nsThresholdPoints(satFat * SAT_FAT_KJ_PER_G, NS2023_THRESHOLDS.energy_from_saturated_fat);
    nPoints = energyFromSatNs + sugarsNs + ratioNs + saltNs;
  } else {
    energyNs = nsThresholdPoints(energyKj, energyTable);
    satNs = nsThresholdPoints(satFat, NS2023_THRESHOLDS.saturated_fat);
    energyPts = mapNsPointsToPurla(energyNs, energyTable.length, 10, true);
    satPts = mapNsPointsToPurla(satNs, NS2023_THRESHOLDS.saturated_fat.length, 10, true);
    nPoints = energyNs + sugarsNs + satNs + saltNs;
  }

  const sugarsPts = mapNsPointsToPurla(sugarsNs, sugarsTable.length, 10, true);
  const sodiumPts = mapNsPointsToPurla(saltNs, NS2023_THRESHOLDS.salt.length, 10, true);
  const fibrePts = fiber == null ? 0 : mapNsPointsToPurla(fiberNs, NS2023_THRESHOLDS.fiber.length, 12, false);

  let proteinSuppressed = false;
  if (path === 'general' && nPoints >= 11) proteinSuppressed = true;
  if (path === 'added_fats' && nPoints >= 7) proteinSuppressed = true;
  // Beverages: Nutri-Score 2023 always counts protein. No sweetener parser.

  const proteinPts = proteinSuppressed || protein == null
    ? 0
    : mapNsPointsToPurla(proteinNs, proteinTable.length, 8, false);

  const raw = path === 'added_fats'
    ? fatQualityPts + sugarsPts + sodiumPts + fibrePts + proteinPts
    : energyPts + sugarsPts + satPts + sodiumPts + fibrePts + proteinPts;
  const points = Math.max(0, Math.min(60, Math.round(raw)));

  return {
    available: true,
    points,
    path,
    reason: null,
    proteinSuppressed,
    nPoints,
    components: {
      energy: path === 'added_fats' ? 0 : energyPts,
      sugars: sugarsPts,
      saturatedFat: path === 'added_fats' ? 0 : satPts,
      fatQuality: path === 'added_fats' ? fatQualityPts : null,
      sodium: sodiumPts,
      fibre: fibrePts,
      protein: proteinPts,
    },
  };
}

// OFF labels_tags is crowd-entered and often absent. Empty/missing is
// "unknown", not "not organic". Never infer from the product name.
function resolveOrganicStatus(labelsTags) {
  if (!Array.isArray(labelsTags) || labelsTags.length === 0) return 'unknown';
  if (labelsTags.includes('en:organic')) return 'yes';
  return 'no';
}

// Display-cased values for the Organic row — shipped app builds render this
// string directly. Keep internal status lowercase; only responses use this.
function formatOrganicDisplay(status) {
  if (status === 'yes') return 'Yes';
  if (status === 'no') return 'No';
  return 'Unknown';
}

function normalizeOrganicStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'yes') return 'yes';
  if (v === 'no') return 'no';
  if (v === 'unknown') return 'unknown';
  return 'unknown';
}

function parseServingQuantity(raw) {
  if (raw == null || raw === '') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function hasServingNutrientData(nutriments) {
  if (!nutriments) return false;
  return nutriments.proteins_serving != null
    || nutriments.sugars_serving != null
    || nutriments.sodium_serving != null;
}

// Convert a per-100g nutrient to per-serving. Never disguise per-100g as serving.
function toServing(val100g, servingVal, servingQuantity) {
  if (val100g === null) return null;
  if (servingVal != null) return servingVal;
  if (servingQuantity) return val100g * servingQuantity / 100;
  return null;
}

// Threshold values are unchanged — only which figure they are applied to.
// Null means unknown data; never coerce to 0 and invent a "low" tier.
function computeNutrientTiers(sugarVal, sodiumVal, proteinVal) {
  const sugarTier = sugarVal == null
    ? 'unknown'
    : sugarVal >= 22.5 ? 'high' : sugarVal >= 5 ? 'medium' : 'low';
  const sodiumTier = sodiumVal == null
    ? 'unknown'
    : sodiumVal >= 0.6 ? 'high' : sodiumVal >= 0.12 ? 'medium' : 'low';
  const proteinTier = proteinVal == null
    ? 'unknown'
    : proteinVal >= 10 ? 'high' : 'low';
  return { sugarTier, sodiumTier, proteinTier };
}

// Shared by /scan and /search so tiers and servingKnown stay aligned.
function resolveFoodServingNutrition(nutriments, servingQuantityRaw) {
  const servingQuantity = parseServingQuantity(servingQuantityRaw);
  const servingKnown = hasServingNutrientData(nutriments) || servingQuantity != null;
  const proteinRaw = nutriments?.proteins_100g ?? null;
  const sugarRaw = nutriments?.sugars_100g ?? null;
  const sodiumRaw = nutriments?.sodium_100g ?? null;
  const proteinDisplay = toServing(proteinRaw, nutriments?.proteins_serving, servingQuantity);
  const sugarDisplay = toServing(sugarRaw, nutriments?.sugars_serving, servingQuantity);
  const sodiumDisplay = toServing(sodiumRaw, nutriments?.sodium_serving, servingQuantity);
  // Tiers share a basis with the numbers shown: per-serving when known, else per-100g.
  const tiers = computeNutrientTiers(
    servingKnown ? sugarDisplay : sugarRaw,
    servingKnown ? sodiumDisplay : sodiumRaw,
    servingKnown ? proteinDisplay : proteinRaw,
  );
  return {
    servingQuantity,
    servingKnown,
    proteinRaw,
    sugarRaw,
    sodiumRaw,
    proteinDisplay,
    sugarDisplay,
    sodiumDisplay,
    sugarTier: tiers.sugarTier,
    sodiumTier: tiers.sodiumTier,
    proteinTier: tiers.proteinTier,
  };
}

function formatGrams(val) {
  if (val === null || val === undefined) return 'N/A';
  return Math.round(val * 10) / 10 + 'g';
}

function formatSodiumMg(val) {
  if (val === null || val === undefined) return 'N/A';
  return Math.round(val * 1000) + 'mg';
}

const additiveMap = {'e100':'Curcumin','e101':'Riboflavin','e102':'Tartrazine','e104':'Quinoline Yellow','e110':'Sunset Yellow','e120':'Carmine','e122':'Carmoisine','e123':'Amaranth','e124':'Ponceau 4R','e127':'Erythrosine','e129':'Allura Red','e131':'Patent Blue','e132':'Indigo Carmine','e133':'Brilliant Blue','e140':'Chlorophyll','e150a':'Caramel Color','e150b':'Caustic Sulfite Caramel','e150c':'Ammonia Caramel','e150d':'Sulfite Ammonia Caramel','e153':'Vegetable Carbon','e160a':'Beta-Carotene','e160b':'Annatto','e161b':'Lutein','e162':'Beetroot Red','e163':'Anthocyanins','e170':'Calcium Carbonate','e171':'Titanium Dioxide','e172':'Iron Oxides','e200':'Sorbic Acid','e202':'Potassium Sorbate','e210':'Benzoic Acid','e211':'Sodium Benzoate','e212':'Potassium Benzoate','e213':'Calcium Benzoate','e220':'Sulfur Dioxide','e221':'Sodium Sulfite','e222':'Sodium Bisulfite','e223':'Sodium Metabisulfite','e224':'Potassium Metabisulfite','e249':'Potassium Nitrite','e250':'Sodium Nitrite','e251':'Sodium Nitrate','e252':'Potassium Nitrate','e260':'Acetic Acid','e261':'Potassium Acetate','e262':'Sodium Acetate','e270':'Lactic Acid','e280':'Propionic Acid','e281':'Sodium Propionate','e282':'Calcium Propionate','e283':'Potassium Propionate','e290':'Carbon Dioxide','e296':'Malic Acid','e297':'Fumaric Acid','e300':'Vitamin C','e301':'Sodium Ascorbate','e302':'Calcium Ascorbate','e306':'Vitamin E','e307':'Alpha-Tocopherol','e310':'Propyl Gallate','e311':'Octyl Gallate','e312':'Dodecyl Gallate','e319':'TBHQ','e320':'BHA','e321':'BHT','e322':'Lecithin','e330':'Citric Acid','e331':'Sodium Citrate','e332':'Potassium Citrate','e333':'Calcium Citrate','e334':'Tartaric Acid','e335':'Sodium Tartrate','e336':'Potassium Tartrate','e337':'Sodium Potassium Tartrate','e338':'Phosphoric Acid','e339':'Sodium Phosphate','e340':'Potassium Phosphate','e341':'Calcium Phosphate','e343':'Magnesium Phosphate','e350':'Sodium Malate','e351':'Potassium Malate','e352':'Calcium Malate','e353':'Metatartaric Acid','e380':'Triammonium Citrate','e400':'Alginic Acid','e401':'Sodium Alginate','e402':'Potassium Alginate','e403':'Ammonium Alginate','e404':'Calcium Alginate','e405':'Propylene Glycol Alginate','e406':'Agar','e407':'Carrageenan','e410':'Locust Bean Gum','e412':'Guar Gum','e413':'Tragacanth','e414':'Acacia Gum','e415':'Xanthan Gum','e416':'Karaya Gum','e417':'Tara Gum','e418':'Gellan Gum','e420':'Sorbitol','e421':'Mannitol','e422':'Glycerol','e432':'Polysorbate 20','e433':'Polysorbate 80','e440':'Pectin','e442':'Ammonium Phosphatides','e450':'Diphosphates','e451':'Triphosphates','e452':'Polyphosphates','e460':'Cellulose','e461':'Methyl Cellulose','e462':'Ethyl Cellulose','e463':'Hydroxypropyl Cellulose','e464':'Hydroxypropyl Methyl Cellulose','e465':'Methyl Ethyl Cellulose','e466':'Carboxymethyl Cellulose','e470':'Fatty Acid Salts','e471':'Mono and Diglycerides','e472a':'Acetic Acid Esters','e472b':'Lactic Acid Esters','e472c':'Citric Acid Esters','e472e':'Diacetyl Tartaric Esters','e473':'Sucrose Esters','e474':'Sucroglycerides','e475':'Polyglycerol Esters','e476':'Polyglycerol Polyricinoleate','e477':'Propylene Glycol Esters','e481':'Sodium Stearoyl Lactylate','e482':'Calcium Stearoyl Lactylate','e491':'Sorbitan Monostearate','e500':'Sodium Carbonates','e501':'Potassium Carbonates','e503':'Ammonium Carbonates','e504':'Magnesium Carbonates','e507':'Hydrochloric Acid','e508':'Potassium Chloride','e509':'Calcium Chloride','e511':'Magnesium Chloride','e512':'Stannous Chloride','e514':'Sodium Sulfates','e515':'Potassium Sulfates','e516':'Calcium Sulfate','e524':'Sodium Hydroxide','e525':'Potassium Hydroxide','e526':'Calcium Hydroxide','e527':'Ammonium Hydroxide','e528':'Magnesium Hydroxide','e529':'Calcium Oxide','e530':'Magnesium Oxide','e535':'Sodium Ferrocyanide','e536':'Potassium Ferrocyanide','e538':'Calcium Ferrocyanide','e541':'Sodium Aluminum Phosphate','e551':'Silicon Dioxide','e552':'Calcium Silicate','e553a':'Magnesium Silicate','e553b':'Talc','e554':'Sodium Aluminosilicate','e555':'Potassium Aluminum Silicate','e556':'Calcium Aluminosilicate','e558':'Bentonite','e559':'Aluminum Silicate','e570':'Fatty Acids','e574':'Gluconic Acid','e575':'Glucono Delta Lactone','e576':'Sodium Gluconate','e577':'Potassium Gluconate','e578':'Calcium Gluconate','e579':'Ferrous Gluconate','e585':'Ferrous Lactate','e620':'Glutamic Acid','e621':'MSG','e622':'Potassium Glutamate','e623':'Calcium Glutamate','e624':'Monoammonium Glutamate','e625':'Magnesium Glutamate','e626':'Guanylic Acid','e627':'Disodium Guanylate','e628':'Dipotassium Guanylate','e629':'Calcium Guanylate','e630':'Inosinic Acid','e631':'Disodium Inosinate','e632':'Dipotassium Inosinate','e633':'Calcium Inosinate','e635':'Disodium Ribonucleotides','e640':'Glycine','e650':'Zinc Acetate','e900':'Dimethyl Polysiloxane','e901':'Beeswax','e902':'Candelilla Wax','e903':'Carnauba Wax','e904':'Shellac','e905':'Microcrystalline Wax','e912':'Montan Acid Esters','e914':'Oxidized Polyethylene Wax','e920':'L-Cysteine','e927b':'Carbamide','e938':'Argon','e939':'Helium','e941':'Nitrogen','e942':'Nitrous Oxide','e943a':'Butane','e943b':'Isobutane','e944':'Propane','e948':'Oxygen','e949':'Hydrogen','e950':'Acesulfame K','e951':'Aspartame','e952':'Cyclamates','e953':'Isomalt','e954':'Saccharin','e955':'Sucralose','e957':'Thaumatin','e959':'Neohesperidin','e960':'Steviol Glycosides','e961':'Neotame','e962':'Aspartame-Acesulfame Salt','e965':'Maltitol','e966':'Lactitol','e967':'Xylitol','e968':'Erythritol','e999':'Quillaia Extract','e1103':'Invertase','e1200':'Polydextrose','e1201':'Polyvinylpyrrolidone','e1202':'Polyvinylpolypyrrolidone','e1404':'Oxidized Starch','e1410':'Monostarch Phosphate','e1412':'Distarch Phosphate','e1413':'Phosphated Distarch Phosphate','e1414':'Acetylated Distarch Phosphate','e1420':'Acetylated Starch','e1422':'Acetylated Distarch Adipate','e1440':'Hydroxypropyl Starch','e1442':'Hydroxypropyl Distarch Phosphate','e1450':'Starch Sodium Octenyl Succinate','e1451':'Acetylated Oxidized Starch'};

// Additive details: name, category, riskLevel (high/limited/safe), description, learnMoreUrl
const additiveDetails = {
  'e100': { category: 'Natural color', riskLevel: 'safe', description: 'Curcumin is the bright yellow pigment found naturally in turmeric root. It has been used for centuries in cooking and traditional medicine. At food-level doses it is considered completely safe, and research even suggests it may have anti-inflammatory benefits.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Curcumin' },
  'e101': { category: 'Color / vitamin', riskLevel: 'safe', description: 'Riboflavin, also known as vitamin B2, is an essential nutrient naturally found in meat, dairy, and leafy greens. When used as a food coloring it gives an orange-yellow hue. It is completely safe and actually beneficial as a vitamin.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Riboflavin' },
  'e102': { category: 'Artificial color', riskLevel: 'high', description: 'Tartrazine is a synthetic lemon-yellow azo dye widely used in sweets, drinks, and snacks. A landmark 2007 UK study found it contributed to hyperactivity in children, leading the EU to require warning labels. It is banned outright in Norway and Austria, and the FDA is reviewing its status in the US as of 2024.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Tartrazine' },
  'e104': { category: 'Artificial color', riskLevel: 'high', description: 'Quinoline Yellow is a synthetic dye that gives a dull yellow-green color. It is included in the EU\'s "Southampton Six" group of dyes linked to hyperactivity in children. It is banned in the US, Australia, Japan, and Norway. Products containing it must carry a warning in the EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Quinoline_Yellow_WS' },
  'e110': { category: 'Artificial color', riskLevel: 'high', description: 'Sunset Yellow FCF is a bright orange-yellow azo dye used in beverages, candies, and snack foods. It is one of the "Southampton Six" dyes associated with increased hyperactivity in children. It requires a warning label in the EU and has been voluntarily phased out by several manufacturers.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sunset_yellow_FCF' },
  'e120': { category: 'Natural color', riskLevel: 'limited', description: 'Carmine is a deep red dye made from dried and crushed cochineal insects. While it is natural and generally safe for most people, it can trigger severe allergic reactions — including anaphylaxis — in sensitive individuals. It is not suitable for vegans or vegetarians. The FDA requires it to be listed by name on labels in the US.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Carmine' },
  'e122': { category: 'Artificial color', riskLevel: 'high', description: 'Carmoisine (Azorubine) is a red azo dye used in confectionery, jams, and drinks. It is one of the "Southampton Six" dyes linked to hyperactivity in children and must carry a warning label in the EU. It is banned in the US, Canada, Japan, and Norway.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Carmoisine' },
  'e123': { category: 'Artificial color', riskLevel: 'high', description: 'Amaranth is a dark red azo dye banned in the United States since 1976 after studies suggested a link to cancer in animal tests. It is still permitted in some countries including Russia and EU nations for certain uses. It must carry a hyperactivity warning in the EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Amaranth_(dye)' },
  'e124': { category: 'Artificial color', riskLevel: 'high', description: 'Ponceau 4R is a bright red synthetic azo dye used in drinks, desserts, and processed meats. It is one of the "Southampton Six" linked to hyperactivity in children and must carry a warning label in the EU. It is not approved for use in the US or Norway.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Ponceau_4R' },
  'e127': { category: 'Artificial color', riskLevel: 'high', description: 'Erythrosine is a cherry-pink dye made from iodine. High doses in animal studies raised concerns about thyroid disruption and cancer risk. The FDA banned it from maraschino cherries in 1990 but still permits it in certain products. It is banned in the EU for most food applications.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Erythrosine' },
  'e129': { category: 'Artificial color', riskLevel: 'high', description: 'Allura Red (Red 40) is the most widely used artificial food dye in the United States, found in everything from cereals to sodas. It is part of the "Southampton Six" linked to hyperactivity in children, and the EU requires a warning label. The FDA has opened a review of its safety as of 2024. Some states are moving to ban it from school foods.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Allura_Red_AC' },
  'e131': { category: 'Artificial color', riskLevel: 'high', description: 'Patent Blue V is a synthetic blue dye. It is banned in the US, Australia, and Norway due to concerns about cancer risk observed in some animal studies. It can also trigger allergic reactions including anaphylactic shock in rare cases.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Patent_Blue_V' },
  'e132': { category: 'Artificial color', riskLevel: 'limited', description: 'Indigo Carmine is a blue dye derived from indigo. It can cause allergic reactions in sensitive individuals and has been linked to nausea and high blood pressure in large medical doses. At normal food levels the risk is considered low, though it is not permitted in Norway.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Indigo_carmine' },
  'e133': { category: 'Artificial color', riskLevel: 'limited', description: 'Brilliant Blue FCF (Blue 1) is a synthetic dye used in confectionery, drinks, and dairy. It may cause allergic reactions in some people and is banned in several European countries. At typical food levels the scientific consensus is that the risk is low, but it remains under periodic review.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Brilliant_Blue_FCF' },
  'e140': { category: 'Natural color', riskLevel: 'safe', description: 'Chlorophyll is the natural green pigment extracted from plants such as spinach, nettles, and grass. It is widely used as a natural food coloring and is considered completely safe. It has no known health risks and some research suggests mild antioxidant properties.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Chlorophyll' },
  'e150a': { category: 'Color', riskLevel: 'safe', description: 'Plain caramel color is made by heating sugar or glucose syrups without any additives. It is the simplest and safest form of caramel coloring, with no known health concerns at typical levels. It is widely used in sauces, baked goods, and beverages.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Caramel_color' },
  'e150c': { category: 'Color', riskLevel: 'limited', description: 'Ammonia caramel is produced by heating sugars with ammonia. It can contain trace amounts of certain nitrogen-containing compounds. While considered safe at typical food levels by most regulatory agencies, some health researchers have called for more long-term safety data.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Caramel_color' },
  'e150d': { category: 'Color', riskLevel: 'limited', description: 'Sulfite ammonia caramel is the type found in colas and dark soft drinks. It can contain 4-methylimidazole (4-MEI), a compound the International Agency for Research on Cancer (IARC) classifies as possibly carcinogenic at high doses. California requires a warning label when levels are high enough.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Caramel_color' },
  'e160a': { category: 'Natural color', riskLevel: 'safe', description: 'Beta-carotene is the orange pigment naturally found in carrots, sweet potatoes, and pumpkins. The body converts it to vitamin A as needed. It is completely safe as a food coloring and beneficial as a provitamin. It has antioxidant properties and is widely used in margarine, cheese, and juices.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Beta-Carotene' },
  'e160b': { category: 'Natural color', riskLevel: 'limited', description: 'Annatto is a natural orange-yellow coloring extracted from the seeds of the achiote tree. While generally safe, it is one of the more common natural additives to trigger allergic reactions, including hives and irritable bowel syndrome in sensitive individuals. People with aspirin sensitivity may be more prone to reactions.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Annatto' },
  'e161b': { category: 'Natural color', riskLevel: 'safe', description: 'Lutein is a natural yellow carotenoid pigment found abundantly in leafy green vegetables like kale and spinach. As a food coloring it is completely safe. Research suggests lutein is beneficial for eye health, particularly in reducing the risk of age-related macular degeneration.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Lutein' },
  'e162': { category: 'Natural color', riskLevel: 'safe', description: 'Beetroot Red (betanin) is a natural red-purple pigment extracted from red beets. It is considered completely safe with no known health risks. It is heat-sensitive and may discolor urine and stools red in large amounts — a harmless condition called beeturia.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Betanin' },
  'e163': { category: 'Natural color', riskLevel: 'safe', description: 'Anthocyanins are the natural pigments that give berries, red grapes, and purple cabbage their color. They are considered completely safe and are associated with antioxidant and anti-inflammatory benefits in research. They are heat and pH sensitive, shifting from red in acidic to blue-purple in alkaline conditions.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Anthocyanin' },
  'e170': { category: 'Color / acidity regulator', riskLevel: 'safe', description: 'Calcium carbonate is a natural mineral compound found in chalk, limestone, and marble. In food it is used as a white colorant, acidity regulator, and calcium supplement. It is completely safe and is even used in antacids and calcium supplements sold in pharmacies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Calcium_carbonate' },
  'e171': { category: 'Color / coating', riskLevel: 'high', description: 'Titanium dioxide is a bright white pigment used in candies, chewing gum, and some dairy products. The European Food Safety Authority (EFSA) re-evaluated it in 2021 and concluded it could no longer be considered safe as a food additive due to concerns about genotoxicity — the ability to damage DNA. The EU banned it in food in 2022. It remains permitted in the US, though under increasing scrutiny.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Titanium_dioxide' },
  'e172': { category: 'Color', riskLevel: 'safe', description: 'Iron oxides are naturally occurring mineral pigments that give red, yellow, brown, and black colors. They are used in confectionery and decorative coatings. They are considered completely safe and are even approved for use in cosmetics and pharmaceutical coatings.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Iron_oxide' },
  'e200': { category: 'Preservative', riskLevel: 'safe', description: 'Sorbic acid is a naturally occurring compound first isolated from the berries of the rowan tree. It prevents the growth of mold, yeast, and fungi in foods like cheese, wine, and baked goods. It is widely considered safe by all major regulatory agencies and is one of the least toxic preservatives in use.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sorbic_acid' },
  'e202': { category: 'Preservative', riskLevel: 'safe', description: 'Potassium sorbate is the potassium salt of sorbic acid, one of the most widely used food preservatives in the world. It is effective against mold and yeast in cheese, wine, dried fruit, and baked goods. It is considered safe by the FDA, EFSA, and WHO at typical food levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_sorbate' },
  'e210': { category: 'Preservative', riskLevel: 'high', description: 'Benzoic acid prevents microbial growth in acidic foods and beverages. The key concern is that when combined with vitamin C (ascorbic acid) in drinks, it can form benzene — a known human carcinogen. It is also linked to hyperactivity in children. The UK FSA has advised limiting intake in children\'s products.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Benzoic_acid' },
  'e211': { category: 'Preservative', riskLevel: 'high', description: 'Sodium benzoate is a widely used preservative in soft drinks, juices, and condiments. Like benzoic acid, it can react with vitamin C to form benzene. The 2007 McCann study found it contributed to hyperactivity in children. Some countries have moved to restrict its use in children\'s drinks.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_benzoate' },
  'e220': { category: 'Preservative', riskLevel: 'limited', description: 'Sulfur dioxide is one of the oldest food preservatives, used in wine, dried fruits, and fruit juices to prevent browning and microbial growth. People with asthma or sulfite sensitivity can experience breathing difficulties, skin reactions, or anaphylaxis. The FDA requires foods containing 10ppm or more to declare sulfites on the label.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sulfur_dioxide' },
  'e221': { category: 'Preservative', riskLevel: 'limited', description: 'Sodium sulfite is a sulfite preservative used mainly in wine and dried fruits. It can trigger asthma attacks and allergic reactions in sulfite-sensitive individuals, who make up roughly 1% of the population. People with severe asthma are at greatest risk.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_sulfite' },
  'e223': { category: 'Preservative', riskLevel: 'limited', description: 'Sodium metabisulfite is a sulfite compound used to preserve color and freshness in seafood, wine, and dried fruits. It can cause asthma, hives, and anaphylaxis in sensitive people. Like all sulfites, it must be declared on labels when present above 10ppm in the US and EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_metabisulfite' },
  'e249': { category: 'Preservative', riskLevel: 'high', description: 'Potassium nitrite is used to cure and preserve meats, giving them their characteristic pink color. In the body it can convert to nitrosamines, compounds that the WHO classifies as probable carcinogens. The International Agency for Research on Cancer (IARC) classifies processed meats — partly due to nitrites — as Group 1 carcinogens.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_nitrite' },
  'e250': { category: 'Preservative', riskLevel: 'high', description: 'Sodium nitrite is the primary curing agent in processed meats like bacon, hot dogs, and deli meats. While it prevents botulism, it forms nitrosamines during digestion and cooking at high heat — compounds strongly linked to colorectal cancer. The WHO classifies processed meats as Group 1 carcinogens. Some countries are phasing out nitrites in favor of natural alternatives.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_nitrite' },
  'e251': { category: 'Preservative', riskLevel: 'high', description: 'Sodium nitrate is used to cure meats and is converted to sodium nitrite by bacteria in the body and during processing. It carries similar cancer risks to E250 — linked to colorectal and potentially gastric cancers. The IARC classifies dietary exposure to nitrates from processed meat as a probable carcinogen.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_nitrate' },
  'e252': { category: 'Preservative', riskLevel: 'high', description: 'Potassium nitrate (saltpeter) has been used to cure meats for centuries. Like other nitrates it converts to nitrite in the body, which can form cancer-linked nitrosamines. It is increasingly being replaced in food production, though it remains widely used in some traditional cured meats.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_nitrate' },
  'e260': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Acetic acid is the compound that gives vinegar its sharp taste and smell. It is produced naturally by fermentation and is one of the most ancient food preservatives known. At food-level concentrations it is completely safe. It has mild antimicrobial properties.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Acetic_acid' },
  'e261': { category: 'Preservative', riskLevel: 'safe', description: 'Potassium acetate is the potassium salt of acetic acid. It is used as a mild preservative and acidity regulator, particularly in salt-restricted products as a substitute for sodium salts. It is considered completely safe by all major regulatory agencies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_acetate' },
  'e262': { category: 'Preservative', riskLevel: 'safe', description: 'Sodium acetate is the sodium salt of acetic acid, commonly known as the compound that gives salt-and-vinegar chips their distinctive flavor. It acts as a preservative and acidity regulator. It is considered completely safe and is naturally present in many fermented foods.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_acetate' },
  'e270': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Lactic acid is a naturally occurring organic acid produced during fermentation. It is found in yogurt, cheese, sourdough bread, and pickled vegetables. In food production it regulates acidity and acts as a mild preservative. It is completely safe and is naturally present in the human body.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Lactic_acid' },
  'e280': { category: 'Preservative', riskLevel: 'safe', description: 'Propionic acid is a short-chain fatty acid naturally found in some cheeses and produced in the human gut by bacteria. It is used as a mold inhibitor in bread and baked goods. At typical food levels it is considered safe, though a small number of studies have explored effects on animal behavior at high doses.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Propionic_acid' },
  'e281': { category: 'Preservative', riskLevel: 'safe', description: 'Sodium propionate is the sodium salt of propionic acid. It is used to prevent mold growth in bread, cakes, and other baked goods. It is generally recognized as safe by the FDA and EFSA. A small number of studies have suggested possible behavioral effects in children at very high intake levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_propionate' },
  'e282': { category: 'Preservative', riskLevel: 'limited', description: 'Calcium propionate prevents mold in bread and is one of the most common preservatives in commercial baking. A 2002 Australian study found that high doses in children were associated with irritability, restlessness, and sleep disturbances. While regulators consider it safe at current levels, some parents choose to avoid it in children\'s food.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Calcium_propanoate' },
  'e296': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Malic acid is a naturally occurring organic acid found in apples, cherries, and other fruits. It gives a pleasantly tart taste and is used as an acidity regulator and flavor enhancer. It is completely safe and is naturally produced in the human body as part of the Krebs cycle.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Malic_acid' },
  'e297': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Fumaric acid is a naturally occurring organic acid found in some mushrooms and lichen. It is used as an acidity regulator and leavening aid in baked goods, beverages, and wine. It is considered completely safe by all major regulatory agencies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Fumaric_acid' },
  'e300': { category: 'Antioxidant / vitamin', riskLevel: 'safe', description: 'Vitamin C (ascorbic acid) is an essential nutrient and powerful antioxidant naturally found in citrus fruits, berries, and vegetables. As a food additive it prevents oxidation and browning. It is completely safe and beneficial. It is water-soluble, meaning excess amounts are excreted rather than stored.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Vitamin_C' },
  'e301': { category: 'Antioxidant', riskLevel: 'safe', description: 'Sodium ascorbate is a mineral salt form of vitamin C used as an antioxidant in food. It has the same benefits as ascorbic acid but is less acidic, making it useful for products where acidity must be controlled. It is completely safe and provides vitamin C to the diet.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_ascorbate' },
  'e306': { category: 'Antioxidant / vitamin', riskLevel: 'safe', description: 'Vitamin E (tocopherol) is a fat-soluble essential vitamin and powerful antioxidant found naturally in nuts, seeds, and vegetable oils. As a food additive it prevents fats from going rancid. It is completely safe and beneficial. It protects cell membranes from oxidative damage.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Vitamin_E' },
  'e310': { category: 'Antioxidant', riskLevel: 'limited', description: 'Propyl gallate prevents fats and oils from going rancid. It is often used alongside BHA and BHT. Some individuals experience allergic contact dermatitis or stomach irritation. It has been classified as a possible endocrine disruptor in some studies, and its use is restricted in baby foods.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Propyl_gallate' },
  'e319': { category: 'Antioxidant', riskLevel: 'limited', description: 'TBHQ (tertiary butylhydroquinone) is a synthetic antioxidant used to extend the shelf life of oils, fats, and fried foods. High doses in animal studies caused precancerous lesions and vision disturbances. It is banned in Japan and its use is tightly restricted in the EU. The FDA permits it at low levels in the US.', learnMoreUrl: 'https://en.wikipedia.org/wiki/tert-Butylhydroquinone' },
  'e320': { category: 'Antioxidant', riskLevel: 'limited', description: 'BHA (butylated hydroxyanisole) is a synthetic antioxidant used to preserve fats and oils in snack foods, cereals, and chewing gum. The US National Toxicology Program lists it as "reasonably anticipated to be a human carcinogen." It is banned in Japan and parts of the EU. The FDA still permits it at low levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Butylated_hydroxyanisole' },
  'e321': { category: 'Antioxidant', riskLevel: 'limited', description: 'BHT (butylated hydroxytoluene) is a synthetic antioxidant used alongside BHA in processed foods. Some animal studies have raised concerns about liver and kidney effects and possible carcinogenicity at high doses. Other studies suggest it may actually be protective. It is banned in some countries and voluntarily avoided by some manufacturers.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Butylated_hydroxytoluene' },
  'e322': { category: 'Emulsifier', riskLevel: 'safe', description: 'Lecithin is a natural phospholipid found in soybeans, sunflower seeds, and egg yolks. It helps oil and water mix smoothly in products like chocolate and mayonnaise. It is widely considered safe by all regulatory agencies. People with severe soy allergies should check the source, though allergic reactions to soy lecithin are rare.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Lecithin' },
  'e330': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Citric acid is one of the most widely used food additives in the world. It occurs naturally in citrus fruits and is produced industrially by fermenting sugars. It gives a pleasant tartness, acts as a preservative, and enhances other flavors. It is completely safe and naturally present in the human body as part of metabolism.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Citric_acid' },
  'e331': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Sodium citrate is the sodium salt of citric acid. It is used to regulate acidity, enhance flavor, and stabilize emulsions. It is a common ingredient in sports drinks and processed cheese. It is considered completely safe and is used medically as an anticoagulant and urinary alkalizer.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_citrate' },
  'e332': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Potassium citrate is used as an acidity regulator and electrolyte source in food and beverages. It is also used medically to treat kidney stones and gout. As a food additive it is considered completely safe and can benefit people who need to increase their potassium intake.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_citrate' },
  'e333': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Calcium citrate is used as an acidity regulator and calcium fortification agent. It is one of the most bioavailable forms of supplemental calcium and is used in calcium supplements sold in pharmacies. As a food additive it is completely safe and provides a nutritional benefit.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Calcium_citrate' },
  'e334': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Tartaric acid is a naturally occurring organic acid found abundantly in grapes and tamarinds. It gives wine its characteristic tartness. As a food additive it acts as an acidity regulator and antioxidant synergist. It is considered completely safe at normal food levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Tartaric_acid' },
  'e338': { category: 'Acidity regulator', riskLevel: 'limited', description: 'Phosphoric acid gives colas their sharp, tangy taste. While safe in small amounts, regular high consumption — particularly from carbonated drinks — has been associated with lower bone mineral density and increased kidney stone risk. The phosphoric acid in soft drinks is a major contributor to dietary phosphate overload in heavy soda consumers.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Phosphoric_acid' },
  'e339': { category: 'Acidity regulator', riskLevel: 'limited', description: 'Sodium phosphate is used as an acidity regulator, emulsifier, and leavening agent. While safe at low levels, high phosphate intake from multiple processed food sources has been linked to impaired kidney function over time, particularly in people with pre-existing kidney disease. The average Western diet already tends to be high in phosphates.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_phosphate' },
  'e340': { category: 'Acidity regulator', riskLevel: 'limited', description: 'Potassium phosphate is used as an acidity regulator and leavening agent. Like other phosphate additives, cumulative high intake may contribute to impaired kidney function, reduced calcium absorption, and cardiovascular risk. People with kidney disease should be particularly cautious.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_phosphate' },
  'e341': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Calcium phosphate is a naturally occurring mineral compound used as a firming agent, acidity regulator, and calcium supplement in food. It is considered safe and can contribute positively to calcium intake. It is also used in toothpaste and bone graft materials.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Calcium_phosphate' },
  'e406': { category: 'Thickener', riskLevel: 'safe', description: 'Agar is a natural gelling agent derived from red algae (seaweed). It has been used in Asian cuisine for centuries and is a popular vegetarian/vegan substitute for gelatin. It is considered completely safe, has essentially no calories, and may have mild prebiotic effects on gut bacteria.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Agar' },
  'e407': { category: 'Thickener', riskLevel: 'limited', description: 'Carrageenan is a natural thickener and stabilizer extracted from red seaweed, used in dairy products, plant milks, and deli meats. Laboratory and animal studies have raised concerns about gut inflammation and intestinal lesions. The evidence in humans is mixed — some researchers have called for it to be removed from infant formula. EFSA and the FDA currently consider it safe at food levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Carrageenan' },
  'e410': { category: 'Thickener', riskLevel: 'safe', description: 'Locust bean gum (carob bean gum) is a natural thickener and gelling agent derived from the seeds of the carob tree. It is commonly used in ice cream, cheese, and sauces to improve texture. It is considered completely safe and may have mild cholesterol-lowering effects as a soluble fiber.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Locust_bean_gum' },
  'e412': { category: 'Thickener', riskLevel: 'safe', description: 'Guar gum is a natural thickener derived from guar beans, commonly grown in India and Pakistan. It is used in ice cream, baked goods, and gluten-free products. It is considered safe, though consuming very large amounts can cause bloating and gas. It has a low glycemic index and may help with blood sugar control.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Guar_gum' },
  'e414': { category: 'Thickener', riskLevel: 'safe', description: 'Gum arabic (acacia gum) is a natural resin harvested from acacia trees, primarily in sub-Saharan Africa. It is one of the oldest known food additives, used for thousands of years. It acts as a thickener, stabilizer, and emulsifier. It is completely safe, functions as a prebiotic fiber, and is approved for use in organic products.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Gum_arabic' },
  'e415': { category: 'Thickener', riskLevel: 'safe', description: 'Xanthan gum is produced by bacterial fermentation of sugars. It is an extremely effective thickener and stabilizer used in salad dressings, sauces, gluten-free baked goods, and plant-based foods. It is considered completely safe. People with digestive sensitivity may notice laxative effects at high doses.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Xanthan_gum' },
  'e420': { category: 'Sweetener', riskLevel: 'safe', description: 'Sorbitol is a sugar alcohol naturally found in fruits such as apples, pears, and prunes. It provides about 60% of the sweetness of sugar with fewer calories. It is considered safe, though consuming more than 10–20g per day can cause bloating, gas, and diarrhea in sensitive individuals. Products containing it must carry a laxative warning in the EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sorbitol' },
  'e421': { category: 'Sweetener', riskLevel: 'safe', description: 'Mannitol is a sugar alcohol naturally found in mushrooms, seaweed, and some fruits. It provides about 60% of the sweetness of sugar and is poorly absorbed, giving it a laxative effect at higher doses. It is used in sugar-free confectionery and pharmaceuticals. Products containing it must carry a laxative warning in the EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Mannitol' },
  'e432': { category: 'Emulsifier', riskLevel: 'limited', description: 'Polysorbate 20 is a synthetic emulsifier used to keep oil and water mixed in cosmetics and food. Animal studies at relatively high doses have suggested it may alter the gut microbiome and increase intestinal permeability. Human evidence is limited. It is approved for use in food but some researchers have called for further investigation.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polysorbate_20' },
  'e433': { category: 'Emulsifier', riskLevel: 'limited', description: 'Polysorbate 80 is a widely used synthetic emulsifier in ice cream, baked goods, and processed foods. A 2015 study in mice found it altered gut microbiome composition and promoted low-grade inflammation. The evidence in humans is not conclusive, but some researchers recommend limiting intake, particularly for those with inflammatory gut conditions.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polysorbate_80' },
  'e440': { category: 'Thickener', riskLevel: 'safe', description: 'Pectin is a naturally occurring structural polysaccharide found in the cell walls of fruits, particularly apples and citrus peels. It is one of the most natural food additives available and is used as a gelling agent in jams and jellies. It is completely safe, functions as a prebiotic, and may help lower cholesterol and blood sugar levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Pectin' },
  'e450': { category: 'Raising agent', riskLevel: 'limited', description: 'Diphosphates are phosphate salts used as raising agents in baked goods and as emulsifiers in processed cheese. While individually safe, cumulative phosphate intake from multiple processed food sources is a growing concern. High dietary phosphate has been associated with impaired kidney function and cardiovascular risk, particularly in people already consuming phosphate-rich foods.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Diphosphate' },
  'e451': { category: 'Raising agent', riskLevel: 'limited', description: 'Triphosphates are used as raising agents, moisture retainers, and emulsifiers in processed meats, seafood, and baked goods. The phosphate concern applies here as well: high cumulative intake may contribute to kidney stress, particularly for those with pre-existing kidney disease or those eating many phosphate-containing processed foods.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Triphosphate' },
  'e452': { category: 'Stabilizer', riskLevel: 'limited', description: 'Polyphosphates are used to help retain moisture in processed meats, seafood, and dairy products. They are effective at preventing water loss during freezing and cooking. As with other phosphate additives, high cumulative intake from multiple sources may contribute to kidney stress and cardiovascular effects over time.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polyphosphate' },
  'e460': { category: 'Thickener', riskLevel: 'safe', description: 'Cellulose is the structural component of plant cell walls and the most abundant natural polymer on earth. As a food additive it is used as a thickener, anti-caking agent, and source of dietary fiber. It passes through the digestive system undigested and is completely safe. It can contribute to daily fiber intake.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Cellulose' },
  'e466': { category: 'Thickener', riskLevel: 'safe', description: 'Carboxymethyl cellulose (CMC) is a modified cellulose derivative used as a thickener, stabilizer, and emulsifier in ice cream, sauces, and baked goods. It is considered safe at typical food levels. Some animal research has raised questions about gut microbiome effects at very high doses, but this has not been replicated in human studies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Carboxymethyl_cellulose' },
  'e471': { category: 'Emulsifier', riskLevel: 'safe', description: 'Mono and diglycerides are derived from glycerol and fatty acids — essentially partial fats. They are among the most widely used food emulsifiers, found in bread, margarine, and ice cream. They are considered safe, though they do contribute small amounts of fat to the diet. They may be derived from animal or vegetable sources.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Mono-_and_diglycerides_of_fatty_acids' },
  'e476': { category: 'Emulsifier', riskLevel: 'safe', description: 'PGPR (polyglycerol polyricinoleate) is an emulsifier derived from castor oil. It is primarily used in chocolate to reduce viscosity and allow manufacturers to use less cocoa butter. It is considered safe by EFSA and the FDA. Some consumers prefer to avoid it as an indicator that a product uses less real chocolate.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polyglycerol_polyricinoleate' },
  'e500': { category: 'Raising agent', riskLevel: 'safe', description: 'Sodium carbonates (including baking soda) are leavening agents that release carbon dioxide when heated, causing baked goods to rise. They are completely safe and have been used in cooking for centuries. Sodium bicarbonate is also used medically as an antacid.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_carbonate' },
  'e501': { category: 'Raising agent', riskLevel: 'safe', description: 'Potassium carbonates are used as acidity regulators and leavening agents, particularly in cocoa processing and some baked goods. They are considered safe and are used in some products as lower-sodium alternatives to sodium carbonates.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_carbonate' },
  'e503': { category: 'Raising agent', riskLevel: 'safe', description: 'Ammonium carbonates are leavening agents that release ammonia and carbon dioxide when heated, causing baked goods to rise. Unlike sodium bicarbonate, they leave no residue — all the gas escapes during baking. They are considered safe and have been used in traditional biscuit and cookie baking for centuries.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Ammonium_carbonate' },
  'e508': { category: 'Flavor enhancer', riskLevel: 'safe', description: 'Potassium chloride is used as a salt substitute and flavor enhancer in low-sodium foods. It has a slightly bitter or metallic taste at higher concentrations. It is considered safe for healthy adults. People with kidney disease or those taking potassium-sparing medications should consult a doctor before consuming large amounts.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_chloride' },
  'e509': { category: 'Firming agent', riskLevel: 'safe', description: 'Calcium chloride is used to maintain firmness in canned fruits and vegetables, in cheese-making, and as an electrolyte in sports drinks. It is considered completely safe. It is also used medically to treat calcium deficiencies and cardiac emergencies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Calcium_chloride' },
  'e551': { category: 'Anticaking agent', riskLevel: 'high', description: 'Silicon dioxide prevents powdered foods from clumping. Concerns have emerged because food-grade silicon dioxide may contain nanoparticles — extremely small particles capable of crossing the intestinal barrier and accumulating in organs. Animal studies have linked it to gut microbiota disruption and inflammation. The EU has flagged it for further safety review, and France temporarily suspended its use in 2019 before a full EFSA assessment.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Silicon_dioxide' },
  'e554': { category: 'Anticaking agent', riskLevel: 'limited', description: 'Sodium aluminosilicate prevents caking in table salt and powdered foods. While most of it passes through the digestive system unabsorbed, trace aluminum absorption raises questions for people with kidney impairment. Current evidence suggests absorption is too low to be a concern for healthy individuals, but some health agencies recommend caution.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_aluminosilicate' },
  'e574': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Gluconic acid is a mild organic acid produced by the oxidation of glucose. It is naturally present in honey, fruit, and wine. It is used as an acidity regulator and sequestrant in food. It is completely safe and is naturally produced in the human body.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Gluconic_acid' },
  'e575': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Glucono delta-lactone (GDL) is a mild natural acidifier used in tofu-making, baked goods, and as a leavening agent. It is derived from glucose and is naturally present in honey and fruit juice. It is considered completely safe.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Glucono_delta-lactone' },
  'e621': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Monosodium glutamate (MSG) enhances the savory umami taste in foods. It is the sodium salt of glutamic acid, an amino acid naturally found in tomatoes, cheese, and mushrooms. Most regulatory agencies consider it safe. Some people report sensitivity symptoms (headache, flushing) in what was historically called "Chinese restaurant syndrome" — but controlled studies have struggled to consistently reproduce this effect.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Monosodium_glutamate' },
  'e627': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Disodium guanylate is a flavor enhancer derived from guanosine monophosphate, a nucleotide found in yeast and fish. It amplifies savory taste and is almost always used alongside MSG. It is not suitable for people with gout (it raises uric acid levels) and is not permitted in foods for infants. It is generally safe for healthy adults.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Disodium_guanylate' },
  'e631': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Disodium inosinate is a flavor enhancer derived from inosine monophosphate, found naturally in meat and fish. It intensifies savory taste and is typically used with MSG and disodium guanylate. Like E627, it raises uric acid and should be avoided by people with gout. It is not suitable for infants or those on purine-restricted diets.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Disodium_inosinate' },
  'e635': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Disodium ribonucleotides is a combination of E627 and E631, providing a powerful savory flavor boost. It is found in many chips, instant noodles, and snack foods. It should be avoided by people with gout, hyperuricemia, or aspirin sensitivity. Some individuals have reported hives and rashes.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Disodium_ribonucleotides' },
  'e640': { category: 'Flavor enhancer', riskLevel: 'safe', description: 'Glycine is the simplest amino acid and is naturally found in protein-rich foods. As a food additive it provides a mildly sweet flavor. It is considered completely safe and is actually a non-essential amino acid that the human body produces itself.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Glycine' },
  'e900': { category: 'Antifoaming agent', riskLevel: 'safe', description: 'Dimethyl polysiloxane (silicone) is added to cooking oils to prevent foaming during deep frying. It passes through the body without being absorbed. It is considered completely safe and is also found in silicone cookware and medical devices.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polydimethylsiloxane' },
  'e901': { category: 'Glazing agent', riskLevel: 'safe', description: 'Beeswax is a natural wax produced by honey bees. It is used as a glazing agent on candies, fruits, and tablets to give them a shiny coating and prevent moisture loss. It is completely safe and is also used in cosmetics and pharmaceutical coatings.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Beeswax' },
  'e903': { category: 'Glazing agent', riskLevel: 'safe', description: 'Carnauba wax is derived from the leaves of the carnauba palm tree in Brazil. It gives candies, gummy bears, and fruit a shiny coating. It is considered completely safe, is vegan, and is also widely used in car wax and cosmetics.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Carnauba_wax' },
  'e950': { category: 'Sweetener', riskLevel: 'limited', description: 'Acesulfame K (Ace-K) is an artificial sweetener 200 times sweeter than sugar. It is heat stable and used in baked goods, drinks, and tabletop sweeteners. Some animal studies at very high doses raised concerns about carcinogenicity and neurological effects, but these were conducted at doses far above typical human consumption. The FDA considers it safe, though some researchers advocate for more long-term human studies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Acesulfame_potassium' },
  'e951': { category: 'Sweetener', riskLevel: 'limited', description: 'Aspartame is one of the most extensively studied food additives in history. It is 200 times sweeter than sugar and used in diet drinks, yogurt, and chewing gum. In 2023 the WHO\'s International Agency for Research on Cancer (IARC) classified it as "possibly carcinogenic to humans" (Group 2B) — the same category as pickled vegetables and aloe vera extract. People with phenylketonuria (PKU) must avoid it as they cannot metabolize phenylalanine.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Aspartame' },
  'e952': { category: 'Sweetener', riskLevel: 'high', description: 'Cyclamate is an artificial sweetener banned in the United States in 1969 after animal studies suggested it may cause bladder cancer. It remains approved in over 50 countries including the EU, Canada, and Australia. Efforts to get it re-approved in the US have been ongoing but unsuccessful. People in countries where it is permitted consume it regularly at the current ADI.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_cyclamate' },
  'e953': { category: 'Sweetener', riskLevel: 'safe', description: 'Isomalt is a sugar alcohol derived from sucrose. It provides about half the calories of sugar and does not cause tooth decay. It is widely used in sugar-free confectionery and hard candies. Consuming large amounts (above 20–30g per day) can cause bloating and a laxative effect. Products containing it require a laxative warning in the EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Isomalt' },
  'e954': { category: 'Sweetener', riskLevel: 'limited', description: 'Saccharin was discovered in 1879 and is one of the oldest artificial sweeteners. In the 1970s animal studies suggested bladder cancer risk, leading to mandatory warning labels in the US. Subsequent research found this was specific to rats and not applicable to humans. Warning labels were removed in 2000. It is now considered safe, though some health professionals prefer other sweeteners with more modern safety data.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Saccharin' },
  'e955': { category: 'Sweetener', riskLevel: 'limited', description: 'Sucralose is made from sugar by replacing three hydroxyl groups with chlorine atoms, making it 600 times sweeter and non-caloric. It is widely considered safe by the FDA and EFSA. However, some studies suggest it may alter gut bacteria composition and affect insulin response even without being fully metabolized. A 2023 study also found it may have genotoxic properties, prompting calls for further investigation.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sucralose' },
  'e960': { category: 'Sweetener', riskLevel: 'safe', description: 'Steviol glycosides are the sweet compounds extracted from the leaves of the stevia plant, native to South America. They are 200–400 times sweeter than sugar with essentially no calories. They are considered safe by the FDA, EFSA, and WHO. Unlike artificial sweeteners, they come from a natural plant source and do not appear to affect blood sugar or gut bacteria negatively.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Steviol_glycoside' },
  'e965': { category: 'Sweetener', riskLevel: 'safe', description: 'Maltitol is a sugar alcohol derived from maltose. It is 90% as sweet as sugar with about half the calories. It is widely used in sugar-free chocolate and candy. It has a higher glycemic index than other sugar alcohols, so diabetics should monitor intake. Consuming large amounts causes bloating and laxative effects. EU products must carry a laxative warning.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Maltitol' },
  'e966': { category: 'Sweetener', riskLevel: 'safe', description: 'Lactitol is a sugar alcohol derived from lactose. It provides about 40% the sweetness of sugar with fewer calories. It is used in sugar-free cookies, chocolate, and chewing gum. It functions as a prebiotic, feeding beneficial gut bacteria. Large amounts can cause bloating and diarrhea. Not suitable for people with lactose intolerance.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Lactitol' },
  'e967': { category: 'Sweetener', riskLevel: 'safe', description: 'Xylitol is a sugar alcohol naturally found in birch trees, corn cobs, and some fruits. It has the same sweetness as sugar but 40% fewer calories and does not raise blood sugar. It is particularly valued for dental health — it actively inhibits the bacteria that cause tooth decay. It is safe for humans but extremely toxic to dogs, even in small amounts.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Xylitol' },
  'e968': { category: 'Sweetener', riskLevel: 'safe', description: 'Erythritol is a sugar alcohol found naturally in fermented foods and some fruits. It has about 70% of the sweetness of sugar with almost no calories (0.2 kcal/g vs 4 kcal/g for sugar). Unlike most sugar alcohols it is almost entirely absorbed and excreted unchanged, so it rarely causes digestive issues. Some research suggests it may have antioxidant properties.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Erythritol' },
  'e1200': { category: 'Bulking agent', riskLevel: 'safe', description: 'Polydextrose is a synthetic soluble fiber made from glucose, sorbitol, and citric acid. It is used as a bulking agent and fat replacer in low-calorie foods. It acts as a prebiotic, feeding beneficial gut bacteria, and may help with blood sugar regulation. It is considered safe by all major regulatory agencies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polydextrose' },
};

// OFF's additives_tags is a curated subset. Its per-ingredient taxonomy IDs
// carry E-numbers it omits from that field (vitamins, some salts). Union both.
// Dedupe on the resolved lookup key so e340 + e340ii do not become two rows
// that both render as "Potassium Phosphate".
function extractAdditiveCodes(product) {
  const rawOrdered = [];
  const seenRaw = new Set();

  function addRaw(key) {
    if (!key || seenRaw.has(key)) return;
    seenRaw.add(key);
    rawOrdered.push(key);
  }

  for (const tag of (product && product.additives_tags) || []) {
    if (tag == null) continue;
    addRaw(String(tag).replace(/^en:/i, '').toLowerCase());
  }

  function walk(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const id = item.id;
      if (typeof id === 'string' && /^en:e\d+/i.test(id)) {
        addRaw(id.replace(/^en:/i, '').toLowerCase());
      }
      if (item.ingredients) walk(item.ingredients);
    }
  }

  try {
    walk(product && product.ingredients);
  } catch (_) {
    // Malformed ingredients must never break additive extraction.
  }

  // Group by resolved key, preserving first-seen order of each group.
  const groups = new Map(); // resolvedKey -> raw codes in encounter order
  for (const raw of rawOrdered) {
    const resolved = resolveAdditiveLookupKey(raw);
    let list = groups.get(resolved);
    if (!list) {
      list = [];
      groups.set(resolved, list);
    }
    list.push(raw);
  }

  const result = [];
  for (const [resolved, raws] of groups) {
    result.push(pickPreferredAdditiveRawCode(raws, resolved));
  }
  return result;
}

// When several raw codes collapse to one lookup key, prefer a more-specific
// form that exists in additiveMap; otherwise keep the base (resolved) code.
function pickPreferredAdditiveRawCode(rawCodes, resolvedKey) {
  if (!rawCodes || rawCodes.length === 0) return resolvedKey;
  if (rawCodes.length === 1) return rawCodes[0];

  const inMap = rawCodes.filter(c => additiveMap[c] || additiveDetails[c]);
  if (inMap.length > 0) {
    // Longer code ≈ more specific suffix (e340ii > e340i > e340).
    let best = inMap[0];
    for (let i = 1; i < inMap.length; i++) {
      if (inMap[i].length > best.length) best = inMap[i];
    }
    return best;
  }
  if (rawCodes.includes(resolvedKey)) return resolvedKey;
  return resolvedKey;
}

// OFF emits sub-forms (e332ii, e160ai). Prefer the exact code when named;
// otherwise fall back to the base number / letter form for map lookups.
function resolveAdditiveLookupKey(code) {
  const key = String(code || '').replace(/^en:/i, '').toLowerCase();
  if (!key) return key;
  if (additiveMap[key] || additiveDetails[key]) return key;

  // Strip trailing roman-numeral form suffixes: e332ii → e332, e160ai → e160a
  let stripped = key.replace(/(?:viii|vii|vi|iv|ix|iii|ii|i)$/i, '');
  if (stripped !== key && (additiveMap[stripped] || additiveDetails[stripped])) {
    return stripped;
  }

  // Digits + single class letter: e160ai → e160a
  const withLetter = key.match(/^(e\d+[a-z])/i);
  if (withLetter && (additiveMap[withLetter[1]] || additiveDetails[withLetter[1]])) {
    return withLetter[1].toLowerCase();
  }

  // Base number only: e332ii → e332
  const baseNum = key.match(/^(e\d+)/i);
  if (baseNum && (additiveMap[baseNum[1]] || additiveDetails[baseNum[1]])) {
    return baseNum[1].toLowerCase();
  }

  return key;
}

function additiveDisplayName(code) {
  const key = String(code || '').replace(/^en:/i, '').toLowerCase();
  const lookup = resolveAdditiveLookupKey(key);
  return additiveMap[lookup] || key.toUpperCase();
}

function additiveRiskDetails(code) {
  const key = String(code || '').replace(/^en:/i, '').toLowerCase();
  const lookup = resolveAdditiveLookupKey(key);
  return additiveDetails[lookup] || additiveDetails[key];
}

// Animal-derived E-numbers that conflict with vegan / vegetarian profiles.
// Matched on exact code or numeric base (e120ii → e120) — not prefixes
// (e120 must not match e1200).
const ANIMAL_ADDITIVE_BASES = new Set(['e120', 'e901', 'e904']);
function findAnimalDerivedAdditive(codes) {
  for (const code of codes || []) {
    const key = String(code || '').replace(/^en:/i, '').toLowerCase();
    if (ANIMAL_ADDITIVE_BASES.has(key)) return key;
    const base = key.match(/^(e\d+)/i);
    if (base && ANIMAL_ADDITIVE_BASES.has(base[1].toLowerCase())) {
      return base[1].toLowerCase();
    }
  }
  return null;
}

// OFF's top-level category tags are too broad to produce relevant comparisons —
// matching only on one of these would compare e.g. a protein bar against bottled
// water. If a product's only available tags are this generic, skip recommendations
// entirely rather than show something irrelevant.
const GENERIC_CATEGORY_TAGS = new Set([
  'en:plant-based-foods-and-beverages', 'en:plant-based-foods', 'en:beverages',
  'en:foods', 'en:snacks', 'en:meals', 'en:groceries', 'en:non-alcoholic-beverages',
]);

async function getCategoryAlternatives(currentBarcode, categoriesTags, currentScore) {
  if (!categoriesTags || categoriesTags.length === 0) {
    console.log(`[ALT DEBUG] barcode=${currentBarcode} EARLY EXIT — categoriesTags=${JSON.stringify(categoriesTags)}`);
    return [];
  }

  // Walk from most specific to least specific, skipping anything too generic
  // to use as a search anchor. This only determines the candidate POOL —
  // actual relevance is decided below by comparing full tag overlap.
  let specificTag = null;
  for (let i = categoriesTags.length - 1; i >= 0; i--) {
    if (!GENERIC_CATEGORY_TAGS.has(categoriesTags[i])) {
      specificTag = categoriesTags[i];
      break;
    }
  }
  if (!specificTag) {
    console.log(`[ALT DEBUG] barcode=${currentBarcode} SILENT EXIT — all tags too generic. fullTagList=${JSON.stringify(categoriesTags)}`);
    return [];
  }

  const searchRes = await fetch(
    `https://world.openfoodfacts.org/api/v2/search?categories_tags=${encodeURIComponent(specificTag)}&countries_tags_en=United States&page_size=40&fields=code,product_name,nutriscore_grade,nova_group,additives_tags,ingredients,labels_tags,nutriments,image_front_url,image_url,categories_tags`,
    { headers: { 'User-Agent': 'DontWorryFoodScanner/1.0 (contact: app developer)' } }
  );
  if (!searchRes.ok) {
    console.log(`[ALT DEBUG] barcode=${currentBarcode} search request failed, status=${searchRes.status}`);
    return [];
  }
  const searchData = await searchRes.json();
  const candidates = (searchData.products || []).filter(p => p.code && p.code !== currentBarcode);

  const originalTagSet = new Set(categoriesTags.filter(t => !GENERIC_CATEGORY_TAGS.has(t)));

  // DEBUG: see exactly why candidates pass or fail relevance/score filtering.
  console.log(`[ALT DEBUG] barcode=${currentBarcode} specificTag=${specificTag} candidateCount=${candidates.length} originalTags=${JSON.stringify([...originalTagSet])}`);

  const scoredFull = candidates
    .map(p => {
      const pNutriScore = p.nutriscore_grade || null;
      const pNovaGroup = p.nova_group || 3;
      const pAdditiveCodes = extractAdditiveCodes(p);
      const pAdditivesCount = pAdditiveCodes.length;
      const pIsOrganic = p.labels_tags?.includes('en:organic') || false;
      const pProtein = p.nutriments?.proteins_100g || 0;
      const pSugar = p.nutriments?.sugars_100g || 0;
      const pSodium = p.nutriments?.sodium_100g || 0;
      const pAdditiveList = pAdditiveCodes.map(a => {
        const details = additiveRiskDetails(a);
        return { riskLevel: details?.riskLevel || 'safe' };
      });
      const pScore = calculateScore(pNutriScore, pNovaGroup, pAdditivesCount, pIsOrganic, pProtein, pSugar, pSodium, pAdditiveList, p.code, p.nutriments, p.foodCategory);
      const pScoreColor = pScore == null ? '#9E9E9E' : pScore >= 75 ? '#2E7D32' : pScore >= 50 ? '#8BC34A' : pScore >= 25 ? '#FF9800' : '#F44336';
      const pScoreLabel = pScore == null ? 'Not enough data' : pScore >= 75 ? 'Excellent' : pScore >= 50 ? 'Good' : pScore >= 25 ? 'Poor' : 'Bad';

      // Relevance: how much of this candidate's non-generic category lineage
      // actually overlaps with the scanned product's. Two genuinely similar
      // products (e.g. two protein bars) share most of their tag chain; a
      // protein bar and bottled water only share a top-level tag, which is
      // already excluded from this comparison.
      const candidateTags = (p.categories_tags || []).filter(t => !GENERIC_CATEGORY_TAGS.has(t));
      const sharedTags = candidateTags.filter(t => originalTagSet.has(t)).length;
      const overlapRatio = originalTagSet.size > 0 ? sharedTags / originalTagSet.size : 0;

      return {
        barcode: p.code,
        name: p.product_name || 'Unknown Product',
        score: pScore,
        scoreColor: pScoreColor,
        scoreLabel: pScoreLabel,
        imageUrl: p.image_front_url || p.image_url || '',
        overlapRatio,
      };
    });

  // DEBUG: show the top candidates by score with their overlap ratio, so we
  // can see exactly why something passed or failed the relevance/score gate.
  const debugTop = scoredFull
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(p => `${p.name}|score=${p.score}|overlap=${p.overlapRatio.toFixed(2)}`);
  console.log(`[ALT DEBUG] currentScore=${currentScore} top8=${JSON.stringify(debugTop)}`);

  const scored = scoredFull
    // Require at least half the scanned product's specific category tags to
    // match — this is the real relevance gate, not the search tag itself.
    .filter(p => p.name !== 'Unknown Product' && p.score != null && p.score >= 50 && p.score > currentScore && p.overlapRatio >= 0.5)
    .sort((a, b) => b.score - a.score)
    .map(({ overlapRatio, ...rest }) => rest);

  console.log(`[ALT DEBUG] qualified=${scored.length} top5raw=${JSON.stringify(candidates.slice(0,5).map(p => p.product_name))}`);

  return scored.slice(0, 2);
}

// Token-aware diet term matching — avoids substring false positives such as
// "milk" inside "oatmilk" / "egg" inside "eggplant", and plant-qualified
// compounds such as "oat milk" / "peanut butter" / "coconut cream".
const PLANT_QUALIFIERS = new Set([
  'oat', 'almond', 'soy', 'soya', 'coconut', 'cashew', 'rice', 'hemp', 'pea',
  'peanut', 'sunflower', 'shea', 'cocoa', 'macadamia', 'hazelnut', 'walnut',
  'pecan', 'pistachio', 'flax', 'sesame', 'potato', 'apple', 'nut', 'plant', 'vegan',
]);

// Dairy/egg terms that are often plant-qualified when preceded by a plant token.
const PLANT_QUALIFIABLE_TERMS = new Set([
  'milk', 'cream', 'butter', 'cheese', 'yogurt', 'dairy', 'egg', 'eggs',
]);

// Separators between ingredient phrases. Must not let a plant qualifier on one
// side suppress a dairy/egg term on the other ("Sugar, Cocoa, Milk").
const DIET_PHRASE_BOUNDARY = '\x1e';

function normalizeDietIngredientText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u0060\u00b4]/g, "'") // curly / grave / acute → '
    .replace(/[-–—/\\]+/g, ' ')
    // Phrase boundaries stay as sentinels so qualifiers cannot cross them.
    .replace(/[,;()\[\].:]/g, ` ${DIET_PHRASE_BOUNDARY} `)
    .replace(new RegExp(`[^a-z0-9'\\s${DIET_PHRASE_BOUNDARY}]+`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeDietIngredients(text) {
  if (!text) return [];
  return normalizeDietIngredientText(text)
    .split(' ')
    .map(t => (t === DIET_PHRASE_BOUNDARY ? t : t.replace(/^'+|'+$/g, '')))
    .filter(Boolean);
}

function isDietPhraseBoundary(token) {
  return token === DIET_PHRASE_BOUNDARY;
}

// Singular / plural / possessive forms of a plant qualifier within one phrase.
function isPlantQualifierToken(token) {
  if (!token || isDietPhraseBoundary(token)) return false;
  if (PLANT_QUALIFIERS.has(token)) return true;
  if (token.endsWith("'s") && PLANT_QUALIFIERS.has(token.slice(0, -2))) return true;
  // oats → oat, almonds → almond, coconuts → coconut (not ss endings)
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') &&
      PLANT_QUALIFIERS.has(token.slice(0, -1))) {
    return true;
  }
  return false;
}

function isNegatedByFree(tokens, index) {
  // "dairy-free" / "gluten free" → term immediately followed by "free"
  return tokens[index + 1] === 'free';
}

// Match diet terms on whole tokens (word boundaries). When applyPlantQualifier
// is true, a dairy/egg term is ignored if the immediately preceding token is
// a plant qualifier in the SAME phrase ("oat milk", "cocoa butter") — not
// across commas/parens ("Sugar, Cocoa, Milk"). substringTerms (gluten path)
// also match when the term appears inside a token (wholewheat → wheat).
// Multi-token animal compounds like "buttermilk" are listed as their own
// terms so boundary matching does not create false negatives.
function findDietTermMatch(ingredientsText, terms, tagList, {
  applyPlantQualifier = false,
  substringTerms = null,
} = {}) {
  const tags = tagList || [];
  for (const term of terms) {
    if (tags.includes(term)) return term;
  }

  const sub = substringTerms instanceof Set
    ? substringTerms
    : (substringTerms ? new Set(substringTerms) : null);

  const tokens = tokenizeDietIngredients(ingredientsText);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (isDietPhraseBoundary(token)) continue;

    for (const term of terms) {
      const isSub = sub && sub.has(term);
      const matched = isSub ? token.includes(term) : token === term;
      if (!matched) continue;
      if (isNegatedByFree(tokens, i)) continue;
      // "gluten-free oats" — oats are the subject of the gluten-free claim in
      // the same phrase, not a separate gluten hit.
      if (
        (term === 'oat' || term === 'oats') &&
        tokens[i - 1] === 'free' &&
        tokens[i - 2] === 'gluten'
      ) {
        continue;
      }
      if (
        applyPlantQualifier &&
        PLANT_QUALIFIABLE_TERMS.has(term) &&
        i > 0 &&
        isPlantQualifierToken(tokens[i - 1])
      ) {
        continue;
      }
      return term;
    }
  }
  return null;
}

// Diet warning detection — checks a product against the user's dietary
// preferences and returns a human-readable warning string, or empty string
// if no conflicts. Uses OFF's labels_tags, ingredients_text, and additive codes
// (additives_tags unioned with per-ingredient taxonomy IDs).
function detectDietWarnings(product, healthProfile) {
  if (!healthProfile || healthProfile.trim() === '') return '';
  const prefs = new Set(healthProfile.split(',').map(s => s.trim()).filter(Boolean));
  if (prefs.size === 0) return '';

  const labels = product.labels_tags || [];
  const ingredientsText = product.ingredients_text || '';
  const ingredientsLower = ingredientsText.toLowerCase();
  const additives = extractAdditiveCodes(product);
  const allergens = (product.allergens_tags || []).map(a => a.replace('en:', '').toLowerCase());
  const traces = (product.traces_tags || []).map(t => t.replace('en:', '').toLowerCase());

  const warnings = [];

  if (prefs.has('vegan')) {
    const isVegan = labels.includes('en:vegan');
    const isNotVegan = labels.includes('en:non-vegan');
    if (isNotVegan) {
      warnings.push('Not compatible with vegan diet');
    } else if (!isVegan) {
      // buttermilk is animal-derived and must remain a whole-token hit even
      // though boundary matching no longer treats it as "butter"/"milk".
      // Seafood names that used to match only as substrings of "fish" are listed
      // explicitly so token matching does not drop them.
      const animalTerms = ['buttermilk', 'milk', 'dairy', 'cheese', 'butter', 'cream', 'egg', 'eggs', 'honey',
        'meat', 'beef', 'pork', 'chicken', 'fish', 'gelatin', 'gelatine', 'lard', 'whey',
        'casein', 'lactose', 'anchovy', 'anchovies', 'tuna', 'salmon', 'shrimp', 'prawn',
        'shellfish', 'crab', 'lobster', 'oyster', 'clam', 'mussel', 'scallop', 'squid',
        'octopus', 'krill', 'cod', 'sardine', 'mackerel', 'herring', 'crustacean',
        'mollusc', 'mollusk'];
      const found = findDietTermMatch(ingredientsText, animalTerms, allergens, { applyPlantQualifier: true });
      if (found) warnings.push(`Contains ${found} — not compatible with vegan diet`);
      // Animal-derived additives (e.g. E120 carmine) often appear only in
      // ingredients[] taxonomy IDs, not additives_tags — check both via helper.
      else {
        const animalAdd = findAnimalDerivedAdditive(additives);
        if (animalAdd) {
          const name = additiveDisplayName(animalAdd).toLowerCase();
          warnings.push(`Contains ${name} — not compatible with vegan diet`);
        }
      }
    }
  }

  if (prefs.has('vegetarian')) {
    const isVeg = labels.includes('en:vegetarian') || labels.includes('en:vegan');
    const isNotVeg = labels.includes('en:non-vegetarian');
    if (isNotVeg) {
      warnings.push('Not compatible with vegetarian diet');
    } else if (!isVeg) {
      const meatTerms = ['meat', 'beef', 'pork', 'chicken', 'turkey', 'lamb', 'veal',
        'fish', 'anchovy', 'anchovies', 'tuna', 'salmon', 'shrimp', 'prawn', 'gelatin', 'gelatine', 'lard',
        'shellfish', 'crab', 'lobster', 'oyster', 'clam', 'mussel', 'scallop', 'squid',
        'octopus', 'krill', 'cod', 'sardine', 'mackerel', 'herring', 'crustacean',
        'mollusc', 'mollusk'];
      const found = findDietTermMatch(ingredientsText, meatTerms, allergens, { applyPlantQualifier: true });
      if (found) warnings.push(`Contains ${found} — not compatible with vegetarian diet`);
      else {
        const animalAdd = findAnimalDerivedAdditive(additives);
        if (animalAdd) {
          const name = additiveDisplayName(animalAdd).toLowerCase();
          warnings.push(`Contains ${name} — not compatible with vegetarian diet`);
        }
      }
    }
  }

  if (prefs.has('gluten-free')) {
    const isGF = labels.includes('en:gluten-free');
    if (!isGF) {
      // Joined compounds (wholewheat, wheatgerm) need substring hits for the
      // cereal terms; malt/oat/oats stay whole-token so maltodextrin is clean.
      const glutenSubstringTerms = ['wheat', 'gluten', 'barley', 'rye', 'spelt'];
      const glutenTokenTerms = ['oats', 'oat', 'malt'];
      const found = findDietTermMatch(
        ingredientsText,
        [...glutenSubstringTerms, ...glutenTokenTerms],
        [...allergens, ...traces],
        { substringTerms: glutenSubstringTerms }
      );
      if (found) warnings.push(`Contains ${found} — may not be suitable for gluten-free diet`);
    }
  }

  if (prefs.has('lactose-free')) {
    const isLF = labels.includes('en:lactose-free') || labels.includes('en:dairy-free');
    if (!isLF) {
      // Same plant-qualified dairy compounds as vegan (oat milk, cocoa butter…).
      const lactoseTerms = ['buttermilk', 'milk', 'dairy', 'lactose', 'whey', 'casein', 'cheese', 'butter', 'cream', 'yogurt'];
      const found = findDietTermMatch(ingredientsText, lactoseTerms, allergens, { applyPlantQualifier: true });
      if (found) warnings.push(`Contains ${found} — not compatible with lactose-free diet`);
    }
  }

  if (prefs.has('soy-free')) {
    // Token match plus compounds where soy/soya is joined (soymilk) — those
    // are real soy, so a bare word-boundary check would wrongly miss them.
    // "soy-free" / "soy free" must not count (negated by following "free").
    const soyTokens = tokenizeDietIngredients(ingredientsText);
    const hasSoyTag = allergens.includes('soybeans') || allergens.includes('soy') || allergens.includes('soya');
    let hasSoyToken = false;
    for (let i = 0; i < soyTokens.length; i++) {
      const t = soyTokens[i];
      if (isDietPhraseBoundary(t)) continue;
      const isSoy = t === 'soy' || t === 'soya' || t === 'tofu' || t === 'soybeans' || t === 'soybean' ||
        t.startsWith('soy') || t.startsWith('soya');
      if (isSoy && !isNegatedByFree(soyTokens, i)) {
        hasSoyToken = true;
        break;
      }
    }
    if (hasSoyTag || hasSoyToken) warnings.push('Contains soy — not compatible with soy-free diet');
  }

  if (prefs.has('pork-free')) {
    const porkTerms = ['pork', 'lard', 'bacon', 'ham', 'gelatin', 'gelatine'];
    const found = findDietTermMatch(ingredientsText, porkTerms, allergens);
    if (found) warnings.push(`Contains ${found} — not compatible with pork-free diet`);
  }

  if (prefs.has('palm-oil-free')) {
    const hasPalm = ingredientsLower.includes('palm oil') || ingredientsLower.includes('palm kernel') ||
      labels.includes('en:palm-oil-free') === false && ingredientsLower.includes('palm');
    if (hasPalm) warnings.push('Contains palm oil');
  }

  if (prefs.has('sulfite-free')) {
    const sulfiteAdditives = ['e220', 'e221', 'e222', 'e223', 'e224', 'e225', 'e226', 'e227', 'e228'];
    const hasSulfite = additives.some(a => sulfiteAdditives.includes(a)) ||
      ingredientsLower.includes('sulfite') || ingredientsLower.includes('sulphite') || ingredientsLower.includes('sulfit');
    if (hasSulfite) warnings.push('Contains sulfites — not compatible with sulfite-free diet');
  }

  return warnings.join(' • ');
}

// Core scan logic, extracted so both the /scan route and the pre-scoring
// admin job can share it. Returns the response data object (already cached),
// or throws on a hard failure (product not found, etc.) — same behavior the
// /scan route relied on before this refactor.
async function generateCosmeticExplanation(scored, ingredientsText) {
  const drivers = (scored.scoreBreakdown.penalties || [])
    .slice()
    .sort((a, b) => b.penalty - a.penalty)
    .slice(0, 3)
    .map(p => {
      const finding = scored.ingredientFindings.find(f => f.inci === p.inci);
      return {
        inci: p.inci,
        risk: p.risk,
        reason: finding?.reason || '',
        disputed: !!finding?.disputed,
        disputeNote: finding?.disputeNote || null,
        allergen: !!p.allergen,
      };
    });

  const noIngredientData = !!scored.noIngredientData || scored.coverageTotal === 0;

  const coverageNote = noIngredientData
    ? ''
    : scored.coverage < 0.60
      ? `Coverage is ${scored.coverageMatched} of ${scored.coverageTotal} ingredients assessed — mention this briefly.`
      : `Coverage is ${scored.coverageMatched} of ${scored.coverageTotal} ingredients (do not dwell on coverage).`;

  const coverageContext = noIngredientData
    ? 'We found this product in the database but it has no ingredient list. Say plainly that we could not assess it because the ingredient list is missing. Do NOT say "0 of 0", "0 of 0 assessed", or similar.'
    : scored.score === null
      ? 'There is not enough ingredient coverage to give a numeric score — say so briefly without inventing findings.'
      : '';

  const hasModerateOrHigh = drivers.some(d => d.risk === 'moderate' || d.risk === 'high');
  const onlyLowFindings = drivers.length > 0 && !hasModerateOrHigh;
  const proportionNote = noIngredientData || scored.score === null
    ? ''
    : drivers.length === 0
      ? 'No ingredient penalties drove the score. Keep the tone calm — do not invent concerns.'
      : onlyLowFindings
        ? 'The only findings are low-risk. Mention them as minor caveats only — do not lead with them as a concern or make the product sound problematic. Tone must stay proportionate to a high/clean score.'
        : 'Lead with the highest-risk findings; keep tone proportionate to their severity.';

  const prompt = `You are explaining a cosmetic ingredient safety scan for a consumer app.
Always write in the first-person plural ("we" / "we've" / "our"). Never use first-person singular ("I" / "I've" / "I'm" / "my").
${coverageContext}
${coverageNote}
${proportionNote}
Top drivers (use these reason texts; do not invent rationale): ${JSON.stringify(drivers)}
Ingredient list (context only): ${ingredientsText || '(none)'}

Write one plain-text explanation under 40 words, findings only, in sentences.
PLAIN TEXT ONLY — no asterisks, no bold, no markdown, no headers, no bullet characters.
Do NOT restate the numeric score or the tier label (Excellent/Good/Poor/Bad) — the app already shows those beside the text.
The explanation must not contradict the score shown beside it — do not sound alarming next to a clean score, or dismissive next to a poor one.
Name the two or three ingredients that drove the score and say why in plain terms (sensitiser, restricted, prohibited, declarable allergen).
Never state or imply a concentration or percentage.
If an ingredient is disputed, you may note that sources disagree, but do not present the dissenting view as equal to the regulatory finding.
Do not mention environmental persistence concerns as personal health risks.
Avoid jargon like "Annex II" — say "prohibited in the EU" if relevant.`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const claudeData = await claudeRes.json();
    return claudeData.content?.[0]?.text || 'Cosmetic ingredient assessment complete.';
  } catch (err) {
    console.log(`[COSMETIC EXPLAIN ERROR] ${err.message}`);
    return 'Cosmetic ingredient assessment complete.';
  }
}

function isKnownNutrientForPrompt(value, tier) {
  if (value == null) return false;
  const text = String(value).trim();
  if (!text || text === 'N/A') return false;
  if (tier === 'unknown') return false;
  return true;
}

// Food explanations must never end mid-sentence. Keep at most 3 complete
// sentences. Decimal points (25.2g) are not sentence boundaries; a period
// after an E-number (E476.) still is when the next character is not a digit.
function trimFoodExplanation(text, maxSentences = 3) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return '';
  const sentences = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    if (ch === '.' && /\d/.test(raw[i - 1] || '') && /\d/.test(raw[i + 1] || '')) {
      continue;
    }
    let end = i;
    while (end + 1 < raw.length && /[.!?]/.test(raw[end + 1])) end += 1;
    const sentence = raw.slice(start, end + 1).trim();
    if (sentence) sentences.push(sentence);
    let next = end + 1;
    while (next < raw.length && /\s/.test(raw[next])) next += 1;
    start = next;
    i = end;
    if (sentences.length >= maxSentences) break;
  }
  return sentences.slice(0, maxSentences).join(' ');
}

function buildFoodExplanationPrompt({
  sugar,
  sodium,
  protein,
  sugarTier,
  sodiumTier,
  proteinTier,
  additivesPhrase,
  isOrganic,
  novaGroup,
  ingredients,
  nutriScoreGrade,
  basisLabel = 'per serving',
}) {
  const grade = String(nutriScoreGrade || 'c').toLowerCase();
  const nutriGuidance =
    grade === 'd' || grade === 'e'
      ? 'The nutritional grade behind most of this score is poor. Your explanation MUST reflect that poor nutritional profile — do not write an entirely positive sentence listing only upsides. Say "poor nutritional profile" in plain English; never say "Nutri-Score" or the letter grade.'
      : grade === 'c'
        ? 'The nutritional grade behind most of this score is middling. Do not claim the product is highly healthy overall; balance any positives with that context. Never say "Nutri-Score" or the letter grade.'
        : 'The nutritional grade behind most of this score is relatively strong. You may mention a genuine benefit when supported by the data. Never say "Nutri-Score" or the letter grade.';

  // Omit nutrients with no data — never invent "N/A (low/unknown tier)".
  const nutrientParts = [];
  if (isKnownNutrientForPrompt(sugar, sugarTier)) {
    nutrientParts.push(`sugar ${sugar} ${basisLabel} (${sugarTier} tier)`);
  }
  if (isKnownNutrientForPrompt(sodium, sodiumTier)) {
    nutrientParts.push(`sodium ${sodium} ${basisLabel} (${sodiumTier} tier)`);
  }
  if (isKnownNutrientForPrompt(protein, proteinTier)) {
    nutrientParts.push(`protein ${protein} ${basisLabel}`);
  }
  const nutrientPhrase = nutrientParts.length > 0
    ? nutrientParts.join(', ') + ', '
    : '';

  return `Write at most 3 complete sentences. Never stop mid-sentence or mid-word.
Purla may use "we" ONLY for an evaluation Purla performs (for example "We rate this Poor because…"). Product composition, formulation, processing, ingredients, and manufacturer actions are always third person — the product contains…, the manufacturer has used…. Never write "we've packed", "we've added", or "we've processed" this product.
Never use first-person singular ("I" / "I've" / "I'm" / "my").
Product data: ${nutrientPhrase}${additivesPhrase}, organic: ${isOrganic}, NOVA group ${novaGroup}. Ingredients: ${ingredients}.
Score context: ${nutriGuidance}
Call out the most specific health concern or benefit using the actual numbers or ingredient names above. The explanation must not contradict the score shown beside it. The tier labels given above (low/medium/high) are already correct — match your wording to them exactly, do not recalculate or reclassify based on the numbers yourself. Never say "NOVA group" or any technical jargon — instead describe processing level in plain words like "highly processed" or "minimally processed" if relevant. Name a specific additive if relevant. Avoid vague filler. Write it the way a person would actually say it out loud — avoid stiff constructions like "makes this a sodium concern" or "is the primary nutritional consideration." PLAIN TEXT ONLY — no asterisks, no bold, no markdown, no headers, no bullet characters. Do not restate an overall product score or Excellent/Good/Poor/Bad tier.`;
}

async function requestFoodExplanation(prompt) {
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 220,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const claudeData = await claudeRes.json();
  if (claudeData.stop_reason === 'max_tokens') {
    console.log('[FOOD EXPLAIN MAX TOKENS] completion stopped at max_tokens — trimming to last complete sentence');
  }
  const text = claudeData.content && claudeData.content[0] && claudeData.content[0].text
    ? claudeData.content[0].text
    : '';
  return trimFoodExplanation(text);
}

function formatAdditivesCountDisplay(additivesCount, ingredientsText) {
  // Empty / punctuation-only ingredients text means we cannot know — do not print "None".
  if (!hasUsableIngredientText(ingredientsText)) return 'Not known';
  return additivesCount === 0 ? 'None' : additivesCount + ' additives';
}

// Fixed copy when food has no usable ingredient list — never call Haiku for this.
const FOOD_NO_INGREDIENTS_EXPLANATION =
  "We couldn't check the ingredients for this product because none are listed. The score is based on nutrition alone.";

// Fixed copy when food lacks energy/proteins/sodium|salt — never call Haiku.
const FOOD_NO_NUTRITION_EXPLANATION =
  "We couldn't tell what kind of product this is. There's no nutrition information and no product category, so we can't score it. If it's a cleaning or household product, we don't assess those.";

const FOOD_INCOMPLETE_NUTRITION_EXPLANATION =
  "We found this product but some required nutrition values are missing, so we could not compute a nutrition score.";

// Fixed copy when a cosmetic explanation is unusable (refusal / malformed).
const COSMETIC_NO_EXPLANATION =
  "We couldn't summarise this product's ingredients.";

function fallbackExplanationForProductType(productType) {
  if (productType === 'household') return HOUSEHOLD_EXPLANATION;
  if (productType === 'cosmetic') return COSMETIC_NO_EXPLANATION;
  return FOOD_NO_INGREDIENTS_EXPLANATION;
}

function formatNutrientForPrompt(gramsVal, kind) {
  if (gramsVal === null || gramsVal === undefined) return null;
  if (kind === 'sodium') return `${Math.round(gramsVal * 1000)}mg`;
  return `${Math.round(gramsVal * 10) / 10}g`;
}

async function generateFoodExplanation({
  sugarDisplay,
  sodiumDisplay,
  proteinDisplay,
  sugarTier,
  sodiumTier,
  proteinTier,
  additivesCount,
  isOrganic,
  novaGroup,
  ingredients,
  nutriScoreGrade,
  basisLabel = 'per serving',
}) {
  const hasIngredients = hasUsableIngredientText(ingredients);
  const additivesPhrase = !hasIngredients
    ? 'additives not known'
    : `${additivesCount} additives`;
  const prompt = buildFoodExplanationPrompt({
    sugar: formatNutrientForPrompt(sugarDisplay, 'sugar'),
    sodium: formatNutrientForPrompt(sodiumDisplay, 'sodium'),
    protein: formatNutrientForPrompt(proteinDisplay, 'protein'),
    sugarTier,
    sodiumTier,
    proteinTier,
    additivesPhrase,
    isOrganic,
    novaGroup,
    ingredients,
    nutriScoreGrade,
    basisLabel,
  });
  const explanation = await requestFoodExplanation(prompt);
  if (!hasUsableExplanation({ explanation })) {
    console.log(`[FOOD EXPLAIN UNUSABLE] excerpt=${String(explanation || '').slice(0, 120)}`);
    return FOOD_NO_INGREDIENTS_EXPLANATION;
  }
  return explanation;
}

// Rebuild a Haiku explanation from a productCache document (food or cosmetic).
async function generateExplanationFromCached(cached) {
  const productType = cached.productType || 'food';
  if (productType === 'household') {
    return HOUSEHOLD_EXPLANATION;
  }
  if (productType === 'cosmetic') {
    const findings = typeof cached.ingredientFindings === 'string'
      ? JSON.parse(cached.ingredientFindings || '[]')
      : (cached.ingredientFindings || []);
    const breakdown = typeof cached.scoreBreakdown === 'string'
      ? JSON.parse(cached.scoreBreakdown || '{}')
      : (cached.scoreBreakdown || {});
    const coverageMatched = cached.coverageMatched ?? 0;
    const coverageTotal = cached.coverageTotal ?? 0;
    return generateCosmeticExplanation({
      score: cached.score,
      scoreLabel: cached.scoreLabel,
      coverageMatched,
      coverageTotal,
      coverage: coverageTotal > 0 ? coverageMatched / coverageTotal : 0,
      ingredientFindings: findings,
      scoreBreakdown: breakdown,
    }, cached.ingredients || '');
  }

  // Food — null score from missing energy/proteins/sodium|salt: fixed copy, never Haiku.
  // Photo-rescued food keeps its own fixed sentence (label alone cannot score food).
  if (cached.score == null && cached.scoreLabel === 'Not enough data') {
    if (cached.source === 'photo') return FOOD_PHOTO_EXPLANATION;
    return FOOD_NO_NUTRITION_EXPLANATION;
  }

  // Food — missing ingredients get the fixed sentence, never Haiku.
  if (!hasUsableIngredientText(cached.ingredients)) {
    return FOOD_NO_INGREDIENTS_EXPLANATION;
  }

  // Food — use the cached display strings (already formatted for the app).
  const additivesPhrase = cached.additivesCount === 'None'
    ? '0 additives'
    : (cached.additivesCount === 'Not known'
      ? 'additives not known'
      : (cached.additivesCount || '0 additives'));
  // Accept legacy Yes/No cache values and yes/no/unknown/Unknown strings.
  const organicStatus = normalizeOrganicStatus(cached.isOrganic);
  const breakdown = typeof cached.scoreBreakdown === 'string'
    ? (() => { try { return JSON.parse(cached.scoreBreakdown || '{}'); } catch (_) { return {}; } })()
    : (cached.scoreBreakdown || {});
  const nutriScoreGrade = cached.nutriScore || breakdown.nutriScoreGrade || 'c';
  // Match the number's basis: per-serving when known, otherwise the per-100g fields.
  const basisLabel = cached.servingKnown ? 'per serving' : 'per 100g';
  const sugar = cached.servingKnown ? cached.sugar : (cached.sugar100g || cached.sugar);
  const sodium = cached.servingKnown ? cached.sodium : (cached.sodium100g || cached.sodium);
  const protein = cached.servingKnown ? cached.protein : (cached.protein100g || cached.protein);
  const prompt = buildFoodExplanationPrompt({
    sugar,
    sodium,
    protein,
    sugarTier: cached.sugarTier,
    sodiumTier: cached.sodiumTier,
    proteinTier: cached.proteinTier,
    additivesPhrase,
    isOrganic: organicStatus,
    novaGroup: cached.novaGroup,
    ingredients: cached.ingredients || '',
    nutriScoreGrade,
    basisLabel,
  });
  const explanation = await requestFoodExplanation(prompt);
  if (!hasUsableExplanation({ explanation })) {
    console.log(`[FOOD EXPLAIN UNUSABLE] excerpt=${String(explanation || '').slice(0, 120)}`);
    return FOOD_NO_INGREDIENTS_EXPLANATION;
  }
  return explanation;
}

function hasUsableExplanation(data) {
  if (!data || data.explanation == null) return false;
  const text = String(data.explanation).trim();
  if (!text) return false;
  // Cosmetic explanations are two to three sentences and can run long with
  // several findings; 600 leaves headroom beyond the old 400 cap.
  if (text.length > 600) return false;
  // Model returning a bullet list.
  if (/\n-\s/.test(text)) return false;

  // Models often emit typographic apostrophes (U+2019 etc.); normalise before
  // matching markers that use a straight apostrophe.
  const lower = text
    .toLowerCase()
    .replace(/[\u2019\u02BC\u2018]/g, "'");
  const refusalMarkers = [
    "i can't",
    'i cannot',
    "i'm unable",
    'i am unable',
    'i apologize',
    'i appreciate the detailed instructions',
    'could you provide',
    'please provide',
    'the ingredient list provided',
  ];
  if (refusalMarkers.some(m => lower.includes(m))) return false;
  // "as requested" together with a question mark.
  if (lower.includes('as requested') && text.includes('?')) return false;
  return true;
}

// Dedupe concurrent Haiku work for the same barcode (deferred fill + /explain).
const explanationInFlight = new Map();

function ensureExplanation(barcode, cached) {
  if (explanationInFlight.has(barcode)) {
    return explanationInFlight.get(barcode);
  }
  const promise = (async () => {
    try {
      // Re-read in case another path already filled the cache.
      try {
        const fresh = await getDocWithBarcodeMigration(CACHE_COLLECTION, barcode);
        const freshData = fresh.exists ? fresh.data() : null;
        // Same rule as stale-cache fallback / GET /explain: do not reattach an
        // explanation generated under an older SCAN_LOGIC_VERSION.
        if (freshData
            && freshData.scanLogicVersion === SCAN_LOGIC_VERSION
            && hasUsableExplanation(freshData)) {
          return freshData.explanation;
        }
      } catch (_) { /* fall through to generate */ }

      let explanation = await generateExplanationFromCached(cached);
      if (!hasUsableExplanation({ explanation })) {
        console.log(`[EXPLAIN UNUSABLE] barcode=${barcode} excerpt=${String(explanation || '').slice(0, 120)}`);
        explanation = fallbackExplanationForProductType(cached && cached.productType);
      }
      try {
        await db.collection(CACHE_COLLECTION).doc(barcode).set({
          explanation,
          explanationPending: false,
        }, { merge: true });
      } catch (writeErr) {
        console.log(`[EXPLAIN CACHE WRITE ERROR] barcode=${barcode} ${writeErr.message}`);
      }
      return explanation;
    } finally {
      explanationInFlight.delete(barcode);
    }
  })();
  explanationInFlight.set(barcode, promise);
  return promise;
}

function scanAndCacheHousehold(barcode, product) {
  const productName = product.product_name || 'Unknown Product';
  const imageUrl = product.image_front_url || product.image_url || '';
  const ingredients = product.ingredients_text || '';
  const source = (product && product.source) || 'off';
  recordRawObservation({
    barcode,
    productType: 'household',
    source,
    payload: product,
    tableVersion: null,
  });
  console.log(`[HOUSEHOLD] barcode=${barcode} — category household, skipping score`);
  return buildHouseholdScanResponse({
    productName,
    imageUrl,
    ingredients,
    extras: { source },
  });
}

async function scanAndCacheCosmetic(barcode, product, { skipExplanation = false } = {}) {
  // Preserve the unmodified OBF product for future rescoring / analysis.
  const source = (product && product.source) || 'obf';
  recordRawObservation({
    barcode,
    productType: 'cosmetic',
    source,
    payload: product,
    tableVersion: COSMETIC_TABLE_VERSION,
  });

  const productName = product.product_name || 'Unknown Product';
  const imageUrl = product.image_front_url || product.image_url || '';
  const ingredients = product.ingredients_text || '';

  // Household cleaners (EPA/pesticide labels) are not scoreable cosmetics.
  if (looksLikeHouseholdProduct(ingredients)) {
    console.log(`[HOUSEHOLD] barcode=${barcode} — skipping cosmetic score`);
    return buildHouseholdScanResponse({ productName, imageUrl, ingredients });
  }

  const scored = scoreCosmeticProduct(product);

  let explanation = null;
  if (scored.noIngredientData) {
    // Fixed copy — do not defer or invent a Haiku line about "0 of 0".
    explanation = 'We found this product but its ingredient list is missing, so we could not assess it.';
  } else if (!skipExplanation) {
    explanation = await generateCosmeticExplanation(scored, ingredients);
  }

  console.log(`[COSMETIC SCORE] barcode=${barcode} coverage=${scored.coverageMatched}/${scored.coverageTotal} score=${scored.score} noIngredientData=${!!scored.noIngredientData} table=${COSMETIC_TABLE_VERSION}`);
  console.log(`[UNPARSEABLE] barcode=${barcode} count=${scored.unparseableCount || 0}`);
  if (scored.drugFactsMarker) {
    console.log(`[DRUG FACTS TRUNCATED] barcode=${barcode} marker=${scored.drugFactsMarker}`);
  }

  const unmatchedNames = scored.unmatchedNames || [];
  const namesJoined = unmatchedNames.map(unmatchedNameLabel).join('|');
  const namesTruncated = namesJoined.length > 200
    ? namesJoined.slice(0, 200) + '...'
    : namesJoined;
  console.log(`[COSMETIC UNMATCHED] barcode=${barcode} count=${unmatchedNames.length} names=${namesTruncated}`);
  // Do not await — logging must not delay the /scan response.
  recordUnmatchedInci(barcode, unmatchedNames);

  const responseData = {
    productType: 'cosmetic',
    productName,
    additiveNames: null,
    additiveList: JSON.stringify([]),
    ingredients,
    nutriScore: null,
    novaGroup: null,
    additivesCount: null,
    isOrganic: null,
    protein: null,
    sugar: null,
    sodium: null,
    sugarTier: null,
    sodiumTier: null,
    proteinTier: null,
    score: scored.score,
    scoreBreakdown: JSON.stringify(scored.scoreBreakdown),
    alternatives: JSON.stringify([]),
    explanation,
    scoreColor: scored.scoreColor,
    imageUrl,
    scoreLabel: scored.scoreLabel,
    coverageMatched: scored.coverageMatched,
    coverageTotal: scored.coverageTotal,
    assessedCount: scored.assessedCount,
    recognisedCount: scored.recognisedCount,
    totalCount: scored.totalCount,
    noIngredientData: !!scored.noIngredientData,
    ingredientFindings: JSON.stringify(scored.ingredientFindings),
    ingredientList: JSON.stringify(scored.ingredientList || []),
    tableVersion: COSMETIC_TABLE_VERSION,
    scanLogicVersion: SCAN_LOGIC_VERSION,
    source,
  };
  if (skipExplanation && !scored.noIngredientData) {
    responseData.explanationPending = true;
  }
  return responseData;
}

async function scanAndCacheFood(barcode, product, { skipExplanation = false } = {}) {
  // Preserve the unmodified upstream product for future rescoring / analysis.
  // Provenance is recorded for hit-rate measurement; scoring does not branch on it.
  const source = (product && product.source) || 'off';
  recordRawObservation({
    barcode,
    productType: 'food',
    source,
    payload: product,
    tableVersion: null,
  });

  const productName = product.product_name || 'Unknown Product';
  const imageUrl = product.image_front_url || product.image_url || '';
  const ingredients = product.ingredients_text || '';

  // Refuse a food score when energy, proteins, and sodium/salt are all absent.
  // A non-empty nutriments object is not enough (Dawn Ultra: saturated-fat 0 +
  // sugars 0 only). Fixed copy — never call Haiku.
  // Nutrition fields are null (not "N/A") so the app hides the nutrition card
  // and the "score always uses nutrition per 100g" footnote — showing a table
  // for a product we just said we can't identify is misleading.
  if (!hasScorableFoodNutriments(product && product.nutriments)) {
    const organicStatus = resolveOrganicStatus(product.labels_tags);
    console.log(`[FOOD NO NUTRITION] barcode=${barcode} — skipping food score`);
    return {
      productType: 'food',
      productName,
      additiveNames: '',
      additiveList: JSON.stringify([]),
      ingredients,
      nutriScore: product.nutriscore_grade || null,
      novaGroup: product.nova_group || null,
      additivesCount: formatAdditivesCountDisplay(
        extractAdditiveCodes(product).length,
        ingredients
      ),
      isOrganic: formatOrganicDisplay(organicStatus),
      protein: null,
      sugar: null,
      sodium: null,
      protein100g: null,
      sugar100g: null,
      sodium100g: null,
      servingQuantity: null,
      servingKnown: false,
      scoreBasis: null,
      sugarTier: null,
      sodiumTier: null,
      proteinTier: null,
      nutriScoreKnown: !!(product.nutriscore_grade),
      score: null,
      scoreBreakdown: JSON.stringify({
        nutriScoreGrade: 'unknown',
        nutriScoreKnown: !!(product.nutriscore_grade),
        nutriPts: null, nutriMax: 60,
        additivesCount: 0,
        additiveRisk: 'none',
        additivePts: null, additiveMax: 30,
        isOrganic: false,
        organicPts: null, organicMax: 10,
      }),
      alternatives: JSON.stringify([]),
      explanation: FOOD_NO_NUTRITION_EXPLANATION,
      scoreColor: '#9E9E9E',
      imageUrl,
      scoreLabel: 'Not enough data',
      coverageMatched: null,
      coverageTotal: null,
      ingredientFindings: null,
      noIngredientData: false,
      scanLogicVersion: SCAN_LOGIC_VERSION,
      source,
    };
  }

  // Do not use OFF Nutri-Score for the 60-point component — Purla's USDA
  // nutrition subscore runs for every food, including those with a real grade.
  const nutriScore = product.nutriscore_grade || null;
  const nutriScoreKnown = !!nutriScore;
  const novaGroup = product.nova_group || 3;
  const additiveTags = extractAdditiveCodes(product);
  const additivesCount = additiveTags.length;

  const additiveNames = additiveTags.map(a => additiveDisplayName(a)).join(', ') || '';

  const additiveList = additiveTags.map(a => {
    const key = String(a).replace(/^en:/i, '').toLowerCase();
    const name = additiveDisplayName(key);
    const details = additiveRiskDetails(key);
    return {
      code: key,
      name: name,
      category: details?.category || 'Food additive',
      riskLevel: details?.riskLevel || 'safe',
      description: details?.description || 'No additional information available for this additive.',
      learnMoreUrl: details?.learnMoreUrl || `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(name)}`,
    };
  });

  const organicStatus = resolveOrganicStatus(product.labels_tags);
  const isOrganicForScore = organicStatus === 'yes';
  const servingNutrition = resolveFoodServingNutrition(product.nutriments, product.serving_quantity);
  const {
    servingQuantity,
    servingKnown,
    proteinRaw,
    sugarRaw,
    sodiumRaw,
    proteinDisplay,
    sugarDisplay,
    sodiumDisplay,
    sugarTier,
    sodiumTier,
    proteinTier,
  } = servingNutrition;
  // For scoring purposes, fall back to 0 when data is missing
  const protein = proteinRaw ?? 0;
  const sugar = sugarRaw ?? 0;
  const sodium = sodiumRaw ?? 0;
  const score = calculateScore(nutriScore, novaGroup, additivesCount, isOrganicForScore, protein, sugar, sodium, additiveList, barcode, product.nutriments, product.foodCategory);
  const scoreBreakdown = getScoreBreakdown(nutriScore, novaGroup, additivesCount, isOrganicForScore, protein, sugar, sodium, additiveList, product.nutriments, product.foodCategory);

  let alternatives = [];
  if (score != null && score < 50) {
    try {
      alternatives = await getCategoryAlternatives(barcode, product.categories_tags, score);
    } catch (altErr) {
      console.log(`[ALTERNATIVES ERROR] barcode=${barcode} ${altErr.message}`);
    }
  }

  console.log(`[SCORE DEBUG] barcode=${barcode} nutriScore=${nutriScore} nutritionPath=${scoreBreakdown.nutritionPath} nutritionAvailable=${scoreBreakdown.nutritionAvailable} nutriPts=${scoreBreakdown.nutriPts} novaGroup=${novaGroup} additivesCount=${additivesCount} isOrganic=${organicStatus} protein100g=${protein} sugar100g=${sugar} sodium100g=${sodium} => score=${score}`);

  // Format display values — show "N/A" when data is genuinely missing
  const fmtProtein = formatGrams(proteinDisplay);
  const fmtSugar = formatGrams(sugarDisplay);
  const fmtSodium = formatSodiumMg(sodiumDisplay);
  const fmtProtein100g = formatGrams(proteinRaw);
  const fmtSugar100g = formatGrams(sugarRaw);
  const fmtSodium100g = formatSodiumMg(sodiumRaw);

  // Explanation numbers must share a basis with their tiers.
  const basisLabel = servingKnown ? 'per serving' : 'per 100g';
  const explainSugar = servingKnown ? sugarDisplay : sugarRaw;
  const explainSodium = servingKnown ? sodiumDisplay : sodiumRaw;
  const explainProtein = servingKnown ? proteinDisplay : proteinRaw;

  let explanation = null;
  const noIngredientData = !hasUsableIngredientText(ingredients);
  if (score == null) {
    explanation = FOOD_INCOMPLETE_NUTRITION_EXPLANATION;
  } else if (noIngredientData) {
    // Fixed copy — do not call Haiku with an empty/junk ingredient list.
    explanation = FOOD_NO_INGREDIENTS_EXPLANATION;
  } else if (!skipExplanation) {
    explanation = await generateFoodExplanation({
      sugarDisplay: explainSugar,
      sodiumDisplay: explainSodium,
      proteinDisplay: explainProtein,
      sugarTier,
      sodiumTier,
      proteinTier,
      additivesCount,
      isOrganic: organicStatus,
      novaGroup,
      ingredients,
      nutriScoreGrade: nutriScore,
      basisLabel,
    });
  }

  const scoreColor = score == null ? '#9E9E9E' : score >= 75 ? '#2E7D32' : score >= 50 ? '#8BC34A' : score >= 25 ? '#FF9800' : '#F44336';
  const scoreLabel = score == null ? 'Not enough data' : score >= 75 ? 'Excellent' : score >= 50 ? 'Good' : score >= 25 ? 'Poor' : 'Bad';

  const responseData = {
    productType: 'food',
    productName,
    additiveNames,
    additiveList: JSON.stringify(additiveList),
    ingredients: ingredients,
    nutriScore,
    nutriScoreKnown,
    novaGroup,
    additivesCount: formatAdditivesCountDisplay(additivesCount, ingredients),
    isOrganic: formatOrganicDisplay(organicStatus),
    protein: fmtProtein,
    sugar: fmtSugar,
    sodium: fmtSodium,
    protein100g: fmtProtein100g,
    sugar100g: fmtSugar100g,
    sodium100g: fmtSodium100g,
    servingQuantity,
    servingKnown,
    scoreBasis: 'per100g',
    sugarTier,
    sodiumTier,
    proteinTier,
    score,
    scoreBreakdown: JSON.stringify(scoreBreakdown),
    alternatives: JSON.stringify(alternatives),
    explanation,
    scoreColor,
    imageUrl,
    scoreLabel,
    coverageMatched: null,
    coverageTotal: null,
    ingredientFindings: null,
    noIngredientData,
    scanLogicVersion: SCAN_LOGIC_VERSION,
    source,
  };
  if (skipExplanation && !noIngredientData && score != null) {
    responseData.explanationPending = true;
  }
  return responseData;
}

// Photo-rescued cache docs have no upstream to re-fetch from. Re-score from
// the stored ingredients text when the entry is stale (TTL or tableVersion).
// Returns null when ingredients are missing — caller falls through to upstream.
// Also: quality overwrite, 30-day upstream recheck, provenance fields.
const PHOTO_UPSTREAM_RECHECK_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function rescorePhotoCachedDocument(cached) {
  const ingredientsText = String((cached && cached.ingredients) || '').trim();
  if (!ingredientsText) return null;

  const scoredStub = {
    score: null,
    coverageMatched: 0,
    coverageTotal: 0,
    unparseableCount: 0,
    drugFactsMarker: null,
    unmatchedNames: [],
  };

  // Food photo entries must not be re-scored as cosmetics on a table/logic bump.
  if (cached.productType === 'food') {
    const food = buildFoodPhotoScanResponse({
      productName: cached.productName || 'Scanned label',
      imageUrl: cached.imageUrl || '',
      ingredients: ingredientsText,
      extras: {
        source: 'photo',
        photoParsedCount: cached.photoParsedCount,
        photoCapturedAt: cached.photoCapturedAt,
        photoCapturedBy: cached.photoCapturedBy,
      },
    });
    return { responseData: food, scored: scoredStub, unmatchedNames: [] };
  }

  // Household labels must not be re-scored as cosmetics on a table bump.
  if (looksLikeHouseholdProduct(ingredientsText) || cached.productType === 'household') {
    const household = buildHouseholdScanResponse({
      productName: cached.productName || 'Scanned label',
      imageUrl: cached.imageUrl || '',
      ingredients: ingredientsText,
      extras: {
        source: 'photo',
        photoParsedCount: cached.photoParsedCount,
        photoCapturedAt: cached.photoCapturedAt,
        photoCapturedBy: cached.photoCapturedBy,
      },
    });
    return { responseData: household, scored: scoredStub, unmatchedNames: [] };
  }

  const scored = scoreCosmeticProduct({ ingredients_text: ingredientsText });
  const responseData = {
    ...cached,
    productType: 'cosmetic',
    source: 'photo',
    ingredients: ingredientsText,
    score: scored.score,
    scoreBreakdown: JSON.stringify(scored.scoreBreakdown),
    scoreColor: scored.scoreColor,
    scoreLabel: scored.scoreLabel,
    coverageMatched: scored.coverageMatched,
    coverageTotal: scored.coverageTotal,
    assessedCount: scored.assessedCount,
    recognisedCount: scored.recognisedCount,
    totalCount: scored.totalCount,
    noIngredientData: !!scored.noIngredientData,
    ingredientFindings: JSON.stringify(scored.ingredientFindings),
    ingredientList: JSON.stringify(scored.ingredientList || []),
    tableVersion: COSMETIC_TABLE_VERSION,
    scanLogicVersion: SCAN_LOGIC_VERSION,
    // photoCapturedAt / photoParsedCount / photoCapturedBy are provenance of
    // the human transcription — never refresh them on local re-score.
  };
  delete responseData.cachedAt;

  // Drop a stale Haiku explanation when the scored outcome changed — otherwise
  // hasUsableExplanation keeps the old sentence (written for the previous
  // score/findings) after a tableVersion bump.
  const outcomeChanged =
    scored.score !== cached.score ||
    scored.coverageMatched !== cached.coverageMatched ||
    scored.coverageTotal !== cached.coverageTotal;
  if (outcomeChanged) {
    responseData.explanation = null;
    responseData.explanationPending = true;
  } else if (responseData.explanation && String(responseData.explanation).trim()) {
    responseData.explanationPending = false;
  }

  return { responseData, scored, unmatchedNames: scored.unmatchedNames || [] };
}

// Quality of a photo-derived cache candidate.
function photoCacheParsedCount(entry) {
  if (!entry) return 0;
  if (typeof entry.photoParsedCount === 'number') return entry.photoParsedCount;
  // Legacy photo docs written before photoParsedCount existed.
  if (typeof entry.coverageTotal === 'number') return entry.coverageTotal;
  return 0;
}

function photoCacheCoverageMatched(entry) {
  if (!entry) return 0;
  return typeof entry.coverageMatched === 'number' ? entry.coverageMatched : 0;
}

function photoParsedCountWithin50Percent(existingParsed, incomingParsed) {
  if (existingParsed <= 0) return true;
  const ratio = incomingParsed / existingParsed;
  return ratio >= 0.5 && ratio <= 1.5;
}

// Incoming photo may replace an existing photo entry only when:
//   - the existing entry is sparse (< 3 parsed ingredients), OR
//   - incoming matches MORE hazard-table ingredients AND its parsed count is
//     within 50% of existing (similar product, better coverage — not a wrong label).
// Upstream (non-photo) data is never overwritten by a photo.
function shouldReplaceWithPhotoCache(existing, incoming) {
  if (!existing) return true;
  if (existing.source !== 'photo') return false;

  const existingParsed = photoCacheParsedCount(existing);
  const incomingParsed = photoCacheParsedCount(incoming);
  const existingMatched = photoCacheCoverageMatched(existing);
  const incomingMatched = photoCacheCoverageMatched(incoming);

  if (existingParsed < 3) return true;

  if (
    incomingMatched > existingMatched &&
    photoParsedCountWithin50Percent(existingParsed, incomingParsed)
  ) {
    return true;
  }
  return false;
}

function photoNeedsUpstreamRecheck(cached) {
  if (!cached || cached.source !== 'photo') return false;
  const last = typeof cached.lastUpstreamCheck === 'number' ? cached.lastUpstreamCheck : 0;
  return Date.now() - last >= PHOTO_UPSTREAM_RECHECK_MS;
}

// Whether an upstream resolve result should replace a photo cache entry.
function shouldReplacePhotoWithUpstream(product) {
  return !!(product && productHasIngredients(product));
}

// Cache/scan payload with nothing to score: no usable ingredient text, empty
// ingredientList, or a null score. Used both ways — photo may overwrite such
// an upstream entry, and a photo entry must not be discarded for one.
function isUnscoreableCacheEntry(entry) {
  if (!entry) return true;
  let ingredientList = [];
  try {
    const parsed = JSON.parse(entry.ingredientList || '[]');
    ingredientList = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    ingredientList = [];
  }
  const noUsableIngredients =
    !hasUsableIngredientText(entry.ingredients) &&
    ingredientList.length === 0;
  return noUsableIngredients || entry.score == null;
}

// When a re-scan fails, prefer a stale cache over a false "not found".
// Returns the response payload, or null if there is nothing to fall back to.
function staleCacheFallbackPayload(staleCached) {
  if (!staleCached) return null;
  const { cachedAt, ...responseData } = staleCached;
  if (!responseData.productType) responseData.productType = 'food';
  // Product/nutrition may stay for resilience, but an explanation generated
  // under an older SCAN_LOGIC_VERSION must not leak through a failed refresh.
  if (staleCached.scanLogicVersion !== SCAN_LOGIC_VERSION) {
    delete responseData.explanation;
    responseData.explanationPending = true;
  }
  return responseData;
}

async function scanAndCache(barcode, { skipCacheCheck = false, skipExplanation = false } = {}) {
  let staleCached = null;

  if (!skipCacheCheck) {
    try {
      const cacheDoc = await getDocWithBarcodeMigration(CACHE_COLLECTION, barcode);
      if (cacheDoc.exists) {
        const cached = cacheDoc.data();
        const age = Date.now() - (cached.cachedAt || 0);
        const cachedType = cached.productType || 'food';
        // Documents cached before scanLogicVersion existed (or on an older
        // logic version) must re-scan so classification/scoring fixes apply.
        const logicStale = cached.scanLogicVersion !== SCAN_LOGIC_VERSION;
        // Cosmetic scores must be recomputed when the hazard table changes.
        const tableStale = cachedType === 'cosmetic' &&
          cached.tableVersion !== COSMETIC_TABLE_VERSION;
        if (age < CACHE_TTL_MS && !tableStale && !logicStale) {
          console.log(`[CACHE HIT] barcode=${barcode} type=${cachedType} age=${Math.round(age / 3600000)}h`);
          const { cachedAt, ...responseData } = cached;
          if (!responseData.productType) responseData.productType = 'food';

          // Old TestFlight clients always need an explanation. If a deferred
          // scan cached a pending entry, fill it inline before returning.
          if (!skipExplanation && !hasUsableExplanation(responseData)) {
            try {
              const explanation = await ensureExplanation(barcode, responseData);
              responseData.explanation = explanation;
              responseData.explanationPending = false;
            } catch (fillErr) {
              console.log(`[EXPLAIN FILL ERROR] barcode=${barcode} ${fillErr.message}`);
            }
          }
          return responseData;
        }

        // Keep the stale doc for photo local re-score and stale-beats-nothing.
        staleCached = cached;
        if (logicStale) {
          console.log(`[CACHE STALE LOGIC] barcode=${barcode} cached=${cached.scanLogicVersion} current=${SCAN_LOGIC_VERSION} — re-scanning`);
        } else if (tableStale) {
          console.log(`[CACHE STALE TABLE] barcode=${barcode} cached=${cached.tableVersion} current=${COSMETIC_TABLE_VERSION} — re-scanning`);
        } else {
          console.log(`[CACHE STALE] barcode=${barcode} age=${Math.round(age / 3600000)}h — re-scanning`);
        }

        // Photo entries: optional 30-day upstream recheck, else local re-score.
        // Never 404 from this path — fall through to stale-fallback if needed.
        if (cached.source === 'photo') {
          let attemptedUpstreamRecheck = false;

          if (photoNeedsUpstreamRecheck(cached)) {
            attemptedUpstreamRecheck = true;
            try {
              const resolved = await resolveProductType(barcode);
              if (shouldReplacePhotoWithUpstream(resolved.product)) {
                const upstreamData = resolved.productType === 'household'
                  ? scanAndCacheHousehold(barcode, resolved.product)
                  : resolved.productType === 'cosmetic'
                    ? await scanAndCacheCosmetic(barcode, resolved.product, { skipExplanation })
                    : await scanAndCacheFood(barcode, resolved.product, { skipExplanation });

                // Same unscoreable rule as [PHOTO CACHE REPLACED UNSCOREABLE],
                // opposite direction: do not discard photo data for a worse
                // upstream (e.g. food-no-nutrition "Not enough data").
                if (isUnscoreableCacheEntry(upstreamData)) {
                  console.log(`[CACHE PHOTO UPSTREAM WORSE] barcode=${barcode}`);
                } else {
                  console.log(
                    `[CACHE PHOTO UPSTREAM REPLACE] barcode=${barcode} type=${resolved.productType}`
                  );

                  if (!upstreamData.noIngredientData) {
                    try {
                      const cachePayload = {
                        ...upstreamData,
                        cachedAt: Date.now(),
                      };
                      if (upstreamData.productType === 'cosmetic' && upstreamData.ingredientList) {
                        cachePayload.ingredientList = stringifyIngredientListForCache(
                          (() => { try { return JSON.parse(upstreamData.ingredientList); } catch (_) { return []; } })(),
                          barcode
                        );
                      }
                      await db.collection(CACHE_COLLECTION).doc(barcode).set(cachePayload);
                    } catch (cacheWriteErr) {
                      console.log(`[CACHE WRITE ERROR] barcode=${barcode} ${cacheWriteErr.message}`);
                    }
                  } else {
                    console.log(`[CACHE SKIP] barcode=${barcode} noIngredientData=true`);
                  }

                  if (!skipExplanation && !hasUsableExplanation(upstreamData)) {
                    try {
                      const explanation = await ensureExplanation(barcode, upstreamData);
                      upstreamData.explanation = explanation;
                      upstreamData.explanationPending = false;
                    } catch (fillErr) {
                      console.log(`[EXPLAIN FILL ERROR] barcode=${barcode} ${fillErr.message}`);
                    }
                  }
                  return upstreamData;
                }
              } else {
                console.log(
                  `[CACHE PHOTO UPSTREAM MISS] barcode=${barcode} hasProduct=${!!resolved.product}`
                );
              }
            } catch (upstreamErr) {
              console.log(
                `[CACHE PHOTO UPSTREAM ERROR] barcode=${barcode} ${upstreamErr.message}`
              );
            }
          }

          const rescored = rescorePhotoCachedDocument(cached);
          if (rescored) {
            console.log(`[CACHE PHOTO RESCORE] barcode=${barcode} coverage=${rescored.scored.coverageMatched}/${rescored.scored.coverageTotal} score=${rescored.scored.score} table=${COSMETIC_TABLE_VERSION}`);
            console.log(`[UNPARSEABLE] barcode=${barcode} count=${rescored.scored.unparseableCount || 0}`);
            if (rescored.scored.drugFactsMarker) {
              console.log(`[DRUG FACTS TRUNCATED] barcode=${barcode} marker=${rescored.scored.drugFactsMarker}`);
            }
            const unmatchedNames = rescored.unmatchedNames;
            const namesJoined = unmatchedNames.map(unmatchedNameLabel).join('|');
            const namesTruncated = namesJoined.length > 200
              ? namesJoined.slice(0, 200) + '...'
              : namesJoined;
            console.log(`[COSMETIC UNMATCHED] barcode=${barcode} count=${unmatchedNames.length} names=${namesTruncated}`);
            recordUnmatchedInci(barcode, unmatchedNames);

            const responseData = rescored.responseData;
            try {
              const cachePayload = {
                ...responseData,
                cachedAt: Date.now(),
              };
              if (attemptedUpstreamRecheck) {
                cachePayload.lastUpstreamCheck = Date.now();
              }
              if (responseData.ingredientList) {
                cachePayload.ingredientList = stringifyIngredientListForCache(
                  (() => { try { return JSON.parse(responseData.ingredientList); } catch (_) { return []; } })(),
                  barcode
                );
              }
              await db.collection(CACHE_COLLECTION).doc(barcode).set(cachePayload);
            } catch (cacheWriteErr) {
              console.log(`[CACHE WRITE ERROR] barcode=${barcode} ${cacheWriteErr.message}`);
            }

            if (!skipExplanation && !hasUsableExplanation(responseData)) {
              try {
                const explanation = await ensureExplanation(barcode, responseData);
                responseData.explanation = explanation;
                responseData.explanationPending = false;
              } catch (fillErr) {
                console.log(`[EXPLAIN FILL ERROR] barcode=${barcode} ${fillErr.message}`);
              }
            }
            return responseData;
          }
          console.log(`[CACHE PHOTO RESCORE SKIP] barcode=${barcode} reason=no_ingredients`);
        }
      }
    } catch (cacheErr) {
      console.log(`[CACHE READ ERROR] barcode=${barcode} ${cacheErr.message}`);
    }
  }

  let responseData;
  try {
    const { productType, product } = await resolveProductType(barcode);
    if (!product) {
      const notFoundErr = new Error('Product not found');
      notFoundErr.statusCode = 404;
      throw notFoundErr;
    }

    responseData = productType === 'household'
      ? scanAndCacheHousehold(barcode, product)
      : productType === 'cosmetic'
        ? await scanAndCacheCosmetic(barcode, product, { skipExplanation })
        : await scanAndCacheFood(barcode, product, { skipExplanation });
  } catch (refreshErr) {
    // Stale beats nothing: a slightly old answer is better than a false 404
    // (photo-rescued products, OFF/OBF outages, network errors).
    const fallback = staleCacheFallbackPayload(staleCached);
    if (fallback) {
      const reason = refreshErr.statusCode === 404 ? 'not_found' : (refreshErr.message || 'refresh_failed');
      console.log(`[CACHE STALE FALLBACK] barcode=${barcode} reason=${reason}`);
      // Version-mismatched explanations were omitted above. Do not reattach
      // from Firestore or call Haiku — refresh already failed.
      const logicMismatch = staleCached.scanLogicVersion !== SCAN_LOGIC_VERSION;
      if (!logicMismatch && !skipExplanation && !hasUsableExplanation(fallback)) {
        try {
          const explanation = await ensureExplanation(barcode, fallback);
          fallback.explanation = explanation;
          fallback.explanationPending = false;
        } catch (fillErr) {
          console.log(`[EXPLAIN FILL ERROR] barcode=${barcode} ${fillErr.message}`);
        }
      }
      return fallback;
    }
    throw refreshErr;
  }

  // Products found without an ingredient list are not worth caching — OBF may
  // gain ingredients later, and "0 of 0" is not a durable result.
  if (responseData.noIngredientData) {
    console.log(`[CACHE SKIP] barcode=${barcode} noIngredientData=true`);
    return responseData;
  }

  try {
    const cachePayload = {
      ...responseData,
      cachedAt: Date.now(),
    };
    // Keep the full ingredientList in the HTTP response; shrink only the cache write.
    if (responseData.productType === 'cosmetic' && responseData.ingredientList) {
      cachePayload.ingredientList = stringifyIngredientListForCache(
        (() => { try { return JSON.parse(responseData.ingredientList); } catch (_) { return []; } })(),
        barcode
      );
    }
    await db.collection(CACHE_COLLECTION).doc(barcode).set(cachePayload);
  } catch (cacheWriteErr) {
    console.log(`[CACHE WRITE ERROR] barcode=${barcode} ${cacheWriteErr.message}`);
  }

  return responseData;
}

// Liveness for uptime monitors. No auth, no rate limit. Checks only what we
// control: Firestore reachability + non-empty reference maps at boot.
app.get('/health', async (req, res) => {
  const counts = getReferenceEntryCounts();
  let firestoreOk = false;
  try {
    await pingFirestore();
    firestoreOk = true;
  } catch (err) {
    console.log(`[HEALTH] firestore ping failed: ${err.message}`);
    firestoreOk = false;
  }

  const result = evaluateHealthStatus({
    firestoreOk,
    hazardCount: counts.hazardCount,
    synonymCount: counts.synonymCount,
    cosingCount: counts.cosingCount,
    uptimeSeconds: Math.floor(process.uptime()),
    tableVersion: COSMETIC_TABLE_VERSION,
    cosingNamesVersion: COSING_NAMES_VERSION,
  });
  return res.status(result.status).json(result.body);
});

app.get('/scan/:barcode', async (req, res) => {
  try {
    if (!enforceIpRateLimit(req, res, '/scan', RATE_LIMIT_SCAN_SEARCH_PER_IP)) return;

    const barcode = normalizeBarcode(req.params.barcode);
    if (!barcode) {
      return res.status(400).json({ error: 'Invalid barcode' });
    }
    const deferExplanation = req.query.deferExplanation === '1';

    // Try to get the user's health profile from their Firestore document.
    // Best-effort — a missing/invalid token just means no diet warnings, never a blocked scan.
    let healthProfile = '';
    try {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace('Bearer ', '').trim();
      if (token) {
        const decoded = await admin.auth().verifyIdToken(token);
        // FIX (session 7): look up the user doc directly by its ID (the
        // Firestore doc ID IS the uid in this schema) instead of querying
        // for a `uid` field that isn't actually stored in the document —
        // that query always matched zero docs, silently.
        const userDoc = await db.collection('users').doc(decoded.uid).get();
        if (userDoc.exists) {
          healthProfile = userDoc.data().healthProfile || '';
        }
      }
    } catch (authErr) {
      console.log(`[DIET] auth/profile lookup failed: ${authErr.message}`);
    }

    const responseData = await scanAndCache(barcode, { skipExplanation: deferExplanation });

    // Diet warning detection — food only. Needs raw OFF product data (labels,
    // allergens etc.) which isn't stored in the cache. Cosmetics skip this.
    let dietWarnings = '';
    const responseType = responseData.productType || 'food';
    if (healthProfile && responseType === 'food') {
      try {
        const offRes = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`, {
          headers: { 'User-Agent': 'DontWorryFoodScanner/1.0 (contact: app developer)' }
        });
        const offData = await offRes.json();
        if (offData.product) {
          dietWarnings = detectDietWarnings(offData.product, healthProfile);
        }
      } catch (dietErr) {
        console.log(`[DIET] product fetch failed: ${dietErr.message}`);
      }
    }

    res.json({ ...responseData, dietWarnings });

    // After the score is already on the wire, fill the Haiku explanation in
    // the background and merge it into the cache. Failures must not matter.
    if (deferExplanation && responseData.explanationPending) {
      ensureExplanation(barcode, responseData).catch(err => {
        console.log(`[EXPLAIN DEFER ERROR] barcode=${barcode} ${err.message}`);
      });
    }
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

const PHOTO_LABEL_PROMPT = `You are reading a cosmetic product ingredient label from a photo.

Transcribe ONLY the cosmetic ingredients / INCI list visible on the label.

Return strict JSON only — no prose, no markdown fences:
{"readable":true|false,"productName":string|null,"ingredients":[...]}

Rules:
- Preserve each ingredient name EXACTLY as printed, including leading positional and stereo prefixes (o-, m-, p-, alpha-). These are not decoration: p-Phenylenediamine is permitted at 2% while o- and m- are prohibited.
- NEVER guess, correct spelling, expand abbreviations, or infer an ingredient that is not legible. Omit anything unreadable.
- Set readable to false if the ingredient list as a whole cannot be read. An empty or unusable list must use readable:false.
- productName is the product's name if clearly visible, otherwise null.
- ingredients is an array of exact name strings in label order when readable is true.`;

const PHOTO_FRONT_PROMPT = `You are reading the FRONT of a cosmetic product pack from a photo.

Decide whether the photo shows commercial product packaging, and if so read ONLY the brand and product name printed on the pack.

Return strict JSON only — no prose, no markdown fences:
{"isProductPackaging":true|false,"readable":true|false,"brand":string|null,"productName":string|null}

Rules:
- isProductPackaging is true ONLY when the image clearly shows commercial product packaging — a bottle, box, tube, jar or label. false for people, body parts, pets, screens, scenery, documents or anything else. When uncertain, return false.
- Read ONLY what is printed on the pack. Never guess, never infer a brand from packaging style, never complete a partially visible name.
- productName excludes the brand; brand is a separate field. Either may be null.
- Set readable to false when nothing usable is legible, or when isProductPackaging is false.
- NEVER invent text that is not clearly printed.`;

function stripJsonFences(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function photoJsonParser(req, res, next) {
  express.json({ limit: '8mb' })(req, res, (err) => {
    if (err && (err.status === 413 || err.type === 'entity.too.large')) {
      return res.status(413).json({ error: 'Image too large. Maximum body size is 8MB.' });
    }
    if (err) {
      return res.status(400).json({ error: err.message || 'Invalid JSON body' });
    }
    next();
  });
}

async function callVisionJson(imageBase64, mediaType, prompt, { maxTokens = 1500 } = {}) {
  const rawBase64 = stripDataUrlBase64(imageBase64);

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: rawBase64,
            },
          },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  const claudeData = await claudeRes.json();
  if (!claudeRes.ok) {
    const msg = claudeData?.error?.message || `Vision request failed (${claudeRes.status})`;
    const err = new Error(msg);
    err.statusCode = 502;
    throw err;
  }

  const text = claudeData.content?.[0]?.text;
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch (_) {
    const err = new Error('Could not parse vision model JSON');
    err.statusCode = 502;
    throw err;
  }
  return parsed;
}

async function readCosmeticLabelFromPhoto(imageBase64, mediaType) {
  return callVisionJson(imageBase64, mediaType, PHOTO_LABEL_PROMPT, { maxTokens: 1500 });
}

async function readFrontOfPackFromPhoto(imageBase64, mediaType) {
  return callVisionJson(imageBase64, mediaType, PHOTO_FRONT_PROMPT, { maxTokens: 400 });
}

// Store front-of-pack image under productImages/{barcode}.
// Returns { stored, skipReason } — never throws.
async function storeProductFrontImage({ barcode, frontImageBase64, frontMediaType, capturedBy }) {
  const code = normalizeBarcode(barcode);
  if (!code) {
    return { stored: false, skipReason: 'no_barcode' };
  }

  const rawBase64 = stripDataUrlBase64(frontImageBase64);
  const bytes = Buffer.byteLength(rawBase64, 'utf8');
  if (bytes > PRODUCT_IMAGE_MAX_BYTES) {
    console.log(`[PRODUCT IMAGE TOO LARGE] barcode=${code} bytes=${bytes} cap=${PRODUCT_IMAGE_MAX_BYTES}`);
    return { stored: false, skipReason: 'too_large' };
  }
  if (bytes <= 0) {
    return { stored: false, skipReason: 'too_large' };
  }

  const docRef = db.collection(PRODUCT_IMAGES_COLLECTION).doc(code);
  try {
    const existingDoc = await getDocWithBarcodeMigration(PRODUCT_IMAGES_COLLECTION, code);
    const existing = existingDoc.exists ? existingDoc.data() : null;
    if (!shouldWriteProductImage(existing)) {
      console.log(`[PRODUCT IMAGE KEPT EXISTING] barcode=${code} bytes=${existing.bytes}`);
      return { stored: true, skipReason: 'existing_kept' };
    }
    // New write (including replacing a suppressed image) always starts clean.
    await docRef.set({
      data: rawBase64,
      mediaType: frontMediaType,
      bytes,
      capturedAt: admin.firestore.FieldValue.serverTimestamp(),
      capturedBy: capturedBy || null,
      reportedBy: [],
      reportCount: 0,
      suppressed: false,
    });
    console.log(`[PRODUCT IMAGE STORED] barcode=${code} bytes=${bytes}`);
    return { stored: true, skipReason: null };
  } catch (err) {
    console.log(`[PRODUCT IMAGE STORE ERROR] barcode=${code} ${err.message}`);
    recordFailedWrite({
      collection: 'productImages',
      barcode: code,
      payload: { mediaType: frontMediaType, bytes, data: rawBase64 },
      error: err.message,
      capturedBy,
    });
    return { stored: false, skipReason: 'write_failed' };
  }
}

// Append imageReports audit row. Never throws.
function recordImageReportAudit({ barcode, reason, reportedBy }) {
  (async () => {
    try {
      await db.collection(IMAGE_REPORTS_COLLECTION).add({
        barcode: barcode ? String(barcode) : null,
        reason: reason != null ? String(reason).slice(0, 500) : null,
        reportedBy: reportedBy || null,
        reportedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.log(`[IMAGE REPORT AUDIT ERROR] barcode=${barcode || 'none'} ${err.message}`);
      recordFailedWrite({
        collection: 'imageReports',
        barcode,
        payload: { reason, reportedBy },
        error: err.message,
        capturedBy: reportedBy,
      });
    }
  })();
}

// Apply a user report to productImages in a transaction. Clears cache imageUrl
// when suppressing. Returns { suppressed, alreadyReported, missing }. Never throws.
async function applyProductImageReport({ barcode, uid }) {
  const code = normalizeBarcode(barcode);
  if (!code || !uid) return { suppressed: false, alreadyReported: false, missing: true };

  try {
    let suppressed = false;
    let alreadyReported = false;
    let missing = false;
    let reportCount = 0;

    // Heal legacy 12-digit keys before the transaction so the report lands
    // on the canonical productImages / productCache docs.
    await getDocWithBarcodeMigration(PRODUCT_IMAGES_COLLECTION, code);
    await getDocWithBarcodeMigration(CACHE_COLLECTION, code);

    await db.runTransaction(async (tx) => {
      const imageRef = db.collection(PRODUCT_IMAGES_COLLECTION).doc(code);
      const imageDoc = await tx.get(imageRef);
      if (!imageDoc.exists) {
        missing = true;
        return;
      }
      const data = imageDoc.data() || {};
      const reportedBy = Array.isArray(data.reportedBy) ? data.reportedBy.slice() : [];
      if (reportedBy.includes(uid)) {
        alreadyReported = true;
        reportCount = typeof data.reportCount === 'number' ? data.reportCount : reportedBy.length;
        suppressed = data.suppressed === true;
        return;
      }

      reportedBy.push(uid);
      reportCount = (typeof data.reportCount === 'number' ? data.reportCount : 0) + 1;
      const update = {
        reportedBy,
        reportCount,
      };

      if (reportCount >= IMAGE_SUPPRESS_REPORT_THRESHOLD) {
        update.suppressed = true;
        suppressed = true;
        const cacheRef = db.collection(CACHE_COLLECTION).doc(code);
        const cacheDoc = await tx.get(cacheRef);
        if (cacheDoc.exists) {
          tx.update(cacheRef, { imageUrl: '' });
        }
      }

      tx.update(imageRef, update);
    });

    if (suppressed && !alreadyReported) {
      console.log(`[PRODUCT IMAGE SUPPRESSED] barcode=${code} reports=${reportCount}`);
    }
    return { suppressed, alreadyReported, missing, reportCount };
  } catch (err) {
    console.log(`[PRODUCT IMAGE REPORT ERROR] barcode=${code} ${err.message}`);
    recordFailedWrite({
      collection: 'productImages',
      barcode: code,
      payload: { action: 'report', uid },
      error: err.message,
      capturedBy: uid,
    });
    return { suppressed: false, alreadyReported: false, missing: false, error: err.message };
  }
}

app.post('/scan/photo', photoJsonParser, async (req, res) => {
  const started = Date.now();

  // IP limit first — cheap backstop before Firebase verify / Anthropic.
  if (!enforceIpRateLimit(req, res, '/scan/photo', RATE_LIMIT_PHOTO_PER_IP)) return;

  // Required auth — /scan/photo is a permanent global write path.
  let photoCapturedBy;
  try {
    const token = parseBearerToken(req.headers['authorization'] || '');
    if (!token) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded || !decoded.uid) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    photoCapturedBy = decoded.uid;
  } catch (authErr) {
    console.log(`[PHOTO SCAN] auth failed: ${authErr.message}`);
    return res.status(401).json({ error: 'Sign in required' });
  }

  const uidLimit = checkRateLimit(
    `/scan/photo:uid:${photoCapturedBy}`,
    RATE_LIMIT_PHOTO_PER_UID
  );
  if (!uidLimit.allowed) {
    return sendRateLimited(res, '/scan/photo', `uid:${photoCapturedBy}`, uidLimit.retryAfter);
  }

  try {
    const {
      imageBase64,
      mediaType,
      barcode,
      frontImageBase64,
      frontMediaType,
    } = req.body || {};
    const normalizedBarcode = barcode ? normalizeBarcode(barcode) : null;
    // Defer only works when we will write a cache doc the app can poll via /explain.
    const deferExplanation = req.query.deferExplanation === '1' && !!normalizedBarcode;

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'Missing imageBase64' });
    }
    if (mediaType !== 'image/jpeg' && mediaType !== 'image/png') {
      return res.status(400).json({ error: 'mediaType must be image/jpeg or image/png' });
    }

    const hasFrontImage = frontImageBase64 != null && frontImageBase64 !== '';
    if (hasFrontImage) {
      if (typeof frontImageBase64 !== 'string') {
        return res.status(400).json({ error: 'frontImageBase64 must be a string' });
      }
      if (frontMediaType !== 'image/jpeg' && frontMediaType !== 'image/png') {
        return res.status(400).json({ error: 'frontMediaType must be image/jpeg or image/png' });
      }
    }

    // Hard daily ceiling — bounds the Anthropic bill regardless of per-user limits.
    if (!tryConsumeVisionSlot()) {
      console.log(`[VISION CAP REACHED] cap=${VISION_DAILY_CAP} day=${visionDayKey}`);
      return res.status(503).json({ error: 'Photo scanning temporarily unavailable' });
    }

    const vision = await readCosmeticLabelFromPhoto(imageBase64, mediaType);

    const ingredientNames = Array.isArray(vision.ingredients)
      ? vision.ingredients.map(n => String(n || '').trim()).filter(Boolean)
      : [];

    if (!vision.readable || ingredientNames.length === 0) {
      console.log(`[PHOTO SCAN] barcode=${normalizedBarcode || 'none'} readable=${!!vision.readable} parsed=${ingredientNames.length} matched=0 ms=${Date.now() - started}`);
      return res.status(422).json({ error: 'Could not read the ingredients' });
    }

    const ingredientsText = ingredientNames.join(', ');

    // Classify when a barcode is supplied — never assume cosmetic for known foods.
    // No barcode (original not-found flow) keeps the cosmetic path.
    let resolvedType = null;
    let upstreamProduct = null;
    let productName = '';
    let imageUrl = '';
    if (normalizedBarcode) {
      try {
        const resolved = await resolveProductType(String(normalizedBarcode));
        resolvedType = resolved.productType || null;
        upstreamProduct = resolved.product || null;
        if (upstreamProduct) {
          const upstreamName = String(upstreamProduct.product_name || '').trim();
          if (upstreamName) productName = upstreamName;
          imageUrl = upstreamProduct.image_front_url || upstreamProduct.image_url || '';
        }
      } catch (upstreamLookupErr) {
        console.log(`[PHOTO SCAN UPSTREAM LOOKUP] barcode=${normalizedBarcode} ${upstreamLookupErr.message}`);
      }
    }

    const isFoodPhoto = resolvedType === 'food';
    // Resolved household wins; otherwise EPA-label heuristic (no-barcode / cosmetic path).
    const isHousehold = resolvedType === 'household'
      || (!isFoodPhoto && looksLikeHouseholdProduct(ingredientsText));
    // Cosmetic path: resolved cosmetic, unknown/not-found, or no barcode.
    const isCosmeticPhoto = !isFoodPhoto && !isHousehold;

    // Photo scans have no upstream DB payload — keep the vision transcription.
    const observationType = isFoodPhoto
      ? 'food'
      : (isHousehold ? 'household' : 'cosmetic');
    recordRawObservation({
      barcode: normalizedBarcode || null,
      productType: observationType,
      source: 'photo',
      payload: vision,
      tableVersion: COSMETIC_TABLE_VERSION,
      photoCapturedBy,
    });

    const product = { ingredients_text: ingredientsText };
    // Food / household: skip cosmetic scoring entirely (empty ingredientList, fixed copy).
    const scored = isCosmeticPhoto ? scoreCosmeticProduct(product) : null;

    // Cache below-gate photo rescues too — transcribed ingredients are valuable
    // even when score is null. Never cache a zero-ingredient parse.
    // Food/household results cache with an empty ingredientList so rescans are instant.
    const photoParsedCount = isCosmeticPhoto
      ? (Array.isArray(scored.ingredientList) ? scored.ingredientList.length : 0)
      : 0;
    const canCache = !!normalizedBarcode && (isHousehold || isFoodPhoto || photoParsedCount > 0);
    // Ignore defer when we are not caching — there is no doc for /explain to fill.
    // Food/household explanations are fixed strings; never defer or call Haiku.
    const skipExplanation = isCosmeticPhoto && deferExplanation && canCache;

    let explanation = null;
    if (isHousehold) {
      explanation = HOUSEHOLD_EXPLANATION;
      console.log(`[HOUSEHOLD] barcode=${normalizedBarcode || 'none'} photo=true`);
    } else if (isFoodPhoto) {
      explanation = FOOD_PHOTO_EXPLANATION;
      console.log(`[FOOD PHOTO] barcode=${normalizedBarcode || 'none'} — skipping score`);
    } else if (!skipExplanation) {
      explanation = await generateCosmeticExplanation(scored, ingredientsText);
    }

    if (isCosmeticPhoto) {
      const unmatchedNames = scored.unmatchedNames || [];
      const namesJoined = unmatchedNames.map(unmatchedNameLabel).join('|');
      const namesTruncated = namesJoined.length > 200
        ? namesJoined.slice(0, 200) + '...'
        : namesJoined;
      console.log(`[COSMETIC UNMATCHED] barcode=${normalizedBarcode || 'none'} count=${unmatchedNames.length} names=${namesTruncated}`);
      recordUnmatchedInci(normalizedBarcode || null, unmatchedNames);
      console.log(`[UNPARSEABLE] barcode=${normalizedBarcode || 'none'} count=${scored.unparseableCount || 0}`);
      if (scored.drugFactsMarker) {
        console.log(`[DRUG FACTS TRUNCATED] barcode=${normalizedBarcode || 'none'} marker=${scored.drugFactsMarker}`);
      }
    }

    // Optional front-of-pack: second vision call (name) + store image for serving.
    // If the daily cap is hit mid-scan, keep the ingredients result and drop the front read.
    let frontVision = null;
    let imageStored = false;
    let imageSkipReason = null;
    if (hasFrontImage) {
      if (tryConsumeVisionSlot()) {
        try {
          frontVision = await readFrontOfPackFromPhoto(frontImageBase64, frontMediaType);
        } catch (frontErr) {
          console.log(`[PHOTO FRONT READ ERROR] barcode=${normalizedBarcode || 'none'} ${frontErr.message}`);
        }
      } else {
        console.log(
          `[VISION CAP REACHED] cap=${VISION_DAILY_CAP} day=${visionDayKey} dropped=front_read barcode=${normalizedBarcode || 'none'}`
        );
      }

      if (frontVision && !isFrontProductPackaging(frontVision)) {
        console.log(
          `[PRODUCT IMAGE REJECTED] barcode=${normalizedBarcode || 'none'} uid=${photoCapturedBy}`
        );
        imageStored = false;
        imageSkipReason = 'not_product';
        // Do not trust brand/productName from a non-packaging photo.
        frontVision = null;
      } else if (!normalizedBarcode) {
        imageStored = false;
        imageSkipReason = 'no_barcode';
      } else if (frontVision && isFrontProductPackaging(frontVision)) {
        const imageResult = await storeProductFrontImage({
          barcode: normalizedBarcode,
          frontImageBase64,
          frontMediaType,
          capturedBy: photoCapturedBy,
        });
        imageStored = !!imageResult.stored;
        imageSkipReason = imageResult.skipReason;
      }
      // else: vision missing/failed — do not store without packaging confirmation
    }

    // Name priority: upstream > front-of-pack (packaging only) > ingredients-panel > "Scanned label".
    if (!productName) {
      const frontName = composeFrontProductName(frontVision);
      if (frontName) productName = frontName;
    }
    if (!productName && vision.productName && String(vision.productName).trim()) {
      productName = String(vision.productName).trim();
    }
    if (!productName) productName = 'Scanned label';

    // Point at our stored front image only when upstream provided none.
    // Requires PUBLIC_BASE_URL — never invent a URL from request headers.
    if (!imageUrl && imageStored && normalizedBarcode) {
      const base = resolvePublicBaseUrl();
      if (base) {
        imageUrl = `${base}/image/${normalizedBarcode}`;
      }
    }

    const photoCapturedAt = Date.now();
    let persisted = false;
    const photoExtras = {
      source: 'photo',
      photoParsedCount,
      photoCapturedAt,
      photoCapturedBy,
      dietWarnings: '',
      imageStored,
      imageSkipReason,
      persisted,
    };
    let responseData;
    if (isHousehold) {
      responseData = buildHouseholdScanResponse({
        productName,
        imageUrl,
        ingredients: ingredientsText,
        extras: photoExtras,
      });
    } else if (isFoodPhoto) {
      responseData = buildFoodPhotoScanResponse({
        productName,
        imageUrl,
        ingredients: ingredientsText,
        extras: photoExtras,
      });
    } else {
      // Cosmetic path — no barcode, not-found, or resolved cosmetic.
      responseData = {
        productType: 'cosmetic',
        productName,
        additiveNames: null,
        additiveList: JSON.stringify([]),
        ingredients: ingredientsText,
        nutriScore: null,
        novaGroup: null,
        additivesCount: null,
        isOrganic: null,
        protein: null,
        sugar: null,
        sodium: null,
        sugarTier: null,
        sodiumTier: null,
        proteinTier: null,
        score: scored.score,
        scoreBreakdown: JSON.stringify(scored.scoreBreakdown),
        alternatives: JSON.stringify([]),
        explanation,
        scoreColor: scored.scoreColor,
        imageUrl,
        scoreLabel: scored.scoreLabel,
        coverageMatched: scored.coverageMatched,
        coverageTotal: scored.coverageTotal,
        assessedCount: scored.assessedCount,
        recognisedCount: scored.recognisedCount,
        totalCount: scored.totalCount,
        noIngredientData: !!scored.noIngredientData,
        ingredientFindings: JSON.stringify(scored.ingredientFindings),
        ingredientList: JSON.stringify(scored.ingredientList || []),
        tableVersion: COSMETIC_TABLE_VERSION,
        scanLogicVersion: SCAN_LOGIC_VERSION,
        ...photoExtras,
      };
    }
    if (skipExplanation) {
      responseData.explanationPending = true;
    }

    if (canCache) {
      try {
        const docRef = db.collection(CACHE_COLLECTION).doc(String(normalizedBarcode));
        const existingDoc = await docRef.get();
        const existing = existingDoc.exists ? existingDoc.data() : null;
        const incomingMeta = {
          source: 'photo',
          photoParsedCount,
          coverageMatched: isCosmeticPhoto ? scored.coverageMatched : 0,
        };

        let writePhotoCache = true;
        if (existing && existing.source !== 'photo' && isCosmeticPhoto) {
          // Unscoreable upstream (e.g. food-no-nutrition misclassified cosmetic)
          // must not block a photo result that has a real score/ingredients.
          if (isUnscoreableCacheEntry(existing)) {
            console.log(`[PHOTO CACHE REPLACED UNSCOREABLE] barcode=${normalizedBarcode}`);
          } else {
            console.log(`[PHOTO CACHE KEPT UPSTREAM] barcode=${normalizedBarcode}`);
            writePhotoCache = false;
            persisted = true;
          }
        } else if (
          isCosmeticPhoto &&
          existing &&
          !shouldReplaceWithPhotoCache(existing, incomingMeta)
        ) {
          console.log(
            `[PHOTO CACHE KEPT EXISTING] barcode=${normalizedBarcode} existing=${photoCacheParsedCount(existing)} new=${photoParsedCount}`
          );
          writePhotoCache = false;
          persisted = true;
        }

        if (writePhotoCache) {
          const { dietWarnings: _dietWarnings, persisted: _p, imageStored: _is, imageSkipReason: _isr, ...cachePayload } = responseData;
          cachePayload.ingredientList = stringifyIngredientListForCache(
            isCosmeticPhoto ? scored.ingredientList : [],
            normalizedBarcode
          );
          const wrote = await writeProductCacheWithRetry(
            docRef,
            { ...cachePayload, cachedAt: Date.now() },
            { barcode: normalizedBarcode, capturedBy: photoCapturedBy }
          );
          persisted = wrote;
        }
      } catch (cacheWriteErr) {
        // Outer guard — writeProductCacheWithRetry is non-throwing; reads can still fail.
        console.log(`[PHOTO SCAN CACHE WRITE ERROR] barcode=${normalizedBarcode} ${cacheWriteErr.message}`);
        persisted = false;
        recordFailedWrite({
          collection: 'productCache',
          barcode: normalizedBarcode,
          payload: responseData,
          error: cacheWriteErr.message,
          capturedBy: photoCapturedBy,
        });
      }
    } else if (normalizedBarcode && photoParsedCount === 0 && isCosmeticPhoto) {
      console.log(`[PHOTO SCAN NOT CACHED] barcode=${normalizedBarcode} coverage=${scored.coverageMatched}/${scored.coverageTotal}`);
    }
    responseData.persisted = persisted;

    const matchedLog = isCosmeticPhoto ? scored.coverageMatched : 0;
    console.log(`[PHOTO SCAN] barcode=${normalizedBarcode || 'none'} readable=true parsed=${ingredientNames.length} matched=${matchedLog} type=${observationType} front=${hasFrontImage ? 'yes' : 'no'} persisted=${persisted} imageStored=${imageStored} ms=${Date.now() - started}`);
    res.json(responseData);

    if (skipExplanation && responseData.explanationPending) {
      ensureExplanation(String(normalizedBarcode), responseData).catch(err => {
        console.log(`[EXPLAIN DEFER ERROR] barcode=${normalizedBarcode} ${err.message}`);
      });
    }
  } catch (err) {
    console.log(`[PHOTO SCAN ERROR] ${err.message}`);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/image/:barcode', async (req, res) => {
  if (!enforceIpRateLimit(req, res, '/image', RATE_LIMIT_IMAGE_PER_IP)) return;

  const barcode = normalizeBarcode(req.params.barcode);
  if (!barcode) {
    return res.status(400).json({ error: 'Invalid barcode' });
  }
  try {
    const doc = await getDocWithBarcodeMigration(PRODUCT_IMAGES_COLLECTION, barcode);
    if (!doc.exists) {
      return res.status(404).json({ error: 'Not found' });
    }
    const cached = doc.data() || {};
    if (cached.suppressed === true) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (!cached.data || !(cached.bytes > 0)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const buf = Buffer.from(String(cached.data), 'base64');
    res.set('Content-Type', cached.mediaType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    return res.send(buf);
  } catch (err) {
    // Do not leak Firestore internals — treat read failures as missing.
    console.log(`[PRODUCT IMAGE READ ERROR] barcode=${barcode} ${err.message}`);
    return res.status(404).json({ error: 'Not found' });
  }
});

// Front-image-only path for barcodes that already have a photo-rescued cache entry
// but no productImages doc (user skipped the front at scan time). Does not re-parse
// or re-score ingredients. Shares /scan/photo rate-limit buckets.
app.post('/image/:barcode', photoJsonParser, async (req, res) => {
  const started = Date.now();

  // IP limit first — same bucket as /scan/photo so this cannot bypass that limit.
  if (!enforceIpRateLimit(req, res, '/scan/photo', RATE_LIMIT_PHOTO_PER_IP)) return;

  let uid;
  try {
    const token = parseBearerToken(req.headers['authorization'] || '');
    if (!token) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded || !decoded.uid) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    uid = decoded.uid;
  } catch (authErr) {
    console.log(`[FRONT IMAGE] auth failed: ${authErr.message}`);
    return res.status(401).json({ error: 'Sign in required' });
  }

  const uidLimit = checkRateLimit(
    `/scan/photo:uid:${uid}`,
    RATE_LIMIT_PHOTO_PER_UID
  );
  if (!uidLimit.allowed) {
    return sendRateLimited(res, '/scan/photo', `uid:${uid}`, uidLimit.retryAfter);
  }

  const barcode = normalizeBarcode(req.params.barcode);
  if (!barcode) {
    return res.status(400).json({ error: 'Invalid barcode' });
  }

  const { frontImageBase64, frontMediaType } = req.body || {};
  if (!frontImageBase64 || typeof frontImageBase64 !== 'string') {
    return res.status(400).json({ error: 'Missing frontImageBase64' });
  }
  if (frontMediaType !== 'image/jpeg' && frontMediaType !== 'image/png') {
    return res.status(400).json({ error: 'frontMediaType must be image/jpeg or image/png' });
  }

  const rawBase64 = stripDataUrlBase64(frontImageBase64);
  const frontBytes = Buffer.byteLength(rawBase64, 'utf8');
  if (frontBytes > PRODUCT_IMAGE_MAX_BYTES) {
    console.log(`[PRODUCT IMAGE TOO LARGE] barcode=${barcode} bytes=${frontBytes} cap=${PRODUCT_IMAGE_MAX_BYTES}`);
    return res.status(413).json({ error: 'Front image too large' });
  }
  if (frontBytes <= 0) {
    return res.status(400).json({ error: 'Missing frontImageBase64' });
  }

  try {
    // Short-circuit before spending vision when an acceptable image already exists.
    const existingImageDoc = await getDocWithBarcodeMigration(PRODUCT_IMAGES_COLLECTION, barcode);
    const existingImage = existingImageDoc.exists ? existingImageDoc.data() : null;
    if (!shouldWriteProductImage(existingImage)) {
      console.log(
        `[FRONT IMAGE] barcode=${barcode} stored=no packaging=no named=no ms=${Date.now() - started}`
      );
      return res.status(200).json({ ok: true, stored: false });
    }

    if (!tryConsumeVisionSlot()) {
      console.log(`[VISION CAP REACHED] cap=${VISION_DAILY_CAP} day=${visionDayKey}`);
      return res.status(503).json({ error: 'Photo scanning temporarily unavailable' });
    }

    const frontVision = await readFrontOfPackFromPhoto(frontImageBase64, frontMediaType);

    if (!isFrontProductPackaging(frontVision)) {
      console.log(
        `[FRONT IMAGE] barcode=${barcode} stored=no packaging=no named=no ms=${Date.now() - started}`
      );
      return res.status(422).json({ error: 'Not product packaging' });
    }

    const imageResult = await storeProductFrontImage({
      barcode,
      frontImageBase64,
      frontMediaType,
      capturedBy: uid,
    });
    const stored = !!(imageResult && imageResult.stored && imageResult.skipReason == null);

    const productName = composeFrontProductName(frontVision);
    let named = false;
    if (productName) {
      try {
        const cacheRef = db.collection(CACHE_COLLECTION).doc(barcode);
        const cacheDoc = await cacheRef.get();
        if (cacheDoc.exists) {
          const cacheData = cacheDoc.data() || {};
          if (isRepairableProductName(cacheData.productName)) {
            await cacheRef.update({ productName });
            named = true;
          }
        }
      } catch (nameErr) {
        console.log(`[FRONT IMAGE NAME REPAIR ERROR] barcode=${barcode} ${nameErr.message}`);
      }
    }

    console.log(
      `[FRONT IMAGE] barcode=${barcode} stored=${stored ? 'yes' : 'no'} packaging=yes named=${named ? 'yes' : 'no'} ms=${Date.now() - started}`
    );
    return res.status(200).json({ ok: true, stored, productName: productName || null });
  } catch (err) {
    console.log(`[FRONT IMAGE ERROR] barcode=${barcode} ${err.message}`);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Report a bad product image. Same success body whether or not an image exists
// (cannot probe). Auth required. One report per uid per barcode.
app.post('/report/image', async (req, res) => {
  let uid;
  try {
    const token = parseBearerToken(req.headers['authorization'] || '');
    if (!token) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded || !decoded.uid) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    uid = decoded.uid;
  } catch (authErr) {
    console.log(`[IMAGE REPORT] auth failed: ${authErr.message}`);
    return res.status(401).json({ error: 'Sign in required' });
  }

  const uidLimit = checkRateLimit(
    `/report/image:uid:${uid}`,
    RATE_LIMIT_IMAGE_REPORT_PER_UID
  );
  if (!uidLimit.allowed) {
    return sendRateLimited(res, '/report/image', `uid:${uid}`, uidLimit.retryAfter);
  }

  const barcode = normalizeBarcode((req.body && req.body.barcode) || '');
  if (!barcode) {
    return res.status(400).json({ error: 'Invalid barcode' });
  }
  const reason = req.body && req.body.reason != null
    ? String(req.body.reason).slice(0, 500)
    : null;

  // Audit trail always — even when there is no productImages doc (upstream image).
  recordImageReportAudit({ barcode, reason, reportedBy: uid });

  await applyProductImageReport({ barcode, uid });

  // Uniform success — do not reveal whether an image document existed.
  return res.json({ ok: true });
});

// Permanently delete the authenticated user's account data: scan history,
// Firestore user doc, Auth user. Product photos are kept; capturedBy is
// unlinked. Report identities are stripped (reportCount/suppressed unchanged);
// imageReports and failedWrites keep their docs with uid fields nulled.
app.post('/account/delete', async (req, res) => {
  let uid;
  try {
    const token = parseBearerToken(req.headers['authorization'] || '');
    if (!token) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded || !decoded.uid) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    uid = decoded.uid;
  } catch (authErr) {
    console.log(`[ACCOUNT DELETE] auth failed: ${authErr.message}`);
    return res.status(401).json({ error: 'Sign in required' });
  }

  try {
    let scansDeleted = 0;
    while (true) {
      const snap = await db.collection('scans')
        .where('userId', '==', uid)
        .limit(500)
        .get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      scansDeleted += snap.size;
    }

    await db.collection('users').doc(uid).delete();

    let imagesUnlinked = 0;
    while (true) {
      const snap = await db.collection(PRODUCT_IMAGES_COLLECTION)
        .where('capturedBy', '==', uid)
        .limit(500)
        .get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.update(doc.ref, { capturedBy: null }));
      await batch.commit();
      imagesUnlinked += snap.size;
    }

    // Strip reporter identity only — leave reportCount and suppressed as-is.
    let reportsUnlinked = 0;
    while (true) {
      const snap = await db.collection(PRODUCT_IMAGES_COLLECTION)
        .where('reportedBy', 'array-contains', uid)
        .limit(500)
        .get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((doc) => {
        batch.update(doc.ref, {
          reportedBy: admin.firestore.FieldValue.arrayRemove(uid),
        });
      });
      await batch.commit();
      reportsUnlinked += snap.size;
    }

    // Keep imageReports audit docs; anonymize the reporter.
    let imageReportsUnlinked = 0;
    while (true) {
      const snap = await db.collection(IMAGE_REPORTS_COLLECTION)
        .where('reportedBy', '==', uid)
        .limit(500)
        .get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.update(doc.ref, { reportedBy: null }));
      await batch.commit();
      imageReportsUnlinked += snap.size;
    }

    // Keep failedWrites audit docs; anonymize the capturer.
    let failedWritesUnlinked = 0;
    while (true) {
      const snap = await db.collection(FAILED_WRITES_COLLECTION)
        .where('capturedBy', '==', uid)
        .limit(500)
        .get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.update(doc.ref, { capturedBy: null }));
      await batch.commit();
      failedWritesUnlinked += snap.size;
    }

    await admin.auth().deleteUser(uid);

    console.log(
      `[ACCOUNT DELETE] uid=${uid} scansDeleted=${scansDeleted} imagesUnlinked=${imagesUnlinked} reportsUnlinked=${reportsUnlinked} imageReportsUnlinked=${imageReportsUnlinked} failedWritesUnlinked=${failedWritesUnlinked} userDocDeleted=true authDeleted=true`
    );
    return res.json({
      ok: true,
      scansDeleted,
      reportsUnlinked,
      imageReportsUnlinked,
      failedWritesUnlinked,
    });
  } catch (err) {
    console.log(`[ACCOUNT DELETE] failed uid=${uid}: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/explain/:barcode', async (req, res) => {
  if (!enforceIpRateLimit(req, res, '/explain', RATE_LIMIT_SCAN_SEARCH_PER_IP)) return;

  const started = Date.now();
  const barcode = normalizeBarcode(req.params.barcode);
  if (!barcode) {
    return res.status(400).json({ error: 'Invalid barcode' });
  }

  // Same best-effort auth as /scan — never blocks the explain path.
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (token) {
      await admin.auth().verifyIdToken(token);
    }
  } catch (authErr) {
    console.log(`[EXPLAIN] auth lookup failed: ${authErr.message}`);
  }

  try {
    const cacheDoc = await getDocWithBarcodeMigration(CACHE_COLLECTION, barcode);
    if (!cacheDoc.exists) {
      return res.status(404).json({ error: 'Not cached' });
    }

    const cached = cacheDoc.data();
    // Same rule as stale-cache fallback: an explanation generated under an
    // older SCAN_LOGIC_VERSION is missing — generate via ensureExplanation.
    if (cached.scanLogicVersion === SCAN_LOGIC_VERSION && hasUsableExplanation(cached)) {
      console.log(`[EXPLAIN] barcode=${barcode} source=cache ms=${Date.now() - started}`);
      return res.json({ explanation: cached.explanation, ready: true });
    }

    const explanation = await ensureExplanation(barcode, cached);
    console.log(`[EXPLAIN] barcode=${barcode} source=generated ms=${Date.now() - started}`);
    return res.json({ explanation, ready: true });
  } catch (err) {
    console.log(`[EXPLAIN ERROR] barcode=${barcode} ${err.message}`);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/search', async (req, res) => {
  if (!enforceIpRateLimit(req, res, '/search', RATE_LIMIT_SCAN_SEARCH_PER_IP)) return;

  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing search query' });

  // Same best-effort health profile lookup as /scan — a missing/invalid
  // token just means no diet warnings, never a blocked search.
  let healthProfile = '';
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (token) {
      const decoded = await admin.auth().verifyIdToken(token);
      const userDoc = await db.collection('users').doc(decoded.uid).get();
      if (userDoc.exists) {
        healthProfile = userDoc.data().healthProfile || '';
      }
    }
  } catch (authErr) {
    console.log(`[DIET] search auth/profile lookup failed: ${authErr.message}`);
  }

  try {
    const searchUrl = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(query)}&fields=code,product_name,image_front_thumb_url,image_url,brands,quantity,nutriscore_grade,nova_group,additives_tags,ingredients,labels_tags,nutriments,serving_quantity,ingredients_text,allergens_tags,traces_tags,categories_tags&page_size=20&json=1`;
    const response = await fetch(searchUrl);
    if (!response.ok) {
      console.error(`Search-a-licious returned ${response.status}`);
      return res.status(503).json({ error: 'Search is temporarily unavailable, please try again shortly.' });
    }
    const data = await response.json();

    const products = (data.hits || data.products || [])
      .filter(p => p.code && p.product_name)
      .map(p => {
        const productType = classifySearchProductType(p.categories_tags);
        const nutriScore = p.nutriscore_grade;
        const novaGroup = p.nova_group;
        const searchAdditiveCodes = extractAdditiveCodes(p);
        const additivesCount = searchAdditiveCodes.length;
        const organicStatus = resolveOrganicStatus(p.labels_tags);
        const isOrganicForScore = organicStatus === 'yes';
        const servingNutrition = resolveFoodServingNutrition(p.nutriments, p.serving_quantity);
        const {
          servingQuantity,
          servingKnown,
          proteinRaw,
          sugarRaw,
          sodiumRaw,
          proteinDisplay,
          sugarDisplay,
          sodiumDisplay,
          sugarTier,
          sodiumTier,
          proteinTier,
        } = servingNutrition;
        const protein = proteinRaw ?? 0;
        const sugar = sugarRaw ?? 0;
        const sodium = sodiumRaw ?? 0;
        const searchAdditiveList = searchAdditiveCodes.map(a => {
          const details = additiveRiskDetails(a);
          return { riskLevel: details?.riskLevel || 'safe' };
        });

        // Cosmetic/household must not receive a Nutri-Score food score.
        let score;
        let scoreColor;
        let scoreLabel;
        if (productType === 'household' || productType === 'cosmetic') {
          score = null;
          scoreColor = '#9E9E9E';
          scoreLabel = 'Not enough data';
        } else {
          score = calculateScore(nutriScore, novaGroup, additivesCount, isOrganicForScore, protein, sugar, sodium, searchAdditiveList, p.code, p.nutriments, p.foodCategory);
          scoreColor = score == null ? '#9E9E9E' : score >= 75 ? '#2E7D32' : score >= 50 ? '#8BC34A' : score >= 25 ? '#FF9800' : '#F44336';
          scoreLabel = score == null ? 'Not enough data' : score >= 75 ? 'Excellent' : score >= 50 ? 'Good' : score >= 25 ? 'Poor' : 'Bad';
        }

        const dietWarnings = healthProfile ? detectDietWarnings(p, healthProfile) : '';

        return {
          barcode: p.code,
          productName: p.product_name,
          brand: Array.isArray(p.brands) ? p.brands[0] || '' : (p.brands || ''),
          quantity: p.quantity || '',
          imageUrl: p.image_front_thumb_url || p.image_url || '',
          productType,
          score,
          scoreColor,
          scoreLabel,
          isOrganic: formatOrganicDisplay(organicStatus),
          protein: formatGrams(proteinDisplay),
          sugar: formatGrams(sugarDisplay),
          sodium: formatSodiumMg(sodiumDisplay),
          protein100g: formatGrams(proteinRaw),
          sugar100g: formatGrams(sugarRaw),
          sodium100g: formatSodiumMg(sodiumRaw),
          servingQuantity,
          servingKnown,
          scoreBasis: 'per100g',
          sugarTier,
          sodiumTier,
          proteinTier,
          dietWarnings,
        };
      });

    res.json({ products });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// One-time admin job: pull the most-scanned US products from Open Food
// Facts' own popularity data and warm the cache for each one, so the first
// real user to scan a common product gets an instant cached result instead
// of the full ~3-5s live scan. Protected by a simple secret query param —
// this is not meant to be discoverable or hit repeatedly.
const PRESCORE_SECRET = process.env.PRESCORE_SECRET || '';
let prescoreRunning = false;
let prescoreSecretMissingLogged = false;

function adminSecretMatches(provided) {
  if (typeof provided !== 'string' || !PRESCORE_SECRET) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(PRESCORE_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function fetchPopularBarcodes(limit) {
  const barcodes = [];
  const pageSize = 100;
  let page = 1;
  while (barcodes.length < limit) {
    const url = `https://world.openfoodfacts.org/api/v2/search?countries_tags_en=United States&sort_by=unique_scans_n&page_size=${pageSize}&page=${page}&fields=code`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DontWorryFoodScanner/1.0 (contact: app developer)' }
    });
    if (!res.ok) {
      console.log(`[PRESCORE] barcode fetch failed on page ${page}, status=${res.status}`);
      break;
    }
    const data = await res.json();
    const codes = (data.products || []).map(p => p.code).filter(Boolean);
    if (codes.length === 0) break;
    barcodes.push(...codes);
    page++;
    // Stay well under OFF's 10 req/min search rate limit.
    await new Promise(r => setTimeout(r, 7000));
  }
  return barcodes.slice(0, limit);
}

async function runPrescoreJob(limit) {
  prescoreRunning = true;
  console.log(`[PRESCORE] starting job, target=${limit} products`);
  try {
    const barcodes = await fetchPopularBarcodes(limit);
    console.log(`[PRESCORE] fetched ${barcodes.length} barcodes, beginning scan loop`);

    let done = 0, cached = 0, failed = 0;
    for (const barcode of barcodes) {
      try {
        await scanAndCache(barcode);
        cached++;
      } catch (err) {
        failed++;
        console.log(`[PRESCORE] failed barcode=${barcode} ${err.message}`);
      }
      done++;
      if (done % 25 === 0) {
        console.log(`[PRESCORE] progress ${done}/${barcodes.length} (cached=${cached}, failed=${failed})`);
      }
      // Stay well under OFF's 15 req/min product-read rate limit.
      await new Promise(r => setTimeout(r, 4500));
    }
    console.log(`[PRESCORE] complete. total=${done} cached=${cached} failed=${failed}`);
  } catch (err) {
    console.log(`[PRESCORE] job crashed: ${err.message}`);
  } finally {
    prescoreRunning = false;
  }
}

app.use('/admin', (req, res, next) => {
  if (!enforceIpRateLimit(req, res, '/admin', RATE_LIMIT_ADMIN_PER_IP)) return;
  if (!PRESCORE_SECRET) {
    if (!prescoreSecretMissingLogged) {
      prescoreSecretMissingLogged = true;
      console.log('[CONFIG] PRESCORE_SECRET not set — admin routes disabled');
    }
    return res.status(503).json({ error: 'Admin routes disabled' });
  }
  if (!adminSecretMatches(req.query.secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

app.get('/admin/prescore', (req, res) => {
  if (prescoreRunning) {
    return res.json({ status: 'already running' });
  }
  const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
  // Fire-and-forget — don't make the caller's browser wait for a job that
  // could take hours; progress is visible in the Railway logs instead.
  runPrescoreJob(limit);
  res.json({ status: 'started', limit });
});

// Admin repair: inspect / delete a permanent cache entry (photo or upstream).
app.get('/admin/cache/inspect', async (req, res) => {
  const barcode = normalizeBarcode(req.query.barcode);
  if (!barcode) {
    return res.status(400).json({ error: 'Missing barcode' });
  }
  try {
    const doc = await getDocWithBarcodeMigration(CACHE_COLLECTION, barcode);
    if (!doc.exists) {
      return res.status(404).json({ error: 'Not cached', barcode });
    }
    return res.json({ barcode, cached: doc.data() });
  } catch (err) {
    console.log(`[ADMIN CACHE INSPECT ERROR] barcode=${barcode} ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/admin/cache/delete', async (req, res) => {
  const barcode = normalizeBarcode(req.query.barcode);
  if (!barcode) {
    return res.status(400).json({ error: 'Missing barcode' });
  }
  const keepImage = req.query.keepImage === '1';
  try {
    const deleted = { productCache: false, productImages: false };

    // Heal legacy keys first so delete targets the canonical docs.
    await getDocWithBarcodeMigration(CACHE_COLLECTION, barcode);
    if (!keepImage) {
      await getDocWithBarcodeMigration(PRODUCT_IMAGES_COLLECTION, barcode);
    }

    const cacheRef = db.collection(CACHE_COLLECTION).doc(barcode);
    const cacheDoc = await cacheRef.get();
    if (cacheDoc.exists) {
      await cacheRef.delete();
      deleted.productCache = true;
    }

    if (!keepImage) {
      const imageRef = db.collection(PRODUCT_IMAGES_COLLECTION).doc(barcode);
      const imageDoc = await imageRef.get();
      if (imageDoc.exists) {
        await imageRef.delete();
        deleted.productImages = true;
      }
    }

    if (!deleted.productCache && !deleted.productImages) {
      return res.status(404).json({ error: 'Not cached', barcode, deleted, keepImage });
    }

    console.log(
      `[ADMIN CACHE DELETE] barcode=${barcode} cache=${deleted.productCache} image=${deleted.productImages} keepImage=${keepImage}`
    );
    return res.json({ deleted, barcode, keepImage });
  } catch (err) {
    console.log(`[ADMIN CACHE DELETE ERROR] barcode=${barcode} ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/admin/failed-writes', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  try {
    const snap = await db.collection(FAILED_WRITES_COLLECTION)
      .orderBy('failedAt', 'desc')
      .limit(limit)
      .get();
    const entries = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ entries, limit });
  } catch (err) {
    console.log(`[ADMIN FAILED WRITES ERROR] ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/admin/image-reports', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  try {
    const snap = await db.collection(IMAGE_REPORTS_COLLECTION)
      .orderBy('reportedAt', 'desc')
      .limit(limit)
      .get();

    const reports = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const barcodes = [];
    const seen = new Set();
    for (const r of reports) {
      const code = r.barcode ? String(r.barcode) : '';
      if (!code || seen.has(code)) continue;
      seen.add(code);
      barcodes.push(code);
    }

    const byBarcode = {};
    await Promise.all(barcodes.map(async (code) => {
      try {
        const doc = await db.collection(PRODUCT_IMAGES_COLLECTION).doc(code).get();
        if (doc.exists) {
          const d = doc.data() || {};
          byBarcode[code] = {
            reportCount: typeof d.reportCount === 'number' ? d.reportCount : 0,
            suppressed: d.suppressed === true,
            hasImage: !!(d.data && d.bytes > 0),
          };
        } else {
          byBarcode[code] = { reportCount: 0, suppressed: false, hasImage: false };
        }
      } catch (_) {
        byBarcode[code] = { reportCount: null, suppressed: null, hasImage: null };
      }
    }));

    const entries = barcodes.map(code => ({
      barcode: code,
      ...(byBarcode[code] || { reportCount: 0, suppressed: false, hasImage: false }),
    }));

    return res.json({ entries, reports, limit });
  } catch (err) {
    console.log(`[ADMIN IMAGE REPORTS ERROR] ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/admin/image/delete', async (req, res) => {
  const barcode = normalizeBarcode(req.query.barcode || (req.body && req.body.barcode) || '');
  if (!barcode) {
    return res.status(400).json({ error: 'Invalid barcode' });
  }
  try {
    const deleted = { productImages: false, cacheImageUrlCleared: false };
    await getDocWithBarcodeMigration(PRODUCT_IMAGES_COLLECTION, barcode);
    await getDocWithBarcodeMigration(CACHE_COLLECTION, barcode);

    const imageRef = db.collection(PRODUCT_IMAGES_COLLECTION).doc(barcode);
    const imageDoc = await imageRef.get();
    if (imageDoc.exists) {
      await imageRef.delete();
      deleted.productImages = true;
    }

    const cacheRef = db.collection(CACHE_COLLECTION).doc(barcode);
    const cacheDoc = await cacheRef.get();
    if (cacheDoc.exists) {
      const data = cacheDoc.data() || {};
      if (data.imageUrl) {
        await cacheRef.update({ imageUrl: '' });
        deleted.cacheImageUrlCleared = true;
      }
    }

    if (!deleted.productImages && !deleted.cacheImageUrlCleared) {
      return res.status(404).json({ error: 'Not found', barcode, deleted });
    }

    console.log(
      `[ADMIN IMAGE DELETE] barcode=${barcode} image=${deleted.productImages} cacheCleared=${deleted.cacheImageUrlCleared}`
    );
    return res.json({ deleted, barcode });
  } catch (err) {
    console.log(`[ADMIN IMAGE DELETE ERROR] barcode=${barcode} ${err.message}`);
    recordFailedWrite({
      collection: 'productImages',
      barcode,
      payload: { action: 'admin_delete' },
      error: err.message,
      capturedBy: null,
    });
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Batch diagnostic: measure cosmetic coverage across popular OBF products.
// Measurement only — no Anthropic, no productCache, no unmatchedInci /
// rawObservations writes. Reuses resolveProductType + scoreCosmeticProduct.
// ---------------------------------------------------------------------------
const DIAGNOSTIC_COLLECTION = 'diagnosticRuns';
const DIAGNOSTIC_EXAMPLE_CAP = 50;
const DIAGNOSTIC_TOP_UNMATCHED_CAP = 200;
const DIAGNOSTIC_FIRESTORE_MAX_BYTES = 900 * 1024; // headroom under 1MB
let diagnoseRunning = false;

async function fetchPopularCosmeticBarcodes(limit, countries) {
  const barcodes = [];
  const pageSize = 100;
  let page = 1;
  while (barcodes.length < limit) {
    let url = `https://world.openbeautyfacts.org/api/v2/search?sort_by=unique_scans_n&page_size=${pageSize}&page=${page}&fields=code`;
    if (countries) {
      url += `&countries_tags_en=${encodeURIComponent(countries)}`;
    }
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DontWorryFoodScanner/1.0 (contact: app developer)' },
    });
    if (!res.ok) {
      console.log(`[DIAGNOSE] barcode fetch failed on page ${page}, status=${res.status}`);
      break;
    }
    const data = await res.json();
    const codes = (data.products || []).map(p => p.code).filter(Boolean);
    if (codes.length === 0) break;
    barcodes.push(...codes);
    page++;
    // Same pacing as runPrescoreJob — stay under OBF/OFF search rate limits.
    await new Promise(r => setTimeout(r, 7000));
  }
  return barcodes.slice(0, limit);
}

function coverageBucketKey(coverage) {
  const pct = coverage * 100;
  if (pct < 20) return '0-20';
  if (pct < 40) return '20-40';
  if (pct < 60) return '40-60';
  if (pct < 80) return '60-80';
  return '80-100';
}

function truncateDiagnosticReport(report) {
  const truncatedFields = [];
  const shrinkList = (field, minKeep) => {
    const val = report[field];
    if (Array.isArray(val) && val.length > minKeep) {
      report[field] = val.slice(0, Math.max(minKeep, Math.floor(val.length * 0.7)));
      truncatedFields.push(field);
      return true;
    }
    if (val && Array.isArray(val.examples) && val.examples.length > minKeep) {
      val.examples = val.examples.slice(0, Math.max(minKeep, Math.floor(val.examples.length * 0.7)));
      truncatedFields.push(field);
      return true;
    }
    return false;
  };

  let json = JSON.stringify(report);
  while (Buffer.byteLength(json, 'utf8') > DIAGNOSTIC_FIRESTORE_MAX_BYTES) {
    const shrunk =
      shrinkList('topUnmatched', 20) ||
      shrinkList('topRecognisedOnly', 20) ||
      shrinkList('rawSamples', 3) ||
      shrinkList('classifiedFood', 5) ||
      shrinkList('noIngredientData', 5);
    if (!shrunk) break;
    json = JSON.stringify(report);
  }
  if (truncatedFields.length > 0) {
    report.truncatedFields = [...new Set(truncatedFields)];
  }
  return report;
}

async function runDiagnoseJob(limit, countries) {
  diagnoseRunning = true;
  const startedAt = Date.now();
  const countriesFilter = countries || null;
  console.log(`[DIAGNOSE] start limit=${limit} countries=${countriesFilter || '(none)'}`);

  const tallies = {
    productsAttempted: 0,
    notFound: 0,
    classifiedFood: 0,
    classifiedFoodExamples: [],
    classifiedCosmetic: 0,
    noIngredientData: 0,
    noIngredientDataExamples: [],
    scored: 0,
    belowGate: 0,
    errors: 0,
    unparseableTotal: 0,
    coverageSum: 0,
    coverageCount: 0,
    recognisedSum: 0,
    coverageBuckets: { '0-20': 0, '20-40': 0, '40-60': 0, '60-80': 0, '80-100': 0 },
    rawSamples: [],
  };
  // name(normalized) -> { name, count, exampleBarcode }
  const unmatchedTally = new Map();
  const recognisedOnlyTally = new Map();

  try {
    const barcodes = await fetchPopularCosmeticBarcodes(limit, countriesFilter);
    console.log(`[DIAGNOSE] fetched ${barcodes.length} barcodes, beginning measure loop`);

    for (const barcode of barcodes) {
      tallies.productsAttempted++;
      try {
        const { productType, product } = await resolveProductType(barcode);

        if (!product || !productType) {
          tallies.notFound++;
        } else if (productType === 'food') {
          tallies.classifiedFood++;
          if (tallies.classifiedFoodExamples.length < DIAGNOSTIC_EXAMPLE_CAP) {
            tallies.classifiedFoodExamples.push(barcode);
          }
        } else if (productType === 'cosmetic') {
          tallies.classifiedCosmetic++;
          // Pure measurement: score only — no explanations, cache, or side-effect logs.
          const scored = scoreCosmeticProduct(product);
          tallies.unparseableTotal += scored.unparseableCount || 0;
          if (scored.drugFactsMarker) {
            console.log(`[DRUG FACTS TRUNCATED] barcode=${barcode} marker=${scored.drugFactsMarker}`);
          }

          if (scored.coverageTotal > 0) {
            tallies.coverageSum += scored.coverage;
            tallies.coverageCount++;
            tallies.recognisedSum += (scored.recognisedCount || 0) / scored.coverageTotal;
            tallies.coverageBuckets[coverageBucketKey(scored.coverage)]++;
          }

          // First 10 below 0.30 coverage — keep a raw excerpt for cause analysis.
          if (scored.coverage < 0.30 && tallies.rawSamples.length < 10) {
            tallies.rawSamples.push({
              barcode,
              ingredientsTextExcerpt: String(product.ingredients_text || '').slice(0, 400),
            });
          }

          if (scored.noIngredientData || scored.coverageTotal === 0) {
            tallies.noIngredientData++;
            if (tallies.noIngredientDataExamples.length < DIAGNOSTIC_EXAMPLE_CAP) {
              tallies.noIngredientDataExamples.push(barcode);
            }
          } else if (scored.score === null) {
            tallies.belowGate++;
          } else {
            tallies.scored++;
          }

          for (const item of scored.unmatchedNames || []) {
            const name = unmatchedNameLabel(item);
            const key = normalizeInci(name);
            if (!key) continue;
            const tallyMap = unmatchedNameRecognised(item) ? recognisedOnlyTally : unmatchedTally;
            const prev = tallyMap.get(key);
            if (prev) {
              prev.count++;
            } else {
              tallyMap.set(key, { name, count: 1, exampleBarcode: barcode });
            }
          }
        }
      } catch (err) {
        tallies.errors++;
        console.log(`[DIAGNOSE] error barcode=${barcode} ${err.message}`);
      }

      if (tallies.productsAttempted % 25 === 0) {
        console.log(
          `[DIAGNOSE] progress n=${tallies.productsAttempted} found=${tallies.classifiedCosmetic + tallies.classifiedFood} scored=${tallies.scored}`
        );
      }
      // Same product-read pacing as runPrescoreJob (resolveProductType hits OFF/OBF).
      await new Promise(r => setTimeout(r, 4500));
    }

    const coverageAverage = tallies.coverageCount > 0
      ? tallies.coverageSum / tallies.coverageCount
      : null;
    const recognisedAverage = tallies.coverageCount > 0
      ? tallies.recognisedSum / tallies.coverageCount
      : null;

    const topUnmatched = [...unmatchedTally.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, DIAGNOSTIC_TOP_UNMATCHED_CAP);

    const topRecognisedOnly = [...recognisedOnlyTally.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, DIAGNOSTIC_TOP_UNMATCHED_CAP);

    const report = truncateDiagnosticReport({
      startedAt,
      finishedAt: Date.now(),
      limit,
      countries: countriesFilter,
      tableVersion: COSMETIC_TABLE_VERSION,
      cosingNamesVersion: COSING_NAMES_VERSION,
      productsAttempted: tallies.productsAttempted,
      notFound: tallies.notFound,
      classifiedFood: {
        count: tallies.classifiedFood,
        examples: tallies.classifiedFoodExamples,
      },
      classifiedCosmetic: tallies.classifiedCosmetic,
      noIngredientData: {
        count: tallies.noIngredientData,
        examples: tallies.noIngredientDataExamples,
      },
      scored: tallies.scored,
      belowGate: tallies.belowGate,
      errors: tallies.errors,
      unparseableTotal: tallies.unparseableTotal,
      coverageAverage,
      recognisedAverage,
      coverageBuckets: tallies.coverageBuckets,
      topUnmatched,
      topRecognisedOnly,
      rawSamples: tallies.rawSamples,
    });

    try {
      const docRef = await db.collection(DIAGNOSTIC_COLLECTION).add(report);
      console.log(
        `[DIAGNOSE] done attempted=${tallies.productsAttempted} scored=${tallies.scored} avgCoverage=${coverageAverage == null ? 'n/a' : coverageAverage.toFixed(3)} avgRecognised=${recognisedAverage == null ? 'n/a' : recognisedAverage.toFixed(3)} topUnmatched=${topUnmatched.length} topRecognisedOnly=${topRecognisedOnly.length} doc=${docRef.id}`
      );
    } catch (writeErr) {
      console.log(`[DIAGNOSE] report write failed: ${writeErr.message}`);
      console.log(
        `[DIAGNOSE] done attempted=${tallies.productsAttempted} scored=${tallies.scored} avgCoverage=${coverageAverage == null ? 'n/a' : coverageAverage.toFixed(3)} avgRecognised=${recognisedAverage == null ? 'n/a' : recognisedAverage.toFixed(3)} topUnmatched=${topUnmatched.length} topRecognisedOnly=${topRecognisedOnly.length}`
      );
    }
  } catch (err) {
    console.log(`[DIAGNOSE] job crashed: ${err.message}`);
    try {
      await db.collection(DIAGNOSTIC_COLLECTION).add({
        startedAt,
        finishedAt: Date.now(),
        limit,
        countries: countriesFilter,
        tableVersion: COSMETIC_TABLE_VERSION,
        status: 'crashed',
        error: err.message,
        productsAttempted: tallies.productsAttempted,
        notFound: tallies.notFound,
        classifiedFood: {
          count: tallies.classifiedFood,
          examples: tallies.classifiedFoodExamples,
        },
        classifiedCosmetic: tallies.classifiedCosmetic,
        noIngredientData: {
          count: tallies.noIngredientData,
          examples: tallies.noIngredientDataExamples,
        },
        scored: tallies.scored,
        belowGate: tallies.belowGate,
        errors: tallies.errors,
        unparseableTotal: tallies.unparseableTotal,
      });
    } catch (writeErr) {
      console.log(`[DIAGNOSE] crash report write failed: ${writeErr.message}`);
    }
  } finally {
    diagnoseRunning = false;
  }
}

app.get('/admin/diagnose', (req, res) => {
  if (diagnoseRunning) {
    return res.json({ status: 'already running' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const countries = (req.query.countries || '').toString().trim() || null;
  // Fire-and-forget — progress in Railway logs; report lands in diagnosticRuns.
  runDiagnoseJob(limit, countries);
  res.json({ status: 'started', limit, countries });
});

app.get('/admin/diagnose/report', async (req, res) => {
  try {
    const visionCallsToday = getVisionCallsToday();
    const runId = (req.query.runId || '').toString().trim();
    if (runId) {
      const doc = await db.collection(DIAGNOSTIC_COLLECTION).doc(runId).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Report not found' });
      }
      return res.json({ id: doc.id, ...doc.data(), visionCallsToday });
    }

    const snap = await db.collection(DIAGNOSTIC_COLLECTION)
      .orderBy('startedAt', 'desc')
      .limit(1)
      .get();
    if (snap.empty) {
      return res.status(404).json({ error: 'No diagnostic runs yet' });
    }
    const doc = snap.docs[0];
    return res.json({ id: doc.id, ...doc.data(), visionCallsToday });
  } catch (err) {
    console.log(`[DIAGNOSE] report read failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
startRateLimitSweeper();
if (!resolvePublicBaseUrl()) {
  console.log('[CONFIG] PUBLIC_BASE_URL not set — stored image URLs disabled');
}
if (require.main === module) {
  app.listen(PORT, () => console.log(`Running on port ${PORT}`));
}

module.exports = app;
// ci

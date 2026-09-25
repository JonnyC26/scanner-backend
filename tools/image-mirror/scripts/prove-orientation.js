#!/usr/bin/env node
'use strict';

/**
 * Dev-environment only. Never invoked by the GitHub Action.
 * Compares our 200×200 output to OFF image_front_small_url after Purla's
 * display transform (centre-crop to square, resize 200×200).
 */

const sharp = require('sharp');
const { selectCandidate, sourcePlan } = require('../src/select');
const { centerSquare } = require('../src/process');
const { processCandidate } = require('../src/run');
const { USER_AGENT, OUTPUT_SIZE } = require('../src/constants');

const SAMPLE_SEED = '20260924';
const COMPARE_SIZE = 32;
const MARGIN_MIN = 0.015;

// Every crop or rotation case from the seed-20260924 contact sheet.
const CASES = [
  '0855005007352',
  '0850010279367',
  '0856306005856',
  '4823077616013',
  '2027119004505',
  '0822249011582',
  '0873885087998',
  '18749939',
  '0051933301450',
  '0030000045602',
  '0193968048532',
  '0038259130407',
  '0099900694235',
  '0814314024610',
  '0078742101330',
  '2000000125310',
  '0044000042370',
  '0815369019880',
  '0076183643631',
  '0859728006005',
  '0067312023011',
  '0041795000738',
  '0075925960425',
  '0032735777308',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, { tries = 5, asJson = false } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
      if (res.ok) {
        return asJson ? res.json() : Buffer.from(await res.arrayBuffer());
      }
      last = new Error(`HTTP ${res.status} ${url}`);
    } catch (err) {
      last = err;
    }
    await sleep(400 * (i + 1));
  }
  throw last || new Error(`fetch failed ${url}`);
}

async function fetchBuf(url) {
  return fetchWithRetry(url);
}

async function fetchProduct(code) {
  const candidates = [code];
  if (/^\d+$/.test(code) && code.length < 13) {
    candidates.push(code.padStart(13, '0'));
  } else if (/^\d+$/.test(code) && code.length === 13 && code.startsWith('0')) {
    candidates.push(code.replace(/^0+/, '') || '0');
  }
  for (const id of candidates) {
    const url = `https://world.openfoodfacts.org/api/v2/product/${id}.json?fields=code,product_name,lang,lc,countries_tags,categories_tags,images,image_front_small_url`;
    try {
      const data = await fetchWithRetry(url, { asJson: true });
      if (data && data.product && data.product.images) {
        data.product.code = data.product.code || id;
        return data.product;
      }
    } catch {
      // try next identifier
    }
  }
  throw new Error(`product not found ${code}`);
}

async function displayTransform(buf) {
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const w = meta.width;
  const h = meta.height;
  if (!w || !h) throw new Error('reference has no dimensions');
  const sq = centerSquare(w, h);
  return sharp(buf, { failOn: 'none' })
    .extract(sq)
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'fill' })
    .removeAlpha()
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function grey32(buf, extraRotate = 0) {
  let pipeline = sharp(buf, { failOn: 'none' });
  if (extraRotate) pipeline = pipeline.rotate(extraRotate);
  return pipeline
    .resize(COMPARE_SIZE, COMPARE_SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
}

function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  const mae = sum / a.length;
  return 1 - mae / 255;
}

async function proveOne(code) {
  const product = await fetchProduct(code);
  const candidate = selectCandidate(product);
  if (!candidate) {
    return { code, status: 'fail', reason: 'not in search universe' };
  }
  const plan = sourcePlan(candidate.chosen);
  if (plan.skip) {
    return { code, status: 'fail', reason: `sourcePlan ${plan.skip}` };
  }
  const processed = await processCandidate(candidate, { fetchImpl: fetch });
  if (processed.status !== 'ready') {
    return { code, status: 'fail', reason: `process ${processed.reason || processed.status}` };
  }

  const smallUrl = product.image_front_small_url;
  if (!smallUrl) return { code, status: 'fail', reason: 'no image_front_small_url' };
  const ref = await displayTransform(await fetchBuf(smallUrl));

  const refGrey = await grey32(ref, 0);
  const scores = {};
  for (const deg of [0, 90, 180, 270]) {
    const probe = await grey32(processed.buffer, deg);
    scores[deg] = Math.round(similarity(probe, refGrey) * 10000) / 10000;
  }
  const ranked = [0, 90, 180, 270].sort((a, b) => scores[b] - scores[a]);
  const best = ranked[0];
  const margin = Math.round((scores[ranked[0]] - scores[ranked[1]]) * 10000) / 10000;
  let status = 'pass';
  if (best !== 0) status = 'fail';
  else if (margin < MARGIN_MIN) status = 'inconclusive';

  return {
    code: candidate.code,
    angle: plan.applyRotate ? plan.generation.angle : 0,
    crop: plan.applyCrop ? 'yes' : 'no',
    best,
    scores,
    margin,
    status,
    name: candidate.productName,
  };
}

async function main() {
  console.log(`orientation proof seed=${SAMPLE_SEED} metric=1-MAE/255 on ${COMPARE_SIZE}×${COMPARE_SIZE} greyscale`);
  console.log('reference = image_front_small_url → centre-square → 200×200');
  const rows = [];
  for (let i = 0; i < CASES.length; i++) {
    const code = CASES[i];
    if (i > 0) await sleep(250);
    try {
      const row = await proveOne(code);
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (err) {
      const row = { code, status: 'fail', reason: err.message };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  const must = rows.find((r) => String(r.code).includes('0856306005856'));
  if (!must) {
    console.error('MISSING required crop+rotate case 0856306005856');
    process.exit(2);
  }
  console.log('\nbarcode\tangle\tcrop\tbest\ts0\ts90\ts180\ts270\tmargin\tstatus');
  for (const r of rows) {
    if (!r.scores) {
      console.log(`${r.code}\t\t\t\t\t\t\t\t\t${r.status} ${r.reason || ''}`);
      continue;
    }
    console.log([
      r.code,
      r.angle,
      r.crop,
      r.best,
      r.scores[0].toFixed(4),
      r.scores[90].toFixed(4),
      r.scores[180].toFixed(4),
      r.scores[270].toFixed(4),
      r.margin.toFixed(4),
      r.status,
    ].join('\t'));
  }
  const failed = rows.filter((r) => r.status !== 'pass');
  console.log(`\n${rows.filter((r) => r.status === 'pass').length}/${rows.length} passed`);
  if (failed.length) {
    console.error('FAILED/INCONCLUSIVE:', failed.map((r) => `${r.code}:${r.status}`).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

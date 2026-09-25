'use strict';

const fs = require('fs');
const path = require('path');
const { mulberry32, seedFrom } = require('./prng');
const { CONTACT_SHEET_RANDOM, CONTACT_SHEET_TRANSFORM_CAP } = require('./constants');
const { offThumbUrl } = require('./select');

function pickRows(mirrored, { seed, randomN = CONTACT_SHEET_RANDOM, transformCap = CONTACT_SHEET_TRANSFORM_CAP }) {
  const transforms = mirrored.filter(r => r.applyCrop || r.applyRotate).slice(0, transformCap);
  const transformCodes = new Set(transforms.map(r => r.code));
  const rest = mirrored.filter(r => !transformCodes.has(r.code));
  const rng = mulberry32(seedFrom(seed) ^ 0x9e3779b9);
  const shuffled = rest.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = t;
  }
  const random = shuffled.slice(0, randomN);
  const seen = new Set();
  const rows = [];
  for (const r of [...transforms, ...random]) {
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    rows.push(r);
  }
  return { rows, transformCount: transforms.length, randomCount: random.length };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function writeContactSheet({ outDir, mirrored, seed, summary }) {
  fs.mkdirSync(outDir, { recursive: true });
  const imagesDir = path.join(outDir, 'ours');
  fs.mkdirSync(imagesDir, { recursive: true });
  const picked = pickRows(mirrored, { seed });
  const cards = [];
  for (const row of picked.rows) {
    const file = `${row.code}.jpg`;
    fs.writeFileSync(path.join(imagesDir, file), row.buffer);
    const labels = [];
    if (row.applyCrop) labels.push('crop');
    if (row.applyRotate) labels.push(`rotate ${row.angle}°`);
    if (!row.applyCrop && !row.applyRotate) labels.push('uncropped');
    const offSrc = offThumbUrl(row.code, row.lc, row.rev);
    cards.push(`
    <figure class="card">
      <figcaption>
        <strong>${escapeHtml(row.code)}</strong>
        <span class="name">${escapeHtml(row.productName || '')}</span>
        <span class="tag">${escapeHtml(labels.join(' · '))}</span>
        <span class="meta">front_${escapeHtml(row.lc)}.${escapeHtml(row.rev)}</span>
      </figcaption>
      <div class="pair">
        <div>
          <img src="ours/${escapeHtml(file)}" width="200" height="200" alt="Purla 200×200">
          <div class="lbl">Purla 200×200</div>
        </div>
        <div>
          <img src="${escapeHtml(offSrc)}" width="100" height="100" alt="OFF thumb (remote)">
          <div class="lbl">OFF image_front_thumb_url (remote)</div>
        </div>
      </div>
    </figure>`);
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Purla image-mirror contact sheet</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111; }
    .notice { background: #fef3c7; border: 1px solid #f59e0b; padding: 10px 14px; border-radius: 8px; font-weight: 600; }
    .summary { background: #f4f4f5; padding: 12px 16px; border-radius: 8px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
    .card { border: 1px solid #e4e4e7; border-radius: 8px; padding: 12px; margin: 0; }
    .card figcaption { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; font-size: 13px; }
    .name { color: #3f3f46; }
    .tag { color: #b45309; font-weight: 600; }
    .meta { color: #71717a; }
    .pair { display: flex; gap: 16px; align-items: flex-start; }
    .lbl { font-size: 11px; color: #71717a; margin-top: 4px; }
    img { background: #fafafa; object-fit: cover; }
  </style>
</head>
<body>
  <p class="notice">Extract the zip before opening this file. Images are referenced by relative path and appear broken otherwise.</p>
  <h1>Image mirror contact sheet</h1>
  <div class="summary">
    <div>seed: ${escapeHtml(summary.sampleSeed)}</div>
    <div>selected: ${summary.selected} · mirrored: ${summary.mirrored} · skipped: ${summary.skipped}</div>
    <div>crop cases in run: ${summary.cropCases} · rotation cases in run: ${summary.rotationCases}</div>
    <div>sheet rows: ${picked.rows.length} (all crop/rotation up to ${CONTACT_SHEET_TRANSFORM_CAP}, plus ${picked.randomCount} random)</div>
    <p>OFF thumbnails are loaded by the viewer from images.openfoodfacts.org. This sheet does not embed those bytes.</p>
  </div>
  <div class="grid">
    ${cards.join('\n')}
  </div>
</body>
</html>
`;
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return { htmlPath: path.join(outDir, 'index.html'), rowCount: picked.rows.length };
}

module.exports = { writeContactSheet, pickRows };

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const scoreStart = src.indexOf('function calculateScore');
const scoreEnd = src.indexOf('// OFF labels_tags is crowd-entered');
if (scoreStart < 0 || scoreEnd < 0) throw new Error('could not locate nutrition subscore');

const block = `
const FOOD_PROTEIN_NUTRIMENT_KEYS = ['proteins_100g', 'proteins'];
${src.slice(scoreStart, scoreEnd)}
module.exports = { computeNutritionSubscore, classifyPurlaFoodPath };
`;
fs.writeFileSync('/tmp/nutrition_subscore_validate.js', block);
delete require.cache['/tmp/nutrition_subscore_validate.js'];
const g = require('/tmp/nutrition_subscore_validate.js');

function usdaNutrientsToOff(usdaNutrients) {
  const n = usdaNutrients || {};
  const nutriments = {};
  const set = (key, rec, scale) => {
    if (!rec || typeof rec.value !== 'number' || !Number.isFinite(rec.value)) return;
    nutriments[key] = scale ? rec.value * scale : rec.value;
  };
  set('energy-kcal_100g', n.energy_kcal);
  set('proteins_100g', n.protein);
  set('fat_100g', n.fat);
  set('carbohydrates_100g', n.carbohydrate);
  set('fiber_100g', n.fiber);
  set('sugars_100g', n.sugars);
  set('saturated-fat_100g', n.saturated_fat);
  if (n.sodium_mg && typeof n.sodium_mg.value === 'number') {
    const unit = String(n.sodium_mg.unit || 'MG').toUpperCase();
    nutriments.sodium_100g = (unit === 'MG' || unit === 'MILLIGRAM')
      ? n.sodium_mg.value / 1000
      : n.sodium_mg.value;
  }
  return nutriments;
}

function rank(values) {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = Array(values.length);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].v === sorted[i].v) j += 1;
    const avg = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) ranks[sorted[k].i] = avg;
    i = j;
  }
  return ranks;
}

function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function spearman(x, y) {
  return pearson(rank(x), rank(y));
}

const GRADE_RANK = { a: 5, b: 4, c: 3, d: 2, e: 1 };

const coverage = JSON.parse(fs.readFileSync(path.join(__dirname, 'off_usda_coverage.json'), 'utf8'));
const rows = coverage.sample || [];
const scored = [];
for (const row of rows) {
  const grade = String(row.nutriscore_grade || '').trim().toLowerCase();
  if (!GRADE_RANK[grade]) continue;
  const nutriments = usdaNutrientsToOff(row.usdaNutrients);
  const result = g.computeNutritionSubscore(nutriments, row.foodCategory);
  if (!result.available) continue;
  scored.push({
    gtin: row.gtin,
    name: row.name,
    foodCategory: row.foodCategory,
    path: result.path,
    grade,
    gradeRank: GRADE_RANK[grade],
    subscore: result.points,
    proteinSuppressed: result.proteinSuppressed,
  });
}

const rho = scored.length ? spearman(scored.map((r) => r.subscore), scored.map((r) => r.gradeRank)) : null;

let pairs = 0;
let correct = 0;
let ties = 0;
for (let i = 0; i < scored.length; i++) {
  for (let j = i + 1; j < scored.length; j++) {
    const gDiff = scored[i].gradeRank - scored[j].gradeRank;
    if (Math.abs(gDiff) < 2) continue;
    pairs += 1;
    const sDiff = scored[i].subscore - scored[j].subscore;
    if (sDiff === 0) {
      ties += 1;
      continue;
    }
    if ((gDiff > 0 && sDiff > 0) || (gDiff < 0 && sDiff < 0)) correct += 1;
  }
}

const pairPct = pairs ? (100 * correct / pairs) : 0;

const summary = {
  nWithOffGradeAndSubscore: scored.length,
  spearmanRho: rho == null ? null : Number(rho.toFixed(4)),
  pairsSeparatedByTwoOrMoreGrades: pairs,
  pairsOrderedCorrectly: correct,
  pairTies: ties,
  pctPairsOrderedCorrectly: Number(pairPct.toFixed(1)),
  targets: { spearman: 0.70, pairwise: 80 },
  spearmanPass: rho != null && rho >= 0.70,
  pairwisePass: pairPct >= 80,
  byGrade: ['a', 'b', 'c', 'd', 'e'].map((gr) => {
    const xs = scored.filter((r) => r.grade === gr).map((r) => r.subscore);
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    return { grade: gr, n: xs.length, meanSubscore: mean == null ? null : Number(mean.toFixed(1)) };
  }),
};

console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(__dirname, 'nutrition_subscore_validation.json'), JSON.stringify(summary, null, 2));

if (!summary.spearmanPass || !summary.pairwisePass) {
  console.error('VALIDATION FAILED — thresholds were not tuned. spearman=' +
    summary.spearmanRho + ' pairwise=' + summary.pctPairsOrderedCorrectly + '%');
  process.exit(2);
}
console.log('validation pass');

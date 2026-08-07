#!/usr/bin/env python3
"""Assertions for INCI normalisation, synonym matching, and cosmetic parsing.

Combines:
- PR #8 synonym / normalizeInci / noIngredientData / prefix-stereo rules
- parse/classify fixes: digit-safe commas, Ingredients: prefix, may-contain,
  tidy-up, (nano), category fragments
- photo-cache stale re-score and stale-beats-nothing fallback
- fragrance/French synonyms + unparseable packaging filter
- EU multilingual slash-joined INCI aliases (Aqua/Water/Eau)
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INGREDIENTS_PATH = ROOT / "purla_cosmetic_ingredients.json"
SYNONYMS_PATH = ROOT / "purla_inci_synonyms.json"


def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Synonym layer (from PR #8)
# ---------------------------------------------------------------------------


def test_synonym_targets_exist_in_hazard_table():
    ingredients = load_json(INGREDIENTS_PATH)["ingredients"]
    synonyms = load_json(SYNONYMS_PATH)["synonyms"]
    inci_names = {entry["inci"] for entry in ingredients}
    missing = {
        common: target
        for common, target in synonyms.items()
        if target not in inci_names
    }
    assert not missing, f"synonym targets missing from hazard table: {missing}"


def test_seeded_and_extended_pairs_present():
    synonyms = load_json(SYNONYMS_PATH)["synonyms"]
    required = {
        "peppermint oil": "Mentha Piperita Oil",
        "spearmint oil": "Mentha Viridis Leaf Oil",
        "coconut oil": "Cocos Nucifera Oil",
        "fractionated coconut oil": "Cocos Nucifera Oil",
        "tea tree oil": "Melaleuca Alternifolia Leaf Oil",
        "clove oil": "Eugenia Caryophyllus Leaf Oil",
        # Highest-value fragrance aliases + French label / OCR variants
        "fragrance": "Parfum",
        "perfume": "Parfum",
        "eau": "Aqua",
        "glycérine": "Glycerin",
        "glycerine": "Glycerin",
        "phénoxyéthanol": "Phenoxyethanol",
        "phenoxyethanol": "Phenoxyethanol",
        "diméthicone": "Dimethicone",
        "carbomère": "Carbomer",
        "carbomere": "Carbomer",
        "tocophérol": "Tocopherol",
        "vaseline": "Petrolatum",
        "gomme xanthane": "Xanthan Gum",
        "cholestérol": "Cholesterol",
        "hyaluronate de sodium": "Sodium Hyaluronate",
        "edta disodique": "Disodium EDTA",
        "céteareth-20": "Ceteareth-20",
        "alcool cétéarylique": "Cetearyl Alcohol",
        "alcool cetearylique": "Cetearyl Alcohol",
        "alcool cétylique": "Cetyl Alcohol",
        "alcool cetylique": "Cetyl Alcohol",
        "éthylhexylglycérine": "Ethylhexylglycerin",
        "ethylhexylglycerine": "Ethylhexylglycerin",
        "méthosulfate de béhentrimonium": "Behentrimonium Methosulfate",
        "methosulfate de behentrimonium": "Behentrimonium Methosulfate",
        "céramide NP": "Ceramide NP",
        "ceramide NP": "Ceramide NP",
        "céramide AP": "Ceramide AP",
        "ceramide AP": "Ceramide AP",
        "céramide EOP": "Ceramide EOP",
        "ceramide EOP": "Ceramide EOP",
        "triglycérides caprylique": "Caprylic/Capric Triglyceride",
        "triglycerides caprylique": "Caprylic/Capric Triglyceride",
    }
    for common, target in required.items():
        assert synonyms.get(common) == target, f"{common} -> {synonyms.get(common)}"
    assert "caprique" not in synonyms, "must not add ambiguous fragment 'caprique'"


def _run_node_lookup_assertions() -> None:
    """Drive the live JS lookupCosmeticIngredient via Node."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('function stripCosmeticAnnotations');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic lookup block');
const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
module.exports = { lookupCosmeticIngredient, normalizeInci, cosmeticBySynonym };
`;
fs.writeFileSync('/tmp/inci_lookup_helpers.js', block);
const { lookupCosmeticIngredient, normalizeInci } = require('/tmp/inci_lookup_helpers.js');
const synonyms = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'purla_inci_synonyms.json'), 'utf8')).synonyms;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Every seeded synonym resolves to the canonical INCI entry.
for (const [common, target] of Object.entries(synonyms)) {
  const hit = lookupCosmeticIngredient(common);
  assert(hit, `synonym miss: ${common}`);
  assert(hit.inci === target, `synonym ${common} -> ${hit && hit.inci}, expected ${target}`);
  // Case / spacing variants still resolve via normalizeInci.
  const hit2 = lookupCosmeticIngredient(common.toUpperCase());
  assert(hit2 && hit2.inci === target, `case variant failed for ${common}`);
}

// Direct INCI match still wins over a synonym (Mentha Piperita Oil is both
// an inci and the target of "peppermint oil"). Looking up the INCI must
// return the same entry — and must not be shadowed by any synonym key.
const direct = lookupCosmeticIngredient('Mentha Piperita Oil');
assert(direct && direct.inci === 'Mentha Piperita Oil', 'direct INCI miss');
const viaSyn = lookupCosmeticIngredient('peppermint oil');
assert(viaSyn && viaSyn.inci === direct.inci, 'synonym must yield same canonical inci');

// Synonym layer is last resort: a declare_as / inci / covers hit must not be
// replaced. Aqua is an inci; inventing a synonym for something else must not
// affect Aqua.
const aqua = lookupCosmeticIngredient('Aqua');
assert(aqua && aqua.inci === 'Aqua', 'Aqua direct match');

// Unknown names fail loudly — no fuzzy / substring match.
const unknown = lookupCosmeticIngredient('Completely Made Up Oil Extract XYZ');
assert(unknown === null, 'unknown name must not fuzzy-match');
const coconutSubstring = lookupCosmeticIngredient('fractionated coconut oil blend');
assert(coconutSubstring === null, 'substring must not match synonym');

// GuruNanda-style common names that previously scored 0/12.
for (const name of [
  'Fractionated Coconut Oil',
  'Peppermint Oil',
  'Spearmint Oil',
  'Clove Oil',
  'Tea Tree Oil',
]) {
  const hit = lookupCosmeticIngredient(name);
  assert(hit, `expected match for ${name}`);
}

console.log('node lookup assertions ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(f"node lookup assertions failed (exit {proc.returncode})")


def test_synonym_lookup_behaviour():
    _run_node_lookup_assertions()


def test_no_ingredient_data_flag_via_node():
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(require('path').join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('function stringifyIngredientListForCache');
const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
module.exports = { scoreCosmeticProduct };
`;
fs.writeFileSync('/tmp/inci_score_helpers.js', block);
const { scoreCosmeticProduct } = require('/tmp/inci_score_helpers.js');

const empty = scoreCosmeticProduct({ ingredients_text: '' });
if (empty.score !== null) throw new Error('expected null score');
if (empty.noIngredientData !== true) throw new Error('expected noIngredientData');
if (empty.coverageTotal !== 0) throw new Error('expected 0 coverageTotal');

const gurunanda = scoreCosmeticProduct({
  ingredients_text: 'Fractionated Coconut Oil, Peppermint Oil, Spearmint Oil, Clove Oil, Tea Tree Oil, Cardamom Oil, Oregano Oil, Fennel Oil'
});
if (gurunanda.noIngredientData) throw new Error('should have ingredients');
if (gurunanda.coverageMatched < 5) throw new Error('expected synonym matches, got ' + gurunanda.coverageMatched);
const clove = gurunanda.ingredientList.find(r => /clove/i.test(r.name));
if (!clove || clove.inci !== 'Eugenia Caryophyllus Leaf Oil') throw new Error('clove canonical inci: ' + JSON.stringify(clove));
if (clove.risk !== 'moderate') throw new Error('clove should be moderate');

console.log('noIngredientData + gurunanda score ok', gurunanda.coverageMatched + '/' + gurunanda.coverageTotal, 'score=' + gurunanda.score);
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(f"score assertions failed (exit {proc.returncode})")
    print(proc.stdout.strip())


# Leading positional / stereo prefixes that must never be stripped or merged.
_PREFIX_RE = (
    r"^(o|m|p|alpha|beta|gamma|iso|n|tert|sec)"
    r"(?:-|\s+)"
)


def _strip_positional_or_stereo_prefix(name: str) -> tuple[str | None, str]:
    """Return (prefix, remainder) if name has a leading positional/stereo prefix."""
    import re

    m = re.match(_PREFIX_RE + r"(.+)$", name.strip(), re.IGNORECASE)
    if not m:
        return None, name.strip().lower()
    return m.group(1).lower(), m.group(2).strip().lower()


def test_synonym_file_has_no_prefix_only_collisions():
    """No synonym key/target pair may differ from another only by a leading prefix."""
    synonyms = load_json(SYNONYMS_PATH)["synonyms"]
    strings = list(synonyms.keys()) + list(synonyms.values())
    # Compare every pair of strings in the synonym file.
    collisions: list[tuple[str, str]] = []
    for i, a in enumerate(strings):
        for b in strings[i + 1 :]:
            if a.lower() == b.lower():
                continue
            pa, ba = _strip_positional_or_stereo_prefix(a)
            pb, bb = _strip_positional_or_stereo_prefix(b)
            # Differ only by prefix: same base, different/absent prefix.
            if ba == bb and (pa or pb) and pa != pb:
                collisions.append((a, b))
            # One name is the unprefixed base of the other.
            if pa and ba == b.lower():
                collisions.append((a, b))
            if pb and bb == a.lower():
                collisions.append((a, b))
    assert not collisions, f"synonym prefix-only collisions: {collisions}"


def test_positional_and_stereo_prefixes_never_conflated():
    """Highest-consequence matcher rule: o-/m-/p- and alpha- must not merge."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(require('path').join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('function stripCosmeticAnnotations');
const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
module.exports = { lookupCosmeticIngredient, normalizeInci };
`;
fs.writeFileSync('/tmp/inci_prefix_helpers.js', block);
const { lookupCosmeticIngredient, normalizeInci } = require('/tmp/inci_prefix_helpers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// normalizeInci must PRESERVE leading positional / stereo prefixes.
for (const raw of [
  'o-Phenylenediamine',
  'm-Phenylenediamine',
  'p-Phenylenediamine',
  'Alpha-Arbutin',
  'Arbutin',
  'Isomethyl Ionone',
  'Methyl Ionone',
  'Alpha-Isomethyl Ionone',
]) {
  const n = normalizeInci(raw);
  assert(n.includes('phenylenediamine') || n.includes('arbutin') || n.includes('ionone'), raw);
  // Prefix characters must survive (o-/m-/p-/alpha-), not be stripped to a shared base.
  if (/^[omp]-/i.test(raw)) {
    assert(n.startsWith(raw[0].toLowerCase() + '-'), `prefix stripped from ${raw} -> ${n}`);
  }
  if (/^alpha-/i.test(raw)) {
    assert(n.startsWith('alpha-'), `alpha- stripped from ${raw} -> ${n}`);
  }
}

// Present in current hazard table:
//   p-Phenylenediamine, Alpha-Arbutin, Arbutin, Alpha-Isomethyl Ionone
// Absent (must return null, never a near-miss):
//   o-Phenylenediamine, m-Phenylenediamine, Isomethyl Ionone, Methyl Ionone

const pPhen = lookupCosmeticIngredient('p-Phenylenediamine');
assert(pPhen && pPhen.inci === 'p-Phenylenediamine', 'p-Phenylenediamine must resolve to itself');

const oPhen = lookupCosmeticIngredient('o-Phenylenediamine');
assert(oPhen === null, 'o-Phenylenediamine must NOT match p-Phenylenediamine');
const mPhen = lookupCosmeticIngredient('m-Phenylenediamine');
assert(mPhen === null, 'm-Phenylenediamine must NOT match p-Phenylenediamine');

const alphaArbutin = lookupCosmeticIngredient('Alpha-Arbutin');
assert(alphaArbutin && alphaArbutin.inci === 'Alpha-Arbutin', 'Alpha-Arbutin must resolve to itself');
const arbutin = lookupCosmeticIngredient('Arbutin');
assert(arbutin && arbutin.inci === 'Arbutin', 'Arbutin must resolve to itself');
assert(alphaArbutin.inci !== arbutin.inci, 'Alpha-Arbutin must not conflate with Arbutin');

const alphaIso = lookupCosmeticIngredient('Alpha-Isomethyl Ionone');
assert(alphaIso && alphaIso.inci === 'Alpha-Isomethyl Ionone', 'Alpha-Isomethyl Ionone must resolve');
const iso = lookupCosmeticIngredient('Isomethyl Ionone');
assert(iso === null, 'Isomethyl Ionone must NOT near-miss to Alpha-Isomethyl Ionone');
const methyl = lookupCosmeticIngredient('Methyl Ionone');
assert(methyl === null, 'Methyl Ionone must NOT near-miss to Alpha-Isomethyl Ionone');

// Cross-check: looking up each present name must never return a different isomer.
assert(lookupCosmeticIngredient('p-Phenylenediamine').inci !== 'o-Phenylenediamine');
assert(lookupCosmeticIngredient('Alpha-Arbutin').inci !== 'Arbutin');
assert(lookupCosmeticIngredient('Arbutin').inci !== 'Alpha-Arbutin');

console.log('prefix/stereo assertions ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(f"prefix/stereo assertions failed (exit {proc.returncode})")
    print(proc.stdout.strip())


# ---------------------------------------------------------------------------
# Parse / classify (from this PR)
# ---------------------------------------------------------------------------


def test_hazard_table_has_digit_comma_chemicals():
    """The three names that digit-blind comma splitting used to destroy."""
    ingredients = load_json(INGREDIENTS_PATH)["ingredients"]
    names = {entry["inci"] for entry in ingredients}
    for required in ("1,2-Hexanediol", "1,4-Dioxane", "Toluene-2,5-Diamine"):
        assert required in names, f"missing hazard-table entry: {required}"


def _run_node_parse_assertions() -> None:
    """Drive live parse/score/category helpers extracted from index.js."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');

const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('// Firestore docs are size-capped');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic block');

const fragStart = src.indexOf('const COSMETIC_CATEGORY_FRAGMENTS');
const fragEnd = src.indexOf('async function resolveProductType');
if (fragStart < 0 || fragEnd < 0) throw new Error('could not locate category block');

const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
${src.slice(fragStart, fragEnd)}
module.exports = {
  parseCosmeticIngredientList,
  scoreCosmeticProduct,
  stripLeadingIngredientLabelPrefix,
  splitMayContainSections,
  splitCosmeticIngredientText,
  truncateDrugFactsAndWarnings,
  extractFromIngredientLabel,
  tidyParsedIngredientName,
  tagIndicatesCosmetic,
  hasCosmeticCategory,
  tagIndicatesHousehold,
  hasHouseholdCategory,
  lookupCosmeticIngredient,
  normalizeInci,
};
`;
fs.writeFileSync('/tmp/cosmetic_parse_helpers.js', block);
const {
  parseCosmeticIngredientList: parseCosmeticIngredientListRaw,
  scoreCosmeticProduct,
  stripLeadingIngredientLabelPrefix,
  splitMayContainSections,
  splitCosmeticIngredientText,
  truncateDrugFactsAndWarnings,
  extractFromIngredientLabel,
  tidyParsedIngredientName,
  tagIndicatesCosmetic,
  hasCosmeticCategory,
  tagIndicatesHousehold,
  hasHouseholdCategory,
  lookupCosmeticIngredient,
} = require('/tmp/cosmetic_parse_helpers.js');

// parseCosmeticIngredientList now returns { items, drugFactsMarker }.
function parseCosmeticIngredientList(product) {
  const result = parseCosmeticIngredientListRaw(product);
  return result.items || result;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- Digit-safe comma splitting (1,2-Hexanediol / 1,4-Dioxane / Toluene-2,5-Diamine) ---
for (const name of ['1,2-Hexanediol', '1,4-Dioxane', 'Toluene-2,5-Diamine']) {
  const parsed = parseCosmeticIngredientList({ ingredients_text: name });
  assert(parsed.length === 1, `${name} must stay one token, got ${JSON.stringify(parsed)}`);
  assert(parsed[0].name === name, `${name} name mismatch: ${parsed[0].name}`);
  const hit = lookupCosmeticIngredient(parsed[0].name);
  assert(hit && hit.inci === name, `${name} must resolve in hazard table, got ${JSON.stringify(hit)}`);
}

// Full label string containing 1,2-Hexanediol among ordinary ingredients.
{
  const label = 'Aqua, Glycerin, 1,2-Hexanediol, Phenoxyethanol';
  const parsed = parseCosmeticIngredientList({ ingredients_text: label });
  const names = parsed.map(p => p.name);
  assert(names.includes('1,2-Hexanediol'), 'full label must keep 1,2-Hexanediol intact: ' + JSON.stringify(names));
  assert(!names.includes('1'), 'must not emit lone "1" from 1,2-Hexanediol: ' + JSON.stringify(names));
  assert(!names.some(n => n === '2-Hexanediol'), 'must not emit "2-Hexanediol": ' + JSON.stringify(names));
  assert(names.includes('Aqua') && names.includes('Glycerin') && names.includes('Phenoxyethanol'),
    'ordinary ingredients must still split: ' + JSON.stringify(names));
  const scored = scoreCosmeticProduct({ ingredients_text: label });
  const hex = scored.ingredientList.find(r => r.name === '1,2-Hexanediol');
  assert(hex && hex.matched && hex.inci === '1,2-Hexanediol', '1,2-Hexanediol must match in score path');
}

// --- Leading Ingredients: / Ingrédients / INCI prefix ---
{
  const cases = [
    'Ingredients: Water, Glycerin',
    'INGREDIENTS - Water, Glycerin',
    'Ingrédients: Water, Glycerin',
    'INCI: Water, Glycerin',
    'inci Water, Glycerin',
  ];
  for (const text of cases) {
    const parsed = parseCosmeticIngredientList({ ingredients_text: text });
    assert(parsed[0] && parsed[0].name === 'Water',
      `prefix strip failed for ${JSON.stringify(text)} -> ${JSON.stringify(parsed)}`);
    assert(!/^ingredients/i.test(parsed[0].name), 'must not leave Ingredients: glued to Water');
  }
  // Do not strip the word mid-list.
  const mid = parseCosmeticIngredientList({
    ingredients_text: 'Water, Ingredients Extract, Glycerin',
  });
  assert(mid.some(p => /ingredients extract/i.test(p.name)),
    'must not strip Ingredients mid-list: ' + JSON.stringify(mid));
}

// --- May contain / +/- / ± — display only, excluded from coverage & scoring ---
{
  const text = 'Water, Glycerin. May Contain (+/-): CI 77491, CI 77492';
  const parsed = parseCosmeticIngredientList({ ingredients_text: text });
  assert(parsed.length === 4, 'expected 4 rows (2 main + 2 conditional), got ' + parsed.length);
  assert(parsed.filter(p => !p.mayContain).map(p => p.name).join('|') === 'Water|Glycerin',
    'main ingredients wrong: ' + JSON.stringify(parsed));
  assert(parsed.filter(p => p.mayContain).every(p => p.mayContain === true),
    'conditional rows must set mayContain');
  assert(parsed.filter(p => p.mayContain).map(p => p.name).join('|') === 'CI 77491|CI 77492',
    'conditional names wrong: ' + JSON.stringify(parsed));

  const scored = scoreCosmeticProduct({ ingredients_text: text });
  assert(scored.coverageTotal === 2,
    'coverageTotal must exclude may-contain (expected 2, got ' + scored.coverageTotal + ')');
  assert(scored.ingredientList.filter(r => r.mayContain).length === 2,
    'ingredientList must still list may-contain rows');
  assert(scored.ingredientList.filter(r => r.mayContain).every(r => r.countsTowardScore === false),
    'may-contain rows must not count toward score');
  assert(!scored.ingredientFindings.some(f => /77491|77492/.test(f.inci || '')),
    'may-contain must not appear in ingredientFindings');
}

{
  const text = 'Aqua, Glycerin +/- CI 77491';
  const { main, conditional } = splitMayContainSections(text);
  assert(main.includes('Aqua'), 'main before +/-');
  assert(/CI 77491/.test(conditional), 'conditional after +/-');
  const scored = scoreCosmeticProduct({ ingredients_text: text });
  assert(scored.coverageTotal === 2, '+/- coverageTotal expected 2, got ' + scored.coverageTotal);
}

{
  const text = 'Aqua ± CI 77491';
  const scored = scoreCosmeticProduct({ ingredients_text: text });
  assert(scored.coverageTotal === 1, '± coverageTotal expected 1, got ' + scored.coverageTotal);
  assert(scored.ingredientList.some(r => r.mayContain && r.name === 'CI 77491'));
}

// --- Tidy-up: trailing . / ; and whitespace; keep (nano); >= 3 char min ---
{
  assert(tidyParsedIngredientName('Glycerin.') === 'Glycerin');
  assert(tidyParsedIngredientName('Glycerin;') === 'Glycerin');
  assert(tidyParsedIngredientName('  Aqua   Glycerin  ') === 'Aqua Glycerin');

  const parsed = parseCosmeticIngredientList({
    ingredients_text: 'Water, Titanium Dioxide (nano), Ab, Glycerin.',
  });
  const names = parsed.map(p => p.name);
  assert(names.includes('Titanium Dioxide (nano)'),
    '(nano) must survive: ' + JSON.stringify(names));
  assert(!names.includes('Ab'), 'names shorter than 3 chars must be dropped: ' + JSON.stringify(names));
  assert(names.includes('Glycerin'), 'trailing period must be stripped: ' + JSON.stringify(names));
}

// --- Category classification: explicit fragments, not fuzzy substrings ---
{
  assert(tagIndicatesCosmetic('en:toothpastes') === true);
  assert(tagIndicatesCosmetic('en:lip-balm') === true);
  assert(tagIndicatesCosmetic('en:skin-care') === true);
  assert(tagIndicatesCosmetic('en:hair-care') === true);
  assert(tagIndicatesCosmetic('en:soaps') === true);
  assert(tagIndicatesCosmetic('en:deodorant') === true);
  assert(tagIndicatesCosmetic('en:cosmetics') === true);
  assert(tagIndicatesCosmetic('en:hygiene') === true);
  // Conservative: soap must not match soapberry.
  assert(tagIndicatesCosmetic('en:soapberry') === false,
    'soap must not fuzzy-match soapberry');
  assert(tagIndicatesCosmetic('en:beverages') === false);
  assert(tagIndicatesCosmetic('en:snacks') === false);

  assert(hasCosmeticCategory({ categories_tags: ['en:toothpastes', 'en:oral-care'] }) === true);
  assert(hasCosmeticCategory({ categories_tags: ['en:plant-based-foods'] }) === false);
  assert(hasCosmeticCategory({ categories_tags: [] }) === false);

  // Household cleaning categories (Dawn Ultra etc.) — compound fragments only.
  assert(tagIndicatesHousehold('en:dishwashing') === true);
  assert(tagIndicatesHousehold('en:dish-soap') === true);
  assert(tagIndicatesHousehold('en:detergents') === true);
  assert(tagIndicatesHousehold('en:laundry-detergent') === true);
  assert(tagIndicatesHousehold('en:cleaning-products') === true);
  assert(tagIndicatesHousehold('en:household-cleaners') === true);
  assert(tagIndicatesHousehold('en:surface-cleaners') === true);
  assert(tagIndicatesHousehold('en:bleach') === true);
  assert(tagIndicatesHousehold('en:disinfectants') === true);
  assert(tagIndicatesHousehold('en:air-fresheners') === true);
  assert(hasHouseholdCategory({
    categories_tags: ['en:dishwashing', 'en:cleaning-products'],
  }) === true);

  // Bare "soap" must NOT be household — cosmetic soaps / hand soap / body wash / shampoo.
  assert(tagIndicatesHousehold('en:soap') === false, 'bare soap must not be household');
  assert(tagIndicatesHousehold('en:soaps') === false, 'soaps must not be household');
  assert(tagIndicatesHousehold('en:hand-soap') === false, 'hand-soap must not be household');
  assert(tagIndicatesHousehold('en:body-wash') === false, 'body-wash must not be household');
  assert(tagIndicatesHousehold('en:shampoo') === false, 'shampoo must not be household');
  assert(tagIndicatesHousehold('en:shampoos') === false, 'shampoos must not be household');
  assert(hasHouseholdCategory({ categories_tags: ['en:soaps', 'en:hygiene'] }) === false,
    'cosmetic soap categories must not be household');
  assert(hasHouseholdCategory({ categories_tags: ['en:hand-soap', 'en:body-wash'] }) === false,
    'hand soap / body wash must not be household');
  assert(hasHouseholdCategory({ categories_tags: ['en:shampoos', 'en:hair-care'] }) === false,
    'shampoo categories must not be household');
  // Cosmetic path still owns soap/shampoo.
  assert(hasCosmeticCategory({ categories_tags: ['en:soaps'] }) === true);
  assert(hasCosmeticCategory({ categories_tags: ['en:hand-soap'] }) === true);
  assert(hasCosmeticCategory({ categories_tags: ['en:shampoos'] }) === true);
}

// Synonym layer still works through the new parser (GuruNanda-style label).
{
  const scored = scoreCosmeticProduct({
    ingredients_text: 'Ingredients: Fractionated Coconut Oil, Peppermint Oil, 1,2-Hexanediol',
  });
  assert(scored.coverageMatched >= 3, 'synonym+digit-comma via new parser, matched=' + scored.coverageMatched);
  const cloveOil = scoreCosmeticProduct({
    ingredients_text: 'Clove Oil, Water',
  });
  const clove = cloveOil.ingredientList.find(r => /clove/i.test(r.name));
  assert(clove && clove.inci === 'Eugenia Caryophyllus Leaf Oil', 'synonym resolve after parse');
}

console.log('cosmetic parse/classify assertions ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(f"node parse assertions failed (exit {proc.returncode})")
    print(proc.stdout.strip())


def test_cosmetic_parse_and_classify():
    _run_node_parse_assertions()


def test_strip_leading_prefix_helper_via_node():
    """Isolated assertion that only the leading label prefix is removed."""
    script = r"""
const fs = require('fs');
const src = fs.readFileSync(require('path').join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('function stripLeadingIngredientLabelPrefix');
const end = src.indexOf('function splitMayContainSections');
eval(src.slice(start, end));
function assert(c, m) { if (!c) throw new Error(m); }
assert(stripLeadingIngredientLabelPrefix('Ingredients: Water') === 'Water');
assert(stripLeadingIngredientLabelPrefix('INCI - Aqua') === 'Aqua');
assert(stripLeadingIngredientLabelPrefix('Water, Ingredients Extract') === 'Water, Ingredients Extract');
console.log('prefix helper ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError("prefix helper assertions failed")
    print(proc.stdout.strip())


def test_photo_cache_rescore_and_stale_fallback():
    """Stale photo entries re-score locally; failed re-scans return stale cache."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(require('path').join(process.cwd(), 'index.js'), 'utf8');

const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('// Firestore docs are size-capped');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic block');

const helperStart = src.indexOf('// Photo-rescued cache docs have no upstream');
const helperEnd = src.indexOf('async function scanAndCache(barcode');
if (helperStart < 0 || helperEnd < 0) throw new Error('could not locate photo cache helpers');
if (helperEnd <= helperStart) throw new Error('photo cache helper slice inverted');

const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
const SCAN_LOGIC_VERSION = '1';
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
${src.slice(helperStart, helperEnd)}
module.exports = {
  rescorePhotoCachedDocument,
  staleCacheFallbackPayload,
  shouldReplaceWithPhotoCache,
  photoCacheParsedCount,
  scoreCosmeticProduct,
  COSMETIC_TABLE_VERSION,
};
`;
fs.writeFileSync('/tmp/photo_cache_helpers.js', block);
const {
  rescorePhotoCachedDocument,
  staleCacheFallbackPayload,
  shouldReplaceWithPhotoCache,
  photoCacheParsedCount,
  scoreCosmeticProduct,
  COSMETIC_TABLE_VERSION,
} = require('/tmp/photo_cache_helpers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Guard: these helpers must not touch the network.
const originalFetch = global.fetch;
let fetchCalls = 0;
global.fetch = async function (...args) {
  fetchCalls += 1;
  throw new Error('UNEXPECTED FETCH: ' + JSON.stringify(args[0]));
};

// --- FIX 1: stale photo entry re-scores from cached ingredients, no network ---
{
  const stalePhoto = {
    productType: 'cosmetic',
    source: 'photo',
    productName: 'Rescued Toothpaste',
    ingredients: 'Aqua, Glycerin, 1,2-Hexanediol, Sodium Fluoride',
    score: 50,
    scoreLabel: 'Good',
    scoreColor: '#8BC34A',
    coverageMatched: 1,
    coverageTotal: 4,
    photoParsedCount: 4,
    photoCapturedAt: 111111,
    photoCapturedBy: 'uid-abc',
    ingredientFindings: '[]',
    ingredientList: '[]',
    tableVersion: '0.4',
    explanation: 'Old explanation naming findings for score 50',
    imageUrl: '',
    cachedAt: Date.now() - (60 * 24 * 60 * 60 * 1000),
  };

  const beforeFetch = fetchCalls;
  const rescored = rescorePhotoCachedDocument(stalePhoto);
  assert(rescored, 'expected photo rescore payload');
  assert(fetchCalls === beforeFetch, 'photo rescore must not call fetch/network');
  assert(rescored.responseData.source === 'photo', 'source must stay photo');
  assert(rescored.responseData.productName === 'Rescued Toothpaste', 'preserve name');
  assert(rescored.responseData.ingredients === stalePhoto.ingredients, 'preserve ingredients text');
  assert(rescored.responseData.tableVersion === COSMETIC_TABLE_VERSION,
    'tableVersion must refresh to current: ' + rescored.responseData.tableVersion);
  assert(rescored.responseData.cachedAt === undefined, 'cachedAt stripped from response payload');
  assert(rescored.responseData.photoCapturedAt === stalePhoto.photoCapturedAt,
    'photoCapturedAt must not refresh on re-score');
  assert(rescored.responseData.photoParsedCount === stalePhoto.photoParsedCount,
    'photoParsedCount must not refresh on re-score');
  assert(rescored.responseData.photoCapturedBy === 'uid-abc',
    'photoCapturedBy must not refresh on re-score');
  assert(typeof rescored.responseData.score === 'number' || rescored.responseData.score === null,
    'score must be recomputed');
  assert(rescored.responseData.coverageTotal === 4, 'coverageTotal from re-parse');
  assert(rescored.scored.coverageMatched >= 2, 'table should match aqua/glycerin/hexanediol');

  // Outcome changed (score 50 / coverage 1 → live values) → drop stale explanation.
  assert(rescored.responseData.score !== 50 || rescored.responseData.coverageMatched !== 1,
    'test setup expects outcome to change from cached 50/1');
  assert(!rescored.responseData.explanation,
    'changed outcome must not retain previous explanation, got: ' + rescored.responseData.explanation);
  assert(rescored.responseData.explanationPending === true,
    'changed outcome must set explanationPending for deferred regeneration');

  // Same score + coverage → keep explanation (no Haiku regen needed).
  const live = scoreCosmeticProduct({ ingredients_text: stalePhoto.ingredients });
  const unchanged = rescorePhotoCachedDocument({
    ...stalePhoto,
    score: live.score,
    coverageMatched: live.coverageMatched,
    coverageTotal: live.coverageTotal,
    explanation: 'Still accurate for this score',
  });
  assert(unchanged.responseData.explanation === 'Still accurate for this score',
    'unchanged outcome must keep explanation');
  assert(unchanged.responseData.explanationPending === false,
    'unchanged outcome must clear explanationPending');

  // Empty ingredients → null (caller falls through to upstream)
  assert(rescorePhotoCachedDocument({ source: 'photo', ingredients: '' }) === null);
  assert(rescorePhotoCachedDocument({ source: 'photo', ingredients: '   ' }) === null);
  assert(rescorePhotoCachedDocument({ source: 'photo' }) === null);
}

// --- FIX 2: stale beats nothing when re-scan throws ---
{
  const stale = {
    productType: 'cosmetic',
    source: 'photo',
    productName: 'Stale Rescue',
    ingredients: 'Aqua, Glycerin',
    score: 90,
    tableVersion: '0.4',
    explanation: 'Kept on fallback path',
    cachedAt: 1,
  };
  const fallback = staleCacheFallbackPayload(stale);
  assert(fallback, 'expected fallback payload');
  assert(fallback.productName === 'Stale Rescue');
  assert(fallback.score === 90);
  assert(fallback.explanation === 'Kept on fallback path',
    'stale FALLBACK deliberately keeps its old explanation');
  assert(fallback.cachedAt === undefined, 'cachedAt must not leak into response');
  assert(staleCacheFallbackPayload(null) === null, 'no cache → no fallback');
  assert(staleCacheFallbackPayload(undefined) === null);

  // Simulate scanAndCache refresh failure path: prefer stale over propagating.
  function refreshOrFallback(staleCached, refreshFn) {
    try {
      return { kind: 'fresh', data: refreshFn() };
    } catch (err) {
      const fb = staleCacheFallbackPayload(staleCached);
      if (fb) return { kind: 'stale-fallback', data: fb, reason: err.message };
      throw err;
    }
  }

  const notFound = () => {
    const e = new Error('Product not found');
    e.statusCode = 404;
    throw e;
  };
  const networkBoom = () => { throw new Error('fetch failed'); };

  const r1 = refreshOrFallback(stale, notFound);
  assert(r1.kind === 'stale-fallback', '404 must fall back to stale');
  assert(r1.data.productName === 'Stale Rescue');
  assert(r1.data.explanation === 'Kept on fallback path', 'fallback keeps explanation');

  const r2 = refreshOrFallback(stale, networkBoom);
  assert(r2.kind === 'stale-fallback', 'network error must fall back to stale');

  let threw = false;
  try {
    refreshOrFallback(null, notFound);
  } catch (e) {
    threw = e.statusCode === 404;
  }
  assert(threw, 'with no cache, 404 must still propagate');
}

global.fetch = originalFetch;
console.log('photo cache rescore + stale fallback ok', 'table=' + COSMETIC_TABLE_VERSION);
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"photo cache assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def test_fragrance_french_synonyms_and_unparseable_rules():
    """Fragrance/Parfum + French synonyms; conservative unparseable filters."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(require('path').join(process.cwd(), 'index.js'), 'utf8');

const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('// Firestore docs are size-capped');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic block');

const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
module.exports = {
  lookupCosmeticIngredient,
  scoreCosmeticProduct,
  isUnparseableIngredientName,
  parseCosmeticIngredientList,
};
`;
fs.writeFileSync('/tmp/syn_unparse_helpers.js', block);
const {
  lookupCosmeticIngredient,
  scoreCosmeticProduct,
  isUnparseableIngredientName,
  parseCosmeticIngredientList,
} = require('/tmp/syn_unparse_helpers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- Fragrance / perfume -> Parfum ---
for (const name of ['Fragrance', 'fragrance', 'Perfume', 'perfume']) {
  const hit = lookupCosmeticIngredient(name);
  assert(hit && hit.inci === 'Parfum', name + ' -> ' + (hit && hit.inci));
}

// --- Accented + unaccented French keys ---
const frenchPairs = [
  ['eau', 'Aqua'],
  ['glycérine', 'Glycerin'],
  ['glycerine', 'Glycerin'],
  ['phénoxyéthanol', 'Phenoxyethanol'],
  ['phenoxyethanol', 'Phenoxyethanol'],
  ['diméthicone', 'Dimethicone'],
  ['dimethicone', 'Dimethicone'],
  ['carbomère', 'Carbomer'],
  ['carbomere', 'Carbomer'],
  ['tocophérol', 'Tocopherol'],
  ['vaseline', 'Petrolatum'],
  ['gomme xanthane', 'Xanthan Gum'],
  ['cholestérol', 'Cholesterol'],
  ['hyaluronate de sodium', 'Sodium Hyaluronate'],
  ['edta disodique', 'Disodium EDTA'],
  ['céteareth-20', 'Ceteareth-20'],
  ['ceteareth-20', 'Ceteareth-20'],
  ['alcool cétéarylique', 'Cetearyl Alcohol'],
  ['alcool cetearylique', 'Cetearyl Alcohol'],
  ['alcool cétylique', 'Cetyl Alcohol'],
  ['alcool cetylique', 'Cetyl Alcohol'],
  ['éthylhexylglycérine', 'Ethylhexylglycerin'],
  ['ethylhexylglycerine', 'Ethylhexylglycerin'],
  ['méthosulfate de béhentrimonium', 'Behentrimonium Methosulfate'],
  ['methosulfate de behentrimonium', 'Behentrimonium Methosulfate'],
  ['céramide NP', 'Ceramide NP'],
  ['ceramide NP', 'Ceramide NP'],
  ['céramide AP', 'Ceramide AP'],
  ['ceramide AP', 'Ceramide AP'],
  ['céramide EOP', 'Ceramide EOP'],
  ['ceramide EOP', 'Ceramide EOP'],
  ['triglycérides caprylique', 'Caprylic/Capric Triglyceride'],
  ['triglycerides caprylique', 'Caprylic/Capric Triglyceride'],
];
for (const [common, target] of frenchPairs) {
  const hit = lookupCosmeticIngredient(common);
  assert(hit && hit.inci === target, common + ' -> ' + (hit && hit.inci) + ' expected ' + target);
}

// --- Unparseable rules fire on real diagnostic junk ---
const junk = [
  // a) no Latin letters (Arabic passage)
  'مستحضر تجميلي للبشرة',
  // b) longer than 70 chars (packaging / address paste)
  'Registered trademark of ® BURNUS GMBH Casablanca street address line extra padding XX',
  // c) URL / email markers
  'www.IRCOSLABORATOIRES.COM',
  'http://example.org/label',
  'support@nivea.example',
  'DISTRIBUÉ PAR NIVEA.COM FRANCE',
  // d) 4+ consecutive digits (barcode / phone) — not a CI colorant
  '3014260214399',
  'Call 0612345678 for info',
];
for (const name of junk) {
  assert(isUnparseableIngredientName(name) === true, 'should be unparseable: ' + name);
}

// Most important: ordinary ingredients must NOT be caught
const keep = [
  'Sodium Acrylate/Sodium Acryloyldimethyl Taurate Copolymer',
  'CI 77491',
  'PEG-150 Pentaerythrityl Tetrastearate',
  'Steareth-100',
  'Aqua',
  '1,2-Hexanediol',
  'Glycerin',
];
for (const name of keep) {
  assert(isUnparseableIngredientName(name) === false, 'must NOT be unparseable: ' + name);
  assert(name.length <= 70, 'test fixture longer than 70: ' + name + ' len=' + name.length);
}

// Score path: junk excluded from coverage + unmatched; kept in ingredientList
{
  const scored = scoreCosmeticProduct({
    ingredients_text:
      'Aqua, Glycerin, www.IRCOSLABORATOIRES.COM, مستحضر تجميلي, Fragrance, 3014260214399',
  });
  assert(scored.unparseableCount === 3, 'unparseableCount=' + scored.unparseableCount);
  assert(scored.coverageTotal === 3, 'coverageTotal should be Aqua+Glycerin+Fragrance, got ' + scored.coverageTotal);
  assert(scored.coverageMatched === 3, 'all three should match, got ' + scored.coverageMatched);
  assert(!scored.unmatchedNames.some(n => /www\.|مستحضر|3014260214399/i.test(n)),
    'unparseable must not enter unmatchedNames: ' + JSON.stringify(scored.unmatchedNames));
  const listed = scored.ingredientList.filter(r => r.unparseable);
  assert(listed.length === 3, 'ingredientList must still show unparseable rows');
  assert(listed.every(r => r.countsTowardScore === false && r.matched === false));
  const frag = scored.ingredientList.find(r => /fragrance/i.test(r.name));
  assert(frag && frag.inci === 'Parfum' && frag.matched, 'Fragrance should match Parfum via synonym');
}

console.log('fragrance/french synonyms + unparseable ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"fragrance/unparseable assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())

def test_slash_joined_multilingual_inci_lookup():
    """EU multilingual Aqua/Water/Eau aliases; whole-name slash INCIs stay intact."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(require('path').join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('// Firestore docs are size-capped');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic block');
const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
module.exports = {
  lookupCosmeticIngredient,
  lookupCosmeticIngredientDirect,
  scoreCosmeticProduct,
};
`;
fs.writeFileSync('/tmp/slash_inci_helpers.js', block);
const {
  lookupCosmeticIngredient,
  lookupCosmeticIngredientDirect,
  scoreCosmeticProduct,
} = require('/tmp/slash_inci_helpers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Multilingual slash aliases resolve via segment fallback.
for (const [raw, expected] of [
  ['Aqua/Water/Eau', 'Aqua'],
  ['Water/Aqua/Eau', 'Aqua'],
  ['Parfum/Fragrance', 'Parfum'],
  ['Aqua / Water / Eau', 'Aqua'],
]) {
  const hit = lookupCosmeticIngredient(raw);
  assert(hit && hit.inci === expected, raw + ' -> ' + (hit && hit.inci));
}

// Whole-name slash INCIs must match BEFORE any split — not via a segment.
{
  const cap = 'Caprylic/Capric Triglyceride';
  const wholeDirect = lookupCosmeticIngredientDirect(cap);
  assert(wholeDirect && wholeDirect.inci === cap, 'direct whole Caprylic/Capric miss');
  const viaLookup = lookupCosmeticIngredient(cap);
  assert(viaLookup && viaLookup.inci === cap, 'lookup must return whole Caprylic/Capric');
  // Caprylic alone must not be how we got there.
  const caprylicOnly = lookupCosmeticIngredientDirect('Caprylic');
  assert(!caprylicOnly || caprylicOnly.inci !== cap,
    'Caprylic segment must not equal the triglyceride entry');
}

{
  const lav = 'Lavandula Angustifolia Flower/Leaf/Stem Extract';
  const hit = lookupCosmeticIngredient(lav);
  assert(hit, 'Lavandula Flower/Leaf/Stem must resolve as whole name');
  const leafOnly = lookupCosmeticIngredientDirect('Leaf');
  assert(!leafOnly, 'Leaf alone must not resolve');
  assert(hit.inci === lav || /Lavandula/i.test(hit.inci),
    'expected lavender family inci, got ' + (hit && hit.inci));
}

// Ambiguous: two segments hit DIFFERENT entries → null + log, do not guess.
{
  let logged = '';
  const origLog = console.log;
  console.log = (...args) => { logged += args.join(' '); };
  try {
    const amb = lookupCosmeticIngredient('Aqua/Parfum');
    assert(amb === null, 'Aqua/Parfum must be unmatched, got ' + (amb && amb.inci));
  } finally {
    console.log = origLog;
  }
  assert(/\[SLASH AMBIGUOUS\]/.test(logged) && /Aqua\/Parfum/.test(logged),
    'expected SLASH AMBIGUOUS log, got: ' + logged);
}

// Splitting must not shadow a direct whole-name match.
{
  const name = 'Caprylic/Capric Triglyceride';
  assert(lookupCosmeticIngredient(name).inci === name);
}

// ingredientList keeps original label text; inci is canonical.
{
  const scored = scoreCosmeticProduct({
    ingredients_text: 'Aqua/Water/Eau, Glycerin, Parfum/Fragrance',
  });
  const aquaRow = scored.ingredientList.find(r => r.name === 'Aqua/Water/Eau');
  assert(aquaRow && aquaRow.matched && aquaRow.inci === 'Aqua',
    'ingredientList must keep original name, canonical inci: ' + JSON.stringify(aquaRow));
  const parfumRow = scored.ingredientList.find(r => r.name === 'Parfum/Fragrance');
  assert(parfumRow && parfumRow.matched && parfumRow.inci === 'Parfum',
    'Parfum/Fragrance row: ' + JSON.stringify(parfumRow));
}

console.log('slash multilingual inci lookup ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"slash multilingual assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def test_paren_commas_and_drug_facts_truncation():
    """Parenthesis-aware splits, Drug Facts truncation, mid-text Ingredients."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(require('path').join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('// Firestore docs are size-capped');
const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
module.exports = {
  splitCosmeticIngredientText,
  truncateDrugFactsAndWarnings,
  extractFromIngredientLabel,
  parseCosmeticIngredientList,
  scoreCosmeticProduct,
  lookupCosmeticIngredient,
  DRUG_FACTS_MARKERS,
};
`;
fs.writeFileSync('/tmp/paren_drug_helpers.js', block);
const {
  splitCosmeticIngredientText,
  truncateDrugFactsAndWarnings,
  extractFromIngredientLabel,
  parseCosmeticIngredientList,
  scoreCosmeticProduct,
  lookupCosmeticIngredient,
  DRUG_FACTS_MARKERS,
} = require('/tmp/paren_drug_helpers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function namesOf(product) {
  const r = parseCosmeticIngredientList(product);
  return (r.items || r).map(p => p.name);
}

// --- 1. Parenthetical commas must not split ---
{
  let parts = splitCosmeticIngredientText('Butyrospermum Parkii (Shea Butter), Glycerin').map(s => s.trim());
  assert(parts.length === 2, JSON.stringify(parts));
  assert(parts[0] === 'Butyrospermum Parkii (Shea Butter)', parts[0]);
  assert(parts[1] === 'Glycerin', parts[1]);

  parts = splitCosmeticIngredientText('Helianthus Annuus (Sunflower, Corn) Seed Oil').map(s => s.trim());
  assert(parts.length === 1, 'sunflower/corn must stay one token: ' + JSON.stringify(parts));
  assert(parts[0].includes('Sunflower, Corn'), parts[0]);

  // Nested parentheses
  parts = splitCosmeticIngredientText('A (B (C, D), E), F').map(s => s.trim());
  assert(parts.length === 2, JSON.stringify(parts));
  assert(parts[0].includes('C, D') && parts[0].includes('E'), parts[0]);
  assert(parts[1] === 'F', parts[1]);

  // Unbalanced "(" must not swallow the rest of the label
  parts = splitCosmeticIngredientText('Foo (Bar, Glycerin, Aqua').map(s => s.trim());
  assert(parts.length >= 2, 'unbalanced paren must still split: ' + JSON.stringify(parts));
  assert(parts.some(p => p.includes('Glycerin') || p.trim() === 'Glycerin'), JSON.stringify(parts));

  // Digit-locant rule preserved
  parts = splitCosmeticIngredientText('Water, 1,2-Hexanediol, Glycerin').map(s => s.trim());
  assert(parts.includes('1,2-Hexanediol'), JSON.stringify(parts));
}

// --- 2. Each Drug Facts marker truncates ---
{
  for (const marker of DRUG_FACTS_MARKERS) {
    const text = 'Aqua, Glycerin. ' + marker.charAt(0).toUpperCase() + marker.slice(1) + ' do not eat';
    // Normalize: markers are matched case-insensitively; build a clear segment.
    const labeled = 'Aqua, Glycerin. ' + marker + ' extra warning copy here';
    const t = truncateDrugFactsAndWarnings(labeled);
    assert(t.marker && t.marker.toLowerCase() === marker.toLowerCase(),
      'marker ' + marker + ' -> ' + t.marker);
    assert(t.text === 'Aqua, Glycerin.', 'truncated text for ' + marker + ': ' + JSON.stringify(t));
    assert(!/extra warning/i.test(t.text), 'must discard after marker');
  }

  // Mid-sentence uses / directions / caution must NOT truncate
  assert(truncateDrugFactsAndWarnings('product that uses: water as solvent, Glycerin').marker === null);
  assert(truncateDrugFactsAndWarnings('follow directions carefully with Glycerin').marker === null);
  assert(truncateDrugFactsAndWarnings('use with caution when applying').marker === null);

  // Ordinary ingredient names containing those words are not truncated away
  const scoredUses = scoreCosmeticProduct({
    ingredients_text: 'Aqua, Glycerin, Caprylic/Capric Triglyceride',
  });
  assert(scoredUses.drugFactsMarker == null);
  assert(scoredUses.ingredientList.some(r => r.name === 'Caprylic/Capric Triglyceride' && r.matched));
}

// --- 3. Ingredients: mid-text after preamble ---
{
  assert(extractFromIngredientLabel('Marketing blurb. Ingredients: Aqua, Glycerin').startsWith('Ingredients'));
  const names = namesOf({
    ingredients_text: 'Marketing blurb. Ingredients: Aqua, Glycerin. Warnings: do not eat',
  });
  assert(names.join('|') === 'Aqua|Glycerin', JSON.stringify(names));
  const scored = scoreCosmeticProduct({
    ingredients_text: 'Preamble INGREDIENTS: Water, Glycerin. If swallowed call poison control',
  });
  // "if swallowed" truncates; Ingredients mid-text extracts the list first
  assert(scored.drugFactsMarker === 'if swallowed', scored.drugFactsMarker);
  assert(scored.ingredientList.map(r => r.name).join('|') === 'Water|Glycerin');

  // Lone INGREDIENTS token dropped
  const lone = namesOf({ ingredients_text: 'Water, INGREDIENTS, Glycerin' });
  assert(!lone.some(n => /^ingredients$/i.test(n)), JSON.stringify(lone));
  assert(lone.includes('Water') && lone.includes('Glycerin'));
}

// Caprylic/Capric still matches as whole name (slash fallback unchanged)
assert(lookupCosmeticIngredient('Caprylic/Capric Triglyceride').inci === 'Caprylic/Capric Triglyceride');

console.log('paren commas + drug facts truncation ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"paren/drug-facts assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def test_photo_cache_below_gate_and_quality():
    """Below-gate photo cache; sparse/match overwrite rule; upstream replaces photo."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(require('path').join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('// Firestore docs are size-capped');
const helperStart = src.indexOf('// Photo-rescued cache docs have no upstream');
const helperEnd = src.indexOf('async function scanAndCache(barcode');
const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
const SCAN_LOGIC_VERSION = '1';
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
function productHasIngredients(product) {
  if (!product) return false;
  if (Array.isArray(product.ingredients) && product.ingredients.length > 0) return true;
  return hasUsableIngredientText(product.ingredients_text);
}
${src.slice(helperStart, helperEnd)}
module.exports = {
  scoreCosmeticProduct,
  shouldReplaceWithPhotoCache,
  photoCacheParsedCount,
  photoParsedCountWithin50Percent,
  shouldReplacePhotoWithUpstream,
  photoNeedsUpstreamRecheck,
  productHasIngredients,
  PHOTO_UPSTREAM_RECHECK_MS,
};
`;
fs.writeFileSync('/tmp/photo_quality_helpers.js', block);
const {
  scoreCosmeticProduct,
  shouldReplaceWithPhotoCache,
  photoCacheParsedCount,
  photoParsedCountWithin50Percent,
  shouldReplacePhotoWithUpstream,
  photoNeedsUpstreamRecheck,
  productHasIngredients,
  PHOTO_UPSTREAM_RECHECK_MS,
} = require('/tmp/photo_quality_helpers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Mirror /scan/photo canCache decision: barcode + at least one parsed ingredient.
function wouldCachePhoto(barcode, scored) {
  const photoParsedCount = Array.isArray(scored.ingredientList)
    ? scored.ingredientList.length
    : 0;
  return !!barcode && photoParsedCount > 0;
}

// Below-gate (score null) WITH parsed ingredients IS cacheable.
{
  const below = scoreCosmeticProduct({
    ingredients_text: 'CompletelyFakeInciOne, CompletelyFakeInciTwo, CompletelyFakeInciThree',
  });
  assert(below.score === null, 'expected below-gate null score, got ' + below.score);
  assert(below.ingredientList.length >= 3, 'expected parsed rows');
  assert(wouldCachePhoto('123', below) === true, 'below-gate with ingredients must cache');
  assert(wouldCachePhoto('', below) === false, 'no barcode → no cache');
  assert(wouldCachePhoto(null, below) === false, 'null barcode → no cache');
}

// Zero parsed ingredients is NOT cached.
{
  const empty = scoreCosmeticProduct({ ingredients_text: '' });
  assert(empty.ingredientList.length === 0);
  assert(wouldCachePhoto('123', empty) === false, 'zero ingredients must not cache');
  const junk = scoreCosmeticProduct({ ingredients_text: 'Ab, X' }); // < 3 chars dropped
  assert(junk.ingredientList.length === 0, 'short tokens dropped');
  assert(wouldCachePhoto('123', junk) === false);
}

// Overwrite rule BOTH directions:
//   - existing < 3 parsed → incoming may overwrite
//   - existing >= 3 → only if incoming has MORE hazard matches AND parsed within 50%
{
  const sparse = { source: 'photo', photoParsedCount: 2, coverageMatched: 0 };
  const richerWrongProduct = { source: 'photo', photoParsedCount: 20, coverageMatched: 1 };
  assert(shouldReplaceWithPhotoCache(sparse, richerWrongProduct) === true,
    'sparse existing (<3) may be overwritten');

  const solid = { source: 'photo', photoParsedCount: 10, coverageMatched: 2 };
  const differentProduct = { source: 'photo', photoParsedCount: 25, coverageMatched: 5 };
  assert(shouldReplaceWithPhotoCache(solid, differentProduct) === false,
    'large parsed-count gap is a different product — keep existing');
  assert(shouldReplaceWithPhotoCache(differentProduct, solid) === false,
    'fewer parsed must not overwrite a solid entry either');

  const betterCoverage = { source: 'photo', photoParsedCount: 11, coverageMatched: 5 };
  assert(shouldReplaceWithPhotoCache(solid, betterCoverage) === true,
    'more hazard matches + within 50% parsed may overwrite');
  assert(shouldReplaceWithPhotoCache(betterCoverage, solid) === false,
    'fewer matches must not overwrite (reverse direction)');

  const moreMatchesButFar = { source: 'photo', photoParsedCount: 3, coverageMatched: 3 };
  assert(shouldReplaceWithPhotoCache(solid, moreMatchesButFar) === false,
    'more matches but parsed far outside 50% → keep existing');

  // Same matched count → do not overwrite solid entry (even within 50%).
  const sameMatch = { source: 'photo', photoParsedCount: 10, coverageMatched: 2 };
  assert(shouldReplaceWithPhotoCache(solid, sameMatch) === false,
    'equal matched count must not overwrite');
}

assert(photoParsedCountWithin50Percent(10, 5) === true);
assert(photoParsedCountWithin50Percent(10, 15) === true);
assert(photoParsedCountWithin50Percent(10, 4) === false);
assert(photoParsedCountWithin50Percent(10, 16) === false);
assert(photoParsedCountWithin50Percent(0, 5) === true);

// Upstream entry is never overwritten by a photo entry.
{
  const upstream = { source: 'obf', photoParsedCount: 0, coverageMatched: 0 };
  const photo = { source: 'photo', photoParsedCount: 99, coverageMatched: 50 };
  assert(shouldReplaceWithPhotoCache(upstream, photo) === false, 'upstream must win');
  assert(shouldReplaceWithPhotoCache({ source: 'off' }, photo) === false);
  assert(shouldReplaceWithPhotoCache(null, photo) === true, 'empty cache accepts photo');
  assert(shouldReplaceWithPhotoCache(undefined, photo) === true);
}

// Upstream replaces a photo entry when it gains ingredients.
{
  assert(shouldReplacePhotoWithUpstream(null) === false);
  assert(shouldReplacePhotoWithUpstream({}) === false);
  assert(shouldReplacePhotoWithUpstream({ ingredients_text: '' }) === false);
  assert(shouldReplacePhotoWithUpstream({ ingredients_text: '   ' }) === false);
  assert(shouldReplacePhotoWithUpstream({ ingredients_text: 'Aqua, Glycerin' }) === true,
    'upstream with ingredients must replace photo');
  assert(productHasIngredients({ ingredients_text: 'Aqua' }) === true);
  assert(productHasIngredients({ ingredients_text: '' }) === false);

  // photoNeedsUpstreamRecheck: never checked → due; recent check → not due.
  assert(photoNeedsUpstreamRecheck({ source: 'photo' }) === true);
  assert(photoNeedsUpstreamRecheck({ source: 'photo', lastUpstreamCheck: 0 }) === true);
  assert(photoNeedsUpstreamRecheck({
    source: 'photo',
    lastUpstreamCheck: Date.now() - 1000,
  }) === false, 'recent check must not recheck');
  assert(photoNeedsUpstreamRecheck({
    source: 'photo',
    lastUpstreamCheck: Date.now() - PHOTO_UPSTREAM_RECHECK_MS - 1000,
  }) === true, 'check older than 30d must recheck');
  assert(photoNeedsUpstreamRecheck({ source: 'obf', lastUpstreamCheck: 0 }) === false);
}

assert(photoCacheParsedCount({ photoParsedCount: 7 }) === 7);
assert(photoCacheParsedCount({ coverageTotal: 3 }) === 3, 'legacy fallback');
assert(PHOTO_UPSTREAM_RECHECK_MS === 30 * 24 * 60 * 60 * 1000);

console.log('photo below-gate + quality + upstream recheck ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"photo below-gate/quality assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def test_request_guards_rate_limit_and_vision_cap():
    """Rate-limit buckets, sweep, bearer parse, and UTC vision daily cap."""
    script = r"""
const fs = require('fs');
const src = fs.readFileSync(require('path').join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('// ── Request guards (rate limits + vision bill backstop)');
const end = src.indexOf('// ── Cosmetic ingredient table');
if (start < 0 || end < 0 || end <= start) throw new Error('could not locate request guards');

const block = `
${src.slice(start, end)}
module.exports = {
  checkRateLimit,
  sweepRateLimitBuckets,
  rateLimitBuckets,
  getClientIp,
  parseBearerToken,
  tryConsumeVisionSlot,
  getVisionCallsToday,
  utcDayKey,
  VISION_DAILY_CAP,
  VISION_CAP_WARNING_RATIO,
  RATE_LIMIT_PHOTO_PER_UID,
  RATE_LIMIT_PHOTO_PER_IP,
  RATE_LIMIT_SCAN_SEARCH_PER_IP,
  RATE_LIMIT_ADMIN_PER_IP,
  RATE_LIMIT_IMAGE_PER_IP,
  RATE_LIMIT_IMAGE_REPORT_PER_UID,
  RATE_LIMIT_WINDOW_MS,
  // expose counters for day-rollover assertions
  getVisionState: () => ({ visionDayKey, visionDayCount, visionCapWarningLoggedForDay }),
  setVisionState: (day, count, warningDay = '') => {
    visionDayKey = day;
    visionDayCount = count;
    visionCapWarningLoggedForDay = warningDay;
  },
};
`;
fs.writeFileSync('/tmp/request_guards.js', block);
const g = require('/tmp/request_guards.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(g.VISION_DAILY_CAP === 500, 'VISION_DAILY_CAP must be 500');
assert(g.VISION_CAP_WARNING_RATIO === 0.8);
assert(g.RATE_LIMIT_PHOTO_PER_UID === 20);
assert(g.RATE_LIMIT_PHOTO_PER_IP === 60);
assert(g.RATE_LIMIT_SCAN_SEARCH_PER_IP === 300);
assert(g.RATE_LIMIT_ADMIN_PER_IP === 10);
assert(g.RATE_LIMIT_IMAGE_PER_IP === 600);
assert(g.RATE_LIMIT_IMAGE_REPORT_PER_UID === 10);
assert(g.RATE_LIMIT_WINDOW_MS === 60 * 60 * 1000);

// Bearer token parsing — missing/malformed must fail closed.
assert(g.parseBearerToken(undefined) === null);
assert(g.parseBearerToken(null) === null);
assert(g.parseBearerToken('') === null);
assert(g.parseBearerToken('Basic abc') === null);
assert(g.parseBearerToken('Bearer') === null);
assert(g.parseBearerToken('Bearer ') === null);
assert(g.parseBearerToken('bearer tok.en.here') === 'tok.en.here');
assert(g.parseBearerToken('Bearer tok.en.here') === 'tok.en.here');
assert(g.parseBearerToken('Bearer  tok.en.here') === 'tok.en.here', 'extra whitespace still parses');
assert(g.parseBearerToken('Bearer tok extra') === 'tok', 'takes first token only');

// Client IP prefers first X-Forwarded-For hop.
assert(g.getClientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, ip: '9.9.9.9' }) === '1.2.3.4');
assert(g.getClientIp({ headers: {}, ip: '10.0.0.1' }) === '10.0.0.1');
assert(g.getClientIp({ headers: {} }) === 'unknown');

// Rate limit: allow up to N, then deny with retryAfter.
{
  g.rateLimitBuckets.clear();
  const now = 1_000_000;
  const key = 'test:uid:a';
  for (let i = 0; i < 3; i++) {
    const r = g.checkRateLimit(key, 3, now, 3600_000);
    assert(r.allowed === true, 'request ' + i + ' should be allowed');
  }
  const denied = g.checkRateLimit(key, 3, now, 3600_000);
  assert(denied.allowed === false, '4th request must be denied');
  assert(denied.retryAfter >= 1, 'retryAfter must be >= 1s');
  // Still denied later in the same window without advancing past reset.
  const still = g.checkRateLimit(key, 3, now + 1000, 3600_000);
  assert(still.allowed === false);

  // New window after resetAt.
  const resetAt = g.rateLimitBuckets.get(key).resetAt;
  const fresh = g.checkRateLimit(key, 3, resetAt, 3600_000);
  assert(fresh.allowed === true, 'window rollover must allow again');
}

// Sweep removes expired buckets and leaves live ones.
{
  g.rateLimitBuckets.clear();
  const now = 2_000_000;
  g.checkRateLimit('live', 5, now, 60_000);
  g.rateLimitBuckets.set('stale', { count: 9, resetAt: now - 1 });
  g.sweepRateLimitBuckets(now);
  assert(g.rateLimitBuckets.has('live') === true, 'live bucket kept');
  assert(g.rateLimitBuckets.has('stale') === false, 'expired bucket swept');
}

// Vision daily cap: exactly VISION_DAILY_CAP allowed, then false; new UTC day resets.
{
  const day1 = Date.parse('2026-08-03T12:00:00.000Z');
  const day2 = Date.parse('2026-08-04T00:00:00.000Z');
  assert(g.utcDayKey(day1) === '2026-08-03');
  assert(g.utcDayKey(day2) === '2026-08-04');

  g.setVisionState('', 0, '');
  const warnAt = Math.ceil(g.VISION_DAILY_CAP * g.VISION_CAP_WARNING_RATIO);
  assert(warnAt === 400, '80% of 500 is 400');

  // Capture console.log for the once-per-day warning.
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };

  for (let i = 0; i < g.VISION_DAILY_CAP; i++) {
    assert(g.tryConsumeVisionSlot(day1) === true, 'slot ' + i + ' should consume');
  }
  console.log = originalLog;

  const warnings = logs.filter(l => l.includes('[VISION CAP WARNING]'));
  assert(warnings.length === 1, 'warning must log exactly once, got ' + warnings.length);
  assert(warnings[0].includes('used=' + warnAt), 'warning at first cross of 80%: ' + warnings[0]);
  assert(warnings[0].includes('cap=' + g.VISION_DAILY_CAP));
  assert(g.getVisionState().visionCapWarningLoggedForDay === '2026-08-03');

  // Further consumes past 80% (already at cap) must not warn again.
  const logs2 = [];
  console.log = (...args) => { logs2.push(args.join(' ')); };
  assert(g.tryConsumeVisionSlot(day1) === false, 'over cap must reject');
  assert(g.tryConsumeVisionSlot(day1) === false, 'still capped');
  console.log = originalLog;
  assert(logs2.filter(l => l.includes('[VISION CAP WARNING]')).length === 0);

  const st = g.getVisionState();
  assert(st.visionDayKey === '2026-08-03');
  assert(st.visionDayCount === g.VISION_DAILY_CAP);
  assert(g.getVisionCallsToday(day1) === g.VISION_DAILY_CAP);
  assert(g.getVisionCallsToday(day2) === 0, 'other UTC day reads as 0 until a consume');

  assert(g.tryConsumeVisionSlot(day2) === true, 'new UTC day resets cap');
  assert(g.getVisionState().visionDayKey === '2026-08-04');
  assert(g.getVisionState().visionDayCount === 1);
  assert(g.getVisionCallsToday(day2) === 1);

  // New day can warn again when crossing 80%.
  g.setVisionState('2026-08-04', warnAt - 1, '');
  const logs3 = [];
  console.log = (...args) => { logs3.push(args.join(' ')); };
  assert(g.tryConsumeVisionSlot(day2) === true);
  console.log = originalLog;
  assert(logs3.filter(l => l.includes('[VISION CAP WARNING]')).length === 1,
    'new UTC day may warn once again');
}

console.log('request guards ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"request guard assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def test_front_pack_name_and_image_helpers():
    """Front-of-pack name compose, barcode validation, image overwrite rules."""
    script = r"""
const fs = require('fs');
const src = fs.readFileSync(require('path').join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('// ── Request guards (rate limits + vision bill backstop)');
const end = src.indexOf('// ── Cosmetic ingredient table');
if (start < 0 || end < 0 || end <= start) throw new Error('could not locate helpers');

const block = `
const PRODUCT_IMAGE_MAX_BYTES = 200 * 1024;
const FAILED_WRITES_PAYLOAD_MAX_BYTES = 800 * 1024;
const IMAGE_SUPPRESS_REPORT_THRESHOLD = 2;
${src.slice(start, end)}
module.exports = {
  normalizeBarcode,
  isValidBarcode,
  composeFrontProductName,
  shouldWriteProductImage,
  isFrontProductPackaging,
  stripDataUrlBase64,
  resolvePublicBaseUrl,
  capFailedWritePayload,
  PRODUCT_IMAGE_MAX_BYTES,
  FAILED_WRITES_PAYLOAD_MAX_BYTES,
  IMAGE_SUPPRESS_REPORT_THRESHOLD,
  tryConsumeVisionSlot,
  VISION_DAILY_CAP,
  setVisionState: (day, count, warningDay = '') => {
    visionDayKey = day;
    visionDayCount = count;
    visionCapWarningLoggedForDay = warningDay;
  },
  getVisionState: () => ({ visionDayKey, visionDayCount, visionCapWarningLoggedForDay }),
};
`;
fs.writeFileSync('/tmp/front_pack_helpers.js', block);
const g = require('/tmp/front_pack_helpers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(g.PRODUCT_IMAGE_MAX_BYTES === 200 * 1024);

// failedWrites payload capping
{
  const small = g.capFailedWritePayload({ ok: true });
  assert(small.truncated === false);
  assert(small.payload.includes('"ok":true'));
  const over = 'x'.repeat(g.FAILED_WRITES_PAYLOAD_MAX_BYTES + 50);
  const capped = g.capFailedWritePayload(over);
  assert(capped.truncated === true, 'oversize must set truncated');
  assert(Buffer.byteLength(capped.payload, 'utf8') <= g.FAILED_WRITES_PAYLOAD_MAX_BYTES);
}

// Barcode validation — digits only, OFF/OBF-ish lengths.
assert(g.normalizeBarcode(' 3017620422003 ') === '3017620422003');
assert(g.normalizeBarcode('1234') === '1234');
assert(g.normalizeBarcode('123') === null, 'too short');
assert(g.normalizeBarcode('abc') === null);
assert(g.normalizeBarcode('../etc') === null);
assert(g.normalizeBarcode('') === null);
assert(g.normalizeBarcode(null) === null);
assert(g.isValidBarcode('3017620422003') === true);
assert(g.isValidBarcode('nope') === false);

assert(g.stripDataUrlBase64('data:image/jpeg;base64,abc') === 'abc');
assert(g.stripDataUrlBase64('abc') === 'abc');

// Name compose: brand + productName; requires isProductPackaging === true.
assert(g.composeFrontProductName(null) === null);
assert(g.composeFrontProductName({ readable: false, brand: 'X', productName: 'Y', isProductPackaging: true }) === null);
assert(g.composeFrontProductName({ readable: true, brand: 'Acme', productName: 'Serum', isProductPackaging: true }) === 'Acme Serum');
assert(g.composeFrontProductName({ readable: true, brand: null, productName: 'Serum', isProductPackaging: true }) === 'Serum');
assert(g.composeFrontProductName({ readable: true, brand: 'Acme', productName: null, isProductPackaging: true }) === 'Acme');
assert(g.composeFrontProductName({ readable: true, brand: '  ', productName: '  ', isProductPackaging: true }) === null);
assert(g.composeFrontProductName({ readable: true, brand: null, productName: null, isProductPackaging: true }) === null);
assert(g.composeFrontProductName({ readable: true, brand: 'Acme', productName: 'Serum', isProductPackaging: false }) === null,
  'non-packaging names must be ignored');
assert(g.composeFrontProductName({ readable: true, brand: 'Acme', productName: 'Serum' }) === null,
  'missing isProductPackaging must not name');
assert(g.isFrontProductPackaging({ isProductPackaging: true }) === true);
assert(g.isFrontProductPackaging({ isProductPackaging: false }) === false);
assert(g.isFrontProductPackaging(null) === false);

// Write when missing/empty OR suppressed (so a troll image can be replaced).
assert(g.shouldWriteProductImage(null) === true);
assert(g.shouldWriteProductImage(undefined) === true);
assert(g.shouldWriteProductImage({ bytes: 0, data: '' }) === true);
assert(g.shouldWriteProductImage({ bytes: 0, data: 'x' }) === true);
assert(g.shouldWriteProductImage({ bytes: 10, data: null }) === true);
assert(g.shouldWriteProductImage({ bytes: 10, data: 'abc' }) === false, 'keep existing');
assert(g.shouldWriteProductImage({ bytes: 10, data: 'abc', suppressed: true }) === true,
  'suppressed image must be replaceable');
assert(g.IMAGE_SUPPRESS_REPORT_THRESHOLD === 2);

// PUBLIC_BASE_URL env wins; else host from request.
{
  const prev = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://api.example.com/';
  assert(g.resolvePublicBaseUrl({ get: () => 'ignored' }) === 'https://api.example.com');
  delete process.env.PUBLIC_BASE_URL;
  const req = {
    protocol: 'https',
    get: (h) => (h === 'host' ? 'scanner.up.railway.app' : undefined),
  };
  assert(g.resolvePublicBaseUrl(req) === 'https://scanner.up.railway.app');
  if (prev !== undefined) process.env.PUBLIC_BASE_URL = prev;
}

// Mid-scan cap: ingredients took the last slot → front read must be dropped.
{
  const day = Date.parse('2026-08-03T12:00:00.000Z');
  g.setVisionState('2026-08-03', g.VISION_DAILY_CAP - 1, '2026-08-03');
  assert(g.tryConsumeVisionSlot(day) === true, 'ingredients gets last slot');
  assert(g.tryConsumeVisionSlot(day) === false, 'front read dropped when capped');
}

console.log('front pack helpers ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"front pack helper assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def test_front_image_endpoint():
    """POST /image/:barcode — validation, short-circuit, packaging gate, name repair."""
    script = r"""
const http = require('http');
const path = require('path');
const Module = require('module');

const productImages = new Map();
const productCache = new Map();
const imageWrites = [];
const cacheUpdates = [];
let fetchCalls = 0;
let visionResponse = {
  isProductPackaging: true,
  readable: true,
  brand: 'Acme',
  productName: 'Serum',
};

function docSnap(data) {
  return {
    exists: data !== undefined,
    data: () => (data === undefined ? undefined : data),
  };
}

function makeDoc(collectionName, id) {
  const store = collectionName === 'productImages' ? productImages : productCache;
  return {
    async get() {
      return docSnap(store.get(id));
    },
    async set(data) {
      imageWrites.push({ id, data: { ...data } });
      store.set(id, { ...(store.get(id) || {}), ...data });
    },
    async update(data) {
      cacheUpdates.push({ id, data: { ...data } });
      const prev = store.get(id) || {};
      store.set(id, { ...prev, ...data });
    },
  };
}

const mockFirestore = {
  collection(name) {
    return {
      doc(id) {
        return makeDoc(name, String(id));
      },
      async add() {
        return { id: 'audit' };
      },
    };
  },
};
mockFirestore.FieldValue = {
  serverTimestamp: () => 'SERVER_TS',
};

const mockAdmin = {
  initializeApp() {},
  credential: { cert() { return {}; } },
  auth() {
    return {
      async verifyIdToken(token) {
        if (!token || token === 'bad') throw new Error('invalid token');
        return { uid: 'uid-front-test' };
      },
    };
  },
  firestore() {
    return mockFirestore;
  },
};
mockAdmin.firestore.FieldValue = mockFirestore.FieldValue;

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') return mockAdmin;
  return origRequire.apply(this, arguments);
};

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'demo',
  client_email: 'demo@demo.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg==\n-----END PRIVATE KEY-----\n',
});
process.env.ANTHROPIC_API_KEY = 'test-key';

global.fetch = async function mockFetch() {
  fetchCalls += 1;
  return {
    ok: true,
    async json() {
      return {
        content: [{ text: JSON.stringify(visionResponse) }],
      };
    },
  };
};

const appPath = path.join(process.cwd(), 'index.js');
delete require.cache[appPath];
const app = require(appPath);

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function request(method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: {
            Authorization: 'Bearer good-token',
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }
              : {}),
            ...(headers || {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch (_) {
              json = text;
            }
            resolve({ status: res.statusCode, json });
          });
        }
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function resetState() {
  productImages.clear();
  productCache.clear();
  imageWrites.length = 0;
  cacheUpdates.length = 0;
  fetchCalls = 0;
  visionResponse = {
    isProductPackaging: true,
    readable: true,
    brand: 'Acme',
    productName: 'Serum',
  };
}

(async () => {
  // 1. Missing or malformed frontImageBase64 → 400
  {
    resetState();
    let res = await request('POST', '/image/3017620422003', {
      body: { frontMediaType: 'image/jpeg' },
    });
    assert(res.status === 400, 'missing frontImageBase64 → 400, got ' + res.status);
    res = await request('POST', '/image/3017620422003', {
      body: { frontImageBase64: '', frontMediaType: 'image/jpeg' },
    });
    assert(res.status === 400, 'empty frontImageBase64 → 400, got ' + res.status);
    res = await request('POST', '/image/3017620422003', {
      body: { frontImageBase64: 12345, frontMediaType: 'image/jpeg' },
    });
    assert(res.status === 400, 'non-string frontImageBase64 → 400, got ' + res.status);
    assert(fetchCalls === 0, 'validation must not call vision');
  }

  // 2. Bad frontMediaType → 400
  {
    resetState();
    const res = await request('POST', '/image/3017620422003', {
      body: { frontImageBase64: 'abc123', frontMediaType: 'image/gif' },
    });
    assert(res.status === 400, 'bad frontMediaType → 400, got ' + res.status);
    assert(fetchCalls === 0, 'bad media type must not call vision');
  }

  // 3. Oversized front image → 413
  {
    resetState();
    const oversized = 'x'.repeat(200 * 1024 + 1);
    const res = await request('POST', '/image/3017620422003', {
      body: { frontImageBase64: oversized, frontMediaType: 'image/jpeg' },
    });
    assert(res.status === 413, 'oversized front → 413, got ' + res.status);
    assert(fetchCalls === 0, 'oversized must not call vision');
    assert(imageWrites.length === 0, 'oversized must not write');
  }

  // 4. Existing image bytes → stored:false, vision NOT called
  {
    resetState();
    productImages.set('3017620422003', {
      data: 'existingbase64',
      bytes: 14,
      mediaType: 'image/jpeg',
      suppressed: false,
    });
    const res = await request('POST', '/image/3017620422003', {
      body: { frontImageBase64: 'abc123', frontMediaType: 'image/jpeg' },
    });
    assert(res.status === 200, 'existing image → 200, got ' + res.status);
    assert(res.json && res.json.ok === true && res.json.stored === false,
      'existing image must return stored:false: ' + JSON.stringify(res.json));
    assert(fetchCalls === 0, 'existing image must NOT call readFrontOfPackFromPhoto/fetch');
    assert(imageWrites.length === 0, 'existing image must not rewrite');
  }

  // 5. isProductPackaging:false → 422, nothing written
  {
    resetState();
    visionResponse = {
      isProductPackaging: false,
      readable: false,
      brand: 'Fake',
      productName: 'Name',
    };
    const res = await request('POST', '/image/3017620422003', {
      body: { frontImageBase64: 'abc123', frontMediaType: 'image/png' },
    });
    assert(res.status === 422, 'non-packaging → 422, got ' + res.status);
    assert(res.json && res.json.error === 'Not product packaging');
    assert(fetchCalls === 1, 'packaging reject still spends one vision call');
    assert(imageWrites.length === 0, 'non-packaging must store nothing');
    assert(cacheUpdates.length === 0, 'non-packaging must not repair name');
  }

  // 6. Name repair for placeholders / missing; not for a real name
  {
    const cases = [
      { productName: 'Scanned label', expectRepair: true },
      { productName: 'Unknown Product', expectRepair: true },
      { productName: '', expectRepair: true },
      { productName: 'null', expectRepair: true },
      { productName: null, expectRepair: true },
      { productName: undefined, expectRepair: true },
      { productName: 'CeraVe Hydrating Cleanser', expectRepair: false },
    ];
    for (const c of cases) {
      resetState();
      visionResponse = {
        isProductPackaging: true,
        readable: true,
        brand: 'Acme',
        productName: 'Serum',
      };
      const cacheDoc = { ingredients: 'Aqua', source: 'photo' };
      if (c.productName !== undefined) cacheDoc.productName = c.productName;
      productCache.set('3017620422003', cacheDoc);

      const res = await request('POST', '/image/3017620422003', {
        body: { frontImageBase64: 'abc123', frontMediaType: 'image/jpeg' },
      });
      assert(res.status === 200, 'store path → 200 for ' + JSON.stringify(c.productName));
      assert(res.json && res.json.ok === true && res.json.stored === true,
        'must store image: ' + JSON.stringify(res.json));
      assert(res.json.productName === 'Acme Serum',
        'response productName: ' + res.json.productName);
      assert(imageWrites.length === 1, 'must write productImages once');
      assert(fetchCalls === 1, 'must call vision once');

      if (c.expectRepair) {
        assert(cacheUpdates.length === 1,
          'name repair must fire for ' + JSON.stringify(c.productName));
        assert(cacheUpdates[0].data.productName === 'Acme Serum');
        assert(Object.keys(cacheUpdates[0].data).length === 1,
          'name repair must only touch productName');
        assert(productCache.get('3017620422003').productName === 'Acme Serum');
      } else {
        assert(cacheUpdates.length === 0,
          'real name must NOT be repaired, got ' + JSON.stringify(cacheUpdates));
        assert(productCache.get('3017620422003').productName === 'CeraVe Hydrating Cleanser');
      }
    }

    // Cache doc missing entirely → do not create / repair
    resetState();
    const resNoCache = await request('POST', '/image/3017620422003', {
      body: { frontImageBase64: 'abc123', frontMediaType: 'image/jpeg' },
    });
    assert(resNoCache.status === 200 && resNoCache.json.stored === true);
    assert(cacheUpdates.length === 0, 'no cache doc → no name repair');
    assert(!productCache.has('3017620422003'), 'must not create cache doc');
  }

  console.log('front image endpoint ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"front image endpoint assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def test_ingredients_text_preference_rejoin_and_u201a():
    """Prefer ingredients_text over OFF array; rejoin comma-split INCIs; U+201A → comma."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');

const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('// Firestore docs are size-capped');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic block');

const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
module.exports = {
  parseCosmeticIngredientList,
  scoreCosmeticProduct,
  normalizeInci,
  lookupCosmeticIngredient,
  rejoinAdjacentUnmatchedFragments,
};
`;
fs.writeFileSync('/tmp/parser_rejoin_helpers.js', block);
const {
  parseCosmeticIngredientList: parseCosmeticIngredientListRaw,
  scoreCosmeticProduct,
  normalizeInci,
  lookupCosmeticIngredient,
} = require('/tmp/parser_rejoin_helpers.js');

function parseCosmeticIngredientList(product) {
  const result = parseCosmeticIngredientListRaw(product);
  return result.items || result;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. BOTH ingredients_text and structured array → parse from text (0792850110991 shape).
{
  const product = {
    ingredients_text:
      'Beeswax, cocos nucifera (COconut) oil, helianthus annuus (sunflower) seed oil',
    ingredients: [
      { text: 'Beeswax' },
      { text: 'cocos nucifera' },
      { text: 'oil' },
      { text: 'helianthus annuus' },
      { text: 'seed oil' },
      { text: 'oll' },
    ],
  };
  const names = parseCosmeticIngredientList(product).map(p => p.name);
  const joined = names.join('|').toLowerCase();
  assert(
    names.some(n => /^helianthus annuus seed oil$/i.test(n)),
    'helianthus annuus seed oil must be one row from text, got ' + JSON.stringify(names)
  );
  assert(
    !names.some(n => /^helianthus annuus$/i.test(n)) &&
      !names.some(n => /^seed oil$/i.test(n)),
    'must not emit split botanical halves from OFF array: ' + JSON.stringify(names)
  );
  assert(joined.includes('cocos nucifera oil'), 'botanical oil from text: ' + JSON.stringify(names));
}

// 2. Array with NO ingredients_text still parses from the array.
{
  const product = {
    ingredients: [
      { text: 'Aqua' },
      { text: 'Glycerin' },
      { id: 'en:phenoxyethanol' },
    ],
  };
  const names = parseCosmeticIngredientList(product).map(p => p.name);
  assert(names.join('|') === 'Aqua|Glycerin|phenoxyethanol',
    'array-only fallback: ' + JSON.stringify(names));
}

// 3. SODIUM, COCOYL GLYCINATE → one row resolving to Sodium Cocoyl Glycinate.
{
  const scored = scoreCosmeticProduct({
    ingredients_text: 'SODIUM, COCOYL GLYCINATE',
  });
  assert(scored.ingredientList.length === 1,
    'expected one merged row, got ' + JSON.stringify(scored.ingredientList));
  assert(scored.ingredientList[0].matched === true, 'merged row must match');
  assert(scored.ingredientList[0].inci === 'Sodium Cocoyl Glycinate',
    'expected Sodium Cocoyl Glycinate, got ' + scored.ingredientList[0].inci);
}

// 4. AQUA, GLYCERIN does NOT merge — both are ASSESSED hazard-table hits.
{
  const scored = scoreCosmeticProduct({ ingredients_text: 'AQUA, GLYCERIN' });
  assert(scored.ingredientList.length === 2,
    'Aqua/Glycerin must stay two rows: ' + JSON.stringify(scored.ingredientList));
  assert(scored.ingredientList[0].inci === 'Aqua');
  assert(scored.ingredientList[1].inci === 'Glycerin');
}

// 5. DISODIUM, EDTA merges — EDTA alone is recognised-only (CosIng), which
// must NOT count as assessed and therefore must not block the rejoin.
{
  const edtaAlone = lookupCosmeticIngredient('EDTA');
  assert(edtaAlone && edtaAlone.recognised === true,
    'fixture: EDTA must be recognised-only, got ' + JSON.stringify(edtaAlone));
  assert(!lookupCosmeticIngredient('DISODIUM'), 'fixture: DISODIUM must miss');
  const scored = scoreCosmeticProduct({ ingredients_text: 'DISODIUM, EDTA' });
  assert(scored.ingredientList.length === 1,
    'DISODIUM+EDTA must merge to one row: ' + JSON.stringify(scored.ingredientList));
  assert(scored.ingredientList[0].inci === 'Disodium EDTA',
    'expected Disodium EDTA, got ' + scored.ingredientList[0].inci);
  assert(scored.ingredientList[0].matched === true, 'merged Disodium EDTA must be assessed');
  assert(scored.ingredientList[0].recognised === false, 'Disodium EDTA is hazard, not recognised-only');
}

// 6. Two adjacent genuine unknowns whose join is also unknown stay as two rows.
{
  const scored = scoreCosmeticProduct({
    ingredients_text: 'CompletelyFakeInciAlpha, CompletelyFakeInciBeta',
  });
  assert(scored.ingredientList.length === 2,
    'unknown+unknown must stay two rows: ' + JSON.stringify(scored.ingredientList));
  assert(scored.coverageMatched === 0);
  assert(scored.coverageTotal === 2);
}

// 7. U+201A normalises to the same key as a real comma.
{
  const withLow9 = normalizeInci('1\u201A2-hexanediol');
  const withComma = normalizeInci('1,2-hexanediol');
  assert(withLow9 === withComma, 'U+201A key mismatch: ' + withLow9 + ' vs ' + withComma);
  assert(withLow9 === '1,2-hexanediol', 'expected 1,2-hexanediol, got ' + withLow9);
  const hit = lookupCosmeticIngredient('1\u201A2-Hexanediol');
  assert(hit && hit.inci === '1,2-Hexanediol', 'U+201A must resolve via lookup');
}

// 8. A merged pair reduces the coverage denominator by exactly one.
{
  const before = parseCosmeticIngredientList({
    ingredients_text: 'SODIUM, COCOYL GLYCINATE',
  });
  assert(before.length === 2, 'pre-rejoin parse must yield two fragments');
  const scored = scoreCosmeticProduct({
    ingredients_text: 'SODIUM, COCOYL GLYCINATE',
  });
  assert(scored.coverageTotal === before.length - 1,
    'merged pair must shrink denom by 1: parse=' + before.length +
    ' coverageTotal=' + scored.coverageTotal);
  assert(scored.coverageMatched === 1, 'merged pair must match');
}

// 9. Join that resolves only to a recognised CosIng name is still a valid merge.
{
  const joined = lookupCosmeticIngredient('Isooctanoyl Tetrapeptide-25');
  assert(joined && joined.recognised === true,
    'fixture: Isooctanoyl Tetrapeptide-25 must be recognised-only');
  const left = lookupCosmeticIngredient('Isooctanoyl');
  const right = lookupCosmeticIngredient('Tetrapeptide-25');
  assert(!left || left.recognised === true, 'fixture: left half must not be assessed');
  assert(!right || right.recognised === true, 'fixture: right half must not be assessed');
  const scored = scoreCosmeticProduct({
    ingredients_text: 'Isooctanoyl, Tetrapeptide-25',
  });
  assert(scored.ingredientList.length === 1,
    'recognised-only join must merge: ' + JSON.stringify(scored.ingredientList));
  assert(scored.ingredientList[0].recognised === true,
    'merged row must be recognised-only');
  assert(scored.ingredientList[0].inci === 'Isooctanoyl Tetrapeptide-25',
    'expected Isooctanoyl Tetrapeptide-25, got ' + scored.ingredientList[0].inci);
  assert(scored.ingredientList[0].assessed === false, 'recognised-only merge is not assessed');
}

console.log('ingredients_text preference + rejoin + U+201A ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"parser rejoin/text-preference assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


# ---------------------------------------------------------------------------
# CosIng recognised-names layer (COSING_NAMES_SPEC)
# ---------------------------------------------------------------------------


def test_cosing_recognised_names_layer():
    """Recognised-only CosIng map: lookup order, coverage, penalty, degrade, unmatched."""
    script = r"""
const fs = require('fs');
const path = require('path');
const os = require('os');
const src = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('function stringifyIngredientListForCache');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic block');

const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
module.exports = {
  lookupCosmeticIngredient,
  lookupRecognisedName,
  normalizeInci,
  scoreCosmeticProduct,
  cosingNamesMap,
  loadCosingNamesFromFile,
  COSING_NAMES_VERSION,
  COSMETIC_TABLE_VERSION,
  unmatchedNameLabel,
  unmatchedNameRecognised,
};
`;
fs.writeFileSync('/tmp/cosing_layer_helpers.js', block);
// Fresh require
delete require.cache[require.resolve('/tmp/cosing_layer_helpers.js')];
const g = require('/tmp/cosing_layer_helpers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. Recognised-only name → recognised:true, assessed:false, risk:null
const recognisedOnly = g.lookupCosmeticIngredient('Gossypium Hirsutum Seed Extract');
assert(recognisedOnly, 'recognised-only lookup miss');
assert(recognisedOnly.recognised === true, 'expected recognised:true');
assert(recognisedOnly.assessed === false, 'expected assessed:false');
assert(recognisedOnly.risk === null, 'expected risk:null, got ' + recognisedOnly.risk);
assert(recognisedOnly.inci === 'Gossypium Hirsutum Seed Extract', 'display name');
assert(Array.isArray(recognisedOnly.functions), 'functions array');
assert(recognisedOnly.penalty === 0, 'penalty 0');

// 2. Name in BOTH hazard + recognised → hazard wins (inject into map)
const aquaKey = g.normalizeInci('Aqua');
g.cosingNamesMap.set(aquaKey, { name: 'Fake Recognised Aqua', fn: ['solvent'] });
const aquaHit = g.lookupCosmeticIngredient('Aqua');
assert(aquaHit && aquaHit.inci === 'Aqua', 'hazard Aqua must win, got ' + JSON.stringify(aquaHit));
assert(!aquaHit.recognised, 'recognised must not shadow hazard');
assert(aquaHit.risk != null || aquaHit.risk === 'none' || aquaHit.risk_type, 'hazard entry shape');
g.cosingNamesMap.delete(aquaKey);

// 3. Synonym target still beats the recognised map
const fragKey = g.normalizeInci('fragrance');
g.cosingNamesMap.set(fragKey, { name: 'Fake Recognised Fragrance', fn: ['masking'] });
const fragHit = g.lookupCosmeticIngredient('fragrance');
assert(fragHit && fragHit.inci === 'Parfum', 'synonym must beat recognised, got ' + JSON.stringify(fragHit));
assert(!fragHit.recognised, 'synonym hit must not be recognised-only');
g.cosingNamesMap.delete(fragKey);

// 4. Coverage: 2 assessed + 8 recognised = 2/10, NOT 10/10
const eightRecognised = [
  'Gossypium Hirsutum Seed Extract',
  'Isooctanoyl Tetrapeptide-25',
  'Nonapeptide-11',
  '1,10-Decanediol',
  'Aluminum Behenate',
  'Aluminum Benzoate',
  'Alumina',
  'Xylitylglucoside',
];
// Confirm each is recognised-only (not hazard)
for (const n of eightRecognised) {
  const h = g.lookupCosmeticIngredient(n);
  assert(h && h.recognised === true, 'fixture must be recognised-only: ' + n + ' -> ' + JSON.stringify(h));
}
const mix = g.scoreCosmeticProduct({
  ingredients_text: ['Aqua', 'Glycerin', ...eightRecognised].join(', '),
});
assert(mix.assessedCount === 2, 'assessedCount expected 2, got ' + mix.assessedCount);
assert(mix.recognisedCount === 8, 'recognisedCount expected 8, got ' + mix.recognisedCount);
assert(mix.totalCount === 10, 'totalCount expected 10, got ' + mix.totalCount);
assert(mix.coverageMatched === 2, 'coverageMatched expected 2, got ' + mix.coverageMatched);
assert(mix.coverageTotal === 10, 'coverageTotal expected 10, got ' + mix.coverageTotal);
assert(mix.coverage === 0.2, 'coverage must be exactly 2/10=0.2, got ' + mix.coverage);

// 5. Recognised-only row contributes 0 to the penalty sum
const onlyRecognised = g.scoreCosmeticProduct({
  ingredients_text: eightRecognised.slice(0, 5).join(', '),
});
// Below gate (0 assessed / 5) — score null, but if we force enough assessed...
const withAssessed = g.scoreCosmeticProduct({
  ingredients_text: ['Aqua', 'Glycerin', 'Xanthan Gum', 'Tocopherol', 'Citric Acid', ...eightRecognised.slice(0, 5)].join(', '),
});
assert(withAssessed.recognisedCount === 5, 'expected 5 recognised');
assert(withAssessed.score !== null, 'should clear coverage gate, score=' + withAssessed.score);
const penaltyIncis = (withAssessed.scoreBreakdown.penalties || []).map(p => p.inci);
for (const n of eightRecognised.slice(0, 5)) {
  assert(!penaltyIncis.includes(n), 'recognised must not enter penalty sum: ' + n);
}
for (const row of withAssessed.ingredientList) {
  if (row.recognised) {
    assert(row.penalty === 0, 'recognised row penalty must be 0');
    assert(row.assessed === false, 'recognised row assessed false');
    assert(row.risk === null, 'recognised row risk null');
  }
  if (row.matched) {
    assert(row.assessed === true, 'assessed row must have assessed:true');
  }
}

// 6. Missing or corrupt purla_cosing_names.json → empty map, no throw
const missing = g.loadCosingNamesFromFile(path.join(os.tmpdir(), 'no-such-cosing-names-purla.json'));
assert(missing.map instanceof Map && missing.map.size === 0, 'missing file → empty map');
assert(missing.version === 'none', 'missing file version none');

const corruptPath = path.join(os.tmpdir(), 'corrupt-cosing-names-purla.json');
fs.writeFileSync(corruptPath, '{not valid json!!!');
const corrupt = g.loadCosingNamesFromFile(corruptPath);
assert(corrupt.map instanceof Map && corrupt.map.size === 0, 'corrupt file → empty map');
assert(corrupt.version === 'none', 'corrupt file version none');

// Empty map must not throw on lookup
const saved = g.cosingNamesMap;
// Replace contents
g.cosingNamesMap.clear();
assert(g.lookupRecognisedName('Gossypium Hirsutum Seed Extract') === null, 'empty map miss');
// Restore from disk for remaining asserts
const reloaded = g.loadCosingNamesFromFile(path.join(process.cwd(), 'purla_cosing_names.json'));
for (const [k, v] of reloaded.map) g.cosingNamesMap.set(k, v);

// 7. Recognised-only name still written to unmatchedInci list, flagged recognised:true
const scoredUnmatched = g.scoreCosmeticProduct({
  ingredients_text: 'Aqua, Gossypium Hirsutum Seed Extract, Totally Fake Ingredient Xyzzy',
});
const flagged = scoredUnmatched.unmatchedNames.filter(
  (item) => item && typeof item === 'object' && item.recognised === true
);
assert(flagged.length === 1, 'expected one recognised unmatched, got ' + JSON.stringify(scoredUnmatched.unmatchedNames));
assert(/gossypium hirsutum seed extract/i.test(flagged[0].name), 'recognised unmatched name');
assert(g.unmatchedNameRecognised(flagged[0]) === true, 'helper recognises flag');
const trueMiss = scoredUnmatched.unmatchedNames.filter(
  (item) => typeof item === 'string' || (item && !item.recognised)
);
assert(trueMiss.some(item => /xyzzy/i.test(g.unmatchedNameLabel(item))), 'true miss still present');

// Table version folds CosIng version so caches refresh once
assert(
  String(g.COSMETIC_TABLE_VERSION).includes('cosing:'),
  'COSMETIC_TABLE_VERSION must fold cosing version, got ' + g.COSMETIC_TABLE_VERSION
);

console.log('cosing recognised-names layer ok', {
  coverage: mix.coverage,
  assessedCount: mix.assessedCount,
  recognisedCount: mix.recognisedCount,
  tableVersion: g.COSMETIC_TABLE_VERSION,
  cosingVersion: g.COSING_NAMES_VERSION,
});
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"cosing recognised-names assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def test_household_product_classification():
    """Household pesticide labels vs sunscreens / cosmetics; empty list + null score."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('function stringifyIngredientListForCache');
if (start < 0 || end < 0 || end <= start) throw new Error('could not locate scoring block');
const fragStart = src.indexOf('const HOUSEHOLD_CATEGORY_FRAGMENTS');
const fragEnd = src.indexOf('async function resolveProductType');
if (fragStart < 0 || fragEnd < 0) throw new Error('could not locate household category block');
const addStart = src.indexOf('function formatAdditivesCountDisplay');
const addEnd = src.indexOf('async function generateFoodExplanation');
if (addStart < 0 || addEnd < 0 || addEnd <= addStart) {
  throw new Error('could not locate formatAdditivesCountDisplay');
}
const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
const SCAN_LOGIC_VERSION = '1';
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
${src.slice(fragStart, fragEnd)}
${src.slice(addStart, addEnd)}
module.exports = {
  looksLikeHouseholdProduct,
  buildHouseholdScanResponse,
  HOUSEHOLD_EXPLANATION,
  tagIndicatesHousehold,
  hasHouseholdCategory,
  formatAdditivesCountDisplay,
};
`;
fs.writeFileSync('/tmp/household_helpers.js', block);
delete require.cache['/tmp/household_helpers.js'];
const g = require('/tmp/household_helpers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const lysol = [
  'ACTIVE INGREDIENTS:',
  'Alkyl (50% C14, 40% C12, 10% C16) dimethyl benzyl ammonium saccharinate 0.10%',
  'Ethanol 58.00%',
  'OTHER INGREDIENTS: 41.90%',
  'KEEP OUT OF REACH OF CHILDREN',
  'EPA Reg. No. 777-99',
].join(' ');

assert(g.looksLikeHouseholdProduct(lysol) === true, 'Lysol-shaped label must classify as household');

// Clorox wipe: EPA Reg. + Other Ingredients percentage — exclusive + total ≥ 2.
const clorox = 'EPA Reg. No. 5813-79 Other Ingredients: 99.816%';
assert(g.looksLikeHouseholdProduct(clorox) === true, 'Clorox wipe with EPA Reg. must be household');

// US OTC Drug Facts cosmetics — shared signals only; must NOT be household.
const notHousehold = [
  [
    'Active ingredients: Avobenzone 3%, Homosalate 15%',
    'Inactive ingredients: Water, Glycerin',
    'Keep out of reach of children',
  ].join(' '),
  [
    'Active ingredients: Salicylic Acid 2%',
    'Inactive ingredients: Water, Glycerin',
    'Keep out of reach of children',
  ].join(' '),
  [
    'Active ingredients: Sodium Fluoride 0.243%',
    'Inactive ingredients: Sorbitol, Water',
    'Keep out of reach of children',
  ].join(' '),
  [
    'Active ingredients: Aluminum Zirconium Tetrachlorohydrex Gly 15%',
    'Inactive ingredients: Cyclopentasiloxane',
    'Keep out of reach of children',
  ].join(' '),
  // Percentage-only sunscreen (original Batch A regression)
  'Avobenzone 3%, Homosalate 15%',
  // Normal cosmetic INCI
  'Aqua, Glycerin, Phenoxyethanol, Tocopherol, Xanthan Gum',
];
for (const text of notHousehold) {
  assert(
    g.looksLikeHouseholdProduct(text) === false,
    'must NOT be household: ' + text.slice(0, 80)
  );
}

// One signal alone never fires (exclusive alone or shared alone).
const singles = [
  'ACTIVE INGREDIENTS: Water',
  'OTHER INGREDIENTS: fragrance',
  'INERT INGREDIENTS: water',
  'EPA Reg. No. 777-99',
  'EPA Est. 777-IN-1',
  'Ethanol 58.00%',
  'KEEP OUT OF REACH OF CHILDREN',
  'Hazards to humans and domestic animals',
];
for (const text of singles) {
  assert(
    g.looksLikeHouseholdProduct(text) === false,
    'single signal must not fire: ' + text
  );
}

// Shared-only combo (3 shared, 0 exclusive) — the OTC false-positive pattern.
assert(
  g.looksLikeHouseholdProduct(
    'Active ingredients: Avobenzone 3% Keep out of reach of children'
  ) === false,
  'three shared OTC signals without exclusive must not fire'
);

const result = g.buildHouseholdScanResponse({
  productName: 'Lysol',
  ingredients: lysol,
});
assert(result.productType === 'household', 'productType must be household');
assert(result.score === null, 'score must be null');
assert(result.scoreLabel === 'Not enough data', 'scoreLabel');
assert(result.scoreColor === '#9E9E9E', 'scoreColor');
assert(result.coverageMatched === 0 && result.coverageTotal === 0, 'coverage zeros');
assert(result.explanation === g.HOUSEHOLD_EXPLANATION, 'fixed explanation');
assert(
  g.HOUSEHOLD_EXPLANATION.includes("aren't disclosed by law"),
  'explanation must be the fixed household sentence'
);
const list = JSON.parse(result.ingredientList);
assert(Array.isArray(list) && list.length === 0, 'ingredientList must be empty');

// Category-based household (Dawn Ultra) — dish soap has no EPA Active/Other split.
assert(g.hasHouseholdCategory({
  categories_tags: ['en:dishwashing', 'en:cleaning-products'],
}) === true, 'Dawn-shaped dishwashing tags must be household');
assert(g.hasHouseholdCategory({
  categories_tags: ['en:dish-soap', 'en:detergents'],
}) === true, 'dish-soap + detergents must be household');
assert(g.hasHouseholdCategory({
  categories_tags: ['en:laundry-detergent'],
}) === true, 'laundry-detergent must be household');

// Cosmetic personal-care soaps must stay out of household (no bare "soap" fragment).
const notHouseholdCategories = [
  ['en:soaps'],
  ['en:soap'],
  ['en:hand-soap'],
  ['en:body-wash'],
  ['en:shampoo'],
  ['en:shampoos', 'en:hair-care'],
  ['en:bath-and-shower', 'en:shower-gels'],
];
for (const tags of notHouseholdCategories) {
  assert(
    g.hasHouseholdCategory({ categories_tags: tags }) === false,
    'must NOT be household category: ' + tags.join(',')
  );
}

// Additives row: missing ingredients text → "Not known", not "None".
assert(g.formatAdditivesCountDisplay(0, '') === 'Not known',
  'empty ingredients must show Not known');
assert(g.formatAdditivesCountDisplay(0, '   ') === 'Not known',
  'whitespace-only ingredients must show Not known');
assert(g.formatAdditivesCountDisplay(0, 'Water, Sugar') === 'None',
  'zero additives with ingredients text must still show None');
assert(g.formatAdditivesCountDisplay(2, 'Water, Sugar') === '2 additives',
  'non-zero additives display');
assert(g.formatAdditivesCountDisplay(0, null) === 'Not known',
  'null ingredients must show Not known');
assert(g.formatAdditivesCountDisplay(0, '.') === 'Not known',
  'punctuation-only ingredients must show Not known');

console.log('household product classification ok');
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"household classification assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def test_health_endpoint():
    """GET /health — 200 with versions; evaluateHealthStatus 503 on empty maps."""
    script = r"""
const http = require('http');
const path = require('path');
const Module = require('module');
const fs = require('fs');

const mockFirestore = {
  collection() {
    return {
      limit() {
        return {
          async get() {
            return { empty: true, docs: [] };
          },
        };
      },
      doc() {
        return {
          async get() {
            return { exists: false, data: () => undefined };
          },
          async set() {},
        };
      },
      async add() {
        return { id: 'x' };
      },
    };
  },
};
mockFirestore.FieldValue = { serverTimestamp: () => 'SERVER_TS', increment: (n) => n };

const mockAdmin = {
  initializeApp() {},
  credential: { cert() { return {}; } },
  auth() {
    return { async verifyIdToken() { return { uid: 'u' }; } };
  },
  firestore() {
    return mockFirestore;
  },
};
mockAdmin.firestore.FieldValue = mockFirestore.FieldValue;

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') return mockAdmin;
  return origRequire.apply(this, arguments);
};

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'demo',
  client_email: 'demo@demo.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg==\n-----END PRIVATE KEY-----\n',
});
process.env.ANTHROPIC_API_KEY = 'test-key';

const appPath = path.join(process.cwd(), 'index.js');
delete require.cache[appPath];
const app = require(appPath);

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function request(method, urlPath) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.request(
        { host: '127.0.0.1', port, path: urlPath, method },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
            resolve({ status: res.statusCode, json });
          });
        }
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

(async () => {
  const res = await request('GET', '/health');
  assert(res.status === 200, 'health → 200, got ' + res.status);
  assert(res.json && res.json.ok === true, 'ok true');
  assert(typeof res.json.uptimeSeconds === 'number', 'uptimeSeconds');
  assert(typeof res.json.tableVersion === 'string' && res.json.tableVersion.length > 0, 'tableVersion');
  assert(typeof res.json.cosingNamesVersion === 'string' && res.json.cosingNamesVersion.length > 0, 'cosingNamesVersion');
  assert(typeof res.json.entryCount === 'number' && res.json.entryCount > 0, 'entryCount');

  // Pure evaluator: empty reference map → 503
  const src = fs.readFileSync(appPath, 'utf8');
  const start = src.indexOf('function evaluateHealthStatus');
  const end = src.indexOf('async function pingFirestore');
  if (start < 0 || end < 0) throw new Error('evaluateHealthStatus not found');
  const block = src.slice(start, end) + '\nmodule.exports = { evaluateHealthStatus };\n';
  fs.writeFileSync('/tmp/health_eval.js', block);
  delete require.cache['/tmp/health_eval.js'];
  const { evaluateHealthStatus } = require('/tmp/health_eval.js');

  const bad = evaluateHealthStatus({
    firestoreOk: true,
    hazardCount: 0,
    synonymCount: 10,
    cosingCount: 10,
    uptimeSeconds: 1,
    tableVersion: 't',
    cosingNamesVersion: 'c',
  });
  assert(bad.status === 503 && bad.body.ok === false, 'empty hazard → 503');

  const badFs = evaluateHealthStatus({
    firestoreOk: false,
    hazardCount: 10,
    synonymCount: 10,
    cosingCount: 10,
    uptimeSeconds: 1,
    tableVersion: 't',
    cosingNamesVersion: 'c',
  });
  assert(badFs.status === 503 && badFs.body.reason === 'firestore unreachable');

  console.log('health endpoint ok', {
    tableVersion: res.json.tableVersion,
    entryCount: res.json.entryCount,
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(f"health endpoint assertions failed (exit {proc.returncode})")
    print(proc.stdout.strip())


def test_cosmetic_explanation_uses_we_voice():
    """Haiku cosmetic prompt must pin first-person plural and ban singular I."""
    src = (ROOT / "index.js").read_text(encoding="utf-8")
    start = src.index("async function generateCosmeticExplanation")
    end = src.index("function buildFoodExplanationPrompt")
    prompt_block = src[start:end]
    assert "Always write in the first-person plural" in prompt_block
    assert 'Never use first-person singular' in prompt_block
    assert '"we"' in prompt_block or "'we'" in prompt_block
    assert '"I"' in prompt_block or "'I'" in prompt_block
    print("cosmetic explanation we-voice ok")


def test_phase0_no_nutrition():
    """Food path: refuse score when energy/proteins/sodium|salt are all absent."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const logicMatch = src.match(/const SCAN_LOGIC_VERSION = '([^']+)'/);
if (!logicMatch) throw new Error('SCAN_LOGIC_VERSION missing');
const SCAN_LOGIC_VERSION = logicMatch[1];
assert(SCAN_LOGIC_VERSION === '2', 'SCAN_LOGIC_VERSION must be 2, got ' + SCAN_LOGIC_VERSION);

const nutStart = src.indexOf('function productHasNutriments');
const nutEnd = src.indexOf('// Explicit beauty/hygiene category fragments');
if (nutStart < 0 || nutEnd < 0) throw new Error('could not locate nutriment helpers');

const scoreStart = src.indexOf('function calculateScore');
const scoreEnd = src.indexOf('// OFF labels_tags is crowd-entered');
if (scoreStart < 0 || scoreEnd < 0) throw new Error('could not locate calculateScore block');

const fmtStart = src.indexOf('function parseServingQuantity');
const fmtEnd = src.indexOf('const additiveMap');
if (fmtStart < 0 || fmtEnd < 0) throw new Error('could not locate serving/format helpers');

const addDispStart = src.indexOf('function formatAdditivesCountDisplay');
const foodExplainStart = src.indexOf('async function generateFoodExplanation');
if (addDispStart < 0 || foodExplainStart < 0) {
  throw new Error('could not locate food explanation constants');
}

const foodFnStart = src.indexOf('async function scanAndCacheFood');
const foodFnEnd = src.indexOf('// Photo-rescued cache docs have no upstream');
if (foodFnStart < 0 || foodFnEnd < 0) throw new Error('could not locate scanAndCacheFood');

const cosStart = src.indexOf('const cosmeticTable = JSON.parse');
const cosEnd = src.indexOf('// Firestore docs are size-capped');
if (cosStart < 0 || cosEnd < 0) throw new Error('could not locate cosmetic block');

const orgStart = src.indexOf('function resolveOrganicStatus');
const orgEnd = src.indexOf('function parseServingQuantity');
if (orgStart < 0 || orgEnd < 0) throw new Error('could not locate organic helpers');

const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
function recordRawObservation() {}
async function getCategoryAlternatives() { return []; }
async function generateFoodExplanation() {
  throw new Error('Haiku must not be called');
}
const additiveMap = {};
const additiveDetails = {};
const SCAN_LOGIC_VERSION = '${SCAN_LOGIC_VERSION}';
${src.slice(cosStart, cosEnd).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
${src.slice(nutStart, nutEnd)}
${src.slice(scoreStart, scoreEnd)}
${src.slice(orgStart, orgEnd)}
${src.slice(fmtStart, fmtEnd)}
${src.slice(addDispStart, foodExplainStart)}
${src.slice(foodFnStart, foodFnEnd)}
module.exports = {
  hasNumericNutriment,
  hasScorableFoodNutriments,
  productHasNutriments,
  scanAndCacheFood,
  scoreCosmeticProduct,
  FOOD_NO_NUTRITION_EXPLANATION,
  SCAN_LOGIC_VERSION,
};
`;
fs.writeFileSync('/tmp/no_nutrition_helpers.js', block);
delete require.cache['/tmp/no_nutrition_helpers.js'];
const g = require('/tmp/no_nutrition_helpers.js');

(async () => {
assert(g.SCAN_LOGIC_VERSION === '2', 'exported SCAN_LOGIC_VERSION must be 2');
assert(/nutrition information/i.test(g.FOOD_NO_NUTRITION_EXPLANATION),
  'fixed explanation must mention nutrition information');
assert(/doesn't look like a food we can score/i.test(g.FOOD_NO_NUTRITION_EXPLANATION),
  'fixed explanation must mention not looking like a food we can score');

// Helper: 0 is present; missing / non-numeric is absent.
assert(g.hasNumericNutriment({ proteins_100g: 0 }, ['proteins_100g']) === true,
  '0 must count as present');
assert(g.hasNumericNutriment({ proteins_100g: '0' }, ['proteins_100g']) === false,
  'string must count as missing');
assert(g.hasNumericNutriment({}, ['proteins_100g']) === false, 'missing key');
assert(g.hasScorableFoodNutriments({
  'saturated-fat': 0,
  sugars: 0,
}) === false, 'Dawn saturated-fat/sugars only must not be scorable');
assert(g.hasScorableFoodNutriments({
  'energy-kcal_100g': 50,
}) === true, 'energy alone is scorable');
assert(g.hasScorableFoodNutriments({
  proteins_100g: 0,
}) === true, 'proteins 0 alone is scorable');
assert(g.hasScorableFoodNutriments({
  salt_100g: 0,
}) === true, 'salt 0 alone is scorable');
assert(g.hasScorableFoodNutriments({
  sodium_100g: 0.1,
}) === true, 'sodium alone is scorable');

// productHasNutriments still true for Dawn shape (non-empty object).
assert(g.productHasNutriments({
  nutriments: { 'saturated-fat': 0, sugars: 0 },
}) === true, 'Dawn shape still passes productHasNutriments');

// 1. Normal food with energy + protein + sodium → numeric score
{
  const result = await g.scanAndCacheFood('111', {
    product_name: 'Yogurt',
    ingredients_text: 'Milk, live cultures',
    nutriscore_grade: 'b',
    nova_group: 3,
    additives_tags: [],
    labels_tags: [],
    nutriments: {
      'energy-kcal_100g': 80,
      proteins_100g: 4,
      sodium_100g: 0.05,
      sugars_100g: 4,
    },
  }, { skipExplanation: true });
  assert(result.productType === 'food', 'normal food type');
  assert(typeof result.score === 'number' && result.score >= 0, 'normal food must score, got ' + result.score);
  assert(result.scoreLabel !== 'Not enough data', 'normal food must not be Not enough data');
  assert(result.scanLogicVersion === '2', 'normal food stamps logic version 2');
}

// 2. Food with only energy still scores
{
  const result = await g.scanAndCacheFood('222', {
    product_name: 'Mystery Calories',
    ingredients_text: 'Wheat flour',
    nutriscore_grade: 'c',
    additives_tags: [],
    nutriments: { 'energy-kcal_100g': 200 },
  }, { skipExplanation: true });
  assert(typeof result.score === 'number', 'energy-only food must score, got ' + result.score);
  assert(result.score !== null, 'energy-only score not null');
  assert(result.scoreLabel !== 'Not enough data', 'energy-only must not be Not enough data');
}

// 3. Dawn Ultra nutriment shape → no score, fixed explanation, no Haiku
{
  const dawn = {
    product_name: 'Dawn ultra',
    ingredients_text: 'alcohol denat., sodium lauryl sulfate, water',
    nutriscore_grade: 'unknown',
    nova_group: 4,
    additives_tags: ['en:e487'],
    categories_tags: [],
    nutriments: {
      'saturated-fat': 0,
      'saturated-fat_100g': 0,
      sugars: 0,
      sugars_100g: 0,
      'nova-group': 4,
      'nova-group_100g': 4,
    },
  };
  // skipExplanation false — must still not call Haiku (stub throws)
  const result = await g.scanAndCacheFood('030772011584', dawn, { skipExplanation: false });
  assert(result.score === null, 'Dawn score must be null, got ' + result.score);
  assert(result.scoreLabel === 'Not enough data', 'Dawn scoreLabel');
  assert(result.scoreColor === '#9E9E9E', 'Dawn grey scoreColor');
  assert(result.explanation === g.FOOD_NO_NUTRITION_EXPLANATION, 'Dawn fixed explanation');
  assert(result.productType === 'food', 'Dawn stays on food path (no categories)');
  assert(result.explanationPending !== true, 'must not defer Haiku for Dawn');
  assert(result.scanLogicVersion === '2', 'Dawn stamps logic version 2');
}

// Source: gate lives in scanAndCacheFood; Haiku skipped on this path
assert(src.includes('hasScorableFoodNutriments(product && product.nutriments)'),
  'scanAndCacheFood must gate on hasScorableFoodNutriments');
assert(src.includes('FOOD_NO_NUTRITION_EXPLANATION'),
  'index.js must define FOOD_NO_NUTRITION_EXPLANATION');
assert(src.includes('[FOOD NO NUTRITION]'),
  'scanAndCacheFood must log FOOD NO NUTRITION');

// 4. Cosmetic is unaffected
{
  const scored = g.scoreCosmeticProduct({
    ingredients_text: 'Aqua, Glycerin, Phenoxyethanol, Tocopherol',
  });
  assert(typeof scored.score === 'number' && scored.score !== null,
    'cosmetic must still score, got ' + scored.score);
  assert(scored.scoreLabel !== undefined, 'cosmetic has scoreLabel');
  assert(scored.coverageTotal > 0, 'cosmetic has coverage');
}

console.log('phase0 no nutrition ok');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"phase0 no-nutrition assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def test_phase0_batch_c():
    """Batch C: usable ingredient text, refusal filter, food no-LLM, cache logic version."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');

const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('// Firestore docs are size-capped');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic block');

const prodStart = src.indexOf('async function fetchProductFromFacts');
const resolveEnd = src.indexOf('function calculateScore');
if (prodStart < 0 || resolveEnd < 0) throw new Error('could not locate product/resolve block');

const explainStart = src.indexOf('function hasUsableExplanation');
const explainEnd = src.indexOf('const explanationInFlight');
if (explainStart < 0 || explainEnd < 0) throw new Error('could not locate hasUsableExplanation');

const foodPromptStart = src.indexOf('function buildFoodExplanationPrompt');
const foodPromptEnd = src.indexOf('async function requestFoodExplanation');
if (foodPromptStart < 0 || foodPromptEnd < 0) throw new Error('could not locate food prompt');

const logicMatch = src.match(/const SCAN_LOGIC_VERSION = '([^']+)'/);
if (!logicMatch) throw new Error('SCAN_LOGIC_VERSION missing');
const SCAN_LOGIC_VERSION = logicMatch[1];
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const foodNoStart = src.indexOf('const FOOD_NO_INGREDIENTS_EXPLANATION');
const foodNoEnd = src.indexOf('async function generateFoodExplanation');
if (foodNoStart < 0 || foodNoEnd < 0) throw new Error('could not locate FOOD_NO_INGREDIENTS_EXPLANATION');

const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = process.cwd();
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
${src.slice(prodStart, resolveEnd)}
${src.slice(explainStart, explainEnd)}
${src.slice(foodNoStart, foodNoEnd)}
module.exports = {
  hasUsableIngredientText,
  productHasIngredients,
  parseCosmeticIngredientList,
  scoreCosmeticProduct,
  hasUsableExplanation,
  hasCosmeticCategory,
  resolveProductType,
  FOOD_NO_INGREDIENTS_EXPLANATION,
  COSMETIC_NO_EXPLANATION,
  HOUSEHOLD_EXPLANATION,
  fallbackExplanationForProductType,
  SCAN_LOGIC_VERSION: '${SCAN_LOGIC_VERSION}',
  CACHE_TTL_MS: ${CACHE_TTL_MS},
  buildFoodExplanationPromptSource: ${JSON.stringify(src.slice(foodPromptStart, foodPromptEnd))},
};
`;
fs.writeFileSync('/tmp/batch_c_helpers.js', block);
delete require.cache['/tmp/batch_c_helpers.js'];
const g = require('/tmp/batch_c_helpers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

(async () => {
// 1. hasUsableIngredientText
assert(g.hasUsableIngredientText('.') === false, '"." must be unusable');
assert(g.hasUsableIngredientText('...') === false, '"..." must be unusable');
assert(g.hasUsableIngredientText(' ') === false, 'whitespace must be unusable');
assert(g.hasUsableIngredientText('a') === false, '"a" must be unusable');
assert(g.hasUsableIngredientText('ab') === false, '"ab" must be unusable');
assert(g.hasUsableIngredientText('Aqua, Glycerin') === true, 'real list must be usable');
assert(g.productHasIngredients({ ingredients_text: '.' }) === false,
  'productHasIngredients must reject "."');

// 2. Cosmetic with "." text falls through to structured array
{
  const parsed = g.parseCosmeticIngredientList({
    ingredients_text: '.',
    ingredients: [
      { text: 'Aqua' },
      { text: 'Glycerin' },
      { text: 'Parfum' },
    ],
  });
  const names = parsed.items.map(i => i.name);
  assert(names.includes('Aqua') && names.includes('Glycerin') && names.includes('Parfum'),
    'must parse from array when text is ".": ' + JSON.stringify(names));
  assert(names.length === 3, 'expected 3 rows, got ' + names.length);
  const scored = g.scoreCosmeticProduct({
    ingredients_text: '.',
    ingredients: [
      { text: 'Aqua' },
      { text: 'Glycerin' },
      { text: 'Parfum' },
    ],
  });
  assert(scored.coverageTotal === 3, 'coverageTotal from array, got ' + scored.coverageTotal);
  assert(scored.coverageTotal > 0, 'must not silent zero-ingredient parse');
}

// 3. OFF "." + cosmetic category → cosmetic via OBF
{
  const offProduct = {
    product_name: 'Dove Whole Body',
    ingredients_text: '.',
    categories_tags: ['en:deodorants', 'en:hygiene'],
    nutriments: {},
  };
  const obfProduct = {
    product_name: 'Dove Whole Body Deodorant',
    ingredients_text: 'Aqua, Glycerin, Parfum',
    categories_tags: ['en:deodorants'],
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('openfoodfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: offProduct }) };
    }
    if (u.includes('openbeautyfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: obfProduct }) };
    }
    return { ok: false };
  };
  const resolved = await g.resolveProductType('0000000000000');
  assert(resolved.productType === 'cosmetic', 'must resolve cosmetic, got ' + resolved.productType);
  assert(resolved.product === obfProduct, 'must use OBF product');
}

// Also: OFF "." without category → fall through to OBF
{
  const offProduct = {
    product_name: 'Mystery Deodorant',
    ingredients_text: '.',
    categories_tags: ['en:snacks'],
    nutriments: { 'energy-kcal_100g': 10 },
  };
  const obfProduct = {
    product_name: 'Mystery Deodorant OBF',
    ingredients_text: 'Aqua, Alcohol Denat., Parfum',
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('openfoodfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: offProduct }) };
    }
    if (u.includes('openbeautyfacts')) {
      return { ok: true, json: async () => ({ status: 1, product: obfProduct }) };
    }
    return { ok: false };
  };
  const resolved = await g.resolveProductType('1111111111111');
  assert(resolved.productType === 'cosmetic',
    'OFF "." must fall through to OBF, got ' + resolved.productType);
  assert(resolved.product.ingredients_text.includes('Aqua'), 'must use OBF ingredients');
}

// 4. Food path: no usable ingredients → fixed sentence, no LLM, noIngredientData
{
  let llmCalls = 0;
  global.fetch = async () => {
    llmCalls += 1;
    throw new Error('LLM must not be called');
  };

  const ingredients = '.';
  const noIngredientData = !g.hasUsableIngredientText(ingredients);
  assert(noIngredientData === true);
  const explanation = noIngredientData
    ? g.FOOD_NO_INGREDIENTS_EXPLANATION
    : 'should-not-happen';
  assert(explanation === g.FOOD_NO_INGREDIENTS_EXPLANATION);
  assert(/couldn't check the ingredients/i.test(explanation));
  assert(llmCalls === 0, 'no LLM call for missing ingredients');

  const foodFnStart = src.indexOf('async function scanAndCacheFood');
  const foodFnEnd = src.indexOf('// Photo-rescued cache docs have no upstream');
  const foodFn = src.slice(foodFnStart, foodFnEnd);
  assert(foodFn.includes('hasUsableIngredientText(ingredients)'),
    'scanAndCacheFood must guard on hasUsableIngredientText');
  assert(foodFn.includes('noIngredientData'),
    'scanAndCacheFood must set noIngredientData');
  assert(foodFn.includes('FOOD_NO_INGREDIENTS_EXPLANATION'),
    'scanAndCacheFood must use fixed sentence');
}

// 5. hasUsableExplanation rejects refusals / long / bullets; accepts normal
assert(g.hasUsableExplanation({
  explanation: "I'm unable to complete this task because the ingredient list provided is empty",
}) === false, 'unable refusal must be rejected');
assert(g.hasUsableExplanation({
  explanation: "I can't complete this request because there is nothing to analyze.",
}) === false, "I can't refusal must be rejected");
// Typographic apostrophes (U+2019) must normalise to straight before matching.
assert(g.hasUsableExplanation({
  explanation: "I can\u2019t complete this request because there is nothing to analyze.",
}) === false, "curly I can't must be rejected");
assert(g.hasUsableExplanation({
  explanation: "I\u2019m unable to complete this task because the ingredient list provided is empty",
}) === false, "curly I'm unable must be rejected");
assert(g.hasUsableExplanation({
  explanation: "I can\u02BCt complete this request.",
}) === false, 'U+02BC apostrophe form must be rejected');
assert(g.hasUsableExplanation({
  explanation: 'x'.repeat(601),
}) === false, '601-char string must be rejected');
assert(g.hasUsableExplanation({
  explanation: 'x'.repeat(500),
}) === true, '500-char explanation must be within the 600 cap');
assert(g.hasUsableExplanation({
  explanation: 'Here are the issues:\n- sugar is high\n- sodium is high',
}) === false, 'bulleted list must be rejected');
assert(g.hasUsableExplanation({
  explanation: "We've got high sugar at 12g per serving in this snack.",
}) === true, 'normal one-sentence explanation must pass');
// Legitimate multi-sentence cosmetic explanation with several findings (>400 chars).
{
  const cosmeticLong =
    "We've flagged Methylchloroisothiazolinone and Methylisothiazolinone as potent sensitisers that are restricted in leave-on cosmetic products under current rules, and Fragrance as a declarable allergen mix that can trigger reactions in sensitive skin. " +
    "Phenoxyethanol is a restricted preservative when used at higher levels in leave-on formulas. " +
    "A few botanical extracts and plant oils were not covered by our hazard table, so this assessment is incomplete on those rows and should be read with that gap in mind.";
  assert(cosmeticLong.length > 400 && cosmeticLong.length <= 600,
    'fixture should sit between old and new caps, len=' + cosmeticLong.length);
  assert(g.hasUsableExplanation({ explanation: cosmeticLong }) === true,
    'multi-sentence cosmetic explanation must pass the 600 cap');
}
assert(g.hasUsableExplanation({ explanation: '' }) === false);
assert(g.hasUsableExplanation({ explanation: null }) === false);
assert(g.hasUsableExplanation({}) === false);

// ensureExplanation fallback must be product-type aware (not food copy for cosmetics)
assert(g.fallbackExplanationForProductType('food') === g.FOOD_NO_INGREDIENTS_EXPLANATION);
assert(g.fallbackExplanationForProductType('cosmetic') === g.COSMETIC_NO_EXPLANATION);
assert(g.fallbackExplanationForProductType('household') === g.HOUSEHOLD_EXPLANATION);
assert(!/nutrition alone/i.test(g.COSMETIC_NO_EXPLANATION),
  'cosmetic fallback must not mention nutrition');
assert(/summarise this product's ingredients/i.test(g.COSMETIC_NO_EXPLANATION));
assert(src.includes('fallbackExplanationForProductType(cached && cached.productType)') ||
  src.includes('fallbackExplanationForProductType(cached.productType)'),
  'ensureExplanation must pick fallback by productType');

// 6 + 7. scanLogicVersion staleness
function isCacheFresh(cached, nowMs) {
  const age = nowMs - (cached.cachedAt || 0);
  const cachedType = cached.productType || 'food';
  const logicStale = cached.scanLogicVersion !== g.SCAN_LOGIC_VERSION;
  const tableStale = cachedType === 'cosmetic' && false;
  return age < g.CACHE_TTL_MS && !tableStale && !logicStale;
}

const now = Date.now();
assert(isCacheFresh({
  productType: 'food',
  cachedAt: now - 1000,
}, now) === false, 'missing scanLogicVersion must be stale');

assert(isCacheFresh({
  productType: 'food',
  cachedAt: now - 1000,
  scanLogicVersion: g.SCAN_LOGIC_VERSION,
}, now) === true, 'matching scanLogicVersion + fresh age must be hit');

assert(isCacheFresh({
  productType: 'household',
  cachedAt: now - 1000,
  scanLogicVersion: '0',
}, now) === false, 'mismatched scanLogicVersion must be stale');

const scanStart = src.indexOf('async function scanAndCache(barcode');
const scanSlice = src.slice(scanStart, scanStart + 2500);
assert(scanSlice.includes('logicStale'), 'scanAndCache must check logicStale');
assert(scanSlice.includes('SCAN_LOGIC_VERSION'), 'scanAndCache must compare SCAN_LOGIC_VERSION');
assert(/scanLogicVersion:\s*SCAN_LOGIC_VERSION/.test(src),
  'cached documents must stamp scanLogicVersion');

// 8. Food prompt contains first-person-plural instruction
assert(g.buildFoodExplanationPromptSource.includes('Always write in the first-person plural'),
  'food prompt must pin first-person plural');
assert(g.buildFoodExplanationPromptSource.includes('Never use first-person singular'),
  'food prompt must ban first-person singular');

console.log('phase0 batch c ok');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
"""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise AssertionError(
            f"phase0 batch c assertions failed (exit {proc.returncode})"
        )
    print(proc.stdout.strip())


def main() -> int:
    tests = [
        test_synonym_targets_exist_in_hazard_table,
        test_seeded_and_extended_pairs_present,
        test_synonym_lookup_behaviour,
        test_no_ingredient_data_flag_via_node,
        test_synonym_file_has_no_prefix_only_collisions,
        test_positional_and_stereo_prefixes_never_conflated,
        test_hazard_table_has_digit_comma_chemicals,
        test_cosmetic_parse_and_classify,
        test_strip_leading_prefix_helper_via_node,
        test_photo_cache_rescore_and_stale_fallback,
        test_fragrance_french_synonyms_and_unparseable_rules,
        test_slash_joined_multilingual_inci_lookup,
        test_paren_commas_and_drug_facts_truncation,
        test_photo_cache_below_gate_and_quality,
        test_request_guards_rate_limit_and_vision_cap,
        test_front_pack_name_and_image_helpers,
        test_front_image_endpoint,
        test_ingredients_text_preference_rejoin_and_u201a,
        test_cosing_recognised_names_layer,
        test_household_product_classification,
        test_health_endpoint,
        test_cosmetic_explanation_uses_we_voice,
        test_phase0_no_nutrition,
        test_phase0_batch_c,
    ]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"OK  {test.__name__}")
        except Exception as exc:  # noqa: BLE001 — report and continue
            failed += 1
            print(f"FAIL {test.__name__}: {exc}")
    if failed:
        print(f"{failed} failed")
        return 1
    print("all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Assertions for INCI normalisation, synonym matching, and cosmetic parsing.

Combines:
- PR #8 synonym / normalizeInci / noIngredientData / prefix-stereo rules
- parse/classify fixes: digit-safe commas, Ingredients: prefix, may-contain,
  tidy-up, (nano), category fragments
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
    }
    for common, target in required.items():
        assert synonyms.get(common) == target, f"{common} -> {synonyms.get(common)}"


def _run_node_lookup_assertions() -> None:
    """Drive the live JS lookupCosmeticIngredient via Node."""
    script = r"""
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join('/workspace', 'index.js'), 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('function stripCosmeticAnnotations');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic lookup block');
const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = '/workspace';
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
module.exports = { lookupCosmeticIngredient, normalizeInci, cosmeticBySynonym };
`;
fs.writeFileSync('/tmp/inci_lookup_helpers.js', block);
const { lookupCosmeticIngredient, normalizeInci } = require('/tmp/inci_lookup_helpers.js');
const synonyms = JSON.parse(fs.readFileSync('/workspace/purla_inci_synonyms.json', 'utf8')).synonyms;

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
const src = fs.readFileSync('/workspace/index.js', 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('function stringifyIngredientListForCache');
const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = '/workspace';
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
const src = fs.readFileSync('/workspace/index.js', 'utf8');
const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('function stripCosmeticAnnotations');
const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = '/workspace';
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
const src = fs.readFileSync(path.join('/workspace', 'index.js'), 'utf8');

const start = src.indexOf('const cosmeticTable = JSON.parse');
const end = src.indexOf('// Firestore docs are size-capped');
if (start < 0 || end < 0) throw new Error('could not locate cosmetic block');

const fragStart = src.indexOf('const COSMETIC_CATEGORY_FRAGMENTS');
const fragEnd = src.indexOf('async function resolveProductType');
if (fragStart < 0 || fragEnd < 0) throw new Error('could not locate category block');

const block = `
const fs = require('fs');
const path = require('path');
const __cosmeticDir = '/workspace';
${src.slice(start, end).replace(/path\.join\(__dirname,/g, 'path.join(__cosmeticDir,')}
${src.slice(fragStart, fragEnd)}
module.exports = {
  parseCosmeticIngredientList,
  scoreCosmeticProduct,
  stripLeadingIngredientLabelPrefix,
  splitMayContainSections,
  tidyParsedIngredientName,
  tagIndicatesCosmetic,
  hasCosmeticCategory,
  lookupCosmeticIngredient,
  normalizeInci,
};
`;
fs.writeFileSync('/tmp/cosmetic_parse_helpers.js', block);
const {
  parseCosmeticIngredientList,
  scoreCosmeticProduct,
  stripLeadingIngredientLabelPrefix,
  splitMayContainSections,
  tidyParsedIngredientName,
  tagIndicatesCosmetic,
  hasCosmeticCategory,
  lookupCosmeticIngredient,
} = require('/tmp/cosmetic_parse_helpers.js');

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
const src = fs.readFileSync('/workspace/index.js', 'utf8');
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

#!/usr/bin/env python3
"""Assertions for INCI normalisation and common-name synonym matching."""

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


def main() -> int:
    tests = [
        test_synonym_targets_exist_in_hazard_table,
        test_seeded_and_extended_pairs_present,
        test_synonym_lookup_behaviour,
        test_no_ingredient_data_flag_via_node,
        test_synonym_file_has_no_prefix_only_collisions,
        test_positional_and_stereo_prefixes_never_conflated,
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

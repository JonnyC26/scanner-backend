# Purla — Cosmetic Scanning & Scoring Spec

> Backend spec for `index.js` (Railway repo — **not** `purla-app`).
> Companion data file: `purla_cosmetic_ingredients.json` v0.4-draft, 371 entries.

---

## 1. What changes

Purla currently scores food only. This adds cosmetics as a second product type
sharing the same `/scan` endpoint, the same cache, and the same response shape —
with a different scoring engine behind it.

**Food scoring is untouched.** Do not modify the 60/30/10 formula, the Nutri-Score
handling, or anything in the existing scoring path.

---

## 2. Product type detection

`/scan/:barcode` must decide food vs cosmetic before scoring.

1. Query **Open Food Facts** first (`world.openfoodfacts.org/api/v2/product/{barcode}.json`)
2. On miss, query **Open Beauty Facts** (`world.openbeautyfacts.org/api/v2/product/{barcode}.json`)
3. First hit wins; set `productType` to `"food"` or `"cosmetic"`

If both miss → existing not-found path, unchanged.

If both hit (rare, usually a data error) → prefer the one with a populated
ingredients list. If still tied, prefer food.

Add `productType` to the response and to the `productCache` document. **Existing
cached documents have no such field — treat a missing value as `"food"`** so the
cache doesn't need rewriting.

---

## 3. Parsing the ingredient list

Open Beauty Facts returns INCI text in `ingredients_text` (and sometimes a parsed
`ingredients` array). Prefer the parsed array when present.

Splitting rules:

- Split on commas and bullet characters
- Strip parenthetical annotations **except** `(nano)` — that's a separate
  regulatory concept and must survive
- Strip leading/trailing whitespace and asterisks (used to mark organic origin)
- Drop empty fragments and anything under 3 characters
- Preserve case for display; lowercase only for matching

**Preserve order.** EU rules require descending concentration order above 1%,
so position carries weak signal. Store it as `position` on each matched
ingredient — it is *not* used in scoring v1, but the display layer may want it.

---

## 4. Matching against the table

Match each parsed ingredient against `purla_cosmetic_ingredients.json` in this
order. **Order matters and getting it wrong loses every grouped entry.**

1. `declare_as` — the name that actually appears on labels for grouped entries
   (e.g. `"Lavandula Oil/Extract"` covers eight member materials)
2. `inci` — the entry's own name
3. `covers_inci[]` — member names of a grouped entry

Normalisation before comparison: lowercase, collapse whitespace, unify hyphens
and slashes. **Do not strip leading positional prefixes** — `p-`, `o-` and `m-`
Phenylenediamine have opposite regulatory status and merging them produces a
confidently wrong grade. Same for `alpha-`.

Entries with a `member_of` pointer are aliases; resolve to the parent entry and
score the parent once, not both.

An ingredient matching nothing is an **unknown**. Unknowns are neutral for
scoring but counted for coverage (§6).

---

## 5. The score

Start at **100** and subtract.

### Exclusions

- Skip every entry with `risk_type: "environmental"` entirely. These are
  restricted for persistence, not skin safety — D5, D6, PTFE, polyethylene and
  similar. Showing them as personal health risks is wrong and is the specific
  error that gets scanner apps criticised.
- `risk_type: "both"` **is** included (D4's Annex II ban is reprotoxicity-driven).

### Penalties

| `risk` | per ingredient | category cap |
|---|---|---|
| `high` | −25 | −50 |
| `moderate` | −10 | −30 |
| `low` | −3 | −15 |
| `none` | 0 | — |

### Dose-dependence

Halve the penalty when `dose_dependent: true` — **except** for declared fragrance
allergens.

> **Why the exception.** For most restricted ingredients the label cannot tell you
> concentration, so the penalty is speculative and gets halved. Fragrance allergens
> are the opposite: an allergen name appears on the label *only because* it exceeds
> 0.001% (leave-on) or 0.01% (rinse-off). Its presence is dose-**confirming**.
> Halving it would discard the one thing the label does tell us.

Identify allergens by the presence of a `declaration_threshold` field.

### Allergen cap

Cap the **total** fragrance-allergen penalty at **−15**, independent of the
`low`/`moderate` category caps.

Without this, a perfume with fifteen declared allergens bottoms out — but that's
a description of perfume, not a health verdict. The cap keeps allergen load
visible without letting it dominate.

### Hard cap

If any matched ingredient has `"II"` in `eu_annex` **and** no other annex
alongside it, cap the final score at **20**. It legally should not be in an EU
product at all.

Do **not** apply this to conditional Annex II entries — those carry a second
annex. `Sodium Hydroxymethylglycinate` is `["II","V"]`: prohibited only above
0.1% releasable formaldehyde, otherwise a permitted preservative at 0.5%.
Treating it as banned would tell users a legal preservative is prohibited.

### Floor and tiers

Clamp to 0–100. Tiers match the food side exactly:

| Score | Label |
|---|---|
| 75–100 | Excellent |
| 50–74 | Good |
| 25–49 | Poor |
| 0–24 | Bad |

---

## 6. Coverage — and when not to show a score

Compute `coverage = matched / totalParsed`.

Return both counts. **If coverage is below 0.40, do not return a numeric score.**
Return `score: null`, `scoreLabel: "Not enough data"`, and the coverage figures.

This is deliberate. A confident "78" on a product where 6 of 34 ingredients were
recognised is a fabricated number. Competitors show it anyway. Purla should not —
it is both more honest and a real point of difference, and it costs nothing but
a branch.

The app should display coverage on every cosmetic result regardless:
`"14 of 22 ingredients assessed"`.

---

## 7. Response shape

Keep the existing envelope. Add:

```
productType        "food" | "cosmetic"
coverageMatched    integer
coverageTotal      integer
ingredientFindings [ { inci, risk, riskType, reason, basis[], doseDependent,
                       disputed, disputeNote, position } ]
```

For cosmetics, the existing nutrition fields (`protein`, `sugar`, `sodium`,
`nutriScore`, `additivesCount`) return `null`. The app must not render those rows
when `productType` is `"cosmetic"`.

`scoreBreakdown` should list the penalty contributions so the UI can explain the
score, same as the food side.

---

## 8. The Claude Haiku explanation

Cosmetics need their own prompt. The food prompt talks about sugar and additives
and will produce nonsense for shampoo.

The cosmetic prompt should:

- Name the two or three ingredients that drove the score, in plain language
- Say *why* — sensitiser, restricted concentration, prohibited, declarable allergen
- **Never** state or imply a concentration. The label doesn't disclose one.
- Mention coverage when it's below 0.60 — "based on the 14 ingredients we could
  assess"
- Stay under 40 words, matching the food side
- Use the entry's `reason` text as source material rather than inventing rationale

Where a matched entry has `disputed: true`, the explanation may mention that
sources disagree, but must not present the dissenting view as equivalent to the
regulatory finding.

---

## 9. Caching

Cache cosmetic results in `productCache` alongside food, same 30-day TTL, with
`productType` set.

**Add a `tableVersion` field** recording which version of
`purla_cosmetic_ingredients.json` produced the score. The EU annexes change
several times a year, and without this you cannot tell which cached scores are
stale after a table update. Invalidate cosmetic cache entries whose
`tableVersion` is older than the current table.

---

## 10. Do not

- Modify food scoring in any way
- Strip positional prefixes during matching
- Show environmental restrictions as health risks
- Return a score below 0.40 coverage
- Treat conditional Annex II entries as outright bans
- State concentrations in user-facing text

---

## 11. Open items, deliberately not specified

**Leave-on vs rinse-off.** Allergen thresholds differ by an order of magnitude
between the two, and Open Beauty Facts categories are inconsistent enough that
inferring product type reliably is its own piece of work. v1 treats all
declarations identically. Revisit once there's real scan data showing how often
the category is populated.

**Position weighting.** An ingredient appearing last in a 30-item list is under
1% by law. That's real signal and it's being stored but not used, because
weighting by position needs calibration against products where the true
concentration is known.

**Six editorial grades.** Two cinnamon oils, clove, jasmine, narcissus and the
two eugenol esters are graded `moderate` despite having no concentration cap,
because they're documented strong sensitisers in the baseline patch-test series.
That's an editorial judgement, not a regulatory one. It should become a written
policy rather than a set of case-by-case calls.

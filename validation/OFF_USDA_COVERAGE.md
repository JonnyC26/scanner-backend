# USDA vs Open Food Facts coverage (Task 1)

Measured 2026-09-10T18:27:24.519Z against USDA FoodData Central branded foods and OFF barcode API v2.

## Headline

- USDA hits in sample: **337** unique GTINs across **100** `foodCategory` values.
- OFF valid product when USDA has one: **89.6%** (302/337).
- Of those OFF records, usable additive data: **92.1%** (278/302).

Unknown-additive status is the **minority**: 82.5% of USDA hits have an OFF record with usable additive data. 17.5% are unknown (no OFF record, or OFF record without additive count/tags).

## Definitions

- OFF valid product: `/api/v2/product/{gtin}` returned `status=1` with a product object (EAN-13 padded USDA GTIN). Two barcodes remained HTTP 429 after retries and are counted as misses; 33 were genuine not-found.
- Usable additive data: non-empty `additives_tags`, **or** `additives_n` is a finite number (including 0). `en:additives-completed` did not appear on these US products.
- `additives_tags` non-empty is a stricter cut: 51.0% of OFF records list at least one additive; another 41.1% have `additives_n === 0` (computed none). 8.0% of OFF records have no additive count at all.

## Store vs national

- Store-brand queries: 258 USDA hits, **90.3%** also in OFF.
- National-brand queries: 79 USDA hits, **87.3%** also in OFF.
- Store-brand searches included Kroger, 365 Whole Foods, Kirkland, Publix, Wegmans, Trader Joe’s, Food Club, Member’s Mark, Happy Belly, Signature Select, Simple Truth. Great Value / Good & Gather USDA searches 429’d under DEMO_KEY; Walmart still appears via other hits.

## OFF fields among valid OFF products

- additives_tags non-empty: 51%
- nutriscore_grade (A–E, not unknown): 83.1%
- labels_tags non-empty: 18.5%

## Implication for Task 2

OFF is present for most USDA branded hits, including store brands in this sample. Additive status is unknown for a minority of USDA hits, not the common case. Task 2 proceeds as specified: replace the Nutri-Score 60-point component with a USDA nutrition subscore; do not change the additive component.

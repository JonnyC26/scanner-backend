# Nutrition subscore validation (Task 2)

Computed on the Task 1 USDA branded sample, for products that both (a) have a real OFF `nutriscore_grade` A–E and (b) have enough USDA nutrients to produce a subscore.

## Results

- n = 242
- Spearman rank correlation vs OFF grade A–E: **0.807** (target ≥ 0.70)
- Pairs separated by two or more grades ordered correctly: **91.6%** (14011 / 15289; 230 ties counted as not correct; target ≥ 80%)
- Mean Purla nutrition subscore by OFF grade: A 43.0, B 40.1, C 37.5, D 30.0, E 23.3 (out of 60)

Thresholds were not tuned against this set. Published Nutri-Score 2023 cut points were mapped onto Purla's 60-point allocation.

## Sentinels (unit-tested)

- Olive oil (Vegetable & Cooking Oils) must not score like chocolate on energy density — fat-quality path vs general food.
- Diet cola (Soda) must not approach the top of the 60-point scale.
- Frozen vegetables and oats outscore crisps and chocolate.

## Asymmetry

- Coca-Cola: no saturated-fat row; total fat 0 derives sat fat 0.
- Heinz-style: fibre 0.0 is stored as zero, not treated as missing.
- Missing energy / sugars / saturated fat / sodium → subscore unavailable (denominator stays 60 when fibre or protein is missing).

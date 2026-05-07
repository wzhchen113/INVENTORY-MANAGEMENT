# Prep canonicalness notes (working draft)

Captured 2026-05-05 by Will (owner). To be formalized into Spec 002.

## Background
The Phase 2 backfill migration left 399 orphan references in prep_recipe_ingredients
across 10 distinct prep names. Spec 002 will investigate whether the canonical
(is_current=true) versions are functionally equivalent to the non-canonical ones.

This file captures owner knowledge that the agents cannot derive from data alone:
which version is *actually* the right one for each prep, regardless of what
is_current currently says.

## Per-prep notes

### 2AM SAUCE (canonical prefix: 66d823)
[your knowledge here — which version is correct, which should have been deleted,
how you know, any other context]
RAW - e8df72 - Garlic Granulated - (27.5 lb.) - 0.176 lbs - $0.54 - 1%
RAW - e33af6 - Horseradish - 24 oz - $3.18 - 4%
PREP - 5d6a0e - Cajun Seasoning (House Mix) - 8 oz - $26.30 - 31%
RAW - 91293b - Mayonnaise - 4 gal - $40.44 - 47%
RAW - 9c4414 - Worcestershire - 0.313 gal - $2.74 - 3%
RAW - ba2714 - Ketchup (Can 114oz) - 114 oz - $7.43 - 9%
RAW - 9ee3f5 - Mustard (Gal) - 0.188 gal - $1.38 - 2%
RAW - 419723 - Sugar - 48 oz - $1.86 - 2%
RAW - 61bcb5 - Parsley Flake - 12 oz - $22.93 - 27%
RAW - f523aa - Paprika - 1.058 lbs - $4.23 - 5%

### Burger Patty (canonical prefix: 500ef2)
[your knowledge — note: this is the prep already covered by Spec 001's 4-row fix]
RAW - 9e11bf - Montreal Steak Seasoning - 4 oz - $1.29 - 1%
RAW - 5e1815 - Ground Beef - 20 lbs - $97.40 - 92%
RAW - 375c3f - Ground Cumin - 8 oz - $2.00 - 2%
RAW - e8df72 - Garlic Granulated - 4 oz - $0.77 - 1%
RAW - bf54f8 - Black Pepper - 8 oz - $4.20 - 4%

### House Special Seasoning (House Mix) (canonical prefix: 38678f)
[your knowledge or "unknown — need to investigate"]
RAW - db453c - Oregano Leaves - 635 g - $10.01 - 7%
RAW - 5a0f12 - Lemon Pepper Seasoning - 7 lbs - $23.77 - 18%
RAW - e525ce - Taco Seasoning - 320 oz - $52.80 - 39%
RAW - 419723 - Sugar - 32 oz - $1.24 - 1%
RAW - 89d3ce - MSG Ajinomoto Umami - 96 oz - $0.00 - 0%
RAW - 090008 - Cajun Spice & Skillet - 10 lbs - $37.50 - 28%
RAW - 9bd04c - Chicken Stock (Totole) - 32 oz - $8.55 - 6%

### Cajun Seasoning (House Mix) (canonical prefix: 5d6a0e)
[your knowledge or "unknown — need to investigate"]
RAW - f523aa - Paprika - 5 lbs - $20.00 - 27%
RAW - 090008 - Cajun Spice & Skillet - 10 lbs - $37.50 - 51%
RAW - 9bd04c - Chicken Stock (Totole) - 16 oz - $4.28 - 6%
RAW - db453c - Oregano Leaves - 635 g - $10.01 - 14%
RAW - 419723 - Sugar - 48 oz - $1.86 - 3%
RAW - 89d3ce - MSG Ajinomoto Umami - 32 oz - $0.00 - 0%

### White Sauce (canonical prefix: 8782cf)
[your knowledge or "unknown — need to investigate"]
RAW - 419723 - Sugar - 16 oz - $0.62 - 1%
RAW - af950c - Dill Leaf Spice - 35 g - $3.58 - 5%
RAW - 6106cc - Lemon Juice 48fl. oz. - 16 fl_oz - $0.00 - 0%
RAW - 7833a3 - Fry Oil Canola - 32 fl_oz - $8.49 - 12%
RAW - 91293b - Mayonnaise - 3 gal - $30.33 - 43%
RAW - bed427 - Sour Cream - 64 oz - $6.07 - 9%
RAW - e8df72 - Garlic Granulated - 4 oz - $0.77 - 1%
RAW - bf54f8 - Black Pepper - 8 oz - $4.20 - 6%
RAW - e396fd - Plain Yogurt - 128 oz - $16.72 - 24%

### Yellow Rice (canonical prefix: fb1e76)
PREP - c7d9a9 - Tumeric Seasoning (House Mix) - 16 oz - $51.87 - 391%
RAW - 562601 - Water (Bottle) - 8.313 lbs - $0.00 - 0%
RAW - 6106cc - Lemon Juice 48fl. oz. - 4 fl_oz - $0.00 - 0%
RAW - 7833a3 - Fry Oil Canola - 8 fl_oz - $2.12 - 16%
RAW - eadfaf - Basmatic Rice - 5 lbs - $7.90 - 60%

### Tumeric Seasoning (House Mix) (canonical prefix: c7d9a9)
RAW - 43829a - Coriander - 10 lbs - $31.40 - 28%
RAW - 9bd04c - Chicken Stock (Totole) - 64 oz - $17.10 - 15%
RAW - 375c3f - Ground Cumin - 5 lbs - $19.99 - 18%
RAW - bdc995 - Tumeric - 10 lbs - $44.98 - 40%
RAW - 89d3ce - MSG Ajinomoto Umami - 96 oz - $0.00 - 0%

### Marinade Chicken (canonical prefix: d89157)
RAW - 562601 - Water (Bottle) - 64 oz - $0.00 - 0%
RAW - e7776e - Chicken Leg - 40 lbs - $88.68 - 74%
RAW - 6106cc - Lemon Juice 48fl. oz. - 16 fl_oz - $0.00 - 0%
RAW - bf54f8 - Black Pepper - 8 oz - $4.20 - 3%
PREP - c7d9a9 - Tumeric Seasoning (House Mix) - 16 oz - $51.87 - 43%
RAW - 375c3f - Ground Cumin - 8 oz - $2.00 - 2%
RAW - f523aa - Paprika - 16 oz - $4.00 - 3%
RAW - 7833a3 - Fry Oil Canola - 64 fl_oz - $16.98 - 14%
RAW - f6af9c - Cooking Wine - 32 fl_oz - $1.06 - 1%

### Imitation Crabmeat Mix (canonical prefix: f44580)
PREP - 5d6a0e - Cajun Seasoning (House Mix) - 8 oz - $26.30 - 30%
RAW - 84a323 - Imitation Crabmeat (Oyster Bay) - 12 lbs - $12.00 - 14%
RAW - 5231ea - Crabmeat (Claw) - 6 lbs - $72.96 - 85%

### House Special Blend (Sauce) (canonical prefix: 4fbd90)
RAW - dd1e17 - Margarine - 26 lbs - $29.71 - 56%
RAW - 6106cc - Lemon Juice 48fl. oz. - 16 fl_oz - $0.00 - 0%
PREP - 38678f - House Special Seasoning (House Mix) - 2110 g - $5836.06 - 10911%
RAW - 2558f9 - Cheese Parmesan Grated - 8 oz - $2.80 - 5%
RAW - 86ea75 - Garlic Fresh Peeled - 27 oz - $4.89 - 9%
RAW - 35c978 - Milk - 1 gal - $3.21 - 6%



## What to do with this
Spec 002 (investigation) should:
1. Run the ingredient-list divergence probe
2. Cross-reference results with this owner-knowledge file
3. Surface conflicts (cases where data says one thing and owner knowledge says another)
4. Output a per-prep verdict that combines both sources of truth
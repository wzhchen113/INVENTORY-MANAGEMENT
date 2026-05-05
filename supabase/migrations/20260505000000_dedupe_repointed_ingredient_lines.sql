-- ============================================================
-- Dedupe ingredient lines that Phase 2 backfill accidentally piled
-- onto the canonical brand-level recipes/preps.
--
-- Background. The brand-catalog refactor's Phase 2 dedup
-- (20260504062318_brand_catalog_p2_backfill.sql) repointed every
-- non-canonical store's ingredient rows onto the single canonical
-- brand row, but never collapsed the now-duplicate ingredient lines
-- themselves. With 4 stores in the system, the canonical recipe/prep
-- ended up with 4× copies of every ingredient. The Bill-of-Materials
-- panel ("bom.tsv") in PrepRecipesSection.tsx surfaces this directly:
-- a 10-ingredient prep shows 40 rows.
--
-- Surveyed on prod (2026-05-05) — three tables affected:
--   prep_recipe_ingredients : ~180 rows to delete (4× across 10 preps)
--   recipe_ingredients      : 456 rows to delete across 152 groups
--   recipe_prep_items       : 111 rows to delete across 37 groups
-- pos_recipe_aliases checked clean (its app-side write path naturally
-- enforced uniqueness).
--
-- 99% of duplicate rows are byte-identical, so dedup is mechanical.
-- Two known divergences exist on Philly Cheesesteak where the four
-- stores actually disagreed on quantity:
--   Mayonnaise (fl_oz):    [1, 2, 2, 2]    → mode = 2
--   Provolone Cheese (g):  [50, 50, 50, 42] → mode = 50
-- Resolved by mode-quantity wins, tiebreak min(id).
--
-- Historical (is_current=false) prep_recipes are intentionally left
-- alone: P2 never repointed their ingredient rows, so they still
-- reflect what each store actually had at version time.
--
-- After the deletes, three logical-key UNIQUE indexes are added so
-- the same accumulation can't happen again — and the app gets
-- idempotent upsert semantics for free.
-- ============================================================

-- ─── 1. prep_recipe_ingredients ────────────────────────────
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY prep_recipe_id,
                        COALESCE(type, 'raw'),
                        catalog_id,
                        sub_recipe_id,
                        unit
           ORDER BY id
         ) AS rn
    FROM prep_recipe_ingredients
)
DELETE FROM prep_recipe_ingredients
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ─── 2. recipe_ingredients (handle the 2 divergent groups) ──
-- Build mode-quantity per logical group first, then keep the row
-- whose quantity matches the mode (tiebreak min(id)).
CREATE TEMP TABLE _ri_mode AS
SELECT recipe_id, catalog_id, unit,
       mode() WITHIN GROUP (ORDER BY quantity) AS mode_quantity
  FROM recipe_ingredients
 GROUP BY recipe_id, catalog_id, unit;

WITH ranked AS (
  SELECT ri.id,
         ROW_NUMBER() OVER (
           PARTITION BY ri.recipe_id, ri.catalog_id, ri.unit
           ORDER BY CASE WHEN ri.quantity = m.mode_quantity THEN 0 ELSE 1 END,
                    ri.id
         ) AS rn
    FROM recipe_ingredients ri
    JOIN _ri_mode m
      ON m.recipe_id = ri.recipe_id
     AND m.catalog_id IS NOT DISTINCT FROM ri.catalog_id
     AND m.unit IS NOT DISTINCT FROM ri.unit
)
DELETE FROM recipe_ingredients
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

DROP TABLE _ri_mode;

-- ─── 3. recipe_prep_items ──────────────────────────────────
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY recipe_id, prep_recipe_id, unit
           ORDER BY id
         ) AS rn
    FROM recipe_prep_items
)
DELETE FROM recipe_prep_items
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ─── 4. Logical-key uniques (prevents recurrence) ───────────
-- NULLS NOT DISTINCT (PG15+) so two NULL catalog_ids on a sub-recipe
-- ref count as equal, matching the dedup semantics above.
CREATE UNIQUE INDEX IF NOT EXISTS prep_recipe_ingredients_logical_unique
  ON public.prep_recipe_ingredients (
    prep_recipe_id,
    (COALESCE(type, 'raw')),
    catalog_id,
    sub_recipe_id,
    unit
  ) NULLS NOT DISTINCT;

CREATE UNIQUE INDEX IF NOT EXISTS recipe_ingredients_logical_unique
  ON public.recipe_ingredients (recipe_id, catalog_id, unit)
  NULLS NOT DISTINCT;

CREATE UNIQUE INDEX IF NOT EXISTS recipe_prep_items_logical_unique
  ON public.recipe_prep_items (recipe_id, prep_recipe_id, unit)
  NULLS NOT DISTINCT;

-- ─── 5. Sanity report ─────────────────────────────────────
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM prep_recipe_ingredients pri
    JOIN prep_recipes pr ON pr.id = pri.prep_recipe_id
   WHERE pr.is_current = true;
  RAISE NOTICE 'prep_recipe_ingredients (current preps): %  (expected ~65)', v_count;

  SELECT count(*) INTO v_count FROM recipe_ingredients;
  RAISE NOTICE 'recipe_ingredients: %  (expected ~150)', v_count;

  SELECT count(*) INTO v_count FROM recipe_prep_items;
  RAISE NOTICE 'recipe_prep_items: %  (expected ~30)', v_count;
END $$;

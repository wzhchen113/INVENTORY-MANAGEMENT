-- ============================================================
-- Brand catalog refactor — Phase 2: data backfill
--
-- Populates brand_id / catalog_id on every existing row, dedupes
-- per-store recipes / prep recipes / ingredient_conversions to one
-- canonical brand-level row each. Non-breaking — running app keeps
-- working unchanged (still ignores the new columns).
--
-- Idempotent: re-running this migration is a no-op (uses
-- "WHERE … IS NULL" predicates and ON CONFLICT DO NOTHING). Safe to
-- re-apply if interrupted mid-way.
--
-- Drift handling discovered during planning:
--   - 1 recipe is unique to Frederick ("2AM Fries"); it survives as a
--     brand-level row, no Towson canonical to repoint at.
--   - 0 current prep recipes are unique to non-Towson stores.
-- See plan: 2-brand-catalog-refactor.md.
-- ============================================================

DO $$
DECLARE
  v_brand_id  constant uuid := '2a000000-0000-0000-0000-000000000001';
  v_towson_id constant uuid := '00000000-0000-0000-0000-000000000001';
  v_count     int;
BEGIN
  -- ─── 1. Brand the simple tables ──────────────────────────
  UPDATE stores  SET brand_id = v_brand_id WHERE brand_id IS NULL;
  UPDATE vendors SET brand_id = v_brand_id WHERE brand_id IS NULL;

  -- ─── 2. Build catalog_ingredients from inventory ─────────
  -- One catalog row per distinct lower(name) across ALL stores so any
  -- non-Towson-only items (none exist today, but be safe) still get a
  -- catalog row. Towson's metadata (unit, category, case_qty, etc.) is
  -- preferred since it's the canonical source.
  INSERT INTO catalog_ingredients (
    brand_id, name, unit, category,
    case_qty, sub_unit_size, sub_unit_unit,
    default_cost, default_case_price
  )
  SELECT v_brand_id, name, unit, category,
         case_qty, sub_unit_size, sub_unit_unit,
         cost_per_unit, case_price
  FROM (
    SELECT DISTINCT ON (lower(name))
           name, unit, category, case_qty, sub_unit_size, sub_unit_unit,
           cost_per_unit, case_price
    FROM inventory_items
    ORDER BY lower(name),
             CASE WHEN store_id = v_towson_id THEN 0 ELSE 1 END,
             created_at
  ) src
  ON CONFLICT (brand_id, lower(name)) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'inserted % catalog_ingredients', v_count;

  -- ─── 3. Link inventory_items → catalog ───────────────────
  UPDATE inventory_items i
     SET catalog_id = c.id
    FROM catalog_ingredients c
   WHERE c.brand_id = v_brand_id
     AND lower(i.name) = lower(c.name)
     AND i.catalog_id IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'linked % inventory_items.catalog_id', v_count;

  -- ─── 4. Dedupe recipes ───────────────────────────────────
  -- Pick canonical: Towson preferred, otherwise oldest. Any recipe
  -- without a Towson equivalent (Frederick's "2AM Fries") gets kept
  -- as-is and just brand_id'd.
  CREATE TEMP TABLE _recipe_dedupe AS
  SELECT id AS row_id,
         menu_item,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(menu_item)
           ORDER BY CASE WHEN store_id = v_towson_id THEN 0 ELSE 1 END,
                    created_at
         ) AS canonical_id
  FROM recipes;

  -- Brand all canonical rows (and any singletons that got picked as
  -- their own canonical, e.g. "2AM Fries" at Frederick).
  UPDATE recipes
     SET brand_id = v_brand_id
   WHERE id IN (SELECT DISTINCT canonical_id FROM _recipe_dedupe)
     AND brand_id IS NULL;

  -- Repoint dependents BEFORE deleting non-canonical recipes.
  -- (recipe_ingredients has ON DELETE CASCADE so we'd lose them
  -- otherwise. pos_import_items is NO ACTION so the delete would fail.
  -- pos_recipe_aliases is CASCADE so we'd lose alias mappings.)
  UPDATE recipe_ingredients ri
     SET recipe_id = d.canonical_id
    FROM _recipe_dedupe d
   WHERE ri.recipe_id = d.row_id AND d.row_id <> d.canonical_id;

  UPDATE recipe_prep_items rpi
     SET recipe_id = d.canonical_id
    FROM _recipe_dedupe d
   WHERE rpi.recipe_id = d.row_id AND d.row_id <> d.canonical_id;

  UPDATE pos_import_items pii
     SET recipe_id = d.canonical_id
    FROM _recipe_dedupe d
   WHERE pii.recipe_id = d.row_id AND d.row_id <> d.canonical_id;

  UPDATE pos_recipe_aliases pra
     SET recipe_id = d.canonical_id
    FROM _recipe_dedupe d
   WHERE pra.recipe_id = d.row_id AND d.row_id <> d.canonical_id;

  DELETE FROM recipes
   WHERE id IN (SELECT row_id FROM _recipe_dedupe WHERE row_id <> canonical_id);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'deleted % duplicate recipes', v_count;

  DROP TABLE _recipe_dedupe;

  -- ─── 5. Dedupe prep recipes (current versions only) ──────
  -- Old versions (is_current=false) are kept as-is — they're version
  -- history, internally referenced via parent_id (no FK constraint, so
  -- nothing breaks if those pointers go cross-brand later). Brand_id
  -- still gets set on them so Phase 3's NOT NULL holds.
  CREATE TEMP TABLE _prep_dedupe AS
  SELECT id AS row_id,
         name,
         FIRST_VALUE(id) OVER (
           PARTITION BY lower(name)
           ORDER BY CASE WHEN store_id = v_towson_id THEN 0 ELSE 1 END,
                    version DESC, created_at
         ) AS canonical_id
  FROM prep_recipes
  WHERE is_current = true;

  -- Brand the canonical current preps and ALL non-current preps.
  UPDATE prep_recipes
     SET brand_id = v_brand_id
   WHERE brand_id IS NULL;

  -- Repoint dependents BEFORE delete.
  UPDATE prep_recipe_ingredients pri
     SET prep_recipe_id = d.canonical_id
    FROM _prep_dedupe d
   WHERE pri.prep_recipe_id = d.row_id AND d.row_id <> d.canonical_id;

  -- Self-FK (sub-recipe references) — only repoint when the sub points
  -- at a non-canonical current prep that's about to be deleted.
  UPDATE prep_recipe_ingredients pri
     SET sub_recipe_id = d.canonical_id
    FROM _prep_dedupe d
   WHERE pri.sub_recipe_id = d.row_id AND d.row_id <> d.canonical_id;

  UPDATE recipe_prep_items rpi
     SET prep_recipe_id = d.canonical_id
    FROM _prep_dedupe d
   WHERE rpi.prep_recipe_id = d.row_id AND d.row_id <> d.canonical_id;

  -- parent_id has no FK constraint (verified) so we don't strictly need
  -- to repoint it, but doing so keeps the version-chain coherent for
  -- any UI that follows it back.
  UPDATE prep_recipes child
     SET parent_id = d.canonical_id
    FROM _prep_dedupe d
   WHERE child.parent_id = d.row_id AND d.row_id <> d.canonical_id;

  DELETE FROM prep_recipes
   WHERE id IN (SELECT row_id FROM _prep_dedupe WHERE row_id <> canonical_id);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'deleted % duplicate prep_recipes (current versions)', v_count;

  DROP TABLE _prep_dedupe;

  -- ─── 6. Migrate ingredient FKs item_id → catalog_id ──────
  UPDATE recipe_ingredients ri
     SET catalog_id = i.catalog_id
    FROM inventory_items i
   WHERE ri.item_id = i.id
     AND i.catalog_id IS NOT NULL
     AND ri.catalog_id IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'migrated % recipe_ingredients to catalog_id', v_count;

  UPDATE prep_recipe_ingredients pri
     SET catalog_id = i.catalog_id
    FROM inventory_items i
   WHERE pri.item_id = i.id
     AND i.catalog_id IS NOT NULL
     AND pri.catalog_id IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'migrated % prep_recipe_ingredients to catalog_id', v_count;

  -- ─── 7. ingredient_conversions: link + dedupe ────────────
  -- A conversion is a property of the ingredient, not of a per-store
  -- inventory row. Same item at 4 stores currently has 4 conversion
  -- rows; collapse to 1, preferring Towson's.
  UPDATE ingredient_conversions ic
     SET catalog_id = i.catalog_id
    FROM inventory_items i
   WHERE ic.inventory_item_id = i.id
     AND i.catalog_id IS NOT NULL
     AND ic.catalog_id IS NULL;

  WITH ranked AS (
    SELECT ic.id,
           ROW_NUMBER() OVER (
             PARTITION BY ic.catalog_id, lower(ic.purchase_unit)
             ORDER BY CASE WHEN i.store_id = v_towson_id THEN 0 ELSE 1 END,
                      ic.id
           ) AS rn
      FROM ingredient_conversions ic
      JOIN inventory_items i ON i.id = ic.inventory_item_id
     WHERE ic.catalog_id IS NOT NULL
  )
  DELETE FROM ingredient_conversions
   WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'deduped % ingredient_conversions', v_count;

  -- ─── 8. Sanity report ────────────────────────────────────
  RAISE NOTICE '════ Phase 2 sanity counts ════';

  SELECT count(*) INTO v_count FROM brands;
  RAISE NOTICE 'brands: %  (expected 1)', v_count;

  SELECT count(*) INTO v_count FROM stores  WHERE brand_id IS NULL;
  RAISE NOTICE 'stores  NULL brand_id: %  (expected 0)', v_count;

  SELECT count(*) INTO v_count FROM vendors WHERE brand_id IS NULL;
  RAISE NOTICE 'vendors NULL brand_id: %  (expected 0)', v_count;

  SELECT count(*) INTO v_count FROM catalog_ingredients;
  RAISE NOTICE 'catalog_ingredients: %  (expected ~143)', v_count;

  SELECT count(*) INTO v_count FROM inventory_items WHERE catalog_id IS NULL;
  RAISE NOTICE 'inventory_items NULL catalog_id: %  (expected 0)', v_count;

  SELECT count(*) INTO v_count FROM recipes;
  RAISE NOTICE 'recipes total: %  (expected 41 — 40 shared + 1 Frederick drift)', v_count;

  SELECT count(*) INTO v_count FROM recipes WHERE brand_id IS NULL;
  RAISE NOTICE 'recipes NULL brand_id: %  (expected 0)', v_count;

  SELECT count(*) INTO v_count FROM (
    SELECT brand_id, lower(menu_item)
      FROM recipes WHERE brand_id IS NOT NULL
     GROUP BY brand_id, lower(menu_item)
    HAVING count(*) > 1
  ) sub;
  RAISE NOTICE 'duplicate (brand, menu_item) groups: %  (expected 0 — Phase 3 unique)', v_count;

  SELECT count(*) INTO v_count FROM prep_recipes WHERE is_current = true;
  RAISE NOTICE 'current prep_recipes: %  (expected 10)', v_count;

  SELECT count(*) INTO v_count FROM prep_recipes WHERE brand_id IS NULL;
  RAISE NOTICE 'prep_recipes NULL brand_id: %  (expected 0)', v_count;

  SELECT count(*) INTO v_count FROM recipe_ingredients WHERE catalog_id IS NULL;
  RAISE NOTICE 'recipe_ingredients NULL catalog_id: %  (expected 0)', v_count;

  -- prep_recipe_ingredients: type='raw' rows must have catalog_id, but
  -- type='prep' rows (sub-recipe references) carry sub_recipe_id and
  -- legitimately have NULL catalog_id. Phase 3 will NOT NULL catalog_id
  -- conditionally via a CHECK (catalog_id IS NOT NULL OR sub_recipe_id
  -- IS NOT NULL), not as a column-level NOT NULL.
  SELECT count(*) INTO v_count
    FROM prep_recipe_ingredients
   WHERE catalog_id IS NULL
     AND COALESCE(type, 'raw') = 'raw';
  RAISE NOTICE 'prep_recipe_ingredients raw NULL catalog_id: %  (expected 0)', v_count;

  SELECT count(*) INTO v_count
    FROM prep_recipe_ingredients
   WHERE catalog_id IS NULL
     AND type = 'prep';
  RAISE NOTICE 'prep_recipe_ingredients prep (sub-recipe refs) NULL catalog_id: %  (informational)', v_count;

  SELECT count(*) INTO v_count FROM ingredient_conversions WHERE catalog_id IS NULL;
  RAISE NOTICE 'ingredient_conversions NULL catalog_id: %  (expected 0)', v_count;

END $$;

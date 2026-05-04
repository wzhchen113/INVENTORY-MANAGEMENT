-- ============================================================
-- Brand catalog refactor — Phase 3: lockdown + drop redundant per-store columns
--
-- Locks in the new schema by:
--  1. NOT NULL on the brand_id / catalog_id FKs that Phase 2 backfilled.
--  2. Adding new unique constraints (brand-level recipe uniqueness,
--     per-store inventory uniqueness, brand-level conversions).
--  3. Dropping the redundant per-store columns now that the app code
--     (Phase 4) reads catalog_ingredients / brand_id / catalog_id only.
--
-- ⚠️ This is the breaking phase for any code still reading old columns.
-- Run only after the Phase 4 commit (57a7821) is in place — verified
-- locally with the running app working against this state.
--
-- See plan: 2-brand-catalog-refactor.md.
-- ============================================================

-- ─── 1. NOT NULL on backfilled FK columns ───────────────────
alter table public.stores            alter column brand_id   set not null;
alter table public.vendors           alter column brand_id   set not null;
alter table public.recipes           alter column brand_id   set not null;
alter table public.prep_recipes      alter column brand_id   set not null;
alter table public.inventory_items   alter column catalog_id set not null;
alter table public.recipe_ingredients alter column catalog_id set not null;
alter table public.ingredient_conversions alter column catalog_id set not null;

-- prep_recipe_ingredients — catalog_id is NULL for type='prep' rows
-- (sub-recipe references) by design. Use a CHECK constraint so every
-- row has at least one of catalog_id / sub_recipe_id populated.
alter table public.prep_recipe_ingredients
  add constraint prep_ri_catalog_or_subrecipe_check
  check ((catalog_id is not null) or (sub_recipe_id is not null));

-- ─── 2. New unique constraints ──────────────────────────────
-- recipes: brand-level menu_item uniqueness replaces the per-store one.
drop index if exists public.recipes_menu_item_store_id_unique;
alter table public.recipes
  add constraint recipes_brand_menu_item_unique unique (brand_id, menu_item);

-- inventory_items: prevent duplicate catalog rows per store.
alter table public.inventory_items
  add constraint inventory_items_store_catalog_unique unique (store_id, catalog_id);

-- ingredient_conversions: brand-level uniqueness on (catalog_id, purchase_unit).
alter table public.ingredient_conversions
  drop constraint if exists ingredient_conversions_inventory_item_id_purchase_unit_key;
alter table public.ingredient_conversions
  add constraint ingredient_conversions_catalog_purchase_unit_unique
  unique (catalog_id, purchase_unit);

-- ─── 3. Drop redundant per-store columns ────────────────────
-- recipes/prep_recipes — store_id no longer scopes them.
alter table public.recipes      drop column store_id;
alter table public.prep_recipes drop column store_id;

-- inventory_items — catalog fields now live on catalog_ingredients.
-- Per-store fields (cost_per_unit, case_price, par_level, current_stock,
-- vendor_id, eod_remaining, etc.) stay.
alter table public.inventory_items drop column name;
alter table public.inventory_items drop column unit;
alter table public.inventory_items drop column category;
alter table public.inventory_items drop column case_qty;
alter table public.inventory_items drop column sub_unit_size;
alter table public.inventory_items drop column sub_unit_unit;

-- recipe_ingredients / prep_recipe_ingredients — catalog_id replaces item_id.
-- The ON DELETE CASCADE FK on item_id goes away with the column; on the
-- catalog_id side, leaving the default NO ACTION is intentional —
-- deleting a catalog ingredient that's still referenced should fail
-- loudly rather than silently nuking recipe lines.
alter table public.recipe_ingredients      drop column item_id;
alter table public.prep_recipe_ingredients drop column item_id;

-- ingredient_conversions — catalog_id replaces inventory_item_id.
alter table public.ingredient_conversions drop column inventory_item_id;

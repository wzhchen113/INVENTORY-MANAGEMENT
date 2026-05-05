-- ============================================================
-- prep_recipes: partial unique index on (brand_id, lower(name))
-- WHERE is_current = true.
--
-- Why: P3 added recipes_brand_menu_item_unique on `recipes` but
-- left `prep_recipes` without a unique constraint. Combined with
-- the fire-and-forget Zustand pattern, that lets retries pile up
-- duplicate is_current=true rows. Partial index so version-history
-- rows (is_current = false) still coexist freely.
--
-- ⚠️ Deploy order: this MUST run AFTER any production dedup pass
-- (admin_dedupe_prep_recipes from the previous migration) — it
-- will fail outright if existing hard duplicates exist. Confirm
-- prep_groups with current_count > 1 is empty in the inspector
-- before pushing this to prod.
-- ============================================================

create unique index if not exists prep_recipes_brand_name_current_unique
  on public.prep_recipes (brand_id, lower(name))
  where is_current = true;

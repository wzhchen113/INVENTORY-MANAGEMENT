-- ============================================================
-- Fix cross-store inventory_item references in prep_recipe_ingredients
--
-- Background: 472 of 639 prep_recipe_ingredients rows in prod (~74%)
-- had their item_id pointing at an inventory_item belonging to a
-- different store than the parent prep_recipe. Surfaced 2026-05-03 by
-- browsing real prod data in the local stack; audit script preserved at
-- supabase/scripts/audit-prep-ingredient-leaks.sql.
--
-- Likely cause: the app's "Duplicate prep recipe" flow copied ingredient
-- lines verbatim without remapping item_id to the destination store's
-- equivalent inventory item. Stock deductions for those recipes drained
-- the wrong store's inventory.
--
-- This migration remaps every cross-store leak to the same-name
-- inventory_item in the prep_recipe's own store. Pre-flight validated
-- locally: all 472 leaks have a same-name equivalent in the target
-- store, so the remap is unambiguous (auto_remappable=472, manual=0).
--
-- IMPORTANT: ship the app-side fix to the duplicate flow BEFORE
-- pushing this migration to prod — otherwise new leaks will be created
-- by subsequent duplicates and re-rot the data within hours.
-- ============================================================

begin;

-- Capture before-state for transparency in `db push` output.
do $$
declare
  v_before int;
begin
  select count(*) into v_before
  from public.prep_recipe_ingredients pri
  join public.prep_recipes pr on pr.id = pri.prep_recipe_id
  join public.inventory_items ii on ii.id = pri.item_id
  where ii.store_id <> pr.store_id;
  raise notice '[fix-leaks] before: % cross-store leaks to fix', v_before;
end $$;

-- The fix: for each leak, find the same-name inventory_item in the
-- prep_recipe's own store and rewrite item_id. Idempotent — re-running
-- this migration on a clean DB is a no-op (the WHERE clause yields no
-- rows when there's nothing to fix).
update public.prep_recipe_ingredients pri
set item_id = remap.target_id
from (
  select
    pri2.id          as line_id,
    target.id        as target_id
  from public.prep_recipe_ingredients pri2
  join public.prep_recipes pr        on pr.id = pri2.prep_recipe_id
  join public.inventory_items src    on src.id = pri2.item_id
  join public.inventory_items target on target.store_id = pr.store_id
                                     and target.name = src.name
  where src.store_id <> pr.store_id
) as remap
where pri.id = remap.line_id;

-- Verify after-state. Fail the migration if any leak remains.
do $$
declare
  v_after int;
begin
  select count(*) into v_after
  from public.prep_recipe_ingredients pri
  join public.prep_recipes pr on pr.id = pri.prep_recipe_id
  join public.inventory_items ii on ii.id = pri.item_id
  where ii.store_id <> pr.store_id;
  raise notice '[fix-leaks] after: % cross-store leaks remaining', v_after;
  if v_after > 0 then
    raise exception 'Migration failed: % cross-store leaks remain', v_after;
  end if;
end $$;

commit;

-- ────────────────────────────────────────────────────────────
-- Deliberately out of scope for this migration:
--
-- 1. Orphan ingredient lines (~20 in prod): rows where item_id points
--    to an inventory_item UUID that no longer exists in the table.
--    Likely the items were renamed or replaced. Needs a human to pick
--    the new equivalent — out of scope here.
--
-- 2. DB-level enforcement to prevent future cross-store leaks. Postgres
--    CHECK constraints can't reference other tables, so this would
--    require a row-level trigger on insert/update of
--    prep_recipe_ingredients. Sketched separately and intentionally
--    NOT applied here — the trigger would block the (still-buggy) app
--    duplicate flow with a hard error and break user workflows. Add it
--    in a follow-up migration AFTER the app fix has shipped.
-- ────────────────────────────────────────────────────────────

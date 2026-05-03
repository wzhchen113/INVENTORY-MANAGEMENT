-- ============================================================
-- Audit: cross-store inventory_item references in prep_recipes
--
-- Background: prep_recipe_ingredients.item_id occasionally points at
-- an inventory_item belonging to a *different* store than the
-- prep_recipe itself. Discovered ~74% of rows affected (472/639) in
-- prod via local-mirror inspection on 2026-05-03.
--
-- Most likely cause: the app's "Duplicate prep recipe" flow copies
-- ingredient lines verbatim instead of remapping item_id to the
-- destination store's equivalent ingredient.
--
-- This script is READ-ONLY. It only runs SELECT statements; no UPDATE,
-- DELETE, or DDL. Safe to paste into Supabase Dashboard → SQL Editor
-- against prod, or run locally via:
--   docker exec supabase_db_imr-inventory psql -U postgres -d postgres \
--     -f /path/to/this/file
-- ============================================================

\echo
\echo '=== 1. Per-store summary: how many prep_recipes / ingredient lines leak ==='
\echo
select
  s.name                                              as prep_store,
  count(distinct pr.id) filter (where ii.store_id <> pr.store_id and ii.id is not null)
                                                      as recipes_with_leaks,
  count(distinct pr.id)                               as recipes_total,
  count(*) filter (where ii.store_id <> pr.store_id and ii.id is not null)
                                                      as leaked_lines,
  count(*)                                            as lines_total,
  count(*) filter (where ii.id is null)               as orphaned_lines  -- item_id points nowhere
from public.prep_recipes pr
join public.stores s on s.id = pr.store_id
left join public.prep_recipe_ingredients pri on pri.prep_recipe_id = pr.id
left join public.inventory_items ii on ii.id = pri.item_id
group by s.name
order by leaked_lines desc nulls last;

\echo
\echo '=== 2. Where do the leaks point? (prep store -> referenced item store) ==='
\echo
select
  ps.name                          as prep_store,
  iis.name                         as referenced_item_store,
  count(*)                         as leaked_lines,
  count(distinct pri.prep_recipe_id) as prep_recipes_affected
from public.prep_recipe_ingredients pri
join public.prep_recipes pr on pr.id = pri.prep_recipe_id
join public.inventory_items ii on ii.id = pri.item_id
join public.stores ps on ps.id = pr.store_id
join public.stores iis on iis.id = ii.store_id
where ii.store_id <> pr.store_id
group by ps.name, iis.name
order by ps.name, leaked_lines desc;

\echo
\echo '=== 3. Auto-remap viability: how many leaks have a same-name item in the correct store? ==='
\echo
with leak as (
  select pri.id as line_id, pr.store_id as target_store, ii.name as item_name
  from public.prep_recipe_ingredients pri
  join public.prep_recipes pr on pr.id = pri.prep_recipe_id
  join public.inventory_items ii on ii.id = pri.item_id
  where ii.store_id <> pr.store_id
)
select
  count(*) filter (where exists (
    select 1 from public.inventory_items ii2
    where ii2.store_id = leak.target_store and ii2.name = leak.item_name
  ))                                                  as auto_remappable,
  count(*) filter (where not exists (
    select 1 from public.inventory_items ii2
    where ii2.store_id = leak.target_store and ii2.name = leak.item_name
  ))                                                  as needs_manual_review,
  count(*)                                            as total_leaks
from leak;

\echo
\echo '=== 4. Items with no same-name equivalent in the target store (manual review needed) ==='
\echo
select
  ps.name                          as prep_store,
  pr.name                          as prep_recipe,
  pr.version                       as v,
  ii.name                          as referenced_item_name,
  iis.name                         as referenced_item_store,
  pri.quantity, pri.unit
from public.prep_recipe_ingredients pri
join public.prep_recipes pr on pr.id = pri.prep_recipe_id
join public.inventory_items ii on ii.id = pri.item_id
join public.stores ps on ps.id = pr.store_id
join public.stores iis on iis.id = ii.store_id
where ii.store_id <> pr.store_id
  and not exists (
    select 1 from public.inventory_items ii2
    where ii2.store_id = pr.store_id and ii2.name = ii.name
  )
order by ps.name, pr.name, pr.version
limit 50;

\echo
\echo '=== 5. Worst-offender prep_recipes (most leaked ingredient lines) ==='
\echo
select
  ps.name                          as prep_store,
  pr.name                          as prep_recipe,
  pr.version                       as v,
  pr.is_current                    as current,
  count(*)                         as leaked_lines,
  count(*) filter (where exists (
    select 1 from public.inventory_items ii2
    where ii2.store_id = pr.store_id and ii2.name = ii.name
  ))                               as auto_remappable,
  count(distinct iis.name)         as distinct_source_stores
from public.prep_recipe_ingredients pri
join public.prep_recipes pr on pr.id = pri.prep_recipe_id
join public.inventory_items ii on ii.id = pri.item_id
join public.stores ps on ps.id = pr.store_id
join public.stores iis on iis.id = ii.store_id
where ii.store_id <> pr.store_id
group by ps.name, pr.id, pr.name, pr.version, pr.is_current
order by leaked_lines desc, prep_store, prep_recipe
limit 20;

\echo
\echo '=== 6. Stock-deduction blast radius: which prod inventory items are pointed at by other stores? ==='
\echo '(These are the items whose stock would be wrongly deducted when another store sells a recipe.)'
\echo
select
  iis.name                         as wrongly_deducted_from_store,
  ii.name                          as item_name,
  count(*)                         as foreign_recipes_pointing_at_it,
  count(distinct pr.store_id)      as distinct_originating_stores
from public.prep_recipe_ingredients pri
join public.prep_recipes pr on pr.id = pri.prep_recipe_id
join public.inventory_items ii on ii.id = pri.item_id
join public.stores iis on iis.id = ii.store_id
where ii.store_id <> pr.store_id
group by iis.name, ii.id, ii.name
order by foreign_recipes_pointing_at_it desc
limit 20;

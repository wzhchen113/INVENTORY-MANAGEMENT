-- supabase/tests/report_reorder_list_hybrid_formula.test.sql
--
-- Spec 023 / A10 — retroactive coverage for spec 021's hybrid
-- `suggested_qty = max(par_replacement, usage_forecasted)` formula at
-- `supabase/migrations/20260514130000_report_reorder_list.sql:445-453`:
--
--   par_replacement  = max(0, par_level - on_hand - pending_po_qty)
--   usage_forecasted = max(0, usage_per_portion * qty_per_day
--                              * days_until_next_delivery
--                              - on_hand - pending_po_qty)
--   suggested_qty    = greatest(par_replacement, usage_forecasted)
--
-- Three scenarios pinned (per architect §1 / A10):
--   Item 1 (par-only):    par=10, usage_per_portion=0 → suggested=10.
--   Item 2 (usage-only):  par=0,  usage_per_portion=1, sales=1/day,
--                         days_until=7 → usage_forecasted=7,
--                         par_repl=0 → suggested=7.
--   Item 3 (both):        par=20, usage_per_portion=1, sales=1/day,
--                         days_until=7 → par_repl=20, usage_fc=7 →
--                         suggested=max(20,7)=20.
--
-- Days_until=7 is the no-schedule fallback (A5 default).
--
-- Architect's caveat (A10 fixture complexity): seeding recipes + sales
-- is the heaviest test in the set. To keep the math controlled and
-- avoid contamination from seed pos_imports inside the trailing 7-day
-- window, this test INSERTS its own catalog_ingredients +
-- inventory_items + recipes + recipe_ingredients + pos_imports +
-- pos_import_items inside the transaction. The rollback discards
-- everything.

begin;
create extension if not exists pgtap;

select plan(5);

-- ─── fixtures ──────────────────────────────────────────────────
-- Resolve Frederick + brand + a vendor with items in Frederick.
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick  uuid;
  v_brand_id   uuid;
  v_vendor_id  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_brand_id  from public.brands  limit 1;

  -- Pick any vendor with at least one item in Frederick — guarantees
  -- the vendor_delivery_offsets CTE's EXISTS pre-filter accepts it.
  select v.id into v_vendor_id
    from public.vendors v
   where exists (
     select 1 from public.inventory_items ii
      where ii.store_id = v_frederick and ii.vendor_id = v.id
   )
   order by v.id asc
   limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
  perform set_config('test.vendor_id',    v_vendor_id::text,  true);
end $$;

select isnt(current_setting('test.brand_id', true), '',
  'fixture: brand + Frederick + vendor resolve from seed');

-- ─── master JWT — privileged for catalog + recipes mutations ───
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.master_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'master')
  )::text,
  true
);

-- Lock the schedule to "no rows" → days_until_next_delivery = 7.
delete from public.order_schedule
 where store_id  = current_setting('test.frederick_id', true)::uuid
   and vendor_id = current_setting('test.vendor_id',    true)::uuid;

-- Three fresh catalog_ingredients (random names to side-step the
-- (brand, lower(name)) UNIQUE if the test re-runs without rollback).
create temp table _catalog on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  values
    (current_setting('test.brand_id', true)::uuid,
     'SPEC023-A10-PAR-'||gen_random_uuid()::text, 'ea'),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC023-A10-USAGE-'||gen_random_uuid()::text, 'ea'),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC023-A10-BOTH-'||gen_random_uuid()::text, 'ea')
  returning id, name
)
select id, name,
       case
         when name like 'SPEC023-A10-PAR%'   then 'par'
         when name like 'SPEC023-A10-USAGE%' then 'usage'
         else 'both'
       end as kind
  from ins;

do $$
declare
  v_par   uuid;
  v_usage uuid;
  v_both  uuid;
begin
  select id into v_par   from _catalog where kind = 'par'   limit 1;
  select id into v_usage from _catalog where kind = 'usage' limit 1;
  select id into v_both  from _catalog where kind = 'both'  limit 1;
  perform set_config('test.cat_par',   v_par::text,   true);
  perform set_config('test.cat_usage', v_usage::text, true);
  perform set_config('test.cat_both',  v_both::text,  true);
end $$;

-- Three inventory_items (one per catalog), all in Frederick under
-- the chosen vendor.
create temp table _items_seed on commit drop as
with ins as (
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.cat_par',      true)::uuid,
     current_setting('test.vendor_id',    true)::uuid,
     1, 0, 10, 0),
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.cat_usage',    true)::uuid,
     current_setting('test.vendor_id',    true)::uuid,
     1, 0, 0,  1),
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.cat_both',     true)::uuid,
     current_setting('test.vendor_id',    true)::uuid,
     1, 0, 20, 1)
  returning id, catalog_id
)
select id, catalog_id from ins;

do $$
declare
  v_par   uuid;
  v_usage uuid;
  v_both  uuid;
begin
  select id into v_par   from _items_seed where catalog_id = current_setting('test.cat_par',   true)::uuid;
  select id into v_usage from _items_seed where catalog_id = current_setting('test.cat_usage', true)::uuid;
  select id into v_both  from _items_seed where catalog_id = current_setting('test.cat_both',  true)::uuid;
  perform set_config('test.item_par',   v_par::text,   true);
  perform set_config('test.item_usage', v_usage::text, true);
  perform set_config('test.item_both',  v_both::text,  true);
end $$;

-- Spec 102 — the reorder RPC now explodes items to vendors via the
-- `item_vendors` junction, NOT the scalar inventory_items.vendor_id. The
-- backfill creates one primary link per vendor-bearing item; these
-- in-transaction test items did not exist when the backfill ran, so we
-- must insert their links explicitly (mirroring the backfill: is_primary,
-- carrying the item's per-vendor cost). Without this, the items produce
-- no reorder rows.
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
select isd.id, current_setting('test.vendor_id', true)::uuid, ii.cost_per_unit, ii.case_price, true
  from _items_seed isd
  join public.inventory_items ii on ii.id = isd.id
on conflict (item_id, vendor_id) do nothing;

-- Two recipes (one for usage item, one for both item — the par item
-- is intentionally not linked to any recipe).
create temp table _recipes on commit drop as
with ins as (
  insert into public.recipes (brand_id, menu_item, sell_price)
  values
    (current_setting('test.brand_id', true)::uuid,
     'SPEC023-A10-MENU-USAGE-'||gen_random_uuid()::text, 0),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC023-A10-MENU-BOTH-'||gen_random_uuid()::text, 0)
  returning id, menu_item
)
select id, menu_item,
       case when menu_item like 'SPEC023-A10-MENU-USAGE%' then 'usage' else 'both' end as kind
  from ins;

do $$
declare
  v_usage uuid;
  v_both  uuid;
begin
  select id into v_usage from _recipes where kind = 'usage' limit 1;
  select id into v_both  from _recipes where kind = 'both'  limit 1;
  perform set_config('test.recipe_usage', v_usage::text, true);
  perform set_config('test.recipe_both',  v_both::text,  true);
end $$;

-- One recipe_ingredients row per recipe linking to its dedicated
-- catalog. quantity = 1 so qty_per_recipe = 1.
insert into public.recipe_ingredients (recipe_id, catalog_id, quantity, unit)
values
  (current_setting('test.recipe_usage', true)::uuid,
   current_setting('test.cat_usage',    true)::uuid, 1, 'ea'),
  (current_setting('test.recipe_both',  true)::uuid,
   current_setting('test.cat_both',     true)::uuid, 1, 'ea');

-- ─── Switch to manager JWT for pos_imports + pos_import_items ─
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- pos_imports row inside the trailing 7-day window. import_date =
-- current_date so it matches the report's as_of_date = today.
create temp table _pos on commit drop as
with ins as (
  insert into public.pos_imports (store_id, filename, import_date)
  values (current_setting('test.frederick_id', true)::uuid,
          'spec-023-A10.csv',
          current_date)
  returning id
)
select id from ins;

do $$
declare v_id uuid;
begin
  select id into v_id from _pos limit 1;
  perform set_config('test.pos_id', v_id::text, true);
end $$;

-- One pos_import_items row per recipe. qty_sold = 7 → divided by 7
-- → qty_per_day = 1. With usage_per_portion = 1 and days_until = 7,
-- usage_forecasted = 1 * 1 * 7 = 7.
insert into public.pos_import_items (import_id, menu_item, qty_sold, recipe_id, recipe_mapped)
values
  (current_setting('test.pos_id',       true)::uuid,
   'TEST USAGE', 7,
   current_setting('test.recipe_usage', true)::uuid,
   true),
  (current_setting('test.pos_id',       true)::uuid,
   'TEST BOTH',  7,
   current_setting('test.recipe_both',  true)::uuid,
   true);

-- ─── Call the runner with as_of_date = today ──────────────────
create temp table _env on commit drop as
select public.report_reorder_list(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
) as env;

-- Pull the vendor's items[] for the test vendor.
create temp table _items_out on commit drop as
select i->>'item_id' as item_id,
       i as item
  from _env, jsonb_array_elements(env->'vendors') v
            , jsonb_array_elements(v->'items') i
 where v->>'vendor_id' = current_setting('test.vendor_id', true);

-- ─── (1) Item 1 (par-only): suggested_qty = par_replacement = 10
select is(
  ((select item from _items_out where item_id = current_setting('test.item_par', true))->>'suggested_qty')::numeric,
  10::numeric,
  'item 1 (par-only): suggested = par_replacement = par - on_hand = 10'
);

-- ─── (2) Item 2 (usage-only): suggested_qty = usage_forecasted = 7
select is(
  ((select item from _items_out where item_id = current_setting('test.item_usage', true))->>'suggested_qty')::numeric,
  7::numeric,
  'item 2 (usage-only): suggested = usage_forecasted = 1 * 1 * 7 = 7'
);

-- ─── (3) Item 3 (both): suggested = max(par_repl=20, usage_fc=7) = 20
select is(
  ((select item from _items_out where item_id = current_setting('test.item_both', true))->>'suggested_qty')::numeric,
  20::numeric,
  'item 3 (both): suggested = max(par_repl=20, usage_fc=7) = 20'
);

-- ─── (4) Sanity: item 1 picked par_replacement path (usage_fc=0)
select is(
  ((select item from _items_out where item_id = current_setting('test.item_par', true))->>'usage_forecasted')::numeric,
  0::numeric,
  'item 1: usage_forecasted = 0 (no recipe link → no sales signal)'
);

select * from finish();
rollback;

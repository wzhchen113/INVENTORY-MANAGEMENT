-- supabase/tests/report_reorder_list_cases.test.sql
--
-- Spec 088 — Reorder "Suggested" shown in cases for case-based items.
--
-- Pins the additive `create or replace` of `report_reorder_list` in
-- supabase/migrations/20260602000000_reorder_suggested_cases.sql
-- (Decision B: the server rounds the cost to the whole-case order):
--
--   per_item:          coalesce(ci.case_qty, 1)::numeric as case_qty
--   per_item_filtered: suggested_cases = ceil(suggested_qty / case_qty)
--                        when case_qty > 1, else NULL
--                      estimated_cost  = ceil(.../case_qty)*case_qty
--                        *cost_per_unit when case_qty > 1, else
--                        suggested_qty*cost_per_unit (unchanged)
--   per-item JSON:     adds case_qty / suggested_cases / suggested_units
--
-- Five scenarios pinned:
--   Item CASE  (case_qty=24, par=49 → suggested_qty=49):
--       suggested_cases=3, suggested_units=72, case_qty=24,
--       estimated_cost = 72*1 = 72 (WHOLE-CASE, not 49).
--   Item EXACT (case_qty=24, par=48 → suggested_qty=48):
--       suggested_cases=2, suggested_units=48, estimated_cost=48
--       (exact multiple → no spurious +1).
--   Item PLAIN (case_qty=1 default, par=10 → suggested_qty=10):
--       suggested_cases is JSON null, case_qty=1, estimated_cost=10
--       (= suggested_qty*cost_per_unit — base-unit behavior UNCHANGED).
--   Rollup:    vendor_total_cost == sum of the (rounded) per-item
--              estimated_cost across the seeded vendor's items[] (pins
--              the rollup inheritance; robust to any seed items already
--              under the chosen vendor).
--
-- Driver: usage_per_portion=0 (item linked to no recipe) → no sales
-- signal → usage_forecasted=0, and current_stock=0 → par_replacement =
-- par_level, so suggested_qty = greatest(par_level, 0) = par_level.
-- No order_schedule rows → days_until_next_delivery = 7 (A5 default);
-- the value is irrelevant here because usage_forecasted is 0 regardless.
-- cost_per_unit = 1 so estimated_cost reads as the ordered base-unit
-- total in dollars.
--
-- Fixtures are inserted inside the transaction (own catalog_ingredients
-- with explicit case_qty + own inventory_items); the rollback discards
-- everything so the seed is untouched. No `set role anon` (segfaults CI
-- per spec 067). The grant is NOT touched by the migration (signature
-- byte-identical), so there is intentionally NO has_function_privilege
-- assertion. Master-JWT pattern mirrors
-- report_reorder_list_hybrid_formula.test.sql.

begin;
create extension if not exists pgtap;

select plan(12);

-- ─── fixtures ──────────────────────────────────────────────────
-- Resolve Frederick + brand + a vendor that already has items in
-- Frederick (guarantees the vendor_delivery_offsets EXISTS pre-filter
-- accepts it).
do $$
declare
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick  uuid;
  v_brand_id   uuid;
  v_vendor_id  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_brand_id  from public.brands  limit 1;

  select v.id into v_vendor_id
    from public.vendors v
   where exists (
     select 1 from public.inventory_items ii
      where ii.store_id = v_frederick and ii.vendor_id = v.id
   )
   order by v.id asc
   limit 1;

  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
  perform set_config('test.vendor_id',    v_vendor_id::text,  true);
end $$;

select isnt(current_setting('test.vendor_id', true), '',
  'fixture: brand + Frederick + a vendor-with-items resolve from seed');

-- ─── master JWT — privileged for catalog + inventory mutations ──
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

-- Three fresh catalog_ingredients with EXPLICIT case_qty. Random names
-- side-step the (brand, lower(name)) UNIQUE on re-run without rollback.
--   CASE  → case_qty 24 (case-size item; drive par=49)
--   EXACT → case_qty 24 (case-size item; drive par=48, exact multiple)
--   PLAIN → case_qty 1  (default / no case size; base-unit unchanged)
create temp table _catalog on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty)
  values
    (current_setting('test.brand_id', true)::uuid,
     'SPEC088-CASE-'||gen_random_uuid()::text,  'each', 24),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC088-EXACT-'||gen_random_uuid()::text, 'each', 24),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC088-PLAIN-'||gen_random_uuid()::text, 'each', 1)
  returning id, name
)
select id, name,
       case
         when name like 'SPEC088-CASE%'  then 'case'
         when name like 'SPEC088-EXACT%' then 'exact'
         else 'plain'
       end as kind
  from ins;

do $$
declare
  v_case  uuid;
  v_exact uuid;
  v_plain uuid;
begin
  select id into v_case  from _catalog where kind = 'case'  limit 1;
  select id into v_exact from _catalog where kind = 'exact' limit 1;
  select id into v_plain from _catalog where kind = 'plain' limit 1;
  perform set_config('test.cat_case',  v_case::text,  true);
  perform set_config('test.cat_exact', v_exact::text, true);
  perform set_config('test.cat_plain', v_plain::text, true);
end $$;

-- Three inventory_items (one per catalog), all in Frederick under the
-- chosen vendor. cost_per_unit=1, current_stock=0, usage_per_portion=0.
-- par_level drives suggested_qty: CASE→49, EXACT→48, PLAIN→10.
create temp table _items_seed on commit drop as
with ins as (
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.cat_case',     true)::uuid,
     current_setting('test.vendor_id',    true)::uuid,
     1, 0, 49, 0),
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.cat_exact',    true)::uuid,
     current_setting('test.vendor_id',    true)::uuid,
     1, 0, 48, 0),
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.cat_plain',    true)::uuid,
     current_setting('test.vendor_id',    true)::uuid,
     1, 0, 10, 0)
  returning id, catalog_id
)
select id, catalog_id from ins;

do $$
declare
  v_case  uuid;
  v_exact uuid;
  v_plain uuid;
begin
  select id into v_case  from _items_seed where catalog_id = current_setting('test.cat_case',  true)::uuid;
  select id into v_exact from _items_seed where catalog_id = current_setting('test.cat_exact', true)::uuid;
  select id into v_plain from _items_seed where catalog_id = current_setting('test.cat_plain', true)::uuid;
  perform set_config('test.item_case',  v_case::text,  true);
  perform set_config('test.item_exact', v_exact::text, true);
  perform set_config('test.item_plain', v_plain::text, true);
end $$;

-- ─── Call the runner with as_of_date = today ──────────────────
create temp table _env on commit drop as
select public.report_reorder_list(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
) as env;

-- Pull the seeded vendor's items[].
create temp table _items_out on commit drop as
select i->>'item_id' as item_id,
       i as item
  from _env, jsonb_array_elements(env->'vendors') v
            , jsonb_array_elements(v->'items') i
 where v->>'vendor_id' = current_setting('test.vendor_id', true);

-- ─── (1) CASE item — suggested_cases = ceil(49/24) = 3 ───────────
select is(
  ((select item from _items_out where item_id = current_setting('test.item_case', true))->>'suggested_cases')::numeric,
  3::numeric,
  'case item: suggested_cases = ceil(49/24) = 3'
);

-- ─── (2) CASE item — suggested_units = 3*24 = 72 (ordered base) ──
select is(
  ((select item from _items_out where item_id = current_setting('test.item_case', true))->>'suggested_units')::numeric,
  72::numeric,
  'case item: suggested_units = 3 cases * 24 = 72'
);

-- ─── (3) CASE item — case_qty passthrough = 24 ───────────────────
select is(
  ((select item from _items_out where item_id = current_setting('test.item_case', true))->>'case_qty')::numeric,
  24::numeric,
  'case item: case_qty exposed = 24'
);

-- ─── (4) CASE item — estimated_cost is WHOLE-CASE (72*1), not 49 ──
select is(
  ((select item from _items_out where item_id = current_setting('test.item_case', true))->>'estimated_cost')::numeric,
  72::numeric,
  'case item: estimated_cost = ceil(49/24)*24*1 = 72 (whole-case, NOT 49)'
);

-- ─── (5) EXACT-multiple item — suggested_cases = 48/24 = 2 ───────
select is(
  ((select item from _items_out where item_id = current_setting('test.item_exact', true))->>'suggested_cases')::numeric,
  2::numeric,
  'exact-multiple item: suggested_cases = ceil(48/24) = 2 (no spurious +1)'
);

-- ─── (6) EXACT item — suggested_units = 48 ───────────────────────
select is(
  ((select item from _items_out where item_id = current_setting('test.item_exact', true))->>'suggested_units')::numeric,
  48::numeric,
  'exact-multiple item: suggested_units = 2 cases * 24 = 48'
);

-- ─── (7) EXACT item — estimated_cost = 48*1 = 48 ─────────────────
select is(
  ((select item from _items_out where item_id = current_setting('test.item_exact', true))->>'estimated_cost')::numeric,
  48::numeric,
  'exact-multiple item: estimated_cost = 2*24*1 = 48'
);

-- ─── (8) PLAIN item — suggested_cases is JSON null (case_qty<=1) ──
select ok(
  (select item from _items_out where item_id = current_setting('test.item_plain', true))->'suggested_cases' = 'null'::jsonb,
  'plain item (case_qty=1): suggested_cases is JSON null'
);

-- ─── (9) PLAIN item — case_qty exposed = 1 ───────────────────────
select is(
  ((select item from _items_out where item_id = current_setting('test.item_plain', true))->>'case_qty')::numeric,
  1::numeric,
  'plain item: case_qty exposed = 1'
);

-- ─── (10) PLAIN item — estimated_cost UNCHANGED = suggested_qty*cpu = 10
select is(
  ((select item from _items_out where item_id = current_setting('test.item_plain', true))->>'estimated_cost')::numeric,
  10::numeric,
  'plain item: estimated_cost = suggested_qty*cost_per_unit = 10 (base-unit unchanged)'
);

-- ─── (11) ROLLUP — vendor_total_cost == sum of per-item estimated_cost
-- Pins that the rounded per-item cost flows into vendor_total_cost.
-- Compared against the SUM of the returned items' estimated_cost, so it
-- holds regardless of any seed items already under this vendor.
select is(
  (select (v->>'vendor_total_cost')::numeric
     from _env, jsonb_array_elements(env->'vendors') v
    where v->>'vendor_id' = current_setting('test.vendor_id', true)),
  (select coalesce(sum((item->>'estimated_cost')::numeric), 0) from _items_out),
  'vendor_total_cost == sum of the (case-rounded) per-item estimated_cost'
);

select * from finish();
rollback;

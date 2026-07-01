-- supabase/tests/report_reorder_list_per_each_cost.test.sql
--
-- Spec 104 — Per-each (smallest-unit) cost basis rework.
--
-- Guards the OQ-1 server reorder-math change: after the basis flip,
-- inventory_items.cost_per_unit / item_vendors.cost_per_unit are per-EACH, and
-- report_reorder_list multiplies estimated_cost by pis.sub_unit_size on BOTH
-- branches (Hunk 2 in 20260701000000_spec104_per_each_cost_basis.sql) so the
-- dollar total stays numerically IDENTICAL to the pre-spec figure per (★):
--
--     cost_old (per counted unit) = cost_new (per each) × sub_unit_size
--
-- Two things are pinned:
--   (A) reorder estimated_cost / vendor_total_cost for seeded fixtures equal
--       the PRE-FLIP figure (computed independently as suggested_qty-in-counted
--       -units × cost_old), for BOTH a case-size item (case_qty > 1) and a
--       high-sub_unit_size packaging item (case_qty = 1, sub_unit_size = 500).
--   (B) the direct (★)-inverse round-trip: for a fixture row stored on the
--       per-each basis, cost_per_unit × sub_unit_size reconstructs the intended
--       cost_old.
--
-- TOLERANCE (spec 104 §1/§4/§8 R7): the per-each value stored at numeric(12,6)
-- reconstructs cost_old to ~$0.001, not to the full numeric mantissa, so the
-- dollar assertions use a CENT-level epsilon (abs(got - expected) < 0.01), NOT
-- byte-exact numeric equality — a byte-exact assert would flake on fine-grained
-- items. The fixtures here are chosen to terminate exactly, but the epsilon
-- keeps the test robust to the general case.
--
-- Fixtures mirror report_reorder_list_cases.test.sql exactly: own
-- catalog_ingredients (explicit case_qty + sub_unit_size), own inventory_items,
-- own item_vendors PRIMARY links (the reorder RPC explodes by the junction, not
-- the scalar vendor_id — spec 102 — so the in-transaction items MUST insert
-- their links or they produce no reorder rows). No `set role anon` (segfaults CI
-- per spec 067). Master-JWT pattern. begin/rollback so the seed is untouched.

begin;
create extension if not exists pgtap;

select plan(6);

-- ─── fixtures ──────────────────────────────────────────────────
-- Resolve Frederick + brand + a vendor that already has items in Frederick
-- (guarantees the vendor_delivery_offsets EXISTS pre-filter accepts it).
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

-- Lock the schedule to "no rows" → days_until_next_delivery = 7 (irrelevant
-- here: usage_forecasted = 0 so suggested_qty = par_replacement = par_level).
delete from public.order_schedule
 where store_id  = current_setting('test.frederick_id', true)::uuid
   and vendor_id = current_setting('test.vendor_id',    true)::uuid;

-- Two fresh catalog_ingredients with EXPLICIT case_qty + sub_unit_size:
--   CASEBOX → case_qty 24, sub_unit_size 10  (case-size item, drive par=49)
--   PKG     → case_qty 1,  sub_unit_size 500 (packaging item, drive par=10)
-- Random names side-step the (brand, lower(name)) UNIQUE on re-run.
create temp table _catalog on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size)
  values
    (current_setting('test.brand_id', true)::uuid,
     'SPEC104-CASEBOX-'||gen_random_uuid()::text, 'each', 24, 10),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC104-PKG-'||gen_random_uuid()::text,     'each', 1,  500)
  returning id, name
)
select id, name,
       case when name like 'SPEC104-CASEBOX%' then 'casebox' else 'pkg' end as kind
  from ins;

do $$
declare
  v_casebox uuid;
  v_pkg     uuid;
begin
  select id into v_casebox from _catalog where kind = 'casebox' limit 1;
  select id into v_pkg     from _catalog where kind = 'pkg'     limit 1;
  perform set_config('test.cat_casebox', v_casebox::text, true);
  perform set_config('test.cat_pkg',     v_pkg::text,     true);
end $$;

-- Two inventory_items — cost_per_unit is stored on the PER-EACH basis (the
-- post-spec-104 basis). Under (★) the pre-flip counted-unit cost (cost_old) is
-- cost_per_unit × sub_unit_size:
--   CASEBOX: per-each 0.25, sub 10 → cost_old = 2.50 (per counted unit)
--   PKG:     per-each 0.10, sub 500 → cost_old = 50.00 (per counted unit)
-- current_stock=0, usage_per_portion=0 → suggested_qty = par_level.
--   CASEBOX par=49 → suggested_qty=49 → 3 cases × 24 = 72 counted units ordered
--   PKG     par=10 → suggested_qty=10 counted units ordered
create temp table _items_seed on commit drop as
with ins as (
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.cat_casebox',  true)::uuid,
     current_setting('test.vendor_id',    true)::uuid,
     0.25, 0, 49, 0),
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.cat_pkg',      true)::uuid,
     current_setting('test.vendor_id',    true)::uuid,
     0.10, 0, 10, 0)
  returning id, catalog_id
)
select id, catalog_id from ins;

do $$
declare
  v_casebox uuid;
  v_pkg     uuid;
begin
  select id into v_casebox from _items_seed where catalog_id = current_setting('test.cat_casebox', true)::uuid;
  select id into v_pkg     from _items_seed where catalog_id = current_setting('test.cat_pkg',     true)::uuid;
  perform set_config('test.item_casebox', v_casebox::text, true);
  perform set_config('test.item_pkg',     v_pkg::text,     true);
end $$;

-- Primary item_vendors links (the RPC explodes by the junction). cost_per_unit
-- on the link is the SAME per-each value as the item — the reorder coalesce
-- reads nullif(iv.cost_per_unit,0) first, so it must also be per-each.
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
select isd.id, current_setting('test.vendor_id', true)::uuid, ii.cost_per_unit, ii.case_price, true
  from _items_seed isd
  join public.inventory_items ii on ii.id = isd.id
on conflict (item_id, vendor_id) do nothing;

-- ─── Call the runner with as_of_date = today ──────────────────
create temp table _env on commit drop as
select public.report_reorder_list(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
) as env;

create temp table _items_out on commit drop as
select i->>'item_id' as item_id,
       i as item
  from _env, jsonb_array_elements(env->'vendors') v
            , jsonb_array_elements(v->'items') i
 where v->>'vendor_id' = current_setting('test.vendor_id', true);

-- ─── (A1) CASEBOX estimated_cost = pre-flip whole-case cost ──────
-- Pre-flip: cost_old = 2.50/counted-unit; whole-case order = ceil(49/24)*24 = 72
-- counted units → 72 × 2.50 = 180.00. Post-flip the RPC computes
-- 72 × per_each(0.25) × sub_unit_size(10) = 72 × 0.25 × 10 = 180.00 — identical.
select ok(
  abs(
    ((select item from _items_out where item_id = current_setting('test.item_casebox', true))->>'estimated_cost')::numeric
    - 180.00
  ) < 0.01,
  'casebox: estimated_cost = ceil(49/24)*24 * per_each(0.25) * sub(10) = 180.00 (= pre-flip 72 * cost_old 2.50)'
);

-- ─── (A2) PKG estimated_cost = pre-flip base-unit cost ───────────
-- case_qty=1 → base-unit branch: suggested_qty(10) × per_each(0.10) × sub(500)
-- = 500.00. Pre-flip equivalent: 10 counted units × cost_old(50.00) = 500.00.
select ok(
  abs(
    ((select item from _items_out where item_id = current_setting('test.item_pkg', true))->>'estimated_cost')::numeric
    - 500.00
  ) < 0.01,
  'pkg (case_qty=1, sub=500): estimated_cost = 10 * per_each(0.10) * sub(500) = 500.00 (= pre-flip 10 * cost_old 50.00)'
);

-- ─── (A3) cost_per_unit passthrough is the PER-EACH value ────────
-- The per-item JSON surfaces the raw per-each cost_per_unit (display basis);
-- only estimated_cost is bridged. Pins that the RPC did NOT mutate the exposed
-- cost_per_unit key to a counted-unit value.
select is(
  ((select item from _items_out where item_id = current_setting('test.item_pkg', true))->>'cost_per_unit')::numeric,
  0.10::numeric,
  'pkg: exposed cost_per_unit is the per-each 0.10 (bridge is applied only to estimated_cost)'
);

-- ─── (A4) ROLLUP — vendor_total_cost == sum of per-item estimated_cost ──
-- Pins the bridged per-item cost flows into vendor_total_cost (and thereby
-- kpis.total_estimated_cost). Compared to the SUM of returned items so it holds
-- regardless of any seed items already under this vendor.
select ok(
  abs(
    (select (v->>'vendor_total_cost')::numeric
       from _env, jsonb_array_elements(env->'vendors') v
      where v->>'vendor_id' = current_setting('test.vendor_id', true))
    - (select coalesce(sum((item->>'estimated_cost')::numeric), 0) from _items_out)
  ) < 0.01,
  'vendor_total_cost == sum of the (bridged) per-item estimated_cost'
);

-- ─── (B) (★)-inverse round-trip on the high-sub_unit_size fixture ─
-- Directly assert cost_new × sub_unit_size reconstructs the intended cost_old
-- for the stored PKG row (per-each 0.10, sub 500 → 50.00), within the same cent
-- epsilon. This is the explicit round-trip the owner asked for.
select ok(
  abs(
    (select ii.cost_per_unit * coalesce(ci.sub_unit_size, 1)
       from public.inventory_items ii
       join public.catalog_ingredients ci on ci.id = ii.catalog_id
      where ii.id = current_setting('test.item_pkg', true)::uuid)
    - 50.00
  ) < 0.01,
  '(★)-inverse: stored per-each cost_per_unit(0.10) × sub_unit_size(500) reconstructs cost_old = 50.00'
);

select * from finish();
rollback;

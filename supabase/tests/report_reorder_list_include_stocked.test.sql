-- supabase/tests/report_reorder_list_include_stocked.test.sql
--
-- Spec (2026-07) — pins the additive `create or replace` of
-- report_reorder_list in
-- supabase/migrations/20260711000000_reorder_list_include_stocked.sql:
--
--   1. p_params.include_stocked (bool, default false): when true, the
--      per_item_filtered CTE keeps EVERY item (not just suggested_qty >=
--      0.001), so at/above-par items surface for the staff "Have enough
--      stock" section. Absent/false → below-par-only (unchanged).
--   2. Each item carries a `needs_order` boolean (suggested_qty >= 0.001).
--
-- Two seeded items under one vendor in Frederick:
--   NEED  → par=10, current_stock=0  → suggested_qty=10  → needs_order=true
--   ENUFF → par=5,  current_stock=99 → suggested_qty=0   → needs_order=false
--
-- Assertions:
--   default params      → only NEED appears; needs_order=true
--   include_stocked=true → BOTH appear; needs_order flags correct
--
-- Fixtures in-transaction, rolled back. Master-JWT pattern mirrors
-- report_reorder_list_cases.test.sql.

begin;
create extension if not exists pgtap;

select plan(6);

do $$
declare
  v_master_id uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick uuid;
  v_brand_id  uuid;
  v_vendor_id uuid;
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
  perform set_config('test.master_id',    v_master_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text, true);
  perform set_config('test.brand_id',     v_brand_id::text,  true);
  perform set_config('test.vendor_id',    v_vendor_id::text, true);
end $$;

select isnt(current_setting('test.vendor_id', true), '',
  'fixture: brand + Frederick + a vendor-with-items resolve from seed');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'master')
  )::text,
  true
);

delete from public.order_schedule
 where store_id  = current_setting('test.frederick_id', true)::uuid
   and vendor_id = current_setting('test.vendor_id',    true)::uuid;

-- Two fresh catalog rows (case_qty=1, plain items).
create temp table _catalog on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty)
  values
    (current_setting('test.brand_id', true)::uuid, 'STOCKED-NEED-'||gen_random_uuid()::text,  'each', 1),
    (current_setting('test.brand_id', true)::uuid, 'STOCKED-ENUFF-'||gen_random_uuid()::text, 'each', 1)
  returning id, name
)
select id, name,
       case when name like 'STOCKED-NEED%' then 'need' else 'enuff' end as kind
  from ins;

do $$
begin
  perform set_config('test.cat_need',  (select id from _catalog where kind='need')::text,  true);
  perform set_config('test.cat_enuff', (select id from _catalog where kind='enuff')::text, true);
end $$;

-- NEED: par=10, stock=0 → suggested 10. ENUFF: par=5, stock=99 → suggested 0.
create temp table _items_seed on commit drop as
with ins as (
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid, current_setting('test.cat_need',  true)::uuid,
     current_setting('test.vendor_id', true)::uuid, 1, 0,  10, 0),
    (current_setting('test.frederick_id', true)::uuid, current_setting('test.cat_enuff', true)::uuid,
     current_setting('test.vendor_id', true)::uuid, 1, 99, 5,  0)
  returning id, catalog_id
)
select id, catalog_id from ins;

do $$
begin
  perform set_config('test.item_need',  (select id from _items_seed where catalog_id = current_setting('test.cat_need',  true)::uuid)::text, true);
  perform set_config('test.item_enuff', (select id from _items_seed where catalog_id = current_setting('test.cat_enuff', true)::uuid)::text, true);
end $$;

insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
select isd.id, current_setting('test.vendor_id', true)::uuid, ii.cost_per_unit, ii.case_price, true
  from _items_seed isd
  join public.inventory_items ii on ii.id = isd.id
on conflict (item_id, vendor_id) do nothing;

-- ─── default params: below-par only ──────────────────────────────
create temp table _default_items on commit drop as
select i->>'item_id' as item_id, i as item
  from (select public.report_reorder_list(
          current_setting('test.frederick_id', true)::uuid,
          jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
        ) as env) e,
       jsonb_array_elements(e.env->'vendors') v,
       jsonb_array_elements(v->'items') i
 where v->>'vendor_id' = current_setting('test.vendor_id', true);

select ok(
  exists(select 1 from _default_items where item_id = current_setting('test.item_need', true)),
  'default: the below-par NEED item appears'
);
select ok(
  not exists(select 1 from _default_items where item_id = current_setting('test.item_enuff', true)),
  'default: the at/above-par ENUFF item is filtered OUT'
);
select is(
  ((select item from _default_items where item_id = current_setting('test.item_need', true))->>'needs_order'),
  'true',
  'default: NEED item carries needs_order=true'
);

-- ─── include_stocked=true: both items surface ────────────────────
create temp table _stocked_items on commit drop as
select i->>'item_id' as item_id, i as item
  from (select public.report_reorder_list(
          current_setting('test.frederick_id', true)::uuid,
          jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'),
                             'include_stocked', true)
        ) as env) e,
       jsonb_array_elements(e.env->'vendors') v,
       jsonb_array_elements(v->'items') i
 where v->>'vendor_id' = current_setting('test.vendor_id', true);

select ok(
  exists(select 1 from _stocked_items where item_id = current_setting('test.item_enuff', true)),
  'include_stocked: the ENUFF item now appears'
);
select is(
  ((select item from _stocked_items where item_id = current_setting('test.item_enuff', true))->>'needs_order'),
  'false',
  'include_stocked: ENUFF item carries needs_order=false'
);

select * from finish();
rollback;

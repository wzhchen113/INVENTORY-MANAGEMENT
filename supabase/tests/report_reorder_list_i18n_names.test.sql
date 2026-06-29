-- supabase/tests/report_reorder_list_i18n_names.test.sql
--
-- Spec 100 — Staff reorder (补货) screen localization completion.
--
-- Pins the additive `create or replace` of `report_reorder_list` in
-- supabase/migrations/20260623000000_reorder_list_i18n_names.sql, which
-- surfaces the catalog's per-item localized-name overrides:
--
--   per_item:          ci.i18n_names as i18n_names  (from the EXISTING
--                        `ci` join — no new join, no new scan)
--   per-item JSON:     adds 'i18n_names', pif.i18n_names — a JSONB object
--                        when the catalog row has overrides, JSON null
--                        when it does not.
--
-- Three scenarios pinned:
--   Item OVERRIDES (i18n_names = {"zh-CN":"虾仁去头","es":"Camarón"}):
--       the per-item JSON carries i18n_names as a JSON object equal to
--       the catalog row's value (both the key presence and the value).
--   Item EMPTY (i18n_names = '{}' — the column default):
--       the per-item JSON carries i18n_names = '{}' (NOT JSON null —
--       the column is `not null default '{}'`, so an unset catalog row
--       reads as the empty object, which the mapper still coalesces to {}).
--   Both items: the 'i18n_names' KEY is present on every per-item object
--       (so the staff mapper can read it unconditionally).
--
-- 7 assertions: 1 fixture resolve + 2 OVERRIDES (key-present + value) +
-- 2 EMPTY (key-present + equals {}) + 2 type guards (i18n_names is a JSON
-- object on both items).
--
-- Driver mirrors report_reorder_list_cases.test.sql: usage_per_portion=0
-- (item linked to no recipe) → usage_forecasted=0, current_stock=0 →
-- par_replacement = par_level, so suggested_qty = greatest(par_level, 0)
-- = par_level >= 0.001 → the item survives the per_item_filtered cut and
-- appears in items[]. No order_schedule rows → days_until = 7 (A5
-- default), irrelevant here. cost_per_unit / case_qty are irrelevant to
-- the i18n_names projection and left at defaults.
--
-- Fixtures are inserted inside the transaction (own catalog_ingredients
-- with explicit i18n_names + own inventory_items); the rollback discards
-- everything so the seed is untouched. No `set role anon` (segfaults CI
-- per spec 067). The grant is NOT touched by the migration (signature
-- byte-identical), so there is intentionally NO has_function_privilege
-- assertion. Master-JWT pattern mirrors report_reorder_list_cases.test.sql.

begin;
create extension if not exists pgtap;

select plan(7);

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

-- Two fresh catalog_ingredients with EXPLICIT i18n_names. Random names
-- side-step the (brand, lower(name)) UNIQUE on re-run without rollback.
--   OVERRIDES → i18n_names = {"zh-CN":"虾仁去头","es":"Camarón"}
--   EMPTY     → i18n_names = '{}' (the column default; set explicitly)
create temp table _catalog on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, i18n_names)
  values
    (current_setting('test.brand_id', true)::uuid,
     'SPEC100-OVERRIDES-'||gen_random_uuid()::text, 'each',
     '{"zh-CN":"虾仁去头","es":"Camarón"}'::jsonb),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC100-EMPTY-'||gen_random_uuid()::text,     'each',
     '{}'::jsonb)
  returning id, name
)
select id, name,
       case
         when name like 'SPEC100-OVERRIDES%' then 'overrides'
         else 'empty'
       end as kind
  from ins;

do $$
declare
  v_overrides uuid;
  v_empty     uuid;
begin
  select id into v_overrides from _catalog where kind = 'overrides' limit 1;
  select id into v_empty     from _catalog where kind = 'empty'     limit 1;
  perform set_config('test.cat_overrides', v_overrides::text, true);
  perform set_config('test.cat_empty',     v_empty::text,     true);
end $$;

-- Two inventory_items (one per catalog), both in Frederick under the
-- chosen vendor. current_stock=0, usage_per_portion=0, par_level=10 →
-- suggested_qty = 10 → survives the filter and appears in items[].
create temp table _items_seed on commit drop as
with ins as (
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.cat_overrides', true)::uuid,
     current_setting('test.vendor_id',     true)::uuid,
     1, 0, 10, 0),
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.cat_empty',     true)::uuid,
     current_setting('test.vendor_id',     true)::uuid,
     1, 0, 10, 0)
  returning id, catalog_id
)
select id, catalog_id from ins;

do $$
declare
  v_overrides uuid;
  v_empty     uuid;
begin
  select id into v_overrides from _items_seed where catalog_id = current_setting('test.cat_overrides', true)::uuid;
  select id into v_empty     from _items_seed where catalog_id = current_setting('test.cat_empty',     true)::uuid;
  perform set_config('test.item_overrides', v_overrides::text, true);
  perform set_config('test.item_empty',     v_empty::text,     true);
end $$;

-- Spec 102 — the reorder RPC now explodes items to vendors via the
-- `item_vendors` junction, NOT the scalar inventory_items.vendor_id. These
-- in-transaction test items did not exist when the backfill ran, so insert
-- their primary links explicitly (mirroring the backfill). Without this,
-- the items produce no reorder rows and the i18n_names key never appears.
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

-- Pull the seeded vendor's items[].
create temp table _items_out on commit drop as
select i->>'item_id' as item_id,
       i as item
  from _env, jsonb_array_elements(env->'vendors') v
            , jsonb_array_elements(v->'items') i
 where v->>'vendor_id' = current_setting('test.vendor_id', true);

-- ─── (1) OVERRIDES item — i18n_names KEY is present ─────────────
select ok(
  (select item from _items_out where item_id = current_setting('test.item_overrides', true)) ? 'i18n_names',
  'overrides item: per-item JSON carries the i18n_names key'
);

-- ─── (2) OVERRIDES item — i18n_names value == catalog override ──
select is(
  (select item->'i18n_names' from _items_out where item_id = current_setting('test.item_overrides', true)),
  '{"zh-CN":"虾仁去头","es":"Camarón"}'::jsonb,
  'overrides item: i18n_names == the catalog row''s override object'
);

-- ─── (3) EMPTY item — i18n_names KEY is present ─────────────────
select ok(
  (select item from _items_out where item_id = current_setting('test.item_empty', true)) ? 'i18n_names',
  'empty item: per-item JSON carries the i18n_names key (always present)'
);

-- ─── (4) EMPTY item — i18n_names == {} (column default, not null) ─
select is(
  (select item->'i18n_names' from _items_out where item_id = current_setting('test.item_empty', true)),
  '{}'::jsonb,
  'empty item: i18n_names == {} (column default; mapper coalesces to {})'
);

-- ─── (5) OVERRIDES item — i18n_names is a JSON object ───────────
select is(
  jsonb_typeof((select item->'i18n_names' from _items_out where item_id = current_setting('test.item_overrides', true))),
  'object',
  'overrides item: i18n_names serializes as a JSON object'
);

-- ─── (6) EMPTY item — i18n_names is a JSON object ───────────────
select is(
  jsonb_typeof((select item->'i18n_names' from _items_out where item_id = current_setting('test.item_empty', true))),
  'object',
  'empty item: i18n_names serializes as a JSON object (not null)'
);

select * from finish();
rollback;

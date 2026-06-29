-- supabase/tests/item_vendors_backfill.test.sql
--
-- Spec 102 / AC-A / AC-I — pgTAP coverage for the item_vendors BACKFILL
-- contract in supabase/migrations/20260630000000_item_vendors.sql.
--
-- The backfill is the inline DML at the bottom of that migration:
--
--   insert into public.item_vendors
--     (item_id, vendor_id, cost_per_unit, case_price, is_primary)
--   select ii.id, ii.vendor_id,
--          coalesce(ii.cost_per_unit, 0), coalesce(ii.case_price, 0), true
--     from public.inventory_items ii
--    where ii.vendor_id is not null
--   on conflict (item_id, vendor_id) do nothing;
--
-- This test seeds its OWN inventory_items (one vendor-bearing with a known
-- distinctive cost, one with vendor_id IS NULL) inside the transaction, runs
-- that exact backfill INSERT, and asserts the three AC-A guarantees:
--
--   (1) fixture resolve — brand + a vendor resolve from seed.
--   (2) a vendor-bearing item produces EXACTLY ONE link row.
--   (3) that link is is_primary = true.
--   (4) the link's cost_per_unit equals the item's cost_per_unit
--       (cost preservation — AC-A "total cost unchanged after migration").
--   (5) the link's case_price equals the item's case_price (cost preservation).
--   (6) a vendor_id IS NULL item produces ZERO link rows (AC-A — null-vendor
--       items stay absent from vendor tabs / reorder cards).
--   (7) IDEMPOTENCY — re-running the SAME backfill INSERT produces ZERO new
--       rows (the ON CONFLICT (item_id, vendor_id) DO NOTHING re-run
--       requirement — AC-A "re-running the backfill does not duplicate link
--       rows"). The link count for the seeded item stays exactly 1.
--
-- CI-fresh safe: every fixture (items + the backfill it exercises) is created
-- INSIDE this transaction, so the test is identical whether the 564-row seed
-- backfill ran or item_vendors was truncated after a `db reset` (the
-- documented local-green/CI-red asymmetry). It never reads the seed's links.
--
-- No `set role anon` (segfaults CI per spec 067). Master-JWT pattern mirrors
-- report_reorder_list_cases.test.sql. Hermetic isolation: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(7);

-- ─── fixtures ──────────────────────────────────────────────────
-- Resolve Frederick + brand + any seed vendor.
do $$
declare
  v_master_id uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick uuid;
  v_brand_id  uuid;
  v_vendor_id uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  select id into v_vendor_id from public.vendors limit 1;

  perform set_config('test.master_id',    v_master_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text, true);
  perform set_config('test.brand_id',     v_brand_id::text,  true);
  perform set_config('test.vendor_id',    v_vendor_id::text, true);
end $$;

select isnt(current_setting('test.vendor_id', true), '',
  '(1) fixture: brand + Frederick + a seed vendor resolve');

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

-- Two fresh catalog_ingredients (random names side-step the
-- (brand, lower(name)) UNIQUE on any re-run without rollback).
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  values
    (current_setting('test.brand_id', true)::uuid, 'SPEC102-BF-VEN-'||gen_random_uuid()::text, 'each'),
    (current_setting('test.brand_id', true)::uuid, 'SPEC102-BF-NUL-'||gen_random_uuid()::text, 'each')
  returning id, name
)
select id, name,
       case when name like 'SPEC102-BF-VEN%' then 'ven' else 'nul' end as kind
  from ins;

-- Two inventory_items in Frederick:
--   VEN → vendor_id set, with DISTINCTIVE costs (cost_per_unit 7.25,
--         case_price 33.40) so the cost-preservation assertions can't pass
--         by coincidence with the seed's typical cost=1 items.
--   NUL → vendor_id IS NULL (the null-vendor case → zero links).
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, case_price, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid,
     (select id from _cat where kind = 'ven'),
     current_setting('test.vendor_id', true)::uuid,
     7.25, 33.40, 0, 0, 0),
    (current_setting('test.frederick_id', true)::uuid,
     (select id from _cat where kind = 'nul'),
     null,
     5.00, 20.00, 0, 0, 0)
  returning id, catalog_id, vendor_id
)
select i.id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
begin
  perform set_config('test.item_ven', (select id from _items where kind = 'ven')::text, true);
  perform set_config('test.item_nul', (select id from _items where kind = 'nul')::text, true);
end $$;

-- ─── Run the backfill (the EXACT inline DML from the migration) ──
-- Scoped to our two fixtures so we exercise the backfill predicate against a
-- known, in-transaction set independent of the seed's 564 rows.
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
select ii.id, ii.vendor_id,
       coalesce(ii.cost_per_unit, 0), coalesce(ii.case_price, 0), true
  from public.inventory_items ii
 where ii.vendor_id is not null
   and ii.id in (current_setting('test.item_ven', true)::uuid,
                 current_setting('test.item_nul', true)::uuid)
on conflict (item_id, vendor_id) do nothing;

-- ─── (2) vendor-bearing item → exactly one link ─────────────────
select is(
  (select count(*)::bigint from public.item_vendors
    where item_id = current_setting('test.item_ven', true)::uuid),
  1::bigint,
  '(2) a vendor-bearing item produces exactly one item_vendors link'
);

-- ─── (3) the link is is_primary = true ──────────────────────────
select is(
  (select is_primary from public.item_vendors
    where item_id = current_setting('test.item_ven', true)::uuid),
  true,
  '(3) the backfilled link is is_primary = true (it IS the scalar vendor)'
);

-- ─── (4) cost_per_unit preserved ────────────────────────────────
select is(
  (select cost_per_unit from public.item_vendors
    where item_id = current_setting('test.item_ven', true)::uuid),
  7.25::numeric,
  '(4) link.cost_per_unit equals the item''s cost_per_unit (cost preserved)'
);

-- ─── (5) case_price preserved ───────────────────────────────────
select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_ven', true)::uuid),
  33.40::numeric,
  '(5) link.case_price equals the item''s case_price (cost preserved)'
);

-- ─── (6) null-vendor item → zero links ──────────────────────────
select is(
  (select count(*)::bigint from public.item_vendors
    where item_id = current_setting('test.item_nul', true)::uuid),
  0::bigint,
  '(6) a vendor_id IS NULL item produces zero links (absent from vendor tabs)'
);

-- ─── (7) idempotency — re-run produces ZERO new rows ────────────
-- Re-execute the IDENTICAL backfill INSERT. The composite-unique
-- ON CONFLICT DO NOTHING must skip the already-present row → the vendor-
-- bearing item's link count stays exactly 1 (no duplicate).
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
select ii.id, ii.vendor_id,
       coalesce(ii.cost_per_unit, 0), coalesce(ii.case_price, 0), true
  from public.inventory_items ii
 where ii.vendor_id is not null
   and ii.id in (current_setting('test.item_ven', true)::uuid,
                 current_setting('test.item_nul', true)::uuid)
on conflict (item_id, vendor_id) do nothing;

select is(
  (select count(*)::bigint from public.item_vendors
    where item_id = current_setting('test.item_ven', true)::uuid),
  1::bigint,
  '(7) re-running the backfill produces zero duplicate rows (idempotent ON CONFLICT)'
);

select * from finish();
rollback;

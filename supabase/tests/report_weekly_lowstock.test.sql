-- supabase/tests/report_weekly_lowstock.test.sql
--
-- Spec 102 / AC-H / SD-2 / AC-I — pgTAP coverage for the NEW advisory RPC
-- report_weekly_lowstock
-- (supabase/migrations/20260630000300_report_weekly_lowstock.sql).
--
-- The RPC had ZERO coverage; every other report RPC in the project has at
-- least the anon-EXECUTE-denial pgTAP. This file pins the auth gate plus the
-- three low_stock branches the migration body computes:
--
--   low_stock =
--     when usage_per_day > 0 : projected_on_hand < 0   (usage-driven)
--                              where projected_on_hand =
--                                on_hand - usage_per_day * max(0, days_until)
--     else                   : on_hand <= 0            (usage=0 fallback)
--
-- Nine assertions:
--   (1) anon lacks EXECUTE (GRANT layer — mirrors reports_anon_revoke.test).
--   (2) authenticated retains EXECUTE.
--   (3) non-member call refused (42501) — auth_can_see_store gate (Charles).
--   (4) fixture resolve under the member JWT.
--   (5) USAGE-DRIVEN LOW — on_hand 5, usage_per_day 10, a FUTURE delivery
--       (days_until ≥ 1) → projected_on_hand < 0 → low_stock = true.
--   (6) NOT-LOW — on_hand 100, usage 0 → low_stock = false (healthy stock,
--       no usage signal).
--   (7) USAGE=0 FALLBACK LOW — on_hand 0, usage 0 → low_stock = true via the
--       `else on_hand <= 0` branch (a zero-stock item still warns).
--   (8) the usage-driven item's usage_per_day == 10 (the pos_daily rate is
--       wired through — guards the projected-on-hand math the low flag rests
--       on).
--   (9) a NO-VENDOR-LINK item is ABSENT from the payload (only items with ≥1
--       link appear — there is no next-delivery date to compare against).
--
-- Usage is driven the same way the reorder hybrid-formula test does it:
-- recipe + recipe_ingredients + pos_imports + pos_import_items (qty_sold/7 =
-- qty_per_day). The usage-driven item's vendor is scheduled for a FUTURE
-- weekday (days_until ≥ 1) so usage actually depletes projected on-hand;
-- without a future delivery, days_until = 0 and projected == on_hand.
--
-- All fixtures (catalog, items, item_vendors links, schedule, recipe, POS)
-- are created INSIDE the transaction, so the test is identical under the
-- 564-row backfill seed AND the CI-fresh `truncate item_vendors` state. No
-- `set role anon` (segfaults CI per spec 067; anon checked via
-- has_function_privilege). Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(9);

-- ─── (1)/(2) GRANT layer — anon denied, authenticated allowed ───
-- Checked under the postgres role (before any switch). Mirrors the
-- reports_anon_revoke.test.sql pattern — no `set role anon`.
select ok(
  not has_function_privilege('anon', 'public.report_weekly_lowstock(uuid, jsonb)', 'EXECUTE'),
  '(1) anon lacks EXECUTE on report_weekly_lowstock'
);

select ok(
  has_function_privilege('authenticated', 'public.report_weekly_lowstock(uuid, jsonb)', 'EXECUTE'),
  '(2) authenticated retains EXECUTE on report_weekly_lowstock'
);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_charles    uuid;
  v_brand_id   uuid;
  v_vendor_id  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  select id into v_vendor_id from public.vendors order by id limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.charles_id',   v_charles::text,    true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
  perform set_config('test.vendor_id',    v_vendor_id::text,  true);
end $$;

-- ─── master JWT — privileged for order_schedule + catalog/inventory/recipe
-- seeding (order_schedule writes are admin-only; manager cannot write them).
-- The manager-JWT auth-gate + RPC assertions run AFTER all seeding below.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           '33333333-3333-3333-3333-333333333333',
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'master')
  )::text,
  true
);

-- Schedule the vendor for a FUTURE weekday (tomorrow) → days_offset 1 →
-- next_delivery_date = today + N (≥ 1) → usage has time to deplete the
-- projected on-hand. order_schedule requires day_of_week + vendor_name (both
-- NOT NULL); the RPC's offset math reads delivery_day. Lock to exactly one
-- delivery_day so the offset is deterministic.
delete from public.order_schedule
 where store_id = current_setting('test.frederick_id', true)::uuid
   and vendor_id = current_setting('test.vendor_id', true)::uuid;

insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.frederick_id', true)::uuid,
       'monday',
       current_setting('test.vendor_id', true)::uuid,
       v.name,
       lower(to_char(current_date + 1, 'FMDay'))
  from public.vendors v
 where v.id = current_setting('test.vendor_id', true)::uuid;

-- Three catalog rows + one no-link catalog/item.
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  values
    (current_setting('test.brand_id', true)::uuid, 'SPEC102-WL-LOW-'||gen_random_uuid()::text,  'ea'),
    (current_setting('test.brand_id', true)::uuid, 'SPEC102-WL-OK-'||gen_random_uuid()::text,   'ea'),
    (current_setting('test.brand_id', true)::uuid, 'SPEC102-WL-ZERO-'||gen_random_uuid()::text, 'ea'),
    (current_setting('test.brand_id', true)::uuid, 'SPEC102-WL-NOLINK-'||gen_random_uuid()::text,'ea')
  returning id, name
)
select id, name,
       case
         when name like 'SPEC102-WL-LOW%'    then 'low'
         when name like 'SPEC102-WL-OK%'     then 'ok'
         when name like 'SPEC102-WL-ZERO%'   then 'zero'
         else 'nolink'
       end as kind
  from ins;

-- Inventory items:
--   LOW    → on_hand 5,   usage-driven (recipe + POS below) → projected < 0.
--   OK     → on_hand 100, no recipe → usage 0 → low_stock false.
--   ZERO   → on_hand 0,   no recipe → usage 0 → low_stock true (fallback).
--   NOLINK → on_hand 0,   NO item_vendors link → absent from payload.
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind='low'),
     current_setting('test.vendor_id', true)::uuid, 1, 5,   0, 0),
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind='ok'),
     current_setting('test.vendor_id', true)::uuid, 1, 100, 0, 0),
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind='zero'),
     current_setting('test.vendor_id', true)::uuid, 1, 0,   0, 0),
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind='nolink'),
     null, 1, 0, 0, 0)
  returning id, catalog_id
)
select i.id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
begin
  perform set_config('test.item_low',    (select id from _items where kind='low')::text,    true);
  perform set_config('test.item_ok',     (select id from _items where kind='ok')::text,     true);
  perform set_config('test.item_zero',   (select id from _items where kind='zero')::text,   true);
  perform set_config('test.item_nolink', (select id from _items where kind='nolink')::text, true);
end $$;

-- item_vendors links for the three linked items (the NOLINK item gets none).
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  (current_setting('test.item_low', true)::uuid,  current_setting('test.vendor_id', true)::uuid, 1, 1, true),
  (current_setting('test.item_ok', true)::uuid,   current_setting('test.vendor_id', true)::uuid, 1, 1, true),
  (current_setting('test.item_zero', true)::uuid, current_setting('test.vendor_id', true)::uuid, 1, 1, true)
on conflict (item_id, vendor_id) do nothing;

-- Recipe + recipe_ingredients to give the LOW item a usage signal. quantity 1
-- → one base unit of the catalog per recipe portion.
create temp table _recipe on commit drop as
with ins as (
  insert into public.recipes (brand_id, menu_item, sell_price)
  values (current_setting('test.brand_id', true)::uuid, 'SPEC102-WL-MENU-'||gen_random_uuid()::text, 0)
  returning id
)
select id from ins;

do $$
begin
  perform set_config('test.recipe_id', (select id from _recipe)::text, true);
end $$;

insert into public.recipe_ingredients (recipe_id, catalog_id, quantity, unit)
values (
  current_setting('test.recipe_id', true)::uuid,
  (select id from _cat where kind='low'),
  1, 'ea'
);

-- POS import inside the trailing 7-day window. qty_sold 70 → /7 = 10 per day
-- → usage_per_day = 10 for the LOW item. With on_hand 5 and days_until ≥ 1,
-- projected_on_hand = 5 - 10 * days_until ≤ -5 < 0 → low_stock true.
create temp table _pos on commit drop as
with ins as (
  insert into public.pos_imports (store_id, filename, import_date)
  values (current_setting('test.frederick_id', true)::uuid, 'spec-102-wl.csv', current_date)
  returning id
)
select id from ins;

insert into public.pos_import_items (import_id, menu_item, qty_sold, recipe_id, recipe_mapped)
values (
  (select id from _pos),
  'SPEC102 WL LOW', 70,
  current_setting('test.recipe_id', true)::uuid,
  true
);

-- ─── Switch to the staff user (manager@local.test, role=user) ──
-- The remaining assertions run as a Frederick member: the non-member auth
-- gate (3), and the RPC call itself under security-invoker RLS (the shape the
-- WeeklyCount screen actually uses).
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- ─── (3) non-member call refused (42501) ───────────────────────
-- The manager is NOT a member of Charles; the auth_can_see_store gate (first
-- statement of the RPC) raises 42501. throws_ok (NOT set role anon).
select throws_ok(
  format(
    $q$select public.report_weekly_lowstock(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.charles_id', true)
  ),
  '42501',
  null,
  '(3) non-member call refused by auth_can_see_store gate (42501)'
);

select isnt(current_setting('test.vendor_id', true), '',
  '(4) fixture: Frederick + Charles + a vendor + brand resolve');

-- ─── Call the RPC with as_of_date = today (member JWT) ─────────
create temp table _env on commit drop as
select public.report_weekly_lowstock(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
) as env;

create temp table _rows on commit drop as
select i->>'item_id'              as item_id,
       (i->>'low_stock')::boolean as low_stock,
       (i->>'usage_per_day')::numeric as usage_per_day,
       i as item
  from _env, jsonb_array_elements(env->'items') i;

-- ─── (5) usage-driven LOW ──────────────────────────────────────
select is(
  (select low_stock from _rows where item_id = current_setting('test.item_low', true)),
  true,
  '(5) usage-driven item (on_hand 5, usage_per_day 10, future delivery) → low_stock = true'
);

-- ─── (6) NOT-LOW (healthy stock, no usage) ─────────────────────
select is(
  (select low_stock from _rows where item_id = current_setting('test.item_ok', true)),
  false,
  '(6) healthy item (on_hand 100, usage 0) → low_stock = false'
);

-- ─── (7) usage=0 FALLBACK LOW (on_hand <= 0) ───────────────────
select is(
  (select low_stock from _rows where item_id = current_setting('test.item_zero', true)),
  true,
  '(7) zero-stock item (on_hand 0, usage 0) → low_stock = true via on_hand <= 0 fallback'
);

-- ─── (8) usage_per_day wired through == 10 ─────────────────────
select is(
  (select usage_per_day from _rows where item_id = current_setting('test.item_low', true)),
  10::numeric,
  '(8) LOW item usage_per_day = 70/7 = 10 (pos_daily rate feeds projected-on-hand)'
);

-- ─── (9) no-vendor-link item ABSENT from the payload ───────────
select is(
  (select count(*)::bigint from _rows where item_id = current_setting('test.item_nolink', true)),
  0::bigint,
  '(9) an item with no vendor link is absent from the weekly low-stock payload'
);

select * from finish();
rollback;

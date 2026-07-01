-- supabase/tests/report_reorder_for_counted_onhand.test.sql
--
-- Spec 105 — pgTAP coverage for the NEW counted-on-hand reorder RPC
-- (supabase/migrations/20260702000000_report_reorder_for_counted_onhand.sql).
--
-- The RPC copies report_reorder_list's forecast/case/delivery CTEs verbatim
-- with exactly TWO deltas: (1) on-hand from the caller-supplied p_on_hand map
-- (not the EOD/stock CASE), and (2) a FLAT item-keyed output collapsing an
-- item's linked vendors to min(days_until) (soonest truck). This suite pins
-- BOTH deltas plus the auth gate the spec 105 backend design enumerates:
--
--   (1) fixture resolve — Frederick + two distinct vendors.
--   (2) BELOW-par supplied on-hand → expected par_replacement / suggested_qty
--       / suggested_cases (spec 088 case math): par=200, case_qty=24,
--       on_hand=60 → par_replacement=140, suggested_qty=140,
--       suggested_cases=ceil(140/24)=6, suggested_units=144.
--   (3) MULTI-VENDOR collapse — a shared item linked to two vendors on
--       different delivery days reports days_until = the SOONEST vendor's
--       offset (min), not the numerically-first or last vendor's.
--   (4) AT/ABOVE-par supplied on-hand (suggested_qty < 0.001) is ABSENT from
--       items[] (the per_item_filtered `>= 0.001` predicate is preserved).
--   (5) NON-MEMBER caller (RLS) → the auth_can_see_store() gate raises 42501
--       (the FE passes the count's store; a manager who can't see it is
--       refused). Mirrors report_run_vendor's 42501 assertion.
--   (6) EMPTY p_on_hand → items: [] with no scan/error (the fast-path guard).
-- NOTE: the numeric labels are LOGICAL, not run-order — at runtime (6) EMPTY
-- executes BEFORE (5) NON-MEMBER (the empty-map probe must run under the master
-- JWT, before the switch to the non-member manager JWT). (code-review CR3)
--
-- All fixtures (catalog, items, item_vendors links, schedule) are created
-- INSIDE the transaction, so the suite is identical under the prod-pulled seed
-- AND a CI-fresh state. No `set role anon` (segfaults CI per spec 067).
-- Master-JWT pattern mirrors report_reorder_list_cases.test.sql. Hermetic:
-- begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(9);

-- ─── fixtures ──────────────────────────────────────────────────
-- Resolve Frederick + brand + two DISTINCT vendors. We control the vendors'
-- schedules below, so they need no pre-existing items — the RPC's
-- vendor_delivery_offsets EXISTS filter accepts a vendor as soon as our
-- junction links land. A third store (Charles) is the non-member target for
-- the 42501 gate — a Frederick-scoped manager must NOT be able to see it.
do $$
declare
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_charles    uuid;
  v_brand_id   uuid;
  v_vendor1    uuid;
  v_vendor2    uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  select id into v_vendor1 from public.vendors order by id asc  limit 1;
  select id into v_vendor2 from public.vendors order by id desc limit 1;

  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.charles_id',   v_charles::text,    true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
  perform set_config('test.vendor1',      v_vendor1::text,    true);
  perform set_config('test.vendor2',      v_vendor2::text,    true);
end $$;

select ok(
  current_setting('test.vendor1', true) <> current_setting('test.vendor2', true)
    and current_setting('test.frederick_id', true) <> '',
  '(1) fixture: Frederick + two distinct vendors resolve from seed'
);

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

-- Lock both vendors' schedule. CASE item is single-vendor (V1) with NO
-- schedule → days_until = 7 (A5 default; irrelevant to the case math since
-- usage_forecasted is 0). The MULTI item is linked to BOTH vendors on
-- DIFFERENT delivery days so we can pin the min(days_until) collapse:
--   V1 delivers today+5, V2 delivers today+1 → soonest = 1 (V2).
delete from public.order_schedule
 where store_id = current_setting('test.frederick_id', true)::uuid
   and vendor_id in (current_setting('test.vendor1', true)::uuid,
                     current_setting('test.vendor2', true)::uuid);

-- V1 delivers today+5.
insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.frederick_id', true)::uuid,
       'monday',
       current_setting('test.vendor1', true)::uuid,
       v.name,
       lower(to_char(current_date + 5, 'FMDay'))
  from public.vendors v
 where v.id = current_setting('test.vendor1', true)::uuid;

-- V2 delivers today+1 (the soonest truck).
insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.frederick_id', true)::uuid,
       'monday',
       current_setting('test.vendor2', true)::uuid,
       v.name,
       lower(to_char(current_date + 1, 'FMDay'))
  from public.vendors v
 where v.id = current_setting('test.vendor2', true)::uuid;

-- Two fresh catalog_ingredients.
--   CASE → case_qty 24 (case-size item; drive the spec 088 case math).
--   MULTI → case_qty 1 (plain; used to pin the multi-vendor collapse).
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty)
  values
    (current_setting('test.brand_id', true)::uuid, 'SPEC105-CASE-'||gen_random_uuid()::text,  'each', 24),
    (current_setting('test.brand_id', true)::uuid, 'SPEC105-MULTI-'||gen_random_uuid()::text, 'each', 1)
  returning id, name
)
select id, name,
       case when name like 'SPEC105-CASE%' then 'case' else 'multi' end as kind
  from ins;

-- Two Frederick items (par=200 for CASE, par=100 for MULTI). current_stock /
-- usage_per_portion are IRRELEVANT — the RPC reads on-hand from p_on_hand.
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid,
     (select id from _cat where kind = 'case'),
     current_setting('test.vendor1', true)::uuid,
     1, 999, 200, 0),
    (current_setting('test.frederick_id', true)::uuid,
     (select id from _cat where kind = 'multi'),
     current_setting('test.vendor1', true)::uuid,
     1, 999, 100, 0)
  returning id, catalog_id
)
select i.id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
begin
  perform set_config('test.item_case',  (select id from _items where kind = 'case')::text,  true);
  perform set_config('test.item_multi', (select id from _items where kind = 'multi')::text, true);
end $$;

-- item_vendors links:
--   CASE  → V1 only (single-vendor).
--   MULTI → V1 + V2 (drives the min(days_until) collapse).
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  (current_setting('test.item_case', true)::uuid,  current_setting('test.vendor1', true)::uuid, 1, 0, true),
  (current_setting('test.item_multi', true)::uuid, current_setting('test.vendor1', true)::uuid, 1, 0, true),
  (current_setting('test.item_multi', true)::uuid, current_setting('test.vendor2', true)::uuid, 1, 0, false)
on conflict (item_id, vendor_id) do nothing;

-- ─── Call: CASE counted BELOW par (60 < 200); MULTI counted BELOW (10 < 100).
create temp table _env on commit drop as
select public.report_reorder_for_counted_onhand(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object(
    current_setting('test.item_case', true),  60,
    current_setting('test.item_multi', true), 10
  ),
  jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
) as env;

-- Flatten items[] to (item_id, item-json).
create temp table _rows on commit drop as
select i->>'item_id' as item_id, i as item
  from _env, jsonb_array_elements(env->'items') i;

-- ─── (2) BELOW-par case math (spec 088) ─────────────────────────
-- par_replacement = greatest(0, 200 - 60 - 0) = 140.
select is(
  ((select item from _rows where item_id = current_setting('test.item_case', true))->>'par_replacement')::numeric,
  140::numeric,
  '(2a) CASE item par_replacement = 200 - 60 = 140'
);

-- suggested_qty = greatest(par_replacement, usage_forecasted) = 140.
select is(
  ((select item from _rows where item_id = current_setting('test.item_case', true))->>'suggested_qty')::numeric,
  140::numeric,
  '(2b) CASE item suggested_qty = 140 (usage_forecasted 0)'
);

-- suggested_cases = ceil(140 / 24) = 6; suggested_units = 6 * 24 = 144.
select is(
  ((select item from _rows where item_id = current_setting('test.item_case', true))->>'suggested_cases')::int,
  6,
  '(2c) CASE item suggested_cases = ceil(140/24) = 6 (spec 088 case math)'
);

select is(
  ((select item from _rows where item_id = current_setting('test.item_case', true))->>'suggested_units')::numeric,
  144::numeric,
  '(2d) CASE item suggested_units = 6 * 24 = 144'
);

-- ─── (3) MULTI-VENDOR collapse to the SOONEST truck ─────────────
-- V1 = today+5, V2 = today+1 → days_until = 1 (min), next_delivery = today+1.
select is(
  ((select item from _rows where item_id = current_setting('test.item_multi', true))->>'days_until')::int,
  1,
  '(3) MULTI item days_until = 1 (soonest vendor V2 @ +1, NOT V1 @ +5)'
);

-- ─── (4) AT/ABOVE-par item is ABSENT from items[] ───────────────
-- Re-call with the CASE item counted AT par (200) → suggested_qty 0 →
-- absent. MULTI stays below so items[] is non-empty (proves the filter is
-- per-item, not an all-or-nothing empty).
create temp table _env_atpar on commit drop as
select public.report_reorder_for_counted_onhand(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object(
    current_setting('test.item_case', true),  200,   -- AT par → nothing to order
    current_setting('test.item_multi', true), 10     -- still below → present
  ),
  jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
) as env;

select is(
  (select count(*)::bigint
     from _env_atpar, jsonb_array_elements(env->'items') i
    where i->>'item_id' = current_setting('test.item_case', true)),
  0::bigint,
  '(4) CASE item counted AT par is absent from items[] (suggested_qty < 0.001)'
);

-- ─── (6) EMPTY p_on_hand → items: [] (fast-path, no scan/error) ─
-- Still under the master JWT (can see Frederick). Empty map → empty items,
-- no error. Asserted BEFORE the JWT switch below.
select is(
  (select jsonb_array_length(
     public.report_reorder_for_counted_onhand(
       current_setting('test.frederick_id', true)::uuid,
       '{}'::jsonb,
       '{}'::jsonb
     )->'items'
  )),
  0,
  '(6) empty p_on_hand → items: [] (fast-path guard, no scan)'
);

-- ─── (5) NON-MEMBER caller → 42501 (auth_can_see_store gate) ────
-- Switch to a plain user JWT (manager, member of Towson+Frederick per seed)
-- and call for CHARLES (a store they are NOT a member of) → 42501.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

select throws_ok(
  format(
    $q$select public.report_reorder_for_counted_onhand(%L::uuid, '{}'::jsonb, '{}'::jsonb)$q$,
    current_setting('test.charles_id', true)
  ),
  '42501',
  null,
  '(5) non-member caller (manager → Charles) raises 42501 (auth_can_see_store gate)'
);

select * from finish();
rollback;

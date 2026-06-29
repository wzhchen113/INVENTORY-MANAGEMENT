-- supabase/tests/report_reorder_list_multi_vendor.test.sql
--
-- Spec 102 / AC-G / OQ-1 / OQ-5 / AC-I — pgTAP coverage for the NEW
-- multi-vendor behavior of report_reorder_list
-- (supabase/migrations/20260630000100_report_reorder_list_multi_vendor.sql).
--
-- The six pre-existing reorder suites were patched to seed ONE item_vendors
-- link per item (so they keep passing), but that only proves the RPC still
-- works for the SINGLE-vendor shape. This file pins the genuinely-new
-- contract the rewrite added:
--
--   (1) EXPLOSION — a shared item linked to TWO vendors, both scheduled the
--       SAME day, appears under BOTH vendor cards.
--   (2) PER-VENDOR COST — its estimated_cost under each card is priced at
--       THAT vendor's per-(item,vendor) junction cost, NOT a single item
--       cost. V1 @ $5 → 10*5 = 50; V2 @ $8 → 10*8 = 80 (DISTINCT, so a
--       single-cost regression can't pass).
--   (3) OQ-5 FALLBACK — a second item whose junction cost is 0 falls back to
--       the item's inventory_items.cost_per_unit ($3 → 10*3 = 30).
--   (4) OQ-1 HINT — other_vendor_count / also_from_vendors: the shared item's
--       per-item JSON reports 1 other vendor and names it; the
--       single-vendor fallback item reports 0.
--
-- Eleven assertions:
--   (1) fixture resolve.
--   (2) shared item present under V1 card.
--   (3) shared item present under V2 card.
--   (4) shared item estimated_cost under V1 == 50 (per-vendor cost $5).
--   (5) shared item estimated_cost under V2 == 80 (per-vendor cost $8).
--   (6) shared item other_vendor_count == 1 under V1 card.
--   (7) shared item also_from_vendors names V2 under V1 card.
--   (8) fallback item present under V1 card.
--   (9) fallback item estimated_cost == 30 (junction cost 0 → item cost $3).
--   (10) fallback item other_vendor_count == 0 (single-vendor).
--   (11) shared item appears in EXACTLY two vendor cards total (no triple /
--        no missing — pins the explosion cardinality).
--
-- Schedule: both vendors get an order_schedule row whose delivery_day is
-- TODAY's weekday → days_offset 0 → next_delivery_date = today → both vendors
-- surface a card on the as-of day (the coincident-schedule case, OQ-1).
--
-- All fixtures (catalog, items, item_vendors links, schedule) are created
-- INSIDE the transaction, so the test is identical under the 564-row backfill
-- seed AND the CI-fresh `truncate item_vendors` state. No `set role anon`
-- (segfaults CI per spec 067). Master-JWT pattern mirrors
-- report_reorder_list_cases.test.sql. Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(11);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_master_id uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick uuid;
  v_brand_id  uuid;
  v_vendor1   uuid;
  v_vendor2   uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  -- Two DISTINCT vendors; we control their schedule below so they need no
  -- pre-existing items (the rewrite's vendor_delivery_offsets EXISTS filter
  -- accepts a vendor as soon as our junction links land).
  select id into v_vendor1 from public.vendors order by id asc  limit 1;
  select id into v_vendor2 from public.vendors order by id desc limit 1;

  perform set_config('test.master_id',    v_master_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text, true);
  perform set_config('test.brand_id',     v_brand_id::text,  true);
  perform set_config('test.vendor1',      v_vendor1::text,   true);
  perform set_config('test.vendor2',      v_vendor2::text,   true);
end $$;

select ok(
  current_setting('test.vendor1', true) <> current_setting('test.vendor2', true),
  '(1) fixture: Frederick + two distinct vendors resolve'
);

-- ─── master JWT ────────────────────────────────────────────────
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

-- Lock both vendors' schedule to "delivers TODAY" → days_offset 0 →
-- next_delivery_date = today → both surface a card on the as-of day.
delete from public.order_schedule
 where store_id = current_setting('test.frederick_id', true)::uuid
   and vendor_id in (current_setting('test.vendor1', true)::uuid,
                     current_setting('test.vendor2', true)::uuid);

-- order_schedule requires day_of_week + vendor_name (both NOT NULL) and has
-- UNIQUE (store_id, day_of_week, vendor_id). day_of_week is "when the order
-- goes out"; the RPC's offset math reads delivery_day ("when the truck
-- arrives"). delivery_day = TODAY's weekday → offset 0 → next_delivery = today
-- → both vendors surface a card on the as-of day (the OQ-1 coincident case).
insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.frederick_id', true)::uuid,
       'monday',
       current_setting('test.vendor1', true)::uuid,
       v.name,
       lower(to_char(current_date, 'FMDay'))
  from public.vendors v
 where v.id = current_setting('test.vendor1', true)::uuid;

insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.frederick_id', true)::uuid,
       'monday',
       current_setting('test.vendor2', true)::uuid,
       v.name,
       lower(to_char(current_date, 'FMDay'))
  from public.vendors v
 where v.id = current_setting('test.vendor2', true)::uuid;

-- Two fresh catalog_ingredients (case_qty defaults to 1 → plain base-unit
-- pricing, so estimated_cost = suggested_qty * cost_per_unit exactly).
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  values
    (current_setting('test.brand_id', true)::uuid, 'SPEC102-RX-SHARED-'||gen_random_uuid()::text, 'each'),
    (current_setting('test.brand_id', true)::uuid, 'SPEC102-RX-FBACK-'||gen_random_uuid()::text,  'each')
  returning id, name
)
select id, name,
       case when name like 'SPEC102-RX-SHARED%' then 'shared' else 'fback' end as kind
  from ins;

-- Two Frederick items. par=10, current_stock=0, usage_per_portion=0 →
-- suggested_qty = greatest(par_level, 0) = 10 for both.
--   SHARED → cost_per_unit 999 (sentinel: must NEVER be read for SHARED —
--            its cards are priced from the junction, not the item).
--   FBACK  → cost_per_unit 3   (read ONLY via the OQ-5 fallback when the
--            junction cost is 0).
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid,
     (select id from _cat where kind = 'shared'),
     current_setting('test.vendor1', true)::uuid,
     999, 0, 10, 0),
    (current_setting('test.frederick_id', true)::uuid,
     (select id from _cat where kind = 'fback'),
     current_setting('test.vendor1', true)::uuid,
     3, 0, 10, 0)
  returning id, catalog_id
)
select i.id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
begin
  perform set_config('test.item_shared', (select id from _items where kind = 'shared')::text, true);
  perform set_config('test.item_fback',  (select id from _items where kind = 'fback')::text,  true);
end $$;

-- item_vendors links:
--   SHARED → V1 @ $5 (primary) + V2 @ $8 (DISTINCT per-vendor costs).
--   FBACK  → V1 @ $0 → triggers OQ-5 fallback to the item cost ($3).
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  (current_setting('test.item_shared', true)::uuid, current_setting('test.vendor1', true)::uuid, 5, 0, true),
  (current_setting('test.item_shared', true)::uuid, current_setting('test.vendor2', true)::uuid, 8, 0, false),
  (current_setting('test.item_fback', true)::uuid,  current_setting('test.vendor1', true)::uuid, 0, 0, true)
on conflict (item_id, vendor_id) do nothing;

-- ─── Call the runner with as_of_date = today ───────────────────
create temp table _env on commit drop as
select public.report_reorder_list(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
) as env;

-- Flatten to (vendor_id, item_id, item-json) across all cards.
create temp table _rows on commit drop as
select v->>'vendor_id' as vendor_id,
       i->>'item_id'   as item_id,
       i               as item
  from _env, jsonb_array_elements(env->'vendors') v
            , jsonb_array_elements(v->'items') i;

-- ─── (2)/(3) shared item under BOTH vendor cards ────────────────
select is(
  (select count(*)::bigint from _rows
    where item_id = current_setting('test.item_shared', true)
      and vendor_id = current_setting('test.vendor1', true)),
  1::bigint,
  '(2) shared item appears under the V1 vendor card'
);

select is(
  (select count(*)::bigint from _rows
    where item_id = current_setting('test.item_shared', true)
      and vendor_id = current_setting('test.vendor2', true)),
  1::bigint,
  '(3) shared item appears under the V2 vendor card (explosion to both)'
);

-- ─── (4)/(5) per-vendor cost — DISTINCT estimated_cost per card ──
select is(
  ((select item from _rows
     where item_id = current_setting('test.item_shared', true)
       and vendor_id = current_setting('test.vendor1', true))->>'estimated_cost')::numeric,
  50::numeric,
  '(4) shared item estimated_cost under V1 = 10 * $5 = 50 (V1 per-vendor cost)'
);

select is(
  ((select item from _rows
     where item_id = current_setting('test.item_shared', true)
       and vendor_id = current_setting('test.vendor2', true))->>'estimated_cost')::numeric,
  80::numeric,
  '(5) shared item estimated_cost under V2 = 10 * $8 = 80 (V2 per-vendor cost — NOT a single item cost)'
);

-- ─── (6)/(7) OQ-1 hint on the shared item ───────────────────────
select is(
  ((select item from _rows
     where item_id = current_setting('test.item_shared', true)
       and vendor_id = current_setting('test.vendor1', true))->>'other_vendor_count')::int,
  1,
  '(6) shared item other_vendor_count = 1 under the V1 card'
);

select ok(
  exists (
    select 1
      from _rows, jsonb_array_elements(
        (select item from _rows
          where item_id = current_setting('test.item_shared', true)
            and vendor_id = current_setting('test.vendor1', true))->'also_from_vendors') l
     where (l->>'vendor_id') = current_setting('test.vendor2', true)
  ),
  '(7) shared item also_from_vendors names V2 under the V1 card'
);

-- ─── (8)/(9) OQ-5 fallback item ─────────────────────────────────
select is(
  (select count(*)::bigint from _rows
    where item_id = current_setting('test.item_fback', true)
      and vendor_id = current_setting('test.vendor1', true)),
  1::bigint,
  '(8) fallback item appears under the V1 vendor card'
);

select is(
  ((select item from _rows
     where item_id = current_setting('test.item_fback', true)
       and vendor_id = current_setting('test.vendor1', true))->>'estimated_cost')::numeric,
  30::numeric,
  '(9) fallback item estimated_cost = 10 * $3 = 30 (junction cost 0 → falls back to item cost)'
);

-- ─── (10) fallback item is single-vendor → other_vendor_count 0 ─
select is(
  ((select item from _rows
     where item_id = current_setting('test.item_fback', true)
       and vendor_id = current_setting('test.vendor1', true))->>'other_vendor_count')::int,
  0,
  '(10) fallback item other_vendor_count = 0 (single-vendor — existing rendering unaffected)'
);

-- ─── (11) explosion cardinality — shared item in EXACTLY 2 cards ─
select is(
  (select count(distinct vendor_id)::bigint from _rows
    where item_id = current_setting('test.item_shared', true)),
  2::bigint,
  '(11) shared item appears in exactly two vendor cards (no triple, no drop)'
);

select * from finish();
rollback;

-- supabase/tests/report_reorder_list_on_hand_source.test.sql
--
-- Spec 023 / A11 — retroactive coverage for spec 021's EOD-first
-- sourcing rule. Pins the per-vendor `on_hand_source` rollup at
-- `supabase/migrations/20260514130000_report_reorder_list.sql:480-516`:
--
--   • Vendor has an EOD submission for today AND at least one item
--     drew its on_hand from that submission's actual_remaining
--     → `on_hand_source = 'eod'`.
--   • Vendor has no EOD submission for today
--     → `on_hand_source = 'stock'` (per-item on_hand falls back to
--       inventory_items.current_stock).
--
-- Two scenarios in one plan inside one begin/rollback frame (per
-- architect §1 / A11 — recommend one plan with two asserts):
--   (a) Vendor A: today's EOD exists, on_hand_source = 'eod'.
--   (b) Vendor B: no EOD today, on_hand_source = 'stock'.

begin;
create extension if not exists pgtap;

select plan(3);

-- ─── fixtures ──────────────────────────────────────────────────
-- Resolve Frederick + two vendors (A, B) each owning at least one
-- inventory_item in Frederick. par_level > current_stock ensures the
-- item survives the suggested_qty >= 0.001 filter and appears in
-- the per-vendor items[].
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick  uuid;
  v_vendor_a   uuid;
  v_vendor_b   uuid;
  v_item_a     uuid;
  v_item_b     uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;

  -- Two distinct vendors, each with at least one item in Frederick.
  -- The seed has 11 vendors across multiple items.
  select v.id into v_vendor_a
    from public.vendors v
   where exists (
     select 1 from public.inventory_items ii
      where ii.store_id = v_frederick and ii.vendor_id = v.id
   )
   order by v.id asc
   limit 1;

  select v.id into v_vendor_b
    from public.vendors v
   where v.id <> v_vendor_a
     and exists (
       select 1 from public.inventory_items ii
        where ii.store_id = v_frederick and ii.vendor_id = v.id
     )
   order by v.id asc
   limit 1;

  -- Pick one item per vendor in Frederick.
  select id into v_item_a from public.inventory_items
   where store_id = v_frederick and vendor_id = v_vendor_a
   limit 1;
  select id into v_item_b from public.inventory_items
   where store_id = v_frederick and vendor_id = v_vendor_b
   limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.vendor_a',     v_vendor_a::text,   true);
  perform set_config('test.vendor_b',     v_vendor_b::text,   true);
  perform set_config('test.item_a',       v_item_a::text,     true);
  perform set_config('test.item_b',       v_item_b::text,     true);
end $$;

select isnt(current_setting('test.vendor_a', true), '',
  'fixture: two distinct Frederick-active vendors + items resolve');

-- ─── Force par_level + current_stock so both items appear ──────
-- Run under master JWT (privileged) for inventory_items UPDATEs.
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

-- Item A: par 50, current_stock 0 → par_replacement = 50.
-- We'll INSERT an EOD entry with actual_remaining = 30, so item A's
-- on_hand drives from EOD (30) instead of current_stock (0). vendor A
-- rollup → 'eod'.
update public.inventory_items
   set par_level = 50, current_stock = 0
 where id = current_setting('test.item_a', true)::uuid;

-- Item B: par 50, current_stock 0 → par_replacement = 50.
-- No EOD for vendor B → on_hand drives from current_stock (0). vendor
-- B rollup → 'stock'.
update public.inventory_items
   set par_level = 50, current_stock = 0
 where id = current_setting('test.item_b', true)::uuid;

-- ─── Manager submits today's EOD for vendor A only ────────────
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- Use current_date for "today" so the report's default as_of matches.
create temp table _sub_a on commit drop as
with ins as (
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values (current_setting('test.frederick_id', true)::uuid,
          current_date,
          current_setting('test.vendor_a', true)::uuid,
          'submitted',
          gen_random_uuid())
  returning id
)
select id from ins;

do $$
declare v_id uuid;
begin
  select id into v_id from _sub_a limit 1;
  perform set_config('test.sub_a', v_id::text, true);
end $$;

insert into public.eod_entries (submission_id, item_id, actual_remaining)
values (
  current_setting('test.sub_a', true)::uuid,
  current_setting('test.item_a', true)::uuid,
  30
);

-- ─── Call the runner with today's as_of_date ──────────────────
create temp table _env on commit drop as
select public.report_reorder_list(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
) as env;

-- Pull both vendor entries.
create temp table _vendors on commit drop as
select v->>'vendor_id' as vendor_id, v as entry
  from _env, jsonb_array_elements(env->'vendors') v;

-- ─── (1) Vendor A: on_hand_source = 'eod' ─────────────────────
select is(
  ((select entry from _vendors where vendor_id = current_setting('test.vendor_a', true)) ->> 'on_hand_source'),
  'eod',
  'vendor A has EOD today → on_hand_source = eod'
);

-- ─── (2) Vendor B: on_hand_source = 'stock' ───────────────────
select is(
  ((select entry from _vendors where vendor_id = current_setting('test.vendor_b', true)) ->> 'on_hand_source'),
  'stock',
  'vendor B has no EOD today → on_hand_source = stock (fallback)'
);

select * from finish();
rollback;

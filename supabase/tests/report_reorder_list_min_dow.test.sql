-- supabase/tests/report_reorder_list_min_dow.test.sql
--
-- Spec 023 / A5 — retroactive coverage for spec 021's MIN-DOW lateral
-- subquery bug fix. Round-1 of spec 021 minimized over the raw
-- day_of_week NUMBER instead of the per-day OFFSET DISTANCE,
-- producing wrong `days_until_next_delivery` for multi-delivery-day
-- vendors. See `specs/021-reorder-delivery-list/reviews/release-proposal.md:69`.
--
-- The migration at
-- `supabase/migrations/20260514130000_report_reorder_list.sql:344-397`
-- now computes per-day distance INSIDE the lateral, then MINs the
-- distances. Same-day-with-cutoff cases force distance=7.
--
-- Test scenarios (all run with as_of_date = 2026-05-14 = Thursday):
--   (a) Multi-delivery-day vendor — Wednesday + Friday schedule.
--       Pre-fix: MIN(3,5)=3 → offset=(3-4+7)%7=6 (Wednesday). WRONG.
--       Post-fix: per-row Wed→6, Fri→1; MIN=1. CORRECT (Friday next).
--   (b) Same delivery_day = Thursday, cutoff BEFORE wall-clock —
--       distance forced to 7 (next cycle).
--   (c) Same delivery_day = Thursday, cutoff = end-of-day 23:59:59 —
--       distance = 0 (truck arrives today; pre-cutoff). The wall-clock
--       flake window is the last millisecond of the UTC day, accepted
--       per the architect's caveat #3.
--
-- Architect's caveat #3 (same-day-cutoff time-of-day flake):
--   The runner reads `v_today_time = (now() at time zone 'utc')::time`.
--   We can't stub now() for the runner; tests pick `order_cutoff_time`
--   values at the day boundary to minimize the flake window. For (c)
--   we use '23:59:59' which means CI only flakes within the last 1s
--   of the UTC day.

begin;
create extension if not exists pgtap;

select plan(5);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick  uuid;
  v_vendor_id  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;

  -- Pick a seed vendor that has at least one inventory_item in
  -- Frederick. The vendor_delivery_offsets CTE filters out vendors
  -- with no items via EXISTS. If a future seed refresh changes the
  -- vendor↔Frederick mapping, this lookup self-corrects.
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
  perform set_config('test.vendor_id',    v_vendor_id::text,  true);
end $$;

select isnt(current_setting('test.vendor_id', true), '',
  'fixture: a Frederick-active seed vendor resolves');

-- ─── master JWT for vendor + schedule mutations ───────────────
-- Vendors are brand-scoped (privileged-only write); we need the
-- privileged JWT to set order_cutoff_time and seed order_schedule.
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

-- Clean pre-existing order_schedule for this (Frederick, vendor) pair
-- so the test owns the entire schedule (no seed-side ambient days).
delete from public.order_schedule
 where store_id  = current_setting('test.frederick_id', true)::uuid
   and vendor_id = current_setting('test.vendor_id',    true)::uuid;

-- ─── Scenario A — Multi-delivery-day vendor (Wed + Fri) ───────
-- Set Wednesday + Friday delivery days. order_cutoff_time = '23:59:00'
-- so the day-boundary code path doesn't fire on Thursday.
update public.vendors
   set order_cutoff_time = '23:59:00'
 where id = current_setting('test.vendor_id', true)::uuid;

-- order_schedule has UNIQUE (store_id, day_of_week, vendor_name) and
-- UNIQUE (store_id, day_of_week, vendor_id) — day_of_week (when the
-- order goes out) varies per row even though we're testing
-- delivery_day (when the truck arrives). Two rows with distinct
-- day_of_week values, both pointing at different delivery_days.
insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.frederick_id', true)::uuid,
       'monday',
       current_setting('test.vendor_id', true)::uuid,
       v.name,
       'wednesday'
  from public.vendors v
 where v.id = current_setting('test.vendor_id', true)::uuid;

insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.frederick_id', true)::uuid,
       'wednesday',
       current_setting('test.vendor_id', true)::uuid,
       v.name,
       'friday'
  from public.vendors v
 where v.id = current_setting('test.vendor_id', true)::uuid;

-- Switch to manager JWT for the actual report call. Manager is a member
-- of Frederick (Towson + Frederick per CLAUDE.md).
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- Pin as-of-date to Thursday 2026-05-14 (extract(dow)=4).
create temp table _env_a on commit drop as
select public.report_reorder_list(
  current_setting('test.frederick_id', true)::uuid,
  '{"as_of_date":"2026-05-14"}'::jsonb
) as env;

-- Extract the vendor entry from the vendors array. Vendor may or may
-- not appear depending on whether any of its items need ordering; we
-- pick by vendor_id directly.
create temp table _vendor_a on commit drop as
select v as vendor
  from _env_a,
       jsonb_array_elements(env->'vendors') as v
 where v->>'vendor_id' = current_setting('test.vendor_id', true);

-- ─── (1) days_until_next_delivery = 1 (Thursday→Friday) ───────
-- Pre-fix this returned 6 (Wednesday-of-next-week via raw-DOW MIN).
-- Post-fix it correctly returns 1.
select is(
  ((select vendor from _vendor_a)->>'days_until_next_delivery')::int,
  1,
  'scenario A: Thursday→Friday = 1 day (NOT 6 from raw-DOW-min bug)'
);

-- ─── (2) next_delivery_date = 2026-05-15 (Friday) ─────────────
select is(
  ((select vendor from _vendor_a)->>'next_delivery_date'),
  '2026-05-15',
  'scenario A: next delivery is Friday 2026-05-15'
);

-- ─── Scenario B — Same delivery day = Thursday, cutoff PASSED ──
-- Switch back to master to mutate schedule + vendor cutoff.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.master_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'master')
  )::text,
  true
);

delete from public.order_schedule
 where store_id  = current_setting('test.frederick_id', true)::uuid
   and vendor_id = current_setting('test.vendor_id',    true)::uuid;

insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.frederick_id', true)::uuid,
       'monday',
       current_setting('test.vendor_id', true)::uuid,
       v.name,
       'thursday'
  from public.vendors v
 where v.id = current_setting('test.vendor_id', true)::uuid;

-- Cutoff at 00:00:01 — by the time CI wall-clock reads any time after
-- this, the cutoff is "passed" and the day is forced to +7.
update public.vendors
   set order_cutoff_time = '00:00:01'
 where id = current_setting('test.vendor_id', true)::uuid;

-- Manager call.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

create temp table _env_b on commit drop as
select public.report_reorder_list(
  current_setting('test.frederick_id', true)::uuid,
  '{"as_of_date":"2026-05-14"}'::jsonb
) as env;

create temp table _vendor_b on commit drop as
select v as vendor
  from _env_b,
       jsonb_array_elements(env->'vendors') as v
 where v->>'vendor_id' = current_setting('test.vendor_id', true);

-- ─── (3) Same-day with cutoff passed → 7 days (next cycle) ─────
select is(
  ((select vendor from _vendor_b)->>'days_until_next_delivery')::int,
  7,
  'scenario B: same delivery day, cutoff passed → 7 (next cycle)'
);

-- ─── Scenario C — Same delivery day = Thursday, cutoff at day end ─
-- order_cutoff_time = '23:59:59' minimizes the wall-clock flake window
-- to the last second of the UTC day. Architect's caveat #3 accepted.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.master_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'master')
  )::text,
  true
);

update public.vendors
   set order_cutoff_time = '23:59:59'
 where id = current_setting('test.vendor_id', true)::uuid;

-- Manager call.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

create temp table _env_c on commit drop as
select public.report_reorder_list(
  current_setting('test.frederick_id', true)::uuid,
  '{"as_of_date":"2026-05-14"}'::jsonb
) as env;

create temp table _vendor_c on commit drop as
select v as vendor
  from _env_c,
       jsonb_array_elements(env->'vendors') as v
 where v->>'vendor_id' = current_setting('test.vendor_id', true);

-- ─── (4) Same-day cutoff at day-end → 0 (truck arrives today) ─
select is(
  ((select vendor from _vendor_c)->>'days_until_next_delivery')::int,
  0,
  'scenario C: same delivery day, cutoff at end-of-day → 0 (today)'
);

select * from finish();
rollback;

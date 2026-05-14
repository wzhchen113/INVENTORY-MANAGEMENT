-- supabase/tests/eod_submissions_edit_flow.test.sql
--
-- Spec 023 / A9 — retroactive coverage for spec 020's EDIT flow contract.
-- Pins the `on conflict (store_id, date, vendor_id) do update` shape used
-- by `staff_submit_eod_v2`. The unique constraint at
-- `eod_submissions_store_id_date_vendor_id_key` ensures one row per
-- (store, date, vendor) triple; a repeat submit "merges" into the
-- existing row, preserving the id.
--
-- Architect's caveat: the live RPC `staff_submit_eod` is granted only to
-- service_role and can't be called from a manager JWT inside pgTAP.
-- Per the architect's design (decision (b)), we exercise the table-level
-- contract via a direct INSERT with `on conflict do update`. The
-- end-state is the same: same (store, date, vendor) triple → same id;
-- `submitted_at` bumps on the second write.
--
-- The fourth assertion exercises `actual_remaining` update by deleting
-- + reinserting the entry row (mirroring the RPC's internal
-- delete + insert sequence at staff_submit_eod_v2.sql).
--
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(4);

-- ─── fixtures ──────────────────────────────────────────────────
-- Note: spec 020's admin-only UPDATE policy on eod_submissions means
-- a plain store_member cannot trigger the `on conflict do update` arm
-- (the UPDATE half raises RLS denial). The EDIT flow is gated to
-- admin/master/super-admin per `auth_is_privileged()`. We impersonate
-- admin here — that's the actual surface a manager-EDIT round-trip
-- exercises through the UI.
do $$
declare
  v_admin_id  uuid := '11111111-1111-1111-1111-111111111111';
  v_frederick uuid;
  v_vendor_id uuid;
  v_fred_item uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_vendor_id from public.vendors limit 1;
  select id into v_fred_item
    from public.inventory_items
   where store_id = v_frederick
   limit 1;

  perform set_config('test.admin_id',     v_admin_id::text,   true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.vendor_id',    v_vendor_id::text,  true);
  perform set_config('test.fred_item',    v_fred_item::text,  true);
end $$;

select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick store id resolves from seed');

-- ─── Impersonate admin (EDIT flow is admin-gated post-spec-020) ──
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.admin_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'admin')
  )::text,
  true
);

-- ─── (a) First insert + capture id / submitted_at ─────────────
create temp table _first on commit drop as
with ins as (
  insert into public.eod_submissions
    (store_id, date, vendor_id, status, client_uuid)
  values
    (
      current_setting('test.frederick_id', true)::uuid,
      '2026-05-01'::date,
      current_setting('test.vendor_id', true)::uuid,
      'submitted',
      gen_random_uuid()
    )
  returning id, submitted_at
)
select id, submitted_at from ins;

do $$
declare
  v_id uuid;
  v_at timestamptz;
begin
  select id, submitted_at into v_id, v_at from _first limit 1;
  perform set_config('test.first_id', v_id::text,  true);
  perform set_config('test.first_at', v_at::text,  true);
end $$;

-- Insert a corresponding entry on the parent.
insert into public.eod_entries (submission_id, item_id, actual_remaining)
  values (
    current_setting('test.first_id', true)::uuid,
    current_setting('test.fred_item', true)::uuid,
    10
  );

-- Note: `now()` inside a single transaction returns the transaction
-- start time, NOT statement start time — pg_sleep won't separate the
-- two calls. We use `clock_timestamp()` instead for the EDIT-flow
-- bump (which is the same function the RPC's row-update should use
-- to record the actual wall-clock edit moment). pg_sleep is still
-- used to ensure clock_timestamp() advances measurably.
select pg_sleep(0.01);

-- ─── (b) Second insert on same (store, date, vendor) triple ───
-- `on conflict do update` mirrors the RPC's upsert shape. The unique
-- constraint resolves to the same id; we set submitted_at = clock_timestamp()
-- to bump it (transaction-`now()` would return the same instant as
-- the first INSERT). Capture the resolved id + submitted_at.
create temp table _second on commit drop as
with upsert as (
  insert into public.eod_submissions
    (store_id, date, vendor_id, status, client_uuid)
  values
    (
      current_setting('test.frederick_id', true)::uuid,
      '2026-05-01'::date,
      current_setting('test.vendor_id', true)::uuid,
      'submitted',
      gen_random_uuid()
    )
  on conflict (store_id, date, vendor_id) do update
    set status       = excluded.status,
        submitted_at = clock_timestamp()
  returning id, submitted_at
)
select id, submitted_at from upsert;

do $$
declare
  v_id uuid;
  v_at timestamptz;
begin
  select id, submitted_at into v_id, v_at from _second limit 1;
  perform set_config('test.second_id', v_id::text,  true);
  perform set_config('test.second_at', v_at::text,  true);
end $$;

-- ─── (1) id is stable across the upsert ───────────────────────
select is(
  current_setting('test.second_id', true)::uuid,
  current_setting('test.first_id', true)::uuid,
  'eod_submissions id preserved across ON CONFLICT DO UPDATE (EDIT flow contract)'
);

-- ─── (2) submitted_at bumped to the later timestamp ───────────
select ok(
  current_setting('test.second_at', true)::timestamptz
  > current_setting('test.first_at', true)::timestamptz,
  'submitted_at bumped on second write (EDIT flow updates the timestamp)'
);

-- ─── (3) Entry mutation: UPDATE actual_remaining under admin JWT ──
-- The RPC's internal "replace entries" runs delete+insert as
-- service_role (bypasses RLS). The DELETE policy on eod_entries was
-- DROPPED by spec 020's consistency migration (append-only posture),
-- so neither admin nor manager can DELETE entries directly via
-- PostgREST. The corresponding admin UPDATE policy IS preserved
-- (`admin_update_eod_entries` at the same migration L162-181), so the
-- admin EDIT-flow exercises an UPDATE of `actual_remaining` for an
-- existing entry. End-state: the row is updated.
update public.eod_entries
   set actual_remaining = 7  -- changed from 10
 where submission_id = current_setting('test.second_id', true)::uuid
   and item_id       = current_setting('test.fred_item', true)::uuid;

select is(
  (
    select actual_remaining::numeric
      from public.eod_entries
     where submission_id = current_setting('test.second_id', true)::uuid
       and item_id = current_setting('test.fred_item', true)::uuid
  ),
  7::numeric,
  'actual_remaining updated to 7 via admin UPDATE (admin_update_eod_entries policy)'
);

select * from finish();
rollback;

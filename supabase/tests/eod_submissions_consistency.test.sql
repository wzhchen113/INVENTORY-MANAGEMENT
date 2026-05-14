-- supabase/tests/eod_submissions_consistency.test.sql
--
-- Spec 023 / A4 — retroactive coverage for spec 020's three EOD-consistency
-- arms. Mirrors the shape of `inventory_counts_set_submitted_by.test.sql`
-- (the spec 022 example for the analogous spec 019 trigger).
--
-- Three arms covered:
--   Arm i  (submitted_by override on eod_submissions) —
--     `supabase/migrations/20260514120030_eod_submissions_consistency.sql:78-94`.
--     Direct INSERT with a forged `submitted_by`; trigger rewrites to
--     auth.uid().
--   Arm ii (cross-store item_id rejection on eod_entries) —
--     same migration, lines 104-138. Direct INSERT of an eod_entries row
--     whose item.store_id != submission.store_id raises 42501.
--   Arm iii (defense-in-depth: trigger is permissive on columns it does
--     not check). Per the architect's caveat #1, the migration does NOT
--     declare a vendor_id consistency trigger on eod_entries —
--     eod_entries has no vendor_id column. The PM-prompt's vendor-scoped
--     current_stock write enforcement is the RPC-layer concern, gated to
--     service_role and not reachable from pgTAP under a manager JWT. We
--     defensively confirm the trigger is permissive on the columns it
--     doesn't check (by verifying same-store entry inserts succeed).
--
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(6);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id   uuid := '22222222-2222-2222-2222-222222222222';
  v_master_id    uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick    uuid;
  v_charles      uuid;
  v_vendor_id    uuid;
  v_fred_item    uuid;
  v_charles_item uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;

  -- Pick any seed vendor. Vendors are brand-scoped so any vendor works.
  select id into v_vendor_id from public.vendors limit 1;

  -- Frederick item for arm-i parent submission's matching entry.
  select id into v_fred_item
    from public.inventory_items
   where store_id = v_frederick
   limit 1;

  -- Charles item for arm-ii cross-store INSERT.
  select id into v_charles_item
    from public.inventory_items
   where store_id = v_charles
   limit 1;

  perform set_config('test.manager_id',    v_manager_id::text,    true);
  perform set_config('test.master_id',     v_master_id::text,     true);
  perform set_config('test.frederick_id',  v_frederick::text,     true);
  perform set_config('test.charles_id',    v_charles::text,       true);
  perform set_config('test.vendor_id',     v_vendor_id::text,     true);
  perform set_config('test.fred_item',     v_fred_item::text,     true);
  perform set_config('test.charles_item',  v_charles_item::text,  true);
end $$;

select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick store id resolves from seed');

-- ─── Impersonate manager ──────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- ─── Arm (i): submitted_by override on direct INSERT ───────────
-- INSERT eod_submissions with `submitted_by = master_id` (forged).
-- Trigger should rewrite it to manager_id (= auth.uid()).
create temp table _sub on commit drop as
with ins as (
  insert into public.eod_submissions
    (store_id, date, vendor_id, submitted_by, status)
  values
    (
      current_setting('test.frederick_id', true)::uuid,
      '2026-05-01'::date,
      current_setting('test.vendor_id', true)::uuid,
      current_setting('test.master_id', true)::uuid,  -- forged
      'submitted'
    )
  returning id
)
select id from ins;

do $$
declare
  v_id uuid;
begin
  select id into v_id from _sub limit 1;
  perform set_config('test.submission_id', v_id::text, true);
end $$;

select is(
  (
    select submitted_by
      from public.eod_submissions
     where id = current_setting('test.submission_id', true)::uuid
  ),
  current_setting('test.manager_id', true)::uuid,
  'arm (i): trigger overrides forged submitted_by with auth.uid()'
);

-- Defense in depth: confirm master_id is NOT the persisted value.
select isnt(
  (
    select submitted_by
      from public.eod_submissions
     where id = current_setting('test.submission_id', true)::uuid
  ),
  current_setting('test.master_id', true)::uuid,
  'arm (i, defense): persisted submitted_by is NOT the forged master_id'
);

-- ─── Arm (ii): cross-store item_id on eod_entries rejected ─────
-- The parent submission is for Frederick; the item belongs to Charles.
-- Trigger eod_entries_check_store raises 42501 with message
-- 'item store mismatch'.
select throws_ok(
  format(
    $q$insert into public.eod_entries (submission_id, item_id, actual_remaining)
       values (%L::uuid, %L::uuid, 5)$q$,
    current_setting('test.submission_id', true),
    current_setting('test.charles_item', true)
  ),
  '42501',
  null,
  'arm (ii): cross-store item_id on eod_entries rejected by trigger'
);

-- ─── Arm (iii): defense-in-depth — same-store entry INSERT works
-- Per the architect's caveat #1 (no vendor_id trigger on eod_entries
-- because eod_entries has no vendor_id column), an entry whose item
-- belongs to the SAME store as the parent submission inserts cleanly.
-- This pins the trigger as permissive-on-uncovered-columns; future
-- migrations that add a too-strict trigger would break this assertion.
insert into public.eod_entries (submission_id, item_id, actual_remaining)
  values (
    current_setting('test.submission_id', true)::uuid,
    current_setting('test.fred_item', true)::uuid,
    10
  );

select is(
  (
    select count(*)::bigint
      from public.eod_entries
     where submission_id = current_setting('test.submission_id', true)::uuid
       and item_id = current_setting('test.fred_item', true)::uuid
  ),
  1::bigint,
  'arm (iii, defense): same-store entry inserts cleanly — trigger does NOT over-reject'
);

-- Final sanity: only the same-store entry persisted (cross-store rejected).
select is(
  (
    select count(*)::bigint
      from public.eod_entries
     where submission_id = current_setting('test.submission_id', true)::uuid
  ),
  1::bigint,
  'arm (iii, defense): exactly one entry on the submission (cross-store INSERT rolled back)'
);

select * from finish();
rollback;

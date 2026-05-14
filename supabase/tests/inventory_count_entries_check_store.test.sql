-- supabase/tests/inventory_count_entries_check_store.test.sql
--
-- Spec 023 / A3 — retroactive coverage for spec 019's second trigger arm
-- (security-auditor C-Sec-2: cross-store `item_id` spoof via direct entry
-- INSERT). The companion trigger arm (submitted_by override on
-- inventory_counts) is already covered by
-- `inventory_counts_set_submitted_by.test.sql`; this file covers the
-- second arm.
--
-- Trigger under test:
-- `supabase/migrations/20260513120000_inventory_counts_consistency.sql:79-113`
-- — BEFORE INSERT/UPDATE on `inventory_count_entries` that reads parent
-- count's `store_id` and the entry's `item_id.store_id`, refusing the
-- write if they mismatch. Raises SQLSTATE 42501 with message containing
-- 'item store mismatch'.
--
-- Attack vector: a member of store A creates a count for store A, then
-- attempts to attach an entry whose `item_id` belongs to store B.
-- Without the trigger, the entries RLS scopes through the parent via
-- EXISTS but never asserts the cross-store relationship.
--
-- Hermetic isolation: begin; ... rollback; — all inserts discarded.

begin;
create extension if not exists pgtap;

select plan(3);

-- ─── fixtures ──────────────────────────────────────────────────
-- Strategy: master sees all stores so we can pick a Charles item id
-- WITHOUT cross-store RLS denying the fixture lookup. Then we switch
-- to manager (Frederick + Towson member, NOT Charles) and attempt the
-- cross-store INSERT. The trigger's exception is the load-bearing
-- assertion.
do $$
declare
  v_manager_id  uuid := '22222222-2222-2222-2222-222222222222';
  v_master_id   uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick   uuid;
  v_charles     uuid;
  v_charles_item uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;

  -- Pick any Charles inventory_item. Run as postgres for the fixture
  -- lookup so we don't need to fiddle with RLS for the pick.
  select id into v_charles_item
    from public.inventory_items
   where store_id = v_charles
   limit 1;

  perform set_config('test.manager_id',    v_manager_id::text,  true);
  perform set_config('test.master_id',     v_master_id::text,   true);
  perform set_config('test.frederick_id',  v_frederick::text,   true);
  perform set_config('test.charles_id',    v_charles::text,     true);
  perform set_config('test.charles_item',  v_charles_item::text, true);
end $$;

select isnt(current_setting('test.charles_item', true), '',
  'fixture: a Charles inventory_item resolves from seed');

-- ─── manager INSERTs a Frederick count (succeeds) ─────────────
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

create temp table _parent on commit drop as
with ins as (
  insert into public.inventory_counts
    (store_id, kind, status, notes)
  values
    (current_setting('test.frederick_id', true)::uuid,
     'spot',
     'submitted',
     'spec-023 A3 parent count')
  returning id
)
select id from ins;

-- Stash the Frederick count_id.
do $$
declare
  v_count_id uuid;
begin
  select id into v_count_id from _parent limit 1;
  perform set_config('test.frederick_count', v_count_id::text, true);
end $$;

-- ─── (1) Cross-store entry INSERT is rejected by trigger ──────
-- The trigger raises 42501 with message 'item store mismatch'.
-- format() interpolates the captured UUIDs inside a $q$...$q$ quoted
-- string per the COGS-example pattern.
-- Asserting BOTH the SQLSTATE (42501) AND the EXACT error message text
-- (pgTAP throws_ok 3rd arg is an exact match — use throws_like/throws_matching
-- for partial). Without the message arg a different 42501-raising trigger
-- could pass this test silently.
select throws_ok(
  format(
    $q$insert into public.inventory_count_entries (count_id, item_id, actual_remaining)
       values (%L::uuid, %L::uuid, 5)$q$,
    current_setting('test.frederick_count', true),
    current_setting('test.charles_item', true)
  ),
  '42501',
  'inventory_count_entries: item store mismatch with parent count',
  'cross-store item_id rejected by inventory_count_entries_check_store trigger'
);

-- ─── (2) Defense in depth: no entry persisted ────────────────
-- The trigger raised — the row must not exist. Asserting 0 rows on the
-- parent's child set rules out any silent-skip path.
select is(
  (select count(*) from public.inventory_count_entries
    where count_id = current_setting('test.frederick_count', true)::uuid),
  0::bigint,
  'no entry persisted for cross-store attempt (trigger short-circuited the INSERT)'
);

select * from finish();
rollback;

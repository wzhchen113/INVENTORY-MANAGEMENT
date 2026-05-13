-- supabase/tests/inventory_counts_set_submitted_by.test.sql
--
-- Spec 022 Track 2 example: covers the BEFORE INSERT/UPDATE trigger
-- `public.inventory_counts_set_submitted_by` (spec 019 round-2,
-- migration 20260513120000_inventory_counts_consistency.sql:48-70).
--
-- The trigger fix closes a C-Sec-1-class attribution-forgery vector:
-- without it, a direct PostgREST INSERT can set `submitted_by` to any
-- UUID because the RLS INSERT policy only gates on
-- `auth_can_see_store(store_id)` — the column had no DEFAULT and no
-- write-time override.
--
-- This file asserts the trigger's behaviour mechanically — INSERT a
-- row with a forged `submitted_by` value, read it back, and confirm
-- the persisted value equals `auth.uid()` not the forged value.
-- That's the only thing the trigger does; that's the only thing
-- the v1 example test asserts.
--
-- Hermetic isolation via begin; ... rollback; — the forged INSERT is
-- discarded along with everything else when the file ends.

begin;
create extension if not exists pgtap;

select plan(3);

-- ─── fixtures ──────────────────────────────────────────────────
-- Seed users: manager (Towson + Frederick), master (all stores). We
-- impersonate manager and INSERT into Frederick (a store they are a
-- member of). The forged `submitted_by` we pass in is master_id; the
-- trigger must rewrite it to manager_id (which is `auth.uid()`).
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
end $$;

select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick store id resolves from seed');

-- ─── (1) Trigger overrides forged submitted_by ────────────────
-- Impersonate manager. Insert with `submitted_by = master_id` (forged).
-- The trigger should overwrite it with auth.uid() (= manager_id).
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

-- Insert directly (not via RPC) — the RPC has its own server-side
-- `submitted_by := auth.uid()` write, so going via the RPC would
-- defeat the test. The point of the trigger is that the *table-level*
-- override fires even for a direct PostgREST INSERT.
--
-- Postgres doesn't accept `create temp table ... as insert into ...
-- returning ...` directly, so wrap the INSERT in a CTE and read out
-- the returning row into the temp table that way. Same end-state.
create temp table _inserted on commit drop as
with ins as (
  insert into public.inventory_counts
    (store_id, kind, submitted_by, status, client_uuid, notes)
  values
    (
      current_setting('test.frederick_id', true)::uuid,
      'spot',
      current_setting('test.master_id', true)::uuid,    -- forged
      'submitted',
      null,
      'spec-022 trigger test'
    )
  returning id
)
select id from ins;

-- Read back. The trigger should have rewritten submitted_by to
-- manager_id (auth.uid()) regardless of what the client passed.
select is(
  (
    select submitted_by
      from public.inventory_counts ic
      join _inserted i on i.id = ic.id
  ),
  current_setting('test.manager_id', true)::uuid,
  'trigger overrides forged submitted_by with auth.uid()'
);

-- Defense in depth: confirm the master_id we tried to forge with did
-- NOT end up on the row. (Subsumed by the above is() but explicit
-- here for grep-ability when this regresses.)
select isnt(
  (
    select submitted_by
      from public.inventory_counts ic
      join _inserted i on i.id = ic.id
  ),
  current_setting('test.master_id', true)::uuid,
  'persisted submitted_by is NOT the forged master_id'
);

select * from finish();
rollback;

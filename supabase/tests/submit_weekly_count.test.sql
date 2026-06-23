-- supabase/tests/submit_weekly_count.test.sql
--
-- Spec 098 §10 — the staff weekly-count write RPC.
--
-- Asserts the four contract guarantees of public.submit_weekly_count:
--   1. Non-member is rejected (42501) — auth_can_see_store gate fires.
--   2. Idempotent on client_uuid — a replay returns conflict:true with the
--      same count_id and inserts NO second row.
--   3. submitted_by is the server-canonical auth.uid() — a value the client
--      could try to forge never appears (the RPC sets auth.uid() and the
--      table trigger also overrides; either way the persisted row is the
--      caller).
--   4. Advisory-snapshot guarantee — inventory_items.current_stock is
--      UNCHANGED after a weekly submit (no UPDATE inventory_items in the RPC).
--
-- Hermetic: begin; ... rollback; — every insert discarded at file end.

begin;
create extension if not exists pgtap;

select plan(10);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_charles    uuid;
  v_item       uuid;
  v_stock      numeric;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;

  -- Pick a Frederick item + capture its current_stock for the no-write check.
  select id, current_stock into v_item, v_stock
    from public.inventory_items
   where store_id = v_frederick
   limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.charles_id',   v_charles::text,    true);
  perform set_config('test.item_id',      v_item::text,       true);
  perform set_config('test.item_stock',   coalesce(v_stock, 0)::text, true);
end $$;

select isnt(current_setting('test.item_id', true), '',
  'fixture: a Frederick inventory_item resolves from seed');

-- Impersonate the manager (member of Frederick, NOT Charles).
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.manager_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

-- ─── (1) Non-member store rejected with 42501 ────────────────
-- Entries built via jsonb_build_array(jsonb_build_object(...)) rather than
-- hand-formatted JSON: %L emits a single-quoted SQL literal (invalid JSON), and
-- here the value is spliced into dynamic SQL too. Passing a SQL expression the
-- database evaluates to jsonb avoids all quoting. The auth_can_see_store gate
-- fires before entries are parsed, but the statement must still be valid SQL.
select throws_ok(
  format(
    $q$select public.submit_weekly_count(
         gen_random_uuid(),
         %L::uuid,
         now(),
         jsonb_build_array(jsonb_build_object('item_id', %L::uuid, 'actual_remaining', 5)),
         null)$q$,
    current_setting('test.charles_id', true),
    current_setting('test.item_id', true)
  ),
  '42501',
  NULL,
  'weekly count for a non-membership store is rejected (auth_can_see_store)'
);

-- ─── (2) First submit succeeds with conflict:false ───────────
select set_config('test.client_uuid', gen_random_uuid()::text, true);

create temp table _first on commit drop as
select public.submit_weekly_count(
  current_setting('test.client_uuid', true)::uuid,
  current_setting('test.frederick_id', true)::uuid,
  now(),
  jsonb_build_array(jsonb_build_object(
    'item_id', current_setting('test.item_id', true)::uuid,
    'actual_remaining', 7
  )),
  'spec-098 weekly test'
) as result;

select is(
  (select (result->>'conflict')::boolean from _first),
  false,
  'first weekly submit returns conflict:false'
);

select isnt(
  (select result->>'count_id' from _first),
  null,
  'first weekly submit returns a count_id'
);

-- Stash the count_id.
do $$
declare v_cid uuid;
begin
  select (result->>'count_id')::uuid into v_cid from _first;
  perform set_config('test.count_id', v_cid::text, true);
end $$;

-- The persisted row is kind='weekly'.
select is(
  (select kind from public.inventory_counts
    where id = current_setting('test.count_id', true)::uuid),
  'weekly',
  'persisted parent row has kind=weekly'
);

-- ─── (3) submitted_by is auth.uid() (the manager), not forgeable ──
select is(
  (select submitted_by from public.inventory_counts
    where id = current_setting('test.count_id', true)::uuid),
  current_setting('test.manager_id', true)::uuid,
  'submitted_by is the server-canonical auth.uid() (manager)'
);

-- ─── (4) Idempotent replay → conflict:true, same id, no 2nd row ──
create temp table _replay on commit drop as
select public.submit_weekly_count(
  current_setting('test.client_uuid', true)::uuid,
  current_setting('test.frederick_id', true)::uuid,
  now(),
  jsonb_build_array(jsonb_build_object(
    'item_id', current_setting('test.item_id', true)::uuid,
    'actual_remaining', 999
  )),
  'replay'
) as result;

select is(
  (select (result->>'conflict')::boolean from _replay),
  true,
  'replay with same client_uuid returns conflict:true'
);

select is(
  (select result->>'count_id' from _replay),
  current_setting('test.count_id', true),
  'replay returns the SAME count_id (no duplicate parent)'
);

select is(
  (select count(*) from public.inventory_counts
    where store_id = current_setting('test.frederick_id', true)::uuid
      and client_uuid = current_setting('test.client_uuid', true)::uuid),
  1::bigint,
  'exactly one parent row for the client_uuid after replay'
);

-- ─── (5) Advisory snapshot: current_stock UNCHANGED ──────────
select is(
  (select coalesce(current_stock, 0) from public.inventory_items
    where id = current_setting('test.item_id', true)::uuid),
  current_setting('test.item_stock', true)::numeric,
  'inventory_items.current_stock is unchanged after a weekly submit'
);

select * from finish();
rollback;

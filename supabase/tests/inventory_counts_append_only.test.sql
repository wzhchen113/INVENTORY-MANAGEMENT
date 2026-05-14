-- supabase/tests/inventory_counts_append_only.test.sql
--
-- Spec 023 / A8 — retroactive coverage for spec 019's append-only posture.
-- Closes C-Sec-3 (UPDATE allows audit-field rewrite) and C-Sec-4 (DELETE
-- allows audit-trail destruction) on `inventory_counts`.
--
-- Spec 019's resolution (`supabase/migrations/20260513120000_inventory_counts_consistency.sql:115-131`)
-- chose **append-only-and-no-edit** for `inventory_counts`. No UPDATE
-- policy and no DELETE policy at all — both store-member and admin
-- callers get 0 rows when attempting UPDATE/DELETE under RLS.
--
-- Important: this differs from `eod_submissions` (spec 020), where the
-- spec Q5 EDIT flow mandated keeping an admin-only UPDATE policy. The
-- PM prompt's "admin can UPDATE → 1 affected" line is the
-- `eod_submissions` semantics, NOT `inventory_counts`. Per the
-- architect's caveat #2 we assert the realised behaviour: ALL 4 cells
-- (manager × {UPDATE, DELETE}, admin × {UPDATE, DELETE}) return 0 rows.
-- We do NOT change the migration to match the prompt — the spec 019
-- design is intentional.
--
-- Behaviour shape: Postgres does NOT raise on RLS-filtered UPDATE/DELETE
-- — it silently returns 0 rows. So we assert on affected-row counts
-- (via CTE returning + outer count) rather than `throws_ok`.

begin;
create extension if not exists pgtap;

select plan(5);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_admin_id   uuid := '11111111-1111-1111-1111-111111111111';
  v_frederick  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.admin_id',     v_admin_id::text,   true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
end $$;

select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick store id resolves from seed');

-- ─── As manager: INSERT a count to mutate later ───────────────
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

create temp table _seed on commit drop as
with ins as (
  insert into public.inventory_counts
    (store_id, kind, status, notes)
  values
    (current_setting('test.frederick_id', true)::uuid,
     'spot', 'submitted', 'spec-023 A8 seed row')
  returning id
)
select id from ins;

do $$
declare
  v_id uuid;
begin
  select id into v_id from _seed limit 1;
  perform set_config('test.count_id', v_id::text, true);
end $$;

-- ─── (1) Manager UPDATE: 0 rows (no UPDATE policy at all) ─────
-- The store_member_update_inventory_counts policy was dropped by spec
-- 019's consistency migration; with no UPDATE policy, RLS denies the
-- write under any non-superuser caller. PostgreSQL returns 0 rows,
-- not an error. We execute the UPDATE in a DO block and capture the
-- ROW_COUNT, stashing into test.* config — pgTAP can then assert on
-- the stashed scalar.
do $$
declare
  v_affected int;
begin
  update public.inventory_counts
     set notes = 'forged-by-manager'
   where id = current_setting('test.count_id', true)::uuid;
  get diagnostics v_affected = row_count;
  perform set_config('test.manager_update_count', v_affected::text, true);
end $$;

select is(
  current_setting('test.manager_update_count', true)::bigint,
  0::bigint,
  'manager UPDATE filtered to 0 rows (no UPDATE policy exists)'
);

-- ─── (2) Manager DELETE: 0 rows (no DELETE policy at all) ─────
do $$
declare
  v_affected int;
begin
  delete from public.inventory_counts
   where id = current_setting('test.count_id', true)::uuid;
  get diagnostics v_affected = row_count;
  perform set_config('test.manager_delete_count', v_affected::text, true);
end $$;

select is(
  current_setting('test.manager_delete_count', true)::bigint,
  0::bigint,
  'manager DELETE filtered to 0 rows (no DELETE policy exists)'
);

-- ─── Switch to admin — same row, same operations ──────────────
-- Admin still gets 0 rows. Spec 019's choice is append-only **for
-- everyone**; spec 020's admin-only UPDATE policy on eod_submissions
-- is the DIFFERENT semantics that does NOT apply here.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.admin_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'admin')
  )::text,
  true
);

-- ─── (3) Admin UPDATE: 0 rows (no UPDATE policy, even for admin)
do $$
declare
  v_affected int;
begin
  update public.inventory_counts
     set notes = 'forged-by-admin'
   where id = current_setting('test.count_id', true)::uuid;
  get diagnostics v_affected = row_count;
  perform set_config('test.admin_update_count', v_affected::text, true);
end $$;

select is(
  current_setting('test.admin_update_count', true)::bigint,
  0::bigint,
  'admin UPDATE also 0 — no UPDATE policy at all (differs from eod_submissions semantics)'
);

-- ─── (4) Admin DELETE: 0 rows (no DELETE policy, even for admin)
do $$
declare
  v_affected int;
begin
  delete from public.inventory_counts
   where id = current_setting('test.count_id', true)::uuid;
  get diagnostics v_affected = row_count;
  perform set_config('test.admin_delete_count', v_affected::text, true);
end $$;

select is(
  current_setting('test.admin_delete_count', true)::bigint,
  0::bigint,
  'admin DELETE also 0 — append-only posture is for all callers'
);

select * from finish();
rollback;

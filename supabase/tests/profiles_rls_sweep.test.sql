-- supabase/tests/profiles_rls_sweep.test.sql
--
-- Spec 043 / pgTAP regression for the two policy tightenings shipped
-- in supabase/migrations/20260517060000_profiles_rls_sweep.sql.
--
-- Twelve arms (plan(12)).
--   Arms (1)-(6): SELECT tightening.
--     (1)   admin SELECT own profile          → admit (1 row).
--     (2)   admin SELECT same-brand peer      → admit (1 row).
--     (3)   admin SELECT cross-brand          → 0 rows (RLS silently
--            filters per Postgres SELECT semantics).
--     (4)   super_admin SELECT cross-brand    → admit (1 row).
--     (5)   regular user SELECT own profile   → admit (1 row).
--     (6)   regular user SELECT other user    → 0 rows.
--   Arms (7)-(9): DELETE tightening.
--     (7)   admin DELETE same-brand user      → admit (row gone).
--     (8)   admin DELETE cross-brand          → 0 rows affected
--            (row still present).
--     (9)   super_admin DELETE cross-brand    → admit (row gone).
--   Arms (10)-(12): no-regression.
--     (10)  authenticated self-DELETE         → rejected with
--            'profile self-delete is not permitted' (spec 041).
--     (11)  assert_not_last_of_role from
--            authenticated context              → fires with P0001
--            'cannot delete the last super_admin' (spec 031 SECURITY
--            DEFINER bypass still works after the new DELETE policy
--            tightening).
--     (12)  brand-admin TRUNCATE on profiles  → 42501 'permission
--            denied for table profiles' (spec 041 round-3 REVOKE).
--
-- Fixture strategy:
--   Mirrors Spec 042's rls_hardening_followups.test.sql verbatim:
--     - seed admin (brand A, 11111…),
--     - seed manager (role 'user', brand A, 22222…),
--     - seed master (brand A, 33333… — promoted to super_admin mid-txn),
--     - one synthetic foreign brand (b2000000-0000-0000-0000-000000000043),
--     - one synthetic same-brand target (a043a043-0000-0000-0000-000000000001,
--       role='user'),
--     - one synthetic foreign-brand target (b043b043-0000-0000-0000-000000000001,
--       role='user'),
--     - synthetic auth.users rows so the profiles FK to auth.users is
--       satisfied.
--   All fixtures roll back at the end of the test transaction.
--
-- JWT-impersonation pattern copied from Spec 042 — set local role
-- authenticated, set_config('request.jwt.claims', …, true).
--
-- Verification SELECT pattern for DELETE arms (7)-(9): use
-- `reset role + select set_config('request.jwt.claims', '', true)`
-- BEFORE the verification COUNT to bypass RLS for the inspection step.
-- Same pattern as rls_hardening_followups.test.sql arms (5)-(6) and
-- the patched arm (9).
--
-- Hermetic isolation: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(12);


-- ─── fixtures (constants stashed via set_config) ───────────────
do $$
declare
  v_admin_id    uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_manager_id  uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', brand A)
  v_master_id   uuid := '33333333-3333-3333-3333-333333333333';  -- seed master (brand A) — promoted to super_admin mid-txn
  v_brand_a     uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b     uuid := 'b2000000-0000-0000-0000-000000000043';  -- test-only foreign brand
  -- Synthetic same-brand target (brand A, role='user'). Distinct
  -- from the seed manager so the DELETE arm doesn't blow away
  -- fixtures other tests use.
  v_target_a    uuid := 'a043a043-0000-0000-0000-000000000001';
  -- Synthetic foreign-brand target (brand B, role='user').
  v_target_b    uuid := 'b043b043-0000-0000-0000-000000000001';
begin
  perform set_config('test.admin_id',    v_admin_id::text,    true);
  perform set_config('test.manager_id',  v_manager_id::text,  true);
  perform set_config('test.master_id',   v_master_id::text,   true);
  perform set_config('test.brand_a',     v_brand_a::text,     true);
  perform set_config('test.brand_b',     v_brand_b::text,     true);
  perform set_config('test.target_a',    v_target_a::text,    true);
  perform set_config('test.target_b',    v_target_b::text,    true);
end $$;


-- Insert the test-only foreign brand. Scoped to this transaction.
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 043)')
on conflict (id) do nothing;


-- Insert synthetic auth.users rows so the profiles FK is satisfied.
-- Match the seed.sql shape (auth.users requires many NOT NULL columns
-- — confirmation_token et al). Idempotent.
insert into auth.users (
  id, instance_id, aud, role,
  email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, is_anonymous,
  confirmation_token, recovery_token,
  email_change_token_new, email_change,
  email_change_token_current, phone_change,
  phone_change_token, reauthentication_token
) values
  (current_setting('test.target_a', true)::uuid,
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'target-a-043@local.test', '',
   now(), now(), now(),
   jsonb_build_object('provider','email','providers',array['email'],'role','user'),
   '{}'::jsonb, false, false,
   '','','','','','','',''),
  (current_setting('test.target_b', true)::uuid,
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'target-b-043@local.test', '',
   now(), now(), now(),
   jsonb_build_object('provider','email','providers',array['email'],'role','user'),
   '{}'::jsonb, false, false,
   '','','','','','','','')
on conflict (id) do nothing;


-- Insert synthetic profiles (one per brand). Both role='user' so
-- the profiles_role_brand_consistent CHECK passes with brand_id
-- non-null.
insert into public.profiles (id, name, role, initials, color, status, brand_id)
values
  (current_setting('test.target_a', true)::uuid,
   'Target A (test 043)', 'user', 'TA', '#888888', 'active',
   current_setting('test.brand_a', true)::uuid),
  (current_setting('test.target_b', true)::uuid,
   'Target B (test 043)', 'user', 'TB', '#888888', 'active',
   current_setting('test.brand_b', true)::uuid)
on conflict (id) do nothing;


-- ============================================================
-- Arms (1)-(6): SELECT tightening
-- ============================================================

-- ─── Arm (1): admin SELECT own profile — admit ───────────────
-- JWT impersonates the seed admin (role='admin', brand A).
-- The new SELECT policy admits via the self-arm (`id = auth.uid()`)
-- — also via the admin+brand arm since admin.brand_id matches.
-- This arm is the no-regression check for the self-arm of the
-- tightened policy.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

select is(
  (select count(*)::int from public.profiles
    where id = current_setting('test.admin_id', true)::uuid),
  1,
  'arm (1): admin can SELECT own profile (self-arm + admin+brand arm)'
);


-- ─── Arm (2): admin SELECT same-brand peer — admit ──────────
-- JWT unchanged. Read the synthetic target_a (brand A). The new
-- SELECT policy admits via the admin arm + auth_can_see_brand
-- (admin.brand_id = target_a.brand_id = brand A).
select is(
  (select count(*)::int from public.profiles
    where id = current_setting('test.target_a', true)::uuid),
  1,
  'arm (2): admin can SELECT same-brand peer profile (admin arm + brand match)'
);


-- ─── Arm (3): admin SELECT cross-brand — 0 rows ─────────────
-- JWT unchanged. Read target_b (brand B). The admin arm's
-- brand check fails (target_b.brand_id != admin.brand_id), the
-- self-arm fails (id != auth.uid()). Postgres RLS surfaces
-- this as 0 rows returned — no error, silent filter.
select is(
  (select count(*)::int from public.profiles
    where id = current_setting('test.target_b', true)::uuid),
  0,
  'arm (3): admin SELECT on cross-brand profile silently returns 0 rows (RLS USING)'
);


-- ─── Arm (4): super_admin SELECT cross-brand — admit ────────
-- Promote the seed master to super_admin (brand_id = NULL per
-- profiles_role_brand_consistent CHECK) mid-transaction. Same
-- pattern as rls_hardening_followups.test.sql arm (7) /
-- auth_can_see_store_brand_scope.test.sql arm (3). Drop into
-- postgres role (with claims cleared) for the fixture UPDATE so
-- it falls outside the Spec 042 round-4 trigger's allowlist
-- (`current_user in ('authenticated','anon')`).
reset role;
select set_config('request.jwt.claims', '', true);

update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.master_id', true)::uuid;

-- Impersonate the in-txn super_admin and read cross-brand. The
-- new SELECT policy admits via auth_can_see_brand short-circuit
-- on auth_is_super_admin.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

select is(
  (select count(*)::int from public.profiles
    where id = current_setting('test.target_b', true)::uuid),
  1,
  'arm (4): super_admin can SELECT cross-brand profile (auth_can_see_brand super-admin short-circuit)'
);


-- ─── Arm (5): regular user SELECT own profile — admit ──────
-- Impersonate the seed manager (role='user', brand A). The new
-- SELECT policy admits via the self-arm (`id = auth.uid()`).
-- The separate `"Users can read own profile"` policy also admits.
-- No-regression check for role='user' callers.
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

select is(
  (select count(*)::int from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  1,
  'arm (5): regular user can SELECT own profile (self-arm — no-regression)'
);


-- ─── Arm (6): regular user SELECT another user — 0 rows ─────
-- JWT unchanged. Read another user's profile (admin_id). The
-- admin arm requires auth_is_privileged() which is false for
-- role='user'; the self-arm fails (id != auth.uid());
-- the "Users can read own profile" policy also requires
-- (id = auth.uid()). All policies' USING fails → 0 rows.
select is(
  (select count(*)::int from public.profiles
    where id = current_setting('test.admin_id', true)::uuid),
  0,
  'arm (6): regular user SELECT on another user profile silently returns 0 rows (no-regression — no cross-user user-tier SELECT)'
);


-- ============================================================
-- Arms (7)-(9): DELETE tightening
-- ============================================================

-- ─── Arm (7): admin DELETE same-brand user — admit ──────────
-- Re-impersonate the seed admin (brand A). DELETE target_a
-- (brand A, role='user'). The new DELETE policy admits via the
-- admin arm + auth_can_see_brand (same brand). Verification
-- COUNT bypasses RLS via `reset role + clear claims` so the
-- inspection step is not gated by the tightened SELECT policy.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

delete from public.profiles
 where id = current_setting('test.target_a', true)::uuid;

reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select count(*)::int from public.profiles
    where id = current_setting('test.target_a', true)::uuid),
  0,
  'arm (7): admin can DELETE same-brand user profile (admin arm + brand match)'
);


-- ─── Arm (8): admin DELETE cross-brand — 0 rows affected ────
-- Re-impersonate the seed admin (brand A). Attempt to DELETE
-- target_b (brand B). The admin arm's brand check fails, the
-- self-arm doesn't exist on this policy. Postgres RLS surfaces
-- this as 0 rows affected — no error, silent rejection. The
-- row should still be present afterwards. Verification COUNT
-- bypasses RLS.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

delete from public.profiles
 where id = current_setting('test.target_b', true)::uuid;

reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select count(*)::int from public.profiles
    where id = current_setting('test.target_b', true)::uuid),
  1,  -- row still exists; DELETE silently affected 0 rows
  'arm (8): admin DELETE on cross-brand profile silently affects 0 rows (RLS USING)'
);


-- ─── Arm (9): super_admin DELETE cross-brand — admit ────────
-- Impersonate the in-txn super_admin (master_id). DELETE
-- target_b (brand B). The new DELETE policy admits via
-- auth_can_see_brand short-circuit on auth_is_super_admin.
-- (master_id was already promoted to super_admin in arm 4's
-- fixture mutation; the promotion persists through this txn.)
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

delete from public.profiles
 where id = current_setting('test.target_b', true)::uuid;

reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select count(*)::int from public.profiles
    where id = current_setting('test.target_b', true)::uuid),
  0,
  'arm (9): super_admin can DELETE cross-brand profile (auth_can_see_brand super-admin short-circuit)'
);


-- ============================================================
-- Arms (10)-(12): no-regression
-- ============================================================

-- ─── Arm (10): authenticated self-DELETE — rejected ─────────
-- Re-impersonate the seed admin (brand A). Attempt to DELETE
-- own profile. The new DELETE policy's USING admits the row
-- through (admin+brand arm — admin can see their own brand,
-- their profile is in their brand), but the Spec 041
-- profiles_self_delete_lock BEFORE-DELETE trigger fires AFTER
-- USING and BEFORE the physical delete. Should raise P0001
-- with the Spec 041 message string. No-regression for Spec 041.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

select throws_ok(
  format(
    $q$delete from public.profiles where id = %L::uuid$q$,
    current_setting('test.admin_id', true)
  ),
  'P0001',
  'profile self-delete is not permitted (use admin delete flow)',
  'arm (10): authenticated self-DELETE is rejected by profiles_self_delete_lock trigger (no-regression for Spec 041)'
);


-- ─── Arm (11): assert_not_last_of_role from authenticated ─────
-- Re-impersonate the seed admin (brand A). Call
-- public.assert_not_last_of_role with target_role='super_admin'
-- against the in-txn master-promoted-to-super_admin. Because
-- master_id is the ONLY super_admin row in this transaction,
-- the helper should raise P0001 'cannot delete the last
-- super_admin'.
--
-- The critical regression check: the helper is SECURITY DEFINER
-- (spec 031), so its internal SELECT from public.profiles runs
-- as the function owner and bypasses RLS — counts every row
-- regardless of the caller's brand-scoped view. The
-- brand-scoped SELECT would exclude rows where brand_id IS NULL,
-- so a SECURITY INVOKER helper called by a brand-admin would
-- count 0 regardless of how many super_admins actually exist.
-- Mechanism: auth_can_see_brand(brand_id) wraps an EXISTS that
-- compares `profiles.brand_id = p_brand_id`; SQL's NULL = NULL
-- yields NULL (treated as false), so a super_admin row (brand_id
-- IS NULL) never satisfies the EXISTS when the caller is not a
-- super_admin. The current SECURITY DEFINER helper bypasses RLS
-- and counts correctly — this arm proves that bypass is still
-- working after the Spec 043 policy tightening.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

select throws_ok(
  format(
    $q$select public.assert_not_last_of_role(%L::uuid, 'super_admin')$q$,
    current_setting('test.master_id', true)
  ),
  'P0001',
  'cannot delete the last super_admin',
  'arm (11): assert_not_last_of_role still works from authenticated context (SECURITY DEFINER bypass survives Spec 043 policy tightening)'
);


-- ─── Arm (12): brand-admin TRUNCATE on profiles — rejected ──
-- JWT impersonates the seed admin (role='admin', brand A).
-- Attempt to TRUNCATE public.profiles. The Spec 041 round-3
-- REVOKE removes TRUNCATE from authenticated, anon. Surfaces
-- as 'permission denied for table profiles' with SQLSTATE
-- 42501 (insufficient_privilege) BEFORE any trigger or RLS
-- policy evaluation. Same shape as
-- auth_can_see_store_brand_scope.test.sql arm (14).
-- No-regression for Spec 041 round-3 fix.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

select throws_ok(
  $q$truncate table public.profiles$q$,
  '42501',
  'permission denied for table profiles',
  'arm (12): brand-admin TRUNCATE on public.profiles is rejected with insufficient_privilege (42501) — no-regression for Spec 041 round-3 REVOKE'
);


select * from finish();
rollback;

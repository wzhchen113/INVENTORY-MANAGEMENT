-- supabase/tests/demote_self_guard.test.sql
--
-- Spec 050 / pgTAP regression for the self-demote refusal implemented
-- as public.demote_profile_to_user(uuid) in
-- supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql.
--
-- Tests the canonical SQL helper directly — the same function the
-- demoteProfileToUser client wrapper at src/lib/db.ts:2757 calls via
-- supabase.rpc(). One source of truth, one regression detector
-- (load-bearing track per spec AC C; smoke arm in
-- scripts/smoke-edge-roles.sh is defense-in-depth).
--
-- Sibling self-action guard: `'cannot delete self'` at
-- supabase/functions/delete-user/index.ts:168-173. Both refuse
-- `caller.id == target.id` with stable, byte-for-byte strings — the SQL
-- side here, the TS side there. A future reviewer who finds one is
-- reminded the other exists.
--
-- Four arms (plan(6) — Arm (ii) contributes 3 assertions: lives_ok + role
-- post-check + brand_id post-check). Architect's ordering: happy-path arm
-- sits BETWEEN
-- the load-bearing self-refusal (i) and the role-gate arm (iii) so the
-- happy-path UPDATE (which mutates the seed manager row's brand_id) is
-- rolled back inside the same hermetic txn.
--
--   Arm (i)   — admin caller self-targets. Sets request.jwt.claims so
--               auth.uid() returns seed admin (11111…) and
--               app_metadata.role='admin'. throws_ok P0001
--               'cannot demote self'. LOAD-BEARING — the regression
--               detector.
--   Arm (ii)  — admin caller, non-self target. Same JWT context as (i),
--               target is the seed manager (22222…). lives_ok + asserts
--               role='user' and brand_id is null post-call. Happy-path.
--   Arm (iii) — non-privileged caller. JWT sets auth.uid() to the seed
--               manager (whose profiles.role is 'user' per seed) and
--               app_metadata.role='user'. auth_is_privileged() returns
--               false → throws_ok 42501 'forbidden'. Authz check:
--               non-privileged caller refused BEFORE the self-check
--               fires (cheaper-fail-first ordering inside the RPC).
--   Arm (iv)  — null caller. No request.jwt.claims set → auth.uid() is
--               null. throws_ok P0001 'cannot demote self'. Defense-in-
--               depth: null caller refused with the unified string (a
--               distinct 'caller is null' string would leak auth-state
--               to a probing caller).
--
-- Hermetic begin; ... rollback; isolation. Mirrors the shape of
-- supabase/tests/delete_last_privileged_guard.test.sql and
-- supabase/tests/invitations_super_admin_rls.test.sql.
--
-- JWT-context idiom: set local role authenticated; +
-- set_config('request.jwt.claims', …, true). The RPC is SECURITY
-- DEFINER and reads auth.uid() per-call, so the JWT context applies.

begin;
create extension if not exists pgtap;

-- plan(6): four functional arms; arm (ii) contributes 3 assertions
-- (lives_ok + role-after + brand_id-after) for a total of 6.
select plan(6);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_admin_id   uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A, role='admin')
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (brand A, role='user')
begin
  perform set_config('test.admin_id',   v_admin_id::text,   true);
  perform set_config('test.manager_id', v_manager_id::text, true);
end $$;

-- ─── Arm (i): admin self-target refused ────────────────────────
-- JWT context: auth.uid() = seed admin, app_metadata.role='admin'.
-- auth_is_privileged() returns true (admin role), so the role gate
-- passes; the self-check then refuses with the stable string.
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
    $q$select public.demote_profile_to_user(%L::uuid)$q$,
    current_setting('test.admin_id', true)
  ),
  'P0001',
  'cannot demote self',
  'arm (i): admin self-target refused (P0001 + exact message — LOAD-BEARING)'
);

-- ─── Arm (ii): admin demotes another user (happy path) ─────────
-- Same JWT context as Arm (i). Target is the seed manager
-- (22222…). Pre-state: role='user', brand_id=brand_a. Post-state:
-- role='user' (unchanged), brand_id=null. lives_ok confirms no
-- exception; the column assertions confirm the UPDATE actually ran
-- (brand_id transition from set → null is observable).
select lives_ok(
  format(
    $q$select public.demote_profile_to_user(%L::uuid)$q$,
    current_setting('test.manager_id', true)
  ),
  'arm (ii): admin demotes another user — call lives (no exception)'
);

-- Reset role to the default psql superuser context for the column-
-- state assertions below. Under `authenticated` + the admin JWT, the
-- `Admins can read all profiles` policy filters out rows whose
-- `brand_id` is NULL (the post-demote brand of the manager row) because
-- `auth_can_see_brand(NULL)` short-circuits to false for non-super_admin
-- callers. The SELECT would silently return 0 rows and the `is(...)`
-- assertion would compare against NULL. Resetting to superuser bypasses
-- RLS for the inspection — same pattern as
-- supabase/tests/admin_rpcs_privileged.test.sql lines 30, 41, 53.
reset role;

select is(
  (select role from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  'user',
  'arm (ii): post-call role is ''user'''
);

select is(
  (select brand_id from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  null::uuid,
  'arm (ii): post-call brand_id is null'
);

-- ─── Arm (iii): non-privileged caller refused at role gate ─────
-- JWT context: auth.uid() = seed manager (whose profiles.role is
-- 'user' per seed and was just confirmed by Arm (ii)). app_metadata
-- role='user' so auth_is_admin() returns false; profiles.role='user'
-- so auth_is_super_admin() returns false; auth_is_privileged()
-- short-circuits to false → 42501 'forbidden'.
--
-- Note: this arm targets the seed admin (11111…) intentionally. The
-- self-check (target == caller) WOULD fire if it ran, but the role
-- gate is positioned BEFORE the self-check in the RPC's ordering
-- (cheapest-fail-first), so the test confirms a non-privileged caller
-- sees 'forbidden' rather than 'cannot demote self'. Clearer error
-- surface for the wrong-permission case.
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

select throws_ok(
  format(
    $q$select public.demote_profile_to_user(%L::uuid)$q$,
    current_setting('test.admin_id', true)
  ),
  '42501',
  'forbidden',
  'arm (iii): non-privileged caller refused at role gate (42501 + forbidden)'
);

-- ─── Arm (iv): null caller refused (defense-in-depth) ──────────
-- Clear the JWT claims so auth.uid() returns null. The RPC's first
-- gate (null-caller check) refuses with the unified self-demote
-- string. The unified string is intentional — a distinct 'caller is
-- null' message would leak auth-state to a probing caller.
select set_config('request.jwt.claims', '', true);

select throws_ok(
  format(
    $q$select public.demote_profile_to_user(%L::uuid)$q$,
    current_setting('test.admin_id', true)
  ),
  'P0001',
  'cannot demote self',
  'arm (iv): null caller refused with unified string (P0001 + ''cannot demote self'')'
);

select * from finish();
rollback;

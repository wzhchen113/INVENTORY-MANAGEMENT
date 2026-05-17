-- pgTAP coverage for the privileged-tier broadening of the three admin RPCs
-- (supabase/migrations/20260517020000_admin_rpcs_use_privileged.sql).
--
-- Asserts: admin + master pass the gate on admin_db_inspector_probe();
-- plain user gets `admin only` rejected. Dedupe RPCs share the same gate
-- so probe coverage is sufficient regression for the broadening.
--
-- super_admin path is NOT exercised here — `auth_is_super_admin()` does
-- a real profile-row lookup and the seed has no super_admin user
-- locally. That path is covered transitively by the Spec 013
-- recipe_categories tests that prove `auth_is_privileged()` accepts
-- super_admin.
--
-- Hermetic: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(3);

-- ─── (1) admin role passes ────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "app_metadata": {"role": "admin"}}';

select lives_ok(
  $$select public.admin_db_inspector_probe()$$,
  '(1) admin role can call admin_db_inspector_probe'
);

reset role;

-- ─── (2) master role passes ───────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "app_metadata": {"role": "master"}}';

select lives_ok(
  $$select public.admin_db_inspector_probe()$$,
  '(2) master role can call admin_db_inspector_probe'
);

reset role;

-- ─── (3) plain user role is rejected with `admin only` ────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated", "app_metadata": {"role": "user"}}';

select throws_ok(
  $$select public.admin_db_inspector_probe()$$,
  'admin only',
  '(3) plain user is rejected with `admin only`'
);

reset role;

select * from finish();

rollback;

-- pgTAP coverage for the vendors INSERT policy after the master-role fix
-- (supabase/migrations/20260517010000_vendors_master_role_fix.sql).
--
-- Asserts: master + admin can INSERT vendors; staff/user is rejected by RLS.
-- super_admin path is exercised transitively via the existing pgTAP coverage
-- on auth_is_privileged() in recipe_categories tests (Spec 013).
--
-- Hermetic: the outer begin/rollback rolls back every test's INSERT at
-- file exit. JWT impersonation uses `set local request.jwt.claims` —
-- the `set local` scope ends with the outer transaction, no savepoints
-- needed. Mirrors the shape of supabase/tests/profiles_locale.test.sql.

begin;
create extension if not exists pgtap;

select plan(4);

-- ─── (1) policy exists ─────────────────────────────────────────────────────────
select cmp_ok(
  (select count(*)::int
     from pg_policies
    where schemaname = 'public'
      and tablename  = 'vendors'
      and policyname = 'Vendors admin only'),
  '=', 1,
  '(1) Vendors admin only policy exists exactly once'
);

-- ─── (2) master role (seed id 33333333-...) can INSERT a vendor ───────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "app_metadata": {"role": "master"}}';

select lives_ok(
  $$insert into vendors (id, name, brand_id) values ('99999999-9999-9999-9999-999999999911', '__test_vendor_master__', '2a000000-0000-0000-0000-000000000001')$$,
  '(2) master role can INSERT vendors'
);

reset role;

-- ─── (3) admin role (seed id 11111111-...) still can — regression ─────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "app_metadata": {"role": "admin"}}';

select lives_ok(
  $$insert into vendors (id, name, brand_id) values ('99999999-9999-9999-9999-999999999922', '__test_vendor_admin__', '2a000000-0000-0000-0000-000000000001')$$,
  '(3) admin role can INSERT vendors (regression)'
);

reset role;

-- ─── (4) user role (seed id 22222222-...) is rejected ─────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated", "app_metadata": {"role": "user"}}';

select throws_ok(
  $$insert into vendors (id, name, brand_id) values ('99999999-9999-9999-9999-999999999933', '__test_vendor_user__', '2a000000-0000-0000-0000-000000000001')$$,
  '42501',
  null,
  '(4) user role is rejected by RLS on vendors INSERT'
);

reset role;

select * from finish();

rollback;

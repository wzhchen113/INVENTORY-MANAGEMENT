-- pgTAP coverage for the vendors INSERT policy after the master-role fix
-- (supabase/migrations/20260517010000_vendors_master_role_fix.sql) AND the
-- spec-115 (W-2) `order_unit` column + its inherited UPDATE gate.
--
-- Asserts:
--   (1-4) master + admin can INSERT vendors; staff/user is rejected by RLS.
--   (5-6) spec 115 (W-2) AC-8 — `vendors.order_unit` exists as
--         NOT NULL DEFAULT 'case', and its CHECK rejects an off-vocabulary
--         value.
--   (7-8) spec 115 OQ-4 — a privileged (admin) caller CAN UPDATE order_unit
--         (proving the column inherits the existing privileged_update_vendors
--         gate), and a NON-privileged (user) caller CANNOT (the RLS USING
--         clause on privileged_update_vendors filters the row → a 0-row
--         update, so the value is UNCHANGED after the attempt). This makes the
--         STALE comment in 20260517010000_vendors_master_role_fix.sql ("UPDATE
--         on vendors has no policies today; intentionally denied") honest:
--         UPDATE is not ungated and not denied — it is privileged-gated by
--         privileged_update_vendors (20260509000000_multi_brand_schema_rls.sql:586,
--         USING auth_is_privileged() AND auth_can_see_brand(brand_id)), which
--         gates order_unit column-agnostically.
--
-- super_admin path is exercised transitively via the existing pgTAP coverage
-- on auth_is_privileged() in recipe_categories tests (Spec 013).
--
-- Hermetic: the outer begin/rollback rolls back every test's INSERT/UPDATE at
-- file exit. JWT impersonation uses `set local request.jwt.claims` —
-- the `set local` scope ends with the outer transaction, no savepoints
-- needed. Mirrors the shape of supabase/tests/profiles_locale.test.sql.
-- The order_unit UPDATE cases operate on a dedicated test vendor
-- ('99999999-…-9944') seeded here as the default (superuser) role, which
-- BYPASSES RLS — giving cases (7)/(8) a stable target that already exists
-- before the impersonated UPDATE attempts run. It lives in the seed brand
-- 2a000000-…-0001, which every seed profile (admin/master/user) has as its
-- profiles.brand_id, so auth_can_see_brand(brand_id) is satisfied for the
-- privileged caller and the DENY in case (8) is driven purely by
-- auth_is_privileged() being false for the `user` role.

begin;
create extension if not exists pgtap;

-- 11 assertions: (1)-(4) INSERT policy (4); (5a/5b/5c) order_unit column shape
-- + default-at-row (3); (6) CHECK rejects off-vocabulary (1); (7a/7b) privileged
-- UPDATE allowed + persisted (2); (8) non-privileged UPDATE denied / unchanged (1).
select plan(11);

-- Seed the dedicated UPDATE-target vendor as the default (superuser) role so
-- it exists regardless of RLS. order_unit is left to its DEFAULT ('case') to
-- also exercise the default at the row level.
insert into vendors (id, name, brand_id)
values ('99999999-9999-9999-9999-999999999944', '__test_vendor_order_unit__', '2a000000-0000-0000-0000-000000000001');

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

-- ─── (5) spec 115 (W-2) AC-8 — order_unit is NOT NULL DEFAULT 'case' ──────────
-- Column shape asserted from the catalog + the seeded row reading the default.
select is(
  (select column_default
     from information_schema.columns
    where table_schema = 'public'
      and table_name  = 'vendors'
      and column_name = 'order_unit'),
  '''case''::text',
  '(5a) vendors.order_unit column default is ''case''::text'
);

select is(
  (select is_nullable
     from information_schema.columns
    where table_schema = 'public'
      and table_name  = 'vendors'
      and column_name = 'order_unit'),
  'NO',
  '(5b) vendors.order_unit is NOT NULL'
);

select is(
  (select order_unit from vendors where id = '99999999-9999-9999-9999-999999999944'),
  'case',
  '(5c) an existing/new vendor row reads ''case'' from the DEFAULT (no backfill needed)'
);

-- ─── (6) spec 115 (W-2) AC-8 — the CHECK rejects an off-vocabulary value ──────
-- Run as the default (superuser) role so RLS does not mask the CHECK: this
-- asserts the CHECK constraint (23514), not a policy denial.
select throws_ok(
  $$update vendors set order_unit = 'pallet' where id = '99999999-9999-9999-9999-999999999944'$$,
  '23514',
  null,
  '(6) order_unit CHECK rejects a value outside {case, unit} (23514 check_violation)'
);

-- ─── (7) spec 115 OQ-4 — a privileged (admin) caller CAN UPDATE order_unit ────
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "app_metadata": {"role": "admin"}}';

select lives_ok(
  $$update vendors set order_unit = 'unit' where id = '99999999-9999-9999-9999-999999999944'$$,
  '(7a) admin (auth_is_privileged, brand-visible) can UPDATE order_unit via privileged_update_vendors'
);

reset role;

-- The privileged UPDATE landed (checked as superuser, RLS-free).
select is(
  (select order_unit from vendors where id = '99999999-9999-9999-9999-999999999944'),
  'unit',
  '(7b) the privileged order_unit UPDATE actually persisted'
);

-- ─── (8) spec 115 OQ-4 — a NON-privileged (user) caller CANNOT flip order_unit ─
-- privileged_update_vendors' USING clause (auth_is_privileged() false for
-- `user`) filters the row, so the UPDATE affects 0 rows and RAISES NOTHING —
-- the correct assertion is value-unchanged, not throws_ok. Attempt to flip it
-- back to 'case'; the value must remain 'unit' (the privileged write from (7)).
set local role authenticated;
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated", "app_metadata": {"role": "user"}}';

update vendors set order_unit = 'case' where id = '99999999-9999-9999-9999-999999999944';

reset role;

select is(
  (select order_unit from vendors where id = '99999999-9999-9999-9999-999999999944'),
  'unit',
  '(8) user role CANNOT change order_unit — RLS 0-row update left the value unchanged (privileged_update_vendors gates the column)'
);

select * from finish();

rollback;

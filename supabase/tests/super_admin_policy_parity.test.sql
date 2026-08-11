-- supabase/tests/super_admin_policy_parity.test.sql
--
-- Spec 157 / pgTAP regression for the super_admin RLS parity fix shipped in:
--   supabase/migrations/20260809000000_super_admin_policy_parity.sql
--
-- Seven policies still gated on the NARROW public.auth_is_admin() (JWT-only,
-- admin/master) after 012a introduced super_admin. Because an UPDATE/DELETE
-- whose USING clause fails is not an ERROR — the rows simply do not match —
-- PostgREST returned 204 and src/lib/db.ts reported success. The owner's
-- super_admin account was silently denied on ingredient-category CRUD and on
-- every audit_log UPDATE/DELETE. The migration widens all seven to
-- public.auth_is_privileged().
--
-- Coverage: positive super_admin + negative plain-user for every changed
-- policy, plus admin-JWT / master-JWT regression arms proving the change is a
-- strict SUPERSET (AC-4), plus a standing lint arm (LINT-1, OQ-6) that fails
-- the build if an eighth bare-auth_is_admin() policy ever appears.
--
--   F-1                 fixture: seed master promoted to super_admin in-txn
--   IC-1 / IC-2 / IC-3  super_admin INSERT / UPDATE / DELETE ingredient_categories
--   IC-4                plain user INSERT rejected (42501)
--   IC-5 / IC-6         plain user UPDATE / DELETE affect 0 rows
--   IC-7 / IC-8         admin JWT / master JWT INSERT still succeed (regression)
--   AL-1 / AL-2         super_admin INSERTs and SELECTs a store-less audit row
--   AL-3 / AL-4         plain user cannot INSERT (42501) nor SELECT one
--   AL-5 / AL-6         super_admin UPDATE / DELETE a store-scoped row (1 row)
--   AL-7 / AL-8         plain user UPDATE / DELETE that same row (0 rows)
--   AL-9 / AL-10        admin JWT UPDATE / master JWT DELETE still work
--   LINT-1              zero public.* policies name auth_is_admin
--
-- Hermetic begin; ... rollback; isolation. The seed is untouched.
--
-- ── Fixture note: the super_admin principal ──────────────────────────────
-- profiles.id has an FK to auth.users(id) (20260405000759_init_schema.sql:21),
-- so we cannot mint a synthetic UUID and INSERT a freestanding profiles row.
-- We reuse the seeded master ('33333333-…') and UPDATE its profile to
-- role='super_admin' + brand_id=NULL inside the hermetic transaction (the
-- profiles_role_brand_consistent CHECK requires NULL brand_id for super_admin
-- rows). This mirrors recipe_categories_super_admin_rls.test.sql verbatim.
--
-- The super_admin arms impersonate with app_metadata.role='user', so
-- auth_is_admin() is FALSE for them and the passing path is PROVABLY
-- auth_is_super_admin() (profiles-based) rather than the JWT.
--
-- ── Fixture note: why AL-7 / AL-8 use a store-SCOPED row ─────────────────
-- The plain user ('22222222-…', profiles.role='user') holds a user_stores
-- grant on store '00000000-…-0001' (Towson) in the seed, so
-- auth_can_see_store() admits them through store_member_read_audit_log's
-- store-scoped arm. Using a store-LESS row for these arms would be worthless:
-- the user would fail the SELECT too, the UPDATE/DELETE would affect 0 rows
-- for the wrong reason, and the arms would pass even if the fix were wrong.
-- Each of AL-7/AL-8 therefore asserts on the row's surviving `detail` value —
-- which is NULL if the row is invisible AND NULL if the row was wrongly
-- deleted, so the arm fails in either failure mode. These are the sharpest
-- arms in the suite.
--
-- ── Fixture note: AL-10 / IC-8 (master JWT) orthogonality ────────────────
-- The master's profiles row is 'super_admin' inside this txn, so both the
-- JWT arm and the profiles arm of auth_is_privileged() are true for it. The
-- arm is a regression guard ("master is not locked out"), not a proof of
-- which arm admitted. recipe_categories_super_admin_rls.test.sql AC8b has the
-- same property and documents it the same way; IC-7 / AL-9 use the seeded
-- admin ('11111111-…', profiles.role='admin') where only the JWT arm is true,
-- so the JWT path is independently proven there.

begin;
create extension if not exists pgtap;

select plan(20);

-- ── fixtures ──────────────────────────────────────────────────────────────
do $$
declare
  v_admin_id  uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (JWT admin)
  v_user_id   uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role='user')
  v_master_id uuid := '33333333-3333-3333-3333-333333333333';  -- seed master, repurposed as super_admin
  v_store_id  uuid := '00000000-0000-0000-0000-000000000001';  -- Towson; v_user_id has a user_stores grant
begin
  perform set_config('test.admin_id',  v_admin_id::text,  true);
  perform set_config('test.user_id',   v_user_id::text,   true);
  perform set_config('test.master_id', v_master_id::text, true);
  perform set_config('test.store_id',  v_store_id::text,  true);
end $$;

-- Promote the seeded master to super_admin inside the hermetic txn.
-- Runs as the postgres superuser: auth.uid() is NULL, so the
-- profiles_self_brand_lock trigger's self-edit branch does not fire.
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.master_id', true)::uuid;

select is(
  (select role from public.profiles
    where id = current_setting('test.master_id', true)::uuid),
  'super_admin',
  'F-1: fixture — seed master promoted to super_admin for this txn'
);

-- ingredient_categories fixture the plain user will fail to mutate (IC-5/IC-6).
insert into public.ingredient_categories (name)
  values ('__test_spec157_ic_user_probe__');

-- audit_log fixtures. Inserted as superuser so RLS is bypassed for setup.
-- All store-scoped on Towson, which BOTH the plain user (user_stores grant)
-- and the admin (same brand) can see — see the AL-7/AL-8 fixture note.
-- user_id is left NULL to keep the profiles FK out of the picture.
insert into public.audit_log (id, store_id, user_id, action, detail) values
  ('a5000157-0000-0000-0000-000000000001',
   current_setting('test.store_id', true)::uuid, null,
   '__test_spec157_al_sa_update__',     '__test_spec157_original__'),
  ('a5000157-0000-0000-0000-000000000002',
   current_setting('test.store_id', true)::uuid, null,
   '__test_spec157_al_sa_delete__',     '__test_spec157_original__'),
  ('a5000157-0000-0000-0000-000000000003',
   current_setting('test.store_id', true)::uuid, null,
   '__test_spec157_al_user_update__',   '__test_spec157_original__'),
  ('a5000157-0000-0000-0000-000000000004',
   current_setting('test.store_id', true)::uuid, null,
   '__test_spec157_al_user_delete__',   '__test_spec157_original__'),
  ('a5000157-0000-0000-0000-000000000005',
   current_setting('test.store_id', true)::uuid, null,
   '__test_spec157_al_admin_update__',  '__test_spec157_original__'),
  ('a5000157-0000-0000-0000-000000000006',
   current_setting('test.store_id', true)::uuid, null,
   '__test_spec157_al_master_delete__', '__test_spec157_original__');


-- ══════════════════════════════════════════════════════════════════════════
-- Context A — super_admin via profiles.role, JWT app_metadata.role='user'
-- ══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

-- ── IC-1: super_admin INSERT into ingredient_categories ───────────────────
insert into public.ingredient_categories (name)
  values ('__test_spec157_ic_sa__');

select is(
  (select count(*)::bigint from public.ingredient_categories
    where name = '__test_spec157_ic_sa__'),
  1::bigint,
  'IC-1: super_admin INSERT into ingredient_categories succeeds (auth_is_super_admin() path)'
);

-- ── IC-2: super_admin UPDATE (the Categories "rename") ────────────────────
update public.ingredient_categories
   set name = '__test_spec157_ic_sa_renamed__'
 where name = '__test_spec157_ic_sa__';

select is(
  (select count(*)::bigint from public.ingredient_categories
    where name = '__test_spec157_ic_sa_renamed__'),
  1::bigint,
  'IC-2: super_admin UPDATE (rename) affects the row'
);

-- ── IC-3: super_admin DELETE ──────────────────────────────────────────────
-- Deliberately targets BOTH the pre- and post-rename name, and asserts on
-- both. If IC-2's rename were refused the row would still carry its original
-- name; a DELETE keyed only on the renamed value would then match nothing and
-- this arm would pass while proving nothing about the DELETE policy. Verified
-- against a negative control that reverts the UPDATE + DELETE policies: with
-- the `in (...)` form this arm correctly fails.
delete from public.ingredient_categories
 where name in ('__test_spec157_ic_sa__', '__test_spec157_ic_sa_renamed__');

select is(
  (select count(*)::bigint from public.ingredient_categories
    where name in ('__test_spec157_ic_sa__', '__test_spec157_ic_sa_renamed__')),
  0::bigint,
  'IC-3: super_admin DELETE removes the row'
);

-- ── AL-1: super_admin INSERT of a store-less audit row ────────────────────
-- store_id IS NULL takes the cross-cutting OR-arm, the one that was gated on
-- auth_is_admin(). Pre-fix this raised 42501.
select lives_ok(
  $q$insert into public.audit_log (store_id, action, detail)
     values (null, '__test_spec157_al_storeless__', '__test_spec157_original__')$q$,
  'AL-1: super_admin INSERT of a store-less audit_log row succeeds'
);

-- ── AL-2: super_admin SELECT sees the store-less row ──────────────────────
select is(
  (select count(*)::bigint from public.audit_log
    where action = '__test_spec157_al_storeless__'),
  1::bigint,
  'AL-2: super_admin SELECT sees the store-less audit_log row'
);

-- ── AL-5: super_admin UPDATE of a store-scoped row affects 1 ──────────────
update public.audit_log
   set detail = '__test_spec157_sa_touched__'
 where id = 'a5000157-0000-0000-0000-000000000001';

select is(
  (select detail from public.audit_log
    where id = 'a5000157-0000-0000-0000-000000000001'),
  '__test_spec157_sa_touched__',
  'AL-5: super_admin UPDATE of a store-scoped audit_log row affects that row'
);

-- ── AL-6: super_admin DELETE of a store-scoped row affects 1 ──────────────
delete from public.audit_log
 where id = 'a5000157-0000-0000-0000-000000000002';

select is(
  (select count(*)::bigint from public.audit_log
    where id = 'a5000157-0000-0000-0000-000000000002'),
  0::bigint,
  'AL-6: super_admin DELETE of a store-scoped audit_log row removes it'
);


-- ══════════════════════════════════════════════════════════════════════════
-- Context B — plain user (profiles.role='user', JWT app_metadata.role='user')
-- Neither auth_is_admin() nor auth_is_super_admin() is true, so
-- auth_is_privileged() is false. Every write below must be refused.
-- ══════════════════════════════════════════════════════════════════════════
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.user_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

-- ── IC-4: plain user INSERT is rejected outright ──────────────────────────
select throws_ok(
  $q$insert into public.ingredient_categories (name)
     values ('__test_spec157_ic_user__')$q$,
  '42501',
  null,
  'IC-4: plain user INSERT into ingredient_categories rejected by RLS (42501)'
);

-- ── IC-5: plain user UPDATE affects 0 rows (silent, not an error) ─────────
update public.ingredient_categories
   set name = '__test_spec157_ic_user_renamed__'
 where name = '__test_spec157_ic_user_probe__';

select is(
  (select count(*)::bigint from public.ingredient_categories
    where name = '__test_spec157_ic_user_probe__'),
  1::bigint,
  'IC-5: plain user UPDATE of ingredient_categories affects 0 rows (row keeps its original name)'
);

-- ── IC-6: plain user DELETE affects 0 rows ────────────────────────────────
delete from public.ingredient_categories
 where name = '__test_spec157_ic_user_probe__';

select is(
  (select count(*)::bigint from public.ingredient_categories
    where name = '__test_spec157_ic_user_probe__'),
  1::bigint,
  'IC-6: plain user DELETE of ingredient_categories affects 0 rows (row survives)'
);

-- ── AL-3: plain user INSERT of a store-less audit row is rejected ─────────
select throws_ok(
  $q$insert into public.audit_log (store_id, action, detail)
     values (null, '__test_spec157_al_storeless_user__', '__test_spec157_original__')$q$,
  '42501',
  null,
  'AL-3: plain user INSERT of a store-less audit_log row rejected by RLS (42501)'
);

-- ── AL-4: plain user cannot SELECT the store-less row ─────────────────────
select is(
  (select count(*)::bigint from public.audit_log
    where action = '__test_spec157_al_storeless__'),
  0::bigint,
  'AL-4: plain user SELECT does not see the store-less audit_log row'
);

-- ── AL-7: plain user UPDATE of a VISIBLE store-scoped row affects 0 ───────
-- The user can SELECT this row (user_stores grant on Towson), so a NULL here
-- would mean "invisible" and a changed value would mean "wrongly updated" —
-- the arm fails in both failure modes. This is the arm that proves the
-- UPDATE policy, not visibility, is what refuses.
update public.audit_log
   set detail = '__test_spec157_user_touched__'
 where id = 'a5000157-0000-0000-0000-000000000003';

select is(
  (select detail from public.audit_log
    where id = 'a5000157-0000-0000-0000-000000000003'),
  '__test_spec157_original__',
  'AL-7: plain user UPDATE of a visible store-scoped audit_log row affects 0 rows'
);

-- ── AL-8: plain user DELETE of a VISIBLE store-scoped row affects 0 ───────
delete from public.audit_log
 where id = 'a5000157-0000-0000-0000-000000000004';

select is(
  (select detail from public.audit_log
    where id = 'a5000157-0000-0000-0000-000000000004'),
  '__test_spec157_original__',
  'AL-8: plain user DELETE of a visible store-scoped audit_log row affects 0 rows'
);


-- ══════════════════════════════════════════════════════════════════════════
-- Context C — admin JWT (AC-4 regression: nobody loses access)
-- profiles.role='admin' for this id, so auth_is_super_admin() is FALSE and
-- the ONLY arm that can admit is auth_is_admin() — the JWT path is proven.
-- ══════════════════════════════════════════════════════════════════════════
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

-- ── IC-7: admin JWT INSERT still succeeds ─────────────────────────────────
insert into public.ingredient_categories (name)
  values ('__test_spec157_ic_admin__');

select is(
  (select count(*)::bigint from public.ingredient_categories
    where name = '__test_spec157_ic_admin__'),
  1::bigint,
  'IC-7: admin JWT INSERT into ingredient_categories still succeeds (regression, AC-4)'
);

-- ── AL-9: admin JWT UPDATE still affects the row ──────────────────────────
update public.audit_log
   set detail = '__test_spec157_admin_touched__'
 where id = 'a5000157-0000-0000-0000-000000000005';

select is(
  (select detail from public.audit_log
    where id = 'a5000157-0000-0000-0000-000000000005'),
  '__test_spec157_admin_touched__',
  'AL-9: admin JWT UPDATE of an audit_log row still affects it (regression, AC-4)'
);


-- ══════════════════════════════════════════════════════════════════════════
-- Context D — master JWT (AC-4 regression). See the orthogonality note in
-- the header: both arms of auth_is_privileged() are true for this principal
-- inside this txn, so these are "master is not locked out" guards.
-- ══════════════════════════════════════════════════════════════════════════
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'master')
  )::text,
  true
);

-- ── IC-8: master JWT INSERT still succeeds ────────────────────────────────
insert into public.ingredient_categories (name)
  values ('__test_spec157_ic_master__');

select is(
  (select count(*)::bigint from public.ingredient_categories
    where name = '__test_spec157_ic_master__'),
  1::bigint,
  'IC-8: master JWT INSERT into ingredient_categories still succeeds (regression, AC-4)'
);

-- ── AL-10: master JWT DELETE still removes the row ────────────────────────
delete from public.audit_log
 where id = 'a5000157-0000-0000-0000-000000000006';

select is(
  (select count(*)::bigint from public.audit_log
    where id = 'a5000157-0000-0000-0000-000000000006'),
  0::bigint,
  'AL-10: master JWT DELETE of an audit_log row still removes it (regression, AC-4)'
);


-- ══════════════════════════════════════════════════════════════════════════
-- LINT-1 (OQ-6) — standing guard against an eighth leftover
-- ══════════════════════════════════════════════════════════════════════════
-- Scans pg_policies PREDICATES ONLY. It must NEVER scan pg_proc /
-- pg_get_functiondef: public.auth_can_see_store() and
-- public.auth_is_privileged() legitimately call auth_is_admin() in their
-- bodies, and public.admin_db_inspector_probe() emits its result in the
-- probe payload. A function-body scan would false-fail on all three.
--
-- After spec 157 the correct count is exactly 0, so this arm needs no
-- allowlist — in the spirit of the spec 053 lint probe.
reset role;

select is(
  (select count(*)::int
     from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '')       like '%auth_is_admin%'
        or coalesce(with_check, '') like '%auth_is_admin%')),
  0,
  'LINT-1: no policy in public.* gates on the narrow auth_is_admin(). Offenders: '
  || coalesce(
       (select string_agg(schemaname || '.' || tablename || ' / ' || policyname || ' (' || cmd || ')', '; '
                          order by tablename, cmd, policyname)
          from pg_policies
         where schemaname = 'public'
           and (coalesce(qual, '')       like '%auth_is_admin%'
             or coalesce(with_check, '') like '%auth_is_admin%')),
       '(none)')
  || ' — an eighth bare-`auth_is_admin()` policy has appeared; see spec 157. '
  || 'Widen it to `auth_is_privileged()`, or state the deliberate super_admin '
  || 'exclusion in a `comment on policy` and add it to this arm''s exception list.'
);

select * from finish();
rollback;

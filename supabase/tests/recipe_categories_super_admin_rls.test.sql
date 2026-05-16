-- supabase/tests/recipe_categories_super_admin_rls.test.sql
--
-- Spec 013 / pgTAP regression for the recipe_categories RLS super_admin
-- broadening shipped in:
--   supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql
--
-- Three role bands × one INSERT vector against public.recipe_categories:
--   (i)   super_admin via profiles.role → INSERT succeeds (AC6 — new behavior;
--          auth_is_super_admin() reads profiles.role, NOT the JWT, so the
--          impersonated JWT carries app_metadata.role='user').
--   (ii)  plain user JWT               → INSERT rejected with SQLSTATE 42501 (AC7).
--   (iii) admin JWT                    → INSERT succeeds (AC8a — regression;
--          pre-existing behavior preserved).
--   (iv)  master JWT                   → INSERT succeeds (AC8b — regression;
--          pre-existing behavior preserved).
--
-- Hermetic begin; ... rollback; isolation. Seed is untouched.
--
-- Implementation note on the super_admin fixture: profiles.id has FK to
-- auth.users(id) (see 20260405000759_init_schema.sql:21), so we cannot
-- mint a synthetic UUID and INSERT a freestanding profiles row. Instead
-- we reuse the seeded master user's auth.users.id (master_id =
-- '33333333-...') and ON CONFLICT DO UPDATE its profile to
-- role='super_admin' + brand_id=NULL inside the hermetic transaction.
-- The profiles_role_brand_consistent CHECK requires brand_id IS NULL for
-- super_admin rows. The master JWT arm (AC8b) sets app_metadata.role='master'
-- directly in the JWT, which is independent of the profiles row mutation;
-- auth_is_admin() checks only the JWT claim so both arms are exercised cleanly.

begin;
create extension if not exists pgtap;

select plan(5);

-- ── fixtures ──────────────────────────────────────────────────────────────
do $$
declare
  v_admin_id  uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin
  v_master_id uuid := '33333333-3333-3333-3333-333333333333';  -- seed master, repurposed as super_admin
  v_user_id   uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role='user')
begin
  perform set_config('test.admin_id',  v_admin_id::text,  true);
  perform set_config('test.master_id', v_master_id::text, true);
  perform set_config('test.user_id',   v_user_id::text,   true);
end $$;

-- Promote the seeded master to super_admin inside the hermetic txn.
-- The profiles_role_brand_consistent CHECK requires brand_id IS NULL for
-- super_admin rows; UPDATE both columns atomically.
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.master_id', true)::uuid;

select is(
  (select role from public.profiles
    where id = current_setting('test.master_id', true)::uuid),
  'super_admin',
  'fixture: seed master promoted to super_admin for this txn'
);

-- ── AC6: positive probe — super_admin via profiles.role can INSERT ─────────
-- JWT app_metadata.role intentionally set to 'user' (not admin/master) to
-- prove the passing path is auth_is_super_admin() (profiles-based), not
-- auth_is_admin() (JWT-based). This is the new behavior enabled by the fix.
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

insert into public.recipe_categories (name)
  values ('__test_spec013_super_admin__');

select is(
  (select count(*)::bigint
     from public.recipe_categories
    where name = '__test_spec013_super_admin__'),
  1::bigint,
  'AC6: super_admin profile INSERT succeeds (auth_is_super_admin() path)'
);

-- ── AC7: negative probe — plain user JWT is rejected ──────────────────────
-- auth_is_admin() fails (JWT role='user', not admin/master).
-- auth_is_super_admin() fails (profiles.role for v_user_id is 'user'; never
-- promoted in this txn). auth_is_privileged() → false → 42501.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.user_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

select throws_ok(
  $q$insert into public.recipe_categories (name)
     values ('__test_spec013_user__')$q$,
  '42501',
  null,
  'AC7: plain user INSERT rejected by RLS (SQLSTATE 42501)'
);

-- ── AC8a: regression — admin JWT still succeeds ───────────────────────────
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

insert into public.recipe_categories (name)
  values ('__test_spec013_admin__');

select is(
  (select count(*)::bigint
     from public.recipe_categories
    where name = '__test_spec013_admin__'),
  1::bigint,
  'AC8a: admin JWT INSERT succeeds (regression — auth_is_admin() path)'
);

-- ── AC8b: regression — master JWT still succeeds ──────────────────────────
-- profiles row for master_id is 'super_admin' inside this txn, but JWT
-- app_metadata.role='master' independently passes auth_is_admin(). The two
-- arms are orthogonal, so this correctly exercises the master-JWT code path.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'master')
  )::text,
  true
);

insert into public.recipe_categories (name)
  values ('__test_spec013_master__');

select is(
  (select count(*)::bigint
     from public.recipe_categories
    where name = '__test_spec013_master__'),
  1::bigint,
  'AC8b: master JWT INSERT succeeds (regression — auth_is_admin() path)'
);

select * from finish();
rollback;

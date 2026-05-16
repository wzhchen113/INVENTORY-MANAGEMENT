-- supabase/tests/profiles_locale.test.sql
--
-- Spec 038 / pgTAP regression for the profiles.locale column shipped in:
--   supabase/migrations/20260516000000_profiles_locale.sql
--
-- Coverage:
--   (1)  Column exists, type text, NOT NULL, default 'en'.
--   (2)  CHECK accepts each of 'en', 'es', 'zh-CN' for an update on a
--        legitimately-owned profile row.
--   (3)  CHECK rejects 'fr' with SQLSTATE 23514.
--   (4)  CHECK rejects '' (empty string) with SQLSTATE 23514.
--   (5)  Default 'en' applies to pre-existing rows (verified via the
--        seeded profiles, all of which were created before this column
--        was added and thus exercise the additive backfill).
--   (6)  RLS: a `user`-role JWT (seed manager 22222222-...) can UPDATE
--        its own row's locale.
--   (7)  RLS: that same `user` JWT cannot UPDATE another user's locale —
--        the row policy `using (id = auth.uid())` filters the row out
--        silently (zero rows updated). The other user's locale is
--        unchanged.
--
-- Hermetic isolation: begin; ... rollback;. Seed is untouched on exit.
--
-- Implementation notes:
--   - profiles.id has FK to auth.users(id), so we cannot freely mint
--     synthetic profile rows. We exercise the CHECK and RLS against the
--     seeded admin / master / manager triplet, matching the precedent in
--     supabase/tests/recipe_categories_super_admin_rls.test.sql.
--   - The CHECK constraint test cases run as `postgres` superuser (no
--     JWT impersonation, no RLS) so a constraint violation is the only
--     reason the statement fails — not a row policy gate. This isolates
--     the CHECK-rejects-bad-values assertion from the RLS coverage.
--   - The RLS arms use `set local role authenticated` + the
--     `request.jwt.claims` mechanism that the rest of this suite uses.

begin;
create extension if not exists pgtap;

select plan(10);

-- ─── fixtures ──────────────────────────────────────────────────────────────
do $$
declare
  v_admin_id   uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';  -- seed user role
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';  -- seed master
begin
  perform set_config('test.admin_id',   v_admin_id::text,   true);
  perform set_config('test.manager_id', v_manager_id::text, true);
  perform set_config('test.master_id',  v_master_id::text,  true);
end $$;

-- ─── (1) schema shape: column exists, type, NOT NULL, default ─────────────
select is(
  (select data_type from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'profiles'
      and column_name  = 'locale'),
  'text',
  '(1a) profiles.locale exists and is of type text'
);

select is(
  (select is_nullable from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'profiles'
      and column_name  = 'locale'),
  'NO',
  '(1b) profiles.locale is NOT NULL'
);

select is(
  (select column_default from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'profiles'
      and column_name  = 'locale'),
  '''en''::text',
  '(1c) profiles.locale default is ''en'''
);

-- ─── (5) backfill: pre-existing rows default to 'en' ──────────────────────
-- The three seeded profiles (admin/manager/master) predate this column;
-- the additive `add column ... not null default 'en'` should have
-- backfilled them to 'en' atomically.
select is(
  (select count(*)::bigint from public.profiles
    where id in (
      current_setting('test.admin_id',   true)::uuid,
      current_setting('test.manager_id', true)::uuid,
      current_setting('test.master_id',  true)::uuid
    )
    and locale = 'en'),
  3::bigint,
  '(5) all three seeded profiles backfilled to locale=''en'''
);

-- ─── (3) CHECK rejects 'fr' (out-of-enum) ─────────────────────────────────
-- Runs as postgres superuser, so RLS is bypassed and a 23514 surfaces
-- only when the CHECK fires. We update the seeded manager row whose
-- locale is currently 'en'.
select throws_ok(
  format(
    $q$update public.profiles
         set locale = 'fr'
       where id = %L::uuid$q$,
    current_setting('test.manager_id', true)
  ),
  '23514',
  null,
  '(3) CHECK rejects locale=''fr'' with SQLSTATE 23514'
);

-- ─── (4) CHECK rejects '' (empty string) ──────────────────────────────────
select throws_ok(
  format(
    $q$update public.profiles
         set locale = ''
       where id = %L::uuid$q$,
    current_setting('test.manager_id', true)
  ),
  '23514',
  null,
  '(4) CHECK rejects empty-string locale with SQLSTATE 23514'
);

-- ─── (2) CHECK accepts each of 'en', 'es', 'zh-CN' ────────────────────────
-- Still running as postgres superuser; this validates the constraint is
-- permissive on each enum member independent of RLS. Rolled back at the
-- end of the test transaction.
update public.profiles
   set locale = 'es'
 where id = current_setting('test.manager_id', true)::uuid;

select is(
  (select locale from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  'es',
  '(2a) CHECK accepts locale=''es'''
);

update public.profiles
   set locale = 'zh-CN'
 where id = current_setting('test.manager_id', true)::uuid;

select is(
  (select locale from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  'zh-CN',
  '(2b) CHECK accepts locale=''zh-CN'''
);

-- Reset manager's locale back to 'en' before the RLS arms exercise it.
update public.profiles
   set locale = 'en'
 where id = current_setting('test.manager_id', true)::uuid;

-- ─── (6) RLS: user can UPDATE own profile.locale ──────────────────────────
-- Impersonate the seeded manager (role='user'). The
-- "Users can update own profile" row policy gates id = auth.uid().
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

update public.profiles
   set locale = 'es'
 where id = current_setting('test.manager_id', true)::uuid;

select is(
  (select locale from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  'es',
  '(6) user JWT can UPDATE own profile.locale (self-write policy)'
);

-- ─── (7) RLS: user CANNOT UPDATE another user's profile.locale ────────────
-- The manager JWT is still active. Attempting to update the admin row
-- (id != auth.uid()) is silently zero rows under the existing
-- "Users can update own profile" policy — the admin's locale is
-- unchanged from its pre-test value of 'en'. After firing the UPDATE
-- attempt under the manager JWT, we reset the role to postgres and
-- read the admin row back (the "Users can read own profile" policy
-- would otherwise filter the admin row out under the manager JWT,
-- conflating "RLS blocked the write" with "RLS blocked the read").
update public.profiles
   set locale = 'zh-CN'
 where id = current_setting('test.admin_id', true)::uuid;

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select locale from public.profiles
    where id = current_setting('test.admin_id', true)::uuid),
  'en',
  '(7) user JWT cannot UPDATE another user''s locale (RLS silent zero-rows)'
);

select * from finish();
rollback;

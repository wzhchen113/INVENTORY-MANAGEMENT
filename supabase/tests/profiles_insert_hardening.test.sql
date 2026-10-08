-- supabase/tests/profiles_insert_hardening.test.sql
--
-- Spec 164 / pgTAP for supabase/migrations/20261007000000_profiles_insert_hardening.sql:
--   - profiles INSERT policy "Admins can insert profiles in own brand"
--     (privileged + brand-scoped, no self-arm, no wide OR-tail)
--   - BEFORE INSERT guard trigger profiles_insert_role_guard
--     (public.assert_profile_insert_role_allowed(), SECURITY INVOKER)
--   - SECURITY DEFINER RPC public.register_invited_profile()
--   - invitations INSERT/UPDATE policies tightened to P_INV
--
-- Arm map (design section 8.1). plan(73).
--   Catalog K-1..K-15 (15)       as postgres
--   Section A  A-1..A-17 (17)    profiles INSERT under JWT impersonation
--   Section B  B-1..B-2  (2)     guard skips postgres + service_role
--                                (B-3, the SECURITY DEFINER skip, is C-5)
--   Section C  C-1..C-18 (21)    register_invited_profile() success,
--                                refusals, atomicity (C-5, C-6, C-8 carry
--                                two assertions each)
--   Section D  D-1..D-18 (18)    invitations INSERT/UPDATE under JWT
--
-- Spec correction D6: Postgres runs BEFORE ROW triggers before the RLS WITH
-- CHECK. A non-'user' role insert by a non-super_admin authenticated caller
-- is therefore refused by the guard (P0001) before RLS runs. A-3 disables
-- the guard and proves RLS alone also refuses the same insert (42501).
--
-- Anon is covered by catalog checks (K-10 / K-11) only: `set role anon`
-- segfaults the CI Postgres image (spec 067; reports_anon_revoke.test.sql).
--
-- B-2 uses `set local role service_role` for a plain INSERT (no
-- permission-denied path, unlike the spec 067 anon crash). If that ever
-- proves unstable on the CI image, replace B-2 with a text probe asserting
-- pg_get_functiondef of the guard contains
-- current_user in ('authenticated', 'anon'), and note it here.
--
-- C-17 atomicity: the RPC has no exception handler, so the cross-brand
-- user_stores failure aborts the whole call and the step-9 profile insert is
-- rolled back with it. C-18 checks the end state as postgres.
--
-- Fixtures: seed admin (11111..., admin, brand A), seed manager (22222...,
-- user, brand A), seed master (33333..., master, brand A). Synthetic brand B,
-- one synthetic store per brand (non-blank address: stores_address_present),
-- one synthetic super_admin SA (brand NULL), and one orphan auth.users row
-- (no profile) per arm that inserts or registers. Token columns are ''
-- (NULL-token gotcha). Invitations for the RPC arms are seeded as postgres.
--
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(73);


-- --- fixtures (constants stashed via set_config) -------------------
do $$
begin
  perform set_config('test.admin_id',   '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.manager_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.master_id',  '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.brand_a',    '2a000000-0000-0000-0000-000000000001', true);
  perform set_config('test.brand_b',    'b2000000-0000-0000-0000-000000000164', true);
  perform set_config('test.store_a',    'a5164000-0000-0000-0000-00000000000a', true);
  perform set_config('test.store_b',    'b5164000-0000-0000-0000-00000000000b', true);
  perform set_config('test.sa',         'd164d164-0000-0000-0000-000000000001', true);
  -- section A / B orphans
  perform set_config('test.o1',   'e1640000-0000-0000-0000-000000000001', true);
  perform set_config('test.o2',   'e1640000-0000-0000-0000-000000000002', true);
  perform set_config('test.ot',   'e1640000-0000-0000-0000-000000000003', true);
  perform set_config('test.o3',   'e1640000-0000-0000-0000-000000000004', true);
  perform set_config('test.o4',   'e1640000-0000-0000-0000-000000000005', true);
  perform set_config('test.o5',   'e1640000-0000-0000-0000-000000000006', true);
  perform set_config('test.ob1',  'e1640000-0000-0000-0000-000000000007', true);
  perform set_config('test.ob2',  'e1640000-0000-0000-0000-000000000008', true);
  -- section C registrants
  perform set_config('test.c1',   'e1640000-0000-0000-0000-000000000011', true);
  perform set_config('test.c5',   'e1640000-0000-0000-0000-000000000015', true);
  perform set_config('test.c6',   'e1640000-0000-0000-0000-000000000016', true);
  perform set_config('test.c7',   'e1640000-0000-0000-0000-000000000017', true);
  perform set_config('test.c9',   'e1640000-0000-0000-0000-000000000019', true);
  perform set_config('test.c10',  'e1640000-0000-0000-0000-00000000001a', true);
  perform set_config('test.c11',  'e1640000-0000-0000-0000-00000000001b', true);
  perform set_config('test.c12',  'e1640000-0000-0000-0000-00000000001c', true);
  perform set_config('test.c13',  'e1640000-0000-0000-0000-00000000001d', true);
  perform set_config('test.c14',  'e1640000-0000-0000-0000-00000000001e', true);
  perform set_config('test.c15',  'e1640000-0000-0000-0000-00000000001f', true);
  perform set_config('test.c17',  'e1640000-0000-0000-0000-000000000020', true);
end $$;


insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 164)')
on conflict (id) do nothing;

insert into public.stores (id, name, address, brand_id)
values
  (current_setting('test.store_a', true)::uuid, 'Store A (test 164)', '1 A Street',
   current_setting('test.brand_a', true)::uuid),
  (current_setting('test.store_b', true)::uuid, 'Store B (test 164)', '1 B Street',
   current_setting('test.brand_b', true)::uuid)
on conflict (id) do nothing;


-- Every synthetic auth user. Only SA gets a profile below; the rest are
-- orphans (no profile). raw_app_meta_data carries NO role key, so A-4 /
-- A-7 / C-18 can assert it stays role-less.
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
)
select v.id::uuid,
       '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated',
       v.email, '',
       now(), now(), now(),
       jsonb_build_object('provider','email','providers',array['email']),
       '{}'::jsonb, false, false,
       '','','','','','','',''
  from (values
    (current_setting('test.sa', true),  'sa-164@local.test'),
    (current_setting('test.o1', true),  'o1-164@local.test'),
    (current_setting('test.o2', true),  'o2-164@local.test'),
    (current_setting('test.ot', true),  'ot-164@local.test'),
    (current_setting('test.o3', true),  'o3-164@local.test'),
    (current_setting('test.o4', true),  'o4-164@local.test'),
    (current_setting('test.o5', true),  'o5-164@local.test'),
    (current_setting('test.ob1', true), 'ob1-164@local.test'),
    (current_setting('test.ob2', true), 'ob2-164@local.test'),
    (current_setting('test.c1', true),  'c1-164@local.test'),
    (current_setting('test.c5', true),  'c5-164@local.test'),
    (current_setting('test.c6', true),  'c6-164@local.test'),
    (current_setting('test.c7', true),  'mixed.164@example.test'),
    (current_setting('test.c9', true),  'c9-164@local.test'),
    (current_setting('test.c10', true), 'c10-164@local.test'),
    (current_setting('test.c11', true), 'c11-164@local.test'),
    (current_setting('test.c12', true), 'c12-164@local.test'),
    (current_setting('test.c13', true), 'c13-164@local.test'),
    (current_setting('test.c14', true), 'c14-164@local.test'),
    (current_setting('test.c15', true), 'c15-164@local.test'),
    (current_setting('test.c17', true), 'c17-164@local.test')
  ) as v(id, email)
on conflict (id) do nothing;

-- Synthetic super_admin profile (brand NULL per profiles_role_brand_consistent).
-- Inserted as postgres: the guard skips and RLS does not apply.
insert into public.profiles (id, name, role, initials, color, status, brand_id)
values (current_setting('test.sa', true)::uuid,
        'Super Admin (test 164)', 'super_admin', 'SA', '#888888', 'active', null)
on conflict (id) do nothing;

-- Section C invitations (seeded as postgres, bypassing the P_INV policies,
-- which is the only way to write the super_admin / master / brandless-admin
-- rows that C-12..C-14 need). profile_id is NOT NULL with no FK; the seed
-- admin id stands in as the inviter sentinel.
insert into public.invitations (email, name, role, store_ids, brand_id, username, profile_id, used, expires_at)
values
  -- C-1: staff invite, brand NULL, resolves brand A from store_a
  ('c1-164@local.test', 'mary jane watson', 'user',
   array[current_setting('test.store_a', true)], null, 'reg164u',
   current_setting('test.admin_id', true)::uuid, false, now() + interval '1 day'),
  -- C-5: admin invite, brand A, store_a
  ('c5-164@local.test', 'Admin Reg', 'admin',
   array[current_setting('test.store_a', true)], current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.admin_id', true)::uuid, false, now() + interval '1 day'),
  -- C-6: staff invite, explicit brand A, no stores
  ('c6-164@local.test', 'Explicit Brand', 'user',
   array[]::text[], current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.admin_id', true)::uuid, false, null),
  -- C-7: mixed-case stored email
  ('Mixed.164@Example.test', 'Mixed Case', 'user',
   array[]::text[], null, null,
   current_setting('test.admin_id', true)::uuid, false, null),
  -- C-9: invitation exists only for a DIFFERENT email
  ('someone-else-164@local.test', 'Someone Else', 'user',
   array[]::text[], null, null,
   current_setting('test.admin_id', true)::uuid, false, null),
  -- C-10: used
  ('c10-164@local.test', 'Used Invite', 'user',
   array[]::text[], null, null,
   current_setting('test.admin_id', true)::uuid, true, null),
  -- C-11: expired
  ('c11-164@local.test', 'Expired Invite', 'user',
   array[]::text[], null, null,
   current_setting('test.admin_id', true)::uuid, false, now() - interval '1 hour'),
  -- C-12: super_admin invitation (written directly as postgres)
  ('c12-164@local.test', 'Super Invite', 'super_admin',
   array[]::text[], null, null,
   current_setting('test.admin_id', true)::uuid, false, null),
  -- C-13: master invitation
  ('c13-164@local.test', 'Master Invite', 'master',
   array[]::text[], current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.admin_id', true)::uuid, false, null),
  -- C-14: admin invitation with NULL brand
  ('c14-164@local.test', 'Brandless Admin', 'admin',
   array[]::text[], null, null,
   current_setting('test.admin_id', true)::uuid, false, null),
  -- C-15: two pending invitations for the same email
  ('c15-164@local.test', 'Dup One', 'user',
   array[]::text[], null, null,
   current_setting('test.admin_id', true)::uuid, false, null),
  ('c15-164@local.test', 'Dup Two', 'user',
   array[]::text[], null, null,
   current_setting('test.admin_id', true)::uuid, false, null),
  -- C-17: staff invite brand A but a brand-B store -> cross-brand failure
  ('c17-164@local.test', 'Cross Brand', 'user',
   array[current_setting('test.store_b', true)], current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.admin_id', true)::uuid, false, null),
  -- D-12: brand-B invitation an admin of brand A must not be able to update
  ('d12-164@local.test', 'Brand B Invite', 'user',
   array[current_setting('test.store_b', true)], current_setting('test.brand_b', true)::uuid, null,
   current_setting('test.admin_id', true)::uuid, false, null);


-- ============================================================
-- Catalog K-1..K-15 (as postgres)
-- ============================================================

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'ALL')),
  1,
  'K-1: exactly one permissive INSERT/ALL policy on public.profiles'
);

select ok(
  (select nc !~ 'auth\.uid\(\) is not null'
          and nc like '%auth_is_privileged%'
          and nc like '%auth_can_see_brand%'
     from (select lower(regexp_replace(coalesce(with_check, ''), '\s+', ' ', 'g')) as nc
             from pg_policies
            where schemaname = 'public' and tablename = 'profiles'
              and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'ALL')) x),
  'K-2: profiles INSERT with_check has no auth.uid() IS NOT NULL and is auth_is_privileged + auth_can_see_brand'
);

select ok(
  (select (t.tgtype::int & 127) = 7          -- ROW | BEFORE | INSERT only
          and t.tgenabled = 'O'
          and t.tgfoid = 'public.assert_profile_insert_role_allowed()'::regprocedure
     from pg_trigger t
    where t.tgrelid = 'public.profiles'::regclass
      and t.tgname = 'profiles_insert_role_guard'
      and not t.tgisinternal),
  'K-3: profiles_insert_role_guard is a BEFORE INSERT FOR EACH ROW trigger, enabled, calling assert_profile_insert_role_allowed()'
);

select is(
  (select prosecdef from pg_proc
    where oid = 'public.assert_profile_insert_role_allowed()'::regprocedure),
  false,
  'K-4: assert_profile_insert_role_allowed is SECURITY INVOKER'
);

select ok(
  (select 'search_path=public, auth' = any(proconfig) from pg_proc
    where oid = 'public.assert_profile_insert_role_allowed()'::regprocedure),
  'K-5: assert_profile_insert_role_allowed pins search_path = public, auth'
);

select has_function(
  'public', 'register_invited_profile', array[]::text[],
  'K-6: public.register_invited_profile() exists'
);

select ok(
  (select prosecdef and proowner::regrole::text = 'postgres' from pg_proc
    where oid = 'public.register_invited_profile()'::regprocedure),
  'K-7: register_invited_profile is SECURITY DEFINER and owned by postgres'
);

select ok(
  (select 'search_path=public' = any(proconfig) from pg_proc
    where oid = 'public.register_invited_profile()'::regprocedure),
  'K-8: register_invited_profile pins search_path = public'
);

select ok(
  has_function_privilege('authenticated', 'public.register_invited_profile()', 'EXECUTE'),
  'K-9: authenticated has EXECUTE on register_invited_profile'
);

select ok(
  not has_function_privilege('anon', 'public.register_invited_profile()', 'EXECUTE'),
  'K-10: anon has NO EXECUTE on register_invited_profile'
);

select ok(
  not has_function_privilege('public', 'public.register_invited_profile()', 'EXECUTE'),
  'K-11: PUBLIC has NO EXECUTE on register_invited_profile'
);

select ok(
  (select count(*) = 3 from pg_trigger
    where tgrelid = 'public.profiles'::regclass
      and tgname in ('profiles_self_brand_lock', 'profiles_self_delete_lock', 'profiles_sync_role_to_jwt')
      and not tgisinternal)
  and exists (select 1 from pg_constraint
               where conrelid = 'public.profiles'::regclass
                 and conname = 'profiles_role_brand_consistent'),
  'K-12: profiles_self_brand_lock, profiles_self_delete_lock, profiles_sync_role_to_jwt and profiles_role_brand_consistent are all still present'
);

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'invitations'
      and cmd in ('SELECT', 'DELETE')
      and qual = 'auth_is_privileged()'),
  2,
  'K-13: invitations SELECT and DELETE policies are unchanged (qual = auth_is_privileged())'
);

-- K-14 / K-15 mirror the migration's fail-closed DO block (architect S1):
-- a second permissive write policy would OR P_INV back open.
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'invitations'
      and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'ALL')),
  1,
  'K-14: exactly one permissive INSERT/ALL policy on public.invitations'
);

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'invitations'
      and permissive = 'PERMISSIVE' and cmd in ('UPDATE', 'ALL')),
  1,
  'K-15: exactly one permissive UPDATE/ALL policy on public.invitations'
);


-- ============================================================
-- Section A - profiles INSERT under JWT impersonation
-- ============================================================

-- --- A-1..A-3, A-5, A-6: orphan O1 (no profile, app_metadata = {}) ---
set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.o1', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'o1', 'user', null)$q$,
         current_setting('test.o1', true)),
  '42501', null,
  'A-1: profile-less caller inserting its OWN row with role=user is refused by RLS (42501)'
);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'o1', 'super_admin', null)$q$,
         current_setting('test.o1', true)),
  'P0001', 'non-user role inserts require super_admin',
  'A-2: profile-less caller inserting its OWN row with role=super_admin is refused by the guard (P0001; D6)'
);

-- A-3: disable the guard and prove RLS alone closes the hole.
reset role;
select set_config('request.jwt.claims', '', true);
alter table public.profiles disable trigger profiles_insert_role_guard;

set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.o1', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'o1', 'super_admin', null)$q$,
         current_setting('test.o1', true)),
  '42501', null,
  'A-3: with the guard disabled, RLS alone refuses the self super_admin insert (42501)'
);

reset role;
select set_config('request.jwt.claims', '', true);
alter table public.profiles enable trigger profiles_insert_role_guard;

-- A-4 (as postgres)
select ok(
  (select not (raw_app_meta_data ? 'role')
          and raw_app_meta_data = jsonb_build_object('provider','email','providers',array['email'])
     from auth.users where id = current_setting('test.o1', true)::uuid),
  'A-4: O1 raw_app_meta_data is unchanged (no role key)'
);

set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.o1', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'victim', 'user', %L::uuid)$q$,
         current_setting('test.o2', true), current_setting('test.brand_a', true)),
  '42501', null,
  'A-5: profile-less caller inserting a row for a DIFFERENT orphan (role=user, brand A) is refused (42501)'
);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'victim', 'admin', %L::uuid)$q$,
         current_setting('test.o2', true), current_setting('test.brand_a', true)),
  'P0001', 'non-user role inserts require super_admin',
  'A-6: profile-less caller inserting role=admin for a DIFFERENT orphan is refused by the guard (P0001)'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- A-7 (as postgres)
select ok(
  (select not (raw_app_meta_data ? 'role')
     from auth.users where id = current_setting('test.o2', true)::uuid)
  and not exists (select 1 from public.profiles where id = current_setting('test.o2', true)::uuid),
  'A-7: victim O2 has no profile and its raw_app_meta_data is unchanged (no role key)'
);

-- --- A-8: manager (role user, brand A) ---
set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.manager_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'ot', 'user', %L::uuid)$q$,
         current_setting('test.ot', true), current_setting('test.brand_a', true)),
  '42501', null,
  'A-8: a role=user (staff) caller inserting any profile row is refused (42501)'
);

-- --- A-9, A-11..A-15: admin A ---
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.admin_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'admin'))::text, true);

select lives_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'o3', 'user', %L::uuid)$q$,
         current_setting('test.o3', true), current_setting('test.brand_a', true)),
  'A-9: brand-A admin inserting role=user, brand A for an orphan succeeds'
);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'ot', 'user', %L::uuid)$q$,
         current_setting('test.ot', true), current_setting('test.brand_b', true)),
  '42501', null,
  'A-11: brand-A admin inserting role=user, brand B is refused (42501)'
);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'ot', 'user', null)$q$,
         current_setting('test.ot', true)),
  '42501', null,
  'A-12: brand-A admin inserting role=user, brand NULL is refused (42501)'
);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'ot', 'admin', %L::uuid)$q$,
         current_setting('test.ot', true), current_setting('test.brand_a', true)),
  'P0001', 'non-user role inserts require super_admin',
  'A-13: brand-A admin inserting role=admin, brand A is refused by the guard even though RLS would admit it (P0001)'
);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'ot', 'master', %L::uuid)$q$,
         current_setting('test.ot', true), current_setting('test.brand_a', true)),
  'P0001', 'non-user role inserts require super_admin',
  'A-14: brand-A admin inserting role=master, brand A is refused by the guard (P0001)'
);

select throws_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'ot', 'super_admin', null)$q$,
         current_setting('test.ot', true)),
  'P0001', 'non-user role inserts require super_admin',
  'A-15: brand-A admin inserting role=super_admin is refused by the guard (P0001)'
);

-- --- A-10: master A ---
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);

select lives_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'o4', 'user', %L::uuid)$q$,
         current_setting('test.o4', true), current_setting('test.brand_a', true)),
  'A-10: brand-A master inserting role=user, brand A for an orphan succeeds'
);

-- --- A-16: super_admin ---
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.sa', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'super_admin'))::text, true);

select lives_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'o5', 'admin', %L::uuid)$q$,
         current_setting('test.o5', true), current_setting('test.brand_b', true)),
  'A-16: super_admin inserting role=admin, brand B for an orphan succeeds'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- A-17 (as postgres)
select is(
  (select raw_app_meta_data->>'role' from auth.users where id = current_setting('test.o5', true)::uuid),
  'admin',
  'A-17: profiles_sync_role_to_jwt still copies the inserted role into raw_app_meta_data'
);


-- ============================================================
-- Section B - guard skips non-API roles
-- ============================================================

-- B-1: postgres (migrations, seed, pgTAP fixtures)
select lives_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'ob1', 'admin', %L::uuid)$q$,
         current_setting('test.ob1', true), current_setting('test.brand_a', true)),
  'B-1: postgres inserting role=admin is not blocked by the guard'
);

-- B-2: service_role (claims cleared)
set local role service_role;
select set_config('request.jwt.claims', '', true);

select lives_ok(
  format($q$insert into public.profiles (id, name, role, brand_id) values (%L::uuid, 'ob2', 'admin', %L::uuid)$q$,
         current_setting('test.ob2', true), current_setting('test.brand_a', true)),
  'B-2: service_role inserting role=admin is not blocked by the guard'
);

reset role;
select set_config('request.jwt.claims', '', true);


-- ============================================================
-- Section C - register_invited_profile()
-- ============================================================

-- --- C-1: staff invitation, brand resolved from store_a ---
set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c1', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);

select is(
  public.register_invited_profile(),
  current_setting('test.c1', true)::uuid,
  'C-1: user invitation registers and the RPC returns the caller uid'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select concat_ws('|', role, brand_id::text, name, username, status, color, initials)
     from public.profiles where id = current_setting('test.c1', true)::uuid),
  concat_ws('|', 'user', current_setting('test.brand_a', true), 'mary jane watson', 'reg164u',
            'active', '#378ADD', 'MJ'),
  'C-2: registered profile = (user, brand A resolved from the store, name, username, active, #378ADD, MJ)'
);

select is(
  (select array_agg(store_id::text order by store_id)
     from public.user_stores where user_id = current_setting('test.c1', true)::uuid),
  array[current_setting('test.store_a', true)],
  'C-3: user_stores for the registrant is exactly {store_A}'
);

select ok(
  (select used and profile_id = current_setting('test.c1', true)::uuid
     from public.invitations where email = 'c1-164@local.test')
  and (select raw_app_meta_data->>'role' = 'user'
         from auth.users where id = current_setting('test.c1', true)::uuid),
  'C-4: invitation is used=true with profile_id = caller, and app_metadata.role = user'
);

-- --- C-5: admin invitation (also proves B-3: guard skips the definer RPC) ---
set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c5', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);

select is(
  public.register_invited_profile(),
  current_setting('test.c5', true)::uuid,
  'C-5a: admin invitation registers via the SECURITY DEFINER RPC (guard skips; B-3)'
);

reset role;
select set_config('request.jwt.claims', '', true);

select ok(
  (select p.role = 'admin'
          and p.brand_id = current_setting('test.brand_a', true)::uuid
          and u.raw_app_meta_data->>'role' = 'admin'
     from public.profiles p join auth.users u on u.id = p.id
    where p.id = current_setting('test.c5', true)::uuid),
  'C-5b: admin registrant has role admin, brand A, and app_metadata.role = admin'
);

-- --- C-6: staff invitation with explicit brand A ---
set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c6', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);

select is(
  public.register_invited_profile(),
  current_setting('test.c6', true)::uuid,
  'C-6a: user invitation with an explicit brand registers'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select brand_id from public.profiles where id = current_setting('test.c6', true)::uuid),
  current_setting('test.brand_a', true)::uuid,
  'C-6b: explicit invitation brand_id wins (coalesce first arm)'
);

-- --- C-7: case-insensitive email match ---
set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c7', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);

select is(
  public.register_invited_profile(),
  current_setting('test.c7', true)::uuid,
  'C-7: invitation for Mixed.164@Example.test is claimed by auth email mixed.164@example.test'
);

-- --- C-8: repeat call by the C-1 registrant ---
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c1', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);

select throws_ok(
  'select public.register_invited_profile()',
  'P0001', 'profile already exists',
  'C-8a: a second call by an already-registered caller is refused'
);

reset role;
select set_config('request.jwt.claims', '', true);

select ok(
  (select count(*) = 1 and bool_and(role = 'user')
     from public.profiles where id = current_setting('test.c1', true)::uuid)
  and (select count(*) = 1
         from public.user_stores where user_id = current_setting('test.c1', true)::uuid),
  'C-8b: the repeat call left exactly one profile (role user) and the user_stores count unchanged'
);

-- --- C-9..C-15: refusals ---
set local role authenticated;

select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c9', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);
select throws_ok(
  'select public.register_invited_profile()',
  'P0001', 'no pending invitation',
  'C-9: invitation exists only for a different email -> no pending invitation'
);

select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c10', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);
select throws_ok(
  'select public.register_invited_profile()',
  'P0001', 'no pending invitation',
  'C-10: used invitation -> no pending invitation'
);

select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c11', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);
select throws_ok(
  'select public.register_invited_profile()',
  'P0001', 'no pending invitation',
  'C-11: expired invitation -> no pending invitation'
);

select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c12', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);
select throws_ok(
  'select public.register_invited_profile()',
  'P0001', 'invitation role not allowed',
  'C-12: super_admin invitation -> invitation role not allowed'
);

select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c13', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);
select throws_ok(
  'select public.register_invited_profile()',
  'P0001', 'invitation role not allowed',
  'C-13: master invitation -> invitation role not allowed'
);

select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c14', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);
select throws_ok(
  'select public.register_invited_profile()',
  'P0001', 'admin invitation requires a brand',
  'C-14: admin invitation with NULL brand -> admin invitation requires a brand'
);

select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c15', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);
select throws_ok(
  'select public.register_invited_profile()',
  'P0001', 'multiple pending invitations',
  'C-15: two pending invitations for the same email -> multiple pending invitations'
);

-- --- C-16: no claims -> auth.uid() is null ---
select set_config('request.jwt.claims', '', true);
select throws_ok(
  'select public.register_invited_profile()',
  'P0001', 'not authenticated',
  'C-16: authenticated role with no JWT subject -> not authenticated'
);

-- --- C-17: downstream cross-brand user_stores failure aborts the call ---
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.c17', true), 'role', 'authenticated',
                     'app_metadata', '{}'::jsonb)::text, true);
select throws_like(
  'select public.register_invited_profile()',
  'cross-brand user_stores assignment rejected%',
  'C-17: brand-A invitation with a brand-B store fails in user_stores_brand_match (P0001)'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- --- C-18: no side effects for any refused registrant ---
select ok(
  (select count(*) = 0 from public.profiles
    where id = any(array[
      current_setting('test.c9', true),  current_setting('test.c10', true),
      current_setting('test.c11', true), current_setting('test.c12', true),
      current_setting('test.c13', true), current_setting('test.c14', true),
      current_setting('test.c15', true), current_setting('test.c17', true)]::uuid[]))
  and (select count(*) = 0 from public.user_stores
        where user_id = any(array[
          current_setting('test.c9', true),  current_setting('test.c10', true),
          current_setting('test.c11', true), current_setting('test.c12', true),
          current_setting('test.c13', true), current_setting('test.c14', true),
          current_setting('test.c15', true), current_setting('test.c17', true)]::uuid[]))
  and (select bool_and(used = false) and count(*) = 8 from public.invitations
        where email in ('someone-else-164@local.test', 'c11-164@local.test',
                        'c12-164@local.test', 'c13-164@local.test', 'c14-164@local.test',
                        'c15-164@local.test', 'c17-164@local.test'))
  and (select bool_and(not (raw_app_meta_data ? 'role')) from auth.users
        where id = any(array[
          current_setting('test.c9', true),  current_setting('test.c10', true),
          current_setting('test.c11', true), current_setting('test.c12', true),
          current_setting('test.c13', true), current_setting('test.c14', true),
          current_setting('test.c15', true), current_setting('test.c17', true)]::uuid[])),
  'C-18: refused registrants (C-9..C-15, C-17) have no profile, no user_stores, invitations still unused, no app_metadata role'
);


-- ============================================================
-- Section D - invitations INSERT / UPDATE under JWT
-- ============================================================

-- --- D-1..D-12: admin A ---
set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.admin_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'admin'))::text, true);

select lives_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d1-164@local.test', 'D1', 'user', array[%L], %L::uuid, %L::uuid)$q$,
         current_setting('test.store_a', true), current_setting('test.brand_a', true),
         current_setting('test.admin_id', true)),
  'D-1: brand-A admin can insert a user invite with brand-A stores'
);

select lives_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d2-164@local.test', 'D2', 'admin', array[]::text[], %L::uuid, %L::uuid)$q$,
         current_setting('test.brand_a', true), current_setting('test.admin_id', true)),
  'D-2: brand-A admin can insert an admin invite with brand A'
);

select throws_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d3-164@local.test', 'D3', 'super_admin', array[]::text[], null, %L::uuid)$q$,
         current_setting('test.admin_id', true)),
  '42501', null,
  'D-3: brand-A admin cannot insert a super_admin invite (42501)'
);

select throws_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d4-164@local.test', 'D4', 'master', array[]::text[], %L::uuid, %L::uuid)$q$,
         current_setting('test.brand_a', true), current_setting('test.admin_id', true)),
  '42501', null,
  'D-4: brand-A admin cannot insert a master invite (42501)'
);

select throws_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d5-164@local.test', 'D5', 'user', array[]::text[], %L::uuid, %L::uuid)$q$,
         current_setting('test.brand_b', true), current_setting('test.admin_id', true)),
  '42501', null,
  'D-5: brand-A admin cannot insert a brand-B invite (42501)'
);

select throws_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d6-164@local.test', 'D6', 'user', array[%L], %L::uuid, %L::uuid)$q$,
         current_setting('test.store_b', true), current_setting('test.brand_a', true),
         current_setting('test.admin_id', true)),
  '42501', null,
  'D-6: brand-A admin cannot insert a brand-A invite carrying a brand-B store (42501)'
);

select throws_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d7-164@local.test', 'D7', 'user', array[%L], null, %L::uuid)$q$,
         current_setting('test.store_b', true), current_setting('test.admin_id', true)),
  '42501', null,
  'D-7: brand-A admin cannot insert a NULL-brand invite carrying a brand-B store (store arm alone, 42501)'
);

select throws_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d8-164@local.test', 'D8', 'user', array['not-a-uuid'], null, %L::uuid)$q$,
         current_setting('test.admin_id', true)),
  '42501', null,
  'D-8: malformed store id fails closed as 42501 (text comparison, not 22P02)'
);

select throws_ok(
  $q$update public.invitations set role = 'super_admin' where email = 'd1-164@local.test'$q$,
  '42501', null,
  'D-9: brand-A admin cannot update an invite to role=super_admin (42501)'
);

select throws_ok(
  format($q$update public.invitations set store_ids = array[%L] where email = 'd1-164@local.test'$q$,
         current_setting('test.store_b', true)),
  '42501', null,
  'D-10: brand-A admin cannot update an invite to carry a brand-B store (42501)'
);

select throws_ok(
  format($q$update public.invitations set brand_id = %L::uuid where email = 'd1-164@local.test'$q$,
         current_setting('test.brand_b', true)),
  '42501', null,
  'D-11: brand-A admin cannot update an invite to brand B (42501)'
);

with u as (
  update public.invitations
     set name = 'hijacked'
   where email = 'd12-164@local.test'
  returning 1
)
select is(
  (select count(*)::int from u),
  0,
  'D-12: brand-A admin UPDATE of a brand-B invitation affects 0 rows (USING hides it)'
);

-- --- D-13..D-16: super_admin ---
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.sa', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'super_admin'))::text, true);

select lives_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d13-164@local.test', 'D13', 'user', array[%L], %L::uuid, %L::uuid)$q$,
         current_setting('test.store_b', true), current_setting('test.brand_b', true),
         current_setting('test.sa', true)),
  'D-13: super_admin can insert a brand-B user invite with a brand-B store'
);

select lives_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d14-164@local.test', 'D14', 'admin', array[]::text[], %L::uuid, %L::uuid)$q$,
         current_setting('test.brand_b', true), current_setting('test.sa', true)),
  'D-14: super_admin can insert a brand-B admin invite'
);

select throws_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d15-164@local.test', 'D15', 'super_admin', array[]::text[], null, %L::uuid)$q$,
         current_setting('test.sa', true)),
  '42501', null,
  'D-15: super_admin cannot insert a super_admin invite (42501)'
);

select throws_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d16-164@local.test', 'D16', 'master', array[]::text[], %L::uuid, %L::uuid)$q$,
         current_setting('test.brand_b', true), current_setting('test.sa', true)),
  '42501', null,
  'D-16: super_admin cannot insert a master invite (42501)'
);

-- --- D-17: master A ---
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);

select lives_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d17-164@local.test', 'D17', 'user', array[]::text[], %L::uuid, %L::uuid)$q$,
         current_setting('test.brand_a', true), current_setting('test.master_id', true)),
  'D-17: brand-A master can insert a brand-A user invite'
);

-- --- D-18: manager (role user) ---
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.manager_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

select throws_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id)
            values ('d18-164@local.test', 'D18', 'user', array[]::text[], null, %L::uuid)$q$,
         current_setting('test.manager_id', true)),
  '42501', null,
  'D-18: a role=user caller cannot insert any invitation (42501)'
);

reset role;
select set_config('request.jwt.claims', '', true);


select * from finish();
rollback;

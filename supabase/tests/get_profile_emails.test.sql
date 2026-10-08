-- supabase/tests/get_profile_emails.test.sql
--
-- Spec 163 / pgTAP for public.get_profile_emails(uuid[]) shipped in
-- supabase/migrations/20261008000000_get_profile_emails.sql.
--
-- The function is SECURITY DEFINER and reads auth.users, so its WHERE clause
-- is the ONLY gate on PII. Its visibility must equal the privileged arm of the
-- spec-043 profiles SELECT policy "Admins can read all profiles"
-- (auth_is_privileged() and auth_can_see_brand(brand_id)), self-arm omitted.
-- Arms (8)-(16) encode the same matrix as profiles_rls_sweep.test.sql arms
-- (1)-(6) - a change to one should surface in review of the other.
--
-- Eighteen arms (plan(18)).
--   Catalog:
--     (1)  function exists with signature (uuid[])
--     (2)  prosecdef = true
--     (3)  search_path pinned to 'public, auth'
--     (4)  provolatile = 's' (stable)
--     (5)  authenticated has EXECUTE
--     (6)  anon has NO EXECUTE      - stands in for "anon -> permission denied"
--     (7)  PUBLIC has NO EXECUTE    - (see note below)
--   Behaviour:
--     (8)  super_admin: [T_A, T_B, T_NULL]       -> 3 rows (cross-brand + NULL brand)
--     (9)  super_admin: T_B row email exact
--     (10) super_admin: [ORPHAN]                 -> 0 rows (no profile -> never returned)
--     (11) admin A:     [T_A]                    -> 1 row, correct email
--     (12) admin A:     [T_B]                    -> 0 rows (cross-brand)
--     (13) admin A:     [T_NULL, SA]             -> 0 rows (NULL-brand)
--     (14) master A:    [T_A]                    -> 1 row
--     (15) master A:    [T_B, T_NULL]            -> 0 rows
--     (16) user:        all fixture ids + own id -> 0 rows, no error
--     (17) admin A:     NULL array               -> 0 rows
--     (18) admin A:     '{}' array               -> 0 rows
--
-- Anon note: the AC "anon gets permission denied" is pinned by the catalog
-- checks (6)-(7), NOT `set role anon` + throws_ok - `set role anon` segfaults
-- the CI Postgres image (spec 067; see reports_anon_revoke.test.sql). Having
-- no EXECUTE privilege is exactly what produces the runtime 42501.
--
-- Fixtures: seed admin (11111..., admin, brand A), seed manager (22222..., user,
-- brand A), seed master (33333..., master, brand A - NOT promoted; the master
-- arm needs it as a master). Synthetic brand B, synthetic auth.users +
-- profiles T_A / T_B / T_NULL / SA (super_admin, brand NULL), and an ORPHAN
-- auth.users row with no profile. Token columns set to '' (NULL-token gotcha).
--
-- JWT-impersonation pattern copied from profiles_rls_sweep.test.sql.
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(18);


-- --- fixtures (constants stashed via set_config) ---------------
do $$
begin
  perform set_config('test.admin_id',   '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.manager_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.master_id',  '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.brand_a',    '2a000000-0000-0000-0000-000000000001', true);
  perform set_config('test.brand_b',    'b2000000-0000-0000-0000-000000000163', true);
  perform set_config('test.t_a',        'a163a163-0000-0000-0000-000000000001', true);
  perform set_config('test.t_b',        'b163b163-0000-0000-0000-000000000001', true);
  perform set_config('test.t_null',     'c163c163-0000-0000-0000-000000000001', true);
  perform set_config('test.sa',         'd163d163-0000-0000-0000-000000000001', true);
  perform set_config('test.orphan',     'e163e163-0000-0000-0000-000000000001', true);
end $$;


insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 163)')
on conflict (id) do nothing;


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
       jsonb_build_object('provider','email','providers',array['email'],'role',v.role),
       '{}'::jsonb, false, false,
       '','','','','','','',''
  from (values
    (current_setting('test.t_a', true),    't-a-163@local.test',    'user'),
    (current_setting('test.t_b', true),    't-b-163@local.test',    'user'),
    (current_setting('test.t_null', true), 't-null-163@local.test', 'user'),
    (current_setting('test.sa', true),     'sa-163@local.test',     'super_admin'),
    (current_setting('test.orphan', true), 'orphan-163@local.test', 'user')
  ) as v(id, email, role)
on conflict (id) do nothing;


-- Profiles for every synthetic auth user EXCEPT the orphan.
insert into public.profiles (id, name, role, initials, color, status, brand_id)
values
  (current_setting('test.t_a', true)::uuid,
   'Target A (test 163)', 'user', 'TA', '#888888', 'active',
   current_setting('test.brand_a', true)::uuid),
  (current_setting('test.t_b', true)::uuid,
   'Target B (test 163)', 'user', 'TB', '#888888', 'active',
   current_setting('test.brand_b', true)::uuid),
  (current_setting('test.t_null', true)::uuid,
   'Target NULL (test 163)', 'user', 'TN', '#888888', 'active',
   null),
  (current_setting('test.sa', true)::uuid,
   'Super Admin (test 163)', 'super_admin', 'SA', '#888888', 'active',
   null)
on conflict (id) do nothing;


-- ============================================================
-- Catalog arms (1)-(7) - run as postgres
-- ============================================================

select has_function(
  'public', 'get_profile_emails', array['uuid[]'],
  'arm (1): public.get_profile_emails(uuid[]) exists'
);

select is(
  (select prosecdef from pg_proc
    where oid = 'public.get_profile_emails(uuid[])'::regprocedure),
  true,
  'arm (2): get_profile_emails is SECURITY DEFINER'
);

select ok(
  (select 'search_path=public, auth' = any(proconfig) from pg_proc
    where oid = 'public.get_profile_emails(uuid[])'::regprocedure),
  'arm (3): get_profile_emails pins search_path = public, auth'
);

select is(
  (select provolatile::text from pg_proc
    where oid = 'public.get_profile_emails(uuid[])'::regprocedure),
  's',
  'arm (4): get_profile_emails is STABLE'
);

select ok(
  has_function_privilege('authenticated', 'public.get_profile_emails(uuid[])', 'EXECUTE'),
  'arm (5): authenticated has EXECUTE on get_profile_emails'
);

select ok(
  not has_function_privilege('anon', 'public.get_profile_emails(uuid[])', 'EXECUTE'),
  'arm (6): anon has NO EXECUTE on get_profile_emails (runtime -> 42501 permission denied)'
);

select ok(
  not has_function_privilege('public', 'public.get_profile_emails(uuid[])', 'EXECUTE'),
  'arm (7): PUBLIC has NO EXECUTE on get_profile_emails'
);


-- ============================================================
-- Behaviour arms (8)-(10) - super_admin (synthetic SA, brand NULL)
-- ============================================================
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.sa', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

select is(
  (select count(*)::int from public.get_profile_emails(array[
     current_setting('test.t_a', true)::uuid,
     current_setting('test.t_b', true)::uuid,
     current_setting('test.t_null', true)::uuid
   ])),
  3,
  'arm (8): super_admin gets rows across two brands plus the NULL-brand profile'
);

select is(
  (select email from public.get_profile_emails(array[
     current_setting('test.t_b', true)::uuid
   ])),
  't-b-163@local.test',
  'arm (9): super_admin sees the exact auth.users email for a cross-brand profile'
);

select is(
  (select count(*)::int from public.get_profile_emails(array[
     current_setting('test.orphan', true)::uuid
   ])),
  0,
  'arm (10): an orphan auth.users row (no profile) is never returned'
);


-- ============================================================
-- Behaviour arms (11)-(13), (17)-(18) - admin, brand A
-- ============================================================
reset role;
select set_config('request.jwt.claims', '', true);
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

select results_eq(
  format(
    $q$select user_id, email from public.get_profile_emails(array[%L::uuid])$q$,
    current_setting('test.t_a', true)
  ),
  format(
    $q$values (%L::uuid, 't-a-163@local.test'::text)$q$,
    current_setting('test.t_a', true)
  ),
  'arm (11): brand-A admin gets the own-brand profile with the correct email'
);

select is(
  (select count(*)::int from public.get_profile_emails(array[
     current_setting('test.t_b', true)::uuid
   ])),
  0,
  'arm (12): brand-A admin gets 0 rows for a brand-B profile'
);

select is(
  (select count(*)::int from public.get_profile_emails(array[
     current_setting('test.t_null', true)::uuid,
     current_setting('test.sa', true)::uuid
   ])),
  0,
  'arm (13): brand-A admin gets 0 rows for NULL-brand profiles (user + super_admin)'
);

select is(
  (select count(*)::int from public.get_profile_emails(null)),
  0,
  'arm (17): NULL id array returns 0 rows (fail-closed)'
);

select is(
  (select count(*)::int from public.get_profile_emails('{}'::uuid[])),
  0,
  'arm (18): empty id array returns 0 rows (fail-closed)'
);


-- ============================================================
-- Behaviour arms (14)-(15) - master, brand A (seed master, NOT promoted)
-- ============================================================
reset role;
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'master')
  )::text,
  true
);

select is(
  (select count(*)::int from public.get_profile_emails(array[
     current_setting('test.t_a', true)::uuid
   ])),
  1,
  'arm (14): brand-A master gets the own-brand profile'
);

select is(
  (select count(*)::int from public.get_profile_emails(array[
     current_setting('test.t_b', true)::uuid,
     current_setting('test.t_null', true)::uuid
   ])),
  0,
  'arm (15): brand-A master gets 0 rows for brand-B and NULL-brand profiles'
);


-- ============================================================
-- Behaviour arm (16) - non-privileged user (seed manager, brand A)
-- ============================================================
reset role;
select set_config('request.jwt.claims', '', true);
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
  (select count(*)::int from public.get_profile_emails(array[
     current_setting('test.manager_id', true)::uuid,
     current_setting('test.admin_id', true)::uuid,
     current_setting('test.master_id', true)::uuid,
     current_setting('test.t_a', true)::uuid,
     current_setting('test.t_b', true)::uuid,
     current_setting('test.t_null', true)::uuid,
     current_setting('test.sa', true)::uuid,
     current_setting('test.orphan', true)::uuid
   ])),
  0,
  'arm (16): non-privileged user gets 0 rows (own id included), no error'
);


reset role;
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;

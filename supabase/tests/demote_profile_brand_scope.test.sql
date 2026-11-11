-- supabase/tests/demote_profile_brand_scope.test.sql
--
-- Spec 191 / pgTAP for supabase/migrations/20261109191000_demote_profile_brand_scope.sql:
--   - public.demote_profile_to_user(uuid): profiles-backed caller check, row
--     locks + caller re-read, super_admin-target gate, NULL-safe brand scope,
--     last-of-role guard with demote wording
--   - public.auth_profile_is_privileged() (profiles-backed, never the JWT)
--   - public.assert_demote_not_last_of_role(uuid, text) (advisory lock + wording)
--   - public.assert_brand_id_immutable_for_self(): super_admin direct role
--     edits (self guard + last-of-role), postgres / service_role skipped
--
-- Arm map (design section 6.1, plus the 2026-11-09 fix-plan arms), in the
-- order the design requires. plan(60).
--   K-1..K-10 (10), L-0 (1)                       catalog + lock precondition
--                                                 (K-9: step-4 re-read; K-10:
--                                                 wrapper privilege check first)
--   W-1 (1)                                       wrapper refuses a staff caller
--   A1a-c (3), A1-RU (1)                          step 2 ignores the claim
--   A2a-e (5), A2-RU (1)                          step 7 brand scope
--   A3a-b (2), A3-RU (1)                          step 6 super_admin target
--   A4a-b (4)                                     allowed in-brand demotions
--   B4 (2), L-scope (1)                           serial stale-claim arm
--   A4c-d (2), L-1 (1)                            RPC-path master lock
--   A5a-b (2), B1a-b (2), B1-RU (1)               super_admin reach; last master
--   D-pre (1), D1 (1), D1-RU (1), D2b (1), L-2 (1), D2b-RU (1)
--                                                 direct PATCH, trigger lock
--   D2a (2), D2c (2), D2d (1)                     direct PATCH last master
--   D3a-c (4), A5c (1), D4a (2), D4b (2)          promotions; postgres/service_role skip
--
-- Comment stripping: K-6, K-9 and K-10 match function text after
-- regexp_replace(..., '--[^\n]*', '', 'g'), so a comment that mentions a
-- forbidden token (the RPC's step-2 comment says "Not auth_is_privileged()")
-- neither passes nor fails an arm.
--
-- Lock probe L(role): transaction-level advisory locks persist until the final
-- rollback (and a lock taken inside a refused throws_ok subtransaction is
-- released with it), so ARM ORDER MATTERS. Keep it.
--
-- Fixtures: seed A1 = 11111... (admin, brand A), U = 22222... (user, brand A),
-- M1 = 33333... (master, brand A). Synthetic brand B and synthetic profiles
-- (prefix d1910000-...), created as postgres with claims cleared. Token
-- columns are '' (NULL-token gotcha). O is an auth.users row with no profile.
--
-- Anon is covered by catalog checks only: `set role anon` segfaults the CI
-- Postgres image (spec 067).
--
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(60);


-- --- fixtures ------------------------------------------------------
do $$
begin
  perform set_config('test.a1',      '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.u',       '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.m1',      '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.brand_a', '2a000000-0000-0000-0000-000000000001', true);
  perform set_config('test.brand_b', 'b1910000-0000-0000-0000-00000000000b', true);
  perform set_config('test.ua',      'd1910000-0000-0000-0000-000000000001', true);
  perform set_config('test.a2',      'd1910000-0000-0000-0000-000000000002', true);
  perform set_config('test.a4t',     'd1910000-0000-0000-0000-000000000003', true);
  perform set_config('test.m2',      'd1910000-0000-0000-0000-000000000004', true);
  perform set_config('test.mb',      'd1910000-0000-0000-0000-000000000005', true);
  perform set_config('test.ab',      'd1910000-0000-0000-0000-000000000006', true);
  perform set_config('test.ub',      'd1910000-0000-0000-0000-000000000007', true);
  perform set_config('test.un',      'd1910000-0000-0000-0000-000000000008', true);
  perform set_config('test.ua2',     'd1910000-0000-0000-0000-000000000009', true);
  perform set_config('test.m3',      'd1910000-0000-0000-0000-00000000000a', true);
  perform set_config('test.s1',      'd1910000-0000-0000-0000-000000000011', true);
  perform set_config('test.s2',      'd1910000-0000-0000-0000-000000000012', true);
  perform set_config('test.s3',      'd1910000-0000-0000-0000-000000000013', true);
  perform set_config('test.o',       'd1910000-0000-0000-0000-0000000000ff', true);
end $$;

select set_config('request.jwt.claims', '', true);

insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 191)')
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
       jsonb_build_object('provider','email','providers',array['email']),
       '{}'::jsonb, false, false,
       '','','','','','','',''
  from (values
    (current_setting('test.ua',  true), 'ua-191@local.test'),
    (current_setting('test.a2',  true), 'a2-191@local.test'),
    (current_setting('test.a4t', true), 'a4t-191@local.test'),
    (current_setting('test.m2',  true), 'm2-191@local.test'),
    (current_setting('test.mb',  true), 'mb-191@local.test'),
    (current_setting('test.ab',  true), 'ab-191@local.test'),
    (current_setting('test.ub',  true), 'ub-191@local.test'),
    (current_setting('test.un',  true), 'un-191@local.test'),
    (current_setting('test.ua2', true), 'ua2-191@local.test'),
    (current_setting('test.m3',  true), 'm3-191@local.test'),
    (current_setting('test.s1',  true), 's1-191@local.test'),
    (current_setting('test.s2',  true), 's2-191@local.test'),
    (current_setting('test.s3',  true), 's3-191@local.test'),
    (current_setting('test.o',   true), 'o-191@local.test')
  ) as v(id, email)
on conflict (id) do nothing;

-- As postgres: the insert guard skips and RLS does not apply.
insert into public.profiles (id, name, role, brand_id)
select v.id::uuid, v.name, v.role, v.brand::uuid
  from (values
    (current_setting('test.ua',  true), 'UA 191',  'user',        current_setting('test.brand_a', true)),
    (current_setting('test.a2',  true), 'A2 191',  'admin',       current_setting('test.brand_a', true)),
    (current_setting('test.a4t', true), 'A4t 191', 'admin',       current_setting('test.brand_a', true)),
    (current_setting('test.m2',  true), 'M2 191',  'master',      current_setting('test.brand_a', true)),
    (current_setting('test.mb',  true), 'MB 191',  'master',      current_setting('test.brand_b', true)),
    (current_setting('test.ab',  true), 'AB 191',  'admin',       current_setting('test.brand_b', true)),
    (current_setting('test.ub',  true), 'UB 191',  'user',        current_setting('test.brand_b', true)),
    (current_setting('test.un',  true), 'UN 191',  'user',        null),
    (current_setting('test.ua2', true), 'UA2 191', 'user',        current_setting('test.brand_a', true)),
    (current_setting('test.m3',  true), 'M3 191',  'user',        current_setting('test.brand_a', true)),
    (current_setting('test.s1',  true), 'S1 191',  'super_admin', null),
    (current_setting('test.s2',  true), 'S2 191',  'super_admin', null),
    (current_setting('test.s3',  true), 'S3 191',  'super_admin', null)
  ) as v(id, name, role, brand)
on conflict (id) do nothing;

-- Lock probe: true iff THIS backend holds the spec 191 advisory lock for role.
create function pg_temp.l191(p_role text) returns boolean
language sql as $$
  select exists (
    select 1 from pg_locks
     where locktype = 'advisory'
       and pid = pg_backend_pid()
       and objsubid = 1
       and granted
       and ((classid::bigint << 32) | objid::bigint) = hashtext('last_of_role:' || p_role)::bigint
  );
$$;

-- Caller helper: set local role authenticated + claims (sub, app_metadata.role).
create function pg_temp.as191(p_sub text, p_claim_role text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated',
                       'app_metadata', jsonb_build_object('role', p_claim_role))::text, true);
end $$;

-- Row snapshot helper (run as postgres).
create function pg_temp.rb191(p_id text) returns text
language sql as $$
  select role || '|' || coalesce(brand_id::text, 'NULL')
    from public.profiles where id = p_id::uuid;
$$;


-- ============================================================
-- Catalog K-1..K-8 (as postgres)
-- ============================================================

select ok(
  (select prosecdef
          and proowner::regrole::text = 'postgres'
          and 'search_path=public, auth' = any(proconfig)
     from pg_proc where oid = 'public.demote_profile_to_user(uuid)'::regprocedure),
  'K-1: demote_profile_to_user is SECURITY DEFINER, owned by postgres, search_path = public, auth'
);

select ok(
  has_function_privilege('authenticated', 'public.demote_profile_to_user(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.demote_profile_to_user(uuid)', 'EXECUTE')
  and not has_function_privilege('public', 'public.demote_profile_to_user(uuid)', 'EXECUTE'),
  'K-2: demote_profile_to_user EXECUTE: authenticated yes, anon no, PUBLIC no'
);

select ok(
  (select prosecdef
          and proowner::regrole::text = 'postgres'
          and 'search_path=public, auth' = any(proconfig)
          and prosrc ~ 'profiles'
          and prosrc !~* 'jwt|app_metadata'
     from pg_proc where oid = 'public.auth_profile_is_privileged()'::regprocedure),
  'K-3: auth_profile_is_privileged is DEFINER, owner postgres, search_path pinned, reads profiles and never the JWT'
);

select ok(
  has_function_privilege('authenticated', 'public.auth_profile_is_privileged()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.auth_profile_is_privileged()', 'EXECUTE')
  and not has_function_privilege('public', 'public.auth_profile_is_privileged()', 'EXECUTE'),
  'K-4: auth_profile_is_privileged EXECUTE: authenticated yes, anon no, PUBLIC no'
);

select ok(
  (select not prosecdef
          and provolatile = 'v'
          and 'search_path=public, auth' = any(proconfig)
     from pg_proc where oid = 'public.assert_demote_not_last_of_role(uuid,text)'::regprocedure)
  and has_function_privilege('authenticated', 'public.assert_demote_not_last_of_role(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.assert_demote_not_last_of_role(uuid,text)', 'EXECUTE')
  and not has_function_privilege('public', 'public.assert_demote_not_last_of_role(uuid,text)', 'EXECUTE'),
  'K-5: assert_demote_not_last_of_role is INVOKER, VOLATILE, search_path pinned; EXECUTE authenticated yes / anon no / PUBLIC no'
);

select ok(
  (select d like '%assert_demote_not_last_of_role(%' and d !~ 'count\s*\('
     from (select regexp_replace(pg_get_functiondef('public.demote_profile_to_user(uuid)'::regprocedure),
                                 '--[^\n]*', '', 'g') as d) x)
  and (select d like '%assert_demote_not_last_of_role(%' and d !~ 'count\s*\('
         from (select regexp_replace(pg_get_functiondef('public.assert_brand_id_immutable_for_self()'::regprocedure),
                                     '--[^\n]*', '', 'g') as d) x)
  and (select d like '%assert_not_last_of_role(%'
              and d like '%pg_advisory_xact_lock%'
              and d like '%''cannot delete the last ''%'
         from (select pg_get_functiondef('public.assert_demote_not_last_of_role(uuid,text)'::regprocedure) as d) x),
  'K-6: RPC and trigger call the wrapper and do not count; wrapper calls assert_not_last_of_role, takes the advisory lock and matches the delete wording'
);

select ok(
  coalesce((select c ~ 'profiles' and c ~ 'auth_is_privileged' and c ~ 'jwt_expiry'
              from (select obj_description('public.demote_profile_to_user(uuid)'::regprocedure, 'pg_proc') as c) x),
           false),
  'K-7: demote_profile_to_user comment documents the profiles-backed caller check and why (A8)'
);

select ok(
  (select (t.tgtype::int & 127) = 19            -- ROW | BEFORE | UPDATE only
          and t.tgfoid = 'public.assert_brand_id_immutable_for_self()'::regprocedure
     from pg_trigger t
    where t.tgrelid = 'public.profiles'::regclass
      and t.tgname = 'profiles_self_brand_lock'
      and not t.tgisinternal)
  and (select not prosecdef from pg_proc
        where oid = 'public.assert_brand_id_immutable_for_self()'::regprocedure),
  'K-8: profiles_self_brand_lock is BEFORE UPDATE FOR EACH ROW calling assert_brand_id_immutable_for_self(), which is SECURITY INVOKER'
);

-- K-9 (fix plan S3(a)): the step-4 caller re-read is the only guard that stops
-- a caller demoted while waiting for the row lock from crossing brands, and no
-- single-session arm can see it (step 2 refuses first). Pin its presence after
-- the row lock and before the brand step, and that the body never consults
-- the claim.
select ok(
  (select b ~ $re$for no key update.*v_caller_role is null\s+or v_caller_role not in \('admin', 'master', 'super_admin'\)\s+then\s+raise exception using\s+errcode = '42501',\s+message = 'forbidden';.*forbidden: target is in a different brand$re$
          and b !~ 'auth_is_privileged|auth_is_admin|jwt|app_metadata'
     from (select regexp_replace(prosrc, '--[^\n]*', '', 'g') as b
             from pg_proc where oid = 'public.demote_profile_to_user(uuid)'::regprocedure) x),
  'K-9: demote_profile_to_user re-reads the caller role after for no key update (42501 forbidden) before the brand step, and never reads the claim'
);

-- K-10 (fix plan, security L1): the wrapper's first statement is the
-- profiles-backed privilege check, ahead of its role filter and its advisory
-- lock. Lock absence cannot be probed after a refused throws_ok (the
-- subtransaction releases the lock), so the order is pinned here.
select ok(
  (select b ~ $re$^\s*begin\s+if not public\.auth_profile_is_privileged\(\) then\s+raise exception using\s+errcode = '42501',\s+message = 'forbidden';\s+end if;$re$
          and position('auth_profile_is_privileged()' in b) < position('p_role not in' in b)
          and position('auth_profile_is_privileged()' in b) < position('pg_advisory_xact_lock' in b)
     from (select regexp_replace(prosrc, '--[^\n]*', '', 'g') as b
             from pg_proc where oid = 'public.assert_demote_not_last_of_role(uuid,text)'::regprocedure) x),
  'K-10: assert_demote_not_last_of_role checks auth_profile_is_privileged() first, before its role filter and advisory lock'
);

select ok(
  not pg_temp.l191('master') and not pg_temp.l191('super_admin'),
  'L-0: no spec 191 advisory lock held before any demotion'
);


-- ============================================================
-- W-1 - the wrapper refuses an unprivileged direct caller (security L1)
-- ============================================================
-- Seed staff U (profile user) with a stale admin claim calls the wrapper
-- over "PostgREST" for a guarded role. Without the privilege check it would
-- take the master advisory lock and return (or answer the last-of-role
-- question); with it, 42501 before any lock.
set local role authenticated;
select pg_temp.as191(current_setting('test.u', true), 'admin');
select throws_ok(
  $q$select public.assert_demote_not_last_of_role('d1910000-0000-0000-0000-0000000000ee'::uuid, 'master')$q$,
  '42501', 'forbidden',
  'W-1: staff caller (profile user, stale admin claim) calling the wrapper directly is refused (42501 forbidden)'
);
reset role;
select set_config('request.jwt.claims', '', true);


-- ============================================================
-- A1 - step 2 decides from profiles.role, never the claim
-- ============================================================
set local role authenticated;

select pg_temp.as191(current_setting('test.u', true), 'admin');
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.ua', true)),
  '42501', 'forbidden',
  'A1a: user profile with a stale admin claim is refused (42501 forbidden)'
);

select pg_temp.as191(current_setting('test.o', true), 'admin');
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.ua', true)),
  '42501', 'forbidden',
  'A1b: profile-less login with an admin claim is refused (42501 forbidden)'
);

select pg_temp.as191(current_setting('test.u', true), 'super_admin');
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.ua', true)),
  '42501', 'forbidden',
  'A1c: user profile with a super_admin claim is refused (42501 forbidden)'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.rb191(current_setting('test.ua', true)),
          'user|' || current_setting('test.brand_a', true),
          'A1-RU: UA unchanged after the A1 refusals');


-- ============================================================
-- A2 - brand scope for admin / master callers
-- ============================================================
set local role authenticated;

select pg_temp.as191(current_setting('test.a1', true), 'admin');
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.ab', true)),
  '42501', 'forbidden: target is in a different brand',
  'A2a: brand-A admin demoting a brand-B admin is refused'
);
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.ub', true)),
  '42501', 'forbidden: target is in a different brand',
  'A2b: brand-A admin demoting a brand-B user is refused'
);
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.un', true)),
  '42501', 'forbidden: target is in a different brand',
  'A2c: brand-A admin demoting a NULL-brand user is refused (NULL-safe comparison)'
);

select pg_temp.as191(current_setting('test.a1', true), 'super_admin');
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.ab', true)),
  '42501', 'forbidden: target is in a different brand',
  'A2d: brand-A admin with a forged super_admin claim still gets the brand refusal'
);

select pg_temp.as191(current_setting('test.mb', true), 'master');
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.ua', true)),
  '42501', 'forbidden: target is in a different brand',
  'A2e: brand-B master demoting a brand-A user is refused'
);

reset role;
select set_config('request.jwt.claims', '', true);

select ok(
  pg_temp.rb191(current_setting('test.ab', true)) = 'admin|' || current_setting('test.brand_b', true)
  and pg_temp.rb191(current_setting('test.ub', true)) = 'user|' || current_setting('test.brand_b', true)
  and pg_temp.rb191(current_setting('test.un', true)) = 'user|NULL'
  and pg_temp.rb191(current_setting('test.ua', true)) = 'user|' || current_setting('test.brand_a', true),
  'A2-RU: AB, UB, UN and UA unchanged after the A2 refusals'
);


-- ============================================================
-- A3 - only a super_admin may demote a super_admin
-- ============================================================
set local role authenticated;

select pg_temp.as191(current_setting('test.a1', true), 'admin');
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.s1', true)),
  '42501', 'forbidden: only a super_admin can demote a super_admin',
  'A3a: admin demoting a super_admin is refused'
);

select pg_temp.as191(current_setting('test.m1', true), 'master');
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.s1', true)),
  '42501', 'forbidden: only a super_admin can demote a super_admin',
  'A3b: master demoting a super_admin is refused'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.rb191(current_setting('test.s1', true)), 'super_admin|NULL',
          'A3-RU: S1 still super_admin');


-- ============================================================
-- A4a/b - allowed in-brand demotions (unguarded roles)
-- ============================================================
set local role authenticated;
select pg_temp.as191(current_setting('test.a1', true), 'admin');

select is(public.demote_profile_to_user(current_setting('test.ua', true)::uuid),
          current_setting('test.ua', true)::uuid,
          'A4a: admin demotes a same-brand user and gets its id back');
select is(public.demote_profile_to_user(current_setting('test.a2', true)::uuid),
          current_setting('test.a2', true)::uuid,
          'A4b: admin demotes a same-brand admin and gets its id back');

reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.rb191(current_setting('test.ua', true)), 'user|NULL',
          'A4a: UA is now (user, NULL)');
select is(pg_temp.rb191(current_setting('test.a2', true)), 'user|NULL',
          'A4b: A2 is now (user, NULL)');


-- ============================================================
-- B4 - serial arm: the demoted admin's stale claim cannot demote back
-- ============================================================
set local role authenticated;
select pg_temp.as191(current_setting('test.a2', true), 'admin');

select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.a1', true)),
  '42501', 'forbidden',
  'B4: demoted A2 (profile user, claim still admin) cannot demote A1'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.rb191(current_setting('test.a1', true)), 'admin|' || current_setting('test.brand_a', true),
          'B4: A1 unchanged');

-- L-scope also probes the 'user' and 'admin' keys, so a wrapper that locks
-- before its role filter (every role) turns this arm red.
select ok(
  not pg_temp.l191('master') and not pg_temp.l191('super_admin')
  and not pg_temp.l191('admin') and not pg_temp.l191('user'),
  'L-scope: no advisory lock taken by demotions of unguarded roles'
);


-- ============================================================
-- A4c/d - master caller; demoting a non-last master takes the lock
-- ============================================================
set local role authenticated;

select pg_temp.as191(current_setting('test.m1', true), 'master');
select is(public.demote_profile_to_user(current_setting('test.a4t', true)::uuid),
          current_setting('test.a4t', true)::uuid,
          'A4c: master demotes a same-brand admin');

select pg_temp.as191(current_setting('test.a1', true), 'admin');
select is(public.demote_profile_to_user(current_setting('test.m2', true)::uuid),
          current_setting('test.m2', true)::uuid,
          'A4d: admin demotes a same-brand master while M1 and MB remain');

reset role;
select set_config('request.jwt.claims', '', true);

select ok(pg_temp.l191('master'),
          'L-1: the RPC path took the master advisory lock');


-- ============================================================
-- A5a/b - super_admin reaches every brand; B1 - last master
-- ============================================================
set local role authenticated;
select pg_temp.as191(current_setting('test.s1', true), 'super_admin');

select is(public.demote_profile_to_user(current_setting('test.ab', true)::uuid),
          current_setting('test.ab', true)::uuid,
          'A5a: super_admin demotes a brand-B admin (cross-brand)');
select is(public.demote_profile_to_user(current_setting('test.mb', true)::uuid),
          current_setting('test.mb', true)::uuid,
          'A5b: super_admin demotes brand-B master MB, leaving M1 as the only master');

select pg_temp.as191(current_setting('test.a1', true), 'admin');
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.m1', true)),
  'P0001', 'cannot demote the last master',
  'B1a: same-brand admin demoting the only master is refused with the demote wording'
);

select pg_temp.as191(current_setting('test.s1', true), 'super_admin');
select throws_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.m1', true)),
  'P0001', 'cannot demote the last master',
  'B1b: super_admin demoting the only master is refused with the demote wording'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.rb191(current_setting('test.m1', true)), 'master|' || current_setting('test.brand_a', true),
          'B1-RU: M1 still (master, A)');


-- ============================================================
-- D - super_admin direct PATCH on profiles.role (trigger path)
-- ============================================================
select ok(not pg_temp.l191('super_admin'),
          'D-pre: no super_admin advisory lock held yet');

set local role authenticated;
select pg_temp.as191(current_setting('test.s1', true), 'super_admin');

select throws_ok(
  format($q$update public.profiles set role = 'user' where id = %L::uuid$q$, current_setting('test.s1', true)),
  'P0001', 'cannot demote self',
  'D1: super_admin changing their own role by direct UPDATE is refused (S1, S2, S3 present)'
);

reset role;
select is(pg_temp.rb191(current_setting('test.s1', true)), 'super_admin|NULL',
          'D1-RU: S1 still super_admin');

set local role authenticated;
select lives_ok(
  format($q$update public.profiles set role = 'user' where id = %L::uuid$q$, current_setting('test.s3', true)),
  'D2b: super_admin demotes another super_admin (S3) by direct UPDATE while two others remain'
);

reset role;
select ok(pg_temp.l191('super_admin'),
          'L-2: the trigger path took the super_admin advisory lock');
select is(pg_temp.rb191(current_setting('test.s3', true)), 'user|NULL',
          'D2b-RU: S3 is now (user, NULL)');

set local role authenticated;
select throws_ok(
  format($q$update public.profiles set role = 'admin' where id = %L::uuid$q$, current_setting('test.m1', true)),
  'P0001', 'cannot demote the last master',
  'D2a: super_admin moving the only master to admin by direct UPDATE is refused'
);

reset role;
select is(pg_temp.rb191(current_setting('test.m1', true)), 'master|' || current_setting('test.brand_a', true),
          'D2a-RU: M1 still (master, A)');

-- D2c: two masters, one multi-row statement that would remove both.
update public.profiles set role = 'master', brand_id = current_setting('test.brand_a', true)::uuid
 where id = current_setting('test.m3', true)::uuid;

set local role authenticated;
select throws_ok(
  $q$update public.profiles set role = 'user', brand_id = null where role = 'master'$q$,
  'P0001', 'cannot demote the last master',
  'D2c: multi-row super_admin UPDATE removing every master is refused on the last row'
);

reset role;
select ok(
  pg_temp.rb191(current_setting('test.m1', true)) = 'master|' || current_setting('test.brand_a', true)
  and pg_temp.rb191(current_setting('test.m3', true)) = 'master|' || current_setting('test.brand_a', true),
  'D2c-RU: M1 and M3 both still (master, A)'
);

-- D2d: back to one master; promoting it to super_admin moves it off master.
update public.profiles set role = 'user' where id = current_setting('test.m3', true)::uuid;

set local role authenticated;
select throws_ok(
  format($q$update public.profiles set role = 'super_admin', brand_id = null where id = %L::uuid$q$,
         current_setting('test.m1', true)),
  'P0001', 'cannot demote the last master',
  'D2d: promoting the only master straight to super_admin is refused (moves the row off master)'
);

-- D3: promotions are not guarded.
select lives_ok(
  format($q$update public.profiles set role = 'admin' where id = %L::uuid$q$, current_setting('test.ua2', true)),
  'D3a: super_admin promotes UA2 from user to admin'
);
select lives_ok(
  format($q$update public.profiles set role = 'master' where id = %L::uuid$q$, current_setting('test.ua2', true)),
  'D3b: super_admin promotes UA2 from admin to master'
);
select lives_ok(
  format($q$update public.profiles set role = 'super_admin', brand_id = null where id = %L::uuid$q$,
         current_setting('test.un', true)),
  'D3c: super_admin promotes UN from user to super_admin'
);

reset role;
select ok(
  pg_temp.rb191(current_setting('test.ua2', true)) = 'master|' || current_setting('test.brand_a', true)
  and pg_temp.rb191(current_setting('test.un', true)) = 'super_admin|NULL',
  'D3: UA2 is (master, A) and UN is (super_admin, NULL)'
);

-- A5c: S1 demotes S2 through the RPC while S1 and UN remain. Claims are
-- re-asserted so the arm does not depend on S1's claims surviving the role
-- resets above.
set local role authenticated;
select pg_temp.as191(current_setting('test.s1', true), 'super_admin');
select is(public.demote_profile_to_user(current_setting('test.s2', true)::uuid),
          current_setting('test.s2', true)::uuid,
          'A5c: super_admin demotes another super_admin through the RPC while two remain');


-- ============================================================
-- D4 - postgres and service_role skip the new branch (S1 claims kept)
-- ============================================================
reset role;   -- claims deliberately NOT cleared: auth.uid() is still S1

select lives_ok(
  $q$update public.profiles set role = 'user', brand_id = null where role = 'master'$q$,
  'D4a: postgres with super_admin claims set can remove every master (branch skips postgres)'
);
select ok(
  pg_temp.rb191(current_setting('test.m1', true)) = 'user|NULL'
  and pg_temp.rb191(current_setting('test.ua2', true)) = 'user|NULL',
  'D4a-RU: M1 and UA2 are now (user, NULL)'
);

update public.profiles set role = 'master', brand_id = current_setting('test.brand_a', true)::uuid
 where id = current_setting('test.m1', true)::uuid;

set local role service_role;
select lives_ok(
  format($q$update public.profiles set role = 'user', brand_id = null where id = %L::uuid$q$,
         current_setting('test.m1', true)),
  'D4b: service_role with super_admin claims set can remove the only master (branch skips service_role)'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.rb191(current_setting('test.m1', true)), 'user|NULL',
          'D4b-RU: M1 is now (user, NULL)');


select * from finish();
rollback;

-- supabase/tests/invitations_hardening.test.sql
--
-- Spec 198 / pgTAP for supabase/migrations/20261110120000_invitations_hardening.sql
-- (design section 8.1):
--   - invitations SELECT/DELETE brand-scoped, profiles-backed, to authenticated,
--     plus the D-7 rule (brand-less, store-less rows: super_admin + inviter)
--   - invite code: sha256 stored, plaintext returned once by create_invitation
--   - register_invited_profile(p_code): select by code, NULL expiry = expired,
--     inviter re-check (D3, FOR SHARE)
--   - check_invitation_code(email, code): same conditions as the claim
--   - expiry bound on INSERT/UPDATE (D-3) and the D-4 clamp
--   - invited_by provenance trigger (D1/D2)
--   - grants: get_pending_invitation and register_invited_profile() dropped,
--     consume_invitation off authenticated, assert_not_last_of_role off anon,
--     assert_invitation_provenance() off public/anon/authenticated (review L2)
--   - review H1: UPDATE is super_admin-only and on unused rows only, so no
--     client can revive a consumed invitation
--
-- Arm map (plan(102)):
--   Catalog  K-a..K-h (9; K-f carries two)                  as postgres
--            A7 (1), E1 (1), E2 (1)                         catalog
--   C3       (3)  clamp: pre-state, then a copy of the migration's clamp
--                 UPDATE (consume_invitation arm C pattern); the two copies
--                 are pinned equal by src/lib/invitationsClamp.source.test.ts
--   B6-agree (1)  check_invitation_code vs the claim, every B2/B3/D3/B5
--                 fixture (incl. the sha256('') blank-code row), run BEFORE
--                 any claim consumes them
--   A2 (3), A3 (2), A4 (2), A5 (2), A6 (7)                   RLS under JWT
--   B1 (4)  create_invitation shape + hash + no plaintext + the code claims
--   B2-staff (5; doubles as D4), B2-admin (2), B2-zero (4)
--   B3-1..9 (9) + B3-2b (1, blank code vs a sha256('') row) + B3-side (1)
--   B5 (3), B8-srv (5), B8-scope (1)
--   CI-1..3 (3)  create_invitation refusals
--   C1 (5), C2 (5), D1 (2), D2 (2), D3-a (1), D3-b (4), D3-c (2)
--   H1-a (2), H1-b (2), H1-c (2), H1-d (5)   revival of a consumed invitation
--
-- C2 and D2 run their admitted UPDATEs as the super_admin: since review H1 a
-- brand admin's UPDATE matches 0 rows (C2 pins that too).
--
-- Each refusal fixture differs from the claimable baseline (role user, brand
-- A, no stores, invited_by = seed admin 1111, unused, expires now()+1 day, a
-- known code) in exactly one attribute, so removing one predicate turns
-- exactly its own arm red.
--
-- Anon is covered by catalog checks only: `set role anon` segfaults the CI
-- Postgres image (spec 067).
--
-- JWT switching: claims are set as postgres, then `set local role
-- authenticated` (pg_temp helpers are only called as postgres).
--
-- Fixtures: seed admin 1111 (brand A), manager 2222 (role user, brand A),
-- master 3333 (brand A). Synthetic: brand B, stores A1/A2 (brand A) and B1
-- (brand B) with non-blank addresses, super_admin SA (brand NULL), a second
-- brand-A admin A2ADM, a disposable brand-A admin DEMOTEE (D3-b), and orphan
-- registrants (auth.users only; token columns '' per the NULL-token gotcha).
--
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(102);


-- --- constants -------------------------------------------------------------
do $$
begin
  perform set_config('test.admin',    '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.manager',  '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.master',   '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.brand_a',  '2a000000-0000-0000-0000-000000000001', true);
  perform set_config('test.brand_b',  'b2000000-0000-0000-0000-000000000198', true);
  perform set_config('test.store_a1', 'a5198000-0000-0000-0000-0000000000a1', true);
  perform set_config('test.store_a2', 'a5198000-0000-0000-0000-0000000000a2', true);
  perform set_config('test.store_b1', 'b5198000-0000-0000-0000-0000000000b1', true);
  perform set_config('test.sa',       'd1980000-0000-0000-0000-000000000001', true);
  perform set_config('test.a2adm',    'd1980000-0000-0000-0000-000000000002', true);
  perform set_config('test.demotee',  'd1980000-0000-0000-0000-000000000003', true);
  perform set_config('test.ghost',    'd1980000-0000-0000-0000-0000000000ff', true);  -- no profile
  -- registrants (orphans)
  perform set_config('test.r_b1',     'e1980000-0000-0000-0000-000000000001', true);
  perform set_config('test.r_staff',  'e1980000-0000-0000-0000-000000000002', true);
  perform set_config('test.r_admin',  'e1980000-0000-0000-0000-000000000003', true);
  perform set_config('test.r_za',     'e1980000-0000-0000-0000-000000000004', true);
  perform set_config('test.r_zb',     'e1980000-0000-0000-0000-000000000005', true);
  perform set_config('test.r31',      'e1980000-0000-0000-0000-000000000031', true);
  perform set_config('test.r35',      'e1980000-0000-0000-0000-000000000035', true);
  perform set_config('test.r36',      'e1980000-0000-0000-0000-000000000036', true);
  perform set_config('test.r37',      'e1980000-0000-0000-0000-000000000037', true);
  perform set_config('test.r38',      'e1980000-0000-0000-0000-000000000038', true);
  perform set_config('test.r39',      'e1980000-0000-0000-0000-000000000039', true);
  perform set_config('test.r5',       'e1980000-0000-0000-0000-000000000050', true);
  perform set_config('test.r8',       'e1980000-0000-0000-0000-000000000080', true);
  perform set_config('test.r3a',      'e1980000-0000-0000-0000-0000000003a0', true);
  perform set_config('test.r3b',      'e1980000-0000-0000-0000-0000000003b0', true);
  perform set_config('test.r3c1',     'e1980000-0000-0000-0000-0000000003c1', true);
  perform set_config('test.r3c2',     'e1980000-0000-0000-0000-0000000003c2', true);
  perform set_config('test.r_blank',  'e1980000-0000-0000-0000-0000000000b0', true);
  perform set_config('test.r_h1burn', 'e1980000-0000-0000-0000-0000000001b1', true);
  perform set_config('test.r_x',      'e1980000-0000-0000-0000-0000000001d1', true);
  perform set_config('test.r_xburn',  'e1980000-0000-0000-0000-0000000001d2', true);
  -- invitation fixture ids (A arms)
  perform set_config('test.fx_i',     'f1980000-0000-0000-0000-000000000001', true);
  perform set_config('test.fx_ii',    'f1980000-0000-0000-0000-000000000002', true);
  perform set_config('test.fx_iii',   'f1980000-0000-0000-0000-000000000003', true);
  perform set_config('test.fx_a5a',   'f1980000-0000-0000-0000-000000000005', true);
  perform set_config('test.fx_a5b',   'f1980000-0000-0000-0000-000000000006', true);
  perform set_config('test.fx_bdel',  'f1980000-0000-0000-0000-000000000007', true);
  perform set_config('test.fx_leg',   'f1980000-0000-0000-0000-000000000008', true);
  -- known codes (32 lowercase hex)
  perform set_config('test.c_staff',  'c0de1980000000000000000000000002', true);
  perform set_config('test.c31',      'c0de1980000000000000000000000031', true);
  perform set_config('test.c34',      'c0de1980000000000000000000000034', true);
  perform set_config('test.c35',      'c0de1980000000000000000000000035', true);
  perform set_config('test.c36',      'c0de1980000000000000000000000036', true);
  perform set_config('test.c37',      'c0de1980000000000000000000000037', true);
  perform set_config('test.c38',      'c0de1980000000000000000000000038', true);
  perform set_config('test.c39',      'c0de1980000000000000000000000039', true);  -- never stored
  perform set_config('test.c_wrong',  'ffffffffffffffffffffffffffffffff', true);  -- never stored
  perform set_config('test.c5a',      'c0de19800000000000000000000005aa', true);
  perform set_config('test.c5b',      'c0de19800000000000000000000005bb', true);
  perform set_config('test.c3a',      'c0de19800000000000000000000003aa', true);
  perform set_config('test.c3c1',     'c0de19800000000000000000000003c1', true);
  perform set_config('test.c3c2',     'c0de19800000000000000000000003c2', true);
  perform set_config('test.c_misc',   'c0de19800000000000000000000000ff', true);
  perform set_config('test.sentinel', '00000000-0000-0000-0000-000000000000', true);
end $$;

create function pg_temp.h(p text) returns text language sql immutable as
  $f$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $f$;

create function pg_temp.jwt(p_sub text, p_role text) returns text language sql stable as
  $f$ select jsonb_build_object('sub', p_sub, 'role', 'authenticated',
       'app_metadata', case when p_role is null then '{}'::jsonb
                            else jsonb_build_object('role', p_role) end)::text $f$;


-- --- C3-pre: before any invitation fixture ------------------------------
select is(
  (select count(*)::int from public.invitations
    where used = false and (expires_at is null or expires_at > now() + interval '7 days')),
  0,
  'C3-pre: after the migration no pending invitation is NULL-expiry or past now()+7 days'
);


-- --- brands, stores, users ------------------------------------------------
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 198)')
on conflict (id) do nothing;

insert into public.stores (id, name, address, brand_id)
values
  (current_setting('test.store_a1', true)::uuid, 'Store A1 (test 198)', '1 A1 Street', current_setting('test.brand_a', true)::uuid),
  (current_setting('test.store_a2', true)::uuid, 'Store A2 (test 198)', '1 A2 Street', current_setting('test.brand_a', true)::uuid),
  (current_setting('test.store_b1', true)::uuid, 'Store B1 (test 198)', '1 B1 Street', current_setting('test.brand_b', true)::uuid)
on conflict (id) do nothing;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, is_anonymous,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select v.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       v.email, '', now(), now(), now(),
       jsonb_build_object('provider','email','providers',array['email']),
       '{}'::jsonb, false, false, '','','','','','','',''
  from (values
    (current_setting('test.sa', true),       'sa-198@local.test'),
    (current_setting('test.a2adm', true),    'a2adm-198@local.test'),
    (current_setting('test.demotee', true),  'demotee-198@local.test'),
    (current_setting('test.r_b1', true),     'b1-198@local.test'),
    (current_setting('test.r_staff', true),  'B2STAFF-198@LOCAL.TEST'),
    (current_setting('test.r_admin', true),  'b2admin-198@local.test'),
    (current_setting('test.r_za', true),     'b2za-198@local.test'),
    (current_setting('test.r_zb', true),     'b2zb-198@local.test'),
    (current_setting('test.r31', true),      'b31-198@local.test'),
    (current_setting('test.r35', true),      'r35-198@local.test'),
    (current_setting('test.r36', true),      'b36-198@local.test'),
    (current_setting('test.r37', true),      'b37-198@local.test'),
    (current_setting('test.r38', true),      'b38-198@local.test'),
    (current_setting('test.r39', true),      'b39-198@local.test'),
    (current_setting('test.r5', true),       'b5-198@local.test'),
    (current_setting('test.r8', true),       'b8-198@local.test'),
    (current_setting('test.r3a', true),      'd3a-198@local.test'),
    (current_setting('test.r3b', true),      'd3b-198@local.test'),
    (current_setting('test.r3c1', true),     'd3c1-198@local.test'),
    (current_setting('test.r3c2', true),     'd3c2-198@local.test'),
    (current_setting('test.r_blank', true),  'bblank-198@local.test'),
    (current_setting('test.r_h1burn', true), 'h1-burner-198@local.test'),
    (current_setting('test.r_x', true),      'h1x-198@local.test'),
    (current_setting('test.r_xburn', true),  'h1x-burner-198@local.test')
  ) as v(id, email)
on conflict (id) do nothing;

insert into public.profiles (id, name, role, initials, color, status, brand_id)
values
  (current_setting('test.sa', true)::uuid,      'Super Admin 198', 'super_admin', 'SA', '#888888', 'active', null),
  (current_setting('test.a2adm', true)::uuid,   'Second Admin 198', 'admin', 'SA', '#888888', 'active', current_setting('test.brand_a', true)::uuid),
  (current_setting('test.demotee', true)::uuid, 'Demotee 198', 'admin', 'DE', '#888888', 'active', current_setting('test.brand_a', true)::uuid)
on conflict (id) do nothing;


-- ============================================================
-- Catalog (as postgres)
-- ============================================================

select ok(
  (select bool_and(n = 1) from (
     select c, (select count(*) from pg_policies
                 where schemaname = 'public' and tablename = 'invitations'
                   and permissive = 'PERMISSIVE' and cmd in (c, 'ALL')) as n
       from unnest(array['SELECT','INSERT','UPDATE','DELETE']) c) x)
  and (select count(*) = 4 and bool_and(roles = '{authenticated}'::name[])
         from pg_policies where schemaname = 'public' and tablename = 'invitations')
  and not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'invitations'
                     and ('anon' = any(roles) or 'public' = any(roles))),
  'K-a: one permissive policy each for SELECT/INSERT/UPDATE/DELETE (ALL counted), all {authenticated}, none names anon or public'
);

select ok(
  (select bool_and(t is null or (t like '%auth_profile_is_privileged()%' and t not like '%auth_is_privileged()%'))
     from (select lower(regexp_replace(qual, '\s+', ' ', 'g')) t
             from pg_policies where schemaname = 'public' and tablename = 'invitations'
           union all
           select lower(regexp_replace(with_check, '\s+', ' ', 'g'))
             from pg_policies where schemaname = 'public' and tablename = 'invitations') x)
  and (select count(*) = 2 from pg_policies
        where schemaname = 'public' and tablename = 'invitations' and cmd in ('SELECT', 'DELETE')
          and lower(regexp_replace(qual, '\s+', ' ', 'g')) like '%auth_can_see_brand%'
          and lower(regexp_replace(qual, '\s+', ' ', 'g')) like '%auth_is_super_admin()%'
          and lower(regexp_replace(qual, '\s+', ' ', 'g')) like '%invited_by = auth.uid()%')
  and (select count(*) = 1 from pg_policies
        where schemaname = 'public' and tablename = 'invitations' and cmd = 'INSERT'
          and lower(regexp_replace(with_check, '\s+', ' ', 'g')) like '%code_hash is not null%'
          and lower(regexp_replace(with_check, '\s+', ' ', 'g')) like '%invited_by = auth.uid()%'
          and lower(regexp_replace(with_check, '\s+', ' ', 'g')) like '%7 days%')
  and (select count(*) = 1 from pg_policies
        where schemaname = 'public' and tablename = 'invitations' and cmd = 'UPDATE'
          and lower(regexp_replace(qual, '\s+', ' ', 'g')) like '%invited_by = auth.uid()%'
          and lower(regexp_replace(with_check, '\s+', ' ', 'g')) like '%7 days%')
  -- review H1: used = false in both, and a super_admin-only leaf on top of
  -- D7's own auth_is_super_admin() arm (so at least two occurrences each)
  and (select count(*) = 1 from pg_policies
        where schemaname = 'public' and tablename = 'invitations' and cmd = 'UPDATE'
          and lower(regexp_replace(qual, '\s+', ' ', 'g')) like '%used = false%'
          and lower(regexp_replace(with_check, '\s+', ' ', 'g')) like '%used = false%'
          and regexp_count(lower(qual), 'auth_is_super_admin\(\)') >= 2
          and regexp_count(lower(with_check), 'auth_is_super_admin\(\)') >= 2),
  'K-b: policy text checks (design 2.4 item 3, plus the H1 used = false and super_admin-only UPDATE leaves) hold on all four invitations policies'
);

select ok(
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'invitations'
             and column_name = 'invited_by' and data_type = 'uuid')
  and exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'invitations'
                 and column_name = 'code_hash' and data_type = 'text')
  and exists (select 1 from pg_indexes
               where schemaname = 'public' and tablename = 'invitations'
                 and indexname = 'invitations_code_hash_key'
                 and indexdef ilike 'create unique index%(code_hash)%where (code_hash is not null)%')
  and exists (select 1 from pg_constraint
               where conrelid = 'public.invitations'::regclass
                 and conname = 'invitations_code_hash_format' and contype = 'c'),
  'K-c: invited_by uuid, code_hash text, partial unique index invitations_code_hash_key, check invitations_code_hash_format'
);

select ok(
  (select (t.tgtype::int & 127) = 23          -- ROW | BEFORE | INSERT | UPDATE
          and t.tgenabled = 'O'
          and t.tgfoid = 'public.assert_invitation_provenance()'::regprocedure
     from pg_trigger t
    where t.tgrelid = 'public.invitations'::regclass
      and t.tgname = 'invitations_provenance_guard' and not t.tgisinternal)
  and (select not prosecdef and 'search_path=public, auth' = any(proconfig)
         from pg_proc where oid = 'public.assert_invitation_provenance()'::regprocedure)
  -- review L2: no client role (and no PUBLIC entry) holds EXECUTE on it
  and not has_function_privilege('anon', 'public.assert_invitation_provenance()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.assert_invitation_provenance()', 'EXECUTE')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public.assert_invitation_provenance()'::regprocedure and a.grantee = 0),
  'K-d: invitations_provenance_guard is BEFORE INSERT OR UPDATE FOR EACH ROW, enabled; function INVOKER with pinned search_path; no anon/authenticated/PUBLIC EXECUTE (L2)'
);

select ok(
  to_regprocedure('public.register_invited_profile()') is null
  and to_regprocedure('public.get_pending_invitation(text)') is null
  and (select prosecdef and pg_get_userbyid(proowner) = 'postgres' and 'search_path=public' = any(proconfig)
         from pg_proc where oid = 'public.register_invited_profile(text)'::regprocedure)
  and (select not prosecdef from pg_proc
        where oid = 'public.create_invitation(text,text,text,text[],uuid,text)'::regprocedure)
  and (select prosecdef from pg_proc
        where oid = 'public.check_invitation_code(text,text)'::regprocedure),
  'K-e: zero-arg register_invited_profile and get_pending_invitation dropped; register_invited_profile(text) DEFINER/postgres/search_path=public; create_invitation INVOKER; check_invitation_code DEFINER'
);

select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.prosrc ~* 'insert\s+into\s+(public\.)?profiles\y'),
  array['register_invited_profile(text)'],
  'K-f1: the only public SECURITY DEFINER function inserting into profiles is register_invited_profile(text)'
);

select is(
  (select array_agg(p.oid::regprocedure::text || ':' || p.prosecdef::text order by p.oid::regprocedure::text)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?profiles\y'),
  array['demote_profile_to_user(uuid):true', 'register_invited_profile(text):true'],
  'K-f2: the full public profiles-writer list (spec 198 Q-4) is pinned'
);

select is(
  (select array_agg(has_function_privilege(r, f, 'EXECUTE') order by f, r)
     from unnest(array['anon', 'authenticated', 'service_role']) r
    cross join unnest(array['public.check_invitation_code(text,text)',
                            'public.create_invitation(text,text,text,text[],uuid,text)',
                            'public.register_invited_profile(text)']) f)
  || (select array_agg(exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) order by p.oid::regprocedure::text)
        from pg_proc p
       where p.oid in ('public.check_invitation_code(text,text)'::regprocedure,
                       'public.create_invitation(text,text,text,text[],uuid,text)'::regprocedure,
                       'public.register_invited_profile(text)'::regprocedure)),
  array[true, true, true,        -- check_invitation_code: anon, authenticated, service_role
        false, true, true,       -- create_invitation
        false, true, true,       -- register_invited_profile(text)
        false, false, false],    -- no PUBLIC entry on any of the three
  'K-g: EXECUTE matrix (anon/authenticated/service_role) and no PUBLIC entry for the three new functions'
);

select ok(
  pg_get_functiondef('public.register_invited_profile(text)'::regprocedure) ~* 'for\s+share',
  'K-h: register_invited_profile(text) reads the inviter FOR SHARE (D3 race with demote/delete)'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.invitations'::regclass)
  and not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'invitations'
                     and ('anon' = any(roles) or 'public' = any(roles))),
  'A7: RLS is on for invitations and no policy names anon or public'
);

select ok(
  not has_function_privilege('anon', 'public.assert_not_last_of_role(uuid,text)', 'EXECUTE')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public.assert_not_last_of_role(uuid,text)'::regprocedure and a.grantee = 0)
  and has_function_privilege('authenticated', 'public.assert_not_last_of_role(uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.assert_not_last_of_role(uuid,text)', 'EXECUTE'),
  'E1: assert_not_last_of_role: anon no, no PUBLIC entry, authenticated and service_role yes'
);

select ok(
  not has_function_privilege('anon', 'public.consume_invitation(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.consume_invitation(uuid,text)', 'EXECUTE')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public.consume_invitation(uuid,text)'::regprocedure and a.grantee = 0)
  and has_function_privilege('service_role', 'public.consume_invitation(uuid,text)', 'EXECUTE'),
  'E2: consume_invitation: anon no, authenticated no, no PUBLIC entry, service_role yes'
);


-- ============================================================
-- C3 - the D-4 clamp
-- ============================================================
insert into public.invitations (email, name, role, store_ids, profile_id, used, expires_at)
values
  ('c3null-198@local.test', 'C3 Null', 'user', '{}', current_setting('test.sentinel', true)::uuid, false, null),
  ('c3far-198@local.test',  'C3 Far',  'user', '{}', current_setting('test.sentinel', true)::uuid, false, '2099-01-01'::timestamptz),
  -- just past the bound: a 7-day clamp must catch it, an 8-day clamp would not
  ('c3edge-198@local.test', 'C3 Edge', 'user', '{}', current_setting('test.sentinel', true)::uuid, false, now() + interval '7 days 12 hours'),
  ('c3in-198@local.test',   'C3 In',   'user', '{}', current_setting('test.sentinel', true)::uuid, false, now() + interval '3 days');

-- COPY of the migration's clamp UPDATE - MUST stay identical (after
-- whitespace normalisation) to
-- supabase/migrations/20261110120000_invitations_hardening.sql section 4.
-- src/lib/invitationsClamp.source.test.ts (jest) pins the two copies equal.
update public.invitations
   set expires_at = now() + interval '48 hours'
 where used = false
   and (expires_at is null or expires_at > now() + interval '7 days');

select is(
  (select array_agg(expires_at = now() + interval '48 hours' order by email)
     from public.invitations where email in ('c3edge-198@local.test', 'c3far-198@local.test', 'c3null-198@local.test')),
  array[true, true, true],
  'C3: NULL, now()+7d12h and 2099-01-01 pending rows are clamped to now()+48h'
);

select is(
  (select expires_at from public.invitations where email = 'c3in-198@local.test'),
  now() + interval '3 days',
  'C3: an in-bound pending row is untouched by the clamp'
);


-- ============================================================
-- Invitation fixtures (as postgres; the provenance trigger skips postgres)
-- ============================================================
insert into public.invitations (id, email, name, role, store_ids, brand_id, username, profile_id, used, expires_at, invited_by, code_hash)
values
  -- A arms
  (current_setting('test.fx_i', true)::uuid,   'fx-i-198@local.test',   'Fx i',   'user', '{}',
   current_setting('test.brand_b', true)::uuid, null, current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.sa', true)::uuid, pg_temp.h('aaaa1980000000000000000000000001')),
  (current_setting('test.fx_ii', true)::uuid,  'fx-ii-198@local.test',  'Fx ii',  'user', array[current_setting('test.store_b1', true)],
   null, null, current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.sa', true)::uuid, pg_temp.h('aaaa1980000000000000000000000002')),
  (current_setting('test.fx_iii', true)::uuid, 'fx-iii-198@local.test', 'Fx iii', 'user', array[current_setting('test.store_b1', true)],
   current_setting('test.brand_a', true)::uuid, null, current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.sa', true)::uuid, pg_temp.h('aaaa1980000000000000000000000003')),
  (current_setting('test.fx_a5a', true)::uuid, 'fx-a5a-198@local.test', 'Fx a5a', 'user', '{}',
   current_setting('test.brand_a', true)::uuid, null, current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.master', true)::uuid, pg_temp.h('aaaa1980000000000000000000000005')),
  (current_setting('test.fx_a5b', true)::uuid, 'fx-a5b-198@local.test', 'Fx a5b', 'user',
   array[current_setting('test.store_a1', true), current_setting('test.store_a2', true)],
   null, null, current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.master', true)::uuid, pg_temp.h('aaaa1980000000000000000000000006')),
  (current_setting('test.fx_bdel', true)::uuid, 'fx-bdel-198@local.test', 'Fx bdel', 'admin', '{}',
   current_setting('test.brand_b', true)::uuid, null, current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.sa', true)::uuid, pg_temp.h('aaaa1980000000000000000000000007')),
  -- legacy brand-less, store-less row: no inviter, no code
  (current_setting('test.fx_leg', true)::uuid, 'fx-leg-198@local.test', 'Fx legacy', 'user', '{}',
   null, null, current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   null, null);

insert into public.invitations (email, name, role, store_ids, brand_id, username, profile_id, used, expires_at, invited_by, code_hash)
values
  -- B2-staff: brand NULL, store A1 (brand resolved from the store), inviter admin 1111
  ('b2staff-198@local.test', 'peter benjamin parker', 'user', array[current_setting('test.store_a1', true)],
   null, 'b2staff198', current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.admin', true)::uuid, pg_temp.h(current_setting('test.c_staff', true))),
  -- B3 baseline (claimable; r31 attacks it with bad codes)
  ('b31-198@local.test', 'B31', 'user', '{}', current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.admin', true)::uuid, pg_temp.h(current_setting('test.c31', true))),
  -- B3-4: another claimable invitation whose code r31 tries
  ('b34-198@local.test', 'B34', 'user', '{}', current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.admin', true)::uuid, pg_temp.h(current_setting('test.c34', true))),
  -- B3-5: claimable for b35, presented by r35 (auth email r35-198)
  ('b35-198@local.test', 'B35', 'user', '{}', current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.admin', true)::uuid, pg_temp.h(current_setting('test.c35', true))),
  -- B3-6: used
  ('b36-198@local.test', 'B36', 'user', '{}', current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, true, now() + interval '1 day',
   current_setting('test.admin', true)::uuid, pg_temp.h(current_setting('test.c36', true))),
  -- B3-7: expired
  ('b37-198@local.test', 'B37', 'user', '{}', current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() - interval '1 hour',
   current_setting('test.admin', true)::uuid, pg_temp.h(current_setting('test.c37', true))),
  -- B3-8: NULL expires_at
  ('b38-198@local.test', 'B38', 'user', '{}', current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, null,
   current_setting('test.admin', true)::uuid, pg_temp.h(current_setting('test.c38', true))),
  -- B3-9: legacy row, no code_hash
  ('b39-198@local.test', 'B39', 'user', '{}', current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.admin', true)::uuid, null),
  -- B5: same email pending in brand A (admin 1111) and brand B (SA)
  ('b5-198@local.test', 'B5 Brand A', 'user', '{}', current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.admin', true)::uuid, pg_temp.h(current_setting('test.c5a', true))),
  ('b5-198@local.test', 'B5 Brand B', 'user', '{}', current_setting('test.brand_b', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.sa', true)::uuid, pg_temp.h(current_setting('test.c5b', true))),
  -- D3-a: inviter uuid with no profile
  ('d3a-198@local.test', 'D3a', 'user', '{}', current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.ghost', true)::uuid, pg_temp.h(current_setting('test.c3a', true))),
  -- D3-c: admin 1111 inviter, resolved brand B
  ('d3c1-198@local.test', 'D3c1', 'user', '{}', current_setting('test.brand_b', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.admin', true)::uuid, pg_temp.h(current_setting('test.c3c1', true))),
  -- D3-c: master 3333 inviter, resolved brand B
  ('d3c2-198@local.test', 'D3c2', 'user', '{}', current_setting('test.brand_b', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.master', true)::uuid, pg_temp.h(current_setting('test.c3c2', true))),
  -- B3-2b / R3b: a row whose code_hash is sha256('') (any privileged in-scope
  -- caller can plant one: the INSERT policy checks only the 64-hex format).
  -- Otherwise the claimable baseline, so only the blank-code guard refuses it.
  ('bblank-198@local.test', 'BBlank', 'user', '{}', current_setting('test.brand_a', true)::uuid, null,
   current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
   current_setting('test.admin', true)::uuid, pg_temp.h(''));


-- ============================================================
-- B6-agree - pre-check vs claim, before any claim consumes a fixture
-- ============================================================
select is(
  (select array_agg((select count(*)::int from public.check_invitation_code(e, c)) order by ord)
     from (values
       (1,  'B2STAFF-198@LOCAL.TEST', current_setting('test.c_staff', true)),  -- B2-staff: claim succeeds
       (2,  'b31-198@local.test',     null),                                   -- B3-1
       (3,  'b31-198@local.test',     ''),                                     -- B3-2
       (4,  'b31-198@local.test',     current_setting('test.c_wrong', true)),  -- B3-3
       (5,  'b31-198@local.test',     current_setting('test.c34', true)),      -- B3-4
       (6,  'r35-198@local.test',     current_setting('test.c35', true)),      -- B3-5
       (7,  'b36-198@local.test',     current_setting('test.c36', true)),      -- B3-6 used
       (8,  'b37-198@local.test',     current_setting('test.c37', true)),      -- B3-7 expired
       (9,  'b38-198@local.test',     current_setting('test.c38', true)),      -- B3-8 NULL expiry
       (10, 'b39-198@local.test',     current_setting('test.c39', true)),      -- B3-9 legacy no code
       (11, 'd3a-198@local.test',     current_setting('test.c3a', true)),      -- D3-a no inviter profile
       (12, 'd3c1-198@local.test',    current_setting('test.c3c1', true)),     -- D3-c admin, other brand
       (13, 'd3c2-198@local.test',    current_setting('test.c3c2', true)),     -- D3-c master, other brand
       (14, 'b5-198@local.test',      current_setting('test.c5b', true)),      -- B5 brand-B code
       (15, 'b5-198@local.test',      current_setting('test.c5a', true)),      -- B5 brand-A code
       (16, ' B31-198@local.test ',   upper(current_setting('test.c31', true))), -- baseline, case/space-normalised
       (17, 'b34-198@local.test',     current_setting('test.c34', true)),      -- B3-4's code, its own email
       (18, 'bblank-198@local.test',  ''),                                     -- B3-2b: blank code vs a sha256('') row
       (19, 'bblank-198@local.test',  '   '),                                  -- B3-2b: whitespace-only code
       (20, 'bblank-198@local.test',  null)                                    -- B3-2b: NULL code
     ) v(ord, e, c)),
  array[1, 0,0,0,0,0,0,0,0,0, 0,0,0, 1,1, 1,1, 0,0,0],
  'B6-agree: check_invitation_code returns 1 row exactly where the claim succeeds and 0 for every B3/D3 refusal (incl. a blank code against a sha256('''') row)'
);


-- ============================================================
-- A2..A6 - SELECT / DELETE scope
-- ============================================================

-- A2: admin 1111 (brand A) and the three out-of-scope rows
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.admin', true), 'admin'), true);
set local role authenticated;

select is(
  (select count(*)::int from public.invitations
    where id in (current_setting('test.fx_i', true)::uuid, current_setting('test.fx_ii', true)::uuid,
                 current_setting('test.fx_iii', true)::uuid)),
  0,
  'A2: brand-A admin SELECTs 0 of (i) brand B, (ii) NULL brand + brand-B store, (iii) brand A + brand-B store'
);

with d as (
  delete from public.invitations
   where id in (current_setting('test.fx_i', true)::uuid, current_setting('test.fx_ii', true)::uuid,
                current_setting('test.fx_iii', true)::uuid)
  returning 1
)
select is((select count(*)::int from d), 0, 'A2: brand-A admin DELETE of (i)/(ii)/(iii) affects 0 rows');

reset role;
select is(
  (select count(*)::int from public.invitations
    where id in (current_setting('test.fx_i', true)::uuid, current_setting('test.fx_ii', true)::uuid,
                 current_setting('test.fx_iii', true)::uuid)),
  3,
  'A2: (as postgres) all three out-of-scope rows still exist'
);

-- A3: manager 2222 (profile role user) with a stale admin claim
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.manager', true), 'admin'), true);
set local role authenticated;

select is((select count(*)::int from public.invitations), 0,
  'A3: stale admin claim on a role=user profile SELECTs 0 invitations of any brand');

with d as (delete from public.invitations returning 1)
select is((select count(*)::int from d), 0,
  'A3: stale admin claim DELETE affects 0 rows');

-- A4: super_admin
reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.sa', true), 'super_admin'), true);
set local role authenticated;

select is(
  (select count(*)::int from public.invitations
    where id in (current_setting('test.fx_i', true)::uuid, current_setting('test.fx_ii', true)::uuid,
                 current_setting('test.fx_iii', true)::uuid, current_setting('test.fx_a5a', true)::uuid,
                 current_setting('test.fx_a5b', true)::uuid, current_setting('test.fx_bdel', true)::uuid,
                 current_setting('test.fx_leg', true)::uuid)),
  7,
  'A4: super_admin SELECTs every A fixture (brands A and B, brand-less and legacy included)'
);

with d as (delete from public.invitations where id = current_setting('test.fx_bdel', true)::uuid returning 1)
select is((select count(*)::int from d), 1, 'A4: super_admin DELETE of a brand-B row affects 1 row');

-- A5: admin 1111 and brand-A rows
reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.admin', true), 'admin'), true);
set local role authenticated;

select is(
  (select count(*)::int from public.invitations
    where id in (current_setting('test.fx_a5a', true)::uuid, current_setting('test.fx_a5b', true)::uuid)),
  2,
  'A5: brand-A admin SELECTs brand-A rows (brand A; NULL brand with only brand-A stores)'
);

with d as (
  delete from public.invitations
   where id in (current_setting('test.fx_a5a', true)::uuid, current_setting('test.fx_a5b', true)::uuid)
  returning 1
)
select is((select count(*)::int from d), 2, 'A5: brand-A admin DELETEs both brand-A rows');

-- A6 (D-7): brand-less, store-less row inserted directly by 1111
select lives_ok(
  $q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id, code_hash)
     values ('a6-198@local.test', 'A6', 'user', '{}', null, '00000000-0000-0000-0000-000000000000',
             encode(sha256(convert_to('aaaa19800000000000000000000000a6', 'UTF8')), 'hex'))$q$,
  'A6: admin 1111 inserts a brand-less, store-less invitation directly'
);

select is((select count(*)::int from public.invitations where email = 'a6-198@local.test'), 1,
  'A6: the inviter sees its brand-less, store-less row');

select is((select count(*)::int from public.invitations where id = current_setting('test.fx_leg', true)::uuid), 0,
  'A6: a legacy brand-less row with NULL invited_by is invisible to a brand admin');

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.sa', true), 'super_admin'), true);
set local role authenticated;

select is(
  (select count(*)::int from public.invitations
    where email = 'a6-198@local.test' or id = current_setting('test.fx_leg', true)::uuid),
  2,
  'A6: super_admin sees the brand-less row and the legacy NULL-inviter row'
);

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.a2adm', true), 'admin'), true);
set local role authenticated;

select is((select count(*)::int from public.invitations where email = 'a6-198@local.test'), 0,
  'A6: another brand-A admin does not see the brand-less row');

with d as (delete from public.invitations where email = 'a6-198@local.test' returning 1)
select is((select count(*)::int from d), 0, 'A6: another brand-A admin deletes 0 rows');

select is((select count(*)::int from public.invitations where id = current_setting('test.fx_leg', true)::uuid), 0,
  'A6: the legacy NULL-inviter row is invisible to another brand-A admin too');

reset role;


-- ============================================================
-- B1 - create_invitation
-- ============================================================
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.admin', true), 'admin'), true);
set local role authenticated;

select set_config('test.b1_res',
  public.create_invitation('b1-198@local.test', 'B One', 'user',
                           array[current_setting('test.store_a1', true)], null, 'b1user198')::text,
  true);

select ok(
  (current_setting('test.b1_res', true)::jsonb ->> 'code') ~ '^[0-9a-f]{32}$'
  and (current_setting('test.b1_res', true)::jsonb ? 'invitation_id')
  and (current_setting('test.b1_res', true)::jsonb ? 'expires_at'),
  'B1: create_invitation returns {invitation_id, code (32 lowercase hex), expires_at}'
);

reset role;

select ok(
  (select i.code_hash = pg_temp.h(current_setting('test.b1_res', true)::jsonb ->> 'code')
          and i.invited_by = current_setting('test.admin', true)::uuid
          and i.expires_at = now() + interval '48 hours'
          and i.brand_id = current_setting('test.brand_a', true)::uuid
          and i.id = (current_setting('test.b1_res', true)::jsonb ->> 'invitation_id')::uuid
     from public.invitations i where i.email = 'b1-198@local.test'),
  'B1: stored code_hash = sha256(code), invited_by = caller, expires_at = now()+48h, brand resolved from the store'
);

select ok(
  not exists (select 1
                from public.invitations i, jsonb_each_text(to_jsonb(i)) kv
               where i.email = 'b1-198@local.test'
                 and kv.value ilike '%' || (current_setting('test.b1_res', true)::jsonb ->> 'code') || '%'),
  'B1: no column of the stored row contains the plaintext code'
);

select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r_b1', true), null), true);
set local role authenticated;

select is(
  public.register_invited_profile(current_setting('test.b1_res', true)::jsonb ->> 'code'),
  current_setting('test.r_b1', true)::uuid,
  'B1: the returned code claims the invitation'
);

reset role;


-- ============================================================
-- B2 - successful claims
-- ============================================================

-- B2-staff / D4: auth email upper case, registrant JWT has no role; inviter
-- 1111 is a profile admin of brand A.
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r_staff', true), null), true);
set local role authenticated;

select is(
  public.register_invited_profile(current_setting('test.c_staff', true)),
  current_setting('test.r_staff', true)::uuid,
  'B2-staff / D4: staff invitation claimed with the right code (upper-case auth email; inviter re-checked from profiles)'
);

reset role;

select is(
  (select concat_ws('|', role, brand_id::text, name, username, status, color, initials)
     from public.profiles where id = current_setting('test.r_staff', true)::uuid),
  concat_ws('|', 'user', current_setting('test.brand_a', true), 'peter benjamin parker', 'b2staff198',
            'active', '#378ADD', 'PB'),
  'B2-staff: profile = (user, brand A resolved from store A1, name, username, active, #378ADD, PB)'
);

select is(
  (select array_agg(store_id::text) from public.user_stores
    where user_id = current_setting('test.r_staff', true)::uuid),
  array[current_setting('test.store_a1', true)],
  'B2-staff: user_stores = {A1}'
);

select ok(
  (select used and profile_id = current_setting('test.r_staff', true)::uuid
     from public.invitations where email = 'b2staff-198@local.test'),
  'B2-staff: invitation used = true with profile_id = registrant'
);

select is(
  (select raw_app_meta_data ->> 'role' from auth.users where id = current_setting('test.r_staff', true)::uuid),
  'user',
  'B2-staff: raw_app_meta_data.role synced to user'
);

-- B2-admin: master 3333 creates an admin invitation for brand A
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.master', true), 'master'), true);
set local role authenticated;
select set_config('test.b2a_res',
  public.create_invitation('b2admin-198@local.test', 'Admin Two', 'admin', '{}',
                           current_setting('test.brand_a', true)::uuid, null)::text,
  true);

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r_admin', true), null), true);
set local role authenticated;

select is(
  public.register_invited_profile(current_setting('test.b2a_res', true)::jsonb ->> 'code'),
  current_setting('test.r_admin', true)::uuid,
  'B2-admin: master-created admin invitation is claimed'
);

reset role;

select ok(
  (select p.role = 'admin' and p.brand_id = current_setting('test.brand_a', true)::uuid
          and u.raw_app_meta_data ->> 'role' = 'admin'
     from public.profiles p join auth.users u on u.id = p.id
    where p.id = current_setting('test.r_admin', true)::uuid),
  'B2-admin: profile admin, brand A, app_metadata.role admin'
);

-- B2-zero (a): super_admin zero-store staff invitation stays brand-less
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.sa', true), 'super_admin'), true);
set local role authenticated;
select set_config('test.za_res',
  public.create_invitation('b2za-198@local.test', 'Zero A', 'user', '{}', null, null)::text, true);

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r_za', true), null), true);
set local role authenticated;

select is(
  public.register_invited_profile(current_setting('test.za_res', true)::jsonb ->> 'code'),
  current_setting('test.r_za', true)::uuid,
  'B2-zero (a): super_admin zero-store staff invitation is claimed'
);

reset role;

select ok(
  (select brand_id is null and role = 'user' from public.profiles where id = current_setting('test.r_za', true)::uuid)
  and (select brand_id is null from public.invitations where email = 'b2za-198@local.test'),
  'B2-zero (a): stored invitation brand NULL and the profile is a brand-less user'
);

-- B2-zero (b): admin 1111 zero-store staff invitation is stamped brand A (AD-4)
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.admin', true), 'admin'), true);
set local role authenticated;
select set_config('test.zb_res',
  public.create_invitation('b2zb-198@local.test', 'Zero B', 'user', '{}', null, null)::text, true);

reset role;

select is(
  (select brand_id from public.invitations where email = 'b2zb-198@local.test'),
  current_setting('test.brand_a', true)::uuid,
  'B2-zero (b): AD-4 - an admin''s zero-store staff invitation is stored with the admin''s brand'
);

select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r_zb', true), null), true);
set local role authenticated;

select is(
  public.register_invited_profile(current_setting('test.zb_res', true)::jsonb ->> 'code'),
  current_setting('test.r_zb', true)::uuid,
  'B2-zero (b): the stamped invitation is claimable (passes D3)'
);

reset role;


-- ============================================================
-- B3 - refusals, all P0001 'no pending invitation'
-- ============================================================
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r31', true), null), true);
set local role authenticated;

select throws_ok('select public.register_invited_profile(null)',
  'P0001', 'no pending invitation', 'B3-1: NULL code');
select throws_ok($q$select public.register_invited_profile('')$q$,
  'P0001', 'no pending invitation', 'B3-2: empty code');
select throws_ok(format('select public.register_invited_profile(%L)', current_setting('test.c_wrong', true)),
  'P0001', 'no pending invitation', 'B3-3: wrong valid-format code');
select throws_ok(format('select public.register_invited_profile(%L)', current_setting('test.c34', true)),
  'P0001', 'no pending invitation', 'B3-4: another invitation''s code');

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r35', true), null), true);
set local role authenticated;
select throws_ok(format('select public.register_invited_profile(%L)', current_setting('test.c35', true)),
  'P0001', 'no pending invitation', 'B3-5: right code, different auth email');

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r36', true), null), true);
set local role authenticated;
select throws_ok(format('select public.register_invited_profile(%L)', current_setting('test.c36', true)),
  'P0001', 'no pending invitation', 'B3-6: used invitation');

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r37', true), null), true);
set local role authenticated;
select throws_ok(format('select public.register_invited_profile(%L)', current_setting('test.c37', true)),
  'P0001', 'no pending invitation', 'B3-7: expired invitation');

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r38', true), null), true);
set local role authenticated;
select throws_ok(format('select public.register_invited_profile(%L)', current_setting('test.c38', true)),
  'P0001', 'no pending invitation', 'B3-8: NULL expires_at counts as expired');

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r39', true), null), true);
set local role authenticated;
select throws_ok(format('select public.register_invited_profile(%L)', current_setting('test.c39', true)),
  'P0001', 'no pending invitation', 'B3-9: legacy invitation with no code_hash');

-- B3-2b: the registrant's email matches a row whose code_hash is sha256(''),
-- so only R3b (the blank-code guard) stands between '' and a claim.
reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r_blank', true), null), true);
set local role authenticated;
select throws_ok($q$select public.register_invited_profile('')$q$,
  'P0001', 'no pending invitation', 'B3-2b: blank code against an invitation whose code_hash is sha256('''')');

reset role;

select ok(
  (select count(*) = 0 from public.profiles
    where id = any(array[current_setting('test.r31', true), current_setting('test.r35', true),
                         current_setting('test.r36', true), current_setting('test.r37', true),
                         current_setting('test.r38', true), current_setting('test.r39', true),
                         current_setting('test.r_blank', true)]::uuid[]))
  and (select count(*) = 0 from public.user_stores
        where user_id = any(array[current_setting('test.r31', true), current_setting('test.r35', true),
                                  current_setting('test.r36', true), current_setting('test.r37', true),
                                  current_setting('test.r38', true), current_setting('test.r39', true),
                                  current_setting('test.r_blank', true)]::uuid[]))
  and (select bool_and(not (raw_app_meta_data ? 'role')) from auth.users
        where id = any(array[current_setting('test.r31', true), current_setting('test.r35', true),
                             current_setting('test.r36', true), current_setting('test.r37', true),
                             current_setting('test.r38', true), current_setting('test.r39', true),
                             current_setting('test.r_blank', true)]::uuid[]))
  and (select count(*) = 8
              and bool_and(profile_id = current_setting('test.sentinel', true)::uuid)
              and bool_and(used = (email = 'b36-198@local.test'))
         from public.invitations
        where email in ('b31-198@local.test', 'b34-198@local.test', 'b35-198@local.test', 'b36-198@local.test',
                        'b37-198@local.test', 'b38-198@local.test', 'b39-198@local.test',
                        'bblank-198@local.test')),
  'B3-side: refused registrants have no profile, no user_stores, no app_metadata role; their invitations are unchanged'
);


-- ============================================================
-- B5 - select by code, not by email
-- ============================================================
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r5', true), null), true);
set local role authenticated;

select is(
  public.register_invited_profile(current_setting('test.c5b', true)),
  current_setting('test.r5', true)::uuid,
  'B5: with two pending invitations for one email, the brand-B code claims (no multiple-pending refusal)'
);

reset role;

select is(
  (select brand_id from public.profiles where id = current_setting('test.r5', true)::uuid),
  current_setting('test.brand_b', true)::uuid,
  'B5: the profile takes the brand of the invitation whose code was used (brand B)'
);

select ok(
  (select not used from public.invitations where email = 'b5-198@local.test' and name = 'B5 Brand A')
  and (select used from public.invitations where email = 'b5-198@local.test' and name = 'B5 Brand B'),
  'B5: the brand-A invitation for the same email is still pending; only the brand-B one is used'
);


-- ============================================================
-- B8 - re-invite replaces
-- ============================================================
-- The two calls differ in role, stores, username, name and email case (a
-- brand-A admin's scope is brand A, so the brand cannot differ here).
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.admin', true), 'admin'), true);
set local role authenticated;
select set_config('test.b8_1', public.create_invitation('b8-198@local.test', 'B8 One', 'user',
  array[current_setting('test.store_a1', true)], null, 'b8one198')::text, true);
reset role;

-- As postgres (the provenance trigger skips it): age the first row's expiry so
-- a fresh expires_at on the replacement is observable (now() is constant in
-- the transaction).
update public.invitations set expires_at = now() + interval '1 hour' where email = 'b8-198@local.test';

set local role authenticated;
select set_config('test.b8_2', public.create_invitation(' B8-198@Local.Test ', 'B8 Two', 'admin', '{}',
  current_setting('test.brand_a', true)::uuid, 'b8two198')::text, true);
reset role;

select is(
  (select count(*)::int from public.invitations where email = 'b8-198@local.test' and used = false),
  1,
  'B8-srv: two create_invitation calls for one email leave exactly one pending row'
);

select ok(
  (select i.id = (current_setting('test.b8_2', true)::jsonb ->> 'invitation_id')::uuid
          and i.role = 'admin'
          and i.store_ids = '{}'::text[]
          and i.brand_id = current_setting('test.brand_a', true)::uuid
          and i.username = 'b8two198'
          and i.name = 'B8 Two'
          and i.expires_at = now() + interval '48 hours'
          and i.code_hash = pg_temp.h(current_setting('test.b8_2', true)::jsonb ->> 'code')
     from public.invitations i where i.email = 'b8-198@local.test' and not i.used)
  and not exists (select 1 from public.invitations
                   where id = (current_setting('test.b8_1', true)::jsonb ->> 'invitation_id')::uuid),
  'B8-srv: the surviving row is the second call''s (its id, role, stores, brand, username, name, code hash and a fresh expires_at); the first row is gone'
);

select is(
  array[(select count(*)::int from public.check_invitation_code('b8-198@local.test', current_setting('test.b8_1', true)::jsonb ->> 'code')),
        (select count(*)::int from public.check_invitation_code('b8-198@local.test', current_setting('test.b8_2', true)::jsonb ->> 'code'))],
  array[0, 1],
  'B8-srv: the pre-check rejects the first code and accepts the second'
);

select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r8', true), null), true);
set local role authenticated;

select throws_ok(
  format('select public.register_invited_profile(%L)', current_setting('test.b8_1', true)::jsonb ->> 'code'),
  'P0001', 'no pending invitation',
  'B8-srv: the replaced (first) code no longer claims'
);

select is(
  public.register_invited_profile(current_setting('test.b8_2', true)::jsonb ->> 'code'),
  current_setting('test.r8', true)::uuid,
  'B8-srv: the new code claims'
);

reset role;

-- B8-scope: a brand-B pending row for the same email survives 1111's re-invite
insert into public.invitations (email, name, role, store_ids, brand_id, profile_id, used, expires_at, invited_by, code_hash)
values ('b8s-198@local.test', 'B8s Brand B', 'user', '{}', current_setting('test.brand_b', true)::uuid,
        current_setting('test.sentinel', true)::uuid, false, now() + interval '1 day',
        current_setting('test.sa', true)::uuid, pg_temp.h('aaaa19800000000000000000000008b5'));

select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.admin', true), 'admin'), true);
set local role authenticated;
select set_config('test.b8s', public.create_invitation('b8s-198@local.test', 'B8s', 'user',
  array[current_setting('test.store_a1', true)], null, null)::text, true);
reset role;

select is(
  (select array_agg(brand_id::text order by brand_id::text) from public.invitations
    where email = 'b8s-198@local.test' and used = false),
  (select array_agg(b order by b) from unnest(array[current_setting('test.brand_a', true),
                                                     current_setting('test.brand_b', true)]) b),
  'B8-scope: re-invite as brand-A admin leaves the out-of-scope brand-B pending row in place'
);


-- ============================================================
-- CI - create_invitation refusals
-- ============================================================
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.manager', true), 'user'), true);
set local role authenticated;
select throws_ok(
  $q$select public.create_invitation('ci1-198@local.test', 'CI1', 'user', '{}', null, null)$q$,
  '42501', 'forbidden',
  'CI-1: a role=user caller -> 42501 forbidden'
);

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.manager', true), 'admin'), true);
set local role authenticated;
select throws_ok(
  $q$select public.create_invitation('ci2-198@local.test', 'CI2', 'user', '{}', null, null)$q$,
  '42501', 'forbidden',
  'CI-2: a stale admin claim on a role=user profile -> 42501 forbidden'
);

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.admin', true), 'admin'), true);
set local role authenticated;
select throws_ok(
  format($q$select public.create_invitation('ci3-198@local.test', 'CI3', 'user', array[%L], null, null)$q$,
         current_setting('test.store_b1', true)),
  '42501', null,
  'CI-3: brand-A admin inviting with a brand-B store -> 42501 (RLS; the function is INVOKER)'
);


-- ============================================================
-- C1 / C2 - expiry bound (still admin 1111)
-- ============================================================
select throws_ok(
  $q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id, code_hash, expires_at)
     values ('c1n-198@local.test', 'C1n', 'user', '{}', '2a000000-0000-0000-0000-000000000001',
             '00000000-0000-0000-0000-000000000000',
             encode(sha256(convert_to('aaaa19800000000000000000000000c1', 'UTF8')), 'hex'), null)$q$,
  '42501', null,
  'C1: direct INSERT with expires_at NULL -> 42501'
);

select throws_ok(
  $q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id, code_hash, expires_at)
     values ('c1f-198@local.test', 'C1f', 'user', '{}', '2a000000-0000-0000-0000-000000000001',
             '00000000-0000-0000-0000-000000000000',
             encode(sha256(convert_to('aaaa19800000000000000000000000c2', 'UTF8')), 'hex'), now() + interval '8 days')$q$,
  '42501', null,
  'C1: direct INSERT with expires_at now()+8 days -> 42501'
);

select lives_ok(
  $q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id, code_hash)
     values ('c1o-198@local.test', 'C1o', 'user', '{}', '2a000000-0000-0000-0000-000000000001',
             '00000000-0000-0000-0000-000000000000',
             encode(sha256(convert_to('aaaa19800000000000000000000000c3', 'UTF8')), 'hex'))$q$,
  'C1: direct INSERT with expires_at omitted is admitted'
);

select lives_ok(
  $q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id, code_hash, expires_at)
     values ('c1s-198@local.test', 'C1s', 'user', '{}', '2a000000-0000-0000-0000-000000000001',
             '00000000-0000-0000-0000-000000000000',
             encode(sha256(convert_to('aaaa19800000000000000000000000c4', 'UTF8')), 'hex'), now() + interval '6 days')$q$,
  'C1: direct INSERT with expires_at now()+6 days is admitted'
);

reset role;
select is(
  (select expires_at from public.invitations where email = 'c1o-198@local.test'),
  now() + interval '48 hours',
  'C1: an omitted expires_at is stored as the now()+48h default'
);

-- C2 runs as the super_admin: since review H1 only a super_admin's UPDATE
-- reaches WITH CHECK (a brand admin's matches 0 rows, pinned below).
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.sa', true), 'super_admin'), true);
set local role authenticated;

select throws_ok(
  $q$update public.invitations set expires_at = null where email = 'c1o-198@local.test'$q$,
  '42501', null,
  'C2: super_admin UPDATE expires_at to NULL -> 42501'
);

select throws_ok(
  $q$update public.invitations set expires_at = now() + interval '8 days' where email = 'c1o-198@local.test'$q$,
  '42501', null,
  'C2: super_admin UPDATE expires_at to now()+8 days -> 42501'
);

with u as (
  update public.invitations set expires_at = now() + interval '6 days'
   where email = 'c1o-198@local.test' returning 1
)
select is((select count(*)::int from u), 1, 'C2: super_admin UPDATE expires_at within the bound affects 1 row');

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.admin', true), 'admin'), true);
set local role authenticated;

with u as (
  update public.invitations set expires_at = now() + interval '5 days'
   where email = 'c1o-198@local.test' returning 1
)
select is((select count(*)::int from u), 0,
  'C2 / H1: an in-scope brand admin (1111, the row''s own inviter) UPDATE of an unused invitation affects 0 rows (UPDATE is super_admin-only)');

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.manager', true), 'admin'), true);
set local role authenticated;

with u as (
  update public.invitations set expires_at = now() + interval '5 days'
   where email = 'c1o-198@local.test' returning 1
)
select is((select count(*)::int from u), 0, 'C2: stale admin claim UPDATE affects 0 rows');


-- ============================================================
-- D1 / D2 - provenance
-- ============================================================
reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.admin', true), 'admin'), true);
set local role authenticated;

select lives_ok(
  format($q$insert into public.invitations (email, name, role, store_ids, brand_id, profile_id, code_hash, invited_by)
            values ('d1-198@local.test', 'D1', 'user', '{}', '2a000000-0000-0000-0000-000000000001',
                    '00000000-0000-0000-0000-000000000000',
                    encode(sha256(convert_to('aaaa19800000000000000000000000d1', 'UTF8')), 'hex'), %L::uuid)$q$,
         current_setting('test.sa', true)),
  'D1: INSERT carrying invited_by = another uuid is admitted (the trigger overwrites it)'
);

-- D2 runs as the super_admin (review H1: only a super_admin's UPDATE matches).
reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.sa', true), 'super_admin'), true);
set local role authenticated;

with u as (
  update public.invitations
     set invited_by = current_setting('test.sa', true)::uuid,
         code_hash  = encode(sha256(convert_to('aaaa19800000000000000000000000d2', 'UTF8')), 'hex')
   where email = 'd1-198@local.test'
  returning 1
)
select is((select count(*)::int from u), 1, 'D2: super_admin UPDATE setting invited_by and code_hash affects 1 row');

reset role;

select is(
  (select invited_by from public.invitations where email = 'd1-198@local.test'),
  current_setting('test.admin', true)::uuid,
  'D1: stored invited_by is the caller (1111), not the payload uuid'
);

select ok(
  (select invited_by = current_setting('test.admin', true)::uuid
          and code_hash = pg_temp.h('aaaa19800000000000000000000000d1')
     from public.invitations where email = 'd1-198@local.test'),
  'D2: invited_by and code_hash are unchanged by the client UPDATE'
);


-- ============================================================
-- D3 - inviter re-check
-- ============================================================
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r3a', true), null), true);
set local role authenticated;
select throws_ok(format('select public.register_invited_profile(%L)', current_setting('test.c3a', true)),
  'P0001', 'no pending invitation', 'D3-a: the inviter has no profile');

-- D3-b: 191-M1 replay
reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.demotee', true), 'admin'), true);
set local role authenticated;
select set_config('test.d3b', public.create_invitation('d3b-198@local.test', 'D3b', 'admin', '{}',
  current_setting('test.brand_a', true)::uuid, null)::text, true);

reset role;
select is(
  (select count(*)::int from public.check_invitation_code('d3b-198@local.test', current_setting('test.d3b', true)::jsonb ->> 'code')),
  1,
  'D3-b: before the demotion the pre-check accepts the planted admin invitation'
);

select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.sa', true), 'super_admin'), true);
set local role authenticated;
select lives_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.demotee', true)),
  'D3-b: the super_admin demotes the inviter through demote_profile_to_user'
);

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r3b', true), null), true);
set local role authenticated;
select throws_ok(
  format('select public.register_invited_profile(%L)', current_setting('test.d3b', true)::jsonb ->> 'code'),
  'P0001', 'no pending invitation',
  'D3-b: after the demotion the right code no longer claims (191-M1 closed)'
);

reset role;
select is(
  (select count(*)::int from public.check_invitation_code('d3b-198@local.test', current_setting('test.d3b', true)::jsonb ->> 'code')),
  0,
  'D3-b: after the demotion the pre-check returns 0 rows'
);

-- D3-c: inviter privileged but in another brand than the resolved brand
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r3c1', true), null), true);
set local role authenticated;
select throws_ok(format('select public.register_invited_profile(%L)', current_setting('test.c3c1', true)),
  'P0001', 'no pending invitation', 'D3-c: admin inviter whose brand differs from the resolved brand');

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r3c2', true), null), true);
set local role authenticated;
select throws_ok(format('select public.register_invited_profile(%L)', current_setting('test.c3c2', true)),
  'P0001', 'no pending invitation', 'D3-c: master inviter whose brand differs from the resolved brand');


-- ============================================================
-- H1 (review, owner 2026-11-10) - a consumed invitation cannot be revived
-- ============================================================
-- The UPDATE policy is super_admin-only (auth_is_super_admin()) and admits
-- only used = false rows in USING and WITH CHECK. The DEFINER claim (as
-- postgres) stays the only writer of used = true.
-- Target: the B1 invitation (b1-198, inviter 1111, brand A), consumed by r_b1.

-- H1-a: the in-scope admin (its own inviter) tries the revival.
-- Layered: both the super_admin leaf and used = false refuse this; C2's 1111
-- arm pins the super_admin leaf alone, H1-b pins used = false alone.
reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.admin', true), 'admin'), true);
set local role authenticated;

with u as (
  update public.invitations
     set used = false,
         email = 'h1-burner-198@local.test',
         profile_id = '00000000-0000-0000-0000-000000000000',
         expires_at = now() + interval '6 days'
   where email = 'b1-198@local.test'
  returning 1
)
select is((select count(*)::int from u), 0,
  'H1-a: an in-scope brand admin cannot revive a consumed invitation (UPDATE affects 0 rows)');

reset role;
select ok(
  (select used and email = 'b1-198@local.test' and profile_id = current_setting('test.r_b1', true)::uuid
     from public.invitations where id = (current_setting('test.b1_res', true)::jsonb ->> 'invitation_id')::uuid),
  'H1-a: (as postgres) the consumed invitation is unchanged: used, same email, same profile_id'
);

-- H1-b: not even the super_admin can target a used row, or set used = true.
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.sa', true), 'super_admin'), true);
set local role authenticated;

with u as (
  update public.invitations
     set used = false,
         email = 'h1-burner-198@local.test',
         profile_id = '00000000-0000-0000-0000-000000000000',
         expires_at = now() + interval '6 days'
   where email = 'b1-198@local.test'
  returning 1
)
select is((select count(*)::int from u), 0,
  'H1-b: the super_admin cannot revive a consumed invitation either (USING used = false; 0 rows)');

select throws_ok(
  $q$update public.invitations set used = true where email = 'c1s-198@local.test'$q$,
  '42501', null,
  'H1-b: the super_admin cannot set used = true on an unused invitation from a client (WITH CHECK used = false -> 42501)'
);

-- H1-c: the consumed code still refuses at the claim and at the pre-check.
reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r_h1burn', true), null), true);
set local role authenticated;
select throws_ok(
  format('select public.register_invited_profile(%L)', current_setting('test.b1_res', true)::jsonb ->> 'code'),
  'P0001', 'no pending invitation',
  'H1-c: a burner account presenting the consumed B1 code is refused'
);

reset role;
select is(
  array[(select count(*)::int from public.check_invitation_code('h1-burner-198@local.test',
                                                                 current_setting('test.b1_res', true)::jsonb ->> 'code')),
        (select count(*)::int from public.check_invitation_code('b1-198@local.test',
                                                                 current_setting('test.b1_res', true)::jsonb ->> 'code'))],
  array[0, 0],
  'H1-c: the pre-check returns 0 rows for the consumed code (burner email and original email)'
);

-- H1-d: the auditor's probe C, end to end. Master 3333 invites X as a
-- brand-A admin; X claims; X (still admin) tries to revive and re-point the
-- row to a burner; the super_admin demotes X; the burner claims X's code.
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.master', true), 'master'), true);
set local role authenticated;
select set_config('test.h1x', public.create_invitation('h1x-198@local.test', 'H1 X', 'admin', '{}',
  current_setting('test.brand_a', true)::uuid, null)::text, true);

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r_x', true), null), true);
set local role authenticated;
select is(
  public.register_invited_profile(current_setting('test.h1x', true)::jsonb ->> 'code'),
  current_setting('test.r_x', true)::uuid,
  'H1-d: X claims the master''s admin invitation (now a brand-A admin)'
);

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r_x', true), 'admin'), true);
set local role authenticated;
with u as (
  update public.invitations
     set used = false,
         email = 'h1x-burner-198@local.test',
         profile_id = '00000000-0000-0000-0000-000000000000',
         expires_at = now() + interval '6 days'
   where id = (current_setting('test.h1x', true)::jsonb ->> 'invitation_id')::uuid
  returning 1
)
select is((select count(*)::int from u), 0,
  'H1-d: X, still an admin, cannot revive and re-point its own consumed invitation (0 rows)');

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.sa', true), 'super_admin'), true);
set local role authenticated;
select lives_ok(
  format('select public.demote_profile_to_user(%L::uuid)', current_setting('test.r_x', true)),
  'H1-d: the super_admin demotes X'
);

reset role;
select set_config('request.jwt.claims', pg_temp.jwt(current_setting('test.r_xburn', true), null), true);
set local role authenticated;
select throws_ok(
  format('select public.register_invited_profile(%L)', current_setting('test.h1x', true)::jsonb ->> 'code'),
  'P0001', 'no pending invitation',
  'H1-d: the burner presenting X''s original code is refused (probe C closed)'
);

reset role;
select is(
  (select count(*)::int from public.check_invitation_code('h1x-burner-198@local.test',
                                                           current_setting('test.h1x', true)::jsonb ->> 'code')),
  0,
  'H1-d: the pre-check returns 0 rows for the burner and X''s code'
);

reset role;
select set_config('request.jwt.claims', '', true);


select * from finish();
rollback;

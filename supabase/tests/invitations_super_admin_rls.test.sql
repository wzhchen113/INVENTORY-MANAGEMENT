-- supabase/tests/invitations_super_admin_rls.test.sql
--
-- Spec 026 / Track A — pgTAP regression for the invitations RLS
-- super_admin broadening shipped in
-- supabase/migrations/20260514150000_invitations_super_admin_rls.sql.
--
-- Three role bands × one INSERT vector against public.invitations:
--   (i)   admin JWT             → INSERT succeeds (regression check;
--                                  pre-existing behavior preserved).
--   (ii)  super_admin via       → INSERT succeeds (new behavior;
--         profiles.role row       auth_is_super_admin() reads
--                                  profiles.role, NOT the JWT, so the
--                                  impersonated JWT carries
--                                  app_metadata.role='user').
--   (iii) plain user JWT        → INSERT rejected with SQLSTATE 42501.
--
-- Hermetic begin; ... rollback; isolation. Mirrors the shape of
-- supabase/tests/eod_submissions_consistency.test.sql.
--
-- Implementation note on the super_admin fixture: profiles.id has FK to
-- auth.users(id) (see 20260405000759_init_schema.sql:21), so we cannot
-- mint a synthetic UUID and INSERT a freestanding profiles row. Instead
-- we reuse the seeded master user's auth.users.id (master_id =
-- '33333333-...') and ON CONFLICT DO UPDATE its profile to
-- role='super_admin' + brand_id=NULL inside the hermetic transaction.
-- The profiles_role_brand_consistent CHECK requires brand_id IS NULL for
-- super_admin rows.

begin;
create extension if not exists pgtap;

select plan(4);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_admin_id  uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin
  v_super_id  uuid := '33333333-3333-3333-3333-333333333333';  -- seed master, repurposed
  v_user_id   uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager
begin
  perform set_config('test.admin_id', v_admin_id::text, true);
  perform set_config('test.super_id', v_super_id::text, true);
  perform set_config('test.user_id',  v_user_id::text,  true);
end $$;

select isnt(current_setting('test.admin_id', true), '',
  'fixture: admin_id resolves from seed');

-- Promote the seeded master to super_admin inside the hermetic txn.
-- The profiles_role_brand_consistent CHECK requires brand_id IS NULL
-- for super_admin rows; UPDATE both columns atomically.
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.super_id', true)::uuid;

-- ─── Arm (i): admin JWT — INSERT succeeds ─────────────────────
-- auth_is_admin() reads app_metadata.role from the JWT; no profiles
-- row mutation needed for this arm.
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

-- profile_id is NOT NULL with no default and no FK constraint
-- (see information_schema). Reuse the caller's auth.uid() as the
-- inviter's profile id — same shape the inviteUser flow uses in prod.
insert into public.invitations (email, name, role, store_ids, profile_id)
  values ('test-admin@example.invalid', 'Admin Test', 'manager',
          array[]::text[],
          current_setting('test.admin_id', true)::uuid);

select is(
  (select count(*)::bigint
     from public.invitations
    where email = 'test-admin@example.invalid'),
  1::bigint,
  'arm (i): admin JWT INSERT succeeds (regression check — pre-existing behavior preserved)'
);

-- ─── Arm (ii): super_admin via profiles row — INSERT succeeds ─
-- JWT app_metadata.role is intentionally 'user' (NOT admin/master) to
-- prove the super_admin code path triggers via profiles.role lookup
-- inside auth_is_super_admin(), independent of the JWT.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.super_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

insert into public.invitations (email, name, role, store_ids, profile_id)
  values ('test-superadmin@example.invalid', 'Super Test', 'manager',
          array[]::text[],
          current_setting('test.super_id', true)::uuid);

select is(
  (select count(*)::bigint
     from public.invitations
    where email = 'test-superadmin@example.invalid'),
  1::bigint,
  'arm (ii): super_admin via profiles row INSERT succeeds (new behavior)'
);

-- ─── Arm (iii): plain user JWT — INSERT rejected (42501) ──────
-- Neither auth_is_admin() (JWT app_metadata.role='user', not in
-- ['admin','master']) nor auth_is_super_admin() (profiles.role for
-- v_user_id is 'user' per seed, never promoted in this txn) returns
-- true. auth_is_privileged() short-circuits to false → 42501.
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
  format(
    $q$insert into public.invitations (email, name, role, store_ids, profile_id)
       values ('test-user@example.invalid', 'User Test', 'manager',
               array[]::text[], %L::uuid)$q$,
    current_setting('test.user_id', true)
  ),
  '42501',
  null,
  'arm (iii): non-privileged user JWT INSERT rejected by RLS (42501)'
);

select * from finish();
rollback;

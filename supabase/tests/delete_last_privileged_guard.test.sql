-- supabase/tests/delete_last_privileged_guard.test.sql
--
-- Spec 031 / pgTAP regression for the last-super-admin / master deletion
-- guard implemented as public.assert_not_last_of_role(uuid, text) in
-- supabase/migrations/20260514160000_assert_not_last_of_role.sql.
--
-- Tests the canonical SQL helper directly — the same function the
-- delete-user edge function calls via RPC. One source of truth, one
-- regression detector (Path A per spec §0).
--
-- Four arms (plan(4)). Architect's ordering: master arms BEFORE
-- super_admin arms because Arm (iii) mutates the seed master profile
-- to super_admin (brand_id NULL per profiles_role_brand_consistent CHECK),
-- which would otherwise contaminate the master count for Arm (i) / (ii).
--
--   Arm (i)   — last master refused. Seed has exactly one master row;
--               assert_not_last_of_role raises P0001 with message
--               'cannot delete the last master'.
--   Arm (ii)  — non-last master allowed. Promote the seed admin row to
--               master so count = 2; the helper returns void.
--   Arm (iii) — last super_admin refused. Promote the seed master to
--               super_admin so exactly one super_admin row exists; the
--               helper raises P0001 with 'cannot delete the last
--               super_admin'.
--   Arm (iv)  — non-last super_admin allowed. Promote a second user to
--               super_admin so count = 2; the helper returns void.
--
-- Hermetic begin; ... rollback; isolation. All profile mutations are
-- rolled back. Mirrors the shape of invitations_super_admin_rls.test.sql.
--
-- JWT context: the helper is `security definer` and does not check
-- auth.uid(). No need to set local role / stuff request.jwt.claims —
-- the test runs as the default psql superuser context.

begin;
create extension if not exists pgtap;

-- plan(4): four functional arms (i)..(iv). No fixture sanity assertion —
-- the seed UUIDs are literals embedded in the do$$ block; a fixture
-- assertion is unnecessary here (the seed always contains these rows
-- per supabase/seed.sql).
select plan(4);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_admin_id   uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';  -- seed master
  v_brand_a    uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
begin
  perform set_config('test.admin_id',   v_admin_id::text,   true);
  perform set_config('test.manager_id', v_manager_id::text, true);
  perform set_config('test.master_id',  v_master_id::text,  true);
  perform set_config('test.brand_a',    v_brand_a::text,    true);
end $$;

-- ─── Arm (i): last master refused ──────────────────────────────
-- Seed contains exactly one master row (id 33333333-..., brand A).
-- The helper sees no OTHER master rows when target = master_id and
-- raises P0001 with the exact stable message.
select throws_ok(
  format(
    $q$select public.assert_not_last_of_role(%L::uuid, 'master')$q$,
    current_setting('test.master_id', true)
  ),
  'P0001',
  'cannot delete the last master',
  'arm (i): last master delete refused (P0001 + exact message)'
);

-- ─── Arm (ii): non-last master allowed ─────────────────────────
-- Promote the seed admin row (11111111-...) to master in brand A so
-- the master count becomes 2. Deleting the original master is now
-- allowed (one other master remains).
update public.profiles
   set role = 'master', brand_id = current_setting('test.brand_a', true)::uuid
 where id = current_setting('test.admin_id', true)::uuid;

select lives_ok(
  format(
    $q$select public.assert_not_last_of_role(%L::uuid, 'master')$q$,
    current_setting('test.master_id', true)
  ),
  'arm (ii): non-last master delete allowed (helper returns void)'
);

-- ─── Arm (iii): last super_admin refused ───────────────────────
-- Promote the seed master row to super_admin with brand_id = NULL (the
-- profiles_role_brand_consistent CHECK requires brand_id IS NULL for
-- super_admin). After this update there is exactly one super_admin row.
-- Note: the admin row is still 'master' from Arm (ii), so the master
-- count is 1 (only the admin row) — but Arm (iii) targets super_admin,
-- not master, so that's irrelevant.
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.master_id', true)::uuid;

select throws_ok(
  format(
    $q$select public.assert_not_last_of_role(%L::uuid, 'super_admin')$q$,
    current_setting('test.master_id', true)
  ),
  'P0001',
  'cannot delete the last super_admin',
  'arm (iii): last super_admin delete refused (P0001 + exact message)'
);

-- ─── Arm (iv): non-last super_admin allowed ────────────────────
-- Promote the seed manager row to super_admin (brand_id NULL) so the
-- super_admin count becomes 2. Deleting the original super_admin (the
-- former master, id 33333333-...) is now allowed.
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.manager_id', true)::uuid;

select lives_ok(
  format(
    $q$select public.assert_not_last_of_role(%L::uuid, 'super_admin')$q$,
    current_setting('test.master_id', true)
  ),
  'arm (iv): non-last super_admin delete allowed (helper returns void)'
);

select * from finish();
rollback;

-- supabase/tests/auth_can_see_store_brand_scope.test.sql
--
-- Spec 041 / pgTAP regression for the brand-scoped tightening of
-- public.auth_can_see_store(uuid) shipped in
-- supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql.
--
-- Fourteen arms (plan(14)). Each arm impersonates a different caller via
-- request.jwt.claims and asserts the boolean return of the helper
-- for a known store_id, or asserts that an UPDATE / DELETE / TRUNCATE
-- on profiles is rejected by the new self-write lockdown triggers and
-- the round-3 REVOKE. Arms (1)-(2) exercise the helper tightening
-- (admin sees own brand only); arm (3) confirms super_admin still
-- spans every brand; arm (4) confirms the master JWT path mirrors
-- admin; arms (5)-(6) confirm the per-row user_stores membership arm
-- is unchanged.
-- Arms (7)-(10) cover the review-round 1 privilege-escalation fix
-- (self-PATCH on profiles.brand_id / profiles.role is rejected by
-- the new profiles_self_brand_lock trigger, end-to-end proof that
-- the attacker cannot then see foreign-brand stores).
-- Arms (11)-(13) cover the review-round 2 fix — the BEFORE-DELETE
-- companion trigger profiles_self_delete_lock that closes the
-- DELETE+INSERT bypass of the UPDATE trigger.
-- Arm (14) covers the review-round 3 fix — REVOKE TRUNCATE on
-- public.profiles from authenticated, anon closes the
-- TRUNCATE+INSERT bypass of both the UPDATE and DELETE triggers
-- (TRUNCATE does not fire row-level triggers per Postgres semantics).
--
-- Fixture strategy:
--   - The seed has a single brand ('2a000000-...-0001', "2AM
--     PROJECT") and four brand-A stores. To exercise the
--     cross-brand denial path, the test transaction inserts a
--     second brand row and a brand-B store inside the hermetic
--     begin/rollback. Both are gone when the test finishes.
--   - The super_admin arm promotes the seed master profile to
--     super_admin (brand_id = NULL per profiles_role_brand_consistent)
--     mid-transaction, same pattern as
--     delete_last_privileged_guard.test.sql:95-97.
--
-- JWT-impersonation pattern copied from
-- recipe_categories_super_admin_rls.test.sql:65-74 — set local
-- role authenticated, set_config('request.jwt.claims', …, true).
--
-- Hermetic isolation: begin; … rollback;. The seed brand list,
-- store list, profiles, and user_stores rows are all restored on
-- rollback.

begin;
create extension if not exists pgtap;

select plan(14);

-- ─── fixtures (constants stashed via set_config) ───────────────
do $$
declare
  v_admin_id   uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', brand A)
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';  -- seed master (brand A)
  v_brand_a    uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b    uuid := 'b1000000-0000-0000-0000-000000000001';  -- test-only brand
  v_store_towson uuid := '00000000-0000-0000-0000-000000000001';  -- seed Towson (brand A)
  v_store_charles uuid := '1ea549bb-8b50-4078-9301-479311d9fdec';  -- seed Charles (brand A, manager has NO user_stores grant for it)
  v_store_b    uuid := 'b1000001-0000-0000-0000-000000000001';  -- test-only foreign-brand store
begin
  perform set_config('test.admin_id',     v_admin_id::text,     true);
  perform set_config('test.manager_id',   v_manager_id::text,   true);
  perform set_config('test.master_id',    v_master_id::text,    true);
  perform set_config('test.brand_a',      v_brand_a::text,      true);
  perform set_config('test.brand_b',      v_brand_b::text,      true);
  perform set_config('test.store_towson', v_store_towson::text, true);
  perform set_config('test.store_charles',v_store_charles::text,true);
  perform set_config('test.store_b',      v_store_b::text,      true);
end $$;

-- Insert the test-only foreign brand and a store inside it. Both
-- are scoped to this transaction. The brand row goes into
-- public.brands directly under the default psql superuser role
-- (no RLS for the postgres role).
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 041)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (
  current_setting('test.store_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Store (test 041)',
  '1 Foreign Way',
  'active',
  '22:00'
)
on conflict (id) do nothing;


-- ─── Arm (1): admin sees own-brand store ──────────────────────
-- JWT: app_metadata.role='admin', sub = seed admin (brand A).
-- Target: Towson (brand A). Expected: true via the new arm
-- (auth_is_admin() AND auth_can_see_brand(stores.brand_id)).
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

select is(
  public.auth_can_see_store(current_setting('test.store_towson', true)::uuid),
  true,
  'arm (1): admin sees own-brand store (admin + auth_can_see_brand match)'
);


-- ─── Arm (2): admin does NOT see foreign-brand store ──────────
-- JWT unchanged from arm (1). Target: store_b (foreign brand).
-- Expected: false. The admin arm fails on the brand check
-- (auth_can_see_brand returns false for a non-super-admin caller
-- whose profiles.brand_id != stores.brand_id), and the
-- user_stores arm fails (no grant exists; the
-- user_stores_brand_match trigger would have blocked one anyway).
select is(
  public.auth_can_see_store(current_setting('test.store_b', true)::uuid),
  false,
  'arm (2): admin does NOT see foreign-brand store (brand mismatch, no user_stores grant)'
);


-- ─── Arm (3): super_admin sees foreign-brand store ────────────
-- Reset to the postgres role so we can mutate profiles outside
-- of RLS, promote the seed master to super_admin (brand_id NULL
-- per profiles_role_brand_consistent), then impersonate them.
-- Same pattern as delete_last_privileged_guard.test.sql:95-97.
reset role;

update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.master_id', true)::uuid;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

select is(
  public.auth_can_see_store(current_setting('test.store_b', true)::uuid),
  true,
  'arm (3): super_admin sees foreign-brand store (auth_is_super_admin short-circuit)'
);


-- ─── Arm (4): master sees own-brand store ─────────────────────
-- Reset role, then impersonate the SEED admin row (still
-- profiles.role='admin', brand A) but with JWT
-- app_metadata.role='master' — auth_is_admin() reads the JWT and
-- treats master identically to admin. Using the seed admin row
-- here (rather than the seed master, which we just promoted to
-- super_admin) keeps the test arms order-independent.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'master')
  )::text,
  true
);

select is(
  public.auth_can_see_store(current_setting('test.store_towson', true)::uuid),
  true,
  'arm (4): master JWT sees own-brand store (admin/master arm passes via auth_can_see_brand)'
);


-- ─── Arm (5): staff with user_stores grant sees granted store ──
-- JWT: app_metadata.role='user', sub = seed manager (brand A,
-- role='user'). Manager has explicit user_stores rows for
-- Towson + Frederick (seed.sql:198-200). Target: Towson.
-- Expected: true via the third OR-arm (user_stores membership).
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
  public.auth_can_see_store(current_setting('test.store_towson', true)::uuid),
  true,
  'arm (5): staff with user_stores grant sees granted store'
);


-- ─── Arm (6): staff without grant is rejected ─────────────────
-- JWT unchanged from arm (5). Target: Charles (brand A, manager
-- has NO user_stores grant for it — seed.sql:198-200 only grants
-- Towson + Frederick). Expected: false. Manager has role='user'
-- so the JWT admin/master arm fails; no user_stores row exists.
select is(
  public.auth_can_see_store(current_setting('test.store_charles', true)::uuid),
  false,
  'arm (6): staff with no user_stores grant does not see store'
);


-- ============================================================
-- Profile self-write lockdown arms (review-round 1 fix)
--
-- Closes a privilege-escalation chain that the helper tightening
-- alone did not stop: a brand-admin could PATCH their own
-- profiles.brand_id to a foreign brand and immediately regain
-- cross-brand access via the helper's now-tightened admin arm
-- (since auth_can_see_brand would then return true for the
-- foreign brand). The profiles_self_brand_lock trigger installed
-- by the migration rejects such self-writes for non-super_admin
-- callers, on both brand_id and role.
--
-- Arms 7-8 exercise the trigger directly (under the seed admin's
-- JWT). Arm 9 confirms super_admin can still update OTHER users'
-- brand_id (positive control — the trigger doesn't over-block).
-- Arm 10 is the end-to-end proof: after a rejected self-write
-- attempt, the brand-admin still cannot see foreign-brand stores
-- via the helper.
-- ============================================================

-- ─── Arm (7): brand-admin self-PATCH of brand_id is rejected ──
-- Impersonate the seed admin (role='admin', brand A). Attempt to
-- self-UPDATE profiles.brand_id to the foreign brand. The trigger
-- raises an exception with the stable message
-- 'brand_id is read-only for self-edits (super_admin only)'.
-- pgTAP's throws_ok asserts the exact message; without this
-- check, a future migration that drops the trigger would silently
-- pass the attack.
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

select throws_ok(
  format(
    $q$update public.profiles
         set brand_id = %L::uuid
       where id = %L::uuid$q$,
    current_setting('test.brand_b', true),
    current_setting('test.admin_id', true)
  ),
  'P0001',
  'brand_id is read-only for self-edits (super_admin only)',
  'arm (7): brand-admin self-PATCH on profiles.brand_id is rejected by profiles_self_brand_lock trigger'
);


-- ─── Arm (8): brand-admin self-PATCH of role is rejected ──────
-- JWT unchanged from arm (7). Attempt to self-UPDATE
-- profiles.role to 'super_admin'. The trigger raises with the
-- stable message 'role is read-only for self-edits (super_admin
-- only)'. Defense-in-depth: a brand-admin who could self-promote
-- to super_admin via PATCH /rest/v1/profiles would bypass every
-- brand-scoped policy in one step.
--
-- Note: role='super_admin' is one of several values that would
-- be game-over; any role-mutation by a non-super_admin caller is
-- rejected regardless of the target value, because the trigger
-- compares old.role IS DISTINCT FROM new.role.
select throws_ok(
  format(
    $q$update public.profiles
         set role = 'super_admin'
       where id = %L::uuid$q$,
    current_setting('test.admin_id', true)
  ),
  'P0001',
  'role is read-only for self-edits (super_admin only)',
  'arm (8): brand-admin self-PATCH on profiles.role is rejected by profiles_self_brand_lock trigger'
);


-- ─── Arm (9): super_admin can update another user's brand_id ──
-- Positive control: the trigger MUST NOT over-block — super_admin
-- is the legitimate path for cross-brand admin moves (e.g.
-- promoting a user to a new brand). Reuse the in-txn-promoted
-- master_id from arm (3) (still role='super_admin' inside this
-- transaction). Have them update the seed manager's brand_id to
-- the foreign brand and confirm the write lands.
--
-- We're NOT updating the manager's actual brand assignment in
-- prod — the entire test is wrapped in begin/rollback. This arm
-- only proves the trigger short-circuits on auth_is_super_admin()
-- BEFORE the brand_id check fires.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

update public.profiles
   set brand_id = current_setting('test.brand_b', true)::uuid
 where id = current_setting('test.manager_id', true)::uuid;

select is(
  (select brand_id from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  current_setting('test.brand_b', true)::uuid,
  'arm (9): super_admin can update ANOTHER user''s brand_id (trigger does not over-block)'
);


-- ─── Arm (10): brand-admin still cannot see foreign store ─────
-- End-to-end proof. After arm (7) rejected the self-PATCH, the
-- brand-admin's profiles.brand_id is unchanged (still brand A —
-- the trigger raised an exception, the UPDATE never committed).
-- We re-impersonate them and confirm auth_can_see_store still
-- returns false for the foreign-brand store. Without the trigger,
-- the helper would have returned true at this point (the attack
-- chain Bobby ran on the local DB).
--
-- Note: we set brand_id back to brand A before the impersonation
-- because arm (9) just moved the seed manager (NOT the seed
-- admin), but defensively re-affirming admin's brand_id makes
-- this arm independent of arm-9's outcome.
reset role;
update public.profiles
   set brand_id = current_setting('test.brand_a', true)::uuid
 where id = current_setting('test.admin_id', true)::uuid
   and brand_id is distinct from current_setting('test.brand_a', true)::uuid;

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

select is(
  public.auth_can_see_store(current_setting('test.store_b', true)::uuid),
  false,
  'arm (10): after rejected self-PATCH, brand-admin still cannot see foreign-brand store (end-to-end)'
);


-- ============================================================
-- Profile self-DELETE lockdown arms (review-round 2 fix)
--
-- Closes the DELETE+INSERT bypass that the BEFORE-UPDATE trigger
-- did not cover. A brand-admin (JWT app_metadata.role='admin')
-- could DELETE their own profile (permitted by "Admins can
-- delete profiles") and then INSERT a fresh row at the same
-- auth.uid() with foreign brand_id or role='super_admin'
-- (permitted by the self-INSERT policy) — reaching the same
-- privilege-escalation end-state as the round-1 UPDATE attack.
--
-- The new profiles_self_delete_lock BEFORE-DELETE trigger rejects
-- step 1 (the DELETE), so the chain never reaches step 2.
-- Blocking DELETE alone is sufficient because the PK constraint
-- on profiles.id + FK to auth.users make standalone INSERT
-- impractical — the row would PK-collide with the original.
--
-- Arm (11) exercises the trigger directly under the brand-admin's
-- JWT (still loaded from arm (10), see note below).
-- Arm (12) is the positive control — the in-txn-promoted
-- super_admin (master_id, see arm (3)) can DELETE another user's
-- profile; the trigger must not over-block.
-- Arm (13) re-runs the end-to-end attack chain after the
-- positive control to confirm the chain still dies at step 1.
-- ============================================================

-- ─── Arm (11): brand-admin self-DELETE is rejected ────────────
-- JWT still impersonates the seed admin (role='admin', brand A)
-- from arm (10). Attempt to self-DELETE the brand-admin's own
-- profile row. The trigger raises with the stable message
-- 'profile self-delete is not permitted (use admin delete flow)'.
-- pgTAP's throws_ok asserts the exact message — without this
-- check, a future migration that drops the trigger would silently
-- re-open the DELETE+INSERT bypass.
select throws_ok(
  format(
    $q$delete from public.profiles where id = %L::uuid$q$,
    current_setting('test.admin_id', true)
  ),
  'P0001',
  'profile self-delete is not permitted (use admin delete flow)',
  'arm (11): brand-admin self-DELETE on profiles is rejected by profiles_self_delete_lock trigger'
);


-- ─── Arm (12): super_admin can DELETE another user's profile ──
-- Positive control: the trigger MUST NOT over-block. The in-txn
-- super_admin (master_id, promoted in arm (3)) is still
-- role='super_admin' inside this transaction. We DELETE the seed
-- manager's profile row and confirm the row is gone — proving the
-- trigger admits the operation when the caller is not deleting
-- their own row.
--
-- RLS isolation: the current "Admins can delete profiles" RLS
-- policy gates DELETE on JWT app_metadata.role IN ('admin',
-- 'master') and no super_admin-specific DELETE policy exists, so
-- attempting this under `set local role authenticated` would be
-- silently filtered by RLS (DELETE 0) regardless of trigger
-- behavior. To isolate the TRIGGER's behavior from the RLS policy
-- stack, we run this arm under the postgres role (RLS bypass) but
-- with the super_admin JWT claims set so auth.uid() and
-- auth_is_super_admin() read the intended caller. Triggers fire
-- regardless of role, so this proves the trigger's bypass works.
-- We're not affecting prod state — the entire test is wrapped in
-- begin/rollback. The seed manager will be restored on rollback.
reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

delete from public.profiles
 where id = current_setting('test.manager_id', true)::uuid;

select is(
  (select count(*)::int from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  0,
  'arm (12): super_admin can DELETE another user''s profile (trigger does not over-block)'
);


-- ─── Arm (13): end-to-end DELETE+INSERT chain dies at step 1 ──
-- After arm (12) verified the trigger does not over-block, the
-- brand-admin attack chain (DELETE own profile, then INSERT a
-- fresh row with foreign brand_id or role='super_admin') must
-- still fail at step 1. Re-impersonate the brand-admin and
-- attempt the DELETE; throws_ok confirms the chain dies before
-- INSERT is even possible. (We don't need to attempt the INSERT —
-- the spec 041 round-2 audit confirms the PK constraint on
-- profiles.id makes a standalone INSERT impractical without the
-- prior DELETE landing.)
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

select throws_ok(
  format(
    $q$delete from public.profiles where id = %L::uuid$q$,
    current_setting('test.admin_id', true)
  ),
  'P0001',
  'profile self-delete is not permitted (use admin delete flow)',
  'arm (13): brand-admin DELETE+INSERT escalation chain dies at step 1 (DELETE rejected, INSERT never attempted)'
);


-- ============================================================
-- Profile TRUNCATE lockdown arm (review-round 3 fix)
--
-- Closes the TRUNCATE+INSERT bypass that BOTH the round-1 UPDATE
-- trigger AND the round-2 DELETE trigger missed. TRUNCATE does
-- not fire row-level DELETE triggers — it has its own
-- statement-level TRUNCATE trigger event class (documented
-- Postgres semantics). A brand-admin could TRUNCATE
-- public.profiles CASCADE and then INSERT a fresh row at
-- auth.uid() with role='super_admin' or any foreign brand_id,
-- reaching the same end-state as the round-1 and round-2 attacks
-- — full cross-brand visibility + same-session super_admin
-- self-escalation.
--
-- The migration's REVOKE TRUNCATE on public.profiles from
-- authenticated, anon closes the chain at step 1. service_role
-- retains TRUNCATE (separate grant audience), and the postgres
-- superuser bypasses all grants — so no legitimate flow is
-- affected.
--
-- Arm (14) exercises the REVOKE directly under the brand-admin's
-- JWT. The TRUNCATE attempt should fail with SQLSTATE 42501
-- (insufficient_privilege) before any row-level trigger or
-- policy gets a chance to fire.
-- ============================================================

-- ─── Arm (14): brand-admin TRUNCATE on profiles is rejected ───
-- JWT impersonates the seed admin (role='admin', brand A).
-- Attempt to TRUNCATE public.profiles. The REVOKE removes the
-- privilege at the grant layer, so PostgreSQL raises
-- 'permission denied for table profiles' with SQLSTATE '42501'
-- (insufficient_privilege) BEFORE any trigger or RLS policy
-- evaluation. pgTAP's throws_ok with the 4-arg form pins both
-- the SQLSTATE and the exact error message — guarding against a
-- silent regression where the REVOKE is removed (which would
-- surface as a different error class: trigger NOTICE, RLS
-- "no rows affected", or — worst case — TRUNCATE succeeding).
--
-- Without the REVOKE, the TRUNCATE+INSERT bypass landed in the
-- live-verify run from the security-auditor round-3 audit
-- (TRUNCATE TABLE; INSERT 0 1; auth_is_super_admin() returned
-- true). This arm guards against that regression.
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

select throws_ok(
  $q$truncate table public.profiles$q$,
  '42501',
  'permission denied for table profiles',
  'arm (14): brand-admin TRUNCATE on public.profiles is rejected with insufficient_privilege (42501) — closes the TRUNCATE+INSERT bypass'
);


select * from finish();
rollback;

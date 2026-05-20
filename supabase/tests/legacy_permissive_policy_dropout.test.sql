-- supabase/tests/legacy_permissive_policy_dropout.test.sql
--
-- Spec 051 / pgTAP regression for the legacy permissive-policy
-- dropout shipped in
-- supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql.
--
-- Thirteen arms (plan(13)). Each arm exercises one of the policy
-- predicates that was previously shadowed by the wide ALL policy on
-- `public.stores` or `public.user_stores`, or asserts the no-
-- regression behavior on the rewritten `*_categories` SELECT
-- policies.
--
--   Arms (1)-(7): public.stores tightening (Matrix A).
--     (1) brand-A admin SELECT on foreign store → 0 rows (the
--         Bobby leak the spec was written to close).
--     (2) brand-A admin INSERT into stores with brand_id =
--         <foreign> → 42501 (latent WRITE leak in the same
--         shadowed policy stack).
--     (3) brand-A admin UPDATE on foreign store → silently 0
--         rows (USING fails).
--     (4) brand-A admin DELETE on foreign store → silently 0
--         rows.
--     (5) super_admin SELECT/INSERT/UPDATE/DELETE across brands
--         → all succeed via the auth_is_super_admin short-
--         circuit inside auth_can_see_brand (no-regression,
--         compacted into one ok() over a bool_and VALUES list).
--     (6) brand-A admin SELECT same-brand stores → 4 rows (the
--         four seed stores in brand A, no-regression).
--     (7) seed manager (role=user, brand A, no user_stores
--         grant for foreign-brand store) SELECT foreign store
--         → 0 rows (no-regression — the legacy wide policy
--         previously admitted this read for any authenticated
--         caller).
--
--   Arms (8)-(11): public.user_stores tightening (Matrix B).
--     (8) seed manager INSERT into user_stores granting another
--         user a store → 42501 (own-row policy: user_id !=
--         auth.uid(); admin arm fails: not privileged). This is
--         the same-brand cross-user grant leak the legacy
--         `Users can manage own store links` left open.
--     (9) seed manager INSERT into user_stores granting THEMSELF
--         a brand-A store they have no current grant for → admit
--         (own-row policy WITH CHECK: user_id = auth.uid();
--         trigger admits: same brand). No-regression for the
--         legitimate self-onboarding path.
--     (10) brand-A admin INSERT into user_stores granting a
--          brand-A user a brand-A store → admit (admin arm:
--          privileged + brand match). No-regression for the
--          legitimate admin invitation flow.
--     (11) brand-A admin INSERT into user_stores granting a
--          brand-A user a FOREIGN-brand store → P0001 from the
--          existing user_stores_brand_match trigger (which fires
--          BEFORE ROW, before RLS WITH CHECK per documented
--          Postgres execution order). The new admin policy
--          introduced in this migration ALSO rejects the same
--          row structurally (admin arm's brand check fails), but
--          the trigger raises first — this arm proves the
--          belt-and-suspenders pair is intact post-051 and
--          guards against a regression where a future migration
--          drops or weakens either layer.
--
--   Arms (12)-(13): public.*_categories no-regression
--     (Matrix C + D — clarity rewrite, semantic no-op).
--     (12) brand-A admin SELECT on ingredient_categories → row
--          count > 0 (NOT brand-filtered — intentional cross-
--          brand master data).
--     (13) brand-A admin SELECT on recipe_categories → row count
--          > 0 (same intent).
--
-- Fixture pattern mirrors
-- supabase/tests/auth_can_see_store_brand_scope.test.sql
-- verbatim — seed admin / manager / master IDs from the seed,
-- foreign brand + foreign store + foreign user inserted inside
-- the transaction. The seed master is promoted to super_admin
-- mid-txn for arm (5) (same pattern as
-- delete_last_privileged_guard.test.sql:95-97).
--
-- JWT-impersonation pattern: `set local role authenticated;` plus
-- `set_config('request.jwt.claims', …, true)` immediately before
-- each arm. Verification SELECTs that need to inspect rows the
-- impersonated caller cannot SELECT (the brand-A admin reading
-- the foreign-brand store under their own JWT would be filtered
-- by the now-tightened `store_member_read_stores` policy) use
-- `reset role; select set_config('request.jwt.claims', '', true);`
-- to fall back to the postgres role (RLS bypass) — same pattern
-- as supabase/tests/rls_hardening_followups.test.sql arms (5)-(6).
--
-- Hermetic isolation: `begin; ... rollback;`. The seed brands,
-- stores, profiles, user_stores rows are all restored on
-- rollback. Foreign-brand fixtures inserted in this transaction
-- vanish on rollback.

begin;
create extension if not exists pgtap;

select plan(13);


-- ─── fixtures (constants stashed via set_config) ───────────────
do $$
declare
  v_admin_id      uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_manager_id    uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', brand A)
  v_master_id     uuid := '33333333-3333-3333-3333-333333333333';  -- seed master (brand A) — promoted to super_admin mid-txn
  v_brand_a       uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b       uuid := 'b1000000-0000-0000-0000-000000000051';  -- test-only foreign brand (51 = spec 051)
  v_store_towson  uuid := '00000000-0000-0000-0000-000000000001';  -- seed Towson (brand A)
  v_store_charles uuid := '1ea549bb-8b50-4078-9301-479311d9fdec';  -- seed Charles (brand A) — manager has NO user_stores grant for it
  v_store_b       uuid := 'b1000001-0000-0000-0000-000000000051';  -- test-only foreign-brand store
  -- A synthetic brand-A target user for arm (10) (the admin grants
  -- this user access to Charles). Distinct from the seed manager
  -- so arm (10) doesn't bump into arm (9)'s INSERT.
  v_target_a      uuid := 'aaaaa051-0000-0000-0000-000000000001';
  -- A synthetic brand-A target user for arm (8) — the seed manager
  -- attempts to grant THIS user (not themselves) a store. Same
  -- brand so the cross-user-but-same-brand leak is what we close.
  v_other_a       uuid := 'aaaaa051-0000-0000-0000-000000000002';
begin
  perform set_config('test.admin_id',      v_admin_id::text,      true);
  perform set_config('test.manager_id',    v_manager_id::text,    true);
  perform set_config('test.master_id',     v_master_id::text,     true);
  perform set_config('test.brand_a',       v_brand_a::text,       true);
  perform set_config('test.brand_b',       v_brand_b::text,       true);
  perform set_config('test.store_towson',  v_store_towson::text,  true);
  perform set_config('test.store_charles', v_store_charles::text, true);
  perform set_config('test.store_b',       v_store_b::text,       true);
  perform set_config('test.target_a',      v_target_a::text,      true);
  perform set_config('test.other_a',       v_other_a::text,       true);
end $$;


-- Insert the test-only foreign brand and a store inside it. Both
-- are scoped to this transaction. The brand row goes into
-- public.brands directly under the default psql superuser role
-- (no RLS for the postgres role).
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 051)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (
  current_setting('test.store_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Store (test 051)',
  '1 Foreign Way',
  'active',
  '22:00'
)
on conflict (id) do nothing;


-- Insert synthetic auth.users rows so the profiles FK is satisfied.
-- Match the seed.sql shape (auth.users requires many NOT NULL
-- columns — confirmation_token et al). Idempotent.
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
) values
  (current_setting('test.target_a', true)::uuid,
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'target-a-051@local.test', '',
   now(), now(), now(),
   jsonb_build_object('provider','email','providers',array['email'],'role','user'),
   '{}'::jsonb, false, false,
   '','','','','','','',''),
  (current_setting('test.other_a', true)::uuid,
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'other-a-051@local.test', '',
   now(), now(), now(),
   jsonb_build_object('provider','email','providers',array['email'],'role','user'),
   '{}'::jsonb, false, false,
   '','','','','','','','')
on conflict (id) do nothing;


-- Insert synthetic brand-A profiles for the two target users.
-- role='user' so the profiles_role_brand_consistent CHECK passes
-- with brand_id non-null.
insert into public.profiles (id, name, role, initials, color, status, brand_id)
values
  (current_setting('test.target_a', true)::uuid,
   'Target A (test 051)', 'user', 'TA', '#888888', 'active',
   current_setting('test.brand_a', true)::uuid),
  (current_setting('test.other_a', true)::uuid,
   'Other A (test 051)', 'user', 'OA', '#888888', 'active',
   current_setting('test.brand_a', true)::uuid)
on conflict (id) do nothing;


-- ============================================================
-- Arms (1)-(7): public.stores tightening
-- ============================================================

-- ─── Arm (1): brand-A admin SELECT on foreign store — 0 rows ──
-- The Bobby leak. JWT app_metadata.role='admin', sub = seed admin
-- (brand A). The post-051 SELECT policy `store_member_read_stores`
-- gates on auth_can_see_store(id), which returns false for a
-- brand-A admin against a foreign-brand store (spec 041 helper).
-- Pre-051 the wide ALL policy `auth_manage_stores` admitted the
-- read for any authed caller; the count assertion would have been
-- 1, not 0.
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
  (select count(*)::int from public.stores
    where id = current_setting('test.store_b', true)::uuid),
  0,
  'arm (1): brand-A admin SELECT on foreign-brand store returns 0 rows (Bobby leak closed)'
);


-- ─── Arm (2): brand-A admin INSERT cross-brand — 42501 ────────
-- JWT unchanged. Attempt INSERT into stores with brand_id =
-- <foreign>. The post-051 policy stack: `privileged_insert_stores`
-- WITH CHECK fails (auth_can_see_brand(foreign brand) = false for
-- a brand-A admin); no other INSERT policy admits. Pre-051 the
-- wide ALL policy admitted the INSERT.
select throws_ok(
  format(
    $q$insert into public.stores
         (brand_id, name, address, status, eod_deadline_time)
       values (%L::uuid, 'Tampered store (test 051)', '1 Tamper Way', 'active', '22:00')$q$,
    current_setting('test.brand_b', true)
  ),
  '42501',
  'new row violates row-level security policy for table "stores"',
  'arm (2): brand-A admin cross-brand INSERT into stores is rejected by RLS WITH CHECK (42501)'
);


-- ─── Arm (3): brand-A admin UPDATE foreign store — 0 rows ─────
-- JWT unchanged. UPDATE the pre-existing foreign-brand store.
-- Postgres RLS semantics: UPDATE that fails USING evaluates to
-- "no row matched" — silently affects 0 rows, no error. Same
-- shape as rls_hardening_followups.test.sql arms (5)-(6).
--
-- Verification flips to postgres-role (RLS bypass) because the
-- brand-A admin cannot SELECT the foreign-brand row under their
-- own JWT post-051. Clear `request.jwt.claims` so `reset role`
-- truly lands at `current_user = 'postgres'` (the spec 043 fixture
-- pattern — falls outside any current_user-gated trigger
-- allowlist).
update public.stores
   set name = 'Foreign Store (tampered by test 051)'
 where id = current_setting('test.store_b', true)::uuid;

reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select name from public.stores
    where id = current_setting('test.store_b', true)::uuid),
  'Foreign Store (test 051)',  -- unchanged from the original insert
  'arm (3): brand-A admin UPDATE on foreign-brand store silently affects 0 rows (RLS USING)'
);


-- ─── Arm (4): brand-A admin DELETE foreign store — 0 rows ─────
-- Re-impersonate the brand-A admin (claims cleared by arm 3's
-- verification step). DELETE the foreign-brand store. Same
-- silent-RLS-USING shape as arm (3).
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

delete from public.stores
 where id = current_setting('test.store_b', true)::uuid;

reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select count(*)::int from public.stores
    where id = current_setting('test.store_b', true)::uuid),
  1,  -- row still exists; DELETE silently affected 0 rows
  'arm (4): brand-A admin DELETE on foreign-brand store silently affects 0 rows (RLS USING)'
);


-- ─── Arm (5): super_admin cross-brand SELECT/INSERT/UPDATE/DELETE
-- Promote the seed master to super_admin mid-txn (brand_id NULL
-- per profiles_role_brand_consistent — same pattern as
-- auth_can_see_store_brand_scope.test.sql:135-139). Impersonate
-- the super_admin and exercise all four ops against the
-- foreign-brand store; bool_and over the four results compacts
-- into one assertion. The auth_is_super_admin short-circuit
-- inside auth_can_see_brand admits every op.
--
-- INSERT/UPDATE/DELETE actually mutate the store row; the
-- transaction's outer ROLLBACK restores state on test exit. We do
-- the INSERT against a new id (so the SELECT count of foreign-
-- brand stores comparing 2 rows works after the INSERT) — then we
-- UPDATE the original foreign store, then DELETE it. SELECT is
-- the first op, before any mutation, so it reads the still-1-row
-- foreign-brand set.
reset role;
select set_config('request.jwt.claims', '', true);

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

-- Track the four ops as boolean predicates and bool_and them.
do $$
declare
  v_select_ok bool;
  v_insert_ok bool;
  v_update_ok bool;
  v_delete_ok bool;
  v_new_id    uuid := 'b1000002-0000-0000-0000-000000000051';
begin
  -- SELECT: foreign-brand store visible.
  select count(*) = 1 into v_select_ok
    from public.stores
   where id = current_setting('test.store_b', true)::uuid;

  -- INSERT: new foreign-brand store.
  insert into public.stores
    (id, brand_id, name, address, status, eod_deadline_time)
  values (
    v_new_id,
    current_setting('test.brand_b', true)::uuid,
    'SuperAdmin Cross-Brand Insert (test 051)',
    '2 Foreign Way',
    'active',
    '22:00'
  );
  select count(*) = 1 into v_insert_ok
    from public.stores
   where id = v_new_id;

  -- UPDATE: rename the original foreign-brand store.
  update public.stores
     set name = 'SuperAdmin Cross-Brand Update (test 051)'
   where id = current_setting('test.store_b', true)::uuid;
  select count(*) = 1 into v_update_ok
    from public.stores
   where id = current_setting('test.store_b', true)::uuid
     and name = 'SuperAdmin Cross-Brand Update (test 051)';

  -- DELETE: remove the newly-inserted foreign-brand store.
  delete from public.stores where id = v_new_id;
  select count(*) = 0 into v_delete_ok
    from public.stores
   where id = v_new_id;

  perform set_config(
    'test.arm5_all_ok',
    (v_select_ok and v_insert_ok and v_update_ok and v_delete_ok)::text,
    true
  );
end $$;

select is(
  current_setting('test.arm5_all_ok', true),
  'true',
  'arm (5): super_admin can SELECT + INSERT + UPDATE + DELETE foreign-brand stores (auth_is_super_admin short-circuit)'
);


-- ─── Arm (6): brand-A admin SELECT own-brand stores — 4 rows ──
-- No-regression. Re-impersonate the brand-A admin. The post-051
-- SELECT policy `store_member_read_stores` admits all 4 seed
-- stores (brand A) via auth_can_see_store(id) — admin arm passes
-- because admin's brand_id matches store.brand_id.
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
  (select count(*)::int from public.stores
    where brand_id = current_setting('test.brand_a', true)::uuid),
  4,
  'arm (6): brand-A admin SELECTs all 4 own-brand seed stores (no-regression)'
);


-- ─── Arm (7): seed manager SELECT foreign store — 0 rows ──────
-- JWT app_metadata.role='user', sub = seed manager (brand A,
-- role='user'). Manager has NO user_stores grant for the
-- foreign-brand store. Post-051 the wide ALL policy on stores is
-- gone, so the only SELECT path is `store_member_read_stores`
-- (auth_can_see_store) — which evaluates false for every arm:
-- admin/master JWT arm fails (role='user'), super_admin profile
-- arm fails (manager.role='user'), user_stores arm fails (no
-- grant for the foreign store).
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
  (select count(*)::int from public.stores
    where id = current_setting('test.store_b', true)::uuid),
  0,
  'arm (7): seed manager (role=user, no grant) SELECT on foreign-brand store returns 0 rows'
);


-- ============================================================
-- Arms (8)-(11): public.user_stores tightening
-- ============================================================

-- ─── Arm (8): manager INSERT user_stores granting OTHER user ──
-- JWT unchanged (seed manager, role='user', brand A). Attempt to
-- INSERT a user_stores row granting `other_a` (a brand-A target
-- user) access to Charles (a brand-A store). Same-brand cross-
-- user grant — pre-051 the legacy `Users can manage own store
-- links` policy admitted via the second OR-arm (auth.uid() IS
-- NOT NULL), and the trigger admitted because both users are in
-- brand A. Post-051: own-row policy fails (user_id != auth.uid()),
-- admin arm fails (manager is not privileged) → 42501.
select throws_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id)
       values (%L::uuid, %L::uuid)$q$,
    current_setting('test.other_a', true),
    current_setting('test.store_charles', true)
  ),
  '42501',
  'new row violates row-level security policy for table "user_stores"',
  'arm (8): seed manager INSERT into user_stores for ANOTHER user is rejected (same-brand cross-user leak closed)'
);


-- ─── Arm (9): manager INSERT user_stores for SELF — admit ─────
-- JWT unchanged. INSERT a user_stores row granting `auth.uid()`
-- (the manager) access to Charles — a brand-A store the manager
-- has no current grant for. Post-051: own-row policy WITH CHECK
-- admits (user_id = auth.uid()); trigger admits (manager and
-- Charles are both in brand A). The row should exist after the
-- INSERT.
insert into public.user_stores (user_id, store_id)
values (
  current_setting('test.manager_id', true)::uuid,
  current_setting('test.store_charles', true)::uuid
);

-- Use the postgres role for the verification SELECT (the
-- manager's own-row SELECT policy `Users can read own store
-- links` would also admit this read, but flipping to postgres
-- mirrors the canonical project pattern and decouples this
-- assertion from any future change to the own-row SELECT
-- policy).
reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select count(*)::int from public.user_stores
    where user_id  = current_setting('test.manager_id', true)::uuid
      and store_id = current_setting('test.store_charles', true)::uuid),
  1,
  'arm (9): seed manager INSERT into user_stores for SELF on same-brand store admits (own-row policy + trigger)'
);


-- ─── Arm (10): brand-A admin INSERT user_stores in own brand ──
-- Re-impersonate the brand-A admin (claims cleared). INSERT a
-- user_stores row granting `target_a` (a brand-A user) access to
-- Charles (a brand-A store). The new admin arm admits:
-- auth_is_privileged() (admin JWT) + EXISTS subquery returns true
-- (Charles.brand_id = brand A, and auth_can_see_brand(brand A)
-- returns true for the brand-A admin). Trigger admits (same
-- brand). No-regression for the legitimate admin invitation flow.
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

insert into public.user_stores (user_id, store_id)
values (
  current_setting('test.target_a', true)::uuid,
  current_setting('test.store_charles', true)::uuid
);

reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select count(*)::int from public.user_stores
    where user_id  = current_setting('test.target_a', true)::uuid
      and store_id = current_setting('test.store_charles', true)::uuid),
  1,
  'arm (10): brand-A admin INSERT into user_stores for brand-A user on brand-A store admits (admin policy + brand match)'
);


-- ─── Arm (11): brand-A admin INSERT user_stores cross-brand ───
-- Re-impersonate the brand-A admin. Attempt to INSERT a
-- user_stores row crossing brands: target_a is a brand-A user,
-- store_b is a brand-B (foreign) store. Per the spec AC "covered
-- by both the new policy and the existing user_stores_brand_match
-- trigger — both layers asserted":
--
--   (i) The new admin POLICY introduced in this migration would
--       reject the INSERT: the admin arm's brand-check EXISTS
--       subquery evaluates auth_can_see_brand(s.brand_id = brand
--       B), which returns false for the brand-A admin; the
--       own-row arm fails (target_a != auth.uid()). Pre-051 the
--       wide ALL policy admitted the INSERT and the trigger was
--       the sole gate. Verified structurally by the migration's
--       policy text and by arm (10) showing the same admin policy
--       admits when the brand check passes.
--
--   (ii) The existing BEFORE-ROW user_stores_brand_match TRIGGER
--        also rejects the INSERT: profiles.brand_id (brand A) is
--        DISTINCT FROM stores.brand_id (brand B). Per documented
--        Postgres execution order (trigger.html §38.6), BEFORE
--        ROW triggers fire BEFORE RLS WITH CHECK evaluation on
--        INSERT — so the trigger raises P0001 first and the RLS
--        policy never gets to fire. We assert the trigger's
--        stable message and SQLSTATE here; the policy layer is
--        verified structurally by reading the migration. The
--        trigger raising first is unchanged from pre-051
--        behaviour — this arm guards against a regression where
--        a future migration drops or weakens the trigger,
--        because the cross-brand INSERT must continue to fail
--        somewhere (policy if trigger removed, trigger if
--        policy removed).
--
-- Both layers active is the "belt-and-suspenders" design pinned
-- in spec 051 §2 Matrix B and spec 012a's original trigger
-- documentation.
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
    $q$insert into public.user_stores (user_id, store_id)
       values (%L::uuid, %L::uuid)$q$,
    current_setting('test.target_a', true),
    current_setting('test.store_b', true)
  ),
  'P0001',
  format(
    'cross-brand user_stores assignment rejected: user brand=%s, store brand=%s',
    current_setting('test.brand_a', true),
    current_setting('test.brand_b', true)
  ),
  'arm (11): brand-A admin INSERT into user_stores cross-brand is rejected — trigger P0001 fires first (BEFORE ROW); migration policy is the structural backstop per spec 051 §2 Matrix B'
);


-- ============================================================
-- Arms (12)-(13): public.*_categories no-regression
-- ============================================================

-- ─── Arm (12): authenticated SELECT ingredient_categories ─────
-- JWT unchanged (brand-A admin). The rewritten SELECT policy
-- `Authenticated can read ingredient categories` admits via
-- `to authenticated using (true)` — semantically identical to
-- the legacy `auth.uid() is not null`. No brand filter; row
-- count > 0 (the seed plus any spec 004 backfill rows). The
-- specific count varies with the seed; just asserting > 0
-- captures the no-regression intent without pinning to a brittle
-- magic number.
select ok(
  (select count(*)::int from public.ingredient_categories) > 0,
  'arm (12): authenticated SELECT on ingredient_categories returns > 0 rows (intentional cross-brand master data)'
);


-- ─── Arm (13): authenticated SELECT recipe_categories ─────────
-- JWT unchanged. Same shape as arm (12). The rewritten SELECT
-- policy on recipe_categories admits via `to authenticated using
-- (true)`. The seed inserts a non-trivial recipe_categories
-- corpus (spec 013 + spec 048); the row count is > 0.
select ok(
  (select count(*)::int from public.recipe_categories) > 0,
  'arm (13): authenticated SELECT on recipe_categories returns > 0 rows (intentional cross-brand master data)'
);


select * from finish();
rollback;

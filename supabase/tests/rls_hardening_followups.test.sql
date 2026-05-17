-- supabase/tests/rls_hardening_followups.test.sql
--
-- Spec 042 / pgTAP regression for the three policy tightenings +
-- one trigger broadening shipped in
-- supabase/migrations/20260517050000_rls_hardening_followups.sql.
--
-- Fifteen arms (plan(15)).
--   Arms (1)-(7): order_schedule WRITE policy tightening.
--     (1)-(3) same-brand admin INSERT/UPDATE/DELETE → admit.
--     (4)-(6) cross-brand admin INSERT/UPDATE/DELETE → reject /
--             0 rows.
--     (7)    super_admin cross-brand INSERT → admit (positive
--             control via auth_is_super_admin short-circuit).
--   Arms (8)-(12): profiles policy tightenings.
--     (8)   admin same-brand cross-user UPDATE → admit.
--     (9)   admin cross-brand UPDATE → 0 rows (RLS rejects
--            silently per Postgres UPDATE+RLS semantics).
--     (10)  super_admin cross-brand UPDATE → admit (positive
--            control).
--     (11)  regular user self-UPDATE (dark_mode) → admit
--            (WITH CHECK no-regression).
--     (12)  regular user row-key forgery (UPDATE … SET id=other)
--            → reject by WITH CHECK.
--   Arms (13)-(15): trigger broadening — closes the same-brand
--                   role-escalation chain (Row J of spec Q1).
--     (13)  brand-admin promoting same-brand other user to
--            super_admin → REJECT by trigger
--            ('role changes require super_admin').
--     (14)  brand-admin transferring same-brand other user's
--            brand_id to foreign brand → reject by WITH CHECK
--            (sanity arm — confirms the policy clause closes
--            cross-user brand transfers).
--     (15)  super_admin promoting another user to super_admin
--            → admit (positive control — trigger does not
--            over-block).
--
-- Fixture strategy:
--   - Mirror Spec 041's pgTAP: seed admin (brand A, 11111…),
--     seed manager (brand A, role='user', 22222…), seed master
--     (brand A, 33333… — promoted to super_admin mid-txn). Plus
--     two test-only IDs: a foreign brand, a foreign store, a
--     foreign profile, and a synthetic order_schedule row in the
--     foreign store.
--   - All fixtures roll back at the end of the test transaction.
--
-- JWT-impersonation pattern copied from
-- auth_can_see_store_brand_scope.test.sql — set local role
-- authenticated, set_config('request.jwt.claims', …, true).
--
-- Hermetic isolation: begin; … rollback;. The seed brand list,
-- store list, profiles, order_schedule, and user_stores rows
-- are all restored on rollback.

begin;
create extension if not exists pgtap;

select plan(15);


-- ─── fixtures (constants stashed via set_config) ───────────────
do $$
declare
  v_admin_id    uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_manager_id  uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', brand A)
  v_master_id   uuid := '33333333-3333-3333-3333-333333333333';  -- seed master (brand A) — promoted to super_admin mid-txn
  v_brand_a     uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b     uuid := 'b2000000-0000-0000-0000-000000000001';  -- test-only foreign brand
  v_store_towson uuid := '00000000-0000-0000-0000-000000000001'; -- seed Towson (brand A)
  v_store_b     uuid := 'b2000001-0000-0000-0000-000000000001';  -- test-only foreign-brand store
  v_vendor_a    uuid := 'b1ee724a-8626-45ab-85d4-14a99e7cbc45';  -- seed BJs (brand A)
  -- A synthetic in-brand-A user that the brand-admin will attempt
  -- to manipulate. Distinct from the seed manager so arms that
  -- mutate this row don't interfere with the spec 041 fixtures.
  v_target_a    uuid := 'aaaaa042-0000-0000-0000-000000000001';
  -- A synthetic in-brand-B user — target for the cross-brand
  -- reject arms.
  v_target_b    uuid := 'bbbbb042-0000-0000-0000-000000000001';
  -- Synthetic auth.users rows so the profiles FK to auth.users is
  -- satisfied. (profiles.id references auth.users.id.) Created
  -- below.
  -- order_schedule rows for arms 1-7. Created below.
  v_os_a        uuid := 'aaaa0042-0000-0000-0000-000000000001';
  v_os_b        uuid := 'bbbb0042-0000-0000-0000-000000000001';
begin
  perform set_config('test.admin_id',     v_admin_id::text,     true);
  perform set_config('test.manager_id',   v_manager_id::text,   true);
  perform set_config('test.master_id',    v_master_id::text,    true);
  perform set_config('test.brand_a',      v_brand_a::text,      true);
  perform set_config('test.brand_b',      v_brand_b::text,      true);
  perform set_config('test.store_towson', v_store_towson::text, true);
  perform set_config('test.store_b',      v_store_b::text,      true);
  perform set_config('test.vendor_a',     v_vendor_a::text,     true);
  perform set_config('test.target_a',     v_target_a::text,     true);
  perform set_config('test.target_b',     v_target_b::text,     true);
  perform set_config('test.os_a',         v_os_a::text,         true);
  perform set_config('test.os_b',         v_os_b::text,         true);
end $$;


-- Insert the test-only foreign brand and foreign store. Both are
-- scoped to this transaction.
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 042)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (
  current_setting('test.store_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Store (test 042)',
  '1 Foreign Way',
  'active',
  '22:00'
)
on conflict (id) do nothing;


-- Insert synthetic auth.users rows so the profiles FK is satisfied.
-- Match the seed.sql shape (auth.users requires many NOT NULL columns
-- — confirmation_token et al). Idempotent.
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
   'target-a-042@local.test', '',
   now(), now(), now(),
   jsonb_build_object('provider','email','providers',array['email'],'role','user'),
   '{}'::jsonb, false, false,
   '','','','','','','',''),
  (current_setting('test.target_b', true)::uuid,
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'target-b-042@local.test', '',
   now(), now(), now(),
   jsonb_build_object('provider','email','providers',array['email'],'role','user'),
   '{}'::jsonb, false, false,
   '','','','','','','','')
on conflict (id) do nothing;


-- Insert synthetic profiles (one per brand). Both role='user' so
-- the profiles_role_brand_consistent CHECK passes with brand_id
-- non-null.
insert into public.profiles (id, name, role, initials, color, status, brand_id)
values
  (current_setting('test.target_a', true)::uuid,
   'Target A (test 042)', 'user', 'TA', '#888888', 'active',
   current_setting('test.brand_a', true)::uuid),
  (current_setting('test.target_b', true)::uuid,
   'Target B (test 042)', 'user', 'TB', '#888888', 'active',
   current_setting('test.brand_b', true)::uuid)
on conflict (id) do nothing;


-- Insert a synthetic order_schedule row in the FOREIGN brand's
-- store. Arms (5)/(6) will attempt to UPDATE/DELETE it as the
-- brand-A admin and confirm 0 rows are affected. Arm (2) updates
-- an in-brand-A row; we'll create that under the brand-A admin in
-- arm (1) (test logic: arm 1 inserts → arm 2 updates → arm 3
-- deletes — chained per-row to avoid orphan fixtures).
insert into public.order_schedule (id, store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (
  current_setting('test.os_b', true)::uuid,
  current_setting('test.store_b', true)::uuid,
  'monday',
  null,
  'Foreign Brand Vendor (test 042)',
  'tuesday'
)
on conflict (id) do nothing;


-- ============================================================
-- Arms (1)-(7): order_schedule WRITE policy tightening
-- ============================================================

-- ─── Arm (1): brand-A admin INSERT in brand-A store — admit ──
-- JWT: app_metadata.role='admin', sub = seed admin (brand A).
-- The new policy admits because auth_is_privileged() is true and
-- auth_can_see_store(towson) returns true via the brand arm
-- (admin's profiles.brand_id matches stores.brand_id).
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

insert into public.order_schedule (id, store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (
  current_setting('test.os_a', true)::uuid,
  current_setting('test.store_towson', true)::uuid,
  'monday',
  current_setting('test.vendor_a', true)::uuid,
  'BJs',
  'tuesday'
);

select is(
  (select count(*)::int from public.order_schedule
    where id = current_setting('test.os_a', true)::uuid),
  1,
  'arm (1): brand-A admin can INSERT order_schedule in own-brand store'
);


-- ─── Arm (2): brand-A admin UPDATE in brand-A store — admit ──
-- JWT unchanged. Update the row inserted by arm (1). The new
-- policy admits via the same path.
update public.order_schedule
   set delivery_day = 'wednesday'
 where id = current_setting('test.os_a', true)::uuid;

select is(
  (select delivery_day from public.order_schedule
    where id = current_setting('test.os_a', true)::uuid),
  'wednesday',
  'arm (2): brand-A admin can UPDATE order_schedule in own-brand store'
);


-- ─── Arm (3): brand-A admin DELETE in brand-A store — admit ──
-- JWT unchanged. Delete the row inserted by arm (1) and updated
-- by arm (2). The new policy admits via the same path.
delete from public.order_schedule
 where id = current_setting('test.os_a', true)::uuid;

select is(
  (select count(*)::int from public.order_schedule
    where id = current_setting('test.os_a', true)::uuid),
  0,
  'arm (3): brand-A admin can DELETE order_schedule in own-brand store'
);


-- ─── Arm (4): brand-A admin INSERT in foreign brand — reject ─
-- JWT unchanged. INSERT a new row with store_id = foreign store.
-- The new policy WITH CHECK fails (auth_can_see_store returns
-- false for the foreign store, brand mismatch). PostgREST would
-- surface this as 42501; throws_ok asserts the SQLSTATE.
select throws_ok(
  format(
    $q$insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
       values (%L::uuid, 'tuesday', null, 'Foreign Vendor (test 042)', 'wednesday')$q$,
    current_setting('test.store_b', true)
  ),
  '42501',
  'new row violates row-level security policy for table "order_schedule"',
  'arm (4): brand-A admin INSERT in foreign-brand store is rejected by RLS WITH CHECK (42501)'
);


-- ─── Arm (5): brand-A admin UPDATE in foreign brand — 0 rows ─
-- JWT unchanged. UPDATE the pre-existing foreign-brand row.
-- Postgres RLS semantics: UPDATEs that fail USING evaluate to
-- "no row matched" — silently affects 0 rows, no error. (Per the
-- spec §3 behaviour matrix.)
--
-- Verification flips to postgres-role (RLS bypass) because the
-- brand-A admin cannot SELECT the foreign-brand row to inspect
-- its state — the "Store members can read order_schedule" policy
-- gates SELECT on the same auth_can_see_store(store_id) check
-- that gates writes. We clear request.jwt.claims so `reset role`
-- truly lands us at `current_user = 'postgres'`, which falls outside
-- the round-4 trigger's allowlist (`current_user IN ('authenticated',
-- 'anon')`) and thus exempts any incidental profile UPDATEs from
-- firing the cross-user role-change branch.
update public.order_schedule
   set delivery_day = 'foreign-day-tamper'
 where id = current_setting('test.os_b', true)::uuid;

reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select delivery_day from public.order_schedule
    where id = current_setting('test.os_b', true)::uuid),
  'tuesday',  -- unchanged from the original insert
  'arm (5): brand-A admin UPDATE on foreign-brand order_schedule silently affects 0 rows (RLS USING)'
);


-- ─── Arm (6): brand-A admin DELETE in foreign brand — 0 rows ─
-- Re-impersonate the brand-A admin (claims cleared by arm 5's
-- verification step). DELETE the pre-existing foreign-brand row.
-- Same Postgres RLS semantics: USING-failed DELETE silently
-- affects 0 rows. Verification again flips back to postgres-role
-- to inspect the table state.
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

delete from public.order_schedule
 where id = current_setting('test.os_b', true)::uuid;

reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select count(*)::int from public.order_schedule
    where id = current_setting('test.os_b', true)::uuid),
  1,  -- row still exists; DELETE silently affected 0 rows
  'arm (6): brand-A admin DELETE on foreign-brand order_schedule silently affects 0 rows (RLS USING)'
);


-- ─── Arm (7): super_admin INSERT in foreign brand — admit ────
-- Promote the seed master to super_admin (brand_id = NULL per
-- profiles_role_brand_consistent CHECK) mid-transaction. Same
-- pattern as auth_can_see_store_brand_scope.test.sql arm (3),
-- but with claims explicitly cleared before the postgres-role
-- UPDATE. This is the architect's recommended pattern (§13 of
-- the spec): pgTAP tests that promote roles mid-txn under
-- postgres-role should clear request.jwt.claims so the
-- `reset role` truly lands at `current_user = 'postgres'`, which
-- falls outside the round-4 trigger's allowlist (`current_user IN
-- ('authenticated', 'anon')`) and exempts the fixture UPDATE from
-- the cross-user role-change branch. Then impersonate the new
-- super_admin and INSERT into the foreign-brand store. The new
-- policy admits because auth_is_privileged() (super-admin is
-- privileged) and
-- auth_can_see_store short-circuits on auth_is_super_admin()
-- returning true.
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

insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (
  current_setting('test.store_b', true)::uuid,
  'thursday',
  null,
  'SuperAdmin Cross-Brand Vendor (test 042)',
  'friday'
);

select is(
  (select count(*)::int from public.order_schedule
    where store_id = current_setting('test.store_b', true)::uuid
      and day_of_week = 'thursday'),
  1,
  'arm (7): super_admin can INSERT order_schedule in any brand (auth_is_super_admin short-circuit)'
);


-- ============================================================
-- Arms (8)-(12): profiles policy tightenings
-- ============================================================

-- ─── Arm (8): brand-A admin UPDATE same-brand other user — admit
-- Reset role + re-impersonate the seed admin (brand A admin).
-- UPDATE the target_a synthetic user's `name` column. The new
-- "Admins can update any profile" policy admits via the admin
-- arm: auth_is_privileged() AND auth_can_see_brand(brand_id of
-- target_a = brand A) both pass.
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

update public.profiles
   set name = 'Target A (renamed by brand-A admin)'
 where id = current_setting('test.target_a', true)::uuid;

select is(
  (select name from public.profiles
    where id = current_setting('test.target_a', true)::uuid),
  'Target A (renamed by brand-A admin)',
  'arm (8): brand-A admin can UPDATE same-brand other user profile (admin arm + brand match)'
);


-- ─── Arm (9): brand-A admin UPDATE cross-brand user — 0 rows ─
-- JWT unchanged. UPDATE target_b's `name`. The admin arm's brand
-- check fails (target_b.brand_id != admin.brand_id), the
-- self-arm fails (id != auth.uid()). Postgres RLS surfaces this
-- as 0 rows affected — no error, just silent rejection.
update public.profiles
   set name = 'Target B (tampered by cross-brand admin)'
 where id = current_setting('test.target_b', true)::uuid;

select is(
  (select name from public.profiles
    where id = current_setting('test.target_b', true)::uuid),
  'Target B (test 042)',  -- unchanged from the original insert
  'arm (9): brand-A admin UPDATE on cross-brand profile silently affects 0 rows (RLS USING)'
);


-- ─── Arm (10): super_admin UPDATE cross-brand user — admit ───
-- Re-impersonate the in-txn super_admin (master_id). UPDATE
-- target_b's `name`. The tightened admin policy admits via
-- auth_can_see_brand short-circuiting on auth_is_super_admin().
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
   set name = 'Target B (renamed by super_admin)'
 where id = current_setting('test.target_b', true)::uuid;

select is(
  (select name from public.profiles
    where id = current_setting('test.target_b', true)::uuid),
  'Target B (renamed by super_admin)',
  'arm (10): super_admin can UPDATE cross-brand profile (auth_can_see_brand super-admin short-circuit)'
);


-- ─── Arm (11): regular user self-UPDATE — admit (no-regression)
-- Impersonate the seed manager (role='user', brand A). UPDATE
-- their own dark_mode column. Both policies admit:
--   "Admins can update any profile" via the self-arm (id =
--     auth.uid()).
--   "Users can update own profile" via the USING/WITH CHECK
--     (id = auth.uid()).
-- The new WITH CHECK on "Users can update own profile" must not
-- regress this legitimate case.
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
   set dark_mode = true
 where id = current_setting('test.manager_id', true)::uuid;

select is(
  (select dark_mode from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  true,
  'arm (11): regular user can UPDATE own profile under the WITH CHECK-armed policy (no-regression)'
);


-- ─── Arm (12): regular user row-key forgery — reject ─────────
-- JWT unchanged. Attempt UPDATE … SET id = <other-uuid> on the
-- manager's own row. USING passes (OLD.id = auth.uid()). WITH
-- CHECK fails (NEW.id != auth.uid()) on BOTH policies — the
-- self-policy and the admin policy's self-arm. PostgREST
-- surfaces as 42501.
--
-- Defense-in-depth: today's PostgREST does not produce client
-- requests that mutate `id`, but a future client or an
-- adversarial PATCH /rest/v1/profiles?id=eq.<self> with `{ "id":
-- "<other-uuid>" }` body would land here. The WITH CHECK closes
-- the structural gap.
select throws_ok(
  format(
    $q$update public.profiles
         set id = %L::uuid
       where id = %L::uuid$q$,
    current_setting('test.target_a', true),
    current_setting('test.manager_id', true)
  ),
  '42501',
  'new row violates row-level security policy for table "profiles"',
  'arm (12): regular user UPDATE … SET id = <other-uuid> is rejected by WITH CHECK (row-key forgery defense)'
);


-- ============================================================
-- Arms (13)-(15): trigger broadening — closes the same-brand
--                 role-escalation chain (Row J of spec Q1).
-- ============================================================

-- ─── Arm (13): brand-A admin promotes same-brand user to
--               super_admin — REJECT by trigger
--
-- This is the **core security-fix arm for the trigger
-- broadening**. Pre-042 the brand-A admin could PATCH
-- target_a.role to 'super_admin' (target_a is brand A, the
-- tightened admin policy admits because auth_can_see_brand
-- passes, and the original Spec 041 trigger only fired on
-- self-edits where old.id = auth.uid()). The Spec 042 trigger
-- extension fires on cross-user edits too, with the distinct
-- message 'role changes require super_admin'.
--
-- Re-impersonate the seed admin (role='admin', brand A).
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
         set role = 'super_admin'
       where id = %L::uuid$q$,
    current_setting('test.target_a', true)
  ),
  'P0001',
  'role changes require super_admin',
  'arm (13): brand-A admin promoting same-brand other user to super_admin is rejected by trigger (closes Row J)'
);


-- ─── Arm (14): brand-A admin transfers same-brand user's
--               brand_id to foreign brand — reject by WITH CHECK
--
-- Sanity arm. The brand_id transfer is blocked by the new
-- WITH CHECK on "Admins can update any profile": NEW.brand_id =
-- foreign brand, admin is in brand A, the auth_can_see_brand
-- arm of the WITH CHECK fails. PostgREST surfaces as 42501.
-- (The trigger would NOT catch this — brand_id cross-user
-- transfers are deliberately deferred to the WITH CHECK + row
-- CHECK layers, per spec §10 step 4 commentary.)
select throws_ok(
  format(
    $q$update public.profiles
         set brand_id = %L::uuid
       where id = %L::uuid$q$,
    current_setting('test.brand_b', true),
    current_setting('test.target_a', true)
  ),
  '42501',
  'new row violates row-level security policy for table "profiles"',
  'arm (14): brand-A admin transferring same-brand user brand_id to foreign brand is rejected by WITH CHECK'
);


-- ─── Arm (15): super_admin promotes another user to
--               super_admin — admit (positive control)
--
-- The trigger MUST NOT over-block. Super_admin is the legitimate
-- path for cross-user role changes. Re-impersonate the in-txn
-- super_admin (master_id). UPDATE target_a's role to
-- 'super_admin'. Because role='super_admin' requires
-- brand_id=NULL per profiles_role_brand_consistent, set both in
-- a single statement to avoid CHECK violation.
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
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.target_a', true)::uuid;

select is(
  (select role from public.profiles
    where id = current_setting('test.target_a', true)::uuid),
  'super_admin',
  'arm (15): super_admin can promote another user to super_admin (trigger does not over-block)'
);


select * from finish();
rollback;

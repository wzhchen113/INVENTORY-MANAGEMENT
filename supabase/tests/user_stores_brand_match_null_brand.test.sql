-- supabase/tests/user_stores_brand_match_null_brand.test.sql
--
-- Spec 068 §4 / §12.3 — pgTAP regression for the NULL-brand tightening of the
-- public.user_stores_brand_match() BEFORE-INSERT/UPDATE trigger shipped in
-- supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql.
--
-- The original trigger (20260509000000_multi_brand_schema_rls.sql:357-387)
-- SKIPPED its cross-brand check when the assigned user's profiles.brand_id was
-- NULL (`if v_user_brand is null then return new;`). That NULL state is exactly
-- what the staff (role='user') invite→register path produces, so a NULL-brand
-- user could be granted user_stores rows spanning multiple brands unchallenged.
-- The new body keeps the non-NULL path byte-for-byte and tightens ONLY the
-- NULL branch: a NULL-brand user may hold multiple grants, but all within a
-- SINGLE brand.
--
-- plan(7). Arms:
--   (fixture) the test user really is brand_id NULL                 → IS NULL
--   (1) non-NULL-brand user, cross-brand store  → RAISES  (regression: old behavior preserved)
--   (2) non-NULL-brand user, same-brand store   → SUCCEEDS (regression: old behavior preserved)
--   (3) NULL-brand user, FIRST grant (brand A)  → SUCCEEDS (assignment defines the brand)
--   (4) NULL-brand user, SECOND grant same brand→ SUCCEEDS (single-brand multi-store staff)
--   (5) NULL-brand user, SECOND grant brand B   → RAISES   (THE NEW GUARD — old behavior ALLOWED this)
--   (6) NULL-brand user, no-op UPDATE of the brand-A row → SUCCEEDS (no self-conflict on UPDATE)
--
-- Arm (5) is the AC "previously-allowed-then-now-blocked" arm: under the OLD
-- function body this exact INSERT succeeded (the NULL branch returned NEW
-- unconditionally); under the new body it is rejected. The OLD-behavior claim
-- is documented in the arm-(5) comment below.
--
-- throws_ok uses the 4-arg form with a NULL expected-message: this asserts the
-- SQLSTATE (P0001) WITHOUT pinning the exact raise text, per spec 068 §12.3
-- ("assert on the raise occurring, not exact text"). The 3-arg form is NOT used
-- because pgTAP would interpret a P0001-looking 2nd arg + a 3rd arg as
-- (errcode, expected_message) and treat our description AS the expected text.
--
-- Fixture strategy mirrors auth_can_see_store_brand_scope.test.sql:74-91 — a
-- second brand row + a brand-B store are inserted inside the hermetic
-- begin/rollback and torn down on rollback. We create TWO fresh profiles in-txn
-- rather than leaning on seed rows:
--   * a NULL-brand role='user' profile — the seed's Tara Manager carries a
--     non-NULL brand_id (seed.sql:118-120) so she does NOT exercise the NULL
--     branch; we need a genuinely NULL-brand user.
--   * a non-NULL brand-A role='admin' profile with NO pre-existing user_stores
--     grants — the seed admin already holds ALL four brand-A stores, leaving no
--     spare store for a clean INSERT; a fresh admin keeps arms (1)/(2)
--     self-contained and order-independent.
-- The user_stores INSERTs run under the default postgres superuser role (RLS
-- bypass): the trigger fires for every role, so this isolates the TRIGGER
-- behavior from the user_stores RLS policy stack — same rationale as
-- auth_can_see_store_brand_scope.test.sql arm (12).
--
-- Hermetic isolation: begin; … rollback;. All fixture rows are restored on
-- rollback; the 286 KB seed is untouched.

begin;
create extension if not exists pgtap;

select plan(7);

-- ─── fixtures (constants stashed via set_config) ───────────────
do $$
declare
  v_brand_a       uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b       uuid := 'b1000000-0000-0000-0000-000000000001';  -- test-only brand
  v_store_towson  uuid := '00000000-0000-0000-0000-000000000001';  -- seed Towson (brand A)
  v_store_charles uuid := '1ea549bb-8b50-4078-9301-479311d9fdec';  -- seed Charles (brand A)
  v_store_b       uuid := 'b1000001-0000-0000-0000-000000000001';  -- test-only foreign-brand store
  v_nullbrand_id  uuid := 'c0000000-0000-0000-0000-0000000000aa';  -- test-only NULL-brand 'user' profile
  v_admin_a_id    uuid := 'c0000000-0000-0000-0000-0000000000bb';  -- test-only brand-A 'admin' profile (no grants)
begin
  perform set_config('test.brand_a',       v_brand_a::text,       true);
  perform set_config('test.brand_b',       v_brand_b::text,       true);
  perform set_config('test.store_towson',  v_store_towson::text,  true);
  perform set_config('test.store_charles', v_store_charles::text, true);
  perform set_config('test.store_b',       v_store_b::text,       true);
  perform set_config('test.nullbrand_id',  v_nullbrand_id::text,  true);
  perform set_config('test.admin_a_id',    v_admin_a_id::text,    true);
end $$;

-- Test-only foreign brand + a store inside it (same shape as
-- auth_can_see_store_brand_scope.test.sql:78-91).
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 068)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (
  current_setting('test.store_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Store (test 068)',
  '1 Foreign Way',
  'active',
  '22:00'
)
on conflict (id) do nothing;

-- Backing auth.users rows for the two test profiles (profiles.id FKs to
-- auth.users(id)). Minimal columns; mirrors the seed's auth.users inserts.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values
  (current_setting('test.nullbrand_id', true)::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'nullbrand-068@local.test', now(), now()),
  (current_setting('test.admin_a_id', true)::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin-a-068@local.test', now(), now())
on conflict (id) do nothing;

-- A role='user' profile with brand_id NULL — the exact state the invite flow
-- produces for staff and the case the original trigger left unguarded.
insert into public.profiles (id, name, role, status, brand_id)
values (
  current_setting('test.nullbrand_id', true)::uuid,
  'Null Brand Staff (test 068)',
  'user',
  'active',
  null
)
on conflict (id) do nothing;

-- A role='admin' profile scoped to brand A with NO user_stores grants, for the
-- non-NULL regression arms (1)/(2).
insert into public.profiles (id, name, role, status, brand_id)
values (
  current_setting('test.admin_a_id', true)::uuid,
  'Brand A Admin (test 068)',
  'admin',
  'active',
  current_setting('test.brand_a', true)::uuid
)
on conflict (id) do nothing;

-- Sanity: confirm the fixture user really is NULL-brand (guards against a
-- future profiles_role_brand_consistent change silently backfilling it).
select is(
  (select brand_id from public.profiles
    where id = current_setting('test.nullbrand_id', true)::uuid),
  null,
  'fixture: test user has brand_id NULL (exercises the trigger NULL branch)'
);


-- ─── Arm (1): non-NULL-brand user, cross-brand store → RAISES ──
-- Regression: the original non-NULL path must be preserved byte-for-byte. The
-- brand-A admin assigned the foreign brand-B store must still be rejected.
-- Assert on the raise occurring (errcode P0001), not the exact message text.
select throws_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (%L::uuid, %L::uuid)$q$,
    current_setting('test.admin_a_id', true),
    current_setting('test.store_b', true)
  ),
  'P0001',
  null,
  'arm (1): non-NULL-brand user assigned a cross-brand store is rejected (non-NULL path unchanged)'
);


-- ─── Arm (2): non-NULL-brand user, same-brand store → SUCCEEDS ─
-- Regression positive control: a brand-A admin assigned a brand-A store
-- (Towson) inserts cleanly. The fresh fixture admin has no pre-existing grants,
-- so there is no PK collision; the row is rolled back with the txn.
select lives_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (%L::uuid, %L::uuid)$q$,
    current_setting('test.admin_a_id', true),
    current_setting('test.store_towson', true)
  ),
  'arm (2): non-NULL-brand user assigned a same-brand store succeeds (non-NULL path unchanged)'
);


-- ─── Arm (3): NULL-brand user, FIRST grant (brand A) → SUCCEEDS ─
-- The assignment itself defines the brand. With no pre-existing grant there is
-- nothing to conflict with, so the first row passes — a NULL-brand staff user
-- is legitimately allowed stores within ONE brand.
select lives_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (%L::uuid, %L::uuid)$q$,
    current_setting('test.nullbrand_id', true),
    current_setting('test.store_towson', true)
  ),
  'arm (3): NULL-brand user FIRST grant (brand A) succeeds (assignment defines the brand)'
);


-- ─── Arm (4): NULL-brand user, SECOND grant same brand → SUCCEEDS ─
-- Same NULL-brand user, a SECOND brand-A store (Charles). All existing grants
-- resolve to brand A and so does this one → single-brand multi-store staff
-- assignment still works.
select lives_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (%L::uuid, %L::uuid)$q$,
    current_setting('test.nullbrand_id', true),
    current_setting('test.store_charles', true)
  ),
  'arm (4): NULL-brand user SECOND grant within the same brand succeeds (single-brand multi-store)'
);


-- ─── Arm (5): NULL-brand user, SECOND grant DIFFERENT brand → RAISES ─
-- THE NEW GUARD + the AC "previously-allowed-then-now-blocked" arm.
--
-- Under the OLD trigger body (20260509000000_…:372-374), the NULL branch was
-- `if v_user_brand is null then return new;` — an UNCONDITIONAL pass. This
-- exact INSERT (the NULL-brand user already holds brand-A grants from arms 3-4,
-- now assigned the brand-B store) WOULD HAVE SUCCEEDED under that body, writing
-- a cross-brand user_stores row. Under the new body it is REJECTED because the
-- user already holds a grant whose store brand (A) differs from this row's
-- store brand (B). Assert on the raise occurring (P0001), not exact text.
select throws_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (%L::uuid, %L::uuid)$q$,
    current_setting('test.nullbrand_id', true),
    current_setting('test.store_b', true)
  ),
  'P0001',
  null,
  'arm (5): NULL-brand user SECOND grant in a DIFFERENT brand is rejected (NEW guard; OLD body allowed it)'
);


-- ─── Arm (6): NULL-brand user, no-op UPDATE of an existing row → SUCCEEDS ─
-- The trigger also fires on UPDATE. Re-asserting an existing (user, store) pair
-- must not self-conflict: the conflict lookup excludes the row being mutated by
-- store_id, so a no-op UPDATE of the brand-A Towson grant still passes.
select lives_ok(
  format(
    $q$update public.user_stores set store_id = %L::uuid
        where user_id = %L::uuid and store_id = %L::uuid$q$,
    current_setting('test.store_towson', true),
    current_setting('test.nullbrand_id', true),
    current_setting('test.store_towson', true)
  ),
  'arm (6): NULL-brand user no-op UPDATE of an existing same-brand grant succeeds (no self-conflict)'
);


select * from finish();
rollback;

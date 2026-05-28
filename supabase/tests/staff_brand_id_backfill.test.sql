-- supabase/tests/staff_brand_id_backfill.test.sql
--
-- Spec 069 — pgTAP coverage for the NULL-brand-staff catalog read fix
-- (Option A: backfill profiles.brand_id + get_pending_invitation widen).
--
-- THE BUG (spec 069): a role='user' staff user with profiles.brand_id = NULL
-- who is a user_stores member of a 2AM store cannot read catalog_ingredients /
-- vendors for that brand, because the brand_member_read_* SELECT policies gate
-- on auth_can_see_brand(brand_id), which checks profiles.brand_id (NULL = 2AM is
-- never true). The EOD screen's embedded catalog:catalog_ingredients(name,unit)
-- and vendor:vendors(id,name) therefore return null and ingredient names render
-- blank. Option A gives staff a brand_id (backfill + invite-flow stamp) so
-- auth_can_see_brand works uniformly for them.
--
-- Fixture strategy (copied from auth_can_see_store_brand_scope.test.sql +
-- staff_role_eod_rls.test.sql):
--   * The seed has a single brand ('2a000000-…-0001' = brand A, "2AM PROJECT")
--     and four brand-A stores. To exercise cross-brand isolation we insert a
--     second brand B + a brand-B store + a brand-B catalog_ingredients row +
--     a brand-B vendor, all inside the hermetic begin/rollback.
--   * The NULL-brand staff fixture: take the seed manager
--     ('22222222-…' role='user', user_stores for Towson + Frederick), and set
--     brand_id = NULL inside the txn (the seed gives it brand A — a seed-author
--     choice — but the production invite flow emits NULL, which is the path this
--     test must exercise; see spec 069 §"The asymmetry"). The manager has NO
--     user_stores grant for any brand-B store.
--   * JWT impersonation via set local role authenticated +
--     set_config('request.jwt.claims', …, true) — same as the reference files.
--
-- Hermetic isolation: begin; … rollback;. The second brand, brand-B store /
-- catalog / vendor, profiles.brand_id mutation, and any inserted invitation are
-- all restored on rollback.
--
-- Arms (plan(13)):
--   (1)  NULL-brand staff CANNOT read brand-A catalog (pre-fix proof):
--        auth_can_see_brand(A) = FALSE and the catalog SELECT returns 0 rows.
--   (2)  After fix (brand_id = A, simulating the backfill) NULL-brand-then-fixed
--        staff CAN read brand-A catalog: auth_can_see_brand(A) = TRUE and the
--        catalog SELECT returns > 0 rows. THE CORE BUG FIX.
--   (3)  Cross-brand isolation preserved: the fixed staff user reading brand-B
--        catalog returns 0 rows / auth_can_see_brand(B) = FALSE (no store in
--        brand B → no access). No over-broadening.
--   (4)  Staff STILL CANNOT write catalog_ingredients (privileged-only
--        preserved): INSERT into catalog_ingredients for brand A is RLS-denied
--        (42501) — proves the fix did not leak write access.
--   (5)  The vendors embed class is fixed too: vendors SELECT for brand A
--        returns > 0 rows for the fixed staff user (closes the latent
--        fallback-masked vendors embed).
--   (6)  EOD embed integration-style: the actual EOD join shape
--        (inventory_items ⋈ catalog_ingredients ON catalog_id) for a brand-A
--        store under the staff JWT returns NON-NULL catalog name for every row
--        — proves the embedded join resolves, not just the bare table SELECT.
--        THE LITERAL BUG.
--   (7)  Brand-A admin still sees 0 brand-B catalog AND 0 brand-B vendors
--        (spec-012a isolation regression guard, probes 1–7 of 20260509000000).
--   (8)  get_pending_invitation returns the correct resolved_brand_id for a
--        staff invite (brand_id NULL, store_ids=[brand-A store] → brand A).
--   (9)  get_pending_invitation passes brand_id straight through (resolved ==
--        brand_id) for an admin invite — admin path unchanged.
--   (10) Backfill correctness: a NULL-brand role='user' profile with a single
--        brand-A user_stores grant, after the backfill UPDATE, has brand_id = A.
--   (11) Zero NULL-brand-staff-with-stores remain (post-backfill invariant):
--        count of the offending shape == 0 (duplicates the migration's own
--        post-backfill RAISE EXCEPTION guard at test level).
--   (12) Zero-store staff are skipped, not errored: a NULL-brand role='user'
--        profile with NO user_stores rows is left NULL by the backfill logic
--        (and the backfill does not fail) — matches the §3a flagging design.
--   (13) get_pending_invitation resolved_brand_id is NULL for a staff invite
--        with zero store_ids and NULL brand_id (benign no-op, matches §4).

begin;
create extension if not exists pgtap;

select plan(14);

-- ─── fixtures (constants stashed via set_config) ───────────────
do $$
declare
  v_admin_id      uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_manager_id    uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user')
  v_brand_a       uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b       uuid := 'b1000000-0000-0000-0000-000000000001';  -- test-only brand
  v_store_towson  uuid := '00000000-0000-0000-0000-000000000001';  -- seed Towson (brand A; manager HAS grant)
  v_store_b       uuid := 'b1000001-0000-0000-0000-000000000001';  -- test-only foreign-brand store
  v_cat_b         uuid := 'b1000002-0000-0000-0000-000000000001';  -- test-only brand-B catalog ingredient
  v_vendor_b      uuid := 'b1000003-0000-0000-0000-000000000001';  -- test-only brand-B vendor
begin
  perform set_config('test.admin_id',     v_admin_id::text,     true);
  perform set_config('test.manager_id',   v_manager_id::text,   true);
  perform set_config('test.brand_a',      v_brand_a::text,      true);
  perform set_config('test.brand_b',      v_brand_b::text,      true);
  perform set_config('test.store_towson', v_store_towson::text, true);
  perform set_config('test.store_b',      v_store_b::text,      true);
  perform set_config('test.cat_b',        v_cat_b::text,        true);
  perform set_config('test.vendor_b',     v_vendor_b::text,     true);
end $$;

-- Second brand B + a brand-B store + a brand-B catalog row + a brand-B vendor,
-- all under the postgres role (no RLS for the superuser). All scoped to this
-- transaction.
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 069)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (
  current_setting('test.store_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Store (test 069)',
  '1 Foreign Way',
  'active',
  '22:00'
)
on conflict (id) do nothing;

insert into public.catalog_ingredients (id, brand_id, name, unit)
values (
  current_setting('test.cat_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Catalog Item (test 069)',
  'lbs'
)
on conflict (id) do nothing;

insert into public.vendors (id, brand_id, name)
values (
  current_setting('test.vendor_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Vendor (test 069)'
)
on conflict (id) do nothing;

-- ─── Arm (0): migration's WHERE brand_id IS NULL guard spares branded staff ─
-- The backfill migration ran during `db reset` (before this txn). The seed
-- manager carries brand A, so the migration's `where brand_id is null` predicate
-- must have SKIPPED them — i.e. their brand_id is still brand A here, NOT nulled
-- or rewritten. Asserts the guard's no-op-on-branded-staff behavior (closes the
-- test-engineer's minor #3; partial mitigation of the migration-DO-block coverage
-- gap). Run as postgres — pure data check, no impersonation.
select is(
  (select brand_id from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  current_setting('test.brand_a', true)::uuid,
  'arm (0): backfill migration left the already-branded seed manager untouched (WHERE brand_id IS NULL guard)'
);

-- Put the seed manager into the production NULL-brand staff state. The seed
-- sets brand_id = brand A; the invite flow emits NULL. This is the path the bug
-- lives on, so we reproduce it inside the txn.
update public.profiles
   set brand_id = null
 where id = current_setting('test.manager_id', true)::uuid;


-- ─── Arm (1): NULL-brand staff CANNOT read brand-A catalog (pre-fix) ─
-- Impersonate the staff user with brand_id = NULL. auth_can_see_brand(A) is
-- FALSE (NULL = A never true, not a super_admin), and the catalog SELECT
-- returns 0 rows. Establishes the bug exists before the fix is applied.
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

-- Self-contained pre-fix proof: BOTH the helper returns false AND the catalog
-- SELECT is RLS-filtered to 0 rows for the NULL-brand staff caller (the literal
-- blank-names bug). Previously the row-count half lived only in arm (2)'s
-- post-fix assertion; folding it here makes arm (1) a complete standalone proof.
select ok(
  not public.auth_can_see_brand(current_setting('test.brand_a', true)::uuid)
    and (
      select count(*) = 0
        from public.catalog_ingredients
       where brand_id = current_setting('test.brand_a', true)::uuid
    ),
  'arm (1): NULL-brand staff cannot see brand A — auth_can_see_brand false AND catalog SELECT returns 0 rows (pre-fix proof)'
);


-- ─── Arm (2): after fix, staff CAN read brand-A catalog (THE FIX) ─
-- Set the staff user's brand_id = brand A (simulating the backfill / invite-flow
-- stamp), re-impersonate, and assert auth_can_see_brand(A) is TRUE and the
-- brand-A catalog SELECT returns > 0 rows.
--
-- IMPORTANT: clear request.jwt.claims to '{}' BEFORE the postgres-role UPDATE so
-- auth.uid() is NULL during the mutation. The profiles_self_brand_lock trigger
-- (assert_brand_id_immutable_for_self) blocks a brand_id change whenever
-- old.id = auth.uid() REGARDLESS of current_user — so leaving the manager's JWT
-- claims set while editing their row would self-block. Setting NULL auth.uid()
-- mirrors exactly how the migration's backfill runs (migration role, auth.uid()
-- NULL — spec 069 §1b confirms the trigger does NOT block that path).
reset role;
select set_config('request.jwt.claims', '{}', true);
update public.profiles
   set brand_id = current_setting('test.brand_a', true)::uuid
 where id = current_setting('test.manager_id', true)::uuid;

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

select ok(
  public.auth_can_see_brand(current_setting('test.brand_a', true)::uuid)
    and (
      select count(*) > 0
        from public.catalog_ingredients
       where brand_id = current_setting('test.brand_a', true)::uuid
    ),
  'arm (2): brand-stamped staff CAN read brand-A catalog_ingredients (the core bug fix)'
);


-- ─── Arm (3): cross-brand isolation preserved (no over-broadening) ─
-- The fixed staff user (brand_id = brand A) reading brand-B catalog returns 0
-- rows and auth_can_see_brand(B) is FALSE — they have no store in brand B.
select ok(
  not public.auth_can_see_brand(current_setting('test.brand_b', true)::uuid)
    and (
      select count(*) = 0
        from public.catalog_ingredients
       where brand_id = current_setting('test.brand_b', true)::uuid
    ),
  'arm (3): brand-A staff CANNOT read brand-B catalog (cross-brand isolation preserved)'
);


-- ─── Arm (4): staff STILL CANNOT write catalog_ingredients ─────
-- The privileged_* write policies gate on auth_is_privileged(), which is FALSE
-- for role='user'. Giving staff a brand_id broadens READ only; the INSERT must
-- still be RLS-denied (42501). Mirrors arm (9) of staff_role_eod_rls.test.sql.
select throws_ok(
  format(
    $q$insert into public.catalog_ingredients (brand_id, name, unit)
        values (%L::uuid, 'Staff Write Attempt spec 069', 'lbs')$q$,
    current_setting('test.brand_a', true)
  ),
  '42501',
  null,
  'arm (4): staff cannot INSERT into catalog_ingredients (auth_is_privileged-gated write still denies)'
);


-- ─── Arm (5): the vendors embed class is fixed too ─────────────
-- vendors is also auth_can_see_brand-gated (brand_member_read_vendors). The
-- fixed staff user reading brand-A vendors returns > 0 rows — closes the latent
-- fallback-masked vendors embed.
select ok(
  (
    select count(*) > 0
      from public.vendors
     where brand_id = current_setting('test.brand_a', true)::uuid
  ),
  'arm (5): brand-stamped staff CAN read brand-A vendors (closes the latent vendors embed)'
);


-- ─── Arm (6): EOD embed integration-style (THE LITERAL BUG) ────
-- Run the actual EOD join shape: inventory_items ⋈ catalog_ingredients ON
-- catalog_id for a brand-A store (Towson, which the staff user has a grant for),
-- under the staff JWT. Assert every joined row has a NON-NULL catalog name —
-- proves the embedded join resolves (not just the bare table SELECT). At pgTAP
-- level this is the join returning non-null name; the PostgREST embed
-- nullability is covered by the §8 prod probe and EODCount.test.tsx mock.
--
-- Belt-and-braces: also assert at least one such row exists so a vacuous
-- "0 rows, 0 nulls" cannot pass the arm.
select ok(
  (
    -- at least one inventory_items row for Towson resolves to a catalog row
    select count(*) > 0
      from public.inventory_items i
      join public.catalog_ingredients ci on ci.id = i.catalog_id
     where i.store_id = current_setting('test.store_towson', true)::uuid
  )
  and (
    -- and ZERO of them have a NULL catalog name visible to the staff user
    select count(*) = 0
      from public.inventory_items i
      left join public.catalog_ingredients ci on ci.id = i.catalog_id
     where i.store_id = current_setting('test.store_towson', true)::uuid
       and ci.name is null
  ),
  'arm (6): EOD inventory_items ⋈ catalog_ingredients resolves non-null catalog name for the fixed staff user (the literal bug)'
);


-- ─── Arm (7): brand-A admin still sees 0 brand-B catalog + vendors ─
-- spec-012a isolation regression guard. Impersonate the seed admin (brand A,
-- JWT app_metadata.role='admin'). They must see ZERO brand-B catalog and ZERO
-- brand-B vendors — the isolation guarantee (012a probes 1–7) is intact, and
-- Option A did not touch it.
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

select ok(
  (
    select count(*) = 0
      from public.catalog_ingredients
     where brand_id = current_setting('test.brand_b', true)::uuid
  )
  and (
    select count(*) = 0
      from public.vendors
     where brand_id = current_setting('test.brand_b', true)::uuid
  ),
  'arm (7): brand-A admin sees 0 brand-B catalog AND 0 brand-B vendors (spec-012a isolation preserved)'
);

reset role;


-- ─── Arm (8): get_pending_invitation resolves the staff brand ──
-- Insert a staff invitation (brand_id NULL, store_ids = [brand-A Towson]) and
-- assert resolved_brand_id = brand A (derived server-side from store_ids[1]).
-- This is the durability half — registerInvitedUser stamps profiles.brand_id
-- from this value so new staff land WITH a brand.
insert into public.invitations
  (email, profile_id, name, role, store_ids, brand_id, used, expires_at)
values (
  'staff069pgtap@test.local',
  '00000000-0000-0000-0000-000000000000',
  'Staff 069 pgTAP',
  'user',
  array[current_setting('test.store_towson', true)],
  null,
  false,
  now() + interval '7 days'
);

select is(
  (select resolved_brand_id
     from public.get_pending_invitation('staff069pgtap@test.local')),
  current_setting('test.brand_a', true)::uuid,
  'arm (8): get_pending_invitation returns resolved_brand_id = store brand for a staff invite (brand_id NULL)'
);


-- ─── Arm (9): get_pending_invitation passes admin brand through ─
-- An admin invitation already carries brand_id; resolved_brand_id must equal it
-- (COALESCE short-circuits on the non-NULL brand_id). Admin path unchanged.
insert into public.invitations
  (email, profile_id, name, role, store_ids, brand_id, used, expires_at)
values (
  'admin069pgtap@test.local',
  '00000000-0000-0000-0000-000000000000',
  'Admin 069 pgTAP',
  'admin',
  array[current_setting('test.store_towson', true)],
  current_setting('test.brand_a', true)::uuid,
  false,
  now() + interval '7 days'
);

select is(
  (select resolved_brand_id
     from public.get_pending_invitation('admin069pgtap@test.local')),
  current_setting('test.brand_a', true)::uuid,
  'arm (9): get_pending_invitation resolved_brand_id == brand_id for an admin invite (admin path unchanged)'
);


-- ─── Arm (10): backfill correctness ────────────────────────────
-- Put the staff user back to NULL-brand, then run the migration's backfill
-- UPDATE logic verbatim, and assert the resulting brand_id = brand A (derived
-- from their single brand-A user_stores grant). Clear request.jwt.claims first
-- so auth.uid() is NULL during the mutations (mirrors the migration role; see
-- arm (2) note) — otherwise the self-brand-lock trigger would block the reset.
select set_config('request.jwt.claims', '{}', true);
update public.profiles
   set brand_id = null
 where id = current_setting('test.manager_id', true)::uuid;

update public.profiles p
   set brand_id = (
     select distinct s.brand_id
       from public.user_stores us
       join public.stores s on s.id = us.store_id
      where us.user_id = p.id
   )
 where p.role = 'user'
   and p.brand_id is null
   and exists (select 1 from public.user_stores us2 where us2.user_id = p.id);

select is(
  (select brand_id from public.profiles
    where id = current_setting('test.manager_id', true)::uuid),
  current_setting('test.brand_a', true)::uuid,
  'arm (10): backfill UPDATE sets a NULL-brand staff user''s brand_id to their single store brand'
);


-- ─── Arm (11): zero NULL-brand-staff-with-stores remain ────────
-- The AC / migration post-backfill invariant, asserted at test level.
select is(
  (
    select count(*)::bigint
      from public.profiles p
     where p.role = 'user'
       and p.brand_id is null
       and exists (select 1 from public.user_stores us where us.user_id = p.id)
  ),
  0::bigint,
  'arm (11): zero role=user profiles with a user_stores grant remain NULL-brand after backfill (post-backfill invariant)'
);


-- ─── Arm (12): zero-store staff are skipped, not errored ───────
-- Construct a NULL-brand role='user' profile with NO user_stores rows. Re-run
-- the backfill UPDATE; the row must be LEFT NULL (no store → no brand to
-- derive) and the UPDATE must not error. Matches the §3a NOTICE+skip design.
-- Insert a matching auth.users row first to satisfy the profiles → auth.users FK.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, is_anonymous)
values (
  '0b000000-0000-0000-0000-0000000000aa',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'zerostore069@test.local',
  now(), now(), false
)
on conflict (id) do nothing;

insert into public.profiles (id, name, role, initials, color, status, brand_id)
values ('0b000000-0000-0000-0000-0000000000aa', 'Zero Store 069', 'user', 'ZS', '#378ADD', 'active', null)
on conflict (id) do nothing;

update public.profiles p
   set brand_id = (
     select distinct s.brand_id
       from public.user_stores us
       join public.stores s on s.id = us.store_id
      where us.user_id = p.id
   )
 where p.role = 'user'
   and p.brand_id is null
   and exists (select 1 from public.user_stores us2 where us2.user_id = p.id);

select is(
  (select brand_id from public.profiles
    where id = '0b000000-0000-0000-0000-0000000000aa'),
  null::uuid,
  'arm (12): zero-store NULL-brand staff is left NULL by the backfill (skipped, not errored)'
);


-- ─── Arm (13): resolved_brand_id NULL for zero-store staff invite ─
-- A staff invite with zero store_ids AND NULL brand_id resolves to NULL —
-- the profile is created NULL-brand (constraint-legal for role='user'), a benign
-- no-op matching §4. Use an empty text[] for store_ids.
insert into public.invitations
  (email, profile_id, name, role, store_ids, brand_id, used, expires_at)
values (
  'staff069nostore@test.local',
  '00000000-0000-0000-0000-000000000000',
  'Staff 069 No Store',
  'user',
  array[]::text[],
  null,
  false,
  now() + interval '7 days'
);

select is(
  (select resolved_brand_id
     from public.get_pending_invitation('staff069nostore@test.local')),
  null::uuid,
  'arm (13): get_pending_invitation resolved_brand_id is NULL for a zero-store NULL-brand staff invite (benign no-op)'
);


select * from finish();
rollback;

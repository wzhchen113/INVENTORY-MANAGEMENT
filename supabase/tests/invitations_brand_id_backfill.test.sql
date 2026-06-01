-- supabase/tests/invitations_brand_id_backfill.test.sql
--
-- Spec 083 — pgTAP regression for the "(email not loaded)" fix on the REAL
-- loader (fetchAllUsers, via fetchInvitationsForUserLookup). Covers the
-- data-only backfill migration
-- supabase/migrations/20260531010000_invitations_brand_id_backfill.sql:
-- two mutually-exclusive UPDATE statements that fill invitations.brand_id
-- from the linked profile's brand (UPDATE #1 = profile_id join, UPDATE #2 =
-- name fallback with an exactly-one-distinct-brand guard).
--
-- THE BUG (spec 083): profiles has no email column; fetchAllUsers infers each
-- user's email from the invitations row that registered them. The lookup
-- query filtered invitations by `.eq('brand_id', brandId)` when a brand was
-- scoped. Two affected prod users (Bobby/Charles) carry invitations with
-- brand_id = NULL while their profiles carry a real brand, so the filter
-- dropped their invitation and the row rendered "(email not loaded)". The
-- backfill repairs the data so even a brand-scoped view resolves; the db.ts
-- half drops the filter for resilience (covered by the jest track).
--
-- Hermetic begin; … rollback; isolation — the seed has ZERO invitations
-- (spec 082 §0.2), so ALL fixtures are created in-txn. Reuses two seeded
-- users (11111… admin, 22222… manager; their profiles.id FK auth.users) and
-- the seed brand ('2a000000-…-0001'); a second brand ('b1000000-…') is
-- minted in-txn for the ambiguity arm, mirroring staff_brand_id_backfill.test.sql.
-- Constants are stashed via set_config — same idiom as
-- consume_invitation_sets_profile_id.test.sql.
--
-- DRIFT DISCIPLINE: this test executes the backfill UPDATEs INLINE (pgTAP
-- can't re-run a migration mid-transaction). Those inline copies MUST stay
-- BYTE-IDENTICAL to UPDATE #1 and UPDATE #2 in the migration's `do $$ … $$`
-- block — the same discipline CLAUDE.md applies to the escapeHtml mirrors and
-- spec 082 applies to its backfill copy. If the migration's predicate
-- changes, update this copy too.
--
-- NO grant / NO `set role anon` check: this migration changes no function and
-- no grant (data-only). Therefore NO has_function_privilege arm and
-- absolutely NO `set role anon` + throws_ok (the spec-067 pattern that
-- segfaults the CI Postgres image — explicitly avoided).
--
-- Six arms (plan(6) — a leading fixture-sanity assertion, then arms 2–6):
--   Arm 1 — fixture sanity (admin_id resolves from seed).
--   Arm 2 — UPDATE #1 (profile_id path) fills brand from the linked profile.
--           THE CORE INVARIANT (AC #1).
--   Arm 3 — NULL-brand profile → invitation left NULL (the p.brand_id is not
--           null guard; AC #3 accepted bootstrap gap).
--   Arm 4 — UPDATE #2 (name fallback, exactly-one) fills brand from a single
--           branded name match.
--   Arm 5 — UPDATE #2 ambiguity (two same-name profiles, DISTINCT brands) →
--           left NULL (the count(distinct …) = 1 guard).
--   Arm 6 — idempotency: re-run BOTH inline UPDATEs; the arm-2 row is
--           unchanged (the brand_id IS NULL guard excludes it). AC #2.

begin;
create extension if not exists pgtap;

select plan(6);

-- ─── fixtures (constants stashed via set_config) ───────────────
do $$
declare
  v_admin_id    uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_manager_id  uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', brand A)
  v_brand_a     uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b     uuid := 'b1000000-0000-0000-0000-000000000001';  -- test-only second brand
  v_sentinel    uuid := '00000000-0000-0000-0000-000000000000';
begin
  perform set_config('test.admin_id',   v_admin_id::text,   true);
  perform set_config('test.manager_id', v_manager_id::text, true);
  perform set_config('test.brand_a',    v_brand_a::text,    true);
  perform set_config('test.brand_b',    v_brand_b::text,    true);
  perform set_config('test.sentinel',   v_sentinel::text,   true);
end $$;

-- Second brand B, minted in-txn for the ambiguity arm (arm 5). Run as
-- postgres (no RLS for the superuser); restored on rollback.
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 083)')
on conflict (id) do nothing;

select isnt(current_setting('test.admin_id', true), '',
  'arm 1: fixture admin_id resolves from seed');


-- ─── Arm 2: UPDATE #1 (profile_id path) fills brand ────────────
-- Insert a NULL-brand invitation linked by profile_id to the seed manager
-- (whose seed brand_id is brand A). Run UPDATE #1 inline. The invitation's
-- brand_id must become the manager's brand A. THE CORE INVARIANT (AC #1).
insert into public.invitations (email, name, role, store_ids, profile_id, brand_id, used)
  values ('bobby083pgtap@test.local', 'Bobby 083', 'admin',
          array[]::text[], current_setting('test.manager_id', true)::uuid, null, true);

-- INLINE COPY of the migration's UPDATE #1 — MUST stay byte-identical to
-- supabase/migrations/20260531010000_invitations_brand_id_backfill.sql.
update public.invitations i
   set brand_id = p.brand_id
  from public.profiles p
 where i.brand_id is null
   and i.profile_id <> '00000000-0000-0000-0000-000000000000'::uuid
   and p.id = i.profile_id
   and p.brand_id is not null;

select is(
  (select brand_id from public.invitations
     where email = 'bobby083pgtap@test.local' limit 1),
  current_setting('test.brand_a', true)::uuid,
  'arm 2: UPDATE #1 backfills invitations.brand_id from the profile_id-linked profile (the core invariant)'
);


-- ─── Arm 3: NULL-brand profile → invitation left NULL ──────────
-- Construct a NULL-brand role='user' profile and an invitation linked to it
-- by profile_id. Insert a matching auth.users row first (profiles → auth.users
-- FK). Run UPDATE #1; the invitation must STILL be NULL (the p.brand_id is not
-- null guard — nothing to derive). AC #3 accepted bootstrap gap.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, is_anonymous)
values (
  '0c000000-0000-0000-0000-0000000000aa',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'nullbrand083@test.local',
  now(), now(), false
)
on conflict (id) do nothing;

insert into public.profiles (id, name, role, initials, color, status, brand_id)
values ('0c000000-0000-0000-0000-0000000000aa', 'Null Brand 083', 'user', 'NB', '#378ADD', 'active', null)
on conflict (id) do nothing;

insert into public.invitations (email, name, role, store_ids, profile_id, brand_id, used)
  values ('nullbrand083pgtap@test.local', 'Null Brand 083', 'user',
          array[]::text[], '0c000000-0000-0000-0000-0000000000aa'::uuid, null, true);

update public.invitations i
   set brand_id = p.brand_id
  from public.profiles p
 where i.brand_id is null
   and i.profile_id <> '00000000-0000-0000-0000-000000000000'::uuid
   and p.id = i.profile_id
   and p.brand_id is not null;

select is(
  (select brand_id from public.invitations
     where email = 'nullbrand083pgtap@test.local' limit 1),
  null::uuid,
  'arm 3: invitation linked to a NULL-brand profile is left NULL (p.brand_id is not null guard; accepted bootstrap gap)'
);


-- ─── Arm 4: UPDATE #2 (name fallback, exactly-one) fills brand ──
-- Insert a NULL-brand, SENTINEL-profile_id invitation whose name matches
-- exactly one branded profile (the seed manager 'Tara Manager', brand A). Run
-- UPDATE #2 inline. The invitation's brand_id must become brand A.
insert into public.invitations (email, name, role, store_ids, profile_id, brand_id, used)
  values ('namematch083pgtap@test.local', 'Tara Manager', 'user',
          array[]::text[], current_setting('test.sentinel', true)::uuid, null, true);

-- INLINE COPY of the migration's UPDATE #2 — MUST stay byte-identical to
-- supabase/migrations/20260531010000_invitations_brand_id_backfill.sql.
update public.invitations i
   set brand_id = (
     select distinct p.brand_id
       from public.profiles p
      where p.name = i.name
        and p.brand_id is not null
   )
 where i.brand_id is null
   and i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
   and (
     select count(distinct p.brand_id)
       from public.profiles p
      where p.name = i.name
        and p.brand_id is not null
   ) = 1;

select is(
  (select brand_id from public.invitations
     where email = 'namematch083pgtap@test.local' limit 1),
  current_setting('test.brand_a', true)::uuid,
  'arm 4: UPDATE #2 name fallback backfills brand from a single branded name match'
);


-- ─── Arm 5: UPDATE #2 ambiguity → left NULL ────────────────────
-- Create two in-txn profiles sharing the SAME name but carrying DISTINCT
-- non-null brands (manager seed already covers brand A via 'Tara Manager';
-- here we mint a fresh shared name across brand A and brand B). Insert a
-- sentinel invitation with that shared name, run UPDATE #2. The count(distinct
-- …) = 1 guard must leave the invitation NULL (two distinct brands → cannot
-- pick one). Insert matching auth.users rows first (profiles FK).
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, is_anonymous)
values
  ('0d000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dupea083@test.local', now(), now(), false),
  ('0d000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dupeb083@test.local', now(), now(), false)
on conflict (id) do nothing;

insert into public.profiles (id, name, role, initials, color, status, brand_id)
values
  ('0d000000-0000-0000-0000-0000000000a1', 'Dupe Name 083', 'admin', 'DA', '#378ADD', 'active',
   current_setting('test.brand_a', true)::uuid),
  ('0d000000-0000-0000-0000-0000000000a2', 'Dupe Name 083', 'admin', 'DB', '#378ADD', 'active',
   current_setting('test.brand_b', true)::uuid)
on conflict (id) do nothing;

insert into public.invitations (email, name, role, store_ids, profile_id, brand_id, used)
  values ('ambiguous083pgtap@test.local', 'Dupe Name 083', 'admin',
          array[]::text[], current_setting('test.sentinel', true)::uuid, null, true);

update public.invitations i
   set brand_id = (
     select distinct p.brand_id
       from public.profiles p
      where p.name = i.name
        and p.brand_id is not null
   )
 where i.brand_id is null
   and i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
   and (
     select count(distinct p.brand_id)
       from public.profiles p
      where p.name = i.name
        and p.brand_id is not null
   ) = 1;

select is(
  (select brand_id from public.invitations
     where email = 'ambiguous083pgtap@test.local' limit 1),
  null::uuid,
  'arm 5: name matching two DISTINCT-brand profiles is left NULL (count(distinct …) = 1 guard)'
);


-- ─── Arm 6: idempotency — re-run both UPDATEs, arm-2 row unchanged ──
-- Re-run BOTH inline UPDATEs. The arm-2 row (already brand A) must be
-- unchanged — the brand_id IS NULL guard excludes it. AC #2.
update public.invitations i
   set brand_id = p.brand_id
  from public.profiles p
 where i.brand_id is null
   and i.profile_id <> '00000000-0000-0000-0000-000000000000'::uuid
   and p.id = i.profile_id
   and p.brand_id is not null;

update public.invitations i
   set brand_id = (
     select distinct p.brand_id
       from public.profiles p
      where p.name = i.name
        and p.brand_id is not null
   )
 where i.brand_id is null
   and i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
   and (
     select count(distinct p.brand_id)
       from public.profiles p
      where p.name = i.name
        and p.brand_id is not null
   ) = 1;

select is(
  (select brand_id from public.invitations
     where email = 'bobby083pgtap@test.local' limit 1),
  current_setting('test.brand_a', true)::uuid,
  'arm 6: re-running both UPDATEs leaves the already-filled arm-2 row unchanged (brand_id IS NULL guard → idempotent)'
);


select * from finish();
rollback;

-- supabase/tests/staff_role_eod_rls.test.sql
--
-- Spec 061 / A4 — pgTAP coverage for the per-user-JWT staff EOD flow.
-- Mirrors the shape of eod_submissions_consistency.test.sql (the spec
-- 020 round-2 example) and inventory_counts_set_submitted_by.test.sql
-- (the spec 022 trigger example).
--
-- Ten assertions covering the contract pinned in spec 061 §8:
--
--   (1) Staff user CAN call staff_submit_eod for a store in their
--       user_stores (Frederick).
--   (2) The RPC's insert lands exactly one row at the expected
--       (store_id, date, vendor_id) triple.
--   (3) eod_submissions.submitted_by on the persisted row equals
--       auth.uid() (the staff user's id), proving the
--       eod_submissions_set_submitted_by_trg trigger fires under the
--       new GRANT-to-authenticated path.
--   (4) audit_log.detail is prefixed with auth.uid()::text, not the
--       caller-supplied p_submitted_by — spec 061 §2 spoof-proofing.
--   (5) Staff user CANNOT call staff_submit_eod for a store NOT in
--       their user_stores (Charles). The new auth_can_see_store gate
--       in the RPC body raises 42501. THIS IS THE LOAD-BEARING
--       ASSERTION for AC A2 (spec 061 §8 risk #1).
--   (6) Staff user CANNOT direct-INSERT into eod_submissions for a
--       non-membership store (RLS denial, not the RPC's gate). Defense
--       in depth — the RLS policy on eod_submissions enforces the
--       same boundary the RPC's auth_can_see_store does.
--   (7) Staff user CAN SELECT eod_submissions for in-membership store.
--   (8) Staff user CANNOT see eod_submissions for non-membership store
--       (RLS SELECT scope).
--   (9) Staff user CANNOT INSERT into recipes (brand-shared table,
--       write-side gated on auth_is_privileged). Per the architect's
--       §0 revised A2 ruling — staff CAN read recipes but cannot
--       WRITE them.
--   (10) service_role has no EXECUTE on staff_submit_eod (spec 061 §1
--        Q1 GRANT swap). Verifies the lockdown half of the GRANT
--        change is in place.
--
-- An eleventh, smaller assertion (§8 idempotency replay) is folded
-- into the assertion plan as the 11th item — plan(11) below.
--
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(11);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id   uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick    uuid;
  v_charles      uuid;
  v_vendor_id    uuid;
  v_fred_item    uuid;
  v_charles_item uuid;
  v_client_a     uuid := gen_random_uuid();
  v_client_b     uuid := gen_random_uuid();
  v_client_c     uuid := gen_random_uuid();
begin
  -- The seed manager@local.test user has user_stores rows for
  -- Towson + Frederick only (seed.sql:198-200). Charles is therefore
  -- the negative case for the membership gate.
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;

  -- Pick any seed vendor — vendors are brand-shared so any one is
  -- valid for the call. The vendor_id presence check at the top of
  -- the RPC body needs a non-null value; the membership gate fires
  -- AFTER that, so we still need a real vendor.
  select id into v_vendor_id from public.vendors limit 1;

  -- Frederick item must share the vendor with the RPC call for the
  -- vendor-scoped inventory_items update to actually mutate (not a
  -- correctness requirement for the assertions below, but keeps the
  -- happy-path call shape realistic). Fall back to ANY Frederick item
  -- if no vendor-matching item exists in the seed.
  select id into v_fred_item
    from public.inventory_items
   where store_id = v_frederick
     and vendor_id = v_vendor_id
   limit 1;
  if v_fred_item is null then
    select id into v_fred_item
      from public.inventory_items
     where store_id = v_frederick
     limit 1;
  end if;

  select id into v_charles_item
    from public.inventory_items
   where store_id = v_charles
   limit 1;

  perform set_config('test.manager_id',    v_manager_id::text,    true);
  perform set_config('test.frederick_id',  v_frederick::text,     true);
  perform set_config('test.charles_id',    v_charles::text,       true);
  perform set_config('test.vendor_id',     v_vendor_id::text,     true);
  perform set_config('test.fred_item',     v_fred_item::text,     true);
  perform set_config('test.charles_item',  v_charles_item::text,  true);
  perform set_config('test.client_a',      v_client_a::text,      true);
  perform set_config('test.client_b',      v_client_b::text,      true);
  perform set_config('test.client_c',      v_client_c::text,      true);
end $$;

-- ─── (pre) service_role has NO EXECUTE on staff_submit_eod ────
-- Assertion (10) of the spec §8 plan — check the GRANT lockdown
-- BEFORE we switch roles. has_function_privilege is callable from
-- the postgres role, which we still hold here.
select ok(
  not has_function_privilege(
    'service_role',
    'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)',
    'EXECUTE'
  ),
  '(10) service_role lacks EXECUTE on staff_submit_eod (spec 061 GRANT swap)'
);

-- ─── Impersonate the staff user (manager@local.test, role=user) ─
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- ─── (1) In-membership RPC call succeeds ───────────────────────
-- Happy-path assertion. The staff user calls staff_submit_eod for
-- Frederick (in their user_stores). The call should return cleanly
-- (no exception) and return a JSON envelope with submission_id.
--
-- Test-only date '1999-12-31'. NOT today's date — using today would
-- collide with the row left behind by scripts/smoke-staff-eod.sh
-- (which writes to today/Frederick/vendor and is not transactional).
-- The hermetic begin/rollback wrapper rolls back the test's writes,
-- but doesn't undo prior-run smoke residue; using a date no other
-- test or smoke ever writes avoids that coupling. Same posture as
-- eod_submissions_consistency.test.sql which uses 2026-05-01.
create temp table _first_call on commit drop as
select public.staff_submit_eod(
  current_setting('test.client_a', true)::uuid,
  current_setting('test.frederick_id', true)::uuid,
  '1999-12-31'::date,
  null,
  'submitted',
  jsonb_build_array(
    jsonb_build_object(
      'ingredient_id', current_setting('test.fred_item', true)::uuid,
      'actual_remaining', 7,
      'unit', 'lbs'
    )
  ),
  current_setting('test.vendor_id', true)::uuid
) as result;

select ok(
  (select (result ->> 'submission_id') is not null from _first_call),
  '(1) staff user can call staff_submit_eod for in-membership store (Frederick)'
);

do $$
declare
  v_sub_id uuid;
begin
  select (result ->> 'submission_id')::uuid into v_sub_id from _first_call limit 1;
  perform set_config('test.first_submission_id', v_sub_id::text, true);
end $$;

-- ─── (2) Exactly one eod_submissions row at the expected triple ─
select is(
  (
    select count(*)::bigint
      from public.eod_submissions
     where store_id   = current_setting('test.frederick_id', true)::uuid
       and date       = '1999-12-31'::date
       and vendor_id  = current_setting('test.vendor_id', true)::uuid
  ),
  1::bigint,
  '(2) RPC inserted exactly one eod_submissions row at the expected (store, date, vendor) triple'
);

-- ─── (3) submitted_by on the persisted row equals auth.uid() ────
-- The eod_submissions_set_submitted_by_trg trigger should override
-- whatever was passed (in this case the RPC writes null) with
-- auth.uid() = manager_id. This is the spec 020 round-2 fix; we're
-- here re-confirming it fires under the new GRANT-to-authenticated
-- path, since the previous test ran under service_role and the
-- override resolved to NULL.
select is(
  (
    select submitted_by
      from public.eod_submissions
     where store_id  = current_setting('test.frederick_id', true)::uuid
       and date      = '1999-12-31'::date
       and vendor_id = current_setting('test.vendor_id', true)::uuid
  ),
  current_setting('test.manager_id', true)::uuid,
  '(3) eod_submissions.submitted_by is server-derived from auth.uid() (staff user id, not caller-supplied null)'
);

-- ─── (4) audit_log.detail is prefixed with auth.uid()::text ─────
-- Spec 061 §2 spoof-proofing — the v_actor variable in the RPC body
-- is coalesce(auth.uid()::text, p_submitted_by, 'staff:unknown').
-- We passed p_submitted_by = null but auth.uid() is the staff user's
-- id, so the detail should begin with the manager UUID.
select ok(
  (
    select detail
      from public.audit_log
     where store_id = current_setting('test.frederick_id', true)::uuid
       and action   = 'EOD entry'
     order by id desc
     limit 1
  ) like current_setting('test.manager_id', true) || '%',
  '(4) audit_log.detail is prefixed with auth.uid()::text (not caller-supplied p_submitted_by) — spoof-proof'
);

-- ─── (5) Out-of-membership RPC call refused (42501) ─────────────
-- THE load-bearing assertion for AC A2 (spec 061 §8 risk #1). The
-- staff user attempts to call staff_submit_eod for Charles (NOT in
-- their user_stores). The new auth_can_see_store gate in the RPC
-- body raises 42501 BEFORE any insert can land.
select throws_ok(
  format(
    $q$select public.staff_submit_eod(
      %L::uuid,
      %L::uuid,
      '2026-05-23'::date,
      null,
      'submitted',
      jsonb_build_array(jsonb_build_object(
        'ingredient_id', %L::uuid,
        'actual_remaining', 5
      )),
      %L::uuid
    )$q$,
    current_setting('test.client_b', true),
    current_setting('test.charles_id', true),
    current_setting('test.charles_item', true),
    current_setting('test.vendor_id', true)
  ),
  '42501',
  null,
  '(5) staff user is refused for out-of-membership store via auth_can_see_store gate (42501)'
);

-- ─── (6) Direct INSERT into eod_submissions for non-membership rejected by RLS ─
-- Defense-in-depth: even if the RPC's gate were ever removed, the
-- table-level RLS policy on eod_submissions
-- (store_member_insert_eod_submissions in per_store_rls_hardening
-- migration:63-132) gates INSERT through auth_can_see_store(store_id).
-- A staff user without user_stores for Charles gets RLS-denied.
select throws_ok(
  format(
    $q$insert into public.eod_submissions
        (store_id, date, vendor_id, status, client_uuid)
        values (%L::uuid, '2026-05-22'::date, %L::uuid, 'submitted', gen_random_uuid())$q$,
    current_setting('test.charles_id', true),
    current_setting('test.vendor_id', true)
  ),
  '42501',
  null,
  '(6) direct INSERT into eod_submissions for out-of-membership store rejected by RLS'
);

-- ─── (7) Staff CAN SELECT eod_submissions for in-membership store ─
-- The submission we just inserted via the RPC is visible to the
-- staff user. (Belt-and-braces for assertion (2), but exercising the
-- SELECT RLS path explicitly.)
select is(
  (
    select count(*)::bigint
      from public.eod_submissions
     where store_id = current_setting('test.frederick_id', true)::uuid
       and date     = '1999-12-31'::date
  ),
  1::bigint,
  '(7) staff user can SELECT own-store eod_submissions'
);

-- ─── (8) Staff CANNOT SELECT eod_submissions for non-membership ─
-- Seed an eod_submissions row at Charles using the postgres role
-- (bypasses RLS), then re-impersonate the staff user and confirm the
-- row is invisible.
reset role;
insert into public.eod_submissions
  (store_id, date, vendor_id, submitted_by, status, client_uuid)
  values (
    current_setting('test.charles_id', true)::uuid,
    '2026-05-22'::date,
    current_setting('test.vendor_id', true)::uuid,
    null,
    'submitted',
    gen_random_uuid()
  )
on conflict do nothing;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

select is(
  (
    select count(*)::bigint
      from public.eod_submissions
     where store_id = current_setting('test.charles_id', true)::uuid
       and date     = '2026-05-22'::date
  ),
  0::bigint,
  '(8) staff user CANNOT SELECT out-of-membership store eod_submissions (RLS hides row)'
);

-- ─── (9) Staff CANNOT INSERT into recipes (brand-shared write block) ─
-- Per the architect's §0 revised A2 ruling: staff CAN read brand-
-- shared tables (recipes, catalog_ingredients, etc.) by design, but
-- CANNOT WRITE them. The privileged_insert_recipes policy gates on
-- auth_is_privileged(), which short-circuits to false for role='user'.
select throws_ok(
  format(
    $q$insert into public.recipes
        (brand_id, menu_item, category, sell_price)
        values (%L::uuid, 'Test Recipe spec 061', 'Mains', 12.00)$q$,
    '2a000000-0000-0000-0000-000000000001'
  ),
  '42501',
  null,
  '(9) staff user cannot INSERT into recipes (auth_is_privileged-gated brand-shared write)'
);

-- ─── (11) Idempotency replay returns conflict: true with same submission_id ─
-- Re-call staff_submit_eod with the SAME client_uuid_a. The RPC
-- short-circuits at the idempotency check and returns the existing
-- submission_id with conflict=true.
create temp table _replay on commit drop as
select public.staff_submit_eod(
  current_setting('test.client_a', true)::uuid,
  current_setting('test.frederick_id', true)::uuid,
  '1999-12-31'::date,
  null,
  'submitted',
  jsonb_build_array(
    jsonb_build_object(
      'ingredient_id', current_setting('test.fred_item', true)::uuid,
      'actual_remaining', 9
    )
  ),
  current_setting('test.vendor_id', true)::uuid
) as result;

select is(
  ((select result from _replay) ->> 'conflict')::boolean,
  true,
  '(11) idempotency replay with same client_uuid returns conflict: true'
);

select * from finish();
rollback;

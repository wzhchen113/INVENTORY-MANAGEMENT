-- supabase/tests/staff_submit_eod_cases_each.test.sql
--
-- Spec 086 / Track 2 — pgTAP coverage for the additive
-- staff_submit_eod Cases + Units persistence
-- (20260601000000_staff_submit_eod_cases_each.sql).
--
-- The staff EOD screen now sends two split inputs per item
-- (actual_remaining_cases / actual_remaining_each) plus the
-- client-computed total (actual_remaining) INSIDE the existing p_entries
-- jsonb. The RPC's jsonb_to_recordset destructure + eod_entries INSERT
-- gained the two columns additively; the signature/GRANT are unchanged.
--
-- Six assertions covering the spec 086 §"Test contract" (Track 2):
--
--   (1) GRANT pinned — authenticated still has EXECUTE on the 7-arg
--       signature after `create or replace`. Belt-and-suspenders that
--       the GRANT survived the additive replace (the signature is
--       intentionally byte-identical, so this should hold). Cheap +
--       valuable per the design.
--   (2) Happy path — calling the RPC with an element carrying
--       actual_remaining + actual_remaining_cases + actual_remaining_each
--       returns a submission_id (no exception).
--   (3) All three values persist — the resulting eod_entries row has the
--       client-computed total in actual_remaining AND the raw splits in
--       _cases / _each. THE load-bearing assertion for spec 086.
--   (4) Backward-compat — a LEGACY element OMITTING the two split keys
--       still inserts, with _cases / _each = NULL and actual_remaining
--       set. Proves jsonb_to_recordset yields NULL for absent columns
--       and the nullable eod_entries columns accept it (the admin
--       direct-PostgREST path + any older staff client are unaffected).
--   (5) actual_remaining is stored as-received — the RPC does NOT
--       recompute the total from the splits (2 cases + 3 each is NOT
--       silently turned into some pack-math total; the RPC stores the
--       single number the client sent). Pins the "stores what it
--       receives" contract.
--   (6) Per-store gate still holds — a caller WITHOUT
--       auth_can_see_store(p_store_id) is refused with 42501 BEFORE any
--       insert lands, under the new INSERT. Confirms the additive change
--       did not weaken the spec 061 membership gate. Uses throws_ok (NOT
--       `set role anon` — that segfaults the CI Postgres image, spec
--       067).
--
-- Hermetic isolation: begin; ... rollback;.
-- Seeded-user pattern mirrors staff_role_eod_rls.test.sql (the spec 061
-- example) — manager@local.test (id 2222…, role=user) with user_stores
-- for Towson + Frederick only; Charles is the negative membership case.

begin;
create extension if not exists pgtap;

select plan(6);

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
  -- manager@local.test has user_stores for Towson + Frederick only
  -- (seed.sql). Charles is therefore the negative membership case.
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;

  -- Any seed vendor works — vendors are brand-shared. The vendor_id
  -- presence check at the top of the RPC needs a non-null value.
  select id into v_vendor_id from public.vendors limit 1;

  -- Prefer a Frederick item sharing the vendor so the vendor-scoped
  -- inventory_items update actually mutates AND the eod_entries
  -- cross-store-consistency trigger (the item must belong to the
  -- submission's store) is satisfied. Fall back to ANY Frederick item.
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

  perform set_config('test.manager_id',   v_manager_id::text,   true);
  perform set_config('test.frederick_id', v_frederick::text,    true);
  perform set_config('test.charles_id',   v_charles::text,      true);
  perform set_config('test.vendor_id',    v_vendor_id::text,    true);
  perform set_config('test.fred_item',    v_fred_item::text,    true);
  perform set_config('test.charles_item', v_charles_item::text, true);
  perform set_config('test.client_a',     v_client_a::text,     true);
  perform set_config('test.client_b',     v_client_b::text,     true);
  perform set_config('test.client_c',     v_client_c::text,     true);
end $$;

-- ─── (1) GRANT pinned — authenticated still has EXECUTE ────────
-- The additive `create or replace` keeps the 7-arg signature byte-
-- identical, so the existing GRANT EXECUTE ... TO authenticated must
-- survive. has_function_privilege is callable from the postgres role,
-- which we still hold here (before the role switch).
select ok(
  has_function_privilege(
    'authenticated',
    'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)',
    'EXECUTE'
  ),
  '(1) authenticated retains EXECUTE on staff_submit_eod after additive create-or-replace (GRANT preserved)'
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

-- ─── (2) Happy path with split keys returns a submission_id ────
-- Test-only date '1999-12-30' — NOT today (avoids colliding with the
-- non-transactional scripts/smoke-staff-eod.sh residue) and distinct
-- from staff_role_eod_rls.test.sql's '1999-12-31'. 2 cases + 3 units
-- with a client-computed total of 17 (the RPC must store 17 verbatim,
-- NOT recompute from the splits — see assertion (5)).
create temp table _split_call on commit drop as
select public.staff_submit_eod(
  current_setting('test.client_a', true)::uuid,
  current_setting('test.frederick_id', true)::uuid,
  '1999-12-30'::date,
  null,
  'submitted',
  jsonb_build_array(
    jsonb_build_object(
      'ingredient_id', current_setting('test.fred_item', true)::uuid,
      'actual_remaining', 17,
      'actual_remaining_cases', 2,
      'actual_remaining_each', 3,
      'unit', 'lbs'
    )
  ),
  current_setting('test.vendor_id', true)::uuid
) as result;

select ok(
  (select (result ->> 'submission_id') is not null from _split_call),
  '(2) staff_submit_eod with cases/each split keys returns a submission_id (no exception)'
);

-- ─── (3) All three values persist on the eod_entries row ───────
-- THE load-bearing assertion: total in actual_remaining, raw splits in
-- _cases / _each. is_empty / is over a row(...) tuple compares all
-- three columns at once.
select is(
  (
    select row(actual_remaining, actual_remaining_cases, actual_remaining_each)
      from public.eod_entries
     where item_id = current_setting('test.fred_item', true)::uuid
       and submission_id = (select (result ->> 'submission_id')::uuid from _split_call)
  ),
  row(17::numeric, 2::numeric, 3::numeric),
  '(3) eod_entries persists actual_remaining (total) + actual_remaining_cases + actual_remaining_each'
);

-- ─── (4) Legacy element (no split keys) still inserts, splits NULL ─
-- Backward-compat guarantee: an element WITHOUT the two new keys
-- inserts with _cases / _each = NULL and actual_remaining set. Uses a
-- distinct date so it lands a fresh submission/entry, not an upsert of
-- the (3) row.
create temp table _legacy_call on commit drop as
select public.staff_submit_eod(
  current_setting('test.client_c', true)::uuid,
  current_setting('test.frederick_id', true)::uuid,
  '1999-12-29'::date,
  null,
  'submitted',
  jsonb_build_array(
    jsonb_build_object(
      'ingredient_id', current_setting('test.fred_item', true)::uuid,
      'actual_remaining', 11
    )
  ),
  current_setting('test.vendor_id', true)::uuid
) as result;

select is(
  (
    select row(actual_remaining, actual_remaining_cases, actual_remaining_each)
      from public.eod_entries
     where item_id = current_setting('test.fred_item', true)::uuid
       and submission_id = (select (result ->> 'submission_id')::uuid from _legacy_call)
  ),
  row(11::numeric, null::numeric, null::numeric),
  '(4) legacy element omitting split keys still inserts — actual_remaining set, _cases/_each NULL (backward-compat)'
);

-- ─── (5) RPC stores the total as-received, does NOT recompute ──
-- Re-confirm against the (3) row: 2 cases + 3 each but the client sent
-- 17 as the total. If the RPC recomputed (e.g. cases*caseQty+each) the
-- stored total would differ; it must be exactly 17. (caseQty is never
-- sent to or known by the RPC — this pins that contract.)
select is(
  (
    select actual_remaining
      from public.eod_entries
     where item_id = current_setting('test.fred_item', true)::uuid
       and submission_id = (select (result ->> 'submission_id')::uuid from _split_call)
  ),
  17::numeric,
  '(5) actual_remaining stored as the client-sent total (RPC does not recompute from splits)'
);

-- ─── (6) Per-store gate still holds under the new INSERT (42501) ─
-- The additive change must NOT weaken the spec 061 auth_can_see_store
-- gate. The staff user attempts to submit for Charles (NOT in their
-- user_stores), now carrying the split keys. The gate raises 42501
-- BEFORE any insert lands. throws_ok (NOT `set role anon` — that
-- segfaults the CI Postgres image, spec 067).
select throws_ok(
  format(
    $q$select public.staff_submit_eod(
      %L::uuid,
      %L::uuid,
      '1999-12-28'::date,
      null,
      'submitted',
      jsonb_build_array(jsonb_build_object(
        'ingredient_id', %L::uuid,
        'actual_remaining', 9,
        'actual_remaining_cases', 1,
        'actual_remaining_each', 4
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
  '(6) out-of-membership store still refused (42501) with split keys present — gate not weakened'
);

select * from finish();
rollback;

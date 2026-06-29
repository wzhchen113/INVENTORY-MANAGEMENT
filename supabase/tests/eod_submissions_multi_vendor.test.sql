-- supabase/tests/eod_submissions_multi_vendor.test.sql
--
-- Spec 102 / AC-F / FG-1 / AC-I — pgTAP coverage for the JUNCTION-MEMBERSHIP
-- on-hand write in staff_submit_eod
-- (supabase/migrations/20260630000200_staff_submit_eod_multi_vendor.sql).
--
-- The one hunk that migration changed: the inventory on-hand write predicate
-- went from the vendor-EQUALITY form
--     update inventory_items … where ii.id = … and ii.vendor_id = p_vendor_id
-- to a junction-MEMBERSHIP form
--     update inventory_items … where ii.id = …
--       and exists (select 1 from item_vendors iv
--                    where iv.item_id = ii.id and iv.vendor_id = p_vendor_id)
--
-- The load-bearing spec-102 behavior: a SHARED item linked to V1 (primary)
-- AND V2 (non-primary), when counted under V2 (the NON-primary vendor), MUST
-- still update the single shared on-hand (current_stock + eod_remaining). The
-- OLD vendor-equality predicate would have skipped that write (the scalar
-- vendor_id is V1, not V2) — silently dropping the on-hand. This is AC-E /
-- AC-F. The escape-hatch (an item with NO link to the submitting vendor) must
-- still SKIP the on-hand write (the entry/audit row still lands).
--
-- Five assertions, manager@local.test (id 2222…, role=user, member of
-- Frederick):
--
--   (1) fixture resolve — Frederick + two DISTINCT vendors resolve.
--   (2) the RPC call under the NON-primary vendor returns a submission_id.
--   (3) current_stock on the SHARED item == the submitted count — the
--       membership write fired under the non-primary vendor (THE load-bearing
--       assertion; under the old scalar-equality predicate this stays at the
--       seeded starting value and the assertion fails).
--   (4) eod_remaining on the SHARED item == the submitted count (the write
--       sets BOTH columns).
--   (5) escape-hatch — an item with NO item_vendors link to the submitting
--       vendor is NOT written: its current_stock stays at the seeded starting
--       value even though it was in the same p_entries payload.
--
-- The item is linked to the submitting (V2) vendor via item_vendors seeded
-- INSIDE the transaction — so the test is identical under the 564-row backfill
-- seed AND the CI-fresh `truncate item_vendors` state (it never reads the seed
-- links; it creates exactly the links it asserts on). This is precisely the
-- gap the backend-architect flagged (staff_submit_eod_cases_each.test.sql
-- selects its target by the scalar vendor_id and seeds no item_vendors, so it
-- could not cover the new predicate).
--
-- No `set role anon` (segfaults CI per spec 067). The vendor-scoped
-- inventory write + the eod_entries cross-store trigger require the items to
-- belong to Frederick (the submission's store). Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(5);

-- ─── fixtures ──────────────────────────────────────────────────
-- Resolve Frederick + brand + TWO distinct vendors (V1 primary, V2 the
-- non-primary vendor we will count under).
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_brand_id   uuid;
  v_vendor1    uuid;  -- primary
  v_vendor2    uuid;  -- non-primary (counted under)
  v_client     uuid := gen_random_uuid();
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  select id into v_vendor1   from public.vendors order by id asc  limit 1;
  select id into v_vendor2   from public.vendors order by id desc limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
  perform set_config('test.vendor1',      v_vendor1::text,    true);
  perform set_config('test.vendor2',      v_vendor2::text,    true);
  perform set_config('test.client',       v_client::text,     true);
end $$;

select ok(
  current_setting('test.vendor1', true) <> current_setting('test.vendor2', true),
  '(1) fixture: Frederick + two DISTINCT vendors (primary V1, non-primary V2) resolve'
);

-- ─── master JWT — privileged for catalog + inventory seeding ────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           '33333333-3333-3333-3333-333333333333',
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'master')
  )::text,
  true
);

-- Two fresh catalog_ingredients + two Frederick inventory_items:
--   SHARED  → scalar vendor_id = V1 (primary), starting current_stock = 100.
--             Linked to BOTH V1 (primary) and V2 (non-primary) below.
--   ESCAPE  → scalar vendor_id = V1, starting current_stock = 100. Linked
--             ONLY to V1 — so under a V2 submission it is the escape-hatch
--             (no link to the submitting vendor → on-hand write skipped).
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  values
    (current_setting('test.brand_id', true)::uuid, 'SPEC102-MV-SHARED-'||gen_random_uuid()::text, 'lbs'),
    (current_setting('test.brand_id', true)::uuid, 'SPEC102-MV-ESCAPE-'||gen_random_uuid()::text, 'lbs')
  returning id, name
)
select id, name,
       case when name like 'SPEC102-MV-SHARED%' then 'shared' else 'escape' end as kind
  from ins;

create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, case_price, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid,
     (select id from _cat where kind = 'shared'),
     current_setting('test.vendor1', true)::uuid,
     1, 1, 100, 0, 0),
    (current_setting('test.frederick_id', true)::uuid,
     (select id from _cat where kind = 'escape'),
     current_setting('test.vendor1', true)::uuid,
     1, 1, 100, 0, 0)
  returning id, catalog_id
)
select i.id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
begin
  perform set_config('test.item_shared', (select id from _items where kind = 'shared')::text, true);
  perform set_config('test.item_escape', (select id from _items where kind = 'escape')::text, true);
end $$;

-- Seed item_vendors links INSIDE the transaction:
--   SHARED → V1 (is_primary=true) AND V2 (is_primary=false).
--   ESCAPE → V1 only.
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  (current_setting('test.item_shared', true)::uuid, current_setting('test.vendor1', true)::uuid, 1, 1, true),
  (current_setting('test.item_shared', true)::uuid, current_setting('test.vendor2', true)::uuid, 1, 1, false),
  (current_setting('test.item_escape', true)::uuid, current_setting('test.vendor1', true)::uuid, 1, 1, true)
on conflict (item_id, vendor_id) do nothing;

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

-- ─── Submit the count under V2 (the NON-primary vendor) ─────────
-- Both items are in the payload with actual_remaining = 42. The SHARED item
-- is linked to V2 → its on-hand must be written. The ESCAPE item is NOT
-- linked to V2 → its on-hand must be skipped. Test-only date 1999-12-27
-- (distinct from the other staff EOD tests' dates).
create temp table _call on commit drop as
select public.staff_submit_eod(
  current_setting('test.client', true)::uuid,
  current_setting('test.frederick_id', true)::uuid,
  '1999-12-27'::date,
  null,
  'submitted',
  jsonb_build_array(
    jsonb_build_object(
      'ingredient_id', current_setting('test.item_shared', true)::uuid,
      'actual_remaining', 42, 'unit', 'lbs'
    ),
    jsonb_build_object(
      'ingredient_id', current_setting('test.item_escape', true)::uuid,
      'actual_remaining', 42, 'unit', 'lbs'
    )
  ),
  current_setting('test.vendor2', true)::uuid
) as result;

select ok(
  (select (result ->> 'submission_id') is not null from _call),
  '(2) staff_submit_eod under the NON-primary vendor (V2) returns a submission_id'
);

-- ─── (3) SHARED item current_stock written by the membership predicate ──
-- THE load-bearing assertion. The item's scalar vendor_id is V1, but it was
-- counted under V2; the junction-membership EXISTS sees the V2 link → the
-- write fires. Under the OLD `and ii.vendor_id = p_vendor_id` predicate this
-- would still be 100 (the seeded starting value).
select is(
  (select current_stock from public.inventory_items
    where id = current_setting('test.item_shared', true)::uuid),
  42::numeric,
  '(3) SHARED item current_stock == submitted count — junction-membership write fired under the NON-primary vendor'
);

-- ─── (4) SHARED item eod_remaining also written (both columns) ──
select is(
  (select eod_remaining from public.inventory_items
    where id = current_setting('test.item_shared', true)::uuid),
  42::numeric,
  '(4) SHARED item eod_remaining == submitted count (the write sets both columns)'
);

-- ─── (5) ESCAPE item NOT written (no link to the submitting vendor) ──
-- The escape-hatch invariant: an item with no item_vendors link to V2 has the
-- EXISTS yield false → no row matches → on-hand untouched. Stays at 100.
select is(
  (select current_stock from public.inventory_items
    where id = current_setting('test.item_escape', true)::uuid),
  100::numeric,
  '(5) ESCAPE item (no link to V2) on-hand untouched — membership skip preserved'
);

select * from finish();
rollback;

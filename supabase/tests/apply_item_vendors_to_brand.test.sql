-- supabase/tests/apply_item_vendors_to_brand.test.sql
--
-- Spec 119 — pgTAP coverage for public.apply_item_vendors_to_brand(uuid,
-- jsonb, uuid) in supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql.
--
-- The RPC fans an ingredient's item_vendors link set out across the SAME
-- catalog ingredient's inventory_items rows in every caller-visible store of
-- the catalog's brand, mirroring is_primary + the legacy scalar vendor_id on
-- each store, preserving existing per-store prices, seeding new links from the
-- submitted values, propagating per-link order_code, and reporting stores that
-- lack a row as skipped. Save (db.updateInventoryItem) is untouched.
--
-- Fixtures (all seeded INSIDE the txn under the postgres role so the run is
-- hermetic and CI-fresh safe — never depends on the 564-row backfill seed):
--   • Brand A = the seed 2AM brand (2a00…0001), which admin@local.test
--     (11111111-…, role=admin, brand_id=2AM) can see.
--   • A FRESH catalog ingredient X in brand A, with inventory_items rows in
--     TWO of the four 2AM stores (Towson + Charles) and NONE in the other two
--     (Frederick + Reisters → the skipped set).
--   • Towson's X seeded with V1 (primary, cost 5.00) + a de-selected extra
--     link V3 (must be removed by the fan-out). Charles's X seeded with V1
--     (primary, cost 7.00). Scalar inventory_items.vendor_id = V1 on both.
--   • A SECOND brand B + its own store + catalog Y + item + link, which admin
--     CANNOT see (brand_id mismatch) — the never-cross-brand boundary.
--
-- The apply call repoints the primary to V2 and submits [V1 (cost 99 —
-- MUST be ignored for the existing link), V2 (cost 20 — seeds the new link)]
-- with order codes, primary = V2.
--
-- Roles / claims mirror copy_brand_catalog.test.sql + item_vendors_rls.test.sql:
-- set local role authenticated + a request.jwt.claims blob. Cross-brand rows
-- are seeded under postgres (RLS-bypassing). No `set role anon` (segfaults CI
-- per spec 067). All mutations roll back at the end.

begin;
create extension if not exists pgtap;

select plan(19);

-- ─── fixtures (postgres role) ───────────────────────────────────────────────
do $$
declare
  v_brand_a      uuid := '2a000000-0000-0000-0000-000000000001';
  v_brand_b      uuid := 'beeff00d-0000-0000-0000-000000000119';
  v_towson       uuid;
  v_charles      uuid;
  v_frederick    uuid;
  v_reisters     uuid;
  v_store_b      uuid := 'beeff00d-0000-0000-0000-0000000000b5';
  v_cat_x        uuid;
  v_cat_y        uuid;
  v_item_towson  uuid;
  v_item_charles uuid;
  v_item_b       uuid;
  v_v1           uuid;
  v_v2           uuid;
  v_v3           uuid;
begin
  select id into v_towson    from public.stores where name = 'Towson'    limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_reisters  from public.stores where name = 'Reisters'  limit 1;

  select id into v_v1 from public.vendors order by id       limit 1;
  select id into v_v2 from public.vendors order by id offset 1 limit 1;
  select id into v_v3 from public.vendors order by id offset 2 limit 1;

  -- FRESH catalog ingredient X in brand A (unique name → no seed collision).
  insert into public.catalog_ingredients (brand_id, name, unit, category)
  values (v_brand_a, '__spec119_ingredient_x__', 'ea', 'test')
  returning id into v_cat_x;

  -- X items in Towson + Charles ONLY (Frederick + Reisters intentionally absent).
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, case_price)
  values (v_towson, v_cat_x, v_v1, 5.00, 60.00) returning id into v_item_towson;
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, case_price)
  values (v_charles, v_cat_x, v_v1, 7.00, 84.00) returning id into v_item_charles;

  -- Towson: V1 primary (matching scalar) + a de-selected extra link V3.
  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary, order_code)
  values (v_item_towson, v_v1, 5.00, 60.00, true,  'OLD-1');
  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary, order_code)
  values (v_item_towson, v_v3, 3.00, 36.00, false, 'OLD-3');
  -- Charles: V1 primary.
  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary, order_code)
  values (v_item_charles, v_v1, 7.00, 84.00, true, 'OLD-1');

  -- SECOND brand B (admin's brand_id is 2AM → cannot see B).
  insert into public.brands (id, name) values (v_brand_b, '__spec119_brand_b__')
  on conflict (id) do nothing;
  insert into public.stores (id, brand_id, name) values (v_store_b, v_brand_b, '__spec119_store_b__')
  on conflict (id) do nothing;
  insert into public.catalog_ingredients (brand_id, name, unit, category)
  values (v_brand_b, '__spec119_ingredient_y__', 'ea', 'test')
  returning id into v_cat_y;
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, case_price)
  values (v_store_b, v_cat_y, v_v1, 11.00, 132.00) returning id into v_item_b;
  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary, order_code)
  values (v_item_b, v_v1, 11.00, 132.00, true, 'B-KEEP');

  perform set_config('t.cat_x',        v_cat_x::text,        false);
  perform set_config('t.cat_y',        v_cat_y::text,        false);
  perform set_config('t.item_towson',  v_item_towson::text,  false);
  perform set_config('t.item_charles', v_item_charles::text, false);
  perform set_config('t.item_b',       v_item_b::text,       false);
  perform set_config('t.frederick',    v_frederick::text,    false);
  perform set_config('t.reisters',     v_reisters::text,     false);
  perform set_config('t.v1',           v_v1::text,           false);
  perform set_config('t.v2',           v_v2::text,           false);
  perform set_config('t.v3',           v_v3::text,           false);
end $$;

-- ─── (0) non-privileged caller rejected BEFORE any side effect ──────────────
-- manager@local.test (2222…, role=user, brand_id=2AM) — can see the brand but
-- is not privileged → 'privileged only'.
set local role authenticated;
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated", "app_metadata": {"role": "user"}}';
select throws_ok(
  format($$select public.apply_item_vendors_to_brand(%L::uuid,
    '[{"vendor_id":"%s"}]'::jsonb, %L::uuid)$$,
    current_setting('t.cat_x'), current_setting('t.v1'), current_setting('t.v1')),
  'privileged only',
  '(0) non-privileged (role=user) caller is rejected with `privileged only`'
);
reset role;

-- ─── admin runs the fan-out (repoint primary V1 → V2) ───────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "app_metadata": {"role": "admin"}}';
do $$
declare r jsonb;
begin
  r := public.apply_item_vendors_to_brand(
    current_setting('t.cat_x')::uuid,
    jsonb_build_array(
      jsonb_build_object('vendor_id', current_setting('t.v1'), 'cost_per_unit', 99.00, 'case_price', 999.00, 'order_code', 'OC-1'),
      jsonb_build_object('vendor_id', current_setting('t.v2'), 'cost_per_unit', 20.00, 'case_price', 240.00, 'order_code', 'OC-2')
    ),
    current_setting('t.v2')::uuid
  );
  perform set_config('t.result', r::text, false);
end $$;

-- ─── (1) cross-brand rejection: admin CANNOT apply to brand B's catalog ─────
select throws_ok(
  format($$select public.apply_item_vendors_to_brand(%L::uuid, '[]'::jsonb, null)$$,
    current_setting('t.cat_y')),
  'brand not accessible',
  '(1) admin cannot apply to a catalog in a brand it cannot see (never cross-brand)'
);

-- ─── (2) bad catalog id rejected ────────────────────────────────────────────
select throws_ok(
  $$select public.apply_item_vendors_to_brand('00000000-0000-0000-0000-0000000000ff'::uuid, '[]'::jsonb, null)$$,
  'catalog ingredient not found',
  '(2) an unknown catalog id is rejected'
);
reset role;

-- ─── return-shape assertions (read t.result stashed by the do-block) ────────
select is(
  (current_setting('t.result')::jsonb ->> 'updated_count')::int, 2,
  '(3) updated_count = 2 (Towson + Charles both reconciled)'
);
select is(
  (current_setting('t.result')::jsonb ->> 'skipped_count')::int, 2,
  '(4) skipped_count = 2 (Frederick + Reisters have no row for X)'
);
select ok(
  (current_setting('t.result')::jsonb -> 'skipped_store_ids')
    @> to_jsonb(array[current_setting('t.frederick'), current_setting('t.reisters')]),
  '(5) skipped_store_ids contains both Frederick and Reisters'
);

-- ─── row-level assertions (postgres role — RLS-bypassing reads) ─────────────
-- Repoint primary + is_primary mirror on BOTH stores.
select is(
  (select vendor_id from public.item_vendors
    where item_id = current_setting('t.item_towson')::uuid and is_primary),
  current_setting('t.v2')::uuid,
  '(6) Towson: the single primary link is now V2'
);
select is(
  (select is_primary from public.item_vendors
    where item_id = current_setting('t.item_towson')::uuid and vendor_id = current_setting('t.v1')::uuid),
  false,
  '(7) Towson: the old primary V1 is no longer primary'
);
select is(
  (select vendor_id from public.item_vendors
    where item_id = current_setting('t.item_charles')::uuid and is_primary),
  current_setting('t.v2')::uuid,
  '(8) Charles: the single primary link is now V2'
);

-- Legacy scalar mirror on BOTH stores (SD-1, AC-8).
select is(
  (select vendor_id from public.inventory_items where id = current_setting('t.item_towson')::uuid),
  current_setting('t.v2')::uuid,
  '(9) Towson: legacy inventory_items.vendor_id scalar mirrors the new primary V2'
);
select is(
  (select vendor_id from public.inventory_items where id = current_setting('t.item_charles')::uuid),
  current_setting('t.v2')::uuid,
  '(10) Charles: legacy scalar mirrors the new primary V2'
);

-- Preserve existing per-store price on the ALREADY-linked vendor (AC-6).
select is(
  (select cost_per_unit from public.item_vendors
    where item_id = current_setting('t.item_towson')::uuid and vendor_id = current_setting('t.v1')::uuid),
  5.00::numeric,
  '(11) Towson V1: existing cost_per_unit PRESERVED (5.00, not the submitted 99)'
);
select is(
  (select cost_per_unit from public.item_vendors
    where item_id = current_setting('t.item_charles')::uuid and vendor_id = current_setting('t.v1')::uuid),
  7.00::numeric,
  '(12) Charles V1: existing cost_per_unit PRESERVED (7.00, not the submitted 99)'
);

-- Seed the NEW link from the submitted values (AC-6).
select is(
  (select cost_per_unit from public.item_vendors
    where item_id = current_setting('t.item_towson')::uuid and vendor_id = current_setting('t.v2')::uuid),
  20.00::numeric,
  '(13) Towson V2: NEW link SEEDED from submitted cost_per_unit (20.00)'
);

-- Order code propagated to preserved AND new links (AC-7).
select is(
  (select order_code from public.item_vendors
    where item_id = current_setting('t.item_towson')::uuid and vendor_id = current_setting('t.v1')::uuid),
  'OC-1',
  '(14) Towson V1: order_code propagated (OC-1) even though price preserved'
);
select is(
  (select order_code from public.item_vendors
    where item_id = current_setting('t.item_charles')::uuid and vendor_id = current_setting('t.v2')::uuid),
  'OC-2',
  '(15) Charles V2: new link carries the propagated order_code (OC-2)'
);

-- De-selected link removed → each target item has EXACTLY the submitted set.
select is(
  (select count(*)::int from public.item_vendors where item_id = current_setting('t.item_towson')::uuid),
  2,
  '(16) Towson has exactly the 2 submitted links (the de-selected V3 was removed)'
);

-- Cross-brand item completely untouched (never-cross-brand, AC-4).
select is(
  (select count(*)::int from public.item_vendors where item_id = current_setting('t.item_b')::uuid),
  1,
  '(17) brand-B item still has its single original link (untouched)'
);
select is(
  (select cost_per_unit from public.item_vendors where item_id = current_setting('t.item_b')::uuid),
  11.00::numeric,
  '(18) brand-B link cost_per_unit unchanged (no cross-brand write)'
);

select * from finish();

rollback;

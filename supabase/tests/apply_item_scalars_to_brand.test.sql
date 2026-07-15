-- supabase/tests/apply_item_scalars_to_brand.test.sql
--
-- Spec 122 — pgTAP coverage for public.apply_item_scalars_to_brand(uuid,
-- numeric, numeric, numeric) in
-- supabase/migrations/20260717000000_apply_item_scalars_to_brand.sql.
--
-- The RPC OVERWRITES the three per-store CONFIG scalars (par_level,
-- cost_per_unit, case_price) across the SAME catalog ingredient's
-- inventory_items rows in every caller-visible store of the catalog's brand,
-- NULL-means-skip per field, and reports stores that lack a row as skipped.
-- current_stock and count-like fields are excluded BY CONSTRUCTION (never
-- parameters) — this test asserts they are UNCHANGED (critical AC-5/AC-6).
-- OVERWRITE (not preserve) — the deliberate divergence from spec 119.
--
-- Fixtures (all seeded INSIDE the txn under the postgres role so the run is
-- hermetic and CI-fresh safe — never depends on the backfill seed):
--   • Brand A = the seed 2AM brand (2a00…0001), which admin@local.test
--     (11111111-…, role=admin, brand_id=2AM) can see.
--   • A FRESH catalog ingredient X in brand A, with inventory_items rows in
--     TWO of the four 2AM stores (Towson + Charles) and NONE in the other two
--     (Frederick + Reisters → the skipped set).
--   • Towson's X: par 4, cost 5.00, case 60.00, current_stock 111, expiry,
--     usage_per_portion, average_daily_usage, safety_stock all distinct.
--   • Charles's X: par 4, cost 7.00, case 84.00, current_stock 222 (a DIFFERENT
--     live count — the AC-5 pre/post equality target).
--   • A SECOND brand B + its own store + catalog Y + item, which admin CANNOT
--     see (brand_id mismatch) — the never-cross-brand boundary.
--
-- The apply call overwrites par → 480, cost → 20.00, case → 240.00.
--
-- Roles / claims mirror apply_item_vendors_to_brand.test.sql: set local role
-- authenticated + a request.jwt.claims blob. Cross-brand rows are seeded under
-- postgres (RLS-bypassing). No `set role anon` (segfaults CI per spec 067).
-- All mutations roll back at the end.

begin;
create extension if not exists pgtap;

select plan(18);

-- ─── fixtures (postgres role) ───────────────────────────────────────────────
do $$
declare
  v_brand_a      uuid := '2a000000-0000-0000-0000-000000000001';
  v_brand_b      uuid := 'beeff00d-0000-0000-0000-000000000122';
  v_towson       uuid;
  v_charles      uuid;
  v_frederick    uuid;
  v_reisters     uuid;
  v_store_b      uuid := 'beeff00d-0000-0000-0000-0000000000c2';
  v_cat_x        uuid;
  v_cat_y        uuid;
  v_item_towson  uuid;
  v_item_charles uuid;
  v_item_b       uuid;
  v_v1           uuid;
begin
  select id into v_towson    from public.stores where name = 'Towson'    limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_reisters  from public.stores where name = 'Reisters'  limit 1;

  select id into v_v1 from public.vendors order by id limit 1;

  -- FRESH catalog ingredient X in brand A (unique name → no seed collision).
  insert into public.catalog_ingredients (brand_id, name, unit, category)
  values (v_brand_a, '__spec122_ingredient_x__', 'ea', 'test')
  returning id into v_cat_x;

  -- X items in Towson + Charles ONLY (Frederick + Reisters intentionally
  -- absent). Seed DISTINCT par/cost/case AND distinct live/count-like fields
  -- per store so the overwrite (par/cost/case) and the never-touch (stock +
  -- count-like) can both be asserted.
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, par_level, cost_per_unit, case_price,
     current_stock, expiry_date, usage_per_portion, average_daily_usage, safety_stock)
  values (v_towson, v_cat_x, v_v1, 4, 5.00, 60.00,
     111, '2026-08-01', 0.5, 3.3, 2.2)
  returning id into v_item_towson;
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, par_level, cost_per_unit, case_price,
     current_stock, expiry_date, usage_per_portion, average_daily_usage, safety_stock)
  values (v_charles, v_cat_x, v_v1, 4, 7.00, 84.00,
     222, '2026-09-02', 0.7, 4.4, 1.1)
  returning id into v_item_charles;

  -- SECOND brand B (admin's brand_id is 2AM → cannot see B).
  insert into public.brands (id, name) values (v_brand_b, '__spec122_brand_b__')
  on conflict (id) do nothing;
  insert into public.stores (id, brand_id, name) values (v_store_b, v_brand_b, '__spec122_store_b__')
  on conflict (id) do nothing;
  insert into public.catalog_ingredients (brand_id, name, unit, category)
  values (v_brand_b, '__spec122_ingredient_y__', 'ea', 'test')
  returning id into v_cat_y;
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, par_level, cost_per_unit, case_price, current_stock)
  values (v_store_b, v_cat_y, v_v1, 9, 11.00, 132.00, 333)
  returning id into v_item_b;

  perform set_config('t.cat_x',        v_cat_x::text,        false);
  perform set_config('t.cat_y',        v_cat_y::text,        false);
  perform set_config('t.item_towson',  v_item_towson::text,  false);
  perform set_config('t.item_charles', v_item_charles::text, false);
  perform set_config('t.item_b',       v_item_b::text,       false);
  perform set_config('t.frederick',    v_frederick::text,    false);
  perform set_config('t.reisters',     v_reisters::text,     false);
end $$;

-- ─── (0) non-privileged caller rejected BEFORE any side effect ──────────────
-- manager@local.test (2222…, role=user, brand_id=2AM) — can see the brand but
-- is not privileged → 'privileged only'.
set local role authenticated;
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated", "app_metadata": {"role": "user"}}';
select throws_ok(
  format($$select public.apply_item_scalars_to_brand(%L::uuid, 480, 20.00, 240.00)$$,
    current_setting('t.cat_x')),
  'privileged only',
  '(0) non-privileged (role=user) caller is rejected with `privileged only`'
);
reset role;

-- ─── admin runs the fan-out (overwrite par 480, cost 20, case 240) ──────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "app_metadata": {"role": "admin"}}';
do $$
declare r jsonb;
begin
  r := public.apply_item_scalars_to_brand(
    current_setting('t.cat_x')::uuid, 480, 20.00, 240.00);
  perform set_config('t.result', r::text, false);
end $$;

-- ─── (1) cross-brand rejection: admin CANNOT apply to brand B's catalog ─────
select throws_ok(
  format($$select public.apply_item_scalars_to_brand(%L::uuid, 1, 1, 1)$$,
    current_setting('t.cat_y')),
  'brand not accessible',
  '(1) admin cannot apply to a catalog in a brand it cannot see (never cross-brand)'
);

-- ─── (2) bad catalog id rejected ────────────────────────────────────────────
select throws_ok(
  $$select public.apply_item_scalars_to_brand('00000000-0000-0000-0000-0000000000ff'::uuid, 1, 1, 1)$$,
  'catalog ingredient not found',
  '(2) an unknown catalog id is rejected'
);
reset role;

-- ─── return-shape assertions (read t.result stashed by the do-block) ────────
select is(
  (current_setting('t.result')::jsonb ->> 'updated_count')::int, 2,
  '(3) updated_count = 2 (Towson + Charles both overwritten)'
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

-- ─── OVERWRITE assertions (postgres role — RLS-bypassing reads) ─────────────
-- par_level overwritten on BOTH stores (AC-3/AC-7), incl. Charles which had a
-- DIFFERENT par (4) — guards against a developer copy-pasting 119's preserve.
select is(
  (select par_level from public.inventory_items where id = current_setting('t.item_towson')::uuid),
  480::numeric,
  '(6) Towson: par_level OVERWRITTEN to 480'
);
select is(
  (select par_level from public.inventory_items where id = current_setting('t.item_charles')::uuid),
  480::numeric,
  '(7) Charles: par_level OVERWRITTEN to 480 (was 4 — overwrite, not preserve)'
);
-- cost + case_price overwritten on BOTH stores (AC-7), incl. Charles which had
-- DIFFERENT prices (7.00 / 84.00) — overwrite not preserve.
select is(
  (select cost_per_unit from public.inventory_items where id = current_setting('t.item_towson')::uuid),
  20.00::numeric,
  '(8) Towson: cost_per_unit OVERWRITTEN to 20.00'
);
select is(
  (select cost_per_unit from public.inventory_items where id = current_setting('t.item_charles')::uuid),
  20.00::numeric,
  '(9) Charles: cost_per_unit OVERWRITTEN to 20.00 (was 7.00 — overwrite)'
);
select is(
  (select case_price from public.inventory_items where id = current_setting('t.item_charles')::uuid),
  240.00::numeric,
  '(10) Charles: case_price OVERWRITTEN to 240.00 (was 84.00 — overwrite)'
);

-- ─── AC-5/AC-6: current_stock + count-like fields NEVER touched ─────────────
-- Charles seeded current_stock 222; must remain 222 after the fan-out.
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_charles')::uuid),
  222::numeric,
  '(11) Charles: current_stock UNCHANGED (222) — AC-5 never fans out'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_towson')::uuid),
  111::numeric,
  '(12) Towson: current_stock UNCHANGED (111) — AC-5 never fans out'
);
select is(
  (select array[
     expiry_date::text,
     usage_per_portion::text,
     average_daily_usage::text,
     safety_stock::text]
     from public.inventory_items where id = current_setting('t.item_charles')::uuid),
  array['2026-09-02', '0.7000', '4.4', '1.1'],
  '(13) Charles: expiry/usage/avg-daily/safety all UNCHANGED — AC-6 count-like never fans out'
);

-- ─── NULL-means-skip: par fans out, cost left alone ─────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "app_metadata": {"role": "admin"}}';
do $$
begin
  perform public.apply_item_scalars_to_brand(
    current_setting('t.cat_x')::uuid, 7, null, null);
end $$;
reset role;
select is(
  (select par_level from public.inventory_items where id = current_setting('t.item_charles')::uuid),
  7::numeric,
  '(14) NULL-means-skip: par_level still fans out (overwritten to 7)'
);
select is(
  (select cost_per_unit from public.inventory_items where id = current_setting('t.item_charles')::uuid),
  20.00::numeric,
  '(15) NULL-means-skip: cost_per_unit LEFT ALONE (still 20.00, the p_cost_per_unit => null no-op)'
);

-- ─── cross-brand item completely untouched (never-cross-brand, AC-8) ────────
select is(
  (select par_level from public.inventory_items where id = current_setting('t.item_b')::uuid),
  9::numeric,
  '(16) brand-B item par_level unchanged (no cross-brand write)'
);
select is(
  (select cost_per_unit from public.inventory_items where id = current_setting('t.item_b')::uuid),
  11.00::numeric,
  '(17) brand-B item cost_per_unit unchanged (no cross-brand write)'
);

select * from finish();

rollback;

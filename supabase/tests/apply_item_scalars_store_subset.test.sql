-- supabase/tests/apply_item_scalars_store_subset.test.sql
--
-- Ingredient Save store-scope picker — pgTAP coverage for the p_store_ids
-- param added to public.apply_item_scalars_to_brand in
-- supabase/migrations/20261115120000_apply_item_scalars_store_subset.sql.
--
-- The 4-arg (NULL ⇒ all stores) path stays covered by
-- apply_item_scalars_to_brand.test.sql, which still calls with 4 args.
--
-- Fixtures (seeded under postgres, rolled back):
--   • A FRESH catalog ingredient X in the 2AM brand with rows in Towson +
--     Charles ONLY (Frederick + Reisters have none).
--   • A second brand B + store + catalog Y + item admin cannot see.
-- The subset call picks [Charles, Frederick, brand-B store]:
--   Charles overwritten, Towson untouched, Frederick skipped, brand B untouched.

begin;
create extension if not exists pgtap;

select plan(10);

do $$
declare
  v_brand_a      uuid := '2a000000-0000-0000-0000-000000000001';
  v_brand_b      uuid := 'beeff00d-0000-0000-0000-000000000200';
  v_store_b      uuid := 'beeff00d-0000-0000-0000-0000000002c2';
  v_towson       uuid;
  v_charles      uuid;
  v_frederick    uuid;
  v_reisters     uuid;
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

  insert into public.catalog_ingredients (brand_id, name, unit, category)
  values (v_brand_a, '__store_subset_ingredient_x__', 'ea', 'test')
  returning id into v_cat_x;

  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, par_level, cost_per_unit, case_price, current_stock)
  values (v_towson, v_cat_x, v_v1, 4, 5.00, 60.00, 111)
  returning id into v_item_towson;
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, par_level, cost_per_unit, case_price, current_stock)
  values (v_charles, v_cat_x, v_v1, 4, 7.00, 84.00, 222)
  returning id into v_item_charles;

  insert into public.brands (id, name) values (v_brand_b, '__store_subset_brand_b__')
  on conflict (id) do nothing;
  insert into public.stores (id, brand_id, name, address)
    values (v_store_b, v_brand_b, '__store_subset_store_b__', '1 Fixture Way')
  on conflict (id) do nothing;
  insert into public.catalog_ingredients (brand_id, name, unit, category)
  values (v_brand_b, '__store_subset_ingredient_y__', 'ea', 'test')
  returning id into v_cat_y;
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, par_level, cost_per_unit, case_price, current_stock)
  values (v_store_b, v_cat_y, v_v1, 9, 11.00, 132.00, 333)
  returning id into v_item_b;

  perform set_config('t.cat_x',        v_cat_x::text,        false);
  perform set_config('t.item_towson',  v_item_towson::text,  false);
  perform set_config('t.item_charles', v_item_charles::text, false);
  perform set_config('t.item_b',       v_item_b::text,       false);
  perform set_config('t.charles',      v_charles::text,      false);
  perform set_config('t.frederick',    v_frederick::text,    false);
  perform set_config('t.reisters',     v_reisters::text,     false);
  perform set_config('t.store_b',      v_store_b::text,      false);
end $$;

-- ─── admin: subset call [Charles, Frederick, brand-B store] ─────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "app_metadata": {"role": "admin"}}';
do $$
declare r jsonb;
begin
  r := public.apply_item_scalars_to_brand(
    current_setting('t.cat_x')::uuid, 480, 20.00, 240.00,
    array[current_setting('t.charles')::uuid,
          current_setting('t.frederick')::uuid,
          current_setting('t.store_b')::uuid]);
  perform set_config('t.result', r::text, false);
end $$;

-- (1) empty store list is rejected, not a silent no-op
select throws_ok(
  format($$select public.apply_item_scalars_to_brand(%L::uuid, 1, 1, 1, '{}'::uuid[])$$,
    current_setting('t.cat_x')),
  'no stores selected',
  '(1) an empty p_store_ids array is rejected with `no stores selected`'
);
reset role;

-- (2) non-privileged caller still rejected on the 5-arg path
set local role authenticated;
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated", "app_metadata": {"role": "user"}}';
select throws_ok(
  format($$select public.apply_item_scalars_to_brand(%L::uuid, 1, 1, 1, array[%L::uuid])$$,
    current_setting('t.cat_x'), current_setting('t.charles')),
  'privileged only',
  '(2) non-privileged caller is rejected on the store-subset path'
);
reset role;

select is(
  (current_setting('t.result')::jsonb ->> 'updated_count')::int, 1,
  '(3) updated_count = 1 (only Charles among the picked stores has a row)'
);
select is(
  (current_setting('t.result')::jsonb ->> 'skipped_count')::int, 1,
  '(4) skipped_count = 1 (only the picked Frederick; unpicked Reisters is not reported)'
);
select is(
  (current_setting('t.result')::jsonb -> 'skipped_store_ids'),
  to_jsonb(array[current_setting('t.frederick')]),
  '(5) skipped_store_ids is exactly [Frederick]'
);

select is(
  (select array[par_level, cost_per_unit, case_price]
     from public.inventory_items where id = current_setting('t.item_charles')::uuid),
  array[480, 20.00, 240.00]::numeric[],
  '(6) picked Charles: par/cost/case OVERWRITTEN'
);
select is(
  (select array[par_level, cost_per_unit, case_price]
     from public.inventory_items where id = current_setting('t.item_towson')::uuid),
  array[4, 5.00, 60.00]::numeric[],
  '(7) unpicked Towson: par/cost/case UNCHANGED'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_charles')::uuid),
  222::numeric,
  '(8) picked Charles: current_stock UNCHANGED (never fans out)'
);
select is(
  (select array[par_level, cost_per_unit, case_price]
     from public.inventory_items where id = current_setting('t.item_b')::uuid),
  array[9, 11.00, 132.00]::numeric[],
  '(9) brand-B store id in the list does not reach across brands'
);

-- (10) the 5-arg signature exists and the 4-arg one is gone (no overload)
select is(
  (select array_agg(pg_get_function_identity_arguments(p.oid)::text)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_item_scalars_to_brand'),
  array['p_catalog_id uuid, p_par_level numeric, p_cost_per_unit numeric, p_case_price numeric, p_store_ids uuid[]'],
  '(10) exactly one apply_item_scalars_to_brand overload, with p_store_ids'
);

select * from finish();

rollback;

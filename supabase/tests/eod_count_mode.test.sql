-- supabase/tests/eod_count_mode.test.sql
--
-- Spec 171 — per-ingredient EOD count mode. pgTAP coverage for migration
-- 20261023000000_catalog_eod_count_mode.sql (design §1, §2, §3, §11, R2).
--
--   Schema (AC-1/AC-2/AC-3)
--     (1)  column exists                       (2) type text
--     (3)  NOT NULL                            (4) default 'cases_and_units'
--     (5)  UPDATE to 'cases'  → 23514          (6) UPDATE to ''  → 23514
--     (7)  UPDATE to NULL     → 23502          (8) INSERT 'bogus' → 23514
--     (9)  the three valid literals are accepted
--     (10) every pre-existing row reads 'cases_and_units' (backfilled by the
--          default; none NULL). Runs BEFORE any fixture mutation.
--     (11) a row inserted with the column omitted reads 'cases_and_units'
--   Staff principal (AC-4) — manager@local.test, profiles.role='user',
--   user_stores grant on Frederick; JWT shape mirrors
--   staff_role_eod_rls.test.sql.
--     (12) reads eod_count_mode through the item_vendors → inventory_items
--          → catalog_ingredients join (the staff fetch's embed path); every
--          visible row carries a non-null mode
--     (13) the staff read sees the admin-set 'units_only' value on the
--          fixture item (proves the column value, not just the column, is
--          readable)
--     (14) staff UPDATE of eod_count_mode affects 0 rows
--     (15) …and the stored value is unchanged afterwards
--   RPC create_inventory_item_with_catalog (design §3, §11 a-e, R2)
--     (16) (a) p_eod_count_mode => 'units_only' lands on the column
--     (17) (a) …and the returned catalog.eod_count_mode carries it
--     (18) (b) omitted → 'cases_and_units'
--     (19) (c) 'bogus' on a NEW name raises 23514
--     (20) (d) the find-existing path does NOT overwrite an existing mode
--     (21) (e) anon lacks EXECUTE on the 13-arg signature
--     (22) (e) PUBLIC lacks EXECUTE on the 13-arg signature
--     (23) (e) authenticated has EXECUTE on the 13-arg signature
--     (24) R2: exactly ONE pg_proc row named create_inventory_item_with_catalog
--          (no surviving 12-arg overload → no PGRST203 for legacy callers)
--     (25) SECURITY INVOKER preserved (prosecdef = false)
--
-- Privilege arms use has_function_privilege catalog queries (not
-- `set local role anon`), the get_profile_emails.test.sql idiom.
--
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(25);

-- ─── (10) AC-3 backfill — BEFORE any fixture mutation ──────────────────────
select is(
  (select count(*)::int
     from public.catalog_ingredients
    where eod_count_mode is distinct from 'cases_and_units'),
  0,
  '(10) every pre-existing catalog_ingredients row reads cases_and_units (AC-3)'
);

-- ─── fixtures ──────────────────────────────────────────────────────────────
do $$
declare
  v_admin_id   uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';  -- seed staff (role=user)
  v_brand_id   uuid;
  v_frederick  uuid;
  v_towson     uuid;
  v_item_cat   uuid;
begin
  select brand_id into v_brand_id from public.profiles where id = v_admin_id;
  if v_brand_id is null then
    raise exception 'seed admin (11111111-...) has no brand_id — cannot run spec 171 arms';
  end if;

  -- manager@local.test has user_stores on Towson + Frederick only.
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_towson    from public.stores where name = 'Towson'    limit 1;
  if v_frederick is null or v_towson is null then
    raise exception 'seed stores Frederick/Towson missing — cannot run spec 171 arms';
  end if;

  -- A catalog row reachable by the staff principal through the
  -- item_vendors → inventory_items (Frederick) → catalog_ingredients path.
  select i.catalog_id into v_item_cat
    from public.item_vendors iv
    join public.inventory_items i on i.id = iv.item_id
   where i.store_id = v_frederick
   order by i.id
   limit 1;
  if v_item_cat is null then
    raise exception 'no Frederick item_vendors row in seed — cannot run AC-4 arms';
  end if;

  -- Admin-set mode on the fixture row (as postgres; hermetic rollback).
  update public.catalog_ingredients set eod_count_mode = 'units_only' where id = v_item_cat;

  perform set_config('test.admin_id',   v_admin_id::text,   true);
  perform set_config('test.manager_id', v_manager_id::text, true);
  perform set_config('test.brand_id',   v_brand_id::text,   true);
  perform set_config('test.frederick',  v_frederick::text,  true);
  perform set_config('test.towson',     v_towson::text,     true);
  perform set_config('test.item_cat',   v_item_cat::text,   true);
end $$;

-- ─── (1)-(4) AC-1 column shape ─────────────────────────────────────────────
select has_column('public', 'catalog_ingredients', 'eod_count_mode',
  '(1) catalog_ingredients.eod_count_mode exists (AC-1)');
select col_type_is('public', 'catalog_ingredients', 'eod_count_mode', 'text',
  '(2) eod_count_mode is text (AC-1)');
select col_not_null('public', 'catalog_ingredients', 'eod_count_mode',
  '(3) eod_count_mode is NOT NULL (AC-1)');
select col_default_is('public', 'catalog_ingredients', 'eod_count_mode', 'cases_and_units'::text,
  '(4) eod_count_mode defaults to cases_and_units (AC-1)');

-- ─── (5)-(9) AC-2 CHECK + NOT NULL enforcement ─────────────────────────────
select throws_ok(
  format($q$update public.catalog_ingredients set eod_count_mode = 'cases' where id = %L$q$,
         current_setting('test.item_cat', true)),
  '23514', null,
  '(5) UPDATE eod_count_mode = ''cases'' raises 23514 (AC-2)'
);
select throws_ok(
  format($q$update public.catalog_ingredients set eod_count_mode = '' where id = %L$q$,
         current_setting('test.item_cat', true)),
  '23514', null,
  '(6) UPDATE eod_count_mode = '''' raises 23514 (AC-2)'
);
select throws_ok(
  format($q$update public.catalog_ingredients set eod_count_mode = null where id = %L$q$,
         current_setting('test.item_cat', true)),
  '23502', null,
  '(7) UPDATE eod_count_mode = NULL raises 23502 (AC-2)'
);
select throws_ok(
  format($q$insert into public.catalog_ingredients (brand_id, name, unit, eod_count_mode)
            values (%L, '__test_spec171_bogus_insert', 'each', 'bogus')$q$,
         current_setting('test.brand_id', true)),
  '23514', null,
  '(8) INSERT eod_count_mode = ''bogus'' raises 23514 (AC-2)'
);
select lives_ok(
  format($q$
    update public.catalog_ingredients set eod_count_mode = 'cases_and_units' where id = %1$L;
    update public.catalog_ingredients set eod_count_mode = 'cases_only'      where id = %1$L;
    update public.catalog_ingredients set eod_count_mode = 'units_only'      where id = %1$L;
  $q$, current_setting('test.item_cat', true)),
  '(9) the three literals cases_and_units / cases_only / units_only are accepted (AC-2)'
);

-- ─── (11) AC-3 omitted column on INSERT → default ─────────────────────────
insert into public.catalog_ingredients (brand_id, name, unit)
values (current_setting('test.brand_id', true)::uuid, '__test_spec171_default_insert', 'each');

select is(
  (select eod_count_mode
     from public.catalog_ingredients
    where brand_id = current_setting('test.brand_id', true)::uuid
      and name = '__test_spec171_default_insert'),
  'cases_and_units',
  '(11) a row inserted with eod_count_mode omitted reads cases_and_units (AC-3)'
);

-- ─── (12)-(15) AC-4 staff principal ───────────────────────────────────────
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

-- Same path the staff fetch embeds: item_vendors → inventory_items!inner
-- (this store) → catalog_ingredients. Every visible row must carry a mode.
select ok(
  (select count(*) > 0
          and count(*) = count(c.eod_count_mode)
     from public.item_vendors iv
     join public.inventory_items i on i.id = iv.item_id
     join public.catalog_ingredients c on c.id = i.catalog_id
    where i.store_id = current_setting('test.frederick', true)::uuid),
  '(12) staff reads eod_count_mode through item_vendors → inventory_items → catalog_ingredients (AC-4)'
);

select is(
  (select c.eod_count_mode
     from public.item_vendors iv
     join public.inventory_items i on i.id = iv.item_id
     join public.catalog_ingredients c on c.id = i.catalog_id
    where i.store_id = current_setting('test.frederick', true)::uuid
      and c.id = current_setting('test.item_cat', true)::uuid
    limit 1),
  'units_only',
  '(13) staff sees the admin-set units_only value on the fixture item (AC-4)'
);

-- Staff UPDATE: the privileged_update_catalog_ingredients policy filters the
-- target row out, so the statement affects 0 rows (no error).
with upd as (
  update public.catalog_ingredients
     set eod_count_mode = 'cases_only'
   where id = current_setting('test.item_cat', true)::uuid
  returning 1
)
select set_config('test.staff_upd_count', (select count(*)::text from upd), true);

select is(
  current_setting('test.staff_upd_count', true),
  '0',
  '(14) staff UPDATE of catalog_ingredients.eod_count_mode affects 0 rows (AC-4)'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select eod_count_mode from public.catalog_ingredients
    where id = current_setting('test.item_cat', true)::uuid),
  'units_only',
  '(15) stored eod_count_mode is unchanged after the staff UPDATE attempt (AC-4)'
);

-- ─── (16)-(20) RPC arms, under the admin JWT ───────────────────────────────
-- Admin JWT so the inventory_items insert passes the per-store WITH CHECK.
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

-- (a) explicit units_only
do $$
declare
  v_result jsonb;
begin
  v_result := public.create_inventory_item_with_catalog(
    p_brand_id       => current_setting('test.brand_id', true)::uuid,
    p_store_id       => current_setting('test.towson', true)::uuid,
    p_name           => '__test_spec171_rpc_units_only',
    p_unit           => 'each',
    p_case_qty       => 24,
    p_eod_count_mode => 'units_only'
  );
  perform set_config('test.rpc_a_return_mode',
    coalesce(v_result->'catalog'->>'eod_count_mode', '<missing>'), true);
end $$;

select is(
  (select eod_count_mode from public.catalog_ingredients
    where brand_id = current_setting('test.brand_id', true)::uuid
      and lower(name) = '__test_spec171_rpc_units_only'),
  'units_only',
  '(16) RPC threads p_eod_count_mode => units_only into catalog_ingredients (AC-18 create)'
);

select is(
  current_setting('test.rpc_a_return_mode', true),
  'units_only',
  '(17) RPC return shape exposes catalog.eod_count_mode (mapItem hydration path)'
);

-- (b) omitted → default
do $$
begin
  perform public.create_inventory_item_with_catalog(
    p_brand_id => current_setting('test.brand_id', true)::uuid,
    p_store_id => current_setting('test.towson', true)::uuid,
    p_name     => '__test_spec171_rpc_default',
    p_unit     => 'each'
  );
end $$;

select is(
  (select eod_count_mode from public.catalog_ingredients
    where brand_id = current_setting('test.brand_id', true)::uuid
      and lower(name) = '__test_spec171_rpc_default'),
  'cases_and_units',
  '(18) RPC without p_eod_count_mode defaults to cases_and_units (legacy-caller compat)'
);

-- (c) bogus on a NEW name → CHECK
select throws_ok(
  format($q$select public.create_inventory_item_with_catalog(
              p_brand_id       => %L::uuid,
              p_store_id       => %L::uuid,
              p_name           => '__test_spec171_rpc_bogus',
              p_eod_count_mode => 'bogus')$q$,
         current_setting('test.brand_id', true),
         current_setting('test.towson', true)),
  '23514', null,
  '(19) RPC with p_eod_count_mode => ''bogus'' on a new name raises 23514'
);

-- (d) find-existing does NOT overwrite: the units_only row from (a) is
-- re-used from a different store with a different requested mode.
do $$
begin
  perform public.create_inventory_item_with_catalog(
    p_brand_id       => current_setting('test.brand_id', true)::uuid,
    p_store_id       => current_setting('test.frederick', true)::uuid,
    p_name           => '__test_spec171_rpc_units_only',
    p_unit           => 'each',
    p_eod_count_mode => 'cases_only'
  );
end $$;

select is(
  (select eod_count_mode from public.catalog_ingredients
    where brand_id = current_setting('test.brand_id', true)::uuid
      and lower(name) = '__test_spec171_rpc_units_only'),
  'units_only',
  '(20) RPC find-existing path does NOT overwrite an existing row''s eod_count_mode'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- ─── (21)-(25) RPC privilege posture + overload uniqueness ────────────────
select ok(
  not has_function_privilege('anon',
    'public.create_inventory_item_with_catalog(uuid, uuid, text, text, text, numeric, numeric, text, numeric, numeric, jsonb, jsonb, text)',
    'EXECUTE'),
  '(21) anon lacks EXECUTE on the 13-arg create_inventory_item_with_catalog'
);
select ok(
  not has_function_privilege('public',
    'public.create_inventory_item_with_catalog(uuid, uuid, text, text, text, numeric, numeric, text, numeric, numeric, jsonb, jsonb, text)',
    'EXECUTE'),
  '(22) PUBLIC lacks EXECUTE on the 13-arg create_inventory_item_with_catalog'
);
select ok(
  has_function_privilege('authenticated',
    'public.create_inventory_item_with_catalog(uuid, uuid, text, text, text, numeric, numeric, text, numeric, numeric, jsonb, jsonb, text)',
    'EXECUTE'),
  '(23) authenticated has EXECUTE on the 13-arg create_inventory_item_with_catalog'
);
select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_inventory_item_with_catalog'),
  1,
  '(24) exactly one create_inventory_item_with_catalog overload (no PGRST203 ambiguity)'
);
select is(
  (select p.prosecdef from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_inventory_item_with_catalog'),
  false,
  '(25) create_inventory_item_with_catalog stays SECURITY INVOKER'
);

select * from finish();
rollback;

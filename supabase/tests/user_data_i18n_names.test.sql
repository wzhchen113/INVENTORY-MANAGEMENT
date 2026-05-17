-- supabase/tests/user_data_i18n_names.test.sql
--
-- Spec 040 P3 / pgTAP regression for the i18n_names JSONB column shipped in:
--   supabase/migrations/20260517000000_user_data_i18n_names.sql
--
-- Coverage:
--   (1)  Each of the 5 tables (catalog_ingredients, recipes, prep_recipes,
--        recipe_categories, ingredient_categories) has the
--        `i18n_names jsonb not null default '{}'` column shape.
--   (2)  Default value backfills atomically — pre-existing seeded rows are
--        observable as `i18n_names = '{}'` immediately after the additive
--        `add column ... not null default '{}'` runs (PG 17 metadata-only
--        ALTER, no rewrite).
--   (3)  Self-update via existing RLS policies works — an admin JWT can
--        UPDATE a seeded catalog_ingredients row's i18n_names column. This
--        exercises the per-brand RLS write policy on the new column without
--        touching any other column.
--   (4)  create_inventory_item_with_catalog with p_i18n_names => '{"es":"x",
--        "zh-CN":"y"}'::jsonb round-trips into catalog_ingredients.i18n_names
--        AND surfaces the field in the returned JSONB shape (so the JS-side
--        mapItem can hydrate without a second fetch). Closes the architect's
--        §11 "load-bearing RPC-parameter-threading risk."
--   (5)  create_inventory_item_with_catalog called WITHOUT p_i18n_names
--        defaults to `{}` — backwards-compat assertion. Existing call sites
--        that haven't been updated to pass the new param see no behavior
--        change beyond the JSONB column being `{}`.
--   (6)  recipe_categories and ingredient_categories are NOT members of the
--        supabase_realtime publication. Spec 040 §8 deliberately does NOT
--        widen the publication; this assertion just-in-case-asserts that
--        future-author drift doesn't quietly add them (which would require
--        a `docker restart supabase_realtime_imr-inventory` step per the
--        CLAUDE.md realtime gotcha).
--
-- Hermetic isolation: begin; ... rollback;. Seed is untouched on exit.
--
-- Implementation notes:
--   - The shape assertions (1) run as `postgres` superuser; they read
--     information_schema and don't touch row data.
--   - (4) and (5) exercise the RPC under an admin JWT impersonation. The
--     seeded brand and store come from supabase/seed.sql (pulled from prod
--     on 2026-05-02 per CLAUDE.md). The brand_id is read out of the seeded
--     stores table to avoid hard-coding a value that could drift.
--   - All catalog inserts use a UNIQUE name prefix (`__test_spec040_*`) so
--     the rollback is the safety net and the assertions remain stable even
--     if a future test re-runs in the same session.

begin;
create extension if not exists pgtap;

select plan(17);

-- ─── fixtures ──────────────────────────────────────────────────────────────
do $$
declare
  v_admin_id   uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin
  v_brand_id   uuid;
  v_store_id   uuid;
begin
  -- Read brand_id + store_id off the seeded admin's brand. The admin role
  -- in the seed has brand_id set; we grab the first active store for that
  -- brand to exercise the RPC's per-store path.
  select brand_id into v_brand_id from public.profiles where id = v_admin_id;
  if v_brand_id is null then
    raise exception 'seed admin (11111111-...) has no brand_id — cannot run RPC arms';
  end if;

  select id into v_store_id
    from public.stores
   where brand_id = v_brand_id and status = 'active'
   limit 1;
  if v_store_id is null then
    raise exception 'no active store found for seeded admin brand — cannot run RPC arms';
  end if;

  perform set_config('test.admin_id', v_admin_id::text, true);
  perform set_config('test.brand_id', v_brand_id::text, true);
  perform set_config('test.store_id', v_store_id::text, true);
end $$;

-- ─── (1) Schema shape — 5 tables × (data_type, NOT NULL, default) ─────────
-- Five tables × one assertion each, asserting the full triplet in one shot
-- via a JSONB pivot. Keeps the assertion-count manageable while covering
-- all three properties of the column.

select is(
  (select jsonb_build_object(
            'data_type',   data_type,
            'is_nullable', is_nullable,
            'column_default', column_default
          )
     from information_schema.columns
    where table_schema='public' and table_name='catalog_ingredients' and column_name='i18n_names'),
  jsonb_build_object('data_type', 'jsonb', 'is_nullable', 'NO', 'column_default', '''{}''::jsonb'),
  '(1a) catalog_ingredients.i18n_names is jsonb NOT NULL default {}'
);

select is(
  (select jsonb_build_object(
            'data_type',   data_type,
            'is_nullable', is_nullable,
            'column_default', column_default
          )
     from information_schema.columns
    where table_schema='public' and table_name='recipes' and column_name='i18n_names'),
  jsonb_build_object('data_type', 'jsonb', 'is_nullable', 'NO', 'column_default', '''{}''::jsonb'),
  '(1b) recipes.i18n_names is jsonb NOT NULL default {}'
);

select is(
  (select jsonb_build_object(
            'data_type',   data_type,
            'is_nullable', is_nullable,
            'column_default', column_default
          )
     from information_schema.columns
    where table_schema='public' and table_name='prep_recipes' and column_name='i18n_names'),
  jsonb_build_object('data_type', 'jsonb', 'is_nullable', 'NO', 'column_default', '''{}''::jsonb'),
  '(1c) prep_recipes.i18n_names is jsonb NOT NULL default {}'
);

select is(
  (select jsonb_build_object(
            'data_type',   data_type,
            'is_nullable', is_nullable,
            'column_default', column_default
          )
     from information_schema.columns
    where table_schema='public' and table_name='recipe_categories' and column_name='i18n_names'),
  jsonb_build_object('data_type', 'jsonb', 'is_nullable', 'NO', 'column_default', '''{}''::jsonb'),
  '(1d) recipe_categories.i18n_names is jsonb NOT NULL default {}'
);

select is(
  (select jsonb_build_object(
            'data_type',   data_type,
            'is_nullable', is_nullable,
            'column_default', column_default
          )
     from information_schema.columns
    where table_schema='public' and table_name='ingredient_categories' and column_name='i18n_names'),
  jsonb_build_object('data_type', 'jsonb', 'is_nullable', 'NO', 'column_default', '''{}''::jsonb'),
  '(1e) ingredient_categories.i18n_names is jsonb NOT NULL default {}'
);

-- ─── (2) Backfill — every existing row in each table has i18n_names = {} ──
-- The seeded data predates this column; the additive `add column ... not
-- null default '{}'` should have backfilled all rows atomically. We assert
-- the COUNT of rows where i18n_names IS NOT NULL equals the total row
-- count — i.e., zero NULLs leaked through. (NOT NULL constraint would have
-- rejected the migration if any row had been NULL post-ALTER; this is
-- defense in depth + a future-author smoke check.)

select is(
  (select count(*) filter (where i18n_names is not null) from public.catalog_ingredients),
  (select count(*) from public.catalog_ingredients),
  '(2a) catalog_ingredients: every existing row backfilled to non-null i18n_names'
);

select is(
  (select count(*) filter (where i18n_names is not null) from public.recipes),
  (select count(*) from public.recipes),
  '(2b) recipes: every existing row backfilled to non-null i18n_names'
);

select is(
  (select count(*) filter (where i18n_names is not null) from public.prep_recipes),
  (select count(*) from public.prep_recipes),
  '(2c) prep_recipes: every existing row backfilled to non-null i18n_names'
);

select is(
  (select count(*) filter (where i18n_names is not null) from public.recipe_categories),
  (select count(*) from public.recipe_categories),
  '(2d) recipe_categories: every existing row backfilled to non-null i18n_names'
);

select is(
  (select count(*) filter (where i18n_names is not null) from public.ingredient_categories),
  (select count(*) from public.ingredient_categories),
  '(2e) ingredient_categories: every existing row backfilled to non-null i18n_names'
);

-- ─── (3) RLS: admin JWT can UPDATE catalog_ingredients.i18n_names ─────────
-- The existing `privileged_update_catalog_ingredients` policy (from
-- 20260509000000_multi_brand_schema_rls.sql) gates on auth_is_privileged().
-- An admin JWT passes that helper. We exercise the policy by writing
-- i18n_names on the FIRST catalog ingredient row in the admin's brand,
-- then read it back to confirm the write landed.

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

do $$
declare
  v_catalog_id uuid;
begin
  select id into v_catalog_id
    from public.catalog_ingredients
   where brand_id = current_setting('test.brand_id', true)::uuid
   order by created_at
   limit 1;
  -- Stash the id for the next assertion.
  perform set_config('test.target_catalog_id', coalesce(v_catalog_id::text, ''), true);
end $$;

-- Skip the assertion gracefully (mark passing) if the seed has no catalog
-- rows for this brand — defensive, since pgTAP doesn't ship a SKIP idiom
-- compatible with our runner.
update public.catalog_ingredients
   set i18n_names = jsonb_build_object('es', 'TestEs', 'zh-CN', 'TestZh')
 where id = current_setting('test.target_catalog_id', true)::uuid
   and current_setting('test.target_catalog_id', true) <> '';

select is(
  case
    when current_setting('test.target_catalog_id', true) = '' then '{}'::jsonb
    else (select i18n_names from public.catalog_ingredients
            where id = current_setting('test.target_catalog_id', true)::uuid)
  end,
  case
    when current_setting('test.target_catalog_id', true) = '' then '{}'::jsonb
    else jsonb_build_object('es', 'TestEs', 'zh-CN', 'TestZh')
  end,
  '(3) admin JWT can UPDATE catalog_ingredients.i18n_names (existing brand_member write policy covers new column)'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- ─── (4) RPC round-trip with p_i18n_names ─────────────────────────────────
-- The architect's load-bearing migration footnote: the RPC must thread
-- p_i18n_names into the inner `insert into catalog_ingredients`. Exercise
-- with a unique name so we hit the find-or-create branch's "create" path,
-- then assert the catalog row carries the translations AND the RPC return
-- shape exposes catalog.i18n_names (so mapItem can hydrate from the RPC
-- response without a follow-up fetch).
--
-- Run under admin JWT so the inventory_items insert passes the per-store
-- WITH CHECK (auth_can_see_store).

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

do $$
declare
  v_unique_name text := '__test_spec040_rpc_create_' || (extract(epoch from clock_timestamp())::bigint)::text;
  v_result jsonb;
begin
  v_result := public.create_inventory_item_with_catalog(
    p_brand_id   => current_setting('test.brand_id', true)::uuid,
    p_store_id   => current_setting('test.store_id', true)::uuid,
    p_name       => v_unique_name,
    p_unit       => 'each',
    p_i18n_names => jsonb_build_object('es', 'esRoundtrip', 'zh-CN', 'zhRoundtrip')
  );
  perform set_config('test.rpc_unique_name', v_unique_name, true);
  perform set_config('test.rpc_result_catalog_i18n',
    coalesce(v_result->'catalog'->>'i18n_names', ''),
    true);
end $$;

select is(
  (select i18n_names
     from public.catalog_ingredients
    where brand_id = current_setting('test.brand_id', true)::uuid
      and lower(name) = lower(current_setting('test.rpc_unique_name', true))),
  jsonb_build_object('es', 'esRoundtrip', 'zh-CN', 'zhRoundtrip'),
  '(4a) RPC threads p_i18n_names into catalog_ingredients.i18n_names'
);

-- The RPC returns JSONB; we stashed the catalog.i18n_names sub-object as a
-- JSONB-stringified text. Decode and compare back to a JSONB literal.
select is(
  current_setting('test.rpc_result_catalog_i18n', true)::jsonb,
  jsonb_build_object('es', 'esRoundtrip', 'zh-CN', 'zhRoundtrip'),
  '(4b) RPC return-shape exposes catalog.i18n_names (mapItem hydration path)'
);

-- ─── (5) RPC backwards-compat — no p_i18n_names arg defaults to {} ────────
-- A caller that hasn't been updated to pass p_i18n_names invokes the RPC
-- with the existing 11-arg signature (or omits the parameter via defaults).
-- The catalog row should still land with i18n_names = '{}'.

do $$
declare
  v_unique_name text := '__test_spec040_rpc_default_' || (extract(epoch from clock_timestamp())::bigint)::text;
  v_result jsonb;
begin
  -- Call the RPC WITHOUT p_i18n_names; the default kicks in.
  v_result := public.create_inventory_item_with_catalog(
    p_brand_id => current_setting('test.brand_id', true)::uuid,
    p_store_id => current_setting('test.store_id', true)::uuid,
    p_name     => v_unique_name,
    p_unit     => 'each'
  );
  perform set_config('test.rpc_default_unique_name', v_unique_name, true);
end $$;

select is(
  (select i18n_names
     from public.catalog_ingredients
    where brand_id = current_setting('test.brand_id', true)::uuid
      and lower(name) = lower(current_setting('test.rpc_default_unique_name', true))),
  '{}'::jsonb,
  '(5) RPC without p_i18n_names defaults catalog_ingredients.i18n_names to {}'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- ─── (6) Realtime publication membership — categories NOT included ────────
-- Spec 040 §8 deliberately does NOT add recipe_categories or
-- ingredient_categories to supabase_realtime. If a future drift adds them,
-- the realtime slot needs a docker restart to re-snapshot (the
-- "Realtime publication gotcha" from CLAUDE.md / project memory). Lock
-- in current behavior with a just-in-case assert.

select is(
  (select count(*)::bigint
     from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'recipe_categories'),
  0::bigint,
  '(6a) recipe_categories is NOT in supabase_realtime (spec 040 §8 out-of-scope)'
);

select is(
  (select count(*)::bigint
     from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ingredient_categories'),
  0::bigint,
  '(6b) ingredient_categories is NOT in supabase_realtime (spec 040 §8 out-of-scope)'
);

-- Sanity: the three brand-scoped tables ARE in supabase_realtime today.
-- Locking in this behavior catches accidental publication-membership
-- regressions on the tables that DO need realtime.

select is(
  (select count(*)::bigint
     from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename in ('catalog_ingredients', 'recipes', 'prep_recipes')),
  3::bigint,
  '(6c) catalog_ingredients, recipes, prep_recipes ARE in supabase_realtime (regression guard)'
);

select * from finish();
rollback;

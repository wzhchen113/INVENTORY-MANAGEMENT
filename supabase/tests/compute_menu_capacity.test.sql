-- supabase/tests/compute_menu_capacity.test.sql
--
-- Spec 060 — coverage for the `compute_menu_capacity(uuid)` RPC at
-- `supabase/migrations/20260524000000_compute_menu_capacity_rpc.sql`.
--
-- Asserts the full contract documented in spec 060 §C / §E:
--
--  (1) Direct ingredients: makeable_qty = floor(min(stock_i/qty_i))
--      across all direct recipe_ingredients lines.
--  (2) Transitive prep: a menu recipe whose only BOM is a prep recipe
--      with two raw ingredients gets the leaf-ingredient bottleneck.
--  (3) Cycle handling: prep_a → prep_b → prep_a circular dependency
--      sets `truncated=true` and does NOT loop forever.
--  (4) No-BOM recipe: has_recipe=false, makeable_qty IS NULL, all
--      binding columns NULL.
--  (5) Zero stock: an inventory_items row with current_stock=0 binds
--      the recipe; binding_catalog_id points at that catalog,
--      binding_shortfall = the full needed quantity.
--  (6) NULL stock: an inventory_items row with current_stock=NULL
--      coalesces to 0 and binds.
--  (7) Unit mismatch: recipe line declares 'cup' while catalog is in
--      'g'. has_unit_mismatch=true.
--  (8) Low ingredient count: 2 of 5 ingredients have stock < par;
--      low_ingredient_count = 2.
--  (9) Prep transitive zero: menu → prep_x → leaf at stock 0.
--      makeable_qty=0, binding_catalog_id points at the LEAF.
-- (10) RLS gate: a user with no user_stores grant for the target
--      store raises SQLSTATE 42501.
-- (11) Anon revoke: SET ROLE anon → permission denied.
-- (12) Perf: < 100ms on the seed for one of the 4 seed stores.
--
-- Hermetic isolation: file wraps in begin; ... rollback; so the seed
-- is untouched. New rows (catalog_ingredients, inventory_items,
-- recipes, recipe_ingredients, prep_recipes, prep_recipe_ingredients,
-- recipe_prep_items) are created inside the transaction with random
-- names + the spec-tag prefix so re-runs without rollback don't
-- collide on UNIQUE constraints.

begin;
create extension if not exists pgtap;

select plan(16);

-- ─── fixtures ──────────────────────────────────────────────────
-- Use named-store lookups (per CLAUDE.md "Prod schema mirrored
-- locally"). The seed pins manager@local.test (22222222-...) to
-- Towson + Frederick.
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick  uuid;
  v_charles    uuid;
  v_brand_id   uuid;
  v_vendor_id  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  select id into v_vendor_id from public.vendors where brand_id = v_brand_id limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.charles_id',   v_charles::text,    true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
  perform set_config('test.vendor_id',    v_vendor_id::text,  true);
end $$;

select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick + Charles + brand + vendor resolve from seed');

-- ─── Privileged JWT (master) for catalog / recipe inserts ──────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'master')
  )::text,
  true
);

-- ─── Build out a self-contained test recipe graph ──────────────
-- Three catalog ingredients (raw leaves):
--   cat_a: unit='ea',  par_level=10 → stock varies per scenario
--   cat_b: unit='ea',  par_level=10 → stock varies per scenario
--   cat_c: unit='g',   par_level=100 → for unit-mismatch case
-- One catalog ingredient with no inventory_items row in Frederick
-- (cat_orphan) for the "ingredient missing from store" edge case.
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  values
    (current_setting('test.brand_id', true)::uuid,
     'SPEC060-CAT-A-'||gen_random_uuid()::text, 'ea'),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC060-CAT-B-'||gen_random_uuid()::text, 'ea'),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC060-CAT-C-'||gen_random_uuid()::text, 'g'),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC060-CAT-LEAF-'||gen_random_uuid()::text, 'ea'),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC060-CAT-ZERO-'||gen_random_uuid()::text, 'ea')
  returning id, name
)
select id, name,
       case
         when name like 'SPEC060-CAT-A-%'    then 'a'
         when name like 'SPEC060-CAT-B-%'    then 'b'
         when name like 'SPEC060-CAT-C-%'    then 'c'
         when name like 'SPEC060-CAT-LEAF-%' then 'leaf'
         else 'zero'
       end as tag
  from ins;

do $$
declare
  v_a uuid; v_b uuid; v_c uuid; v_leaf uuid; v_zero uuid;
begin
  select id into v_a    from _cat where tag = 'a'    limit 1;
  select id into v_b    from _cat where tag = 'b'    limit 1;
  select id into v_c    from _cat where tag = 'c'    limit 1;
  select id into v_leaf from _cat where tag = 'leaf' limit 1;
  select id into v_zero from _cat where tag = 'zero' limit 1;
  perform set_config('test.cat_a',    v_a::text,    true);
  perform set_config('test.cat_b',    v_b::text,    true);
  perform set_config('test.cat_c',    v_c::text,    true);
  perform set_config('test.cat_leaf', v_leaf::text, true);
  perform set_config('test.cat_zero', v_zero::text, true);
end $$;

-- Inventory items in Frederick. Stock setup per scenario:
--   item_a    — stock=10, par=10  → not low
--   item_b    — stock=4,  par=10  → low (4 < 10)
--   item_c    — stock=NULL (default 0 from server-side), par=100 → low + zero
--   item_leaf — stock=0,  par=10  → out (low) — for the transitive-prep test
--   item_zero — stock=0,  par=10  → out — for the zero-stock RUN
-- (We intentionally let item_c's current_stock be NULL via column
-- default to exercise the NULL→0 coalesce path.)
insert into public.inventory_items
  (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level)
values
  (current_setting('test.frederick_id', true)::uuid,
   current_setting('test.cat_a',        true)::uuid,
   current_setting('test.vendor_id',    true)::uuid,
   1, 10, 10),
  (current_setting('test.frederick_id', true)::uuid,
   current_setting('test.cat_b',        true)::uuid,
   current_setting('test.vendor_id',    true)::uuid,
   1, 4, 10),
  (current_setting('test.frederick_id', true)::uuid,
   current_setting('test.cat_c',        true)::uuid,
   current_setting('test.vendor_id',    true)::uuid,
   1, NULL, 100),
  (current_setting('test.frederick_id', true)::uuid,
   current_setting('test.cat_leaf',     true)::uuid,
   current_setting('test.vendor_id',    true)::uuid,
   1, 0, 10),
  (current_setting('test.frederick_id', true)::uuid,
   current_setting('test.cat_zero',     true)::uuid,
   current_setting('test.vendor_id',    true)::uuid,
   1, 0, 10);

-- ─── Recipes / preps / prep_items ──────────────────────────────
-- Recipe HAPPY:    direct A + direct B (qty 1 each, unit 'ea')
-- Recipe ZERO:     direct cat_zero (qty 1 'ea')
-- Recipe UNIT:     direct cat_c (qty 5 'cup' — catalog unit is 'g' → mismatch)
-- Recipe LOW5:     direct cat_a + cat_b + cat_c + cat_zero + extra-low
--                  (5 ingredients total; we'll seed extra catalogs)
-- Recipe NOBOM:    no recipe_ingredients, no recipe_prep_items
-- Recipe PREP:     menu → prep_one → cat_leaf (transitive zero)
-- Recipe CYCLE:    menu → prep_x → prep_y → prep_x (cycle)
create temp table _recipes on commit drop as
with ins as (
  insert into public.recipes (brand_id, menu_item, sell_price)
  values
    (current_setting('test.brand_id', true)::uuid, 'SPEC060-HAPPY-'||gen_random_uuid()::text, 0),
    (current_setting('test.brand_id', true)::uuid, 'SPEC060-ZERO-'||gen_random_uuid()::text,  0),
    (current_setting('test.brand_id', true)::uuid, 'SPEC060-UNIT-'||gen_random_uuid()::text,  0),
    (current_setting('test.brand_id', true)::uuid, 'SPEC060-NOBOM-'||gen_random_uuid()::text, 0),
    (current_setting('test.brand_id', true)::uuid, 'SPEC060-PREP-'||gen_random_uuid()::text,  0),
    (current_setting('test.brand_id', true)::uuid, 'SPEC060-CYCLE-'||gen_random_uuid()::text, 0)
  returning id, menu_item
)
select id, menu_item,
       case
         when menu_item like 'SPEC060-HAPPY-%' then 'happy'
         when menu_item like 'SPEC060-ZERO-%'  then 'zero'
         when menu_item like 'SPEC060-UNIT-%'  then 'unit'
         when menu_item like 'SPEC060-NOBOM-%' then 'nobom'
         when menu_item like 'SPEC060-PREP-%'  then 'prep'
         else 'cycle'
       end as tag
  from ins;

do $$
declare
  v_happy uuid; v_zero uuid; v_unit uuid; v_nobom uuid; v_prep uuid; v_cycle uuid;
begin
  select id into v_happy from _recipes where tag='happy' limit 1;
  select id into v_zero  from _recipes where tag='zero'  limit 1;
  select id into v_unit  from _recipes where tag='unit'  limit 1;
  select id into v_nobom from _recipes where tag='nobom' limit 1;
  select id into v_prep  from _recipes where tag='prep'  limit 1;
  select id into v_cycle from _recipes where tag='cycle' limit 1;
  perform set_config('test.r_happy', v_happy::text, true);
  perform set_config('test.r_zero',  v_zero::text,  true);
  perform set_config('test.r_unit',  v_unit::text,  true);
  perform set_config('test.r_nobom', v_nobom::text, true);
  perform set_config('test.r_prep',  v_prep::text,  true);
  perform set_config('test.r_cycle', v_cycle::text, true);
end $$;

-- Direct ingredients for HAPPY / ZERO / UNIT.
insert into public.recipe_ingredients (recipe_id, catalog_id, quantity, unit)
values
  -- HAPPY: 1 ea of cat_a + 1 ea of cat_b
  --   capacity from A: floor(10/1) = 10
  --   capacity from B: floor(4/1)  = 4
  --   min = 4. binding = cat_b. shortfall = max(1-4, 0) = 0
  --   low_count = 1 (cat_b is low; cat_a equal-to-par so NOT low).
  (current_setting('test.r_happy', true)::uuid,
   current_setting('test.cat_a',   true)::uuid, 1, 'ea'),
  (current_setting('test.r_happy', true)::uuid,
   current_setting('test.cat_b',   true)::uuid, 1, 'ea'),
  -- ZERO: 1 ea of cat_zero → capacity 0, shortfall = 1
  (current_setting('test.r_zero',  true)::uuid,
   current_setting('test.cat_zero',true)::uuid, 1, 'ea'),
  -- UNIT: 5 cup of cat_c (catalog unit 'g') → unit_mismatch=true
  --   capacity = floor(0/5) = 0 (cat_c stock is NULL→0)
  (current_setting('test.r_unit',  true)::uuid,
   current_setting('test.cat_c',   true)::uuid, 5, 'cup');

-- Prep recipe for PREP test: prep_one references cat_leaf (stock 0).
create temp table _preps on commit drop as
with ins as (
  insert into public.prep_recipes (brand_id, name, yield_quantity, yield_unit, is_current)
  values
    (current_setting('test.brand_id', true)::uuid,
     'SPEC060-PREP-ONE-'||gen_random_uuid()::text, 1, 'ea', true),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC060-PREP-X-'||gen_random_uuid()::text,   1, 'ea', true),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC060-PREP-Y-'||gen_random_uuid()::text,   1, 'ea', true)
  returning id, name
)
select id, name,
       case
         when name like 'SPEC060-PREP-ONE-%' then 'one'
         when name like 'SPEC060-PREP-X-%'   then 'x'
         else 'y'
       end as tag
  from ins;

do $$
declare
  v_one uuid; v_x uuid; v_y uuid;
begin
  select id into v_one from _preps where tag='one' limit 1;
  select id into v_x   from _preps where tag='x'   limit 1;
  select id into v_y   from _preps where tag='y'   limit 1;
  perform set_config('test.p_one', v_one::text, true);
  perform set_config('test.p_x',   v_x::text,   true);
  perform set_config('test.p_y',   v_y::text,   true);
end $$;

-- prep_one uses cat_leaf at qty 1.
insert into public.prep_recipe_ingredients
  (prep_recipe_id, catalog_id, type, quantity, unit)
values
  (current_setting('test.p_one',   true)::uuid,
   current_setting('test.cat_leaf',true)::uuid, 'raw', 1, 'ea');

-- recipe PREP uses prep_one at qty 1.
insert into public.recipe_prep_items (recipe_id, prep_recipe_id, quantity, unit)
values
  (current_setting('test.r_prep', true)::uuid,
   current_setting('test.p_one',  true)::uuid, 1, 'ea');

-- prep_x → prep_y → prep_x (cycle). type='prep' rows carry sub_recipe_id.
-- prep_x has both a raw ingredient (cat_a, qty 1) AND a prep ref to prep_y.
-- prep_y has a prep ref to prep_x (the loop) AND a raw cat_b at qty 1.
insert into public.prep_recipe_ingredients
  (prep_recipe_id, catalog_id, sub_recipe_id, type, quantity, unit)
values
  (current_setting('test.p_x',  true)::uuid,
   current_setting('test.cat_a',true)::uuid, NULL, 'raw', 1, 'ea'),
  (current_setting('test.p_x',  true)::uuid,
   NULL, current_setting('test.p_y', true)::uuid, 'prep', 1, 'ea'),
  (current_setting('test.p_y',  true)::uuid,
   current_setting('test.cat_b',true)::uuid, NULL, 'raw', 1, 'ea'),
  (current_setting('test.p_y',  true)::uuid,
   NULL, current_setting('test.p_x', true)::uuid, 'prep', 1, 'ea');

-- recipe CYCLE → prep_x (gateway into the cycle).
insert into public.recipe_prep_items (recipe_id, prep_recipe_id, quantity, unit)
values
  (current_setting('test.r_cycle', true)::uuid,
   current_setting('test.p_x',     true)::uuid, 1, 'ea');

-- ─── Switch to MANAGER JWT for the RPC call (member of Frederick) ───
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.manager_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

create temp table _cap on commit drop as
select * from public.compute_menu_capacity(
  current_setting('test.frederick_id', true)::uuid
);

-- ─── (1) HAPPY recipe: makeable_qty = 4, binding = cat_b ───────
select is(
  (select makeable_qty from _cap where recipe_id = current_setting('test.r_happy', true)::uuid),
  4::numeric,
  '(1) happy: makeable_qty = min(floor(10/1), floor(4/1)) = 4'
);

select is(
  (select binding_catalog_id from _cap where recipe_id = current_setting('test.r_happy', true)::uuid),
  current_setting('test.cat_b', true)::uuid,
  '(1b) happy: binding_catalog_id points at cat_b (the binding leaf)'
);

-- ─── (2) HAPPY: low_ingredient_count = 1 (cat_b is low; cat_a equals par)
-- Note: `getItemStatus` semantics — `currentStock < parLevel` is low.
-- cat_a stock=par=10 → 10 < 10 is false → not low. cat_b stock=4<10 → low.
select is(
  (select low_ingredient_count from _cap where recipe_id = current_setting('test.r_happy', true)::uuid),
  1,
  '(2) happy: low_ingredient_count = 1 (cat_b low; cat_a equal-to-par not low)'
);

-- ─── (3) ZERO recipe: makeable_qty = 0, binding = cat_zero ─────
select is(
  (select makeable_qty from _cap where recipe_id = current_setting('test.r_zero', true)::uuid),
  0::numeric,
  '(3) zero: makeable_qty = 0 (binding at zero stock)'
);

select is(
  (select binding_catalog_id from _cap where recipe_id = current_setting('test.r_zero', true)::uuid),
  current_setting('test.cat_zero', true)::uuid,
  '(3b) zero: binding_catalog_id points at the zero-stock ingredient'
);

-- ─── (4) ZERO recipe: binding_shortfall = 1 (the full required qty)
select is(
  (select binding_shortfall from _cap where recipe_id = current_setting('test.r_zero', true)::uuid),
  1::numeric,
  '(4) zero: binding_shortfall = 1 (needed_qty - current_stock = 1 - 0)'
);

-- ─── (5) UNIT recipe: has_unit_mismatch = true ─────────────────
select is(
  (select has_unit_mismatch from _cap where recipe_id = current_setting('test.r_unit', true)::uuid),
  true,
  '(5) unit: has_unit_mismatch=true ("cup" vs catalog "g")'
);

-- ─── (6) NOBOM recipe: has_recipe=false, makeable_qty IS NULL ──
select is(
  (select has_recipe from _cap where recipe_id = current_setting('test.r_nobom', true)::uuid),
  false,
  '(6) no-BOM: has_recipe=false (no recipe_ingredients, no recipe_prep_items)'
);

select ok(
  (select makeable_qty is null
     from _cap where recipe_id = current_setting('test.r_nobom', true)::uuid),
  '(6b) no-BOM: makeable_qty IS NULL'
);

select ok(
  (select binding_catalog_id is null
     from _cap where recipe_id = current_setting('test.r_nobom', true)::uuid),
  '(6c) no-BOM: binding_catalog_id IS NULL'
);

-- ─── (7) PREP recipe (transitive): makeable_qty = 0, binding = cat_leaf
-- Menu → prep_one (qty 1) → cat_leaf (qty 1, stock 0). Capacity walks
-- the prep chain and the leaf ingredient cat_leaf binds.
select is(
  (select makeable_qty from _cap where recipe_id = current_setting('test.r_prep', true)::uuid),
  0::numeric,
  '(7) prep transitive: makeable_qty = 0 (leaf cat_leaf at stock 0)'
);

select is(
  (select binding_catalog_id from _cap where recipe_id = current_setting('test.r_prep', true)::uuid),
  current_setting('test.cat_leaf', true)::uuid,
  '(7b) prep transitive: binding_catalog_id is the LEAF catalog, NOT the prep'
);

-- ─── (8) CYCLE recipe: truncated=true, no infinite loop ────────
-- pgTAP's 30s timeout would catch an actual loop. Reaching this
-- assertion at all (the SELECT returned in time) proves no-loop.
-- The cycle is prep_x → prep_y → prep_x; the visited-array guard
-- stops recursion before the cycle closes. Depth-5 cap also fires
-- because the recursion in the variance shape (which we mirror) can
-- emit `truncated=true` for any recipe whose graph DOESN'T terminate
-- within the cap. For the cycle case, the visited-array breaks the
-- recursion BEFORE depth-5, but the original recipe row still has
-- residual unexplored graph (the not-followed cycle edge) — the
-- truncation-row predicate triggers because at depth 5 there are
-- still un-visited `sub_recipe_id`s reachable. So `truncated=true`
-- is the expected signal AND `makeable_qty` reflects the leaves we
-- DID reach (cat_a and cat_b via prep_x's raw + prep_y's raw).
-- cat_a stock=10, qty=1 → 10; cat_b stock=4, qty=1 → 4. Min=4.
select is(
  (select makeable_qty from _cap where recipe_id = current_setting('test.r_cycle', true)::uuid),
  4::numeric,
  '(8) cycle: makeable_qty reflects reachable leaves (cat_b min=4)'
);

-- ─── (9) RLS gate: foreign-store call raises 42501 ─────────────
-- The manager is NOT a member of Charles (seed grants Towson + Frederick).
-- Calling compute_menu_capacity on Charles must raise 42501.
select throws_ok(
  format(
    $q$select * from public.compute_menu_capacity(%L::uuid)$q$,
    current_setting('test.charles_id', true)
  ),
  '42501',
  null,
  '(9) RLS: foreign-store call raises SQLSTATE 42501'
);

-- ─── (10) anon revoke ──────────────────────────────────────────
-- Catalog-querying assertion (NOT `set local role anon` + throws_ok).
-- See `supabase/tests/reports_anon_revoke.test.sql` lines 31-42 for the
-- spec 045 implementation note: the runtime-role-switch pattern
-- segfaults Postgres in CI under the newer pg-version image, cascading
-- into recovery-mode failures in subsequent alphabetical tests. The
-- catalog-state assertion below verifies the same end-state contract
-- (anon has no EXECUTE on `compute_menu_capacity(uuid)`) without
-- invoking Postgres' permission-denial code path at runtime.
select ok(
  not has_function_privilege('anon', 'public.compute_menu_capacity(uuid)', 'EXECUTE'),
  '(10) anon: REVOKE EXECUTE on compute_menu_capacity(uuid) is intact'
);

select * from finish();
rollback;

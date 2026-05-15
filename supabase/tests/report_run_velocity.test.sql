-- supabase/tests/report_run_velocity.test.sql
--
-- Spec 036 — coverage for `public.report_run_velocity(uuid, jsonb)` from
-- `supabase/migrations/20260515120000_report_run_velocity.sql`. Asserts:
--
--   • Auth gate raises 42501 for a non-member store (mirrors
--     `report_run_vendor.test.sql` (3)).
--   • Empty-range short-circuit returns populated columns + empty
--     kpis/rows/series.
--   • Per-row formula on a single fixture insert: qty_sold / window_days
--     (the load-bearing velocity denominator — see arm 8 too).
--   • Multi-recipe ordering by revenue DESC (recipe ASC tiebreaker).
--   • Unmapped POS rows (recipe_id IS NULL OR recipe_mapped = false)
--     are excluded — mirrors the COGS exclude-unmapped policy.
--   • Velocity ratio across multi-day window — LOAD-BEARING denominator
--     check: 30 sold over 30-day window must yield velocity 1.000, NOT
--     30/day_count=30. This is the assertion that distinguishes
--     `qty_sold / window_days` from `qty_sold / day_count`.
--   • by='category' smoke — column[0].key flips and rows[0] has the
--     'category' + 'recipes_count' keys.
--   • Top mover KPI cross-cuts: re-call with by='category' and the
--     KPI value still starts with the top-revenue recipe's menu_item.
--   • Envelope shape: sorted-key list = [columns, kpis, rows, series].
--
-- Fixture pattern mirrors `report_run_vendor.test.sql`: Frederick store
-- named lookup, manager JWT 22222222-..., hermetic `begin; ... rollback;`.
-- Fixture biz_date '2026-06-01' is AFTER the seed pull date (2026-05-02)
-- so seed-collision regressions surface immediately if a future seed
-- back-dates POS history into the test's window.

begin;
create extension if not exists pgtap;

select plan(11);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_charles    uuid;
  v_brand_id   uuid;
  v_recipe_a   uuid;
  v_recipe_b   uuid;
begin
  select id, brand_id
    into v_frederick, v_brand_id
    from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;

  -- Two distinct recipes for Frederick's brand. Recipes are brand-scoped
  -- per the brand-catalog refactor (20260504072830_brand_catalog_p3_lockdown);
  -- `recipes.store_id` was dropped in that migration. The runner reads
  -- recipes via the brand-scoped SELECT policy and joins by recipe_id
  -- (which originates from `pos_import_items.recipe_id`). Stable across
  -- seed refreshes — the seed has multiple recipes per brand. If <2 exist,
  -- the fixture inserts them.
  select id into v_recipe_a
    from public.recipes
   where brand_id = v_brand_id
   order by menu_item asc, id asc
   limit 1;
  select id into v_recipe_b
    from public.recipes
   where brand_id = v_brand_id
     and id <> v_recipe_a
   order by menu_item asc, id asc
   limit 1;

  -- If the seed doesn't have two recipes for this brand, insert fixtures.
  -- Stable across seed evolution. Note `recipes.menu_item` has a brand-level
  -- unique constraint (recipes_brand_menu_item_unique) so we suffix with
  -- 'TEST36' to avoid colliding with any seeded recipe of the same name.
  if v_recipe_a is null then
    insert into public.recipes (brand_id, menu_item, category)
      values (v_brand_id, 'TEST36 RECIPE A', 'Test36')
      returning id into v_recipe_a;
  end if;
  if v_recipe_b is null then
    insert into public.recipes (brand_id, menu_item, category)
      values (v_brand_id, 'TEST36 RECIPE B', 'Test36')
      returning id into v_recipe_b;
  end if;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.charles_id',   v_charles::text,    true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
  perform set_config('test.recipe_a',     v_recipe_a::text,   true);
  perform set_config('test.recipe_b',     v_recipe_b::text,   true);
end $$;

-- (1) Fixture sanity: Frederick store id resolves from seed.
select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick store id resolves from seed');

-- (2) Fixture sanity: Two distinct Frederick recipes resolve.
select isnt(current_setting('test.recipe_b', true), '',
  'fixture: two distinct Frederick recipes resolve from seed');

-- ─── Impersonate manager (member of Towson + Frederick) ──────
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

-- (3) Auth gate: manager calling Charles (non-member store) raises 42501.
select throws_ok(
  format(
    $q$select public.report_run_velocity(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.charles_id', true)
  ),
  '42501',
  null,
  'report_run_velocity raises 42501 for a non-member store (manager calling Charles)'
);

-- (4) Empty range — call with from = to = '2000-01-01' (no POS rows in
-- seed for that date). Envelope must have populated columns AND empty
-- kpis/rows/series.
create temp table _empty_env on commit drop as
select public.report_run_velocity(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2000-01-01', 'to', '2000-01-01', 'by', 'recipe')
) as env;

select is(
  jsonb_build_object(
    'kpis_len',    jsonb_array_length(env->'kpis'),
    'rows_len',    jsonb_array_length(env->'rows'),
    'series_len',  jsonb_array_length(env->'series'),
    'cols_typeof', jsonb_typeof(env->'columns'),
    'cols_first',  env->'columns'->0->>'key'
  ),
  jsonb_build_object(
    'kpis_len',    0,
    'rows_len',    0,
    'series_len',  0,
    'cols_typeof', 'array',
    'cols_first',  'recipe'
  ),
  'empty range: kpis/rows/series all empty arrays; columns populated for by=recipe'
) from _empty_env;

-- ─── Insert fixture POS rows ─────────────────────────────────
-- Import on 2026-06-01 (AFTER the 2026-05-02 seed pull date so
-- seed-collision regressions surface immediately).
--   Line 1 — recipe A, qty_sold=30, revenue=150.00, recipe_mapped=true
--             → primary single-row formula fixture.
--   Line 2 — recipe B, qty_sold=10, revenue=50.00, recipe_mapped=true
--             → multi-recipe ordering (B < A by revenue).
--   Line 3 — recipe_id IS NULL, qty_sold=99, revenue=999.00 → unmapped
--             (must be excluded).
--   Line 4 — recipe A, qty_sold=7, revenue=70.00, recipe_mapped=false
--             → unmapped (must be excluded). Recipe A's totals stay
--             qty_sold=30 / revenue=150.
do $$
declare
  v_import_id uuid := gen_random_uuid();
begin
  insert into public.pos_imports (id, store_id, import_date, imported_at)
  values (
    v_import_id,
    current_setting('test.frederick_id', true)::uuid,
    '2026-06-01'::date,
    '2026-06-01 12:00:00+00'::timestamptz
  );

  insert into public.pos_import_items (import_id, menu_item, qty_sold, revenue, recipe_id, recipe_mapped)
  values
    (v_import_id, 'Recipe A line',
       30, 150.00,
       current_setting('test.recipe_a', true)::uuid, true),
    (v_import_id, 'Recipe B line',
       10,  50.00,
       current_setting('test.recipe_b', true)::uuid, true),
    (v_import_id, 'Unmapped line (NULL recipe_id)',
       99, 999.00,
       NULL, false),
    (v_import_id, 'Unmapped line (recipe_mapped=false)',
        7,  70.00,
       current_setting('test.recipe_a', true)::uuid, false);

  perform set_config('test.import_id', v_import_id::text, true);
end $$;

-- ─── Resolve recipe A's menu_item label (used across multiple arms) ──
do $$
declare
  v_a_label text;
  v_a_category text;
begin
  select menu_item, coalesce(nullif(trim(category), ''), '(uncategorized)')
    into v_a_label, v_a_category
  from public.recipes
  where id = current_setting('test.recipe_a', true)::uuid;
  perform set_config('test.recipe_a_label',    v_a_label,    true);
  perform set_config('test.recipe_a_category', v_a_category, true);
end $$;

-- ─── Call the runner: closed 1-day window 2026-06-01 .. 2026-06-01 ──
create temp table _env on commit drop as
select public.report_run_velocity(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-06-01', 'to', '2026-06-01', 'by', 'recipe')
) as env;

-- (5) Single-row formula assertion (bundled with the Total qty / Total
-- revenue KPI sanity check — mirrors vendor test arm (5)'s "bundled"
-- shape; see migration design notes and the vendor test header comment
-- block for the plan(11)-vs-plan(12) note).
-- Asserts:
--   - Total qty sold KPI = '40.000' (recipe A's 30 + recipe B's 10;
--     the unmapped 99 and the recipe_mapped=false 7 are excluded — see
--     arm 6 for the explicit assertion).
--   - Total revenue $ KPI = '$200.00' (150 + 50 — same exclusion).
--   - rows[recipe=A].recipe = recipe A's menu_item label.
--   - rows[recipe=A].qty_sold = '30.000'.
--   - rows[recipe=A].revenue = '$150.00'.
--   - rows[recipe=A].day_count = 1.
--   - rows[recipe=A].velocity = '30.000' (30 sold / 1-day window =
--     30/day on average — the load-bearing window_days denominator).
select is(
  (
    select jsonb_build_object(
      'total_qty',     (select k->>'value' from jsonb_array_elements(env->'kpis') k
                         where k->>'label' = 'Total qty sold' limit 1),
      'total_revenue', (select k->>'value' from jsonb_array_elements(env->'kpis') k
                         where k->>'label' = 'Total revenue $' limit 1),
      'a_recipe',      (select r->>'recipe' from jsonb_array_elements(env->'rows') r
                         where r->>'recipe' = current_setting('test.recipe_a_label', true) limit 1),
      'a_qty',         (select r->>'qty_sold' from jsonb_array_elements(env->'rows') r
                         where r->>'recipe' = current_setting('test.recipe_a_label', true) limit 1),
      'a_revenue',     (select r->>'revenue' from jsonb_array_elements(env->'rows') r
                         where r->>'recipe' = current_setting('test.recipe_a_label', true) limit 1),
      'a_days',        (select (r->>'day_count')::int from jsonb_array_elements(env->'rows') r
                         where r->>'recipe' = current_setting('test.recipe_a_label', true) limit 1),
      'a_velocity',    (select r->>'velocity' from jsonb_array_elements(env->'rows') r
                         where r->>'recipe' = current_setting('test.recipe_a_label', true) limit 1)
    ) from _env
  ),
  jsonb_build_object(
    'total_qty',     '40.000',
    'total_revenue', '$200.00',
    'a_recipe',      current_setting('test.recipe_a_label', true),
    'a_qty',         '30.000',
    'a_revenue',     '$150.00',
    'a_days',        1,
    'a_velocity',    '30.000'
  ),
  'per-row formula + bundled KPI sanity (plan(11) consolidation, code-reviewer spec 036 S2 ack): recipe A row = $150 / 30 qty / velocity 30.000 (1-day window); Total qty=40.000 / Total revenue=$200.00 reflect A+B (recipe B contributes 10 / $50)'
);

-- (6) Unmapped POS rows excluded — load-bearing for the velocity
-- runner (mirrors the COGS exclude-unmapped policy). Both unmapped
-- rows (the NULL recipe_id line and the recipe_mapped=false line)
-- contribute neither qty nor revenue to the headlines, AND neither
-- shows up in `rows`. Without the filter, total_qty would be
-- 30+10+99+7 = 146 and total_revenue would be 150+50+999+70 = 1269.
-- We re-assert rows_len + totals explicitly so a future refactor that
-- loosens the filter surfaces here with a precise error.
select is(
  (
    select jsonb_build_object(
      'rows_len',      jsonb_array_length(env->'rows'),
      'total_qty',     (select k->>'value' from jsonb_array_elements(env->'kpis') k
                         where k->>'label' = 'Total qty sold' limit 1),
      'total_revenue', (select k->>'value' from jsonb_array_elements(env->'kpis') k
                         where k->>'label' = 'Total revenue $' limit 1)
    ) from _env
  ),
  jsonb_build_object(
    'rows_len',      2,
    'total_qty',     '40.000',
    'total_revenue', '$200.00'
  ),
  'unmapped rows excluded: rows_len=2 (only A/B), totals = qty 40.000 + revenue $200 (NULL recipe_id and recipe_mapped=false dropped)'
);

-- (7) Multi-recipe ordering — recipe A ($150) before recipe B ($50)
-- by revenue DESC. Mirrors vendor test arm (6).
select is(
  (
    select array_agg(r->>'recipe' order by ord)
      from (
        select r, ord
          from _env, jsonb_array_elements(env->'rows') with ordinality as t(r, ord)
      ) ordered_rows
  ),
  array[
    current_setting('test.recipe_a_label', true),
    (select menu_item from public.recipes where id = current_setting('test.recipe_b', true)::uuid)
  ]::text[],
  'rows ordered by revenue DESC: recipe A ($150) before recipe B ($50)'
);

-- ─── Extend the window to 30 days WITHOUT inserting new rows ────────
create temp table _env_wide on commit drop as
select public.report_run_velocity(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-06-01', 'to', '2026-06-30', 'by', 'recipe')
) as env;

-- (8) Velocity ratio across multi-day window — LOAD-BEARING per
-- architect §A12 / PM AC line 301-309. Denominator is window_days
-- (30), not day_count (still 1). Recipe A's qty_sold stays 30, so
-- velocity becomes 30 / 30 = 1.000. If a regression flipped the
-- denominator to day_count, velocity would still be 30/1 = 30.000
-- and this arm would fail. Test name MUST include "denominator is
-- window_days not day_count" so a reviewer scanning failures sees
-- the contract immediately.
select is(
  (
    select jsonb_build_object(
      'a_velocity',  (select r->>'velocity' from _env_wide, jsonb_array_elements(env->'rows') r
                       where r->>'recipe' = current_setting('test.recipe_a_label', true) limit 1),
      'a_days',      (select (r->>'day_count')::int from _env_wide, jsonb_array_elements(env->'rows') r
                       where r->>'recipe' = current_setting('test.recipe_a_label', true) limit 1),
      'a_qty',       (select r->>'qty_sold' from _env_wide, jsonb_array_elements(env->'rows') r
                       where r->>'recipe' = current_setting('test.recipe_a_label', true) limit 1)
    )
  ),
  jsonb_build_object(
    'a_velocity',  '1.000',
    'a_days',      1,
    'a_qty',       '30.000'
  ),
  'velocity ratio: 30 sold over 30-day window → velocity = 1.000 (denominator is window_days not day_count)'
);

-- (9) by='category' smoke — column[0].key = 'category' and rows[0]
-- has 'category' + 'recipes_count' keys. recipes_count for the test
-- category equals the integer count of distinct recipes mapped in
-- that category over the window (recipe A's category contains both
-- recipe A and recipe B if they share a category; else just recipe A).
create temp table _env_cat on commit drop as
select public.report_run_velocity(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-06-01', 'to', '2026-06-01', 'by', 'category')
) as env;

select is(
  (
    select jsonb_build_object(
      'cols_first',                env->'columns'->0->>'key',
      'rows_first_has_category',   case when env->'rows'->0->'category' is not null then true else false end,
      'rows_first_has_recipes_ct', case when env->'rows'->0->'recipes_count' is not null then true else false end
    ) from _env_cat
  ),
  jsonb_build_object(
    'cols_first',                'category',
    'rows_first_has_category',   true,
    'rows_first_has_recipes_ct', true
  ),
  'by=category smoke: columns[0].key = ''category''; rows[0] has ''category'' + ''recipes_count'' keys'
);

-- (10) Top mover KPI cross-cuts — re-call with by='category' and
-- assert that the Top mover KPI value still starts with recipe A's
-- menu_item label. Proves the KPI is computed via the recipe
-- grouping regardless of the by-toggle. Mirrors vendor's Top vendor
-- cross-cut behaviour.
select ok(
  (
    select (k->>'value') like (current_setting('test.recipe_a_label', true) || ' · $%')
      from _env_cat, jsonb_array_elements(env->'kpis') k
     where k->>'label' = 'Top mover'
     limit 1
  ),
  'top mover KPI cross-cuts: by=category still names recipe A as the top mover (recipe-level KPI regardless of by-toggle)'
);

-- (11) Envelope shape sanity: sorted-key list matches the spec 016
-- uniform envelope. Mirrors vendor arm (11) verbatim.
select is(
  (
    select array_agg(k order by k)
      from _env, jsonb_object_keys(env) k
     where k in ('kpis', 'columns', 'rows', 'series')
  ),
  array['columns', 'kpis', 'rows', 'series']::text[],
  'envelope retains the four standard keys (kpis, columns, rows, series)'
);

select * from finish();
rollback;

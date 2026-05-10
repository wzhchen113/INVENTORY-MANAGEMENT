-- ============================================================
-- Spec 017 (REPORTS-2) — COGS template runner
--
-- Adds `report_run_cogs(uuid, jsonb)` and re-creates the dispatcher
-- `report_run(text, uuid, jsonb)` (from `20260510120000_report_runs.sql:222-256`)
-- with a new `when 'cogs'` arm. Signature unchanged so callers see no
-- surface drift.
--
-- Computes per-store cost-of-goods-sold over a date range, grouped by
-- `recipes.category` text or `recipes.menu_item`, with a single-series
-- `cogs_pct` daily trend line. Returns the uniform envelope per the
-- per-template RPC convention documented in
-- `20260510120000_report_runs.sql:21-75`.
--
-- ─── Design notes / caveats documented for reviewers ─────────
--
-- • Per-row POS smearing (Q6). `pos_imports.import_date` is the time
--   bucket key. If a single POS CSV spans multiple business days,
--   those rows roll up to the import's single date. Per-row date is
--   a separate spec.
--
-- • Missing cost policy (Q4) — PARTIAL CREDIT, FLAGGED. When ANY
--   catalog ingredient on a recipe has no `inventory_items` row for
--   `p_store_id`, OR has `cost_per_unit IS NULL`, OR has
--   `cost_per_unit = 0` after coalesce, that ingredient's
--   contribution to recipe cost is treated as 0 AND the recipe is
--   flagged. The `missing_cost` flag propagates through prep-recipe
--   nesting via `bool_or(missing_cost)` — a top-level recipe whose
--   prep-recipe leaves touch a null cost anywhere in their graph
--   carries the flag up. The flag drives:
--     (a) the `' ⚠'` suffix on the row's category/item cell, and
--     (b) the third KPI `Recipes missing cost` (tone=warn) when
--         count > 0.
--   Rationale: option (a) "skip the recipe" hides revenue from the
--   denominator and distorts COGS%. Option (b) "treat missing as 0"
--   without flagging would falsely show a great margin. Option (c)
--   "fail the run" is too brittle on real datasets.
--
-- • Hardcoded KPI tone thresholds (Q8): ok < 30%, warn 30-35%,
--   danger ≥ 35%. Per-brand or per-category targets are deferred
--   to a follow-up spec — REPORTS-2 ships sensible defaults and
--   the future spec will replace these thresholds with a
--   per-brand or per-recipe-category column.
--
-- • Prep-recipe depth cap = 5 with cycle detection on the visited
--   `prep_recipe_id` array (`prep_recipe_id = any (visited)`).
--   Real kitchens chain 2-3 levels; 5 is the belt-and-suspenders
--   bound. Exceeding the cap raises a NOTICE (not a fatal error)
--   so the report still returns whatever was computed at depth 1-5,
--   AND surfaces the truncation to the user in two places:
--     (a) a fourth KPI `Recipe graph truncated` (tone=warn) showing
--         the count of distinct top-level recipes whose chain was
--         cut off at depth 5 — hidden when count = 0.
--     (b) the row's category/item cell gets the suffix
--         `' ⚠ (truncated)'` (instead of the plain `' ⚠'` used for
--         missing-cost rows). When BOTH conditions apply to the
--         same row, the truncated suffix wins — it's the more
--         specific signal.
--   Rationale for keeping NOTICE + truncation over the architect's
--   original `raise exception ... 54001` design: a fatal raise
--   would block the entire COGS view when a single deep-chained
--   recipe exists in the brand catalog, consistent with the Q4
--   "partial credit" theme. Architect Round 2 recommended this
--   path (option 2 of the depth-cap divergence resolution).
--
-- • The NOTICE is preserved alongside the KPI for developer-log
--   visibility; postgres `RAISE NOTICE` is non-fatal and shows up
--   in `docker logs` / Supabase logs without poisoning the envelope.
--
-- • Excluded `pos_import_items` rows: `recipe_id IS NULL` OR
--   `recipe_mapped = false`. Summed revenue therefore won't equal
--   `pos_imports` totals when some menu items aren't yet mapped.
-- ============================================================

create or replace function public.report_run_cogs(
  p_store_id uuid,
  p_params   jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_from                date;
  v_to                  date;
  v_by                  text;
  v_total_revenue       numeric;
  v_total_cogs          numeric;
  v_missing_cost_count  bigint;
  v_row_count           bigint;
  v_cogs_pct            numeric;
  v_overall_value       text;
  v_overall_tone        text;
  v_margin_value        text;
  v_kpis                jsonb;
  v_columns             jsonb;
  v_rows                jsonb;
  v_series              jsonb;
  v_truncated_recipe_count bigint;
begin
  -- (1) Auth gate — same shape as the dispatcher and report_run_stub.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) Param coercion. Malformed dates raise 22007/22008 natively
  -- (invalid_text_representation / datetime_field_overflow); the
  -- frontend's runReport sanitizer maps to "Run failed — check
  -- server logs". Unknown keys in p_params are ignored.
  v_from := coalesce(
    nullif(p_params->>'from', '')::date,
    ((now() at time zone 'utc')::date - interval '30 days')::date
  );
  v_to := coalesce(
    nullif(p_params->>'to', '')::date,
    (now() at time zone 'utc')::date
  );
  v_by := coalesce(nullif(p_params->>'by', ''), 'category');
  if v_by not in ('category', 'item') then
    -- Forward-compat: silently coerce unknown values to the default.
    v_by := 'category';
  end if;

  -- (3) Range validation — structured 22023 per AC.
  if v_from > v_to then
    raise exception 'COGS report: from > to (% > %)', v_from, v_to
      using errcode = '22023';
  end if;

  -- (4) Depth-violation pre-check. Walks the prep-recipe graph
  -- carrying the top-level `recipe_id` so we can both NOTICE-log
  -- and surface a per-recipe truncation flag downstream (the
  -- `Recipe graph truncated` KPI + the row suffix). Independent
  -- of the main aggregation so the count is computed once before
  -- the bigger CTE materializes. A row in `_walk` with depth=5,
  -- non-null sub_recipe_id, and sub_recipe_id not yet visited is
  -- the "this chain would have walked further" signal — that's
  -- the truncation marker.
  with recursive _walk as (
    select rpi.recipe_id,
           rpi.prep_recipe_id,
           pri.sub_recipe_id,
           array[rpi.prep_recipe_id] as visited,
           1 as depth
      from public.recipe_prep_items rpi
      join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rpi.prep_recipe_id
     where pri.sub_recipe_id is not null
    union all
    select _w.recipe_id,
           _w.prep_recipe_id,
           pri.sub_recipe_id,
           _w.visited || _w.sub_recipe_id,
           _w.depth + 1
      from _walk _w
      join public.prep_recipe_ingredients pri on pri.prep_recipe_id = _w.sub_recipe_id
     where _w.sub_recipe_id is not null
       and not (_w.sub_recipe_id = any (_w.visited))
       and _w.depth < 5
  )
  select count(distinct recipe_id) into v_truncated_recipe_count
    from _walk
   where depth = 5
     and sub_recipe_id is not null
     and not (sub_recipe_id = any (visited));

  if v_truncated_recipe_count > 0 then
    raise notice 'COGS report: prep-recipe chain exceeds depth 5 (% recipe(s) truncated; partial cost may be undercounted)',
      v_truncated_recipe_count;
  end if;

  -- (5) Build the column header up-front so the empty-result branch
  -- can return it without re-deciding on `by`.
  if v_by = 'item' then
    v_columns := jsonb_build_array(
      jsonb_build_object('key','item',     'label','Item',     'align','left'),
      jsonb_build_object('key','category', 'label','Category', 'align','left'),
      jsonb_build_object('key','revenue',  'label','Revenue',  'align','right'),
      jsonb_build_object('key','cogs',     'label','COGS',     'align','right'),
      jsonb_build_object('key','cogs_pct', 'label','COGS %',   'align','right'),
      jsonb_build_object('key','margin',   'label','Margin',   'align','right')
    );
  else
    v_columns := jsonb_build_array(
      jsonb_build_object('key','category', 'label','Category', 'align','left'),
      jsonb_build_object('key','revenue',  'label','Revenue',  'align','right'),
      jsonb_build_object('key','cogs',     'label','COGS',     'align','right'),
      jsonb_build_object('key','cogs_pct', 'label','COGS %',   'align','right'),
      jsonb_build_object('key','margin',   'label','Margin',   'align','right')
    );
  end if;

  -- (6) Main aggregation. One CTE chain that produces (a) totals,
  -- (b) grouped rows, (c) daily series — each as a jsonb fragment.
  -- The recursive prep-flatten walks once; the planner can fuse the
  -- downstream aggregations off the same materialization.
  with recursive
  -- (6a) Direct (non-prep) ingredients per recipe, reduced to
  -- (recipe, catalog, qty). Excludes rows where catalog_id is null
  -- (none expected post-P3 lockdown but defensive).
  direct_ri as (
    select
      ri.recipe_id,
      ri.catalog_id,
      ri.quantity::numeric as qty
    from public.recipe_ingredients ri
    where ri.catalog_id is not null
  ),
  -- (6b) Recursive flatten: recipe → prep_recipe → sub_recipe → ... → catalog.
  -- BASE: top-level link from recipe_prep_items into the first prep
  -- recipe's ingredients. We carry both `catalog_id` (the leaf cost
  -- target) and `sub_recipe_id` (the descend pointer) on every row
  -- so the recursive step can choose to keep walking when
  -- sub_recipe_id is non-null.
  --
  -- STEP: descend exactly one level by joining `prep_recipe_ingredients`
  -- on the previous row's `sub_recipe_id`. Cycle detection: refuse
  -- to add a `sub_recipe_id` that's already in `visited`. Depth cap:
  -- stop at 5 iterations (already pre-flagged above).
  recursive_prep as (
    select
      rpi.recipe_id,
      pri.catalog_id,
      pri.sub_recipe_id,
      (rpi.quantity * pri.quantity)::numeric    as qty,
      array[rpi.prep_recipe_id]                 as visited,
      1                                          as depth
    from public.recipe_prep_items rpi
    join public.prep_recipe_ingredients pri
      on pri.prep_recipe_id = rpi.prep_recipe_id

    union all

    select
      rp.recipe_id,
      pri.catalog_id,
      pri.sub_recipe_id,
      (rp.qty * pri.quantity)::numeric,
      rp.visited || rp.sub_recipe_id,
      rp.depth + 1
    from recursive_prep rp
    join public.prep_recipe_ingredients pri
      on pri.prep_recipe_id = rp.sub_recipe_id
    where rp.sub_recipe_id is not null
      and not (rp.sub_recipe_id = any (rp.visited))
      and rp.depth < 5
  ),
  -- (6c) Leaf catalog ingredients only — these are what gets costed.
  prep_leaves as (
    select recipe_id, catalog_id, qty
    from recursive_prep
    where catalog_id is not null
  ),
  -- (6d) Combined per-recipe ingredient list (direct + flattened-prep).
  all_ri as (
    select recipe_id, catalog_id, sum(qty)::numeric as qty
    from (
      select * from direct_ri
      union all
      select recipe_id, catalog_id, qty from prep_leaves
    ) u
    group by recipe_id, catalog_id
  ),
  -- (6e) Per-recipe cost: Σ qty × cost_per_unit. Missing cost → 0
  -- contribution; missing_cost flag rolls up via bool_or. A recipe
  -- that touches a null/zero cost ANYWHERE in its graph (including
  -- prep-recipe nested ingredients) is flagged.
  recipe_cost as (
    select
      ari.recipe_id,
      sum(ari.qty * coalesce(ii.cost_per_unit, 0))::numeric as cost_per_unit,
      bool_or(ii.id is null or coalesce(ii.cost_per_unit, 0) = 0) as missing_cost
    from all_ri ari
    left join public.inventory_items ii
      on ii.catalog_id = ari.catalog_id
     and ii.store_id   = p_store_id
    group by ari.recipe_id
  ),
  -- (6f) POS sales rows in [v_from, v_to] for this store. Inner-join
  -- recipes so unmapped rows (recipe_id IS NULL or recipe_mapped = false)
  -- are excluded.
  sales as (
    select
      pi.import_date::date as biz_date,
      r.id                 as recipe_id,
      coalesce(nullif(trim(r.category), ''), '(uncategorized)') as category,
      r.menu_item          as item,
      pii.qty_sold::numeric                                     as qty_sold,
      pii.revenue::numeric                                      as revenue,
      pii.qty_sold::numeric * coalesce(rc.cost_per_unit, 0)     as cogs,
      coalesce(rc.missing_cost, true)                           as missing_cost
    from public.pos_imports pi
    join public.pos_import_items pii on pii.import_id = pi.id
    join public.recipes r            on r.id = pii.recipe_id
    left join recipe_cost rc         on rc.recipe_id = r.id
    where pi.store_id = p_store_id
      and pi.import_date between v_from and v_to
      and pii.recipe_id is not null
      and pii.recipe_mapped = true
  ),
  -- (6g) Headline totals — Σ over the whole window.
  totals as (
    select
      coalesce(sum(revenue), 0)::numeric                    as total_revenue,
      coalesce(sum(cogs),    0)::numeric                    as total_cogs,
      count(distinct recipe_id) filter (where missing_cost) as missing_cost_recipes,
      count(*)                                              as row_count
    from sales
  )
  select
    t.total_revenue,
    t.total_cogs,
    t.missing_cost_recipes,
    t.row_count
  into
    v_total_revenue,
    v_total_cogs,
    v_missing_cost_count,
    v_row_count
  from totals t;

  -- (7) Empty-result short-circuit. Returns populated columns,
  -- empty kpis/rows/series per AC line 99-101 (Q6 design call).
  if v_row_count = 0 then
    return jsonb_build_object(
      'kpis',    '[]'::jsonb,
      'columns', v_columns,
      'rows',    '[]'::jsonb,
      'series',  '[]'::jsonb
    );
  end if;

  -- (8) Headline KPIs.
  if v_total_revenue > 0 then
    v_cogs_pct      := v_total_cogs / v_total_revenue * 100;
    v_overall_value := to_char(v_cogs_pct, 'FM990.0') || '%';
    v_overall_tone  := case
                         when v_cogs_pct < 30 then 'ok'
                         when v_cogs_pct < 35 then 'warn'
                         else 'danger'
                       end;
  else
    -- Zero revenue but non-zero row count is unusual but possible
    -- (refunds wiping the day). Tag warn so the user notices.
    v_cogs_pct      := 0;
    v_overall_value := '0.0%';
    v_overall_tone  := 'warn';
  end if;

  v_margin_value := '$' || to_char(v_total_revenue - v_total_cogs, 'FM999,999,990.00');

  -- Build the KPI array compositionally. The first two are always
  -- present (Overall COGS % + Gross margin). The optional 3rd
  -- (`Recipes missing cost`) and 4th (`Recipe graph truncated`)
  -- KPIs append in order ONLY when their respective counts are
  -- non-zero — hidden cleanly when count = 0.
  v_kpis := jsonb_build_array(
    jsonb_build_object('label','Overall COGS %', 'value', v_overall_value, 'tone', v_overall_tone),
    jsonb_build_object('label','Gross margin',   'value', v_margin_value,  'tone', null)
  );
  if v_missing_cost_count > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object('label','Recipes missing cost', 'value', v_missing_cost_count, 'tone', 'warn')
    );
  end if;
  if v_truncated_recipe_count > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object('label','Recipe graph truncated', 'value', v_truncated_recipe_count, 'tone', 'warn')
    );
  end if;

  -- (9) Rows — server-side formatted strings to preserve decimal
  -- precision across JSON round-trips (AC line 127-129). Sorted
  -- revenue desc per AC. We re-walk the recursive prep CTE here
  -- because plpgsql doesn't let us reuse the earlier CTE between
  -- statements; the planner can still cache temp results within
  -- the call. For seed-scale data this is sub-50ms.
  --
  -- The `truncated_recipes` CTE materializes the set of top-level
  -- recipe_ids whose chain was cut off at depth 5 (i.e. the same
  -- signal counted into `v_truncated_recipe_count` above). It feeds
  -- a `truncated` bool flag through the grouping so the row's
  -- category/item cell can carry the `' ⚠ (truncated)'` suffix.
  -- The truncated suffix takes precedence over the plain `' ⚠'`
  -- missing-cost suffix when both apply.
  if v_by = 'item' then
    with recursive
    direct_ri as (
      select ri.recipe_id, ri.catalog_id, ri.quantity::numeric as qty
      from public.recipe_ingredients ri
      where ri.catalog_id is not null
    ),
    recursive_prep as (
      select
        rpi.recipe_id, pri.catalog_id, pri.sub_recipe_id,
        (rpi.quantity * pri.quantity)::numeric as qty,
        array[rpi.prep_recipe_id]              as visited,
        1                                       as depth
      from public.recipe_prep_items rpi
      join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rpi.prep_recipe_id
      union all
      select rp.recipe_id, pri.catalog_id, pri.sub_recipe_id,
             (rp.qty * pri.quantity)::numeric,
             rp.visited || rp.sub_recipe_id, rp.depth + 1
      from recursive_prep rp
      join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rp.sub_recipe_id
      where rp.sub_recipe_id is not null
        and not (rp.sub_recipe_id = any (rp.visited))
        and rp.depth < 5
    ),
    truncated_recipes as (
      -- Distinct top-level recipe_ids whose chain hit the depth cap
      -- with more to walk. `recursive_prep.depth < 5` filters out
      -- the deeper step from the recursion; rows that landed at
      -- depth = 5 still have `sub_recipe_id` if the chain wanted
      -- to continue. Same signal as the pre-walk in section (4).
      select distinct recipe_id
      from recursive_prep
      where depth = 5
        and sub_recipe_id is not null
        and not (sub_recipe_id = any (visited))
    ),
    prep_leaves as (
      select recipe_id, catalog_id, qty from recursive_prep where catalog_id is not null
    ),
    all_ri as (
      select recipe_id, catalog_id, sum(qty)::numeric as qty
      from (select * from direct_ri union all select recipe_id, catalog_id, qty from prep_leaves) u
      group by recipe_id, catalog_id
    ),
    recipe_cost as (
      select ari.recipe_id,
             sum(ari.qty * coalesce(ii.cost_per_unit, 0))::numeric as cost_per_unit,
             bool_or(ii.id is null or coalesce(ii.cost_per_unit, 0) = 0) as missing_cost
      from all_ri ari
      left join public.inventory_items ii
        on ii.catalog_id = ari.catalog_id and ii.store_id = p_store_id
      group by ari.recipe_id
    ),
    sales as (
      select
        r.menu_item          as item,
        coalesce(nullif(trim(r.category), ''), '(uncategorized)') as category,
        pii.qty_sold::numeric * coalesce(rc.cost_per_unit, 0) as cogs,
        pii.revenue::numeric as revenue,
        coalesce(rc.missing_cost, true) as missing_cost,
        (tr.recipe_id is not null) as truncated
      from public.pos_imports pi
      join public.pos_import_items pii on pii.import_id = pi.id
      join public.recipes r            on r.id = pii.recipe_id
      left join recipe_cost rc         on rc.recipe_id = r.id
      left join truncated_recipes tr   on tr.recipe_id = r.id
      where pi.store_id = p_store_id
        and pi.import_date between v_from and v_to
        and pii.recipe_id is not null
        and pii.recipe_mapped = true
    ),
    grouped_item as (
      select
        item,
        category,
        sum(revenue)::numeric as revenue,
        sum(cogs)::numeric    as cogs,
        bool_or(missing_cost) as missing_cost,
        bool_or(truncated)    as truncated
      from sales
      group by item, category
    )
    select coalesce(jsonb_agg(row_obj order by revenue desc), '[]'::jsonb)
      into v_rows
      from (
        select
          jsonb_build_object(
            'item',     item || case
                                  when truncated    then ' ⚠ (truncated)'
                                  when missing_cost then ' ⚠'
                                  else '' end,
            'category', category,
            'revenue',  '$' || to_char(revenue,        'FM999,999,990.00'),
            'cogs',     '$' || to_char(cogs,           'FM999,999,990.00'),
            'cogs_pct', case when revenue > 0
                              then to_char(cogs / revenue * 100, 'FM990.0') || '%'
                              else '0.0%' end,
            'margin',   '$' || to_char(revenue - cogs, 'FM999,999,990.00')
          ) as row_obj,
          revenue
        from grouped_item
      ) ordered;
  else
    with recursive
    direct_ri as (
      select ri.recipe_id, ri.catalog_id, ri.quantity::numeric as qty
      from public.recipe_ingredients ri
      where ri.catalog_id is not null
    ),
    recursive_prep as (
      select
        rpi.recipe_id, pri.catalog_id, pri.sub_recipe_id,
        (rpi.quantity * pri.quantity)::numeric as qty,
        array[rpi.prep_recipe_id]              as visited,
        1                                       as depth
      from public.recipe_prep_items rpi
      join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rpi.prep_recipe_id
      union all
      select rp.recipe_id, pri.catalog_id, pri.sub_recipe_id,
             (rp.qty * pri.quantity)::numeric,
             rp.visited || rp.sub_recipe_id, rp.depth + 1
      from recursive_prep rp
      join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rp.sub_recipe_id
      where rp.sub_recipe_id is not null
        and not (rp.sub_recipe_id = any (rp.visited))
        and rp.depth < 5
    ),
    truncated_recipes as (
      select distinct recipe_id
      from recursive_prep
      where depth = 5
        and sub_recipe_id is not null
        and not (sub_recipe_id = any (visited))
    ),
    prep_leaves as (
      select recipe_id, catalog_id, qty from recursive_prep where catalog_id is not null
    ),
    all_ri as (
      select recipe_id, catalog_id, sum(qty)::numeric as qty
      from (select * from direct_ri union all select recipe_id, catalog_id, qty from prep_leaves) u
      group by recipe_id, catalog_id
    ),
    recipe_cost as (
      select ari.recipe_id,
             sum(ari.qty * coalesce(ii.cost_per_unit, 0))::numeric as cost_per_unit,
             bool_or(ii.id is null or coalesce(ii.cost_per_unit, 0) = 0) as missing_cost
      from all_ri ari
      left join public.inventory_items ii
        on ii.catalog_id = ari.catalog_id and ii.store_id = p_store_id
      group by ari.recipe_id
    ),
    sales as (
      select
        coalesce(nullif(trim(r.category), ''), '(uncategorized)') as category,
        pii.qty_sold::numeric * coalesce(rc.cost_per_unit, 0)     as cogs,
        pii.revenue::numeric                                      as revenue,
        coalesce(rc.missing_cost, true)                           as missing_cost,
        (tr.recipe_id is not null)                                as truncated
      from public.pos_imports pi
      join public.pos_import_items pii on pii.import_id = pi.id
      join public.recipes r            on r.id = pii.recipe_id
      left join recipe_cost rc         on rc.recipe_id = r.id
      left join truncated_recipes tr   on tr.recipe_id = r.id
      where pi.store_id = p_store_id
        and pi.import_date between v_from and v_to
        and pii.recipe_id is not null
        and pii.recipe_mapped = true
    ),
    grouped_category as (
      select
        category,
        sum(revenue)::numeric as revenue,
        sum(cogs)::numeric    as cogs,
        bool_or(missing_cost) as missing_cost,
        bool_or(truncated)    as truncated
      from sales
      group by category
    )
    select coalesce(jsonb_agg(row_obj order by revenue desc), '[]'::jsonb)
      into v_rows
      from (
        select
          jsonb_build_object(
            'category', category || case
                                      when truncated    then ' ⚠ (truncated)'
                                      when missing_cost then ' ⚠'
                                      else '' end,
            'revenue',  '$' || to_char(revenue,        'FM999,999,990.00'),
            'cogs',     '$' || to_char(cogs,           'FM999,999,990.00'),
            'cogs_pct', case when revenue > 0
                              then to_char(cogs / revenue * 100, 'FM990.0') || '%'
                              else '0.0%' end,
            'margin',   '$' || to_char(revenue - cogs, 'FM999,999,990.00')
          ) as row_obj,
          revenue
        from grouped_category
      ) ordered;
  end if;

  -- (10) Series — single-line `cogs_pct` over time. Empty array when
  -- < 2 distinct dates have matched rows (the frame's chart panel
  -- needs ≥ 2 points; it skips the panel on empty). NOT null —
  -- `null` is reserved for templates that genuinely don't chart.
  --
  -- Single CTE walk: a `series_points` CTE produces one row per
  -- distinct biz_date with cogs_pct. We aggregate that into the
  -- final jsonb_agg in the same statement, gated on the row count
  -- being >= 2. Note: the `daily` CTE intentionally does NOT join
  -- `recipes` (the row aggregations above do). The `pii.recipe_id`
  -- FK to recipes has `on delete cascade` (init schema), so a
  -- recipe-id that survives the filter `pii.recipe_id is not null`
  -- is guaranteed to have a matching recipes row. We skip the join
  -- here because the series only needs revenue + cost numerics,
  -- not category/menu_item — fewer joins, same result.
  with recursive
  direct_ri as (
    select ri.recipe_id, ri.catalog_id, ri.quantity::numeric as qty
    from public.recipe_ingredients ri
    where ri.catalog_id is not null
  ),
  recursive_prep as (
    select rpi.recipe_id, pri.catalog_id, pri.sub_recipe_id,
           (rpi.quantity * pri.quantity)::numeric as qty,
           array[rpi.prep_recipe_id]              as visited,
           1                                       as depth
    from public.recipe_prep_items rpi
    join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rpi.prep_recipe_id
    union all
    select rp.recipe_id, pri.catalog_id, pri.sub_recipe_id,
           (rp.qty * pri.quantity)::numeric,
           rp.visited || rp.sub_recipe_id, rp.depth + 1
    from recursive_prep rp
    join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rp.sub_recipe_id
    where rp.sub_recipe_id is not null
      and not (rp.sub_recipe_id = any (rp.visited))
      and rp.depth < 5
  ),
  prep_leaves as (
    select recipe_id, catalog_id, qty from recursive_prep where catalog_id is not null
  ),
  all_ri as (
    select recipe_id, catalog_id, sum(qty)::numeric as qty
    from (select * from direct_ri union all select recipe_id, catalog_id, qty from prep_leaves) u
    group by recipe_id, catalog_id
  ),
  recipe_cost as (
    select ari.recipe_id,
           sum(ari.qty * coalesce(ii.cost_per_unit, 0))::numeric as cost_per_unit
    from all_ri ari
    left join public.inventory_items ii
      on ii.catalog_id = ari.catalog_id and ii.store_id = p_store_id
    group by ari.recipe_id
  ),
  daily as (
    select
      pi.import_date::date as biz_date,
      sum(pii.revenue::numeric)                                  as revenue,
      sum(pii.qty_sold::numeric * coalesce(rc.cost_per_unit, 0)) as cogs
    from public.pos_imports pi
    join public.pos_import_items pii on pii.import_id = pi.id
    left join recipe_cost rc         on rc.recipe_id = pii.recipe_id
    where pi.store_id = p_store_id
      and pi.import_date between v_from and v_to
      and pii.recipe_id is not null
      and pii.recipe_mapped = true
    group by pi.import_date
  ),
  daily_count as (
    select count(*) as n from daily
  )
  -- Conditional aggregation: when the day count is < 2, return
  -- an empty jsonb array — otherwise the populated series. Both
  -- branches come out of the same CTE materialization so the
  -- recursive prep CTE walks exactly once for section (10).
  select case
           when (select n from daily_count) < 2 then '[]'::jsonb
           else coalesce(jsonb_agg(
             jsonb_build_object(
               'label', 'COGS %',
               'x',     to_char(biz_date, 'YYYY-MM-DD'),
               'y',     case when revenue > 0 then round(cogs / revenue * 100, 1) else 0 end
             ) order by biz_date asc
           ), '[]'::jsonb)
         end
    into v_series
    from daily;

  -- (11) Final envelope.
  return jsonb_build_object(
    'kpis',    v_kpis,
    'columns', v_columns,
    'rows',    v_rows,
    'series',  v_series
  );
end;
$$;

revoke execute on function public.report_run_cogs(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_cogs(uuid, jsonb) to authenticated;

-- ─── Dispatcher: add 'cogs' arm ───────────────────────────────
-- Postgres has no in-place CASE-edit; we re-create the dispatcher in
-- full. The 'stub' arm and the not_implemented fallback are preserved
-- exactly as in 20260510120000_report_runs.sql:222-256 so callers see
-- no surface drift. REPORTS-3 will repeat this pattern for 'variance'.
-- Signature unchanged — `create or replace` handles the swap without
-- breaking outstanding `grant execute` rows.
create or replace function public.report_run(
  p_template_id text,
  p_store_id    uuid,
  p_params      jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  case p_template_id
    when 'stub' then
      return public.report_run_stub(p_store_id, p_params);
    when 'cogs' then
      return public.report_run_cogs(p_store_id, p_params);
    -- REPORTS-3 will add: when 'variance' then return public.report_run_variance(p_store_id, p_params);
    else
      return jsonb_build_object(
        'kpis',     '[]'::jsonb,
        'columns',  '[]'::jsonb,
        'rows',     '[]'::jsonb,
        'series',   null,
        '_status',  'not_implemented',
        '_message', 'Runner coming soon · definition saved'
      );
  end case;
end;
$$;

revoke execute on function public.report_run(text, uuid, jsonb) from public, anon;
grant  execute on function public.report_run(text, uuid, jsonb) to authenticated;

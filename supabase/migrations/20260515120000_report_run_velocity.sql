-- ============================================================
-- Spec 036 — Reports: Item velocity template runner.
--
-- public.report_run_velocity(p_store_id uuid, p_params jsonb) returns jsonb
--
-- Returns the spec 016 uniform envelope { kpis, columns, rows, series }
-- aggregating pos_imports/pos_import_items over a date window, sliced
-- by recipe / category per p_params.by. Mirrors spec 035 (vendor)
-- byte-for-byte except where divergences are explicitly called out below.
--
-- DESIGN NOTES (pinned by the architect §A3; don't relitigate post-impl):
--
-- • Date anchor = pos_imports.import_date::date. Matches the COGS
--   precedent at 20260511120000_report_run_cogs.sql:284 / :454 / :551.
--   `import_date` is the manager-facing business date set at POS-import
--   time and is the only sales-anchor column on `pos_imports`. There is
--   NO per-row date on `pos_import_items`; the entire import batch's
--   items share the parent's `import_date` (the per-row date smearing
--   caveat is documented in 20260511120000_report_run_cogs.sql:17-20 —
--   same carry-over applies here).
--
-- • Closed [from, to] window (`>= v_from AND <= v_to` on the date
--   anchor). Mirrors COGS / waste / vendor. Variance is the only
--   outlier with its half-open `(v_from, v_to]` shape (anchor-pair
--   reconciliation semantics). Velocity is event-stream like the
--   others. Reviewers comparing to variance: do NOT flag the closed
--   shape as drift.
--
-- • NO status filter on pos_imports (architect §A3 #3 / Q3). The table
--   has NO `status` column — verified against init_schema.sql:176-183.
--   POS imports are written as finalized records by the existing
--   POS-import surface, so there's no draft-vs-finalized distinction
--   to gate on. Reviewers comparing to the vendor runner (which DOES
--   gate on `po.status = 'received' or po.received_at is not null`):
--   do NOT ask "where's the status filter."
--
-- • Recipe-mapping filter (`pii.recipe_id IS NOT NULL AND
--   pii.recipe_mapped = true`). Matches the COGS precedent at
--   20260511120000_report_run_cogs.sql:298-299 / :455-456 / :552-553.
--   Unmapped POS rows (where the operator hasn't yet linked a
--   `menu_item` string to a recipe) are excluded from velocity.
--   Operators may notice "POS headline doesn't match velocity total"
--   and the answer is this filter.
--
-- • Velocity denominator = window_days = (v_to - v_from) + 1 (the
--   inclusive day count of the closed window). NOT `day_count` (the
--   distinct-anchor count per group). Q2 resolution: the whole-window
--   denominator gives "this item moves N per day on average across
--   the period," which matches the intuitive question. The
--   `day_count` column still surfaces informationally so users can
--   mentally compute `qty_sold / day_count` if they want.
--
-- • Top mover KPI ALWAYS uses recipe grouping regardless of p_params.by
--   (Q11 cross-cut). Parallel to vendor's "Top vendor" (always vendor)
--   and waste's "Top driver" (always reason). When the user toggles
--   `by='category'`, the table slices by category but the KPI still
--   tells them "which one item drove the most revenue." Reviewers: do
--   NOT propose making this dynamic.
--
-- • Top-N=5 series cap (architect §A0 #2). DIVERGENCE from vendor's
--   all-vendors-charted behaviour: vendor doesn't cap because most
--   stores have <10 vendors; recipe-level velocity can easily hit
--   50+ menu items per store, and a 50-line chart is unreadable.
--   Top-5 by total revenue within the window (same ordering as the
--   `rows` sort). Hardcoded via `v_series_n constant int := 5` — tunable
--   via `p_params->>'series_n'` in a follow-up if a caller needs it.
--
-- • All three KPIs emit `"tone": null` (Q4). Sales are not inherently
--   bad. High sales just means high purchasing volume; low sales just
--   means the period was quiet. DIVERGENCE from waste's
--   `< $50 ok / $50-$200 warn / > $200 danger` band (which makes
--   sense because all waste is loss). Reviewers comparing the
--   runners side-by-side: do NOT copy-paste waste's
--   `case when v_total_dollar < 50 then 'ok' ...` block here.
--
-- • No recursive prep-recipe CTE. `pos_import_items` references
--   `recipes.id` directly — the data is already at the granular
--   menu-item level. Load-bearing absence — same shape as waste /
--   vendor. Future contributors: do NOT mimic the COGS / variance
--   recursive CTE here.
--
-- • Index reuse. The runner does a per-store time-range scan on
--   `pos_imports` then joins `pos_import_items` by `import_id`. The
--   COGS runner already exercises this access path against the same
--   table shape and is in production; no new index in this
--   migration. If scale eventually warrants
--   `idx_pos_imports_store_import_date (store_id, import_date)` or
--   `idx_pos_import_items_import_id_recipe`, that's a follow-up spec.
--
-- • Per-row POS smearing caveat (same as COGS line 17-20). If a
--   single CSV spans multiple business days, all of that import's
--   rows bucket to the parent's single `import_date`. A per-row
--   `business_date` column on `pos_import_items` is a future spec.
--
-- • Grants/revokes mirror spec 016 convention: revoke from public,
--   anon; grant to authenticated. Closes the anon-bypass-PUBLIC
--   foot-gun the reports_anon_revoke.test.sql covers.
--
-- • Recipe name resolution. `recipes.menu_item` via the
--   pos_import_items.recipe_id → recipes.id FK. Rows whose `recipes`
--   row was deleted (orphan recipe_id) get the label
--   '(deleted recipe)'. Left-join keeps the row in the output. Per
--   the recipe-mapping filter above, NULL `recipe_id` rows never
--   reach the join.
-- ============================================================

create or replace function public.report_run_velocity(
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
  v_window_days         integer;
  v_series_n constant   int := 5;            -- top-N cap; see header for follow-up tunable
  v_total_qty           numeric;
  v_total_revenue       numeric;
  v_row_count           bigint;
  v_top_recipe          text;
  v_top_recipe_revenue  numeric;
  v_distinct_dates      bigint;
  v_kpis                jsonb;
  v_columns             jsonb;
  v_rows                jsonb;
  v_series              jsonb;
begin
  -- (1) AUTH GATE — first statement; mirrors vendor line 124-127 /
  -- waste line 88-92.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) PARAM COERCION. Malformed dates raise 22007/22008 natively
  -- (sanitized by the frontend's runReport toast path). Unknown keys
  -- in p_params are ignored. Default window: last 30 days inclusive
  -- (today-30d → today), matching the vendor / waste / COGS precedent.
  v_from := coalesce(
    nullif(p_params->>'from', '')::date,
    ((now() at time zone 'utc')::date - interval '30 days')::date
  );
  v_to := coalesce(
    nullif(p_params->>'to', '')::date,
    (now() at time zone 'utc')::date
  );
  v_by := coalesce(nullif(p_params->>'by', ''), 'recipe');
  if v_by not in ('recipe', 'category') then
    -- Forward-compat: silently coerce unknown values to the default.
    v_by := 'recipe';
  end if;

  -- (3) RANGE VALIDATION. from > to raises 22023; from == to is
  -- allowed (single-day velocity is meaningful — e.g. "what sold
  -- yesterday"). The closed inclusive interval makes
  -- v_window_days = (v_to - v_from) + 1 always ≥ 1, so the
  -- velocity-formula divisor is never zero — see header note.
  if v_from > v_to then
    raise exception 'Velocity report: from > to (% > %)', v_from, v_to
      using errcode = '22023';
  end if;
  v_window_days := (v_to - v_from) + 1;

  -- (4) COLUMN HEADER — built up-front so the empty-result branch
  -- can return it without re-deciding on by. Per-mode named keys
  -- (architect §A1 — match the variance/COGS/waste/vendor precedent).
  if v_by = 'recipe' then
    v_columns := jsonb_build_array(
      jsonb_build_object('key','recipe',    'label','Recipe',   'align','left' ),
      jsonb_build_object('key','qty_sold',  'label','Qty sold', 'align','right'),
      jsonb_build_object('key','day_count', 'label','Days',     'align','right'),
      jsonb_build_object('key','velocity',  'label','Velocity', 'align','right'),
      jsonb_build_object('key','revenue',   'label','Revenue',  'align','right')
    );
  else  -- v_by = 'category'
    v_columns := jsonb_build_array(
      jsonb_build_object('key','category',      'label','Category', 'align','left' ),
      jsonb_build_object('key','recipes_count', 'label','Recipes',  'align','right'),
      jsonb_build_object('key','qty_sold',      'label','Qty sold', 'align','right'),
      jsonb_build_object('key','day_count',     'label','Days',     'align','right'),
      jsonb_build_object('key','velocity',      'label','Velocity', 'align','right'),
      jsonb_build_object('key','revenue',       'label','Revenue',  'align','right')
    );
  end if;

  -- (5) HEADLINE TOTALS + TOP-RECIPE LOOKUP. One pass over the
  -- filtered pos_imports/pos_import_items. The CTE is re-walked in
  -- sections (8)/(9) because plpgsql can't share a CTE across
  -- statements — same limitation as COGS line 373-377 / vendor line
  -- 184-235 / waste line 154-186.
  with base as (
    select
      pi.id                                                   as import_id,
      pi.import_date                                          as biz_date,
      pii.recipe_id,
      coalesce(pii.qty_sold, 0)::numeric                      as qty,
      coalesce(pii.revenue,  0)::numeric                      as revenue,
      coalesce(r.menu_item, '(deleted recipe)')               as recipe,
      coalesce(nullif(trim(r.category), ''),
               '(uncategorized)')                             as category
    from public.pos_imports pi
    join public.pos_import_items pii on pii.import_id = pi.id
    left join public.recipes r       on r.id = pii.recipe_id
    where pi.store_id = p_store_id
      and pi.import_date >= v_from
      and pi.import_date <= v_to
      and pii.recipe_id is not null
      and pii.recipe_mapped = true
  ),
  totals as (
    select coalesce(sum(qty),     0)::numeric  as total_qty,
           coalesce(sum(revenue), 0)::numeric  as total_revenue,
           count(*)                            as row_count,
           count(distinct biz_date)            as distinct_dates
    from base
  ),
  top_recipe as (
    select recipe, sum(revenue)::numeric as revenue
    from base
    group by recipe
    order by sum(revenue) desc, recipe asc
    limit 1
  )
  select t.total_qty, t.total_revenue, t.row_count, t.distinct_dates,
         tr.recipe,   tr.revenue
    into v_total_qty, v_total_revenue, v_row_count, v_distinct_dates,
         v_top_recipe, v_top_recipe_revenue
    from totals t
    left join top_recipe tr on true;

  -- (6) EMPTY-RESULT SHORT-CIRCUIT — populated columns, empty
  -- kpis/rows/series. Series is '[]' NOT null (spec 016 contract:
  -- null is reserved for templates that genuinely don't chart).
  if v_row_count = 0 then
    return jsonb_build_object(
      'kpis',    '[]'::jsonb,
      'columns', v_columns,
      'rows',    '[]'::jsonb,
      'series',  '[]'::jsonb
    );
  end if;

  -- (7) KPI ASSEMBLY. ALL THREE KPIs emit "tone": null per Q4 /
  -- header note. Do NOT add tone bands here. Sales are not inherently
  -- bad — high sales just means high volume, low sales just means a
  -- quiet period. Reviewers comparing to waste: do NOT copy the
  -- `case when v_total_dollar < 50 then 'ok' ...` block over.
  v_kpis := jsonb_build_array(
    jsonb_build_object(
      'label','Total qty sold',
      'value', to_char(v_total_qty, 'FM999,999,990.000'),
      'tone', null
    )
  );

  -- Top mover KPI: only when at least one row exists AND a recipe
  -- group has positive revenue. The empty-result short-circuit at (6)
  -- already handles row_count = 0; here we just guard against the
  -- (theoretically possible) case where every row contributed $0
  -- because of NULL/zero revenue values.
  if v_top_recipe is not null and coalesce(v_top_recipe_revenue, 0) > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object(
        'label','Top mover',
        'value', v_top_recipe || ' · $' || to_char(v_top_recipe_revenue, 'FM999,999,990.00'),
        'tone', null
      )
    );
  end if;

  v_kpis := v_kpis || jsonb_build_array(
    jsonb_build_object(
      'label','Total revenue $',
      'value','$' || to_char(v_total_revenue, 'FM999,999,990.00'),
      'tone', null
    )
  );

  -- (8) ROWS. Server-side formatting preserves decimal precision
  -- across JSON round-trips. Sort: revenue desc, group_key asc
  -- (tiebreaker keeps output deterministic). Branched by v_by.
  --
  -- The base CTE re-walks here (and again in section 9) because
  -- plpgsql can't share a CTE between statements. Same pattern as
  -- vendor / COGS / waste.
  if v_by = 'recipe' then
    with base as (
      select
        pi.import_date                                          as biz_date,
        pii.recipe_id,
        coalesce(pii.qty_sold, 0)::numeric                      as qty,
        coalesce(pii.revenue,  0)::numeric                      as revenue,
        coalesce(r.menu_item, '(deleted recipe)')               as recipe
      from public.pos_imports pi
      join public.pos_import_items pii on pii.import_id = pi.id
      left join public.recipes r       on r.id = pii.recipe_id
      where pi.store_id = p_store_id
        and pi.import_date >= v_from
        and pi.import_date <= v_to
        and pii.recipe_id is not null
        and pii.recipe_mapped = true
    ),
    grouped as (
      select recipe,
             sum(qty)::numeric                 as qty,
             count(distinct biz_date)          as day_count,
             sum(revenue)::numeric             as revenue
      from base
      group by recipe
    )
    select coalesce(jsonb_agg(row_obj order by revenue desc, recipe asc), '[]'::jsonb)
      into v_rows
      from (
        select jsonb_build_object(
          'recipe',    recipe,
          'qty_sold',  to_char(qty,                'FM999,990.000'),
          'day_count', day_count,
          'velocity',  to_char(qty / v_window_days::numeric, 'FM999,990.000'),
          'revenue',   case when revenue >= 0
                            then '$'  || to_char(revenue,      'FM999,999,990.00')
                            else '-$' || to_char(abs(revenue), 'FM999,999,990.00') end
        ) as row_obj, revenue, recipe
        from grouped
      ) ordered;
  else  -- v_by = 'category'
    with base as (
      select
        pi.import_date                                          as biz_date,
        pii.recipe_id,
        coalesce(pii.qty_sold, 0)::numeric                      as qty,
        coalesce(pii.revenue,  0)::numeric                      as revenue,
        coalesce(nullif(trim(r.category), ''),
                 '(uncategorized)')                             as category
      from public.pos_imports pi
      join public.pos_import_items pii on pii.import_id = pi.id
      left join public.recipes r       on r.id = pii.recipe_id
      where pi.store_id = p_store_id
        and pi.import_date >= v_from
        and pi.import_date <= v_to
        and pii.recipe_id is not null
        and pii.recipe_mapped = true
    ),
    grouped as (
      select category,
             count(distinct recipe_id)         as recipes_count,
             sum(qty)::numeric                 as qty,
             count(distinct biz_date)          as day_count,
             sum(revenue)::numeric             as revenue
      from base
      group by category
    )
    select coalesce(jsonb_agg(row_obj order by revenue desc, category asc), '[]'::jsonb)
      into v_rows
      from (
        select jsonb_build_object(
          'category',      category,
          'recipes_count', recipes_count,
          'qty_sold',      to_char(qty,                'FM999,990.000'),
          'day_count',     day_count,
          'velocity',      to_char(qty / v_window_days::numeric, 'FM999,990.000'),
          'revenue',       case when revenue >= 0
                                then '$'  || to_char(revenue,      'FM999,999,990.00')
                                else '-$' || to_char(abs(revenue), 'FM999,999,990.00') end
        ) as row_obj, revenue, category
        from grouped
      ) ordered;
  end if;

  -- (9) SERIES — top-N=5 recipes by revenue (architect §A0 #2).
  -- One series per top-N recipe, multi-line. Each point:
  -- { label: <recipe>, x: 'YYYY-MM-DD', y: <revenue_that_day> }.
  -- Computed regardless of v_by (the chart always tells the
  -- recipe-over-time story while the table can be sliced any way).
  -- Empty array when < 2 distinct biz_date have matched rows (same
  -- gate as COGS / waste / vendor). NEVER null — spec 016 contract.
  -- DIVERGENCE from vendor's all-vendors-charted behaviour: top-N
  -- cap, hardcoded N=5.
  if v_distinct_dates < 2 then
    v_series := '[]'::jsonb;
  else
    with base as (
      select
        pi.import_date                                          as biz_date,
        coalesce(pii.qty_sold, 0)::numeric                      as qty,
        coalesce(pii.revenue,  0)::numeric                      as revenue,
        coalesce(r.menu_item, '(deleted recipe)')               as recipe
      from public.pos_imports pi
      join public.pos_import_items pii on pii.import_id = pi.id
      left join public.recipes r       on r.id = pii.recipe_id
      where pi.store_id = p_store_id
        and pi.import_date >= v_from
        and pi.import_date <= v_to
        and pii.recipe_id is not null
        and pii.recipe_mapped = true
    ),
    top_n as (
      select recipe, sum(revenue)::numeric as rev
      from base
      group by recipe
      order by sum(revenue) desc, recipe asc
      limit v_series_n
    ),
    daily as (
      select b.recipe, b.biz_date, sum(b.revenue)::numeric as revenue
        from base b
        join top_n t on t.recipe = b.recipe
       group by b.recipe, b.biz_date
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'label', recipe,
        'x',     to_char(biz_date, 'YYYY-MM-DD'),
        'y',     round(revenue, 2)
      ) order by recipe asc, biz_date asc
    ), '[]'::jsonb)
      into v_series
      from daily;
  end if;

  -- (10) FINAL ENVELOPE.
  return jsonb_build_object(
    'kpis',    v_kpis,
    'columns', v_columns,
    'rows',    v_rows,
    'series',  v_series
  );
end;
$$;

revoke execute on function public.report_run_velocity(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_velocity(uuid, jsonb) to authenticated;

-- ─── Dispatcher: add 'velocity' arm ────────────────────────────
-- Postgres has no in-place CASE-edit; we re-create the dispatcher
-- in full. The 'stub' / 'cogs' / 'variance' / 'waste' / 'vendor' arms
-- and the not_implemented fallback are preserved exactly as in
-- `20260514180000_report_run_vendor.sql:477-514` so callers see no
-- surface drift. Signature unchanged — `create or replace` handles
-- the swap without breaking outstanding grants.
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
    when 'variance' then
      return public.report_run_variance(p_store_id, p_params);
    when 'waste' then
      return public.report_run_waste(p_store_id, p_params);
    when 'vendor' then
      return public.report_run_vendor(p_store_id, p_params);
    when 'velocity' then
      return public.report_run_velocity(p_store_id, p_params);
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

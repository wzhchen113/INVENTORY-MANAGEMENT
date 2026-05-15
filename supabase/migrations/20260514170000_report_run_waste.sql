-- ============================================================
-- Spec 034 — Reports: Waste cost template runner.
--
-- public.report_run_waste(p_store_id uuid, p_params jsonb) returns jsonb
--
-- Returns the spec 016 uniform envelope { kpis, columns, rows, series }
-- aggregating waste_log over a date window, sliced by reason / category /
-- item per p_params.by.
--
-- DESIGN NOTES (pinned by the architect; don't relitigate post-impl):
--
-- • Column-key naming. Per-mode named keys, NOT generic 'dimension'.
--   by='reason'   → rows have a 'reason'   key; columns key 'reason'.
--   by='category' → rows have a 'category' key; columns key 'category'.
--   by='item'     → rows have an 'item'    key; columns key 'item'.
--   Shared analytic keys: qty, items_affected, dollar_impact, unit.
--   This matches the variance/COGS pattern. Frame renderer reads
--   row[col.key].
--
-- • Date window divergence from variance. CLOSED [from, to] on
--   logged_at::date (`>= v_from AND <= v_to`), NOT variance's
--   half-open (v_from, v_to]. Rationale: waste is an event log,
--   not anchor-pair reconciliation; single-day windows must include
--   that day's rows. COGS line 297 is the precedent.
--
-- • Cost source. waste_log.cost_per_unit SNAPSHOT only. Captured at
--   log-time by staff_log_waste (20260504000002_staff_log_waste_rpc
--   :42-65). No fallback to inventory_items.cost_per_unit — the
--   snapshot is the historically-correct number. NULL cost → row
--   contributes $0 to dollar_impact / Total waste $; qty still
--   surfaces in the row count.
--
-- • No recursive prep-recipe CTE. waste_log references
--   inventory_items.id directly — the data is already at the
--   granular level. Future contributors: don't mimic the variance/
--   COGS recursive CTE here. It's load-bearing absence.
--
-- • from == to is ALLOWED (single-day waste reports are meaningful).
--   Diverges from variance which requires distinct anchors.
--
-- • Top driver KPI cross-cuts. Computed via reason grouping
--   regardless of the by: toggle — it's the "what's hurting us most"
--   signal. Omitted from kpis array (not zero-valued) when no rows.
--
-- • Series cross-cuts. ONE series per reason, multi-line,
--   regardless of by: toggle. Empty array ('[]'::jsonb) when < 2
--   distinct logged_at dates; never null. Mirrors COGS line 661-672.
--
-- • Tone bands hardcoded: < $50 ok / $50-$200 warn / > $200 danger.
--   Per-brand thresholds are out of scope.
--
-- • Grants/revokes mirror spec 016 convention: revoke from public,
--   anon; grant to authenticated. Closes the anon-bypass-PUBLIC
--   foot-gun the reports_anon_revoke.test.sql covers.
--
-- • Index reuse. The (store_id, logged_at) composite index on
--   waste_log was added by the variance migration
--   (20260512120000_report_run_variance.sql:619-620). This runner
--   inherits it for the store-scoped time-range scan — no new index
--   needed in this migration.
-- ============================================================

create or replace function public.report_run_waste(
  p_store_id uuid,
  p_params   jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_from              date;
  v_to                date;
  v_by                text;
  v_total_dollar      numeric;
  v_total_qty         numeric;
  v_row_count         bigint;
  v_top_reason        text;
  v_top_reason_dollar numeric;
  v_distinct_dates    bigint;
  v_kpis              jsonb;
  v_columns           jsonb;
  v_rows              jsonb;
  v_series            jsonb;
  v_tone              text;
  v_top_tone          text;
begin
  -- (1) AUTH GATE — first statement; mirrors variance line 142-146.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) PARAM COERCION. Malformed dates raise 22007/22008 natively
  -- (sanitized by the frontend's runReport toast path). Unknown keys
  -- in p_params are ignored. Default window: last 30 days inclusive
  -- (today-30d → today), matching the spec AC line 35-37 / COGS
  -- precedent at line 111-118.
  v_from := coalesce(
    nullif(p_params->>'from', '')::date,
    ((now() at time zone 'utc')::date - interval '30 days')::date
  );
  v_to := coalesce(
    nullif(p_params->>'to', '')::date,
    (now() at time zone 'utc')::date
  );
  v_by := coalesce(nullif(p_params->>'by', ''), 'reason');
  if v_by not in ('reason', 'category', 'item') then
    -- Forward-compat: silently coerce unknown values to the default.
    v_by := 'reason';
  end if;

  -- (3) RANGE VALIDATION. from > to raises 22023; from == to is
  -- allowed (single-day waste reports are meaningful — see design
  -- notes above for the divergence from variance).
  if v_from > v_to then
    raise exception 'Waste report: from > to (% > %)', v_from, v_to
      using errcode = '22023';
  end if;

  -- (4) COLUMN HEADER — built up-front so the empty-result branch
  -- can return it without re-deciding on by. Per-mode named keys
  -- (architect §A1 — match the variance/COGS precedent).
  if v_by = 'reason' then
    v_columns := jsonb_build_array(
      jsonb_build_object('key','reason',         'label','Reason',   'align','left' ),
      jsonb_build_object('key','qty',            'label','Qty',      'align','right'),
      jsonb_build_object('key','items_affected', 'label','Items',    'align','right'),
      jsonb_build_object('key','dollar_impact',  'label','$ impact', 'align','right')
    );
  elsif v_by = 'category' then
    v_columns := jsonb_build_array(
      jsonb_build_object('key','category',       'label','Category', 'align','left' ),
      jsonb_build_object('key','qty',            'label','Qty',      'align','right'),
      jsonb_build_object('key','items_affected', 'label','Items',    'align','right'),
      jsonb_build_object('key','dollar_impact',  'label','$ impact', 'align','right')
    );
  else  -- v_by = 'item'
    v_columns := jsonb_build_array(
      jsonb_build_object('key','item',           'label','Item',     'align','left' ),
      jsonb_build_object('key','category',       'label','Category', 'align','left' ),
      jsonb_build_object('key','qty',            'label','Qty',      'align','right'),
      jsonb_build_object('key','unit',           'label','Unit',     'align','left' ),
      jsonb_build_object('key','dollar_impact',  'label','$ impact', 'align','right')
    );
  end if;

  -- (5) HEADLINE TOTALS + TOP-REASON LOOKUP. One pass over the
  -- filtered waste_log. The CTE is re-walked in sections (8)/(9)
  -- because plpgsql can't share a CTE across statements — same
  -- limitation as COGS line 373-377. At seed-scale (waste_log ~0
  -- rows by default; production ~thousands per store-month) the
  -- (store_id, logged_at) index covers the filter.
  with base as (
    select
      wl.id,
      wl.item_id,
      wl.logged_at::date                                              as biz_date,
      wl.quantity::numeric                                            as qty,
      coalesce(wl.cost_per_unit, 0)::numeric * wl.quantity::numeric   as dollar,
      coalesce(nullif(trim(wl.reason), ''), '(no reason)')            as reason
    from public.waste_log wl
    where wl.store_id = p_store_id
      and wl.logged_at::date >= v_from
      and wl.logged_at::date <= v_to
  ),
  totals as (
    select coalesce(sum(dollar), 0)::numeric  as total_dollar,
           coalesce(sum(qty),    0)::numeric  as total_qty,
           count(*)                           as row_count,
           count(distinct biz_date)           as distinct_dates
    from base
  ),
  top_reason as (
    select reason, sum(dollar)::numeric as dollar
    from base
    group by reason
    order by sum(dollar) desc, reason asc
    limit 1
  )
  select t.total_dollar, t.total_qty, t.row_count, t.distinct_dates,
         tr.reason,      tr.dollar
    into v_total_dollar, v_total_qty, v_row_count, v_distinct_dates,
         v_top_reason,   v_top_reason_dollar
    from totals t
    left join top_reason tr on true;

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

  -- (7) KPI ASSEMBLY. Tone bands hardcoded per AC line 108-113.
  -- Per-brand thresholds are out of scope (same as COGS).
  v_tone := case
              when v_total_dollar < 50  then 'ok'
              when v_total_dollar < 200 then 'warn'
              else 'danger'
            end;

  v_kpis := jsonb_build_array(
    jsonb_build_object(
      'label','Total waste $',
      'value','$' || to_char(v_total_dollar, 'FM999,999,990.00'),
      'tone', v_tone
    ),
    jsonb_build_object(
      'label','Total qty wasted',
      'value', to_char(v_total_qty, 'FM999,990.000'),
      'tone', null
    )
  );

  -- Top driver KPI: only when at least one row exists AND a reason
  -- group has positive dollar. The empty-result short-circuit at (6)
  -- already handles row_count = 0; here we just guard against the
  -- (theoretically possible) case where every row has cost=0.
  if v_top_reason is not null and coalesce(v_top_reason_dollar, 0) > 0 then
    v_top_tone := case
                    when v_top_reason_dollar < 50  then 'ok'
                    when v_top_reason_dollar < 200 then 'warn'
                    else 'danger'
                  end;
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object(
        'label','Top driver',
        'value', v_top_reason || ' · $' || to_char(v_top_reason_dollar, 'FM999,999,990.00'),
        'tone', v_top_tone
      )
    );
  end if;

  v_kpis := v_kpis || jsonb_build_array(
    jsonb_build_object('label','Logs in period', 'value', v_row_count, 'tone', null)
  );

  -- (8) ROWS. Server-side formatting preserves decimal precision
  -- across JSON round-trips. Sort: dollar_impact desc, group_key
  -- asc (tiebreaker keeps output deterministic). Branched by v_by.
  --
  -- The base CTE re-walks here (and again in section 9) because
  -- plpgsql can't share a CTE between statements. Same pattern as
  -- COGS lines 386-583 / variance lines 295-298.
  if v_by = 'reason' then
    with base as (
      select
        wl.item_id,
        wl.quantity::numeric                                            as qty,
        coalesce(wl.cost_per_unit, 0)::numeric * wl.quantity::numeric   as dollar,
        coalesce(nullif(trim(wl.reason), ''), '(no reason)')            as reason
      from public.waste_log wl
      where wl.store_id = p_store_id
        and wl.logged_at::date >= v_from
        and wl.logged_at::date <= v_to
    ),
    grouped as (
      select reason,
             sum(qty)::numeric                  as qty,
             sum(dollar)::numeric               as dollar,
             count(distinct item_id) filter (where item_id is not null) as items_affected
      from base
      group by reason
    )
    select coalesce(jsonb_agg(row_obj order by dollar desc, reason asc), '[]'::jsonb)
      into v_rows
      from (
        select jsonb_build_object(
          'reason',         reason,
          'qty',            to_char(qty,    'FM999,990.000'),
          'items_affected', items_affected,
          'dollar_impact',  case when dollar >= 0
                                 then '$'  || to_char(dollar,      'FM999,999,990.00')
                                 else '-$' || to_char(abs(dollar), 'FM999,999,990.00') end
        ) as row_obj, dollar, reason
        from grouped
      ) ordered;
  elsif v_by = 'category' then
    with base as (
      select
        wl.item_id,
        wl.quantity::numeric                                            as qty,
        coalesce(wl.cost_per_unit, 0)::numeric * wl.quantity::numeric   as dollar,
        coalesce(nullif(trim(ci.category), ''), '(uncategorized)')      as category
      from public.waste_log wl
      left join public.inventory_items ii      on ii.id = wl.item_id
      left join public.catalog_ingredients ci  on ci.id = ii.catalog_id
      where wl.store_id = p_store_id
        and wl.logged_at::date >= v_from
        and wl.logged_at::date <= v_to
    ),
    grouped as (
      select category,
             sum(qty)::numeric                  as qty,
             sum(dollar)::numeric               as dollar,
             count(distinct item_id) filter (where item_id is not null) as items_affected
      from base
      group by category
    )
    select coalesce(jsonb_agg(row_obj order by dollar desc, category asc), '[]'::jsonb)
      into v_rows
      from (
        select jsonb_build_object(
          'category',       category,
          'qty',            to_char(qty,    'FM999,990.000'),
          'items_affected', items_affected,
          'dollar_impact',  case when dollar >= 0
                                 then '$'  || to_char(dollar,      'FM999,999,990.00')
                                 else '-$' || to_char(abs(dollar), 'FM999,999,990.00') end
        ) as row_obj, dollar, category
        from grouped
      ) ordered;
  else  -- v_by = 'item'
    -- Item mode: no items_affected column (the row IS the item).
    -- Orphan waste_log.item_id rows (inventory_items hard-deleted)
    -- left-join to '(deleted item)' / '(uncategorized)' / '' unit
    -- so they still surface in the table.
    with base as (
      select
        wl.item_id,
        wl.quantity::numeric                                            as qty,
        coalesce(wl.cost_per_unit, 0)::numeric * wl.quantity::numeric   as dollar,
        coalesce(ci.name, '(deleted item)')                             as item_name,
        coalesce(nullif(trim(ci.category), ''), '(uncategorized)')      as category,
        coalesce(ci.unit, '')                                           as unit
      from public.waste_log wl
      left join public.inventory_items ii      on ii.id = wl.item_id
      left join public.catalog_ingredients ci  on ci.id = ii.catalog_id
      where wl.store_id = p_store_id
        and wl.logged_at::date >= v_from
        and wl.logged_at::date <= v_to
    ),
    grouped as (
      select item_name,
             category,
             unit,
             sum(qty)::numeric                  as qty,
             sum(dollar)::numeric               as dollar
      from base
      group by item_name, category, unit
    )
    select coalesce(jsonb_agg(row_obj order by dollar desc, item_name asc), '[]'::jsonb)
      into v_rows
      from (
        select jsonb_build_object(
          'item',           item_name,
          'category',       category,
          'qty',            to_char(qty, 'FM999,990.000'),
          'unit',           unit,
          'dollar_impact',  case when dollar >= 0
                                 then '$'  || to_char(dollar,      'FM999,999,990.00')
                                 else '-$' || to_char(abs(dollar), 'FM999,999,990.00') end
        ) as row_obj, dollar, item_name
        from grouped
      ) ordered;
  end if;

  -- (9) SERIES. ONE series per reason. Each point:
  -- { label: <reason>, x: 'YYYY-MM-DD', y: <dollar> }.
  -- Computed regardless of v_by (the chart always tells the
  -- reason-over-time story while the table can be sliced any way).
  -- Empty array when < 2 distinct logged_at dates have matched
  -- rows (same gate as COGS line 661-672). NEVER null — spec 016
  -- contract: null is reserved for templates that genuinely don't
  -- chart.
  if v_distinct_dates < 2 then
    v_series := '[]'::jsonb;
  else
    with base as (
      select
        wl.logged_at::date                                              as biz_date,
        coalesce(wl.cost_per_unit, 0)::numeric * wl.quantity::numeric   as dollar,
        coalesce(nullif(trim(wl.reason), ''), '(no reason)')            as reason
      from public.waste_log wl
      where wl.store_id = p_store_id
        and wl.logged_at::date >= v_from
        and wl.logged_at::date <= v_to
    ),
    daily_by_reason as (
      select reason, biz_date, sum(dollar)::numeric as dollar
      from base
      group by reason, biz_date
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'label', reason,
        'x',     to_char(biz_date, 'YYYY-MM-DD'),
        'y',     round(dollar, 2)
      ) order by reason asc, biz_date asc
    ), '[]'::jsonb)
      into v_series
      from daily_by_reason;
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

revoke execute on function public.report_run_waste(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_waste(uuid, jsonb) to authenticated;

-- ─── Dispatcher: add 'waste' arm ───────────────────────────────
-- Postgres has no in-place CASE-edit; we re-create the dispatcher
-- in full. The 'stub' / 'cogs' / 'variance' arms and the
-- not_implemented fallback are preserved exactly as in
-- `20260512120000_report_run_variance.sql:628-661` so callers see
-- no surface drift. Signature unchanged — `create or replace`
-- handles the swap without breaking outstanding grants.
--
-- No forward-reference comment for the next template — see
-- architect §A2 rationale. The next runner spec can decide whether
-- to add the comment when it lands.
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

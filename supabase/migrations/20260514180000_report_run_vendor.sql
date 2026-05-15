-- ============================================================
-- Spec 035 — Reports: Vendor spend template runner.
--
-- public.report_run_vendor(p_store_id uuid, p_params jsonb) returns jsonb
--
-- Returns the spec 016 uniform envelope { kpis, columns, rows, series }
-- aggregating purchase_orders/po_items over a date window, sliced by
-- vendor / category / item per p_params.by. Mirrors spec 034 (waste)
-- byte-for-byte except where divergences are explicitly called out below.
--
-- DESIGN NOTES (pinned by the architect §A3; don't relitigate post-impl):
--
-- • Per-mode named keys (architect §A1, §A3 #1). by='vendor' → rows
--   have a 'vendor' key; by='category' → 'category'; by='item' →
--   'item'. Shared analytic keys: po_count, items_affected, total_qty,
--   unit, dollar_impact. Matches the variance / COGS / waste pattern;
--   frame renderer reads row[col.key].
--
-- • Closed [from, to] window divergence from variance (architect §A3 #2).
--   The date filter is `>= v_from AND <= v_to` on the date anchor,
--   NOT variance's half-open `(v_from, v_to]`. Rationale: vendor is an
--   event-stream report (a PO landed on day X), not anchor-pair
--   reconciliation. A manager asking "POs delivered on 2026-06-01"
--   expects to see that day's deliveries. Variance is the outlier
--   here — waste, COGS, and now vendor share the closed-window shape.
--   COGS line 297 / waste line 21-24 are the precedent.
--
-- • Cost source — po_items.cost_per_unit SNAPSHOT only (architect §A3 #3).
--   Captured at PO-creation time. No fallback to
--   inventory_items.cost_per_unit (which is the current value and may
--   have drifted since the PO was received). NULL cost → row
--   contributes $0 to Total spend $; qty still surfaces in
--   total_qty so the row doesn't disappear, it just doesn't move the
--   headline. Mirrors waste's stance using waste_log.cost_per_unit,
--   citing the variance multivendor migration
--   (20260514120020_report_run_variance_multivendor.sql:347-348) as
--   the join precedent.
--
-- • No recursive prep-recipe CTE (architect §A3 #4). po_items
--   references inventory_items.id directly — the data is already at
--   the granular level. Future contributors: don't mimic the
--   variance / COGS recursive CTE here. Load-bearing absence — same
--   shape as waste.
--
-- • Tone bands explicitly OMITTED (architect §A3 #5). All three KPIs
--   emit "tone": null. Vendor spend is not inherently bad — a high
--   spend simply means the store bought a lot. A "warn" tone on $10k
--   of spend would falsely flag healthy high-volume stores. Waste's
--   `< $50 ok / $50-$200 warn / > $200 danger` band makes sense
--   because all waste is loss; vendor spend is just operations.
--   Reviewers comparing the runners side-by-side: do NOT copy-paste
--   waste's `case when v_total_dollar < 50 then 'ok' ...` block here.
--
-- • from == to is ALLOWED (architect §A3 #6). Single-day vendor
--   reports are meaningful (e.g. "what did we receive yesterday").
--   Diverges from variance which requires distinct anchors.
--
-- • Top vendor KPI cross-cuts (architect §A3 #7). Computed via vendor
--   grouping regardless of the by: toggle — it's the "where is our
--   money going" signal. Parallel to waste's "Top driver" (which
--   always uses reason). Omitted from kpis array (not zero-valued)
--   when no rows OR when every row contributed $0 because of NULL
--   costs.
--
-- • Series cross-cuts (architect §A3 #8). ONE series per vendor,
--   multi-line, regardless of by: toggle. Empty array ('[]'::jsonb)
--   when < 2 distinct anchor dates have matched rows; never null
--   (spec 016 contract). Mirrors waste's "one series per reason"
--   decision.
--
-- • Index reuse (architect §A3 #9). The (store_id, reference_date)
--   composite index on purchase_orders was added by
--   20260502071736_remote_schema.sql:177. This runner inherits it for
--   the store-scoped time-range scan — no new index in this
--   migration.
--
-- • Status filter (architect §A3 #10). `(po.status = 'received' OR
--   po.received_at IS NOT NULL)`. Mirrors the variance multivendor
--   precedent (20260514120020_report_run_variance_multivendor.sql:350).
--   `partial`-with-receipt rows ARE included (rationale: a partial
--   receipt represents money that has actually changed hands for the
--   portion received). `draft` / `sent` / `partial`-without-receipt
--   rows are excluded — not real spend yet. This is the load-bearing
--   exclusion that makes the dollar arithmetic match what managers
--   see in their PO log.
--
-- • Grants/revokes mirror spec 016 convention: revoke from public,
--   anon; grant to authenticated. Closes the anon-bypass-PUBLIC
--   foot-gun the reports_anon_revoke.test.sql covers.
--
-- • Vendor name resolution. `vendors.name` via the
--   po_items.po_id → purchase_orders.id → purchase_orders.vendor_id →
--   vendors.id chain. Rows whose `purchase_orders.vendor_id` is NULL
--   get the label '(no vendor)'. Rows whose `vendors` row was deleted
--   (orphan vendor_id) get '(deleted vendor)'. Left-join keeps the
--   row in both cases; the dollar still contributes to the headline.
-- ============================================================

create or replace function public.report_run_vendor(
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
  v_row_count         bigint;
  v_po_count          bigint;
  v_top_vendor        text;
  v_top_vendor_dollar numeric;
  v_distinct_dates    bigint;
  v_kpis              jsonb;
  v_columns           jsonb;
  v_rows              jsonb;
  v_series            jsonb;
begin
  -- (1) AUTH GATE — first statement; mirrors waste line 88-92 /
  -- variance line 142-146.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) PARAM COERCION. Malformed dates raise 22007/22008 natively
  -- (sanitized by the frontend's runReport toast path). Unknown keys
  -- in p_params are ignored. Default window: last 30 days inclusive
  -- (today-30d → today), matching the waste / COGS precedent.
  v_from := coalesce(
    nullif(p_params->>'from', '')::date,
    ((now() at time zone 'utc')::date - interval '30 days')::date
  );
  v_to := coalesce(
    nullif(p_params->>'to', '')::date,
    (now() at time zone 'utc')::date
  );
  v_by := coalesce(nullif(p_params->>'by', ''), 'vendor');
  if v_by not in ('vendor', 'category', 'item') then
    -- Forward-compat: silently coerce unknown values to the default.
    v_by := 'vendor';
  end if;

  -- (3) RANGE VALIDATION. from > to raises 22023; from == to is
  -- allowed (single-day vendor reports are meaningful — see design
  -- notes above for the divergence from variance).
  if v_from > v_to then
    raise exception 'Vendor report: from > to (% > %)', v_from, v_to
      using errcode = '22023';
  end if;

  -- (4) COLUMN HEADER — built up-front so the empty-result branch
  -- can return it without re-deciding on by. Per-mode named keys
  -- (architect §A1 / §A4 — match the variance/COGS/waste precedent).
  if v_by = 'vendor' then
    v_columns := jsonb_build_array(
      jsonb_build_object('key','vendor',         'label','Vendor',   'align','left' ),
      jsonb_build_object('key','po_count',       'label','POs',      'align','right'),
      jsonb_build_object('key','total_qty',      'label','Qty',      'align','right'),
      jsonb_build_object('key','dollar_impact',  'label','$ spend',  'align','right')
    );
  elsif v_by = 'category' then
    v_columns := jsonb_build_array(
      jsonb_build_object('key','category',       'label','Category', 'align','left' ),
      jsonb_build_object('key','po_count',       'label','POs',      'align','right'),
      jsonb_build_object('key','items_affected', 'label','Items',    'align','right'),
      jsonb_build_object('key','total_qty',      'label','Qty',      'align','right'),
      jsonb_build_object('key','dollar_impact',  'label','$ spend',  'align','right')
    );
  else  -- v_by = 'item'
    v_columns := jsonb_build_array(
      jsonb_build_object('key','item',           'label','Item',     'align','left' ),
      jsonb_build_object('key','category',       'label','Category', 'align','left' ),
      jsonb_build_object('key','po_count',       'label','POs',      'align','right'),
      jsonb_build_object('key','total_qty',      'label','Qty',      'align','right'),
      jsonb_build_object('key','unit',           'label','Unit',     'align','left' ),
      jsonb_build_object('key','dollar_impact',  'label','$ spend',  'align','right')
    );
  end if;

  -- (5) HEADLINE TOTALS + TOP-VENDOR LOOKUP. One pass over the
  -- filtered purchase_orders/po_items. The CTE is re-walked in
  -- sections (8)/(9) because plpgsql can't share a CTE across
  -- statements — same limitation as COGS line 373-377 / waste line
  -- 154-186. At seed-scale the (store_id, reference_date) index
  -- covers the filter; the po_items.po_id FK lookup falls back to the
  -- purchase_orders.id primary-key index for the implied join.
  with base as (
    select
      po.id                                                       as po_id,
      pi.item_id,
      coalesce(po.reference_date, po.received_at::date)           as biz_date,
      coalesce(pi.received_qty, 0)::numeric                       as qty,
      (coalesce(pi.received_qty, 0)::numeric
        * coalesce(pi.cost_per_unit, 0)::numeric)                 as dollar,
      coalesce(v.name, case when po.vendor_id is null
                             then '(no vendor)'
                             else '(deleted vendor)' end)         as vendor
    from public.purchase_orders po
    join public.po_items pi      on pi.po_id = po.id
    left join public.vendors v   on v.id = po.vendor_id
    where po.store_id = p_store_id
      and (po.status = 'received' or po.received_at is not null)
      and coalesce(po.reference_date, po.received_at::date) >= v_from
      and coalesce(po.reference_date, po.received_at::date) <= v_to
  ),
  totals as (
    select coalesce(sum(dollar), 0)::numeric  as total_dollar,
           coalesce(sum(qty),    0)::numeric  as total_qty,
           count(*)                           as row_count,
           count(distinct po_id)              as po_count,
           count(distinct biz_date)           as distinct_dates
    from base
  ),
  top_vendor as (
    select vendor, sum(dollar)::numeric as dollar
    from base
    group by vendor
    order by sum(dollar) desc, vendor asc
    limit 1
  )
  -- Code-reviewer spec 035 S1: total_qty is not surfaced as a KPI in the
  -- vendor envelope (only Total spend $, Top vendor, POs in period — see
  -- KPI assembly below). Dropped from the SELECT INTO target list to
  -- avoid the misleading "future KPI dropped?" question on copy-paste
  -- into future runners.
  select t.total_dollar, t.row_count, t.po_count, t.distinct_dates,
         tv.vendor,      tv.dollar
    into v_total_dollar, v_row_count, v_po_count, v_distinct_dates,
         v_top_vendor,   v_top_vendor_dollar
    from totals t
    left join top_vendor tv on true;

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

  -- (7) KPI ASSEMBLY. ALL THREE KPIs emit "tone": null per Q3 /
  -- architect §A3 #5. Do NOT add tone bands here. Vendor spend is not
  -- inherently bad — high spend just means high purchasing volume.
  v_kpis := jsonb_build_array(
    jsonb_build_object(
      'label','Total spend $',
      'value','$' || to_char(v_total_dollar, 'FM999,999,990.00'),
      'tone', null
    )
  );

  -- Top vendor KPI: only when at least one row exists AND a vendor
  -- group has positive dollar. The empty-result short-circuit at (6)
  -- already handles row_count = 0; here we just guard against the
  -- (theoretically possible) case where every row has cost=0 (all
  -- NULL po_items.cost_per_unit).
  if v_top_vendor is not null and coalesce(v_top_vendor_dollar, 0) > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object(
        'label','Top vendor',
        'value', v_top_vendor || ' · $' || to_char(v_top_vendor_dollar, 'FM999,999,990.00'),
        'tone', null
      )
    );
  end if;

  v_kpis := v_kpis || jsonb_build_array(
    jsonb_build_object('label','POs in period', 'value', v_po_count, 'tone', null)
  );

  -- (8) ROWS. Server-side formatting preserves decimal precision
  -- across JSON round-trips. Sort: dollar_impact desc, group_key
  -- asc (tiebreaker keeps output deterministic). Branched by v_by.
  --
  -- The base CTE re-walks here (and again in section 9) because
  -- plpgsql can't share a CTE between statements. Same pattern as
  -- COGS lines 386-583 / variance lines 295-298 / waste lines 251-361.
  if v_by = 'vendor' then
    with base as (
      select
        po.id                                                       as po_id,
        coalesce(pi.received_qty, 0)::numeric                       as qty,
        (coalesce(pi.received_qty, 0)::numeric
          * coalesce(pi.cost_per_unit, 0)::numeric)                 as dollar,
        coalesce(v.name, case when po.vendor_id is null
                               then '(no vendor)'
                               else '(deleted vendor)' end)         as vendor
      from public.purchase_orders po
      join public.po_items pi      on pi.po_id = po.id
      left join public.vendors v   on v.id = po.vendor_id
      where po.store_id = p_store_id
        and (po.status = 'received' or po.received_at is not null)
        and coalesce(po.reference_date, po.received_at::date) >= v_from
        and coalesce(po.reference_date, po.received_at::date) <= v_to
    ),
    grouped as (
      select vendor,
             count(distinct po_id)             as po_count,
             sum(qty)::numeric                 as qty,
             sum(dollar)::numeric              as dollar
      from base
      group by vendor
    )
    select coalesce(jsonb_agg(row_obj order by dollar desc, vendor asc), '[]'::jsonb)
      into v_rows
      from (
        select jsonb_build_object(
          'vendor',         vendor,
          'po_count',       po_count,
          'total_qty',      to_char(qty,    'FM999,990.000'),
          'dollar_impact',  case when dollar >= 0
                                 then '$'  || to_char(dollar,      'FM999,999,990.00')
                                 else '-$' || to_char(abs(dollar), 'FM999,999,990.00') end
        ) as row_obj, dollar, vendor
        from grouped
      ) ordered;
  elsif v_by = 'category' then
    with base as (
      select
        po.id                                                       as po_id,
        pi.item_id,
        coalesce(pi.received_qty, 0)::numeric                       as qty,
        (coalesce(pi.received_qty, 0)::numeric
          * coalesce(pi.cost_per_unit, 0)::numeric)                 as dollar,
        coalesce(nullif(trim(ci.category), ''), '(uncategorized)')  as category
      from public.purchase_orders po
      join public.po_items pi                  on pi.po_id = po.id
      left join public.inventory_items ii      on ii.id = pi.item_id
      left join public.catalog_ingredients ci  on ci.id = ii.catalog_id
      where po.store_id = p_store_id
        and (po.status = 'received' or po.received_at is not null)
        and coalesce(po.reference_date, po.received_at::date) >= v_from
        and coalesce(po.reference_date, po.received_at::date) <= v_to
    ),
    grouped as (
      select category,
             count(distinct po_id)             as po_count,
             count(distinct item_id) filter (where item_id is not null) as items_affected,
             sum(qty)::numeric                 as qty,
             sum(dollar)::numeric              as dollar
      from base
      group by category
    )
    select coalesce(jsonb_agg(row_obj order by dollar desc, category asc), '[]'::jsonb)
      into v_rows
      from (
        select jsonb_build_object(
          'category',       category,
          'po_count',       po_count,
          'items_affected', items_affected,
          'total_qty',      to_char(qty,    'FM999,990.000'),
          'dollar_impact',  case when dollar >= 0
                                 then '$'  || to_char(dollar,      'FM999,999,990.00')
                                 else '-$' || to_char(abs(dollar), 'FM999,999,990.00') end
        ) as row_obj, dollar, category
        from grouped
      ) ordered;
  else  -- v_by = 'item'
    -- Item mode: no items_affected column (the row IS the item).
    -- Orphan po_items.item_id rows (inventory_items hard-deleted)
    -- left-join to '(deleted item)' / '(uncategorized)' / '' unit so
    -- they still surface in the table (mirrors waste line 319-331).
    with base as (
      select
        po.id                                                       as po_id,
        coalesce(pi.received_qty, 0)::numeric                       as qty,
        (coalesce(pi.received_qty, 0)::numeric
          * coalesce(pi.cost_per_unit, 0)::numeric)                 as dollar,
        coalesce(ci.name, '(deleted item)')                         as item_name,
        coalesce(nullif(trim(ci.category), ''), '(uncategorized)')  as category,
        coalesce(ci.unit, '')                                       as unit
      from public.purchase_orders po
      join public.po_items pi                  on pi.po_id = po.id
      left join public.inventory_items ii      on ii.id = pi.item_id
      left join public.catalog_ingredients ci  on ci.id = ii.catalog_id
      where po.store_id = p_store_id
        and (po.status = 'received' or po.received_at is not null)
        and coalesce(po.reference_date, po.received_at::date) >= v_from
        and coalesce(po.reference_date, po.received_at::date) <= v_to
    ),
    grouped as (
      select item_name,
             category,
             unit,
             count(distinct po_id)             as po_count,
             sum(qty)::numeric                 as qty,
             sum(dollar)::numeric              as dollar
      from base
      group by item_name, category, unit
    )
    select coalesce(jsonb_agg(row_obj order by dollar desc, item_name asc), '[]'::jsonb)
      into v_rows
      from (
        select jsonb_build_object(
          'item',           item_name,
          'category',       category,
          'po_count',       po_count,
          'total_qty',      to_char(qty, 'FM999,990.000'),
          'unit',           unit,
          'dollar_impact',  case when dollar >= 0
                                 then '$'  || to_char(dollar,      'FM999,999,990.00')
                                 else '-$' || to_char(abs(dollar), 'FM999,999,990.00') end
        ) as row_obj, dollar, item_name
        from grouped
      ) ordered;
  end if;

  -- (9) SERIES. ONE series per vendor. Each point:
  -- { label: <vendor>, x: 'YYYY-MM-DD', y: <dollar> }.
  -- Computed regardless of v_by (the chart always tells the
  -- vendor-over-time story while the table can be sliced any way).
  -- Empty array when < 2 distinct biz_date have matched rows (same
  -- gate as COGS / waste). NEVER null — spec 016 contract.
  if v_distinct_dates < 2 then
    v_series := '[]'::jsonb;
  else
    with base as (
      select
        coalesce(po.reference_date, po.received_at::date)           as biz_date,
        (coalesce(pi.received_qty, 0)::numeric
          * coalesce(pi.cost_per_unit, 0)::numeric)                 as dollar,
        coalesce(v.name, case when po.vendor_id is null
                               then '(no vendor)'
                               else '(deleted vendor)' end)         as vendor
      from public.purchase_orders po
      join public.po_items pi      on pi.po_id = po.id
      left join public.vendors v   on v.id = po.vendor_id
      where po.store_id = p_store_id
        and (po.status = 'received' or po.received_at is not null)
        and coalesce(po.reference_date, po.received_at::date) >= v_from
        and coalesce(po.reference_date, po.received_at::date) <= v_to
    ),
    daily_by_vendor as (
      select vendor, biz_date, sum(dollar)::numeric as dollar
      from base
      group by vendor, biz_date
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'label', vendor,
        'x',     to_char(biz_date, 'YYYY-MM-DD'),
        'y',     round(dollar, 2)
      ) order by vendor asc, biz_date asc
    ), '[]'::jsonb)
      into v_series
      from daily_by_vendor;
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

revoke execute on function public.report_run_vendor(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_vendor(uuid, jsonb) to authenticated;

-- ─── Dispatcher: add 'vendor' arm ──────────────────────────────
-- Postgres has no in-place CASE-edit; we re-create the dispatcher
-- in full. The 'stub' / 'cogs' / 'variance' / 'waste' arms and the
-- not_implemented fallback are preserved exactly as in
-- `20260514170000_report_run_waste.sql:425-460` so callers see no
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

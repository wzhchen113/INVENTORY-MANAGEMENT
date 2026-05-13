-- ============================================================
-- Spec 020 — `report_run_variance` multi-vendor anchor refactor
--
-- After spec 020 lands the schema migration, `eod_submissions` is
-- partitioned per (store_id, date, vendor_id). The original variance
-- migration (`20260512120000_report_run_variance.sql:208-224`)
-- captured a single `v_from_submission_id` / `v_to_submission_id` via
-- `select id into … from eod_submissions where store_id=? and date=?
-- and status='submitted'`. With multiple submissions per anchor date,
-- that capture is ambiguous; the per-row `select … into` would either
-- raise "more than one row returned" OR silently pick one — neither is
-- acceptable.
--
-- Refactor:
--   • DROP single-id capture; replace with EXISTS predicates for the
--     P0002 anchor-existence gates and a 'submitted' filter on the
--     prior_only / current_only XOR CTEs.
--   • REPLACE prior_counts / current_counts single-submission filters
--     with SUM-aggregation across ALL (store_id, date, status='submitted')
--     submissions for the anchor date, joined through eod_submissions.
--     One item appearing under two vendors on the same anchor date
--     contributes the sum of its `actual_remaining` rows.
--
-- Why the math is identical on existing seed data (variance-equality
-- smoke test). PRE-migration, the bug forces exactly ONE submission per
-- (store_id, date). After the schema migration each row has a vendor_id
-- but still — because no two-vendor day has actually been submitted — at
-- most one submission per (store_id, date). The new `sum(actual_remaining)
-- group by item_id` over one matching submission's entries reduces to
-- that single submission's `actual_remaining` per item, which is what
-- the old per-submission filter pulled. JSON envelopes match bit-for-bit.
--
-- ─── Equality smoke-test runbook ─────────────────────────────
-- Operator/dev runs (locally or on a prod copy):
--
--   -- BEFORE applying this triplet:
--   select public.report_run('variance', '<store_uuid>',
--          '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}'::jsonb)
--     into temporary table _variance_pre;
--
--   -- After applying 20260514120000 + 20260514120010 + 20260514120020:
--   select public.report_run('variance', '<store_uuid>',
--          '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}'::jsonb)
--     into temporary table _variance_post;
--
--   -- diff JSON-aware. The two tables must hold structurally identical
--   -- jsonb values for `kpis`, `columns`, `rows`, `series`. Sorting is
--   -- server-side and deterministic (`abs_dollar desc, abs_delta desc`)
--   -- so a jsonb-string compare is sufficient.
--   select (a.report_run::text) is distinct from (b.report_run::text)
--          as differs
--     from _variance_pre a, _variance_post b;
--
-- Three day-pairs worth running:
--   1) two consecutive submitted days (the common case)
--   2) a multi-day jump (verifies receiving/sales/waste windows)
--   3) a day-pair where one anchor has a submission and the other does
--      not — should still raise P0002 with the right "anchor: from|to"
--      message before vs after.
--
-- If any pair shows `differs = true` on seed data, abort the deploy and
-- inspect; the most likely culprit would be a missed status='submitted'
-- filter on one of the new CTEs.
-- ============================================================

create or replace function public.report_run_variance(
  p_store_id uuid,
  p_params   jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_from                    date;
  v_to                      date;
  v_default_anchors         date[];
  v_net_dollar              numeric;
  v_items_with_variance     bigint;
  v_missing_cost_count      bigint;
  v_truncated_recipe_count  bigint;
  v_single_anchor_count     bigint;
  v_kpis                    jsonb;
  v_columns                 jsonb;
  v_rows                    jsonb;
begin
  -- (1) AUTH GATE — first statement; mirrors COGS line 102-105.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) DEFAULT ANCHOR RESOLUTION — Q2 default. When either of
  -- from/to is missing, default to the most-recent two submitted EOD
  -- dates for this store. Multiple vendor-submissions on the same
  -- date collapse via DISTINCT.
  select array_agg(date order by date desc)
    into v_default_anchors
    from (
      select distinct date
        from public.eod_submissions
       where store_id = p_store_id
         and status = 'submitted'
       order by date desc
       limit 2
    ) recent;

  -- (3) PARAM COERCION.
  v_to := coalesce(
    nullif(p_params->>'to', '')::date,
    case when array_length(v_default_anchors, 1) >= 1
         then v_default_anchors[1]
         else null end
  );
  v_from := coalesce(
    nullif(p_params->>'from', '')::date,
    case when array_length(v_default_anchors, 1) >= 2
         then v_default_anchors[2]
         else null end
  );

  -- (4) "NEED TWO ANCHORS" GATE.
  if v_from is null or v_to is null then
    raise exception
      'Not enough EOD history — need at least two submitted EODs to compute variance'
      using errcode = 'P0001';
  end if;

  -- (5) RANGE VALIDATION.
  if v_from > v_to then
    raise exception 'Variance report: from > to (% > %)', v_from, v_to
      using errcode = '22023';
  end if;
  if v_from = v_to then
    raise exception
      'Variance report: from == to (%); variance needs two distinct EOD dates',
      v_from
      using errcode = '22023';
  end if;

  -- (6) ANCHOR-EXISTENCE CHECK (Q1: P0002 with explicit which-date).
  -- Post-spec-020, there can be MULTIPLE submissions per (store_id,
  -- date) — one per vendor. Replace the single-id capture with EXISTS
  -- predicates so the anchor gate fires once if no vendor at all has
  -- submitted on the anchor date.
  if not exists (
    select 1
      from public.eod_submissions
     where store_id = p_store_id
       and date = v_from
       and status = 'submitted'
  ) then
    raise exception
      'Variance report: no submitted EOD for store on % (anchor: from)', v_from
      using errcode = 'P0002';
  end if;

  if not exists (
    select 1
      from public.eod_submissions
     where store_id = p_store_id
       and date = v_to
       and status = 'submitted'
  ) then
    raise exception
      'Variance report: no submitted EOD for store on % (anchor: to)', v_to
      using errcode = 'P0002';
  end if;

  -- (7) FIXED COLUMN HEADER.
  v_columns := jsonb_build_array(
    jsonb_build_object('key','item',          'label','Item',     'align','left'),
    jsonb_build_object('key','expected',      'label','Expected', 'align','right'),
    jsonb_build_object('key','counted',       'label','Counted',  'align','right'),
    jsonb_build_object('key','delta',         'label','Δ',        'align','right'),
    jsonb_build_object('key','dollar_impact', 'label','$ impact', 'align','right')
  );

  -- (8) DEPTH-CAP PRE-WALK (truncation count). Unchanged from spec 018.
  with recursive _walk as (
    select rpi.recipe_id, rpi.prep_recipe_id, pri.sub_recipe_id,
           array[rpi.prep_recipe_id] as visited, 1 as depth
      from public.recipe_prep_items rpi
      join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rpi.prep_recipe_id
     where pri.sub_recipe_id is not null
    union all
    select w.recipe_id, w.prep_recipe_id, pri.sub_recipe_id,
           w.visited || w.sub_recipe_id, w.depth + 1
      from _walk w
      join public.prep_recipe_ingredients pri on pri.prep_recipe_id = w.sub_recipe_id
     where w.sub_recipe_id is not null
       and not (w.sub_recipe_id = any (w.visited))
       and w.depth < 5
  )
  select count(distinct recipe_id) into v_truncated_recipe_count
    from _walk
   where depth = 5
     and sub_recipe_id is not null
     and not (sub_recipe_id = any (visited));

  if v_truncated_recipe_count > 0 then
    raise notice 'Variance report: prep-recipe chain exceeds depth 5 (% recipe(s) truncated)',
      v_truncated_recipe_count;
  end if;

  -- (9) SINGLE-ANCHOR COUNT KPI. Post-spec-020, the prior_only /
  -- current_only sets are unions across all vendor-submissions on each
  -- anchor date (the same item can appear under multiple vendors on
  -- one date — DISTINCT collapses). Filters: status='submitted',
  -- store_id, anchor date, actual_remaining is not null.
  with
    prior_only as (
      select distinct e.item_id
        from public.eod_entries e
        join public.eod_submissions s on s.id = e.submission_id
       where s.store_id = p_store_id
         and s.date     = v_from
         and s.status   = 'submitted'
         and e.actual_remaining is not null
      except
      select distinct e.item_id
        from public.eod_entries e
        join public.eod_submissions s on s.id = e.submission_id
       where s.store_id = p_store_id
         and s.date     = v_to
         and s.status   = 'submitted'
         and e.actual_remaining is not null
    ),
    current_only as (
      select distinct e.item_id
        from public.eod_entries e
        join public.eod_submissions s on s.id = e.submission_id
       where s.store_id = p_store_id
         and s.date     = v_to
         and s.status   = 'submitted'
         and e.actual_remaining is not null
      except
      select distinct e.item_id
        from public.eod_entries e
        join public.eod_submissions s on s.id = e.submission_id
       where s.store_id = p_store_id
         and s.date     = v_from
         and s.status   = 'submitted'
         and e.actual_remaining is not null
    )
  select (select count(*) from prior_only) + (select count(*) from current_only)
    into v_single_anchor_count;

  -- (10) MAIN AGGREGATION. prior_counts / current_counts now SUM
  -- `actual_remaining` across all of an anchor date's vendor-submissions
  -- (Q3). For seed data with one submission per date this reduces to
  -- the old per-submission filter (sum over one row = that row's value).
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
    join public.prep_recipe_ingredients pri
      on pri.prep_recipe_id = rpi.prep_recipe_id
    union all
    select rp.recipe_id, pri.catalog_id, pri.sub_recipe_id,
           (rp.qty * pri.quantity)::numeric,
           rp.visited || rp.sub_recipe_id, rp.depth + 1
    from recursive_prep rp
    join public.prep_recipe_ingredients pri
      on pri.prep_recipe_id = rp.sub_recipe_id
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
    select recipe_id, catalog_id, qty
    from recursive_prep
    where catalog_id is not null
  ),
  all_ri as (
    select recipe_id, catalog_id, sum(qty)::numeric as qty
    from (
      select * from direct_ri
      union all
      select recipe_id, catalog_id, qty from prep_leaves
    ) u
    group by recipe_id, catalog_id
  ),
  recipe_meta as (
    select
      ari.recipe_id,
      bool_or(ii.id is null or coalesce(ii.cost_per_unit, 0) = 0) as missing_cost,
      bool_or(tr.recipe_id is not null)                            as truncated
    from all_ri ari
    left join public.inventory_items ii
      on ii.catalog_id = ari.catalog_id
     and ii.store_id   = p_store_id
    left join truncated_recipes tr
      on tr.recipe_id = ari.recipe_id
    group by ari.recipe_id
  ),
  -- Anchor counts (Q3: SUM across all vendor-submissions on the
  -- anchor date). The INNER JOIN to eod_submissions enforces the
  -- status='submitted' / store_id / date triple. `actual_remaining IS
  -- NOT NULL` is preserved per Appendix B item 6 (drops "not counted"
  -- entries from both numerator and denominator). One item appearing
  -- under two vendors on one anchor date contributes the sum of its
  -- actual_remaining values to the qty cell.
  prior_counts as (
    select e.item_id,
           sum(e.actual_remaining)::numeric as qty
      from public.eod_entries e
      join public.eod_submissions s on s.id = e.submission_id
     where s.store_id = p_store_id
       and s.date     = v_from
       and s.status   = 'submitted'
       and e.actual_remaining is not null
     group by e.item_id
  ),
  current_counts as (
    select e.item_id,
           sum(e.actual_remaining)::numeric as qty
      from public.eod_entries e
      join public.eod_submissions s on s.id = e.submission_id
     where s.store_id = p_store_id
       and s.date     = v_to
       and s.status   = 'submitted'
       and e.actual_remaining is not null
     group by e.item_id
  ),
  -- Receiving / sales_depletion / waste are unchanged — they aggregate
  -- over the half-open date window and never referenced submission_id.
  receiving as (
    select pi2.item_id,
           sum(coalesce(pi2.received_qty, 0))::numeric as qty
      from public.purchase_orders po
      join public.po_items pi2 on pi2.po_id = po.id
     where po.store_id = p_store_id
       and (po.status = 'received' or po.received_at is not null)
       and coalesce(po.reference_date, po.received_at::date) >  v_from
       and coalesce(po.reference_date, po.received_at::date) <= v_to
       and pi2.item_id is not null
     group by pi2.item_id
  ),
  sales_depletion as (
    select
      ii.id                                                 as item_id,
      sum(pii.qty_sold::numeric * ari.qty)::numeric         as qty,
      bool_or(coalesce(rm.missing_cost, false))             as missing_cost,
      bool_or(coalesce(rm.truncated, false))                as truncated
    from public.pos_imports pi
    join public.pos_import_items pii on pii.import_id = pi.id
    join all_ri ari                  on ari.recipe_id = pii.recipe_id
    join public.inventory_items ii   on ii.catalog_id = ari.catalog_id
                                    and ii.store_id   = p_store_id
    left join recipe_meta rm         on rm.recipe_id   = pii.recipe_id
    where pi.store_id     = p_store_id
      and pi.import_date >  v_from
      and pi.import_date <= v_to
      and pii.recipe_id is not null
      and pii.recipe_mapped = true
    group by ii.id
  ),
  waste as (
    select w.item_id,
           sum(coalesce(w.quantity, 0))::numeric as qty
      from public.waste_log w
     where w.store_id = p_store_id
       and w.logged_at::date >  v_from
       and w.logged_at::date <= v_to
       and w.item_id is not null
     group by w.item_id
  ),
  joined as (
    select
      pc.item_id,
      ci.name                                              as item_name,
      pc.qty                                               as prior_qty,
      cc.qty                                               as counted_qty,
      coalesce(r.qty, 0)                                   as receiving_qty,
      coalesce(sd.qty, 0)                                  as sales_qty,
      coalesce(w.qty, 0)                                   as waste_qty,
      (pc.qty + coalesce(r.qty, 0)
              - coalesce(sd.qty, 0)
              - coalesce(w.qty, 0))                        as expected_qty,
      (cc.qty - (pc.qty + coalesce(r.qty, 0)
                        - coalesce(sd.qty, 0)
                        - coalesce(w.qty, 0)))             as delta,
      coalesce(ii.cost_per_unit, 0)::numeric               as cost_per_unit,
      (coalesce(sd.missing_cost, false)
        or ii.cost_per_unit is null
        or coalesce(ii.cost_per_unit, 0) = 0)              as missing_cost,
      coalesce(sd.truncated, false)                        as truncated
    from prior_counts pc
    join current_counts cc on cc.item_id = pc.item_id
    join public.inventory_items ii on ii.id = pc.item_id
                                  and ii.store_id = p_store_id
    join public.catalog_ingredients ci on ci.id = ii.catalog_id
    left join receiving r          on r.item_id  = pc.item_id
    left join sales_depletion sd   on sd.item_id = pc.item_id
    left join waste w              on w.item_id  = pc.item_id
  ),
  joined_with_dollar as (
    select *,
           case when missing_cost then 0::numeric
                else delta * cost_per_unit end as dollar_impact
    from joined
  ),
  filtered as (
    select *
    from joined_with_dollar
    where abs(delta) >= 0.01
  ),
  totals as (
    select
      coalesce(sum(dollar_impact), 0)::numeric             as net_dollar,
      count(*) filter (where abs(delta) > 0)::bigint       as items_with_variance,
      count(*) filter (where missing_cost)::bigint         as missing_cost_count
    from joined_with_dollar
  ),
  rows_json as (
    select coalesce(jsonb_agg(row_obj order by abs_dollar desc, abs_delta desc), '[]'::jsonb) as rows
    from (
      select
        jsonb_build_object(
          'item', item_name || case
                                 when truncated    then ' ⚠ (truncated)'
                                 when missing_cost then ' ⚠'
                                 else '' end,
          'expected', case when expected_qty < 0
                           then '-' || to_char(abs(expected_qty), 'FM999,990.000')
                           else        to_char(expected_qty,      'FM999,990.000') end,
          'counted',  case when counted_qty < 0
                           then '-' || to_char(abs(counted_qty), 'FM999,990.000')
                           else        to_char(counted_qty,      'FM999,990.000') end,
          'delta',    case when delta < 0
                           then '-' || to_char(abs(delta), 'FM999,990.000')
                           else        to_char(delta,      'FM999,990.000') end,
          'dollar_impact', case
            when missing_cost      then '$0.00'
            when dollar_impact < 0 then '-$' || to_char(abs(dollar_impact), 'FM999,990.00')
            else                        '$'  || to_char(dollar_impact,      'FM999,990.00')
          end
        ) as row_obj,
        abs(dollar_impact) as abs_dollar,
        abs(delta)         as abs_delta
      from filtered
    ) ordered
  )
  select
    t.net_dollar,
    t.items_with_variance,
    t.missing_cost_count,
    r.rows
  into
    v_net_dollar,
    v_items_with_variance,
    v_missing_cost_count,
    v_rows
  from totals t
  cross join rows_json r;

  -- (11) KPI COMPOSITION.
  v_kpis := jsonb_build_array(
    jsonb_build_object(
      'label', 'Net $ impact',
      'value', case
                 when v_net_dollar < 0 then '-$' || to_char(abs(v_net_dollar), 'FM999,999,990.00')
                 else                       '$'  || to_char(v_net_dollar,      'FM999,999,990.00')
               end,
      'tone',  case when v_net_dollar < 0 then 'danger' else 'ok' end
    ),
    jsonb_build_object(
      'label', 'Items with variance',
      'value', v_items_with_variance,
      'tone',  null
    )
  );
  if v_missing_cost_count > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object('label','Items missing cost',
                         'value', v_missing_cost_count, 'tone','warn')
    );
  end if;
  if v_truncated_recipe_count > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object('label','Recipe graph truncated',
                         'value', v_truncated_recipe_count, 'tone','warn')
    );
  end if;
  if v_single_anchor_count > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object('label','Items not counted at both anchors',
                         'value', v_single_anchor_count, 'tone','warn')
    );
  end if;

  -- (12) FINAL ENVELOPE.
  return jsonb_build_object(
    'kpis',    v_kpis,
    'columns', v_columns,
    'rows',    coalesce(v_rows, '[]'::jsonb),
    'series',  '[]'::jsonb
  );
end;
$$;

revoke execute on function public.report_run_variance(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_variance(uuid, jsonb) to authenticated;

-- ============================================================
-- Spec 018 (REPORTS-3) — Variance template runner
--
-- Adds `report_run_variance(uuid, jsonb)` and re-creates the dispatcher
-- `report_run(text, uuid, jsonb)` (from
-- `20260511120000_report_run_cogs.sql:694-726`) with a new `when 'variance'`
-- arm. Signature unchanged so callers see no surface drift.
--
-- Computes per-item inventory variance between two EOD-submission anchors
-- ('from' = prior, 'to' = current). The variance reveals shrink, waste
-- mis-logging, or recipe drift across the period the manager picked.
-- Returns the uniform envelope per the per-template RPC convention
-- documented in `20260510120000_report_runs.sql:21-75`.
--
-- ─── Design notes / caveats documented for reviewers ─────────
--
-- • Per-item formula (Q4 strict). `expected = prior_count + receiving
--   − sales_depletion − waste`; `variance = counted − expected`;
--   `dollar_impact = variance × cost_per_unit`. Waste is folded into
--   `expected` (NOT surfaced as a separate column) to keep the headline
--   single-number ("did we lose more than the system knows about?")
--   and minimise columns. Trade-off acknowledged: the diagnostic view
--   "how much of the variance is unlogged waste vs. real shrink?" is
--   harder to read; accepted for v1.
--
-- • Half-open date windows. Receiving, sales-depletion, and waste all
--   filter on `> v_from AND <= v_to`. Rationale: an EOD count at
--   v_from already includes activity through end-of-day; activity
--   strictly AFTER v_from up through end-of-day v_to is the "between
--   anchors" window. Same shape across all three subqueries for
--   consistency.
--   - Same-day receipt at v_from but before EOD submitted_at: EXCLUDED
--     by the `> v_from` clause. Documented caveat — the receipt's units
--     are already in the prior count; double-counting would be worse.
--   - Same-day waste log at v_to but after EOD submitted_at: INCLUDED
--     by the `<= v_to` clause. Slight over-counting; documented.
--   - Same-day POS import at v_from: EXCLUDED. Symmetric with receiving.
--   - Same-day POS import at v_to: INCLUDED.
--
-- • Receiving column choice. Filter is on
--   `coalesce(po.reference_date, po.received_at::date)` — NOT just
--   `po.received_at::date`. Rationale:
--     - `purchase_orders.reference_date` (date) is the user-facing
--       "delivery date" written by `db.upsertPurchaseOrder` and is the
--       calendar date the receipt "counts for" — semantically aligned
--       with EOD anchor dates which are also `date`-typed.
--     - The existing index `idx_purchase_orders_store_reference_date`
--       lights up for `where store_id = $1 and reference_date > $2 and
--       reference_date <= $3`; `received_at::date` is unindexed.
--     - `received_at::date` is the fallback for legacy rows pre-dating
--       the `reference_date` column.
--   The receipt gate `status = 'received' OR received_at IS NOT NULL`
--   excludes `draft`/`sent` POs whose `reference_date` may be set
--   ahead-of-time for a future delivery.
--
-- • Missing-cost policy (Q6) — PARTIAL CREDIT, FLAGGED. Same shape as
--   COGS (`20260511120000_report_run_cogs.sql` notes). When `cost_per_unit`
--   is null or 0, OR a recipe in the depletion graph touches a null/zero
--   cost ingredient, the per-row `dollar_impact` is forced to 0, the
--   row's `item` cell gets a `' ⚠'` suffix, AND the `Items missing cost`
--   KPI surfaces the count (warn tone). The qty math still computes
--   normally so the count anomaly stays diagnostic.
--
-- • Prep-recipe depth cap = 5 with cycle detection. Same shape as
--   COGS. When a chain exceeds depth 5, a `RAISE NOTICE` logs the count,
--   the row's item suffix becomes `' ⚠ (truncated)'` (precedence over
--   the plain `' ⚠'` missing-cost suffix), and the `Recipe graph
--   truncated` KPI surfaces the count.
--
-- • One-anchor item exclusion (Q5/AC line 158-164). Items present at
--   only one anchor (counted at prior but not current, or vice versa)
--   are EXCLUDED from the rows table — variance on a one-anchor item
--   is undefined math (we don't know whether the item was on hand at
--   the missing anchor). The `Items not counted at both anchors` KPI
--   surfaces the count (warn tone, hidden when 0) so the manager knows
--   the table is a subset.
--
-- • Zero-variance filter (Q7) — SPLIT TREATMENT (release-proposal
--   Option C, REPORTS-3 round 2):
--     · Rows table filters `|delta| >= 0.01` for readability — the
--       architect's reviewer-flag concern about 50+ zero-rows in seed
--       is real; the table stays actionable.
--     · `Items with variance` KPI counts off `joined` (all intersected
--       items, pre-filter) per spec Q7 line 440-443 and the KPI
--       definition at spec line 175: `count(*) where abs(variance) > 0`.
--     · `Net $ impact` KPI ALSO aggregates off `joined` (not `filtered`)
--       so a row with `0 < |delta| < 0.01` and a populated cost still
--       contributes its small-but-real dollar impact to the headline
--       sum. Symmetric with the count KPI; avoids a silent
--       arithmetic-rounding-disagrees-with-count situation.
--     · `Items missing cost` KPI is computed off `joined` too — an item
--       with tiny variance + missing cost is still a data-quality
--       signal worth surfacing.
--   This keeps the table readable while ensuring KPIs do not lie about
--   the spec-defined counts/sums.
--
-- • Recipe snapshot semantics (Q8 default). The sales-depletion CTE
--   uses CURRENT `recipe_ingredients` / `prep_recipe_ingredients`. If
--   a recipe was edited mid-period, the depletion uses the post-edit
--   recipe for the entire window. Documented caveat; snapshotting is
--   its own much larger schema change.
--
-- • Buffer / non-recipe items (Q9). Items not in any recipe have
--   sales-depletion = 0; the variance reads as
--   `counted − (prior + receiving − waste)` which is exactly the
--   unexplained-loss signal. No special casing.
--
-- • Series (Q10). Variance over a single anchor pair = single number
--   per item, NOT a time series. `series` is always `[]` (NOT null —
--   null is reserved for templates that genuinely don't chart; a future
--   spec could add rolling-daily variance and return a populated series).
--
-- • Item name source. `inventory_items.name` was dropped in P3 lockdown
--   (`20260504072830_brand_catalog_p3_lockdown.sql:59`); names live on
--   `catalog_ingredients.name`. The joined CTE picks the name via
--   `inventory_items ii → catalog_ingredients ci on ci.id = ii.catalog_id`.
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
  v_from_submission_id      uuid;
  v_to_submission_id        uuid;
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
  -- dates for this store. The subquery returns 0/1/2 dates; section
  -- (4) errors if the result is short of what's needed.
  select array_agg(date order by date desc)
    into v_default_anchors
    from (
      select date
        from public.eod_submissions
       where store_id = p_store_id
         and status = 'submitted'
       order by date desc
       limit 2
    ) recent;

  -- (3) PARAM COERCION. Malformed `from`/`to` strings raise 22007/22008
  -- natively; the frontend's runReport sanitizer surfaces them. Unknown
  -- keys are ignored (forward-compat).
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

  -- (4) "NEED TWO ANCHORS" GATE. If params left either v_from or v_to
  -- unresolved (because the store has < 2 submitted EODs and no
  -- explicit anchors were passed), raise P0001. The modal's pre-emptive
  -- "Submit at least two EODs to enable variance" hint covers the
  -- common path; this raise catches the hand-crafted PostgREST request
  -- that bypasses the hint.
  if v_from is null or v_to is null then
    raise exception
      'Not enough EOD history — need at least two submitted EODs to compute variance'
      using errcode = 'P0001';
  end if;

  -- (5) RANGE VALIDATION. Per the developer prompt: both `from > to`
  -- AND `from == to` raise 22023 — variance between two ANCHORS
  -- requires they differ.
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
  -- Look up submission_ids; raise P0002 if either anchor has no
  -- submitted EOD for this store.
  select id into v_from_submission_id
    from public.eod_submissions
   where store_id = p_store_id and date = v_from and status = 'submitted';
  if v_from_submission_id is null then
    raise exception
      'Variance report: no submitted EOD for store on % (anchor: from)', v_from
      using errcode = 'P0002';
  end if;

  select id into v_to_submission_id
    from public.eod_submissions
   where store_id = p_store_id and date = v_to and status = 'submitted';
  if v_to_submission_id is null then
    raise exception
      'Variance report: no submitted EOD for store on % (anchor: to)', v_to
      using errcode = 'P0002';
  end if;

  -- (7) FIXED COLUMN HEADER. Built up-front; variance has no `by:`
  -- toggle so there's only one column set.
  v_columns := jsonb_build_array(
    jsonb_build_object('key','item',          'label','Item',     'align','left'),
    jsonb_build_object('key','expected',      'label','Expected', 'align','right'),
    jsonb_build_object('key','counted',       'label','Counted',  'align','right'),
    jsonb_build_object('key','delta',         'label','Δ',        'align','right'),
    jsonb_build_object('key','dollar_impact', 'label','$ impact', 'align','right')
  );

  -- (8) DEPTH-CAP PRE-WALK (truncation count). Mirrors COGS lines
  -- 140-170 verbatim. Output: v_truncated_recipe_count. Independent
  -- of the main aggregation so the count is decided once.
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

  -- (9) SINGLE-ANCHOR COUNT KPI. Items in prior_counts XOR
  -- current_counts. Cheap independent CTE — runs once. Counts items
  -- counted at one anchor but not the other (NULL `actual_remaining`
  -- treats the row as "not counted" per Appendix B item 6).
  with
    prior_only as (
      select e.item_id
        from public.eod_entries e
       where e.submission_id = v_from_submission_id
         and e.actual_remaining is not null
      except
      select e.item_id
        from public.eod_entries e
       where e.submission_id = v_to_submission_id
         and e.actual_remaining is not null
    ),
    current_only as (
      select e.item_id
        from public.eod_entries e
       where e.submission_id = v_to_submission_id
         and e.actual_remaining is not null
      except
      select e.item_id
        from public.eod_entries e
       where e.submission_id = v_from_submission_id
         and e.actual_remaining is not null
    )
  select (select count(*) from prior_only) + (select count(*) from current_only)
    into v_single_anchor_count;

  -- (10) MAIN AGGREGATION. One CTE chain emits both the headline
  -- scalars and the rows. The recursive prep CTE walks once; the
  -- planner can fuse the downstream aggregations off the same
  -- materialization.
  --
  -- ─── CTE walk overview ────────────────────────────────────
  --   • direct_ri / recursive_prep / prep_leaves / all_ri / recipe_meta —
  --     same shape as COGS lines 197-263. End-state: per (recipe_id,
  --     catalog_id) quantity-per-recipe + a `missing_cost` / `truncated`
  --     bool_or roll-up at the recipe_id level.
  --   • truncated_recipes — top-level recipe_ids whose chain hit the
  --     depth cap with more to walk. Same shape as COGS lines 411-422.
  --   • prior_counts / current_counts — per-item qty at each anchor.
  --   • receiving — half-open `(v_from, v_to]` window on
  --     `coalesce(reference_date, received_at::date)`; status gate
  --     excludes pre-receipt POs.
  --   • sales_depletion — `qty_sold × qty_per_recipe` flattened to
  --     inventory_items.id via catalog_id; carries `missing_cost` and
  --     `truncated` flags.
  --   • waste — half-open `(v_from, v_to]` window on `logged_at`.
  --   • joined — INNER JOIN prior_counts ↔ current_counts on item_id
  --     (drops one-anchor items), LEFT JOIN the rest, compute
  --     expected_qty / delta / dollar_impact / missing_cost / truncated.
  --   • totals + rows_json — both materialized off `joined` in one
  --     statement returning a single tuple (totals + jsonb rows).
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
  -- recipe_meta carries per-recipe `missing_cost` (any ingredient
  -- has null/zero cost in this store) AND `truncated` (chain hit
  -- depth cap). Both roll up via bool_or so a recipe whose graph
  -- touches a null cost OR was cut off at depth 5 propagates the
  -- flag to downstream sales_depletion rows.
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
  -- Anchor counts. `actual_remaining IS NOT NULL` filters out "not
  -- counted" entries per Appendix B item 6.
  prior_counts as (
    select e.item_id, e.actual_remaining::numeric as qty
      from public.eod_entries e
     where e.submission_id = v_from_submission_id
       and e.actual_remaining is not null
  ),
  current_counts as (
    select e.item_id, e.actual_remaining::numeric as qty
      from public.eod_entries e
     where e.submission_id = v_to_submission_id
       and e.actual_remaining is not null
  ),
  -- Receiving — `coalesce(reference_date, received_at::date)` half-open
  -- window. Status gate excludes pre-receipt POs.
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
  -- Sales depletion. Inner-join through pos_imports → pos_import_items →
  -- all_ri → inventory_items (per store via catalog_id). Filter:
  -- import_date half-open window; recipe_id non-null; recipe_mapped.
  -- Carry missing_cost / truncated up through bool_or.
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
  -- Waste — half-open `(v_from, v_to]` window on `logged_at::date`.
  -- `item_id` references `inventory_items.id` directly.
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
  -- Per-item math. INNER JOIN prior ↔ current ensures the
  -- intersection (one-anchor items drop out). LEFT JOIN the three
  -- "between" sources because an item may have no receiving / sales
  -- / waste in the window.
  -- Item names come from `catalog_ingredients.name` since
  -- `inventory_items.name` was dropped in P3 lockdown.
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
      -- missing_cost rolls up from the recipe-graph cost gaps AND
      -- the per-store cost on the item itself. Either path forces
      -- `dollar_impact` to 0 below.
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
  -- Per-row dollar_impact is decided once on `joined` (pre-noise-filter)
  -- so KPI sums and the rows table read off the same arithmetic.
  -- `missing_cost` zeroes out dollar_impact per Q6 partial-credit.
  joined_with_dollar as (
    select *,
           case when missing_cost then 0::numeric
                else delta * cost_per_unit end as dollar_impact
    from joined
  ),
  -- ROWS-only filter: drop reconciled rows (|delta| < 0.01) to keep
  -- the table actionable. The architect's reviewer-flag concern about
  -- a 50-row wall of zeros in seed is real; this filter applies ONLY
  -- to the rows output. KPI aggregates read off `joined_with_dollar`
  -- below.
  filtered as (
    select *
    from joined_with_dollar
    where abs(delta) >= 0.01
  ),
  -- Headline aggregates. Computed off `joined_with_dollar` (NOT
  -- `filtered`) per release-proposal Option C — see migration header.
  -- `items_with_variance` is `count(*) where abs(delta) > 0`,
  -- matching the spec's KPI definition exactly. `net_dollar` and
  -- `missing_cost_count` aggregate over the same pre-filter set so
  -- they cannot disagree with each other or with the row-count
  -- semantics surfaced to the manager.
  totals as (
    select
      coalesce(sum(dollar_impact), 0)::numeric             as net_dollar,
      count(*) filter (where abs(delta) > 0)::bigint       as items_with_variance,
      count(*) filter (where missing_cost)::bigint         as missing_cost_count
    from joined_with_dollar
  ),
  -- Server-side row formatting. Sorted abs($) desc, then abs(delta)
  -- desc. Suffix precedence: truncated > missing_cost > none.
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

  -- (11) KPI COMPOSITION. Two headlines always; up to three conditional.
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

  -- (12) FINAL ENVELOPE. `series` is always empty per Q10.
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

-- ─── Optional supporting index for the waste join ─────────────
-- `waste_log` has no `(store_id, logged_at)` composite today. At
-- seed scale a seq scan is fine but adding the partial index is zero-
-- cost forward-proofing and matches the spec's "in scope" allowance
-- (AC line 226-228). `idx_waste_log_store_logged_at` over
-- `(store_id, logged_at)` covers the receiving / waste filter shape
-- (`store_id = $1 AND logged_at::date > $2 AND logged_at::date <= $3`)
-- as a range scan on logged_at after the store_id equality.
create index if not exists idx_waste_log_store_logged_at
  on public.waste_log (store_id, logged_at);

-- ─── Dispatcher: add 'variance' arm ───────────────────────────
-- Postgres has no in-place CASE-edit; we re-create the dispatcher in
-- full. The 'stub' and 'cogs' arms and the not_implemented fallback
-- are preserved exactly as in `20260511120000_report_run_cogs.sql:694-726`
-- so callers see no surface drift. Signature unchanged — `create or
-- replace` handles the swap without breaking outstanding grants.
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

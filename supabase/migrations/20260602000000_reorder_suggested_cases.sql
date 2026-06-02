-- ============================================================
-- Spec 088 — Reorder "Suggested" shown in cases for case-based items
--
-- Additive `create or replace` of `public.report_reorder_list(uuid,
-- jsonb)`. Body is copied verbatim from the CURRENT on-disk
-- 20260514130000_report_reorder_list.sql (originally created by spec 021,
-- then updated IN-PLACE by spec 087) — so it carries spec 087's
-- as_of_date / EOD-first logic, the next-delivery math, the depth-cap
-- walk, the hybrid suggested_qty formula, and the vendor filter. A future
-- `create or replace` MUST likewise copy the LATEST on-disk body, not the
-- spec-021-era revision. Exactly THREE additive hunks here (Decision B:
-- server rounds the cost, the FE only formats the cases·units display):
--
--   (1) per_item CTE: surface the catalog's units-per-case from the
--       EXISTING `ci` join — `coalesce(ci.case_qty, 1)::numeric as
--       case_qty`. No new join, no new scan.
--
--   (2) per_item_filtered: derive two case-aware values.
--       • suggested_cases = ceil(suggested_qty / case_qty) when the
--         item HAS a case size (case_qty IS NOT NULL AND > 1), else
--         NULL.
--       • estimated_cost is now case-rounded: for case-size items it is
--         (ceil(suggested_qty / case_qty) * case_qty * cost_per_unit)
--         — the WHOLE-CASE order cost — and for null/≤1 case_qty items
--         it stays the unchanged (suggested_qty * cost_per_unit). This
--         is the SINGLE place cost is computed; vendor_total_cost
--         (sum(estimated_cost)) and kpis.total_estimated_cost
--         (sum(vendor_total_cost)) INHERIT the rounding automatically —
--         no other SQL edit needed for the rollups.
--
--   (3) per-item jsonb_build_object: add THREE additive keys —
--       'case_qty' (always present; 1 when no case size),
--       'suggested_cases' (ceil; JSON null when case_qty ≤ 1),
--       'suggested_units' (the ordered base-unit total M =
--        suggested_cases * case_qty for case items, else suggested_qty)
--       — exposed so the FE display, CSV, and PDF all read ONE
--       server-authoritative M. The raw `suggested_qty` key is kept
--       unchanged for back-compat and the par/usage breakdown semantics.
--
-- Predicate (B): "has a case size" ⇔ case_qty IS NOT NULL AND > 1.
-- Null/0/1 ALL mean "no case size → base unit unchanged" (strict > 1 so
-- a literal 1-per-case item never renders the degenerate "1 case · 1").
-- case_qty is `numeric`; ceil(x/y) returns numeric and serializes
-- without a decimal for whole values — NO ::int cast (a fractional
-- case_qty like 6.5 must not silently truncate; > 1 admits it and ceil
-- handles it correctly).
--
-- Behavior preserved: par/forecast formula, suggested_qty = greatest(
-- par_replacement, usage_forecasted), the as_of_date/EOD logic, the
-- schedule/next-delivery math, and the vendor filter are UNCHANGED.
-- Output is IDENTICAL for items with case_qty null/≤1 (verified by
-- pgTAP) — the only value change is the case-rounded cost for items
-- that genuinely have a case size.
--
-- No RLS change (security invoker; reads the same catalog_ingredients
-- row already SELECTed via the `ci` join under the caller's RLS). No
-- realtime / publication change. No GRANT change — the function
-- SIGNATURE is byte-identical, so `create or replace` PRESERVES the
-- existing `revoke … from public, anon` + `grant … to authenticated`
-- ACL from the spec-021 migration; re-stating it here would be
-- redundant. Backward-compatible (extra JSON keys; an old client keeps
-- working and just shows the rounded cost, the desired end state).
-- ============================================================

create or replace function public.report_reorder_list(
  p_store_id uuid,
  p_params   jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_as_of_date              date;
  v_today_dow_num           int;
  v_today_time              time;
  v_vendors                 jsonb;
  v_kpis                    jsonb;
  v_warnings                jsonb;
  v_truncated_recipe_count  bigint;
begin
  -- (1) AUTH GATE — first statement. Mirrors variance / cogs lines.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) AS-OF DATE RESOLUTION. Frontend passes the store-local "today"
  -- as YYYY-MM-DD via p_params. When omitted, fall back to the server's
  -- current_date (UTC). Same caveat as variance / cogs runners — caller
  -- supplies for correctness across time zones.
  v_as_of_date := coalesce(
    nullif(p_params->>'as_of_date', '')::date,
    current_date
  );
  v_today_dow_num := extract(dow from v_as_of_date)::int; -- 0=Sun..6=Sat
  v_today_time    := (now() at time zone 'utc')::time;

  -- (3) DEPTH-CAP PRE-WALK — recipe-graph depth cap is 5, same as
  -- variance / cogs. The 'truncated' flag propagates to per-item rows.
  -- Independent of the main aggregation so the count is computed once.
  with recursive _walk as (
    select rpi.recipe_id, rpi.prep_recipe_id, pri.sub_recipe_id,
           array[rpi.prep_recipe_id] as visited, 1 as depth
      from public.recipe_prep_items rpi
      join public.prep_recipe_ingredients pri
        on pri.prep_recipe_id = rpi.prep_recipe_id
     where pri.sub_recipe_id is not null
    union all
    select w.recipe_id, w.prep_recipe_id, pri.sub_recipe_id,
           w.visited || w.sub_recipe_id, w.depth + 1
      from _walk w
      join public.prep_recipe_ingredients pri
        on pri.prep_recipe_id = w.sub_recipe_id
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
    raise notice 'Reorder report: prep-recipe chain exceeds depth 5 (% recipe(s) truncated)',
      v_truncated_recipe_count;
  end if;

  -- (4) MAIN AGGREGATION. One CTE chain emits the per-vendor payload
  -- and the warnings array. Structure mirrors the variance runner.
  with recursive
  -- (4a) Direct (non-prep) ingredients per recipe, reduced to
  -- (recipe, catalog, qty). Same shape as variance lines 321-325.
  direct_ri as (
    select ri.recipe_id, ri.catalog_id, ri.quantity::numeric as qty
      from public.recipe_ingredients ri
     where ri.catalog_id is not null
  ),
  -- (4b) Recursive flatten with depth cap + cycle detection.
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
  -- (4c) Combined per-recipe ingredient quantities (direct + prep
  -- flattened). Joined to inventory_items via catalog_id below.
  all_ri as (
    select recipe_id, catalog_id, sum(qty)::numeric as qty
      from (
        select * from direct_ri
        union all
        select recipe_id, catalog_id, qty from prep_leaves
      ) u
     group by recipe_id, catalog_id
  ),
  -- (4d) Per-recipe truncation flag (rolls up to sales_depletion).
  recipe_meta as (
    select ari.recipe_id,
           bool_or(tr.recipe_id is not null) as truncated
      from all_ri ari
      left join truncated_recipes tr on tr.recipe_id = ari.recipe_id
     group by ari.recipe_id
  ),
  -- (4e) PER-VENDOR EOD LOOKUP. Post-spec-020, (store, date, vendor)
  -- is unique with at most one row. Filter 'submitted' status only.
  -- A vendor with a submission today is 'eod'-sourced; otherwise
  -- 'stock' fallback. eod_submitted_at is surfaced for the UI badge.
  latest_eod_per_vendor as (
    select s.vendor_id,
           s.id          as submission_id,
           s.submitted_at
      from public.eod_submissions s
     where s.store_id = p_store_id
       and s.date = v_as_of_date
       and s.status = 'submitted'
  ),
  -- (4f) Per-item on_hand. Three cases:
  --   case A: vendor has EOD today AND this item has a non-null
  --           actual_remaining → on_hand = actual_remaining, source=eod.
  --   case B: vendor has EOD today but THIS item's entry is missing
  --           or null → on_hand = inventory_items.current_stock,
  --           source=eod (vendor-level), item-level flag
  --           'eod_missing_for_item' attached.
  --   case C: vendor has no EOD today → on_hand = current_stock,
  --           source=stock.
  -- Item-level "on_hand_source" tracks per-item; vendor rollup
  -- elevates to 'eod' when ANY item under the vendor came from EOD
  -- (handled in (4l)).
  item_on_hand as (
    select
      ii.id                                              as item_id,
      ii.store_id,
      ii.vendor_id,
      ii.catalog_id,
      ii.par_level::numeric                              as par_level,
      coalesce(ii.usage_per_portion, 0)::numeric         as usage_per_portion,
      coalesce(ii.cost_per_unit, 0)::numeric             as cost_per_unit,
      coalesce(ii.current_stock, 0)::numeric             as current_stock,
      lev.submission_id,
      lev.submitted_at,
      e.actual_remaining,
      case
        when lev.submission_id is not null
         and e.actual_remaining is not null
        then e.actual_remaining::numeric
        else coalesce(ii.current_stock, 0)::numeric
      end                                                as on_hand,
      case
        when lev.submission_id is not null
         and e.actual_remaining is not null
        then 'eod'::text
        else 'stock'::text
      end                                                as item_on_hand_source,
      (lev.submission_id is not null
        and (e.id is null or e.actual_remaining is null))
                                                         as eod_missing_for_item
      from public.inventory_items ii
      left join latest_eod_per_vendor lev
        on lev.vendor_id = ii.vendor_id
      left join public.eod_entries e
        on e.submission_id = lev.submission_id
       and e.item_id = ii.id
     where ii.store_id = p_store_id
       and ii.vendor_id is not null
  ),
  -- (4g) Pending PO quantity. v1: ALWAYS 0. Structure preserved so
  -- v2 can swap in a real CTE here filtering on
  -- `purchase_orders.status IN (...) AND received_at IS NULL` joined
  -- through `po_items`. See spec §1 / §5 step 6.
  pending_po_qty as (
    select ioh.item_id,
           0::numeric as pending_po_qty
      from item_on_hand ioh
  ),
  -- (4h) Sales depletion average (per-day). For each item, flatten
  -- recipes-touching-this-item × qty_sold in the trailing 7d window
  -- and divide by 7 to get the per-day rate. Structurally identical
  -- to variance's sales_depletion CTE but with a different window
  -- and divided to per-day. Items not in any recipe yield no row.
  pos_daily_per_item as (
    select
      ii.id                                                  as item_id,
      sum(pii.qty_sold::numeric * ari.qty)::numeric / 7.0    as qty_per_day,
      bool_or(coalesce(rm.truncated, false))                 as truncated
      from public.pos_imports pi
      join public.pos_import_items pii on pii.import_id = pi.id
      join all_ri ari                  on ari.recipe_id = pii.recipe_id
      join public.inventory_items ii   on ii.catalog_id = ari.catalog_id
                                      and ii.store_id   = p_store_id
      left join recipe_meta rm         on rm.recipe_id   = pii.recipe_id
     where pi.store_id    = p_store_id
       and pi.import_date >  (v_as_of_date - 7)
       and pi.import_date <= v_as_of_date
       and pii.recipe_id is not null
       and pii.recipe_mapped = true
     group by ii.id
  ),
  -- (4i) NEXT-DELIVERY computation. For each vendor in this store
  -- with inventory items, compute days_offset to the next delivery_day.
  --
  -- CORRECTNESS NOTE: MIN must operate on the OFFSET DISTANCE
  -- ((dow - today_dow + 7) % 7), NOT on the raw DOW number. The
  -- previous shape ran MIN over the raw DOW which picked the
  -- numerically-smallest day-of-week — wrong for multi-delivery-day
  -- vendors. Example bug: a vendor delivering Wednesday (DOW=3) and
  -- Friday (DOW=5), called on Thursday (DOW=4): MIN(3,5)=3 →
  -- offset = (3-4+7)%7 = 6 days. Correct: per-day offsets are
  -- Wed=(3-4+7)%7=6 and Fri=(5-4+7)%7=1, MIN(6,1)=1. We compute the
  -- per-row distance first inside the lateral, push to next-week
  -- (+7) on the same row when today-is-delivery-and-cutoff-passed,
  -- then MIN over those distances.
  --
  -- Edge cases handled inline:
  --   • No order_schedule rows for vendor → COALESCE to 7 (A5 default).
  --   • Multiple delivery_days → MIN of per-day distances.
  --   • Today is a delivery day AND vendor's order_cutoff_time has
  --     already passed → force that day's offset to 7 (next cycle).
  --   • order_cutoff_time IS NULL → treat as "no cutoff", today's
  --     delivery counts (offset = 0).
  vendor_delivery_offsets as (
    select
      v.id            as vendor_id,
      v.name          as vendor_name,
      v.order_cutoff_time,
      os.days_offset  as days_offset
      from public.vendors v
      cross join lateral (
        -- Per delivery-day row: compute the naive distance from today,
        -- then push to +7 when this row is today-the-delivery-day AND
        -- the cutoff has already passed. Finally MIN over the
        -- resulting per-row distances.
        select min(per_day.distance) as days_offset
          from (
            select
              case
                when per_dow.dow is null then null
                when per_dow.dow = v_today_dow_num then
                  case
                    when v.order_cutoff_time is not null
                     and v_today_time > v.order_cutoff_time::time
                    then 7
                    else 0
                  end
                else
                  ((per_dow.dow - v_today_dow_num + 7) % 7)
              end as distance
              from (
                select distinct
                  case lower(os2.delivery_day)
                    when 'sunday'    then 0
                    when 'monday'    then 1
                    when 'tuesday'   then 2
                    when 'wednesday' then 3
                    when 'thursday'  then 4
                    when 'friday'    then 5
                    when 'saturday'  then 6
                    else null
                  end as dow
                  from public.order_schedule os2
                 where os2.store_id  = p_store_id
                   and os2.vendor_id = v.id
                   and os2.delivery_day is not null
              ) per_dow
             where per_dow.dow is not null
          ) per_day
      ) os
     where exists (
       select 1
         from public.inventory_items ii
        where ii.store_id  = p_store_id
          and ii.vendor_id = v.id
     )
  ),
  -- (4j) Resolve next-delivery metadata per vendor (handle the
  -- A5 fallback explicitly). Always pick a numeric days_offset so
  -- the downstream forecast multiplication is total.
  vendor_delivery as (
    select
      vdo.vendor_id,
      vdo.vendor_name,
      coalesce(vdo.days_offset, 7)                       as days_until,
      (vdo.days_offset is not null)                       as schedule_known,
      v_as_of_date + coalesce(vdo.days_offset, 7)         as next_delivery_date
      from vendor_delivery_offsets vdo
  ),
  -- (4k) PER-ITEM MATH. Compute par_replacement / usage_forecasted /
  -- suggested_qty per the hybrid formula. Join through
  -- catalog_ingredients for the item name (since inventory_items.name
  -- was dropped in P3). Filter rows with suggested_qty < 0.001 — the
  -- "nothing to order" case at the item grain.
  --
  -- Spec 088 hunk (1): surface the catalog's units-per-case from the
  -- EXISTING `ci` join. coalesce(…, 1) so a NULL case_qty reads as 1
  -- (= "no case size") downstream; the `> 1` predicate then treats it
  -- as base-unit. No ::int cast — keep `numeric` so a fractional
  -- case_qty isn't silently truncated.
  per_item as (
    select
      ioh.vendor_id,
      ioh.item_id,
      ci.name                                                       as item_name,
      coalesce(ci.unit, '')                                         as unit,
      coalesce(ci.case_qty, 1)::numeric                             as case_qty,
      ioh.on_hand,
      ioh.item_on_hand_source,
      ioh.eod_missing_for_item,
      coalesce(ppq.pending_po_qty, 0)                                as pending_po_qty,
      ioh.par_level,
      case when ioh.usage_per_portion > 0 then ioh.usage_per_portion else null end
                                                                     as usage_per_portion,
      coalesce(pos.qty_per_day, 0)::numeric                          as qty_per_day,
      coalesce(pos.truncated, false)                                 as truncated,
      vd.days_until,
      ioh.cost_per_unit,
      greatest(0,
        coalesce(ioh.par_level, 0) - ioh.on_hand - coalesce(ppq.pending_po_qty, 0)
      )::numeric                                                     as par_replacement,
      greatest(0,
        coalesce(ioh.usage_per_portion, 0)
        * coalesce(pos.qty_per_day, 0)
        * vd.days_until
        - ioh.on_hand
        - coalesce(ppq.pending_po_qty, 0)
      )::numeric                                                     as usage_forecasted
      from item_on_hand ioh
      join public.catalog_ingredients ci on ci.id = ioh.catalog_id
      join vendor_delivery vd            on vd.vendor_id = ioh.vendor_id
      left join pending_po_qty ppq       on ppq.item_id = ioh.item_id
      left join pos_daily_per_item pos   on pos.item_id = ioh.item_id
  ),
  per_item_suggested as (
    select
      pi.*,
      greatest(pi.par_replacement, pi.usage_forecasted)              as suggested_qty
      from per_item pi
  ),
  -- Spec 088 hunk (2): derive the case-aware values. "Has a case size"
  -- ⇔ case_qty > 1 (null/0/1 are normalized to 1 above, so the strict
  -- `> 1` test correctly excludes them).
  --   • suggested_cases = ceil(suggested_qty / case_qty) when case-size,
  --     else NULL.
  --   • estimated_cost is case-rounded: whole-case cost for case-size
  --     items, unchanged (suggested_qty * cost_per_unit) otherwise.
  -- This is the SINGLE cost source — vendor_total_cost (sum below) and
  -- kpis.total_estimated_cost inherit the rounding with no other edit.
  per_item_filtered as (
    select
      pis.*,
      case when pis.case_qty > 1
           then ceil(pis.suggested_qty / pis.case_qty)
           else null end                                            as suggested_cases,
      case when pis.case_qty > 1
           then (ceil(pis.suggested_qty / pis.case_qty) * pis.case_qty * pis.cost_per_unit)
           else (pis.suggested_qty * pis.cost_per_unit) end         as estimated_cost,
      -- Per-item flag list (jsonb array of lowercase tokens).
      (
        case when coalesce(pis.par_level, 0) <= 0 then jsonb_build_array('no_par')
             else '[]'::jsonb end
        ||
        case when pis.usage_per_portion is null or coalesce(pis.qty_per_day, 0) = 0
                  then jsonb_build_array('no_usage_rate')
             else '[]'::jsonb end
        ||
        case when pis.eod_missing_for_item then jsonb_build_array('eod_missing_for_item')
             else '[]'::jsonb end
        ||
        case when pis.truncated then jsonb_build_array('truncated')
             else '[]'::jsonb end
      )                                                              as flags
      from per_item_suggested pis
     where pis.suggested_qty >= 0.001
  ),
  -- (4l) VENDOR ROLLUP. Vendors with zero rows are filtered OUT here
  -- (matches AC line 62 — "If a vendor has zero suggested items, the
  -- card is hidden"). on_hand_source rolls up to 'eod' iff any item
  -- under the vendor came from EOD; else 'stock'.
  vendors_with_items as (
    select
      vd.vendor_id,
      vd.vendor_name,
      vd.schedule_known,
      vd.next_delivery_date,
      vd.days_until,
      -- vendor-level source: 'eod' if any item drew from EOD.
      case when bool_or(pif.item_on_hand_source = 'eod') then 'eod'
           else 'stock' end                                          as on_hand_source,
      -- earliest submitted_at across this vendor's items (one
      -- submission per vendor per day post-spec-020, so this collapses).
      max(ioh_lev.submitted_at)                                      as eod_submitted_at,
      sum(pif.estimated_cost)::numeric                               as vendor_total_cost,
      jsonb_agg(
        jsonb_build_object(
          'item_id',          pif.item_id,
          'item_name',        pif.item_name,
          'unit',             pif.unit,
          'on_hand',          pif.on_hand,
          'pending_po_qty',   pif.pending_po_qty,
          'par_level',        pif.par_level,
          'usage_forecasted', pif.usage_forecasted,
          'par_replacement',  pif.par_replacement,
          'suggested_qty',    pif.suggested_qty,
          -- Spec 088 hunk (3): three additive case keys. case_qty is
          -- always present (1 when no case size); suggested_cases is the
          -- ceil (JSON null when case_qty ≤ 1); suggested_units is the
          -- ordered base-unit total M (= cases * case_qty for case
          -- items, else the raw suggested_qty). One server-authoritative
          -- M so the FE display / CSV / PDF never re-derive cases×qty.
          'case_qty',         pif.case_qty,
          'suggested_cases',  pif.suggested_cases,
          'suggested_units',  case when pif.suggested_cases is not null
                                   then pif.suggested_cases * pif.case_qty
                                   else pif.suggested_qty end,
          'cost_per_unit',    pif.cost_per_unit,
          'estimated_cost',   pif.estimated_cost,
          'flags',            pif.flags
        )
        order by pif.suggested_qty desc, pif.item_name asc
      )                                                              as items
      from per_item_filtered pif
      join vendor_delivery vd on vd.vendor_id = pif.vendor_id
      left join item_on_hand ioh_lev on ioh_lev.item_id = pif.item_id
     group by vd.vendor_id, vd.vendor_name, vd.schedule_known,
              vd.next_delivery_date, vd.days_until
  ),
  -- (4m) VENDOR ROW JSON. Sorted by next_delivery_date ASC then
  -- vendor_name ASC so the manager sees imminent deliveries first.
  vendor_rows as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'vendor_id',                vwi.vendor_id,
        'vendor_name',              vwi.vendor_name,
        'schedule_known',           vwi.schedule_known,
        'next_delivery_date',       to_char(vwi.next_delivery_date, 'YYYY-MM-DD'),
        'days_until_next_delivery', vwi.days_until,
        'on_hand_source',           vwi.on_hand_source,
        'eod_submitted_at',         vwi.eod_submitted_at,
        'items',                    vwi.items,
        'vendor_total_cost',        vwi.vendor_total_cost
      )
      order by vwi.next_delivery_date asc, vwi.vendor_name asc
    ), '[]'::jsonb)                                                  as rows
      from vendors_with_items vwi
  ),
  -- (4n) KPI rollup. Reads off vendors_with_items (post-vendor-filter)
  -- so empty-vendor cards don't inflate counts.
  kpi_calc as (
    select
      count(*)::bigint                                               as vendor_count,
      coalesce(sum(jsonb_array_length(vwi.items)), 0)::bigint        as item_count,
      coalesce(sum(vwi.vendor_total_cost), 0)::numeric               as total_estimated_cost,
      count(*) filter (where vwi.on_hand_source = 'eod')::bigint     as eod_sourced_vendor_count,
      count(*) filter (where vwi.on_hand_source = 'stock')::bigint   as stock_fallback_vendor_count
      from vendors_with_items vwi
  )
  select vr.rows,
         jsonb_build_object(
           'vendor_count',                k.vendor_count,
           'item_count',                  k.item_count,
           'total_estimated_cost',        k.total_estimated_cost,
           'eod_sourced_vendor_count',    k.eod_sourced_vendor_count,
           'stock_fallback_vendor_count', k.stock_fallback_vendor_count
         )
    into v_vendors, v_kpis
    from vendor_rows vr
    cross join kpi_calc k;

  -- (5) WARNINGS — vendors that surfaced suggestions but have no
  -- order_schedule row (A5 fallback applied). Scoped to vendors that
  -- ACTUALLY appear in the final `v_vendors` payload so the warnings
  -- the user sees match the cards on screen. A vendor whose items
  -- are all at par (filtered out at per_item_filtered) won't generate
  -- a `schedule_unknown` warning even if it has no order_schedule row,
  -- because there's no card to attach the warning to.
  with surfaced_vendor_ids as (
    -- Extract vendor_ids from the already-built v_vendors envelope.
    -- jsonb_array_elements is a no-op when v_vendors is [].
    select (elem->>'vendor_id')::uuid as vendor_id
      from jsonb_array_elements(coalesce(v_vendors, '[]'::jsonb)) elem
  ),
  vendors_no_schedule as (
    select v.id as vendor_id, v.name as vendor_name
      from public.vendors v
      join surfaced_vendor_ids svi on svi.vendor_id = v.id
     where not exists (
         select 1
           from public.order_schedule os
          where os.store_id  = p_store_id
            and os.vendor_id = v.id
            and os.delivery_day is not null
       )
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'code',    'schedule_unknown',
      'message', 'Vendor "' || vns.vendor_name
                  || '" has no order schedule — using 7-day buffer.'
    )
  ), '[]'::jsonb) into v_warnings
    from vendors_no_schedule vns;

  -- (6) FINAL ENVELOPE.
  return jsonb_build_object(
    'as_of_date', to_char(v_as_of_date, 'YYYY-MM-DD'),
    'vendors',    coalesce(v_vendors, '[]'::jsonb),
    'kpis',       v_kpis,
    '_warnings',  coalesce(v_warnings, '[]'::jsonb)
  );
end;
$$;

-- NOTE: NO grant/revoke statements here. The function signature is
-- byte-identical to the spec-021 definition, so `create or replace`
-- PRESERVES the existing ACL (`revoke … from public, anon` + `grant …
-- to authenticated`). Re-stating it would be redundant churn.

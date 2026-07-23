-- Spec 138: Reorder becomes the single ordering surface — retire PO & Receiving.
--
-- Per the architect's OPTION A ruling (spec §"Architect ruling — drop the inbound
-- term on BOTH engines"), this ONE migration CREATE-OR-REPLACEs BOTH reorder
-- engines, applying the IDENTICAL `(4g) pending_po_qty` CTE change to each:
--
--   (1) public.report_reorder_list(uuid, jsonb)
--       — base = VERBATIM live body from 20260718000000_reorder_list_has_po.sql
--         (confirmed latest owner; nothing 20260719..20260725 replaces it).
--   (2) public.report_reorder_for_counted_onhand(uuid, jsonb, jsonb) — the STAFF
--       counted-on-hand engine (spec 105)
--       — base = VERBATIM latest-owner body from 20260704000000_po_loop.sql:1087
--         (the spec-107 real-netting version, NOT the 20260702000000 v1 body).
--
-- The SINGLE change to EACH function is its `(4g) pending_po_qty` CTE: it now
-- returns ZERO ROWS (`where false`) so every downstream
-- `coalesce(ppq.pending_po_qty, 0)` reads 0 — the emitted per-item
-- `pending_po_qty` is always 0 and `par_replacement` / `usage_forecasted` no
-- longer subtract inbound. Envelope shape is byte-stable in both (the JSON key
-- stays in report_reorder_list at value 0; report_reorder_for_counted_onhand
-- never surfaced the key — internal-only — so its flat item shape is unchanged).
--
-- WHY (Design §2 + ruling): with receiving fully retired for BOTH admin AND staff
-- (AC-3 drops the staff Receiving tab), a cart-filled order that the extension
-- transitions draft→'sent' would enter each engine's pending_po_qty and NEVER
-- clear (no receive, spec-125 auto-receive is inert by starvation), suppressing
-- that item's reorder forever — on the admin AND the staff reorder screen.
-- Option (a): drop the inbound term entirely from both — reorder plans purely off
-- counted on-hand vs par (+ usage forecast), the honest model for a "no inbound
-- record" world. The two-orders-before-next-count window this trades away is
-- short and self-corrects at the next EOD/weekly count. Keeping the two engines
-- byte-parallel preserves the pgTAP byte-parity guard (po_loop.test.sql).
--
-- Minimum-diff form (each function): only the CTE body changes; the
-- `left join pending_po_qty ppq`, the `coalesce(ppq.pending_po_qty, 0)`
-- references, report_reorder_list's `has_po` EXISTS, the auth gates,
-- `security invoker`, and `search_path = public` are all preserved textually.
-- Non-destructive CREATE OR REPLACE of two SECURITY-INVOKER read RPCs — no
-- table/column/index/policy/grant/publication change, no data touched, signatures
-- byte-identical so the existing revoke/grant ACLs are preserved. Instant on PG 17.

CREATE OR REPLACE FUNCTION public.report_reorder_list(p_store_id uuid, p_params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  -- (4f) Per-item on_hand — SPEC 102: now item × LINKED-VENDOR (was item
  -- 1:1 inventory_items.vendor_id). The item→vendor source is a JOIN on
  -- public.item_vendors, so a shared item produces ONE ROW PER LINKED
  -- vendor. The three on_hand cases are unchanged:
  --   case A: vendor has EOD today AND this item has a non-null
  --           actual_remaining → on_hand = actual_remaining, source=eod.
  --   case B: vendor has EOD today but THIS item's entry is missing/null
  --           → on_hand = inventory_items.current_stock, source=eod
  --           (vendor-level), 'eod_missing_for_item' flag attached.
  --   case C: vendor has no EOD today → on_hand = current_stock,
  --           source=stock.
  --
  -- SPEC 102 changes (and ONLY these):
  --   • vendor_id is iv.vendor_id (from the junction), not ii.vendor_id.
  --   • cost_per_unit is the PER-VENDOR cost from the junction, FALLING
  --     BACK to the item cost when null/0 (OQ-5):
  --       coalesce(nullif(iv.cost_per_unit, 0), ii.cost_per_unit, 0).
  --   • the source table gains `join public.item_vendors iv on
  --     iv.item_id = ii.id`, and latest_eod_per_vendor / eod_entries join
  --     on iv.vendor_id.
  --   • the `ii.vendor_id IS NOT NULL` filter is DROPPED — membership is
  --     now expressed by the inner JOIN to item_vendors (an item with no
  --     link produces no row, exactly as a null vendor_id did before).
  -- par_level / usage_per_portion / current_stock stay PER-ITEM (OQ-3).
  item_on_hand as (
    select
      ii.id                                              as item_id,
      ii.store_id,
      iv.vendor_id,                                      -- from junction, not ii.vendor_id
      ii.catalog_id,
      ii.par_level::numeric                              as par_level,       -- OQ-3: per-item, shared
      coalesce(ii.usage_per_portion, 0)::numeric         as usage_per_portion,
      -- OQ-5: per-vendor cost from the junction, fallback to item cost.
      coalesce(nullif(iv.cost_per_unit, 0), ii.cost_per_unit, 0)::numeric as cost_per_unit,
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
      join public.item_vendors iv
        on iv.item_id = ii.id                            -- explode by link
      left join latest_eod_per_vendor lev
        on lev.vendor_id = iv.vendor_id
      left join public.eod_entries e
        on e.submission_id = lev.submission_id
       and e.item_id = ii.id
     where ii.store_id = p_store_id
  ),
  -- (4f2) SPEC 102: per item, the full set of linked vendors (id + name)
  -- + the count. Feeds the OQ-1 coincident-schedule "also from N" hint
  -- (Hunk 3). Keyed by item; store-scoped via the inventory_items join.
  item_vendor_set as (
    select iv.item_id,
           jsonb_agg(jsonb_build_object('vendor_id', iv.vendor_id,
                                        'vendor_name', v.name)
                     order by v.name) as vendor_links,
           count(*)                   as vendor_link_count
      from public.item_vendors iv
      join public.vendors v          on v.id = iv.vendor_id
      join public.inventory_items ii on ii.id = iv.item_id
     where ii.store_id = p_store_id
     group by iv.item_id
  ),
  -- (4g) Pending PO quantity. SPEC 138: the inbound-netting term is RETIRED
  -- with receiving. This CTE now returns ZERO ROWS (`where false`), so the
  -- `left join pending_po_qty ppq` below always misses and every
  -- `coalesce(ppq.pending_po_qty, 0)` reads 0 — the emitted per-item
  -- `pending_po_qty` is always 0 and par_replacement / usage_forecasted no
  -- longer subtract inbound. Rationale (Design §1/§2): with no receive path,
  -- a cart-filled order that goes draft→'sent' would enter pending forever and
  -- suppress that item's reorder permanently. Reorder now plans purely off
  -- counted on-hand vs par (+ usage forecast). The `group by pit.item_id` +
  -- ::numeric shape is preserved verbatim so the join column types are
  -- unchanged; only the predicate flips to `where false`. Envelope key stays
  -- present (value 0) — byte-stable for every consumer.
  pending_po_qty as (
    select pit.item_id,
           sum(0)::numeric as pending_po_qty
      from public.po_items pit
     where false            -- spec 138: inbound netting retired with receiving
     group by pit.item_id
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
         join public.item_vendors iv on iv.item_id = ii.id
        where ii.store_id  = p_store_id
          and iv.vendor_id = v.id
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
  --
  -- Spec 100 hunk (1): surface ci.i18n_names from the SAME `ci` join so
  -- the staff reorder screen can render localized item names via
  -- getLocalizedName the way EOD/Weekly already do. JSONB; NULL → JSON
  -- null → mapper coalesces to {} → silent English fallback. No new
  -- join, no new scan.
  --
  -- Spec 104 hunk (1): surface the catalog's sub_unit_size from the SAME
  -- `ci` join (no new join, no new scan). coalesce(…, 1) so a NULL reads
  -- as 1 (= "tracking unit IS the smallest unit") downstream. It threads
  -- through per_item_suggested (pi.*) and per_item_filtered (pis.*) with
  -- no further edit, and feeds the estimated_cost × sub_unit_size bridge
  -- in per_item_filtered (OQ-1: keeps reorder totals numerically identical
  -- now that cost_per_unit is per-each).
  per_item as (
    select
      ioh.vendor_id,
      ioh.item_id,
      ci.name                                                       as item_name,
      ci.i18n_names                                                 as i18n_names,
      coalesce(ci.unit, '')                                         as unit,
      coalesce(ci.case_qty, 1)::numeric                             as case_qty,
      coalesce(ci.sub_unit_size, 1)::numeric                        as sub_unit_size,
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
  --
  -- Spec 104 hunk (2): cost_per_unit is now per-EACH (smallest unit), but
  -- suggested_qty / suggested_cases are in COUNTED units. Multiply BOTH
  -- branches by pis.sub_unit_size UNCONDITIONALLY so the dollar total stays
  -- numerically IDENTICAL to the pre-spec figure (per ★: cost_old =
  -- cost_per_unit × sub_unit_size). Under option (b) cost_per_unit is uniformly
  -- per-each on every row, so the bridge needs no discriminator: a sub_unit_size
  -- = 1 row had its flip be a no-op (× 1), and a cost_old = 0 row is 0 on both
  -- bases. Reorder remains case-accurate (OQ-1) — the cases/units display below
  -- is unchanged; only the cost derivation adapts to the new basis.
  per_item_filtered as (
    select
      pis.*,
      case when pis.case_qty > 1
           then ceil(pis.suggested_qty / pis.case_qty)
           else null end                                            as suggested_cases,
      case when pis.case_qty > 1
           then (ceil(pis.suggested_qty / pis.case_qty) * pis.case_qty * pis.cost_per_unit * pis.sub_unit_size)
           else (pis.suggested_qty * pis.cost_per_unit * pis.sub_unit_size) end
                                                                     as estimated_cost,
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
     -- Spec (2026-07): when p_params.include_stocked is true, keep EVERY item
     -- (including at/above par) so the staff Reorder screen can show a
     -- "Have enough stock" section. Absent/false (the admin default) → the
     -- original below-par-only filter, byte-for-byte unchanged.
     where (coalesce((p_params->>'include_stocked')::boolean, false)
            or pis.suggested_qty >= 0.001)
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
          -- Spec 100 hunk (2): additive per-item localized-name key.
          -- JSONB object (e.g. {"zh-CN":"虾仁去头"}) or JSON null when the
          -- catalog row has no overrides; the staff mapper coalesces
          -- null/absent to {} so getLocalizedName falls through to the
          -- English item_name. The admin mapper ignores this key.
          'i18n_names',       pif.i18n_names,
          'unit',             pif.unit,
          'on_hand',          pif.on_hand,
          'pending_po_qty',   pif.pending_po_qty,
          'par_level',        pif.par_level,
          'usage_forecasted', pif.usage_forecasted,
          'par_replacement',  pif.par_replacement,
          'suggested_qty',    pif.suggested_qty,
          -- Spec (2026-07): true when the item is below par and should be
          -- ordered; false for at/above-par items surfaced by include_stocked.
          -- Always present (admin items are all true, so admin is unaffected).
          'needs_order',      (pif.suggested_qty >= 0.001),
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
          'flags',            pif.flags,
          -- Spec 102 hunk (3): OQ-1 coincident-schedule "also from N"
          -- hint. ADVISORY ONLY — does not change which card the item
          -- appears on. other_vendor_count is 0 for a single-vendor item
          -- (existing rendering unaffected). also_from_vendors is the set
          -- of the item's OTHER linked vendors (excluding THIS card's
          -- vendor) for the UI to name. The mapper ignores both keys
          -- until taught; envelope shape is unchanged.
          'other_vendor_count', greatest(0, coalesce(ivs.vendor_link_count, 1) - 1),
          'also_from_vendors',  coalesce(
             (select jsonb_agg(l)
                from jsonb_array_elements(coalesce(ivs.vendor_links, '[]'::jsonb)) l
               where (l->>'vendor_id')::uuid <> pif.vendor_id),
             '[]'::jsonb)
        )
        order by pif.suggested_qty desc, pif.item_name asc
      )                                                              as items
      from per_item_filtered pif
      join vendor_delivery vd on vd.vendor_id = pif.vendor_id
      left join item_on_hand ioh_lev on ioh_lev.item_id = pif.item_id
                                    and ioh_lev.vendor_id = pif.vendor_id
      left join item_vendor_set ivs  on ivs.item_id = pif.item_id
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
        'vendor_total_cost',        vwi.vendor_total_cost,
        -- Spec 123: per-vendor "PO CREATED" signal. TRUE when a
        -- non-cancelled purchase_orders row exists for this store + this
        -- vendor keyed on the SAME v_as_of_date the reorder list is
        -- computed for. Legacy null-reference_date drafts never match
        -- (null = date is never true) — by design, no backfill.
        'has_po', exists (
          select 1
            from public.purchase_orders po
           where po.store_id       = p_store_id
             and po.vendor_id      = vwi.vendor_id
             and po.reference_date = v_as_of_date
             and po.status <> 'cancelled'
        )
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
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (2) report_reorder_for_counted_onhand(uuid, jsonb, jsonb) re-CREATE — the
-- STAFF counted-on-hand engine (spec 105). Base body copied VERBATIM from its
-- latest-owner definition (20260704000000_po_loop.sql:1087 — the spec-107
-- real-netting version). EXACTLY ONE hunk versus that body: the (4g)
-- pending_po_qty CTE, swapped IDENTICALLY to report_reorder_list above so its
-- pending reads 0 and it stops subtracting inbound. Per the verbatim-copy
-- discipline both reorder migrations document, the two engines' pending_po_qty
-- CTE + downstream use stay byte-parallel — po_loop.test.sql's byte-parity guard
-- now asserts BOTH engines emit no inbound reduction (parity holds at the
-- un-netted baseline). Signature byte-identical → `create or replace` PRESERVES
-- the existing revoke/grant ACL.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.report_reorder_for_counted_onhand(
  p_store_id uuid,
  p_on_hand  jsonb,                       -- { "<item_id>": <counted_total_numeric>, ... }
  p_params   jsonb default '{}'::jsonb    -- { "as_of_date": "YYYY-MM-DD" } (optional)
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_as_of_date              date;
  v_today_dow_num           int;
  v_today_time              time;
  v_items                   jsonb;
  v_warnings                jsonb;
  v_truncated_recipe_count  bigint;
begin
  -- (1) AUTH GATE — first statement. Byte-identical to report_reorder_list
  -- (…_multi_vendor.sql:84-88). This is the store the COUNT belongs to.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (1b) EMPTY-MAP FAST PATH. Empty / null p_on_hand → nothing to score;
  -- return the empty envelope WITHOUT scanning the recipe graph. The FE
  -- only calls this when it has at least one below-par entry, but guard
  -- cheaply anyway (Delta 1: the count IS the on-hand set).
  if p_on_hand is null or p_on_hand = '{}'::jsonb then
    return jsonb_build_object(
      'as_of_date', to_char(coalesce(nullif(p_params->>'as_of_date','')::date, current_date), 'YYYY-MM-DD'),
      'items',      '[]'::jsonb,
      '_warnings',  '[]'::jsonb
    );
  end if;

  -- (2) AS-OF DATE RESOLUTION. Frontend passes the store-local "today"
  -- as YYYY-MM-DD via p_params. When omitted, fall back to the server's
  -- current_date (UTC). Same caveat / contract as report_reorder_list —
  -- the forecast window and delivery offset are LIVE (as of today), NOT
  -- the count date (spec 105 semantic caveat: historical on-hand + live
  -- forecast/timing).
  v_as_of_date := coalesce(
    nullif(p_params->>'as_of_date', '')::date,
    current_date
  );
  v_today_dow_num := extract(dow from v_as_of_date)::int; -- 0=Sun..6=Sat
  v_today_time    := (now() at time zone 'utc')::time;

  -- (3) DEPTH-CAP PRE-WALK — recipe-graph depth cap is 5, same as the
  -- engine. Copied verbatim from …_multi_vendor.sql.
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
    raise notice 'Counted-reorder report: prep-recipe chain exceeds depth 5 (% recipe(s) truncated)',
      v_truncated_recipe_count;
  end if;

  -- (4) MAIN AGGREGATION. Same CTE chain as report_reorder_list; the two
  -- deltas are localized to (4f) item_on_hand and (4l+) the output.
  with recursive
  -- (4a) Direct (non-prep) ingredients per recipe. Verbatim.
  direct_ri as (
    select ri.recipe_id, ri.catalog_id, ri.quantity::numeric as qty
      from public.recipe_ingredients ri
     where ri.catalog_id is not null
  ),
  -- (4b) Recursive flatten with depth cap + cycle detection. Verbatim.
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
  -- (4c) Combined per-recipe ingredient quantities. Verbatim.
  all_ri as (
    select recipe_id, catalog_id, sum(qty)::numeric as qty
      from (
        select * from direct_ri
        union all
        select recipe_id, catalog_id, qty from prep_leaves
      ) u
     group by recipe_id, catalog_id
  ),
  -- (4d) Per-recipe truncation flag. Verbatim.
  recipe_meta as (
    select ari.recipe_id,
           bool_or(tr.recipe_id is not null) as truncated
      from all_ri ari
      left join truncated_recipes tr on tr.recipe_id = ari.recipe_id
     group by ari.recipe_id
  ),
  -- (4f) DELTA 1 — Per-item on_hand from the CALLER-SUPPLIED p_on_hand
  -- map (was the three-branch EOD/stock CASE in report_reorder_list). The
  -- item×LINKED-VENDOR explosion via item_vendors is PRESERVED (spec 102
  -- shape) so delivery timing can consider every vendor that carries the
  -- item; par_level / usage_per_portion stay PER-ITEM. There is NO
  -- eod_submissions / eod_entries / latest_eod_per_vendor read: the
  -- counted total IS the on-hand snapshot for this record. Items ABSENT
  -- from p_on_hand produce NO ROW (the `p_on_hand ? item-key` filter) — the
  -- FE sends only the below-par entries it wants suggestions for. Cost is
  -- dropped from this CTE (Delta 2 — no $ output).
  item_on_hand as (
    select
      ii.id                                              as item_id,
      ii.store_id,
      iv.vendor_id,                                      -- from junction (explosion preserved)
      ii.catalog_id,
      ii.par_level::numeric                              as par_level,
      coalesce(ii.usage_per_portion, 0)::numeric         as usage_per_portion,
      (p_on_hand ->> ii.id::text)::numeric               as on_hand
      from public.inventory_items ii
      join public.item_vendors iv
        on iv.item_id = ii.id                            -- explode by link (preserved)
     where ii.store_id = p_store_id
       and p_on_hand ? ii.id::text                       -- DELTA 1: only supplied items
  ),
  -- (4g) Pending PO quantity. SPEC 138 (option A ruling): the inbound-netting
  -- term is RETIRED with receiving on the STAFF engine too. This CTE now returns
  -- ZERO ROWS (`where false`), so the `left join pending_po_qty ppq` below always
  -- misses and every `coalesce(ppq.pending_po_qty, 0)` reads 0 — par_replacement
  -- / usage_forecasted no longer subtract inbound. Rationale (Design §2 + ruling
  -- §1): a cart-filled order that goes draft→'sent' would enter pending forever
  -- and suppress that item on the staff reorder screen permanently (receiving
  -- retired for staff too — AC-3). Swapped byte-IDENTICALLY to report_reorder_list
  -- above so the two engines stay byte-parallel (po_loop.test.sql byte-parity
  -- guard). The `group by pit.item_id` + ::numeric shape is preserved verbatim so
  -- the join column types are unchanged; only the predicate flips to `where
  -- false`. This engine never surfaced the pending key (internal-only) so its
  -- flat item envelope is unchanged.
  pending_po_qty as (
    select pit.item_id,
           sum(0)::numeric as pending_po_qty
      from public.po_items pit
     where false            -- spec 138: inbound netting retired with receiving
     group by pit.item_id
  ),
  -- (4h) Sales depletion average (per-day). Verbatim from
  -- …_multi_vendor.sql (4h). Items not in any recipe yield no row →
  -- coalesced to 0 downstream.
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
  -- (4i) NEXT-DELIVERY computation per vendor. Verbatim from
  -- …_multi_vendor.sql (4i) — the MIN-over-per-day-offset logic with
  -- order_cutoff_time handling and the A5 (7-day) fallback.
  vendor_delivery_offsets as (
    select
      v.id            as vendor_id,
      v.name          as vendor_name,
      v.order_cutoff_time,
      os.days_offset  as days_offset
      from public.vendors v
      cross join lateral (
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
         join public.item_vendors iv on iv.item_id = ii.id
        where ii.store_id  = p_store_id
          and iv.vendor_id = v.id
     )
  ),
  -- (4j) Resolve next-delivery metadata per vendor (A5 fallback). Verbatim.
  vendor_delivery as (
    select
      vdo.vendor_id,
      vdo.vendor_name,
      coalesce(vdo.days_offset, 7)                       as days_until,
      (vdo.days_offset is not null)                       as schedule_known,
      v_as_of_date + coalesce(vdo.days_offset, 7)         as next_delivery_date
      from vendor_delivery_offsets vdo
  ),
  -- (4k) PER-(item, vendor) MATH. par_replacement / usage_forecasted /
  -- suggested_qty formulae copied VERBATIM from …_multi_vendor.sql (4k).
  -- Still per-(item, vendor) here because delivery timing (days_until) is
  -- per-vendor; Delta 2 collapses to per-item AFTER the case math. Cost is
  -- dropped (no cost_per_unit column, no estimated_cost). i18n_names is
  -- also dropped — this feature renders the FE's own already-joined item
  -- name from the Zustand inventory array (no name in the payload).
  per_item as (
    select
      ioh.vendor_id,
      ioh.item_id,
      coalesce(ci.case_qty, 1)::numeric                             as case_qty,
      ioh.on_hand,
      coalesce(ppq.pending_po_qty, 0)                                as pending_po_qty,
      ioh.par_level,
      case when ioh.usage_per_portion > 0 then ioh.usage_per_portion else null end
                                                                     as usage_per_portion,
      coalesce(pos.qty_per_day, 0)::numeric                          as qty_per_day,
      coalesce(pos.truncated, false)                                 as truncated,
      vd.days_until,
      vd.schedule_known,
      vd.next_delivery_date,
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
  -- (4k2) Case math — spec 088 verbatim (minus estimated_cost, which is a
  -- cost field and is OMITTED per Delta 2). suggested_cases = ceil(qty /
  -- case_qty) when case_qty > 1 (null/0/1 normalized to 1 above), else
  -- NULL. Per-item flag list is the ITEM-GRAIN subset of the engine's
  -- vocabulary — no_par / no_usage_rate / truncated. The engine's
  -- eod_missing_for_item token is dropped (no EOD path — Delta 1).
  per_item_filtered as (
    select
      pis.*,
      case when pis.case_qty > 1
           then ceil(pis.suggested_qty / pis.case_qty)
           else null end                                            as suggested_cases,
      (
        case when coalesce(pis.par_level, 0) <= 0 then jsonb_build_array('no_par')
             else '[]'::jsonb end
        ||
        case when pis.usage_per_portion is null or coalesce(pis.qty_per_day, 0) = 0
                  then jsonb_build_array('no_usage_rate')
             else '[]'::jsonb end
        ||
        case when pis.truncated then jsonb_build_array('truncated')
             else '[]'::jsonb end
      )                                                              as flags
      from per_item_suggested pis
     where pis.suggested_qty >= 0.001
  ),
  -- (4l) DELTA 2 — COLLAPSE per-(item, vendor) to PER-ITEM. Everything
  -- except delivery timing is per-item already (par/usage/suggested are
  -- computed from per-item inputs and are identical across an item's
  -- vendor rows). days_until / next_delivery_date / schedule_known are
  -- per-VENDOR, so pick the item's SOONEST truck: min(days_until), and
  -- carry that row's next_delivery_date. schedule_known is TRUE iff ANY of
  -- the item's vendors had a real schedule (else the 7-day A5 fallback was
  -- used for ALL of them). The soonest-truck row is chosen via distinct on.
  per_item_collapsed as (
    select distinct on (pif.item_id)
      pif.item_id,
      pif.on_hand,
      pif.par_level,
      pif.par_replacement,
      pif.usage_forecasted,
      pif.suggested_qty,
      pif.case_qty,
      pif.suggested_cases,
      case when pif.suggested_cases is not null
           then pif.suggested_cases * pif.case_qty
           else pif.suggested_qty end                               as suggested_units,
      pif.days_until,
      pif.next_delivery_date,
      -- schedule_known: TRUE if ANY vendor for this item had a real
      -- schedule. bool_or over the item's rows, surfaced via a window so
      -- the distinct-on row carries the item-wide value.
      bool_or(pif.schedule_known)
        over (partition by pif.item_id)                              as schedule_known,
      pif.flags
      from per_item_filtered pif
     order by pif.item_id, pif.days_until asc, pif.next_delivery_date asc
  ),
  -- (4m) FLAT ITEM ROWS. Sorted by suggested_qty desc for a stable order
  -- (the FE keys by item_id, so order is cosmetic).
  item_rows as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'item_id',            pic.item_id,
        'on_hand',            pic.on_hand,
        'par_level',          pic.par_level,
        'par_replacement',    pic.par_replacement,
        'usage_forecasted',   pic.usage_forecasted,
        'suggested_qty',      pic.suggested_qty,
        'case_qty',           pic.case_qty,
        'suggested_cases',    pic.suggested_cases,
        'suggested_units',    pic.suggested_units,
        'days_until',         pic.days_until,
        'next_delivery_date', to_char(pic.next_delivery_date, 'YYYY-MM-DD'),
        'schedule_known',     pic.schedule_known,
        'flags',              pic.flags
      )
      order by pic.suggested_qty desc, pic.item_id asc
    ), '[]'::jsonb)                                                  as rows
      from per_item_collapsed pic
  )
  select ir.rows into v_items
    from item_rows ir;

  -- (5) WARNINGS — reserved; may stay [] in v1 (spec 105 response shape).
  -- The vendor-level schedule_unknown warnings the engine surfaces have no
  -- vendor cards to attach to in the flat item output; the per-item
  -- schedule_known flag carries the same signal.
  v_warnings := '[]'::jsonb;

  -- (6) FINAL ENVELOPE — flat, item-keyed (Delta 2).
  return jsonb_build_object(
    'as_of_date', to_char(v_as_of_date, 'YYYY-MM-DD'),
    'items',      coalesce(v_items, '[]'::jsonb),
    '_warnings',  coalesce(v_warnings, '[]'::jsonb)
  );
end;
$$;

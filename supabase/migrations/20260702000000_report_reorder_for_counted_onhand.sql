-- ============================================================
-- Spec 105 — report_reorder_for_counted_onhand: reorder math for a
-- CALLER-SUPPLIED counted on-hand map, flat per-item output.
--
-- Powers the inventory-count history detail's below-par inline reorder
-- suggestion: given a past count's counted totals as the on-hand basis,
-- return "what you'd order RIGHT NOW" (live 7-day usage forecast + live
-- next-delivery timing over this record's counted on-hand). Read-only.
--
-- The forecast / case / next-delivery CTE chain is copied VERBATIM from
-- the CURRENT on-disk LATEST report_reorder_list body
-- (20260630000100_report_reorder_list_multi_vendor.sql — which carries the
-- spec 087 as_of_date / EOD-first logic, the spec 088 case math, the
-- spec 100 i18n keys, AND the spec 102 item_vendors explosion). Per the
-- function-header rule both reorder migrations state, this copies that
-- LATEST body, NOT a stale revision — a future engine-editing spec that
-- changes the forecast/case/delivery formula MUST update this sibling too,
-- or the two silently diverge (the accepted cost of NOT touching the
-- load-bearing ~600-line report_reorder_list — spec 105 backend design
-- "Verbatim-copy drift" risk). The report_reorder_for_counted_onhand
-- pgTAP suite pins the two deltas below.
--
-- EXACTLY TWO structural deltas versus the copied body — everything else
-- (direct_ri / recursive_prep / all_ri / recipe_meta / pos_daily_per_item /
-- vendor_delivery_offsets / vendor_delivery, the depth-cap pre-walk, the
-- par_replacement / usage_forecasted / suggested_qty / suggested_cases /
-- suggested_units formulae, the as_of_date resolution, the schedule/
-- next-delivery math, the flag vocabulary) is byte-for-byte identical:
--
--   Delta 1 — ON-HAND SOURCE. The item_on_hand CTE's three-branch
--     EOD/stock CASE (cases A/B/C reading eod_submissions + eod_entries +
--     inventory_items.current_stock) is REPLACED by a single lookup into
--     the caller-supplied p_on_hand jsonb map:
--       on_hand := (p_on_hand ->> ii.id::text)::numeric
--     Items ABSENT from the map produce NO ROW (an inner-ish filter on
--     `p_on_hand ? ii.id::text`) — the FE sends only the below-par entries
--     it wants suggestions for. There is NO eod_submissions /
--     eod_entries / latest_eod_per_vendor read at all; the counted total
--     IS the on-hand snapshot. item_on_hand_source is dropped (always the
--     supplied count) and eod_missing_for_item is dropped (no EOD path).
--     The item×vendor explosion via item_vendors is PRESERVED so delivery
--     timing can still consider every vendor that carries the item.
--
--   Delta 2 — OUTPUT GRAIN. Instead of the vendor-grouped / item-exploded
--     envelope ({vendors[], kpis, _warnings}), the RPC returns a FLAT
--     array keyed by item_id ({as_of_date, items[], _warnings}). For an
--     item linked to N vendors with different schedules the per-(item,
--     vendor) rows are COLLAPSED to the item's SOONEST next delivery —
--     min(days_until) across the item's linked vendors — answering "when
--     does the next truck that carries this item arrive." NO cost fields:
--     cost_per_unit / estimated_cost / vendor_total_cost are DELIBERATELY
--     OMITTED (spec 105 out-of-scope: no $ display → spec 104's per-each
--     basis stays disengaged). suggested_cases / suggested_units follow
--     the spec 088 case math verbatim.
--
-- security invoker + `set search_path = public` + the auth_can_see_store
-- gate as the FIRST statement are byte-identical to report_reorder_list
-- (…_multi_vendor.sql:72-73, 84-88). MUST be invoker, not definer: the
-- auth gate relies on the caller's own RLS context. This is the store the
-- COUNT belongs to (the FE passes detail.storeId). No RLS change, no
-- realtime/publication change (no table membership touched, so the
-- docker-restart publication gotcha does NOT apply). Depends only on
-- objects that predate it (item_vendors, catalog_ingredients,
-- order_schedule, pos_imports, the recipe tables, auth_can_see_store) →
-- ordered AFTER the latest on-disk migration (…20260701000000). Additive
-- new signature; rollback = `drop function`. Because it is a NEW
-- function, the GRANT/REVOKE is stated EXPLICITLY below (mirrors
-- report_reorder_list's ACL exactly — revoke from public, anon; grant to
-- authenticated).
-- ============================================================

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
  -- (4g) Pending PO quantity. v1: ALWAYS 0. `select distinct` collapses
  -- the per-(item, vendor) explosion to ONE row per item (verbatim
  -- rationale from …_multi_vendor.sql (4g) — keeps a shared item from
  -- fanning its per_item row out by its vendor-link count).
  pending_po_qty as (
    select distinct ioh.item_id,
           0::numeric as pending_po_qty
      from item_on_hand ioh
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

-- Grants — mirror report_reorder_list's ACL EXACTLY (…_multi_vendor.sql
-- relies on `create or replace` preserving it; this is a NEW signature so
-- the migration MUST state it). `revoke … from public` is required
-- because authenticated/anon inherit from PUBLIC; a bare `revoke from
-- anon` leaves the function callable via PUBLIC.
revoke execute on function public.report_reorder_for_counted_onhand(uuid, jsonb, jsonb)
  from public, anon;
grant  execute on function public.report_reorder_for_counted_onhand(uuid, jsonb, jsonb)
  to authenticated;

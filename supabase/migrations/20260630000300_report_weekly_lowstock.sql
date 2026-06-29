-- ============================================================
-- Spec 102 — report_weekly_lowstock: advisory low-stock-vs-next-delivery
-- warning for the weekly full-store count (SD-2 / AC-H / US-5).
--
-- The weekly count screen is FULL-STORE and ADVISORY (it does NOT place or
-- suggest orders — out-of-scope "weekly-count ordering"). US-5 wants each
-- ingredient to WARN when its on-hand is too low to last until its NEXT
-- delivery date, catching shortfalls the schedule-driven reorder would
-- only surface on the vendor's order day.
--
-- SD-2 rationale (server-computed, not client-side): the "nearest next
-- delivery" date needs the SAME DOW / cutoff offset math the reorder RPC
-- already encodes (the vendor_delivery_offsets CTE). Re-deriving that in TS
-- in WeeklyCount.tsx would fork a subtle, well-tested algorithm onto the
-- advisory surface. This small read-only RPC reuses that pattern and stays
-- on the JWT-protected `security invoker` path (per the spec note "prefer
-- an RPC over a new edge function"). It mirrors the security shape of the
-- reports trilogy (report_reorder_list / report_run_*): security invoker,
-- auth_can_see_store pre-flight gate, per-read RLS, and an anon/public
-- EXECUTE revoke + authenticated grant.
--
-- CONTRACT
--   Inputs:  p_store_id; p_params.as_of_date (store-local today, same
--            time-zone caveat as the reorder RPC). No write.
--   Per item — ALL store items WITH ≥1 vendor link (a no-vendor item has
--   no "next delivery date" to compare against, so it is excluded; the
--   screen renders its on-hand with no badge):
--     • on_hand            — EOD-first / current_stock fallback, but
--                            ITEM-grained (one row per item — the shared
--                            on-hand is ONE number, NOT exploded per link).
--                            EOD-first means: if ANY of the item's linked
--                            vendors submitted today AND this item has a
--                            non-null actual_remaining in that submission,
--                            use it; else current_stock.
--     • next_delivery_date — NEAREST across ALL the item's vendors (OQ-4):
--                            min(next_delivery_date) over the item's linked
--                            vendors, reusing the reorder offset math.
--     • days_until         — next_delivery_date − as_of_date.
--     • usage_per_day      — reorder's pos_daily_per_item per-day rate;
--                            degrades to 0 when no usage signal.
--     • projected_on_hand  — on_hand − usage_per_day * days_until.
--     • low_stock (bool)   — projected_on_hand < 0 (runs out before the
--                            nearest delivery). When usage_per_day = 0 (no
--                            signal), fall back to on_hand <= 0 so a
--                            zero-stock item still warns; otherwise false
--                            (advisory, conservative — don't cry wolf
--                            without a usage rate).
--   Envelope:
--     { "as_of_date": "YYYY-MM-DD",
--       "items": [ { item_id, item_name, unit, on_hand,
--                    next_delivery_date, days_until, usage_per_day,
--                    projected_on_hand, low_stock } ] }
--
-- No PO / order / suggestion affordance (AC-H advisory; out-of-scope
-- weekly-count ordering). No realtime/publication change. New function →
-- the GRANT/REVOKE block at the bottom is emitted (this is the function's
-- birth, not a `create or replace` of an existing ACL). Depends on
-- item_vendors existing → ordered AFTER …000000.
-- ============================================================

create or replace function public.report_weekly_lowstock(
  p_store_id uuid,
  p_params   jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_as_of_date    date;
  v_today_dow_num int;
  v_today_time    time;
  v_items         jsonb;
begin
  -- (1) AUTH GATE — first statement. Mirrors report_reorder_list.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) AS-OF DATE RESOLUTION. Same caveat as the reorder runner — the
  -- caller passes the store-local "today" as YYYY-MM-DD; fall back to the
  -- server's current_date (UTC) when omitted.
  v_as_of_date := coalesce(
    nullif(p_params->>'as_of_date', '')::date,
    current_date
  );
  v_today_dow_num := extract(dow from v_as_of_date)::int; -- 0=Sun..6=Sat
  v_today_time    := (now() at time zone 'utc')::time;

  with recursive
  -- (a) Direct (non-prep) ingredients per recipe. Copied from the reorder
  -- runner's all_ri chain — needed for the per-day usage rate (d).
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
  -- (b) Items in scope — every store item WITH ≥1 vendor link. The
  -- shared on-hand is ITEM-grained, so this is one row per item (NOT
  -- exploded per link). DISTINCT collapses the multi-link items.
  scoped_items as (
    select distinct
      ii.id          as item_id,
      ii.store_id,
      ii.catalog_id,
      coalesce(ii.current_stock, 0)::numeric as current_stock
      from public.inventory_items ii
      join public.item_vendors iv on iv.item_id = ii.id
     where ii.store_id = p_store_id
  ),
  -- (c) EOD-first on_hand, ITEM-grained. The item draws from EOD iff ANY
  -- of its linked vendors submitted today AND this item has a non-null
  -- actual_remaining in that submission. We take MAX(actual_remaining)
  -- across such submissions (post-spec-020 there is at most one
  -- submission per (vendor, day); across the item's vendors there could
  -- be several, but the client sends the SAME shared on-hand under each
  -- tab, so any of them is the same number — MAX is an order-independent
  -- pick). Falls back to current_stock when no EOD signal.
  item_eod as (
    select
      si.item_id,
      max(e.actual_remaining)::numeric as eod_remaining
      from scoped_items si
      join public.eod_submissions s
        on s.store_id = p_store_id
       and s.date     = v_as_of_date
       and s.status   = 'submitted'
       and s.vendor_id in (
         select iv.vendor_id from public.item_vendors iv
          where iv.item_id = si.item_id
       )
      join public.eod_entries e
        on e.submission_id = s.id
       and e.item_id       = si.item_id
       and e.actual_remaining is not null
     group by si.item_id
  ),
  item_on_hand as (
    select
      si.item_id,
      si.store_id,
      si.catalog_id,
      case when ie.eod_remaining is not null
           then ie.eod_remaining
           else si.current_stock end as on_hand
      from scoped_items si
      left join item_eod ie on ie.item_id = si.item_id
  ),
  -- (d) Per-day usage rate — identical to the reorder runner's
  -- pos_daily_per_item (trailing 7d window ÷ 7). Items not in any recipe
  -- yield no row → degrade to 0 below.
  pos_daily_per_item as (
    select
      ii.id                                                  as item_id,
      sum(pii.qty_sold::numeric * ari.qty)::numeric / 7.0    as qty_per_day
      from public.pos_imports pi
      join public.pos_import_items pii on pii.import_id = pi.id
      join all_ri ari                  on ari.recipe_id = pii.recipe_id
      join public.inventory_items ii   on ii.catalog_id = ari.catalog_id
                                      and ii.store_id   = p_store_id
     where pi.store_id    = p_store_id
       and pi.import_date >  (v_as_of_date - 7)
       and pi.import_date <= v_as_of_date
       and pii.recipe_id is not null
       and pii.recipe_mapped = true
     group by ii.id
  ),
  -- (e) Per-vendor next-delivery offset — copied verbatim from the
  -- reorder runner's vendor_delivery_offsets, EXCEPT the existence filter
  -- joins item_vendors (a vendor is in scope iff it is LINKED to a store
  -- item, matching the reorder rewrite's (4i)). Same DOW/cutoff math.
  vendor_delivery_offsets as (
    select
      v.id            as vendor_id,
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
  -- (f) Per-vendor next_delivery_date (A5 fallback to 7 days, same as the
  -- reorder runner's vendor_delivery).
  vendor_delivery as (
    select
      vdo.vendor_id,
      v_as_of_date + coalesce(vdo.days_offset, 7) as next_delivery_date
      from vendor_delivery_offsets vdo
  ),
  -- (g) NEAREST next-delivery across the item's vendors (OQ-4). MIN of
  -- the per-vendor next_delivery_date over the item's links.
  item_next_delivery as (
    select
      iv.item_id,
      min(vd.next_delivery_date) as next_delivery_date
      from public.item_vendors iv
      join public.inventory_items ii on ii.id = iv.item_id
      join vendor_delivery vd        on vd.vendor_id = iv.vendor_id
     where ii.store_id = p_store_id
     group by iv.item_id
  ),
  -- (h) Assemble per-item rows. days_until / projected_on_hand /
  -- low_stock per the contract. next_delivery_date may be NULL only if a
  -- linked vendor produced no delivery row, which cannot happen here
  -- (vendor_delivery always emits a row per linked vendor via the A5
  -- fallback) — but coalesce days_until to NULL-safe just in case.
  rows_out as (
    select
      ioh.item_id,
      ci.name                                            as item_name,
      coalesce(ci.unit, '')                              as unit,
      ioh.on_hand,
      ind.next_delivery_date,
      (ind.next_delivery_date - v_as_of_date)            as days_until,
      coalesce(pos.qty_per_day, 0)::numeric              as usage_per_day,
      (ioh.on_hand
        - coalesce(pos.qty_per_day, 0)::numeric
          * greatest(0, (ind.next_delivery_date - v_as_of_date)))::numeric
                                                         as projected_on_hand,
      case
        when coalesce(pos.qty_per_day, 0) > 0 then
          (ioh.on_hand
            - pos.qty_per_day
              * greatest(0, (ind.next_delivery_date - v_as_of_date))) < 0
        else ioh.on_hand <= 0
      end                                                as low_stock
      from item_on_hand ioh
      join public.catalog_ingredients ci on ci.id = ioh.catalog_id
      join item_next_delivery ind        on ind.item_id = ioh.item_id
      left join pos_daily_per_item pos    on pos.item_id = ioh.item_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'item_id',            ro.item_id,
      'item_name',          ro.item_name,
      'unit',               ro.unit,
      'on_hand',            ro.on_hand,
      'next_delivery_date', to_char(ro.next_delivery_date, 'YYYY-MM-DD'),
      'days_until',         ro.days_until,
      'usage_per_day',      ro.usage_per_day,
      'projected_on_hand',  ro.projected_on_hand,
      'low_stock',          ro.low_stock
    )
    order by ro.low_stock desc, ro.item_name asc
  ), '[]'::jsonb) into v_items
    from rows_out ro;

  return jsonb_build_object(
    'as_of_date', to_char(v_as_of_date, 'YYYY-MM-DD'),
    'items',      coalesce(v_items, '[]'::jsonb)
  );
end;
$$;

-- ─── GRANT — new function, emit the ACL at birth ───────────────
-- Mirrors the reports trilogy: lock anon/public out, grant authenticated
-- EXECUTE. security invoker means per-read RLS still applies under the
-- caller's JWT; the in-body auth_can_see_store gate is the explicit
-- store-membership boundary. (reports_anon_revoke.test.sql pattern.)
revoke execute on function public.report_weekly_lowstock(uuid, jsonb) from public, anon;
grant  execute on function public.report_weekly_lowstock(uuid, jsonb) to authenticated;

comment on function public.report_weekly_lowstock(uuid, jsonb) is
  'spec 102: advisory weekly low-stock warning. Per store item with ≥1 vendor link, returns shared on_hand (EOD-first / current_stock fallback, item-grained), the NEAREST next_delivery_date across the item''s vendors (OQ-4), days_until, usage_per_day (trailing-7d ÷ 7), projected_on_hand, and low_stock (projected < 0, or on_hand <= 0 when no usage signal). Read-only — creates no orders/POs (AC-H advisory). security invoker; auth_can_see_store gate; GRANTed to authenticated, REVOKEd from anon/public.';

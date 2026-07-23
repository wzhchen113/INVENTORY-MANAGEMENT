-- supabase/tests/report_reorder_list_no_inbound.test.sql
--
-- Spec 138 — pins the CREATE OR REPLACE of report_reorder_list in
-- supabase/migrations/20260726000000_reorder_drop_inbound_term.sql: the
-- `(4g) pending_po_qty` inbound-netting term is RETIRED (the CTE returns zero
-- rows via `where false`), so:
--
--   • every surfaced item emits `pending_po_qty = 0`, and
--   • `suggested_qty` / `par_replacement` NO LONGER subtract inbound —
--     the plan is counted-on-hand-vs-par only.
--
-- Fixture: one fresh vendor under one brand in Frederick, with a single
-- par-only item (par=100, stock=0, usage=0 → on_hand=0 → par_replacement=100).
-- Then an OPEN 'sent' PO keyed at as_of_date with a po_items line of
-- ordered_qty=40, received_qty=0. Under the OLD (pre-138) definition this
-- item's pending_po_qty would be 40 and its suggested_qty would net down to
-- max(0, 100-0-40)=60. Under spec 138 both are ignored: pending_po_qty=0,
-- suggested_qty=100.
--
-- Also asserts the envelope shape is byte-stable (the `pending_po_qty` key is
-- still present) and that the separate `has_po` EXISTS is intact (the 'sent'
-- PO at as_of_date lights has_po=true — unchanged by the inbound-term drop).
--
-- Fixtures in-transaction, rolled back. Master-JWT pattern mirrors
-- reorder_list_has_po.test.sql.

begin;
create extension if not exists pgtap;

select plan(6);

do $$
declare
  v_master_id uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick uuid;
  v_brand_id  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  perform set_config('test.master_id',    v_master_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text, true);
  perform set_config('test.brand_id',     v_brand_id::text,  true);
  -- The as-of date the reorder list is computed for; the PO is keyed off this.
  perform set_config('test.as_of', to_char(current_date, 'YYYY-MM-DD'), true);
end $$;

select isnt(current_setting('test.brand_id', true), '',
  'fixture: brand + Frederick resolve from seed');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'master')
  )::text,
  true
);

-- ─── One fresh vendor + one par-only item (par=100, stock=0). ─────
create temp table _vendor on commit drop as
with ins as (
  insert into public.vendors (brand_id, name)
  values (current_setting('test.brand_id', true)::uuid,
          'NOINBOUND-V-'||gen_random_uuid()::text)
  returning id
)
select id from ins;

do $$
begin
  perform set_config('test.vendor_id', (select id from _vendor)::text, true);
end $$;

create temp table _catalog on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty)
  values (current_setting('test.brand_id', true)::uuid,
          'NOINBOUND-ITEM-'||gen_random_uuid()::text, 'each', 1)
  returning id
)
select id from ins;

do $$
begin
  perform set_config('test.catalog_id', (select id from _catalog)::text, true);
end $$;

create temp table _item on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.catalog_id',   true)::uuid,
          current_setting('test.vendor_id',     true)::uuid,
          1, 0, 100, 0)
  returning id
)
select id from ins;

do $$
begin
  perform set_config('test.item_id', (select id from _item)::text, true);
end $$;

insert into public.item_vendors (item_id, vendor_id, cost_per_unit, is_primary)
values (current_setting('test.item_id',   true)::uuid,
        current_setting('test.vendor_id', true)::uuid,
        1, true)
on conflict (item_id, vendor_id) do nothing;

-- ─── An OPEN 'sent' PO at as_of_date + a po_items line (inbound 40). ──
-- Under the OLD definition this would net the suggestion down to 60.
create temp table _po on commit drop as
with ins as (
  insert into public.purchase_orders (store_id, vendor_id, status, reference_date)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor_id',     true)::uuid,
          'sent', current_setting('test.as_of', true)::date)
  returning id
)
select id from ins;

insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
values ((select id from _po),
        current_setting('test.item_id', true)::uuid,
        40, 0, 1);

-- ─── Run the report and snapshot the item + its vendor row. ──────
create temp table _rows on commit drop as
select v->>'vendor_id'    as vendor_id,
       (v->>'has_po')      as has_po,
       i                   as item
  from (select public.report_reorder_list(
          current_setting('test.frederick_id', true)::uuid,
          jsonb_build_object('as_of_date',      current_setting('test.as_of', true),
                             'include_stocked', true)
        ) as env) e,
       jsonb_array_elements(e.env->'vendors') v,
       jsonb_array_elements(v->'items')        i
 where v->>'vendor_id' = current_setting('test.vendor_id', true)
   and i->>'item_id'   = current_setting('test.item_id',   true);

-- (1) The inbound term is gone: pending_po_qty is 0 despite the open sent PO.
select is(
  (select (item->>'pending_po_qty')::numeric from _rows),
  0::numeric,
  'pending_po_qty = 0 for an item with an open sent PO (inbound term retired)'
);

-- (2) suggested_qty is NOT netted down by inbound: par(100) - on_hand(0) = 100,
--     not the old max(0, 100 - 0 - 40) = 60.
select is(
  (select (item->>'suggested_qty')::numeric from _rows),
  100::numeric,
  'suggested_qty = 100 (par - on_hand); no inbound subtraction (would be 60 pre-138)'
);

-- (3) par_replacement likewise ignores inbound.
select is(
  (select (item->>'par_replacement')::numeric from _rows),
  100::numeric,
  'par_replacement = 100 (par - on_hand - 0); inbound not subtracted'
);

-- (4) Envelope shape byte-stable: the pending_po_qty key is still PRESENT.
select ok(
  (select item ? 'pending_po_qty' from _rows),
  'envelope shape unchanged: item still carries the pending_po_qty key (value 0)'
);

-- (5) has_po (a SEPARATE EXISTS, unaffected by the inbound-term drop) still
--     lights for a non-cancelled PO keyed at as_of_date.
select is(
  (select distinct has_po from _rows),
  'true',
  'has_po intact: the sent PO at as_of_date still flips has_po = true'
);

select * from finish();
rollback;

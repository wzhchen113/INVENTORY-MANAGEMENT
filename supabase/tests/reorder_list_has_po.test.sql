-- supabase/tests/reorder_list_has_po.test.sql
--
-- Spec 123 — pins the additive `create or replace` of report_reorder_list in
-- supabase/migrations/20260718000000_reorder_list_has_po.sql:
--
--   Each surfaced vendor gains a per-vendor `has_po` boolean =
--     exists (select 1 from purchase_orders po
--              where po.store_id = <store>
--                and po.vendor_id = <this vendor>
--                and po.reference_date = v_as_of_date   -- the list's as-of date
--                and po.status <> 'cancelled')
--
-- Five fresh vendors under one brand in Frederick, each with a single below-par
-- item so the vendor surfaces on the reorder list, then POs seeded to exercise
-- the predicate:
--   A → non-cancelled 'draft' PO at as_of_date            → has_po = true
--   B → only a 'cancelled' PO at as_of_date               → has_po = false
--   C → a PO at a DIFFERENT reference_date (as_of - 5)     → has_po = false
--   D → no PO at all                                        → has_po = false
--   E → a legacy PO with reference_date = null             → has_po = false
--
-- Independence: A (true) and D (false) share the same as_of_date, proving the
-- flag is per-vendor and one vendor's PO does not light another's button.
--
-- Fixtures in-transaction, rolled back. Master-JWT pattern mirrors
-- report_reorder_list_include_stocked.test.sql.

begin;
create extension if not exists pgtap;

select plan(7);

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
  -- The as-of date the reorder list is computed for; POs are keyed off this.
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

-- ─── Five fresh vendors ──────────────────────────────────────────
create temp table _vendors on commit drop as
with ins as (
  insert into public.vendors (brand_id, name)
  values
    (current_setting('test.brand_id', true)::uuid, 'HASPO-A-'||gen_random_uuid()::text),
    (current_setting('test.brand_id', true)::uuid, 'HASPO-B-'||gen_random_uuid()::text),
    (current_setting('test.brand_id', true)::uuid, 'HASPO-C-'||gen_random_uuid()::text),
    (current_setting('test.brand_id', true)::uuid, 'HASPO-D-'||gen_random_uuid()::text),
    (current_setting('test.brand_id', true)::uuid, 'HASPO-E-'||gen_random_uuid()::text)
  returning id, name
)
select id, name, substring(name from 'HASPO-(.)-') as tag from ins;

do $$
begin
  perform set_config('test.vendor_a', (select id from _vendors where tag='A')::text, true);
  perform set_config('test.vendor_b', (select id from _vendors where tag='B')::text, true);
  perform set_config('test.vendor_c', (select id from _vendors where tag='C')::text, true);
  perform set_config('test.vendor_d', (select id from _vendors where tag='D')::text, true);
  perform set_config('test.vendor_e', (select id from _vendors where tag='E')::text, true);
end $$;

-- One below-par catalog item per vendor (par=10, stock=0 → surfaces).
create temp table _catalog on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty)
  select current_setting('test.brand_id', true)::uuid,
         'HASPO-ITEM-'||tag||'-'||gen_random_uuid()::text, 'each', 1
    from _vendors
  returning id, name
)
select id, name, substring(name from 'HASPO-ITEM-(.)-') as tag from ins;

create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  select current_setting('test.frederick_id', true)::uuid,
         c.id,
         v.id,
         1, 0, 10, 0
    from _catalog c
    join _vendors v on v.tag = c.tag
  returning id, catalog_id
)
select id, catalog_id from ins;

insert into public.item_vendors (item_id, vendor_id, cost_per_unit, is_primary)
select it.id, v.id, 1, true
  from _items it
  join _catalog c on c.id = it.catalog_id
  join _vendors v on v.tag = c.tag
on conflict (item_id, vendor_id) do nothing;

-- ─── Purchase orders exercising the predicate ────────────────────
-- A: non-cancelled draft at as_of_date.
insert into public.purchase_orders (store_id, vendor_id, status, reference_date)
values (current_setting('test.frederick_id', true)::uuid,
        current_setting('test.vendor_a', true)::uuid,
        'draft', current_setting('test.as_of', true)::date);

-- B: cancelled at as_of_date (must NOT count).
insert into public.purchase_orders (store_id, vendor_id, status, reference_date)
values (current_setting('test.frederick_id', true)::uuid,
        current_setting('test.vendor_b', true)::uuid,
        'cancelled', current_setting('test.as_of', true)::date);

-- C: non-cancelled but at a DIFFERENT reference_date (must NOT count).
insert into public.purchase_orders (store_id, vendor_id, status, reference_date)
values (current_setting('test.frederick_id', true)::uuid,
        current_setting('test.vendor_c', true)::uuid,
        'sent', (current_setting('test.as_of', true)::date - 5));

-- D: no PO at all.

-- E: legacy draft with null reference_date (must NOT count).
insert into public.purchase_orders (store_id, vendor_id, status, reference_date)
values (current_setting('test.frederick_id', true)::uuid,
        current_setting('test.vendor_e', true)::uuid,
        'draft', null);

-- ─── Run the report and snapshot per-vendor has_po ───────────────
create temp table _vendor_rows on commit drop as
select v->>'vendor_id' as vendor_id, (v->>'has_po') as has_po
  from (select public.report_reorder_list(
          current_setting('test.frederick_id', true)::uuid,
          jsonb_build_object('as_of_date',       current_setting('test.as_of', true),
                             'include_stocked',  true)
        ) as env) e,
       jsonb_array_elements(e.env->'vendors') v;

select is(
  (select has_po from _vendor_rows where vendor_id = current_setting('test.vendor_a', true)),
  'true',
  'A: non-cancelled PO at as_of_date → has_po = true'
);
select is(
  (select has_po from _vendor_rows where vendor_id = current_setting('test.vendor_b', true)),
  'false',
  'B: only a cancelled PO at as_of_date → has_po = false'
);
select is(
  (select has_po from _vendor_rows where vendor_id = current_setting('test.vendor_c', true)),
  'false',
  'C: PO at a different reference_date → has_po = false'
);
select is(
  (select has_po from _vendor_rows where vendor_id = current_setting('test.vendor_d', true)),
  'false',
  'D: no PO → has_po = false'
);
select is(
  (select has_po from _vendor_rows where vendor_id = current_setting('test.vendor_e', true)),
  'false',
  'E: legacy null-reference_date PO → has_po = false'
);

-- Independence: A and D share the as_of_date; A true does not spill to D.
select ok(
  (select has_po from _vendor_rows where vendor_id = current_setting('test.vendor_a', true)) = 'true'
  and (select has_po from _vendor_rows where vendor_id = current_setting('test.vendor_d', true)) = 'false',
  'independence: A (has PO) and D (no PO) on the same date are independent'
);

select * from finish();
rollback;

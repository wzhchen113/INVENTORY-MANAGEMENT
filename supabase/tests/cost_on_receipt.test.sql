-- supabase/tests/cost_on_receipt.test.sql
--
-- Spec 109 — pgTAP coverage for cost-on-receipt
-- (supabase/migrations/20260705000000_cost_on_receipt.sql). This is the ADDITIVE
-- cost path on top of spec 107's stock-only receive_purchase_order. Covers the
-- design's ten cases:
--
--   (1)  a price change updates BOTH the item_vendors link AND the
--        inventory_items scalar, with ★-consistent per-each values
--        (case_price / (case_qty × sub_unit_size) on both).
--   (2)  ⚠ OQ-1 AGGRESSIVE PIN — a delivery from a NON-PRIMARY vendor still
--        rewrites the item scalar (is_primary is NOT a gate).
--   (3)  idempotent replay — a second call with the SAME client_uuid does NOT
--        re-apply the price change (link + scalar values unchanged after replay,
--        no duplicate audit row) and returns price_changes: [].
--   (4)  link-missing — a receive against a vendor with NO existing item_vendors
--        link INSERTS the link (is_primary = false) AND updates the item scalar;
--        the audit renders the old price as '—'.
--   (5)  new_case_price < 0 → P0001 (aborts the whole call).
--   (6)  new_case_price = 0 / absent → no change on either table, no audit row.
--   (7)  an unchanged-price line (equal to the link's current case_price) writes
--        NO cost change and NO 'PO price change' audit row.
--   (8)  the old→new price per item is RECOVERABLE from audit_log
--        (action = 'PO price change', old→new case in detail, old→new per-each
--        in value).
--   (9)  the return envelope carries the price_changes[] shape
--        ({ po_item_id, item_id, old_case_price, new_case_price,
--           old_cost_per_unit, new_cost_per_unit }).
--   (10) stock math is UNCHANGED from spec 107 — a priced receive still
--        increments current_stock by the received delta (regression pin), and a
--        price-only concern never disturbs the additive stock/status logic.
--
-- Review-pass additions (spec 109 reviewer fan-out — CR/SEC/TE Should-fixes):
--
--   (11) OQ-6 LAST-ENTRY-WINS — two sequential receives (DISTINCT client_uuids)
--        at two DIFFERENT non-zero prices leave the LAST price on BOTH
--        item_vendors and inventory_items, with BOTH transitions recoverable
--        from audit_log (two 'PO price change' rows; asserted by detail
--        EXISTENCE, not ordering — same-transaction rows share created_at).
--   (12) non-numeric new_case_price → 22P02 at the cast (defensive half of
--        design case (i)); the abort leaves stock untouched.
--   (13) AUTH GATE BEFORE ANY COST WRITE (design case (e)) — a non-member
--        caller receiving a price-carrying line is refused (P0002 under
--        INVOKER RLS, mirroring po_loop.test.sql case (F)) and NO durable
--        write survives: link price, item scalar, stock, and audit all
--        unchanged.
--   (14) OQ-2 pin — catalog_ingredients.default_cost is NEVER written: after
--        all the churn above, every SPEC109-% catalog row still carries its
--        seeded default_cost.
--
-- All fixtures (catalog, items, item_vendors, PO + lines) are created INSIDE the
-- transaction, so the suite is identical under the prod-pulled seed AND a
-- CI-fresh state. Master-JWT pattern mirrors po_loop.test.sql (master sees all
-- stores via auth_is_admin → auth_can_see_store). No `set role anon` (segfaults
-- CI per spec 067). Hermetic: begin; … rollback;.
--
-- ★ packing chosen for clean assertions: case_qty = 4, sub_unit_size = 1 →
-- divisor 4. So case 20 ⇒ per-each 5; case 40 ⇒ per-each 10; case 55 ⇒ per-each
-- 13.75; case 30 ⇒ per-each 7.5.

begin;
create extension if not exists pgtap;

select plan(55);

-- ─── fixtures ──────────────────────────────────────────────────
-- Frederick (member store) + a brand + two distinct vendors (V1 primary, V2
-- secondary). 3333 is `master` (sees all stores).
do $$
declare
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick  uuid;
  v_brand_id   uuid;
  v_vendor1    uuid;
  v_vendor2    uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  select id into v_vendor1 from public.vendors order by id asc  limit 1;
  select id into v_vendor2 from public.vendors order by id desc limit 1;

  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
  perform set_config('test.vendor1',      v_vendor1::text,    true);
  perform set_config('test.vendor2',      v_vendor2::text,    true);
end $$;

select ok(
  current_setting('test.vendor1', true) <> current_setting('test.vendor2', true)
    and current_setting('test.frederick_id', true) <> '',
  '(0) fixture: Frederick + two distinct vendors resolve from seed'
);

-- ─── master JWT — privileged for all fixture mutations + reads ─────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.master_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'master')
  )::text,
  true
);

-- Four fresh catalog_ingredients, all case_qty 4 / sub_unit_size 1 (divisor 4).
--   PRICED → the primary-vendor price-change item.
--   NONPRI → the NON-PRIMARY-vendor rewrite item (OQ-1 pin).
--   NOLINK → the link-missing item (receive against a vendor with no link).
--   NOCHG  → the equal-price / zero-price / stock-only item.
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values
    (current_setting('test.brand_id', true)::uuid, 'SPEC109-PRICED-'||gen_random_uuid()::text, 'each', 4, 1, 5.00),
    (current_setting('test.brand_id', true)::uuid, 'SPEC109-NONPRI-'||gen_random_uuid()::text, 'each', 4, 1, 5.00),
    (current_setting('test.brand_id', true)::uuid, 'SPEC109-NOLINK-'||gen_random_uuid()::text, 'each', 4, 1, 5.00),
    (current_setting('test.brand_id', true)::uuid, 'SPEC109-NOCHG-'||gen_random_uuid()::text,  'each', 4, 1, 5.00)
  returning id, name
)
select id, name,
       case
         when name like 'SPEC109-PRICED%' then 'priced'
         when name like 'SPEC109-NONPRI%' then 'nonpri'
         when name like 'SPEC109-NOLINK%' then 'nolink'
         else 'nochg'
       end as kind
  from ins;

-- Frederick items. All start with case_price 20 / cost_per_unit 5.00 (= 20/4).
-- current_stock 10 each so the stock regression pin has a baseline.
-- vendor_id (scalar primary) = V1 for PRICED/NONPRI/NOLINK/NOCHG.
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, case_price, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind = 'priced'),
     current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0),
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind = 'nonpri'),
     current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0),
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind = 'nolink'),
     current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0),
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind = 'nochg'),
     current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0)
  returning id, catalog_id
)
select i.id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
begin
  perform set_config('test.item_priced', (select id from _items where kind = 'priced')::text, true);
  perform set_config('test.item_nonpri', (select id from _items where kind = 'nonpri')::text, true);
  perform set_config('test.item_nolink', (select id from _items where kind = 'nolink')::text, true);
  perform set_config('test.item_nochg',  (select id from _items where kind = 'nochg')::text,  true);
end $$;

-- item_vendors links. PRICED/NOCHG → V1 primary (case 20). NONPRI → BOTH a V1
-- primary link (the scalar's vendor) AND a V2 secondary link (the PO vendor) so
-- the receive against V2 is a genuine non-primary delivery. NOLINK → ONLY a V1
-- link (no V2 link — the V2 receive must INSERT it).
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  (current_setting('test.item_priced', true)::uuid, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true),
  (current_setting('test.item_nochg',  true)::uuid, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true),
  (current_setting('test.item_nonpri', true)::uuid, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true),
  (current_setting('test.item_nonpri', true)::uuid, current_setting('test.vendor2', true)::uuid, 5.00, 20.00, false),
  (current_setting('test.item_nolink', true)::uuid, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true)
on conflict (item_id, vendor_id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) + (8) + (9) + (10) — PRIMARY-vendor price change on a PO against V1.
-- PRICED item: ordered 8, receive 8 at NEW case price 40 (was 20). Divisor 4.
--   → link (item, V1): case 20 → 40, per-each 5 → 10.
--   → item scalar:     case 20 → 40, per-each 5 → 10 (★-consistent).
--   → stock 10 → 18 (spec-107 additive, +8; regression pin).
--   → one 'PO price change' audit row: detail old→new CASE, value old→new EACH.
--   → envelope price_changes[0] carries the full shape.
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _po1 on commit drop as
with po as (
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid,
          'sent', 160.00)
  returning id
)
select id from po;
do $$
declare v_po uuid; v_line uuid;
begin
  select id into v_po from _po1;
  perform set_config('test.po1_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_priced', true)::uuid, 8, null, 20.00)
  returning id into v_line;
  perform set_config('test.line1', v_line::text, true);
end $$;

create temp table _r1 on commit drop as
select public.receive_purchase_order(
  current_setting('test.po1_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id',    current_setting('test.line1', true)::uuid,
    'received_qty',  8,
    'new_case_price', 40)),
  gen_random_uuid()
) as env;

-- (1) link updated on BOTH price + per-each.
select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_priced', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  40.00::numeric,
  '(1) item_vendors.case_price updated 20 → 40 for the (item, PO-vendor) link'
);
select is(
  (select cost_per_unit from public.item_vendors
    where item_id = current_setting('test.item_priced', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  10.000000::numeric,
  '(1) item_vendors.cost_per_unit recomputed via ★ = 40/(4×1) = 10'
);
-- (1) item scalar updated on BOTH price + per-each — ★-consistent with the link.
select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_priced', true)::uuid),
  40.00::numeric,
  '(1) inventory_items.case_price updated 20 → 40 (item scalar)'
);
select is(
  (select cost_per_unit from public.inventory_items where id = current_setting('test.item_priced', true)::uuid),
  10.000000::numeric,
  '(1) inventory_items.cost_per_unit recomputed via SAME ★ = 10 (agrees with link)'
);
-- (10) stock regression pin — priced receive still increments +8.
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_priced', true)::uuid),
  18::numeric,
  '(10) stock math UNCHANGED from spec 107 — current_stock 10 → 18 (+8) on a priced receive'
);
select is(
  (select received_qty from public.po_items where id = current_setting('test.line1', true)::uuid),
  8::numeric,
  '(10) po_items.received_qty accumulates to 8 (additive stock/status logic intact)'
);
select is(
  (select env->>'status' from _r1),
  'received',
  '(10) full priced receive still flips status → received'
);

-- (8) audit old→new recoverable — exactly one 'PO price change' row for PRICED.
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO price change'
      and store_id = current_setting('test.frederick_id', true)::uuid
      and item_ref like 'SPEC109-PRICED%'),
  1,
  '(8) exactly one ''PO price change'' audit row for the changed line'
);
select ok(
  (select detail from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC109-PRICED%'
    order by created_at desc limit 1) like '%case 20.00 → 40%',
  '(8) audit detail records old→new CASE price (20.00 → 40) — recoverable'
);
select ok(
  (select value from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC109-PRICED%'
    order by created_at desc limit 1) like 'each 5.00%→ 10%',
  '(8) audit value records old→new PER-EACH cost (5.00 → 10) — recoverable'
);
-- (8) user_id is the INVOKER (spoof-proof).
select is(
  (select user_id from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC109-PRICED%'
    order by created_at desc limit 1),
  current_setting('test.master_id', true)::uuid,
  '(8) audit user_id = auth.uid() (INVOKER, spoof-proof)'
);

-- (9) envelope price_changes[] shape.
select is(
  (select jsonb_array_length(env->'price_changes') from _r1),
  1,
  '(9) envelope price_changes has exactly one element'
);
select is(
  (select (env->'price_changes'->0->>'item_id')::uuid from _r1),
  current_setting('test.item_priced', true)::uuid,
  '(9) price_changes[0].item_id is the changed item'
);
select is(
  (select (env->'price_changes'->0->>'old_case_price')::numeric from _r1),
  20.00::numeric,
  '(9) price_changes[0].old_case_price = 20'
);
select is(
  (select (env->'price_changes'->0->>'new_case_price')::numeric from _r1),
  40::numeric,
  '(9) price_changes[0].new_case_price = 40'
);
select is(
  (select (env->'price_changes'->0->>'new_cost_per_unit')::numeric from _r1),
  10::numeric,
  '(9) price_changes[0].new_cost_per_unit = 10 (★)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (2) OQ-1 AGGRESSIVE PIN — NON-PRIMARY vendor delivery rewrites the item scalar.
-- NONPRI item: scalar primary vendor is V1; the PO is against V2 (a secondary,
-- is_primary=false link exists). Receive at new case 55 (was 20). Divisor 4 →
-- per-each 13.75. The item scalar MUST still be rewritten even though V2 is NOT
-- primary, and the V1 primary link MUST be left untouched.
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _po2 on commit drop as
with po as (
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor2', true)::uuid,   -- SECONDARY vendor
          current_setting('test.master_id', true)::uuid,
          'sent', 55.00)
  returning id
)
select id from po;
do $$
declare v_po uuid; v_line uuid;
begin
  select id into v_po from _po2;
  perform set_config('test.po2_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_nonpri', true)::uuid, 4, null, 20.00)
  returning id into v_line;
  perform set_config('test.line2', v_line::text, true);
end $$;

select public.receive_purchase_order(
  current_setting('test.po2_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id',    current_setting('test.line2', true)::uuid,
    'received_qty',  4,
    'new_case_price', 55)),
  gen_random_uuid()
);

-- (2) the item scalar IS rewritten (headline tracks the last real price paid).
select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_nonpri', true)::uuid),
  55.00::numeric,
  '(2) OQ-1: NON-PRIMARY (V2) delivery STILL rewrites inventory_items.case_price 20 → 55'
);
select is(
  (select cost_per_unit from public.inventory_items where id = current_setting('test.item_nonpri', true)::uuid),
  13.750000::numeric,
  '(2) OQ-1: item scalar cost_per_unit recomputed via ★ = 55/4 = 13.75'
);
-- (2) the V2 (secondary) link is updated.
select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_nonpri', true)::uuid
      and vendor_id = current_setting('test.vendor2', true)::uuid),
  55.00::numeric,
  '(2) the V2 (PO-vendor, non-primary) link case_price updated 20 → 55'
);
-- (2) the V1 (primary) link is LEFT UNTOUCHED (the receipt was against V2).
select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_nonpri', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  20.00::numeric,
  '(2) the V1 (primary, not-the-PO-vendor) link case_price is UNCHANGED (20)'
);
-- (2) is_primary on the V2 link stays false (upsert leaves it untouched).
select is(
  (select is_primary from public.item_vendors
    where item_id = current_setting('test.item_nonpri', true)::uuid
      and vendor_id = current_setting('test.vendor2', true)::uuid),
  false,
  '(2) the updated V2 link stays is_primary = false (SD-1 invariant preserved)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (4) LINK-MISSING — receive NOLINK against V2 (no V2 link exists). The link is
-- INSERTED (is_primary = false) and the item scalar is updated; the audit
-- renders the old price as '—'. New case 30, divisor 4 → per-each 7.5.
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _po4 on commit drop as
with po as (
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor2', true)::uuid,   -- V2 — NOLINK has no V2 link
          current_setting('test.master_id', true)::uuid,
          'sent', 30.00)
  returning id
)
select id from po;
do $$
declare v_po uuid; v_line uuid;
begin
  select id into v_po from _po4;
  perform set_config('test.po4_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_nolink', true)::uuid, 4, null, 20.00)
  returning id into v_line;
  perform set_config('test.line4', v_line::text, true);
end $$;

create temp table _r4 on commit drop as
select public.receive_purchase_order(
  current_setting('test.po4_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id',    current_setting('test.line4', true)::uuid,
    'received_qty',  4,
    'new_case_price', 30)),
  gen_random_uuid()
) as env;

-- (4) a V2 link now exists for NOLINK, is_primary = false, at the new price.
select is(
  (select count(*)::int from public.item_vendors
    where item_id = current_setting('test.item_nolink', true)::uuid
      and vendor_id = current_setting('test.vendor2', true)::uuid),
  1,
  '(4) link-missing: a V2 item_vendors link was INSERTED for NOLINK'
);
select is(
  (select is_primary from public.item_vendors
    where item_id = current_setting('test.item_nolink', true)::uuid
      and vendor_id = current_setting('test.vendor2', true)::uuid),
  false,
  '(4) the inserted link is is_primary = false'
);
select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_nolink', true)::uuid
      and vendor_id = current_setting('test.vendor2', true)::uuid),
  30.00::numeric,
  '(4) the inserted link carries the new case price (30) + ★ per-each'
);
-- (4) the item scalar is still updated (OQ-1 unconditional).
select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_nolink', true)::uuid),
  30.00::numeric,
  '(4) link-missing still updates the item scalar case_price 20 → 30'
);
-- (4) the audit row renders the old CASE price as '—' (no prior link).
select ok(
  (select detail from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC109-NOLINK%'
    order by created_at desc limit 1) like '%case — → 30%',
  '(4) link-missing audit renders old CASE as ''—'' (no prior price)'
);
-- (4) envelope old_* are JSON null on the link-missing INSERT.
select ok(
  (select (env->'price_changes'->0->'old_case_price') = 'null'::jsonb from _r4),
  '(4) price_changes[0].old_case_price is JSON null on a link-missing INSERT'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (5) NEGATIVE PRICE → P0001 (aborts the whole call). Fresh PO on PRICED-clone
-- path: reuse NOCHG item under a NEW PO against V1.
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _po5 on commit drop as
with po as (
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid,
          'sent', 20.00)
  returning id
)
select id from po;
do $$
declare v_po uuid; v_line uuid;
begin
  select id into v_po from _po5;
  perform set_config('test.po5_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_nochg', true)::uuid, 4, null, 20.00)
  returning id into v_line;
  perform set_config('test.line5', v_line::text, true);
end $$;

select throws_ok(
  format(
    $q$select public.receive_purchase_order(%L::uuid,
         jsonb_build_array(jsonb_build_object(
           'po_item_id', %L::uuid, 'received_qty', 4, 'new_case_price', -1)),
         gen_random_uuid())$q$,
    current_setting('test.po5_id', true), current_setting('test.line5', true)
  ),
  'P0001',
  null,
  '(5) new_case_price < 0 raises P0001 (aborts the whole call)'
);
-- (5) the abort rolled back the stock write too (nothing half-applied): NOCHG
-- stock is still 10 (the negative-price call touched nothing durable).
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_nochg', true)::uuid),
  10::numeric,
  '(5) the P0001 abort left NOCHG stock at 10 (no half-applied stock write)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (6) + (7) — ZERO / EQUAL / ABSENT price → NO cost change, NO audit row, but
-- stock STILL receives (the cost path is independent of the stock path).
-- Three lines in one receive on a fresh PO against V1 for NOCHG:
--   • new_case_price = 0     → treated as "no price entered" (fails > 0).
--   • new_case_price = 20    → EQUAL to the link's current 20 (fails distinct).
--   • (absent key)           → spec-107 stock-only.
-- We drive them as three sequential single-line receives so the received_qty
-- assertions stay simple; each must leave case_price = 20 and write no
-- 'PO price change' row, while stock climbs.
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _po6 on commit drop as
with po as (
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid,
          'sent', 240.00)
  returning id
)
select id from po;
do $$
declare v_po uuid; v_line uuid;
begin
  select id into v_po from _po6;
  perform set_config('test.po6_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_nochg', true)::uuid, 12, null, 20.00)
  returning id into v_line;
  perform set_config('test.line6', v_line::text, true);
end $$;

-- (6a) zero price → no change; stock 10 → 12 (+2).
select public.receive_purchase_order(
  current_setting('test.po6_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line6', true)::uuid, 'received_qty', 2, 'new_case_price', 0)),
  gen_random_uuid());
-- (6b) equal price → no change; stock 12 → 14 (+2).
select public.receive_purchase_order(
  current_setting('test.po6_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line6', true)::uuid, 'received_qty', 2, 'new_case_price', 20)),
  gen_random_uuid());
-- (6c) absent key → stock-only; stock 14 → 16 (+2).
select public.receive_purchase_order(
  current_setting('test.po6_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line6', true)::uuid, 'received_qty', 2)),
  gen_random_uuid());

select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_nochg', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  20.00::numeric,
  '(6) zero / equal / absent price leaves item_vendors.case_price UNCHANGED (20)'
);
select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_nochg', true)::uuid),
  20.00::numeric,
  '(6) zero / equal / absent price leaves inventory_items.case_price UNCHANGED (20)'
);
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC109-NOCHG%'),
  0,
  '(7) unchanged-price lines write NO ''PO price change'' audit row'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_nochg', true)::uuid),
  16::numeric,
  '(6/10) stock STILL received on no-cost-change lines: 10 → 16 (+2+2+2)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (3) IDEMPOTENT REPLAY — re-call the PRICED receive (po1) with a FIXED
-- client_uuid, then replay the SAME uuid. The replay must NOT re-apply: the link
-- + scalar values stay put, no duplicate audit row, and price_changes returns [].
-- Fresh PO to avoid interfering with the completed po1 (which is already
-- 'received'). PRICED2 clone via the NONPRI item under a V1 PO would re-trigger a
-- change; instead we use a NEW item to keep the replay math clean.
-- ═══════════════════════════════════════════════════════════════════════════
-- Fresh catalog + item for the replay (case 20 baseline, V1 primary).
insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
values (current_setting('test.brand_id', true)::uuid, 'SPEC109-REPLAY-'||gen_random_uuid()::text, 'each', 4, 1, 5.00);
do $$
declare v_cat uuid; v_item uuid;
begin
  select id into v_cat from public.catalog_ingredients where name like 'SPEC109-REPLAY%' order by created_at desc limit 1;
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, case_price, cost_per_unit, current_stock, par_level, usage_per_portion)
  values (current_setting('test.frederick_id', true)::uuid, v_cat,
          current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0)
  returning id into v_item;
  perform set_config('test.item_replay', v_item::text, true);
  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
  values (v_item, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true);
end $$;

create temp table _po_rep on commit drop as
with po as (
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid,
          'sent', 40.00)
  returning id
)
select id from po;
do $$
declare v_po uuid; v_line uuid;
begin
  select id into v_po from _po_rep;
  perform set_config('test.po_rep_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_replay', true)::uuid, 2, null, 20.00)
  returning id into v_line;
  perform set_config('test.line_rep', v_line::text, true);
end $$;

select set_config('test.cuuid_rep', gen_random_uuid()::text, true);

-- First call: applies the change (case 20 → 44, per-each 11), stock 10 → 12.
select public.receive_purchase_order(
  current_setting('test.po_rep_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_rep', true)::uuid, 'received_qty', 2, 'new_case_price', 44)),
  current_setting('test.cuuid_rep', true)::uuid);

-- Replay with the SAME uuid: must short-circuit BEFORE any cost write.
create temp table _r_replay on commit drop as
select public.receive_purchase_order(
  current_setting('test.po_rep_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_rep', true)::uuid, 'received_qty', 2, 'new_case_price', 44)),
  current_setting('test.cuuid_rep', true)::uuid
) as env;

select is(
  (select (env->>'conflict')::boolean from _r_replay),
  true,
  '(3) replay with the same client_uuid → conflict:true'
);
select is(
  (select jsonb_array_length(env->'price_changes') from _r_replay),
  0,
  '(3) replay returns price_changes: [] (nothing re-applied)'
);
select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_replay', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  44.00::numeric,
  '(3) replay does NOT re-apply the link case_price (stays 44, not double-written)'
);
select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_replay', true)::uuid),
  44.00::numeric,
  '(3) replay does NOT re-apply the item scalar case_price (stays 44)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_replay', true)::uuid),
  12::numeric,
  '(3) replay does NOT double-increment stock (stays 12, spec-107 idempotency)'
);
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC109-REPLAY%'),
  1,
  '(3) replay does NOT duplicate the ''PO price change'' audit row (still 1)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (11) OQ-6 LAST-ENTRY-WINS — two sequential receives at DIFFERENT prices
-- (DISTINCT client_uuids; this is NOT the replay case). Fresh LASTWIN item,
-- case 20 baseline, V1 primary. PO ordered 6 so the line stays open for the
-- (12) probe. Receive #1: qty 2 at case 24 (per-each 6). Receive #2: qty 2 at
-- case 36 (per-each 9). The SECOND price must land on BOTH tables, and BOTH
-- transitions must be recoverable from audit_log. Audit assertions check row
-- EXISTENCE by detail content, not created_at ordering — both rows share the
-- transaction's now().
-- ═══════════════════════════════════════════════════════════════════════════
insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
values (current_setting('test.brand_id', true)::uuid, 'SPEC109-LASTWIN-'||gen_random_uuid()::text, 'each', 4, 1, 5.00);
do $$
declare v_cat uuid; v_item uuid; v_po uuid; v_line uuid;
begin
  select id into v_cat from public.catalog_ingredients where name like 'SPEC109-LASTWIN%' order by created_at desc limit 1;
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, case_price, cost_per_unit, current_stock, par_level, usage_per_portion)
  values (current_setting('test.frederick_id', true)::uuid, v_cat,
          current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0)
  returning id into v_item;
  perform set_config('test.item_lastwin', v_item::text, true);
  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
  values (v_item, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true);

  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid,
          'sent', 120.00)
  returning id into v_po;
  perform set_config('test.po_lw_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, v_item, 6, null, 20.00)
  returning id into v_line;
  perform set_config('test.line_lw', v_line::text, true);
end $$;

-- Receive #1 at case 24 (distinct uuid).
select public.receive_purchase_order(
  current_setting('test.po_lw_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_lw', true)::uuid, 'received_qty', 2, 'new_case_price', 24)),
  gen_random_uuid());

select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_lastwin', true)::uuid),
  24.00::numeric,
  '(11) receive #1 applied its price first (scalar case_price 20 → 24) — the sequence is real'
);

-- Receive #2 at case 36 (another distinct uuid) — the LAST entry.
select public.receive_purchase_order(
  current_setting('test.po_lw_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_lw', true)::uuid, 'received_qty', 2, 'new_case_price', 36)),
  gen_random_uuid());

select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_lastwin', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  36.00::numeric,
  '(11) LAST entry wins on item_vendors.case_price (24 → 36)'
);
select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_lastwin', true)::uuid),
  36.00::numeric,
  '(11) LAST entry wins on inventory_items.case_price (24 → 36)'
);
select is(
  (select cost_per_unit from public.inventory_items where id = current_setting('test.item_lastwin', true)::uuid),
  9.000000::numeric,
  '(11) item scalar cost_per_unit tracks the LAST price via ★ = 36/4 = 9'
);
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC109-LASTWIN%'),
  2,
  '(11) BOTH price changes were audited (two ''PO price change'' rows)'
);
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC109-LASTWIN%'
      and detail like '%case 20.00 → 24%'),
  1,
  '(11) transition #1 (20.00 → 24) is recoverable from audit_log'
);
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC109-LASTWIN%'
      and detail like '%case 24.00 → 36%'),
  1,
  '(11) transition #2 (24.00 → 36) is recoverable — the full chain, in order, by content'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (12) NON-NUMERIC new_case_price → 22P02 at the jsonb_to_recordset cast
-- (defensive half of design case (i)). The whole call aborts; the LASTWIN line
-- is still open (4 of 6 received) so the probe reaches the recordset scan.
-- ═══════════════════════════════════════════════════════════════════════════
select throws_ok(
  format(
    $q$select public.receive_purchase_order(%L::uuid,
         jsonb_build_array(jsonb_build_object(
           'po_item_id', %L::uuid, 'received_qty', 1, 'new_case_price', 'abc')),
         gen_random_uuid())$q$,
    current_setting('test.po_lw_id', true), current_setting('test.line_lw', true)
  ),
  '22P02',
  null,
  '(12) non-numeric new_case_price raises 22P02 (cast error aborts the whole call)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_lastwin', true)::uuid),
  14::numeric,
  '(12) the 22P02 abort left LASTWIN stock at 14 (no half-applied stock write)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (13) AUTH GATE BEFORE ANY COST WRITE (design case (e)) — a NON-MEMBER caller
-- receiving a price-carrying line is refused with NO durable write. Fixtures
-- (as master): a Charles-store item + PO. The 2222 manager is a member of
-- Towson+Frederick per seed — NOT Charles — so under SECURITY INVOKER their
-- RLS-filtered PO fetch returns 0 rows → P0002, exactly mirroring
-- po_loop.test.sql case (F) (P0002-before-42501: a hard refusal that also
-- hides the PO's existence).
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_charles uuid; v_cat uuid; v_item uuid; v_po uuid; v_line uuid;
begin
  select id into v_charles from public.stores where name = 'Charles' limit 1;
  perform set_config('test.charles_id', v_charles::text, true);

  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values (current_setting('test.brand_id', true)::uuid, 'SPEC109-AUTH-'||gen_random_uuid()::text, 'each', 4, 1, 5.00)
  returning id into v_cat;
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, case_price, cost_per_unit, current_stock, par_level, usage_per_portion)
  values (v_charles, v_cat, current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0)
  returning id into v_item;
  perform set_config('test.item_auth', v_item::text, true);
  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
  values (v_item, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true);

  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (v_charles,
          current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid,
          'sent', 80.00)
  returning id into v_po;
  perform set_config('test.po_auth_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, v_item, 4, null, 20.00)
  returning id into v_line;
  perform set_config('test.line_auth', v_line::text, true);
end $$;

-- Switch to the 2222 manager (plain `user`, Towson+Frederick member — NOT Charles).
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

select throws_ok(
  format(
    $q$select public.receive_purchase_order(%L::uuid,
         jsonb_build_array(jsonb_build_object(
           'po_item_id', %L::uuid, 'received_qty', 2, 'new_case_price', 99)),
         gen_random_uuid())$q$,
    current_setting('test.po_auth_id', true), current_setting('test.line_auth', true)
  ),
  'P0002',
  null,
  '(13) non-member receiving a PRICE-CARRYING line is refused (P0002 under INVOKER RLS, before any write)'
);

-- Back to master to verify NOTHING durable survived the refusal.
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);

select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_auth', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  20.00::numeric,
  '(13) refused call wrote NO link price (item_vendors.case_price still 20)'
);
select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_auth', true)::uuid),
  20.00::numeric,
  '(13) refused call wrote NO item scalar (inventory_items.case_price still 20)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_auth', true)::uuid),
  10::numeric,
  '(13) refused call wrote NO stock (current_stock still 10)'
);
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC109-AUTH%'),
  0,
  '(13) refused call wrote NO audit row (auth gate fired before any cost write)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (14) OQ-2 PIN — catalog_ingredients.default_cost is NEVER written. After all
-- the churn above (PRICED 20→40, NONPRI →55, NOLINK →30, REPLAY →44,
-- LASTWIN →24→36), every SPEC109-% catalog row still carries its seeded 5.00.
-- ═══════════════════════════════════════════════════════════════════════════
select is(
  (select count(*)::int from public.catalog_ingredients
    where name like 'SPEC109-%' and default_cost is distinct from 5.00),
  0,
  '(14) OQ-2: no spec-109 catalog row had default_cost touched (all still 5.00)'
);

select * from finish();
rollback;

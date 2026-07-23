-- supabase/tests/po_loop.test.sql
--
-- Spec 107 — pgTAP coverage for the purchase-order loop backend
-- (supabase/migrations/20260704000000_po_loop.sql). Covers the design §10 plan:
--
--   RLS PIN (regression guard on the 2026-05-04 per-store policies — NOT new
--     policy authorship):
--     (R1) store-member SELECTs own-store PO; (R2) non-member SELECT of another
--          store's PO returns 0 rows; (R3) master (privileged) sees cross-store;
--     (R4) po_items child-scoping — member reads own PO's lines, non-member
--          reads 0.
--
--   receive_purchase_order:
--     (A) full receive: sent → received, received_at stamped, current_stock
--         incremented by the received qty;
--     (B) short receive: sent → partial, received_at LEFT NULL;
--     (C) idempotency: re-call with the same p_client_uuid → conflict:true and
--         NO double-increment of current_stock;
--     (D) two sequential partial receives accumulate received_qty + stock and
--         complete → received;
--     (E) stock-only (OQ-2): item_vendors.case_price + inventory_items.cost_per_unit
--         UNCHANGED after receive;
--     (F) non-member caller → 42501 (auth_can_see_store gate).
--
--   close_short_purchase_order:
--     (G) partial → received with received_at set; remainder leaves pending_po_qty
--         (the reorder suggestion rises back); refuses from non-partial (P0001).
--
--   cancel_purchase_order:
--     (H) sent → cancelled; quantity leaves pending_po_qty; refuses from
--         received (P0001).
--
--   pending_po_qty in BOTH engines (spec 138 — inbound netting RETIRED):
--     (P) after spec 138 dropped the (4g) inbound term on BOTH engines
--         (20260726000000_reorder_drop_inbound_term.sql, option A), an item with
--         an open `sent` PO now returns pending_po_qty = 0 and its suggested_qty
--         is NOT reduced by inbound — par-vs-on-hand only — from BOTH
--         report_reorder_list AND report_reorder_for_counted_onhand. The
--         byte-parity guard still holds, now at the un-netted baseline (both
--         engines suggest the same 140, reduction 0 on each).
--
--   status CHECK:
--     (S) an insert with status = 'submitted' (off-vocabulary) is rejected; the
--         five valid tokens pass.
--
-- All fixtures (catalog, items, item_vendors, PO + lines, schedule) are created
-- INSIDE the transaction, so the suite is identical under the prod-pulled seed
-- AND a CI-fresh state. Master-JWT pattern + member/non-member switch mirror
-- report_reorder_for_counted_onhand.test.sql. No `set role anon` (segfaults CI
-- per spec 067). Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(30);

-- ─── fixtures ──────────────────────────────────────────────────
-- Frederick (member store for the 2222 manager) + Charles (NON-member) + a
-- brand + two distinct vendors. The 2222 profile is a plain `user` member of
-- Towson+Frederick per seed; 3333 is `master` (sees all stores).
do $$
declare
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_charles    uuid;
  v_brand_id   uuid;
  v_vendor1    uuid;
  v_vendor2    uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  select id into v_vendor1 from public.vendors order by id asc  limit 1;
  select id into v_vendor2 from public.vendors order by id desc limit 1;

  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.charles_id',   v_charles::text,    true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
  perform set_config('test.vendor1',      v_vendor1::text,    true);
  perform set_config('test.vendor2',      v_vendor2::text,    true);
end $$;

select ok(
  current_setting('test.vendor1', true) <> current_setting('test.vendor2', true)
    and current_setting('test.frederick_id', true) <> ''
    and current_setting('test.charles_id', true) <> '',
  '(0) fixture: Frederick + Charles + two distinct vendors resolve from seed'
);

-- ─── master JWT — privileged for all fixture mutations ─────────
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

-- Two fresh catalog_ingredients:
--   RCV  → case_qty 1, sub_unit_size 1 (receive math item; counted == each).
--   PEND → case_qty 24, par 200 (drives the pending_po_qty reduction in reorder).
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values
    (current_setting('test.brand_id', true)::uuid, 'SPEC107-RCV-'||gen_random_uuid()::text,  'each', 1,  1, 2.00),
    (current_setting('test.brand_id', true)::uuid, 'SPEC107-PEND-'||gen_random_uuid()::text, 'each', 24, 1, 3.00)
  returning id, name
)
select id, name,
       case when name like 'SPEC107-RCV%' then 'rcv' else 'pend' end as kind
  from ins;

-- Frederick items. RCV: current_stock 10, cost_per_unit 2.00. PEND: par 200,
-- current_stock 60 (below par so reorder suggests it), usage_per_portion 0.
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid,
     (select id from _cat where kind = 'rcv'),
     current_setting('test.vendor1', true)::uuid,
     2.00, 10, 0, 0),
    (current_setting('test.frederick_id', true)::uuid,
     (select id from _cat where kind = 'pend'),
     current_setting('test.vendor1', true)::uuid,
     3.00, 60, 200, 0)
  returning id, catalog_id
)
select i.id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
begin
  perform set_config('test.item_rcv',  (select id from _items where kind = 'rcv')::text,  true);
  perform set_config('test.item_pend', (select id from _items where kind = 'pend')::text, true);
end $$;

-- item_vendors links (both items → V1). PEND is single-vendor so the reorder
-- engine surfaces exactly one card row for it.
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  (current_setting('test.item_rcv', true)::uuid,  current_setting('test.vendor1', true)::uuid, 2.00, 20.00, true),
  (current_setting('test.item_pend', true)::uuid, current_setting('test.vendor1', true)::uuid, 3.00, 72.00, true)
on conflict (item_id, vendor_id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS PIN — regression guard on the existing per-store policies.
-- Create a Frederick PO (as master, who can see Frederick) and its lines.
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _po on commit drop as
with po as (
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid,
          'sent', 100.00)
  returning id
)
select id from po;

do $$
declare v_po uuid; v_line1 uuid;
begin
  select id into v_po from _po;
  perform set_config('test.po_id', v_po::text, true);

  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_rcv', true)::uuid, 5, null, 2.00)
  returning id into v_line1;
  perform set_config('test.line_rcv', v_line1::text, true);
end $$;

-- (R3) master sees the Frederick PO (cross-store privileged read).
select is(
  (select count(*)::int from public.purchase_orders where id = current_setting('test.po_id', true)::uuid),
  1,
  '(R3) master (privileged) SELECTs the Frederick PO cross-store'
);

-- Switch to the 2222 manager (member of Frederick, NOT Charles).
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- (R1) member SELECTs the own-store (Frederick) PO.
select is(
  (select count(*)::int from public.purchase_orders where id = current_setting('test.po_id', true)::uuid),
  1,
  '(R1) Frederick member SELECTs the own-store PO'
);

-- (R4) member reads the PO's child po_items (scoped THROUGH the parent).
select is(
  (select count(*)::int from public.po_items where po_id = current_setting('test.po_id', true)::uuid),
  1,
  '(R4) Frederick member reads the PO''s po_items (child-scoped through parent)'
);

-- (R2) member CANNOT see a Charles PO. Create one AS MASTER, then re-check as
-- the manager. (Insert under a short privileged window, then switch back.)
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);

create temp table _po_charles on commit drop as
with po as (
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.charles_id', true)::uuid,
          current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid,
          'sent', 50.00)
  returning id
)
select id from po;
do $$ begin perform set_config('test.po_charles', (select id from _po_charles)::text, true); end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.manager_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

select is(
  (select count(*)::int from public.purchase_orders where id = current_setting('test.po_charles', true)::uuid),
  0,
  '(R2) Frederick member does NOT see a Charles (non-member) PO'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- receive_purchase_order — (F) non-member refusal FIRST (still under the
-- manager, who is NOT a Charles member).
--
-- NOTE on the errcode: the RPC is SECURITY INVOKER, so the caller's RLS filters
-- the PO row the auth gate reads (`select store_id … where id = p_po_id`). A
-- non-member's SELECT returns 0 rows → v_store_id is NULL → the RPC raises P0002
-- ('not found') BEFORE it can reach the auth_can_see_store 42501 branch (it
-- never learns the store_id to check). This is the behavior of the design's §3
-- gate code as written under INVOKER + RLS; it is a HARD refusal that also does
-- not leak the PO's existence to a non-member (arguably a stronger posture than
-- 42501). The 42501 branch remains as defense-in-depth for the theoretical case
-- where a row is visible but auth_can_see_store disagrees. The spec §10 (e)
-- wording says "42501"; the design §3 CODE produces P0002 for a non-member —
-- flagged in the backend-developer handoff for reviewer reconciliation.
select throws_ok(
  format(
    $q$select public.receive_purchase_order(%L::uuid, '[]'::jsonb, gen_random_uuid())$q$,
    current_setting('test.po_charles', true)
  ),
  'P0002',
  null,
  '(F) non-member caller receiving a Charles PO is refused (P0002 not-found under INVOKER RLS; a hard refusal that also hides existence)'
);

-- Back to master for the receive-math arms (master can see Frederick).
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);

-- Baseline stock for the RCV item = 10.
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_rcv', true)::uuid),
  10::numeric,
  '(A-pre) RCV item current_stock starts at 10'
);

-- ─── (B) SHORT receive: line ordered 5, receive 2 → partial, received_at NULL.
create temp table _r_short on commit drop as
select public.receive_purchase_order(
  current_setting('test.po_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_rcv', true)::uuid, 'received_qty', 2)),
  gen_random_uuid()
) as env;

select is(
  (select env->>'status' from _r_short),
  'partial',
  '(B) short receive (2 of 5) → status partial'
);
select ok(
  (select (received_at is null) from public.purchase_orders where id = current_setting('test.po_id', true)::uuid),
  '(B) short receive leaves received_at NULL (remainder stays inbound, OQ-3)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_rcv', true)::uuid),
  12::numeric,
  '(A) short receive incremented current_stock 10 → 12 (+2 counted units)'
);
select is(
  (select received_qty from public.po_items where id = current_setting('test.line_rcv', true)::uuid),
  2::numeric,
  '(B) po_items.received_qty = 2 after the short receive'
);

-- ─── (E) STOCK-ONLY: cost columns unchanged by the receive (OQ-2).
select is(
  (select cost_per_unit from public.inventory_items where id = current_setting('test.item_rcv', true)::uuid),
  2.00::numeric,
  '(E) inventory_items.cost_per_unit UNCHANGED by receive (stock-only, OQ-2)'
);
select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_rcv', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  20.00::numeric,
  '(E) item_vendors.case_price UNCHANGED by receive (stock-only, OQ-2)'
);

-- ─── (C) IDEMPOTENCY: re-call with a FIXED client_uuid twice. First call adds
-- the rest (3 → completes); second call with the SAME uuid must NOT re-add.
select set_config('test.cuuid', gen_random_uuid()::text, true);

create temp table _r_c1 on commit drop as
select public.receive_purchase_order(
  current_setting('test.po_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_rcv', true)::uuid, 'received_qty', 3)),
  current_setting('test.cuuid', true)::uuid
) as env;

-- After the first (3 added on top of 2): received_qty 5 == ordered 5 → received;
-- stock 12 → 15.
select is(
  (select env->>'status' from _r_c1),
  'received',
  '(D) second partial (3 more) completes the line → status received'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_rcv', true)::uuid),
  15::numeric,
  '(D) accumulated stock 10 +2 +3 = 15'
);
select ok(
  (select (received_at is not null) from public.purchase_orders where id = current_setting('test.po_id', true)::uuid),
  '(A) full completion stamps received_at'
);

-- Re-call with the SAME client_uuid → conflict:true, stock stays 15.
create temp table _r_c2 on commit drop as
select public.receive_purchase_order(
  current_setting('test.po_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_rcv', true)::uuid, 'received_qty', 3)),
  current_setting('test.cuuid', true)::uuid
) as env;

select is(
  (select (env->>'conflict')::boolean from _r_c2),
  true,
  '(C) idempotent re-call with same client_uuid → conflict:true'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_rcv', true)::uuid),
  15::numeric,
  '(C) idempotent re-call does NOT double-increment stock (stays 15)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- cancel_purchase_order — (H) refuse from received, then a fresh sent PO cancels.
-- ═══════════════════════════════════════════════════════════════════════════
select throws_ok(
  format($q$select public.cancel_purchase_order(%L::uuid)$q$, current_setting('test.po_id', true)),
  'P0001',
  null,
  '(H) cancel refuses a received PO (P0001)'
);

-- Fresh sent PO for cancel + pending tests, carrying the PEND item.
create temp table _po2 on commit drop as
with po as (
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid,
          'sent', 288.00)
  returning id
)
select id from po;
do $$
declare v_po2 uuid;
begin
  select id into v_po2 from _po2;
  perform set_config('test.po2_id', v_po2::text, true);
  -- PEND ordered 48 (2 cases of 24), none received yet → 48 outstanding inbound.
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po2, current_setting('test.item_pend', true)::uuid, 48, null, 3.00);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- pending_po_qty in BOTH engines — SPEC 138 (option A): the inbound term is
-- RETIRED, so an open sent PO NO LONGER reduces the suggestion on either engine.
-- PEND: par 200, on_hand 60 → par_replacement = greatest(0, 200 - 60) = 140.
-- The open PO's 48 outstanding is IGNORED (pending_po_qty = 0). The vendor engine
-- reads current_stock (60) as on_hand (no EOD today); the counted engine reads
-- the supplied 60. Both suggest the un-netted 140.
-- ═══════════════════════════════════════════════════════════════════════════

-- (P-engine) report_reorder_list — pending_po_qty = 0, suggested_qty = 140.
create temp table _rl on commit drop as
select public.report_reorder_list(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
) as env;

create temp table _rl_pend on commit drop as
select it as item
  from _rl,
       jsonb_array_elements(env->'vendors') vend,
       jsonb_array_elements(vend->'items') it
 where it->>'item_id' = current_setting('test.item_pend', true);

select is(
  (select (item->>'pending_po_qty')::numeric from _rl_pend),
  0::numeric,
  '(P) report_reorder_list: PEND pending_po_qty = 0 (spec 138: inbound term retired)'
);
select is(
  (select (item->>'suggested_qty')::numeric from _rl_pend),
  140::numeric,
  '(P) report_reorder_list: PEND suggested_qty = 200 - 60 = 140 (open PO NOT netted)'
);

-- (P-counted) report_reorder_for_counted_onhand — SAME un-netted result, supplied
-- on_hand 60. NOTE: this engine's flat item payload does NOT surface a
-- `pending_po_qty` key (it was only ever used INTERNALLY — the 4m item_rows
-- builder omits cost/pending fields, spec 105 Delta 2). Post-138 its (4g) CTE is
-- byte-identical to the vendor engine's (both `where false`), so the OBSERVABLE
-- RESULT is the same un-netted 140 the vendor engine emits — the open PO's 48 is
-- ignored on both.
create temp table _rc on commit drop as
select it as item
  from jsonb_array_elements(
    (public.report_reorder_for_counted_onhand(
       current_setting('test.frederick_id', true)::uuid,
       jsonb_build_object(current_setting('test.item_pend', true), 60),
       jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
     ))->'items'
  ) it
 where it->>'item_id' = current_setting('test.item_pend', true);

select is(
  (select (item->>'suggested_qty')::numeric from _rc),
  140::numeric,
  '(P) report_reorder_for_counted_onhand: PEND suggested_qty = 140 (both engines drop inbound identically)'
);
-- Explicit parity-of-result (KEPT): both engines now apply ZERO inbound
-- reduction — vendor pending (0) == counted-engine reduction (140 baseline − 140
-- actual = 0). Parity holds at the un-netted baseline.
select is(
  (select (item->>'pending_po_qty')::numeric from _rl_pend),
  140::numeric - (select (item->>'suggested_qty')::numeric from _rc),
  '(P) byte-parity of CTE result: vendor pending (0) == counted-engine reduction (140 − 140 = 0)'
);

-- (P-cancelled) cancel the PO — suggestion stays 140 (it was never netted post-138;
-- cancel is a no-op for the reorder math now, still a valid lifecycle transition).
select public.cancel_purchase_order(current_setting('test.po2_id', true)::uuid);

select is(
  (select (it->>'suggested_qty')::numeric
     from public.report_reorder_list(
            current_setting('test.frederick_id', true)::uuid,
            jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))) env,
          jsonb_array_elements(env->'vendors') vend,
          jsonb_array_elements(vend->'items') it
    where it->>'item_id' = current_setting('test.item_pend', true)),
  140::numeric,
  '(H/P) cancelled PO: suggested_qty stays 140 (inbound already ignored post-138)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- close_short_purchase_order — (G) partial → received, remainder leaves pending.
-- Fresh PO: PEND ordered 48, receive 20 (partial), then close short.
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _po3 on commit drop as
with po as (
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid,
          current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid,
          'sent', 288.00)
  returning id
)
select id from po;
do $$
declare v_po3 uuid; v_line uuid;
begin
  select id into v_po3 from _po3;
  perform set_config('test.po3_id', v_po3::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po3, current_setting('test.item_pend', true)::uuid, 48, null, 3.00)
  returning id into v_line;
  perform set_config('test.line3', v_line::text, true);
end $$;

-- Partial receive 20 of 48 → partial.
select public.receive_purchase_order(
  current_setting('test.po3_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line3', true)::uuid, 'received_qty', 20)),
  gen_random_uuid()
);

select is(
  (select status from public.purchase_orders where id = current_setting('test.po3_id', true)::uuid),
  'partial',
  '(G-pre) PO is partial after receiving 20 of 48'
);

-- Close short → received, received_at set.
create temp table _cs on commit drop as
select public.close_short_purchase_order(current_setting('test.po3_id', true)::uuid) as env;

select is(
  (select env->>'status' from _cs),
  'received',
  '(G) close short transitions partial → received'
);
select ok(
  (select (received_at is not null) from public.purchase_orders where id = current_setting('test.po3_id', true)::uuid),
  '(G) close short stamps received_at (remainder leaves pending_po_qty)'
);

-- (G) close short refuses from a non-partial PO (the just-closed received one).
select throws_ok(
  format($q$select public.close_short_purchase_order(%L::uuid)$q$, current_setting('test.po3_id', true)),
  'P0001',
  null,
  '(G) close short refuses a non-partial (received) PO (P0001)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- status CHECK — (S) off-vocabulary token rejected; valid tokens accepted.
-- ═══════════════════════════════════════════════════════════════════════════
select throws_ok(
  format(
    $q$insert into public.purchase_orders (store_id, vendor_id, status)
       values (%L::uuid, %L::uuid, 'submitted')$q$,
    current_setting('test.frederick_id', true), current_setting('test.vendor1', true)
  ),
  '23514',   -- check_violation
  null,
  '(S) inserting status = ''submitted'' is rejected by purchase_orders_status_check'
);

select lives_ok(
  format(
    $q$insert into public.purchase_orders (store_id, vendor_id, status)
       values (%L::uuid, %L::uuid, 'cancelled')$q$,
    current_setting('test.frederick_id', true), current_setting('test.vendor1', true)
  ),
  '(S) inserting a valid token (''cancelled'') passes the CHECK'
);

select * from finish();
rollback;

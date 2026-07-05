-- supabase/tests/staff_receiving_gate.test.sql
--
-- Spec 113 — pgTAP coverage for the staff-receiving PRICE-PATH privilege gate
-- (supabase/migrations/20260707000000_staff_receiving_price_gate.sql). This is
-- the one gate hunk added to receive_purchase_order §3b: a non-privileged store
-- member who sends a non-null new_case_price is refused server-side (42501
-- 'forbidden: price change requires admin') with NOTHING durable, while the
-- stock path stays open for store members and the privileged price path is
-- unchanged (spec 109 regression).
--
-- A NEW file (do NOT extend cost_on_receipt.test.sql — that suite stays pinned
-- to spec 109's cost path). Same harness idioms: begin; create extension … ;
-- select plan(N); … select * from finish(); rollback; `set local role
-- authenticated`; jwt-claims via set_config('request.jwt.claims', …). Fixtures
-- created INSIDE the transaction (hermetic under seed AND CI-fresh). No `set role
-- anon` (segfaults CI per spec 067).
--
-- JWT roles (mirroring po_loop.test.sql / store_count_layouts.test.sql):
--   • MASTER  3333… (app_metadata.role = master → auth_is_privileged() TRUE) —
--     used for fixture mutations, the privileged-price regression (case c), and
--     the RLS-bypassing "read past the refusal" checks in case (b).
--   • STAFF   2222… (app_metadata.role = user → auth_is_privileged() FALSE, but
--     auth_can_see_store TRUE for Frederick) — the "staff store-member" caller
--     for cases a / b / d / e. Verified against the local seed: 2222 is a member
--     of Frederick + Towson, NOT Charles.
--   Charles is the store 2222 is NOT a member of (case e non-member read).
--
-- ★ packing chosen for clean assertions: case_qty = 4, sub_unit_size = 1 →
-- divisor 4. So case 20 ⇒ per-each 5; case 40 ⇒ per-each 10. Every Frederick
-- item starts case_price 20 / cost_per_unit 5.00 / current_stock 10 so the
-- nothing-durable + regression pins have a clean baseline.
--
-- The pinned refusal string 'forbidden: price change requires admin' is a
-- byte-for-byte house contract (the 'cannot delete self' / 'cannot demote self'
-- family). Case (f) pins it byte-equal; a reword must edit this file in the same
-- PR. Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(45);

-- ─── fixtures ──────────────────────────────────────────────────
-- Frederick (member store for the 2222 staff caller) + Charles (NON-member) + a
-- brand + one vendor. 3333 is master; 2222 is a plain `user` member of
-- Towson+Frederick.
do $$
declare
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_staff_id   uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_charles    uuid;
  v_brand_id   uuid;
  v_vendor1    uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  select id into v_vendor1 from public.vendors order by id asc limit 1;

  perform set_config('test.master_id',    v_master_id::text, true);
  perform set_config('test.staff_id',     v_staff_id::text,  true);
  perform set_config('test.frederick_id', v_frederick::text, true);
  perform set_config('test.charles_id',   v_charles::text,   true);
  perform set_config('test.brand_id',     v_brand_id::text,  true);
  perform set_config('test.vendor1',      v_vendor1::text,   true);
end $$;

select ok(
  current_setting('test.frederick_id', true) <> ''
    and current_setting('test.charles_id', true) <> ''
    and current_setting('test.vendor1', true) <> '',
  '(0) fixture: Frederick + Charles + a vendor resolve from seed'
);

-- ─── master JWT — privileged for all fixture mutations + cross-RLS reads ─────
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

-- Fresh catalog items (case_qty 4 / sub_unit_size 1 → divisor 4). One per case
-- that needs an independent baseline so cross-case churn never bleeds.
--   STOCK  → case (a) staff stock-only receive.
--   NODUR  → case (b) staff priced-line refusal (nothing durable).
--   REG    → case (c) privileged price regression.
--   REPLAY → case (d) staff replay idempotency.
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values
    (current_setting('test.brand_id', true)::uuid, 'SPEC113-STOCK-'||gen_random_uuid()::text,  'each', 4, 1, 5.00),
    (current_setting('test.brand_id', true)::uuid, 'SPEC113-NODUR-'||gen_random_uuid()::text,  'each', 4, 1, 5.00),
    (current_setting('test.brand_id', true)::uuid, 'SPEC113-REG-'||gen_random_uuid()::text,    'each', 4, 1, 5.00),
    (current_setting('test.brand_id', true)::uuid, 'SPEC113-REPLAY-'||gen_random_uuid()::text, 'each', 4, 1, 5.00)
  returning id, name
)
select id, name,
       case
         when name like 'SPEC113-STOCK%'  then 'stock'
         when name like 'SPEC113-NODUR%'  then 'nodur'
         when name like 'SPEC113-REG%'    then 'reg'
         else 'replay'
       end as kind
  from ins;

-- Frederick items — all case_price 20 / cost_per_unit 5.00 / current_stock 10.
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, case_price, cost_per_unit, current_stock, par_level, usage_per_portion)
  values
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind = 'stock'),
     current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0),
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind = 'nodur'),
     current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0),
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind = 'reg'),
     current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0),
    (current_setting('test.frederick_id', true)::uuid, (select id from _cat where kind = 'replay'),
     current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0)
  returning id, catalog_id
)
select i.id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
begin
  perform set_config('test.item_stock',  (select id from _items where kind = 'stock')::text,  true);
  perform set_config('test.item_nodur',  (select id from _items where kind = 'nodur')::text,  true);
  perform set_config('test.item_reg',    (select id from _items where kind = 'reg')::text,    true);
  perform set_config('test.item_replay', (select id from _items where kind = 'replay')::text, true);
end $$;

-- item_vendors links — all V1 primary, case 20 / per-each 5.
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  (current_setting('test.item_stock',  true)::uuid, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true),
  (current_setting('test.item_nodur',  true)::uuid, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true),
  (current_setting('test.item_reg',    true)::uuid, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true),
  (current_setting('test.item_replay', true)::uuid, current_setting('test.vendor1', true)::uuid, 5.00, 20.00, true)
on conflict (item_id, vendor_id) do nothing;

-- Four fresh Frederick 'sent' POs (one per case), each one line.
--   PO_STOCK  → STOCK  item, ordered 8.
--   PO_NODUR  → NODUR  item, ordered 8.
--   PO_REG    → REG    item, ordered 8.
--   PO_REPLAY → REPLAY item, ordered 4.
do $$
declare v_po uuid; v_line uuid;
begin
  -- PO_STOCK
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid, current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid, 'sent', 160.00)
  returning id into v_po;
  perform set_config('test.po_stock_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_stock', true)::uuid, 8, null, 20.00)
  returning id into v_line;
  perform set_config('test.line_stock', v_line::text, true);

  -- PO_NODUR
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid, current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid, 'sent', 160.00)
  returning id into v_po;
  perform set_config('test.po_nodur_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_nodur', true)::uuid, 8, null, 20.00)
  returning id into v_line;
  perform set_config('test.line_nodur', v_line::text, true);

  -- PO_REG
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid, current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid, 'sent', 160.00)
  returning id into v_po;
  perform set_config('test.po_reg_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_reg', true)::uuid, 8, null, 20.00)
  returning id into v_line;
  perform set_config('test.line_reg', v_line::text, true);

  -- PO_REPLAY
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid, current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid, 'sent', 80.00)
  returning id into v_po;
  perform set_config('test.po_replay_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_replay', true)::uuid, 4, null, 20.00)
  returning id into v_line;
  perform set_config('test.line_replay', v_line::text, true);
end $$;

-- ═══ Switch to the STAFF caller (2222, role `user`, Frederick member) ═══════
-- auth_can_see_store(Frederick) = TRUE, auth_is_privileged() = FALSE.
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.staff_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

-- ═══════════════════════════════════════════════════════════════════════════
-- (a) AC-1 — STAFF store-member STOCK-ONLY receive SUCCEEDS.
-- As 2222: receive 8 of 8 on PO_STOCK with NO price key. Stock 10 → 18, status
-- → received, price side untouched, one 'PO received' audit, no 'PO price change'.
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _ra on commit drop as
select public.receive_purchase_order(
  current_setting('test.po_stock_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_stock', true)::uuid,
    'received_qty', 8)),
  gen_random_uuid()
) as env;

select is(
  (select env->>'status' from _ra),
  'received',
  '(a) AC-1: staff stock-only full receive flips status → received'
);
select is(
  (select (env->>'conflict')::boolean from _ra),
  false,
  '(a) AC-1: staff stock-only receive is not a conflict'
);
select is(
  (select jsonb_array_length(env->'price_changes') from _ra),
  0,
  '(a) AC-1: staff stock-only receive returns price_changes: [] (no price path)'
);
select is(
  (select received_qty from public.po_items where id = current_setting('test.line_stock', true)::uuid),
  8::numeric,
  '(a) AC-1: po_items.received_qty accumulates to 8 (additive stock path)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_stock', true)::uuid),
  18::numeric,
  '(a) AC-1: inventory_items.current_stock 10 → 18 (+8 counted units)'
);
select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_stock', true)::uuid),
  20.00::numeric,
  '(a) AC-1: inventory_items.case_price STILL 20 (stock-only, price side untouched)'
);
select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_stock', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  20.00::numeric,
  '(a) AC-1: item_vendors.case_price STILL 20 (stock-only, price side untouched)'
);
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO received'
      and store_id = current_setting('test.frederick_id', true)::uuid
      and detail like 'PO ' || left(current_setting('test.po_stock_id', true), 8) || '%'),
  1,
  '(a) AC-1: exactly one ''PO received'' audit row for the staff receive'
);
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC113-STOCK%'),
  0,
  '(a) AC-1: NO ''PO price change'' audit row (staff never touched the cost path)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (b) AC-2 — STAFF caller with new_case_price on a line → 42501, NOTHING durable.
-- As 2222: receive 8 of 8 on PO_NODUR WITH new_case_price 40. The gate refuses
-- the WHOLE call before any write or idempotency stamp.
-- ═══════════════════════════════════════════════════════════════════════════
select throws_ok(
  format(
    $q$select public.receive_purchase_order(%L::uuid,
         jsonb_build_array(jsonb_build_object(
           'po_item_id', %L::uuid, 'received_qty', 8, 'new_case_price', 40)),
         gen_random_uuid())$q$,
    current_setting('test.po_nodur_id', true), current_setting('test.line_nodur', true)
  ),
  '42501',
  null,
  '(b) AC-2: staff caller sending new_case_price → 42501 (price path is admin-only)'
);

-- Read past RLS as master to prove NOTHING durable survived the refusal.
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);

select ok(
  (select received_qty is null from public.po_items where id = current_setting('test.line_nodur', true)::uuid),
  '(b) AC-2: refused call wrote NO po_items.received_qty (still null, NOT 8)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_nodur', true)::uuid),
  10::numeric,
  '(b) AC-2: refused call wrote NO stock (current_stock still 10, NOT 18)'
);
select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_nodur', true)::uuid),
  20.00::numeric,
  '(b) AC-2: refused call wrote NO item scalar case_price (still 20)'
);
select is(
  (select cost_per_unit from public.inventory_items where id = current_setting('test.item_nodur', true)::uuid),
  5.000000::numeric,
  '(b) AC-2: refused call wrote NO item scalar cost_per_unit (still 5)'
);
select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_nodur', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  20.00::numeric,
  '(b) AC-2: refused call wrote NO link case_price (item_vendors still 20)'
);
select is(
  (select cost_per_unit from public.item_vendors
    where item_id = current_setting('test.item_nodur', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  5.000000::numeric,
  '(b) AC-2: refused call wrote NO link cost_per_unit (item_vendors still 5)'
);
select is(
  (select count(*)::int from public.audit_log
    where store_id = current_setting('test.frederick_id', true)::uuid
      and detail like 'PO ' || left(current_setting('test.po_nodur_id', true), 8) || '%'),
  0,
  '(b) AC-2: refused call wrote NO audit row (neither ''PO received'' nor ''PO price change'')'
);
select ok(
  (select receive_client_uuid is null from public.purchase_orders where id = current_setting('test.po_nodur_id', true)::uuid),
  '(b) AC-2: refused call did NOT stamp receive_client_uuid (idempotency key untouched)'
);
select is(
  (select status from public.purchase_orders where id = current_setting('test.po_nodur_id', true)::uuid),
  'sent',
  '(b) AC-2: refused call did NOT flip status (still sent, NOT partial/received)'
);

-- (b) PRESENCE-not-value pin — a staff caller is refused identically for a zero,
-- equal-to-current, and NEGATIVE price. The gate fires before the `< 0` P0001
-- and before the `> 0` / distinct-from value branches: a non-privileged caller
-- can never reach a value-dependent path. Back to the STAFF caller.
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.staff_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

select throws_ok(
  format(
    $q$select public.receive_purchase_order(%L::uuid,
         jsonb_build_array(jsonb_build_object(
           'po_item_id', %L::uuid, 'received_qty', 8, 'new_case_price', 0)),
         gen_random_uuid())$q$,
    current_setting('test.po_nodur_id', true), current_setting('test.line_nodur', true)
  ),
  '42501',
  null,
  '(b) AC-2: staff new_case_price = 0 → SAME 42501 (presence, not value — gate before > 0)'
);
select throws_ok(
  format(
    $q$select public.receive_purchase_order(%L::uuid,
         jsonb_build_array(jsonb_build_object(
           'po_item_id', %L::uuid, 'received_qty', 8, 'new_case_price', 20)),
         gen_random_uuid())$q$,
    current_setting('test.po_nodur_id', true), current_setting('test.line_nodur', true)
  ),
  '42501',
  null,
  '(b) AC-2: staff new_case_price = 20 (equal-to-current) → SAME 42501 (no same-price bypass)'
);
select throws_ok(
  format(
    $q$select public.receive_purchase_order(%L::uuid,
         jsonb_build_array(jsonb_build_object(
           'po_item_id', %L::uuid, 'received_qty', 8, 'new_case_price', -1)),
         gen_random_uuid())$q$,
    current_setting('test.po_nodur_id', true), current_setting('test.line_nodur', true)
  ),
  '42501',
  null,
  '(b) AC-2: staff new_case_price = -1 → SAME 42501, NOT the P0001 <0 abort (gate fires first)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (c) AC-3 — PRIVILEGED caller's changed-price receive STILL works (regression).
-- As master 3333: receive 8 of 8 on PO_REG WITH new_case_price 40. The spec-109
-- semantics survive the re-CREATE byte-identically.
-- ═══════════════════════════════════════════════════════════════════════════
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);

create temp table _rc on commit drop as
select public.receive_purchase_order(
  current_setting('test.po_reg_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_reg', true)::uuid,
    'received_qty', 8, 'new_case_price', 40)),
  gen_random_uuid()
) as env;

select is(
  (select case_price from public.item_vendors
    where item_id = current_setting('test.item_reg', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  40.00::numeric,
  '(c) AC-3: privileged receive updates item_vendors.case_price 20 → 40'
);
select is(
  (select cost_per_unit from public.item_vendors
    where item_id = current_setting('test.item_reg', true)::uuid
      and vendor_id = current_setting('test.vendor1', true)::uuid),
  10.000000::numeric,
  '(c) AC-3: privileged receive recomputes item_vendors.cost_per_unit via ★ = 40/4 = 10'
);
select is(
  (select case_price from public.inventory_items where id = current_setting('test.item_reg', true)::uuid),
  40.00::numeric,
  '(c) AC-3: privileged receive updates inventory_items.case_price 20 → 40 (scalar)'
);
select is(
  (select cost_per_unit from public.inventory_items where id = current_setting('test.item_reg', true)::uuid),
  10.000000::numeric,
  '(c) AC-3: privileged receive recomputes inventory_items.cost_per_unit via ★ = 10'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_reg', true)::uuid),
  18::numeric,
  '(c) AC-3: privileged priced receive still increments stock 10 → 18 (spec-107 additive)'
);
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO price change' and item_ref like 'SPEC113-REG%'),
  1,
  '(c) AC-3: exactly one ''PO price change'' audit row for the changed line'
);
select is(
  (select jsonb_array_length(env->'price_changes') from _rc),
  1,
  '(c) AC-3: envelope price_changes has exactly one element (privileged path unchanged)'
);
select is(
  (select (env->'price_changes'->0->>'new_cost_per_unit')::numeric from _rc),
  10::numeric,
  '(c) AC-3: price_changes[0].new_cost_per_unit = 10 (★ — full spec-109 shape survives)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (d) AC-4 — STAFF replay idempotency UNAFFECTED + not spuriously refused.
-- As 2222: stock-only receive 4 of 4 on PO_REPLAY with a FIXED client_uuid →
-- succeeds; replay the SAME uuid + SAME stock-only lines (no price key) →
-- conflict:true, nothing re-applied, and NOT refused (the gate sees no priced
-- line, and the dedup short-circuit fires before the loop anyway).
-- ═══════════════════════════════════════════════════════════════════════════
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.staff_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

select set_config('test.cuuid_replay', gen_random_uuid()::text, true);

-- First call: stock-only, stock 10 → 14, status → received.
create temp table _rd1 on commit drop as
select public.receive_purchase_order(
  current_setting('test.po_replay_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_replay', true)::uuid, 'received_qty', 4)),
  current_setting('test.cuuid_replay', true)::uuid
) as env;

select is(
  (select env->>'status' from _rd1),
  'received',
  '(d) AC-4: staff first stock-only receive (4 of 4) → status received'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_replay', true)::uuid),
  14::numeric,
  '(d) AC-4: staff first receive incremented stock 10 → 14'
);

-- Replay with the SAME uuid + SAME stock-only lines — must NOT raise, must dedup.
select lives_ok(
  format(
    $q$select public.receive_purchase_order(%L::uuid,
         jsonb_build_array(jsonb_build_object(
           'po_item_id', %L::uuid, 'received_qty', 4)),
         %L::uuid)$q$,
    current_setting('test.po_replay_id', true),
    current_setting('test.line_replay', true),
    current_setting('test.cuuid_replay', true)
  ),
  '(d) AC-4: staff replay of a stock-only receive does NOT raise (no priced line → gate not reached)'
);

create temp table _rd2 on commit drop as
select public.receive_purchase_order(
  current_setting('test.po_replay_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id', current_setting('test.line_replay', true)::uuid, 'received_qty', 4)),
  current_setting('test.cuuid_replay', true)::uuid
) as env;

select is(
  (select (env->>'conflict')::boolean from _rd2),
  true,
  '(d) AC-4: staff replay with the same client_uuid → conflict:true'
);
select is(
  (select jsonb_array_length(env->'price_changes') from _rd2),
  0,
  '(d) AC-4: staff replay returns price_changes: [] (nothing re-applied)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.item_replay', true)::uuid),
  14::numeric,
  '(d) AC-4: staff replay does NOT double-increment stock (stays 14)'
);
select is(
  (select received_qty from public.po_items where id = current_setting('test.line_replay', true)::uuid),
  4::numeric,
  '(d) AC-4: staff replay leaves po_items.received_qty at 4 (not re-added)'
);
select is(
  (select count(*)::int from public.audit_log
    where action = 'PO received'
      and store_id = current_setting('test.frederick_id', true)::uuid
      and detail like 'PO ' || left(current_setting('test.po_replay_id', true), 8) || '%'),
  1,
  '(d) AC-4: staff replay did NOT write a second ''PO received'' audit row (still 1)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (e) AC-6 — READ confirmation: staff reads OWN store's open POs + lines; a
-- non-member reads 0. No new read policy is needed — the existing
-- auth_can_see_store already admits the member and denies the non-member.
-- ═══════════════════════════════════════════════════════════════════════════
-- Seed a Charles 'sent' PO + line as master, so the non-member read has a real
-- row to be denied (proving 0-rows is RLS, not empty data).
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);

do $$
declare v_cat uuid; v_item uuid; v_po uuid; v_line uuid;
begin
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values (current_setting('test.brand_id', true)::uuid, 'SPEC113-CHARLES-'||gen_random_uuid()::text, 'each', 4, 1, 5.00)
  returning id into v_cat;
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, case_price, cost_per_unit, current_stock, par_level, usage_per_portion)
  values (current_setting('test.charles_id', true)::uuid, v_cat,
          current_setting('test.vendor1', true)::uuid, 20.00, 5.00, 10, 0, 0)
  returning id into v_item;
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.charles_id', true)::uuid, current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid, 'sent', 80.00)
  returning id into v_po;
  perform set_config('test.po_charles_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, v_item, 4, null, 20.00)
  returning id into v_line;
  perform set_config('test.line_charles', v_line::text, true);
end $$;

-- As the STAFF member (Frederick member, NOT Charles).
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.staff_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

select ok(
  (select count(*)::int from public.purchase_orders
    where store_id = current_setting('test.frederick_id', true)::uuid
      and status in ('sent', 'partial')) > 0,
  '(e) AC-6: staff member SELECTs Frederick''s OPEN POs (status in sent/partial) — > 0 rows'
);
select ok(
  (select count(*)::int from public.po_items
    where po_id = current_setting('test.po_nodur_id', true)::uuid) > 0,
  '(e) AC-6: staff member reads a Frederick PO''s po_items lines (child-scoped through parent)'
);
select is(
  (select count(*)::int from public.purchase_orders
    where id = current_setting('test.po_charles_id', true)::uuid),
  0,
  '(e) AC-6: staff member (NOT a Charles member) sees 0 rows for the Charles PO (RLS SELECT scope)'
);
select is(
  (select count(*)::int from public.po_items
    where po_id = current_setting('test.po_charles_id', true)::uuid),
  0,
  '(e) AC-6: staff member sees 0 rows for the Charles PO''s po_items (no new read policy needed)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- (f) PINNED refusal string — byte-equal. The third throws_ok arg pins the
-- message; the follow-up asserts an EXPLICIT message equality so a reword fails
-- the build. House stable-string discipline ('cannot delete self' family).
-- Fresh Frederick PO so the assertion is independent of the churn above; as the
-- STAFF caller.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_po uuid; v_line uuid;
begin
  -- create as master (RLS-visible), then probe as staff below.
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                       'app_metadata', jsonb_build_object('role', 'master'))::text, true);
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid, current_setting('test.vendor1', true)::uuid,
          current_setting('test.master_id', true)::uuid, 'sent', 80.00)
  returning id into v_po;
  perform set_config('test.po_pin_id', v_po::text, true);
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, current_setting('test.item_stock', true)::uuid, 4, null, 20.00)
  returning id into v_line;
  perform set_config('test.line_pin', v_line::text, true);
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.staff_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

select throws_ok(
  format(
    $q$select public.receive_purchase_order(%L::uuid,
         jsonb_build_array(jsonb_build_object(
           'po_item_id', %L::uuid, 'received_qty', 1, 'new_case_price', 99)),
         gen_random_uuid())$q$,
    current_setting('test.po_pin_id', true), current_setting('test.line_pin', true)
  ),
  '42501',
  'forbidden: price change requires admin',
  '(f) PINNED: refusal errcode 42501 + message ''forbidden: price change requires admin'' (byte-equal)'
);

-- Explicit message-equality pin (belt to the throws_ok third-arg braces): catch
-- the raise, compare SQLERRM byte-for-byte. A reword breaks THIS too.
do $$
declare v_msg text;
begin
  begin
    perform public.receive_purchase_order(
      current_setting('test.po_pin_id', true)::uuid,
      jsonb_build_array(jsonb_build_object(
        'po_item_id', current_setting('test.line_pin', true)::uuid, 'received_qty', 1, 'new_case_price', 99)),
      gen_random_uuid());
    v_msg := '(no exception raised)';
  exception when others then
    v_msg := SQLERRM;
  end;
  perform set_config('test.pin_msg', v_msg, true);
end $$;

select is(
  current_setting('test.pin_msg', true),
  'forbidden: price change requires admin',
  '(f) PINNED: SQLERRM equals ''forbidden: price change requires admin'' exactly (house stable-string contract)'
);

select * from finish();
rollback;

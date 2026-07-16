-- supabase/tests/auto_receive_due_purchase_orders.test.sql
--
-- Spec 125 — pgTAP coverage for the auto-receive daily job RPC
-- (supabase/migrations/20260719000000_auto_receive_due_purchase_orders.sql).
--
-- Covers the design ## Test surface:
--   • Full receive: a `sent` PO with expected_delivery <= as_of → status
--     'received', received_at set, received_by NULL, current_stock += outstanding
--     qty, po_items.received_qty = ordered.
--   • Future-date skip: expected_delivery = as_of + 1 → untouched.
--   • Null-date skip: expected_delivery IS NULL → untouched (the legacy-PO analog).
--   • Status guards: 'draft' + 'cancelled' POs (even when due) → untouched.
--   • Partial top-up: a 'partial' PO with a line already received k < ordered →
--     stock gains ONLY (ordered − k), flips 'received'.
--   • Idempotency: running the RPC twice does NOT double-increment stock; the
--     second run returns 0 (received_at IS NULL filter drops the already-received
--     PO).
--   • Audit: one audit_log row per received PO with user_id IS NULL and
--     action = 'PO auto-received'.
--   • ACL pin: authenticated lacks EXECUTE; service_role has it.
--
-- All fixtures are created INSIDE the transaction (the local seed has zero PO
-- rows), so the suite is identical under the prod-pulled seed AND CI-fresh state.
-- Runs as the postgres superuser (no role switch) — the RPC is a SECURITY DEFINER
-- system job with no session callers; RLS is not the subject here (po_loop.test.sql
-- pins the per-store policies). Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(24);

-- ─── temp fixture factory ──────────────────────────────────────
-- Creates a fresh catalog row + inventory item + PO + one line, returning the
-- item id and PO id. One catalog/item per scenario so stock deltas are isolated.
create function pg_temp.mk(
  p_store    uuid,
  p_vendor   uuid,
  p_brand    uuid,
  p_status   text,
  p_expected date,
  p_stock    numeric,
  p_ordered  numeric,
  p_received numeric,
  out o_item uuid,
  out o_po   uuid
) language plpgsql as $$
declare
  v_cat uuid;
begin
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values (p_brand, 'SPEC125-' || gen_random_uuid()::text, 'each', 1, 1, 2.00)
  returning id into v_cat;

  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values (p_store, v_cat, p_vendor, 2.00, p_stock, 0, 0)
  returning id into o_item;

  insert into public.purchase_orders (store_id, vendor_id, status, total_cost, expected_delivery)
  values (p_store, p_vendor, p_status, 0, p_expected)
  returning id into o_po;

  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (o_po, o_item, p_ordered, p_received, 2.00);
end;
$$;

-- ─── build the six scenarios ───────────────────────────────────
do $$
declare
  v_store  uuid;
  v_brand  uuid;
  v_vendor uuid;
  r        record;
begin
  select id into v_store  from public.stores where name = 'Frederick' limit 1;
  select id into v_brand  from public.brands limit 1;
  select id into v_vendor from public.vendors order by id asc limit 1;

  -- DUE: sent, expected today, stock 10, ordered 5, none received → +5 → 15.
  select * into r from pg_temp.mk(v_store, v_vendor, v_brand, 'sent', current_date, 10, 5, null);
  perform set_config('t.item_due', r.o_item::text, true);
  perform set_config('t.po_due',   r.o_po::text,   true);

  -- FUTURE: sent, expected tomorrow → untouched.
  select * into r from pg_temp.mk(v_store, v_vendor, v_brand, 'sent', current_date + 1, 10, 5, null);
  perform set_config('t.item_future', r.o_item::text, true);
  perform set_config('t.po_future',   r.o_po::text,   true);

  -- NULL date: sent, expected NULL → never auto-receives.
  select * into r from pg_temp.mk(v_store, v_vendor, v_brand, 'sent', null, 10, 5, null);
  perform set_config('t.item_null', r.o_item::text, true);
  perform set_config('t.po_null',   r.o_po::text,   true);

  -- DRAFT: draft, expected today (due) → status guard skips it.
  select * into r from pg_temp.mk(v_store, v_vendor, v_brand, 'draft', current_date, 10, 5, null);
  perform set_config('t.item_draft', r.o_item::text, true);
  perform set_config('t.po_draft',   r.o_po::text,   true);

  -- CANCELLED: cancelled, expected today (due) → status guard skips it.
  select * into r from pg_temp.mk(v_store, v_vendor, v_brand, 'cancelled', current_date, 10, 5, null);
  perform set_config('t.item_cancelled', r.o_item::text, true);
  perform set_config('t.po_cancelled',   r.o_po::text,   true);

  -- PARTIAL: partial, expected yesterday, stock 20, ordered 10, 4 received →
  -- tops up +6 → 26, flips received.
  select * into r from pg_temp.mk(v_store, v_vendor, v_brand, 'partial', current_date - 1, 20, 10, 4);
  perform set_config('t.item_partial', r.o_item::text, true);
  perform set_config('t.po_partial',   r.o_po::text,   true);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (0) fixture sanity — the six POs resolved to distinct ids.
-- ═══════════════════════════════════════════════════════════════════════════
select ok(
  current_setting('t.po_due', true) <> '' and current_setting('t.po_partial', true) <> ''
    and current_setting('t.po_due', true) <> current_setting('t.po_future', true),
  '(0) fixture: six scenario POs created with distinct ids'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- RUN 1 — receives DUE + PARTIAL (both due), skips the other four.
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _run1 on commit drop as
select public.auto_receive_due_purchase_orders(current_date) as n;

select is(
  (select n from _run1),
  2,
  '(count) first run auto-receives exactly 2 POs (DUE + PARTIAL)'
);

-- ─── DUE PO fully received ──────────────────────────────────────
select is(
  (select status from public.purchase_orders where id = current_setting('t.po_due', true)::uuid),
  'received',
  '(DUE) sent PO due today → status received'
);
select ok(
  (select received_at is not null from public.purchase_orders where id = current_setting('t.po_due', true)::uuid),
  '(DUE) received_at stamped'
);
select ok(
  (select received_by is null from public.purchase_orders where id = current_setting('t.po_due', true)::uuid),
  '(DUE) received_by NULL (system attribution)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_due', true)::uuid),
  15::numeric,
  '(DUE) current_stock 10 → 15 (+5 outstanding)'
);
select is(
  (select received_qty from public.po_items where po_id = current_setting('t.po_due', true)::uuid),
  5::numeric,
  '(DUE) po_items.received_qty topped up to ordered (5)'
);

-- ─── FUTURE-date PO untouched ───────────────────────────────────
select is(
  (select status from public.purchase_orders where id = current_setting('t.po_future', true)::uuid),
  'sent',
  '(FUTURE) expected_delivery tomorrow → status unchanged (sent)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_future', true)::uuid),
  10::numeric,
  '(FUTURE) current_stock unchanged (10)'
);

-- ─── NULL-date PO untouched ─────────────────────────────────────
select is(
  (select status from public.purchase_orders where id = current_setting('t.po_null', true)::uuid),
  'sent',
  '(NULL) expected_delivery NULL → status unchanged (sent)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_null', true)::uuid),
  10::numeric,
  '(NULL) current_stock unchanged (10)'
);

-- ─── DRAFT PO untouched (status guard) ──────────────────────────
select is(
  (select status from public.purchase_orders where id = current_setting('t.po_draft', true)::uuid),
  'draft',
  '(DRAFT) due draft PO → status unchanged (draft)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_draft', true)::uuid),
  10::numeric,
  '(DRAFT) current_stock unchanged (10)'
);

-- ─── CANCELLED PO untouched (status guard) ──────────────────────
select is(
  (select status from public.purchase_orders where id = current_setting('t.po_cancelled', true)::uuid),
  'cancelled',
  '(CANCELLED) due cancelled PO → status unchanged (cancelled)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_cancelled', true)::uuid),
  10::numeric,
  '(CANCELLED) current_stock unchanged (10)'
);

-- ─── PARTIAL PO topped up ───────────────────────────────────────
select is(
  (select status from public.purchase_orders where id = current_setting('t.po_partial', true)::uuid),
  'received',
  '(PARTIAL) due partial PO → status received'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_partial', true)::uuid),
  26::numeric,
  '(PARTIAL) current_stock 20 → 26 (+6 remainder only, not full 10)'
);
select is(
  (select received_qty from public.po_items where po_id = current_setting('t.po_partial', true)::uuid),
  10::numeric,
  '(PARTIAL) po_items.received_qty topped up to ordered (10)'
);

-- ─── AUDIT: one system-attributed row for the DUE PO ────────────
select is(
  (select count(*)::int from public.audit_log
     where action = 'PO auto-received'
       and user_id is null
       and detail like 'PO ' || left(current_setting('t.po_due', true), 8) || '%'),
  1,
  '(AUDIT) exactly one audit_log row (user_id NULL, action ''PO auto-received'') for the DUE PO'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- RUN 2 — idempotency. The received_at IS NULL filter drops both already-received
-- POs → returns 0, stock does NOT double-increment.
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _run2 on commit drop as
select public.auto_receive_due_purchase_orders(current_date) as n;

select is(
  (select n from _run2),
  0,
  '(idempotency) second run auto-receives 0 POs (all due ones already received)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_due', true)::uuid),
  15::numeric,
  '(idempotency) DUE current_stock still 15 (no double-increment)'
);
select is(
  (select current_stock from public.inventory_items where id = current_setting('t.item_partial', true)::uuid),
  26::numeric,
  '(idempotency) PARTIAL current_stock still 26 (no double-increment)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ACL pin — zero session callers; cron/service_role only.
-- ═══════════════════════════════════════════════════════════════════════════
select ok(
  not has_function_privilege('authenticated',
    'public.auto_receive_due_purchase_orders(date)', 'execute'),
  '(ACL) authenticated lacks EXECUTE'
);
select ok(
  has_function_privilege('service_role',
    'public.auto_receive_due_purchase_orders(date)', 'execute'),
  '(ACL) service_role has EXECUTE'
);

select * from finish();
rollback;

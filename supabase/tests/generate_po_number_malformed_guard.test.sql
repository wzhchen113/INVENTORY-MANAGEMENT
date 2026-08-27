-- supabase/tests/generate_po_number_malformed_guard.test.sql
--
-- Regression coverage for the `generate_po_number()` hardening
-- (supabase/migrations/20260819000000_generate_po_number_malformed_guard.sql).
--
-- The bug: a row whose po_number didn't match 'PO-<digits>' made the trigger's
-- positional `cast(substring(po_number from 4) as int)` raise 22P02, which
-- aborted EVERY insert into purchase_orders (prod: 'PO-SAMS-PASS-1', 2026-08-09
-- → all FILL CART / PO creation dead for ten days).
--
-- Covers:
--   • A malformed row does NOT break the insert path (the actual regression).
--   • Malformed rows are excluded from the counter — the next number continues
--     the numeric sequence rather than jumping or restarting.
--   • Rows without the 'PO-' prefix at all are ignored too.
--   • Empty table → PO-001 (the coalesce floor).
--   • Explicit po_number still bypasses the trigger (the `when` clause that let
--     the bad row in is intentional and unchanged).
--
-- Fixtures are created inside the transaction; existing purchase_orders rows are
-- deleted first so the counter assertions are deterministic under BOTH the
-- prod-pulled seed and CI-fresh state. Hermetic: begin; … rollback;.
-- store_id / vendor_id are nullable and irrelevant here, so no catalog fixtures
-- are needed — RLS and the per-store policies are pinned by po_loop.test.sql.
--
-- NB: every row inserted here carries an explicit id and assertions look the row
-- up by that id. `created_at` defaults to now(), which is the TRANSACTION
-- timestamp — identical for every row in this file — so an `order by created_at
-- desc limit 1` would pick an arbitrary row.

begin;
create extension if not exists pgtap;

select plan(8);

-- Clear the table so `max()` sees only what each scenario inserts.
delete from public.po_items;
delete from public.purchase_orders;

-- ─── empty table → the coalesce floor ──────────────────────────
insert into public.purchase_orders (id, status, total_cost)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'draft', 0);
select is(
  (select po_number from public.purchase_orders where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'PO-001',
  'empty table: first generated number is PO-001'
);

-- ─── normal sequence still increments ──────────────────────────
insert into public.purchase_orders (id, status, total_cost)
values ('aaaaaaaa-0000-4000-8000-000000000002', 'draft', 0);
select is(
  (select po_number from public.purchase_orders where id = 'aaaaaaaa-0000-4000-8000-000000000002'),
  'PO-002',
  'sequence continues from the numeric max'
);

-- ─── explicit po_number bypasses the trigger (unchanged) ───────
insert into public.purchase_orders (id, po_number, status, total_cost)
values ('aaaaaaaa-0000-4000-8000-000000000003', 'PO-015', 'draft', 0);
select is(
  (select po_number from public.purchase_orders where id = 'aaaaaaaa-0000-4000-8000-000000000003'),
  'PO-015',
  'explicit po_number is preserved (trigger is when-gated on NULL)'
);

-- ─── the regression: a malformed row must not abort the insert ─
-- This is the exact prod shape. Under the old positional cast the next insert
-- raised 22P02 and no PO could be created at all.
insert into public.purchase_orders (id, po_number, status, total_cost)
values ('aaaaaaaa-0000-4000-8000-000000000004', 'PO-SAMS-PASS-1', 'draft', 0);

select lives_ok(
  $$insert into public.purchase_orders (id, status, total_cost)
    values ('aaaaaaaa-0000-4000-8000-000000000005', 'draft', 0)$$,
  'insert survives a malformed po_number in the table (the 22P02 regression)'
);

select is(
  (select po_number from public.purchase_orders where id = 'aaaaaaaa-0000-4000-8000-000000000005'),
  'PO-016',
  'malformed row is excluded from the counter; sequence continues past PO-015'
);

-- ─── a row with no 'PO-' prefix at all is ignored too ──────────
insert into public.purchase_orders (id, po_number, status, total_cost)
values ('aaaaaaaa-0000-4000-8000-000000000006', 'LEGACY-99', 'draft', 0);

select lives_ok(
  $$insert into public.purchase_orders (id, status, total_cost)
    values ('aaaaaaaa-0000-4000-8000-000000000007', 'draft', 0)$$,
  'insert survives a po_number with no PO- prefix'
);

select is(
  (select po_number from public.purchase_orders where id = 'aaaaaaaa-0000-4000-8000-000000000007'),
  'PO-017',
  'unprefixed row does not perturb the counter'
);

-- ─── the function itself keeps its hardened search_path ────────
select is(
  (select proconfig from pg_proc where oid = 'public.generate_po_number()'::regprocedure),
  array['search_path=public'],
  'generate_po_number keeps the spec-024 pinned search_path'
);

select * from finish();
rollback;

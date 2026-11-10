-- supabase/tests/generate_po_number_malformed_guard.test.sql
--
-- Regression coverage for the `generate_po_number()` hardening
-- (supabase/migrations/20260819000000_generate_po_number_malformed_guard.sql),
-- updated for the sequence-backed counter of spec 190
-- (supabase/migrations/20261109140000_po_number_sequence.sql).
--
-- The bug: a row whose po_number didn't match 'PO-<digits>' made the trigger's
-- positional `cast(substring(po_number from 4) as int)` raise 22P02, which
-- aborted EVERY insert into purchase_orders (prod: 'PO-SAMS-PASS-1', 2026-08-09
-- → all FILL CART / PO creation dead for ten days).
--
-- Covers:
--   • A malformed row does NOT break the insert path (the actual regression).
--   • Malformed rows don't perturb the counter — the next number is the previous
--     generated number + 1.
--   • Rows without the 'PO-' prefix at all are ignored too.
--   • Deleting every row does NOT reset the counter (spec 190, defect 4).
--   • Explicit po_number still bypasses the trigger (the `when` clause that let
--     the bad row in is intentional and unchanged), and the counter does not
--     jump to an explicit number.
--
-- WHY THE EXPECTATIONS ARE RELATIVE (spec 190, AC-13). Before spec 190 the
-- counter was max(po_number) + 1, so emptying the table gave PO-001 and the
-- file could assert PO-001 / PO-002 / PO-016 / PO-017. The counter is now
-- public.purchase_orders_po_number_seq: it does not reset when rows are deleted,
-- and its values survive this file's `rollback` (and every earlier test file's),
-- so its absolute value depends on what ran before. The assertions therefore
-- expect the sequence's next value (read as postgres just before the insert),
-- or "previous generated number + 1" with nothing else inserting in between,
-- each formatted with public.format_po_number(). The explicit fixture is
-- next + 500, computed at run time, instead of a literal PO-015: on CI, earlier
-- test files have already used low numbers, so a literal could be the
-- sequence's next value and send the following inserts through the skip loop by
-- accident. The deliberate collision is covered by AC-10 in
-- generate_po_number_sequence.test.sql.
--
-- Existing purchase_orders rows are still deleted first (unfiltered — spec 186
-- AC-27 refers to that delete), now to show the counter does NOT reset.
-- Hermetic: begin; … rollback; (except the sequence, which only ever moves up).
-- store_id / vendor_id are nullable and irrelevant here, so no catalog fixtures
-- are needed — RLS and the per-store policies are pinned by po_loop.test.sql,
-- and the RLS-blind numbering by generate_po_number_sequence.test.sql.
--
-- NB: every row inserted here carries an explicit id and assertions look the row
-- up by that id. `created_at` defaults to now(), which is the TRANSACTION
-- timestamp — identical for every row in this file — so an `order by created_at
-- desc limit 1` would pick an arbitrary row.

begin;
create extension if not exists pgtap;

select plan(8);

-- The value the next nextval() will return (postgres only: client roles have
-- no SELECT on the sequence).
create function pg_temp.seq_next() returns bigint language sql volatile as $$
  select case when is_called then last_value + 1 else last_value end
    from public.purchase_orders_po_number_seq
$$;

-- Numeric part of a PO's po_number, by id.
create function pg_temp.num(p_id uuid) returns bigint language sql stable as $$
  select (substring(po_number from '^PO-([0-9]+)$'))::bigint
    from public.purchase_orders where id = p_id
$$;

-- Clear the table: under spec 190 this must NOT reset the counter.
delete from public.po_items;
delete from public.purchase_orders;

-- ─── empty table → the sequence's next value, not PO-001 ───────
do $$ begin perform set_config('test.next1', pg_temp.seq_next()::text, true); end $$;

insert into public.purchase_orders (id, status, total_cost)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'draft', 0);
select is(
  (select po_number from public.purchase_orders where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  public.format_po_number(current_setting('test.next1')::bigint),
  'empty table: the first generated number is the sequence''s next value (deleting rows does not reset it)'
);

-- ─── normal sequence still increments ──────────────────────────
insert into public.purchase_orders (id, status, total_cost)
values ('aaaaaaaa-0000-4000-8000-000000000002', 'draft', 0);
select is(
  (select po_number from public.purchase_orders where id = 'aaaaaaaa-0000-4000-8000-000000000002'),
  public.format_po_number(pg_temp.num('aaaaaaaa-0000-4000-8000-000000000001') + 1),
  'sequence continues: previous generated number + 1'
);

-- ─── explicit po_number bypasses the trigger (unchanged) ───────
-- Far ahead of the sequence (next + 500), so it can't collide with anything this
-- file generates.
do $$
begin
  perform set_config('test.explicit', public.format_po_number(pg_temp.seq_next() + 500), true);
end $$;

insert into public.purchase_orders (id, po_number, status, total_cost)
values ('aaaaaaaa-0000-4000-8000-000000000003', current_setting('test.explicit'), 'draft', 0);
select is(
  (select po_number from public.purchase_orders where id = 'aaaaaaaa-0000-4000-8000-000000000003'),
  current_setting('test.explicit'),
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
  public.format_po_number(pg_temp.num('aaaaaaaa-0000-4000-8000-000000000002') + 1),
  'malformed row and explicit number leave the counter alone; next is previous generated + 1'
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
  public.format_po_number(pg_temp.num('aaaaaaaa-0000-4000-8000-000000000005') + 1),
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

-- ============================================================
-- Spec 190 - number purchase orders from a sequence, not from max().
--
-- public.generate_po_number() (the BEFORE INSERT trigger behind set_po_number,
-- `WHEN (new.po_number IS NULL)`) used to pick
-- max(<anchored 'PO-<digits>' capture>) + 1 and format it with lpad(n, 3).
-- That had four defects:
--   1. max() ran as the caller (SECURITY INVOKER), so RLS hid every PO the
--      caller can't see and they got a number that already exists (23505).
--   2. Two concurrent inserts read the same committed max(); one got 23505.
--   3. lpad('1000', 3, '0') = '100', so the 1000th PO collided with PO-100 and
--      every later insert failed too (max() never got past 999).
--   4. Deleting the highest PO let its number be issued again.
--
-- Fix: one global bigint sequence, public.purchase_orders_po_number_seq,
-- seeded past the current numeric max. The trigger takes nextval(), formats it
-- with public.format_po_number(bigint) (at least 3 digits, never truncated:
-- PO-007, PO-999, PO-1000, PO-12345), and skips any number that is already in
-- the table (an explicit 'PO-<digits>' insert ahead of the sequence), at most
-- 100 times, then raises 54000. The NULL gate on the trigger is unchanged.
-- Existing rows are not renumbered. Gaps are accepted.
--
-- SECURITY (spec 190 D-4): the trigger function is SECURITY DEFINER, owner
-- postgres, search_path pinned to public.
--   * Its only input is the sequence value. It reads no caller-supplied NEW
--     field, and its only write is NEW.po_number. The privileged exists() probe
--     is keyed on nextval() output, never on caller input, so it is not an
--     oracle. A standalone "does PO-x exist?" helper (the INVOKER alternative)
--     would have been a cross-brand oracle callable over /rpc.
--   * The probe must ignore RLS or defect 1 comes back. It does, because
--     purchase_orders has no FORCE ROW LEVEL SECURITY and postgres owns both the
--     table and the function. generate_po_number_sequence.test.sql DP-1 pins
--     both facts.
--   * anon and authenticated lose every privilege on the sequence (the spec 097
--     default privileges would otherwise grant ALL), so a caller can't
--     nextval()/setval() it to aim the skip probe or reset the counter.
--     service_role keeps the spec 097 ALL.
--   * EXECUTE on both functions is revoked from public, anon and authenticated.
--     A `returns trigger` function can't be called directly anyway (0A000), and
--     Postgres checks EXECUTE on a trigger function only at CREATE TRIGGER time,
--     so the revoke does not stop set_po_number firing. format_po_number is pure
--     and IMMUTABLE as well, so it meets both AC-15 clauses.
--   * pg_catalog is searched first when it isn't in search_path, so lpad,
--     length, greatest and nextval can't be shadowed from public. Every
--     non-catalog reference is schema-qualified.
--
-- Concurrency (AC-4): nextval() is atomic and non-transactional, never returns
-- the same value twice (NO CYCLE) and is not undone by a rollback, so two
-- concurrent inserts always get different candidates and never wait on each
-- other at the unique index. CACHE 1 keeps numbers in call order across
-- sessions. Residual, out of scope: an UNCOMMITTED explicit insert of exactly
-- the next number is invisible to the probe and costs one 23505.
--
-- No publication change, so NO `docker restart supabase_realtime_imr-inventory`
-- step. Sequences are not publishable; purchase_orders inserts publish as before.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): only after the owner's explicit
-- go-ahead. Follow "Prod apply" and "D-9. Prod apply additions" in
-- specs/190-po-number-sequence.md, which has the exact queries:
--   1. Read-only pre-checks: current_user = postgres; the sequence and
--      format_po_number(bigint) don't exist yet (to_regclass/to_regprocedure
--      null); version '20261109140000' is not in
--      supabase_migrations.schema_migrations; PO count/max; function owner =
--      postgres; relforcerowsecurity = false; purchase_orders owner = function
--      owner or that owner has rolbypassrls (the DP-1 query).
--   2. execute_sql this body via the Supabase MCP BEFORE pushing (never
--      apply_migration, which writes its own version).
--   3. INSERT the exact version '20261109140000' into
--      supabase_migrations.schema_migrations. Optionally paste that INSERT just
--      before the final commit; in the text sent to execute_sql, so the body and
--      its version row commit together (a runbook step; this file's SQL is
--      unchanged).
--   4. Verify without inserting a PO: last_value = the pre-check max and
--      is_called = true (19 / true as of 2026-11-09, next PO-020). A higher
--      last_value is fine only if every extra number belongs to a PO created
--      after the apply; in every case last_value + 1 must exceed the current
--      numeric max. Also: pg_get_serial_sequence finds the sequence, its owner
--      is postgres, normalized md5 of both functions matches local,
--      proconfig/prosecdef/owner as designed, and has_function_privilege /
--      has_sequence_privilege are false for anon, authenticated AND public on
--      both functions and the sequence (a string check on proacl/relacl for
--      anon= / authenticated= would miss a PUBLIC grant, written =X/...).
--
-- ROLLBACK (forward-only by convention, spec D-10): re-run the
-- 20260819000000_generate_po_number_malformed_guard.sql body. CREATE OR REPLACE
-- without a SECURITY clause resets the function to INVOKER; the EXECUTE revoke
-- stays, which is harmless. Optionally drop the sequence. Rollback is safe ONLY
-- while every po_number is below 1000: the old max() body then continues from
-- the highest number the sequence issued. Once any PO-1000 or higher exists, the
-- old lpad(n, 3) body collides on every insert, so rolling back would restore a
-- permanent outage. Rolling back brings all four defects back either way.
--
-- Tests: supabase/tests/generate_po_number_sequence.test.sql,
--        supabase/tests/generate_po_number_malformed_guard.test.sql,
--        scripts/smoke-po-number-concurrency.sh
-- ============================================================

begin;

set local lock_timeout = '5s';

-- ─── (1) Hold off inserts between reading the max and setval ───────────────
-- SHARE ROW EXCLUSIVE conflicts with ROW EXCLUSIVE, so no PO can land between
-- the seed's max() and its setval(). The skip loop would cover that race anyway;
-- the lock makes the seeded value deterministic.
lock table public.purchase_orders in share row exclusive mode;

-- ─── (2) The sequence ──────────────────────────────────────────────────────
-- Plain CREATE (no IF NOT EXISTS) so a re-apply fails loudly instead of
-- silently re-seeding. CACHE must stay 1: a larger cache hands each session its
-- own block and numbers from different sessions come out of order.
create sequence public.purchase_orders_po_number_seq
  as bigint
  increment by 1
  minvalue 1
  no maxvalue
  start with 1
  cache 1
  no cycle
  owned by public.purchase_orders.po_number;

-- ─── (3) Mandatory: undo the spec 097 default ALL for client roles ─────────
revoke all on sequence public.purchase_orders_po_number_seq from public, anon, authenticated;

-- ─── (4) Seed past the current numeric max ─────────────────────────────────
-- Same anchored regex as the old body, so malformed rows ('PO-SAMS-PASS-1',
-- 'LEGACY-99') are ignored. Cast through numeric so a long hand-typed number
-- can't raise 22003 partway through max(); if the max doesn't fit bigint, the
-- ::bigint below fails and the whole migration rolls back. Runs as the
-- migration role, so RLS does not apply.
do $$
declare
  v_max numeric;
begin
  select coalesce(max((substring(po_number from '^PO-([0-9]+)$'))::numeric), 0)
    into v_max
    from public.purchase_orders;

  if v_max >= 1 then
    -- next = max + 1 (prod 2026-11-09: last_value 19, is_called true -> PO-020)
    perform setval('public.purchase_orders_po_number_seq', v_max::bigint, true);
  else
    -- empty table, or only 'PO-000': next = 1 -> PO-001
    perform setval('public.purchase_orders_po_number_seq', 1, false);
  end if;
end $$;

-- ─── (5) The formatter ─────────────────────────────────────────────────────
-- At least 3 digits, never truncated: 7 -> PO-007, 999 -> PO-999,
-- 1000 -> PO-1000, 12345 -> PO-12345. MINVALUE 1 rules out negative input.
create function public.format_po_number(n bigint)
returns text
language sql
immutable
strict
parallel safe
set search_path = public
as $$
  select 'PO-' || lpad(n::text, greatest(3, length(n::text)), '0')
$$;

-- ─── (6) Mandatory: spec 097 grants ALL on future functions ────────────────
revoke execute on function public.format_po_number(bigint) from public, anon, authenticated;

-- ─── (7) The trigger function ──────────────────────────────────────────────
-- SECURITY DEFINER so nextval() needs no client grant and the exists() probe
-- sees every row regardless of RLS (see the header). The probe sees committed
-- rows and this transaction's own rows, through purchase_orders_po_number_key.
create or replace function public.generate_po_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n         bigint;
  v_candidate text;
  v_attempts  int := 0;
begin
  loop
    v_n         := nextval('public.purchase_orders_po_number_seq');
    v_candidate := public.format_po_number(v_n);
    exit when not exists (
      select 1 from public.purchase_orders where po_number = v_candidate
    );
    v_attempts := v_attempts + 1;
    if v_attempts >= 100 then
      raise exception 'generate_po_number: no free PO number after 100 attempts (last tried %)', v_candidate
        using errcode = '54000',
              hint = 'Rows with explicit po_number values occupy this range. Move public.purchase_orders_po_number_seq past them with setval().';
    end if;
  end loop;

  new.po_number := v_candidate;
  return new;
end;
$$;

-- ─── (8) Defense in depth: a trigger function is never called directly ─────
revoke execute on function public.generate_po_number() from public, anon, authenticated;

-- ─── (9) Comments ──────────────────────────────────────────────────────────
comment on sequence public.purchase_orders_po_number_seq is
  'spec 190: global counter behind public.generate_po_number(). Seeded past the highest ''PO-<digits>'' po_number. CACHE must stay 1 (numbers stay in call order across sessions). No privileges for anon/authenticated; only the SECURITY DEFINER trigger uses it. OWNED BY purchase_orders.po_number, so TRUNCATE public.purchase_orders RESTART IDENTITY would reset it to 1 and reissue old numbers: do not do that. Never setval() it below the highest numeric po_number.';

comment on function public.format_po_number(bigint) is
  'spec 190: formats a PO counter value as ''PO-'' plus at least 3 digits, never truncated (PO-007, PO-999, PO-1000, PO-12345). Pure and IMMUTABLE. EXECUTE revoked from public, anon and authenticated.';

comment on function public.generate_po_number() is
  'spec 190: BEFORE INSERT trigger (set_po_number, WHEN new.po_number IS NULL). Takes nextval(public.purchase_orders_po_number_seq), skips numbers already in purchase_orders (at most 100 tries, then 54000). Must stay SECURITY DEFINER, owned by the table owner, with purchase_orders not FORCE RLS: the skip probe has to see every row regardless of RLS (otherwise a caller who cannot see the top PO gets 23505 again), and nextval() runs without any client grant on the sequence.';

commit;

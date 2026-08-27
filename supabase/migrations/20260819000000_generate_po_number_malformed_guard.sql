-- supabase/migrations/20260819000000_generate_po_number_malformed_guard.sql
--
-- Bugfix — one malformed `purchase_orders.po_number` wedged ALL PO creation.
--
-- `generate_po_number()` (init schema, 20260405000759) picks the next number by
-- blindly stripping the first three characters off EVERY existing po_number and
-- casting the remainder to int:
--
--     select coalesce(max(cast(substring(po_number from 4) as int)), 0) + 1 ...
--
-- That only holds while every row matches the 'PO-<digits>' shape the trigger
-- itself writes. The trigger fires only `when (new.po_number is null)`, so any
-- row inserted WITH an explicit po_number bypasses it and can carry any text.
-- On 2026-08-09 a hand-inserted Sam's Club draft landed as 'PO-SAMS-PASS-1';
-- from that moment `substring(...)` yielded 'SAMS-PASS-1' and the cast raised
-- SQLSTATE 22P02 (`invalid input syntax for type integer`) on EVERY subsequent
-- insert. PostgREST surfaced it as HTTP 400, so Reorder → FILL CART failed for
-- every vendor with a useless "Draft not created" toast, and no PO could be
-- created by any path for ten days.
--
-- Fix: parse the counter with an anchored regex instead of a positional
-- substring, so rows that don't match '^PO-<digits>$' contribute NULL and are
-- ignored by `max()` rather than aborting the statement. One bad row can no
-- longer take the whole table's insert path down with it. The generated format
-- is unchanged ('PO-' || 3-padded number), so no existing consumer moves.
--
-- Deliberately NOT done here: rewriting or deleting the offending row. The
-- hardened function ignores it, prod keeps its audit trail, and the next
-- generated number continues the real sequence (highest numeric is PO-015 →
-- next is PO-016).
--
-- Note for a future spec: `po_number` is UNIQUE and this counter is
-- last-writer-wins under concurrency (two simultaneous inserts can pick the
-- same next_num and one hits the unique violation). Pre-existing behaviour,
-- out of scope for this bugfix — a sequence-backed counter is the real answer.

create or replace function public.generate_po_number()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  next_num int;
begin
  -- Anchored capture: non-conforming po_numbers yield NULL and drop out of
  -- max() instead of raising 22P02 the way the old cast(substring(...)) did.
  select coalesce(max(substring(po_number from '^PO-([0-9]+)$')::int), 0) + 1
  into next_num
  from purchase_orders;

  new.po_number = 'PO-' || lpad(next_num::text, 3, '0');
  return new;
end;
$$;

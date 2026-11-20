-- ============================================================
-- Spec 196 - purchase_orders.po_number is server-assigned for API callers.
--
-- Closes the Medium in specs/190-po-number-sequence/reviews/security-auditor.md.
-- After spec 190, numbers come from one global sequence and the trigger skips
-- taken numbers at most 100 times, then raises 54000. A store member could
-- still bulk-insert (or UPDATE their own POs onto) explicit numbers just ahead
-- of the sequence and make the next generated inserts in EVERY brand fail with
-- 54000. No client has a reason to supply or change po_number, so this closes
-- the route.
--
-- public.purchase_orders_po_number_guard() + trigger
-- purchase_orders_po_number_guard_trg (BEFORE INSERT OR UPDATE, FOR EACH ROW,
-- no column list, no WHEN). When current_user is anon or authenticated (every
-- PostgREST caller: admin Cmd UI, staff app, Chrome extension, an edge function
-- forwarding a user JWT; the app role does not matter, super_admins included):
--   * INSERT with a non-NULL po_number is refused. NULL / omitted is allowed and
--     set_po_number assigns the number exactly as spec 190 defines.
--   * UPDATE where new.po_number IS DISTINCT FROM old.po_number is refused (a
--     change to or from NULL counts). An echo of the same value passes, so
--     status-only and total-only updates keep working.
-- Refusal: SQLSTATE P0001, message exactly 'po_number is server-assigned', no
-- DETAIL, no HINT (CLAUDE.md refusal-string convention; PostgREST -> HTTP 400).
-- postgres and service_role (migrations, pg_cron, SQL editor, MCP, pgTAP
-- fixtures, service-role edge functions) keep explicit numbers on INSERT and
-- UPDATE. The test is the effective role only; the guard reads no JWT claims
-- (deliberately NOT spec 194's claims-aware rule).
--
-- SECURITY INVOKER IS LOAD-BEARING. Inside a SECURITY DEFINER function
-- current_user is the owner (postgres), so the role test would let every caller
-- through. The function must stay INVOKER. It calls no function, reads no table
-- and reads no GUC, so there is nothing a client would need EXECUTE on.
--
-- TRIGGER NAME ORDER IS LOAD-BEARING. BEFORE triggers fire in name order (C
-- collation) and each sees NEW as returned by the one before. set_po_number
-- fills NEW.po_number when it is NULL, so a guard sorting after it would refuse
-- every generated insert. 'purchase_orders_po_number_guard_trg' < 'set_po_number'
-- ('p' < 's'). On UPDATE the guard fires after the spec 177/194 BEFORE UPDATE
-- triggers (lock_created_at, lock_store_id, no_return_to_draft), so an update
-- that breaks one of those rules too reports their 42501 instead.
--
-- Accepted residual (owner, 2026-11-09): a statement inside a postgres-owned
-- SECURITY DEFINER RPC runs as postgres and passes. No such RPC writes
-- po_number today; a future one must be reviewed against this rule.
--
-- Additive in schema terms (one function, one trigger, comments, one EXECUTE
-- revoke), restrictive in behaviour. No table, column, index, policy, grant,
-- data or publication change, so NO `docker restart
-- supabase_realtime_imr-inventory` step.
--
-- Requires spec 190 (20261109140000_po_number_sequence) first: the DO block
-- below refuses to apply otherwise (AC-20 ordering on the MCP route).
--
-- PROD-APPLY (spec 064 gate, project MEMORY): only with the owner's explicit
-- go-ahead, after spec 190's apply. Follow D-11 in
-- specs/196-po-number-server-assigned.md: read-only pre-checks, execute_sql
-- this file VERBATIM via the Supabase MCP BEFORE pushing (never apply_migration,
-- never a pg_get_functiondef dump: it has no CREATE TRIGGER, revoke or
-- comments), INSERT the exact version '20261109200000' into
-- supabase_migrations.schema_migrations, then verify normalized md5, prosecdef,
-- proconfig, owner, proacl and the trigger listing against local. No PO row is
-- written to verify.
--
-- ROLLBACK (D-12, owner decision: it reopens spec 190's Medium):
--   drop trigger if exists purchase_orders_po_number_guard_trg on public.purchase_orders;
--   drop function if exists public.purchase_orders_po_number_guard();
--
-- Tests: supabase/tests/po_number_server_assigned.test.sql
-- ============================================================

begin;

set local lock_timeout = '5s';

-- ─── dependency guard: spec 190 must be applied first ─────────
do $$
begin
  if to_regprocedure('public.format_po_number(bigint)') is null
     or to_regclass('public.purchase_orders_po_number_seq') is null then
    raise exception 'spec 196 requires spec 190 (20261109140000) to be applied first';
  end if;
end $$;

-- ─── guard function ───────────────────────────────────────────
create or replace function public.purchase_orders_po_number_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Wiring check, fail closed (spec 194 "bad trigger argument" precedent). A
  -- BEFORE DELETE attachment would return NEW (NULL) and silently skip deletes;
  -- a STATEMENT-level attachment has no NEW.
  if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_op not in ('INSERT', 'UPDATE') then
    raise exception 'purchase_orders_po_number_guard: bad trigger wiring'
      using errcode = 'P0001';
  end if;

  -- Owner paths: anything that is not a PostgREST client role (postgres,
  -- service_role, pg_cron, migrations, SQL editor, MCP).
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  -- Client roles.
  if tg_op = 'INSERT' then
    if new.po_number is not null then
      raise exception 'po_number is server-assigned' using errcode = 'P0001';
    end if;
  elsif new.po_number is distinct from old.po_number then
    raise exception 'po_number is server-assigned' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.purchase_orders_po_number_guard()
  from public, anon, authenticated;

comment on function public.purchase_orders_po_number_guard() is
  'spec 196: BEFORE INSERT OR UPDATE row guard on purchase_orders.po_number. '
  'When current_user is anon or authenticated (every PostgREST caller, any app '
  'role, super_admin included), an INSERT with a non-NULL po_number or an UPDATE '
  'that changes it (IS DISTINCT FROM, NULL counts) raises P0001 '
  '''po_number is server-assigned''. NULL/omitted on INSERT and a same-value '
  'echo on UPDATE pass. postgres and service_role keep explicit numbers. Must '
  'stay SECURITY INVOKER: inside a DEFINER function current_user is the owner '
  'and every caller would pass. Reads no claims, calls no functions, reads no '
  'tables. The trigger name must sort before set_po_number (C collation). A '
  'postgres-owned SECURITY DEFINER RPC runs as postgres and passes (accepted '
  'residual): a future RPC that writes po_number must be reviewed against this '
  'rule. A future column DEFAULT on po_number would make every client insert be '
  'refused and needs a guard change. Wrong wiring raises P0001 '
  '''purchase_orders_po_number_guard: bad trigger wiring''.';

-- ─── trigger ──────────────────────────────────────────────────
drop trigger if exists purchase_orders_po_number_guard_trg on public.purchase_orders;
create trigger purchase_orders_po_number_guard_trg
  before insert or update on public.purchase_orders
  for each row
  execute function public.purchase_orders_po_number_guard();

comment on trigger purchase_orders_po_number_guard_trg on public.purchase_orders is
  'spec 196: refuses a client-supplied or changed po_number (P0001 '
  '''po_number is server-assigned'') for anon/authenticated. Name must sort '
  'before set_po_number (C collation). BEFORE triggers fire in name order and '
  'set_po_number fills NEW.po_number, so a guard sorting after it refuses every '
  'generated insert. Pinned by po_number_server_assigned.test.sql.';

commit;

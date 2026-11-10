-- ============================================================
-- Spec 194 - kept-records delete hardening (closes spec 186 audit M1 and M2).
--
-- (1) public.kept_record_lock_date() + three BEFORE UPDATE OF <col> triggers.
--     purchase_orders.created_at, waste_log.logged_at and pos_imports.imported_at
--     cannot be changed by a non-privileged user JWT (42501
--     '<table>: <col> is immutable'). Privileged callers (auth_is_privileged():
--     admin, master, super_admin) and server contexts (current_user is not
--     anon/authenticated AND the JWT claims role is empty or service_role:
--     postgres, pg_cron, migrations, psql, the service-role key) may. A staff
--     caller inside a postgres-owned SECURITY DEFINER function is still refused,
--     because its claims role stays 'authenticated'. A pass-through SET of the
--     same value is allowed for everyone. INSERT is unchanged.
-- (2) public.purchase_orders_block_return_to_draft() + trigger. No caller,
--     postgres included, can move a PO into 'draft' from any other status
--     (42501 'purchase_orders: status cannot return to draft'). draft -> draft
--     passes.
-- (3) public.po_items_lock_po_id() and public.pos_import_items_lock_import_id()
--     + triggers. A line cannot move to another parent, for any caller
--     (42501 'po_items: po_id is immutable',
--     'pos_import_items: import_id is immutable'). Same value passes.
--     po_items_check_store_trg sorts before po_items_lock_po_id_trg (C
--     collation), so a cross-store po_id move keeps spec 177's message.
-- (4) Two RESTRICTIVE DELETE policies. po_items lines are deletable only while
--     the parent PO is 'draft'; pos_import_items lines are never deletable
--     directly. Both bind every JWT role and give 0 rows, no error. postgres and
--     service_role bypass RLS, and FK cascades (PO rollback, import delete inside
--     spec 186's 1-day window, store and brand delete) are unaffected.
-- (5) Spec 186's three RESTRICTIVE DELETE policy comments are rewritten: the
--     "Not a security boundary" sentence is replaced. Their expressions are
--     unchanged. This fails with 42704 if 20261108120000_retention_prune_job has
--     not been applied first; that is the intended guard.
--
-- Everything is additive in schema terms (4 functions, 6 triggers, 2 policies,
-- 3 comment rewrites) but behaviour-restrictive. No table, column, index or data
-- change. No publication change, so NO `docker restart
-- supabase_realtime_imr-inventory` step.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): follow D-11 in
-- specs/194-kept-records-delete-hardening.md, and only with the owner's
-- go-ahead. Run the AC-34 read-only pre-check, execute_sql this body via the
-- Supabase MCP BEFORE pushing, INSERT the exact version '20261109170000' into
-- supabase_migrations.schema_migrations, and VERIFY the four functions by
-- NORMALIZED-MD5 plus prosecdef, proconfig, owner and proacl against local.
--
-- ROLLBACK: hand-written SQL in the spec's implementation notes, not a
-- migration. It reopens M1 and M2, so it needs an owner decision. Do NOT drop
-- spec 186's policies as part of it.
--
-- Tests: supabase/tests/kept_records_delete_hardening.test.sql
-- ============================================================

begin;

set local lock_timeout = '5s';

-- ─── (1) the three date columns ────────────────────────────────
create or replace function public.kept_record_lock_date()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_claims_role text;
begin
  -- Misconfiguration (missing or unknown column argument): fail closed.
  if tg_nargs <> 1 or not (to_jsonb(new) ? tg_argv[0]) then
    raise exception 'kept_record_lock_date: bad trigger argument'
      using errcode = 'P0001';
  end if;

  -- Pass-through SET of the same value (NULL compares as JSON null, so a change
  -- to or from NULL is a change).
  if (to_jsonb(new) -> tg_argv[0]) is not distinct from (to_jsonb(old) -> tg_argv[0]) then
    return new;
  end if;

  -- Server context: not running directly under a PostgREST client role, and no
  -- user JWT on the request. Read the claims GUCs directly so the service role
  -- does not need EXECUTE on auth.*. Malformed claims JSON raises 22P02 (fails
  -- closed).
  v_claims_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    '');
  if current_user not in ('anon', 'authenticated')
     and v_claims_role in ('', 'service_role') then
    return new;
  end if;

  if public.auth_is_privileged() then
    return new;
  end if;

  raise exception '%: % is immutable', tg_table_name, tg_argv[0]
    using errcode = '42501';
end;
$$;

comment on function public.kept_record_lock_date() is
  'spec 194 (R1): BEFORE UPDATE OF <col> on purchase_orders.created_at, '
  'waste_log.logged_at and pos_imports.imported_at; TG_ARGV[0] is the column. '
  'A change raises 42501 ''<table>: <col> is immutable'' unless the caller is '
  'privileged (auth_is_privileged(): admin, master, super_admin) or a server '
  'context: current_user is not anon/authenticated AND the JWT claims role is '
  'empty or service_role (postgres, pg_cron, migrations, psql, service-role '
  'key). A staff caller inside a postgres-owned SECURITY DEFINER function keeps '
  'claims role authenticated, so is refused. A pass-through SET of the same '
  'value is allowed. A bad trigger argument raises P0001 (fail closed). Tests '
  'that reset role without clearing request.jwt.claims are treated as the last '
  'impersonated user. SECURITY INVOKER.';

revoke execute on function public.kept_record_lock_date()
  from public, anon, authenticated;

drop trigger if exists purchase_orders_lock_created_at_trg on public.purchase_orders;
create trigger purchase_orders_lock_created_at_trg
  before update of created_at on public.purchase_orders
  for each row
  execute function public.kept_record_lock_date('created_at');

drop trigger if exists waste_log_lock_logged_at_trg on public.waste_log;
create trigger waste_log_lock_logged_at_trg
  before update of logged_at on public.waste_log
  for each row
  execute function public.kept_record_lock_date('logged_at');

drop trigger if exists pos_imports_lock_imported_at_trg on public.pos_imports;
create trigger pos_imports_lock_imported_at_trg
  before update of imported_at on public.pos_imports
  for each row
  execute function public.kept_record_lock_date('imported_at');


-- ─── (2) a PO cannot move back into draft ──────────────────────
create or replace function public.purchase_orders_block_return_to_draft()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.status = 'draft' and old.status is distinct from 'draft' then
    raise exception 'purchase_orders: status cannot return to draft'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.purchase_orders_block_return_to_draft() is
  'spec 194 (R4): BEFORE UPDATE OF status on public.purchase_orders. Moving a '
  'PO into draft from any other status (or NULL) raises 42501 '
  '''purchase_orders: status cannot return to draft'', for every caller, '
  'postgres included. draft -> draft passes. Closes the "set received back to '
  'draft, then delete its lines" route round po_items_restrict_delete_non_draft. '
  'SECURITY INVOKER.';

revoke execute on function public.purchase_orders_block_return_to_draft()
  from public, anon, authenticated;

drop trigger if exists purchase_orders_no_return_to_draft_trg on public.purchase_orders;
create trigger purchase_orders_no_return_to_draft_trg
  before update of status on public.purchase_orders
  for each row
  execute function public.purchase_orders_block_return_to_draft();


-- ─── (3) lines cannot move to another parent ───────────────────
create or replace function public.po_items_lock_po_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.po_id is distinct from old.po_id then
    raise exception 'po_items: po_id is immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.po_items_lock_po_id() is
  'spec 194 (R4): BEFORE UPDATE OF po_id on public.po_items. po_id is always '
  'immutable on UPDATE, for every caller; a change raises 42501 '
  '''po_items: po_id is immutable''. A pass-through SET of the same value '
  'passes. po_items_check_store_trg fires first (name order), so a cross-store '
  'move keeps spec 177''s message. SECURITY INVOKER.';

revoke execute on function public.po_items_lock_po_id()
  from public, anon, authenticated;

drop trigger if exists po_items_lock_po_id_trg on public.po_items;
create trigger po_items_lock_po_id_trg
  before update of po_id on public.po_items
  for each row
  execute function public.po_items_lock_po_id();

create or replace function public.pos_import_items_lock_import_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.import_id is distinct from old.import_id then
    raise exception 'pos_import_items: import_id is immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.pos_import_items_lock_import_id() is
  'spec 194 (R4): BEFORE UPDATE OF import_id on public.pos_import_items. '
  'import_id is always immutable on UPDATE, for every caller; a change raises '
  '42501 ''pos_import_items: import_id is immutable''. A pass-through SET of '
  'the same value passes. SECURITY INVOKER.';

revoke execute on function public.pos_import_items_lock_import_id()
  from public, anon, authenticated;

drop trigger if exists pos_import_items_lock_import_id_trg on public.pos_import_items;
create trigger pos_import_items_lock_import_id_trg
  before update of import_id on public.pos_import_items
  for each row
  execute function public.pos_import_items_lock_import_id();


-- ─── (4) line deletes ──────────────────────────────────────────
drop policy if exists "po_items_restrict_delete_non_draft" on public.po_items;

create policy "po_items_restrict_delete_non_draft"
  on public.po_items
  as restrictive
  for delete
  using (exists (
    select 1 from public.purchase_orders po
     where po.id = po_items.po_id
       and po.status = 'draft'));

comment on policy "po_items_restrict_delete_non_draft" on public.po_items is
  'spec 194: RESTRICTIVE. A direct delete of a po_items line is admitted only while its parent PO is draft (any age); lines under sent, partial, received or cancelled POs are refused for every JWT role, admins included (0 rows, no error). The EXISTS runs under the caller''s RLS on purchase_orders, so a parent the caller cannot see counts as not a draft. Scope still comes from store_member_delete_po_items. postgres and service_role bypass RLS, and FK cascades (PO rollback, store and brand delete) are unaffected. The client turns 0 rows into an error in db.deletePoItem. Loosening this reopens spec 186 audit M2, so it needs an owner decision.';

drop policy if exists "pos_import_items_restrict_delete" on public.pos_import_items;

create policy "pos_import_items_restrict_delete"
  on public.pos_import_items
  as restrictive
  for delete
  using (false);

comment on policy "pos_import_items_restrict_delete" on public.pos_import_items is
  'spec 194: RESTRICTIVE. A direct delete of a pos_import_items line is refused for every JWT role at any age (0 rows, no error). A wrong import is removed whole by deleting the pos_imports row inside spec 186''s 1-day window, and the import_id FK cascade takes its lines; store and brand deletes cascade too. postgres and service_role bypass RLS. Loosening this reopens spec 186 audit M2, so it needs an owner decision.';


-- ─── (5) spec 186's three policy comments ──────────────────────
comment on policy "purchase_orders_restrict_delete_aged" on public.purchase_orders is
  'spec 186: RESTRICTIVE. Refuses direct deletes once a row is 1 day old by the server clock (0 rows, no error), so clients still running the removed client purge cannot delete kept records. PO rollback deletes a row seconds old and is admitted. A NULL created_at is refused. FK cascades from stores bypass RLS. Since spec 194 (kept-records delete hardening), staff cannot change created_at (trigger purchase_orders_lock_created_at_trg, 42501), so they cannot re-date a row into this window. Privileged callers (admin, master, super_admin) still can, then delete it inside the window; the owner accepted that residual on 2026-11-09. Dropping this policy restores age-based deletion by stale clients, so it needs an owner decision.';

comment on policy "waste_log_restrict_delete_aged" on public.waste_log is
  'spec 186: RESTRICTIVE. Refuses direct deletes once a row is 1 day old by the server clock (0 rows, no error), so clients still running the removed client purge cannot delete kept records. FK cascades from stores bypass RLS, so store deletion still removes aged rows. A NULL logged_at is refused. Since spec 194 (kept-records delete hardening), staff cannot change logged_at (trigger waste_log_lock_logged_at_trg, 42501), so they cannot re-date a row into this window. Privileged callers (admin, master, super_admin) still can, then delete it inside the window; the owner accepted that residual on 2026-11-09. Dropping this policy restores age-based deletion by stale clients, so it needs an owner decision.';

comment on policy "pos_imports_restrict_delete_aged" on public.pos_imports is
  'spec 186: RESTRICTIVE. Refuses direct deletes once a row is 1 day old by the server clock (0 rows, no error), so clients still running the removed client purge cannot delete kept records. A NULL imported_at is refused. FK cascades from stores bypass RLS. Since spec 194 (kept-records delete hardening), staff cannot change imported_at (trigger pos_imports_lock_imported_at_trg, 42501), so they cannot re-date a row into this window. Privileged callers (admin, master, super_admin) still can, then delete it inside the window; the owner accepted that residual on 2026-11-09. Dropping this policy restores age-based deletion by stale clients, so it needs an owner decision.';

commit;

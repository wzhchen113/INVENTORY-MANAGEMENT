-- ============================================================
-- Spec 186 - keep business records; prune audit_log and expired invitations
-- with a nightly server job instead of a client purge.
--
-- (1) public.prune_audit_log_and_invitations() + pg_cron job
--     prune-audit-log-and-invitations, 47 8 * * * UTC. Prunes audit_log past 90
--     days (all stores, plus store-less rows, superseding spec 170 N2) and
--     invitations that are expired and unused. It names no other table.
-- (2) Three RESTRICTIVE DELETE policies refuse direct deletes of
--     purchase_orders, waste_log and pos_imports rows once they are 1 day old by
--     the server clock. Clients still running the removed client purge get 0
--     rows and no error. The margin is 89 days: on a device clock up to 89 days
--     fast, every row the old purge targets is refused. FK cascades bypass RLS,
--     so store and brand deletes are unaffected. db.deleteStore's own waste_log
--     delete is now refused on rows over a day old; store deletion removes
--     those rows through the stores FK cascade, and the spec 186 probe found no
--     23503 on waste_log_item_id_fkey in either RI firing order.
-- (3) admin_delete_audit_log stays; only its comment changes.
--
-- Everything is additive: no table, column or index change. No publication
-- change, so NO `docker restart supabase_realtime_imr-inventory` step.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): follow "Prod apply" and "Prod apply
-- additions" in specs/186-retention-purge-server-job.md. execute_sql this body
-- via the Supabase MCP BEFORE pushing, INSERT the exact version '20261108120000'
-- into supabase_migrations.schema_migrations, and VERIFY the function by
-- NORMALIZED-MD5 against local.
--
-- ROLLBACK: do NOT drop a restrictive policy to roll back. That lets stale
-- clients resume deleting those tables past 90 days (see spec 186 "Rollback").
--
-- Tests: supabase/tests/retention_prune_job.test.sql
-- ============================================================

begin;

-- ─── (1) the prune ─────────────────────────────────────────────
create or replace function public.prune_audit_log_and_invitations()
returns table (audit_log_deleted integer, invitations_deleted integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- NULL created_at, used or expires_at never match, so age-unknown rows stay.
  delete from public.audit_log
   where created_at < now() - interval '90 days';
  get diagnostics audit_log_deleted = row_count;

  delete from public.invitations
   where used = false
     and expires_at < now();
  get diagnostics invitations_deleted = row_count;

  return next;
end;
$$;

comment on function public.prune_audit_log_and_invitations() is
  'spec 186: nightly retention prune. Deletes audit_log rows past 90 days across all brands and stores, store-less rows included, and invitations that are expired and unused. Returns both counts. Names no other table: EOD, PO, waste and POS records are kept by owner decision (2026-11-08). Run by pg_cron job prune-audit-log-and-invitations; no client role can execute it.';

revoke execute on function public.prune_audit_log_and_invitations()
  from public, anon, authenticated, service_role;
grant  execute on function public.prune_audit_log_and_invitations()
  to postgres;

-- 08:47 UTC shares no minute with an existing job. The `if exists … unschedule`
-- block makes the migration safe to re-apply (same shape as 20260607130000).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'prune-audit-log-and-invitations') then
    perform cron.unschedule('prune-audit-log-and-invitations');
  end if;

  perform cron.schedule(
    'prune-audit-log-and-invitations',
    '47 8 * * *',
    'select * from public.prune_audit_log_and_invitations();'
  );
end $$;

-- ─── (2) refuse direct deletes of kept records past 1 day ──────
drop policy if exists "purchase_orders_restrict_delete_aged" on public.purchase_orders;

create policy "purchase_orders_restrict_delete_aged"
  on public.purchase_orders
  as restrictive
  for delete
  using (created_at >= now() - interval '1 day');

comment on policy "purchase_orders_restrict_delete_aged" on public.purchase_orders is
  'spec 186: RESTRICTIVE. Refuses direct deletes once a row is 1 day old by the server clock (0 rows, no error), so clients still running the removed client purge cannot delete kept records. PO rollback deletes a row seconds old and is admitted. A NULL created_at is refused. FK cascades from stores bypass RLS. Not a security boundary: store_member_update_* still lets a member change the date. Dropping this policy restores age-based deletion by stale clients, so it needs an owner decision.';

drop policy if exists "waste_log_restrict_delete_aged" on public.waste_log;

create policy "waste_log_restrict_delete_aged"
  on public.waste_log
  as restrictive
  for delete
  using (logged_at >= now() - interval '1 day');

comment on policy "waste_log_restrict_delete_aged" on public.waste_log is
  'spec 186: RESTRICTIVE. Refuses direct deletes once a row is 1 day old by the server clock (0 rows, no error), so clients still running the removed client purge cannot delete kept records. FK cascades from stores bypass RLS, so store deletion still removes aged rows. A NULL logged_at is refused. Not a security boundary: store_member_update_* still lets a member change the date. Dropping this policy restores age-based deletion by stale clients, so it needs an owner decision.';

drop policy if exists "pos_imports_restrict_delete_aged" on public.pos_imports;

create policy "pos_imports_restrict_delete_aged"
  on public.pos_imports
  as restrictive
  for delete
  using (imported_at >= now() - interval '1 day');

comment on policy "pos_imports_restrict_delete_aged" on public.pos_imports is
  'spec 186: RESTRICTIVE. Refuses direct deletes once a row is 1 day old by the server clock (0 rows, no error), so clients still running the removed client purge cannot delete kept records. A NULL imported_at is refused. FK cascades from stores bypass RLS. Not a security boundary: store_member_update_* still lets a member change the date. Dropping this policy restores age-based deletion by stale clients, so it needs an owner decision.';

-- ─── (3) admin_delete_audit_log: comment only ──────────────────
-- Keeps the `spec 170: ` prefix: audit_log_rls_hardening arm S-6 counts it.
comment on policy "admin_delete_audit_log" on public.audit_log is
  'spec 170: PERMISSIVE, replaces spec 157''s unscoped policy (closes spec 157 OQ-3 / FUTURE-1 and the erase half of M3). Revised by spec 186. Rows younger than 90 days are not API-deletable by anyone. Older rows are deletable by privileged callers within auth_can_see_store(store_id), and store-less rows by super_admin only. The nightly job prune-audit-log-and-invitations (spec 186) is now the retention path and covers store-less rows, superseding spec 170 N2. New builds have no caller of this policy; clients still running the removed client purge reach it, with no end date, and get no visible error. The job''s 90 days and this policy''s 90 days are independent. Store/brand deletion relies on the audit_log.store_id FK cascade, which bypasses RLS. Client/server clock skew at the boundary is harmless for audit_log (N3). Do not loosen.';

commit;

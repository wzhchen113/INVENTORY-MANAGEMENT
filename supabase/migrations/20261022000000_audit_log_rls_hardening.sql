-- ============================================================
-- Spec 170 — audit_log RLS hardening (visibility + integrity).
--
-- Closes spec 167 security-auditor M2 (staff can read the
-- store-user audit rows, which carry the target login username in
-- item_ref) and M3 (audit rows can be forged / edited / erased
-- through the API), plus spec 157 OQ-3 / FUTURE-1 (the
-- admin_update/delete_audit_log policies had no store or brand
-- scope).
--
-- Shape (owner-approved, spec 170 "Open questions resolved"):
--   (a) RESTRICTIVE SELECT: the 'Store user created' /
--       'Store user password set' rows are readable only by
--       auth_is_privileged() callers (spec 095 anti-enumeration).
--   (b) RESTRICTIVE INSERT: the four server-only actions
--       ('Store user created', 'Store user password set',
--       'Order missed', 'catalog_copy') can never be inserted
--       under caller RLS.
--   (c) RESTRICTIVE INSERT: non-privileged callers must set
--       user_id = auth.uid(). Privileged callers are exempt for the
--       admin EOD on-behalf path.
--   (d) UPDATE: admin_update_audit_log dropped. With no UPDATE
--       policy the table is default-deny for UPDATE, so audit rows
--       are immutable through the API (silent 0-row result).
--   (e) DELETE: admin_delete_audit_log replaced (same name, still
--       PERMISSIVE) with a scoped, 90-day age-gated predicate.
--       Store / brand deletion relies on the audit_log.store_id
--       ON DELETE CASCADE FK, which runs outside RLS.
--   (f) RESTRICTIVE INSERT: created_at must equal the server
--       transaction clock (created_at = now()). Owner decision 9
--       (2026-10-22, in chat) folded spec 170 security-auditor M1 in:
--       without it a staff member could forward-date or NULL-date a
--       self-attributed row so that it pins to the top of the admin
--       feed and, under (e)'s age gate, is never API-deletable. The
--       column default now() is applied before WITH CHECK, so an
--       omitted created_at passes; explicit future / past / NULL
--       values are rejected (42501). created_at stays nullable (prod's
--       NULL count was not checked; NOT NULL is a possible follow-up).
--
-- store_member_read_audit_log and store_member_insert_audit_log are
-- NOT touched (not even dropped/recreated), so they stay
-- byte-identical. No permissive policy widens; the spec 053
-- permissive-policy lint needs no allowlist change.
--
-- These are the FIRST RESTRICTIVE policies in the schema. A
-- restrictive policy ANDs with EVERY permissive policy for its
-- command: a future permissive SELECT/INSERT policy on audit_log
-- cannot bypass (a)/(b)/(c)/(f). That is the point.
--
-- No `to` clause (= PUBLIC), matching every existing audit_log
-- policy, so the restrictive layer also covers `anon`.
--
-- Why not FORCE ROW LEVEL SECURITY: every SECURITY DEFINER writer
-- (staff_submit_eod, staff_log_waste, record_missed_orders_for_day,
-- copy_catalog_rows, auto_receive_due_purchase_orders) is owned by
-- postgres, which also owns audit_log, and relies on the owner
-- bypass. FORCE RLS would make (b)/(c) refuse those writers ((f) would not: they omit created_at).
-- service_role (manage-store-user) is BYPASSRLS either way.
--
-- Realtime: audit_log is NOT in the supabase_realtime publication
-- and this migration does not touch publication membership, so no
-- `docker restart supabase_realtime_imr-inventory` ritual applies.
--
-- No grant change (spec 097 table grants stay; RLS is the inner
-- gate). No table / column / index / trigger change.
--
-- Rollback (restores the spec 157 state verbatim from
-- 20260809000000_super_admin_policy_parity.sql:199-216):
--
--   begin;
--   drop policy if exists "audit_log_restrict_select_store_user_actions" on public.audit_log;
--   drop policy if exists "audit_log_restrict_insert_server_only_actions" on public.audit_log;
--   drop policy if exists "audit_log_restrict_insert_actor_is_caller" on public.audit_log;
--   drop policy if exists "audit_log_restrict_insert_created_at_now" on public.audit_log;
--
--   drop policy if exists "admin_update_audit_log" on public.audit_log;
--
--   create policy "admin_update_audit_log"
--     on public.audit_log for update
--     using (public.auth_is_privileged())
--     with check (public.auth_is_privileged());
--
--   comment on policy "admin_update_audit_log" on public.audit_log is
--     'spec 157: widened auth_is_admin() -> auth_is_privileged() so super_admin is not silently denied (an RLS-shadowed UPDATE returns 0 rows, not an error, so db.ts reported success). KNOWN DEFERRED GAP, pre-dating this change: this policy has NO store or brand scope — any privileged caller may update any audit row in any brand. Scoping it requires co-designing cleanupOldRecords'' global unfiltered retention purge (src/lib/db.ts) and deciding who may purge store_id IS NULL rows. Own spec; see spec 157 OQ-3 / FUTURE-1.';
--
--   drop policy if exists "admin_delete_audit_log" on public.audit_log;
--
--   create policy "admin_delete_audit_log"
--     on public.audit_log for delete
--     using (public.auth_is_privileged());
--
--   comment on policy "admin_delete_audit_log" on public.audit_log is
--     'spec 157: widened auth_is_admin() -> auth_is_privileged(); see admin_update_audit_log for the identical rationale. KNOWN DEFERRED GAP, pre-dating this change: no store or brand scope. Own spec; see spec 157 OQ-3 / FUTURE-1.';
--   commit;
--
-- (A rollback is DB-only safe; no client rollback is required.)
-- ============================================================

begin;

-- ─── (a) SELECT — hide store-user audit rows from non-privileged callers ──
drop policy if exists "audit_log_restrict_select_store_user_actions" on public.audit_log;

create policy "audit_log_restrict_select_store_user_actions"
  on public.audit_log
  as restrictive
  for select
  using (
    action not in ('Store user created', 'Store user password set')
    or public.auth_is_privileged()
  );

comment on policy "audit_log_restrict_select_store_user_actions" on public.audit_log is
  'spec 170: RESTRICTIVE (ANDs with store_member_read_audit_log). Store-user rows carry the target login username in item_ref (spec 167). Hidden from non-privileged callers per spec 095 anti-enumeration. Closes spec 167 security-auditor M2.';

-- ─── (b) INSERT — server-only actions can never be written under caller RLS ──
drop policy if exists "audit_log_restrict_insert_server_only_actions" on public.audit_log;

create policy "audit_log_restrict_insert_server_only_actions"
  on public.audit_log
  as restrictive
  for insert
  with check (
    action not in ('Store user created', 'Store user password set',
                   'Order missed', 'catalog_copy')
  );

comment on policy "audit_log_restrict_insert_server_only_actions" on public.audit_log is
  'spec 170: RESTRICTIVE. These four actions are written only by SECURITY DEFINER RPCs (record_missed_orders_for_day, copy_catalog_rows) or service_role (manage-store-user), all of which bypass RLS (owner/BYPASSRLS, no FORCE RLS). Any RLS-subject insert of them is a forgery. Extend this list when ''User invite'' / ''User deleted'' move server-side. Closes the forgery half of M3.';

-- ─── (c) INSERT — non-privileged callers may only attribute rows to themselves ──
drop policy if exists "audit_log_restrict_insert_actor_is_caller" on public.audit_log;

create policy "audit_log_restrict_insert_actor_is_caller"
  on public.audit_log
  as restrictive
  for insert
  with check (
    user_id = auth.uid()
    or public.auth_is_privileged()
  );

comment on policy "audit_log_restrict_insert_actor_is_caller" on public.audit_log is
  'spec 170: RESTRICTIVE. Non-privileged callers (staff, INVOKER RPCs run by staff) must set user_id = auth.uid(). Privileged callers are exempt for the admin EOD on-behalf path (useStore submitEOD passes entry.submittedByUserId). A future INVOKER RPC that writes a user_id other than auth.uid() will fail for staff with 42501. That is intended. Make it SECURITY DEFINER instead.';

-- ─── (d) UPDATE — no policy at all → default-deny → audit rows immutable via the API ──
drop policy if exists "admin_update_audit_log" on public.audit_log;

-- ─── (e) DELETE — single PERMISSIVE policy, same name, scoped + age-gated ──
drop policy if exists "admin_delete_audit_log" on public.audit_log;

create policy "admin_delete_audit_log"
  on public.audit_log
  for delete
  using (
    public.auth_is_privileged()
    and created_at < now() - interval '90 days'
    and (
      (store_id is not null and public.auth_can_see_store(store_id))
      or (store_id is null and public.auth_is_super_admin())
    )
  );

comment on policy "admin_delete_audit_log" on public.audit_log is
  'spec 170: PERMISSIVE, replaces spec 157''s unscoped policy (closes spec 157 OQ-3 / FUTURE-1 and the erase half of M3). Rows younger than 90 days are not API-deletable by anyone. Older rows are deletable by privileged callers within auth_can_see_store(store_id), and store-less rows by super_admin only. 90 days must match cleanupOldRecords in src/lib/db.ts. Store/brand deletion relies on the audit_log.store_id FK cascade, which bypasses RLS. Admin purge silently skips store-less rows (spec 170 N2). Client/server clock skew at the boundary is harmless (N3). Do not loosen.';

-- ─── (f) INSERT — created_at is pinned to the server transaction clock ──
drop policy if exists "audit_log_restrict_insert_created_at_now" on public.audit_log;

create policy "audit_log_restrict_insert_created_at_now"
  on public.audit_log
  as restrictive
  for insert
  with check (
    created_at = now()
  );

comment on policy "audit_log_restrict_insert_created_at_now" on public.audit_log is
  'spec 170: RESTRICTIVE. created_at must equal now() (the server transaction clock). The column default now() is applied before WITH CHECK, so an omitted created_at passes; an explicit future, past, or NULL value is rejected with 42501. Without this, a store member could forward-date or NULL-date a self-attributed row so it sorts to the top of the admin feed (ORDER BY created_at DESC puts NULL first) and is never API-deletable under admin_delete_audit_log''s 90-day age gate. No RLS-subject writer sets created_at (addAuditEvent and the INVOKER PO RPCs omit it). SECURITY DEFINER RPCs, service_role, and the table owner bypass RLS and are unaffected. Owner decision 9 (2026-10-22); closes spec 170 security-auditor M1.';

commit;

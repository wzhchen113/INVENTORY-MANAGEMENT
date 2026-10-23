# Spec 170: audit_log RLS hardening (visibility + integrity)

Status: READY_FOR_REVIEW

Origin: follow-up **F1** in [specs/167-store-user-audit-trail/reviews/release-proposal.md](167-store-user-audit-trail/reviews/release-proposal.md). Closes security-auditor **M2** (staff can read store-user audit rows) and **M3** (audit rows can be forged / edited / erased) in [specs/167-store-user-audit-trail/reviews/security-auditor.md](167-store-user-audit-trail/reviews/security-auditor.md), plus the spec 157 OQ-3 / FUTURE-1 deferral (`admin_update/delete_audit_log` have no store or brand scope).

## User stories

1. As a **brand owner**, I want store staff to be unable to read the "Store user created" and "Store user password set" audit rows, so that colleagues' login usernames and password-reset events are not exposed through PostgREST (spec 095 anti-enumeration posture).
2. As a **brand owner**, I want audit rows to be trustworthy, so that a staff member cannot insert a fake row attributed to someone else, nobody can insert a fake server-only event from the client, and nobody can edit or erase a recent row through the API.
3. As an **admin**, I want the existing 90-day retention purge, store deletion, and every existing audit writer to keep working unchanged.

## Current state (verified 2026-10-22)

- Policies on `public.audit_log` ([20260809000000_super_admin_policy_parity.sql:175-216](../supabase/migrations/20260809000000_super_admin_policy_parity.sql)), all PERMISSIVE:
  - `store_member_read_audit_log` (SELECT) and `store_member_insert_audit_log` (INSERT): `(store_id is not null and auth_can_see_store(store_id)) or (store_id is null and auth_is_privileged())`.
  - `admin_update_audit_log` (UPDATE) and `admin_delete_audit_log` (DELETE): `auth_is_privileged()`, no scope.
- RLS is enabled, FORCE RLS is not. So SECURITY DEFINER functions owned by `postgres` and the `service_role` both bypass RLS.
- `audit_log.store_id → stores` is ON DELETE CASCADE ([20260510010000_brand_delete_cascade.sql](../supabase/migrations/20260510010000_brand_delete_cascade.sql)).
- `auth_can_see_store()` ([20260517040000_auth_can_see_store_brand_scope.sql:88](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql)): super_admin sees every store; admin/master see the stores in their own brand; other roles see only their `user_stores` stores.

**Writers (confirmed):**
- Client: `addAuditEvent` in [src/lib/db.ts:2836](../src/lib/db.ts), called from `useStore`. Every call site passes `userId = currentUser.id`, except the EOD path ([src/store/useStore.ts:3049](../src/store/useStore.ts)), which passes `entry.submittedByUserId`. That id can differ from the caller when an admin submits or edits a count on behalf of staff. The staff subtree never writes `audit_log` directly. No client code inserts `'Order missed'`, `'catalog_copy'`, or `'Store user …'`.
- SECURITY DEFINER RPCs (bypass RLS): `staff_submit_eod`, `staff_log_waste`, `record_missed_orders_for_day` (`'Order missed'`), `copy_catalog_rows` (`'catalog_copy'`), `auto_receive_due_purchase_orders` (`'PO auto-received'`, `user_id` NULL).
- SECURITY INVOKER RPCs (insert under the caller's RLS, staff included, with `user_id = auth.uid()`): `receive_purchase_order` (latest body in [20260707000000_staff_receiving_price_gate.sql](../supabase/migrations/20260707000000_staff_receiving_price_gate.sql); writes `'PO received'` and `'PO price change'`), and `close_short_purchase_order` / `cancel_purchase_order` ([20260704000000_po_loop.sql](../supabase/migrations/20260704000000_po_loop.sql)).
- Service role: `manage-store-user` edge function (spec 167, staged) writes `'Store user created'` and `'Store user password set'`, with `item_ref` = target username.

**Updaters:** none in the codebase.

**Deleters:**
- `cleanupOldRecords` in [src/lib/db.ts:6017](../src/lib/db.ts), called from [src/store/useStore.ts:2178](../src/store/useStore.ts). It runs a global, unfiltered `created_at < now - 90 days` delete.
- `deleteStore` in [src/lib/db.ts:185](../src/lib/db.ts). It does an explicit `delete … eq('store_id', id)`, which is redundant with the FK cascade.

## Acceptance criteria

All DB criteria are pgTAP arms in a new file `supabase/tests/audit_log_rls_hardening.test.sql`. Each arm switches the JWT and role to the named caller. "Staff" means `role='user'` with a `user_stores` grant on store S1 in brand A. "Admin" means an `app_metadata.role='admin'` JWT whose profile belongs to brand A.

**Migration shape**
- [ ] AC-1: Exactly one new migration under `supabase/migrations/`. After it applies, `pg_policies` for `public.audit_log` shows:
  - the two existing permissive SELECT and INSERT policies, byte-unchanged;
  - no UPDATE policy;
  - exactly one DELETE policy, carrying the decision-5 predicate;
  - the new RESTRICTIVE policies, `permissive = 'RESTRICTIVE'`.

  No new permissive policy is wider than what it replaces. `supabase/tests/permissive_policy_lint.test.sql` (spec 053) passes with no allowlist change.
- [ ] AC-2: Every new or changed policy has a `comment on policy` that cites spec 170.

**SELECT (closes M2)**
- [ ] AC-3: Staff on S1 gets 0 rows from `select … from audit_log where store_id = S1 and action in ('Store user created','Store user password set')`. Seeded fixture rows of both actions exist.
- [ ] AC-4: Staff on S1 can still read other S1 rows, such as `'PO received'` and `'EOD entry'` (count > 0).
- [ ] AC-5: Admin (brand A) and super_admin can each read both store-user actions on S1.

**INSERT (closes the forgery half of M3)**
- [ ] AC-6: Staff on S1 inserting a row with `user_id` ≠ `auth.uid()` (another profile, or NULL) is rejected with SQLSTATE `42501`.
- [ ] AC-7: Staff on S1 inserting with `user_id = auth.uid()` and an ordinary action (for example `'Waste log'`) succeeds.
- [ ] AC-8: Staff, admin, and super_admin are each rejected with `42501` for each of the four server-only actions: `'Store user created'`, `'Store user password set'`, `'Order missed'`, `'catalog_copy'`.
- [ ] AC-9: Admin inserting an ordinary action on S1 with `user_id` set to a staff profile id (the EOD on-behalf path) succeeds.
- [ ] AC-10: These calls still write their audit rows (row count asserted for each):
  - `staff_submit_eod`, `staff_log_waste`, `record_missed_orders_for_day`, `copy_catalog_rows` (SECURITY DEFINER);
  - an insert of `'Store user created'` as `service_role`;
  - `receive_purchase_order` called by staff (SECURITY INVOKER, `'PO received'`).

**UPDATE (closes the edit half of M3)**
- [ ] AC-11: Admin and super_admin `update audit_log set detail = …` on an S1 row affects 0 rows. The re-select shows the original `detail`. No UPDATE policy exists on the table.

**DELETE (closes the erase half of M3 and spec 157 FUTURE-1)**
- [ ] AC-12: Admin deleting an S1 row with `created_at = now()` affects 0 rows. Same for super_admin.
- [ ] AC-13: Admin (brand A) deleting an S1 row with `created_at = now() - interval '91 days'` removes it.
- [ ] AC-14: Admin (brand A) deleting a brand-B store row that is 91 days old affects 0 rows.
- [ ] AC-15: A store-less (`store_id IS NULL`) row that is 91 days old cannot be deleted by admin (0 rows) but can be deleted by super_admin (row removed).
- [ ] AC-16: Staff deleting a 91-day-old S1 row affects 0 rows.
- [ ] AC-17: As superuser, `delete from stores where id = S1` removes every `audit_log` row for S1, fresh rows included (FK cascade, unaffected by RLS).

**INSERT `created_at` (closes security-auditor M1; decision 9)**
- [ ] AC-22: Staff on S1 and admin (brand A) are each rejected with `42501` when inserting an otherwise-admissible ordinary-action row (store S1, `user_id` = caller) with an explicit `created_at` that is (a) in the future, (b) `NULL`, or (c) in the past.
- [ ] AC-23: The same staff and admin inserts with `created_at` omitted (column default `now()`) succeed. Every AC-10 writer still writes its row (none sets `created_at`; DEFINER RPCs and service_role bypass RLS anyway).

**Client**
- [ ] AC-18: The `audit_log` delete line is gone from `deleteStore` in [src/lib/db.ts](../src/lib/db.ts). Every other delete in `deleteStore`, and their order, is unchanged. `cleanupOldRecords` is unchanged.

**Regression gates**
- [ ] AC-19: The full pgTAP suite passes, including the updated `super_admin_policy_parity.test.sql` (see Note for architect N1).
- [ ] AC-20: Full `npx jest`, `npm run typecheck`, and the test-graph typecheck all pass.
- [ ] AC-21: These smokes pass against the local stack: `scripts/smoke-store-user.sh`, `scripts/smoke-edge-roles.sh`, `scripts/smoke-staff-eod.sh`, `scripts/smoke-rpc.sh`.

## In scope

- One migration adding RESTRICTIVE SELECT and INSERT policies (including the decision-9 `created_at = now()` INSERT check), dropping `admin_update_audit_log`, and replacing `admin_delete_audit_log` with a scoped, age-gated predicate.
- A new pgTAP file covering AC-3 to AC-17, AC-22 and AC-23.
- Updating the existing pgTAP arms that pin the old UPDATE/DELETE behavior (N1).
- Removing the redundant `audit_log` delete from `deleteStore` in `db.ts`.

## Out of scope (explicitly)

- **Applying the migration to prod.** Not in this session. Committing the migration turns `db-migrations-applied.yml` red until the owner applies it via the Supabase MCP. That is the owner's call.
- **Moving `'User invite'` / `'User deleted'` server-side.** These stay client-written. A follow-up can add them to the server-only list once they move.
- **Whether other client-written actions, such as `'User invite'`, also leak names to staff.** A separate visibility audit.
- **Making the retention window configurable.** 90 days stays hardcoded in both `cleanupOldRecords` and the policy.
- **Any UI change.** `AuditLogSection` and `PhoneAuditLog` behave the same; staff don't use them.
- **FORCE RLS on `audit_log`.** It would break every SECURITY DEFINER writer.
- **Realtime.** `audit_log` is not in the `supabase_realtime` publication, so no restart ritual applies.
- **`app.json` slug.** Not touched.

## Open questions resolved (owner-approved plan)

- Q: What policy mechanism? → A: One migration adding **RESTRICTIVE** policies, which AND with the existing permissive ones. No permissive policy widens, so the spec-053 lint is unaffected.
- Q: SELECT rule? → A: Rows with action `'Store user created'` or `'Store user password set'` are readable only when `auth_is_privileged()`.
- Q: INSERT rule? → A: Two rules. (a) No RLS-subject caller may insert the server-only actions `'Store user created'`, `'Store user password set'`, `'Order missed'`, `'catalog_copy'`. (b) Non-privileged callers must set `user_id = auth.uid()`. Privileged callers are exempt from (b) because of the EOD on-behalf path. DEFINER RPCs and service role are unaffected because they bypass RLS. INVOKER PO RPCs keep working for staff.
- Q: UPDATE? → A: Drop `admin_update_audit_log`. Audit rows become immutable through the API.
- Q: DELETE? → A: Replace `admin_delete_audit_log` with `auth_is_privileged() AND created_at < now() - interval '90 days' AND ((store_id is not null and auth_can_see_store(store_id)) or (store_id is null and auth_is_super_admin()))`. `cleanupOldRecords` keeps working, nobody can erase a fresh row, and store/brand deletion relies on the FK cascade. Remove the redundant delete in `deleteStore`.
- Q: Tests? → A: The new pgTAP file (AC-3 to AC-17), the spec-053 lint, full jest, both typechecks, and the four existing smokes.
- Q: Prod apply? → A: Out of scope for this session.
- **Decision 9 (owner, 2026-10-22, in chat): fold security-auditor M1 into this migration.** Add a fourth RESTRICTIVE INSERT policy, `audit_log_restrict_insert_created_at_now`, `with check (created_at = now())`. It rejects explicit future, past, and NULL `created_at` values from every RLS-subject caller, privileged included; the column default `now()` still passes. `created_at` is **not** made `NOT NULL` in this spec (prod's NULL count was not checked). In the same decision the owner declined to fold in security **L4** (`revoke truncate … from anon, authenticated`) and **L1** (positive action allowlist); both stay follow-ups (see Follow-ups).

## Notes for architect (factual findings, non-blocking)

- **N1. Existing pgTAP arms pin the behavior this spec reverses.** These arms in [supabase/tests/super_admin_policy_parity.test.sql](../supabase/tests/super_admin_policy_parity.test.sql) assert that a privileged UPDATE or DELETE of a fresh audit row succeeds:
  - AL-5 (super_admin UPDATE, ~line 200)
  - AL-6 (super_admin DELETE, ~line 212)
  - AL-9 (admin UPDATE, ~line 342)
  - AL-10 (master DELETE, ~line 381)

  They fail once this migration lands. Choose how to update them, either by flipping them to 0-row assertions or by aging the DELETE fixtures past 90 days. Keep their intent as spec 157's super_admin-parity check where it still applies. AL-7 and AL-8 (plain user gets 0 rows) and AL-1 to AL-4 should keep passing unchanged.
- **N2. Admin retention purge on store-less rows.** Under decision 5, an admin's (not super_admin's) `cleanupOldRecords` silently skips store-less rows older than 90 days. `safe()` swallows nothing here because RLS returns 0 rows without an error. Those rows age out only when a super_admin session runs the purge. This is the intended consequence of the approved decision. It is noted here so nobody "fixes" it.
- **N3. Clock skew at the 90-day boundary.** `cleanupOldRecords` computes its cutoff on the client, while the policy uses server `now()`. If the client clock runs ahead, rows inside the skew window are skipped and get picked up on a later run. This is harmless. Do not loosen the policy to compensate.
- **N4. The UPDATE drop is a silent 0-row result, not an error.** No client code updates `audit_log`, so nothing regresses. Confirm no smoke script does either.

## Risks

- **`db-migrations-applied` goes red on commit** until the prod apply (decision 7). Per CLAUDE.md, the release-coordinator cannot recommend SHIP_READY while either gate on `main` is red, so the owner has to sequence the prod apply around the push.
- **Hidden RLS-subject writer of a server-only action.** If any path not listed above writes one of the four actions under caller RLS, it will start failing with `42501`. The writer inventory above is grep-verified. The architect should re-grep `supabase/functions/` and the migrations for every action string before finalizing.
- **A future INVOKER RPC that writes `user_id` other than `auth.uid()` will fail for staff.** That is intended, and the policy comment should say so.
- **Immutability is per row, not per store or per actor (security-auditor L3, by design).** Two privileged erase paths remain: deleting a profile SET NULLs `audit_log.user_id` on every row that profile wrote (`20260528000000_actor_fk_cascade_audit.sql`), and deleting a store or brand cascades away all of its audit rows, fresh ones included (D-9). Both are deliberate and loud (the user or store visibly disappears). A true append-only trail (actor snapshot in the row, or an archive table outside the cascade) is a long-term option, not this spec.
- **Spec 167 coupling.** Spec 167 is staged and uncommitted. AC-10's service-role and store-user fixtures don't depend on 167's code, but the user-facing value of AC-3 does. Ship order is the owner's call.

## Dependencies

- Spec 157 policies (base state), spec 053 permissive-policy lint, spec 041 `auth_can_see_store()` brand scope, the brand-delete FK cascade in `20260510010000_brand_delete_cascade.sql`, and spec 167 (the source of the store-user actions).
- Local stack (`npm run dev:db`) for pgTAP and smokes.

## Project-specific notes

- Cmd UI section / legacy: none (no UI change). The only client change is `src/lib/db.ts` `deleteStore`.
- Per-store or admin-global: per-store. The DELETE policy is now store/brand-scoped via `auth_can_see_store()`; the store-less arm is super_admin only.
- Realtime channels touched: none (`audit_log` is not in the `supabase_realtime` publication).
- Migrations needed: yes (one).
- Edge functions touched: none. `manage-store-user` keeps writing via service role.
- Web/native scope: both (DB-level change; the `db.ts` edit is shared code).
- Test tracks: pgTAP (new file plus the `super_admin_policy_parity` update), jest (full regression), and shell smokes (four scripts listed in AC-21).

## Backend design

Architect pass, 2026-10-22. Backend-only: one migration, one new pgTAP file, one pgTAP file amended, one line removed from `src/lib/db.ts`. No edge function, no `useStore.ts` change, no realtime change, no grant change.

### 0. Re-verification of the spec's factual claims

All of these were re-checked against the repo. Nothing in the PM's inventory was wrong, and two findings were added (marked NEW).

| Claim | Verified against | Result |
|---|---|---|
| Latest audit_log policy state is spec 157's | grep `on public.audit_log` across all migrations. The only writers are `20260504173035` (superseded) and `20260809000000_super_admin_policy_parity.sql:175-216` | Confirmed. Four PERMISSIVE policies, none with a `to` clause (i.e. `PUBLIC`). |
| RLS on, FORCE off | `init_schema.sql:254` (`enable row level security`). No `force row level security` on audit_log anywhere | Confirmed. The table owner (`postgres`) and `service_role` (BYPASSRLS) both bypass. |
| `audit_log.store_id` FK is ON DELETE CASCADE | `20260510010000_brand_delete_cascade.sql:190-195` converts `audit_log.store_id` | Confirmed. |
| NEW: `audit_log.user_id` FK is ON DELETE SET NULL | `20260528000000_actor_fk_cascade_audit.sql:55-59` | That is an UPDATE run by the RI trigger. RI actions run as the FK table's owner with `SECURITY_NOFORCE_RLS`, so they bypass RLS. Dropping the UPDATE policy does **not** break profile deletion. `actor_fk_cascade_audit.test.sql` arm (6) keeps passing. |
| Helper names/signatures | `auth_is_privileged()` (`20260509000000:235`), `auth_is_super_admin()` (`20260509000000:187`), `auth_can_see_store(p_store_id uuid)` (latest body `20260517040000:88`) | All exist with these exact signatures. All are `security definer`, `stable`, and have EXECUTE granted to `authenticated, anon`. No later migration redefines them. |
| Server-only actions have no RLS-subject writer | grep `insert into (public.)?audit_log` across `supabase/` (15 files), all four action strings across the repo (excluding specs/seed), and `audit_log` across `supabase/functions/` | Confirmed. See §2. |
| No updater exists | grep `audit_log` across `src/` and `scripts/` | Confirmed. All smoke-script audit_log mutations go through `psql` as `postgres` (`smoke-store-user.sh:41,102,513-546`, `smoke-send-email-hook.sh:99`). None goes through PostgREST, which settles N4. |
| NEW: `db.deleteStore` has **zero callers** | grep `deleteStore\b` over the repo (excluding node_modules/specs) | Only the definition at `src/lib/db.ts:178`. No jest test references it or `audit_log`. AC-18's line removal cannot regress any runtime path. Deleting the dead function is out of scope (see Follow-ups). |
| NEW: no RESTRICTIVE policy exists anywhere in `supabase/migrations/` | grep `as restrictive` | These are the schema's first RESTRICTIVE policies. The only prior use is a test-local one in `order_approvals.test.sql:462`. The pattern is new, and owner decision 1 is the justification. |

### 1. Data model changes

**No table, column, index, constraint, trigger, grant or publication change.** Policy DDL and comments only. The change is additive for SELECT and INSERT (restrictive policies only narrow access) and narrowing for UPDATE and DELETE. Nothing is destructive to data.

**Migration filename:** `supabase/migrations/20261022000000_audit_log_rls_hardening.sql`

- The latest file on disk is `20261008000000_get_profile_emails.sql`. Nothing exists in `2026-10-09 .. 2026-10-21`, and nothing is dated 2027 or later.
- The session-start git snapshot shows no staged or untracked file under `supabase/migrations/`. Spec 169 is staged but has no migration. **Developer:** re-run `ls supabase/migrations | tail -3` and `git status --short supabase/migrations` before creating the file. If a sibling appeared, take the next free `2026102x000000` slot and keep it the single newest file.

**Wrapper and idempotency.** Follow the spec 157 house shape exactly (`20260809000000:166`):
- an explicit `begin; … commit;`. This is required, not decorative. The prod-apply path is MCP `execute_sql`, and a half-apply would leave UPDATE dropped while DELETE stays unscoped.
- `drop policy if exists` before every `create policy`;
- `comment on policy` overwrites;
- re-runnable to a no-op.

**Header comment** must carry: the spec 170 rationale (M2/M3 + spec 157 FUTURE-1), the "first RESTRICTIVE policies in the schema" note, why FORCE RLS is not used (it breaks every DEFINER writer), the "not in `supabase_realtime`, no docker-restart ritual" note, and a **Rollback** block. The rollback pastes the spec 157 text of `admin_update_audit_log` / `admin_delete_audit_log` (`20260809000000:199-216`) plus four `drop policy if exists` statements for the restrictive policies.

**Policy contract.** This is the authoritative text; the developer authors the file. Policy kinds and names are final.

```
-- (a) SELECT — hide store-user audit rows from non-privileged callers (closes M2)
drop policy if exists "audit_log_restrict_select_store_user_actions" on public.audit_log;
create policy "audit_log_restrict_select_store_user_actions"
  on public.audit_log
  as restrictive
  for select
  using (
    action not in ('Store user created', 'Store user password set')
    or public.auth_is_privileged()
  );

-- (b) INSERT — server-only actions can never be written under caller RLS
drop policy if exists "audit_log_restrict_insert_server_only_actions" on public.audit_log;
create policy "audit_log_restrict_insert_server_only_actions"
  on public.audit_log
  as restrictive
  for insert
  with check (
    action not in ('Store user created', 'Store user password set',
                   'Order missed', 'catalog_copy')
  );

-- (c) INSERT — non-privileged callers may only attribute rows to themselves
drop policy if exists "audit_log_restrict_insert_actor_is_caller" on public.audit_log;
create policy "audit_log_restrict_insert_actor_is_caller"
  on public.audit_log
  as restrictive
  for insert
  with check (
    user_id = auth.uid()
    or public.auth_is_privileged()
  );

-- (d) UPDATE — no policy at all → default-deny → audit rows immutable via the API
drop policy if exists "admin_update_audit_log" on public.audit_log;

-- (e) DELETE — single PERMISSIVE policy, same name, scoped + age-gated
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

-- (f) INSERT — created_at pinned to the server transaction clock (decision 9, closes security M1)
drop policy if exists "audit_log_restrict_insert_created_at_now" on public.audit_log;
create policy "audit_log_restrict_insert_created_at_now"
  on public.audit_log
  as restrictive
  for insert
  with check (
    created_at = now()
  );
```

`store_member_read_audit_log` and `store_member_insert_audit_log` are **not touched**, not even dropped and recreated, which keeps them byte-identical (AC-1).

**Design decisions behind the shape:**

- **Where the 90-day scope lives.** It goes in the **permissive** `admin_delete_audit_log`, not a separate RESTRICTIVE policy. AC-1 requires *exactly one* DELETE policy. With only one DELETE policy, permissive-plus-full-predicate and permissive-plus-restrictive have identical effect. The new predicate is a strict subset of the old one (`auth_is_privileged()` AND more), so it is "no wider than what it replaces". Keeping the name preserves the `pg_policies` diff as "UPDATE row gone, DELETE row qual changed, four rows added".
- **Three restrictive policies, not four (design pass; superseded by decision 9, which adds (f) as a fourth).** The fourth slot in the PM's sketch is covered by (d) + (e). A restrictive `using (false)` UPDATE policy was rejected: AC-1 says "no UPDATE policy". It would also silently AND-cancel any future permissive UPDATE policy, which is a confusing failure mode. Default-deny with zero UPDATE policies is the clean shape.
- **Three INSERT restrictive policies, not one combined.** Separate names give each 42501 a single cause in pgTAP and in `pg_policies` review, and either can be dropped independently. That matters for the follow-up that moves `'User invite'` / `'User deleted'` server-side and extends list (b).
- **No `to` clause (= `PUBLIC`).** This matches every existing audit_log policy. Restrictive policies must cover every RLS-subject role, `anon` included. Scoping them `to authenticated` would leave `anon` unrestricted by them. `anon` is already refused by the permissive arms, but the restrictive layer should not depend on that.
- **(f) and column defaults.** Column defaults are applied before WITH CHECK, so an INSERT that omits `created_at` stores `now()` and passes. `now()` is the transaction start, and PostgREST runs each request in its own transaction, so default and check share one clock. An explicit value passes only if it equals the transaction start exactly, which no client can arrange; an explicit NULL gives `NULL = now() → NULL` and is rejected. No RLS-subject writer sets `created_at` (re-grepped in the fix pass: `addAuditEvent` at `src/lib/db.ts:2838` lists only `store_id, user_id, action, detail, item_ref, value`; the live bodies of `receive_purchase_order`, `close_short_purchase_order` and `cancel_purchase_order` insert the same six columns; every pgTAP aged fixture inserts as `postgres`).
- **NULL semantics are fail-closed by construction.** `action` is `NOT NULL` (`init_schema.sql:200`), so `not in` cannot go NULL. In (c), `user_id IS NULL` gives `NULL = uid → NULL`, which ORs to NULL for non-privileged callers, so the row is rejected. That is AC-6's NULL arm. For privileged callers it ORs to true. In (e), a row with `created_at IS NULL` (the column is nullable, default `now()`) is never API-deletable. Only the FK cascade removes it. That is acceptable.
- **Helper choice.** `auth_is_privileged()` everywhere a role gate is needed, per the CLAUDE.md / spec 157 rule. `auth_is_super_admin()` only for the store-less DELETE arm (decision 5). **No `auth_is_admin()` anywhere**, so `super_admin_policy_parity.test.sql` LINT-1 stays at 0. `like '%auth_is_admin%'` does not match `auth_is_super_admin()`: even with `_` as a single-char wildcard there is only one `auth` substring and it is followed by `_is_s…`, so the match fails. The same holds for `auth_can_see_store`.
- **Bare helper calls, not `(select helper())` initplans.** This is consistent with every existing policy in the schema. audit_log is small (seed 286 KB total, no index on the table today). The extra per-row STABLE-function cost is noise.

**Comments (AC-2).** Exactly five `comment on policy` statements, one each on (a), (b), (c), (e) and (f) (four in the design pass; (f) added by decision 9). Each text starts with `'spec 170: '`. Required content:
- (a) "RESTRICTIVE (ANDs with store_member_read_audit_log). Store-user rows carry the target login username in item_ref (spec 167). Hidden from non-privileged callers per spec 095 anti-enumeration. Closes spec 167 security-auditor M2."
- (b) "RESTRICTIVE. These four actions are written only by SECURITY DEFINER RPCs (record_missed_orders_for_day, copy_catalog_rows) or service_role (manage-store-user), all of which bypass RLS (owner/BYPASSRLS, no FORCE RLS). Any RLS-subject insert of them is a forgery. Extend this list when 'User invite' / 'User deleted' move server-side. Closes the forgery half of M3."
- (c) "RESTRICTIVE. Non-privileged callers (staff, INVOKER RPCs run by staff) must set user_id = auth.uid(). Privileged callers are exempt for the admin EOD on-behalf path (useStore submitEOD passes entry.submittedByUserId). A future INVOKER RPC that writes a user_id other than auth.uid() will fail for staff with 42501. That is intended. Make it SECURITY DEFINER instead."
- (f) "RESTRICTIVE. created_at must equal now() (the server transaction clock). The column default is applied before WITH CHECK, so an omitted created_at passes; an explicit future, past, or NULL value is rejected with 42501. … Owner decision 9 (2026-10-22); closes spec 170 security-auditor M1." (full text in the migration).
- (e) "PERMISSIVE, replaces spec 157's unscoped policy (closes spec 157 OQ-3 / FUTURE-1 and the erase half of M3). Rows younger than 90 days are not API-deletable by anyone. Older rows are deletable by privileged callers within auth_can_see_store(store_id), and store-less rows by super_admin only. 90 days must match cleanupOldRecords in src/lib/db.ts. Store/brand deletion relies on the audit_log.store_id FK cascade, which bypasses RLS. Admin purge silently skips store-less rows (spec 170 N2). Client/server clock skew at the boundary is harmless (N3). Do not loosen."

The `admin_update_audit_log` drop needs no comment (the object no longer exists). The rationale lives in the header.

### 2. Writer inventory (re-grep, risk item "hidden RLS-subject writer")

Every `insert into public.audit_log` in `supabase/migrations/`, resolved to the **latest** definition of each function:

| Writer (latest def) | Security | Actions written | `user_id` | Subject to new policies? |
|---|---|---|---|---|
| `staff_submit_eod` (`20260630000200:56`, granted `authenticated`) | DEFINER | `'EOD entry'` | NULL | No (owner bypass) |
| `staff_log_waste` (`20260701000000:1067`, EXECUTE `service_role` only) | DEFINER | `'Waste log'` | NULL | No |
| `record_missed_orders_for_day` (`20260530000000:126`, EXECUTE `postgres, service_role`) | DEFINER | `'Order missed'` | NULL | No |
| `copy_catalog_rows` (`20260518000000:116`, `auth_is_super_admin()` gate) | DEFINER | `'catalog_copy'` (store_id NULL) | `auth.uid()` | No |
| `auto_receive_due_purchase_orders` (`20260719000000:63`) | DEFINER | `'PO auto-received'` | NULL | No |
| `receive_purchase_order` (`20260707000000:114`) | **INVOKER** | `'PO received'`, `'PO price change'` | `auth.uid()` | Yes. It passes (b) and passes (c) via `user_id = auth.uid()`. |
| `close_short_purchase_order` / `cancel_purchase_order` (`20260704000000:314,371`) | **INVOKER** | `'PO closed short'`, `'PO cancelled'` | `auth.uid()` | Yes. It passes, same as above. |
| `manage-store-user` edge fn (`index.ts:272-275`, `serviceClient`) | service_role | `'Store user created'`, `'Store user password set'` | caller id | No (BYPASSRLS) |
| `addAuditEvent` (`src/lib/db.ts:2836`) via `useStore` + `ReceivingSection.tsx:545` | caller RLS | ordinary actions only | `currentUser.id` (or `entry.submittedByUserId` at `useStore.ts:3049`) | Yes. Admin Cmd UI only, privileged callers (see §3). |

- **No trigger function writes audit_log.** Every insert site is one of the RPCs above.
- No other edge function references `audit_log` (grep over `supabase/functions/`). `delete-user` (staged diff) does not.
- `report_run_custom.test.sql:140` tries an `INSERT INTO audit_log` through the custom-report path. That path is refused for a different reason (read-only report SQL) and is unaffected.
- **Owner bypass precondition.** Every DEFINER writer above is created by a migration and therefore owned by `postgres`, which also owns `public.audit_log`, and FORCE RLS is off. pgTAP arm S-7 pins this, so a future `force row level security` or an owner change fails the build instead of silently breaking the cron writers.
- **The FK cascade from `stores` is not subject to RLS.** RI triggers run as the referencing table's owner with `SECURITY_NOFORCE_RLS`. Arm D-9 proves it on the production path: an admin JWT deletes a store and its fresh audit rows go with it.

### 3. Privileged exemption on `user_id` (owner Q3)

It is **needed, and it only matters for privileged callers.**
- `useStore.submitEOD` (`useStore.ts:2943`) writes one audit row per entry with `userId: entry.submittedByUserId` (`:3049`). Entries come from the caller-supplied `submission.entries`. On the edit path (`existing` set, `:2958`) the merged entries can carry the original submitter's id. `submittedByUserId` can also be `undefined`, which becomes NULL. Either case gives `user_id ≠ auth.uid()`.
- `useStore` only runs inside the admin Cmd UI. `RoleRouter` sends `profiles.role = 'user'` to the staff stack, which never writes audit_log (`src/screens/staff/` has zero `audit_log` references). The `profiles_role_check` CHECK allows exactly `super_admin | admin | master | user`. Every caller that reaches `addAuditEvent` is therefore `admin` / `master` (JWT path of `auth_is_privileged()`) or `super_admin` (profiles path). The exemption admits them, and no non-privileged principal can produce `user_id ≠ auth.uid()` legitimately.
- **Residual risk, accepted per decision 3:** a privileged caller can attribute an ordinary-action row to any profile id, including a profile in another brand, on a store they can see. Privileged callers are trusted for attribution. Tightening to "target profile in a brand the caller can see" is a possible follow-up, not this spec.
- **Pre-existing, unchanged:** several call sites pass `userId: currentUser?.id || ''`. An empty string to a `uuid` column raises `22P02` before RLS runs. `addAuditEvent` discards the error (`db.ts:2838` never inspects `error`) and the store wrapper only `console.warn`s. Note that the same swallowing would hide a 42501 from a missed writer. §2 shows there is none.

### 4. API contract

- **PostgREST only. No RPC.** The existing surface is `from('audit_log').select/insert/delete` and stays as is.
- Behavioral contract after the migration:

| Operation | Caller | Result |
|---|---|---|
| SELECT store-user action rows | non-privileged | filtered out (0 rows, no error) |
| SELECT store-user action rows | privileged | visible within existing store scope |
| INSERT a server-only action | any RLS-subject caller | HTTP 403 / SQLSTATE `42501` |
| INSERT with `user_id ≠ auth.uid()` or NULL | non-privileged | `42501` |
| INSERT with an explicit `created_at` (future, past, or NULL) | any RLS-subject caller | `42501` (decision 9) |
| UPDATE | anyone via API | 0 rows, HTTP 204 / 200 with empty body. **Silent, not an error.** |
| DELETE of a row younger than 90 days | anyone via API | 0 rows, silent |
| DELETE of a row 90 days or older | privileged, in-scope | removed |
| DELETE of a row 90 days or older | admin, out-of-brand or store-less | 0 rows, silent |

### 5. Edge functions

None new, none modified. `manage-store-user` keeps `verify_jwt` as configured and keeps writing via the service-role client. BYPASSRLS means the new policies do not apply to it.

### 6. `src/lib/db.ts` surface (AC-18)

- **`deleteStore` (`db.ts:178-189`):** delete line 185, `await supabase.from('audit_log').delete().eq('store_id', id).abortSignal(signal);`, and nothing else. The remaining six awaits keep their order. Recommended: replace it with a one-line comment such as `// audit_log rows ride the stores FK cascade (spec 170 — fresh rows are not API-deletable)`. That stops a future developer from "restoring" the delete. The comment is optional and not a contract item.
- **`cleanupOldRecords` (`db.ts:5995-6026`):** unchanged.
- **`addAuditEvent`, `fetchAuditLog`:** unchanged. No new helper. No mapping change.
- **Jest:** no test mocks `deleteStore` or asserts on `audit_log`. The only grep hits on `deleteStore` in tests are `deleteStoreCountLayout`. No jest edits are expected. Still run the full `npx jest` per AC-20.

### 7. Grants (spec 097)

No change. `20260618000000_public_grants_explicit.sql:147` grants `select, insert, update, delete, references, trigger` on all public tables to `anon, authenticated`. The table-level UPDATE and DELETE grants on audit_log stay, and RLS is the inner gate. A `revoke update` was considered and rejected for three reasons:
- it would turn the silent 0-row UPDATE into a hard 42501, which is a contract change the spec did not ask for;
- it would add a third deliberate table-level REVOKE that `public_grants_explicit.test.sql` and future grant restorations would have to know about;
- RLS default-deny already makes the outcome identical.

### 8. Realtime impact

None. `audit_log` is not a member of `supabase_realtime` (`20260514140000_realtime_publication_tighten.sql:43-53`, restated in the spec 157 header). The migration does not touch publication membership, so **no `docker restart supabase_realtime_imr-inventory` step applies**. Do not add one defensively.

### 9. Frontend store impact

None. No `useStore.ts` slice changes. The optimistic-then-revert pattern does not apply because `addAuditEvent` is fire-and-forget. `AuditLogSection` / `PhoneAuditLog` are admin surfaces, and privileged callers still see everything they saw before.

### 10. pgTAP

#### 10a. New file: `supabase/tests/audit_log_rls_hardening.test.sql`, `select plan(54);` (45 in the design pass; +8 C-* arms for decision 9, +1 D-10 in the review fix pass)

**Conventions** (copy from `super_admin_policy_parity.test.sql` and `auth_can_see_store_brand_scope.test.sql`):
- hermetic `begin; create extension if not exists pgtap; … select * from finish(); rollback;`;
- constants via `set_config('test.*', …, true)`;
- impersonation via `set local role authenticated` plus `set_config('request.jwt.claims', jsonb_build_object('sub', …, 'role', 'authenticated', 'app_metadata', jsonb_build_object('role', …))::text, true)`;
- `reset role` to return to `postgres`;
- `set local role service_role` for the service-role arm, as in `profiles_insert_hardening.test.sql`.
- `scripts/test-db.sh` runs every `*.test.sql` via `psql -f` as `postgres`, fails on `not ok`, and fails on a plan/ran mismatch. **Do not wrap asserts in savepoints that roll back** (that trips the silent-skip detector; see `permissive_policy_lint.test.sql:72-77`).

**Principals:**
- Staff = seed `22222222-…` (`role='user'`, `user_stores` grant on Towson), JWT `app_metadata.role='user'`.
- Admin = seed `11111111-…` (`profiles.role='admin'`, brand A), JWT `'admin'`.
- Super_admin = seed `33333333-…` promoted in-txn to `role='super_admin', brand_id=null`, JWT `app_metadata.role='user'`. This mirrors spec 157. The admit path is then provably `auth_is_super_admin()`.
- S1 = Towson `00000000-0000-0000-0000-000000000001`.
- Brand B + store SB: insert a test-only brand + store as superuser, copying `auth_can_see_store_brand_scope.test.sql:78-91` with fresh ids, e.g. `b1700000-…`.
- S_tmp1, S_tmp2: two test-only brand-A stores for the cascade arms.

**Faking an old row.** There is no UPDATE path any more, so set `created_at` **at insert time as `postgres`** before any `set local role`: `insert into public.audit_log (id, store_id, user_id, action, detail, created_at) values (…, now() - interval '91 days')`. `now()` is the transaction start, so fixtures and policy evaluation share one clock and the 90-day boundary is deterministic. Use fixed uuids (prefix `a5000170-…`) and a `__test_spec170_*__` action/detail namespace.

**Read-back rule (important).** A "row survives" assertion run as a caller who **cannot see** the row is worthless: it returns 0 or NULL whether or not the row survived. Do all DELETE/UPDATE **outcome** assertions in a final `reset role` superuser block (arms U-*, D-*), keyed by fixture id. Use **one fixture row per (caller, arm)** so an earlier arm's delete cannot mask a later arm's survival check.

**Arm map (54):**

| # | ID | AC | Context | Assertion |
|---|---|---|---|---|
| 1 | S-1 | AC-1 | postgres | `pg_policies` for `public.audit_log` returns exactly these seven (policyname, cmd, permissive) rows, in sorted order (`results_eq` or `is(string_agg …)`): `admin_delete_audit_log/DELETE/PERMISSIVE`, `audit_log_restrict_insert_actor_is_caller/INSERT/RESTRICTIVE`, `audit_log_restrict_insert_created_at_now/INSERT/RESTRICTIVE` (decision 9), `audit_log_restrict_insert_server_only_actions/INSERT/RESTRICTIVE`, `audit_log_restrict_select_store_user_actions/SELECT/RESTRICTIVE`, `store_member_insert_audit_log/INSERT/PERMISSIVE`, `store_member_read_audit_log/SELECT/PERMISSIVE` |
| 2 | S-2 | AC-1, AC-11 | postgres | count of `cmd='UPDATE'` policies on audit_log = 0 |
| 3 | S-3 | AC-1 | postgres | `qual` of `store_member_read_audit_log` = the deparsed text **captured from the local DB before the migration** (`select qual from pg_policies …`), pinned as a literal |
| 4 | S-4 | AC-1 | postgres | `with_check` of `store_member_insert_audit_log` = captured pre-migration literal, same method |
| 5 | S-5 | AC-1 | postgres | `admin_delete_audit_log.qual` contains `auth_is_privileged()`, `90 days`, `auth_can_see_store(store_id)` and `auth_is_super_admin()`; `with_check` is NULL |
| 6 | S-6 | AC-2 | postgres | count of audit_log policies whose `pg_description` (via `pg_policy.oid`, `classoid = 'pg_policy'::regclass`) starts with `spec 170:` = 5 (4 before decision 9) |
| 7 | S-7 | §2 precondition | postgres | `relrowsecurity` is true, `relforcerowsecurity` is false for `public.audit_log`, **and** `proowner` of `staff_submit_eod`, `staff_log_waste`, `record_missed_orders_for_day`, `copy_catalog_rows`, `auto_receive_due_purchase_orders` all equal `relowner` of audit_log (one boolean `ok()`) |
| 8 | F-1 | AC-3 fixture | postgres | seeded S1 rows: 1 × `'Store user created'`, 1 × `'Store user password set'`, 1 × `'PO received'`, 1 × `'EOD entry'` exist (count = 4) |
| 9 | R-1 | AC-3 | staff | `count(*) where store_id=S1 and action in (two store-user actions)` = 0 |
| 10 | R-2 | AC-4 | staff | `count(*)` of the S1 `'PO received'` + `'EOD entry'` fixtures = 2 |
| 11 | R-3 | AC-5 | admin | both store-user fixtures visible (= 2) |
| 12 | R-4 | AC-5 | super_admin | both store-user fixtures visible (= 2) |
| 13 | I-1 | AC-6 | staff | `throws_ok` insert S1 `'Waste log'`, `user_id = admin id` → `42501` |
| 14 | I-2 | AC-6 | staff | `throws_ok` insert S1 `'Waste log'`, `user_id = NULL` → `42501` |
| 15 | I-3 | AC-7 | staff | `lives_ok` insert S1 `'Waste log'`, `user_id = staff id` |
| 16–19 | I-4..I-7 | AC-8 | staff | `throws_ok … '42501'` for each of the four server-only actions. **store_id = S1, user_id = staff id**, so the permissive policy and (c) both pass and only (b) can refuse |
| 20–23 | I-8..I-11 | AC-8 | admin | same four, store_id = S1, user_id = admin id |
| 24–27 | I-12..I-15 | AC-8 | super_admin | same four, store_id = S1, user_id = super_admin id |
| 28 | I-16 | AC-9 | admin | `lives_ok` insert S1 `'EOD entry'`, `user_id = staff id` |
| 29 | W-1 | AC-10 | staff | `staff_submit_eod(…)` called as staff → expected `'EOD entry'` row delta for S1 (minimal fixture copied from `staff_submit_eod_cases_each.test.sql`) |
| 30 | W-2 | AC-10 | staff | as postgres first: `grant execute on function public.staff_log_waste(uuid,uuid,uuid,numeric,text,text,text,text) to authenticated;` (rolled back with the txn). Then as staff call it on an S1 item → 1 `'Waste log'` row, `user_id IS NULL`. Calling it from an RLS-subject role is what makes the arm sharp: under caller RLS, (c) would refuse the NULL actor |
| 31 | W-3 | AC-10 | staff | same in-txn grant trick for `record_missed_orders_for_day(date)`. Fixture: an `order_schedule` row on S1 for `to_char(p_date,'FMDay')` with no matching PO (copy `missed_order_audit_rpc.test.sql`) → ≥1 `'Order missed'` row. (b) would refuse it under caller RLS |
| 32 | W-4 | AC-10 | super_admin | `copy_catalog_rows(…)` (its gate is `auth_is_super_admin()`, `20260518000000:133`; fixtures from `cross_brand_copy.test.sql`) → expected `'catalog_copy'` row count. (b) would refuse it under caller RLS |
| 33 | W-5 | AC-10 | service_role | insert S1 `'Store user created'`, then count = 1 |
| 34 | W-6 | AC-10 | staff | `receive_purchase_order(…)` with **no price change** (staff price gate, `20260707000000`; fixture from `staff_receiving_gate.test.sql`) → 1 `'PO received'` row with `user_id = staff id` |
| 35 | U-1 | AC-11 | admin attempt, read as postgres | `update … set detail='x' where id=<U1 fixture>`. Read-back: detail unchanged |
| 36 | U-2 | AC-11 | super_admin attempt, read as postgres | same on the U2 fixture |
| 37 | D-1 | AC-12 | admin, read as postgres | fresh S1 row survives |
| 38 | D-2 | AC-12 | super_admin, read as postgres | fresh S1 row survives |
| 39 | D-3 | AC-13 | admin, read as postgres | 91-day S1 row is gone |
| 40 | D-4 | AC-14 | admin, read as postgres | 91-day SB (brand B) row survives. **SELECT-masked** (review fix pass): a column-filtered DELETE also applies the SELECT policies, so this passes under spec 157's unscoped DELETE too. D-10 isolates the clause |
| 41 | D-5 | AC-15 | admin, read as postgres | 91-day store-less row X survives |
| 42 | D-6 | AC-15 | super_admin, read as postgres | 91-day store-less row Y is gone (a **different** row from X) |
| 43 | D-7 | AC-16 | staff, read as postgres | 91-day S1 row survives |
| 44 | D-8 | AC-17 | postgres | `delete from public.stores where id = S_tmp1` (S_tmp1 has one fresh + one 91-day audit row) → 0 audit rows remain for S_tmp1 |
| +C | C-1..C-3 | AC-22 | staff | `throws_ok … '42501'` for an S1 ordinary-action insert with `user_id` = staff and `created_at` = `'2099-01-01'` / `NULL` / `now() - 30 days`. Store, actor and action all pass, so only (f) can refuse |
| +C | C-4 | AC-23 | staff | `lives_ok` for the same insert with `created_at` omitted |
| +C | C-5..C-7 | AC-22 | admin | same three refusals, `user_id` = admin (privileged callers get no exemption) |
| +C | C-8 | AC-23 | admin | `lives_ok`, `created_at` omitted |
| +D | D-10 | AC-14 (clause-isolating) | admin, read as postgres | As postgres, in-txn `create policy probe_wide_select … for select using (true)` so the SELECT mask no longer hides brand-B rows. As admin: record that a **new** 91-day brand-B fixture (`…0027`) is visible (precondition), then delete it by id. Drop the probe immediately. Read back as postgres: precondition held, row survives, probe gone. Verified to fail against the spec-157 `using (auth_is_privileged())` policy and against the mutant `auth_can_see_store(store_id) or true` |
| 45 | D-9 | AC-17 (production path) | admin JWT, read as postgres | the admin deletes S_tmp2 (brand A; `privileged_delete_stores` admits). Its **fresh** audit row is gone even though `admin_delete_audit_log` refuses fresh rows. This proves the cascade bypasses RLS |

**Ordering inside the file:** fixtures as postgres → S-* → F-1 → staff block (R-1, R-2, I-1..I-7, W-1, W-2, W-3, W-6, C-1..C-4, the D-7 attempt) → admin block (R-3, I-8..I-11, I-16, U-1 / D-1 / D-3 / D-4 / D-5 attempts, the D-9 store delete, C-5..C-8, the D-10 probe attempt) → super_admin block (R-4, I-12..I-15, W-4, U-2 / D-2 / D-6 attempts) → service_role block (W-5) → `reset role` → D-8 → all U-*/D-* read-back asserts. The plan count is 54 after the review fix pass (was 45). If a W-* fixture turns out to need more than one assertion, change `plan()` accordingly and note the change in the file header.

**AC-17 fixture note (interpretation, not drift).** AC-17 says "delete from stores where id = S1". Deleting seed Towson cascades through every per-store table, and any non-CASCADE FK into `stores` added since `20260510010000` would abort the whole file. D-8 uses a test-only brand-A store with the same fixture shape (fresh + old audit rows). That is semantically AC-17, because "S1" is simply "a store with fresh audit rows". The test-engineer should read D-8 as satisfying AC-17. D-9 is added because a superuser delete bypasses RLS anyway, so D-8 alone proves the FK action and nothing about RLS. D-9 exercises the real admin path.

#### 10b. Amend `supabase/tests/super_admin_policy_parity.test.sql` (N1). `plan(20)` is unchanged.

- **Fixture insert (`:107-125`).** Add `created_at` to the column list. Rows `…0002` (AL-6), `…0006` (AL-10) and, after the review fix pass, `…0004` (AL-8) get `now() - interval '91 days'`; the other three get `default`.
- **AL-5 (`:199-209`)** flips to a 0-row assertion: `is(detail, '__test_spec157_original__', 'AL-5: super_admin UPDATE of a store-scoped audit_log row affects 0 rows (spec 170: no UPDATE policy; audit rows immutable)')`.
- **AL-9 (`:341-351`)** flips the same way: admin JWT UPDATE affects 0 rows.
- **AL-6 (`:211-220`)** keeps asserting removal (count 0), with the message amended to "…removes an aged (>90d) row (spec 170 age gate)". This **preserves spec 157's parity intent**: super_admin is not silently denied on the retention purge.
- **AL-10 (`:380-389`)** keeps asserting removal on the aged row, with the same message amendment. Master-JWT parity is preserved.
- **AL-1 / AL-2 / AL-3 / AL-4 / AL-7 / AL-8 / IC-* / LINT-1** are unchanged and keep passing:
  - AL-1's super_admin store-less insert has `user_id` NULL and an ordinary action, so the privileged exemption in (c) admits it. The arm now incidentally exercises that exemption.
  - AL-8's fixture is fresh and the caller is non-privileged, so 0 rows either way. **Review fix pass:** that made AL-8 vacuous (the age gate alone refused it), so fixture `…0004` is now aged to `now() - interval '91 days'` and only `auth_is_privileged()` can refuse. Mutation-checked: removing `auth_is_privileged()` from the DELETE policy fails AL-8. AL-7's prose now says its refusal is default-deny (no UPDATE policy).
  - LINT-1 stays at 0 because no new predicate names `auth_is_admin`.
- **Header (`:19-29`).** Update the AL-5/AL-6 and AL-9/AL-10 legend lines and add a short "Spec 170 amendment" paragraph explaining the flip vs. aging choice.

#### 10c. Unchanged suites that double as regression evidence

- `permissive_policy_lint.test.sql` needs no allowlist change. It filters on PERMISSIVE, and the only permissive predicate touched (e) contains no trivially-wide token.
- `cost_on_receipt.test.sql`, `staff_receiving_gate.test.sql`, `staff_role_eod_rls.test.sql`, `missed_order_audit_rpc.test.sql`, `cross_brand_copy.test.sql`, `auto_receive_due_purchase_orders.test.sql` and `actor_fk_cascade_audit.test.sql` all write or read audit_log through the paths in §2 and must stay green (AC-19).

### 11. Build split and files

**One backend-developer.** No frontend-developer is needed. The `db.ts` edit is a one-line data-layer change in the backend lane.

Files the developer creates or changes:
1. `supabase/migrations/20261022000000_audit_log_rls_hardening.sql` (new)
2. `supabase/tests/audit_log_rls_hardening.test.sql` (new, `plan(54)`)
3. `supabase/tests/super_admin_policy_parity.test.sql` (amend AL-5/6/9/10, fixture `created_at`, header)
4. `src/lib/db.ts` (remove line 185 in `deleteStore`; optional one-line comment)

Verification the developer runs locally (`npm run dev:db`; **local only**):
- `npx supabase db reset` or a migration apply;
- `npm run test:db` (full suite);
- `npx jest`, `npm run typecheck`, the test-graph typecheck;
- `scripts/smoke-store-user.sh`, `scripts/smoke-edge-roles.sh`, `scripts/smoke-staff-eod.sh`, `scripts/smoke-rpc.sh`.

**Capture the S-3/S-4 literals from the local DB BEFORE applying the new migration.**

### 12. Prod rollout note (owner, later; this session must NOT touch prod)

The prod-apply path is Supabase MCP on project `ebwnovzzkwhsdxkpyjka`, per the project memory. `supabase db push` lacks the prod password.

1. **Pre-check:**
   - `select policyname, cmd, permissive from pg_policies where schemaname='public' and tablename='audit_log' order by 1;` should return exactly the four spec 157 policies.
   - `select relforcerowsecurity from pg_class where oid='public.audit_log'::regclass;` should return false.
   - Security L6 (delta re-review): `select count(*) filter (where created_at is null) as null_dated, count(*) filter (where created_at > now()) as future_dated from public.audit_log;` is read-only. Policy (f) only guards new inserts, so existing NULL- or future-dated rows would stay pinned at the top of the feed, and after the apply nobody could delete them through the API. If either count is non-zero, clean those rows up as postgres before the apply, and record what you removed.
2. **Apply:** run the migration body verbatim via `execute_sql`, with its `begin/commit` wrapper intact.
3. **Record:** `insert into supabase_migrations.schema_migrations (version, name) values ('20261022000000', 'audit_log_rls_hardening');` The version must byte-match the filename.
4. **Post-check:** the S-1 query returns the seven expected rows (including `audit_log_restrict_insert_created_at_now/INSERT/RESTRICTIVE`, decision 9), and the S-6 comment count is 5.
5. **Sequencing tip to avoid a red `db-migrations-applied` window.** Applying to prod **before** pushing the commit only produces the gate's *warn* (exit 0) path ("prod has an entry not in repo"). Pushing first produces a *hard fail* until the apply. Per the CLAUDE.md CI rule, both gates must be green before SHIP_READY, so apply-then-push is the clean order.
6. **DB and client order is otherwise free.** An old client's `deleteStore` audit line just affects 0 rows (and has no callers). `cleanupOldRecords` works under either policy set. A DB-only rollback is safe without a client rollback.

### 13. Risks and tradeoffs

- **Migration ordering.** The new file is a single newest file with no dependency on spec 167's staged code. AC-10's service-role arm inserts the action string directly. Ship order relative to 167 remains the owner's call.
- **RLS gaps that remain (accepted / follow-up):**
  - Staff can still insert *ordinary* actions with self-attribution, for example a self-attributed fake `'PO received'`. This holds while the PO RPCs stay INVOKER.
  - Privileged callers can attribute ordinary rows to any profile (§3).
  - ~~**`created_at` is client-settable on INSERT.**~~ **Closed by decision 9** (policy (f)). The security auditor's M1 extended this to `NULL` (sorts first under `ORDER BY created_at DESC` and is never API-deletable); (f) rejects that too. `created_at` stays nullable at the schema level, so service_role could still write a NULL; making the column `NOT NULL` is an optional follow-up after a prod NULL-count check.
- **Silent semantics.** UPDATE and in-scope-but-fresh DELETE return 0 rows with no error. That is consistent with spec 157's observation, and no client code depends on either succeeding.
- **Retention lag.** Admin purge is now brand-scoped, and store-less rows purge only on a super_admin session (N2). A brand whose admins never log in accumulates rows older than 90 days until a super_admin session runs the purge. Client-cutoff vs server-`now()` skew is harmless (N3).
- **Performance on the seed dataset.** Per-row evaluation of three STABLE SECURITY DEFINER helpers on SELECT and DELETE over a small, unindexed table is negligible. `cleanupOldRecords` already seq-scans audit_log today. If audit_log grows large, `(store_id, created_at)` is the index to add. It is not needed now.
- **Edge function cold start.** Not applicable. No function changes.
- **First RESTRICTIVE policies in the schema.** Reviewers and future migrations must remember that a restrictive policy ANDs with **every** permissive policy for its command. Adding a new permissive SELECT or INSERT policy on audit_log cannot bypass (a) / (b) / (c) / (f). That is the point. The policy comments say so.

### Follow-ups (not in this build; surface to owner)

- ~~**F-170-1:** restrictive INSERT check pinning `created_at = now()`.~~ Done in this spec (decision 9). Optional remainder: `alter column created_at set not null` after checking prod's NULL count.
- **F-170-2:** delete the dead `db.deleteStore` (zero callers), or wire it, in a cleanup pass.
- **F-170-3:** move the PO RPCs' audit writes behind a DEFINER helper so `'PO received'` / `'PO price change'` / `'PO closed short'` / `'PO cancelled'` can join the server-only list.
- **F-170-4:** optional brand-scoping of the privileged on-behalf `user_id` exemption.
- **F-170-5 (security L4, owner declined to fold in, decision 9):** `revoke truncate on public.audit_log from anon, authenticated` plus a `has_table_privilege` arm. TRUNCATE ignores RLS; not reachable today. The broader 46-table TRUNCATE sweep stays its own spec.
- **F-170-6 (security L1, owner declined to fold in, decision 9):** replace list (b)'s exact-string blocklist with a positive allowlist or CHECK on `action`, so case / whitespace / label-text lookalikes are refused. Pairs with F-170-3.

## Files changed

Backend-developer pass, 2026-10-22. Local stack only; prod untouched.

**Migrations**
- `supabase/migrations/20261022000000_audit_log_rls_hardening.sql` (new). Applied locally with `supabase migration up --local`, then re-run twice via `psql` to confirm it is re-runnable.

**pgTAP**
- `supabase/tests/audit_log_rls_hardening.test.sql` (new, `plan(45)`, arms S-1..D-9 per §10a). S-3 / S-4 literals were captured from the local DB before the migration was applied.
- `supabase/tests/super_admin_policy_parity.test.sql` (amended per §10b: fixture `created_at` column, AL-5 / AL-9 flipped to 0-row, AL-6 / AL-10 fixtures aged to 91 days, header legend + "Spec 170 amendment" paragraph). `plan(20)` unchanged.

**src/lib/db.ts**
- `deleteStore`: removed the `audit_log` delete line and replaced it with a one-line comment. The other six awaits and their order are unchanged. `cleanupOldRecords`, `addAuditEvent` and `fetchAuditLog` are unchanged.

**Review fix pass (2026-10-22, backend-developer; local stack only, prod untouched)**

Addresses the release proposal's in-scope items 1-5 plus owner decision 9 (security M1). L4 and L1 were not folded in (F-170-5, F-170-6).

- `supabase/migrations/20261022000000_audit_log_rls_hardening.sql`: added policy (f) `audit_log_restrict_insert_created_at_now` (RESTRICTIVE INSERT, `with check (created_at = now())`) with a `spec 170:` comment; header shape list, FORCE-RLS and restrictive notes, and the rollback block (one more `drop policy if exists`) updated. Re-applied locally via `psql` (twice, re-runnable).
- `supabase/tests/audit_log_rls_hardening.test.sql`: `plan(45)` → `plan(54)`. S-1 expects seven policies, S-6 expects five comments. Added C-1..C-8 (decision 9 / AC-22, AC-23) and D-10 (wide-SELECT probe; clause-isolating AC-14 arm with a visibility precondition; new fixture `…0027`). D-4's comment and message now say it is SELECT-masked. Header arm map updated.
- `supabase/tests/super_admin_policy_parity.test.sql`: AL-8 fixture `…0004` aged to `now() - interval '91 days'`; stale prose fixed (header legend, Spec 170 amendment paragraph, AL-7/AL-8 fixture note, AL-7 and AL-8 arm comments, AL-8 message). `plan(20)` unchanged.
- `src/lib/db.ts`: comment-only. In `deleteStore`, the `// Delete all related data first` comment is now `// Delete related data explicitly first, except audit_log (left to the stores FK cascade)`. ("non-cascading" was not used, because the other five tables' `store_id` FKs are also ON DELETE CASCADE locally.)
- `specs/170-audit-log-rls-hardening.md`: decision 9, AC-22/AC-23, the L3 Risks sentence, §1 SQL and design notes, the §4 contract row, §10a/§10b, the §12 post-check, §13, follow-ups F-170-5/F-170-6, and this list.

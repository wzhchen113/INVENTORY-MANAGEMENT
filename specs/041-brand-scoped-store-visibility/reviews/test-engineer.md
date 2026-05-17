## Test report for spec 041 (re-review after fix pass)

### Acceptance criteria status

- **AC1** — `public.auth_can_see_store(p_store_id uuid)` is redefined so that (a) `auth_is_super_admin()` callers return `true` for every store; (b) `auth_is_admin()` callers return `true` ONLY when `auth_can_see_brand(s.brand_id)` passes; (c) any other caller returns `true` only via `user_stores` row.
  → **PASS** — Migration implements the three-arm body verbatim. Arms (1)+(2) cover (b), arm (3) covers (a), arms (5)+(6) cover (c). All 10 pgTAP assertions green.

- **AC2** — Redefinition lives at exactly `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`.
  → **PASS** — File confirmed at that path.

- **AC3** — `CREATE OR REPLACE FUNCTION` (no signature change), `language sql stable security definer set search_path = public, auth`, and re-applies `grant execute … to authenticated, anon`.
  → **PASS** — Signature is `(p_store_id uuid) returns boolean`, `language sql stable security definer set search_path = public, auth`, and `grant execute on function public.auth_can_see_store(uuid) to authenticated, anon;` is present. All attributes match the 012a definition.

- **AC4** — No RLS policy text changes. Every policy that calls `auth_can_see_store(store_id)` continues to compile; helper truthiness tightens at the call site.
  → **PASS** — Migration contains no `create policy`, `alter policy`, `drop policy`, `enable row level security`, or `disable row level security` DDL. The 100+ call sites across migrations are byte-identical to before.

- **AC5** — pgTAP test at `supabase/tests/auth_can_see_store_brand_scope.test.sql` covers all scenario arms including (1) admin own-brand → true; (2) admin foreign-brand → false; (3) super_admin both brands → true; (4) master own-brand → true; (5) staff with `user_stores` grant → true; (6) staff with no grant → false; (7) brand-admin self-PATCH on `brand_id` rejected; (8) brand-admin self-PATCH on `role` rejected; (9) super_admin can update another user's `brand_id`; (10) end-to-end chain closure after rejected self-PATCH.
  → **PASS** — File confirmed at exact path. `select plan(10)` matches 10 assertions. Ran single-file: `1/1 PASS (10 assertion(s) passed)`.

- **AC6** — After migration, a PostgREST GET as Bobby against `/rest/v1/stores?select=*` returns ONLY rows where `brand_id` matches his `profiles.brand_id`. (Smoke-able via shell smoke; not required as CI gate.)
  → **NOT TESTED** — The spec marks this as "Smoke-able via shell smoke; not required as a CI gate." No shell smoke script was added; per the spec's explicit "not required" language this is acceptable and non-blocking. The helper-level pgTAP tests provide functional coverage of the predicate that drives this behavior.

- **AC7** — After migration, PostgREST GET as Bobby against per-store tables with a foreign `store_id` returns `[]` (RLS filter). Enumerated tables: `inventory_items`, `eod_submissions`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items`, `inventory_counts`, `inventory_count_entries`, `order_schedule`, `report_runs`, `report_definitions`, related artifacts.
  → **NOT TESTED** (cascade downstream) — No per-table RLS cascade test was written. The spec's design §9 argues that helper-level testing is sufficient because the helper is the single source of truth for the truthiness that cascades through every policy. This is an architectural choice, not a gap: the helper is `SECURITY DEFINER` and called directly from each policy's `USING` clause — tightening the helper by construction tightens every downstream table. A downstream cascade test on one representative table (e.g., `inventory_items`) would add confidence, but the spec explicitly chose helper-level testing only. Flagged as a **Nit** (non-blocking); no AC requires a cascade test.

- **AC8** — All existing pgTAP tests under `supabase/tests/*.test.sql` continue to pass.
  → **PASS** — Full suite run: `26/26 DB test file(s) passed`. This includes all 25 pre-existing files plus the new spec 041 file.

- **AC9** — No client-side code changes ship with this spec.
  → **PASS** — No changes to `src/components/cmd/TitleBar.tsx`, `src/lib/db.ts`, `src/store/useStore.ts`, `supabase/functions/*`, or `supabase/config.toml` are present in the working tree.

### pgTAP arms 7-10 — detailed hermetic analysis

**Arm (7): brand-admin self-PATCH on `brand_id` → raises stable error.**
Role: `authenticated`, JWT `sub=admin_id`, `app_metadata.role='admin'`. The arm issues a direct SQL `UPDATE public.profiles SET brand_id = brand_b WHERE id = admin_id` under the impersonated JWT. The `profiles_self_brand_lock` BEFORE UPDATE trigger fires; it detects `old.id = auth.uid()` (self-edit) and `not auth_is_super_admin()` (caller is role='admin', not 'super_admin'); `old.brand_id IS DISTINCT FROM new.brand_id` is true → `raise exception 'brand_id is read-only for self-edits (super_admin only)'`. pgTAP `throws_ok` asserts SQLSTATE `P0001` and the exact stable message. **This correctly exercises the trigger.**

What it covers: direct SQL UPDATE path (which is the same path PostgREST PATCH resolves to at the DB layer — PostgREST translates `PATCH /rest/v1/profiles?id=eq.<self>` to a `UPDATE public.profiles SET ... WHERE id = <self>` statement, which the trigger intercepts). The trigger fires regardless of which RLS policy admitted the UPDATE, so it covers both the "Users can update own profile" and the "Admins can update any profile" paths in a single place.

**Arm (8): brand-admin self-PATCH on `role` → raises stable error.**
JWT unchanged from arm (7). Issues `UPDATE public.profiles SET role = 'super_admin' WHERE id = admin_id`. Trigger detects `old.role IS DISTINCT FROM new.role` → `raise exception 'role is read-only for self-edits (super_admin only)'`. pgTAP `throws_ok` asserts `P0001` + stable message. **This correctly exercises the trigger's role lockdown.** The note in the test is accurate: any role value (not just 'super_admin') would be rejected because the trigger compares `old.role IS DISTINCT FROM new.role` without inspecting the target value.

**Arm (9): super_admin can update ANOTHER user's `brand_id` (positive control).**
JWT `sub=master_id`, `app_metadata.role='super_admin'`; at this point in the transaction `master_id`'s profile row has `role='super_admin'` (promoted in arm 3). The arm UPDATEs `profiles SET brand_id = brand_b WHERE id = manager_id` — a cross-user write. Trigger fires: `old.id = manager_id != auth.uid() = master_id` → the `old.id = auth.uid()` predicate is false → the lockdown branch is skipped → write proceeds. pgTAP `is()` asserts the write landed. **This correctly verifies the trigger does not over-block.** Note: `auth.uid()` returns NULL for the postgres superuser, so the `reset role` + direct UPDATE at lines 336-340 in arm (10)'s setup also bypasses the trigger safely.

**Arm (10): end-to-end proof — after rejected self-PATCH, foreign brand still inaccessible.**
Setup: `reset role` (postgres superuser) re-affirms `admin_id.brand_id = brand_a` with a conditional UPDATE guarded by `brand_id IS DISTINCT FROM brand_a` — this is a no-op in practice because arm (7)'s UPDATE was rejected and never committed (the exception aborted the statement, not the transaction, and `throws_ok` absorbs the error). Then re-impersonates admin_id with `app_metadata.role='admin'` and calls `auth_can_see_store(store_b)`. Expected: `false`. The helper evaluates: `auth_is_super_admin()` → false (profile still `role='admin'`); `auth_is_admin() AND auth_can_see_brand(store_b.brand_id)` → `auth_can_see_brand(brand_b)` checks `profiles WHERE id=admin_id AND brand_id=brand_b` → no row (brand_id is still brand_a) → false; `user_stores` → no grant → false. Result: `false`. **This correctly closes the privilege-escalation chain end-to-end.**

### Pre-flight DO block: now uses `raise exception`

The previous round flagged the pre-flight as using `raise warning` — contract drift from the architect's design. The fix pass corrected this to `raise exception` at line 81. The migration comment block was also simplified (no `v_bad_count` variable) and documents the `raise exception` semantics. The nit from the previous report is **resolved**.

### New gap analysis: INSERT path and trigger coverage breadth

**Is there a test for the INSERT path (brand-admin INSERTs a profile row with a different brand_id)?**

The `profiles_self_brand_lock` trigger is `BEFORE UPDATE` only — it does not fire on INSERT. No test verifies the INSERT path. However, **the INSERT path is not a viable vector for the specific spec 041 privilege-escalation attack** for the following structural reasons:

1. A brand-admin's own profile row exists with `id = auth.uid()` as a primary key. A self-INSERT of that row would fail with a primary key constraint violation before any trigger fires.
2. A brand-admin inserting a *different* user's profile row with a foreign `brand_id` would affect that other user's brand visibility — not the attacker's own `auth_can_see_store` evaluation, which reads the attacker's own `profiles.brand_id` via `auth.uid()`.
3. `profiles.id` is a FK to `auth.users(id) ON DELETE CASCADE`. A brand-admin cannot create a new `auth.users` row via PostgREST — only via the admin SDK / invite edge function. So they cannot manufacture a new victim profile to insert.
4. The `profiles_role_brand_consistent` CHECK constraint would block inserting an 'admin' profile with `brand_id = foreign_brand` without the FK pointing to a pre-existing `brands` row.

**Verdict:** The INSERT path gap is a **Nit** (non-blocking) for the spec 041 attack chain. The trigger's `BEFORE UPDATE` scope is correct and sufficient for the specific escalation being fixed. The broader "Admins can insert any profile" INSERT policy gap (the wide-open WITH CHECK clause that allows any authenticated user to insert any profile) is a pre-existing concern explicitly deferred to a follow-up spec (noted in spec §"Known follow-up work").

**Is there a test that the trigger fires for ALL update paths — PostgREST PATCH, RPC, and direct SQL?**

- **PostgREST PATCH:** Covered implicitly. PostgREST `PATCH /rest/v1/profiles?id=eq.<self>` translates to a database-level `UPDATE` statement. The `profiles_self_brand_lock` BEFORE UPDATE trigger fires on every UPDATE regardless of which client path admitted it. Arm (7) exercises the DB-level UPDATE (which is what PostgREST emits); there is no separate PostgREST HTTP smoke test, which would require a shell smoke test. This is a **Nit** — acceptable because the trigger fires at the Postgres layer, not at the PostgREST API layer.
- **RPC path:** No RPC in the codebase issues `UPDATE public.profiles SET brand_id = ...` on behalf of a non-super_admin caller in a way that would bypass the trigger. The `delete-user` edge function calls `auth.admin.deleteUser`, not a profile UPDATE. The trigger fires at the Postgres layer on any UPDATE, so an RPC-issued UPDATE would also be intercepted. No separate RPC test is present; Nit only.
- **Direct SQL:** Arm (7) uses a direct SQL UPDATE — this is the most direct trigger coverage path. Covered.

**Is there a test for the super_admin self-PATCH case (arm 9 positive control is cross-user, not self)?**

Arm (9) exercises super_admin updating ANOTHER user's brand_id. There is no arm that tests super_admin updating their OWN brand_id. The trigger body allows this (`not auth_is_super_admin()` is false for a super_admin, so the lockdown branch is skipped entirely). The absence of this specific positive-control arm is a **Nit** — the trigger's logic makes it correct by construction and the arm (9) already verified the `auth_is_super_admin()` short-circuit works.

### Cascade downstream tests

No test verifies end-to-end RLS filtering on a specific per-store table. The spec deliberately chose helper-level pgTAP as sufficient coverage. Nit; non-blocking.

### Realtime channel test gap

No test verifies that a brand-A admin subscribed to a brand-B store's Realtime channel receives no events. Structurally impossible from pgTAP. Nit per spec §7; non-blocking.

### Test run

```
bash scripts/test-db.sh supabase/tests/auth_can_see_store_brand_scope.test.sql
  PASS supabase/tests/auth_can_see_store_brand_scope.test.sql (10 assertion(s) passed)
  1/1 DB test file(s) passed

bash scripts/test-db.sh  (full suite)
  PASS admin_rpcs_privileged.test.sql (3)
  PASS auth_can_see_store_brand_scope.test.sql (10)
  PASS copy_brand_catalog.test.sql (5)
  PASS delete_last_privileged_guard.test.sql (4)
  PASS eod_submissions_consistency.test.sql (6)
  PASS eod_submissions_edit_flow.test.sql (4)
  PASS inventory_count_entries_check_store.test.sql (3)
  PASS inventory_counts_append_only.test.sql (5)
  PASS inventory_counts_set_submitted_by.test.sql (3)
  PASS invitations_super_admin_rls.test.sql (4)
  PASS profiles_locale.test.sql (10)
  PASS recipe_categories_super_admin_rls.test.sql (5)
  PASS report_reorder_list_hybrid_formula.test.sql (5)
  PASS report_reorder_list_min_dow.test.sql (5)
  PASS report_reorder_list_on_hand_source.test.sql (3)
  PASS report_run_cogs.test.sql (5)
  PASS report_run_custom.test.sql (14)
  PASS report_run_unknown_template.test.sql (4)
  PASS report_run_variance_formula.test.sql (7)
  PASS report_run_variance_multivendor_sum.test.sql (4)
  PASS report_run_velocity.test.sql (11)
  PASS report_run_vendor.test.sql (11)
  PASS report_run_waste.test.sql (11)
  PASS reports_anon_revoke.test.sql (12)
  PASS user_data_i18n_names.test.sql (17)
  PASS vendors_role_access.test.sql (4)
  26/26 DB test file(s) passed

npm run typecheck -> exit 0
```

### Notes

1. **Pre-flight RAISE EXCEPTION (resolved).** The previous review flagged the pre-flight as using `raise warning` — contract drift from the architect's design. The fix pass corrected this to `raise exception`. The nit is closed; no remaining deviation from the spec's stated fail-closed contract.

2. **INSERT path not covered by trigger (Nit, non-blocking).** The `profiles_self_brand_lock` trigger is `BEFORE UPDATE` only. No pgTAP arm exercises the INSERT path. However, the INSERT path is structurally blocked from being the specific spec 041 escalation vector: a brand-admin's own profile row already exists (PK collision), they cannot create new `auth.users` rows via PostgREST, and inserting another user's profile only affects that user's brand_id, not the attacker's. The deferred "Admins can insert any profile" policy gap is a separate follow-up concern. Non-blocking for spec 041.

3. **PostgREST PATCH and RPC paths not separately smoked (Nit, non-blocking).** Arm (7) exercises a direct SQL UPDATE, which is the exact operation PostgREST PATCH emits at the database layer. The trigger fires at the Postgres layer regardless of which client path admitted the UPDATE. No shell smoke verifies the HTTP path end-to-end; this would require extending `scripts/smoke-edge.sh` or writing a new RPC-path test. Non-blocking.

4. **Cascade downstream tests absent (Nit, non-blocking).** Same as previous review. The spec explicitly elected helper-level pgTAP as sufficient. No AC requires a per-table downstream cascade test.

5. **Realtime isolation not testable from pgTAP (Nit, non-blocking).** Same as previous review. Acknowledged by spec §7.

6. **Shell smoke for AC6 not added (Nit, non-blocking).** Same as previous review. Spec explicitly marks AC6 as "smoke-able; not required as a CI gate."

7. **All Criticals from the previous review are now cleared.** The two blocking findings from round 1 — (a) `raise warning` vs `raise exception` in the pre-flight DO block and (b) the unaddressed privilege-escalation chain (brand-admin self-PATCH of `brand_id`) — have both been resolved. The pre-flight now uses `raise exception`, and the `profiles_self_brand_lock` BEFORE UPDATE trigger closes the escalation chain. Arms (7)-(10) in the expanded test file verify both fixes directly.

8. **No jest or UI changes.** Confirmed — this is a backend-only spec. No jest test additions required or present.

## Test report for spec 042

### Acceptance criteria status

- **AC1** — Migration exists at exactly `supabase/migrations/20260517050000_rls_hardening_followups.sql` → **PASS** — File confirmed at that path. `ls -la` shows it exists at the required timestamp slot.

- **AC2** — `"Admins can write order_schedule"` re-created as FOR ALL with `using (auth_is_privileged() AND auth_can_see_store(store_id))` AND `with check (auth_is_privileged() AND auth_can_see_store(store_id))` → **PASS** — Live `pg_policies` query confirms `cmd=ALL`, USING and WITH CHECK both match the spec exactly.

- **AC3** — `"Admins can update any profile"` re-created with brand-scoped admin arm + self-arm in both USING and WITH CHECK → **PASS** — Live policy text matches spec exactly: `((auth_is_privileged() AND auth_can_see_brand(brand_id)) OR (id = auth.uid()))` on both clauses. FOR UPDATE confirmed.

- **AC4** — `"Users can update own profile"` re-created with `with check (id = auth.uid())` mirroring USING → **PASS** — Live policy confirms both USING and WITH CHECK are `(id = auth.uid())`. FOR UPDATE confirmed.

- **AC5** — All three changes use `drop policy if exists` + `create policy` (idempotent) → **PASS** — All three drop-if-exists + create sequences confirmed in the migration file.

- **AC6** — pgTAP test at `supabase/tests/rls_hardening_followups.test.sql` covering arms (a)-(h) → **PASS with notes** — File exists and 15/15 arms pass. Full mapping below. One coverage sub-gap noted (see Notes).

- **AC7** — All 26 existing pgTAP test files continue to pass → **PASS** — Full suite 27/27 (26 pre-existing + 1 new). Spec 041 regression file `auth_can_see_store_brand_scope.test.sql` confirmed 14/14.

- **AC8** — No client-side code changes ship with this spec → **PASS** — `git diff --cached --name-only` shows only `specs/`, `supabase/migrations/`, and `supabase/tests/` in staged area. No `src/` changes.

- **AC9** — No RPC body changes; fix lives entirely in policy text + helper composition → **PASS** — No `supabase/functions/` changes staged. No helper-function changes in the migration. Confirmed via `git diff --cached -- supabase/functions/`.

### pgTAP arm-to-AC mapping

| Spec AC sub-arm | Covered by test arm(s) | Status |
|---|---|---|
| (a) super-admin can INSERT/UPDATE/DELETE order_schedule in any brand | Arm 7 (INSERT only) | Partial — see Notes |
| (b) brand-A admin can INSERT/UPDATE/DELETE order_schedule in brand-A | Arms 1, 2, 3 | PASS |
| (c) brand-A admin CANNOT INSERT/UPDATE/DELETE in brand-B store | Arms 4 (INSERT, 42501), 5 (UPDATE, 0 rows), 6 (DELETE, 0 rows) | PASS |
| (d) brand-A admin CANNOT UPDATE brand-B user profile | Arm 9 (0 rows) | PASS |
| (e) brand-A admin CAN UPDATE brand-A user's profile | Arm 8 (name rename confirmed) | PASS |
| (f) super-admin CAN UPDATE any profile including brand-B | Arm 10 (cross-brand name rename confirmed) | PASS |
| (g) regular user CAN UPDATE own profile under WITH CHECK-armed policy | Arm 11 (dark_mode = true confirmed) | PASS |
| (h) regular user CANNOT UPDATE with id=other-uuid in SET | Arm 12 (42501 row-key forgery confirmed) | PASS |
| Row J: brand-A admin promoting same-brand other user to super_admin BLOCKED | Arm 13 (P0001 + 'role changes require super_admin') | PASS |
| Row F: brand-A admin brand_id transfer blocked by WITH CHECK | Arm 14 (42501 confirmed) | PASS |
| Trigger positive control: super_admin CAN promote another user | Arm 15 (role=super_admin confirmed) | PASS |

### Architect's §9 coverage matrix (Q1 rows A-J)

The spec's Q1 matrix has 10 rows (A-J). Test coverage by row:

| Matrix row | Scenario | Covered | Test arm |
|---|---|---|---|
| A | brand-A admin self-UPDATE of non-locked columns | Implicitly via arm 11 (manager self-UPDATE) | PASS (analogous) |
| B | brand-A admin self-UPDATE of brand_id | Covered by Spec 041 arm 7 (regression check passed 14/14) | PASS |
| C | brand-A admin self-UPDATE of role | Covered by Spec 041 arm 8 (regression check passed 14/14) | PASS |
| D | brand-A admin UPDATE same-brand other user non-locked columns | Arm 8 | PASS |
| E | brand-A admin UPDATE brand-B user (any column) | Arm 9 | PASS |
| F | brand-A admin cross-user brand_id transfer to foreign brand | Arm 14 | PASS |
| G | super_admin UPDATE any user (any column) | Arms 10, 15 | PASS |
| H | regular user self-UPDATE non-locked columns | Arm 11 | PASS |
| I | regular user UPDATE own profile SET id=other-uuid | Arm 12 | PASS |
| J | brand-A admin promoting same-brand other user to super_admin | Arm 13 | PASS |

### Test run

```
bash scripts/test-db.sh supabase/tests/rls_hardening_followups.test.sql
  PASS  supabase/tests/rls_hardening_followups.test.sql (15 assertion(s) passed)
✓ 1/1 DB test file(s) passed

bash scripts/test-db.sh supabase/tests/auth_can_see_store_brand_scope.test.sql
  PASS  supabase/tests/auth_can_see_store_brand_scope.test.sql (14 assertion(s) passed)
✓ 1/1 DB test file(s) passed

bash scripts/test-db.sh  (full suite)
  PASS  supabase/tests/admin_rpcs_privileged.test.sql (3 assertion(s) passed)
  PASS  supabase/tests/auth_can_see_store_brand_scope.test.sql (14 assertion(s) passed)
  PASS  supabase/tests/copy_brand_catalog.test.sql (5 assertion(s) passed)
  PASS  supabase/tests/delete_last_privileged_guard.test.sql (4 assertion(s) passed)
  PASS  supabase/tests/eod_submissions_consistency.test.sql (6 assertion(s) passed)
  PASS  supabase/tests/eod_submissions_edit_flow.test.sql (4 assertion(s) passed)
  PASS  supabase/tests/inventory_count_entries_check_store.test.sql (3 assertion(s) passed)
  PASS  supabase/tests/inventory_counts_append_only.test.sql (5 assertion(s) passed)
  PASS  supabase/tests/inventory_counts_set_submitted_by.test.sql (3 assertion(s) passed)
  PASS  supabase/tests/invitations_super_admin_rls.test.sql (4 assertion(s) passed)
  PASS  supabase/tests/profiles_locale.test.sql (10 assertion(s) passed)
  PASS  supabase/tests/recipe_categories_super_admin_rls.test.sql (5 assertion(s) passed)
  PASS  supabase/tests/report_reorder_list_hybrid_formula.test.sql (5 assertion(s) passed)
  PASS  supabase/tests/report_reorder_list_min_dow.test.sql (5 assertion(s) passed)
  PASS  supabase/tests/report_reorder_list_on_hand_source.test.sql (3 assertion(s) passed)
  PASS  supabase/tests/report_run_cogs.test.sql (5 assertion(s) passed)
  PASS  supabase/tests/report_run_custom.test.sql (14 assertion(s) passed)
  PASS  supabase/tests/report_run_unknown_template.test.sql (4 assertion(s) passed)
  PASS  supabase/tests/report_run_variance_formula.test.sql (7 assertion(s) passed)
  PASS  supabase/tests/report_run_variance_multivendor_sum.test.sql (4 assertion(s) passed)
  PASS  supabase/tests/report_run_velocity.test.sql (11 assertion(s) passed)
  PASS  supabase/tests/report_run_vendor.test.sql (11 assertion(s) passed)
  PASS  supabase/tests/report_run_waste.test.sql (11 assertion(s) passed)
  PASS  supabase/tests/reports_anon_revoke.test.sql (12 assertion(s) passed)
  PASS  supabase/tests/rls_hardening_followups.test.sql (15 assertion(s) passed)
  PASS  supabase/tests/user_data_i18n_names.test.sql (17 assertion(s) passed)
  PASS  supabase/tests/vendors_role_access.test.sql (4 assertion(s) passed)
✓ 27/27 DB test file(s) passed

npm run typecheck
  (exit 0 — no output)
```

### Notes

**1. Staging gap — CRITICAL for the user to resolve before committing.**

The three files in `git add` (staged) are internally inconsistent with each other:

- `supabase/migrations/20260517050000_rls_hardening_followups.sql` (staged) contains `security definer` — the round-3 trigger body that the spec's §"Round-4 BLOCKER" section documents as empirically broken (under SECURITY DEFINER, `current_user` collapses to `postgres` inside the function body, making the `current_user in ('authenticated', 'anon')` cross-user branch permanently unreachable; Row J remains open).
- `supabase/tests/rls_hardening_followups.test.sql` (staged) asserts `P0001 + 'role changes require super_admin'` for arm 13 — correct for the round-4 implementation but the round-3 staged migration would cause arm 13 to FAIL with `23514` instead (the `profiles_role_brand_consistent` CHECK would catch it incidentally, not the trigger).
- `specs/042-rls-hardening-followups.md` (staged) ends at the round-4 BLOCKER handoff — the architect's resolution is not yet staged.

The working tree has the correct round-4 implementation: `security invoker` in the migration + the architect's round-4 resolution text in the spec. Tests pass because the local database has the working-tree migration applied (confirmed via `pg_proc.prosecdef = false`).

**The user must stage the working-tree migration and spec changes before committing, otherwise the commit will contain the broken round-3 trigger and arm 13 will fail on a fresh apply.**

To stage: `git add supabase/migrations/20260517050000_rls_hardening_followups.sql specs/042-rls-hardening-followups.md`

**2. AC (a) coverage sub-gap — minor, by architect's design.**

AC (a) requires test coverage for super-admin INSERT/UPDATE/DELETE on `order_schedule` in any brand. The architect's §Q5 table explicitly chose INSERT-only (arm 7) as the positive control for super-admin's cross-brand access via the `auth_is_super_admin()` short-circuit. UPDATE and DELETE use the same policy path (FOR ALL, same USING/WITH CHECK) and are not separately exercised for the super-admin caller. This gap is by-design per the architect's arm-count decision — the short-circuit is a single code path that INSERT exercises fully. Calling this NOT TESTED for the UPDATE/DELETE verbs under super-admin, but it is not a blocking concern given the explicit architect decision in §Q5.

**3. Spec 041 self-edit strings preserved.**

Arm 13 fires the `'role changes require super_admin'` message (cross-user branch). Arms 7 and 8 of `auth_can_see_store_brand_scope.test.sql` continue to fire `'brand_id is read-only for self-edits (super_admin only)'` and `'role is read-only for self-edits (super_admin only)'` respectively — confirmed by the 14/14 Spec 041 regression pass.

**4. Arm 5 and arm 6 role-management pattern.**

Arms 5 and 6 correctly clear the JWT claims before verifying via postgres-role, and arm 6 correctly re-impersonates the brand-A admin before the DELETE. The isolation pattern is sound and matches the spec §13 recommendation.

**5. Risk #3 and Risk #4 (out-of-scope gaps) are documented but not tested.**

Per the spec: "Admins can read all profiles" and "Admins can delete profiles" are explicitly out of scope for 042. No tests cover those paths. This is correct per spec — not a test gap for this spec. The release-coordinator should be aware that a brand-admin can still SELECT and DELETE cross-brand profiles after this spec ships.

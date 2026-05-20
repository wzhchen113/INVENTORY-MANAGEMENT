# Security audit for spec 051

Threat model: spec 051 closes a Critical RLS leak verified on prod where a legacy `auth_manage_stores` permissive ALL policy on `public.stores` (predicate `auth.uid() IS NOT NULL`) shadowed the scoped `store_member_read_stores` (SELECT) and `privileged_*_stores` (INSERT/UPDATE/DELETE) policies because Postgres ORs permissive policies. Same shape on `public.user_stores` via the legacy `Users can manage own store links` (OR-arm `auth.uid() IS NOT NULL`) and `Admins can manage all store links` (raw JWT app_metadata, no brand scope — the spec 042 shape gap). Read leak (Bobby saw every brand's stores) was the visible symptom; the latent WRITE leak (any authenticated user could INSERT/UPDATE/DELETE any store, or grant same-brand `user_stores` rows to other users) was the catastrophic case.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
- `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql:115-140` — informational, not a finding. The new brand-scoped admin policy on `user_stores` is correct: WITH CHECK mirrors USING, the EXISTS subquery references `user_stores.store_id` (not stale `id`), and the brand-check uses `auth_can_see_brand(s.brand_id)` (the brand-scoped helper, not the single-store helper). The architect's design-narrative note that cross-brand admin INSERT raises P0001 (trigger) rather than 42501 (RLS) is benign: the trigger fires BEFORE RLS WITH CHECK per documented Postgres execution order, both layers reject, and pgTAP arm (11) asserts the trigger raises first while arm (10) verifies the admin policy admits same-brand INSERTs — together those two arms prove the new policy is the structural backstop if the trigger is ever dropped or weakened. Defense-in-depth works.

### Verification of audit probes

1. **All four legacy policies dropped on the right tables.** Verified: `auth_manage_stores` on `stores` (line 81), `Users can manage own store links` + `Admins can manage all store links` on `user_stores` (lines 101-102), and the two `Authenticated can read *` SELECT policies on the categories tables (lines 157, 180). All five drops use `drop policy if exists` and all creates are preceded by a matching drop. No stale name drift. The scoped `store_member_read_stores`, `privileged_insert_stores`, `privileged_update_stores`, `privileged_delete_stores` policies from `20260509000000_multi_brand_schema_rls.sql:611-643` survive and now cover every command path on `public.stores` without OR-shadow.

2. **WITH CHECK on own-row `user_stores` policy.** Verified at `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql:104-110`: `using (user_id = auth.uid()) with check (user_id = auth.uid())`. Both clauses are present and identical. A user cannot UPDATE their `user_id` to forge ownership.

3. **Brand-scoped admin `user_stores` policy correctness.** Verified at lines 115-140: WITH CHECK present and identical to USING; EXISTS subquery references `user_stores.store_id` (correct outer-row reference); brand-check is `auth_can_see_brand(s.brand_id)` (correct helper — not a single-letter typo for `auth_can_see_store`). super_admin spans every brand via the short-circuit inside `auth_can_see_brand`.

4. **No new wide policies introduced.** Greppable scan of the migration for `using (auth.uid() IS NOT NULL)` and `using (true)` returned only the two intentional `to authenticated using (true)` rewrites on the categories SELECT policies (lines 159-164, 182-187). Both are explicitly role-gated to `authenticated` (which denies anon), match the curated-master-data intent from spec 004 + spec 013, and carry inline `comment on policy` annotations pinning the cross-brand intent for future audits. The legacy `auth.uid() IS NOT NULL` references in the migration body are documentation strings inside SQL comments and rollback hints — not executable policy text.

5. **Categories WRITE policies untouched.** Verified by cross-reading `supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql:37-48` (admin-gated INSERT/UPDATE/DELETE on `ingredient_categories`) and `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql:26-27` (`auth_is_privileged()` USING + WITH CHECK on `recipe_categories` writes). The spec 051 migration only DROPs + recreates the SELECT policies on each categories table; no WRITE policy is named in any DDL statement.

6. **Spec 041 closeout edit is strictly additive.** `git diff HEAD specs/041-brand-scoped-store-visibility.md` shows exactly one new line appended (line 1228) — a "Follow-up: spec 051" bullet under the Migrations subsection. No existing bullet is reworded or removed.

7. **CLAUDE.md addition is strictly additive.** `git diff HEAD CLAUDE.md` shows exactly one new bullet inserted before the "Imports" entry under "Conventions already in use". No existing bullet is reworded; the OR-shadow footgun convention sits alongside the existing conventions without weakening any. References spec 051's migration path and the forthcoming spec 052 linter as out-of-scope follow-up.

8. **No GRANT/REVOKE drift.** Greppable scan of the migration confirms zero `grant` or `revoke` statements. The role/grant state on every affected table is byte-identical post-migration; only the policy stack changes.

### pgTAP regression review
Thirteen arms cover every Matrix A/B/C/D row the spec acceptance criteria enumerated. Hermetic `begin; … rollback;` isolation pattern matches the project's canonical fixture style (`auth_can_see_store_brand_scope.test.sql`, `delete_last_privileged_guard.test.sql`). Arms (1)-(4) directly assert the Bobby read leak AND the latent WRITE leak are closed; arm (5) compacts the super_admin cross-brand no-regression case via `bool_and`; arms (8)-(11) cover the four legitimate vs. attacker `user_stores` paths including the belt-and-suspenders trigger+policy pair on the cross-brand INSERT.

### Dependencies
No package.json changes — skipped.

### Verdict
Migration cleanly drops the OR-shadow footgun on all four affected tables, replaces the two `user_stores` policies with correctly-scoped own-row + brand-scoped-admin pair (both with WITH CHECK), rewrites the two intentionally cross-brand categories SELECT policies for clarity with `comment on policy` annotations, and ships a thirteen-arm pgTAP regression covering both leak closures and no-regression cases. CLAUDE.md and spec 041 edits are strictly additive. No Critical, High, Medium, or actionable Low findings.

## Code review for spec 205

Scope: the migration, the two new pgTAP suites, and the four pin edits (read from the diff). I did not run anything. Findings are about readability, safety of the migration text, and maintainability. Equivalence, RLS correctness and coverage belong to the architect, security-auditor and test-engineer.

Checked and fine, no finding:
- All 36 `alter policy` statements match the design D-2.6 texts, and the `::uuid[]` cast is present in all 21 store-scoped rewrites.
- The R9 rollback block has 36 `alter policy` lines (35 + the multi-line invitations one), and drops the index and functions last.
- No rewritten qual names `auth_is_admin` (spec 157 LINT-1).
- No policy is added or dropped, so the permissive-OR rule (CLAUDE.md, specs 051/053) has nothing new to compose.
- Grants follow the sibling `auth_*` helpers and spec 097: revoke from public, grant to authenticated, anon and service_role.
- All four pin edits keep their original intent (details under Nits).
- Both new test files follow the established pgTAP track. `plan(56)` and `plan(3)` match the assertion counts I tallied.

### Critical
- None.

### Should-fix
- `supabase/tests/rls_visibility_once_per_query.test.sql:548-676` (AC-6 manifest) — maintainability cost is high for what it keeps proving.
  - The manifest is 126 rows of opaque md5 pairs covering every policy on 35 of the most actively edited tables (`inventory_items`, `purchase_orders`, `invitations`, `profiles`, ...). Any later spec that touches any policy on any of those tables, including write-side ones unrelated to visibility, fails this file. The failure message lists only `table.policy`, so the author cannot see what changed.
  - The md5s are also of `pg_policies` deparse text, so a Postgres major bump forces a full regeneration. The T3 comment already warns about this for one policy.
  - Its real job, proving the write side is byte-identical, was already done once (implementation notes, "AC-6 one-time diff").
  - Suggested fix: keep name, cmd, permissive, roles and per-`(table, cmd)` counts for all rows. Keep md5s only for the 36 rewritten quals and the two ALL `with_check` values. Alternatively, keep the full manifest but move the regeneration recipe from this file's header into `tests/README.md`, so the next author finds it from the failure.
- `supabase/tests/rls_visibility_once_per_query.test.sql:759-858, 937-979` (AC-2 old-vs-new) — this is a one-time migration proof, but the header only documents regenerating the AC-6 manifest.
  - `old_using` is frozen pre-205 text that calls `auth_can_see_store/brand`. AC-5b (L482-499) depends on those functions too.
  - The next spec that legitimately changes one of the 36 policies, or retires or changes `auth_can_see_store`, will fail AC-2 with "sees different rows". That is misleading: it is intended drift, not a leak.
  - Suggested fix: add a header paragraph saying what a later author does. For example: delete the AC-2 section once spec 205 is on prod, or re-baseline `old_using`. Say which arms are permanent (AC-5, AC-3, AC-6, AC-7) and which are migration-time only (AC-2, AC-5b).
- `supabase/tests/rls_per_row_helper_lint.test.sql:44-47, 72-74, 53-54, 80-81, 113-114` — the allowlist CTE and the offender predicate are copy-pasted three times.
  - The header tells future authors to "add one VALUES row" to the allowlist. As written they must add it in both arm 1 and arm 2, or arm 2 reports an offender that arm 1 accepted. Arm 3 repeats the predicate a third time, so editing the detection predicate in arms 1/2 will not fail arm 3.
  - Arm 3 also only exercises the `auth_can_see_store(` half; the brand half is never proven detectable.
  - Suggested fix: use one `create temp table allowlist` and one `create temp view offenders`. Have arm 1 count it and arm 2 aggregate it. Have arm 3 query the same view for the probe table, once for a store policy and once for a brand policy.
- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql:95-153` — the R9 rollback is less safe than the forward migration. It runs 36 `alter policy` statements, each taking an ACCESS EXCLUSIVE lock one at a time, with no up-front `lock table` in the forward order (profiles, stores and user_stores last).
  - That reintroduces the deadlock window the forward path was built to shorten (header L76-80). The rollback is the path used during an incident.
  - Suggested fix: put the same `lock table ... in access exclusive mode` list in the rollback block.
- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql:1-20, 161-164` — the header never says the migration is deliberately not replayable on top of itself.
  - The pre-flight raises on a second run, because all 36 policies are "missing" from the old-text set. Every other statement is idempotent, so a reader assumes a re-run is safe.
  - This matters for the MCP apply (project memory): if `execute_sql` succeeds but the `schema_migrations` insert fails, the right move is to insert the row, not to re-run.
  - Suggested fix: add one sentence to the header, "fail-closed pre-flight; re-running after success raises by design".
- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql:218, 220`; `supabase/tests/rls_visibility_once_per_query.test.sql:679, 691` — `string_agg(..., ', ' order by 1)`.
  - Inside an aggregate, `ORDER BY 1` is a constant expression, not a column position, so these do not sort. The reader assumes they do. Failure messages come out in arbitrary order.
  - Suggested fix: order by the real expression (`order by tablename, policyname`), or drop the clause.

### Nits
- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql:165-249` — the pre-flight pins the exact set of 36 policies. If spec 202/203/204 land first and add one more `auth_can_see_*` SELECT policy dated before this file, a fresh `db reset` fails here. That is fail-closed and probably desired, but one header line would help: "a new per-row policy dated before this file must be added to the expected list".
- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql:510-524` — the post-flight is thin.
  - `with_check like '%auth_can_see_%'` only proves the string is still mentioned.
  - `auth_visible_store_ids() is null` run as the migration role is vacuously false: `auth.uid()` is null there, so it always returns `'{}'`.
  - Neither is wrong. Consider comparing each ALL policy's `with_check` against the pre-flight-time value, saved in a `do $$` variable.
- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql:302-315` — in `auth_visible_store_ids()`, `public.auth_is_admin()` and the `exists (profiles ...)` are evaluated per `stores` row inside the helper. Tiny tables, so negligible. `where (select public.auth_is_admin())` would hoist the first one and is cheaper to read.
- `supabase/tests/rls_visibility_once_per_query.test.sql:702-712` vs `971-979` — the R6 `with_check` md5 assertion runs before the old/new round trip. The restore guard re-checks only `qual`. After the round trip nothing re-asserts that the two ALL policies' `with_check` survived. Move the R6 arm after the restore guard, or assert it in both places.
- `supabase/tests/audit_log_rls_hardening.test.sql` (S-3) and `supabase/tests/user_stores_own_row_writes.test.sql` (T3), from the pin diff — each now duplicates a policy text already pinned by an md5 in the AC-6 manifest (`686dfa73...` for the audit_log read policy). The next policy change means editing two places. If you take the manifest-narrowing suggestion above, keep these byte-exact pins as the only text pins.
- Pin edits, each keeps its original intent, with minor remarks:
  - `invitations_hardening` K-b: the SELECT branch only checks that `auth_profile_brand_id()` appears and `auth_can_see_brand(` does not. The old check was equally substring-level, so intent is preserved. The new SELECT text uses the helper in two places (brand arm and store-list arm), so a `like` count of at least 2 would pin both.
  - `report_last_order_context` P1b and its header comment: updated consistently. The expected string is unchanged, as designed.
  - T3: the comment now explains that the md5 refers to `with_check` only. Good.
- `supabase/tests/rls_per_row_helper_lint.test.sql:53-54` — the lint targets only the two `auth_can_see_*` names. A future SELECT policy that calls bare `auth_is_privileged()` or `auth_is_super_admin()` per row is not caught, although design D-2.2 wraps those too. Fine for v1; the header could say so.
- CLAUDE.md (owner decision, not an agent edit) — this lint now constrains every future SELECT/ALL policy on `public.*`, yet CLAUDE.md's RLS conventions never mention the InitPlan form. The spec already defers the bullet to the owner (design D-9 risk 2). Until then, the lint's failure message is the only documentation.
- (out-of-scope) The implementation notes record that `super_admin_read_all_profiles` still calls `auth_is_super_admin()` per row on the `updater:profiles` embed. This is correctly left for a follow-up spec alongside the `auth_rls_initplan` self-policy warnings.

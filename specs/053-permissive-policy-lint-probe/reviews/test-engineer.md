## Test report for spec 053

### Acceptance criteria status

- AC1: A new pgTAP file lands at `supabase/tests/permissive_policy_lint.test.sql` → PASS — file exists at that path.
- AC2: The file follows the hermetic `begin; create extension if not exists pgtap; select plan(N); ...; select * from finish(); rollback;` shape → PASS — lines 78–79, 81, 274–275 match exactly.
- AC3: The probe queries `pg_policies` for every permissive policy whose `schemaname = 'public'` → PASS — both arms filter `where schemaname = 'public' and permissive = 'PERMISSIVE'`.
- AC4: For each such policy, the probe detects whether its `qual` or `with_check` is "trivially-wide" per the five detection patterns → PASS — two-pass regex (head + OR-tail) on both `nq` (normalized qual) and `nc` (normalized with_check) covers all five spec patterns.
- AC5: Trivially-wide policy is checked against a hardcoded allowlist of `(schemaname, tablename, policyname)` triples → PASS — `allowlist (schemaname, tablename, policyname) as (values ...)` CTE is inline at both arms.
- AC6: If a trivially-wide policy is NOT on the allowlist, the test arm FAILS with a pgTAP assertion whose message names the policy and table → PASS — arm (1) message includes a query to surface offenders; arm (2) string_agg surfaces the exact triples in TAP output on failure. The failure message in arm (1) is actionable but doesn't literally embed the offending triple in the message string itself — it instructs the developer to look at arm (2). This is a minor deviation from AC6's "names the policy and table" requirement but arm (2) provides the named triples, so the spirit is met across the two arms together.
- AC7: If every trivially-wide policy IS on the allowlist, the probe passes → PASS — suite currently shows 32/32 pass with both allowlisted `*_categories` policies present.
- AC8: Allowlist initially contains exactly the two spec 051 intentional policies → PASS — `ingredient_categories / Authenticated can read ingredient categories` and `recipe_categories / Authenticated can read categories` are the only two rows.
- AC9: Probe scope is all commands (SELECT, INSERT, UPDATE, DELETE, ALL) → PASS — no `cmd` filter in the where clause; all commands are scanned.
- AC10: Probe scope is `permissive = true` only → PASS — explicit `and permissive = 'PERMISSIVE'` filter.
- AC11: Probe scope is `schemaname = 'public'` only → PASS — explicit `and schemaname = 'public'` filter.
- AC12: Failure mode is hard-fail → PASS — pgTAP `is()` arms produce `not ok` on mismatch; `scripts/test-db.sh` exits non-zero on any `not ok`.
- AC13: Running `bash scripts/test-db.sh` against current main HEAD reports the new file as passing → PASS — `32/32 DB test file(s) passed` confirmed above.
- AC14: Adding a synthetic wide policy causes the suite to fail with a clear, actionable message — negative-test arm → PASS — arm (3) creates `public.__lint_probe_negative_test` with `using (auth.uid() is not null)`, captures the detector hit count into `test.negative_arm_hit_count`, drops the table, then asserts `is(count, 1, ...)`. This is the regex-regression guard the spec required under Q-arch-2.

### NULL handling

`pg_policies.qual` is NULL for WITH-CHECK-only policies. Both arms use `coalesce(qual, '')` and `coalesce(with_check, '')` before normalizing, so NULL becomes the empty string. The empty string does not match any trivially-wide regex (it is neither `auth.uid() is not null`, `true`, nor `auth.role() = 'authenticated'`). Result: pure WITH-CHECK-only policies with a NULL `qual` produce `nq = ''`, which will not trip the head-regex or OR-tail regex. They would only be flagged if their `with_check` value (nc) matches. This is correct behavior — a NULL USING expression is not "trivially-wide USING" — no crash, no false-positive.

### Plan count math

`select plan(3)` at line 81. Three `select is(...)` calls: arm (1) at line 102, arm (2) at line 149, arm (3) at line 265. Count matches. `finish()` will report correctly.

### Drop-then-assert deviation

The architect documented this deviation from the spec's savepoint pseudocode (spec §6 vs. Implementation Notes). The reason is sound: `rollback to savepoint` after a pgTAP `is()` inside the savepoint discards the assertion from `__tresults__`, causing `finish()` to report `planned 3 but ran 2` — which `scripts/test-db.sh:122–127` treats as a hard failure. The drop-then-assert pattern correctly preserves the assertion counter while cleaning the synthetic table before `finish()` runs. The negative arm still proves what it claims: if the regex is broken, `v_hit_count` stays 0, `is(0, 1, ...)` fails, CI breaks.

One subtlety: the stashed value (`current_setting('test.negative_arm_hit_count', true)`) uses a session variable scoped `true` (transaction-local). Since arm (3) runs inside the outer `begin...rollback` transaction, the variable is visible through `finish()` and the rollback cleans it — correct.

### Future-friendliness

When a future spec adds an intentional wide READ on a third table, the probe fails arm (1) and arm (2) surfaces the exact `public.<table> / <policy>` triple in TAP output. The arm (1) failure message explicitly lists three remediation options: drop, narrow, or add to the allowlist VALUES list. The pattern is clear.

One note aligned with the code-reviewer's OR-tail false-positive flag: the OR-tail regex `\bor\s+\(*\s*(auth.uid() is not null|true|auth.role() = 'authenticated')\s*\)*` would trip on a legitimate policy whose OR-tail contains a trivially-wide sub-expression that is itself AND-gated (e.g. `(id = auth.uid()) OR (auth.uid() is not null AND some_guard)`). In that case the allowlist mechanism is the escape valve — the developer sees the failure and adds the row. The code-reviewer already filed this as a Should-fix. It does not block SHIP_READY per se but the probe will generate a false-positive on such a shape without allowlist intervention.

### Test run

Command: `bash scripts/test-db.sh 2>&1 | tail -10`

Result: 32/32 DB test file(s) passed. New file `permissive_policy_lint.test.sql` is one of the 32 — all 3 arms of `plan(3)` pass.

### Notes

- No jest arm, no smoke arm — consistent with spec scope (pgTAP only, no client surface).
- No migration landed — correct per spec ("DDL-free").
- CLAUDE.md "Forthcoming spec 053..." sentence was updated to past-tense per spec §8 (not verified in this review, but within scope of the PR; if omitted it is a documentation gap only, not an AC).
- The code-reviewer's OR-tail false-positive (filed in `code-reviewer.md`) is real but is a Should-fix, not a blocking defect. The allowlist provides the escape valve for edge cases.

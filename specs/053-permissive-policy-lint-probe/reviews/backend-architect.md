# Spec 053 — Backend architect post-impl drift review

Status under review: READY_FOR_REVIEW. Read-only. The architect designed the
spec; this is a check against the contract in §1-17, not a re-deliberation.

## Verdict

No architectural drift. Zero Critical, zero Should-fix, two Minor (both
documentation-shape, not correctness).

## Checklist results

1. **File path + framing** — `supabase/tests/permissive_policy_lint.test.sql`
   present. Hermetic `begin; create extension if not exists pgtap; select
   plan(3); ...; select * from finish(); rollback;` shape matches §2 exactly.
2. **Allowlist matches §4** — exactly 2 rows, both `*_categories` SELECT
   policies, identical schemaname/tablename/policyname literals. Repeated
   verbatim in arm (1) and arm (2). Q-arch-1 enumeration unchanged.
3. **Regex matches §6** — two-pass head + OR-tail. Head anchor
   `^\s*\(*\s*(...)\s*\)*(\s+or\s+.*)?\s*$` and OR-tail `\bor\s+\(*\s*(...)\s*\)*`
   appear identically on both `nq` and `nc` in all three arms. AND-guard
   exclusion is correct (the anchored optional `(\s+or\s+.*)?\s*$` falls off
   on AND-tails). All three trivially-wide tokens listed.
4. **Negative arm structure** — synthetic table named
   `__lint_probe_negative_test` per design's `__`-prefix marker rule.
   Synthetic policy uses `using (auth.uid() is not null)` — the canonical
   spec 051 root-cause shape, which is the correct regex-regression
   anchor.
5. **CLAUDE.md edit byte-exact** — line 66 contains the §8 replacement
   sentence verbatim: `Spec 053 ([supabase/tests/permissive_policy_lint.test.sql](supabase/tests/permissive_policy_lint.test.sql)) enforces this via a pgTAP CI probe that fail-builds...`.
   Zero occurrences of "Forthcoming spec 053" remain. No other CLAUDE.md
   lines mutated.
6. **Plan count** — `plan(3)` matches §7. Developer kept arms (1)+(2)
   separate, did not collapse, did not drop arm (3). Permitted.

## Deviation evaluation (drop-then-assert pattern)

**Architecturally sound.** The dispatching prompt asked three questions:

1. **Is the deviation sound?** Yes. pgTAP's `__tcache__`/`__tresults__` ARE
   temp tables; `rollback to savepoint` after an `is()` inside the savepoint
   DOES discard the assertion from the counters, which DOES trip
   `scripts/test-db.sh:122-127`'s "planned N but ran M" silent-skip guard.
   The dev's pattern (create policy → run detector → `set_config()` stash →
   DROP policy + table → `is()` on stashed value) preserves hermetic
   isolation: the synthetic policy is created, exercised against the same
   detection CTE arms (1)+(2) use, and gone before `finish()` runs. The
   outer `rollback;` is belt-and-suspenders. `set_config(..., true)` (the
   third arg = is_local) scopes the GUC to the outer transaction, which
   also rolls back. No state leaks past `finish()`.

2. **Did it change the contract?** No. §6's contract is "synthetic wide
   policy is detected by the probe within hermetic isolation." Both
   savepoint and drop-then-assert satisfy that contract. The literal
   `savepoint + rollback to savepoint` in §6's pseudocode was a shape
   guess; the architect did not test it. The dev hit the pgTAP-counter
   constraint in implementation and refined to a pattern that meets the
   same contract — design refinement, not contract violation.

3. **Should the spec be amended?** Yes. The drop-then-assert pattern is
   the right canonical shape for ANY future pgTAP test that mutates schema
   inside a negative-arm assertion. The savepoint pattern only works when
   the mutation is observed via a NON-pgTAP query (e.g. arm (5) of
   `legacy_permissive_policy_dropout.test.sql` uses `do $$ ... bool_and
   ... $$` which never calls `is()` inside the savepoint — that's why the
   savepoint trick works there). Recommended: a one-line addendum to §6
   noting "if the negative arm's `is()` runs inside the savepoint, use
   `set_config()` + explicit DROP instead of `rollback to savepoint`;
   pgTAP's `__tcache__`/`__tresults__` are temp tables." Not blocking;
   future-architect documentation hygiene.

## Minor findings

- **M1 (doc).** The header comment of the test file already documents the
  pgTAP-counter rationale (lines 56-66). Good. The spec body §6 still
  shows the literal `savepoint` pseudocode. Future architects reading the
  spec without the test file will re-tread this. Recommend a one-line edit
  to §6 acknowledging the actual implementation choice. **Not blocking.**
- **M2 (doc).** The detection CTE is duplicated three times (arms 1, 2, 3).
  The header comment (lines 86-91) calls this out — "CTEs cannot persist
  across statements." Correct per pgTAP. A future v2 could collapse via a
  temp-table helper, but that's an optimization, not a defect. Mentioned
  only so the reviewer fan-out does not flag it as DRY-violation drift.

## Files reviewed

- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/permissive_policy_lint.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/CLAUDE.md` (line 66 only)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/053-permissive-policy-lint-probe.md`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/scripts/test-db.sh` (lines 110-127 — silent-skip guard cited in the deviation rationale)

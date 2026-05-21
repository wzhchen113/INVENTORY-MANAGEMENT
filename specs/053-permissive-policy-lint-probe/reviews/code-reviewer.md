# Code review — Spec 053

Date: 2026-05-20
Reviewer: code-reviewer

## Verdict

0 Critical, 2 Should-fix, 3 Nits.

## Critical

None.

## Should-fix

- **`supabase/tests/permissive_policy_lint.test.sql:121-122`** — OR-tail regex false-positive. The pattern `\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*` has no closing anchor after the optional-paren group. A policy whose OR-arm reads `OR (auth.uid() is not null AND scoped_thing)` would false-positive: the regex matches at `or (auth.uid() is not null` and `\)*` matches zero closing parens (the `)` belongs to `AND scoped_thing)`). The spec §3 exclusion list says `auth.uid() IS NOT NULL AND <scoped predicate>` must NOT flag, but that exclusion only holds for the head-position regex (which is end-anchored). The OR-tail case is unguarded.

  Suggested fix: tighten the OR-tail close to `\s*\)*\s*($|\s+or\b)` plus a negative lookahead `(?!\s+and\b)` after the trivially-wide token — i.e. after the optional closing-paren, require end-of-string or another OR, and the AND-suffix lookahead excludes the `OR (wide AND scoped)` construction.

  Negative arm (3) only creates a pure `using (auth.uid() is not null)` policy without an AND suffix, so this regression is not caught by the current test suite. A second synthetic-policy arm covering `OR (wide AND scoped)` (which should NOT flag) would close the gap.

- **`supabase/tests/permissive_policy_lint.test.sql:84-96`** — Comment block accuracy. The justification for threefold copy of the detection CTE says "cost ≈ 10 duplicated lines" but the actual duplicated block is ~20 lines per copy. This is fine for v1 given the constraint (CTEs can't persist across statements), but the comment should update the line-count so the next maintainer's mental model is accurate. Alternatively, a SQL function or temp view created once inside the transaction (before `select plan(3)`) could hold the normalized CTE and be queried by each arm — but introduces its own fragility. At minimum, correcting "~10 duplicated lines" to "~20 duplicated lines" makes the comment honest.

## Nits

- **`supabase/tests/permissive_policy_lint.test.sql:265-271`** — Arm (3)'s `is()` message says "If this arm fails, the head-position regex has regressed" but the synthetic policy it creates exercises only the head-position branch (using `auth.uid() is not null` with no OR-tail). A future regression that breaks only the OR-tail regex (lines 121-122) would leave arm (3) passing. Failure message could say "head-position regex or synthetic-policy creation" and note that the OR-tail branch has no dedicated negative arm. Documentation nit, not correctness issue.

- **`supabase/tests/permissive_policy_lint.test.sql:133-141`** — Arm (1) failure message embeds a raw SQL snippet in backticks inside the pgTAP assertion string. TAP output tools that render markdown may misformat this, but psql's raw TAP output is unaffected. Non-blocking.

- **`CLAUDE.md:66`** — Updated sentence reads "enforces this via a pgTAP CI probe that fail-builds on any future permissive policy in `public.*` whose USING or WITH CHECK is trivially-wide". The phrase "fail-builds" is hyphenated inconsistently with the rest of the bullet ("fails-build" appears later in the same sentence as "fail-builds"). One of them should be changed to match the other. Non-blocking.

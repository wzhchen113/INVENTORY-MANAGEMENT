## Code review for spec 097

Reviewed files:
- `supabase/migrations/20260618000000_public_grants_explicit.sql`
- `supabase/tests/public_grants_explicit.test.sql`
- `.github/workflows/test.yml` (Track 2 `db` job)
- `CLAUDE.md` (line 205)

Other reviewers already cleared the design-drift (backend-architect), security crux
(security-auditor), and acceptance-criteria coverage (test-engineer) with zero
Criticals. This review focuses exclusively on craftsmanship: naming, comment
accuracy, comment completeness for future maintainability, and idiomatic pgTAP.

### Critical

None.

### Should-fix

- `supabase/tests/public_grants_explicit.test.sql:277-304` — Arm (3)'s DO block
  scans all three roles (`anon`, `authenticated`, `service_role`) against the
  synthetic table, but only `authenticated`'s SELECT was revoked (line 275). The
  assertion `is(..., 1, ...)` is correct — `anon` retains SELECT from `ALTER
  DEFAULT PRIVILEGES` and `service_role` retains ALL — but neither the arm comment
  (lines 256-273) nor the `is()` message (lines 301-303) explains *why* the expected
  count is 1 instead of 2. A future maintainer who sees "3 roles scanned, revoked
  from 1, expected count = 1" will immediately ask: "does `anon` not also lose
  SELECT?" without re-reading the migration's default-privileges section. The
  test-engineer had to document this in their review notes (note 2) rather than it
  being self-evident from the file. Add one sentence to the arm comment, e.g.:
  "Only `authenticated` is explicitly revoked; `anon` retains SELECT from the
  migration's `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` default-privileges grant,
  and `service_role` retains ALL from the same. So exactly 1 of the 3 role checks
  returns false." The `is()` assertion message should also say "exactly 1 — only
  `authenticated` is revoked; `anon` retains its inherited grant" so CI failure
  output is self-explanatory without consulting external notes.

- `supabase/tests/public_grants_explicit.test.sql:110` — Arm (4) is labeled
  "(4) negative/false-positive" in the plan-count summary block. "Negative" is
  used consistently in this file to mean "asserts a privilege IS absent" (arms 5
  and 6), but arm (4) asserts the count IS zero — it guards against *false
  positives*, the opposite of a negative grant assertion. The mixed label will
  confuse a reader who has just read arms 5 and 6 and expects "negative" to mean
  the same thing throughout. The spec (§4c) calls it "false-positive guard" and the
  reference probe (`permissive_policy_lint.test.sql`) uses that exact phrase. Change
  the label to "(4) false-positive guard — a correctly-granted table is NOT flagged
  (count = 0)" to match the reference and avoid the overloaded "negative" term.

### Nits

- `supabase/migrations/20260618000000_public_grants_explicit.sql:52` — The
  subheading `WHAT THIS MIGRATION DOES (approach 7a CORRECTED — see spec §1a/§1b/§7
  risk 1)` embeds spec-internal section numbers as cross-references. The rationale
  is fully stated inline below that heading (the five bullet points are clear and
  complete), so the `see spec §1a/§1b/§7 risk 1` parenthetical does not add
  information — it just points outside the file. In two years this will mean nothing
  to a reader who doesn't have the spec open. The inline explanation already stands
  on its own; trim the parenthetical to `(approach 7a, corrected)` and drop the
  spec-section cross-reference. The same pattern repeats in the migration header at
  lines 65 (`see the probe's allowlist`) and 86 (`See §7 risk 1`) — those
  references are informative and point at context that IS retained in the probe and
  the CLAUDE.md note, so they are fine; the §1a/§1b/§7 risk 1 triple is the most
  opaque one since it names structural spec-doc sections rather than named concepts.

- `.github/workflows/test.yml:138` — The comment says "See CLAUDE.md
  local-green/CI-red note." CLAUDE.md has no heading labeled "local-green/CI-red
  note"; the relevant sentence is inside the "CI status check after every push to
  `main`" section. The current cross-reference will send a reader searching for a
  heading that doesn't exist. Change to "See CLAUDE.md §'CI status check after
  every push to main'" or simply "See CLAUDE.md §'CI status check'" to make the
  pointer land correctly.

- `supabase/tests/public_grants_explicit.test.sql:102-116` — The plan-count
  summary comment at the top of the test body uses two different counting
  conventions without noting the difference. Arms (1)-(4) each count as 1
  (`is()` call), while arms (5) and (6) each count as 3 (`3 ok() calls`). The note
  "(3 ok() calls.)" on arms (5) and (6) is helpful, but arm (1) and (2) silently
  each count as 1. Spec §4d says "A multi-assertion arm using `select ok(a); select
  ok(b);` counts as 2 toward the plan" — making the 1-vs-3 distinction explicit for
  arms (1)-(4) too (e.g., "(1 is() call)") would make the total 10 derivable by
  inspection from the summary block, rather than requiring the reader to also scan
  the file for the count. Minor, but the reference probe (`permissive_policy_lint`)
  has only single-assertion arms so it doesn't face this problem.

- `supabase/migrations/20260618000000_public_grants_explicit.sql:21-22` — The
  comment says "a grep over all migrations for `grant ... to {anon|authenticated}`
  on a public table returns ZERO matches." This was true at authoring time and the
  migration's own grants are the only new table-level grants for those roles (the
  backend-architect confirmed this). The phrasing "ZERO matches" correctly refers to
  the state before this migration — but a reader running the grep after this
  migration is applied will see matches (this file's own lines 145-146). The comment
  would be clearer as "ZERO matches in any migration earlier than this one" or
  "ZERO matches in any migration at `< 20260618000000`" to correctly scope the
  historical claim and avoid confusion when the grep is re-run.

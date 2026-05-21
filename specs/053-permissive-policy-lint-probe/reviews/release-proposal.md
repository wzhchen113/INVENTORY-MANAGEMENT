# Release proposal — Spec 053 (Permissive-policy lint probe, defense-in-depth pgTAP)

## Verdict
verdict: SHIP_READY
rationale: All three reviewers green at the blocking tier (0 Critical across code-reviewer, backend-architect-post-impl, and test-engineer); 14/14 ACs PASS; pgTAP suite reports 32/32 file pass with the new `permissive_policy_lint.test.sql` included; the one non-trivial Should-fix (OR-tail regex false-positive) is a known-shape footgun for a hypothetical future policy that does not exist on main today, and the fix is a small inline regex tightening plus one extra negative-arm shape — recommended pre-commit, not gating, because shipping the probe with this gap is strictly better than shipping no probe (the gap is "may false-fail a legitimate AND-guarded OR-arm policy in the future," not "may false-pass a wide policy today").

## Findings summary

Reviewer-set scope: code-reviewer + backend-architect (post-impl) + test-engineer were dispatched. Security-auditor was intentionally skipped — this is itself a security control (defense-in-depth lint probe), not a feature with a security surface (no auth path, no HTML rendering, no destructive op, no user-controlled input — the probe reads `pg_policies` under the existing `psql -U postgres` runner). The spec 027 escapeHtml convention and spec 031/050 self-protection conventions do not apply to a catalog-scan pgTAP test.

- **code-reviewer:** 0 Critical, 2 Should-fix, 3 Nits.
  - Should-fix #1 (`supabase/tests/permissive_policy_lint.test.sql:121-122`) — OR-tail regex false-positive on `OR (auth.uid() is not null AND scoped_thing)`: the optional-paren `\)*` matches zero closing parens (because the `)` belongs to the AND), so the AND-guarded narrowing is misread as a trivially-wide OR-arm. The head-position regex is end-anchored and gets this right; the OR-tail regex is unanchored and does not. Today this is hypothetical (no live policy on main HEAD uses that shape), but a future legitimate policy could trip it. Fix: tighten to `\s*\)*\s*($|\s+or\b)` with a `(?!\s+and\b)` lookahead after the trivially-wide token, plus a 4th negative-test arm asserting an AND-guarded OR-arm does NOT flag. ~10-15 lines.
  - Should-fix #2 (lines 84-96) — comment accuracy: "~10 duplicated lines" should read "~20 duplicated lines" given the actual block size of each repeated detection CTE. Trivial inline edit.
  - Nit 1 (lines 265-271) — arm (3)'s failure message says "head-position regex has regressed" but the synthetic policy only exercises the head branch; OR-tail regression would leave arm (3) passing. Documentation-only.
  - Nit 2 (lines 133-141) — arm (1) message embeds a SQL snippet in backticks; some TAP-rendering tools may misformat. Raw psql output is fine. Non-blocking.
  - Nit 3 (CLAUDE.md:66) — "fail-builds" vs "fails-build" hyphenation inconsistency within the same sentence. Style nit.

- **backend-architect (post-impl):** 0 Critical, 0 Should-fix, 2 Minor (both documentation-shape, not correctness).
  - File path, hermetic framing, allowlist row count + literals, regex shape, negative-arm structure, CLAUDE.md byte-exact replacement, and plan count all match the design in §1-17 verbatim.
  - Drop-then-assert deviation from §6's literal `savepoint + rollback to savepoint` pseudocode evaluated and accepted as architecturally sound: pgTAP's `__tcache__`/`__tresults__` are temp tables, so `rollback to savepoint` inside the savepoint would discard the assertion from `finish()`'s counter and trip `scripts/test-db.sh:122-127`'s "planned N but ran M" silent-skip guard. The dev's pattern (create policy → run detector → `set_config()` stash → DROP policy + table → `is()` against stashed count) preserves the hermetic-isolation contract.
  - M1: §6 of the spec still shows literal `savepoint` pseudocode; a one-line addendum acknowledging the actual `set_config()`/drop-then-assert implementation would help future architects. Not blocking.
  - M2: detection CTE is duplicated three times (arms 1, 2, 3); header comment already calls out the pgTAP "CTEs cannot persist across statements" constraint. Mentioned only so the reviewer fan-out doesn't flag it as DRY-violation drift.

- **test-engineer:** 14/14 ACs PASS, 0 FAIL, 0 NOT TESTED.
  - File at the right path, hermetic framing, `pg_policies` query with correct filters (`permissive = 'PERMISSIVE'` and `schemaname = 'public'`), two-pass regex on both `nq` (normalized qual) and `nc` (normalized with_check), allowlist seeded with exactly the two `*_categories` SELECT policies, all-commands scope (no `cmd` filter), hard-fail mode, and 32/32 pgTAP suite pass with the new file included.
  - Plan count math: `plan(3)` matches three `is()` calls at lines 102, 149, 265.
  - NULL handling: `coalesce(qual, '')` and `coalesce(with_check, '')` correctly normalize NULL `qual` (WITH-CHECK-only policies) to the empty string, which matches no trivially-wide regex.
  - Drop-then-assert deviation independently verified: `set_config(..., true)` is transaction-local, visible through `finish()`, cleaned by outer `rollback;`. No state leaks.
  - Aligned with code-reviewer on the OR-tail false-positive: real concern, but the allowlist provides the escape valve so it is a Should-fix, not a blocking defect.

- **No security-auditor:** intentionally skipped (rationale above). The probe IS the security control.

## Recommended next steps (ordered)

Since SHIP_READY:

1. **Apply the four inline cleanups pre-commit** (recommended; together <30 lines, all in the new test file and CLAUDE.md). The probe ships meaningfully tighter and the next maintainer doesn't inherit a known-shape footgun:

   a. **Fix OR-tail false-positive (code-reviewer Should-fix #1)** at `supabase/tests/permissive_policy_lint.test.sql:121-122`. Tighten the OR-tail regex from `\bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')\s*\)*` to require either end-of-string or another `or`-boundary after the optional closing-paren, AND a negative-lookahead `(?!\s+and\b)` immediately after the trivially-wide token. Concrete replacement target (applies identically on both `nq` and `nc`):
      ```
      \bor\s+\(*\s*(auth\.uid\(\) is not null|true|auth\.role\(\) = ''authenticated'')(?!\s+and\b)\s*\)*\s*($|\s+or\b)
      ```
      This blocks the `OR (wide AND scoped)` false-positive while still catching the spec 051 `user_stores` shape `(user_id = auth.uid()) OR (auth.uid() IS NOT NULL)` (which has nothing after the trivially-wide token's closing-paren — `$` matches). Apply on all six occurrences (three arms × `nq`+`nc`).

   b. **Add a 4th negative-arm shape** in arm (3) (or as a sibling arm (4) — developer's call; plan count becomes `plan(4)` if separate). Create a second synthetic table `__lint_probe_negative_test_and_guarded` with policy `using ((user_id = auth.uid()) OR (auth.uid() is not null AND auth_is_admin()))`, capture the detector hit count, drop, assert `is(count, 0, ...)` — i.e. an AND-guarded OR-arm must NOT trip the probe. This is the regression guard that closes the gap step (a) just fixed.

   c. **Fix comment line-count (code-reviewer Should-fix #2)** at `supabase/tests/permissive_policy_lint.test.sql:84-96`. Change "~10 duplicated lines" to "~20 duplicated lines" (or measure the actual block-size and write the true number). Trivial honesty edit.

   d. **Fix hyphenation (code-reviewer Nit 3)** in `CLAUDE.md:66`. Pick one of "fail-builds" or "fails-build" and use it consistently within the sentence. The existing surrounding bullet uses "fails-build" as a verb (line 23 of spec 053 itself), so propagate `fails-build` and reword the trailing clause to match. One-character edit.

2. **(Optional inline polish, sub-30-second edits)**

   e. **Arm (3) failure message precision (code-reviewer Nit 1)** at lines 265-271: update message to say "head-position regex or synthetic-policy creation" and, if step (b) is applied as a 4th arm, the arm (4) message can read "OR-tail regex's AND-guard exclusion has regressed" — making each negative arm self-documenting about which branch it guards.

   f. **Architect M1 addendum** to spec §6: one-line note acknowledging the implemented `set_config()` + drop-then-assert pattern alongside the savepoint pseudocode, citing the pgTAP `__tcache__`/`__tresults__` temp-table constraint. Documentation-hygiene only; the test file's header comment already documents this.

3. **Commit and deploy.** New file `supabase/tests/permissive_policy_lint.test.sql` + the one-sentence CLAUDE.md past-tense closeout. No migration, no edge function, no client touch, no realtime publication change, no `app.json` edit. The `db-tests` job in `.github/workflows/test.yml` picks up the new file automatically; the existing 32/32 pgTAP suite confirms the probe passes on current main HEAD with the two `*_categories` policies on the seed allowlist.

4. **(Optional, separate follow-up specs — none blocking this ship)**

   - **`db-migrations-applied.yml` CI gate** — spec §15a's known limitation: the probe scans `pg_policies` against the local + CI database, not prod. A wide policy applied directly via the Supabase dashboard SQL editor without a corresponding migration file would not be caught. Closing that gap requires the long-pending workflow referenced in README.md and CLAUDE.md §"CI workflow." A future spec lands the migrations-applied gate; until then, the probe catches the migration-file class of leak only. This is honest about the probe's scope.
   - **Allowlist mechanism v2** — current inline VALUES list is good for ≤5-10 entries; CLAUDE.md §"Resolved questions" already documents the `COMMENT ON POLICY` marker pattern as the v2 escape hatch if the allowlist ever grows past ~10. Defer until the count actually approaches the threshold.
   - **Restrictive-policy probe** — explicitly out-of-scoped by this spec (PM Q4): restrictive policies AND-combine and cannot exhibit the OR-shadow footgun. If a restrictive-policy footgun is ever identified, a separate spec adds that probe.
   - **Execution-based detection** — PM Q1 chose text-match for hermeticity; an execution-based variant (impersonate a synthetic caller and assert the policy returns true for any input) would be more precise but introduces SECURITY DEFINER side-effects. Defer indefinitely unless a real false-negative motivates it.

## Out of scope for this review

- **`db-migrations-applied.yml` CI workflow** — captured above as a recommended follow-up; the gap exists at the project level, not in this spec's deliverable. Spec §15a documents it honestly.
- **Retroactive audit of every existing policy** — spec §4's `Q-arch-1` enumeration is the explicit scope: trace every historical wide policy in `supabase/migrations/` and confirm only the two `*_categories` policies remain live. Architect performed this; result is the seed allowlist.
- **Non-`public.*` schemas** — `auth.*`, `storage.*`, `realtime.*`, and extension schemas are Supabase-managed (PM Q6). The probe's `schemaname = 'public'` filter is correct and not to be widened here.
- **Comment-marker allowlist via `COMMENT ON POLICY`** — captured above as v2 if the allowlist grows past ~10 entries (spec §15f tradeoff documented).
- **Execution-based detection (PM Q1 tradeoff)** — defer indefinitely per the spec's §15e rationale.
- **Restrictive-policy footgun probe** — explicitly out-of-scoped by spec; separate spec if ever needed.
- **app.json slug change** — N/A; the probe is pgTAP-only and does not touch any client config (CLAUDE.md "DO NOT AUTO-FIX" applies regardless).
- **Realtime publication review** — N/A; no schema change, no `docker restart supabase_realtime_imr-inventory` ritual required (spec §13).
- **`src/lib/db.ts` and `useStore.ts` review** — N/A; no client touch (spec §12, §14).

## Handoff
next_agent: NONE
prompt: SHIP_READY — 0 Critical from all three reviewers (code-reviewer, backend-architect-post-impl, test-engineer); 14/14 ACs PASS; pgTAP 32/32 with new permissive_policy_lint.test.sql included; one Should-fix is a known-shape OR-tail regex false-positive (false-fails a hypothetical AND-guarded OR-arm policy that does not exist on main today, never false-passes a wide policy) — recommended inline pre-commit fix is ~10-15 lines of regex tightening + one extra negative arm; second Should-fix is a comment line-count edit (~10 → ~20); nits are documentation/hyphenation; security-auditor intentionally skipped (the probe IS the security control)
payload_paths:
  - specs/053-permissive-policy-lint-probe/reviews/release-proposal.md

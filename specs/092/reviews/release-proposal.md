# Release proposal for spec 092

## Verdict
verdict: SHIP_READY
rationale: The lone Critical and both Should-fixes are resolved + re-verified (5 passed, zero teardown leak), all 7 ACs PASS, and `main`'s `test.yml` is green — this test-only Track-4 e2e adds no app/migration/contract surface.

## Findings summary
- **code-reviewer**: 1 Critical + 2 Should-fix + 3 Nits. **Critical + both Should-fixes RESOLVED** (confirmed in the file's own `## Resolution` section, lines 27-36).
  - Critical (`global-teardown.ts:125`) — spec-092 cleanup block was conditionally unreachable behind the spec-080 store-delete handler's early `return`, risking a leak of the two dedicated reorder stores + their non-cascading `inventory_items`. **Fixed:** handler converted to `warn` + `else`-log (fall-through); the spec-092 block now runs unconditionally. Re-verified: `npx playwright test e2e/staff-reorder.spec.ts` → 5 passed; teardown logs confirm the block fires and removes both stores + the catalog (zero leak).
  - Should-fix #1 (`staff-reorder.spec.ts:300-301`) — vacuous KPI `getByText('1').first()` assertion. **Fixed:** removed; KPI guard is now the specific `"Vendors"` label, and the real no-vacuous-pass guards (vendor-card tripwire + by-the-case regex) are unchanged.
  - Should-fix #2 (`global-teardown.ts:210`) — document the cascaded-`return` dependency so the gatekeeping pattern isn't reintroduced. **Fixed:** comment added; the lone trailing `return` is the function's last statement (skips only the final success log, never a sibling cleanup).
  - 3 Nits (long test title; `e2eReorderItemId` `a1` suffix vs the `0092`/`0093` convention; the pre-existing `or().first()` locator ported verbatim from `eod.spec.ts`) — **deferred, cosmetic, non-blocking.**
- **security-auditor**: N/A — correctly not invoked. Test-only spec: no app code, no migration, no contract/RLS/edge change. The only DB touch is the existing-pattern e2e service-role fixture (already cleared by the spec-078 audit).
- **test-engineer**: **7 PASS / 0 FAIL / 0 NOT-TESTED** ACs (NAV, LIST, CASES, EXPORT, STATE, DETERMINISM, RUNS). Solo run 5 passed; full suite 16 passed / 1 failed where the single failure is the PRE-EXISTING, UNRELATED `eod.spec.ts:190` offline-queue race (uses Towson, not the `…92`/`…93` stores; fails identically with none of this spec's code). Teardown leak check returns `[]` for all five affected tables; both typechecks exit 0. Independently confirms the Critical fix and the Should-fix #1 removal.
- **backend-architect (post-impl)**: N/A — correctly not invoked. No contract/migration/edge/RLS drift surface; the spec marked it N/A and the design itself states every contract section N/A with reason.

## Recommended next steps (ordered)
SHIP_READY:
1. **Commit and push.** Stage and commit the test-only change:
   - `e2e/staff-reorder.spec.ts` (new)
   - `e2e/fixtures/constants.ts`
   - `e2e/global-teardown.ts`
   - `specs/092/`
   Suggested message: `Spec 092: Track-4 Playwright e2e for the staff Reorder page (SHIP_READY)`.
2. **No migration / no `db push` / no `test.yml` impact.** This is test-only (Track 4). `test.yml` (jest + typechecks + pgTAP) is unaffected and stays green — no `src/`, `supabase/migrations/`, or `supabase/functions/` change. The e2e suite runs in the separate NON-BLOCKING `e2e.yml`, which does not gate merges.
3. **Vercel deploy is irrelevant** — there is no app/runtime code in this change. No deploy step required.
4. **CI confirmation after push:** per the CLAUDE.md post-push rule, confirm the latest `test.yml` run on `main` is green via `gh run list --branch main --limit 1`. Since this commit adds no app code, `test.yml` is expected to remain green (latest known-green: run 26839377450, spec 091).

## Out of scope for this review
- **Pre-existing `e2e/eod.spec.ts:190` offline-queue flake (NON-BLOCKING note — NOT an 092 blocker).** The `setOffline` DOM-detach re-render race already exists on `main`, uses Towson (not the dedicated `…92`/`…93` stores), and fails identically without any spec-092 code. It does not gate anything (`e2e.yml` is non-blocking) and is unrelated to 092. Candidate for a separate future follow-up spec — surfaced here for visibility only.
- **3 code-reviewer Nits** (test-title length; `e2eReorderItemId` suffix convention; the inherited `or().first()` locator pattern) — cosmetic, deferred, do not block ship.
- **Date-picker look-back / real export download / native share / admin Reorder section** — explicitly out of scope per the spec's "Out of scope" section.

## Summary
Spec 092 closes the deferred staff-Reorder Track-4 e2e from spec 089: a deterministic Playwright happy-path (manager sign-in → Reorder tab → `Order: 2 cases · 24 EA` by-the-case string → `Vendors` KPI → present-but-not-clicked export buttons) plus an empty-state assertion, backed by a `beforeAll` fixture (two dedicated NON-anchor stores granted to the manager, a 7-weekday `order_schedule`, and a below-par `case_qty=12` catalog/inventory item) cleaned in `global-teardown.ts`. The one Critical (conditionally-unreachable teardown that risked leaking the dedicated stores + their non-cascading `inventory_items`) and both Should-fixes were folded in by a main-Claude fix-pass and re-verified green (5 passed, zero leak); the 3 Nits are deferred as cosmetic. All 7 acceptance criteria PASS, both typechecks exit 0, and the single full-suite failure is the pre-existing, unrelated `eod.spec.ts:190` flake. This is test-only (no app code, no migration, no contract/RLS/edge change), so `test.yml` stays green and Vercel deploy is irrelevant — the verdict is SHIP_READY: commit and push, then confirm the `test.yml` run on `main` stays green.

## Handoff
next_agent: NONE
prompt: SHIP_READY — spec 092 staff-Reorder Track-4 e2e; Critical + both Should-fixes resolved and re-verified (5 passed, zero leak), 7/7 ACs PASS, test-only (no test.yml/Vercel impact), main green. Commit covers e2e/staff-reorder.spec.ts (new), e2e/fixtures/constants.ts, e2e/global-teardown.ts, specs/092/. Non-blocking note: pre-existing unrelated eod.spec.ts:190 flake on main.
payload_paths:
  - specs/092/reviews/release-proposal.md

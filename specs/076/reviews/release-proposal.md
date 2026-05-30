## Verdict
verdict: SHIP_READY
rationale: Zero Critical findings across reviewers; the lone Should-fix (vacuous `unconfirmed_po` assertion in Test 5) was addressed in a post-review FE fix-pass, jest is 40 suites / 386 tests green, both tsc configs exit 0, AC9 verified byte-untouched, and the latest `test.yml` run on `main` (spec 075, run 26676899835) was green.

## Summary

Spec 076 unifies the attention queue's `eod_missing` and `food_cost_streak` rules onto the same tz-aware anchor pattern that spec 074 ratified for `unconfirmed_po`:

- `src/lib/cmdSelectors.ts:computeAttentionQueue` — `todayISO`, `yesterdayISO`, and `startSevenISO` now all derive via `getLocalDateISO(timezone, now)` with a DST-safe whole-day-ms back-step against the UTC instant (NOT `setDate()` on a UTC-anchored Date). `isPastDeadline(now, store?.eodDeadlineTime)` continues to receive the raw `now: Date` per AC #4.
- Inline comment at `cmdSelectors.ts:864-873` — the pre-existing "DO NOT 'fix' the inconsistency drive-by" warning replaced with a 4-line ratification note ("All three rules ... derive their ISO date anchors via `getLocalDateISO(timezone, now)` — ratified by spec 076").
- `src/lib/cmdSelectors.eodAndStreak.test.ts` — NEW file (6 tests) pinning the canonical regression instant `2026-05-26T03:00:00Z` (= Mon 23:00 ET / Tue 03:00 UTC). 5 of the 6 tests are load-bearing against pre-fix UTC code; Test 1 is the intentional agreement-day control case.
- `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` — byte-untouched per AC #9 (`git diff main` returns 0 lines).

No prod migration applies — this is a pure-frontend selector-logic change. Vercel deploys on push to `main`.

## Findings summary

- **code-reviewer**: 0 Critical, 1 Should-fix, 2 Nits.
  - Should-fix (vacuous `expect(po).toHaveLength(0)` in Test 5 — the module-level `orderSchedule` is `{}`, so the assertion held tautologically regardless of tz windowing) — **fixed** in the post-review FE fix-pass via reviewer's option (b): assertion dropped + scope note added to Test 5's leading comment. Matches separation of concerns (spec 074 owns `unconfirmed_po` tz coverage with a non-empty `orderSchedule` fixture; spec 076 owns `eod_missing` + `food_cost_streak`). Test 5's `eod_missing` anchor assertion remains load-bearing.
  - Nit #1 (stale "(see inline comment in cmdSelectors.ts above the unconfirmed_po block)" cross-reference at `cmdSelectors.unconfirmedPoWindow.test.ts:5-6` now points at the spec 076 ratification note rather than the original inconsistency warning) — **deferred** per AC #9 (spec-074 file stays byte-untouched). Logged as follow-up candidate.
  - Nit #2 (`() => 'fine' as ItemStatus` at `cmdSelectors.unconfirmedPoWindow.test.ts:53` is not in the `'ok' | 'low' | 'out'` union and is `as`-suppressed; new spec 076 file correctly uses `'ok'`) — **deferred** per AC #9. Logged as follow-up candidate.
- **security-auditor**: not run (correctly skipped — no auth / RLS / RPC / edge function / migration surface).
- **test-engineer**: PASS. 13 ACs covered, 0 NOT TESTED, 0 FAIL. `npx jest --no-coverage` → 40 suites / 386 tests green (6 new). `npx tsc --noEmit -p tsconfig.json` + `tsconfig.test.json` both exit 0. AC9 verified via `git diff main -- src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` returning 0 lines. Load-bearing analysis confirms Tests 2/3/4/5/6 each fail pre-fix; Test 1 is the documented control case. DST coverage and Asia/Tokyo coverage live at the `getLocalDateISO` helper level (`src/utils/weekWindow.test.ts`) — no gap at the selector level.
- **backend-architect (post-impl)**: not run (correctly skipped — no `db.ts` / migration / RPC / edge function / realtime surface; no backend contract to drift against).
- **Post-fix re-verification**: `npx jest src/lib/cmdSelectors.eodAndStreak` → 6 tests pass; `npx tsc --noEmit -p tsconfig.json` exit 0. Full-project counts (40 suites / 386 tests) unchanged from implementer's report.
- **CI gate**: latest `test.yml` on `main` (spec 075, run 26676899835) was green; SHIP_READY rule clears.

## Recommended next steps (ordered)

1. **Commit and push to `main`.** Commit is the user's to authorize. No prod migration applies — Vercel auto-deploys on push.
2. After push to `main`, confirm the next `test.yml` run is green (per CLAUDE.md "CI status check after every push to `main`" rule).

## Out of scope for this review

These were logged by code-reviewer as deferred 1-line cleanups on the byte-untouched spec-074 sibling file. AC #9 explicitly required that file stay untouched, so they cannot land in this spec. Both candidates pair naturally — a future small follow-up spec (or any re-touch of `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts`) can land them together:

- `cmdSelectors.unconfirmedPoWindow.test.ts:5-6` — refresh or remove the now-stale "(see inline comment in cmdSelectors.ts above the unconfirmed_po block)" cross-reference. After spec 076, that pointer lands on the ratification note rather than the original inconsistency warning the comment claims is there.
- `cmdSelectors.unconfirmedPoWindow.test.ts:53` — replace `() => 'fine' as ItemStatus` with `() => 'ok'` to drop the `as`-suppression and align with the new spec-076 sibling file (which correctly uses `'ok'`).

Other previously-flagged follow-ups from spec 074 (per-store timezone slice; spec 075 UTC-vs-NY doc divergence) remain out of scope for this spec per its own §Out of scope block.

## Handoff
next_agent: NONE
prompt: SHIP_READY, commit user's call; pure-frontend, no prod migration (Vercel deploys on push). 2 deferred 1-line nits on the byte-untouched spec-074 sibling file (stale cross-reference + `'fine'` vs `'ok'` ItemStatus) logged as paired follow-up candidates.
payload_paths:
  - specs/076/reviews/release-proposal.md

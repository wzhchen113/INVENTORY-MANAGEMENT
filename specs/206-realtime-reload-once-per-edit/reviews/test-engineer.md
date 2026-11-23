# Test report — spec 206

_Transcribed by main Claude from the test-engineer's hand-back on 2026-11-23. The agent misread its brief as forbidding the review file, so it returned the report inline. The content below is the test-engineer's, with only formatting changed._

## Acceptance criteria status

- AC-1 (R5, trailing debounce, 399/400 ms, burst) → PASS. `src/lib/realtimeReloadScheduler.test.ts` › "AC-1 (R5)" (2 cases).
- AC-2 (R3, held while writing, 1 reload 400 ms after drain) → PASS. Same file › "AC-2 (R3)". It also asserts no timer is armed while writes are in flight.
- AC-3 (R3, re-hold on a new write during the post-drain debounce) → PASS. Same file › "AC-3".
- AC-4 (drain with nothing held gives 0 reloads) → PASS. Same file › "AC-4".
- AC-5 (R4, single-flight plus one dirty follow-up) → PASS. Same file › "AC-5" (2 cases, including an event less than 400 ms before settle).
- AC-6 (R4, reject path, no unhandled rejection) → PASS. Same file › "AC-6" (3 cases: reject, synchronous throw, throwing reporter). The check uses a setImmediate turn. The developer reports a temporary re-throw in the reject branch failed all four rejection cases; not re-run by the test-engineer.
- AC-7 (R4 + R3, dirty follow-up held by a write at settle time) → PASS. Same file › "AC-7".
- AC-8 (no dirty means no follow-up) → PASS. Same file › "AC-8".
- AC-9 (R7, dispose) → PASS. Same file › "AC-9" (a, b, c, c-reject, d): timers cleared, held event dropped, no follow-up after dispose, subscription released, idempotent dispose. Invariant guards (e, f, write-clears-timer) are extras.
- AC-10 (R1, write counter) → PASS. `src/lib/inflight.test.ts` › "useInflight.track — write counter (spec 206)" (7 cases): resolve, reject, 30 s hard abort, read leaves counter untouched, two concurrent writes, mixed read/write, selector. Existing `hasInflight` / `hasSlow` cases unchanged and passing.
- AC-11 (R6 wiring, hook level) → PASS. `src/hooks/useRealtimeReloadScheduler.test.ts` (8 cases): stable `handleSync` identity; a held event does not fire at 400 ms (old inline debounce gone); unmount disposes; store id read at fire time; adapter fires only on `hasWriteInflight` edges and a real tracked write drives the hold end to end. No `AuthedRoot` render test, which the spec permits; diff confirms `CmdNavigator.tsx` calls `useRealtimeReloadScheduler()` at line 66 and the inline debounce is gone.
- AC-12 (full jest) → PASS.
- AC-13 (typecheck) → PASS for `npm run typecheck:test` (exit 0). `npm run typecheck` fails locally only with 24 TS2688 errors (see Notes): PASS for CI, FAIL in this local environment, not a spec 206 defect.
- AC-14 (one reload per edit, plus vendor-link variant) → PASS on the developer's recorded results (not re-run). Resource Timing marker via Playwright, local stack: baseline at 250 ms added latency 3, 2, 3 reloads with overlap; after 1, 1, 1. At 0 ms both builds gave 1. `stores` cross-check matched. Vendor-link variant 1/1 at 0 ms and 250 ms. Caveats: Playwright rather than preview tools; the vendor-link variant has no separate pre-change baseline.
- AC-15 (another manager's change still arrives live) → PASS on the developer's recorded results: 3 edits from session B, each visible in A in about 0.94–1.24 s with exactly 1 reload per edit.
- AC-16 (no overlap under rapid edits) → PASS on the developer's recorded results: 3 saves in about 1.4 s gave 1 reload at 0 ms and 250 ms; no overlap, no reload during a save request, final DB value matched UI.

Totals: 16 PASS, 0 FAIL, 0 NOT TESTED. AC-14–AC-16 rest on the developer's recorded browser results.

## Test run

- `npx jest` (full): 322 suites, 4131 tests passed, 0 failed, 17 snapshots passed (about 12 s).
- `npm run typecheck:test`: exit 0.
- `npm run typecheck`: 24 errors, all TS2688 "Cannot find type definition file for '<pkg> 2'". 0 other errors.

## Notes

- **TS2688 is the only failure; CI is unaffected.** 24 duplicate folders under `node_modules/@types/` (e.g. `react 2`, `ws 2`, `yargs 2`), git-ignored, macOS Finder-style copies not created by this spec. `.github/workflows/test.yml` runs `npm ci` before `npm run typecheck` and `npm run typecheck:test`, so a clean install won't have them. Local fix: delete the `* 2` folders or rerun `npm ci`.
- **No existing test pinned the old inline debounce.** No other test mentions `CmdNavigator`, `reloadTimerRef` or `handleSync`; grep for `setTimeout…400` / `, 400)` under `src/navigation` and `src/hooks` finds only a comment in the new hook test. Full jest is green.
- **Residual risk, not blocking.** AC-14–16 measured with Playwright and emulated latency; at 0 ms the baseline already gave 1 reload. Late self-echo not observed. The architect's note that a storage `.remove()` without an abort signal could keep `hasWriteInflight` true is a design note, not a test gap.
- No new test framework introduced; all tests are jest.

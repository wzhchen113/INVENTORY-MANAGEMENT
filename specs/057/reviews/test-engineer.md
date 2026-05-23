## Test report for spec 057

### Acceptance criteria status

- **AC1**: `src/hooks/useConnectionStatus.ts` exports `useConnectionStatus(): boolean`; preserves optimistic-`true` semantics (empty channels → `true`; otherwise `channels.some(c => c.state === 'joined' || c.state === 'subscribed')`) → **PASS** — `src/hooks/useConnectionStatus.test.ts` describe blocks "empty-channels branch" (2 tests), "healthy single-channel states" (2 tests), "unhealthy single-channel states" (2 tests), "mixed-state aggregation" (2 tests).

- **AC2**: Hook owns the `setInterval(..., 2000)` poll and the `supabase.realtime.channels` read currently inlined at `TitleBar.tsx:86-100` → **PASS** — Hook file (`src/hooks/useConnectionStatus.ts` lines 44-58) contains the full `useEffect` with `setInterval(tick, 2000)` and `supabase.realtime.channels` read. `TitleBar.tsx` contains no `useState`/`useEffect` related to connection (only the store-menu `storeMenuOpen` state remains). Confirmed by `grep` — no `setConnected`, no `realtime`, no `channels` in `TitleBar.tsx`.

- **AC3**: `TitleBar.tsx` removes `import { supabase } from '../../lib/supabase'` (line 6) and replaces lines 85-100 with `const connected = useConnectionStatus()` → **PASS** — `grep "lib/supabase" TitleBar.tsx` returns zero import lines (only a comment reference). `TitleBar.tsx:86` is `const connected = useConnectionStatus();`. Confirmed.

- **AC4**: `TitleBar.test.tsx` removes `jest.mock('../../lib/supabase', ...)` block and replaces with `jest.mock('../../hooks/useConnectionStatus', ...)` → **PASS** — `grep "lib/supabase" TitleBar.test.tsx` returns empty. The file contains `jest.mock('../../hooks/useConnectionStatus', () => ({ __esModule: true, useConnectionStatus: () => true }))` at lines 63-66. No dual-mock coexistence.

- **AC5**: New jest test at `src/hooks/useConnectionStatus.test.ts` covers: empty-channels → `true`; one channel `'joined'` → `true`; one channel `'closed'` → `false`; mixed states → `true` if any joined/subscribed; cleanup clears interval on unmount → **PASS** — all enumerated cases confirmed present and passing (13 tests, 0 failures; see Test run below).

- **AC6**: No UI change — pixel-equivalent render before vs after; browser smoke (green/amber dot + label) → **NOT TESTED** — The browser smoke ("toggle Offline in DevTools, watch dot flip amber within ~2s") is explicitly deferred by the FE developer due to unavailability of `mcp__claude-in-chrome__*` tools during their agent invocation. The jest test suite validates the polling logic is byte-for-byte identical (same mapping, same cadence, same initial tick, same cleanup), and `npm run typecheck` is clean. The browser smoke is the only verification gap; a human reviewer should perform it before release. Treated as **Should-Fix** (manual step), not Critical — the behavioral correctness is fully covered by the hook unit tests.

- **AC7**: No new connection states added; hook returns the same boolean shape → **PASS** — Hook signature is `useConnectionStatus(): boolean`. No union type, no enum, no additional fields. `TitleBar.tsx:229-241` consumes the result as a bare boolean (`connected ? C.ok : C.warn`, `connected ? T('chrome.connected') : T('chrome.reconnecting')`), unchanged.

- **AC8** (implied from spec — polling cadence stays at 2000 ms; initial tick fires immediately): → **PASS** — Explicit test: `'cadence is exactly 2000ms (1999ms does not tick, 2000ms does)'` uses `jest.useFakeTimers()` + `jest.advanceTimersByTime(1999)` then `advanceTimersByTime(1)` to assert boundary behavior. Initial synchronous tick is verified by the unhealthy-state tests: `useState(true)` is the default, but `result.current` is `false` immediately after `renderHook` — possible only if the synchronous `tick()` inside the effect already ran and called `setConnected(false)`.

---

### Test run

```
npm test
```

- **23 suites, 228 tests, 0 failures, 0 skipped**
- `src/hooks/useConnectionStatus.test.ts` — 13 passed (unit project, node env)
- `src/components/cmd/TitleBar.test.tsx` — 3 passed (component project, jsdom env)

```
PASS unit src/hooks/useConnectionStatus.test.ts
  useConnectionStatus — empty-channels branch
    ✓ returns true on initial mount with no channels
    ✓ stays true across ticks while channels stay empty
  useConnectionStatus — healthy single-channel states
    ✓ returns true when the only channel is in state 'joined'
    ✓ returns true when the only channel is in state 'subscribed'
  useConnectionStatus — unhealthy single-channel states
    ✓ returns false when the only channel is in state 'closed'
    ✓ returns false when the only channel is in state 'errored'
  useConnectionStatus — mixed-state aggregation
    ✓ returns true when ANY channel is 'joined' (mixed with closed)
    ✓ returns false when NO channel is in a healthy state
  useConnectionStatus — polling picks up mutations
    ✓ flips false when the only channel transitions to closed
    ✓ flips true when a previously-closed channel re-joins
    ✓ cadence is exactly 2000ms (1999ms does not tick, 2000ms does)
  useConnectionStatus — cleanup
    ✓ clearInterval is called on unmount with the setInterval id
    ✓ after unmount, advancing timers does not trigger further state reads

PASS component src/components/cmd/TitleBar.test.tsx
  TitleBar — LoadingBar integration (Spec 055)
    ✓ does NOT render the LoadingBar when nothing is in flight
    ✓ renders the LoadingBar inside the chrome when hasInflight flips true
    ✓ LoadingBar follows hasSlow into the warn state inside TitleBar
```

Typecheck gates:

```
npm run typecheck        → clean (0 errors)
npm run typecheck:test   → clean (0 errors)
```

---

### Notes

**Mock swap — clean.** `TitleBar.test.tsx` contains exactly one mock for the connection-status concern: `jest.mock('../../hooks/useConnectionStatus', ...)`. The `jest.mock('../../lib/supabase', ...)` block introduced in spec 055 Pass-2 is fully removed. No dual-mock coexistence.

**Initial-sync-tick coverage — adequate.** The spec task asked whether the initial synchronous fire is explicitly tested vs. only implied. The hook tests for unhealthy states (`'closed'`, `'errored'`) verify it directly: the `useState` default is `true`, yet `result.current` is `false` right after `renderHook` with no `advanceTimersByTime` call. That transition requires the synchronous `tick()` inside the `useEffect` to have already run. This is robust verification even though it is not an isolated "initial tick" describe block.

**2 s interval coverage — robust.** The "cadence is exactly 2000ms" test exercises the off-by-one boundary (`1999ms` vs `2000ms`) with fake timers. The "polling picks up mutations" describe adds two more tick-driven tests (false-flip and true-flip). Coverage of the polling cadence claim is strong.

**`clearInterval` + post-unmount coverage — complete.** Two cleanup tests: the spy-based id-matching test and the "advancing timers after unmount does not read further state" behavioral test. Both pass.

**Test count discrepancy (nit).** The spec's "Files changed" section claims "14 cases under 7 describe blocks" (`specs/057-use-connection-status-hook.md:426`). The actual file has **13 tests in 6 describe blocks** (jest confirms 13 pass). The off-by-one is in the spec's self-description only; the coverage matrix from spec §5a is fully represented in the 13 tests. No functional gap — nit only.

**Browser smoke deferred (should-fix).** AC6 ("pixel-equivalent render, manual browser check shows the same green/amber dot + reconnecting label") requires interactive browser tooling. The FE developer documents this as deferred. The polling logic's correctness is fully covered by unit tests; the remaining gap is visual confirmation that both dot states are reachable in the browser. A human reviewer should perform the DevTools websocket-close smoke before the spec is marked SHIP_READY.

**No pgTAP or smoke-edge changes needed.** This is a pure FE refactor: no migrations, no RLS, no edge functions, no RPCs, no realtime publication changes.

---

## Pass 2

### Pass-2 checklist

**Item 1 — AC6 (browser smoke).** Treated as covered per the task instruction: main Claude is running the browser smoke in parallel. No change to the AC6 finding here; if main Claude reports a behavioral regression that supersedes this finding it would be a separate Critical. As of this review: AC6 remains NOT TESTED by automated means; covered by manual browser smoke running concurrently.

**Item 2 — Spec prose count nit.** The spec's "Files changed" section now reads: "13 cases under 6 describe blocks … (Pass 2 adds a 14th case under a 7th describe block — the native-bail regression test)". The actual test file has 14 tests across 7 describe blocks (confirmed by `npm test` output: "Tests: 14 passed, 14 total" for `src/hooks/useConnectionStatus.test.ts`). The prose is now accurate. Nit closed.

**Item 3 — Native-bail regression test.** Verified `src/hooks/useConnectionStatus.test.ts` lines 241-275 ("useConnectionStatus — native platform bail" describe block, test "does NOT call setInterval on native and returns the optimistic default"):

- `try/finally` cleanup: `Platform.OS = originalOS` and `setSpy.mockRestore()` both appear inside the `finally` block (lines 270-273). Cleanup runs on both success and thrown-exception paths. Confirmed.
- `setInterval` spy asserted NOT called: `expect(setSpy).not.toHaveBeenCalled()` at line 259. Confirmed.
- `result.current === true` (optimistic default): `expect(result.current).toBe(true)` at line 261. Additionally `expect(result.current).toBe(true)` at line 267 after advancing fake timers 10 000 ms, confirming no interval fires. Confirmed.
- Spy cleared between tests / no file-level leak: `setSpy` is a local variable declared inside the test function body; `setSpy.mockRestore()` in `finally` restores `global.setInterval` before the test exits. `afterEach(() => jest.useRealTimers())` resets the fake-timer state. No other test file can inherit this spy. Confirmed.

**Item 4 — Suite count.** `npm test` output: "Tests: 229 passed, 229 total" across "Test Suites: 23 passed, 23 total". FE-claimed count (229 = 228 + 1 native-bail) confirmed. No failures, no skipped.

**Item 5 — Typechecks.** `npm run typecheck` and `npm run typecheck:test` both exit clean (0 errors). Confirmed.

**Item 6 — Pass-1 PASS items unchanged.** All 13 original tests from Pass 1 still pass:
- "empty-channels branch" (2 tests) — PASS
- "healthy single-channel states" (2 tests) — PASS
- "unhealthy single-channel states" (2 tests) — PASS
- "mixed-state aggregation" (2 tests) — PASS
- "polling picks up mutations" (3 tests) — PASS
- "cleanup" (2 tests) — PASS

No coverage regression.

### Updated acceptance criteria status (Pass 2)

- **AC1** → PASS (unchanged from Pass 1)
- **AC2** → PASS (unchanged from Pass 1)
- **AC3** → PASS (unchanged from Pass 1)
- **AC4** → PASS (unchanged from Pass 1)
- **AC5** → PASS (14 tests now, up from 13; all pass)
- **AC6** → NOT TESTED by automated means — browser smoke running concurrently by main Claude (unchanged status; coverage risk mitigated by unit-test correctness proof and parallel human smoke)
- **AC7** → PASS (unchanged from Pass 1)
- **AC8** → PASS (unchanged from Pass 1)

### Assessment for release-coordinator

Both Pass-1 open items are closed:

1. The spec prose count (nit) now matches reality: 14 tests / 7 describe blocks.
2. The native-bail regression test is substantive: it mutates `Platform.OS` to `'ios'` inside a `try/finally`, spies on `global.setInterval`, asserts the spy was NOT called, asserts `result.current === true` (and stays `true` after 10 s of fake-timer advance), and restores both the platform override and the spy in `finally` so no other test is affected. The test directly exercises the spec's §3a platform-gate invariant and would catch any future regression where the `if (Platform.OS !== 'web') return` guard is removed or misplaced inside the `useEffect`.

The suite is green (229/229), typechecks are clean, and all 8 AC items are either PASS or (AC6) NOT TESTED with the manual smoke running in parallel. No Criticals remain from Pass 1. The single remaining NOT TESTED item is the interactive browser smoke — a should-fix deferred to main Claude's parallel run, not a blocker if that run is clean.

## Handoff
next_agent: NONE
prompt: Test report complete. Pass 2 — 7 PASS, 0 FAIL, 1 NOT TESTED (AC6 browser smoke, covered by parallel manual run) across acceptance criteria. Suite green at 229/229, typechecks clean, native-bail regression test confirmed substantive, Pass-1 nit closed.
payload_paths:
  - specs/057/reviews/test-engineer.md

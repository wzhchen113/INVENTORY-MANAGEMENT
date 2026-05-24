## Test report for spec 059

### Acceptance criteria status

- **AC1: Hook public signature unchanged — `useConnectionStatus(): boolean` remains the sole export.**
  PASS — `src/hooks/useConnectionStatus.ts:106` exports exactly `export function useConnectionStatus(): boolean`. No other exports added.

- **AC2: No `setInterval` (and no `setTimeout`-as-poll equivalent) anywhere in the hook body.**
  PASS — `grep -n 'setInterval\|setTimeout' src/hooks/useConnectionStatus.ts` returns zero matches. Case 11 (`src/hooks/useConnectionStatus.test.ts::setInterval is never called by the hook`) enforces this at runtime via `jest.spyOn(global, 'setInterval')` + `jest.spyOn(global, 'setTimeout')`, both asserting zero calls through mount and unmount.

- **AC3: Indicator flips within ~250 ms — jest asserts synchronous flip inside `act()` with no `advanceTimersByTime`.**
  PASS — Cases 9 and 10 (describe "synchronous flip inside act()") dispatch `handlers.close[0]()` and `handlers.open[0]()` inside a single `act(() => { ... })` with the assertion immediately after, no `advanceTimersByTime` call anywhere in the file. `grep -n 'advanceTimersByTime' src/hooks/useConnectionStatus.test.ts` returns zero matches.

- **AC4: Optimistic default preserved — returns `true` on initial mount before any event.**
  PASS — Two test groups cover this. Describe "initial seed branch" has Case 1 (`isConnected=false + connectionState='connecting'` → `true`) and Case 2 (open state stays `true` with no events). Describe "initial-seed three-branch rule (Q4)" adds Case 15 with three explicit sub-cases: `isConnected=true → true`, `connectionState='connecting' → true`, `connectionState='closed' → false`.

- **AC5: Native-bail guard preserved — `if (Platform.OS !== 'web') return;` stays as first statement of `useEffect` body.**
  PASS — Line 118 of `src/hooks/useConnectionStatus.ts` is the first statement of the `useEffect` body. Case 14 (describe "native platform bail") mutates `Platform.OS = 'ios'` in a `try/finally`, asserts `socket.onOpen` / `socket.onClose` / `socket.onError` were NOT called, asserts `setInterval` was NOT called, and asserts `result.current === true`. Mutation test confirmed: commenting out the guard causes Case 14 to fail at the `__getOnOpenSpy().not.toHaveBeenCalled()` assertion. The test was rewritten from the spec 058 shape (was checking `setInterval`; now also checks the subscription methods).

- **AC6: Cleanup complete — every event listener is unsubscribed in the `useEffect` cleanup.**
  PASS — Case 12 (describe "AC6 cleanup") mounts the hook, captures the three ref strings returned by `onOpen`, `onClose`, `onError`, unmounts, then asserts `socket.off` was called exactly once with `[openRef, closeRef, errorRef]`. The test verifies both the exact argument array and the call count. `src/hooks/useConnectionStatus.ts:155` calls `subscribedSocket.off(refs)` in the cleanup return function.

- **AC7: Existing TitleBar wiring unchanged — `src/components/cmd/TitleBar.tsx` not modified.**
  PASS — `TitleBar.tsx:8` still imports `useConnectionStatus` from `'../../hooks/useConnectionStatus'`; `TitleBar.tsx:77` still reads `const connected = useConnectionStatus();`. `git diff --name-only` confirms the file was not touched.

- **AC8: `TitleBar.test.tsx` mock continues to work unchanged.**
  PASS — `TitleBar.test.tsx:63-65` still reads `jest.mock('../../hooks/useConnectionStatus', () => ({ useConnectionStatus: () => true }))`. The module boundary mock is unaffected by the internal hook refactor.

- **AC9: Test file updated to mock event-emitter API; total count ≥ 14, no cases deleted.**
  PASS — The mock factory at lines 34-136 of the test file provides `socket.onOpen/onClose/onError` (each storing the callback and returning a unique ref string), `socket.off` (filters by ref), and test-only escape hatches `__getCapturedHandlers`, `__setInitialConnected`, `__getOffSpy`, `__getOnOpenSpy`, `__getOnCloseSpy`, `__getOnErrorSpy`, `__resetMock`. All 14 original cases from spec 058 are rewritten as event-driven equivalents; one new case (15th) was added for the §4 three-branch seed rule. Final count: 17 `test()` blocks across 8 describe groups. No deletions.

- **AC10: `npm test` passes; `npm run typecheck` passes; `npm run typecheck:test` passes.**
  PASS — See Test run section below.

### Test run

```
npm test
Test Suites: 23 passed, 23 total
Tests:       232 passed, 232 total
Snapshots:   0 total
Time:        1.485 s
```

```
npm run typecheck
(clean — zero diagnostics)

npm run typecheck:test
(clean — zero diagnostics)
```

`npm test -- --testPathPattern="useConnectionStatus" --verbose` output:
```
PASS unit src/hooks/useConnectionStatus.test.ts
  useConnectionStatus — initial seed branch
    ✓ seed returns true on initial mount with isConnected=false + state='connecting'
    ✓ stays true across `act()` flushes when no event has fired
  useConnectionStatus — onOpen flips connected to true
    ✓ dispatching captured onOpen callback flips connected to true
    ✓ onOpen fires after a prior onClose → flips back to true
  useConnectionStatus — onClose / onError flip connected to false
    ✓ dispatching captured onClose callback flips connected to false
    ✓ dispatching captured onError callback flips connected to false
  useConnectionStatus — sequence and latch
    ✓ open → close → open sequence latches correctly through each event
    ✓ close → error sequence — both map to false (no spurious flip)
  useConnectionStatus — synchronous flip inside act()
    ✓ onClose flips false in the same act() flush, no timer advancement
    ✓ onOpen flips true in the same act() flush, no timer advancement
  useConnectionStatus — AC2 no setInterval
    ✓ setInterval is never called by the hook (event-driven, not polled)
  useConnectionStatus — AC6 cleanup
    ✓ socket.off is called once on unmount with all three captured refs
  useConnectionStatus — post-unmount no-op
    ✓ invoking a captured callback after unmount does not flip result.current
  useConnectionStatus — native platform bail (spec 058 alignment)
    ✓ does NOT subscribe to socket events on native, returns optimistic default
  useConnectionStatus — initial-seed three-branch rule (Q4)
    ✓ isConnected=true → seed true regardless of connectionState
    ✓ isConnected=false + connectionState='connecting' → seed true (optimistic)
    ✓ isConnected=false + connectionState='closed' → seed false (explicitly down)

Tests: 17 passed, 17 total
```

### Specific checks

**Initial-seed coverage (AC4 detail):**
- `connectionState: 'connecting'` → seed `true` (optimistic): Case 1, also native-bail Case 14.
- `connectionState: 'open'` / `isConnected: true` → seed `true`: Case 2, Case 15 branch 1.
- `connectionState: 'closed'` → seed `false`: Case 3 setup, Case 15 branch 3.
All three branches of the §4 seed-rule decision table are directly exercised.

**Event-flip latency (AC3):**
No `jest.useFakeTimers` call exists in the file. No `advanceTimersByTime` call exists anywhere in the file. The `setInterval`/`setTimeout` mentions in the file are exclusively `jest.spyOn` with `not.toHaveBeenCalled()` assertions — they confirm timers are NOT used, not that they are.

**Cleanup coverage (AC6):**
Case 12 mounts, captures refs, unmounts, and asserts `socket.off` called once with the exact `[openRef, closeRef, errorRef]` array. Case 13 additionally verifies that a stale callback invoked after unmount does not mutate `result.current` (the value stays `true` from the seed, confirming React's unmounted-component protection).

**Native-bail regression (AC5):**
Case 14 uses `try/finally` to restore `Platform.OS`. The assertions check `__getOnOpenSpy().not.toHaveBeenCalled()`, `__getOnCloseSpy().not.toHaveBeenCalled()`, `__getOnErrorSpy().not.toHaveBeenCalled()` — these are the new event-subscription methods replacing the old `setInterval` check. The `setInterval` spy assertion is also retained as an additional regression invariant. This test was rewritten for the new shape, not skipped or hand-waved.

**Mutation test result:**
Commented out `if (Platform.OS !== 'web') return;` at line 118 of `src/hooks/useConnectionStatus.ts`. Jest ran Case 14 and failed at `expect(__getOnOpenSpy()).not.toHaveBeenCalled()` — the subscription methods were called because the bail was absent. 16/17 tests passed, 1 failed. Guard restored; suite returns to 17/17. The test is structurally load-bearing.

**No fake timers:**
`grep -n 'jest.useFakeTimers' src/hooks/useConnectionStatus.test.ts` returns zero matches. No leftover polling-test timer machinery.

**No new test framework introduced.**

### Notes

- The FE-developer added 3 net tests beyond the spec 058 count (14 → 17), satisfying AC9's "14 or grows" requirement. The three additions are: Case 13 (post-unmount no-op, which existed in spec 058 as a timer-advancement test but is now a substantive event-dispatch test), and Case 15's three sub-cases covering the §4 seed-rule branches.
- The `spec 059 §8b` case map targets 15 cases but the implementation delivers 17. The count is within spec (AC9: "14 minimum, zero deletions"). The extra two tests are the `setTimeout` spy in Case 11 (not a separate test, inline) and the three-sub-case expansion of Case 15 into individual `test()` blocks rather than one.
- No pgTAP or shell smoke coverage gaps — spec 059 is a pure FE jest-track refactor with no DB, RPC, or edge-function surface.
- The `supabase.realtime.socketAdapter.getSocket()` chain is private API; the JSDoc at lines 1-78 of `useConnectionStatus.ts` documents the version pin, the wall-clock budget caveat, and the drift-fallback behavior per spec requirements. This is a known accepted risk (spec §14).

**SHIP_READY** — all 10 acceptance criteria PASS, 17/17 tests pass, both typechecks clean, mutation test confirms the native-bail guard is load-bearing.

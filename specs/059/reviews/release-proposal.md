## Verdict
verdict: SHIP_READY
rationale: Zero Critical findings across both reviewers, 10/10 acceptance criteria PASS, 17/17 tests green, mutation test confirms the native-bail guard is load-bearing, and the browser smoke measured a real-world disconnect-detection improvement from up to 2000 ms (spec 057 poll) to ~774 ms (event-driven) with no change to consumer code.

## Findings summary

- **code-reviewer**: 0 Critical, 2 Should-fix, 4 Nits. All 10 checklist items confirmed (private-API null-checks at every hop, fail-safe failure mode, lazy `useState` initializer, captured-socket-ref cleanup, zero `setInterval`, platform bail first in `useEffect`, boolean return signature unchanged, no real timers in tests, JSDoc updated, no drift outside the hook + its test).
  - Should-fix #1: `__resetMock` does not clear `realtime.isConnected` / `realtime.connectionState` / `realtime.socketAdapter.getSocket` `jest.fn()` call counts. No active failure (no test asserts `toHaveBeenCalledTimes` on these), but the reset contract is incomplete.
  - Should-fix #2: Decision-rule branch 2 (`isConnected: false`, `connectionState: 'open'` → `true`) is not exercised in isolation — every existing `connectionState: 'open'` case also sets `isConnected: true` and short-circuits before the state check. Add a fourth sub-case to Case 15.
  - Nits: stale `setInterval` comment in `TitleBar.tsx:74-75` (out of scope per AC7, log as follow-up); bare `Function` type in mock factory; `__getCapturedHandlers()` call ordered before `renderHook` in Case 13 (works but reads confusingly); slightly imprecise JSDoc wording around the lazy-vs-eager `useState` comparison.

- **test-engineer**: 10/10 ACs PASS, 0 FAIL, 0 NOT TESTED. `npm test` → 23 suites / 232 tests pass in 1.485 s. `npm run typecheck` and `npm run typecheck:test` both clean. All three §4 seed-rule branches exercised. Mutation test of AC5 native-bail guard verified — removing the guard fails Case 14 deterministically. No `jest.useFakeTimers`, no `advanceTimersByTime`, no real timers. Explicit SHIP_READY recommendation.

- **backend-architect**: Not invoked (FE-only refactor, no backend/DB/RPC/edge-function surface touched).

## Browser-verification headline

Live smoke against the local stack measured the actual real-world win:
- Hard disconnect → "reconnecting" flip: **774 ms** (was up to 2000 ms with the spec 057 poll; ~2.5x faster than the previous worst-case)
- Reconnect cadence (~26 s) is the underlying socket's behavior, identical with either implementation
- Color and text transitions captured correctly in both directions (green/connected ↔ amber/reconnecting)

The 774 ms result is the headline: detection latency improved without changing any consumer code and without the architect's predicted 50–200 ms (the gap is `socket.disconnect()` waiting for close-frame confirmation before firing `onClose`, not a hook-side issue).

## Process note

Spec 059 landed clean first-pass with zero fix-loop iterations, same as spec 058. Spec 057 needed a Pass-2 re-spin to fix a Rules-of-Hooks Critical. Emerging pattern worth recording: refactors that pin a stable public signature (058: same `LoadingBar` props; 059: same `useConnectionStatus(): boolean` return) ship faster than refactors that introduce new public surface (057 added `useConnectionStatus` itself as a new hook). Lower API-surface delta correlates with cleaner first-pass review.

## Recommended next steps (ordered)

1. **Commit and push to `main`.** The two Should-fix items and four Nits are non-blocking. Suggested message shape: `feat: event-driven useConnectionStatus refactor (Spec 059, SHIP_READY) — Phoenix Socket onOpen/onClose/onError replaces 2 s poll, disconnect detection measured at 774 ms (vs. up to 2000 ms)`.

2. **(Follow-up, non-blocking)** Open a brief polish-pass spec batching all six deferrable items:
   - SF#1: complete `__resetMock` to clear the three `realtime.*` `jest.fn()` instances
   - SF#2: add the missing seed-rule branch-2 sub-case to Case 15 (`isConnected: false`, `connectionState: 'open'` → `true`)
   - Nit #1: update the stale `setInterval` comment at `TitleBar.tsx:74-75` (out of AC7 scope here)
   - Nit #2: replace bare `Function` / `Function[]` with `() => void` / `Array<() => void>` in the mock factory
   - Nit #3: re-order `__getCapturedHandlers()` after `renderHook` in Case 13
   - Nit #4: tighten the JSDoc lazy-vs-eager wording around `readInitialConnected`
   None of these affects runtime behavior, observable test outcomes, or the acceptance contract. Pure hygiene.

## Out of scope for this review

- `TitleBar.tsx:74-75` stale comment — explicitly forbidden by AC7. Fix on next routine touch of `TitleBar.tsx`.
- The underlying ~26 s socket reconnect cadence — that lives in `supabase-js` / Phoenix Socket config, not in this hook.
- The general `_shared/` vs. inline duplication discussion for FE hooks — separate architectural conversation if it ever comes up.

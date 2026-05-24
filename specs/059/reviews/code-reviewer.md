## Code review for spec 059

### Critical

_None._

### Should-fix

- `src/hooks/useConnectionStatus.test.ts:122-134` — `__resetMock` clears the four Phoenix socket spies (`offSpy`, `onOpenSpy`, `onCloseSpy`, `onErrorSpy`) but does NOT clear the three `jest.fn()` instances on the `realtime` object: `realtime.isConnected`, `realtime.connectionState`, and `realtime.socketAdapter.getSocket`. Their `.mock.calls` arrays accumulate across tests. No current test asserts `.toHaveBeenCalledTimes` on these three, so there is no active failure — but the omission makes the reset contract incomplete and will silently break any future test that does. Add `realtime.isConnected.mockClear(); realtime.connectionState.mockClear(); realtime.socketAdapter.getSocket.mockClear();` to `__resetMock`.

- `src/hooks/useConnectionStatus.test.ts:510-531` (case 15) — The spec §4 decision rule has four paths: `isConnected() === true`, `connectionState() === 'open'`, `connectionState() === 'connecting'`, and anything else. Case 15 covers branches 1, 3, and 4. Branch 2 (`isConnected: false, connectionState: 'open' → true`) is never exercised in isolation because every test that uses `connectionState: 'open'` also sets `isConnected: true`, which causes the hook to short-circuit at line 94 before reaching the `connectionState` check. Add a fourth sub-case: `__setInitialConnected({ isConnected: false, connectionState: 'open' })` → `result.current` is `true`. This closes the coverage gap on the `s === 'open'` path of `readInitialConnected`.

### Nits

- `src/components/cmd/TitleBar.tsx:74-75` — Comment still reads "self-gates its `setInterval` side-effect on platform, so the poller never starts on native." This is now factually stale; the hook is event-driven and has no `setInterval`. TitleBar.tsx is out of scope for this spec (AC7 explicitly forbids editing it), so this cannot be fixed here. Flag as a follow-up cleanup in the next routine touch of TitleBar.

- `src/hooks/useConnectionStatus.test.ts:36,43,65,71,77,150` — `Function[]` and `Function` (the global-object type) are used throughout the mock factory and its type annotations. TypeScript strict mode discourages the bare `Function` type in favor of a callable signature (e.g., `() => void`). The mock is test-only code and `@typescript-eslint` would catch this, but since the project runs `typecheck:test` in CI it is worth aligning. Change `Function[]` → `Array<() => void>` and `(cb: Function)` → `(cb: () => void)` in the mock closure.

- `src/hooks/useConnectionStatus.test.ts:426-432` — In case 13 (post-unmount no-op), `handlers` is obtained by calling `__getCapturedHandlers()` at line 426, three lines BEFORE `renderHook` at line 428. The `handlers` object IS the live closure reference so `handlers.close[0]` resolves correctly after the hook mounts — it just reads confusingly as "getting handlers before the hook has subscribed." Moving the `__getCapturedHandlers()` call to after `renderHook` (between lines 428 and 429) would make the read-order match the actual subscription order and eliminate the apparent race.

- `src/hooks/useConnectionStatus.ts:107-109` — The comment "The literal `useState(true)` form would NOT call the seed reader" is slightly imprecise: `useState(readInitialConnected)` (lazy) and `useState(readInitialConnected())` (eager) are the two forms being contrasted, not `useState(true)`. The comment as written implies the alternative would be `useState(true)`, but the actual wrong form the spec warned against (and the architect called out in §7) is `useState(readInitialConnected())` — calling the function eagerly on every render. Suggest rewording to: "Do NOT use `useState(readInitialConnected())` — the eager form calls the function on every render. The lazy form here calls it exactly once at mount."

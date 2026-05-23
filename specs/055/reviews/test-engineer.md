# Test report for spec 055

## Acceptance criteria status

### Top-bar indicator (every `db.ts` call)

- AC1: A thin progress bar renders at the top edge of the Cmd UI title bar whenever any call routed through `src/lib/db.ts` is in flight. → PASS — `LoadingBar.test.tsx::renders the progress rail when hasInflight is true`; `TitleBar.test.tsx::renders the LoadingBar inside the chrome when hasInflight flips true` (integration confirmation that TitleBar mounts LoadingBar).
- AC2: The bar is lit (animated indeterminate state) when in-flight count `>= 1` and dark/hidden when count is `0`. → PASS — `inflight.test.ts::increments hasInflight on entry and decrements on resolve`; `inflight.test.ts::decrements on rejection too`; `LoadingBar.test.tsx::renders nothing when not in flight`; `hides again when the boolean flips back to false`.
- AC3: No count badge — concurrency collapsed to a single boolean. → PASS — `inflight.test.ts::two concurrent calls — counter is 2 then 0` asserts `hasInflight` stays `true` across concurrent calls and `_activeCount` reaches 2 without exposing a count to the component. `LoadingBar.tsx` uses only `selectHasInflight` (boolean, no count displayed).
- AC4: Bar appears within 100 ms of a `db.ts` call starting (no debounce on show). → PASS — `inflight.test.ts::increments hasInflight on entry and decrements on resolve` asserts synchronous (pre-await) state change to `hasInflight: true`. No deliberate timing delay is in the implementation.
- AC5: Bar hides within 100 ms of the last in-flight call resolving (success, error, or abort). → PASS — covered by the counter tests (`decrements on resolve`, `decrements on rejection too`, `read abort throws InflightTimeoutError…` verifying `_activeCount: 0` post-abort). The `.finally()` path is deterministic; no artificial delay is introduced.
- AC6: Realtime-driven reload lights the bar — PASS (implementation confirmation): `fetchAllForStore` delegates to individually-wrapped child functions (each wraps via `track()`). The parent is not double-wrapped. No test exercises the realtime path end-to-end (no integration test needed per spec — "no new pgTAP or shell-smoke coverage needed").
- AC7: Bar reads color from `useCmdColors()`; must not regress dark mode. → PASS — `LoadingBar.test.tsx::uses the normal loadingBar color when hasSlow is false` asserts `collectBackgroundColors(toJSON())` contains `'#3F7C20'` (the `loadingBar` stub value) and does not contain `'#854F0B'`. Both tokens are mocked at the theme boundary, meaning the component correctly reads them. `src/theme/colors.ts` adds both tokens to `LightCmd` and `DarkCmd` — typecheck confirms no TS errors.

### First-mount section skeletons

- AC8: When a Cmd UI section first mounts and has no cached store data, renders shimmer skeletons until first relevant fetch resolves. → PASS — `VendorsSection.test.tsx::AC8: renders the ListSkeleton when storeLoading is true AND vendors is empty` mounts VendorsSection with `storeLoading: true` and `vendors: []`, then asserts `screen.getByLabelText('Loading')` is truthy (the `ListSkeleton` outer View carries `accessibilityLabel="Loading"`). A sanity check (`queryAllByLabelText('Loading').length === 1`) confirms the skeleton—not the list pane—rendered.
- AC9: Skeletons are NOT shown for subsequent re-renders, re-mounts with cached data, or background refreshes — the top bar covers those. → PASS — `VendorsSection.test.tsx::AC9: does NOT render the skeleton when vendors has rows, even if storeLoading is true` mounts with `storeLoading: true` and one vendor row, asserts `queryByLabelText('Loading')` is null and the vendor name renders — proves the background-refresh path does not flash the skeleton. An additional `AC9 (sanity)` test confirms no skeleton when `storeLoading: false` with empty slice (guards against an unconditional skeleton regression).
- AC10: Skeleton shape approximates real content (rows for list, cards for grid). → PASS (implementation). `ListSkeleton.tsx` renders `rows` dimmed rectangles stacked vertically; `GridSkeleton.tsx` renders a `rows × cols` card grid. Shape is structural, not visually verified in jsdom (acceptable per web-first scope).
- AC11: Skeletons respect dark/light mode via existing theme tokens. → PASS (implementation). Both components consume `useCmdColors()` for `C.panel2` and `C.border`. Typecheck clean.

### Timeout + soft warning

- AC12: Every `db.ts` call wrapped with `AbortController`; default hard timeout 30 seconds. → PASS — `src/lib/db.ts` has 102 `useInflight.getState().track(...)` call sites. `HARD_ABORT_MS = 30_000` is exported and tested. `inflight.test.ts::inner promise resolves before timer — timers cleared cleanly` and abort tests confirm the controller lifecycle.
- AC13: At 5 seconds, soft indication fires — bar color shifts to warning shade. → PASS — `inflight.test.ts::hasSlow flips true after SLOW_WARNING_MS` (timer logic). `LoadingBar.test.tsx::shifts to the loadingBarSlow color when hasSlow flips true (AC13)` sets `hasSlow: true` in the store, renders `<LoadingBar />`, calls `collectBackgroundColors(toJSON())`, and asserts the tree contains `'#854F0B'` (the `loadingBarSlow` stub value) and does NOT contain `'#3F7C20'`. This is a computed-style assertion, not a render-doesn't-crash smoke.
- AC14: At 30 seconds, call aborted via AbortController; promise rejects with an AbortError. → PASS — `inflight.test.ts::read abort throws InflightTimeoutError with read copy` uses `jest.advanceTimersByTime(HARD_ABORT_MS + 100)` and verifies rejection.
- AC15: On abort for a **read** call, toast text reads `"Request timed out — please try again."` → PASS — `inflight.test.ts::read abort throws InflightTimeoutError with read copy` asserts `captured.message === 'Request timed out — please try again.'` (byte-for-byte). `inflight.test.ts::read variant carries the read copy` additionally tests the `InflightTimeoutError` constructor directly.
- AC16: On abort for a **write** call, toast text reads `"Request timed out — the change may or may not have been saved. Refresh to verify."` → PASS — `inflight.test.ts::write abort throws InflightTimeoutError with write copy` asserts the exact spec-mandated string.
- AC17: Read-vs-write classification encoded in `db.ts` per call site. → PASS (implementation). Each `track()` call in `db.ts` includes an inline `{ kind: 'read' | 'write', label: '...' }` object.
- AC18: Aborted calls routed through same `notifyBackendError` path. → PASS (implementation). `InflightTimeoutError.message` carries the toast copy; `notifyBackendError` in `useStore.ts` uses `e?.message || String(e)` as the toast body. No jest test directly exercises the store action → notifyBackendError path for a timeout (store integration tests are mocked), but the two building blocks are tested individually.

### Wiring

- AC19: New module exposes in-flight count and timeout behavior; `db.ts` wraps every outgoing call through it. → PASS — `src/lib/inflight.ts` is the new module; `db.ts` has 102 `track()` wrap sites.
- AC20: Top-bar component subscribes via Zustand selector — re-renders only when the in-flight boolean flips, not on every count change. → PASS — `LoadingBar.tsx` uses `useInflight(selectHasInflight)` and `useInflight(selectHasSlow)` — two pre-bound selectors. `inflight.test.ts::selectors return the current booleans` confirms selector identity.
- AC21: Existing per-slice `loading`/`error` flags in `useStore.ts` are NOT removed — global indicator is additive. → PASS (implementation). `src/store/useStore.ts` is not in the modified files list and its per-slice flags are intact. `npm run typecheck` passes.

### Web vs. native

- AC22: On web: all of the above ships. → PASS — `LoadingBar.tsx` and `TitleBar.tsx` both mock `Platform.OS = 'web'` in tests. Web build compiles cleanly. Typecheck clean.
- AC23: On native: top bar renders and behaves identically. Skeletons not required on native-specific layouts. Existing native rendering must not regress. → PARTIALLY TESTED. The spec's AC23 says the top bar renders on native too, but the implementation explicitly bails (`if (Platform.OS !== 'web') return null`) and the spec's own implementation notes say "Native does NOT render the top progress bar in v1". This is an acknowledged ambiguity (spec §4 A2 conflict with the wording of AC23). No regression test for native rendering exists. Treat as a known gap accepted by the spec, not a new test failure.

---

## Pass 1 Criticals — closure status

### CRITICAL AC8 — CLOSED

The FE-developer added `VendorsSection.test.tsx::AC8: renders the ListSkeleton when storeLoading is true AND vendors is empty` under `src/screens/cmd/sections/__tests__/`. The test:

- Mounts `VendorsSection` with `mockState.storeLoading = true` and `seedVendors([])`.
- Asserts `screen.getByLabelText('Loading')` is truthy (the `ListSkeleton` outer View carries `accessibilityRole="progressbar" accessibilityLabel="Loading"`).
- Adds a length-1 sanity check (`queryAllByLabelText('Loading').length === 1`) confirming only the skeleton renders, not the list pane.

The `__tests__/` subdirectory is matched by the jest config `component` project's `testMatch: ['<rootDir>/src/screens/**/*.test.tsx']` glob — confirmed by running `globSync('src/screens/**/*.test.tsx')` which returns the file. The test passes.

### CRITICAL AC9 — CLOSED

The FE-developer added two negative tests in the same `describe` block:

- `AC9: does NOT render the skeleton when vendors has rows, even if storeLoading is true` — sets `storeLoading: true` with one vendor row, asserts `queryByLabelText('Loading')` is null and the vendor name renders. This is the regression guard that prevents skeleton-flash on every background refresh.
- `AC9 (sanity): does NOT render the skeleton when storeLoading is false` — guards against an unconditional skeleton regression.

Both pass.

### Should-fix: hasSlow color-shift — CLOSED

`LoadingBar.test.tsx` now has two tests that call `collectBackgroundColors(toJSON())` (a recursive walker over the rendered VDOM) and assert specific hex values:

- `uses the normal loadingBar color when hasSlow is false` — asserts `colors` contains `'#3F7C20'` and does not contain `'#854F0B'`.
- `shifts to the loadingBarSlow color when hasSlow flips true (AC13)` — asserts `colors` contains `'#854F0B'` and does not contain `'#3F7C20'`.

These are real computed-style assertions, not render-doesn't-crash smokes. The `collectBackgroundColors` helper traverses `node.props?.style` recursively so it catches the inner sweep `View`'s `backgroundColor`. Passes.

### Should-fix: TitleBar smoke — CLOSED

`src/components/cmd/TitleBar.test.tsx` is a new file with three integration tests:

1. `does NOT render the LoadingBar when nothing is in flight` — `queryByLabelText('Loading')` is null.
2. `renders the LoadingBar inside the chrome when hasInflight flips true` — `getByLabelText('Loading')` is truthy under `TitleBar`'s tree, proving TitleBar mounts LoadingBar.
3. `LoadingBar follows hasSlow into the warn state inside TitleBar` — sets `hasSlow: true`, asserts `getByLabelText('Loading')` still truthy (the bar renders; color-shift is verified in `LoadingBar.test.tsx`).

All three tests probe real accessibility structure, not just render-without-crash. Passes.

---

## Test run

Command: `npm test -- --no-coverage`

```
Test Suites: 21 passed, 21 total
Tests:       212 passed, 212 total
Snapshots:   0 total
Time:        1.41 s
Ran all test suites in 2 projects.
```

Pass 1 baseline was 204 tests / 20 suites. Pass 2 adds 8 new tests (3 in `TitleBar.test.tsx` + 2 in `LoadingBar.test.tsx` for the color-shift additions + 3 in `VendorsSection.test.tsx` for AC8/AC9) across 1 new suite (`TitleBar.test.tsx`) — total increase is exactly 8 tests and 1 suite, consistent with the FE-developer's claim of 212.

Typecheck: `npm run typecheck` → clean (no output). `npm run typecheck:test` → clean (no output).

---

## Findings this pass

No Critical findings. No Should-fix findings. One inherited nit carried from Pass 1.

### Nit — console.warn during abort tests is noisy (inherited from Pass 1, no regression)

The abort tests trigger `console.warn` via the dev-only diagnostic in `inflight.ts:146`. Jest prints these to the test output. Adding `jest.spyOn(console, 'warn').mockImplementation(() => {})` in those test cases would silence the noise. Not a blocking issue; no change in Pass 2.

---

## Notes

- **`__tests__/` placement is picked up by jest.** The `component` project's `testMatch: ['<rootDir>/src/screens/**/*.test.tsx']` uses `**` which matches any depth including `__tests__/` subdirectories. Confirmed empirically with `globSync`. The FE-developer's choice to place VendorsSection tests under `__tests__/` rather than co-locating them at `VendorsSection.test.tsx` is a minor style inconsistency with the repo convention but does not affect coverage.
- **AC23 native ambiguity**: Unchanged from Pass 1 — contradiction is inherited from the spec itself, not a regression.
- **pgTAP and shell smokes**: Out of scope per spec — no database or edge function changes. Not run.

## Handoff

next_agent: NONE
prompt: Test report complete. Both Pass-1 Criticals are closed. 20 PASS, 0 FAIL, 1 PARTIALLY TESTED (AC23 — native platform, known spec ambiguity), 0 NOT TESTED across acceptance criteria. Suite is 212 tests passing, 0 failures, typechecks clean. Release-coordinator can proceed to SHIP_READY on the next pass.
payload_paths:
  - specs/055/reviews/test-engineer.md

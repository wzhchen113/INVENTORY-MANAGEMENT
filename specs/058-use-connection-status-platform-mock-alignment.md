# Spec 058: Align `useConnectionStatus` test Platform mock with project convention

Status: READY_FOR_REVIEW

## Problem

`src/hooks/useConnectionStatus.test.ts:24` mocks the entire `react-native`
module to stub `Platform`. Every other test file in this project that needs to
stub `Platform` targets the granular path
`'react-native/Libraries/Utilities/Platform'` —
[src/components/cmd/LoadingBar.test.tsx:24](../src/components/cmd/LoadingBar.test.tsx),
[src/components/cmd/TitleBar.test.tsx:20](../src/components/cmd/TitleBar.test.tsx),
[src/components/cmd/MobileTopAppBar.test.tsx:25](../src/components/cmd/MobileTopAppBar.test.tsx).
The top-level mock works today (the hook only imports `Platform`) but is
narrower in what it exposes: any future `react-native` import the hook gains
would silently resolve to `undefined`. Pass-2 code-reviewer on spec 057 called
this out as Should-fix.

## User story

As a test author, I want all `Platform` mocks in this repo to target the same
granular path so a future `react-native` import in a hook under test does not
silently break the suite.

## Acceptance criteria

- [ ] `src/hooks/useConnectionStatus.test.ts` `jest.mock(...)` call at line 24
  targets `'react-native/Libraries/Utilities/Platform'` instead of
  `'react-native'`, matching the three reference test files cited above.
- [ ] The native-bail test's `require('react-native')` call at line 244 is
  updated to `require('react-native/Libraries/Utilities/Platform')` so the
  Platform mutation still hits the mocked module (the code-reviewer note
  flagged this paired change).
- [ ] All 14 existing tests in the file still pass. No behavioral change.
- [ ] The native-bail regression test (`'does NOT call setInterval on native
  and returns the optimistic default'`) continues to pass — the `try/finally`
  mutation logic is unchanged.

## In scope

- The two lines in `src/hooks/useConnectionStatus.test.ts` that reference
  `'react-native'` (the `jest.mock` call and the native-bail `require`).
- Mock factory shape stays identical — the same `{ __esModule: true, Platform:
  { OS: 'web', select: ... } }` object, just under a different module path. (If
  the granular-path mock requires a different shape — e.g. exporting the
  Platform object as `default` rather than as a named `Platform` field — match
  whatever the three reference test files use.)

## Out of scope (explicitly)

- Any change to the production hook at `src/hooks/useConnectionStatus.ts`. The
  hook does not change.
- Crusading across the rest of the repo for other test files that may have a
  similar top-level `react-native` mock. The three reference files already
  follow the convention; if a future file diverges that is a separate spec.
- Adding a lint rule or pgTAP probe to enforce the convention. Out of scope —
  this is a one-line cleanup, not a policy spec.

## Open questions resolved

None. The cleanup is unambiguous.

## Dependencies

- None. Test-file-only change. Existing jest infrastructure under
  [.github/workflows/test.yml](../.github/workflows/test.yml) catches a
  regression on the next CI run.

## Project-specific notes

- Cmd UI section / legacy: N/A — test file only.
- Per-store or admin-global: N/A — no DB or RLS touched.
- Realtime channels touched: none.
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: test-only; the production hook continues to work on both.
- Tests track: **jest** — this IS the jest-track change. No new tests; the
  existing 14 must keep passing.

## Backend design

No backend impact whatsoever — this is a jest-track test-file cleanup with zero contract, migration, RLS, edge-function, realtime, `src/lib/db.ts`, or `src/store/useStore.ts` surface area. The two and only two changes both live in [src/hooks/useConnectionStatus.test.ts](../src/hooks/useConnectionStatus.test.ts): (1) the `jest.mock('react-native', ...)` call at line 24 swaps the module path to `'react-native/Libraries/Utilities/Platform'` AND adopts the canonical factory shape used by the three reference files — namely `{ __esModule: true, default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default }, OS: 'web' }` (verified against [src/components/cmd/LoadingBar.test.tsx:24-28](../src/components/cmd/LoadingBar.test.tsx); the granular path exports Platform as `default`, not as a named `Platform` field — so the spec's mock-factory parenthetical is the operative one); (2) the paired `require('react-native')` destructure at line 244 swaps to `require('react-native/Libraries/Utilities/Platform').default` so the native-bail test still mutates the same mocked-module instance jest is wiring up (mutating the named `Platform` field on the old shape vs. mutating `default.OS` on the new shape — the `originalOS`/`Platform.OS = 'ios'`/`finally` restore pattern is otherwise structurally identical). Risks are bounded: the only way this regresses is if the developer updates one call site without the other, in which case the native-bail test's `Platform.OS = 'ios'` mutation lands on an unrelated object and the `setInterval`-not-called assertion silently passes for the wrong reason — call-site parity must be reviewed as a pair. The existing 14 tests in the file (jest-expo unit-project) provide full regression coverage on the next CI run via [.github/workflows/test.yml](../.github/workflows/test.yml); no new tests required.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec. Two-line swap in `src/hooks/useConnectionStatus.test.ts` — update the `jest.mock` at line 24 to target `'react-native/Libraries/Utilities/Platform'` with the canonical `{ __esModule: true, default: { OS: 'web', select: ... }, OS: 'web' }` factory shape (mirror [src/components/cmd/LoadingBar.test.tsx:24-28](../src/components/cmd/LoadingBar.test.tsx)), AND update the paired `require('react-native')` destructure at line 244 to `require('react-native/Libraries/Utilities/Platform').default` so the native-bail test mutates the same module instance. Both edits must land together. After implementation, run jest on the file to confirm all 14 tests still pass, then set `Status: READY_FOR_REVIEW` and list files changed under `## Files changed`.
payload_paths:
  - specs/058-use-connection-status-platform-mock-alignment.md

## Files changed

- `src/hooks/useConnectionStatus.test.ts` — swapped the `jest.mock` module path (line 24) from `'react-native'` to `'react-native/Libraries/Utilities/Platform'` with the canonical `{ __esModule: true, default: { OS: 'web', select: ... }, OS: 'web' }` factory shape mirroring `src/components/cmd/LoadingBar.test.tsx:24-28`; swapped the paired native-bail `require('react-native')` destructure (line 244) to `require('react-native/Libraries/Utilities/Platform').default` so the `Platform.OS = 'ios'` mutation lands on the same mocked module instance jest is wiring up.

## Verification

- `npx jest src/hooks/useConnectionStatus.test.ts` — all 14 tests pass (empty-channels, healthy single-channel, unhealthy single-channel, mixed-state aggregation, polling-picks-up-mutations, cleanup, native platform bail describe blocks).
- `npm test` — full jest suite: 23 suites / 229 tests pass.
- `npm run typecheck` — clean.
- `npm run typecheck:test` — clean.
- Mutation-test the native-bail case: temporarily replaced the `if (Platform.OS !== 'web') return;` guard inside `useConnectionStatus.ts`'s `useEffect` with `void Platform;` and re-ran the native-bail test — it FAILED with `expect(setSpy).not.toHaveBeenCalled()` receiving 1 call (proving the test's `Platform.OS = 'ios'` mutation lands on the same object the production hook reads). Guard restored; all 14 tests pass again.

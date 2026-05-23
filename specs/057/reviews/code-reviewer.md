## Code review for spec 057 (Pass 2)

Pass 1 flagged one Critical (Rules-of-Hooks violation in `TitleBar.tsx`) and one Should-fix (test-count mismatch). The FE developer addressed both with a pass-2 amendment that moved the platform gate inside the hook's `useEffect` body, moved the hook call above the early return in `TitleBar.tsx`, and added a 14th regression test. This review verifies the closures and scans the new changes for regressions.

---

### Pass-1 findings — status

**Critical (Rules of Hooks)** — CLOSED.
`src/components/cmd/TitleBar.tsx:77`: `const connected = useConnectionStatus()` now appears at line 77, unconditionally before the `if (Platform.OS !== 'web') return null` early return at line 79. The hook call order invariant is satisfied. The comment block at lines 70-77 correctly explains the requirement.

**Should-fix (test count mismatch)** — CLOSED.
`src/hooks/useConnectionStatus.test.ts` now has 14 tests under 7 describe blocks (the 7th "native platform bail" describe added in pass 2). The spec's "Files changed" (pass 2) section correctly states 14/7. The pass-1 "Files changed" section (lines 469-477) still says 13/6 for pass 1, which is accurate — the pass-2 addendum is the live count. No confusion for future readers.

---

### Critical

None.

---

### Should-fix

- `src/hooks/useConnectionStatus.test.ts:24-27` — The file-level `jest.mock('react-native', ...)` replaces the ENTIRE `react-native` module with an object that exposes only `Platform`. The hook currently only imports `Platform` from `react-native`, so nothing is missing today. But this mock shape is more brittle than the established project pattern: every other test file that needs to stub `Platform` in the unit or component projects targets the granular path `'react-native/Libraries/Utilities/Platform'` (see `LoadingBar.test.tsx:24`, `TitleBar.test.tsx:20`, `MobileTopAppBar.test.tsx:25`). If the hook later gains a second import from `react-native` (e.g. `useEffect`, `useState` — both already imported from `'react'` directly, so unlikely here — but any future `Dimensions`, `AppState`, etc.) the top-level mock silently drops that export and the test breaks in a hard-to-diagnose way. The granular path mock does not have this problem: it only overrides `Platform` and leaves the rest of the RN module intact. Consider switching to the project-consistent pattern:
  ```ts
  jest.mock('react-native/Libraries/Utilities/Platform', () => ({
    __esModule: true,
    default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
    OS: 'web',
  }));
  ```
  The native-bail test at line 244 that does `const { Platform } = require('react-native')` would also need to change to `require('react-native/Libraries/Utilities/Platform')`, but the `try/finally` mutation logic stays identical.

---

### Nits

- `src/hooks/useConnectionStatus.test.ts:51-53` — The `__setChannels` helper is typed at the import site as `(next: { state: string }[]) => void`. The mock factory at lines 35-44 types it via `state: { channels: { state: string }[] }` — which is consistent. However, there is a subtle mismatch: the production hook reads `(supabase as any).realtime?.channels`, where each element is a full `RealtimeChannel` object with many more fields than `{ state: string }`. The test type `{ state: string }[]` is intentionally narrow (structural subtype) and correct for the hook's actual `.some(c => c.state === ...)` read. A one-line comment acknowledging this would prevent a future contributor from thinking the type needs widening: `// Narrow stub — hook only reads c.state; wider RealtimeChannel shape is not needed.` (Existing comment at lines 41-43 gets close but doesn't address the deliberate narrowness.)

- `src/hooks/useConnectionStatus.test.ts:183-206` (cleanup describe) — The `setSpy` and `clearSpy` are created at the top of the test body but `setSpy.mockRestore()` and `clearSpy.mockRestore()` are called at the bottom of the same test, not in `afterEach`. This means a test failure between the spy setup and `mockRestore` would leave the spies active for subsequent tests. `inflight.test.ts:204-210` handles an analogous `warnSpy` in a `beforeEach`/`afterEach` pair to avoid this. The current shape still works (the test passes) and the risk is low — but it diverges from the project's own precedent for spy lifecycle management. Moving spy setup + restore to a `beforeEach`/`afterEach` scoped to that describe block would align with `inflight.test.ts`.

- `src/hooks/useConnectionStatus.ts:59` — The inline comment `// 'joined' or 'subscribed' are healthy states; default optimistic if no / channels yet ...` is split mid-sentence across line 60. The JSDoc block above the function (lines 22-27) already states this clearly. The inline comment at line 59-62 is redundant with the file-level header comment and with the spec-level rationale. Minor duplication but not harmful; collapsing it to a single sentence (`// healthy = 'joined' || 'subscribed'; empty array → optimistic true`) would keep the comment tighter.

- `specs/057-use-connection-status-hook.md:464-467` — The pass-1 "Files changed" entry for `useConnectionStatus.ts` still says "JSDoc documents ... the absence of a platform gate (caller responsibility)". The pass-2 implementation replaced that JSDoc note with the in-effect gate rationale (spec §3a). The pass-1 entry was not retroactively updated; the pass-2 addendum (lines 533-538) does correctly describe the new state. No functional impact, but a future reader skimming the pass-1 block will see stale JSDoc description. Acceptable given that the pass-2 addendum supersedes it and is clearly labeled — no action required before merge.

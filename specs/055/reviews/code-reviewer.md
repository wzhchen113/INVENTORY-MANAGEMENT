# Code review — Spec 055 (global loading indicator) — Pass 2

Reviewer: code-reviewer
Date: 2026-05-23
Pass: 2 (fix-pass verification)

## Pass-1 findings closure status

| Pass-1 finding | Status |
|---|---|
| CRITICAL: `LoadingBar.test.tsx` mocked `lib/supabase` directly | CLOSED — now mocks `../../theme/colors` per StatusPill pattern |
| SHOULD-FIX: `inflight.ts:96-102` dead `ctrl.signal.aborted` guard | CLOSED — dead guard removed, replaced with a comment explaining the internal-only abort path |
| SHOULD-FIX: `inflight.ts:127,129` redundant `(ctrl as AbortController)` casts | CLOSED — casts gone; `ctrl.abort()` is uncast |
| SHOULD-FIX: GridSkeleton/ListSkeleton shimmer duplication | CLOSED — `skeletonUtils.ts` extracted; both components import `ensureSkeletonShimmer` + `SKELETON_KEYFRAME` from the shared helper |
| SHOULD-FIX: `LoadingBar.tsx:84` `any` type consistency | NOT in fix-pass scope (was buried in the missing Pass-1 file; not enumerated in the release-proposal's Should-fix list); still `any` consistently in all three files — no new drift |
| NIT: `inflight.ts:92` trailing `<T,>` comma | CLOSED |
| NIT: `inflight.test.ts:65` signal-ignored comment | CLOSED — comment on line 63 reads "signal intentionally ignored in this test — counter lifecycle only" |
| NIT: `db.ts:1-24` misleading `.abortSignal()` ordering comment | CLOSED — line 14 now says "must come BEFORE `.single()` / `.maybeSingle()`" |
| NIT: `LoadingBar.tsx:75` `ensureKeyframes()` in render body | Not addressed — acceptable nit, no regression |
| NIT: `ListSkeleton.tsx:115` `key={i}` | Not addressed — acceptable nit, no regression |

---

## Critical

None.

---

## Should-fix

- `src/components/cmd/TitleBar.test.tsx:61-66` — The test mocks `../../lib/supabase` directly, violating the tests/README.md rule: "Do NOT mock `src/lib/supabase.ts` for component tests." The comment at line 59 acknowledges this: "TitleBar reads `supabase.realtime.channels` in the connection indicator's interval." The forced necessity comes from `TitleBar.tsx:6`, which has a direct `import { supabase } from '../../lib/supabase'` outside `db.ts`. That direct import is a pre-existing architecture violation (CLAUDE.md: "All PostgREST/RPC traffic flows through `src/lib/db.ts`") from before spec 055, and the test is the symptom. The mock itself is minimal — it doesn't re-implement builder semantics — so the test works, but the convention is still violated.

  Fix: extract the `supabase.realtime.channels` polling from `TitleBar.tsx` (lines 86-100) into a `useConnectionStatus()` hook in `src/hooks/`. The hook can be mocked at the hook boundary in the test (`jest.mock('../../hooks/useConnectionStatus', ...)`) instead of at `lib/supabase`. This also removes TitleBar's only direct `lib/supabase` import, bringing it into line with the project's db-centralization convention.

  Scope caveat: the root cause is in `TitleBar.tsx`, not in the test. If TitleBar.tsx is out of scope for this fix-pass, annotate the test mock with a TODO pointing at the TitleBar refactor rather than leaving the convention violation undocumented. The current comment at line 59-60 is appropriate but does not mention the convention breach.

---

## Nits

- `src/components/cmd/skeletonUtils.ts:15` — Module-scoped `let injected = false` is a mutable module variable that crosses test-file boundaries only if modules are NOT reset between files. Jest isolates test files with fresh module registries by default, so this is safe in practice. A comment noting "module-scoped — jest resets this between test files" would make the isolation guarantee explicit for future test authors who might wonder why the flag doesn't need a `beforeEach` reset.

- `src/components/cmd/TitleBar.test.tsx:15` — Comment says "Mocking shape follows VendorsSection.test.tsx." The `VendorsSection.test.tsx` file is a screen test; TitleBar is a component test. The actual mock shape being followed more closely is the `useStore` Zustand-function-stub pattern, not specifically the vendor-section file. A more precise citation would be: "Zustand mock shape follows the pattern in `VendorsSection.test.tsx` — `jest.fn((selector) => selector(state))`."

- `src/components/cmd/GridSkeleton.tsx:23` and `src/components/cmd/ListSkeleton.tsx:69` — `ensureSkeletonShimmer()` is called unconditionally inside the render body (guarded only by the `Platform.OS === 'web'` check inline). The same nit was raised for `LoadingBar.tsx:75` in Pass 1: calling a DOM-touching function during render is a side effect that React Strict Mode double-invokes in development. The idempotency guard makes this harmless, but `React.useEffect(() => { if (Platform.OS === 'web') ensureSkeletonShimmer(); }, [])` in the component body would be more idiomatically correct. Carry-over from Pass 1 — consistency across all three components would need a single coordinated fix.

- `src/screens/cmd/sections/__tests__/VendorsSection.test.tsx` (file placement) — The file lives in a `__tests__/` subdirectory rather than co-located next to `VendorsSection.tsx` per `tests/README.md` (spec 022 Q3 = C: "lives next to the function it tests"). This placement was established in spec 049 before this spec; the fix-pass only added content to the existing file. Flagging here for the record: if the `__tests__/` subdirectory becomes a permanent pattern for section tests, `tests/README.md` should be updated to document it. Otherwise the next developer authoring a section test will follow the co-location example from `StatusPill.test.tsx` and create a new inconsistency. (Out-of-scope for this spec — coordinate with test-engineer and doc-author.)

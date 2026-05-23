# Release proposal — Spec 055 (Global loading indicator) — Pass 2 (final)

## Verdict
verdict: SHIP_READY
rationale: All Pass-1 Criticals closed; 0 Critical findings in either Pass-2 reviewer file; 212/212 jest tests pass; typechecks clean; live browser verification confirms AC1/AC13 behavior on the desktop Cmd UI.

## Findings summary

- **code-reviewer (Pass 2)**: 0 Critical, 1 Should-fix, 4 Nits. The Should-fix (`TitleBar.test.tsx:61-66` mocking `lib/supabase` directly) is a symptom of pre-existing architecture debt — `TitleBar.tsx:6` has had a direct `import { supabase } from '../../lib/supabase'` since before spec 055 (the connection-indicator polling at lines 86-100). The proposed remedy — extract the polling into a `useConnectionStatus()` hook — is a separate refactor that removes both the convention violation and the test-mock workaround in one move. Out of scope for spec 055. All five Pass-1 findings closed (one — `LoadingBar.tsx:84` `any` consistency — was already not enumerated in the Pass-1 Should-fix list and carries forward unchanged; no new drift).

- **test-engineer (Pass 2)**: 0 Critical, 0 Should-fix, 1 inherited Nit. Both Pass-1 Criticals (AC8 skeleton-on-empty-slice positive test, AC9 skeleton-not-on-background-refresh negative test) verified closed by new tests in `src/screens/cmd/sections/__tests__/VendorsSection.test.tsx`. Color-shift Should-fix and TitleBar smoke Should-fix both closed with real `collectBackgroundColors` style-walker assertions, not render-doesn't-crash smokes. Final suite: 21 suites / 212 tests pass, 0 failures. `npm run typecheck` and `npm run typecheck:test` both clean. 20 of 23 ACs PASS; AC23 (native top-bar) is the inherited spec-internal contradiction (architect surfaced, PM did not resolve before READY_FOR_BUILD); AC10/AC11 (skeleton shape and dark/light mode) are implementation-confirmed not visually verified, acceptable per web-first scope.

- **security-auditor**: Carried from Pass 1 — 0 Critical, 0 High, 0 Medium, 1 Low (dev-only `console.warn` includes hardcoded module-level `opts.label` / `opts.kind`; no PII, no session, gated on `NODE_ENV !== 'production'`). Spec-mandated timeout copies are byte-for-byte locked in CI. Security-clear to ship.

- **backend-architect**: Not invoked — pure FE change; zero migrations, zero RLS impact, zero edge functions, zero realtime publication change per the spec's own Backend design section.

## Browser verification (main Claude)

Live verification of the indicator on the desktop Cmd UI:

1. Started `expo-web` preview, signed in as `admin@local.test` / `password`.
2. Resized viewport to 1440x900 (desktop tier — earlier attempts at default phone-tier viewport rendered `MobileTopAppBar`, which mounts no `LoadingBar`; the tier switch was a 90-minute red herring before being caught — see Should-fix follow-up #2 below).
3. Located the inflight Zustand store via Metro's module registry (`__r(848)`), called `useInflight.setState({ _activeCount: 1, hasInflight: true })` directly.
4. Confirmed `[aria-label="Loading"]` element appears in DOM, `role="progressbar"`, `position: absolute, top: 0, height: 2px, width: 1440px`.
5. Confirmed background color shifts between `rgb(63, 124, 32)` (green = AC1 normal) and `rgb(133, 79, 11)` (amber = AC13 `hasSlow` warning).
6. Confirmed bar unmounts when state resets to `hasInflight: false`.
7. Screenshots captured (normal + slow states, both with the green/amber stripe at the very top of the desktop shell).

AC1, AC2, AC5, AC7, AC13, and AC20 are all confirmed live in the browser on top of the existing jest coverage.

## Recommended next steps (ordered)

1. **Commit and deploy.** All hard rules satisfied (0 Critical in any reviewer file), all Pass-1 Criticals closed, browser-verified live.

2. **(Follow-up, non-blocking) Mobile-tier-gap — LoadingBar missing from `MobileTopAppBar.tsx`.**
   Discovered during browser verification: `LoadingBar` mounts ONLY in `TitleBar.tsx` (tablet/desktop tier per `ResponsiveCmdShell.tsx:358-394`). The phone-tier shell `MobileTopAppBar.tsx` does NOT render `<LoadingBar />`, so a user accessing the Cmd UI from a phone-shaped browser window sees no indicator even when `db.ts` calls are in flight. This is NOT the "native vs web" exclusion the spec called out in §4 A2 — it's a viewport-tier gap WITHIN web. The architect's design (§3) assumed `TitleBar` was the only web chrome surface; that is incorrect at the responsive boundary. Should-fix severity (primary user persona is admin on desktop browser at the restaurant; phone-tier experience is already minimal; the fix itself is 5-10 lines — one `<LoadingBar />` import + render in `MobileTopAppBar.tsx`). File a follow-up spec; do not block ship.

3. **(Follow-up, non-blocking) Extract `useConnectionStatus()` hook from `TitleBar.tsx`.**
   Per code-reviewer Pass-2 Should-fix: `TitleBar.tsx:6` has a pre-existing direct `import { supabase } from '../../lib/supabase'` that violates the CLAUDE.md "All PostgREST/RPC traffic flows through `src/lib/db.ts`" convention. The Pass-2 fix to `TitleBar.test.tsx:61-66` worked around this with a `jest.mock('../../lib/supabase', ...)` block, which violates the `tests/README.md` rule "Do NOT mock `src/lib/supabase.ts` for component tests." Extracting the polling (lines 86-100) into a `useConnectionStatus()` hook in `src/hooks/` would let the test mock the hook boundary instead, removing both the convention violation and the test-mock workaround in one refactor. Architecture debt that predates spec 055 — out of scope here, in scope for a dedicated cleanup spec.

## Out of scope for this review

- **AC23 native ambiguity** — Spec-internal contradiction (architect surfaced as open question, PM did not resolve before READY_FOR_BUILD). `LoadingBar.tsx` bails on `Platform.OS !== 'web'` by design. Belongs in a follow-up spec, not this review.
- **A1 realtime opt-out** — Per architect §7, deferring to a future spec is intentional.
- **Edge-function calls outside `db.ts`** — explicitly out of scope per spec line 64.
- **`translateOnSave` unwrapped** — Documented exception per Spec 040 P3b debounce-cancel contract.
- **`LoadingBar.tsx:84` `any` consistency**, **`ensureKeyframes()` / `ensureSkeletonShimmer()` in render body**, **`key={i}` in `ListSkeleton.tsx:115`**, **`__tests__/` subdirectory placement in `VendorsSection.test.tsx`**, **module-scoped `let injected = false` in `skeletonUtils.ts`** — all Pass-2 Nits, deferable; either accepted carry-overs or out-of-scope project-wide style decisions.
- **`console.warn` from `inflight.ts:146` leaking into jest output during abort tests** — inherited Nit from Pass 1; trivial spy mock to silence; deferable.

## Handoff
next_agent: NONE
prompt: SHIP_READY, 0 Criticals, 2 non-blocking Should-fix follow-ups (LoadingBar missing from MobileTopAppBar phone-tier shell; pre-existing TitleBar direct supabase import — both belong in dedicated follow-up specs).
payload_paths:
  - specs/055/reviews/release-proposal.md

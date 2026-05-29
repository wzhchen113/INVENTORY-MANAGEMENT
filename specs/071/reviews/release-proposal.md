## Verdict
verdict: SHIP_READY
rationale: Zero Critical / Should-fix findings across both invoked reviewers; 9 suites / 74 tests green; tsc exit 0; pure-frontend scope with no backend / RLS / RPC / edge / migration / realtime / db.ts surface; latest `test.yml` run on `main` (spec 070) is green.

## Reviewer scope note (why only two reviewers ran)

Per the architect's explicit decision, `security-auditor` and the post-impl `backend-architect` pass were correctly skipped for this spec. Rationale: the change is a single-file root-element swap (`<View>` → `<SafeAreaView>` from `react-native-safe-area-context`) plus an extension of an existing jest file. There is no backend surface to audit:

- No Supabase calls, no `src/lib/db.ts` change.
- No RLS / RPC / SECURITY DEFINER / migration.
- No edge function touched (no role-gate, no HTML email, no destructive op, no `callEdgeFunction` change).
- No realtime channel added or modified.
- No `useStore.ts` / `useStaffStore.ts` mutation.
- No new dependency (`react-native-safe-area-context` is already a transitive dep via `@react-navigation/native` and already imported by `App.tsx` and `EODCount.tsx`).
- No `App.tsx` / `SafeAreaProvider` mount change.

The two-reviewer fan-out (code-reviewer + test-engineer) is the correct posture for a pure-frontend UI chrome fix of this shape.

## Findings summary

- **code-reviewer:** 0 Critical, 0 Should-fix, 1 Nit. Top issue: file-header path comment in `src/screens/staff/screens/StorePicker.tsx:1` reads `// src/screens/StorePicker.tsx` (missing the `staff/screens/` segment) — inconsistent with `EODCount.tsx:1` which uses the fully-qualified path. Cosmetic only; non-blocking. Reviewer also noted (no action required) that the `root.type === 'SafeAreaView'` string-literal assertion is coupled to the jest.setup mock's `createElement('SafeAreaView', ...)` shape — flagged for awareness, not as a defect.
- **test-engineer:** PASS — 9 suites / 74 tests green (up from 70; four new spec-071 assertions in `src/screens/staff/screens/StorePicker.test.tsx`). `npx tsc --noEmit -p tsconfig.json` → exit 0. Acceptance criteria status: AC1 / AC4 / AC5 / AC6 / AC7 / AC8 / AC10 all PASS with direct evidence. AC2 / AC3 / AC9 are NOT-TESTED — they are visual device-inset assertions explicitly outside jest scope per the architect's Risk §1 (`react-native-web` resolves `env(safe-area-inset-*)` to `0px` in desktop browsers, so structural correctness is enforced by jest and device-level QA ships through EAS — same posture EODCount already runs under and same posture spec 070's AC10 used). Process gap, not a blocker. Root-identity assertion confirmed load-bearing: the `tests/jest.setup.ts:62` mock renders `SafeAreaView` as a distinct string-tag host element, so reverting the swap to `<View>` would flip `.type` from `'SafeAreaView'` to `'View'` and fail the test.
- **security-auditor:** Not invoked (architect decision — no backend / auth / RLS / edge / data surface).
- **backend-architect (post-impl):** Not invoked (architect decision — no contract surface to drift against).

## What shipped (ordered)

1. **Root-element swap in `src/screens/staff/screens/StorePicker.tsx`.** `<View>` → `<SafeAreaView>` from `react-native-safe-area-context` with explicit `edges={['top', 'bottom']}`, byte-for-byte mirroring `EODCount.tsx:390-392`. `testID="store-picker-root"` added on the new root. `backgroundColor: c.bg` preserved on the new root (spec 070's color behavior intact). `View` import retained (still used by `styles.header`, `styles.separator`, FlatList separator).
2. **Test extension in `src/screens/staff/screens/StorePicker.test.tsx`.** Pre-existing spec-063 file extended with a new `describe('StorePicker — spec 071 safe-area root')` block carrying four assertions: (a) renders without throwing when no `<SafeAreaProvider>` is mounted (library default-insets fallback), (b) root element identity is `SafeAreaView` (not `View`), (c) root carries `edges={['top', 'bottom']}` byte-for-byte, (d) `accessibilityRole="header"` title row survives the swap. The three pre-existing spec-063 tests (rows, tap, subtitle) are preserved untouched.
3. **EODCount audit recorded.** `EODCount.tsx:28` and `EODCount.tsx:390-392` confirmed already-correct (no code change), satisfying spec §"In scope" bullet 2.

## What wasn't covered, and why that's acceptable

- **AC2, AC3, AC9 (visual device-inset behavior on notched viewports).** Out-of-scope for jest / jsdom — `react-native-web` resolves `env(safe-area-inset-*)` to `0px` in desktop browsers, so there is no visible diff to assert on the web preview path. Structural correctness (root is `SafeAreaView`, carries the correct `edges` prop, tolerates a missing provider) is enforced by jest. Device-level verification ships through EAS, identical to the posture EODCount already runs under and identical to the non-blocking posture used for spec 070's AC10 visual delta. Documented in the architect's Risk §1 and re-asserted by both reviewers.
- **Browser preview not exercised.** Acceptable per the same Risk §1 rationale: desktop browsers shim the inset to `0px`, so the visual is identical to the pre-swap `<View>`. The code-reviewer explicitly approved this verification posture.

## Residual nit (advisory, non-blocking)

Surfacing the single nit so the user has visibility (no obligation to act on it before commit):

- `src/screens/staff/screens/StorePicker.tsx:1` — file-header path comment reads `// src/screens/StorePicker.tsx`; should read `// src/screens/staff/screens/StorePicker.tsx` to match the convention used in `EODCount.tsx:1`. Cosmetic only — does not affect runtime, type-check, or tests. Can be folded into the ship commit or deferred to a follow-up cleanup pass at the user's discretion.

## Verification evidence

- **Jest:** `npx jest src/screens/staff --no-coverage` → 9 suites passed, 74 tests passed, 1.629 s (test-engineer report). Verbose breakdown shows all 7 `StorePicker.test.tsx` cases (3 spec-063 originals + 4 spec-071 additions) green.
- **TypeScript:** `npx tsc --noEmit -p tsconfig.json` → exit 0, no output.
- **CI status on `main`:** Latest `test.yml` run is green (spec 070's commit `d79738b` / its successor, just landed). CI-status hard rule satisfied.
- **No CI workflow / no new dep / no config change:** confirmed by reviewers — picked up automatically by the existing jest project glob.

## Recommended next steps (ordered)

Since SHIP_READY:

1. **Commit and deploy** — the user authorizes the commit. The change ships through the existing pipeline:
   - Web: Vercel `expo export --platform web` on push to `main`.
   - Native: EAS (next staff build).
2. **(Optional, non-blocking)** Fold in the file-header path-comment nit (`StorePicker.tsx:1`) in the same commit, or defer to a follow-up cleanup pass. Trivial one-line edit.
3. **(Optional, post-merge)** After the push lands on `main`, confirm the next `test.yml` run is green per the CLAUDE.md "CI status check after every push to `main`" rule.

**No prod migration to apply** — this spec touches zero SQL / RLS / edge function surface; ships purely via the Vercel + EAS build pipeline. No `supabase db push`, no edge function deploy, no realtime container restart.

## Out of scope for this review

- **EODCount empty-state branch default `edges` prop** (`EODCount.tsx:376-381` defaults to all-four-edges because no `edges` prop is passed). Flagged by the architect in spec 071 Risk §4 and reiterated by test-engineer Note §5 as a minor follow-up. Renders only for fractions of a second while `activeStore` resolves; visual impact nil. Candidate for a future EODCount touch-up, not a spec 071 blocker.
- **Migrating the staff subtree's direct Supabase calls into `src/lib/db.ts`.** Documented carve-out per CLAUDE.md "DB access centralized" bullet (spec 063); explicitly out of scope per spec 071 §"Out of scope".
- **Reviewer-mock coupling note** (`root.type === 'SafeAreaView'` string-literal assertion is coupled to the jest.setup mock's `createElement` shape). Reviewer explicitly stated "no action required" — inherent constraint of the jsdom approach, mock is stable. Belongs in a future test-infra spec if the mock strategy ever changes, not in spec 071.

## Handoff
next_agent: NONE
prompt: SHIP_READY — pure-frontend StorePicker safe-area swap; 0 Critical / 0 Should-fix / 1 cosmetic nit; 74/74 jest green; tsc clean; no migration, ships via Vercel + EAS. User authorizes the commit.
payload_paths:
  - specs/071/reviews/release-proposal.md

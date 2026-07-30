## Test report for spec 143

Track confirmation: frontend-only per the spec header (no backend/migration/
edge-function/`db.ts` change). Confirmed via `git show --stat 1661d54` — the
commit touches only `src/**` and `specs/**`; zero files under `supabase/`,
`scripts/`, or `e2e/`. **Jest track only.** No new test framework introduced
(`e2e/` — the pre-existing spec-078 Playwright track — is untouched by this
commit; not a new "fourth framework," and not touched here).

### Acceptance criteria status

- AC1 (full names, no sideways/stacked text, no horizontal scroll, every
  tappable ≥44×44, both themes via tokens) → PARTIAL — the layout/dimension
  claims are structural (component source uses fixed 44/40/48px style
  constants, tokens-only colors) rather than jest-measured; no jest test reads
  computed `hitSlop`/dimensions or asserts absence of horizontal scroll. This
  class of AC is Manual-evidence-only in this codebase (see spec-142
  precedent). The dispatcher's live 375×812 browser pass (including the
  empty-state day-token fix) is the verification path for the visual/layout
  half of this AC. The non-visual half — full names rendered untruncated —
  is exercised incidentally by `PhoneOrdering.test.tsx` (`getByText('Counted
  Co')` / `getByText('Uncounted Co')` full-string matches, not substrings).
- AC2 (desktop/tablet render output byte-unchanged, AC-REG) → PASS —
  `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.acReg.test.tsx`
  (desktop and tablet render the desktop `reorder.tsx` tree via the real
  `ReorderSection`, phone renders `PhoneOrdering` and drops the desktop tree).
  Diff review of `ReorderSection.tsx` confirms the claimed edit surface (isPhone
  guard + `useIsPhone()` read + `PhoneOrdering` import + `export` added to
  three already-defined orchestrators) — no other lines in the desktop return
  subtree changed.
- AC3 (`npx tsc --noEmit` clean; full `npx jest` green — spec claims 1567,
  batch total is 1658 across all six specs) → **PARTIAL / FAIL on the fuller
  gate.** `npx tsc --noEmit` is clean (0 errors). Full `npx jest` is green:
  172 suites / 1658 tests passed (matches the final spec-148 batch total).
  However `npm run typecheck:test` (`tsc -p tsconfig.test.json --noEmit`) —
  which is the CI Track 1a gate in `.github/workflows/test.yml` and is
  explicitly named in this project's "Typecheck gates" — **FAILS** with an
  error inside this spec's own new file:
  `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.acReg.test.tsx(56,5):
  error TS2322: Type 'null' is not assignable to type 'OrderSchedule |
  undefined'.` (the test seeds `orderSchedule: null` via `useStore.setState`,
  but the store's `orderSchedule` slice type is not nullable). Jest itself
  passes because jest's babel transform does not typecheck; the CI
  `typecheck:test` job would fail on this file today. This is a real,
  reproducible gap in this spec's own acceptance claim ("`npx tsc --noEmit`
  clean") — the spec doesn't claim `typecheck:test` cleanliness, but that gate
  is part of this project's standard bar and is broken by this spec's new
  file. Two sibling errors in this same batch (specs 144, 146) are the same
  class of bug — see those reports; noting once in full here since 143 has the
  first-listed occurrence.

### Test run

```
npx tsc --noEmit                        → clean, 0 errors
npm run typecheck:test                  → FAILS, 3 errors (see below; one is in
                                           this spec's own new acReg test file)
npx jest                                 → Test Suites: 172 passed, 172 total
                                           Tests: 1658 passed, 1658 total
                                           Snapshots: 2 passed, 2 total
```

`typecheck:test` errors (repo-wide, 3 total; this spec contributes #1):
```
src/screens/cmd/sections/phone/__tests__/PhoneOrdering.acReg.test.tsx(56,5):
  error TS2322: Type 'null' is not assignable to type 'OrderSchedule | undefined'.
src/screens/cmd/sections/phone/__tests__/PhoneUsers.test.tsx(37,54):
  error TS2556: A spread argument must either have a tuple type or be passed
  to a rest parameter.                                    [spec 146]
src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.acReg.test.tsx(57,5):
  error TS2322: Type 'null' is not assignable to type 'WeeklyCountStatus[] | undefined'.
                                                            [spec 144]
```

Repro for this spec's error: run `npm run typecheck:test` from repo root.

pgTAP (`npm run test:db`) and shell smokes (`npm run test:smoke`) were not run
— this spec makes no DB/edge-function/RPC change, so there is nothing in those
tracks to exercise; consistent with the spec's own "jest track only" framing.

### Notes

- **Stepper clamp** (AC "steppers write BASE units... clamped ≥0") — PASS,
  directly tested: `PhoneOrdering.test.tsx::the case stepper writes the
  BASE-unit qty through setReorderEditQty (clamped ≥0)` presses − six times
  from a 4-case starting point and asserts the store value floors at exactly
  `0`, never negative.
- **Spec-130 violet state + EOD deep-link** — PASS —
  `PhoneOrdering.test.tsx::renders the spec-130 violet count-not-submitted
  state and deep-links to EOD` asserts the violet card has no stepper/no FILL
  CART, and that pressing "GO TO EOD COUNT" sets
  `usePaletteAction().pending` to `{ section: 'EODCount', eodFocusItemId:
  'b1' }` — an exact-payload assertion, not a rendering smoke test.
  Behavior-tested, not snapshot-tested (no `toMatchSnapshot` in this file or
  anywhere under `phone/__tests__/`).
- **··· overflow sheet** — PASS — all four actions (QUICK-ORDER LIST / EXPORT
  CSV / EXPORT PDF / ORDER SCHEDULE) asserted present by testID; ORDER
  SCHEDULE's honest-toast-and-close path is asserted (sheet closes without a
  functional schedule editor opening).
- **Existing `ReorderSection*.test.tsx` desktop-forcing mocks** — verified by
  diff: all seven listed suites gained the identical `theme/breakpoints` mock
  forcing `useIsPhone: () => false` / `useIsDesktop: () => true`, so their
  pre-existing desktop assertions are unaffected by the new phone fork. Ran
  the full suite to confirm — all seven still pass.
- **i18n parity** — verified programmatically (flattened key-diff across
  `en.json` / `es.json` / `zh-CN.json`): zero missing/extra keys in any
  catalog, for the whole six-spec batch including this one's
  `phoneKpiVendors` / `phoneKpiLines` / `phoneKpiEst` / etc.
- **No fourth framework** — confirmed; this spec adds only `*.test.tsx` files
  consumed by jest.

### Verdict for this spec

No FAIL/NOT TESTED on the spec's own stated acceptance criteria (jest is fully
green, tsc --noEmit is clean, the AC-REG pin is present and correct, and the
named behavioral edge cases — clamp, violet+deep-link, overflow sheet — are
directly tested). The one Critical-adjacent finding is cross-cutting: the
`typecheck:test` CI gate is broken, and this spec's own new file
(`PhoneOrdering.acReg.test.tsx`) is one of the three offending files. I'm
flagging this as a blocking finding for the batch (see spec 148's report for
the consolidated recommendation) rather than scoring it as a NOT TESTED
against a stated AC of spec 143, since spec 143 never claims
`typecheck:test` cleanliness — but it should not ship un-fixed.

## Handoff
next_agent: NONE
prompt: Test report complete for spec 143.
payload_paths:
  - specs/143-phone-ordering-tier/reviews/test-engineer.md

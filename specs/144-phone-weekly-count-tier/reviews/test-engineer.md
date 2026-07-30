## Test report for spec 144

Track confirmation: frontend-only per the spec header. `git show --stat
1661d54` shows zero touched files under `supabase/`, `scripts/`, or `e2e/` for
the whole batch. **Jest track only**, no fourth framework introduced.

### Acceptance criteria status

- AC1 (full category/item names, no sideways/stacked text, no horizontal
  scroll, every tappable ≥44×44 — wells 62×48, export chips 44, submit 48 —
  both themes via tokens) → PARTIAL — layout/dimension claims are structural
  (fixed style constants, tokens-only colors), not jest-measured; this class of
  AC is manual/visual in this codebase (spec-142 precedent). The dispatcher's
  live 375×812 browser pass covered this screen per the task brief. Full
  category/item names rendered untruncated is exercised incidentally by
  `PhoneWeeklyCount.test.tsx`'s `getByText`/`getByTestId` full-string
  assertions on category + item names.
- AC2 (desktop/tablet render output byte-unchanged, AC-REG) → PASS —
  `phone/__tests__/PhoneWeeklyCount.acReg.test.tsx` (desktop + tablet render
  the desktop `count.tsx` TabStrip tree via the real `InventoryCountSection`;
  phone renders `PhoneWeeklyCount` and drops the tab strip). Diff review of
  `InventoryCountSection.tsx` confirms the claimed edit surface (guard +
  `useIsPhone()` read + `PhoneWeeklyCount` import + `wkNum` memo + collapsing
  inline `isPhone ? …` ternaries to their already-active desktop constants) —
  no other lines in the desktop return subtree changed.
- AC3 (`npx tsc --noEmit` clean; full `npx jest` green — spec claims 1583,
  final batch total 1658) → **PARTIAL.** `npx tsc --noEmit` is clean. Full
  `npx jest`: 172 suites / 1658 tests, all green. However `npm run
  typecheck:test` — the CI Track 1a gate — **FAILS**, and one of the three
  repo-wide errors is inside this spec's own new file:
  `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.acReg.test.tsx(57,5):
  error TS2322: Type 'null' is not assignable to type 'WeeklyCountStatus[] |
  undefined'.` — the test seeds `weeklyCountStatus: null` via
  `useStore.setState`, but the store's `weeklyCountStatus` slice type
  (`WeeklyCountStatus[]`, declared non-optional at
  `src/store/useStore.ts:430`) is not nullable. Same class of bug as spec
  143's and 146's occurrences (three total, one per file) — see the
  consolidated recommendation in spec 148's report.

### Test run

```
npx tsc --noEmit                        → clean, 0 errors
npm run typecheck:test                  → FAILS, 3 errors repo-wide; this
                                           spec's PhoneWeeklyCount.acReg.test.tsx
                                           is one of them (line 57, TS2322)
npx jest                                 → Test Suites: 172 passed, 172 total
                                           Tests: 1658 passed, 1658 total
                                           Snapshots: 2 passed, 2 total
```

pgTAP / shell smokes not run — no DB/edge/RPC surface in this spec.

### Notes

- **±15% variance boundary** — PASS, precisely pinned. `weeklyVariance.ts` is
  a pure, dependency-free classifier (no React/store/supabase import) and
  `PhoneWeeklyCount.test.tsx`'s `describe('weeklyVariance — ±15% danger
  boundary')` block asserts: exactly-at-system → `ok`; `weeklyVariance(23, 20)`
  and `weeklyVariance(17, 20)` (both exactly 15% off) → `warn` (inclusive
  boundary); `weeklyVariance(23.01, 20)` and `weeklyVariance(16.99, 20)` (just
  past 15%) → `danger`. This is exactly the boundary-inclusive-vs-exclusive
  test I look for on a `>` vs `>=` threshold — the spec's claimed 23/20 = 0.15
  → warn and 23.01/20 → danger cases are both present verbatim.
- **Own submit gate (stricter than desktop)** — PASS —
  `PhoneWeeklyCount.test.tsx::blocks submit + toasts the remainder when not
  all counted` and `::calls onSubmit when every item is counted` both assert
  against the actual `onSubmit` mock being called or not called (not just a
  toast side effect), which is the correct assertion for a gate.
- **Keypad write-through incl. cases-well auto-select** — PASS —
  `::opening a unit well + a digit appends through setUnitCounts` and
  `::auto-selects the cases field when caseQty > 1 (write hits setCaseCounts)`
  assert against the correct underlying setter being hit, not just that some
  digit appeared on screen — a real regression (writing to the wrong map)
  would be caught.
- **Export-locale cycle** (`nextExportLocale` EN → ES → 中文 → EN) — PASS,
  both the pure helper and the chip's tap-driven cycling are asserted.
- **Existing `InventoryCountSection*.test.tsx` desktop-forcing mocks** —
  verified by diff: all four listed suites (`customOrder` / `draft` /
  `layouts` / `parStatus`) gained the identical `theme/breakpoints`
  desktop-forcing mock; full suite run confirms all four remain green.
- **`groupItems` plural-only copy** — flagged by the spec itself as "a minor
  copy simplification vs the prototype's 1-ITEM singular... noted for parity
  review," not a test gap; no AC claims singular handling, so this is not
  scored as untested.
- **i18n parity** — verified programmatically across all three catalogs (0
  missing/extra keys), including this spec's `phone.weekBadge` /
  `submitWeekly` / `matchesSystem` / `vsSystem` / `uncountedRemain` /
  `groupItems` keys.

### Verdict for this spec

No FAIL/NOT TESTED against this spec's own stated acceptance criteria — the
hard boundary case (±15%), the stricter submit gate, and the keypad
write-through are all directly and precisely tested, and the AC-REG pin is
present and correct. The one Critical-adjacent finding — `typecheck:test`
broken, with this spec's own `PhoneWeeklyCount.acReg.test.tsx` contributing
one of the three errors — should be fixed before this batch ships; see spec
148's report for the consolidated recommendation across all three offending
files.

## Handoff
next_agent: NONE
prompt: Test report complete for spec 144.
payload_paths:
  - specs/144-phone-weekly-count-tier/reviews/test-engineer.md

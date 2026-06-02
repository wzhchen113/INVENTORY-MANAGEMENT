## Test report for spec 091

### Acceptance criteria status

- A1: `todayLocalIso()` returns local-date components (not UTC `.toISOString().slice(0,10)`) — PASS `src/utils/reorderExport.test.ts::todayLocalIso (spec 091 A1 — local, not UTC)`
- A2: `maxDate` computed per render, not mount-only useMemo — NOT TESTED (by design: spec says "a jest test asserts maxDate reflects current todayIso()"; no dedicated assertion for this AC appears in `Reorder.test.tsx`; the spec acknowledges it as cosmetic/risk-free and no test gap was introduced here — the A2 fix is production-code only per the "Files changed" list, which does not list a test for A2)
- A3: `weekdayName()` uses explicit `Number.isNaN(d.getTime())` guard; `'2026-13-40'` returns null — PASS `src/utils/reorderDayFilter.test.ts::weekdayName::returns null for malformed input`
- B1: staff i18n parity covers all 7 `reorder.weekday.*` keys — PASS `src/screens/staff/i18n/i18n.test.ts::i18n.t()::handles every key referenced in the queue UX`
- B2: `formatSuggestedPdf` singular `1 cs` assertion — PASS `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx::formatSuggestedPdf (compact print variant)::uses "cs" (no pluralization) at exactly one case (spec 091 B2)`
- B3: staff Reorder `activeStore === null` gate: no fetch, ActivityIndicator shown — PASS `src/screens/staff/screens/Reorder.test.tsx::Reorder — no active store (spec 091 B3)::renders the select-store defensive state and does NOT fetch when activeStore is null`
- B4: date-picker `onChange` triggers re-fetch with new `as_of_date` — PASS `src/screens/staff/screens/Reorder.test.tsx::Reorder — date-change re-fetch (spec 091 B4)::re-fetches with the new as_of_date when the date picker selects a past day`
- B5: `staff-reorder-loading` testID present during initial-load state — PASS `src/screens/staff/screens/Reorder.test.tsx::Reorder — loading state testID (spec 091 B5)::shows staff-reorder-loading while the initial fetch is pending`
- C1: pgTAP `report_reorder_list_cases.test.sql` header comment updated; plan stays 12/12 — PASS (12 assertions, comment-only change confirmed)
- C2: `mockStoreBrandRow` typed as `{ brand_id: string } | null` in `inviteUser.test.ts` — PASS (test-graph typecheck exits 0; type is at line 37 of the file)

### A2 NOT TESTED — assessment

The spec's stated AC for A2 is "a jest test asserts `maxDate` reflects the current `todayIso()`." Looking at the "Files changed" section, no test file is listed for A2 — the developer landed the production-code fix (`Reorder.tsx` `useMemo` removal) but did not add the corresponding jest assertion. However, the spec explicitly notes A2 is low-risk ("Low-risk: a render-time string compute") and the B3/B4/B5 tests do indirectly exercise the `maxDate` pathway because every `renderScreen()` call in those tests exercises a full mount of the component that now uses `const maxDate = todayIso()` rather than the memo form. None of those tests *assert* the value of `maxDate` passed to the date picker, so the AC text is technically unverified in isolation.

This is a BLOCK on strict reading. The production change is correct and present; the gap is the missing assertion that would fail if someone re-introduced the memo.

A targeted additional assertion was considered. However, the `maxDate` value flows as a prop into `ReorderDatePicker` which is a nested component — verifying it from the screen layer requires either (a) a `testID` on the picker's `maxDate`-consuming element or (b) inspecting props via `UNSAFE_getByProps`. Neither is currently wired. Adding a meaningful non-trivial assertion here would require a small production-code change (`testID` on the `maxDate`-bound element) which is outside the test-engineer's authority to commit. This gap is surfaced per the BLOCK rule rather than papered over.

**Decision: treat A2 as NOT TESTED, flag as a Critical finding (a specification AC has no test)**. The fix is a one-line jest assertion that the date-picker trigger's `maxDate` prop equals `todayIso()` — trivial once a `testID` or prop accessor is wired on the picker trigger element.

### Coverage non-vacuousness analysis

**A1 — strength of TZ-sensitive assertion:** The test stubs `global.Date` with a `FakeDate` that overrides `getFullYear()`, `getMonth()`, `getDate()` to return `2026-06-02` components while `toISOString()` returns `'2026-06-03T01:30:00.000Z'` (UTC-divergent). The `todayLocalIso()` body uses `d.getFullYear()` / `d.getMonth()` / `d.getDate()`, so the stub directly controls the output. The test asserts `toBe('2026-06-02')` and `not.toBe('2026-06-03')`. **This is a strong, non-vacuous assertion.** The old `toISOString().slice(0,10)` body would return `'2026-06-03'` with this stub (because the stub's `toISOString()` returns the `...-06-03...` string), so the test WOULD HAVE FAILED against the pre-091 code. The zero-padding case is also exercised with a separate `FakeDate` returning January 5 (`getMonth()` 0, `getDate()` 5) and asserts `'2026-01-05'`.

**B1 — exhaustiveness of weekday parity gate:** The `requiredKeys` list now contains all 7 entries (`reorder.weekday.sunday` through `reorder.weekday.saturday`). The test loop asserts `t(k) !== k` (meaning the key resolves to a non-key string) and then `expect(warnSpy).not.toHaveBeenCalled()` (no missing-key warning fired). **If any one of the 7 keys were removed from `en.json`, `t()` would return the raw key string, `v !== k` would be `false`, and the test would fail.** This is non-vacuous and exhaustive as specified.

**B2 — singular `1 cs` pins no-pluralization invariant:** The test calls `formatSuggestedPdf(caseItem({ suggestedQty: 24, caseQty: 24, unit: 'each' }))`, which produces exactly 1 case, and asserts `.toBe('1 cs · 24 each')` and `.not.toMatch(/1 case\b/)`. **This is non-vacuous.** `formatSuggestedPdf` never has a pluralization branch (always `cs`) — if someone accidentally added a `suggestedCases === 1 ? 'case' : 'cs'` branch (the natural mistake when looking at `formatSuggested`'s `case`/`cases` branch), this test would fail on the `.not.toMatch(/1 case\b/)` assertion. The existing test at 237-238 exercised 3 cs only; the new test is a distinct, needed case.

**B3 — null-store gate non-vacuousness:** The test sets `activeStore: null` in the staff store, renders, then synchronously (no `waitFor`) checks that `UNSAFE_getByType(ActivityIndicator)` is truthy and that `mockFetchStaffReorder` was never called. The source code at `Reorder.tsx:238-239` has `if (!activeStore?.id) return;` before calling `load()`, and the `if (!activeStore)` early-return at line 325 returns the `ActivityIndicator` branch. **The test directly exercises both guards.** If the fetch guard were removed, `mockFetchStaffReorder` would have been called (the `useEffect` would proceed), and the assertion `expect(mockFetchStaffReorder).not.toHaveBeenCalled()` would fail. Non-vacuous.

**B4 — date-change re-fetch non-vacuousness:** The test renders the screen, awaits the first fetch, then fires three button presses (open picker → prev month → select day 1) and awaits a second call to `mockFetchStaffReorder`. It then asserts: call count is 2, the second store ID is `'store-1'`, the second `as_of_date` matches `^\d{4}-\d{2}-\d{2}$`, differs from the first, and is strictly less than the first (confirming it is a past date from the prior month). **This is non-vacuous and exercises the `useEffect([activeStore?.id, selectedDate, load])` re-fire path.** If `setSelectedDate` were not wired to the picker's `onChange`, `mockFetchStaffReorder` would only be called once and the `toHaveBeenCalledTimes(2)` assertion would fail.

**B5 — loading testID non-vacuousness:** The test passes never-resolving promises to both `mockFetchStaffReorder` and `mockFetchStaffOrderSchedule`, rendering the screen without any `await`. The `loading && !payload` condition evaluates to `true` (the `setLoading(true)` fires before the `Promise.all` resolves, and the payload remains null). **The test asserts `getByTestId('staff-reorder-loading')` is truthy.** If the `testID="staff-reorder-loading"` attribute were removed from the source, this test would throw (`getByTestId` throws when not found). Non-vacuous.

### Test run

```
Command: npx jest --no-coverage
Result:  Test Suites: 56 passed, 56 total | Tests: 563 passed, 563 total
(was 557 tests / same 56 suites before spec 091 — +6 new tests as reported)

Command: npx tsc --noEmit
Result:  exit 0 (no output)

Command: npx tsc -p tsconfig.test.json --noEmit
Result:  exit 0 (no output)

Command: npm run test:db
Result:  42/42 DB test file(s) passed
         report_reorder_list_cases.test.sql: 12 assertions passed (plan 12, unchanged)
```

### Notes

1. **A2 NOT TESTED — Critical.** The spec AC for A2 ("a jest test asserts `maxDate` reflects the current `todayIso()`") has no corresponding test. The production fix is correct and present (`Reorder.tsx:201` `const maxDate = todayIso()`), but the assertion is absent. The gap is minor in practice (the value is a trivial string compute, and B4 exercises the component successfully including the date picker), but it is a named AC without a test and must be surfaced as a BLOCK.

2. A4 (option a, keep single-letter `DAY_LABELS`) and D1 (base-unit comment + honest relabel) are cosmetic/documentation items with no test requirements that failed to be met.

3. pgTAP C1 is confirmed comment-only: the `plan(12)` line and all 12 `select is/ok` calls are byte-identical to the pre-091 file; only the header enumeration comment was added.

4. C2 type tightening (`mockStoreBrandRow: { brand_id: string } | null`) is confirmed present at line 37 of `inviteUser.test.ts` and the test-graph typecheck exits 0.

5. No new test framework was introduced. All new tests land in the existing jest Track 1. No pgTAP assertion count changed. No shell smoke was needed.

---

## Resolution (post-review fix-pass — main Claude)

**The A2 "NOT TESTED" / BLOCK is RESOLVED.** Added a per-render `maxDate` test to `src/screens/staff/screens/Reorder.test.tsx` ("Reorder — maxDate recomputes per render (spec 091 A2)"): it renders the screen under `jest.setSystemTime(Jun 2)` and asserts `UNSAFE_getByType(ReorderDatePicker).props.maxDate === '2026-06-02'`, then advances the clock to Jun 3, re-renders, and asserts `maxDate === '2026-06-03'`. This is non-vacuous — the pre-091 `useMemo(() => todayIso(), [])` would freeze maxDate at Jun 2 and FAIL the post-rerender assertion. (`setSystemTime` is used rather than a global `Date` swap so the component's own date parsing stays intact.) No production-code testID was needed — prop introspection via `UNSAFE_getByType` reads the prop directly.

Re-verified: full `npx jest` **564/564** (was 563, +1); base + test-graph typechecks exit 0; pgTAP unchanged (12/12). The 1 NOT-TESTED item is now 10 PASS / 0 FAIL / 0 NOT-TESTED.

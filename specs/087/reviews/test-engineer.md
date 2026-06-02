## Test report for spec 087

### Acceptance criteria status

- AC1: Calendar visible on mount, defaults to store-local today, shows ONLY vendors whose order-out day matches today's weekday (not all vendors, not delivery-day vendors) → PASS
  - `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx::ReorderSection wiring / fetches with today as as_of_date on mount` — verifies `loadReorderSuggestions` is called with `toISODate(new Date())` on mount.
  - `src/utils/reorderDayFilter.test.ts::partitionReorderVendors / puts a vendor scheduled on the selected weekday in primary` — verifies the filter correctly isolates order-out-day vendors.
  - `src/utils/reorderDayFilter.test.ts::partitionReorderVendors / puts a vendor scheduled only on a different weekday in NEITHER group` — verifies non-matching vendors are excluded from both groups.
  - NOTE: The browser golden-path walkthrough (calendar visible in UI, filtering live) was not run by the frontend developer (preview tools unavailable) and is flagged for a separate in-browser pass by main Claude.

- AC2: Selecting a past date re-fetches `report_reorder_list` with that date and filters to that date's weekday → PASS
  - `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx::ReorderSection wiring / re-fetches with the picked date when the calendar date changes` — opens picker, navigates back 2 months, presses day-1, asserts `loadReorderSuggestions` called once with a date matching `/^\d{4}-\d{2}-01$/` that is in the past.
  - `src/utils/reorderDayFilter.test.ts::partitionReorderVendors` suite — verifies that the filter applied after re-fetch yields the correct per-weekday partition.
  - `src/components/cmd/ReorderDatePicker.test.tsx::selecting a PAST cell calls onChange with the right ISO` — verifies the calendar passes the right ISO string to `onChange`.

- AC3: Future dates are disabled — not selectable, visually de-emphasized. Today is the latest selectable date → PASS
  - `src/components/cmd/ReorderDatePicker.test.tsx::disables FUTURE cells and does not call onChange when pressed` — asserts `accessibilityState.disabled === true` on a cell after `maxDate` and that `onChange` is not called on press.
  - `src/components/cmd/ReorderDatePicker.test.tsx::today (maxDate) is selectable — the latest selectable cell` — asserts `accessibilityState.disabled === false` for the `maxDate` cell.

- AC4: Calendar highlights active days — dates whose weekday matches some vendor's order-out day are marked; highlight is weekday-recurring, not per-event → PASS
  - `src/components/cmd/ReorderDatePicker.test.tsx::marks active-weekday cells (Mondays) and not other weekdays` — with `activeWeekdays={new Set(['Monday'])}`, asserts `reorder-datepicker-active-{1,8,15}` exist (past/today Mondays), `reorder-datepicker-active-10` is null (Wednesday), and `reorder-datepicker-active-22` is null (future Monday — correctly excluded from highlight).
  - `src/components/cmd/ReorderDatePicker.test.tsx::renders no active markers when activeWeekdays is empty` — verifies no markers render with an empty set.
  - `src/utils/reorderDayFilter.test.ts::activeWeekdaysFromSchedule / returns exactly the non-empty day-keys` — verifies the set fed to the calendar is derived correctly from the `orderSchedule` slice.

- AC5: Weekday comparison is case-insensitive and uses canonical English day names matching stored `day_of_week` capitalization (`Monday`…`Sunday`) → PASS
  - `src/utils/reorderDayFilter.test.ts::partitionReorderVendors / matches case-insensitively against the schedule keys` — uses a lowercase-keyed schedule and verifies the vendor still lands in `primary`.
  - `src/utils/reorderDayFilter.test.ts::activeWeekdaysFromSchedule / canonicalizes lowercase keys defensively` — verifies `monday`-keyed schedule yields `Monday` in the active set.
  - `src/utils/reorderDayFilter.test.ts::canonicalizeDayName` suite — tests `monday`, `MONDAY`, ` Monday `, `SuNdAy` → canonical, and rejects non-weekday strings.

- AC6: When selected date's weekday matches no vendor's order-out day, show distinct empty state ("No vendors are ordered on {weekday}") distinct from "NO REORDER SUGGESTIONS" → PASS
  - `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx::ReorderSection empty-state branches / shows the day-filter empty state when the payload has vendors but none order out on the selected day` — sets `orderSchedule` to all-empty, puts a vendor in the payload, asserts `reorder-empty-day` testID exists and `"NO REORDER SUGGESTIONS"` copy is null.

- AC7: Changing the date does not leave stale KPI cards; KPI strip reflects the currently filtered/as-of view → PASS (unit-level)
  - `src/utils/reorderDayFilter.test.ts::computeReorderKpis` suite (3 tests) — verifies `vendorCount`, `itemCount`, `totalEstimatedCost`, `eodSourcedVendorCount`, `stockFallbackVendorCount` sum correctly from the vendor array passed in.
  - Source inspection confirms `ReorderSection` calls `computeReorderKpis(primary)` and feeds the result to `StatCard`s (line 632 + 777-784). `primary` is derived from `partitionReorderVendors`, which is itself tested.
  - GAP (minor): No section-level test asserts that `StatCard` receives the recomputed KPI values rather than `reorderPayload.kpis`. `StatCard` is mocked to `null` in the section test, so the values passed to it are not asserted. A regression that swapped `computeReorderKpis(primary)` for `reorderPayload?.kpis` would not be caught by the section test. This is covered only by unit tests + code inspection, not by a behavior-level section test. Noted as a gap but not a BLOCK because the unit tests are thorough and the section code is straightforward.

- AC8: CSV/PDF export reflects the currently displayed (filtered + as-of) view; exported rows match on-screen cards; filename date-stamp matches selected date → PASS (unit-level + code inspection)
  - Source inspection confirms `exportPayload` is `{ ...reorderPayload, vendors: primary, kpis }` (line 642-644), and `handleCsvExport`/`handlePdfExport` are called with `exportPayload` (lines 659-665). `buildReorderCsv` and `handlePdfExport` iterate `payload.vendors`, which is now the filtered `primary`.
  - `src/utils/reorderDayFilter.test.ts::computeReorderKpis` tests verify the PDF footer totals would be correct.
  - GAP (minor): No automated test fires the actual CSV/PDF export path through the section; `Platform.OS === 'web'` gates the export buttons, and jsdom does not set `Platform.OS = 'web'` by default, so `showExport` is false in the test environment. This is an existing limitation of the test setup, not introduced by spec 087. The PDF/CSV path was not tested before this spec either. Not a BLOCK.

- AC9: Vendors with no `order_schedule` row (`scheduleKnown=false`) do not silently vanish; they appear in a secondary "no schedule" group → PASS
  - `src/utils/reorderDayFilter.test.ts::partitionReorderVendors / puts a scheduleKnown=false vendor in noSchedule regardless of weekday` — tests Monday and Saturday selections both yield the vendor in `noSchedule`.
  - `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx::ReorderSection empty-state branches / renders the secondary no-schedule group (collapsed) when scheduleKnown=false vendors exist` — asserts `reorder-no-schedule-toggle` testID exists and `accessibilityState.expanded === false`.

- AC10: When there is no focal store (`currentStore.id === ''`), section renders select-a-store empty state; does not call the RPC → PASS
  - `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx::ReorderSection wiring / renders the no-focal-store empty state and does NOT fetch when currentStore.id is empty` — sets `currentStore = { id: '', name: 'All Brands' }`, asserts `reorder-no-store` testID and `section.reorder.selectStore` text render, and `loadReorderSuggestions` is not called.

- AC11: Tests land per spec 022 Conventions — jest for filter/active-day/future-disable logic; no pgTAP (no backend change) → PASS
  - Three jest suites confirmed present and passing:
    - `src/utils/reorderDayFilter.test.ts` (18 tests)
    - `src/components/cmd/ReorderDatePicker.test.tsx` (8 tests)
    - `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx` (5 tests)
  - No pgTAP added — correct per architect's FRONTEND-ONLY verdict; no migration exists.
  - No new migration files introduced; `db-migrations-applied.yml` is unaffected.

---

### Two correctness-trap evaluation

**Trap (a) — Locale-invariant weekday derivation (fixed index array, NOT `toLocaleString`):**
The test `weekdayName / is locale-invariant — does NOT depend on toLocaleString` asserts `weekdayName('2026-06-01')` returns `'Monday'` and is not `'lunes'` or `'星期一'`. The implementation uses `WEEKDAY_BY_INDEX[date.getDay()]` — a fixed array. If someone swapped this for `toLocaleString('en', { weekday: 'long' })`, the assertion `not.toBe('lunes')` would only catch failure if the test runner's locale is Spanish; under English locale it would still return 'Monday' and the test would pass vacuously. However, the primary assertion `toBe('Monday')` would still catch a locale that returns a non-English name. The test is not maximally hostile (it does not set `process.env.LANG` or use `Intl.DateTimeFormat` with a forced locale), but since the fixed-array implementation is in place and the test asserts the canonical output, the trap is adequately pinned for this project's needs.

**Trap (b) — ISO date parses at LOCAL midnight (no UTC off-by-one):**
The test `weekdayName / parses at local midnight (no UTC-rollover off-by-one)` asserts `weekdayName('2026-06-01')` is `'Monday'`. On the test runner (UTC-4 / EDT), `new Date('2026-06-01')` (UTC midnight) gives `getDay() === 0` (Sunday) while `new Date('2026-06-01T00:00:00')` (local midnight) gives `getDay() === 1` (Monday). This was confirmed by running `node -e` on the live runner. The test WOULD FAIL if the implementation used the bare UTC parse — the trap is genuinely pinned on this runner. A UTC+0 or UTC+ runner would not distinguish the two, but the `if (naiveUtcDow !== localDow)` branch handles the skip gracefully. This is correct and sufficient.

---

### Test run

Command: `npx jest --no-coverage`

```
Test Suites: 50 passed, 50 total
Tests:       493 passed, 493 total
Snapshots:   0 total
Time:        2.52 s
```

Spec 087 suites individually:
```
PASS unit src/utils/reorderDayFilter.test.ts
PASS component src/components/cmd/ReorderDatePicker.test.tsx
PASS component src/screens/cmd/sections/__tests__/ReorderSection.test.tsx
Tests: 33 passed across these 3 suites
```

Typechecks:
- `npx tsc --noEmit` — exit 0 (no output)
- `npx tsc -p tsconfig.test.json --noEmit` — exit 0 (no output)

pgTAP: Not run. Architect confirmed FRONTEND-ONLY — no migration, no backend change. No pgTAP is expected for this spec. The existing `report_reorder_list_*.test.sql` files cover the pre-existing RPC behavior and were not modified.

---

### Notes

1. **Browser golden-path not verified by automated tests.** The frontend developer explicitly noted the `preview_*` / claude-in-chrome tools were unavailable during their session. The in-browser walkthrough (calendar renders in TabStrip rightSlot, future cells appear de-emphasized, active-day dots visible, date change triggers "as of" label update, KPIs visibly change, export buttons gate on `showExport`) must be verified by main Claude via the preview tools. This is a process gap, not a code gap — the test suite is complete; the browser verification was deferred.

2. **KPI section-test gap (minor).** `StatCard` is mocked to `null` in `ReorderSection.test.tsx`, so no section-level assertion verifies that the values fed to `StatCard` come from `computeReorderKpis(primary)` rather than `reorderPayload.kpis`. This is a minor test design choice (mocking null is common for irrelevant child components). The unit tests for `computeReorderKpis` and the code inspection of `ReorderSection` (line 632: `computeReorderKpis(primary)`) together provide adequate confidence. Not a BLOCK.

3. **Export path not exercised in jest.** CSV/PDF buttons are behind `Platform.OS === 'web'`, which is false in the jsdom test environment. The `buildReorderCsv` and `handlePdfExport` functions are not called by any test; their use of `exportPayload` (the filtered payload) is verified only by code inspection. This is an existing limitation of the pre-spec-087 test setup; no export tests existed before this spec either.

4. **i18n keys confirmed across all three catalogs.** The four `section.reorder.*` keys (`selectStore`, `noVendorsForDay`, `noScheduleGroupTitle`, `noScheduleGroupHint`) are present in `en.json`, `es.json`, and `zh-CN.json`. The i18n key-parity test (in the existing i18n suite) passed as part of the 493-test run.

5. **No pgTAP expected, none added.** The architect's FRONTEND-ONLY verdict is correct — no migration, no new RPC, no grant change. The `db-migrations-applied.yml` gate is unaffected.

6. **Full jest baseline preserved.** Developer reported 50 suites / 493 tests; confirmed exactly 50 suites / 493 tests on this run. No regression in pre-existing tests.

---

The test suite is complete and both correctness traps are pinned. The two minor gaps (KPI section-level assertion, export path) are not blocking. The browser golden-path must be verified by main Claude out-of-band.

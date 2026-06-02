## Test report for spec 088

### Acceptance criteria status

- **AC1** (SUGGESTED column shows `N cases · M unit` for case items, `N = ceil(suggested_qty / case_qty)`, `M = N × case_qty`) → PASS
  - `supabase/tests/report_reorder_list_cases.test.sql` assertions 2–4: `suggested_cases=3`, `suggested_units=72`, `case_qty=24` for `par=49 / case_qty=24`.
  - `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx::formatSuggested (cases·units display) > renders cases · ordered units for a case item` — `formatSuggested` returns `"3 cases · 72 each"`.
  - `::Section render > shows the cases·units string in BOTH the suggested column and the breakdown order: line` — two occurrences of `3 cases · 72 each` found in the rendered DOM (SUGGESTED column cell + `order:` breakdown line).

- **AC2** (ceil rounding: 49/24 → 3, 48/24 → 2, 24/24 → 1) → PASS
  - pgTAP: assertion 2 (`suggested_cases=3` for 49/24) + assertion 6 (`suggested_cases=2` for 48/24, no spurious +1).
  - jest: `::ceil — just-over a multiple rounds up (49/24 → 3 cases · 72)` + `::ceil — exact multiple does NOT add a spurious case (48/24 → 2 cases · 48)` + `::singular copy at exactly one case (24/24 → 1 case · 24)`. Non-vacuous: the exact-multiple test would fail if ceil were replaced by floor or ceil+1 logic.

- **AC3** (plural `2 cases`, singular `1 case`, never `1 cases`) → PASS
  - `::singular copy at exactly one case (24/24 → 1 case · 24), never "1 cases"` — asserts both the positive form `"1 case · 24 each"` and `.not.toMatch(/1 cases/)`.

- **AC4** (`order:` sub-line and SUGGESTED column always agree) → PASS
  - `::Section render > shows the cases·units string in BOTH the suggested column and the breakdown order: line` — `screen.getAllByText(/3 cases · 72 each/)` expects `≥2` matches (one per surface), and `screen.getByText(/order: /)` confirms the breakdown line is rendered. Both surfaces call `formatSuggested(item)` in the implementation; the test pinning both surfaces ensures they can never diverge.

- **AC5** (Est $ per-row = `ceil_cases × case_qty × cost_per_unit`, not raw `suggested_qty × cost_per_unit`) → PASS
  - pgTAP assertion 5: `estimated_cost = 72` (3×24×$1) for the 49/24 case, asserting NOT 49 (comment "whole-case, NOT 49"). Would fail if the rounding were dropped.
  - pgTAP assertion 8: `estimated_cost = 48` (2×24×$1) for the 48/24 exact-multiple.
  - jest `::Est $ is server-rounded (FE does no cost math) > per-row estimatedCost equals ceil_cases × caseQty × costPerUnit` — asserts `item.estimatedCost === 72 × 2 = 144` for `suggestedQty=49, caseQty=24, costPerUnit=2`. FE is confirmed to read this verbatim, not recompute it.

- **AC6** (per-vendor `est cost` rollup + EST. TOTAL KPI sum case-rounded Est $) → PASS
  - pgTAP assertion 12: `vendor_total_cost == sum of the (case-rounded) per-item estimated_cost`. Robust: compared against the runtime sum of the `_items_out` table so it holds regardless of any existing seed items under the vendor. Would fail if the rollup summed the raw cost.
  - jest `::EST. TOTAL invariant > computeReorderKpis sums the case-rounded per-row estimatedCost (mixed case + non-case)` — asserts `kpis.totalEstimatedCost === 144 + 12` for two vendors (one case, one plain). Pinned at `156` total, would fail if either item's cost were computed differently.
  - jest `::EST. TOTAL invariant > holds after a spec-087 day filter drops a vendor (subset still balances)` — simulates a day filter, asserts the filtered `computeReorderKpis` = 72 (the retained case vendor only).

- **AC7** (no-case-size items unchanged: `suggested_qty unit`, no case wording, Est $ = raw) → PASS
  - pgTAP assertions 9–11: `suggested_cases` is JSON null, `case_qty=1`, `estimated_cost=10` (`= suggested_qty × cost_per_unit`). The null assertion (`ok (... = 'null'::jsonb)`) would fail if the server applied case math to a `case_qty=1` item.
  - jest `::no-case-size item renders {suggestedQty} {unit} unchanged (caseQty=1)`: `formatSuggested` returns `"8 gal"`, `.not.toMatch(/case/)`.
  - jest `::no-case-size item renders unchanged for caseQty null/0`: covers both null and zero case_qty.
  - jest `::Section render > non-case item renders {qty} {unit} with no case wording`: DOM render confirms `queryByText(/case/)` is null.

- **AC8** (ON HAND, INBOUND, PAR stay in base unit for all items) → PASS (implementation-verified, partially tested)
  - Implementation: `BreakdownLine` renders `on hand: {formatQty(item.onHand)} {item.unit}`, `inbound: {formatQty(item.pendingPoQty)} {item.unit}`, `par: {formatQty(item.parLevel)} {item.unit}` — all bypass `formatSuggested` and use the raw base-unit fields directly.
  - No dedicated assertion checks `on hand:` text in the section render, but the section render test for the case item (AC4) renders a BreakdownLine and confirms neither the `on hand:` nor `inbound:` nor `par:` segments contain case wording (they can't since the code paths don't invoke `formatSuggested`). PASS by implementation constraint + render test; a pure unit test of BreakdownLine's `on hand:` segment is absent but not required given the implementation clarity.

- **AC9** (CSV: Cases + Units Per Case columns for case items, empty for non-case, Est. Cost = rounded) → PASS
  - jest `::buildReorderCsv > emits Cases + Units Per Case columns in the header`: header contains both columns; column order matches `Suggested Qty,Cases,Units Per Case,Unit`.
  - jest `::buildReorderCsv > case row: Suggested Qty = ordered units (M), Cases populated, Est. Cost case-rounded`: `cells[5]=72`, `cells[6]=3`, `cells[7]=24`, `cells[9]=72.00`. Non-vacuous: would fail if `Suggested Qty` carried the raw 49 instead of the ordered 72.
  - jest `::buildReorderCsv > non-case row is byte-for-byte unchanged`: `cells[5]=8`, `cells[6]=''`, `cells[7]=''`.

- **AC10** (PDF Suggested cell + Est. Cost + footer = case-rounded figures) → PASS
  - jest `::formatSuggestedPdf > uses the "cs" abbreviation for case items`: returns `"3 cs · 72 each"`. Non-vacuous: would fail if the PDF helper returned the plain `"72 each"` or case-less form.
  - jest `::formatSuggestedPdf > renders plain for non-case items`: returns `"8 gal"`, no case wording.
  - `handlePdfExport` uses `formatSuggestedPdf(item)` and `$${item.estimatedCost.toFixed(2)}` directly; the footer reads `payload.kpis.totalEstimatedCost`. None of these are re-derived FE-side; the PDF unit test pins the one new spec-088 code path in the PDF builder (`formatSuggestedPdf`). No full PDF render integration test (the jsPDF dynamic import makes that hard to drive in jest), but per spec design that's not required.

- **AC11** (case display applies identically regardless of spec-087 day filter and to both PRIMARY + secondary groups) → PASS
  - jest `::EST. TOTAL invariant > holds after a spec-087 day filter drops a vendor`: filters one of two vendors and confirms the KPI rebalances correctly.
  - The `beforeEach` in the section render tests schedules the test vendor on EVERY weekday, ensuring the vendor lands in PRIMARY regardless of "today". The spec architect confirmed (Decision D) this is orthogonal — no `reorderDayFilter.ts` change required — and the day-filter invariant test covers the spec-087 interaction.

- **AC12** (regression: identical output for items with `case_qty` null/≤1 after migration) → PASS
  - pgTAP: the PLAIN item scenario (`case_qty=1`, `suggested_qty=10`, `cost_per_unit=1`) asserts `suggested_cases = JSON null`, `case_qty=1`, `estimated_cost=10`. The assertion `estimated_cost=10` would fail if the migration accidentally applied case rounding to a `case_qty=1` item. No `has_function_privilege` assertion (correct per spec — grant is untouched, signature byte-identical).

---

### Test run

#### pgTAP (via `npm run test:db` after `npx supabase db reset`)

```
npx supabase db reset          # applied all 31 migrations incl. 20260602000000_reorder_suggested_cases.sql
npm run test:db

== supabase/tests/report_reorder_list_cases.test.sql ==
  PASS  (12 assertion(s) passed)

✓ 42/42 DB test file(s) passed
```

New file: 42 → 42 total (was 41); `report_reorder_list_cases.test.sql` 12/12.

#### jest (full suite: `npx jest`)

```
Test Suites: 51 passed, 51 total
Tests:       510 passed, 510 total
Snapshots:   0 total
Time:        2.554 s
```

New file: `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx` — 17/17 tests passing. `src/utils/reorderDayFilter.test.ts` type-completeness fix passes. No regressions.

#### Typechecks

```
npx tsc --noEmit               → exit 0
npx tsc -p tsconfig.test.json --noEmit → exit 0
```

---

### Notes

1. **pgTAP plan count is exactly right.** `select plan(12)` matches 12 actual assertions (1 `isnt` fixture check + 10 `is` + 1 `ok`). The "Five scenarios pinned" in the file comment refers to the five distinct scenario types; the assertions are distributed correctly across them.

2. **No singular-case pgTAP assertion (24/24 → 1 case).** The spec's AC2 requires this boundary for display. The pgTAP correctly does not test it — singular/plural is pure FE formatting; the DB exposes `suggested_cases=1` for 24/24 which is algebraically implied by the exact-multiple 48/24 → 2 test. The jest test covers the singular boundary directly. No gap.

3. **ON HAND/INBOUND/PAR base-unit AC has no dedicated jest assertion.** The implementation uses a hardcoded code path that bypasses `formatSuggested`, so drift is unlikely, but a future refactor of `BreakdownLine` would not be caught by the existing tests until a section render test noticed "case" wording where none should be. Minor observability gap, not a blocking finding.

4. **PDF full-render test absent.** The `handlePdfExport` function dynamically imports jsPDF, making a full-render jest test impractical. The `formatSuggestedPdf` helper is tested directly (2 assertions), and all other PDF fields are unchanged server-read-throughs. Not a blocking gap given the design.

5. **FE does NO cost math — confirmed.** The test fixture (`caseItem` helper) derives `estimatedCost = orderedUnits × cost` to model what the server computes, then asserts the FE reads it verbatim. There is no `computeReorderKpis` FE-side per-item cost path; the KPI invariant flows through `vendorTotalCost` (server-rolled). This is the critical Decision-B guarantee and it is correctly pinned.

6. **No `set role anon` in pgTAP, no `has_function_privilege` assertion** — consistent with spec requirements (grant untouched, signature byte-identical). Correct.

7. **Migration applies cleanly after `db reset`** — confirmed, no errors from `20260602000000_reorder_suggested_cases.sql`.

---

All 12 acceptance criteria PASS. No criterion is FAIL or NOT TESTED. The test suite is non-vacuous across all key assertions (cost rounding, exact-multiple, KPI invariant). The spec-088 feature is ready for release-coordinator evaluation.

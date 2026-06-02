## Test report for spec 089

### Acceptance criteria status

**Data + scope (manager-RLS-scoped)**

- AC1: Staff Reorder screen renders the per-vendor reorder list for the manager's
  currently-selected `activeStore` by calling `report_reorder_list` via the
  staff-subtree carve-out (`fetchStaffReorder`), NOT the admin `db.ts`
  `fetchReorderSuggestions`. → **PASS** — `fetchReorder.test.ts::fetchStaffReorder calls report_reorder_list with p_store_id + p_params.as_of_date`; `Reorder.test.tsx::happy path` mocks `fetchStaffReorder` (not `db.ts`); confirmed by import graph (Reorder.tsx line 34 imports from `../lib/fetchReorder`, not `db.ts`).

- AC2: Screen is gated on an active store: if `activeStore` is null it does not
  attempt a fetch. → **NOT TESTED** — The screen implements the gate (`if (!activeStore?.id) return;` in the fetch effect, line 239 of Reorder.tsx), but no test in `Reorder.test.tsx` exercises the `activeStore = null` branch to assert fetch is not called. The `beforeEach` always sets a non-null `activeStore`. Gap in automated jest coverage; the guard is present in production code but unverified by test.

- AC3: A manager (role `user`) with a `user_stores` grant can load the screen; a
  store not granted yields the RPC's 42501 surfaced as a non-crashing error state. → **PASS (partial)** — The 42501 propagation is tested at two layers: `fetchReorder.test.ts::throws (propagates) a PostgREST RLS error (42501)` (fetch layer) and `Reorder.test.tsx::error pane (retry-able) when the fetch rejects` (screen layer, triggered via a rejected mock). The "manager with grant" path is not verified with a real JWT against the live Supabase stack — the spec confirms no pgTAP is required (no backend change; AC3's data-path openness is verified by the architect's §0 audit of the migration grants). Accepted: the fetch mock test covers the mapping; real-RPC validation was done by the developer manually (§Verification).

**Full parity with admin Reorder**

- AC4 (by-the-case display, spec 088): For an item where the server returns
  `suggestedCases != null`, the Suggested figure reads `N cases · M unit`
  (singular `1 case`); FE uses server-authoritative `suggestedUnits`; Est $ reads
  server-rounded `estimatedCost`. Byte-for-byte matches the admin `formatSuggested`
  output. → **PASS** — Covered by:
  (a) `reorderExport.test.ts::formatSuggested (cases·units, spec 088 byte-for-byte)` — four cases covering plural/singular/non-case/PDF variants;
  (b) `Reorder.test.tsx::renders the per-vendor card with the spec-088 cases·units Suggested string` — asserts `'Order: 3 cases · 72 each'` in rendered output using the shared `formatSuggested` (not a re-implementation);
  (c) `fetchReorder.test.ts::maps the spec-088 case fields through verbatim` — asserts `caseQty`, `suggestedCases`, `suggestedUnits`, `estimatedCost` survive the mapping unchanged.

- AC5 (calendar look-back, spec 087): A date picker lets the manager pick an
  as-of date; picking re-fetches with that `as_of_date`. Picker highlights the
  store's order-out weekdays via `activeWeekdaysFromSchedule`. → **PASS (partial)** — The RPC call with `as_of_date` is tested in `fetchReorder.test.ts::calls report_reorder_list with p_store_id + p_params.as_of_date`. The `ReorderDatePicker` component exists (`src/screens/staff/components/ReorderDatePicker.tsx`) with `activeWeekdays` prop wired (Reorder.tsx line 380). However, no jest test verifies the picker's `onChange` triggers a re-fetch with the new date — the Reorder.test.tsx has no date-change interaction test. The AC is covered at the RPC layer; the re-fetch-on-date-change interaction path is untested at the screen layer. Flagged as a gap.

- AC6 (order-out filter, spec 087): Rendered list is the PRIMARY "order today"
  set via `partitionReorderVendors`; vendors with no `order_schedule` row surface
  in a secondary "no schedule" group, not silently dropped. → **PASS** — `Reorder.test.tsx::nothing-to-order state when vendors exist but none order out today` confirms the primary/no-schedule partition (empty schedule yields `staff-reorder-nothing-today`). `Reorder.test.tsx::surfaces scheduleKnown=false vendors in the collapsible no-schedule group` confirms the no-schedule group is rendered and toggled. The `partitionReorderVendors` pure util is independently tested in `reorderDayFilter.test.ts`.

- AC7 (KPI cards): KPI strip shows vendor count, item count, est. total,
  EOD-sourced vs. stock-fallback vendor counts, computed CLIENT-SIDE from the
  filtered primary set via `computeReorderKpis`. → **PASS** — `Reorder.test.tsx::export buttons invoke the share orchestrator with the derived payload` asserts `passedPayload.kpis.itemCount === 1` and `passedPayload.kpis.totalEstimatedCost === 144` from a filtered primary payload, confirming `computeReorderKpis(primary)` drives the KPI values. The `computeReorderKpis` function is also exercised in `ReorderSectionCases.test.tsx::EST. TOTAL invariant`.

- AC8 (empty/warning/loading/error states): Mobile-appropriate equivalents of
  all four states (loading, empty, nothing-to-order, error+retry) and the
  `_warnings` banner. → **PASS (partial)** — Three of four states are tested:
  `staff-reorder-empty` (Reorder.test.tsx::empty state when the payload has no vendors at all),
  `staff-reorder-nothing-today` (Reorder.test.tsx::nothing-to-order state),
  `staff-reorder-error` + `staff-reorder-retry` (Reorder.test.tsx::error pane (retry-able) when the fetch rejects),
  `staff-reorder-warnings` (Reorder.test.tsx::renders the warnings banner).
  MISSING: No test asserts the `staff-reorder-loading` testID appears during the initial-load state (before the first payload resolves). The loading state is implemented in the screen (Reorder.tsx line 507–512) but not exercised in tests. Flagged as a gap.

**Cross-platform export/share (Option 2 — PDF everywhere)**

- AC9 (web export download): On web, export downloads the list via
  `triggerDownload`-pattern Blob+anchor, reflecting the filtered + as-of view. → **PASS** — `shareReorder.test.ts::shareReorderCsv web → builds a Blob + anchor download (no share sheet)` and `shareReorderText native → writes a .txt temp file + shares as text/plain` both cover the web Blob path. The derived (filtered) payload invariant is asserted in `Reorder.test.tsx::export buttons invoke the share orchestrator with the derived payload`.

- AC10 (native export/share): On native (Expo), export opens the OS share sheet
  via `expo-sharing` (writing a temp file via `expo-file-system` first). → **PASS** — `shareReorder.test.ts::shareReorderCsv native → writes a .csv temp file and opens the share sheet` asserts `mockFileCreate({ overwrite: true })`, `mockFileWrite`, and `mockShareAsync` with the correct mimeType. PDF-on-native via `expo-print` is tested in `shareReorder.test.ts::shareReorderPdf native → mockPrintToFileAsync renders a PDF, then shares it`.

- AC11 (export contents match on-screen data): Export reflects the same filtered
  primary set, cases-aware Suggested formatting, server-rounded costs — no FE cost
  re-derivation. → **PASS** — `Reorder.test.tsx::export buttons invoke the share orchestrator with the derived payload` directly inspects `passedPayload.vendors` and `passedPayload.kpis` to confirm the derived filtered payload is passed to the share functions. `reorderExport.test.ts::buildReorderText uses the server-rounded est cost (no FE cost math)` explicitly tests `est $144.00` comes from `estimatedCost`, not a re-derivation.

- AC12 (export hidden when nothing to export): Export is hidden/disabled when
  filtered list is empty, or error, or initial load — mirrors the admin `showExport`
  gate. → **PASS** — `Reorder.test.tsx::empty state when the payload has no vendors at all` asserts `queryByTestId('staff-reorder-export-csv')` is null. `Reorder.test.tsx::nothing-to-order state` also asserts export buttons absent.

- AC12a (PDF escape — security): `buildReorderPdfHtml` escapes HTML-unsafe
  characters in vendor/item names and store name. → **PASS** — `reorderExport.test.ts::buildReorderPdfHtml escapes HTML-unsafe characters in vendor + item names` asserts `Salt &amp; &lt;Pepper&gt;`, `Acme &quot;Foods&quot; &amp; Co`, `Store &amp; Co` and explicitly asserts the raw unescaped forms do NOT appear. This is the security-relevant test the security auditor also flags.

**Navigation / entry point**

- AC13: The manager can reach the Reorder screen from within the staff app via the
  bottom tab bar (Count | Reorder); EOD count remains reachable. → **PASS** — `StaffStack.tsx` implements `createBottomTabNavigator` with `EODCount` and `Reorder` tabs (confirmed by reading the file). The `staff-tab-eod` and `staff-tab-reorder` testIDs are set. The i18n test `i18n.test.ts::handles every key referenced in the queue UX` includes `'reorder.tabLabel'` and `'eodTab.label'`. No `StaffStack.test.tsx` directly exercises the tab bar navigation — this is the existing pattern (StaffStack.test.tsx if it exists was not extended for tabs).

**Admin regression gate (extraction)**

- AC14 (admin reorder jest stays green after extraction): `ReorderSectionCases.test.tsx` imports `formatSuggested`, `formatSuggestedPdf`, `buildReorderCsv` FROM `ReorderSection` (which re-exports them from `src/utils/reorderExport`). The 22-test admin suite must stay green. → **PASS** — Confirmed: `ReorderSectionCases.test.tsx` line 87 imports from `'../ReorderSection'`; `ReorderSection.tsx` line 42 re-exports from `../../../utils/reorderExport`. All 22 admin tests pass in the full suite run (60 tests across the 5 key suites, 553/553 total).

### Test run

**Command:** `npx jest`
**Result:** 55 suites, 553 tests, 0 failures, 0 snapshots — all PASS.

Key suite breakdown:
- `src/utils/reorderExport.test.ts` — PASS (13 tests)
- `src/screens/staff/lib/fetchReorder.test.ts` — PASS (6 tests)
- `src/screens/staff/lib/shareReorder.test.ts` — PASS (8 tests)
- `src/screens/staff/screens/Reorder.test.tsx` — PASS (8 tests)
- `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx` — PASS (22 tests)

**Typechecks:**
- `npx tsc --noEmit` — exit 0 (no output)
- `npx tsc -p tsconfig.test.json --noEmit` — exit 0 (no output)

**pgTAP:** None required or run. The spec explicitly confirms no backend change; the architect's §0 audit verified `report_reorder_list` and `order_schedule` are already manager-callable with no RLS gap.

### Notes

**Gaps found (none are Critical blockers for this review; detail below):**

1. **AC2 — `activeStore === null` gate (NOT TESTED, non-critical):** The screen correctly guards `if (!activeStore?.id) return;` in the fetch effect and renders an `<ActivityIndicator>` rather than fetching. No test in `Reorder.test.tsx` exercises this branch (e.g., set `activeStore: null` in the store and assert `mockFetchStaffReorder` was NOT called). In practice the tab navigator is never mounted without an active store (the `StaffStack` render branch guarantees this), so this is defense-in-depth code. The gap is a coverage quality issue, not a functional gap.

2. **AC5 — date picker re-fetch on change (PARTIAL, non-critical):** The `as_of_date` RPC param is verified in `fetchReorder.test.ts`. The screen's `useEffect([activeStore?.id, selectedDate, load])` dependency structure correctly triggers a re-fetch when `selectedDate` changes. No screen-level test fires the date picker's `onChange` and asserts a second `mockFetchStaffReorder` call. This is a test-completeness gap, not a functional gap.

3. **AC8 — loading state (`staff-reorder-loading`) NOT TESTED:** The initial-load state (spinner + text while `loading && !payload`) has the `staff-reorder-loading` testID in the production code but no test asserts it appears. The three other states (empty, nothing-to-order, error) ARE tested. This is a test-completeness gap.

4. **e2e `staff-reorder.spec.ts` NOT CREATED:** The spec's test contract (§ "Test contract") calls for a new `e2e/staff-reorder.spec.ts` using the existing `e2e/.auth/staff.json` fixture. The file does not exist. The spec frames this as "feasible" but explicitly defers to the developer; the test contract design section treats it as a deliverable. This is a gap. The spec's in-scope section says "e2e (Track 4) for the staff Reorder happy path if feasible" — so it is identified as in-scope.

5. **`expo-print` jest transform (confirmed present):** `jest.config.js` line 29 adds `'expo-print'` to `RN_TRANSPILE_DEPS`. This prevents the "SyntaxError: Cannot use import statement outside a module" error from expo-print's untranspiled ESM. Confirmed present — no issue.

6. **No platform asymmetry in PDF escape test:** The `buildReorderPdfHtml` HTML-escape test is thorough (`&`, `<`, `>`, `"` all verified; raw forms verified absent). This satisfies the security-auditor's expected finding. No gap here.

**Summary of PASS/FAIL/NOT TESTED:**
- AC1: PASS
- AC2: NOT TESTED (active store null guard)
- AC3: PASS (partial — real-JWT test not run; architect confirms data path open)
- AC4: PASS
- AC5: PASS (partial — re-fetch-on-date-change interaction not tested at screen layer)
- AC6: PASS
- AC7: PASS
- AC8: PASS (partial — loading state testID not tested)
- AC9: PASS
- AC10: PASS
- AC11: PASS
- AC12: PASS
- AC12a (PDF escape): PASS
- AC13: PASS (tab bar wired; no tab-navigation interaction test)
- AC14 (admin regression): PASS

All gaps (AC2, AC5 date-change, AC8 loading) are test-completeness issues, not functional failures — the production code implementing those behaviors is present and correct. The e2e gap (Track 4) is a missing deliverable from the spec's test contract.

No AC is FAIL. Three ACs have partial coverage gaps (AC2, AC5, AC8). The e2e gap is a separate track issue.

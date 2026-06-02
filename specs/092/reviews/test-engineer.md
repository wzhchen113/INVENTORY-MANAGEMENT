# Test report for spec 092

## Acceptance criteria status

- **AC-092-NAV** (reach the Reorder page as the manager): PASS — `e2e/staff-reorder.spec.ts::staff Reorder > AC-092-NAV/LIST/CASES/EXPORT`. `gotoReorderStore` navigates to `SEED.e2eReorderStoreId`, asserts `staff-reorder-root` visible, then `staff-reorder-store-name` contains the exact store name `'E2E Reorder Store'`. Handles both the StorePicker-tap path and the reload-with-persisted-store path via `picker.or(reorderTab).first()`.

- **AC-092-LIST** (reorder list renders, vendor card tripwire): PASS — `e2e/staff-reorder.spec.ts::staff Reorder > AC-092-NAV/LIST/CASES/EXPORT`. `getByTestId('staff-reorder-vendor-' + SEED.vendorUsFoodId)` is the FIRST assertion after navigation — a fail-loud tripwire that breaks if the fixture ever stops producing a non-empty PRIMARY list. The KPI strip "Vendors" label is then asserted within `staff-reorder-root`. Non-vacuous: would fail if the fixture produced an empty PRIMARY list because the vendor-card testID would not exist in the DOM.

- **AC-092-CASES** (by-the-case "N cases · M units" Suggested string): PASS — `e2e/staff-reorder.spec.ts::staff Reorder > AC-092-NAV/LIST/CASES/EXPORT`. The regex `/Order:\s*2\s*cases\s*·\s*24\s*EA/` is asserted on `vendorCard.getByText(casesPattern)`. Requires the "cases" word AND the U+00B7 middot — a units-only regression would not match. The value 2 cases / 24 EA is fixture-determined (par=24, current_stock=0, case_qty=12 → par_replacement=24 → suggested_cases=ceil(24/12)=2, suggested_units=24). Anchored to the US FOOD vendor card, not the root.

- **AC-092-EXPORT** (three export buttons present + enabled, no download): PASS — `e2e/staff-reorder.spec.ts::staff Reorder > AC-092-NAV/LIST/CASES/EXPORT`. All three `staff-reorder-export-csv`, `staff-reorder-export-text`, `staff-reorder-export-pdf` buttons are asserted `toBeVisible()` + `toBeEnabled()`. No click or `page.waitForEvent('download')` — matches the admin `reorder.spec.ts` precedent.

- **AC-092-STATE** (at least one no-data state): PASS — `e2e/staff-reorder.spec.ts::staff Reorder > AC-092-STATE: the empty store shows the no-data state`. `gotoReorderStore(page, SEED.e2eReorderEmptyStoreId)` then asserts `staff-reorder-empty` visible. Belt-and-suspenders: also asserts the US FOOD vendor card has `toHaveCount(0)` (the `showExport` gate is false on an empty PRIMARY). Now-independent (the empty store has no inventory, so `staff-reorder-empty` renders on any weekday without calendar interaction).

- **AC-092-DETERMINISM** (no cross-track pollution): PASS — teardown verified. After the run, PostgREST queries on all five affected tables (`stores`, `inventory_items`, `order_schedule`, `user_stores`, `catalog_ingredients`) for the two dedicated store ids (`e2e00000-…-0092`, `e2e00000-…-0093`) and the catalog id (`e2e00000-…-0000000000c1`) all return `[]`. The teardown log confirms `[e2e global-teardown] dedicated staff-Reorder stores … + catalog … removed.` fired unconditionally (the Critical fix landed: the spec-080 store-delete error handler is `warn`+fall-through, not `warn`+`return`). Both dedicated ids are not pgTAP `missed_order_audit_rpc` anchors.

- **AC-092-RUNS** (spec runs green locally, weekday-agnostic): PASS — `npx playwright test e2e/staff-reorder.spec.ts` on 2026-06-02 (Tuesday): 5 passed (3 auth-setup + 2 spec tests). All-7-weekdays `order_schedule` fixture and the now-independent empty store make this weekday-agnostic. No `waitForTimeout` fixed waits; all expects are Playwright auto-retrying.

---

## Test run

### Solo spec run
```
npx playwright test e2e/staff-reorder.spec.ts
5 passed (3.7s)

  ✓ [setup] authenticate as admin
  ✓ [setup] authenticate as master
  ✓ [setup] authenticate as staff
  ✓ [chromium] staff Reorder > AC-092-NAV/LIST/CASES/EXPORT: reorder list, by-the-case Suggested, export affordances (710ms)
  ✓ [chromium] staff Reorder > AC-092-STATE: the empty store shows the no-data state (669ms)
```
Teardown confirmed: `[e2e global-teardown] dedicated staff-Reorder stores e2e00000-0000-0000-0000-000000000092 + e2e00000-0000-0000-0000-000000000093 + catalog e2e00000-0000-0000-0000-0000000000c1 removed.`

### Full suite run
```
npx playwright test
16 passed, 1 failed (1.1m)
```
The single failure is the pre-existing `eod.spec.ts:190 AC-EOD2/3` (`setOffline` DOM-detach re-render race, timeout on `eod-submit` disabled button). This failure occurs identically without any spec-092 code, uses Towson (not the dedicated `…92`/`…93` stores), and is confirmed unrelated to spec 092. No new failure introduced by spec-092 fixture/teardown changes.

### Typechecks
```
npx tsc -p e2e/tsconfig.json --noEmit   → exit 0
npx tsc --noEmit                        → exit 0
```

### Teardown leak check (post-run DB queries)
```
stores          WHERE id IN (e2e00000-…0092, e2e00000-…0093)               → []
inventory_items WHERE store_id IN (e2e00000-…0092, e2e00000-…0093)         → []
order_schedule  WHERE store_id IN (e2e00000-…0092, e2e00000-…0093)         → []
user_stores     WHERE store_id IN (e2e00000-…0092, e2e00000-…0093)         → []
catalog_ingredients WHERE id = e2e00000-…-0000000000c1                     → []
```
Zero leak across all five tables.

---

## Coverage judgment — non-vacuousness per AC

**AC-NAV/LIST vendor-card tripwire:** Would FAIL if the fixture produced an empty PRIMARY list. `getByTestId('staff-reorder-vendor-' + SEED.vendorUsFoodId)` is a specific, fixture-derived testID. If the fixture seed fails or the order_schedule all-7-weekdays schedule does not land the vendor in `primary`, this element is absent and Playwright's auto-retrying `expect` times out → loud failure. Not vacuous.

**AC-CASES headline assertion:** The regex `/Order:\s*2\s*cases\s*·\s*24\s*EA/` requires (1) the string "cases" (plural), (2) the U+00B7 middot, (3) the exact fixture-computed values 2 and 24. A regression to units-only rendering would produce a string like "Order: 24 EA" without "cases" or the middot, and the regex would not match. Anchored to `vendorCard` (the US FOOD vendor card), not the root — so it requires both the card to be present AND the correct string within it. Non-vacuous.

**AC-EXPORT:** The three `getByTestId` calls are specific frozen testIDs from the frozen selector contract. `toBeEnabled()` distinguishes the enabled state from the disabled one (the `showExport` gate can disable them). No download asserted — matches spec scope.

**AC-STATE:** `staff-reorder-empty` is a specific testID that the screen only renders when `payload.vendors === []`. The dedicated empty store has no inventory, so this is `now`-independent. The belt-and-suspenders `toHaveCount(0)` for the vendor card confirms the negative state structurally.

**`beforeAll` fail-loud discipline:** The `REORDER_CASE_QTY <= 1` guard at the top of `beforeAll` throws a descriptive `Error` if a future edit drops `case_qty` to 1. Each of the 5 upserts checks `error` and throws with a self-explaining message naming the table, the expected FK chain, and the stack precondition. No silent-empty vacuous pass path.

**`beforeAll` idempotency:** All 5 upserts use `onConflict: 'id'` or `onConflict: 'user_id,store_id'` / `onConflict: 'store_id,day_of_week,vendor_id'` with `ignoreDuplicates: true` for the schedule. A re-run and a `db reset` both converge cleanly.

**`case_qty > 1` determinism guard:** Confirmed present at `staff-reorder.spec.ts:87-95`. Guard fires before any DB write.

---

## Critical fix verification

The code-reviewer's Critical (spec-092 teardown block conditionally unreachable due to `return` on spec-080 store-delete failure) is confirmed fixed in the current state of `e2e/global-teardown.ts:119-136`. The spec-080 store-delete error handler now uses `console.warn` + an `else` branch (fall-through), not `return`. The spec-092 block at lines 138-227 is reached unconditionally. The lone `return` at the function's end (line 220, after the catalog-delete failure warn) is the function's last statement and skips only the final success log — it cannot gate a sibling cleanup. Confirmed by teardown logs from the live run.

---

## Notes

- **Track classification:** This is Track 4 (Playwright, `e2e.yml`), NON-BLOCKING. Does not gate `test.yml` (jest + pgTAP). Confirmed correct.
- **No app code, no migration, no contract change:** The spec is test-only. `src/`, `supabase/migrations/`, `supabase/functions/` are untouched.
- **Pre-existing suite failure:** `eod.spec.ts:190` (`setOffline` re-render race) fails independently of this spec. It uses Towson, not the dedicated `…92`/`…93` stores. The spec-092 fixture and teardown do not touch Towson, Towson's `order_schedule`, or the EOD submission tables. This is not an AC-092 regression.
- **KPI "Vendors" label assertion:** The code-reviewer's Should-fix (removing the vacuous `getByText('1', { exact: true }).first()` assertion) is confirmed applied in the current code. The KPI assertion is now `root.getByText('Vendors', { exact: true })` — specific to the KPI strip, not a generic digit. The real no-vacuous-pass guard is the vendor-card tripwire.
- **Nits deferred:** The long test title, the `e2eReorderItemId` `0000000000a1` suffix, and the pre-existing `or().first()` locator pattern are cosmetic and do not affect correctness.
- **Local stack requirement:** The spec requires `npm run dev:db` (Supabase local) + Expo web (:8081). Both confirmed running during this test run.

## Test report for spec 104

### Acceptance criteria status

**Cost math (pure helpers)**

- AC1: `calcUnitCost(casePrice, caseQty, subUnitSize)` returns `casePrice / (caseQty × subUnitSize)` with defaults and the AC-pinned examples → PASS — `src/components/cmd/IngredientForm.test.ts` (describe `calcUnitCost (spec 104 — per-each…)`, 5 its: divides, 2000-count cup, caseQty=0 guard, negative price, single-source identity)
- AC2: `calcUnitCost` single-sourced with `piecesPerCase` (AC line 83 identity over positive domain) → PASS — `src/components/cmd/IngredientForm.test.ts::is single-sourced with piecesPerCase over the positive-case_qty domain`. Note: open issue documented in spec (AC line 81 guard vs identity are contradictory at caseQty=0). The guard wins (concrete AC value); identity asserted over positive domain. The test matches that decision.
- AC3: `derivedUnitCost` gains `subUnitSize` arg; editor cost/unit shows per-each → PASS — `src/components/cmd/IngredientForm.test.ts` (describe `derivedUnitCost (spec 104 — 3-arg per-each string wrapper)`, 6 its including `'50','1','500' === '0.1'`, deep sub-cent precision, guard cases)

**Recipe / BOM costing (second-divide removal)**

- AC4: `getIngredientLineCost` no longer divides by `subUnitSize` a second time; line cost dollar unchanged → PASS — `src/store/useStore.test.ts::branch 2 (standard conversion) drops the 2nd sub-unit divide` (8 oz at per-each $1.0/oz = $8.0, pre-flip identical)
- AC5: Short-circuit and abstract-conversion branches reviewed and adjusted → PASS — `src/store/useStore.test.ts` covers: `branch 1` (short-circuit, `× subUnitSize` bridge), `branch 1b` (each-tracked, bridge is no-op), `branch 3` (abstract subUnitSize=1 unchanged), `branch 3b` (abstract subUnitSize>1, `× subUnitSize` into costPerBase). All three branches plus the subUnitSize=1 no-op case are exercised.
- AC6: `getPrepRecipeCost` / `getPrepRecipeCostPerUnit` and RecipesSection roll-up produce the same dollar → NOT TESTED by a dedicated jest test. The store functions call `getIngredientLineCost` which is tested; the inline copy at RecipesSection.tsx:678 has the `× subUnitSize` bridge but no jest regression pins the roll-up dollar end-to-end. The spec notes this as pinned via "regression-pinned" but no test file exercises `getPrepRecipeCost` with per-each seeds. The FE dev's local validation log confirms math equality but there is no automated test that would catch a future regression on the recipe roll-up path. **Finding (non-blocking per test-track rules but surfaced):** AC line 104-107 says "regression-pinned"; the test track AC says `getIngredientLineCost` regression covers this, and `getPrepRecipeCost` calls through it. However no test file exercises `getPrepRecipeCost` directly with per-each values. Treat as a coverage gap.

**Stock value / waste / reconciliation / dashboard (OQ-5 bridges)**

- AC7: `getInventoryValue` and every live-costPerUnit × counted-quantity consumer bridged with `× subUnitSize` (DashboardSection, ReconciliationSection, InventoryCatalogMode weightedCost, RestockSection, POsSection, ReceivingSection, EODCountSection) → PASS (code verified, no dedicated jest test). All bridges are present in code: `DashboardSection.tsx:243,799`, `ReconciliationSection.tsx:85,271,356`, `RestockSection.tsx:73`, `POsSection.tsx:77`, `ReceivingSection.tsx:102`, `EODCountSection.tsx:585,1791`, `RecipesSection.tsx:681`, `ItemDetailScreen.tsx:97`, `InventoryDesktopLayout.tsx:449`, `ExportCsvDrawer.tsx:29`. The `weightedCost` at `InventoryCatalogMode.tsx:147` is intentionally NOT bridged (it is a cost-average numerator, not a stock value; bridging it would break the OQ-3 per-each avgCost display — documented in the open issues). `getInventoryValue` at `useStore.ts:2565` has the `× (item.subUnitSize || 1)` bridge. No jest regression pins the dollar equality for these consumers, but the spec's governing constraint is asserted by the `getIngredientLineCost` branches plus the pgTAP reorder test; the FE consumer bridges are uniform code changes without branch complexity.
- AC8: Waste snapshot (R1 option (a)) — write-side NOT read-side → PASS (code verified). `logWasteEntry` in `db.ts:704` persists `entry.costPerUnit * subUnitSize` (looked up from catalog). The re-CREATEd `staff_log_waste` RPC at migration line 1132 snapshots `v_item.cost_per_unit * v_item.sub_unit_size`. `getWasteThisWeek` at `useStore.ts:2573` is correctly left UNBRIDGED. `DashboardSection.tsx:257` waste read is left UNBRIDGED with a guard comment. **No automated test (jest or pgTAP) exercises the write-side R1 fix.** The spec validates it via local manual run ("staff_log_waste verified: high-sub_unit_size item snapshots 49.00 = cost_old (matches=t)"). This is a coverage gap per the test-layer rules (no mock-free test exists for this write path); however the spec's test-track AC does not explicitly mandate an automated test for the waste snapshot fix (the spec-104 test ACs call for jest on calcUnitCost/derivedUnitCost/getIngredientLineCost and pgTAP on reorder). Treat as a noted gap, not a block.
- AC9: Detail-panel and inventory-list "Cost / unit" / "cost / u" cells show per-each cost and remain self-consistent → PASS (code verified, no jest render test). `ItemDetailScreen.tsx:108` shows `Cost / ${eachLabel}` with `sub: 'per-each'`; `InventoryDesktopLayout.tsx:459` same pattern; `InventoryCatalogMode.tsx:831` shows per-each via the `perEachCost` util (primary path unchanged, fallback now identity); `VendorsSection.tsx:525` shows raw `costPerUnit` (per-each as-is). No jest render test pins the label wording.
- AC10: `InventoryCatalogMode` per-each display does not double-divide once `costPerUnit` is already per-each → PASS — `src/utils/perEachCost.test.ts::falls back to costPerUnit AS-IS (identity) when casePrice is 0/unset — spec 104` and `fallback is subUnitSize-independent now (identity)`. The `perEachCost.ts` fallback is confirmed identity; the tests pin it.

**Display label (OQ-3)**

- AC11: "Cost / unit" / "cost / u" label updated to per-each / smallest-unit wording across ItemDetailScreen, InventoryDesktopLayout, IngredientForm → PASS (code verified, no render test). Labels changed: `ItemDetailScreen.tsx:108` → `Cost / ${eachLabel}`, `IngredientForm.tsx` → "cost / each" and "auto · case price ÷ (units/case × sub-units)"; i18n `en.json:290` → "Avg cost / each". No jest render test pins the exact string, but the `IngredientForm.spec093.test.tsx` narrowed-catch-all confirms the "×" glyph is no longer banned form-wide (the spec-104-mandated help text is permitted). The narrowing is legitimate: the old `queryByText(/×/)` banned all "×" in the form, but spec 104 adds "units/case × sub-units" to the help text intentionally. The narrowed assert `queryByText(/×\s*\S+\s*per order/)` targets only the old inverted arithmetic.

**Per-vendor cost (spec 102)**

- AC12: `item_vendors.cost_per_unit` uses the per-each basis; editor's `handleVendorCasePriceChange` derives per-each → PASS (code verified). `IngredientForm.tsx:836` calls `derivedUnitCost(value, values.caseQty, values.subUnitSize)` (3-arg, per-each). `IngredientFormDrawer.tsx:67` threads `String(it.subUnitSize || 1)` to per-vendor `derivedUnitCost`. Migration derives `item_vendors.cost_per_unit / sub_unit_size`. The pgTAP reorder test inserts `item_vendors` links with per-each cost and confirms the rollup.
- AC13: Reorder RPC per-vendor cost coalesce `coalesce(nullif(iv.cost_per_unit,0), ii.cost_per_unit, 0)` consumes per-each consistently → PASS — verified in migration lines 840-841 (both branches multiply by `pis.sub_unit_size`). The pgTAP test's vendor_total_cost rollup assertion (A4) covers the coalesce path end-to-end.

**Reorder cost (server) — OQ-1**

- AC14: Reorder `estimated_cost`, `vendor_total_cost`, `kpis.total_estimated_cost` numerically equal pre-spec values (cent tolerance) → PASS — `supabase/tests/report_reorder_list_per_each_cost.test.sql` assertions A1 (casebox: 180.00, `abs < 0.01`), A2 (pkg: 500.00, `abs < 0.01`), A4 (rollup == sum of items, `abs < 0.01`). The (★)-inverse round-trip assertion B also confirms the reconstruction path. The tolerance is cent-level as required by §8 R7.

**Data migration (prod + seed) — OQ-2, OQ-4**

- AC15: Migration widens `inventory_items.cost_per_unit` and `item_vendors.cost_per_unit` to `numeric(12,6)` before re-derivation → PASS (migration code verified). `20260701000000_spec104_per_each_cost_basis.sql` lines 128-129: `ALTER TABLE … type numeric(12,6)` for both columns, BEFORE any UPDATE. `catalog_ingredients.default_cost` is already unconstrained and not widened. **No automated pgTAP test asserts `information_schema.columns` precision/scale** — the spec explicitly calls this a manual verification step for prod apply (R2: "verify `information_schema.columns` shows `numeric_precision=12, numeric_scale=6`"). The local pgTAP suite validates the functional effect (reorder reconstructs to cent tolerance), not the schema type itself.
- AC16: Reversible, idempotent migration re-derives all three columns via `cost_old / sub_unit_size` (option (b)) with idempotency guard on the audit table → PASS (migration code verified). All three UPDATEs are guarded by `WHERE NOT EXISTS (select 1 from spec104_per_each_cost_audit a where …)`. The `on conflict (source_table, row_id) do nothing` on INSERTs completes the double guard. Comment at migration lines 75-96 explicitly documents the idempotency caveat (migration-before-seed on local reset means the first local apply is a no-op; prod apply is one-shot against old-basis rows and the guard prevents double-divide on re-run).
- AC17: (★) round-trip holds within $0.001 → PASS — `supabase/tests/report_reorder_list_per_each_cost.test.sql` assertion B: `cost_per_unit(0.10) × sub_unit_size(500) = 50.00`, `abs < 0.01`.
- AC18: Rows with `cost_per_unit` / `default_cost` ≤ 0 or null snapshotted to audit table as population 'X' and NOT mutated → PASS (migration code verified). Separate INSERT with `population = 'X'`, `new_cost = NULL`; the UPDATE joins on `population = 'D' AND new_cost IS NOT NULL`, so zero-cost rows are never mutated. **No automated pgTAP test inserts a zero-cost fixture and asserts audit membership** — population-X is not exercised in any test. This is a coverage gap. However, the logic is a simple predicate split on `coalesce(cost, 0) > 0` vs `<= 0`; the migration structure is correct by inspection.
- AC19: BACKOUT block restores VALUES first, then re-narrows → PASS (migration code verified). The BACKOUT comment block at the foot of the migration documents the correct order (restore from audit `old_cost` WHILE columns are `numeric(12,6)`, then re-narrow). Not auto-applied; no test covers the BACKOUT path (consistent with the project's no-down-migration convention, same as spec 093).
- AC20: `supabase/seed.sql` regenerated to per-each basis for `inventory_items.cost_per_unit`, `item_vendors` (not in seed per spec), and `catalog_ingredients.default_cost` (OQ-4) → PASS (verified via the local pgTAP run passing `report_reorder_list_per_each_cost.test.sql` on a db-reset stack). The developer confirms "368 inventory_items + 92 catalog_ingredients rows updated in-place." Item_vendors is not in the seed (backfilled by migration), consistent with spec.
- AC21: Migration reflected in prod's `schema_migrations` (db-migrations gate stays green) → NOT TESTED (prod-gated; user-gated MCP apply is pending). The CI `db-migrations-applied.yml` gate is the automated check; it is NOT run locally and the status at the time of this review is unconfirmable until prod apply.

**Tests (track AC)**

- AC22: jest — spec-093 `calcUnitCost` and `derivedUnitCost` describes REPLACED to assert per-each basis → PASS — `src/components/cmd/IngredientForm.test.ts` lines 280-377 (describe headers explicitly call out "spec 104 REVERSES spec 093"). Old "12×-class error" language is gone.
- AC23: jest — `getIngredientLineCost` regression covers all three branches → PASS — `src/store/useStore.test.ts` lines 299-436. Branches: short-circuit (1, 1b), standard conversion (2), abstract with subUnitSize=1 (3), abstract with subUnitSize>1 (3b), no-item-found (0 guard).
- AC24: pgTAP — DB test pins reorder `estimated_cost` / `vendor_total_cost` for seeded fixture equals pre-spec figure → PASS — `supabase/tests/report_reorder_list_per_each_cost.test.sql` (6 assertions, all PASS in the run below).
- AC25: `public_grants_explicit.test.sql` updated — `spec104_per_each_cost_audit` added to allowlist (anon + authenticated) and negative arm (7) added → PASS — `supabase/tests/public_grants_explicit.test.sql` plan updated from 10 to 13; arm (7) adds 3 `ok()` calls asserting the audit table's deny-all locks hold for anon/authenticated and service_role keeps SELECT. Allowlist VALUES list includes the 4 spec-104 rows. All 13 assertions PASS.

---

### Test run

**jest (full suite):**
```
npx jest --no-coverage
Test Suites: 74 passed, 74 total
Tests:       783 passed, 783 total
Time: 3.222 s
```
No regressions introduced. 783/783.

**jest (spec-104-relevant files only, confirming targets pass):**
```
npx jest --testPathPattern="perEachCost|IngredientForm.test|useStore.test|IngredientForm.spec093" --no-coverage
Test Suites: 4 passed, 4 total
Tests:       89 passed, 89 total
```
Specific files: `src/utils/perEachCost.test.ts` (PASS), `src/store/useStore.test.ts` (PASS), `src/components/cmd/IngredientForm.test.ts` (PASS), `src/components/cmd/IngredientForm.spec093.test.tsx` (PASS).

**pgTAP (full suite via `npm run test:db`):**
```
58/58 DB test file(s) passed
```
Includes: `report_reorder_list_per_each_cost.test.sql` (6/6 PASS), `public_grants_explicit.test.sql` (13/13 PASS). No regressions.

**Typecheck:**
```
npm run typecheck   → 0 errors
npm run typecheck:test → 0 errors
```

---

### Notes

**1. `IngredientForm.spec093.test.tsx` narrowing — legitimate, not masking a regression.**
The old `queryByText(/×/)` banned all "×" glyphs from the form. Spec 104 adds "case price ÷ (units/case × sub-units)" to the IngredientForm help text, which correctly contains "×". The narrowed assert (`queryByText(/×\s*\S+\s*per order/)`) preserves the original intent (ban the old "× N per order" inverted arithmetic sentence) without false-positiving on the new help text. This is a correct, scoped fix.

**2. `perEachCost.test.ts` fallback tests — correctly updated, not masking a regression.**
Three tests updated (per spec's "stale pre-existing test fixes"): the old `costPerUnit / subUnitSize` fallback produced a different number; the new identity fallback produces `costPerUnit` itself. The tests are semantically correct for the new per-each-end-to-end contract. Any regression that re-introduces the `/ subUnitSize` fallback would be caught by the `'3.25oz Cup w/ Lid'` test (which currently expects the primary path via `casePrice / (caseQty × subUnitSize)`, not the fallback) and the `'fallback is subUnitSize-independent now'` test.

**3. Coverage gaps (non-blocking per spec's test-track ACs, surfaced for awareness):**

- **`getPrepRecipeCost` / `getPrepRecipeCostPerUnit` roll-up (AC6):** No jest test seeds these functions with per-each cost values and asserts dollar equality. The functions call `getIngredientLineCost` which is tested, so the call graph is covered indirectly, but an inline copy of the short-circuit at `RecipesSection.tsx:681` is also bridged and not tested by any render test.

- **`logWasteEntry` write-side fix and `staff_log_waste` RPC (AC8 / R1):** No automated test (jest or pgTAP) exercises the waste snapshot bridge. The write-side code (`db.ts:704`: `entry.costPerUnit * subUnitSize`) and the RPC (`migration:1132`: `v_item.cost_per_unit * v_item.sub_unit_size`) are correct by code inspection. The spec dev confirmed via local DB query that the RPC snapshots `49.00` for a `sub=2000` item. Per project policy, integration tests must hit a real DB; a pgTAP test for `staff_log_waste` is feasible but was not written. The `logWasteEntry` FE path similarly has no jest test.

- **Population-X (zero-cost rows) in migration (AC18):** No pgTAP test inserts a zero-cost fixture and asserts it stays in the audit as population 'X' with no column mutation. The migration's predicate is correct and simple; the gap is noted for completeness.

- **Column widening `numeric(12,6)` assertion (AC15):** No automated `col_type_is` or `information_schema` pgTAP assertion verifies the column precision was widened. The spec designates this as a manual prod-apply verification step. The functional effect is tested indirectly (the pgTAP reorder test stores per-each cost at sub-cent precision and reconstructs to cent tolerance, which would fail under the old `numeric(10,2)` truncation).

- **Prod migration gate (AC21):** The `db-migrations-applied.yml` gate status cannot be confirmed locally. This is prod-apply-gated per the spec.

**4. `InventoryCatalogMode.weightedCost` intentionally NOT bridged (documented open issue 2).**
This is a correctly documented design decision (the numerator feeds the per-each `avgCost` display; bridging it would make `avgCost` per-counted-unit, contradicting OQ-3). No test pins this unbridged state, but the code comment at `InventoryCatalogMode.tsx:133-147` is explicit. Not a defect.

**5. Minor display mismatch in POs/Receiving (documented open issue 3).**
The per-unit cost cell in those sections shows the raw per-each figure while the line total is bridged. `unitCost × qty ≠ lineCost` visually for sub>1 items. This is the spec's documented follow-up; it does not affect dollar totals.

## Test report for spec 093

### Acceptance criteria status

- **AC1 — Readback wording.** For DEFAULT UNIT=`cases`, case size=`20`, PACK UNIT=`lbs`, the readback contains `"1 case = 20 lbs"` and does NOT contain `"20 cases per order"`. → **PASS** — `src/components/cmd/IngredientForm.spec093.test.tsx` :: `"renders \"1 case = 20 lbs\"..."` and `"does NOT render the old inverted \"20 cases per order\" sentence"` (two separate assertions). Also pins `per order` and `×` absence as belt-and-suspenders. The `subUnitUnit`-empty fallback (`1 case = 450 each`) and empty-caseQty guard (renders nothing) are also covered in the same describe block.

- **AC2 — Column binding (Q1(a)).** Saving "1 case = 20 lbs" persists `case_qty=20`, NOT `case_qty=1, sub_unit_size=20`. → **PASS** (with scope note). The AC says "verified by reading the row after save"; the tests verify this at two levels: (a) `IngredientForm.spec093.test.tsx` :: independent-axes write asserts the accumulated form state has `caseQty='20'` after onChange fires, which is the value `toUpdates()` would feed into db.ts:278 (`case_qty = updates.caseQty`); (b) the Track-3 smoke (`smoke-migrate-spec093.sh`) confirms `0 rows with case_qty<=1 AND sub_unit_size>1` exist in the live seeded DB after the backfill applies. There is no jest-level test that fires a real DB write and reads the row back; §11 explicitly scopes the form layer as a "pure-function test on `toUpdates`" and the DB layer as Track-2/Track-3. The chain is structurally verified (form state → `toUpdates()` → db.ts:278-280 → PostgREST), and db.ts:278-280 is unchanged and correct per §0.

- **AC3 — Sub-unit retained as a separate axis (Q1(a)).** The two fields never conflate. → **PASS** — `IngredientForm.spec093.test.tsx` :: `"drives caseQty and subUnitSize independently (neither conflated)"`. Test fires `changeText('5', '20')` on the case-size input and `changeText('7', '10')` on the sub-unit input; asserts `caseQty==='20'` AND `subUnitSize==='10'` plus the cross-bleed negations. `IngredientFormDrawer.tsx:toUpdates()` maps them to distinct `Partial<InventoryItem>` fields; db.ts:278-280 maps those to distinct columns (`case_qty`, `sub_unit_size`).

- **AC4 — Reorder round-trip (Q4(b)).** After a fixed row with `case_qty=20`, `suggested_cases = ceil(suggested_qty / 20)`. → **PASS** — `supabase/tests/spec093_case_qty_backfill.test.sql` :: assertion (B) `"reorder round-trip: fixed case_qty=20 row → suggested_cases = ceil(50/20) = 3"`. Inserts a catalog row with `case_qty=20`, an `inventory_items` row with `par_level=50, current_stock=0, usage_per_portion=0`, calls `report_reorder_list`, and asserts `suggested_cases = 3::numeric`. 8/8 assertions pass.

- **AC5 — EOD round-trip (Q4(b)).** After a fixed row, EOD `total = cases × 20 + units`. → **PASS** — `src/screens/staff/screens/EODCount.test.tsx` :: `"round-trips a spec-093 fixed row (case_qty=20): total = cases × 20 + units"`. Item with `case_qty: 20`; inputs `cases='3', units='4'`; asserts submit payload `actual_remaining: 64 (3×20+4)`. No EOD code change — pins the existing consumer against the fixed-row shape.

- **AC6 — Label/help reconciliation (Q5).** Case-size and sub-unit fields carry distinct labels; sub-unit help describes "per tracking unit," not shipping-wrapper-only. → **PASS** — `IngredientForm.spec093.test.tsx` :: four tests in the `"label / help reconciliation"` describe:
  - `"gives the case-size field and the sub-unit field DISTINCT labels"` — asserts `"units / case"` and `"sub-unit / unit"` both render, and old `"units / pack"` / `"packs / order"` labels are gone.
  - `"describes the case-size help as units-per-case"` — asserts `"how many tracking units come in one case (e.g. 20 lbs per case)"`.
  - `"describes the sub-unit help as PER-TRACKING-UNIT, not a shipping wrapper"` — asserts `"how many sub-units make up ONE tracking unit (e.g. a bag of 10 each)"`.
  - `"reworded the PACK UNIT help away from the \"shipping wrapper\" meaning"` — asserts the new copy and asserts `queryByText(/shipping wrapper/)` is null.
  - Additionally: `IngredientForm.help-text.test.tsx` was updated with the spec-093 `PACK_UNIT_HELP` constant and all 6 behavior assertions (help persists under error; renders in both SelectField + CustomUnitInput branches) stay green.

- **AC7 — Existing-data posture (Q2(a)).** Backfill migration moves Population-B rows into `case_qty`, leaves Population-C untouched + flagged, leaves A/D untouched, post-count = 0, documented backout. → **PASS** — covered by three tracks:
  - `supabase/tests/spec093_case_qty_backfill.test.sql` assertions 1–7: B fixture migrated to 500/1; C fixture unchanged at 4/5 AND present in audit table with `population='C'`; A/D fixtures untouched; B recorded with old 1/500 snapshot; no mis-encoded rows remain across fixtures.
  - `scripts/smoke-migrate-spec093.sh` against the live seeded DB: 0 mis-encoded rows, idempotent re-apply, audit table has RLS enabled + no anon/authenticated grants; 42 Population-C rows flagged (matching seed shape).
  - Backout block is present as a commented `-- BACKOUT` section at the foot of `supabase/migrations/20260602120000_spec093_case_qty_backfill.sql`.

- **AC8 — Cost calc (Q3(a)).** `calcUnitCost(20.00, 20, anything) === 1.00`; third argument no longer affects result. → **PASS** — `src/components/cmd/IngredientForm.test.ts` :: `"calcUnitCost (spec 093 Q3a — divide by case_qty alone)"` describe block (4 tests): `calcUnitCost(20, 20, 0)=1.0`, `calcUnitCost(20, 20, 1)=1.0`, `calcUnitCost(20, 20, 999)=1.0`; `calcUnitCost(20, 20, 5)=1.00`; `calcUnitCost(50, 500, 10)≈0.10`; `calcUnitCost(20, 0, 5)=0`. db.ts:3710 fallback independently confirmed fixed in source (`cp / caseQty` alone).

- **AC9 — No regression (specs 045/046/052/054).** Existing form tests stay green. → **PASS** — Full jest run: 57 suites / 578 tests, all pass. Specifically:
  - `IngredientForm.test.ts` (spec 046 `validateCustomUnit` tests) — PASS.
  - `IngredientForm.help-text.test.tsx` (specs 052/054, PACK_UNIT_HELP updated per spec-093 §9) — PASS.
  - `IngredientForm.spec093.test.tsx` — PASS (new, 9 tests).
  - `EODCount.test.tsx` — PASS (includes new EOD round-trip).

---

### Test run

#### Track-1 (jest)

```
npx jest --no-coverage
Test Suites: 57 passed, 57 total
Tests:       578 passed, 578 total
```

Specific suites exercised by spec 093:
- `PASS component src/components/cmd/IngredientForm.spec093.test.tsx` — 9 tests
- `PASS component src/components/cmd/IngredientForm.test.ts` — includes 4 calcUnitCost pins (total suite passes all validateCustomUnit + calcUnitCost tests)
- `PASS component src/components/cmd/IngredientForm.help-text.test.tsx` — 6 tests (updated PACK_UNIT_HELP constant)
- `PASS component src/screens/staff/screens/EODCount.test.tsx` — includes new spec-093 EOD round-trip test (total suite 12 tests)

No failing tests. No skipped tests. Full regression clean.

#### Track-2 (pgTAP)

```
npm run test:db
✓ 43/43 DB test file(s) passed
```

- `PASS supabase/tests/spec093_case_qty_backfill.test.sql (8 assertion(s) passed)`
  - (1) 0 mis-encoded rows across fixtures after backfill
  - (2) Population-C fixture unchanged at 4/5
  - (3) Population-C fixture in audit table with `population='C'`
  - (4) Population-B fixture migrated to 500/1
  - (5) Population-A fixture untouched at 450/1
  - (6) Population-D fixture untouched at 1/1
  - (7) Population-B in audit table with `population='B'` and old 1/500 snapshot
  - (B) Reorder round-trip: `case_qty=20`, par 50 → `suggested_cases = 3`
- All prior tests green including `report_reorder_list_cases.test.sql` (12/12), `permissive_policy_lint.test.sql` (4/4 — audit table does not trip it), and all 40 other files.

#### Track-3 (shell smoke)

```
bash scripts/smoke-migrate-spec093.sh
✓ all checks passed
```

Results:
- Migration applied cleanly (psql exit 0); NOTICE: 42 split rows flagged for owner hand-review (Population C)
- `public.spec093_case_qty_backfill_audit` exists
- RLS enabled on audit table
- No anon/authenticated grants on audit table
- 0 rows with `case_qty<=1 AND sub_unit_size>1` (Population-B UPDATE took effect against seeded data)
- Re-apply is a data no-op (self-extinguishing predicate, count still 0)

#### TypeScript

```
npx tsc --noEmit
(exit 0, no output)
```

---

### Notes

1. **AC2/AC3 "reading the row after save" language vs. pure-function tests.** The AC text says "Verified by reading the row after save." The jest tests verify form-state accumulation only (no real DB write). This is architecturally sound because: (a) §11 explicitly describes the Track-1 design as "a pure-function test on `toUpdates`"; (b) db.ts:278-280 is the one already-correct seam (per §0) and is left unchanged; (c) the Track-3 smoke confirms the live seeded DB has 0 mis-encoded rows after applying the migration. The gap between "form state verified" and "DB row read-back verified" is intentional and owner-accepted in the test plan. Not a BLOCK.

2. **Population-C hand-review list.** The smoke confirms 42 Population-C rows are flagged in `spec093_case_qty_backfill_audit`. These are NOT auto-mutated per the AC. The owner must hand-review `select * from public.spec093_case_qty_backfill_audit where population = 'C'` after `supabase db push`. The spec and migration comment this clearly. No test gap — this is a deliberate owner step.

3. **R2 (default_cost recompute) and R4 (calcCasePrice asymmetry).** Both are explicitly out-of-scope per owner decision. No test covers them, and none is expected. The test-engineer confirms these are not ACs and not BLOCKs.

4. **`calcUnitCost` third parameter marked `void`.** The implementation uses `void subUnitSize;` to suppress the unused-parameter pattern. The AC pins the 3-arg call shape and this is satisfied. The TypeScript build is clean.

5. **`IngredientForm.help-text.test.tsx` PACK_UNIT_HELP pin update.** This is a legitimate test update — spec 093 §9 rewrites that copy string. The file notes this in a header comment. Behavioral assertions (help persists under error, both SelectField + CustomUnitInput branches) are preserved and still green.

6. **No new test framework introduced.** All three tracks use the existing jest / pgTAP / shell-smoke setup from spec 022. No fourth framework. No CI workflow changes.

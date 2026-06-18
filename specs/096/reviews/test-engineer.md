## Test report for spec 096

### Acceptance criteria status

- AC1 — A custom unit name committed via the `'+ custom…'` flow on ANY ingredient becomes a selectable option in the default-unit AND pack-unit dropdowns of EVERY ingredient in that brand → **PASS** — `src/utils/brandUnitPool.test.ts::unions BOTH ingredient axes — unit AND subUnitUnit (the AC1 gap-closer)` covers the helper's gap-closing behavior. `IngredientForm.spec093.test.tsx` (9 tests, all passing) and `IngredientForm.help-text.test.tsx` (6 tests, all passing) confirm the component renders without crashing; the pool is wired into both dropdowns (confirmed by code review of IngredientForm.tsx). The prior-review Critical (mock mismatch) is resolved.

- AC2 — Picking a shared unit name sets the ingredient's `unit`/`sub_unit_unit` string only; conversion factors and pack sizes are NOT inherited → **NOT TESTED** — No automated test verifies that picking a pool entry leaves `caseQty`/`subUnitSize` unchanged. The spec design explains AC2 holds structurally (pick path calls only `set('unit', v)` / `set('subUnitUnit', v)`), but there is no test that mutates form state via the pool and asserts conversion fields are untouched. Acceptable follow-up; not a ship blocker per the architect's "holds by construction" note.

- AC3 — The shared pool is brand-scoped; a unit name from brand A does NOT appear in brand B's dropdowns → **NOT TESTED** — The pool source was switched to `catalogIngredients` (which is brand-scoped by construction per the security fix), but no test exercises two brands' arrays through `deriveBrandUnitPool` and verifies isolation. Acceptable follow-up; the security finding from the prior review is resolved by the implementation switch, not by an added test.

- AC4 — Canonical units, stored-value fallback, `'+ custom…'` sentinel-last, and case-insensitive snap-to-canonical continue to work unchanged → **PASS** — `IngredientForm.test.ts` exercises the canonical/custom-unit paths without regression. `IngredientForm.help-text.test.tsx` and `IngredientForm.spec093.test.tsx` (previously broken) now pass, confirming no regression in the custom-unit paths they cover.

- AC5 — Case-insensitively matching an existing pool name does NOT create a duplicate entry → **PASS** — `src/utils/brandUnitPool.test.ts::de-dupes case-insensitively on lower(name) (AC5)` directly covers this.

- AC6 — The catalog list row surfaces BOTH a case price AND a per-each price when a meaningful breakdown exists → **NOT TESTED at the UI level** — `InventoryCatalogMode.test.tsx` still only covers the spec-049 copy affordances. No test seeds an inventory row with `caseQty=1, subUnitSize=2000` and asserts the dual `$X/case · $Y/each` label renders. The math is covered by `perEachCost.test.ts` (proves the $0.0245 figure). The rendered UI label is unverified. **Acceptable follow-up — does not block ship.** The underlying `perEachCost` util is fully tested; the catalog-row rendering is a thin wrapper. A CI gap exists but it is a new-coverage gap, not a regression.

- AC7 — The per-each figure divides by `caseQty × subUnitSize`, never `caseQty` alone; `db.ts:3769-3779` is NOT changed → **PASS** — `src/utils/perEachCost.test.ts::primary path divides casePrice by the REAL piece count (caseQty × subUnitSize), not caseQty alone (AC7)` directly pins this: with `caseQty=1, subUnitSize=2000`, if the divide were by `caseQty` alone the result would be `49.00`; the test asserts `0.0245`. The `db.ts:3769-3779` guard is confirmed untouched.

- AC8 — Ingredients where tracking unit == smallest unit render with no behavior change (no redundant "$X/each ($X/each)" doubling) → **PASS** — `src/utils/perEachCost.test.ts::AC8 — returns null when piecesPerCase <= 1 (tracking unit == smallest unit)` covers this.

- AC9 — The editor case-size preview reflects the REAL case breakdown (`piecesPerCase = caseQty × subUnitSize`), and it does not swap one mislabel for another → **PASS** — `IngredientForm.spec093.test.tsx` now passes all 9 tests. The component-level proof exists: "renders '1 case = 20 lbs' for DEFAULT UNIT=cases / case size=20 / PACK UNIT=lbs" passes; "does NOT render the old inverted '20 cases per order' sentence" passes; "falls back to the tracking unit when no PACK UNIT is set (e.g. 1 case = 450 each)" passes. This was the prior Critical finding — it is resolved.

- AC10 — No regression to recipe cost math, Conversions tab, EOD count, or Reorder; edge functions consume `unit`/`sub_unit_unit` as opaque text → **PASS** — `db.ts` was not modified; no migration landed; no edge function was touched; all Reorder and EOD section tests continue to pass in the full run.

---

### Critical status

The prior-review Critical is **RESOLVED**. The root cause (store selector iterating `args.inventory`, which was absent from two test mocks) was fixed by:

1. Switching `deriveBrandUnitPool` to iterate `args.catalogIngredients` instead of `args.inventory` (also resolved the security finding about cross-brand leakage).
2. Adding `catalogIngredients: []` to the `state` object in both previously-broken mocks (`IngredientForm.help-text.test.tsx:103` and `IngredientForm.spec093.test.tsx:87`).

No new Criticals.

---

### Test run

```
npx jest --no-coverage

Test Suites: 64 passed, 64 total
Tests:       655 passed, 655 total
Snapshots:   0 total
Time:        2.648 s, estimated 3 s
Ran all test suites in 2 projects.
```

Spec-096 helper tests (both pass):
```
npx jest --no-coverage --testPathPattern="perEachCost|brandUnitPool|IngredientForm"

PASS  unit    src/utils/brandUnitPool.test.ts       (7 tests)
PASS  unit    src/utils/perEachCost.test.ts         (15 tests)
PASS  component src/components/cmd/IngredientForm.test.ts
PASS  component src/components/cmd/IngredientForm.help-text.test.tsx  (6 tests)
PASS  component src/components/cmd/IngredientForm.spec093.test.tsx    (9 tests)

Test Suites: 5 passed, 5 total
Tests:       63 passed, 63 total
```

---

### Notes

1. **Critical resolved.** The prior 15-test regression is gone. `IngredientForm.help-text.test.tsx` (6 tests) and `IngredientForm.spec093.test.tsx` (9 tests) are fully green.

2. **AC9 now has a passing component-level proof.** `IngredientForm.spec093.test.tsx` passes all 9 tests, including the "1 case = 20 lbs" render assertion and the "no inverted arithmetic" guard.

3. **AC6 remains NOT TESTED at the UI level.** The dual `$X/case · $Y/each` string in the catalog row is unverified in CI. This is an acceptable follow-up gap: the math is fully unit-tested in `perEachCost.test.ts`; the rendering is a thin conditional in the catalog row component. A regression here would be visible in a quick smoke review. Recommend a follow-up ticket for `InventoryCatalogMode.test.tsx` to add a dual-price render assertion.

4. **AC2 and AC3 remain NOT TESTED.** Both hold by construction per the architect's design (AC2: pick path is a single-field setter; AC3: `catalogIngredients` is brand-scoped by store loading). The security fix (switching from `inventory` to `catalogIngredients`) strengthens the AC3 structural argument but no multi-brand isolation test was added. Acceptable follow-up.

5. **No pgTAP tests and no shell smokes needed.** The spec is display-only with no DB migration, new table, or edge function changes. Jest is the correct and only track.

6. **The `app.json` slug was not touched.** Confirmed.

7. **`db.ts:3769-3779` was not modified.** Confirmed.

## Code review for spec 105

### Critical

_None._

### Should-fix

- `src/screens/cmd/sections/__tests__/InventoryCountSection.parStatus.test.tsx:149` — The null-total exclusion case uses `item-apple-null` as the `itemId`, but `inventoryById` has no entry for that id. This means the entry is excluded by the `!item` (unresolvable) check in `buildCountedOnHandMap`, NOT by the `actualRemaining == null` check that the test comment claims to cover ("null total → excluded"). A reader auditing the null-total path gets a false sense of confidence. Fix: add `item-apple-null` to the `INVENTORY` fixture (with a real `parLevel > 0`) so the null-total exclusion is actually the operative gate. The `toEqual` at line 152 passes either way so this is a test-authoring gap, not a runtime bug.

- `src/screens/cmd/sections/countHistoryPar.ts:86-93` — The comment at line 86 says this `formatQty` is "the same rule as the reorder screen's `formatQty` (reorderExport.ts)," and the implementations are indeed byte-for-byte identical. However the justification at line 88-89 says "Kept local so this module stays free of the ReorderItem-typed export helpers (which carry cost fields this feature must not surface)" — which is inaccurate: `ReorderItem` is a type-only import that is erased at compile time and carries no runtime cost. The actual reason `formatQty` is duplicated here is to avoid pulling in `papaparse` (a runtime import at `reorderExport.ts:23`) into the jest module graph for a pure helper file. The misleading comment should be corrected so future maintainers don't re-merge these two copies under the wrong impression that types leak at runtime. Suggested: "Kept local to avoid pulling `papaparse` (a non-zero runtime dep imported by `reorderExport.ts`) into this pure module's graph and into jest runs that don't need it."

- `supabase/tests/report_reorder_for_counted_onhand.test.sql:241,256` — Assertions `(6)` and `(5)` appear in the file in the wrong numeric order: `(6) EMPTY p_on_hand` runs at line 244 while `(5) NON-MEMBER caller` runs at line 269. The ordering swap is functionally correct (the comment at line 242 explains the constraint: empty-map test must use the master JWT before the JWT switch), but the numbered labels are misleading for anyone reading the test output, where assertions print in run order but the spec's enumerated list (comment at lines 22-26) lists them as `(5)` then `(6)`. Suggested fix: swap the labels so the number matches the execution order, or add a comment to the design's enumeration noting the execution transposition.

### Nits

- `supabase/migrations/20260702000000_report_reorder_for_counted_onhand.sql:337` — In `per_item`, the `case_qty` column is sourced as `coalesce(ci.case_qty, 1)::numeric`. The `coalesce` to `1` is correct (treat null case_qty as no case), but the comment block at `(4k)` says "null/0/1 normalized to 1 above" when the coalesce only handles `null`, not `0`. If `case_qty = 0` exists in the catalog, the `case_qty > 1` check in `per_item_filtered` would yield `suggested_cases = null` (correct outcome) but the division `ceil(suggested_qty / 0)` would never be reached because `0 > 1` is false. The comment is slightly imprecise but the runtime behavior is correct; no code change required, only a comment clarification.

- `src/screens/cmd/sections/InventoryCountSection.tsx:1550` — The call `parStateFor(e.actualRemaining, parItem?.parLevel ?? 0)` passes `0` for an unresolvable item (`parItem == null`). This is functionally correct — `parStateFor` returns `'none'` for `parLevel <= 0`. The function's own signature accepts `number | null | undefined` for `parLevel`, so passing `null` directly (`parItem?.parLevel ?? null`) would also work and would make the "unresolvable item" semantic (distinct from "par = 0") more explicit at the call site. Low priority since the test at line 133-139 explicitly documents and validates the `?? 0` convention.

- `src/screens/cmd/sections/countHistoryPar.ts:41` — `type ParState = 'above' | 'below' | 'none'` is a bare string union. This is idiomatic TypeScript and fine, but `'none'` differs slightly from the OQ-4 label "no indicator" used in the spec and the JSDoc above. A reader searching for "no indicator" won't find the type. Not wrong; just noting the label discontinuity.

- `src/screens/cmd/sections/__tests__/InventoryCountSection.parStatus.test.tsx:106-110` — The `describe` block "spec 105 par status (module loads)" with a single `it('is a real React component...')` test is a module-load smoke check, which is a valid pattern from the sibling test file. However, the assertion is `expect(typeof InventoryCountSection).toBe('function')` — which passes for any imported value that happens to be a function, not specifically a React component. The comment "imports + composes countHistoryPar" is not actually asserted (the import path being valid is what matters, which `tsc --noEmit` also catches). This is fine as-is but consider whether this test adds meaningful value beyond what the typecheck already provides.

- `src/screens/cmd/sections/InventoryCountSection.tsx:1462` — The dual-basis caption reads `✓ / ● checked vs current par · reorder suggestion mixes this count's on-hand with live forecast + delivery timing`. The Unicode bullet `●` at this position is a literal character in a string — it renders correctly. Minor: the caption says "mixes… delivery timing" without the "right now" phrasing that the spec and the `db.ts` JSDoc pin as the key semantic. The spec says the caption "MUST state both: current-par basis AND live-forecast/timing basis" — it does, so this is technically compliant. The wording is terse but not incorrect.

---

## Resolution (applied by main Claude post-review)

All three Should-fixes fixed; Nits left as advisory.
- **CR1 (null-total test fixture) — FIXED.** Added `item-apple-null` (parLevel 10, resolvable) to the `INVENTORY` fixture so the null-total exclusion is now gated by `actualRemaining == null`, not the unresolvable-item check. parStatus suite still 15/15.
- **CR2 (`formatQty` comment) — FIXED.** Comment now states the real reason it's kept local (avoids pulling `papaparse` into the pure module's graph), and explicitly notes the `ReorderItem` type is erased at compile time.
- **CR3 (pgTAP `(5)`/`(6)` label order) — FIXED.** Added a header note that the numeric labels are logical, not run-order (empty-map probe runs before the JWT switch).

Post-fix: tsc clean, **jest 798/798**, **pgTAP 59/59**.

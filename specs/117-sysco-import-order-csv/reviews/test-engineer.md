## Test report for spec 117 (SYSCO "Import Order" file export)

Scope reviewed (staged, uncommitted): `src/utils/syscoImport.ts` + `.test.ts`
(new), `src/utils/vendorImportShared.ts` (new), `src/utils/usFoodsImport.ts`
(refactored onto the shared module), `src/screens/cmd/sections/ReorderSection.tsx`
(SYSCO branch + shared `emitImportPlan`), `src/lib/db.ts`, `src/types/index.ts`,
`src/components/cmd/VendorFormDrawer.tsx`, `src/i18n/{en,es,zh-CN}.json`.
No migration in this changeset (reuses spec 116's `vendors` columns) — pgTAP
and shell-smoke tracks are **not applicable** to this spec; both remain
jest-only.

### Acceptance criteria status

1. New `order_import_format = 'sysco'` recognized end-to-end (db map, type,
   Vendors form option, reorder branch). No migration. →
   **NOT TESTED (Critical — repeat of an unresolved spec-116 gap)**.
   - Type union (`'' | 'us_foods' | 'sysco'`) is enforced at compile time only
     — `npm run typecheck` / `typecheck:test` both clean, so a caller
     assigning an invalid literal fails the build. That part is a real,
     if indirect, signal.
   - `db.ts` `fetchVendors`'s `order_import_format` ternary (`db.ts:1807-1810`)
     is correct by code inspection only; there is still no `fetchVendors` test
     file anywhere in the repo (pre-existing gap, already flagged in spec
     116's report, unresolved).
   - `VendorFormDrawer`'s new `'sysco'` `SegmentField` option and the
     format-conditional reveal (`VendorFormDrawer.tsx:380-406`) has **zero**
     coverage: grepped `VendorFormDrawer.test.tsx` for
     `sysco|us_foods|orderImportFormat|importFormat` — no hits. This is the
     exact same gap spec 116's test-engineer report flagged for `'us_foods'`
     (item 2 in that report) — it was never closed, and this spec adds a
     second untested option to the same untested control.
   - `ReorderSection.tsx`'s `onCsvPress` branch — now `v.orderImportFormat ===
     'us_foods' || v.orderImportFormat === 'sysco'` (`ReorderSection.tsx:1050`)
     dispatching to `handleImportExport` — has **zero** RTL coverage. Grepped
     `ReorderSection.test.tsx` and `ReorderSectionCases.test.tsx` for
     `sysco|onCsvPress|planUsFoodsExport|handleImportExport|orderImportFormat|
     CSV|triggerDownload` — zero hits in both files. In fact `ReorderSection.
     test.tsx`'s existing suite never exercises the CSV button AT ALL, not
     even the pre-existing generic-CSV path.
   - This is a verbatim repeat of spec 116's test-engineer Critical finding
     (its item 12/13), which the spec-116 release-coordinator proposal marked
     **must-fix before commit** ("Cover the `onCsvPress` US-Foods branch...a
     second test with two displayed vendors covers Risk 1"). Checking the
     commit that shipped it (`d66d6d2`): `ReorderSection.test.tsx` was not
     touched by that commit or any commit since — the must-fix was not
     actually done. Spec 117 now doubles the untested branch surface (two
     formats instead of one) without adding any of the recommended coverage.

2. `buildSyscoImportCsv` emits one `H` record (customer # + order datetime +
   literal `N`; other fields blank), the `F` field row byte-for-byte, and one
   `P` row per ordered SYSCO item. → **PASS** —
   `syscoImport.test.ts::'emits H + F records with the SYSCO field names and
   the store customer #'` asserts the exact `F,SUPC,"Case Qty",...` string and
   the H row's customer-number position + quoted datetime + 2-line
   header-only length; `'writes a P row...'` and `'skips items with no SUPC
   and counts them...'` (3-item payload) confirm P rows are emitted per
   ordered item.

3. `P` row: `SUPC` = order_code; `Case Qty` = whole cases; `Split Qty` =
   loose units (no-case → Split Qty); Description/Pack Size/prices populated;
   Brand/Mfr # blank. → **PARTIAL PASS**. The risk-bearing fields (the ones an
   upload actually depends on) are directly asserted: SUPC (`p[1]`), Case Qty
   (`p[2]`), Split Qty (`p[3]`) for both the case-item and no-case-item shapes
   (`'writes a P row...'`, `'a no-case item goes to Split Qty...'`), and
   Description is asserted present + quoted. **Not directly asserted by any
   test:** Pack/Size value, Case $/Each $ values, or that Brand/Mfr # render
   as empty strings — these are the spec's own "informational only, owner
   choice" fields (R2), so I weigh this as a coverage gap, not a functional
   risk; recommend one additional assertion (index positions 5,6,8,10,11) in
   the existing `'writes a P row'` test to close it cheaply, mirroring how
   thin `usFoodsImport.test.ts`'s equivalent PACK SIZE/CS PRICE/EA PRICE
   coverage already is (same gap exists on the US Foods sibling, so this is
   parity, not a regression).

4. Only below-par items (qty > 0) WITH an order code are written; codeless
   items skipped and counted; have-enough items excluded; header-only file
   when nothing is ordered. → **PASS** —
   `syscoImport.test.ts::'skips items with no SUPC and counts them; excludes
   have-enough rows'` (3-item mix: coded case item, uncoded plain item,
   `needsOrder:false` stocked item → `included:1`, `skippedNoCode:1`) and the
   first test's `lines.toHaveLength(2)` for an empty order.

5. Leading-zero SUPCs preserved (text); formula injection neutralized on
   order code + description (+ header) via the shared `csvSafe`. →
   **PASS (direct + transitive)**. `syscoImport.test.ts::'preserves a
   leading-zero SUPC and neutralizes formula injection'` directly covers the
   leading-zero SUPC and a leading-`=` item NAME. The order-code/SUPC
   injection path itself (`csvSafe(code)`, `syscoImport.ts:116`) is not
   separately exercised with an evil *code* in this file, but it runs through
   the identical shared `csvSafe` that `usFoodsImport.test.ts::'neutralizes
   CSV/spreadsheet formula injection in the product number + description'`
   DOES exercise with an evil product-number value (`'=HYPERLINK(...)'`) — so
   the shared guard is proven against both sink shapes across the two test
   files. Header-field injection (customer number) is untested in either
   file — low risk (customer numbers are admin-entered in the Vendors form,
   not staff-writable), noted for completeness only.

6. Custom serializer quotes text-with-spaces (matching SYSCO's export style);
   codes/numbers unquoted; rows joined with CRLF. → **PASS with a known
   edge-case gap**. The exact quoted `F` row, the quoted `"Rice Parboiled
   Perfect"` description, the unquoted numeric/code fields, and the CRLF join
   (`csv.split('\r\n')`) are all directly asserted. **Gap:** no test exercises
   embedded-quote doubling (`""`) or the lone-`\r` RFC-4180 edge case that
   security-auditor flagged as Should-fix (`syscoRow`'s trigger regex
   `/[",\n ]/` omits bare `\r`). Bounded impact per security-auditor's own
   read (a comma anywhere in the value already forces quoting, so no
   attacker-controlled numeric/quantity field can be forged this way) — I
   agree with that severity call and do not treat it as blocking on its own,
   but flag it as an uncovered edge case tied to a filed Should-fix; a
   regression test should land in the same commit as that fix.

7. Per-store CUSTOMER NUMBER: `importCustomerNumbers[storeId]` →
   `account_number` fallback; a missing number surfaced (not silent). →
   **PASS** — `planSyscoExport` tests cover the override-wins-over-fallback
   case, the `account_number`-only fallback, and the `customerNumberMissing:
   true` flag when neither is set.

8. `onCsvPress` emits US Foods OR SYSCO file per the displayed vendor's
   format, else the generic CSV; other vendors cued in the toast (shared
   emitter). → **NOT TESTED (Critical — same wiring surface as AC1)**. The
   `otherVendorCount` VALUE is unit-tested at the pure-function layer in both
   `planSyscoExport` and `planUsFoodsExport` tests (e.g.
   `syscoImport.test.ts`'s `plan.otherVendorCount).toBe(1)`), so the counting
   arithmetic is verified. What is **not** verified at any layer: that
   `onCsvPress` actually picks `handleImportExport` over the generic CSV path
   for a `'sysco'`-tagged vendor, that it picks `planSyscoExport` specifically
   (not `planUsFoodsExport`) when the format is `'sysco'`, that
   `emitImportPlan`'s `Toast.show` call fires with the composed message, or
   that the generic-CSV fallback still fires when no displayed vendor has
   either format set. This is glue code across three store slices
   (`vendorsList`, `inventory`, `exportPayload`) — the same class of
   "new state silently not wired through" bug this codebase has hit
   repeatedly on `db.ts` (`deliveryDays`/`categories`/`accountNumber`), now
   doubled to two format branches with zero coverage on the branch selection
   itself.

9. Shared `vendorImportShared.ts` (`csvSafe`/`isOrdered`/`orderQuantities`) is
   the single source of truth for both vendor builders; US Foods refactored
   onto it with identical behavior (its tests unchanged/green). → **PASS**,
   with one Should-fix note. `npx jest usFoodsImport` is 11/11 green (up from
   the 6 in spec 116's original report — the extra 5 are the formula-
   injection test and the 4 `planUsFoodsExport` tests added to close that
   spec's own must-fix items; none were removed or weakened by the refactor).
   `vendorImportShared.ts` itself has **no direct test file** — `csvSafe`,
   `isOrdered`, and `orderQuantities` are each exercised only transitively,
   via both `usFoodsImport.test.ts` and `syscoImport.test.ts` hitting the
   same code paths (leading-`=` injection, needs-order/have-enough exclusion,
   case vs. no-case quantity split). I assessed this transitive coverage as
   **not thin** — every exported function's both branches are hit by at least
   one of the two call-site test files — but recommend a direct
   `vendorImportShared.test.ts` going forward: it is now the single source of
   truth for a THIRD vendor format that will land someday, and a future
   change to (e.g.) `isOrdered`'s cases-vs-suggestedQty branch could pass both
   builders' current fixtures by coincidence while breaking an untested edge
   (e.g. `suggestedCases: 0` with `suggestedQty > 0`). Should-fix, not
   blocking — code-reviewer independently flagged the DRY concern (three
   near-identical plan-shape interfaces, two near-identical planner bodies)
   from the maintainability angle; a shared test file would sit naturally
   alongside a shared `planVendorImportExport` if that refactor lands.

### Test run

```
npx jest syscoImport usFoodsImport vendorImport
PASS unit src/utils/usFoodsImport.test.ts
PASS unit src/utils/syscoImport.test.ts
Test Suites: 2 passed, 2 total
Tests:       18 passed, 18 total   (7 sysco + 11 usFoods)
Time:        0.155s

npx jest usFoodsImport --verbose
Test Suites: 1 passed, 1 total
Tests:       11 passed, 11 total   (confirms the US Foods refactor onto
                                     vendorImportShared didn't regress any
                                     prior test)

npx jest   (full suite)
Test Suites: 100 passed, 100 total
Tests:       1154 passed, 1154 total
Time:        3.486s
(Some pre-existing `act(...)` console warnings from an unrelated staff
EODCount test — not new, not related to this feature.)

npm run typecheck            → clean, no errors
npm run typecheck:test       → clean, no errors
```

pgTAP (`npm run test:db`) and shell smokes (`npm run test:smoke`) were not run
for this spec — no migration, no RLS change, no edge function / RPC surface
touched (confirmed via diff: `supabase/` directory has zero changes in this
changeset). Both tracks are N/A here, not skipped-with-a-gap.

### Notes

**Critical — the branch-selection wiring (AC1's Vendors-form-option + reorder-
branch clause, and AC8) is genuinely uncovered across every applicable track,
and this is not a new gap — it is spec 116's already-identified, already-
must-fix-flagged Critical finding, left unresolved when 116 shipped, now
doubled in surface area by this spec.** Concretely missing:

- A `VendorFormDrawer.test.tsx` test selecting `'sysco'` in the segmented
  control and asserting the per-store customer-number inputs reveal (mirror
  the existing `orderUnit` `SegmentField` test pattern already in the same
  file, lines ~64-110).
- A `ReorderSection.test.tsx` test mocking `useStore`/`exportPayload` with a
  `'sysco'`-tagged displayed vendor, pressing the CSV button, and asserting
  (a) the filename matches `SYSCO_Order_<slug>_<date>.csv`, (b) `triggerDownload`
  was called (not the generic CSV path), (c) the toast text reflects
  `included`/`skippedNoCode`/`otherVendorCount`/`customerNumberMissing`. A
  second test with a `'us_foods'`-tagged vendor pins the sibling branch. A
  third test with neither format set confirms the generic-CSV fallback still
  fires (regression guard for the `||` condition itself). None of
  `handleImportExport`/`emitImportPlan`/`triggerDownload` are currently
  exported from `ReorderSection.tsx`, so closing this either needs a
  `jest.spyOn(document, 'createElement')`/Blob-URL style test driven through
  the rendered button (matching how DOM-download tests are done elsewhere in
  this codebase) or exporting the three helpers for direct unit test — a
  design choice for the developer, not mine to make here.

I am marking AC1 and AC8 **NOT TESTED** per my mandate (any unverified AC is a
Critical finding for the release-coordinator's purposes), and note for the
record that this is the second consecutive spec on this same feature family
to ship this exact gap unaddressed despite a prior release-coordinator
proposal explicitly listing it as must-fix. I'd flag to the user that either
(a) the fix needs to land before this ships, or (b) if the team is
deliberately accepting this risk again, that should be an explicit decision
recorded in the spec rather than a second silent no-op of a "must-fix."

**Should-fix (non-blocking, in priority order):**
1. `vendorImportShared.ts` has no direct test file (item 9 above).
2. AC3's Pack/Size, Case $/Each $, Brand/Mfr#-blank fields have no direct
   assertion (parity gap with the US Foods sibling, not a regression).
3. AC6's lone-`\r` / embedded-quote-doubling edge case is untested — should
   land as a regression test alongside security-auditor's filed Should-fix
   fix to the `syscoRow` trigger regex.
4. `db.ts fetchVendors` and `VendorFormDrawer`'s new-field mapping have no
   direct jest coverage — pre-existing gap for the whole function/component,
   not unique to this spec, carried over verbatim from spec 116's report.

### Framework note

No new test framework introduced or needed. All recommendations above stay
within the existing jest track (`syscoImport.test.ts`, a new
`vendorImportShared.test.ts`, `VendorFormDrawer.test.tsx`,
`ReorderSection.test.tsx`). pgTAP and shell-smoke tracks are not applicable to
this spec (no DB/edge-function surface).

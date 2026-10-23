## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical, Should-fix, High or Medium. AC-1 to AC-21 pass in jest, the AC-23 browser check passed, and the latest `main` CI runs after spec 172 (f7b2759) were green. This verdict depends on main Claude's AC-22 re-run (full `npx jest --ci`, `npm run typecheck`, `npm run typecheck:test`) passing before staging.

## Findings summary
- **code-reviewer:** 0 Critical, 0 Should-fix, 6 Nits. All nits are non-blocking.
  - `reorderExportStaff.ts:159-169`: the have-enough `itemLine` is now a ternary nested three levels deep. It could be collapsed or turned into a helper.
  - `PhoneOrdering.tsx:430-448`: the pill style values are hand-copied from the private desktop `FlagChip` (design N5). This creates a drift risk. A mirror comment on the `FlagChip` side was suggested.
  - The test fixtures (`row` / `vendor` / `payloadOf`) are copy-pasted across three spec 174 test files. A shared `__fixtures__` helper would be a follow-up.
  - Minor doc-comment wording in `eodNoNeed.ts:29`.
  - **Staging hygiene:** the three `.snap` files and four of the five new test files are untracked. They are the byte-identity proof for AC-4/7/9/10/12, so they must be staged with the sources.
  - It noted that AC-23 was still pending at review time. That check has since been closed by browser-check.md.
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 1 Low.
  - The Low is pre-existing and was not introduced by this spec. `buildStaffReorderCsv` (`reorderExportStaff.ts:101`) calls `Papa.unparse` directly instead of `unparseCsvSafe`. As a result, the vendor, item and unit cells in the staff CSV are not formula-neutralized. Only an admin could plant a formula there. The new NO NEED cell is not exploitable.
  - Both PDF-HTML builders escape the label. The admin CSV label goes through `csvSafeCell`. jsPDF and the RN `<Text>` tag are not injection sinks.
  - Nothing new is exposed: the stale `onHand` is replaced by a label, and the `no_need` token was already in Flags.
  - There is no DB, RLS, edge-function or dependency change.
- **test-engineer:** AC-1 to AC-21 PASS (21/21). 0 FAIL, 0 untested.
  - Targeted run: 52 suites, 574 tests and 15 snapshots passed under `--ci`.
  - Existing `reorderExport.test.ts`, `reorderExportStaff.test.ts`, `PhoneApproveOrder.tsx` and `src/i18n` are byte-untouched.
  - AC-22 is left to main Claude. The frontend-developer reported 262/262 suites, 3280/3280 tests, and both typechecks at exit 0.
  - **Caveat:** test-engineer could not independently confirm that the snapshots were captured before the source edit. It did confirm that they pass `--ci`, and that every source edit is a ternary whose `else` arm is the original expression unchanged.
  - Coverage gaps: jsPDF is mocked in jest, and the es "NO HACE FALTA" column width is not checked. Both are cosmetic.
- **browser-check (AC-23, main Claude):** PASS.
  - **Phone (390x844):** the NO NEED tag renders under the item name and is the only tagged line. The name stays on one line, the stepper and cost are unchanged, and there is no horizontal overflow (`scrollWidth` = 390).
  - **CSV export:** the On Hand cell reads `NO NEED`. The French Fries row keeps its `2`.
  - **jsPDF:** en `NO NEED`, es `NO HACE FALTA`, zh-CN `NO NEED` (English, per AC-6).
  - **Seed data:** removed afterwards.
  - **Deviations from the AC-23 script, none blocking:**
    - The edit was applied with `setReorderEditQty` from the console, which is the same store action the `+` stepper calls, rather than a physical tap.
    - The PDF was exercised by calling `handlePdfExport` in the page. That is the same function the overflow PDF button calls.
    - The check does not mention the console-errors item, so that part of AC-23 is unconfirmed.
- **backend-architect:** not invoked post-implementation. The change is client-only, with no migration, RPC, `db.ts`, `useStore.ts` or catalog change, so there is no contract to check for drift.

## Recommended next steps (ordered)
1. **Re-run the AC-22 gates before staging:** full `npx jest --ci` (not a subset, per project memory), `npm run typecheck`, and `npm run typecheck:test`. If any of them fails, this verdict becomes FIXES_NEEDED.
2. **Stage only spec 174 paths. Do not run `git add -A`.** Spec 173's staged files (`src/lib/db.ts`, `src/lib/db.eodCountMode.test.ts`, `src/store/useStore.updateItem.catalogRevert.spec173.test.ts`, `specs/173-*`, and the others) share the index.
   - **Sources:**
     - `src/lib/eodNoNeed.ts`
     - `src/screens/staff/lib/eodNoNeed.ts`
     - `src/utils/reorderExport.ts`
     - `src/screens/staff/lib/reorderExportStaff.ts`
     - `src/screens/cmd/sections/ReorderSection.tsx`
     - `src/screens/cmd/sections/phone/PhoneOrdering.tsx`
   - **Tests:** the five `*.spec174.test.ts(x)` files.
   - **Snapshots:** all three `.snap` files. These are the byte-identity pins and must not be left behind:
     - `src/utils/__snapshots__/reorderExport.noNeed.spec174.test.ts.snap`
     - `src/screens/staff/lib/__snapshots__/reorderExportStaff.noNeed.spec174.test.ts.snap`
     - `src/screens/cmd/sections/__tests__/__snapshots__/ReorderSection.pdfNoNeed.spec174.test.tsx.snap`
   - **Spec files:** `specs/174-reorder-no-need-display.md` and `specs/174-reorder-no-need-display/`.
   - Check that each `__snapshots__/` directory holds only spec 174 `.snap` files before staging the directory as a whole.
3. **Commit, once the user confirms (no auto-commit), then deploy.** This is a Vercel web build only, with no migration.
4. **After the push, check the gates:** confirm the latest `main` runs of `test.yml` and `db-migrations-applied.yml` are green. Also check `e2e.yml` manually (project memory: not yet promoted to the gate checklist).
5. **Optional follow-ups (not blocking):**
   - Send the staff CSV through `unparseCsvSafe` (security Low, pre-existing). It is a one-line change at `reorderExportStaff.ts:101` and keeps normal data byte-identical.
   - Add a mirror comment on the desktop `FlagChip` that points to the phone pill copy, so style drift can be found from both sides.
   - Flatten the staff have-enough `itemLine` ternary into a small named helper.
   - Pull the copy-pasted spec 174 test fixtures into a shared `__fixtures__` helper.
   - Move the three spec 172 sites that still inline `flags.includes(REORDER_FLAG_NO_NEED)` onto `isReorderNoNeed`: `BreakdownLine`, staff `Reorder.tsx` and `lastOrderContext.ts` (design §11).
   - Add a staff-export `reorderExport.noNeed` key, only if the owner wants sentence case ("No need") in staff exports to match the staff screen. This is the accepted tradeoff in design §6 N2.
   - Optionally, a quick visual check of the es jsPDF On Hand column width with "NO HACE FALTA".

## Out of scope for this review
- **The staff CSV skips the formula-injection guard** (`Papa.unparse` without `csvSafeCell`). This was already the case before spec 174. The same class of issue was raised in spec 139's audit of `countExport.ts`. It belongs in a small CSV-hardening spec, or in the optional follow-up above.
- **A full store reload nulls `reorderPayload`** (`useStore.ts` ~L2136). Any reload does this, including the realtime echo after an export records its draft PO. Phone Ordering then shows "No reorder suggestions" until you navigate away and back. This was found during the AC-23 browser check and has nothing to do with spec 174. It deserves its own bug spec.
- **The admin jsPDF has no CJK-capable engine,** so zh-CN prints English. This is the pre-existing 2026-07 follow-up.
- **`buildReorderPdfHtml` has no `locale` parameter.** It is English-only and has no live caller.
- **Spec 173's staged files** (`catalog-update-error-surfacing`) belong to a separate session and were not reviewed here.

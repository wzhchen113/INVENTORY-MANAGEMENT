## Test report for spec 201

### Acceptance criteria status
pgTAP (supabase/tests/):
- AC-1 coincident, primary wins -> PASS: report_reorder_list_primary_wins.test.sql
- AC-2 hint on primary (yielded_from_vendors) -> PASS: report_reorder_list_primary_wins.test.sql
- AC-3 rollups coherent -> PASS: report_reorder_list_primary_wins.test.sql
- AC-4 vendor left empty -> PASS: report_reorder_list_primary_wins.test.sql (G modelled by deleting its only link; equivalent for the RPC)
- AC-5 include_stocked -> PASS: report_reorder_list_primary_wins.test.sql
- AC-6 not coincident -> PASS: report_reorder_list_primary_wins.test.sql; also report_reorder_list_multi_vendor.test.sql (rewritten, 11/11)
- AC-7 three vendors -> PASS: report_reorder_list_primary_wins.test.sql
- AC-8 no primary in set / no primary -> PASS: report_reorder_list_primary_wins.test.sql
- AC-9 no-schedule vendor (+C3) -> PASS: report_reorder_list_primary_wins.test.sql
- AC-10 primary EOD not submitted -> PASS: report_reorder_list_primary_wins.test.sql
- AC-11 day-name case -> PASS: report_reorder_list_primary_wins.test.sql
- AC-12 primary source (vendor_id vs is_primary, dangling, null) -> PASS: report_reorder_list_primary_wins.test.sql
- AC-13 borrowed into submitted vendor -> PASS: report_reorder_list_borrowed_count.test.sql
- AC-14 borrowed into primary -> PASS: report_reorder_list_borrowed_count.test.sql
- AC-15 latest wins (+15b id tiebreak) -> PASS: report_reorder_list_borrowed_count.test.sql
- AC-16 own wins -> PASS: report_reorder_list_borrowed_count.test.sql
- AC-17 not a source (draft, D-1, other store, NO NEED per C1) -> PASS: report_reorder_list_borrowed_count.test.sql (other-store arm uses session_replication_role=replica, rolled back)
- AC-18 vendor never submitted (R10) -> PASS: report_reorder_list_borrowed_count.test.sql
- AC-19 NO NEED still overrides -> PASS: report_reorder_list_borrowed_count.test.sql
- AC-20 posture/regressions -> PASS: posture arms in primary_wins; full pgTAP 111/111 incl. reports_anon_revoke, eod_no_need, po_loop, all report_reorder_list_* suites
- Switch RPC (design section 5, backs AC-25/26 server side) -> PASS: set_item_primary_vendor.test.sql (30 arms)

jest:
- AC-21 admin card -> PASS: src/screens/cmd/sections/__tests__/ReorderSection.primaryWins.spec201.test.tsx
- AC-22 phone -> PASS: src/screens/cmd/sections/phone/__tests__/PhoneOrdering.primaryWins.spec201.test.tsx
- AC-23 staff + i18n parity -> PASS: src/screens/staff/screens/Reorder.primaryWins.spec201.test.tsx (staff i18n.test.ts also green in full run)
- AC-24 order paths take no F line for B -> PASS: src/store/useStore.orderPaths.primaryWins.spec201.test.ts
- AC-25 switch happy path / cancel -> PASS: src/store/useStore.switchItemPrimaryVendor.spec201.test.ts (+ component half in ReorderSection.primaryWins test)
- AC-26 switch refused (3c) -> PASS: same two files
- AC-27 switch failure revert + notifyBackendError -> PASS: useStore.switchItemPrimaryVendor.spec201.test.ts
- mapper (yielded_from_vendors, absent -> []) -> PASS: src/lib/db.reorderYieldedFrom.spec201.test.ts
- AC-28 gates -> PASS for jest, typecheck:test, pgTAP; PARTIAL for e2e/staff-reorder.spec.ts: NOT RUN (see Notes). Base typecheck: only environmental TS2688.

### Test run
- `bash scripts/test-db.sh` (local stack up): 111/111 DB test files passed. New: primary_wins 60, borrowed_count 41, set_item_primary_vendor 30, multi_vendor 11.
- `npx jest`: 315/315 suites, 4014/4014 tests, 17 snapshots passed.
- `npm run typecheck:test`: exit 0, no errors.
- `npm run typecheck`: fails only with TS2688 on Finder-duplicate `node_modules/@types/* 2` folders (known machine issue, not fixed). `npx tsc --noEmit` filtered for non-TS2688 errors: none.
- No failures; nothing attributable to spec 200's in-progress staff work.

### Notes
- Gap: `e2e/staff-reorder.spec.ts` was not run by me or by the frontend developer (needs e2e global setup and port 8081). The AC-28 clause "e2e stays green" is unverified. Recommend the owner runs it, or release-coordinator treats it as a manual check.
- Judgement calls for review (not test failures): PhoneApproveOrder shows the yielded line text-only (no switch); staff wording is "also from X - order it here".
- Observation from frontend notes: after F leaves a vendor's card, that vendor's badge can flip to STOCK FALLBACK if F was its only submitted item (R10-consistent, rare).
- I verified results by running the suites; I did not re-run the developers' mutation check against the baseline body.
- Prod apply of both migrations is still pending (owner); must precede spec 200's client.

Totals: all ACs PASS except the e2e clause of AC-28 (NOT RUN).

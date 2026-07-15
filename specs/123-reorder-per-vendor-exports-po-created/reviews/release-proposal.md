# Release proposal — spec 123 (Reorder per-vendor CSV/PDF exports + persistent "PO CREATED")

## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical; the one CI-blocker (a red `typecheck:test`) and the two blocking-adjacent code-review Should-fixes were already fixed, leaving only informational nits.

## Findings summary
- code-reviewer: 0 Critical, 3 Should-fix, 4 Nits. Should-fix #1 (per-vendor CSV/PDF filename collision — two vendor cards on same store+date wrote identical filenames) FIXED: filenames now embed the vendor name when the payload is a single vendor. Should-fix #2 (dead `exportPayload` memo used only for a truthiness check) FIXED: `showExport` now gates on `!!reorderPayload`. Should-fix #3 (unreachable "other vendors omitted" toast note — `otherVendorCount` is always 0 now that per-vendor always narrows to one vendor) assessed as benign dead-ish code, non-blocking; left as-is to avoid touching import-plan logic. Nits (hardcoded English `accessibilityLabel` on export buttons matching pre-existing REFRESH-button pattern; narrow-call hoist; missing direct `mapReorderVendor` unit test) are informational.
- security-auditor: 0 findings across Critical/High/Medium/Low. Confirmed `report_reorder_list` is a verbatim CREATE OR REPLACE of the live body plus one additive `has_po` EXISTS key; the EXISTS is keyed only on server-resolved values (no client-injectable probe of other stores/vendors); SECURITY INVOKER + `search_path` + auth gate all preserved; `referenceDate` threading is a PostgREST-bound column (no SQLi); no new grant/table/RLS/publication; no `package.json` change.
- test-engineer: All 13 acceptance criteria PASS, including both brief-flagged HIGH-RISK ACs — date-keying correctness (AC10, pgTAP cases C/E pin the date boundary) and hard duplicate-prevention (AC12, "PO CREATED" is a non-pressable `View` with no `onPress`, jest asserts `createPoDraft` never fires on press). Coverage gaps are non-blocking: AC5 (import-vendor scoping) not driven end-to-end through the per-vendor button but the underlying `pickImportVendor`/`handleImportExport` is pinned by pre-existing suites; AC11 (`referenceDate` threading) verified by code + pgTAP fixture, no dedicated jest assertion — recommended follow-up. Blocking finding: `npm run typecheck:test` (CI "Track 1a") failed with 8 `TS2741`/`TS2322` errors because `ReorderVendor.hasPo` was required. RESOLVED by main Claude — changed to `hasPo?: boolean` (read everywhere via `?? false`); `typecheck:test` passes, base tsc clean, full jest 1213 green. Pre-existing unrelated `item_vendors_rls.test.sql` test-12 failure (spec 114) noted as not spec-123's.
- backend-architect: 0 drift, 0 Should-fix, 4 Minor (all informational). Confirmed migration is verbatim-base + single additive `has_po` key with no reorder-math drift, correct base-body provenance, date-string identity round-trip intact, TS surfaces and pgTAP match design, no RLS/edge/realtime/publication change. Minor notes: hardcoded English export aria (pre-existing pattern), cosmetic migration header comment, design-flagged UTC-midnight straddle, design-flagged UX-only disabled state — none block.

## Recommended next steps (ordered)
1. Commit and push to `main` (all reviewer Criticals: 0; CI-blocker resolved; base tsc + `typecheck:test` + full jest green).
2. In the SAME deploy window, apply the pending prod migration to keep `db-migrations-applied.yml` green: run `20260718000000_reorder_list_has_po.sql` via Supabase MCP `execute_sql` (CREATE OR REPLACE `report_reorder_list`), insert version `20260718000000` into `supabase_migrations.schema_migrations`, and verify the function via normalized-md5. NO edge redeploy. Until the version row is inserted, `db-migrations-applied.yml` will hard-fail (repo migration missing from prod) — this is expected and clears on insert.
3. After push + prod insert, confirm the latest run of BOTH gates on `main` is green: `test.yml` and `db-migrations-applied.yml` (`gh run list --branch main --workflow <file> --limit 1` each). Do not treat a green `test.yml` alone as sufficient.
4. (Follow-up, non-blocking) Add a dedicated jest unit test asserting `createPoDraft` passes `referenceDate = reorderPayload.asOfDate` to `db.createPurchaseOrderDraft` (closes AC11 coverage gap).
5. (Follow-up, non-blocking) Add a direct `mapReorderVendor` unit test for `has_po → hasPo` and the "absent → false" default (code-reviewer nit / test-engineer awareness item).

## Out of scope for this review
- i18n keys for the per-vendor export-button `accessibilityLabel`s ("Export CSV" / "Export PDF") — matches the pre-existing untranslated REFRESH-button pattern; a broader ReorderSection aria-i18n pass belongs in a separate cleanup spec.
- Pre-existing `item_vendors_rls.test.sql` test-12 failure (spec 114 `order_code` assertion) — predates and is untouched by spec 123.
- Hard server-side duplicate-PO prevention beyond the UX disabled state (a direct INSERT still bypasses the chip; RLS store-scopes writes) — explicitly deferred per spec Q3.

## Handoff
next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/123-reorder-per-vendor-exports-po-created/reviews/release-proposal.md

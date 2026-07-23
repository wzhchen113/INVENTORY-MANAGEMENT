# Release proposal — spec 138 (reorder-only, retire PO receiving)

## Verdict
verdict: FIXES_NEEDED
rationale: AC-7's reset-after-export behavior is unimplemented (not merely untested), which is a broken acceptance criterion — a Critical category that blocks SHIP_READY under the hard rule, even though security, drift, and CI are all clean.

## Findings summary
- **code-reviewer:** 0 Critical / 3 Should-fix / 4 nits. Top issues: (1) `upsertVendorDraftOrder` UPDATE path does delete-then-reinsert-then-update as three unguarded round-trips — a reinsert failure after a successful delete leaves a previously-filled draft with zero lines (data-loss window on re-fill); (2) the "POsSection.tsx is dead/unmounted" claim in the spec is inaccurate — `VendorsSection.tsx:9,444` still imports and renders `POHistoryTab` from it, so a future cleanup spec trusting the claim would break the Vendors PO-history tab; (3) no jest coverage for the `upsertVendorDraftOrder` / `fillCartForVendor` branching the design's own §12 test plan promised.
- **security-auditor:** 0 findings at every severity. Migration is a byte-identical-header `CREATE OR REPLACE` of two SECURITY-INVOKER read RPCs (ACLs preserved); `upsertVendorDraftOrder` stays RLS-enforced inside `db.ts` with no service-role/secret access; extension RPC surface byte-untouched; retired UI surfaces confirmed unreachable; no dependency change.
- **test-engineer:** All suites green (jest 1388/1388, pgTAP 76/76, extension vitest 31/31, tsc clean). AC status: **AC-7 FAIL** — reset-after-export never implemented (real behavior gap vs. AC text, not just a missing test; the only `clearReorderEditsForVendor` production call site is inside `fillCartForVendor`, none in the CSV/PDF/quick-order handlers). **AC-9/AC-10 PARTIAL** — Fill-cart write path (`fillCartForVendor` + `upsertVendorDraftOrder`) has zero automated coverage at any layer despite being named in §12; every test stubs it as a `jest.fn()`. **AC-3 NOT TESTED** — staff Receiving tab removal is source-confirmed but has no test (never had one). Remaining ACs PASS.
- **backend-architect:** 0 Critical / 0 Should-fix / 2 Minor (cosmetic wording only). AC-7 buffer-reset revert, the two-engine OPTION A migration, the `upsertVendorDraftOrder` §4 contract, the untouched extension RPCs, and the dormant-not-dropped posture all match the design.

## Recommended next steps (ordered)
FIXES_NEEDED:

1. **[Critical — broken AC-7] Resolve the reset-after-export gap.** AC-7 requires that after an export *or* a cart-fill for a vendor, the next reorder cycle starts fresh from computed suggestions. The cart-fill half exists (`useStore.ts:2916`); the export half is not built. Fix path A (implement to spec): wire `clearReorderEditsForVendor(vendorId)` into `ReorderVendorExportButtons`' `onCsv`/`onPdf` handlers (`ReorderSection.tsx:435-449`) and `ReorderQuickOrderButton`'s `onShareQuickOrder` (`ReorderSection.tsx:340-391`), firing after the export succeeds — then add jest assertions that each export path clears that vendor's buffer. Fix path B (spec amendment): if the owner actually wants edits to persist through export, the PM must amend the AC-7 text and the design §12 line to drop the export-reset clause; this is a spec-owner decision, not a coder call. Either way it cannot ship against the current AC text. First because it is the sole Critical and gates the verdict.
2. **[Should-fix, high] Add the `fillCartForVendor` / `upsertVendorDraftOrder` write-path tests (AC-9/AC-10).** This is the highest-risk code the spec adds — it writes the `draft` `purchase_orders` row the browser extension reads before touching a live vendor cart — and has zero coverage at jest, pgTAP, or shell-smoke level. Add a mocked-`supabase` jest test in the established shape (`src/lib/db.poLoop.test.ts` / `useStore.createPoDraft.spec125.test.ts` are precedent) exercising all §12 branches: create-when-no-draft, update-existing-draft, new-draft-when-only-a-`sent`-exists, and the `expected_delivery`-omitted invariant. Second because browser verification exercised only the happy path once; the branch matrix is unpinned.
3. **[Should-fix] Close the `upsertVendorDraftOrder` UPDATE-path data-loss window.** Reorder the existing-draft branch (`db.ts:1687-1709`) to insert-the-new-lines-first-then-delete-the-old, or add compensating re-insert on `reinsertErr`, so a mid-operation failure leaves the prior lines intact rather than an empty draft. Best paired with fix #2 (the new test should cover the failure branch). Data-loss-adjacent but narrow (only on a re-fill of an existing draft with a transient reinsert failure), so ranked below the Critical.
4. **[Should-fix, doc] Correct the "POsSection.tsx unmounted/dead" claim.** Update the spec's Design §6 and the backend Files-changed note to record that `POHistoryTab` (a named export of `POsSection.tsx`) is still live via `VendorsSection.tsx` — only the default export is unmounted. Prevents a future cleanup pass from deleting the file and silently breaking the Vendors PO-history tab.
5. **[Nit / follow-up] Direct test gaps.** Add a 5-line test asserting `useDefaultSidebarGroups()`'s OPERATIONS group no longer contains `Receiving` (AC-2, currently only indirectly covered), and — if cheap — an e2e/staff assertion that the staff tab bar has no Receiving tab (AC-3, never covered before or after). Neither is spec-138-introduced regression risk; both are "nothing protects this" gaps.
6. **[Nits] Cosmetics.** Drop the redundant `|| 1` fallback (`ReorderSection.tsx:107` vs `1282-1284`); fix the stale header comment in `ReorderSection.spec123.test.tsx:8-10`; add the intentional-defensiveness comment on `fillCartForVendor`'s buffer re-derivation (`useStore.ts:2883`); optionally align the migration header wording (architect M1) and the "mirroring spec-135" framing (architect M2).

**Ship-time operational note (not a code fix):** the new migration `20260726000000_reorder_drop_inbound_term.sql` is applied to the local stack only. Once spec-138 is committed to `main`, `db-migrations-applied.yml` will read red until the migration is applied to prod via Supabase MCP + `schema_migrations` insert (per project MEMORY). Both CI gates are green as of `ce8c4e1` today with the spec work uncommitted; per the CI hard rule, do not treat SHIP_READY as reachable until the fixes land AND the post-commit run of both gates (including the prod-apply of this migration) is green.

## Out of scope for this review
- `e2e/reorder.spec.ts:69-84` — the export-buttons check reads the pre-spec-123 non-suffixed testID (`reorder-export-csv`), so `exportVisible` is always false and the enabled-state assertions silently never run. Pre-existing (not spec-138-introduced); belongs in a test-hygiene follow-up.
- Wholesale deletion / migration of the dormant `POsSection.tsx`, `ReceivingSection.tsx`, staff `Receiving.tsx`, and the staff-subtree `db.ts` migration — explicitly deferred by this spec's dormant-not-dropped posture; a future cleanup spec (informed by the corrected POHistoryTab carve-out in fix #4).

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 6 items, top: AC-7 reset-after-export is unimplemented (broken acceptance criterion, blocks SHIP_READY)
payload_paths:
  - specs/138-reorder-only-retire-po-receiving/reviews/release-proposal.md

---

# RE-VERDICT (2026-07-23, post-fix-round)

## Verdict
verdict: SHIP_READY
rationale: Both blockers from the first pass are resolved and mutation-verified by the test-engineer — AC-7 export-reset is now implemented (success-only, per-vendor-scoped) and AC-9/AC-10's write path has real non-stub coverage — leaving no reviewer-flagged Critical; AC-3's remaining gap is NOT-TESTED, not a broken criterion, so it does not trip the hard rule.

## What changed since the first pass
- **AC-7 → PASS.** Reset-after-export is now built for CSV/PDF/quick-order, gated success-only (`if (ok)` / `if (shared)`, never in a `finally`), scoped to the exported vendor. Test-engineer mutation-verified it: deleting the `onCsv` reset line produced exactly 2 real test failures ("Number of calls: 0"), then a clean revert to 6/6 and full-suite green — so the test is non-vacuous.
- **AC-9 / AC-10 → PASS.** The Fill-cart write path now has real coverage against the actual functions, not stubs: `db.upsertVendorDraftOrder.test.ts` (INSERT, skip-non-`draft`/`sent`, null-`reference_date` match, `expected_delivery` asserted absent, the reordered insert-before-delete with `invocationCallOrder`, and the failure-preserves-old-lines branch) and `useStore.fillCartForVendor.spec138.test.ts` (edited-qty overlay + spec-104 per-counted-unit bridge, referenceDate keying, clear-on-success inspected via real reducer state, preserve-on-failure for both null and thrown shapes, no-active-store guard).
- **Fix #3 (data-loss window) → resolved.** `upsertVendorDraftOrder`'s UPDATE path reordered to insert-new-then-delete-old per the code-reviewer's recommendation, with the failure-ordering branch now pinned by the test above.
- **Fix #4 (POHistoryTab doc claim) → corrected** in the spec's Files-changed notes.
- **Nits → done;** the pre-existing `e2e/reorder.spec.ts` testID nit explicitly deferred (was already out-of-scope in the original proposal).
- **Full suites green:** jest 134 suites / 1407 tests, pgTAP 76/76, extension vitest 31/31, both typechecks clean.

## AC-3 weighed explicitly against the hard rule
The hard rule blocks SHIP_READY on any reviewer-flagged **Critical**, and "broken acceptance criteria" is one of the Critical categories. AC-3 (staff Receiving tab removal) is **source-confirmed correct** — the `Tab.Screen` is actually gone from `StaffStack.tsx`; main-session browser verification also confirmed the retirement live. The criterion's *behavior* is satisfied; what is missing is an automated *test*. A NOT-TESTED-but-correct criterion is a coverage gap, not a broken criterion, so it does not meet the "broken acceptance criteria" Critical bar. Corroborating this reading: no reviewer classified AC-3 as Critical — the test-engineer explicitly frames it as a pre-existing, disclosed gap that "long-predates spec 138" and on which "none of the fix-plan's own claims depended," and states it blocks only under an "every AC needs a test before ship" bar, not under a "no Critical regressions introduced by this spec" bar. This project's shipping posture is the latter (CLAUDE.md: v1 test tracks ship infra + example tests, retroactive coverage is a follow-up), and the file was never covered before spec 138 either, so nothing regressed. Therefore AC-3 is a tracked follow-up, not a ship blocker.

## Recommended next steps
SHIP_READY:
1. **Commit** the spec-138 working tree.
2. **In the same ship step, apply migration `20260726000000_reorder_drop_inbound_term.sql` to prod** via the Supabase MCP workflow (execute_sql + insert the exact version into `schema_migrations` + verify with normalized-md5, project ebwnovzzkwhsdxkpyjka), otherwise `db-migrations-applied.yml` goes red on the next `main` run. This is a hard ordering requirement, not optional cleanup.
3. **After the push, confirm both CI gates are green on `main`** — `test.yml` AND `db-migrations-applied.yml` (`gh run list --branch main --workflow <file> --limit 1` each) — before any further pipeline work. A green `test.yml` alone is not sufficient evidence here precisely because the migration prod-apply is what the second gate checks.

### Non-blocking follow-ups (do not gate ship)
- Add the AC-3 staff-Receiving-tab-absent test (jest on `StaffStack` and/or an e2e assertion) — closes the one remaining NOT-TESTED acceptance criterion.
- Add the direct `useDefaultSidebarGroups()` OPERATIONS-group assertion for AC-2 (currently indirect only).
- Fix the pre-existing `e2e/reorder.spec.ts:69-84` non-suffixed-testID nit so the export-enabled assertions actually run again.

## Handoff
next_agent: NONE
prompt: SHIP_READY — both first-pass blockers resolved and mutation-verified; AC-3 is a NOT-TESTED (not broken) pre-existing gap that does not trip the hard rule. Ship steps: commit, apply migration 20260726000000 to prod via MCP in the same step, then confirm both CI gates green on main.
payload_paths:
  - specs/138-reorder-only-retire-po-receiving/reviews/release-proposal.md

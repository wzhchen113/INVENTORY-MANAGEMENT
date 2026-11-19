# Release proposal: spec 201 (reorder primary-vendor-wins + cross-vendor count read)

Release coordinator, 2026-11-18. Synthesized from the four reviewer files in this directory (read directly), plus the spec's design, implementation notes and files-changed sections.

## Verdict
verdict: SHIP_READY (conditional)
rationale: All four reviewers report 0 Critical and 0 High. Every server and client AC passes (pgTAP 111/111, jest 315/315, typecheck:test clean). The only gaps are an unrun e2e suite and CI-gate state that this agent cannot check, so ship depends on the preconditions below.

**Conditions for SHIP_READY to hold.** If any one fails, treat the verdict as FIXES_NEEDED.
1. **CI gates on `main`.** Main Claude must confirm that the latest run on `main` of **both** gates is green before this goes out:
   - `gh run list --branch main --workflow test.yml --limit 1`
   - `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`

   The release coordinator has no shell and could not check either one. Per CLAUDE.md, a red or in-progress run on either gate blocks SHIP_READY.
2. **`e2e/staff-reorder.spec.ts` runs green** once port 8081 is free. AC-28 requires it, and nobody has run it: the developers and test-engineer all skipped it because another session held the port. It is unverified, not known broken. A failure blocks.
3. **Both spec 201 migrations go to prod before the push to `main`** (see step 2 below). Without them, `db-migrations-applied.yml` goes red on that push, and the Vercel-deployed admin switch fails with PGRST202.

## Findings summary

- **code-reviewer:** 0 Critical, 2 Should-fix, 7 Nits.
  - **Should-fix 1 (duplicated switch handler):** the switch state and handler (`switchingItemId`, the `onSwitchPrimary` body, `reorderAsOfDate.slice(0,10)`) are copy-pasted between `ReorderSection.tsx` and `PhoneOrdering.tsx`. The suggested fix is a `usePrimaryVendorSwitch(vendor)` hook next to `primaryVendorSwitch.ts`. This is drift risk only; today both copies behave the same.
  - **Should-fix 2 (revert scope, owner call):** the store's revert restores the whole pre-switch row, so it could overwrite a realtime update that lands during the await. That matches the existing `updateItem` pattern, so the reviewer calls it consistent with the project, not a bug.
  - **Nits:**
    - hoist `item.yieldedFromVendors ?? []` into one variable;
    - stale spec 102 comments that still say the item "appears under each card";
    - a duplicated `Translate` type;
    - "today's {from} order" wording in the refusal copy;
    - an empty-vendor-name fallback in the confirm text;
    - the staff es "pídalo aquí" formality check.
  - **Conventions:** every project-convention check is clean, including db.ts centralization, optimistic-then-revert with `notifyBackendError`, `confirmAction`, i18n token parity, and migration 2's posture and guard order.

- **security-auditor:** 0 Critical, 0 High, 0 Medium, 3 Low.
  - **L1 (pre-existing):** the RPC enforces "admin only" for the switch path, but the existing `store_member_update_inventory_items` / `store_member_update_item_vendors` policies still let any store member change `vendor_id` / `is_primary` with a direct PATCH. Design §5.1 reason 4 must not be cited later as proof that primary changes are admin-gated. Possible follow-up: a RESTRICTIVE policy or a column guard trigger.
  - **L2:** `set_item_primary_vendor.test.sql` has no cross-brand admin arm (expected: P0001 "item not found") and no super_admin arm (expected: succeeds).
  - **L3:** the in-transaction 3c re-check narrows the TOCTOU window but doesn't close it under READ COMMITTED. The comment should say "narrows". The impact is the stale-draft residual risk the spec already accepts.
  - **Verified clean:**
    - `report_reorder_list` posture (invoker, search_path, ACL, `reports_anon_revoke` state kept);
    - the borrow source is store-scoped with no cross-store leak;
    - the RPC grants and the parity of `auth_is_privileged()` across all three privileged roles;
    - no injection sinks;
    - no package changes.

- **test-engineer:** every AC from AC-1 to AC-27 passes, plus the design §12 extras: AC-15b id tiebreak, C3, AC-12's dangling/null cases, and the mapper.
  - **Totals:**
    - pgTAP: 111/111 files. The new suites are primary_wins (60 arms), borrowed_count (41) and set_item_primary_vendor (30); the rewritten multi_vendor suite passes 11/11.
    - jest: 315/315 suites, 4014 tests.
    - `typecheck:test`: exit 0.
    - Base `typecheck`: only the environmental TS2688 errors from Finder-duplicate `@types/* 2` directories; filtered `tsc` is clean.
  - **AC-28 is PARTIAL:** `e2e/staff-reorder.spec.ts` was **not run**.
  - The developers' mutation check against the baseline body (29/60 and 22/41 arms fail on the old body) was not re-run, though the suites themselves were.

- **backend-architect (post-impl):** no contract drift. 0 Critical, 1 Should-fix (S1), 4 Minor.
  - **S1, owner decision tied to spec 200.** Once spec 200 ships its omit rule, a backup vendor whose surfaced items are all shared will badge STOCK FALLBACK, even though every number on its card is a real borrowed count. This affects:
    - the badge on desktop and phone;
    - `kpis.stock_fallback_vendor_count`;
    - the spec 151 last-order deltas, which are suppressed.

    Quantities and order paths stay correct. This follows from R10 plus D4 as designed, but the PM never decided the submitted-but-all-borrowed case. The architect asks for:
    - a §13 risk bullet in the spec;
    - one pgTAP arm pinning the vendor-level `on_hand_source = 'stock'` with a non-null `eod_submitted_at` under the drop.

    Any relabel, such as "counted under {vendor}", would be a follow-up spec, not an edit to R10 inside 201.
  - **M1:** the text-only line on PhoneApproveOrder is ratified. Optionally, make it an explicit `allowPrimarySwitch` prop and add a §9 addendum.
  - **M2:** stale "equivalent" comment in `reorderDayFilter.ts` L197-199.
  - **M3:** "today's" in the refusal copy (same as the code-reviewer nit).
  - **M4:** optional pointer comment in the inherited (4f) header of migration 1.
  - **Method caveat:** the architect compared the migration hunk by hunk, not as a mechanical byte diff. For the baseline-verbatim claim, rely on the developer's diff ("only three removed lines, all replaced in place") and the md5 pre- and post-checks in the migration header.

## Owner decision: architect S1 (vendor badge after spec 200)

Spec 201 alone doesn't cause the misleading badge in normal use; it is rare today. Spec 200's omit rule is what makes it common for backup vendors. The owner chooses one of:
- **(a) Accept now, relabel later.** Ship 201 as is. Add the §13 bullet and the pgTAP pin, either now or in the fix round below. Then file a follow-up spec for a "counted under {vendor}" vendor token that uses the unmapped `on_hand_borrowed_from` diagnostic, and accept the cosmetic regression until it lands. **Recommended.** Quantities are correct, R10/AC-18 stay intact, and the relabel is a contained design question.
- **(b) Hold spec 200's client** until a relabel spec ships. 201 can still ship on its own.

Either way this does not block spec 201.

## Recommended next steps (ordered)

1. **Before the push, run `e2e/staff-reorder.spec.ts`** on a free port 8081 against the local stack. This is the open AC-28 clause.
2. **Prod apply on the owner's go-ahead,** via Supabase MCP on project `ebwnovzzkwhsdxkpyjka`, following each migration header.
   - **Migration `20261118120000_reorder_primary_wins_borrowed_count.sql`:**
     - Pre-check: the normalized md5 of prod `report_reorder_list` equals the 20261024000000 body.
     - Run `execute_sql`.
     - Insert version `20261118120000` into `supabase_migrations.schema_migrations`.
     - Post-check the md5.
   - **Migration `20261118120100_set_item_primary_vendor.sql`:** run `execute_sql`, insert version `20261118120100`, then verify the md5.
   - Apply the two together, before any push to `main`. Pushing first would turn `db-migrations-applied.yml` red, and the auto-deployed admin switch would hit PGRST202.
   - No publication change, so no realtime restart.
3. **Commit spec 201 by itself** after the owner's explicit go-ahead.
   - The index is shared with specs 188, 192, 196 and 200. Use the temp-`GIT_INDEX_FILE` single-spec commit technique and run the gates on the exported tree.
   - Watch these overlaps:
     - `src/lib/db.ts` is `MM`. Only the spec 201 hunks are staged; leave the unrelated invite-comment edit near L2645 unstaged.
     - Spec 200's in-progress frontend shares `src/screens/staff/i18n/{en,es,zh-CN}.json`. Make sure only `reorder.item.yieldedFrom` from 201 goes in.
     - `ReorderSection.tsx` and the `EODCountSection` test files have staged changes that may belong to other specs. Check that each hunk belongs to 201.
4. **After the push to `main`,** main Claude checks the latest run of `test.yml` **and** `db-migrations-applied.yml` on `main`. Both must be green. Also check `e2e.yml` by hand (it isn't yet a formal gate). If any run is red or in progress, surface the URL and stop.
5. **Sequencing with spec 200:** don't push spec 200's client (Vercel or EAS) until step 2 is confirmed on prod. Spec 200 is reviewed separately.
6. **Optional, before or soon after ship (non-blocking, should-fix):**
   1. Architect S1: add the §13 risk bullet and the pgTAP arm pinning the vendor-level `on_hand_source = 'stock'` with a non-null `eod_submitted_at` under the drop. Best landed before spec 200 ships, so the behaviour is pinned on purpose.
   2. Code-reviewer Should-fix 1: extract a `usePrimaryVendorSwitch` hook to dedupe the desktop and phone handlers.
   3. Security L2: add the cross-brand admin arm (P0001, nothing written) and the super_admin arm (succeeds) to `set_item_primary_vendor.test.sql`.
   4. Comment and copy cleanups:
      - Security L3: "closes" → "narrows" in the migration 2 header and §5.1.
      - Architect M2: `reorderDayFilter.ts` comment.
      - Architect M4: (4f) pointer.
      - Code-reviewer stale spec 102 comments in `ReorderSection.tsx` and staff `Reorder.tsx`.
      - "today's" → "for this date" in `switchRefused`, all three locales (code-reviewer nit and architect M3).
      - An empty-vendor-name fallback in the confirm text.
      - Hoist `yieldedFromVendors`.
      - Import `useT`'s return type.
   5. Owner checks: es "pídalo aquí" formality against the other es staff strings. Accept or narrow the code-reviewer's revert-scope Should-fix 2.
   6. Architect M1: an explicit `allowPrimarySwitch` prop on PhoneOrdering, and a §9 addendum recording the PhoneApproveOrder text-only decision.

## Out of scope for this review
- **Staff can still write `inventory_items.vendor_id` / `item_vendors.is_primary` by direct PATCH** (security L1, pre-existing). A real admin-only boundary on these columns needs its own spec: a RESTRICTIVE UPDATE policy or a guard trigger, after a `pg_policies` audit under the permissive-OR rule, and a check that the staff app never writes these columns.
- **A "counted under {vendor}" vendor-level source token or relabel** (architect S1 follow-up). It must not be done by editing R10 inside spec 201.
- **Fully closing the 3c TOCTOU** with `FOR UPDATE` on matching `purchase_orders` rows (security L3). It is optional hardening, and its impact is the stale-draft residual risk the spec already accepts.
- **The `eod_vendor_has_below_par` "order ready" approximation, repairing `vendor_id` / `is_primary` drift, and pre-ship stale drafts.** All are already listed as out of scope or residual risk in the spec.
- **Spec 200's own review and release.**

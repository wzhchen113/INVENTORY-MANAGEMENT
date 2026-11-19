# Release proposal: spec 200 (staff EOD counts a shared item once across vendors)

Release coordinator, 2026-11-18. This proposal draws on the three reviewer files in this directory, which I read directly: `code-reviewer.md`, `security-auditor.md` and `test-engineer.md`. It also uses the spec's design, implementation notes and files-changed sections, and spec 201's release proposal (`specs/201-reorder-shared-item-primary-vendor-wins/reviews/release-proposal.md`). I checked the all-borrowed copy path myself (`src/screens/staff/screens/EODCount.tsx` L1008-1024) and the writer's on-hand update (`supabase/migrations/20261109190000_staff_eod_date_bound.sql` L263-273).

## Verdict
verdict: SHIP_READY (conditional)
rationale: No reviewer reports a Critical or High, and all 18 automatable ACs pass (jest 318/4067, pgTAP 112/112, typecheck:test clean). Main Claude confirmed that the latest `main` runs of test.yml, db-migrations-applied.yml and e2e.yml are green. What remains is two owner decisions and the deploy order with spec 201, not code fixes.

**Conditions.** If any of these fails, treat the verdict as FIXES_NEEDED.
1. **The owner explicitly accepts the security Medium**, the on-hand revert in the all-borrowed case, as a Residual risk. The alternative is to choose one of the fix options below, which turns this into a fix round. The accepted residual risk today covers only "the source count changes". The Medium is wider than that, so the owner has not yet accepted it.
2. **Spec 201 migration `20261118120000` is on prod before spec 200's client reaches `main`.** Vercel deploys on push. The same applies to EAS.
3. **No new red gate.** After each push, `test.yml` and `db-migrations-applied.yml` on `main` are green, and `e2e.yml` is checked by hand.

## Findings summary

- **code-reviewer: 0 Critical, 0 Should-fix, 5 Nits** (one of them out of scope).
  - The first committed key on a borrowed row writes `''` into the untouched map. This is harmless, but the map's shape is inconsistent with `commitRow`.
  - When the refresh after a submit fails, the screen replaces the last good server sources with `[]`. The label and the count then drop until the next read. This matches AC-15, but keeping the last snapshot would be friendlier.
  - A comment should explain why `isCounted` uses `borrowed.has` while the display uses `borrowedFor`.
  - The `ListRow` `footer` uses `flexWrap` with a 100% basis. It was verified only on web, so it needs one check on a native build.
  - (Out of scope) The CTE name `latest_eod_per_vendor` in the spec 201 migration is misleading.
  - **Verified:** the client borrow ordering reduces exactly to spec 201's `eod_borrow_source`:
    - `submitted_at DESC NULLS LAST, id DESC`, at microsecond precision;
    - null vendor included;
    - blank legacy entries skipped.

    The reviewer also accepted both documented deviations (the `ListRow` footer slot, and seeding own maps after an all-borrowed submit). All convention checks are clean.

- **security-auditor: 0 Critical, 0 High, 1 Medium, 2 Low.**
  - **Medium (data integrity, no privilege gain).** In the all-borrowed case, each copy is a numeric entry for an item linked to this vendor. `eod_write_submission` therefore runs `current_stock = actual_remaining` (L263-273, confirmed). That reverts any on-hand change made between the source vendor's submit and this one, for example PO receiving, auto-receive, a manual adjustment or an admin EOD edit. The number nobody re-counted is attributed to a staffer who didn't count it. See the decision section below.
  - **Low 1.** The copy's `'EOD entry'` audit row looks like a fresh count by the submitting staffer, with no provenance. Fixing it properly needs a server change.
  - **Low 2.** The staff `notifyBackendError` toast shows the internal name `fetchBorrowSources` and the PostgREST message. This is the existing pattern, it leaks nothing, and no action is needed.
  - **Verified clean:** store-scoped RLS on both tables and the `vendors(name)` embed (an unseen vendor falls back to the generic label); queued sources limited to the signed-in user; no new write capability; minimal columns; no XSS sink; a hermetic pgTAP test.

- **test-engineer: 18 PASS, 0 FAIL, 1 NOT TESTED.**
  - AC-1 through AC-18 pass. This includes AC-1 arms (i)-(k), which pin the shared contract, and the R9 drain-gap test. AC-18 notes the base `typecheck`, where only the 24 known environmental TS2688 errors appear, from the Finder-duplicate `@types/* 2` folders.
  - AC-19 (390 px label fit) is manual. The developer recorded a pass on the local stack (label scrollWidth = clientWidth = 364 px) and ran the AC-2 and AC-9 flows through the real screen with DB confirmation. I accept this as the evidence for the manual AC. The owner can glance at the developer's screenshots if they want.
  - e2e (`e2e/eod.spec.ts`, `e2e/staff-reorder.spec.ts`) was not run, because the user's dev server holds port 8081. Neither spec exercises borrowing, so this is a regression check only, not AC evidence.

- **backend-architect (post-impl): not run.** I don't consider that a material gap.
  - The spec makes no server change: there's no migration, RPC or policy, and the only server-side file is the test-only `eod_cross_vendor_read_rls.test.sql`. The one place where design and implementation could drift is the cross-spec borrow contract (§1). The code-reviewer checked it explicitly against the actual `eod_borrow_source` CTE in `20261118120000`, and AC-1 arms (i)-(k) pin it on the client.
  - The architect already reviewed the server side of that contract in spec 201's post-impl review and found no drift.
  - Both implementation deviations (the `ListRow` footer, seeding own maps after an all-borrowed submit) are UI-local, and the code-reviewer accepted them.
  - The one design-level issue an architect pass might have raised is the Medium below, and security already caught it.
  - Residual gap: no single test spans both the client ordering and the SQL ordering. Each side is pinned separately against the same written contract. That is acceptable.

## Decision required: security Medium (on-hand revert in the all-borrowed case)

**When it bites.** All three of these must hold:
1. The vendor's entire list is shared items.
2. Every item was already counted that night under another vendor, so the R8 exception applies.
3. At least one of those items had an on-hand change between the source submit and this submit.

The item's `current_stock` then goes back to the source count until the next count overwrites it. This affects anything that reads `current_stock`: the admin inventory view and STOCK-sourced reorder rows. The suggested quantities on EOD-sourced reorder rows are unaffected.

**Options:**
- **(1) Accept explicitly.** Add a Residual-risk bullet to spec 200 that names the receiving, auto-receive, adjustment and admin-edit revert, and the audit-provenance limitation (Low 1). This costs nothing, and the exposure is narrow and bounded to one night.
- **(2) Re-read the sources right before building the copies,** and refuse with a toast if a source changed. This is client-only, but it narrows only the "source edited" window, which the owner **already accepted**. It does nothing for receiving or adjustments, which are the actual new concern. It also adds a round trip, a new refusal UX with three-locale strings, and a re-review. **Not recommended.**
- **(2b) A variant worth evaluating in the follow-up (unverified, design only).** The writer sets `current_stock = actual_remaining` exactly. So just before submit, a client read of `inventory_items.current_stock` for the copied items would detect any change since the source's write: if `current_stock` differs from the copy's `actual_remaining`, something changed. The screen could then refuse the auto-copy for those rows and ask for a real count. This stays inside the staff carve-out with no server change, and unlike (2) it does catch receiving and adjustments. It still needs design work (UX, false positives from another vendor's later count of the same item), so it isn't a ship-time fix.
- **(3) A follow-up spec with a server-side copy marker.** For example, entries flagged as copies would make `eod_write_submission` skip the on-hand write and record provenance in the audit `detail`. This is the clean fix, and it also closes Low 1. It's a server change, so it needs its own spec, architect design and pgTAP.

**Recommendation: (1) now, plus (3) as a follow-up spec** that also evaluates (2b) as the lighter alternative. The exposure is narrow and bounded until the next count. The behaviour it replaces, forcing a duplicate physical count, is what the owner asked to remove. And (2) doesn't address the new part of the risk. The Residual-risk edit to the spec belongs to the PM or developer; the release coordinator doesn't edit the spec.

## Recommended next steps (ordered): combined release for specs 201 and 200

1. **Owner decisions (no code needed):**
   1. **Spec 200 security Medium:** accept per option (1) and file the option (3) follow-up spec. The PM or developer then adds the Residual-risk bullet to spec 200.
   2. **Spec 201 architect S1** (STOCK FALLBACK badge on a backup vendor whose surfaced items are all borrowed): take option **(a), accept now and relabel later.** Spec 200's omit rule is exactly what makes this badge common, so the decision should be made before spec 200 ships. The quantities stay correct. File the "counted under {vendor}" vendor-token relabel as a follow-up spec.
2. **Land spec 201's S1 pin before 201 is committed:** the §13 risk bullet plus one pgTAP arm pinning the vendor-level `on_hand_source = 'stock'` with a non-null `eod_submitted_at` under the drop. With that in place, the post-200 behaviour is pinned on purpose. This is a spec 201 test-only change, so the full pgTAP run must pass again.
3. **Run e2e locally** once port 8081 is free; stopping the dev server is the user's call. Run `e2e/staff-reorder.spec.ts`, which is spec 201's open AC-28 clause and a condition in 201's proposal, and `e2e/eod.spec.ts` as a regression check for spec 200. A failure in either blocks.
4. **Apply spec 201's two migrations to prod** on the owner's go-ahead, via Supabase MCP (project `ebwnovzzkwhsdxkpyjka`), following each migration header and spec 201's proposal step 2:
   - `20261118120000`: md5 pre-check, then `execute_sql`, insert the version into `schema_migrations`, then md5 post-check.
   - Then `20261118120100`, the same way.
   - Do both before **any** push to `main`.
5. **Commit spec 201 by itself**, using the temp-`GIT_INDEX_FILE` single-spec technique, and run the gates on the exported tree.
   - The staff i18n files `src/screens/staff/i18n/{en,es,zh-CN}.json` hold both 201's `reorder.item.yieldedFrom` and 200's `eod.borrowed.*`. Split by hunk.
   - Leave the unrelated `db.ts` invite edit and the other specs' (188/192/196) staged files out.
6. **Push 201, then confirm `test.yml` and `db-migrations-applied.yml` are green on `main`,** and check `e2e.yml` by hand. If any is red or in progress, surface the URL and stop.
7. **Commit spec 200 by itself**, the same way. Its files are in the spec's `## Files changed`. Run the gates on the exported tree: full `npx jest`, `typecheck:test`, and pgTAP including `eod_cross_vendor_read_rls.test.sql`.
   - This only works if 201 is already in HEAD. Spec 200 depends on 201's i18n neighbours and on the migration on prod, though not on any 201 code.
8. **Push 200**, which triggers the Vercel deploy. Repeat the gate check from step 6.
9. **Before the next EAS build,** check the `ListRow` `footer` wrap on a native build (code-reviewer nit; it was verified only on web). Native builds are currently blocked on the Xcode install, so this doesn't block web. Don't ship native until it's checked.
10. **Optional follow-ups (non-blocking):**
    1. Spec 200 nits: keep the last good server-source snapshot when a refresh fails; write only the seated field and the non-blank seed fields on the first borrowed key; add the `isCounted` vs `borrowedFor` comment.
    2. Spec 201's remaining optional items, listed in its proposal step 6 (the `usePrimaryVendorSwitch` hook, security L2 arms, comment and copy cleanups).

Specs 201 and 200 may go out in a single push instead of steps 6 and 8, as long as step 4 is done first and they stay as separate commits. Pushing them one at a time keeps the cause of any red gate unambiguous, so it's preferred.

## Out of scope for this review
- **A server-side copy marker** that skips the on-hand write for copied entries and records provenance in the audit row (security Medium option 3 and Low 1). It needs a new spec, because it changes `staff_submit_eod` / `eod_write_submission`.
- **The current_stock drift check before an all-borrowed submit** (option 2b). A design question for that same follow-up.
- **A "counted under {vendor}" vendor-level relabel for reorder's STOCK FALLBACK badge** (spec 201 architect S1 follow-up). It must not be done by editing spec 201 R10 in place.
- **The misleading `latest_eod_per_vendor` CTE name** in `20261118120000` (code-reviewer, out of scope). A rename belongs in a future reorder migration.
- **The stale header comment in `src/screens/staff/components/ListRow.tsx`** (pre-existing).
- **Admin EOD counting drafts while staff doesn't** (OQ-2). This is a documented, intentional difference.
- **Spec 201's own out-of-scope items** (security L1, staff direct PATCH of `vendor_id` / `is_primary`; the 3c TOCTOU). See its proposal.

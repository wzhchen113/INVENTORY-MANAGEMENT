# Spec 184 release proposal

Release-coordinator, 2026-11-07. Advisory only. Sources: the four reviewer files in this directory, the spec (including `## Files changed` and `## Browser verification (AC-45)`), and the facts main Claude checked on 2026-11-05 (listed under Gate and prod context). I read `BrandsSection.tsx` L1204-1258 and `StockStoreDialog.tsx` L69-96 to confirm the code-reviewer's stale-panel finding. Nothing was applied, staged or edited apart from this file.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer found a Critical and all three `main` gates are green, but two cheap Should-fix bugs (the D-14 short-page stop, which still truncates silently if prod's `max_rows` is below 1000, and a stale result panel after a brand switch) plus a missing staging guard in the runbook should land before this change is committed and pushed.

## Gate and prod context

- **CI on `main` at feb6301 is green on all three workflows:** `test.yml` run 42000265755, `db-migrations-applied.yml` run 42000265668, `e2e.yml` run 42000265921. Spec 184 sits uncommitted on top of feb6301, so CI hasn't run on it yet. The CLAUDE.md gate rule applies again after the push.
- **pgTAP (architect S-2) is answered.** The test-engineer ran the full `scripts/test-db.sh`: 94 of 95 files pass. `stock_store_from_store.test.sql` passes (196 assertions), and the four AC-20 suites pass unmodified. The only failing file is `supabase/tests/order_approvals_fk_set_null.test.sql` (8 of 12 assertions fail). That file was untracked before spec 184 started, belongs to other work, and is out of scope here. **It must stay out of this change's commit.** If it gets committed, CI pgTAP goes red. S-2 needs nothing more beyond the re-run after fixes in step 8.
- **Typecheck.** Plain `npm run typecheck` fails locally only because of the stray `node_modules/@types/* 2` directories. The `--types` substitute and `typecheck:test` both exit 0, and CI's `typecheck-base` job runs on a clean `npm ci`. I accept this. The push's CI run will confirm it.
- **Prod has nothing from spec 184.** If the migration is pushed before it's applied (runbook steps 2-3), `db-migrations-applied.yml` goes red.
- **Kenyon and H Street on prod are no longer empty.** Another session used a one-time data change to copy Charles's 149 items and 154 vendor links into both stores. As a result:
  - A manual check against either store won't show the S1 empty state. Running STOCK from Charles there should say "already has everything". Any manual empty-state check on prod needs a store that really is empty.
  - The spec's "Current state" table (Kenyon 0, H Street 0) is out of date. The section 10 runbook should not treat either store as empty. Probe 2 is safe because it stocks a synthetic store, but if Step 1's "distance to the F-2 cap" read assumes 584 rows, it's wrong. Assuming the spec's 584 figure was accurate, prod is now about 882 rows (584 + 2 x 149).
  - That backfill skipped the RPC, so it wrote no `Store stocked` audit row and showed none of the result warnings. Nobody saw the AC-34 no-schedule warning for H Street (0 `order_schedule` rows, so staff EOD there still shows no vendors), and nobody saw the D-15 US Foods customer-number warning for either store. These are owner items. See the decisions list below.
  - The live prod client (feb6301) reads all-store inventory in one unpaged request. At about 882 rows it is under the 1000 cap, but one more stocked store would pass it. So D-14, with the S-1 fix, should ship before any other store is stocked on prod.

## Findings summary

- **code-reviewer: 0 Critical, 4 Should-fix, 8 Nit.**
  - Should-fix: a late stock result can land on another brand's tab (confirmed by reading the code: the `[brandId]` effect unmounts the dialog, the in-flight `submit` still calls the old `onStocked`, and `showStockPanel` bumps its own generation, so the guard doesn't catch it).
  - Should-fix: `plural` is defined twice, and `plural(n, 'of those', 'of those')` is a misuse.
  - Should-fix: the create drawer's "Stock from" list has no INACTIVE marker, but the dialog shows one.
  - Should-fix: about 40 hardcoded English strings in the dialog, drawer, panel and `stockResult.ts`, built by English-only concatenation (owner decision).
- **security-auditor: 0 Critical, 0 High, 0 Medium, 5 Low.**
  - L-1: the `Store stocked` audit row can be forged by any store member, and by a privileged caller under another user's id.
  - L-2: a stale admin JWT on a `role='user'` profile that kept its brand passes every gate. This grants nothing new, and the preview has no stale-JWT test.
  - L-3: the audit row shows the source store's name to target-store staff.
  - L-4: a copied `product_page_url` can open any http(s) host from the extension.
  - L-5: paging widens an existing race where one user's rows can land under another user when identities switch.
  - Also noted: the `max_rows` assumption at `db.ts:333`, and pre-existing H1 and `pwa-catalog` exposure.
- **test-engineer: 46 of 46 ACs PASS, 0 FAIL, 0 not tested.**
  - Full jest: 296/296 suites and 3755/3755 tests pass. `typecheck:test` and the `--types` typecheck exit 0. `test-db.sh` is 94/95 as described above.
  - Migration replay is clean and idempotent.
  - AC-45 counts as a recorded manual pass (not re-run), and AC-46 as a document. No coverage gaps. The test-engineer flagged SUBMIT COUNT at 0 items as an open observation.
- **backend-architect (post-impl): 0 Critical, 3 Should-fix, 6 Minor.** No unlisted drift. All six frontend deviations accepted, including D-15 reading through `db.ts`.
  - S-1: the D-14 short-page stop.
  - S-2: no pgTAP evidence. Answered, see above.
  - S-3: the runbook doesn't guard against committing the spec 178 test.
  - M-1: `scheduleConfigured` is a dead input.
  - M-2: the rollback text is only valid before the push.
  - M-3: `PROBE SKIPPED` is never defined.
  - M-4: no read of prod's `max_rows`.
  - M-5: three superseded passages in the design.
  - M-6: SUBMIT COUNT at 0 items writes nothing but shows the "Enter at least one count" toast.
- **Browser pass (AC-45), main Claude:** steps 1-7 passed at 1440 and 375 widths, with no console errors and 2 reloads per run.
  - Not exercised in the browser: the failed-load state, dark mode, native, a second admin's realtime view, and staff EOD at a stocked store.
  - Raised for the owner: the 11px desktop no-items message, and SUBMIT COUNT being enabled at 0 items.

### Grouped duplicates

- **The `max_rows` stop condition** comes up in four places, with one fix:
  - architect S-1 and Judgment 2 (the fix), M-4 (read prod's value) and M-5 (superseded F-2 and D-14 text);
  - the security auditor's "For code-reviewer" note on `db.ts:333`;
  - security L-5, a nearby issue: paging widens an identity-switch race, but the fix is separate;
  - the paging test notes: the `wire` fixture in `db.fetchInventoryPaging.spec184.test.ts` returns the same rows for every cursor, so it has to change first, or jest hangs under the new stop.
  - The test-engineer's report doesn't mention `max_rows` itself.
- **SUBMIT COUNT at 0 items:** the browser pass ("for the owner's eye"), architect M-6 (traced: nothing is written, and the toast shows `enterAtLeastOne`), and the test-engineer's open observation.
- **Hardcoded English:** code-reviewer Should-fix 4. The architect's Judgment 1 accepts it as matching section 6. It is also listed as a frontend deviation in `## Files changed`.
- **The forgeable `Store stocked` action:** design D-8 and security L-1, which shows D-8 understates who can forge it.
- **`plural`:** code-reviewer Should-fix 2 and the "1 of 1 are" nit. Both are copy-helper fixes in the same two files.

## Recommended next steps (ordered)

### Owner decisions (not mine; needed before or alongside the fixes)

- **OD-1. Hardcoded English in the dialog, drawer and result panel.** Either accept it as a named follow-up, or key it now with `{count}` interpolation and the `pluralKey` pattern (`BrandsSection.tsx:45`). Keying it now means rewriting `stockResult.ts`'s sentence building, which is a real chunk of work and touches fix 5. My lean is a follow-up: the spec sanctioned it, and the Brands tab is super-admin only. But this is a product call about es and zh-CN admins.
- **OD-2. How prominent the desktop no-items message is.** Today S1 and S2 are 11px text in the vendor row above a blank body. Options: leave it, or render S1, S2 and `itemsNotLoaded` as a body-level empty-state panel. Either way AC-22 holds. Only the visual weight changes.
- **OD-3. Wording of the SUBMIT COUNT toast at 0 items.** It's safe, since nothing is written, but in S1 and S2 "Enter at least one count" contradicts the banner ("nothing to count"). Options: leave it; give S1 and S2 their own toast copy (new keys in three locales); or disable SUBMIT COUNT when the state is `no_items`, `no_vendor_links` or `load_failed`. This applies to desktop and phone, which share `onSubmit`.
- **OD-4. Go-ahead for the prod apply** (section 10). Nothing goes to prod until the owner says so.
- **OD-5. Kenyon and H Street after the one-time backfill.** The backfill bypassed the result warnings, so the owner should confirm:
  - H Street needs an order schedule before staff can count there;
  - whether either store needs a US Foods `import_customer_numbers` entry (the D-15 check never ran for them).
- **OD-6. Accept the security Lows as follow-ups.** L-1 needs an RLS policy, which AC-20 rules out in this spec. L-3 matters only if store names are sensitive.

### Fix before commit

1. **D-14 stop condition (Should-fix, architect S-1 group). This goes first because it's the only finding that leaves data silently wrong.** Change `db.ts:333` to stop on an empty page, keeping the check above the `page[page.length - 1]` read. Update the comments at L282-283 and L291-292.
   - **Test work, which must land first or jest hangs:** make `wire` return an empty page once `.gt` has been called; change the request counts (L67-75 1 to 2, L77-96 3 to 4, L117-125 2 to 3); add the capped-server case (pages of 500, 500 and 31 give 1031 rows in 4 requests).
   - TypeScript only, so the recorded md5s stay valid.
   - Why before commit: the short-page stop protects only when prod's `max_rows` is at least 1000. Prod is now about 882 rows (see context), so the margin is small, and the fix costs one extra request per all-store load.
2. **Stale stock panel after a brand switch (Should-fix, code-reviewer 1).** In `StockStoreDialog.submit`, add an `isMounted` ref and skip `onStocked` and `onClose` once unmounted, or compare the report's brand to the current `brandId` in `StoresTab.onStocked`. The write and the slice reload are unaffected, so only the panel is wrong. The fix is a few lines, and that's why it's here and not a follow-up.
3. **INACTIVE marker in the drawer's "Stock from" list (Should-fix, code-reviewer 3).** `StockSourceOption.status` is already loaded. Without the marker, an admin can pick a deactivated store at create time with no cue, while the dialog shows one. Small, and it removes an inconsistency between the two entry points.
4. **Remove the dead `scheduleConfigured` input (Minor, architect M-1).**
   - Remove the field at `eodEmptyState.ts:42`.
   - Remove the argument and dependency at `EODCountSection.tsx:482` and L487.
   - Remove `base.scheduleConfigured` and the L114-116 test.
   - Keep the local memo.
   - Before commit because the API hasn't shipped yet. Later, it becomes a breaking change to a pinned test.
5. **Copy-helper cleanup (Should-fix, code-reviewer 2, plus the "1 of 1 are" nit).** Define `plural` once and import it. Write `${n} of those` directly. Pluralize the verb in "{n} of {m} are already at". **Depends on OD-1:** if the owner chooses i18n now, this folds into that rewrite. Otherwise do it as listed.
6. **Runbook and spec text (architect S-3, M-2, M-3, M-4, M-5, plus the prod context).** These are edits to the spec, so the spec's owning agent makes them, not me. They're needed before the runbook is used:
   - **S-3, Step 6:** stage the paths under `## Files changed` explicitly. Leave `supabase/tests/order_approvals_fk_set_null.test.sql` out, and don't use a broad `git add`.
   - **M-2:** after the push, rollback means a forward migration that drops both functions while the version row stays. Deleting the version row turns `db-migrations-applied.yml` red.
   - **M-3:** `PROBE SKIPPED` means fall back to Step 4 plus the local pgTAP run (spec 179 wording).
   - **M-4:** add a report-only read of prod's `max_rows` to Step 1. Doing it now is also worthwhile, because the live client is unpaged.
   - **Prod context:** Step 1's row-count read should expect about 882, not 584. Note that Kenyon and H Street are stocked, so no step should assume they are empty.
   - **M-5:** mark F-2's "harmless at any value", section 5's "until a page comes back short" and its exactly-1000-row line, and section 11's "compute from the vendors already in the slice" as superseded.
7. **Owner-chosen fixes from OD-1 to OD-3,** if the owner picks a change over "leave". Do them here, before the gates re-run, so a single run covers everything.
8. **Re-run the gates on the fixed tree (AC-44):**
   - full `npx jest`, not a subset;
   - `npm run typecheck:test`, plus the `--types` typecheck;
   - `scripts/test-db.sh`: expect 94/95, with only `order_approvals_fk_set_null` failing.
   - If fix 7 changes desktop or phone EOD layout, add a short browser check at both widths.
9. **Then, on the owner's go-ahead (OD-4), follow section 10 in order:**
   1. M-1 md5 recompute.
   2. Steps 1-5 on prod. Any `PROBE FAILED` means stop.
   3. Commit the explicit paths only.
   4. Push.
   5. Confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.
   - Main Claude doesn't auto-commit, so the user confirms the commit.

### Explicit follow-ups (not blocking ship)

- **i18n of the stock surfaces**, if OD-1 defers it. Add it to the cleanup backlog next to the InventoryCatalogMode i18n pass.
- **L-1:** a RESTRICTIVE policy `action <> 'Store stocked' OR auth_is_privileged()` on `audit_log`. It removes non-privileged forgers but not privileged ones. Needs its own spec, because it's a policy change.
- **L-2:** a stale-JWT test case for `stock_store_preview`. Leave the root cause to the queued M2 JWT/profile-staleness work.
- **L-4:** the extension should navigate only to URLs whose origin matches the adapter (`safeOrigin(url)`).
- **L-5:** bump a load generation counter when the identity changes, and check it alongside the store id.
- **Code-review nits:**
  - skip the D-15 fetch when nothing was added;
  - add a cross-reference comment in `vendorImportShared.ts`;
  - add a retry control on a failed dialog preview;
  - make the drawer's CANCEL visibly disabled while a create is in flight;
  - consider toasting "Created store" after the stock run finishes;
  - add a comment pinning `void loadFromSupabase` to never-reject;
  - add a shared `useEscape` hook.
- **Unverified in the browser:** the failed-load state, dark mode, native, a second admin's realtime view during a burst, and staff EOD at a stocked store. A good moment is the first real STOCK run on prod with a second admin signed in.

## Out of scope for this review

- **`supabase/tests/order_approvals_fk_set_null.test.sql`.** Untracked, it predates spec 184, and 8 of 12 assertions fail. It belongs to the spec 178 work and must not be committed with this change.
- **Pre-existing, from the security auditor:**
  - H1 (`Users can manage own store links` lets NULL-brand staff self-grant a store) is still open. The backlog guidance stands: no staff invites with no stores ticked.
  - `pwa-catalog` returns `cost_per_unit` and `case_price` to the service-token holder, and the PWA's handling of newly stocked stores wasn't checked.
- **From the design's section 11:**
  - `breadbot-nightly-sync` selects columns that P3 dropped and looks broken already;
  - keeping prior rows on a failed inventory reload (D-13 only makes the failure visible);
  - a store-scoped inventory load to replace the all-store reload;
  - the spec 128 "Updated" badge appearing at a new store.
- **Deferred in the spec itself:** staff EOD empty-state copy, phone S3/S4 copy, the order schedule for Frederick and Reisterstown, and stocking a brand with no stocked store (Baltimore Seafood).
- **The Kenyon and H Street backfill.** It was done in another session through a one-time data change, not this spec's RPC. This spec only needs to stay correct on top of it, and per R-4 a STOCK run there only adds what's missing.

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 6 fix-before-commit items plus owner-chosen fixes and a gate re-run, top: change the D-14 paging stop to an empty page (db.ts:333) with the paging-test fixture updated first.
payload_paths:
  - specs/184-stock-new-store/reviews/release-proposal.md

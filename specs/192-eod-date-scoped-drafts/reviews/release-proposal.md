## Verdict
verdict: SHIP_READY
rationale: No reviewer raised a Critical or High finding. All 24 ACs pass, and 24 of the 30 new arms fail against the pre-fix section, so the tests do catch the bug. The fix is client-only, and all three gates on `origin/main` (`980a79c`) are green. The only open item is one should-fix in a test, and it doesn't block shipping.

## Findings summary

- **code-reviewer:** 0 Critical, 1 Should-fix, 7 Nits.
  - **Should-fix (a test, not product code):** spec 189's edited S1 arm (`EODCountSection.resubmit.spec189.test.tsx:447-505`) no longer checks that one date's SUBMIT keeps another date's baseline. Steps 4-5 never blank a day-A row. The reviewer points out that AC-19 (`dateScoped.spec192.test.tsx:780-800`) is the real guard, and I checked that this is true. If a successful SUBMIT dropped every BJs baseline again, D-1's UPDATE COUNT would send `removed: []`, and the `toEqual(['a'])` assertion at :798 would fail. Suggested fix: add a step that blanks `p1` on day A and expects `removed == ['p1']`, and reword the arm's header comment.
  - **Judgement calls, all confirmed correct:**
    - The spec 189 S1 bug class stays closed, and AC-24 holds. A slot's baseline is created and removed with that slot's maps on every path.
    - Narrowing `dropVendorBaselines` to the submitted slot is required, not just allowed.
    - D-192-1 (`liveDayKeyRef`, skip the jump to Ordering if the day changed during the write) is correct.
    - Each submit captures its slot before the `await`.
  - **Nits:**
    - Stale comments at `EODCountSection.tsx:293-296`, `:1165` and `:1170-1176`. The last one names the removed `dropVendorBaselines` and design ids such as P10.
    - The success clear leaves `{}` entries in the maps (`:1178-1181`).
    - `onEditCurrentVendor` lists all three maps as dependencies (`:726`). This was already so at spec 189's commit.
    - `AddCountModal.onAdd` uses the render's `dayKey`. This is fine because the modal blocks a date change.
    - A history mention of the old name in `eodDraftSlot.ts:8`.
  - **Project conventions:** all clean. No new `supabase` calls, no color literals, no web-only APIs. The state rename is complete: only `savedIdsByVendor` keeps a vendor key, on purpose.

- **security-auditor:** 0 Critical, 0 High, 0 Medium, 2 Low.
  - **Low:** `admin_submit_eod` has no server-side limit on `p_date` (`20261109120000_admin_eod_replace.sql:430`). It's not an authorization gap and wasn't introduced here. Spec 189 O-2 and this spec's Out of scope both defer it. See Out of scope below.
  - **Low (missing test):** no in-flight arm switches the **store** while a write is pending. The code is safe because `submittedSlot` includes `currentStore.id` and is captured before the `await` (`:1159`, `:1083`), but no test pins that. Suggested: one arm that switches to S2 mid-flight and asserts that only S1's slot is cleared.
  - **Checked, no problem found:** 12 write and read paths, including:
    - SUBMIT, UPDATE COUNT and SAVE DRAFT
    - concurrent writes
    - the EDIT seed
    - the gate's prefix test, which includes the trailing `|` so `s1` can't match `s10`
    - the export
    - store switch
    - phone
    - + COUNT rows
    - the narrowed baseline drop. Server-side removals are also limited to the (store, date, vendor) submission.
  - **npm audit:** 46 advisories already in the dependency tree. This spec adds none.

- **test-engineer:** 24 PASS, 0 FAIL, 0 NOT TESTED. AC-22 and AC-23 come with caveats.
  - **Isolated runs:** all 30 arms in `dateScoped.spec192` (AC-1 to AC-21, AC-24, plus the D-192-1 checks) pass. So do the 7 tests in `eodDraftSlot.test.ts`. All 11 EOD suites pass together (178 tests).
  - **Fail-before check:** run independently at `97f0f17`, 24 of 30 arms fail. That matches the developer's figure, and both AC-24 arms, AC-8, AC-9 and AC-15 are among the failures. The 6 that pass are the arms that check existing behaviour still works.
  - **Typechecks:**
    - `typecheck:test` is clean.
    - Base `typecheck` shows only 24 × TS2688 errors. They come from Finder-duplicate `node_modules/@types/* 2` folders in this checkout, which is a local setup problem. CI installs fresh dependencies, so it won't see them.
  - **AC-22 caveat:** full `npx jest` was not seen green in this session. Weighing is below.
  - **AC-23:** the manual record was reviewed and accepted, but not re-run in a browser.
  - **Notes (Low):**
    - The same S1-arm weakness the code-reviewer found. The test-engineer says a regression "would pass all tests". That's too strong: AC-19 catches it, as shown above. Adding the step is still worth doing so the guard sits next to the S1 assertion.
    - The D192 suite is heavy: about 20 s alone, 130-360 s under load, with the default 5 s per-test timeout. A per-suite `jest.setTimeout` would make it sturdier.

- **manual-verification (AC-23):** passed at desktop 1440×900 and phone 390×844 on the local stack. It was driven through Playwright headless Chromium because the `preview_*` tools weren't available. The days were shifted by one (Tue/Mon/Sun) because today is Tuesday; the test shape is the same.
  - **Run 1:** Monday showed blank fields, the gate blocked the submit, and the all-NO NEED submit was dated 2026-11-09 with no Tuesday values in it.
  - **Run 2:** EDIT did not follow to Sunday, and it resumed on Monday.
  - **Header:** followed the selected day.
  - **Console and network:** no errors and no HTTP ≥ 400 responses.
  - **Cleanup:** done by exact row id. Row counts are back to the baseline, and the `inventory_items` diff is empty.
  - **Not covered in the browser:** AC-8/9 and AC-17. jest covers them.

- **backend-architect:** not run. That's appropriate: the change touches no migration, RPC, edge function, `db.ts`, `useStore.ts` or `PhoneEodCount.tsx`. The code-reviewer and security-auditor both confirmed this.

### How much weight the AC-22 full-jest caveat deserves

Not enough to block, but enough to warrant one cheap step before committing:
- **Points to the environment, not the code:**
  - Every failure the test-engineer inspected was a 5 s timeout, or a `waitFor` / `Unable to find` error that followed from one.
  - The set of failing suites changed from run to run and included unrelated ones (Settings, IngredientPhotoControl, InventoryCountSection spec 106, POsSection, useNotificationToggle).
  - Every failing EOD suite passed alone.
  - The load average was 250-340 because of other sessions.
  - The developer had a clean full run (307 suites / 3948 tests).
- **Why it still deserves a step:** the D192 suite was the one that timed out most often, and the user's standing rule is to run the full `npx jest` before committing (a stale EOD test once turned main red). A clean run on a quiet machine settles it cheaply, and `test.yml` on push is a second safety net.
- **If load stays high:** use `--maxWorkers=2`. If a quiet run can't be had at all, the developer's earlier green run is acceptable evidence, provided `test.yml` is checked right after the push.

## Recommended next steps (ordered)

1. **Before committing, run the full `npx jest` once on a quiet machine** (load average low, no other jest sessions running). Expect 307 suites / 3948 tests green, or more if other sessions have added tests since. If anything fails other than a timeout, stop and route it back to frontend-developer.
2. **Commit only spec 192's files.** The working tree holds other sessions' unrelated changes (`db.ts`, `auth.ts`, invite files, `package.json`, staff `useEodSubmit` / i18n, delete-user, and others). Stage these paths only:
   - `src/lib/eodDraftSlot.ts` (new)
   - `src/lib/eodDraftSlot.test.ts` (new)
   - `src/screens/cmd/sections/EODCountSection.tsx`
   - `src/screens/cmd/sections/eod/__tests__/EODCountSection.dateScoped.spec192.test.tsx` (new)
   - `src/screens/cmd/sections/__tests__/EODCountSection.countedOnce.test.tsx`
   - `src/screens/cmd/sections/__tests__/EODCountSection.customOrder.test.tsx`
   - `src/screens/cmd/sections/eod/__tests__/EODCountSection.countMode.spec171.test.tsx`
   - `src/screens/cmd/sections/eod/__tests__/EODCountSection.noNeed.spec172.test.tsx`
   - `src/screens/cmd/sections/eod/__tests__/EODCountSection.resubmit.spec189.test.tsx`
   - `specs/192-eod-date-scoped-drafts.md`
   - `specs/192-eod-date-scoped-drafts/reviews/` (manual-verification, the three reviewer files and this proposal, matching how the spec 196 reviews are staged)

   Before staging, run `git diff -- <path>` on each modified file above and confirm every hunk belongs to spec 192. git status lists several EOD test files as modified, and at least one other session works on EOD code (spec 193, staff). If any hunk belongs to someone else, stage with `git add -p`. Don't stage `src/screens/cmd/sections/eod/PhoneEodCount.tsx`, `db.ts`, `useStore.ts` or anything under `supabase/`. The user runs the commit.
3. **After the push**, check the latest run on `main` of `test.yml`, `db-migrations-applied.yml` and `e2e.yml`, as CLAUDE.md requires plus the e2e gate the user's notes say to check by hand. No migration ships here, so `db-migrations-applied` should stay green. Any red run comes from someone else's change and should be reported, not ignored.
4. *(Optional, non-blocking follow-up. One small test-only change, with no change to product code:)*
   - (a) Add a step to the spec 189 S1 arm: blank `p1` on day A after day B's SUBMIT, and assert `removed == ['p1']`. Reword the arm's header comment to match (code-reviewer Should-fix, test-engineer note 1).
   - (b) Add an in-flight arm that switches the store mid-write (security-auditor Low).
   - (c) Add a per-suite `jest.setTimeout` to `dateScoped.spec192` (test-engineer note 2).
   - (d) Clean up the stale comments: `EODCountSection.tsx:293-296`, `:1165`, `:1170-1176` (remove `dropVendorBaselines` / P10 / §-ids, keep the reasoning), and `eodDraftSlot.ts:8`.

   This can go into this commit if the developer is still active. Otherwise it gets its own small commit.

## Out of scope for this review

- **No server-side date limit on `admin_submit_eod` (`p_date`).** Security-auditor Low, already deferred by spec 189 O-2 and this spec's Out of scope. Worth its own spec once spec 193's staff date limit lands, so the two can match, with an explicit allowance for back-dated admin corrections.
- **Back-dated submits move live stock.** A past-date submit still moves `current_stock` / `eod_remaining` (spec 102 rule).
- **Back-dated audit rows and notification copy.** The `order_ready` notification still fires, and the "submitted today's EOD count" text is wrong for a past date (seen again during the manual pass). Spec follow-ups.
- **The week list still has hard-coded `'en'` month labels.** Same class of problem as the header fix.
- **No marker on week-list days that hold unsaved drafts.**
- **An EDIT flag or baseline can outlive a server-side change to its submission** (another device, or a realtime reload). This is the design's stated "one limit", unchanged here.
- **Rebuilding `onEditCurrentVendor` on every keystroke** (its dependency list). Already so at spec 189's commit.
- **The 46 existing `npm audit` advisories** (1 critical `shell-quote`, 17 high). For a separate dependency cleanup pass.
- **The local `node_modules/@types/* 2` duplicate folders** that cause the TS2688 errors in base `typecheck`. A fix to this checkout, not to the repo.

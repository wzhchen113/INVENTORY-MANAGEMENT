## Test report for spec 172 (EOD "NO NEED")

Verdict: all 41 ACs have covering tests and every gate is green. 41 PASS, 0 FAIL, 0 NOT TESTED.
Two ACs (AC-10 item-level, AC-14) have a coverage caveat, listed under Notes. Neither blocks.

### Acceptance criteria status

Paths: `T` = `supabase/tests/eod_no_need.test.sql`. Numbers like `(33)` are its assertion numbers.
The jest files are:
- `E` = `src/screens/cmd/sections/eod/__tests__/EODCountSection.noNeed.spec172.test.tsx`
- `SE` = `src/screens/staff/screens/EODCount.noNeed.spec172.test.tsx`
- `SN` = `src/screens/staff/screens/eod/StaffNoNeed.spec172.test.tsx`
- `H` = `src/lib/eodNoNeed.test.ts`

**Schema and write paths (pgTAP)**
- AC-1 (column `no_need boolean NOT NULL DEFAULT false`) → PASS. `T` (1)-(5), (10). (5) is scoped to quantity-bearing rows. The seed has no `eod_entries`, and smoke residue legitimately leaves NO NEED rows. NOT NULL + DEFAULT (3)(4) plus (10) pin the rest.
- AC-2 (CHECK, `23514` per numeric column, legacy null-total row stays valid) → PASS. `T` (6), (7), (8), (9).
- AC-3 a-e (staff RPC `no_need`: row, on-hand unchanged at 7, `updated_at` not bumped, audit `'NO NEED'`, omitted from `stock_updates`) → PASS. `T` (22), (23), (24), (25), (26).
- AC-4 (no `no_need` key behaves as before; the three named suites pass unmodified) → PASS.
  - `T` (27)-(30) pin the numeric path.
  - `staff_submit_eod_cases_each`, `staff_role_eod_rls` and `eod_submissions_multi_vendor` pass in the full `test:db` run, and no existing `supabase/tests/*` file is modified.
- AC-5 (`no_need` + number refused, whole call rolls back) → PASS. `T` (19), (31). The item stays at 7 in (23) after the refused call, so no on-hand leak.
- AC-6 (member INSERT allowed, non-member refused, trigger intact) → PASS. `T` (20), (21), (32).
- AC-7 (additive, re-runnable, full suite passes) → PASS. `npm run test:db` ran 90/90 files, including `permissive_policy_lint`, `po_loop`, every `report_reorder_list_*` file, `reorder_list_has_po` and `eod_count_mode`. The backend dev recorded a double-apply with an unchanged md5, and the mutation harness below re-applied the migration inside a transaction.

**Reorder "suggest 0" (pgTAP)**
- AC-8 (all-zero numerics, `suggested_cases` 0 or JSON null, `needs_order` false, `no_need` flag without `eod_missing_for_item`, `on_hand` = 2) → PASS. `T` (33)-(39).
- AC-9 (absent without `include_stocked`; hidden vendor; no KPI contribution) → PASS. `T` (43), (44), (45).
- AC-10 (as narrowed by the architect, D7) → PASS. `T` (40) V1 all-NO-NEED rolls up `'eod'`; (47) override rows on a submitted vendor roll up `'eod'`; (42) a cross-vendor override on a vendor that has not submitted stays `'stock'`. That last case is the narrowing, and it is pinned as designed. Caveat: the item payload has no per-item source key, so "item-level source" is only observable through the vendor rollup (Notes 1).
- AC-11 (cycle-scoped, `as_of_date + 1` gives suggest 8) → PASS. `T` (51), (52).
- AC-12 (shared item; both V2 variants; own numeric entry wins) → PASS. `T` (41) V2 not submitted; (46), (47) V2 submitted without X; (48), (49) V2 own numeric entry stays case A with no flag; (50).
- AC-13 (draft ignored) → PASS. `T` (53).
- AC-14 (byte-identical regression with no NO NEED) → PASS. Evidence is the unmodified `report_reorder_list_*` suites plus `reorder_list_has_po` and `po_loop` passing. There is no dedicated before/after payload diff test (Notes 2).
- AC-15 (`report_run_variance` treats NO NEED as absent) → PASS. `T` (54), (55) compare the full envelope with and without the NO NEED row.

**Shared rules (jest)**
- AC-16 (counted / entry values / toggle matrix under all three modes) → PASS. `H`: `describe.each(EOD_COUNT_MODES)` blocks for `eodRowCounted` and `eodRowEntryValues` with stale-value cases, plus "toggle transitions", which cover set-clears-both, re-tap, typing and keypad backspace.
- AC-17 (`deriveCountedItemIds` NO NEED arm, omitted arg unchanged) → PASS. `E` "deriveCountedItemIds — spec 172 noNeedByVendor (AC-17)" (2 arms) and "AC-17: a shared item marked NO NEED under one vendor tab is counted under the other". The existing `countedOnce` / `customOrder` / 171 suites are unmodified and green.

**Admin desktop (jest)**
- AC-18 a-d (control, counted, blank boxes, no `· total` suffix, gate) → PASS. `E` "AC-18: tapping NO NEED counts the row…" and "AC-18d + AC-21 … passes the gate". The 3-locale label is covered by the i18n parity tests and by the key grep (7 keys in 6 catalogs).
- AC-19 (typing clears NO NEED; tap clears number) → PASS. `E` "AC-19 / OQ-1…".
- AC-20 (disabled when locked) → PASS. `E` "AC-20: the control is disabled on a locked vendor".
- AC-21 (`buildSubmission`, Save Draft, itemCount) → PASS. `E` "AC-18d + AC-21…", "AC-21: Save Draft with only NO NEED marks…". `src/lib/db.eodNoNeed.test.ts` "itemCount still counts NO NEED entries".
- AC-22 (`submitEODCount` payload; no `inventory_items` update) → PASS. `src/lib/db.eodNoNeed.test.ts` "submitEODCount — no_need write (AC-22)" (4 arms: `no_need` on every row of a mixed batch, numerics forced null, no on-hand update, NO-NEED-only submit).
- AC-23 (optimistic `submitEOD`: no mirror, no `adjustItemStock`, audit `'NO NEED'`) → PASS. `src/store/useStore.submitEOD.noNeed.spec172.test.ts` (3 arms).
- AC-24 (footer `estValue` / `variance` exclude NO NEED) → PASS. `E` "AC-24…". It fails under mutation (below).
- AC-25 (locked view blank and active-disabled; EDIT prefill no `"0"`) → PASS. `E` "AC-25: a locked NO NEED entry…", "AC-25: EDIT prefill seeds the NO NEED state…".
- AC-26 (three read mappers surface `noNeed`, never `actualRemaining: 0`) → PASS. `src/lib/db.eodNoNeed.test.ts`: `describe.each(READERS)` over `fetchTodaysEODForStores`, `fetchRecentEODSubmissions` and `fetchEodSubmissionsForStores`. Arms: selects `no_need`, null + `noNeed: true`, numeric rows have no `noNeed` key, itemCount.

**Numeric consumers (jest)**
- AC-27 (identical output with and without a NO NEED entry) → PASS, per call site:
  - `getStockSeries`, `computeVarianceLines` (both modes), `computeCogsActual`, `computeTopVarianceItems`, `computeStoreFoodCostVariancePp` (with POS revenue, and the `entries.length` proxy), `computeStoreFoodCostSeries`, the scoped wrappers, and no-mutation of the input → `src/lib/cmdSelectors.eodNoNeed.test.ts` (11 tests).
  - Opening-stock and variance paths in `usageCalculations` → `src/utils/usageCalculations.eodNoNeed.test.ts` (3 tests). Closing count, opening stock, NO-NEED-only end date.
  - Reconciliation counted/delta math → `src/screens/cmd/sections/__tests__/ReconciliationSection.eodNoNeed.spec172.test.tsx`. Render-pair identity on variance, byCategory and timeline, plus "items reconciled 1 / 1, not 2 / 2".
  - A grep of every remaining `actualRemaining` / `actual_remaining` reader outside tests found each one guarded: null-aware, narrowed by `isNumericEodEntry`, or fed `numericEodSubmissions`. `npm run typecheck` is clean with the widened type.

**Admin phone (jest)**
- AC-28 (row control, no keypad, blank wells) → PASS. `E` "AC-28…".
- AC-29 (sheet `eod-sheet-noneed`: mark + advance, closes on last, label in total, digit clears) → PASS. `E` "AC-29 / OQ-5…", "AC-29: while NO NEED the running total…".
- AC-30 (`isDone` / `advanceUncounted` / "N left / ready"; locked row never `0`) → PASS. `E` "AC-30: a locked NO NEED entry…", "AC-30: a locked numeric row shows no NO NEED control", and the READY caption assert in AC-28.

**Staff app (jest)**
- AC-31 (row control + sheet button, optional props, existing `StaffEodCountRow` arms untouched) → PASS. `SN` (9 arms: omitted-when-no-callback, label + aria, active suppresses total, locked + noNeed disabled, locked without hidden, sheet button, total label). `SE` "AC-31/32…".
- AC-32 (`isCounted` / `countedNum` / `isBlank` gate / builder shape / only-NO-NEED guard) → PASS. `SE` "AC-31/32: tapping NO NEED…submits the NO NEED shape", "AC-32: a worksheet of ONLY NO NEED marks passes the gate + the 'no counts' guard".
- AC-33 (`fetchExistingSubmission` selects `no_need`; seed restores without `"0"`; EDIT then Cancel; synthesized-after-submit and queued) → PASS. `SE` "§3.5: the existing-submission embed selects no_need", "AC-33: an existing NO NEED entry renders locked…EDIT→Cancel keeps it", "AC-33: a queued NO NEED submit locks and still shows NO NEED".
- AC-34 (queue validator accepts the shape; drain carries `no_need: true`; old arms unmodified) → PASS.
  - `src/screens/staff/lib/eodQueue.test.ts`: describe "eodQueue — NO NEED entries (spec 172)", 6 new arms, additive only (+70 / −0).
  - `src/screens/staff/hooks/useEodSubmit.test.ts`: describe "useEodSubmit — NO NEED (spec 172)", online and drain, additive only (+86 / −0).

**Spec 171 interaction**
- AC-35 (all three modes; stale disabled-box value cannot un-set NO NEED) → PASS. `H` mode matrix, `E` `it.each(['cases_only','units_only','cases_and_units'])` plus "AC-35: a stale disabled-box value…", `SE` `it.each` over the modes. The 171 suites pass unmodified.

**Reorder surfaces**
- AC-36 (`FlagChip` "NO NEED") → PASS. `src/screens/cmd/sections/__tests__/ReorderSection.noNeed.spec172.test.tsx` "AC-36…".
- AC-37 (`lastOrderContext` delta suppressed for `no_need`) → PASS. `src/utils/lastOrderContext.noNeed.spec172.test.ts` (control, suppression, rest of line unchanged).
- AC-38 (label replaces on-hand, admin "Have enough" and staff `Reorder.tsx`) → PASS. `ReorderSection.noNeed.spec172` "AC-38…". `src/screens/staff/screens/Reorder.noNeed.spec172.test.tsx` has 2 arms, including an `es` localization arm.

**Count export**
- AC-39 (blank case/unit cells, localized "NO NEED" in Counted Total; `inventoryCount` unchanged) → PASS. `src/utils/countExport.noNeed.spec172.test.ts` (5 arms: en, numeric row unchanged, es/zh-CN, PDF, `inventoryCount` ignores the flag) and `E` "AC-39: the CSV export…".

**Regression gates**
- AC-40 (no NO NEED marks means no behavior change; existing suites pass unmodified) → PASS.
  - Full jest is green, including the admin and staff i18n parity tests.
  - Only 2 pre-existing test files are touched (`eodQueue.test.ts`, `useEodSubmit.test.ts`). `git diff --cached --numstat` shows additions only (+70 / −0 and +86 / −0).
  - Every other test change is a new file.
- AC-41 (jest, both typechecks, `test:db`, smoke) → PASS. See Test run. The smoke has a NO NEED arm (step 8b: 200, empty `stock_updates`, on-hand still 7, row `no_need=true` with NULL numerics).

### Test run
- `npx jest` (before my addition): 254 suites passed, 3173/3173 tests passed. After staging my 1 new file: 255 suites, 3175/3175 tests.
- `npm run typecheck`: exit 0.
- `npm run typecheck:test`: exit 0, also re-run after adding my test file.
- `npm run test:db`: 90/90 DB test files passed. `eod_no_need.test.sql` passed 55/55.
- `bash scripts/smoke-staff-eod.sh`: exit 0, all checks passed, including step 8b and the three 410 stubs.

**Mutation checks** (each restored afterwards; `git diff --stat` shows no unstaged change)

SQL mutations ran inside one transaction against the live local DB. I prepended `begin;` to a copy of the migration with `begin;` / `commit;` removed and one line mutated, then piped the pgTAP file after it. The file's own `rollback` undoes the mutated function. After the runs, `test-db.sh eod_no_need.test.sql` passed 55/55 again. A control run with no mutation had 0 failures.

| Mutation | Result |
|---|---|
| `staff_submit_eod`: drop `and not coalesce(v_entry.no_need,false)` from the on-hand UPDATE (S3) | FAIL 2/55: (23) AC-3b `current_stock` unchanged and (24) AC-3c `updated_at` not bumped |
| `report_reorder_list`: disable the `no_need_for_item` zeroing in `par_replacement` (R3) | FAIL 9/55: (33), (34), (36), (41), (43), (44), (45), (46), (50), i.e. AC-8, AC-9 and AC-12 |
| `db.ts` `submitEODCount`: delete `if (entry.noNeed) continue;` | FAIL 2/16: "performs NO inventory_items update" and "NO-NEED-only submit writes no on-hand" |
| `cmdSelectors.ts`: remove the `numericEodSubmissions` strip at each of the 5 sites (L32, L364, L473, L521, L622) | FAIL each time, with the matching AC-27 arm (`getStockSeries`, `computeVarianceLines` x2, `computeCogsActual`, `computeTopVarianceItems`, `computeStoreFoodCostVariancePp` x2, scoped wrappers) |
| `usageCalculations.ts`: remove the strip in `buildReconciliationLines` | FAIL 3/3 |
| `EODCountSection.tsx`: `localHasCount` includes NO NEED (AC-24) | FAIL 1/24, "AC-24: the footer est. value / variance exclude a NO NEED row" |

I did not mutate the `useStore.submitEOD` guard, `isValidEodEntry` or the `eodQueue` / `useEodSubmit` paths (the backend dev mutation-checked only the ReconciliationSection guards). Those paths are covered by dedicated arms but not mutation-proven.

**PhoneWeeklyCount has no NO NEED control (user-requested check)**
- Existing `PhoneWeeklyCount.test.tsx` and `.acReg.test.tsx` made no direct NO NEED absence assertion.
- The only related assertion was `PhoneKeypadSheet` without `onNoNeed` renders no `eod-sheet-noneed` (`E`, "PhoneKeypadSheet — spec 172 opt-in"). That tests the component contract, not the weekly surface.
- I added `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.noNeed.spec172.test.tsx` (new file, staged, 2 tests):
  - rows render no `eod-noneed-<id>` and no "NO NEED" text;
  - the sheet opened from a weekly well has the digit pad but no `eod-sheet-noneed`.
- Mutation: passing `onNoNeed` to `PhoneKeypadSheet` in `PhoneWeeklyCount.tsx` makes the sheet test fail 1/2. I restored the file.

### Notes
1. **AC-10 and the architect's D7 narrowing.** The item payload carries no per-item source key (only `ioh.item_on_hand_source` internally, then a vendor rollup `on_hand_source`), so "item-level source `'eod'`" is not directly observable. Coverage is vendor-level only: (40), (42), (47). The ACs are satisfied as narrowed. If the owner reverses D7 (OQ-A, a one-line SQL change), (42) must flip from `'stock'` to `'eod'`.
2. **AC-14 byte-identical output** is proven only by the existing reorder suites staying green. There is no dedicated snapshot of the pre-172 vs post-172 envelope for a no-NO-NEED fixture. Existing suites assert many envelope fields, and the backend dev's before/after `pg_functiondef` diff showed only hunks R1-R4. Acceptable. A cheap hardening, if wanted later, is a golden-envelope pgTAP.
3. **AC-6** pins no SQLSTATE for the non-member case, as the design intended, since the trigger and RLS can race for which raises first.
4. **Frameworks and gaps.** No new framework was introduced: jest, pgTAP and shell smoke only. Native (iOS/Android) rendering of the new controls is untested. The jest suite runs RN on react-native-web; the frontend dev browser-verified desktop and phone widths, but not the staff screen. This was the same already-known gap as prior specs, and I am not raising it as a blocker.
5. **Not verified by me:** the §9 prod normalized-md5 pre-check and the prod apply. Those are owner-gated MCP steps. Local md5s from the backend notes: `staff_submit_eod` pre `c7a6f379…` / post `41220a3f…`; `report_reorder_list` pre `15eaff54…` / post `395f8831…`. **Deploy order is load-bearing: apply the migration to prod before pushing the client**, or `db-migrations-applied` goes red and a new client hits an old DB. After the push, check `test.yml`, `db-migrations-applied.yml` and `e2e.yml`.
6. **Unrelated residue.** The empty `specs/172-eod-no-need/reviews/` directory was untracked before I wrote this file. `scripts/smoke-staff-eod.sh` leaves non-transactional local residue (that item's on-hand stays at 7, plus NO NEED rows). It is documented by the backend dev and is why pgTAP (5) is scoped. The mutation harness is rolled back and leaves nothing behind.
7. **Files staged by me:** `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.noNeed.spec172.test.tsx`. This report file is not staged. I committed nothing.

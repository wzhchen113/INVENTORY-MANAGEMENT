## Test report for spec 171 (re-verification after Review-fix round 1)

### Acceptance criteria status

Paths: `S171` = `src/screens/cmd/sections/eod/__tests__/EODCountSection.countMode.spec171.test.tsx`; `PG` = `supabase/tests/eod_count_mode.test.sql`; `HELP` = `src/lib/eodCountMode.test.ts`; `DB` = `src/lib/db.eodCountMode.test.ts`; `STAFF` = `src/screens/staff/screens/EODCount.test.tsx` (describe "EODCount — spec 171 count mode"); `WEEKLY` = `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.test.tsx`; `KEYPAD` = `src/lib/eodKeypad.test.ts`.

AC-1 to AC-8 and AC-10 to AC-22 are unchanged from my previous run. Review-fix round 1 touched no SQL, and I re-ran every suite below.

- AC-1 (column exists, text, NOT NULL, default) → PASS — `PG` (1)-(4).
- AC-2 (CHECK admits the 3 values; 23514 on bad, 23502 on NULL) → PASS — `PG` (5)-(9).
- AC-3 (existing rows backfilled; omitted column reads default) → PASS — `PG` (10), (11).
- AC-4 (staff reads mode via embed path; staff UPDATE refused) → PASS — `PG` (12)-(15).
- AC-5 (additive, re-runnable; existing pgTAP unchanged) → PASS — `npm run test:db` 89/89, and `PG` (24) asserts exactly one RPC overload. The earlier `psql -v ON_ERROR_STOP=1` re-apply is still valid because the migration file is unchanged.
- AC-6 (effective-mode helper matrix) → PASS — `HELP` "effectiveEodCountMode — AC-6 matrix".
- AC-7 (total / counted / entry values per mode) → PASS — `HELP` `eodHasEntry` / `eodTotal` / `eodEntryValues`; `S171` cases_only draft payload; `STAFF` cases_only and default arms.
- AC-8 (initial keypad field from effective mode, at every call site) → PASS
  - `KEYPAD` "activeFieldFor — spec 171 count-mode arg".
  - Admin phone pending-focus, advance and clamp: `S171`.
  - Staff pending-focus: `STAFF`.
  - Staff advance is covered only by the shared clamp. The `clampActiveField` helper now has direct unit tests in `KEYPAD`.
- AC-9 (PhoneWeeklyCount behavior unchanged; existing `activeFieldFor(caseQty)` tests unmodified; optional mode arg) → **PASS at both the helper level and the component level (re-scored; was FAIL at component level after round 0)**
  - Helper level:
    - `git diff --cached` of `src/lib/eodKeypad.test.ts` and `src/screens/staff/lib/eodKeypad.test.ts` shows 0 removed lines, so the pre-existing assertions are unmodified.
    - `activeFieldFor` still accepts one argument and `PhoneWeeklyCount.tsx` itself is unmodified.
  - Component level: `WEEKLY` describe "PhoneWeeklyCount — spec 171 count mode does not leak into the weekly sheet" runs 3 tests for each of `units_only` and `cases_only`, so 6 tests, all on a caseQty-24 item.
    1. Opening the CS well renders BOTH sheet wells (`eod-sheet-well-cases` and `eod-sheet-well-units`), and a digit writes via `setCaseCounts` only.
    2. Opening the units well renders both wells, and a digit writes via `setUnitCounts` only.
    3. A blocked submit (one-arg `activeFieldFor` seats cases) leaves a rendered, typeable well, and the digit writes.
  - Helper tests for the review-fix additions, in `KEYPAD`:
    - `eodBoxesFor`: modes, omitted or null stored mode giving the legacy layout, and caseQty ≤ 1 forcing units only.
    - `clampActiveField`: enabled seat kept, disabled seat re-seated, legacy layout when the stored mode is omitted.
  - Mutation check (below) confirms the weekly tests have teeth.
- AC-10 (desktop row disabled box) → PASS — `S171` AC-10 arms.
- AC-11 (gate jump focuses the enabled input) → PASS — `S171` AC-11.
- AC-12 (`deriveCountedItemIds` ignores disabled-box values) → PASS — `S171` "deriveCountedItemIds — spec 171 effectiveModeOf (AC-12)" plus the unmodified `countedOnce` and `customOrder` suites. Residual: there is no multi-tab integration arm; the pure helper arms cover the logic.
- AC-13 (admin phone row + sheet omit the disabled well) → PASS — `S171` AC-13 row and sheet arms. After the fix, `PhoneEodCount` passes the explicit `countMode` prop, and those arms still pass.
- AC-14 (staff row + sheet) → PASS — `StaffEodCountRow.test.tsx` and `StaffKeypadSheet.test.tsx`, spec-171 describes. `StaffKeypadSheet` now uses `eodBoxesFor` and still passes.
- AC-15 (staff fetch selects the mode; EodItem carries it) → PASS — `STAFF` AC-15 and the mode arms.
- AC-16 (stale value in a now-disabled box) → PASS — `HELP`, `S171`, `STAFF` and the clamp test.
- AC-17 (IngredientForm control) → PASS — `IngredientForm.spec171.test.tsx` (8 tests). Passing `EOD_COUNT_MODE_OPTIONS` directly to `SelectField` still passes.
- AC-18 (persist via update and create) → PASS — `DB`, `IngredientFormDrawer.spec171.test.tsx` (the drawer now uses `DEFAULT_EOD_COUNT_MODE`) and `PG` (16)-(20).
- AC-19 (`fetchInventory` embed and `eodCountMode` mapping) → PASS — `DB`.
- AC-20 (locked count renders stored values; OQ-A amendment) → PASS — `S171` AC-20, OQ-A and `unitsDisplayFor` arms; `STAFF` AC-20 + AC-16.
- AC-21 (default-mode behavior identical; existing EOD suites unmodified) → PASS — no assertion in any pre-existing EOD test was removed or changed (see Notes for the one non-assertion exception).
- AC-22 (full jest, both typechecks, pgTAP, staff-EOD smoke) → PASS — see Test run.

Summary: 22 PASS, 0 FAIL, 0 NOT TESTED. The AC-9 component-level regression found in the earlier round is closed.

### Test run

- `npx jest` (full): 240/240 suites, 2967/2967 tests, 2 snapshots, exit 0. This is 12 more tests than the previous 2955: 6 `WEEKLY` arms and 6 `KEYPAD` helper tests.
- `npm run typecheck`: exit 0.
- `npm run typecheck:test`: exit 0.
- `npm run test:db`: 89/89 DB test files passed (local stack up, 12 imr-inventory containers).
- `bash scripts/smoke-staff-eod.sh`: "all checks passed", exit 0.

**Mutation check (AC-9 component level)**
- Mutation: in `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx`, changed the default arm from `eodBoxesFor(item.caseQty)` to `eodBoxesFor(item.caseQty, item.eodCountMode)`.
- Result: `PhoneWeeklyCount.test.tsx` gave 6 failed and 13 passed. Exactly the 6 spec-171 `WEEKLY` arms failed (3 for `units_only`, 3 for `cases_only`), and the pre-existing weekly tests still passed.
- Restore: `git checkout --` on that file. Then `git diff` printed nothing (no unstaged change), `cmp` against a pre-mutation copy confirmed the file is identical, and `git status` shows the same staged set as before (the only untracked paths are `specs/171-eod-count-mode/` and `specs/172-eod-no-need.md`).

### Notes

1. The only edits I made this run are the temporary mutation (reverted) and this report. I did not touch `specs/172-eod-no-need.md`.
2. The one removed line in a pre-existing test remains `select: () => builder,` in `EODCount.test.tsx`. It is the mock query builder, changed to record `select()` args, not an assertion.
3. Still not covered by automated tests (non-blocking, as before):
   - Staff advance has no dedicated test; it relies on the shared clamp, which is now directly unit-tested.
   - The staff app was not browser-verified (no local `order_schedule` fixtures).
   - There is no native testing.
   - Realtime delivery of a mode change was verified by hand only.
   - The frontend-developer's browser check of the weekly screen (both wells, 28 total) is not something I re-ran; the jest arms are my evidence.
4. Deploy and CI preconditions are outside this report:
   - The migration is not applied to prod.
   - The prod-body md5 pre-check (architect S1) has not been run.
   - Nothing has been pushed, so I did not check `test.yml` or `db-migrations-applied.yml`.

## Handoff
next_agent: NONE
prompt: Test report complete. 22 PASS, 0 FAIL, 0 NOT TESTED across acceptance criteria. AC-9 is re-scored PASS at the component level. Full jest 240 suites / 2967 tests, both typechecks, pgTAP 89/89, and the staff-EOD smoke are green. The mutation check confirmed the 6 new PhoneWeeklyCount arms fail when PhoneKeypadSheet's default arm reads item.eodCountMode, and the file was restored with no unstaged diff.
payload_paths:
  - specs/171-eod-count-mode/reviews/test-engineer.md

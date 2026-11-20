## Test report for spec 192

Reviewed 2026-11-10 against the shared working tree (HEAD `fa6171c`, spec 192 changes uncommitted). Source not edited.

### Acceptance criteria status

All automated ACs live in `src/screens/cmd/sections/eod/__tests__/EODCountSection.dateScoped.spec192.test.tsx` (abbreviated `D192` below) unless noted. Every one was run and passed in isolation (11 suites / 178 tests, see Test run).

- AC-1: typed values hidden on D-1, back on D0 → PASS — `D192::AC-1: values typed on D0 are blank on D-1 ...`
- AC-2: note + NO NEED per date → PASS — `D192::AC-2: a note and a NO NEED mark on D0 ...`
- AC-3: D-1 SUBMIT ships only D-1 values, dated D-1, D0 intact → PASS — `D192::AC-3 (run 1 negative) ...`
- AC-4: gate / counter / `deriveCountedItemIds` arms (a)(c) day-filtered, arm (b) unchanged → PASS — `D192::AC-4 ...` (rendered) plus the pure arm in `src/screens/cmd/sections/__tests__/EODCountSection.countedOnce.test.tsx` (other date, other store, prefix store id `store-10`, arm (b))
- AC-5: vendor-tab drafts kept within a date, counted-once across tabs → PASS — `D192::AC-5 ...`
- AC-6: successful SUBMIT clears only its slot → PASS — `D192::AC-6 ...`
- AC-7: CSV export holds only the selected date's values → PASS — `D192::AC-7 ...`
- AC-8: in-flight submit across date change (dated D-1, only D-1 cleared, D0 untouched, toast names D-1) → PASS — `D192::AC-8 ...`; D-192-1 guard covered by that arm and the two "D-192-1" jump-still-happens arms
- AC-9: rejected write keeps slot + EDIT; SAVE DRAFT too → PASS — `D192::AC-9 ...` and `D192::AC-9 (SAVE DRAFT) ...`
- AC-10: EDIT does not follow to D-2; D-2 submits only its own values → PASS — `D192::AC-10 (run 2 negative) ...`
- AC-11: EDIT resumes on return → PASS — `D192::AC-11 ...`
- AC-12: D-3 stays locked, shows its own submitted values → PASS — `D192::AC-12 ...`
- AC-13: EDIT seeds only its own slot → PASS — `D192::AC-13 ...`
- AC-14: UPDATE COUNT ends EDIT for that slot only → PASS — `D192::AC-14 ...`
- AC-15: desktop header = selected date in app locale (en and es, D0 and D-1) → PASS — `D192::AC-15 ...` (expected string computed independently with the same expression, so ICU-independent)
- AC-16: phone header unchanged → PASS — `D192::AC-16 ...`
- AC-17: store switch (EDIT and drafts stay on S1, S2 opens by own status, never editing) → PASS — `D192::EDIT and typed values on S1 stay on S1 ...` and `D192::S2 with its own submission on D-1 opens locked ...`
- AC-18: phone repeat of AC-1, 3, 10, 11 through the full section with `mockIsPhone = true` → PASS — `D192` describe "phone — spec 192 (AC-18)", 4 arms. AC-3/10/11 enter values through the keypad sheet. AC-1's phone arm seeds values by key rather than through the sheet; minor, the same slot readers are exercised.
- AC-19: blank in D-1 EDIT, D-2 submit has no removal, D-1 UPDATE COUNT sends it dated D-1 → PASS — `D192::AC-19 ...`
- AC-20: value under another category pill on D0 does not ship with D-1 submit → PASS — `D192::AC-20 ...`
- AC-21: + COUNT row per (store, date), shared across vendor tabs → PASS — `D192::a + COUNT row on D0 is not on D-1 ...`
- AC-22: existing EOD suites pass; full jest + both typechecks → PASS with a caveat on full jest. The EOD suites (countedOnce, customOrder, emptyState.spec184, acReg, countMode.spec171, noNeed.spec172, PhoneEodCount, PhoneType, resubmit.spec189) all pass. `typecheck:test` is clean. Base `typecheck` has only the pre-existing environment errors (below). Full `npx jest` could not be observed green in this session because of machine load (below); I treat that as an environment limit, not a spec 192 failure, but the release-coordinator should rely on the developer's earlier green 307 / 3948 run or a re-run on a quiet machine.
- AC-23: browser pass (manual) → PASS as documented — `specs/192-eod-date-scoped-drafts/reviews/manual-verification.md`. I did not re-drive the browser. Reviewed the record: desktop run 1 and run 2, and a phone pass, all with the expected results; it used Mon/Tue/Sun in place of the spec's Sun/Mon/Sat because today is Tuesday (equivalent shape); cleanup by exact row id with counts restored to the baseline; it was driven through Playwright headless Chromium rather than `preview_*` (no repo change). AC-8/9, AC-17 are jest-only, as stated in that file.
- AC-24: blank on D-1 does not become a removal of a D0 baseline value (SAVE DRAFT-saved, and EDIT-seeded) → PASS — `D192::AC-24 ... SAVE DRAFT value on D0` and `D192::AC-24 ... EDIT-seeded value on D0`

Totals: 24 PASS, 0 FAIL, 0 NOT TESTED (AC-22 and AC-23 carry the caveats above).

### Test run

- `npx jest src/lib/eodDraftSlot.test.ts src/screens/cmd/sections` (quiet moment): 87 suites / 845 tests passed.
- `npx jest --maxWorkers=2 --testTimeout=60000 src/screens/cmd/sections/__tests__/EODCountSection src/screens/cmd/sections/eod src/lib/eodDraftSlot`: **11 suites / 178 tests passed** (includes `eodDraftSlot.test.ts` 7 tests and the 30-arm D192 suite).
- `npx jest ...resubmit.spec189 ...dateScoped.spec192` (together): 2 suites / 45 tests passed.
- `src/screens/staff/screens/EODCount.noNeed.spec172` alone: 11 passed (it failed once in a loaded full run, a file this spec did not touch).
- `npm run typecheck:test`: clean (no output).
- `npm run typecheck`: exactly **24 errors, all TS2688 "Cannot find type definition file for '<pkg> 2'"**. I checked that no error is any other code (0 non-TS2688 lines) and that none names a folder without the ` 2` suffix. There are 24 `node_modules/@types/* 2` directories. Nothing was deleted. This is the only cause, as the developer reported.
- **Full `npx jest`, four runs, none clean.** The machine's load average was 250 to 340 for the whole session (other sessions running jest and more). Run 1 (while I was also running a worktree jest): 2 suites failed, 8 tests (189 resubmit and D192). Run 2: 1 suite, 7 tests (D192, 130 s suite time). Run 3: 8 suites, 25 tests, including unrelated suites (Settings, IngredientPhotoControl, InventoryCountSection spec 106, POsSection, useNotificationToggle). Run 4 (`--maxWorkers=4`): 7 suites, 21 tests. Every failure I inspected was `Exceeded timeout of 5000 ms` or a `waitFor`/`Unable to find` consequence of it. The set of failing tests changed from run to run, and every failing EOD suite passes in isolation. No failure was in a file this spec didn't touch that I could attribute to a non-timeout cause. Nothing outside the spec's footprint was fixed.
- **Fail-before check:** I copied `eodDraftSlot.ts` and the D192 suite into a detached worktree at `97f0f17` (spec 189's commit, pre-fix section), symlinked `node_modules`, ran the suite, then removed the worktree. Result: **24 failed, 6 passed, 30 total**, which matches the developer's claim. The 6 that pass are the non-regression arms: AC-5, AC-11 (desktop and phone), AC-16, and the two D-192-1 jump-still-happens arms. Both AC-24 arms fail pre-fix, as do AC-8, AC-9 and AC-15, so those ACs do guard the bug. The worktree was removed (`git worktree list` shows only the main checkout and an unrelated pre-existing one).
- Grep check: in `EODCountSection.tsx`, `ByVendor\b` remains only as `savedIdsByVendor` (intended, spec 103), and `editingVendorIds` is gone.

### Notes

1. **189 S1 arm still exercises the class, with one weaker spot (Low, non-blocking).** The edited arm keeps its purpose: day A draft saved, day B submitted, back to A, count the one remaining row, and assert no removal of the drafted rows (steps 4 and 5 unchanged). It now also guards the new failure mode, because step 3 asserts A's values `5`/`6` survive day B's submit, so over-clearing would fail it. It no longer distinguishes "A's baseline was dropped" from "A's baseline survived": step 4 never blanks a drafted row, so a regression back to dropping every date's baseline on a successful submit (the pre-192 `dropVendorBaselines` behaviour that the developer narrowed to the submitted slot) would pass all tests. The effect would be that blanking a saved row on another date after a different date's submit is read as "never touched" and silently keeps the count. I reasoned this from the code and tests and did not mutate the source to prove it. Suggested follow-up: one extra step in that arm that blanks `p1` on day A after day B's submit and expects `removed` to contain `p1`.
2. **D192 suite is heavy (Low, CI risk).** It takes about 20 s alone, but 130 to 360 s when the machine is loaded, and its arms use the default 5 s per-test timeout. It was the suite most often timing out under load. Healthy CI should be fine, but an explicit per-suite `jest.setTimeout` would make it robust. Not a correctness issue.
3. Every AC maps to jest, as the spec says. No pgTAP or shell smoke is needed (client-only, no migration). No new framework was introduced.
4. The 189 P9 edit (steps 2 and 3 of the S1 arm) is justified and documented in the arm's comment, and the justification matches the observed 24 pre-fix failures (the arm relied on the leak).
5. The release-coordinator should still run the CI status check on `main` (`test.yml` and `db-migrations-applied.yml`) after any push, as CLAUDE.md requires. Nothing was pushed here.

## Handoff
next_agent: NONE
prompt: Test report complete. 24 PASS, 0 FAIL, 0 NOT TESTED across acceptance criteria (AC-22 caveat: full jest not observed green here due to ~280 machine load, all failures were 5 s timeouts, EOD suites pass in isolation; AC-23 manual record reviewed, not re-driven).
payload_paths:
  - specs/192-eod-date-scoped-drafts/reviews/test-engineer.md

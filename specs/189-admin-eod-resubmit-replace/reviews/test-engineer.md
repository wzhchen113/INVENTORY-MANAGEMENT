## Test report for spec 189

Wordings applied: design section 12 (R1, D-4, AC-3, AC-4, AC-7, AC-8, AC-15, AC-21, AC-24, AC-25, AC-26, AC-31), plus AC-33 and AC-34 (O-1 approved by owner 2026-11-09).

### Acceptance criteria status

pgTAP file: `supabase/tests/admin_submit_eod.test.sql` (96 arms, all pass). Shown below as `ASE#n`.
All "survived / removed" arms read back as postgres after `reset role`.

| AC | Status | Test file and arm |
|---|---|---|
| AC-1 EDIT replace | PASS | ASE#35 |
| AC-2 draft then submit | PASS | ASE#42, #43 |
| AC-3 admin over staff (sec.12 wording) | PASS | ASE#25 (rows remain, change applied, cleared row gone), #27 client_uuid kept, #32 replay returns conflict true, #33 replay leaves admin entries |
| AC-4 left-out item (sec.12 wording) | PASS | ASE#44, #45 (named: gone, on-hand kept), #46, #47 (not named: untouched). Also #31 |
| AC-5 payload fidelity | PASS | ASE#48, #49 |
| AC-6 id preserved, one parent, approval link | PASS | ASE#26, #36, #37, #38 |
| AC-7 submitted_by (sec.12 wording) | PASS | ASE#39 (admin), #34 (after admin over staff), #18 (staff, p_submitted_by names someone else) |
| AC-8 on-hand, primary and non-primary, last_updated_by | PASS | ASE#40, #41, #50, #29 (admin). #19 (staff: last_updated_by unchanged) |
| AC-9 off-vendor | PASS | ASE#51, #52 |
| AC-10 NO NEED and null-total guard | PASS | ASE#49, #51, #20 (staff null-total gains guard) |
| AC-11 last-entry failure rolls back (23514) | PASS | ASE#54, #55 (old literal submitted_at, row-by-row, no new notification) |
| AC-12 cross-store 42501 | PASS | ASE#56, #57 |
| AC-13 role user refused | PASS | ASE#58, #59 |
| AC-14 privileged but cannot see store | PASS | ASE#60, #65 |
| AC-15 catalog (sec.12 wording) | PASS | ASE#1-#13 (prosecdef, proconfig, EXECUTE for anon, authenticated, service_role on both functions; staff_submit_eod still definer, authenticated-only; index exists) |
| AC-16 no DELETE or ALL policy, direct delete removes 0 | PASS | ASE#14, #15 |
| AC-17 run_variance | PASS | ASE#86, #87, #88 (vs control; sign not flipped) |
| AC-18 reorder_list | PASS | ASE#89-#93 (one row, suggested_qty, item_count, estimate match control) |
| AC-19 weekly_lowstock | PASS | ASE#94, #95 |
| AC-20 locked screen, EDIT seed, day tile | PASS | jest `EODCountSection.resubmit.spec189.test.tsx` "after a re-submit (AC-20 / AC-23)". Manual in AC-28 step 1 |
| AC-21 mock no longer treats eod_entries delete as success (sec.12 wording) | PASS | jest `src/lib/db.eodNoNeed.test.ts` describe "submitEODCount - admin_submit_eod RPC". `afterEach` fails on any direct table op or `supabase.from`. Arms: no_need on every row, null numerics on NO NEED, null total passes through. On-hand arms moved to pgTAP ASE#49-#51 |
| AC-22 rejected write, SUBMIT and SAVE DRAFT | PASS | jest `EODCountSection.resubmit.spec189.test.tsx` "failure path": UPDATE COUNT rejected, first SUBMIT rejected, SAVE DRAFT rejected, undo called once. Also `useStore.submitEOD.undo.spec189.test.ts` "undo" arms |
| AC-23 slice matches server without reload | PASS | jest `useStore.submitEOD.undo.spec189.test.ts` "removal merge" arms, plus the section test above |
| AC-24 audit feed (sec.12 wording) | PASS | Server: ASE#30 (one `Count cleared` row with removed value), ASE#96 (admin path writes no per-entry server audit row). Client: `useStore.submitEOD.noNeed.spec172.test.ts` (one row per entry), `useStore.submitEOD.undo.spec189.test.ts` "Count updated" arm. **Gap found and closed:** the first-submit `Remaining count submitted` wording was not pinned anywhere. Test added (see Notes). Staff audit rows: ASE#16-#24 staff arms and the unmodified staff suites |
| AC-25 D-4 change set (sec.12 add: no RPC on no-change) | PASS | jest `EODCountSection.resubmit.spec189.test.tsx` "change set (AC-25)": no-change under a pill issues no write; change one row ships only that row, other categories and the off-vendor row stay; blank-only correction; draft, reload, count rest; first SUBMIT ships other pills; same-session draft cases; seed fix. Pure logic: `src/lib/eodChangeSet.test.ts` (34 tests). Blank-only correction server side: ASE#75, #76 |
| AC-26 notifications (sec.12 add: no-change gives no row) | PASS | ASE#82-#85 (first, edit, draft save, draft to submitted). "EDIT with no changes gives no row" is the no-RPC arm in the AC-25 jest test, since no write is issued. Existing `eod_update_notifications.test.sql` passes (33) |
| AC-27 unique index 23505, D1/D2 rewritten | PASS | ASE#66 (table), #67 (writer), #68, #69 (re-submit still works). `report_last_order_context.test.sql` D1, D2 kept with the reason, D3 added (42 pass) |
| AC-28 manual browser pass | PASS with one named gap | `reviews/manual-verification.md`: steps 1-6 pass. See step 7 note below |
| AC-29 comment table | PASS | Checked in the tree: `db.ts` stale comments replaced; `eod_submissions_edit_flow.test.sql` L10-20 corrected (service_role wording, delete-and-reinsert wording); `comment on table eod_entries` and `comment on function report_last_order_context` in the new migration (forward notes, as the design chose); useStore "third copy" comments rewritten (no match left); `e2e/staff-reorder.spec.ts` L292 updated; README row added |
| AC-30 design states D-5 behaviour | PASS | Design section 8 failure table and the named follow-up. Behaviour pinned by `useStore.submitEOD.undo.spec189.test.ts` "does not undo the audit rows or the bell (D-5)" |
| AC-31 gates | PASS for spec 189 (see Test run) | pgTAP: `permissive_policy_lint` (5), `public_grants_explicit` (13), `staff_submit_eod_cases_each` (6), `eod_no_need` (54), `staff_role_eod_rls` (11), `eod_submissions_multi_vendor` (5), `eod_update_notifications` (33) all pass. One unrelated pgTAP failure, see below |
| AC-32 prod runbook | PASS (design) | Design section 14: duplicate query expecting 0 rows, role-drift query, policy check, md5 pre-check, verification list, post-push gates, rollback in section 13. Not run, by design, owner go-ahead only |
| AC-33 empty call refusals | PASS | ASE#70 (empty), #71 (NULL), #72 (non-array), #73 (rule B: all rows named), #74 (entries and submitted_at unchanged on the 200-day-old submission), #75, #76 (blank-only correction) |
| AC-34 (O-1) staff empty refusal | PASS | ASE#77 ('[]'), #78 (NULL), #79 (non-array), #80 (state unchanged), #81 (replay with '[]' still conflict true) |

Totals: 34 AC rows. 34 PASS, 0 FAIL, 0 NOT TESTED. Named gap in AC-28 step 7, judged below.

### AC-28 step 7 (reorder list on screen): judgement

Not covered on screen, and I judge the server-side risk covered. ASE#89-#93 call `report_reorder_list` after a re-submit through the real writer and compare to a control submitted once: one row per item, `suggested_qty`, `item_count` and the estimate all match. The spec's own evidence (the 4-rows-per-item and doubled quantity) was RPC output, and the screen renders those rows. What AC-18 does not prove is the rendering of the response. That is a low-risk gap, since no spec 189 code touches the reorder screen. The skipped step was blocked by local data (no vendor scheduled for Monday, per the notes). I do not block on it. If the owner wants the on-screen confirmation, do it on a day with a scheduled vendor, or run it after the prod EDIT in runbook step 5.

### Old-behaviour sweep (CLAUDE.md memory rule)

| Old behaviour | Result |
|---|---|
| Direct `eod_entries` delete treated as success | None left. `db.eodNoNeed.test.ts` now errors the table and fails on any direct op. The only other test files naming `eod_entries` are staff `EODCount*.test.tsx`, which are staff-path |
| `adjustItemStock` called from `submitEOD` | None left. Both useStore tests assert `not.toHaveBeenCalled()` (undo.spec189, noNeed.spec172 L116, L145, L164) |
| `submitEODCount` returning a bare id | None left. No test mocks a bare-id or undefined return of `submitEODCount`. db test asserts `{ submissionId, entryCount }`. Section specs 171/172 spies return an undo for `submitEOD` |
| D1/D2 duplicate fixture | Rewritten. Only the 9 row is inserted, D3 pins 23505 |

### Test run

- `bash scripts/test-db.sh` (full): 99 of 100 files pass. `admin_submit_eod` 96 arms, `report_last_order_context` 42, `eod_submissions_edit_flow` 4. **1 fail: `kept_records_delete_hardening.test.sql`**, "psql exit 3, deadlock detected" on `po_items`. It is an untracked file from another session's spec 194 (with untracked migration `20261109170000_kept_records_delete_hardening.sql`), not spec 189. It deadlocked against a concurrent connection on the shared database. Rerun alone: `bash scripts/test-db.sh supabase/tests/kept_records_delete_hardening.test.sql` passes (103 arms). Treat as a shared-database race, not a defect of this spec.
- `npx jest` (full): 299 suites, 3826 tests pass, 17 snapshots. (Run before my added test; the file with my test was rerun below.)
- `npx jest src/store/useStore.submitEOD.undo.spec189`: 9 of 9 pass after my addition.
- `npm run typecheck:test`: clean (run before and after my addition).
- Base typecheck with `--types` list excluding the stray `* 2` folders: clean, exit 0. Plain `npm run typecheck` not run, as instructed. The stray folders were not touched.

### Notes

- **Test added (one):** `src/store/useStore.submitEOD.undo.spec189.test.ts`, "AC-24: a first submit writes one 'Remaining count submitted' EOD entry row per entry; a re-submit writes 'Count updated'". It only asserts existing behaviour. Nothing else was edited.
- **Shared tree:** no failures belong to spec 189. The only failure is the spec 194 file above.
- **Not tested, by design and not an AC:** AC-22's "both SUBMIT and SAVE DRAFT" on the phone layout (no SAVE DRAFT there). Phone EDIT is covered by manual step 4.
- **Known residual (D-5):** the client audit rows and bell can still fire on a failed write. Pinned as intended behaviour, named follow-up.
- **Still manual, not run:** the AC-32 runbook, which needs the owner's go-ahead. The migration is not on prod; `db-migrations-applied.yml` will go red after a push until runbook step 2 is done.
- **Observed by manual pass, outside spec 189:** wrong header date (spec 192), and "total 0" on the locked screen (pre-existing).
- No framework gaps. Native testing was not requested by this spec.

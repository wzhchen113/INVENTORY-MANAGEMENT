## Test report for spec 199

### Acceptance criteria status
pgTAP file: `supabase/tests/staff_submit_eod_skip_unknown.test.sql` (plan 57; arm numbers in parens). Jest hook file: `src/screens/staff/hooks/useEodSubmit.test.ts` (describe "spec 199 skip unknown items").

- AC-1 (partial skip, deleted item) → PASS — skip_unknown (1)-(8)
- AC-2 (partial skip, cross-store item; X on-hand and audit untouched) → PASS — skip_unknown (9)-(12)
- AC-3 (valid payload envelope, key `[]`, exact key set) → PASS — skip_unknown (13)-(15); `admin_submit_eod.test.sql` arm (16) pins the staff key set including `skipped_item_ids` (SR-1)
- AC-4 (all skipped, first submit, 22023 + exact message, no parent) → PASS — skip_unknown (16)-(17)
- AC-5 (all skipped over S, nothing changes) → PASS — skip_unknown (18)-(19)
- AC-6 (message rules, SQLSTATE 22023) → PASS — skip_unknown (20)-(21)
- AC-7 (NULL / absent id, nothing changes over S) → PASS — skip_unknown (22)-(24)
- AC-8 (Count cleared interaction) → PASS — skip_unknown (25)-(29)
- AC-9 (gate order: store gate + R13 prefix, replay, O-1, date window, vendor) → PASS — skip_unknown (30)-(36)
- AC-10 (duplicates: 23505 unchanged; skipped dup reported once) → PASS — skip_unknown (37)-(39), (40)
- AC-11 (privileged caller) → PASS — skip_unknown (41)-(44)
- AC-12 (unchanged surfaces: prosecdef, search_path, ACL, trigger exists, direct insert still 42501, writer posture) → PASS — skip_unknown (45)-(54); other suites pass (see run)
- AC-13 (drain, store gate dequeues + syncErrorBanner) → PASS — useEodSubmit.test.ts "AC-13: drain + store-gate 42501 ..."
- AC-14 (drain, trigger/permission-denied/403-with-trigger-msg keep item, next FIFO item still submitted) → PASS — "AC-14" x3
- AC-15 (drain, bare 403 dequeues) → PASS — "AC-15: drain + a bare HTTP 403 ..."
- AC-16 (online: store gate forbidden; trigger 42501 failed, nothing enqueued) → PASS — "AC-16" x2
- AC-17 (online notice, last toast, locked) → PASS — hook half "AC-17 (hook half)" + "AC-17: an empty skipped_item_ids ..."; screen half `src/screens/staff/screens/EODCount.test.tsx` "EODCount - spec 199 skipped-items notice / AC-17"
- AC-18 (drain notice N=3, allSynced not overwriting; no-skip unchanged) → PASS — "AC-18" x2
- AC-19 (no key -> no notice, outcome unchanged) → PASS — "AC-19" x2
- AC-20 (i18n en/es/zh-CN, same token) → PASS — `eod.toast.skippedItems` present in all three json (line 106), `src/screens/staff/i18n/i18n.test.ts` passes
- AC-21 (gates; L115-125 fixture updated not deleted) → PASS — see run; the old-fixture arm "returns forbidden when RPC error code === 42501" passes with the real gate message

### Test run
- `bash scripts/test-db.sh supabase/tests/staff_submit_eod_skip_unknown.test.sql`: 57/57 assertions pass.
- `bash scripts/test-db.sh` (full): 107/107 files pass, 0 FAIL (includes admin_submit_eod, staff_submit_eod_date_bound, eod_*, edge-flow suites).
- `npx jest` (full): 308/308 suites, 3972/3972 tests, 17 snapshots pass.
- Focused jest (useEodSubmit, EODCount, i18n): 86 passed.
- `npm run typecheck:test` and `npm run typecheck`: only TS2688 noise from duplicate `node_modules/@types/* 2` folders (local-only, not fixed per instruction); filtering `error TS` excluding TS2688 yields zero errors in both.

### Notes
- Not exercised: R10 concurrency (pgTAP cannot run two sessions). Arm (55) pins only that `prosrc` contains `for key share`. Accepted by design (§6.1 SK13).
- No shell smoke (spec says none required); no native/Simulator testing.
- Spec 193's uncommitted edits in `useEodSubmit.test.ts` and `admin_submit_eod.test.sql` coexist; no failures. No source/test files edited by this review.
- Spec 199 hard-depends on spec 193 landing first (migration pre-flight raises 55000 otherwise); that is a commit/prod-apply ordering concern, not a test gap.
- Result: 21 PASS, 0 FAIL, 0 NOT TESTED.

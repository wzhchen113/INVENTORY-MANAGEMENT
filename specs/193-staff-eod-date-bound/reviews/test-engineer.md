## Test report for spec 193

### Acceptance criteria status
New pgTAP file: supabase/tests/staff_submit_eod_date_bound.test.sql (plan 69; arms cited by number).
- AC-1 (A-36 first-time refused) -> PASS - date_bound arm (1)
- AC-2 (A-35 inclusive succeeds) -> PASS - arm (3)
- AC-3 (refusal over existing A-36 submission leaves everything unchanged) -> PASS - arms (7)-(8) and following snapshot reads
- AC-4 (22023, not 42501, no network substrings; exact message) -> PASS - arms (1), lint arm
- AC-5 (admin/master/super_admin exempt at A-36 and A+2) -> PASS - arms (23)-(28)
- AC-6 (replay at A-36 returns conflict:true) -> PASS - arm (10)
- AC-7 (out-of-store gets 42501 before the window) -> PASS - arm (12); also staff_role_eod_rls and staff_submit_eod_cases_each pass, with out-of-membership dates retained
- AC-8 (signature, prosecdef, search_path, ACL) -> PASS - catalog arms; eod_no_need and staff_role_eod_rls ACL arms pass
- AC-9 (jest drain: refused item bumped, kept, next item still submitted) -> PASS - src/screens/staff/hooks/useEodSubmit.test.ts "AC-9"
- AC-10 (jest online submit returns failed) -> PASS - same file "AC-10"
- AC-11 (smoke HTTP 400) -> PASS (author's run only; I did not re-run the smoke) - scripts/smoke-staff-eod.sh step 8c, asserts 400, code 22023, exact message
- AC-12 (all gates) -> PASS for pgTAP and jest (my runs); typecheck/typecheck:test NOT re-run by me, developer reports only environmental TS2688 noise
- AC-13 (first-time A-36 leaves no parent) -> PASS - arm (5)
- AC-14 (A+2 refused, A+1 succeeds) -> PASS - arms (4) and following
- AC-17/18/19 -> N/A, confirmed: landed spec 189 wrapper already carries O-1 (22023 "p_entries must be a non-empty array") and eod_update_notifications already sends test.payload. R8 correctly skipped.
- AC-20 (NULL p_date refused) -> PASS - date_bound suite
- AC-21 (anchor ignores session TimeZone, Etc/GMT-14 and Etc/GMT+12; prosrc has America/New_York, no current_date) -> PASS - arms (15)-(22), (35), (36)
- AC-22 (P7 re-run: one Count cleared row for dropped I2, exact shape/value "20 lbs", none for I1, one per-entry row for I1) -> PASS - arms (37)-(40), arm (39) is the P7 re-run
- AC-23 (NO NEED and NULL-qty cleared values, on-hand untouched) -> PASS - R9 arms for S_b
- AC-24 (first submit writes zero Count cleared) -> PASS
- AC-25 (replay writes zero audit rows; full re-send writes zero Count cleared) -> PASS
- AC-26 (date refusal, O-1, 23514, 23505 each roll back audit rows) -> PASS - arms (51) onward
- AC-27 (admin JWT calling staff RPC audits too) -> PASS
- AC-28 (existing admin_submit_eod arms unchanged; writer catalog and 2x "Count cleared" + "not exists" structural) -> PASS - arms (61)-(69); admin_submit_eod.test.sql passes with only the D3 date move

Result: 0 FAIL, 0 NOT TESTED. AC-11 and the typechecks rest on the developer's runs, not mine.

### Test run
- `bash scripts/test-db.sh` (whole runner, local stack not restarted): 106/106 files PASS, 0 FAIL, including staff_submit_eod_date_bound (69/69) and all 8 reworked suites.
- `npx jest src/screens/staff/hooks/useEodSubmit.test.ts`: 13/13 pass.
- `npx jest` (full): 307 suites / 3948 tests pass, 17 snapshots pass.
- Not run by me: smoke script, `npm run typecheck`, `npm run typecheck:test`.

### Flake / collision analysis
- Midnight NY: every suite derives A from `(now() at time zone 'America/New_York')::date` inside the transaction; now() is the transaction start, so A and the RPC's own A cannot diverge mid-test. The new suite computes A once into test.anchor. No suite uses current_date or the wall clock after the fixture. Boundary arms (A-35, A+1) are computed from the same A, so they cannot flip.
- TimeZone-independence is pinned with Etc/GMT-14 and Etc/GMT+12, which covers every time of day.
- Smoke script: picks k in [3,33], well inside the window; a run crossing NY midnight shifts the server A by at most 1, so k stays within [A-35, A+1]. A-36 stays refused either way. Local-only guard (not exercised by me).
- Collisions: the new suite creates V, V2, VR and items in-transaction, so triples are fresh. Suites using persistent seed Frederick plus seed vendor (staff_role_eod_rls, staff_submit_eod_cases_each, audit_log_rls_hardening, eod_submissions_multi_vendor) pre-delete leftover rows (rolled back). staff_role_eod_rls pre-deletes every Frederick row at A-18 because an arm counts per store/date. eod_no_need, eod_update_notifications, inventory_items_identity_lock and admin_submit_eod use in-transaction vendors or stores. This matters more with R9 because a leftover row would turn a first submit into a replace and write unexpected Count cleared rows.
- Distinct k per suite (10-19, 20-25 in the new file); suites roll back and run serially, so there is no cross-suite interference.
- Residual (low): a date_bound arm depends on seed Frederick/seed manager/seed admin/master profiles existing; the seed is stable.

### Notes
- Mutation evidence is the developer's claim (23 of 69 arms fail against the 189 bodies); I did not reproduce it.
- No new test framework introduced. No unrelated suite failed. Working tree contains other sessions' edits (invitations, EOD admin UI, spec 192); none affected these results.
- No prod touched; nothing committed.

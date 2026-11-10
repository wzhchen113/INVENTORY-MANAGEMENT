## Test report for spec 190

### Acceptance criteria status
- AC-1 (same brand, other store) -> PASS. generate_po_number_sequence.test.sql: "AC-1 anti-vacuity", "AC-1: a member who cannot see the top PO inserts...", unique-table-wide and above-Y checks. Run as role-user member via `set local role authenticated` + jwt claims; anti-vacuity proves RLS hides store Y's top PO.
- AC-2 (another brand) -> PASS. Same file, "AC-2" x4 (anti-vacuity, lives_ok, unique, above brand B's top).
- AC-3 (numbers go up across callers) -> PASS. "AC-3" x4: owner(postgres) -> member -> admin -> owner, distinct and strictly increasing. Note: the "owner" is the postgres role, not an authenticated admin; the spec allows "the owner".
- AC-4 (concurrency) -> PASS. scripts/smoke-po-number-concurrency.sh (A: PO-2067, B: PO-2068, B completed while A open, both commit, distinct). Design D-7 contains the nextval argument. Smoke is local-only, not in CI (as the spec allows).
- AC-5 (deleted number not reissued) -> PASS. "AC-5" x2.
- AC-6 (padding 007/042/999) -> PASS. Three format_po_number assertions.
- AC-7 (no truncation) -> PASS. 1000/12345 via formatter, plus real trigger-path insert asserting `>= 1000` and equal to the computed expected number (PO-1000 on a fresh DB).
- AC-8 (seeded past existing) -> PASS. First assertion, before fixtures.
- AC-9 (explicit number skips trigger, sequence unchanged) -> PASS. Compares last_value/is_called before and after.
- AC-10 (skip taken number, RLS-blind) -> PASS. Explicit row holding next candidate in store Y; member of X (cannot see it, anti-vacuity) inserts; gets next+1; sequence advanced by 2.
- AC-11 (malformed rows ignored) -> PASS. PO-SAMS-PASS-1 and LEGACY-99 in both the new file and the rewritten guard file.
- AC-12 (search_path pin) -> PASS. Last assertion of generate_po_number_malformed_guard.test.sql, unchanged.
- AC-13 (guard test updated) -> PASS. Plan 8, all 8 assertions kept, absolute expectations made relative, header explains why, explicit fixture is next+500, unfiltered delete kept (now line 70 rather than 38; spec 186 docs cite :38, noted by the dev).
- AC-14 (whole suite) -> PASS for pgTAP: 99/99 files, including retention_prune_job, po_loop, permissive_policy_lint, public_grants_explicit, report_run_variance_formula and order_approvals_approver_snapshot (spec 187's column is now applied locally, so the "known failure" no longer reproduces). Jest and typecheck were NOT re-run by me; I rely on the developer's reported run (299 suites pass; typecheck:test exit 0). No TS changed.
- AC-15 (no new client-callable RPC) -> PASS. DP-2 asserts anon/authenticated lack EXECUTE on generate_po_number() and format_po_number(bigint); DP-3 asserts no USAGE/SELECT/UPDATE on the sequence.
- AC-16 (prod rollout) -> NOT TESTED. Prod is out of scope for this run (gated on owner go-ahead). This is expected and pending, not a defect; the release-coordinator should treat it as a prod-apply step (expect last_value 19, is_called true).
- Design-pinned DP-1..DP-6 -> all PASS (57 assertions in the new file). DP-6 also verifies the 54000 message and that the retry clears itself.

### Test run
- `bash scripts/test-db.sh supabase/tests/generate_po_number_sequence.test.sql supabase/tests/generate_po_number_malformed_guard.test.sql` -> 57/57 and 8/8 pass.
- `bash scripts/smoke-po-number-concurrency.sh` -> all checks pass.
- `bash scripts/test-db.sh` (full) -> 99/99 files pass.
- No test files edited; prod untouched; nothing committed.

### Notes
Sequence-persistence rules (checked by reading every assertion):
- No assertion depends on an absolute sequence value without setting it. Everything is relative to `seq_next()` read as postgres, or to previous generated numbers (`num(pid)`), or format-only.
- The only `setval` is in the AC-7 block, guarded by `if next < 1000 then setval(999, true)`. It raises the sequence only (next < 1000 means last_value <= 999), and AC-8's invariant means the table's max is below next, so it never goes below the table's max numeric. No test lowers the sequence.
- AC-9 (next+500) and malformed-guard (next+500) explicit rows never overlap DP-6's block (next..next+99 taken later, with AC-7 having already pushed past 1000), and DP-6 is last as required.

Fresh-CI judgement (sequence starts at 1, is_called false; earlier files may have consumed low numbers): expected to PASS.
- AC-8: next >= 1 > 0 on the empty table. OK.
- AC-7: if earlier files left next < 1000, the sequence is lifted to 999 and the insert gets PO-1000; if >= 1000, it uses next. Both consistent with the assertion, which compares against the computed expected value.
- Guard file (alphabetically before the sequence file): next-relative; the literal PO-015 that could have collided is gone. The explicit fixture at next+500 cannot be reached by the 3 inserts that follow.
- AC-10 and DP-6 compute from live state, so low consumed numbers are irrelevant.
- No other test file asserts an absolute generated PO number or touches the sequence (grep: only report_run_variance_formula and retention_prune_job use explicit po_number fixtures, not PO-<digits> collisions).
- I could not simulate a fresh sequence locally without lowering it (forbidden); this judgement is by reading.

Residual weaknesses (non-blocking):
- Shared-DB flake window: the tests read `seq_next()` and then insert; another session calling nextval in between would break AC-9 (state-unchanged), AC-10 (next+1 / advanced by 2) and DP-6 (retry = next+100) assertions. CI is single-session so it is not exposed; locally it is possible only if another session inserts POs during the run.
- Smoke only covers postgres-role sessions (no RLS), by design; RLS cases are covered by pgTAP. It is not in CI.
- AC-10's "skip" is exercised for one taken number; the multi-skip path is only exercised via DP-6 (all 100 taken).
- Stale comment in retention_prune_job.test.sql:259-262 intentionally left (spec 186 uncommitted); no test impact.

## Handoff
next_agent: NONE
prompt: Test report complete. 15 PASS, 0 FAIL, 1 NOT TESTED (AC-16, prod rollout, gated on owner go-ahead) across acceptance criteria.
payload_paths:
  - specs/190-po-number-sequence/reviews/test-engineer.md

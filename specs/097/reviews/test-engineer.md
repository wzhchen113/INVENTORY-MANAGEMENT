## Test report for spec 097

### Acceptance criteria status

- AC1: New migration issues explicit `GRANT` statements restoring NET-EFFECTIVE grant posture for all three roles (anon, authenticated, service_role), preserving the two deliberate REVOKEs (spec-041 profiles TRUNCATE, spec-093 audit-table) via a no-TRUNCATE privilege list for anon/authenticated plus one targeted re-lock REVOKE — PASS
  - File: `supabase/migrations/20260618000000_public_grants_explicit.sql`
  - Verified: `grant select, insert, update, delete, references, trigger on all tables … to anon, authenticated` (TRUNCATE omitted); `grant all on all tables … to service_role`; `revoke select, insert, update, delete, references, trigger on public.spec093_case_qty_backfill_audit from anon, authenticated` AFTER the broad grant.
  - No `GRANT ALL ON ALL TABLES … TO anon, authenticated` present — the raw-default trap is not taken.

- AC2: Migration issues `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT … TO {anon, authenticated, service_role}` for tables (no-TRUNCATE split), sequences, and functions — PASS
  - File: `supabase/migrations/20260618000000_public_grants_explicit.sql` (lines 187–204)
  - Four `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` blocks present: no-TRUNCATE table grant to anon/authenticated; ALL tables to service_role; ALL sequences to all three; ALL functions to all three.
  - `FOR ROLE postgres` is explicit (spec §1b requirement for migration-ownership fidelity).
  - No retroactive `GRANT … ON ALL ROUTINES` (correctly absent — approach 7a preserved).

- AC3: Migration is idempotent/additive; no down migration — PASS
  - `GRANT` and `ALTER DEFAULT PRIVILEGES … GRANT` are idempotent by definition. The single targeted `REVOKE` (audit-table re-lock) is also idempotent. Header comment confirms "Strictly additive; no down migration (repo convention)" (line 109–110).

- AC4 (ship checklist — prod reconciliation via `supabase db push` / `migration up`, NOT dashboard SQL editor): PENDING BY DESIGN
  - This is an operational deploy step the user runs post-merge. The migration body is a safe no-op against prod (§1c). The `db-migrations-applied.yml` drift gate will hard-fail until this step is executed. Flagged as the gating release step, not a code-review blocker.

- AC5: pgTAP regression-guard probe exists under `supabase/tests/` and fails on grant-posture regression — PASS
  - File: `supabase/tests/public_grants_explicit.test.sql`
  - Probe implements iterate-all-tables-with-1-row-role-keyed-allowlist pattern (modeled on spec 053).
  - Arms 5a/5b assert `has_table_privilege('{authenticated,anon}', 'public.profiles', 'TRUNCATE')` is FALSE — the arm that would have caught the original blanket-GRANT-ALL flaw.
  - Arms 6a/6b assert `has_table_privilege('{authenticated,anon}', 'public.spec093_case_qty_backfill_audit', 'SELECT')` is FALSE — guards the audit-table re-lock.
  - Arms 5c/6c (service_role TRUE) document the asymmetry and guard against service_role grant loss.
  - Arms 3/4 (synthetic throwaway tables, drop-then-assert pattern) prove the detector fires on a real missing grant and does not false-flag a correctly-granted table.
  - Developer meta-test (cited in spec §8 local validation): temporarily re-applying the flawed `GRANT ALL` made arms 5a/5b and 6a/6b go red — confirmed by the developer; arms 5c/6c stayed green. Probe is not vacuously passing.
  - Plan count: `plan(10)` declared on line 148; 10 `select ok/is(...)` calls counted (lines 170, 215, 298, 337, 359, 366, 371, 389, 395, 400). Plan matches assertion count — `test-db.sh` "planned N but ran M" guard satisfied.

- AC6: New pgTAP probe passes through `npm run test:db` — PASS
  - `public_grants_explicit.test.sql` (10 assertions) passed in the `npm run test:db` run below.
  - All 47/47 files green, including the two formerly-failing guards: `auth_can_see_store_brand_scope.test.sql` (14 assertions, including arm 14 for the TRUNCATE guard) and `profiles_rls_sweep.test.sql` (12 assertions, including arm 12).

- AC7: `.github/workflows/test.yml` Track 2 bumped from `version: 2.105.0` to `version: 2.106.0` — PASS
  - Line 139 of `.github/workflows/test.yml`: `version: 2.106.0` (fixed pin, not `latest`).
  - Only the Track 2 `db` job was modified; jest, typecheck, and typecheck-base jobs are untouched (scope guard honored).

- AC8 (comment block updated): PASS
  - Lines 127–138 of `.github/workflows/test.yml` contain the rewritten comment block: references "2.106.0 — the FIRST CLI family whose bundled Postgres image revokes the implicit GRANT …", "SCHEMA-EXPLICIT via migration 20260618000000_public_grants_explicit.sql", "spec 097", and the "fixed (not `latest`)" rationale.

- AC9: No RLS policy added, dropped, or altered — PASS
  - Verified: no `CREATE POLICY`, `ALTER POLICY`, or `DROP POLICY` appears in the migration outside comments.

- AC-load-bearing (Track 2 GREEN against CLI 2.106.0 on `main`, all 47 pgTAP pass against the image that previously failed 34): PENDING BY DESIGN
  - The most recent CI run on `main` is the stopgap pin commit (4c180c8, `version: 2.105.0`, status: success). Spec 097 is staged but not yet committed/pushed. The definitive proof — Track 2 green at 2.106.0 — occurs on the first push of this branch to `main`.
  - Local image is `postgres:17.6.1.084` (OLD, grants ALL by default), so several grant lines are local no-ops; local 47/47 green is meaningful for the negative arms and the probe's correctness, but is not equivalent to the 2.106.0 proof.
  - This is the gating release step per spec §1.12 and CLAUDE.md "CI status check" rule. Release coordinator must not recommend SHIP_READY until this run is confirmed green.

### Test run

Command: `npm run test:db`
Result: 47/47 PASS

Full output:
```
47/47 DB test file(s) passed
```

All individual files passed, including:
- `public_grants_explicit.test.sql` — 10 assertions (new probe)
- `auth_can_see_store_brand_scope.test.sql` — 14 assertions (arm 14 = TRUNCATE guard, previously FAILED on flawed design)
- `profiles_rls_sweep.test.sql` — 12 assertions (arm 12 = TRUNCATE guard, previously FAILED on flawed design)

### Notes

1. **Local-DB caveat (expected, not a gap).** The local Postgres image is `postgres:17.6.1.084` (old, grants ALL by default), so the retroactive `GRANT … ON ALL TABLES` and `GRANT … ON ALL SEQUENCES` lines in the migration are no-ops locally. The MEANINGFUL local signals are (a) arms 5 and 6 (the negative guards on profiles TRUNCATE and audit-table SELECT), which read the live catalog and pass correctly, and (b) the two formerly-failing guard files now green. The definitive 2.106.0 proof is post-push and pending by design.

2. **Probe arm 3 count=1 is correct.** Only `authenticated` is explicitly revoked; `anon` and `service_role` inherit their grants from `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` (ALL). One role missing SELECT → count=1. The assertion `is(..., 1, ...)` is correct for the single-role revoke setup.

3. **Allowlist is 1-row, role-keyed.** `spec093_case_qty_backfill_audit` is allowlisted for anon and authenticated (Category A, grant-revoked by design). `username_resolve_rate_limit` and `_edge_auth` are intentionally OFF the allowlist (Category B, hold the grant, unreachable via RLS). The distinction is correctly implemented and documented inline.

4. **No retroactive routines grant.** Verified: no `GRANT … ON ALL ROUTINES` in the migration. The ~15 per-RPC EXECUTE REVOKEs from specs 016/061/095 are therefore unaffected. Future functions only are covered via `ALTER DEFAULT PRIVILEGES … ON functions`.

5. **CLAUDE.md updated.** The "CI status check after every push to `main`" bullet has been extended with a one-sentence pointer to spec 097's `20260618000000_public_grants_explicit.sql` as the durable fix for the CLI grant-drift class of local-green/CI-red asymmetry (line 205 of CLAUDE.md).

6. **Prod reconciliation (AC4) is the only open release step.** All code-review-time ACs are PASS. The two pending-by-design items (prod reconciliation and Track 2 CI proof on `main` at 2.106.0) are operational ship steps, not code gaps. They must both be completed before SHIP_READY.

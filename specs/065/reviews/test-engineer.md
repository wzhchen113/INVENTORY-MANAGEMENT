## Test report for spec 065

### Acceptance criteria status

- AC1: Migration file exists at `supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql` with `ON DELETE SET NULL` semantics → PASS
  - File confirmed present and correct. `pg_constraint.confdeltype = 'n'` verified via direct psql query post-reset.

- AC2: `bash scripts/test-db.sh` runs green AND `auth_can_see_store_brand_scope.test.sql` passes (no FK violation on arm 12) → PASS
  - 34/34 suites pass. `auth_can_see_store_brand_scope.test.sql` shows 14/14 assertions.

- AC3: No other pgTAP test regresses — every previously-passing suite still passes → PASS
  - 34/34 pass. No regressions observed. Full suite output recorded below.

- AC4: Migration applies cleanly to local Supabase via `npx supabase db reset` → PASS
  - Clean apply. No errors. Expected "trigger does not exist, skipping" NOTICEs from prior migrations only.

- AC5: Migration applies cleanly to PROD via `npx supabase db push` → NOT TESTED
  - Deferred to main Claude per spec scope. Out of scope for this review per AC5 text.

- AC6: `db-migrations-applied.yml` CI gate catches future drift → NOT TESTED
  - Architectural — the gate is spec 064's responsibility and not testable in local review. Out of scope per spec AC6 text.

- AC7: Deleting a profiles row with dependent eod_submissions rows succeeds, and submitted_by values are set to NULL → PASS (verified by direct psql check)
  - Verified directly: seeded one `eod_submissions` row with `submitted_by = '22222222-...'` (manager_id) under the manager's JWT. Deleted the profile via postgres role with empty JWT claims (simulating the `delete-user` edge function's `auth.admin.deleteUser` cascade path). Result: row_count = 1 (row preserved), non_null_submitted_by = 0 (submitted_by nulled). Confirmed `ON DELETE SET NULL` cascade fires correctly.


### Test run

**npm test (jest)**
```
Test Suites: 33 passed, 33 total
Tests:       316 passed, 316 total
Time:        ~2s
```
316/316 pass. No regressions.

**npm run typecheck + npm run typecheck:test**
Both clean. No output (zero errors).

**bash scripts/test-db.sh (pgTAP)**
```
34/34 DB test file(s) passed
```
All 34 suites pass including `auth_can_see_store_brand_scope.test.sql` (14/14 assertions).

**pg_constraint direct probe**
```sql
select conname, confdeltype from pg_constraint
where conname = 'eod_submissions_submitted_by_fkey';
-- result: eod_submissions_submitted_by_fkey | n
```
`confdeltype = 'n'` confirms ON DELETE SET NULL.

**Mutation test**

The mutation procedure required an extra step beyond the task brief because the local seed has zero `eod_submissions` rows. A bare `db reset` + `test-db.sh` with `on delete no action` passes trivially — no FK-blocking rows exist. Procedure used:

1. Swapped migration to `on delete no action`; ran `npx supabase db reset`.
2. Seeded one `eod_submissions` row with `submitted_by = manager_id` using JWT impersonation (required to get the trigger to write the correct `submitted_by`).
3. Ran `bash scripts/test-db.sh auth_can_see_store_brand_scope.test.sql`.
4. Result: FAIL — arm (12) raised `ERROR: update or delete on table "profiles" violates foreign key constraint "eod_submissions_submitted_by_fkey"` — exact match to the failure described in the spec problem statement.
5. Restored migration to `on delete set null`; ran `npx supabase db reset`; ran full `bash scripts/test-db.sh` — 34/34 pass.

The mutation test confirms the fix is load-bearing when dependent rows exist.


### Notes

**Canary test is conditional on seed state (Should-fix, not blocking)**

The spec states that `auth_can_see_store_brand_scope.test.sql` arm (12) is the canary and that "if a future migration silently reverts this FK to no action, arm (12) would fail again." This is only true when the local seed contains `eod_submissions` rows referencing the manager profile. The current `supabase/seed.sql` has zero `eod_submissions` rows. A future reversion to `no action` would pass the pgTAP suite silently on a fresh `db reset` — the canary only fires when dependent rows are present.

The architect dismissed a dedicated `pg_constraint.confdeltype` probe as overkill. That call is reasonable given the low blast radius of this FK. However, the regression protection is weaker than the spec implies. A future schema-sweep spec (already flagged by the architect for the 11 other actor-FK columns) would be the right place to add a systematic `pg_constraint.confdeltype` probe for all `profiles(id)`-referencing FKs.

This is a Should-fix for the follow-up audit-sweep spec, not a blocker for spec 065. The direct psql check in this review satisfies AC7's "manual psql check during review" path.

**`eod_submissions_set_submitted_by_trg` trigger interaction confirmed**

When deleting a profile via the postgres role with empty JWT (simulating the cascade from `auth.admin.deleteUser`), the FK cascade updates `submitted_by = NULL` on affected rows. The trigger did NOT fire and re-set `submitted_by` to a non-null value, confirming the architect's orthogonality claim. The cascade result is correct.

**AC7 not covered by a dedicated pgTAP assertion**

The spec says "verified by a dedicated assertion in the pgTAP suite OR by manual psql check during review." This review covers the manual-psql path. No new test file was added (per the architect's recommendation and the spec's "no new tests required" framing). If the release-coordinator considers this a gap, a one-assertion pgTAP file exercising the delete-then-null pattern would be the appropriate addition — but the spec explicitly defers this to the "or manual psql check" path.

**AC5 and AC6 are out-of-scope for local review** — both are architectural or production-deployment concerns deferred to main Claude and the spec 064 CI gate respectively.

**SHIP_READY.**

All testable ACs pass. Migration is correct, FK `confdeltype = 'n'` confirmed, mutation test reproduces the original failure and demonstrates the fix is load-bearing, AC7 verified by direct psql, 316/316 jest, 34/34 pgTAP, typechecks clean.

## Handoff
next_agent: NONE

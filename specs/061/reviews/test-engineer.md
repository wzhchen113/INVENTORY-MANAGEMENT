## Test report for spec 061

### Acceptance criteria status

**Track A — Backend (`imr-inventory`)**

- **A1**: `staff_submit_eod` GRANT updated from `service_role` to `authenticated` — PASS
  - `supabase/tests/staff_role_eod_rls.test.sql` assertion (10): `not has_function_privilege('service_role', …, 'EXECUTE')` passes.
  - Direct DB check: `has_function_privilege('authenticated', …, 'EXECUTE')` returns true; same for `service_role` returns false.
  - Migration `supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql` contains the `revoke … from service_role; grant execute … to authenticated;` block.

- **A2 (revised)**: Staff CAN read brand-shared tables, CANNOT WRITE them; staff CAN read/write `eod_submissions` for their stores, CANNOT write for non-member stores — PASS
  - pgTAP assertion (5): out-of-membership RPC call raises 42501 via `auth_can_see_store` gate.
  - pgTAP assertion (6): direct INSERT into `eod_submissions` for non-member store raises 42501 via RLS.
  - pgTAP assertion (7): staff CAN SELECT own-store `eod_submissions`.
  - pgTAP assertion (8): staff CANNOT SELECT non-member store `eod_submissions`.
  - pgTAP assertion (9): staff CANNOT INSERT into `recipes` (write-block on brand-shared tables, `auth_is_privileged()` gates it).
  - Note: A2's original bullet "CANNOT SELECT recipes rows" appears in the spec AC list but was superseded by the architect's revised A2 ruling in §0. The pgTAP test correctly covers the revised A2, not the original. The spec's AC section still contains the stale original wording — a documentation inconsistency but not a functional gap.

- **A3**: Three edge functions return HTTP 410 — PASS
  - `smoke-staff-eod.sh` step 9: all three (`staff-eod-submit`, `staff-catalog`, `staff-waste-log`) return 410 and body contains "spec 061".
  - All three function files rewritten to the deprecation shape. CORS headers preserved. `verify_jwt = false` retained.

- **A4**: pgTAP file `supabase/tests/staff_role_eod_rls.test.sql` with 10+ assertions — PASS
  - File exists at the specified path.
  - `bash scripts/test-db.sh supabase/tests/staff_role_eod_rls.test.sql` passes 11 assertions.
  - Plan and finish agree (`plan(11)`, 11 `ok` lines, no `not ok`, no plan/run mismatch).
  - One A4 spec bullet is stale: "same user CANNOT INSERT into `brand_inventory_items`" — that table does not exist in this schema. The test instead covers `recipes` INSERT (the correct revised target per the architect's §0 ruling). Not a blocking gap — the table reference in the spec is vestigial.

- **A5**: Existing admin EOD section unchanged — PASS (regression)
  - `src/screens/cmd/sections/EODCountSection.tsx` is unmodified (git status confirms no diff against HEAD for that file).
  - `npm test` passes 259/259 jest tests — no regression in any admin-side test.
  - No dedicated jest test for `EODCountSection` exists; A5 is verified by the absence of code changes to that file and the passing jest baseline. The spec notes this criterion "may be exercised manually instead of via jest" — that framing is satisfied.

- **A6**: Permissive-policy lint (spec 053) passes — PASS
  - `supabase/tests/permissive_policy_lint.test.sql` passes 4 assertions in the full `bash scripts/test-db.sh` run.
  - The new migration adds no new permissive policies — it only modifies a function body and grant.

**Track C — Sequencing and tests**

- **C1**: Backend lands before any `imr-staff` frontend work — PASS (structural)
  - The `imr-staff` repo contains only scaffold (App.tsx placeholder), no EOD screen, no submission flow.
  - The `spec 061` backend is pending SHIP_READY; spec 062 is not created yet.

- **C2**: pgTAP test runs via `bash scripts/test-db.sh` and passes — PASS
  - Confirmed in Test run section below.

- **C3**: Shell smoke at `scripts/smoke-staff-eod.sh` — FAIL (3 checks fail, see Critical finding below)

- **C4**: Staff frontend in second build cycle — PASS (structural)
  - Spec 062 does not exist; the imr-staff repo has only scaffold. Sequencing rule is honored.

- **C5**: `imr-staff` repo exists with initial commit — PASS
  - `~/Documents/GitHub/imr-staff` exists.
  - `git log --oneline` shows single commit: `481b561 Initial scaffold for imr-staff (spec 061)`.

**Track B — Frontend scaffold (`imr-staff`)**

- **B1**: Expo SDK 54, RN 0.81, TS 5.3, Zustand, supabase-js 2.101, React Navigation 6, AsyncStorage, Babel/Metro alias — PASS
  - `package.json` at `~/Documents/GitHub/imr-staff/package.json` confirms: `expo: ^54.0.0`, `react-native: 0.81.5`, `typescript: ^5.3.0`, `zustand: ^4.5.4`, `@supabase/supabase-js: ^2.101.1`, `@react-navigation/native: ^6.1.17`, `@react-navigation/stack: ^6.3.29`, `@react-native-async-storage/async-storage: 2.2.0`, `@react-native-community/netinfo: ^11.0.0`.

- **B2**: `CLAUDE.md` in `imr-staff` with required content — PASS
  - CLAUDE.md present. Contains: "What this is" (staff EOD app), "Backend" pointing at imr-inventory Supabase and spec 061 path, stack list, conventions section stating no admin UI / no brand catalog UI / no recipe management, auth model section, "Realtime: NONE in v1" convention.

- **B3–B10**: These are the frontend implementation ACs — NOT TESTED (scope deferred to spec 062)
  - The spec explicitly scopes B3–B10 as "the contract the staff-frontend must hit" and defers implementation to spec 062. The scaffold contains no screens, no auth flow, no EOD count screen, no offline queue — correctly so. These ACs will be evaluated by the test-engineer for spec 062.

---

### Test run

**`npm test` (jest)**
```
Test Suites: 25 passed, 25 total
Tests:       259 passed, 259 total
```
Baseline holds. No regression.

**`npm run typecheck` + `npm run typecheck:test`**
Both exit 0. No type errors in source or test files.

**`bash scripts/test-db.sh` (pgTAP, 34 files)**
```
33/34 PASS
1/34 FAIL: supabase/tests/auth_can_see_store_brand_scope.test.sql
  psql exit 3: ERROR: update or delete on table "profiles" violates foreign key
  constraint "eod_submissions_submitted_by_fkey" on table "eod_submissions"
```
The `auth_can_see_store_brand_scope` failure is pre-existing (confirmed: the same file fails on a stash of spec 061 files, i.e. against the prior baseline). It is NOT introduced by spec 061. The `staff_role_eod_rls.test.sql` file passes all 11 assertions.

**`bash scripts/smoke-staff-eod.sh`**
```
PASS  got staff access_token
PASS  vendor_id=...
PASS  inventory_items.id=...
PASS  first call returns 200
PASS  response has submission_id=...
PASS  first call returned conflict=false
FAIL  expected exactly 1 row at client_uuid=<new-uuid>, got: []
FAIL  row.submitted_by was '' (expected '22222222-2222-2222-2222-222222222222')
PASS  replay returns 200
FAIL  replay returned conflict=false (expected true)
PASS  replay submission_id matches first call's
PASS  non-membership store call returns 403 (auth_can_see_store gate fired)
PASS  no eod_submissions row at NEG_CLIENT_UUID (from staff POV)
PASS  /functions/v1/staff-eod-submit returns 410
PASS  /functions/v1/staff-eod-submit body references spec 061
PASS  /functions/v1/staff-catalog returns 410
PASS  /functions/v1/staff-catalog body references spec 061
PASS  /functions/v1/staff-waste-log returns 410
PASS  /functions/v1/staff-waste-log body references spec 061
✗ some checks failed
```

---

### Mutation test

The `auth_can_see_store` gate was removed from the function body by re-executing the DDL with that block commented out. `bash scripts/test-db.sh` was run in that mutated state.

Result: `staff_role_eod_rls.test.sql` FAILED (pgTAP assertion(s) failed — assertion (5) "staff user is refused for out-of-membership store via auth_can_see_store gate" fired `not ok`). The gate IS load-bearing in the test.

After mutation test, the real migration was re-applied by piping the original file into the DB container. Full pgTAP run confirmed `staff_role_eod_rls.test.sql` passes 11/11 again.

---

### pgTAP quality probe

**Assertion count**: plan(11) declared; 11 `ok` lines emitted. Plan/run agreement confirmed.

**Load-bearing negative case (assertion 5)**: present and tested.
- Uses `throws_ok(…, '42501', null, …)` against the non-member store (Charles, UUID `1ea549bb…`).
- The date used is `2026-05-23` (not today = 2026-05-24, not the spec's test-only `1999-12-31`). This is the out-of-membership test, so date isolation does not matter — the call is expected to raise before any insert lands; the date is irrelevant.

**Spoof-proof attribution test (assertion 4)**: partially substantive.
- The test passes `p_submitted_by = null` (not `p_submitted_by = 'attacker-id'`). It then checks `audit_log.detail LIKE manager_id || '%'`, which proves `auth.uid()` won when `p_submitted_by = null`.
- The stronger version — passing an attacker-controlled string as `p_submitted_by` and checking the audit log does NOT contain that string — would be more definitive. As written, the test confirms the happy-path attribution (`auth.uid()` wins when present), but does not exercise the spoof case where `p_submitted_by` is supplied with a non-null adversarial value.
- This is a Should-fix, not a Critical, because the spoof surface is blocked by the three-tier fallback logic: `coalesce(auth.uid()::text, p_submitted_by, 'staff:unknown')`. When `auth.uid()` is non-null (it always is for an `authenticated` JWT), `p_submitted_by` is unreachable. The logic is correct; the test just doesn't exercise the unreachable arm.

**Date isolation**: the happy-path assertions (1, 2, 3, 4, 7, 11) use date `1999-12-31`. The spec comment in the test file explains the rationale: smoke-script residue at today's date would otherwise leave conflicting rows at `(store, today, vendor)`. Using `1999-12-31` avoids that coupling. Good isolation.

**Idempotency replay (assertion 11)**: correct — replays with the same `client_uuid` from `_first_call`, confirms `conflict = true` and same `submission_id`. Works correctly in the pgTAP context because the test is hermetically wrapped in a transaction and the first insert always uses a fresh row (date `1999-12-31` is rolled back by prior runs, so each run starts clean).

---

### Notes

**Critical finding — Smoke script has non-idempotent day-relative collision (C3 FAIL)**

The smoke script (`scripts/smoke-staff-eod.sh`) generates a fresh `client_uuid` and uses `TODAY=$(date +%Y-%m-%d)` as the submission date. It then queries `eod_submissions` by `client_uuid=eq.<new-uuid>` to verify the row landed.

The RPC's upsert is `ON CONFLICT (store_id, date, vendor_id) DO UPDATE` with `client_uuid = coalesce(existing.client_uuid, excluded.client_uuid)`. On any run after the first, a row already exists for `(Frederick, today, seed-vendor)`. The upsert fires the DO UPDATE path, preserving the ORIGINAL `client_uuid` in the DB. The smoke script's new `client_uuid` is never stored. Querying by that new UUID returns an empty array.

The same collision prevents the idempotency replay check from working: the smoke's second call uses the new `client_uuid`, which is also not in the DB (the original `client_uuid` is), so the idempotency check in the RPC body doesn't find it either, and the second call returns `conflict: false` instead of `conflict: true`.

Three smoke checks fail on every run after the first (each calendar day):

1. Row-visibility check (`expected exactly 1 row at client_uuid=<new>, got: []`)
2. `submitted_by` check (empty result from the failed row query)
3. Idempotency replay (`conflict=false` expected `conflict=true`)

The fix: the smoke script should use a stable past date (e.g. `2025-06-01`) or a unique future-sentinel date that will never conflict with real data or seed data, not `TODAY`. Alternatively, it can query by `submission_id` returned in the first call's response body rather than by `client_uuid`. The pgTAP file correctly handles this by using `1999-12-31`.

This is a Critical for the smoke track (C3). The RPC itself is correct — the pgTAP tests and manual debugging confirm the logic works. The smoke script has a test-design flaw that makes it fail after its own first run and on any day where residue exists.

**Should-fix — Spoof-proof test doesn't pass an adversarial `p_submitted_by`**

Assertion (4) passes `p_submitted_by = null` and verifies `audit_log.detail` is prefixed with `auth.uid()`. A stronger test would pass `p_submitted_by = 'attacker-uuid'` (a different UUID from the staff user's) and assert the audit log detail does NOT start with `'attacker-uuid'` but DOES start with the real manager UUID. As written, the test proves `auth.uid()` is used when `p_submitted_by` is null — it doesn't verify the fallback is unreachable when an adversarial value is supplied. The logic is correct (`coalesce(auth.uid()::text, …)` short-circuits when `auth.uid()` is non-null), but the test leaves the adversarial arm unexercised.

**Nit — A4 spec bullet references non-existent table `brand_inventory_items`**

AC A4 says "same user CANNOT INSERT into `brand_inventory_items`". That table does not exist in this schema. The test correctly covers `recipes` (per the architect's revised A2 ruling). The stale table reference in the spec's A4 bullet should be updated to match what was actually tested.

**Nit — A4 spec bullet "CANNOT SELECT recipes rows" not updated after A2 revision**

The original A2 bullet "CANNOT SELECT recipes rows" appears in both the AC A2 section and the AC A4 test-list section. The architect's §0 ruling revised A2 so that staff CAN read recipes. The test (and the underlying facts) are aligned with the revised A2, but the original wording was not struck from the AC A2 / A4 bullet lists. The spec is internally inconsistent on this point. Recommend updating the spec's bullet lists to match the §0 ruling before marking SHIP_READY.

**Pre-existing failure not caused by spec 061**

`supabase/tests/auth_can_see_store_brand_scope.test.sql` fails with a foreign key constraint violation (`eod_submissions_submitted_by_fkey`) at arm (12). This failure exists on the main branch baseline (confirmed via git stash + rerun) and is not related to spec 061's changes. It needs a separate fix — the test's `delete from public.profiles where id = manager_id` hits the FK from `eod_submissions.submitted_by` referencing `profiles.id`. The test needs to either delete the eod_submissions rows first or use a test user with no eod_submissions rows.

---

### Acceptance criteria status (summary for release-coordinator)

| AC | Text | Status |
|----|------|--------|
| A1 | GRANT swap service_role → authenticated | PASS |
| A2 (revised) | Staff CAN read brand-shared, CANNOT write; store-scoped reads/writes gated by user_stores | PASS |
| A3 | Three edge functions return 410 | PASS |
| A4 | pgTAP file with 10+ assertions passes | PASS |
| A5 | Admin EOD section unchanged | PASS |
| A6 | Permissive-policy lint passes | PASS |
| C1 | Backend lands before frontend (sequencing) | PASS |
| C2 | pgTAP passes via `bash scripts/test-db.sh` | PASS |
| C3 | Shell smoke passes | FAIL — 3 checks fail due to non-idempotent date collision |
| C4 | Frontend in second build cycle | PASS (structural) |
| C5 | imr-staff repo with initial commit | PASS |
| B1 | Scaffold stack matches spec | PASS |
| B2 | CLAUDE.md content correct | PASS |
| B3–B10 | Frontend implementation ACs | NOT TESTED (deferred to spec 062) |

**C3 is FAIL → this is a blocking Critical for SHIP_READY.**

## Handoff
next_agent: NONE
prompt: Test report complete. 12 PASS, 1 FAIL, 8 NOT TESTED across acceptance criteria. C3 (smoke script) fails on 3 checks due to a non-idempotent day-relative collision in the smoke's client_uuid/date query strategy. The RPC and pgTAP tests are correct; the smoke test design is the flaw. Also surfaced: one Should-fix (spoof-proof test should pass an adversarial p_submitted_by value) and two Nits (stale A4 spec bullet references non-existent brand_inventory_items table; A4 "CANNOT SELECT recipes" bullet not updated after A2 revision). Pre-existing unrelated pgTAP failure in auth_can_see_store_brand_scope.test.sql documented.
payload_paths:
  - specs/061/reviews/test-engineer.md

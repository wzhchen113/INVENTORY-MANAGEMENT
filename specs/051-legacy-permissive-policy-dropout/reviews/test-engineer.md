## Test report for spec 051

### Acceptance criteria status

- **AC: Migration file exists at exact path** → PASS — `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql` exists.
- **AC: Migration is idempotent (all drops use `IF EXISTS`)** → PASS — every `drop policy` uses `if exists`; every `create policy` is preceded by a matching `drop policy if exists`.
- **AC: `public.stores` — `auth_manage_stores` dropped, no replacement** → PASS — migration line 81. Four scoped policies remain.
- **AC: `public.user_stores` — `Users can manage own store links` replaced with exact-match own-row predicate** → PASS — migration lines 104–113; `using (user_id = auth.uid()) with check (user_id = auth.uid())`.
- **AC: `public.user_stores` — `Admins can manage all store links` replaced with brand-scoped admin policy** → PASS — migration lines 115–140; `auth_is_privileged() AND exists(… auth_can_see_brand(s.brand_id))` for both USING and WITH CHECK.
- **AC: `public.ingredient_categories` SELECT rewritten to `to authenticated using (true)` + `comment on policy`** → PASS — migration lines 157–167.
- **AC: `public.recipe_categories` SELECT rewritten to `to authenticated using (true)` + `comment on policy`** → PASS — migration lines 180–190.
- **AC: pgTAP file exists at `supabase/tests/legacy_permissive_policy_dropout.test.sql`** → PASS.
- **AC (a): brand-A admin SELECT on foreign store returns 0 rows (Bobby leak)** → PASS — arm (1), `select is(count(*)::int, 0, …)`. Asserts row count not a 4xx error.
- **AC (b): brand-A admin INSERT cross-brand store rejected (42501)** → PASS — arm (2), `select throws_ok(…, '42501', 'new row violates row-level security policy for table "stores"', …)`.
- **AC (c): brand-A admin UPDATE foreign store silently affects 0 rows** → PASS — arm (3); verifies original `name` unchanged via postgres-role bypass read.
- **AC (d): brand-A admin DELETE foreign store silently affects 0 rows** → PASS — arm (4); verifies `count(*) = 1` (row still present) via postgres-role bypass read.
- **AC (e): super_admin can SELECT/INSERT/UPDATE/DELETE across brands** → PASS — arm (5); bool_and over four bool predicates, single `is('true', …)` assertion. Master promoted to super_admin mid-txn, same pattern as `delete_last_privileged_guard.test.sql`.
- **AC (f): staff user (role=user, no foreign grant) cannot SELECT foreign store** → PASS — arm (7), `select is(count(*)::int, 0, …)` under manager JWT.
- **AC (g): staff user CANNOT INSERT `user_stores` row for another user** → PASS — arm (8), `select throws_ok(…, '42501', 'new row violates row-level security policy for table "user_stores"', …)`.
- **AC (h): staff user CAN INSERT/UPDATE/DELETE own `user_stores` row** → PARTIAL PASS — arm (9) covers INSERT-self (admits). UPDATE-own and DELETE-own `user_stores` are NOT tested. The spec explicitly says "CAN INSERT/UPDATE/DELETE their own `user_stores` row."
- **AC (i): brand-A admin CAN INSERT `user_stores` for brand-A user on brand-A store** → PASS — arm (10); verification SELECT via postgres role confirms row inserted.
- **AC (j): brand-A admin CANNOT INSERT `user_stores` crossing brands — both policy and trigger asserted** → PASS — arm (11); `throws_ok('P0001', 'cross-brand user_stores assignment rejected: user brand=…, store brand=…', …)`. The error message matches the trigger's stable format string. Test comment explains why P0001 fires before 42501 (BEFORE ROW trigger precedes RLS WITH CHECK on INSERT, per Postgres §38.6).
- **AC (k): authenticated SELECT on `ingredient_categories` and `recipe_categories` returns > 0 rows** → PASS — arms (12)+(13), `select ok(count(*) > 0, …)`.
- **AC: All 30 pre-existing pgTAP test files pass after migration** → PASS — 31/31 files pass (30 pre-existing + new file 051). No regressions.
- **AC: No client-side code changes ship with this spec** → PASS — no TypeScript files modified; `npm test -- --ci` (182 tests) and `npm run typecheck:test` both pass clean.
- **AC: CLAUDE.md addition documenting the "ORed-permissive-policy" footgun** → PASS — CLAUDE.md line 66 contains the required bullet referencing spec 051, the four-table audit, and the migration path.
- **AC: Closeout note on spec 041** → PASS — `specs/041-brand-scoped-store-visibility.md` line 1228 contains the "Follow-up: spec 051" bullet.

### Gap — AC (h) UPDATE and DELETE own-row not covered

Spec AC (h) reads: "staff user CAN INSERT/**UPDATE/DELETE** their own `user_stores` row." The test covers INSERT-self (arm 9, PASS). No arm exercises UPDATE or DELETE on `user_stores` under the manager JWT. The rewritten `Users can manage own store links` policy is `FOR ALL` with `using (user_id = auth.uid()) with check (user_id = auth.uid())`, so UPDATE and DELETE should behave identically to INSERT — but they are not directly asserted. A future migration that narrows the policy to `FOR INSERT` only would break UPDATE/DELETE without any test catching it.

### Test run

```
npm run typecheck:test   → exit 0 (no output; clean)
npm test -- --ci         → 17 suites, 182 tests, 0 failures
bash scripts/test-db.sh  → 31/31 DB test file(s) passed
```

`legacy_permissive_policy_dropout.test.sql`: 13 assertions declared (`plan(13)`), 13 assertions executed — plan and assertion count agree.

### Notes

- **Hermetic isolation**: test wraps in `begin; … rollback;`. All fixture rows (foreign brand, foreign store, synthetic auth.users, synthetic profiles) vanish on rollback. No seed pollution.
- **JWT idiom**: `set local role authenticated` + `set_config('request.jwt.claims', …, true)` — consistent with `auth_can_see_store_brand_scope.test.sql`. Postgres-role bypass for verification reads uses `reset role; select set_config('request.jwt.claims', '', true)` — same pattern as `rls_hardening_followups.test.sql`.
- **Arm (11) message stability**: the trigger error message uses PL/pgSQL `raise exception '…: user brand=%, store brand=%', v_user_brand, v_store_brand`. The test's `format(…, current_setting('test.brand_a'), current_setting('test.brand_b'))` produces the identical UUID-interpolated string. Assertion is stable against refactors that do not change the trigger message template.
- **Seed assumption (arm 6)**: `count(*) = 4` brand-A stores verified live in the running DB — Towson, Charles, Frederick, Reisters. Correct.
- **Seed assumption (arm 9)**: manager (`22222222-…`) holds Towson + Frederick grants but NOT Charles. Verified live. Arm (9) INSERT to Charles is a valid fresh row that the rollback cleans up.
- **No smoke arm required**: spec DDL only; architect design confirms pgTAP is the load-bearing track. Smoke skipped per spec convention.
- **AC (h) gap is Minor** (not Critical): the own-row policy is `FOR ALL` — the INSERT-self passing arm is strong evidence UPDATE/DELETE also pass. The gap is a coverage gap, not evidence of a defect. Marking as PARTIAL PASS rather than FAIL.

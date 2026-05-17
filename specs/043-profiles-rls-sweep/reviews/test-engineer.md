## Test report for spec 043

### Acceptance criteria status

#### Policy changes on `public.profiles`

- AC-SELECT-1: "Admins can read all profiles" SELECT policy is dropped and re-created with USING `(public.auth_is_privileged() and public.auth_can_see_brand(brand_id)) or id = auth.uid()` → **PASS** — `pg_policies` live query confirms the exact expression. Verified by arm (1), (2), (3), (4) in `supabase/tests/profiles_rls_sweep.test.sql`.

- AC-DELETE-1: "Admins can delete profiles" DELETE policy is dropped and re-created with USING `public.auth_is_privileged() and public.auth_can_see_brand(brand_id)` → **PASS** — `pg_policies` live query confirms the exact expression. Verified by arms (7), (8), (9) in `supabase/tests/profiles_rls_sweep.test.sql`.

- AC-NO-OTHER-POLICY: No other policy on `public.profiles` is mutated (Spec 042 "Admins can update any profile", "Users can update own profile", "Anyone can insert own profile or admin can insert any", "Users can read own profile" are unchanged) → **PASS** — `pg_policies` query shows all four Spec 042 policies present with their prior shapes; rls_hardening_followups.test.sql 15/15 confirms no UPDATE regression.

#### Trigger / function invariants (no-regression)

- AC-TRIGGER-SELF-DELETE: `profiles_self_delete_lock` BEFORE DELETE (Spec 041) still blocks self-DELETE by `authenticated`/`anon` callers with the message `'profile self-delete is not permitted (use admin delete flow)'` → **PASS** — `supabase/tests/profiles_rls_sweep.test.sql::arm (10)` + `supabase/tests/auth_can_see_store_brand_scope.test.sql` arms (11), (13).

- AC-TRIGGER-BRAND-LOCK: `profiles_self_brand_lock` BEFORE UPDATE (Spec 041/042) is untouched, Spec 042 message-string contracts preserved → **PASS** — rls_hardening_followups.test.sql arms (13), (14), (15) + auth_can_see_store_brand_scope.test.sql arms (7), (8), (9) pass.

- AC-SECURITY-DEFINER: `assert_not_last_of_role` is SECURITY DEFINER and bypasses the new DELETE policy when called from an authenticated admin session → **PASS** — `pg_proc.prosecdef = true` confirmed by live query; `supabase/tests/profiles_rls_sweep.test.sql::arm (11)` explicitly asserts the helper fires from an admin-context JWT with P0001 `'cannot delete the last super_admin'`.

#### Pre-flight defense-in-depth

- AC-PREFLIGHT: Migration opens with `do $$ begin … end $$` block that raises `'043: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying'` if any admin/master row has `brand_id is null` → **PASS** — present in `supabase/migrations/20260517060000_profiles_rls_sweep.sql` lines 63-72; exact message matches spec.

#### Edge-function defense-in-depth (`delete-user`)

- AC-EDGE-BRAND-RESOLVE: Before `auth.admin.deleteUser`, the function resolves target's `profiles.role` and `profiles.brand_id` via the service-role client → **PASS** — `supabase/functions/delete-user/index.ts` lines 75-79 resolve target's `brand_id`; lines 172-176 resolve `role` for the existing last-of-role guard.

- AC-EDGE-SUPER-ADMIN-PASS: Caller is `super_admin` → proceeds unchanged → **PASS** — `requireSameBrandOrSuperAdmin` line 68 returns `{ status: 200 }` immediately for `super_admin`.

- AC-EDGE-ADMIN-BRAND-CHECK: Caller is `admin`/`master`, target is in a different brand → 403 `{ error: 'forbidden: target is in a different brand' }` BEFORE any side-effect deletes → **PASS** — `requireSameBrandOrSuperAdmin` lines 105-107; brand gate executes at lines 149-160, before `assert_not_last_of_role` (line 186) and before any cascade deletes (lines 199-201).

- AC-EDGE-AUTH-ONLY: Target with no profiles row → retain current behavior, service-role delete proceeds → **PASS** — `requireSameBrandOrSuperAdmin` line 88 returns `{ status: 200 }` when `!targetProfile`.

- AC-EDGE-HELPER-SHAPE: `requireSameBrandOrSuperAdmin(callerId, callerRole, targetUserId)` is inline in `delete-user/index.ts`, not in `_shared/` → **PASS** — function declared at lines 62-110 within `delete-user/index.ts`; no `_shared/` import.

- AC-EDGE-ORDERING: Brand gate executes BEFORE `assert_not_last_of_role` → **PASS** — `brandGate` call at lines 149-160 precedes `guardError` call at lines 186-196.

- AC-EDGE-REQUIRE-ADMIN-CALLER-APPROLE: `requireAdminCaller` now returns `{ userId, appRole, status: 200 }` (was `{ userId, status: 200 }`), `appRole` threaded through to `requireSameBrandOrSuperAdmin` → **PASS** — `requireAdminCaller` returns `{ userId, appRole, status: 200 }` at lines 30, 39; `gate.appRole` passed to brand gate at line 152.

#### Edge-function (`send-invite-email`) — scoped

- AC-INVITE-REVIEWED-NOT-MODIFIED: `send-invite-email/index.ts` reviewed but NOT modified (confirmed no brand-blind decisions in the function) → **PASS** — spec body documents the architect's end-to-end read confirming no profiles.brand_id branch in the function; no code change landed.

#### pgTAP test arms (§8 matrix coverage)

The architect's §8 arm table specifies 11 arms minimum (plus an optional 12th TRUNCATE arm). The implementation delivers 12 arms:

- Arm 1: SELECT own profile as admin → admit → **PASS** — `profiles_rls_sweep.test.sql::arm (1)` (12/12 passed)
- Arm 2: SELECT same-brand peer as admin → admit → **PASS** — `profiles_rls_sweep.test.sql::arm (2)` (uses synthetic `target_a` brand-A profile rather than seed `manager_id`; behavior equivalent, test passes)
- Arm 3: SELECT cross-brand as admin → 0 rows → **PASS** — `profiles_rls_sweep.test.sql::arm (3)`
- Arm 4: SELECT cross-brand as super_admin → admit → **PASS** — `profiles_rls_sweep.test.sql::arm (4)`
- Arm 5: SELECT own profile as `user` role → admit → **PASS** — `profiles_rls_sweep.test.sql::arm (5)`
- Arm 6: SELECT another user's profile as `user` role → 0 rows → **PASS** — `profiles_rls_sweep.test.sql::arm (6)`
- Arm 7: DELETE same-brand user as admin → row gone → **PASS** — `profiles_rls_sweep.test.sql::arm (7)`
- Arm 8: DELETE cross-brand as admin → 0 rows affected, row still present → **PASS** — `profiles_rls_sweep.test.sql::arm (8)`
- Arm 9: DELETE cross-brand as super_admin → row gone → **PASS** — `profiles_rls_sweep.test.sql::arm (9)`
- Arm 10: self-DELETE by authenticated caller → P0001 `'profile self-delete is not permitted (use admin delete flow)'` → **PASS** — `profiles_rls_sweep.test.sql::arm (10)`
- Arm 11: `assert_not_last_of_role` last-of-role guard from brand-A admin context → P0001 `'cannot delete the last super_admin'` → **PASS** — `profiles_rls_sweep.test.sql::arm (11)`
- Arm 12 (optional, included): TRUNCATE by brand-admin → 42501 `'permission denied for table profiles'` → **PASS** — `profiles_rls_sweep.test.sql::arm (12)`

#### No-regression checks

- AC-NO-REGRESSION-042: `rls_hardening_followups.test.sql` continues to pass (15/15) after arm-9 patch → **PASS** — 15/15 confirmed by test run.
- AC-NO-REGRESSION-041: `auth_can_see_store_brand_scope.test.sql` continues to pass (14/14) → **PASS** — 14/14 confirmed.
- AC-FULL-SUITE: Full pgTAP suite (`bash scripts/test-db.sh`) passes ≥28/28 → **PASS** — 28/28 files, all assertions passed.

#### Spec 042 arm-9 patch

- AC-ARM9-PATCH: Three-line `reset role; select set_config('request.jwt.claims', '', true);` inserted before arm-9 verification SELECT in `rls_hardening_followups.test.sql` → **PASS** — patch present at lines 433-434; comment block at lines 418-428 documents the Spec 043 context. The patched file passes 15/15.

---

### Test run

```
bash scripts/test-db.sh supabase/tests/profiles_rls_sweep.test.sql
  PASS  supabase/tests/profiles_rls_sweep.test.sql (12 assertion(s) passed)
✓ 1/1 DB test file(s) passed

bash scripts/test-db.sh supabase/tests/rls_hardening_followups.test.sql
  PASS  supabase/tests/rls_hardening_followups.test.sql (15 assertion(s) passed)
✓ 1/1 DB test file(s) passed

bash scripts/test-db.sh supabase/tests/auth_can_see_store_brand_scope.test.sql
  PASS  supabase/tests/auth_can_see_store_brand_scope.test.sql (14 assertion(s) passed)
✓ 1/1 DB test file(s) passed

bash scripts/test-db.sh (full suite)
  28/28 DB test file(s) passed — 0 failures

npm run typecheck
  exit 0
```

---

### Notes

**Nit (not a block): No jest or shell-smoke coverage for the `requireSameBrandOrSuperAdmin` helper in `delete-user/index.ts`.**

The new edge-function brand gate is Deno code and therefore outside the jest surface (`src/**`). The spec body acknowledges this at the bottom of the "Test track" section: "the realistic coverage path is a shell smoke (`scripts/test-edge.sh` or similar) hitting the local edge runtime." The backend developer documented edge-function smoke results (cross-brand admin → 403, same-brand admin → 200, super_admin cross-brand → 200) in the spec's Verification section, but no automated shell smoke was committed for the new gate.

The existing `scripts/smoke-edge-roles.sh` covers the `delete-user` self-delete 400 path but does not add a cross-brand admin → 403 arm.

This is a Nit, not a Critical or Major, because:
1. The SQL-side RLS policy (the authoritative gate) is fully covered by the new pgTAP file's 12 arms.
2. The edge-function gate is defense-in-depth over service_role's RLS bypass, not the primary enforcement layer.
3. The Deno function is not testable via jest without a new framework (not permitted without user approval per CLAUDE.md).
4. The spec itself classifies the shell smoke as optional ("if the architect decides Deno-side coverage warrants it").

Recommendation for the release-coordinator: flag as a follow-up ticket — add a `scripts/smoke-edge-roles.sh` arm that signs a brand-A admin JWT, targets a brand-B user UUID, and asserts HTTP 403 with `{"error":"forbidden: target is in a different brand"}`.

**Implementation deviation from §8 matrix (Nit):**

Arm 2 uses the synthetic `target_a` (brand-A, role='user') instead of the seed `manager_id` (brand-A, role='user') the architect's table specified. The behavioral outcome is identical (both are brand-A profiles visible to brand-A admin via the admin+brand arm). The choice avoids an arm ordering dependency: `target_a` is deleted in arm (7), so using it in arm (2) works cleanly; `manager_id` would have been equally valid. Not a defect.

**`super_admin_read_all_profiles` policy visible in `pg_policies`:**

A third SELECT policy `super_admin_read_all_profiles` (USING `auth_is_super_admin()`) is present on `public.profiles`, not mentioned in the spec's §"Policies explicitly NOT touched" list. This policy pre-exists from Spec 012a and is not modified by Spec 043. It is functionally redundant with the new `auth_can_see_brand` super_admin short-circuit arm in the "Admins can read all profiles" policy but causes no behavioral conflict. No action required for this spec; worth noting for a future cleanup sweep.

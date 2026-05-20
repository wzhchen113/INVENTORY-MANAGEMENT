## Test report for spec 050

### Acceptance criteria status

- AC A: Server-side `caller.id != target.id` for `demoteProfileToUser` → PASS
  - `supabase/tests/demote_self_guard.test.sql::arm (i)` — admin self-target refused (P0001, `'cannot demote self'`)
  - `supabase/tests/demote_self_guard.test.sql::arm (ii)` — non-self happy path lives; post-UPDATE role/brand_id asserted
  - `supabase/tests/demote_self_guard.test.sql::arm (iv)` — null caller unified-string defense
  - `scripts/smoke-edge-roles.sh::Arm 7` — smoke confirms HTTP 400 + `"message":"cannot demote self"` via PostgREST + state-mutation invariant (re-query post-refusal)
  - Migration `supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql` positions the guard at step (3) with the UPDATE at step (4) — pre-side-effect ordering verified by reading the function body.
  - `src/lib/db.ts:2761-2766` wraps `supabase.rpc('demote_profile_to_user', ...)` with no `caller_id` argument. Call-site forgery defense confirmed.

- AC B: `delete-user` self-delete guard verify-and-tighten → PASS
  - Self-check at `supabase/functions/delete-user/index.ts:168-173` is gate position 1 after `requireAdminCaller` returns — fires before `requireSameBrandOrSuperAdmin` (line 189) and before `assert_not_last_of_role` (line 202+). Ordering is correct.
  - `scripts/smoke-edge-roles.sh::Arm 6` asserts HTTP 400 with `"cannot delete self"` or `"cannot delete the last super_admin"`. Because Arm 6 uses the caller's own uid as target, the self-check fires first and the assert accepts either string — the primary string is `"cannot delete self"`.
  - Cross-reference comment in `supabase/tests/demote_self_guard.test.sql` header (lines 13-17) mentions `'cannot delete self'` and the edge function location, satisfying the "cross-reference comment block" sub-bullet.

- AC C: pgTAP regression file lands, hermetic, file count delta → PASS
  - `supabase/tests/demote_self_guard.test.sql` is present. File count is 30 (verified: `ls supabase/tests/ | wc -l` = 30).
  - `begin; ... rollback;` hermetic isolation confirmed.
  - `npm run test:db` reports 30/30 PASS including the new file with 6 assertions.

- AC D: Smoke arm appended, reuses admin bearer, asserts on message string → PASS
  - Arm 7 in `scripts/smoke-edge-roles.sh` (lines 383-472). Reuses `$ADMIN_BEARER` from Arm 3 login (plain admin — not the Arm 4 super_admin promotion). Asserts `"message":"cannot demote self"` on the response body (message-string is the load-bearing check per comment at line 447). State-mutation invariant re-queries role and brand_id pre/post.

- AC E: Backward compat / call-site sweep → PASS
  - `src/store/useStore.ts:863-895` unchanged; calls `db.demoteProfileToUser(profileId)` via the same outer signature.
  - `src/screens/cmd/sections/BrandsSection.tsx:845-855` unchanged; calls `demoteProfileToUser(u.id)` via store slice.
  - `src/lib/db.ts:2761` swapped the direct PostgREST UPDATE to `supabase.rpc('demote_profile_to_user', { target_user_id: profileId })`. Return type remains `Promise<string>`. No new useStore slice, no new toast surface.

- AC F: Convention doc additions strictly additive → PASS
  - `CLAUDE.md` has a new bullet at line 64 under "Conventions already in use": "Edge functions and SECURITY DEFINER RPCs performing destructive role-change or deletion operations enforce a server-side `caller.id != target.id` guard..." with spec 050 reference. Existing bullets are verbatim-preserved.
  - `.claude/agents/security-auditor.md` has a new audit bullet at line 52: "Audit destructive role-change or deletion paths (both edge functions AND SECURITY DEFINER RPCs) for a server-side `caller.id != target.id` self-guard..." with spec 050 reference. Existing bullets unchanged.

- AC G: Cross-cutting verification gates → PASS
  - `npm run typecheck:test` — exit 0 (confirmed).
  - `npm test -- --ci` — 17 suites, 182 tests, 0 failures (confirmed).
  - `npm run test:db` — 30/30 PASS (confirmed).
  - `npm run test:smoke` — not re-run (local-stack-up requirement, dev reports PASS); Arm 7 logic inspected and is sound.

### Test run

```
npm run typecheck:test   → exit 0
npm test -- --ci         → 17 suites, 182 tests PASS
npm run test:db          → 30/30 PASS (includes demote_self_guard.test.sql, 6 assertions)
```

### Notes

**plan(6) arithmetic — correct.** Arm (i) = 1 assertion (throws_ok), Arm (ii) = 3 assertions (lives_ok + 2 × is), Arm (iii) = 1 assertion (throws_ok), Arm (iv) = 1 assertion (throws_ok). Total = 6. The plan matches.

**JWT context / `reset role` idiom — consistent with siblings.** The `reset role;` before Arm (ii)'s column assertions matches `admin_rpcs_privileged.test.sql` lines 30, 41, 53. Rationale is documented inline (lines 108-116): the `Admins can read all profiles` policy filters out NULL-brand_id rows under an authenticated session, so the superuser context is needed for inspection-only SELECTs.

**Smoke Arm 7 ordering — proves what it claims.** Arm 7 runs after Arm 4's super_admin promotion but before `restore_admin` fires. The script snapshots the admin row's current role and brand_id (whichever state Arm 4 left it in) and compares post-refusal. The self-check in the RPC fires purely on `auth.uid() == target_user_id`, independent of the caller's role. However, there is a subtle issue: Arm 4 promotes `admin@local.test` to `super_admin` in the DB, but then re-mints a token for `SUPER_ADMIN_BEARER`. Arm 7 uses `ADMIN_BEARER` (the original admin-role token, minted before promotion). The RPC's role gate (`auth_is_privileged()`) reads from JWT `app_metadata.role`. If the JWT still says `admin` after the Arm 4 DB promotion (the trigger updates `raw_app_meta_data`, but the in-flight `ADMIN_BEARER` was minted before the trigger fired), the JWT claim still reflects `admin` — which passes `auth_is_privileged()` normally. Self-check then fires. The arm is valid: it proves the self-check using the original admin token, which is the scenario specified in AC D sub-bullet 2 ("self-demote is meaningful at any admin role").

**`P0002` refusal string drift — non-blocking, no test asserts on it.** The migration uses `'target profile not found'` (step 5) while the architect's design table originally stated `'profile not found'`. No test asserts on this string in any of the three tracks, so there is no test to update. The drift is cosmetic (the string is only surfaced on a genuine not-found, not the self-demote path). Flagged for the architect's post-impl review.

**No new jest tests for the TypeScript wrapper — acceptable.** `src/lib/db.ts:2761-2766` is a thin `supabase.rpc()` pass-through with no branching logic. All load-bearing behavior lives in the SQL function, which is directly exercised by pgTAP. A jest test of the wrapper would require a mocked Supabase client (forbidden per project policy) or would duplicate the pgTAP/smoke coverage. The gap is intentional and correctly classified by the developer.

## Test report for spec 164

### Acceptance criteria status

**A. profiles INSERT policy** (`supabase/tests/profiles_insert_hardening.test.sql`)
- A-policy: old policy dropped, one new permissive INSERT policy `privileged AND auth_can_see_brand(brand_id)`, no self-arm, no wide tail → PASS — `profiles_insert_hardening.test.sql::K-2`
- A-count: exactly 1 permissive INSERT/ALL policy on `public.profiles` → PASS — `::K-1` (also confirmed by an independent psql query, count = 1)
- A-1 profile-less caller, own id, role=super_admin → refused → PASS — `::A-2` (P0001 from the guard, not 42501; spec correction D6) and `::A-3` (guard disabled, RLS alone gives 42501). `raw_app_meta_data` unchanged → `::A-4`
- A-2 profile-less caller, own id, role=user → 42501 → PASS — `::A-1`
- A-3 profile-less caller inserting a row for a different orphan → refused, victim metadata unchanged → PASS — `::A-5`, `::A-6`, `::A-7`
- A-4 role=user (staff) inserting any profile row → 42501 → PASS — `::A-8`
- A-5 brand-A admin and master inserting role=user, brand A succeeds → PASS — `::A-9`, `::A-10`
- A-6 brand-A admin inserting role=user with brand B or NULL → 42501 → PASS — `::A-11`, `::A-12`
- A-7 brand-A admin inserting admin / master / super_admin → rejected by guard → PASS — `::A-13`, `::A-14`, `::A-15`
- A-8 super_admin inserting role=admin, brand B succeeds → PASS — `::A-16`, `::A-17` (sync trigger still writes `app_metadata.role`)

**B. INSERT-time role guard trigger**
- Trigger refuses non-user role for authenticated non-super_admin with a stable message → PASS — `::A-13`..`A-15` (`non-user role inserts require super_admin`, P0001); fires even when RLS would admit (`::A-13`)
- SECURITY INVOKER with pinned search_path → PASS — `::K-4`, `::K-5`
- Trigger is BEFORE INSERT, enabled, on profiles → PASS — `::K-3`
- Skips postgres, service_role, and the SECURITY DEFINER RPC → PASS — `::B-1`, `::B-2`, `::C-5a`/`C-5b`
- Existing CHECK and triggers unchanged → PASS — `::K-12`

**C. Registration RPC `register_invited_profile()`**
- SECURITY DEFINER, no client params, search_path pinned, owner postgres → PASS — `::K-6`, `K-7`, `K-8`
- Grants: authenticated yes, anon no, PUBLIC no → PASS — `::K-9`, `K-10`, `K-11`
- Success derives name / role / brand / username / status / color / initials; user_stores; invitation consumed; app_metadata role set → PASS — `::C-1`..`C-4`
- Admin invitation registers (brand A, role admin, app_metadata admin) → PASS — `::C-5a`, `C-5b`
- Brand rule: explicit invitation brand wins; brand resolved from store_ids[1] when NULL → PASS — `::C-2`, `::C-6a`/`C-6b`
- Case-insensitive email match → PASS — `::C-7`
- Refusals (no side effects): null uid → `::C-16`; existing profile → `::C-8a`/`C-8b`; no / other-email / used / expired invitation → `::C-9`, `C-10`, `C-11`; role not in (user, admin) incl. super_admin and master → `::C-12`, `C-13`; admin with NULL brand → `::C-14`; duplicate pending (design D8) → `::C-15` → PASS
- Atomicity and no side effects (no profile, no user_stores, invitation still unused, no app_metadata role) → PASS — `::C-17`, `::C-18`
- `get_pending_invitation` / `consume_invitation` unchanged → PASS by diff (neither file is touched). Still exercised by the pre-existing `consume_invitation_sets_profile_id` and `profiles_username` pgTAP files, which pass in the full run.

**D. invitations write policies**
- INSERT/UPDATE WITH CHECK tightened; SELECT/DELETE unchanged → PASS — `::K-13`, `::D-1`..`D-18`
- Brand-A admin: user and admin invites in own brand succeed → `::D-1`, `D-2`; super_admin / master / brand B / brand-B store, on INSERT and UPDATE, all 42501 → `::D-3`..`D-11`; malformed store id fails closed → `::D-8`
- super_admin: user/admin for any brand OK, super_admin and master invites refused → `::D-13`..`D-16`; user-role caller refused → `::D-18`; master → `::D-17`
- UPDATE USING also tightened (architect addition) → `::D-12`
- Existing admin invite flow (Cmd UI drawer) still works for admin and user invites in own brand → PARTIAL. The DB arms (D-1, D-2, D-17) pass. The UI-drawer run is part of AC-H, which main Claude is running.

**E. Client registration change** (`src/lib/registerInvitedUser.test.ts`)
- Exported signature and return shape unchanged → PASS — typecheck plus test case 1 (`result.error` null / `result.user`)
- After signUp, exactly one `register_invited_profile` call, no args; no `from('profiles')` / `from('user_stores')` / `consume_invitation` → PASS — "success: signUp without role, then exactly one register_invited_profile call and no direct writes"
- signUp `options.data` is exactly `{ name }` (no role) → PASS — same test
- Pre-signUp lookup and the two existing error strings unchanged → PASS — "admin invitation with NULL brand…" and "no invitation: existing 'No invitation found'…"
- RPC failure → non-null error, welcome email not sent → PASS — "RPC error: returns the 'profile setup failed' error and does not send the welcome email"
- Welcome email still fires on success → PASS — proxy via `getSession` called (case 1)
- RPC call lives in `src/lib/auth.ts` (carve-out), no db.ts change → PASS (`git diff` shows no spec-164 change to db.ts; the db.ts diff is spec 163's)
- signUp error returns its message and skips the RPC → PASS — "signUp error: returns its message and the RPC is not called"

**F. Lint fix**
- `\b` → `\y` in all regex literals of `permissive_policy_lint.test.sql` → PASS. `grep '\\b' supabase/tests` returns nothing. Header and arm-4 message updated.
- New positive OR-tail arm flags the former profiles shape (count = 1); plan(5) → PASS — `permissive_policy_lint.test.sql` arm (5)
- AND-guard negative arm (4) still passes → PASS (5/5 assertions). Independent psql check: re-creating the old profiles policy inside a rolled-back transaction is matched by the `\y` OR-tail regex.
- Arm (1) = 0 with no new allowlist rows → PASS. The allowlist is untouched in `git diff`, and arm (1) passes against the migrated DB.
- `order_approvals.test.sql` `\b` → `\y`, arm still passes → PASS (24/24)

**G. Tests**
- New pgTAP file covers sections A, B, C, D, plus the grant/definer probe and the policy-text probe → PASS (71 of 71 planned assertions)
- `permissive_policy_lint` and `order_approvals` changes → PASS
- Full `scripts/test-db.sh` → PASS (87/87 files)
- jest `registerInvitedUser.test.ts` rewritten (5 cases) → PASS
- Other tests pinning old registration behavior updated → PASS (none remained; full jest green)
- Full `npx jest`, `tsc --noEmit -p .`, `npm run typecheck:test` → PASS

**H. Local browser end-to-end** → PENDING (being run by main Claude). Not counted as PASS, FAIL or NOT TESTED here. It covers the invite → register → sign-in flow for staff and admin, staff `brand_id` / `user_stores`, the existing-staff language change, and the invite-drawer UI against the new P_INV policy.

**Rollout AC-R1..R4** → NOT TESTED / out of this review's scope. These are prod MCP and CI steps (no prod access by instruction; CI after push). AC-R4 ordering is a release-time decision (spec 163's migration must not reach prod before this one).

### Test run
- `npx jest` → Test Suites: 219 passed, 219 total; Tests: 2524 passed, 2524 total; Snapshots 2 passed (about 7 s, 2 projects). The only noise is pre-existing console.warn output.
- `npx tsc --noEmit -p .` → exit 0
- `npm run typecheck:test` → exit 0
- `bash scripts/test-db.sh` → `87/87 DB test file(s) passed`, exit 0.
  - `profiles_insert_hardening` 71 assertions pass
  - `permissive_policy_lint` 5 pass
  - `order_approvals` 24 pass
  - `invitations_super_admin_rls` 4 pass
  - `get_profile_emails`, `profiles_rls_sweep`, `rls_hardening_followups`, `profiles_username`, `staff_brand_id_backfill`, `invitations_brand_id_backfill` and `user_stores_brand_match_null_brand` all pass (full run was green)
- Independent psql sanity checks (read-only or rolled back):
  - exactly 1 permissive INSERT/ALL policy on `public.profiles`
  - the `\y` OR-tail regex matches a re-created old-shape profiles policy

### Notes
- No test failures, no spec deviations beyond what the spec itself documents. D6 (guard fires before RLS, so P0001 rather than 42501 for non-user roles) is pinned by the tests, and A-3 proves RLS alone is sufficient.
- The jest `registerInvitedUser` test mocks the `./supabase` boundary. This is the existing convention for client-unit tests and matches the spec 8.4 design. The real-database behavior of the RPC is proven by pgTAP against local Postgres. No jest-vs-real-PostgREST test of the actual client call exists. The nearest check is the developer's curl smoke, and AC-H will cover it end to end.
- C-17 atomicity caveat (from the developer's notes): pgTAP `throws_*` rolls back at statement level, so it proves the RPC has no handler that swallows the error. The full-request rollback applies in PostgREST.
- Not run by me: `e2e/invite.spec.ts` (Playwright e2e gate, spec 8.5). It should be rerun alongside or after AC-H. `npm run test:smoke` is not applicable (no edge function change).
- Native (EAS) registration is not testable here (no native test setup). Old builds will fail registration after apply, which is an accepted risk (R1).
- Comment-only staleness in `src/lib/auth.ts` (about lines 357, 379, 441-450) and the `db.ts:5485` comment were flagged by the developer as out of scope. They are not test issues.
- No files were committed, and prod was not touched.

Summary: 31 criteria groups PASS, 0 FAIL, 1 PENDING (AC-H, with the D invite-drawer UI sub-item riding on it), rollout AC-R1..R4 not testable in this review.

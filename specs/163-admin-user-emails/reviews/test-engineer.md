## Test report for spec 163

### Acceptance criteria status

**Backend (RPC)**
- AC-B1: Migration creates SECURITY DEFINER STABLE function in `public` returning `(user_id uuid, email text)` from `auth.users` joined to `profiles` on `id` → PASS. `supabase/tests/get_profile_emails.test.sql` arms 1, 2, 4.
- AC-B2: `search_path` pinned → PASS. Arm 3 (`search_path=public, auth`).
- AC-B3: Visibility matches the `profiles` SELECT policy (`auth_is_privileged() and auth_can_see_brand(brand_id)`) → PASS. Arms 8-16.
  - super_admin sees every brand plus NULL-brand profiles → PASS. Arms 8, 9.
  - admin sees own brand only; brand-B and NULL-brand profiles return no row → PASS. Arms 11, 12, 13.
  - master follows the same own-brand rule → PASS. Arms 14, 15 (seed master, not promoted).
  - non-privileged authenticated caller gets 0 rows, own row included, no error → PASS. Arm 16 (the id list includes the caller's own id).
  - anon cannot run the function → PASS, via catalog check. Arms 6, 7. I also confirmed this against the live local DB: `has_function_privilege` returns anon=f, authenticated=t, public=f. `set role anon` + `throws_ok` is not used because of the spec-067 CI segfault (the design's documented adjustment).
- AC-B4: Orphan `auth.users` rows (no profile) never appear → PASS. Arm 10.
- AC-B5: Explicit grants (`revoke ... from public, anon`, `grant execute ... to authenticated`) in the same migration → PASS. Arms 5, 6, 7, plus the live `has_function_privilege` check. The migration text was read and the statements are present.
- AC-B6: Migration adds no RLS policies; the permissive-policy lint is unaffected → PASS. The migration contains no `create policy`. `supabase/tests/permissive_policy_lint.test.sql` passes within the full pgTAP run.
- Extra (design arms 17, 18): NULL and empty id arrays return 0 rows (fail-closed) → PASS.

**Data layer**
- AC-D1: `fetchProfileEmails` in `db.ts` calls the RPC via `track(..., {kind:'read', label})` and returns a `Map`; no other call site → PASS. `grep get_profile_emails src` shows a single `supabase.rpc` call, at `src/lib/db.ts:252`. Behavior is covered by the `fetchBrandAdmins` spec-163 cases, which call through the real helper with a mocked `supabase.rpc`: "calls the RPC with ONLY profile ids" and "skips the RPC entirely when the brand has no active profiles".
- AC-D2: `fetchAllUsers` precedence is RPC email, then invitation by `profile_id`, then invitation by `name`, then `''` → PASS. `src/lib/auth.fetchAllUsers.test.ts` cases "RPC email beats an invitation email for the same user", "falls back to invitation (profile_id, then name) when the RPC map lacks the user", and "returns '' when neither the RPC nor any invitation has the user".
- AC-D3: `fetchBrandAdmins` uses the same order for active rows, keeps pending `invitation:<id>` rows unchanged, and `activeEmails` dedup uses the resolved emails → PASS. `src/lib/db.fetchBrandAdmins.test.ts` ("RPC email beats ...", "falls back to invitation ...", "returns '' when neither ...", "pending dedup suppresses an unconsumed invite matching an RPC-resolved active email"). The existing spec-082/084 cases (a) through (g) still pass.
- AC-D4: If the RPC errors, both functions still return the full list from invitation emails, with `console.warn` and no toast → PASS.
  - `auth.fetchAllUsers.test.ts`: "RPC rejecting still returns the full list ..., warns, no toast".
  - `auth.fetchAllUsers.test.ts`: "fetchProfileEmails throwing synchronously still returns the full list".
  - `db.fetchBrandAdmins.test.ts`: "RPC error still returns the full list ..., warns, no toast".
  - `db.fetchBrandAdmins.test.ts`: "rpc call throwing synchronously still returns the full list".
  - The source uses the required async try/await wrapper in both consumers.
- AC-D5: When the RPC email and invitation email differ, the RPC value wins → PASS. The "RPC email beats an invitation email" cases in both test files.

**UI**
- AC-U1: With the RPC deployed, the identity line shows `@username · <email> · <shortId>` for an account with a username and an `auth.users` email but no invitation → PASS. New test `src/screens/cmd/sections/__tests__/UsersSection.identityLine.spec163.test.tsx::username + email + shortId when both exist`. Added in this review; it renders the real `UsersSection`/`UserRow` against a mocked `fetchAllUsers`. The data side (RPC email reaches `User.email`) is covered by AC-D2.
- AC-U2: The staged identity-line logic is unchanged: `@username`, then email, then shortId, and "(email not loaded)" only with no username and no email → PASS. The new test file has 3 more cases: username without email, "(email not loaded)" only with neither (exactly one occurrence), and email without username. `git diff` confirms `UsersSection.tsx` still carries only the staged change; no spec-163 edits were made to it.
- AC-U3: The Brands members tab shows the real email for a profile that now resolves via the RPC → PASS (indirect). `BrandsSection.tsx:972` renders `u.email || '(email not loaded)'`, and `fetchBrandAdmins` supplies `u.email` from the RPC (AC-D3 tests). There is no BrandsSection render test; see Notes.
- AC-U4: `PhoneUsers.tsx` needs no code change → PASS. It is unchanged in git, and `PhoneUsers.test.tsx` and `PhoneUsers.acReg.test.tsx` pass in the full jest run.
- AC-U5: Two expected behaviors need no code change (SEND RESET works, `requiredText` becomes the email) → PASS by inspection. Nothing in the diff touches those paths; the changed accessibility labels in `UsersSection.tsx` (adds a `username` fallback) do not alter either behavior.

**Tests**
- AC-T1: pgTAP file covers the listed arms (super_admin, admin, master, user, anon, orphan, `has_function_privilege`, definer/search_path) → PASS. `supabase/tests/get_profile_emails.test.sql`, 18/18 assertions, plan(18) matches.
- AC-T2: jest covers RPC-beats-invitation, invitation fallback, `''`, and RPC-throws for both `fetchAllUsers` and `fetchBrandAdmins` → PASS (see AC-D2 to AC-D5).
- AC-T3: Explicit `./db` mocks updated; full `npx jest`, `typecheck`, and `typecheck:test` pass → PASS. `auth.signIn.test.ts` has `fetchProfileEmails: jest.fn()`. `PhoneUsers.acReg.test.tsx` mocks `lib/auth`, not `lib/db`, so it is unaffected and was left alone.

**Rollout**
- AC-R1: Migration applied to prod via the Supabase MCP, with the schema_migrations row and the normalized-md5 check → NOT TESTED. Prod was deliberately not touched in this review, and the spec's "Not done" section says this is pending user approval. This is a ship gate for the release-coordinator, not a code defect. Per design §9 step 4, functional verification must be a UI check as a prod admin; MCP `execute_sql` has no JWT, so an empty result there proves nothing.
- AC-R2: After the push to `main`, the latest runs of `test.yml` and `db-migrations-applied.yml` are green → NOT TESTED. Nothing has been pushed. Per CLAUDE.md, apply to prod before pushing, or `db-migrations-applied` goes red. Also check `e2e.yml` manually after the push.

### Test run
- `npx jest`: 219 suites, 2523 tests, all passed. This is the 218 suites / 2519 tests baseline plus the 4-test UI file added in this review. Spec-163-relevant files: `auth.fetchAllUsers.test.ts`, `db.fetchBrandAdmins.test.ts`, `auth.signIn.test.ts`, and the new `UsersSection.identityLine.spec163.test.tsx` (36 tests across the first three files, all passing).
- `npx tsc --noEmit -p .`: exit 0.
- `npm run typecheck:test`: exit 0 (re-run after adding the new test file).
- `bash scripts/test-db.sh` (full): 86/86 DB test files passed, including `get_profile_emails.test.sql` (18 assertions) and `permissive_policy_lint.test.sql`.
- `bash scripts/test-db.sh supabase/tests/get_profile_emails.test.sql`: 18/18.
- Live local DB privilege check: `has_function_privilege` anon=f, authenticated=t, public=f.
- No failures to reproduce.

### Notes
- **File added by this review (needs developer awareness and the user's commit decision):** `src/screens/cmd/sections/__tests__/UsersSection.identityLine.spec163.test.tsx`. It sits in the existing jest track with no new framework. It was added because the spec's UI ACs (AC-U1, AC-U2) had no automated render coverage and the Tests section did not list one. It mocks only `lib/supabase`, `lib/auth`, and the breakpoints hook, the same as `PhoneUsers.acReg.test.tsx`; no DB is mocked. Nothing was committed or staged.
- **Gap, non-blocking:** the Brands members tab line (`BrandsSection.tsx:972`) has no render test. Coverage is via the `fetchBrandAdmins` data tests plus a one-line `u.email ||` render. Native and browser UI were not exercised; the developer's note says only HTTP-level checks were done. Design §9 step 4 (manual sign-in as a prod admin) remains the real end-to-end check.
- **Gap, by design:** the "anon gets permission denied" runtime behavior is pinned by catalog privileges rather than `set role anon`, because of the spec-067 CI segfault. The developer also reported a live HTTP check (anon key got 42501), which I did not re-run. The prod `has_function_privilege('anon', ...)` check in the rollout steps closes the same gap in prod.
- **Not a gap, one design-doc caveat:** jest `fetchBrandAdmins` tests mock `supabase.rpc`. That mocks the transport, not the DB, and the DB behavior is covered separately by pgTAP and the live local run.
- **Local `schema_migrations` drift:** the developer notes that the local `schema_migrations` lacks `20260819000000`, `20260829000000`, `20260829000100`, and the new version, because the migration was applied with `psql -f`. This is local-only and does not affect the tests. CI builds the schema from the migration files, so the new migration is exercised there on a fresh DB.
- **Release-coordinator:** AC-R1 and AC-R2 are NOT TESTED because they are post-implementation rollout steps that need user approval. All code and test ACs are PASS and nothing is FAIL. Treat the two rollout items as ship gates, not as test failures.

Summary: 22 PASS, 0 FAIL, 2 NOT TESTED (the two rollout gates).

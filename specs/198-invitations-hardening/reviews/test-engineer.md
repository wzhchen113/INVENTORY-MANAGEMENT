## Test report for spec 198 (invitations hardening)

Reviewer: test-engineer, 2026-11-10. Nothing was committed and no code or test was changed. e2e was read, not run. `smoke-edge-roles.sh`, `smoke-delete-user.sh`, `db reset` and `stop` were not run (shared stack).

### Acceptance criteria status

Legend: pgTAP = `supabase/tests/invitations_hardening.test.sql` (`IH`) unless another file is named.

#### A. Brand-scoped SELECT/DELETE
- A1 policies `to authenticated`, `auth_profile_is_privileged()`, no `auth_is_privileged()`, D-7 clause → PASS. `IH::K-a`, `IH::K-b`, plus `profiles_insert_hardening::K-13`.
- A2 brand-A admin sees and deletes 0 of the three out-of-scope rows → PASS. `IH::A2` (3 arms, including a postgres re-read proving the rows survived).
- A3 stale JWT claim on a `role=user` profile → PASS. `IH::A3` (SELECT 0, DELETE 0).
- A4 super_admin sees all, deletes a brand-B row → PASS. `IH::A4` (7 rows including the brand-less and legacy ones; delete = 1).
- A5 admin still sees and deletes own-brand rows → PASS. `IH::A5` (brand A, and NULL brand with only brand-A stores).
- A6 D-7 → PASS. `IH::A6` (7 arms). Small gap: the inviter's own DELETE of its brand-less row is not asserted (see Nits).
- A7 anon denied → PASS. `IH::A7` is catalog-only (anon can't run in pgTAP, spec 067). I confirmed behaviour live with read-only curls as anon: `GET /invitations` returns `[] 200`, `DELETE` returns `[] 200`, `check_invitation_code` wrong code returns `[] 200`, `get_pending_invitation` returns 404 PGRST202, `register_invited_profile` and `create_invitation` return 401/42501. Those curls are not part of the suite.
- A8 fail-closed counts and text → PASS. `IH::K-a`, `IH::K-b`. The migration's own DO block also ran at apply.
- A9 K-13 updated, `test:db` otherwise green → PASS for 198's scope. `profiles_insert_hardening` 80/80. K-6..K-11 and Section C/D also moved (AD-11 acknowledged). See the E-1 note under Should-fix.

#### B. Claim needs the invite code
- B1 code, hash, no plaintext stored → PASS. `IH::B1` (4 arms). The no-plaintext arm scans every column through `to_jsonb`, which is stronger than the AC asks. The AC says "at least 128 bits from a CSPRNG"; the 32-hex format is pinned but randomness is not (see Nits).
- B2 claim creates the profile as before → PASS. `IH::B2-staff` (5 arms: upper-case auth email, brand from store, username, initials, `user_stores`, `used`, `profile_id`, `app_metadata.role`), `B2-admin` (2), `B2-zero` (4), `B1`'s claim.
- B3 each refusal is P0001 `'no pending invitation'` with no side effects → PASS, with three weak arms. `IH::B3-1..9`, `B3-side`. See "Assertions that pass whatever" below.
- B4 no callable path claims without the code → PASS. `IH::K-e` (zero-arg dropped), `IH::K-f1/K-f2` (profiles-writer set pinned), `IH::K-g`.
- B5 select by code, not by email → PASS. `IH::B5` (3 arms: brand-B code claims, profile gets brand B, the brand-A row stays pending).
- B6 `get_pending_invitation` gone; code-gated pre-check gives one response → PASS. `IH::K-e`, `IH::K-g`, `IH::B6-agree` (17 fixtures, positive and negative controls, run before any claim consumes a fixture). The anon call path is covered by catalog plus my ad-hoc curls only. The real-anon positive path is exercised by e2e F2.
- B7 invite link in the drawer (jest) → PASS. `src/components/cmd/InviteUserDrawer.test.tsx` ("invite link (spec 198)": 9 tests, including copy, missing clipboard, native with and without a web URL, Cmd+Enter does not resubmit, a second invite shows the new code). `InviteAdminDrawer.test.tsx` (AD-10, 6 tests). `inviteLink.test.ts`.
- B8 re-invite replaces → PASS, partly asserted. `IH::B8-srv` (4), `B8-scope` (1), jest "second invite shows the new code", and `inviteUser.test.ts` asserts zero `from('invitations')` calls, so the old client-side "already exists" block is gone. Gap: both `create_invitation` calls in B8-srv use identical arguments, so "role, stores and username from the form" and "new expiry" for the replacement row are never asserted (see Should-fix).
- B9 `register-code` field and prefill (jest) → PASS. `src/screens/RegisterScreen.test.tsx` ("invite code (spec 198 B9)", 7 tests). `LoginScreen.registerHandoff.test.tsx` (6 tests, AD-6/AD-5). Note: the AC says the URL param is `code`; the design changed it to `invite` (AD-5), and the tests follow the design.
- B10 `registerInvitedUser` order, no table writes (jest) → PASS. `src/lib/registerInvitedUser.test.ts` (pre-check, then `signUp` with no `role`, then exactly one `register_invited_profile({p_code})`, `fromMock` never called, `get_pending_invitation` never called, `signUp` not called when the pre-check fails).
- B11 `send-invite-email` body carries the escaped link → PASS (jest half). `src/lib/sendInviteEmail.source.test.ts` (5 tests). The smoke half (`smoke-edge-roles.sh` Arm 3b) was NOT RUN by instruction, and no test renders the real HTML body (no Resend locally). Run the smoke before ship.

#### C. Bounded expiry
- C1 INSERT bound → PASS. `IH::C1` (5 arms: NULL and +8d refused 42501; omitted and +6d admitted; omitted stored as now()+48h).
- C2 UPDATE bound → PASS. `IH::C2` (4 arms, including the stale-claim caller affecting 0 rows).
- C3 legacy clamp → PASS, but see the "inline copy" finding. `IH::C3-pre`, `IH::C3` (2 arms; fixtures NULL, 2099, +7d12h edge, in-bound +3d).
- C4 `retention_prune_job` unchanged and green → PASS. Passed in the full `npm run test:db`.

#### D. Provenance and inviter re-check
- D1 `invited_by` stamped server-side → PASS. `IH::D1` (2 arms: a payload uuid is overwritten with the caller's).
- D2 UPDATE cannot change `invited_by` → PASS. `IH::D2` (2 arms: `invited_by` and `code_hash` unchanged).
- D3 claim refuses for a gone, demoted or other-brand inviter → PASS. `IH::D3-a` (no profile), `D3-b` (191-M1 replay: admin invite planted, super_admin demotes through `demote_profile_to_user`, claim and pre-check both refuse), `D3-c` (admin and master with a brand mismatch).
- D4 still-privileged inviter's invitee succeeds, reading `profiles` not the JWT → PASS. `IH::B2-staff / D4` (registrant JWT has no role).

#### E. Grant ride-alongs
- E1 `assert_not_last_of_role` → PASS. `IH::E1` (catalog). `smoke-delete-user.sh` NOT RUN (not by me, and the developer deferred it): the delete-user refusal strings are unchecked. Run before the prod apply.
- E2 `consume_invitation` → PASS. `IH::E2`, and `consume_invitation_sets_profile_id` 9/9 with the grant arm flipped.

#### F. Regression and end-to-end
- F1 `e2e/invite.spec.ts` → NOT RUN (by instruction); read and judged likely to pass in CI. See e2e assessment.
- F2 `e2e/invite-claim.spec.ts` → NOT RUN (by instruction); read and judged likely to pass in CI, with one unverifiable risk (V-5). See e2e assessment.
- F3 full jest, `typecheck:test`, `test:db` → PASS for 198's scope. jest and typecheck are fully green. `npm run test:db` currently exits red on one file that is not spec 198's (details below). The five named existing files all pass.
- F4 Users list and Brands members emails (jest) → PASS. `auth.fetchAllUsers.test.ts` and `db.fetchBrandAdmins.test.ts` pass (comment-only edits). These mock supabase, so they can't observe the RLS narrowing; that is as the design expected.
- F5 migration ASCII, `lock_timeout`, DO block, rollback file → PASS. I checked `grep -P '[^\x00-\x7F]'` (no hits) and the `set local lock_timeout = '5s'` lines in both the migration and `rollback.sql`. The DO block's effect is pinned by K-a/K-b/K-e/K-g/E1/E2. I did not re-run the rollback dry-run (it takes AccessExclusive on a shared table); I am relying on the developer's recorded dry run.

Totals: 36 PASS (counting each sub-criterion group once), 0 FAIL, 2 NOT RUN by instruction (F1, F2, e2e), 1 half-unverified (B11 smoke).

### Test run

- `bash scripts/test-db.sh supabase/tests/<file>` for the six named files:
  - `invitations_hardening`: PASS, 88 assertions
  - `profiles_insert_hardening`: PASS, 80
  - `invitations_super_admin_rls`: PASS, 4
  - `profiles_username`: PASS, 15
  - `staff_brand_id_backfill`: PASS, 11
  - `consume_invitation_sets_profile_id`: PASS, 9
- `npm run test:db`: 105/106 files passed. The one failure, run twice and reproduced both times:
  `supabase/tests/staff_role_eod_rls.test.sql`, `not ok 5 - (4) audit_log.detail is prefixed with auth.uid()::text`.
  Attribution: not spec 198. That file is modified by another session's spec 193 work (uncommitted, anchor-relative date fixture and the untracked `20261109190000_staff_eod_date_bound.sql`). The failing arm reads the latest `audit_log` row for Frederick by `id desc`, which is sensitive to other sessions writing to the shared stack. 198's migration touches neither `staff_submit_eod` nor `audit_log`. I did not bisect, so this attribution is by inspection, not proven.
- `npx jest`: 307/307 suites, 3948/3948 tests, 17 snapshots. No spec 192 EODCountSection flake showed up this run (the developer saw one in theirs).
- `npm run typecheck:test`: exit 0, no output. I also ran `npx tsc -p e2e/tsconfig.json`: clean.

### Assertions that pass whatever the behaviour was

1. **`IH::B3-9` (legacy row with no `code_hash`) is vacuous.** The registrant presents `c39`, a code that is never stored anywhere, so the claim refuses by "no row for this hash" exactly as in B3-3. A NULL `code_hash` can never equal a hash, so the "legacy no-code" behaviour can't be distinguished from a wrong code. The developer's own mutation note says the same. It is still harmless to keep, but it proves nothing the B3-3 arm doesn't.
2. **`IH::B3-4` ("another invitation's code") tests the same predicate as `B3-5`.** Selecting by code means B3-4 always reduces to an email mismatch (r31 presents b34's code). Removing the email check turns both red together. Redundant, not wrong.
3. **`IH::B3-1` and `B3-2` do not pin R3b.** The developer is right that removing R3b alone stays green, because `sha256(NULL)` and `sha256('')` match no stored hash. The judgement call "layered, equivalent mutant" holds for NULL. It does not hold for the empty string, and I confirmed that with a rolled-back probe on the local DB: an invitation whose `code_hash = sha256('')` (writable directly by any privileged in-scope caller, because the INSERT policy only requires a 64-hex `code_hash`) makes `check_invitation_code(email, '')` return 1 row, while `register_invited_profile('')` refuses at R3b. So the pre-check and the claim disagree in exactly the case R3b exists for. Impact is small (the planter is already a privileged in-scope inviter, RegisterScreen blocks non-32-hex client-side, and the claim still refuses), but B6-agree says it pins this agreement and it does not. See Should-fix 1.
4. **`IH::B3-3` mutation staying green when only R3c's `if not found` is removed:** accepted. The all-NULL record falls to R3d's `expires_at is null` check and raises the same string, so behaviour is unchanged (a true equivalent mutant). The arm is still protective, because if the NULL-expiry rule were ever relaxed the fall-through would reach R5 and raise a different message, turning B3-3 red.
5. **`scripts/smoke-edge-roles.sh` Arm 5 is now vacuous.** Its payload has no `inviteCode`, so the function returns 400 "inviteCode required" before building any HTML or reaching the fallback. The arm's pass condition ("200 or any 4xx, body without `<script>`") is met by that 400 whatever `escapeHtml` does. The developer flagged this (note 7). It no longer exercises what spec 028 meant it to.
6. **`IH::C3` is not a test of the migration's clamp.** It executes an inline copy of the clamp UPDATE. Byte-identity with the migration is by convention only (stated in a comment), so editing the migration's clamp alone (for example 7 to 8 days) stays green. The developer's mutation changed both copies, which is why it went red. C3-pre only reads post-apply state, which is trivially 0 on a DB with no legacy rows.
7. **`IH::B8-srv` replacement content:** both calls pass the same arguments, so an implementation that kept the old row's role, stores or username would pass. Only the old-code-fails and new-code-passes parts are proven.

### Judgement on the developer's notes

- **B3-1/B3-2 staying green (R3b removed):** accept for NULL, reject for blank. See item 3. The fix is one extra fixture (an invitation hashed from `''`) that makes `B6-agree` and a blank-code claim assert 0 rows and P0001. That fixture also turns up the real divergence in `check_invitation_code`, which needs the same blank guard.
- **B3-3 staying green (`if not found` removed):** accept (item 4).
- **B3-9 "no predicate of its own":** accept the explanation, but it means the arm cannot go red for a legacy-row regression, so do not count it as coverage of "legacy invitation with no code" beyond B3-3.
- **A4 stand-in (remove `auth_is_super_admin()` from D7):** valid. The listed mutation did not fit D7, and the stand-in genuinely turns A4 red because the legacy NULL-inviter row becomes invisible to the super_admin. It also exercises the arm A6 relies on.
- **D3-b stand-in (remove R7's role test):** valid. The claim never receives the inviter's JWT, so "check the inviter via the JWT" is unbuildable. Removing the role test is the right equivalent: after `demote_profile_to_user` the inviter's role is `user`, and without the role test the claim would succeed, which turns the arm red. D3-a covers the "profile gone" half. D3-c covers the brand half.
- **Other deviations:** the C3 `+7d12h` fixture is a good catch (the design's own mutation could not turn C3 red without it). The `profiles_insert_hardening` E-1 deferral is the weakest. E-1 now passes with two simultaneous causes (no privilege and no `code_hash`), so it no longer isolates the privilege leaf; CI-2, A3, C2 and E-2 do cover it. It must be fixed once spec 191 is committed.

### Gaps, ranked

**Critical**
- None from the test run. Spec 198's own suites are green on all three tracks that I was allowed to run.
- Release note for the coordinator: the repo-wide `npm run test:db` is currently red (`staff_role_eod_rls`, spec 193's in-flight change), and CLAUDE.md requires `test.yml` to be green on `main`. That is outside 198, but 198 cannot be CI-green until the other session's work is resolved or landed. Say so rather than treating 198 as the cause.

**Should-fix**
1. **Blank-code divergence** between `check_invitation_code` and `register_invited_profile` (item 3). Add a blank-code guard to the pre-check (CP) and a fixture with `code_hash = sha256('')`, asserting both refuse. This is the only place a mutation on R3b can be caught.
2. **Clamp copy drift (C3).** Add a jest source probe (like `sendInviteEmail.source.test.ts`) that asserts the migration contains the exact clamp statement that `IH::C3` runs, or have the pgTAP file read it. Otherwise the test can stay green while the shipped clamp is wrong.
3. **B8-srv replacement content.** Re-invite with different `role`, stores, username and brand in the second call, and assert the surviving row carries the second call's values.
4. **Run the smokes before ship.** `smoke-edge-roles.sh` (Arm 3b is the only B11 smoke evidence) and `smoke-delete-user.sh` (E1) were not run by me or the developer.
5. **Smoke Arm 5** (item 5). Send a valid 32-hex `inviteCode` so it reaches the fallback again.
6. **`profiles_insert_hardening` E-1** needs a `code_hash` after spec 191 is committed, so it isolates the privilege leaf again.
7. **Behavioural anon coverage.** A7 and the B6 anon claims are catalog-only in pgTAP. Add a small `smoke-rpc.sh` arm with the curls I ran (anon `GET`/`DELETE` on `invitations` return `[]`, `check_invitation_code` wrong code returns `[]`, the dropped `get_pending_invitation` returns 404, `register_invited_profile`/`create_invitation` return 401).

**Nits**
- `IH::A6` does not assert the inviter's own DELETE of its brand-less row.
- No explicit CSPRNG/uniqueness arm for B1. A constant code would be caught only indirectly (B8-srv arm 2 and the unique index).
- `IH::B3-4` duplicates `B3-5` and `B3-9` duplicates `B3-3` (items 1 and 2). Consider collapsing them.
- `sendInviteEmail.source.test.ts` pins exact source strings, so it is refactor-fragile and says nothing about the rendered HTML. Extracting a pure `buildInviteEmailHtml()` would allow a behavioural test.
- `e2e/invite-claim.spec.ts` stub fulfills with no `Access-Control-Allow-Origin` header, so the browser will likely reject the stubbed response and the app may toast an error. The test still passes, because the request body is captured in the route handler and the send is fire-and-forget.
- `F2`'s `profiles` check filters by `name = 'E2E Wrong Code'`; the authoritative check is the null auth-user lookup before it.

### e2e assessment (not run)

`npx tsc -p e2e/tsconfig.json` is clean.

- **`e2e/invite.spec.ts` (F1): likely passes in CI.**
  - `send-invite-email`'s local fallback ignores the `inviteUserByEmail` result and always returns `200 {success:true, method:'supabase-auth'}` unless it throws, so `expect(status).toBe(200)` does not depend on local SMTP working. The new `inviteCode` check runs first and the code is valid format, so it gets past the 400.
  - The fallback does create an `auth.users` row for the `e2e-invite+<runId>` email. That is harmless here (F1 never registers it).
  - `waitForResponse` is armed before the click. If a CORS preflight is reported it is also a 200.
  - The service-role read checks `used=false`, a 64-hex `code_hash`, and `invited_by` equal to the master seed id `33333333-...`. The pgTAP file uses the same id as the seeded master, so that holds.
  - The `invite-link` regex and the `invite-done` flow match `InviteLinkPanel`.
- **`e2e/invite-claim.spec.ts` (F2): likely passes in CI, one risk I cannot verify without running it.**
  - The `page.route` stub of `send-invite-email` is the right handling of the local `inviteUserByEmail` fallback: it stops the invitee's `auth.users` row being pre-created, and the guard (`authUserIdFor(claimEmail)` is null) fails fast with a clear message if the stub stops working.
  - The route is armed before the submit click, and the request body is checked against the link's code.
  - AD-6 is exercised (`register-code` value comes from the route param after `replaceState`).
  - The negative arm flips the last hex char, asserts the exact `NO_PENDING_INVITATION_ERROR`, and checks that no auth user exists. That is a real end-to-end proof the pre-check blocks before `signUp`. It also exercises the real anon `check_invitation_code` path.
  - Selectors all exist in source (`invite-store-<id>`, `invite-link`, `invite-done`, the `register-*` ids, `signin-*`, `eod-store-name`, `store-row-*`); the Towson id `...0001` is the seed constant.
  - **Risk (V-5):** after `signUp` with autoconfirm, the client holds a session. The spec's claim that RegisterScreen's success state stays up (RoleRouter keys off stores rather than the raw session) is plausible from `App.tsx`, which has no `onAuthStateChange` routing, but it can only be confirmed by running. If that fails, `register-success` will not appear and the test will fail for a reason unrelated to the security change.
  - Second smaller risk: the staff landing for a one-store user relies on the `eod-store-name` or the picker, with the picker tolerated.

### Notes

- No fourth test framework was introduced. All tracks used are the three in-tree ones plus Playwright (`e2e.yml`, already present).
- No FAIL against any acceptance criterion in 198's own scope. NOT RUN items are e2e (CI by instruction), `smoke-edge-roles.sh` Arm 3b, `smoke-delete-user.sh`, and the rollback dry-run (developer-attested only).
- The scratch SQL I used for the blank-code probe was run inside `begin ... rollback` and left no rows. The curls were read-only except an anon `DELETE` that matched no rows.

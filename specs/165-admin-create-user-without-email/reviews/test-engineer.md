## Test report for spec 165

### Acceptance criteria status

Test paths: S = `scripts/smoke-store-user.sh` (arm numbers per its header), J = jest, E = `e2e/add-user.spec.ts`.

**A. Create store user (server)**
- A1 server-side create path, inputs `{name, username, password, storeIds}` only, no role/brand/email/id → PASS. S arm 9 (response keys exactly `{id, username}`), arm 10 (client `role:"admin"`, `id`, `email`, `brand` ignored).
- A2 caller gate (401 no bearer; 403 for `user` role; nothing created) → PASS. S arm 1, arm 2 (create and set_password), "no profile created by any refused request".
- A3 role always `'user'` → PASS. S arm 9, arm 10.
- A4 store and brand rules → PASS. Empty `storeIds` 400: S arm 4. Unknown or mixed-brand 400: S arm 5. Brand derived and non-NULL: S arm 9. Cross-brand admin 403, with the `delete-user` wording: S arm 3. super_admin cross-brand allow path is not exercised. There is no local super_admin. See Notes.
- A5 username rules → PASS. Format: S arm 6. Reserved: S arm 7. Lowercase on write: S arm 9. Duplicate (case-insensitive) 409 `username taken`: S arm 11.
- A6 name required → PASS. S "blank name → 400".
- A7 password at least 8 chars, GoTrue rejection mapped to 400 → PASS (min length). S arm 8, arm 8b. The GoTrue weak-password mapping branch is code-read only and not exercised, since local GoTrue allows 6+.
- A8 success state: confirmed placeholder auth user, no email sent, profile fields, one `user_stores` row per store, `raw_app_meta_data.role='user'`, 201 `{id, username}` → PASS. S arm 9 (all DB assertions), arm 19 (Mailpit shows 0 messages).
- A9 compensation, no partial state → PASS. S arm C forces a `user_stores` failure with a temporary trigger. It asserts 500, auth user and profile rolled back, username released, and the same username then succeeds. S arm 11 asserts no orphan after the 409.
- A10 no client INSERT into `profiles` / `user_stores`; spec 164 policy and trigger unchanged → PASS. `test:db` 87/87, including `profiles_insert_hardening`, `permissive_policy_lint`, `user_stores_brand_match_*`. No migration in the diff.
- A11 password never in logs or responses → PASS for responses (S arm 18 greps 27 captured bodies). Logs: backend reported an edge-runtime log check, and I did not repeat it. Code has no log of the body.

**B. Set password (server)**
- B1 path takes `{userId, password}` → PASS. S arms 13-17.
- B2 caller gate (401/403) → PASS. S arm 2 covers set_password as a `user`. Arm 1 covers the missing bearer.
- B3 self-guard `'cannot set password for self'` before any side effect → PASS. S arm 13 (including an uppercased UUID).
- B4 target rules → PASS. Non-`user` target or unknown target 403: S arm 14. Real-email target 400 `account has an email; use password reset`, with the password unchanged: S arm 15. Malformed id 400: S arm 14. Cross-brand target 403 is not exercised directly (there is no brand-B `user` fixture); it shares the gate code with create arm 3. Nothing else blocks.
- B5 password re-validated server-side → PASS. S arm 8b.
- B6 success: new password works, old fails, `{success:true}` with no echo → PASS. S arm 16, arm 17.
- B7 existing sessions revoked → PASS. S arm 16 (S-REV): 2 live sessions, then both refresh tokens return 400 and `auth.sessions` count is 0.

**C. Placeholder email**
- C1 non-deliverable `.invalid`, accepted by GoTrue → PASS locally (S arm 9 on every run, arm 19). Prod acceptance is a rollout probe (K).
- C2 single shared predicate, identical copies → PASS. J `src/lib/placeholderEmail.test.ts` (positive and negative) and `src/lib/placeholderEmail.parity.test.ts` (byte-parity across the TS file and the four Deno copies, plus the reserved-usernames block). A lint rejects other `src/**` files mentioning `no-email.invalid`.
- C3 unique per account, independent of username and user id → PASS. S arm 9 ("placeholder is independent of username and user id").
- C4 never returned or shown → PASS. S arm 18. D coverage below.
- C5 typing the placeholder into login gives no extra capability → PASS by design analysis. `signIn` is unchanged (diff of `auth.ts` is additive) and `auth.signIn.test.ts` still passes.

**D. Display**
- D1 desktop identity line `@username · shortId` + marker, no email or "(email not loaded)" → PASS. J `UsersSection.storeUser.spec165.test.tsx::shows @username · shortId…`.
- D2 phone list meta / detail / name fallback → PASS. J `PhoneUsers.test.tsx` spec 165 cases (meta, name fallback, detail subtitle).
- D3 delete confirm, desktop and phone → PASS. Phone: J `PhoneUsers.test.tsx::delete confirm requires the username`. Desktop: previously only helper-level (`userIdentity.test.ts`), so **I added** J `UsersSection.storeUser.spec165.test.tsx::username-only account: confirm requires the username…` and a real-email control.
- D4 Brands members tab + delete-profile modal → PASS. J `BrandsSection.members.spec165.test.tsx` (4 tests). This runs through the exported `MembersTab` / `DeleteProfileModal`.
- D5 `CascadePreviewModal` never renders the placeholder → PASS. The mapper is covered in J `db.fetchBrandAdmins.test.ts::previewBrandCascade (mapCascadePreview)`. The modal render side had no test, so **I added** J `src/components/cmd/CascadePreviewModal.spec165.test.tsx` (username-only row shows "username sign-in", real-email row unchanged).
- D6 data-layer clearing and `loginKind` → PASS. J `auth.fetchAllUsers.test.ts` and `db.fetchBrandAdmins.test.ts` spec 165 cases, including the name-matched unrelated invitation.
- D7 RESET PW hidden, SET PASSWORD shown (desktop and phone) → PASS. J `UsersSection.storeUser.spec165` ("hides RESET PW…", real-email unchanged control) and `PhoneUsers.test.tsx` ("SET PASSWORD replaces RESET PW").
- D8 `activeEmails` ignores placeholders → PASS. J `db.fetchBrandAdmins.test.ts`.

**E. Outbound email**
- E1 `eod-reminder-cron` and `weekly-reminder-cron` skip the Resend fallback for placeholders → PASS, weak coverage. There is no behavioral test of either cron. Evidence: predicate block byte-parity (J parity test) and a code diff showing `lookupEmail` returns `null` for placeholders. Deno cron bodies can't be driven from jest, and a cron smoke would need Resend/push fixtures. Accepted, see Notes.
- E2 audit of the other emailing functions recorded in the design → PASS (design §6). `send-welcome-email`, the one function reachable by a placeholder account, got a smoke arm. **I added** S arm 20: a signed-in placeholder user calling it gets 200 `{success:true, skipped:"placeholder"}`. Verified, 3 consecutive passing runs.

**F. Add user drawer**
- F1 `users-add-trigger` beside the unchanged invite trigger → PASS. J `UsersSection.storeUser.spec165::renders + ADD USER next to…` and `::opens the add-store-user drawer`. E also exercises it.
- F2 `phone-users-add` beside INVITE; guard-after-hooks preserved → PASS. J `PhoneUsers.test.tsx::ADD USER opens the add-store-user drawer…`; `PhoneUsers.acReg.test.tsx` still passes.
- F3 fields, lowercase, live validation, secure entry with toggle, brand-filtered stores → PASS. J `AddStoreUserDrawer.test.tsx` ("lowercases…", "show/hide toggles…", "only lists the active brand stores").
- F4 no role picker, account-type explainer → PASS. J `::has no role picker or email field…`.
- F5 no-brand notice and zero-store notice, submit disabled → PASS. J `::no-brand view…`, `::a brand with zero stores…`.
- F6 submit gating and footer hint → PASS. J `::keeps submit disabled until…`.
- F7 success behavior (toast with username, password cleared, close, refresh) → PASS. J `::sends the four fields, toasts @username (never the password), clears the password, refreshes + closes`. The new row appearing in the list is covered by E (`add-user.spec.ts`).
- F8 error behavior (taken, forbidden, server string; drawer stays open) → PASS. J `::maps "username taken"…`, `::maps forbidden*…`, `::passes any other server string through verbatim`.
- F9 password never persisted or logged → PASS. J `auth.storeUser.test.ts` (password absent from every console call and toast) and the drawer tests. The password is local `useState` only (no store/storage code in the diff).
- F10 via `callEdgeFunction`, no raw fetch → PASS. J `auth.storeUser.test.ts` (envelope and body shape).
- F11 hero and empty-state copy mention add-user → PASS by inspection (`UsersSection.tsx:225,259`). No automated assertion, and the strings are copy.
- F12 i18n in `en` / `es` / `zh-CN` → PASS. Existing i18n parity jest suites are green on the added keys.

**G. Set password action**
- G1 SET PASSWORD replaces RESET PW when `canResetPassword` → PASS. J `UsersSection.storeUser.spec165` (desktop, including a non-master admin viewer) and `PhoneUsers.test.tsx`.
- G2 sheet content: secure field with toggle, 8-char gate, `@username` target, sessions note → PASS. J `SetStoreUserPasswordModal.test.tsx` ("names the target…", "gates submit on an 8-character password and toggles secure entry").
- G3 success and error toasts, password cleared on close → PASS. J `::calls setStoreUserPassword, toasts success…`, `::shows the server error string…`, `::clears the password when closed and re-opened`. E also covers the live flow.
- G4 real-email rows unchanged → PASS. J `UsersSection.storeUser.spec165::real-email rows are unchanged`; `PhoneUsers.test.tsx`.

**H. Sign-in and staff app**
- H1 created user signs in by username through the login portal, lands in StaffStack with the assigned stores → PARTIAL (decomposed, see Notes). Verified: password sign-in against the account's `auth.users` email (S arm 12). The `signIn` → `resolveUsernameToEmail` → `signInWithPassword` mapping is unchanged and covered with mocks by `auth.signIn.test.ts`. Staff landing was verified manually by the frontend developer, using the account's auth email. **Not verified end to end: the live `username-resolve` call returning the placeholder, and the portal typing a username.** See the gap decision.
- H2 after set-password the new password works and the old returns `GENERIC_LOGIN_ERROR` → PASS at the GoTrue boundary (S arm 17: old 400, new 200). The `GENERIC_LOGIN_ERROR` string mapping is unchanged pre-existing code (`auth.signIn.test.ts`).
- H3 `signIn` / `username-resolve` unchanged, anti-oracle intact → PASS. No diff in `supabase/functions/username-resolve`; `auth.ts` changes are additive; `username_resolve_rate_limit.test.sql` passes.

**I. Deletion**
- I1 existing `delete-user` flow removes the placeholder account, no gate changes → PASS. E (`add-user.spec.ts` deletes the created account through the real DELETE flow; teardown leaves no row). Frontend also confirmed 0 auth/profile/user_stores rows. No diff in `delete-user`.

**J. Tests**
- J1 shell smoke for create and set-password → PASS. `scripts/smoke-store-user.sh`: all arms PASS, 1 SKIP (arm 12 resolve step).
- J2 pgTAP → PASS / N/A. The design adds no SQL, and the diff has no migration. The existing 87 DB files pass.
- J3 jest → PASS. Every item listed in the AC has a test (see D/F/G). Existing pinning tests were updated, not deleted.
- J4 e2e (optional) → PASS. `e2e/add-user.spec.ts` passes locally (4 passed including setup). Its header records that username sign-in is skipped because `e2e.yml` has no `USERNAME_RESOLVE_SERVICE_TOKEN`.
- J5 local browser verification → PARTIAL. The developer reported create, set password, delete, no placeholder visible on Users (desktop and phone), and dark mode. Username sign-in and the Brands tab were not in the browser (same gaps as above).

**K. Rollout** → NOT TESTED (deploy-time steps, not verifiable pre-deploy): prod function deploys, `verify_jwt` pin (the `config.toml` entry is present and `true` locally), cron redeploys, prod `.invalid` probe, GoTrue notification setting, and post-push `test.yml` / `db-migrations-applied.yml` / `e2e.yml` runs. These belong on the release checklist. They are not code defects, but the release-coordinator should not mark them done.

### Test run
- `npx jest`: **229 suites passed / 2637 tests passed** (was 228 / 2633 before my additions of 1 suite and 4 tests). 0 failing.
- `npm run typecheck`: pass.
- `npm run typecheck:test`: pass (re-run after my test additions).
- `npm run test:db`: **87/87 DB test files passed.**
- `bash scripts/smoke-store-user.sh` (local stack; edge-runtime mount confirmed under the repo root): **ALL ARMS PASSED**, 1 SKIP (arm 12 `username-resolve`, no local `USERNAME_RESOLVE_SERVICE_TOKEN`), including my new arm 20. Ran 3 times after adding arm 20; cleanup left 0 `zz_*` profiles and 0 `zz_s165` / placeholder auth users.
- `npx playwright test e2e/add-user.spec.ts`: 4 passed.
- One transient observation: the first smoke run after the Playwright run failed at preflight (`fixture stores missing`, brand B store id empty) and cleaned up. Two reruns passed. I could not reproduce it. Treat it as a possible fixture-creation flake (Playwright global-teardown racing the psql insert is my guess; unconfirmed).

### Notes

**Tests I added (clearly in the test-engineer lane, no existing test edited or deleted):**
1. `src/components/cmd/CascadePreviewModal.spec165.test.tsx` (new): render-side proof for D5.
2. `src/screens/cmd/sections/__tests__/UsersSection.storeUser.spec165.test.tsx`: appended a `describe` for the desktop delete confirm (D3). The file header already claimed this coverage, but no test existed.
3. `scripts/smoke-store-user.sh`: new arm 20 (`send-welcome-email` skips a placeholder account), closing the only live-verification hole for §E that the backend had checked by hand.

**Gap decisions**
- **Username sign-in end to end is not runnable locally (`USERNAME_RESOLVE_SERVICE_TOKEN`): does NOT block, with a condition.** The unverified part is narrow. `username-resolve`, `signIn`, and the portal are pre-existing and untouched (the diff touches none of them, and spec 095 tests still pass). The new behavior (a placeholder email that signs in with the admin-set password) is proven at the GoTrue boundary by arms 12 and 17. Condition: rollout step K's prod probe (create `zz_probe165`, sign in by username in the staff app, delete) is the first real end-to-end username sign-in. The release-coordinator should treat that probe as mandatory, not optional. If the owner wants it closed before ship, set `USERNAME_RESOLVE_SERVICE_TOKEN` on the local edge runtime (and `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN` in the bundle) and re-run; arm 12's resolve branch already handles a present token. I did not change the local environment.
- **Brands members tab and cascade preview verified only through jest: does NOT block.** There is no local super_admin, and the behavior is pure rendering from `loginKind`, which is the right layer for jest. The two data mappers and both render paths (members tab, delete modal, cascade modal) now have tests. The residual risk is a layout or visual issue, not a correctness one.
- **Smoke script not in `test:smoke`: does NOT block, recommend a follow-up.** Nothing in `.github/` calls `test:smoke`, so wiring it would change local ergonomics only. `smoke-edge-roles.sh` is in that script and mutates state the same way. A one-line `package.json` change (`&& bash scripts/smoke-store-user.sh`) plus the `tests/README.md` "ships three" line is a reasonable follow-up. I did not make it because it is shared tooling outside the test files, and `package.json` has no other spec 165 change.

**Other gaps, non-blocking**
- No test exercises the super_admin allow path (create in any brand, brand-gate skip) or admin/master with a NULL-brand profile, because there is no local super_admin. The branch is small and mirrors `delete-user`.
- The GoTrue weak-password to 400 mapping branch isn't exercised locally (local minimum 6, function minimum 8). It matters on prod only if `password_requirements` is stricter.
- Cron placeholder skip (E1) rests on byte-parity of the predicate plus code review. A behavioral cron check is not cheap to build.
- Cross-brand `set_password` target (B4 third bullet) has no dedicated smoke arm, since there is no brand-B `user` fixture.
- Known follow-up from the backend notes: local GoTrue sends a "Reset your password" mail for `POST /auth/v1/recover` with a placeholder address (design §6(b)). That is out of scope and needs a Send-Email hook spec. It is the only way a placeholder address can still receive GoTrue mail, so keep it on the follow-up list.

**Summary for release-coordinator:** 0 FAIL. Everything except H1 / J5 (PARTIAL, non-blocking with the prod-probe condition above) and K (rollout, not yet performed) maps to a passing test. No framework gaps; all new tests are in existing tracks (jest, shell smoke).

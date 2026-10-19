# Spec 165: release proposal

Author: release-coordinator, 2026-10-18
Inputs read: `specs/165-admin-create-user-without-email.md` (AC, design, Files changed), and the four reviewer files in this directory (`code-reviewer.md`, `security-auditor.md`, `test-engineer.md`, `backend-architect.md`). I re-read `supabase/functions/manage-store-user/index.ts:288-452` myself to confirm architect S2, and grepped `src/` to confirm the hard-coded marker and `package.json:18` to confirm the `test:smoke` gap.

CI state on `main` at HEAD `4ea74ff` (reported by the dispatcher, checked just now): `test.yml` success, `db-migrations-applied.yml` success, `e2e.yml` success. The spec 165 work is staged, not committed, not pushed, not deployed. It adds no migration, so `db-migrations-applied` is not affected by this change.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical and every CI gate is green, but one should-fix breaks the AC A "no partial state" guarantee (a thrown exception after `createUser` skips compensation), and the fix is small enough to make before the commit.

Once the four items in (a) are done, this is ready to ship. They are cheap, local, and make no contract change. None of them needs another full review round: re-running jest, both typechecks, and the smoke script is enough.

## Findings summary
- **code-reviewer:** 0 Critical, 4 Should-fix, 10 Nits.
  - Top issues:
    - `scripts/smoke-store-user.sh` is not wired into `test:smoke` or `tests/README.md`.
    - The Brands delete-confirm `requiredText` for **email** accounts changed from name-first to email-first. This is outside AC D, though it follows design §7.
    - The password field block is duplicated across `AddStoreUserDrawer` and `SetStoreUserPasswordModal`.
    - The marker `'username sign-in'` is hard-coded in English on the desktop surfaces while the phone tier uses i18n.
  - Flag for rollout: `deno check` has not been run on `manage-store-user/index.ts`. The reviewer's manual type read found no errors.
- **security-auditor:** 0 Critical, 0 High, 1 Medium, 7 Low. Nothing blocks merge.
  - M1: `username-resolve` returns the placeholder, so anyone with the anon key can trigger `/auth/v1/recover` to a `.invalid` address. Each send is a guaranteed hard bounce and burns the shared `email_sent` budget. The fix is the Send-Email hook follow-up, plus an owner check of which SMTP provider prod uses.
  - Low items:
    - L1: the "Password changed" notification must be off in prod.
    - L2: an already-issued access token outlives `set_password` by up to 1 hour. Accepted, and the UI copy says so.
    - L3: also refuse when the target's `app_metadata.role` is not `user`.
    - L4: there is no audit record of `create` or `set_password`.
    - L5: an 8-character floor on a guessable username. This is a policy call.
    - L6: brand-gate wording reveals whether a foreign UUID exists. Negligible.
    - L7: `delete-user`'s self-guard can be bypassed with an uppercase UUID. Pre-existing.
  - All gates verified: ADMIN_ROLES parity, brand derivation, literal role, self-guard, target rules, rollback, log hygiene, spec 164 intact, H1 not widened.
- **test-engineer:** 0 FAIL.
  - jest: 229 suites / 2637 tests. typecheck and typecheck:test pass. `test:db` 87/87. Smoke: all arms pass, 1 SKIP. Playwright `add-user.spec.ts`: 4 passed.
  - The tester added tests: a `CascadePreviewModal` render test, a desktop delete-confirm test, and smoke arm 20 for `send-welcome-email`.
  - Acceptance criteria: A-G, I and J pass, with two exceptions that are PARTIAL:
    - H1 (end-to-end username sign-in): local runs have no `USERNAME_RESOLVE_SERVICE_TOKEN`, so smoke arm 12's resolve step SKIPs.
    - J5 (browser check of username sign-in and the Brands tab).
  - K (rollout) is not yet performed.
  - **Condition:** the prod `zz_probe165` username sign-in probe is mandatory, not optional.
  - Non-blocking gaps:
    - no test of the super_admin allow path
    - the GoTrue weak-password mapping is not exercised
    - the cron skip is proven only by parity
    - there is no cross-brand `set_password` arm
    - one unreproduced smoke preflight flake after a Playwright run
- **backend-architect (post-impl):** 0 Critical, 3 Should-fix, 11 Minor. No contract drift. The §4.6 strings, §7 signatures, §3.2 five-copy parity, §4.4 order, §6 skips and §7 clearing all match.
  - S1: AC H is not proven end to end. Run arm 12 with the token set, or treat the prod probe as a blocking gate.
  - **S2: steps 8-9 of `handleCreate` are not inside a `try`. A thrown exception reaches the top-level `catch` (`index.ts:448`) and returns 500 without calling `compensate(newId)`.** If the profile insert had already succeeded, this leaves a username-holding `role='user'` account with no stores. I confirmed this in the source.
  - S3: carry the §6(b) recovery-mail finding into the rollout decision.
  - Minors worth acting on:
    - M2(a): also exclude `user_already_exists` from the weak-password class.
    - M7: the UI SET PASSWORD gate should add `&& user.role === 'user'`.
    - M8: owner question, plain `admin` has no UI entry point.
    - M9: stale "ONLY" docblock in `usernameValidation.ts`.
  - The remaining minors are accepted deviations or are optional.

## Recommended next steps (ordered)

### (a) Code fixes to make before the commit (ordered by severity, then dependency)

1. **Wrap `handleCreate` steps 8-9 so a throw still compensates.** Severity: should-fix, but it is the only item that touches an acceptance criterion (AC A, "no partial state left behind").
   - File: `supabase/functions/manage-store-user/index.ts:310-343`.
   - Put the profile insert and the `user_stores` insert in a `try { … } catch { await compensate(service, newId); return json(500, { error: "could not create account" }); }`. Keep the existing returned-error branches as they are.
   - Optionally, fold in code-reviewer's nit at `:198,205`: log `e?.code` inside `compensate`'s swallowed catches, so an incomplete cleanup can be diagnosed. Never log the body.
   - It goes first because it is the only server-side correctness gap, and the smoke re-run in item 5 must cover it.
2. **Replace the hard-coded English `'username sign-in'` marker with `T('section.users.phone.usernameSignIn')`.** Severity: should-fix. It is a user-visible i18n regression: an es/zh-CN admin sees the localized marker on phone and English on desktop for the same account.
   - Sites: `src/screens/cmd/sections/UsersSection.tsx:442`, `src/screens/cmd/sections/BrandsSection.tsx:979` and `:1066`, `src/components/cmd/CascadePreviewModal.tsx:340`.
   - The key already exists in en/es/zh-CN.
   - While editing, switch `CascadePreviewModal.tsx:340` to `isUsernameLogin(p)`. Optionally add the `userIdentityLine(u, markerText)` helper to `src/utils/userIdentity.ts`.
   - Dependency: if the owner narrows the Brands confirm text (item (b)1), make that change in the same pass, because it touches the same lines at `:1062-1073`.
   - Existing jest assertions that pin the English literal will need the mocked `T` value. Update them; do not delete them.
3. **Register `scripts/smoke-store-user.sh` in `test:smoke`.** Severity: should-fix, a test-track convention item. It does not gate CI, because nothing in `.github/` calls `test:smoke`.
   - Append `&& bash scripts/smoke-store-user.sh` to `package.json:18`.
   - Update the "runs all three" line and the script list in `tests/README.md:36,403-412`.
4. **Small server/UI hardening.** Severity: low or minor. Do these now only because they are one-liners in files that are already being edited. Defer any that adds churn.
   - Security L3: in `set_password`, refuse when `authUser.user.app_metadata?.role` is set and is not `'user'` (`manage-store-user/index.ts:397-404`).
   - Architect M2(a): exclude `user_already_exists` from `isWeakPasswordError`, next to `email_exists`.
   - Architect M7: add `&& user.role === 'user'` to `showSetPassword` (`UsersSection.tsx:373-380`, `PhoneUsers.tsx:129-135`).
   - Architect M9: reword the stale "ONLY" sentence in `src/lib/usernameValidation.ts:30-33`. Comment only, and keep it outside the parity marker block.
   - Code-reviewer nit: limit plain-Enter submit in `SetStoreUserPasswordModal.tsx:69` to when the password input has focus.
5. **Re-verify, then hand to the user for the commit.** Run all of these:
   - full `npx jest`
   - `npm run typecheck` and `npm run typecheck:test` (typecheck:test is a CI gate that jest misses)
   - `bash scripts/smoke-store-user.sh` against the local stack. Check the edge-runtime mount first.
   - `deno check supabase/functions/manage-store-user/index.ts` on a machine with Deno. If it can't be run, record that fact in the commit or PR notes (code-reviewer flag 3).
   - Optionally, close architect S1 locally: set `USERNAME_RESOLVE_SERVICE_TOKEN` on the local edge runtime and `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN` in the bundle, then re-run arm 12 so it passes rather than SKIPs. If this is skipped, the prod probe in (d) step 6 stays blocking (it is blocking either way).

Not required before the commit (should-fix or nit, deferred). These can be a later cleanup or bundled now if the developer prefers:
- extract a shared `PasswordField` for the two new sheets
- `resolveLoginIdentity()` dedup across the three mappers, plus an explicit `: User` on the map callbacks
- rename the parity test file
- the `storeUserErrorText` header note
- the duplicate username on the phone detail
- the "Arm 8b" ordering in the smoke header
- an `afterEach` cleanup in `e2e/add-user.spec.ts`

### (b) Owner decisions (needed before commit or deploy; reviewers are advisory)

1. **Brands delete-confirm text for email accounts** (code-reviewer should-fix, flag 1).
   - `BrandsSection.tsx:1062-1073` now asks the admin to type the **email** for real-email accounts. Before this change it asked for the **name**.
   - Design §7 prescribed `userConfirmText` everywhere, so this is design-compliant. AC D only required a change for placeholder accounts.
   - `BrandsSection.members.spec165.test.tsx:130-134` pins the new behaviour.
   - Choose one, **before the commit**:
     - (i) keep email-first. It now matches Users & access, and this proposal records the change.
     - (ii) narrow it, so `userConfirmText` is used only when `isUsernameLogin(target)` and email accounts keep the old name text. That is a one-line change plus a test update, done in step (a)2.
2. **Prod Supabase dashboard checks, before the function deploy** (architect S3 / design §6(a); security L1, M1, L5):
   - **Auth → Emails → security notifications.** "Password changed" and "Email changed" must be **off**. If they are on, every admin `set_password` makes GoTrue mail a `.invalid` address and bounce. **Hard gate:** do not deploy `manage-store-user` until this is confirmed.
   - **Which SMTP provider prod GoTrue uses.** If it is the same Resend account used for PO, invite and order-failure mail, the public `/recover` bounce path (security M1) threatens real delivery. Then queue the Send-Email hook spec (c)1 next, ahead of the backlog. The owner also decides whether to ship spec 165 before that hook exists. Reviewers rated it Medium and non-blocking.
   - **Password policy.** Check prod's GoTrue `minimum_password_length`, `password_requirements` and leaked-password protection. The function floor is 8. Decide whether to raise it, for example to 10, or to add a common-password deny-list. Admin-chosen passwords are read aloud, never force-changed, and paired with guessable usernames that `username-resolve` exposes. If prod's policy is stricter than 8, the untested GoTrue weak-password mapping (test-engineer gap) becomes live behaviour. The prod probe should use a password that satisfies it.
3. **Should plain `admin` reach Users & access?** (architect M8; security L4 context.)
   - `src/lib/cmdSelectors.ts:1325-1337` (spec 030) shows the section only to master and super_admin. The server, following AC A and the CLAUDE.md `ADMIN_ROLES` convention, admits plain `admin` as well. So a non-master store manager like the "Towson store manager" in the spec scenario has no button, but could still curl the function.
   - This is pre-existing and identical to the invite flow, so it does not block this release.
   - Options:
     - (i) leave it as is
     - (ii) open the section to `admin` in a follow-up spec
     - (iii) narrow the server to master/super_admin, which would need an explicit exception to the ADMIN_ROLES convention
   - Recommendation: (i) for this release, and record the choice.

### (c) Follow-up specs (out of this release; file them)

1. **GoTrue Send-Email hook that drops `.invalid` recipients.** Security M1 / architect S3 / design §6(b). Local GoTrue already sends a "Reset your password" mail to a placeholder address on public `/recover`. This is the only remaining way a placeholder account receives GoTrue mail. Priority depends on (b)2. If prod shares the Resend account, it is next in the queue.
2. **Audit trail for `set_password` (and `create`).** Security L4. This is the first path where one user sets another user's password. A brand admin can set it, sign in as the store user, and submit EOD counts under that user's name, and nothing records it. Write an `audit_events` row (or at minimum a structured log line with caller id, target id and action, never the password) on each success.
3. **`delete-user` case-insensitive self-guard parity.** Security L7. `supabase/functions/delete-user/index.ts:168` compares `userId === gate.userId` case-sensitively, so an uppercase self-UUID gets past `'cannot delete self'`. `manage-store-user` already has the fix at `:360-364`, and smoke arm 13 tests it. This is a one-line parity fix plus a smoke arm. It is pre-existing and does not gate spec 165, but under the CLAUDE.md self-guard rule it should not wait long.
4. Smaller test-coverage follow-ups, lower priority:
   - a forced profile-insert race arm for the 23505 → 409 path (architect M10)
   - a brand-B `user` fixture so a cross-brand `set_password` arm exists (test-engineer)
   - super_admin allow-path coverage once a local super_admin fixture exists
   - extend the `no-email.invalid` lint scan to `supabase/functions/**` (architect M5)
   - investigate the smoke preflight flake seen after a Playwright run

### (d) Prod rollout steps (project `ebwnovzzkwhsdxkpyjka`; none performed yet)

0. Preconditions: (a)1-3 and (a)5 are done, and the owner has decided (b)1 and signed off the security-notification check in (b)2.
1. **The user commits.** Main Claude does not auto-commit.
2. Deploy the updated email functions first: `supabase functions deploy eod-reminder-cron weekly-reminder-cron send-welcome-email`.
3. Deploy the new function: `supabase functions deploy manage-store-user`. Confirm on prod that it runs with `verify_jwt = true`, per the `supabase/config.toml` pin. A no-bearer request should return 401.
   - Functions must land **before** the web push. Otherwise "+ ADD USER" returns HTTP 404.
   - No migration and no MCP apply are needed. The §5.4 contingency was not built.
4. Push `main`. Vercel deploys the web build.
5. **CI gate check (mandatory).**
   - `gh run list --branch main --workflow test.yml --limit 1` and `gh run list --branch main --workflow db-migrations-applied.yml --limit 1` must both be green.
   - Check `e2e.yml` manually (project memory: not yet promoted to the gate checklist).
   - If any run is red or in progress, surface the run URL and stop.
6. **Mandatory prod probe `zz_probe165`.** This is the first real end-to-end username sign-in (test-engineer condition, architect S1). It is a ship gate, not optional. Steps:
   1. As a master or super_admin on Users & access, open **+ ADD USER**. Create display name `zz probe 165`, username `zz_probe165`, a password that meets the prod policy, and one store.
   2. Confirm the row shows `@zz_probe165`, the "username sign-in" marker, SET PASSWORD, and no RESET PW. No `.invalid` address may appear anywhere: Users desktop, the phone detail, and the Brands members tab if a super_admin is available.
   3. On the login portal, sign in with username `zz_probe165` and the password. Confirm it lands in the **StaffStack** EOD app and shows exactly the one store.
   4. Recommended: as the admin, SET PASSWORD. Confirm the old password is refused and the new one is accepted. Also confirm no bounce or "password changed" mail appears in the SMTP provider logs.
   5. Delete the account with the existing DELETE, typing the username. Confirm that 0 `auth.users`, `profiles` and `user_stores` rows remain.
   - **If create fails:** the function creates nothing on failure (§4.4), so the probe is safe. Architect M2(b): a prod rejection of `.invalid` may show as a 400 "Unable to validate email address…" rather than a 500.
   - **If any step fails:** stop, surface it to the user, and do not announce the feature. The change is additive, so existing invite, reset and delete flows are unaffected.
7. Native: picked up in the next EAS build. No separate action is needed for this release.

## Out of scope for this review
- Send-Email hook for `.invalid` recovery mail. Follow-up (c)1.
- Audit trail for `set_password` / `create`. Follow-up (c)2.
- `delete-user` case-insensitive self-guard. Follow-up (c)3; pre-existing.
- Opening Users & access to plain `admin`. Owner decision (b)3; a separate spec if wanted.
- H1 (`user_stores` own-row self-grant for NULL-brand profiles). Still the next security spec. Spec 165 does not widen it, and within-brand self-grant is pre-existing (security auditor confirmed).
- Access tokens staying valid for up to 1 hour after `set_password` (security L2). Inherent to the `jwt_expiry` design. Accepted, and stated in the UI copy.
- Spec 163's name-match email inference when `get_profile_emails` fails (architect design risk 5). Pre-existing and not regressed.
- `AddStoreUserDrawer` copying `Field`, `inputStyle` and the store multi-select from `InviteUserDrawer` (code-reviewer out-of-scope nit). Extract these when a third sheet needs them. The spec required the invite drawer to stay untouched.
- Spec-listed non-goals: attaching an email later, forced first-login change, editing username or stores, bulk creation, and the `app.json` slug.

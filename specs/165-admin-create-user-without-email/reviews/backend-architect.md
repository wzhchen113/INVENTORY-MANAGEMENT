# Spec 165: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-10-18
Baseline: the `## Backend design` section of `specs/165-admin-create-user-without-email.md` (§0-§12)
Scope: the staged files listed under `## Files changed`. I read them from the working tree because this agent has no shell, so I could not run `git diff --cached`. Every staged backend and data-layer file was read in full or at the relevant slice.

## Verdict

**0 Critical, 3 Should-fix, 11 Minor.** No contract drift that blocks ship.

The implementation matches the design on every point I was asked to check:
- the §4.6 error strings
- the §7 wrapper signatures
- the §3.2 predicate and its five-copy parity
- the §4.4 rollback order
- the §6 email skips
- the §7 data-layer clearing, including the invitation-fallback skip

All five reported deviations are accepted (details under Minor). The Should-fix items are about verification and a gap in the rollback. None is a contract mismatch.

## Contract conformance (checked, no drift)

| Area | Design ref | Result |
|---|---|---|
| Single function, `action` dispatch, 405/`OPTIONS`, CORS verbatim | D1, §4 | `manage-store-user/index.ts:34-38, 422-452`. Matches `delete-user/index.ts:8-12` |
| `verify_jwt = true` pin + comment block | §4 | `supabase/config.toml:489-499` |
| `ADMIN_ROLES` + `requireAdminCaller` verbatim | §4 | `manage-store-user/index.ts:42, 90-109`. Byte-matches `delete-user/index.ts:28-47` |
| Caller-brand gate wording | §4 | `:119-141`. Missing profile, NULL brand, and super_admin bypass all as designed |
| Allowlisted fields only; role is a literal | §4, §4.2.8 | `:218-221, 314`. Smoke arm 10 proves it |
| Create steps 1-10, 201 `{id, username}` | §4.2 | `:223-346`. Every string matches §4.6. Username pre-check uses the `username-resolve` escape idiom (`:259`) |
| Set-password steps 1-7, 200 `{success:true}` | §4.3 | `:351-418`. Missing target is refused (the deliberate difference from `requireSameBrandOrSuperAdmin`) |
| Password rule, verbatim, min 8, GoTrue 400 passthrough + scrub | §4.1 | `:145-170` |
| Rollback order | §4.4 | `compensate()` `:193-209`: `deleteUser` with one retry, then `user_stores` delete, then `profiles` delete, then id-only `console.error`. It runs before the error is mapped, at `:322` and `:336` |
| Log hygiene, top-level catch returns `internal error` | §4.5 | Logs carry only `code`/`status`; `e.message` is never returned (`:448-451`) |
| §4.6 error table | §4.6 | All strings present and byte-identical. The extra 500 `internal error` from a caller-brand read failure (`:136`) falls inside the 500 row |
| Predicate, five byte-identical copies, `export` outside the block | §3.2 | Canonical `src/lib/placeholderEmail.ts:25-32`. Copies at `manage-store-user:70-75`, `eod-reminder-cron:22-27`, `weekly-reminder-cron:35-40`, `send-welcome-email:20-25`. Parity jest `src/lib/placeholderEmail.parity.test.ts:34-61` |
| Reserved-usernames mirror | §3.4 / D4 | `usernameValidation.ts:41-53` and `manage-store-user:53-65`. Parity plus a "markers wrap the whole literal" check (`parity.test.ts:72-79`) |
| Cron skips | §6 | `lookupEmail` caches and returns `null` for placeholders (`eod-reminder-cron:195-198`, `weekly-reminder-cron:203-206`). `deliverReminder` then makes no Resend call and leaves `emailed=false`. Both crons have only this one Resend call site |
| `send-welcome-email` skip | §6 | `:83-87`, after the gate and before Resend, returning `{success:true, skipped:"placeholder"}` |
| Audit of the other email senders | §6 | No changes to `send-po-email`, `send-order-failure-email`, or `send-invite-email`, as designed |
| Wrappers | §7 | `src/lib/auth.ts:693-734`. `STORE_USER_PASSWORD_MIN_LENGTH`, `CreateStoreUserInput`, `createStoreUser`, and `setStoreUserPassword` have the exact §7 signatures, go through `callEdgeFunction`, and do no logging |
| `fetchAllUsers` clearing + `loginKind` + fallback skip | §7 | `src/lib/auth.ts:651-663` |
| `fetchBrandAdmins` active rows / pending rows / `activeEmails` | §7 | `src/lib/db.ts:5522-5533`, `:5577`, `:5562` (`''` filtered) |
| `mapCascadePreview` (+ `fetchBrandDeletionLog` through the same mapper) | §7 | `src/lib/db.ts:5272-5282`, `:5382` |
| `fetchProfileEmails` unchanged | §7 | `src/lib/db.ts:247-262` untouched |
| No migration, no SQL, no pgTAP, no publication change | D3, §1, §9 | Confirmed. The `db-migrations-applied` gate and the realtime restart step are not engaged |
| No bypass of `db.ts`/`auth.ts` | CLAUDE.md | `AddStoreUserDrawer.tsx` and `SetStoreUserPasswordModal.tsx` make no `supabase.*` or `fetch(` calls. Screens read `loginKind` through `src/utils/userIdentity.ts`, never the email shape |
| §5.3 UI copy | §5.3 | `SetStoreUserPasswordModal.tsx:187`, exact |

## Should-fix

### S1. AC H (sign in by username) is not proven end-to-end anywhere
- **Where:** `scripts/smoke-store-user.sh:319-333` (arm 12 SKIPs the `username-resolve` step and falls back to the email read from `auth.users`). `e2e/add-user.spec.ts` deliberately skips username sign-in. The browser check signed in with the auth email.
- **Design ref:** §3.3 ("the smoke happy path re-proves this on every run"), §10 arm 12, spec §J/§H.
- **Why it matters:** this is the only check that proves a placeholder account round-trips through `username-resolve` → `signInWithPassword`, and that is the feature's main user story. The code path is structurally unchanged: `username-resolve/index.ts:150-155` returns `userData.user.email` verbatim, and `signIn` (`src/lib/auth.ts:131-148`) passes any non-null string through. So the risk is low, but it is untested.
- **Fix:** set `USERNAME_RESOLVE_SERVICE_TOKEN` (and the matching client bundle token) for the local edge runtime and re-run arm 12 so it passes rather than SKIPs before ship. If that isn't done, rollout step K(5), the prod `zz_probe165` username sign-in, must be recorded as a blocking gate in the release proposal, not optional.

### S2. Unhandled throws between `createUser` and `user_stores` skip compensation
- **Where:** `supabase/functions/manage-store-user/index.ts:308-343`. Steps 8-9 handle *returned* errors but are not wrapped in `try`. A *thrown* exception after `newId` exists (a runtime error, or an unexpected throw from the client library) goes to the top-level `catch` (`:448`). That catch returns 500 `internal error` **without calling `compensate(newId)`**.
- **Design ref:** §4.4 ("Any failure at 8 or 9 runs `compensate(newId)`") and spec AC A ("no partial state left behind").
- **Impact:** a throw after a successful profile insert leaves a signable `role='user'` account with no stores that holds the username. postgrest-js normally returns fetch failures as `{ error }` rather than throwing, so the likelihood is low, but the fix is cheap.
- **Fix:** wrap steps 8-9 in `try { … } catch { await compensate(service, newId); return json(500, { error: "could not create account" }) }`.

### S3. The §6(b) finding must be carried into the rollout decision
- **Where:** backend verification note in the spec (`## Files changed` → "§6(b) public recovery"). Local GoTrue **does** send a recovery mail to a placeholder address when anyone posts `/auth/v1/recover`.
- **Design ref:** §6(b) said to file a follow-up spec for a GoTrue Send-Email hook. That is not drift, because the design scoped it out.
- **Why it matters:** an unauthenticated caller can get the placeholder from `username-resolve` (bundle token, 20/min/IP) and trigger recovery. On prod's SMTP that is a guaranteed hard bounce to `.invalid`, which hurts sender reputation. Rollout check §6(a) (GoTrue "password changed" security notifications must be off) is related: if those are on, every admin set-password bounces too.
- **Fix (process, not code):** file the Send-Email-hook follow-up spec before prod deploy. Make §6(a) an explicit owner sign-off item in the release proposal. The owner decides whether to ship before the hook exists.

## Minor

### M1. Accepted deviation: `set_password` lowercases `userId` before the self-guard
`manage-store-user/index.ts:360-366`. This is strictly stronger than §4.3 step 2: it closes a case-variant bypass, because Postgres `uuid` comparison ignores case and JS `===` does not. Smoke covers it with an uppercased-UUID arm (`smoke-store-user.sh:344-345`). No action.

### M2. Accepted deviation: `email_exists` is kept out of the weak-password 422 class
`:157-161`. This aligns with §3.1, which says a placeholder collision maps to 500 with nothing created. Without the exclusion, §4.1's blanket "HTTP 422" rule would have shown GoTrue's "already registered" text as a 400. Two notes:
- (a) Also exclude `user_already_exists`, which some GoTrue versions use for the same case at 422.
- (b) This one is my design's imprecision, not the developer's. `validation_failed` also covers a GoTrue email-format rejection ("Unable to validate email address…", 400). If prod GoTrue ever rejected `.invalid`, the admin would see that message as a 400 rather than a 500. Nothing is created and the message doesn't contain the address, so it is harmless. Keep it in mind when reading the result of the prod probe.

### M3. Accepted deviation: caller-brand checks run before store checks
`:266` precedes `:267-286`. This is better than §4.2 step 5's order: an admin with no brand scope or no profile row learns nothing about whether store ids exist. The cross-brand 403 still precedes the 409 `username taken`, so the collision is only revealed to an in-brand caller with valid stores. That is the intended spec 095 posture. No action.

### M4. Set-password error strings show whether a target exists
`:390-394`. A missing target returns `forbidden: target is not a store user`, while an existing profile in another brand returns `forbidden: target is in a different brand`. A same-role admin can therefore tell "this UUID exists in another brand" from "this UUID doesn't exist". UUIDs are not guessable, both responses are 403, and `delete-user` has the same shape, so this is accepted. The design (§4.3 step 4) allowed this ordering.

### M5. Accepted deviation: the parity test also forbids `no-email.invalid` elsewhere in `src/`
`parity.test.ts:82-104`. It goes beyond §3.2 and is welcome. Two gaps:
- it scans only `src/**`, so a sixth hand-rolled check in a future edge function would not be caught
- it does not cover a bare `.invalid` check (§3.2 named both)

Optional: extend the scan to `supabase/functions/**` with a per-file allowance for the generator and scrub lines in `manage-store-user`.

### M6. The `no-email.invalid` literal appears outside the predicate block in `manage-store-user`
`:168` (`safeAuthMessage` scrub) and `:175` (generator). Both are sanctioned by §4.1 and §3.1. The scrub is a disclosure guard, not an "is this a username account" decision. No action. This is recorded so a future reviewer doesn't treat it as a §3.2 violation.

### M7. The UI SET PASSWORD gate admits non-`user` targets for master callers
`UsersSection.tsx:373-380` and `PhoneUsers.tsx:129-135`: `showSetPassword = canResetPassword && usernameLogin`. For masters, `canResetPassword` admits `admin` rows. This feature only creates `role='user'` placeholder accounts, so this is reachable only through the §11.4 self-converted-email case, and the server refuses it with 403 (`:394`). Spec §G describes the gate as "target is `role='user'`". Suggest `&& user.role === 'user'` on both tiers for parity with the server.

### M8. Open question for PM/owner: plain `admin` has no UI entry point
`src/lib/cmdSelectors.ts:1325-1337` (spec 030) shows Users & access only to master and super_admin. The server correctly admits all of `ADMIN_ROLES` (spec AC A), but a plain `admin`, like the "Towson store manager" in the spec scenario if she is not a master, cannot reach + ADD USER. This is pre-existing and identical to the invite flow; my design missed it. No code change is implied. Surface it to the owner.

### M9. Stale docblock in `usernameValidation.ts`
`usernameValidation.ts:30-33` still says the reserved list is "enforced ONLY in the admin assignment UI, never in the resolver or backfill". It is now also enforced in `manage-store-user`. The added paragraph at `:35-38` explains this, but the "ONLY" sentence should be reworded. Comment only.

### M10. Arm 11 does not prove compensation; arm C does
My §10 claimed arm 11 proves compensation. It doesn't: the 409 comes from the pre-check, before `createUser`. The developer's arm C (`smoke-store-user.sh:293-316`, a temporary failure trigger on `user_stores`, dropped in the EXIT trap) is the real proof, and it corrects the design.

Remaining gap: the profile-insert race path (`:324-326`, 23505 on `profiles_username_lower_key` → 409) is not exercised by any arm. A second trigger arm could force it. Low priority.

### M11. Accepted deviation: S-REV passed, so the §5.4 contingency was not built
S-REV passed with two live sessions, both refresh tokens returning 400, and `auth.sessions` at 0 (`smoke-store-user.sh:373-385`). That satisfies D5 as designed. Confirmed:
- no `20261018000000_revoke_user_sessions.sql`
- no pgTAP suite
- `db-migrations-applied` unaffected

The §5.3 limit, that a live access token stays valid up to `jwt_expiry`, is reflected in the UI copy exactly.

Two small client additions, both accepted:
- `createStoreUser` returns `'Unexpected response from server'` on a malformed 2xx (`auth.ts:718`). This is client-only and not part of the §4.6 server table.
- `storeUserErrorText` lives in `src/utils/userIdentity.ts:32-40` instead of being duplicated in the drawer and the modal. That still meets §7's rule that the mapping sits outside the wrapper, and it removes a drift surface.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 14 findings: 0 Critical, 3 Should-fix, 11 Minor.
payload_paths:
  - specs/165-admin-create-user-without-email/reviews/backend-architect.md

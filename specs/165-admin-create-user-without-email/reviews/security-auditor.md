## Security audit for spec 165

Scope: staged diff (`git diff --cached`), centred on the new `supabase/functions/manage-store-user/index.ts` (service-role, `verify_jwt = true`). Also covered: the placeholder skips in `eod-reminder-cron`, `weekly-reminder-cron` and `send-welcome-email`; the data-layer clearing in `src/lib/auth.ts` and `src/lib/db.ts`; the two new UI components; `supabase/config.toml`; the smoke script and the e2e test. The diff has no migration, no `supabase/tests/*.sql` and no `package.json` change.

Verdict: **0 Critical, 0 High, 1 Medium, 7 Low.** Nothing blocks merge. Before deploy, the owner still has to do the two dashboard checks in L1 and M1.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- `supabase/functions/username-resolve/index.ts:150-155` together with GoTrue `POST /auth/v1/recover` (known finding (a)). Anyone holding the public bundle token can resolve a guessable username (for example `marcus.l`) to its placeholder address, at 20 requests/min/IP. The limiter fails open on an RPC error (`username-resolve/index.ts:110`). With only the anon key, they can then make GoTrue send a recovery mail to `u-…@no-email.invalid`. The backend-developer confirmed that local GoTrue sends it (spec §Files changed, "§6(b) public recovery").
  - **Impact:** this is not an account takeover, because the recovery link goes to an undeliverable address and nobody can read it. It is a sender-reputation and quota attack:
    - every send is a guaranteed hard bounce on the prod SMTP provider
    - every send uses up GoTrue's project-wide `email_sent` budget, which is shared with real invites and password resets
    - if prod GoTrue relays through the same provider as Resend, sustained bounces put PO, invite and order-failure delivery at risk
  - **Why only Medium:** an attacker could already burn `email_sent` with any known real address. What's new is the guaranteed bounce.
  - **Fix:** file the follow-up spec for a GoTrue Send-Email hook that drops `.invalid` recipients, as the design calls for. Before deploy, the owner confirms which SMTP prod GoTrue uses. If it is the shared Resend account, put the hook spec next in the queue rather than in the backlog.

### Low
- **L1. GoTrue "password changed" notification (known finding (b)).** `supabase/functions/manage-store-user/index.ts:408`. If prod has the "Password changed" security notification on, every admin `set_password` makes GoTrue mail the placeholder address and bounce. Only an admin can trigger this, so it isn't attacker-amplifiable. It stays a hard pre-deploy owner check (spec §6(a), rollout step K(1)). Locally it is off (`supabase/config.toml:268` is commented out).
- **L2. Access tokens outlive a set_password (known finding (c)).** `supabase/functions/manage-store-user/index.ts:406-408`, `supabase/config.toml:171` (`jwt_expiry = 3600`). Smoke S-REV proved that refresh tokens and `auth.sessions` are revoked. An access token that was already issued keeps working against PostgREST for up to 1 hour, so a lost or shared device keeps working until its next refresh. This can't be fixed in this design, and the UI says so (§5.3 copy in `SetStoreUserPasswordModal.tsx`). Accepted.
- **L3. set_password checks only `profiles.role`, not the target's auth `app_metadata.role`.** `supabase/functions/manage-store-user/index.ts:394` and `:397-404`. `authUser.user` has already been fetched at `:397`, so also refusing when `authUser.user.app_metadata?.role` is set and is not `'user'` costs nothing. Today this is unreachable:
  - non-super_admins cannot change `role` (the trigger in `20260517050000_rls_hardening_followups.sql`)
  - placeholder accounts are created as `'user'`
  
  It does close a profile/JWT role desync, where `requireAdminCaller` (`:98-99`) would trust the JWT role on an account whose password a brand admin had just set. Defense in depth only.
- **L4. Neither action leaves an audit record.** `supabase/functions/manage-store-user/index.ts:346`, `:417`. This is the first path that lets one user set another user's password. Any brand admin, not only masters (the UI is master-gated, the server allows `admin`), can set a store user's password, sign in as them, and submit EOD counts under their name. Nothing records that the password was changed, or by whom. That isn't privilege escalation, because the admin already outranks the target, but it makes impersonation undetectable. Suggestion: write an `audit_events` row (or a `console.log` of caller id, target id and action, never the password) on each successful create and set_password.
- **L5. Weak password floor on an exposed, guessable-identifier login.** The rule is `supabase/functions/manage-store-user/index.ts:44,145-150`; local `minimum_password_length = 6` and `password_requirements = ""` are at `supabase/config.toml:188,191`.
  - Store-user passwords are chosen by an admin, read aloud, and never force-changed. Their usernames are short and guessable, and `username-resolve` lets anyone holding the bundle token resolve them.
  - The only brute-force brake is GoTrue's per-IP `sign_in_sign_ups` limit (`supabase/config.toml:213`).
  - Suggestion: confirm prod's GoTrue `password_requirements` and leaked-password protection, and consider a 10-character floor or a deny-list of common passwords in the drawer. Policy call for the owner.
- **L6. A brand-gate error reveals whether a target id exists in another brand.** `supabase/functions/manage-store-user/index.ts:390-394`. An admin/master can tell "exists in another brand" (`forbidden: target is in a different brand`) from "doesn't exist, or isn't a store user" (`forbidden: target is not a store user`). Exploiting it needs foreign profile UUIDs, which admins can't list, and `delete-user` behaves the same way. Negligible. If you want, return the same 403 string for both.
- **L7. Pre-existing, outside this diff: `delete-user`'s self-guard can be bypassed with case.** `supabase/functions/delete-user/index.ts:168`. The check is `userId === gate.userId`, a case-sensitive JS comparison. Postgres `uuid` and GoTrue both accept an uppercase UUID, so a hand-written request with the caller's own id in uppercase gets past `'cannot delete self'`. It then reaches the brand and last-of-role gates and the delete. The UI always sends lowercase, so this is only reachable on purpose, which is why it is rated Low here rather than High under the self-guard rule. `manage-store-user` has the fix (`:360,364`) and smoke arm 13 tests the uppercase form (`scripts/smoke-store-user.sh:344-345`). File a one-line parity follow-up for `delete-user`. It does not gate spec 165.

### Verified (no finding)
- **ADMIN_ROLES parity.** `manage-store-user/index.ts:42` is `new Set(["admin", "master", "super_admin"])`. `requireAdminCaller` (`:90-109`) is a verbatim copy of `delete-user/index.ts:28-47`: `getUser()` reads app_metadata fresh from GoTrue, with a fallback to `profiles.role` through the caller's JWT. Since spec 041/042, self-edits to `profiles.role` are blocked, so the fallback can't be self-promoted. `verify_jwt = true` is pinned at `supabase/config.toml:498-499`. An anon-key bearer passes the gateway but fails `getUser()`, which returns 401.
- **Brand and store scoping.**
  - `readCallerBrand` (`:119-141`) refuses admin/master callers with a missing profile or a NULL brand, using delete-user's wording.
  - On create, the brand is derived only from the service-role `stores` read (`:276-282`): every id must exist, all must share exactly one non-NULL brand, and it must equal the caller's brand unless the caller is super_admin (`:283-285`).
  - `user_stores_brand_match_trg` backstops a brand change mid-flight, mapped at `:337-339` with compensation.
  - On set_password, a missing target profile is refused, not passed through (`:390`, a deliberate tightening over delete-user). Cross-brand returns 403 (`:391-393`).
  - super_admin (`brandId: null`) may target any brand, which is intended.
- **No client-chosen role, brand, email or id.** Only `name`, `username`, `password` and `storeIds` are read (`:218-221`). `role: "user"` is a literal (`:314`), `brand_id` is derived (`:315`), the email is generated server-side from `crypto.randomUUID()` and self-checked (`:174-176,289-290`), and `createUser` gets no `id` and no `app_metadata` (`:295-300`). `user_metadata` carries only `name`; no RLS policy reads `user_metadata` (grepped migrations).
- **Self-guard.** `:360-366` lowercases and trims both sides before comparing, before the password check and before any read or write. The uppercase bypass is closed. The refusal string `'cannot set password for self'` follows the convention, and the response is HTTP 400.
- **set_password target rules.** All checks run before the single side effect at `:408`:
  - the profile must exist
  - same brand, unless super_admin
  - `role === 'user'` (`:394`), so admin, master and super_admin are out of reach
  - the auth email must pass the strict placeholder predicate (`:402-404`), so real-email accounts are refused. The predicate fails closed: any other `.invalid` shape doesn't count.
  
  Self-converting a real-email account to a placeholder (design risk 4) is blocked locally by `double_confirm_changes = true` (`config.toml:230`), because the new address can never confirm. It is self-inflicted in any case.
- **Rollback.** `compensate()` (`:193-209`) runs on both post-create failures (`:321-322`, `:335-336`). It calls `auth.admin.deleteUser` (which cascades to profiles and `user_stores`) with one retry, then falls back to deleting the public rows directly. It logs only the orphan id and never returns it. The residual auth-only orphan is inert: its random email was never returned, without a profile `username-resolve` can't find it, and spec 164 stops it from creating a profile. The weak-password and other `createUser` failures (`:301-307`) happen before anything is created.
- **Passwords and placeholder never logged or returned.**
  - Every `console.error` logs only `error.code` / `error.status`, or the orphan id (`:135,208,268,272,305,327,341,384,399,413`).
  - The top-level catch returns a generic `internal error` without `e.message` (`:448-450`).
  - GoTrue messages pass through only for the weak-password class, and are scrubbed of the placeholder (`:165-170`).
  - Responses are `{ id, username }` and `{ success: true }`.
  - Client side: the wrappers (`src/lib/auth.ts`) don't log, `callEdgeFunction` doesn't log the body, toasts carry only the username or the server error string, and the password lives only in component `useState`, cleared on success and close (`AddStoreUserDrawer.tsx:126-127`, `SetStoreUserPasswordModal.tsx:57`). Nothing goes to Zustand or storage.
  - `src/lib/auth.storeUser.test.ts` checks the console and toast spies, and smoke arm 18 greps the response bodies.
- **Placeholder display and exposure.**
  - The data layer clears the placeholder in `fetchAllUsers`, `fetchBrandAdmins` and `mapCascadePreview`, and skips invitation name-match inference for those rows, which closes the "RESET PW to a stranger's inbox" path.
  - RESET PW is hidden and `handleSendReset` returns early for username accounts.
  - Only `src/lib/placeholderEmail.ts` and `manage-store-user` contain the literal string, and the parity test enforces that.
  - `username-resolve` returning the placeholder is by design (random, no id leak, password still required). Its downstream recover abuse is M1.
- **Outbound email skips.**
  - `eod-reminder-cron/index.ts:197` and `weekly-reminder-cron/index.ts:205` cache `null` for placeholders before any Resend call.
  - `send-welcome-email/index.ts:83-87` skips after its auth and email-match gate.
  - I grepped every Resend-calling function: `send-po-email` (vendor addresses), `send-order-failure-email` (admin/master/super_admin recipients plus ops), and `send-invite-email` (admin-typed address). None can reach a `role='user'` placeholder account, which matches the design §6 audit.
- **Spec 164 hardening intact.** The diff touches no migration. `profiles_insert_role_guard` (`20261007000000_profiles_insert_hardening.sql:96-122`) correctly skips `service_role`, and the function only ever inserts `role='user'`. No client INSERT into `profiles` or `user_stores` was introduced.
- **H1 not widened.** Create refuses an empty store set (`:249`) and NULL-brand stores (`:279`), so it can never mint a NULL-brand profile. Within-brand self-grant through the `user_stores` own-row arm remains the pre-existing spec 164 out-of-scope item. H1 stays the next security spec.
- **Input validation.** The username is limited to `[a-z0-9_.]{3,20}`, so no PostgREST `*` or `,` metacharacters reach `ilike`, and `_` and `\` are escaped (`:259`). `storeIds` are strings, UUID-shaped, at most 100, and deduped. The name is trimmed, required, at most 100 characters, and is rendered only in RN `Text`. All PostgREST and GoTrue calls use bound parameters, with no dynamic SQL. CORS `*` with bearer-only auth and no cookies is not a CSRF concern.
- **Smoke and e2e fixtures.** These use only local default passwords. The service-role key is read at runtime from the local container (`scripts/smoke-store-user.sh:104`), and no prod secrets are committed.

### Dependencies
No `package.json` changes, so `npm audit` was skipped.

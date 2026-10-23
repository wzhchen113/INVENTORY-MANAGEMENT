## Security audit for spec 167

Scope: unstaged working tree (`git diff`), excluding `specs/166-*`. Files reviewed:
`supabase/functions/manage-store-user/index.ts`, `supabase/functions/delete-user/index.ts`,
`scripts/smoke-store-user.sh`, `scripts/smoke-edge-roles.sh`, `src/types/index.ts`,
`src/utils/formatAuditAction.ts`, `src/i18n/{en,es,zh-CN}.json`,
`src/screens/cmd/sections/AuditLogSection.tsx`, `src/screens/cmd/sections/phone/PhoneAuditLog.tsx`,
`src/utils/enumLabels.test.ts`. No migration, no `config.toml` change, no `package.json` change.

Live-stack checks I ran (all read-only): `pg_policies` / `pg_constraint` / `pg_trigger` on
`public.audit_log`; live bodies of `auth_can_see_store()` and `auth_is_admin()`; Postgres casts of
alternate uuid spellings; PostgREST `eq.` filters with hyphenless and braced ids (service-role
GET); and the auth-js `validateUUID` regex in `node_modules`.

### Verified clean (focus items from the dispatch)

- **No secret reaches `audit_log` or logs.** The audit rows are built only from validated store
  ids, `gate.userId`, the GoTrue-issued `newId` or the normalized `userId`, the username, and
  the brand id (`manage-store-user/index.ts:237-252`). The `password` / `pw` / `placeholder`
  locals are never passed to the audit helpers. `USERNAME_RE` (`:47`) rules out `@` and `-`, so a
  username cannot hold the placeholder or its domain. Every new log line (`:261-266`, `:275`,
  `:278-284`, `:298`, `:303-309`) prints only static text, caller id, target id, the action and
  the error `code` or exception class name. It never prints `message`, `details`, the rows, the
  username or the body. Smoke A8/A9 check this.
- **Rows are written only after a successful side effect.** The create audit (`:466-469`) sits
  outside the compensating `try`, and every refusal or compensated `return` (`:328-464`) exits
  before it. The set_password audit (`:550-562`) runs only once `updErr` is falsy. Refused paths
  do no extra I/O. Smoke A7 (exact delta of 7) catches stray rows from any refused arm.
- **Best-effort writes cannot change the response.** `writeStoreUserAudit` and
  `readTargetStoreIds` catch everything, and `buildStoreUserAuditRows` is pure and cannot throw.
  The 3 s `AbortSignal.timeout` caps how long a hung call can delay the response.
  `public.audit_log` has no triggers (checked live), so the insert has no hidden side effects.
  The single bulk insert is atomic.
- **Visibility is store-scoped.** No row with `store_id IS NULL` is ever written. Store ids
  come from validated `ids` or from `user_stores.store_id`, and that column is NOT NULL (checked
  live). Zero stores means no row (`:260-267`). Reads go through
  `store_member_read_audit_log` (`20260809000000_super_admin_policy_parity.sql:176-181`). The
  live `auth_can_see_store()` limits admin/master to their own brand, so a brand-B admin cannot
  see brand-A rows. One exception: store **members** can read these rows too (see M2).
- **delete-user normalization is used everywhere after it.** `userId` is trimmed and lowercased
  once (`delete-user/index.ts:165-168`). The self-guard (`:177`) runs before any read. The same
  value then goes to the brand gate (`:198-203`), the super_admin role lookup (`:231`),
  `assert_not_last_of_role` (`:245`), the three cleanup deletes (`:257-259`) and
  `auth.admin.deleteUser` (`:261`). A non-string, `null` or array body now returns 400
  `userId required` and no longer throws. **The uppercase partial-delete case the developer
  found is closed** for case and surrounding whitespace. It is not closed for other uuid
  spellings (see M1).
- **Smoke safety is good.** `smoke-edge-roles.sh` refuses any non-local `SUPABASE_URL`
  (`:58-65`). Arm 8 uses a disposable same-brand admin, never `admin@local.test`, and runs last.
  Its cleanup sits inside the single `restore_admin` EXIT trap, guarded by `SELFDEL_CREATED`.
  It SKIPs when there is no stack. `smoke-store-user.sh` cleanup is scoped to these two actions
  and `item_ref like 'zz_s165%'`.
- The function stays `verify_jwt = true`. `ADMIN_ROLES` still includes `super_admin`. There is no
  HTML output, so `escapeHtml` does not apply. The frontend changes are display-only, and
  `itemRef` renders in RN `<Text>`, which is not an HTML sink.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

- **M1: the L7 / partial-delete fix covers case only. Other uuid spellings still get past the
  self-guard and still half-delete accounts.** `supabase/functions/delete-user/index.ts:168`
  and `:177`, with side effects at `:257-261`. Postgres and PostgREST accept several spellings
  of the same uuid. I confirmed on the local stack that each of these resolves to the canonical
  id and matches rows through `?id=eq.<value>`:
  - the hyphenless form `a0eebc999c0b4ef8bb6d6bb9bd380a11`
  - the braced form `{a0eebc99-…}`
  - the hyphen-every-4-digits form

  Trimming and lowercasing does not turn them into the canonical string. So:
  - (a) A caller who sends their **own** id in hyphenless form passes
    `userId === gate.userId.toLowerCase()`. For an admin, or a non-last super_admin, the brand
    gate and `assert_not_last_of_role` then pass. The three cleanup deletes remove the caller's
    own `user_stores`, `profiles` and `invitations` rows.
  - (b) For **any** permitted target, the same deletes run. Then `auth.admin.deleteUser`
    throws. auth-js `validateUUID` (`node_modules/@supabase/auth-js/dist/main/lib/helpers.js:318`,
    a lowercase canonical-only regex) runs *outside* `deleteUser`'s try. The outer catch
    (`:273-278`) returns 500.

  This is the same half-delete state the developer found for uppercase ids. `auth.users`
  survives with `raw_app_meta_data.role` intact, because `profiles_sync_role_to_jwt` fires only
  on INSERT/UPDATE, not DELETE. The result is an orphan that does not show in Users & access but
  can still log in and still carries its JWT role. That role is enough for `auth_is_admin()` and
  therefore `auth_is_privileged()`.

  Why this is Medium and not High:
  - It needs a privileged caller to hand-craft a non-canonical id. It is not an operator
    footgun, because the UI always sends canonical ids.
  - A privileged caller can already create the same orphan by sending
    `DELETE /rest/v1/profiles` directly under `Admins can delete profiles`.

  It still means AC-8's purpose, and the "confirm closed" question, is only partly met. **Fix
  (one line, in scope):** after normalization, add
  `if (!UUID_RE.test(userId)) → 400 { error: "userId required" }`, using the same canonical
  regex as `manage-store-user/index.ts:48` / `:487`. Add smoke Arm 8 cases that send the own id
  hyphenless and braced, expect 400, and repeat the profile / auth-user post-checks. The design
  left out UUID_RE (§4.4 "Not changed"). That was a scope choice, not a developer error, but it
  is exactly the gap that keeps this class open.

- **M2: store members (staff, `role='user'`) can read the new rows. That exposes colleagues'
  login usernames and password-reset events.** `manage-store-user/index.ts:248` sets
  `item_ref` to the username. The read policy is
  `20260809000000_super_admin_policy_parity.sql:176-181`. Its arm
  `store_id is not null and auth_can_see_store(store_id)` admits anyone with a `user_stores` row
  for the store (live `auth_can_see_store()` third arm). Staff cannot read other people's
  `profiles` (live policies: own row, super_admin, or privileged+brand only). So
  `GET /rest/v1/audit_log?action=eq.Store user created` with a staff JWT becomes a **new**
  channel for listing every username-only login handle in the store, plus target ids and the
  acting admin's id.

  This works against the anti-enumeration posture the project built for usernames in
  `username-resolve` (spec 095's anti-oracle contract and per-IP limit). Combined with spec 165
  L5 (8-character password floor), it helps a co-worker guess passwords. Not Critical/High: the
  exposure stays inside one store (no cross-brand or customer-PWA reach, since PWA users have no
  `user_stores`), and the Cmd audit UI itself is admin-only.

  **Fix options**, either acceptable:
  - (a) Add a RESTRICTIVE SELECT policy on `audit_log`:
    `using (action not in ('Store user created','Store user password set') or public.auth_is_privileged())`.
    This needs a migration, so it is a follow-up spec if the owner wants this spec to stay
    migration-free.
  - (b) Accept the risk explicitly in the release proposal.

  Note: the existing client-written `'User invite'` rows already show invitee *display names* to
  store members. Usernames are worse because they are login identifiers.

- **M3: deferred `audit_log` integrity gap, rated as requested (not blocking).** Two parts:
  - `admin_update_audit_log` / `admin_delete_audit_log`
    (`20260809000000_super_admin_policy_parity.sql:201-213`) have no store or brand scope. Any
    `auth_is_privileged()` caller can edit or erase a `'Store user password set'` row,
    including the admin who did the reset.
  - `store_member_insert_audit_log` (`:189-194`) lets any store member insert store-scoped rows
    with any `action` and `user_id`. Staff can therefore **forge** look-alike
    `'Store user password set'` rows blaming an admin. Those rows cannot be told apart from
    server-written ones, because the table has no server-only marker column.

  The new trail is server-written but neither tamper-proof nor forgery-proof. That matches the
  spec's Out-of-scope statement. Recommend that the spec 157 FUTURE-1 follow-up covers both:
  append-only or RESTRICTIVE UPDATE/DELETE, and a RESTRICTIVE INSERT that reserves these action
  strings for `service_role`.

### Low

- **L1: a profile-less caller with a `super_admin` JWT can set passwords across brands, and the
  audit write fails without any visible sign.** The paths involved:
  - `manage-store-user/index.ts:98-99`: `requireAdminCaller` trusts JWT `app_metadata.role`
    first.
  - `:124`: `readCallerBrand` returns `brandId: null` for `super_admin` without reading the
    caller's profile.
  - `audit_log_user_id_fkey`: `user_id → profiles(id)`, checked live.

  A super_admin whose `profiles` row was deleted but whose `auth.users` row survived (reachable
  via M1, or via a direct PostgREST `DELETE` on profiles by another super_admin) keeps
  cross-brand create / set_password in this function. Every audit insert for that caller then
  fails with 23503. Best-effort design (AC-4) logs only the code and returns success. That
  defeats L4's goal ("a trace that a hand-crafted request cannot skip") for precisely the caller
  you would most want recorded. It needs a super_admin insider, hence Low.

  **Fix:** `readCallerBrand` should confirm a `profiles` row with `role='super_admin'` exists
  before taking the super_admin short-circuit, matching `auth_is_super_admin()`, which reads
  `profiles`, not the JWT. Otherwise return 403. A follow-up is fine.

- **L2 (pre-existing, already noted by the architect): delete-user returns raw error
  messages.** `supabase/functions/delete-user/index.ts:102`, `:117`, `:235`, `:250`, `:264`,
  `:274` return `error.message` to the client. The `:274` catch also covers a malformed-JSON
  `req.json()` `SyntaxError`, whose text can quote request-body fragments, and (after M1) the
  auth-js `validateUUID` text. This spec does not make it worse. A follow-up should collapse
  these to fixed strings, as `manage-store-user` already does (`:595-597`).

### Dependencies

No `package.json` changes, so `npm audit` was skipped.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 3 Medium, 2 Low.
payload_paths:
  - specs/167-store-user-audit-trail/reviews/security-auditor.md

## Delta re-review (fix pass) — 2026-10-19

Scope: the unstaged `git diff` on top of the staged implementation, excluding `specs/166-*`.
Security-relevant files: `supabase/functions/delete-user/index.ts`,
`supabase/functions/manage-store-user/index.ts` (comment only), `scripts/smoke-store-user.sh`
(new Arm AF), `scripts/smoke-edge-roles.sh` (Arm 8 additions and `sd_psql` exit status). The
frontend changes are display-only. No migration, no `config.toml` change, no `package.json`
change.

### M1: CLOSED

- `delete-user/index.ts:26` `UUID_RE` is byte-identical to `manage-store-user/index.ts:50`. I
  checked this with `diff` on the two declaration lines. It is case-sensitive lowercase with no
  `/i` flag, which is right because it runs on the value after it has been lowercased.
- `delete-user/index.ts:179` `if (!userId || !UUID_RE.test(userId))` returns 400
  `userId required`. It runs right after trim and lowercase (`:175`) and before:
  - the self-guard (`:186`)
  - `createClient` (`:193`)
  - the brand gate (`:206`)
  - the super_admin role lookup
  - `assert_not_last_of_role`
  - the three cleanup deletes
  - `auth.admin.deleteUser`
- Postgres accepts these alternate spellings of a uuid: uppercase, surrounding whitespace,
  braces, no hyphens, and hyphens every 4 digits. Trim and lowercase handle the first two. The
  regex rejects the other three. After this gate, each uuid value has exactly one accepted
  string, so the JS `===` self-guard now compares values, not spellings. Self-deletion through
  any alternate spelling is no longer possible. The half-delete path is also gone: auth-js
  `validateUUID` now accepts every id that reaches `deleteUser`, so it can no longer throw
  after the cleanup deletes have run.
- Side effect: this also narrows **L2**. The auth-js `validateUUID` message can no longer show up
  in the `:282` catch. L2 is otherwise unchanged and stays a follow-up.
- New test coverage: `smoke-edge-roles.sh` Arm 8 sends the caller's own id in braces and without
  hyphens, built with `jq --arg`, so there is no shell or JSON injection. It expects 400
  `userId required`, and the existing post-checks confirm the profile and auth user still exist.
  The `sd_psql` rewrite now returns psql's exit status, so a broken fixture fails visibly instead
  of passing silently. That is a test-integrity improvement.

### Smoke Arm AF (temporary `audit_log` trigger): acceptable

- **Local only.** The script exits early with code 2 for any `SUPABASE_URL` that is not
  `127.0.0.1` or `localhost` (`smoke-store-user.sh:57-64`). Every trigger DDL goes through
  `psql_q`, which runs `docker exec` against the local `supabase_db_imr-inventory` container. No
  path reaches a remote database.
- **Removed on the normal path and on interruption.** The arm drops the trigger itself and
  clears `AUDIT_TRIGGER_INSTALLED` only if the drop succeeds. The `trap cleanup EXIT` handler
  (`:111`) uses `drop ... if exists` whenever the flag is still 1, and prints a WARN pointing to
  the header if that fails. The header's kill -9 recovery block lists both the trigger drop and
  the function drop.
- **Small blast radius even if it is left behind.** The trigger raises only when
  `new.item_ref = 'zz_s165_f<6 hex>'`, a random per-run username nothing else writes. If it
  survived a kill -9, the only effect would be on that one throwaway username on a local stack.
  The function is plain plpgsql (SECURITY INVOKER) and `returns trigger`, so PostgREST cannot
  call it as an RPC and it adds no privilege surface. The interpolated values are `U_AUD` (hex
  from `/urandom`) and a fixed message string, so the SQL cannot be injected into.
- Informational, no finding: there is a window of a few milliseconds between psql committing the
  `create trigger` and the shell setting `AUDIT_TRIGGER_INSTALLED=1`. Arm C's `zz_s165` trigger
  has the same pattern. Because the cleanup drop uses `if exists`, setting the flag *before*
  running the install would close that window at no cost. It is optional, given the blast radius
  above and the documented manual recovery.

### Log assertions: no secret leakage

- AF prints only counts, the target uuid, and the response `BODY`. A successful create response
  is exactly `{id, username}`, and an error response carries only the function's fixed error
  strings. The script never prints `AF_LOGS`, `PW1` / `PW2`, or the placeholder `AUD_EMAIL`. It
  only greps them or passes them to `login_code`, which prints just the HTTP code.
- The AF assertions match what the function is supposed to log: the failure lines contain the
  target id and `P0001`, and the trigger's message text never appears. This confirms in practice
  that the audit helper logs `code` and never `message`, as the updated header comment at
  `manage-store-user/index.ts:24-26` states.
- A8 and A9 run after AF (`:574-594`). A9's log window starts at `SMOKE_T0`, so it also checks the
  AF create and set_password calls for both passwords.

### Updated counts

| Severity | Original | After fix pass |
|---|---|---|
| Critical | 0 | 0 |
| High | 0 | 0 |
| Medium | 3 (M1, M2, M3) | 2 (M2, M3; M1 closed) |
| Low | 2 (L1, L2) | 2 (L1, L2; L2 narrowed) |

M2 still needs either a RESTRICTIVE SELECT migration in a follow-up or an explicit risk
acceptance in the release proposal. M3, L1 and L2 are follow-ups, as stated in the original
audit. Nothing blocks.

### Dependencies (delta)

No `package.json` changes, so `npm audit` was skipped.

# Spec 165: Admin "Add user": create a store user with username + password (no email)

Status: READY_FOR_REVIEW

## User stories
- As a brand admin (admin, master, or super_admin) on Cmd UI **Users & access**, I want to create a store user directly by typing a display name, a username, an initial password, and the stores they work at. No invitation email is sent, so I can set up a new staff member who has no email (or doesn't want to use one) and give them their login in person.
- As that admin, I want to set a new password for one of these username-only store users when they forget it. They have no inbox, so the email reset can't reach them.
- As the new store user, I want to sign in to the staff app with my username and the password my manager gave me, and keep using that password.

Concrete scenario: the Towson store manager hires a line cook who has no email. On her phone she opens Users & access, taps **+ ADD USER**, and enters "Marcus Lee", username `marcus.l`, a password, and ticks "Towson". She reads the password to Marcus. He signs in to the staff EOD app on the store tablet as `marcus.l`. Three weeks later he forgets it. She opens his row, taps **SET PASSWORD**, types a new one, and tells him.

## Background (verified in code, 2026-10-18)
- **Usernames (spec 095).**
  - `profiles.username` has a case-insensitive unique index, `profiles_username_lower_key`.
  - The client validator is [src/lib/usernameValidation.ts](../src/lib/usernameValidation.ts): 3-20 chars, `[A-Za-z0-9_.]`, plus a reserved list.
  - Usernames are stored lowercased. [InviteUserDrawer.tsx:352](../src/components/cmd/InviteUserDrawer.tsx) lowercases as the admin types, and `inviteUser` folds on write.
- **Login.** `signIn` ([src/lib/auth.ts:130](../src/lib/auth.ts)) treats an identifier without `@` as a username. It resolves the email through the `username-resolve` edge function ([supabase/functions/username-resolve/index.ts](../supabase/functions/username-resolve/index.ts)), which uses the service token, returns 200 even when nothing matches (anti-oracle), and looks up `profiles.username` and then `auth.admin.getUserById(...).email`. It then calls `signInWithPassword`. Staff sign in through the same portal (`RoleRouter` → `StaffStack`). So **an auth user with any email plus a `profiles.username` can already sign in by username.** The sign-in path needs no change.
- **Supabase Auth requires an email on every auth user.** These accounts need a synthetic placeholder email.
- **Invite flow today.** `inviteUser` / `registerInvitedUser` ([src/lib/auth.ts:388](../src/lib/auth.ts), [:477](../src/lib/auth.ts)) and [InviteUserDrawer.tsx](../src/components/cmd/InviteUserDrawer.tsx). The drawer is mounted from [UsersSection.tsx:252](../src/screens/cmd/sections/UsersSection.tsx) (desktop/tablet trigger `users-invite-trigger`, "+ INVITE USER") and [phone/PhoneUsers.tsx:278](../src/screens/cmd/sections/phone/PhoneUsers.tsx) (phone trigger `phone-users-invite`).
- **Password reset today.** It is email-only: `sendPasswordReset` → `resetPasswordForEmail` ([src/lib/auth.ts:687-703](../src/lib/auth.ts)), behind the RESET PW button with the gate `canResetPassword` ([UsersSection.tsx:320](../src/screens/cmd/sections/UsersSection.tsx), [PhoneUsers.tsx:107](../src/screens/cmd/sections/phone/PhoneUsers.tsx)). It cannot reach a placeholder address. The login screens' "forgot password" link is only a toast pointing at the desktop console.
- **Emails are displayed today (spec 163).** `get_profile_emails` returns the real `auth.users.email`. It feeds:
  - the Users identity line ([UsersSection.tsx:373-378](../src/screens/cmd/sections/UsersSection.tsx))
  - the delete-confirm `requiredText` (`email || name`, [UsersSection.tsx:271](../src/screens/cmd/sections/UsersSection.tsx), [PhoneUsers.tsx:297](../src/screens/cmd/sections/phone/PhoneUsers.tsx))
  - the phone list and detail ([PhoneUsers.tsx:135, 220, 228](../src/screens/cmd/sections/phone/PhoneUsers.tsx))
  - the Brands members tab ([BrandsSection.tsx:972](../src/screens/cmd/sections/BrandsSection.tsx)) and its delete modal ([:1055-1057](../src/screens/cmd/sections/BrandsSection.tsx))
  - the super-admin brand-cascade preview ([CascadePreviewModal.tsx:338](../src/components/cmd/CascadePreviewModal.tsx))

  Without changes, a placeholder address would show up in every one of these places.
- **Store users get emails from crons.** `eod-reminder-cron` ([supabase/functions/eod-reminder-cron/index.ts:179-209, 273](../supabase/functions/eod-reminder-cron/index.ts)) and `weekly-reminder-cron` (same `lookupEmail` → Resend fallback) email any `user_stores` member whose push delivery fails. A placeholder address would be passed to Resend. That causes bounces and sender-reputation damage, and if the domain were real, delivery to a stranger.
- **Security baseline.**
  - Spec 164: profiles can only be created server-side. A client INSERT is refused, and the `profiles_insert_role_guard` trigger skips `service_role` / SECURITY DEFINER.
  - The edge-function role gate is `ADMIN_ROLES = {admin, master, super_admin}` with a brand-match gate. Reference: [supabase/functions/delete-user/index.ts:19-143](../supabase/functions/delete-user/index.ts).
  - The client calls edge functions through `callEdgeFunction` ([src/lib/auth.ts:295](../src/lib/auth.ts)).
  - `user_stores_brand_match_trg` refuses cross-brand store links.
  - Open hole H1: a NULL-brand staff profile can self-grant any store through the `user_stores` own-row policy. That is why this flow must never create a NULL-brand profile.

## Acceptance criteria

### A. Create store user (server)
- [ ] A new server-side create path exists. It is a JWT-protected edge function, or an edge function plus a SECURITY DEFINER RPC; the architect decides the split. It takes `{ name, username, password, storeIds[] }` and **no** role, brand, email, or user-id input from the client.
- [ ] Caller gate: the caller's role must be in `{admin, master, super_admin}`, with the JWT `app_metadata.role` checked first and `profiles.role` as the fallback. This mirrors `requireAdminCaller` in `delete-user`. A missing or invalid bearer returns HTTP 401. Any other role (including `user`) returns HTTP 403. Neither creates an auth user or a profile.
- [ ] The role is always `'user'`. It is hard-coded server-side, and the request has no field that can change it.
- [ ] Store and brand rules. On violation, return HTTP 400 with a structured `{ error }` and create nothing:
  - [ ] `storeIds` must be non-empty (after dedupe) → else `'at least one store is required'`
  - [ ] every id must be an existing store, and all of them must belong to **one** brand → else a stable error such as `'stores must belong to one brand'`
  - [ ] the brand is **derived** from the stores (spec 090 shape) and is never NULL
  - [ ] admin/master callers: the derived brand must equal the caller's `profiles.brand_id`. A cross-brand request returns HTTP 403 `'forbidden: target is in a different brand'`, using the same wording as `delete-user`. super_admin may target any brand.
- [ ] Username rules, re-validated server-side (never trust the client):
  - it is trimmed and lowercased before storage
  - the format must be 3-20 chars of `[a-z0-9_.]` → else HTTP 400
  - if taken (case-insensitive) → HTTP 409, or 400 with a stable `'username taken'` error. The status code is the architect's choice, but it must be distinguishable from other errors. This is an authenticated, brand-scoped admin action, so revealing the collision is intended (same posture as spec 095's invite drawer).
  - whether the reserved-name list (`RESERVED_USERNAMES`) is also enforced server-side is the architect's call, but the client always enforces it
- [ ] Name: required, non-blank after trim.
- [ ] Password: required, at least 8 characters, enforced server-side as well as in the client. It must also satisfy the project's GoTrue password policy; a GoTrue rejection is returned as HTTP 400 with a readable message.
- [ ] On success, in this order and with no partial state left behind:
  - an `auth.users` row is created with a **placeholder email** (section C) and the admin-typed password, already confirmed so it can sign in immediately
  - **no email of any kind is sent**: no invite, no welcome, no confirmation, no GoTrue mailer
  - one `public.profiles` row is created server-side with `id` = the auth user id, `role='user'`, `brand_id` = the derived brand, `username`, `name`, `status='active'`, and `color` / `initials` derived the same way as `register_invited_profile` (spec 164 §3 step 8)
  - one `public.user_stores` row is created per distinct store id
  - `auth.users.raw_app_meta_data->>'role' = 'user'` (through the existing sync trigger)
  - the response is HTTP 200 / 201 with `{ id, username }`. It does **not** echo the password or the placeholder email.
- [ ] Compensation: if anything after auth-user creation fails (username race, `user_stores_brand_match`, FK, network), the auth user is deleted before the error is returned. Afterwards there is no orphan `auth.users` row, no profile, and no `user_stores` rows. Pre-checking the username before creating the auth user is encouraged, but it does not replace this compensation step.
- [ ] No client INSERT into `profiles` or `user_stores` is introduced. The spec 164 policy and trigger stay unchanged and keep passing.
- [ ] The password never appears in server logs or in responses. That covers the edge function's logs, error messages, and returned JSON.

### B. Set password for a username-only account (server)
- [ ] A new server-side set-password path takes `{ userId, password }`. It is an edge function, or an action on the same function as A; the architect decides.
- [ ] Caller gate: identical to A (401 / 403).
- [ ] Self-guard: if the caller is the target, return HTTP 400 `'cannot set password for self'`. It fires before any side effect, per the CLAUDE.md `'cannot <verb> self'` convention. The architect may adjust the verb wording but must keep the convention.
- [ ] Target rules, checked before any side effect:
  - [ ] the target must have a `profiles` row with `role='user'` → else HTTP 403. This path can never change an admin, master, or super_admin password.
  - [ ] the target must be a **placeholder-email account** (section C) → else HTTP 400 with a stable error such as `'account has an email; use password reset'`. Real-email accounts keep the email reset.
  - [ ] admin/master callers: the target's `brand_id` must equal the caller's `brand_id` → else HTTP 403 (same brand-match gate as `delete-user`, including its NULL-brand caller refusal). super_admin may target any brand.
- [ ] The password is re-validated server-side with the same rules as A.
- [ ] On success the target can sign in by username with the new password, and the old password no longer works. Response: HTTP 200 `{ success: true }`, with no password echo.
- [ ] Existing sessions of the target are revoked (refresh tokens invalidated), so a lost or shared device is signed out. If the architect finds that revocation cannot be done reliably from the edge function, the design doc must say so explicitly and propose the fallback. See the open question below.

### C. Placeholder email
- [ ] The architect chooses the exact shape. It **must** be:
  - [ ] **non-deliverable by construction.** A reserved TLD such as `.invalid` (RFC 2606 / 6761) is the expected class; a domain the company or anyone else could register is **not** acceptable. The architect confirms that GoTrue accepts the chosen shape on both local and prod.
  - [ ] **recognizable by one shared predicate.** A single exported helper (for example `isPlaceholderEmail(email)` or an equivalent server-provided flag) is the only way client and server code decide "this is a username-only account". No screen hand-rolls its own check. If the server needs the same predicate (sections B and D), the server and client copies are listed together in the design so drift is caught in review (inline-not-shared, per spec 027).
  - [ ] **unique per account and independent of the username**, so it never needs rewriting if a username changes
  - [ ] **not usable as a disclosure.** It is never returned to the client in a create or set-password response, and never shown in any UI (section D)
- [ ] Typing the placeholder address directly into the login form gives no extra capability beyond username sign-in. The password is still required, and GoTrue's normal rate limiting applies. No special handling is required beyond confirming this in the design.

### D. Display of username-only accounts (no placeholder ever shown)
- [ ] Users & access, desktop/tablet: for a placeholder account the identity line shows `@username · <shortId>`. It shows **no** email and **no** "(email not loaded)". It carries a small marker that the account signs in by username (copy is the developer's call, e.g. "username sign-in").
- [ ] Users & access, phone (list row `meta`, detail subtitle, list `name` fallback): the placeholder is never rendered. It shows `@username` plus the same marker in place of the email or "noEmail" string.
- [ ] Delete confirm (desktop and phone): for a placeholder account, `requiredText`, the title, and the description use the username (or name) and never the placeholder address.
- [ ] Brands section: the members tab ([BrandsSection.tsx:972](../src/screens/cmd/sections/BrandsSection.tsx)) and the delete-profile modal ([:1055-1057](../src/screens/cmd/sections/BrandsSection.tsx)) never render the placeholder. They show `@username` and the marker instead.
- [ ] [CascadePreviewModal.tsx](../src/components/cmd/CascadePreviewModal.tsx) never renders the placeholder.
- [ ] Recommended approach (architect may choose another that meets the AC): clear the email at the data layer (`fetchAllUsers`, `fetchBrandAdmins`, the cascade-preview mapper) and expose a boolean such as `User.loginKind: 'email' | 'username'`, so screens don't need to know the placeholder shape.
- [ ] RESET PW (email reset) is **hidden** for placeholder accounts on desktop and phone, so it never calls `resetPasswordForEmail` on a placeholder address. **SET PASSWORD** is shown in its place.
- [ ] Pending-invitation dedup in `fetchBrandAdmins` (spec 163 `activeEmails`) does not treat placeholder addresses as active emails. Since no invitation ever carries one, this mostly matters for correctness of the predicate. Covered by jest.

### E. Outbound email never targets a placeholder address
- [ ] `eod-reminder-cron` and `weekly-reminder-cron` skip the Resend email fallback for placeholder addresses. The user is counted as not emailed, with no Resend call. Push delivery is unchanged.
- [ ] The architect audits every other edge function that emails a user (`send-po-email`, `send-order-failure-email`, `send-welcome-email`, `send-invite-email`) and either confirms it cannot reach a `role='user'` placeholder account (for example, recipients are admins only) or adds the same skip. The audit result is recorded in the design doc.

### F. Cmd UI: Add user drawer (desktop/tablet + phone)
- [ ] Users & access desktop/tablet: a second trigger, **+ ADD USER** (`testID="users-add-trigger"`), sits next to "+ INVITE USER" in the TabStrip right slot. The existing invite trigger, drawer, and behavior are unchanged.
- [ ] Phone ([PhoneUsers.tsx](../src/screens/cmd/sections/phone/PhoneUsers.tsx)): a thumb-reachable **ADD USER** action (`testID="phone-users-add"`) is added alongside the existing 48px INVITE primary. The phone tier's guard-after-hooks pattern is preserved.
- [ ] Both triggers open the same new drawer (a sibling of `InviteUserDrawer`, built on `ResponsiveSheet`, with the same Esc and Cmd+S / Cmd+Enter keyboard behavior on web). Fields:
  - **Display name** (required)
  - **Username** (required). It is lowercased as the admin types and validated live with `validateUsername`; the error appears inline.
  - **Password** (required, at least 8 characters). It is a secure-entry field with a show/hide toggle, so the admin can read it back to the user.
  - **Stores** (required, at least 1). It is a multi-select limited to the active brand's stores, with the same spec 068 brand filter and stale-selection prune as `InviteUserDrawer`.
- [ ] No role picker. The drawer states that the account is a store user that signs in to the staff app with username + password.
- [ ] No-brand state (super_admin "All brands" view) shows the same "Switch into a brand first" notice as `InviteUserDrawer`, and submit is disabled. If the active brand has zero stores, a notice is shown and submit is disabled.
- [ ] Submit is disabled until name, username (valid), password (at least 8), and at least 1 store are present. The footer hint names the missing field(s).
- [ ] On success:
  - a success toast shows the username (never the password)
  - the drawer closes and **clears the password from component state**
  - the Users list refreshes and the new row appears with `@username`, the store chips, the "store user" role badge, and the username-sign-in marker
- [ ] On error, a toast appears and the drawer stays open with the input kept, so the admin can fix and retry:
  - username taken → `Username "<u>" is already taken`
  - store / brand / password errors → the server's error string
  - 403 → a permission message
- [ ] The password is never persisted: not in Zustand, not in AsyncStorage/localStorage, not in logs, not in toasts.
- [ ] The client calls go through `callEdgeFunction` (or `supabase.functions.invoke` if typed errors are needed, per the CLAUDE.md exception). There is no raw `fetch`. The wrappers live in `src/lib/auth.ts`, next to `inviteUser` / `deleteUser`.
- [ ] The section hero copy ("Invite admins and store users, …") and the empty state ("Click "+ INVITE USER" …") mention the add-user path.
- [ ] New phone-tier strings go through the i18n catalogs (`section.users.phone.*`) in `en`, `es`, and `zh-CN`. New desktop strings follow whatever the surrounding UsersSection code already does.

### G. Cmd UI: Set password action
- [ ] On desktop/tablet rows and on the phone detail, a **SET PASSWORD** button appears for a placeholder account when the caller passes the existing `canResetPassword` gate (target is `role='user'`, not self). For placeholder accounts it replaces RESET PW.
- [ ] It opens a small confirm sheet or modal with:
  - a new-password field (secure entry with a show/hide toggle, at least 8 characters)
  - a line naming the target by `@username`
  - a note that the user's existing sessions will be signed out (or the architect's fallback wording)
- [ ] Success toast: "Password updated for @username". Error toast: the server string. The password is cleared from state on close.
- [ ] Real-email accounts are unchanged. They keep RESET PW (email) and do not get SET PASSWORD.

### H. Sign-in and staff app
- [ ] A user created through A signs in through the existing login portal (desktop `LoginScreen` and phone `PhoneLogin`) with `username` + password, lands in the **StaffStack** EOD app, and sees exactly the assigned stores.
- [ ] After a B set-password, the new password works and the old one returns `GENERIC_LOGIN_ERROR`.
- [ ] `signIn`, `resolveUsernameToEmail`, and the `username-resolve` function need no behavior change. If the architect finds one is needed (for example, resolving a placeholder account), it must keep the spec 095 anti-oracle contract (always 200 `{ email | null }`).

### I. Deletion
- [ ] Deleting a placeholder account through the existing `delete-user` flow removes its profile, `user_stores`, and auth user, with no change to `delete-user`'s gates. The confirm text follows section D.

### J. Tests
- [ ] **Shell smoke** (new `scripts/smoke-*.sh`, `scripts/smoke-edge-roles.sh` style) against the local stack, for the create and set-password function(s):
  - no bearer → 401
  - `user`-role bearer → 403
  - admin with a cross-brand store → 403
  - empty `storeIds` → 400
  - mixed-brand stores → 400
  - bad username format → 400
  - duplicate username → the "taken" error
  - short password → 400
  - happy path → 2xx, and a follow-up `username-resolve` + password sign-in succeeds
  - set-password on self → 400; on an admin target → 403; on a real-email `user` → 400; happy path → old password fails and new password works
  - the response bodies never contain the password or the placeholder email
- [ ] **pgTAP:** if the design adds any SQL (an RPC, helper, or constraint), a new `supabase/tests/*.test.sql` covers its grants (`revoke … from public, anon`, spec 097), `prosecdef`, pinned `search_path`, brand derivation, the refusal of empty or mixed-brand store sets, `role='user'` only, and the no-partial-state rule. The existing `profiles_insert_hardening`, `permissive_policy_lint`, and `user_stores_brand_match_*` suites still pass unchanged.
- [ ] **jest:**
  - the placeholder predicate (positive and negative cases)
  - the data-layer email clearing and `loginKind` flag in `fetchAllUsers` / `fetchBrandAdmins`
  - the new `auth.ts` wrappers (envelope / error mapping, password never in the payload of any toast or log spy)
  - the Add user drawer: validation gating, required store, lowercase username, password cleared on close, taken-username toast mapping, no-brand notice
  - UsersSection and PhoneUsers: the new triggers exist; placeholder rows show `@username` with no email, no "(email not loaded)", no RESET PW, but SET PASSWORD; real-email rows are unchanged
  - BrandsSection members tab placeholder rendering
  - existing tests that pin the current UsersSection / PhoneUsers / InviteUserDrawer behavior are updated, not deleted
  - full `npx jest`, `npm run typecheck`, and `npm run typecheck:test` pass
- [ ] **e2e (Playwright, optional but recommended):** a sibling of [e2e/invite.spec.ts](../e2e/invite.spec.ts) that adds a user and signs in as them. If it is skipped, the reason is recorded in the test-engineer review.
- [ ] **Local browser verification** (`npm run dev:db`, as `admin@local.test`), on desktop and phone widths:
  - add a user with one store
  - sign in as them by username into the staff app
  - set their password and sign in with the new one
  - confirm the placeholder is never visible on Users, Brands, or the phone detail

### K. Rollout
- [ ] The new edge function(s) are deployed to prod (`ebwnovzzkwhsdxkpyjka`), with their `verify_jwt` entry in [supabase/config.toml](../supabase/config.toml) pinned explicitly (send-po-email precedent).
- [ ] Any migration is applied to prod via MCP, with its version inserted into `schema_migrations` and the function bodies verified with normalized-md5 (project runbook).
- [ ] Updated crons from section E are deployed.
- [ ] After the push to `main`, the latest runs of `test.yml` and `db-migrations-applied.yml` on `main` are green, and `e2e.yml` is checked manually (project memory).

## In scope
- A server-side create-store-user path (username + admin-set password + 1 or more stores, role fixed to `user`, brand derived from the stores, placeholder email, no email sent, compensating cleanup)
- A server-side admin set-password path for placeholder (username-only) `user` accounts, brand-scoped, with a self-guard and session revocation
- The placeholder email convention and its single shared predicate
- Hiding placeholder addresses on every admin surface that shows user emails (Users desktop/tablet/phone, Brands members tab and delete modal, cascade preview), and hiding email RESET PW for these accounts
- Skipping the reminder-cron email fallback for placeholder addresses, plus an audit of other user-emailing functions
- An Add user drawer with triggers on desktop/tablet and phone, and a SET PASSWORD action on both tiers
- Shell smoke, jest, pgTAP (if SQL is added), optional e2e, prod deploy, CI gate check

## Out of scope (explicitly)
- **Attaching or changing a real email on a username-only account later** (owner decision 4). Possible follow-up spec.
- **Forced password change on first sign-in** (owner decision 2).
- **Auto-generated or emailed passwords** (owner decision 1).
- **Creating admins, masters, or super_admins without email** (owner decision 3). Admins still use the email invite.
- **Admin set-password for real-email accounts.** They keep the email reset. Widening this is a one-line follow-up if wanted.
- **Self-service "forgot password" for username-only users.** The login "forgot password" toast stays as it is; they ask their manager.
- **Editing username, name, or store assignments after creation.** There is no edit UI today, and this spec does not add one.
- **Converting existing invited or email accounts into username-only accounts**, or the reverse.
- **The H1 fix** (dropping the `user_stores` own-row write arm). This flow never creates a NULL-brand profile, so it does not widen H1. A placeholder user can still self-grant other stores **within its own brand** (the existing spec 164 out-of-scope item), which is pre-existing and unchanged. H1 stays the next security spec.
- **Changes to `signIn` / `username-resolve` behavior**, unless the architect finds them strictly necessary (H).
- **Realtime push of the new row** to other open admin sessions. Users & access refetches on mount and after its own actions, the same as invites today.
- **Bulk or CSV user creation.**
- **The `app.json` slug.** Not touched.

## Open questions resolved
Owner decisions (from the request, not re-asked):
- Q: Who picks the initial password? → A: The admin types it in the drawer and hands it over in person. Nothing is auto-generated.
- Q: Force a password change on first sign-in? → A: No. The user keeps the admin-set password.
- Q: Which roles can be created this way? → A: Store users only (`role='user'`). Admins use the email invite.
- Q: Allow attaching a real email later? → A: No. Explicit non-goal; possible follow-up.

PM defaults, using least-privilege or existing-precedent choices. None blocks the design. Items marked **(user may override)** are product calls:
- Q: Who may use Add user and Set password? → A: Every role in `ADMIN_ROLES` (admin, master, super_admin), brand-scoped. This matches who can invite store users today. Non-master admins are already allowed to invite `user` rows.
- Q: Are stores required? → A: Yes, at least 1, and all from one brand. The brand is derived from the stores. This keeps the account out of the H1 NULL-brand state (the owner's security constraint).
- Q: Minimum password length? → A: 8, enforced on client and server. It matches the RecoveryScreen floor; local GoTrue allows 6. **(user may override)**
- Q: Should Set password be limited to username-only accounts? → A: Yes. Real-email accounts keep the email reset, so an admin can't silently take over an account that has its own inbox. **(user may override)**
- Q: Should Set password sign the user out elsewhere? → A: Yes, revoke existing sessions, because the main reason to reset is a forgotten password or a lost or shared device. The architect confirms feasibility; if it isn't feasible, the design says so and the UI note is adjusted. **(user may override)**
- Q: Should the drawer be separate or a mode of the invite drawer? → A: A separate "+ ADD USER" trigger and drawer. Owner phrasing: "alongside the existing 'Invite user' flow". It leaves the invite drawer and its tests untouched.
- Q: Should the password field be masked? → A: Masked, with a show/hide toggle. The admin needs to read it back to the user in person.
- Q: Is the display name required? → A: Yes, the same as invites. `profiles.name` drives initials and the row title.
- Q: Should a username taken by another brand be revealed? → A: Yes, as "already taken", the same as the invite drawer (spec 095). The username index is global, and this is an authenticated admin action. It does not reveal which brand holds the username.
- Q: Web and native? → A: Both. No web-only APIs. Native picks it up in the next EAS build.

## Dependencies
- Spec 095 usernames: `profiles.username`, `profiles_username_lower_key`, `usernameValidation.ts`, the `username-resolve` edge function and its service token
- Spec 164: profiles INSERT policy and `profiles_insert_role_guard` (server-side creation only), and the `register_invited_profile` initials/color rule to mirror
- Spec 163: `get_profile_emails`, `fetchProfileEmails`, `fetchAllUsers` / `fetchBrandAdmins` email precedence (the placeholder clearing hooks in here)
- Spec 090 / 068 / 069: store-derived brand and the brand-filtered store multi-select
- `delete-user` edge function: `requireAdminCaller`, `requireSameBrandOrSuperAdmin`, and the self-guard shape
- `user_stores_brand_match_trg`, `profiles_role_brand_consistent`, `profiles_sync_role_to_jwt`
- Supabase Auth admin API (create user with a confirmed email, update a user's password, session revocation) through the service-role key in an edge function
- `eod-reminder-cron`, `weekly-reminder-cron` (section E)
- The `ResponsiveSheet` drawer pattern and the phone-tier `PhoneDrillScaffold` / guard-after-hooks conventions (specs 140-148)

## Project-specific notes
- **Cmd UI section / legacy:** `src/screens/cmd/sections/UsersSection.tsx` (desktop/tablet), `src/screens/cmd/sections/phone/PhoneUsers.tsx` (phone), a new drawer under `src/components/cmd/`, and display-only touches in `BrandsSection.tsx` and `src/components/cmd/CascadePreviewModal.tsx`. There is no legacy surface.
- **Per-store or admin-global:** Brand-scoped admin action. The caller can only create users in, or set passwords for users in, its own brand (super_admin: any brand). The created user is per-store through `user_stores` and reads through `auth_can_see_store()`. Per-store RLS is unchanged.
- **Realtime channels touched:** None required. Profile and `user_stores` inserts replay on whatever channels already carry those tables, the same as invites. No publication change is expected; if the design adds one, the `docker restart supabase_realtime_imr-inventory` gotcha applies.
- **Migrations needed:** Possibly. If the design puts profile creation or validation in a SECURITY DEFINER RPC, it needs a migration with spec 097 explicit grants, applied to prod via MCP before the push. A pure edge-function design (service-role insert, which `profiles_insert_role_guard` skips) needs none. Architect's call.
- **Edge functions touched:**
  - new: a create-store-user function and a set-password function (one function or two; architect's call). JWT-protected, `ADMIN_ROLES` gate, brand gate, self-guard on set-password, and an explicit `verify_jwt = true` pin in `config.toml`
  - modified: `eod-reminder-cron`, `weekly-reminder-cron` (placeholder skip)
  - audited: `send-po-email`, `send-order-failure-email`, `send-welcome-email`, `send-invite-email`
  - JSON only, so no HTML-escape concern in the new function(s). The crons already follow the escape rule.
- **Web/native scope:** Both. `src/lib/auth.ts` and the drawers are shared. Web ships through Vercel; native needs an EAS build.
- **Test tracks:** shell smoke (primary, edge functions), jest (UI + data layer + predicate), pgTAP (only if SQL is added), optional Playwright e2e, plus manual local browser verification.
- **`app.json` slug:** Not touched.
- **Security notes for architect and auditor:**
  - This is the first path that sets another user's password. Required: target is `role='user'`, target is a placeholder account, same brand, not self, all checked before any side effect.
  - The service-role client in the edge function bypasses RLS and the spec 164 guard, so every role/brand/store check must be explicit in the function body.
  - The password must never be logged.

## Backend design

Author: backend-architect, 2026-10-18. Owner-approved defaults (8-char minimum, set-password only for username-only `user` accounts, session revocation on set-password, separate Add-user drawer) are taken as fixed and not reopened here.

### 0. Decisions at a glance

| # | Question | Decision | Evidence checked |
|---|---|---|---|
| D1 | One edge function or two | **One** JWT-protected function, `manage-store-user`, with `action: 'create' \| 'set_password'` | `delete-user/index.ts:19-143` (gate + brand gate would otherwise be duplicated verbatim in two bundles under inline-not-shared) |
| D2 | Placeholder email shape | `u-<32 lowercase hex>@no-email.invalid`. The hex comes from `crypto.randomUUID()` with the dashes removed. It is **not** the auth user id and **not** derived from the username | RFC 2606 §2 / RFC 6761 §6.4 reserve `.invalid`; GoTrue admin create accepts RFC 2606 TLDs locally (see §3.3) |
| D3 | RPC / migration for brand-store scoping and username uniqueness | **None.** All checks run in the edge function through the service-role client. The DB backstops are the existing `profiles_username_lower_key`, `user_stores_brand_match_trg`, and FK cascades. **No migration and no new pgTAP** (one contingency migration in §5.4 is built only if a smoke assertion fails) | `20260607120000_profiles_username.sql:78`, `20260528010000_user_stores_brand_match_null_brand_guard.sql:69-128`, `20260405000759_init_schema.sql:21,32` (`on delete cascade` from auth.users to profiles to user_stores) |
| D4 | Reserved usernames on the server | **Yes.** The edge function checks an inline copy of `RESERVED_USERNAMES`, and jest enforces that the copy matches (§3.4) | `src/lib/usernameValidation.ts:35-47` |
| D5 | Session revocation | Primary: GoTrue's own behaviour on `auth.admin.updateUserById(id, { password })`, which logs out every session of that user. supabase-js 2.x has **no** sign-out-by-user-id. **A smoke assertion gates this (blocking).** Fallback in §5.4 | `node_modules/@supabase/auth-js` 2.101.1 `GoTrueAdminApi.d.ts:46` (`signOut(jwt, scope)` needs the target's own JWT) and `GoTrueAdminApi.js:56` (`POST /logout?scope=` with that JWT) |
| D6 | Rollback after `auth.admin.createUser` | Compensate with `auth.admin.deleteUser(newId)`. The FK cascade removes the profile and `user_stores` | init schema FKs as in D3 |
| D7 | Outbound email | Placeholder skip added to `eod-reminder-cron`, `weekly-reminder-cron`, `send-welcome-email`. Confirmed unreachable, no change: `send-po-email`, `send-order-failure-email`, `send-invite-email` | §6 |
| D8 | Display | Data-layer clearing plus `User.loginKind`, in `fetchAllUsers` (auth.ts), `fetchBrandAdmins` (db.ts), and `mapCascadePreview` (db.ts). The invitation-inference fallback is **suppressed** for placeholder rows | `src/lib/auth.ts:639-663`, `src/lib/db.ts:5503-5545`, `src/lib/db.ts:5253-5280` |

### 1. Data model changes

**None.** There is no migration, no new table or column or index, and no publication change.

The function relies on existing structure:
- `profiles.id` references `auth.users(id) on delete cascade`, and `user_stores.user_id` references `profiles(id) on delete cascade` (`20260405000759_init_schema.sql:21,32`). One `auth.admin.deleteUser` is therefore a complete rollback.
- `profiles_username_format` CHECK plus `profiles_username_lower_key` (unique on `lower(username)`) is the race-proof uniqueness authority.
- `user_stores_brand_match_trg` (BEFORE INSERT/UPDATE) refuses a store whose brand differs from the profile's non-NULL brand.
- `profiles_insert_role_guard` skips `service_role` (`current_user` is not `authenticated`/`anon`), so a service-role insert of `role='user'` passes. The function never inserts any other role, and the spec 164 policy and trigger stay unchanged.
- `profiles_sync_role_to_jwt` (AFTER INSERT) writes `raw_app_meta_data.role = 'user'`.
- No trigger fires on `auth.users` insert. I grepped every `*.sql` under `supabase/` for `after insert on auth`/`handle_new_user` and found nothing, so creating the auth user creates nothing else.

Why no RPC? An RPC would make the profile and `user_stores` inserts atomic with each other. It cannot make them atomic with `auth.admin.createUser`, which is an HTTP call to GoTrue outside any DB transaction, so compensation is required either way. The cascade makes compensation one call. An RPC would add a prod MCP apply, a normalized-md5 verification, a `db-migrations-applied` row, and a pgTAP suite, all to protect a sub-second window that compensation already covers. Rejected.

### 2. RLS impact

- **No policy changes.** No new tables.
- The service-role client in the function bypasses RLS, so every gate in §4 is explicit in the function body. This is the same posture as `delete-user`.
- The created account reads through the existing policies: `auth_can_see_store()` for its `user_stores`, the profiles own-row arm, and so on.
- H1 is not widened. The brand is always the store-derived, non-NULL brand. Within-brand self-grant through the `user_stores` own-row arm is the pre-existing spec 164 out-of-scope item.
- The spec 051/053 permissive-policy lint is not engaged.

### 3. Placeholder email

#### 3.1 Shape and generator
- Shape: `u-` + 32 lowercase hex + `@no-email.invalid`. Example: `u-3f2a…9c@no-email.invalid`, 50 characters in total.
- Generator (server only, in `manage-store-user`): `"u-" + crypto.randomUUID().replaceAll("-", "") + "@no-email.invalid"`. Immediately after generating, the function asserts `isPlaceholderEmail(generated)`. If that fails, it returns 500 and nothing is created.
- Why random rather than the auth user id: `username-resolve` returns this address to anyone holding the public bundle token, at 20 requests/min/IP (`username-resolve/index.ts:150-155`). A user-id-derived address would leak profile UUIDs through that endpoint. A random value leaks nothing, and the address never needs rewriting.
- Uniqueness: 122 random bits, and GoTrue's unique email index is the backstop. A collision surfaces as a createUser error, which maps to 500 with nothing created.

#### 3.2 The one predicate (inline-not-shared, five identical copies)

Contract:

```
PLACEHOLDER_EMAIL_RE = /^u-[0-9a-f]{32}@no-email\.invalid$/
isPlaceholderEmail(email: unknown): boolean
  = typeof email === "string" && PLACEHOLDER_EMAIL_RE.test(email.trim().toLowerCase())
```

- The predicate is strict: only the generator's output shape matches. Any other `.invalid` address is "not a placeholder", which is the fail-safe direction for the set-password gate.
- Copies. Each one sits between the marker lines `// BEGIN placeholder-email (spec 165)` and `// END placeholder-email (spec 165)`. The text between the markers must be **byte-identical** in every copy, and `export` keywords stay outside the block:
  1. `src/lib/placeholderEmail.ts` (TS canonical; exports `isPlaceholderEmail` and `PLACEHOLDER_EMAIL_RE`)
  2. `supabase/functions/manage-store-user/index.ts`
  3. `supabase/functions/eod-reminder-cron/index.ts`
  4. `supabase/functions/weekly-reminder-cron/index.ts`
  5. `supabase/functions/send-welcome-email/index.ts`
- Use double quotes inside the block. The crons use single quotes elsewhere, which is fine because only the block must match.
- No other code may test for `no-email.invalid` or `.invalid`. Client screens use `User.loginKind` (§7), never the email shape.

#### 3.3 GoTrue acceptance: what was checked and how to verify
- Checked in repo:
  - `scripts/smoke-edge-roles.sh:273-303` (Arm 5) creates auth users at `escape-test-…@local.test` through `auth.admin.inviteUserByEmail` and passes locally, so local GoTrue does not reject an RFC 2606 reserved TLD on the admin path.
  - The seed's `admin@local.test` and `manager@local.test` are also reserved-TLD addresses.
  - `GoTrueAdminApi.d.ts:244` documents that `createUser()` sends **no** confirmation email.
- Not checkable in repo: GoTrue is a Docker image, so its source isn't on disk. `.invalid` specifically, and prod's GoTrue version, are verified by these steps:
  - **Local (backend-developer, before writing the function):**
    1. `POST http://127.0.0.1:54321/auth/v1/admin/users` with service-role `apikey` + `Authorization` and body `{"email":"u-<32hex>@no-email.invalid","password":"<8+ chars>","email_confirm":true}`. Expect 200, with `user.email` equal to the lowercased input and `email_confirmed_at` set.
    2. `POST /auth/v1/token?grant_type=password` with that email and password. Expect 200.
    3. The local mail catcher UI at `http://127.0.0.1:54324` shows no message for that address.
    4. Delete the user with `DELETE /auth/v1/admin/users/<id>`.
    5. Record the result in the PR description. The smoke happy path (§10) re-proves this on every run.
  - **Prod (rollout step K, owner present):** after deploying the function, create one throwaway user (`zz_probe165`, one store) through the drawer, sign in by username on the staff app, then delete it through the existing DELETE. If createUser rejects the shape, the function returns a 4xx/5xx and has created nothing (§4.4), so this probe is safe.
- Typing the placeholder into the login form: `signIn` (`auth.ts:130-148`) sends any `@` identifier straight to `signInWithPassword`. That gives the same capability as username sign-in: the password is still required, and GoTrue's `sign_in_sign_ups` limit applies. No handling needed.

#### 3.4 Reserved names (D4)
- `manage-store-user` holds an inline `RESERVED_USERNAMES` set, byte-identical to `src/lib/usernameValidation.ts:35-47`, between marker lines `// BEGIN reserved-usernames (spec 165)` and `// END reserved-usernames (spec 165)`.
- The TS file gets the same markers around its set literal. Only comments are added, so behaviour is unchanged.
- Rationale: this path mints a login identity with no inbox, and any admin can curl the function directly. The server is the trust boundary, and blocking `admin`/`support`/`system` handles on a shared store tablet is cheap.
- The spec 095 backfill exemption is unaffected, because it is a SQL-side backfill.

### 4. API contract: `manage-store-user` edge function

- `POST /functions/v1/manage-store-user`, JSON only (no HTML, so no `escapeHtml`). CORS headers copied verbatim from `delete-user/index.ts:8-12`. `OPTIONS` returns `ok`; any other method returns 405 `{ error: "method not allowed" }`.
- **config.toml:** add `[functions.manage-store-user]` with `verify_jwt = true`, plus a comment block in the `send-po-email` / `instacart-cart-link` style (admin-triggered, carries the caller's JWT, holds the service-role key, must never be flipped off).
- Gate:
  - `const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);`
  - `requireAdminCaller()` is copied verbatim from `delete-user/index.ts:24-47`: JWT `app_metadata.role` first, then `profiles.role` through the caller-JWT client.
  - Missing or invalid bearer returns 401 (`"missing bearer token"` / `"invalid token"`). Any other role returns 403 `"forbidden"`.
  - The gateway's own `verify_jwt` 401 also satisfies "no bearer → 401".
- Brand gate for **admin/master** callers:
  - One service-role read of the caller's `profiles.brand_id`. Missing row returns 403 `"forbidden: caller profile not found"`. NULL brand returns 403 `"forbidden: caller has no brand scope"`.
  - super_admin skips this gate.
  - The wording is copied from `delete-user/index.ts:119-140`.
- Body: `{ action: "create" | "set_password", ... }`. An unknown or missing action returns 400 `"unknown action"`. Malformed JSON returns 400 `"invalid JSON"`.
- The function reads **only** the allowlisted fields per action. Any other key (`role`, `brand_id`, `brandId`, `email`, `id`, `userId` on create) is ignored and never read. Smoke proves this by sending `role:"admin"` and asserting `profiles.role='user'`.

#### 4.1 Password rule (both actions)
- `typeof password === "string"`, used **verbatim** (no trim). Fewer than 8 characters returns 400 `"password must be at least 8 characters"`.
- Inline const `PASSWORD_MIN_LENGTH = 8`.
- If GoTrue rejects the password (`error.code` is `weak_password` or `validation_failed`, or HTTP status 422; this covers the 72-byte bcrypt cap and any prod `password_requirements`), return 400 with GoTrue's `error.message`. GoTrue messages describe the rule and never echo the value.
- As a belt-and-braces step, any message that contains the generated placeholder is replaced with `"could not create account"`.

#### 4.2 `action: "create"`

Request `{ action:"create", name, username, password, storeIds }`. The steps run in this order, and steps 1-6 have **no side effects**:

1. `name` is a string; trim it. Empty returns 400 `"name is required"`. Longer than 100 characters returns 400 `"name must be at most 100 characters"`.
2. `username` is a string; trim and lowercase it. It must match `/^[a-z0-9_.]{3,20}$/`, else 400 `"username must be 3-20 characters: a-z, 0-9, _ or ."`. If it is in `RESERVED_USERNAMES`, return 400 `"username is reserved"`.
3. Apply the password rule (§4.1).
4. `storeIds` must be an array. Filter it to strings, trim, lowercase, and dedupe. Empty returns 400 `"at least one store is required"`. Any element that is not UUID-shaped, or more than 100 elements, returns 400 `"unknown store"`.
5. Run these service-role reads in parallel with `Promise.all`:
   - (a) `stores.select("id, brand_id").in("id", ids)`
   - (b) the caller-brand read (admin/master only)
   - (c) a username pre-check: `profiles.select("id").ilike("username", escaped).limit(1).maybeSingle()`, using the escape idiom copied from `username-resolve/index.ts:138`
   
   Then:
   - Fewer rows in (a) than ids: 400 `"unknown store"`.
   - Distinct `brand_id` count other than 1, or any NULL brand: 400 `"stores must belong to one brand"`. This is the derived brand.
   - admin/master whose caller brand differs from the derived brand: 403 `"forbidden: target is in a different brand"`.
   - (c) found a row: **409** `"username taken"`.
6. Generate the placeholder and self-check it (§3.1). Compute `initials` with the `register_invited_profile` rule (`20261007000000_profiles_insert_hardening.sql:219-225`): split the trimmed name on single spaces, take the first character of each part (empty parts contribute nothing), join, keep the first 2, uppercase. `color = "#378ADD"`.
7. **Side effect 1:** `auth.admin.createUser({ email: placeholder, password, email_confirm: true, user_metadata: { name } })`. Do not pass `app_metadata` (the sync trigger owns `role`) and do not pass `id`. On error: a weak-password class error returns 400 per §4.1; anything else returns 500 `"could not create account"`. Nothing needs compensating at this point.
8. **Side effect 2:** service-role `profiles.insert({ id, name, role: "user", brand_id: derived, username, status: "active", color, initials })`. `role` is a string literal in code, never a variable from the request. On error, compensate (§4.4) and then:
   - 23505 whose message or details mention `profiles_username_lower_key`: 409 `"username taken"` (race)
   - anything else: 500 `"could not create account"`
9. **Side effect 3:** a **single bulk** `user_stores.insert(ids.map(store_id => ({ user_id: id, store_id })))`. That is one statement, so it is all or nothing. On error, compensate and then:
   - message contains `cross-brand user_stores assignment rejected` (a store moved brands mid-flight): 400 `"stores must belong to one brand"`
   - 23503 (store deleted mid-flight): 400 `"unknown store"`
   - otherwise: 500 `"could not create account"`
10. Return **201** `{ id, username }`. No email, no password, no brand.

#### 4.3 `action: "set_password"`

Request `{ action:"set_password", userId, password }`. Steps 1-5 have no side effects:

1. `userId` must be a UUID-shaped string, else 400 `"userId required"`.
2. **Self-guard:** if `userId === gate.userId`, return 400 `"cannot set password for self"`. This is the `'cannot <verb> self'` convention, alongside `'cannot delete self'` and `'cannot demote self'`. It fires before any read or write.
3. Apply the password rule (§4.1).
4. One service-role read: `profiles.select("brand_id, role").eq("id", userId).maybeSingle()`.
   - admin/master: apply the caller-brand gate, then `target.brand_id !== caller.brand_id` returns 403 `"forbidden: target is in a different brand"`. This is `requireSameBrandOrSuperAdmin` semantics with **one deliberate difference**: a missing target profile is refused, not allowed through.
   - All callers: no profile, or `role !== "user"`, returns 403 `"forbidden: target is not a store user"`.
5. `auth.admin.getUserById(userId)`. On error, 500 `"could not update password"`. If `!isPlaceholderEmail(user.email)`, return 400 `"account has an email; use password reset"`.
6. **Side effect:** `auth.admin.updateUserById(userId, { password })`. A weak-password class error returns 400 (§4.1); any other error returns 500 `"could not update password"`.
7. Return 200 `{ success: true }`.

#### 4.4 Compensation (rollback ordering)

The only side effects are createUser (7), profile insert (8), and `user_stores` insert (9). Any failure at 8 or 9 runs `compensate(newId)`:
1. `auth.admin.deleteUser(newId)`. On error, retry once.
2. If both attempts fail, run a service-role `user_stores.delete().eq("user_id", newId)` and then `profiles.delete().eq("id", newId)`. This releases the username and removes the half-row from the Users list. Then `console.error("[manage-store-user] compensation incomplete; orphan auth user", newId)`. Log the id only, never the body.
3. The response is always the mapped error from steps 8 and 9 (or 500 `"could not create account"`). The orphan id is never returned to the client.

Residual risk: a network partition during compensation can leave an **auth-only** user. It has no profile, so it cannot sign in by username (`username-resolve` finds no profile) and it doesn't appear in the Users list. It can be removed from the Supabase dashboard. This is accepted and recorded.

#### 4.5 Logging and secrets
- Never log `req.json()`, `password`, the generated email, or GoTrue request objects. The only permitted logs are the compensation line above and `console.error` of `error.code`/`error.status` with no message text. Reason: GoTrue messages are safe, but log hygiene should not depend on that.
- The `catch` at the top level returns 500 `"internal error"`. Unlike `delete-user`, it does not return `e.message`, because a thrown JSON parse error could quote body fragments.

#### 4.6 Error table (the stable strings the client maps)

| Status | `error` | Action |
|---|---|---|
| 401 | `missing bearer token` / `invalid token` | both |
| 403 | `forbidden` | both |
| 403 | `forbidden: caller profile not found` / `forbidden: caller has no brand scope` / `forbidden: target is in a different brand` | both |
| 403 | `forbidden: target is not a store user` | set_password |
| 400 | `invalid JSON` / `unknown action` | both |
| 400 | `name is required` / `name must be at most 100 characters` | create |
| 400 | `username must be 3-20 characters: a-z, 0-9, _ or .` / `username is reserved` | create |
| 409 | `username taken` | create |
| 400 | `at least one store is required` / `unknown store` / `stores must belong to one brand` | create |
| 400 | `password must be at least 8 characters` / GoTrue's weak-password message | both |
| 400 | `userId required` / `cannot set password for self` / `account has an email; use password reset` | set_password |
| 500 | `could not create account` / `could not update password` / `internal error` | — |

### 5. Session revocation (D5)

#### 5.1 What exists
supabase-js 2.101.1 admin API (`GoTrueAdminApi.d.ts`) has `signOut(jwt, scope)`, `inviteUserByEmail`, `generateLink`, `createUser`, `listUsers`, `getUserById`, `updateUserById`, `deleteUser`, and `mfa`. `signOut` posts `/logout?scope=` **with the target's own JWT** (`GoTrueAdminApi.js:51-60`). The edge function doesn't have that JWT and cannot mint one. **There is no sign-out-by-user-id in supabase-js 2.x.** The edge functions import `esm.sh/@supabase/supabase-js@2`, which is the same API surface.

#### 5.2 Primary mechanism
In GoTrue, an admin password update goes through `User.UpdatePassword(tx, nil)`. With a nil session id, that calls `Logout(tx, userID)` and deletes every `auth.sessions` row (and with them the refresh tokens) for the user. `manage-store-user` therefore needs **no extra call**: step 6 of §4.3 is the revocation.

This is GoTrue server behaviour that can't be read on disk, so it is **not assumed**. It is a blocking smoke assertion (§10, arm S-REV):
- sign in as the created user and capture `refresh_token`
- run set_password
- `POST /auth/v1/token?grant_type=refresh_token` must return 400
- `select count(*) from auth.sessions where user_id = '<id>'` (docker psql) must be 0

#### 5.3 Inherent limit, and the UI copy
An already-issued access token stays valid for PostgREST until it expires (`jwt_expiry = 3600`, `config.toml:171`). PostgREST checks only the signature, not the sessions table. A device that is open right now loses access at its next refresh, within one hour at most.

SET PASSWORD sheet note (exact copy): **"Signs @<username> out on every device. A device that's open right now may keep working for up to an hour."**

#### 5.4 Contingency (build ONLY if S-REV fails locally)
- Migration `supabase/migrations/20261018000000_revoke_user_sessions.sql` adds `public.revoke_user_sessions(p_user_id uuid) returns integer`:
  - `language plpgsql`, `security definer`, `set search_path = ''`, owner postgres
  - body: `delete from auth.sessions where user_id = p_user_id` (refresh tokens cascade on `session_id`), plus `delete from auth.refresh_tokens where user_id = p_user_id::text` for any session-less legacy tokens; returns the session row count
  - grants: `revoke all … from public, anon, authenticated; grant execute … to service_role`
- `manage-store-user` calls it through RPC immediately after a successful `updateUserById`. On error it still returns 200, plus `console.error` of the code. The password change is the primary outcome.
- pgTAP plan, `supabase/tests/revoke_user_sessions.test.sql`:
  - (1) `has_function_privilege` is false for `anon` and `authenticated`, true for `service_role`
  - (2) `prosecdef = true`
  - (3) `proconfig` contains `search_path=""`
  - (4) seed sessions and refresh tokens for two users; the call deletes only the target's; the return value equals the deleted count
  - (5) unknown uuid returns 0
- Prod apply via MCP, with the version row and normalized-md5 per the runbook.
- Risk: on hosted Supabase the `auth` schema is owned by `supabase_auth_admin`. `postgres` keeps SELECT (spec 163 relies on it), but DELETE on `auth.sessions` must be confirmed in the same local run. If it is denied, the fallback becomes "UI note says sessions are not revoked", and that goes back to the owner.

### 6. Outbound email audit (section E)

| Function | Recipient source | Can it reach a placeholder? | Change |
|---|---|---|---|
| `eod-reminder-cron` | `user_stores` members plus admin/master, through `lookupEmail` → `auth.admin.getUserById` (`index.ts:178-210`) | **Yes** | In `lookupEmail`, a placeholder address is cached and returned as `null`, so `deliverReminder` does no Resend call and `emailed=false`. Push is unchanged. Add the predicate block |
| `weekly-reminder-cron` | Same `lookupEmail` shape (`index.ts:187-213`) | **Yes** | Same change, predicate block |
| `send-welcome-email` | The caller's **own** auth email (gate at `index.ts:20-35`). A placeholder user holds that address in its session after sign-in and could invoke this itself | **Yes**, self-triggered | After the gate and before Resend: placeholder returns 200 `{ success: true, skipped: "placeholder" }`. Predicate block |
| `send-order-failure-email` | super_admin plus same-brand admin/master profiles only (`index.ts:121-139`) | **No.** Placeholder accounts are hard-coded `role='user'`, and no client path promotes `user` → admin (the only role-change RPC is demote, spec 050) | None. A future promotion spec must add the skip here |
| `send-po-email` | `vendors` contact email (`index.ts:186`), never an account | No | None |
| `send-invite-email` | An address the admin types into the invite drawer | No *account* lookup. A placeholder address is never displayed or returned by this feature, and the function already accepts any admin-typed address, so placeholders add no new capability | None |

GoTrue's own mailer is outside our code, so these are rollout checks:
- **(a) Prod dashboard:** Auth → Emails → security notifications ("Password changed", "Email changed") must be **off**. The owner confirms before deploy. If they are on, an admin set-password makes GoTrue attempt mail to `.invalid`. They are off locally (`config.toml:268` is commented out).
- **(b) Public recovery:** anyone with the anon key can call `POST /auth/v1/recover` with a placeholder address (learnable from `username-resolve`). The backend-developer runs this once locally and records whether the mail catcher receives a message. If it does, file a follow-up for a GoTrue Send-Email hook that drops `.invalid`. It is rate-limited by `email_sent`, it is the same class as recovery for any address, and it is out of scope here.

### 7. `src/lib` surface (client)

**Types** (`src/types/index.ts`):
- `User.loginKind?: 'email' | 'username'`. It is optional so the existing fixtures compile; readers treat `undefined` as `'email'`.
- `BrandCascadePreview.blockingProfiles[].loginKind: 'email' | 'username'` (db.ts interface).

**New pure module** `src/lib/placeholderEmail.ts`: `export function isPlaceholderEmail(email: unknown): boolean` and `export const PLACEHOLDER_EMAIL_RE: RegExp`. Contract in §3.2.

**Data-layer clearing.** The same rule applies at three mappers:
- `fetchAllUsers` (`src/lib/auth.ts:639-663`) and `fetchBrandAdmins` active rows (`src/lib/db.ts:5503-5525`):
  `const rpcEmail = rpcEmails.get(p.id); const usernameLogin = isPlaceholderEmail(rpcEmail);`, then `email: usernameLogin ? '' : (rpcEmail || fallback?.email || '')` and `loginKind: usernameLogin ? 'username' : 'email'`.
  The invitation fallback is **skipped** for placeholder rows. Otherwise the name-match path (`invByName`) could attach an unrelated invitation's email to "Marcus Lee" and re-enable RESET PW against a stranger's inbox.
- `fetchBrandAdmins` pending rows: `loginKind: 'email'`. `activeEmails` (`db.ts:5543`) already filters `''`, so placeholders never enter it. Add a jest case for this.
- `mapCascadePreview` (`db.ts:5266-5272`): `email: isPlaceholderEmail(bp.email) ? null : (bp.email ?? null)` and `loginKind` likewise. `fetchBrandDeletionLog`'s `cascadePayload` goes through the same mapper.
- `fetchProfileEmails` (`db.ts:247`) is **unchanged** (raw map, single RPC call site). `fetchProfile` is unchanged: it already emits `email: ''` because profiles has no email column.
- Degraded mode: if `get_profile_emails` fails, `loginKind` falls back to `'email'` and the pre-existing spec 163 inference applies. That's acceptable because placeholder rows have no `profile_id`-linked invitation. The name-match risk is pre-existing and noted in §11.

**Display helper** `src/utils/userIdentity.ts` (new, node-env jest). It stops screens hand-rolling the rule:
- `isUsernameLogin(u: Pick<User,'loginKind'>): boolean`
- `userConfirmText(u: Pick<User,'loginKind'|'email'|'username'|'name'>): string`. Username accounts get `username || name || ''`; email accounts get `email || name || ''`. Used for **every** delete-confirm `requiredText`: UsersSection `:271`, PhoneUsers `:297`, BrandsSection `:1057`. Use it in titles and descriptions too: never interpolate `email` when `isUsernameLogin`.

**Wrappers** in `src/lib/auth.ts`, next to `deleteUser`. They go through `callEdgeFunction`, with no raw fetch and no `functions.invoke` (string errors are enough, because the table in §4.6 is stable):
- `export const STORE_USER_PASSWORD_MIN_LENGTH = 8;`
- `export interface CreateStoreUserInput { name: string; username: string; password: string; storeIds: string[] }`
- `export async function createStoreUser(input: CreateStoreUserInput): Promise<{ data: { id: string; username: string } | null; error: string | null }>`. Body: `{ action: 'create', name: trim, username: trim+lowercase, password: verbatim, storeIds: deduped }`.
- `export async function setStoreUserPassword(userId: string, password: string): Promise<{ error: string | null }>`. Body: `{ action: 'set_password', userId, password }`.
- Neither wrapper logs. Neither puts `password` into any returned string.
- Client mapping lives in the drawer and modal, not the wrapper:
  - `error === 'username taken'` → `Username "<u>" is already taken`
  - `error.startsWith('forbidden')` → "You don't have permission to manage users in this brand."
  - anything else → the server string

### 8. Frontend store impact
- **None in `src/store/useStore.ts`.** Users & access already holds the users list in local component state and refetches after its own actions (`UsersSection.tsx:42-61`). The new drawer and modal follow `InviteUserDrawer`: call the wrapper, `Toast.show` directly, then `onCreated()` → `refresh()`.
- No optimistic-then-revert: creation is server-authoritative and nothing is shown before it succeeds. `notifyBackendError` is not used, which matches the invite drawer's precedent.
- The password lives only in drawer/modal `useState`. It is reset to `''` on close, on success, and on unmount. It is never placed in Zustand, AsyncStorage/localStorage, a log, or a toast.
- New UI files: `src/components/cmd/AddStoreUserDrawer.tsx` (sibling of `InviteUserDrawer`, built on `ResponsiveSheet`, with the same Esc and Cmd+S / Cmd+Enter `handleSaveRef` idiom, the spec 068 brand filter, and the stale-selection prune) and `src/components/cmd/SetStoreUserPasswordModal.tsx`.
- Host state lives in `UsersSection` (`addOpen`, `setPasswordTarget`) and is lifted into the `PhoneUsersModel` the same way as `inviteOpen` (`PhoneUsers.tsx:81-92`), so the phone guard-after-hooks shape is preserved.
- SET PASSWORD visibility is `canResetPassword && isUsernameLogin(u)`. RESET PW visibility is `canResetPassword && !isUsernameLogin(u)`. `handleSendReset` also returns early for username accounts, as defense-in-depth.

### 9. Realtime impact
- None. There is no publication change, so the `docker restart supabase_realtime_imr-inventory` step does **not** apply to this spec.
- The new rows replay on whatever already carries `profiles`/`user_stores`. Users & access refetches on mount and after its own actions (out-of-scope item preserved).

### 10. Tests

**Shell smoke** `scripts/smoke-store-user.sh` (owned by backend-developer), in the `smoke-edge-roles.sh` style with `pass`/`fail`/`skip` and an EXIT trap:
- Fixtures: `admin@local.test` (brand A admin bearer) and `manager@local.test` (`role='user'` with a real email; used as the user-role bearer and as the real-email set-password target). A foreign brand B plus one store are created through docker psql and dropped in the trap. Every created `zz_s165_*` user is deleted in the trap.
- Arms:
  1. No bearer → 401
  2. `user` bearer → 403
  3. Cross-brand store → 403 `forbidden: target is in a different brand`
  4. `storeIds: []` → 400
  5. Brand A + brand B stores → 400 `stores must belong to one brand`
  6. Username `"A!"` → 400
  7. Reserved `admin` → 400
  8. Short password → 400
  9. Happy path → 201 `{id, username}`. Then assert `profiles.role='user'`, `brand_id` = A, one `user_stores` row per store, `raw_app_meta_data->>'role'='user'`, `email_confirmed_at` set, and an email matching the regex
  10. `role:"admin"` in the body → still `role='user'`
  11. Duplicate username → 409 `username taken`
  12. `username-resolve` + `grant_type=password` sign-in → 200
  13. Set-password on self → 400 `cannot set password for self`
  14. Set-password on the admin target → 403
  15. Set-password on `manager@local.test` → 400 `account has an email; use password reset`
  16. **S-REV** (§5.2, blocking)
  17. Happy set-password → 200; old password → 400; new password → 200
  18. Every captured response body is grepped: it must contain neither the literal password nor `no-email.invalid`
  19. Mail catcher shows zero messages for the created address
- Compensation is proven by arm 11: after the 409 there is no `auth.users` row with a fresh placeholder and no profile. Assert `count(*)` of placeholder-shaped `auth.users` is unchanged before and after.

**pgTAP:** no new suite (no SQL), unless §5.4 is triggered. The existing `profiles_insert_hardening`, `permissive_policy_lint`, and `user_stores_brand_match_*` suites must pass unchanged.

**jest:**
- Backend-owned:
  - `src/lib/placeholderEmail.test.ts`. Positive: generator-shape, mixed case, surrounding whitespace. Negative: `''`, `null`, real emails, `x@no-email.invalid`, 31/33 hex, uppercase domain variants that aren't the shape, `@local.test`.
  - `src/lib/placeholderEmail.parity.test.ts`. Uses `fs.readFileSync` (precedent: `src/lib/guide.i18n.test.ts:188`). Extracts the marker block from the TS file and from each of the four Deno files and asserts byte equality. Does the same for the `reserved-usernames` block in `usernameValidation.ts` and `manage-store-user/index.ts`.
- Frontend-owned: everything else listed in spec §J, including updates (not deletions) to `src/lib/auth.fetchAllUsers.test.ts`, `src/lib/db.fetchBrandAdmins.test.ts`, `src/components/cmd/InviteUserDrawer.test.tsx`, `src/screens/cmd/sections/__tests__/UsersSection.identityLine.spec163.test.tsx`, and `src/screens/cmd/sections/phone/__tests__/PhoneUsers*.test.tsx`.
- Add a `fetchAllUsers` case: a placeholder row whose `name` matches an unrelated invitation → `email: ''`, `loginKind: 'username'`.

**e2e (optional):** `e2e/add-user.spec.ts`, a sibling of `e2e/invite.spec.ts`.

### 11. Risks and tradeoffs
1. **GoTrue behaviour is verified, not read.** Two things are GoTrue-internal: `.invalid` acceptance (§3.3) and session revocation on admin password update (§5.2). Both are gated by smoke arms that must pass before READY_FOR_REVIEW. Contingency for revocation is in §5.4. The prod `.invalid` check is the rollout probe.
2. **Non-atomic create.** There are three side effects across two systems. Compensation is one cascade delete. The residual orphan is auth-only and harmless (§4.4).
3. **Placeholder exposure through `username-resolve`.** By the spec 095 design, the placeholder is returned to any holder of the bundle token, at 20 requests/min/IP. It grants nothing. The password is still required, and the address is random (no id leak).
4. **Self-converted accounts.** With email autoconfirm, a real-email `user` could change their own email to a placeholder-shaped address through `updateUser`. That account then becomes eligible for admin set-password. The harm is self-inflicted: the user gave up their own inbox, and an admin cannot change someone else's email through any path in this spec. Accepted.
5. **Name-match inference.** The pre-existing spec 163 fallback can mislabel emails when `get_profile_emails` fails. This design removes the risk for placeholder rows only when the RPC succeeds. It is not regressed. Noted for a future cleanup.
6. **Five identical predicate copies.** Drift is enforced by the parity jest, which is stronger than review-only escapeHtml.
7. **Cold start.** One function serves both actions, so the rare set-password path shares warmth with create. Create makes about 6 serial round trips, with the three pre-check reads parallelized. That is about 1 s warm, plus the esm.sh import on a cold start, the same as `delete-user`. The 286 KB seed is irrelevant: every query is a PK or unique-index lookup.
8. **Migration ordering.** None, so the `db-migrations-applied` gate is unaffected. **Deploy ordering for rollout K:**
   - (1) owner confirms the GoTrue security notifications are off
   - (2) `supabase functions deploy eod-reminder-cron weekly-reminder-cron send-welcome-email`
   - (3) `supabase functions deploy manage-store-user` (the config.toml pin carries `verify_jwt = true`)
   - (4) push `main` (Vercel web)
   - (5) prod probe (§3.3)
   - (6) check `test.yml`, `db-migrations-applied.yml`, and manually `e2e.yml`
   
   Functions must land before the web push, or "+ ADD USER" returns `HTTP 404`.
9. **Local edge-runtime bind mount.** The new function directory is served only if the runtime's mount points at the repo root. Run the CLAUDE.md `docker inspect … | grep functions` check before debugging a 503 `BOOT_ERROR`.
10. **The `app.json` slug** is not touched and is not implicated.

### 12. File ownership (parallel build is safe)

The contract (§4.6 strings, §7 signatures, §3.2 regex) is fixed, so the two developers don't block each other. Frontend jest mocks `callEdgeFunction`. Only the final browser verification (spec §J) needs both halves.

- **backend-developer:**
  - `supabase/functions/manage-store-user/index.ts` (new)
  - `supabase/config.toml` (new `[functions.manage-store-user]` block)
  - `supabase/functions/eod-reminder-cron/index.ts`
  - `supabase/functions/weekly-reminder-cron/index.ts`
  - `supabase/functions/send-welcome-email/index.ts`
  - `src/lib/placeholderEmail.ts` (new)
  - `src/lib/placeholderEmail.test.ts` (new)
  - `src/lib/placeholderEmail.parity.test.ts` (new)
  - `src/lib/usernameValidation.ts` (marker comments only)
  - `scripts/smoke-store-user.sh` (new)
  - Contingency only: `supabase/migrations/20261018000000_revoke_user_sessions.sql` + `supabase/tests/revoke_user_sessions.test.sql`
- **frontend-developer:**
  - `src/types/index.ts`
  - `src/lib/auth.ts` (wrappers + `fetchAllUsers`)
  - `src/lib/db.ts` (`fetchBrandAdmins`, `mapCascadePreview`, `BrandCascadePreview`)
  - `src/utils/userIdentity.ts` (new) + test
  - `src/components/cmd/AddStoreUserDrawer.tsx` (new) + test
  - `src/components/cmd/SetStoreUserPasswordModal.tsx` (new) + test
  - `src/screens/cmd/sections/UsersSection.tsx`
  - `src/screens/cmd/sections/phone/PhoneUsers.tsx`
  - `src/screens/cmd/sections/BrandsSection.tsx`
  - `src/components/cmd/CascadePreviewModal.tsx`
  - `src/i18n/en.json`, `es.json`, `zh-CN.json`
  - the existing tests listed in §10
  - optional `e2e/add-user.spec.ts`
- Shared touchpoint: frontend imports `isPlaceholderEmail` from `src/lib/placeholderEmail.ts`. If frontend gets there first, it codes against the §3.2 signature and does not create the file. Backend owns it.

## Files changed

### Backend (backend-developer, 2026-10-18) — complete

Backend half done and verified locally. `Status:` is left at `READY_FOR_BUILD` because the parallel frontend half was still in progress when this list was written; the frontend-developer flips it to `READY_FOR_REVIEW` when they append their list.

**Edge functions**
- `supabase/functions/manage-store-user/index.ts` (new): `create` / `set_password` per §4
- `supabase/functions/eod-reminder-cron/index.ts`: placeholder-email block; `lookupEmail` returns `null` for placeholders (§6)
- `supabase/functions/weekly-reminder-cron/index.ts`: same change (§6)
- `supabase/functions/send-welcome-email/index.ts`: placeholder-email block; after the gate, returns 200 `{ success: true, skipped: "placeholder" }` (§6)

**Config**
- `supabase/config.toml`: `[functions.manage-store-user] verify_jwt = true`, with a comment block

**src/lib**
- `src/lib/placeholderEmail.ts` (new): canonical §3.2 predicate
- `src/lib/usernameValidation.ts`: `reserved-usernames` marker comments only (§3.4); behaviour unchanged

**Tests**
- `src/lib/placeholderEmail.test.ts` (new): positive and negative predicate cases
- `src/lib/placeholderEmail.parity.test.ts` (new): byte-parity of the placeholder block (TS plus four Deno copies) and of the reserved-usernames block; also a lint that fails if shipped `src/**` other than the predicate module mentions `no-email.invalid`
- `scripts/smoke-store-user.sh` (new): §10 arms 1-19, plus arm C (compensation, forced through a temporary local trigger)

**Not built:** the §5.4 contingency (migration `20261018000000_revoke_user_sessions.sql` and its pgTAP suite). S-REV passed locally, so no migration and no SQL.

**Backend verification notes**
- §3.3 local GoTrue check: `POST /auth/v1/admin/users` with `u-<32hex>@no-email.invalid` and `email_confirm:true` returned 200, with the email stored lowercase and `email_confirmed_at` set. Password grant returned 200. Mailpit had 0 messages for the address. Admin DELETE returned 200.
- Smoke `scripts/smoke-store-user.sh`: all arms PASS, one SKIP. The SKIP is arm 12's `username-resolve` step: the local edge runtime has no `USERNAME_RESOLVE_SERVICE_TOKEN`, so it returns HTTP 500. This was recorded and not worked around. The password sign-in half of arm 12 passes against the email read from `auth.users`.
- **S-REV PASSED.** With 2 live sessions, `set_password` led to both pre-change refresh tokens returning 400, `auth.sessions` count dropping to 0, the old password returning 400, and the new one 200. GoTrue's admin password update revokes sessions, so the §5.3 UI copy stands.
- §6(b) public recovery: `POST /auth/v1/recover` with a placeholder address returns 200, and **local GoTrue does send a "Reset your password" mail to it** (Mailpit caught it). Per §6(b), this needs a follow-up spec for a GoTrue Send-Email hook that drops `.invalid` recipients. It is out of scope here.
- `send-welcome-email` placeholder skip verified live: a signed-in placeholder user calling it with its own address gets 200 `{ success: true, skipped: "placeholder" }`.
- Edge-runtime logs from the smoke window contain neither password nor `no-email.invalid`.

### Frontend (frontend-developer, 2026-10-18) — complete

**Types / data layer**
- `src/types/index.ts`: optional `User.loginKind?: 'email' | 'username'` (§7)
- `src/lib/auth.ts`: `fetchAllUsers` clears placeholder emails, sets `loginKind`, and skips invitation inference for placeholder rows; new `STORE_USER_PASSWORD_MIN_LENGTH`, `CreateStoreUserInput`, `createStoreUser`, `setStoreUserPassword` (through `callEdgeFunction`, no logging)
- `src/lib/db.ts`: `fetchBrandAdmins` active rows get the same clearing + `loginKind`, pending rows get `loginKind: 'email'`; `BrandCascadePreview.blockingProfiles[].loginKind`; `mapCascadePreview` nulls placeholder emails

**Display helper**
- `src/utils/userIdentity.ts` (new): `isUsernameLogin`, `userConfirmText`, plus `storeUserErrorText` (the §7 error mapping, shared by the drawer and modal)

**UI**
- `src/components/cmd/AddStoreUserDrawer.tsx` (new): "+ ADD USER" drawer (§F)
- `src/components/cmd/SetStoreUserPasswordModal.tsx` (new): SET PASSWORD modal with the §5.3 copy (§G)
- `src/screens/cmd/sections/UsersSection.tsx`: `users-add-trigger`, hero + empty-state copy, username-only identity line + "username sign-in" marker, SET PASSWORD replaces RESET PW, `handleSendReset` early return, `userConfirmText` in the delete confirm, phone model wiring
- `src/screens/cmd/sections/phone/PhoneUsers.tsx`: `phone-users-add` beside INVITE, `@username · username sign-in` in row meta / detail subtitle / name fallback, `phone-user-set-password`, `userConfirmText` in the delete confirm; model gains `addOpen` / `setAddOpen` / `setPasswordTarget` / `setSetPasswordTarget` (guard-after-hooks unchanged)
- `src/screens/cmd/sections/BrandsSection.tsx`: members-tab identity line + delete-profile modal use `@username` / marker / `userConfirmText`; `MembersTab` and `DeleteProfileModal` exported for jest (StoresTab precedent)
- `src/components/cmd/CascadePreviewModal.tsx`: shows "username sign-in" instead of an email for `loginKind: 'username'`
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`: `section.users.addUser`, `section.users.phone.add` / `setPw` / `usernameSignIn`; `section.users.phone.empty` mentions adding

**Tests**
- `src/utils/userIdentity.test.ts` (new)
- `src/lib/auth.storeUser.test.ts` (new): wrapper body / envelope / error mapping; password absent from every console call and toast
- `src/lib/auth.fetchAllUsers.test.ts`: spec 165 cases (placeholder + unrelated name-match invitation → `email: ''`, `loginKind: 'username'`)
- `src/lib/db.fetchBrandAdmins.test.ts`: spec 165 cases (clearing, pending `loginKind`, `activeEmails` ignores placeholders) + `previewBrandCascade` mapper
- `src/components/cmd/AddStoreUserDrawer.test.tsx` (new), `src/components/cmd/SetStoreUserPasswordModal.test.tsx` (new)
- `src/screens/cmd/sections/__tests__/UsersSection.storeUser.spec165.test.tsx` (new), `src/screens/cmd/sections/__tests__/BrandsSection.members.spec165.test.tsx` (new)
- `src/screens/cmd/sections/__tests__/UsersSection.identityLine.spec163.test.tsx`, `src/screens/cmd/sections/phone/__tests__/PhoneUsers.acReg.test.tsx`: auth mocks gain the new wrappers
- `src/screens/cmd/sections/phone/__tests__/PhoneUsers.test.tsx`: model gains the new fields; spec 165 phone cases
- `e2e/add-user.spec.ts` (new): master adds a user, sets its password, deletes it. Username sign-in is deliberately not in the e2e (e2e.yml has no `USERNAME_RESOLVE_SERVICE_TOKEN`); see the file header

**Frontend verification notes**
- `npx jest` (228 suites / 2633 tests at the time of the run), `npm run typecheck`, `npm run typecheck:test`, `tsc -p e2e/tsconfig.json` all pass. `npx playwright test e2e/add-user.spec.ts` and `e2e/invite.spec.ts` pass locally.
- Browser (headless Chromium via the repo's Playwright against `expo start --web` + the local stack, as `master@local.test` — Users & access is master-gated, so `admin@local.test` has no entry point): drawer validation, lowercase username, reserved/format errors, SHOW toggle, create → row with `@username` + marker + SET PASSWORD and no RESET PW, duplicate → `Username "…" is already taken` with the drawer kept open, password empty on reopen, SET PASSWORD → toast, old password refused / new accepted, delete by username → 0 auth/profile/user_stores rows. Function responses never carried the password or the placeholder. Phone width (390×844) repeated create / detail / SET PASSWORD / delete. Dark mode checked on the drawer.
- Not verified in the browser: username sign-in (same local `USERNAME_RESOLVE_SERVICE_TOKEN` gap as smoke arm 12; the staff landing was verified by signing in with the account's auth email instead), and the Brands members tab / cascade preview (super_admin only; there is no local super_admin). Both are covered by jest.


### Pre-commit fixes, backend (backend-developer, 2026-10-18; release-proposal (a)1, (a)3 and (a)4 server items)

- `supabase/functions/manage-store-user/index.ts`:
  - `handleCreate` steps 8-9 now sit inside a `try`. A thrown exception runs `compensateOnce()` (at most once per request) and then returns 500 `could not create account`. The returned-error branches are unchanged.
  - `set_password` refuses with 403 `forbidden: target is not a store user` when the target's auth `app_metadata.role` is set and is not `user` (security L3).
  - `isWeakPasswordError` treats `user_already_exists` like `email_exists` (architect M2(a)).
- `src/lib/usernameValidation.ts`: corrected the stale "ONLY in the admin assignment UI" docblock (architect M9). The marker block is unchanged.
- `scripts/smoke-store-user.sh`: new arm 14b covers the L3 refusal and checks that the password hash is unchanged.
- `package.json`: `test:smoke` now also runs `bash scripts/smoke-store-user.sh`.
- `tests/README.md`: the Track 3 TL;DR and the smoke list now include `smoke-store-user.sh`.
- Throw-path compensation was proven once with a temporary, reverted local edit (not shipped). A forced `throw` after a successful profile insert returned 500, left 0 placeholder auth users, 0 profiles and 0 orphan `user_stores` rows, and logged only the error class name.

### Pre-commit fixes, frontend (frontend-developer, 2026-10-18; release-proposal (a)2, (a)4 UI items, and the optional PasswordField extraction)

The owner kept the email-first Brands delete-confirm, so `userConfirmText` is unchanged everywhere.

- **(a)2, i18n marker.** The key moved from `section.users.phone.usernameSignIn` to the shared `section.users.usernameSignIn` in `src/i18n/en.json`, `src/i18n/es.json` and `src/i18n/zh-CN.json`. It was new in this spec, so nothing else referenced it. The hard-coded English `'username sign-in'` is gone from these places:
  - `src/screens/cmd/sections/UsersSection.tsx` (marker pill)
  - `src/screens/cmd/sections/BrandsSection.tsx` (members identity line, and the `DeleteProfileModal` description, which now calls `useT`)
  - `src/components/cmd/CascadePreviewModal.tsx` (now calls `useT`, and goes through `isUsernameLogin` via the helper)
- **Shared helper.** `src/utils/userIdentity.ts` gained `userIdentityLine(u, marker, { emailFallback, separator })`. Username accounts get `@username · marker`, or just the marker when there is no username. Email accounts get the email, or the fallback. Callers: the Brands members line, the Brands delete description (`', '` separator), CascadePreviewModal, and PhoneUsers `identityLine`.
- **(a)4, architect M7.** `showSetPassword` now also requires `user.role === 'user'`, in `UsersSection.tsx` and `phone/PhoneUsers.tsx`.
- **(a)4, code-reviewer nit (plain-Enter).** In `src/components/cmd/SetStoreUserPasswordModal.tsx`, plain Enter now submits only through the password input's `onSubmitEditing`. The document listener keeps Esc and Cmd/Ctrl+S / Cmd/Ctrl+Enter.
  - Root cause: react-native-web's TextInput calls `stopPropagation()` on every keydown. So the old document-level plain-Enter never fired from inside the field. It fired only when focus was elsewhere, such as on CANCEL.
- **Optional (a), shared password field.** `src/components/cmd/StoreUserPasswordField.tsx` (new) holds the secure input, the SHOW/HIDE toggle and the length error, with an optional hint.
  - It is stateless: the value and the show flag stay in the host's `useState`, so the existing reset-on-open/close is unchanged.
  - testIDs are explicit props, so the existing `add-user-password*` and `set-password-*` IDs are unchanged.
  - Used by `src/components/cmd/AddStoreUserDrawer.tsx` and `SetStoreUserPasswordModal.tsx`.
- **Tests:**
  - `src/utils/userIdentity.test.ts`: `userIdentityLine` cases.
  - `src/components/cmd/SetStoreUserPasswordModal.test.tsx`: a keyboard-submit block. It checks that a document Enter does not submit, that the input's submitEditing does submit, that a short password with submitEditing does not submit, and that Cmd+Enter does submit.
  - `src/screens/cmd/sections/__tests__/UsersSection.storeUser.spec165.test.tsx`: the marker is rendered through i18n, and M7 (no SET PASSWORD for a username-only `admin` row).
  - `src/screens/cmd/sections/phone/__tests__/PhoneUsers.test.tsx`: M7 on the phone tier.
  - `src/screens/cmd/sections/__tests__/BrandsSection.members.spec165.test.tsx`: under its key-returning `useT` mock, it now asserts `section.users.usernameSignIn` instead of the English literal.
- **Verification:**
  - `npx jest`: 229 suites, 2648 tests, all pass. `npm run typecheck` and `npm run typecheck:test` both pass.
  - Browser: headless Chromium against `expo start --web` and the local stack, as `master@local.test`. The fixtures were two temporary placeholder-email accounts, one `role='user'` and one `role='admin'`, deleted afterwards.
  - The marker reads "username sign-in" in en, "acceso con usuario" in es and "用户名登录" in zh-CN, on the desktop row and the phone row.
  - SET PASSWORD shows only on the username-only `user` row. It does not show on the username-only `admin` row or on the email row (which still has RESET PW).
  - Enter on a focused CANCEL closes the modal without calling `manage-store-user`. Enter in the password field calls it once and closes.
  - SHOW/HIDE works. No console errors.
  - The Brands tab and the cascade preview need a super_admin, and none exists locally, so they are covered by jest only.

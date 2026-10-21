# Spec 166: Supabase Auth Send-Email hook that drops mail to placeholder addresses

Status: READY_FOR_REVIEW

Follow-up to spec 165 ([specs/165-admin-create-user-without-email.md](165-admin-create-user-without-email.md), commit `afe181e`, not yet deployed). Closes security-auditor finding **M1** and low finding **L1** from [specs/165-admin-create-user-without-email/reviews/security-auditor.md](165-admin-create-user-without-email/reviews/security-auditor.md).

## User stories
- As the brand owner, I want GoTrue to never send an email to a username-only store user's placeholder address (`u-<32hex>@no-email.invalid`), so that anyone with the public anon key can't use `POST /auth/v1/recover` to make prod send guaranteed hard bounces that burn the shared email quota and damage sender reputation.
- As a manager with a real email, I want password-reset emails (and every other auth email the app relies on) to keep arriving, with a working link, after this change.

Concrete scenario: an attacker types `marcus.l` into `username-resolve` and gets `u-3f2a…9c@no-email.invalid`. They call `POST /auth/v1/recover` with that address 20 times a minute. Today each call makes GoTrue send a "Reset your password" mail that hard-bounces; this was reproduced locally, and Mailpit caught it. After this spec, each call still returns HTTP 200, but no mail leaves the system. When the Towson manager clicks "forgot password" on her own `manager@…` address, she still gets exactly one reset email, and its `token_hash` link signs her into the reset screen.

## Background (verified 2026-10-19)
- **Placeholder shape and predicate.** These are spec 165 §3.1-3.2. The regex is `/^u-[0-9a-f]{32}@no-email\.invalid$/`, tested against the trimmed, lowercased address. Five copies of the inline-not-shared `// BEGIN placeholder-email (spec 165)` / `// END …` block exist today. They are kept byte-identical by [src/lib/placeholderEmail.parity.test.ts](../src/lib/placeholderEmail.parity.test.ts) (the `COPIES` array).
- **Spec 165 §6(b) result.** Local `POST /auth/v1/recover` to a placeholder returns 200, and GoTrue sends the mail. §6(a) (password-changed / email-changed notifications) was a manual owner check for prod. Locally these notifications are off (`supabase/config.toml:267-271`, commented out).
- **Send Email hook facts.** Source: the research note, verified against the Supabase docs on 2026-10-19 and treated as data.
  - Enabling the hook **replaces GoTrue's SMTP entirely**, and GoTrue stops rendering templates. The hook receives `{ user, email_data }`. `email_data` includes `token`, `token_hash`, `redirect_to`, `email_action_type`, `site_url`, `token_new`, `token_hash_new`, and `old_email`.
  - The hook must build the subject, the body and every link itself. **A filter-only hook is impossible:** any non-placeholder mail the hook doesn't deliver is lost.
  - `email_action_type` values: `signup`, `invite`, `magiclink`, `recovery`, `email_change`, `email`, `reauthentication`, `password_changed_notification`, `email_changed_notification`, `phone_changed_notification`, `identity_linked_notification`, `identity_unlinked_notification`, `mfa_factor_enrolled_notification`, `mfa_factor_unenrolled_notification`.
  - `email_change` with secure change on sends two mails, and the hash fields are "swapped": `token_hash_new` goes with the **current** `user.email` + `token`, and `token_hash` goes with `user.new_email` + `token_new`.
  - A 200 response with an empty body counts as success.
  - An HTTP hook is an edge function deployed without JWT verification. It verifies a Standard Webhooks signature, with secret format `v1,whsec_<base64>`; `standardwebhooks@1.0.0` is available from esm.sh.
  - Local config uses `[auth.hook.send_email]` with `uri = "http://host.docker.internal:54321/functions/v1/<fn>"` and `secrets = "env(…)"`.
  - Prod config: Dashboard → Authentication → Hooks → Send Email → HTTPS → Generate Secret.
- **Auth mail the app triggers today.**
  - **Recovery:** `sendPasswordReset` → `resetPasswordForEmail(email, { redirectTo: resolveRecoveryRedirectUrl() })` ([src/lib/auth.ts:756](../src/lib/auth.ts)). Prod uses a dashboard-edited spec 085 template with a `token_hash` link: `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`. The local mirror is [supabase/templates/recovery.html](../supabase/templates/recovery.html), subject "Reset your password". The client redeems it with `verifyOtp({ token_hash, type: 'recovery' })` ([src/lib/recoveryRedirect.ts](../src/lib/recoveryRedirect.ts)).
  - **Signup confirmation:** `registerInvitedUser` → `auth.signUp` ([src/lib/auth.ts:509](../src/lib/auth.ts)). A mail is sent only if prod has "Confirm email" on. Inference, not proof: the very next call, `register_invited_profile`, needs the fresh signUp session, so invited registration would already be broken if prod had Confirm email on. Locally `enable_confirmations = false`.
  - **Invite:** [send-invite-email](../supabase/functions/send-invite-email/index.ts) uses GoTrue `inviteUserByEmail(email, { redirectTo: "<APP_URL>?register=true" })` only as a fallback, when `RESEND_API_KEY` is unset (`index.ts:94-99`).
  - **Notifications** (password changed, email changed, and others): sent only if prod has them on.
  - **Public unauthenticated endpoints** that can trigger mail: `/recover`, `/otp` (magic link, if allowed), and `/resend`.
- **Every Resend call in the repo** uses `from: "I.M.R Inventory <onboarding@resend.dev>"`, Resend's shared test sender (`send-invite-email`, `send-welcome-email`, `send-po-email`, `send-order-failure-email`). The crons read `RESEND_FROM_ADDRESS`.
- **Prod SMTP is not determinable from the repo.** `[auth.email.smtp]` is commented out in [supabase/config.toml:242-250](../supabase/config.toml), prod auth logs had no mailer lines, and the Management API `GET /v1/projects/ebwnovzzkwhsdxkpyjka/config/auth` needs the owner's PAT. So it is an owner input (O1).
- **CI boots the local stack from `config.toml`.** `test.yml` runs `supabase start` on CLI 2.106.0 (`.github/workflows/test.yml:173,178`), and `e2e.yml` runs `supabase start` on CLI `latest` (`.github/workflows/e2e.yml:63,66`). Any `[auth.hook.send_email]` block therefore boots in CI too.
- **Local edge secrets.** `supabase/functions/.env.local` is not loaded by `supabase start`. Spec 165 recorded that `USERNAME_RESOLVE_SERVICE_TOKEN` was missing from the local runtime for this reason. `[edge_runtime.secrets]` exists but is commented out (`config.toml:401-402`).

## Acceptance criteria

### A. Hook function: contract and safety
- [ ] A new edge function exists under `supabase/functions/`. The working name is `send-email-hook`; the architect may rename it. GoTrue calls it as the Send Email hook.
- [ ] `[functions.<fn>]` in [supabase/config.toml](../supabase/config.toml) pins `verify_jwt = false` explicitly. It has a comment block in the established style (see `submission-push-fanout` / `send-order-failure-email`) that says three things:
  - GoTrue calls it with a Standard Webhooks signature, not a JWT
  - the signature check replaces the gateway JWT check
  - it is event-driven, not a user-invoked privileged op, so it has **no** `ADMIN_ROLES` gate
- [ ] **Signature verification is mandatory and fails closed.** The signature is checked against `SEND_EMAIL_HOOK_SECRET` (the name is the architect's call) before any parsing side effect or send:
  - a missing or invalid signature returns HTTP 401 and sends nothing
  - if the secret env var is unset or malformed, the hook returns a non-2xx response and sends nothing
- [ ] Only `POST` is accepted. Other methods return 405. A signed but malformed payload (no `user`, no `email_data`, no `email_action_type`) returns 400 and sends nothing.
- [ ] **Recipients come only from the signed payload** (`user.email`, `user.new_email`, per action type). The function has no other recipient source.
- [ ] **Placeholder drop.** The function contains the spec 165 placeholder block **byte-identically**, between the existing `// BEGIN placeholder-email (spec 165)` / `// END placeholder-email (spec 165)` markers. Each recipient is tested with `isPlaceholderEmail`:
  - a placeholder recipient is dropped: no transport call, no render
  - if every recipient of the request is dropped, the hook returns HTTP 200 with an empty JSON object (or an empty body, whichever the architect confirms GoTrue accepts)
  - if a request has one placeholder leg and one real leg (`email_change`), only the real leg is delivered and the hook returns 200
- [ ] **Anti-enumeration preserved.** `POST /auth/v1/recover` returns the same HTTP status (200) and the same response body for each of these: an existing placeholder account, an existing real-email account, and an address with no account.
- [ ] **No silent loss for real recipients.** If a non-placeholder recipient cannot be handed to the transport (transport misconfigured, provider error, network failure), the hook returns a non-2xx response. GoTrue then surfaces the failure, as it does for SMTP failures today. The hook never returns 200 for a real recipient it did not hand to the transport.
- [ ] **Log hygiene.** The function never logs any of these: the request body, `token`, `token_hash`, `token_new`, `token_hash_new`, any constructed link, any full recipient address, or provider credentials. Permitted log fields: `email_action_type`, outcome (`sent` / `dropped` / `failed`), recipient count, and a transport error status code. The top-level catch returns a generic error string without `e.message` (spec 165 §4.5 precedent).
- [ ] **HTML escaping.** Every value interpolated into an HTML body goes through an inline `escapeHtml()` (CLAUDE.md rule, five-character escape, reference [send-invite-email/index.ts:42-45](../supabase/functions/send-invite-email/index.ts)). This covers links, tokens, `site_url`, `redirect_to`, user names, and addresses. Query-string parameters are also `encodeURIComponent`-encoded before escaping. Subjects and recipient addresses are not HTML and don't need the helper.

### B. Rendering: every non-placeholder auth email still works
- [ ] **Recovery.**
  - The link is exactly `<redirect_to>?token_hash=<token_hash>&type=recovery`. This is link-identical to the spec 085 template, and the client's `verifyOtp({ token_hash, type: 'recovery' })` flow is unchanged.
  - Subject: "Reset your password".
  - If `redirect_to` is empty, the architect confirms what GoTrue puts there (the validated redirect or `site_url`) and the hook uses only that value. The hook never builds a link to a host that didn't come from the signed payload or the function's own `SUPABASE_URL`.
- [ ] **Signup confirmation** (`signup`). It renders a confirmation link that confirms the account when clicked. The link form is the architect's call; it must be equivalent to GoTrue's default `{{ .ConfirmationURL }}` (for example `<SUPABASE_URL>/auth/v1/verify?token=<token_hash>&type=signup&redirect_to=<redirect_to>`).
- [ ] **Invite** (`invite`). It renders an accept-invite link equivalent to GoTrue's default. It must carry `send-invite-email`'s `redirectTo` (`<APP_URL>?register=true`) through, so the GoTrue-fallback invite still lands on registration.
- [ ] **Magic link** (`magiclink`) and **`email`** (OTP). A link (when a `token_hash` is present) and/or the numeric `token` code.
- [ ] **Email change** (`email_change`). Both legs follow the swapped-hash rule from Background:
  - current address: `token_hash_new` + `token`
  - new address: `token_hash` + `token_new`
  
  The single-mail (non-secure-change) case is also handled, with the architect confirming which fields GoTrue sends. Each leg is subject to the placeholder drop on its own.
- [ ] **Reauthentication** (`reauthentication`). The numeric `token` code, no link.
- [ ] **All `*_notification` types.** A generic plain notice with a type-specific subject and no link.
- [ ] **Unknown future `email_action_type`.** A generic fallback mail, with a link if `token_hash` is present and the `token` code if `token` is present. It is **never** silently dropped. The only drop rule is the placeholder predicate.
- [ ] Visual parity with the current prod templates is **not** required. Link mechanics, recipients and subjects are (PM default, user may override). Templates are plain, brand-neutral HTML ("I.M.R" / "2AM PROJECT" naming per the existing send-* functions), English only.

### C. Delivery channel (transport)
- [ ] The hook delivers through a transport chosen by configuration (env), not by a code edit. The architect designs the seam.
- [ ] **Local transport.** A local path delivers into the local Mailpit (`[inbucket]`, UI and API at `http://127.0.0.1:54324`), so the section F smoke is meaningful. Mailpit's SMTP inside the Docker network, or Mailpit's HTTP send API, are both acceptable; the architect decides and verifies reachability from the edge-runtime container.
- [ ] **Prod transport.** Supports the owner's answer to O2. PM default **(user may override):** build a Resend HTTP API transport (this matches every other mail path in the repo, and `RESEND_API_KEY` is already a prod secret), plus the local Mailpit path.
  - If the owner answers O2 = "SMTP relay to the existing provider" **before build**, build that transport instead of Resend, and do not build both.
  - If O2 is still open at build time, build Resend + local. An SMTP relay is then a contained follow-up inside this one function.
- [ ] The From address and sender name come from env (for example `SEND_EMAIL_FROM`). They are **not** hard-coded, and in particular not `onboarding@resend.dev`. If the From env is unset, real-recipient sends fail with a non-2xx (rule in section A) rather than falling back to a test sender.
- [ ] Each transport built has at least one automated proof:
  - the local path: through the section F smoke
  - the prod transport: through a smoke arm against a local stub, or a configurable API base pointed at a local echo server (architect's call), that asserts the outbound request's recipient, From, subject, and presence of the link. It never makes a real provider call in automated tests.

### D. Local config and secret
- [ ] `supabase/config.toml` has `[auth.hook.send_email]` with `enabled = true`, a `uri` pointing at the local function through `host.docker.internal:54321`, and `secrets` resolved from an env reference. The architect may choose an equivalent.
- [ ] The hook secret reaches **both** GoTrue (config) and the edge runtime (function env) under plain `npm run dev:db`, starting from a clean `npx supabase stop --no-backup`, with no manual export step.
  - The mechanism is the architect's call. Candidates: `[edge_runtime.secrets]`, `supabase/functions/.env`, a CLI-read env file.
  - A pinned, clearly local-only dev secret committed to the repo is acceptable. Precedent: the pinned dev tokens in [supabase/functions/.env.local.example](../supabase/functions/.env.local.example). It must be visibly distinct from any prod value, and the prod secret is never committed.
- [ ] **CI still boots.** `supabase start` in `test.yml` (CLI 2.106.0) and `e2e.yml` (CLI latest) succeeds with the hook block present. The local secret is in whatever format the CLI validates. `test.yml`, `db-migrations-applied.yml` and `e2e.yml` all stay green.
- [ ] A comment in `config.toml` beside `[auth.hook.send_email]` warns that the block is local-only and that the prod hook is dashboard-configured. Running `supabase config push` against prod would push a `host.docker.internal` URI and break all prod auth mail (see risks).
- [ ] The local transport config (section C) also boots with no manual step.

### E. jest
- [ ] The new function's path is added to the `COPIES` array in [src/lib/placeholderEmail.parity.test.ts](../src/lib/placeholderEmail.parity.test.ts). The block is extracted and asserted byte-identical to the canonical block, and the existing five copies keep passing.
- [ ] Full `npx jest`, `npm run typecheck` and `npm run typecheck:test` pass.

### F. Local smoke (shell)
A new `scripts/smoke-send-email-hook.sh`, in the `smoke-store-user.sh` / `smoke-edge-roles.sh` style with `pass`/`fail`/`skip` and an EXIT trap. It is added to `npm run test:smoke` and to the Track 3 list in [tests/README.md](../tests/README.md). The architect may instead fold the arms into an existing script. The arms:
- [ ] **Setup.** Clear Mailpit (`DELETE /api/v1/messages`) and create a placeholder fixture account through `manage-store-user` (admin bearer) or the admin API. The trap deletes it.
- [ ] **S1, placeholder dropped.** `POST /auth/v1/recover` with the anon key and the placeholder address returns HTTP 200. After a settle wait, the **total** Mailpit message count is 0.
- [ ] **S2, real address delivered.** `POST /auth/v1/recover` for `manager@local.test` with `redirect_to = http://localhost:8081/reset-password` returns 200. Mailpit then has **exactly 1** message, addressed to `manager@local.test`, with subject "Reset your password". Its body contains `http://localhost:8081/reset-password?token_hash=<hash>&type=recovery`.
- [ ] **S3, the link works.** The smoke extracts `<hash>` from the S2 message and calls `POST /auth/v1/verify` with `{ "type": "recovery", "token_hash": "<hash>" }`. That returns 200 with an `access_token`, which proves the rendered link redeems.
- [ ] **S4, anti-enumeration.** `/recover` status and body are identical for the placeholder, `manager@local.test`, and a non-existent address.
- [ ] **S5, signature gate.** A direct POST to the function with no signature returns 401, and one with a wrong signature returns 401. The Mailpit count is unchanged.
- [ ] **S6, signed synthetic payloads.** The smoke signs these with the local secret (Standard Webhooks HMAC through `openssl` or an equivalent):
  - `signup`, `invite` and one `*_notification` to a real address: each gives 200 and exactly one Mailpit message to that address with a type-appropriate subject
  - `email_change` with a placeholder `user.email` and a real `user.new_email`: exactly one message, to the real address
  - every type addressed to a placeholder: 0 messages
- [ ] **S7, hygiene.** No response body from the hook contains a token, a token hash, or `no-email.invalid`. The edge-runtime logs captured for the smoke window contain no `token_hash` value and no full recipient address.
- [ ] **S8, prod-transport proof** from section C, if it is implemented as a smoke arm.
- [ ] **Regression.** The existing `scripts/smoke-store-user.sh` (including arm 19, "Mailpit: 0 messages to no-email.invalid") and the other `test:smoke` scripts still pass with the hook enabled.
- [ ] Local GoTrue's `email_sent = 2`/hour and `max_frequency = "1s"` (`config.toml:205,236`) may throttle S2/S6 or repeated runs. The architect confirms whether the rate limit applies to hook sends and makes the smoke deterministic, through arm ordering, the fixture design, or a documented local limit change. A local limit change must not touch any prod value.

### G. Prod rollout runbook (written into the spec's design or rollout section; the owner executes the dashboard steps)
- [ ] **Step 0, owner inputs.** O1-O5 (below) are answered and recorded in this spec before step 3. The function may be **deployed** before they are answered. The hook may **not be enabled** in prod until they are.
- [ ] **Step 1, snapshot current prod auth mail config.** Record these from Dashboard → Authentication → Emails, or from `GET /v1/projects/ebwnovzzkwhsdxkpyjka/config/auth`:
  - the SMTP settings (host, sender)
  - which templates are customized
  - Confirm email
  - Secure email change
  - which security notifications are on
  
  The rollout **does not edit or delete** the SMTP settings. They are the rollback path.
- [ ] **Step 2, transport secrets.** `supabase secrets set` for the From address, the transport selector, and the transport credentials (Resend: `RESEND_API_KEY` already exists, so confirm it; SMTP: host, port, user, pass).
- [ ] **Step 3, hook secret.** In Dashboard → Authentication → Hooks → Send Email → HTTPS, enter `https://ebwnovzzkwhsdxkpyjka.supabase.co/functions/v1/<fn>`, then **Generate Secret**, then `supabase secrets set SEND_EMAIL_HOOK_SECRET='v1,whsec_…'`.
  - The hook stays **disabled** at this step.
  - If the dashboard can't save a disabled hook with a generated secret, the architect documents the safe alternative, for example a self-generated `v1,whsec_` secret set on both sides before enabling.
- [ ] **Step 4, deploy.** `supabase functions deploy <fn>`. The `verify_jwt = false` pin in `config.toml` carries the setting; `--no-verify-jwt` is an acceptable belt-and-braces flag.
- [ ] **Step 5, pre-enable probe.**
  - An unsigned `POST` to the prod function URL returns 401. This proves three things: the function is deployed, the gateway JWT check is off, and the signature gate is on.
  - A 401 from the **gateway** (JWT) rather than from the function means `verify_jwt` was not applied. Stop and fix before continuing.
- [ ] **Ordering rule, stated in the runbook in bold.** The function and the hook secret must be live **before** the hook is enabled. Otherwise every prod auth email (recovery, invite fallback, confirmations) fails.
- [ ] **Step 6, enable.** Turn the Send Email hook on in the dashboard.
- [ ] **Step 7, prod probes**, run immediately after enabling:
  - (a) `/recover` to an owner-controlled real address gives exactly one mail with the expected From. Its link opens the prod web reset screen (`EXPO_PUBLIC_WEB_RECOVERY_URL`) and a new password can be set.
  - (b) `/recover` to a placeholder account (a probe store user `zz_probe166` created through + ADD USER, deleted afterwards) returns 200, the provider dashboard shows **no** send, and the function logs show outcome `dropped` with no address.
  - (c) If O3 shows any security notification on: `manage-store-user` set_password on `zz_probe166` sends nothing (closes L1).
- [ ] **Step 8, rollback** (written as a one-line action). Dashboard → Authentication → Hooks → disable the Send Email hook. GoTrue's SMTP sending resumes immediately with the step 1 config untouched.
  - **Rollback triggers:** any step 7 probe fails, or any report of missing auth mail after enablement.
  - The function may stay deployed while disabled.
- [ ] **Step 9, CI check.** After the push to `main`, the latest `test.yml` and `db-migrations-applied.yml` runs on `main` are green (CLAUDE.md rule), and `e2e.yml` is checked manually (project memory).
- [ ] The runbook states that this spec adds **no migration**, so the `db-migrations-applied` gate is unaffected.

### H. Process (owner constraints)
- [ ] Before any code edit, the implementing developer(s) show the owner a file-by-file plan and get approval.
- [ ] Changes are staged, never committed. The owner commits.

## In scope
- One new Send Email hook edge function: signature verification, the spec 165 placeholder predicate (byte-identical block), per-recipient drop, rendering for every `email_action_type`, and an env-selected transport with a local Mailpit path plus one prod transport
- `supabase/config.toml`: the `[functions.<fn>] verify_jwt = false` pin and the local `[auth.hook.send_email]` block, plus a local secret mechanism that boots locally and in CI
- Parity-test update (`COPIES`)
- A new local smoke script wired into `test:smoke`, and a tests/README update
- The written prod rollout runbook: owner inputs, ordering, probes, rollback

## Out of scope (explicitly)
- **Editing or removing prod GoTrue SMTP settings.** They stay untouched as the rollback path.
- **Setting up a verified sending domain in Resend or DNS.** This is an owner action. The hook only reads the From address from env.
- **Moving the other send-* functions** (`send-invite-email`, `send-welcome-email`, `send-po-email`, `send-order-failure-email`) or the reminder crons off `onboarding@resend.dev`, or onto the hook's renderer. That is a separate hygiene item, even though the same sender question applies.
- **Visual redesign or i18n of auth emails.** English, plain templates only.
- **Further hardening of `username-resolve`** (rate limit, its fail-open limiter) or CAPTCHA on `/recover`. Separate items. This spec removes the bounce impact, not the lookup.
- **Security L4 (audit events), L5 (password floor), L7 (`delete-user` uppercase self-guard).** Tracked separately.
- **SMS / phone hooks**, and any other auth hook.
- **The native recovery deep link** (spec 085 Q1, `app.json` scheme) and **the `app.json` slug.** Neither is touched.
- **Building both prod transports** when O2 is already answered. Only the chosen one plus the local path are built.
- **Enabling local security notifications** in `config.toml`. Synthetic signed payloads (S6) cover the notification path.

## Open questions resolved
From the request (not re-asked):
- Q: What gets dropped? → A: Any recipient matching the spec 165 predicate (trimmed, lowercased, `/^u-[0-9a-f]{32}@no-email\.invalid$/`). Nothing else is ever dropped.
- Q: What does a dropped send return? → A: HTTP 200, so `/recover` keeps its anti-enumeration behaviour.
- Q: Is the predicate shared? → A: No. It is the inline block, byte-identical, added to the parity test's `COPIES`.
- Q: Must non-placeholder mail keep working? → A: Yes. The hook replaces SMTP, so it renders and delivers everything else itself.

PM defaults (least-privilege / precedent; **(user may override)** where marked):
- Q: One function or a DB (`pg-functions://`) hook? → A: An HTTP edge function. A Postgres hook can only queue or relay, and can't send mail without `pg_net` plus an HTTP provider anyway.
- Q: Gate on `ADMIN_ROLES`? → A: No. It isn't user-invoked. The Standard Webhooks signature is the gate (`submission-push-fanout` precedent).
- Q: Prod transport if O2 is open at build time? → A: Resend HTTP API, matching repo precedent and the existing secret. **(user may override)**
- Q: Visual parity with current prod templates? → A: Not required; link mechanics, recipients and subjects are. **(user may override)**
- Q: Behaviour on a real-recipient delivery failure? → A: Non-2xx, so the failure is visible and never silently swallowed.
- Q: Commit a local-only dev hook secret? → A: Yes, if needed for CI and `npm run dev:db` to boot (pinned dev-token precedent). Never the prod value. **(user may override)**
- Q: Should the hook render for action types the app doesn't use today (magic link, reauthentication, notifications)? → A: Yes, with a generic fallback. `/otp` and `/resend` are public, and any mail the hook doesn't handle is lost.

### Owner inputs required before prod enablement (rollout-time; do NOT guess)
The build doesn't depend on these: the design renders every action type and has an env-selected transport. **Prod enablement (G step 6) is blocked until each is answered and recorded here.**
- **O1. Which SMTP does prod GoTrue use today?** Supabase default, or custom; if custom, which provider and host. Check Dashboard → Authentication → Emails → SMTP Settings.
  - If it is the **Supabase default SMTP**: today it delivers only to project team members, at about 2/hour. M1's bounce risk is then mostly moot, and enabling the hook would **newly** deliver recovery mail to real managers. That is a behaviour change the owner should knowingly accept, and it may lower this spec's priority.
  - If it is **custom (for example Resend SMTP)**: M1 is live and this spec should ship next.
- **O2. Which channel should the hook deliver through, and from which address?**
  - The channel: Resend HTTP API, or an SMTP relay to prod's existing provider.
  - The **From address and sender name.** The repo's Resend calls all use `onboarding@resend.dev`, Resend's test sender. The architect must verify the sender's restrictions; the PM's understanding is that it can deliver only to the Resend account owner's own address. If so, using it would break recovery for real managers. A verified-domain sender is presumed necessary.
- **O3. Prod Auth settings:** is Confirm email on, is Secure email change on, and which security notifications are on (password changed, email changed, others)? This determines which hook paths carry real prod traffic and whether probe 7(c) applies.
- **O4. Prod template customizations** beyond the spec 085 recovery template. If other templates were edited in the dashboard, the owner shares their content so link mechanics can be matched.
- **O5. Confirmation of the prod `redirect_to` allowlist** (spec 085 manual steps). It must include `EXPO_PUBLIC_WEB_RECOVERY_URL`, so probe 7(a) exercises the real link.
  - It must contain **no wildcard entries on shared-hosting domains**, for example `https://*.vercel.app/**` (release proposal, security L2). The recovery `token_hash` rides in the redirect URL's query string, and the hook trusts the GoTrue-approved `redirect_to`. A wildcard on a domain anyone can host on would send a victim's reset token to a third-party origin when they click. The app's own host is `hopeful-lewin.vercel.app`, so list it exactly.

## Dependencies
- Spec 165: the placeholder shape, the `// BEGIN/END placeholder-email (spec 165)` block, `src/lib/placeholderEmail.ts`, the parity test, `manage-store-user` (fixture creation), and `scripts/smoke-store-user.sh` (regression). Spec 165 is committed but not deployed. This spec's prod rollout should follow, or accompany, spec 165's rollout K.
- Spec 085: the recovery `token_hash` link format, `resolveRecoveryRedirectUrl`, `verifyOtp` redemption, and the prod redirect allowlist.
- Supabase Auth Send Email hook (HTTP), Standard Webhooks (`standardwebhooks` from esm.sh or equivalent).
- Local Mailpit (`[inbucket]`) for local delivery and assertions.
- The prod transport: a Resend account plus a verified sending domain, or prod SMTP provider credentials (owner, O2).
- CLAUDE.md conventions: inline `escapeHtml`, inline-not-shared, `verify_jwt` pinning, the CI gate check after every push.

## Project-specific notes
- **Cmd UI section / legacy:** None. Backend and config only; no UI change.
- **Per-store or admin-global:** Project-global. GoTrue auth mail covers every account in every brand. No `auth_can_see_store()` involvement and no RLS change.
- **Realtime channels touched:** None.
- **Migrations needed:** No. The `db-migrations-applied` gate is unaffected.
- **Edge functions touched:**
  - new: `send-email-hook` (working name), `verify_jwt = false`, signature-gated
  - unchanged: all others. `send-invite-email`'s GoTrue fallback now routes through the hook at runtime, with no code change.
- **Web/native scope:** Server-side; it affects both clients' auth mail. Recovery links target web (`EXPO_PUBLIC_WEB_RECOVERY_URL`); native recovery remains spec 085 Q1. No EAS build needed.
- **`app.json` slug:** Not touched.
- **Test tracks:** shell smoke (primary, section F), jest (the parity `COPIES` update, plus the full suite). No pgTAP, since there is no SQL.

## Risks and items the architect must verify (do not assume)
1. **Total-mail-outage blast radius.** A hook bug, missing secret, or wrong From address stops **all** prod auth mail once the hook is enabled. Mitigations: the rollout ordering, the step 5 pre-enable probe, the step 7 probes, and the one-click rollback.
2. **Edge-function outbound SMTP ports.** The PM recalls that Supabase Edge Functions block outbound ports 25 and 587. This must be verified against current docs before choosing an SMTP-relay transport for prod.
3. **Resend test-sender restriction.** See O2. Verify before any prod enablement.
4. **The GoTrue hook timeout and retry behaviour.** A slow provider call may time out and fail the auth request, or a retry may send duplicates. Confirm the documented timeout and whether GoTrue retries, and design within it.
5. **The `email_sent` rate limit with the hook enabled.** Confirm whether it still applies, both for the local smoke and for prod's quota posture.
6. **Exact `email_data` field semantics** per action type: the `email_change` swap, the contents of `redirect_to` when the client passes none, and `site_url` versus the API URL. Verify locally against real GoTrue payloads (for example by temporarily logging the action type and key **names** only, never values).
7. **`supabase config push` footgun.** The local `[auth.hook.send_email]` block points at `host.docker.internal`. Pushing local config to prod would break prod auth mail. Mitigated with a comment; the owner doesn't use `config push` today.
8. **CLI hook-secret validation** in `supabase start` across 2.106.0 (`test.yml`) and `latest` (`e2e.yml`). A malformed or unset local secret could break both CI gates.
9. **Local edge-runtime bind mount** (CLAUDE.md). The new function directory is served only if the mount points at the repo root. Run the `docker inspect … | grep functions` check before debugging a 503.

## Backend design

Author: backend-architect, 2026-10-19. This section is the plan the owner approves before any code edit (H). It holds for every answer to O1-O5: they gate **prod enablement** (G step 6), not the build. Build needs only the backend-developer. No frontend work, no migration, no RLS change.

### 0. Decisions at a glance

| # | Question | Decision | Why / evidence |
|---|---|---|---|
| D1 | Function name | **`auth-email-hook`** (renamed from the working name `send-email-hook`) | The `send-*-email` family is user-invoked and gates on `ADMIN_ROLES`; `send-order-failure-email` is already the confusing exception (`config.toml:454-462`). A name that reads "GoTrue hook" keeps reviewers from pattern-matching a missing admin gate. |
| D2 | Signature verification | `https://esm.sh/standardwebhooks@1.0.0` `Webhook.verify()`, tried against each `\|`-separated secret. Fails closed: secret unset or malformed → 500; bad, missing or stale (>5 min) signature → 401 | Reference implementation from the Supabase docs (constant-time compare plus timestamp tolerance). This is security-critical, so no hand-rolled HMAC. Esm.sh imports are already precedent (`send-invite-email/index.ts:2`), and prod bundles them at deploy. |
| D3 | Success / drop response | HTTP **200**, `Content-Type: application/json`, body `{}`. Never an empty body | The docs say "empty 200 = success". GoTrue's hook client (as I know it; not readable on disk) **rejects a 2xx with no JSON Content-Type**. `{}` + JSON satisfies both. Proven against v2.189.0 by smoke S1/S2. |
| D4 | Real-recipient failure | **Fail closed**: non-2xx (500), never 200. Never 429 or 503 | AC A "no silent loss". The cost is a temporary existence oracle: while the transport is broken, `/recover` returns 500 for existing real accounts but 200 for placeholders and unknown addresses. That is **identical to today's SMTP-failure behaviour**, so it is not a regression. Returning 200 would turn every outage into silent loss of real reset mail. The window is bounded by the step 5b pre-enable probe, the step 7 probes, and a one-click rollback. 429/503 are avoided because GoTrue retries them, which could send duplicates. |
| D5 | Transport seam | Env-selected `SEND_EMAIL_TRANSPORT` = **`mailpit`** (local, Mailpit HTTP send API) or **`resend`** (prod, Resend HTTP API). Any other value, or unset, counts as misconfigured and returns 500 for real recipients. **No SMTP transport is built** | Every mail path in the repo is Resend HTTP. Docs recollection: hosted Edge Functions block outbound ports 25 and 587. That is **unverified**, and it is moot for HTTP transports. If O2 = "SMTP relay" is answered **before** build, the developer stops and returns to the architect for a transport addendum (library choice and port verification), per AC C. |
| D6 | From address | `SEND_EMAIL_FROM` (bare address, required) and `SEND_EMAIL_FROM_NAME` (optional; omitted if unset). **No default sender.** The `resend` transport refuses any `@resend.dev` From | Resend's shared test sender only delivers to the Resend account owner's own address. A verified-domain sender is required (O2). Unset or invalid From returns 500 (D4). |
| D7 | Local hook secret | A **committed literal**, visibly dev-only: `v1,whsec_LOCAL/DEV/ONLY/imr/SendEmailHook/NotForProd/0000`. The same literal goes in `[auth.hook.send_email] secrets` and `[edge_runtime.secrets] SEND_EMAIL_HOOK_SECRET` | CI must boot with no repo secrets, and `env()` would need a workflow edit or an env file the CLI may not load. The literal is 48 base64-alphabet chars (12 full quads, valid base64, decodes to a 36-byte key), so it passes the CLI/GoTrue `v1,whsec_[A-Za-z0-9+/=]{32,88}` check. The `/`s keep the longest alphanumeric run at 13, below the `whsec_[A-Za-z0-9]{32,}` shape that secret scanners flag as a Stripe webhook secret. **Tripwire:** if the secret contains `LOCAL/DEV/ONLY` and the transport is `resend`, the hook refuses with 500. A leaked local secret therefore can never send real mail. |
| D8 | Local transport target | Mailpit HTTP API `http://supabase_inbucket_imr-inventory:8025/api/v1/send`, set via `[edge_runtime.secrets] MAILPIT_SEND_URL` | Verified reachable from the edge-runtime network (your 2026-10-19 check). It is HTTP, so there is no SMTP client in Deno. The value lives in config, so a CLI rename is a one-line fix. |
| D9 | Pure logic in a parity-locked TS mirror | Routing, render, secret parsing, transport-config resolution and request building sit in one marker block, `// BEGIN auth-email-hook-core (spec 166)`. It is **byte-identical** in `src/lib/authEmailHook.ts` (jest-only canonical) and in the Deno function, enforced by a new parity test | Follows the escapeHtml TS-mirror precedent (`src/utils/escapeHtml.ts`) and the spec 165 parity mechanism (`placeholderEmail.parity.test.ts:21-32`). The code jest tests is literally the code that ships. |
| D10 | Prod-transport proof (AC C / S8) | **Jest, not a smoke stub.** Jest covers `buildTransportRequest` and `isTransportSuccess` for Resend: URL, auth header, recipient, From, subject, link presence, idempotency key, and 2xx/non-2xx classification. That block ships byte-identical (D9). **Not covered:** the bare `fetch()` call, and real Resend behaviour (domain verification, rate limits, its actual error responses). Prod probes 5b and 7a cover that. **Spec deviation, needs owner sign-off** | Local edge-runtime env is fixed when the container is created. Exercising `resend` locally would need a second runtime, or a stop/start with different env, which breaks the "CI boots with no extra secrets" rule. A configurable Resend API base in the prod bundle would be a key-redirect lever. Fallback if the owner vetoes: add `RESEND_API_BASE` (http allowed only for `host.docker.internal`) plus a manual, opt-in S8 that restarts the stack with `SEND_EMAIL_TRANSPORT=resend`. |
| D11 | Link base for GoTrue `/verify` links | `email_data.site_url` if it parses as a URL whose path ends in `/auth/v1`. Otherwise `SUPABASE_URL + "/auth/v1"` | I believe GoTrue fills the hook's `site_url` with its **API external URL**. The docs' sample `"site_url": "http://localhost:9999"` is GoTrue's own port. If so, links match GoTrue's own `{{ .ConfirmationURL }}` host exactly, prod custom domains included. If not, we fall back to the function's own URL. Both sources satisfy AC B. Locally the fallback is `http://kong:8000`, which can't be clicked from Mailpit; that is dev-only and cosmetic, and the smoke rewrites the host. **Resolved 2026-10-19 (S6b):** the hook's `site_url` is the Site URL (the app), not the API URL, so the `SUPABASE_URL` fallback is the live branch, and it is correct for prod (`https://<ref>.supabase.co/auth/v1`). Custom-domain note: if a Supabase custom domain is adopted, links stay on `<ref>.supabase.co`, which still works; an optional `SEND_EMAIL_VERIFY_BASE` env is a future option for branded links. |
| D12 | `email_changed_notification` recipient | `email_data.old_email` if set, else `user.email` | It is a security notice to the address that was replaced. `old_email` comes from the signed payload, so this extends AC A's recipient list within its rule. **Spec clarification, owner sign-off.** |
| D13 | Duplicate-send guard | Legs are sent **sequentially**, each with `AbortSignal.timeout(2000)`, so worst case is about 4 s against GoTrue's hook timeout (5 s in the GoTrue I know; verify). Resend gets `Idempotency-Key: <webhook-id>:<legIndex>` | GoTrue re-sends with the same `webhook-id` on network-error retries, so Resend de-duplicates within its window. Confirm Resend's header support at build time; an unknown header is harmless. |
| D14 | Extra smoke arms beyond AC F | S3b (PKCE-shaped `/recover`, like the app), S6b (real GoTrue invite, link redeemed), S9 (real secure email change, both legs redeemed) | These are the payload mappings most likely to be wrong: the `token_hash` prefix, the `site_url` semantics, and the email_change swap. Synthetic payloads can't prove them. Additive only. |
| D15 | Optional owner pre-enable probe script | `scripts/probe-auth-email-hook.sh`, **optional, owner decides at plan approval**. It sends one signed, link-free, code-free fallback mail to an owner address through the **prod** function **before** enabling | Risk #1 is a total auth-mail outage. This proves secret match, transport, From and domain verification with the hook still off. |

Spec deviations or clarifications needing explicit owner OK at plan approval: **D1** (rename), **D10** (jest instead of an S8 stub), **D12** (`old_email`), **D15** (the optional extra script). §3.4 also has one small one: the recovery-link separator. Everything else is within the spec's latitude.

**Owner approval (2026-10-19, in chat):** "Approved: build spec 166 as designed, including D1, D10, D12, the §3.4 separator, and the optional D15 probe script. Stage, don't commit." D15 `scripts/probe-auth-email-hook.sh` is therefore built.

### 1. Data model changes
**None.** No migration, table, column, index or publication change. The `db-migrations-applied` gate is unaffected (G).

### 2. RLS impact
**None.** The function never touches the database. It has no Supabase client and makes no service-role or PostgREST call; recipients come only from the signed payload. The spec 051/053 permissive-policy lint is not engaged.

### 3. API contract: `auth-email-hook` (GoTrue → function, server-to-server)

`POST /functions/v1/auth-email-hook`. GoTrue sends `{ user, email_data }`, signed per Standard Webhooks with headers `webhook-id`, `webhook-timestamp` and `webhook-signature`. There is no CORS: the function is never browser-invoked, and `OPTIONS` gets 405 like any other non-POST.

#### 3.1 Handler order (each step runs before any later side effect)
1. Method is not `POST`: **405** `{"error":"method not allowed"}`.
2. `parseHookSecrets(Deno.env.get("SEND_EMAIL_HOOK_SECRET"))` returns null (unset, or any `|`-part not matching `^v1,whsec_[A-Za-z0-9+/=]{32,88}$`): **500** `{"error":"hook misconfigured"}`.
3. `body = await req.text()`. More than 64 KiB: **413** `{"error":"payload too large"}`. This guard runs before the HMAC.
4. For each secret, `new Webhook(<base64 part>).verify(body, Object.fromEntries(req.headers))`. If none verifies (missing headers, bad signature, timestamp outside ±5 min): **401** `{"error":"invalid signature"}`.
5. `parsePayload(JSON.parse(body))` returns null (no `user` object, no `email_data` object, or `email_action_type` not a non-empty string): **400** `{"error":"invalid payload"}`.
6. `planMails(payload, SUPABASE_URL)` (§4). This routes the legs, **drops placeholder legs before any render**, then renders only the surviving real legs.
   - `invalid_payload` (for example `email_change` with no `user.new_email`): **400**
   - `unlinkable` (a link-bearing real leg where neither `redirect_to` nor `site_url` gives a usable URL): **500** `{"error":"delivery failed"}`. The hook never invents a host.
7. Zero mails left (every leg was a placeholder): log `dropped`, then **200** `{}`.
8. `resolveTransport({...env, hookSecretRaw})` returns misconfigured: log `failed` with `reason: "config"`, then **500** `{"error":"delivery failed"}`.
9. For each mail, **sequentially**, `fetch` the built request with `AbortSignal.timeout(2000)`. Any non-2xx, timeout or network error: log `failed` (with the provider status code if there was one), then **500** `{"error":"delivery failed"}`. The provider response body is never read into a log.
10. All sent: log `sent`, then **200** `{}`.
- Top-level `catch`: **500** `{"error":"internal error"}`, never `e.message` (spec 165 §4.5 precedent).
- GoTrue maps any non-2xx from the hook to a 5xx for its own caller, which is the documented failure surfacing.

#### 3.2 Recipient routing (`routeLegs`)

| `email_action_type` | Leg(s): recipient → hash, code |
|---|---|
| `recovery`, `signup`, `invite`, `magiclink`, `email`, `reauthentication` | `user.email` → `token_hash`, `token` |
| `email_change`, both pairs present (`token_hash_new` non-empty and `user.email` non-empty) | **current:** `user.email` → `token_hash_new`, `token`. **new:** `user.new_email` → `token_hash`, `token_new` |
| `email_change`, single pair (secure change off) | **new:** `user.new_email` → `token_hash`, then `token_new` if non-empty, else `token` |
| `email_changed_notification` | `email_data.old_email` if non-empty, else `user.email` (D12) |
| every other `*_notification` | `user.email` |
| unknown future type | `user.email`. Generic fallback, **never dropped** |

- A leg with an empty or non-string recipient is skipped. If the request then has no legs at all, the result is `invalid_payload`.
- **Each** leg goes through `isPlaceholderEmail` on its own. Matching legs are counted as `dropped` and never reach render or transport.

#### 3.3 Subjects (plain text, no escaping; AC A)

| Type | Subject |
|---|---|
| `recovery` | `Reset your password` (exact, S2) |
| `signup` | `Confirm your email` |
| `invite` | `You have been invited to I.M.R` |
| `magiclink` | `Your sign-in link` |
| `email` | `Your sign-in code` |
| `email_change` | `Confirm your email change` (both legs) |
| `reauthentication` | `Your verification code` |
| `password_changed_notification` | `Your password was changed` |
| `email_changed_notification` | `Your email address was changed` |
| `phone_changed_notification` | `Your phone number was changed` |
| `identity_linked_notification` | `A sign-in method was linked to your account` |
| `identity_unlinked_notification` | `A sign-in method was removed from your account` |
| `mfa_factor_enrolled_notification` | `A verification method was added to your account` |
| `mfa_factor_unenrolled_notification` | `A verification method was removed from your account` |
| unknown | `Account notification` |

#### 3.4 Links and body content
- **Recovery** (spec 085 parity): `<redirect_to>?token_hash=<encodeURIComponent(hash)>&type=recovery`.
  - If `redirect_to` is unusable, `site_url` is used. GoTrue already substitutes its validated redirect or its Site URL there, so in practice `redirect_to` is never empty; S2 verifies this.
  - "Unusable" means it fails `new URL()` or has the protocol `javascript:`, `data:`, `vbscript:` or `file:`. Other schemes are allowed, so the future native `<scheme>://reset-password` (spec 085 Q1) keeps working.
  - The separator is `&` instead of `?` only when `redirect_to` already contains `?`. Every value the app sends has no query string, so the link is byte-identical to the template. **Spec clarification.**
- **`signup` / `invite` / `magiclink` / `email` / `email_change` / unknown with a hash:**
  `<verifyBase>/verify?token=<enc(hash)>&type=<enc(email_action_type)>&redirect_to=<enc(redirect_to or site_url)>`
  - This mirrors GoTrue's default `{{ .ConfirmationURL }}` and the docs' own example.
  - `verifyBase` is per D11.
  - Invite carries `send-invite-email`'s `redirectTo` through unchanged. Allowlisting it in prod is an O5 item (§12 step 0).
- **Codes:**
  - `magiclink`, `email`, `email_change` and unknown types also show the 6-digit code when one is present.
  - `reauthentication` shows **code only, no link**.
  - `*_notification` types show **no link and no code**.
- **HTML**
  - Every interpolated value (link, code, addresses) goes through the inline `escapeHtml()`. It is byte-identical to `send-invite-email/index.ts:42-45`, sits **outside** the core block, and the parity test checks it (§11).
  - Query parameters are `encodeURIComponent`-ed **before** escaping, so the `&` inside an `href` appears as `&amp;`. Browsers decode that back to the same URL.
- **Text part**: plain, unescaped, with the same link and code. The smoke asserts the exact link against the Text part.
- **Content limits**: **no `user_metadata` (names) is ever interpolated.** That removes a user-controlled text-injection surface.
- **Layout**: brand-neutral. Header "I.M.R", footer "I.M.R — Inventory Management for Restaurant". English only.

#### 3.5 Error table

| Status | Body | When |
|---|---|---|
| 200 | `{}` | sent, or all legs dropped |
| 400 | `{"error":"invalid payload"}` | signed but malformed |
| 401 | `{"error":"invalid signature"}` | missing, wrong or stale signature |
| 405 | `{"error":"method not allowed"}` | not POST |
| 413 | `{"error":"payload too large"}` | body over 64 KiB |
| 500 | `{"error":"hook misconfigured"}` | `SEND_EMAIL_HOOK_SECRET` unset or malformed |
| 500 | `{"error":"delivery failed"}` | transport misconfigured, provider non-2xx, timeout, or unlinkable |
| 500 | `{"error":"internal error"}` | uncaught |

### 4. Core block (`auth-email-hook-core`, spec 166)

The block is pure TS. It has no imports, no `Deno.*`, no `fetch`, no `console`, no `export`, and no newer lib APIs (use `.replace(/…/g)`, not `replaceAll`). It references two free identifiers, `isPlaceholderEmail` and `escapeHtml`:
- In Deno, the spec 165 placeholder block and the inline `escapeHtml` above it define them.
- In `src/lib/authEmailHook.ts`, they are imported (outside the block) from `./placeholderEmail` and `../utils/escapeHtml`.

The canonical file must **not** contain the literal `no-email.invalid`, or the spec 165 lint (`placeholderEmail.parity.test.ts:97-103`) fails.

Signatures:

```
type HookEmailData = { token: string; token_hash: string; redirect_to: string; email_action_type: string;
  site_url: string; token_new: string; token_hash_new: string; old_email: string }   // missing → ""
type HookPayload = { user: { email: string; new_email: string }; email_data: HookEmailData }
type Leg = { to: string; hash: string; code: string }
type PlannedMail = { to: string; subject: string; html: string; text: string }
type Plan = { ok: true; action: string; mails: PlannedMail[]; dropped: number }
          | { ok: false; reason: "invalid_payload" | "unlinkable" }
type TransportConfig = { kind: "mailpit"; url: string; from: string; fromName: string }
                     | { kind: "resend"; apiKey: string; from: string; fromName: string }

function parsePayload(raw: unknown): HookPayload | null
function routeLegs(p: HookPayload): Leg[] | null
function planMails(p: HookPayload, supabaseUrl: string): Plan
function subjectFor(action: string): string
function verifyBase(siteUrl: string, supabaseUrl: string): string | null
function recoveryLink(redirectTo: string, siteUrl: string, hash: string): string | null
function verifyLink(base: string, hash: string, action: string, redirectTo: string): string
function logAction(action: unknown): string        // [a-z_]{1,64} passthrough, else "unknown"
function parseHookSecrets(raw: string | undefined): string[] | null   // base64 parts, prefix stripped
function isLocalDevSecret(raw: string): boolean     // contains "LOCAL/DEV/ONLY"
function resolveTransport(env: { transport?: string; from?: string; fromName?: string;
  resendApiKey?: string; mailpitUrl?: string; hookSecretRaw?: string }): TransportConfig | null
function buildTransportRequest(cfg: TransportConfig, mail: PlannedMail, idempotencyKey: string):
  { url: string; headers: Record<string, string>; body: string }
function isTransportSuccess(status: number): boolean   // 200..299
```

`resolveTransport` returns null (misconfigured) when any of these holds:
- The transport is not `mailpit` or `resend`.
- `from` doesn't match `^[^\s@<>"]+@[^\s@<>"]+$`.
- `fromName` contains any of `<>"\r\n`.
- `mailpit` has no http(s) `mailpitUrl`.
- `resend` has an empty `resendApiKey`, a From ending `@resend.dev`, or `isLocalDevSecret(hookSecretRaw)` is true (the D7 tripwire).

Request shapes:
- **Mailpit:** `POST <url>`, JSON body `{From:{Email,Name},To:[{Email}],Subject,HTML,Text}`.
- **Resend:** `POST https://api.resend.com/emails` (constant), with headers `Authorization: Bearer <key>`, `Content-Type: application/json` and `Idempotency-Key`. JSON body `{from: fromName ? "Name <addr>" : addr, to:[to], subject, html, text}`.

### 5. Edge function: `supabase/functions/auth-email-hook/index.ts`
- **`verify_jwt = false`, pinned.** In `config.toml`, add after the `send-order-failure-email` block:

  ```
  # auth-email-hook (spec 166) — GoTrue Send Email hook. GoTrue calls it with a
  # Standard Webhooks signature (SEND_EMAIL_HOOK_SECRET), NOT a Supabase JWT, so
  # the gateway JWT check would reject every call; the in-function signature check
  # REPLACES it and fails closed. Event-driven, not a user-invoked privileged op,
  # so NO ADMIN_ROLES gate — there is no caller JWT to gate on. Pinned so a CLI
  # redeploy can't silently re-enable JWT and break ALL prod auth mail.
  [functions.auth-email-hook]
  verify_jwt = false
  ```
- **File layout, top to bottom:**
  1. header comment (contract, log hygiene, anti-enumeration, the D4 rationale)
  2. `import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0"`
  3. env reads
  4. the spec 165 placeholder block, byte-identical
  5. inline `escapeHtml`, byte-identical to `send-invite-email`
  6. the core block, byte-identical
  7. `jsonResponse(status, body)` in the `username-resolve/index.ts:51-56` style, without CORS
  8. `logOutcome()`
  9. `Deno.serve` running §3.1
- **Env vars:**

  | Var | Required | Notes |
  |---|---|---|
  | `SEND_EMAIL_HOOK_SECRET` | yes | `\|` rotation supported |
  | `SEND_EMAIL_TRANSPORT` | yes | `mailpit` / `resend` |
  | `SEND_EMAIL_FROM` | yes | |
  | `SEND_EMAIL_FROM_NAME` | no | |
  | `MAILPIT_SEND_URL` | mailpit only | |
  | `RESEND_API_KEY` | resend only | already a prod secret |
  | `SUPABASE_URL` | | auto-injected |

- **Logging (AC A, log hygiene):** exactly one line per request, `console.log(JSON.stringify({hook:"auth-email-hook", action, outcome, recipients, dropped, status?, reason?}))`.
  - `action` is `logAction(...)` (sanitized).
  - `outcome` ∈ `sent | dropped | failed | rejected`.
  - `recipients` and `dropped` are counts.
  - `status` is the provider HTTP status code only.
  - `reason` is a **fixed enum** (`signature | payload | config | transport | timeout | unlinkable | size`). It carries no data. This is a small extension of the permitted fields; flagged for the security reviewer.
  - Never logged: body, tokens, hashes, links, addresses, `user.id`, `webhook-id`, provider response bodies, `e.message`.

### 6. Config and local secret (`supabase/config.toml`)
1. **Replace** the commented `# [edge_runtime.secrets]` stub (`config.toml:401-402`) with a live block. Add a comment that these are LOCAL-ONLY literals, never pushed to prod, and that prod values come from `supabase secrets set`:
   ```
   [edge_runtime.secrets]
   SEND_EMAIL_HOOK_SECRET = "v1,whsec_LOCAL/DEV/ONLY/imr/SendEmailHook/NotForProd/0000"
   SEND_EMAIL_TRANSPORT = "mailpit"
   MAILPIT_SEND_URL = "http://supabase_inbucket_imr-inventory:8025/api/v1/send"
   SEND_EMAIL_FROM = "no-reply@imr.local.test"
   SEND_EMAIL_FROM_NAME = "I.M.R (local)"
   ```
   The block is visible to every local function. That is benign: none of them reads these names.
2. **Add** `[auth.hook.send_email]` next to the commented hook stubs (`config.toml:294-302`):
   ```
   [auth.hook.send_email]
   enabled = true
   uri = "http://host.docker.internal:54321/functions/v1/auth-email-hook"
   secrets = "v1,whsec_LOCAL/DEV/ONLY/imr/SendEmailHook/NotForProd/0000"
   ```
   Its comment must say four things (AC D):
   - It is LOCAL-ONLY. The prod hook is dashboard-configured (spec 166 §12).
   - **Never run `supabase config push` against prod.** It would push this `host.docker.internal` URI and the public dev secret, and break all prod auth mail. Rollback is to disable the hook in the dashboard.
   - The secret must equal `[edge_runtime.secrets] SEND_EMAIL_HOOK_SECRET` byte-for-byte; the smoke preflight checks this.
   - To turn it off locally, set `enabled = false` and run `npx supabase stop --no-backup && npm run dev:db`.
3. **Comment only** on `[auth.email.template.recovery]` (`config.toml:257-265`): while the hook is enabled, GoTrue doesn't render this template locally. It is kept as the mirror of the prod template, which is the rollback path.
4. Local rate limits: **no change.** The CLI already overrides `email_sent` to 360000 locally (your verified env). `max_frequency = "1s"` is per user and is handled by smoke ordering (§11). No prod value is touched.

**Developer verification gate (blocking, before READY_FOR_REVIEW).** After `npx supabase stop --no-backup && npm run dev:db`:
- `docker exec supabase_edge_runtime_imr-inventory printenv SEND_EMAIL_HOOK_SECRET SEND_EMAIL_TRANSPORT MAILPIT_SEND_URL SEND_EMAIL_FROM` prints all four.
- `docker exec supabase_auth_imr-inventory printenv | grep GOTRUE_HOOK_SEND_EMAIL` shows ENABLED=true, the URI and the secret.
- If CLI 2.95.4 doesn't apply literal `[edge_runtime.secrets]`, **stop and return to the architect**. Don't improvise a `.env` mechanism.

### 7. `src/lib/db.ts` surface
**None.** The hook is GoTrue → function, and no client calls it. `sendPasswordReset` (`auth.ts:748-764`), `registerInvitedUser` (`auth.ts:509`) and `send-invite-email` are unchanged. They now reach the hook at runtime through GoTrue. No new carve-out.

### 8. Realtime impact
**None.** There is no publication change, so the `docker restart supabase_realtime_imr-inventory` step does **not** apply.

### 9. Frontend store impact
**None.** `useStore.ts` is untouched, and there is no optimistic-then-revert path. The existing `sendPasswordReset` toast already surfaces a GoTrue 5xx (the D4 failure mode) as an error.

### 10. Owner inputs: how each answer lands (build is unchanged for every answer)
- **O1**
  - Default SMTP: enabling the hook **newly** delivers mail to real managers. The owner accepts that knowingly, or defers enablement.
  - Custom SMTP: ship next.
  - Either way, the step 1 snapshot is the rollback reference.
- **O2**
  - Resend or a verified domain: set `SEND_EMAIL_FROM` to that domain.
  - SMTP relay answered **before** build: architect addendum (D5).
  - SMTP relay answered **after** build: a contained follow-up that adds one `kind` to `resolveTransport` and `buildTransportRequest`. The seam is in the core block.
- **O3**: decides which rows of §3.2 carry real prod traffic, and whether probe 7(c) runs. No code change.
- **O4**: if a prod template uses non-default link mechanics for some type, as recovery does, the change is confined to that type's link function in the core block, plus a jest case. That is a small post-build edit and must land **before** enablement.
- **O5**: the allowlist must include `EXPO_PUBLIC_WEB_RECOVERY_URL` **and** `https://hopeful-lewin.vercel.app?register=true` (`send-invite-email/index.ts:8,70`). Without the second, the fallback invite lands on Site URL, which is the same as today.

### 11. Tests

**jest (unit project, node env)**
- `src/lib/authEmailHook.ts` (new): the jest-only canonical holding the core block. Its header states it is NOT imported by the function (escapeHtml precedent).
- `src/lib/authEmailHook.test.ts` (new) covers:
  - **Routing:** every type in §3.2. `email_change` in four shapes: secure, single-pair, placeholder-current + real-new, and real-current + placeholder-new. `email_changed_notification` with `old_email` (and the fallback). A leg with no recipient gives `invalid_payload`.
  - **Drop before render:** an all-placeholder payload gives `mails: []` and the right `dropped` count. A mixed payload renders only the real leg.
  - **Recovery link:** the exact string, including the `?`/`&` separator and an encoded hash (`pkce_` included). The fallback to `site_url`. Unusable `redirect_to` + `site_url` gives `unlinkable`. A `javascript:` redirect is rejected.
  - **Verify link:** `verifyBase` from an API-shaped `site_url` vs the `SUPABASE_URL` fallback, `type=<action>`, and an encoded `redirect_to`.
  - **Escaping:** a `"><script>` in `new_email`/`redirect_to` comes out escaped in HTML and raw in Text.
  - **Content:**
    - the subject table, including the unknown fallback
    - an unknown type with a hash gets a link, and with a token gets a code
    - reauthentication has a code and no `/verify`
    - notifications contain no `http` and no token
  - **Payload validation:** non-object, missing keys, non-string fields.
  - **Secret parsing:** valid, `|` rotation, missing prefix, under 32 or over 88 chars, illegal chars, the D7 literal is accepted, `isLocalDevSecret`.
  - **Transport config:** each null case in §4, the tripwire, and `@resend.dev`.
  - **Request building:** the Resend request (URL, `Authorization`, `Idempotency-Key`, `from` with and without a name, `to`, `subject`, link in `html` and `text`) and the Mailpit body shape.
  - `isTransportSuccess` boundaries (199, 200, 299, 300, 429, 500).
  - `logAction` sanitizing.
- `src/lib/authEmailHook.parity.test.ts` (new). It has its own extractor, tagged `(spec 166)`, so the spec 165 test is left alone. It asserts:
  - (a) the core block is byte-identical between the canonical file and `supabase/functions/auth-email-hook/index.ts`
  - (b) the block contains no `export`, `Deno.`, `fetch(`, `console.` or `no-email.invalid`
  - (c) the Deno file contains the exact `escapeHtml` function text from `src/utils/escapeHtml.ts`, minus `export `
- `src/lib/placeholderEmail.parity.test.ts`: append `'supabase/functions/auth-email-hook/index.ts'` to `COPIES` (`:36-41`) and update the "four Deno edge functions" header comment.
- `src/lib/placeholderEmail.ts`: header comment list only (`:10-14`).
- Full `npx jest`, `npm run typecheck` and `npm run typecheck:test` must pass. `src/lib/*.ts` is in the base typecheck graph.

**Shell smoke: `scripts/smoke-send-email-hook.sh` (new)**

It uses the `smoke-store-user.sh` skeleton (`:47-96`): `set -u`, the local-only refusal, `pass`/`fail`/`skip`/`step`, `psql_q`, the EXIT trap, and `exit $FAILED`. Fixture prefix is `zz_s166_`. The trap deletes `auth.users` where the email or profile username starts with `zz_s166`.

Helpers:
- `mp_total`: `GET /api/v1/messages`, then `.total`.
- `mp_clear`: `DELETE /api/v1/messages`.
- `mp_wait <n> <secs>`: poll every 250 ms until total = n. For "= 0" checks it is a fixed 2 s settle.
- `mp_msg <to>`: `/api/v1/search?query=to:<addr>`, then `GET /api/v1/message/<ID>` for `To`, `Subject`, `Text` and `HTML`.
- `sign <body>`:
  - key = `openssl base64 -d -A` of the secret minus `v1,whsec_`, hex-encoded with `od` (the existing scripts' idiom)
  - `printf '%s' "$id.$ts.$body" | openssl dgst -sha256 -mac HMAC -macopt hexkey:<hex> -binary | openssl base64 -A`
  - headers `webhook-id: msg_<rand>`, `webhook-timestamp: <ts>`, `webhook-signature: v1,<sig>`
- `hook <body> [headers]`: posts to `${SUPABASE_URL}/functions/v1/auth-email-hook` and appends the body to `BODIES_FILE`.

Arm order is chosen for determinism. Every arm runs.

- **P, preflight:**
  - stack up
  - GoTrue `GOTRUE_HOOK_SEND_EMAIL_ENABLED=true`. If not, FAIL with "restart from clean: `npx supabase stop --no-backup && npm run dev:db`".
  - GoTrue `GOTRUE_HOOK_SEND_EMAIL_SECRETS` equals the edge runtime's `SEND_EMAIL_HOOK_SECRET`
  - Mailpit API reachable. FAIL, not SKIP: the hook depends on it.
  - an unsigned POST returns 401 `{"error":"invalid signature"}`. That proves the function is served; a 404/503 points to the CLAUDE.md bind-mount check.
  - record `SMOKE_START` for the log arm
- **Setup:**
  - `mp_clear`
  - placeholder fixture via `manage-store-user` (admin bearer, username `zz_s166_p<sfx>`); read its email via `psql_q`
  - real fixture `zz_s166_r<sfx>@local.test` via the admin API (`email_confirm:true`, with a password)
- **S5, signature gate.** None of these may change the Mailpit total (0):
  - no headers → 401
  - wrong signature → 401
  - correct signature with timestamp now−600 → 401
  - `GET` → 405
  - signed `{}` → 400
  - signed `{"user":{},"email_data":{}}` → 400
- **S1:** `POST /auth/v1/recover` (anon) to the placeholder → 200. Settle, then total = 0.
- **S2:** `POST /auth/v1/recover?redirect_to=http%3A%2F%2Flocalhost%3A8081%2Freset-password` for `manager@local.test` → 200.
  - `mp_wait 1`
  - `To` = manager, `Subject` = `Reset your password`
  - Text contains `http://localhost:8081/reset-password?token_hash=<H>&type=recovery`
  - HTML contains the `&amp;type=recovery` form
- **S3:** `POST /auth/v1/verify {"type":"recovery","token_hash":"<H>"}` → 200 with `access_token`.
- **S3b (PKCE, app-faithful):**
  - sleep 2 (per-user `max_frequency`), `mp_clear`
  - `/recover` for manager with `code_challenge` (S256 of a random verifier) and `code_challenge_method:"s256"` → 200
  - one message; extract `<H2>`
  - `/verify` token_hash → 200
  - **Blocking.** A failure means the hook's `token_hash` differs from the template's `.TokenHash` for PKCE. Escalate to the architect.
- **S4, anti-enumeration:**
  - `/recover` to the placeholder, to manager (after sleep 2), and to `zz_s166_nobody@local.test`
  - identical status (200) and an identical byte-for-byte body across all three
- **S6, signed synthetic payloads:**
  - `mp_clear` before each sub-arm
  - **Real address `zz_s166_syn@local.test`**, one each for `signup`, `invite`, `magiclink`, `email`, `reauthentication`, all seven `*_notification`, and `zz_future_type` (with hash + token). Each gives 200 `{}`, exactly 1 message to that address, and the §3.3 subject. Content checks:
    - link types: Text contains `/verify?token=<hash>&type=<type>&redirect_to=`
    - reauthentication: contains the code, no `/verify`
    - notifications: no `http`, no token
  - **`email_change` secure, both real (A, B):** 2 messages. A's contains `token_hash_new` and `token`; B's contains `token_hash` and `token_new`. This is the swap proof.
  - **`email_change` single-pair:** 1 message, to `new_email`.
  - **`email_change` placeholder current + real new:** exactly 1, to the real address.
  - **`email_change` real current + placeholder new:** exactly 1, to the current address.
  - **Every type addressed to the placeholder**, plus `email_changed_notification` with a placeholder `old_email`: 200 each, total 0.
- **S6b, real invite:**
  - `mp_clear`
  - `POST /auth/v1/invite?redirect_to=http%3A%2F%2Flocalhost%3A8081%2Fregister` (service role) for `zz_s166_inv<sfx>@local.test` → 200
  - 1 message; extract the `/verify` link from Text
  - if the host is `kong:8000`, rewrite it to `127.0.0.1:54321`
  - `GET` the link → 303 with `Location` containing `access_token=`
  - Record in the PR which `verifyBase` branch was taken. That resolves D11 empirically.
- **S9, real secure email change:**
  - sign in as the real fixture
  - `PUT /auth/v1/user {"email":"zz_s166_n<sfx>@local.test"}` → 200
  - `mp_wait 2`: one message to the old address, one to the new
  - `/verify {"type":"email_change","token_hash":…}` for each → 200
  - `auth.users.email` = the new address
- **S7, hygiene:**
  - `BODIES_FILE` contains no captured token, hash or `no-email.invalid`
  - `docker logs --since "$SMOKE_START" supabase_edge_runtime_imr-inventory`: every captured hash, every fixture address, and `no-email.invalid` are absent
  - every `auth-email-hook` log line is JSON whose keys are a subset of §5's set
- **S8:** not a smoke arm (D10). The script prints `SKIP S8 (reason: prod transport proven by src/lib/authEmailHook.test.ts — spec 166 D10)`.

Wiring:
- `package.json:18`: append `&& bash scripts/smoke-send-email-hook.sh` to `test:smoke`.
- `tests/README.md`: the Track 3 list (`:36`, `:395-419`) becomes five scripts, plus a one-line note that the smoke wipes local Mailpit.
- **Regression:** the full `npm run test:smoke`, including `smoke-store-user.sh` arm 19, passes with the hook enabled.
- **Rate limits:** S2/S3b/S4 are spaced by 2 s sleeps for `max_frequency = 1s`. `token_verifications` (30 per 5 min per IP) covers the 5 or 6 `/verify` calls in one run. Back-to-back reruns within 5 min are documented as a possible 429.

**Optional (D15) `scripts/probe-auth-email-hook.sh`.** Owner-run against prod.
- Args: `--url <fn url> --to <owner address>`. The secret comes from env `HOOK_SECRET` and is never echoed.
- It refuses a placeholder `--to`.
- It sends one signed `zz_preflight_probe` payload, which renders as the generic fallback with no link and no code. It expects 200 `{}`.
- It is not in `test:smoke`.

### 12. Prod rollout runbook (owner executes the dashboard steps)
**Ordering rule: the function, its transport secrets and the hook secret must all be live, and probed, BEFORE the hook is enabled. Otherwise every prod auth email (recovery, invite fallback, confirmations) fails.**

0. **Owner inputs.**
   - O1-O5 are answered and recorded in this spec before step 3. The function may be deployed earlier; it may not be enabled until then.
   - Spec 165 rollout K should land first, or together with this rollout. Probe 7(b) needs `manage-store-user` in prod.
   - **Mail-surface decision (release proposal, security M1).** Using the step 1 snapshot: if prod is on the Supabase default SMTP (O1) **or** signups are open (`enable_signup` on, or magic-link/OTP sign-in creates users), the owner either closes signups or accepts **in writing, recorded here**, before step 6, that `/signup`, `/otp` and `/resend` become unauthenticated paths that send brand-domain mail to arbitrary addresses through the shared Resend account. Saturating Resend's shared limit would also turn D4's fail-closed 500 into an existence oracle an attacker can trigger.
   - **O5 check:** the `redirect_to` allowlist has no wildcard entry on a shared-hosting domain (see O5).
1. **Snapshot** (Dashboard → Authentication → Emails, or `GET /v1/projects/ebwnovzzkwhsdxkpyjka/config/auth` with the owner's PAT). Record:
   - SMTP host and sender
   - customized templates
   - Confirm email
   - Secure email change
   - enabled security notifications
   - `rate_limit_email_sent`
   - `enable_signup`, and whether magic-link/OTP sign-in creates users (security M1; feeds the step 0 decision)
   - any existing `hook_send_email_*` fields
   
   **Do not edit SMTP.** It is the rollback path.
2. **Transport secrets.**
   - `supabase secrets set --project-ref ebwnovzzkwhsdxkpyjka SEND_EMAIL_TRANSPORT=resend SEND_EMAIL_FROM='<addr@verified-domain>' SEND_EMAIL_FROM_NAME='I.M.R'`
   - `supabase secrets list` shows `RESEND_API_KEY`. Confirm the domain is "Verified" in the Resend dashboard (O2).
3. **Hook secret, with the hook still disabled.** Dashboard → Authentication → Hooks → Send Email → HTTPS → URL `https://ebwnovzzkwhsdxkpyjka.supabase.co/functions/v1/auth-email-hook` → **Generate Secret** → copy it. Then save the hook **disabled**:
   - (a) If the dialog has an enable toggle, save with it **off**.
   - (b) Otherwise, **keep the dialog open and do not click Create yet.** Set the secret on the function first (below), finish steps 4-5, then Create. Creating then enables the hook, but only once the function is ready.
   - (c) Alternatively, the owner PATCHes `/v1/projects/ebwnovzzkwhsdxkpyjka/config/auth` with `hook_send_email_enabled=false`, `hook_send_email_uri`, and `hook_send_email_secrets` set to a self-generated `v1,whsec_$(openssl rand -base64 32)`.
   
   Then set it on the function **without putting the value on a command line** (release proposal, security L1: this secret is a "send any link to anyone from our domain" capability, so keep it out of shell history):
   ```sh
   umask 077; f=$(mktemp)                       # mktemp creates the file 0600
   read -rs S && printf 'SEND_EMAIL_HOOK_SECRET=%s\n' "$S" > "$f"; unset S   # paste v1,whsec_…, then Enter
   supabase secrets set --project-ref ebwnovzzkwhsdxkpyjka --env-file "$f"; rm -f "$f"
   ```
4. **Deploy.** `supabase functions deploy auth-email-hook --project-ref ebwnovzzkwhsdxkpyjka --no-verify-jwt`. The `config.toml` pin also carries `verify_jwt=false`.
5. **Pre-enable probe.** `curl -sS -X POST <fn url> -H 'Content-Type: application/json' -d '{}'`:
   - **401 `{"error":"invalid signature"}`**: function deployed, gateway JWT off, signature gate on, and the secret is well-formed. Proceed to 5b. This does **not** prove the secret matches GoTrue's; only 5b does.
   - 401 with a gateway body (`"Missing authorization header"` / `"Invalid JWT"`): `verify_jwt` was not applied. **Stop.**
   - 500 `hook misconfigured`: the secret is not set, is malformed, or is not valid padded base64 (for example a truncated mis-paste; `parseHookSecrets` decode-validates since the release-proposal fix). **Stop.**
   
   **5b (mandatory; D15 was approved):** run `bash scripts/probe-auth-email-hook.sh --url <fn url> --to <owner address>` with `HOOK_SECRET` unset; the script prompts for it without echo. Alternatively run `read -rs HOOK_SECRET && export HOOK_SECRET` first. Never type `HOOK_SECRET='…'` inline, because it lands in shell history (security L1). It must return 200, and one "Account notification" must arrive from the expected From. That proves secret match, transport, From and domain before any user is affected. Do not run step 6 until 5b passes.
6. **Enable** the Send Email hook in the dashboard.
7. **Prod probes, immediately:**
   - (a) `/recover` (web "forgot password") to an owner address: exactly one mail, expected From, and the link opens `EXPO_PUBLIC_WEB_RECOVERY_URL` and sets a new password.
   - (b) Create `zz_probe166` via + ADD USER and `/recover` its placeholder: 200. Resend shows **no** send, and the function logs show `outcome:"dropped"` with no address. Delete `zz_probe166` afterwards.
   - (c) If O3 shows any security notification on: `set_password` on `zz_probe166` sends nothing (closes L1).
   - (d) **`email_sent` is still enforced with the hook on** (security M1). Either compare GoTrue's behaviour with the step 1 `rate_limit_email_sent` value, or send a small burst of `/recover` requests to an owner address and look for a GoTrue 429 once the limit is reached. If it is **not** enforced for hook sends, file a follow-up spec for a send cap inside the hook.
   - **Record** (architect m3), while running (a) and (b): the observed hook latency and any timeout behaviour, or the prod GoTrue version. This is the first real evidence for the §13 risk-2 timeout and retry row.
8. **Rollback** (one action): Dashboard → Authentication → Hooks → **disable** Send Email. GoTrue's SMTP resumes immediately, with the step 1 config untouched.
   - Triggers: any step 7 probe fails, any report of missing auth mail, or any `outcome:"failed"` log burst.
   - The function may stay deployed.
9. **CI.** After the push to `main`, confirm the latest `test.yml` **and** `db-migrations-applied.yml` runs are green (CLAUDE.md). Check `e2e.yml` manually (project memory).
   - **Push protection (security L6).** If GitHub push protection flags the D7 literal on push, mark it "used in tests". It is public by design and tripwired against the `resend` transport. (It does match a generic `whsec_[A-Za-z0-9+/]{32,}` scanner shape; D7's claim covers only alphanumeric, Stripe-shaped rules.)
10. **No migration.** The `db-migrations-applied` gate is unaffected.

### 13. Risks and tradeoffs
1. **Total-outage blast radius** once enabled. Mitigations: the bold ordering rule, the step 5/5b probes, the step 7 probes, one-click rollback, and fail-closed config checks that fail loudly rather than silently.
2. **GoTrue internals taken from recollection, not from disk** (the image source isn't in the repo). Each is gated on local v2.189.0 by a smoke arm, and prod GoTrue may be a different version, which the step 7 probes cover:

   | Assumption | Gating arm |
   |---|---|
   | 200 needs a JSON Content-Type | S1/S2 |
   | `site_url` is the API external URL | S6b (falls back safely either way). **Resolved 2026-10-19 (S6b): disproved.** The hook `site_url` is the Site URL (the app); the `SUPABASE_URL` fallback is the live branch and is correct for prod. With a custom domain, links stay on `<ref>.supabase.co`, which still works (`SEND_EMAIL_VERIFY_BASE` is a future option). |
   | `redirect_to` is never empty | S2 |
   | the `token_hash` prefix under PKCE | S3b |
   | the email_change pairing | S9 |
   | hook timeout is 5 s, with retries on network errors and on 429/503 + `Retry-After` | D13 keeps the worst case under 5 s and never returns 429/503 |
3. **Duplicates:** possible only if GoTrue sees a network error after the provider accepted the mail. The Resend idempotency key de-duplicates that. Mailpit (local) does not.
4. **Enumeration during a transport outage.** This is the deliberate D4 trade, identical to today's SMTP failure. It is bounded by rollback.
5. **`email_sent` with the hook on is unverified.** The local CLI override hides it.
   - If prod doesn't apply the limit to hook sends, real-address flooding is bounded only by per-user `max_frequency` (prod default 60 s) and Resend's own limits. Note: Resend's default is about 2 requests/s, and legs are sequential.
   - Placeholder flooding becomes free and silent, which is the spec's goal.
   - The step 1 snapshot records the value. If it matters, it's a follow-up.
6. **Committed dev secret (D7).**
   - It is public by design. The `resend` tripwire makes it useless for real mail.
   - GitHub secret scanning could still raise a false positive. If push protection blocks the push, the owner bypasses it as "used in tests", or picks a different literal with the same properties (via an architect note). Security L6 confirmed that the literal matches a generic `whsec_[A-Za-z0-9+/]{32,}` shape, so a Standard-Webhooks or generic base64 rule may fire (see runbook step 9).
7. **CI boot.**
   - `supabase start` validates the hook block (URI host `host.docker.internal` is in GoTrue's http allowlist; the secret matches the regex). GoTrue never calls the hook at boot, so an unserved function can't fail boot.
   - Whether `host.docker.internal` resolves inside GoTrue on Linux CI is **unverified**. It doesn't block a gate: `test.yml` sends no auth mail, and e2e's invite goes through `send-invite-email`, which ignores the `inviteUserByEmail` result (`send-invite-email/index.ts:96-103`). The invitation row the test asserts is unaffected.
   - `e2e.yml` floats CLI `latest`, so a future change to `[edge_runtime.secrets]` or hook schema would surface there first.
8. **`supabase config push` footgun.** Handled by the config comment and the runbook. The owner doesn't use `config push` today. Note that it would also push `site_url = 127.0.0.1:3000`, which is a pre-existing hazard.
9. **Local dev dependency.** Every local auth mail now goes through the edge runtime and the esm.sh fetch on first call (same posture as other functions), so offline or bind-mount-broken stacks fail `/recover` with a 500. Local escape hatch: set `enabled = false` and restart from clean.
10. **Cold start.** Prod is bundled at deploy, with one import and no DB. Expected cold start is well under the hook timeout, and warm calls are dominated by the provider call. The 286 KB seed is irrelevant: there are no queries.
11. **Pre-existing, out of scope:** `send-invite-email`'s fallback swallows `inviteUserByEmail` errors, so an invite can "succeed" while the hook fails. Noted for a future hygiene spec.
12. **The native recovery deep link and the `app.json` slug** are untouched and not implicated.

### 14. File ownership (backend-developer only; nothing for frontend-developer)
- **New:**
  - `supabase/functions/auth-email-hook/index.ts`
  - `src/lib/authEmailHook.ts`
  - `src/lib/authEmailHook.test.ts`
  - `src/lib/authEmailHook.parity.test.ts`
  - `scripts/smoke-send-email-hook.sh`
  - *optional, D15:* `scripts/probe-auth-email-hook.sh`
- **Edited:**
  - `supabase/config.toml`: §6 items 1-3 plus the §5 pin
  - `src/lib/placeholderEmail.parity.test.ts`: `COPIES` + header
  - `src/lib/placeholderEmail.ts`: header comment only
  - `package.json`: `test:smoke`
  - `tests/README.md`: Track 3
  - this spec: `## Files changed`
- **Not touched:** `src/lib/db.ts`, `src/lib/auth.ts`, `src/store/useStore.ts`, all migrations, every other edge function, `supabase/templates/recovery.html`, `supabase/functions/.env.local.example`, `app.json`, `CLAUDE.md`.
- **Process (H):** the developer shows the owner §0 and §14 and gets approval **before the first edit**. Changes are staged and never committed. Before READY_FOR_REVIEW, the developer passes the §6 verification gate, full `npx jest`, both typechecks, and the full `npm run test:smoke`. The PR description records the S3b, S6b (D11 branch) and S9 results.

## Implementation notes (backend-developer, 2026-10-19)

**Owner approval:** recorded under §0 — D1, D10, D12, the §3.4 separator and D15 approved; stage, don't commit.

**§6 boot gate — PASSED** on CLI 2.95.4 after `supabase stop --no-backup && npm run dev:db` (repo root):
- `docker exec supabase_edge_runtime_imr-inventory printenv …` printed all of `SEND_EMAIL_HOOK_SECRET`, `SEND_EMAIL_TRANSPORT=mailpit`, `MAILPIT_SEND_URL`, `SEND_EMAIL_FROM`, `SEND_EMAIL_FROM_NAME` — literal `[edge_runtime.secrets]` values are applied by this CLI.
- `docker exec supabase_auth_imr-inventory printenv | grep GOTRUE_HOOK_SEND_EMAIL` → `ENABLED=true`, `URI=http://host.docker.internal:54321/functions/v1/auth-email-hook`, `SECRETS=` the D7 literal (CLI accepted the literal secret format).
- Edge bind-mount check points at the repo root (`…/INVENTORY-MANAGEMENT/supabase/functions`).
- Not verifiable here: `supabase start` on CI's CLI 2.106.0 (`test.yml`) and `latest` (`e2e.yml`). Same config shape as 2.95.4 accepted; first CI run on the push is the proof (§13 risk 7).

**Headline proof (local GoTrue v2.189.0, `scripts/smoke-send-email-hook.sh`):**
- `/recover` (anon) to the placeholder fixture → **HTTP 200 `{}`**, Mailpit total **0**, and the edge log shows one `{"action":"recovery","outcome":"dropped"}` line (so GoTrue did call the hook and the hook dropped it).
- `/recover?redirect_to=http://localhost:8081/reset-password` to `manager@local.test` → **HTTP 200 `{}`**, Mailpit total **exactly 1**, To `manager@local.test`, Subject `Reset your password`, Text contains `http://localhost:8081/reset-password?token_hash=<H>&type=recovery`, HTML the `&amp;type=recovery` form; `POST /auth/v1/verify {type:recovery, token_hash:<H>}` → **200 + access_token** (S3).
- D3 confirmed: GoTrue v2.189.0 accepts `200` + `application/json` `{}`.

**Recorded results:**
- **S3b (PKCE, app-faithful): PASS.** The PKCE `/recover` mail carries a `pkce_`-prefixed `token_hash`; it redeems via `POST /verify` → 200 + access_token. The hook's `token_hash` is the template's `.TokenHash` under PKCE.
- **S6b (real invite): PASS.** D11 branch that fired locally: **the `SUPABASE_URL` fallback** (link host `kong:8000`, rewritten to `127.0.0.1:54321` by the smoke) — i.e. GoTrue's hook `site_url` is NOT `/auth/v1`-shaped on v2.189.0. GET on the link → 303 to `http://localhost:8081/register#…access_token=…`. In prod the fallback is `https://<ref>.supabase.co/auth/v1`, which is the correct verify host (custom-domain parity would need the `site_url` branch; not applicable today).
- **S9 (real secure email change): PASS, with one test-mechanics adaptation.** Local GoTrue runs `MAILER_AUTOCONFIRM=true` (`enable_confirmations = false`), so the FIRST redeemed leg completes a secure change and consumes the other leg's hash (first run: old-leg `/verify` 200, new-leg 403, email already changed). The arm therefore (a) asserts against GoTrue's own state that the old-address mail's hash = `auth.users.email_change_token_current` and the new-address mail's hash = `email_change_token_new` (the §3.2 swap is right), and (b) runs two changes — one redeemed via the current-address leg, one via the new-address leg — each `/verify` → 200 and `auth.users.email` updated. No config change; design intent (both legs' links work) is proven.
- S1, S2, S3, S4 (identical `200 {}` for placeholder / real / unknown), S5 (unsigned / wrong / stale → 401, GET → 405, signed `{}` and empty user/email_data → 400; plus an extra 70 KB → 413 arm), S6 (all 5 link/code types, all 7 notifications, `zz_future_type`, the 4 `email_change` shapes, every type to the placeholder → 0), S7 (no token/hash/address/`no-email.invalid` in hook bodies or edge logs; 49 hook log lines, all JSON with keys ⊆ the §5 set): all PASS. S8: SKIP by design (D10).

**Verification run (all green):** full `npx jest` (232 suites / 2730 tests), `npm run typecheck`, `npm run typecheck:test`, `bash scripts/smoke-send-email-hook.sh`, and full `npm run test:smoke` (exit 0; includes `smoke-store-user.sh` arm 19 "Mailpit: 0 messages to no-email.invalid" PASS with the hook enabled; the only SKIPs are pre-existing — `BOBBY_TOKEN`, the documented `username-resolve` local token — plus S8). The D15 probe script was exercised against the local function: correct secret → 200 `{}` + one "Account notification" in Mailpit; wrong secret → 401 with the mismatch hint; placeholder `--to`, missing `HOOK_SECRET`, and the local dev secret against an `https://` URL all refused.

**Small in-design choices worth a reviewer's eye (no contract change):**
- `routeLegs`: `email_change` with an empty `user.new_email` → `invalid_payload` (400), per the §3.1 example, even when the current-address pair is present.
- `renderMail`: a `recovery` leg with an empty `token_hash`, or a `signup` / `invite` leg with an empty `token_hash`, is `unlinkable` (500) rather than shipping a mail with no usable link. GoTrue always sends the hash for these, so this is fail-loud for a should-never-happen payload.
- `parsePayload`: missing / `null` fields default to `""`; a present non-string field rejects the payload (400).
- Log lines for 405 and the top-level catch carry no `reason` (the §5 enum has no fitting value); every other outcome carries one of the fixed enum values.
- The function has no `edge-runtime.d.ts` import (design §5 layout lists only the `standardwebhooks` import); it was strict-typechecked ad hoc with a `Deno` shim since no `deno` binary is installed locally.

**Not done (out of scope, unchanged):** no prod call of any kind (no deploy, no `supabase secrets set`, no MCP). Prod rollout is owner-run per §12; O1-O5 remain open and gate step 6.

## Files changed

Owner approval recorded under §0 (2026-10-19).

**Edge functions**
- `supabase/functions/auth-email-hook/index.ts` (new)

**Config**
- `supabase/config.toml` — live `[edge_runtime.secrets]` (local-only literals), `[auth.hook.send_email]` (local-only, with the `config push` warning), comment on `[auth.email.template.recovery]`, `[functions.auth-email-hook] verify_jwt = false` pin

**src/lib (jest-only canonical + tests)**
- `src/lib/authEmailHook.ts` (new — core block canonical, not imported by the app)
- `src/lib/authEmailHook.test.ts` (new — unit tests incl. the D10 Resend transport proof)
- `src/lib/authEmailHook.parity.test.ts` (new — core block + escapeHtml parity)
- `src/lib/placeholderEmail.parity.test.ts` — `COPIES` + header comment
- `src/lib/placeholderEmail.ts` — header comment only

**Scripts / test wiring**
- `scripts/smoke-send-email-hook.sh` (new)
- `scripts/probe-auth-email-hook.sh` (new, D15, owner-run, not in `test:smoke`)
- `package.json` — `test:smoke` appends `smoke-send-email-hook.sh`
- `tests/README.md` — Track 3 list (five scripts, Mailpit-wipe note)

**Spec**
- `specs/166-send-email-hook-placeholder-drop.md` — status, owner approval, implementation notes, this list

No migration, no `src/lib/db.ts` / `src/store` / frontend change, no other edge function touched, `app.json` untouched.

### Pre-commit fixes (release-proposal)

Applied 2026-10-19 by backend-developer from `reviews/release-proposal.md` §A-§B (items 1-13). The deferred items in §G (the `renderMail` refactor, `deliver()` extraction, and so on) were **not** done. No `config.toml` or `package.json` change, and no stack restart.

**Code**
- **Fix 1: secret decode-validation** (code-reviewer SF1, security L4). `parseHookSecrets` now also rejects a part whose base64 body has `length % 4 !== 0`, or that `atob` rejects (a misplaced `=`). A mis-pasted secret therefore gives 500 `hook misconfigured` instead of 401. The same edit was made in `src/lib/authEmailHook.ts` and in `supabase/functions/auth-email-hook/index.ts`, and the parity suite is green.
  - Evidence: `@stablelib/base64@1.0.1` (what `standardwebhooks@1.0.0` loads) was fuzzed against the new check, 500k strings.
    - The new check never accepts a string the library rejects.
    - The library is laxer on length: a non-multiple-of-4 body silently decodes to a different key and gives 401. The fix maps that case to 500 too, which matches GoTrue's strict Go decoder on the signing side.
  - New jest cases: non-multiple-of-4, one char short, mid-string `=`, `===`, a bad rotation slot, the D7 literal, a 44-char `openssl rand -base64 32` value, and a padded 44-char value.
  - The optional "decoded key ≥ 24 bytes" check was not added.
- **Fix 2: `Content-Length` pre-check** (security L3, architect m2). Handler only, outside the core block. A declared `Content-Length` over 64 KiB returns 413 (log reason `size`) before `req.text()`. The post-read `TextEncoder` check is kept, and the order is still method → secret → size → HMAC.
- **Fix 3: `?deps=` pin** (security L5). The import is now `https://esm.sh/standardwebhooks@1.0.0?deps=@stablelib/base64@1.0.1,fast-sha256@1.3.0`.
  - The versions are what the declared ranges (`^1.0.0`, `^1.3.0`, per `npm view standardwebhooks@1.0.0 dependencies`) resolve to today, confirmed on both npm and the esm.sh entry module.
  - Follow-up remains: `npm:` specifier plus `deno.lock`.
- **Fix 4: probe secret handling** (security L1). `scripts/probe-auth-email-hook.sh`:
  - When `HOOK_SECRET` is unset, it prompts with `read -rs`.
  - If stdin is not a TTY, it refuses.
  - The header now says the step is MANDATORY, and notes the brief `ps` visibility of `-macopt hexkey:`.
  - The 500 hint now also covers a non-decodable secret.
- **Nits:**
  - `authEmailHook.test.ts`: fixed the unfilled `%s` title.
  - `index.ts` header: added an `email_change` partial-send note (D4 / D13).
  - Smoke: `TS` renamed to `CODE_SINGLE`.
  - `placeholderEmail.parity.test.ts`: header reflowed.

**Docs / runbook**
- §0 D11 and §13 risk-2 row: annotated as resolved (S6b), with the custom-domain note (architect m1).
- O5 and step 0: no wildcard allowlist entry on a shared-hosting domain (security L2).
- Step 0: the mail-surface (M1) owner decision.
- Step 1: also snapshot `enable_signup` and whether magic-link/OTP creates users.
- Step 3: set the secret via `--env-file` from a 0600 `mktemp` file filled by `read -rs` (L1).
- Step 5: the table now covers a malformed or non-decodable secret, and 5b is **mandatory** with the no-echo prompt (L4, L1).
- Step 7: (d) `email_sent`-still-enforced probe (M1), plus a note to record latency, timeout and GoTrue version (m3).
- Step 9 and §13 risk 6: push-protection note (L6).
- `tests/README.md` Track 3:
  - a probe-script line (owner-run, not in `test:smoke`)
  - a line saying the 166 and store-user smokes run sequentially, never concurrently

**Re-verification (local, sequential, no concurrent smoke)**
- Full `npx jest`: 232 suites / 2732 tests pass (+2 new). `npm run typecheck` and `npm run typecheck:test` are clean.
- Live (the edge runtime hot-reloaded the function):
  - unsigned `{}` → 401 `invalid signature`, so the pinned import boots
  - 70 KB → 413 via the pre-check, log `reason:"size"`
  - GET → 405
  - The edge runtime also logs one `error writing a body to connection` line per early 413, because the worker answers without draining the body. It is runtime-level and benign; `req.body.cancel()` did not suppress it, so it was not added.
- Probe script, local:
  - env path → 200 plus one "Account notification"
  - TTY prompt path → 200; with a wrong-but-well-formed secret → 401 plus the mismatch hint
  - unset without a TTY → refused
- `bash scripts/smoke-send-email-hook.sh`: ALL ARMS PASSED, S8 SKIP by design. Headline re-confirmed:
  - S1: `/recover` to the placeholder → 200, Mailpit 0, plus an `outcome:dropped` log
  - S2/S3: `/recover` to `manager@local.test` → exactly one message whose `token_hash` redeems (`/verify` → 200 + access_token)
- `npm run test:smoke`: exit 0, all five scripts green. The only SKIPs are the pre-existing `BOBBY_TOKEN` and `username-resolve` token, plus S8.

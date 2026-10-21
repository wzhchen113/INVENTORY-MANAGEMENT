## Security audit for spec 166

Scope (as dispatched; the concurrent spec 167 files were ignored):
- `supabase/functions/auth-email-hook/index.ts`
- `src/lib/authEmailHook.ts` plus `authEmailHook.test.ts` and `authEmailHook.parity.test.ts`
- `src/lib/placeholderEmail.ts` and `placeholderEmail.parity.test.ts`
- `scripts/smoke-send-email-hook.sh` and `scripts/probe-auth-email-hook.sh`
- the spec 166 hunks of `supabase/config.toml`
- the `test:smoke` line in `package.json`
- the §12 runbook in the spec

I also read the shipped `standardwebhooks@1.0.0` dist (`npm pack` into a scratch dir) to confirm how verification behaves. I ran the four relevant jest suites (107/107 pass) and diffed the core block between the canonical and the Deno copy (byte-identical). I made no prod calls.

Verdict: **0 Critical, 0 High, 1 Medium, 6 Low.** Nothing blocks merge. M1 is a rollout gate: settle it at runbook steps 0/1 before step 6 (enable). It needs no code change.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- **M1. Turning the hook on may remove prod's only auth-mail send ceiling, and the D4 oracle is something an attacker can cause, not only an accident.** Refs: `supabase/functions/auth-email-hook/index.ts:620-646`, spec §13 risk 5 (`specs/166-send-email-hook-placeholder-drop.md:675-678`), §0 D4 (`:240`).
  - **What changes.** Once enabled, every non-placeholder auth mail goes out through the shared Resend account from the verified brand domain. Spec risk 5 says it is unverified whether GoTrue's `rate_limit_email_sent` still applies to hook sends.
  - **If O1 = Supabase default SMTP.** Today's ceiling is about 2 mails/hour, delivered only to team members. Enabling the hook can therefore newly open:
    - `/signup` (if `enable_signup` and Confirm email are on in prod; local has `enable_signup = true` at `config.toml:182`)
    - `/otp`
    - `/resend`
    
    These become unauthenticated paths that send mail to arbitrary addresses from the brand domain, limited only by GoTrue's per-user `max_frequency` and Resend's team rate limit.
  - **The oracle can be forced.** Resend's team limit (about 2 req/s by default) is shared with `send-po-email`, `send-invite-email`, `send-welcome-email` and `send-order-failure-email`. Saturating it makes the hook return 500 (D4). While that lasts:
    - `/recover` returns 500 for existing real-email accounts but 200 for unknown and placeholder addresses
    - so the existence oracle can be triggered by an attacker, not just by an accidental outage
    - the same burst also degrades PO, invite and order-failure mail
  - **Why this is not a code bug.** D4 itself is correct: fail-closed beats silent loss, and the behaviour matches today's SMTP-failure path. The risk sits in the prod settings the hook depends on.
  - **Fix (runbook, no code):**
    - Add to step 1 a record of `rate_limit_email_sent`, `enable_signup`, Confirm email, and whether magic-link/OTP sign-in creates users.
    - Add to step 0 (O1/O3) an owner decision: if prod is on default SMTP, or if signups are open, either close signups or accept the new mail surface in writing before step 6.
    - Add to step 7 a probe: check, using the step 1 value or a GoTrue 429 under a small burst to an owner address, that `email_sent` is still enforced with the hook on. If it isn't, file a follow-up for a per-recipient or global send cap inside the hook.

### Low
- **L1. The prod hook secret is now a "send any link to anyone from our domain" capability, and the runbook writes it to disk and to argv.** Refs: `scripts/probe-auth-email-hook.sh:14,59,69`; spec `:642` (step 3) and `:649` (step 5b).
  - **Why the secret is worth more than a normal webhook secret.** The hook trusts `user.email`, `redirect_to` and `site_url` completely from the signed payload, which is correct for GoTrue-originated calls. So anyone holding `SEND_EMAIL_HOOK_SECRET` can make the function send a real "Reset your password" mail with an attacker-chosen link, to any address, from the verified brand domain.
  - **Where the runbook leaks it:**
    - Step 3 (`supabase secrets set SEND_EMAIL_HOOK_SECRET='v1,whsec_…'`) and step 5b (`HOOK_SECRET='v1,whsec_…' bash …`) both put the literal on the command line, so it is saved in `~/.zsh_history`.
    - The probe passes the decoded key as `-macopt hexkey:<hex>` (`probe-auth-email-hook.sh:69`). That is visible in `ps` to other local users for the life of the `openssl` process.
  - **Good already:** the script unsets the secret and the key after use (`:61,70`), never echoes them, and refuses the dev literal against `https://` (`:54-57`).
  - **Fix:**
    - When `HOOK_SECRET` is unset, have the probe prompt with `read -rs HOOK_SECRET`. Change the runbook to `read -rs HOOK_SECRET && export HOOK_SECRET` (or use a leading space with `HIST_IGNORE_SPACE`).
    - For step 3, use `supabase secrets set --env-file <0600 tmp file>` and delete the file afterwards.
    - The `ps` exposure is acceptable on a single-user Mac. Note it in the script header.
- **L2. Redirect handling is a denylist, and the hook never checks link origins (defense in depth).** Refs: `index.ts:227-238` (`usableRedirect`), `:254-260` (`recoveryLink`).
  - **What is checked.** Only `javascript:`, `data:`, `vbscript:` and `file:` are refused. The check runs on the WHATWG-parsed protocol, so case and tab/newline obfuscation can't slip a `javascript:` past it. I verified this, and the jest cases cover it. Any other scheme or host from the payload goes into the link. The spec 085 native-scheme carve-out is intentional.
  - **What actually protects the link.** In practice the boundary is GoTrue's redirect allowlist (O5), since GoTrue substitutes `site_url` for any `redirect_to` that isn't allowlisted. The recovery link puts `token_hash` in the query string of the redirect host. So a wildcard allowlist entry on a domain anyone can host on (for example `https://*.vercel.app/**`) would send reset tokens to a third-party origin as soon as a victim clicks. This was already true of the spec 085 template.
  - **Fix:**
    - Make O5 explicitly forbid wildcard entries on shared-hosting domains.
    - Optionally, add an env allowlist of link origins in the hook, so a leaked secret (L1) can't produce arbitrary-host links. The tradeoff is drift with the GoTrue allowlist, which fails closed as an outage.
- **L3. Unsigned callers can make the function buffer the whole body before the 64 KiB guard runs.** Ref: `index.ts:560-561`.
  - `req.text()` reads the entire request before the size check. With `verify_jwt = false`, anyone on the internet can stream bodies up to the platform request limit, and each one also writes a `rejected` log line.
  - The impact is resource pressure on the one function every prod auth mail depends on. It is not a bypass.
  - **Fix:** reject early when `Content-Length` is over `MAX_BODY_BYTES`, and/or read the stream with a byte cap.
- **L4. The step 5 pre-enable probe can't tell a correct secret from a mis-pasted one.** Refs: `index.ts:414-423` (`parseHookSecrets`), `:529-539` (`verifySignature`); spec `:644-649`.
  - `parseHookSecrets` accepts any 32-88 character string in the base64 alphabet, including lengths that aren't a multiple of 4 and misplaced `=`. `@stablelib/base64.decode` then throws inside `new Webhook()`. That error is caught, so every call returns 401 `invalid signature`.
  - 401 `invalid signature` is exactly step 5's "proceed" signal. So a truncated or mis-pasted secret, or simply a mismatched one, passes step 5, and step 6 would then take down all auth mail.
  - Only step 5b catches it.
  - **Fix:**
    - Reword step 5b from "if D15 was approved" to mandatory (D15 was approved).
    - Optionally, have `parseHookSecrets` try decoding each part and return null when it fails, so the call gets 500 `hook misconfigured`.
  
  This is availability only, and it fails closed.
- **L5. The supply chain for the security-critical verifier floats.** Ref: `index.ts:42`.
  - `https://esm.sh/standardwebhooks@1.0.0` pins the top-level package, but its dependencies are caret ranges (`@stablelib/base64 ^1.0.0`, `fast-sha256 ^1.3.0`, confirmed in the packed `package.json`). esm.sh resolves those at deploy time.
  - This function holds `RESEND_API_KEY` and sees every recovery and confirmation token.
  - The repo precedent is looser (`supabase-js@2`), so this is not a regression.
  - **Fix:** use `npm:standardwebhooks@1.0.0` with a committed `deno.lock` for this function, or esm.sh with explicit `?deps=` pins.
- **L6. The committed dev secret's scanner-shape claim is only half true (informational).** Refs: `config.toml:323,431`; spec D7 (`:243`).
  - The D7 claim does hold for alphanumeric-only, Stripe-shaped rules: the longest alphanumeric run is 13.
  - But the literal is 48 consecutive characters from the base64 alphabet right after `whsec_`. I checked: it matches `whsec_[A-Za-z0-9+/]{32,}`. A Svix / Standard-Webhooks-style or generic base64 rule may flag it.
  - The impact is only a false-positive alert or a push-protection prompt. It is public by design, and the tripwire makes it useless for real mail (see Verified).
  - If push protection fires, mark it "used in tests". No code change is needed.

### Verified (no finding)
- **Fail-closed signature gate.** The handler order is method → secret parse → size → HMAC → parse (`index.ts:547-584`).
  - An unset or malformed secret returns 500 before any read of user data.
  - A missing, wrong or stale signature (±300 s, checked both ways in the library) returns 401.
  - `standardwebhooks@1.0.0` does a constant-time compare (`timing_safe_equal.js`, length check then XOR fold), signs `id.timestamp.body`, and requires all three headers.
  - `Object.fromEntries(req.headers)` gives lowercase keys, and the library lowercases again.
  - Rotation tries each `|` part, and errors are swallowed without logging (`:529-539`).
  - Nothing renders or sends before signature verification.
- **What an unsigned or forged caller can do (`verify_jwt = false`).** They can get 405, 413, 401, or 500 `hook misconfigured` (which only reveals that the secret is unset). They cannot reach `planMails`, the transport, or any outbound fetch. The function has no DB client and no service-role use. Replay of a captured signed request is possible within 5 minutes, but it needs the TLS-protected GoTrue→function body. On `resend`, the `Idempotency-Key: <webhook-id>:<i>` (`:621-623`) also de-duplicates a replay.
- **No `ADMIN_ROLES` gate is correct here.** It is event-driven with no caller JWT, and the config comment (`config.toml:499-506`) says so, matching the PM default. The `super_admin` parity, last-of-role and self-guard rules don't apply: there is no role-gated or destructive op.
- **Recipients come only from the signed payload.**
  - `routeLegs` (`index.ts:153-175`) uses only `user.email`, `user.new_email` and `email_data.old_email` (D12, `email_changed_notification` only).
  - `to` is the trimmed leg address, checked with the same trimmed, lowercased predicate.
  - The transport `to` is a JSON array element, so neither Resend nor Mailpit allows header injection.
  - From and FromName come only from env and are validated against `<>"\r\n` (`:440-441`).
- **Placeholder drop.**
  - The spec 165 block is byte-identical (the parity suite passes, and `auth-email-hook` is added to `COPIES`).
  - The drop happens before render and before the transport (`:395-398`).
  - `email_change` legs are tested one at a time, so a placeholder current or new leg drops only that leg. The swap pairing matches GoTrue's stored `email_change_token_current/new` (smoke S9).
  - A placeholder `old_email` is dropped.
  - An all-placeholder request returns `200 {}`, the same body as a send (`:601-604`).
  - Edge case: when `old_email` is empty, D12 falls back to `user.email`, so the alert goes to the new address rather than the displaced owner. GoTrue populates `old_email`, so this is no worse than having no alert.
- **Anti-enumeration.** Placeholder, real and unknown `/recover` give the same 200 and a byte-identical body (S4). Two oracles remain, both pre-existing GoTrue behaviour and not introduced here:
  - per-user `max_frequency` gives a 429 on a repeat request for any existing account
  - real-recipient latency now includes the provider round trip, as SMTP did
  
  Placeholder and unknown addresses look the same, which is what M1 of spec 165 needed. D4 is discussed in M1 above.
- **HTML and URL escaping.**
  - Every interpolation into the HTML body goes through the inline `escapeHtml`: intro (including `new_email`), label, link, code, and footer (`:353-375`). That function is byte-identical to `src/utils/escapeHtml.ts` (parity (c)).
  - Query parameters are `encodeURIComponent`-ed before escaping (`:259`, `:263-272`).
  - `href` attribute breakout is impossible because `"` and `'` are escaped. The jest `"><script>` cases pass.
  - No `user_metadata` is ever rendered.
  - Subjects are fixed literals.
  - `verifyBase` builds the host only from the signed `site_url` (when it ends in `/auth/v1`) or the function's own `SUPABASE_URL` (`:243-251`).
- **Log hygiene.**
  - Exactly one `console.log` per request, with fixed keys (`:509-527`).
  - `action` is sanitized to `[a-z_]{1,64}`.
  - Counts and the provider status are the only numbers logged.
  - `reason` is a closed enum.
  - The provider body is cancelled and never read (`:638-642`).
  - The top-level catch drops `e`.
  - Smoke S7 greps the response bodies and the edge logs for every hash, code and fixture address, and for `no-email.invalid`.
- **Dev-secret tripwire.**
  - `isLocalDevSecret` runs on the raw, unsplit `SEND_EMAIL_HOOK_SECRET`. So the dev literal in any rotation slot blocks the `resend` transport (`:426-428,451`), and `@resend.dev` From is also refused.
  - The worst `config push` outcome is therefore availability-only: a `host.docker.internal` URI and the public secret on prod GoTrue mean all auth mail fails, loudly, while the step 1 SMTP config stays as the rollback. It can't become a forged-mail relay.
  - The comment at `config.toml:308-319` states the footgun and the rollback.
  - Residual: nothing in the repo technically prevents `config push`, and it would also push `site_url`, `enable_signup` and the localhost redirect allowlist. That hazard predates this spec.
- **Local secret posture.** `[edge_runtime.secrets]` (`config.toml:419-435`) holds only local literals and the Mailpit URL. No prod value is committed. `RESEND_API_KEY` stays an empty placeholder in `.env.local.example`, and `.env` / `.env.local` are gitignored.
- **Scripts.**
  - The smoke refuses any non-local `SUPABASE_URL` (`smoke-send-email-hook.sh:52-60`). It reads keys from the local containers only and cleans up its `zz_s166` fixtures in an EXIT trap.
  - The probe refuses placeholder `--to`, non-hook URLs, and the dev secret against https. It sends a link-free, code-free payload.
  - Neither script logs secrets.
- **`package.json`.** Only the `test:smoke` script string changed. No dependency or lockfile change.

### Dependencies
`package.json` changed only in `scripts.test:smoke`, and `package-lock.json` is untouched. I ran `npm audit --audit-level=high` anyway: 82 findings (2 critical, 57 high, 22 moderate, 1 low), all pre-existing and transitive. The criticals are `shell-quote` and `tar`, and the highs are mostly `ws` under Expo, Metro and RN tooling. None was introduced by spec 166. The new Deno dependency (`standardwebhooks@1.0.0` via esm.sh) is outside npm audit's view; see L5.

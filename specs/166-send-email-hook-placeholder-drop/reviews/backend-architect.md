# Spec 166: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-10-19
Design reviewed against: `specs/166-send-email-hook-placeholder-drop.md` §0-§14, plus the developer's "Implementation notes" and "Files changed"

Files read:
- `supabase/functions/auth-email-hook/index.ts`
- `src/lib/authEmailHook.ts`
- `src/lib/authEmailHook.parity.test.ts`
- `src/lib/authEmailHook.test.ts` (describe/it inventory only)
- `src/lib/placeholderEmail.parity.test.ts` (the `COPIES` hunk)
- `supabase/config.toml`: the spec 166 hunks at :263-266, :308-323, :422-435 and :499-506
- `scripts/smoke-send-email-hook.sh`
- `scripts/probe-auth-email-hook.sh`
- the `package.json:18` and `tests/README.md` wiring

Staged files that belong to the concurrent spec 167 session were ignored.

## Verdict

**No Critical. No Should-fix. 6 Minor.**

The build matches the contract:
- handler order (§3.1)
- routing table (§3.2), including the D12 `old_email` rule
- subject table (§3.3)
- link mechanics (§3.4)
- error table (§3.5)
- core-block signatures (§4)
- env set and log key set (§5)
- config shape (§6)
- the D7 tripwire

The core block is byte-identical across the canonical and Deno copies, and that is parity-enforced (`authEmailHook.parity.test.ts:37-39`). The spec 165 placeholder block is in `COPIES` (`placeholderEmail.parity.test.ts:42`). Nothing touches the DB, `src/lib/db.ts`, the store, RLS, realtime or migrations. There is no bypass of `db.ts`, because there is no client surface at all.

All six developer deviations are accepted. Two of them, (3) and (4), are already inside the design text. One of them, (1), is a strictly **stronger** proof than the arm I designed.

## Deviation assessment

### (1) S9 rewritten for local `MAILER_AUTOCONFIRM`: ACCEPTED, and an improvement
`scripts/smoke-send-email-hook.sh:590-621`.

- **Why my S9 had to change.** It assumed that redeeming both legs in sequence was possible. With `enable_confirmations = false`, local GoTrue autoconfirms, so the first redeemed leg completes the change and consumes the other leg's hash. The developer observed exactly this: the old leg returned 200 and the new leg returned 403. The behaviour comes from GoTrue, not from the hook.
- **Why the replacement is better.** As I understand GoTrue's `/verify` path, the `token_hash` lookup for `email_change` matches **either** `email_change_token_current` or `email_change_token_new`. So my original "both legs redeem" arm would have passed **even if the hook had swapped the legs**. It never proved the §3.2 pairing. The new assertion (`:603-607`) does prove it: the old-address mail's hash equals `auth.users.email_change_token_current`, and the new-address mail's hash equals `email_change_token_new`. That is the only check in the suite that pins the swap against GoTrue's real state; the S6 synthetic arm only proves the function obeys its own table. The two-round redemption (`:616-618`) still proves that each leg's link is a live credential on its own.
- **What it doesn't cover.** The prod-shaped double confirmation (autoconfirm off: the first `/verify` returns "Confirmation link accepted", and the second completes the change) is not exercised locally. That sequencing belongs to GoTrue, and the hook can't affect it once the hashes match GoTrue's columns. Exposure is also low: no app code triggers `email_change`. A grep of `src/` finds only `updateUser({ password })` at `RecoveryScreen.tsx:104`. The path is reachable only through a direct `PUT /auth/v1/user`. Whether it carries real prod traffic depends on O3. No action needed.

### (2) Empty `token_hash` on recovery / signup / invite returns 500 `unlinkable`: ACCEPTED
`index.ts:255`, `:332`.

- This is a natural extension of the §3.1 step 6 `unlinkable` rule. For these three types the link is the whole point of the mail, so a link-less mail would be a silent functional loss. A loud 500 matches the D4 posture.
- GoTrue always fills `token_hash` for these types, so the branch should never fire in practice.
- The anti-enumeration cost is the same class as D4 (a 500 for a real account only), bounded by a should-never-happen input.
- jest pins it (`authEmailHook.test.ts:225`, `:255`), and the log reason stays in the fixed enum.

### (3) `email_change` with an empty `new_email` returns 400: ACCEPTED, already in the design
§3.1 step 6 literally names "`email_change` with no `user.new_email`" as `invalid_payload`. GoTrue only sends `email_change` mail when there is a pending `new_email`, so this can't trip on real traffic.

The edge case of a phone-only user adding an email (empty `user.email`, non-empty `new_email`) is handled correctly by the single-pair branch (`index.ts:159-165`).

### (4) A non-string field returns 400: ACCEPTED, already in the design
§11 lists "non-string fields" under payload validation.

- The strictness applies only to the eight named `email_data` fields plus `user.email` and `user.new_email`. GoTrue serializes all of these as strings.
- Newer GoTrue fields (`old_phone`, `provider`, `factor_type`, …) are ignored, not validated, so additive GoTrue changes can't break the hook.
- The only outage vector is GoTrue changing the **type** of one of these ten fields. Fail-loud is the right response to that, and the step 7 probes and rollback cover it.

### (5) D11 resolved to the `SUPABASE_URL` fallback: prod consequence CONFIRMED correct
**Local evidence (S6b).** GoTrue v2.189.0 fills the hook's `site_url` with its **Site URL** (the app URL, locally `http://127.0.0.1:3000`), not the API external URL. So `verifyBase` (`index.ts:243-251`) takes the `SUPABASE_URL + "/auth/v1"` branch.

**Prod.** The edge runtime injects `SUPABASE_URL = https://ebwnovzzkwhsdxkpyjka.supabase.co`, so links are `https://ebwnovzzkwhsdxkpyjka.supabase.co/auth/v1/verify?token=…&type=…&redirect_to=…`. That is byte-for-byte the host and path GoTrue's own `{{ .ConfirmationURL }}` uses on a hosted project (API external URL = `https://<ref>.supabase.co/auth/v1`). **Correct.**

**This also resolves a latent tension in my design in the right direction.** §3.4 used `site_url` as the *app* fallback for `redirect_to`, while D11 guessed `site_url` was the *API* URL. The empirical answer (Site URL = app) makes both of these correct:
- the recovery fallback (`index.ts:256`)
- the `redirect_to` fallback for verify links (`index.ts:335`)

The `site_url` branch of `verifyBase` is now effectively dead code on current GoTrue. It is harmless: it fires only on a `/auth/v1`-shaped `site_url`, which would itself be GoTrue's API URL. The synthetic S6 payloads deliberately send an API-shaped `site_url` (`smoke-send-email-hook.sh:197`), so both branches stay exercised.

**A custom auth domain would NOT break the links.**
- If the owner later activates a Supabase custom domain or vanity subdomain, GoTrue's own links would move to the branded host, but the hook's links would stay on `<ref>.supabase.co`.
- The `<ref>.supabase.co` domain keeps serving after custom-domain activation. `/verify` state (one-time tokens, PKCE flow state) lives in the DB and doesn't depend on the host. The redirect lands on the app's `redirect_to` either way.
- The impact is therefore cosmetic and deliverability-only: the link host doesn't match the branded domain, which is a minor spam-score signal.
- If the owner adopts a custom domain and wants branded links, that is a one-line follow-up inside the core block: an optional `SEND_EMAIL_VERIFY_BASE` env, or GoTrue's API URL passed in explicitly. Not needed now. See Minor m1.

### (6) 413 body cap: ACCEPTED, implemented as designed
`index.ts:559-564`.

- The guard runs after the secret check and before the HMAC, exactly per §3.1 step 3.
- It measures UTF-8 bytes via `TextEncoder`.
- The smoke proves it with an unsigned 70 KB body (`smoke-send-email-hook.sh:318-320`).
- `"size"` is in the fixed log enum.
- GoTrue doesn't retry on 413.

One refinement is noted as Minor m2.

## §12 runbook vs what was built: MATCHES

| Runbook item | Built | Match |
|---|---|---|
| Step 2 env names `SEND_EMAIL_TRANSPORT=resend`, `SEND_EMAIL_FROM` (bare addr), `SEND_EMAIL_FROM_NAME`, existing `RESEND_API_KEY` | `index.ts:44-50`; `resolveTransport` requires a bare address (`:440`), rejects `<>"\r\n` in the name (`:441`) and `@resend.dev` (`:450`) | yes |
| Step 3 secret name `SEND_EMAIL_HOOK_SECRET`, `v1,whsec_` format, `\|` rotation | `index.ts:44`, `parseHookSecrets` `:414-423` (`{32,88}`; a dashboard / `openssl rand -base64 32` secret is 44 chars) | yes |
| Step 4 `supabase functions deploy auth-email-hook … --no-verify-jwt` + config pin | `config.toml:505-506` | yes |
| Step 5 unsigned `{}` → 401 `{"error":"invalid signature"}`; unset secret → 500 `hook misconfigured`; gateway 401 means JWT is on | `index.ts:553-571`; the probe's `.message` parse handles the gateway body (`probe-auth-email-hook.sh:84-88`) | yes |
| Step 5b `HOOK_SECRET='v1,whsec_…' bash scripts/probe-auth-email-hook.sh --url <fn url> --to <owner address>` | Same flags and env (`probe…sh:14-16, 27-36, 51`). It refuses: a placeholder `--to`, a missing or malformed secret, a rotation list, and the dev secret against `https://`. Payload is the `zz_preflight_probe` generic fallback, with no link and no code. | yes |
| Step 7(b) logs show `outcome:"dropped"` with no address | `logOutcome` `:509-527` | yes |
| Step 8 rollback (disable hook; SMTP untouched) | no code dependency | yes |
| Step 10 no migration | none | yes |

The 5b probe works under all three step 3 paths (a/b/c). It exercises only the **function-side** secret, which is set in every path before step 5.

## Findings

### Critical
None.

### Should-fix
None.

### Minor

**m1. The D11 design text and the core-block comment are now known to be inaccurate.**
- Spec §0 D11 ("I believe GoTrue fills the hook's `site_url` with its API external URL") and the §13 risk-2 row ("`site_url` is the API external URL") are disproved by S6b. The implementation notes record this, but the design table still states the old belief.
- The core-block comment at `index.ts:240-242` and the canonical copy say "the payload's site_url when it is the API external URL". That is technically still accurate, because it's conditional, but it implies that is the normal case.
- Suggest:
  - annotate D11 and the §13 row as "resolved 2026-10-19: `site_url` = Site URL (app); fallback is the live branch"
  - optionally reword the comment in **both** copies in one edit (parity test enforces the pair)
- No behaviour change. Add a custom-domain note: links stay on `<ref>.supabase.co`, which still works (§(5) above).

**m2. The size guard buffers the whole body before measuring it.**
- `await req.text()` (`index.ts:560`) reads an unbounded body into memory before the 64 KiB check.
- The function is `verify_jwt = false`, so this is reachable unauthenticated. That is the same posture as every other `verify_jwt = false` function, and the hosted gateway caps request size anyway, so it is low risk.
- Optional hardening: a cheap pre-check that returns 413 when `Content-Length` is present and over `MAX_BODY_BYTES`, before `req.text()`. Keep the post-read byte check for chunked bodies. It is not a contract change.

**m3. GoTrue hook timeout and retry semantics remain unverified (§13 risk 2, last row; D13).**
- The implementation honours the budget (sequential legs, `AbortSignal.timeout(2000)` each, `index.ts:53, 622-647`), and the function never returns 429/503.
- Nothing in the build or smoke confirms the 5 s timeout or the retry set.
- Prod probes 7(a)/(b) are the first real evidence. Record the observation, or the GoTrue version, when the owner runs them. No code action.

**m4. S9 depends on local autoconfirm.**
- The comment at `smoke-send-email-hook.sh:575-581` documents this, but the arm hard-asserts `auth.users.email = new` after a **single** `/verify` (`:611-612`).
- If someone later sets local `enable_confirmations = true`, S9 fails with a misleading "auth.users.email = old" rather than a clear precondition message.
- Optional: read `GOTRUE_MAILER_AUTOCONFIRM` in preflight and branch, or SKIP the redemption half with a reason. The hash-equals-DB-column half is valid under either setting and should stay unconditional.

**m5. `isPlaceholderEmail` timing is not uniform across placeholder, unknown and real addresses.** Informational, for the security reviewer.
- A placeholder `/recover` incurs a hook round-trip.
- An unknown address incurs none.
- A real address incurs a hook round-trip plus a provider call.

The bodies and statuses are identical (S4), which is all the AC requires. The timing delta between "placeholder" and "unknown" reveals nothing new, because the attacker got the placeholder from `username-resolve` in the first place. The delta between "real" and the others predates this spec (it existed with SMTP). Recorded so it isn't rediscovered as a regression.

**m6. Unverified prod facts carried forward unchanged (not drift; restated so the release proposal doesn't lose them).**
- `supabase start` acceptance of the hook block on CI CLI 2.106.0 / `latest` is unverified (only 2.95.4 was run locally). The first CI run after push is the proof; this is the CLAUDE.md post-push gate check.
- `email_sent` applicability to hook sends is unverified (§13 risk 5; the step 1 snapshot records it).
- O1-O5 remain open and block runbook step 6.

## Contract-conformance checklist

| Item | Location | Status |
|---|---|---|
| D1 name `auth-email-hook`; `verify_jwt = false` pin with the required three-point comment | `config.toml:499-506` | OK |
| D2 `standardwebhooks@1.0.0`, per-secret try, fail closed | `index.ts:42, 529-539, 553-571` | OK |
| D3 200 + `application/json` `{}` (confirmed on v2.189.0) | `index.ts:499-504, 601-604, 649-651` | OK |
| D4 real-recipient failure returns 500, never 429/503 | `index.ts:615-646` | OK |
| D5 env-selected `mailpit` / `resend`, no SMTP | `index.ts:430-455` | OK |
| D6 From from env, no default, `@resend.dev` refused | `index.ts:438-452` | OK |
| D7 committed dev literal, both sides identical, resend tripwire | `config.toml:323, 431`; `index.ts:426-428, 451` | OK |
| D8 Mailpit HTTP send API via `[edge_runtime.secrets]` | `config.toml:433` | OK |
| D9 core block byte-identical + purity lint + escapeHtml parity | `authEmailHook.parity.test.ts:37-57` | OK |
| D10 Resend request proof in jest | `authEmailHook.test.ts:409-458` | OK |
| D12 `old_email` for `email_changed_notification` | `index.ts:166-167` | OK |
| D13 sequential legs, 2 s timeout, `Idempotency-Key: <webhook-id>:<i>` | `index.ts:621-631` | OK |
| D14 S3b / S6b / S9 present | smoke `:383-408, 534-571, 574-621` | OK (S9 adapted, see (1)) |
| D15 probe script | `scripts/probe-auth-email-hook.sh` | OK |
| Log hygiene: one line, fixed keys, enum reason, no `e.message` | `index.ts:506-527, 652-656`; S7 `:635-653` | OK |
| No user_metadata interpolated; every HTML value escaped; query params encoded before escaping | `index.ts:259, 263-273, 347-376` | OK |
| `COPIES` updated; canonical holds no placeholder literal | `placeholderEmail.parity.test.ts:42`; `authEmailHook.parity.test.ts:46` | OK |
| No migration / RLS / db.ts / store / realtime change | none | OK |

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 6 Minor findings.
payload_paths:
  - specs/166-send-email-hook-placeholder-drop/reviews/backend-architect.md

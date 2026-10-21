## Code review for spec 166

Scope: the staged spec 166 files only. I read the working-tree content of each file. This session had no shell tool, so `git diff --cached` was not run. The `config.toml`, `package.json` and `tests/README.md` hunks were located by search, and the surrounding lines were read.

Convention checklist (all pass):
- Inline `escapeHtml` is byte-identical to `src/utils/escapeHtml.ts` and is parity-tested (test case c). Every value interpolated into the HTML body goes through it.
- The spec 165 placeholder block and the new `auth-email-hook-core` block are both inline-not-shared, and both are parity-tested. `COPIES` includes the new function.
- The `[functions.auth-email-hook] verify_jwt = false` pin carries the three required statements:
  - Standard Webhooks signature, not a JWT.
  - The signature check replaces the gateway check.
  - No `ADMIN_ROLES` gate.
- The `[auth.hook.send_email]` comment carries the local-only and `config push` warnings.
- No `supabase.from/rpc` call, no legacy file touched, no `app.json` change, no new realtime channel.
- The canonical `src/lib/authEmailHook.ts` does not contain the placeholder domain literal. The spec 165 lint stays green.
- Hex colors inside the email HTML are inline CSS in a server-rendered email, the same as `send-invite-email`. The `useColors()` rule does not apply, so I did not flag them.

### Critical
None.

### Should-fix
- `supabase/functions/auth-email-hook/index.ts:418,529-538` (mirrored in `src/lib/authEmailHook.ts:373`) — **A secret that passes the shape regex but is not decodable base64 is reported as a 401 "invalid signature", not a 500 "hook misconfigured".**
  - `parseHookSecrets` accepts any `[A-Za-z0-9+/=]{32,88}`. That includes lengths that are not a multiple of 4 and `=` in the middle.
  - `verifySignature` wraps `new Webhook(secret)` and `.verify()` in one `try/catch`. If the constructor throws on bad base64 (my expectation for `standardwebhooks@1.0.0`; I did not confirm it), the failure is swallowed and the request ends as 401.
  - It still fails closed, so this is not a security hole. But the runbook (spec §12 step 5) reads `401 {"error":"invalid signature"}` as "proceed". A mis-pasted prod secret would pass that pre-enable probe. Only the optional 5b probe would catch it, and its hint text would then wrongly say the secrets differ.
  - Fix: make `parseHookSecrets` reject non-decodable parts. For example, require `m[1].length % 4 === 0` and a `try { atob(m[1]) } catch { return null }`, which is pure TS and exists in both Deno and the Node jest env. Add a jest case. Apply the change to both copies of the core block.
  - Alternatively, build the `Webhook` instances once, outside the per-request `try/catch`, and map a constructor throw to the 500.

- `supabase/functions/auth-email-hook/index.ts:317-385` (identical at `src/lib/authEmailHook.ts:272-340`) — **`renderMail` is about 70 lines doing three jobs.** It picks the link and code per action, builds the HTML, and builds the text. The link/code decision tree is also the hardest part to read, because it is spread over four branches with a special case for `signup`/`invite` in two separate places:
  - Line 332: `(signup || invite) && hash === ""` returns null.
  - Line 341: `action !== "signup" && action !== "invite"` decides whether to show the code.
  - Fix: extract `resolveLinkAndCode(action, leg, d, supabaseUrl): { link, code } | null` and `renderBody(...)`. As a small related tidy-up, `usableRedirect(d.redirect_to) ?? usableRedirect(d.site_url)` appears at lines 256 and 335. Pull it into `resolveRedirect(redirectTo, siteUrl)` so the "never any other host" rule has one home.
  - Because the block is parity-locked, change both copies in the same edit. The existing tests pin the behavior.

### Nits
- `src/lib/authEmailHook.test.ts:245` — `it.each([...])('%s renders a /verify link with type=%s', ...)` passes one argument per row. The second `%s` is never filled, so the test titles read "signup renders a /verify link with type=%s". Drop the second placeholder, or use `'%s renders a /verify link'`.

- `supabase/functions/auth-email-hook/index.ts:560-564` — The comment says "Size guard, before the HMAC", but `await req.text()` has already buffered the whole body in memory. A cheap `Content-Length` pre-check would reject an oversize body before buffering. This endpoint is unauthenticated by design. I'm raising it as a code-shape issue only. Severity is for security-auditor.

- `supabase/functions/auth-email-hook/index.ts:541-657` — The handler is about 115 lines. The delivery loop (lines 620-647) has its own nested try/catch and three failure exits. Extracting `deliver(cfg, mails, webhookId): Promise<{ ok: true } | { ok: false; reason: LogReason; status?: number }>` would make the handler read as the §3.1 steps, and would make the one jest-uncovered piece (the `fetch` outcome mapping) a self-contained function.

- `supabase/functions/auth-email-hook/index.ts:20-25,620-647` — The header says a real recipient never gets 200 unless the transport accepted it. It does not mention the partial-send case: on an `email_change` with two real legs, leg 0 can be delivered and leg 1 fail, giving a 500 after one mail has gone out. D13's Idempotency-Key covers retries of the same leg. Add one line to the header so the next reader does not "fix" it.

- `src/lib/authEmailHook.ts:287,326` — `magiclink`, `email` and `reauthentication` with neither hash nor code produce a mail with no usable content and a 200. `signup`, `invite` and `recovery` fail loudly (`unlinkable`) for the same shape. That is deliberate for the unknown-future-type "never drop" rule. For the three named types a one-line comment saying why they differ would help.

- `src/lib/authEmailHook.ts:327-329` — An empty `else if (isNotificationAction(action)) { // Plain notice }` branch exists only to skip the final `else`. Folding the notification check into the final `else` as a guard (`if (!isNotificationAction(action)) {...}`) removes the empty block.

- `scripts/smoke-send-email-hook.sh:435-486` — Terse and overlapping names: `H`, `H2`, `HA`, `HB`, `HS`, `TA`, `TB`, `TS`. `TS` (a token code in the email_change arm) reads like a timestamp next to `SIG_TS` in the helpers. Rename it, for example `CODE_SINGLE`.

- `scripts/smoke-send-email-hook.sh:42-47` — The header says "Fixtures (all removed by the EXIT trap)", while a later `Each script accepts SUPABASE_URL= to point at a remote stack` sentence in `tests/README.md:432` is now misleading for this script and `smoke-store-user.sh`, since both refuse non-local URLs. This is pre-existing text for the store-user script, so (out-of-scope) beyond a one-line reword.

- `scripts/probe-auth-email-hook.sh:49,69` — The probe is not in the `scripts/smoke-*.sh` pattern that `tests/README.md` Track 3 describes, and the README does not mention it. It is a prod owner tool, not a test, so the name is fine. One line under Track 3 ("`probe-auth-email-hook.sh` is an owner-run prod pre-enable probe, not part of `test:smoke`") would stop a future reader from treating it as a stray test file. Separately, the HMAC key is passed via `-macopt hexkey:` on the command line, so it is briefly visible in `ps` on the owner's machine (defer to security-auditor).

- `src/lib/placeholderEmail.parity.test.ts:3-7` — The re-wrapped header now attaches "(spec 166 added auth-email-hook)" mid-sentence before the reserved-username clause, and the "(spec 027 §4.2: shared `_shared/` modules…" parenthetical is split across lines awkwardly. Reflow to two sentences.

- (out-of-scope) `src/utils/escapeHtml.ts:1-5` — The header lists only `send-invite-email` and `send-welcome-email` as inline copies. `auth-email-hook` is now a third, parity-tested one. The file is unchanged and not in scope, so this is a follow-up note only.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 2 Should-fix, 11 Nit.
payload_paths:
  - specs/166-send-email-hook-placeholder-drop/reviews/code-reviewer.md

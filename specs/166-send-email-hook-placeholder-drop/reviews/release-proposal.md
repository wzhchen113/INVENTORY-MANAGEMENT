# Release proposal: spec 166 (Send Email hook, placeholder drop)

Author: release-coordinator, 2026-10-19. Advisory only. The owner decides and commits.

Sources read directly:
- `specs/166-send-email-hook-placeholder-drop.md` (all 769 lines, including §0-§14, Implementation notes and Files changed)
- `specs/166-send-email-hook-placeholder-drop/reviews/code-reviewer.md`
- `specs/166-send-email-hook-placeholder-drop/reviews/security-auditor.md`
- `specs/166-send-email-hook-placeholder-drop/reviews/test-engineer.md`
- `specs/166-send-email-hook-placeholder-drop/reviews/backend-architect.md`

I made no edits to the spec, the code or the reviewer files, and I ran no `gh` commands. The latest CI state on `main` is **not verified by me**.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer found a Critical defect and all 39 automatically testable criteria pass. However, the test-engineer recorded two NOT TESTED items as Critical holds: D3 (CI boot on CLI 2.106.0 / latest) and G2 (prod probes). Separately, the CLAUDE.md CI-green rule can't be met yet, because this change is staged but not committed and `main` already carries an unpushed commit (spec 165, `afe181e`). There are also two cheap correctness and safety fixes, one Should-fix and two Low items, that are worth landing before the commit.

Hold status at a glance:

| Gate | Status | Blocks |
|---|---|---|
| Any reviewer Critical (defect) | None (0 / 0 / 0 / 0) | — |
| test-engineer D3: CI boots with the `[auth.hook.send_email]` + `[edge_runtime.secrets]` blocks on CLI 2.106.0 (`test.yml`) and CLI `latest` (`e2e.yml`) | NOT TESTED. Only possible after the push | SHIP_READY, until the first post-push runs are green |
| CLAUDE.md: latest `test.yml` **and** `db-migrations-applied.yml` on `main` are green | No run exists for this change. `afe181e` (spec 165) is also unpushed, so the push will carry both specs | SHIP_READY |
| `e2e.yml` (project memory: manual check) | Same as above. It floats CLI `latest`, so it is the most likely place a config-schema problem shows up | Check manually |
| test-engineer G2: prod probes (steps 5, 5b, 7a-c) | NOT TESTED by design. Owner-run | **Prod enablement (runbook step 6)**, not the commit |
| O1-O5 owner inputs | Open | **Prod enablement (runbook step 6)**, not the commit or the deploy |

## Findings summary
- **code-reviewer: 0 Critical, 2 Should-fix, 11 Nits.**
  - SF1: a secret that passes the shape regex but is not decodable base64 makes `new Webhook()` throw. The throw is swallowed and the request returns **401 "invalid signature"** instead of **500 "hook misconfigured"**. So a mis-pasted prod secret passes the runbook step 5 "proceed" signal. It still fails closed (`index.ts:418,529-538`, mirrored at `src/lib/authEmailHook.ts:373`).
  - SF2: `renderMail` is about 70 lines doing three jobs, with the signup/invite special case split across two places. Suggested extraction: `resolveLinkAndCode` / `renderBody` / `resolveRedirect`. Readability only, no behaviour change.
  - Notable nits:
    - the `%s` that never gets filled in a jest title (`authEmailHook.test.ts:245`)
    - `Content-Length` pre-check (see security L3)
    - the handler is about 115 lines; suggest extracting `deliver()`
    - the partial-send case for `email_change` is undocumented in the header
    - no README line for the probe script
    - terse smoke variable names (`TS` reads like a timestamp)
    - reflow of the `placeholderEmail.parity.test.ts` header
- **security-auditor: 0 Critical, 0 High, 1 Medium, 6 Low.** Nothing blocks merge.
  - **M1 (rollout gate, runbook only):** enabling the hook may remove prod's only auth-mail send ceiling. If prod is on default SMTP or signups are open, `/signup`, `/otp` and `/resend` become brand-domain mail paths. Saturating the shared Resend limit also turns D4's fail-closed 500 into an existence oracle an attacker can trigger. The fix is to add records, an owner decision and a probe to runbook steps 0, 1 and 7.
  - **L1:** the prod hook secret amounts to the ability to send any link to anyone from the brand domain. The runbook puts it in shell history (steps 3 and 5b), and the probe passes the HMAC key on argv (`-macopt hexkey:`, visible in `ps`).
  - **L2:** redirect handling is a scheme denylist. The real boundary is GoTrue's allowlist (O5), so a wildcard entry on a shared-hosting domain would leak reset tokens. The app itself is hosted on `*.vercel.app`.
  - **L3:** `req.text()` buffers the full unauthenticated body before the 64 KiB guard runs.
  - **L4:** same root cause as code-reviewer SF1. The step 5 probe can't tell a good secret from a mis-pasted one, so step 5b should be mandatory and `parseHookSecrets` should decode-validate.
  - **L5:** `esm.sh/standardwebhooks@1.0.0` pins the top-level package, but its deps (`@stablelib/base64 ^1.0.0`, `fast-sha256 ^1.3.0`) float at deploy time.
  - **L6 (informational):** the committed dev secret matches a generic `whsec_[A-Za-z0-9+/]{32,}` scanner shape, so GitHub push protection may fire.
  - Verified clean:
    - the fail-closed signature gate, with a constant-time compare in the library
    - recipients come only from the signed payload
    - placeholder legs are dropped before render
    - anti-enumeration
    - HTML and URL escaping
    - log hygiene
    - the dev-secret tripwire
    - local secret posture
  - The 82 `npm audit` findings are all pre-existing.
- **test-engineer: 41 criteria, 39 PASS, 0 FAIL, 2 NOT TESTED (D3 CI boot, G2 prod probes).** Each NOT TESTED item is treated as a Critical hold until the first CI run on `main` is green.
  - Full `npx jest` passed 232/232 suites and 2730 tests, with the concurrent spec 167 tests included.
  - Both typechecks are clean.
  - `smoke-send-email-hook.sh` ALL ARMS PASSED; S8 is SKIPped by design (D10).
  - `smoke-store-user.sh` ALL ARMS PASSED, including arm 19, with the hook enabled.
  - The S9 rewrite was assessed as a stronger proof than the original design.
  - Gaps (non-blocking):
    - the handler-level fail-closed branches have no repo test; they were probed live ad hoc and returned 500 "delivery failed"
    - single-pair (non-secure) `email_change` is only proven with synthetic payloads
    - the S9 unredeemed leg is proven by hash equality only
  - Operational note: the 166 smoke wipes the shared local Mailpit. Don't run it at the same time as a 167 session or `smoke-store-user.sh`.
- **backend-architect (post-impl): 0 Critical, 0 Should-fix, 6 Minor.** The build matches the §3-§6 contract and the §12 runbook, and all six developer deviations are accepted.
  - **m1:** D11 and the §13 risk-2 row are disproved. GoTrue's hook `site_url` is the app Site URL, so the `SUPABASE_URL` fallback is the live branch, and it is correct for prod. Annotate the spec; optionally reword the core-block comment in both copies.
  - **m2:** the `Content-Length` pre-check (same as security L3).
  - **m3:** the GoTrue hook timeout and retry behaviour are still unverified. Record what the step 7 probes show.
  - **m4:** S9 depends on local autoconfirm. Add a precondition check.
  - **m5:** timing differences, informational.
  - **m6:** restates the unverified facts: CI CLI acceptance, `email_sent` applicability to hook sends, and O1-O5.

## Recommended next steps (ordered)

The order is: pre-commit code fixes, then pre-commit doc and runbook edits, then re-verification, then a separate commit for spec 166, then the post-push CI gates, then the owner-run prod rollout. Severity comes first, then dependency.

### A. Pre-commit code fixes (backend-developer; stage, don't commit)

1. **Decode-validate hook secrets in `parseHookSecrets`. Both parity copies. Should-fix (code-reviewer SF1 + security L4).** This goes first because it changes what runbook step 5 means, and it touches the parity-locked core block, which every later core-block edit has to stay in step with.
   - Edit **both** `src/lib/authEmailHook.ts` and `supabase/functions/auth-email-hook/index.ts` in the same edit. `authEmailHook.parity.test.ts` enforces byte-identity.
   - Reject any `|`-part whose base64 body has `length % 4 !== 0`, or where `try { atob(part) } catch { return null }` fails. `atob` exists in both Deno and the jest Node env.
   - Optionally, also require that the decoded key length is at least 24 bytes. That keeps the D7 dev literal (36 bytes) and a dashboard or `openssl rand -base64 32` secret (32 bytes) valid.
   - Add jest cases to `src/lib/authEmailHook.test.ts`:
     - non-multiple-of-4 length → null
     - mid-string `=` → null
     - the D7 literal is still accepted
     - a 44-char `openssl rand -base64 32` value is still accepted
   - Result: a mis-pasted prod secret now gives 500 `hook misconfigured` at step 5 instead of the misleading 401.
2. **`Content-Length` pre-check before `req.text()`. Low (security L3, architect m2, code-reviewer nit).** Handler only, in `supabase/functions/auth-email-hook/index.ts:559-564`. This is outside the core block, so there is no parity impact.
   - If `Content-Length` is present and over `MAX_BODY_BYTES`, return 413 with log reason `size` **before** buffering.
   - Keep the post-read `TextEncoder` byte check for chunked or absent `Content-Length`.
   - Keep the existing order: method, then secret parse, then the size checks, then HMAC.
   - The existing 70 KB smoke arm should now hit the pre-check, so no new arm is needed.
3. **Pin `standardwebhooks`' transitive deps. Low (security L5).** Edit only the import line in `index.ts:42`.
   - Use `https://esm.sh/standardwebhooks@1.0.0?deps=@stablelib/base64@<exact>,fast-sha256@<exact>`, with the exact versions esm.sh resolves today. The developer should look them up rather than guess.
   - I recommend doing this before commit because it is a one-line change and the first prod deploy should ship the pinned verifier.
   - The stronger fix (`npm:standardwebhooks@1.0.0` plus a committed `deno.lock`) is a follow-up; see section F.
4. **Probe script secret handling. Low (security L1).** `scripts/probe-auth-email-hook.sh`.
   - When `HOOK_SECRET` is unset, prompt with `read -rs HOOK_SECRET` instead of refusing. Keep the existing env path for non-interactive use.
   - Add a header note that the decoded key is passed to `openssl` via `-macopt hexkey:`, so it is briefly visible in `ps`. The auditor rates that acceptable on a single-user Mac.
   - Removing the key from argv entirely (for example HMAC via a stdin-fed helper) is optional. The auditor did not require it, so I list it under follow-ups.
5. **Cheap nits, batched while the files are open. Nit, optional but recommended.**
   - `src/lib/authEmailHook.test.ts:245`: drop the second `%s` from the `it.each` title.
   - `index.ts` header (lines 20-25): add one line on the `email_change` partial send (leg 0 delivered, leg 1 fails, so the hook returns 500 after one mail has gone out; the Idempotency-Key covers retries). This is outside the core block.
   - `scripts/smoke-send-email-hook.sh:435-486`: rename `TS` (a token code) to something like `CODE_SINGLE`, so it isn't confused with `SIG_TS`.
   - `src/lib/placeholderEmail.parity.test.ts:3-7`: reflow the header into two sentences.
   - Leave these for SF2 (section F) so the core block isn't churned twice:
     - the empty `else if (isNotificationAction)` branch and the magiclink/email/reauth "why they differ" comment (`authEmailHook.ts:287,326-329`)
     - optionally, the m1 core-block comment rewording

### B. Pre-commit doc and runbook edits (spec 166 §12 and §0/§13; backend-developer or architect owns the spec text)

6. **Runbook additions for security M1 (Medium; rollout gate, no code).**
   - **Step 1 (snapshot):** also record `rate_limit_email_sent`, `enable_signup`, Confirm email, and whether magic-link/OTP sign-in creates users.
   - **Step 0 (O1/O3):** add an explicit owner decision. If prod is on default SMTP **or** signups are open, either close signups or accept the new brand-domain mail surface in writing before step 6.
   - **Step 7:** add a probe that `email_sent` is still enforced with the hook on. Either compare with the step 1 value, or look for a GoTrue 429 under a small burst to an owner address. If it is not enforced, file a follow-up for a send cap inside the hook (section F).
7. **Make step 5b mandatory. Low (security L4).** Reword "5b (if D15 was approved)" as a required step; D15 was approved. Update the step 5 interpretation table so that 500 `hook misconfigured` now also covers a malformed or non-decodable secret, after fix 1.
8. **Keep the secret out of shell history. Low (security L1).**
   - Step 3: replace the inline `supabase secrets set SEND_EMAIL_HOOK_SECRET='v1,whsec_…'` with `supabase secrets set --project-ref ebwnovzzkwhsdxkpyjka --env-file <0600 tmp file>`, then delete the file.
   - Step 5b: replace the inline `HOOK_SECRET='…'` with `read -rs HOOK_SECRET && export HOOK_SECRET`, or rely on the new prompt from fix 4.
9. **O5 allowlist rule. Low (security L2).** State in O5 and step 0 that the prod `redirect_to` allowlist must contain **no wildcard entries on shared-hosting domains**, for example `https://*.vercel.app/**`. The app's own host is `hopeful-lewin.vercel.app`, so this is a realistic misconfiguration, and a recovery `token_hash` would leak to a third-party origin.
10. **D11 and §13 annotations. Minor (architect m1).**
    - Annotate §0 D11 and the §13 risk-2 row "`site_url` is the API external URL" with: "resolved 2026-10-19 (S6b): hook `site_url` = Site URL (app); the `SUPABASE_URL` fallback is the live branch and is correct for prod."
    - Add the custom-domain note: links stay on `<ref>.supabase.co`, which still works; a `SEND_EMAIL_VERIFY_BASE` env is a future option.
11. **Step 7 observation note. Minor (architect m3).** Add a line asking the owner to record the observed hook latency and timeout behaviour, or the prod GoTrue version, when running probes 7(a)/(b).
12. **Push-protection note. Informational (security L6).** Add to step 9 or §13 risk 6: if GitHub push protection flags the D7 literal on push, mark it "used in tests". It is public by design and tripwired against `resend`.
13. **`tests/README.md` Track 3. Nit (code-reviewer).** Add one line: "`scripts/probe-auth-email-hook.sh` is an owner-run prod pre-enable probe, not part of `test:smoke`." Also add a note to run `smoke-send-email-hook.sh` and `smoke-store-user.sh` sequentially, never concurrently (test-engineer note 5: shared Mailpit wipe).

### C. Re-verify before staging the final state (blocking for the commit)

14. After items 1-13, re-run:
    - full `npx jest` (not a subset; project memory)
    - `npm run typecheck`
    - `npm run typecheck:test`
    - `bash scripts/smoke-send-email-hook.sh`
    - the full `npm run test:smoke`
    
    Run them **sequentially**, with no concurrent spec 167 smoke run against the shared Mailpit. Confirm `authEmailHook.parity.test.ts` and `placeholderEmail.parity.test.ts` are green after the core-block edit.

### D. Commit spec 166 separately from spec 167 (owner)

15. The index currently mixes spec 166 and spec 167. **These paths belong to spec 166.** Commit exactly these, after checking the three shared-looking files below:
    - `supabase/functions/auth-email-hook/index.ts` (new)
    - `supabase/config.toml`: spec 166 hunks only, at roughly lines 263-266, 308-323, 422-435 and 499-506
    - `src/lib/authEmailHook.ts` (new)
    - `src/lib/authEmailHook.test.ts` (new)
    - `src/lib/authEmailHook.parity.test.ts` (new)
    - `src/lib/placeholderEmail.parity.test.ts`
    - `src/lib/placeholderEmail.ts`
    - `scripts/smoke-send-email-hook.sh` (new)
    - `scripts/probe-auth-email-hook.sh` (new)
    - `package.json`: the `test:smoke` line only
    - `tests/README.md`: the Track 3 list, the spec 166 entry and the line-429 example
    - `specs/166-send-email-hook-placeholder-drop.md`
    - `specs/166-send-email-hook-placeholder-drop/reviews/` (all five files). **This directory is currently untracked (`??`), so it needs `git add`.**

    **These paths are NOT spec 166.** They belong to spec 167 or another session; leave them out of the 166 commit:
    - `specs/167-store-user-audit-trail.md` and `specs/167-store-user-audit-trail/reviews/*`
    - `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
    - `src/screens/cmd/sections/AuditLogSection.tsx` and `src/screens/cmd/sections/__tests__/AuditLogSection.storeUser.spec167.test.tsx`
    - `src/screens/cmd/sections/phone/PhoneAuditLog.tsx` and `src/screens/cmd/sections/phone/__tests__/PhoneAuditLog.test.tsx`
    - `src/types/index.ts`, `src/utils/enumLabels.test.ts`, `src/utils/formatAuditAction.ts`
    - `supabase/functions/delete-user/index.ts`, `supabase/functions/manage-store-user/index.ts`
    - `scripts/smoke-store-user.sh` (spec 167 audit arms A1-A9/AF), `scripts/smoke-edge-roles.sh`

    **Check before committing.** Run `git diff --cached -- package.json tests/README.md supabase/config.toml`. If any spec 167 hunk is present, split with `git restore --staged -p` / `git add -p`.
    - What I confirmed by search: the only `spec 16x` markers in `config.toml` are spec 166, and `package.json`'s `test:smoke` change is the spec 166 append.
    - What I did not confirm: that spec 167 has no other hunks in these three files.

### E. Post-push CI gates (the agent after the push; required before any SHIP_READY)

16. The push to `main` will carry `afe181e` (spec 165) **and** the spec 166 commit, plus spec 167's commit if pushed together. Afterwards:
    - Confirm the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` are green: `gh run list --branch main --workflow test.yml --limit 1` and `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`.
    - Check `e2e.yml` manually (project memory).
    - **The first green `test.yml` and `e2e.yml` runs are the only proof of test-engineer D3**: CLI 2.106.0 and `latest` accept `[auth.hook.send_email]` with the literal secret plus the literal `[edge_runtime.secrets]`.
    - If either gate is red or still running, surface the run URL and stop.
    - Possible red causes specific to this spec:
      - CLI schema validation of the hook block or secret
      - `[edge_runtime.secrets]` handling on newer CLIs
    - Spec 166 adds no migration, so `db-migrations-applied` reflects spec 165 and earlier.
    - SHIP_READY is withheld until these runs are green.

### F. Owner-run prod rollout gates (spec §12; not commit blockers, but they block hook enablement)

17. **Spec 165 rollout K** lands first or together with this one. Probe 7(b) needs `manage-store-user` in prod.
18. **O1-O5** are answered and recorded in the spec before step 3/6, including the M1 decision (item 6) and the O5 no-wildcard check (item 9).
    - O1 matters most for priority: on default SMTP, enabling the hook **newly** delivers real recovery mail and newly opens the M1 surface.
    - O2 needs a verified Resend sending domain. `@resend.dev` is refused by code.
19. **Steps 1-4** in order: snapshot without editing SMTP; transport secrets; hook secret with the hook still disabled, set via `--env-file`; deploy with `--no-verify-jwt`.
20. **Step 5 + 5b (now mandatory).** Unsigned POST → 401 `invalid signature`, not a gateway body. The probe script → 200 plus one "Account notification" from the expected From. This is the first real exercise of the Resend `fetch` (D10 gap).
21. **Step 6:** enable. **Step 7 probes (test-engineer G2):** (a) a real owner `/recover` end to end; (b) a placeholder `zz_probe166` gives no send and a `dropped` log; (c) if O3 shows notifications on, `set_password` sends nothing; (new) `email_sent` is still enforced.
22. **Step 8 rollback:** disable the hook in the dashboard if any probe fails, any report of missing mail comes in, or `outcome:"failed"` lines arrive in bursts.

### G. Follow-ups (do not block commit or ship; owner may pull any forward)
- **code-reviewer SF2, the `renderMail` refactor.** Extract `resolveLinkAndCode` / `renderBody` / `resolveRedirect`, then fold in the empty notification branch, the magiclink/email/reauth comment and the m1 comment rewording.
  - Deferred because it is readability with no behaviour change.
  - It touches the parity-locked block in both copies, so it would need a full smoke re-run.
  - Prod enablement is gated on O1-O5 anyway, so there is time to do it as a contained post-commit change before enablement. Pull it forward if you would rather edit the core block once alongside fix 1.
- **Extract `deliver()` from the handler** (code-reviewer nit). This would make the one jest-uncovered piece, the fetch outcome mapping, self-contained.
- **Smoke arm for the handler fail-closed path** (test-engineer note 2). A signed payload to a deliberately malformed real recipient should give 500 `delivery failed`. It needs no config change.
- **S9 autoconfirm precondition** (architect m4). Read `GOTRUE_MAILER_AUTOCONFIRM` in preflight and SKIP the redemption half with a reason; keep the hash-equality half unconditional.
- **L5, stronger form:** `npm:standardwebhooks@1.0.0` plus a committed `deno.lock` for this function.
- **L1, optional:** remove the HMAC key from `openssl` argv in the probe script.

## Out of scope for this review
- **A send cap inside the hook** if step 7 shows `email_sent` is not enforced for hook sends (security M1 follow-up). This needs its own spec.
- **An env allowlist of link origins inside the hook** (security L2 optional). It drifts from the GoTrue allowlist and fails closed as an outage, so it needs a design decision.
- **`SEND_EMAIL_VERIFY_BASE` / custom-domain branded verify links** (architect m1). Only relevant if a Supabase custom domain is adopted.
- **A live proof of non-secure (single-pair) `email_change` against real GoTrue** (test-engineer residual 2; needs `secure_email_change_enabled=false` and a restart). No app code path triggers `email_change` today.
- **`send-invite-email` swallowing `inviteUserByEmail` errors** (spec §13 risk 11). Pre-existing.
- **Moving `send-invite-email`, `send-welcome-email`, `send-po-email` and `send-order-failure-email` off `onboarding@resend.dev`.** Explicitly out of scope in the spec.
- **`username-resolve` hardening and CAPTCHA on `/recover`.** Explicitly out of scope in the spec.
- **A repo guard against `supabase config push`**, which would also push `site_url`, `enable_signup` and the localhost allowlist. A pre-existing hazard.
- **`src/utils/escapeHtml.ts` header** listing only two inline copies; `auth-email-hook` is now a third (code-reviewer, out of scope).
- **`tests/README.md:432`**: the pre-existing "Each script accepts `SUPABASE_URL=`" sentence is misleading for the local-only smokes (code-reviewer, out of scope beyond a one-line reword).
- **82 pre-existing `npm audit` findings** (2 critical: `shell-quote`, `tar`; 57 high, mostly `ws` under Expo/Metro/RN). None was introduced by spec 166.
- **Timing differences between placeholder, unknown and real `/recover`** (architect m5). Informational; nothing new is revealed.

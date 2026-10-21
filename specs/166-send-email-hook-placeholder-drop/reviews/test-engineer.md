## Test report for spec 166

Reviewer: test-engineer, 2026-10-19. Read-only against code. No stack restart, no prod call.
Only file written outside this report: a throwaway probe in the session scratchpad (not in the repo).

### Acceptance criteria status

Legend: PASS = automated proof ran green in this review. PASS (static) = verified by code inspection plus unit tests, with no live arm. NOT TESTED = cannot be proven before the push or before the owner acts.

**A. Hook function: contract and safety**
- A1 New edge function exists (renamed `auth-email-hook`, D1 approved) → PASS. `supabase/functions/auth-email-hook/index.ts`. Smoke preflight proves it is served and GoTrue calls it (S1 "hook was invoked and logged outcome:dropped").
- A2 `[functions.auth-email-hook] verify_jwt = false` pinned, with the three-point comment → PASS (static). Staged `supabase/config.toml` diff has the pin plus the comment (Standard Webhooks signature not JWT, signature replaces gateway check, event-driven with no ADMIN_ROLES gate). Live: the unsigned POST returns the function's own `{"error":"invalid signature"}`, not a gateway body (smoke P).
- A3 Signature mandatory and fail-closed → PASS. `smoke-send-email-hook.sh` S5: no headers 401, wrong signature 401, stale timestamp (now-600s) 401. Mailpit stays at 0. Secret unset or malformed → `parseHookSecrets` null → 500 `hook misconfigured` before any send. Covered by `authEmailHook.test.ts::hook secrets` (unset, missing prefix, length, illegal chars) plus handler inspection. The handler wiring for the unset-secret branch has no live arm, because env is fixed per container (see Notes 2).
- A4 POST only (405). Signed malformed payload (400) → PASS. S5: GET 405, signed `{}` 400, signed `{"user":{},"email_data":{}}` 400, and an extra 70 KB body 413. Jest: `parsePayload` cases.
- A5 Recipients only from the signed payload → PASS (static). `routeLegs` uses only `user.email`, `user.new_email` and `email_data.old_email` (D12, approved). The function has no DB client and no other recipient source. Jest: `routeLegs (§3.2)`.
- A6 Placeholder drop (no render and no transport call, 200 `{}` when all dropped, one-real-leg `email_change` sends only the real leg) → PASS. Smoke: S1 (recover to placeholder, total 0), S6 "every type addressed to the placeholder + placeholder old_email → 200 {}, total 0", S6 email_change placeholder-current+real-new = exactly 1, S6 real-current+placeholder-new = exactly 1. Jest: `placeholder drop before render` (5 tests, including "dropped even when otherwise unlinkable"). Byte-identical placeholder block: `placeholderEmail.parity.test.ts` (includes `auth-email-hook` in `COPIES`).
- A7 Anti-enumeration → PASS. S4: identical status 200 and byte-identical body `{}` for the placeholder, `manager@local.test`, and a non-existent address.
- A8 No silent loss for real recipients (non-2xx) → PASS. No repo test drives the handler's transport-failure branch. I probed it live and ad hoc (not committed): a signed `password_changed_notification` to a malformed real recipient made Mailpit answer 400, and the hook returned **HTTP 500 `{"error":"delivery failed"}`** with log `outcome:"failed", status:400, reason:"transport"`. Config-null (bad transport or From) → 500 is unit-tested through `resolveTransport`. See Notes 2 for the gap.
- A9 Log hygiene → PASS. S7: no hook response body and no edge log contains any captured hash or token, fixture address, or `no-email.invalid`. All 49 hook log lines are JSON with keys ⊆ {hook, action, outcome, recipients, dropped, status, reason}. The catch returns the generic `internal error` with no `e.message` (inspected). Caveat: 6-digit codes are exempted from the log grep (timestamp collisions).
- A10 HTML escaping → PASS. Jest `content::escapes interpolated values in HTML, leaves Text raw`, and `authEmailHook.parity.test.ts` (c) asserts the inline `escapeHtml` is byte-identical to the mirror. Query params are encoded before escaping (jest verify-link and recovery-link tests; S2 asserts the `&amp;type=recovery` HTML form).

**B. Rendering**
- B1 Recovery (exact link `<redirect_to>?token_hash=<hash>&type=recovery`, subject "Reset your password", redirect fallback) → PASS. S2 asserts To, Subject, the exact Text link and the HTML `&amp;` form. S3 redeems it (`/verify` 200 with access_token). S3b redeems the PKCE-shaped mail (`pkce_` hash). Jest `recovery link (spec 085 parity)`: separator, encoding, site_url fallback, `javascript:` rejection, unlinkable.
- B2 Signup → PASS. S6 `signup` (1 message, "Confirm your email", link form `/verify?token=<hash>&type=signup&redirect_to=`). Jest `verify link (D11)`.
- B3 Invite, carrying redirectTo → PASS. S6 synthetic invite. S6b is a real GoTrue `/invite?redirect_to=…/register`; the link GET returns 303 to `localhost:8081/register` with `access_token=`. Jest "invite carries send-invite-email redirectTo through".
- B4 Magic link and `email` OTP → PASS. S6 `magiclink` and `email` (subjects). Jest "magiclink / email / email_change also show the code".
- B5 Email change (swapped-hash rule, single-pair, per-leg drop) → PASS, with the caveat in B5 below. S6 secure: 2 messages, current gets `token_hash_new`+`token`, new gets `token_hash`+`token_new`. S6 single-pair: 1 message to `new_email`. The two mixed placeholder cases are covered (A6). S9 uses real GoTrue (see assessment). Jest `routeLegs` has four shapes.
  - Caveat: the single-pair case (secure change off) is proven only with a synthetic payload, because the local GoTrue runs with secure change on. The AC asked the architect to confirm which fields GoTrue really sends in that mode, and no live proof exists.
- B6 Reauthentication (code, no link) → PASS. S6 plus jest "reauthentication: code, no link".
- B7 All `*_notification` types (generic notice, type-specific subject, no link) → PASS. S6 covers all seven subjects. Jest "notifications contain no http and no token".
- B8 Unknown future type is never dropped → PASS. S6 `zz_future_type` gives 1 message "Account notification". Jest "an unknown type gets a link with a hash, a code with a token, and is never dropped".
- B9 Visual parity not required (informational) → PASS (n/a).

**C. Delivery channel**
- C1 Env-selected transport → PASS (static plus live). `SEND_EMAIL_TRANSPORT` switches mailpit/resend. Jest `resolveTransport`.
- C2 Local Mailpit path → PASS. Every smoke arm delivers via Mailpit from inside the edge runtime.
- C3 Prod transport (Resend HTTP) → PASS (static). Jest only; the `fetch()` call itself is not run (D10, approved).
- C4 From and name from env, no `onboarding@resend.dev`, unset From → non-2xx → PASS. Jest "bad From / From name → null", "resend refuses @resend.dev", and the local dev-secret tripwire.
- C5 Each transport has at least one automated proof → PASS. Mailpit via smoke. Resend via `authEmailHook.test.ts::buildTransportRequest (prod-transport proof, D10)` (URL, auth header, idempotency key, from with and without name, to, subject, link in html and text). This is the approved D10 spec deviation (jest instead of an S8 stub). S8 prints SKIP by design. The proof covers request construction and status classification only, not real Resend behaviour.

**D. Local config and secret**
- D1 `[auth.hook.send_email]` enabled in config.toml → PASS. Staged diff, and smoke preflight "GoTrue Send Email hook enabled".
- D2 Secret reaches GoTrue and the edge runtime with no manual step → PASS for runtime state. Preflight "GoTrue and edge-runtime hook secrets match" passed against the running stack. I did not repeat a clean `supabase stop --no-backup` start, as instructed. That clean-start gate is evidenced only by the developer's notes (CLI 2.95.4).
- D3 CI still boots (`test.yml` on CLI 2.106.0, `e2e.yml` on CLI latest) → **NOT TESTED**. This is not provable pre-push. Spec §13 risk 7 acknowledges it ("first CI run on the push is the proof"). The release-coordinator must hold SHIP_READY until `test.yml`, `db-migrations-applied.yml` and `e2e.yml` (manual) are green on `main` after the push.
- D4 `config push` warning comment → PASS (static). In the staged config diff.
- D5 Local transport config boots with no manual step → PASS (same evidence as D2; the Mailpit URL and From are present in the running edge runtime).

**E. jest**
- E1 `COPIES` includes the new function, and the five existing copies still pass → PASS. `src/lib/placeholderEmail.parity.test.ts` (diff verified). Also `src/lib/authEmailHook.parity.test.ts` for the core block.
- E2 Full `npx jest`, `npm run typecheck`, `npm run typecheck:test` → PASS (counts below).

**F. Local smoke**
- F1 Script exists, wired into `test:smoke`, listed in `tests/README.md` → PASS. `package.json` and the README diff verified.
- F2 Setup (Mailpit cleared, placeholder fixture via `manage-store-user`, EXIT trap deletes it) → PASS. Run output: "Mailpit cleared", "placeholder fixture … via manage-store-user", "removed zz_s166 users".
- F3 S1 → PASS. S2 → PASS. S3 → PASS. S4 → PASS. S5 → PASS. S6 → PASS. S7 → PASS (each as in A and B above).
- F4 S8 (prod-transport proof) → PASS via the approved D10 deviation (see C5). The smoke reports SKIP.
- F5 Regression: `smoke-store-user.sh` including arm 19, and the other `test:smoke` scripts → PASS for `smoke-store-user.sh` (ALL ARMS PASSED; arm 19 "Mailpit: 0 messages to no-email.invalid" PASS with the hook enabled). I did not rerun `smoke-edge.sh`, `smoke-rpc.sh` or `smoke-edge-roles.sh` (outside my allowed command list). The developer reports the full `test:smoke` green.
- F6 Rate limit determinism → PASS (run completed with no 429 or throttle failures; 2 s spacing before S3b/S4, `sleep 2` between the S9 rounds). Rerunning within 5 minutes may hit the `/verify` limit (documented in the spec).

**G. Prod rollout runbook**
- G1 Steps 0-9, ordering rule in bold, rollback, no-migration statement → PASS (static, documentation). Spec §12 contains all of them; the owner executes the dashboard steps. Prod enablement is blocked on O1-O5 (not a test gap).
- G2 Prod behaviour (step 5 probe, step 7 probes) → NOT TESTED by design. Runtime prod probes belong to the owner and I made no prod call. `scripts/probe-auth-email-hook.sh` exists as the D15 pre-enable probe; its local exercise is reported in the implementation notes. I did not rerun it.

**H. Process**
- H1 Owner plan approval before code edits → PASS (documented). The spec records the approval under §0 (2026-10-19, in chat) and I have no way to audit its timing.
- H2 Staged, never committed → PASS. `git status` shows the 166 files as `A`/`M` in the index; no commit.

Summary counts (41 criteria items above): 39 PASS, 0 FAIL, 2 NOT TESTED (D3 CI boot on CLI 2.106.0/latest; G2 prod probes). Both NOT TESTED items are inherently post-push or owner-run. Neither is a defect, but per the release-coordinator rule each counts as a Critical hold until the first CI run on `main` is green.

### Assessment of S9 (the changed arm)

**Verdict: S9 still proves the email_change AC, and in one respect proves it more strongly than the original design. One narrow residual gap is noted.**

What it does now: `email_change_round` triggers a real secure email change through `PUT /auth/v1/user` against real GoTrue. It then reads both Mailpit messages and extracts each `token_hash` from the rendered Text link. It compares them with GoTrue's own stored state, `auth.users.email_change_token_current` for the old-address mail and `email_change_token_new` for the new-address mail. Finally it calls `POST /auth/v1/verify` with the extracted hash and asserts `auth.users.email` flipped. It runs two rounds, redeeming the old leg in the first and the new leg in the second.

Why this is acceptable or better:
- Redeeming both legs from one change is impossible locally. `MAILER_AUTOCONFIRM=true` means the first redeemed leg completes the change and consumes the other leg's hash. This is GoTrue behaviour, not a hook bug, and the dev correctly did not change `config.toml`.
- The hash-equals-stored-token assertion is a more direct test of the swap mapping (`token_hash_new` goes with the current address, `token_hash` with the new) than "it redeems", because it pins each leg's hash to GoTrue's authoritative column. It is not tautological: a swapped mapping would fail the equality check.
- Each leg's hash is shown to redeem on its own across the two rounds, so "each link works" is covered.
- Verified in my run: all 10 S9 assertions passed.

Residual gaps (non-blocking):
1. The unredeemed leg in each round is proven only by hash equality, not by a redeem. Given the equality to GoTrue's stored token, a redeem would also succeed unless the hook mangles the link around the hash. The Text-link regex extraction does prove the link carries that hash and `type=email_change`. The `redirect_to` portion of the email_change link is not asserted.
2. The non-secure (single-pair) email_change shape is never exercised against real GoTrue (needs `secure_email_change_enabled=false` and a stack restart). It rests on the synthetic S6 arm and jest, so the architect's AC "confirm which fields GoTrue sends" is still unconfirmed for that mode.
3. The arm mutates `auth.users.email` of its own fixture only, and the EXIT trap removes `zz_s166` users, so there is no seeded-data mutation.

### Test run
- `npx jest` (full): **232 suites passed / 232, 2730 tests passed / 2730, 2 snapshots**. Includes `src/lib/authEmailHook.test.ts`, `authEmailHook.parity.test.ts` and `placeholderEmail.parity.test.ts`. All green, so no failure is attributable to the concurrent spec 167 staged files. The suite includes spec 167's staged tests and they pass. The `console.warn` noise from `db.ts` in the output comes from tests that deliberately trigger a backend error.
- `npm run typecheck`: clean (no output from `tsc --noEmit`).
- `npm run typecheck:test`: clean.
- `bash scripts/smoke-send-email-hook.sh`: **ALL ARMS PASSED** (P, Setup, S5, S1, S2, S3, S3b, S4, S6, S6b, S9, S7 all PASS; S8 SKIP by design). The exit code came back blank because of my `PIPESTATUS` handling through `tail`, but the script's own "ALL ARMS PASSED" line and the cleanup PASS confirm a clean run. Mailpit D11 branch recorded: `SUPABASE_URL` fallback (`kong:8000`).
- `bash scripts/smoke-store-user.sh`: **ALL ARMS PASSED** (includes spec 167 audit arms A1-A9 and AF from the concurrent session, plus arm 19 "Mailpit: 0 messages to no-email.invalid" and arm 20). Hook enabled throughout.
- Ad hoc live probe (scratchpad, not committed): signed payload to a malformed real address → HTTP 500 `delivery failed` (Mailpit 400); signed placeholder payload → HTTP 200 `{}` and log `outcome:"dropped"`. Edge log lines for both carried no address.

### Notes
1. **No framework gap.** All tests are in-tree jest or shell smoke. No fourth framework introduced.
2. **Handler-level fail-closed branches have no repo test.** The pure functions behind them are unit-tested (`parseHookSecrets`, `resolveTransport`, `isTransportSuccess`), but the `Deno.serve` wiring is not importable in jest and not drivable in the smoke, because the container's env is fixed at boot. These branches are unset hook secret → 500 `hook misconfigured`, unset or invalid transport or From → 500, and provider non-2xx or timeout → 500. I confirmed the provider-non-2xx branch live, as above. A future regression in the handler wiring (for example returning 200 after a failed fetch) would not be caught by CI. Optional hardening: a smoke arm that sends a signed payload to a deliberately invalid real recipient and expects 500 (the same trick as my probe, no config change needed). Not blocking.
3. **Prod transport is proven at the request-builder level only** (D10, owner-approved). The real `fetch` to Resend, domain verification, and Resend rate limits and idempotency-header behaviour are first exercised by the owner's step 5b probe (`probe-auth-email-hook.sh`) and the step 7 probes.
4. **D3 / CI boot is the one real unknown.** `[edge_runtime.secrets]` literals and `[auth.hook.send_email]` are accepted by CLI 2.95.4 locally. Whether CLI 2.106.0 (`test.yml`) and CLI latest (`e2e.yml`) accept the same block, and whether `host.docker.internal` resolves on Linux CI, is unverified. Per CLAUDE.md, the next agent action after the push must confirm `test.yml` and `db-migrations-applied.yml` green on `main`, and `e2e.yml` is checked manually.
5. **Concurrency hazard to be aware of.** The 166 smoke calls `DELETE /api/v1/messages` on the shared local Mailpit. A concurrent spec 167 or other session reading Mailpit could see its messages wiped, and `smoke-store-user.sh` arm 19 asserts a zero count on the same inbox. Both passed in my sequential runs. Run them one at a time.
6. Spec 166 is labelled READY_FOR_REVIEW and the work is staged. No code, test or config was modified by this review.

# Spec 168: auth-email-hook follow-ups (spec 166 §G)

Status: READY_FOR_REVIEW

Follow-up to spec 166 ([specs/166-send-email-hook-placeholder-drop.md](166-send-email-hook-placeholder-drop.md), committed as `227436c`, which is the baseline for this spec). Source: [specs/166-send-email-hook-placeholder-drop/reviews/release-proposal.md](166-send-email-hook-placeholder-drop/reviews/release-proposal.md), section "G. Follow-ups". The owner approved the six-item scope below in chat. No product questions are open; the remaining unknowns are technical and are marked **Architect to decide**.

## User story
As the brand owner, I want the auth-email-hook's leftover review follow-ups closed before I enable the hook in prod, so that the core render code is easier to review, the fail-closed delivery path has a repeatable test, the S9 smoke arm can't give a false result on a stack without autoconfirm, the signature verifier's dependency tree is locked, and the prod probe never exposes the hook key in `ps`.

Concrete scenario: before running spec 166 runbook step 5b, the owner runs `bash scripts/probe-auth-email-hook.sh --url https://ebwnovzzkwhsdxkpyjka.supabase.co/functions/v1/auth-email-hook --to <owner inbox>`. Today, for a few milliseconds, the decoded key is visible on `openssl`'s command line. After this spec, it is never on any process's argv. Separately, a developer running `bash scripts/smoke-send-email-hook.sh` now gets a dedicated arm proving that a real recipient the transport rejects gives HTTP 500 `{"error":"delivery failed"}` and sends no mail.

## Behaviour boundary (applies to every item)
Only three observable changes are intended:
1. the new smoke arm (item 3)
2. the S9 autoconfirm precondition (item 4)
3. the probe script's HMAC mechanism (item 6)

Everything else is a no-behaviour-change refactor or a dependency-resolution change. In particular, for every request the function can receive, these must stay identical to the `227436c` baseline:
- the HTTP status and response body
- the rendered `subject` / `html` / `text` and recipient of every mail
- the transport request (URL, headers, body, `Idempotency-Key`)
- the log line (keys and values)

## Acceptance criteria

### 1. `renderMail` split (code-reviewer SF2) and parked comment fixes
- [ ] In the `// BEGIN auth-email-hook-core (spec 166)` / `// END auth-email-hook-core (spec 166)` block, `renderMail` is split into three functions named `resolveLinkAndCode`, `renderBody` and `resolveRedirect`. **Architect to decide:**
  - the exact signatures
  - whether `renderMail` survives as a thin composer or is removed (with `planMails` calling the three directly)
  - whether any of the three are added to the canonical file's `export` list for direct jest coverage (the export list is outside the block)
- [ ] The edit is made identically in both copies: [src/lib/authEmailHook.ts](../src/lib/authEmailHook.ts) and [supabase/functions/auth-email-hook/index.ts](../supabase/functions/auth-email-hook/index.ts). [src/lib/authEmailHook.parity.test.ts](../src/lib/authEmailHook.parity.test.ts) passes unmodified, all four cases including (b): no `export`, `Deno.`, `fetch(`, `console.` or `no-email.invalid` inside the block.
- [ ] The signup/invite special case (link-only, and `unlinkable` when `token_hash` is empty) is expressed in one place, not split across two branches as it is today (`authEmailHook.ts:287` and `:296`).
- [ ] The empty `else if (isNotificationAction(action)) { /* no link, no code */ }` branch (`authEmailHook.ts:282-283`) no longer exists as an empty branch. The notification no-link/no-code rule is still explicit in code or a comment.
- [ ] One comment in the block explains why the action types differ:
  - `magiclink` / `email` / `email_change` / unknown types show a link (when a hash exists) **and** a code
  - `reauthentication` shows a code only, with no `/verify` link
  - `signup` / `invite` are link-only
  - `recovery` uses the spec 085 `token_hash` link rather than `/verify`
- [ ] The D11 comment above `verifyBase` (`authEmailHook.ts:195-197`) is reworded to say:
  - GoTrue's hook `site_url` is the **app Site URL** (spec 166 architect m1, proven by smoke S6b on GoTrue v2.189.0)
  - so the `SUPABASE_URL + "/auth/v1"` fallback is the live branch in practice, and it is correct for prod
  - the API-shaped `site_url` branch remains as a defensive branch

  **Comment only.** `verifyBase`'s logic, including the `site_url` branch, is unchanged.
- [ ] **Golden equivalence (jest).** A new jest check asserts that `planMails` output (`ok`, `action`, `dropped`, and every mail's `to`, `subject`, `html`, `text`) after the refactor is byte-identical to output captured from the `227436c` baseline code.
  - The golden is captured **before** the refactor edit, from the unmodified baseline, and committed with this change. **Architect to decide** whether it is a committed JSON fixture or a jest `__snapshots__` file.
  - A missing golden fails the test; it is never silently written. Note that `jest --ci` does not write new snapshots, so a snapshot file must be committed.
  - The input matrix covers at least:
    - all 14 `email_action_type` values in spec 166 §3.3, plus one unknown type with both hash and token
    - `email_change` in all four shapes: secure, single-pair, placeholder-current + real-new, and real-current + placeholder-new
    - recovery with: a `redirect_to` that has no `?`, one that has a `?`, a `pkce_`-prefixed hash, an unusable `redirect_to` falling back to `site_url`, and both unusable (expects `unlinkable`)
    - signup and invite with an empty `token_hash` (expects `unlinkable`)
    - a link type where both `redirect_to` and `site_url` are unusable (expects `unlinkable`)
    - an API-shaped `site_url` (`.../auth/v1`) and an app-shaped `site_url`, to exercise both `verifyBase` branches
    - the `"><script>` escaping case from the existing tests
    - `email_changed_notification` with and without `old_email`
- [ ] The golden check passes against the refactored code, and it was also shown to pass against the unmodified baseline before the edit. The developer records both runs in the spec's implementation notes.
- [ ] Every existing case in [src/lib/authEmailHook.test.ts](../src/lib/authEmailHook.test.ts) still passes, and none has its expected value changed or is deleted. Additions are allowed.

### 2. Extract `deliver()` from the handler
- [ ] The step-9 delivery loop in the `Deno.serve` handler (`index.ts:644-671`: sequential `fetch` per mail, `AbortSignal.timeout(TRANSPORT_TIMEOUT_MS)`, body cancel, status classification) moves into a named `deliver()` function in `index.ts`. The handler calls it and maps its result to the log line and response.
- [ ] Unchanged by the extraction:
  - mails are sent sequentially, in plan order
  - `TRANSPORT_TIMEOUT_MS` and its value
  - the `Idempotency-Key` format `<webhook-id>:<legIndex>`
  - the provider response body is cancelled and never read into a log
  - the first failure stops delivery of the remaining legs
  - outcome mapping: a thrown `TimeoutError` / `AbortError` gives `reason:"timeout"`; any other throw gives `reason:"transport"` with no `status`; a non-2xx gives `reason:"transport"` with `status:<code>`; each returns 500 `{"error":"delivery failed"}`; all-2xx gives `outcome:"sent"` and 200 `{}`
  - the log line keys stay within `{hook, action, outcome, recipients, dropped, status, reason}`, with values identical to the baseline for each outcome
- [ ] **Optional, Architect to decide:** move the pure mapping (fetch outcome → `{ ok: true }` or `{ ok: false, reason: "timeout" | "transport", status? }`) into the core block so jest covers it.
  - If chosen: the mapping takes a runtime-neutral input (for example an error name string or a status number), not a `Response` or `DOMException`, so the block stays pure and type-checks in both the jest/Node and Deno graphs. It is mirrored byte-identically in both copies, and jest covers each branch: TimeoutError, AbortError, another error, 199/200/299/300/500.
  - If not chosen: the architect records why in the design, and the item is satisfied by the handler-only extraction.

### 3. New smoke arm: handler fail-closed delivery path
- [ ] [scripts/smoke-send-email-hook.sh](../scripts/smoke-send-email-hook.sh) gains an arm, in the existing `pass`/`fail`/`skip` style, that does the following:
  - clears Mailpit
  - sends a correctly signed synthetic payload whose recipient is a real (non-placeholder) address that Mailpit's `/api/v1/send` rejects
  - asserts HTTP **500** with body exactly `{"error":"delivery failed"}`
  - after the settle wait, asserts the Mailpit **total is 0**
  - asserts the edge-runtime log for the arm's window contains a `"hook":"auth-email-hook"` JSON line with `outcome:"failed"`, `reason:"transport"` and a numeric `status` equal to the non-2xx code Mailpit returned
- [ ] The developer finds the rejected recipient **empirically** by probing Mailpit's `/api/v1/send` from the edge-runtime network. The chosen value and the status Mailpit returns are recorded in a script comment and in the implementation notes. The recipient must:
  - not match the spec 165 placeholder predicate
  - pass `parsePayload` and `routeLegs` unchanged, so the request genuinely reaches the transport and is not rejected earlier with 400 or `unlinkable`
- [ ] No `supabase/config.toml` change, no hook code change, and no Mailpit configuration change is made to manufacture the failure. If no such recipient exists, the developer stops and returns to the architect rather than improvising.
- [ ] The arm's recipient is registered with the script's `remember` / secrets list, so the existing S7 hygiene arm also proves the address never appears in edge logs or hook response bodies.
- [ ] Placement: **Architect to decide**. The arm uses a signed synthetic payload and does not go through GoTrue, so it adds no `/recover` rate-limit pressure. It must not disturb the S2/S3b/S4 spacing.
- [ ] The script header's arm list documents the new arm.

### 4. S9 autoconfirm precondition (spec 166 architect m4)
- [ ] Before S9's redemption steps, the script reads `GOTRUE_MAILER_AUTOCONFIRM` from the `supabase_auth_imr-inventory` container (for example via `docker exec … printenv`).
- [ ] If the value is exactly `true`, S9 runs as today.
- [ ] If the value is anything else (including empty or unreadable), the **redemption half** of S9 is reported with `skip` and a reason that includes the observed value, for example `SKIP S9 redemption (reason: GOTRUE_MAILER_AUTOCONFIRM='false'; the first-leg-completes-change mechanics need autoconfirm)`. The redemption half means:
  - the per-leg `/verify` → 200 check
  - the `auth.users.email = new address` check
  - anything that depends on a completed change, such as the second round starting from the changed address
- [ ] The **hash-equality half** runs unconditionally, at least once, as a PASS/FAIL (never SKIP). That half is:
  - one message each to the old and new address
  - old-leg hash = `email_change_token_current`
  - new-leg hash = `email_change_token_new`

  **Architect to decide** how the two-round structure (`email_change_round … old`, then `… new` from the changed address) is restructured so that the hash-equality half still runs when redemption is skipped.
- [ ] On the current local stack (autoconfirm `true`), S9 produces the same PASS lines as the baseline, plus one line reporting the precondition value.
- [ ] **Architect to decide** how the SKIP branch is proven: code review only, or a documented test-only override. No `config.toml` change.

### 5. `npm:` specifier and a committed `deno.lock` (security L5, stronger form)

> **Architect (design, 2026-10-21): FALLBACK TAKEN.** The docs do not confirm (a)-(c), so the import stays on the esm.sh `?deps=` pin and only its comment changes. No deno download or install is needed. See "Backend design" §5. The checkboxes below are N/A except "Fallback".
- [ ] The verifier import in `index.ts` changes from `https://esm.sh/standardwebhooks@1.0.0?deps=@stablelib/base64@1.0.1,fast-sha256@1.3.0` to `npm:standardwebhooks@1.0.0`.
- [ ] A `deno.lock` for this function is committed under `supabase/functions/auth-email-hook/`, plus a per-function `deno.json` if the mechanism needs one. It resolves exactly `standardwebhooks@1.0.0`, `@stablelib/base64@1.0.1` and `fast-sha256@1.3.0`. These are the same versions as today's `?deps=` pin, so spec 166's fix-1 fuzz evidence for `parseHookSecrets` against `@stablelib/base64@1.0.1` still holds.
- [ ] **Architect to confirm from current Supabase docs** (cite the page in the design) that a per-function `deno.json` / `deno.lock` is honoured by all three of these:
  - (a) local serving under `supabase start`, on the dev machine's CLI (2.95.4 per spec 166 implementation notes)
  - (b) the CI CLIs: 2.106.0 in `test.yml`, `latest` in `e2e.yml`
  - (c) `supabase functions deploy`, including whichever bundling path (Docker or API) the owner's deploy uses

  Also confirm whether a `[functions.auth-email-hook]` `import_map` (or equivalent) entry in `supabase/config.toml` is required. If it is, the edit is confined to that block, `verify_jwt = false` stays pinned, and the edit is flagged in the owner plan. `config.toml` is otherwise out of scope.
- [ ] **The architect specifies how the lock is generated.** The `deno` CLI is not installed on the dev machine.
  - **Any download or install** (a deno binary, a Homebrew package, or pulling a `denoland/deno` Docker image) needs explicit owner permission. **Main Claude asks the owner first**; no agent downloads or installs anything on its own.
  - The design states the generating Deno version and the lockfile format version. It also confirms that format is readable by the edge runtime (`[edge_runtime] deno_version = 2` in `config.toml`).
  - The design states whether a `.gitignore` rule would exclude `deno.lock`.
- [ ] Verification after the switch, on a clean `npx supabase stop --no-backup && npm run dev:db`:
  - the function boots (unsigned POST gives 401 `{"error":"invalid signature"}`)
  - all existing smoke arms pass unchanged, which proves signature verification behaves identically, including S5's stale-timestamp 401
  - the edge-runtime logs show no lockfile integrity or resolution error
- [ ] The comments that reference the esm.sh import are updated to match: the `index.ts` header and the import comment.
- [ ] **Fallback.** If any of the following happens, the import stays on the current esm.sh `?deps=` pin, nothing else in item 5 lands, and the reason is recorded in this spec's implementation notes:
  - the docs don't confirm (a)-(c)
  - the owner declines the deno download/install
  - the lockfile isn't honoured locally
  - any smoke arm fails on the `npm:` import

  Items 1-4 and 6 are unaffected. Taking the fallback is an acceptable outcome for this spec, not a failure.
- [ ] No prod deploy in this spec. Prod-deploy acceptance of the lock is covered by the existing spec 166 runbook steps 4, 5 and 5b, which the owner runs. The design notes this as a residual risk.

### 6. HMAC key off `openssl` argv in the probe (security L1, optional item, approved)
- [ ] [scripts/probe-auth-email-hook.sh](../scripts/probe-auth-email-hook.sh) computes the Standard Webhooks HMAC-SHA256 with `node`, reading the key material from **stdin**.
  - Neither the raw secret nor the decoded key appears on the argv of any process the script spawns.
  - The script does not newly place key material in a child process's environment. It already `unset`s `SECRET` / `HOOK_SECRET` after use, and that stays.
  - **Architect to decide** whether node receives the `v1,whsec_…` secret and does the base64 decode itself, or receives the decoded hex. The signed message (`<id>.<ts>.<body>`) is not secret and may reach node by any route.
- [ ] Probe behaviour is otherwise unchanged:
  - argument handling
  - the `https://` / local URL check
  - the placeholder `--to` refusal
  - the TTY prompt and the non-TTY refusal
  - the `^v1,whsec_[A-Za-z0-9+/=]{32,88}$` shape check
  - the LOCAL/DEV-secret-against-https refusal
  - the payload, the curl call, and the result and hint messages
  - exit codes
- [ ] **A non-decodable secret is still refused** with `REFUSE … HOOK_SECRET did not base64-decode` and exit 2. Node's `Buffer.from(…, 'base64')` is lenient, so if decoding moves into node, the strictness must be preserved explicitly.
- [ ] The signature node produces is byte-identical to the current `openssl dgst -sha256 -mac HMAC -macopt hexkey:` output for a fixed test vector (key, id, ts, body). The developer records the vector comparison in the implementation notes.
- [ ] Run locally against `http://127.0.0.1:54321/functions/v1/auth-email-hook`, all of these behave as in spec 166:
  - the env path and the TTY prompt path both give 200 `{}` plus one "Account notification" in Mailpit
  - a wrong but well-formed secret gives 401 with the mismatch hint
  - a missing secret without a TTY is refused
- [ ] If `node` is not on `PATH`, the script refuses with a clear `REFUSE` message and exit 2.
- [ ] The probe script no longer contains `-macopt` or `hexkey`.
- [ ] The header's "Exposure note (security L1)" is removed or rewritten to describe the new mechanism. The `--help` line range (`sed -n '2,31p'`) is adjusted so `--help` still prints exactly the header.
- [ ] **Architect to decide** whether the smoke's `sign_headers` (`smoke-send-email-hook.sh:125-131`, same `-macopt hexkey:` pattern, used only with the public local dev secret D7) is aligned to the node mechanism.
  - If aligned, every smoke arm still passes.
  - If not, the design records the rationale: the key is public by design, so there is no exposure to close.

### Done criteria (all items)
- [ ] Full `npx jest` is green. Run the full suite, not a subset.
- [ ] `npm run typecheck` and `npm run typecheck:test` are clean.
- [ ] `bash scripts/smoke-send-email-hook.sh` prints **ALL ARMS PASSED**. The only SKIPs are the pre-existing S8 (spec 166 D10) and, only if the precondition is not `true`, the S9 redemption half.
- [ ] `npm run test:smoke` is green.
- [ ] Mailpit-using smokes run **sequentially, never concurrently**: `smoke-send-email-hook.sh`, `smoke-store-user.sh`, and anything else that reads or wipes Mailpit. That includes not running them alongside another session's spec 167 smoke run, because the spec 166 smoke wipes the shared local Mailpit.
- [ ] Before the first edit, the developer shows the owner a file-by-file plan and gets approval.
- [ ] Stage only spec 168 paths and **never commit**; the owner commits.
  - Spec 167 paths are staged by another session. Do not stage, unstage, restore or modify any of them: `specs/167-*`, `src/i18n/*.json`, `src/screens/cmd/sections/AuditLogSection.tsx`, `src/screens/cmd/sections/phone/PhoneAuditLog.tsx` and their tests, `src/types/index.ts`, `src/utils/enumLabels.test.ts`, `src/utils/formatAuditAction.ts`, `supabase/functions/delete-user/index.ts`, `supabase/functions/manage-store-user/index.ts`, `scripts/smoke-store-user.sh`, `scripts/smoke-edge-roles.sh`.

## In scope
- `supabase/functions/auth-email-hook/index.ts`: core-block refactor (item 1), `deliver()` extraction (item 2), import switch and comment updates (item 5)
- `src/lib/authEmailHook.ts`: the identical core-block refactor, plus export-list additions if the architect chooses
- `src/lib/authEmailHook.test.ts`: the golden equivalence check (item 1), optional delivery-mapping cases (item 2), and any new direct cases for the split functions
- A golden fixture or snapshot file next to the test (item 1)
- `scripts/smoke-send-email-hook.sh`: the new fail-closed arm (item 3), the S9 precondition (item 4), and the optional `sign_headers` alignment (item 6)
- `scripts/probe-auth-email-hook.sh`: the node HMAC via stdin and the header update (item 6)
- `supabase/functions/auth-email-hook/deno.lock`, and `deno.json` if required (item 5)
- `supabase/config.toml` **only** if the architect shows a `[functions.auth-email-hook]` entry is required for item 5, confined to that block
- `tests/README.md`, only if a Track 3 line needs updating (for example the new arm, or the probe now requiring `node`)
- This spec file: implementation notes and files changed

## Out of scope (explicitly)
- **Any change to rendered mail content, subjects, links, routing or recipients.** Item 1 is a pure refactor, guarded by the golden check.
- **Removing or changing `verifyBase`'s `site_url` branch.** The m1 finding is a comment rewording only; removing a defensive branch is a behaviour change.
- **`SEND_EMAIL_VERIFY_BASE` / custom-domain verify links.** Spec 166 architect m1 parked this as a future option.
- **A send cap inside the hook** (security M1 follow-up). It needs its own spec, and only if spec 166 runbook probe 7(d) shows `email_sent` isn't enforced.
- **An env allowlist of link origins in the hook** (security L2 optional). It needs a design decision on drift from the GoTrue allowlist.
- **A live non-secure `email_change` proof**, which would need `secure_email_change_enabled=false` plus a restart. It would be a config change.
- **Changing local `config.toml` auth settings** (for example `enable_confirmations` or autoconfirm) to exercise the S9 SKIP branch.
- **Migrating other edge functions** (`send-invite-email` and others) to `npm:` specifiers or lockfiles. This spec covers `auth-email-hook` only.
- **Any prod action**: deploy, `supabase secrets set`, dashboard change, or MCP call. The spec 166 runbook remains owner-run.
- **Spec 166 runbook text and O1-O5.** They are unchanged by this spec.
- **The `app.json` slug.** Not touched.
- **Every spec 167 path** (listed under Done criteria).

## Open questions resolved
- Q: Which follow-ups are in scope? → A: The six items above, from release-proposal §G. The owner approved them in chat.
- Q: May anything else change behaviour? → A: No. The only intended observable changes are the new smoke arm, the S9 precondition and the probe's HMAC mechanism.
- Q: Must the refactor be proven output-identical? → A: Yes. Rendered subject/html/text is byte-identical for every action type, with a jest golden/snapshot-style check.
- Q: Is a config change needed for the fail-closed arm? → A: No. The developer finds a recipient Mailpit rejects empirically.
- Q: What should S9 do without autoconfirm? → A: SKIP the redemption half with a reason. The hash-equality half stays unconditional.
- Q: How strong should the L5 fix be? → A: The stronger form, `npm:standardwebhooks@1.0.0` plus a committed `deno.lock`. If that's infeasible, keep the esm.sh `?deps=` pin and record why.
- Q: May agents install deno? → A: Not without explicit owner permission. Main Claude asks the owner first.
- Q: What HMAC mechanism should the probe use? → A: Node, reading the key from stdin. Also remove or update the "Exposure note".
- Q: Should the smoke's `sign_headers` be aligned too? → A: Architect to decide. It only ever uses the public local dev secret.
- Q: Commit? → A: No. Stage only spec 168 paths; the owner commits.

## Dependencies
- Spec 166 at `227436c`: the core block, the parity test, the smoke script, the probe script, D7 (local dev secret), D10, D11/m1, and the fix-1 fuzz evidence for `@stablelib/base64@1.0.1`.
- Spec 165: the placeholder predicate (the new arm's recipient must not match it).
- Local stack via `npm run dev:db`, including Mailpit (`supabase_inbucket_imr-inventory`, `/api/v1/send`), `supabase_auth_imr-inventory` (`GOTRUE_MAILER_AUTOCONFIRM`), and `supabase_edge_runtime_imr-inventory` (logs). Run the CLAUDE.md bind-mount check before debugging a 503.
- Supabase CLI per-function `deno.json` / `deno.lock` support (item 5; architect confirms from docs).
- A Deno binary or image to generate the lock (item 5; owner permission required).
- `node` on `PATH` for the probe (item 6). Already required by the repo's npm toolchain.
- `jq`, `curl`, `openssl` and `docker`, as the existing smoke already uses.

## Project-specific notes
- **Cmd UI section / legacy:** None. Backend, scripts and tests only; no UI.
- **Per-store or admin-global:** Project-global (GoTrue auth mail). No `auth_can_see_store()` involvement and no RLS change.
- **Realtime channels touched:** None. No publication change, so the realtime restart gotcha does not apply.
- **Migrations needed:** No. The `db-migrations-applied` gate is unaffected.
- **Edge functions touched:** `auth-email-hook` only: refactor, `deliver()`, import, and lock. Its `verify_jwt = false` pin and signature-gate semantics are unchanged. No other function is touched.
- **Web/native scope:** Server-side and dev tooling. No client, Vercel or EAS change.
- **`app.json` slug:** Not touched.
- **Test tracks:**
  - **jest:** the golden equivalence check, the optional delivery-mapping cases, parity unchanged, and the full suite
  - **shell smoke:** the new fail-closed arm, the S9 precondition, and the full `test:smoke`
  - **pgTAP:** not applicable (no SQL)

## Risks for the architect
1. **The parity block is edited in two places.** A one-character divergence fails `authEmailHook.parity.test.ts`. The golden must be captured from the baseline before either copy is edited.
2. **The golden captures too little.** If the matrix misses a branch (for example the `?` separator or the API-shaped `site_url`), a regression in that branch passes silently. The matrix above is the minimum.
3. **Lockfile acceptance differs across CLIs.** The local CLI is 2.95.4, `test.yml` uses 2.106.0 and `e2e.yml` uses `latest`. If a CLI or edge runtime rejects or ignores the lock, the function may fail to boot or may silently float deps. A boot failure only bites when GoTrue calls the hook; e2e's invite path goes through `send-invite-email` (spec 166 §13 risk 7). Prod deploy acceptance is only provable at the owner's runbook step 4/5/5b.
4. **`npm:` resolution at local boot** may need network access on first serve, the same posture as esm.sh today (spec 166 §13 risk 9).
5. **Mailpit may accept everything** that reaches the core's transport, in which case item 3 has no candidate recipient. The developer stops and returns to the architect rather than changing config or code.
6. **Node's base64 is lenient.** Moving the decode into node could silently weaken the probe's "did not base64-decode" refusal (item 6 criterion).
7. **Shared Mailpit.** A concurrent spec 167 session running `smoke-store-user.sh` would interfere. Run sequentially.

## Backend design

Architect, 2026-10-21. Baseline is `227436c`. Neither hook file (`src/lib/authEmailHook.ts`, `supabase/functions/auth-email-hook/index.ts`) is touched by the spec 167 staged set, so `HEAD` equals the baseline for both.

### 0. Summary of decisions

| Item | Decision |
|---|---|
| 1 | Split `renderMail` into `resolveRedirect` + `resolveLinkAndCode` + `renderBody`. **`renderMail` stays** as a 4-line composer, so `planMails` is untouched. `recoveryLink` reuses `resolveRedirect`. All three new functions are **exported** from the canonical module. |
| 1 golden | A **committed JSON fixture**, `src/lib/authEmailHook.golden.json`, checked by a new `src/lib/authEmailHook.golden.test.ts`. No jest snapshot. Capture runs only on request, refuses under CI, refuses to overwrite, and refuses unless the working-tree core block hashes to the 227436c block. |
| 2 | `deliver()` goes in `index.ts`. **Yes**, the pure outcome mapping moves into the core block as `classifyDelivery()` and gets jest coverage. |
| 3 | New arm **S10**, placed after S6 and before S6b. It uses a signed synthetic `recovery` payload with `user.email = "not-an-address"`. It first probes Mailpit directly as a precondition, and the arm asserts the log `status` against the code that probe returned. |
| 4 | `email_change_round` gets a third mode, `none` (hash-equality only). If autoconfirm is `true`, the rounds run exactly as today. Otherwise one `none` round runs, plus one SKIP line. The SKIP branch is proven with a documented test-only override, `S9_AUTOCONFIRM_OVERRIDE`. |
| 5 | **Fallback taken.** The esm.sh `?deps=` pin stays. Only the import comment changes. No deno install, no `deno.json`/`deno.lock`, no `config.toml` change. |
| 6 | The decode **stays in openssl**, unchanged, so strictness is preserved exactly. node receives the **decoded hex key on stdin** and computes the HMAC. The smoke's `sign_headers` is **not** aligned. |

Not affected: data model, migrations, RLS, PostgREST/RPC, `src/lib/db.ts`, realtime, `src/store/useStore.ts`, and any UI. `[functions.auth-email-hook] verify_jwt = false` is unchanged, and so are the signature-gate semantics. No other edge function is touched.

### 1. `renderMail` split (core block, both copies)

#### 1.1 New types and functions

The new types and functions live inside the block, in this order:
- `resolveRedirect` goes directly after `usableRedirect`.
- `resolveLinkAndCode`, `renderBody` and `renderMail` go where `renderMail` is today, in that order.

```ts
type LinkAndCode = { link: string; code: string };
type RenderedBody = { subject: string; html: string; text: string };

// The redirect fallback rule, now defined once: redirect_to if usable, else site_url if usable, else null.
function resolveRedirect(redirectTo: string, siteUrl: string): string | null;
//   ≡ usableRedirect(redirectTo) ?? usableRedirect(siteUrl)

// null = unlinkable.
function resolveLinkAndCode(action: string, leg: Leg, d: HookEmailData, supabaseUrl: string): LinkAndCode | null;

// Moved VERBATIM from renderMail (today's lines 298-339 of the canonical): subject/intro/label, the html[] and text[] arrays, and the joins.
function renderBody(action: string, newEmail: string, link: string, code: string): RenderedBody;

// Survives as the composer. planMails is NOT edited.
function renderMail(action: string, leg: Leg, p: HookPayload, supabaseUrl: string): PlannedMail | null;
//   lc = resolveLinkAndCode(action, leg, p.email_data, supabaseUrl); if null → null
//   b  = renderBody(action, p.user.new_email, lc.link, lc.code)
//   return { to: leg.to.trim(), subject: b.subject, html: b.html, text: b.text }
```

`recoveryLink(redirectTo, siteUrl, hash)` keeps its signature and its `hash === ""` early return. Its `usableRedirect(redirectTo) ?? usableRedirect(siteUrl)` becomes `resolveRedirect(redirectTo, siteUrl)`. The verify path in `resolveLinkAndCode` uses `resolveRedirect(d.redirect_to, d.site_url)`. After this, the fallback rule appears in exactly one place.

#### 1.2 `resolveLinkAndCode` decision table (must equal the baseline)

| Action | Result |
|---|---|
| `recovery` | `link = recoveryLink(d.redirect_to, d.site_url, leg.hash)`. If null → `null`. Otherwise `{ link, code: "" }`. |
| `reauthentication` | `{ link: "", code: leg.code }` |
| `isNotificationAction(action)` | `{ link: "", code: "" }`. This is an explicit return, not an empty branch. |
| Everything else | See below. |

For everything else, define `const linkOnly = action === "signup" || action === "invite";` **once**. This is the single place the signup/invite special case is expressed. Then:
- If `leg.hash === ""`: return `linkOnly ? null : { link: "", code: leg.code }`.
- Otherwise: `base = verifyBase(d.site_url, supabaseUrl)` and `redirect = resolveRedirect(d.redirect_to, d.site_url)`. If either is null → `null`. Otherwise `{ link: verifyLink(base, leg.hash, action, redirect), code: linkOnly ? "" : leg.code }`.

Keep the baseline branch order (recovery, reauthentication, notification, rest). These are exact-string or suffix tests that can't overlap, but the order makes the review diff easier to read.

#### 1.3 Required comments (inside the block, identical in both copies)

Above `resolveLinkAndCode`, the action-type rationale. Suggested wording:

```
// Why the action types differ (spec 166 §3.3):
//   * recovery: the spec 085 link <redirect>?token_hash=…&type=recovery, which
//     the app redeems itself, NOT a /verify link; no code.
//   * reauthentication: code only; GoTrue has no /verify link for it.
//   * signup / invite: link-only (/verify). With no hash the mail is useless,
//     so it is unlinkable rather than an empty notice.
//   * *_notification: a plain notice with no link and no code (routeLegs also
//     blanks both).
//   * magiclink / email / email_change / unknown future types: a /verify link
//     when a hash exists AND the code when present.
// null = unlinkable (planMails → 500 "delivery failed").
```

Replace the D11 comment above `verifyBase`. **Comment only; the logic is unchanged.** Suggested wording:

```
// D11 — base for GoTrue /verify links. GoTrue's hook site_url is the APP Site
// URL (spec 166 architect m1, proven by smoke S6b on GoTrue v2.189.0), so in
// practice the SUPABASE_URL + "/auth/v1" fallback is the live branch, and it is
// correct for prod (the function's SUPABASE_URL is the project API URL). The
// API-shaped site_url branch (path ends in /auth/v1) remains as a defensive
// branch. Never any other host.
```

**Parity (b) word traps.** Test (b) runs `\bexport\b` and substring checks against the whole block, comments included. A new comment inside the block must not contain:
- the word `export` (for example "exported for jest")
- `fetch(` (for example "the fetch() result")
- `console.`, `Deno.` or the placeholder domain

#### 1.4 Export list (outside the block, canonical only)

Add the following. `authEmailHook.parity.test.ts` is not modified; its export check still passes.
- Functions: `resolveRedirect`, `resolveLinkAndCode`, `renderBody`, `classifyDelivery` (item 2)
- Types: `LinkAndCode`, `RenderedBody`, `TransportAttempt`, `DeliveryResult`

Optionally, update the canonical file header's first paragraph (outside the block) to mention delivery-outcome classification.

#### 1.5 Two-copy edit procedure

Edit the canonical first. Then replace the Deno block with the canonical block mechanically: splice the lines between the markers with a one-off script or editor, rather than retyping. Run `npx jest src/lib/authEmailHook.parity.test.ts` right after.

#### 1.6 Direct jest additions (`src/lib/authEmailHook.test.ts`, additions only)

**`resolveRedirect`:**
- usable redirect → returned raw
- `''` redirect → site_url
- `javascript:` redirect → site_url
- both unusable → `null`
- `imr://reset-password` → allowed

**`resolveLinkAndCode`** (one assertion per table row; use `toStrictEqual`):
- notification, even with a non-empty leg hash and code → `{link:"",code:""}`
- reauthentication → code only
- recovery → link, `code:""`
- recovery with empty hash → `null`
- signup and invite with empty hash → `null`
- signup with hash → link, `code:""`
- magiclink with empty hash → `{link:"", code}`
- magiclink with hash and both redirect bases unusable → `null`
- magiclink with `supabaseUrl ''` and app-shaped site → `null`
- unknown type with hash and token → both

**`renderBody`** (one case): a notification body has no "If you did not request this" line, and a body with `link ""` has no `<a href`.

### 1G. Golden equivalence check (item 1)

#### Files
- **Fixture:** `src/lib/authEmailHook.golden.json`, next to the test.
- **Test:** a new file, `src/lib/authEmailHook.golden.test.ts`. It is matched by the unit project's `src/lib/**/*.test.ts` and type-checked by `tsconfig.test.json`. A separate file keeps the large matrix out of the existing suite and lets the check run alone.
- The matrix **must live inside the `.test.ts` file**, not in a shared `.ts` module. The spec 165 lint in `placeholderEmail.parity.test.ts` scans non-test `src/**/*.ts` for the placeholder domain, and placeholder inputs would trip it. The JSON fixture is not scanned (`.json`).
- The test imports **only** `parsePayload`, `planMails` and the `Plan` type. It must not import any of the new split functions, so it runs unchanged against the baseline.

#### Why a JSON fixture rather than `__snapshots__`
- A local `npx jest` (not `--ci`) silently **writes** a missing snapshot.
- `jest -u` silently rewrites an existing one.

Both break "a missing golden fails; never silently written". A fixture read with `fs` cannot be created or rewritten by jest itself.

#### Fixture shape
Written as `JSON.stringify(obj, null, 2) + "\n"`, UTF-8:

```
{
  "baseline": "227436c",
  "baselineBlockSha256": "<hex>",
  "cases": [ { "name": "<id>", "supabaseUrl": "<str>", "input": <raw payload>, "output": <Plan> } ]
}
```

`output` is the whole `planMails` result, so `ok`, `action`, `dropped`, `reason` and every mail's `to`/`subject`/`html`/`text` are all captured.

#### Verify mode (default; the only mode in CI)
1. If `!fs.existsSync(GOLDEN)`, **fail**. The message points at the capture procedure below.
2. `golden.cases.map(c => c.name)` `toEqual` the matrix names, **in order**. This fails on any added, removed or renamed case.
3. For each case (`it.each` for per-case diagnostics):
   - the golden `input` `toStrictEqual` the matrix `input`, and `supabaseUrl` is equal
   - `planMails(parsePayload(input)!, supabaseUrl)` `toStrictEqual` the golden `output`
   - also assert `parsePayload(input) !== null`

`toStrictEqual` compares strings exactly, so html/text must be byte-identical.

#### Capture mode
Run `AUTH_EMAIL_HOOK_GOLDEN=capture npx jest src/lib/authEmailHook.golden.test.ts`. Capture mode:
- **refuses** (throws) when `process.env.CI` is set
- **refuses** when the fixture already exists. To recapture, delete it deliberately; the deletion shows in `git status`.
- **refuses** unless the sha256 of the working-tree canonical core block equals a constant hard-coded in the test, `BASELINE_227436C_BLOCK_SHA256`. Hash the lines strictly between the BEGIN/END markers, joined with `"\n"`, using the same extraction rule as `authEmailHook.parity.test.ts`. The developer computes the constant once by running that extraction plus `crypto.createHash('sha256')` over `git show 227436c:src/lib/authEmailHook.ts` (a short `node -e` reading stdin), and records the value in the implementation notes. After the refactor the hash no longer matches, so a post-refactor capture is mechanically impossible.
- writes the fixture, including `baselineBlockSha256`, and then **throws** `golden written — re-run without AUTH_EMAIL_HOOK_GOLDEN to verify`, so a capture run is never green.

#### Order of work (mandatory)
1. Before touching either hook file, confirm `git diff --quiet HEAD -- src/lib/authEmailHook.ts supabase/functions/auth-email-hook/index.ts` and the same with `--cached`.
2. Write the golden test, then run capture mode.
3. Run verify mode against the unmodified baseline. This is **run #1**, recorded in the implementation notes along with `shasum -a 256 src/lib/authEmailHook.golden.json`.
4. **`git add` the fixture and the golden test immediately.**
5. Do the refactor (items 1 and 2) and run verify mode again. This is **run #2**, recorded.
6. `git diff --exit-code -- src/lib/authEmailHook.golden.json` must be clean (unstaged vs index), and the sha256 must be unchanged.

#### Minimum matrix
Each case has a stable id. Defaults:
- user: `REAL` = `manager@example.com`
- `token '123456'`, `token_hash 'hash-main'`
- `redirect_to 'http://localhost:8081/reset-password'`
- `site_url 'https://abc.supabase.co/auth/v1'` (API-shaped)
- `supabaseUrl 'http://kong:8000'`

**A. Every §3.3 type plus unknown, with default inputs:**
- `recovery`, `signup`, `invite`, `magiclink`, `email`, `reauthentication`
- the 7 `*_notification` types (they carry a non-empty token/hash, which routing must blank)
- `zz_future_type` with hash and token
- `email_change` appears in group B

**B. `email_change`:**
- secure, both real: `token 111111`, `token_hash hash-for-new`, `token_new 222222`, `token_hash_new hash-for-current`, `new_email REAL_NEW`
- single-pair with `token`
- single-pair with `token_new` (the code comes from `token_new`)
- placeholder current + real new
- real current + placeholder new
- both placeholder (dropped 2, no mails)
- no `new_email` (→ `invalid_payload`)

**C. Recovery:**
- redirect with no `?` (the default)
- `https://app.example.com/r?x=1` (`&` separator)
- hash `pkce_a/b+c=`
- redirect `javascript:alert(1)` with site `https://site.example.com` (fallback)
- redirect `not a url` with site `https://site.example.com`
- redirect `''` with site `''` (→ `unlinkable`)
- redirect `imr://reset-password`

**D. signup and invite with empty `token_hash`** (→ `unlinkable`).

**E. Unlinkable link types:**
- `magiclink` with redirect `''` and site `''`
- `invite` with site `''` and supabaseUrl `''`

**F. `verifyBase` branches:**
- `magiclink` and `signup` with an API-shaped site
- the same with an API-shaped site plus a trailing `/`
- the same with an app-shaped site `http://127.0.0.1:3000` (SUPABASE_URL fallback)
- an app-shaped site with supabaseUrl `https://abc.supabase.co/`

**G. Escaping:**
- `email_change` with `new_email '"><script>alert(1)</script>@example.com'`
- `recovery` with redirect `https://x.example.com/"><script>`

**H. `email_changed_notification`:**
- with `old_email 'old@example.com'`
- without `old_email`
- with a placeholder `old_email`

**I. Other:**
- all-placeholder `recovery` (dropped 1)
- trimmed recipient `'  manager@example.com '`
- `reauthentication` with an empty token
- `magiclink` with an empty hash but a token (code, no link)
- unknown type with a token and no hash
- the probe shape `zz_preflight_probe` with every field empty
- `recovery` with a blank user email (→ `invalid_payload`)

### 2. `deliver()` and `classifyDelivery()`

#### 2.1 Core block additions (both copies, after `isTransportSuccess`)

```ts
type TransportAttempt = { kind: "threw"; errorName: string } | { kind: "status"; status: number };
type DeliveryResult = { ok: true } | { ok: false; reason: "timeout" | "transport"; status?: number };
function classifyDelivery(attempt: TransportAttempt): DeliveryResult;
```

The mapping. **Return object literals exactly as shown, with no `status` key on the throw rows**, because jest uses `toStrictEqual`:
- `threw` with `errorName` `"TimeoutError"` or `"AbortError"` → `{ ok: false, reason: "timeout" }`
- `threw` with any other name, including `""` → `{ ok: false, reason: "transport" }`
- `status` where `isTransportSuccess(status)` → `{ ok: true }`
- any other `status` → `{ ok: false, reason: "transport", status }`

Rationale for moving it in: the input is runtime-neutral (a string or a number), so the block stays pure in both TS graphs, and the mapping becomes the only part of the delivery path with unit coverage. The comment must avoid `fetch(` (see §1.3).

**Jest** (additions in `authEmailHook.test.ts`), all with `toStrictEqual`: `TimeoutError`, `AbortError`, `TypeError`, `""`, and statuses 199, 200, 299, 300, 500.

#### 2.2 `index.ts`, outside the block

```ts
async function deliver(cfg: TransportConfig, mails: PlannedMail[], webhookId: string): Promise<DeliveryResult>;
```

It loops `i = 0..mails.length-1` **sequentially**:
1. `r = buildTransportRequest(cfg, mails[i], webhookId + ":" + i)`. This stays **outside** the try/catch around the network call. If it throws, the throw propagates to the handler's outer catch (500 `internal error`, no reason), as in the baseline.
2. Make the network call with `AbortSignal.timeout(TRANSPORT_TIMEOUT_MS)`. On a throw, return `classifyDelivery({ kind: "threw", errorName: e instanceof DOMException ? e.name : "" })`.
   - The `instanceof DOMException` test stays exactly as in the baseline. A non-DOMException error that happens to be named `TimeoutError` is still `transport`.
3. `try { await res.body?.cancel(); } catch {}`. Never read the provider body.
4. `const c = classifyDelivery({ kind: "status", status: res.status }); if (!c.ok) return c;`. The first failure stops the loop.

After the loop, return `{ ok: true }`. Move the "worst case ~2 × 2 s" comment onto `deliver()`.

**Handler step 9** becomes:
- `const webhookId = req.headers.get("webhook-id") ?? "";` (stays in the handler)
- `const result = await deliver(cfg, plan.mails, webhookId);`
- If `!result.ok`: `logOutcome({ action, outcome: "failed", recipients, dropped, status: result.status, reason: result.reason })` and return 500 `{"error":"delivery failed"}`.

`logOutcome` already omits `status` when it is not a number, so the throw paths still log no `status` key. The key order is fixed by `logOutcome`. Steps 1-8 and 10 are untouched.

### 3. Smoke arm S10: transport rejects a real recipient

#### Placement
A new `step "S10: transport rejects a real recipient → 500 delivery failed, 0 mails"` goes immediately **after the S6 block** (after its placeholder sub-arms) and **before S6b**.
- It sits with the other signed synthetic arms.
- It is far from the S2/S3b/S4 `/recover` spacing.
- It runs before S7, so S7's hygiene pass covers it.

The label is S10 rather than renumbering, because the S-labels are referenced from spec 166. Add a header arm-list line after S6.

#### Recipient and payload
- Recipient: `BAD_TO="not-an-address"`. Mailpit rejects it with 400 (established on 2026-10-21; record this in a script comment). It is not a placeholder, it is a non-empty string, it passes `parsePayload`, and `routeLegs` keeps it.
- Payload: `syn_payload recovery "$BAD_TO" "" "$SC" "$SH" "" ""` with `SH="synhash$(rand_hex 12)"` and `SC=$(rand_code)`.
- Why `recovery`: `syn_payload` supplies a usable `redirect_to` and the hash, so the request passes render, and the remembered hash lets **S7 also prove that no token hash leaks into logs or bodies on the fail-closed path**.
- Call `remember "$BAD_TO" "$SH" "$SC"` **before** the hook call.

#### Sequence
1. **Precondition, a direct Mailpit probe from the host.**
   - POST `${MAILPIT_URL}/api/v1/send` with `{"From":{"Email":<edge SEND_EMAIL_FROM via docker exec printenv>},"To":[{"Email":"not-an-address"}],"Subject":"s168 probe","Text":"x"}`, and capture `MP_CODE`.
   - Then `mp_clear`.
   - If `MP_CODE` is 2xx or empty: `fail "Mailpit now accepts 'not-an-address' (HTTP ${MP_CODE}) — spec 168 item 3 needs a new rejected recipient; return to the architect"` and skip the remaining S10 assertions. This is a FAIL, not a SKIP.
   - Otherwise `pass "precondition: Mailpit /api/v1/send rejects 'not-an-address' → HTTP ${MP_CODE}"`.
2. `mp_clear`, then assert the total is 0.
3. `S10_START=$(date -u +%Y-%m-%dT%H:%M:%SZ); sleep 1` (the same second-granularity guard as `SMOKE_START`).
4. Call `hook_signed` with the payload. Assert `CODE == 500` **and** `jq -c . <<< BODY == '{"error":"delivery failed"}'`.
5. `mp_wait 0`, the 2 s settle: `pass "Mailpit total = 0 after the rejected send"`.
6. Poll for up to 5 s, at 250 ms intervals:
   - read `docker logs --since "$S10_START" "$EDGE_CONTAINER"`
   - strip the prefix with `sed -E 's/^[^{]*//'`, as S7 does
   - pass the lines through `grep '{'`, then `jq -c 'select(.hook=="auth-email-hook" and .action=="recovery" and .outcome=="failed" and .reason=="transport" and (.status|type)=="number" and .status==<MP_CODE> and .recipients==1 and .dropped==0)' 2>/dev/null`
   - PASS when exactly one matching line is found

#### Constraints
No change to `config.toml`, the hook code or Mailpit configuration. If `not-an-address` stops being rejected, the precondition fails loudly.

### 4. S9 autoconfirm precondition

1. At the top of S9, after `FX_BEARER`, read `AC="${S9_AUTOCONFIRM_OVERRIDE-$(docker exec "$AUTH_CONTAINER" printenv GOTRUE_MAILER_AUTOCONFIRM 2>/dev/null)}"`. Track whether the override was used.
2. Print one **info line**, not a PASS, so the PASS lines stay byte-identical to the baseline. Use the D11 style: `printf '         S9 precondition: GOTRUE_MAILER_AUTOCONFIRM=%s%s\n' "'$AC'" "<' (S9_AUTOCONFIRM_OVERRIDE)' when overridden>"`.
3. `email_change_round <from> <to> <redeem: old|new|none>`:
   - PUT, `mp_wait 2`, hash extraction, `remember`, and the "one message to the old address, one to the new" PASS.
   - The **hash-equality PASS/FAIL** (old-leg = `email_change_token_current`, new-leg = `email_change_token_new`) always runs.
   - When `which == none`, return right after the hash-equality check.
   - The PUT PASS label is `(${which}-leg round)` for old/new and `(hash-equality round)` for none.
4. Dispatch:
   - If `AC` is exactly `true`: `email_change_round "$REAL_FX" "$NEW_FX" old; sleep 2; email_change_round "$NEW_FX" "$NEW_FX2" new`. This is identical to the baseline.
   - Otherwise: `email_change_round "$REAL_FX" "$NEW_FX" none`, then `skip "S9 redemption" "GOTRUE_MAILER_AUTOCONFIRM='${AC}'${override_note}; the first-leg-completes-change mechanics need autoconfirm"`. There is no second round, because it starts from the changed address. The pending change is removed with the fixture by the EXIT trap.
5. Update the S9 block comment and add a header Usage note: `S9_AUTOCONFIRM_OVERRIDE=<value>` is **test-only**, forces the SKIP branch, and is never set in `test:smoke`.

**Proving the SKIP branch:**
- Run the full smoke once with `S9_AUTOCONFIRM_OVERRIDE=false`. Record that S9 prints the info line, the hash-equality PASS lines and exactly one `SKIP S9 redemption (reason: GOTRUE_MAILER_AUTOCONFIRM='false' (S9_AUTOCONFIRM_OVERRIDE); …)`, and that nothing else changes.
- Run it once without the override. Record the baseline PASS lines plus the info line `'true'`.
- No `config.toml` change.

### 5. `npm:` + `deno.lock`: fallback taken

**Sources** (as established by main Claude via the Supabase docs MCP on 2026-10-21):
- [Managing dependencies](https://supabase.com/docs/guides/functions/dependencies) recommends a per-function `deno.json` with `npm:` imports, and recommends against a global one for deploy. It says **nothing** about `deno.lock` being honoured by `supabase functions serve` or `deploy`.
- [Securing npm installs](https://supabase.com/docs/guides/security/npm-security), Edge Functions section, describes no runtime-layer release-age gate. It advises exact pins, vendoring, and `--lock` in CI.

**Decision.** Criteria (a), (b) and (c) cannot be confirmed for CLI 2.95.4, CLI 2.106.0, `latest`, or the owner's deploy bundler path. Without a lock that is proven to be honoured, `npm:standardwebhooks@1.0.0` lets `@stablelib/base64 ^1.0.0` and `fast-sha256 ^1.3.0` float under semver at bundle time. That is **strictly weaker** than today's `?deps=` pin, which fixes both, and it would invalidate the spec 166 fix-1 fuzz evidence against `@stablelib/base64@1.0.1`. The spec's fallback clause applies, so the owner does **not** need to be asked about installing deno.

**Developer action:** comment only, at `index.ts:47-50`. Replace "Follow-up: npm: specifier + deno.lock." with a short rationale, for example:

```
// Spec 168 item 5: kept on esm.sh ?deps= deliberately. Supabase docs don't
// confirm a per-function deno.lock is honoured by serve/deploy, and npm: without
// an honoured lock would let these transitive deps float (weaker than this pin).
```

The import line itself is byte-unchanged. There is no `deno.json`, `deno.lock` or `config.toml` change, and no `import_map` entry. The file header has no esm.sh reference, so it needs no change. Record "item 5: fallback taken (architect design §5)" in the implementation notes.

**Facts for a future spec:**
- No `.gitignore` rule excludes `deno.lock` (checked).
- `[edge_runtime] deno_version = 2`.
- The lockfile format version and deno vendoring mechanics in Deno 2 must be confirmed then, not assumed. The docs page's `deno vendor` advice may predate Deno 2's `"vendor": true` setting.
- The strongest option is to drop the dependency altogether: an inline Standard Webhooks verifier using WebCrypto HMAC, a constant-time compare and the ±5 min tolerance, parity-tested like the core. That needs its own spec plus a security review.

### 6. Probe HMAC via node stdin

- **Decode stays in bash/openssl, byte-unchanged:** `KEY_HEX=$(printf '%s' "${SECRET#v1,whsec_}" | openssl base64 -d -A 2>/dev/null | od -An -tx1 | tr -d ' \n')` followed by the existing `die "HOOK_SECRET did not base64-decode"`. `printf` is a bash builtin, so the secret only ever travels through pipes. This keeps the refusal semantics exactly as they are, and risk 6 (node's lenient base64) cannot arise.
- **node gets the decoded hex, not the `whsec_` secret.** Only line 81 changes. `SIG=$(printf '%s\n%s' "$KEY_HEX" "${MSG_ID}.${TS}.${BODY}" | node -e "$HMAC_JS")`, where `HMAC_JS` is a fixed script string with no secret in it. Contract:
  - stdin is `<lower-hex key>` LF `<message bytes>`. Split at the **first** LF, and HMAC the raw message bytes as a Buffer, with no string re-encoding.
  - If the key line is empty, not `^[0-9a-f]+$`, or odd-length, exit non-zero with nothing on stdout.
  - stdout is the standard padded base64 of HMAC-SHA256 with no newline, matching today's `openssl base64 -A`.
- **Ordering:** node runs **after** the existing `unset SECRET HOOK_SECRET`, so node's environment never contains the secret. `KEY_HEX` is a non-exported shell variable. Keep `unset KEY_HEX` right after.
- **New guards:**
  - `command -v node >/dev/null 2>&1 || die "node is required on PATH to sign the probe"`. Place it after the `--to` checks and **before** the secret is read or prompted, so the owner is never asked for a secret that then can't be used.
  - `[[ -n "$SIG" ]] || die "could not compute the signature"`. This is a new refusal on a path that could not fail meaningfully before, and it's better than sending `v1,` unsigned. Flag it in the notes.
- **Header:** replace "Exposure note (security L1)" with a "Key handling" note. The secret comes from the env or a no-echo prompt and is decoded by `openssl base64 -d` from a pipe. The decoded key reaches `node` only on stdin and is never on any argv. `SECRET`/`HOOK_SECRET` are unset before node runs. Requires `node`, `openssl`, `jq` and `curl`. Adjust `sed -n '2,Np'` so N is the last line before `set -u`, as today's 31 is. The file must contain no `-macopt` or `hexkey`.
- **Test vector** (implementation notes):
  - key = the decoded D7 literal (public)
  - id = `msg_vector`
  - ts = `1700000000`
  - two bodies: `{"a":"b"}` and a non-ASCII `{"e":"é—"}`
  - record the node output and `openssl dgst -sha256 -mac HMAC -macopt hexkey:… -binary | openssl base64 -A` for each; they must be identical
- **Local runs:**
  - env path
  - TTY prompt path: needs a real TTY; if the developer has none, use `script -q /dev/null bash scripts/probe-auth-email-hook.sh …` or ask the owner to run it, and record which
  - a wrong but well-formed secret → 401 plus the hint
  - unset secret with stdin not a TTY → refused
  - PATH without node → refused, exit 2
- **Optional micro-hardening, owner decides at plan approval:** `unset HOOK_SECRET` immediately after line 58 copies it into `SECRET`, so the `openssl`/`od`/`tr` decode children no longer inherit an exported `HOOK_SECRET`. The existing `unset SECRET HOOK_SECRET` line stays.
- **Smoke `sign_headers`: NOT aligned.** It only ever signs with the public D7 literal and a random throwaway wrong key, so there is no exposure to close. The smoke also keeps openssl for the D7 decode and the S3b PKCE challenge. Changing it would only add risk to the S5 gate arms.

### 7. tests/README.md (Track 3)
- Extend the `smoke-send-email-hook.sh` bullet with: "a transport-rejected real recipient → 500 `delivery failed`, 0 mails (S10); S9 redemption SKIPs unless `GOTRUE_MAILER_AUTOCONFIRM=true`".
- Add "requires `node`" to the probe paragraph.

### 8. Risks and tradeoffs
1. **Two-copy drift.** Mitigated by the mechanical splice (§1.5) and the parity test. Also watch the parity (b) word traps in new comments (§1.3).
2. **The handler code outside the block is type-checked nowhere.** There is no deno locally, and `tsconfig` excludes `supabase/functions`. The edge runtime transpiles without type-checking, so `deliver()` is proven only by the smoke (S2/S6 sent, S10 transport failure) and by review. Keep `deliver()` minimal.
3. **The timeout branch has no live proof.** A hanging transport would need a config change, which is out of scope. jest covers `classifyDelivery`, and review covers the `instanceof DOMException → name` conversion.
4. **Golden coverage.** The §1G matrix exceeds the spec minimum, and the name/input lock stops the matrix and fixture drifting apart. The capture-time block-hash guard proves the fixture's provenance.
5. **Hot reload.** `per_worker` should pick up `index.ts` edits. If the smoke shows stale behaviour, `docker restart supabase_edge_runtime_imr-inventory`, and first run the CLAUDE.md bind-mount check.
6. **S10 depends on Mailpit's validation.** A Mailpit image bump could start accepting the address. The precondition then FAILs with an actionable message instead of a false pass.
7. **The override knob can be misused.** `S9_AUTOCONFIRM_OVERRIDE` only reduces coverage, and its use is printed in both the info line and the SKIP reason. It must never be set in `test:smoke`.
8. **Item 5 residual.** esm.sh remains a deploy-time network dependency with no integrity lock on esm.sh's build output (spec 166 risk 9). This is unchanged from the baseline.
9. **Prod.** No deploy in this spec. The refactored function reaches prod only at the owner's spec 166 runbook steps 4/5/5b, and step 5b's probe (now using node) is the prod acceptance. Performance and cold start are unchanged: no new dependencies, and the same number of network calls.
10. **Shared Mailpit.** Run `smoke-send-email-hook.sh`, `test:smoke` and any spec 167 `smoke-store-user.sh` strictly one after another.
11. **No migration, RLS, realtime publication, `db.ts` or store impact.** The realtime restart gotcha does not apply.

### 9. Expected files changed
- `src/lib/authEmailHook.ts`: core block (items 1 and 2), export list, optional header line
- `supabase/functions/auth-email-hook/index.ts`: identical core block, `deliver()`, step 9, the item 5 import comment
- `src/lib/authEmailHook.test.ts`: additions only
- `src/lib/authEmailHook.golden.test.ts`: new
- `src/lib/authEmailHook.golden.json`: new, captured from the baseline
- `scripts/smoke-send-email-hook.sh`: S10, S9, header
- `scripts/probe-auth-email-hook.sh`: node HMAC, guards, header, `--help` range
- `tests/README.md`: Track 3 lines
- This spec: implementation notes and files changed

Not changed: `supabase/config.toml`, `src/lib/authEmailHook.parity.test.ts`, any `deno.json`/`deno.lock`, and every spec 167 path.

## Implementation notes

Backend developer, 2026-10-21. Baseline `227436c` (HEAD equal to it for both hook files). The owner approved the file-by-file plan in chat ("Run the full pipeline for spec 168; stage your own paths only, don't commit"), including the optional early `unset HOOK_SECRET` (§6). Nothing was installed or downloaded.

### Item 1: golden check, order of work (§1G)
1. Pre-edit check: `git diff --quiet HEAD -- src/lib/authEmailHook.ts supabase/functions/auth-email-hook/index.ts` and the same with `--cached` → both clean.
2. `BASELINE_227436C_BLOCK_SHA256 = 8a27aa0f7612d4191a4aa1da457d998fbf6e0e5e59860c87ce7cf4e6c8e414ec`, computed with `git show 227436c:src/lib/authEmailHook.ts | node -e '…'` (parity-test extraction rule, lines strictly between the markers joined with `"\n"`, sha256).
3. Wrote `src/lib/authEmailHook.golden.test.ts` (54 tests: 2 structural + 52 matrix cases covering every §1G group A-I), then `env -u CI AUTH_EMAIL_HOOK_GOLDEN=capture npx jest src/lib/authEmailHook.golden.test.ts` → wrote the fixture and threw `golden written — re-run without AUTH_EMAIL_HOOK_GOLDEN to verify` (red, as designed).
4. **Run #1** (unmodified baseline): `npx jest src/lib/authEmailHook.golden.test.ts` → **54 passed**. `shasum -a 256 src/lib/authEmailHook.golden.json` → `cb33ffb0412ac48b3633b40eb212ecf53b76eb2da20764a597e7a06ffaee1b14`.
   - Capture guards proven on the baseline: a second capture → `golden capture refused: … exists`; `CI=1` capture → `golden capture refused: CI is set`. The fixture's sha was unchanged afterwards.
5. `git add src/lib/authEmailHook.golden.json src/lib/authEmailHook.golden.test.ts` immediately, before the refactor.
6. Refactor (items 1 + 2). The canonical block was edited first, then spliced into the Deno file with a one-off node script (lines between the markers replaced wholesale, no retyping). Then `npx jest src/lib/authEmailHook` → 3 suites green (parity passes unmodified).
7. **Run #2** (refactored): `npx jest src/lib/authEmailHook.golden.test.ts` → **54 passed**. `git diff --exit-code -- src/lib/authEmailHook.golden.json` → clean. sha256 unchanged (`cb33ffb0…1b14`).
   - Post-refactor guard proven: with the fixture moved aside, capture → `golden capture refused: the working-tree core block (9c38eb1f…3a7b) is not the 227436c block`, and verify → `golden fixture … is missing` (red, nothing written). The fixture was restored; `git diff --exit-code` stayed clean.

Refactor shape is as designed (§1.1-§1.4): `resolveRedirect` (after `usableRedirect`, also used by `recoveryLink`), `resolveLinkAndCode` (single `linkOnly` definition, explicit notification return, action-type rationale comment above it), `renderBody` (moved verbatim; `p.user.new_email` → `newEmail` parameter), and `renderMail` as a 4-line composer, so `planMails` is untouched. The D11 comment is reworded; `verifyBase` logic is unchanged. No new comment in the block contains `export`, `fetch(`, `console.`, `Deno.` or the placeholder domain (parity (b) green). The canonical header's first paragraph mentions delivery-outcome classification. `authEmailHook.test.ts`: additions only. The import list gained the new names (that is the diff's one changed line); no existing case was edited or removed.

### Item 2
`classifyDelivery` + `TransportAttempt` / `DeliveryResult` were added to the core block after `isTransportSuccess`, with jest coverage (TimeoutError, AbortError, TypeError, `""`, 199/200/299/300/500; `toStrictEqual`). `deliver()` is in `index.ts` exactly as §2.2 describes: `buildTransportRequest` outside the try, `instanceof DOMException ? e.name : ""`, body cancel, first failure returns. Step 9 maps the result onto `logOutcome`. The container serves the edited file: `grep` inside `supabase_edge_runtime_imr-inventory` finds `deliver` and `classifyDelivery`, and the bind mount points at the repo root. Live proof is S2/S6 (sent), S10 (non-2xx), and S7 (log key set). As the design notes (§8 risk 3), the timeout branch has no live proof.

### Item 3: S10
- Recipient `not-an-address`. Mailpit `/api/v1/send` answers **HTTP 400** `{"Error":"invalid To address: not-an-address"}`. This was probed on 2026-10-21 from the host (`127.0.0.1:54324`) and from inside the stack's Docker network, using the hook's own `MAILPIT_SEND_URL` host (`supabase_inbucket_imr-inventory:8025`). The edge container has no curl/wget, so the in-network probe used `node`'s fetch inside `supabase_studio_imr-inventory`. The authoritative edge-runtime evidence is S10's own log assertion, `status:400`, emitted by the hook running in the edge runtime.
- No config.toml, hook-code or Mailpit change was made. The values are recorded in the S10 script comment.
- Minor implementation choices within the design (flagged for review):
  - (a) The precondition treats curl's `000` (no HTTP response) like empty, but as a separate FAIL with its own message, because "Mailpit now accepts" would be misleading there.
  - (b) The log poll uses `jq -cR 'fromjson? | select(…)'` rather than plain `jq -c`, so a single non-JSON line in the window cannot abort the stream.
  - (c) Step 2's "total is 0" assertion prints as `PASS Mailpit cleared`.

### Item 4: S9 precondition
- Without the override, S9 prints `S9 precondition: GOTRUE_MAILER_AUTOCONFIRM='true'` plus the baseline PASS lines byte-for-byte (`(old-leg round)` / `(new-leg round)` labels unchanged).
- With `S9_AUTOCONFIRM_OVERRIDE=false`, S9 prints:
  - the info line `'false' (S9_AUTOCONFIRM_OVERRIDE)`
  - `PUT … (hash-equality round) → 200`, the "one message to the old address, one to the new" PASS, and the hash-equality PASS
  - exactly one `SKIP S9 redemption (reason: GOTRUE_MAILER_AUTOCONFIRM='false' (S9_AUTOCONFIRM_OVERRIDE); the first-leg-completes-change mechanics need autoconfirm)`
- A normalized `diff` of the two full runs differs **only** in those S9 lines. Everything else is identical and the output ends in ALL ARMS PASSED.

### Item 5
**Fallback taken (architect design §5).** Only the import comment changed; the import line itself is byte-unchanged. No deno install, no `deno.json` / `deno.lock`, no `config.toml` change.

### Item 6: probe
- **Decode unchanged** (openssl). The key reaches node only on stdin; `HMAC_JS` contains no secret.
- **New guards:**
  - node-on-PATH check, placed before the secret read
  - early `unset HOOK_SECRET` right after the copy (owner-approved); the existing `unset SECRET HOOK_SECRET` stays
  - `[[ -n "$SIG" ]] || die "could not compute the signature"`. This is a **new refusal** on a path that could not fail before, flagged per design.
- **Header:** "Key handling" replaces "Exposure note"; `--help` is now `sed -n '2,34p'`, which still ends at the blank line before `set -u`. `grep -c 'macopt\|hexkey'` → 0.
- **Test vector:**
  - key = the decoded D7 literal `2ce0802ff0c457f38d2d8fe29abfd27a774499a8a51e8a24fcda2d168acfae877fd34d34`, id `msg_vector`, ts `1700000000`
  - the script's own `HMAC_JS`, extracted from the file, compared with `openssl dgst -sha256 -mac HMAC -macopt hexkey:… -binary | openssl base64 -A` (OpenSSL 3.6.2):
    - `{"a":"b"}` → node `xqgCspicZv/oSTd9Q1fnDS8JxTgxgn77rND6oyBOui4=` = openssl, **IDENTICAL**
    - `{"e":"é—"}` (13 bytes) → node `9tmyMw8kfLRfWKnqherF2jbqNDoM6962K50b8EUjMLE=` = openssl, **IDENTICAL**
  - bad key lines (`""`, `ABCD`, `abc`, `zz`, no LF) → exit 2, empty stdout
- **Local runs** against `http://127.0.0.1:54321/functions/v1/auth-email-hook`:

  | Run | Result |
  |---|---|
  | env path | OK 200 `{}`, exit 0, 1 "Account notification" in Mailpit |
  | TTY prompt path, via `script -q /dev/null` with delayed input | OK 200 `{}`, exit 0, 1 "Account notification" |
  | wrong but well-formed secret | `FAIL HTTP 401 (invalid signature)` + mismatch hint, exit 1 |
  | unset secret, stdin not a TTY | REFUSE, exit 2 |
  | PATH without node | `REFUSE node is required on PATH to sign the probe`, exit 2 |
  | `v1,whsec_` + 32×`=` | `REFUSE HOOK_SECRET did not base64-decode`, exit 2 |
  | placeholder `--to` | REFUSE, exit 2 |
  | LOCAL secret against https | REFUSE, exit 2 |
  | malformed shape | REFUSE, exit 2 |
  | missing args | REFUSE, exit 2 |

- **argv/env proof:** a `node` shim on PATH recorded node's argv and environment during the env-path run. 0 argv lines contained the key hex or the secret, and 0 env entries matched `whsec_` / `HOOK_SECRET` / `LOCAL/DEV`.
- Smoke `sign_headers` is not aligned, per design.

### Verification (in the required order)
1. `npx jest` (full) → **233 suites, 2802 tests passed**, 2 snapshots passed.
2. `npm run typecheck` → exit 0; `npm run typecheck:test` → exit 0.
3. `bash scripts/smoke-send-email-hook.sh` → **ALL ARMS PASSED**:
   - S10: 5 PASS, including `hook logged outcome:failed reason:transport status:400 (recipients 1, dropped 0)`
   - the S9 info line `'true'` and the baseline S9 PASS lines
   - S7: 50 hook log lines within the §5 key set, and no leak of `not-an-address` or the S10 hash/code
   - the only SKIP is the pre-existing S8

   Then `S9_AUTOCONFIRM_OVERRIDE=false bash scripts/smoke-send-email-hook.sh` → ALL ARMS PASSED, with the S9 SKIP branch as recorded above. No 429 was hit.
4. `npm run test:smoke` → exit 0. All five scripts green, and the spec 166 smoke inside it printed ALL ARMS PASSED. The SKIPs in smoke-edge.sh (`BOBBY_TOKEN`) and smoke-store-user.sh (`USERNAME_RESOLVE_SERVICE_TOKEN`) are pre-existing.
5. Probe signature equivalence: see the item 6 test vector (IDENTICAL on both bodies).

Mailpit-using runs were strictly sequential. Before the first run, `ps` showed no other smoke running; Mailpit held only stale spec 166 leftovers from 2026-10-19.

Observed, not caused by this spec: the edge log line `error in user worker connection: error writing a body to connection` appears right after S5's 413 oversize arm. It occurred 7 times over the container's lifetime, from earlier spec 166 runs too.

## Files changed

**Edge functions**
- `supabase/functions/auth-email-hook/index.ts`: core block re-spliced from the canonical (items 1 + 2), new `deliver()`, step 9 now calls it, item 5 import comment

**src/lib (jest-only canonical + tests)**
- `src/lib/authEmailHook.ts`: core block (`resolveRedirect`, `resolveLinkAndCode`, `renderBody`, `renderMail` composer, `classifyDelivery`, new types, comments), export list, header line
- `src/lib/authEmailHook.test.ts`: additions only (resolveRedirect / resolveLinkAndCode / renderBody / classifyDelivery)
- `src/lib/authEmailHook.golden.test.ts`: new golden equivalence check
- `src/lib/authEmailHook.golden.json`: new fixture captured from the 227436c baseline

**Scripts**
- `scripts/smoke-send-email-hook.sh`: S10 arm, S9 autoconfirm precondition and `none` round, header arm list and override note
- `scripts/probe-auth-email-hook.sh`: node HMAC via stdin, node guard, early `unset HOOK_SECRET`, empty-signature guard, "Key handling" header, `--help` range

**Docs**
- `tests/README.md`: Track 3 lines (S10, S9 SKIP condition, probe requires node)
- `specs/168-auth-email-hook-followups.md`: status, implementation notes, this list

Not changed: `supabase/config.toml`, `src/lib/authEmailHook.parity.test.ts`, any `deno.json` / `deno.lock`, and every spec 167 path.

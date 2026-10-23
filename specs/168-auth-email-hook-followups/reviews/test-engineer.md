## Test report for spec 168

Baseline 227436c. Staged spec 168 paths reviewed: `supabase/functions/auth-email-hook/index.ts`, `src/lib/authEmailHook.ts`, `src/lib/authEmailHook.test.ts`, `src/lib/authEmailHook.golden.test.ts`, `src/lib/authEmailHook.golden.json`, `scripts/smoke-send-email-hook.sh`, `scripts/probe-auth-email-hook.sh`, `tests/README.md`. Spec 167 paths ignored. No source, test or script was edited by this review.

### Acceptance criteria status

**Item 1: renderMail split, comments, golden**
- 1a. `renderMail` split into `resolveLinkAndCode`, `renderBody`, `resolveRedirect` → PASS. `renderMail` survives as a 4-line composer, so `planMails` is untouched. The three functions and `classifyDelivery` are added to the canonical export list. Evidence: `git diff --cached src/lib/authEmailHook.ts`; direct jest cases in `src/lib/authEmailHook.test.ts` (`resolveRedirect`, `resolveLinkAndCode`, `renderBody` describes).
- 1b. Identical edit in both copies; parity test passes unmodified → PASS. `src/lib/authEmailHook.parity.test.ts` is green and unmodified (no staged diff). The two diffs show the same block text.
- 1c. Signup/invite special case in one place → PASS. A single `const linkOnly = action === "signup" || action === "invite"` is used for both the unlinkable and the code-blanking outcomes. Covered by `resolveLinkAndCode` jest cases and golden groups D/F.
- 1d. Empty notification branch removed, rule still explicit → PASS. It is now `if (isNotificationAction(action)) return { link: "", code: "" };`, plus a comment bullet. Covered by the `resolveLinkAndCode` notification case.
- 1e. One comment explaining the action-type differences → PASS. The "Why the action types differ" block above `resolveLinkAndCode` lists all four groups, in both copies.
- 1f. D11 comment reworded, logic unchanged → PASS. The diff touches comment lines only. `verifyBase`'s body is unchanged and the `site_url` branch remains. Smoke S6b still reports the `SUPABASE_URL fallback` branch.
- 1g. Golden equivalence jest check → PASS. `src/lib/authEmailHook.golden.test.ts` (54 tests, 52 matrix cases) against the committed fixture `src/lib/authEmailHook.golden.json`.
  - Matrix groups A-I cover all 14 types plus unknown, the four `email_change` shapes (plus extras), the recovery variants, empty-hash signup/invite, unlinkable link types, both `verifyBase` branches, the `"><script>` cases, and `email_changed_notification` with and without `old_email`.
  - A missing fixture fails (it is never auto-written). Capture mode refuses under CI, refuses to overwrite, and refuses unless the working-tree block hash equals the 227436c block hash.
  - The golden test imports only `parsePayload`, `planMails` and the `Plan` type.
- 1h. Golden passes on the refactor AND on the unmodified baseline → PASS.
  - Refactor: full jest green, golden suite included.
  - Baseline, independently re-verified by this review: the 227436c `authEmailHook.ts` (from `git show 227436c:...`) was transpiled in the scratchpad and run against all 52 fixture cases with `deepStrictEqual` → "baseline matches golden for 52 cases".
  - Provenance: the fixture's `baselineBlockSha256` and the test's constant both equal 8a27aa0f… (matches my recomputation from `git show 227436c:src/lib/authEmailHook.ts`). The fixture sha256 is cb33ffb0… in both the working tree and the index, and `git diff` on it is clean.
  - Developer's recorded run #1 / run #2 are in the spec's implementation notes.
- 1i. Existing `authEmailHook.test.ts` cases unchanged → PASS. The diff is additions only, plus the import-list lines.

**Item 2: `deliver()` extraction**
- 2a. Step-9 loop moved into a named `deliver()`; the handler maps its result → PASS. Evidence: the diff of `index.ts`, and live smoke S2/S6 (sent) and S10 (failed path via `deliver`).
- 2b. Behaviour unchanged → PASS.
  - Sequential loop in plan order; `buildTransportRequest` stays outside the try; the `instanceof DOMException` test is kept; the body is cancelled and never read; the first failure returns; the `Idempotency-Key` is `webhookId:i`.
  - Log keys stay within the allowed set: S7 reports "50 hook log lines, all JSON with keys ⊆ {hook,action,outcome,recipients,dropped,status,reason}".
  - `status` is omitted on throw paths because `result.status` is undefined and `logOutcome` omits non-numbers.
- 2c. Optional pure mapping moved into the core block and jest-covered → PASS. `classifyDelivery` is mirrored in both copies. Jest covers TimeoutError, AbortError, TypeError, "", 199, 200, 299, 300 and 500 with `toStrictEqual` (`describe('classifyDelivery (spec 168 item 2)')`).
  - Gap, accepted by the design (§8 risk 3): the timeout branch of `deliver()` has no live proof. Only the pure `classifyDelivery` is unit-tested. `deliver()` itself runs only in Deno and is exercised through smoke.

**Item 3: S10 smoke arm**
- 3a. Arm covers the 500 `{"error":"delivery failed"}` body, Mailpit total 0 and the log assertion → PASS. Run output:
  - `PASS signed recovery to 'not-an-address' → 500 {"error":"delivery failed"}`
  - `PASS Mailpit total = 0 after the rejected send`
  - `PASS hook logged outcome:failed reason:transport status:400 (recipients 1, dropped 0)`
- 3b. Recipient found empirically, recorded in a script comment → PASS. `not-an-address` gives Mailpit HTTP 400 `invalid To address`. It is not a placeholder, it passes `parsePayload`/`routeLegs`, and the request reaches the transport. The precondition probe passed live: `precondition: Mailpit /api/v1/send rejects 'not-an-address' → HTTP 400`.
- 3c. No config.toml, hook-code or Mailpit change to manufacture the failure → PASS. `git diff --cached` of `supabase/config.toml` is empty.
- 3d. Recipient registered with `remember` so S7 covers it → PASS. `scripts/smoke-send-email-hook.sh:560` `remember "$BAD_TO" "$SH" "$SC"`. S7 reports no hash, address or `no-email.invalid` leak.
- 3e. Placement does not disturb S2/S3b/S4 spacing → PASS. It sits after S6 and before S6b, with no GoTrue call. No 429 occurred across 3 smoke runs plus `test:smoke`.
- 3f. Header arm list documents the new arm → PASS (S10 line in the header).

**Item 4: S9 autoconfirm precondition**
- 4a. Reads `GOTRUE_MAILER_AUTOCONFIRM` from the auth container → PASS. It prints `S9 precondition: GOTRUE_MAILER_AUTOCONFIRM='true'`.
- 4b. `true` → S9 runs as before → PASS. The PASS lines and the `(old-leg round)` / `(new-leg round)` labels are unchanged, plus the one info line.
- 4c. Not `true` → redemption half SKIPs with the observed value in the reason → PASS. Run with `S9_AUTOCONFIRM_OVERRIDE=false`: `SKIP S9 redemption (reason: GOTRUE_MAILER_AUTOCONFIRM='false' (S9_AUTOCONFIRM_OVERRIDE); the first-leg-completes-change mechanics need autoconfirm)`. The run ended with ALL ARMS PASSED.
- 4d. Hash-equality half runs unconditionally as PASS/FAIL → PASS. In the override run: `PASS PUT … (hash-equality round) → 200`, `PASS one message to the old address, one to the new`, `PASS old-leg hash = email_change_token_current, new-leg hash = email_change_token_new`.
- 4e. Same PASS lines on the current stack, plus one info line → PASS.
- 4f. SKIP branch proof documented, with no config.toml change → PASS. Test-only knob `S9_AUTOCONFIRM_OVERRIDE`, documented in the header and not set by `test:smoke`.

**Item 5: npm: + deno.lock**
- 5. Fallback taken, per the architect's design → PASS (fallback outcome; the spec calls it acceptable).
  - The import line is byte-unchanged (esm.sh `?deps=` pin). Only the comment changed.
  - No `deno.json`, `deno.lock` or `config.toml` change: `ls supabase/functions/auth-email-hook` shows only `index.ts`.
  - The rationale is in the index.ts comment and the spec notes.
  - The `npm:` and lock sub-criteria are N/A under the fallback. The function boots and signature verification behaves as before: S5 and the preflight unsigned 401 passed.

**Item 6: probe HMAC via node stdin**
- 6a. HMAC computed by node reading the key from stdin; no secret or key on any argv → PASS. By code inspection: `printf '%s\n%s' "$KEY_HEX" … | node -e "$HMAC_JS"`, and `HMAC_JS` contains no secret. The developer's shim recorded node's argv/env with 0 secret hits (spec notes); I did not re-run that shim.
- 6b. Env hygiene (secret not newly in a child env) → PASS. `unset HOOK_SECRET` right after the copy and `unset SECRET HOOK_SECRET` before node. The new early unset was owner-approved per the notes.
- 6c. Non-decodable secret refused (`did not base64-decode`, exit 2) → PASS. Decode stays in openssl. I re-ran with `v1,whsec_` + 32×`=` → `REFUSE HOOK_SECRET did not base64-decode`, rc=2.
- 6d. Byte-identical signature vs the openssl output for a fixed test vector → PASS on the developer's evidence. Two vectors (ASCII and non-ASCII) are recorded as IDENTICAL in the spec notes. I did not recompute the vector. The end-to-end proof is mine: the local hook returned 200 for a node-signed probe, which means the signature verified.
- 6e. Local runs behave as in spec 166 → PASS (re-run by this review against `http://127.0.0.1:54321/functions/v1/auth-email-hook`):
  - env path: OK HTTP 200 `{}`, rc=0, Mailpit total 1 "Account notification"
  - TTY prompt path via `script -q /dev/null` with delayed input: OK 200 `{}`, Mailpit total 1
  - wrong but well-formed secret: `FAIL HTTP 401 (invalid signature)` plus the mismatch hint, rc=1
  - unset secret with stdin not a TTY: REFUSE, rc=2
- 6f. `node` missing from PATH → clear REFUSE, exit 2 → PASS. Re-run with a node-free PATH: `REFUSE node is required on PATH to sign the probe`, rc=2.
- 6g. No `-macopt` or `hexkey` in the probe script → PASS (`grep -c` = 0).
- 6h. Header "Exposure note" replaced, `--help` range adjusted → PASS. "Key handling" note; `--help` is `sed -n '2,34p'` and prints the header ending at the blank line before `set -u`.
- 6i. Smoke `sign_headers` alignment decision → PASS. The design deliberately did not align it, because the key is the public local dev secret. The rationale is recorded in the design and the notes.
- 6j. Other probe behaviour unchanged → PASS. The probe's REFUSE paths I re-ran (non-decodable secret, node missing, missing secret) all give exit 2, and the 401 path gives exit 1. The placeholder `--to`, https, shape and argument-handling refusals were not re-run by me; the notes record them as passing. The one new refusal, `could not compute the signature`, is flagged as such in the notes.

**Done criteria**
- D1. Full `npx jest` green → PASS (233 suites, 2802 tests).
- D2. `npm run typecheck` and `npm run typecheck:test` clean → PASS (both exit 0).
- D3. `bash scripts/smoke-send-email-hook.sh` prints ALL ARMS PASSED, with only the pre-existing S8 SKIP → PASS (run 1, exit 0).
- D4. `npm run test:smoke` green → PASS (exit 0; all 5 scripts).
- D5. Mailpit smokes run sequentially → PASS. I ran them one at a time and checked `ps` beforehand.
- D6. Staging discipline (stage spec 168 paths only, never commit; plan approval before the first edit) → PASS on observation. Nothing is committed and spec 168 files are staged. Approval is recorded in the implementation notes, and I cannot independently verify it.
- D7. `tests/README.md` Track 3 lines updated → PASS (S10 and S9 SKIP line, probe requires `node`).

Totals: 0 FAIL, 0 NOT TESTED. Every criterion above is PASS. The sub-points that rest on the developer's recorded evidence rather than my own re-run are called out in the lines above (6a argv/env shim, 6d test vector).

### Test run
Sequential, by this review, on the local stack:
1. `npx jest`: Test Suites 233 passed / 233; Tests 2802 passed / 2802; Snapshots 2 passed.
2. `npm run typecheck`: exit 0. `npm run typecheck:test`: exit 0.
3. `bash scripts/smoke-send-email-hook.sh`: exit 0, ALL ARMS PASSED. Preflight, S5, S1-S4, S6, S10 (5 PASS), S6b, S9 (info line `'true'` plus baseline PASS lines), S7 (50 hook log lines within the key set, no leaks). The only SKIP is S8.
4. `npm run test:smoke`: exit 0. smoke-edge, smoke-rpc, smoke-edge-roles, smoke-store-user and smoke-send-email-hook all ended ALL ARMS PASSED. The SKIPs are pre-existing: BOBBY_TOKEN in smoke-edge, `USERNAME_RESOLVE_SERVICE_TOKEN` in smoke-store-user, and S8.
5. Extra: `S9_AUTOCONFIRM_OVERRIDE=false bash scripts/smoke-send-email-hook.sh`: exit 0, ALL ARMS PASSED. The S9 hash-equality PASS lines ran, with exactly one `SKIP S9 redemption`.
6. Extra: independent baseline check. The 227436c `authEmailHook.ts` run against the committed golden fixture gave 52/52 cases byte-identical (`deepStrictEqual`).
7. Extra: probe local runs, as listed under 6c, 6e and 6f.

No 429 occurred. No failing tests. Mailpit was cleared at the end of my probe runs.

### Notes
- Item 5 fallback: the esm.sh `?deps=` pin remains with no integrity lock on esm.sh's build output. It is unchanged from the baseline and is the architect's recorded residual risk (§8 risk 8).
- `deliver()` and the Deno handler are not type-checked or unit-tested in jest, because they only run in Deno. Coverage is live smoke (S2/S6 for sent, S10 for non-2xx) plus the jest-covered `classifyDelivery` mapping. The timeout and throw branches of `deliver()` have no live proof; this is accepted by the design (§8 risk 3), but it is a residual gap.
- S10 depends on Mailpit continuing to reject `not-an-address`. If an image bump changes that, the precondition FAILs loudly with an actionable message, so it will not give a false pass.
- Observed, pre-existing and not caused by this spec: the edge log line `error in user worker connection: error writing a body to connection` after S5's 413 arm (also noted by the developer).
- The probe now has one new refusal path (`could not compute the signature`), flagged in the design and the notes.
- No fourth test framework was introduced. Tracks used: jest and shell smoke. pgTAP is not applicable.

# Spec 168: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-10-21
Baseline: `227436c`. Compared against: `## Backend design` in [specs/168-auth-email-hook-followups.md](../../168-auth-email-hook-followups.md).
Files read: `supabase/functions/auth-email-hook/index.ts`, `src/lib/authEmailHook.ts`, `src/lib/authEmailHook.test.ts`, `src/lib/authEmailHook.golden.test.ts`, `src/lib/authEmailHook.golden.json` (case list and outcomes), `src/lib/authEmailHook.parity.test.ts` (unchanged, used as reference), `scripts/smoke-send-email-hook.sh`, `scripts/probe-auth-email-hook.sh`, `tests/README.md`, and the `[functions.auth-email-hook]` block of `supabase/config.toml`.

Limitation: this review was done by reading files only, with no shell. I did not run `git diff 227436c`, jest, or the smokes. Byte-identity of the two core blocks is taken from a side-by-side read plus the developer's recorded parity run. Baseline equivalence is taken from the golden fixture's recorded outcomes plus reasoning about the code.

## Verdict

**No Critical findings. No Should-fix findings. 4 Minor findings.**

The implementation matches the design contract. Every signature is as designed, the placement is correct, `deliver()` keeps `buildTransportRequest` outside the network try/catch, S9 and S10 are as designed, all golden capture guards are present, and item 5 was fallback-only. The three recorded developer deviations are acceptable.

## Contract conformance checklist

| Design point | Result | Evidence |
|---|---|---|
| §1.1 `resolveRedirect(redirectTo: string, siteUrl: string): string \| null`, placed directly after `usableRedirect` | Match | `src/lib/authEmailHook.ts:195-199` |
| §1.1 `recoveryLink` reuses `resolveRedirect`; signature and `hash === ""` early return kept | Match | `authEmailHook.ts:218-224` |
| §1.1 `resolveLinkAndCode(action, leg: Leg, d: HookEmailData, supabaseUrl): LinkAndCode \| null` | Match | `authEmailHook.ts:295-309` |
| §1.2 branch order is recovery, reauthentication, notification, rest; `linkOnly` is defined once; notification is an explicit `return {link:"",code:""}`; there is no empty branch | Match | `authEmailHook.ts:296-308` |
| §1.1 `renderBody(action, newEmail, link, code): RenderedBody`, with the body moved verbatim | Match. Only `p.user.new_email` became the `newEmail` parameter | `authEmailHook.ts:311-355` |
| §1.1 `renderMail` kept as a 4-line composer; `planMails` not edited | Match | `authEmailHook.ts:357-383` |
| §1.3 action-type rationale comment and reworded D11 comment; `verifyBase` logic unchanged | Match. The wording follows the design verbatim | `authEmailHook.ts:201-215`, `:284-294` |
| §1.3 parity (b) word traps | Clean. `export` / `fetch(` / `console.` / `Deno.` / the placeholder domain appear only outside the block (header lines 17-18 and the export list) | grep of `authEmailHook.ts` |
| §1.4 exports: 4 functions plus 4 types | Match | `authEmailHook.ts:502-533` |
| §1.5 two copies byte-identical | Match on read (Deno block `index.ts:85-557`). Parity test file unmodified | `index.ts:338-557` vs `authEmailHook.ts:281-500` |
| §2.1 `classifyDelivery(attempt: TransportAttempt): DeliveryResult` in the core block, directly after `isTransportSuccess`, in both copies | Match. The throw rows return literals with no `status` key, as `toStrictEqual` requires | `authEmailHook.ts:479-499`, `index.ts:536-556` |
| §2.2 `deliver(cfg, mails, webhookId): Promise<DeliveryResult>` in `index.ts`, outside the block | Match | `index.ts:605-629` |
| §2.2 `buildTransportRequest` outside the network try/catch | Match. Line 607 runs before `try {` at 609, so a throw there propagates to the handler's outer catch (500 `internal error`, no reason), as in the baseline. The comment at 603-604 records why | `index.ts:603-618` |
| §2.2 `instanceof DOMException ? e.name : ""`, body cancel, first failure returns, `<webhook-id>:<i>` key, `AbortSignal.timeout(TRANSPORT_TIMEOUT_MS)`, constant still 2000 | Match | `index.ts:65`, `:607-626` |
| §2.2 step 9: `webhookId` read in the handler, `result.status` / `result.reason` passed to `logOutcome`; `logOutcome` drops a non-number `status` | Match. Throw paths still log no `status` key | `index.ts:584`, `:717-723` |
| §3 S10 placed after the S6 block (after the placeholder sub-arms) and before S6b | Match | `smoke-send-email-hook.sh:544-592` |
| §3 `remember` before the hook call; precondition probe; `mp_clear`; total 0; `S10_START` + `sleep 1`; 500 plus exact body; `mp_wait 0`; log poll for `status == MP_CODE`, `recipients 1`, `dropped 0` | Match, with deviations (a)-(c) below | `:558-591` |
| §3 header arm list line and S7 coverage | Match | `:22-24`; S7 reads the shared `SECRETS_FILE` |
| §4 `AC` read with the `${S9_AUTOCONFIRM_OVERRIDE-…}` default (an empty override counts as set), info line rather than a PASS, override note | Match | `:656-659` |
| §4 `email_change_round … none`: PUT label `(hash-equality round)`; hash-equality PASS/FAIL always runs; returns before redemption | Match | `:661-687` |
| §4 dispatch: `true` gives the baseline two rounds plus `sleep 2`; otherwise one `none` round plus exactly one SKIP, and no second round | Match | `:689-697` |
| §4 header Usage note for the test-only knob | Match | `:37-41` |
| §5 fallback only: import line byte-unchanged; comment replaced; no `deno.json` / `deno.lock`; no `config.toml` change | Match. `supabase/functions/auth-email-hook/` contains only `index.ts`. `[functions.auth-email-hook] verify_jwt = false` is unchanged (`config.toml:505-506`), and `config.toml` is not in the staged set | `index.ts:47-54` |
| §6 decode stays in openssl byte-unchanged; node gets the hex key on stdin; `HMAC_JS` holds no secret; `unset SECRET HOOK_SECRET` runs before node; `unset KEY_HEX` follows; node guard runs before the secret read; empty-SIG guard; `--help` range is `2,34`; no `macopt` / `hexkey` | Match | `probe-auth-email-hook.sh:43`, `:62`, `:64-65`, `:78-101` |
| §6 smoke `sign_headers` not aligned | Match (still openssl, as designed) | `smoke-send-email-hook.sh:137-142` |
| §7 tests/README Track 3 lines | Match | `tests/README.md:419-421`, `:433-434` |

## Golden capture guards (§1G)

Every guard in the design is present in `src/lib/authEmailHook.golden.test.ts`:
- **CI refusal:** `if (process.env.CI) throw` (line 211). Any non-empty value refuses, which is the conservative choice.
- **No-overwrite refusal:** `fs.existsSync(GOLDEN)` (lines 212-214).
- **Baseline-block hash refusal:** sha256 of the lines strictly between the markers, joined with `"\n"`, using the same rule as `authEmailHook.parity.test.ts:21-31`. It is compared with the hard-coded `BASELINE_227436C_BLOCK_SHA256` (lines 37 and 192-200, 215-218).
- **A capture run is never green:** after writing, the test throws `golden written — re-run …` (line 225).
- **Verify mode:**
  - a missing fixture fails with a pointer to the procedure and nothing is written (lines 229-236)
  - the fixture's `baseline` and `baselineBlockSha256` are pinned (237-238)
  - the name list must match in order (241-244)
  - for each case, `input` and `supabaseUrl` are compared exactly, `parsePayload` must be non-null, and the output is compared with `toStrictEqual` (246-256)
- **Imports:** only `parsePayload`, `planMails` and `Plan` (lines 28-29), so the test ran unchanged against the baseline.
- **Matrix location:** inside the `.test.ts` file, which keeps it out of the spec 165 lint scope.

The matrix covers groups A-I as designed (52 cases). The recorded outcomes cover both sides of each branch: `unlinkable` for C/D/E, `invalid_payload` for `B.no_new_email` and `I.recovery_blank_user_email`, and dropped counts of 1/1/2/1/1 for the placeholder cases.

One baseline-ordering question was settled by the fixture itself. The refactor tests `leg.hash === ""` *before* resolving `verifyBase` / `resolveRedirect`. If the baseline had resolved the bases first, an empty-hash, non-link-only mail with unusable bases would have been `unlinkable`. `I.zz_preflight_probe_all_empty` (empty hash, `redirect_to ''`, `site_url ''`) is recorded as `ok: true` in the baseline-captured fixture, so the baseline also checked the hash first. The refactor preserves that order.

The order of work in the implementation notes (pre-edit cleanliness check, capture, run #1 with sha `cb33ffb0…1b14`, staging before the refactor, run #2, `git diff --exit-code` clean, plus the post-refactor capture-refusal proof) matches §1G step for step.

## Developer deviations (from the implementation notes)

| # | Deviation | Ruling |
|---|---|---|
| 3(a) | S10 treats curl `000` (no HTTP response) as a separate FAIL with its own message, instead of folding it into "Mailpit now accepts" | **Accepted.** Same severity (FAIL, not SKIP) and a more accurate message. `smoke-send-email-hook.sh:565-566` |
| 3(b) | The log poll uses `jq -cR 'fromjson? \| select(…)'` instead of `jq -c` | **Accepted, and an improvement.** A non-JSON line beginning with `{` in the window can no longer abort the jq stream and produce a false `0`. The filter predicate is exactly as designed. `:582-585` |
| 3(c) | The step-2 "total is 0" assertion prints as `PASS Mailpit cleared` | **Accepted.** Label only. |
| 6 | Early `unset HOOK_SECRET` right after the copy (owner-approved optional micro-hardening) | **Accepted, as designed in §6.** The original `unset SECRET HOOK_SECRET` at line 80 stays. `probe-auth-email-hook.sh:64-65` |
| 6 | New `[[ -n "$SIG" ]] \|\| die "could not compute the signature"` refusal | **Accepted, as designed.** It is a new exit-2 path that cannot fire in normal use, and it is better than sending `v1,` unsigned. |

None of these changes the HTTP contract, the rendered output, the transport request, or the log line. They stay inside the spec's behaviour boundary.

## Findings

### Critical
None.

### Should-fix
None.

### Minor

**m1. S10 precondition does not guard an empty `EDGE_FROM`** (`scripts/smoke-send-email-hook.sh:561-570`).
- If `docker exec … printenv SEND_EMAIL_FROM` returns empty (env not visible, or the container was renamed), Mailpit would answer 400 for the invalid **From**, and the precondition would print `PASS … rejects 'not-an-address' → HTTP 400` for the wrong reason.
- There is no false pass of the arm overall. The hook sends its own valid From, so if Mailpit accepted `not-an-address` the hook would return 200 and the 500 and log-status assertions would FAIL.
- Only the precondition's diagnostic would mislead. Optional fix: `[[ -n "$EDGE_FROM" ]] || fail "precondition: could not read SEND_EMAIL_FROM from ${EDGE_CONTAINER}"` before the probe.

**m2. Probe: two children still inherit an exported `HOOK_SECRET`** (`scripts/probe-auth-email-hook.sh:56`). This is pre-existing and not a regression.
- The `TO_NORM` pipeline (`tr`, `sed`) runs before the early `unset HOOK_SECRET` at line 65. In the env-path run, those two short-lived children inherit `HOOK_SECRET` in their **environment**, not argv.
- This predates spec 168, and the spec criterion is "does not *newly* place key material in a child environment". It is therefore not a violation. The argv exposure that L1 targeted is fully closed.
- Optional follow-up for the owner: move `SECRET="${HOOK_SECRET:-}"; unset HOOK_SECRET` to before argument parsing, so no child ever inherits it.
- I would not expand spec 168's scope for this. Surface it as a question only.

**m3. Golden matrix: the "rest" branch with an app-shaped `site_url` is exercised only for `magiclink` / `signup`** (`src/lib/authEmailHook.golden.test.ts:158-161`).
- In prod the live D11 branch is the SUPABASE_URL fallback (app-shaped `site_url`). Groups A, B and G default to the API-shaped `site_url`, so `email`, `invite`, `email_change` and `zz_future_type` are byte-locked only on the defensive branch.
- The risk is low: `resolveLinkAndCode` takes the same code path for every non-special action, `verifyBase` is untouched, and F covers both branches for one link-only and one link-plus-code type.
- This meets and exceeds the spec minimum. No action is needed for this spec. A future edit to the "rest" branch could add an app-shaped `email_change` case, but only with a fresh baseline capture, since the fixture is baseline-locked.

**m4. `BASELINE_227436C_BLOCK_SHA256` is self-attested** (`src/lib/authEmailHook.golden.test.ts:37`).
- Verify mode checks that the fixture's recorded hash equals the in-file constant. Both were produced by the same developer run, so CI cannot independently prove the constant is the real `227436c` block hash.
- The order-of-work record (pre-edit `git diff --quiet` clean, fixture staged before the refactor) makes tampering implausible.
- Optionally, before commit, the release coordinator or owner can recompute it once: `git show 227436c:src/lib/authEmailHook.ts`, extract the block, sha256. It should equal `8a27aa0f7612d4191a4aa1da457d998fbf6e0e5e59860c87ce7cf4e6c8e414ec`.
- I could not run this check myself (no shell in this review).

## Residual risks (unchanged from design §8, restated for the release-coordinator)
- `deliver()` and the rest of the handler outside the block are not type-checked anywhere (no local deno; `tsconfig` excludes `supabase/functions`). They are proven only by the smoke (S2/S6 sent, S10 non-2xx, S7 key set) and by this review.
- The timeout branch of `deliver()` has no live proof. `classifyDelivery` covers the mapping, and review covers the `instanceof DOMException → name` conversion, which is unchanged from the baseline.
- Item 5: esm.sh remains a deploy-time network dependency with no integrity lock (spec 166 risk 9). This is unchanged.
- No prod deploy in this spec. The refactored function and node-based probe reach prod only at the owner's spec 166 runbook steps 4/5/5b.
- No migration, RLS, realtime publication, `src/lib/db.ts` or `useStore.ts` impact. Nothing bypasses `db.ts`: the changes are confined to an edge function, its jest-only canonical, tests and shell scripts.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 4 Minor findings (m1 S10 precondition empty-From guard; m2 pre-existing HOOK_SECRET env inheritance by the TO_NORM children; m3 golden app-shaped-site coverage for the rest-branch types; m4 baseline block hash is self-attested, optional one-time recompute).
payload_paths:
  - specs/168-auth-email-hook-followups/reviews/backend-architect.md

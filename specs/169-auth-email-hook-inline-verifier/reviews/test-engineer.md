## Test report for spec 169

Reviewer: test-engineer, 2026-10-22. Baseline 3508960. Spec 167 paths and untracked specs/170-* ignored. No source, test or script was edited. Smokes and the probe ran strictly one at a time; no 429s.

### Acceptance criteria status

**1. Placement and dependency removal**
- AC1.1 index.ts has no `import`, `https://` module specifier, `npm:` or `jsr:`; `standardwebhooks` only in comments → PASS. `src/lib/authEmailHook.verify.test.ts::S1`. Manual grep: the only hits are comment lines (19, 51, 466). The `https://api.resend.com/emails` constant at line 115 is a runtime string, not a module specifier.
- AC1.2 Verifier lives inside the core block and the block is byte-identical in both files → PASS. Block extracted from both files hashes identically (sha1 4a2487c2…); verifyWebhook, signWebhook, timingSafeEqualString and base64ToBytes are inside the markers.
- AC1.3 `authEmailHook.parity.test.ts` passes unmodified (all 4 cases) → PASS. `git diff HEAD` is empty for it, and it is green in the full run.
- AC1.4 Verifier takes an injected clock → PASS. Signature `verifyWebhook(secrets: readonly string[], body, headers, nowSeconds)`. `src/lib/authEmailHook.verify.test.ts::S2` (no `Date.now`, `new Date(`, `subtle.verify` or `require(` in the block), plus V3.1/V3.2 using the injected clock.
- AC1.5 New symbols exported from the canonical file → PASS. `base64ToBytes`, `timingSafeEqualString`, `signWebhook`, `verifyWebhook` and type `WebhookHeaders` are imported by the verify test.
- AC1.6 `verifySignature` wrapper removed and step 4 awaits and keeps the log and 401 → PASS. `S1` asserts no `verifySignature` or `new Webhook(`. I read step 4 (index.ts:767-776): it awaits `verifyWebhook`, logs `reason:"signature"` and returns 401 `{"error":"invalid signature"}` with no detail. Smoke S5 confirms live.
- AC1.7 A verifier exception becomes a verify failure, never a 500 or 200 → PASS. `V6.4` (throwing secret skipped, none rejects), `V6.5` (fail-open guard: throwing secret vs `v1,` entry → false), `V3.7`, `V5.3`. Every assertion uses `.resolves.toBe`. Source review: `null` sentinel for `expected`, per-secret try/catch, outer try/catch.

**2. Parity with standardwebhooks@1.0.0**
- AC2.1 Key decoding (same bytes as `@stablelib/base64`) → PASS. `V2.1` (3000 random members of S incl. non-canonical tails vs `Buffer`), `V2.2` (3000 random strings: `parseHookSecrets` accepts iff `base64ToBytes` doesn't throw), `V2.3`, `V2.4`, `V1.4`. The Deno half is proven live for D7 by the GoTrue-signed smoke arms.
- AC2.2 Signed content and base64 HMAC → PASS. `V1.1`, `V1.2`, `V1.5` against a `node:crypto` `createHmac` oracle and the fixed vectors.
- AC2.3 Signature header: space-separated list, non-v1 skipped, any v1 match, constant-time compare → PASS. `V5.1`-`V5.8` (including the non-canonical alias rejection) and `V9` (`timingSafeEqualString`, which compares UTF-8 bytes). `crypto.subtle.verify` is deliberately not used (S2 bans it).
- AC2.4 Required headers missing or empty are rejected; names case-insensitive → PASS. `V4.1`, `V4.2`, `V4.3`.
- AC2.5 Timestamp: non-numeric rejected; exactly ±300 accepted; ±301 rejected → PASS. `V3.1`-`V3.7`.
- AC2.6 Rotation, every secret in order → PASS. `V6.1`-`V6.4`.
- AC2.7 Library semantics pinned: `parseInt` leniency (replicated, V3.4/V3.5/V3.6), signed non-JSON gives 401 (V8.1-V8.3; wrong-shape JSON still passes the gate, V8.2), malformed entries (V5.3), duplicate headers (V4.4, V5.7) → PASS.

**3. Unchanged HTTP contract and golden**
- AC3.1 Golden fixture byte-unchanged → PASS. `git diff HEAD` is empty, sha256 is `cb33ffb0412ac48b3633b40eb212ecf53b76eb2da20764a597e7a06ffaee1b14`, and `authEmailHook.golden.test.ts` is green and unmodified.
- AC3.2 Existing `authEmailHook.test.ts` cases unchanged → PASS. The file is untouched and green (`npx jest src/lib/authEmailHook --verbose`: 4 suites, 187 tests, 0 failed).
- AC3.3 Handler steps 1-3 and 5-10, `deliver()` and the constants byte-unchanged → PASS. Live: `smoke-send-email-hook.sh` ALL ARMS PASSED. Note: I did not re-do the hunk-by-hunk `git diff HEAD` read; I confirmed step 4 and the header and relied on the smoke plus golden for the rest.
- AC3.4 `supabase/config.toml` unchanged → PASS. `git diff HEAD` is empty.

**4. Tests (jest, unit project)**
- AC4.1 Fixed vectors (D7 key, `msg_vector`, 1700000000, both bodies) → PASS. `V1.1`, `V1.2`, `V1.3`.
- AC4.2 Edge cases → PASS. Each listed case maps to V3.x-V8.x above. Wrong key is V6.3, stale and future are V3.1/V3.2, non-numeric is V3.3/V3.6, each missing header is V4.1, multi-signature is V5.1, non-v1 is V5.2, rotation is V6.1/V6.2, tampered body, id and timestamp are V7.1-V7.3, malformed entries are V5.3, signed non-JSON is V8.1.
- AC4.3 Runs in the `unit` project on Node with no mock of `crypto.subtle` → PASS locally (Node 24). `V0` asserts `crypto.subtle`, `atob`, `btoa` and `TextEncoder` are reachable without mocks. CI Node 20 is covered only by the CI run (see Notes).

**5. Smoke and probe**
- AC5.1 `smoke-send-email-hook.sh` unmodified; all S5, signed and GoTrue-driven arms pass → PASS. Output: ALL ARMS PASSED, 72 PASS, 0 FAIL, only SKIP is S8. S5 arms: unsigned 401, wrong signature 401, now−600 s 401, signed `{}` 400, signed empty 400, Mailpit total 0. S9 precondition `GOTRUE_MAILER_AUTOCONFIRM='true'`.
- AC5.2 Probe unmodified and working → PASS. The env path (D7 secret read from the container) gave HTTP 200 `{}`, exit 0, and Mailpit holds exactly 1 "Account notification" for zz_probe169@local.test. The random `v1,whsec_<openssl rand -base64 32>` gave 401 `invalid signature` with the "HOOK_SECRET differs" hint, exit 1.
- AC5.3 Edge runtime serves the staged file; unsigned POST gives 401 → PASS. The bind-mount points at the repo root. The container copy of `index.ts` contains `verifyWebhook` and has no `import`. The worktree equals the index for that file. An unsigned POST gave 401 `{"error":"invalid signature"}`. The recent edge-runtime logs show no module-resolution or esm.sh error.

**6. Docs**
- AC6.1 AUTH POSTURE paragraph updated → PASS (read index.ts:11-21).
- AC6.2 Import comment block replaced by a short note → PASS (index.ts:51).
- AC6.3 Step 4 comment accurate → PASS (index.ts:767-770).
- AC6.4 Canonical header mentions signature verification → PASS (the developer notes report it; the export and structure are visible; I did not diff the header text line by line).
- AC6.5 `tests/README.md` unchanged → PASS (`git diff HEAD` is empty).
- AC6.6 CLAUDE.md not edited → PASS (`git diff HEAD` is empty).

**Done criteria**
- Full `npx jest` green → PASS.
- `npm run typecheck` and `npm run typecheck:test` clean → PASS.
- `smoke-send-email-hook.sh` ALL ARMS PASSED → PASS.
- `npm run test:smoke` green → PASS.
- Sequential Mailpit runs → PASS (this session).
- Process items (owner plan approval, staging only spec 169 paths, no commit) → not a test concern. Staged spec 169 paths observed: the spec, `authEmailHook.ts`, `authEmailHook.verify.test.ts`, `index.ts`.

Totals: 29 PASS, 0 FAIL, 0 NOT TESTED.

### Test run
- `npx jest`: 234 suites passed, 2846 tests passed, 2 snapshots passed (about 7 s).
- `npx jest src/lib/authEmailHook --verbose`: 4 suites (verify, test, golden, parity), 187 tests passed.
- `npm run typecheck`: no errors. `npm run typecheck:test`: no errors.
- Unsigned curl POST to http://127.0.0.1:54321/functions/v1/auth-email-hook: 401 `{"error":"invalid signature"}`.
- `bash scripts/smoke-send-email-hook.sh`: exit 0, ALL ARMS PASSED, 72 PASS, 0 FAIL, SKIP S8 only.
- `npm run test:smoke`: exit 0; every script reports ALL ARMS PASSED or all checks passed. The SKIPs are environmental and unrelated to this spec: no BOBBY_TOKEN (two checks), local USERNAME_RESOLVE_SERVICE_TOKEN unset/mismatched (HTTP 500), and S8.
- Probe, env secret: HTTP 200 `{}`, exit 0, 1 mail in Mailpit. Probe, random well-formed secret: HTTP 401, exit 1, mismatch hint.

### Notes
- Source review of `verifyWebhook` against design §3: D1 clock guard first, header lowercasing into a Map, required-header check, `parseInt` NaN check, ±300 bounds, v1 candidate collection, per-secret try/catch with a `null` sentinel (not `""`), `JSON.parse` only after a match, outer try/catch. The code follows the design line for line. No laxer-than-library behavior found.
- Node 20 (the CI version) is not available locally. V0/V1 on Node 20 get their first proof on CI `test.yml`. Local proof is Node 24. After the owner pushes, `test.yml` and `db-migrations-applied.yml` on `main` need the usual check.
- The D7 key is the only key proven in the Deno runtime (via GoTrue-signed smoke arms); other keys are proven only in Node by V1.4, V1.5 and V2.x. That matches the design's stated risk 5.
- Prod acceptance (spec 166 runbook steps 4/5b/5) is out of scope; no deploy happened.
- No framework gaps; no new test framework introduced.

## Security audit for spec 169

Scope: staged diff against baseline `3508960` for `src/lib/authEmailHook.ts`, `supabase/functions/auth-email-hook/index.ts` and `src/lib/authEmailHook.verify.test.ts`. Spec 167 paths and the untracked `specs/170-*` were not reviewed. The parity reference was `standardwebhooks@1.0.0` `dist/index.js`, `dist/timing_safe_equal.js` and `@stablelib/base64@1.0.1` `lib/base64.js`, read from the scratchpad copies. I read them but did not run them.

Verdict: **no Critical, no High.** I found no input on which the inline verifier accepts a request that the library-plus-old-wrapper would reject.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `src/lib/authEmailHook.verify.test.ts:411-425` — The S1 static guard is the regression lock on the supply-chain property ("no third-party import"), but it does not catch a module-level `export { x } from "https://…"` / `export * from "npm:…"` re-export, or a dynamic `import (` with whitespace before the parenthesis. Either one would pull a remote module back into the `verify_jwt = false` function and still pass S1. The `npm:` check (`/['"]npm:/`) and the `jsr:` check cover those schemes in any position, but an `https://` re-export is only caught if the line also contains `esm.sh` or `standardwebhooks`. **Impact:** a future edit could reintroduce a remote dependency on the only gate without failing CI. This is a hardening gap only; today's code has no such line. **Fix (optional, follow-up):** also assert `!/^\s*export\b[^;]*\bfrom\s*['"]/m.test(src)`, `!/\bimport\s*\(/.test(src)` and `!/['"]https?:\/\//.test(src)` in a module-specifier position, or more simply assert that no line matches `/\bfrom\s*['"]/`.

### Checklist results (each verified, with evidence)

| Check | Result | Evidence |
|---|---|---|
| `expected` can never be `""` or match a bare `v1,` | PASS | `authEmailHook.ts:506-515`: `expected` starts as `null`, is set to `null` again in the catch, and the loop `continue`s on `null`. On success, `expected` is `btoa` of a 32-byte MAC, which is always 44 characters. A `v1,` / `v1` entry becomes candidate `""` (`:504`), and the length check in `timingSafeEqualString` rejects it. Jest V6.5 pins `['!!!!']` with `v1,` and `['', '!!!!']` with `v1, v1,`, both false. |
| Constant-time compare with any-match over v1 entries | PASS | `authEmailHook.ts:444-452`: UTF-8 bytes; length mismatch returns early (length is public, same as `tse:10-12`); XOR-OR over the full length otherwise. `:516-525` returns on the first matching candidate under any secret, the same as `swh:63-70` plus the wrapper. Non-`v1` versions are skipped exactly (`parts[0] !== "v1"`, case-sensitive, so `V1`, `v1a` and `v2` are skipped), matching `swh:65`. |
| ±300 s bounds, inclusive like the library | PASS | `:498-499` uses `nowSeconds - ts > 300` and `ts > nowSeconds + 300`, the same expressions as `swh:95,98`. Jest V3.1/V3.2 assert both sides of both bounds. |
| `parseInt` semantics; signed content uses the parsed integer | PASS | `:496-497` uses `parseInt(msgTs, 10)` + NaN check, like `swh:91-93`. `signWebhook` signs `msgId + "." + timestamp + "." + body` with the numeric `ts` (`:465`). The library builds `${Math.floor(new Date(ts*1000).getTime()/1000)}` (`swh:84-85,101`). For every in-window `ts` these are the same text, including `-0`, which becomes `"0"` in both. V3.4/V3.5 pin it: lenient headers verify only against the canonical integer, never the raw text. `Infinity` and huge values fall outside the window (V3.6). |
| Clock guard | PASS (stricter) | `:483` refuses a non-safe-integer clock or one with `|now| > 8.64e12 − 300`. That closes the NaN-clock fail-open (with `now = NaN`, both bound checks are false). The handler passes `Math.floor(Date.now() / 1000)` (`index.ts:773`), the same as `swh:90`. The block contains no `Date.now` or `new Date(` (S2). |
| Rotation across secrets | PASS | `:506-526` tries every secret in order; a throwing secret is skipped (`:509-513`), the same as the old `verifySignature` loop. Jest V6.1, V6.2 and V6.4 pin this. |
| Signed non-JSON body → 401 | PASS | `:517-522`: on a match, `JSON.parse(body)` and `false` on throw. This is equivalent to library-plus-wrapper, because JSON validity doesn't depend on the secret. V8.1/V8.3 return false, so the handler answers 401. V8.2 checks that `{}`, `null`, `[]` and `1` pass the gate, so step 5 still answers 400 (smoke S5 unchanged). |
| Missing or empty headers → 401 | PASS | `:489-495`: the value must be a string and non-empty. This is a superset of the library's falsy test (`swh:55`). Names are lowercased last-wins into a `Map` (`:484-485`), like `swh:48-51`, and are immune to `__proto__`. V4.1-V4.3 pin it. |
| Any throw → false, never 500 or accept | PASS | The whole body is in `try { … } catch { return false; }` (`:482,527-529`), and the only `await` is inside the per-secret try. The function cannot reject, so the handler's outer catch (500) can't be reached from step 4. Every jest case uses `.resolves.toBe(...)`. If `crypto` were somehow missing at runtime, the ReferenceError would be caught per secret, giving 401 for every request (fail-closed). |
| Key-decode equivalence with `@stablelib/base64` | PASS | `base64ToBytes` (`:427-433`) accepts exactly S (`^[A-Za-z0-9+/]+={0,2}$`, length % 4 === 0). That equals the `parseHookSecrets` accepted set (`index.ts:449-463`: the regex, % 4 and `atob` success together rule out a misplaced `=`), and S is a subset of stablelib's accepted set (`b64:117,198`). I checked 20,000 random members of S, including non-canonical trailing bits, against a line-by-line transcription of `b64:76-121,166-203`: **0 byte differences**. Jest V2.1-V2.3 independently check against `Buffer`. |
| No secret, key or signature in any log line | PASS | The verifier has no logging and returns only a boolean. The step-4 log is `logOutcome({…, reason: "signature"})`, which contains only enums and counts (`index.ts:681-703`). The 401 body is the fixed `{"error":"invalid signature"}`. No `e.message` is returned anywhere. |
| Gate order unchanged | PASS | `index.ts:740-781`: method (405) → `parseHookSecrets` (500) → Content-Length and post-read size checks (413) → `verifyWebhook` (401) → `parsePayload` (400). Steps 1-3 and 5-10 are byte-unchanged in the diff. |
| Dependency removal | PASS | `index.ts` has no `import`, `https://`, `npm:` or `jsr:` module specifier. `standardwebhooks` and `esm.sh` appear only in comments (lines 19, 51, 466). The function now bundles only repo code plus runtime WebCrypto, which closes spec 168 L2. |
| Block parity | PASS | The marker ranges of the two files are byte-identical (`diff` of the extracted blocks is empty). `npx jest src/lib/authEmailHook`: 4 suites, 187 tests green. |
| No global shadowing | PASS | Neither file declares or imports `crypto`, `atob`, `btoa` or `TextEncoder`. The canonical file imports only `placeholderEmail` and `escapeHtml`. |
| `verify_jwt` pin | PASS | `supabase/config.toml:505-506` `[functions.auth-email-hook] verify_jwt = false`; no diff on `config.toml`. |

### Differential fuzz (my own probe, scratchpad only, no repo files)
I extracted the verifier lines from the staged `src/lib/authEmailHook.ts` (lines 418-531) and ran them under Node 24.14.1 (`--experimental-strip-types`). I compared them against a hand transcription of `swh:24-102` + `tse:9-28` + `b64:76-121,166-203`, with `node:crypto` HMAC standing in for `fast-sha256`, wrapped in the old per-secret try/catch loop. The adversarial generators covered:
- signature headers: `v1`/`v2`/`v1a`/`V1`/bare/empty/`v1,` entries, non-canonical aliases, truncated or over-padded signatures, case-flipped signatures, extra commas, and single, double and `", "` separators
- timestamp headers: lenient `parseInt` forms (`abc` suffix, leading space, tab, NBSP, `+`, leading `0`, `.9`, `-0`, `0x10`, `1e9`, `Infinity`, comma-joined duplicates) and the exact ±300/±301 boundaries
- ids containing `,`, spaces, `é` and comma-joined duplicates
- JSON and non-JSON bodies
- missing headers, `undefined` header values and mixed-case header names
- secret lists including `[]`, `[""]`, `["!!!!", D7]`, `["AAAA"]` and an odd-padding secret

Results:
- 40,000 adversarial cases + 200,000 mixed cases + 200,000 accept-dense cases (25,539 accepts): **0 mismatches**. Zero cases where the inline verifier accepted and the library model rejected, and none the other way.
- 20,000 key-decode cases: 0 byte differences against the stablelib transcription.

### Notes (not findings)
- Deno-side decode parity for the **prod** secret is shown only by the argument that Deno's `atob` follows the spec, plus the live GoTrue-signed smoke arms for the D7 key. A mismatch would fail closed (every hook call 401, no auth mail), not open. The owner's spec 166 runbook step 5b probe is the first prod proof, as the spec already records.
- Replay inside the ±300 s window is unchanged from the library and is out of scope (spec 169 Out of scope; spec 166 D13 idempotency).
- Timing: the per-candidate compare is constant-time. The number of secrets and candidates, and whether an earlier secret matched, are observable, the same as the library. That doesn't help a forger.

### Dependencies
No `package.json` / `package-lock.json` changes (`git diff HEAD` is empty for both), so I skipped `npm audit`. The edge function's only third-party dependency (esm.sh `standardwebhooks@1.0.0` with `@stablelib/base64@1.0.1` and `fast-sha256@1.3.0`) is removed.

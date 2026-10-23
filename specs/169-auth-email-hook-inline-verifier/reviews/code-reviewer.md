## Code review for spec 169

Scope: `src/lib/authEmailHook.ts` (core block verifier group, header, exports), `supabase/functions/auth-email-hook/index.ts` (header, import note, step 4, spliced block), `src/lib/authEmailHook.verify.test.ts`, and the spec. Spec 167 paths and the untracked `specs/170-*` were ignored.

Overall: the implementation follows the design closely and I found no correctness or policy defects. The block matches the §3 pseudocode, the `null` sentinel is in place with a comment, every `await` sits inside a `try`, the clock is injected, the block contains none of the banned tokens, and the handler change is confined to step 4. The `index.ts` header and import note are accurate. The block comments avoid the parity word traps. The findings are all about explaining the deliberate library-mirroring quirks at the point they happen, plus a few readability items. Architecture and security are deferred to the other reviewers.

### Critical
None.

### Should-fix

- `src/lib/authEmailHook.ts:496` (identical at `supabase/functions/auth-email-hook/index.ts:547`) — `const ts = parseInt(msgTs, 10);` has no comment at the site. A reader sees lenient parsing on a security gate and will want to "fix" it to `Number()` or `^\d+$`. That would be a fail-closed-looking change that breaks library parity. Add a why-comment, which must avoid the word traps, for example: `// parseInt on purpose (library parity): "1700000000abc" parses to 1700000000, and the signed text below uses this parsed integer, never the raw header.` The rationale currently lives only in the spec (§2.2), not where the code is.

- `src/lib/authEmailHook.ts:500-505` (`index.ts:551-556`) — the lax comma handling gives no hint of intent. Two lines are unexplained:
  - `parts[0] !== "v1"` and `parts[1]` deliberately ignore any further comma fields (`v1,<sig>,extra` still matches).
  - Pushing `""` for a comma-less entry looks pointless, because an empty candidate can never equal a 44-character MAC.

  Both are library mirroring (design L7/L9), and the lax shape also tolerates GoTrue's `v1,a, v1,b` join. Add a short comment: `// Lax like the library: only parts[0] and parts[1] count; a comma-less "v1" is an empty (never matching) candidate.` Without it, the next reader either tightens it, which risks breaking multi-secret GoTrue mail, or deletes the `""` branch.

- `src/lib/authEmailHook.ts:517-522` (`index.ts:568-573`) — the "non-JSON → 401" rule is explained only in the function's doc comment, and the code at the site looks like dead code: a `JSON.parse` whose result is discarded, inside a try that returns `false`. Add an inline why-comment, for example: `// The library JSON-parses the payload after a match, so a signed non-JSON body is a verify failure (401), not a 400 from step 5. Result discarded on purpose.` Also note why this is correct inside the loop. Parseability does not depend on the secret, so returning `false` at the first match instead of trying the next secret is equivalent (design §2.1).

- `src/lib/authEmailHook.ts:469-474` (`index.ts:520-525`) — the `verifyWebhook` doc comment is a single run-on sentence of about six conjoined conditions, and it is the only place the quirks are described. Split it into a short summary plus a bullet list of the replicated library behaviours, with the three quirks above (parseInt, lax commas, non-JSON → 401) called out by name. This is also where to say that any divergence from the library must be fail-closed.

- `src/lib/authEmailHook.ts:483` (`index.ts:534`) — the magic number `8.64e12` is unexplained, and the comment ("would open both bounds") doesn't say where the number comes from. It is the maximum JS `Date` range in seconds (8.64e15 ms), which the design uses to prove the signed text equals the library's. Name it (for example `MAX_DATE_SECONDS`) next to `WEBHOOK_TOLERANCE_SECONDS`, and say in one phrase that it keeps every accepted `ts` inside the `Date` range. The line is also about 125 columns; naming the constant fixes that.

### Nits

- `src/lib/authEmailHook.verify.test.ts:130` — the `bodyChars` array contains literal invisible characters (the last two entries render as plain spaces, but the grep for U+00A0/U+2028/U+2029/U+3000/U+2003 hits this line). Use escapes (`' '`, `' '`, …) so the intent is visible and an editor "trim whitespace" pass can't change the test.

- `src/lib/authEmailHook.verify.test.ts:76,134` — `ALPHABET.split('')` and `idChars.split('')` run inside the per-character loops (about 260k splits in V2.1 alone). Hoist `const ALPHABET_CHARS = ALPHABET.split('')` and the id equivalent. It is harmless but sloppy in a file that is otherwise tidy.

- `src/lib/authEmailHook.verify.test.ts:140,153,177` — the `expect({ ..., got }).toEqual({ ..., got: want })` idiom (put the inputs in both sides so a failure prints the failing case) is clever but not self-evident. Add a one-line comment above the first use (V1.5) saying why the inputs are in both objects. The design explains it, the file does not.

- `src/lib/authEmailHook.verify.test.ts:237` — the title refers to "D1" and the file uses the V1…V9 / S1-S2 IDs throughout. These IDs only resolve in spec 169 §7 and §2.6. The header cites §7, which is enough for V/S, but D1 is a different section. Either cite "§2.6" in the V3.7 title or describe the guard in words.

- `src/lib/authEmailHook.verify.test.ts` (V4.3 / V4.4) — no case sends two keys that differ only in case (`Webhook-Id` and `webhook-id`). The `Map` is last-wins, which the library's object copy also is. This is a harmless gap, so a one-line pin would document the behaviour; it is optional.

- `src/lib/authEmailHook.ts:414-418` (`index.ts:465-469`) — the "Standard Webhooks verification (spec 169)" comment sits directly above `const WEBHOOK_TOLERANCE_SECONDS`, so it reads as that constant's doc comment rather than a section header for the whole verifier group. A divider-style first line (or moving the constant under the comment) would make the grouping clearer.

- `src/lib/authEmailHook.ts:457` — `signWebhook` returns only the bare base64 MAC (no `v1,` prefix, no header), and it is also the exported test surface. A name like `computeWebhookSignature` would match what it does. The existing doc comment states the contract, so this is a preference only.

- `src/lib/authEmailHook.ts:484` — the local `h` (lowercased header map) and the loop variable `c` (line 515) are terse in a security-sensitive function. `lowered` and `candidate` would read better. `x` and `y` in `timingSafeEqualString` are fine at that size.

- `src/lib/authEmailHook.ts:500-514` — when `candidates` is empty (no `v1` entry), the loop still does an `importKey` plus `sign` per secret before returning `false`. An early `if (candidates.length === 0) return false;` would be clearer and cheaper. It is not a correctness issue, and the library does the HMAC first too.

- `supabase/functions/auth-email-hook/index.ts:768` — the step 4 comment says "±5 min tolerance" while the header (line 18) and the block say "±300 s". Pick one unit so the three places agree.

- (out-of-scope) The `index.ts` header paragraph (lines 11-21) now carries the verifier description that also lives in the canonical header and the block comment. Three places describe the same thing, so future drift is possible. Left as designed (the spec asked for each).

### Convention checklist (no findings)
- No `import`, `https://`, `npm:` or `jsr:` specifier in `index.ts`. The `standardwebhooks` and esm.sh mentions are all `//` comment lines (19, 51, 466).
- The `verifySignature` wrapper is removed. Step 4 awaits `verifyWebhook` and keeps `logOutcome(... reason: "signature")` and `jsonResponse(401, { error: "invalid signature" })` with no error detail.
- No `Date.now`, `new Date(`, `subtle.verify` or `require(` in the block, and the clock is a parameter. The handler passes `Math.floor(Date.now() / 1000)`.
- `bytesToBase64` and `WEBHOOK_TOLERANCE_SECONDS` stay unexported, as designed. `WebhookHeaders` is in `export type`.
- The test file sits in the jest unit project (`src/lib/*.test.ts`) and uses an independent `node:crypto` oracle plus the fixed literals. No `crypto.subtle` mock. `authEmailHook.test.ts`, the golden test and the parity test are untouched.
- No edit to `supabase/config.toml`, the `app.json` slug, or any legacy deleted file. No direct Supabase calls (the function has no DB access).

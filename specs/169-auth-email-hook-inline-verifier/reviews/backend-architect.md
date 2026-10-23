# Spec 169: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-10-22.
Spec status on entry: `READY_FOR_REVIEW` (not changed by this review).
Baseline: `3508960` (spec 168), confirmed as HEAD in the session git snapshot.
Design reference: the `## Backend design` section of the spec, §0-§10.

Files reviewed (all staged, nothing unstaged):
- `src/lib/authEmailHook.ts`
- `supabase/functions/auth-email-hook/index.ts`
- `src/lib/authEmailHook.verify.test.ts` (new)
- `src/lib/authEmailHook.parity.test.ts` (read only, to confirm the (b) word-trap rules)

The staged set for spec 169 is exactly the four paths in design §8 step 14: the spec, `authEmailHook.ts`, `authEmailHook.verify.test.ts` and `index.ts`. No spec 167 path is in the spec 169 diff.

## Verdict

**No drift from the design. 0 Critical, 1 Should-fix (a verification gate, not a code change), 4 Minor.**

## Design conformance checklist

| Check | Result | Evidence |
|---|---|---|
| Signatures (§3) | Match | `base64ToBytes(b64: string): Uint8Array<ArrayBuffer>` at authEmailHook.ts:427. `bytesToBase64` at :436. `timingSafeEqualString(a, b): boolean` at :444. `signWebhook(secret, msgId, timestamp: number, body): Promise<string>` at :457. `verifyWebhook(secrets: readonly string[], body, headers: WebhookHeaders, nowSeconds: number): Promise<boolean>` at :475-480. `WebhookHeaders = Record<string, string \| undefined>` at :421. `WEBHOOK_TOLERANCE_SECONDS = 5 * 60` at :418. |
| Placement | Match | After `parseHookSecrets` (ends :412) and before `isLocalDevSecret` (:533). The BEGIN/END marker text is unchanged. |
| Export list (§5) | Match | `export type` adds `WebhookHeaders` (:635). `export { … }` adds `base64ToBytes`, `timingSafeEqualString`, `signWebhook` and `verifyWebhook` (:656-659). `bytesToBase64` and `WEBHOOK_TOLERANCE_SECONDS` are not exported. |
| Order: D1 clock guard first | Match | :483 is the first statement inside the outer `try`. The bound is `8.64e12 - WEBHOOK_TOLERANCE_SECONDS` and the check is `Number.isSafeInteger`. |
| Headers lowercased into a `Map` (L1, D4) | Match | :484-485 |
| Required-header check (L2, D2) | Match | :489-495 (`typeof … !== "string" \|\| … === ""` for all three). |
| `parseInt(…, 10)`, NaN check, inclusive ±300 (L3/L4) | Match | :496-499. The comparisons are `nowSeconds - ts > TOL` and `ts > nowSeconds + TOL`, so exactly ±300 passes. |
| Candidates: `split(" ")`, `parts[0] === "v1"`, lax `parts[1]`, `""` when there is no comma (L7/L9) | Match | :500-505 |
| `expected` uses the `null` sentinel (hard rule 1) | Match | :508 `let expected: string \| null = null`; the catch sets `null` (:512); `continue` on `null` (:514). It is never initialised to `""`. |
| Per-secret try/catch plus outer try/catch (hard rule 2) | Match | Per-secret at :509-513 and outer at :481/:527-529. The only `await` (:510) is inside both. `verifyWebhook` cannot reject. |
| `JSON.parse` only after a match (L10, §2.1) | Match | :516-523. It runs only inside the `timingSafeEqualString` true branch and returns `false` on a throw, without trying further secrets. That is equivalent to the library plus the wrapper, as shown in §2.1. |
| Typed-array views only to `crypto.subtle` (hard rule 3) | Match | `importKey` gets `base64ToBytes(secret)` (a `Uint8Array`, :460). `sign` gets `TextEncoder.encode(…)` (:465). The returned `ArrayBuffer` is only wrapped with `new Uint8Array(mac)`, which is realm-safe. |
| Signed content (L5) | Match | `msgId + "." + timestamp + "." + body` at :465, where `timestamp` is the parsed integer, so it is the canonical decimal. Under D1 it never has an exponent (§2.2 proof). |
| No clock, `subtle.verify`, `require` or import statement in the block (hard rule 4) | Match | Visual inspection; static test S2 enforces this. |
| Verifier returns only a boolean (hard rule 5) | Match | |
| Parity (b) word traps | Clean | The new comments contain no `export` token (the design's "(unexported helper)" was dropped from the `bytesToBase64` comment), no `fetch(`, no `console.`, no `Deno.` and no placeholder literal. |
| Block byte-identical in both files | Match | I read both blocks in full: canonical :33-621 and Deno :84-672. The parity suite (a) is the authority and is reported green. |
| D1-D4 implemented as designed | Yes | D1 :483. D2 :489-495. D3 :428. D4 :484-485. |
| Handler: esm.sh import removed | Yes | index.ts:51-52 is the two-line spec 169 note from §5, verbatim. There is no `import` line anywhere in the file. `standardwebhooks` / `esm.sh` appear only in `//` comments (lines 19, 51 and 466). |
| Handler: `verifySignature` removed | Yes | Absent from the file; S1 asserts it. |
| Handler step 4 (§5) | Match | index.ts:767-776 matches the §5 snippet verbatim: the comment, `Object.fromEntries(req.headers)`, `Math.floor(Date.now() / 1000)`, `await verifyWebhook(secrets, body, headers, nowSeconds)`, and the unchanged `logOutcome(… reason: "signature")` and `jsonResponse(401, { error: "invalid signature" })`. |
| Gate order: method, secret, size, signature, payload | Unchanged | Steps 1-3 (:740-765) and step 5 (:778-789) are in the original order. |
| AUTH POSTURE paragraph (§5) | Match | index.ts:11-21 is the §5 text verbatim. |
| Canonical header (§5) | Match | authEmailHook.ts:8-9 (the spec 169 list item) and :22-24 (the runtime globals and the "never import node's `crypto`" warning). |
| `deliver()`, `logOutcome`, `jsonResponse`, constants, env reads | Unchanged by inspection | index.ts:54-63 and :675-733 match the spec 168 shapes. See M4 on how I verified this. |
| `config.toml`, parity / golden / test files, golden JSON, scripts, `tests/README.md` | Not in the spec 169 staged set | Matches the git snapshot and the developer's post-checks (golden sha256 `cb33ffb0…1b14`). |

## Test matrix (design §7) completeness

All 41 rows of the design table are present, with no missing rows and no weakened expectations:

| Group | Location in `authEmailHook.verify.test.ts` |
|---|---|
| V0 | :85-93 |
| V1.1-V1.5 | :95-143 |
| V2.1-V2.4 | :145-199 |
| V3.1-V3.7 | :201-244 |
| V4.1-V4.4 | :246-278 |
| V5.1-V5.8 | :280-329 |
| V6.1-V6.5, plus the OTHER/OTHER2 well-formedness assertion the design required | :331-366 |
| V7.1-V7.3 | :368-380 |
| V8.1-V8.3 | :382-399 |
| V9 | :401-408 |
| S1, S2 | :410-441 |

The test-design rules were followed:
- **Oracle independence.** Every expected signature comes from `createHmac` (:37-41) or from the openssl-agreed literals. None comes from `signWebhook`. `signWebhook` is only ever the system under test (V1.1, V1.2, V1.4, V1.5).
- **No rejection escapes.** Every verifier assertion uses `await expect(…).resolves.toBe(…)`.
- **Realm-safe comparisons.** Bytes are compared as hex, never as `Uint8Array`s (:48-50).
- **Reproducible randomness.** Seeded mulberry32 (seeds 169 and 1690), with the failing input embedded in each property assertion.
- **No mocking of the runtime globals.** `crypto` is not mocked. The test file imports only `createHmac` from `'crypto'`, so the global `crypto` that V0 probes is not shadowed.

**Developer deviations (implementation notes): accepted.**
- V6.5 also checks `['', '!!!!']` with header `'v1, v1,'`. This is a stronger fail-open probe: two throwing secrets and two empty candidates.
- V3.6 also checks the Infinity-sized header signed over its own raw text.

Both expect `false` and both tighten coverage. Neither changes the contract. The developer reports no other deviations, and I found none.

## Findings

### Critical
None.

### Should-fix

**SF1. The Node 20 run of V0/V1 is unproven until CI runs.**
- The developer ran jest only on local Node 24.14.1 (implementation notes, "Order followed" 1).
- Spec AC §4 requires the tests to run "on the CI Node version", which is Node 20 (`test.yml`). Design §6.2 / risk 3 named the cross-realm `ArrayBuffer` hazard as version-sensitive, and V0 + V1 are the proof for it.
- No code change is needed. Before SHIP_READY, release-coordinator must treat the first `test.yml` run that includes this change (Node 20) as a gate for this spec, in addition to the standing CLAUDE.md rule that both `test.yml` and `db-migrations-applied.yml` must be green.
- If V0 or V1 is red on Node 20, the developer must return to the architect; do not mock (AC §4).

### Minor

**M1. Comments added inside the block that are not in the design's text.** These are:
- authEmailHook.ts:456: "Only typed-array views are handed to crypto.subtle …"
- :482: the D1 rationale
- :507: the null-sentinel warning
- the trailing `// too old` / `// too new` on :498-499

All of them are accurate, they restate hard rules 1 and 3 at the point of use, and they pass parity (b). Accepted; no action.

A self-correction on the design: hard rule 4 says "no … `import` … in the block", but the design's own suggested comment (:416, "no third-party import") contains the word. The rule means import *statements*, which S1/S2 and parity (b) check structurally. No code change is needed. Future readers should read hard rule 4 as "no import statements".

**M2. D2 has no dedicated jest case.**
- D2 says a present-but-non-string header value (for example `{ 'webhook-id': undefined }` with the key present) returns false.
- V4.1 covers absent keys and V4.2 covers `""`. The `typeof` branch for an explicitly-`undefined` value is reached only incidentally.
- It cannot be reached from the handler, because `Object.fromEntries(Headers)` always yields strings. The design matrix did not require it.
- Optional follow-up: one row asserting false for an explicit-`undefined` value.

**M3. The inner D1 boundary is not pinned.**
- V3.7 pins the out-of-range clock (`8.64e12`) as false, but not the largest accepted clock (`8.64e12 - 300` with a matching ts and a valid signature as true).
- Both are far from any reachable clock (now ≈ 1.7e9), and the design did not require the inner case.
- Optional follow-up only.

**M4. Steps 1-3 / 5-10 were checked by inspection, not by diff.**
- This agent has no shell, so I could not run `git diff --cached HEAD -- supabase/functions/auth-email-hook/index.ts`.
- What I did: compare the handler and the helpers outside the block against the spec 166 §3 contract, the spec 168 shapes and design §5. I found no change outside the header, the import note, the `verifySignature` removal and step 4.
- The developer reports exactly five hunks from `git diff HEAD`: header, import note, block insert, `verifySignature` removal and step 4.
- Before proposing a ship, release-coordinator (or code-reviewer, if it has a shell) should run that diff once and confirm that the hunk count and the content outside the block match.

## Design-level notes (no action)

- **`Object.fromEntries(req.headers)` now sits outside any try.** Previously it ran inside `verifySignature`'s try; it is now outside the verifier, at index.ts:771, exactly as §5 specified. A throw there would become a 500, not a 401, but `Object.fromEntries` over a `Headers` instance cannot throw, so the contract is unaffected.
- **The idempotency key still reads the raw header.** Step 9 reads `req.headers.get("webhook-id")` (index.ts:826), the same combined string the verifier signed over (§2.7), so the Resend idempotency key stays tied to the verified id.
- **Not affected:** RLS, migrations, the realtime publication, `src/lib/db.ts` and `useStore.ts`, as designed. `verify_jwt = false` stays pinned and is not in the diff.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix (SF1: confirm the Node 20 CI run of V0/V1 before SHIP_READY; no code change), 4 Minor (M1 comment additions accepted, M2/M3 optional extra jest rows, M4 run the index.ts `git diff --cached HEAD` once to confirm the five-hunk claim).
payload_paths:
  - specs/169-auth-email-hook-inline-verifier/reviews/backend-architect.md

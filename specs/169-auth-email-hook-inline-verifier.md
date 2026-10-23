# Spec 169: auth-email-hook inline Standard Webhooks verifier (no third-party import)

Status: READY_FOR_REVIEW

Source: spec 168 security-auditor Low L2 ([specs/168-auth-email-hook-followups/reviews/security-auditor.md](168-auth-email-hook-followups/reviews/security-auditor.md), second Low), plus spec 168 architect design §5 "Facts for a future spec". The owner approved the scope in chat. No product questions are open. The remaining unknowns are technical and are marked **Architect to decide**.

**Baseline.** Spec 168 is staged and the owner will commit it before build. Its staged content is the baseline for this spec: the spec 168 core block (`resolveRedirect` / `resolveLinkAndCode` / `renderBody` / `classifyDelivery`), `deliver()`, the golden fixture, the S10 arm and the S9 precondition. The architect and developer confirm the spec 168 commit has landed before the first edit, and record its hash in the design.

**Supersedes spec 166 D2 in part.** Spec 166 D2 chose `standardwebhooks@1.0.0` from esm.sh and said "security-critical, so no hand-rolled HMAC". This spec deliberately reverses that. The reason is that the signature check is the function's **only** gate (`verify_jwt = false`), so the CDN is part of the trust boundary. The replacement is therefore held to library parity (§2), independent test vectors (§4) and a security review.

## User story
As the brand owner, I want the auth-email-hook to verify GoTrue's signature with code that lives in this repo, so that a compromised esm.sh cannot serve a verifier that accepts forged signatures and lets anyone who can reach the function URL send phishing mail from the brand domain.

Concrete scenario: the owner runs `supabase functions deploy auth-email-hook` (spec 166 runbook step 4). Today the bundler fetches `standardwebhooks`, `@stablelib/base64` and `fast-sha256` from esm.sh at that moment, with no integrity lock on esm.sh's build output. After this spec the function has no third-party import. The deploy bundles only repo code and the runtime's built-in WebCrypto (`crypto.subtle`). A forged request still gets 401 `{"error":"invalid signature"}`, exactly as today.

## Behaviour boundary
For every request GoTrue can send, and for every request the spec 166/168 smoke sends, these must stay identical to the baseline:
- the HTTP status and response body
- the gate order: method → secret parse → size → signature → payload
- the rendered mails and the transport requests
- the log line keys and values, including `reason:"signature"` on every verify failure

The only intended changes are:
1. the import is removed and the verifier code is inline
2. verification may become `async`, and the handler awaits it
3. the comments describing the verifier are updated

Any further divergence from `standardwebhooks@1.0.0` on adversarial input (see §2, "Library semantics the architect must pin down") must be **fail-closed**. That means the inline verifier never treats a request as validly signed when the library would reject its headers, timestamp or signature. Every divergence must be listed in the design with a rationale.

## Acceptance criteria

### 1. Placement and dependency removal
- [ ] `supabase/functions/auth-email-hook/index.ts` contains no `import` statement, no `https://` module specifier, no `npm:` specifier and no `jsr:` specifier. The string `standardwebhooks` appears only in comments, if at all.
- [ ] The verifier (signed-content construction, HMAC-SHA256 via `crypto.subtle`, header parsing, timestamp tolerance, constant-time comparison, and iteration over rotated secrets) lives **inside** the `// BEGIN auth-email-hook-core (spec 166)` / `// END auth-email-hook-core (spec 166)` block. It is byte-identical in [src/lib/authEmailHook.ts](../src/lib/authEmailHook.ts) and in `index.ts`.
- [ ] [src/lib/authEmailHook.parity.test.ts](../src/lib/authEmailHook.parity.test.ts) passes **unmodified**, all four cases including (b): the block contains no `export`, `Deno.`, `fetch(` or `console.` and no placeholder literal. New comments inside the block must avoid these words (spec 168 §1.3 word traps). For example, "exported for jest" would break (b).
- [ ] The verifier takes the current time as an **injected parameter**, for example `nowSeconds: number`. It does not read a clock itself. The handler passes the real clock. **Architect to decide** the exact signature, including whether it takes the `string[]` from `parseHookSecrets` or one secret at a time, and whether it takes a headers record or three explicit strings.
- [ ] The new verifier function(s), and any helper types the tests need, are added to the canonical file's `export` list, which sits **outside** the block. **Architect to decide** which symbols.
- [ ] The handler's `verifySignature` wrapper (outside the block) is removed or reduced to a call into the core verifier. **Architect to decide.** Step 4 of the handler awaits the result and keeps:
  - `logOutcome({ action, outcome: "rejected", recipients, dropped, reason: "signature" })`
  - `jsonResponse(401, { error: "invalid signature" })`
  
  No error detail (`e.message`, which header failed, or the computed signature) is logged or returned.
- [ ] Any exception the verifier raises (for example a WebCrypto failure, or a key that won't import) maps to a verify **failure** for that secret: try the next secret, and 401 if none match. It never escapes as a 500 `internal error` or a 200. **Architect to decide** where the try/catch lives.

### 2. Behavioural parity with `standardwebhooks@1.0.0`
The PM's reading of the library is below. The **architect confirms each point against the published `standardwebhooks@1.0.0` source** (npm tarball or the tagged GitHub source) and cites file and line in the design. Where the source differs from this list, the source wins, subject to the fail-closed rule in the "Behaviour boundary" section.
- [ ] **Key.** The secret is the base64 part after `v1,whsec_`, exactly as `parseHookSecrets` returns it today (unchanged). The HMAC key is that string's decoded bytes. **Architect to decide** the decoder (for example `atob` to bytes, already used by `parseHookSecrets`). The architect must also show that, for every string `parseHookSecrets` accepts, it yields the same bytes `@stablelib/base64@1.0.1` yields, because GoTrue signs with those bytes. Spec 166 fix-1 evidence covers accept/reject parity, not decoded-byte equality.
- [ ] **Signed content.** It is `${webhook-id}.${timestamp}.${body}`, UTF-8 encoded. `body` is the exact string from `req.text()`. The expected signature is standard padded base64 of HMAC-SHA256(key, signed content).
- [ ] **Signature header.** `webhook-signature` is a space-separated list of `<version>,<sig>` entries. Entries whose version is not `v1` are skipped. The request is accepted if **any** `v1` entry matches the expected signature. The comparison is **constant-time** with respect to the signature bytes; a length mismatch may short-circuit, because signature length is public. **Architect to decide** between:
  - computing the expected signature and comparing in constant time, or
  - base64-decoding each candidate and using `crypto.subtle.verify`, which is constant-time by construction. In that case an undecodable candidate is a non-match, not an exception that escapes.
- [ ] **Required headers.** A missing or empty `webhook-id`, `webhook-timestamp` or `webhook-signature` is rejected. Header names are matched case-insensitively. `Object.fromEntries(req.headers)` already lowercases them; the architect confirms nothing else is needed.
- [ ] **Timestamp.** A non-numeric timestamp is rejected. More than 300 s in the past ("too old") is rejected, and more than 300 s in the future ("too new") is rejected. The architect pins the exact boundary (PM's reading: `now - ts > 300` is too old and `ts > now + 300` is too new, so exactly ±300 s is accepted), and jest asserts both sides of each boundary.
- [ ] **Rotation.** Every `|`-separated secret from `parseHookSecrets` is tried in order. A match on any secret accepts.

**Library semantics the architect must pin down** (each recorded in the design as "replicate" or "diverge, fail-closed, because …"):
- **Lenient timestamp parsing.** The PM's reading is that the library uses `parseInt(header, 10)`. That accepts `"1700000000abc"`, `" 1700000000"` or `"17e8"` as their leading integer, and signs the **parsed integer**, not the raw header text. Options:
  - replicate exactly, or
  - require `^[0-9]+$` (stricter; GoTrue always sends a plain integer)
  
  Either way, the signed content uses the same timestamp text the library would use for every value that is accepted.
- **`verify()` JSON-parses the body.** The PM's reading is that the library's `verify()` returns `JSON.parse(payload)`. So a validly signed **non-JSON** body throws inside `verify`, and today that gives 401 `invalid signature` (log `reason:"signature"`), not 400 `invalid payload`. Because the HTTP contract must be unchanged, the default is to **replicate** this: a validly signed body that is not parseable JSON fails verification and gives 401. If the architect proposes letting it reach step 5 (400 `invalid payload`), the design must call it out explicitly as a contract change, and the developer's plan must flag it to the owner at plan approval.
- **Malformed signature entries.** Examples: an entry with no comma, extra commas, empty entries from repeated spaces, or a `v1,` entry with an empty or non-base64 signature. Each is a non-match for that entry, never an exception that escapes and never an accept.
- **Duplicate headers.** A comma-joined header value is what `Headers` produces for repeated headers. The architect states the resulting behaviour and confirms it is fail-closed.

### 3. Unchanged HTTP contract and golden
- [ ] [src/lib/authEmailHook.golden.json](../src/lib/authEmailHook.golden.json) is **byte-unchanged**: `git diff --exit-code` is clean and its sha256 matches the spec 168 recorded value `cb33ffb0412ac48b3633b40eb212ecf53b76eb2da20764a597e7a06ffaee1b14`. [src/lib/authEmailHook.golden.test.ts](../src/lib/authEmailHook.golden.test.ts) passes unmodified.
- [ ] Every existing case in [src/lib/authEmailHook.test.ts](../src/lib/authEmailHook.test.ts) still passes. No case has its expected value changed and none is deleted. Additions only, apart from the import list.
- [ ] Handler steps 1-3 and 5-10 in `index.ts` are byte-unchanged apart from the `await` at step 4 and any variable needed to pass the clock. `deliver()`, `logOutcome`, `jsonResponse`, `MAX_BODY_BYTES`, `TRANSPORT_TIMEOUT_MS` and the env reads are unchanged.
- [ ] `supabase/config.toml` is unchanged, including `[functions.auth-email-hook] verify_jwt = false`.

### 4. Tests (jest, unit project)
The verifier is exercised directly in jest from the canonical module, so jest tests the shipping code. A test may compute expected signatures with `node:crypto` `createHmac` as an **independent oracle**. Tests must not derive their expectations from the verifier's own signing path. **Architect to decide** the test file: new file or additions to `authEmailHook.test.ts`.
- [ ] **Fixed vectors** (from spec 168 implementation notes; openssl and node agreed on both). Key = decoded D7 dev secret `2ce0802ff0c457f38d2d8fe29abfd27a774499a8a51e8a24fcda2d168acfae877fd34d34` (hex; supplied to the verifier as its `whsec_` base64 form, the D7 literal), id `msg_vector`, ts `1700000000`, injected clock `1700000000`:
  - body `{"a":"b"}` → expected signature `xqgCspicZv/oSTd9Q1fnDS8JxTgxgn77rND6oyBOui4=`, and the verifier accepts `v1,<that>`
  - body `{"e":"é—"}` (13 UTF-8 bytes) → `9tmyMw8kfLRfWKnqherF2jbqNDoM6962K50b8EUjMLE=`, accepted
  - If the architect exposes the signature computation as its own function, the test also asserts it returns exactly these strings.
- [ ] **Edge cases**, each a reject unless stated, all with an injected clock:
  - wrong key, using a well-formed different secret
  - stale: ts = now − 301 (reject); ts = now − 300 (accept, per the pinned boundary)
  - future: ts = now + 301 (reject); ts = now + 300 (accept, per the pinned boundary)
  - non-numeric timestamp (`"abc"`, `""`), plus whatever the architect's parseInt decision implies for `"1700000000abc"`
  - missing `webhook-id`; missing `webhook-timestamp`; missing `webhook-signature` (one case each)
  - a multi-signature header (`v1,<bad> v1,<good>`) → accept; `v1,<bad> v1,<bad>` → reject
  - a non-v1 prefix carrying the correct signature (`v2,<good>`, `v1a,<good>`) → reject
  - rotation: `[wrongSecret, rightSecret]` → accept (the second secret matches); `[wrongA, wrongB]` → reject
  - a tampered body (one byte changed after signing) → reject
  - a tampered id or timestamp (signed with one, sent with another, within tolerance) → reject
  - malformed signature entries (no comma, empty signature, non-base64) → reject, with no exception escaping
  - a validly signed non-JSON body → the outcome follows the architect's §2 decision (default: reject)
- [ ] The tests run in the jest `unit` project (`testEnvironment: 'node'`) on the CI Node version, with no polyfill or mock of `crypto.subtle`. If `crypto.subtle` is not reachable there, the developer stops and returns to the architect rather than mocking it.

### 5. Smoke and probe (unchanged scripts)
- [ ] `scripts/smoke-send-email-hook.sh` is **not modified**. All of its S5 signature-gate arms pass unchanged: no headers → 401, wrong key → 401 `invalid signature`, now−600 s → 401, GET → 405, signed `{}` → 400, signed empty user/email_data → 400, oversize → 413, Mailpit total 0. So does every signed arm (S6, S10 and the rest), and every GoTrue-driven arm (S1-S4, S6b, S9), because GoTrue's real signatures must verify.
- [ ] `scripts/probe-auth-email-hook.sh` is **not modified** and keeps working: run locally against `http://127.0.0.1:54321/functions/v1/auth-email-hook`, the env path gives 200 `{}` plus one "Account notification" in Mailpit, and a wrong but well-formed secret gives 401 with the mismatch hint.
- [ ] After a hot reload, or `docker restart supabase_edge_runtime_imr-inventory` if needed (run the CLAUDE.md bind-mount check first), the edge-runtime logs show the function booting with no module-resolution error, and an unsigned POST gives 401 `{"error":"invalid signature"}`.

### 6. Docs
- [ ] The `index.ts` header's AUTH POSTURE paragraph says the Standard Webhooks signature is verified by an **inline WebCrypto (HMAC-SHA256) verifier in the core block**, with a constant-time compare, ±300 s tolerance and rotation, and that the function has no third-party imports (spec 169).
- [ ] The import comment block (`index.ts:47-53` at baseline: "Transitive deps pinned with ?deps= …" / "Spec 168 item 5 …") is removed or replaced by a short note that the esm.sh dependency was removed in spec 169 (security L2).
- [ ] The comment at handler step 4 stays accurate.
- [ ] The canonical file's header (outside the block) mentions signature verification.
- [ ] `tests/README.md` is updated **only** if it references `standardwebhooks` or esm.sh for this function. At the PM's read it does not (lines 414-434), so no change is expected.
- [ ] CLAUDE.md is not edited by this spec.

### Done criteria
- [ ] Full `npx jest` is green. Run the full suite, not a subset.
- [ ] `npm run typecheck` and `npm run typecheck:test` are clean.
- [ ] `bash scripts/smoke-send-email-hook.sh` prints **ALL ARMS PASSED**. The only SKIP is the pre-existing S8 (and the S9 redemption half only if the autoconfirm precondition is not `true`).
- [ ] `npm run test:smoke` is green.
- [ ] Mailpit-using smokes run **strictly sequentially, never concurrently**: `smoke-send-email-hook.sh`, `test:smoke`, `smoke-store-user.sh`, and the probe. That includes not running them alongside another session's spec 167 smoke run.
- [ ] Before the first edit, the developer shows the owner a file-by-file plan and gets approval.
- [ ] Stage **only spec 169 paths** and **never commit**; the owner commits.
  - Spec 167 paths are staged by another session. Do not stage, unstage, restore or modify any of them: `specs/167-*`, `src/i18n/*.json`, `src/screens/cmd/sections/AuditLogSection.tsx`, `src/screens/cmd/sections/phone/PhoneAuditLog.tsx` and their tests, `src/types/index.ts`, `src/utils/enumLabels.test.ts`, `src/utils/formatAuditAction.ts`, `supabase/functions/delete-user/index.ts`, `supabase/functions/manage-store-user/index.ts`, `scripts/smoke-store-user.sh`, `scripts/smoke-edge-roles.sh`.

## In scope
- `src/lib/authEmailHook.ts`: the verifier inside the core block, export-list additions, and a header line
- `supabase/functions/auth-email-hook/index.ts`: the identical core block, removal of the import, step 4 awaiting the core verifier, the `verifySignature` wrapper removed or thinned, and the header/import comment updates
- jest verifier tests, as a new file or additions to `src/lib/authEmailHook.test.ts`
- `tests/README.md`, only if it turns out to reference the library (not expected)
- This spec file: design, implementation notes and files changed

## Out of scope (explicitly)
- **Removing esm.sh imports from other edge functions** (`@supabase/supabase-js@2` in `send-invite-email`, `delete-user`, `manage-store-user` and others). Those functions are JWT-gated or service-token-gated and are not covered by this finding. That needs its own spec if wanted.
- **`npm:` specifiers or `deno.lock`.** Spec 168 item 5's fallback stands. Removing the dependency makes it moot for this function.
- **Asymmetric `v1a` (ed25519) signatures** or any Standard Webhooks feature beyond what `standardwebhooks@1.0.0` `Webhook.verify` does with a symmetric `whsec_` secret. GoTrue's Send Email hook uses `v1` HMAC.
- **Changing the tolerance, the secret format, `parseHookSecrets` strictness, or rotation semantics.**
- **New smoke arms** (for example a live "too new" or "multi-signature" arm). jest covers those cases against the shipping code, and the existing S5 arms stay the live proof.
- **Modifying `scripts/smoke-send-email-hook.sh` or `scripts/probe-auth-email-hook.sh`**, including aligning `sign_headers` (spec 168 decided against).
- **Replay protection** (remembering seen `webhook-id`s). The library does not do it, and the ±300 s window plus Resend idempotency (spec 166 D13) is the accepted posture.
- **`supabase/config.toml`**, including `verify_jwt`.
- **Any prod action**: deploy, `supabase secrets set`, dashboard change, or MCP call. The function reaches prod at the owner's spec 166 runbook steps 4/5/5b.
- **CLAUDE.md edits.** If the architect thinks the "edge function" conventions need a line about inline verifiers, that is a separate owner decision.
- **The `app.json` slug.** Not touched.
- **Every spec 167 path** (listed under Done criteria).

## Open questions resolved
- Q: Which finding does this close? → A: Spec 168 security-auditor Low L2 (esm.sh verifier as a supply-chain gate on a `verify_jwt = false` function).
- Q: Inline verifier or lockfile? → A: Inline verifier on WebCrypto (`crypto.subtle` HMAC-SHA256). After this, the function has no third-party import.
- Q: Where does the verifier live? → A: Inside the parity-locked core block, so jest exercises the shipping code.
- Q: Required parity? → A: Behavioural parity with `standardwebhooks@1.0.0`: `whsec_` base64 key, `${id}.${ts}.${body}` signed content, base64 HMAC-SHA256, space-separated `v1,` entries with any-match in constant time, ±300 s tolerance both directions, non-numeric and missing headers rejected, and every rotated secret tried. The architect pins down unclear library semantics.
- Q: May the HTTP contract change? → A: No. Gate order, the 401 `{"error":"invalid signature"}` body and the log key set are unchanged. Async verification is the only handler change. The golden fixture stays unchanged and green.
- Q: Tests? → A: jest fixed vectors (D7 key, `msg_vector`, `1700000000`, the two bodies and their known signatures), edge cases (wrong key, stale, future, non-numeric, each missing header, multi-signature, non-v1 prefix, rotation), an injectable clock, and the existing smoke arms passing unchanged.
- Q: Docs? → A: Update the `index.ts` header and import note; update `tests/README.md` only if it mentions the library. The probe keeps working unchanged.
- Q: Commit? → A: No. Stage only spec 169 paths; the owner commits.

## Dependencies
- **Spec 168, committed by the owner before build.** It provides the core block, `deliver()`, the golden fixture and test, the S10/S9 smoke changes, the probe node-HMAC, and the test vectors in its implementation notes.
- **Spec 166.** It provides D2 (partly superseded here), D7 (the local dev secret), the `parseHookSecrets` fix-1 strictness, and runbook steps 4/5/5b (prod acceptance).
- The `standardwebhooks@1.0.0` published source, read-only, as the parity reference. It is not installed as a dependency. **Architect to decide** how to obtain it for reading (for example, viewing the npm tarball contents). Any download beyond reading published source needs owner permission, per the spec 168 precedent.
- WebCrypto `crypto.subtle` in the Supabase edge runtime (`[edge_runtime] deno_version = 2`) and in the jest Node env.
- The local stack via `npm run dev:db` (Mailpit, `supabase_edge_runtime_imr-inventory`, `supabase_auth_imr-inventory`).

## Project-specific notes
- **Cmd UI section / legacy:** None. Backend and tests only; no UI.
- **Per-store or admin-global:** Project-global (GoTrue auth mail). No `auth_can_see_store()` involvement and no RLS change.
- **Realtime channels touched:** None. No publication change, so the realtime restart gotcha does not apply.
- **Migrations needed:** No. The `db-migrations-applied` gate is unaffected.
- **Edge functions touched:** `auth-email-hook` only. The `verify_jwt = false` pin and the signature-gate HTTP semantics are unchanged; only the verifier's implementation moves in-repo.
- **Web/native scope:** Server-side only. No client, Vercel or EAS change.
- **`app.json` slug:** Not touched.
- **Test tracks:**
  - **jest** (unit project): the verifier vectors and edge cases, parity and golden unchanged, and the full suite
  - **shell smoke:** `smoke-send-email-hook.sh` and `test:smoke`, unchanged scripts, as live proof
  - **pgTAP:** not applicable (no SQL)

## Risks for the architect
1. **Hand-rolled crypto on the only gate.** Spec 166 D2 avoided this on purpose. The mitigations are exact-parity semantics pinned from the library source, independent `node:crypto` oracle vectors, a constant-time compare (or `subtle.verify`), and security-auditor review. A parity bug that is *laxer* than the library (for example, accepting when no `v1` entry matches, comparing only a prefix, or ignoring the timestamp) is a Critical.
2. **Key-decode equivalence.** If the inline decoder yields different bytes from `@stablelib/base64@1.0.1` for some secret that `parseHookSecrets` accepts (for example, non-canonical trailing bits), GoTrue's signatures stop verifying (fails closed, but the hook stops working) for that secret. The architect shows equivalence for the accepted input space.
3. **Hidden library coupling.** These are `parseInt` leniency and `verify()`'s `JSON.parse` of the body (see §2). Getting the second one wrong silently changes signed-non-JSON from 401 to 400. No smoke arm covers it, so jest must.
4. **TS graphs.** The block must type-check in the base `npm run typecheck` graph, the `typecheck:test` graph (`types: ["jest","node"]`), and the Deno runtime (transpiled without type-checking; there is no local `deno`). `crypto.subtle`, `BufferSource`, `TextEncoder` and `atob` typings must resolve in both TS graphs without new `lib` / `types` entries. **Architect to decide** if any tsconfig change is unavoidable; the default is none.
5. **jest env reachability of `crypto.subtle`.** Jest 29's `node` environment should expose Node's global `crypto`. The architect confirms this on the CI Node version. The criteria forbid mocking it.
6. **Async gate.** Making step 4 `await` must not reorder the gates or let an unhandled rejection escape to the outer catch as 500 `internal error` (§1 criterion: exceptions become verify failures).
7. **Parity word traps.** Comments inside the block must not contain `export`, `fetch(`, `console.`, `Deno.` or the placeholder domain.
8. **Prod acceptance.** No deploy in this spec. The first prod proof is the owner's spec 166 runbook step 5b probe (GoTrue-independent signing) and step 5 (real GoTrue traffic). Removing the esm.sh fetch also removes a deploy-time network dependency (spec 166 risk 9). That is a side benefit, not a criterion.
9. **Shared Mailpit.** Run the smokes strictly one after another, never alongside a spec 167 session.

## Backend design

Architect, 2026-10-22. **Baseline:** the spec 168 commit (hash recorded by the developer at build start). The design was written against the spec 168 *staged* content of `src/lib/authEmailHook.ts`, `supabase/functions/auth-email-hook/index.ts`, `src/lib/authEmailHook.parity.test.ts`, `src/lib/authEmailHook.test.ts` and `src/lib/authEmailHook.golden.test.ts`. Line numbers below refer to that content.

**Parity reference.** `standardwebhooks@1.0.0` `dist/index.js` (cited as `swh:<line>`), `dist/timing_safe_equal.js` (`tse:<line>`), and `@stablelib/base64@1.0.1` `lib/base64.js` (`b64:<line>`). Main Claude fetched these verbatim for reading only; nothing was installed. `fast-sha256@1.3.0` was not read. Its HMAC is checked indirectly: the fixed vectors (openssl and node agree), the `node:crypto` oracle in jest, and the live GoTrue-signed smoke arms.

Not affected: data model, migrations, RLS, PostgREST/RPC, `src/lib/db.ts`, realtime (no publication change, so the restart gotcha does not apply), `src/store/useStore.ts`, UI, `supabase/config.toml` (`verify_jwt = false` stays pinned), and every other edge function.

### 0. Decisions at a glance

| Item | Decision |
|---|---|
| Verifier shape | `verifyWebhook(secrets, body, headers, nowSeconds): Promise<boolean>` in the core block. It takes the whole `string[]` from `parseHookSecrets` and the headers **record**. It never throws or rejects. |
| Signature compare | Compute the expected base64 string, then do a **constant-time string compare** (library parity). `crypto.subtle.verify` is **rejected** because it would be *laxer* than the library (§2.3). |
| Signed non-JSON body | **Replicate: verify failure, so 401** `invalid signature` / `reason:"signature"`. No contract change. |
| `parseInt` leniency | **Replicate exactly** (`parseInt(h, 10)`), and sign the canonical decimal of the parsed integer. |
| Multi-comma entries | **Lax, replicate** (`split(",")[1]`). |
| Key decoder | `atob` → bytes, behind a strict-shape guard (`/^[A-Za-z0-9+/]+={0,2}$/` and length % 4 === 0). |
| try/catch | A per-secret try/catch around signing (rotation continues), plus one outer try/catch over the whole verifier (returns false). There is no try/catch in the handler. |
| `verifySignature` wrapper | **Removed.** Step 4 calls `await verifyWebhook(...)` directly. |
| Placement | In the core block, directly after `parseHookSecrets` and before `isLocalDevSecret`. |
| Exports | Functions `base64ToBytes`, `timingSafeEqualString`, `signWebhook`, `verifyWebhook`; type `WebhookHeaders`. |
| Test file | New file: `src/lib/authEmailHook.verify.test.ts`. `authEmailHook.test.ts` is **not touched**. |
| tsconfig / jest config | **No change.** |

### 1. Library semantics, confirmed against the source

Main Claude's reading is confirmed, with one PM correction.

| # | Point | Source | Confirmed |
|---|---|---|---|
| L1 | Header names are lowercased by copying into a new object. | swh:48-51 | Yes |
| L2 | Id, signature or timestamp missing **or empty** is rejected (a falsy test). | swh:55 | Yes |
| L3 | Timestamp is `parseInt(header, 10)`, and NaN is rejected. | swh:91-93 | Yes |
| L4 | Too old if `now - ts > 300`; too new if `ts > now + 300`. **Exactly ±300 passes.** `now = Math.floor(Date.now()/1000)`. | swh:7, :90, :95, :98 | Yes |
| L5 | Signed content uses the **parsed** number: `new Date(ts*1000)` (swh:101), then `Math.floor(getTime()/1000)` (swh:84), then `` `${msgId}.${n}.${payload}` ``, UTF-8 encoded (swh:83-85). | swh:84-86 | Yes |
| L6 | Expected signature is `base64.encode(hmac(key, toSign))`, standard padded. The `"v1,"` prefix is stripped before comparing. | swh:86-87, :60 | Yes |
| L7 | The signature header is `split(" ")`, then each entry is destructured from `split(",")`, so only `[0]` and `[1]` are used (lax). Entries whose version is not `"v1"` are skipped. Any match accepts. | swh:61-71 | Yes |
| L8 | The compare is over the UTF-8 bytes of the two base64 strings. A length mismatch returns false. The XOR loop is constant time. | swh:62, :68; tse:9-28 | Yes |
| L9 | When an entry has no comma, `signature` is undefined. `encode(undefined)` gives an empty array, so the lengths differ and the entry is a non-match. | swh:64, :68 | Yes |
| L10 | On a match the library returns `JSON.parse(payload)`, so a correctly signed non-JSON body **throws**. Today `verifySignature` catches that, tries the next secret, returns false, and the handler answers **401**. | swh:69; index.ts:589-599 | Yes |
| L11 | Key: an optional `whsec_` prefix is stripped, then `@stablelib/base64` decode. The handler passes the bare base64 (`parseHookSecrets` already strips `v1,whsec_`), and `_` is not in the accepted alphabet, so the strip is a no-op. | swh:41-44 | Yes |
| L12 | Decode: padding is counted only at the end; it throws if there are more than 2 `=` or the length is under 4 (b64:189-203). It throws on any out-of-alphabet character, including a mid-string `=` (b64:117-119, :166-187). Non-canonical trailing bits are dropped silently by the `Uint8Array` store truncating to 8 bits (b64:103, :109, :114). | b64 | Yes |

**PM correction.** `"17e8"` is not "accepted as its leading integer" in any useful sense. `parseInt("17e8", 10)` is `17`, which is then rejected as too old. `"1700000000abc"`, `"+1700000000"`, `"01700000000"` and `"1700000000.9"` all parse to `1700000000`. They are accepted only if the signature is over the text `"1700000000"`.

**Library quirk not replicated (not observable).** `tse:13-16` wraps `a.buffer` from offset 0 and ignores `byteOffset`. That is only correct for fresh arrays, which `TextEncoder` returns. The inline compare indexes the views directly. The results are identical for every input the library handles correctly.

### 2. Decisions on the open items

#### 2.1 Signed non-JSON body: replicate the 401
After the first signature match, `verifyWebhook` runs `try { JSON.parse(body); return true; } catch { return false; }`.

This is equivalent to the library-plus-wrapper. In the library, a JSON throw on secret *i* makes the wrapper try secret *i+1*. Whether the body parses does not depend on the secret, so the overall result is (some secret matches) AND (the body parses). A correctly signed body that is JSON but has the wrong shape (`{}`, `null`, `[]`, `1`) still passes the gate and reaches step 5, which gives **400**. That preserves smoke S5 "signed `{}` → 400". No contract change; nothing to flag to the owner.

#### 2.2 `parseInt`: replicate exactly
Use `const ts = parseInt(tsHeader, 10); if (Number.isNaN(ts)) return false;`, then the L4 bounds, then sign `` `${msgId}.${ts}.${body}` ``.

Rationale:
- Zero divergence means nothing new for the security review to reason about.
- The leniency is not a weakness. The signed bytes always use the canonical integer, so junk in the header cannot change what must be MAC'd.

GoTrue evidence, recorded but **not load-bearing** because we replicate: from my reading of supabase/auth's hook dispatcher (recalled, not re-fetched this session), GoTrue sets `webhook-timestamp` to `fmt.Sprintf("%d", time.Unix())`, a plain integer, and the Go standard-webhooks `Sign` uses `strconv.FormatInt(ts, 10)`. The smoke and probe send `date +%s`.

**Proof that the text equals the library's** (scoped by divergence D1, §2.6). Every accepted `ts` satisfies `|ts| ≤ 8.64e12`. So `ts*1000` is an exact double below 2^53, `new Date(ts*1000)` is valid, `Math.floor(getTime()/1000) === ts`, and `${ts}` has no exponent. That means `${ts}` is the same text the library builds at swh:84-85.

#### 2.3 Signature compare: expected string plus constant-time compare
Rejected alternative: base64-decode each candidate and call `crypto.subtle.verify`. It is **laxer** than the library in three ways:
- non-canonical aliases. A 32-byte MAC is 43 data characters, carrying 2 spare bits. `…ui4=` and `…ui5=` decode to the same bytes, but the library compares strings and rejects the alias.
- `atob` tolerates ASCII whitespace inside the candidate.
- `atob` accepts an unpadded candidate.

Under the spec's Risk 1 any of these is a Critical, so it is out. Jest V5.8 pins the alias case.

#### 2.4 Multi-comma entries: lax (replicate)
`const parts = entry.split(","); if (parts[0] !== "v1") continue; candidate = parts.length > 1 ? parts[1] : "";`

The compared substring must still equal the full 44-character expected MAC, so extra fields grant nothing. Strict would also risk breaking GoTrue with multiple secrets. From my recollection, GoTrue joins its signatures with `", "`, which gives `v1,sigA, v1,sigB` and makes every entry except the last carry a trailing comma. That recollection is unverified, and the lax decision does not depend on it. Jest V5.6 pins the shape anyway.

#### 2.5 Async signature and clock injection
- `verifyWebhook` is `async` and resolves to a boolean.
- The clock is the `nowSeconds` parameter. The block never reads a clock: no `Date.now`, no `new Date(`, which static check S2 enforces.
- The handler passes `Math.floor(Date.now() / 1000)`, which is exactly swh:90.
- Jest needs no fake timers and no Date mocking.

#### 2.6 Divergences from the library (all fail-closed)

| ID | Divergence | Why it is safe |
|---|---|---|
| D1 | `nowSeconds` must satisfy `Number.isSafeInteger(nowSeconds) && Math.abs(nowSeconds) <= 8.64e12 - WEBHOOK_TOLERANCE_SECONDS`, else return false. | A NaN clock would make both bounds false, so the library logic would accept any timestamp (fail-open). The guard also keeps every accepted `ts` inside the Date range, which the §2.2 proof needs. It is unreachable from the handler (now ≈ 1.7e9). |
| D2 | A non-string header value returns false. | The library would throw on `.split`, which the wrapper turns into false. Same outcome. |
| D3 | `base64ToBytes` throws unless the input matches `/^[A-Za-z0-9+/]+={0,2}$/` and its length % 4 === 0. | Its accepted set is a subset of stablelib's, with equal bytes on it (§4). It is stricter than bare `atob`, so whitespace and unpadded keys are refused. This only matters for direct jest calls, because `parseHookSecrets` already returns 500 on anything else. |
| D4 | Lowercased headers go into a `Map` rather than `{}`. | No observable difference for string values. A `__proto__` header is inert in both. |

Everything else is replicated: L1-L12, rotation in order, any-match, exact ±300.

#### 2.7 Duplicate headers
`Headers` joins repeated fields with `", "`, and `Object.fromEntries(req.headers)` carries the joined value. The inline verifier sees exactly what the library saw.
- `webhook-signature: v1,A, v1,B` → entries `v1,A,` (A under the lax rule) and `v1,B`. Accept iff A or B is valid. A valid signature could be sent alone anyway.
- `webhook-id` duplicated → the signed id is `"id1, id2"`. GoTrue never signs that, so reject.
- `webhook-timestamp` duplicated → `parseInt` takes the first value, and the signature must be over that canonical integer. A forger gains nothing.

All fail-closed. Jest V4.4 and V5.7 pin these cases.

#### 2.8 Header case-insensitivity
`Object.fromEntries(req.headers)` already yields lowercase names. `verifyWebhook` still lowercases, mirroring swh:48-51, so the core is self-contained and jest can pin mixed-case keys (V4.3). Nothing else is needed.

### 3. Core block additions (both copies, byte-identical)

Insert directly **after `parseHookSecrets`** and **before `isLocalDevSecret`**. Keep the BEGIN/END marker text unchanged (`(spec 166)`).

```ts
// Standard Webhooks verification (spec 169): behavioural parity with
// standardwebhooks@1.0.0 Webhook.verify, built on WebCrypto (crypto.subtle) so
// the function has no third-party import. The clock is a parameter so jest
// can pin the ±300 s boundaries; the caller passes the real clock.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

// Header record as received; names are matched case-insensitively.
type WebhookHeaders = Record<string, string | undefined>;

// Strict padded base64 → bytes. Throws unless [A-Za-z0-9+/]+ with at most two
// trailing "=" and length % 4 === 0 (the parseHookSecrets shape). On that set
// atob gives the same bytes as @stablelib/base64@1.0.1 (both drop
// non-canonical trailing bits).
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer>;
//   if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new Error("bad base64");
//   const bin = atob(b64); const out = new Uint8Array(bin.length);
//   for (i) out[i] = bin.charCodeAt(i); return out;

// Standard padded base64 of raw bytes (unexported helper).
function bytesToBase64(bytes: Uint8Array): string;
//   let bin = ""; for (i) bin += String.fromCharCode(bytes[i]); return btoa(bin);

// Constant-time compare of the UTF-8 bytes of two strings; a length mismatch
// is false at once (signature length is public).
function timingSafeEqualString(a: string, b: string): boolean;
//   const enc = new TextEncoder(); const x = enc.encode(a), y = enc.encode(b);
//   if (x.length !== y.length) return false;
//   let diff = 0; for (i) diff |= x[i] ^ y[i]; return diff === 0;

// base64(HMAC-SHA256(key, "<id>.<timestamp>.<body>")), UTF-8, without the
// "v1," prefix. May throw (bad key); verifyWebhook treats that as a non-match.
async function signWebhook(secret: string, msgId: string, timestamp: number, body: string): Promise<string>;
//   const key = await crypto.subtle.importKey("raw", base64ToBytes(secret),
//     { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
//   const mac = await crypto.subtle.sign("HMAC", key,
//     new TextEncoder().encode(msgId + "." + timestamp + "." + body));
//   return bytesToBase64(new Uint8Array(mac));

// true iff webhook-id / webhook-timestamp / webhook-signature are present and
// non-empty, parseInt(timestamp, 10) is within ±300 s of nowSeconds
// (inclusive), some "v1,<sig>" entry equals the expected signature under ANY
// secret (tried in order), and the body is JSON (the library JSON-parses the
// payload on a match, so a signed non-JSON body is a verify failure, i.e. 401,
// not 400). Never throws or rejects: any error is false.
async function verifyWebhook(
  secrets: readonly string[],
  body: string,
  headers: WebhookHeaders,
  nowSeconds: number,
): Promise<boolean>;
```

`verifyWebhook` pseudocode. **The order is mandatory.**

```
try {
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds) > 8.64e12 - WEBHOOK_TOLERANCE_SECONDS) return false;   // D1
  const h = new Map<string, string | undefined>();
  for (const k of Object.keys(headers)) h.set(k.toLowerCase(), headers[k]);                                            // L1, D4
  const msgId = h.get("webhook-id"), msgTs = h.get("webhook-timestamp"), msgSig = h.get("webhook-signature");
  if (typeof msgId !== "string" || msgId === "" || typeof msgTs !== "string" || msgTs === "" ||
      typeof msgSig !== "string" || msgSig === "") return false;                                                         // L2, D2
  const ts = parseInt(msgTs, 10);
  if (Number.isNaN(ts)) return false;                                                                                  // L3
  if (nowSeconds - ts > WEBHOOK_TOLERANCE_SECONDS) return false;                                                       // L4 too old
  if (ts > nowSeconds + WEBHOOK_TOLERANCE_SECONDS) return false;                                                       // L4 too new
  const candidates: string[] = [];
  for (const entry of msgSig.split(" ")) {                                                                             // L7
    const parts = entry.split(",");
    if (parts[0] !== "v1") continue;
    candidates.push(parts.length > 1 ? parts[1] : "");                                                                 // L9
  }
  for (const secret of secrets) {                                                                                      // rotation, in order
    let expected: string | null = null;
    try { expected = await signWebhook(secret, msgId, ts, body); } catch { expected = null; }
    if (expected === null) continue;
    for (const c of candidates) {
      if (timingSafeEqualString(c, expected)) {
        try { JSON.parse(body); return true; } catch { return false; }                                                 // L10
      }
    }
  }
  return false;
} catch {
  return false;
}
```

**Hard rules for this code** (code-reviewer and security-auditor check these):
1. **Never initialise `expected` to `""`.** If signing threw, a `"v1,"` entry (candidate `""`) would then match: fail-open. Use the `null` sentinel exactly as shown. Jest V6.5 pins this.
2. Every `await` sits inside a `try`. The function must never reject; otherwise the handler's outer catch would turn a verify failure into a 500.
3. Pass only **typed-array views** to `crypto.subtle`, never a bare `ArrayBuffer`. Node's webcrypto checks a bare ArrayBuffer with a realm-sensitive prototype test, which fails across jest's vm realm (§6.2). Views pass `ArrayBuffer.isView`, which works across realms.
4. No `Date.now`, `new Date(`, `subtle.verify`, `import` or `require` in the block. Do not add `import … from 'crypto'` to the canonical file: it would shadow the global `crypto` and make the Deno copy behave differently.
5. Do not log or return anything from the verifier other than the boolean.

**Parity (b) word traps for the new comments.** The suggested text above has been checked. If you reword it, it must not contain:
- `export` in any form (e.g. "exported for jest")
- `fetch(`
- `console.`
- `Deno.`, **including at the end of a sentence** ("…in Node and Deno." breaks (b))
- the placeholder domain

### 4. Key-decode equivalence (accepted space)

Let **S** be the set of strings matching `/^[A-Za-z0-9+/]+={0,2}$/` with length % 4 === 0.

1. **`parseHookSecrets` ∩ length 32..88 = S ∩ length 32..88.**
   - Its regex limits the alphabet. `atob`'s forgiving-base64 algorithm, applied to a length divisible by 4, strips one or two trailing `=`. Any remaining `=`, or a remainder of 1, throws.
   - So `atob` succeeds iff `=` appears only as one or two trailing characters, which is S.
2. **stablelib accepts every s ∈ S** (from 32 characters up):
   - padding ≤ 2 and length ≥ 4 (b64:198)
   - every non-padding character is in the alphabet (b64:117)
3. **The bytes are equal on S.** Let L = 4k − p, with p ∈ {0, 1, 2}.
   - The stablelib loop (b64:87-99) decodes the full quads before the last group. The tail (b64:100-116) emits 3, 2 or 1 bytes for p = 0, 1, 2. That gives 3k − p bytes, matching `maxDecodedLength` (b64:67-72).
   - Each byte is `(v_a << s) | (v_b >>> t)` truncated to 8 bits. That is the RFC 4648 bit layout with spare trailing bits discarded, which is exactly what forgiving-base64 (`atob`) produces.
   - Neither decoder checks that trailing bits are canonical.
4. **`base64ToBytes`'s guard (D3) accepts exactly S**, so for every secret `parseHookSecrets` returns, its bytes equal stablelib's.

Jest proves the Node half empirically (V2 below: against `Buffer.from(s, "base64")`, over random members of S including non-canonical ones, plus the D7 literal). The Deno half relies on Deno's spec-conformant `atob`, and is proven live for D7 by every GoTrue-signed smoke arm.

### 5. Handler (`index.ts`, outside the block)

- **Delete** lines 47-54: the import comment block and the `import { Webhook } …` line. Replace them with:
  ```
  // No imports (spec 169, security L2): the esm.sh standardwebhooks dependency
  // was removed; the signature is verified by verifyWebhook in the core block.
  ```
- **Delete** `verifySignature` (lines 589-599) entirely.
- **Step 4** becomes the code below. This is the only handler-body change. Steps 1-3 and 5-10, `deliver()`, `logOutcome`, `jsonResponse`, the constants and the env reads stay byte-identical.
  ```ts
      // 4. Standard Webhooks signature: verifyWebhook in the core block (inline
      // WebCrypto HMAC-SHA256, constant-time compare, ±5 min tolerance, every
      // rotated secret). It never throws; any failure, including a signed body
      // that is not JSON, is false → 401.
      const headers = Object.fromEntries(req.headers);
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (!(await verifyWebhook(secrets, body, headers, nowSeconds))) {
        logOutcome({ action, outcome: "rejected", recipients, dropped, reason: "signature" });
        return jsonResponse(401, { error: "invalid signature" });
      }
  ```
- **The AUTH POSTURE paragraph** (lines 11-17) is rewritten as:
  ```
  // AUTH POSTURE — event-driven, NOT a user-invoked privileged op. GoTrue signs
  // each call with a Standard Webhooks signature (SEND_EMAIL_HOOK_SECRET,
  // "v1,whsec_<base64>", "|"-separated for rotation). verify_jwt = false is
  // pinned in config.toml because there is no Supabase JWT; the signature check
  // REPLACES the gateway JWT check and FAILS CLOSED (secret unset or malformed →
  // 500; missing / wrong / stale signature → 401). The signature is verified by
  // an inline WebCrypto (HMAC-SHA256) verifier in the core block (verifyWebhook):
  // constant-time compare, ±300 s tolerance, every rotated secret tried, parity
  // with standardwebhooks@1.0.0 Webhook.verify. The function has NO third-party
  // imports (spec 169), so a deploy bundles only repo code. There is
  // deliberately NO ADMIN_ROLES gate — there is no caller JWT to gate on.
  ```

**Canonical header** (`src/lib/authEmailHook.ts`, outside the block):
- Extend the first paragraph's list with "…delivery-outcome classification (spec 168) and Standard Webhooks signature verification (spec 169)".
- Add to the "free identifiers" paragraph: "It also uses runtime globals that behave identically in Node ≥ 20 (jest) and the Deno 2 edge runtime: `crypto.subtle`, `TextEncoder`, `atob`, `btoa`. Never import node's `crypto` module here; it would shadow the global."

**Export list** (outside the block): add `base64ToBytes`, `timingSafeEqualString`, `signWebhook` and `verifyWebhook` to `export { … }`, and `WebhookHeaders` to `export type { … }`. Do not export `bytesToBase64` or `WEBHOOK_TOLERANCE_SECONDS`. The tests hardcode 300 so that they pin the boundary independently of the constant.

`tests/README.md`: **no change**. Grep confirms no reference to `standardwebhooks` or esm.sh anywhere under `tests/`, `src/` or `scripts/`. CLAUDE.md: no change.

### 6. Toolchain facts (checked; no config change)

#### 6.1 TypeScript
- Installed TypeScript is **5.9.3** (package-lock). Both graphs inherit `lib: ["DOM", "ESNext"]` from `expo/tsconfig.base`. `tsconfig.test.json` adds `types: ["jest", "node"]`.
- `@types/node` 25.5.2 `web-globals/crypto.d.ts:38` (and the encoding globals) defer to the DOM declarations whenever `onmessage` exists, which it does under DOM. So `crypto`, `TextEncoder`, `atob` and `btoa` resolve to the DOM types in both graphs.
- **TS 5.9 gotcha.** In `lib.dom.d.ts:39168`, `BufferSource = ArrayBufferView<ArrayBuffer> | ArrayBuffer`. A bare `Uint8Array` annotation means `Uint8Array<ArrayBufferLike>` and **will not** type-check as `importKey`'s `keyData`. Hence `base64ToBytes(): Uint8Array<ArrayBuffer>`. `TextEncoder.encode` already returns `Uint8Array<ArrayBuffer>` (`lib.dom.d.ts:31824`).
- Babel (jest) and the Deno transpiler both strip the generic.
- **No `lib` or `types` change is needed.**

#### 6.2 jest
- The unit project sets `testEnvironment: 'node'` (`jest.config.js:83`); `src/lib/**/*.test.ts` matches the new file. No docblock is needed.
- `jest-environment-node` 29.7.0 copies every own global of the outer realm into the test context via lazy getters (`build/index.js:54-136`), so `crypto`, `TextEncoder`, `atob` and `btoa` reach the tests. `ArrayBuffer` and `Uint8Array` are deny-listed (`:43-53`), so the context keeps its own realm for them. That is why hard rule 3 (views only) exists.
- CI runs **Node 20** (`test.yml:63`, `:84`, `:106`, `:136`). Node 20 has global `crypto.subtle`, `atob` and `btoa`. Local Node 24 also has them.
- `tests/jest.setup.ts:72-78` only replaces `crypto.randomUUID` on the real crypto object. `subtle` is untouched, and that is not a mock of `crypto.subtle`.
- jest-expo and the react-native jest setup do not touch these globals (grep confirmed).
- Reachability has not been run by the architect (no shell). Test V0 is the first thing the developer runs (§8 step 3).

### 7. Jest matrix: `src/lib/authEmailHook.verify.test.ts` (new, unit project)

**Imports:**
- `createHmac` from `'crypto'`; `fs` and `path` for the static checks
- `base64ToBytes`, `timingSafeEqualString`, `signWebhook`, `verifyWebhook`, `parseHookSecrets` from `./authEmailHook`

**Fixtures:**
- `D7 = 'LOCAL/DEV/ONLY/imr/SendEmailHook/NotForProd/0000'`
- `D7_HEX = '2ce0802ff0c457f38d2d8fe29abfd27a774499a8a51e8a24fcda2d168acfae877fd34d34'`
- `OTHER = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkw'`
- `OTHER2`: any fixed literal accepted by `parseHookSecrets` and distinct from both. The test asserts that it is accepted.
- `ID = 'msg_vector'`, `TS = 1700000000`, `NOW = 1700000000`
- `SIG_AB = 'xqgCspicZv/oSTd9Q1fnDS8JxTgxgn77rND6oyBOui4='`
- `SIG_E = '9tmyMw8kfLRfWKnqherF2jbqNDoM6962K50b8EUjMLE='`

**Oracle (independent).** `oracle(b64, id, tsText, body) = createHmac('sha256', Buffer.from(b64, 'base64')).update(`${id}.${tsText}.${body}`, 'utf8').digest('base64')`. Expectations come only from the oracle or the literals, never from `signWebhook`.

**Helpers:**
- `hdrs(id, ts, sig)` returns `{ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig }`.
- `hex(u)` is `Array.from(u, b => b.toString(16).padStart(2, '0')).join('')`. Compare hex strings, never `Uint8Array`s, because the two realms differ.
- A seeded PRNG (mulberry32, seed `169`) so property failures reproduce. Put the failing input in the assertion, e.g. `expect({ s, got }).toEqual({ s, want })`.

Every verifier assertion uses `await expect(verifyWebhook(…)).resolves.toBe(…)`, which also proves no rejection escapes. "good(ts)" means `'v1,' + oracle(D7, ID, String(ts), '{"a":"b"}')` with body `{"a":"b"}`, unless a row says otherwise.

| ID | Case | Expect |
|---|---|---|
| **V0** | `typeof globalThis.crypto?.subtle?.importKey === 'function'`, plus `sign`, `atob`, `btoa`, `TextEncoder`. If this is red, **stop and return to the architect**; do not mock. | pass |
| **V1.1** | `oracle(D7, ID, '1700000000', '{"a":"b"}') === SIG_AB` (oracle sanity), and `await signWebhook(D7, ID, TS, '{"a":"b"}') === SIG_AB` | equal |
| V1.2 | Same for `{"e":"é—"}` → `SIG_E`; also `Buffer.byteLength(body, 'utf8') === 13` | equal |
| V1.3 | `verifyWebhook([D7], body, hdrs(ID, '1700000000', 'v1,' + SIG), NOW)` for both bodies | true |
| V1.4 | 66-byte key (88 characters, longer than the HMAC block) and 22-byte key (32 characters ending `==`): `signWebhook` equals the oracle, and verify is true | equal / true |
| V1.5 | 300 random cases (key from the V2.1 generator, ASCII id, ts in [1e9, 2e9], body with BMP, astral and multibyte characters): `signWebhook === oracle` | equal |
| **V2.1** | 3000 random members of S: L ∈ {32, 36, …, 88}, p ∈ {0, 1, 2}, (L − p) random alphabet characters + `'='.repeat(p)`. This includes non-canonical trailing bits by construction. Assert: `parseHookSecrets('v1,whsec_' + s)` equals `[s]`; `hex(base64ToBytes(s)) === Buffer.from(s, 'base64').toString('hex')`; decoded length `=== L / 4 * 3 - p` (b64:67-75) | all pass |
| V2.2 | 3000 random strings over the 65-character alphabet (including `=`) of length L ∈ {32 … 88 step 4}. Assert `parseHookSecrets` accepts **iff** `base64ToBytes` does not throw; when accepted, the hex equals Buffer's | all pass |
| V2.3 | `hex(base64ToBytes(D7)) === D7_HEX`; `'A'.repeat(42) + 'B='` (non-canonical) equals Buffer's bytes | equal |
| V2.4 | Throws: `''`, `'A'.repeat(43)`, `'A'.repeat(20) + '=' + 'A'.repeat(23)`, `'A'.repeat(29) + '==='`, `'AAAA AAAA'`, `'AAAAAA'` (unpadded) | throws |
| **V3.1** | ts = NOW − 300 / NOW + 300, each with good(ts) | true / true |
| V3.2 | ts = NOW − 301 / NOW + 301, each with good(ts) | false / false |
| V3.3 | `'abc'` (sig over `'abc'`) → false. `''` → false (missing-header path) | false |
| V3.4 | Replicated leniency: header `'1700000000abc'`, `'+1700000000'`, `'01700000000'`, `'1700000000.9'`, `' 1700000000'`, each with the signature over `'1700000000'` | true |
| V3.5 | Header `'1700000000abc'` with the signature over the raw `'1700000000abc'` | false |
| V3.6 | `'17e8'` (sig over `'17'`); `'1' + '0'.repeat(400)` (Infinity); `'-1700000000'` | false |
| V3.7 | D1: `nowSeconds` = NaN, Infinity, 1700000000.5, or 8.64e12 (with a timestamp equal to it and a valid signature) | false |
| **V4.1** | Missing `webhook-id`; missing `webhook-timestamp`; missing `webhook-signature` (key absent), one case each | false |
| V4.2 | Each of the three set to `''` | false |
| V4.3 | Mixed-case keys `Webhook-Id`, `WEBHOOK-TIMESTAMP`, `Webhook-Signature`, plus unrelated extra headers | true |
| V4.4 | Combined id `'msg_vector, msg_other'` (signature over `msg_vector`) → false. Combined timestamp `'1700000000, 1700000001'` (signature over `1700000000`) → true (replicated) | false / true |
| **V5.1** | `v1,<bad> v1,<good>` → true; `v1,<bad> v1,<bad2>` → false | true / false |
| V5.2 | `v2,<good>`, `v1a,<good>`, `V1,<good>`, `<good>` (no version) | false |
| V5.3 | `v1` (no comma), `v1,` (empty), `v1,!!!notbase64!!!`, `,<good>`, `' '` | false |
| V5.4 | `<good>` with its trailing `=` removed (43 characters) | false |
| V5.5 | `v1,<good> ` (trailing space) and `v1,<bad>  v1,<good>` (double space) | true |
| V5.6 | Lax, replicated: `v1,<good>,extra`; GoTrue multi-secret shape `v1,<good>, v1,<other>` | true |
| V5.7 | Combined duplicate signature header `v1,<bad>, v1,<good>` | true |
| V5.8 | **Non-canonical alias**: `SIG_AB` with its last data character `'4'` changed to `'5'` (same decoded bytes, different string) | false |
| **V6.1** | Rotation `[OTHER, D7]` → true; `[D7, OTHER]` → true | true |
| V6.2 | `[OTHER, OTHER2]` → false; `[]` → false | false |
| V6.3 | Signed with OTHER, verified with `[D7]` (wrong key) | false |
| V6.4 | Throwing secret: `['!!!!', D7]` → true; `['!!!!']` → false; `['', D7]` → true; `['']` → false. None rejects. | as listed |
| V6.5 | **Fail-open guard**: `['!!!!']` with signature header `'v1,'` | false |
| **V7.1** | Tampered body `{"a":"c"}` with the signature over `{"a":"b"}` | false |
| V7.2 | Signed with id `msg_vector`, sent as `msg_vectoR` | false |
| V7.3 | Signed with ts 1700000000, sent as 1700000001 (inside the window) | false |
| **V8.1** | Correctly signed non-JSON bodies `'not json'`, `''`, `'{"a":'` (the 401 decision) | false |
| V8.2 | Correctly signed `'{}'`, `'null'`, `'[]'`, `'1'` (these reach step 5 and get 400) | true |
| V8.3 | `[OTHER, D7]` with a correctly signed non-JSON body | false |
| **V9** | `timingSafeEqualString`: equal → true; same length but different → false; different length → false; `'é'` vs `'e'` → false | as listed |
| **S1** | Static, `index.ts`: no line matches `/^\s*import[\s{*]/`, no `import(`, no `'npm:` / `"npm:` / `jsr:`. Every line containing `standardwebhooks` or `esm.sh` is a `//` comment line. No `verifySignature`, no `new Webhook(`. | pass |
| **S2** | Static, the canonical core block (same extraction rule as the parity test: lines strictly between the markers): no `Date.now`, no `new Date(`, no `subtle.verify`, no `require(`. The block contains `async function verifyWebhook(`. | pass |

`authEmailHook.test.ts`, `authEmailHook.golden.test.ts`, `authEmailHook.parity.test.ts` and `authEmailHook.golden.json` are **not modified**.

### 8. Build and verify order (developer)

1. **Pre-edit.**
   - Confirm the spec 168 commit has landed. Record `git rev-parse HEAD` (and `git log -1 --oneline`) in the implementation notes as the baseline.
   - `git diff --quiet HEAD -- src/lib/authEmailHook.ts supabase/functions/auth-email-hook/index.ts src/lib/authEmailHook.golden.json`, and the same with `--cached`; both must be clean.
   - `shasum -a 256 src/lib/authEmailHook.golden.json` must equal `cb33ffb0…1b14`.
2. Show the owner a file-by-file plan and get approval.
3. Create the new test file with **V0 only**, then run `npx jest src/lib/authEmailHook.verify.test.ts`. If it is red, stop and return to the architect.
4. Edit the canonical block and export list (§3, §5). Write the full V/S matrix. Run `npx jest src/lib/authEmailHook.verify.test.ts`.
5. Splice the canonical block into `index.ts` mechanically (spec 168 §1.5: replace the lines between the markers with a script; no retyping). Then make the `index.ts` edits outside the block (§5).
6. Run `npx jest src/lib/authEmailHook`. All four suites must be green: parity unmodified, golden unmodified, test, verify.
7. Run the **full** `npx jest`.
8. Run `npm run typecheck`, then `npm run typecheck:test`.
9. Do the CLAUDE.md bind-mount check (`docker inspect … | grep functions` must show the repo root). If needed, hot reload or `docker restart supabase_edge_runtime_imr-inventory`. The edge logs must show the boot with no module-resolution error. `curl -X POST` unsigned must give 401 `{"error":"invalid signature"}`.
10. `bash scripts/smoke-send-email-hook.sh` must print **ALL ARMS PASSED**. The only SKIP is S8.
11. Then `npm run test:smoke`, which must be green.
12. Then the probe, locally:
    - the env path gives 200 `{}` and one "Account notification"
    - a wrong but well-formed secret gives 401 and the hint

    Steps 10-12 run **strictly sequentially**, never alongside a spec 167 smoke.
13. **Post-checks** (all must be clean):
    - `git diff --exit-code -- src/lib/authEmailHook.golden.json`, with the sha256 unchanged
    - `git diff HEAD -- supabase/config.toml src/lib/authEmailHook.parity.test.ts src/lib/authEmailHook.test.ts src/lib/authEmailHook.golden.test.ts scripts/ tests/README.md` (empty)
    - review `git diff HEAD -- supabase/functions/auth-email-hook/index.ts`: the only non-block hunks are the header, the import note, the `verifySignature` removal and step 4
14. Stage only these four paths and **never commit**:
    - `src/lib/authEmailHook.ts`
    - `supabase/functions/auth-email-hook/index.ts`
    - `src/lib/authEmailHook.verify.test.ts`
    - this spec

    Do not stage, unstage, restore or touch any spec 167 path.

### 9. Risks and tradeoffs

1. **Hand-rolled crypto on the only gate.** Mitigations:
   - semantics pinned line by line to the library source (§1)
   - every divergence fail-closed and listed (§2.6)
   - `subtle.verify` rejected because it is laxer (§2.3)
   - independent `node:crypto` oracle plus the openssl-agreed literals
   - static bans (S2)
   - security-auditor review

   Any laxer-than-library finding is Critical.
2. **The fail-open initializer trap** (`expected = ""`). Closed by the `null` sentinel, hard rule 1, and V6.5.
3. **Cross-realm buffers in jest.** Passing a context-realm `ArrayBuffer` to Node's subtle fails its prototype check. Hard rule 3 (views only) avoids it, and V0/V1 prove it on CI's Node 20.
4. **TypeScript generics.** `Uint8Array<ArrayBuffer>` needs TS 5.7 or later. The lock pins 5.9.3, while `package.json`'s `^5.3.0` floor is nominal. A downgrade below 5.7 would fail typecheck loudly, not silently.
5. **Node vs Deno runtime parity.** On S, `atob`, `btoa`, `TextEncoder`, `parseInt` (V8 in both runtimes) and WebCrypto HMAC (RFC 2104 in both) behave the same. Jest proves Node. The GoTrue-signed smoke arms S1-S4, S6b and S9 prove Deno, for the D7 key only.
6. **Code outside the block is type-checked nowhere** (no local deno, and `supabase/functions` is excluded). Step 4 is one call. Smoke S5 (401s, signed `{}` → 400) and every signed or GoTrue arm prove it live.
7. **Timing.** The number of secrets and candidates is observable. That is public, and the same as the library. The per-candidate compare is constant time.
8. **GoTrue format claims** (`%d` timestamp, `", "` join) are recalled, not re-verified. Neither decision depends on them, because both replicate the library.
9. **Prod.** There is no deploy in this spec. Prod acceptance is the owner's spec 166 runbook step 5b probe and then step 5 (real GoTrue).
   - Side benefits: no esm.sh fetch at deploy (closes spec 166 risk 9 / spec 168 risk 8), and a smaller bundle.
   - Cold start is unchanged or better. Per-request cost is one `importKey` and one `sign` per secret, in microseconds.
10. **Shared Mailpit.** Steps 10-12 run sequentially, never alongside a spec 167 session.
11. No migration, RLS, realtime publication, `db.ts` or store impact.

### 10. Expected files changed
- `src/lib/authEmailHook.ts`: core block (verifier group), export list, header
- `supabase/functions/auth-email-hook/index.ts`: identical core block, import removed with a short note, `verifySignature` removed, step 4, AUTH POSTURE paragraph
- `src/lib/authEmailHook.verify.test.ts`: new
- `specs/169-auth-email-hook-inline-verifier.md`: implementation notes and files changed

Not changed: `supabase/config.toml`, `authEmailHook.parity.test.ts`, `authEmailHook.test.ts`, `authEmailHook.golden.test.ts`, `authEmailHook.golden.json`, both scripts, `tests/README.md`, `CLAUDE.md`, and every spec 167 path.

## Implementation notes

Backend developer, 2026-10-22.

**Baseline.** `3508960de534e874a8d7084eb4ccfb4a48d62ce2` (`3508960 Spec 168: auth-email-hook follow-ups (renderMail split, deliver(), S10/S9 smoke, probe HMAC via node)`). Pre-edit checks were clean: `git diff --quiet HEAD` and `--cached` for `authEmailHook.ts`, `index.ts` and `authEmailHook.golden.json`, and the golden sha256 was `cb33ffb0…1b14`. The owner approved the plan in chat ("build spec 169"), so the §8 step 2 plan-approval stop was skipped as instructed.

**Order followed (design §8).**
1. **V0 first.** A V0-only `authEmailHook.verify.test.ts` was green on local Node 24.14.1 (`crypto.subtle.importKey` / `sign`, `atob`, `btoa`, `TextEncoder` all reachable; no mock or polyfill). Node 20 isn't installed locally, so CI `test.yml` (Node 20) is the Node 20 proof.
2. **Core block.** The §3 verifier group was added to the canonical block directly after `parseHookSecrets` and before `isLocalDevSecret`. It follows the §3 pseudocode line for line:
   - the D1 clock guard comes first
   - headers are lowercased into a `Map`
   - the `null` sentinel for `expected` (never `""`)
   - a per-secret try/catch around `signWebhook`, plus an outer try/catch
   - `JSON.parse(body)` runs only after the first match
   - only typed-array views go to `crypto.subtle` (`base64ToBytes(): Uint8Array<ArrayBuffer>` and `TextEncoder.encode`)
   - no `Date.now`, `new Date(`, `subtle.verify` or `require(` in the block
   
   The comments were checked against the parity (b) word traps. The export list gained `base64ToBytes`, `timingSafeEqualString`, `signWebhook`, `verifyWebhook` and the type `WebhookHeaders`; `bytesToBase64` and `WEBHOOK_TOLERANCE_SECONDS` are not exported. The canonical header gained the §5 lines.
3. **Matrix.** The full V0-V9 + S1/S2 matrix was written. Before the `index.ts` edit, S1 was red on the live `import { Webhook } …` line (red-before-green proof); everything else was green.
4. **Splice.** A node script (scratchpad only, not in the repo) replaced the lines strictly between the `index.ts` markers with the canonical lines; nothing was retyped. `diff` of the two marker ranges is empty.
5. **`index.ts` outside the block.**
   - the AUTH POSTURE paragraph was rewritten as in §5
   - lines 47-54 (the import comment block and the `import`) were replaced by the two-line spec 169 note
   - `verifySignature` was deleted
   - step 4 now builds `nowSeconds = Math.floor(Date.now() / 1000)` and awaits `verifyWebhook(...)`, with the same `logOutcome(... reason: "signature")` and `jsonResponse(401, { error: "invalid signature" })`
   
   `git diff HEAD` shows exactly five hunks: the header, the import note, the block insert, the `verifySignature` removal and step 4.

**No deviations from the design.** Two small additions within the design's latitude:
- The V6.5 case also covers `['', '!!!!']` with header `'v1, v1,'`.
- V3.6 also covers the Infinity header signed over its own raw text.

Both expect `false`.

**Verification (all green).**
- `npx jest src/lib/authEmailHook`: 4 suites (verify, test, golden, parity) and 187 tests passed. Parity, golden and `authEmailHook.test.ts` are unmodified.
- Full `npx jest`: 234 suites and 2846 tests passed, 2 snapshots.
- `npm run typecheck` and `npm run typecheck:test`: clean, with no tsconfig or jest-config change.
- Bind-mount check: `/host_mnt/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions` (the repo root).
- `docker restart supabase_edge_runtime_imr-inventory` was run to force-load the edited file, after confirming no other smoke was running. The boot logs (edge-runtime 1.73.13, Deno 2.1.4) show no module-resolution error and no esm.sh download. An unsigned POST gives 401 `{"error":"invalid signature"}` with log `reason:"signature"`.
- `bash scripts/smoke-send-email-hook.sh` (unmodified) exited 0 with **ALL ARMS PASSED**: 72 PASS and 0 FAIL. The only SKIP is S8. The S9 redemption ran, and all S5 signature-gate arms passed (no headers → 401, wrong signature → 401, now−600 s → 401, GET → 405, signed `{}` → 400, signed empty → 400, oversize → 413, Mailpit 0). Every GoTrue-signed arm passed (S1-S4, S6b, S9), which is the live Deno proof that GoTrue's real D7 signatures verify.
- `npm run test:smoke` exited 0, with "ALL ARMS PASSED" / "all checks passed" for each script and 0 FAIL. Its SKIPs are environmental and unrelated to this spec: no `BOBBY_TOKEN`, an unset local `USERNAME_RESOLVE_SERVICE_TOKEN`, and S8.
- Probe (`scripts/probe-auth-email-hook.sh`, unmodified), run locally against `http://127.0.0.1:54321/functions/v1/auth-email-hook`:
  - with the D7 secret: 200 `{}`, exit 0, and exactly one "Account notification" in Mailpit for the probe address
  - with a wrong but well-formed secret (`OTHER`): 401 plus the "HOOK_SECRET differs" hint, exit 1, and 0 mails
- The smokes and probe ran strictly one after another, with no concurrent spec 167 smoke (checked with `ps` before starting). There were no 429s.
- Post-checks:
  - `git diff --exit-code -- src/lib/authEmailHook.golden.json` is clean and the sha256 is still `cb33ffb0412ac48b3633b40eb212ecf53b76eb2da20764a597e7a06ffaee1b14`
  - `git diff HEAD` is empty for `supabase/config.toml`, the parity, test and golden test files, both auth-email-hook scripts, `tests/README.md`, `CLAUDE.md` and `app.json`
  - `grep -n "esm.sh\|standardwebhooks" supabase/functions/auth-email-hook/index.ts` matches only comment lines (19, 51 and the block comment at 466)

**Open items for reviewers / owner.**
- The Node 20 run of V0/V1 happens on CI only (there is no local Node 20).
- Prod acceptance is unchanged: there is no deploy in this spec. The owner's spec 166 runbook steps 4/5b/5 are the first prod proof.

### Pre-commit fixes (release proposal §A)

Backend developer, 2026-10-22. Scope as approved by the owner: A1, the recommended A2 nits, and A3. The baseline for every diff below is the staged (reviewed) content, snapshotted to the scratchpad before the first edit.

**A1 (core block, comments plus one constant).**
- Why-comments added at `parseInt(msgTs, 10)`, at the lax candidate loop, and at the post-match `JSON.parse`.
- The `verifyWebhook` doc comment is now a summary, a bullet list of the acceptance conditions, a bullet list of the three replicated quirks (parseInt timestamp, lax commas, non-JSON → 401), and the fail-closed divergence rule.
- `8.64e12` is now the unexported `const MAX_DATE_SECONDS = 8.64e12;`, declared next to `WEBHOOK_TOLERANCE_SECONDS` and commented as "the JS Date range in seconds". The guard is still `MAX_DATE_SECONDS - WEBHOOK_TOLERANCE_SECONDS`, i.e. exactly `8.64e12 - 300`. The guard `if` is wrapped across lines in the same style as the header check, with the same tokens.

**A2 (nits).**
- Block: "Standard Webhooks verification (spec 169)" is now a divider-style section header for the verifier group, and `WEBHOOK_TOLERANCE_SECONDS` has its own one-line comment. The locals are renamed `h` → `lowered` and `c` → `candidate`.
- `index.ts` step 4: "±5 min" → "±300 s".
- Test file:
  - The two invisible `bodyChars` entries are now `' '` and `' '`, the only invisible characters actually present. The values are unchanged, so the PRNG sequence is unchanged too.
  - `ALPHABET_CHARS` and `idChars` are hoisted out of the per-character loops.
  - A comment above the V1.5 `expect` explains the inputs-on-both-sides idiom.
  - The V3.7 title cites "spec 169 §2.6 clock guard".
- Optional rows added: V3.8 (architect M3: clock `8.64e12 - 300` with a matching ts and a valid signature → true; one second past it → false), V4.2b (architect M2: explicit `undefined` value for each header → false), and V4.3b (header keys differing only in case, last-wins in both orders).
- Not done, as instructed: the early return on empty candidates and the `signWebhook` rename.

**A3 (S1 hardening, test-only).** S1 now also asserts that no non-`//` line of `index.ts` matches `/\bfrom\s*['"]/`, and that the source does not match `/\bimport\s*\(/`. There is no bare `https://` check (`RESEND_API_URL`). Red-before-green was run in the scratchpad only, with the real test files run against mirror trees through a scratchpad-only jest config:

| tree | test | result |
|---|---|---|
| index.ts + `export { x } from "https://evil.example/mod.ts";` | old S1 | green (the gap) |
| same | new S1 | red, `fromSpecifier: true` on the injected line |
| index.ts + `const m = await import ("https://evil.example/mod.ts");` | old S1 | green (the gap) |
| same | new S1 | red, `not /\bimport\s*\(/` |
| clean index.ts | new S1 | green |

**Behaviour-neutral proof.**
- Word traps: the block has no `export`, `Deno.`, `fetch(`, `console.`, placeholder domain, `Date.now`, `new Date(`, `subtle.verify` or `require(`.
- Token compare: stripping comments and whitespace from the baseline and new blocks, then applying only the approved substitutions to the baseline (the constant, the two renames and the guard brace normalisation), gives identical code.
- Outside the block, `index.ts` differs from the baseline only on the step 4 comment line.

**Re-splice.** Done with the same scratchpad splice script (632 block lines, previously 589). The `diff` of the two marker ranges is empty.

**Re-verification (all green).**
1. `npx jest src/lib/authEmailHook`: 4 suites and 190 tests passed (187 plus the 3 new rows). The parity test, the golden test, `authEmailHook.test.ts` and the golden fixture are unmodified, and the golden sha256 is still `cb33ffb0412ac48b3633b40eb212ecf53b76eb2da20764a597e7a06ffaee1b14`.
2. Full `npx jest`: 234 suites and 2849 tests passed.
3. `npm run typecheck` and `npm run typecheck:test`: clean.
4. The bind mount is `/host_mnt/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions`, and the container sees the edited file (`MAX_DATE_SECONDS` present). `ps` showed no smoke running, so `docker restart supabase_edge_runtime_imr-inventory` was run. An unsigned POST then returned 401 `{"error":"invalid signature"}`.
5. `bash scripts/smoke-send-email-hook.sh`, run alone (`ps` checked first), exited 0 with **ALL ARMS PASSED**: 72 lines containing PASS (71 arm PASS lines plus the banner), 0 FAIL, and S8 as the only SKIP.

## Files changed

**Edge functions**
- `supabase/functions/auth-email-hook/index.ts`: the core block re-spliced byte-identical with the verifier group; esm.sh `import` removed and replaced with the spec 169 note; `verifySignature` removed; step 4 awaits `verifyWebhook(secrets, body, headers, nowSeconds)`; AUTH POSTURE paragraph rewritten.

**src/lib (jest canonical)**
- `src/lib/authEmailHook.ts`: verifier group in the core block (`WEBHOOK_TOLERANCE_SECONDS`, `MAX_DATE_SECONDS`, `WebhookHeaders`, `base64ToBytes`, `bytesToBase64`, `timingSafeEqualString`, `signWebhook`, `verifyWebhook`); export-list additions; header lines.

**Tests (jest, unit project)**
- `src/lib/authEmailHook.verify.test.ts`: new; the V0-V9 + S1/S2 matrix from design §7, plus V3.8 / V4.2b / V4.3b and the hardened S1 from the pre-commit fixes.

**Specs**
- `specs/169-auth-email-hook-inline-verifier.md`: status, implementation notes, files changed.

Not changed: `supabase/config.toml`, `src/lib/authEmailHook.parity.test.ts`, `src/lib/authEmailHook.test.ts`, `src/lib/authEmailHook.golden.test.ts`, `src/lib/authEmailHook.golden.json`, `scripts/smoke-send-email-hook.sh`, `scripts/probe-auth-email-hook.sh`, `tests/README.md`, `CLAUDE.md`, `app.json`, and every spec 167 path.

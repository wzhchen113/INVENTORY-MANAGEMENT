# Security audit for spec 055

Scope: FE-only change introducing a global in-flight counter, AbortController-based
30s hard timeout, 5s soft-warning, top-bar progress indicator, and shimmer
skeletons. No migrations, no RLS, no edge function diffs, no new network
endpoints. Threat model is correspondingly narrow — the highest-severity
failure mode is the write-abort toast copy misleading an admin into re-issuing
a destructive RPC that already committed server-side.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low / Nits

- `src/lib/inflight.ts:146-148` — Dev-only `console.warn` includes `opts.label`
  and `opts.kind`. Both are hardcoded constants declared at each `db.ts` call
  site (`'fetchInventory'`, `'createInventoryItem'`, etc., per
  `src/lib/db.ts:56-1386`) — not user/server-controlled. The warning is gated
  on `process.env.NODE_ENV !== 'production'` so it never ships to a live build.
  No remediation needed; flagging only because the dispatching prompt asked
  explicitly about log payloads. No PII / no session data / no bearer in the
  output.

## Findings against the six sweeps in the dispatching prompt

### 1. Timeout misuse hiding partial writes (the load-bearing check)

PASS. Verified byte-for-byte:

- `src/lib/inflight.ts:72` write copy matches `specs/055-global-loading-indicator.md:34` and `:427` exactly:
  `Request timed out — the change may or may not have been saved. Refresh to verify.`
- `src/lib/inflight.ts:73` read copy matches `specs/055-global-loading-indicator.md:33` and `:428` exactly:
  `Request timed out — please try again.`

Em-dash (`—`, U+2014) is the same character in all locations. The write copy
preserves the mandated "may or may not have been saved" hedging — there is no
weaker variant ("cancelled" / "failed" / "rolled back") anywhere in the
wrapper. Jest tests at `src/lib/inflight.test.ts:227, 260, 299, 307` lock both
strings in CI.

The `InflightTimeoutError.kind` is propagated faithfully from the per-call-site
declaration at the `track()` invocation in `db.ts` — no runtime inference,
matching spec A5. A spot-check of `kind` classifications in `db.ts:56-1386`
shows the rule-of-thumb is applied correctly:

- `fetchStores`, `fetchInventory`, `fetchRecipes`, etc. are `kind: 'read'`.
- `createStore`, `deleteStore`, `createInventoryItem`, `updateInventoryItem`,
  `submitEODCount`, etc. are `kind: 'write'`.
- Mixed read-then-write bodies (e.g. `updateInventoryItem` at db.ts:251 reads
  `catalog_id` then updates) are declared `'write'` per the spec's safer-copy
  rule.

No path produces a `'read'` toast for a body that performs a mutation. No
crossed wires.

### 2. AbortController leak / re-use

PASS. Verified at `src/lib/inflight.ts:96` — every `track()` call constructs a
fresh `new AbortController()` inside the function, never shared across calls.
`warnTimer` and `abortTimer` are closure-locals; cleared in the `.finally()`
block at lines 154-155 regardless of resolve / reject / abort. The cleanup
also decrements `_activeCount` and conditionally `_slowCount` in a single
atomic `set()` at lines 156-165.

Idempotency edge cases reviewed:

- An already-aborted signal triggers the early-throw at `src/lib/inflight.ts:100-102`
  BEFORE the counter increment, so the leak path is closed by construction.
- A native rejection from the inner promise (non-abort) at line 152 bubbles
  unchanged through `.finally()`. Counter still decrements.
- The `_slowCount` decrement guard at line 158 (`warnFired ? ... - 1 : ...`)
  is correct: if the call resolves under 5s, the warn timer was cleared and
  `_slowCount` was never incremented, so the decrement is correctly skipped.

The two-test pair at `src/lib/inflight.test.ts:153-166` ("fast call never
flips hasSlow") and `:274-288` ("timers cleared cleanly when inner resolves
before timer") guards this regression.

### 3. Auth / session implications

PASS. Neither `src/lib/inflight.ts` nor any wrapper invocation in
`src/lib/db.ts` touches `supabase.auth.*`. The AbortController is plumbed
exclusively through:

- `PostgrestBuilder.abortSignal(signal)` — cancels the in-flight HTTP fetch
  but does NOT mutate session storage or refresh tokens.
- `FunctionInvokeOptions.signal` — same, for the one wrapped edge-function
  call at `src/lib/db.ts:1369-1372`.

Aborting either rejects the wrapped promise without touching the
GoTrue / supabase-js session refresh queue (managed independently in
`@supabase/gotrue-js`). No half-refreshed token state is reachable from this
code path.

No `Authorization` header, bearer token, or session object is read, logged,
stored, or transmitted by the new module. Grep for `token|session|bearer|jwt|password|secret|api_key|access_token` in `src/lib/inflight.ts`, `src/components/cmd/LoadingBar.tsx`, `src/components/cmd/ListSkeleton.tsx`, `src/components/cmd/GridSkeleton.tsx` returns zero matches.

### 4. DoS / resource exhaustion

PASS. Each `track()` call allocates exactly two `setTimeout` handles, both
explicitly `clearTimeout`'d in the `.finally()` block at
`src/lib/inflight.ts:154-155`. Path coverage:

- Inner promise resolves → `.finally()` clears both timers.
- Inner promise rejects (server / network) → `.finally()` clears both timers.
- 30s abort fires → `clearTimeout(abortTimer)` is a no-op on a fired timer
  (well-defined behavior); `warnTimer` already fired ~25s earlier and is
  also a no-op clear. `.finally()` still runs.

Worst case: ~65 `db.ts` exports × bursty fanout from `fetchAllForStore`
yields ~15 concurrent timer pairs (30 active `setTimeout` handles) for the
peak ~200-500ms before fetches return. Negligible.

The "buggy counter never decrements" path is closed by the unconditional
`.finally()`. Counter math regression coverage:
`src/lib/inflight.test.ts:58-117` exercises increment-on-entry,
decrement-on-resolve, decrement-on-rejection, and the two-call concurrent
case explicitly.

### 5. Toast content escaping

PASS. `InflightTimeoutError.message` is constructed from string literals
only — no interpolation, no concatenation of caller-provided or
server-controlled data. The class at `src/lib/inflight.ts:66-79` accepts
`kind` and `label` as constructor args but does not embed `label` in the
message; only `kind` selects between the two hardcoded literal strings.

The downstream flow:

1. `track()` throws `InflightTimeoutError` (line 150).
2. The wrapped `db.ts` call propagates the throw to the calling action in
   `src/store/useStore.ts`.
3. The action's existing `.catch(e => notifyBackendError('<action>', e))`
   fires.
4. `notifyBackendError` at `src/store/useStore.ts:27-36` reads
   `e?.message || String(e)` and routes through `Toast.show({ text1, text2 })`.
5. `react-native-toast-message` v2.3.3 renders `text1`/`text2` through React
   Native `<Text>` components — plain text, never `dangerouslySetInnerHTML`.

No path lets a server-controlled `error.message` reach the abort copy: the
discriminator `ctrl.signal.aborted` at line 141 only flips true when the
30s timer ran; in that case the wrapper REPLACES the original error with
the typed `InflightTimeoutError`, discarding any server-controlled `e.message`
that may have arrived in the same catch tick. The non-abort branch at line
152 re-throws the original `e` unchanged, which is the same behavior the
codebase has always had — no new exposure surface.

### 6. Other OWASP-style sweeps

PASS / N/A.

- No new SQL — confirmed by `git status` listing only TS/TSX files and one
  spec markdown.
- No new HTML rendering — toasts and bar/skeleton use React Native primitives.
- No new auth boundary — the wrapper is a synchronous Zustand store, no
  network of its own.
- No new SSRF / path traversal surface — abort is wired into existing
  supabase-js builders only, no new URL construction.
- CORS / cookies / CSRF — unchanged.
- File uploads — unchanged.
- The injected `<style>` tag in `src/components/cmd/LoadingBar.tsx:43-64`
  and the parallel ones in `ListSkeleton.tsx:28-48` / `GridSkeleton.tsx:22-40`
  contain only hardcoded CSS keyframes — no user data interpolated. The
  `style.id` and `KEYFRAME_NAME` are module-scoped constants. Idempotent
  insertion is guarded by both the module-scoped flag and a
  `document.getElementById` re-check, so multiple mounts don't accumulate
  `<style>` nodes. Not a CSS-injection surface.

## Dependencies

`package.json` changed only the version field (`1.0.0 → 2.4.0`) — no
dependency adds, removes, or version bumps. `npm audit` skipped.

## Conclusion

No Critical, No High, No Medium. One Low (dev-only console.warn observation,
no remediation needed). The two spec-mandated copies are present byte-for-byte
and locked in CI by jest assertions, which is the single highest-risk failure
mode of the feature. The AbortController plumbing is correct, the counter
math is leak-free, and no auth / session surface is touched.

Spec 055 is safe to ship from a security standpoint.

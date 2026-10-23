## Security audit for spec 168

Scope: the staged diff against baseline `227436c` for `supabase/functions/auth-email-hook/index.ts`, `src/lib/authEmailHook.ts`, `src/lib/authEmailHook.test.ts`, `src/lib/authEmailHook.golden.test.ts`, `src/lib/authEmailHook.golden.json`, `scripts/smoke-send-email-hook.sh`, `scripts/probe-auth-email-hook.sh` and `tests/README.md`. Spec 167 paths were ignored. No working-tree drift from the index on these paths. `supabase/config.toml` is unchanged: `[functions.auth-email-hook] verify_jwt = false` at `supabase/config.toml:505-506`. I did not run the Mailpit smokes, as instructed.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `scripts/probe-auth-email-hook.sh:64,78-80,99`: if `SECRET` or `KEY_HEX` is already exported in the owner's shell, it stays exported here. Bash keeps the export attribute when a variable inherited from the environment is reassigned. I confirmed this with `export SECRET=pre; SECRET=...; env | grep ^SECRET=`, which still prints the variable. The effects:
  - A pre-exported `SECRET` puts the raw `v1,whsec_…` value into the environment of the `openssl`/`od`/`tr` children on line 78.
  - A pre-exported `KEY_HEX` puts the decoded key into `node`'s environment on line 99. That contradicts the header's claim at lines 29-30.

  This existed before the spec: the baseline's `openssl` children had the same exposure. Spec 168 does not newly place key material in any child's environment. On macOS, another user cannot read a process's environment without root, so only the same user is exposed. It needs an unusual pre-existing export, and `SECRET` is a generic name some shells do export. Fix (one line, no behaviour change): run `unset SECRET KEY_HEX` before line 64. `unset` drops the export attribute, so the later assignments create non-exported shell variables.
- `supabase/functions/auth-email-hook/index.ts:54` (item 5, residual, unchanged from spec 166): the verifier still loads from esm.sh at deploy time with no integrity lock on esm.sh's build output. If esm.sh were compromised, it could serve a `Webhook.verify` that accepts forged signatures. That would let anyone who can reach the function URL trigger brand-domain auth mails (phishing), since `verify_jwt = false` makes the signature the only gate. This is accepted risk carried over from spec 166, not a regression. The architect's §5 "facts for a future spec" option is the real fix: an inline Standard Webhooks verifier using WebCrypto HMAC, a constant-time compare and the ±5 min tolerance, parity-tested like the core, with no third-party code on the auth path. That needs its own spec and security review.

### Verification of the requested properties

**1. The refactor stays fail-closed (index.ts).**
- **Gate order is unchanged.** The diff hunks touch only the import comment (`:47-54`), the core block, the new `deliver()` (`:601-629`) and step 9 (`:717-723`). Steps 1-8 and 10 are byte-identical to the baseline:
  - method (`:637`)
  - secret fail-closed (`:643`)
  - size before HMAC (`:651-661`)
  - signature (`:664-668`), before any parse, render or transport
- **A transport failure gives 500.** Every `!result.ok` returns `jsonResponse(500, { error: "delivery failed" })` (`:719-722`).
- **No 200 for an undelivered real recipient.**
  - `deliver()` returns `{ ok: true }` only after every leg's `classifyDelivery({kind:"status"})` returned ok. That requires `isTransportSuccess`, which is unchanged at 200-299 (`:536-538`).
  - The only other 200 is step 7, where all legs are placeholders (`:697-701`), and it is untouched.
  - `deliver()` is never reached with zero mails.
- **The core render logic is equivalent.**
  - `resolveLinkAndCode` (`:352-366`) matches the baseline branch by branch:
    - signup/invite with an empty hash → null
    - other types with an empty hash → code only
    - a null base or redirect → null
    - code is blanked for linkOnly
  - `renderBody` (`:369-412`) is the baseline body moved verbatim. I diffed it against `227436c`, and the only differences are the function boundary and `p.user.new_email` → `newEmail`.
  - Every HTML interpolation still goes through `escapeHtml`: intro, link (twice), label, code and footer.
  - The two copies of the core block are byte-identical (awk extraction plus `diff`).
- **Log hygiene is unchanged; no new logged fields.**
  - `logOutcome` (`:569-587`) is untouched and still builds the line from the fixed key set in fixed order.
  - The throw rows pass `status: result.status`, which is `undefined`. `logOutcome` drops it, because it only adds `status` when `typeof === "number"`. So throw-path lines still carry no `status` key, as in the baseline.
  - `classifyDelivery` receives only the error *name* and never logs it. Only the `reason` enum is logged.
  - The core block adds no `console.` calls (parity test (b)).

**2. `deliver()` cannot let an unexpected throw escape or change a status.**
- A `buildTransportRequest` throw (`:607`) rejects `deliver()`'s promise. The handler awaits it inside the outer `try` (`:718`), so it lands in the catch-all: 500 `internal error` with no `reason`, the same as the baseline.
- The network call's throw is caught (`:616-618`). The `e instanceof DOMException ? e.name : ""` conversion keeps the baseline semantics: a non-DOMException named `TimeoutError` is still `transport`.
- A `body.cancel()` throw is swallowed (`:620-624`), as in the baseline.
- `classifyDelivery` is pure, total over its union, and cannot throw (`:547-555`).
- The first failure returns right away, so remaining legs are not sent.
- The `Idempotency-Key` input is `webhookId + ":" + i`, unchanged.

**3. The probe HMAC (`scripts/probe-auth-email-hook.sh`).**
- **No key material on any argv.**
  - The secret travels by `printf` (a bash builtin) into `openssl base64 -d -A` on stdin (`:78`).
  - The decoded hex travels by builtin `printf` into `node -e "$HMAC_JS"` on stdin (`:99`).
  - `HMAC_JS` (`:91-98`) is a fixed literal with no interpolation, so node's argv holds only the script text.
  - `-macopt` and `hexkey` are gone from the file.
- **Environment.** `HOOK_SECRET` is unset as soon as it is copied (`:65`). `SECRET` and `HOOK_SECRET` are unset before node runs (`:80`), and `KEY_HEX` right after (`:100`). This is subject to the pre-exported-variable Low above.
- **A non-decodable secret is still refused.** The decode is byte-unchanged and still openssl, and `die "HOOK_SECRET did not base64-decode"` still exits 2 (`:78-79`). Node's lenient base64 is never used. Node additionally rejects an empty, non-lowercase-hex or odd-length key line with exit 2 and empty stdout, and the new `[[ -n "$SIG" ]]` guard (`:101`) refuses rather than sending `v1,`.
- **No echo of secrets.**
  - No `die`/`printf` path prints `SECRET`, `KEY_HEX` or `SIG`.
  - A node exception would print source text, not stdin values.
  - `read -rs` stays no-echo.
- **Independent cross-check.** I compared node and `openssl dgst -sha256 -mac HMAC -macopt hexkey:` on 3 random keys with non-ASCII messages, and the outputs were identical. A bad key line and empty stdin both give exit 2 with nothing on stdout.
- **Trust of `node`.** Node is resolved from `PATH`, the same posture `openssl` already had. It is not a new trust boundary.

**4. The golden fixture holds no real secrets (`src/lib/authEmailHook.golden.json`).**
- It has 52 cases. The tokens are `123456`, `111111` and `222222`. The hashes are `hash-main`, `hash-for-new`, `hash-for-current` and `pkce_a/b+c=`.
- The addresses are `@example.com`, plus synthetic spec 165 placeholders. The user id is all zeros.
- The hosts are `abc.supabase.co`, `kong:8000`, `127.0.0.1`, `localhost` and `*.example.com`.
- A scan found no `whsec_`, JWT (`eyJ…`), `re_`/`sk_` key shapes, the prod project ref, `service_role` or `SUPABASE_*` env names. The `password` hits are only the `/reset-password` redirect path and the action-type names.
- Capture mode refuses under `CI` and refuses to overwrite (`authEmailHook.golden.test.ts:211-217`).

**5. The item 5 fallback (esm.sh `?deps=` pin) is sound.**
- Without a lock that is proven to be honoured, `npm:standardwebhooks@1.0.0` would let `@stablelib/base64 ^1.0.0` and `fast-sha256 ^1.3.0` float at bundle time. That is weaker than the current exact `?deps=` pin, and it would void spec 166's fix-1 fuzz evidence against `@stablelib/base64@1.0.1`.
- The import line is byte-unchanged (`index.ts:54`). Only the comment changed (`:50-53`).
- There is no `deno.json`, `deno.lock` or `config.toml` change, and nothing was installed.
- The remaining CDN-integrity risk is the second Low above, unchanged from the baseline.

**Smoke script (`scripts/smoke-send-email-hook.sh`), for completeness.**
- **S10.** It is local-only, since the script refuses remote. `remember` registers `not-an-address` and the S10 hash/code, so S7's leak scan covers the fail-closed path. `SEND_EMAIL_FROM` is not a secret. The `MP_CODE` passed to `jq --argjson` comes from curl's `%{http_code}` and is guarded by the precondition branch.
- **`S9_AUTOCONFIRM_OVERRIDE`.** It only reduces coverage, it is printed whenever it is used, and `test:smoke` (`package.json:18`) does not set it.

### Dependencies
No `package.json` or lockfile changes. `npm audit` skipped. The Deno-side dependency, `standardwebhooks@1.0.0` with pinned deps on esm.sh, is unchanged; see the second Low.

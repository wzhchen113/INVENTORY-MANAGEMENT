## Security audit for spec 027

Scope: 5-file change set.

- `supabase/functions/send-invite-email/index.ts` — Track A (one-line + 4-line comment).
- `scripts/smoke-edge-roles.sh` — new.
- `package.json` — `test:smoke` chain only.
- `CLAUDE.md`, `.claude/agents/security-auditor.md` — strictly-additive prose.

I verified the strict-superset claim, JWT-vs-profiles parity, smoke-script secret hygiene and state-mutation cleanup, the CORS preflight arm, and the `npm audit` baseline (unchanged, no new deps). Net: no Critical, no High. One Medium and three Low — all defense-in-depth / hygiene; none block release. The change does what the spec contracted and nothing more.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

- `scripts/smoke-edge-roles.sh:43-55` — **No guard rail preventing the script from running against a non-local stack.** The header documents "default: local stack" and the docker-exec arms will naturally fail (and SKIP) if no `supabase_db_imr-inventory` container exists, but nothing actually *refuses* a remote `SUPABASE_URL`. Concrete attack-shape: a developer with `SUPABASE_URL=https://<prod>.supabase.co` in their shell environment (e.g. left over from another script) runs `bash scripts/smoke-edge-roles.sh`. Arms 1 and 2 hit prod — benign (CORS preflight + a no-auth POST that 401s at the gateway). Arm 3 attempts to log in as `admin@local.test / password` against prod, which fails harmlessly *unless* such credentials happen to exist there (very unlikely, but the script has no way to know). Arm 4's `docker exec` to a container that doesn't exist locally also fails harmlessly. So the practical blast radius is minor — but the script is the one and only smoke in the repo that promotes a profile to super_admin, and the principle "the only state-mutating smoke must refuse to run against non-local" is a cheap defense-in-depth. **Fix:** add an early guard near line 56:
  ```
  case "$SUPABASE_URL" in
    http://127.0.0.1:*|http://localhost:*) ;;
    *) printf 'refusing to run against non-local SUPABASE_URL=%s — this script promotes a profile in Arm 4.\n' "$SUPABASE_URL" >&2; exit 2 ;;
  esac
  ```
  Recommend as defence-in-depth, not blocking — the docker-exec failure path already SKIPs cleanly. Surface for the architect as the canonical pattern if a second state-mutating smoke is ever added.

### Low

- `scripts/smoke-edge-roles.sh:69-83` — **`trap … EXIT` does not fire on `SIGKILL` (kill -9, OOM-killer, power loss).** The script's own header acknowledges this and provides the manual-recovery one-liner (line 34-37), which is the right call — a shell trap *cannot* run after SIGKILL by design. Re `set -u` interaction: `set -u` is *not* the same as `set -e` (only the former is set, at line 41), so a non-zero curl/grep does not auto-exit; the trap fires only when the script reaches its `exit $FAILED` at line 245 or hits an *unset* variable. That's the intended bash semantics — verified by reading the `fail()` helper at line 62, which sets `FAILED=1` but does NOT exit. So under normal failure paths (a curl returns 403, an assertion fails), the script runs to completion and the trap runs the restore. The only un-restorable path is SIGKILL, which is documented. No fix required — calling out for the audit record only.

- `scripts/smoke-edge-roles.sh:51` — **`ADMIN_PASSWORD` default of `password` is committed in plaintext.** This is the local-seed-stable password used by `admin@local.test` (matches `smoke-rpc.sh:48` and `smoke-multi-brand.sh:57`), so the value itself is not a secret. Including the default inline matches the pattern of the existing smoke scripts and is acceptable for a local-only fixture. *Provided* the Medium-severity local-only guard above is added, this is fine. If the Medium is deferred, this Low becomes a no-op consideration (the script can attempt to log in as `admin@local.test / password` against prod — which will fail, but the attempt has been made). Calling out for completeness; no action required.

- `scripts/smoke-edge-roles.sh:48` — **`SUPABASE_ANON_KEY` default is the local-stable publishable key.** Matches `smoke-rpc.sh:45` precedent. Publishable / anon keys are designed to ship to clients and are not secrets. Verified — not a finding, calling out only because every committed-credential merits an explicit pass.

### Audit of focus areas

#### 1. Strict-superset claim — verified

Comparing `send-invite-email/index.ts:20-35` (post-fix) against the same file pre-fix:

| Caller shape | Pre-fix gate | Post-fix gate | Notes |
|---|---|---|---|
| No `Authorization` header | 401 ("missing bearer token") at `requireAdminCaller` line 23 | 401 (same) | unchanged |
| `Bearer <invalid>` | 401 ("invalid token") at line 29 — `auth.getUser()` returns error | 401 (same) | unchanged |
| `Bearer <jwt with app_metadata.role='user'>` AND `profiles.role='user'` | 403 ("forbidden") at line 33 | 403 (same) | unchanged |
| `Bearer <jwt with app_metadata.role='admin'>` | 200 at line 31 (Set.has match) | 200 (same) | unchanged |
| `Bearer <jwt with app_metadata.role='master'>` | 200 at line 31 (Set.has match) | 200 (same) | unchanged |
| `Bearer <jwt with app_metadata.role='super_admin'>` | 403 at line 33 (was NOT in Set) | **200 at line 31 (now in Set)** | the spec-027 fix |
| `Bearer <jwt with app_metadata.role=null>` AND `profiles.role='super_admin'` | 403 at line 33 (was NOT in Set fallback) | **200 at line 34 (profiles fallback now passes)** | also the fix |
| `Bearer <jwt with app_metadata.role='manager'>` AND `profiles.role='manager'` | 403 at line 33 | 403 (same) | unchanged |
| `Bearer <jwt with app_metadata.role='anon'>` | 401 (gateway `verify_jwt=true` rejects before the function runs; if the function ran, line 29 `auth.getUser()` would also fail) | 401 (same) | unchanged |

`ADMIN_ROLES` is consumed only at `index.ts:31` (`app_metadata` path) and `:33` (`profiles.role` path). Both are `.has(role)` membership checks; neither iterates the Set nor measures `.size`, so adding `"super_admin"` is the **only** observable change. Confirmed by reading the full function body lines 22-100.

The role CHECK constraint at `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:163-164` restricts `profiles.role` to `('super_admin','admin','master','user')` — so the JWT-fallback `profiles.role` value cannot be an arbitrary attacker-controlled string (e.g. there is no way to introduce a fifth role and slip it past). The DB-side constraint is the back-stop; the edge-function Set is the front-line. Both agree on the four-element domain.

**Strict-superset confirmed.** No combination of `app_metadata.role` + `profiles.role` opens an unintended path. The only new accepted shape is `super_admin` (by either signal); the rejected shapes (user, manager, anon) remain rejected.

#### 2. JWT vs `profiles.role` sourcing — parity verified

`send-invite-email/index.ts:22-35` mirrors `delete-user/index.ts:21-34` byte-for-byte at the gate level:
- Both check `app_metadata.role` first via `userRes.user.app_metadata` (line 30 vs delete-user line 29).
- Both fall back to `profiles.role` via a per-request supabase-js client bound to the caller's bearer (line 32 vs delete-user line 31).
- Both reject with 403 if neither passes (line 33 vs delete-user line 32).

The only difference is `delete-user` returns the `userId` (it needs it for the self-delete guard); `send-invite-email` doesn't. That's expected and not a divergence in the role-gate shape.

No JWT-vs-profiles asymmetry to flag.

#### 3. Smoke-script secrets — verified clean

- Lines 4-7 of the new script don't touch any prod secrets. All env-var reads are either:
  - Public defaults (publishable anon key — designed to ship to clients, matches `smoke-rpc.sh:45` precedent),
  - Local fixture defaults (`admin@local.test / password` — matches `smoke-rpc.sh:47-48` and `smoke-multi-brand.sh:57`),
  - Opt-in overrides via `ADMIN_BEARER` / `SUPER_ADMIN_BEARER` for non-local runs.
- The `LOGIN` curl response at line 136-141 is passed through `python3` to extract just `access_token` — the rest of the response (including refresh_token and the user object with `app_metadata`) is **not** echoed to stdout. Good. Equivalent for the super-admin login at line 200-205.
- Error paths print at most the first 200 bytes of the response body (`${BODY:0:200}` at lines 167, 170, 172, 174, 226, 229, 231, 233). For a 401/403/400 response body this is the error message JSON (e.g. `{"error":"forbidden"}`) — no JWT material, no API key material, no PII. Verified safe.
- The `LOGIN_S:0:200` snippet at line 207 truncates the login response. The Supabase auth response on failure is `{"error":"...", "error_description":"..."}` — no token material in failure path. On success the response *would* contain `access_token`, but line 207 only fires when `SUPER_ADMIN_BEARER` is empty (login parsing failed), so the success-with-token branch never reaches the log. Verified safe.
- The script does NOT `set -e`, so a curl failure leaves variables empty rather than mid-script-aborting. Combined with `set -u`, attempting to read an unset variable would error, but every conditionally-set variable (`ADMIN_BEARER`, `SUPER_ADMIN_BEARER`, `LOGIN`, `LOGIN_S`) is initialized to `""` via `|| echo ""` or a default expansion. Verified safe.

**No secrets are baked in. CI-safe as written.** Once the Medium-severity local-only guard is added, the script is also safe-by-construction against accidental prod hits.

#### 4. Manual promotion via psql — state-cleanup analysis

The `trap restore_admin EXIT` pattern is the standard bash idiom for this and is correctly applied here:

- `PROMOTED=0` at line 59 — initialized to "no mutation has happened yet".
- `PROMOTED=1` at line 199 — flips only *after* the `docker exec … UPDATE … role='super_admin'` SQL has run successfully (the `if ! docker exec … ; then` at line 193 ensures the flag is only set on the success branch).
- `restore_admin()` at lines 69-83 — reads `$PROMOTED` and runs the restore UPDATE only if `=1`. Preserves the caller's exit code via `local exit_code=$?` at line 70 + `exit "$exit_code"` at line 82.

Trap semantics verified against bash:
- `EXIT` fires on normal exit, on uncaught error (with `set -e`, which is NOT set here), on `exit` calls (lines 245), and on signals that have a default disposition of termination (SIGTERM, SIGHUP, SIGINT) — verified empirically in bash 5+; `EXIT` is the inclusive trap.
- `SIGKILL` cannot be trapped — the script header at lines 33-37 acknowledges this and provides the manual recovery one-liner. **Correct disposition.**
- `set -u` interaction: an unset-variable read mid-script causes bash to print an error and exit with status 1, which triggers the EXIT trap and runs the restore. Verified the only conditionally-set variables (`ADMIN_BEARER`, `SUPER_ADMIN_BEARER`, `LOGIN`, `LOGIN_S`, `RESPONSE`, `CODE`, `BODY`, `HEADERS`, `STATUS`) all have unconditional defaults or assignments before being read. **Correct disposition.**

**The trap will fire on every failure path the script can reach (including `Ctrl-C`).** Worst-case state-persistence: SIGKILL → manual recovery (documented). For local-dev only, this is acceptable. The Medium-severity local-only guard above closes the "wait, what if someone runs this against prod" tail of the risk.

#### 5. CORS preflight arm — verified

Arm 1 at `smoke-edge-roles.sh:89-111` asserts:
- `200` or `204` status (line 97) — matches `send-invite-email/index.ts:39` which returns 200 explicitly,
- presence of `access-control-allow-origin` header (line 103),
- `access-control-allow-methods` includes `POST` (line 106),
- `access-control-allow-headers` includes `authorization` (line 109).

These are the specific headers the spec asks for — the smoke script asserts more than just the status code. The script does **not** assert the *value* of `Access-Control-Allow-Origin` (which is `"*"` at `send-invite-email/index.ts:11`), only that the header is present. That's intentional and matches `smoke-edge.sh:63` precedent; `Access-Control-Allow-Origin: *` is the project's accepted default for edge functions (verified in `delete-user/index.ts:9`, `send-invite-email/index.ts:11`, `fetch-breadbot-sales`, etc).

I note for the record that `Access-Control-Allow-Origin: *` combined with the function's bearer-only auth is the correct pattern — the function authenticates via `Authorization: Bearer`, not via cookies or session, so CSRF doesn't apply and the wildcard origin is safe. (The threat model in the security-auditor agent prompt explicitly carves CSRF out: "same-origin token-bearer API where there's no cookie auth.") **No CORS finding.**

#### 6. `verify_jwt` config — verified

`send-invite-email` is **not** in `supabase/config.toml`'s explicit `[functions.<name>]` overrides (verified by grep on lines 384-398 — only `pwa-catalog` and the three `staff-*` entries are listed). Per `supabase/config.toml` defaults, an unspecified function inherits `verify_jwt = true`. So `send-invite-email` is gateway-protected, and its `requireAdminCaller()` is a defence-in-depth role check on top of the gateway's JWT validation. The gateway-401 at Arm 2 of the smoke (where no `Authorization` header is sent) confirms this end-to-end. **No verify_jwt finding** — the spec is purely a role-band fix on top of an already-protected function.

### Dependencies

`package.json` changes are limited to the `scripts.test:smoke` chain (`+ && bash scripts/smoke-edge-roles.sh`). No `dependencies` / `devDependencies` modifications. The repo's existing `npm audit --audit-level=high` baseline is unchanged by this spec.

For the record, the current baseline (independent of this spec; reported here only because the audit process requires running `npm audit` when `package.json` changes — even though this change is to a script string only):

- **1 High severity:** `@xmldom/xmldom <=0.8.12` — XML injection / DoS in transitive deps. Reachability into client-side or edge-runtime code paths in `imr-inventory` is not obvious from the dependency tree (xmldom is a transitive dep, no direct usage in `src/` or `supabase/functions/`).
- **5 Moderate, 5 Low** — `dompurify`, `postcss` (transitive via `@expo/metro-config` / `@expo/cli`), `http-proxy-agent` / `@tootallnate/once` (transitive via `jest-environment-jsdom`).
- **`npm audit fix` available for non-breaking fixes**; `--force` upgrade chain would push `jest-expo` and `expo` to breaking-major versions and is out of scope for this spec.

These findings predate spec 027 and are not within this spec's scope. Surfacing for completeness only. **No new vulnerabilities introduced by spec 027.**

### Summary

| Severity | Count |
|---|---|
| Critical (BLOCKS merge) | 0 |
| High (must fix before deploy) | 0 |
| Medium | 1 (local-only guard for state-mutating smoke) |
| Low | 3 (SIGKILL un-restorable / `ADMIN_PASSWORD` default / `SUPABASE_ANON_KEY` default — all defense-in-depth or no-op explainers) |

Spec 027 implements exactly what it contracted: a strict-superset role-gate fix on one edge function, a four-arm smoke script that asserts the gate including the load-bearing super_admin path, and two strictly-additive prose docs. The fix narrows the gap closed by spec 026 (DB-side parity) at the edge layer with the smallest possible surface change. No new attack vectors introduced; the change is observably the addition of one element to one Set, plus the smoke and docs.

**Recommendation: no Criticals, no Highs — spec is releasable from the security perspective.** The Medium-severity local-only guard for the smoke script is a defense-in-depth nice-to-have, not a blocker. The user runs `supabase functions deploy send-invite-email` post-merge to cut the fix over to prod, as flagged in the spec.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 1 Medium, 3 Low. No findings block release. The change is a verified strict-superset (admin/master still pass, super_admin newly passes, all other shapes unchanged) with no new attack vectors. One Medium hardening — refuse-to-run-against-non-local guard for the new state-mutating smoke script — is recommended but does not block. Three Lows are defense-in-depth explainers. `npm audit` baseline unchanged (no new deps).
payload_paths:
  - specs/027-edge-fn-super-admin-parity/reviews/security-auditor.md

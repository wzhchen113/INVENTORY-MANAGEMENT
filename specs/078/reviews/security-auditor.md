# Security audit for spec 078 — Playwright E2E framework (web-only)

Scope reviewed: the test harness + CI + secret surface only, per the dispatch.
Frontend `testID` instrumentation in `src/` is production-inert (selector hooks,
no auth/data surface) and explicitly out of scope. Files audited:

- `.github/workflows/e2e.yml`
- `e2e/global-setup.ts`
- `playwright.config.ts`
- `e2e/fixtures/constants.ts`
- `e2e/auth.setup.ts`
- `.gitignore`
- `specs/078-e2e-playwright-framework.md` (OQ-1 env-sourcing, OQ-3 isolation, OQ-4 fixture)

## Verdict

No Critical, no High. The load-bearing concern — a committed prod secret —
is **confirmed absent**. Both hardcoded keys decode to the universal
`supabase-demo` local-stack JWTs, the storageState files are correctly
gitignored and never tracked nor uploaded, and the workflow is least-privilege
and non-blocking. One Low (a defense-in-depth prod-URL guard in global-setup)
and a couple of informational notes. **Nothing here blocks the spec.**

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `e2e/global-setup.ts:34-38` — **No prod-URL guard on the service-role insert
  path.** `SUPABASE_URL` falls back to `http://127.0.0.1:54321`, but if a
  developer (or a future CI misconfig) has `EXPO_PUBLIC_SUPABASE_URL` set to a
  prod `*.supabase.co` URL in their shell, `globalSetup` would run a
  service-role `upsert` into `order_schedule` against prod. Blast radius is
  bounded: (a) the demo `SERVICE_ROLE_KEY` fallback is rejected by prod's
  gateway (different signing secret), so the insert only reaches prod if a real
  prod service-role key is ALSO present in env — at which point the operator has
  already exported a prod service-role key into a shell that runs tests, which is
  the actual footgun; (b) `db.ts`'s own client reads the same `EXPO_PUBLIC_*`
  vars, so a leaked prod URL is a pre-existing repo-wide hazard, not introduced
  here. This is the same class of issue the spec-027 audit raised for
  `scripts/smoke-edge-roles.sh` ("the only state-mutating path should refuse a
  non-local stack"). **Acceptable for v1** because CI explicitly boots a local
  stack and the design (OQ-1) deliberately keeps the URL env-sourced for the
  future remote-branch swap. **Optional hardening:** assert
  `SUPABASE_URL.includes('127.0.0.1') || SUPABASE_URL.includes('localhost')`
  unless an explicit `E2E_ALLOW_REMOTE=1` opt-in is set, and throw otherwise —
  cheap, mirrors the spec-027 guard recommendation, and costs nothing for the
  local-stack happy path. Not a blocker.

### Informational (no action required)

- `playwright.config.ts:26` / `e2e/global-setup.ts:38` — **The two hardcoded
  JWTs are the well-known public local-stack demo keys, not secrets.** Decoded
  payloads:
  - anon: `{"iss":"supabase-demo","role":"anon","exp":1983812996}`
  - service_role: `{"iss":"supabase-demo","role":"service_role","exp":1983812996}`

  `iss: supabase-demo` is the universal issuer baked into every `supabase start`
  — these strings are published verbatim in Supabase's own docs and ship
  identically on every developer's machine. They have zero value against prod
  (prod uses a project-specific JWT secret). Hardcoding them as the env fallback
  is correct and matches the OQ-1 env-sourcing decision: a remote-branch swap is
  a CI-secret change, not a code edit. Not a finding.

- `e2e/.auth/admin.json` / `master.json` / `staff.json` — **storageState files
  carry live (local) auth tokens but are correctly gitignored and never
  tracked.** Confirmed:
  - `git check-ignore -v e2e/.auth/admin.json` → matches `.gitignore:37`
    (`/e2e/.auth/`).
  - `git ls-files e2e/.auth/` → empty (nothing tracked).
  - `git status` shows the whole `e2e/` tree as untracked (`?? e2e/`); a
    subsequent `git add e2e/` will skip `.auth/` because the ignore rule
    pre-empts it. The committer should still add files by path rather than
    `git add e2e/` wholesale, but even the wholesale form is safe here.

  The tokens are local-stack-only (signed by the demo JWT secret), so even if
  one leaked it would authenticate nothing beyond a throwaway local stack. The
  poison-queue guard in `e2e/auth.setup.ts:10-16` (no EOD submit during setup)
  also means the saved state carries auth only, never the offline-queue
  localStorage key — correctly implemented (`auth.setup.ts:34,46,60` stop at the
  landing surface).

- `.github/workflows/e2e.yml:96-104` — **Artifact upload cannot leak
  storageState.** The `if: always()` upload globs `playwright-report/` and
  `test-results/` only. The storageState lives in `e2e/.auth/` (a different
  tree) and is gitignored, so it is in neither glob. Acceptable.

- `playwright.config.ts:53` (`trace: 'on-first-retry'`) — **Trace leakage is
  bounded to local-stack-only artifacts.** On a CI retry the trace can embed the
  local auth tokens (request headers) and the service-role-inserted
  `order_schedule` rows. Because every token/key/URL in play is the local-stack
  demo set, the uploaded trace has no prod value. The service-role KEY itself is
  not in the trace — global-setup runs in the Node process before any browser
  context, so its client traffic is not captured by the browser tracer, and the
  fixture explicitly never logs the key (`global-setup.ts:24-26,81`). Acceptable
  for the threat model; no action.

- `.github/workflows/e2e.yml:73-94` — **No secret echo; CI logs are clean.**
  Local keys are piped straight from `supabase status -o env` into `$GITHUB_ENV`
  (line 80) and consumed via `${{ env.* }}` (lines 93-94) — the values are never
  `echo`'d. The single `console.log` in global-setup
  (`global-setup.ts:90-93`) prints only the row count and store UUID, never the
  key. The error path (`global-setup.ts:82-86`) is explicitly key-free.

- `.github/workflows/e2e.yml:31-34` — **Least-privilege confirmed.**
  `permissions: contents: read` mirrors `test.yml:36-37`. No write scopes. The
  workflow is non-blocking by design (header comment + spec AC-PROMO1): it is
  not a required status check, so a red run does not gate merge — consistent with
  the spec and with the CLAUDE.md CI-status rule being scoped to `test.yml`
  only.

- `e2e/fixtures/constants.ts:12-17` — **Demo accounts are local seed only.**
  `admin@local.test` / `master@local.test` / `manager@local.test` with password
  `password` come straight from `supabase/seed.sql`. They are used solely by
  `auth.setup.ts` against the local stack (baseURL `localhost:8081` → local
  Supabase). The password is a seed credential, not a prod one. Not a finding.

### Dependencies

`npm audit` total: **17 (0 critical, 1 high, 16 moderate, 0 low)** — **identical
to the stated prior baseline** (16 moderate + 1 high `@xmldom/xmldom`). The new
`@playwright/test@1.60.0` devDependency introduced **zero new vulnerabilities**.

- High (pre-existing, not from this spec): `@xmldom/xmldom <=0.8.12` — DoS +
  XML-injection advisories. Reaches via the Expo/native build toolchain, not via
  Playwright, and not via any runtime web path. Unchanged by spec 078.
- The 16 moderate (dompurify, postcss, uuid, brace-expansion, and the Expo
  transitive chain) are all pre-existing and unrelated to Playwright.

No `@playwright/test`-introduced CVE. No dependency action required for this
spec.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 1 Low. The load-bearing concern (committed prod secret) is confirmed absent — both hardcoded JWTs decode to the public `supabase-demo` local-stack keys, no prod URL/key appears anywhere in the spec-078 surface, storageState files are gitignored and never tracked or uploaded, and the workflow is least-privilege + non-blocking. npm audit is 17 (1 high + 16 moderate), identical to the prior baseline; `@playwright/test` added zero CVEs. The single Low is an optional defense-in-depth prod-URL guard in `e2e/global-setup.ts` (acceptable for v1 since CI boots a local stack). Nothing blocks the spec.
payload_paths:
  - specs/078/reviews/security-auditor.md

## Resolution (post-review fix-pass — main Claude)

- **Low (no prod-URL guard on the service-role fixture)** — **fixed.** Added an exported `assertLocalStack(url)` guard in `e2e/global-setup.ts`, reused by the new `e2e/global-teardown.ts`. Both service-role fixtures now throw unless the Supabase URL is `localhost`/`127.0.0.1`, with an `E2E_ALLOW_REMOTE=1` escape hatch for the deferred OQ-1 remote-branch path. This closes the "stray prod `EXPO_PUBLIC_SUPABASE_URL` could be targeted" gap you flagged, mirroring the spec-027 smoke-script guard. No other security finding outstanding (0 Critical/High/Medium confirmed).

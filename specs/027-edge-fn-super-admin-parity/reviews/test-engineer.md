## Test report for spec 027

### Acceptance criteria status

#### Track A — Fix `send-invite-email`

- **A1.** `super_admin` added to `ADMIN_ROLES` Set at line 20 of `send-invite-email/index.ts` → **PASS** — `scripts/smoke-edge-roles.sh::Arm 4` (load-bearing regression detector)
- **A2.** 4-line comment above the constant citing `public.auth_is_privileged()` and spec 026 → **PASS** — verified by code read at `supabase/functions/send-invite-email/index.ts:16-19`
- **A3.** No other change to `send-invite-email/index.ts` — `requireAdminCaller`, email template, Resend path, `auth.admin.inviteUserByEmail` fallback preserved → **PASS** — file is 100 lines, function body lines 22-35 and body handler lines 37-99 confirmed unchanged

#### Track B — Audit and fix sibling edge functions

- **B1.** All 10 functions under `supabase/functions/` audited for role-gate patterns → **PASS** — architect re-walked all 10; PM baseline confirmed correct; grep against all 10 `index.ts` files in this review confirms only `delete-user` and `send-invite-email` carry an `ADMIN_ROLES` constant; remaining 8 have no role-band check
- **B2.** Every privilege-gate hit extended to include `super_admin` with matching comment → **PASS** — zero additional hits beyond Track A's target (net: only one file needed fixing)
- **B3.** Recipient-selection hit (`eod-reminder-cron/index.ts:192`) documented as not a privilege gate and deferred → **PASS** — the architect's design section §3 and spec Out-of-scope §6 both record this; the line is confirmed at `eod-reminder-cron/index.ts:192` as `.in('role', ['admin', 'master'])` used to build `adminUserIds` for fan-out, not a caller gate
- **B4.** Audit table in the design doc covers all 10 functions with exactly one classification per file → **PASS** — spec §"Architect design" §1 provides the 10-row table; all 10 present functions confirmed against `ls supabase/functions/`

#### Track C — Smoke test

- **C1.** New shell script at `scripts/smoke-edge-roles.sh` following `smoke-edge.sh` patterns (set -u, pass/fail/skip/step helpers, FAILED accumulator, non-zero exit on failure) → **PASS** — file present, all conventions matched
- **C2(i).** `OPTIONS` preflight returns 200 + CORS headers → **PASS** — Arm 1 asserts HTTP 200 (also accepts 204 as defense-in-depth; the actual function body returns 200 per line 39 of `send-invite-email/index.ts`); headers `access-control-allow-origin`, `access-control-allow-methods`, `access-control-allow-headers` asserted individually
- **C2(ii).** `POST` without `Authorization` returns 401 → **PASS** — Arm 2 asserts exactly `401`; send-invite-email defaults to `verify_jwt=true` (no `[functions.send-invite-email]` entry in `config.toml`), so the gateway returns 401 before the function body runs; the function's internal `requireAdminCaller` entry guard also returns 401 — either path satisfies the assertion
- **C2(iii).** `POST` with admin JWT reaches post-gate handler (200 or 4xx post-gate, not 401/403) → **PASS** — Arm 3 asserts `CODE == "200" || CODE == "400"` and on 400 additionally body-matches `"email and name required"`; SKIP idiom fires when login fails (no local stack)
- **C2(iv).** `POST` with super_admin JWT reaches post-gate handler — load-bearing regression detector → **PASS** — Arm 4 promotes `admin@local.test` via `docker exec` psql, re-logs in to mint a fresh JWT (required because `profiles_sync_role_to_jwt` AFTER trigger writes to `raw_app_meta_data` but old tokens don't pick up the new claim), then asserts same 200/400 shape; 403 is explicitly the regression signal
- **C3.** Smoke test does NOT hit Resend or `auth.admin.inviteUserByEmail` — empty body `{}` triggers `400 email and name required` before either path runs → **PASS** — validated by `send-invite-email/index.ts:53-54`: the `if (!email || !name)` check fires before the `if (RESEND_API_KEY)` block at line 63; on local stack `RESEND_API_KEY` is unset anyway
- **C4.** `npm run test:smoke` chains `smoke-edge-roles.sh` last → **PASS** — `package.json:18` confirmed: `"test:smoke": "bash scripts/smoke-edge.sh && bash scripts/smoke-rpc.sh && bash scripts/smoke-edge-roles.sh"`
- **C5.** Documentation comment at top of `scripts/smoke-edge-roles.sh` cites spec 027 and the parity convention → **PASS** — lines 2-14 confirmed: cites "Spec 027", references `auth_is_privileged()`, references `delete-user/index.ts:19`

#### Track D — Document the role-constants convention

- **D1.** New bullet added to `CLAUDE.md` under "Conventions already in use", immediately after the "Edge function auth split" bullet → **PASS** — `CLAUDE.md:61` confirmed; content matches spec intent: names `ADMIN_ROLES`, the `Set` shape, `auth_is_privileged()` mirror, reference to `delete-user/index.ts`, and spec 027 as the parity fix
- **D2.** New bullet added to `.claude/agents/security-auditor.md` under "Edge functions — `verify_jwt` and service-token validation" → **PASS** — `security-auditor.md:49` confirmed; directs future auditors to check `ADMIN_ROLES` for `super_admin` inclusion; severity guidance "High" is present; reference shape at `delete-user/index.ts:19` is present
- **D3.** Both prose edits strictly additive — no existing paragraph rewritten → **PASS** — surrounding bullets in CLAUDE.md (lines 60, 62) and security-auditor.md (lines 45-48, "Secrets" section following) confirmed unchanged

#### Cross-track verification gates

- **CT1.** `npx tsc --noEmit` exits 0 → **PASS** — developer-reported; spec changes no TypeScript source files; no TS types were changed
- **CT2.** `npm run typecheck:test` exits 0 → **PASS** — same rationale as CT1
- **CT3.** `npm test -- --ci` 17/17 PASS → **PASS** — developer-reported; no jest test files reference `ADMIN_ROLES` or `send-invite-email` (confirmed by search of `tests/` directory); the constant change is forward-compatible with all existing tests
- **CT4.** `npm run test:db` 14/14 PASS → **PASS** — developer-reported; spec ships zero migrations and zero SQL changes
- **CT5.** `npm run test:smoke` PASS including `smoke-edge-roles.sh`; when run without `ADMIN_BEARER`/`SUPER_ADMIN_BEARER` in CI, Arms 3-4 SKIP and script exits 0 → **PASS** — developer-reported; SKIP logic confirmed in script: Arm 3 checks `[[ -z "${ADMIN_BEARER}" ]]` and attempts local login, falling to `skip()` on empty token; Arm 4 checks `docker exec` success and falls to `skip()` on failure; both print SKIP and continue rather than FAIL
- **CT6.** Manual gate: super-admin session in Cmd UI clicks "Invite User" — inserts `invitations` row, returns 200 from edge function, no console error → **NOT TESTED** — explicitly specified as a manual developer gate. No automated coverage exists or is expected per spec. The developer claimed this gate was run locally during implementation. This test-engineer cannot verify it independently without a live stack and a super-admin session. See notes section.

---

### Test run

The spec ships no jest tests (shell smoke per project pattern). Automated verifications performed by this review:

- Code read of `supabase/functions/send-invite-email/index.ts` — A1/A2/A3 confirmed
- Code read of all 10 `supabase/functions/*/index.ts` via grep — B1/B2/B3/B4 confirmed
- Code read of `scripts/smoke-edge-roles.sh` — C1/C2(i-iv)/C3/C4/C5 confirmed
- Code read of `CLAUDE.md:61` — D1 confirmed
- Code read of `.claude/agents/security-auditor.md:49` — D2/D3 confirmed
- Code read of `supabase/config.toml` — confirms `send-invite-email` defaults to `verify_jwt=true`

The developer's reported test run (4/4 smoke arms PASS with local stack) is consistent with the script logic. No discrepancy found that would indicate test result fabrication.

**CT6 is the only NOT TESTED criterion and is explicitly specified as manual-only in the spec.** See notes.

---

### Notes

#### Should-fix: trap/exit semantics — wording mismatch with header comment

The script header at line 10 states "same set -u + non-zero-exit-on-first-failure contract." This is inaccurate: `fail()` at line 62 sets `FAILED=1` but does NOT exit immediately. All four arms always run regardless of earlier failures. The final `exit $FAILED` at line 245 is the single exit point. This is the same behavior as `smoke-edge.sh` (which makes the same non-first-failure claim in its header), so it is a documentation nit, not a behavioral divergence from sibling scripts. However the spec AC C1 explicitly references "non-zero exit on first failure" as a required contract match. The actual behavior is "non-zero exit after all arms run." A developer relying on the header comment to believe a CORS failure would abort before Arm 4's state mutation would be misled.

Recommendation: correct the header comment in `smoke-edge-roles.sh` (and optionally `smoke-edge.sh`) to read "non-zero exit on any failure" rather than "first failure." This is a should-fix — it does not affect correctness of the AC coverage, but it misleads future maintainers about the state-mutation risk window.

#### Nit: Arm 1 accepts HTTP 204 without spec authorization

The spec at C2(i) specifies "OPTIONS preflight returns 200." Arm 1 at line 97 accepts `200 OR 204`. The function itself returns 200 (confirmed at `send-invite-email/index.ts:39`). The 204 acceptance is defensible (proxies may rewrite OPTIONS responses) but is undocumented in the spec and slightly weakens the assertion. No action required — noting for traceability.

#### Manual gate CT6 — release-coordinator must surface this explicitly

CT6 cannot be automated at this project's current test infrastructure level. The criterion requires a live Cmd UI session with a real super-admin JWT, a working local Supabase stack, and observation of Docker logs. The developer's claim that this gate was run is plausible and consistent with the smoke test logic, but this test-engineer cannot verify it. The release-coordinator should include CT6 as an explicit pre-deploy checklist item in the release proposal.

#### Post-merge deployment step — not gated by any test

`supabase functions deploy send-invite-email` is a manual post-merge step (spec Out-of-scope §10). No test in any track verifies that the deployed function matches the source. The smoke test only exercises the locally-served function (via `supabase functions serve` or a running local stack). If the production deployment step is skipped after merge, the bug remains live in prod despite the test suite being green. The release-coordinator must flag this.

#### CI gating posture — Track C added coverage but NOT CI enforcement

Per spec 022 Track 3 and the architect's design §7, `npm run test:smoke` is a manual-run gate. The new `smoke-edge-roles.sh` is chained into it but does not run in CI (no `.github/workflows/` exists on disk). Arms 3 and 4 would SKIP in CI anyway due to absence of a local stack. Recommendation: leave CI enforcement for a future spec (consistent with the project's existing posture). The value of Arms 1-2 (CORS preflight and 401 no-auth check) could run in CI without a local stack — a future spec could wire those two arms to run against a deployed staging URL.

#### Regression coverage — no updates needed to existing tests

The constant change (`Set(["admin", "master"])` → `Set(["admin", "master", "super_admin"])`) is additive. No existing jest test, DB test, or smoke test references `ADMIN_ROLES` by name or tests the `send-invite-email` function's rejection behavior for `admin` or `master` callers. All existing tests remain green by construction.

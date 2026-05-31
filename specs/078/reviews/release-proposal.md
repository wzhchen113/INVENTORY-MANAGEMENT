## Verdict
verdict: SHIP_READY
rationale: Zero Critical anywhere; both code-reviewer Should-fixes, the security Low, and a spec-078-induced local cross-track pgTAP collision are all resolved, with the full Playwright suite green (13/13) and all other tracks green (pgTAP 38/38, jest 386/386, e2e tsc exit 0).

## What shipped

Spec 078 adds a fourth test track — browser E2E via Playwright (web-only, react-native-web target) — wired as a SEPARATE, initially non-blocking CI workflow. Concretely:

- **Harness:** `playwright.config.ts` at repo root (Expo webServer on 8081, `reuseExistingServer: !CI`, `testIdAttribute: 'data-testid'`, setup + chromium projects, CI retries=2, `trace: 'on-first-retry'`, per-test + global timeouts) + `e2e/tsconfig.json` (base `tsconfig.json` now excludes `e2e/**`).
- **8 spec files / 13 tests:** `auth.setup.ts` (admin/master/staff storageState, no EOD submit — poison-queue guard), `auth.spec.ts` (S1/S2/S3 sign-in role-branching), `eod.spec.ts` (EOD1 online + EOD2/3 offline→queue→reconnect→drain), `invite.spec.ts` (master-path invite, uniquified email), `dashboard.spec.ts`, `reorder.spec.ts`, `audit.spec.ts`, `dark-mode.spec.ts`, plus `e2e/fixtures/constants.ts` and the `e2e/global-setup.ts` order_schedule fixture.
- **New CI workflow:** `.github/workflows/e2e.yml` — separate from `test.yml`, non-blocking, `permissions: contents: read`, boots the Supabase stack + `supabase db reset`, installs chromium, runs `npm run e2e`, uploads report/traces (`if: always()`). Promotion-to-gating rule documented: >= 20 consecutive green runs on `main` AND observed flake rate < 5% (user-decided flip).
- **16 production testIDs** instrumented (non-behavioral attribute adds): LoginScreen (`signin-email/password/error`), ResponsiveCmdShell (`cmd-shell-root` ×3 breakpoints), DashboardSection (`dashboard-root/kpis`), ReorderSection (`reorder-root`), AuditLogSection (`audit-root`), UsersSection (`users-root/invite-trigger`, `user-row-{id}`), InviteUserDrawer (`invite-email/name`, `invite-role-{r}`, `invite-store-{id}`, `invite-submit`). The optional `eod-queue-count` (§7 row #17) was consciously skipped — the EOD spec keys on indicator presence/absence only.
- **Config/deps/docs:** `@playwright/test@^1.60.0` devDependency + `e2e`/`e2e:headed`/`e2e:ui` scripts, `.gitignore` (test-results, playwright-report, blob-report, `e2e/.auth/`), `tsconfig.json` exclude, and a full `tests/README.md` Track 4 section + 4-row track table.

**Fix-pass items (all landed before this proposal):**
- code-reviewer Should-fix #1: stale `invite.spec.ts` header block rewritten to a "WHY MASTER, NOT ADMIN" note matching the shipped master storageState.
- code-reviewer Should-fix #2: dead `EXPO_PUBLIC_NEW_UI` env + its misleading "mirrors .env.local" comment removed from `playwright.config.ts` (flag deleted in spec 025; nothing reads it).
- security Low: `assertLocalStack(url)` prod-URL guard added to `global-setup.ts` (reused by teardown); both service-role fixtures refuse a non-localhost/127.0.0.1 URL unless `E2E_ALLOW_REMOTE=1`.
- Cross-track collision: new `e2e/global-teardown.ts` removes exactly the order_schedule fixture rows global-setup inserted on Towson, so `npm run e2e` is locally hermetic.

## Findings summary
- **code-reviewer:** 0 Critical, 2 Should-fix, 4 Nits. Both Should-fixes FIXED (stale invite.spec.ts header; dead `EXPO_PUBLIC_NEW_UI` env). The 4 Nits (dark-mode `match!` non-null assertion, `gotoTowsonEod` helper placement, README tree annotation, auth.setup "blocks independent" comment) are cosmetic and consciously deferred to a future tidy pass.
- **security-auditor:** 0 Critical / 0 High / 0 Medium, 1 Low — FIXED via `assertLocalStack(url)`. Load-bearing concern (committed prod secret) confirmed ABSENT: both hardcoded JWTs decode to the public `supabase-demo` local-stack keys (zero prod value), storageState files gitignored + never tracked/uploaded, artifact upload globs cannot reach `e2e/.auth/`, workflow least-privilege + non-blocking. `npm audit` unchanged at 17 (1 high + 16 moderate, all pre-existing); `@playwright/test` added 0 new CVEs.
- **test-engineer:** PASS — 23/23 acceptance criteria covered (Phases 1-4 + cross-cutting AC-DARK1/CI1/CI2/DOC1/PROMO1). Data-isolation guards (OQ-3 poison-queue, OQ-3b invite uniquification, OQ-4 weekday fixture) confirmed present. `user-row-{id}` + `invite-store-{id}` are instrumented-but-unexercised by design (AC-SEL-USERS requires they exist, not that v1 exercises each). Surfaced the pgTAP `missed_order_audit_rpc.test.sql` arm C.1 failure, diagnosed as a spec-078-induced LOCAL cross-track collision (global-setup commits order_schedule rows on Towson; spec 075's pgTAP arm C also uses Towson) — CI never affected (test.yml + e2e.yml run separate fresh `db reset` stacks) — and FIXED via global-teardown. pgTAP back to 38/38.
- **backend-architect:** not invoked. Correct and proportionate here — this spec has zero backend-contract surface: NO DB migration, NO RPC, NO RLS change, NO seed edit. The architect already designed the workflow + OQ-4 fixture in design mode; a post-impl drift pass would have nothing to check (the §7 testID adds are production-inert selector hooks). The 3-reviewer fan-out (code + security + test) is the right proportionate set for a test-infra + instrumentation spec.

## Recommended next steps (ordered)
SHIP_READY:

1. **Commit and push** (the user authorizes the commit — main Claude does not auto-commit on SHIP_READY). Stage by explicit path; even a wholesale `git add e2e/` is safe because `.gitignore` pre-empts `e2e/.auth/`, but path-scoped adds are preferred.

2. **Watch BOTH CI runs after the push to `main` — this is operationally important.** This spec adds a BRAND-NEW workflow (`.github/workflows/e2e.yml`) that has NEVER run in CI. On the push, BOTH workflows trigger:
   - `test.yml` (the GATE) — must stay green. This is the required check the CLAUDE.md CI-status rule covers.
   - `e2e.yml` (NEW, non-blocking) — its FIRST CI run is unproven in the CI environment. Playwright chromium install, Supabase stack boot, and Expo webServer cold-boot timing all differ from local, so the spec-060/067 local-green / CI-red asymmetry is a real risk for a first-ever workflow run. It will NOT block merge (non-blocking by design), but a red brand-new E2E run needs eyes: observe the first `e2e.yml` run, and if it is red, surface the run URL before the promotion-to-gating clock (>= 20 consecutive green + <5% flake) is treated as started. A red first run does not block ship; it does block counting toward promotion.

3. (Optional, non-blocking follow-ups) The 4 deferred Nits (tidy pass); forwarding `EXPO_PUBLIC_SUPABASE_URL` explicitly in `e2e.yml` when the OQ-1 remote-branch path is activated (today the hardcoded `http://127.0.0.1:54321` fallback is correct for the CI bind address); migrating the staff `e2e/` helpers (e.g. `gotoTowsonEod`) into a shared module if a future spec adds more EOD coverage.

## Deploy / secrets note
This spec applies **NO prod migration** — it is web-deploy-only (the testID instrumentation rides the normal `expo export` → Vercel web build; no schema/RPC/RLS surface to migrate). The new `e2e.yml` needs **no repo secrets**: it pipes the local stack's well-known `supabase-demo` keys from `supabase status -o env` into `$GITHUB_ENV` and uses the hardcoded local-stack URL fallback. Nothing prod-facing is touched by the E2E track.

## Out of scope for this review
- Native (Detox / device-driver) E2E — Playwright is web-only by locked decision #1; native gestures + native push registration are explicitly deferred.
- The OQ-1 remote-branch / non-local-stack E2E path — deliberately deferred; the `E2E_ALLOW_REMOTE=1` escape hatch and the env-sourced URL are the seam left for it.
- Retroactively migrating the `src/screens/staff/` and `e2e/` navigation helpers into a shared/fixture module — flagged by code-reviewer Nit #4 for the next iteration that adds EOD coverage.
- The pre-existing `@xmldom/xmldom` high-severity advisory (reaches via the Expo/native build toolchain, not via Playwright or any runtime web path) — unchanged by this spec; belongs to a dependency-bump spec.

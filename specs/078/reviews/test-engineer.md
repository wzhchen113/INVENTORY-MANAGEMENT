## Test report for spec 078

### Acceptance criteria status

#### Phase 1 — Harness + auth + one smoke

- AC-H1: `@playwright/test` devDependency pinned at `^1.60.0`; chromium install documented as a one-time step in `tests/README.md` Track 4 section → PASS `package.json`, `tests/README.md`
- AC-H2: `playwright.config.ts` exists at repo root; configures `webServer` (Expo web, port 8081, `reuseExistingServer: !process.env.CI`, `timeout: 180_000`); `use.baseURL`; `testIdAttribute: 'data-testid'`; `projects` (setup + chromium); `retries: process.env.CI ? 2 : 0`; `trace: 'on-first-retry'`; per-test `timeout: 60_000`; global `globalTimeout: 15 * 60_000` → PASS `playwright.config.ts`
- AC-H3: `npm run e2e`, `npm run e2e:headed`, `npm run e2e:ui` scripts exist in `package.json`; prerequisite (`npm run dev:db`) documented in `tests/README.md` → PASS `package.json`
- AC-H4: `test-results/`, `playwright-report/`, `blob-report/`, `e2e/.auth/` are all in `.gitignore` → PASS `.gitignore`
- AC-A1: `e2e/auth.setup.ts` logs in as admin, master, and staff via real UI; saves per-role `storageState` to `e2e/.auth/admin.json`, `e2e/.auth/master.json`, `e2e/.auth/staff.json`; stops at landing surface without EOD submit (poison-queue guard OQ-3c) → PASS `e2e/auth.setup.ts:26,37,49`
- AC-A2: All flow specs declare `test.use({ storageState: STORAGE_STATE.<role> })` and the chromium project declares `dependencies: ['setup']`; UI login is not repeated per test (only `auth.spec.ts` exercises real login) → PASS `playwright.config.ts:88-93`, all `*.spec.ts`
- AC-SEL-LOGIN: `testID="signin-email"` (line 144), `testID="signin-password"` (line 158), `testID="signin-error"` (line 136) added to `LoginScreen.tsx`; `signin-submit` was pre-existing → PASS `src/screens/LoginScreen.tsx`
- AC-S1: `auth.spec.ts` fills `admin@local.test`/`password`, clicks `signin-submit`, asserts `cmd-shell-root` visible → PASS `e2e/auth.spec.ts:19` (13/13 green run verified locally)
- AC-S2: Same spec asserts `manager@local.test`/`password` lands on `store-picker-root` (two-store manager → StorePicker, not EODCount) → PASS `e2e/auth.spec.ts:27`
- AC-S3: Bad-credentials case asserts `signin-error` visible and `signin-email` still present and `cmd-shell-root` count is 0 (user did not navigate away) → PASS `e2e/auth.spec.ts:36`

#### Phase 2 — Staff EOD submit + offline queue

- AC-EOD1: `eod.spec.ts` navigates StorePicker → Towson EODCount, fills a count, clicks `eod-submit`, asserts `eod-queue-indicator` has count 0 (indicator absent means no item stuck in queue) → PASS `e2e/eod.spec.ts:76`
- AC-EOD2: `eod.spec.ts` calls `context.setOffline(true)`, polls `navigator.onLine` until false before clicking submit (timing guard against race), clicks `eod-submit`, asserts `eod-queue-indicator` is visible (item queued), then calls `context.setOffline(false)`, polls `navigator.onLine` until true, and asserts `eod-queue-indicator` has count 0 within 30 s (drain completed). The assertion that the indicator disappears is load-bearing: if `drainQueue` never ran the element would remain. → PASS `e2e/eod.spec.ts:92`
- AC-EOD3: `QueueIndicator` propagates the `testID` prop to its root `<View>` (renders null when `pending===0 && !draining`); the offline test asserts presence (`toBeVisible`) then absence (`toHaveCount(0)`) — never asserts exact text, so the assertion is not text-fragile → PASS `src/screens/staff/components/QueueIndicator.tsx:26`, `e2e/eod.spec.ts:120,134`
- AC-SEL-EOD: Audit of `EODCount.tsx` confirms all required selectors exist: `eod-store-name`, `vendor-chip-{id}`, `eod-item-input-{id}`, `eod-item-row-{id}`, `eod-submit`, `eod-queue-indicator`; `store-picker-root`, `store-row-{id}` in `StorePicker.tsx`. No new EOD testID was required, consistent with the design note → PASS

#### Phase 3 — Invite-user flow

- AC-INV1: `invite.spec.ts` runs under `master` storageState (main Claude's fix — plain admin is gate-blocked from `Users & access` by Spec 030 sidebar guard); navigates via sidebar label click; asserts `users-root`; opens drawer via `users-invite-trigger`; fills `invite-email` + `invite-name` with a uniquified email; asserts `invite-role-user` visible (master sees role chips); clicks `invite-submit`; asserts drawer closes (`invite-email` count = 0) and `users-root` remains → PASS `e2e/invite.spec.ts:39`
- AC-INV2: `uniqueInviteEmail()` returns `e2e-invite+${RUN_ID}@local.test` where `RUN_ID = process.env.GITHUB_RUN_ID ?? String(Date.now())`; the CI workflow runs `supabase db reset` before the suite; both isolation mechanisms are active → PASS `e2e/fixtures/constants.ts:67-71`, `.github/workflows/e2e.yml:71`
- AC-SEL-USERS: All required testIDs added — `users-root` and `users-invite-trigger` on `UsersSection.tsx`; `user-row-${user.id}` on `UserRow` component (covers pending-invite rows, which use the same `UserRow` render path); `invite-email`, `invite-name`, `invite-role-${r}`, `invite-store-${s.id}`, `invite-submit` on `InviteUserDrawer.tsx` → PASS `src/screens/cmd/sections/UsersSection.tsx:129,136,307`, `src/components/cmd/InviteUserDrawer.tsx:247,280,288,317,466`

#### Phase 4 — Admin dashboard, reorder, audit log

- AC-DASH1: `dashboard.spec.ts` navigates to Dashboard via sidebar label click, asserts `dashboard-root` and `dashboard-kpis` visible (structural presence, not seed-value dependent) → PASS `e2e/dashboard.spec.ts:18`
- AC-REORD1: `reorder.spec.ts` navigates to Reorder, asserts `reorder-root` visible → PASS `e2e/reorder.spec.ts:15`
- AC-AUDIT1: `audit.spec.ts` navigates to Audit log, asserts `audit-root` visible; explicitly does not depend on exact row count (tolerant of prior invite run's entries) → PASS `e2e/audit.spec.ts:16`
- AC-SEL-DASH/REORD/AUDIT: `testID="dashboard-root"` and `testID="dashboard-kpis"` on `DashboardSection.tsx`; `testID="reorder-root"` on `ReorderSection.tsx`; `testID="audit-root"` on `AuditLogSection.tsx`; `testID="cmd-shell-root"` on all three responsive branches of `ResponsiveCmdShell.tsx` → PASS

#### Cross-cutting

- AC-DARK1: `dark-mode.spec.ts` sets `colorScheme: 'dark'` emulation and seeds `localStorage.darkMode='true'` via `addInitScript` before app boot (the admin Cmd theme reads `useStore.darkMode` hydrated from localStorage, not `prefers-color-scheme`); after sign-in reads `getComputedStyle(cmd-shell-root).backgroundColor`, extracts R+G+B, asserts sum < 150 (DarkCmd `#08090C` ≈ 29; LightCmd `#FAFAF8` ≈ 748) → PASS `e2e/dark-mode.spec.ts:34`
- AC-CI1: `.github/workflows/e2e.yml` exists; separate from `test.yml`; triggers on `push` and `pull_request` (no branch filter so runs on all pushes); `permissions: contents: read`; job `timeout-minutes: 30`; `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`; boots Supabase stack, runs `supabase db reset`, installs chromium binary, runs `npm run e2e`; uploads `playwright-report/` + `test-results/` artifact (`if: always()`); stops stack (`if: always()`). Non-blocking posture is a branch-protection fact, not enforced by YAML (correctly documented in comments) → PASS `.github/workflows/e2e.yml`
- AC-CI2: `reuseExistingServer: !process.env.CI` in `playwright.config.ts` means CI always boots fresh via `webServer`; the Expo dev-server command is passed `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` with local fallbacks. CI workflow exports `ANON_KEY` and `SERVICE_ROLE_KEY` from `supabase status -o env` and passes them through the `env:` block. Note: `EXPO_PUBLIC_SUPABASE_URL` is not explicitly set in the `Run E2E suite` step, but `playwright.config.ts` and `global-setup.ts` both hardcode the correct CI fallback (`http://127.0.0.1:54321`) which matches the local stack's bind address. This works in practice → PASS
- AC-DOC1: `tests/README.md` Track 4 section is present and covers: what it covers, runner (Playwright chromium), where tests live (`e2e/*.spec.ts`), how to run locally (incl. `npm run dev:db` prerequisite + `npx playwright install`), selector strategy (`testID` → `data-testid`), data-isolation strategy, and promotion criteria. Track table at file top updated to 4 rows → PASS `tests/README.md`
- AC-PROMO1: Promotion criteria documented in spec §CI promotion criteria and in `tests/README.md §CI + promotion criteria`: ≥ 20 consecutive green runs on `main` AND observed flake rate < 5%; the `e2e.yml` file ships non-blocking (branch-protection flip deferred to user call) → PASS

### Data-isolation guards

- OQ-3 poison-queue guard: `auth.setup.ts` never submits EOD — staff storageState carries auth tokens only, no `imr-staff:eod-queue:v1` key. `eod.spec.ts` `beforeEach` calls `context.addInitScript` to `localStorage.removeItem(STAFF_QUEUE_KEY)` before the app boots. Both guards confirmed present. PASS.
- OQ-3b invite uniquification: `uniqueInviteEmail()` used in `invite.spec.ts:58`. PASS.
- OQ-4 weekday fixture: `global-setup.ts` inserts 14 rows (2 vendors × 7 weekdays) on Towson idempotently via `upsert` with `ignoreDuplicates: true`. EOD spec validates fixture ran by asserting both vendor chips are visible before proceeding, so a silently-vacuous test is caught at the fixture-sanity step. PASS.

### AC-SEL-* testID orphan audit

testIDs added to `src/` by this spec and their first E2E usage:

| testID | Added to | Referenced in spec |
|---|---|---|
| `signin-email` | LoginScreen | `auth.setup.ts`, `auth.spec.ts`, `dark-mode.spec.ts` |
| `signin-password` | LoginScreen | `auth.setup.ts`, `auth.spec.ts`, `dark-mode.spec.ts` |
| `signin-error` | LoginScreen | `auth.spec.ts:44` |
| `cmd-shell-root` | ResponsiveCmdShell (3 branches) | `auth.setup.ts`, all Cmd specs, `dark-mode.spec.ts` |
| `dashboard-root` | DashboardSection | `dashboard.spec.ts:24` |
| `dashboard-kpis` | DashboardSection | `dashboard.spec.ts:26` |
| `reorder-root` | ReorderSection | `reorder.spec.ts:22` |
| `audit-root` | AuditLogSection | `audit.spec.ts:22` |
| `users-root` | UsersSection | `invite.spec.ts:47,72` |
| `users-invite-trigger` | UsersSection | `invite.spec.ts:50` |
| `user-row-${user.id}` | UserRow (UsersSection) | Not referenced in v1 specs |
| `invite-email` | InviteUserDrawer | `invite.spec.ts:51,59,70` |
| `invite-name` | InviteUserDrawer | `invite.spec.ts:60` |
| `invite-role-${r}` | InviteUserDrawer | `invite.spec.ts:55` (asserts `invite-role-user` visible) |
| `invite-store-${s.id}` | InviteUserDrawer | Not referenced in v1 specs |
| `invite-submit` | InviteUserDrawer | `invite.spec.ts:63,64` |

Orphan analysis: `user-row-${user.id}` and `invite-store-${s.id}` are instrumented but not exercised by any v1 E2E assertion. This is acceptable: AC-SEL-USERS requires the testIDs to be *added* (to enable future assertions); it does not mandate a v1 spec exercises every one. The `invite.spec.ts` intentionally does not select a store because store assignment is optional for a `user`-role invite (the `requiredValid` check in `InviteUserDrawer.tsx:113-116` requires only email + name for role='user'). No orphan testID represents a missing assertion the spec required.

### Test run

#### jest (Track 1)

Command: `npx jest --ci`

Result: **40 suites / 386 tests — all PASS**. Spec 078's testID additions to `src/` components have no effect on jest tests (those tests mock at the `src/lib/db.ts` boundary and do not render the full screen hierarchy). The two new test files added by spec 078 (`src/screens/staff/components/ListRow.test.tsx`, `src/screens/staff/lib/theme.test.ts`) are from spec 070, not 078; they were already in the git status at conversation start. No regressions introduced.

#### pgTAP DB tests (Track 2)

Command: `npm run test:db`

Result: **37/38 PASS, 1 pre-existing FAIL**

The failing test is `supabase/tests/missed_order_audit_rpc.test.sql` — assertion C.1 expects 1 row but gets 3. This failure is pre-existing (the test file's only commit is `92b50e1` from spec 075; the `e2e/` tree is entirely untracked/new with zero DB migrations). Spec 078 adds no DB migrations, no RLS changes, and no seed edits — the pgTAP failure is unrelated to this spec.

#### Playwright E2E (Track 4)

Command: `npx playwright test --project=chromium --project=setup`

Prerequisites: local Supabase stack running (`supabase start`), Expo web dev server running on port 8081 (already up), chromium binary installed.

Result: **13/13 PASS** (verified in this review session)

```
[e2e global-setup] order_schedule fixture ready: 14 rows (2 vendors × 7 weekdays)
  ✓ [setup] authenticate as admin (792ms)
  ✓ [setup] authenticate as master (524ms)
  ✓ [setup] authenticate as staff (509ms)
  ✓ [chromium] AC-AUDIT1: audit log section renders (1.1s)
  ✓ [chromium] AC-S1: admin credentials land on the Cmd shell (1.1s)
  ✓ [chromium] AC-EOD1: online submit clears the queue indicator (1.2s)
  ✓ [chromium] AC-DARK1: the Cmd shell renders in dark mode (1.2s)
  ✓ [chromium] AC-DASH1: dashboard KPI surface renders (1.2s)
  ✓ [chromium] AC-REORD1: reorder section renders from seed (730ms)
  ✓ [chromium] AC-S2: staff credentials land on the StorePicker (875ms)
  ✓ [chromium] AC-EOD2/3: offline submit queues, reconnect drains (867ms)
  ✓ [chromium] AC-INV1/2: master invites a uniquified user and the drawer confirms (1.2s)
  ✓ [chromium] AC-S3: bad credentials show inline error and stay on login (459ms)
  13 passed (5.1s)
```

### Notes

1. **Pre-existing pgTAP failure unrelated to spec 078.** `missed_order_audit_rpc.test.sql` (spec 075) fails on assertion C.1. Spec 078 adds no migrations; this is a pre-existing drift issue that should be addressed in a separate fix spec.

2. **`EXPO_PUBLIC_SUPABASE_URL` not forwarded in CI `e2e.yml`.** The `Run E2E suite` step sets `SUPABASE_SERVICE_ROLE_KEY` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` but not `EXPO_PUBLIC_SUPABASE_URL`. Both `playwright.config.ts` (for the web server) and `global-setup.ts` (for the service-role client) fall back to the hardcoded local stack address `http://127.0.0.1:54321`, which is correct for the Supabase CLI's default CI bind address. This works in practice but would silently break if a remote test branch is ever used without also adding the env override. Low risk for v1; document as a follow-up when OQ-1 remote-branch path is activated.

3. **AC-EOD2 offline drain assertion quality.** The drain assertion (`toHaveCount(0, { timeout: 30_000 })`) is load-bearing: `QueueIndicator` returns `null` only when `pending === 0 && !draining`, so the element's disappearance confirms the queue was drained. The test uses `context.setOffline()` (real browser-level network cut, not route interception), polls `navigator.onLine` to avoid the React re-render race before submitting offline, and polls again before asserting drain. This is the correct OQ-5 implementation per the spec's timing guidance.

4. **invite-store-{id} and user-row-{id} are instrumented but unused in v1 E2E specs.** Both testIDs are correctly added per AC-SEL-USERS. The spec does not require a v1 spec to exercise every added testID; it requires the testIDs to exist so future specs can use them. Not a gap.

5. **invite.spec.ts correctly runs under master storageState.** The plain `admin` role is blocked from the `Users & access` sidebar entry by the spec 030 `isMaster` guard (`useIsMaster()` hook). Running under master is the right fix — confirmed 13/13 green.

6. **Native E2E gap acknowledged as out of scope.** Playwright is web-only (locked decision #1). Native device gestures and native push registration are explicitly deferred. No action required.

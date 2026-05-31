# Spec 078: Browser E2E test framework (Playwright, web-only)

Status: READY_FOR_REVIEW

## Problem / context

The repo has three test tracks (jest unit/component, pgTAP DB, shell smokes —
see [tests/README.md](../tests/README.md)). None of them exercise the *running
application through a browser*. Component tests mock at the `src/lib/db.ts`
boundary; they never prove that a real signed-in session, the navigation shell,
RLS, and the live Supabase stack compose into a working flow. The most
behaviorally-rich and regression-prone surfaces — sign-in role-branching, the
invite-user flow, and the staff EOD offline queue that drains on reconnect —
have no end-to-end coverage at all.

This spec introduces a **fourth test track: browser E2E via Playwright**, run
against the **web build** (react-native-web → Vercel target). Both the admin Cmd
UI and the staff EOD app run on react-native-web, so a single web-target E2E
suite covers the vast majority of application logic. It is wired as a
**separate, initially non-blocking CI workflow** so it can stabilize before it
gates merges.

This is a multi-day infrastructure investment. The flows are phased so the
harness + auth + one smoke land first (Phase 1), and the remaining critical
paths land incrementally on top of a proven harness (Phases 2-4). The end-state
v1 coverage is broad per the locked decision below.

### Locked strategic decisions (do not re-litigate — build around these)

1. **Framework: Playwright, web-only.** No Cypress. No Detox / native driver.
   Native-only behaviors (true device gestures, native push registration) are
   explicitly out of scope.
2. **CI model: a separate workflow, non-blocking at first.** New
   `.github/workflows/e2e.yml`. Runs on PRs and pushes to `main` but does NOT
   gate merge initially. Must NOT be folded into `test.yml` (which gates jest +
   the two typechecks + pgTAP). Promotion-to-required criteria defined below.
3. **v1 scope: broad — all critical paths.** Auth/sign-in, invite-user, staff
   EOD submit (including the offline queue), admin dashboard, reorder, and the
   audit log. Phased within this spec by dependency order (auth first).

## Grounding facts confirmed during scoping

- **`testID` maps to `data-testid` on web.** Confirmed in
  `node_modules/react-native-web/dist/modules/createDOMProps/index.js:831-832`
  (`domProps['data-testid'] = testID;`). Playwright `getByTestId()` defaults to
  the `data-testid` attribute, so RN `testID` props are directly addressable.
  `dataSet={{ foo: 'bar' }}` becomes `data-foo="bar"` (same file, line 757) —
  available as a fallback selector strategy if a component exposes `dataSet`
  instead of `testID`.
- **`testID` coverage is partial today.** 51 occurrences across 15 files. The
  staff EOD path is well-instrumented (`eod-submit`, `eod-store-name`,
  `eod-queue-indicator`, `eod-item-input-{id}`, `vendor-chip-{id}`,
  `store-row-{id}`, `store-picker-root`, etc. in
  [EODCount.tsx](../src/screens/staff/screens/EODCount.tsx) /
  [StorePicker.tsx](../src/screens/staff/screens/StorePicker.tsx)). The login
  screen has `signin-submit` + `signin-demo-*` but NOT the email/password
  inputs ([LoginScreen.tsx:143,156,166](../src/screens/LoginScreen.tsx)). The
  **admin critical-path sections named in v1 — DashboardSection, ReorderSection,
  AuditLogSection, UsersSection + InviteUserDrawer — have ZERO `testID`s today.**
  Only POSImports and a couple of modals are instrumented in the cmd surface.
  **Adding the missing selectors is part of this spec's work** (see AC-SEL-*).
- **Demo accounts exist in the local seed.** `admin@local.test`,
  `master@local.test`, `manager@local.test`, all password `password` (per
  user-memory note). E2E auth uses these against the **LOCAL** stack, never
  prod.
- **Login screen branches on role.** `signIn()` → `result.user.role === 'user'`
  takes the staff path (StorePicker / EOD); admin/master/super_admin take the
  admin Cmd path (LoginScreen.tsx:54-107). The E2E suite must cover both
  branches.
- **Web build / dev server.** `npx expo start --web --port 8081` for the dev
  server (matches `.claude/launch.json` `expo-web`). Production export is
  `npx expo export --platform web` → `dist/` (vercel.json). The local stack is
  `npm run dev:db` (`supabase start`); seed is the committed 286 KB
  `supabase/seed.sql`; reset is `npm run dev:db:reset` (`supabase db reset`).
- **The offline queue.** Staff EOD enqueues to AsyncStorage
  (`imr-staff:eod-queue:v1`) and drains FIFO on reconnect via
  [eodQueue.ts `drainQueue`](../src/screens/staff/lib/eodQueue.ts). On web,
  AsyncStorage is backed by `localStorage`. `drainQueue` stops on the first
  `network` outcome and resumes on the next connectivity flip — the E2E test
  must force offline, submit, force online, and assert the drain + the queue
  indicator clearing.

## User stories

- As a **developer**, I want a browser E2E suite I can run locally with one
  command (`npm run e2e`) against the local Supabase stack, so I can prove a
  critical flow still works end-to-end before opening a PR.
- As a **reviewer**, I want a non-blocking E2E CI job that runs on every PR and
  push to `main`, so regressions in sign-in, invite, EOD-offline, dashboard,
  reorder, and audit-log surface as a visible (initially advisory) signal with
  a trace artifact to debug from.
- As the **team**, I want a documented promotion path (flake budget + green-run
  threshold) so the E2E gate becomes a required merge check only once it has
  earned trust, without a judgment call in the moment.

## Acceptance criteria

Criteria are grouped by phase. Phases land in order; each phase's harness work
is reusable by later phases. The *end-state* (all phases merged) is the broad
v1 the user asked for.

### Phase 1 — Harness + auth + one smoke

Harness:
- [ ] AC-H1: `@playwright/test` is added as a devDependency in
      [package.json](../package.json) at a pinned major; `npx playwright install
      --with-deps chromium` is documented as the one-time browser-binary step
      (chromium-only in v1).
- [ ] AC-H2: A `playwright.config.ts` exists at the chosen suite root (see
      "Test-data isolation & suite location" — default `e2e/`). It configures:
      `webServer` to boot the Expo web dev server (`npx expo start --web --port
      8081`, `reuseExistingServer: !process.env.CI`, a generous
      `timeout` for cold Metro bundling); `use.baseURL` pointing at
      `http://localhost:8081`; `testIdAttribute: 'data-testid'`;
      `projects` for the auth-setup project + chromium; `retries: process.env.CI
      ? 2 : 0`; `trace: 'on-first-retry'`; a per-test `timeout` and a global
      run `timeout`.
- [ ] AC-H3: `npm run e2e`, `npm run e2e:headed`, and `npm run e2e:ui` scripts
      exist in [package.json](../package.json) and invoke `playwright test`,
      `playwright test --headed`, `playwright test --ui` respectively. The doc
      states the prerequisite: `npm run dev:db` must be running first (E2E does
      NOT boot the DB stack — only the web server via `webServer`).
- [ ] AC-H4: Playwright artifacts (`test-results/`, `playwright-report/`,
      `.auth/` storage-state dir, any `blob-report/`) are gitignored.

Auth (storageState + per-role setup project):
- [ ] AC-A1: An auth **setup project** logs in once per role via the real UI
      (fill email + password, click `signin-submit`, wait for the post-login
      landing surface) and writes `storageState` to a per-role file (e.g.
      `e2e/.auth/admin.json`, `e2e/.auth/staff.json`). At minimum `admin@local.test`
      and `manager@local.test` (a `role='user'` staff account) are covered;
      `master@local.test` is added if a privileged-only flow needs it.
- [ ] AC-A2: Flow specs declare `test.use({ storageState: 'e2e/.auth/<role>.json' })`
      and `dependencies: ['setup']` so they start already-signed-in. UI login is
      NOT repeated per test (except the dedicated sign-in spec below).
- [ ] AC-SEL-LOGIN: The login screen gains `testID`s on the email input,
      password input (LoginScreen.tsx:143,156), and the inline error box
      (LoginScreen.tsx:135-139) so the auth setup + the sign-in spec can target
      them with `getByTestId` rather than placeholder text.

Smoke (the Phase-1 "one example test"):
- [ ] AC-S1: A sign-in spec proves the **admin branch**: navigate to `/`, fill
      `admin@local.test` / `password`, submit, and assert the admin Cmd shell
      landing surface renders (a stable admin-shell selector — see AC-SEL-DASH).
- [ ] AC-S2: The same spec (or a sibling case) proves the **staff branch**:
      `manager@local.test` / `password` lands on the StorePicker or EOD screen
      (assert `store-picker-root` or `eod-store-name`, depending on whether the
      seed account has one store or many).
- [ ] AC-S3: A **bad-credentials** case asserts the inline error box renders and
      the user stays on the login screen (no navigation).

### Phase 2 — Staff EOD submit + offline queue (highest value, highest difficulty)

- [ ] AC-EOD1: Signed in as staff (storageState), select a vendor chip
      (`vendor-chip-{id}`), enter a count into at least one item input
      (`eod-item-input-{id}`), click `eod-submit`, and assert a success signal
      (the queue indicator clears / a success toast / the row reflects
      submission) **while online**.
- [ ] AC-EOD2: **Offline-then-drain.** Using Playwright `context.setOffline(true)`
      (and/or route interception of the EOD submit RPC), submit while offline and
      assert the item is **queued** (`eod-queue-indicator` shows a pending
      count). Then `context.setOffline(false)`, trigger the connectivity flip the
      app listens for, and assert the queue **drains** (indicator returns to
      empty; the submission is no longer pending). The assertion must confirm the
      drain actually happened, not merely that no error toast fired.
- [ ] AC-EOD3: A `data-testid`/`testID` exists for whatever element exposes the
      pending count so the offline assertion is not text-fragile. (The
      `eod-queue-indicator` testID exists; confirm it surfaces the pending count
      in an addressable way, add a child testID if needed.)
- [ ] AC-SEL-EOD: Any EOD selector the offline test needs that is missing today
      is added (audit `EODCount.tsx` against the test plan; most exist).

### Phase 3 — Invite-user flow

- [ ] AC-INV1: Signed in as admin, open the Users section, click the
      invite-user trigger, fill the invite drawer (email + role + store), submit,
      and assert a success signal (toast / the drawer closing / the new pending
      invite appearing in the list).
- [ ] AC-INV2: The invite spec is **isolated** per the data-isolation strategy
      (see below) — it MUST NOT leave a persistent invited user that breaks a
      re-run. Either it runs against a freshly-`db reset` DB, uses a uniquified
      email per run (`invite+<runId>@local.test`), or cleans up after itself.
      The chosen approach is documented in the spec deliverable + `tests/README.md`.
- [ ] AC-SEL-USERS: `UsersSection` + `InviteUserDrawer` gain `testID`s on: the
      invite trigger button (UsersSection.tsx:136), the drawer's email input,
      role selector, store selector, and submit button, and the pending-invite
      list rows. (Zero exist today — this is net-new instrumentation.)

### Phase 4 — Admin dashboard, reorder, audit log (read-heavy)

- [ ] AC-DASH1: Signed in as admin, navigate to the dashboard and assert its
      primary KPI/summary surface renders against seed data using a stable
      selector (not a seed-dependent dollar value — assert structure/presence,
      e.g. the KPI cards container is visible).
- [ ] AC-REORD1: Navigate to the reorder section and assert the reorder
      list/table renders from seed; assert at least one structural element
      (a row, an empty-state, or the section header) deterministically. If the
      flow includes an action (mark-ordered / generate PO), assert the action's
      visible effect; otherwise a render assertion is acceptable for v1.
- [ ] AC-AUDIT1: Navigate to the audit log and assert the log list renders
      (rows present, or a deterministic empty-state). Audit entries created by
      earlier mutating specs (e.g. invite) may appear — the assertion must not
      depend on an exact row count.
- [ ] AC-SEL-DASH/REORD/AUDIT: Stable container/landing `testID`s are added to
      DashboardSection, ReorderSection, and AuditLogSection (zero exist today).
      One shell-level selector that uniquely identifies "the admin Cmd shell has
      loaded" is added for the Phase-1 AC-S1 assertion.

### Cross-cutting

- [ ] AC-DARK1: One smoke test uses Playwright `colorScheme: 'dark'` emulation
      and asserts the app renders in dark mode (a dark-mode-specific selector or
      a computed background-color assertion on a known element). Rationale: specs
      070/072 shipped dark mode; a single guard test is cheap insurance. (Light
      mode is the default for all other specs.)
- [ ] AC-CI1: `.github/workflows/e2e.yml` exists, is **separate** from
      `test.yml`, runs on `pull_request` and `push`, and is **non-blocking**
      (not a required status check) in v1. It boots the local Supabase stack
      (`supabase/setup-cli@v1` + `supabase start`, mirroring `test.yml`'s `db`
      job), installs deps + the chromium binary, runs `npm run e2e`, uploads the
      Playwright HTML report + traces as an artifact (`if: always()`), and stops
      the stack (`if: always()`). It sets `permissions: contents: read`, a
      job-level `timeout-minutes`, and `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`
      to match the `test.yml` posture.
- [ ] AC-CI2: The workflow boots its own web server. Default: let Playwright's
      `webServer` config boot Expo in CI (`reuseExistingServer: false` when
      `CI`). If cold Metro start is too slow/flaky, the fallback (documented as
      an architect decision point) is to `expo export --platform web` and serve
      `dist/` statically — but v1 defaults to the dev server unless the architect
      chooses the export path.
- [ ] AC-DOC1: [tests/README.md](../tests/README.md) gains a **Track 4 — Browser
      E2E (Playwright)** section mirroring the existing track docs: what it
      covers, the runner, where tests live, how to run locally (incl. the
      `npm run dev:db` prerequisite + `npx playwright install`), the selector
      strategy (`testID` → `data-testid`), the data-isolation strategy, and the
      promotion criteria. The track table at the top is updated to 4 rows.
- [ ] AC-PROMO1: The spec documents the **promotion-to-required** criteria for
      flipping `e2e.yml` to a gating check: e.g. **N=20 consecutive green runs on
      `main`** AND **observed flake rate < 5%** over those runs, decided by the
      user. Until then the job is advisory. (Mirrors the `test.yml` `db` job's
      "NOT a required status check in v1; tighten once stability is observed"
      posture.)

## In scope

- A new Playwright-based browser E2E track, web-only, against the LOCAL Supabase
  stack with the committed seed.
- A `playwright.config.ts`, an auth-setup project producing per-role
  `storageState`, and the four phases of flow specs above.
- Net-new `testID` instrumentation on the login inputs, the admin Cmd shell
  landing surface, DashboardSection, ReorderSection, AuditLogSection,
  UsersSection, and InviteUserDrawer — only the selectors the E2E specs need.
- `npm run e2e` / `e2e:headed` / `e2e:ui` scripts.
- `.github/workflows/e2e.yml` — separate, non-blocking, with artifact upload.
- A `tests/README.md` Track 4 section + the promotion criteria.
- One dark-mode emulation smoke.
- The data-isolation / DB-reset strategy for the mutating flows (invite, EOD).

## Out of scope (explicitly)

- **Native (Detox/device) E2E.** Locked decision #1. True device gestures and
  native push registration are not testable via Playwright web and are deferred.
- **Cypress** or any non-Playwright runner. Locked decision #1.
- **Folding E2E into `test.yml`.** Locked decision #2 — it stays a separate
  workflow.
- **Making `e2e.yml` a required/gating check in v1.** It is advisory until the
  AC-PROMO1 criteria are met; flipping it is a follow-up the user authorizes.
- **A dedicated Supabase test branch / remote test DB.** v1 uses the local
  `dev:db` stack + committed seed (cheapest, matches the pgTAP precedent). A
  remote test branch is named as a deferred alternative in open questions, not
  built.
- **Visual-regression / screenshot-diff testing.** `toHaveScreenshot` baselines
  are intentionally deferred — RN-web pixel output is noisy across OS/font
  stacks and would generate flake. A future spec may add it for a tiny set of
  stable surfaces.
- **Exhaustive coverage of every Cmd section.** v1 covers the six named
  critical paths only. Other sections (Recipes, Vendors, POS imports, Waste,
  Reconciliation, etc.) are out of scope for v1 and land in later specs.
- **Backend / RPC / migration changes.** This spec adds test infra + frontend
  `testID`s only. No new RPCs, edge functions, or migrations. (If the chosen
  data-isolation strategy needs a seed-only test fixture, that is a seed/test
  artifact, not a prod migration — flagged as an open question for the
  architect.)
- **Changing the `app.json` slug.** Untouched; load-bearing per CLAUDE.md.

## Test-data isolation & DB-reset strategy (the thorny part)

**Decision for v1: run against the local `npm run dev:db` stack with the
committed `supabase/seed.sql`.** This matches the existing pgTAP/Track-2 and
Track-3 local-stack pattern, costs nothing extra, and uses the same demo
accounts already in the seed. A dedicated remote Supabase test branch is the
deferred alternative (open question OQ-1) — heavier to provision and not needed
for v1.

The hard part is that the broad v1 flows **mutate** data (EOD submit writes
counts; invite creates a pending user/invite; reorder may write a PO). A naive
re-run would either fail on a duplicate or accumulate drift. The architect must
choose and document a reset strategy. Recommended approach in priority order
(architect picks; defaults noted):

1. **CI: full `supabase db reset` before the E2E run** (clean, deterministic
   seed every CI run). This is the default for CI — the stack is ephemeral
   anyway. Cost: the reset + reseed adds time to an already-slow job; acceptable
   for a non-blocking job.
2. **Mutating specs use uniquified inputs** so they are re-run-safe locally
   without a reset between runs: invite uses `invite+<timestamp-or-runId>@local.test`;
   EOD writes to a date/vendor combination that the assertions key off the same
   run's `client_uuid` rather than asserting an absolute DB row count. This is
   the recommended default for the *invite* flow (AC-INV2) so a developer's
   local re-run doesn't require a reset every time.
3. **Per-suite cleanup hooks** (`afterAll` deletes what the spec created) — only
   if (1)+(2) prove insufficient. Cleanup hooks are themselves a flake source
   (they run even on failure); prefer reset + uniquification.

The EOD-offline flow's assertion keys off **the same run's queued item** (its
`client_uuid` and the indicator state), so it is naturally idempotent and does
NOT depend on a clean DB — but it DOES depend on `localStorage`/AsyncStorage
state. Playwright gives each test a fresh `BrowserContext` (fresh
`localStorage`), so the queue starts empty per test as long as the offline spec
does not share a context with another EOD spec. The architect must confirm the
storageState reuse (which seeds cookies/localStorage for auth) does not also
carry a stale queue — if it does, the EOD specs clear the queue key in a
`beforeEach`.

The architect's deliverable must state, explicitly: (a) does CI `db reset`
before E2E, yes/no; (b) the per-flow idempotency approach for invite and EOD;
(c) whether storageState carries any queue/localStorage that needs clearing.

## Suite location

**Decision: a top-level `e2e/` directory** (Playwright convention; keeps the
Playwright config, `.auth/` storage-state, fixtures, and specs together and
visually distinct from the jest `*.test.ts(x)` colocation and the
`supabase/tests/` pgTAP files). Rejected alternative: `tests/e2e/` — `tests/`
today holds jest setup + `babel-jest-dynamic-import.js` + the README, and
nesting a Playwright suite under it muddies the "one dir per track" mental
model. (`tests/README.md` remains the single docs landing page for all four
tracks regardless of where the specs live.)

## CI promotion criteria (AC-PROMO1, restated for prominence)

`e2e.yml` ships **non-blocking**. It is promoted to a **required status check**
only when BOTH hold, on the user's call:

- **>= 20 consecutive green `e2e.yml` runs on `main`** (the same "tighten once
  stability is observed" posture `test.yml`'s `db` job documents), AND
- **observed flake rate < 5%** across those runs (a run that goes green only on
  Playwright retry counts as a flake for this metric — `trace: 'on-first-retry'`
  makes retries visible in the report).

Until promoted, a red `e2e.yml` run does NOT block merge and does NOT block
SHIP_READY (it is not yet one of the gates the CLAUDE.md "CI status check"
rule covers — that rule is scoped to `test.yml`). When the user promotes it,
this spec's follow-up adds it to the required-checks set and the CLAUDE.md CI
rule is extended to name `e2e.yml`.

## Open questions resolved

- Q: Framework / web-vs-native? → A: **Playwright, web-only.** Locked by user.
- Q: CI — fold into `test.yml` or separate? → A: **Separate `e2e.yml`,
  non-blocking initially.** Locked by user.
- Q: v1 coverage breadth? → A: **Broad** — auth, invite, staff EOD + offline
  queue, dashboard, reorder, audit log. Locked by user, phased within this spec.
- Q: Suite location? → A: **Top-level `e2e/`** (auto-mode default; rationale
  above).
- Q: Auth — UI-login per test vs stored session? → A: **storageState with a
  per-role setup project** (auto-mode default; the dedicated sign-in spec still
  exercises real UI login for AC-S1/S2/S3).
- Q: Browser matrix? → A: **chromium-only in v1** (auto-mode default; Firefox /
  WebKit are a trivial config add later if cross-browser regressions surface).
- Q: Selector strategy? → A: **`getByTestId` against `data-testid`** (confirmed
  RN-web mapping); net-new `testID`s added where the named flows lack them.
- Q: Data isolation for v1? → A: **Local `dev:db` + committed seed**, with CI
  `db reset` (architect-confirmed) + per-flow uniquification for invite (default
  above). Remote test branch deferred (OQ-1).

## Open questions for the architect / user (genuinely strategic — surface, don't decide)

- **OQ-1 (deferred alternative, not v1):** Do we ever want a dedicated remote
  Supabase test branch instead of the local stack, for running E2E against a
  prod-shaped DB in CI? v1 says no (local stack); flagging so the architect can
  note the migration path rather than re-deciding later.
- **OQ-2 (architect decision):** CI web-server strategy — boot the Expo **dev
  server** via Playwright `webServer` (simpler, but cold Metro bundle is slow
  and a known flake source) vs **`expo export` → serve `dist/` statically**
  (closer to the Vercel prod artifact, faster steady-state, but adds a build
  step). v1 defaults to the dev server; architect may override with rationale.
- **OQ-3 (architect decision):** Does CI run `supabase db reset` before the E2E
  run (clean seed every run, slower) or rely solely on per-flow uniquification
  (faster, but invite-list assertions must tolerate accumulated rows)? Default:
  reset in CI. Architect confirms.
- **OQ-4 (possible seed/test artifact):** If any flow needs a fixture row the
  committed seed doesn't provide (e.g. a known pending reorder), is that added
  to `supabase/seed.sql` (affects every track + local dev) or to an E2E-only
  setup step that inserts via an authenticated client at runtime? Prefer the
  runtime insert to avoid mutating the shared seed; architect confirms.
- **OQ-5 (Phase-2 fidelity):** For the offline-queue drain, is
  `context.setOffline(true)` sufficient, or must we additionally intercept the
  specific EOD-submit RPC route to force the `network` outcome deterministically?
  `@react-native-community/netinfo` on web reads `navigator.onLine`;
  `setOffline` flips that, but the architect should confirm the staff app's
  connectivity hook (`useConnectionStatus`) reacts to it in the web build, and
  fall back to route interception if not.

## Dependencies

- New devDependency: `@playwright/test` (pinned major) + the chromium browser
  binary (`npx playwright install --with-deps chromium`, one-time / CI step).
- The local Supabase stack (`npm run dev:db`) + committed `supabase/seed.sql`
  with the demo accounts (`admin@local.test`, `manager@local.test`,
  `master@local.test`, password `password`).
- The Expo web build path (`expo start --web` for dev; `expo export --platform
  web` as the OQ-2 fallback).
- Frontend `testID` additions across LoginScreen, the admin Cmd shell,
  DashboardSection, ReorderSection, AuditLogSection, UsersSection, and
  InviteUserDrawer (in-repo; no backend coupling).
- No new RPCs, edge functions, or migrations.

## Project-specific notes

- **Cmd UI section / legacy:** Touches the admin Cmd surface
  ([src/screens/cmd/sections/](../src/screens/cmd/sections/)) and the staff
  surface ([src/screens/staff/](../src/screens/staff/)) for `testID`
  instrumentation only — no behavior change, no legacy surface involved (spec
  025 deleted it).
- **Per-store or admin-global:** The E2E flows exercise both — admin-global
  surfaces (invite, audit log, dashboard) as admin/master, and per-store
  surfaces (staff EOD scoped by `auth_can_see_store()` / `user_stores`) as the
  `manager@local.test` staff account. The suite is validating the existing RLS
  composition end-to-end, not changing scope.
- **Realtime channels touched:** None directly. The staff stack does not use
  realtime in v1 (per spec 062), and the admin realtime sync (`store-{id}` /
  `brand-{id}`) is incidental — E2E specs assert post-action state, not live
  cross-client propagation. Risk note: if a future E2E spec asserts realtime
  propagation, the CLAUDE.md realtime-publication gotcha (mid-session pub
  changes need a `docker restart supabase_realtime_imr-inventory`) applies.
- **Migrations needed:** No.
- **Edge functions touched:** None. (The invite flow calls `send-invite-email` /
  the invite RPC through the existing app code path; the E2E test exercises it
  black-box via the UI, it does not modify the function.)
- **Web/native scope:** **Web only** — locked decision #1. Native E2E is
  explicitly out of scope.
- **Tests:** This spec ADDS Track 4 (browser E2E / Playwright) to the three
  existing tracks (jest / pgTAP / shell smokes). The test-engineer routes E2E
  coverage to this new track; the `testID` additions to existing components do
  not require new jest tests (they are non-behavioral attributes), though a
  component-test reviewer may spot-check that no existing jest assertion keyed
  on the absence of a `testID` breaks.
- **CI:** New `.github/workflows/e2e.yml`, separate from `test.yml`,
  non-blocking in v1. Mirrors `test.yml`'s `db`-job stack boot + the
  `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` + least-privilege `permissions` posture.

---

## Backend / Frontend design

Author: backend-architect. This is test infrastructure: there is **no DB
migration, no RPC, no edge-function change** (confirmed against the spec's
"Out of scope" + verified below). The "data model" section is therefore about
*test fixtures and seed reality*, not schema. The architecture surface is real
nonetheless: a new CI workflow, a web-server boot strategy, a DB-isolation
strategy, and net-new `testID` instrumentation in **production** components.

The five open questions are resolved first (each grounded in code I read), then
the concrete shapes the two developers implement.

### 0. Scope confirmation against the existing system

- **No `src/lib/db.ts` change.** E2E specs drive the app through the browser;
  they never import `db.ts` and never call `supabase.from/rpc` from app code.
  The one place a test *does* touch the DB directly is the runtime fixture
  setup (OQ-4), which runs in the Playwright/Node process via a `@supabase/
  supabase-js` service-role client in the `e2e/` tree — that is test code, not
  an app carve-out, so it does not widen the `db.ts` centralization rule.
- **No edge-function change.** The invite flow reaches `send-invite-email` /
  the invite RPC through the existing `inviteUser()` in
  [src/lib/auth.ts](../src/lib/auth.ts) → `callEdgeFunction`. The E2E test
  exercises that path black-box via the UI. No `verify_jwt` setting, no
  service-token validation, no `_shared/` module is touched. (Stated explicitly
  because the architect rubric asks for the `verify_jwt` posture of any
  new/modified function — answer: **none modified**.)
- **No realtime publication change.** The CLAUDE.md
  `docker restart supabase_realtime_imr-inventory` gotcha does **not** apply:
  this spec adds no migration and changes no `supabase_realtime` membership.
  Staff has no realtime (spec 062); admin realtime is incidental and no E2E
  spec asserts cross-client propagation. If a *future* E2E spec asserts
  realtime, that spec re-engages the gotcha — out of scope here.

### 1. Open-question resolutions

#### OQ-1 — Remote Supabase test branch: **stays DEFERRED. Confirmed.**

v1 runs against the local `npm run dev:db` stack + committed `supabase/seed.sql`,
exactly as Tracks 2 and 3 do (`test.yml`'s `db` job boots `supabase start`; see
[.github/workflows/test.yml:115-143](../.github/workflows/test.yml)). A remote
branch buys a prod-shaped DB but costs provisioning, a second set of secrets,
and a slower, network-dependent job — none justified for a non-blocking v1.

Migration path when/if it is wanted later (noted so it isn't re-decided): the
`playwright.config.ts` `webServer.env` and the fixture setup client both read
`EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` + a service-role
key from env. Pointing those at a branch URL is a CI-secret + env swap, not a
code change. Keep the URL/keys env-sourced (never hard-coded) so the swap stays
config-only.

#### OQ-2 — CI web-server strategy: **dev server (`expo start --web`) for v1.**

Two candidates, decided in favor of the dev server, with a documented fallback.

**Decision: Playwright `webServer` boots `npx expo start --web --port 8081`**
(matches `.claude/launch.json`'s `expo-web` config — verified). Rationale:

1. **Parity with how the team already runs the app.** Every preview/dev
   workflow and the launch.json configs use the dev server on 8081. The E2E
   suite testing the same server the team eyeballs is the lower-surprise choice.
2. **`__DEV__`-gated demo accounts.** [LoginScreen.tsx:180](../src/screens/LoginScreen.tsx)
   wraps the demo-account quick-login buttons in `{__DEV__ && ...}`. A static
   `expo export` build sets `__DEV__ = false`, so those buttons **vanish** in
   the prod artifact. The auth-setup project does NOT rely on the demo buttons
   (it fills email+password and clicks `signin-submit` — see §3), so this is not
   a blocker, but it is a behavioral divergence that makes the export build
   subtly different from what developers see. The dev server keeps the surfaces
   identical.
3. **One build path, fewer moving parts.** The export path adds an
   `expo export --platform web` step (~the Vercel build) + a static file server
   to every CI run and every local invocation. For a non-blocking job that's net
   negative complexity in v1.

**Cost accepted:** cold Metro bundling is slow (tens of seconds) and is a known
flake source. Mitigations baked into the config: a generous `webServer.timeout`
(180s) for cold bundle, `reuseExistingServer: !process.env.CI` (local reuses a
running 8081; CI always boots fresh), and `retries: 2` in CI.

**Documented fallback (architect decision point, AC-CI2):** if cold Metro start
proves too slow/flaky across the first ~10 CI runs, switch `webServer.command`
to a two-step `expo export --platform web && npx serve -s dist -l 8081` (or
equivalent static server) — the **static export** path. This is closer to the
Vercel prod artifact and faster steady-state. It is a config-only change (swap
`command`, keep `port`/`url`/`reuseExistingServer`), so promoting it later does
not touch any spec. The `__DEV__` divergence above must be re-checked if/when
the suite ever needs the demo buttons (it shouldn't). **v1 ships the dev
server; the fallback is documented, not built.**

#### OQ-3 — DB isolation for mutating flows: **CI `db reset` + per-flow uniquification; storageState does NOT carry the queue.**

Three sub-answers the deliverable must state explicitly (per the spec's §
"Test-data isolation"):

**(a) Does CI `db reset` before E2E? — YES, once, before the run.**
The `e2e.yml` job runs `supabase db reset` after `supabase start` and before
`npm run e2e`, so every CI run starts from the committed seed. The stack is
ephemeral in CI so the reset cost (reseed of the 286 KB seed) is acceptable for
a non-blocking job. This is the cheapest *reliable* baseline — it makes
invite-list and audit-log assertions deterministic without per-test cleanup
hooks. **Locally**, `db reset` is NOT forced by `npm run e2e` (the script only
boots the web server; the dev stack + its data are the developer's, per AC-H3) —
local re-run safety comes from uniquification (b).

**(b) Per-flow idempotency:**
- **Invite (AC-INV2):** uniquified email per run —
  `e2e-invite+<runId>@local.test`, where `runId` is a Playwright-run-scoped
  token (e.g. `Date.now()` captured once in a fixture, or
  `process.env.GITHUB_RUN_ID` in CI). The assertion keys off *that* email
  appearing in the pending-invite list / the success toast, never an absolute
  row count. This makes a developer's local re-run safe without a `db reset`
  every time, and makes the CI run safe even if the reset is ever skipped.
- **EOD (AC-EOD1/2):** the assertion keys off the **same run's** `client_uuid`
  and the queue-indicator state, which is naturally idempotent (a new submit
  generates a fresh `uuidv4` in [useEodSubmit.ts:235](../src/screens/staff/hooks/useEodSubmit.ts)).
  EOD writes to a dedicated e2e store + today's date (see OQ-4); re-runs upsert
  on `(store, date, vendor)` via `staff_submit_eod`'s `p_client_uuid` conflict
  path, so they do not accumulate duplicate rows.

**(c) storageState and the offline queue — the poison-queue risk, resolved.**
The PM flagged that a logged-in staff `storageState` could carry a half-drained
offline queue from a prior run and poison the next. I traced this:

- The queue lives in `AsyncStorage` under key `imr-staff:eod-queue:v1`
  ([eodQueue.ts:20](../src/screens/staff/lib/eodQueue.ts)). On web, AsyncStorage
  is backed by `localStorage`.
- Playwright `storageState` **does** serialize `localStorage` (it captures
  cookies + origin localStorage). So a naive "save storageState after a staff
  session that queued an item" WOULD carry the queue into the next test. The
  risk is real.
- **Resolution — two guards, belt and suspenders:**
  1. The **auth-setup project logs in and stops** — it fills credentials,
     clicks `signin-submit`, waits for the post-login landing surface, and saves
     storageState. It performs **no EOD submit**, so the queue key is never
     written during setup. The saved `e2e/.auth/staff.json` therefore contains
     auth tokens but an empty (absent) queue key by construction.
  2. The EOD specs additionally **clear the queue key in `beforeEach`** via
     `page.addInitScript` (or `context.addInitScript`) that runs
     `window.localStorage.removeItem('imr-staff:eod-queue:v1')` before the app
     boots — defense in depth, so even if a future setup step or a shared
     context ever writes the key, each EOD test starts from an empty queue.
  Playwright also gives each test a **fresh `BrowserContext`** by default, so
  cross-test localStorage bleed only happens through the explicitly-loaded
  `storageState` file — which guard (1) keeps clean. Net: the queue starts empty
  per EOD test. **The deliverable states: storageState carries auth only; the
  EOD specs clear the queue key in `beforeEach` as defense in depth.**

#### OQ-4 — Seed vs runtime fixture, and the weekday-determinism problem: **runtime fixture insert; do NOT mutate the shared seed.**

I read the entire seed insert list. **The committed `supabase/seed.sql` contains
ZERO `order_schedule` rows and ZERO `eod_submissions` rows** (grep for
`order_schedule` / `day_of_week` against the seed returns nothing; the full
insert set is auth.users, profiles, stores, user_stores, vendors,
recipe/ingredient_categories, brands, catalog_ingredients, inventory_items,
ingredient_conversions, recipes, prep_recipes, recipe_ingredients,
recipe_prep_items, prep_recipe_ingredients — verified by line). The PM's
"Frederick+Thursday" note described an older local state that the current seed
does not reproduce.

**Consequence:** the staff EOD "today" flow renders **no vendor chips and no
item inputs for any weekday** against the committed seed, because
`fetchVendorsForToday(storeId, todayWeekday())`
([EODCount.tsx:82-112](../src/screens/staff/screens/EODCount.tsx)) reads
`order_schedule` at `(store_id, day_of_week)` and finds nothing. AC-EOD1/2 are
**not satisfiable against the raw seed.** This is the weekday-determinism
problem and it must be solved by the harness, not assumed away.

**Decision: an E2E-only runtime fixture (not a seed edit).** A setup step (a
dedicated Playwright `globalSetup` or a `fixture-setup` project that runs once
before the EOD specs) uses a **service-role** `supabase-js` client to insert,
**idempotently** (`on conflict do nothing` semantics via upsert):

1. A **dedicated e2e store** OR reuse of the seed's **Towson** store
   (`00000000-0000-0000-0000-000000000001`), which the manager account is
   assigned to ([seed.sql:199](../supabase/seed.sql)) and which already has
   `inventory_items` with populated `vendor_id`s
   ([seed.sql:401-414](../supabase/seed.sql)). **Reuse Towson** — it already has
   items, an existing store-access grant for `manager@local.test`, and avoids a
   new `user_stores` insert. (A brand-new e2e store would need its own
   inventory_items, which is more fixture to maintain.)
2. An `order_schedule` row at `(Towson, <every weekday>, <vendor V>)` where
   `V` is a vendor that has `inventory_items` at Towson — e.g. **US FOOD**
   (`023cba00-1b67-4218-a906-cb18a8e62964`), which several Towson items list as
   `vendor_id`. **Insert a row for all 7 weekdays** (Sunday..Saturday) so the
   test is deterministic regardless of which weekday CI runs on. This is the
   clean fix for the determinism problem: one vendor scheduled every day → the
   EOD screen always has chips+items for "today".

The fixture is owned by the harness (backend-developer) and lives in
`e2e/fixtures/` (e.g. `seedOrderSchedule.ts`). It is **not** added to
`supabase/seed.sql`, because the seed feeds all four tracks + local dev, and
spec policy (per the PM's OQ-4 framing) prefers a runtime insert over mutating
the shared seed. The insert must be idempotent so re-runs and a `db reset` both
converge.

**Note on the single-vendor vs >1-vendor render branch:** with exactly one
scheduled vendor, EODCount does **not** render the vendor switcher
([EODCount.tsx:456](../src/screens/staff/screens/EODCount.tsx) gates on
`vendors.length > 1`), and it auto-selects the sole vendor
([EODCount.tsx:213](../src/screens/staff/screens/EODCount.tsx)). AC-EOD1 says
"select a vendor chip (`vendor-chip-{id}`)". To exercise the chip selector the
fixture should schedule **two** vendors for the e2e store on every weekday
(e.g. US FOOD + RESTAURANT DEPOT, both of which have Towson items), so the
`vendor-chip-{id}` elements actually render. If the test plan is content to
assert the item inputs + submit without the chip (single vendor), schedule one;
the architect's recommendation is **two vendors** so AC-EOD1's chip-select step
is literally testable. Either way, the items list is non-empty because both
vendors have Towson inventory_items.

**Invite + dashboard + reorder + audit fixtures:** none needed beyond the seed.
- Invite (Phase 3) needs only a clean target email — solved by uniquification
  (OQ-3b), no fixture row.
- Dashboard / Reorder / Audit (Phase 4) are read-heavy and assert **structure/
  presence** against seed data (KPI cards container visible, reorder list/
  empty-state present, audit list/empty-state present), not seed-dependent
  values — the seed's stores + inventory_items + (synthetic) audit entries are
  sufficient. AuditLog tolerates rows created by the invite spec (assertion is
  presence, not count, per AC-AUDIT1).

#### OQ-5 — Offline-queue test fidelity: **`context.setOffline(true)` IS sufficient on web. The hook reacts.**

This is the make-or-break feasibility question, and I traced the full chain.

The connectivity signal on web is `window.addEventListener('online'|'offline')`:
[useConnectionStatus.ts:52-61](../src/screens/staff/hooks/useConnectionStatus.ts)
runs the **web branch** (`Platform.OS === 'web'`) and subscribes to the DOM
`online`/`offline` window events; the initial state seeds from
`navigator.onLine`. The native NetInfo branch never executes in the web bundle.

Playwright's `context.setOffline(true)` flips the browser's network emulation
**and dispatches the `offline` DOM event** (and `online` on `setOffline(false)`)
on every page in the context — this is exactly the signal
`useConnectionStatus` listens for. **So `setOffline` flips the hook.** No test
hook, no route interception is required for the basic offline→queue→drain flow.

The drain chain that fires on reconnect, traced end to end:
`context.setOffline(false)` → `online` DOM event → `useConnectionStatus`
`setConnected(true)` → `useEodSubmit` **Effect 1** detects the false→true
transition and calls `drain()`
([useEodSubmit.ts:212-218](../src/screens/staff/hooks/useEodSubmit.ts)) →
`drain()` walks the queue FIFO, calls `staff_submit_eod` per item, dequeues
successes, and the `QueueIndicator` clears when `pendingCountForUser === 0`
([QueueIndicator.tsx:21](../src/screens/staff/components/QueueIndicator.tsx)
returns `null` when `pending === 0 && !draining`). This is a clean,
browser-observable, deterministic drain. **AC-EOD2 is feasible as specified.**

**Two subtleties the spec author of the EOD spec must handle (call-outs, not
blockers):**

1. **`submit()` reads `isOnline` from a captured closure.** When offline,
   `submit()` checks `if (!isOnline)` synchronously and enqueues without hitting
   the network ([useEodSubmit.ts:259-262](../src/screens/staff/hooks/useEodSubmit.ts)).
   `isOnline` is a dependency of the `submit` callback
   ([useEodSubmit.ts:290](../src/screens/staff/hooks/useEodSubmit.ts)), so after
   `setOffline(true)` the test must **wait for React to re-render** (the
   `offline` event → state update → `submit` re-memoized) before clicking
   `eod-submit`. The robust way: after `setOffline(true)`, assert a UI signal
   that the offline state has propagated before submitting — but there is no
   dedicated "you are offline" badge today. Practical approach: a short
   `expect.poll`/`waitForFunction` on `() => navigator.onLine === false`, then
   click. (This is timing hygiene, standard Playwright practice, not a code
   gap.)
2. **Defense-in-depth route interception is available but NOT required.** If the
   bare `setOffline` approach ever proves flaky (e.g. a request races the
   emulation flip), the EOD spec MAY additionally `page.route()` the
   `staff_submit_eod` RPC endpoint (`**/rest/v1/rpc/staff_submit_eod`) to abort
   with a network failure while "offline", giving fully deterministic control of
   the `network` outcome. This is the documented fallback; v1 starts with plain
   `setOffline` per the resolution above.

**Bottom line for OQ-5: the offline-queue E2E is cleanly testable at the browser
layer.** It does NOT need to be demoted to jest. (The jest track still covers the
queue's unit behavior — `eodQueue.ts` drain logic — independently; that is
existing/peer coverage, not a substitute, and out of this spec's scope.)

### 2. `playwright.config.ts` (concrete shape)

Lives at repo root (Playwright's default discovery), `testDir: './e2e'`.
Pinned major: **`@playwright/test` `^1.x`** (current stable line). Shape the
developers implement (pseudocode, not committed code):

```
defineConfig({
  testDir: './e2e',
  testIdAttribute: 'data-testid',          // RN testID → data-testid (confirmed mapping)
  fullyParallel: false,                    // serial: shared local DB; avoids invite/EOD cross-talk
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined, // 1 worker in CI — one shared local stack
  timeout: 60_000,                         // per-test
  globalTimeout: 15 * 60_000,              // whole-run guard (mirrors test.yml job timeouts)
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]   // html artifact + GH annotations
    : [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: 'http://localhost:8081',
    trace: 'on-first-retry',
    // colorScheme defaults to 'light'; the dark smoke overrides per-test.
  },
  webServer: {
    command: 'npx expo start --web --port 8081',
    url: 'http://localhost:8081',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,                      // cold Metro bundle budget
    env: {                                 // local stack URL + anon key (OQ-1 env-sourcing)
      EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '<local anon key>',
    },
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },     // logs in each role, writes storageState
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
```

Notes:
- **`fullyParallel: false` + `workers: 1` in CI** is deliberate: a single local
  Supabase stack is shared, and the invite/EOD specs mutate it. Serial execution
  removes an entire class of cross-spec flake for v1. (Parallelism can be
  reintroduced later behind per-worker uniquification.)
- The **`setup` project** produces both `e2e/.auth/admin.json` and
  `e2e/.auth/staff.json`; `master.json` only if a Phase-3 privileged-only path
  needs it (the manager account is `role='user'`; the admin account suffices for
  invite as admin). Flow specs set `test.use({ storageState: 'e2e/.auth/<role>.json' })`.
- The fixture insert for EOD (OQ-4) runs either in a `globalSetup` script (set
  `globalSetup: './e2e/global-setup.ts'`) or as a dependency project ordered
  before the EOD spec. **Recommendation: `globalSetup`** — it runs once per run,
  before any project, with no browser, and is the natural home for a
  service-role DB insert.

### 3. Auth setup project + storageState (concrete shape)

`e2e/auth.setup.ts` (the `setup` project body), one test per role:

```
setup('authenticate as admin', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('signin-email').fill('admin@local.test');
  await page.getByTestId('signin-password').fill('password');
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('cmd-shell-root')).toBeVisible();   // AC-SEL-DASH shell anchor
  await page.context().storageState({ path: 'e2e/.auth/admin.json' });
});

setup('authenticate as staff', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('signin-email').fill('manager@local.test');
  await page.getByTestId('signin-password').fill('password');
  await page.getByTestId('signin-submit').click();
  // manager is assigned to TWO stores (Towson + Frederick, seed.sql:199-200)
  // → lands on StorePicker, NOT directly on EOD.
  await expect(page.getByTestId('store-picker-root')).toBeVisible();
  await page.context().storageState({ path: 'e2e/.auth/staff.json' });
});
```

**Verified seed fact driving AC-S2:** `manager@local.test` (`role='user'`) is
granted **two** stores — Towson + Frederick ([seed.sql:198-200](../supabase/seed.sql)).
Per [StaffStack.tsx:79-105](../src/screens/staff/navigation/StaffStack.tsx) +
[LoginScreen.tsx:88-97](../src/screens/LoginScreen.tsx), two stores with no
persisted active store → **StorePicker** renders, not EODCount. So **AC-S2 must
assert `store-picker-root`**, and the EOD specs (Phase 2) must first **tap a
`store-row-{id}`** to reach EODCount. The spec's AC-S2 already hedges "depending
on whether the seed account has one store or many" — the answer is **many →
StorePicker**. (Note: the setup project saves storageState while on StorePicker;
the EOD spec then navigates picker → EOD by tapping a store row. The active
store is persisted to `localStorage` key `imr-staff:active-store:v1`; if the EOD
beforeEach clears the queue key, leave the active-store key alone or set it so
the EOD test lands on EOD deterministically.)

### 4. `.github/workflows/e2e.yml` (concrete shape)

Separate file, mirrors `test.yml`'s `db` job for the stack boot. Non-blocking
(it simply is not added to the branch's required-checks set — there is nothing
in the YAML that makes it "non-blocking", that's a repo-settings fact; the YAML
just runs). Shape:

```
name: e2e
on:
  push:
  pull_request:
permissions:
  contents: read                       # least-privilege; reads source + runs tests only
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true   # matches test.yml posture (spec 047)
jobs:
  e2e:
    name: Track 4 — Playwright (web)
    runs-on: ubuntu-latest
    timeout-minutes: 30               # generous: supabase boot + reset + cold Metro + suite
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      - name: Start Supabase stack
        run: supabase start
      - name: Reset DB to committed seed          # OQ-3(a)
        run: supabase db reset
      - name: Install Playwright chromium
        run: npx playwright install --with-deps chromium
      - name: Run E2E suite
        run: npm run e2e
        env:
          CI: true
          # EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY default to the local stack in
          # playwright.config.ts; the service-role key for the OQ-4 fixture is
          # read from the local `supabase status` output / a step that exports it.
      - name: Upload Playwright report + traces
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: |
            playwright-report/
            test-results/
          retention-days: 7
      - name: Stop Supabase stack
        if: always()
        run: supabase stop --no-backup
```

Open detail for the developer: the **service-role key** for the OQ-4 fixture
insert. Locally and in CI the local stack's service-role key is fixed/derivable
from `supabase status`; the global-setup reads it from env
(`SUPABASE_SERVICE_ROLE_KEY`) exported by a CI step that parses `supabase status`,
or uses the well-known local demo service key. Keep it env-sourced; never commit
it. (It is the *local* stack key, not a prod secret.)

**Promotion-to-required criteria (AC-PROMO1, the gating-flip rule):** `e2e.yml`
ships advisory. It is promoted to a required status check only when BOTH hold,
on the user's call: **>= 20 consecutive green `e2e.yml` runs on `main`** AND
**observed flake rate < 5%** across those runs (a run that goes green only on
Playwright retry counts as a flake; `trace: 'on-first-retry'` makes retries
visible). Until promoted, a red `e2e.yml` does NOT block merge and does NOT block
SHIP_READY (the CLAUDE.md "CI status check" rule is scoped to `test.yml` only).
When the user promotes it, the follow-up adds it to required-checks and extends
the CLAUDE.md CI rule to name `e2e.yml`.

### 5. `package.json` scripts + devDependency

- devDependency: `"@playwright/test": "^1.x"` (pin the major).
- Scripts (AC-H3):
  - `"e2e": "playwright test"`
  - `"e2e:headed": "playwright test --headed"`
  - `"e2e:ui": "playwright test --ui"`
- Doc note (in `tests/README.md` Track 4 + the script comments): **`npm run
  dev:db` must be running first** locally — `npm run e2e` boots only the web
  server (via `webServer`), not the DB stack. CI boots the stack itself in the
  workflow.

### 6. `.gitignore` additions (AC-H4)

[.gitignore](../.gitignore) does not yet exclude Playwright artifacts. Add:
```
# Playwright (spec 078)
/test-results/
/playwright-report/
/blob-report/
/e2e/.auth/
```
(`/e2e/.auth/` holds the per-role storageState JSON, which carries live auth
tokens — must never be committed.)

### 7. testID instrumentation checklist (the AC-SEL-* work — NET-NEW PRODUCTION SOURCE EDITS)

This is the only change to production source. Each is a non-behavioral
attribute add. **Enumerated so the FE developer has an exact checklist.** Every
`testID` maps to `data-testid` on web (verified via react-native-web
`createDOMProps`), so `getByTestId('<id>')` addresses it.

| # | File | Element | testID to add | AC |
|---|------|---------|---------------|-----|
| 1 | [LoginScreen.tsx:143](../src/screens/LoginScreen.tsx) | email `TextInput` | `signin-email` | AC-SEL-LOGIN |
| 2 | [LoginScreen.tsx:156](../src/screens/LoginScreen.tsx) | password `TextInput` | `signin-password` | AC-SEL-LOGIN |
| 3 | [LoginScreen.tsx:135-139](../src/screens/LoginScreen.tsx) | inline error box `View` | `signin-error` | AC-SEL-LOGIN, AC-S3 |
| 4 | [ResponsiveCmdShell.tsx](../src/screens/cmd/ResponsiveCmdShell.tsx) — the desktop/tablet/phone root `<View style={{ flex: 1, backgroundColor: C.bg }}>` (lines 361 / 400 / 458) | shell root wrapper | `cmd-shell-root` | AC-SEL-DASH (shell anchor), AC-S1 |
| 5 | [DashboardSection.tsx](../src/screens/cmd/sections/DashboardSection.tsx) — section root `<View>` (the one wrapping `TabStrip` + content) | dashboard container | `dashboard-root` | AC-SEL-DASH, AC-DASH1 |
| 6 | DashboardSection — the KPI cards container `View` | KPI cards row | `dashboard-kpis` | AC-DASH1 (assert presence, not values) |
| 7 | [ReorderSection.tsx](../src/screens/cmd/sections/ReorderSection.tsx) — section root `<View>` | reorder container | `reorder-root` | AC-SEL-REORD, AC-REORD1 |
| 8 | [AuditLogSection.tsx](../src/screens/cmd/sections/AuditLogSection.tsx) — section root `<View>` | audit container | `audit-root` | AC-SEL-AUDIT, AC-AUDIT1 |
| 9 | [UsersSection.tsx:135-148](../src/screens/cmd/sections/UsersSection.tsx) | `+ INVITE USER` `TouchableOpacity` | `users-invite-trigger` | AC-SEL-USERS, AC-INV1 |
| 10 | UsersSection — the section root `<View style={{ flex: 1 }}>` (line 129) | users container | `users-root` | AC-SEL-USERS |
| 11 | UsersSection — pending-invite list rows (the row component in the lower part of the file, not shown above) | per-row | `invite-row-{id}` or `user-row-{id}` | AC-SEL-USERS, AC-INV1 |
| 12 | [InviteUserDrawer.tsx:278](../src/components/cmd/InviteUserDrawer.tsx) — Email `Field` | thread `testID` through `Field` → its `TextInput` | `invite-email` | AC-SEL-USERS, AC-INV1 |
| 13 | InviteUserDrawer Display-name `Field` (line 285) | via `Field` testID prop | `invite-name` | AC-SEL-USERS |
| 14 | InviteUserDrawer role selector `TouchableOpacity`s (line 309-344) | per-role | `invite-role-{user|admin}` | AC-SEL-USERS, AC-INV1 |
| 15 | InviteUserDrawer store-checkbox `TouchableOpacity`s (line 457-503) | per-store | `invite-store-{id}` | AC-SEL-USERS, AC-INV1 |
| 16 | InviteUserDrawer SEND button (line 246) | submit `TouchableOpacity` | `invite-submit` | AC-SEL-USERS, AC-INV1 |

**Implementation notes for the FE developer:**
- **#12/#13 require threading a prop.** The `Field` helper
  ([InviteUserDrawer.tsx:513](../src/components/cmd/InviteUserDrawer.tsx)) is a
  shared inner component with no `testID` prop. Add an optional `testID?: string`
  to `Field`'s props and pass it to the inner `TextInput`. Both invite fields
  then pass their respective testID. This is the one "structural" edit (a prop
  add); the rest are leaf attribute adds.
- **#4 shell anchor** must be on a wrapper that renders on **all three
  breakpoints** so AC-S1 is breakpoint-agnostic. The cleanest single home is the
  outer `<View style={{ flex: 1, backgroundColor: C.bg, overflow: 'hidden' }}>`
  that each of the three tier branches returns — give all three the same
  `testID="cmd-shell-root"`. (Playwright runs `Desktop Chrome` → desktop branch
  by default, but instrumenting all three keeps the anchor robust if the device
  profile changes.)
- **EOD selectors (AC-SEL-EOD):** I audited `EODCount.tsx` against the Phase-2
  plan. The needed selectors **already exist**: `eod-store-name` (412),
  `eod-submit` (586), `eod-queue-indicator` (579), `vendor-chip-{id}` (474),
  `eod-item-input-{id}` (562), `eod-item-row-{id}` (538), `eod-prefill-banner`
  (451). `store-row-{id}` (StorePicker:63) and `store-picker-root`
  (StorePicker:40) exist. **No net-new EOD testID is required** for AC-EOD1.
- **AC-EOD3 (pending count addressable):** `eod-queue-indicator` wraps the pill
  but the **pending count is in a child `<Text>`** with no own testID
  ([QueueIndicator.tsx:32](../src/screens/staff/components/QueueIndicator.tsx)).
  The offline assertion can read the *visibility* of `eod-queue-indicator`
  (it renders `null` when `pending===0 && !draining`, so "indicator visible" ⇔
  "something pending or draining" and "indicator absent" ⇔ "queue empty") — that
  is already a non-text-fragile assertion (presence/absence of the testID
  element). **Recommendation: add `testID="eod-queue-count"` to the count
  `<Text>`** so a test can additionally assert the *number* of pending items, not
  just presence. Low-cost; satisfies AC-EOD3's "addressable pending count"
  literally. (One extra leaf testID — add it to the table as #17 if the FE dev
  wants to assert the count value; otherwise presence/absence of #579 suffices.)

### 8. Frontend store impact

**None.** No slice of [src/store/useStore.ts](../src/store/useStore.ts) or
[src/screens/staff/store/useStaffStore.ts](../src/screens/staff/store/useStaffStore.ts)
changes. The optimistic-then-revert + `notifyBackendError` pattern is unaffected
(E2E asserts the existing behavior; it does not alter it). The `testID` adds are
attribute-only and do not touch state, selectors, or actions.

### 9. Risks and tradeoffs (explicit)

- **(Critical) The committed seed has no `order_schedule`/`eod_submissions`
  rows.** Without the OQ-4 runtime fixture, the entire Phase-2 EOD suite renders
  empty (no vendor chips, no item inputs) and AC-EOD1/2 cannot pass. The fixture
  (§OQ-4) is therefore a hard dependency of Phase 2, not optional. The
  backend-developer owns it. **This is the single most likely place Phase 2
  silently degrades to a vacuous test** — the EOD spec must assert that items
  actually rendered (non-empty `eod-item-input-*`) before claiming a pass.
- **Cold Metro bundle is a flake/latency risk (OQ-2).** Mitigated by the 180s
  `webServer.timeout`, `retries: 2`, and the documented static-export fallback.
  Watch the first ~10 CI runs; flip to the export path if the boot is the flake
  source.
- **`submit()` closure staleness on the offline path (OQ-5 subtlety 1).** If the
  EOD spec clicks `eod-submit` before React re-renders after `setOffline(true)`,
  the submit may take the *online* branch and hit the network. Mitigated by
  polling `navigator.onLine === false` before the offline submit; route
  interception is the documented fallback.
- **storageState carrying the queue (OQ-3c).** Resolved by (1) setup never
  submitting EOD and (2) clearing the queue key in `beforeEach`. If a future
  refactor moves the queue out of localStorage (e.g. to IndexedDB), the
  `beforeEach` clear must follow — note it in the Track-4 docs.
- **Serial execution (`workers: 1` in CI) is slower** than parallel. Accepted:
  it removes shared-DB cross-talk for v1; the job is non-blocking so wall-clock
  is not on the critical path.
- **Seed-coupling drift (Phase 4).** Read-heavy assertions key on **structure**
  (container testIDs), not seed values, so a future seed refresh won't break
  them. The one coupling is the hard-coded store/vendor UUIDs in the OQ-4 fixture
  (`Towson`, `US FOOD`); if the seed ever drops Towson or US FOOD, the fixture
  breaks loudly (a missing-FK insert error) rather than silently — acceptable,
  and the failure is self-explaining.
- **`__DEV__` demo-button divergence (OQ-2).** Documented; not a blocker because
  auth-setup fills the form directly. Becomes relevant only if a future spec
  switches to the static-export server AND wants the demo buttons.
- **Performance on the 286 KB seed.** `supabase db reset` reseeds the full seed
  each CI run (~seconds). Acceptable for a non-blocking job; it is the price of
  determinism (OQ-3a). Local runs do not auto-reset, so local cost is zero.
- **No CI gate assumption.** Per CLAUDE.md "No CI assumption" and the project's
  manual-migration reality, `e2e.yml` is advisory and the design does not make
  any *other* gate depend on it. The `db-migrations-applied.yml` workflow is
  untouched (no migration here).

### 10. Division of labor (clean split — neither developer stomps the other)

The two developers work in **disjoint file sets**:

**backend-developer owns the harness + CI + DB-fixture side** (no production
source edits):
- `playwright.config.ts` (root)
- `e2e/` tree: `auth.setup.ts`, `global-setup.ts` (the OQ-4 service-role
  `order_schedule` fixture insert), `fixtures/` helpers, and **all flow specs**
  (`e2e/auth.spec.ts`, `e2e/eod.spec.ts`, `e2e/invite.spec.ts`,
  `e2e/dashboard.spec.ts`, `e2e/reorder.spec.ts`, `e2e/audit.spec.ts`,
  `e2e/dark-mode.spec.ts`) — the specs are authored against the testIDs the FE
  dev adds, so they are owned by the same person who owns the harness mechanics.
- `.github/workflows/e2e.yml`
- `package.json` (the three `e2e*` scripts + `@playwright/test` devDependency)
- `.gitignore` (Playwright artifact entries)
- `tests/README.md` (Track 4 section + the 4-row track table + promotion criteria)

**frontend-developer owns the production `testID` instrumentation ONLY**
(the §7 checklist, rows 1-16, plus optional 17):
- `src/screens/LoginScreen.tsx` (#1-3)
- `src/screens/cmd/ResponsiveCmdShell.tsx` (#4)
- `src/screens/cmd/sections/DashboardSection.tsx` (#5-6)
- `src/screens/cmd/sections/ReorderSection.tsx` (#7)
- `src/screens/cmd/sections/AuditLogSection.tsx` (#8)
- `src/screens/cmd/sections/UsersSection.tsx` (#9-11)
- `src/components/cmd/InviteUserDrawer.tsx` (#12-16; includes the `Field`
  `testID?` prop thread)
- (optional) `src/screens/staff/components/QueueIndicator.tsx` (#17,
  `eod-queue-count`) — assign to FE if the EOD spec wants the count value.

**Why this split is clean:** the FE dev touches only `src/`; the BE dev touches
only `e2e/`, the workflow, `package.json`, `.gitignore`, and docs. The only
contract between them is the **testID names in §7** — frozen in this design, so
the BE dev can author specs against `getByTestId('signin-email')` etc. before the
FE edits land (specs will simply fail until the testIDs exist, which is expected
in a fresh suite). No file is co-owned. `package.json` is BE-only (FE adds no
deps). The `package.json` `e2e*` scripts and the FE testID edits do not overlap.

**Sequencing note (not a blocker):** the suite goes green only once *both* sides
land — the FE testIDs and the BE specs/harness are mutually dependent at
run-time but independent at edit-time. Phase 1 (harness + auth setup + sign-in
smoke + login testIDs + the shell anchor) is the minimum that proves the pipe;
Phases 2-4 layer on. Both developers can start immediately in parallel.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the ## Backend / Frontend design in this spec, in
  parallel, in DISJOINT file sets. backend-developer owns the Playwright harness
  + config + e2e specs + .github/workflows/e2e.yml + package.json scripts/dep +
  .gitignore + tests/README.md Track-4 docs + the OQ-4 service-role
  order_schedule runtime fixture (e2e/global-setup.ts) — NO production source
  edits. frontend-developer owns ONLY the §7 testID checklist (rows 1-16, plus
  optional #17) in src/ — LoginScreen, ResponsiveCmdShell shell anchor,
  Dashboard/Reorder/AuditLog/Users section roots, the Users invite trigger +
  pending-invite rows, and InviteUserDrawer (threading a testID prop through the
  Field helper). The frozen contract between you is the testID names in §7 — do
  not rename them. EOD selectors already exist (audited); no net-new EOD testID
  required except optional #17. After implementation, set Status:
  READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/078-e2e-playwright-framework.md

---

## Files changed (backend/harness)

Implemented by backend-developer — the harness/infra half of the §10 split.
**Zero production `src/` files touched** (the §7 testID instrumentation is the
frontend-developer's parallel half). The frozen contract is the §7 testID
names; the specs reference those exact names.

### Playwright config (repo root)
- `playwright.config.ts` — NEW. `testDir: ./e2e`; `webServer` boots
  `npx expo start --web --port 8081` (OQ-2 dev-server decision) with
  `reuseExistingServer: !CI` + 180s cold-bundle timeout + env-sourced
  `EXPO_PUBLIC_SUPABASE_URL`/`_ANON_KEY` (local-stack fallback); `use`:
  `baseURL`, `trace: 'on-first-retry'`, `testIdAttribute: 'data-testid'`
  (placed under `use` per the Playwright 1.x API — the design §2 pseudocode
  listed it top-level; the pinned VALUE is unchanged); `retries: CI?2:0`;
  `workers: CI?1:undefined`; `fullyParallel:false`; per-test + global
  timeouts; html+github (CI) / html+list (local) reporters; `globalSetup`
  pointing at the OQ-4 fixture; `setup` project + `chromium` project
  (`dependencies: ['setup']`).

### e2e/ tree (NEW)
- `e2e/global-setup.ts` — OQ-4 runtime fixture. Service-role
  `@supabase/supabase-js` client inserts `order_schedule` rows for ALL 7
  weekdays × TWO Towson vendors (US FOOD + RESTAURANT DEPOT) idempotently
  (`upsert` / `onConflict: store_id,day_of_week,vendor_id`,
  `ignoreDuplicates`). Includes `delivery_day` + `vendor_name` (both NOT
  NULL on the prod-pulled schema). Local-only service-role key, env-sourced,
  never logged. **Verified: inserts exactly 14 rows; idempotent on re-run.**
- `e2e/auth.setup.ts` — `setup` project. Logs in admin + staff via the real
  UI, saves per-role `storageState`. NEVER submits EOD (OQ-3c poison-queue
  guard #1).
- `e2e/auth.spec.ts` — Phase 1 sign-in smoke (AC-S1 admin → `cmd-shell-root`,
  AC-S2 staff → `store-picker-root`, AC-S3 bad creds → `signin-error`, no
  nav).
- `e2e/eod.spec.ts` — Phase 2. AC-EOD1 online submit; AC-EOD2/3
  offline→queue→drain via `context.setOffline()` with the OQ-5
  `navigator.onLine` timing-poll guard. Clears the queue key in `beforeEach`
  (OQ-3c guard #2). Asserts vendor chips + items actually rendered before
  submitting (guards against a vacuous test).
- `e2e/invite.spec.ts` — Phase 3. Admin-path invite, uniquified email
  `e2e-invite+<runId>@local.test` (OQ-3b/AC-INV2). Success = drawer closes.
  Documents why the master-only `invite-role-*` selectors are NOT exercised
  on the admin path.
- `e2e/dashboard.spec.ts` / `e2e/reorder.spec.ts` / `e2e/audit.spec.ts` —
  Phase 4 read-heavy structural assertions (`dashboard-root`+`dashboard-kpis`,
  `reorder-root`, `audit-root`). Navigate via stable sidebar label clicks
  (the Cmd shell has no URL/linking).
- `e2e/dark-mode.spec.ts` — AC-DARK1. `colorScheme: 'dark'` + seeds the
  `darkMode` localStorage pref (the admin theme reads the store pref, not the
  OS media query); asserts `cmd-shell-root` computed bg is dark.
- `e2e/fixtures/constants.ts` — shared seed UUIDs, demo accounts,
  storageState paths, staff localStorage keys, `RUN_ID`/`uniqueInviteEmail`,
  sidebar labels.
- `e2e/tsconfig.json` — scopes TS for the e2e tree (base `tsconfig.json` now
  excludes `e2e/**`).

### CI
- `.github/workflows/e2e.yml` — NEW, SEPARATE from `test.yml`, non-blocking.
  Mirrors `test.yml`'s `db`-job boot + `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` +
  `permissions: contents: read`. Adds `npx playwright install --with-deps
  chromium`, `supabase db reset` (OQ-3a), a step that pipes the local stack's
  well-known keys into `$GITHUB_ENV` for the fixture, `if: always()` artifact
  upload (html report + traces), and stack teardown. Documents the
  20-green/<5%-flake promotion-to-gating rule (AC-PROMO1).

### Config / deps / docs
- `package.json` — added `@playwright/test` devDependency (`^1.60.0`) +
  `e2e` / `e2e:headed` / `e2e:ui` scripts (AC-H1/H3).
- `package-lock.json` — lockfile updated by the install.
- `.gitignore` — added `/test-results/`, `/playwright-report/`,
  `/blob-report/`, `/e2e/.auth/` (AC-H4).
- `tsconfig.json` — added `e2e/**` + `playwright.config.ts` to `exclude` so
  the app typecheck doesn't compile the Playwright tree (config-only; not a
  `src/` edit).
- `tests/README.md` — added the **Track 4 — Browser E2E (Playwright)**
  section + the 4-row track table + the TL;DR command block + the CI-section
  note (AC-DOC1, AC-PROMO1).

### Verification performed
- `npx playwright --version` → 1.60.0.
- `npx tsc --noEmit -p tsconfig.json` AND `-p tsconfig.test.json` AND
  `-p e2e/tsconfig.json` → all green.
- `npx playwright test --list` → 12 tests across 8 files discovered with
  correct project deps.
- `npx jest` → 386 passed / 40 suites (no existing test broken).
- OQ-4 fixture run twice against the live local stack → 14 idempotent rows on
  Towson.
- `npx playwright test --project=setup` → globalSetup ran (fixture log),
  Expo webServer booted, `page.goto('/')` rendered the login screen (captured
  page-snapshot shows "Sign in" + the email/password textboxes). Setup then
  fails ONLY at `waiting for getByTestId('signin-email')` — expected
  mid-parallel-build, since the FE testID `signin-email` (§7 #1) is not yet
  landed. The harness itself is proven independent of the testIDs.

## Files changed (frontend/testID)

The §7 testID-instrumentation half (rows #1-16). Every change is a
non-behavioral attribute add; row #12/#13 additionally thread an optional
`testID?: string` prop through the shared `Field` helper. Row #17
(`eod-queue-count`) was the OPTIONAL one — SKIPPED, because the BE-authored
`e2e/eod.spec.ts` keys on `eod-queue-indicator` presence/absence only and
references no `eod-queue-count` (confirmed by grep), so the optional leaf is
unused. All pre-existing EOD/StorePicker selectors (§7 audit notes) were
already present and untouched. `signin-submit` (§7 button) was already present
in `LoginScreen.tsx` from a prior spec and satisfies the BE specs as-is — not
re-added.

| File | testID(s) added | §7 row |
|------|-----------------|--------|
| `src/screens/LoginScreen.tsx` | `signin-email` (email TextInput), `signin-password` (password TextInput), `signin-error` (inline error View) | #1, #2, #3 |
| `src/screens/cmd/ResponsiveCmdShell.tsx` | `cmd-shell-root` on ALL THREE breakpoint roots (phone ~L361, tablet ~L400, desktop ~L458) | #4 |
| `src/screens/cmd/sections/DashboardSection.tsx` | `dashboard-root` (section root View), `dashboard-kpis` (KPI strip View) | #5, #6 |
| `src/screens/cmd/sections/ReorderSection.tsx` | `reorder-root` (section root View) | #7 |
| `src/screens/cmd/sections/AuditLogSection.tsx` | `audit-root` (section root View) | #8 |
| `src/screens/cmd/sections/UsersSection.tsx` | `users-root` (section root View), `users-invite-trigger` (+ INVITE USER TouchableOpacity), `user-row-${user.id}` (per-row View in `UserRow`) | #10, #9, #11 |
| `src/components/cmd/InviteUserDrawer.tsx` | `invite-email` + `invite-name` (via new `Field` `testID?` prop thread), `invite-role-${r}` (role chips, `user`/`admin`), `invite-store-${s.id}` (store checkboxes), `invite-submit` (SEND button) | #12, #13, #14, #15, #16 |

### Frontend verification performed
- `npx tsc --noEmit -p tsconfig.json` → exit 0 (the `Field` `testID?: string`
  thread typechecks cleanly).
- `npx jest` → 386 passed / 40 suites (baseline unchanged; the existing
  `InviteUserDrawer.test.tsx` still passes with the `Field` prop add — the
  attribute is inert to its assertions).
- Web bundle (`expo/AppEntry.bundle?platform=web`) compiles with no
  transform/syntax error; all 16 testID literals present in the compiled
  bundle (`cmd-shell-root` ×3 confirms all breakpoints).
- **Playwright (BONUS, frozen-contract proof):** with `npm run dev:db` up and
  Metro on 8081, `npx playwright test e2e/auth.spec.ts --project=chromium`
  → **5 passed** (admin+staff auth setup via `signin-email`/`signin-password`/
  `signin-submit`, AC-S1 `cmd-shell-root`, AC-S2 StorePicker, AC-S3
  `signin-error`). `dashboard.spec.ts` + `reorder.spec.ts` + `audit.spec.ts`
  → all pass (`dashboard-root`, `dashboard-kpis`, `reorder-root`,
  `audit-root` addressable).
- **Invite/Users testIDs proven via throwaway probe (not committed):** logged
  in as `master@local.test` (the role gate, see finding below) → `users-root`,
  `users-invite-trigger`, `invite-email` (`.fill()` round-trips),
  `invite-name`, `invite-submit`, `invite-role-user`, `invite-role-admin` all
  addressable. My instrumentation is correct.

### Finding surfaced to reviewers (BE-spec defect, NOT a frontend-testID issue)
`e2e/invite.spec.ts` (BE-owned) **fails** — but not on any FE testID. It times
out at line 42 `getByText('Users & access', { exact: true }).first().click()`
because `e2e/auth.setup.ts` authenticates the admin storageState as
`DEMO.adminEmail` = `admin@local.test`, a **plain `admin` role**. The "Users &
access" sidebar entry AND the invite-drawer role chips are gated behind
`isMaster` (master/super_admin only) per Spec 030
([src/lib/cmdSelectors.ts:1136](../src/lib/cmdSelectors.ts)). A plain admin
never sees the Users entry, so the text-based navigation step can never
resolve and the spec dies before reaching `users-root`. The `invite.spec.ts`
flow must authenticate/operate as `master@local.test` (the spec already
defines `DEMO.masterEmail`) to reach the master-gated invite flow. This is in
the backend-developer's disjoint file set — flagged here, not patched, per the
clean-split rule.

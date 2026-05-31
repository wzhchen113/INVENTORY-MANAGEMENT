# Spec 080: E2E — dashboard attention-queue weekly-window guard

Status: DEFERRED (architect RE-DEFER — Q5; see ## Backend / Frontend design)

## Problem / context

Spec 074 windowed the admin Dashboard's per-store Attention Queue
`unconfirmed_po` ("VENDOR order missed (DATE)") rows to a **Monday-reset**
window: only this work-week's missed orders show; anything before this week's
Monday 00:00 (store timezone) drops off. The windowing math lives in
`computeAttentionQueue` in [src/lib/cmdSelectors.ts:853-905](../src/lib/cmdSelectors.ts)
(the `getWeekWindow(timezone, now)` filter → `weekISOs.filter(iso < todayISO)`
"exclude today" → schedule-vs-submission predicate per date).

It is already covered by ~8 deterministic jest tests with an injected `now`
(`src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` + `src/utils/weekWindow.test.ts`).

Spec 079 wanted to ALSO cover it as a browser E2E and **explicitly deferred it
to a 080 candidate** (079 "Out of scope" + Open-questions + design §4), with a
recorded clean path: a **dedicated non-Towson store** + a **date-scoped
teardown** the Towson teardown doesn't touch. This spec scopes that work — and
makes an honest call on whether the value justifies the fixture cost.

This spec **extends the spec-078/079 Playwright harness; it does NOT rebuild
it.** No `playwright.config.ts` rewrite, no new workflow, no new auth model. The
backend behavior under test (spec 074) is unchanged — this is a test-coverage
spec.

## Honest value assessment (read this before building)

The marginal value of this E2E over the existing jest layer is **narrow**: it
confirms the *real* `DashboardSection` renders the spec-074-windowed result in a
browser against real DB-loaded slices — an integration-wiring proof, not a
logic proof (the logic is already pinned deterministically in jest). The
fixture cost is genuinely high and mostly **fixed regardless of how many
assertions we add**:

- A created throwaway store (the only collision-safe option — see Open
  Questions Q2) plus its `user_stores` grant and at least one `inventory_items`
  row for a vendor.
- A `now`-relative date-arithmetic generator that produces an in-week,
  before-today date that is correct across **all 7 possible CI weekdays**
  (the crux — see Open Questions Q1), plus a before-this-Monday date for the
  out-of-window proof if we keep it.
- A **date-and-store-scoped teardown** that touches only this store's rows so
  it never collides with the pgTAP `missed_order_audit_rpc` test (which uses
  all four seed stores) or the OQ-4 Towson teardown.
- New production `testID`s on `StoreCol` / attention rows (none exist today).

Because that scaffolding cost is paid whether we assert one thing or three,
the spec's headline decision (Q5) is: **build LEAN (one in-window assertion,
Monday-aware skip), build FULL (in-window + out-of-window), or RE-DEFER.** The
PM recommendation is **LEAN, gated behind explicit user/architect go-ahead** —
documented in Open Questions Q5. If the architect concludes the integration
delta does not clear the fixture+flake+teardown cost even at LEAN, **re-defer
is an acceptable design outcome** and the architect should say so in the design
doc rather than build scaffolding for thin value.

## User story

As a **developer**, I want the spec-074 Monday-reset attention-queue window
guarded by a browser E2E so a future refactor that re-breaks the windowing (or
the wiring between `computeAttentionQueue` and the rendered `StoreCol`) is
caught by CI in a real DOM, not only by injected-clock unit tests.

As a **reviewer**, I want this guard to be deterministic across every weekday
CI can run on, and fully isolated from the Towson OQ-4 fixture and the pgTAP
missed-order test, so it never flakes and never corrupts a sibling track.

## Acceptance criteria

> Phasing note: AC-080-DATE, AC-080-STORE, AC-080-SEL, and AC-080-TEARDOWN are
> the **fixed scaffolding** — required no matter which Q5 variant lands (LEAN
> or FULL). AC-080-IN is the LEAN floor. AC-080-OUT is the FULL add-on (kept
> only if Q5 resolves to FULL). If Q5 resolves to RE-DEFER, none of these land
> and the spec records the re-defer rationale instead.

Fixture scaffolding (fixed):

- [ ] AC-080-STORE: A **dedicated, e2e-only store** (NOT Towson / Frederick /
      Charles / Reisters — all four are pgTAP `missed_order_audit_rpc` fixture
      anchors) is created idempotently by an e2e fixture using the
      `serviceRoleClient()` from `e2e/fixtures/db.ts`. It is brand-scoped to the
      seed brand (`2a000000-0000-0000-0000-000000000001`) so the
      `user_stores_brand_match` trigger and RLS brand checks pass, granted to
      `admin@local.test` via `user_stores` (admin already sees all stores via
      `auth_is_admin()`, but the grant is added defensively / documents intent
      — architect confirms whether the grant is strictly needed), and carries at
      least one `inventory_items` row for the scheduled vendor so the
      schedule-vs-submission derivation has a real vendor to miss. The store id
      is a fixed constant added to `e2e/fixtures/constants.ts` (`SEED.e2eWindowStoreId`
      or similar), NOT a random UUID, so the teardown is exact.
- [ ] AC-080-DATE: The fixture computes its target date(s) **relative to `now`'s
      work-week in the store timezone** (matching `getWeekWindow` semantics:
      Monday 00:00 reset, exclude today), so the in-window miss falls on a date
      that is reliably **in this week AND strictly before today** on **every**
      weekday CI can run. The exact date arithmetic is the architect's to nail
      (Open Question Q1); the requirement is determinism across all 7 weekdays
      with no hardcoded calendar dates.
- [ ] AC-080-SEL: A stable per-store `testID` is added to the `StoreCol` card
      and/or to attention-queue rows so the assertion targets the **dedicated
      store's** card and its missed-order row deterministically, NOT by brittle
      text matching. Proposed: `dashboard-store-card-{storeId}` on the
      `StoreCol` root ([DashboardSection.tsx:451](../src/screens/cmd/sections/DashboardSection.tsx))
      and `attention-row-{rule}-{date}` (or `attention-row-{item.id}`) on each
      rendered queue row ([DashboardSection.tsx:926](../src/screens/cmd/sections/DashboardSection.tsx)).
      The exact name(s) and whether one or both are needed is the architect's
      call (Q3); these are the ONLY net-new production `testID`s in this spec
      and are frontend disjoint-split items.
- [ ] AC-080-TEARDOWN: A **date-and-store-scoped teardown** removes ONLY this
      spec's fixture rows — the dedicated store's `order_schedule`,
      `orderSubmissions`/`purchase_orders`, `inventory_items`, `user_stores`, and
      the store row itself — keyed by the dedicated store id (and, where rows
      could pre-exist, by the fixture date). It MUST NOT touch Towson (no OQ-4 /
      pgTAP collision) and MUST be idempotent (a no-op if already clean).
      Whether this extends the existing `global-teardown.ts` or adds a
      per-spec fixture/teardown is the architect's call (Q4).

Behavioral assertions:

- [ ] AC-080-IN (LEAN floor): As `admin@local.test`, navigate to the Dashboard,
      and on the **dedicated store's** card assert the windowed missed-order row
      **is visible** — i.e. the attention queue for that store shows exactly the
      in-window miss the fixture created (a `unconfirmed_po` row whose date is
      this week, before today, with no matching submission). The assertion keys
      off the AC-080-SEL testID and the run-computed in-window date, never
      brittle prose or an absolute count.
- [ ] AC-080-IN-MONDAY-SKIP: Because the spec-074 window is **empty on a Monday
      morning** (range `[thisMonday, today)` is empty when today IS Monday), the
      in-window assertion has nothing to assert when CI runs on a Monday. The
      test MUST handle this deterministically — `test.skip()` (with a logged
      reason) when the store-tz weekday is Monday, computed from the same
      `now`/tz derivation the fixture uses. A skipped-on-Monday run is GREEN, not
      a flake. (Architect may instead choose to assert the **empty/All-clear**
      state on Monday as a positive Monday-reset proof — that is a strictly
      better variant if cheap; Q5 sub-decision.)
- [ ] AC-080-OUT (FULL add-on; kept only if Q5 = FULL): The fixture ALSO creates
      a missed-order condition on a date **before this week's Monday** (e.g. last
      week), and the test asserts that row is **NOT present** on the dedicated
      store's card (`toHaveCount(0)` on its `attention-row-*` testID) — proving
      the window actually filters older misses, not merely that an in-window row
      renders. Drop this AC if Q5 resolves to LEAN.

Cross-cutting:

- [ ] AC-080-DOC: `tests/README.md` Track-4 section notes the new window guard,
      the dedicated-store + date-scoped-teardown isolation pattern (and WHY it
      must avoid the four pgTAP seed stores), and — if it lands — that this is
      the second deterministic-clock-sensitive E2E (the Monday-skip pattern is a
      reusable note for future date-windowed E2Es).
- [ ] AC-080-FLAKE: The new spec follows the spec-079 flake checklist:
      `getByTestId` navigation (`SIDEBAR_NAV.dashboard`), web-first auto-retrying
      assertions, assert `dashboard-root` visible before interacting, no fixed
      `waitForTimeout`. The Monday-skip is the only conditional and it is
      computed deterministically, not by catching a timeout.
- [ ] AC-080-GREEN: After this spec lands and is pushed to `main`, the latest
      `e2e.yml` run on `main` is confirmed green per the CLAUDE.md "CI status
      check after every push to `main`" rule (a Monday run shows the skip, still
      green). This spec does NOT flip `e2e.yml` to required (that remains the
      separate AC-PROMO1 follow-up from 078/079).

## In scope

- One new Playwright spec (`e2e/dashboard-window.spec.ts` or a deepening of
  `e2e/dashboard.spec.ts` — architect's call) guarding the spec-074 windowed
  attention-queue row in a real browser.
- A dedicated, e2e-only store fixture (store + `user_stores` + `inventory_items`
  + date-keyed `order_schedule` and the absence of a matching submission)
  created via `serviceRoleClient()`, fully isolated from Towson.
- A `now`-relative, store-tz-aware date generator that is deterministic across
  all 7 CI weekdays, plus a Monday-aware skip (or Monday All-clear assertion).
- A date-and-store-scoped teardown for the dedicated store's rows.
- The minimal net-new production `testID`s on `StoreCol` / attention rows
  needed to target the dedicated store's card and its missed-order row.
- A `tests/README.md` Track-4 note + the Monday-skip pattern.

## Out of scope (explicitly)

- **Re-testing the spec-074 windowing LOGIC.** The 8 jest tests
  (`cmdSelectors.unconfirmedPoWindow.test.ts` + `weekWindow.test.ts`) already
  pin Monday-reset / exclude-today / tz-boundary deterministically and are
  untouched. This spec adds the integration-render layer only; it does NOT
  duplicate the unit matrix in the browser. Rationale: the unit layer is the
  cheaper, more exhaustive home for the date matrix; the E2E proves wiring.
- **Reusing any of the four seed stores (Towson / Frederick / Charles /
  Reisters).** All four are pgTAP `missed_order_audit_rpc` fixture anchors; a
  persisted e2e `order_schedule`/PO row on any of them re-introduces the exact
  cross-track collision `global-teardown.ts` was built to prevent. A created
  throwaway store is the clean path (Open Question Q2).
- **Changing the spec-074 backend behavior.** `computeAttentionQueue`,
  `getWeekWindow`, the loader window in `db.ts`, and the brand-global-timezone
  approximation are all unchanged. No migration, no RPC, no edge function.
- **Other attention rules in the browser** (`eod_missing`, `low_out_stock`,
  `food_cost_streak`, `expiry`). Only `unconfirmed_po` is windowed by spec 074;
  only it is exercised here.
- **A per-store-timezone fixture.** The brand has one timezone (spec 074
  follow-up #2). The fixture uses the brand-global `useStore.timezone`; a
  multi-region tz fixture is out.
- **Rebuilding the spec-078/079 harness** — no config/workflow/auth-model
  rewrite. The new spec REUSES `serviceRoleClient()`, `assertLocalStack`,
  `SIDEBAR_NAV`, storageState-per-role, and the `testID`→`data-testid` contract.
- **Promoting `e2e.yml` to required.** Unchanged; AC-PROMO1 follow-up.
- **Native (Detox) coverage.** Locked out by 078; the Cmd Dashboard E2E is web.
- **Service-role assertions beyond the fixture setup/teardown.** Unlike the
  spec-079 EOD persistence case, this spec's assertion is **UI-only** (read the
  rendered card). The service-role client is used only to seed/tear-down the
  fixture, matching the OQ-4 fixture posture. No new service-role *read*
  assertion.
- **The `app.json` slug.** Untouched; load-bearing per CLAUDE.md.

## Open questions resolved

AskUserQuestion is unavailable inside this agent; each strategic question is
resolved with the PM's recommended default (auto-mode) and grounded in code
read during scoping. Each is reversible by the architect or user. **Q5 is the
genuinely strategic one** — it decides whether this spec ships at all and at
what depth; it is surfaced first.

- Q5: **Is the value worth the fixture complexity — and at what depth?**
  → A: **Recommend LEAN, contingent on explicit go-ahead; RE-DEFER is an
  acceptable architect outcome.** The logic is already covered by 8 deterministic
  jest tests; the E2E adds only integration-render confirmation at a high,
  mostly-fixed fixture cost (created store + date-arithmetic generator +
  scoped teardown + new testIDs). The leanest defensible version — **one
  in-window assertion with a Monday-aware skip (AC-080-IN + AC-080-IN-MONDAY-
  SKIP)** — captures the integration delta without the extra out-of-window
  fixture date. FULL (adds AC-080-OUT, the before-this-Monday "must NOT appear"
  proof) is more faithful to "the window filters" but ~doubles the date-math and
  fixture-row surface for a property the jest layer already proves. **If the
  architect judges that even LEAN does not clear the cost/flake/teardown bar,
  re-deferring is the correct call** — say so in the design doc rather than
  build thin-value scaffolding. The PM lean is LEAN; the architect owns the
  final go / lean / full / re-defer decision because the date-determinism and
  isolation are design surface, not product surface.

- Q1: **How is the in-window date made deterministic across all 7 CI weekdays?**
  → A: **Compute it at fixture time relative to `now`'s week in the store tz**,
  mirroring `getWeekWindow`/`getLocalDateISO`: take this week's Monday 00:00
  (store tz), and pick an in-window date = `max(thisMonday, today - 1)` style
  target that is guaranteed `>= thisMonday` and `< today`. On Tue-Sun this
  yields a valid in-week-before-today date; on Monday the window is empty
  (handled by AC-080-IN-MONDAY-SKIP). The schedule row is keyed to that date's
  **weekday name** (`order_schedule.day_of_week`, the TitleCase `WEEKDAYS[d.getDay()]`
  string the app reads) and the **absence** of any `orderSubmissions`/`purchase_orders`
  row for that exact (store, vendor, date) makes it a "miss." The architect
  nails the precise arithmetic (DST-safe, store-tz, no hardcoded dates) — this
  AC frames the requirement, not the implementation. The e2e helper SHOULD
  reuse the production `getWeekWindow`/`getLocalDateISO` from `src/utils/weekWindow.ts`
  if importable from the `e2e/` tree (so the test and the app agree on the
  window boundary by construction), or replicate them with a comment — architect
  decides.

- Q2: **Dedicated store — reuse a seed store or create a throwaway?**
  → A: **Create a throwaway, e2e-only store.** All four existing seed stores
  (Towson, Frederick, Charles, Reisters) are pgTAP `missed_order_audit_rpc`
  fixture anchors; a persisted e2e `order_schedule`/PO row on any of them
  re-creates the cross-track collision `global-teardown.ts` exists to prevent.
  The pgTAP test is hermetic (`begin; … rollback;`) so its own rows don't
  persist — but the e2e fixture's rows DO persist locally until torn down, and a
  stale e2e row on a shared store would be counted by `record_missed_orders_for_day`
  on a subsequent local pgTAP run. A created store is fully isolated and its
  teardown can drop the whole store. The cost (store + `user_stores` +
  `inventory_items` rows) is the price of isolation and is the documented clean
  path from spec 079.

- Q3: **Which testID(s) on the dashboard — store-card, attention-row, or both?**
  → A: **Both, minimally.** `dashboard-store-card-{storeId}` on the `StoreCol`
  root lets the assertion scope to the dedicated store's card (the dashboard
  renders one card per visible store; there will be 5 once the throwaway store
  exists). `attention-row-{rule}-{date}` (or `{item.id}`) on each queue row
  lets the assertion target the specific missed-order row and lets AC-080-OUT
  assert `toHaveCount(0)` for the out-of-window row. If the architect finds the
  card-scoped testID alone is sufficient (e.g. assert within the card by a
  stable row attribute), they may drop the row testID — but the card testID is
  required because text-only scoping across 5 cards is brittle. Final names
  frozen by the architect as the contract between frontend (adds the testIDs)
  and the harness dev (consumes them).

- Q4: **Teardown — extend `global-teardown.ts` or per-spec fixture?**
  → A: **Architect's call; default = extend `global-teardown.ts`** with a
  store-scoped delete block for the dedicated store id (drop order_schedule,
  POs, inventory_items, user_stores, then the store), keyed off the
  `SEED.e2eWindowStoreId` constant. This keeps all e2e DB hygiene in one place
  and the delete is store-scoped so it cannot touch Towson or the other three
  seed stores. A per-spec `test.afterAll` is the alternative if the architect
  prefers co-location; either way it must be idempotent and store-scoped.

- Q6: **Service-role read assertion (like spec 079's EOD case) or UI-only?**
  → A: **UI-only.** The assertion reads the rendered dashboard card. The
  service-role client is used only to seed/tear-down the fixture (OQ-4 posture),
  not to assert. The spec-079 single service-role-read carve-out is not widened
  here.

## Dependencies

- **The spec-078/079 harness, in full** — `playwright.config.ts`,
  `e2e/auth.setup.ts`, `e2e/global-setup.ts` + `global-teardown.ts`,
  `e2e/fixtures/db.ts` (`serviceRoleClient`, `assertLocalStack`, `todayIso`),
  `e2e/fixtures/constants.ts` (SEED UUIDs, `SIDEBAR_NAV`, STORAGE_STATE). This
  spec extends these; it does not recreate them.
- **Spec 074 windowing** — `computeAttentionQueue` + `src/utils/weekWindow.ts`
  (`getWeekWindow`, `isoDateRange`, `getLocalDateISO`). The fixture's date math
  should reuse these helpers if importable from `e2e/` (Q1), so the test and the
  app derive the window boundary identically.
- **The local Supabase stack** (`npm run dev:db`) + committed `supabase/seed.sql`
  (the seed brand `2a000000-...0001` must exist for the dedicated store's
  brand FK; it is inserted by migration `20260504060452_brand_catalog_p1_additive`).
- `@supabase/supabase-js` (already a dependency) via `serviceRoleClient()` — no
  new install.
- Frontend `testID` additions on `DashboardSection.tsx` (`StoreCol` root +
  attention rows) — the only `src/` change; no backend coupling.
- **No new RPCs, edge functions, or migrations. No `db.ts` change.**
- The existing `e2e.yml` workflow — the fixture reuses the spec-078
  quote-stripped service-role-key env export; no new secret, no new step
  expected (architect confirms; default zero workflow change).

## Project-specific notes

- **Cmd UI section / legacy:** Admin Cmd surface only —
  [src/screens/cmd/sections/DashboardSection.tsx](../src/screens/cmd/sections/DashboardSection.tsx)
  for `testID` instrumentation (no behavior change) + the `e2e/` tree. No legacy
  surface (spec 025 deleted it).
- **Which app:** This repo (admin). Not the staff app, not the customer PWA.
- **Per-store or admin-global:** Per-store. The attention queue is computed and
  rendered per visible store; this spec adds one dedicated per-store row of test
  data and reads that store's card. Admin sees all stores via `auth_is_admin()`
  in `auth_can_see_store()` (verified in
  [20260504173035_per_store_rls_hardening.sql:31-41](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)),
  so the dedicated store's card renders for `admin@local.test`.
- **Edge function or PostgREST:** Neither changes. The fixture writes via the
  service-role PostgREST client in the `e2e/` tree (does not widen the
  `src/lib/db.ts` centralization rule, per the 078/079 precedent).
- **Realtime channels touched:** None. The dashboard's per-store data is fetched
  at mount (`db.fetchEodSubmissionsForStores` / `useStore.orderSchedule`); no
  E2E spec asserts realtime propagation. The CLAUDE.md realtime-publication
  gotcha (`docker restart supabase_realtime_imr-inventory`) does NOT apply — no
  migration, no publication-membership change.
- **Migrations needed:** No.
- **Edge functions touched:** None.
- **Web/native scope:** **Web only** — Playwright drives the desktop Cmd shell
  (Desktop Chrome). Native dashboard is not Playwright-testable and is out.
- **Tests:** Track 4 (browser E2E / Playwright) only. No new jest or pgTAP — the
  spec-074 jest tests already exist and are untouched; the new production
  `testID`s are non-behavioral attributes needing no new jest assertion (a
  reviewer may spot-check no existing test keyed on their absence).
- **`app.json` slug:** Not touched (load-bearing per CLAUDE.md).
- **CLAUDE.md "Permissive RLS" / "Edge function" rules:** N/A — no DB policy
  and no edge-function change.
- **CI:** Existing `.github/workflows/e2e.yml` (separate, non-blocking). After
  the push to `main` the latest `e2e.yml` run on `main` must be confirmed green
  (AC-080-GREEN); a Monday run shows the skip and is still green. Does NOT flip
  `e2e.yml` to required.

## Division of labor (preview for the architect)

The spec-078/079 clean split applies: the **frontend-developer** owns the
net-new production `testID`s only (`DashboardSection.tsx`); the
**backend/harness-developer** owns the `e2e/` spec, the dedicated-store fixture,
the date-arithmetic generator, the scoped teardown, and the `tests/README.md`
doc. The frozen contract between them is the `testID` names (AC-080-SEL). The
architect finalizes the date arithmetic (Q1), the testID names (Q3), the
teardown home (Q4), the LEAN-vs-FULL-vs-RE-DEFER decision (Q5), and the
Monday-handling (skip vs assert-All-clear).

## Backend / Frontend design

**Decision: RE-DEFER (Q5).** Status set to `DEFERRED`. Recommended `next_agent:
NONE`. The PM honestly flagged this as a legitimate outcome; the code reads
during design surfaced a hard blocker the spec did not anticipate that pushes
the verdict past "lean is borderline" into "the proposed E2E cannot
deterministically assert what it claims to assert, and the cheaper LEAN variant
proves a property the jest layer already proves better." Detail below so the
user can override with full information.

### The decisive finding: `unconfirmed_po` is NOT genuinely per-store on the dashboard

This is the architecture fact that reframes Q1–Q5. The spec's mental model is
"the fixture seeds an `order_schedule` row on the dedicated store; the rule
emits a row on *that store's* card." The actual data flow does not work that
way.

`DashboardSection` computes `queueByStore` by looping every visible store and
calling `computeAttentionQueue(s.id, …)` once per card
([DashboardSection.tsx:281-298](../src/screens/cmd/sections/DashboardSection.tsx)).
But the `orderSchedule` and `orderSubmissions` arguments it passes are the
**focal-store-only** slices:

- `orderSchedule` = `useStore((s) => s.orderSchedule)`
  ([DashboardSection.tsx:118](../src/screens/cmd/sections/DashboardSection.tsx)).
  That slice is loaded by `fetchAllForStore(sid)` → `fetchOrderSchedule(sid)`
  for a **single** `storeId`
  ([db.ts:3384](../src/lib/db.ts), [db.ts:3401-3420](../src/lib/db.ts)) and is
  keyed by weekday name with **no store dimension**
  (`{ Monday: [...], Tuesday: [...] }`, [useStore.ts:1028-1031](../src/store/useStore.ts)).
- `orderSubmissions` = `useStore((s) => s.orderSubmissions)`
  ([DashboardSection.tsx:117](../src/screens/cmd/sections/DashboardSection.tsx)),
  also focal-store-only (`fetchRecentPurchaseOrders(sid)`, [db.ts:3386](../src/lib/db.ts)).

Inside the rule
([cmdSelectors.ts:876-905](../src/lib/cmdSelectors.ts)) the predicate iterates
`orderSchedule[pastDayName]` (the focal store's vendors) and, for the **card's**
`storeId`, looks for a matching `orderSubmissions` row with `o.storeId ===
storeId`. Because `orderSubmissions` only ever contains focal-store rows, for
any **non-focal** card the match is always `undefined` → the rule emits a
"VENDOR order missed" row for **every** focal-store-scheduled vendor on every
in-window past day, attributed to that non-focal store via string
interpolation (`${storeId}:po:…`). Contrast `eod_missing`, which IS genuinely
cross-store because the dashboard separately fetches `allEod` via
`fetchEodSubmissionsForStores(storeIds, since)`
([DashboardSection.tsx:150-184](../src/screens/cmd/sections/DashboardSection.tsx)).
**There is no `fetchOrderScheduleForStores` / `fetchOrderSubmissionsForStores`**
(grep-confirmed across `src/`). The `unconfirmed_po` row on every card is driven
by the focal store's schedule, not its own.

Consequences for this spec's fixture, in order of severity:

1. **Seeding `order_schedule` on the dedicated store does nothing unless the
   dedicated store is also the focal store.** If Towson (or any other store) is
   focal, the dedicated store's card shows `unconfirmed_po` rows derived from
   *Towson's* schedule — not from the fixture's rows. The fixture would be
   inert against its own assertion target.

2. **The focal store is not deterministic.** On admin login the focal store is
   `allStores.find((s) => user.stores.includes(s.id)) || allStores[0]`
   ([useStore.ts:572](../src/store/useStore.ts)). `admin@local.test` is granted
   **all** stores (seed cross-join, [seed.sql:190-196](../supabase/seed.sql)),
   and `fetchStores()` issues **no `.order()`**
   ([db.ts:44-58](../src/lib/db.ts)) — rows return in PostgREST's default
   (physical / unspecified) order. So "which store is focal" — and therefore
   "whose schedule drives every card's `unconfirmed_po`" — is not pinned by
   anything the E2E controls. Adding a 5th (dedicated) store perturbs that
   ordering further. A green assertion today could flip red on the next seed
   refresh or PG planner change with zero code change — the exact non-determinism
   AC-080-FLAKE exists to forbid.

3. **The only way to force determinism is to make the dedicated store focal**,
   which means either (a) seeding `localStorage`/store state to pick it (the
   admin focal store is derived server-side from grants + fetch order, not from
   a persisted picker the way the staff active-store key is — there is no clean
   E2E lever for "focal store" on the admin shell), or (b) making the dedicated
   store sort first in `fetchStores`, which is a **production `db.ts` change**
   the spec explicitly rules out ("No `db.ts` change", In-scope/Dependencies).
   Either route expands scope well past "add testIDs + a fixture."

4. **FULL (AC-080-OUT) is effectively impossible to assert cleanly.** The
   out-of-window "must NOT appear" proof requires that the dedicated store's
   card show *only* the in-window row and not the before-Monday one. But every
   card also shows the focal store's full windowed schedule mixed in. You cannot
   assert `toHaveCount(0)` for the older `attention-row-*` on a card whose
   `unconfirmed_po` set is contaminated by another store's schedule. FULL is off
   the table regardless of fixture effort.

This is not a bug to fix in this spec (spec 074 is explicitly out of scope, and
the dashboard's focal-schedule-for-all-cards behavior predates 074 and is its
own latent issue — see "Surfaced for the PM" below). It is the reason the E2E as
scoped cannot do its job deterministically.

### Why LEAN does not clear the bar even setting the blocker aside

Even if we accepted non-determinism (we should not) or forced the dedicated
store focal via a scope-expanding `db.ts` change (we should not in a
test-coverage spec), the residual value is thin:

- **The logic is already pinned, more exhaustively, in jest.** `computeAttentionQueue`
  is a pure function; `cmdSelectors.unconfirmedPoWindow.test.ts` (~8 cases) +
  `weekWindow.test.ts` inject `now` and cover Monday-reset, exclude-today, and
  tz boundaries deterministically across the full weekday matrix. The E2E can
  only ever assert *one* weekday per run (whatever today is), behind a
  Monday-skip — strictly less coverage than the unit layer, at orders of
  magnitude more cost and flake surface.
- **The "integration-wiring" delta the E2E claims is mostly already covered.**
  The wiring from `queueByStore` → rendered `StoreCol` row is exercised by the
  spec-078 `dashboard.spec.ts` happy path (the dashboard renders, cards render,
  `dashboard-root` is asserted). What 080 would add on top is "a *specific*
  windowed row renders" — but per the finding above, the row it renders is not
  the one the fixture controls, so the added assertion does not actually test
  the 074 window in the browser. It tests "some `unconfirmed_po` row from the
  focal store's schedule renders," which is neither what the AC says nor a 074
  guarantee.
- **The fixture cost is the spec's own stated "high and mostly fixed":** a
  created store + `user_stores` + `inventory_items` + date-arithmetic generator
  + a date-and-store-scoped teardown + 2 net-new production testIDs — all paid
  to land an assertion that is non-deterministic at the data-flow level.

The cost/value ratio is the inverse of what would justify building. The PM
leaned LEAN "contingent on go-ahead"; the design read removes the contingency
basis.

### The five design-surface items, resolved (for the record / if the user overrides)

If the user overrides the re-defer, these are the answers a developer would
need. They are recorded so an override does not re-run the discovery, and so the
override-path is honest about what it would and would not prove. **An override
should also expand scope to address item #1's focal-store problem — likely a
new `fetchOrderScheduleForStores` in `db.ts` so the rule is genuinely per-store
— which is a different, larger spec.**

- **Q1 (date arithmetic).** Reuse the production helpers — they ARE importable
  from `e2e/`: `e2e/tsconfig.json` is plain Node + DOM with no path restriction
  on `../src`, and `weekWindow.ts` is dependency-free (`Intl` only). Import
  `getWeekWindow`, `getLocalDateISO`, `isoDateRange` from
  `../../src/utils/weekWindow`. In-window target date:
  `weekISOs = isoDateRange(mondayStart, nextMondayStart)` then
  `inWindow = weekISOs.filter(iso => iso < getLocalDateISO(tz, now))`, take the
  **last** element (closest to today, maximizes distance from the Monday edge).
  The schedule row's `day_of_week` is `WEEKDAYS[new Date(+y,+m-1,+d).getDay()]`
  (TitleCase, matching the constant already in `constants.ts:45`). `tz` is the
  brand-global `useStore.timezone` value (single tz, spec 074 follow-up #2).
  This part is sound; it is not the blocker.

- **Q2 (dedicated store).** A created throwaway store IS the correct isolation
  boundary vs. reusing a seed store — the PM's reasoning holds (the four seed
  stores are pgTAP `missed_order_audit_rpc` anchors; a persisted e2e
  `order_schedule` row on a shared store would be counted by a later local
  `record_missed_orders_for_day` pgTAP run). And admin DOES see the created
  store's card: `auth_can_see_store()` short-circuits on `auth_is_admin()`
  ([20260504173035_per_store_rls_hardening.sql:31-41](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)),
  so the `user_stores` grant is **not strictly needed for visibility** — but it
  IS needed for a different reason the spec missed: the grant determines focal
  candidacy (`user.stores.includes(s.id)`, useStore.ts:572). Fixture shape, if
  built: `stores` row (brand `2a000000-0000-0000-0000-000000000001`, fixed id
  constant `SEED.e2eWindowStoreId`, `status='active'` so `fetchStores` returns
  it) + `user_stores` (admin grant) + one `vendors` row (or reuse a seed vendor)
  + one `inventory_items` row for that vendor + one `order_schedule` row keyed to
  the Q1 target date's weekday + NO matching `purchase_orders` row. **But this is
  inert unless the store is also focal — the Q2 shape is necessary-not-sufficient.**

- **Q3 (testID contract — FROZEN regardless, cheap and harmless).** Even on
  re-defer, freezing the contract costs nothing and de-risks a future override
  or a follow-up that fixes the per-store loader. Frozen names:
  - `dashboard-store-card-{storeId}` on the `StoreCol` root wrapper. Production
    site: the per-store `<View>` at
    [DashboardSection.tsx:451](../src/screens/cmd/sections/DashboardSection.tsx)
    (the `stores.map` wrapper) — apply to that `View` (it owns `key={s.id}`), or
    to the `StoreCol` outer container; the wrapper at :451 is the cleaner home
    because it already has the id in scope.
  - `attention-row-{rule}-{date}` on each rendered queue row. Production site:
    the `Wrapper` element at
    [DashboardSection.tsx:926](../src/screens/cmd/sections/DashboardSection.tsx).
    Derive the suffix from the row: `rule` is `item.rule`; `date` must be parsed
    from the row (the `unconfirmed_po` id is `${storeId}:po:${vendorKey}:${pastISO}`
    — the date is the trailing ISO). Simpler and less brittle: use
    `attention-row-{item.id}` verbatim (the id is already unique and stable per
    cmdSelectors), and let the test compute the expected id from the same
    `storeId`+`pastISO` it seeds. **Frozen choice: `attention-row-{item.id}`**
    (one interpolation, no re-parse, exact-match-able from the fixture).
  These are the ONLY net-new production testIDs and are the frontend-developer's
  disjoint lane. They are non-behavioral attributes; no jest assertion keys on
  their absence (reviewer spot-check per AC-080-DOC). **On re-defer these are
  NOT added** (no consumer) — they are frozen here only so an override or
  follow-up uses these exact names.

- **Q4 (teardown home).** If built: extend `global-teardown.ts` (PM default) —
  it already constructs `serviceRoleClient()` and runs the `assertLocalStack`
  prod-URL guard. Add a store-scoped delete block keyed on `SEED.e2eWindowStoreId`:
  delete `order_schedule`, `purchase_orders`, `inventory_items`, `user_stores`
  for that store id, then the `stores` row last (FK order). A created store can
  be hard-deleted (no cascade concern beyond those child tables; grep shows no
  other table FK-references a store id that the fixture touches). Idempotent by
  construction (delete-by-id is a no-op when absent). It is store-id-scoped so it
  can never touch Towson — satisfying the OQ-4 / pgTAP non-collision requirement.
  Sound; not the blocker.

- **Q5 (LEAN / FULL / RE-DEFER).** **RE-DEFER**, per the two sections above:
  FULL is impossible (focal-schedule contamination defeats `toHaveCount(0)`),
  and LEAN is both non-deterministic (undefined focal store drives the asserted
  rows) and lower-value than the existing jest matrix. **Monday sub-decision:**
  moot under re-defer; recorded for an override — prefer the *positive*
  Monday variant (assert the dedicated store's card shows the "All clear ✓"
  empty-state, [DashboardSection.tsx:904-908](../src/screens/cmd/sections/DashboardSection.tsx))
  over `test.skip()`, because a skip-on-Monday means 1/7 of CI days the guard
  proves nothing, whereas asserting the empty-state turns Monday into a genuine
  Monday-reset proof — but this too is defeated by the focal-contamination
  issue unless the per-store loader is fixed first.

### Surfaced for the PM / user (push-back, not silent work-around)

The `unconfirmed_po` rule rendering the **focal store's** schedule on **every**
store's dashboard card (finding above) is a latent correctness issue in the
*product*, independent of this E2E. On a multi-store brand, a non-focal store's
attention queue can show "VENDOR order missed" rows for vendors that store may
not even be scheduled for — they are the focal store's vendors. `eod_missing`
does not have this problem (it fetches cross-store). This predates spec 074
(074 only added the date window; it did not change the per-card schedule
source). **Recommended follow-up spec:** add `fetchOrderScheduleForStores` (and
`fetchOrderSubmissionsForStores`) to `db.ts`, have the dashboard fetch them
cross-store like it already does for `allEod`, and pass the per-store slice into
`computeAttentionQueue`. That spec would (a) fix the latent product bug and (b)
make the per-store dashboard genuinely per-store — at which point THIS E2E
becomes both meaningful and deterministic and can be un-deferred against a real
per-store assertion. I have NOT designed that fix here (it is out of 080's
scope and is product behavior, not test coverage); I am surfacing it as the
correct home for the integration value 080 was reaching for.

### What changes / what doesn't

- **No production code change** under re-defer (testIDs frozen but not added —
  no consumer). **No migration, no RPC, no edge function, no `db.ts` change, no
  `useStore.ts` change.** Realtime publication gotcha N/A (no publication
  change). The spec-078/079 harness is untouched.
- **No `e2e/` change** — no new spec, no fixture, no teardown extension.
- `tests/README.md` Track-4 is **not** modified (AC-080-DOC does not land); the
  Monday-skip "reusable pattern" note has no test to anchor it.
- The frozen testID names (Q3) and the per-store-loader follow-up recommendation
  are the durable artifacts of this design pass.

---

## Handoff

next_agent: NONE
prompt: Spec 080 RE-DEFERRED by the architect (Status: DEFERRED). The design pass
  surfaced a hard blocker the spec did not anticipate — the dashboard's
  `unconfirmed_po` rule renders the FOCAL store's `order_schedule` on EVERY store
  card (no `fetchOrderScheduleForStores`; focal store itself is non-deterministic
  because `fetchStores` has no `.order()` and admin is granted all stores), so a
  fixture seeding `order_schedule` on a dedicated store cannot deterministically
  drive that store's card, and the FULL out-of-window proof is impossible
  (focal-schedule contamination defeats `toHaveCount(0)`). LEAN is also
  lower-value than the existing 8 deterministic jest tests. The testID contract is
  frozen in the design (`dashboard-store-card-{storeId}` + `attention-row-{item.id}`)
  for a future override or follow-up, but nothing is built. Recommended follow-up:
  a separate spec adding `fetchOrderScheduleForStores`/`fetchOrderSubmissionsForStores`
  to db.ts so the dashboard attention queue is genuinely per-store — which fixes a
  latent product bug AND makes this E2E meaningful + deterministic, at which point
  080 can be un-deferred. Return to the user to accept the re-defer, override
  (expanding scope to the per-store loader fix), or greenlight the follow-up spec.
payload_paths:
  - specs/080-e2e-dashboard-attention-queue-window.md

## Original handoff (superseded — preserved for trace)

next_agent: backend-architect
prompt: Design the contract for this spec (design mode). There is real design
  surface that a developer should NOT guess at: (1) the exact `now`-relative,
  store-tz-aware date arithmetic that yields an in-week-before-today missed-order
  date deterministically across all 7 CI weekdays (Q1) — reuse src/utils/weekWindow.ts
  if importable from the e2e/ tree; (2) the dedicated throwaway-store fixture
  shape (store + brand FK + user_stores + inventory_items) and confirm a created
  store, not any of the four pgTAP seed stores, is the isolation boundary (Q2);
  (3) the date-and-store-scoped teardown and its home — extend global-teardown.ts
  vs per-spec afterAll (Q4); (4) the frozen testID contract on StoreCol /
  attention rows (Q3); and (5) the headline LEAN-vs-FULL-vs-RE-DEFER call (Q5) —
  if even LEAN does not clear the integration-value-vs-fixture-cost bar, record a
  re-defer rather than build thin-value scaffolding, plus the Monday-skip vs
  assert-All-clear sub-decision. Produce the design doc, freeze the testID
  contract, and set Status: READY_FOR_BUILD (or document a re-defer).
payload_paths:
  - specs/080-e2e-dashboard-attention-queue-window.md

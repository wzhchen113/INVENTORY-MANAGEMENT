# Spec 092: Track-4 Playwright E2E for the staff Reorder page

Status: READY_FOR_REVIEW

## User story
As an engineer maintaining `imr-inventory`, I want a deterministic Track-4
(Playwright, web) e2e for the **staff Reorder page** (shipped in spec 089) so
that the realistic manager happy-path — sign in, navigate to the Reorder tab,
see the reorder list, see the by-the-case Suggested display, and see the export
affordances — plus the key empty/nothing-to-order states are protected against
regression by a browser-level integration test the jest layer cannot reach.

This is the deferred staff-Reorder e2e from spec 089. Spec 089's test contract
named `e2e/staff-reorder.spec.ts` but the file was never created; this spec
closes that gap.

## Acceptance criteria

The deliverable is `e2e/staff-reorder.spec.ts` plus any deterministic-data
fixture additions (global-setup/teardown + constants). It must satisfy:

- [ ] **AC-092-NAV — reach the Reorder page as the manager.** Signed in via the
  staff `storageState` (`e2e/.auth/staff.json`, `manager@local.test`, role
  `user`, granted Towson + Frederick), the test reaches an active store and taps
  the bottom-tab `getByTestId('staff-tab-reorder')`, after which
  `getByTestId('staff-reorder-root')` is visible and
  `getByTestId('staff-reorder-store-name')` shows the selected store name. Store
  selection mirrors `eod.spec.ts` (handle BOTH the StorePicker path — tap
  `store-row-{id}` — and the reload-with-persisted-active-store path that lands
  directly on the tabs).
- [ ] **AC-092-LIST — the reorder list renders (deterministic-data dependent).**
  With the deterministic-data strategy the architect pins (open question A),
  the page renders at least one per-vendor card
  (`getByTestId('staff-reorder-vendor-<vendorId>')`) for the test vendor, AND the
  four KPI cards render (the KPI strip is always present; e.g. assert the
  `reorder.kpi.vendors` value is the expected vendor count for the seeded
  primary set). A pre-assertion guard (mirroring `eod.spec.ts`'s vendor-chip
  sanity and `dashboard-window.spec.ts`'s tripwire) fails loudly if the fixture
  ever stops producing a non-empty primary list, so the test can never pass
  vacuously.
- [ ] **AC-092-CASES — the by-the-case Suggested string renders.** For a seeded
  case-based item (`case_qty > 1`, below par), the rendered order line shows the
  spec-088 "N cases · M units" form (the `formatSuggested` output wrapped by
  `t('reorder.item.order', { suggested })` → `Order: N cases · M units`). Assert
  the `·`-joined cases·units shape inside the test vendor's card (NOT a generic
  units-only string). This is the one assertion that proves the spec-088 +
  spec-089 case-display wiring end-to-end in a browser.
- [ ] **AC-092-EXPORT — the export affordances are present.** When the primary
  list is non-empty (the `showExport` gate), the three export buttons render and
  are enabled: `staff-reorder-export-csv`, `staff-reorder-export-text`,
  `staff-reorder-export-pdf`. v1 asserts presence + enabled-ness ONLY — it does
  NOT trigger an export or assert a file download / share (see "Out of scope").
- [ ] **AC-092-STATE — at least one no-data state is asserted.** The test
  asserts at least one of the no-data states with data the architect can pin
  deterministically: either `staff-reorder-nothing-today` (payload has
  suggestions but none order out on the selected weekday) or
  `staff-reorder-empty` (no suggestions at all). Which state is asserted, and on
  what data/date, is part of open question A. Asserting a state is REQUIRED so
  the spec covers more than the happy path.
- [ ] **AC-092-DETERMINISM — no cross-track pollution.** Any fixture rows the
  spec seeds are removed by `global-teardown.ts` (store-scoped, FK-ordered),
  keyed on an id that is NOT any of the four pgTAP `missed_order_audit_rpc`
  anchor stores (Towson / Frederick / Charles / Reisters), so a local
  `npm run e2e` followed by `scripts/test-db.sh` cannot see a stale
  `order_schedule` row counted by `record_missed_orders_for_day`. (If the
  architect reuses the EXISTING Towson global-setup fixture rather than a
  dedicated store, the existing Towson teardown already covers it — call that
  out explicitly in the design.)
- [ ] **AC-092-RUNS — the spec runs green locally.** `npx playwright test
  e2e/staff-reorder.spec.ts` passes against the local stack (`npm run dev:db` +
  the committed seed), on the default Desktop Chrome project, on whatever
  weekday it is run (no day-fragile assertions, or day-handling mirrors
  `dashboard-window.spec.ts`).

## In scope
- `e2e/staff-reorder.spec.ts` — the staff Reorder happy path + the case-display
  assertion + the export-affordance assertion + at least one no-data state.
- Any deterministic-data additions the architect's open-question-A decision
  requires: `order_schedule` + below-par / case-based `inventory_items` fixtures
  for the manager's store, added in `global-setup.ts` (or a `test.beforeAll`
  like `dashboard-window.spec.ts`) and torn down in `global-teardown.ts`.
- Any new constants the spec needs in `e2e/fixtures/constants.ts` (e.g. a
  dedicated store/item UUID, the test vendor id, the `STAFF_ACTIVE_STORE_KEY`
  reuse).
- Reuse of existing helpers: `serviceRoleClient()` / `assertLocalStack` /
  `todayIso` from `e2e/fixtures/db.ts`; the `SEED` / `DEMO` / `STORAGE_STATE` /
  `STAFF_ACTIVE_STORE_KEY` / `WEEKDAYS` constants.

## Out of scope (explicitly)
- **Changing the staff Reorder app code.** Spec 089 shipped it; the testIDs the
  e2e keys off already exist (`staff-reorder-root`, `-store-name`, `-vendor-<id>`,
  `-export-csv` / `-text` / `-pdf`, `-empty`, `-nothing-today`, `-loading`,
  `-datepicker-trigger` / `-prev-month` / `-day-N`; tab bar `staff-tab-reorder`).
  Prefer the existing testIDs. If a needed assertion genuinely lacks a testID,
  that is a tiny app addition the architect/dev flags — not a license to refactor
  the screen.
- **Triggering an export / asserting a download or native share.** Rationale:
  jsPDF / PapaParse blob downloads and `expo-sharing` on RN-web are a known flake
  surface — `reorder.spec.ts` (admin) explicitly excluded the
  `page.waitForEvent('download')` assertion for the same reason. v1 asserts the
  buttons are present + enabled, matching the admin precedent. The native share
  path is device QA (per spec 089 (D)).
- **The date-picker look-back flow.** Exercising
  `staff-reorder-datepicker-trigger` / `-prev-month` / `-day-N` to look back to a
  prior day is OPTIONAL and deferred unless the architect folds a past-date
  assertion into the chosen state (AC-092-STATE). Rationale: a past-date
  assertion adds a second `now`-relative determinism axis; keep v1 narrow.
- **The admin Reorder section.** Covered by the existing `e2e/reorder.spec.ts`.
- **Native (iOS/Android) execution.** Playwright is web-only (Track 4). Rationale:
  the framework is browser-only; the native staff app is not in this track's
  scope (per spec 089 (D) and the Track-4 charter).
- **Realtime.** The staff stack does not use realtime (spec 062); the Reorder
  screen fetches on mount / store-switch / date-change / manual Refresh only.
- **Migrations / app-behavior changes.** None expected — this is a test-only
  addition.

## Open questions resolved
- Q: Which app surface and which screen? → A: This repo's STAFF surface, the
  Reorder tab (`src/screens/staff/screens/Reorder.tsx`, spec 089). Web-only via
  Playwright (Track 4).
- Q: Which session / account? → A: The staff `storageState`
  (`e2e/.auth/staff.json`), `manager@local.test`, role `user`, granted Towson +
  Frederick (existing `auth.setup.ts` saves it on StorePicker, never selecting a
  store).
- Q: Does this gate `test.yml`? → A: No. This is Track 4 / `e2e.yml`
  (NON-BLOCKING). It does not gate the `test.yml` jest/pgTAP suite. Noted so the
  reviewers don't treat a red `e2e.yml` as a merge blocker the way `test.yml` is.
- Q: Trigger a real export download? → A: No (see Out of scope) — presence +
  enabled only, matching `reorder.spec.ts`.

## HEADLINE OPEN QUESTION (architect must pin) — (A) deterministic-data strategy

This is the crux and the real design work; it is why the spec routes through the
architect rather than straight to the developer.

The staff Reorder PRIMARY "vendors I order today" list is computed by
`report_reorder_list(p_store_id, { as_of_date })` and then client-filtered by
`partitionReorderVendors(payload.vendors, orderSchedule, selectedWeekday)`. For
the happy-path assertions (AC-092-LIST / -CASES / -EXPORT) to be non-vacuous,
the manager's store must reliably have BOTH:

1. **An `order_schedule` row on the selected weekday** so a vendor lands in the
   PRIMARY set (the order-out filter). The committed `supabase/seed.sql` has
   **ZERO `order_schedule` rows** (confirmed by `global-setup.ts`'s header
   comment). During spec 089 dev, `order_schedule` rows had to be seeded into the
   local DB to exercise the primary path at all.
2. **At least one item below par** so `report_reorder_list` returns a non-zero
   `suggested_qty` — the RPC FILTERS OUT items with `suggested_qty < 0.001`
   (`par_replacement = max(0, par_level - on_hand - pending_po_qty)`, and items
   with `par_level=0/NULL AND usage_forecast=0` produce `0` and are dropped). So
   "store has a scheduled vendor" is necessary but NOT sufficient — there must
   also be a below-par item for that vendor, and for **AC-092-CASES** that item
   must have `case_qty > 1`.

The existing Towson `global-setup.ts` fixture covers (1) for Towson (2 vendors ×
7 weekdays) but says nothing about (2) — whether Towson's seeded inventory has a
below-par, case-based item on the test day is NOT guaranteed by that fixture.

**Two candidate strategies — the architect picks ONE and pins exact fixtures +
teardown:**

- **Strategy A1 — dedicated seeded data (mirror spec 080).** Seed a dedicated
  store (or extend the manager's grant) with a known `order_schedule` row for the
  selected weekday AND known below-par `inventory_items` including one with
  `case_qty > 1`, via `global-setup.ts` (or a `test.beforeAll`), cleaned
  store-scoped + FK-ordered in `global-teardown.ts`. This gives byte-for-byte
  control over the rendered vendor card and the cases·units string, at the cost
  of a larger fixture (must satisfy `inventory_items` FK chain — `vendor_id`,
  `brand`/`catalog` linkage, `par_level`, `current_stock`, `case_qty` so the RPC
  yields the desired `suggested_cases`). **CRITICAL:** if a dedicated store is
  used, its id MUST NOT be any of the four pgTAP `missed_order_audit_rpc` anchors
  (Towson `…0001`, Frederick `…ce1988`, Charles, Reisters) — exactly the
  cross-track collision `global-teardown.ts` exists to prevent (see its spec-080
  comment block). A persisted `order_schedule` on a shared store is counted by a
  later local `record_missed_orders_for_day` pgTAP run. Also note the manager
  must be GRANTED the store (`user_stores`) or the RPC returns RLS 42501 →
  error pane (per `fetchReorder.ts`), so a dedicated store needs a `user_stores`
  grant — UNLIKE spec 080's dashboard store, which admin saw via `auth_is_admin()`
  without a grant.

- **Strategy A2 — assert the states the existing seed deterministically
  produces.** If the architect judges the dedicated-data fixture too heavy,
  reduce v1 to what the committed seed + the EXISTING Towson `order_schedule`
  fixture deterministically yield. Depending on whether Towson has below-par
  items, that is either the happy-path-on-Towson (if it does) or the
  `staff-reorder-empty` / `staff-reorder-nothing-today` states. The risk: if v1
  cannot deterministically produce a non-empty primary list, AC-092-LIST /
  -CASES / -EXPORT cannot be met and the spec narrows to the state assertions
  only — the architect must say so explicitly and adjust the acceptance criteria
  in the design doc.

The architect must (i) choose A1 vs A2, (ii) name the exact fixture rows + the
selected weekday handling (fixed weekday vs all-7-weekdays like the existing
Towson fixture, so the test is weekday-agnostic), (iii) name the exact teardown
(store-scoped, NOT an anchor store), and (iv) decide store selection (seed
`STAFF_ACTIVE_STORE_KEY` via `addInitScript` vs tap a `store-row-{id}` — mirror
`eod.spec.ts`).

## Other design questions for the architect (don't pre-decide)
- **(B) Which flows/assertions are in v1.** Confirm the AC set above: navigate to
  the tab, the per-vendor card + the cases·units Suggested string, the KPI cards,
  the export buttons present (not triggered), and at least one no-data state. The
  date-picker look-back is OPTIONAL (Out of scope above) unless folded into the
  chosen state.
- **(C) Store selection.** The manager has 2 stores → the e2e must reach an active
  store. Mirror `eod.spec.ts`: either seed `STAFF_ACTIVE_STORE_KEY`
  (`imr-staff:active-store:v1`) via `addInitScript` before boot, or tap a
  `store-row-{id}` on the StorePicker (handling both the picker and the
  persisted-store-reload paths). Pin which.
- **(D) Scope = web-only.** Confirmed — Playwright is web. Native share is out.
- **(E) Reuse vs new fixture file.** Decide whether the deterministic-data seed
  extends `global-setup.ts` (runs once, before any project — the Towson EOD
  fixture's home) or lives in a `test.beforeAll` inside `staff-reorder.spec.ts`
  (the spec-080 pattern, used when the fixture is spec-local / `now`-relative).
  Spec 080's reasoning: `now`-relative date math lives WITH the assertions; a
  weekday-agnostic all-7-weekdays fixture can live in global-setup.

## E2E flakiness / teardown considerations (carry into the design)
- **No vacuous pass.** Both `eod.spec.ts` (vendor-chip sanity) and
  `dashboard-window.spec.ts` (the `scrollHeight > clientHeight` tripwire) assert a
  precondition that fails LOUDLY if the fixture stops producing data. AC-092-LIST
  must do the same — assert the seeded vendor card / KPI count up front so a
  silently-empty screen fails rather than passes.
- **Navigate by testID, never by visible label.** Use
  `getByTestId('staff-tab-reorder')` for the tab (label text is i18n-coupled and
  fragile — the spec-079 flake-kill rationale). The tab testID is
  `staff-tab-reorder` (`StaffStack.tsx`).
- **Auto-retrying expects, no fixed waits.** The Reorder screen fetches on mount
  and exposes `staff-reorder-loading` during the initial load; assert on the
  terminal testIDs (`-root`, `-vendor-<id>`, a state card) with Playwright's
  auto-retrying `expect`, not a `waitForTimeout`.
- **Cross-track collision guard (the load-bearing teardown rule).**
  `global-teardown.ts` already cleans (a) Towson + the two fixture vendors and
  (b) the dedicated spec-080 store, both store-scoped + FK-ordered, both keyed
  off ids that are NOT pgTAP anchors. Any new fixture this spec adds MUST follow
  the same shape: delete children before parent, key on a non-anchor id, be
  idempotent (no-op when already clean), non-fatal on error (warn + continue).
  The anchor set to avoid is Towson / Frederick / Charles / Reisters (the
  `missed_order_audit_rpc` fixture stores) — a persisted `order_schedule` on any
  of them is counted by `record_missed_orders_for_day` and breaks pgTAP.
- **Idempotent upserts.** Fixture inserts use `upsert(..., { onConflict, ignoreDuplicates: true })` so a re-run and a `db reset` both converge (matches
  both existing fixtures). The `order_schedule` unique key is
  `(store_id, day_of_week, vendor_id)`; `vendor_name` and `delivery_day` are NOT
  NULL on the prod-pulled schema and must be supplied.
- **Service-role safety.** Reuse `serviceRoleClient()` from `e2e/fixtures/db.ts`
  — it runs the `assertLocalStack` prod-URL guard on construction (refuses any
  non-local URL unless `E2E_ALLOW_REMOTE=1`). Never log the key; log only row
  counts. The DB touch lives in test code (`e2e/`), so it does not widen the
  `src/lib/db.ts` centralization rule (per the existing fixture comments).
- **Serial suite.** `playwright.config.ts` runs `fullyParallel: false`, 1 worker
  in CI, against one shared local stack — so a `test.beforeAll`/`global-setup`
  fixture is safe from concurrent-worker races, matching the existing specs.

## Dependencies
- Spec 089 (shipped) — the staff Reorder screen + its testIDs + the cross-platform
  export.
- Spec 088 (shipped) — the by-the-case "N cases · M units" Suggested display
  (`formatSuggested`, `case_qty`/`suggested_cases`/`suggested_units`).
- Spec 078 / 079 / 080 — the Track-4 Playwright framework, the shared
  `e2e/fixtures/db.ts` service-role client, and the dedicated-store +
  store-scoped-teardown pattern this spec mirrors.
- `report_reorder_list` RPC (`supabase/migrations/20260514130000_report_reorder_list.sql`,
  case fields added in `20260602000000_reorder_suggested_cases.sql`) — the data
  source; its `suggested_qty < 0.001` filter is the below-par determinism
  dependency.
- The committed `supabase/seed.sql` + `npm run dev:db` local stack (CI: `e2e.yml`
  boots a fresh `db reset` stack).

## Project-specific notes
- Cmd UI section / legacy: N/A — this is the STAFF surface
  (`src/screens/staff/`), not the admin Cmd UI. No admin section touched.
- Per-store or admin-global: per-store. The manager's view is scoped to the
  active store via `auth_can_see_store()` / `report_reorder_list`'s RLS; a store
  the manager is not granted yields RLS 42501 → the error pane.
- Realtime channels touched: none (staff stack has no realtime; spec 062).
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: WEB ONLY (Playwright / Track 4). Native share path out.
- Tests: Track 4 (Playwright e2e). The ONLY track this spec touches. It runs in
  `e2e.yml` (NON-BLOCKING — does not gate `test.yml`). No jest, pgTAP, or shell
  smoke work expected. The deterministic-data fixture is e2e-local (global-setup /
  beforeAll + global-teardown), not a seed edit (mirrors the OQ-4 rationale).
- `app.json` slug: untouched.
- Pipeline note for downstream: `security-auditor` and `backend-architect`
  (post-impl) are likely N/A here — no app code, no contract, no migration
  changes (the only DB touch is the existing-pattern e2e service-role fixture,
  already cleared by the spec-078 audit). `frontend-developer` writes the e2e +
  verifies it runs locally; `test-engineer` confirms it + the suite. Flag the
  N/A reviewers in the routing decision rather than fanning out by reflex.

---

## Backend design (architect)

TEST-ONLY spec. There is **no app code, no contract, no migration, no edge
function, no RLS, and no `src/lib/db.ts` change** in this design. The "backend"
surface is entirely the deterministic-data fixture (`global-teardown.ts` +
`e2e/fixtures/constants.ts` edits + a `test.beforeAll` in the new spec) plus the
Playwright assertions. The sections the architect template normally fills
(Data model / RLS / API contract / Edge functions / db.ts surface / Realtime /
Frontend store) are stated **N/A** below with the reason, per the spec's
"per-store / migrations: no / edge functions: none" notes.

### 0. Verification summary (what was read to pin this)

Confirmed against the live tree before deciding A1 vs A2:

- **Seed has ZERO `order_schedule` rows** — `grep` on [supabase/seed.sql](../../supabase/seed.sql) returns 0. The spec's claim holds; the existing Towson fixture in [e2e/global-setup.ts](../../e2e/global-setup.ts) is the only source of `order_schedule` rows during an e2e run.
- **Manager (`manager@local.test`, id `22222222-2222-2222-2222-222222222222`, role `user`) is granted exactly Towson + Frederick** ([supabase/seed.sql:198-201](../../supabase/seed.sql)). Profile `brand_id = 2a000000-0000-0000-0000-000000000001` (the seed brand) ([supabase/seed.sql:118-121](../../supabase/seed.sql)). **Both Towson AND Frederick are pgTAP `missed_order_audit_rpc` anchors** — so neither can carry a persisted `order_schedule` fixture row without the exact cross-track collision [e2e/global-teardown.ts](../../e2e/global-teardown.ts) exists to prevent.
- **`report_reorder_list` per-item shape** ([supabase/migrations/20260602000000_reorder_suggested_cases.sql](../../supabase/migrations/20260602000000_reorder_suggested_cases.sql)): a vendor only surfaces an item when `suggested_qty >= 0.001` (CTE `per_item_filtered`, line 459). `suggested_qty = greatest(par_replacement, usage_forecasted)`, and `par_replacement = greatest(0, par_level − on_hand − pending_po_qty)`. With `pending_po_qty` hard-wired to 0 (CTE `pending_po_qty`, v1) and `on_hand = current_stock` when there is no EOD submission for the vendor that day (CTE `item_on_hand`, case C), a row with **`par_level − current_stock >= 1`** deterministically yields a positive `suggested_qty` independent of any POS/usage data. This is the below-par lever, and it does NOT depend on `pos_imports` / recipe wiring.
- **`suggested_cases` is non-null iff `case_qty > 1`** (CTE `per_item_filtered`, lines 437-439: `ceil(suggested_qty / case_qty)`). `case_qty` comes from `coalesce(ci.case_qty, 1)` — i.e. **the `catalog_ingredients` row**, not `inventory_items`.
- **Post-P3 schema** ([supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql](../../supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql)): `inventory_items.catalog_id` is **NOT NULL** (line 23); `inventory_items.name` and `.unit` were **dropped** (lines 59-60). The RPC reads item name/unit/case_qty exclusively from the joined `catalog_ingredients` row (`ci.name`, `ci.unit`, `ci.case_qty` — `per_item` CTE, lines 389-391). **Consequence: the fixture must create a `catalog_ingredients` row** (the source of the case-display data) and an `inventory_items` row that FKs to it.
- **`order_schedule` has TWO unique constraints**: `order_schedule_store_id_day_of_week_vendor_name_key` on `(store_id, day_of_week, vendor_name)` ([remote_schema](../../supabase/migrations/20260502071736_remote_schema.sql):185) AND `order_schedule_store_day_vendor_unique` on `(store_id, day_of_week, vendor_id)` ([spec 007](../../supabase/migrations/20260507214842_spec007_order_schedule_unique.sql):77). A single fixture row with a constant `vendor_name` satisfies BOTH; the existing global-setup `upsert(..., { onConflict: 'store_id,day_of_week,vendor_id', ignoreDuplicates: true })` is therefore correctly idempotent and this spec reuses that exact shape. `vendor_name` AND `delivery_day` are **NOT NULL** on the prod-pulled schema and must be supplied.
- **`user_stores_brand_match` trigger** ([null-guard version](../../supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql):69-120): the manager's profile brand is non-null (`2a00…0001`), so the non-null path applies — the granted store's `brand_id` must EQUAL the profile brand. **A dedicated store on the seed brand is admitted; one on a different/NULL brand is rejected.** The fixture stores must therefore set `brand_id = 2a000000-0000-0000-0000-000000000001`.
- **`partitionReorderVendors`** ([src/utils/reorderDayFilter.ts:142-165](../../src/utils/reorderDayFilter.ts)): a vendor lands in `primary` iff it has a suggestion AND `vendorIdsForWeekday(schedule, selectedWeekday)` contains it — keyed off `order_schedule` rows whose `canonicalizeDayName(day_of_week)` equals the selected weekday. The screen defaults `selectedDate = todayIso()` ([Reorder.tsx:202](../../src/screens/staff/screens/Reorder.tsx)), so to be **weekday-agnostic the fixture seeds the order_schedule on ALL 7 weekdays** (mirrors the existing Towson fixture's all-7-weekdays shape), guaranteeing the vendor is in `primary` on whatever day CI runs.
- **`store-row-{storeId}`** testID exists on the StorePicker ([StorePicker.tsx:63](../../src/screens/staff/screens/StorePicker.tsx)); `setActiveStore` reads `storeId`/`storeName` from the `user_stores`-derived list — so the manager only sees a dedicated store after the grant lands.
- **The case-display rendered string** is `Order: {formatSuggested(item)}` ([Reorder.tsx:154-156](../../src/screens/staff/screens/Reorder.tsx) + [en.json:95](../../src/screens/staff/i18n/en.json) `reorder.item.order` = `"Order: {suggested}"`), and `formatSuggested` for a case item returns `` `${cases} ${caseWord} · ${units} ${unit}` `` ([src/utils/reorderExport.ts:47-54](../../src/utils/reorderExport.ts)). The load-bearing signature is the middot **`·` (U+00B7)** joining cases and units.

### 1. DECISION on open question (A): Strategy **A1 — dedicated seeded data**, two dedicated stores

A2 is rejected: the only stores the manager can see in the raw seed are Towson + Frederick (both anchors), and the seed has zero `order_schedule` rows, so A2 cannot produce a non-empty PRIMARY list on a non-anchor store without new fixtures — and seeding an anchor store is the forbidden cross-track collision. A2 would collapse the spec to state-only assertions and fail AC-092-LIST/-CASES/-EXPORT.

A1 with **two dedicated, e2e-only stores granted to the manager** (mirroring the spec-080 dedicated-store pattern, extended with the `user_stores` grant + `inventory_items` chain the dashboard fixture didn't need):

| Store | Purpose | order_schedule | inventory_items | Yields |
|---|---|---|---|---|
| **Reorder store** (`SEED.e2eReorderStoreId`) | LIST / CASES / EXPORT | 1 vendor (US FOOD) × **all 7 weekdays** | 1 below-par, `case_qty > 1` item | non-empty PRIMARY → vendor card + cases·units + export buttons, **any weekday** |
| **Empty store** (`SEED.e2eReorderEmptyStoreId`) | STATE | none | none | `payload.vendors === []` → **`staff-reorder-empty`**, any weekday |

**Why two stores, not one + the date picker.** The spec leans away from the date-picker look-back (it adds a second `now`-relative determinism axis — "keep v1 narrow", Out of scope). Driving `staff-reorder-empty` off a dedicated empty store is **`now`-independent** and needs no calendar interaction. The cost is one extra parent `stores` row + one `user_stores` grant (zero child rows) — cheaper in fixture-surface than a date-math axis is in flakiness. The empty store also exercises the store-switch path for free (AC-092-NAV's "handle both" clause).

**Manager store count.** The manager already has 2 stores (>1 → StorePicker renders). Adding 2 dedicated stores → 4 total, still >1, so StorePicker still renders and the `store-row-{id}` tap path in [eod.spec.ts](../../e2e/eod.spec.ts) ports directly. No change to the auto-select-sole-store branch.

**`nothing-today` vs `empty`.** AC-092-STATE requires **at least one** no-data state. We assert **`staff-reorder-empty`** (the deterministic one — empty store, no inventory). `staff-reorder-nothing-today` would require a store that HAS suggestions but no schedule on the *selected* weekday — only reachable deterministically via the date picker or a weekday-fragile partial schedule, both of which the spec defers. `empty` fully satisfies the AC.

### 2. Fixture rows (exact) — `test.beforeAll` in `e2e/staff-reorder.spec.ts`

Per open question (E), the seed is **`now`-INDEPENDENT** (all-7-weekdays, fixed ids) so it COULD live in `global-setup.ts`. But it is spec-local (only this spec reads these stores) and mirrors the spec-080 precedent of co-locating a dedicated-store fixture with its assertions, so it lives in a **`test.beforeAll` inside `e2e/staff-reorder.spec.ts`**. The teardown still lives in the shared `global-teardown.ts` (the only place that runs after the whole suite). All inserts use `serviceRoleClient()` from [e2e/fixtures/db.ts](../../e2e/fixtures/db.ts) (the `assertLocalStack` prod-URL guard fires on construction).

FK / insert order (parents before children; all idempotent upserts):

1. **`catalog_ingredients`** — one row, the case-display source. Upsert on `id`.
   - `id = SEED.e2eReorderCatalogId`
   - `brand_id = '2a000000-0000-0000-0000-000000000001'` (seed brand; required FK)
   - `name = 'E2E Reorder Case Item'` (deterministic — the test does NOT assert on this string, but it renders in the card)
   - `unit = 'EA'` (the unit shown after `M` in the cases·units string)
   - `case_qty = 12` (**> 1** → `suggested_cases` non-null → cases·units form)
   - other columns take their defaults.
2. **`stores`** × 2 — reorder store + empty store. Upsert on `id`. Same shape as the spec-080 store:
   - `brand_id = '2a000000-0000-0000-0000-000000000001'`, `status = 'active'` (so the staff store list / RLS returns them), `name` set, `address` set, `eod_deadline_time = '22:00'`.
   - `SEED.e2eReorderStoreId` (name e.g. `'E2E Reorder Store'`) and `SEED.e2eReorderEmptyStoreId` (name e.g. `'E2E Reorder Empty Store'`).
3. **`user_stores`** × 2 — grant the manager BOTH dedicated stores. Upsert on the `(user_id, store_id)` PK with `ignoreDuplicates`.
   - `(user_id = '22222222-2222-2222-2222-222222222222', store_id = SEED.e2eReorderStoreId)` and `(…, store_id = SEED.e2eReorderEmptyStoreId)`.
   - Brand-match trigger passes (seed-brand stores, seed-brand profile). **Without these grants the RPC raises RLS `42501` → the error pane, not the list** ([fetchReorder.ts:28-29](../../src/screens/staff/lib/fetchReorder.ts)).
4. **`inventory_items`** — one row on the **reorder store only** (the empty store gets none). Upsert on `id`.
   - `id = SEED.e2eReorderItemId`
   - `store_id = SEED.e2eReorderStoreId`
   - `vendor_id = SEED.vendorUsFoodId` (existing seed vendor; brand-scoped to the seed brand — the RPC's `vendor_delivery_offsets` reads `public.vendors` cross-store gated only by `exists inventory_items for (store, vendor)`, so reusing US FOOD is correct and needs no new vendor row)
   - `catalog_id = SEED.e2eReorderCatalogId` (NOT NULL post-P3)
   - `par_level = 24`, `current_stock = 0`, `cost_per_unit = 1.00`
     → `par_replacement = greatest(0, 24 − 0 − 0) = 24`, `suggested_qty = 24 >= 0.001` (surfaces), `suggested_cases = ceil(24/12) = 2`, `suggested_units = 2 × 12 = 24`.
     → rendered: **`Order: 2 cases · 24 EA`** (the headline assertion target; `cases` plural since `2 ≠ 1`).
   - `usage_per_portion = 0` (irrelevant — `par_replacement` alone clears the filter; no POS data needed).
5. **`order_schedule`** — 7 rows on the **reorder store only** (one per weekday), for US FOOD. Upsert on `(store_id, day_of_week, vendor_id)` with `ignoreDuplicates` (same call shape as global-setup). Built `WEEKDAYS.map(day => ({ store_id: SEED.e2eReorderStoreId, day_of_week: day, vendor_id: SEED.vendorUsFoodId, vendor_name: 'US FOOD', delivery_day: day }))`.
   - `delivery_day = day` (= the order day) so `vendorIdsForWeekday` includes US FOOD on every weekday AND the RPC's next-delivery math has a delivery day. NOT NULL satisfied.

Fail-loud on any insert error (mirror global-setup's `throw new Error(...)` with a self-explaining message; never log the service key). Log only row counts.

**Determinism cross-checks baked into the fixture (no-vacuous-pass discipline, specs 078/080):**
- Assert in `beforeAll` (or as the first spec assertion) that the catalog `case_qty` used is `> 1` — a guard so a future edit to `12 → 1` fails loudly rather than silently dropping the cases form to units-only.
- The `par_level − current_stock` margin is a fixed `24`, far above the `0.001` filter, so float wobble cannot drop the row.

### 3. AC / assertion set (open question B) — frozen selector list

Web-only, Desktop Chrome project (suite default). `test.use({ storageState: STORAGE_STATE.staff })`. Navigation strictly by `getByTestId` (never `getByText` — spec-079 flake-kill), terminal-state `expect` only (no `waitForTimeout`), the screen's `staff-reorder-loading` is transient so assert on terminal ids.

A `gotoReorderStore(page, storeId)` helper (ported from [eod.spec.ts](../../e2e/eod.spec.ts)'s `gotoTowsonEod`) that: `page.goto('/')` → assert `store-picker-root` **or** the staff tab bar visible (handles BOTH the fresh-context picker path AND the reload-with-persisted-active-store path) → if picker visible, `getByTestId('store-row-{storeId}').click()` → assert the tab bar / store name → `getByTestId('staff-tab-reorder').click()` → assert `staff-reorder-root` visible.

| AC | Assertion |
|---|---|
| **AC-092-NAV** | After `gotoReorderStore(page, SEED.e2eReorderStoreId)`: `getByTestId('staff-reorder-root')` visible AND `getByTestId('staff-reorder-store-name')` contains the reorder store's name. |
| **AC-092-LIST** | **Tripwire first** (no-vacuous-pass): `getByTestId('staff-reorder-vendor-' + SEED.vendorUsFoodId)` is visible (the seeded vendor card rendered). Then the KPI strip: assert the `reorder.kpi.vendors` card shows the expected count. The KPI cards have no per-card testID today — see §6 for the one optional tiny app add; the fallback is scoping the `Vendors` label + value within `staff-reorder-root`. |
| **AC-092-CASES** | Inside the vendor card, assert the order line text matches the cases·units form: `expect(card.getByText(/Order:\s*2\s*cases\s*·\s*24\s*EA/)).toBeVisible()` — or, more robustly against spacing, assert the card contains the literal `·` joined to `cases` (NOT a units-only string). Headline assertion. The `2 cases · 24 EA` value is fully determined by the fixture (`par 24`, `case_qty 12`). |
| **AC-092-EXPORT** | The `showExport` gate is satisfied (non-empty PRIMARY, no error, not initial-loading). Assert all three present + enabled: `staff-reorder-export-csv`, `staff-reorder-export-text`, `staff-reorder-export-pdf` each `toBeVisible()` + `toBeEnabled()`. **Do NOT click them / do NOT assert a download** — match the admin [reorder.spec.ts](../../e2e/reorder.spec.ts) precedent (jsPDF/PapaParse/expo-sharing blob path is a known flake surface; Out of scope). |
| **AC-092-STATE** | In a separate `test` (or after a store switch): `gotoReorderStore(page, SEED.e2eReorderEmptyStoreId)` → assert `getByTestId('staff-reorder-empty')` visible. The empty store has no inventory → `payload.vendors === []` → the empty StateCard, on any weekday. |
| **AC-092-DETERMINISM** | Satisfied by the §4 teardown (no runtime assertion). |
| **AC-092-RUNS** | Satisfied by the all-7-weekdays schedule + `now`-independent empty store (no day-fragile assertion). |

**Frozen testID contract** (all already exist in [Reorder.tsx](../../src/screens/staff/screens/Reorder.tsx) / [StaffStack.tsx](../../src/screens/staff/navigation/StaffStack.tsx) — confirmed by read):
`staff-tab-reorder` (tab); `staff-reorder-root`, `staff-reorder-store-name`, `staff-reorder-vendor-<vendorId>`, `staff-reorder-export-csv` / `-export-text` / `-export-pdf`, `staff-reorder-empty`, `staff-reorder-nothing-today`, `staff-reorder-loading`, `staff-reorder-error`, `staff-reorder-refresh`; plus `store-picker-root`, `store-row-<id>` (StorePicker).

### 4. Teardown (open question A.iii) — store-scoped, FK-ordered, non-anchor, in `global-teardown.ts`

Extend [e2e/global-teardown.ts](../../e2e/global-teardown.ts) with a third cleanup block, same posture as the existing spec-080 block (idempotent, non-fatal warn-and-continue, never log the key). Both dedicated store ids are NOT pgTAP anchors (distinct fixed UUIDs), so a local `npm run e2e` → `scripts/test-db.sh` cannot see a stale `order_schedule` counted by `record_missed_orders_for_day`.

Delete order (children before parents) for **both** dedicated stores:
1. `order_schedule` `.eq('store_id', <each dedicated store id>)` (reorder store has 7 rows; empty store has 0 — the delete is a harmless no-op there).
2. `inventory_items` `.eq('store_id', <each dedicated store id>)` (reorder store has 1; empty store 0). **Must precede the store delete** — `inventory_items.store_id` has no declared `ON DELETE CASCADE` in init_schema (`references stores(id)` with no cascade clause), unlike `order_schedule`/`purchase_orders`. So this child delete is **load-bearing, not belt-and-suspenders** — without it the `stores` delete fails the FK and the store leaks.
3. `user_stores` `.eq('store_id', <each dedicated store id>)` (1 grant each; `ON DELETE CASCADE` off both `profiles` and `stores` per init_schema, so this is belt-and-suspenders, but explicit keeps the FK order self-documenting).
4. `stores` `.eq('id', <each dedicated store id>)` LAST.

Do NOT delete the `catalog_ingredients` row by store (it is brand-scoped, not store-scoped). Delete it explicitly by `.eq('id', SEED.e2eReorderCatalogId)` AFTER the `inventory_items` delete (the item FKs the catalog row; catalog → brand, not → store). Idempotent (no-op if already gone). It is keyed on the dedicated catalog id, so it can never touch a seed catalog row.

> Note: `inventory_items` referencing `catalog_id` NOT NULL means the catalog delete MUST follow the item delete. Order: order_schedule → inventory_items → user_stores → stores → catalog_ingredients (catalog last because nothing the fixture created still references it once the item is gone).

### 5. Fixtures / constants (open question D) — `e2e/fixtures/constants.ts`

Add to the `SEED` object (mirroring the spec-080 `e2eWindowStoreId` comment block — explicitly NOT an anchor):

```
// ─── Spec 092: dedicated stores for the staff Reorder e2e ────────────────
// Two e2e-only stores GRANTED to manager@local.test (user_stores), seed-brand
// scoped (brand-match trigger). Fixed (non-random) UUIDs so teardown is exact
// + store-scoped. Deliberately NOT any of the four pgTAP missed_order_audit_rpc
// anchors (Towson / Frederick / Charles / Reisters) — a persisted order_schedule
// row on a shared store would be counted by a later local
// record_missed_orders_for_day pgTAP run (the cross-track collision
// global-teardown.ts prevents). UNLIKE the spec-080 dashboard store, these need
// an explicit user_stores grant: the manager is role 'user' and sees a store
// only via the grant; without it report_reorder_list raises RLS 42501.
e2eReorderStoreId:        'e2e00000-0000-0000-0000-000000000092',  // case item + 7-day schedule
e2eReorderEmptyStoreId:   'e2e00000-0000-0000-0000-000000000093',  // no inventory → staff-reorder-empty
e2eReorderItemId:         'e2e00000-0000-0000-0000-0000000009i1',  // below-par, case_qty>1 inventory_items row
e2eReorderCatalogId:      'e2e00000-0000-0000-0000-0000000009c1',  // catalog_ingredients (case_qty=12, unit 'EA')
```

(Final UUID literals are the developer's to finalize as long as they are valid v4-shaped, fixed, distinct, and not any anchor id. The `i1`/`c1` mnemonics above are illustrative — use hex-valid suffixes.) Reuse existing `SEED.vendorUsFoodId`, `DEMO.staffEmail`, `STORAGE_STATE.staff`, `WEEKDAYS`, and `serviceRoleClient()` — no new vendor, account, or storageState. The manager's user id `22222222-2222-2222-2222-222222222222` is used for the grant; add it as `SEED.managerUserId` rather than inlining the literal (single source of truth).

`STAFF_ACTIVE_STORE_KEY` reuse (open question C): **tap `store-row-{id}`** (the eod.spec.ts path), do NOT seed `STAFF_ACTIVE_STORE_KEY`. Rationale: the suite targets TWO different dedicated stores (reorder + empty); a single persisted active-store key can only point at one, so the StorePicker-tap path is the clean way to land on a specific store per test. The `gotoReorderStore` helper still handles the reload-with-persisted-store branch defensively (so a same-context re-navigation that auto-restores the last store is robust), exactly as `gotoTowsonEod` does.

### 6. App-code change — NONE required; one OPTIONAL tiny add flagged

All testIDs the assertions key off **already exist** (§3 frozen list, confirmed by read). The KPI cards (`KpiCard` in [Reorder.tsx:76-92](../../src/screens/staff/screens/Reorder.tsx)) have **no per-card testID** today. AC-092-LIST's KPI assertion can be met WITHOUT an app change by scoping the localized `Vendors` label + its value within `staff-reorder-root`. If the developer finds that scoping fragile, a **single optional additive testID** on the vendors KPI card (e.g. `testID="staff-reorder-kpi-vendors"`) is acceptable as a tiny, non-behavioral add — but **prefer the no-app-change route** (the vendor-card tripwire in AC-092-LIST is the real no-vacuous-pass guard; the KPI count is secondary). Do NOT refactor the screen. If the developer adds the optional testID, it is a one-line change with no logic impact and no migration — note it under `## Files changed` so reviewers see it.

### 7. Template sections — N/A with reason

- **Data model changes.** N/A — no migration. The fixture writes EXISTING tables (`catalog_ingredients`, `stores`, `user_stores`, `inventory_items`, `order_schedule`) via the service-role e2e client; no schema/index/column change.
- **RLS impact.** N/A — no policy change. The fixture deliberately satisfies the EXISTING `auth_can_see_store()` path by granting the manager `user_stores` rows (otherwise `report_reorder_list` raises `42501`). The service-role client bypasses RLS for the inserts/deletes (local-stack only, per the [db.ts](../../e2e/fixtures/db.ts) guard).
- **API contract.** N/A — no PostgREST/RPC contract added or changed. The test exercises the existing `report_reorder_list(p_store_id, { as_of_date })` RPC through the existing [fetchReorder.ts](../../src/screens/staff/lib/fetchReorder.ts) carve-out.
- **Edge function changes.** N/A — none touched; no `verify_jwt` change.
- **`src/lib/db.ts` surface.** N/A — no new helper. The staff Reorder path is the [src/screens/staff/](../../src/screens/staff/) carve-out (`fetchReorder.ts`), which does not flow through `db.ts` by design (CLAUDE.md staff carve-out). The e2e DB touch lives in `e2e/` test code, which the existing fixture comments confirm does NOT widen the `db.ts` centralization rule.
- **Realtime impact.** N/A — the staff stack has no realtime (spec 062); the Reorder screen fetches on mount / store-switch / date-change / manual Refresh. **No `supabase_realtime` publication membership change** → the `docker restart supabase_realtime_imr-inventory` gotcha does NOT apply to this spec.
- **Frontend store impact.** N/A — no `src/store/useStore.ts` (admin) change and no `useStaffStore` change. No optimistic-then-revert / `notifyBackendError` path is added (the screen's existing error handling is unchanged).

### 8. Risks and tradeoffs (explicit)

- **`inventory_items` is NOT `ON DELETE CASCADE` off `stores`** (init_schema `references stores(id)` with no cascade) — UNLIKE `order_schedule`/`purchase_orders`/`user_stores`. The teardown's `inventory_items` delete is therefore **mandatory and must precede the `stores` delete**, else the store delete FK-fails and the dedicated store leaks across runs (a slow-burn cross-run pollution, though NOT a pgTAP-anchor collision). Called out in §4 — the single highest-risk ordering detail.
- **Catalog-before-store vs catalog-after-item.** `catalog_ingredients` is brand-scoped, not store-scoped, so it is NOT covered by the store-scoped child deletes. It must be deleted explicitly by id AFTER the `inventory_items` delete (the item FKs it). If a future seed refresh ever ships a catalog row with this exact fixed id, the upsert-on-id makes the insert idempotent and the by-id delete still targets only that row — but the id is in the e2e `e2e0…` space, so collision is implausible.
- **Reusing `SEED.vendorUsFoodId` across stores.** US FOOD is brand-scoped to the seed brand and is also the global-setup Towson fixture vendor. There is NO collision: `order_schedule` rows are keyed by `store_id`, so the reorder store's US FOOD schedule is independent of Towson's. The teardown is store-scoped, so cleaning the reorder store's rows never touches Towson's (which global-teardown's first block handles separately).
- **Manager now sees 4 stores.** Harmless for StorePicker (>1 either way). If a FUTURE staff spec asserts an exact store COUNT for the manager, these two dedicated grants would shift it — but they are torn down after the suite, so only a concurrent in-suite assertion would see 4. No current spec does.
- **Performance on the 286 KB seed.** Negligible — 1 catalog row + 2 stores + 2 grants + 1 item + 7 schedule rows = 13 inserted rows, all upserts. The RPC walk is unchanged; the dedicated store has exactly one vendor and one item, so the report is trivially small.
- **e2e cold-start / flakiness disciplines (specs 078/079/080).** Carry forward: (a) **collection-vs-execution timing** — the `test.beforeAll` runs before the spec's tests in the serial single-worker config (`fullyParallel: false`), so the fixture is in place before any assertion; (b) **storageState auth** — `test.use({ storageState: STORAGE_STATE.staff })`, no per-test UI login; (c) **deterministic seed** — fixed ids, all-7-weekdays, `now`-independent empty store; (d) **navigate by testID, auto-retrying `expect`, no fixed waits**; (e) **tripwire** the vendor card (AC-092-LIST) so a silently-empty screen fails loudly. No `page.waitForEvent('download')` (Out of scope).
- **No `test.yml` impact.** Track 4 / `e2e.yml` only (NON-BLOCKING). No jest, pgTAP, or shell-smoke change. CI boots a fresh `db reset` stack per `e2e.yml` run, so the dedicated-store fixtures never pre-exist there; the teardown matters chiefly for LOCAL `npm run e2e` → `scripts/test-db.sh` hygiene.

## Files changed

Implemented exactly per the Backend design (A1 — two dedicated stores). TEST-ONLY:
e2e spec + fixture constants + global-teardown. NO app code, NO migration, NO
contract change. The optional `staff-reorder-kpi-vendors` testID was NOT added —
the no-app-change KPI route (scoping the localized `Vendors` label/value within
`staff-reorder-root`) proved robust, and the vendor-card tripwire is the real
no-vacuous-pass guard (design §6).

- `e2e/staff-reorder.spec.ts` — NEW. The staff Reorder e2e: a `test.beforeAll`
  service-role fixture (catalog → 2 stores → 2 user_stores grants → 1 below-par
  case `inventory_items` → 7-weekday `order_schedule`, all idempotent upserts,
  fail-loud on error, case_qty>1 determinism guard), the `gotoReorderStore`
  helper (ported from `eod.spec.ts`'s `gotoTowsonEod` — handles BOTH the
  StorePicker-tap path and the persisted-active-store reload path), and the AC
  assertions: AC-092-NAV (root + store name), AC-092-LIST (vendor-card tripwire
  + Vendors KPI = 1), AC-092-CASES (the `Order: 2 cases · 24 EA` middot-joined
  string), AC-092-EXPORT (the three `staff-reorder-export-*` buttons present +
  enabled, NOT clicked), AC-092-STATE (`staff-reorder-empty` on the empty store).
- `e2e/fixtures/constants.ts` — added `SEED.e2eReorderStoreId`,
  `e2eReorderEmptyStoreId`, `e2eReorderItemId`, `e2eReorderCatalogId`, and
  `managerUserId` (single source of truth for the grant target), with the
  spec-080-style non-anchor comment block.
- `e2e/global-teardown.ts` — added the THIRD cleanup block: store-scoped +
  FK-ordered (`order_schedule` → `inventory_items` → `user_stores` → `stores`
  for both dedicated stores, then `catalog_ingredients` by id LAST), idempotent +
  non-fatal warn-and-continue, keyed on the two NON-anchor store ids. CRITICAL:
  `inventory_items` is deleted BEFORE `stores` (no `ON DELETE CASCADE` off
  `stores`); the catalog row (brand-scoped) is deleted by id after the item.

### Verification run (against the live local stack — `npm run dev:db` + Expo web on :8081)

- `npx playwright test e2e/staff-reorder.spec.ts` → **5 passed** (3 auth-setup +
  2 spec tests). Run on today's weekday (Tue 2026-06-02); weekday-agnostic via
  the all-7-weekdays schedule + the `now`-independent empty store.
- Teardown verified against the DB: after the run, PostgREST queries for the two
  dedicated store ids return `[]` for `stores`, `inventory_items`,
  `order_schedule`, `user_stores`, and `catalog_ingredients` — zero leak.
- `npx playwright test` (full suite) → 16 passed, 1 failed. The single failure is
  `eod.spec.ts:190 AC-EOD2/3` (the offline submit/queue/drain flow — `setOffline`
  DOM-detach re-render race). **Pre-existing and unrelated to spec 092:** it fails
  the SAME way when run in isolation (`npx playwright test e2e/eod.spec.ts` → 5
  passed, 1 failed, same line) with none of this spec's code in the run. My
  fixture/teardown touch only the non-anchor `…92`/`…93` stores + the dedicated
  catalog row; the EOD spec uses Towson + seed inventory, which I never touch.
- `npx tsc -p e2e/tsconfig.json --noEmit` → exit 0 (e2e graph).
- `npx tsc --noEmit` → exit 0 (base app graph).
- `npm test` (jest) → 56 suites / 564 tests passed (unaffected — no `src/` change).
- pgTAP anchors (Towson / Frederick / Charles / Reisters) untouched — the
  teardown is store-scoped to the dedicated non-anchor ids (verified above).

## Handoff
next_agent: frontend-developer
prompt: Implement spec 092 against the Backend design above. Write
  `e2e/staff-reorder.spec.ts` with (1) a `test.beforeAll` service-role fixture
  seeding the two dedicated stores + grants + catalog + below-par case
  `inventory_items` + 7-weekday `order_schedule` exactly per §2, using
  `serviceRoleClient()`; (2) the AC assertions per §3 (tripwire the seeded
  vendor card; assert the `Order: 2 cases · 24 EA` cases·units string; assert the
  three `staff-reorder-export-*` buttons present+enabled WITHOUT clicking; assert
  `staff-reorder-empty` on the empty store). Add the new `SEED` ids + the
  `managerUserId` constant to `e2e/fixtures/constants.ts` per §5. Extend
  `e2e/global-teardown.ts` with the store-scoped FK-ordered cleanup per §4 —
  CRITICAL: delete `inventory_items` before `stores` (no cascade), and the
  `catalog_ingredients` row by id after the item delete. Reach a specific store
  by tapping `store-row-{id}` (do NOT seed `STAFF_ACTIVE_STORE_KEY`). Prefer the
  no-app-change route for the KPI assertion; only add the optional
  `staff-reorder-kpi-vendors` testID if scoping proves fragile, and note it under
  ## Files changed. Verify `npx playwright test e2e/staff-reorder.spec.ts` passes
  locally against `npm run dev:db` + the committed seed (run it on today's
  weekday — it must be weekday-agnostic). Then set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed. No backend-developer needed (no
  migration / no app contract); no migration; no `test.yml` change.
payload_paths:
  - specs/092/spec.md

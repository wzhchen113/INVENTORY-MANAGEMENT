# Spec 159: Dashboard scope — one store, or the whole brand, but never both at once

Status: READY_FOR_REVIEW

> **Owner request (verbatim, 2026-08-16).**
> *"dashboard only show selected store dashboard, or brand dashboard if store select is
> for all store instead on single store"*

---

## PM summary (plain language, for the owner)

The Dashboard today is **half one store and half all stores at the same time**, and it
never says which. Two of the five headline numbers are brand-wide, two are only the
store you have selected in the title bar, and the big title says "All stores" no matter
what. So a manager reading the top of the screen is comparing a brand-wide inventory
value against a single store's food-cost number and drawing conclusions from a chart
that mixes them.

This spec makes the Dashboard pick a lane and say which lane it is in:

- **One store** — every number, card, row and title on the page is that store.
- **All stores** — every number, card, row and title on the page is the whole set of
  stores you can see under the brand you have selected.

You choose with a small picker in the Dashboard's own header strip (top-right, where the
static text `store: all (N) · period: today` sits today). It defaults to whatever store
the title-bar switcher is on, so nothing about the rest of the app changes; "All stores"
is one click away and applies **only to the Dashboard**.

One number genuinely cannot be computed brand-wide today: **WASTE / WK**. Waste is the
only slice still loaded for a single store, so the backend needs one new multi-store
read in the same shape as the ones the Dashboard already uses for EOD and POS. That is
the whole backend surface of this spec — no schema change, no new table, no migration.

---

## Verified current behavior (do not re-derive)

| Surface | Scope today | Where |
|---|---|---|
| TOTAL INV VALUE | ALL visible stores (`inventory` slice is cross-store — `fetchAllForStore` calls `fetchInventory()` with no store filter) | `src/lib/db.ts:5630`, `DashboardSection.tsx:244` |
| STOCK ALERTS | ALL visible stores (same slice) | `DashboardSection.tsx:264` |
| AVG FOOD COST % | FOCAL store only (`eodSubmissions` slice) | `DashboardSection.tsx:341` |
| WASTE / WK | FOCAL store only (`wasteLog` slice, `db.fetchWasteLog(storeId)`) | `DashboardSection.tsx:253`, `src/lib/db.ts:773` |
| CoGS card + top-variance list | FOCAL store only (`useCogsForCurrentStore` / `useTopVarianceItems` key off `currentStore.id`) | `src/lib/cmdSelectors.ts:1000,1027` |
| EOD SUBMITTED `x/N` | ALL stores in the raw `stores` slice | `DashboardSection.tsx:275` |
| Food-cost heatmap | ALL stores in the raw `stores` slice | `DashboardSection.tsx:376` |
| Per-store attention cards | ALL stores in the raw `stores` slice | `DashboardSection.tsx:588` |
| Hero title | Hardcoded `"All stores · day in progress"` | `section.dashboard.heroTitle`, `src/i18n/en.json:378` |

Additionally the section reads the **raw `stores` slice** rather than
`visibleStoresFor(stores, currentUser, currentBrandId)` (`src/lib/storeVisibility.ts`),
so a super-admin who has picked a single brand still sees other brands' stores in the
heatmap, the card grid, and the `x/N` denominator.

There is **no "all stores" option** in the global switcher: `setCurrentStore` redirects
the `'__all__'` sentinel to a real store (`src/store/useStore.ts:1406-1440`) and ~6
sections carry defensive `__all__` guards. This spec does **not** revive that mode.

---

## User stories

- **US-1 (one store, honestly).** As a store manager whose title-bar switcher is on
  Towson, I want every number on the Dashboard to be Towson's, so that the inventory
  value, the alert count and the food-cost number describe the same restaurant.
- **US-2 (the rollup, deliberately).** As a multi-store owner, I want to switch the
  Dashboard to "All stores" and see brand-wide totals — inventory value, waste, CoGS,
  EOD completion — so I can compare stores from one screen without the numbers being
  silently mixed.
- **US-3 (say which one).** As either user, I want the hero title and the header strip
  to name the current scope, so I never have to guess whether a number is one store or
  many.
- **US-4 (brand hygiene).** As a super-admin with one brand selected, I want the
  Dashboard's store list, heatmap rows and `x/N` denominator to contain only that
  brand's stores, so brand selection means the same thing here as everywhere else.

---

## Acceptance criteria

Terminology used below:

- `visibleStores` = `visibleStoresFor(stores, currentUser, currentBrandId)`.
- `scope` = `{ mode: 'store', storeId }` **or** `{ mode: 'all' }`.
- `scopedStores` = `mode === 'store' ? [the one store] : visibleStores`.
- `scopedStoreIds` = ids of `scopedStores`.

### AC-P — the scope picker

- [ ] **AC-P1** The `TabStrip` `rightSlot` (today the static `store: all (N) · period:
      today` text at `DashboardSection.tsx:456-461`) renders an interactive picker whose
      options are, in order: **All stores (N)** followed by every store in
      `visibleStores` by name. `period: today` text is unchanged.
- [ ] **AC-P2** The picker's initial value on mount is `{ mode: 'store', storeId:
      currentStore.id }`. The Dashboard's first paint is single-store, matching the
      title-bar switcher.
- [ ] **AC-P3** Selecting an option updates Dashboard-local state **only**. It does not
      call `setCurrentStore`, does not write to `profiles`, does not touch
      `currentBrandId`, and no other section's rendering changes.
- [ ] **AC-P4** When `currentStore.id` changes (user uses the global title-bar
      switcher), the Dashboard scope resets to `{ mode: 'store', storeId:
      currentStore.id }` — including when the Dashboard was in `all` mode.
- [ ] **AC-P5** If the resolved single-store id is not present in `visibleStores` (e.g.
      brand switch narrowed it away), the scope falls back to `{ mode: 'all' }` rather
      than rendering an empty dashboard.
- [ ] **AC-P6** The picker exposes stable test hooks: `testID="dashboard-scope-picker"`,
      option `dashboard-scope-option-all`, and `dashboard-scope-option-{storeId}`.
- [ ] **AC-P7** `visibleStores.length <= 1` still renders the picker (the "All stores"
      option is allowed to be degenerate); no crash and no empty option list.

### AC-S — single-store mode (`mode: 'store'`)

For the selected store `S`, whether or not `S` is the focal store:

- [ ] **AC-S1 TOTAL INV VALUE** = `Σ over inventory where storeId === S of currentStock ×
      costPerUnit × (subUnitSize || 1)`. Sub-label item count counts only those rows;
      store count reads `1`.
- [ ] **AC-S2 STOCK ALERTS** value = count of `S`'s inventory rows with
      `getItemStatus() ∈ {low, out}`; the `out/low` sub-label counts likewise.
- [ ] **AC-S3 WASTE / WK** = `Σ quantity × costPerUnit` over waste entries for `S` in
      the trailing 7 days. The spec-104 R1 rule is preserved: this read stays
      **unbridged** (no `× subUnitSize`).
- [ ] **AC-S4 AVG FOOD COST %** is derived from `S`'s EOD series (see PM-3 for the
      derivation, which is unchanged from today apart from the store it reads). When `S`
      is the focal store the rendered value is byte-identical to today's.
- [ ] **AC-S5 EOD SUBMITTED** renders `1/1` when `S` has an EOD dated today, `0/1`
      otherwise.
- [ ] **AC-S6 CoGS card** shows theoretical / actual / Δ / % for `S` over the trailing 7
      days. When `S` is the focal store the values equal today's `useCogsForCurrentStore(7)`
      output.
- [ ] **AC-S7 Top variance items** lists `S`'s top 5 by `|deltaCost|` over the same
      window. The store-name column is retained (it shows `S` on every row) — no layout
      change.
- [ ] **AC-S8 Heatmap** renders exactly one row, for `S`.
- [ ] **AC-S9 Store cards** renders exactly one card, `dashboard-store-card-{S.id}`,
      with its attention queue unchanged in content.
- [ ] **AC-S10 Hero title** names the store (see AC-I18N).

### AC-B — all-stores mode (`mode: 'all'`)

Over `scopedStores`:

- [ ] **AC-B1 TOTAL INV VALUE** = same formula as AC-S1 summed over rows whose `storeId
      ∈ scopedStoreIds`. **Rows for stores outside `visibleStores` are excluded** — this
      is a behavior change from today, where the raw cross-store `inventory` slice was
      summed unfiltered.
- [ ] **AC-B2 STOCK ALERTS** = same, filtered to `scopedStoreIds`.
- [ ] **AC-B3 WASTE / WK** = 7-day waste summed across `scopedStoreIds`, using the new
      cross-store waste read (see Dependencies). Same unbridged-cost rule as AC-S3.
- [ ] **AC-B4 AVG FOOD COST %** = per-day unweighted mean across the stores in
      `scopedStores` that have a value that day; days where no scoped store has a value
      are `null` and are skipped. Headline = the most recent non-null value. (Derivation
      of each store's daily value is unchanged — see PM-3.)
- [ ] **AC-B5 EOD SUBMITTED** = `x/N` where `N = scopedStores.length` and `x` = count of
      scoped stores with an EOD dated today.
- [ ] **AC-B6 CoGS card** = `Σ theoretical` and `Σ actual` across `scopedStores` for the
      trailing 7 days; `delta = Σactual − Σtheoretical`; `pct = Σtheoretical > 0 ?
      delta / Σtheoretical × 100 : 0`.
      **DOCUMENTED LIMITATION (architect R-B, recorded at build time — read AC-B6 as
      "correct within ONE brand"):** `computeCogsTheoretical` needs `recipes`, and the
      `recipes` slice only ever holds the FOCAL store's brand (`fetchAllForStore` →
      `fetchRecipes(brandId)`). A super-admin on "All brands" whose scope spans two
      brands therefore gets a full `actual` but a **zero `theoretical`** for every
      out-of-brand store, inflating Δ and pct. Deliberately **not** fixed in this spec
      (a cross-brand recipe fetch is the OQ-4 follow-up's territory); it is mitigated
      only by the §9.1 label resolver, which detects >1 distinct brandId and degrades
      the title to the generic `All stores (N)` so the number never claims a brand it
      isn't. Recorded in the `computeScopedCogs` docblock and pinned by a test in
      `src/lib/cmdSelectors.scopedRollups.test.ts` that asserts the current,
      known-incomplete behavior.
- [ ] **AC-B7 Top variance items** = per-store top-5 lists merged, re-sorted by
      `|deltaCost|` desc, truncated to 5. The store-name column identifies which store
      each row came from.
- [ ] **AC-B8 Heatmap** renders one row per store in `scopedStores`, in `visibleStores`
      order.
- [ ] **AC-B9 Store cards** renders one card per store in `scopedStores`.
- [ ] **AC-B10 Hero title** names the aggregate scope and store count (see AC-I18N).

### AC-V — visibility narrowing (both modes)

- [ ] **AC-V1** Every place the section reads the raw `stores` slice for rendering or
      denominators — heatmap rows, card grid, `storeCount`, greeting line, picker
      options — reads `visibleStoresFor(stores, currentUser, currentBrandId)` instead.
- [ ] **AC-V2** The mount-time cross-store fetch effect (`DashboardSection.tsx:173-209`)
      requests only `visibleStores` ids.
- [ ] **AC-V3** With a single brand selected, a super-admin sees zero stores from other
      brands anywhere on the Dashboard.

### AC-I18N — strings

- [ ] **AC-I1** `section.dashboard.heroTitle` is no longer rendered as a fixed string.
      Two keys replace its use at the call site:
      `heroTitleStore` = `"{store} · day in progress"` and `heroTitleAllStores` =
      `"All stores ({count}) · day in progress"`.
- [ ] **AC-I2** The greeting line becomes scope-aware: `greetingLine` (existing,
      `"// {greeting}, admin · {date} · {count} stores"`) is used in `all` mode;
      a new `greetingLineStore` = `"// {greeting}, admin · {date} · {store}"` is used in
      single-store mode.
- [ ] **AC-I3** The picker reuses `section.dashboard.storeSelector` as its leading label
      and `section.dashboard.allStores` (`"all ({count})"`) as its aggregate option
      label; new keys are added for the single-store option label (store names are data,
      not strings) and the picker's accessibility label
      (`section.dashboard.scopePickerA11y`).
- [ ] **AC-I4** Every new or renamed key exists in **all three** catalogs —
      `src/i18n/en.json`, `es.json`, `zh-CN.json` — with a real translation, not an
      English copy. The existing parity test (`src/i18n/i18n.test.ts`) must stay green.
- [ ] **AC-I5** No key is deleted without removing its last call site in the same PR
      (parity test asserts set equality, so an orphan in one catalog fails CI).

### AC-REG — things that must not change

- [ ] **AC-R1** The global title-bar store switcher, `setCurrentStore`, and the
      `'__all__'` sentinel handling in `useStore` and in the ~6 sections that guard on it
      are untouched.
- [ ] **AC-R2** No other Cmd section's rendering changes.
- [ ] **AC-R3** No new realtime channel, publication change, or subscription.
- [ ] **AC-R4** `e2e/dashboard-window.spec.ts` (spec 080) asserts on
      `dashboard-store-card-{SEED.e2eWindowStoreId}` — a **dedicated, non-focal** store —
      on default Dashboard load. Under AC-P2 that card no longer renders by default, so
      the e2e spec MUST be updated in the same PR to select `dashboard-scope-option-all`
      (or that store) before asserting. Both AC-080-IN and AC-080-OUT must still pass on
      every weekday.
- [ ] **AC-R5** `src/screens/cmd/sections/phone/__tests__/PhoneDashboard.acReg.test.tsx`
      stays green (see OQ-1 for the phone-tier decision this interacts with).

### AC-T — tests

- [ ] **AC-T1** Track 1 (jest): unit tests for the aggregate reducers (inventory value,
      alert counts, waste sum, EOD `x/N`, CoGS sum, merged top-variance ordering) as pure
      functions with fixture data spanning ≥ 2 stores, including a store with no data.
- [ ] **AC-T2** Track 1 (jest): component tests for the picker — default is single-store
      (AC-P2), switching to All stores re-renders N cards (AC-B9), switching back renders
      1 card (AC-S9), `currentStore` change resets scope (AC-P4), and a store outside
      `visibleStores` never appears as an option (AC-V1).
- [ ] **AC-T3** Track 4 (Playwright e2e): `e2e/dashboard-window.spec.ts` updated per
      AC-R4.
- [ ] **AC-T4** No pgTAP (Track 2) test is required **unless** the architect implements
      the cross-store waste read as a new SECURITY DEFINER RPC rather than a PostgREST
      `.in('store_id', ...)` query — in which case an RLS-visibility pgTAP test is
      required.

---

## In scope

- A Dashboard-local scope picker in the existing `TabStrip` `rightSlot`.
- Re-scoping all five KPI tiles, the CoGS card, the top-variance list, the heatmap and
  the per-store card grid to the selected scope.
- Routing all store enumeration through `visibleStoresFor(...)`.
- One new cross-store waste read in `src/lib/db.ts`, shaped like
  `fetchEodSubmissionsForStores` / `fetchPosImportsForStores`.
- Generalizing or replacing `useCogsForCurrentStore` / `useTopVarianceItems` so the
  Dashboard can compute for an arbitrary store id and for a set of stores. (The pure
  functions `computeCogsTheoretical`, `computeCogsActual`, `computeTopVarianceItems`,
  `computeStoreFoodCostVariancePp` already take a `storeId` and need no change.)
- Scope-aware hero title + greeting line, and the i18n keys for them in en / es / zh-CN.
- Updating `e2e/dashboard-window.spec.ts` so the spec-080 assertions survive AC-P2.

## Out of scope (explicitly)

- **Reviving a global `'__all__'` store mode.** The picker is Dashboard-local; the
  `setCurrentStore` redirect and the defensive `__all__` guards in other sections stay
  exactly as they are. *Rationale: the owner locked this; a global all-stores mode is a
  much larger blast radius across ~6 sections.*
- **The phone tier (`PhoneDashboard`, gated by `useIsPhone` at
  `DashboardSection.tsx:431`).** No picker is added to the phone surface, and the phone
  layout is not redesigned. *Rationale: the phone surface has no room for a scope
  control and is already store-titled.* **Caveat:** see OQ-1 — the phone model today
  receives cross-store `totalInvValue` / `itemCount` / `outItems` under a single store's
  name, which is the same bug class; whether that gets fixed for free is OQ-1.
- **Making AVG FOOD COST % honest.** The per-day value is a mock heuristic
  (`30 + (entries.length % 5)`, `DashboardSection.tsx:349`, mirrored at `:896` for the
  per-card `food%` and inside `computeStoreFoodCostVariancePp`'s no-revenue fallback).
  This spec re-scopes it; it does not replace it. *Rationale: an honest number needs
  daily rollups (a `kpi_rollups_daily`-shaped table) and a revenue-weighting decision —
  that is its own spec, and mixing it in here would make the scoping change unreviewable.*
  The `SYNTHETIC_KPI_SERIES` / v1-proxy code comments must be preserved and updated to
  say the mock is now also aggregated.
- **Making the 4 synthetic KPI sparklines honest.** `synthSeries` stays. It is re-seeded
  by scope key (`'all'` or the store id) so the line does not reshuffle on every render,
  and that is the only change. *Rationale: same as above — needs real historical
  aggregates.*
- **Per-store food-cost targets.** `TARGET_FOOD_COST_PCT_DEFAULT = 30` remains a single
  brand-wide constant. *Rationale: pre-existing follow-up (architect Decision D3 of spec
  009); an aggregate view does not force it.*
- **Realtime freshness for non-focal stores.** Cross-store data stays mount-time only
  (the spec-009 R4 caveat). *Rationale: pre-existing; promoting to multi-channel
  subscriptions is its own spec.* Surfaced as a risk below.
- **A period selector.** `period: today` stays static text; the trailing-7-day windows
  stay 7 days.
- **Any schema change, migration, or edge function.**

---

## Decisions locked by the owner

- **D1 — Where the switch lives.** A **Dashboard-local** scope picker replacing the
  static `rightSlot` label. The global TitleBar store switcher is not touched,
  `currentStore` is not changed by it, and the `'__all__'` global mode is not revived.
- **D2 — Default scope.** The **currently selected store** (follows the global title-bar
  switcher), matching every other section. All-stores is one click away.
- **D3 — Surface.** The **desktop/tablet Cmd surface** is the target. The phone path is
  a scope boundary, not an open question (but see OQ-1 for the one interaction it has).

## PM decisions (made here; flip before build if you disagree)

- **PM-1 — Aggregate label.** All-stores mode is labeled `"All stores (N)"`, not by
  brand name. *Rationale: the brand name is not reliably available for non-super-admin
  roles (`brandsList` can be empty), and `visibleStores` already encodes the brand
  narrowing.* See OQ-2 to change this.
- **PM-2 — Scope is ephemeral.** Component-local React state. Not persisted to
  `profiles`, not to localStorage, not to the URL. Navigating away and back returns to
  the AC-P2 default.
- **PM-3 — AVG FOOD COST % derivation is unchanged per store.** The existing
  14-day-series derivation is extracted as a pure per-store helper so both modes call
  the same code; single-store mode for the focal store is numerically identical to
  today. Aggregation is the unweighted per-day mean (AC-B4).
- **PM-4 — Top-variance merge is per-store top-5 then global top-5.** Sound because the
  ranking metric is identical at both levels: an item in the global top 5 is necessarily
  in its own store's top 5.
- **PM-5 — The store-name column in the top-variance list stays in both modes.** Avoids
  a conditional column and keeps the two modes visually comparable.

---

## Open questions resolved

- **Q: Where does the user switch scope — the global title-bar switcher or a
  Dashboard-local control?** → **A:** Dashboard-local picker in the `TabStrip`
  `rightSlot`; the global switcher and `currentStore` are untouched, and the `'__all__'`
  global mode is not revived. (D1)
- **Q: What is the default scope on load — all stores, or the selected store?** → **A:**
  The currently selected store, following the global title-bar switcher, matching every
  other section. All-stores is one click away. (D2)
- **Q: Does this apply to the phone tier as well as desktop?** → **A:** Desktop/tablet
  Cmd surface only; the phone path is out of scope. (D3)

## Open questions REMAINING (non-blocking — each has a PM default the architect can build on)

- **OQ-1 — Phone-tier fallout (recommend: let it inherit).** `PhoneDashboard` is handed
  `totalInvValue`, `itemCount`, `outItems`, `outCount`, `lowCount` computed from the
  **cross-store** `inventory` slice while its header says `currentStore.name` — the same
  mis-scoping this spec fixes on desktop. If the shared memos become scope-derived, the
  phone (which has no picker and is always single-store) gets correct per-store numbers
  **for free**. *PM default: allow it — the phone model becomes single-store-correct, no
  phone UI change, and `PhoneDashboard.acReg.test.tsx` is updated if it pins the old
  cross-store values.* Flip to "freeze the phone numbers as-is" if you want zero phone
  movement in this spec.
- **OQ-2 — Aggregate label wording.** PM-1 uses `"All stores (N)"`. Do you want it to
  read as the brand instead — e.g. `"2AM PROJECT · 3 stores · day in progress"` — when a
  brand is selected? *PM default: no, keep "All stores (N)".*
- **OQ-3 — Should the picker remember the last scope within a session?** PM-2 says no
  (resets to the selected store on every mount). *PM default: no persistence.* Cheap to
  add later if the rollup view turns out to be the daily driver.
- **OQ-4 — Follow-up spec for honest food-cost + real sparklines.** This spec knowingly
  aggregates a mock. Do you want a follow-up spec queued now for a daily-rollup table so
  AVG FOOD COST %, the per-card `food%` and the 4 synthetic sparklines become real?
  *PM default: yes, queue it — but as a separate spec, not this one.*

---

## Dependencies

- **New cross-store waste read (backend).** `wasteLog` is focal-store only
  (`db.fetchWasteLog(storeId)`, `src/lib/db.ts:773`). Both all-stores mode **and**
  single-store mode for a *non-focal* store need waste for arbitrary stores. Needs a new
  `db.ts` helper in the shape of `fetchEodSubmissionsForStores` — `.in('store_id',
  storeIds)` plus a `since` cutoff (7 days is the only consumer; a 14-day window would
  match the existing effect's cushion). Must route through `useInflight.getState().track`
  like its siblings, and must preserve the frozen-`cost_per_unit` semantics (spec 104 R1)
  in its mapper. **This is the only backend work in the spec.**
- **Existing cross-store reads, reused as-is:** `db.fetchEodSubmissionsForStores`,
  `db.fetchPosImportsForStores`, `db.fetchOrderScheduleForStores`,
  `db.fetchOrderSubmissionsForStores` — already fetched at mount with a 14-day lookback,
  which is a strict superset of every window this spec needs.
- **Existing pure selectors, reused as-is:** `computeCogsTheoretical`,
  `computeCogsActual`, `computeTopVarianceItems`, `computeStoreFoodCostVariancePp`,
  `computeAttentionQueue` (all in `src/lib/cmdSelectors.ts`, all already `storeId`-keyed).
- **`visibleStoresFor` / `isPrivilegedRole`** — `src/lib/storeVisibility.ts` (spec 150).
- **Hook generalization:** `useCogsForCurrentStore` and `useTopVarianceItems` are
  `currentStore`-bound. Architect decides between adding an explicit-store variant and
  having the Dashboard call the pure functions directly with its cross-store state (the
  pattern the heatmap and attention queue already use). Check for other call sites before
  changing signatures.
- **A picker control.** `src/components/cmd/SelectField.tsx` exists (native `<select>` on
  web, inline panel on native) but is form-styled; the `rightSlot` is a 10.5px mono strip.
  Architect decides reuse vs. a small local control — either way AC-P6's test hooks are
  required.
- **i18n catalogs** — `src/i18n/{en,es,zh-CN}.json`, enforced by `src/i18n/i18n.test.ts`.
- **e2e** — `e2e/dashboard-window.spec.ts` (spec 080) must be updated in the same PR.

---

## Risks

- **R1 — e2e breakage is guaranteed, not hypothetical.** AC-P2 changes what renders on
  default Dashboard load; the spec-080 e2e asserts on a non-focal store's card. If AC-R4
  is skipped the `e2e.yml` lane goes red. (Note: `e2e.yml` is green as of `63dd9ab` but
  is not yet in the CLAUDE.md gate checklist — check it manually post-push.)
- **R2 — Staleness asymmetry in all-stores mode.** Only the focal store's slices are
  realtime; every other store's data is mount-time only (spec-009 R4). A brand-wide total
  can therefore lag a just-submitted EOD at another store until remount. Out of scope to
  fix; must be accepted knowingly.
- **R3 — Dashboard-local scope can diverge from the rest of the app.** A user can view
  store B's dashboard while every other section shows store A. This is the direct
  consequence of D1 + the "picker offers every visible store" shape. Mitigation is
  labeling (AC-S10 / AC-B10): the hero title always names the scope.
- **R4 — Aggregating a mock.** AC-B4 produces a brand-wide average of a heuristic. It is
  strictly more honest than today (which shows a *focal-store* mock under an *All stores*
  title), but it is still not a real food-cost number. See OQ-4.
- **R5 — Cross-store waste read volume.** `waste_log` has no per-store row cap; the
  helper must carry a date cutoff, not fetch the table. RLS (`auth_can_see_store()`)
  already narrows to visible stores — the client-side `scopedStoreIds` filter is a
  rendering rule, not the authorization boundary.
- **R6 — Silent 0-row RLS denials.** If the new helper is added, it must follow the
  sibling pattern (`console.warn` + return `[]` on error) rather than resolving as an
  empty success that reads as "$0 waste this week".

---

## Project-specific notes

- **Cmd UI section / legacy:** `src/screens/cmd/sections/DashboardSection.tsx` (Cmd UI).
  No legacy admin surface exists — spec 025 deleted it.
- **Per-store or admin-global:** per-store **and** brand-scoped. Both modes narrow
  through `visibleStoresFor(stores, currentUser, currentBrandId)`; the DB-side gate
  remains `auth_can_see_store()` and is unchanged by this spec.
- **Realtime channels touched:** none. No new channel, no publication change — so the
  realtime-publication gotcha (`docker restart supabase_realtime_imr-inventory`) does not
  apply here. Existing `store-{id}` / `brand-{id}` behavior is unchanged, with the R2
  staleness caveat.
- **Migrations needed:** no.
- **Edge functions touched:** none. The new cross-store waste read is PostgREST via
  `src/lib/db.ts` (the centralized-DB-access convention), not an edge function.
- **Web/native scope:** desktop + tablet Cmd surface, web **and** native (the section is
  shared). Phone tier excluded per D3 — see OQ-1.
- **`app.json` slug:** not touched. No build identifier, store listing, or push-cert
  change in this spec.
- **Test tracks:** Track 1 (jest) for reducers + picker behavior; Track 4 (Playwright
  e2e) for the spec-080 repair. Track 2 (pgTAP) only if the waste read lands as an RPC
  (AC-T4). No shell smokes.

---

# Backend design

Architect pass, 2026-08-16. Owner resolved OQ-1 (phone IN scope), OQ-2 (brand-named
aggregate label), OQ-3 (no persistence — default stands), OQ-4 (honest food-cost is a
separate spec — default stands). Those four are folded in below.

**Headline:** the spec's "no migration, no edge function, no realtime change" claim is
**verified correct** (§2, §5, §7). The whole backend surface is one new `src/lib/db.ts`
read plus four new pure functions in `src/lib/cmdSelectors.ts`. Everything else is
frontend.

Read before designing: `DashboardSection.tsx` (full), `cmdSelectors.ts:284-1054`,
`db.ts:773-802` / `1089-1152` / `1419-1465` / `5614-5721`, `storeVisibility.ts`,
`20260504173035_per_store_rls_hardening.sql`, `20260509000000_multi_brand_schema_rls.sql`,
`20260517040000_auth_can_see_store_brand_scope.sql`, `20260514140000_realtime_publication_tighten.sql`,
`PhoneDashboard.tsx` + its acReg test, `e2e/dashboard-window.spec.ts`, `TabStrip.tsx`,
`SelectField.tsx`, `TitleBar.tsx:42-97`, `i18n.test.ts`.

---

## 1. Data model changes

**None. No migration file in this spec.**

- No new table, column, index, constraint, view, RPC, trigger, grant, or publication
  change.
- The one new read is a PostgREST `select` over `public.waste_log`, a table that has
  existed since `20260405000759_init_schema.sql:138`.
- The index the new query needs **already exists**:
  `idx_waste_log_store_logged_at (store_id, logged_at)`, created by
  `20260512120000_report_run_variance.sql:619-620`. It is an exact prefix match for
  `WHERE store_id IN (...) AND logged_at >= $1`. No index work.

Rollout safety: N/A (nothing to roll out). The `db-migrations-applied.yml` gate is a
no-op for this spec because the migration set does not change.

---

## 2. RLS impact

**No policy is added, dropped, or edited. Verified, not inherited.**

The spec asserts the cross-store waste read needs no policy change. I checked the actual
policy chain rather than trusting it:

| Layer | Current state | Source |
|---|---|---|
| `waste_log` SELECT | `store_member_read_waste_log` — `USING (public.auth_can_see_store(store_id))` | `20260504173035_per_store_rls_hardening.sql:137-139` |
| Superseded policies | `"Store access"` (init) dropped by `20260502071736_remote_schema.sql:41`; `auth_manage_waste_log` dropped by the hardening migration:135 | — |
| Later migrations | `20260509000000_multi_brand_schema_rls.sql:991-1014` explicitly lists `waste_log` as **not modified** — it inherits brand scope through `auth_can_see_store()` | — |
| `auth_can_see_store()` today | `auth_is_super_admin() OR (auth_is_admin() AND auth_can_see_brand(store.brand_id)) OR user_stores membership` | `20260517040000_auth_can_see_store_brand_scope.sql:88-108` |

So `admin` / `master` (via `auth_is_admin()`, JWT `app_metadata.role`, defined at
`20260504073942_brand_catalog_p5_rls.sql:23-27`) and `super_admin` (via
`auth_is_super_admin()`) all read `waste_log` for every store they can see — the **same
gate, byte for byte**, that already admits `db.fetchEodSubmissionsForStores`'s
`.in('store_id', …)` fan-out on `eod_submissions`
(`20260504173035_per_store_rls_hardening.sql:66-68`). If the EOD fan-out works today for
a role, the waste fan-out works for that role. **Claim confirmed. No migration needed.**

Consequences the developer must not undo:

- **Do NOT pre-filter `storeIds` server-side for authorization.** RLS silently drops rows
  the caller can't see — same posture documented at `db.ts:1099-1102`. The client-side
  `scopedStoreIds` filter is a *rendering* rule (spec R5 is right about this).
- **Do NOT add `logger:profiles!logged_by(name)` or the two-hop
  `item:inventory_items(catalog:catalog_ingredients(name,unit))` embed to the new read.**
  See §4 — the aggregate needs neither, the embeds cost bytes on every non-focal store,
  and `profiles` SELECT is its own policy surface that would silently return `null` for
  some rows. Narrow column list only.
- No pgTAP test is required. AC-T4's condition ("unless the architect implements this as
  a SECURITY DEFINER RPC") does **not** fire — this is a plain PostgREST read (§4).

---

## 3. API contract

**PostgREST table read, not an RPC.** Rationale: it is a single-table, single-trip,
RLS-gated `SELECT` with no cross-table aggregation and no privilege elevation — exactly
the shape of the four cross-store reads the Dashboard already makes. An RPC would (a)
require a migration, (b) require the AC-T4 pgTAP test, (c) need `SECURITY DEFINER` +
hand-rolled visibility logic that duplicates `auth_can_see_store()`. All cost, no gain.

```
GET /rest/v1/waste_log
  ?select=id,store_id,item_id,quantity,unit,cost_per_unit,reason,logged_by,logged_at,notes
  &store_id=in.(<uuid>,<uuid>,…)
  &logged_at=gte.<ISO-8601 instant>
  &order=logged_at.desc
```

- **Request shape:** `storeIds: string[]` (uuids), `sinceISO: string` (full ISO-8601
  instant, e.g. `2026-08-02T14:03:11.000Z`). Note this differs from the sibling helpers'
  date-only `sinceDate` param, because `waste_log.logged_at` is a `timestamptz` while
  `eod_submissions.date` / `pos_imports.import_date` are `date`. Name the param
  `sinceISO` (not `sinceDate`) so the difference is visible at every call site.
- **Response shape:** `WasteEntry[]` (`src/types/index.ts:330-343`), see §5 for the
  mapper and its deliberately-sparse fields.
- **Error cases (degrade, don't throw — matches all four siblings):**
  - `storeIds.length === 0` → return `[]` **before** any network call
    (`db.ts:1107`, `1434`, `5696` precedent).
  - PostgREST error (RLS denial that surfaces as an error, network failure, aborted
    signal) → `console.warn('[Supabase] fetchWasteLogForStores:', error.message)` and
    return `[]`. Spec R6 is right that a silent empty-success reads as "$0 waste this
    week"; the `console.warn` is the sibling contract and is what the Dashboard's
    `.catch()` also does. **Do not** call `notifyBackendError` — none of the four
    existing cross-store reads toasts, and a toast on every Dashboard mount in a degraded
    network is worse than a warn.
  - Rows for stores the caller can't see are absent, not errors. Expected.

---

## 4. Edge function changes

**None.** No function added, modified, or retired. No `verify_jwt` change in
`supabase/config.toml`. The three HTTP-410 `staff-*` stubs stay stubs.

---

## 5. `src/lib/db.ts` surface

### 5.1 The one new export

```ts
/**
 * Spec 159 — cross-store waste fan-out for the Dashboard scope picker.
 * Sibling of fetchEodSubmissionsForStores / fetchPosImportsForStores /
 * fetchOrderScheduleForStores / fetchOrderSubmissionsForStores.
 *
 * AGGREGATE-ONLY SHAPE. Returns WasteEntry[] so it merges with the
 * `wasteLog` slice, but the joins the single-store fetchWasteLog makes
 * (profiles + inventory_items→catalog_ingredients) are DELIBERATELY
 * omitted: the only consumer sums quantity × costPerUnit. `itemName`
 * and `loggedBy` are '' — same "backfilled by caller if needed"
 * convention as fetchEodSubmissionsForStores' `storeName: ''`
 * (db.ts:1126). Do not render these rows in a list without hydrating.
 *
 * `timestamp` carries the RAW ISO `logged_at`, NOT fetchWasteLog's
 * `new Date(...).toLocaleString()`. See Risk R-A.
 *
 * Spec 104 R1: `cost_per_unit` is the FROZEN per-COUNTED-unit snapshot.
 * Pass it through UNBRIDGED — no `× subUnitSize` here or downstream.
 */
export async function fetchWasteLogForStores(
  storeIds: string[],
  sinceISO: string,
): Promise<WasteEntry[]>;
```

Implementation contract (developer authors the code):

- Wrap in `useInflight.getState().track(async (signal) => {...}, { kind: 'read', label: 'fetchWasteLogForStores' })` — mandatory, all five siblings do it.
- `.abortSignal(signal)` on the query.
- Narrow `select` (the column list in §3). No embeds.
- snake_case → camelCase mapping, mirroring `fetchWasteLog`'s mapper except as noted:

| column | field | note |
|---|---|---|
| `id` | `id` | |
| `store_id` | `storeId` | |
| `item_id` | `itemId` | |
| — | `itemName` | `''` — sparse, see docblock |
| `quantity` | `quantity` | |
| `unit` | `unit` | `w.unit \|\| ''` (no catalog join to fall back on) |
| `cost_per_unit` | `costPerUnit` | UNBRIDGED (spec 104 R1) |
| `reason` | `reason` | |
| `logged_by` | `loggedByUserId` | |
| — | `loggedBy` | `''` — sparse |
| `logged_at` | `timestamp` | **raw ISO**, not `toLocaleString()` |
| `notes` | `notes` | `w.notes \|\| ''` |

### 5.2 Nothing else in `db.ts` changes

`fetchWasteLog`, `fetchAllForStore`, and the `wasteLog` slice loader are untouched.

### 5.3 `src/lib/cmdSelectors.ts` — four new pure functions, two hook deletions

**Decision D-A: delete `useCogsForCurrentStore` and `useTopVarianceItems`; do not add
`storeIds` params to them and do not add sibling hooks.**

Justification (the spec left this open): (a) `DashboardSection.tsx:363-364` is the
**only** call site of either hook anywhere in the repo — verified by grep across `src/`,
`e2e/`, and `tests/`; nothing else imports them, no test pins them. (b) Both hooks read
the **focal-only** `eodSubmissions` / `posImports` slices, which is precisely the data
the Dashboard must stop using. (c) `cmdSelectors.ts:985-994` already states the house
rule: *"Callers needing cross-store data … must call the pure functions above directly
with component-local state."* Keeping a `currentStore`-bound hook alive next to a
`storeIds` variant is the drift surface spec 150 was written about. Delete both; the
Dashboard calls the new pure functions with `allEod` / `allPos`.

```ts
/** Per-store daily food-cost % series, oldest → newest, `null` on days with no EOD.
 *  EXTRACTED VERBATIM from DashboardSection.tsx:341-352 — the `30 + (entries.length % 5)`
 *  mock and the `.find()` (first-match) semantics are preserved byte for byte
 *  (PM-3 / AC-S4). `now` is injectable for deterministic tests. */
export function computeStoreFoodCostSeries(
  storeId: string,
  eodSubmissions: EODSubmission[],
  days?: number,          // default 14
  now?: Date,             // default new Date()
): Array<number | null>;

/** AC-B4 — per-day UNWEIGHTED mean across `storeIds`, over stores that have a value
 *  that day. A day where no scoped store has a value is `null`. Single-element
 *  `storeIds` returns computeStoreFoodCostSeries verbatim (mean of one === itself,
 *  no float drift) — this is what makes AC-S4 byte-identical. */
export function computeScopedFoodCostSeries(
  storeIds: string[],
  eodSubmissions: EODSubmission[],
  days?: number,
  now?: Date,
): Array<number | null>;

/** AC-B6 — per-store loop over the existing pure computeCogsTheoretical /
 *  computeCogsActual, then Σ. delta = Σactual − Σtheoretical;
 *  pct = Σtheoretical > 0 ? +((delta / Σtheoretical) * 100).toFixed(1) : 0
 *  — the SAME expression as the deleted useCogsForCurrentStore:1050-1051,
 *  so a single-element storeIds reproduces today's focal numbers exactly (AC-S6). */
export function computeScopedCogs(
  storeIds: string[],
  startDate: string,
  endDate: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  posImports: POSImport[],
  recipes: Recipe[],
): { theoretical: number; actual: number; delta: number; pct: number };

/** AC-B7 / PM-4 — per-store computeTopVarianceItems(…, limit) concatenated in
 *  `storeIds` order, re-sorted by |deltaCost| desc, sliced to `limit`. */
export function computeScopedTopVarianceItems(
  storeIds: string[],
  startDate: string,
  endDate: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  stores: Store[],
  limit?: number,         // default 5
): VarianceLine[];
```

**§5.3 semantics the developer must honor:**

- **Rounding.** `computeCogsTheoretical` / `computeCogsActual` each `+x.toFixed(2)`
  internally. `computeScopedCogs` sums the *already-rounded* per-store values, so the
  aggregate can drift from a single-pass sum by at most `N × 0.005`. Accepted — the card
  renders `Math.round(...)`. Do not "fix" it by reimplementing the pure functions.
- **PM-4 is sound, and here is why** (the spec asserted it without proof): the ranking
  key inside `computeTopVarianceItems` is `e.itemId`, which is `inventory_items.id` — a
  **per-store** row id (`cmdSelectors.ts:539-560`). Item ids never collide across stores,
  so there is no cross-store aggregation to lose. Merging N per-store top-5 lists and
  re-ranking is exactly equivalent to a global top-5. Corollary the UI must accept: the
  same catalog ingredient at three stores yields up to three rows — which is what PM-5's
  retained store-name column is for.
- **Tie-break determinism (needed by AC-T1).** Iterate `storeIds` in `visibleStores`
  order and rely on `Array.prototype.sort` stability (guaranteed by spec in every engine
  the app targets). Equal `|deltaCost|` therefore breaks by store order, then by the
  per-store function's own output order. Deterministic and testable.
- `stores` stays the **raw** `stores` slice at every `compute*` call site — those
  functions use it only for a `find()` name lookup (`cmdSelectors.ts:369`, `519`, `766`).
  Narrowing it to `visibleStores` could blank a name; narrowing the *iteration* is the
  whole job. Don't conflate them.

---

## 6. Frontend: scope state, derivation, and consumer re-keying

All of this lives in `src/screens/cmd/sections/DashboardSection.tsx`. **No slice of
`src/store/useStore.ts` changes** — see §8.

### 6.1 The scope state (AC-P2/P3/P4/P5, OQ-3)

```ts
type DashboardScope = { mode: 'store'; storeId: string } | { mode: 'all' };
```

Three values, in this order, all before the `storeLoading` and `isPhone` early returns:

1. **`scope`** — raw user pick. `React.useState<DashboardScope>(() => ({ mode: 'store', storeId: currentStore.id }))` (AC-P2). Component-local, never persisted (OQ-3/PM-2).
2. **AC-P4 reset** — use the render-phase "adjust state when a prop changes" pattern, *not* a `useEffect`:
   ```
   const [seenStoreId, setSeenStoreId] = useState(currentStore.id);
   if (seenStoreId !== currentStore.id) { setSeenStoreId(currentStore.id); setScope({ mode:'store', storeId: currentStore.id }); }
   ```
   An effect would paint one frame of the stale scope first. React re-renders
   synchronously before committing, so there is no visible flash and no extra DOM pass.
3. **`effectiveScope`** — **derived, never stored**:
   - If `isPhone` → **pinned** to `{ mode: 'store', storeId: currentStore.id }`, unconditionally. This is the whole of the OQ-1 fix (§6.4) and it also immunizes the phone against a web resize that carries an `all` scope down from the desktop tier. The phone deliberately bypasses AC-P5.
   - Else if `scope.mode === 'store'` and `scope.storeId` is not in `visibleStores` → `{ mode: 'all' }` (AC-P5). Derivation beats an effect here: it can't fight the AC-P4 reset and it can't loop.
   - Else `scope`.

Then:

```
visibleStores    = useMemo(() => visibleStoresFor(stores, currentUser, currentBrandId), [stores, currentUser, currentBrandId])
scopedStores     = effectiveScope.mode === 'all' ? visibleStores : visibleStores.filter(s => s.id === effectiveScope.storeId)
                   // phone: fall back to [currentStore] when the filter is empty, so the phone never renders a nameless zero-store dashboard
scopeStoreIds    = scopedStores.map(s => s.id)          // phone: [currentStore.id]
scopeIdSet       = useMemo(new Set(scopeStoreIds), [scopeIdsKey])
scopeIdsKey      = scopeStoreIds.join(',')              // dep-list handle
scopeKey         = effectiveScope.mode === 'all' ? 'all' : effectiveScope.storeId   // synthSeries seed
```

`scopedStores` derives by **filtering `visibleStores`**, which preserves its order for
free — that is AC-B8's "in `visibleStores` order".

Failure mode to be aware of, not to fix: `currentUser` is `null` on first paint, and
`visibleStoresFor` fails closed to `[]` (`storeVisibility.ts:50`). On desktop that means
one frame of `effectiveScope = {mode:'all'}` over zero stores → zero KPIs + the existing
`noStoresVisible` heatmap string. When `currentUser` hydrates, `scopeIdsKey` changes and
both the memos and the mount effect re-run. Acceptable; it is strictly better than
today's "render other brands' stores until the user notices."

### 6.2 Mount-time cross-store fetch (AC-V2)

`DashboardSection.tsx:173-209` changes in exactly three ways:

1. `const storeIds = visibleStores.map(s => s.id)` instead of `stores.map(...)` (AC-V2).
2. A fifth call, same `cancelled` guard, same `.catch(console.warn)` shape:
   `db.fetchWasteLogForStores(storeIds, sinceISO).then(rows => { if (!cancelled) setCrossStoreWaste(rows); })`
   where `sinceISO = new Date(Date.now() - 14*24*3600*1000).toISOString()`. Keep the
   existing date-only `since` for the four existing calls — they take `date` columns.
   14 days is the same cushion; 7 is all the KPI needs.
3. Dep list becomes `[scopeIdsKey-of-visibleStores, currentStore.id]` — i.e. replace
   `stores.map(s => s.id).join(',')` with `visibleStores.map(s => s.id).join(',')` so a
   brand switch refetches. Keep `currentStore.id` (the focal-merge pivot depends on it).

New state: `const [crossStoreWaste, setCrossStoreWaste] = useState<WasteEntry[]>([])`.

### 6.3 The focal-over-cross merge (mirrors `allEod` at :213-216)

```ts
const allWaste = React.useMemo<WasteEntry[]>(() => {
  const others = crossStoreWaste.filter((w) => w.storeId !== currentStore.id);
  return [...others, ...wasteLog];          // focal slice LAST → focal stays realtime-fresh
}, [crossStoreWaste, wasteLog, currentStore.id]);
```

This is the identical shape to `allEod` / `allPos` / `allOrderSubmissions`, and it is why
the focal store's waste stays live on the `store-{id}` realtime channel while the rest is
mount-time only (R2, pre-existing).

`wasteWeek` then becomes:

```
cutoff = Date.now() - 7*24*3600*1000
Σ over allWaste where scopeIdSet.has(w.storeId)
              and Number.isFinite(Date.parse(w.timestamp))     // see Risk R-A
              and Date.parse(w.timestamp) >= cutoff
  of  w.quantity * w.costPerUnit          // UNBRIDGED — spec 104 R1, AC-S3/AC-B3
```

`wasteEventCount` (phone) gets the same scope + cutoff filter.

### 6.4 Every existing consumer, re-keyed

| Consumer | Today | Becomes | AC |
|---|---|---|---|
| `focalInventory` (:240) | `inventory` filter on `currentStore.id` | **unchanged** — `eodRows` is deliberately focal per-vendor progress | — |
| *(new)* `scopedInventory` | — | `useMemo(inventory.filter(i => scopeIdSet.has(i.storeId)), [inventory, scopeIdsKey])` — **one** memo, five consumers | AC-S1/S2, AC-B1/B2 |
| `totalInvValue` (:244) | `inventory` unfiltered | `scopedInventory`, same `× (subUnitSize \|\| 1)` bridge | AC-S1/B1 |
| `itemCount` (:250) | `inventory.length` | `scopedInventory.length` | AC-S1/B1 |
| `storeCount` (:251) | `stores.length` | `scopedStores.length` | AC-S1, AC-B5 |
| `lowOutAll` / `outCount` / `lowCount` (:264-272) | `inventory` | `scopedInventory` | AC-S2/B2 |
| `outItems` (:285) | `inventory` | `scopedInventory` | OQ-1 |
| `wasteWeek` (:253) / `wasteEventCount` (:289) | `wasteLog` (focal) | `allWaste` + `scopeIdSet` (§6.3) | AC-S3/B3 |
| `eodSubmittedToday` (:275) | `stores.filter(...)` | `scopedStores.filter(...)` over `allEod` | AC-S5/B5 |
| `foodCostTrend14` (:341) | inline mock over `eodSubmissions` | `computeScopedFoodCostSeries(scopeStoreIds, allEod, 14)` | AC-S4/B4, PM-3 |
| `fcSeries` (:354) | `synthSeries(..., \`${currentStore.id}:fc\`)` | seed becomes `` `${scopeKey}:fc` `` | out-of-scope §"synthSeries stays" |
| all 4 other `synthSeries` seeds (:485,501,511,519) | `currentStore.id` | `scopeKey` | same |
| `cogs` (:363) | `useCogsForCurrentStore(7)` | `computeScopedCogs(scopeStoreIds, start, end, inventory, allEod, allPos, recipes)` | AC-S6/B6 |
| `topVariance` (:364) | `useTopVarianceItems(7,5)` | `computeScopedTopVarianceItems(scopeStoreIds, start, end, inventory, allEod, stores, 5)` | AC-S7/B7 |
| `heatmapRows` (:376) | `stores.map` | `scopedStores.map` | AC-S8/B8 |
| `queueByStore` (:394) | `for (const s of stores)` | `for (const s of scopedStores)`; the `stores` **argument** to `computeAttentionQueue` stays the raw slice | AC-S9/B9 |
| store-card grid (:588) | `stores.map` | `scopedStores.map` | AC-S9/B9 |
| greeting line (:467) | `greetingLine` + `stores.length` | `greetingLineStore` (single) / `greetingLine` with `scopedStores.length` (all) | AC-I2 |
| hero title (:469) | `heroTitle` fixed string | `heroTitleScope` + resolved label (§9) | AC-S10/B10, AC-I1 |
| `rightSlot` (:456-461) | static text | `ScopePicker` + unchanged `period: today` | AC-P1 |

New store subscription needed: `const recipes = useStore((s) => s.recipes)` (the deleted
`useCogsForCurrentStore` used to read it).

`recipes` is **brand-scoped** (`fetchAllForStore` → `fetchRecipes(brandId)` for the focal
store's brand only). See Risk R-B.

**Phone (OQ-1) is now free.** `PhoneDashboard`'s model literal at :433-446 does not change
one character — `totalInvValue` / `itemCount` / `outCount` / `lowCount` / `outItems` /
`wasteWeek` / `wasteEventCount` are the same identifiers, now derived from
`scopedInventory` / `allWaste`, which on the phone are pinned to `currentStore.id` by
§6.1 step 3. The header's `currentStore.name` and the numbers under it finally describe
the same restaurant. `PhoneDashboard.tsx` is **not edited** (AC-R5 stays green — its
acReg test seeds `stores: []` + `inventory: []`, so every path still renders).

### 6.5 The picker control (AC-P1, AC-P6, AC-P7)

**Decision D-B: a small local `ScopePicker` component inside `DashboardSection.tsx`, not
`SelectField`.** Justification: (a) `SelectField` renders an uppercase label *above* a
32px bordered box (`SelectField.tsx:40-48`) — wrong furniture for a 10.5px mono strip
inside a 28px-tall `TabStrip` row; (b) its web branch is a native `<select>`, whose
`<option>`s cannot be `click()`ed by Playwright or `fireEvent.press`ed by RNTL, which
AC-P6 + AC-T2 + AC-T3 all require; (c) `Kpi`, `CogsCard`, `CogsStat`, `HeatmapLegend`,
`StoreCol`, `Mini2` are all already section-local components in this file — this is the
established pattern, not a new one.

Shape:

- Trigger: `TouchableOpacity`, `testID="dashboard-scope-picker"`,
  `accessibilityRole="button"`, `accessibilityLabel={T('section.dashboard.scopePickerA11y')}`,
  renders `T('section.dashboard.storeSelector')` + the resolved strip label + `▼`.
- Panel: absolutely positioned under the trigger, `zIndex: 50`, right-aligned. Options in
  order: aggregate first (`testID="dashboard-scope-option-all"`), then one per
  `visibleStores` entry (`testID={`dashboard-scope-option-${s.id}`}`), each a
  `TouchableOpacity` with `accessibilityRole="menuitem"`. Closes on select.
- AC-P7: when `visibleStores.length <= 1` (including `0`), still render the trigger and
  still render the aggregate option. Never render an empty panel — with zero visible
  stores the panel has exactly the one aggregate row.
- The `TabStrip` itself is **not modified** — `rightSlot` already accepts arbitrary
  `React.ReactNode` (`TabStrip.tsx:19,76`). Verify on native tablet that the absolute
  panel is not clipped by the strip's sibling `ScrollView`; if it is, wrap the strip in a
  `zIndex`-raised `View` inside `DashboardSection` rather than editing `TabStrip`
  (AC-R2 protects other sections, and `TabStrip` is shared by many).

---

## 7. Realtime impact

**No change. No new channel, no new subscription, no publication membership change
(AC-R3 honored).**

- `public.waste_log` has been in the `supabase_realtime` publication since
  `20260514140000_realtime_publication_tighten.sql:45`, filtered `store_id=eq.<id>` on
  the `store-{id}` channel. This spec adds no table to and removes no table from that
  publication.
- **The publication gotcha does NOT apply to this spec.** Because
  `ALTER PUBLICATION supabase_realtime` is never executed, no
  `docker restart supabase_realtime_imr-inventory` step is needed after `npm run dev:db`.
  Flagging this explicitly so nobody adds a phantom deploy step — and so that if a
  reviewer *does* see a publication statement appear in a migration during
  implementation, they know it is out of contract.
- Replay behavior, unchanged: `store-{currentStore.id}` refreshes the focal store's
  `inventory` / `wasteLog` / `eodSubmissions`, and the `allEod` / `allPos` / `allWaste`
  merges put the focal slice last, so the focal store's contribution to a brand-wide
  total is live. Every non-focal store is mount-time only. That is spec R2, pre-existing,
  knowingly accepted.

---

## 8. Frontend store impact (`src/store/useStore.ts`)

**No slice changes. No new action. No new state.**

- Scope is component-local by owner decision (OQ-3 / PM-2 / D1).
- `setCurrentStore`, the `'__all__'` sentinel redirect (`useStore.ts:1406-1440`), and the
  ~6 defensive `__all__` guards in other sections are **not touched** (AC-R1).
- `currentBrandId` / `setCurrentBrandId` are read-only inputs here (AC-P3).
- **The optimistic-then-revert + `notifyBackendError` pattern does not apply.** This spec
  adds zero writes. Every new path is a read that degrades to `[]` with a `console.warn`
  (§3). Do not wire a toast into `fetchWasteLogForStores`.

---

## 9. i18n contract (AC-I1..I5) — supersedes AC-I1/AC-I3 wording

OQ-2 resolved the aggregate label to **brand-named**, which changes the key set AC-I1
proposed. The full contract, with the OQ-2 fallback the owner asked to be specified
rather than left to the developer:

### 9.1 Label resolution (this is the OQ-2 edge-case answer)

Two pure resolvers, both `useMemo`'d in `DashboardSection`:

```
brandNameByBrandId = { ...map over brandsList } then { [brand.id]: brand.name } if brand?.id
                     // exactly TitleBar.tsx:60-65's merge: brandsList covers super-admins,
                     // `brand` covers regular admins/masters who only ever load their own.

scopeBrandName(scopedStores):
  ids = distinct brandId over scopedStores
  if ids.length !== 1  -> null            // super-admin on "All brands" spanning >1 brand
  return brandNameByBrandId[ids[0]] ?? null   // brand slice not loaded yet -> null
```

Then:

| Surface | `mode: 'store'` | `mode: 'all'`, brand name resolved | `mode: 'all'`, brand name `null` |
|---|---|---|---|
| Hero title | `heroTitleScope` with `scope = store.name` | `heroTitleScope` with `scope =` `scopeAllBrand` / `scopeAllBrandOne` | `heroTitleScope` with `scope =` `scopeAllFallback` |
| Strip + picker option | `store.name` | `scopeAllBrand` / `scopeAllBrandOne` | existing `allStores` (`"all ({count})"`) |
| Greeting line | `greetingLineStore` | `greetingLine` (existing) | `greetingLine` (existing) |

Two label variants (hero vs. strip) exist only in the fallback column: the strip is
prefixed by `store:` so `"store: All stores (3)"` reads badly, while a hero reading
`"all (3) · day in progress"` reads badly. Everywhere else the two agree by construction,
which is what makes the picker trigger and the hero title impossible to desync.

`brandNameByBrandId` is a near-duplicate of `TitleBar.tsx:60-65`. **Preferred:** lift a
pure `brandNameFor(brandId, brand, brandsList): string | null` into
`src/lib/storeVisibility.ts` (already the no-React, no-store home of the store/brand
identity rules; adding it there is why that module exists) and call it from the
Dashboard. **Do not** refactor `TitleBar` in this spec — it needs *initials*, not names,
and touching it risks AC-R2's spirit. Note the remaining near-duplication for a future
pass.

### 9.2 Exact catalog diff — `src/i18n/{en,es,zh-CN}.json`, under `section.dashboard`

**Delete (1):** `heroTitle` — its only call site (`DashboardSection.tsx:469`) goes away
in the same PR (AC-I5). Remove from all three catalogs or the parity test fails.

**Add (6),** with real translations (AC-I4 — no English copies):

| key | en | es | zh-CN |
|---|---|---|---|
| `heroTitleScope` | `{scope} · day in progress` | `{scope} · día en curso` | `{scope} · 当日进行中` |
| `scopeAllBrand` | `{brand} · {count} stores` | `{brand} · {count} tiendas` | `{brand} · {count} 家门店` |
| `scopeAllBrandOne` | `{brand} · {count} store` | `{brand} · {count} tienda` | `{brand} · {count} 家门店` |
| `scopeAllFallback` | `All stores ({count})` | `Todas las tiendas ({count})` | `全部门店 ({count})` |
| `greetingLineStore` | `// {greeting}, admin · {date} · {store}` | `// {greeting}, admin · {date} · {store}` | `// {greeting},管理员 · {date} · {store}` |
| `scopePickerA11y` | `Dashboard scope` | `Alcance del panel` | `面板范围` |

**Keep, still used:** `storeSelector`, `allStores`, `period`, `periodToday`,
`greetingLine`, every `kpi.*`, `noStoresVisible`.

Net: `en.json` grows by 5 leaf keys; the `i18n.test.ts` set-equality assertion
(`i18n.test.ts:41-57`) plus the all-leaves-are-strings assertion must stay green.

---

## 10. Tests (refines AC-T)

- **AC-T1 (jest, pure).** The four new `cmdSelectors` functions with ≥2-store fixtures
  including an empty store: `computeScopedFoodCostSeries` (per-day mean, all-null day
  stays null, single-store identity vs `computeStoreFoodCostSeries`),
  `computeScopedCogs` (Σ, `pct === 0` when `Σtheoretical === 0`, single-store identity),
  `computeScopedTopVarianceItems` (merge → re-rank → truncate, deterministic tie-break).
  Inject `now` for the series functions. Plus the inventory/alert/waste/EOD reducers —
  if those stay as inline `useMemo`s in the component they are only reachable through
  AC-T2; extracting `wasteWeek`'s reducer is optional but makes AC-T1 cheaper.
- **`db.crossStoreLoaders.test.ts` extension.** That file
  (`src/lib/db.crossStoreLoaders.test.ts`) already pins the empty-input short-circuit,
  the `.in()` shape, and the error→`[]` degrade for the two spec-081 loaders. Add
  `fetchWasteLogForStores` to it — same three cases, plus a mapper assertion that
  `costPerUnit` is passed through unbridged and `timestamp` is the raw `logged_at`.
- **AC-T2 (jest, component).** As written in the spec. Add one case: with `isPhone`
  true, the phone model's `totalInvValue` counts only the focal store's rows even when
  `inventory` holds two stores (the OQ-1 regression guard). And one for AC-P5 (a scope
  store outside `visibleStores` falls back to `all`, not to an empty dashboard).
- **AC-T3 (Playwright).** `e2e/dashboard-window.spec.ts` — insert, after
  `await expect(page.getByTestId('dashboard-root')).toBeVisible()` (line 228):
  click `dashboard-scope-picker`, then click
  `` `dashboard-scope-option-${SEED.e2eWindowStoreId}` ``. **Preferred over
  `dashboard-scope-option-all`** because it renders exactly one card, which strengthens
  the already card-scoped `toHaveCount(0)` absence assertion against interference. Either
  satisfies AC-R4. `e2e/dashboard.spec.ts` needs **no** change — it asserts only
  `dashboard-root` + `dashboard-kpis`, both of which still render on default load.
- **AC-T4.** Confirmed not required: no RPC, no new policy, no pgTAP.

---

## 11. Risks and tradeoffs

- **R-A — `WasteEntry.timestamp` is a locale string on the focal half.**
  `fetchWasteLog` writes `new Date(w.logged_at).toLocaleString()` (`db.ts:797`) and the
  Dashboard reparses it with `new Date(w.timestamp)` (`:260`). `toLocaleString()` uses
  the **runtime** locale, not the app locale — under a zh-CN/ja/ar system locale the
  round-trip yields `Invalid Date` → `NaN >= cutoff` is false → the row is silently
  dropped and WASTE/WK reads `$0`. **Pre-existing**, not introduced here. This design
  contains it: the new cross-store rows carry raw ISO (always parseable), and the
  reducer's `Number.isFinite(Date.parse(...))` guard makes the drop explicit rather than
  accidental. The focal half stays as fragile as it is today — no regression, no fix.
  **Recommend filing a follow-up** to make `WasteEntry.timestamp` ISO end-to-end (it
  touches `WasteLogSection`'s renderer, so it is genuinely its own spec).
- **R-B — brand-wide CoGS *theoretical* is understated when the scope spans brands.**
  `computeCogsTheoretical` needs `recipes`, and the `recipes` slice only ever holds the
  **focal store's brand** (`fetchAllForStore` → `fetchRecipes(brandId)`). For a
  super-admin on "All brands" whose `visibleStores` span two brands, stores outside the
  loaded brand contribute `0` theoretical while contributing full `actual` — inflating
  Δ and pct. AC-B6 should be read as *"correct within one brand."* Mitigations already in
  the design: the OQ-2 label resolver detects exactly this case (>1 distinct brandId) and
  degrades to the generic `All stores (N)` string, so the title stops claiming a brand it
  isn't. **I recommend the PM add an explicit sentence to AC-B6 saying so** rather than
  shipping it undocumented. Fixing it properly = a cross-brand recipe fetch, which is the
  OQ-4 follow-up's territory.
- **R-C — aggregating a mock (spec R4), amplified.** AC-B4 averages
  `30 + (entries.length % 5)` across stores. This is strictly more honest than today
  (a *focal-store* mock under an *All stores* title), but the
  `SYNTHETIC_KPI_SERIES` / v1-proxy comments at `DashboardSection.tsx:38-44` and
  `:347-349` **must be updated to say the mock is now also aggregated** (the spec asks
  for this; it is easy to forget in the diff).
- **R-D — performance on the 286 KB seed.** `inventory` is genuinely cross-store
  (`fetchAllForStore` calls `fetchInventory()` with no store filter, `db.ts:5630`).
  Filtering it five separate times per render would be the naive read of the AC table —
  hence the **single** `scopedInventory` memo + `Set` lookup in §6.4. The new waste query
  is index-covered (§1). Net render cost should be flat or slightly better than today
  (the heatmap/queue loops now iterate `scopedStores`, which is ≤ `stores`).
- **R-E — `visibleStoresFor` on first paint returns `[]`.** Covered in §6.1. Worth a
  reviewer's eye because it changes what the *mount effect* requests (nothing, then
  everything) — a double-fetch on login is possible. The `cancelled` guard already
  handles the ordering; the cost is one wasted round trip.
- **R-F — R3 divergence is now visible, not hidden.** The user can read store B's
  dashboard while every other section shows store A. That is the direct, owner-accepted
  consequence of D1. The hero title naming the scope (AC-S10/B10) is the only mitigation
  and it is therefore **not optional** — a reviewer should treat a missing/incorrect hero
  title as a Critical, not a Minor.
- **R-G — e2e (spec R1).** Guaranteed break without AC-T3. `e2e.yml` is green as of
  `63dd9ab` but is not yet in the CLAUDE.md gate checklist — check it manually after the
  push.
- **Migration ordering:** N/A. **Edge-function cold start:** N/A. **CI:** the
  `db-migrations-applied.yml` gate is unaffected (no migration); `test.yml` gains the new
  jest specs and must stay green including `typecheck:test`.

---

## 12. Where I disagree with the spec

1. **AC-I1's key names are superseded** by the OQ-2 resolution. `heroTitleStore` +
   `heroTitleAllStores` are replaced by `heroTitleScope` + a three-way label resolver
   (§9). The *intent* of AC-I1 (hero title is no longer a fixed string; scope is named) is
   fully satisfied. Reviewers should grade against §9.2, not AC-I1's table.
2. **AC-P1's option label** ("All stores (N)") likewise becomes brand-named with the §9.1
   fallback, so the picker and the hero can never disagree.
3. **AC-B6 is silent about the cross-brand recipe gap** (R-B). It is not wrong, it is
   incomplete. Requesting a PM amendment sentence rather than designing around it.
4. **AC-T4's condition does not fire** — confirmed no RPC, so no pgTAP. Recorded so a
   reviewer doesn't read the missing pgTAP file as an omission.
5. **AC-R5 is satisfiable without touching `PhoneDashboard.acReg.test.tsx`** — the OQ-1
   fix lands entirely in `DashboardSection`'s memos, and that test seeds `stores: []` /
   `inventory: []`. If a developer finds themselves editing that test, something drifted
   from this design.
6. **Everything else in the AC set I agree with**, including the AC-B1 behavior change
   (excluding non-visible stores from the inventory total) — which is not merely a
   scoping change but closes a real cross-brand information leak in the headline number
   for super-admins.

---

## 13. Files this design touches

**Backend lane (`backend-developer`)**
- `src/lib/db.ts` — add `fetchWasteLogForStores` (§5.1). Nothing else.
- `src/lib/cmdSelectors.ts` — add 4 pure functions, delete 2 hooks (§5.3).
- `src/lib/db.crossStoreLoaders.test.ts` — extend (§10).
- `src/lib/storeVisibility.ts` — add `brandNameFor` (§9.1, preferred).
- New: pure-function unit tests for §5.3 (AC-T1).

**Frontend lane (`frontend-developer`)**
- `src/screens/cmd/sections/DashboardSection.tsx` — §6 in full, incl. the local
  `ScopePicker`.
- `src/i18n/en.json`, `es.json`, `zh-CN.json` — §9.2.
- `e2e/dashboard-window.spec.ts` — §10 / AC-R4.
- New: component tests (AC-T2).

**Not touched:** `supabase/migrations/*`, `supabase/functions/*`, `supabase/config.toml`,
`src/store/useStore.ts`, `src/hooks/useRealtimeSync.ts`,
`src/screens/cmd/sections/phone/PhoneDashboard.tsx`, `src/components/cmd/TabStrip.tsx`,
`src/components/cmd/TitleBar.tsx`, `app.json`.

---

## Files changed

### Backend lane (`backend-developer`, 2026-08-16)

**`src/lib/db.ts`**
- Added `fetchWasteLogForStores(storeIds: string[], sinceISO: string): Promise<WasteEntry[]>`
  (§5.1) — the spec's only backend read. Single-trip `.in('store_id', …)` +
  `.gte('logged_at', sinceISO)` + `.order('logged_at', desc)`, narrow column list, no
  embeds, wrapped in `useInflight.getState().track(..., { kind: 'read' })` with
  `.abortSignal(signal)`. Degrades to `[]` on empty input and on PostgREST error with a
  `console.warn` (no toast — matches all four sibling cross-store reads).
- **R-A containment:** the new rows carry the **raw ISO** `logged_at` in `timestamp`.
  `fetchWasteLog` (single store) is UNTOUCHED and still stores
  `new Date(...).toLocaleString()`; the asymmetry, why it exists, and the
  `Number.isFinite(Date.parse(...))` guard consumers must keep are documented in the new
  function's docblock. Making `WasteEntry.timestamp` ISO end-to-end remains a follow-up
  (it touches `WasteLogSection`'s renderer).
- `itemName` / `loggedBy` are `''` (aggregate-only shape, no `profiles` or
  `inventory_items→catalog_ingredients` embeds); `cost_per_unit` passes through
  **unbridged** per spec 104 R1.
- Nothing else in `db.ts` changed.

**`src/lib/cmdSelectors.ts`**
- Added four pure functions per §5.3: `computeStoreFoodCostSeries`,
  `computeScopedFoodCostSeries` (AC-B4), `computeScopedCogs` (AC-B6),
  `computeScopedTopVarianceItems` (AC-B7 / PM-4). All take `storeIds: string[]` and loop
  the existing per-store pure functions — no per-store maths is reimplemented, so
  single-element `storeIds` reproduces the pre-159 focal numbers (AC-S4 / S6 / S7).
- Deleted `useCogsForCurrentStore` and `useTopVarianceItems` per **D-A**. Re-verified by
  grep across `src/`, `e2e/`, `tests/`, `scripts/` before deleting: `DashboardSection.tsx:363-364`
  was the only call site in the repo. A tombstone comment replaces them in the (now empty)
  hooks section, and the "cross-store callers use the pure functions" house rule is kept
  and extended to name `fetchWasteLogForStores`.
- The R-B cross-brand `recipes` gap is recorded as a DOCUMENTED LIMITATION in the
  `computeScopedCogs` docblock (and in AC-B6 above). No cross-brand recipe fetch added.

**`src/lib/storeVisibility.ts`**
- Added `brandNameFor(brandId, brand, brandsList): string | null` (§9.1 "preferred"),
  the pure brand-id → name resolver the Dashboard's OQ-2 label needs. `brand` wins over
  `brandsList`; returns `null` (never a placeholder) for "All brands", unknown ids, blank
  names and pre-hydration first paint. `TitleBar.tsx` was **not** refactored onto it
  (it needs initials; out of blast radius) — noted in the docblock as a cheap follow-up.

**Tests (Track 1 / jest)**
- `src/lib/db.crossStoreLoaders.test.ts` — extended with a `fetchWasteLogForStores`
  describe: empty-input short-circuit, `.in()`/`.gte()` shape + source-table pin,
  error → warn → `[]`, no-rows → `[]`, plus the two load-bearing mapper assertions
  (raw-ISO `timestamp`, unbridged `costPerUnit`) and the sparse-field contract.
- `src/lib/cmdSelectors.scopedRollups.test.ts` (**new**) — 24 cases over ≥2-store
  fixtures plus a store with no data: single-store identity for all three scoped
  functions, per-day unweighted mean with all-null days preserved, `pct === 0` when
  `Σtheoretical === 0`, empty-`storeIds` behavior, float-dust guard, deterministic
  tie-break by `storeIds` order, and an explicit pin of the R-B understatement.
- `src/lib/storeVisibility.test.ts` — added a `brandNameFor` describe (6 cases).

**Verification**
- `npx tsc --noEmit` and `npm run typecheck:test` clean.
- Jest: the three backend-lane suites green; full-suite run has no failures attributable
  to this lane.
- Live local stack (`npm run dev:db`): the exact wire query was exercised against
  PostgREST as `admin@local.test` over two stores with seeded `waste_log` rows — the
  narrow select returns every column the mapper needs, the `logged_at` cutoff excludes an
  out-of-window row, and `logged_at` arrives as a parseable ISO instant. Re-run as the
  non-privileged `manager@local.test` (grants: Towson + Frederick) asking for
  Towson + Charles: HTTP 200 with the Charles row **silently dropped** by
  `auth_can_see_store()` — confirming the "RLS narrows, the client list is a rendering
  rule" posture and that no server-side pre-filter is needed. Probe rows deleted
  afterwards; `waste_log` is back to 0 local rows.

**Out of contract, confirmed not written:** no migration, no RPC, no edge function, no
`supabase/config.toml` change, no `supabase_realtime` publication change (so no
`docker restart supabase_realtime_imr-inventory` step), no `src/store/useStore.ts` change,
no component / i18n-catalog edits.

### Frontend lane (`frontend-developer`, 2026-08-16)

**`src/screens/cmd/sections/DashboardSection.tsx`** (§6 in full)
- **Scope state (§6.1).** New `DashboardScope` type; `scope` state defaulting to
  `{ mode: 'store', storeId: currentStore.id }` (AC-P2); the AC-P4 reset as a
  render-phase adjustment (`seenStoreId`), not a `useEffect`; `effectiveScope` derived —
  phone-pinned first (OQ-1), then the AC-P5 "picked store is no longer visible → `all`"
  fallback. All of it above the `storeLoading` / `isPhone` early returns, so hook order is
  identical on every tier. Nothing is persisted (OQ-3 / PM-2) and `setCurrentStore` /
  `currentBrandId` / `profiles` are never written (AC-P3).
- **`visibleStores` is now the only store enumeration (AC-V1/V3):** picker options,
  `scopedStores`, heatmap rows, card grid, the `x/N` denominator, the greeting count and
  the mount-effect id list all read `visibleStoresFor(stores, currentUser, currentBrandId)`.
  `scopedStores` is a FILTER of `visibleStores`, which is what gives AC-B8 its ordering.
- **Mount-time cross-store fetch (AC-V2):** id list switched from the raw `stores` slice to
  `visibleStores`; dep list is now `[visibleStoreIdsKey, currentStore.id]` so a brand
  switch refetches. Added the fifth read, `db.fetchWasteLogForStores(storeIds, sinceISO)`
  with a 14-day ISO cutoff (the four existing reads keep their date-only `since`).
- **`allWaste` merge (§6.3)** in the identical focal-slice-last shape as `allEod` /
  `allPos`, so the focal store's waste stays realtime-fresh (R2 unchanged).
- **Consumers re-keyed:** one `scopedInventory` memo (R-D) feeds `totalInvValue`,
  `itemCount`, `lowOutAll`/`outCount`/`lowCount` and `outItems`; `storeCount` →
  `scopedStores.length`; `wasteWeek` / `wasteEventCount` → `allWaste` + `scopeIdSet` +
  the R-A `Number.isFinite(Date.parse(...))` guard, still UNBRIDGED (spec 104 R1);
  `eodSubmittedToday` → `scopedStores`; `foodCostTrend14` →
  `computeScopedFoodCostSeries(scopeStoreIds, allEod, 14)`; `cogs` → `computeScopedCogs`;
  `topVariance` → `computeScopedTopVarianceItems`; `heatmapRows` and `queueByStore` and
  the store-card grid → `scopedStores` (the `stores` ARGUMENT into `computeAttentionQueue`
  / `computeTopVarianceItems` deliberately stays the raw slice — name lookup only).
  All five `synthSeries` seeds → `scopeKey`. `focalInventory` / `eodRows` /
  `recentActivity` stay focal on purpose.
- **`ScopePicker` (§6.5, D-B)** — new section-local component in this file (not
  `SelectField`): `TouchableOpacity` trigger `testID="dashboard-scope-picker"` +
  `accessibilityLabel` from `scopePickerA11y`, absolutely-positioned panel with
  `dashboard-scope-option-all` first and `dashboard-scope-option-{storeId}` per visible
  store, `accessibilityRole="menuitem"`, closes on select (AC-P6). AC-P7: the aggregate
  option renders even at 0/1 visible stores, so the panel is never empty. `TabStrip` is
  NOT modified — the panel's stacking is handled by a `zIndex: 50` wrapper `View` around
  `<TabStrip>` inside this section. `period: today` is unchanged.
- **Labels (§9.1):** one `aggregateLabelFor(list, fallbackKey)` resolver feeds the hero
  title, the trigger and the aggregate option, so they cannot desync. Distinct `brandId`
  over the scoped list; not exactly 1 → `null` → generic label; else `brandNameFor(...)` →
  `scopeAllBrand` / `scopeAllBrandOne`. Hero falls back to `scopeAllFallback`, strip +
  option to the existing `allStores`. New `testID`s `dashboard-hero-title` /
  `dashboard-greeting` on the two scope-naming lines (R-F says the hero title is
  load-bearing, so it is now assertable).
- **Comments:** the `SYNTHETIC_KPI_SERIES` / v1-proxy notes are updated to say the mock is
  now scope-seeded and, in `all` mode, aggregated (R-C).
- **Phone:** `PhoneDashboard.tsx` is untouched; its model literal passes the same
  identifiers, which are now single-store-correct (OQ-1).

**`src/i18n/en.json`, `es.json`, `zh-CN.json`** (§9.2)
- Deleted `section.dashboard.heroTitle` from all three (its only call site went away in
  this PR — AC-I5).
- Added `heroTitleScope`, `scopeAllBrand`, `scopeAllBrandOne`, `scopeAllFallback`,
  `greetingLineStore`, `scopePickerA11y` to all three with real translations (AC-I4).
  `storeSelector`, `allStores`, `period`, `periodToday`, `greetingLine` are unchanged and
  still used. `src/i18n/i18n.test.ts` parity stays green.

**`e2e/dashboard-window.spec.ts`** (AC-R4 / AC-T3)
- After `dashboard-root` is visible, the spec now clicks `dashboard-scope-picker` and then
  `dashboard-scope-option-${SEED.e2eWindowStoreId}` — the dedicated NON-focal store, which
  under AC-P2 no longer renders by default. Picking that store (rather than "All stores")
  renders exactly one card, which strengthens the existing card-scoped `toHaveCount(0)`
  absence assertions. The frozen selector-contract header comment records the two new
  testIDs. No assertion was weakened or removed.

**`src/screens/cmd/sections/__tests__/DashboardSection.scopePicker.spec159.test.tsx`** (new, AC-T2)
- 7 component cases: default = selected store (AC-P2/S9/S1), "All stores" → N cards +
  aggregated headline that EXCLUDES an out-of-brand store (AC-B9/B1), switch back to a
  single non-focal store, `currentStore` change resets out of `all` (AC-P4), an
  out-of-brand store is neither an option nor a card (AC-V1), a scope narrowed away by a
  brand switch degrades to `all` rather than to an empty dashboard (AC-P5), one visible
  store still renders the picker + aggregate option (AC-P7), and the OQ-1 regression guard
  (phone model is single-store while `inventory` holds three stores).

**Verification**
- `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json --noEmit`, `npx tsc -p e2e/tsconfig.json --noEmit` — all clean.
- FULL `npx jest`: **212 suites / 2383 tests passed** (includes the untouched
  `PhoneDashboard.acReg.test.tsx` — AC-R5 green without editing it, as §12.5 predicted).
- FULL `npx playwright test --project=chromium`: **17/17 passed**, including the repaired
  `dashboard-window.spec.ts` (AC-080-IN path, non-Monday) and `dashboard.spec.ts`.
- Browser (local stack, `admin@local.test`, 4 visible stores, zero console errors):
  default load reads `store: Towson` / hero `Towson · day in progress` / greeting
  `… · Towson` / **1** card / `143 items · 1 store`. Picking the aggregate reads
  `2AM PROJECT · 4 stores · day in progress` (the OQ-2 brand label resolving live) /
  **4** cards / 4 heatmap rows / `572 items · 4 stores` / `EOD 0/4`. Picking the non-focal
  Frederick re-scopes every tile, the heatmap and the card to Frederick while the title bar
  still reads `2P://towson` (AC-P3/AC-R1 — the global switcher is untouched; R-F divergence
  is visible and labeled). Re-checked at the 1000px tablet width and in dark mode: the
  dropdown panel is not clipped and paints over the KPI row.

**Not touched (frontend lane):** `src/lib/db.ts`, `src/lib/cmdSelectors.ts`,
`src/lib/storeVisibility.ts`, `src/store/useStore.ts`, `src/components/cmd/TabStrip.tsx`,
`src/components/cmd/TitleBar.tsx`, `src/screens/cmd/sections/phone/PhoneDashboard.tsx` and
its acReg test, `e2e/dashboard.spec.ts`, `app.json`.

### Fix pass (`test-engineer`, 2026-08-16)

Applied the release-coordinator's 5 must-fix items
(`specs/159-dashboard-scope-picker/reviews/release-proposal.md`) verbatim, in order.
`Status:` unchanged (still `READY_FOR_REVIEW` — this pass is additive test work plus two
small hardening fixes, not a redo; the release-coordinator's proposal called it a coverage
block, not a correctness block).

**1. Extracted + tested the waste reducer.**
- `src/lib/cmdSelectors.ts` — new `sumScopedWaste(entries, scopeIds, nowMs): { dollars,
  events }`, next to the other scoped rollups. Carries all four load-bearing rules the two
  DashboardSection memos used to duplicate: the `scopeIdSet` filter, the 7-day cutoff, the
  R-A `Number.isFinite(Date.parse(...))` guard, and the UNBRIDGED `quantity × costPerUnit`
  multiply (spec 104 R1 — explicitly does NOT apply `× subUnitSize`, unlike the LIVE
  `inventory.costPerUnit` reads elsewhere in the section).
- `src/screens/cmd/sections/DashboardSection.tsx` — `wasteWeek` and `wasteEventCount` now
  both read one `scopedWaste = sumScopedWaste(allWaste, scopeIdSet, Date.now())` memo; the
  duplicated filter predicate (code-reviewer Should-fix) is gone.
- `src/lib/cmdSelectors.scopedRollups.test.ts` — new `sumScopedWaste` describe, 6 cases:
  two-store sum, out-of-window exclusion, out-of-scope exclusion, the R-A unparseable-
  timestamp guard, empty-input zero rollup, and the load-bearing one — a row carrying a
  `subUnitSize` field asserting the sum stays UNBRIDGED. **Proved this assertion bites**:
  temporarily added `× ((w as any).subUnitSize || 1)` to the reducer, confirmed the new
  test failed (`Expected: 40, Received: 240`), then reverted. Before this fix pass, that
  exact regression passed all 2383 jest tests and both e2e projects (architect S-1).

**2. Hero title tests (AC-S10/AC-B10), including the OQ-2 resolver.**
- `DashboardSection.scopePicker.spec159.test.tsx` — new describe with 3 cases asserting
  `dashboard-hero-title`'s exact rendered text: single-store (`"Towson · day in
  progress"`), same-brand aggregate (`"2AM PROJECT · 2 stores · day in progress"` — the
  OQ-2 brand-named resolver, previously verified only by a manual browser pass), and the
  cross-brand fallback (`currentBrandId: null`, visible stores spanning both seeded
  brands → `"All stores (3) · day in progress"`, never a confident brand name). Each case
  also asserts `dashboard-greeting` ends with the matching store name / count (closes
  AC-I2/AC-I3's content gap).

**3. Batched the remaining NOT-TESTED ACs into the existing component suite.**
All landed in `DashboardSection.scopePicker.spec159.test.tsx` — no new file, hook, or
framework:
- AC-S2/AC-B2 — STOCK ALERTS value + `out`/`low` sub-label, scoped.
- AC-S5/AC-B5 — EOD SUBMITTED `x/N` text across single-store, a different single store,
  and all-stores.
- AC-S8/AC-B8 — heatmap row count. Required one additive change to
  `src/components/cmd/Heatmap.tsx`: a stable `testID={`heatmap-row-${rIdx}`}` per data row
  (Heatmap has exactly one consumer, `DashboardSection.tsx` — no other section's rendering
  is affected; AC-R2 holds).
- AC-V2 — asserts the mount-effect fetch calls (`fetchWasteLogForStores`,
  `fetchEodSubmissionsForStores`) with only the two visible-store ids, excluding the
  out-of-brand store — the security-relevant half of AC-V, since it guards the leak this
  spec closed.
- AC-P3 — `jest.spyOn(useStore, 'setState')` around a picker selection; asserts zero calls
  (the picker's `onSelect` is a plain `React.useState` setter).

**4. Repaired the AC-B6 pinning test.**
Preferred option (a) from the proposal — made it real:
- `DashboardSection.scopePicker.spec159.test.tsx` — new describe `AC-B6 (R-B pin)`: seeds
  `currentBrandId: null` (super-admin, "All brands"), `visibleStores` spanning both seeded
  brands, and `recipes` covering only the focal brand's catalog id. Asserts the RENDERED
  CoGS card shows `theoretical: $40` (Towson only — the out-of-brand store's recipe was
  never loaded) while `actual: $110` (both stores' depletion counted in full) — the exact
  shape AC-B6's DOCUMENTED LIMITATION describes, exercised at the call site where the bug
  actually lives. **Proved this test is sensitive to the fix**: temporarily added a second
  recipe covering the out-of-brand store's catalog id plus a matching POS sale, re-ran, and
  the `$40` assertion went red (the test caught the simulated OQ-4 fix); reverted.
- `src/lib/cmdSelectors.scopedRollups.test.ts` — the original pure-function test (renamed
  to `'documents computeScopedCogs with an EMPTY recipes array (not a call-site regression
  guard)'`) keeps its `recipes: []` shape and assertions unchanged, but its comment no
  longer claims it is "pinned so it stays visible" or that its expectation is "expected to
  change" — both were false at the level that test runs (`computeScopedCogs` is brand-
  unaware; the bug lives entirely in what `DashboardSection` passes it). The comment now
  points at the new component test as the real regression guard.

**5. Two one-line hardening fixes.**
- Architect M-3 (`DashboardSection.tsx`, `aggregateLabelFor`): `brandIds` is now
  `Array.from(new Set(list.map((s) => s.brandId ?? null)))` (kept in the set, not
  `.filter(Boolean)`'d out), and the brand-name lookup only fires when
  `brandIds.length === 1 && brandIds[0]`. A scope mixing a brand-less store with a brand-A
  store now correctly falls through to the generic fallback label instead of printing a
  confident brand name over a set that includes a store outside that brand — the sole
  mitigation for the R-B cross-brand CoGS gap.
- Security-auditor Low #2 (`src/lib/db.ts`, `fetchWasteLogForStores`): dropped `notes` and
  `logged_by` from the `select(...)` column list; `notes` and `loggedByUserId` are now
  sparse-filled (`''`) the same way `itemName`/`loggedBy` already are — the only consumer
  sums `quantity × costPerUnit` and never renders either field.
  `src/lib/db.crossStoreLoaders.test.ts` updated to match (fixtures no longer carry
  `logged_by`/`notes`; added a case asserting the select column list omits both).

**Verification (fix pass)**
- `npx tsc --noEmit` and `npm run typecheck:test` — both clean.
- FULL `npx jest`: **212 suites / 2399 tests passed** (2383 + 16 new).
- FULL `npx playwright test --project=chromium`: **17/17 passed** against the live local
  stack, including the repaired `dashboard-window.spec.ts`.

**Accepted limitation (recorded per architect Should-fix S-2 / "should accompany the
merge"):** the `ScopePicker` panel's stacking (`zIndex: 50` wrapper `View`, absolutely-
positioned panel) was verified correct only on **desktop web** (1000px width, light and
dark mode). It was NOT verified on native tablet, and this spec's declared surface (D3) is
"desktop/tablet Cmd surface... web **and** native." On native the panel overflows its
parent `TabStrip` row's bounds by design; Android clips children that overflow a parent's
bounds, and iOS does not deliver touches outside the parent's frame, so the picker may
render clipped (Android) or be unopenable via touch (iOS) on a native tablet build. Not
fixed in this pass — if it fails on a real device, the remedy is a design change (portal /
`Modal`-hosted panel), not a style tweak. The architect additionally notes a backdrop
`Pressable` would fix this AND M-5 (no outside-press dismissal) together, as a follow-up.
Neither is built here — noted, not silently shipped.

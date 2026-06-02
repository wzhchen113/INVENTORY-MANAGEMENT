# Spec 087: Reorder calendar — "what to order today" with go-back-in-time

Status: READY_FOR_REVIEW

## User story
As a store manager (or super_admin) using the admin **Reorder** section
(`src/screens/cmd/sections/ReorderSection.tsx`, sidebar "Reorder" under
PLANNING), I want a calendar that defaults to **today** and shows only the
vendors I am supposed to **order from today**, and lets me **pick a past date**
to go back and review what the reorder list looked like on that day — so the
screen answers "what do I need to place right now?" instead of dumping every
vendor with a suggestion regardless of whether today is their order day.

## Context the architect should not re-derive (verified in code)

- The reorder data already comes from the `report_reorder_list(p_store_id,
  p_params)` RPC
  ([supabase/migrations/20260514130000_report_reorder_list.sql](../../supabase/migrations/20260514130000_report_reorder_list.sql)).
  It already accepts **`as_of_date`** inside `p_params` (defaults to
  `current_date`; resolved to `v_as_of_date` at line 128) and is **historically
  accurate**: on-hand is EOD-first, pulling `eod_submissions WHERE date =
  v_as_of_date` → that submission's `eod_entries.actual_remaining`, falling back
  to `inventory_items.current_stock` only when no EOD exists for that date
  (CTE `item_on_hand`, lines 253-289). `next_delivery_date`,
  `days_until_next_delivery`, and `v_today_dow_num` (line 132) are all computed
  relative to `as_of_date`. **"Go back" already returns the real historical
  reorder for a past date with no backend change.**
- The FE already threads the date end-to-end but never sends it:
  `fetchReorderSuggestions(storeId, asOfDate?)`
  ([src/lib/db.ts:2706](../../src/lib/db.ts)) puts `as_of_date` into `p_params`;
  `loadReorderSuggestions(asOfDate?)`
  ([src/store/useStore.ts:2364](../../src/store/useStore.ts)) accepts the arg.
  But `ReorderSection`'s mount `useEffect` and `refresh` call
  `loadReorderSuggestions()` with **no argument**
  ([ReorderSection.tsx:576-592](../../src/screens/cmd/sections/ReorderSection.tsx)),
  so the RPC always uses server `current_date`. Wiring a date through this
  existing parameter is the core FE change.
- **The filter gap.** The vendor-row JSON (migration lines 519-533) exposes
  `vendor_id, vendor_name, schedule_known, next_delivery_date,
  days_until_next_delivery, on_hand_source, eod_submitted_at, items,
  vendor_total_cost` — and the matching `ReorderVendor` type
  ([src/types/index.ts:722-732](../../src/types/index.ts)) — but **NOT the
  vendor's order-out weekday** (`order_schedule.day_of_week`). "next delivery"
  is the *delivery* side (truck arrival, `delivery_day`); the user's filter is
  the *order-out* side (`day_of_week`). See open question (A).
- **`order_schedule` schema** (declared in
  [supabase/migrations/20260424211732_recover_undeclared_tables.sql:86](../../supabase/migrations/20260424211732_recover_undeclared_tables.sql)):
  `day_of_week text NOT NULL` (when the order goes OUT), `delivery_day text`
  (nullable; when the truck arrives). The report's next-delivery math uses
  `lower(delivery_day)` against full lowercase day names. `day_of_week` is
  stored as **capitalized** canonical English day names (`'Monday'` …
  `'Sunday'`) — confirmed by `OrderScheduleSection` `DAY_NAMES`
  ([src/screens/cmd/sections/OrderScheduleSection.tsx:12](../../src/screens/cmd/sections/OrderScheduleSection.tsx))
  and the db.ts mapping that keys the slice by `row.day_of_week`
  ([src/lib/db.ts:3506](../../src/lib/db.ts)). Any weekday comparison must
  normalize case.
- **An existing client-side source for both the filter and the active-days
  highlight may already exist.** The `orderSchedule` Zustand slice
  ([src/store/useStore.ts:514](../../src/store/useStore.ts), type
  `OrderSchedule`) is keyed by `day_of_week` (`{ Monday: [...], … Sunday:
  [...] }`), loaded **per focal store** by `loadFromSupabase`, each day holding
  `{ vendorId, vendorName, deliveryDay }[]`. So "vendors whose order-out day is
  D" = `orderSchedule[D].map(v => v.vendorId)`, and "active order-out days" =
  the day keys whose array is non-empty — both already in the store with no new
  read. See open questions (A) and (B): the architect decides whether to derive
  client-side from this slice or add a server field/param for robustness.
- **No `__all__` store mode in the admin shell.** `setCurrentStore` redirects
  any `__all__` to a real focal store
  ([src/store/useStore.ts:608-626](../../src/store/useStore.ts)); the "All
  brands" super_admin context sets `currentStore` to an **empty-id placeholder**
  (`{ id: '', … }`, line 640-643). So `currentStore.id` is either a real store
  id or `''`. The reorder RPC is `p_store_id`-scoped and cannot run without a
  focal store. See open question (E).
- **Existing calendar components don't fit as-is.**
  [src/components/DatePicker.tsx](../../src/components/DatePicker.tsx) is a full
  month-grid calendar with a today highlight and a Today/Clear footer, but it
  (1) uses `useColors()` (Light/Dark theme), not the Cmd palette
  `useCmdColors()` that `ReorderSection` uses, and (2) has **no** future-disable,
  past-only, or active-day-highlight support.
  [src/components/DateScopeBar.tsx](../../src/components/DateScopeBar.tsx) wraps
  it for single/range scoping (also `useColors()`). See open question (C).
- KPI cards and CSV/PDF export already read off `reorderPayload`
  ([ReorderSection.tsx:526-545, 681-707](../../src/screens/cmd/sections/ReorderSection.tsx))
  and the report's KPIs are already post-vendor-filter (CTE `kpi_calc`, lines
  538-545). Export filenames already stamp `payload.asOfDate`. See open question
  (D).

## Acceptance criteria

- [ ] On opening Reorder with a focal store selected, a calendar control is
      visible in the section, the selected date defaults to **the store-local
      "today"** (the same ISO `YYYY-MM-DD` the FE passes as `as_of_date`), and
      the vendor list shows **only vendors whose order-out day
      (`order_schedule.day_of_week`) matches today's weekday** — not all vendors
      with a suggestion, not delivery-day vendors.
- [ ] Selecting a **past date** on the calendar re-fetches `report_reorder_list`
      with that date as `as_of_date` (via the existing
      `loadReorderSuggestions(asOfDate)` → `fetchReorderSuggestions(storeId,
      asOfDate)` path) and then filters the returned vendors to those whose
      order-out day matches **the selected date's** weekday. On-hand reflects
      that date's EOD (historical) per the existing RPC behavior.
- [ ] **Future dates are disabled** in the calendar — not selectable, visually
      de-emphasized. Today is the latest selectable date.
- [ ] The calendar **highlights active days**: dates whose weekday matches some
      vendor's order-out day for the current focal store are visually marked, so
      the user sees at a glance which days have order-out activity. (Highlight is
      a weekday-recurring mark across the visible month, not a per-calendar-date
      event lookup.)
- [ ] Weekday comparison is **case-insensitive** and uses canonical English day
      names, matching the stored `day_of_week` capitalization (`Monday` …
      `Sunday`).
- [ ] When the selected date's weekday matches **no** vendor's order-out day,
      the section shows a clear empty state distinct from the existing
      "NO REORDER SUGGESTIONS" copy — e.g. "No vendors are ordered on
      &lt;weekday&gt;." — so the user understands the list is empty *because of
      the day filter*, not because of missing EOD or all-at-par.
- [ ] Changing the date does not leave stale KPI cards: the KPI strip and any
      "as of" label reflect the currently filtered/as-of view (see open question
      (D) for whether KPIs recompute client-side post-filter or stay as the
      server's post-suggestion-filter numbers — the architect pins this; the
      criterion is "no visibly stale numbers after a date change").
- [ ] CSV/PDF export reflects the currently displayed (filtered + as-of) view:
      the exported rows match the on-screen vendor cards and the filename's date
      stamp matches the selected date.
- [ ] Vendors with **no `order_schedule` row** (the report's A5 7-day fallback,
      `schedule_known=false`) are handled per the architect's decision in (A)
      and do not silently vanish without explanation (they have no known
      order-out day, so they cannot satisfy "I order today" — but the user must
      still be able to discover them; the architect specifies where, e.g. a
      secondary "no schedule" group or a toggle).
- [ ] When there is **no focal store** (`currentStore.id === ''`, the "All
      brands" placeholder), the section renders a select-a-store empty state
      rather than calling the RPC with an empty id (resolve per open question
      (E)).
- [ ] Tests land per the Conventions section below (jest for the
      filter/active-day/future-disable logic; pgTAP only if a backend
      field/param/RPC is added).

## In scope

- A calendar control in `ReorderSection` styled for the Cmd shell: default =
  store-local today, past + today selectable, **future disabled**, active
  order-out days highlighted.
- Re-fetch on date change through the **existing** `loadReorderSuggestions
  (asOfDate)` / `fetchReorderSuggestions(storeId, asOfDate)` path (no new FE
  data function unless the architect adds a backend read for (A)/(B)).
- The **default + selectable filter**: show only vendors whose order-out day
  (`order_schedule.day_of_week`) matches the selected date's weekday.
- The minimal backend addition, if any, that open questions (A) and (B)
  require — at the architect's discretion (see "Out of scope" for the
  no-change-by-default posture).
- An empty state for "no vendors ordered on this weekday" distinct from the
  existing no-suggestions empty state.
- Tests per Conventions.

## Out of scope (explicitly)

- **Forward / future planning.** Future dates are explicitly disabled. This is
  "go back and check," not "plan ahead." (Per user decision 2.)
- **Changing the reorder math.** `suggested_qty`, the EOD-first on-hand
  resolution, the next-delivery computation, the depth cap, the
  `pending_po_qty=0` v1 stub — all unchanged. We are adding a *date control* and
  an *order-out-day filter*, not touching the formula.
- **Delivery-day filtering or a delivery calendar.** The user asked for
  order-out ("what to place today"), explicitly not delivery day. The existing
  per-vendor "next delivery" header stays as-is.
- **A date *range* / window.** Single-date selection only; no `DateScopeBar`
  range mode. (Rationale: the request is "pick a day to go back to," not a
  window report — the reports trilogy already owns range reporting.)
- **Persisting the selected date** across sessions/store-switches. Resets to
  today on mount and on store switch (the existing store-switch clears
  `reorderPayload`). A remembered-date affordance is a follow-up if asked.
- **The staff app** (`src/screens/staff/`) and **other report sections.**
- **`app.json` slug.** Untouched.
- **Defaulting to a non-trivial backend change.** Unless the architect's (A)/(B)
  analysis concludes a server field/param is materially better, the preferred
  path is FE-only (derive filter + active days from the existing `orderSchedule`
  slice; the historical as-of fetch already works). A migration is *permitted*
  if the architect justifies it, but is not assumed.

## Open questions resolved

- Q: Default filter — delivery day, order-out day, or all vendors?
  → A: **Order-out day** (`order_schedule.day_of_week` matches the selected
  date's weekday). The actionable "what to place today" list. (User decision 1.)
- Q: Date range — past+future, or past+today only?
  → A: **Past + today only; future disabled.** (User decision 2.)
- Q: Should the calendar mark which days matter?
  → A: **Yes** — highlight dates whose weekday matches some vendor's order-out
  day. (User decision 3.)
- Q: Does "go back" need a backend change to be historically accurate?
  → A: **No.** `report_reorder_list` already takes `as_of_date` and resolves
  on-hand EOD-first relative to it (verified, migration lines 128-289). The
  historical accuracy is already correct; only the FE wiring + filter are new.
- Q: Is there a `__all__`/all-stores reorder mode to design around?
  → A: **No.** The admin shell has no `__all__` store mode; `currentStore.id`
  is a real store or `''`. The date filter is per-focal-store. (See (E) for the
  `''` case.)

## Open questions for the architect

These are architect-decidable; none blocks spec readiness.

- **(A) Order-out-day filter mechanism.** Pick one and pin it:
  - **(A1) FE-only intersection** — derive "vendors I order on weekday D" from
    the existing `orderSchedule` slice (`orderSchedule[D].map(v => v.vendorId)`,
    keyed by capitalized `day_of_week`) and intersect with
    `reorderPayload.vendors[].vendorId`. No migration. Caveat: the slice is the
    *full* planned vendor list; the report only returns vendors *with
    suggestions* for the as-of date — the intersection is the right set, but the
    architect should confirm the slice is loaded for the focal store at the time
    the section renders (it is loaded by `loadFromSupabase` on store switch).
  - **(A2) Additive payload field** — add `order_out_days` (array) or an
    `orders_on_as_of_date` boolean to the vendor JSON in `report_reorder_list`
    (migration + pgTAP + `mapReorderVendor` + `ReorderVendor` type). More
    self-contained payload; costs a migration.
  - **(A3) Server-side filter param** — a `p_params` flag that filters vendors
    server-side to the as-of weekday. Smallest payload, least FE logic; costs a
    migration and reduces FE flexibility (can't toggle the filter without a
    re-fetch).
  - Also decide how **`schedule_known=false`** (no `order_schedule` row, A5
    7-day fallback) vendors appear under the filter — they have no order-out
    day, so they fail "I order today"; specify where they surface (secondary
    group, toggle, or warning) so they don't silently disappear.
- **(B) Active-days highlight source.** Pin the exact source for the set of
  order-out weekdays used to highlight the calendar:
  - **(B1)** Derive from the existing `orderSchedule` slice (day keys with
    non-empty arrays) — no new read. Likely sufficient and consistent with
    (A1).
  - **(B2)** A new lightweight read (distinct `order_schedule.day_of_week` for
    the focal store's vendors) if the architect wants this decoupled from the
    slice's load lifecycle. Note the slice is *per focal store*, which matches
    the highlight's scope.
- **(C) Calendar component for the Cmd shell.** Specify the approach:
  - Reuse/adapt [src/components/DatePicker.tsx](../../src/components/DatePicker.tsx)
    (already a month grid with a today highlight + footer) but it needs (i) a
    Cmd-palette variant (`useCmdColors()` vs its current `useColors()`),
    (ii) a `maxDate`/future-disable prop, and (iii) an `activeDays`/weekday-mark
    prop; OR
  - Build a small Cmd-native calendar in `ReorderSection`/a new
    `src/components/cmd/` component. The architect picks reuse-with-props vs.
    new component and names the file(s). Web + native both render in the Cmd
    shell (react-native-web), so the control must work cross-platform (the
    existing `DatePicker` uses RN `Modal` + `TouchableOpacity`, which is
    cross-platform).
- **(D) KPIs + export under the filter.** Confirm the interaction: the report's
  KPIs are already post-suggestion-filter (server CTE `kpi_calc`). If the
  order-out filter is applied **client-side** (A1/A2), the KPI cards
  (`kpis.vendorCount` etc.) will over-count relative to the filtered vendor
  list. Decide whether the KPI strip recomputes from the *filtered* vendor array
  client-side, or whether the filter is server-side (A3) so KPIs stay
  authoritative. The acceptance criterion is "no visibly stale numbers"; the
  architect pins the mechanism. Same question for CSV/PDF: `buildReorderCsv` /
  `handlePdfExport` iterate `payload.vendors` — they must iterate the *filtered*
  set, and the PDF footer `payload.kpis.itemCount`/`totalEstimatedCost` must
  match.
- **(E) No-focal-store behavior.** When `currentStore.id === ''` ("All brands"
  placeholder), confirm the section renders a select-a-store empty state (the
  established pattern — `OrderScheduleSection` and `EODCountSection` guard
  `!currentStore?.id || currentStore.id === '__all__'`) rather than calling the
  RPC with an empty store id. The existing mount effect already early-returns on
  `!currentStore?.id`, so this is mostly confirming/strengthening the guard and
  the empty-state copy. Flagged because the request's screenshot showed "BRAND
  ALL BRANDS"; if the user actually wants a cross-store reorder rollup for the
  all-brands view, that is a **separate, larger spec** (the RPC is single-store)
  — out of scope here unless the user says otherwise.

## Dependencies

- `report_reorder_list` RPC
  ([supabase/migrations/20260514130000_report_reorder_list.sql](../../supabase/migrations/20260514130000_report_reorder_list.sql))
  — already takes `as_of_date`; only modified if the architect picks (A2)/(A3).
- `fetchReorderSuggestions` / `loadReorderSuggestions` — already accept
  `asOfDate`; the FE change wires the calendar's value through them.
- `orderSchedule` Zustand slice + `OrderSchedule` type
  ([src/store/useStore.ts:514](../../src/store/useStore.ts),
  [src/types/index.ts](../../src/types/index.ts)) — candidate source for filter +
  active days (A1/B1).
- Existing date components
  ([src/components/DatePicker.tsx](../../src/components/DatePicker.tsx),
  [src/components/DateScopeBar.tsx](../../src/components/DateScopeBar.tsx)) and
  date helpers
  ([src/utils/reportDates.ts](../../src/utils/reportDates.ts) — `toISODate`,
  `isISODate`) for reuse (C).
- `ReorderVendor` / `ReorderPayload` / `OnHandSource` types
  ([src/types/index.ts:701-746](../../src/types/index.ts)) and `mapReorderVendor`
  ([src/lib/db.ts:2750](../../src/lib/db.ts)) — touched only if (A2) adds a
  payload field.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI —
  `src/screens/cmd/sections/ReorderSection.tsx`. No legacy surface.
- **Per-store or admin-global:** **Per-store.** The RPC is `p_store_id`-scoped
  and gated by `auth_can_see_store()`; the calendar/filter operate on the focal
  store. No change to RLS posture.
- **Edge function or PostgREST:** **PostgREST RPC** (`report_reorder_list`,
  `security invoker`). No edge function. If (A2)/(A3) adds a field/param it stays
  in this same RPC; the grant model (`revoke from public, anon; grant to
  authenticated`) is unchanged — no new grant unless the architect adds one.
- **Realtime channels touched:** **None.** Reorder is lazy-loaded per section
  and not part of the `useRealtimeSync` reload set; this spec does not add a
  realtime dependency. (If a future spec wants live reorder updates that is its
  own design with the realtime-publication gotcha as a risk.)
- **Migrations needed:** **Only if** the architect picks (A2) or (A3). Default
  posture is **no migration** (FE-only via the existing `as_of_date` param +
  `orderSchedule` slice). If a migration lands, the
  `db-migrations-applied` gate applies (user runs `npx supabase db push
  --linked` post-merge) and pgTAP coverage is required.
- **Edge functions touched:** None.
- **Web/native scope:** **Both** (the Cmd shell renders on web via Vercel and
  native via EAS). The calendar must be cross-platform RN. CSV/PDF export
  remains web-only as it is today (`Platform.OS === 'web'` guard at
  [ReorderSection.tsx:597](../../src/screens/cmd/sections/ReorderSection.tsx));
  the date filter applies on both, export only on web.
- **Tests (per spec 022 tracks):**
  - **jest (required):** the order-out-day filter (case-insensitive weekday
    match, intersection with the suggestion list, `schedule_known=false`
    handling), the active-days derivation, the future-disable / past-only
    selectable logic, and the date→`as_of_date` wiring. If KPIs recompute
    client-side (D), test that too.
  - **pgTAP (only if A2/A3):** assert the new field/param shape AND that the
    existing `as_of_date` historical behavior (EOD-first on-hand for a past
    date) is preserved. Use `has_function_privilege` for grant assertions ONLY
    if a grant is touched; **no `set role anon`**.
  - **shell smokes:** not required for this feature.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. Decide open questions (A)-(E) —
  especially the order-out-day filter mechanism (FE-only intersection from the
  existing `orderSchedule` slice vs. an additive payload field vs. a server
  filter param) and the calendar component approach (adapt DatePicker with
  Cmd-palette + maxDate + activeDays props vs. a new Cmd-native component). Pin
  the active-days source, the KPI/export-under-filter behavior, and the
  no-focal-store empty state. Default to the FE-only path unless a backend change
  is materially justified; if a migration lands, note the `db-migrations-applied`
  gate and required pgTAP. Then produce the design doc and set
  Status: READY_FOR_BUILD.
payload_paths:
  - specs/087/spec.md

---

## Backend design (architect)

### Verdict: FRONTEND-ONLY. No backend change.

I confirmed all five open questions resolve client-side against state the
store already holds. **No migration, no RLS change, no edge function, no
realtime change, no `db.ts` data-function change, no pgTAP.** The
`report_reorder_list` RPC, `fetchReorderSuggestions`, and
`loadReorderSuggestions` are touched only in that the FE now *passes the date
it already accepts*. The entire deliverable lives in
`src/screens/cmd/sections/ReorderSection.tsx`, one new Cmd-native calendar
component, one pure filter/active-days util, the i18n catalogs, and jest.

This is a `frontend-developer`-only build. **`backend-developer` is not
needed** — see Handoff.

#### Why FE-only is correct (not just convenient)

The two facts that close the door on a migration:

1. **Historical accuracy already works.** `report_reorder_list` resolves
   `as_of_date` from `p_params` (defaults `current_date`), and on-hand is
   EOD-first relative to that date (verified by the PM at migration lines
   128-289). "Go back" returns the real historical list with zero backend
   work — the FE just stopped passing the date.
2. **The order-out-day axis is already in the store, per focal store.** The
   `orderSchedule` slice (`src/store/useStore.ts:514`, hydrated by
   `loadFromSupabase` at `src/store/useStore.ts:1028-1031` from
   `db.fetchOrderSchedule` → `src/lib/db.ts:3496`) is a weekday-keyed
   `Record<DayName, { vendorId, vendorName, deliveryDay }[]>` scoped to the
   current focal store. That is exactly — and only — the data the filter and
   the active-days highlight need. Adding `order_out_days` to the report
   payload (A2) or a server filter param (A3) would duplicate data the client
   already has and cost a migration + pgTAP + drift-gate for zero capability
   gain. Rejected.

---

### Data model changes

**None.** No new tables, columns, or indexes. No proposed migration filename.
No `db-migrations-applied.yml` impact. No `supabase_realtime` publication
change (so the realtime-restart gotcha does not apply).

### RLS impact

**None.** No new table; no policy added or modified. The existing
`report_reorder_list` (`security invoker`, gated by `auth_can_see_store()`)
and the `order_schedule` SELECT policy (`auth_can_see_store` per
`order_schedule_super_admin_rls.sql`) already scope both reads to the focal
store. The client-side filter operates on rows RLS already admitted — it
cannot widen visibility.

### API contract

**Unchanged.** Still the existing PostgREST RPC `report_reorder_list(p_store_id
uuid, p_params jsonb)`. The only behavioral change is that the FE now populates
`p_params.as_of_date` with the calendar's selected date (it already does this
when `asOfDate` is passed — `src/lib/db.ts:2711`). Request/response/error
shapes are identical. No RPC signature change.

### Edge function changes

**None.** No `verify_jwt` decision to make.

### `src/lib/db.ts` surface

**No new helper. No signature change.** `fetchReorderSuggestions(storeId,
asOfDate?)` (`src/lib/db.ts:2706`) already threads `as_of_date`. The
order-out-day data source (`fetchOrderSchedule`, `src/lib/db.ts:3496`) is
already wired into `loadFromSupabase`. No new snake_case→camelCase mapping.

The filter and active-days logic is **pure** and must NOT live in `db.ts`
(it's not DB access). Put it in a new util — see "New files" below.

### Realtime impact

**None.** Reorder is lazy-loaded per section and is not in the
`useRealtimeSync` reload set (confirmed: the spec's project notes and
`ReorderSection`'s own mount-effect). This spec adds no realtime dependency
and no publication membership change. The
`docker restart supabase_realtime_imr-inventory` step is **not** required for
this spec.

### Frontend store impact

The `orderSchedule` slice and the reorder slice (`reorderPayload`,
`reorderLoading`, `reorderError`, `loadReorderSuggestions`) are consumed
**as-is**. **No new store state, no new action, no signature change.** The
optimistic-then-revert + `notifyBackendError` pattern does **not** apply —
this is a pure read; the existing in-section error pane (fed by
`reorderError`) is the error surface, unchanged.

One behavioral note the developer must preserve: `loadFromSupabase` already
clears `reorderPayload` on store switch (`src/store/useStore.ts:1032-1038`)
and re-hydrates `orderSchedule` for the new store in the same `set()`. So
when the focal store changes, the section must **reset its selected date to
today** (local state, see below) so it doesn't re-fetch the new store as-of a
date the user picked for the old store. This matches the "resets to today on
store switch" out-of-scope decision.

---

### Open questions — decisions

#### (A) Order-out-day filter mechanism → **A1 (FE-only intersection). Confirmed no migration.**

- **Source:** `orderSchedule[DayName].map(v => v.vendorId)` where `DayName` is
  the canonical capitalized weekday of the **selected date**
  (`['Sunday','Monday',...,'Saturday'][selectedDate.getDay()]`). This is the
  set "vendors I order out on that weekday."
- **Filter:** keep a returned vendor `v` iff its `v.vendorId` is in that set.
  Intersection of (vendors the report returned, i.e. has-a-suggestion) with
  (vendors scheduled to order out on the selected weekday). This is the
  correct set per the PM's analysis.
- **Slice availability — confirmed.** `loadFromSupabase(storeId)` populates
  `orderSchedule` for the focal store and runs on every store switch
  (`setCurrentStore` → `loadFromSupabase`) and on login. By the time
  `ReorderSection` mounts there is a focal store and `loadFromSupabase` has
  fired for it, so the slice is the focal store's schedule. **No extra load
  call is needed in `ReorderSection`.** Defensive note for the developer: if
  the slice is the 7-empty-days baseline (store genuinely has no
  `order_schedule` rows yet), the filter yields zero vendors and the section
  shows the day-filter empty state (see below) — that is correct, not a bug.
- **Case-normalization:** the slice keys are already capitalized canonical
  English (`Monday`…`Sunday`), matching `DayName` from
  `src/utils/enumLabels.ts:23`. Derive the selected weekday as a `DayName`
  via a fixed index array (NOT `toLocaleString`, which is locale-dependent).
  No `.toLowerCase()` dance is needed because both sides are canonical
  capitalized; the acceptance criterion's "case-insensitive" requirement is
  satisfied by comparing canonical-to-canonical. The util should still
  normalize defensively (compare on a canonical lookup) so a future
  lowercase-keyed source can't silently mismatch.
- **`schedule_known=false` vendors (A5 7-day fallback, no `order_schedule`
  row):** these have **no order-out weekday**, so they can never satisfy "I
  order today." Per AC ("do not silently vanish without explanation"), render
  them in a **secondary, collapsed-by-default group** below the filtered
  primary list, titled e.g. "No order schedule — not tied to a weekday"
  (i18n key, see catalog work). Detection: a returned vendor whose
  `vendorId` is **not present in ANY** `orderSchedule[day]` array (equivalent
  to the report's `scheduleKnown === false`; prefer keying off
  `vendor.scheduleKnown` from the payload since it's authoritative and already
  mapped at `src/lib/db.ts:2771`). This group is independent of the selected
  weekday (these vendors have no weekday) and is always shown when such
  vendors exist in the as-of payload. A vendor that HAS a schedule but not on
  the selected weekday simply doesn't show that day — it is not "no schedule",
  so it does not go in this group.

  Rationale for a secondary group over a toggle: it's discoverable without an
  interaction, matches the existing "warnings" panel idiom already in
  `ReorderSection` (lines 709-731), and keeps the primary list strictly "what
  to place today."

#### (B) Active-days highlight source → **B1 (derive from the `orderSchedule` slice).**

- **Active weekday set** = the `orderSchedule` day-keys whose array is
  non-empty: `DAY_NAMES.filter(d => (orderSchedule[d]?.length ?? 0) > 0)`.
  This is the set of weekdays the focal store orders out on, decoupled from
  the as-of payload (the highlight shows the *recurring* pattern, not "days
  with a suggestion right now" — matches the AC: "weekday-recurring mark, not
  a per-calendar-date event lookup").
- **Calendar mapping:** a visible calendar cell for date `D` is highlighted
  iff `activeWeekdays.has(weekdayOf(D))` AND `D` is selectable (i.e. `D <=
  today` — future cells are disabled and not highlighted). The highlight is
  purely a function of the cell's weekday, so every past Monday is marked if
  Monday is active, etc.
- B2 (a new distinct read) is rejected: the slice is already per-focal-store,
  already loaded, and already the exact scope the highlight needs.

#### (C) Calendar component → **Build a small Cmd-native component. Do NOT adapt `DatePicker.tsx`.**

Reasons to build new rather than retrofit `src/components/DatePicker.tsx`:
- `DatePicker` is `useColors()` (Light/Dark) and is consumed by the reports
  surface; bolting `useCmdColors()` + `maxDate` + `activeDays` onto it risks
  regressing existing report callers and mixes two theme systems in one
  component.
- The Cmd shell already owns a family of `useCmdColors()` modal components in
  `src/components/cmd/` (e.g. `AddVendorScheduleModal.tsx`,
  `RecipePickerModal.tsx`) — a Cmd-native calendar is the consistent choice
  and the reuse target for any future Cmd date control.
- It is small (a month grid + prev/next + footer), and the new behaviors
  (future-disable, active-day marks) are easier to get right in a purpose-built
  component than as conditional props on a shared one.

**New file:** `src/components/cmd/ReorderDatePicker.tsx` (Cmd-native; mirrors
the structure of `DatePicker.tsx` — RN `Modal` + `TouchableOpacity`, fully
cross-platform for web+native — but themed via `useCmdColors()`).

**Component contract (props):**

```ts
interface ReorderDatePickerProps {
  value: string;                 // selected date, 'YYYY-MM-DD' (never '')
  onChange: (isoDate: string) => void;
  maxDate: string;               // 'YYYY-MM-DD' — latest selectable (today).
                                 //   Cells > maxDate are disabled + de-emphasized.
  activeWeekdays: ReadonlySet<DayName>;  // weekdays to highlight (B1 set)
  testIdPrefix?: string;         // default 'reorder-datepicker'
}
```

Behavioral spec:
- **Default/selected:** `value` defaults to store-local today
  (`toISODate(new Date())` from `src/utils/reportDates.ts`). `value` is never
  empty — there is **no Clear** affordance (unlike `DatePicker`); a date is
  always selected. Footer has a single **"Today"** action that jumps to and
  selects `maxDate`.
- **Future-disable:** any cell whose ISO date `> maxDate` renders
  de-emphasized (`C.fg3`, reduced opacity) and is non-pressable (`disabled`
  on the `TouchableOpacity`, and the press handler no-ops defensively). The
  next-month chevron may still navigate into future months (so the user can
  see the calendar continues), but no future cell is selectable. Acceptable
  alternative: cap forward navigation at the month containing `maxDate` — the
  developer picks; the AC only requires future *dates* be non-selectable and
  de-emphasized.
- **Active-day highlight:** a selectable cell whose weekday is in
  `activeWeekdays` gets a marker — use a small dot or an accent underline in
  `C.accent` (the green accent already used for the EOD source badge), kept
  visually distinct from the **today** ring and the **selected** fill so the
  three states (today / selected / active-day) don't collide. Suggested
  precedence when a cell is multiple things: selected fill wins the
  background; today keeps its ring; the active-day dot renders regardless
  (it's a separate glyph), so an active + selected + today cell shows fill +
  ring + dot. The developer tunes exact styling against the Cmd palette;
  the contract is "three distinguishable states."
- **Theming:** `useCmdColors()` exclusively. Use `C.panel`/`C.bg` surfaces,
  `C.border`/`C.borderStrong` strokes, `C.fg`/`C.fg2`/`C.fg3` text,
  `C.accent`/`C.accentBg` for the active/selected affordances — matching the
  rest of `ReorderSection`.
- **Trigger:** the closed-state control is a Cmd-styled button showing the
  selected date (reuse the `mono()` + bordered-pill look of the existing
  CSV/PDF/REFRESH buttons at `ReorderSection.tsx:626-676`). It opens the
  modal grid.
- **TestIDs:** expose `${prefix}-trigger`, `${prefix}-prev-month`,
  `${prefix}-next-month`, `${prefix}-day-<n>`, `${prefix}-today` (same scheme
  as `DatePicker`) so jest can drive it.

**Where it mounts in `ReorderSection`:** in the `TabStrip` `rightSlot`
(`ReorderSection.tsx:622-678`), to the **left** of the CSV/PDF/REFRESH
buttons, so the header reads `[date-picker] [CSV] [PDF] [REFRESH]`. The "as
of <date>" line in the hero (`ReorderSection.tsx:690-694`) stays and now
reflects the selected date (it already reads `reorderPayload.asOfDate`, which
the RPC echoes back from the date we send — so it updates for free).

#### (D) KPIs + export under the filter → **Recompute client-side from the filtered primary set. On-screen list, KPIs, and export must all agree.**

The order-out filter is client-side (A1), so the server's KPIs
(post-suggestion-filter, but pre-order-out-filter) will over-count. Per the
user's expectation that the on-screen list and the KPIs/export agree:

- **KPI strip** (`ReorderSection.tsx:698-707`): recompute from the **filtered
  primary vendor array** (the vendors shown in the main "order today" list),
  NOT `reorderPayload.kpis`:
  - `vendorCount` = filtered vendors length
  - `itemCount` = sum of `v.items.length` over filtered vendors
  - `totalEstimatedCost` = sum of `v.vendorTotalCost` over filtered vendors
  - `eodSourcedVendorCount` / `stockFallbackVendorCount` = count filtered
    vendors by `onHandSource === 'eod' | 'stock'`
  Put this in the pure util (testable) and feed the existing `StatCard`s.
  **Decision: KPIs count the PRIMARY (order-today) list only**, excluding the
  secondary "no schedule" group — the strip is labeled "suggesting today",
  so it must reflect today's order-out set. (If the developer finds the
  "no-schedule" exclusion confusing in practice, surface it; default is
  exclude.)
- **CSV** (`buildReorderCsv`, `ReorderSection.tsx:396-428`) and **PDF**
  (`handlePdfExport`, lines 456-559): both iterate `payload.vendors`. Change
  the call sites to pass the **filtered set** (primary order-today vendors).
  Decision: **export = the primary on-screen list** (what the user is about
  to place), so the exported rows match the cards and the PDF footer totals
  match the recomputed KPIs. The simplest mechanism: build a derived
  `ReorderPayload`-shaped object `{ ...payload, vendors: filteredVendors,
  kpis: recomputedKpis }` and pass THAT to `handleCsvExport`/`handlePdfExport`
  — they already read `payload.kpis.itemCount` / `totalEstimatedCost` for the
  PDF footer (lines 526-527), so a recomputed `kpis` keeps the footer
  consistent with no change to the export functions themselves. The filename
  date-stamp already uses `payload.asOfDate` (line 433/464), which is the
  selected date — correct as-is.
- **`showExport` guard** (`ReorderSection.tsx:597-602`): change the
  `reorderPayload.vendors.length > 0` check to gate on the **filtered**
  primary length, so the export buttons hide when the day-filtered list is
  empty (nothing meaningful to export). Keep the `Platform.OS === 'web'` and
  error/loading conditions unchanged.

#### (E) No-focal-store (all-brands) empty state → **Guard like `OrderScheduleSection` / `EODCountSection`. Render select-a-store; do not call the RPC.**

`currentStore.id` is `''` in the "All brands" placeholder
(`src/store/useStore.ts:641`). Mirror the established guard
(`OrderScheduleSection.tsx:56-63`): **after all hooks**, if
`!currentStore?.id || currentStore.id === '__all__'`, return a centered
select-a-store empty state. Reuse the existing copy pattern — add a reorder
sibling of `section.orderSchedule.selectStore`, e.g.
`section.reorder.selectStore` = "Select a store to view the reorder list."
The existing mount-effect already early-returns on `!currentStore?.id`
(`ReorderSection.tsx:577`); this just makes the empty state explicit and
strengthens the guard. A cross-store all-brands reorder rollup remains a
separate, larger spec (the RPC is single-store) — out of scope, as the spec
states.

---

### Exact `ReorderSection` wiring (for the developer)

1. **Selected-date state:** `const [selectedDate, setSelectedDate] =
   React.useState<string>(() => toISODate(new Date()));` (import `toISODate`
   from `src/utils/reportDates.ts`). `maxDate` = `toISODate(new Date())`
   computed once per render (or memoized for the day).
2. **Mount + date-change fetch:** change the mount effect
   (`ReorderSection.tsx:576-579`) and `refresh` (lines 590-592) to call
   `loadReorderSuggestions(selectedDate)`. Add `selectedDate` to the effect's
   dependency array so picking a date re-fetches. Keep the `if
   (!currentStore?.id) return;` guard.
3. **Store-switch reset:** add an effect keyed on `currentStore.id` that
   resets `setSelectedDate(toISODate(new Date()))` when the store changes
   (so a date picked for store A doesn't carry into store B). Order this so
   the reset runs before/with the fetch; simplest is one effect on
   `[currentStore.id]` that sets the date to today, and the fetch effect on
   `[currentStore.id, selectedDate, ...]` then fires with today. The
   developer ensures no double-fetch race (acceptable: a single redundant
   fetch on switch is harmless; a stale as-of fetch is not).
4. **Derive filter + groups (pure util, see New files):**
   - `activeWeekdays = activeWeekdaysFromSchedule(orderSchedule)`
   - `selectedWeekday = weekdayName(selectedDate)` → `DayName`
   - `{ primary, noSchedule } = partitionReorderVendors(payload.vendors,
     orderSchedule, selectedWeekday)` where `primary` = vendors scheduled on
     `selectedWeekday`, `noSchedule` = vendors with `scheduleKnown === false`.
     (A vendor scheduled but not on the selected weekday is in neither group —
     it's simply hidden for that day.)
   - `kpis = computeReorderKpis(primary)`
5. **Render:**
   - Mount `<ReorderDatePicker value={selectedDate} onChange={setSelectedDate}
     maxDate={maxDate} activeWeekdays={activeWeekdays} />` in the `TabStrip`
     `rightSlot` (left of CSV/PDF/REFRESH).
   - Feed `kpis` (recomputed) to the `StatCard`s instead of
     `reorderPayload.kpis`.
   - Map `primary` to `VendorCard`s (replacing the current `vendors.map`).
   - Render the `noSchedule` group (collapsed-by-default) when non-empty.
   - Day-filter empty state: when `primary.length === 0` AND not loading AND
     no error AND there IS a focal store AND the payload loaded — show the new
     "No vendors are ordered on <weekday>." copy (distinct from the existing
     "NO REORDER SUGGESTIONS"). Use `dayOfWeekLongLabel(selectedWeekday, T)`
     for `<weekday>`. Keep the existing "NO REORDER SUGGESTIONS" state for the
     case where the *payload itself* is empty (no suggestions at all for the
     date) — distinguish: payload-empty → existing copy; payload-non-empty but
     day-filtered-to-zero → new copy.
   - Export buttons pass the derived filtered payload (D).
   - No-focal-store guard (E) returns early after hooks.

---

### New files

- `src/components/cmd/ReorderDatePicker.tsx` — Cmd-native calendar (contract
  in (C)).
- `src/utils/reorderDayFilter.ts` — pure, framework-free functions:
  - `weekdayName(isoDate: string): DayName` — via fixed index array
    `['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']`
    indexed by `new Date(iso + 'T00:00:00').getDay()`. (Parse at local
    midnight to avoid the UTC-rollover bug `DatePicker` avoids the same way.)
  - `activeWeekdaysFromSchedule(schedule: OrderSchedule): Set<DayName>`
  - `partitionReorderVendors(vendors: ReorderVendor[], schedule:
    OrderSchedule, selectedWeekday: DayName): { primary: ReorderVendor[];
    noSchedule: ReorderVendor[] }`
  - `computeReorderKpis(vendors: ReorderVendor[]): ReorderPayload['kpis']`
  Keeping these pure (no React, no store import) is what makes the jest
  contract below cheap and is consistent with the `enumLabels` / `reportDates`
  pure-util pattern. Reuse `DayName` from `src/utils/enumLabels.ts` and the
  `OrderSchedule` / `ReorderVendor` types from `src/types`.

### i18n catalog work (all three: en / es / zh-CN)

Add under `section.reorder` (`src/i18n/en.json:782` and the es/zh-CN
siblings — the i18n test enforces key-parity across catalogs):
- `section.reorder.selectStore` — "Select a store to view the reorder list."
- `section.reorder.noVendorsForDay` — e.g. "No vendors are ordered on
  {day}." (uses the `{var}` substitution `t()` already supports;
  developer passes `{ day: dayOfWeekLongLabel(...) }`).
- `section.reorder.noScheduleGroupTitle` — e.g. "No order schedule".
- `section.reorder.noScheduleGroupHint` — e.g. "Not tied to a weekday — shown
  for reference."
Reuse existing `enum.dayOfWeek.long.*` / `enum.dayOfWeek.short.*` and the
helpers `dayOfWeekLongLabel` / `dayOfWeekShortLabel`
(`src/utils/enumLabels.ts:104-111`) — no new enum keys. The calendar's
weekday header row may reuse `enum.dayOfWeek.short` or the existing
single-letter `DAYS` literal; developer's choice (short labels are more
legible than the `S/M/T/W/T/F/S` ambiguity).

---

### Test contract (jest only — no pgTAP)

Per spec Conventions; **no pgTAP** because no field/param/RPC/grant changes.

1. **`src/utils/reorderDayFilter.test.ts`** (pure-function unit tests):
   - `weekdayName`: maps known ISO dates to the correct `DayName`; parses at
     local midnight (no off-by-one across a UTC boundary).
   - `activeWeekdaysFromSchedule`: empty baseline → empty set; mixed schedule
     → exactly the non-empty day-keys.
   - `partitionReorderVendors`:
     - vendor scheduled on the selected weekday → in `primary`.
     - vendor scheduled only on a different weekday → in neither group.
     - vendor with `scheduleKnown === false` → in `noSchedule`, regardless of
       weekday.
     - case-insensitive / canonical match (selected `Monday` matches schedule
       key `Monday`; defensively also a lowercased key if the source ever
       changes).
     - intersection correctness: a scheduled vendor NOT in the payload (no
       suggestion) does not appear (only payload vendors are partitioned).
   - `computeReorderKpis`: sums itemCount / totalEstimatedCost; counts
     vendorCount and eod/stock split off the filtered set.
2. **`src/components/cmd/ReorderDatePicker.test.tsx`** (RN testing-library,
   same idiom as `MenuCapacityBadge.test.tsx` / `StatusPill.test.tsx`):
   - **default-today:** opens with `value` = today selected.
   - **past-only / future-disabled:** a `-day-<n>` cell for a date `>
     maxDate` is disabled / pressing it does not call `onChange`; a past cell
     calls `onChange` with the right ISO.
   - **active-days:** given `activeWeekdays={new Set(['Monday'])}`, cells on
     Mondays carry the active marker (assert via testID + style or an
     accessibility hint the developer exposes) and non-Mondays do not.
   - **Today action:** tapping `-today` calls `onChange(maxDate)`.
3. **Date→re-fetch wiring** (lighter-touch, optional but recommended — a
   `ReorderSection` interaction test or a store-level assertion):
   - changing the selected date calls `loadReorderSuggestions(<that date>)`.
   - if a full-section render test is heavy, assert the wiring at the store
     boundary (`loadReorderSuggestions(asOfDate)` →
     `fetchReorderSuggestions(storeId, asOfDate)` puts `as_of_date` in
     `p_params`) — `fetchReorderSuggestions` already has the shape; a focused
     test that the section passes `selectedDate` through is sufficient.
   The hard requirement is coverage of the filter logic (#1) and the calendar
   behaviors (#2); #3 is the integration seam.

### Risks and tradeoffs (explicit)

- **KPI/server divergence is intentional, not a bug.** After this change the
  on-screen KPIs are client-recomputed off the order-out-filtered set and will
  legitimately differ from `reorderPayload.kpis` (which is server
  post-suggestion-filter, pre-order-out-filter). This is the (D) decision and
  the only way the strip, list, and export agree. A reviewer comparing the
  strip to the raw RPC payload will see a difference — call it out in the PR.
- **Slice-load timing.** The filter depends on `orderSchedule` being hydrated
  for the focal store. It is, because `loadFromSupabase` runs on store switch
  and login before the section is interactable. Edge case: a hard refresh
  landing directly on Reorder relies on the boot `loadFromSupabase`. If the
  slice is momentarily the empty baseline, the filter yields zero primary
  vendors and shows the day-filter empty state for an instant, then corrects
  when the slice arrives — acceptable (it's a read, no data loss). The
  developer should NOT add a separate `fetchOrderSchedule` call in the section
  (that would duplicate the slice and risk store-scoping drift); rely on the
  slice.
- **Performance on the 286 KB seed.** Trivial. The filter is an O(vendors)
  array pass against a `Set`; the active-days set is O(7). No new query, no
  new round-trip. The historical as-of fetch is the same single RPC that
  already runs.
- **No migration ⇒ no drift-gate, no ordering risk.** Nothing to push, nothing
  for `db-migrations-applied.yml` to check.
- **Weekday derivation must be index-based, not `toLocaleString`.** A
  locale-dependent weekday name would break the canonical match for es/zh-CN
  users. The util pins the fixed index array — this is the one real
  correctness trap and the test covers it.
- **"No schedule" group scope.** Defining "no schedule" off
  `vendor.scheduleKnown` (authoritative, server-computed) rather than
  re-deriving from the slice avoids a subtle mismatch if a vendor exists in
  the payload but the slice's view of its schedule differs. Prefer the
  payload flag.

### Acceptance-criteria coverage map

- AC1 (calendar visible, defaults today, shows only order-out-today vendors) →
  `ReorderDatePicker` + A1 filter + wiring.
- AC2 (past date re-fetches as-of + filters to that date's weekday) → wiring
  step 2 + filter on `selectedWeekday`.
- AC3 (future disabled) → (C) future-disable.
- AC4 (active-days highlight, weekday-recurring) → (B1) + (C) active marker.
- AC5 (case-insensitive canonical weekday match) → util `weekdayName` +
  canonical keys + test.
- AC6 (distinct day-filter empty state) → `section.reorder.noVendorsForDay`.
- AC7 (no stale KPIs after date change) → (D) client recompute.
- AC8 (export matches on-screen filtered + as-of) → (D) derived payload to
  export fns.
- AC9 (`schedule_known=false` vendors don't silently vanish) → (A) secondary
  "no schedule" group.
- AC10 (no-focal-store select-a-store) → (E) guard.
- AC11 (tests) → jest contract above; no pgTAP.

## Handoff
next_agent: frontend-developer
prompt: Implement Spec 087 against the "Backend design (architect)" section
  above. This is FRONTEND-ONLY — no backend-developer needed, no migration, no
  pgTAP. Build the Cmd-native `src/components/cmd/ReorderDatePicker.tsx`
  (default today, past-only/future-disabled, active-day highlight from the
  `orderSchedule` slice, `useCmdColors()`), the pure
  `src/utils/reorderDayFilter.ts` (weekday derivation via fixed index array,
  order-out partition, client KPI recompute), and wire `selectedDate` through
  `ReorderSection` to `loadReorderSuggestions(asOfDate)` with re-fetch on
  change and reset-to-today on store switch. Apply the (D) client-side KPI +
  export recompute (strip, CSV, PDF, and `showExport` all reflect the filtered
  primary set), the (A) secondary "no schedule" group, the distinct
  day-filter empty state, and the (E) no-focal-store guard. Add the four
  `section.reorder.*` i18n keys across en/es/zh-CN. Land the jest tests in the
  Test contract. After implementation, set Status: READY_FOR_REVIEW and list
  files changed under ## Files changed.
payload_paths:
  - specs/087/spec.md

---

## Files changed (frontend-developer)

FRONTEND-ONLY, as the architect specified — no migration, no pgTAP, no
edge/RLS/realtime, no `db.ts` change. `loadReorderSuggestions` and
`fetchReorderSuggestions` already accepted `asOfDate`; the section now passes
the calendar's date.

New files:
- `src/utils/reorderDayFilter.ts` — pure (no React/supabase) order-out
  filter + active-days + client KPI recompute. `weekdayName` uses a fixed
  index array (NOT `toLocaleString`) and parses ISO at local midnight (both
  correctness traps the architect flagged). Exports `weekdayName`,
  `canonicalizeDayName`, `activeWeekdaysFromSchedule`,
  `partitionReorderVendors`, `computeReorderKpis`, `ALL_WEEKDAYS`.
- `src/components/cmd/ReorderDatePicker.tsx` — Cmd-native month-grid calendar
  (RN `Modal` + `TouchableOpacity`, cross-platform), `useCmdColors()`,
  default-today, past-only/future-disabled, active-day dot, single "Today"
  footer (no Clear). Props per design (C).
- `src/utils/reorderDayFilter.test.ts` — pure-util unit tests (node project):
  weekday locale-invariance + UTC-rollover, active-days, partition
  (primary/no-schedule/hidden/intersection/case-insensitive), KPI recompute.
- `src/components/cmd/ReorderDatePicker.test.tsx` — calendar tests (jsdom):
  default-today, past-only/future-disabled, active-day marks (incl. no mark
  on future Mondays), Today action, month navigation.
- `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx` — section
  interaction tests (jsdom, integration seam #3): mount fetch with today,
  re-fetch with picked past date, no-focal-store guard renders + no fetch,
  day-filter empty state, collapsed no-schedule group.

Modified:
- `src/screens/cmd/sections/ReorderSection.tsx` — `selectedDate` state
  (default today) + `maxDate`; mount/refresh now call
  `loadReorderSuggestions(selectedDate)` and re-fetch on date change; reset to
  today on focal-store switch (ref-guarded); derive `activeWeekdays`,
  `selectedWeekday`, `{ primary, noSchedule }`, and client-recomputed `kpis`
  from the pure util; mount `ReorderDatePicker` in the `TabStrip` rightSlot
  left of CSV/PDF/REFRESH; StatCards + CSV/PDF + `showExport` all driven off
  the filtered primary set + recomputed KPIs (D); secondary collapsed
  "no schedule" group (A); distinct day-filter empty state vs the existing
  payload-empty "NO REORDER SUGGESTIONS" copy; no-focal-store guard (E)
  after hooks.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — four
  `section.reorder.*` keys (`selectStore`, `noVendorsForDay`,
  `noScheduleGroupTitle`, `noScheduleGroupHint`); reuses existing
  `enum.dayOfWeek.long.*`. Catalog key-parity test passes.

Verification:
- `npx tsc --noEmit` (base) and `npx tsc -p tsconfig.test.json --noEmit`
  (test graph) both exit 0.
- `npx jest` — 50 suites / 493 tests green (added 28 util/calendar + 5
  section interaction tests; i18n parity green).
- Production-equivalent web bundle (`expo/AppEntry.bundle`, platform=web)
  compiles HTTP 200 with the new util/component/i18n present and no
  resolve/transform/syntax errors — exercises the full import graph through
  Metro, not just typecheck.
- The live `report_reorder_list` RPC on the local stack accepts the
  `{p_store_id, p_params:{as_of_date}}` shape (the path the calendar drives).
- NOTE: I could not drive the live browser UI — the `preview_*` /
  claude-in-chrome / computer-use MCP tools described in this session's
  context are not in my callable tool set and there is no ToolSearch handle to
  load them. Verification rests on the full Metro web-bundle compile, the
  whole-component render test (real `ReorderSection` + real `ReorderDatePicker`
  + real util exercising mount fetch, date-change re-fetch, the guard, and
  both empty states), the calendar component tests, and the typechecks. A
  reviewer with the preview tools should still do the in-browser golden-path
  pass per the spec's verification list (default = today's order-out vendors,
  calendar opens / future disabled / active days highlighted, past date
  re-fetches + filters + "as of" updates, KPIs/CSV/PDF match the filtered
  list, no-schedule group + day-filter empty state + no-focal-store state).

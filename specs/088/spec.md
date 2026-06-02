# Spec 088: Reorder "Suggested" shown in cases for case-based items

Status: READY_FOR_REVIEW

## User story
As a store manager working the admin **Reorder** section, I want the **Suggested** order
quantity to be expressed **in whole cases** (plus the underlying unit breakdown) for items
that have a case size set, so that the figure matches how I actually order from vendors —
by the case — and the estimated cost reflects the real quantity I'll order (a whole number
of cases), not a fractional in-base-unit suggestion.

## Context (verified against code)
- The Reorder data comes from the `report_reorder_list(uuid, jsonb)` RPC
  ([supabase/migrations/20260514130000_report_reorder_list.sql](../../supabase/migrations/20260514130000_report_reorder_list.sql)).
  Per item it computes `suggested_qty = greatest(par_replacement, usage_forecasted)` in the
  item's BASE unit (line 451) and `estimated_cost = suggested_qty * cost_per_unit` (line 457).
  The per-item JSON object (lines 494–509) exposes `item_name, unit, on_hand, pending_po_qty,
  par_level, usage_forecasted, par_replacement, suggested_qty, cost_per_unit, estimated_cost,
  flags` — but NOT `case_qty`.
- The report already JOINs `public.catalog_ingredients ci` for the item name (`ci.name as
  item_name`, line 419; the join is at line 443). `ci.case_qty` is therefore reachable to add
  additively to the per-item JSON.
- `catalog_ingredients.case_qty` is `numeric default 1` (added in
  [supabase/migrations/20260504060452_brand_catalog_p1_additive.sql:40](../../supabase/migrations/20260504060452_brand_catalog_p1_additive.sql)).
  The same column was DROPPED from `inventory_items` in P3 lockdown
  ([supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql:62](../../supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql)),
  so the catalog row is the only source of truth for units-per-case today.
- FE: `fetchReorderSuggestions` ([src/lib/db.ts:2706](../../src/lib/db.ts)) maps the payload via
  `mapReorderVendor` (line 2750). The `ReorderItem` type
  ([src/types/index.ts:701](../../src/types/index.ts)) has `suggestedQty, unit, costPerUnit,
  estimatedCost, …` but NOT `caseQty`. `costPerUnit` IS already mapped (db.ts:2762).
- `ReorderSection` ([src/screens/cmd/sections/ReorderSection.tsx](../../src/screens/cmd/sections/ReorderSection.tsx))
  renders the suggested figure in five places:
  1. the `order: {suggestedQty} {unit}` sub-line in `BreakdownLine` (line 72);
  2. the **SUGGESTED column** value (line 333) and its header (line 297);
  3. the **EST $** column (line 336) and the per-vendor `total qty` / `est cost` header rollups
     (lines 270/275/360);
  4. the CSV export `buildReorderCsv` (lines 405–437, `Suggested Qty` + `Unit` + `Est. Cost`
     columns at 427/430);
  5. the PDF export `handlePdfExport` (`Suggested` + `Unit` + `Est. Cost` columns, lines
     507–516, footer `Est. total` line 539).
  The **EST. TOTAL** KPI card reads `kpis.totalEstimatedCost` (line 779).
- Spec 087 already recomputes the KPI strip + builds the export payload client-side from the
  day-filtered set (`computeReorderKpis` + `exportPayload`,
  [src/utils/reorderDayFilter.ts:174](../../src/utils/reorderDayFilter.ts) and
  ReorderSection.tsx lines 632/642). `totalEstimatedCost` is summed from
  `vendor.vendorTotalCost`. Any case-rounding of Est $ must therefore reconcile with how
  `vendorTotalCost` and `computeReorderKpis` are computed, so the per-row Est $, the per-vendor
  `est cost`, and the EST. TOTAL KPI all agree.
- Precedent for the case-display math already exists at
  [src/lib/orderCalculator.ts:78–83](../../src/lib/orderCalculator.ts) (`caseQty = item.caseQty
  || 1; hasCaseInfo = casePrice > 0 && caseQty > 1; cases = Math.floor(orderQuantity / caseQty);
  looseUnits = orderQuantity - cases*caseQty`). NOTE the divergences for this spec: (a) round
  **UP** (`Math.ceil`) because you can't order a partial case, and (b) "has a case size" is keyed
  on `case_qty` alone per the user decision, not on `casePrice`. The staff EOD screen mirrors
  the `caseQty || 1` fallback convention ([src/screens/staff/lib/types.ts:20–23](../../src/screens/staff/lib/types.ts), spec 086).

## Acceptance criteria
- [ ] For an item **with a case size** (`case_qty > 1`), the SUGGESTED column shows the case
      count PLUS the underlying base-unit total — format `N cases · M unit` where
      `N = ceil(suggested_qty / case_qty)` (whole cases, rounded UP) and `M = N × case_qty`
      (total units actually ordered). Exact separator/copy/pluralization is finalized by
      architect/FE (the user-given example was `3 cases · 72 each`).
- [ ] Rounding is **ceil**: a `suggested_qty` of `49` with `case_qty = 24` shows `3 cases · 72`
      (49/24 = 2.04 → 3 cases); an exact multiple `suggested_qty = 48`, `case_qty = 24` shows
      `2 cases · 48` (no spurious extra case); `suggested_qty = 24`, `case_qty = 24` shows
      `1 case · 24`.
- [ ] Pluralization: `1 case` (singular) vs `2 cases` (plural) — FE decides exact copy but it
      must not read `1 cases`.
- [ ] The `order:` sub-line in the inline breakdown (`BreakdownLine`) shows the SAME cases·unit
      figure as the SUGGESTED column for case-based items (the two never disagree).
- [ ] **Est $** for a case-based item reflects the rounded-up case order:
      `est_$ = ceil(suggested_qty / case_qty) × case_qty × cost_per_unit` (i.e. the actual
      quantity ordered × cost_per_unit, NOT the raw fractional `suggested_qty × cost_per_unit`).
- [ ] The per-vendor `est cost` rollup (VendorCard header + footer) and the **EST. TOTAL** KPI
      card sum the case-rounded per-row Est $ for case-based items, so the KPI total equals the
      sum of the visible per-row Est $ values.
- [ ] Items **without a case size** (`case_qty` null, `0`, or `1`) are UNCHANGED: SUGGESTED and
      the `order:` line render `suggested_qty unit` exactly as today (each / gal / lbs), with no
      case wording and no rounding applied, and Est $ stays `suggested_qty × cost_per_unit`.
- [ ] **ON HAND, INBOUND, PAR** columns and their breakdown segments stay in the BASE unit for
      all items (case conversion applies ONLY to the order/suggested figure + its Est $).
- [ ] The **CSV export** reflects the case treatment for case-based items in a spreadsheet-safe
      way: the case count and the ordered base-unit total are both recoverable, and the
      `Est. Cost` column equals the case-rounded Est $. Exact column shape (e.g. adding a
      `Cases` / `Units per Case` column vs. encoding into existing columns) is finalized by
      architect/FE; rows for no-case-size items are byte-for-byte unchanged from today.
- [ ] The **PDF export** suggested column + Est. Cost column + the footer `Est. total` reflect
      the same case-rounded figures the on-screen cards show.
- [ ] The case display is a pure display/derivation transform over whatever rows are currently
      shown — it applies identically regardless of spec 087's calendar selected-date and
      order-out-day filter, and to both the PRIMARY group and the secondary "no schedule" group.
- [ ] If the case math lands server-side (Decision A path), the report continues to return
      identical output for items with `case_qty` null/≤1 (no regression for the existing
      base-unit behavior), verified by pgTAP.

## In scope
- Expose / surface units-per-case for reorder rows (additive `case_qty` on the report's per-item
  JSON, OR a server-computed `suggested_cases` + case-rounded `estimated_cost` — Decision A).
- FE: cases·unit display for the SUGGESTED column and the `order:` breakdown sub-line, ceil
  rounding, singular/plural copy, for items with a case size.
- Est $ (per-row), per-vendor `est cost`, and the EST. TOTAL KPI all follow the rounded-up case
  order for case-based items.
- CSV + PDF exports reflect the case treatment consistently with the on-screen cards.
- Tests: jest (FE display + rounding + Est $ recompute + no-case-size-unchanged + EST. TOTAL
  consistency); pgTAP iff the report changes.

## Out of scope (explicitly)
- Changing the reorder MATH — `par_replacement`, `usage_forecasted`, and
  `suggested_qty = greatest(...)` are unchanged. This spec changes only the UNIT the suggested
  figure is expressed in and the ceil-to-whole-cases rounding for the order/cost. *(The user
  asked for a display+ordering change, not a forecast change.)*
- **ON HAND / PAR / INBOUND** display — stays in base units. *(User highlighted only the
  Suggested column.)*
- Sub-unit / pack decomposition beyond cases (e.g. `case_qty × sub_unit_size` three-level
  breakdown) — only the single cases·unit split is in scope. *(Not requested; orderCalculator's
  richer pack model is a separate concern.)*
- Any "Create PO" / write-back of the case-rounded quantity — the Create PO button remains the
  disabled v1 placeholder. *(No PO write path exists; unrelated to this display change.)*
- The staff EOD app and any other admin section. *(Admin Reorder only.)*
- Mutating actual order quantities or persisting the rounded figure anywhere — this is
  display/derivation only.

## Open questions resolved
- Q: Which items convert to cases? → A: ONLY items with a case size set (`case_qty > 1`). Items
  with no case size keep their base unit (each/gal/lbs) unchanged. *(User decision 1.)*
- Q: Display format? → A: cases + unit breakdown, both visible — e.g. `3 cases · 72 each`. Exact
  separator/copy finalized by architect/FE. *(User decision 2.)*
- Q: Rounding + cost behavior? → A: round UP to whole cases (`ceil(suggested_qty / case_qty)` —
  no partial cases), and Est $ follows the rounded-up case order
  (`ceil_cases × case_qty × cost_per_unit`), so cost reflects the actual quantity ordered, not
  the raw fractional suggestion. *(User decision 3.)*
- Q: Is this admin or staff? → A: admin Reorder section only.

## Open questions for the architect (not user-blocking — design decisions)
- **(A) Where the case math lives.** Two viable paths, pin one:
  - **A1 (FE recompute, matches spec 087 posture):** the report additively exposes
    `case_qty` (keeping the existing `cost_per_unit` + `estimated_cost` fields), and the FE
    does the `ceil`-to-cases, the cases·unit display, AND the Est $ recompute. Pro: consistent
    with spec 087's existing client-side recompute (`computeReorderKpis`, `exportPayload`);
    keeps the rounding rule in one TS place that jest can pin. Con: the report's
    `estimated_cost` / `vendor_total_cost` / `kpis.total_estimated_cost` become "raw" numbers
    the FE must override everywhere they surface (per-row, per-vendor header, KPI, exports) —
    miss one and the totals disagree.
  - **A2 (server computes):** the report returns `suggested_cases` + a case-rounded
    `estimated_cost` (and rolls the case-rounded cost into `vendor_total_cost` +
    `kpis.total_estimated_cost`). Pro: one source of truth; KPI/vendor rollups already correct.
    Con: diverges from spec 087's client-recompute, and the client STILL recomputes KPIs from
    the day-filtered set so the per-row case-rounded Est $ must still flow through
    `vendorTotalCost` → `computeReorderKpis`.
  - Whichever is chosen, **the EST. TOTAL KPI must equal the sum of the visible per-row
    case-rounded Est $**, including after spec 087's day filter. Note the FE already recomputes
    KPIs from `vendor.vendorTotalCost`; pin whether `vendorTotalCost` carries the raw or the
    case-rounded sum so the two layers can't disagree.
- **(B) `case_qty` source + the "has a case size" boundary.** Confirm the source is
  `catalog_ingredients.case_qty` (the report's `ci` join). Define the predicate precisely:
  user decision 1 says `case_qty > 1`. Confirm null/`0`/`1` ALL mean "no case size → base unit
  unchanged" (i.e. predicate is `case_qty IS NOT NULL AND case_qty > 1`, mirroring
  `orderCalculator`'s `caseQty > 1` and spec 086's `caseQty || 1` fallback). Decide whether the
  threshold is strict `> 1` (so a literal 1-per-case item never shows "1 case · 1 each").
- **(C) Scope of the conversion within the row.** Confirm ON HAND / PAR / INBOUND stay base
  unit (likely yes — the user only asked about the order quantity). Confirm the conversion set
  is exactly: SUGGESTED column + `order:` sub-line + Est $ (per-row, per-vendor, KPI) + CSV +
  PDF. Decide the CSV/PDF column shape (add explicit `Cases` / `Units per Case` columns vs.
  encode into the existing `Suggested Qty` / `Unit` cells) — exports are consumed by
  spreadsheets, so numeric-friendliness matters (see `buildReorderCsv`'s existing
  no-`$`-in-Est.-Cost note, db.ts ReorderSection line 429).
- **(D) Interaction with spec 087.** Confirm the cases display is a pure transform over the
  already-filtered rows (PRIMARY + secondary "no schedule" groups), independent of the selected
  date / order-out filter, with no conflict against `exportPayload` / `computeReorderKpis`.

## Dependencies
- If Decision A lands server-side or even just additively exposes `case_qty`, a new timestamped
  migration is required → the `db-migrations-applied` drift gate applies (user runs
  `npx supabase db push --linked` post-merge), plus pgTAP coverage.
- FE: `ReorderItem` type ([src/types/index.ts:701](../../src/types/index.ts)) gains `caseQty`
  (path A1) — and `mapReorderVendor` ([src/lib/db.ts:2750](../../src/lib/db.ts)) maps it; or
  gains `suggestedCases` (path A2). `ReorderSection.tsx` display + exports;
  `reorderDayFilter.ts` `computeReorderKpis` / the section's `exportPayload` if the Est $
  rounding is FE-side.
- Existing precedent to reuse, NOT re-derive: the case split logic shape in
  `src/lib/orderCalculator.ts` (adapt floor→ceil, drop the casePrice gate).

## Project-specific notes
- **Cmd UI section / legacy:** admin Cmd UI — `src/screens/cmd/sections/ReorderSection.tsx`.
  No legacy surface.
- **Per-store or admin-global:** per-store. `report_reorder_list` is `p_store_id`-scoped behind
  `auth_can_see_store()`; the section already guards the "All brands" placeholder
  (ReorderSection.tsx line 672). `case_qty` lives on `catalog_ingredients` (brand-scoped) — no
  new store-scoping concern introduced.
- **Realtime channels touched:** none. This is a display transform on the on-demand reorder
  payload; no new data writes, no new publication. (No realtime publication gotcha applies.)
- **Migrations needed:** likely YES (additive — expose `ci.case_qty` and/or add
  `suggested_cases` + case-rounded `estimated_cost`). If the architect finds an FE-only path
  where `case_qty` is already reachable client-side without touching the report, that's
  preferable — but the report does NOT currently expose it, so an additive report change is the
  expected path. A migration triggers the `db-migrations-applied` gate.
- **Edge functions touched:** none.
- **Web/native scope:** the section renders on both; the CSV/PDF exports are web-only (existing
  spec 025 constraint, `Platform.OS === 'web'` gate at ReorderSection.tsx line 651) — the case
  display itself applies on both web and native.
- **Tests:**
  - **jest** (FE): cases·unit breakdown rendering; ceil rounding incl. exact-multiple (no
    spurious case) and just-over-a-multiple; singular `1 case` vs plural; Est $ recompute equals
    `ceil_cases × case_qty × cost_per_unit`; items with `case_qty` null/`0`/`1` unchanged
    (base unit, no rounding); EST. TOTAL KPI equals the sum of visible per-row Est $ (including
    after the spec 087 day filter); CSV/PDF rows reflect the case figures.
  - **pgTAP** (only if the report changes): assert the per-item JSON exposes `case_qty` (path
    A1) or `suggested_cases` + the case-rounded `estimated_cost` (path A2); assert existing
    base-unit behavior is preserved for items with `case_qty` null/≤1. Grant-lockdown via
    `has_function_privilege` ONLY if a grant is touched; do NOT use `set role anon`.
  - **app.json slug:** not touched.

## Status note
Set to READY_FOR_ARCH: all three user-facing decisions (which items, display format,
rounding+cost) are captured, and the remaining open items (A–D) are architect-decidable design
choices (where the math lives, the exact predicate threshold, export column shape, spec-087
reconciliation) rather than product decisions that need the user.

---

## Backend design (architect)

### Decision summary (A)–(D)

- **(A) Where the case math lives — PICK: Option B (server computes the cost rounding), with
  display formatting on the FE.** The report additively exposes `case_qty` and a server-computed
  `suggested_cases`, AND rounds `estimated_cost` up to the whole-case order, AND rolls that
  rounded cost into `vendor_total_cost` and `kpis.total_estimated_cost`. The FE does the
  `N cases · M units` *display* formatting only (no cost math). **Rationale — the spec-087
  reconciliation chain decides it:** `computeReorderKpis` ([src/utils/reorderDayFilter.ts:182](../../src/utils/reorderDayFilter.ts))
  sums `v.vendorTotalCost`, and `vendorTotalCost` is mapped straight from the server's
  `vendor_total_cost` ([src/lib/db.ts:2777](../../src/lib/db.ts)). If the server rounds
  `estimated_cost` per item AND rolls it into `vendor_total_cost`, then **every downstream cost
  surface is correct with zero new FE cost-math**: the per-row Est $ (`item.estimatedCost`,
  ReorderSection.tsx:336), the per-vendor `est cost` rollup (`vendor.vendorTotalCost`, lines
  270/275/360), and the EST. TOTAL KPI (`computeReorderKpis` summing `vendorTotalCost`, line 779)
  all already read these fields verbatim, and the "KPI == sum of visible per-row Est $" invariant
  holds **by construction** — including after spec-087's day filter, because the filter only
  selects which `vendor.vendorTotalCost` values get summed; it never recomputes them. It is also a
  single pgTAP-testable source of truth. Option A was rejected: it would force the FE to override
  `estimatedCost` per row AND recompute every `vendorTotalCost` *before* `computeReorderKpis` runs
  — four surfaces to keep in lockstep, exactly the "miss one and the totals disagree" failure the
  spec's (A) note warns about. The cases·units *display* (`N cases · M units`, pluralization)
  stays FE-side because it's pure formatting jest can pin cheaply; it does NOT recompute cost.

- **(B) Predicate + nulls.** "Has a case size" ⇔ `case_qty IS NOT NULL AND case_qty > 1`. Null,
  `0`, and `1` ALL mean "no case size → base unit unchanged". Strict `> 1` so a literal
  1-per-case item never renders the degenerate `1 case · 1 each`. The server computes
  `suggested_cases` only when the predicate holds (else returns `null`/omits it and leaves
  `estimated_cost` as the raw `suggested_qty × cost_per_unit`). FE mirrors with the
  `caseQty ?? 1` / `caseQty > 1` convention from [src/lib/orderCalculator.ts:78-80](../../src/lib/orderCalculator.ts)
  and spec 086 ([src/screens/staff/lib/types.ts:20-23](../../src/screens/staff/lib/types.ts)) —
  drop orderCalculator's `casePrice > 0` gate (the user keyed the predicate on `case_qty` alone),
  and flip `Math.floor` → `Math.ceil` (whole cases to cover the suggestion).

- **(C) Scope within the row + CSV/PDF shape.** Conversion set is EXACTLY: SUGGESTED column +
  `order:` sub-line + Est $ (per-row, per-vendor, KPI) + CSV + PDF. **ON HAND / INBOUND / PAR stay
  base unit** for all items (confirmed — user asked only about the order/Suggested figure). CSV:
  **add two explicit numeric-friendly columns** `Cases` and `Units Per Case` (so the case count
  and the ordered base-unit total are both recoverable and spreadsheet-summable) rather than
  encoding a `"3 cases · 72"` string into `Suggested Qty`; `Suggested Qty` continues to carry the
  **ordered base-unit total** `M` for case items (= `suggested_cases × case_qty`) and the raw
  `suggested_qty` for non-case items, and `Est. Cost` carries the server's (now case-rounded)
  value. PDF: keep the existing 7-column head; render the `Suggested` cell as `N cs · M unit` for
  case items and `M unit` for non-case items (a glanceable string is fine for a print artifact),
  and `Est. Cost` reads the server's rounded value. **No-case-size rows are byte-for-byte
  unchanged** in both exports (`Cases`/`Units Per Case` empty, `Suggested Qty` = raw
  `suggestedQty`).

- **(D) Spec-087 interaction.** Confirmed orthogonal. The cases display + the server's
  case-rounded cost are a pure per-row transform; spec-087's `partitionReorderVendors` and
  `computeReorderKpis` operate over whichever rows are shown (PRIMARY + secondary "no schedule"),
  selecting/summing the already-rounded `vendorTotalCost`. No change to `reorderDayFilter.ts` is
  required, and `exportPayload` ([ReorderSection.tsx:642](../../src/screens/cmd/sections/ReorderSection.tsx))
  carries the rounded numbers through unchanged.

### 1. Data model changes

**No table/column/index changes.** `catalog_ingredients.case_qty` already exists (`numeric
default 1`, [supabase/migrations/20260504060452_brand_catalog_p1_additive.sql:40](../../supabase/migrations/20260504060452_brand_catalog_p1_additive.sql)).
The change is **additive to the `report_reorder_list(uuid, jsonb)` RPC body only** — a
`create or replace function` with the **same signature and same grants**. No `inventory_items`
changes (`case_qty` was dropped there in P3; the catalog row is the only source — confirmed).

**Proposed migration:** `supabase/migrations/20260602000000_reorder_suggested_cases.sql`
(sorts after the latest on disk, `20260601000000_staff_submit_eod_cases_each.sql`).

- Additive `create or replace`. **Destructive: no.** Rollout-safe: the only output changes are
  (a) three NEW keys in the per-item JSON, (b) the *values* of `estimated_cost` /
  `vendor_total_cost` / `kpis.total_estimated_cost` become case-rounded for items with a case
  size — a deliberate behavior change, but **identical output for items with `case_qty` null/≤1**
  (verified by pgTAP). The current FE tolerates extra JSON keys (`mapReorderVendor` reads named
  fields), so an old client against the new RPC keeps working (it just shows the rounded cost,
  which is the desired end state anyway).
- **Signature/grant unchanged → no anon-lockdown churn.** Do NOT re-`revoke`/`grant`; the existing
  `revoke … from public, anon` + `grant … to authenticated` at the bottom of the current migration
  ([…20260514130000…:606-609](../../supabase/migrations/20260514130000_report_reorder_list.sql))
  stays in force because `create or replace` preserves ACLs. (Confirmed — re-stating grants would
  be redundant; only restate if you change the signature, which you must not.)

**The exact SQL change (developer authors; shown here as the contract, not committed code):**

1. In the `per_item` CTE (after line ~443), surface the catalog's case size from the existing
   `ci` join (`join public.catalog_ingredients ci on ci.id = ioh.catalog_id`, already present at
   line 443):
   - add `coalesce(ci.case_qty, 1)::numeric as case_qty` to the select list.
2. In `per_item_filtered` (lines ~454-475), derive the two rounded values alongside the existing
   `estimated_cost`:
   - `suggested_cases` = `case when pis.case_qty > 1 then ceil(pis.suggested_qty / pis.case_qty) else null end` (numeric or null).
   - replace the existing `estimated_cost` expression (line 457, currently
     `pis.suggested_qty * pis.cost_per_unit`) with the case-rounded form:
     `case when pis.case_qty > 1 then (ceil(pis.suggested_qty / pis.case_qty) * pis.case_qty * pis.cost_per_unit) else (pis.suggested_qty * pis.cost_per_unit) end`.
     This is the single place cost is computed; `vendor_total_cost` (`sum(estimated_cost)`, line
     493) and `kpis.total_estimated_cost` (`sum(vendor_total_cost)`, line 542) inherit the
     rounding automatically — no other SQL edit needed for the rollups.
3. In the per-item `jsonb_build_object` (lines ~495-508), add THREE keys:
   - `'case_qty', pif.case_qty`
   - `'suggested_cases', pif.suggested_cases`
   - `'suggested_units', case when pif.suggested_cases is not null then pif.suggested_cases * pif.case_qty else pif.suggested_qty end`
     — the "ordered base-unit total" `M`. Exposed explicitly so the FE display, CSV `Suggested
     Qty`, and PDF all read ONE server-authoritative `M` rather than re-deriving
     `cases × case_qty` in three places (defends against any future server rounding-rule change).
   - keep `suggested_qty` (the raw greatest(...) figure) unchanged for back-compat and for the
     `parReplacement`/`usageForecasted` breakdown semantics.

   > **Numeric note for the developer:** `case_qty` is `numeric`. `ceil(x/y)` in Postgres returns
   > numeric; the JSON serializes it without a decimal for whole values, and `Number(...)` on the
   > FE handles it. No `::int` cast needed (and avoid one — a fractional `case_qty` like `6.5`
   > shouldn't silently truncate; `> 1` admits it and `ceil` handles it correctly).

### 2. RLS impact

**None.** No new tables. `report_reorder_list` is `security invoker` behind a first-statement
`auth_can_see_store(p_store_id)` gate ([…:119](../../supabase/migrations/20260514130000_report_reorder_list.sql));
adding `ci.case_qty` reads the same `catalog_ingredients` row the function already SELECTs through
the `ci` join under the caller's RLS — no new read surface, no new policy. `case_qty` is
brand-scoped on `catalog_ingredients`; no store-scoping concern is introduced (confirmed against
spec §"Per-store or admin-global"). No `pg_policies` changes.

### 3. API contract

**PostgREST vs RPC: unchanged — stays the existing `report_reorder_list(uuid, jsonb)` RPC.**

- **Request shape:** unchanged. `supabase.rpc('report_reorder_list', { p_store_id, p_params })`,
  `p_params = { as_of_date?: 'YYYY-MM-DD' }`.
- **Response shape (additive):** each `vendors[].items[]` object gains:
  - `case_qty: number` (always present; `1` when no case size)
  - `suggested_cases: number | null` (null when `case_qty ≤ 1`)
  - `suggested_units: number` (= `suggested_cases × case_qty` for case items, else
    `suggested_qty`)
  and `estimated_cost` / `vendor_total_cost` / `kpis.total_estimated_cost` now carry case-rounded
  values for case items (identical to today for non-case items).
- **Error cases:** unchanged — `42501` for foreign-store (auth gate), errors bubble to the caller
  ([src/lib/db.ts:2719](../../src/lib/db.ts)) which routes to the in-section `reorderError` pane.

### 4. Edge function changes

**None.** No edge function touches reorder (confirmed against spec §"Edge functions touched").
`verify_jwt` settings untouched.

### 5. `src/lib/db.ts` surface

**No new exported helper.** The change is inside the existing private mapper `mapReorderVendor`
([src/lib/db.ts:2750](../../src/lib/db.ts)). Add three fields to the per-item map (snake_case →
camelCase):

```ts
// inside mapReorderVendor's items map, alongside the existing fields:
caseQty:        Number(it?.case_qty ?? 1),
suggestedCases: it?.suggested_cases == null ? null : Number(it.suggested_cases),
suggestedUnits: Number(it?.suggested_units ?? it?.suggested_qty ?? 0),
```

`ReorderItem` ([src/types/index.ts:701](../../src/types/index.ts)) gains:

```ts
caseQty: number;               // units per case; 1 when no case size
suggestedCases: number | null; // whole cases (ceil); null when caseQty <= 1
suggestedUnits: number;        // ordered base-unit total = suggestedCases*caseQty, else suggestedQty
```

No change to `fetchReorderSuggestions` (it just maps vendors through `mapReorderVendor`) and no
change to the `kpis` mapping block ([db.ts:2733-2739](../../src/lib/db.ts)) — `total_estimated_cost`
already maps straight through and is now server-rounded.

### 6. Realtime impact

**None.** This is a display + cost-derivation transform on the on-demand reorder RPC payload; no
data writes, no new publication membership. **`supabase_realtime` publication is NOT touched, so
the `docker restart supabase_realtime_imr-inventory` gotcha does NOT apply.** (Confirmed against
spec §"Realtime channels touched: none".)

### 7. Frontend store impact

**No `useStore.ts` slice change.** The reorder slice stores the `ReorderPayload` as-is; the new
fields ride along inside `items[]`. The **optimistic-then-revert + `notifyBackendError` pattern
does NOT apply** — this is a read-only RPC; errors already route to the in-section `reorderError`
pane (a deliberate non-toast carve-out, [db.ts:2703-2704](../../src/lib/db.ts)), unchanged.

**FE render work (frontend-developer), all in `ReorderSection.tsx` (display only — NO cost math):**

- Add a pure helper (top of the file, jest-targetable), e.g.
  `formatSuggested(item: ReorderItem): string` returning:
  - case item (`item.suggestedCases != null`): `` `${cases} ${cases === 1 ? 'case' : 'cases'} · ${formatQty(item.suggestedUnits)} ${item.unit}`.trim() `` → e.g. `3 cases · 72 each`, `1 case · 24 each`.
  - non-case item: `` `${formatQty(item.suggestedQty)} ${item.unit}`.trim() `` (today's exact output).
- **SUGGESTED column** (line ~333): replace `{formatQty(item.suggestedQty)} {item.unit}` with
  `{formatSuggested(item)}`.
- **`order:` sub-line** in `BreakdownLine` (line ~72): replace the trailing
  `{formatQty(item.suggestedQty)} {item.unit}` with the SAME `formatSuggested(item)` so the two
  never disagree (AC). Keep `on hand` / `inbound` / `par` segments in base unit (lines 65-69) —
  unchanged.
- **Est $** (per-row line ~336, per-vendor header line ~275, footer line ~360, KPI line ~779):
  **no code change** — they already read `item.estimatedCost` / `vendor.vendorTotalCost` /
  `kpis.totalEstimatedCost`, which are now server-rounded. (The per-vendor `total qty` rollup at
  line ~218/270 sums `i.suggestedQty` (raw base unit); leave it base-unit — it's a qty rollup, not
  the order figure, and the user scoped cases to the Suggested/Est$ surfaces. Flag for FE: if
  product wants this rollup in ordered-units, switch the reduce to `i.suggestedUnits` — but that's
  NOT in the ACs, so default to leaving it.)
- **CSV** `buildReorderCsv` (lines ~405-437): add `'Cases'` and `'Units Per Case'` to the
  `columns` array (placed right after `'Suggested Qty'`); per row emit
  `'Cases': item.suggestedCases ?? ''`, `'Units Per Case': item.caseQty > 1 ? item.caseQty : ''`,
  and set `'Suggested Qty': item.suggestedCases != null ? item.suggestedUnits : item.suggestedQty`.
  `'Est. Cost': item.estimatedCost.toFixed(2)` is unchanged (now server-rounded). Non-case rows:
  `Cases`/`Units Per Case` empty, `Suggested Qty` = raw — byte-for-byte same as today.
- **PDF** `handlePdfExport` (lines ~505-516): keep the 7-column head; change the `Suggested` body
  cell to `formatSuggestedPdf(item)` (e.g. case → `${cases} cs · ${formatQty(suggestedUnits)} ${unit}`,
  non-case → `${formatQty(suggestedQty)} ${unit}`). `Unit` column stays. `Est. Cost`
  (`$${item.estimatedCost.toFixed(2)}`) and footer (`payload.kpis.totalEstimatedCost`) read the
  server-rounded values — unchanged.

### 8. Risks and tradeoffs (explicit)

- **Behavior change in returned cost (intended).** `estimated_cost` / `vendor_total_cost` /
  `total_estimated_cost` rise to the case-rounded order for case items. This is the user's
  decision-3. **Mitigation:** pgTAP asserts non-case items (`case_qty` null/≤1) are byte-for-byte
  unchanged, so the blast radius is bounded to items that genuinely have a case size.
- **Migration ordering.** `20260602000000_…` sorts after `20260601000000_…` (the latest on disk).
  Triggers the `db-migrations-applied` drift gate — user runs `npx supabase db push --linked`
  post-merge (per spec §Dependencies). No CI auto-apply (manual-verification reality per
  CLAUDE.md). The `db-migrations-applied` workflow only READS prod migration state; it will hard-
  fail if this file isn't pushed to prod, which is the intended safety net.
- **`vendorTotalCost` is the single carrier.** The whole "KPI == sum of visible per-row Est $"
  guarantee rests on `vendor_total_cost = sum(per-item estimated_cost)` (server, line 493) and
  `computeReorderKpis` summing `vendorTotalCost` (FE, line 182). Because we round at the per-item
  `estimated_cost` source, both rollups inherit it and **cannot drift**. Risk would only
  re-appear if a future change recomputed cost on the FE — explicitly NOT done here (the reason
  Option B was chosen).
- **Floating rounding at the per-row grain.** Rounding cost per item (then summing) — not summing
  raw then rounding once — is the correct model here (each item is ordered by the case
  independently) and is what makes per-row Est $ sum exactly to the KPI. No half-cent surprise:
  `formatMoney` already rounds to 2dp for display; the underlying numeric sum is exact in
  Postgres `numeric`.
- **Performance on the 286 KB seed.** Negligible — `ceil`/`coalesce` are scalar ops on rows
  already materialized by `per_item`; no new join, no new scan (the `ci` join already exists).
- **Edge-function cold-start.** N/A (no edge function).
- **Non-case predicate edge (`case_qty` exactly 1, the default).** Most catalog rows default to
  `case_qty = 1`; the strict `> 1` predicate correctly treats them as base-unit (no "1 case · 1"
  noise). Verified this is the intended boundary (B).
- **Fractional `case_qty`.** Admitted by `> 1` (e.g. `6.5`); `ceil(suggested/6.5)` is well-defined.
  Not a documented use case, but not mishandled. Surfaced here in case product wants to constrain
  `case_qty` to integers in a future spec — out of scope now.

### 9. Test contract

- **jest (FE, `ReorderSection`/`formatSuggested` + CSV/PDF builders):**
  - cases·units breakdown: `suggested_cases=3, suggested_units=72, unit='each'` → `3 cases · 72 each`.
  - ceil exact-multiple: `suggested_qty=48, case_qty=24` → server `suggested_cases=2`,
    `suggested_units=48` → `2 cases · 48` (no spurious extra case).
  - ceil just-over: `suggested_qty=49, case_qty=24` → `suggested_cases=3`, `suggested_units=72` →
    `3 cases · 72`.
  - boundary: `suggested_qty=24, case_qty=24` → `1 case · 24` (singular copy, never `1 cases`).
  - Est $ rounded: assert per-row `estimatedCost` (as delivered by the server fixture) equals
    `suggested_cases × case_qty × cost_per_unit`; FE does not alter it.
  - no-case-size unchanged: `case_qty` null/`0`/`1` → SUGGESTED renders `suggestedQty unit`, no
    case wording, Est $ = `suggestedQty × costPerUnit`.
  - **EST. TOTAL == sum of visible per-row Est $:** build a `primary` set, assert
    `computeReorderKpis(primary).totalEstimatedCost` equals the sum of each visible
    `item.estimatedCost` across `primary` (including after a spec-087 day filter) — pins the
    invariant.
  - CSV/PDF: `Cases`/`Units Per Case` columns populated for case rows, empty for non-case;
    `Suggested Qty` = `suggestedUnits` for case rows; `Est. Cost` = rounded value.
- **pgTAP (the report changes — required):** new `supabase/tests/report_reorder_list_cases.test.sql`,
  mirroring the fixture shape of [report_reorder_list_hybrid_formula.test.sql](../../supabase/tests/report_reorder_list_hybrid_formula.test.sql)
  (insert own `catalog_ingredients` with `case_qty`, own `inventory_items`, no order_schedule →
  `days_until=7`, call the runner, read `vendors[].items[]`). Assertions:
  - case item: insert `catalog_ingredients.case_qty = 24`, drive `suggested_qty = 49` (e.g.
    `par_level=49, current_stock=0, usage_per_portion=0`); assert the item JSON's
    `suggested_cases = 3`, `suggested_units = 72`, `case_qty = 24`, and
    `estimated_cost = 72 × cost_per_unit` (with `cost_per_unit=1` → `72`).
  - exact-multiple case item: `case_qty=24`, `suggested_qty=48` → `suggested_cases=2`,
    `suggested_units=48`, `estimated_cost=48`.
  - **regression for null/≤1:** an item with `case_qty=1` (the default) → `suggested_cases` is
    JSON `null`, `case_qty=1`, and `estimated_cost = suggested_qty × cost_per_unit` (unchanged
    base-unit behavior). Optionally a second item with no explicit case_qty to cover the default.
  - `vendor_total_cost` equals the sum of the (rounded) per-item `estimated_cost` for the seeded
    vendor — pins the rollup inheritance.
  - **Grant/anon:** the grant is NOT touched (signature unchanged), so do **NOT** add a
    `has_function_privilege` assertion (only add one if a grant changes — it doesn't) and do
    **NOT** use `set role anon`. Use the `set local role authenticated` + `request.jwt.claims`
    master/manager pattern from the reference test.

### Files the developers will touch

- `supabase/migrations/20260602000000_reorder_suggested_cases.sql` (NEW — backend)
- `supabase/tests/report_reorder_list_cases.test.sql` (NEW — backend/test)
- `src/lib/db.ts` — `mapReorderVendor` (~line 2750) gains 3 fields (FE)
- `src/types/index.ts` — `ReorderItem` (~line 701) gains `caseQty` / `suggestedCases` /
  `suggestedUnits` (FE)
- `src/screens/cmd/sections/ReorderSection.tsx` — `formatSuggested` helper +
  SUGGESTED column + `BreakdownLine` `order:` line + CSV columns + PDF `Suggested` cell (FE)
- jest test file(s) for the FE display/CSV/PDF + KPI invariant (FE/test)

### Open question surfaced (non-blocking)

- The per-vendor `total qty` rollup (ReorderSection.tsx ~line 218/270) sums raw `suggestedQty`
  (base unit). The ACs scope cases to the SUGGESTED figure + Est $ only, so the design **leaves
  this rollup in base units**. If product later wants it in ordered-units, switch the reduce to
  `i.suggestedUnits` — flagged, not done. (Does NOT touch the `app.json` slug or any load-bearing
  identity.)

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec (Decision B — server rounds the cost, FE formats
  the cases·units display). Backend: author migration
  `supabase/migrations/20260602000000_reorder_suggested_cases.sql` (additive `create or replace`
  of `report_reorder_list`, same signature + grants; expose `case_qty` from the `ci` join,
  compute `suggested_cases`=ceil and the case-rounded `estimated_cost`, add `case_qty` /
  `suggested_cases` / `suggested_units` to the per-item JSON; `vendor_total_cost` +
  `kpis.total_estimated_cost` inherit the rounding) plus pgTAP
  `supabase/tests/report_reorder_list_cases.test.sql` (assert the new fields, the rounded cost,
  the vendor_total_cost rollup, and byte-for-byte regression for `case_qty` null/≤1; NO
  `set role anon`, NO grant assertion since the grant is untouched). Frontend: add `caseQty` /
  `suggestedCases` / `suggestedUnits` to `ReorderItem` + `mapReorderVendor`; add a pure
  `formatSuggested` helper and apply it to the SUGGESTED column + the `BreakdownLine` `order:`
  sub-line; add `Cases` / `Units Per Case` CSV columns and the PDF `Suggested`-cell formatting;
  do NOT recompute cost on the FE (it reads the server-rounded `estimatedCost` /
  `vendorTotalCost` / `kpis.totalEstimatedCost`). Add jest covering the cases·units rendering,
  ceil incl. exact-multiple + just-over, singular/plural, no-case-size-unchanged, and the
  EST. TOTAL == sum-of-visible-per-row-Est$ invariant after the spec-087 filter. After
  implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/088/spec.md

---

## Files changed (parallel build — backend-developer + frontend-developer)

Field-name contract confirmed in agreement: the report exposes `case_qty` / `suggested_cases` / `suggested_units`; the FE maps them to `caseQty` / `suggestedCases` / `suggestedUnits`.

**Backend (server-side cost rounding — Decision B) — backend-developer:**
- `supabase/migrations/20260602000000_reorder_suggested_cases.sql` (NEW) — additive `create or replace` of `report_reorder_list`; three hunks: add `coalesce(ci.case_qty,1)` from the existing `ci` join; `suggested_cases = case when case_qty > 1 then ceil(suggested_qty/case_qty) else null end`; `estimated_cost` case-rounded to the whole-case order (`ceil(suggested_qty/case_qty) × case_qty × cost_per_unit`) for case-size items, unchanged otherwise; expose `case_qty`/`suggested_cases`/`suggested_units` in the per-item JSON. `vendor_total_cost` + `kpis.total_estimated_cost` inherit the rounding (they sum `estimated_cost`). Signature byte-identical → grants preserved; no RLS/realtime change.
- `supabase/tests/report_reorder_list_cases.test.sql` (NEW) — 12 assertions (case item 49/24 → 3 cases + whole-case cost; exact-multiple 48/24 → 2; null/≤1 unchanged; rollup reflects rounding). No `set role anon`; no `has_function_privilege` arm (grant untouched).

**Frontend (display only — no FE cost math) — frontend-developer:**
- `src/types/index.ts` — `ReorderItem` gains `caseQty: number`, `suggestedCases: number | null`, `suggestedUnits: number`.
- `src/lib/db.ts` (`mapReorderVendor`) — maps the three new fields; `estimatedCost`/`vendorTotalCost` left server-authoritative (now case-rounded).
- `src/screens/cmd/sections/ReorderSection.tsx` — exported `formatSuggested` (`N cases · M unit`, singular `1 case`, plain `{qty} {unit}` for non-case) + `formatSuggestedPdf` (`N cs · M unit`); applied to the SUGGESTED column + the `order:` sub-line; `Cases` + `Units Per Case` CSV columns; PDF `Suggested`-cell formatting. ON HAND/INBOUND/PAR stay base unit. No cost recompute.
- `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx` (NEW, 17 tests) + `src/utils/reorderDayFilter.test.ts` (fixture type-completeness fix).

**Verification:** backend pgTAP 42/42 files from a clean `db reset` (new file 12/12); frontend jest 51 suites / 510 tests, base + test-graph typechecks exit 0, plus a real-RPC-payload drive-through (Towson/BJs "Dr Pepper" 72/36 → `2 cases · 72 each`, EST $38.16; non-case `8 gal` unchanged). Changes UNCOMMITTED. Migration applies to prod via `npx supabase db push --linked` post-merge.

# Spec 018: Reports — Variance Template (REPORTS-3)

Status: READY_FOR_REVIEW

> Third of three sequential specs building out the Reports runner.
> **REPORTS-1** (spec 016) landed the foundation. **REPORTS-2** (spec 017)
> shipped the COGS template (`report_run_cogs`, date-range picker on the
> modal + override chips on the detail frame, single-source-of-truth
> `templates.ts` flipped `cogs` to `'live'`). **REPORTS-3 (this spec)**
> does the same for Variance — it flips `variance` from `status: 'preview'`
> to `status: 'live'` by shipping `report_run_variance`, repurposes the
> modal's date-range field as a two-EOD-anchor picker, and adds the
> column / KPI / row mapping.
>
> Templates not addressed in REPORTS-1/2/3 (waste, vendor, velocity,
> custom) keep returning the `not_implemented` envelope until their own
> specs land.

## User story

As a 2AM PROJECT store manager, I want to open my saved Variance report,
pick two EOD-submission dates as anchors (e.g. "last Sunday" and "this
Sunday"), and see — for each ingredient I count — what the inventory
should have been at the second anchor vs. what was actually counted,
with a signed dollar impact across the period. That tells me whether
shrink, waste mis-logging, or recipe drift is eating my food cost,
without exporting to a spreadsheet.

As a brand admin viewing across stores, I want the same template to
honour `auth_can_see_store(p_store_id)` so a cross-store comparison only
surfaces stores the caller already had visibility into.

## Acceptance criteria

### Database

- [ ] New migration `supabase/migrations/20260512NNNNNN_report_run_variance.sql`
      (timestamp after `20260511120000_report_run_cogs.sql`): creates
      `public.report_run_variance(p_store_id uuid, p_params jsonb)
      returns jsonb` and updates `public.report_run` (the dispatcher)
      to add a `when 'variance' then return public.report_run_variance(p_store_id, p_params);`
      branch. The `'stub'` and `'cogs'` arms and the `not_implemented`
      fallback are preserved exactly as in
      `20260511120000_report_run_cogs.sql:694-726` so callers see no
      surface drift.
- [ ] `report_run_variance` matches the per-template RPC contract
      documented in `20260510120000_report_runs.sql:21-75`:
      - `language plpgsql`
      - `security invoker`
      - `set search_path = public`
      - First statement: `if not public.auth_can_see_store(p_store_id) then raise exception 'Not authorized for store %', p_store_id using errcode = '42501'; end if;`
      - `revoke execute on function public.report_run_variance(uuid, jsonb) from public, anon;`
      - `grant execute on function public.report_run_variance(uuid, jsonb) to authenticated;`
      - Returns the uniform envelope (`kpis`, `columns`, `rows`,
        `series`) — no `_status` / `_message` keys.
- [ ] **Params accepted (`p_params jsonb`)** — all optional, all
      defaulted by the RPC so a call with `'{}'::jsonb` succeeds with
      sensible defaults:
      - `from` — ISO date `YYYY-MM-DD` for the **prior anchor** (the
        earlier EOD-submission date the user is measuring from).
        Default: **the second-most-recent submitted EOD date for
        `p_store_id`** (computed in-RPC; see the EOD-anchor resolution
        CTE below).
      - `to` — ISO date `YYYY-MM-DD` for the **current anchor** (the
        later EOD-submission date the user is measuring to). Default:
        **the most-recent submitted EOD date for `p_store_id`**.
      - Unknown keys MUST be ignored (forward-compat).
      - Malformed `from`/`to` (non-ISO strings) raise
        `invalid_text_representation` natively — `db.runReport`
        surfaces this as the standard sanitized "Run failed — check
        server logs" message.
      - `from > to` raises
        `raise exception 'Variance report: from > to (% > %)', v_from, v_to using errcode = '22023';`
        so the frontend gets a structured error class consistent with COGS.
      - **`from == to`** (single anchor) raises
        `raise exception 'Variance report: from == to (%); variance needs two distinct EOD dates', v_from using errcode = '22023';`.
      - **EOD-anchor resolution.** Q1 RESOLUTION → ⟪RESOLVED: user
        accepted default⟫ **option B**: date-picker inputs, RPC raises
        an explicit error when either date does not match a row in
        `eod_submissions(store_id = p_store_id, date = X, status =
        'submitted')`. Error class `'P0002'` (`no_data_found`) so
        `db.runReport`'s error sanitizer can map it. Error message:
        `'Variance report: no submitted EOD for store on % (anchor: %)'`
        identifying which date and which anchor.
- [ ] **Joins** — the RPC builds:
      1. **Anchor counts.** `eod_entries.actual_remaining` from the
         submission whose `(store_id, date)` matches `v_from` / `v_to`
         respectively, joined to `inventory_items` to get
         `cost_per_unit` and `name`. The set of items considered is
         the **intersection** of items present at both anchors (an
         item counted at the prior but not the current — or vice
         versa — is excluded; reported in a separate count for
         transparency; see KPI #5 below). Q7 RESOLUTION → see Open
         questions; default in DRAFT: include all intersected items
         regardless of variance magnitude (zero-variance rows stay
         visible so the manager can confirm those items were
         reconciled).
      2. **Receiving between anchors.** `purchase_orders` rows where
         `purchase_orders.store_id = p_store_id` and
         `purchase_orders.received_at::date > v_from` and
         `purchase_orders.received_at::date <= v_to`. Join
         `po_items` on `po_id`; sum `po_items.received_qty` grouped
         by `po_items.item_id`. Rationale: an EOD count includes the
         day's receipts up to that point; so receipts AFTER the prior
         EOD count and AT OR BEFORE the current EOD count is the
         "received between anchors" window. Purchase orders with
         `received_at IS NULL` (un-received POs) are excluded.
         **NULL-safety:** receipts that landed at exactly `v_from`'s
         submission date but BEFORE the prior count's `submitted_at`
         timestamp are still excluded by the `> v_from` clause —
         acceptable approximation; same-day arrival edge cases are a
         documented caveat in the migration header.
      3. **Sales-derived depletion between anchors.** Same recursive
         CTE pattern as REPORTS-2 (see
         `20260511120000_report_run_cogs.sql:197-247`) to flatten
         recipes onto their catalog ingredients, then join
         `pos_imports` (filter:
         `store_id = p_store_id AND import_date > v_from AND import_date <= v_to`)
         to `pos_import_items` (filter: `recipe_id IS NOT NULL AND
         recipe_mapped = true`). For each `(recipe_id, catalog_id)`
         the depletion contribution is `qty_sold × qty_per_recipe`.
         Convert `catalog_id` to per-store `inventory_items.id` by
         joining `inventory_items` on `(catalog_id, store_id =
         p_store_id)`. Sum grouped by `inventory_items.id`.
         **Depth cap = 5** with cycle detection, identical to COGS
         (`20260511120000_report_run_cogs.sql:140-170`). A top-level
         recipe whose chain is truncated propagates a `truncated`
         flag the same way COGS does — flag rolls up through
         `bool_or` and drives:
         (a) a `' ⚠ (truncated)'` suffix on the row's `item` cell.
         (b) the `Recipe graph truncated` KPI when count > 0.
      4. **Waste between anchors.** `waste_log` rows where
         `store_id = p_store_id AND logged_at::date > v_from AND
         logged_at::date <= v_to`. Sum `quantity` grouped by `item_id`.
         Same date-window semantics as receiving. (Q5: this exists
         in the init schema — no schema work needed.)
- [ ] **Per-item variance formula.** Q4 RESOLUTION → ⟪RESOLVED: user
      accepted default⟫ **strict formula** —
      `expected = prior_count + receiving_between − sales_depletion_between − waste_between`
      and `variance = counted − expected`. Waste is folded into the
      expected term (not surfaced as a separate column). This keeps
      the headline single-number ("did we lose more than the system
      knows about?") and minimises columns.
- [ ] **Per-item dollar impact.** `dollar_impact = variance × cost_per_unit`
      where `cost_per_unit` comes from `inventory_items.cost_per_unit`
      for that store. Q6 RESOLUTION → ⟪RESOLVED: user accepted default⟫
      **partial credit + `' ⚠'` flag** (same as COGS). When
      `cost_per_unit IS NULL` or `= 0`:
      - The qty variance still computes normally (the user wants to
        see the count anomaly).
      - `dollar_impact` is treated as `0` in the per-row dollar value
        AND in the headline `Net $ impact` KPI sum.
      - The item's row gets a `' ⚠'` suffix on `item` (or
        `' ⚠ (truncated)'` if the truncated flag also fires — the
        truncated suffix wins).
      - A `Items missing cost` KPI surfaces the count (warn tone),
        hidden when count = 0.
- [ ] **Items present at only one anchor.** Items in `eod_entries` for
      `v_from` but not `v_to` (or vice versa) are EXCLUDED from the
      `rows` table. A separate KPI `Items not counted at both anchors`
      surfaces the count (warn tone, hidden when count = 0) so the
      manager knows the table is a subset. Rationale: variance on a
      one-anchor item is undefined; surfacing the count keeps the
      omission visible without polluting the table.
- [ ] **Output — KPIs** (in order, conditional ones append only when
      their count > 0). Q11 RESOLUTION → ⟪RESOLVED: user accepted
      default⟫ **two headline KPIs always present, three conditional**.
      The proposed `Shrink %` benchmark is excluded.
      1. `{ label: 'Net $ impact', value: '$<m>' (signed), tone }`
         where `m` is `Σ dollar_impact` formatted with two decimals
         and a thousands separator. Negative values prefixed with
         `'-'` (e.g. `'-$124.50'`). `tone`: `'danger'` when `m < 0`
         (shrink), `'ok'` when `m >= 0`.
      2. `{ label: 'Items with variance', value: <count>, tone: null }`
         where `count` is `count(*) where abs(variance) > 0`.
      3. *(Conditional)* `{ label: 'Items missing cost', value: <count>, tone: 'warn' }`
         when partial-credit policy chosen AND count > 0.
      4. *(Conditional)* `{ label: 'Recipe graph truncated', value: <count>, tone: 'warn' }`
         when count > 0.
      5. *(Conditional)* `{ label: 'Items not counted at both anchors', value: <count>, tone: 'warn' }`
         when count > 0.
- [ ] **Output — columns** (fixed; no `by:` toggle for variance — see
      Out of scope):
      ```
      [
        { key: 'item',          label: 'Item',     align: 'left'  },
        { key: 'expected',      label: 'Expected', align: 'right' },
        { key: 'counted',       label: 'Counted',  align: 'right' },
        { key: 'delta',         label: 'Δ',        align: 'right' },
        { key: 'dollar_impact', label: '$ impact', align: 'right' }
      ]
      ```
      Rows sorted by `abs(dollar_impact) desc` then `abs(delta) desc`
      (largest dollar drift first; for ties, largest qty drift wins).
- [ ] **Output — rows** are formatted server-side as strings to
      preserve decimal precision across JSON round-trips:
      - `item` → `inventory_items.name`, with the `' ⚠'` or
        `' ⚠ (truncated)'` suffix when the respective flag fires.
        The `' ⚠ (truncated)'` suffix takes precedence over `' ⚠'`
        when both apply (specific signal wins, same as COGS).
      - `expected`, `counted`, `delta` → numeric, formatted with
        `to_char(value, 'FM999,990.000')` (three decimals to match
        `eod_entries.actual_remaining numeric(10,3)`). Negative
        deltas render with a leading `'-'`.
      - `dollar_impact` → `'$' || to_char(value, 'FM999,990.00')`
        with a leading `'-'` for negative values.
- [ ] **Output — series** is **empty array `[]`** for REPORTS-3 (Q10:
      variance over a two-anchor window has no time series). NOT
      `null` — null is reserved for templates that genuinely don't
      chart (the variance template *could* chart in a future spec
      that adds rolling daily variance). The frame's chart panel
      auto-skips when `series.length < 2`.
- [ ] **Performance budget.** The RPC must return under 500 ms for
      the seed data set (`supabase/seed.sql`) at the default
      "most-recent two EODs" anchor pair. Verify with `explain
      analyze`. No new indexes are expected — the existing indexes
      already cover:
      - `eod_submissions_store_date_key` (UNIQUE on `(store_id,
        date)`).
      - `idx_purchase_orders_store_reference_date` (close to what we
        need; the date filter actually uses `received_at::date`, so
        verify the plan — if a partial index `(store_id,
        (received_at::date))` is wanted, add it in the same
        migration with `if not exists`).
      - `pos_imports (store_id, import_date)` — present from init.
      - `waste_log (store_id, logged_at)` — verify; if missing,
        adding `idx_waste_log_store_logged_at if not exists` is in
        scope for this migration.
- [ ] **Migration header comment.** Documents (a) Q4 formula, (b) Q6
      missing-cost policy, (c) Q5 waste-log inclusion, (d) the
      single-anchor exclusion + KPI surfacing, (e) the
      `received_at::date > v_from` vs `<= v_to` date-window choice
      and its same-day-receipt caveat, (f) the depth-5 truncation
      pattern shared with COGS, (g) Q8 default ("current
      `recipe_ingredients` snapshot, not as-of-anchor").

### `src/screens/cmd/sections/reports/templates.ts`

- [ ] Flip the `variance` row from `status: 'preview'` to
      `status: 'live'`. The `PREVIEW` badge auto-disappears from the
      catalog tile because `ReportsSection` derives the badge from
      `template.status`.
- [ ] No other rows change. The remaining four templates (`waste`,
      `vendor`, `velocity`, `custom`) stay `'preview'`.
- [ ] Optional: update the `cols` string from
      `'item · expected · counted · Δ · $impact'` to match the actual
      output table headers (`'item · expected · counted · Δ · $ impact'`
      — single space before `impact` for consistency with the column
      `label`). Pure cosmetic.

### `src/components/cmd/NewReportModal.tsx`

- [ ] When `picked === 'variance'`:
      - The date-range field's **preset chip strip is hidden** (`Last
        30d` / `This month` / etc. don't apply — variance picks two
        specific EOD dates, not a continuous range).
      - The two `from` / `to` inputs are **relabeled** to `'Prior EOD'`
        / `'Current EOD'`.
      - The default values are seeded from a new helper
        `db.fetchRecentEodDates(storeId, 2)` (see `src/lib/db.ts`
        below) returning the two most-recent submitted EOD dates for
        the current store. If `< 2` dates exist, the inputs default
        to empty strings and the modal surfaces an inline hint
        `'Submit at least two EODs to enable variance'` below the
        inputs. The CREATE button is NOT disabled — the user can
        still save a variance definition; pressing RUN against an
        unresolvable anchor will surface the RPC's `'P0002'` error
        via the standard toast. (Q1 default-resolution decision; see
        Open questions.)
      - The `by:` chip / toggle is **not rendered** when
        `picked === 'variance'` — variance has no by-mode.
- [ ] When `picked !== 'variance'` (i.e. `cogs` and future templates),
      behaviour is unchanged from REPORTS-2.
- [ ] The picked anchor pair is written into `params` on create:
      `params: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }`. The `range`
      key is NOT written when `picked === 'variance'` (range is a COGS
      concept). Q3 RESOLUTION → ⟪RESOLVED: user accepted default⟫
      **reuse the `from` / `to` keys** to keep the params schema flat
      and the detail frame's chip generic.

### `src/lib/db.ts`

- [ ] New helper `fetchRecentEodDates(storeId: string, limit: number = 2): Promise<string[]>`
      runs a small read against `eod_submissions` returning the most-
      recent `limit` submitted-EOD dates for `storeId`, sorted
      descending. Uses PostgREST's `.select('date').eq('store_id',
      storeId).eq('status', 'submitted').order('date', { ascending:
      false }).limit(limit)`. Falls back to `[]` on error. No
      camelCase mapping needed — return is `string[]` of ISO dates.
- [ ] No other `db.ts` changes. `runReport` already accepts a `params`
      arg; the dispatcher routing change is server-side only.

### `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`

- [ ] **No frame code changes.** The frame is template-agnostic by
      design (REPORTS-1's contract); the variance template's columns
      and KPIs already render through the existing
      `columns[]` / `rows[]` / `kpis[]` mappers.
- [ ] The existing `overrideRange` prop (a `{ range; from; to }`
      object — see `ReportDetailFrame.tsx:40`) is reused for variance.
      When the user clicks the `range:` chip on a variance report,
      the dropdown shows ONLY a "Custom dates" affordance with two
      date inputs labeled `'Prior EOD'` / `'Current EOD'` (no preset
      chips). The `range` field within the override object is hardcoded
      to `'custom'` when `templateId === 'variance'`. The `·`
      override indicator still works.
- [ ] The `by:` chip is **not rendered** for variance reports (gated
      on `templateId === 'variance'` in the frame's chip strip).
- [ ] The chart panel auto-skips for variance (series is empty) — no
      explicit branch needed; existing `series.length < 2` skip
      logic covers it.

### `src/screens/cmd/sections/ReportsSection.tsx`

- [ ] The override-state Map (`Map<definitionId, overrideRange>`) and
      its delete cleanup + foreign-tab reconcile, both shipped in
      REPORTS-2, are reused unchanged. The variance template's
      `from` / `to` override values just happen to mean "anchor
      dates" instead of "range endpoints".
- [ ] No other changes — the section's catalog-tile-press → modal
      flow and saved-report-tile → detail-view-flow are unchanged.

### `src/store/useStore.ts`

- [ ] **No store changes.** `runReport(definitionId, overrideParams?)`
      already forwards merged params to `db.runReport`; the
      dispatcher routes `'variance'` to the new RPC; the frame
      renders the result. The store is generic by design.

### Out of scope for REPORTS-3 (explicitly)

- **`by:` toggle for variance.** Variance is inherently per-item;
  category grouping (and `eod_entries` doesn't carry a category
  column anyway — it'd require a `recipes` / `inventory_items`
  category join that doesn't fit the per-item delta model) is not
  in scope. *Rationale: the user explicitly asked.*
- **Time-series chart for variance.** REPORTS-3 ships a single
  anchor-pair → single number per item. A "rolling daily variance
  over last 14 days" series is a much larger SQL build (would need
  the recursive CTE walked once per day in the window). Deferred to
  a future spec. *Rationale: the user explicitly asked.*
- **Waste / vendor / velocity / custom templates.** They keep
  returning the `not_implemented` envelope. *Rationale: per the
  three-part runner series plan; each needs its own joins.*
- **Snapshotting `recipe_ingredients` history.** REPORTS-3 uses the
  CURRENT `recipe_ingredients` to compute sales-depletion. If a
  recipe was edited mid-period (e.g. an ingredient added on day 5 of
  a 7-day variance window), the depletion calculation uses the
  post-edit recipe for the entire period. This is a documented
  caveat in the migration header. *Rationale: as-of-date
  snapshotting is its own big schema change (history table on
  `recipe_ingredients` + `prep_recipe_ingredients` + a
  point-in-time read pattern); the user accepted this as a
  documented caveat in their feature request.*
- **Custom SQL template.** Separate spec — needs the sandboxed-EXEC
  edge function that REPORTS-1's "Out of scope" deferred.
- **Run history list inside the detail view.** REPORTS-1 / REPORTS-2
  already punted this; REPORTS-3 keeps the latest-only display.
- **CSV / PDF export of the variance run.** Same deferral as
  REPORTS-2; PapaParse + jsPDF utilities make this trivial later
  but it's not blocking the user's stated complaint.
- **Snapshotting `inventory_items.current_stock` over time.**
  Variance is inherently delta-between-two-EOD-counts; a continuous
  `current_stock` history isn't part of this spec.
- **A "save chip-override back to definition" affordance.** The
  in-frame override on the prior/current EOD chips is in-memory only
  (same as COGS).
- **Saving a chip-override to `report_definitions.params`.** REPORTS-3
  inherits REPORTS-2's "override is in-memory only; the run's
  persisted `params` capture the override at run time, but the saved
  definition itself is untouched" semantics.

## Open questions resolved

These are decisions the user delegated to defaults under auto-mode.
Each is called out so the architect / user can flip them with one line
of feedback before READY_FOR_BUILD. **Q1, Q4, Q6, Q11 are the
load-bearing ones — the PM surfaced them via chat to the user before
locking the spec.**

- **Q1: EOD-anchor selection — date pickers vs dropdown of dated
  submissions vs snap-to-nearest?**
  → **A ⟪RESOLVED: user accepted default⟫: date-picker inputs; RPC
  raises `'P0002'` (`no_data_found`) with message
  `'Variance report: no submitted EOD for store on % (anchor: %)'`
  when either picked date has no matching `eod_submissions` row.**
  Lightest UI change (reuses the existing `from`/`to` inputs from
  REPORTS-2; just hides the preset chips and relabels). Most
  explicit failure mode (user knows which date was wrong). Trade-off
  against the dropdown-of-dates option: the dropdown forces a valid
  choice but adds a new `fetchRecentEodDates` UI surface beyond just
  the default-seed call.
- **Q2: Default anchor pair when the modal opens for a fresh variance
  report.**
  → **A: most-recent two submitted EOD dates for the current store.**
  Computed via `db.fetchRecentEodDates(storeId, 2)` at modal open.
  If `< 2` exist, the inputs default to empty and the modal surfaces
  the inline hint `'Submit at least two EODs to enable variance'`.
  Rationale: matches the user's stated intent ("variance between two
  EOD counts") and avoids the alternative defaults
  ("today vs. last full month's last EOD") which require more
  bookkeeping.
- **Q3: Modal UX — reuse `from`/`to` keys or introduce
  `anchor_from`/`anchor_to`?**
  → **A ⟪RESOLVED: user accepted default⟫: reuse `from`/`to`.** Keeps
  the params schema flat and the detail frame's chip dropdown
  generic. The frontend just relabels the inputs when
  `templateId === 'variance'`. Alternative is the clean-namespacing
  option `anchor_from`/`anchor_to`; rejected as default because
  variance is the only template that interprets the keys this way
  for now and the cost of distinct keys (modal switch on
  `templateId` in two more places, store action passthrough
  unchanged) outweighs the clarity.
- **Q4: Variance formula — strict `counted − (prior + receiving −
  sales − waste)` or waste-as-separate-column?**
  → **A ⟪RESOLVED: user accepted default⟫: strict formula** —
  `expected = prior_count + receiving − sales_depletion − waste` and
  `variance = counted − expected`. Single headline number, fewest
  columns. Trade-off against waste-as-column: the diagnostic view
  ("how much of the variance is just unlogged waste vs. real
  shrink?") is harder to read; we accept that for v1.
- **Q5: Waste-log integration.**
  → **A: include `waste_log` between anchors.** The init schema
  has `waste_log (store_id, item_id, quantity, logged_at, …)` so
  joining is a one-CTE addition. Filter:
  `store_id = p_store_id AND logged_at::date > v_from AND
  logged_at::date <= v_to`. (Q4's strict formula folds this into
  `expected`; waste-as-column would surface it separately.)
- **Q6: Missing-cost policy.**
  → **A ⟪RESOLVED: user accepted default⟫: partial credit + `' ⚠'`
  flag + `Items missing cost` KPI**, same as COGS. Reasoning: same
  consistency-with-REPORTS-2 argument; the qty variance is still
  diagnostic even when `cost_per_unit` is null. Trade-off against
  (b) skip-row-entirely: skipping hides count anomalies for ingredients
  whose cost wasn't entered. Trade-off against (c) render
  `dollar_impact` as `'—'`: a forced em-dash is harder to read in a
  signed-dollar column; sums get noisy.
- **Q7: Item filter — show all intersected items or only non-zero
  variance.**
  → **A (DEFAULT): include all intersected items, even when
  `delta = 0`.** Zero-variance rows confirm reconciliation rather
  than waste table space. The `Items with variance` KPI surfaces the
  non-zero count separately so the user can scan the headline.
  Alternative: filter to `abs(variance) > 0` to keep the table
  short. Architect's call; reviewers will flag if the table is
  routinely longer than ~50 rows in seed.
- **Q8: Recipe-snapshot semantics.**
  → **A: use current `recipe_ingredients` for the sales-depletion
  calc.** Snapshotting is its own much larger schema change
  (history tables on `recipe_ingredients` + `prep_recipe_ingredients`
  + a point-in-time read pattern). Migration header documents the
  caveat: a recipe edited mid-window applies its post-edit
  ingredients to the entire window.
- **Q9: Buffer / non-recipe items (napkins, bags).**
  → **A: included.** Items not in any recipe have sales-depletion
  of 0; the variance reads as `counted − (prior + receiving −
  waste)` which is exactly the unexplained-loss signal. No special
  casing in the RPC.
- **Q10: Series (variance over a window of anchor pairs).**
  → **A: drop the series for REPORTS-3.** Variance is inherently
  delta-between-two-dates; a single anchor pair = single number per
  item, not a time series. A future spec can add "rolling daily
  variance over last N days" (requires walking the recursive CTE
  once per day; non-trivial). The detail frame's chart panel
  auto-skips when `series.length < 2`.
- **Q11: Headline KPIs.**
  → **A ⟪RESOLVED: user accepted default⟫:**
  1. `Net $ impact` (signed, tone=`'danger'` when negative,
     `'ok'` when ≥ 0).
  2. `Items with variance` (count of rows with `abs(delta) > 0`,
     tone=null).
  3. `Items missing cost` — conditional, tone=`'warn'`.
  4. `Recipe graph truncated` — conditional, tone=`'warn'`.
  5. `Items not counted at both anchors` — conditional, tone=`'warn'`.
  **The proposed 5th `Shrink %` benchmark KPI (`abs(net_impact) /
  Σ(prior_count × cost_per_unit)`) is excluded per default.**

## Dependencies

- `public.report_run` dispatcher from
  `20260510120000_report_runs.sql:222-256`, re-created in
  `20260511120000_report_run_cogs.sql:694-726`. This spec re-creates
  it again to add the `'variance'` arm.
- `public.report_run_cogs` from `20260511120000_report_run_cogs.sql`
  — REPORTS-3 mirrors its recursive-CTE prep-flatten + missing-cost
  partial-credit + depth-cap-with-NOTICE patterns. Verbatim where
  possible. Migrations should not depend on COGS at SQL-level —
  variance has its own CTE — but the patterns are reused.
- `public.auth_can_see_store(uuid)` from
  `20260504173035_per_store_rls_hardening.sql:31`. Used as the first
  statement of `report_run_variance`.
- `public.eod_submissions` (init schema:118-126), `public.eod_entries`
  (init schema:128-135), `public.waste_log` (init schema:137-149),
  `public.purchase_orders` (init schema:151-164), `public.po_items`
  (init schema:166-173), `public.pos_imports` (init schema:175-183),
  `public.pos_import_items` (init schema:185-193). All exist; no
  schema changes needed.
- `public.recipe_ingredients` and `public.prep_recipe_ingredients`
  post-P3 lockdown — `catalog_id`-based joins. No changes; the
  recursive CTE is identical to COGS.
- `public.inventory_items.cost_per_unit` — same caveats as COGS
  (null/zero → partial-credit).
- Frontend: `src/screens/cmd/sections/reports/templates.ts` (one
  line flip), `src/components/cmd/NewReportModal.tsx` (the
  variance-mode gating), `src/lib/db.ts` (new
  `fetchRecentEodDates` helper), `src/screens/cmd/sections/reports/
  ReportDetailFrame.tsx` (variance-mode gating in the chip dropdown
  — but no new frame code beyond an `if templateId === 'variance'`
  branch).
- No new third-party libraries. No new edge functions.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. The legacy
  `src/screens/AdminScreens.tsx` is not touched.
- **Per-store or admin-global:** per-store. The RPC's first statement
  is `auth_can_see_store(p_store_id)`. Admins / super-admins see
  cross-store via the helper's existing short-circuit.
- **Realtime channels touched:** none. `report_runs` is still NOT a
  member of the realtime publication (REPORTS-1's "Out of scope"
  decision is upheld). The realtime publication gotcha
  (`docker restart supabase_realtime_imr-inventory`) does NOT
  apply to this migration.
- **Migrations needed:** yes — one new migration
  `20260512NNNNNN_report_run_variance.sql` that (a) creates
  `report_run_variance`, (b) re-creates `report_run` with the
  added `'variance'` arm. Optionally adds
  `idx_waste_log_store_logged_at if not exists` if the
  `explain analyze` shows the waste-log join needs it.
- **Edge functions touched:** none.
- **Web/native scope:** both. The modal gating, the relabeled
  inputs, and the chip dropdown all work via flex layout that
  degrades cleanly at narrow widths. No web-only API.
- **Tests:** no test framework yet. Acceptance criteria are
  testable manually via psql (the RPC under multiple scenarios:
  default anchors, missing-anchor errors, missing-cost items, deep
  prep chains, items at one anchor only) and via the browser
  preview (modal pre-fill, chip dropdown, override `·` indicator).
- **`app.json` slug:** untouched.
- **Files explicitly NOT modified:**
  `src/store/useSupabaseStore.ts`, `src/store/useJsonServerSync.ts`,
  `db.json`, `src/screens/AdminScreens.tsx`, the `npm run db`
  script. The store at `src/store/useStore.ts` is touched
  conceptually only — the existing `runReport` action and
  `reportRuns` slice are reused; **no code changes in the store**.

## Appendix A — Uniform output envelope reference (Variance)

```jsonc
{
  "kpis": [
    { "label": "Net $ impact",                    "value": "-$124.50", "tone": "danger" },
    { "label": "Items with variance",             "value": 17,         "tone": null     },
    { "label": "Items missing cost",              "value": 3,          "tone": "warn"   },
    { "label": "Items not counted at both anchors", "value": 2,        "tone": "warn"   }
  ],
  "columns": [
    { "key": "item",          "label": "Item",     "align": "left"  },
    { "key": "expected",      "label": "Expected", "align": "right" },
    { "key": "counted",       "label": "Counted",  "align": "right" },
    { "key": "delta",         "label": "Δ",        "align": "right" },
    { "key": "dollar_impact", "label": "$ impact", "align": "right" }
  ],
  "rows": [
    { "item": "Beef Patty",  "expected": "12.000", "counted": "10.500", "delta": "-1.500", "dollar_impact": "-$8.25" },
    { "item": "Salmon ⚠",    "expected": "8.000",  "counted": "7.000",  "delta": "-1.000", "dollar_impact": "$0.00"  },
    { "item": "Napkins",     "expected": "200.000","counted": "200.000","delta": "0.000",  "dollar_impact": "$0.00"  }
  ],
  "series": []
}
```

## Appendix B — Open data-window edge cases (for the architect)

The migration header should call these out:

1. **Same-day EOD + receipt at the prior anchor.** A PO whose
   `received_at` falls AT the prior anchor's date but BEFORE the
   prior EOD's `submitted_at` is excluded by the `> v_from` clause.
   Acceptable approximation; the receipt's units are already in the
   prior count and double-counting would be worse. Documented.
2. **Same-day EOD + waste log at the current anchor.** A waste row
   whose `logged_at` falls ON the current anchor's date but AFTER
   the current EOD's `submitted_at` is INCLUDED by the `<= v_to`
   clause but should arguably be excluded (the count didn't reflect
   the post-count waste). Mitigation: in practice waste logs are
   logged through the day so the date-only granularity is fine.
   Documented.
3. **A recipe edited mid-window.** Sales-depletion uses the
   current `recipe_ingredients`. Q8 default. Documented.
4. **A prep-recipe chain exceeding depth 5.** Same truncation +
   ` ⚠ (truncated)` suffix + KPI as COGS. Documented.
5. **An item counted at the prior but deleted from
   `inventory_items` before the current.** The cost-join falls
   away; in practice the EOD entry would have been removed too,
   but defensive: the row is excluded by the items-at-both-anchors
   intersection.
6. **`actual_remaining IS NULL`** in an `eod_entries` row. Excluded
   from the intersection (NULL means "wasn't counted"). Same
   handling as missing-from-the-submission.

## Appendix C — Pseudocode for the per-anchor CTE shape

```sql
-- (1) Anchor resolution: which submission rows correspond to v_from / v_to.
with anchors as (
  select
    'from' as anchor, id as submission_id, date
    from eod_submissions
   where store_id = p_store_id
     and date = v_from
     and status = 'submitted'
  union all
  select
    'to' as anchor, id as submission_id, date
    from eod_submissions
   where store_id = p_store_id
     and date = v_to
     and status = 'submitted'
),
-- Raise 'P0002' if either anchor is missing — checked in plpgsql
-- after counting rows.

-- (2) Counts at each anchor, restricted to non-null `actual_remaining`.
prior_counts as (
  select e.item_id, e.actual_remaining as qty
    from eod_entries e
    join anchors a on a.submission_id = e.submission_id and a.anchor = 'from'
   where e.actual_remaining is not null
),
current_counts as (
  select e.item_id, e.actual_remaining as qty
    from eod_entries e
    join anchors a on a.submission_id = e.submission_id and a.anchor = 'to'
   where e.actual_remaining is not null
),

-- (3) Receiving between anchors. po_items.item_id is inventory_items.id.
receiving as (
  select pi2.item_id, sum(coalesce(pi2.received_qty, 0))::numeric as qty
    from purchase_orders po
    join po_items pi2 on pi2.po_id = po.id
   where po.store_id = p_store_id
     and po.received_at is not null
     and po.received_at::date >  v_from
     and po.received_at::date <= v_to
   group by pi2.item_id
),

-- (4) Sales-derived depletion. Recursive prep-flatten (verbatim from
-- 20260511120000_report_run_cogs.sql:197-247) producing
-- (recipe_id, catalog_id, qty_per_recipe). Then:
sales_depletion as (
  select
    ii.id                                             as item_id,
    sum(pii.qty_sold::numeric * ari.qty)::numeric     as qty,
    bool_or(coalesce(rc.missing_cost, true))          as missing_cost,
    bool_or(tr.recipe_id is not null)                 as truncated
  from pos_imports pi
  join pos_import_items pii on pii.import_id = pi.id
  join all_ri ari            on ari.recipe_id = pii.recipe_id
  join inventory_items ii    on ii.catalog_id = ari.catalog_id
                            and ii.store_id   = p_store_id
  left join recipe_cost rc      on rc.recipe_id   = pii.recipe_id
  left join truncated_recipes tr on tr.recipe_id  = pii.recipe_id
  where pi.store_id     = p_store_id
    and pi.import_date >  v_from
    and pi.import_date <= v_to
    and pii.recipe_id is not null
    and pii.recipe_mapped = true
  group by ii.id
),

-- (5) Waste between anchors.
waste as (
  select item_id, sum(coalesce(quantity, 0))::numeric as qty
    from waste_log
   where store_id = p_store_id
     and logged_at::date >  v_from
     and logged_at::date <= v_to
   group by item_id
),

-- (6) The intersection + the per-item math.
joined as (
  select
    pc.item_id,
    pc.qty                                 as prior_qty,
    cc.qty                                 as counted_qty,
    coalesce(r.qty, 0)                     as receiving_qty,
    coalesce(sd.qty, 0)                    as sales_qty,
    coalesce(w.qty, 0)                     as waste_qty,
    pc.qty + coalesce(r.qty, 0)
           - coalesce(sd.qty, 0)
           - coalesce(w.qty, 0)            as expected_qty,
    cc.qty -
      (pc.qty + coalesce(r.qty, 0)
              - coalesce(sd.qty, 0)
              - coalesce(w.qty, 0))        as delta,
    coalesce(sd.missing_cost, false)
      or (ii.cost_per_unit is null
          or coalesce(ii.cost_per_unit, 0) = 0)  as missing_cost,
    coalesce(sd.truncated,    false)             as truncated,
    coalesce(ii.cost_per_unit, 0)::numeric       as cost_per_unit,
    ii.name                                       as item
  from prior_counts pc
  join current_counts cc on cc.item_id = pc.item_id
  join inventory_items ii on ii.id = pc.item_id and ii.store_id = p_store_id
  left join receiving r       on r.item_id = pc.item_id
  left join sales_depletion sd on sd.item_id = pc.item_id
  left join waste w            on w.item_id  = pc.item_id
)

-- (7) Then aggregate to the envelope shape — KPI totals over `joined`,
-- rows from `joined` formatted server-side, single-anchor count
-- computed as (prior_only ∪ current_only) elsewhere.
```

This is illustrative — the architect / dev will refine the exact CTE
structure and SARGable predicate placement during design. The shape is
faithful to the joins listed in AC.

## Backend Architecture

### Decisions vs. the spec's appendix C

Three small contract clarifications I'm making explicit before the
developer writes SQL. None overturn a Q-resolution; each is a SQL
mechanic the spec's pseudocode leaves underspecified.

1. **`pi.import_date` filter is plain date comparison, not `::date`.**
   `pos_imports.import_date` is already declared as `date` in init
   schema:181, so `pi.import_date > v_from AND pi.import_date <= v_to`
   matches the half-open semantics without a cast. Same shape COGS uses
   at `20260511120000_report_run_cogs.sql:297` (which is `between`, not
   `>/<=`, but that's the spec's intentional variance-window difference
   — see AC line 117-118).

2. **Receiving uses `purchase_orders.reference_date`, not
   `received_at::date`.** The spec body asks for `received_at::date`
   (a `timestamptz`-cast field) but:
   - `purchase_orders` has BOTH `received_at timestamptz` (init
     schema:161) AND `reference_date date` (`20260502071736_remote_schema.sql:149`).
   - `reference_date` is the user-facing "delivery date" the manager
     enters when receiving (used by `db.upsertPurchaseOrder` at
     `src/lib/db.ts:635-655`) — it's the calendar date the receipt
     "counts for," semantically aligned with EOD counts that are
     also `date`-typed.
   - The existing index `idx_purchase_orders_store_reference_date`
     on `(store_id, reference_date)` matches the filter shape exactly
     — no new index needed and the planner will use it. The
     `received_at::date` route is unindexed.
   - When `reference_date IS NULL` (legacy rows before the
     remote-schema migration backfilled it), fall back to
     `received_at::date`. The COALESCE keeps backwards-compat without
     a separate code path.
   - **Filter:**
     `coalesce(po.reference_date, po.received_at::date)`
     `> v_from AND <= v_to`, AND the existing-receipt gate
     `po.status = 'received' OR po.received_at IS NOT NULL`. The
     receipt gate excludes `draft`/`sent` POs whose `reference_date`
     was set ahead-of-time for a future delivery — those quantities
     are not yet in stock.

   This is the only intentional divergence from the spec's wording.
   The semantic is the same ("receipts that landed between the
   anchors"); the column choice tracks the rest of the codebase and
   uses the available index. Document in the migration header.

3. **One `with recursive` block, two materializations.** COGS walks
   the recursive prep CTE three times (once for headline totals, once
   for grouped rows, once for daily series — see
   `20260511120000_report_run_cogs.sql:197-247, 387-457, 601-672`).
   For variance the CTE is needed exactly once (sales_depletion per
   item; rows aggregate from `joined`; no series). So variance is
   simpler than COGS structurally — one big CTE block ending in two
   queries: one `SELECT INTO` for the headline scalars, one
   `jsonb_agg` for the rows. No section (10) equivalent.

### Migration plan

**Filename:** `supabase/migrations/20260512120000_report_run_variance.sql`
(timestamp after `20260511120000_report_run_cogs.sql`).

**Operations (additive only, no destructive changes):**

1. `create or replace function public.report_run_variance(uuid, jsonb) returns jsonb` — body detailed in §SQL skeleton below.
2. `revoke execute on function public.report_run_variance(uuid, jsonb) from public, anon;`
3. `grant execute on function public.report_run_variance(uuid, jsonb) to authenticated;`
4. `create or replace function public.report_run(text, uuid, jsonb)` — full re-creation of the dispatcher (Postgres can't edit a CASE in place) with the new `when 'variance' then return public.report_run_variance(p_store_id, p_params);` arm added. `'stub'`, `'cogs'`, and the `not_implemented` fallback are preserved verbatim from `20260511120000_report_run_cogs.sql:694-726`.
5. `revoke / grant` re-applied to `public.report_run` (idempotent; `create or replace` doesn't reset grants on the function, but the pattern at `20260511120000_report_run_cogs.sql:728-729` is what we're matching).
6. **No new indexes.** See §Performance below for the analysis. If post-deploy `explain analyze` shows a sequential scan on `waste_log` or `pos_imports`, the indexes are added in a follow-up migration — not this one. Reason: the spec authorized the index addition only conditionally, and adding indexes "just in case" against a 286 KB seed inflates the migration footprint.

**Rollout safety.** Pure additive — new function + dispatcher swap. The dispatcher swap is `create or replace`, which is non-destructive (existing grants survive; outstanding RPC calls in flight succeed against whichever version they bound at parse time). No data migration. No table-level locks. Estimated downtime: 0 ms.

**Realtime.** No publication change. `report_runs` is intentionally NOT in `supabase_realtime` (REPORTS-1 decision; the spec's "Project-specific notes" upholds it). The realtime publication gotcha (`docker restart supabase_realtime_imr-inventory`) does NOT apply.

### SQL skeleton (function body)

This is the structural plan for `report_run_variance` — the developer's job is to fill in the body that produces a correct JSON envelope. The shapes that MUST be present:

```
create or replace function public.report_run_variance(
  p_store_id uuid,
  p_params   jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_from                    date;
  v_to                      date;
  v_default_anchors         date[];  -- holds the most-recent 2 EOD dates
  v_from_submission_id      uuid;
  v_to_submission_id        uuid;
  v_net_dollar              numeric;
  v_items_with_variance     bigint;
  v_missing_cost_count      bigint;
  v_truncated_recipe_count  bigint;
  v_single_anchor_count     bigint;
  v_kpis                    jsonb;
  v_columns                 jsonb;
  v_rows                    jsonb;
begin
  -- (1) AUTH GATE — first statement; mirrors COGS line 102-105.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) DEFAULT ANCHOR RESOLUTION — Q2 default.
  -- When either of from/to is missing (or both), default to the
  -- most-recent two submitted EOD dates for this store. The CTE
  -- returns 0/1/2 dates; we error before the next gate if the count
  -- is short of what was needed.
  select coalesce(
           array_agg(date order by date desc),
           array[]::date[]
         )
    into v_default_anchors
    from (
      select date
        from public.eod_submissions
       where store_id = p_store_id
         and status = 'submitted'
       order by date desc
       limit 2
    ) recent;

  -- (3) PARAM COERCION. Malformed `from`/`to` strings raise 22007/22008
  -- natively; the frontend's runReport sanitizer surfaces them. Unknown
  -- keys are ignored (forward-compat).
  v_to := coalesce(
    nullif(p_params->>'to', '')::date,
    case when array_length(v_default_anchors, 1) >= 1
         then v_default_anchors[1]
         else null end
  );
  v_from := coalesce(
    nullif(p_params->>'from', '')::date,
    case when array_length(v_default_anchors, 1) >= 2
         then v_default_anchors[2]
         else null end
  );

  -- (4) "NEED TWO ANCHORS" GATE. If the user passed no params AND
  -- the store has < 2 submitted EODs, surface the structured P0001
  -- specified in the prompt (the modal already shows the
  -- "Submit at least two EODs..." hint pre-emptively, but a hand-
  -- crafted PostgREST call could still get here with empty params).
  -- Per the spec's AC line 211-212, frontend treats this as an
  -- ordinary error toast.
  if v_from is null or v_to is null then
    raise exception
      'Variance report: not enough EOD history (need at least two submitted EODs for store %)',
      p_store_id
      using errcode = 'P0001';
  end if;

  -- (5) RANGE VALIDATION. Spec AC line 73-76: strict from < to (== is
  -- also rejected for variance specifically — single anchor is a
  -- 22023 because the math is undefined).
  if v_from > v_to then
    raise exception 'Variance report: from > to (% > %)', v_from, v_to
      using errcode = '22023';
  end if;
  if v_from = v_to then
    raise exception
      'Variance report: from == to (%); variance needs two distinct EOD dates',
      v_from
      using errcode = '22023';
  end if;

  -- (6) ANCHOR-EXISTENCE CHECK (Q1: P0002 with explicit which-date).
  -- Look up submission_ids; raise the specific P0002 if either anchor
  -- has no submitted EOD for this store.
  select id into v_from_submission_id
    from public.eod_submissions
   where store_id = p_store_id and date = v_from and status = 'submitted';
  if v_from_submission_id is null then
    raise exception
      'Variance report: no submitted EOD for store on % (anchor: from)', v_from
      using errcode = 'P0002';
  end if;

  select id into v_to_submission_id
    from public.eod_submissions
   where store_id = p_store_id and date = v_to and status = 'submitted';
  if v_to_submission_id is null then
    raise exception
      'Variance report: no submitted EOD for store on % (anchor: to)', v_to
      using errcode = 'P0002';
  end if;

  -- (7) FIXED COLUMN HEADER. Built up-front so the empty-result branch
  -- doesn't have to know the shape. Variance has no `by:` toggle, so
  -- there's only one column set.
  v_columns := jsonb_build_array(
    jsonb_build_object('key','item',          'label','Item',     'align','left'),
    jsonb_build_object('key','expected',      'label','Expected', 'align','right'),
    jsonb_build_object('key','counted',       'label','Counted',  'align','right'),
    jsonb_build_object('key','delta',         'label','Δ',        'align','right'),
    jsonb_build_object('key','dollar_impact', 'label','$ impact', 'align','right')
  );

  -- (8) DEPTH-CAP PRE-WALK (truncation count). Mirror COGS lines
  -- 140-170 verbatim. Output: v_truncated_recipe_count. Independent
  -- of the main aggregation, so the count is decided once.
  with recursive _walk as (
    select rpi.recipe_id, rpi.prep_recipe_id, pri.sub_recipe_id,
           array[rpi.prep_recipe_id] as visited, 1 as depth
      from public.recipe_prep_items rpi
      join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rpi.prep_recipe_id
     where pri.sub_recipe_id is not null
    union all
    select w.recipe_id, w.prep_recipe_id, pri.sub_recipe_id,
           w.visited || w.sub_recipe_id, w.depth + 1
      from _walk w
      join public.prep_recipe_ingredients pri on pri.prep_recipe_id = w.sub_recipe_id
     where w.sub_recipe_id is not null
       and not (w.sub_recipe_id = any (w.visited))
       and w.depth < 5
  )
  select count(distinct recipe_id) into v_truncated_recipe_count
    from _walk
   where depth = 5 and sub_recipe_id is not null
     and not (sub_recipe_id = any (visited));

  if v_truncated_recipe_count > 0 then
    raise notice 'Variance report: prep-recipe chain exceeds depth 5 (% recipe(s) truncated)',
      v_truncated_recipe_count;
  end if;

  -- (9) MAIN AGGREGATION CTE. One materialization; both the
  -- headline-totals SELECT INTO and the rows jsonb_agg run off it
  -- via a temp table (the cleanest way to share a CTE block across
  -- two statements in plpgsql).
  --
  -- Implementation note for the developer: plpgsql can't share a
  -- `with` CTE across two separate SELECTs. Two clean options:
  --   (a) build `joined` into a CTE that the same single SELECT
  --       returns BOTH the scalar totals AND the jsonb rows by
  --       wrapping the row aggregation as a sub-SELECT alongside
  --       the totals (returning a single tuple).
  --   (b) materialize `joined` into a `create temp table` and then
  --       run two queries against it.
  -- COGS uses (a)-style with two separate `with recursive` blocks
  -- per call (one per statement, paying the plan cost twice).
  -- Variance only needs the CTE once for the row-level math —
  -- recommend (b) here to avoid a double-walk of the recursive
  -- prep CTE. The temp table is dropped on commit, no cleanup
  -- needed inside the function.
  create temp table if not exists _variance_joined
    (LIKE (
       select
         null::uuid    as item_id,
         null::text    as item_name,
         null::numeric as prior_qty,
         null::numeric as counted_qty,
         null::numeric as receiving_qty,
         null::numeric as sales_qty,
         null::numeric as waste_qty,
         null::numeric as expected_qty,
         null::numeric as delta,
         null::numeric as dollar_impact,
         null::boolean as missing_cost,
         null::boolean as truncated
     ) INCLUDING ALL)
    on commit drop;
  -- ^^ pseudocode; the developer will write the real DDL or just
  -- use a CTE-with-two-SELECTs-on-the-same-tuple approach. Either
  -- works. The shape below is the data the table/CTE must hold.

  -- 9a. Anchor counts (intersection at the eod_entries level).
  --     `where actual_remaining IS NOT NULL` excludes "not counted"
  --     entries per Appendix B item 6.
  -- 9b. Receiving — see decision #2 above (reference_date COALESCE).
  -- 9c. Sales depletion via the recursive prep CTE, identical
  --     structure to COGS lines 197-247 but ending at
  --     `inventory_items.id` (via catalog_id → store_id) instead of
  --     at recipe_id. Carry `missing_cost` and `truncated` flags via
  --     `bool_or`.
  -- 9d. Waste — straight sum over the half-open window.
  -- 9e. INTERSECTION join: INNER JOIN prior_counts ↔ current_counts
  --     on item_id (drops one-anchor items per AC line 158-164),
  --     then LEFT JOIN receiving / sales_depletion / waste.
  -- 9f. Compute expected_qty, delta, dollar_impact per row.
  --     missing_cost rolls up from sales_depletion's bool_or OR
  --     `inventory_items.cost_per_unit IS NULL OR = 0`. When
  --     missing_cost is true, force dollar_impact to 0 per Q6.
  -- 9g. JOIN inventory_items to catalog_ingredients for `item_name`
  --     (inventory_items.name was dropped in P3 lockdown line 59 —
  --     names live on catalog_ingredients).

  -- (10) HEADLINE TOTALS.
  select
    coalesce(sum(dollar_impact), 0)::numeric,
    count(*) filter (where abs(delta) > 0)::bigint,
    count(*) filter (where missing_cost)::bigint
  into
    v_net_dollar,
    v_items_with_variance,
    v_missing_cost_count
  from _variance_joined;

  -- (11) SINGLE-ANCHOR COUNT KPI. Items in prior_counts XOR
  --      current_counts. Cheap independent CTE — runs once.
  with
    prior_only as (
      select e.item_id
        from public.eod_entries e
       where e.submission_id = v_from_submission_id
         and e.actual_remaining is not null
      except
      select e.item_id
        from public.eod_entries e
       where e.submission_id = v_to_submission_id
         and e.actual_remaining is not null
    ),
    current_only as (
      select e.item_id
        from public.eod_entries e
       where e.submission_id = v_to_submission_id
         and e.actual_remaining is not null
      except
      select e.item_id
        from public.eod_entries e
       where e.submission_id = v_from_submission_id
         and e.actual_remaining is not null
    )
  select (select count(*) from prior_only) + (select count(*) from current_only)
    into v_single_anchor_count;

  -- (12) KPI COMPOSITION. Two headlines always; 3 conditional.
  v_kpis := jsonb_build_array(
    jsonb_build_object(
      'label', 'Net $ impact',
      'value', case
                 when v_net_dollar < 0 then '-$' || to_char(abs(v_net_dollar), 'FM999,999,990.00')
                 else                       '$' || to_char(v_net_dollar,      'FM999,999,990.00')
               end,
      'tone',  case when v_net_dollar < 0 then 'danger' else 'ok' end
    ),
    jsonb_build_object(
      'label', 'Items with variance',
      'value', v_items_with_variance,
      'tone',  null
    )
  );
  if v_missing_cost_count > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object('label','Items missing cost',
                         'value', v_missing_cost_count, 'tone','warn')
    );
  end if;
  if v_truncated_recipe_count > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object('label','Recipe graph truncated',
                         'value', v_truncated_recipe_count, 'tone','warn')
    );
  end if;
  if v_single_anchor_count > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object('label','Items not counted at both anchors',
                         'value', v_single_anchor_count, 'tone','warn')
    );
  end if;

  -- (13) ROWS — server-side formatted strings; sorted abs($) desc,
  --       then abs(delta) desc. The Q7 default keeps zero-variance
  --       rows visible.
  --
  -- Item-name suffix selection: truncated > missing_cost > none.
  -- Negative deltas / dollars render with a leading '-' (the
  -- to_char fill-mode 'FM' suppresses leading zeros + spaces; we
  -- prepend the sign manually so a $0.00 row reads cleanly).
  select coalesce(jsonb_agg(row_obj order by abs_dollar desc, abs_delta desc), '[]'::jsonb)
    into v_rows
    from (
      select
        jsonb_build_object(
          'item', item_name || case
                                 when truncated    then ' ⚠ (truncated)'
                                 when missing_cost then ' ⚠'
                                 else '' end,
          'expected', to_char(expected_qty, 'FM999,990.000'),
          'counted',  to_char(counted_qty,  'FM999,990.000'),
          'delta',    case when delta < 0
                           then '-' || to_char(abs(delta), 'FM999,990.000')
                           else        to_char(delta,      'FM999,990.000') end,
          'dollar_impact', case
            when missing_cost then '$0.00'
            when dollar_impact < 0 then '-$' || to_char(abs(dollar_impact), 'FM999,990.00')
            else                        '$' || to_char(dollar_impact,      'FM999,990.00')
          end
        ) as row_obj,
        abs(dollar_impact) as abs_dollar,
        abs(delta)         as abs_delta
      from _variance_joined
    ) ordered;

  -- (14) FINAL ENVELOPE. `series` is always empty per Q10.
  return jsonb_build_object(
    'kpis',    v_kpis,
    'columns', v_columns,
    'rows',    v_rows,
    'series',  '[]'::jsonb
  );
end;
$$;

revoke execute on function public.report_run_variance(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_variance(uuid, jsonb) to authenticated;
```

**Dispatcher re-creation** (replacing the existing one from
`20260511120000_report_run_cogs.sql:694-726`):

```
create or replace function public.report_run(
  p_template_id text,
  p_store_id    uuid,
  p_params      jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;
  case p_template_id
    when 'stub' then
      return public.report_run_stub(p_store_id, p_params);
    when 'cogs' then
      return public.report_run_cogs(p_store_id, p_params);
    when 'variance' then
      return public.report_run_variance(p_store_id, p_params);
    else
      return jsonb_build_object(
        'kpis', '[]'::jsonb, 'columns', '[]'::jsonb,
        'rows', '[]'::jsonb, 'series', null,
        '_status',  'not_implemented',
        '_message', 'Runner coming soon · definition saved'
      );
  end case;
end;
$$;

revoke execute on function public.report_run(text, uuid, jsonb) from public, anon;
grant  execute on function public.report_run(text, uuid, jsonb) to authenticated;
```

### Edge cases & decisions in the SQL

| # | Case | Behavior |
|---|------|----------|
| 1 | `from > to` | `22023` raise, "from > to" |
| 2 | `from == to` | `22023` raise, "needs two distinct EOD dates" |
| 3 | Either anchor has no submitted EOD | `P0002` raise, "no submitted EOD for store on % (anchor: from|to)" |
| 4 | Fewer than 2 EODs exist AND no params passed | `P0001` raise, "not enough EOD history" |
| 5 | Item present at prior but not current (or vice versa) | EXCLUDED from `rows`; counted toward `Items not counted at both anchors` KPI (per AC line 158-164) |
| 6 | `eod_entries.actual_remaining IS NULL` | Treated as "not counted" — excluded from anchor's set, just like #5 |
| 7 | `cost_per_unit IS NULL` OR `= 0` | qty math runs normally; `dollar_impact` forced to 0; row gets `' ⚠'` suffix; counted toward `Items missing cost` KPI |
| 8 | Prep-recipe chain > depth 5 | `bool_or(truncated)` rolls up; row gets `' ⚠ (truncated)'` suffix (precedence over `' ⚠'`); counted toward `Recipe graph truncated` KPI; `RAISE NOTICE` logs the count |
| 9 | Receipt at exactly `v_from` date but before EOD `submitted_at` | EXCLUDED by `reference_date > v_from`. Acceptable approximation; the receipt's units are already in the prior count. Documented in migration header. |
| 10 | Waste log at exactly `v_to` date but after EOD `submitted_at` | INCLUDED by `logged_at::date <= v_to`. Slight over-counting; documented. |
| 11 | Recipe edited mid-window | Uses CURRENT `recipe_ingredients` (Q8 default). Documented. |
| 12 | `pos_imports.import_date` exactly equals `v_from` | EXCLUDED (`> v_from`). The prior count happened at end-of-day; a same-day import is conceptually "after the count." Symmetric with the receiving treatment. |
| 13 | `pos_imports.import_date` exactly equals `v_to` | INCLUDED (`<= v_to`). |
| 14 | `pos_import_items.recipe_id IS NULL` or `recipe_mapped = false` | EXCLUDED (same as COGS) — unmapped POS rows contribute zero depletion. Variance over-counts shrink for unmapped recipes; surface as a documented caveat. |
| 15 | `purchase_orders.status` is `'draft'` or `'sent'` (not received) | EXCLUDED (`status = 'received' OR received_at IS NOT NULL`). Pre-receipt POs don't contribute units. |
| 16 | `waste_log.cost_per_unit` differs from current `inventory_items.cost_per_unit` | Per the spec prompt note, `waste_log.cost_per_unit` is informational (the snapshot at log time). For variance, the *dollar impact* of the variance uses the CURRENT `inventory_items.cost_per_unit` because variance measures "what is this missing inventory worth now?" — the qty of waste is what feeds `expected`, not its dollar value. So `waste_log.cost_per_unit` is unused by this RPC; the waste subtotal contributes to the quantity equation only. |

### Performance

Seed at `supabase/seed.sql` is 286 KB; for a typical store this works out to:
- ~10-50 inventory_items rows per store (one per catalog ingredient in use).
- ~30-100 eod_submissions per store-year.
- ~50-300 pos_imports per store-month.
- ~20-100 purchase_orders per store-month.
- ~5-50 waste_log per store-week.
- ~50-150 active recipes brand-wide; ~5-30 prep_recipes.

For the default anchor pair (two most recent EODs, usually 1-7 days apart) the windowed joins touch O(100) POS rows, O(10) PO rows, O(20) waste rows, and the recursive CTE walks O(150) recipes at depth ≤ 3 typically.

**Expected runtime: < 100 ms on local seed. Spec's 500 ms budget is comfortable.**

**Existing indexes that benefit:**
- `eod_submissions_store_date_key` UNIQUE on `(store_id, date)` — anchor lookups in section (6) hit this directly.
- `idx_purchase_orders_store_reference_date` on `(store_id, reference_date)` — the receiving subquery's `WHERE store_id = $1 AND reference_date > $2 AND reference_date <= $3` lights this up.
- No POS / waste indexes today.

**Indexes I'm NOT adding in this migration, but flagging for follow-up:**

1. `pos_imports(store_id, import_date)` — currently no index. Spec AC line 225 incorrectly asserts "present from init"; verified absent in the migration grep. For variance on a 7-day window over a 50-imports/month store, a seq scan is ~50 rows: fine for now. But for COGS over a 90-day window (~150 rows), seq is still fine, but at brand-scale (5+ stores × 150 rows = 750), an index would matter. Recommend the `backend-developer` `explain analyze` the default-anchor case during dev and add the index in a follow-up if seq scan reaches the planner output.

2. `waste_log(store_id, logged_at)` — currently no index. Same story: small per-store volumes today, but worth adding. **Recommend adding to this migration** since the cost is zero and the spec authorizes "adding `idx_waste_log_store_logged_at if not exists` is in scope" (AC line 227-228). Adding:

   ```sql
   create index if not exists idx_waste_log_store_logged_at
     on public.waste_log (store_id, logged_at);
   ```

3. `po_items(po_id)` — Postgres doesn't auto-index FK columns. For variance the receiving subquery does `purchase_orders po → po_items pi2 on pi2.po_id = po.id`; the planner will use a hash join + seq scan on po_items. At seed scale (O(500) rows total) this is fine. Defer.

4. `eod_entries(submission_id)` — same: no auto-index on FK. Anchor lookups in (9a) are bounded by the submission_id constraint, so the seq scan over `eod_entries` is < 100 rows per submission. Defer.

**Migration-time recommendation:** add only #2. The rest are deferred to a follow-up if `explain analyze` warrants it post-deploy. This keeps the migration scope tight and matches the spec's "no new indexes are expected" intent.

### `src/lib/db.ts` surface

**New helper:**

```ts
/**
 * Spec 018 (REPORTS-3) — most-recent `limit` submitted EOD dates for
 * `storeId`, descending. Used by NewReportModal to seed the
 * `Prior EOD` / `Current EOD` inputs when picking the variance
 * template. Returns `string[]` of ISO dates (YYYY-MM-DD); `[]` on
 * error or empty. No camelCase mapping needed.
 */
export async function fetchRecentEodDates(
  storeId: string,
  limit: number = 2,
): Promise<string[]>
```

Implementation shape (for the developer):

```ts
const { data, error } = await supabase
  .from('eod_submissions')
  .select('date')
  .eq('store_id', storeId)
  .eq('status', 'submitted')
  .order('date', { ascending: false })
  .limit(limit);
if (error) { console.warn('[Supabase] fetchRecentEodDates:', error.message); return []; }
return (data || []).map((r: any) => r.date);
```

RLS gates the query: `eod_submissions` is per-store; `auth_can_see_store(store_id)` is enforced by the existing per-store policy in `20260504173035_per_store_rls_hardening.sql`.

**No other `db.ts` changes.** `runReport` already accepts `params` and routes by `templateId` — the dispatcher's variance arm is invisible to it. The override-merge path (`db.ts:1672-1674`) already handles `from`/`to` correctly since variance reuses those keys per Q3.

### Edge function changes

**None.** All variance work is plpgsql; no Deno edge function is involved. No `verify_jwt` setting to change. No service-token validation strategy needed.

### RLS impact

**No new tables.** Variance reads from existing per-store tables that already enforce `auth_can_see_store()` at the policy level. The RPC's `security invoker` setting + the first-statement auth gate + the inner table RLS layers all stack consistently. No policy changes needed.

The only RLS-adjacent surface: the new `fetchRecentEodDates` helper queries `eod_submissions`. Per `20260504173035_per_store_rls_hardening.sql:46-61`, that table is read-gated by `auth_can_see_store(store_id)`, so the helper just inherits that protection.

### Realtime impact

**None.** `report_runs` is intentionally NOT in `supabase_realtime` publication (REPORTS-1 decision; the spec's AC line 520-523 upholds it). The variance RPC writes to `report_runs` (via the two-step client INSERT) the same way COGS does — no publication membership change, no realtime channel touched.

**Publication-gotcha note:** N/A here. The realtime gotcha (`docker restart supabase_realtime_imr-inventory`) only fires when `supabase_realtime` publication membership changes. This migration touches no `alter publication` statement.

### Frontend store impact

**No `useStore.ts` changes.** Per AC lines 324-329 the existing `runReport(definitionId, overrideParams?)` action already merges overrideParams onto `def.params` and forwards to `db.runReport`. Variance reuses the `from`/`to` keys, so the merge path is identical to COGS.

The optimistic-then-revert pattern (`useStore.ts:1851-1913`) does apply: pressing RUN writes a pending row to `reportRuns[definitionId]`, the RPC resolves to `'ok'` (envelope with rows) or `'error'` (sanitized message + `'Run failed — check server logs'` for non-auth errors). `notifyBackendError` fires on insert-side throws only — RPC-level errors get persisted as `status: 'error'` rows in `report_runs` and displayed via `ReportDetailFrame`'s `ErrorPanel`.

The `P0001` / `P0002` raises will surface in the frontend as:
- `'Variance report: no submitted EOD for store on ...'` — the `Not authorized` short-circuit in `db.runReport:1692` doesn't apply (the prefix is different), so the message goes through the sanitizer and renders as `'Run failed — check server logs'`. **This matches the spec's AC line 70-72** — the modal's hint is the user-facing affordance for "pick valid dates"; the toast is the fallback for the racing-PostgREST case.

If the user team wants a friendlier P0002 message, that's a follow-up spec for the sanitizer (add a `Variance report:` prefix allowlist).

### Frontend column mapping (for the frontend-developer)

The RPC's envelope is template-agnostic, so the existing `ReportDetailFrame` renders variance with **zero new frame code**. The only frontend changes are the modal-gating + chip-popover variance branches the spec calls out (AC lines 237-310).

For reference, the column → table cell mapping the frame uses automatically:

| Column key | Header label | Align | Rendered as |
|---|---|---|---|
| `item` | `Item` | `left` | `inventory_items.name` from `catalog_ingredients.name`, with `' ⚠'` or `' ⚠ (truncated)'` suffix as applicable |
| `expected` | `Expected` | `right` | `to_char(value, 'FM999,990.000')` — three decimals, no leading zeros |
| `counted` | `Counted` | `right` | Same format as `expected` |
| `delta` | `Δ` | `right` | Same format, with manual `'-'` prefix for negatives |
| `dollar_impact` | `$ impact` | `right` | `'$' || to_char(value, 'FM999,990.00')` or `'-$...'` for negatives; forced to `'$0.00'` when `missing_cost` |

KPI rendering order (the frame iterates `output.kpis` in order):
1. `Net $ impact` — always present; tone=`'danger'`/`'ok'` per sign.
2. `Items with variance` — always present; tone=null.
3. `Items missing cost` — conditional (count > 0); tone=`'warn'`.
4. `Recipe graph truncated` — conditional; tone=`'warn'`.
5. `Items not counted at both anchors` — conditional; tone=`'warn'`.

**Series:** `[]`. The frame's `series.length < 2` guard at
`ReportDetailFrame.tsx:788` skips the chart panel automatically. No
branch needed in the frame.

**`by:` chip:** the spec asks the frame to hide it for variance reports
(AC line 308-309). Per Q3's reuse-of-from/to-keys decision, this is the
ONLY place in the frame where `templateId === 'variance'` needs a
branch. The simplest implementation is in `ReportsSection.tsx:244-247`:
gate `overrideBy` and `onByChange` on `selectedTemplate?.id !==
'variance'` AND `selectedIsLive`. The frame respects `onByChange ===
undefined` by skipping the chip (`byInteractive` becomes false → the
`ChipButton` renders as plain text, AC line 446-453).

**`range:` chip:** the spec asks the variance popover to hide the
preset chips (AC line 304-306). Implementation: thread a
`presetsHidden?: boolean` prop into `RangePopover` (or simpler — pass
`hidePresets` through `ReportDetailFrame` and conditionally render the
`PRESETS.map(...)` block at line 571-590). Labels `'Prior EOD'` /
`'Current EOD'` replace the date-cell labels (currently no label — the
cells just say "from cell" / "to cell"); the simplest path is a
`labels?: { from?: string; to?: string }` prop on `RangePopover` with
defaults to the existing implicit shape.

These are small, contained variance-specific branches — the spec's
"in-frame gating only, no new frame code beyond an `if templateId ===
'variance'` branch" (AC line 506-509) is accurate.

### Risks & tradeoffs

1. **`reference_date` vs `received_at::date` divergence from spec.** I'm filtering on `coalesce(reference_date, received_at::date)` rather than the spec's literal `received_at::date`. Surfacing this explicitly so the reviewers don't flag it as drift. Rationale: matches the rest of the codebase (`db.upsertPurchaseOrder` writes `reference_date`), and the existing index applies. The fallback to `received_at::date` keeps legacy rows correct. **If the user prefers the spec's literal `received_at::date`, the developer can swap and we lose the index — the runtime impact is still well under the 500 ms budget at seed scale.**

2. **One-anchor item exclusion.** The spec is explicit (AC line 158-164) — items at only one anchor are excluded from `rows` and surfaced as a KPI count. **Alternative:** include them with `prior_count = 0` (current-only items) or `current_count = 0` (prior-only items). The spec rejected this in DRAFT. If anyone challenges the exclusion during review, the answer is: a one-anchor delta is undefined math because we don't know whether the item was on hand at the missing anchor. The KPI count is the visible signal.

3. **P0002 error message sanitization.** `db.runReport`'s sanitizer (`src/lib/db.ts:1684-1697`) treats only `'Not authorized'`-prefixed messages as verbatim. Anything else becomes `'Run failed — check server logs'`. So a legitimately-helpful `'Variance report: no submitted EOD for store on 2026-05-01 (anchor: from)'` will render as the generic message in the toast. The pre-emptive modal hint covers the common case ("user hasn't done 2 EODs yet"); the race case (user picks a date with no EOD in the popover) silently degrades to the generic. **Either acceptable for v1 (the hint is the primary affordance), or follow-up spec to widen the sanitizer allowlist.** Spec AC line 70-72 explicitly accepts the sanitizer behavior.

4. **No CTE re-walk optimization.** Variance walks the recursive prep CTE once (sales depletion only). COGS walks it three times per call. This means variance is structurally faster than COGS at the same data volume — no concern there.

5. **Temp table inside the function.** I'm recommending a temp table (`_variance_joined`) to share intermediate state between the "headline scalars" and "rows aggregation" statements. This is one pattern; the developer might prefer a single SELECT that emits both via a sub-query. Either is fine. The temp-table approach is more readable for the multi-statement plpgsql case but adds a tiny per-call DDL overhead. Developer's discretion.

6. **Catalog name via two joins.** Item name lives on `catalog_ingredients.name`, not `inventory_items.name` (which was dropped in P3 lockdown line 59). The `joined` CTE will need `JOIN inventory_items ii ON ii.id = e.item_id JOIN catalog_ingredients ci ON ci.id = ii.catalog_id` to get the display name. This is one extra join compared to COGS (which uses `recipes.menu_item`). Trivial cost at seed scale.

7. **`fetchRecentEodDates` swallows errors to `[]`.** Matches the pattern of `fetchBrandForStore` and other "nice-to-have" reads. The modal then shows the empty-defaults branch + inline hint. If the read fails for an RLS reason (the user has no access to the store), the same UX path fires. Acceptable.

### Forward-compat note for REPORTS-4 (Waste) and beyond

The recursive prep CTE pattern (depth-5 cap, cycle detection, missing_cost / truncated bool_or rollups) now appears in:
- `20260511120000_report_run_cogs.sql:197-247` (three times within COGS).
- `20260512120000_report_run_variance.sql` (this spec, once).

REPORTS-4 (Waste) will need it once more (waste qty × per-recipe ingredient flatten is the same shape). REPORTS-5 (Vendor) and REPORTS-6 (Velocity) may not need it.

**Extraction candidate (deferred, NOT this spec):** a shared SQL function or view like
`public.recipe_cost(p_store_id uuid) returns table(recipe_id uuid, cost_per_unit numeric, missing_cost boolean, truncated boolean)` that wraps the recursive prep CTE + the `inventory_items` cost join. Three callers materialize the same shape today; consolidating would:
- Cut duplicate CTE walks per template runner.
- Make the depth-5-with-NOTICE behavior single-source.
- Let a fourth caller (waste runner) just `JOIN public.recipe_cost(p_store_id) USING (recipe_id)`.

**Log it in the REPORTS-4 spec, not here.** This spec ships verbatim duplication for the now-second time, exactly per the spec prompt's "don't actually extract — log the candidate."

### Files the developer will change

1. `supabase/migrations/20260512120000_report_run_variance.sql` — **new**, ~350 lines (function body + dispatcher re-creation + optional waste_log index).
2. `src/lib/db.ts` — **add** `fetchRecentEodDates` helper near the other `eod_*` reads (~20 lines).
3. `src/screens/cmd/sections/reports/templates.ts` — **change** `variance` row's `status: 'preview'` → `status: 'live'`; cosmetic `'cols'` string spacing fix (one line).
4. `src/components/cmd/NewReportModal.tsx` — **variance-mode branches**: hide preset chips, relabel inputs, hide `by:` chip, seed inputs from `fetchRecentEodDates(currentStore.id, 2)`, omit `range` key from `params` on create, swap the inline hint when < 2 EODs exist. ~30-50 lines of changes; existing date input infrastructure is reused.
5. `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` — **variance-mode branches**: gate `by:` chip rendering on `templateId !== 'variance'`; thread `hidePresets` + custom labels into `RangePopover` for variance. ~15-25 lines.
6. `src/screens/cmd/sections/ReportsSection.tsx` — gate `onByChange` on variance template check. ~3 lines.

Nothing else.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement Spec 018 (Reports Variance Template) against the design in the `## Backend Architecture` section. Backend builds `supabase/migrations/20260512120000_report_run_variance.sql` (the variance RPC + dispatcher re-creation + optional waste_log index) and the new `fetchRecentEodDates` helper in `src/lib/db.ts`. Frontend handles the variance-mode gating in `NewReportModal.tsx`, `ReportDetailFrame.tsx`, `ReportsSection.tsx`, and the `status: 'live'` flip in `templates.ts`. Coordinate on the `templates.ts` flip — it's the visible "ship" signal so it should land last in the implementation sequence. After implementation, set `Status: READY_FOR_REVIEW` and list files changed under `## Files changed`.
payload_paths:
  - specs/018-reports-variance-template/spec.md
  - supabase/migrations/20260511120000_report_run_cogs.sql
  - supabase/migrations/20260510120000_report_runs.sql
  - supabase/migrations/20260510130000_report_runs_consistency.sql
  - src/lib/db.ts
  - src/components/cmd/NewReportModal.tsx
  - src/screens/cmd/sections/reports/ReportDetailFrame.tsx
  - src/screens/cmd/sections/reports/templates.ts
  - src/screens/cmd/sections/ReportsSection.tsx
  - src/store/useStore.ts
  - src/types/index.ts

## Files changed

### Migrations
- `supabase/migrations/20260512120000_report_run_variance.sql` — new; creates
  `report_run_variance(uuid, jsonb)` with the half-open
  `(prior_anchor, current_anchor]` joins for receiving / sales-depletion /
  waste, the depth-5 recursive prep CTE shared with COGS, the floating-point
  noise filter (`abs(delta) >= 0.01`), the four KPI cases, and the
  server-side row formatting. Re-creates `report_run(text, uuid, jsonb)` to
  add the `when 'variance'` dispatcher arm. Includes the
  `idx_waste_log_store_logged_at` partial index per the architect's
  "Performance" section (forward-proofing; zero cost at seed scale).

### `src/lib/db.ts`
- New `fetchRecentEodDates(storeId, limit = 2): Promise<string[]>` helper
  inserted right after `fetchEodSubmissionsForStores`. Returns ISO dates
  descending; swallows errors to `[]` (matches the `fetchBrandForStore`
  /nice-to-have-read pattern). RLS gates the read via `eod_submissions`'s
  per-store policy.

### Verification (manual; no test framework wired up)
- Applied the migration via `docker exec -i supabase_db_imr-inventory psql`;
  function created, dispatcher re-created, index built. No errors.
- Smoke tests through psql under `set_config('request.jwt.claims', ...)`
  impersonation:
  - Anon caller → `42501 'Not authorized for store ...'` ✓
  - Admin, no EOD submissions → `P0001 'Not enough EOD history ...'` ✓
  - Admin, `from > to` → `22023 'Variance report: from > to ...'` ✓
  - Admin, `from == to` → `22023 'Variance report: from == to ...'` ✓
  - Admin, explicit `from` with no matching EOD → `P0002 '... (anchor: from)'` ✓
  - Admin, explicit `to` with no matching EOD → `P0002 '... (anchor: to)'` ✓
  - Admin, default anchors with sparse data → correct envelope:
    - Lamb Gyro Meat: prior=20, +5 receiving, -1.5 waste → expected=23.5;
      counted=12; delta=-11.5; dollar=-$475.53 ✓
    - MSG Ajinomoto (cost=0): missing_cost flagged, `$0.00` dollar,
      `' ⚠'` suffix ✓
    - 4LB Brown Paper Bag (prior only): excluded from rows, surfaces in
      `Items not counted at both anchors` KPI ✓
    - Waste at `v_from` (excluded by `> v_from`) correctly NOT counted ✓
  - Floating-point noise filter: delta=0 rows dropped from output ✓
  - Dispatcher routes: `variance` → variance RPC; `cogs` → cogs RPC;
    `waste` → `not_implemented` envelope; `stub` → stub RPC ✓
- `npx tsc --noEmit`: zero new errors in `src/lib/db.ts` (121 pre-existing
  errors elsewhere in the tree unchanged by my edits; the
  `ReportDetailFrame.tsx:422 hidePresets` error pre-existed from the
  parallel frontend-developer work and is out of my scope).

### Frontend (`src/components/cmd/NewReportModal.tsx`)
- Imports `fetchRecentEodDates` from `src/lib/db.ts` for variance pre-fill.
- Adds `seedVarianceDates(storeId)` helper: returns `{from, to, eodCount}`
  where `from`/`to` are the two most-recent submitted EOD dates (`dates[1]`
  / `dates[0]` of the descending fetch) when 2+ exist; falls back to a
  `last_30d` window otherwise so the inputs remain populated. `eodCount`
  drives the inline hint + CREATE disabled state.
- New `eodCount` state (`-1` = not-yet-fetched sentinel; `0`/`1` = hint
  applies; `≥ 2` = good to go).
- Initial-open `useEffect` calls `seedVarianceDates` when
  `initialPicked === 'variance'`. A second `useEffect` watches `picked`
  changes mid-modal and re-seeds on switch-TO / restores `last_30d` on
  switch-FROM variance. `prevPickedRef` is reset on each modal open so a
  re-open with a new template doesn't suppress the seed.
- Conditional render of the params section: when `isVariance`, renders
  two stacked labelled inputs (`prior EOD` / `current EOD`) with the
  existing tap-to-edit pattern, plus an inline hint
  (`Not enough EOD history — submit at least two EODs to compute
  variance` in danger tone when blocked, else a neutral helper note).
  Hides the preset chip strip and the `by:` toggle for variance.
- `onCreate` writes `params: { from, to }` for variance (no `range`,
  no `by`); falls through to the existing `{ range, from, to, by }`
  shape for COGS. Rejects `varianceBlocked` and `from === to` (variance
  requires two distinct dates) before delegating to
  `addReportDefinition`.
- CREATE button now respects `varianceBlocked`: disabled style + cursor +
  text color flip, matching the existing RUN-disabled pattern in
  `ReportDetailFrame`.

### Frontend (`src/screens/cmd/sections/reports/ReportDetailFrame.tsx`)
- Adds `isVariance = definition.templateId === 'variance'` derived flag.
- Adds `varianceRangeLabel(from, to)` helper that renders
  `prior: <date> · current: <date>` (with `—` placeholders for empty
  anchors).
- `range:` chip: when `isVariance`, swaps `range: <label>` for the
  variance-shaped label via the helper.
- `by:` chip + its preceding `·` separator: hidden entirely when
  `isVariance` (per AC: variance is inherently per-item; no by-mode).
- `RangePopover` extended with two optional props: `hidePresets?: boolean`
  and `labels?: { from?: string; to?: string }`. When `labels` is set,
  each cell renders its own column header (`PRIOR EOD` / `CURRENT EOD`)
  and the popover's overall "range" header is dropped. When `hidePresets`
  is true, the preset chip strip is omitted and the inline helper text
  switches to the variance-shaped wording.
- Detail frame passes `hidePresets={isVariance}` and the variance
  `labels` object into `RangePopover` only when variance.
- No `formatCellValue` changes; no chart changes (server returns empty
  `series` so the existing `series.length < 2` skip handles it).

### Frontend (`src/screens/cmd/sections/ReportsSection.tsx`)
- Adds `selectedSupportsBy = selectedIsLive && selectedTemplate?.id !==
  'variance'`. Threads it into `ReportDetailFrame` for `overrideBy` /
  `onByChange` so variance never gets a by-toggle. `selectedIsLive`
  still gates `overrideRange` / `onRangeChange` / `onResetOverrides`.
- `onRun` merged-override builder now branches on
  `definitionIsVariance`: variance omits the `range` key (and any
  stray `by` key) from `mergedOverride`, so the persisted
  `report_runs.params` audit row stays variance-shaped rather than
  inheriting COGS vocabulary.

### Frontend (`src/screens/cmd/sections/reports/templates.ts`)
- Flips the `variance` row from `status: 'preview'` to `status: 'live'`.
  This is the visible "ship" signal — the catalog tile drops its PREVIEW
  badge and `ReportsSection` starts wiring the chip-override props on
  detail-frame open.
- Cosmetic: `cols` for variance updated to
  `'item · expected · counted · Δ · $ impact'` (single space before
  `impact`) to match the column `label` in the RPC envelope.
- Comment update on lines 12-13 reflects that REPORTS-3 has now landed
  the variance runner (not "will flip").

### Verification (frontend)
- `npx tsc --noEmit`: zero new errors in the four touched frontend files
  (`NewReportModal.tsx`, `ReportDetailFrame.tsx`, `ReportsSection.tsx`,
  `templates.ts`). Pre-existing errors elsewhere in the tree are
  unrelated to this spec.
- Code path trace through the verification scenarios:
  1. Catalog tile: `templates.ts` shows `status: 'live'` for variance →
     `ReportsSection.tsx:355-359` PREVIEW badge gated on
     `r.status === 'preview'` → no badge rendered for variance. Other
     four preview templates still gated on `'preview'` → badge stays.
  2. Click variance tile → `onCatalogTilePress('variance')` opens
     `NewReportModal` with `initialTemplateId='variance'`,
     `initialName='Variance — May 2026'`. `isVariance` derived true →
     hides preset chips, hides `by:` toggle, shows
     `prior EOD` / `current EOD` labelled cells.
  3. `seedVarianceDates(currentStore.id)` resolves; the modal sets
     `eodCount` from the helper's array length. When `< 2`, inline hint
     text turns danger tone and CREATE is disabled.
  4. CREATE writes `params: { from, to }` (no `range` / `by` keys). The
     saved tile shows `VARIANCE` badge via the existing
     `r.templateId.toUpperCase()` render.
  5. Click saved tile → `ReportDetailFrame` opens. `isVariance` derived
     true. `range:` chip renders via `varianceRangeLabel` →
     `prior: <date> · current: <date>`. `by:` chip + its preceding `·`
     are skipped.
  6. RUN → `db.runReport` posts `{ from, to }` (no range / by) and the
     backend's `'variance'` dispatcher arm routes to
     `report_run_variance`. Envelope renders unchanged via the existing
     template-agnostic frame.
  7. Click `range:` chip → `RangePopover` renders with `hidePresets`
     and the `labels` prop, showing two labelled cells (`PRIOR EOD` /
     `CURRENT EOD`), no preset row. The `·` override indicator paints
     once the user commits a new date.
  8. Anchor with no matching EOD → backend raises `P0002` →
     `db.runReport`'s sanitizer maps to `'Run failed — check server
     logs'` (raw message in `console.warn`). Frame's `ErrorPanel`
     renders the sanitized message. (Acceptable per AC line 70-72; a
     friendlier message would require widening the sanitizer
     allowlist — out of scope for this spec.)
- Browser preview verification: not executed in this run — the preview
  tools are not in the available toolset for this agent. The dev
  server at `http://localhost:8081/` is running and the code paths
  above are visually testable manually by the user / reviewer.

### Files touched (frontend)
- `src/components/cmd/NewReportModal.tsx` — variance-mode branches
  (input labels, hidden presets, hidden by-toggle, EOD pre-fill,
  inline hint, CREATE-disabled, variance-shaped `params` on save).
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` —
  variance-mode chip label, hidden `by:` chip, `RangePopover` extended
  with `hidePresets` / `labels` props.
- `src/screens/cmd/sections/ReportsSection.tsx` —
  `selectedSupportsBy` gate + `onRun` merged-override variance branch.
- `src/screens/cmd/sections/reports/templates.ts` — `variance` flipped
  to `status: 'live'`; cosmetic `cols` spacing; comment updated.

### Round-2 fixes (release-proposal addresses)

The release proposal at
`specs/018-reports-variance-template/reviews/release-proposal.md`
returned **FIXES_NEEDED** on two Critical AC violations plus four
Should-fix items. This subsection lists what each round-2 change
addresses; the test/verification notes follow.

**P0 — Critical fixes**

- **`src/components/cmd/NewReportModal.tsx` — CREATE-button disable
  removed (release-proposal Item 1, Option A).** Spec AC line 265 says
  "The CREATE button is NOT disabled" but round 1 disabled it when
  `eodCount < 2`. The CREATE button now stays enabled (no `disabled`
  prop, no conditional `opacity` / `backgroundColor` / `cursor` /
  `color`). The early-return guard `if (varianceBlocked) return;` in
  `onCreate` is removed too — per spec, the user can save the variance
  definition and the subsequent RUN surfaces the P0001/P0002 error via
  the sanitized toast path. The `varianceBlocked` variable is kept
  because it still drives the inline danger hint at the params section.
- **`supabase/migrations/20260512120000_report_run_variance.sql` —
  KPI counts off `joined`, rows table stays filtered (release-proposal
  Item 2, Option C).** Spec Q7 line 440-443 says "include all
  intersected items" and the KPI definition at spec line 175 says
  "count(*) where abs(variance) > 0". Round 1 aggregated both the rows
  AND the KPI off `filtered` (which dropped rows with `|delta| < 0.01`),
  so items with sub-cent variance vanished from both. The fix splits
  the treatment:
    · Per-row `dollar_impact` is now computed in `joined_with_dollar`
      (pre-filter); `filtered` selects from there for the rows table.
    · `totals` now aggregates from `joined_with_dollar` with
      `count(*) filter (where abs(delta) > 0)` for `items_with_variance`,
      `sum(dollar_impact)` for `net_dollar`, and `count(*) filter (where
      missing_cost)` for `missing_cost_count`.
    · Migration header comments at lines 78-95 updated to document the
      split contract (architect's readability concern → rows-only
      filter; spec KPI definition → counts off `joined`).

**P1 — Should-fix bundle**

- **`src/components/cmd/NewReportModal.tsx:111` — empty-string fallback
  for low-EOD seed.** Round 1 fell back to `computePreset('last_30d')`
  when fewer than 2 EODs existed, pre-filling calendar dates that
  would fail the RPC's `P0002` anchor check. Per spec line 263 the
  inputs default to **empty strings** and the danger hint is the
  sufficient UX affordance. Both the `< 2` branch and the catch branch
  of `seedVarianceDates` now return `{ from: '', to: '', eodCount }`.
- **`src/components/cmd/NewReportModal.tsx:615` — `'#000'` → `C.accentFg`.**
  Round 1's CREATE button text used the literal `'#000'`; the round-2
  rewrite of the same button uses `C.accentFg` (the Cmd palette token —
  `#FFFFFF` in light mode, `#0E1014` in dark mode), restoring the
  REPORTS-1 round-2 convention.
- **`src/screens/cmd/sections/ReportsSection.tsx:21` — stale
  forward-tense comment.** Round 1 still said "REPORTS-2 will flip
  `cogs`, REPORTS-3 will flip `variance`"; both have shipped. The
  comment is rewritten in past tense and points the reader at
  `templates.ts` for the historical record.
- **`src/screens/cmd/sections/reports/ReportDetailFrame.tsx:84-85` —
  stale "premature shared module" comment.** Preferred path: extract
  `toISODate`, `isISODate`, `computePreset`, and `PresetId` into the
  new `src/utils/reportDates.ts` and import from both
  `NewReportModal.tsx` and `ReportDetailFrame.tsx`. The shared module
  is the source of truth; the frame keeps a local `PresetId` alias
  that adds `'custom'` for its manual-edit affordance. `NewReportModal`
  drops its `toISODate` / `isISODate` / `computePreset` / `PresetId`
  copies entirely.

### Files touched (round 2)

- `supabase/migrations/20260512120000_report_run_variance.sql` —
  header rewrite for the split KPI/rows treatment; `joined_with_dollar`
  CTE inserted; `filtered` now selects from it; `totals` aggregates
  off `joined_with_dollar`.
- `src/components/cmd/NewReportModal.tsx` — CREATE-button disable
  reverted (no `disabled` prop, no conditional styling, no early-return
  in `onCreate`); `'#000'` → `C.accentFg`; `seedVarianceDates` returns
  empty strings on low-EOD; date helpers replaced by import from
  `src/utils/reportDates.ts`.
- `src/screens/cmd/sections/ReportsSection.tsx` — comment update
  (past-tense; cite `templates.ts`).
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` — replaces
  duplicated date helpers with imports from
  `src/utils/reportDates.ts`; local `PresetId` is now an extension of
  the shared union for the `'custom'` manual-edit case.
- `src/utils/reportDates.ts` — **new file**; single source of truth
  for `PresetId`, `toISODate`, `isISODate`, `computePreset`. Replaces
  the previously-duplicated implementations.

### Verification (round 2)

- **Migration applied** via `docker exec -i supabase_db_imr-inventory
  psql -U postgres -d postgres -f -` against the modified migration:
  `CREATE FUNCTION` / `CREATE INDEX` / `CREATE FUNCTION` all OK; no
  errors.
- **FAIL-2 repro confirmed fixed** (the test-engineer's exact
  scenario):
    · Setup: Towson store, anchors `2026-06-01` → `2026-06-08`.
      Fixture `eod_entries` rows for `Aluminum Foil` with
      `actual_remaining = 10.000` at prior and `9.995` at current
      (`|delta| = 0.005 < 0.01`).
    · Before fix: KPI `Items with variance = 1`, rows shows only
      `Snow Crab Leg`.
    · After fix: KPI `Items with variance = 2` (counts the foil row),
      rows still shows only `Snow Crab Leg` (foil filtered for
      readability). ✓
    · Variant test: bump foil `cost_per_unit` to `1000`; `Net $ impact`
      shifts from `-$762.00` to `-$767.00` (the `-0.005 × 1000 = -$5`
      contribution now flows into the headline sum), confirming KPI
      aggregates off `joined_with_dollar` (pre-filter). ✓
- **CREATE-button fix**: static trace — `NewReportModal.tsx:560-571`
  no longer carries `disabled`, conditional `opacity`, conditional
  `backgroundColor`, conditional `cursor`, or conditional `color`.
  `onCreate` at line 224 no longer early-returns on
  `varianceBlocked`. The inline danger hint at line 419-422 still
  renders. Browser preview not run (the `preview_*` tools listed in
  the round-2 prompt aren't available to this agent — flagged in
  the handoff for the test-engineer to exercise).
- **Empty-string fallback**: `seedVarianceDates` returns
  `{ from: '', to: '', eodCount }` on the low-EOD and catch branches
  (`NewReportModal.tsx:103-116`). The TextInput cells render the
  empty string (placeholder `'YYYY-MM-DD'` shown in the
  read-only state at lines 433-435 / 462-464 via the `{dateRange.from
  || 'YYYY-MM-DD'}` fallback already in place).
- **`accentFg` flip**: text color at line 570 references `C.accentFg`
  which is `'#FFFFFF'` in light and `'#0E1014'` in dark — see
  `src/theme/colors.ts:178, 201`.
- **`npx tsc --noEmit`**: 121 pre-existing errors unchanged; **zero**
  new errors in `NewReportModal.tsx`, `ReportDetailFrame.tsx`,
  `ReportsSection.tsx`, `reportDates.ts`, or the migration. Verified
  via filter `| grep -E "NewReportModal|ReportDetailFrame|
  ReportsSection|reportDates|templates.ts"` returning no output.

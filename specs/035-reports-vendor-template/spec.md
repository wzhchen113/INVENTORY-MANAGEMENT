# Spec 035: Reports — Vendor template

Status: READY_FOR_REVIEW

## User story

As a store manager, I want to run a "Vendor spend" report over a date range so
I can see how much money we paid out, sliced by vendor, by category, or by
item, so I can identify where our purchasing dollars actually go and prioritize
renegotiation or supplier consolidation.

## Acceptance criteria

### Backend — `public.report_run_vendor(uuid, jsonb) returns jsonb`

- [ ] A new migration `supabase/migrations/<timestamp>_report_run_vendor.sql`
  creates the function with signature
  `(p_store_id uuid, p_params jsonb) returns jsonb`,
  `language plpgsql`, `security invoker`,
  `set search_path = public`. Matches the spec 034 waste runner's security
  shape byte-for-byte.
- [ ] First statement raises SQLSTATE `42501` if
  `public.auth_can_see_store(p_store_id)` returns false, mirroring
  `report_run_waste.sql:88-92` / `report_run_variance.sql:142-146`.
- [ ] Same migration re-creates the dispatcher
  `public.report_run(text, uuid, jsonb)` with a new `when 'vendor' then return
  public.report_run_vendor(p_store_id, p_params)` arm, preserving the existing
  `'stub'`, `'cogs'`, `'variance'`, `'waste'` arms and the `not_implemented`
  fallback exactly as in `20260514170000_report_run_waste.sql`. The arm slots
  immediately after `when 'waste'` (placement convention: live arms in the
  order their templates landed).
- [ ] Grants: `revoke execute on function public.report_run_vendor(uuid, jsonb)
  from public, anon; grant execute on function public.report_run_vendor(uuid,
  jsonb) to authenticated;` — matches the spec 016 convention and the
  `reports_anon_revoke.test.sql` lockdown.
- [ ] Parameters accepted in `p_params`:
  - `from` (string, `YYYY-MM-DD`) — defaults to `current_date - interval '30
    days'` when null/empty, matching the waste / COGS precedent.
  - `to` (string, `YYYY-MM-DD`) — defaults to `current_date` when null/empty,
    matching the waste / COGS precedent.
  - `by` (text) — one of `'vendor'`, `'category'`, `'item'`. Defaults to
    `'vendor'` when null/empty. Unknown values silently coerce to the default
    (forward-compat per the COGS / waste pattern).
  - Unknown keys ignored. Malformed dates surface as native 22007/22008 →
    sanitized to "Run failed — check server logs" via the frontend's
    existing `runReport` toast path.
- [ ] Range validation: `from > to` raises SQLSTATE `22023` with message
  `'Vendor report: from > to (% > %)'`. `from = to` is ALLOWED (single-day
  vendor reports are meaningful — useful for "show me yesterday's deliveries").
- [ ] Date anchor: `coalesce(po.reference_date, po.received_at::date)` —
  MATCHES the variance/multivendor precedent at
  `20260512120000_report_run_variance.sql:408` and
  `20260514120020_report_run_variance_multivendor.sql:351`. Rationale:
  `purchase_orders.reference_date` (date) is the manager-facing business
  date and is indexed via
  `idx_purchase_orders_store_reference_date (store_id, reference_date)` at
  `20260502071736_remote_schema.sql:177`; `received_at::date` is the
  fallback for legacy rows pre-dating the `reference_date` column.
- [ ] Date window: closed `[from, to]` on the date anchor (`>= v_from AND <=
  v_to`). Mirrors waste/COGS, NOT variance's half-open shape. Migration
  header documents the divergence the way the waste header does so reviewers
  comparing the runners don't flag it as drift.
- [ ] Status filter: `(po.status = 'received' or po.received_at is not null)`
  — MATCHES the variance precedent. Excludes `draft`/`sent`/`partial`-without-
  receipt POs which are not real spend yet. `partial`-with-receipt rows ARE
  included (rationale: a partial receipt represents money that has actually
  changed hands for the portion received).
- [ ] Dollar source: `coalesce(pi.received_qty, 0) * coalesce(pi.cost_per_unit,
  0)` per `po_items` line, NOT `purchase_orders.total_cost`. Rationale:
  - `received_qty` is the historically-correct quantity (what actually
    arrived), not `ordered_qty` (which can differ for partials).
  - `po_items.cost_per_unit` is the historical snapshot at PO creation
    time; same logic as waste using `waste_log.cost_per_unit` (the
    snapshot, NOT `inventory_items.cost_per_unit` which is the current
    value). Lines with NULL `cost_per_unit` or NULL `received_qty`
    contribute $0 — they still surface in row counts but don't move
    the headline. Header MUST call this out.
- [ ] Empty-result short-circuit: when no `po_items` rows match the filter,
  return populated `columns` + empty `kpis`/`rows`/`series` (`[]` not null
  for the array shapes; the series stays `[]` not `null` per the spec 016
  contract).
- [ ] Vendor-name resolution: `vendors.name` via the
  `po_items.po_id → purchase_orders.id → purchase_orders.vendor_id →
  vendors.id` chain. Rows whose `purchase_orders.vendor_id` is NULL get
  the name `'(no vendor)'`. Rows whose `vendors` row was deleted (orphan
  `vendor_id`) get the name `'(deleted vendor)'`. Left-joins keep the row
  in both cases; the dollar still contributes to the headline.
- [ ] Item-name resolution: `catalog_ingredients.name` via the
  `po_items.item_id → inventory_items.id → inventory_items.catalog_id →
  catalog_ingredients.id` chain (mirrors waste line 329, variance line 481).
  Rows whose `inventory_items` row was deleted (orphan `po_items.item_id`)
  get the name `'(deleted item)'`. Left-join keeps the row in the output.
- [ ] Category resolution: `catalog_ingredients.category` (free-form text,
  same surface COGS / waste read). NULL/empty/whitespace coerce to
  `'(uncategorized)'` via `coalesce(nullif(trim(category), ''),
  '(uncategorized)')`.
- [ ] Envelope shape returned (matches the spec 016 uniform envelope):
  ```json
  {
    "kpis":    [
      { "label": "Total spend $",   "value": "$12,345.67", "tone": null },
      { "label": "Top vendor",      "value": "Sysco · $5,678.90", "tone": null },
      { "label": "POs in period",   "value": 17,           "tone": null }
    ],
    "columns": [ /* depends on `by:` — see column shapes below */ ],
    "rows":    [ /* one row per group key, dollar-desc sorted */ ],
    "series":  [ { "label": "<vendor>", "x": "YYYY-MM-DD", "y": <number> }, ... ]
  }
  ```
- [ ] Columns by `by:` value (per-mode named keys policy from spec 034 §A1):
  - `by='vendor'`: `[vendor, po_count, total_qty, dollar_impact]` —
    `po_count` is `count(distinct po_items.po_id)` within the vendor.
  - `by='category'`: `[category, po_count, items_affected, total_qty,
    dollar_impact]` — `items_affected` is `count(distinct po_items.item_id)`
    within the category.
  - `by='item'`: `[item, category, po_count, total_qty, unit,
    dollar_impact]` — no `items_affected` (the row IS the item).
    `unit` is `coalesce(catalog_ingredients.unit, '')` per the waste/reorder
    pattern.
- [ ] Row formatting (server-side):
  - Dollar cells: `'$' || to_char(value, 'FM999,999,990.00')` for positive,
    `'-$' || to_char(abs(value), 'FM999,999,990.00')` for negative (vendor
    spend should always be positive — guard for forward-compat).
  - Qty cells: `to_char(value, 'FM999,990.000')` (three-decimal precision
    matches waste / variance row format).
  - Rows sorted by `dollar_impact desc, group_key asc` (tiebreaker keeps
    output deterministic).
- [ ] KPI tone bands: ALL THREE KPIs emit `"tone": null`. Rationale: vendor
  spend is not inherently bad — a high spend simply means the store bought
  a lot. A "warn" tone on $10k of spend would falsely flag healthy
  high-volume stores. The PM resolved Q3 as "omit tone bands for spend"
  (in contrast to waste, where any spend is bad and >$200/period is
  danger). Header documents this divergence so reviewers don't
  copy-paste waste's `case when total < 50 then ok ...` block.
- [ ] KPI `Top vendor` ALWAYS uses the `vendor` grouping regardless of the
  requested `by:` value — it's the cross-cutting "where is our money
  going" signal, parallel to waste's `Top driver` (which always uses
  `reason`). Computed as `vendor || ' · $' || to_char(top_vendor_dollar)`.
  When no PO rows exist, the KPI is omitted (not emitted as a zero); the
  empty-result short-circuit at the early return already handles
  row_count = 0. Defense-in-depth guard against `top_vendor_dollar = 0`
  (every row contributed $0 because of NULL costs) — when guard fails,
  omit the KPI.
- [ ] `series` shape: ONE series per `vendor` value, multi-line. Each point
  is `{ "label": <vendor>, "x": <date>, "y": <dollar_impact_that_day> }`.
  Computed regardless of the `by:` toggle (so the chart always tells the
  vendor-over-time story while the table can be sliced any way). Mirrors
  waste's "one series per reason" decision. Empty array (`'[]'::jsonb`)
  when fewer than 2 distinct dates have matched rows — same gate as COGS
  / waste. Series NEVER returns `null` — per the spec 016 contract.
- [ ] No recursive prep-recipe CTE needed (po_items rows are already at
  the granular level — they reference `inventory_items.id` directly).
  Migration header explicitly notes the absence so future contributors
  don't add one out of pattern-mimicry. Same load-bearing absence as
  waste.

### Frontend — `src/screens/cmd/sections/reports/templates.ts`

- [ ] Flip the `vendor` template's `status: 'preview'` to `status: 'live'`.
- [ ] No other field changes on the row (name `'Vendor performance'` stays
  even though the runner is now scoped to spend specifically — the spec
  doesn't expand to fill rate / on-time which the original tile copy
  advertised. A future spec may rename the tile / add a velocity-style
  fill-rate runner; for spec 035 we accept the copy as aspirational and
  ship the spend slice).

### Frontend — `src/components/cmd/NewReportModal.tsx`

- [ ] `vendor` template uses the SAME date-range + by-toggle UI that COGS /
  waste use (the existing non-variance branch). No template-specific UI
  needed.
- [ ] Extend the `BY_OPTIONS` registry (currently `{ cogs, waste }`) to add
  `vendor: ['vendor', 'category', 'item'] as const`.
- [ ] Widen the `ByOption` type union from `'reason' | 'category' | 'item'`
  to `'reason' | 'vendor' | 'category' | 'item'`. The `by` state hook,
  the `BY_OPTIONS` value type, and the `defaultByForTemplate` return type
  all flow from this union.
- [ ] Extend `defaultByForTemplate` to return `'vendor'` for the `vendor`
  template (mirrors waste returning `'reason'`). COGS and all other
  templates continue to fall through to `'category'`.
- [ ] Save-time params for `vendor`:
  `{ range, from, to, by }` — same shape as COGS / waste. `range` is
  informational (drives the chip label); `from`/`to` are authoritative.

### Frontend — `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`

- [ ] `overrideBy` / `onByChange` / `onPickBy` / `byOpts` types widen from
  `'reason' | 'category' | 'item'` to `'reason' | 'vendor' | 'category' |
  'item'`. The `savedBy` parser (line 187-191) admits a fourth arm for
  `'vendor'`:
  ```ts
  const savedBy: 'reason' | 'vendor' | 'category' | 'item' =
    rawSavedBy === 'item'   ? 'item' :
    rawSavedBy === 'reason' ? 'reason' :
    rawSavedBy === 'vendor' ? 'vendor' :
    'category';
  ```
- [ ] `byOpts` (line 263-266) gains a third per-template branch:
  ```ts
  const byOpts =
    definition.templateId === 'waste'  ? (['reason', 'category', 'item'] as const) :
    definition.templateId === 'vendor' ? (['vendor', 'category', 'item'] as const) :
                                          (['category', 'item'] as const);
  ```
- [ ] By-chip override (the in-frame chip-strip): the `selectedSupportsBy`
  gate today is `selectedIsLive && selectedTemplate?.id !== 'variance'`
  in `ReportsSection.tsx:241`. With `vendor` now `'live'`, the chip strip
  fires for it automatically — same code path as waste. No code change in
  `ReportsSection.tsx` beyond the `OverrideState['by']` union widening
  below.

### Frontend — `src/screens/cmd/sections/ReportsSection.tsx`

- [ ] Widen `OverrideState['by']` from `'reason' | 'category' | 'item'` to
  `'reason' | 'vendor' | 'category' | 'item'`. The `setOverrideBy`
  signature (line 177) widens to the same union. COGS / waste / variance
  continue to ignore the `'vendor'` value if a user somehow saved that
  on a non-vendor definition (forward-compat: the RPC coerces unknown
  values to default).
- [ ] No removal of the PREVIEW badge needs explicit code change here —
  the badge already lives inside the catalog tile and is gated on
  `r.status === 'preview'`. The templates.ts flip drops the badge
  automatically.

### Tests

- [ ] New pgTAP test `supabase/tests/report_run_vendor.test.sql` with
  `plan(11)` mirroring `report_run_waste.test.sql` structure:
  1. **Fixture sanity (1)** — Frederick store id resolves from seed.
  2. **Fixture sanity (2)** — A Frederick `inventory_item` with cost > 0
     resolves from seed (gives us a stable `item_id` for inserts).
  3. **Auth gate** — manager calling vendor on Charles (non-member store)
     raises SQLSTATE `42501`. Mirrors `report_run_waste.test.sql` (3).
  4. **Empty range** — call with `from = to = '2000-01-01'` (no PO rows
     in seed before then), returns populated `columns` + empty
     `kpis`/`rows`/`series` arrays.
  5. **Single-row happy path** — insert one `purchase_orders` row
     (`status='received'`, `reference_date='2026-06-01'`,
     `vendor_id=<seeded vendor>`) and one `po_items` row (`received_qty=10`,
     `cost_per_unit=2.50`). Call with `from=to='2026-06-01'`,
     `by='vendor'`. Assert:
     - `kpis[label='Total spend $'].value = '$25.00'`
     - row count = 1, `rows[0].vendor = <vendor name>`,
       `rows[0].total_qty = '10.000'`, `rows[0].dollar_impact = '$25.00'`,
       `rows[0].po_count = 1`
  6. **Missing-cost zero-out** — insert one row with `cost_per_unit = NULL`.
     Assert that row's `dollar_impact = '$0.00'` and is excluded from
     `Total spend $` headline (the qty still surfaces in `total_qty`).
     Mirrors waste test (5). No `⚠` suffix per the waste precedent.
  7. **Multi-vendor ordering** — insert two rows with different
     vendors and different dollar impacts, assert `rows` is ordered
     dollar-desc, vendor-asc tiebreaker.
  8. **Status filter** — insert one `status='received'` row AND one
     `status='draft'` row with `received_at IS NULL` for the same date /
     vendor / item / qty / cost. Assert only the received row appears in
     the headline (one row in `rows`, `Total spend $` covers one row's
     value not two). This case is unique to the vendor runner (waste has
     no status field) and is the most likely regression vector.
  9. **`by='category'` smoke** — call once with `by='category'`. Assert
     `columns[0].key = 'category'` and `rows[0]` has a `category` key
     (not a `vendor` key).
  10. **`by='item'` smoke** — call once with `by='item'`. Assert
      `columns[0].key = 'item'` and `rows[0]` has an `item` key. Verify
      `columns` includes the `unit` column (per-mode shape divergence).
  11. **Envelope shape** — sorted-key list assertion matches `array
      ['columns', 'kpis', 'rows', 'series']::text[]`, same shape as
      `report_run_waste.test.sql` (7).
- [ ] `supabase/tests/reports_anon_revoke.test.sql` adds an arm for
  `report_run_vendor(uuid, jsonb)` — anon → 42501 at GRANT time. Brings
  the assertion plan from `plan(9)` to `plan(10)`. Arm slots after the
  existing waste arm (the `(5) report_run_waste` block) and before the
  `report_reorder_list` arm; the comment block at the top of the file
  grows from "8 RPCs covered" → "10 RPCs covered" (waste added 8→9; this
  spec takes it to 10).
- [ ] No new shell smoke arm. The existing `scripts/smoke-rpc.sh` smokes
  `report_run('stub', ...)` for the dispatcher contract; vendor is
  reachable through the same RPC, no per-template smoke needed.
- [ ] No new jest test required (no new TS helpers extracted by this
  spec). The `BY_OPTIONS` registry widening + the savedBy parser
  widening are typed at the TypeScript boundary and exercised by manual
  browser smoke; mechanical correctness is gated by `npx tsc --noEmit`.

### Verification gates

- [ ] `npx tsc --noEmit` exit 0.
- [ ] `npm run typecheck:test` exit 0.
- [ ] `npm test -- --ci` PASS.
- [ ] `npm run test:db` PASS — pgTAP file count moves from 16 → **17**; the
  `reports_anon_revoke.test.sql` plan moves from 9 → 10.
- [ ] `npm run test:smoke` PASS (no new arms; only confirms existing
  smokes still green).
- [ ] Manual browser smoke after `npm run dev` against local stack:
  - Reports section, catalog tile `vendor` — PREVIEW badge gone, click
    opens `NewReportModal` pre-filled with template = `vendor`, name =
    `"Vendor performance — May 2026"`.
  - The by-toggle in the modal shows three chips: `vendor` (selected),
    `category`, `item`.
  - Save the report — appears in "your reports" grid.
  - Click the saved report — detail frame opens.
  - Click RUN — `kpis` show Total spend $ + Top vendor + POs count;
    `rows` populate with vendor groups; multi-line chart renders one
    line per vendor.
  - Click `by:` chip strip — toggling between vendor / category / item
    re-runs with the override; rows + columns change shape correctly.
  - Toggle the date range — re-runs against the new window.

## In scope

- New RPC `public.report_run_vendor(uuid, jsonb) returns jsonb`.
- Dispatcher re-create with the `when 'vendor'` arm added after the
  existing `when 'waste'` arm.
- `templates.ts` flip of `vendor.status: 'preview' → 'live'`.
- `NewReportModal` + `ReportDetailFrame` + `ReportsSection` type-union
  widening to admit the `'vendor'` option for the by-toggle (and only
  for vendor).
- pgTAP test `report_run_vendor.test.sql` covering auth gate + envelope
  shape + per-row formula + missing-cost zero-out + ordering + status
  filter + by-toggle smoke.
- `reports_anon_revoke.test.sql` arm added for the new RPC.
- Migration header documents the design choices: date anchor
  (`coalesce(reference_date, received_at::date)`), status filter
  (`'received' or received_at is not null`), cost-snapshot rationale
  (`po_items.cost_per_unit`, not `inventory_items.cost_per_unit`), tone-
  bands omission (spend isn't inherently bad), no recursive CTE
  rationale.

## Out of scope (explicitly)

- **Velocity / custom templates.** Each is its own spec; the
  reports-templates-backlog stubs them out. Spec 035 is vendor only.
- **Fill rate / on-time / late metrics** advertised by the catalog tile
  copy ("on-time, fill-rate"). Spec 035 ships the *spend* slice only.
  A future spec may add separate KPIs / columns for `ordered_qty -
  received_qty` shortfalls or `received_at vs expected_delivery`
  lateness; we accept the catalog-tile copy as aspirational and ship
  the spend slice now. Surfacing this is not regret-bait — the spec
  intentionally narrows scope to ship.
- **New surfaces for creating, editing, or deleting purchase orders.**
  PO management is an existing surface (`PurchaseOrdersSection` and
  related Cmd UI). The admin app already writes POs; this spec only
  reads PO history.
- **Per-brand or per-store tone thresholds for `Total spend $`.** Tone
  bands are explicitly omitted (`"tone": null` for all spend KPIs) per
  the PM's Q3 resolution. Adding per-brand spend-band config is a
  future spec.
- **Snapshot-vs-current cost toggle.** Locked to the snapshot value
  stored on `po_items.cost_per_unit` at PO creation time (see Q2
  resolution below). Adding a "use current cost" param later is a
  follow-up if needed; the historical-snapshot is the right answer for
  "what did we spend" reports.
- **`vendor_id` orphan-detection cleanup.** Rows where
  `purchase_orders.vendor_id` is NULL or points to a deleted vendor
  surface in the output as `'(no vendor)'` / `'(deleted vendor)'`
  fallback labels — same shape as waste's `'(deleted item)'`. We do
  NOT add an FK ON DELETE SET NULL or backfill; that's a data-hygiene
  spec.
- **Pending POs as spend.** The status filter explicitly excludes
  `'draft'`/`'sent'` POs without a `received_at`. A future "pending
  spend" tile is its own spec.
- **A `⚠` suffix on rows with missing cost.** Same rationale as waste
  spec 034 — a single row with NULL cost just doesn't contribute to
  the dollar number; the qty still surfaces. No per-row diagnostic.
- **Realtime push for PO inserts into the open detail frame.** The
  detail frame is run-on-demand; `useRealtimeSync.ts` already listens
  on `purchase_orders` for the section-level reload, but a re-run of
  an open Vendor report is the user's action via the RUN button.
- **Slug or `app.json` changes.** (Not relevant — see project-specific
  notes.)
- **Edge function.** RPC-only; no `supabase/functions/` work.

## Open questions resolved

- **Q1: Date anchor — `received_at` vs `reference_date`?** →
  **`coalesce(po.reference_date, po.received_at::date)`** — verbatim
  variance/multivendor precedent. Rationale:
  - `purchase_orders.reference_date` (date) is the manager-facing
    business date and is what managers think of when filtering "show me
    POs for May." Operator-controlled and may be backdated for
    historical accuracy.
  - `received_at::date` is the system-of-record fallback for legacy
    rows pre-dating the `reference_date` column.
  - The existing index `idx_purchase_orders_store_reference_date
    (store_id, reference_date)` lights up for the filter; bare
    `received_at::date` is unindexed.
  - The receipt gate `status = 'received' OR received_at IS NOT NULL`
    excludes `draft`/`sent`/`partial`-without-receipt rows whose
    `reference_date` may be set but whose money hasn't moved yet.

- **Q2: Status filter — `received` only vs all POs?** →
  **`(po.status = 'received' OR po.received_at IS NOT NULL)`** — verbatim
  variance precedent. Rationale: a PO that hasn't been received is not
  real spend yet; receiving is the money-moves event. `partial`-status
  POs with a populated `received_at` are included (rationale: a partial
  receipt represents money that has actually changed hands for the
  portion received; the `po_items.received_qty` field carries the
  actual quantity, so dollar arithmetic stays correct). `draft`/`sent`
  rows without `received_at` are excluded.

- **Q3: KPI tone bands for spend?** →
  **OMIT — all three KPIs emit `"tone": null`.** Rationale: vendor spend
  is not inherently bad. A "warn" tone on $10k of spend would falsely
  flag healthy high-volume stores. Waste's `< $50 ok / $50-$200 warn / >
  $200 danger` band makes sense because all waste is loss; vendor spend
  is just operations. The header MUST document this divergence so
  reviewers comparing the runners side-by-side don't copy-paste the
  waste `case when` block.

- **Q4: Default `group_by`?** →
  **`'vendor'`.** The obvious default for a "spend by vendor" report; the
  catalog-tile copy advertises "vendor · orders · fill % · late · $"
  with vendor as the first column. Toggle offers all three:
  `vendor | category | item`. Same shape as waste's three-mode toggle.

- **Q5: Cost source — `po_items.cost_per_unit` snapshot or
  `inventory_items.cost_per_unit` current?** →
  **`po_items.cost_per_unit` SNAPSHOT.** Mirrors waste using
  `waste_log.cost_per_unit` (the historical snapshot). The `po_items`
  row was created at PO-creation time with the cost the vendor was
  charging us THEN; that's the historically-correct number for "what
  did we spend." `inventory_items.cost_per_unit` is the current value
  (which may have drifted since the PO was received). Rows where
  `cost_per_unit IS NULL` contribute $0 to the dollar number but their
  `received_qty` still surfaces in `total_qty` (so a row with no cost
  doesn't disappear, it just doesn't move the headline). Same shape as
  waste's NULL-cost handling.

- **Q6: Date window — closed `[from, to]` like waste/COGS, or half-open
  `(from, to]` like variance?** →
  **CLOSED `[from, to]`** on the date anchor. Rationale: vendor is an
  event-stream report (POs landed on day X), not anchor-pair
  reconciliation. A manager asking "POs delivered on 2026-06-01"
  expects to see that day's deliveries; half-open would require
  `from='2026-05-31', to='2026-06-01'` which doesn't match the modal's
  "pick a date range" mental model. Waste / COGS are the precedent for
  closed windows; variance's half-open shape exists because anchors are
  submission timestamps, not date ranges. Migration header MUST call
  out the divergence so reviewers comparing the runners don't flag it
  as drift (variance is the outlier here — waste, COGS, and now vendor
  share the closed-window shape).

- **Q7: Does this spec add a new table or migration to
  `purchase_orders` / `po_items` / `vendors`?** →
  **NO.** All three tables exist and are well-populated by the existing
  Purchasing surface. No schema additions, no FK changes, no policy
  changes. The variance migration already established that
  `purchase_orders` per-store RLS works for the runner via the
  `auth_can_see_store` gate inside the RPC body.

- **Q8: Realtime?** →
  **No new subscription.** `purchase_orders` is already on the realtime
  publication via `20260514140000_realtime_publication_tighten.sql:47`
  and the `store-{id}` channel already listens via the per-table filter
  established in spec 029. A new PO written by the Purchasing surface
  triggers a debounced reload — re-running the open Vendor report is
  the user's deliberate action via the RUN button, not a push.

- **Q9: Top vendor KPI — always cross-cut on vendor, or follow the
  `by:` toggle?** →
  **ALWAYS vendor.** Parallel to waste's `Top driver` (always reason).
  Rationale: when the user toggles `by='category'`, they want the
  table sliced by category but the KPI still tells them "where is our
  money going" — vendor is the most-actionable axis. Header documents
  this so reviewers don't propose making it dynamic.

- **Q10: Series shape — one series per vendor, one per category, or
  toggle-driven?** →
  **One series per vendor**, regardless of `by:` toggle. Mirrors waste's
  "one series per reason" decision. Multi-series is supported by
  `react-native-chart-kit` and the existing `ReportDetailFrame` chart
  panel (proven by COGS / waste). Same `< 2 distinct dates → empty
  array` gate as COGS / waste.

- **Q11: Catalog tile copy — rename `'Vendor performance'` →
  `'Vendor spend'` since spec 035 doesn't ship fill rate / on-time?** →
  **NO — keep the existing name.** A rename would imply spec 035 closes
  the "Vendor performance" backlog item, but fill rate / on-time / late
  are valuable future scopes. Keep the tile name aspirational; the
  `sub:` copy and the actual column shape make the spend scope obvious.
  A future spec adding fill-rate / late-rate KPIs would reuse the same
  tile slot.

## Dependencies

- Migration applies cleanly via `npx supabase db push` (no realtime
  publication touch — `purchase_orders` is already published).
- No new edge function deploys.
- No new tables.
- pgTAP test count: 16 files → 17 files. Existing
  `reports_anon_revoke.test.sql` plan grows from 9 → 10.
- Reads from `purchase_orders`, `po_items`, `vendors`,
  `inventory_items`, `catalog_ingredients` (per-store RLS gates already
  in place from spec 020 hardening; vendors are brand-scoped per the
  brand-catalog refactor — the runner reads vendor rows via the
  `vendor_id` FK and RLS lets any authenticated user `SELECT` vendors
  for their brand).
- The remote-schema migration `20260502071736_remote_schema.sql:177`
  already created `idx_purchase_orders_store_reference_date (store_id,
  reference_date)` — the vendor runner inherits that index for its
  store-scoped time-range scan, no new index needed.
- The `po_items.po_id` FK is not indexed by name, but PostgreSQL
  auto-indexes the implicit unique constraint on `purchase_orders.id`
  primary key and the per-row join is bounded by the
  `purchase_orders` filter result; at production data scale (~1k POs /
  store-month with ~10 lines each) this is acceptable. If the runner
  becomes slow under load, a follow-up spec can add
  `idx_po_items_po_id`; not in scope here.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. `src/screens/cmd/sections/
  ReportsSection.tsx` is the only Reports surface (legacy admin was
  deleted in spec 025).
- **Per-store or admin-global:** Per-store. The RPC's
  `auth_can_see_store(p_store_id)` gate enforces it; admins/masters
  still see cross-store via the same helper.
- **Realtime channels touched:** None added. The `store-{id}` channel
  already includes `purchase_orders` since
  `20260514140000_realtime_publication_tighten.sql`. The detail frame
  does NOT auto-rerun on PO inserts (re-run is the user's action via
  the RUN button).
- **Migrations needed:** YES — one new SQL migration creating
  `report_run_vendor(uuid, jsonb)` + re-creating the dispatcher with
  the `'vendor'` arm. No realtime publication change. No new index
  (remote-schema migration already added the matching one).
- **Edge functions touched:** None.
- **Web/native scope:** Both. No web-only or native-only code. The
  Reports section is Cmd UI which runs on both surfaces via the
  existing `CmdNavigator` shell.
- **Tests track:** pgTAP (`supabase/tests/report_run_vendor.test.sql`
  new file) + pgTAP edit (`reports_anon_revoke.test.sql` adds one
  arm). No new jest. No new shell smoke. Test-engineer routes
  accordingly per spec 022's three tracks.
- **app.json slug:** Not touched. Locked to `towson-inventory` per the
  CLAUDE.md DO-NOT-AUTO-FIX rule.

## Handoff

Backend-architect will: (a) confirm the column-key naming policy
extends cleanly to four `by:` modes (waste's three: reason / category
/ item; vendor's three: vendor / category / item — the architect §A1
"per-mode named keys" policy still applies — but the union of all
keys across all live templates is now 5: reason, vendor, category,
item, plus the per-mode analytic keys), (b) pin the migration
filename + timestamp (next free hour-slot on the 2026-05-14 cluster
following waste's `170000`), (c) decide whether the
`auth_can_see_store` gate inside the RPC is sufficient for the
brand-scoped `vendors` join (no additional vendor-RLS check needed —
the per-brand SELECT policy already lets authenticated users read
vendor names for joined POs), and (d) decide whether the
`OverrideState['by']` widening (which is a non-breaking type union
extension) flags any saved-definition migration concern (it does
not — the union is purely TypeScript-side and the RPC coerces unknown
values).

## Architect design

Spec 034 (waste) established the byte-for-byte template the vendor runner
copies. This section confirms each design decision the PM resolved, pins
the filename + dispatcher slot, and walks the developer through every
delta from waste.

### A1 — Migration filename slot

`supabase/migrations/20260514180000_report_run_vendor.sql`.

Slot rationale: the 2026-05-14 cluster currently ends at `170000`
(`20260514170000_report_run_waste.sql`). `180000` is the next free
hour-slot, mirrors waste's spacing convention, and keeps the per-day
cluster contiguous. No realtime publication touch, no out-of-band
ordering concern.

### A2 — Function signature + security shape

Verbatim from waste, with the obvious rename:

```sql
create or replace function public.report_run_vendor(
  p_store_id uuid,
  p_params   jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  -- ... typed locals ...
begin
  -- (1) AUTH GATE
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;
  -- ...
end;
$$;

revoke execute on function public.report_run_vendor(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_vendor(uuid, jsonb) to authenticated;
```

Identical to `20260514170000_report_run_waste.sql:63-92` and `:411-412`.
The `auth_can_see_store(p_store_id)` gate is sufficient for the
brand-scoped `vendors` join — the per-brand SELECT policy on `vendors`
lets any authenticated user read vendor names; the runner's vendor name
resolution is a read-only display join, not a write. No additional
vendor-RLS check needed inside the RPC body.

### A3 — Migration header design notes

The header must spell out the five divergences/load-bearing absences
spec 034 documents, with vendor-specific wording. The waste header at
`:1-61` is the model. The vendor header MUST include:

1. **Per-mode named keys** — `by='vendor'` → rows have a `vendor` key;
   `by='category'` → `category`; `by='item'` → `item`. Shared analytic
   keys: `po_count`, `items_affected`, `total_qty`, `unit`, `dollar_impact`.
2. **Closed `[from, to]` window divergence from variance** — copy the
   waste header's note verbatim; variance is the outlier. Cite COGS line
   297 as the precedent.
3. **Cost source — `po_items.cost_per_unit` SNAPSHOT only.** Captured at
   PO-creation time. No fallback to `inventory_items.cost_per_unit`.
   NULL cost → row contributes $0 to `Total spend $`; qty still
   surfaces in `total_qty`. Mirrors waste's stance, citing the
   variance multivendor migration `:347-348` as the join precedent.
4. **No recursive prep-recipe CTE.** Same load-bearing absence as
   waste; `po_items` references `inventory_items.id` directly. Future
   contributors: don't add one.
5. **Tone bands explicitly OMITTED.** All three KPIs emit `"tone": null`.
   Vendor spend is not inherently bad. Header MUST instruct reviewers
   not to copy-paste waste's `case when total < 50 then 'ok' ...` block.
6. **`from == to` is ALLOWED** — single-day vendor reports are
   meaningful (e.g. "what did we receive yesterday").
7. **Top vendor KPI cross-cuts.** Computed via `vendor` grouping
   regardless of the `by:` toggle. Omitted (not zero-valued) when no
   rows or when guard `top_vendor_dollar > 0` fails.
8. **Series cross-cuts.** ONE series per `vendor`, multi-line,
   regardless of the `by:` toggle. Empty array (`'[]'::jsonb`) when
   fewer than 2 distinct anchor dates have matched rows; never `null`.
9. **Index reuse.** `idx_purchase_orders_store_reference_date
   (store_id, reference_date)` from
   `20260502071736_remote_schema.sql:177` covers the store-scoped
   time-range scan. No new index in this migration.
10. **Status filter** — `(po.status = 'received' OR po.received_at IS
    NOT NULL)`. Mirrors the variance precedent. Header must call this
    out because it's the load-bearing exclusion that makes the dollar
    arithmetic match what managers see in their PO log.

### A4 — SQL CTE pipeline skeleton

Three branched arms mirror waste's three. Each arm re-walks its own
base CTE for the same reason waste does — plpgsql can't share a CTE
across statements.

**Shared prelude** (sections 1-3 of the function body):

```
(1) AUTH GATE — auth_can_see_store(p_store_id) → 42501 if false.
(2) PARAM COERCION:
    v_from := coalesce(nullif(p_params->>'from','')::date,
                       ((now() at time zone 'utc')::date - interval '30 days')::date);
    v_to   := coalesce(nullif(p_params->>'to','')::date,
                       (now() at time zone 'utc')::date);
    v_by   := coalesce(nullif(p_params->>'by',''), 'vendor');
    if v_by not in ('vendor','category','item') then v_by := 'vendor'; end if;
(3) RANGE VALIDATION — if v_from > v_to then raise 22023
    'Vendor report: from > to (% > %)'.
```

**Section 4 — columns built up-front** (so the empty-result branch can
return them without re-deciding on `by`):

```
v_by = 'vendor':
  [vendor, po_count, total_qty, dollar_impact]
v_by = 'category':
  [category, po_count, items_affected, total_qty, dollar_impact]
v_by = 'item':
  [item, category, po_count, total_qty, unit, dollar_impact]
```

`po_count` is `count(distinct po_id)` within the group key.
`items_affected` (category mode only) is `count(distinct po_items.item_id)`.

**Section 5 — totals + top-vendor lookup** (single pass, mirrors waste
`:154-186`):

```sql
with base as (
  select
    po.id                                                       as po_id,
    pi.item_id,
    coalesce(po.reference_date, po.received_at::date)           as biz_date,
    coalesce(pi.received_qty, 0)::numeric                       as qty,
    (coalesce(pi.received_qty, 0)::numeric
      * coalesce(pi.cost_per_unit, 0)::numeric)                 as dollar,
    coalesce(v.name, case when po.vendor_id is null
                           then '(no vendor)'
                           else '(deleted vendor)' end)         as vendor
  from public.purchase_orders po
  join public.po_items pi      on pi.po_id = po.id
  left join public.vendors v   on v.id = po.vendor_id
  where po.store_id = p_store_id
    and (po.status = 'received' or po.received_at is not null)
    and coalesce(po.reference_date, po.received_at::date) >= v_from
    and coalesce(po.reference_date, po.received_at::date) <= v_to
),
totals as (
  select coalesce(sum(dollar), 0)::numeric  as total_dollar,
         coalesce(sum(qty),    0)::numeric  as total_qty,
         count(*)                           as row_count,
         count(distinct po_id)              as po_count,
         count(distinct biz_date)           as distinct_dates
  from base
),
top_vendor as (
  select vendor, sum(dollar)::numeric as dollar
  from base
  group by vendor
  order by sum(dollar) desc, vendor asc
  limit 1
)
select t.total_dollar, t.total_qty, t.row_count, t.po_count, t.distinct_dates,
       tv.vendor,      tv.dollar
  into v_total_dollar, v_total_qty, v_row_count, v_po_count, v_distinct_dates,
       v_top_vendor,   v_top_vendor_dollar
  from totals t
  left join top_vendor tv on true;
```

Note: `top_vendor` discriminates `'(no vendor)'` vs `'(deleted vendor)'`
correctly because they're literal strings produced by the `coalesce`
chain — they group separately and tiebreak alphabetically.

**Section 6 — empty-result short-circuit:**

```
if v_row_count = 0 then return populated columns + empty [] for kpis/rows/series;
```

**Section 7 — KPI assembly:**

```
kpis = [
  { label: 'Total spend $', value: '$' || to_char(v_total_dollar, ...), tone: null },
  -- 'Top vendor' KPI:
  --   include iff v_top_vendor is not null AND v_top_vendor_dollar > 0;
  --   value = v_top_vendor || ' · $' || to_char(v_top_vendor_dollar, ...)
  --   tone: null
  -- (guard against all-NULL-cost edge case where dollar = 0)
  { label: 'POs in period', value: v_po_count, tone: null },
]
```

ALL THREE KPIs emit `"tone": null` per Q3. Mirror waste's structure of
appending the top-driver KPI mid-array via a guard branch, but with
ALL tones nulled. `'POs in period'` uses `v_po_count` (distinct
`po_id` from the totals CTE), NOT `v_row_count` (which is line count,
not PO count).

**Section 8 — rows** (three branched arms; each re-walks its own base):

- `by='vendor'`: base CTE selects `(po_id, item_id, vendor, qty, dollar)`
  with the same vendor coalesce as section 5; grouped by `vendor`;
  aggregates `count(distinct po_id) as po_count`, `sum(qty)`, `sum(dollar)`;
  row object: `{ vendor, po_count, total_qty, dollar_impact }`.
  Sort: `dollar desc, vendor asc`.
- `by='category'`: base CTE adds the `inventory_items` → `catalog_ingredients`
  left-join chain for `category`. Grouped by `category`. Aggregates
  `count(distinct po_id) as po_count`, `count(distinct item_id) filter
  (where item_id is not null) as items_affected`, `sum(qty)`, `sum(dollar)`.
  Row object: `{ category, po_count, items_affected, total_qty,
  dollar_impact }`. Sort: `dollar desc, category asc`.
- `by='item'`: base CTE adds `inventory_items` + `catalog_ingredients`
  left-join for `(item_name, category, unit)`. `item_name` coalesces to
  `'(deleted item)'`; `category` coalesces to `'(uncategorized)'`;
  `unit` coalesces to `''`. Grouped by `(item_name, category, unit)`.
  Aggregates `count(distinct po_id) as po_count`, `sum(qty)`,
  `sum(dollar)`. Row object: `{ item, category, po_count, total_qty,
  unit, dollar_impact }` — NO `items_affected`. Sort: `dollar desc,
  item_name asc`.

Format masks (mirror waste verbatim):
- Dollar: `'$' || to_char(v, 'FM999,999,990.00')` when v >= 0, else
  `'-$' || to_char(abs(v), 'FM999,999,990.00')`. Vendor spend should
  always be non-negative; the negative branch is a forward-compat
  guard.
- Qty: `to_char(v, 'FM999,990.000')`.

**Section 9 — series** (one per vendor, multi-line, regardless of `by:`):

```
if v_distinct_dates < 2 then v_series := '[]'::jsonb;
else
  with base as ( /* same shape as section 5 base, selecting biz_date + vendor + dollar */ ),
  daily_by_vendor as (
    select vendor, biz_date, sum(dollar)::numeric as dollar
    from base
    group by vendor, biz_date
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'label', vendor,
      'x',     to_char(biz_date, 'YYYY-MM-DD'),
      'y',     round(dollar, 2)
    ) order by vendor asc, biz_date asc
  ), '[]'::jsonb)
    into v_series
    from daily_by_vendor;
end if;
```

**Section 10 — final envelope:**

```sql
return jsonb_build_object(
  'kpis',    v_kpis,
  'columns', v_columns,
  'rows',    v_rows,
  'series',  v_series
);
```

### A5 — Dispatcher arm placement

Re-create `public.report_run(text, uuid, jsonb)` in full (same shape as
`20260514170000_report_run_waste.sql:425-460`). The `'vendor'` arm
slots immediately after `'waste'`:

```sql
case p_template_id
  when 'stub'     then return public.report_run_stub(p_store_id, p_params);
  when 'cogs'     then return public.report_run_cogs(p_store_id, p_params);
  when 'variance' then return public.report_run_variance(p_store_id, p_params);
  when 'waste'    then return public.report_run_waste(p_store_id, p_params);
  when 'vendor'   then return public.report_run_vendor(p_store_id, p_params);
  else
    return jsonb_build_object(
      'kpis',     '[]'::jsonb,
      'columns',  '[]'::jsonb,
      'rows',     '[]'::jsonb,
      'series',   null,
      '_status',  'not_implemented',
      '_message', 'Runner coming soon · definition saved'
    );
end case;
```

Preserves the existing arms verbatim. Signature unchanged → `create or
replace` handles the swap without breaking outstanding grants.
`revoke`/`grant` lines below the function definition are re-issued
verbatim from waste `:462-463`.

### A6 — pgTAP plan(11) — arm-by-arm enumeration

New file: `supabase/tests/report_run_vendor.test.sql`. Mirrors
`report_run_waste.test.sql` (sibling file). Fixture pattern: hermetic
`begin; ... rollback;`, manager JWT `22222222-...`, Frederick store
lookup, two pre-resolved `inventory_items` ids.

Plan(11) arms, in order:

1. **Fixture sanity (1)** — `current_setting('test.frederick_id')`
   non-empty.
2. **Fixture sanity (2)** — `current_setting('test.item_id')` non-empty
   (Frederick `inventory_item` with `cost_per_unit > 0`).
3. **Auth gate** — manager calling `report_run_vendor(<charles_id>,
   '{}')` raises `42501`. Mirrors waste arm (3).
4. **Empty range** — `from = to = '2000-01-01'`, `by='vendor'`. Assert
   `kpis_len = 0`, `rows_len = 0`, `series_len = 0`, `cols_typeof =
   'array'`, `cols_first = 'vendor'`. Mirrors waste arm (4).
5. **Single-row happy path** — insert one `purchase_orders` row
   (`status='received'`, `reference_date='2026-06-01'`,
   `vendor_id=<seeded vendor>`, `received_at=<some ts>`) and one
   `po_items` row (`received_qty=10`, `cost_per_unit=2.50`,
   `item_id=<test.item_id>`). Call with `from=to='2026-06-01'`,
   `by='vendor'`. Assert:
   - `kpis[label='Total spend $'].value = '$25.00'`
   - `rows` length = 1, `rows[0].vendor = <vendor name>`,
     `rows[0].total_qty = '10.000'`,
     `rows[0].dollar_impact = '$25.00'`,
     `rows[0].po_count = 1`.
   - Combine into a single `is(jsonb_build_object(...), ...)`
     assertion to stay within plan budget (same as waste arms 5-7
     are split, but the spec budget for vendor includes the
     status-filter as an extra arm so we condense single-row
     formula assertions where possible).
6. **Missing-cost zero-out** — insert a second `po_items` row on the
   same PO with `cost_per_unit = NULL`, `received_qty = 1`. Re-call.
   Assert that row's `dollar_impact = '$0.00'` and that `Total spend
   $` headline did NOT change (the row contributes $0). Mirrors
   waste arm (8). No `⚠` suffix per the waste precedent.
7. **Multi-vendor ordering** — insert a second `purchase_orders` row
   for the same date with a *different* `vendor_id` and a smaller
   `received_qty * cost_per_unit` than the first (so the original
   vendor outranks it). Assert ordered vendor names from
   `array_agg(rows[i].vendor order by i)` come out
   `[<higher-dollar vendor>, <lower-dollar vendor>]`. Mirrors waste
   arm (9).
8. **Status filter (unique-to-vendor regression)** — insert a third
   `purchase_orders` row with `status='draft'` AND `received_at IS
   NULL`, same date / vendor / item / qty / cost as the row from
   arm (5). Re-call. Assert `rows` length unchanged (the draft row
   does NOT add a row) AND `Total spend $` unchanged (the draft
   row's dollar does NOT contribute). This regression vector does
   not exist in waste (no status field on `waste_log`); vendor MUST
   cover it.
9. **`by='category'` smoke** — re-call with `by='category'`. Assert
   `env->'columns'->0->>'key' = 'category'` AND
   `env->'rows'->0->'category' IS NOT NULL`.
10. **`by='item'` smoke** — re-call with `by='item'`. Assert
    `env->'columns'->0->>'key' = 'item'` AND
    `env->'rows'->0->'item' IS NOT NULL` AND
    `'unit' = ANY(array_agg(c->>'key' from columns c))` (per-mode
    `unit` column present).
11. **Envelope shape** — sorted-key list assertion identical to waste
    arm (10): `array_agg(k order by k) where k in (...) = array['columns',
    'kpis', 'rows', 'series']::text[]`.

**Per-arm budget note**: arm (5) condenses "kpi + per-row" assertions
into one `is(jsonb_build_object(...), ...)` to keep plan(11). This
follows the spec 016 / variance precedent of multi-field condensation
when arm-budget pressure exists. If the developer would rather split
into plan(12) for clarity, that's acceptable — the
`reports_anon_revoke.test.sql` plan change is unaffected.

**Anon-revoke arm (existing file edit):**
`supabase/tests/reports_anon_revoke.test.sql` — bump `plan(9)` →
`plan(10)`, update the leading comment block from "8 RPCs covered"
→ "9 RPCs covered" → wait, sanity check: the existing comment at
`:10` already lists `report_run_waste` as the 5th of 8 (so the file
covers 8 RPCs not 9). Adding vendor makes it 9 RPCs covered total.
The comment block in the file's current state actually reads "8 RPCs
covered" and waste was added as the 5th arm — confirm by reading
`:10-22` before editing.

  Wait — the spec at line 269-274 claims plan goes 9 → 10 and the file
  goes "8 RPCs covered" → "9 RPCs covered" → "10 RPCs covered" (waste
  added 8→9, vendor takes it to 10). Confirming against the actual
  current file: `plan(9)` is already there (waste added the 9th
  arm); comment header says "8 RPCs covered" (stale by one — waste
  edit forgot to bump it from 8 to 9). The vendor migration's
  developer should:
  1. Bump `plan(9)` → `plan(10)`.
  2. Update the comment block from "8 RPCs covered" → "9 RPCs covered"
     (a stale-header backfix from spec 034) and then to "10 RPCs
     covered" with the new vendor arm. Net: comment goes 8 → 10 in
     a single edit; developer should add both lines (waste +
     vendor) to the bullet list.
  3. Slot the new `throws_ok` arm AFTER the existing `(5) report_run_waste`
     block and BEFORE the `(6) report_reorder_list` block — keep the
     numeric ordering tight. Renumber `(6)..(8)` → `(7)..(9)` for
     the trailing arms.

**Reasoning for arm (8) being unique-to-vendor:** vendor is the only
runner that touches a table with a `status` column whose values gate
inclusion. The variance multivendor receiving CTE filters on the
same predicate (`po.status = 'received' or po.received_at is not
null`) but variance's own pgTAP coverage tests the joined output,
not the gate. A `status='draft'` row that contributes spend is the
most likely regression vector if someone later refactors the WHERE
clause — arm (8) catches it at the source.

### A7 — Frontend wiring (file-by-file)

Four files. All edits are mechanical type-union widenings plus the
template flip. No new components, no new helpers, no new db.ts
helpers, no useStore.ts changes.

**1. `src/screens/cmd/sections/reports/templates.ts`**

- Line 31 (the `vendor` row): flip `status: 'preview'` → `status:
  'live'`.
- Line 13-14 (the comment block above `TEMPLATES`): append a line:
  `// Spec 035 flipped 'vendor' to 'live' (see
  '20260514180000_report_run_vendor.sql').`
- Keep `name: 'Vendor performance'` and the existing `sub` / `cols`
  copy (per Q11 — the tile copy is aspirational; a future spec
  shipping fill-rate / on-time can revisit).

**2. `src/components/cmd/NewReportModal.tsx`**

- Line 70 (`type ByOption = 'reason' | 'category' | 'item';`):
  widen to `type ByOption = 'reason' | 'vendor' | 'category' | 'item';`.
- Lines 71-74 (the `BY_OPTIONS` record): add a third entry
  `vendor: ['vendor', 'category', 'item'] as const`. Final shape:
  ```ts
  const BY_OPTIONS: Record<string, ReadonlyArray<ByOption>> = {
    cogs:   ['category', 'item'] as const,
    waste:  ['reason', 'category', 'item'] as const,
    vendor: ['vendor', 'category', 'item'] as const,
  };
  ```
- Lines 77-81 (`defaultByForTemplate`): extend the ternary to return
  `'vendor'` for the vendor template; keep `'reason'` for waste; keep
  `'category'` fallback. Suggested shape:
  ```ts
  function defaultByForTemplate(templateId: string): ByOption {
    if (templateId === 'waste')  return 'reason';
    if (templateId === 'vendor') return 'vendor';
    return 'category';
  }
  ```
- Line 115 (the `useState<'reason' | 'category' | 'item'>(...)`):
  widen the union to include `'vendor'`. The `defaultByForTemplate`
  call inside the initializer already returns the right type — no
  default change.
- No other edits. The `BY_OPTIONS[picked] ?? DEFAULT_BY_OPTIONS`
  pattern at line 540 already routes through the registry; the new
  `vendor: [...]` entry lights up automatically.
- The save-time params block (line 263-270) already produces
  `{ range, from, to, by }` for any non-variance template; no edit.

**3. `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`**

- Line 60-61 (the `Props` interface): widen
  `overrideBy?: 'reason' | 'category' | 'item' | null;` →
  `overrideBy?: 'reason' | 'vendor' | 'category' | 'item' | null;`
  and `onByChange?: (...)` similarly.
- Line 188-191 (`savedBy` parser): admit a fourth arm for `'vendor'`:
  ```ts
  const savedBy: 'reason' | 'vendor' | 'category' | 'item' =
    rawSavedBy === 'item'   ? 'item'   :
    rawSavedBy === 'reason' ? 'reason' :
    rawSavedBy === 'vendor' ? 'vendor' :
    'category';
  ```
- Line 198 (`effectiveBy`): widen the type annotation to include
  `'vendor'`.
- Line 254 (`onPickBy`): widen the parameter type union.
- Line 263-266 (`byOpts`): gain the third per-template branch:
  ```ts
  const byOpts: ReadonlyArray<'reason' | 'vendor' | 'category' | 'item'> =
    definition.templateId === 'waste'  ? (['reason', 'category', 'item'] as const) :
    definition.templateId === 'vendor' ? (['vendor', 'category', 'item'] as const) :
                                          (['category', 'item'] as const);
  ```
- Lines 655-658 (the `ByPopover` props at the bottom of the file):
  widen the `effective`, `options`, and `onPick` union types
  identically.

**4. `src/screens/cmd/sections/ReportsSection.tsx`**

- Line 40 (the `OverrideState['by']` annotation): widen
  `'reason' | 'category' | 'item'` →
  `'reason' | 'vendor' | 'category' | 'item'`.
- Line 177 (`setOverrideBy` signature): widen the same way.
- Line 274 (the `overrideBy={...}` prop pass): no change — the
  underlying `selectedOverride?.by` already flows from the widened
  `OverrideState`.
- No other edits. The `selectedSupportsBy` gate at line 241
  (`selectedIsLive && selectedTemplate?.id !== 'variance'`) already
  fires for vendor as soon as templates.ts flips it to `'live'`.

### A8 — Cross-cutting confirmations

- **No realtime publication change.** `purchase_orders` and
  `vendors` are already on `supabase_realtime` per
  `20260514140000_realtime_publication_tighten.sql:47` and `:52`.
  `po_items` is NOT on the publication and does NOT need to be —
  the vendor RPC reads but does not subscribe; section-level
  reloads from a new PO already fire via `purchase_orders`. No
  `docker restart supabase_realtime_imr-inventory` step in this
  migration.
- **No edge function changes.** Pure RPC.
- **No `src/lib/db.ts` change.** The runner is dispatched through the
  existing `runReport` store action which routes through the
  existing `report_run(p_template_id, p_store_id, p_params)`
  PostgREST call. The dispatcher arm makes the new template
  reachable without a new helper.
- **No `src/store/useStore.ts` change.** The `runReport` action and
  the `reportRuns` cache are template-agnostic.
- **No `app.json` change.** Per CLAUDE.md DO-NOT-AUTO-FIX rule, the
  slug stays `towson-inventory`.
- **No new table.** Reads from existing `purchase_orders`, `po_items`,
  `vendors`, `inventory_items`, `catalog_ingredients`.
- **No new index.** `idx_purchase_orders_store_reference_date
  (store_id, reference_date)` from
  `20260502071736_remote_schema.sql:177` is sufficient. If
  production data scale eventually warrants `idx_po_items_po_id`,
  that's a follow-up spec — out of scope here.
- **`OverrideState` widening is non-breaking.** The TS union is
  purely a typed boundary in `ReportsSection`. The RPC coerces
  unknown values to its own default per the param-coercion logic
  in section (2) of the function body. A user who somehow saves a
  COGS definition with `by='vendor'` has no path through the UI to
  do so (the modal's `BY_OPTIONS[picked]` gates this), but even if
  they did, the COGS RPC silently coerces to `'category'`. No
  saved-definition migration concern.

### A9 — Verification gates

Per the PM's list at spec line 285-306, plus the pgTAP count delta:

1. `npx tsc --noEmit` → exit 0.
2. `npm run typecheck:test` → exit 0.
3. `npm test -- --ci` → PASS (jest count unchanged at 54 — no new
   `.test.ts` files in this spec).
4. `npm run test:db` → PASS:
   - pgTAP file count `find supabase/tests -name '*.test.sql' | wc -l`
     moves from **16 → 17**.
   - `reports_anon_revoke.test.sql` plan moves from **plan(9) →
     plan(10)** (developer also fixes the stale "8 RPCs covered"
     header from spec 034 → "10 RPCs covered" inclusive of both
     waste + vendor).
   - `report_run_vendor.test.sql` plan(11) — 11 of 11 PASS.
5. `npm run test:smoke` → PASS (no new arms; sanity check the
   `report_run('stub', ...)` dispatcher smoke still green; if the
   `scripts/smoke-rpc.sh` includes a template-coverage matrix arm,
   it does not need a new template entry — the dispatcher arm
   itself is what gets exercised, and it's covered by the existing
   `'stub'` call).
6. Manual browser smoke after `npm run dev` against local stack
   (PM's bullets at spec lines 292-305) — RUN button produces:
   - kpis bar showing `Total spend $`, `Top vendor`, `POs in period`
     with `tone: null` (no color band) on all three;
   - rows table with vendor-grouped rows, dollar-desc sorted;
   - multi-line chart with one series per vendor.
   - Toggle `by:` chip → re-runs, rows + columns flip per-mode.
   - Toggle preset range chip → re-runs against the new window.
   - PREVIEW badge gone from the catalog tile.

### A10 — Post-merge deploy step

Single command (no realtime restart, no edge function deploy):

```
npx supabase db push --linked --yes
```

The migration file itself is additive (new function + dispatcher
re-create with one new arm). Rollout safety:
- `create or replace function public.report_run_vendor(...)` is
  idempotent — re-running the migration is a no-op.
- `create or replace function public.report_run(...)` swaps the
  dispatcher in-place; outstanding `grant`s on the dispatcher
  survive `create or replace` per Postgres semantics (waste
  established this — see waste header `:419-421`).
- Roll back by reverting the migration file and re-running an older
  dispatcher migration; the vendor function can stay orphaned
  (no one calls it once the dispatcher arm is gone). Operationally
  cleaner: ship a follow-up migration that `drop function
  public.report_run_vendor(uuid, jsonb)` + re-creates the
  dispatcher without the arm. Not needed unless something blows up
  in production.

No CI gate. Per CLAUDE.md "CI workflow" — manual migration
verification is current reality. Developer should:
1. Apply against local stack first (`npm run dev:db` is already up
   from baseline; `npx supabase db reset` re-applies fresh).
2. Run pgTAP locally (`npm run test:db`).
3. After PR merge, `npx supabase db push --linked --yes` against
   the linked remote project.

### A11 — Risks and tradeoffs

- **Performance risk on large stores.** At seed-scale (~1k POs per
  store-month, ~10 line items per PO) the per-store time-range scan
  is cheap. The `(store_id, reference_date)` index covers the outer
  filter; the `po_items.po_id` foreign-key relationship is
  unindexed by name but Postgres uses the `purchase_orders.id`
  primary-key index for the implied join. If production scales to
  10k+ POs/store-month, a follow-up spec adds `idx_po_items_po_id`;
  no need to ship it preemptively.
- **`top_vendor` discrimination of `'(no vendor)'` vs `'(deleted
  vendor)'`.** Both labels group separately in the `top_vendor`
  CTE. If a store has 80% of spend on `vendor_id IS NULL` rows
  (e.g. data quality regression), `Top vendor` will surface
  `'(no vendor)' · $X,XXX.XX` — which is correct behaviour
  (informative, not a bug) but operators may file it as one.
  Mitigation: the `sub`-copy on the catalog tile already reads
  "vendor · orders · fill % · late · $" — operators understand
  the report is vendor-keyed.
- **Tone-band omission divergence from waste.** Reviewers comparing
  the waste header to the vendor header WILL notice the missing
  `case when v_total_dollar < 50 then 'ok' ...` block. The header
  MUST call out the divergence explicitly (per A3 §5) so this
  reads as intentional, not as an incomplete copy-paste.
- **Single-arm anon-revoke test stale comment.** The existing
  `reports_anon_revoke.test.sql:10` comment block reads "8 RPCs
  covered" but the file actually covers 9 today (waste was added
  in spec 034 without bumping the comment). The vendor edit
  should fix the stale comment at the same time it adds the new
  arm — same line of work, low marginal risk.
- **Forward-compat for future `by:` axes.** If a future template
  adds a fifth `by:` value (e.g. `'period'` for a date-bucketed
  report), the UI union widening pattern accumulates. At ~6
  templates total, the `BY_OPTIONS` registry is still tractable;
  if it grows to ~12, a refactor to a per-template options-prop
  on the template definition itself is warranted. Out of scope
  for spec 035.

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec. Single agent — RPC
  migration + pgTAP test + small TypeScript union widenings across four
  frontend files. After implementation, set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - specs/035-reports-vendor-template/spec.md

## Files changed

### Migrations
- `supabase/migrations/20260514180000_report_run_vendor.sql` (new) —
  defines `public.report_run_vendor(uuid, jsonb)` with the per-mode
  named-keys envelope, status filter, NULL-cost zero-out, multi-line
  vendor series, and re-creates the `report_run` dispatcher with the
  new `'vendor'` arm slotted after `'waste'`. Header documents the
  10 architect §A3 design notes (tone-band omission divergence from
  waste, closed-window divergence from variance, etc.).

### pgTAP tests
- `supabase/tests/report_run_vendor.test.sql` (new) — plan(11)
  hermetic test: fixture sanity (×2), auth gate 42501, empty-range
  envelope, single-row formula, multi-vendor ordering, status-filter
  regression (load-bearing arm 7 — unique-to-vendor), missing-cost
  zero-out, by=category smoke, by=item smoke (with `unit` column),
  envelope shape.
- `supabase/tests/reports_anon_revoke.test.sql` (modified) — plan
  9 → 10; added `report_run_vendor` arm (6) between waste and
  reorder; renumbered subsequent arms; fixed stale "8 RPCs covered"
  header → "10 RPCs covered" (back-fix from spec 034).

### Frontend
- `src/screens/cmd/sections/reports/templates.ts` — flipped
  `vendor.status: 'preview' → 'live'`; added spec-035 comment in the
  preamble.
- `src/components/cmd/NewReportModal.tsx` — widened `ByOption` union
  to admit `'vendor'`; added `vendor` entry to `BY_OPTIONS` registry;
  extended `defaultByForTemplate` to return `'vendor'` for the vendor
  template; widened the `by` useState union.
- `src/screens/cmd/sections/ReportsSection.tsx` — widened
  `OverrideState['by']` and `setOverrideBy` signature to admit
  `'vendor'`.
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` — widened
  `overrideBy`/`onByChange` prop types; admitted a fourth arm for
  `'vendor'` in the `savedBy` parser; widened `effectiveBy` /
  `onPickBy` types; extended `byOpts` with the vendor branch; widened
  the `ByPopover` prop union types to match.

### Spec
- `specs/035-reports-vendor-template/spec.md` — `Status:` flipped to
  `READY_FOR_REVIEW`; added this `## Files changed` section.

## Post-merge deploy

`npx supabase db push --linked --yes` applies the new migration to the
linked remote project. No realtime publication change (so no
`docker restart` step); no edge function deploy; no new indexes; no
new tables. DO NOT run `db push` automatically — flagged by the
backend-developer for release-coordinator to surface in the proposal.

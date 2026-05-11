# Reports runner — remaining template backlog

The Reports section ships 6 templates. Two are live as of 2026-05-10:

- ✅ `cogs` — Spec [017](017-reports-cogs-template/spec.md) (`d0155f4`)
- ✅ `variance` — Spec [018](018-reports-variance-template/spec.md) (`688c7aa`)

Four are still rendering as PREVIEW tiles, returning `not_implemented` envelopes from the dispatcher. Each would be its own future spec following the proven `report_run_<template>(p_store_id, p_params jsonb) returns jsonb` pattern from spec 016's foundation.

## Foundation already in place (don't re-design)

- `report_runs` table + per-store RLS + consistency trigger ([016](016-reports-runner-foundation/spec.md))
- Per-template RPC contract: `security invoker`, `set search_path = public`, `grant execute to authenticated; revoke from public, anon;`, first gate `auth_can_see_store(p_store_id)` raising `42501`, uniform envelope `{ kpis, columns, rows, series }`
- Dispatcher `public.report_run(text, uuid, jsonb)` — add a new `when '<id>'` arm per template
- Recursive prep-recipe CTE pattern with depth-5 cap + cycle detection + `' ⚠'` / `' ⚠ (truncated)'` row suffixes — see `report_run_cogs` ([migration 20260511120000](../supabase/migrations/20260511120000_report_run_cogs.sql))
- Per-store inventory cost join: `recipe_ingredients.catalog_id → inventory_items WHERE store_id = p_store_id` (P3 lockdown, see migration 20260504072830)
- Frontend: `templates.ts` flip `status: 'preview'` → `'live'` makes the catalog tile drop its badge; `ReportDetailFrame` is template-agnostic — only the column/series mapping is per-template; `NewReportModal` already gates the params section on `template.status === 'live'`
- `db.runReport` / `useStore.runReport` accept `overrideParams` for in-frame chip overrides ([017](017-reports-cogs-template/spec.md))
- Date helpers extracted to [`src/utils/reportDates.ts`](../src/utils/reportDates.ts) — `toISODate`, `isISODate`, `computePreset`, `PresetId`

## Backlog priority

The user's original priority (2026-05-10) was COGS + Variance first. The remaining 4 are unordered — pick whichever has the strongest current business signal. Suggested order by ease and likely impact:

1. **`waste`** — easiest. `waste_log` table already exists and is well-populated. Pure aggregation, no recursive CTE needed.
2. **`velocity`** — medium. Needs to join sales depletion (already implemented in variance) with current stock for "days on hand."
3. **`vendor`** — medium. Needs purchase-order receiving history with received-vs-ordered deltas.
4. **`custom`** — largest. Needs a sandboxed SQL exec edge function — separate large spec.

---

## Spec stub: `waste` — Waste cost report

**Template ID:** `waste`  
**Catalog text:** "Waste cost · by reason & category"  
**Columns hint:** `date · item · qty · reason · $cost`  
**Status today:** PREVIEW, dispatcher returns `not_implemented`.

### What it computes

Total waste dollars over a date range, broken down by reason and/or category. Surfaces which categories or reasons drive the most loss.

### Data needed

- `waste_log` table — already exists. Schema: `(id, item_id, store_id, quantity, cost_per_unit, reason, logged_at, ...)`. The `cost_per_unit` snapshot on each row means you don't need to re-join `inventory_items` for cost — but DO join for `category` (via `inventory_items.category_id` if the column is there, or whatever the brand-catalog refactor settled on for category resolution).
- `inventory_items` for item name + category lookup.
- No recursive CTE needed — waste rows are already at the granular level.

### SQL shape sketch

```sql
with waste_in_range as (
  select wl.item_id, ii.name, ii.category_id, wl.quantity, wl.cost_per_unit, wl.reason,
         wl.logged_at::date as date,
         wl.quantity * wl.cost_per_unit as dollar_impact
  from waste_log wl
  join inventory_items ii on ii.id = wl.item_id and ii.store_id = wl.store_id
  where wl.store_id = p_store_id
    and wl.logged_at::date > v_from and wl.logged_at::date <= v_to
)
-- aggregate by reason (default) or by category per p_params->>'by'
```

### Open questions for the spec

1. `by:` toggle options — reason / category / item? COGS used category/item; waste's most useful axis is probably reason but category is also high-signal. Pick 2 or 3.
2. Series shape — `series: [{ label: reason, x: date, y: $cost }]` would give a stacked-line view of reasons over time. Multi-series chart is more useful than single-series here.
3. Should the report exclude `reason='expired_in_storage'` (or whatever the auto-expiry code is) from the headline KPI since it's "normal" depreciation? Surface to user.
4. Match COGS's hardcoded thresholds? Probably no — waste targets are brand-specific.

### Estimated effort

~3-4 hours backend + 1 hour frontend + 1 hour reviews/iteration. The simplest of the remaining four.

---

## Spec stub: `vendor` — Vendor scorecard

**Template ID:** `vendor`  
**Catalog text:** "Vendor performance · on-time, fill-rate"  
**Columns hint:** `vendor · orders · fill % · late · $`  
**Status today:** PREVIEW.

### What it computes

Per-vendor scorecard over a date range: on-time delivery rate, fill rate (received vs. ordered), total $ purchased, count of late deliveries.

### Data needed

- `vendors` table for the vendor list and identity.
- `purchase_orders` joined with `vendors`. Need:
  - `purchase_orders.ordered_at` (or whatever the order-placement timestamp column is)
  - `purchase_orders.expected_delivery_at` (or similar)
  - `purchase_orders.received_at` for on-time-vs-late comparison
  - `purchase_orders.status` for "received vs. open"
- `po_items.ordered_qty` vs. `po_items.received_qty` for fill-rate.

### Open questions for the spec

1. Schema check: does `purchase_orders` actually have an `expected_delivery_at`? If not, "on-time" can't be computed and the spec degrades to "delivered count" + "fill rate" only — surface to user.
2. "Fill rate" definition — line-item-level (sum of received_qty / sum of ordered_qty per PO) or PO-level (binary: was every line fully filled). Surface.
3. Tone thresholds for fill % — hardcoded like COGS (≥95 ok, ≥90 warn, else danger)? Or expose as `params.target`?
4. Headline KPIs — best 2-3 of: average on-time %, average fill %, total $ purchased, count of late deliveries, count of short-shipments.

### Estimated effort

~5-6 hours total. Schema verification work might surface gaps that need a separate small migration to add columns. Flag in the spec.

---

## Spec stub: `velocity` — Item velocity

**Template ID:** `velocity`  
**Catalog text:** "Item velocity · turn rate per ingredient"  
**Columns hint:** `item · usage/wk · turns · DOH`  
**Status today:** PREVIEW.

### What it computes

Per-item usage velocity (units sold or depleted per week), turns (sales / average inventory), and days-on-hand at current stock level.

### Data needed

- `inventory_items.current_stock` for the "current stock" leg.
- POS sales depletion via `pos_imports` × `pos_import_items` × recursive prep-recipe CTE → per-`inventory_items.id` units depleted. **The exact CTE landed in `report_run_variance`** ([migration 20260512120000](../supabase/migrations/20260512120000_report_run_variance.sql) section 10) — reuse verbatim.
- Optionally: receiving from `po_items` + waste from `waste_log` to get a fuller depletion picture.

### Formulas

- `usage_per_week = total_units_depleted / (date_range_days / 7)`
- `days_on_hand = current_stock / (usage_per_week / 7)` — guard against divide-by-zero.
- `turns = usage / average_inventory` — average inventory is tricky. Use `(current_stock + last_received) / 2` as a rough proxy, or skip turns and surface only usage + DOH.

### Open questions for the spec

1. The "turns" formula needs `average_inventory` which is hard without snapshots. Skip turns or use a rough proxy? Surface to user. Default: skip turns, show only usage + DOH.
2. DOH threshold tone — `< 3 days` danger (about to run out), `< 7 days` warn, else ok? Or expose as `params.threshold`?
3. Filter to items with non-zero usage in the period? Otherwise the table is huge.
4. By-category aggregation toggle? Or item-only is fine?

### Estimated effort

~4-5 hours. The recursive CTE is already proven in variance.

---

## Spec stub: `custom` — Custom SQL

**Template ID:** `custom`  
**Catalog text:** "Custom SQL · write your own"  
**Columns hint:** `-- SELECT … FROM inventory`  
**Status today:** PREVIEW. This is the largest of the four.

### What it would do

Let admin users write arbitrary SQL against a sandboxed view of their store's data and have it return an envelope-shaped result. This is the open-ended escape hatch when a user needs a one-off query that doesn't fit any template.

### Why it's the largest

Cannot follow the per-template RPC pattern because the SQL is dynamic. Needs:

- **Edge function with a sandboxed `EXECUTE`.** Cannot run arbitrary SQL inside a PG function with `security invoker` and get RLS to enforce — the SQL might bypass the gate. Need an edge function that opens a connection with a per-user role and lets PG enforce RLS naturally.
- **Query parser / allowlist.** Reject `DELETE`, `UPDATE`, `INSERT`, `DROP`, `ALTER`, `GRANT`, `CREATE` keywords. Or use a `SELECT`-only role.
- **Envelope adapter.** Coerce arbitrary `SELECT` result into `{ kpis, columns, rows, series }`. The frame's `formatCellValue` already handles strings/numbers; columns can be auto-derived from result metadata.
- **UI:** a code editor (monaco / codemirror via react-native-web?), syntax hints, "saved queries" reuse pattern.
- **Result size limits:** cap at N rows, fail gracefully past that.
- **Performance budget:** kill query after K seconds.

### Open questions before designing

1. Is this actually wanted, or do users just need 2-3 more pre-built templates instead? Talk to users first. Low-yes-rate users mean it's not worth the complexity.
2. If yes — who can write custom SQL? Just `super_admin`? Or every store admin? The blast radius differs.
3. Saved-query reuse — does the user save the SQL itself into `report_definitions.params.sql`? RLS allows the brand admin to read another store's custom SQL. Confirm acceptable.
4. Result-size cap and timeout — what's the right ceiling for the average dataset?

### Estimated effort

~2-3 weeks of focused work. Realistically a sub-project with its own architecture review. Defer until the other three preview templates are live and demand for custom SQL is proven.

---

## Picking this back up

When you return:

1. Read this file.
2. Read [`016-reports-runner-foundation/spec.md`](016-reports-runner-foundation/spec.md) for the contract.
3. Read [`017-reports-cogs-template/spec.md`](017-reports-cogs-template/spec.md) for the recursive-CTE + missing-cost pattern.
4. Read [`018-reports-variance-template/spec.md`](018-reports-variance-template/spec.md) for the anchor-pair + half-open interval + KPI-split pattern.
5. Dispatch `product-manager` with the chosen template's stub from above as the brief.

# Spec 036: Reports — Velocity template

Status: READY_FOR_REVIEW

## User story

As a store manager, I want to run an "Item velocity" report over a date range
so I can see which menu items are selling fast vs slow, sliced by recipe or
by category, so I can identify top movers worth pushing and slow movers worth
86'ing or repricing.

## Acceptance criteria

### Backend — `public.report_run_velocity(uuid, jsonb) returns jsonb`

- [ ] A new migration `supabase/migrations/<timestamp>_report_run_velocity.sql`
  creates the function with signature
  `(p_store_id uuid, p_params jsonb) returns jsonb`,
  `language plpgsql`, `security invoker`,
  `set search_path = public`. Matches the spec 035 vendor runner's security
  shape byte-for-byte.
- [ ] First statement raises SQLSTATE `42501` if
  `public.auth_can_see_store(p_store_id)` returns false, mirroring
  `report_run_vendor.sql:124-127` / `report_run_waste.sql:88-92`.
- [ ] Same migration re-creates the dispatcher
  `public.report_run(text, uuid, jsonb)` with a new
  `when 'velocity' then return public.report_run_velocity(p_store_id, p_params)`
  arm, preserving the existing `'stub'`, `'cogs'`, `'variance'`, `'waste'`,
  `'vendor'` arms and the `not_implemented` fallback exactly as in
  `20260514180000_report_run_vendor.sql:477-514`. The arm slots immediately
  after `when 'vendor'` (placement convention: live arms in the order their
  templates landed).
- [ ] Grants: `revoke execute on function public.report_run_velocity(uuid,
  jsonb) from public, anon; grant execute on function
  public.report_run_velocity(uuid, jsonb) to authenticated;` — matches the
  spec 016 convention and the `reports_anon_revoke.test.sql` lockdown.
- [ ] Parameters accepted in `p_params`:
  - `from` (string, `YYYY-MM-DD`) — defaults to `current_date - interval '30
    days'` when null/empty, matching the vendor / waste / COGS precedent.
  - `to` (string, `YYYY-MM-DD`) — defaults to `current_date` when null/empty,
    matching the vendor / waste / COGS precedent.
  - `by` (text) — one of `'recipe'`, `'category'`. Defaults to `'recipe'`
    when null/empty. Unknown values silently coerce to the default
    (forward-compat per the COGS / waste / vendor pattern). TWO modes only;
    item-level velocity (which would resolve `recipe_ingredients` to per-
    ingredient turn rate) is explicitly out of scope (see Q1 below).
  - Unknown keys ignored. Malformed dates surface as native 22007/22008 →
    sanitized to "Run failed — check server logs" via the frontend's
    existing `runReport` toast path.
- [ ] Range validation: `from > to` raises SQLSTATE `22023` with message
  `'Velocity report: from > to (% > %)'`. `from = to` is ALLOWED (single-day
  velocity reports are meaningful — e.g. "what sold yesterday").
- [ ] Date anchor: `pos_imports.import_date::date`. MATCHES the COGS
  precedent at `20260511120000_report_run_cogs.sql:284` / `:454` / `:551`.
  `import_date` is the manager-facing business date set at POS-import
  time and is the only sales-anchor column on `pos_imports`. There is NO
  per-row date on `pos_import_items`; the entire import batch's items
  share the parent's `import_date` (the per-row date smearing caveat is
  documented in `20260511120000_report_run_cogs.sql:17-20` — same
  carry-over applies here).
- [ ] Date window: closed `[from, to]` on `pos_imports.import_date`
  (`>= v_from AND <= v_to`). Mirrors COGS / waste / vendor. Migration
  header documents the convergence with COGS (which uses
  `between v_from and v_to` — semantically identical for `date` types).
- [ ] No status filter on `pos_imports`. The table has NO `status` column
  (verified against `init_schema.sql:176-183`); imports are written as
  finalized records by the existing POS-import surface, so there's no
  draft-vs-finalized distinction to gate on. Migration header MUST
  explicitly note the absence so reviewers comparing to the vendor
  runner don't ask "where's the status filter."
- [ ] Recipe-mapping filter: `pii.recipe_id IS NOT NULL AND
  pii.recipe_mapped = true`. MATCHES the COGS precedent at
  `20260511120000_report_run_cogs.sql:298-299` / `:455-456` / `:552-553`.
  Unmapped POS rows (where the operator hasn't yet linked a menu_item
  string to a recipe) are excluded from velocity. Header MUST call this
  out — operators may see "$X in pos_imports headline doesn't match
  velocity total" and the docs need to point at this filter.
- [ ] Empty-result short-circuit: when no `pos_import_items` rows match
  the filter, return populated `columns` + empty `kpis`/`rows`/`series`
  (`[]` not null for the array shapes; the series stays `[]` not `null`
  per the spec 016 contract).
- [ ] Recipe-name resolution: `recipes.menu_item` (the display string used
  on the receipts) via the `pos_import_items.recipe_id → recipes.id` FK.
  Recipes are brand-scoped (per `20260504072830_brand_catalog_p3_lockdown.sql:21`)
  but the per-brand SELECT policy on `recipes` lets authenticated users
  read recipe rows for their brand — no additional gate needed inside
  the RPC.
- [ ] Category resolution: `recipes.category` (free-form text, same surface
  COGS reads). NULL/empty/whitespace coerce to `'(uncategorized)'` via
  `coalesce(nullif(trim(category), ''), '(uncategorized)')`.
- [ ] Velocity computation: `velocity = qty_sold_total / window_days`
  where `window_days = (v_to - v_from) + 1` (the inclusive day count of
  the closed window). For a 30-day window with `qty_sold_total = 150`,
  `velocity = 5.000` (5 units per day on average across the entire
  window, including zero-sales days). NOT `qty_sold / day_count` (the
  number of distinct import dates the item appeared on) — the
  whole-window denominator gives "this item moves N per day on average
  across the period," which matches the intuitive question. Header MUST
  document this choice and the divergence from a `day_count`
  denominator.
- [ ] Envelope shape returned (matches the spec 016 uniform envelope):
  ```json
  {
    "kpis":    [
      { "label": "Total qty sold", "value": "1,234.000",        "tone": null },
      { "label": "Top mover",      "value": "Latte · $5,678.90", "tone": null },
      { "label": "Total revenue $","value": "$5,678.90",         "tone": null }
    ],
    "columns": [ /* depends on `by:` — see column shapes below */ ],
    "rows":    [ /* one row per group key, revenue-desc sorted */ ],
    "series":  [ { "label": "<recipe>", "x": "YYYY-MM-DD", "y": <number> }, ... ]
  }
  ```
- [ ] Columns by `by:` value (per-mode named keys policy from spec 034 §A1):
  - `by='recipe'`: `[recipe, qty_sold, day_count, velocity, revenue]` —
    `day_count` is `count(distinct pos_imports.import_date)` within the
    recipe (informational; how many days this item showed up in the
    POS feed).
  - `by='category'`: `[category, recipes_count, qty_sold, day_count,
    velocity, revenue]` — `recipes_count` is `count(distinct
    pos_import_items.recipe_id)` within the category; `day_count` is
    `count(distinct pos_imports.import_date)` within the category.
- [ ] Row formatting (server-side):
  - Revenue cells: `'$' || to_char(value, 'FM999,999,990.00')` for
    positive, `'-$' || to_char(abs(value), 'FM999,999,990.00')` for
    negative (revenue should always be positive — guard for
    forward-compat, mirrors vendor's same guard).
  - Qty cells: `to_char(value, 'FM999,990.000')` (three-decimal
    precision matches waste / variance / vendor row format).
  - Velocity cells: `to_char(value, 'FM999,990.000')` (three-decimal
    precision; velocity is a units-per-day ratio that can be fractional
    even for whole-unit items, e.g. 17 sold over 30 days = 0.567/day).
  - `day_count` cells: emitted as a plain integer (no formatting mask).
  - `recipes_count` cells (category mode only): emitted as a plain
    integer.
  - Rows sorted by `revenue desc, group_key asc` (tiebreaker keeps
    output deterministic). Same shape as vendor / waste — revenue is
    the business-meaningful primary sort, velocity is the analytic
    column.
- [ ] KPI tone bands: ALL THREE KPIs emit `"tone": null`. Rationale:
  sales are not inherently bad — high sales just means the store sold
  a lot, low sales just means the period was quiet. Same posture as
  vendor (which omits tone bands on Total spend $). Header documents
  this divergence from waste (where any waste is loss).
- [ ] KPI `Top mover` ALWAYS uses the `recipe` grouping regardless of the
  requested `by:` value — it's the cross-cutting "which single item is
  driving the most revenue" signal, parallel to vendor's `Top vendor`.
  Computed as `recipe || ' · $' || to_char(top_recipe_revenue)`. When no
  POS rows exist, the KPI is omitted (not emitted as a zero); the
  empty-result short-circuit at the early return already handles
  row_count = 0. Defense-in-depth guard against `top_recipe_revenue = 0`
  (every matched row contributed $0) — when guard fails, omit the KPI.
- [ ] `series` shape: ONE series per top-N recipes (default `N=5`),
  multi-line. Each point is
  `{ "label": <recipe>, "x": <date>, "y": <revenue_that_day> }`.
  Computed regardless of the `by:` toggle (so the chart always tells
  the recipe-over-time story while the table can be sliced any way).
  Mirrors vendor's "one series per vendor" decision with an explicit
  top-N cap because high-SKU stores can have 100+ recipes (vendor
  doesn't cap because most stores have <10 vendors). The top-5 are
  picked by total revenue within the window — same ordering as the
  `rows` sort. Empty array (`'[]'::jsonb`) when fewer than 2 distinct
  dates have matched rows OR when the empty-result short-circuit fires.
  Series NEVER returns `null` — per the spec 016 contract. Header MUST
  document the top-N cap and the divergence from vendor's
  all-vendors-charted behaviour.
- [ ] No recursive prep-recipe CTE needed (`pos_import_items` rows are
  already at the granular menu-item level — they reference
  `recipes.id` directly). Migration header explicitly notes the
  absence so future contributors don't add one out of pattern-mimicry.
  Same load-bearing absence as waste / vendor.
- [ ] Index reuse: the runner does a per-store time-range scan on
  `pos_imports` then joins `pos_import_items` by `import_id`. The
  COGS runner already exercises this access path against the same
  table shape and is in production; no new index in this migration.
  If production data scale eventually warrants
  `idx_pos_imports_store_import_date (store_id, import_date)` or
  `idx_pos_import_items_import_id_recipe`, that's a follow-up spec —
  out of scope here.

### Frontend — `src/screens/cmd/sections/reports/templates.ts`

- [ ] Flip the `velocity` template's `status: 'preview'` to `status: 'live'`.
- [ ] No other field changes on the row. The existing copy reads
  `name: 'Item velocity'`, `sub: 'turn rate per ingredient'`,
  `cols: 'item · usage/wk · turns · DOH'` — accept as aspirational. The
  spec ships a recipe-grouped velocity (qty_sold / window_days), not
  an ingredient-level turn rate. A future spec may add ingredient-level
  velocity that resolves `recipe_ingredients` to per-ingredient turns.
  Surface the copy mismatch in "Out of scope" so reviewers don't flag
  it. Append one comment line above `TEMPLATES`:
  `// Spec 036 flipped 'velocity' to 'live' (see
  '<timestamp>_report_run_velocity.sql').`

### Frontend — `src/components/cmd/NewReportModal.tsx`

- [ ] `velocity` template uses the SAME date-range + by-toggle UI that
  COGS / waste / vendor use (the existing non-variance branch). No
  template-specific UI needed.
- [ ] Extend the `BY_OPTIONS` registry (currently
  `{ cogs, waste, vendor }`) to add
  `velocity: ['recipe', 'category'] as const`.
- [ ] Widen the `ByOption` type union from
  `'reason' | 'vendor' | 'category' | 'item'` to
  `'reason' | 'vendor' | 'recipe' | 'category' | 'item'`. The `by`
  state hook, the `BY_OPTIONS` value type, and the
  `defaultByForTemplate` return type all flow from this union.
- [ ] Extend `defaultByForTemplate` to return `'recipe'` for the
  `velocity` template (mirrors waste returning `'reason'`, vendor
  returning `'vendor'`). COGS and all other templates continue to fall
  through to `'category'`.
- [ ] Save-time params for `velocity`:
  `{ range, from, to, by }` — same shape as COGS / waste / vendor.
  `range` is informational (drives the chip label); `from`/`to` are
  authoritative.

### Frontend — `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`

- [ ] `overrideBy` / `onByChange` / `onPickBy` / `byOpts` types widen
  from `'reason' | 'vendor' | 'category' | 'item'` to
  `'reason' | 'vendor' | 'recipe' | 'category' | 'item'`. The
  `savedBy` parser (line 189-194) admits a fifth arm for `'recipe'`:
  ```ts
  const savedBy: 'reason' | 'vendor' | 'recipe' | 'category' | 'item' =
    rawSavedBy === 'item'   ? 'item'   :
    rawSavedBy === 'reason' ? 'reason' :
    rawSavedBy === 'vendor' ? 'vendor' :
    rawSavedBy === 'recipe' ? 'recipe' :
    'category';
  ```
- [ ] `byOpts` (line 268-271) gains a fourth per-template branch:
  ```ts
  const byOpts: ReadonlyArray<...> =
    definition.templateId === 'waste'    ? (['reason', 'category', 'item'] as const) :
    definition.templateId === 'vendor'   ? (['vendor', 'category', 'item'] as const) :
    definition.templateId === 'velocity' ? (['recipe', 'category'] as const) :
                                            (['category', 'item'] as const);
  ```
- [ ] By-chip override (the in-frame chip-strip): the
  `selectedSupportsBy` gate today is
  `selectedIsLive && selectedTemplate?.id !== 'variance'` in
  `ReportsSection.tsx:241`. With `velocity` now `'live'`, the chip strip
  fires for it automatically — same code path as waste / vendor. No
  code change in `ReportsSection.tsx` beyond the
  `OverrideState['by']` union widening below.

### Frontend — `src/screens/cmd/sections/ReportsSection.tsx`

- [ ] Widen `OverrideState['by']` from
  `'reason' | 'vendor' | 'category' | 'item'` to
  `'reason' | 'vendor' | 'recipe' | 'category' | 'item'`. The
  `setOverrideBy` signature (line 177) widens to the same union.
  Other templates continue to ignore the `'recipe'` value if a user
  somehow saved it on a non-velocity definition (forward-compat: the
  RPC coerces unknown values to default).
- [ ] No removal of the PREVIEW badge needs explicit code change here —
  the badge already lives inside the catalog tile and is gated on
  `r.status === 'preview'`. The `templates.ts` flip drops the badge
  automatically.

### Tests

- [ ] New pgTAP test `supabase/tests/report_run_velocity.test.sql` with
  `plan(11)` mirroring `report_run_vendor.test.sql` structure:
  1. **Fixture sanity (1)** — Frederick store id resolves from seed.
  2. **Fixture sanity (2)** — Two distinct Frederick `recipes` rows
     resolve from seed (or get inserted in the fixture do-block when
     no two exist). Stable across seed refreshes.
  3. **Auth gate** — manager calling velocity on Charles (non-member
     store) raises SQLSTATE `42501`. Mirrors `report_run_vendor.test.sql`
     arm (3).
  4. **Empty range** — call with `from = to = '2000-01-01'` (no POS
     imports in seed before then), `by='recipe'`. Returns populated
     `columns` + empty `kpis`/`rows`/`series` arrays; `columns[0].key
     = 'recipe'`.
  5. **Single-row formula** — insert one `pos_imports` row
     (`import_date='2026-06-01'`, `store_id=<frederick>`) and one
     `pos_import_items` row (`recipe_id=<recipe A>`, `qty_sold=30`,
     `revenue=150.00`, `recipe_mapped=true`). Call with
     `from=to='2026-06-01'`, `by='recipe'`. Assert:
     - `kpis[label='Total qty sold'].value = '30.000'`
     - `kpis[label='Total revenue $'].value = '$150.00'`
     - row count = 1, `rows[0].recipe = <recipe A menu_item>`,
       `rows[0].qty_sold = '30.000'`,
       `rows[0].revenue = '$150.00'`,
       `rows[0].day_count = 1`,
       `rows[0].velocity = '30.000'` (30 sold / 1-day window).
  6. **Unmapped POS row excluded** — insert a second
     `pos_import_items` row on the same import with `recipe_id IS
     NULL` AND a third row with `recipe_id=<recipe A>` but
     `recipe_mapped=false`. Re-call. Assert that `Total qty sold` /
     `Total revenue $` are UNCHANGED — both unmapped rows are
     filtered out. Mirrors the COGS exclude-unmapped policy (header
     `:70-72`).
  7. **Multi-recipe ordering** — insert one more `pos_import_items`
     row on the same import for a *different* recipe with smaller
     `revenue` than recipe A. Re-call with `by='recipe'`. Assert
     `array_agg(rows[i].recipe order by i)` comes out
     `[<recipe A>, <recipe B>]` (revenue-desc, recipe-asc
     tiebreaker).
  8. **Velocity ratio across multi-day window** — extend the window
     to a multi-day range (`from='2026-06-01', to='2026-06-30'`,
     30-day window) WITHOUT inserting any new rows. Recipe A's
     `qty_sold = 30` stays the same; `velocity` becomes
     `30 / 30 = '1.000'`. Assert
     `rows[recipe=A].velocity = '1.000'` AND
     `rows[recipe=A].day_count = 1` (still only one import date).
     This is the load-bearing assertion that proves the denominator
     is `window_days`, not `day_count`.
  9. **`by='category'` smoke** — call once with `by='category'` over
     the single-day window from arm (5)/(6)/(7). Assert
     `columns[0].key = 'category'` and `rows[0]` has a `category` key
     (not a `recipe` key) AND `rows[0]` has a `recipes_count` key
     equal to the integer count of distinct recipes in that category.
  10. **Top mover KPI cross-cuts** — re-call with `by='category'`.
      Assert the `Top mover` KPI value starts with `<recipe A
      menu_item> · $` — proves the KPI is computed via the recipe
      grouping regardless of the by-toggle. Mirrors vendor arm
      "Top vendor cross-cuts" semantics.
  11. **Envelope shape** — sorted-key list assertion matches
      `array['columns', 'kpis', 'rows', 'series']::text[]`, same shape
      as `report_run_vendor.test.sql` (11).

  Per-arm budget note: if the developer prefers `plan(12)` to split
  arm (5) into "kpi assertion" + "per-row assertion", that's
  acceptable — the `reports_anon_revoke.test.sql` plan change is
  unaffected. Follow the architect's choice during design.

- [ ] `supabase/tests/reports_anon_revoke.test.sql` adds an arm for
  `report_run_velocity(uuid, jsonb)` — anon → 42501 at GRANT time.
  Brings the assertion plan from `plan(10)` to `plan(11)`. Arm slots
  after the existing vendor arm (the `(6) report_run_vendor` block)
  and before the `(7) report_reorder_list` arm; renumber the trailing
  arms `(7)..(9)` → `(8)..(10)`. The comment block at the top of the
  file grows from "10 RPCs covered" → "11 RPCs covered" and adds a
  bullet for `report_run_velocity(uuid, jsonb)` — spec 036.

- [ ] No new shell smoke arm. The existing `scripts/smoke-rpc.sh`
  smokes `report_run('stub', ...)` for the dispatcher contract;
  velocity is reachable through the same RPC, no per-template smoke
  needed.

- [ ] No new jest test required (no new TS helpers extracted by this
  spec). The `BY_OPTIONS` registry widening + the `savedBy` parser
  widening are typed at the TypeScript boundary and exercised by
  manual browser smoke; mechanical correctness is gated by
  `npx tsc --noEmit`.

### Verification gates

- [ ] `npx tsc --noEmit` exit 0.
- [ ] `npm run typecheck:test` exit 0.
- [ ] `npm test -- --ci` PASS (jest unchanged).
- [ ] `npm run test:db` PASS — pgTAP file count moves from 17 → **18**;
  the `reports_anon_revoke.test.sql` plan moves from 10 → 11.
- [ ] `npm run test:smoke` PASS (no new arms; only confirms existing
  smokes still green).
- [ ] Manual browser smoke after `npm run dev` against local stack:
  - Reports section, catalog tile `velocity` — PREVIEW badge gone,
    click opens `NewReportModal` pre-filled with template =
    `velocity`, name = `"Item velocity — May 2026"`.
  - The by-toggle in the modal shows two chips: `recipe` (selected),
    `category`.
  - Save the report — appears in "your reports" grid.
  - Click the saved report — detail frame opens.
  - Click RUN — `kpis` show Total qty sold + Top mover +
    Total revenue $; `rows` populate with recipe groups (or category
    groups if `by='category'` was selected); multi-line chart renders
    up to 5 series (one per top-revenue recipe).
  - Click the `by:` chip strip — toggling between recipe / category
    re-runs with the override; rows + columns change shape correctly.
  - Toggle the date range — re-runs against the new window; the
    `velocity` column in the rows reflects `qty_sold / window_days`
    (visibly shrinks when the window expands).

## In scope

- New RPC `public.report_run_velocity(uuid, jsonb) returns jsonb`.
- Dispatcher re-create with the `when 'velocity'` arm added after the
  existing `when 'vendor'` arm.
- `templates.ts` flip of `velocity.status: 'preview' → 'live'`.
- `NewReportModal` + `ReportDetailFrame` + `ReportsSection` type-union
  widening to admit the `'recipe'` option for the by-toggle (and only
  for velocity).
- pgTAP test `report_run_velocity.test.sql` covering auth gate +
  envelope shape + per-row formula + recipe-mapping filter + multi-
  recipe ordering + velocity-ratio math (the load-bearing window-days
  denominator assertion) + by-toggle smoke + top-mover cross-cut.
- `reports_anon_revoke.test.sql` arm added for the new RPC.
- Migration header documents the design choices: date anchor
  (`pos_imports.import_date`), no status filter (absence is
  load-bearing — no column to gate on), recipe-mapping filter
  (`recipe_id IS NOT NULL AND recipe_mapped = true`), velocity
  denominator (`window_days`, not `day_count`), top-N series cap (5,
  divergence from vendor's all-vendors-charted behaviour), tone-
  bands omission (sales aren't inherently bad), no recursive CTE
  rationale.

## Out of scope (explicitly)

- **Ingredient-level velocity.** The catalog-tile copy reads "turn
  rate per ingredient" and lists columns `item · usage/wk · turns ·
  DOH`. Spec 036 ships RECIPE-level velocity (the menu items sold,
  not the ingredients consumed). Adding an `item-level` `by:` mode
  that resolves `recipe_ingredients` through `inventory_items` to
  per-ingredient turns is a future spec — the SQL is non-trivial
  (recursive CTE for prep recipes, share-of-recipe math, DOH
  computation needs current `inventory_items.current_stock`) and
  the analytic question is different ("am I stocked appropriately"
  vs "what's selling"). Catalog tile copy stays aspirational; a
  follow-up spec can rename or split the tile.
- **Custom SQL template.** Each is its own larger spec; the
  reports-templates-backlog stubs it out (sandboxed EXECUTE edge
  function). Spec 036 is velocity only.
- **Per-row POS date smearing.** A single `pos_imports` row's
  `import_date` covers all of that batch's `pos_import_items`. If
  one CSV spans multiple business days, those rows bucket to the
  parent import's single date. Same caveat COGS documents at
  `20260511120000_report_run_cogs.sql:17-20`. A future spec adding a
  per-row `business_date` column to `pos_import_items` is the right
  shape; not in scope here.
- **A `⚠` suffix on rows with missing revenue or qty.** Same
  rationale as waste / vendor — a row with NULL/0 revenue just
  doesn't contribute to the dollar number; the qty still surfaces.
  No per-row diagnostic.
- **Per-brand or per-store tone thresholds.** Tone bands are
  explicitly omitted (`"tone": null` for all velocity KPIs) per the
  Q4 resolution below. Adding per-brand velocity-band config (e.g.
  "items selling <0.5/day are danger") is a future spec.
- **Realtime push for POS imports into the open detail frame.**
  `pos_imports` and `pos_import_items` are NOT on the
  `supabase_realtime` publication (per
  `20260514140000_realtime_publication_tighten.sql:43-53`). A new POS
  import does NOT auto-re-run the open Velocity report; re-run is
  the user's action via the RUN button. Same as vendor's stance on
  `po_items`. Out of scope to add either table to the publication —
  POS imports are bulk batches and would flood subscribers.
- **New POS-import surfaces.** Reads from existing
  `pos_imports`/`pos_import_items` tables; no new CSV-import UI, no
  new mapping flow. The existing `PosImportSection` (if present) is
  not touched.
- **Pricing or 86'ing actions from the report.** Velocity surfaces
  slow movers; acting on them (changing `sell_price`, archiving the
  recipe) is the user's separate workflow in `RecipesSection`.
- **Day-count denominator alternative.** Spec 036 commits to
  `velocity = qty_sold / window_days` (the inclusive day count of
  the closed `[from, to]` window). A `qty_sold / day_count`
  alternative ("avg per day the item actually appeared") is a
  reasonable second metric but is explicitly not shipped — pick one,
  ship it, let users ask for the other if they need it.
- **Slug or `app.json` changes.** (Not relevant — see project-
  specific notes.)
- **Edge function.** RPC-only; no `supabase/functions/` work.

## Open questions resolved

- **Q1: by-modes — recipe / category, or include item via
  `recipe_ingredients` resolution?** → **recipe / category only
  (TWO modes).** Rationale: item-level velocity would require a
  recursive prep-recipe CTE, share-of-recipe math, and a DOH
  computation that needs `inventory_items.current_stock` — that's a
  separate analytic question ("am I stocked appropriately") with a
  different envelope. A future spec can add the `'item'` mode and
  the new columns; spec 036 ships the simpler recipe slice. The
  catalog-tile copy advertises "turn rate per ingredient" but the
  spec narrows scope intentionally — the tile copy is aspirational
  and a follow-up can revisit.

- **Q2: Velocity column — `qty_sold / day_count` or `qty_sold /
  window_days`?** → **`qty_sold / window_days`.** Rationale: simpler
  arithmetic, more intuitive ("this item moves N per day on average
  across the period"). The `day_count` alternative ("avg per day the
  item actually appeared") double-counts items that appear on every
  import day vs. items with sporadic presence, which is informative
  but not the headline question. `day_count` STILL surfaces as a
  separate row column (informational), so the user can compute
  `qty_sold / day_count` mentally if they want. The migration header
  MUST document this choice and the divergence.

- **Q3: Status filter on `pos_imports`?** → **NO — the table has no
  `status` column.** Verified against `init_schema.sql:176-183`. POS
  imports are written as finalized records by the existing import
  surface; there is no draft-vs-finalized distinction to gate on. The
  migration header MUST explicitly note the absence so reviewers
  comparing to the vendor runner don't ask "where's the status
  filter."

- **Q4: KPI tone bands?** → **OMIT — all three KPIs emit `"tone":
  null`.** Rationale: sales are not inherently bad. High sales just
  means the store sold a lot; low sales just means the period was
  quiet (or the store closed for renovations). Same posture as
  vendor's stance on Total spend $. Waste's `< $50 ok / $50-$200
  warn / > $200 danger` band makes sense because all waste is loss;
  velocity is just operations. Header MUST document this divergence
  from waste so reviewers don't copy-paste the `case when` block.

- **Q5: Default `group_by`?** → **`'recipe'`.** The obvious default
  for an "Item velocity" report — managers think "which menu items
  are selling." Toggle offers two: `recipe | category`. Mirrors
  vendor defaulting to `'vendor'`.

- **Q6: Series cap — one series per recipe like vendor's one per
  vendor, or top-N?** → **Top-N (N=5).** Rationale: vendor doesn't
  cap because most stores have <10 vendors. Velocity at recipe level
  can easily hit 50+ menu items; a 50-line chart is unreadable. The
  top-5 by total revenue within the window gives a clean visual.
  Top-N picks by revenue (same ordering as the `rows` sort).
  Migration header MUST call out the divergence from vendor's
  all-vendors-charted behaviour.

- **Q7: Date anchor — `import_date` or `imported_at::date`?** →
  **`pos_imports.import_date`.** Matches the COGS precedent
  (`20260511120000_report_run_cogs.sql:284`). `import_date` is the
  manager-facing business date (what day did these sales happen).
  `imported_at` is the system-of-record timestamp (when did the CSV
  get uploaded), which could be days after the business day — wrong
  shape for "what sold on day X."

- **Q8: Date window — closed `[from, to]` like vendor / waste / COGS,
  or half-open?** → **CLOSED `[from, to]`** on the date anchor.
  Mirrors vendor / waste / COGS. Variance is the only outlier with
  its half-open shape (anchor-pair reconciliation semantics).
  Velocity is event-stream like the others. Header MUST call this
  out so reviewers don't flag it as drift.

- **Q9: Does this spec add a new table or migration to
  `pos_imports` / `pos_import_items` / `recipes`?** → **NO.** All
  three tables exist and are well-populated by the existing
  POS-import surface and Recipes section. No schema additions, no
  FK changes, no policy changes. The COGS migration already
  established that `pos_imports` per-store RLS works for the runner
  via the `auth_can_see_store` gate inside the RPC body.

- **Q10: Realtime?** → **No new subscription.** Neither
  `pos_imports` nor `pos_import_items` is on the realtime
  publication (per `20260514140000_realtime_publication_tighten.sql`).
  This is deliberate — POS imports are bulk batches that would
  flood subscribers. Re-running the open Velocity report is the
  user's deliberate action via the RUN button, not a push. Adding
  either table to the publication is out of scope.

- **Q11: Top mover KPI — always cross-cut on recipe, or follow the
  `by:` toggle?** → **ALWAYS recipe.** Parallel to vendor's "Top
  vendor" (always vendor) and waste's "Top driver" (always reason).
  Rationale: when the user toggles `by='category'`, they want the
  table sliced by category but the KPI still tells them "which one
  item drove the most revenue" — recipe is the most-actionable
  axis. Header documents this so reviewers don't propose making it
  dynamic.

- **Q12: Catalog tile copy — rename `'Item velocity'` →
  `'Recipe velocity'` since spec 036 doesn't ship ingredient-level
  turns?** → **NO — keep the existing name.** A rename would imply
  spec 036 closes the entire velocity backlog item, but
  ingredient-level turn rate / DOH are valuable future scopes. Keep
  the tile name aspirational; the `sub:` and `cols:` copy can be
  revisited by the follow-up spec that adds ingredient-level
  velocity.

## Dependencies

- Migration applies cleanly via `npx supabase db push` (no realtime
  publication touch — `pos_imports` is not on the publication and
  spec 036 does not change that).
- No new edge function deploys.
- No new tables.
- pgTAP test count: 17 files → 18 files. Existing
  `reports_anon_revoke.test.sql` plan grows from 10 → 11.
- Reads from `pos_imports`, `pos_import_items`, `recipes` (per-store
  RLS gates already in place from spec 020 hardening for
  `pos_imports`/`pos_import_items`; `recipes` is brand-scoped per the
  brand-catalog refactor — the runner reads recipe rows via the
  `recipe_id` FK and RLS lets any authenticated user `SELECT`
  recipes for their brand).
- No new index (out of scope per AC; existing COGS runner exercises
  the same access path against the same tables and is in
  production).

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only.
  `src/screens/cmd/sections/ReportsSection.tsx` is the only Reports
  surface (legacy admin was deleted in spec 025).
- **Per-store or admin-global:** Per-store. The RPC's
  `auth_can_see_store(p_store_id)` gate enforces it; admins/masters
  still see cross-store via the same helper.
- **Realtime channels touched:** None added. `pos_imports` and
  `pos_import_items` remain absent from the publication (out of
  scope to add). The detail frame does NOT auto-rerun on POS
  inserts (re-run is the user's action via the RUN button).
- **Migrations needed:** YES — one new SQL migration creating
  `report_run_velocity(uuid, jsonb)` + re-creating the dispatcher
  with the `'velocity'` arm. No realtime publication change. No new
  index.
- **Edge functions touched:** None.
- **Web/native scope:** Both. No web-only or native-only code. The
  Reports section is Cmd UI which runs on both surfaces via the
  existing `CmdNavigator` shell.
- **Tests track:** pgTAP
  (`supabase/tests/report_run_velocity.test.sql` new file) + pgTAP
  edit (`reports_anon_revoke.test.sql` adds one arm). No new jest.
  No new shell smoke. Test-engineer routes accordingly per spec
  022's three tracks.
- **app.json slug:** Not touched. Locked to `towson-inventory` per
  the CLAUDE.md DO-NOT-AUTO-FIX rule.

## Architect design

### A0. Architect decisions (PM's four open questions resolved up-front)

1. **Migration filename slot — `20260515120000_report_run_velocity.sql`.**
   2026-05-14 closed at `180000_report_run_vendor.sql`. Today is
   2026-05-15; we use the noon slot, matching the same hour pattern as
   `20260511120000_report_run_cogs.sql`, `20260512120000_report_run_variance.sql`,
   `20260513120000_inventory_counts_consistency.sql`, and
   `20260514120000_eod_submissions_vendor_id.sql`. There is no migration in
   the 20260515 cluster yet, so 120000 is the first hour-slot — leaves
   afternoon slots free for any same-day follow-up.

2. **Hardcoded vs param `series_n` cap → HARDCODED N=5.** Adopt PM's
   lean. The top-N cap is an analyst-side display concern, not a caller
   contract knob; widening `p_params` for a "tune the chart line count"
   value spec-balloons the surface for no demonstrated user benefit at
   v1. If a future caller (e.g. an exported PDF that wants top-10)
   needs it, that's a one-line additive change to add
   `coalesce(nullif(p_params->>'series_n','')::int, 5)` later — the
   constant declaration in the migration header explicitly notes
   "tunable via params in a follow-up" so the affordance is visible.
   Migration uses a `v_series_n constant int := 5;` declaration at the
   top of the function body, NOT a magic 5 buried in the series LIMIT
   clause — improves readability and pinpoints the future widening
   site.

3. **`recipe_id` deeplink field → NOT IN v1.** Adopt PM's lean. No
   other live runner emits an ID column (vendor emits `vendor` name,
   waste emits `reason`/`category`/`item` strings, COGS emits
   `category`/`item` strings). Adding `recipe_id` to velocity ONLY is
   an asymmetric divergence that would surface as drift in
   code-review. The frame renderer reads `row[col.key]` — there's no
   wiring for a hidden-ID-plus-display-label pattern, and inventing
   one for spec 036 expands scope. If recipe-detail deeplinks are a
   real need (and they are — "click 'Latte' in the velocity report
   to jump to the recipe page"), they should land in a dedicated
   follow-up that adds the affordance uniformly across COGS, vendor,
   waste, and velocity (rows could carry a parallel `_keys`
   side-channel or each runner could emit `*_id` columns whose
   shape the frame knows to hide). Migration `Out of scope` paragraph
   in the spec already covers this — no architect-introduced new
   work.

4. **`byOpts` ternary refactor → DEFER.** Adopt PM's lean. The chain
   at `ReportDetailFrame.tsx:268-271` is currently three arms (waste /
   vendor / fallback); spec 036 makes it four (waste / vendor /
   velocity / fallback). Four arms of a ternary is still readable and
   the per-template branches are short single-line `as const` arrays.
   The same registry already exists at the modal side
   (`NewReportModal.tsx:76` `BY_OPTIONS`) — both sites would need to
   be unified, the `templates.ts` definition would need to grow a
   `byOptions?: ReadonlyArray<ByOption>` field, and the existing
   modal default-by lookup would need to be re-routed through the
   template definition. That's a 30+ line refactor that touches every
   currently-shipped template at exactly the moment we're trying to
   ship a sixth one. The cleaner play is to extract the registry
   ONCE in spec 037 (the next reports template) when there's no
   pressure to ship the runner alongside it. Inline comment at the
   `byOpts` branch ("at five live templates this is the complexity
   ceiling — promote to `templates.ts` field when the next velocity-
   shaped template lands") makes the deferral explicit for the next
   contributor.

### A1. Data model changes — NONE.

The migration adds a function only. Reads from existing tables
`pos_imports`, `pos_import_items`, `recipes`. No DDL on any table, no
new index, no FK changes, no policy edits. Spec Q9 already established
this.

### A2. Migration file and security shape

`supabase/migrations/20260515120000_report_run_velocity.sql` —
ADDITIVE. Two top-level statements (verbatim shape from spec 035 vendor):

1. `create or replace function public.report_run_velocity(p_store_id uuid, p_params jsonb) returns jsonb`
   - `language plpgsql`
   - `security invoker` — caller's RLS gates apply on every joined
     read (`pos_imports`, `pos_import_items`, `recipes`). The
     `auth_can_see_store(p_store_id)` first-statement gate
     short-circuits before any cross-store leak can land.
   - `set search_path = public` — closes the
     `search_path`-manipulation attack vector flagged in
     20260424211733_security_fixes.sql.
   - First statement is the auth gate raising SQLSTATE 42501
     (same shape as vendor:124-127 / waste:88-92).
   - Trailing grants:
     ```
     revoke execute on function public.report_run_velocity(uuid, jsonb) from public, anon;
     grant  execute on function public.report_run_velocity(uuid, jsonb) to authenticated;
     ```

2. `create or replace function public.report_run(p_template_id text, p_store_id uuid, p_params jsonb)`
   re-created in full from vendor:477-514 with a new
   `when 'velocity' then return public.report_run_velocity(p_store_id, p_params)`
   arm slotted immediately after the existing `when 'vendor'` arm
   and immediately before the `else` not_implemented branch. All
   other arms (`stub`, `cogs`, `variance`, `waste`, `vendor`) and the
   not_implemented envelope shape preserved verbatim. Signature
   unchanged so callers see no surface drift. Same trailing
   `revoke ... from public, anon; grant ... to authenticated;`.

**Destructive vs additive:** purely additive. No drop, no breaking
column change. Rollback is `drop function public.report_run_velocity(uuid, jsonb);`
plus a re-create of the dispatcher with the `'velocity'` arm removed —
captured implicitly because `create or replace function` on the
dispatcher swaps the body without breaking outstanding grants.

### A3. CTE pipeline skeleton

Function body in numbered sections (mirrors vendor's numbered
comment scheme so reviewers can compare side-by-side):

```
(1)  AUTH GATE
       if not auth_can_see_store(p_store_id) then
         raise exception 'Not authorized for store %', p_store_id
           using errcode = '42501';
       end if;

(2)  PARAM COERCION
       v_from        := coalesce(nullif(p_params->>'from','')::date,
                                 ((now() at time zone 'utc')::date - interval '30 days')::date);
       v_to          := coalesce(nullif(p_params->>'to','')::date,
                                 (now() at time zone 'utc')::date);
       v_by          := coalesce(nullif(p_params->>'by',''), 'recipe');
       if v_by not in ('recipe', 'category') then
         v_by := 'recipe';                                 -- forward-compat
       end if;
       v_window_days := (v_to - v_from) + 1;               -- closed-interval inclusive count
       v_series_n constant int := 5;                       -- top-N cap; see A0 #2 for follow-up tunable

(3)  RANGE VALIDATION
       if v_from > v_to then
         raise exception 'Velocity report: from > to (% > %)', v_from, v_to
           using errcode = '22023';
       end if;
       -- from = to ALLOWED (single-day velocity is meaningful).

(4)  COLUMN HEADER (built up-front so the empty-result branch returns it)
       if v_by = 'recipe' then
         v_columns := jsonb_build_array(
           {key:'recipe',     label:'Recipe',    align:'left' },
           {key:'qty_sold',   label:'Qty sold',  align:'right'},
           {key:'day_count',  label:'Days',      align:'right'},
           {key:'velocity',   label:'Velocity',  align:'right'},
           {key:'revenue',    label:'Revenue',   align:'right'}
         );
       else  -- v_by = 'category'
         v_columns := jsonb_build_array(
           {key:'category',       label:'Category',  align:'left' },
           {key:'recipes_count',  label:'Recipes',   align:'right'},
           {key:'qty_sold',       label:'Qty sold',  align:'right'},
           {key:'day_count',      label:'Days',      align:'right'},
           {key:'velocity',       label:'Velocity',  align:'right'},
           {key:'revenue',        label:'Revenue',   align:'right'}
         );
       end if;

(5)  HEADLINE TOTALS + TOP-RECIPE LOOKUP — one CTE pass
       with base as (
         select
           pi.id                                            as import_id,
           pi.import_date                                   as biz_date,
           pii.recipe_id,
           coalesce(pii.qty_sold, 0)::numeric               as qty,
           coalesce(pii.revenue,  0)::numeric               as revenue,
           coalesce(r.menu_item, '(deleted recipe)')        as recipe,
           coalesce(nullif(trim(r.category), ''),
                    '(uncategorized)')                      as category
         from public.pos_imports pi
         join public.pos_import_items pii on pii.import_id = pi.id
         left join public.recipes r       on r.id = pii.recipe_id
         where pi.store_id = p_store_id
           and pi.import_date >= v_from
           and pi.import_date <= v_to
           and pii.recipe_id is not null
           and pii.recipe_mapped = true
       ),
       totals as (
         select coalesce(sum(qty),     0)::numeric          as total_qty,
                coalesce(sum(revenue), 0)::numeric          as total_revenue,
                count(*)                                    as row_count,
                count(distinct biz_date)                    as distinct_dates
         from base
       ),
       top_recipe as (
         select recipe, sum(revenue)::numeric as revenue
         from base
         group by recipe
         order by sum(revenue) desc, recipe asc
         limit 1
       )
       select t.total_qty, t.total_revenue, t.row_count, t.distinct_dates,
              tr.recipe,   tr.revenue
         into v_total_qty, v_total_revenue, v_row_count, v_distinct_dates,
              v_top_recipe, v_top_recipe_revenue
         from totals t
         left join top_recipe tr on true;

(6)  EMPTY-RESULT SHORT-CIRCUIT
       if v_row_count = 0 then
         return jsonb_build_object(
           'kpis',    '[]'::jsonb,
           'columns', v_columns,
           'rows',    '[]'::jsonb,
           'series',  '[]'::jsonb
         );
       end if;

(7)  KPI ASSEMBLY — all three tones explicitly null
       v_kpis := jsonb_build_array(
         {label:'Total qty sold', value: to_char(v_total_qty, 'FM999,999,990.000'),
          tone: null}
       );
       if v_top_recipe is not null and coalesce(v_top_recipe_revenue, 0) > 0 then
         v_kpis := v_kpis || jsonb_build_array(
           {label:'Top mover',
            value: v_top_recipe || ' · $' || to_char(v_top_recipe_revenue, 'FM999,999,990.00'),
            tone: null}
         );
       end if;
       v_kpis := v_kpis || jsonb_build_array(
         {label:'Total revenue $',
          value:'$' || to_char(v_total_revenue, 'FM999,999,990.00'),
          tone: null}
       );

(8)  ROWS — branched by v_by; base CTE re-walked (plpgsql CTE scope)
     v_by = 'recipe':
       with base as (...same WHERE / joins as (5)...),
       grouped as (
         select recipe,
                sum(qty)::numeric                    as qty,
                count(distinct biz_date)             as day_count,
                sum(revenue)::numeric                as revenue
         from base
         group by recipe
       )
       select coalesce(jsonb_agg(row_obj order by revenue desc, recipe asc), '[]'::jsonb)
         into v_rows from (
           select jsonb_build_object(
             'recipe',     recipe,
             'qty_sold',   to_char(qty,                     'FM999,990.000'),
             'day_count',  day_count,
             'velocity',   to_char(qty / v_window_days,     'FM999,990.000'),
             'revenue',    case when revenue >= 0
                                then '$'  || to_char(revenue,      'FM999,999,990.00')
                                else '-$' || to_char(abs(revenue), 'FM999,999,990.00') end
           ) as row_obj, revenue, recipe from grouped
         ) ordered;

     v_by = 'category':
       with base as (...same WHERE / joins as (5)...),
       grouped as (
         select category,
                count(distinct recipe_id)            as recipes_count,
                sum(qty)::numeric                    as qty,
                count(distinct biz_date)             as day_count,
                sum(revenue)::numeric                as revenue
         from base
         group by category
       )
       select coalesce(jsonb_agg(row_obj order by revenue desc, category asc), '[]'::jsonb)
         into v_rows from (
           select jsonb_build_object(
             'category',       category,
             'recipes_count',  recipes_count,
             'qty_sold',       to_char(qty,                 'FM999,990.000'),
             'day_count',      day_count,
             'velocity',       to_char(qty / v_window_days, 'FM999,990.000'),
             'revenue',        case when revenue >= 0
                                    then '$'  || to_char(revenue,      'FM999,999,990.00')
                                    else '-$' || to_char(abs(revenue), 'FM999,999,990.00') end
           ) as row_obj, revenue, category from grouped
         ) ordered;

(9)  SERIES — top-N=5 recipes by revenue (architect §A0 #2)
       if v_distinct_dates < 2 then
         v_series := '[]'::jsonb;       -- chart needs ≥ 2 anchor dates
       else
         with base as (...same WHERE / joins as (5)...),
         top_n as (
           select recipe, sum(revenue)::numeric as rev
           from base group by recipe
           order by sum(revenue) desc, recipe asc
           limit v_series_n
         ),
         daily as (
           select b.recipe, b.biz_date, sum(b.revenue)::numeric as revenue
             from base b
             join top_n t on t.recipe = b.recipe
            group by b.recipe, b.biz_date
         )
         select coalesce(jsonb_agg(
           jsonb_build_object(
             'label', recipe,
             'x',     to_char(biz_date, 'YYYY-MM-DD'),
             'y',     round(revenue, 2)
           ) order by recipe asc, biz_date asc
         ), '[]'::jsonb)
           into v_series from daily;
       end if;

(10) FINAL ENVELOPE — { kpis, columns, rows, series }
```

**Joins explained:**
- `pos_imports pi → pos_import_items pii` on `pii.import_id = pi.id`
  (inner join; the per-row date is the parent's `import_date`).
- `pos_import_items pii → recipes r` on `r.id = pii.recipe_id` LEFT
  JOIN so orphan `recipe_id` rows (recipe hard-deleted) still
  surface with `coalesce(r.menu_item, '(deleted recipe)')`. Per
  spec AC `recipe_id IS NOT NULL AND recipe_mapped = true` filter
  is in the WHERE clause, so NULL `recipe_id` is excluded before
  the join even gets there.
- `recipes.category` is free-form text; same coerce pattern as
  vendor's `catalog_ingredients.category`:
  `coalesce(nullif(trim(r.category), ''), '(uncategorized)')`.
- `count(distinct biz_date) per group` resolves `day_count` (the
  number of distinct `pos_imports.import_date` values an item
  appeared on within the window).

**Migration header MUST document (verbatim list, no relitigation
post-impl):**

1. Date anchor = `pos_imports.import_date::date` (matches COGS line
   284; the manager-facing business date).
2. Closed `[from, to]` window (`>= v_from AND <= v_to`). Matches
   COGS / waste / vendor. Variance is the only outlier.
3. NO status filter (the table has no `status` column — verified
   against `init_schema.sql:176-183`). Reviewers comparing to vendor
   should NOT ask "where's the status filter."
4. Recipe-mapping filter (`recipe_id IS NOT NULL AND recipe_mapped = true`)
   matches COGS line 298-299. Unmapped POS rows excluded — operators
   may see "POS total != velocity total" and the header points them
   at this filter.
5. Velocity denominator = `window_days = (v_to - v_from) + 1` NOT
   `day_count` (the distinct-anchor count per group). Q2 resolution:
   the whole-window denominator gives "this item moves N per day on
   average across the period." The day_count column still surfaces
   informationally so users can mentally compute the alternative.
6. Top mover KPI ALWAYS uses recipe grouping regardless of `by:` —
   Q11 cross-cut. Parallel to vendor's Top vendor.
7. Top-N=5 series cap (architect §A0 #2). DIVERGENCE from vendor's
   all-vendors-charted behaviour — vendor doesn't cap because most
   stores have <10 vendors; recipe-level velocity can hit 50+ menu
   items. Top-5 by total revenue within window. Hardcoded; tunable
   via `p_params->>'series_n'` in a follow-up.
8. All three KPIs emit `"tone": null` (Q4). Sales aren't inherently
   bad. DIVERGENCE from waste — reviewers comparing the runners
   should NOT copy-paste waste's `case when v_total_dollar < 50 then
   'ok' ...` block here.
9. No recursive prep-recipe CTE — `pos_import_items` already
   references `recipes.id` directly. Load-bearing absence; do not
   mimic the COGS / variance recursive CTE here.
10. Index reuse — the COGS runner already exercises the same
    `pos_imports (store_id, import_date)` access path against
    production data. No new index in this migration. If scale
    eventually warrants `idx_pos_imports_store_import_date` or
    `idx_pos_import_items_import_id_recipe`, that's a follow-up
    spec, out of scope here.
11. Per-row POS smearing caveat — same as COGS line 17-20. If a
    single CSV spans multiple business days, all of that import's
    rows bucket to the parent's single `import_date`. A per-row
    `business_date` column on `pos_import_items` is a future spec.

### A4. Dispatcher arm placement

Re-create the dispatcher at the bottom of the migration (after
`report_run_velocity` and its grants) in full. The new arm slots
between `when 'vendor'` and `else`:

```sql
case p_template_id
  when 'stub'     then return public.report_run_stub(p_store_id, p_params);
  when 'cogs'     then return public.report_run_cogs(p_store_id, p_params);
  when 'variance' then return public.report_run_variance(p_store_id, p_params);
  when 'waste'    then return public.report_run_waste(p_store_id, p_params);
  when 'vendor'   then return public.report_run_vendor(p_store_id, p_params);
  when 'velocity' then return public.report_run_velocity(p_store_id, p_params);
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

All other arms and the not_implemented envelope shape preserved
exactly as in vendor:477-514. Function signature unchanged.

### A5. RLS impact

**No policy changes.** The function uses `security invoker` so RLS
fires on the caller's identity for every joined read:
- `pos_imports` → `store_member_read_pos_imports` (per-store RLS
  hardening 20260504173035:256-258, uses `auth_can_see_store`).
- `pos_import_items` → `store_member_read_pos_import_items` (same
  migration:276-284, uses an `exists` subquery that walks back to
  `pos_imports.store_id` via `import_id`).
- `recipes` → existing brand-scoped SELECT policy (per the brand-
  catalog refactor; authenticated users can read recipes for their
  brand).

The first-statement `auth_can_see_store(p_store_id)` gate is
belt-and-suspenders: the RLS policies would already block
cross-store reads, but the explicit gate raises 42501 immediately
rather than returning an empty envelope, matching the existing
COGS / variance / waste / vendor / reorder runners. Reviewers
comparing the runners side-by-side should NOT remove this gate as
"redundant."

### A6. API contract

**RPC, not PostgREST.** Matches every other report runner.

**Request shape:**
```ts
supabase.rpc('report_run_velocity', {
  p_store_id: string,           // uuid
  p_params:   {
    from?:  string,             // 'YYYY-MM-DD'; defaults to today - 30d
    to?:    string,             // 'YYYY-MM-DD'; defaults to today
    by?:    'recipe' | 'category',  // defaults to 'recipe'; unknown coerces to default
  },
});
```

**Response shape (uniform envelope):**
```ts
{
  kpis: Array<{ label: string; value: string | number; tone: null }>,
  columns: Array<{ key: string; label: string; align: 'left' | 'right' }>,
  rows: Array<Record<string, string | number>>,
  series: Array<{ label: string; x: string; y: number }>,
}
```

Empty short-circuit shape: `{ kpis: [], columns: <populated>, rows: [], series: [] }`.

**Error cases:**
- Caller not a member of `p_store_id` → SQLSTATE 42501,
  `'Not authorized for store %'`.
- Anon caller → SQLSTATE 42501 at GRANT time, message varies (PG
  default `permission denied for function`).
- Malformed `from` / `to` → SQLSTATE 22007 or 22008 (native PG
  date parse errors). Sanitized to "Run failed — check server
  logs" by the existing `runReport` toast path.
- `from > to` → SQLSTATE 22023, `'Velocity report: from > to (% > %)'`.

**Routing through the dispatcher:** the existing
`useStore.ts → runReport → db.runReport` path calls
`supabase.rpc('report_run', { p_template_id: 'velocity', p_store_id, p_params })`
which routes to `report_run_velocity` via the dispatcher arm. The
client never calls `report_run_velocity` directly — same shape as
the other live runners. No `src/lib/db.ts` change needed (no new
helper); the existing `runReport` shape already covers velocity.

### A7. Edge function changes

**NONE.** RPC-only, no `supabase/functions/` work. No `verify_jwt`
toggle, no service-token validation.

### A8. `src/lib/db.ts` surface

**NO change.** The existing `runReport` helper at
`src/lib/db.ts` (the one that wraps `supabase.rpc('report_run', ...)`)
already covers the velocity template via the dispatcher. No new
camelCase mapping needed — the envelope is generic JSON consumed by
`ReportDetailFrame.tsx` which reads `row[col.key]` and
`kpi.value` / `kpi.tone` directly without any snake/camel transform.
Reviewers checking the diff for a `db.ts` edit should confirm there
isn't one.

### A9. Realtime impact

**None added.** Neither `pos_imports` nor `pos_import_items` is on
the `supabase_realtime` publication (per
`20260514140000_realtime_publication_tighten.sql:43-53` —
deliberate, bulk-batch POS imports would flood subscribers). The
open detail frame does NOT auto-rerun when a new POS import lands;
re-run is the user's deliberate action via the RUN button. Same
posture as vendor on `po_items`.

**Publication membership unchanged.** This migration does NOT touch
`supabase_realtime`, so the realtime-publication-gotcha (mid-session
publication changes require `docker restart
supabase_realtime_imr-inventory` to re-snapshot the slot — see
project_realtime_publication_gotcha.md) does NOT apply to spec 036.
A `docker restart` is not a step in the deploy or dev workflow for
this spec.

### A10. Frontend store impact

**NONE on `src/store/useStore.ts`.** The existing `runReport` action
already handles the velocity template via the dispatcher. The
optimistic-then-revert + `notifyBackendError` pattern is already
wired for all live runners and applies to velocity unchanged.

### A11. Frontend file-by-file edit plan (4 files)

1. **`src/screens/cmd/sections/reports/templates.ts`**
   - Flip `velocity.status: 'preview' → 'live'`.
   - Append one comment line above `TEMPLATES`:
     `// Spec 036 flipped 'velocity' to 'live' (see '20260515120000_report_run_velocity.sql').`
   - Do NOT touch `name`, `sub`, `cols`, `icon` on the row. The
     copy reads "Item velocity / turn rate per ingredient / item ·
     usage/wk · turns · DOH" — accept as aspirational per the spec
     "Out of scope" paragraph on ingredient-level velocity.

2. **`src/components/cmd/NewReportModal.tsx`**
   - Extend `BY_OPTIONS` registry (currently three entries) to add
     `velocity: ['recipe', 'category'] as const`. Slot after the
     existing `vendor` entry to keep insertion order matching the
     template landing order.
   - Widen `type ByOption` union from
     `'reason' | 'vendor' | 'category' | 'item'` to add `'recipe'`:
     `'reason' | 'vendor' | 'recipe' | 'category' | 'item'`.
   - Extend `defaultByForTemplate(templateId: string): ByOption` to
     return `'recipe'` for the `velocity` template — slot the new
     `if (templateId === 'velocity') return 'recipe';` branch after
     the existing vendor branch, before the `return 'category';`
     fallback. The state hook at line 124
     (`useState<...>(defaultByForTemplate(initialPicked))`)
     auto-picks up the new return value with no further edit.
   - Save-time params shape unchanged: the existing
     `{ range, from, to, by }` non-variance branch (line 274-279)
     covers velocity verbatim.

3. **`src/screens/cmd/sections/reports/ReportDetailFrame.tsx`**
   - Widen `overrideBy` / `onByChange` / `onPickBy` / inferred
     types and the `savedBy` parser (line 189-194) to admit
     `'recipe'`. Spec already gives the exact 5-arm ternary:
     ```ts
     const savedBy: 'reason' | 'vendor' | 'recipe' | 'category' | 'item' =
       rawSavedBy === 'item'   ? 'item'   :
       rawSavedBy === 'reason' ? 'reason' :
       rawSavedBy === 'vendor' ? 'vendor' :
       rawSavedBy === 'recipe' ? 'recipe' :
       'category';
     ```
   - Widen `effectiveBy` annotation on line 201 to the same union.
   - Widen `onPickBy` arg type (line 257) to the same union.
   - `byOpts` per-template branch chain (line 268-271) gains a
     fourth arm:
     ```ts
     const byOpts: ReadonlyArray<'reason' | 'vendor' | 'recipe' | 'category' | 'item'> =
       definition.templateId === 'waste'    ? (['reason', 'category', 'item'] as const) :
       definition.templateId === 'vendor'   ? (['vendor', 'category', 'item'] as const) :
       definition.templateId === 'velocity' ? (['recipe', 'category'] as const) :
                                              (['category', 'item'] as const);
     ```
   - Add a one-line comment above `byOpts`:
     `// At five live templates this ternary is the complexity ceiling — promote to a templates.ts byOptions field in the next velocity-shaped template's spec.`
     This makes the architect §A0 #4 deferral explicit at the
     deferred site.

4. **`src/screens/cmd/sections/ReportsSection.tsx`**
   - Widen `OverrideState['by']` union from
     `'reason' | 'vendor' | 'category' | 'item'` to add `'recipe'`.
   - Widen the `setOverrideBy` arg type (line 177) to the same
     union.
   - The `selectedSupportsBy` gate at line 241 is
     `selectedIsLive && selectedTemplate?.id !== 'variance'` — with
     velocity now `'live'`, the gate fires for it automatically.
     No edit there.
   - No removal of the PREVIEW badge needed here — the badge lives
     inside the catalog tile gated on `r.status === 'preview'`; the
     `templates.ts` flip drops it automatically. Frontend
     developer should verify in the manual smoke (per AC verification
     gates).

**TypeScript boundary:** all four widenings sit on the same union
(`'reason' | 'vendor' | 'recipe' | 'category' | 'item'`). The
quickest way to confirm coherence post-edit is
`npx tsc --noEmit` — a missed widening surfaces immediately as
"Type 'recipe' is not assignable to ...".

### A12. pgTAP test plan — `report_run_velocity.test.sql`

`plan(11)`. Arm-by-arm:

1. **Fixture sanity (1)** — Frederick store id resolves from seed
   via `select id into v_frederick from public.stores where name =
   'Frederick' limit 1;` followed by `isnt(current_setting('test.frederick_id', true), '', ...)`.

2. **Fixture sanity (2)** — Two distinct Frederick `recipes` rows
   resolve from seed (or get inserted in the do-block when fewer
   than two seed rows exist for the store). Stable across seed
   refreshes — pattern matches vendor's two-vendor SYSCO/RD lookup
   at vendor test:61-69. Recipe ids stored via
   `perform set_config('test.recipe_a', ...)` /
   `'test.recipe_b', ...`.

3. **Auth gate** — manager calling Charles (non-member store)
   raises SQLSTATE 42501. Mirrors vendor test arm (3) verbatim
   except for the function name.

4. **Empty range** — call with `from = to = '2000-01-01'`,
   `by='recipe'`. Returns populated `columns` + empty
   `kpis`/`rows`/`series` arrays; `columns[0].key = 'recipe'`.
   Mirrors vendor test arm (4) modulo the column-key flip.

5. **Single-row formula** — insert one `pos_imports` row
   (`import_date='2026-06-01'`, `store_id=<frederick>`) and one
   `pos_import_items` row (`recipe_id=<recipe A>`, `qty_sold=30`,
   `revenue=150.00`, `recipe_mapped=true`). Call with
   `from=to='2026-06-01'`, `by='recipe'`. Assert via single
   `jsonb_build_object` comparison:
   - `kpis[label='Total qty sold'].value = '30.000'`
   - `kpis[label='Total revenue $'].value = '$150.00'`
   - row count = 1
   - `rows[0].recipe = <recipe A menu_item>`
   - `rows[0].qty_sold = '30.000'`
   - `rows[0].revenue = '$150.00'`
   - `rows[0].day_count = 1`
   - `rows[0].velocity = '30.000'` (30 sold / 1-day window = 30/day).

6. **Unmapped POS row excluded** — insert a second
   `pos_import_items` row on the same import with `recipe_id IS
   NULL` AND a third row with `recipe_id=<recipe A>` but
   `recipe_mapped=false`. Re-call. Assert that `Total qty sold` /
   `Total revenue $` are UNCHANGED — both unmapped rows are
   filtered out. Mirrors the COGS exclude-unmapped policy
   (header :70-72).

7. **Multi-recipe ordering** — insert one more `pos_import_items`
   row on the same import for `<recipe B>` with smaller `revenue`
   than recipe A. Re-call with `by='recipe'`. Assert
   `array_agg(rows[i].recipe order by ord)` comes out
   `[<recipe A>, <recipe B>]` (revenue-desc, recipe-asc
   tiebreaker). Pattern matches vendor test arm (6).

8. **Velocity ratio across multi-day window** (LOAD-BEARING per PM)
   — extend the window to `from='2026-06-01', to='2026-06-30'`
   (30-day window) WITHOUT inserting any new rows. Recipe A's
   `qty_sold = 30` stays the same; `velocity` becomes
   `30 / 30 = '1.000'`. Assert
   `rows[recipe=A].velocity = '1.000'` AND
   `rows[recipe=A].day_count = 1` (still only one import date).
   This is the assertion that distinguishes the
   `qty_sold / window_days` formula from `qty_sold / day_count` —
   if a regression flipped the denominator, velocity would still
   be `30/1 = 30.000` and this arm would fail. Test name MUST
   include "denominator is window_days not day_count" so a
   reviewer scanning failures sees the contract immediately.

9. **`by='category'` smoke** — call once with `by='category'` over
   the single-day window from arm (5)/(6)/(7). Assert
   `columns[0].key = 'category'` and `rows[0]` has a `category`
   key (not a `recipe` key) AND `rows[0]` has a `recipes_count`
   key equal to the integer count of distinct recipes in that
   category. Mirrors vendor test arm (9).

10. **Top mover KPI cross-cuts** — re-call with `by='category'`.
    Assert the `Top mover` KPI value starts with `<recipe A
    menu_item> · $` — proves the KPI is computed via the recipe
    grouping regardless of the by-toggle. Mirrors vendor test arm
    semantics (vendor uses Top vendor at arm 10 implicitly via the
    multi-vendor arm 6).

11. **Envelope shape** — sorted-key list assertion matches
    `array['columns', 'kpis', 'rows', 'series']::text[]`. Mirrors
    vendor test arm (11) verbatim.

**Fixture biz_date pattern.** Use `'2026-06-01'` matching vendor —
after the 2026-05-02 seed-pull date so seed-collision regressions
surface immediately if a future seed back-dates POS history into
the test window.

**Plan(11) vs plan(12) note.** PM's spec line 324-327 allows the
developer to split arm (5) into "kpi assertion" + "per-row
assertion" for plan(12). Architect call: **stay at plan(11) with
the bundled `jsonb_build_object` assertion** — mirrors vendor test
arm (5)'s "bundled" shape (vendor's spec 035 review explicitly
acknowledged the consolidation in code-reviewer spec 035 S2,
arm 5). Saves one arm, reads identically. The
`reports_anon_revoke.test.sql` change is independent of this
choice.

### A13. `reports_anon_revoke.test.sql` extension

Plan grows from **10 → 11**. Add a new arm (7)
`report_run_velocity` denied to anon → 42501 at GRANT time. Slot
after the existing arm (6) `report_run_vendor` and before the
current arm (7) `report_reorder_list`; **renumber the trailing arms
(7)..(9) → (8)..(10)**.

Comment block at the top of the file:
- Bump "10 RPCs covered" → "11 RPCs covered" (line 10).
- Insert a new bullet `• report_run_velocity(uuid, jsonb) — spec 036`
  after the existing `• report_run_vendor(uuid, jsonb) — spec 035`
  bullet (line 19).
- The "Header was stale at..." parenthetical on line 11-13 is
  historical — leave it untouched (it's a one-time confession for
  the 8→10 bump; future bumps don't need to copy that line).

### A14. Cross-cutting confirmations

- **Realtime channels:** none touched. `pos_imports` /
  `pos_import_items` remain absent from `supabase_realtime`. No
  `store-{id}` / `brand-{id}` payload shape change. No
  `docker restart supabase_realtime_imr-inventory` in the deploy
  or dev workflow for this spec.
- **Edge functions:** none touched. No `supabase/functions/` work.
- **`src/lib/db.ts`:** no edit. Existing `runReport` covers
  velocity via the dispatcher.
- **`src/store/useStore.ts`:** no edit. Existing `runReport`
  action covers velocity unchanged.
- **`app.json`:** not touched. Slug stays
  `towson-inventory` per the CLAUDE.md DO-NOT-AUTO-FIX rule.
- **No new index** in the migration. Existing COGS runner already
  exercises the same `pos_imports (store_id, import_date)` access
  path against production data without one.
- **No new RPC helper signatures in `db.ts`** — confirms PM's spec
  AC item under "No new jest test required" — the change is
  type-only at the TS boundary and gated by `tsc --noEmit`.

### A15. Risks and tradeoffs

- **`v_window_days = 0` division-by-zero — IMPOSSIBLE.** The closed
  inclusive interval `(v_to - v_from) + 1` is always ≥ 1 because
  the range validation at section (3) rejects `v_from > v_to`. The
  developer should NOT add a `nullif(v_window_days, 0)` guard —
  that hides a real invariant violation if the range-validation
  block is ever weakened. If reviewers flag this as "missing
  defense-in-depth," the answer is "the invariant lives in the
  range check; double-guarding masks regressions there."

- **`qty_sold = 0` divides cleanly.** `0 / window_days = 0`, no
  division-by-zero. Velocity column emits `'0.000'` for that row.

- **Recipe orphan handling.** A POS row's `recipe_id` could point
  at a hard-deleted recipe (`recipes.id` deleted while a
  pos_import_items row referencing it persists — possible only if
  the FK was non-cascading, which it is per
  `init_schema.sql:191`). The left-join with
  `coalesce(r.menu_item, '(deleted recipe)')` keeps the row in the
  output. Test arm 6 covers the unmapped path; the orphan path is
  shape-tested implicitly by the same coalesce expression and is
  not separately asserted — same posture as vendor's `(deleted
  vendor)` shape (no dedicated test arm).

- **Recipe `store_id` mismatch.** `recipes` is brand-scoped per
  the brand-catalog refactor; a Frederick `pos_import_items.recipe_id`
  could point at a recipe owned by Towson if both stores share a
  brand. That's expected behaviour — the recipe is brand-level,
  not store-level. RLS allows it because the SELECT policy on
  `recipes` is brand-scoped not store-scoped. Reviewers should
  NOT flag the cross-store recipe read as an RLS gap.

- **Top-N=5 ties.** If recipes 5 and 6 by revenue tie at the
  cutoff, the deterministic tiebreaker is `recipe ASC` (the same
  rule the `rows` sort uses). One recipe is included, one is
  excluded; the chart legend doesn't show the cut. Acceptable for
  v1; future spec can add the "...and N more" affordance.

- **Empty `recipes.menu_item`.** Theoretically possible (the
  init schema has `menu_item text not null` but a future migration
  could relax it). The coalesce treats NULL recipe rows as
  `(deleted recipe)`; an empty-string `menu_item` would currently
  fall through to the literal empty string. Mitigation cost is one
  `nullif(trim(r.menu_item), '')` — acceptable defensive add but
  not load-bearing. Developer call.

- **Performance on the 286 KB seed dataset.** The seed has 23
  pos_imports rows and ~600 pos_import_items rows for the
  Frederick store. A 30-day window scan is well under a millisecond
  on the seed. Production scale (multi-month windows, multi-store
  brands with 2000+ POS rows/day) will hit the existing
  (store_id, import_date) primary access path on `pos_imports`
  followed by a `po_items.import_id` join — same shape COGS already
  runs in production. No new index needed unless scale changes
  materially, per Q9 / spec 036 out-of-scope.

- **Edge function cold-start: N/A.** RPC-only, no edge function
  involvement.

### A16. Verification gates (PM's list, architect-confirmed)

- `npx tsc --noEmit` exit 0.
- `npm run typecheck:test` exit 0.
- `npm test -- --ci` PASS (jest unchanged — no jest test added).
- `npm run test:db` PASS — pgTAP file count moves **17 → 18**;
  `reports_anon_revoke.test.sql` plan moves **10 → 11**.
  (Confirmed file count: `Glob supabase/tests/*.sql` returned 17
  files before this spec, including
  `report_run_vendor.test.sql` and `reports_anon_revoke.test.sql`
  added in spec 035.)
- `npm run test:smoke` PASS (no new arms).
- Manual browser smoke against local stack — per PM AC list:
  PREVIEW badge drop, modal pre-fill, by-toggle (`recipe` /
  `category`), save, run, multi-line chart up to 5 series,
  chip-strip override, date-range expansion shrinks velocity.

### A17. Post-merge deploy

**Migration only.** Single command from repo root:
```
npx supabase db push --linked --yes
```

No edge function deploy (`supabase functions deploy ...` not
needed; no `supabase/functions/` change).

No realtime publication touch → no
`docker restart supabase_realtime_imr-inventory` step. The
publication membership for `pos_imports` / `pos_import_items` is
unchanged (still absent from `supabase_realtime`).

No EAS rebuild needed for native — the frontend changes are pure
client code without any native module touches.

Web → Vercel auto-deploys on push to main per `vercel.json`.

## Handoff

next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. The migration
  file is `supabase/migrations/20260515120000_report_run_velocity.sql`
  (architect §A2); follow the §A3 CTE pipeline skeleton and the §A4
  dispatcher placement verbatim. New pgTAP file is
  `supabase/tests/report_run_velocity.test.sql` plan(11) per §A12;
  `supabase/tests/reports_anon_revoke.test.sql` plan grows 10 → 11
  per §A13. Frontend edits are exactly four files per §A11. After
  implementation, set Status: READY_FOR_REVIEW and list files
  changed under ## Files changed. Confirm the verification gates
  §A16 pass before handoff.
payload_paths:
  - specs/036-reports-velocity-template/spec.md

## Files changed

### Migrations
- `supabase/migrations/20260515120000_report_run_velocity.sql` — NEW.
  Creates `public.report_run_velocity(uuid, jsonb)` per architect §A3
  CTE pipeline (auth gate → param coercion → range validation →
  per-mode columns → headline totals + top-recipe → empty short-circuit
  → KPI assembly → branched rows by `by:` → top-N=5 series → envelope).
  Re-creates `public.report_run(text, uuid, jsonb)` dispatcher with the
  new `when 'velocity'` arm slotted after `when 'vendor'`. Header
  documents all 11 design choices (date anchor, closed window, no
  status filter, recipe-mapping filter, window_days denominator, top-
  N=5 series cap, tone-bands omission, no recursive CTE, index reuse,
  per-row smearing caveat, grants).

### pgTAP tests
- `supabase/tests/report_run_velocity.test.sql` — NEW. `plan(11)`:
  fixture sanity x2, auth gate, empty range, single-row formula
  (bundled with totals), unmapped exclusion, multi-recipe ordering,
  velocity-ratio denominator (LOAD-BEARING — proves denominator is
  `window_days` not `day_count`), by=category smoke, top-mover
  cross-cut, envelope shape. Hermetic begin/rollback. Recipes are
  brand-scoped per the brand-catalog refactor — fixture looks them up
  by `stores.brand_id` not the dropped `recipes.store_id`.
- `supabase/tests/reports_anon_revoke.test.sql` — MODIFIED. Plan
  bumped 10 → 11. Header bullet count bumped 10 → 11. New arm (7)
  added for `report_run_velocity` between the existing vendor arm
  and reorder arm; trailing arms (7-9) renumbered to (8-10).

### Frontend
- `src/screens/cmd/sections/reports/templates.ts` — flipped the
  `velocity` row `status: 'preview' → 'live'`. Added a comment line
  citing the new migration filename.
- `src/components/cmd/NewReportModal.tsx` — extended `BY_OPTIONS`
  registry to include `velocity: ['recipe', 'category']`. Widened
  `ByOption` union to admit `'recipe'`. Extended
  `defaultByForTemplate` to return `'recipe'` for the velocity
  template. Widened the `by` useState type.
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` — widened
  `overrideBy` / `onByChange` prop types, `savedBy` parser (5-arm
  ternary), `effectiveBy` annotation, `onPickBy` arg type, `byOpts`
  per-template branch (added velocity arm), `ByPopover` internal
  types. Inline comment at `byOpts` documents the architect §A0 #4
  deferral.
- `src/screens/cmd/sections/ReportsSection.tsx` — widened
  `OverrideState['by']` union and `setOverrideBy` arg type to admit
  `'recipe'`.

### Spec
- `specs/036-reports-velocity-template/spec.md` — set
  `Status: READY_FOR_REVIEW` and appended this `## Files changed`
  list.

## Post-merge deploy

**DO NOT** `npx supabase db push --linked --yes` from the developer
agent — that's the release-coordinator's call on the user's signoff.
Migration is purely additive (new function + dispatcher re-create);
rollback is `drop function public.report_run_velocity(uuid, jsonb);`
plus a re-create of the dispatcher with the `velocity` arm removed.
No realtime publication change, no edge function deploy, no EAS
rebuild needed.

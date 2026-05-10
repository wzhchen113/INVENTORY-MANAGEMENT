# Spec 017: Reports — COGS Template (REPORTS-2)

Status: READY_FOR_REVIEW

> Second of three sequential specs building out the Reports runner.
> **REPORTS-1** (spec 016) landed the foundation — `report_runs`, the
> dispatcher RPC `report_run`, the generic `ReportDetailFrame`, the
> single-source-of-truth `templates.ts`, and per-store RLS on
> `report_definitions` and `report_runs`. **REPORTS-2 (this spec)** flips
> the `cogs` template from `status: 'preview'` to `status: 'live'` by
> shipping `report_run_cogs`, a date-range picker on both the create
> modal and the detail header, and the column / series mapping.
> **REPORTS-3** will do the same for Variance.
>
> Templates not addressed in REPORTS-2 (variance, waste, vendor,
> velocity, custom) keep returning the `not_implemented` envelope until
> their own specs land.

## User story

As a 2AM PROJECT store manager, I want to open my saved "COGS by
category — May 2026" report and see a real COGS percentage for my
store over a date range I picked — by category, with a trend line —
so I can tell at a glance whether my food cost is moving in the right
direction without exporting to a spreadsheet.

As a brand admin viewing across stores, I want the same template to
honour `auth_can_see_store(p_store_id)` so a cross-store comparison
only surfaces stores the caller already had visibility into.

## Acceptance criteria

### Database

- [ ] New migration `supabase/migrations/20260511NNNNNN_report_run_cogs.sql`
      (timestamp after `20260510130000_report_runs_consistency.sql`):
      creates `public.report_run_cogs(p_store_id uuid, p_params jsonb) returns jsonb`
      and updates `public.report_run` (the dispatcher) to add a
      `when 'cogs' then return public.report_run_cogs(p_store_id, p_params);`
      branch.
- [ ] `report_run_cogs` matches the per-template RPC contract documented
      in `20260510120000_report_runs.sql:21-75`:
      - `language plpgsql`
      - `security invoker`
      - `set search_path = public`
      - First statement: `if not public.auth_can_see_store(p_store_id) then raise exception 'Not authorized for store %', p_store_id using errcode = '42501'; end if;`
      - `revoke execute on function public.report_run_cogs(uuid, jsonb) from public, anon;`
      - `grant execute on function public.report_run_cogs(uuid, jsonb) to authenticated;`
      - Returns the uniform envelope (`kpis`, `columns`, `rows`,
        `series`) — no `_status` / `_message` keys.
- [ ] **Params accepted (`p_params jsonb`)** — all optional, all
      defaulted by the RPC so a call with `'{}'::jsonb` succeeds with
      sensible defaults:
      - `from` — ISO date `YYYY-MM-DD`. Default: 30 days ago (i.e.
        `(now() at time zone 'utc')::date - interval '30 days'`).
      - `to` — ISO date `YYYY-MM-DD`. Default: today
        (`(now() at time zone 'utc')::date`).
      - `by` — `'category' | 'item'`. Default: `'category'`.
      - Unknown keys MUST be ignored (forward-compat).
      - Malformed `from`/`to` (non-ISO strings) MUST raise
        `invalid_text_representation` (Postgres' native error) — the
        client surfaces this as the standard sanitized "Run failed —
        check server logs" message via `db.runReport`.
      - `from > to` MUST raise
        `raise exception 'COGS report: from > to (% > %)', p_from, p_to using errcode = '22023';`
        so the frontend gets a structured error class.
- [ ] **Joins** — the RPC builds a recursive CTE that flattens prep
      recipes onto their catalog ingredients, then aggregates:
      1. `pos_imports` rows in `[from, to]` for `p_store_id` only.
      2. `pos_import_items` (mapped to a recipe) inner-join the above.
      3. `recipes` to get `category` (text column post-brand-catalog —
         **see Q3 resolution**), `sell_price`, and the join key.
      4. `recipe_ingredients` AND the flattened
         `recipe_prep_items → prep_recipe_ingredients` recursive CTE,
         all reduced to `(catalog_id, qty_per_recipe_unit)` rows.
      5. `inventory_items` on `(store_id = p_store_id, catalog_id)` for
         `cost_per_unit`.
      Computed per row: `recipe_cost_per_unit = Σ (qty × cost_per_unit)`
      across all catalog ingredients (direct + prep-flattened).
      Computed per `pos_import_items` row:
      - `revenue = pos_import_items.revenue` (raw).
      - `cogs    = pos_import_items.qty_sold × recipe_cost_per_unit`.
- [ ] **Recipe-not-mapped rows** (`pos_import_items.recipe_id is null` or
      `recipe_mapped = false`) — EXCLUDED from the aggregates. Documented
      in the migration's header comment so reviewers understand why
      summed revenue may not equal `pos_imports` totals.
- [ ] **Output — KPIs** (always two, in this order):
      1. `{ label: 'Overall COGS %', value: '<pct>%', tone: <tone> }`
         where `pct` is `Σ cogs / Σ revenue × 100` rounded to one
         decimal place, e.g. `'31.4%'`. `tone`: `'ok'` if pct < 30,
         `'warn'` if 30 ≤ pct < 35, `'danger'` if pct ≥ 35. **See Q8
         resolution** — hardcoded thresholds in REPORTS-2; a per-brand
         target column is a follow-up spec.
      2. `{ label: 'Gross margin', value: '$<m>', tone: null }` where
         `m` is `Σ revenue - Σ cogs` formatted with two decimal places
         and a thousands separator, e.g. `'$12,481.20'`. **See Q9
         resolution** — absolute dollars only in REPORTS-2; a "% of
         revenue" secondary KPI is a follow-up.
      3. **No KPIs are returned** when there are zero matching rows in
         the period (the body of `rows` is `[]`); the frame's
         `<EmptyPanel title="Empty result">` branch handles that case.
- [ ] **Output — columns** (per `params.by`):
      - `by = 'category'` (default):
        ```
        [
          { key: 'category', label: 'Category', align: 'left'  },
          { key: 'revenue',  label: 'Revenue',  align: 'right' },
          { key: 'cogs',     label: 'COGS',     align: 'right' },
          { key: 'cogs_pct', label: 'COGS %',   align: 'right' },
          { key: 'margin',   label: 'Margin',   align: 'right' }
        ]
        ```
      - `by = 'item'`:
        ```
        [
          { key: 'item',     label: 'Item',     align: 'left'  },
          { key: 'category', label: 'Category', align: 'left'  },
          { key: 'revenue',  label: 'Revenue',  align: 'right' },
          { key: 'cogs',     label: 'COGS',     align: 'right' },
          { key: 'cogs_pct', label: 'COGS %',   align: 'right' },
          { key: 'margin',   label: 'Margin',   align: 'right' }
        ]
        ```
      `'item'` here = `recipes.menu_item` (per-store recipe sales row,
      grouped). `'category'` = `recipes.category` text. Rows sorted by
      `revenue desc`.
- [ ] **Output — rows** are formatted server-side as strings so the
      frame's `formatCellValue` doesn't lose decimal precision on
      `number → JSON.stringify` round-trips:
      - `revenue`, `cogs`, `margin` → `'$' + numeric to_char(value, 'FM999,999,990.00')`.
      - `cogs_pct` → `to_char(value, 'FM990.0') || '%'`.
      - `category` falls back to `'(uncategorized)'` when null/empty.
      - `item` (item view) is `recipes.menu_item` verbatim.
- [ ] **Output — series** is `cogs_pct` over time, one point per
      `pos_imports.import_date` in the range that had any matched rows:
      ```
      [
        { label: 'COGS %', x: '2026-04-11', y: 31.7 },
        { label: 'COGS %', x: '2026-04-12', y: 30.4 },
        ...
      ]
      ```
      `y` is a numeric (not a string) — the frame's chart needs to plot
      it. Sorted ascending by `x`. Empty array `[]` when the range has
      < 2 distinct dates with matched rows (frame's chart needs ≥ 2
      points). NOT `null` — that key is reserved for templates that
      genuinely don't chart. **See Q7 resolution** — REPORTS-2 ships
      single-series `cogs_pct` only; stacked-area by category is a
      follow-up.
- [ ] **Performance budget** — the RPC must return under 500 ms for the
      seed data set (`supabase/seed.sql`) at the default 30-day range.
      No explicit indexes added in this migration; the developer should
      verify with `explain analyze` and only add indexes if the budget
      is missed. If indexes are needed, add them in the same migration
      with `if not exists` guards (suggested candidates:
      `pos_imports (store_id, import_date)`,
      `pos_import_items (import_id, recipe_id)` — both single-column
      indexes already exist in init schema; confirm before adding).

### `src/screens/cmd/sections/reports/templates.ts`

- [ ] Flip the `cogs` row from `status: 'preview'` to `status: 'live'`.
      The `PREVIEW` badge auto-disappears from the catalog tile because
      `ReportsSection` derives the badge from `template.status`.
- [ ] No other rows change. The other five templates remain `'preview'`.

### `src/components/cmd/NewReportModal.tsx`

- [ ] Add a date-range field (two `TextInput`s + presets) below the
      template grid, ABOVE the report-name input. The field is
      **always visible** (not gated on `status === 'live'`) — this
      simplifies the layout, keeps the UI consistent across templates,
      and lets non-live templates capture a range for when their
      runner lands. **See Q1 / Q2 resolution.**
- [ ] Field shape:
      - Two readonly-display strings showing `from` / `to` as
        `YYYY-MM-DD`.
      - Four preset chips: `Last 30d` (default selected),
        `This month`, `Last full month`, `Last 90d`. Clicking a chip
        rewrites `from`/`to` in local state.
      - Manual edit affordance: each readonly cell flips to an editable
        `TextInput` on tap (web: also on focus). Manual entries are
        validated client-side — invalid dates revert with a Toast
        `error` message `'Invalid date — must be YYYY-MM-DD'` and the
        chip stays where it was.
- [ ] The picked range is written into `params` on create:
      `params: { range: '<preset-id>', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', by: 'category' }`.
      `range` is informational (the detail header chip uses it for the
      preset-label display); `from` / `to` are authoritative.
- [ ] The existing `+ NEW REPORT` quick-action button at the top of
      `ReportsSection` continues to default to Variance; it opens the
      modal with no `initialTemplateId` and the date-range field stays
      at the `Last 30d` default. No regression in keyboard shortcuts
      (`↑↓ pick · ⏎ create · ⌘⏎ create & run`).

### `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`

- [ ] The header chip `rangeChip` (currently a read-only string from
      `definition.params?.range`) becomes a small **dropdown** with the
      same four preset chips. Selecting a new preset:
      1. Calls a new prop `onRangeChange(range, from, to)` provided by
         `ReportsSection`.
      2. Does NOT immediately re-run the report (no surprise compute);
         the next press of `RUN` uses the new range.
      3. The chip shows a subtle `·` indicator when the in-frame range
         differs from the definition's saved range, communicating "this
         is an override, the saved report still has the old range".
- [ ] The frame's existing branches (no-run / pending / error /
      not-implemented / result) are unchanged. The KPI strip, table,
      and chart already support tone, alignment, and multi-series —
      no frame code changes for the COGS template beyond the chip
      dropdown.
- [ ] **Override scope.** The chip override is in-memory only for
      REPORTS-2. The saved `ReportDefinition.params` is NOT mutated by
      the chip — that's a follow-up if/when we add a "save changes to
      definition" affordance. Rationale: every press of RUN persists a
      new `report_runs` row whose `params` contain the
      override-at-time-of-run, so the audit trail is preserved even if
      the saved definition's params drift.

### `src/screens/cmd/sections/ReportsSection.tsx`

- [ ] Detail-view state gains `overrideRange?: { range, from, to }`
      alongside the existing `selectedDefinitionId`. Overrides are
      **scoped per definition** (stored in a `Map<definitionId, ...>`
      keyed by report id) — opening a saved report **preserves any
      prior chip overrides for that report** (mental model: each
      saved report is its own "open tab" with its own override
      state). Switching between saved reports therefore retains
      each report's independent override; selecting a chip from
      the detail header updates the override for the currently
      selected report. Deleting a saved report cleans up its
      Map entry. *Revised round-2: the original AC text said
      "Opening a saved report resets `overrideRange` to
      undefined" — the implementation chose per-definition
      persistence and the spec text is now aligned with that
      behaviour.*
- [ ] When the user presses RUN, `runReport(definitionId, overrideRange?)`
      is called. The store action gains the optional second arg (see
      below). Without an override, behaviour is identical to REPORTS-1.

### `src/store/useStore.ts`

- [ ] `runReport(definitionId)` signature changes to
      `runReport(definitionId, overrideParams?)`. The new arg is
      `Partial<ReportDefinition['params']>` — when present, the action
      passes `{ ...def.params, ...overrideParams }` to `db.runReport`.
      Without an override, behaviour is identical.
- [ ] Optimistic row uses the same merged params so a refresh during
      pending doesn't lose the override visually.
- [ ] No new actions. `loadLatestRun` unchanged.

### `src/lib/db.ts`

- [ ] No new helpers required. `runReport` already accepts a `params`
      arg and forwards it to the dispatcher. **The dispatcher's CASE
      now routes `'cogs'` to `report_run_cogs`** — this is the only
      backend wiring change beyond the new RPC itself.

### Out of scope for REPORTS-2 (explicitly)

- **Variance template** — REPORTS-3 owns that, by plan. The dispatcher's
  `when 'variance'` branch stays in the comment in
  `20260510120000_report_runs.sql` for that spec to flip.
  *Rationale: per the plan and REPORTS-1's "Out of scope" line about
  sequential per-template specs.*
- **Waste / vendor / velocity / custom templates.** They keep returning
  the `not_implemented` envelope.
  *Rationale: each requires its own join story; deferring per the plan.*
- **`scheduled.tsx` and `custom.tsx`** tabs in `ReportsSection`.
  Untouched.
  *Rationale: both need their own specs (pg_cron / sandboxed exec).*
- **CSV / PDF export** of the COGS run. Existing PapaParse + jsPDF
  utilities make this trivial later but it's not blocking.
  *Rationale: user has not asked for it; defer until they do.*
- **A "Run history" list** inside the detail view. REPORTS-1 already
  punted this; REPORTS-2 keeps the latest-only display.
  *Rationale: append-only history is in DB; no UI yet.*
- **Backfilling `pos_import_items` with per-row dates.** REPORTS-2
  inherits the `pos_imports.import_date` smearing caveat — if one POS
  CSV spans multiple business days, those rows roll up to the import's
  single date. Documented in the migration header.
  *Rationale: per-row date is a much larger schema change; the user
  explicitly accepted smearing as a documented caveat in their request.*
- **Per-brand COGS target** (e.g. "warn when above 32%"). The KPI tone
  thresholds in this spec are HARDCODED at 30/35; a per-brand or
  per-category target column is a follow-up spec.
  *Rationale: where the target lives — `brands`, `recipe_categories`,
  a new table — is its own modelling decision and bleeds into the
  Variance spec.*
- **Stacked-area-by-category chart.** REPORTS-2 ships a single
  `cogs_pct` line series. Stacked area is deferred.
  *Rationale: the frame supports `series[].label` already so a future
  spec can ship multi-series without frame work — but the chart's
  legend / overlap behaviour needs more design.*
- **Saving a chip-override back to the definition.** The chip is
  in-memory only.
  *Rationale: out-of-scope to avoid scope-creep on the modal/form
  surface; if the user reopens the report tomorrow they see the saved
  range.*
- **Realtime push** on `report_runs`. Still NOT in the
  `supabase_realtime` publication. Tab B has to reload.
  *Rationale: same as REPORTS-1.*

## Open questions resolved

These are decisions the user delegated to defaults under auto-mode.
Each is called out so the architect / user can flip them with one
line of feedback before READY_FOR_BUILD. The Q4 (missing-cost) and
Q8 (target indicator) defaults shape the SQL — push back on either
if the project's policy differs.

- **Q1: Default date range.**
  → **A: Last 30 days.** Rolling window ending today; matches the
  legacy hardcoded preview's "last 30d" range chip in the
  `ReportDetailFrame`. Rejected: "Last full month" (calendar-aware,
  but produces an awkward 30-31-28 day range that's harder to
  compare period-over-period); "Last 90 days" (the old catalog's
  fake number; too long for a default and noisier KPI). The user can
  override with the chip dropdown — and the three other presets are
  there as one-tap alternatives.

- **Q2: `by` parameter — create-time vs run-time vs tabbed toggle.**
  → **A: create-time via modal, plus an in-frame chip toggle.**
  The modal's date-range field is *always-visible* (per AC) so a
  `by:` chip cluster fits naturally next to it. In the detail header
  we ALSO render a small `view: category | item` toggle (mirrors the
  in-frame range chip pattern). Run-time toggle is purely visual —
  it triggers a re-run with the new `by` param, not a stored
  definition change. **Note:** the in-frame `by` toggle is in scope
  for REPORTS-2 and adds one more piece of state to `ReportsSection`
  (`overrideBy?: 'category' | 'item'`). If the architect wants to
  defer the in-frame toggle and ship only the create-time modal
  selection in REPORTS-2, flip with one line.

- **Q3: Category source.**
  → **A: `recipes.category` (the text column).** Spot-check:
  `recipes` has a `category text` column (init schema) but NO
  `category_id` FK to `recipe_categories`. `recipe_categories` is a
  separate table currently used only for tag suggestions in the
  recipe-edit UI (see `20260510030000_recipe_categories_super_admin_rls.sql`).
  No P3/P5 migration added an FK. Resolution: group by
  `recipes.category` text. NULL/empty rolls up to
  `'(uncategorized)'`. **Migrating to an FK is a larger refactor;
  REPORTS-2 doesn't need it.** If a future spec adds the FK, the
  RPC's `group by` clause is the only line that changes.

- **Q4: Missing `cost_per_unit` handling.**
  → **A: Compute partial cost AND flag the row.** When ANY catalog
  ingredient on a recipe has no `inventory_items.cost_per_unit` row
  for `p_store_id` (or has `cost_per_unit = 0` after coalesce), the
  RPC:
  1. Treats that ingredient's contribution as `0` in the cost sum
     (i.e. artificially deflates COGS for that recipe — flagged, not
     silent).
  2. Appends `' ⚠'` to the row's `item` or `category` cell so the
     UI shows a visible flag without a new column.
  3. Counts the affected recipes and adds a third KPI when count > 0:
     `{ label: 'Recipes missing cost', value: <int>, tone: 'warn' }`.
  Rationale: option (a) "skip the recipe" hides revenue from the
  Σ revenue too, distorting COGS%. Option (b) "treat missing cost
  as 0" without flagging would falsely show a great margin. Option
  (c) "fail the run" is too brittle — most stores will have at
  least one missing-cost ingredient at any given time. The chosen
  option is the closest match to "partial cost and flag" you
  surfaced; flag UX is the `' ⚠'` suffix to avoid a new column the
  architect has to wire. **Push back if the project's policy is
  stricter** (fail the run) — this is the open question with the
  most downstream effect.

- **Q5: Prep recipe depth.**
  → **A: Recursive CTE, cap at 5 levels with cycle detection.**
  A `WITH RECURSIVE` traversal flattens
  `recipe_prep_items → prep_recipe_ingredients (sub_recipe_id)`
  arbitrarily deep, multiplying quantities through. Cycle
  detection: a path-array column tracks the chain of
  `prep_recipe_id` UUIDs; the recursive step refuses to add a
  `prep_recipe_id` already in the path. Depth cap at 5 is a
  belt-and-suspenders sanity bound — if a real recipe chains
  deeper, the run **raises a `NOTICE`, returns the truncated
  partial result, adds a `Recipe graph truncated` KPI (tone=warn,
  count of distinct top-level recipes whose chain was cut off)
  when count > 0, and suffixes `' ⚠ (truncated)'` on rows derived
  from those recipes**. The truncated suffix takes precedence
  over the `' ⚠'` missing-cost suffix when both apply to the same
  row. The original design called for `raise exception ... 54001`
  but was revised at round-2 review per architect's option 2:
  partial-credit + envelope surfacing matches the Q4 "partial
  credit and flag" theme and prevents one deep-chained recipe
  from blocking the entire COGS view.
  Rationale: capping at 1 level is too restrictive for real
  kitchens (mother sauces → component sauces → final dish is
  3 levels). Recursive without depth cap is bug-prone if seed data
  ever has a cycle. The 5-level cap matches industry norms and is
  cheap to verify.

- **Q6: Multi-day POS import smearing.**
  → **A: Documented caveat, no schema change in REPORTS-2.** The
  `pos_imports.import_date` is used as the time bucket. If one CSV
  spans multiple business days, those rows fall on a single bucket.
  Documented in the migration header comment. A separate spec can
  add a per-row date if it becomes painful.
  Rationale: per-row date is a much larger change (POS import
  pipeline rewrite, new column on `pos_import_items`, backfill of
  existing data); not blocking COGS visibility now.

- **Q7: Chart shape.**
  → **A: Single-series COGS % over time (line).** Matches the
  detail frame's existing line+area treatment. Stacked-area by
  category is a follow-up if users ask for it. COGS $ over time
  is less actionable (it tracks revenue too) — % is the more
  meaningful trend.

- **Q8: COGS target indicator.**
  → **A: Hardcoded thresholds for KPI tone only; no per-brand target
  in REPORTS-2.** The "Overall COGS %" KPI tones as `ok < 30%`,
  `warn 30-35%`, `danger ≥ 35%`. No horizontal target line on the
  chart; no row tone (the table's `align: 'right'` + tabular-nums is
  the only treatment). Rationale: where a per-brand or per-category
  target lives is a modelling decision (`brands.target_cogs_pct`?
  `recipe_categories.target_cogs_pct`? a new `cogs_targets` table?)
  with implications for Variance and Waste reports too. Ship the
  template with sensible defaults; the target column is its own
  follow-up spec when the user actually wants per-brand thresholds.
  **Push back** if the hardcoded thresholds need to be different
  (e.g. 25/30 instead of 30/35).

- **Q9: `gross_margin_$` KPI.**
  → **A: Absolute dollars only in REPORTS-2.** Format:
  `'$12,481.20'` with thousands separator and two decimals. A
  secondary "% of revenue" KPI is deferred to the
  per-brand-target follow-up spec where it'll align with the COGS%
  target.

## Dependencies

- **Spec 016 (REPORTS-1)** — `report_runs` table, dispatcher RPC
  `report_run`, `ReportDetailFrame`, `templates.ts`, the `runReport`
  store action, and the per-store RLS shape. All committed at
  `c4fb85f`.
- `public.auth_can_see_store(uuid)` from
  `supabase/migrations/20260504173035_per_store_rls_hardening.sql`.
- `inventory_items (store_id, catalog_id)` unique key from
  `supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql:42`.
- `recipe_ingredients.catalog_id` NOT NULL post-P3 (same file:24).
- `prep_recipe_ingredients (catalog_id or sub_recipe_id)` CHECK from
  the same file (`prep_ri_catalog_or_subrecipe_check`).
- `pos_imports.import_date` (date column) and
  `pos_import_items.recipe_id` from init schema.
- Frontend: no new dependencies. Re-uses `ReportDetailFrame` from
  REPORTS-1, the `Toast` plumbing from `react-native-toast-message`,
  the existing Cmd theme tokens, and the SVG chart code in
  `ReportDetailFrame`'s `ResultChart`.
- No new edge functions. No new third-party libraries.
- Follow-up specs that build on REPORTS-2:
  - **REPORTS-3** (Variance) — extends the dispatcher's `case`
    statement to add `'variance'`; reuses the per-store
    `inventory_items.cost_per_unit` join pattern that REPORTS-2
    proves out.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only — all new code in
  `src/screens/cmd/sections/reports/`. `src/screens/AdminScreens.tsx`
  is not touched.
- **Per-store or admin-global:** per-store. `report_run_cogs` gates
  on `auth_can_see_store(p_store_id)` and pulls
  `inventory_items.cost_per_unit` filtered by `store_id = p_store_id`.
  Admins/super-admins keep cross-store visibility via the helper's
  short-circuit to `auth_is_admin()`.
- **Realtime channels touched:** none. `report_runs` is still NOT in
  the realtime publication (per REPORTS-1's "Out of scope"). No
  `docker restart supabase_realtime_imr-inventory` step needed.
- **Migrations needed:** yes — one new migration with
  `report_run_cogs` plus a `create or replace function
  public.report_run(...)` that adds the `when 'cogs'` branch. The
  re-creation of the dispatcher is necessary because Postgres has no
  "alter function add CASE branch" affordance. Pre-flight: confirm
  the previous dispatcher's signature is unchanged so callers see no
  surface drift.
- **Edge functions touched:** none. All backend logic is Postgres
  RPC. Auth is JWT via PostgREST.
- **Web/native scope:** both. The date-range picker uses two
  `TextInput`s + preset chips — native-safe. The chip-dropdown in
  the detail header uses RN's `TouchableOpacity` with a
  `Modal`/popover pattern that already works in both shells (mirrors
  the existing template-picker modal).
- **Tests:** there's no test framework wired up yet. Acceptance
  criteria are testable manually:
  - Backend: `select report_run('cogs', '<store>', '{"from":"2026-04-01","to":"2026-05-01","by":"category"}'::jsonb)`
    against the local seed.
  - Frontend: create a "COGS by category — May 2026" report, change
    the chip to `Last 90d`, press RUN, verify KPI tone tracks the
    30/35 boundaries, verify row formatting matches `$12,481.20`
    pattern, verify chart shows N points sorted by date.
  - RLS: from a non-admin session scoped to one store, confirm
    calling `report_run('cogs', '<other-store>', '{}')` raises
    `42501`.
  - If the test-engineer wants a smoke script alongside
    `scripts/smoke-edge.sh`, that's a follow-up — REPORTS-2
    doesn't introduce one.
- **`app.json` slug:** untouched. Not a build-identifier change.
- **Files explicitly NOT modified:**
  `src/store/useSupabaseStore.ts`, `src/store/useJsonServerSync.ts`,
  `db.json`, `src/screens/AdminScreens.tsx`, the `npm run db`
  script.

## Appendix A — Worked SQL sketch (non-binding)

For the architect / dev — the recursive flatten + aggregate looks
roughly like the below. The architect owns final shape;
optimisations (precomputed `recipe_cost_unit` view, etc.) are at
their discretion provided the AC envelope is preserved exactly.

```sql
-- Inside report_run_cogs after the auth check and param coercion.
with params as (
  select
    coalesce((p_params->>'from')::date, (now() at time zone 'utc')::date - interval '30 days') as d_from,
    coalesce((p_params->>'to')::date,   (now() at time zone 'utc')::date)                       as d_to,
    coalesce(p_params->>'by', 'category')                                                       as by_dim
),
-- 1. Direct recipe ingredients reduced to (recipe_id, catalog_id, qty).
direct_ri as (
  select
    ri.recipe_id,
    ri.catalog_id,
    ri.quantity::numeric as qty
  from public.recipe_ingredients ri
),
-- 2. Recursive flatten of recipe → prep_recipe → (catalog_id, qty).
recursive_prep as (
  -- Base: each prep_recipe and its direct catalog ingredients,
  -- multiplied by the recipe→prep quantity.
  select
    rpi.recipe_id,
    pri.catalog_id,
    (rpi.quantity * pri.quantity)::numeric as qty,
    array[rpi.prep_recipe_id]              as visited,
    1                                       as depth
  from public.recipe_prep_items rpi
  join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rpi.prep_recipe_id
  where pri.catalog_id is not null

  union all

  -- Step: descend via sub_recipe_id, accumulating quantity along the chain.
  select
    rp.recipe_id,
    pri.catalog_id,
    (rp.qty * pri.quantity)::numeric,
    rp.visited || pri.sub_recipe_id,
    rp.depth + 1
  from recursive_prep rp
  join public.prep_recipe_ingredients prev_pri on prev_pri.prep_recipe_id = rp.visited[array_length(rp.visited, 1)]
  join public.prep_recipe_ingredients pri      on pri.prep_recipe_id      = prev_pri.sub_recipe_id
  where prev_pri.sub_recipe_id is not null
    and not (prev_pri.sub_recipe_id = any (rp.visited))  -- cycle guard
    and rp.depth < 5                                      -- depth cap
    and pri.catalog_id is not null
),
all_ri as (
  select recipe_id, catalog_id, sum(qty) as qty
  from (
    select * from direct_ri
    union all
    select recipe_id, catalog_id, qty from recursive_prep
  ) u
  group by recipe_id, catalog_id
),
-- 3. Recipe cost per unit, with per-store inventory costs.
recipe_cost as (
  select
    ari.recipe_id,
    sum(ari.qty * coalesce(ii.cost_per_unit, 0)) as cost_per_unit,
    bool_or(ii.id is null or coalesce(ii.cost_per_unit, 0) = 0) as missing_cost
  from all_ri ari
  left join public.inventory_items ii
    on ii.catalog_id = ari.catalog_id
   and ii.store_id   = p_store_id
  group by ari.recipe_id
),
-- 4. POS rows in range for this store, joined to recipes.
sales as (
  select
    pi.import_date::date as biz_date,
    r.id                 as recipe_id,
    coalesce(nullif(trim(r.category), ''), '(uncategorized)') as category,
    r.menu_item          as item,
    pii.qty_sold::numeric * rc.cost_per_unit as cogs,
    pii.revenue::numeric                      as revenue,
    rc.missing_cost
  from public.pos_imports pi
  join public.pos_import_items pii on pii.import_id = pi.id
  join public.recipes r            on r.id = pii.recipe_id
  join recipe_cost rc              on rc.recipe_id = r.id
  cross join params p
  where pi.store_id = p_store_id
    and pi.import_date >= p.d_from
    and pi.import_date <= p.d_to
    and pii.recipe_id is not null
),
-- 5. Aggregate into rows/series/kpis per `by`.
...
```

The architect chooses whether to inline this in one CTE chain (one
RPC) or split into a helper view. The contract — input params,
output envelope, RLS check — is fixed.

## Appendix B — Verification script outline (for the architect)

The dev can adapt this into `scripts/smoke-cogs.sh` if the test-
engineer requests one. Not in scope for REPORTS-2 itself.

```bash
# 1. Auth (mirror scripts/smoke-edge.sh's bearer pattern).
JWT="$(curl ... /token | jq -r .access_token)"
STORE_ID="$(curl ... /rest/v1/stores?select=id | jq -r '.[0].id')"

# 2. Default range, by category.
curl ... /rest/v1/rpc/report_run \
  -d "{\"p_template_id\":\"cogs\",\"p_store_id\":\"$STORE_ID\",\"p_params\":{}}" \
  | jq '.kpis, (.rows | length), (.series | length)'

# 3. By item.
curl ... /rest/v1/rpc/report_run \
  -d "{\"p_template_id\":\"cogs\",\"p_store_id\":\"$STORE_ID\",\"p_params\":{\"by\":\"item\"}}" \
  | jq '.columns[].key'

# 4. From > to should raise.
curl ... /rest/v1/rpc/report_run \
  -d "{\"p_template_id\":\"cogs\",\"p_store_id\":\"$STORE_ID\",\"p_params\":{\"from\":\"2026-05-10\",\"to\":\"2026-04-10\"}}" \
  | jq .  # expect 22023 error class

# 5. Other store as a non-admin → 42501.
SCOPED_JWT="$(curl ... /token | jq -r .access_token)"  # per-store user
OTHER_STORE_ID="$(curl ... /rest/v1/stores?select=id | jq -r '.[1].id')"
curl ... /rest/v1/rpc/report_run \
  -d "{\"p_template_id\":\"cogs\",\"p_store_id\":\"$OTHER_STORE_ID\",\"p_params\":{}}" \
  | jq .  # expect 42501
```

## Appendix C — Files the architect / devs will touch

### Migrations
- `supabase/migrations/20260511NNNNNN_report_run_cogs.sql` (new) —
  `report_run_cogs(uuid, jsonb)` plus `create or replace function
  public.report_run(...)` with the `'cogs'` branch added. Header
  comment documents: (a) the multi-day POS smearing caveat, (b) the
  missing-cost partial-credit-and-flag policy, (c) the depth-5 prep
  cap, (d) the hardcoded 30/35 KPI tone thresholds (so a future
  spec knows where to swap to per-brand targets).

### TypeScript types
- `src/types/index.ts` — extend `ReportDefinition['params']`'s
  documented shape (it's already `Record<string, unknown>`) with a
  comment noting the COGS template's expected keys: `range`, `from`,
  `to`, `by`. No runtime type change — `params` stays
  `Record<string, unknown>` for forward-compat.

### Data layer
- `src/lib/db.ts` — no signature change. `runReport` already forwards
  `params` to the dispatcher; the new RPC is a pure backend addition.

### Store
- `src/store/useStore.ts` — `runReport(definitionId)` becomes
  `runReport(definitionId, overrideParams?)` per AC. Optimistic row
  uses the merged params.

### Frontend
- `src/screens/cmd/sections/reports/templates.ts` — flip the `cogs`
  template's `status` from `'preview'` to `'live'`. One-line diff.
- `src/components/cmd/NewReportModal.tsx` — add the date-range field
  (presets + manual edit + validation) and the `by:` toggle. Writes
  `params: { range, from, to, by }` on create.
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` — convert
  the range chip from a read-only `Text` to a `TouchableOpacity`
  that opens a small dropdown; add an `onRangeChange` (and optionally
  `onByChange`) prop; render a subtle `·` indicator when the
  in-frame range/by differs from the definition's saved values.
- `src/screens/cmd/sections/ReportsSection.tsx` — track
  `overrideRange` and (optionally) `overrideBy` in detail-view local
  state; pass `onRangeChange` to the frame; pass merged params to
  `runReport`.

### Verification (recorded for reviewers)
- `npx supabase db reset` applies the new migration cleanly.
- `select report_run('cogs', '<store-uuid>', '{}'::jsonb)` returns
  the uniform envelope (not `_status: not_implemented`).
- Auth: non-admin session against another store's id raises `42501`;
  malformed dates raise `22023` / `22007` depending on Postgres'
  native error class.
- Frontend: catalog tile for `cogs` no longer shows the PREVIEW
  badge; modal default range is `Last 30d`; detail header chip
  dropdown changes the in-frame range without auto-running; RUN
  uses the latest override; saved definition's `params` is unchanged
  after an override-and-run.
- TypeScript: `npx tsc --noEmit` shows no new errors in
  `useStore.ts`, `db.ts`, `templates.ts`, `NewReportModal.tsx`,
  `ReportDetailFrame.tsx`, or `ReportsSection.tsx`.
- Browser-preview verification (per CLAUDE.md feedback note) — the
  developer should exercise the create / open / chip-change / run
  flow in the local stack with `npm run dev:db` and
  `admin@local.test`.

## Backend Architecture

This design covers `report_run_cogs(uuid, jsonb)` and the dispatcher
re-creation. The REPORTS-1 foundation
(`supabase/migrations/20260510120000_report_runs.sql` and
`20260510130000_report_runs_consistency.sql`) already provides the
table, RLS, BEFORE-trigger consistency, the `ran_by := auth.uid()`
override, and the dispatcher's `not_implemented` envelope path. This
spec adds one new RPC and re-creates the dispatcher in place to add the
`when 'cogs'` arm.

### Open-question verdicts before READY_FOR_BUILD

- **Q4 (missing `cost_per_unit`) — RATIFIED with one tightening.** The
  PM's "partial credit + flag" resolution is the right call for the
  reasons documented in the spec (option (a) "skip recipe" hides
  revenue and distorts the headline COGS%; option (c) "fail run" is
  too brittle on real datasets). I would, however, tighten the policy
  for the recursive prep-flatten path: a prep-recipe whose own
  sub-ingredients have a missing cost contributes 0 cost up the chain
  AND propagates the missing-cost flag to every parent recipe that
  references it. This keeps the data model simple (the `bool_or` over
  `missing_cost` already does this — see SQL below) and avoids the
  trap where a deeply-nested missing cost goes silent because the
  flag sits on the prep-recipe instead of the menu item the user is
  reading. Net effect: any recipe whose total cost graph touches a
  null `cost_per_unit` gets the `' ⚠'` suffix. I treated this as a
  clarification rather than a flip — surface to the user only if
  they want missing-cost-on-a-prep-recipe to be silent at the
  menu-item level.

- **Q8 (COGS target thresholds) — RATIFIED.** Hardcoded 30/35 is the
  right REPORTS-2 simplification. Push-back rejected:
  - Option (b) "add `brands.cogs_target_pct` now" pulls the
    target-modelling decision into REPORTS-2's slice when the spec
    explicitly defers it. It also conflicts with REPORTS-3 (Variance)
    which will likely want the same target structure but for a
    different purpose, and with a future "per-category target" idea.
    Where the column lives needs its own design pass.
  - Option (c) "accept `params.target` from the modal" creates a UI
    surface (a number input) that REPORTS-2 doesn't ship in the
    modal AC. Adding it now would also let two saved reports for the
    same store render different tones for the same underlying COGS%,
    which is confusing without a "target=brand default unless set"
    semantics layer that itself needs (b).

  Brands whose actual target is 28% or 40% will see the wrong tone —
  that is a known, explicit limitation of REPORTS-2 documented in
  the migration header so the follow-up spec knows what to fix.

  **No open question raised back to the user on Q4 or Q8 — both
  resolutions stand.**

- **Out-of-scope clarifier (NEW — flagged here, not pushed back).**
  The PM accepted the in-frame `by:` toggle in REPORTS-2 (Q2). The
  acceptance criteria mention `overrideRange` but only hint at
  `overrideBy` parenthetically. **The architect endorses shipping
  `overrideBy` in REPORTS-2** — it's the same shape as
  `overrideRange`, the column array already supports both `by`
  values, and re-running with the new `by` is a one-line change in
  the merged-params path. The frontend-developer should treat both
  override states symmetrically.

### Migration — file, structure, and full SQL

**File:** `supabase/migrations/20260511120000_report_run_cogs.sql`
(timestamp after `20260510130000_report_runs_consistency.sql`).
Additive + replacement (the dispatcher is `create or replace`d in
full so the new arm lands inline). Safe to roll back by dropping
`report_run_cogs` and `create or replace`-ing the dispatcher back to
the REPORTS-1 shape.

#### Migration block 1 — `report_run_cogs(uuid, jsonb) returns jsonb`

```sql
-- ============================================================
-- Spec 017 (REPORTS-2) — COGS template runner
--
-- Computes per-store cost-of-goods-sold over a date range, grouped by
-- recipes.category text or recipes.menu_item, with a cogs_pct daily
-- trend series. Returns the uniform envelope per the per-template RPC
-- convention documented in 20260510120000_report_runs.sql:21-75.
--
-- Caveats documented for reviewers / future-spec authors:
--   • POS smearing: `pos_imports.import_date` is the time-bucket key.
--     If one POS CSV spans multiple business days those rows roll up
--     to the import's single date. Per-row date is a separate spec.
--   • Missing cost policy (Q4): a recipe whose ingredient cost graph
--     touches ANY null/zero `inventory_items.cost_per_unit` is
--     partially-credited (the null contribution becomes 0) AND
--     flagged with a ' ⚠' suffix on the row label. Propagates through
--     prep-recipe nesting via `bool_or(missing_cost)`. Counted in
--     the "Recipes missing cost" KPI when > 0.
--   • Hardcoded KPI tone thresholds (Q8): ok < 30%, warn 30-35%,
--     danger ≥ 35%. Per-brand or per-category targets are deferred.
--   • Prep-recipe depth cap = 5 with cycle detection on the visited
--     `prep_recipe_id` array. Real kitchens chain 2-3 levels; 5 is
--     the belt-and-suspenders bound. Exceeding depth raises NOTICE,
--     returns truncated partial result, and surfaces the truncation
--     via a `Recipe graph truncated` KPI plus `' ⚠ (truncated)'` row
--     suffix. Architect's original design raised 54001 — revised at
--     round-2 review per option 2 of the depth-cap divergence.
-- ============================================================

create or replace function public.report_run_cogs(
  p_store_id uuid,
  p_params   jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_from   date;
  v_to     date;
  v_by     text;
  v_envelope jsonb;
begin
  -- (1) Auth gate — same shape as the dispatcher and report_run_stub.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) Param coercion. Malformed dates raise 22007/22008 natively
  -- (invalid_text_representation / datetime_field_overflow); the
  -- frontend's runReport sanitizer already maps to "Run failed —
  -- check server logs". Unknown keys in p_params are ignored.
  v_from := coalesce(
    nullif(p_params->>'from', '')::date,
    ((now() at time zone 'utc')::date - interval '30 days')::date
  );
  v_to := coalesce(
    nullif(p_params->>'to', '')::date,
    (now() at time zone 'utc')::date
  );
  v_by := coalesce(nullif(p_params->>'by', ''), 'category');
  if v_by not in ('category', 'item') then
    v_by := 'category';  -- forward-compat: silently coerce unknown values
  end if;

  -- (3) Range validation — structured 22023 per AC.
  if v_from > v_to then
    raise exception 'COGS report: from > to (% > %)', v_from, v_to
      using errcode = '22023';
  end if;

  -- (4) Build the envelope with one composing query. The recursive
  -- prep-flatten + aggregates + final reshape all live in a single
  -- WITH-chain so the planner can fuse them.
  with
  -- (4a) Direct recipe ingredients reduced to (recipe_id, catalog_id, qty).
  direct_ri as (
    select
      ri.recipe_id,
      ri.catalog_id,
      ri.quantity::numeric as qty
    from public.recipe_ingredients ri
    where ri.catalog_id is not null
  ),
  -- (4b) Recursive flatten of recipe → prep_recipe → sub_recipe → … → catalog.
  -- The base step seeds the recursion with each (recipe, prep_recipe)
  -- direct link from `recipe_prep_items`. The recursive step descends
  -- via `prep_recipe_ingredients.sub_recipe_id` (which points at
  -- another prep_recipes row), accumulating quantity and tracking the
  -- visited prep_recipe_id chain to detect cycles. We emit a
  -- (recipe_id, catalog_id, qty) row whenever a prep ingredient has
  -- catalog_id IS NOT NULL — these are the leaf "raw" ingredients.
  recursive_prep as (
    -- BASE: top-level recipe → prep_recipe → its ingredients (raw or sub-ref).
    select
      rpi.recipe_id,
      pri.catalog_id,
      pri.sub_recipe_id,
      (rpi.quantity * pri.quantity)::numeric as qty,
      array[rpi.prep_recipe_id]              as visited,
      1                                       as depth
    from public.recipe_prep_items rpi
    join public.prep_recipe_ingredients pri
      on pri.prep_recipe_id = rpi.prep_recipe_id

    union all

    -- STEP: descend from a sub-recipe ref into THAT sub-recipe's
    -- prep_recipe_ingredients. Note we do NOT re-walk the previous
    -- row's prep — we descend exactly one level via sub_recipe_id.
    select
      rp.recipe_id,
      pri.catalog_id,
      pri.sub_recipe_id,
      (rp.qty * pri.quantity)::numeric,
      rp.visited || rp.sub_recipe_id,
      rp.depth + 1
    from recursive_prep rp
    join public.prep_recipe_ingredients pri
      on pri.prep_recipe_id = rp.sub_recipe_id
    where rp.sub_recipe_id is not null
      and not (rp.sub_recipe_id = any (rp.visited))   -- cycle guard
      and rp.depth < 5                                 -- depth cap
  ),
  -- (4c) Cycle/depth violation detection. We `raise` from a separate
  -- subquery at result-realization time so the recursion's own
  -- `depth < 5` filter won't silently truncate a real cycle. If the
  -- input has a cycle that the depth filter cuts at level 5, a
  -- subsequent depth-5 iteration would still try to walk it; we
  -- detect "any row at depth = 5 with sub_recipe_id non-null AND
  -- not in visited" — that's the chain-too-deep signal.
  depth_violations as (
    select count(*) as n
    from recursive_prep
    where depth = 5
      and sub_recipe_id is not null
      and not (sub_recipe_id = any (visited))
  ),
  -- (4d) Leaf catalog ingredients only — these are what we cost.
  prep_leaves as (
    select recipe_id, catalog_id, qty
    from recursive_prep
    where catalog_id is not null
  ),
  -- (4e) Combined per-recipe ingredient list (direct + flattened-prep).
  all_ri as (
    select recipe_id, catalog_id, sum(qty)::numeric as qty
    from (
      select * from direct_ri
      union all
      select recipe_id, catalog_id, qty from prep_leaves
    ) u
    group by recipe_id, catalog_id
  ),
  -- (4f) Per-recipe cost: Σ qty × cost_per_unit. Missing cost is
  -- treated as 0; missing_cost flag rolls up via bool_or. A recipe
  -- that touches a null/zero cost ANYWHERE in its graph (including
  -- prep-recipe nested ingredients) is flagged.
  recipe_cost as (
    select
      ari.recipe_id,
      sum(ari.qty * coalesce(ii.cost_per_unit, 0))::numeric as cost_per_unit,
      bool_or(ii.id is null or coalesce(ii.cost_per_unit, 0) = 0) as missing_cost
    from all_ri ari
    left join public.inventory_items ii
      on ii.catalog_id = ari.catalog_id
     and ii.store_id   = p_store_id
    group by ari.recipe_id
  ),
  -- (4g) POS sales rows in [v_from, v_to] for this store. Inner-join
  -- the recipe so unmapped pos_import_items rows (recipe_id IS NULL
  -- or recipe_mapped = false) are EXCLUDED. The header comment notes
  -- that summed revenue here will not equal pos_imports totals when
  -- some menu items aren't mapped.
  sales as (
    select
      pi.import_date::date as biz_date,
      r.id                 as recipe_id,
      coalesce(nullif(trim(r.category), ''), '(uncategorized)') as category,
      r.menu_item          as item,
      pii.qty_sold::numeric                               as qty_sold,
      pii.revenue::numeric                                as revenue,
      pii.qty_sold::numeric * coalesce(rc.cost_per_unit, 0) as cogs,
      coalesce(rc.missing_cost, true)                     as missing_cost
    from public.pos_imports pi
    join public.pos_import_items pii on pii.import_id = pi.id
    join public.recipes r            on r.id = pii.recipe_id
    left join recipe_cost rc         on rc.recipe_id = r.id
    where pi.store_id = p_store_id
      and pi.import_date between v_from and v_to
      and pii.recipe_id is not null
      and pii.recipe_mapped = true
  ),
  -- (4h) Group by category or item per v_by. We compute both
  -- aggregates and pick at envelope-build time so the recursion
  -- runs once.
  grouped_category as (
    select
      category                              as group_label,
      sum(revenue)::numeric                 as revenue,
      sum(cogs)::numeric                    as cogs,
      bool_or(missing_cost)                 as missing_cost
    from sales
    group by category
  ),
  grouped_item as (
    select
      item                                  as item_label,
      coalesce(nullif(trim(s.category), ''), '(uncategorized)') as category_label,
      sum(s.revenue)::numeric               as revenue,
      sum(s.cogs)::numeric                  as cogs,
      bool_or(s.missing_cost)               as missing_cost
    from sales s
    group by item, s.category
  ),
  -- (4i) Daily series. Aggregates ALL sales (not by category/item) so
  -- it stays single-line per AC. A range with < 2 distinct days
  -- yields an empty series array (the frame's chart needs ≥ 2 pts).
  daily as (
    select
      biz_date,
      sum(revenue)::numeric as revenue,
      sum(cogs)::numeric    as cogs
    from sales
    group by biz_date
  ),
  -- (4j) Headline KPIs. Σ values for the whole window.
  totals as (
    select
      sum(revenue)::numeric as total_revenue,
      sum(cogs)::numeric    as total_cogs,
      count(distinct recipe_id) filter (where missing_cost) as missing_cost_recipes,
      count(*)                                            as row_count
    from sales
  )
  -- (4k) Compose the envelope. Empty result short-circuits to an
  -- empty arrays / null series envelope (no _status — the
  -- not_implemented sentinel is the dispatcher's, not the runner's).
  select
    case
      -- Detect chain-too-deep AFTER the CTE materializes. We can't
      -- raise inside a SELECT, so we wrap with a CASE that calls a
      -- raise-via-helper if violations exist. (Postgres has no
      -- inline `raise` expression — solution below uses an explicit
      -- IF block before this SELECT runs.)
      else jsonb_build_object(
        'kpis',    case
                     when (select row_count from totals) = 0 then '[]'::jsonb
                     else (
                       case
                         when (select missing_cost_recipes from totals) > 0 then
                           jsonb_build_array(
                             jsonb_build_object(
                               'label', 'Overall COGS %',
                               'value',
                               case when (select total_revenue from totals) > 0
                                    then to_char(
                                      (select total_cogs from totals) / (select total_revenue from totals) * 100,
                                      'FM990.0') || '%'
                                    else '0.0%' end,
                               'tone',
                               case
                                 when (select total_revenue from totals) <= 0 then 'warn'
                                 when (select total_cogs from totals) / (select total_revenue from totals) * 100 < 30 then 'ok'
                                 when (select total_cogs from totals) / (select total_revenue from totals) * 100 < 35 then 'warn'
                                 else 'danger'
                               end
                             ),
                             jsonb_build_object(
                               'label', 'Gross margin',
                               'value',
                               '$' || to_char(
                                 (select total_revenue - total_cogs from totals),
                                 'FM999,999,990.00'),
                               'tone', null
                             ),
                             jsonb_build_object(
                               'label', 'Recipes missing cost',
                               'value', (select missing_cost_recipes from totals),
                               'tone', 'warn'
                             )
                           )
                         else
                           jsonb_build_array(
                             jsonb_build_object(
                               'label', 'Overall COGS %',
                               'value',
                               case when (select total_revenue from totals) > 0
                                    then to_char(
                                      (select total_cogs from totals) / (select total_revenue from totals) * 100,
                                      'FM990.0') || '%'
                                    else '0.0%' end,
                               'tone',
                               case
                                 when (select total_revenue from totals) <= 0 then 'warn'
                                 when (select total_cogs from totals) / (select total_revenue from totals) * 100 < 30 then 'ok'
                                 when (select total_cogs from totals) / (select total_revenue from totals) * 100 < 35 then 'warn'
                                 else 'danger'
                               end
                             ),
                             jsonb_build_object(
                               'label', 'Gross margin',
                               'value',
                               '$' || to_char(
                                 (select total_revenue - total_cogs from totals),
                                 'FM999,999,990.00'),
                               'tone', null
                             )
                           )
                       end
                     )
                   end,
        'columns', case v_by
                     when 'item' then jsonb_build_array(
                       jsonb_build_object('key','item',     'label','Item',     'align','left'),
                       jsonb_build_object('key','category', 'label','Category', 'align','left'),
                       jsonb_build_object('key','revenue',  'label','Revenue',  'align','right'),
                       jsonb_build_object('key','cogs',     'label','COGS',     'align','right'),
                       jsonb_build_object('key','cogs_pct', 'label','COGS %',   'align','right'),
                       jsonb_build_object('key','margin',   'label','Margin',   'align','right')
                     )
                     else jsonb_build_array(
                       jsonb_build_object('key','category', 'label','Category', 'align','left'),
                       jsonb_build_object('key','revenue',  'label','Revenue',  'align','right'),
                       jsonb_build_object('key','cogs',     'label','COGS',     'align','right'),
                       jsonb_build_object('key','cogs_pct', 'label','COGS %',   'align','right'),
                       jsonb_build_object('key','margin',   'label','Margin',   'align','right')
                     )
                   end,
        'rows', case v_by
                   when 'item' then coalesce((
                     select jsonb_agg(
                       jsonb_build_object(
                         'item',     gi.item_label || case when gi.missing_cost then ' ⚠' else '' end,
                         'category', gi.category_label,
                         'revenue',  '$' || to_char(gi.revenue, 'FM999,999,990.00'),
                         'cogs',     '$' || to_char(gi.cogs,    'FM999,999,990.00'),
                         'cogs_pct', case when gi.revenue > 0
                                       then to_char(gi.cogs / gi.revenue * 100, 'FM990.0') || '%'
                                       else '0.0%' end,
                         'margin',   '$' || to_char(gi.revenue - gi.cogs, 'FM999,999,990.00')
                       ) order by gi.revenue desc
                     )
                     from grouped_item gi
                   ), '[]'::jsonb)
                   else coalesce((
                     select jsonb_agg(
                       jsonb_build_object(
                         'category', gc.group_label || case when gc.missing_cost then ' ⚠' else '' end,
                         'revenue',  '$' || to_char(gc.revenue, 'FM999,999,990.00'),
                         'cogs',     '$' || to_char(gc.cogs,    'FM999,999,990.00'),
                         'cogs_pct', case when gc.revenue > 0
                                       then to_char(gc.cogs / gc.revenue * 100, 'FM990.0') || '%'
                                       else '0.0%' end,
                         'margin',   '$' || to_char(gc.revenue - gc.cogs, 'FM999,999,990.00')
                       ) order by gc.revenue desc
                     )
                     from grouped_category gc
                   ), '[]'::jsonb)
                 end,
        'series', case
                    when (select count(*) from daily) < 2 then '[]'::jsonb
                    else (
                      select coalesce(jsonb_agg(
                        jsonb_build_object(
                          'label', 'COGS %',
                          'x',     to_char(d.biz_date, 'YYYY-MM-DD'),
                          'y',     case when d.revenue > 0
                                     then round(d.cogs / d.revenue * 100, 1)
                                     else 0 end
                        ) order by d.biz_date asc
                      ), '[]'::jsonb)
                      from daily d
                    )
                  end
      )
    end into v_envelope;

  -- Depth violation detection — raised AFTER the SELECT so we don't
  -- have to thread it through CASE expressions. If the recursion
  -- terminates at depth=5 with non-null sub_recipe_id, the chain is
  -- too deep.
  --
  -- ROUND-2 NOTE: this sketch raised `54001` (fatal). The shipped
  -- migration replaces this block with a NOTICE + envelope-surfacing
  -- (per Q5/option-2): truncated chains add a `Recipe graph
  -- truncated` KPI and apply a `' ⚠ (truncated)'` suffix to affected
  -- rows. See `20260511120000_report_run_cogs.sql` for the live
  -- contract.
  if exists (
    with recursive _r as (
      -- inline copy of the recursive CTE for the violation check;
      -- developer can DRY this with a temp view if desired but the
      -- duplication is cheap and keeps the function self-contained.
      select rpi.prep_recipe_id, pri.sub_recipe_id, array[rpi.prep_recipe_id] as visited, 1 as depth
        from public.recipe_prep_items rpi
        join public.prep_recipe_ingredients pri on pri.prep_recipe_id = rpi.prep_recipe_id
       where pri.sub_recipe_id is not null
      union all
      select _r.prep_recipe_id, pri.sub_recipe_id, _r.visited || _r.sub_recipe_id, _r.depth + 1
        from _r
        join public.prep_recipe_ingredients pri on pri.prep_recipe_id = _r.sub_recipe_id
       where _r.sub_recipe_id is not null
         and not (_r.sub_recipe_id = any (_r.visited))
         and _r.depth < 5
    )
    select 1 from _r where depth = 5 and sub_recipe_id is not null
  ) then
    raise notice 'COGS report: prep-recipe chain exceeds depth 5 (truncated)';
    -- NOTE: shipped function tracks per-recipe truncation and
    -- surfaces it via KPI + row suffix rather than raising 54001.
  end if;

  return v_envelope;
end;
$$;

revoke execute on function public.report_run_cogs(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_cogs(uuid, jsonb) to authenticated;
```

> **Implementation note for the developer.** The CASE-as-expression
> wrapping the envelope build is verbose because plpgsql can't `raise`
> inside a SELECT. The developer is free to refactor into separate
> SELECTs landing in distinct local variables (`v_kpis`, `v_columns`,
> `v_rows`, `v_series`) and a final `jsonb_build_object` call — that's
> easier to read. The contract above is what the function MUST emit;
> the SQL shape is non-binding.

#### Migration block 2 — dispatcher re-creation

```sql
-- ─── Dispatcher: add 'cogs' arm ───────────────────────────────
-- Postgres has no in-place CASE-edit; we re-create the dispatcher in
-- full. The 'stub' arm and the not_implemented fallback are
-- preserved exactly as in 20260510120000_report_runs.sql:222-256 so
-- callers see no surface drift. REPORTS-3 will repeat this pattern
-- for 'variance'.
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
    -- REPORTS-3 will add: when 'variance' then return public.report_run_variance(p_store_id, p_params);
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
end;
$$;

revoke execute on function public.report_run(text, uuid, jsonb) from public, anon;
grant  execute on function public.report_run(text, uuid, jsonb) to authenticated;
```

`drop function if exists` is NOT used — the signature
`(text, uuid, jsonb)` is unchanged so `create or replace` handles the
swap without breaking outstanding `grant execute` rows.

### Empty-result envelope shape (Q6 design call)

When the date range has zero matched `pos_import_items` rows (the
common case for stores that haven't run a POS import in the period,
or for super-admin viewing a fresh tenant), the runner returns:

```json
{
  "kpis":    [],
  "columns": [ /* category or item columns per v_by */ ],
  "rows":    [],
  "series":  []
}
```

Empty — but **NOT** `_status: not_implemented`. That sentinel is
reserved for the dispatcher to flag templates whose runner isn't
wired. A live runner that returned no data is a different state and
the frame already handles it: `ResultBody` falls through to its
`<EmptyPanel title="Empty result">` branch when all three of `kpis`,
`rows`, and `series` are empty (see
[ReportDetailFrame.tsx:365-371](src/screens/cmd/sections/reports/ReportDetailFrame.tsx)).

The `columns` array is still populated so the table header would
render correctly if any data appeared — but with `rows: []` the
`hasTable` check on line 354-357 short-circuits and the table panel
is skipped entirely. The empty-panel path runs.

This matches AC line 99-101 ("No KPIs are returned when there are
zero matching rows in the period").

### Frontend mapping shape — column array contract

The frontend renders `output.columns` and `output.rows` directly via
`ReportDetailFrame`'s `ResultTable`. The contract REPORTS-2 enforces:

**`by = 'category'` (default):**

| key        | label    | align  | Cell content                           |
|------------|----------|--------|----------------------------------------|
| `category` | Category | left   | `recipes.category` text, falls back to `'(uncategorized)'`, suffixed `' ⚠'` if any contributing recipe has missing cost. |
| `revenue`  | Revenue  | right  | `'$' || to_char(value, 'FM999,999,990.00')` — e.g. `'$12,481.20'` |
| `cogs`     | COGS     | right  | Same format as `revenue`. |
| `cogs_pct` | COGS %   | right  | `to_char(value, 'FM990.0') || '%'` — e.g. `'31.4%'` |
| `margin`   | Margin   | right  | Same format as `revenue`. |

**`by = 'item'`:**

| key        | label    | align  | Cell content                           |
|------------|----------|--------|----------------------------------------|
| `item`     | Item     | left   | `recipes.menu_item` text, suffixed `' ⚠'` if missing cost. |
| `category` | Category | left   | `recipes.category` text (no flag suffix here — flag rides on the `item` column instead, per Q4 resolution). |
| `revenue`  | Revenue  | right  | `'$12,481.20'` shape. |
| `cogs`     | COGS     | right  | Same. |
| `cogs_pct` | COGS %   | right  | `'31.4%'` shape. |
| `margin`   | Margin   | right  | Same as `revenue`. |

Rows are sorted server-side by `revenue desc` (per AC). The
`formatCellValue` helper at
[ReportDetailFrame.tsx:44](src/screens/cmd/sections/reports/ReportDetailFrame.tsx)
returns the string verbatim for `string` values — no re-formatting
on the client. This is intentional per AC line 127-129: server-side
formatting avoids decimal-precision loss on `number → JSON.stringify`
round-trips and keeps the table alignment tidy.

### Performance / index recommendations

The recursive CTE walks `recipe_prep_items` once per recipe, then
descends through `prep_recipe_ingredients` per sub-recipe. At the
seed dataset's scale (~100s of recipes, ~600 prep_recipe_ingredients)
the CTE materializes in <50ms.

**Indexes already in place** that the developer should NOT add again:

| Table                          | Index                                                            | Source                                                     |
|--------------------------------|------------------------------------------------------------------|------------------------------------------------------------|
| `inventory_items`              | `inventory_items_store_catalog_unique (store_id, catalog_id)`    | `20260504072830_brand_catalog_p3_lockdown.sql:42`          |
| `recipe_ingredients`           | `recipe_ingredients_logical_unique (recipe_id, catalog_id, unit)` | `20260505000000_dedupe_repointed_ingredient_lines.sql:104` |
| `prep_recipe_ingredients`      | `prep_recipe_ingredients_logical_unique (prep_recipe_id, type, catalog_id, sub_recipe_id, unit)` | `20260505000000_dedupe_repointed_ingredient_lines.sql:95` |
| `recipe_prep_items`            | `recipe_prep_items_logical_unique (recipe_id, prep_recipe_id, unit)` | `20260505000000_dedupe_repointed_ingredient_lines.sql:108` |

The `inventory_items_store_catalog_unique` constraint backs an index
on `(store_id, catalog_id)` — that's exactly the join key for the
per-store cost lookup in `recipe_cost`. **No new index is needed for
the inventory join.**

**Indexes to recommend (only if `explain analyze` flags them):**

1. `pos_imports (store_id, import_date)` — composite. Today only
   `store_id` and `import_date` exist as standalone columns; no
   composite index. The query filters on both. If the seed grows
   past ~10k pos_imports rows and the planner sequentially scans,
   add `create index if not exists pos_imports_store_date_idx on
   public.pos_imports (store_id, import_date)`. **Not adding in
   REPORTS-2 unless the developer's `explain analyze` shows >100ms
   on the seed at default 30-day range.**

2. `pos_import_items (import_id, recipe_id) where recipe_id is not null`
   — partial. Today only `import_id` is implicitly indexed (FK).
   The query filters on `import_id` AND `recipe_id is not null`.
   Same rule: only add if the planner sequentially scans.

3. `prep_recipe_ingredients (sub_recipe_id) where sub_recipe_id is not null`
   — partial single-col. The recursive step joins on `sub_recipe_id`,
   not on the leading `prep_recipe_id`. The existing 5-col unique
   index has `sub_recipe_id` at position 4, which the planner WILL
   NOT use for the join. **The developer should EXPLAIN ANALYZE this
   step specifically** — if it's a hash-join with a sequential scan
   of `prep_recipe_ingredients`, this single-col partial index will
   help. Add in REPORTS-2's same migration with `if not exists`
   guard if the dev confirms.

The AC's 500ms budget should be comfortably met without any of the
three. Quote the `explain analyze` output in the developer's PR
description if any index lands.

### Forward-compat note — REPORTS-3 (Variance)

Variance also needs the per-store `inventory_items.cost_per_unit`
join to compute the dollar impact of variance. **The Q4
resolution's missing-cost handling MUST be applied identically** in
`report_run_variance`:

- Treat missing/zero `cost_per_unit` as 0 contribution.
- Set the row's missing-cost flag (`bool_or` semantics).
- Suffix `' ⚠'` on the row label of the affected item.
- Surface a `Recipes missing cost` (or equivalent) KPI when count > 0.

The `recipe_cost` CTE shape can be lifted from `report_run_cogs` and
re-used by REPORTS-3's RPC. Future refactor: extract the recursive
flatten into a helper view `public.v_recipe_cost_flat(store_id)` so
COGS, Variance, Recipe-Profitability, and Reorder-Forecast (Appendix
A of REPORTS-1) all share one source of truth. **Do not extract in
REPORTS-2** — premature; let REPORTS-3 prove the shape is right.

### `src/lib/db.ts` surface

**No changes.** `db.runReport` already accepts `params` and forwards
to the dispatcher RPC; the dispatcher's new `'cogs'` arm is fully
backend. The new RPC is invoked by template id only.

The two-arg `runReport(definitionId, overrideParams?)` per AC line
233-237 is a STORE change in `src/store/useStore.ts`, not a
`db.ts` change — `db.runReport` already accepts a `params` object.
Mirror what's there, don't duplicate.

### `src/store/useStore.ts` slice change

`runReport` signature gains an optional second arg per AC:

```ts
runReport: (definitionId: string, overrideParams?: Partial<ReportDefinition['params']>) => void;
```

When `overrideParams` is set:
1. Merge `{ ...def.params, ...overrideParams }` into the optimistic
   row's `params`.
2. Pass the merged object to `db.runReport({ params })`.
3. Do NOT mutate the saved `ReportDefinition.params` — the override
   is for this run only.

The optimistic-then-revert pattern from REPORTS-1 (snapshot `prev`,
restore on catch, route through `notifyBackendError`) is unchanged.
No new actions; `loadLatestRun` is unchanged.

### Realtime impact

**None.** `report_runs` is intentionally NOT in the
`supabase_realtime` publication (per REPORTS-1's "Out of scope"
section). REPORTS-2 doesn't change publication membership. **No
`docker restart supabase_realtime_imr-inventory` step required** —
this is the safe outcome of intentionally skipping the publication
add. Standard `supabase db reset` is sufficient for local testing.

### RLS impact

**None of the existing RLS surfaces change.** The new
`report_run_cogs` function is `security invoker` — it inherits the
caller's RLS context for every read. The reads it performs:

- `recipe_ingredients`, `prep_recipe_ingredients`,
  `recipe_prep_items`, `recipes` — all gated by their existing
  brand-member-read policies from
  `20260509000000_multi_brand_schema_rls.sql`. The function's caller
  is `authenticated` and either an admin (sees all brands) or a
  brand-scoped user (sees their brand). Cross-brand stores aren't
  in scope so the per-store `auth_can_see_store(p_store_id)` gate
  the function applies first is sufficient.
- `inventory_items` — gated by
  `store_member_read_inventory_items` from
  `20260504173035_per_store_rls_hardening.sql`. The function reads
  with the per-store filter `where store_id = p_store_id` AND the
  caller's `auth_can_see_store(p_store_id)` was just verified, so
  RLS lets the rows through.
- `pos_imports`, `pos_import_items` — gated by the per-store
  policies from `20260504173035_per_store_rls_hardening.sql:253-318`.
  Same reasoning.

The function does NOT need its own per-table RLS; it relies on the
existing policies plus the upfront `auth_can_see_store` check.
`grant execute to authenticated` + `revoke from public, anon`
matches the per-template RPC convention.

### Risks and trade-offs

1. **Recursive CTE performance on a large brand.** A brand with 500
   recipes and 8-level prep nesting (theoretical, unlikely on the
   seed) could cause the recursion to walk many rows. The depth-5
   cap is a hard ceiling. The 500ms budget is comfortable on the
   seed; if a future tenant import hits the cap, surface as an
   issue and split the function into a materialized helper view.

2. **`to_char` formatting locale.** `'FM999,999,990.00'` and
   `'FM990.0'` use the database's `lc_numeric` setting for the
   thousands/decimal separator. Postgres defaults to `'C'` locale
   which gives `'12,481.20'` — the AC's expected format. If a
   migration later sets `lc_numeric` to a European locale,
   formatting would drift to `'12.481,20'`. Acceptable —
   Supabase-managed Postgres uses the default, and the seed
   reproduces it.

3. **`(now() at time zone 'utc')::date` for "today".** Defaults are
   in UTC. A store in Eastern time pressing RUN at 11:00 PM local
   gets "tomorrow" UTC. Acceptable for REPORTS-2 — the AC says
   `now() at time zone 'utc'` explicitly and the chip-override
   workflow lets the user pick exact dates. A per-store timezone
   defaults pass is a follow-up if it matters.

4. **`pos_import_items.recipe_mapped = true` filter.** The AC says
   exclude rows where `recipe_id IS NULL OR recipe_mapped = false`.
   The SQL filters on both. If a future workflow inserts rows with
   `recipe_id` set but `recipe_mapped = false` (the manual mapping
   cleanup spec hasn't fully wired both), those rows are excluded.
   Documented in the migration header.

5. **POS smearing (Q6).** A POS CSV that spans multiple business
   days lands on a single `import_date` bucket. The daily series'
   `y` for that date is the average across the rolled-up days. The
   user accepted this as a documented caveat.

6. **Empty-result envelope and the frame's chart.** When `series`
   is `[]` (range has < 2 distinct days) the frame's `hasSeries`
   check at line 358 fails (`length >= 2`) and the chart panel is
   skipped. No regression.

7. **Hardcoded thresholds (Q8).** Brands whose actual target is 28%
   or 40% see misleading tones. Documented in the migration header.

8. **No CHECK constraint on `report_runs.params` shape.** A future
   spec could pass a malformed `params` and the runner would
   silently coerce to defaults. Acceptable — the runner is the
   authority on its own param contract; the dispatcher and
   `report_runs` table are param-agnostic.

9. **Migration ordering.** Depends on:
   - `auth_can_see_store(uuid)` from
     `20260504173035_per_store_rls_hardening.sql` — exists.
   - `report_run` (dispatcher) from
     `20260510120000_report_runs.sql` — exists.
   - `recipe_ingredients`, `prep_recipe_ingredients`,
     `recipe_prep_items`, `recipes`, `pos_imports`,
     `pos_import_items`, `inventory_items` — all exist post-P3
     lockdown.

   Proposed timestamp `20260511120000` is after all dependencies
   and after the REPORTS-1 follow-up
   `20260510130000_report_runs_consistency.sql`. Manual verification
   per CLAUDE.md (no CI gate currently).

10. **Edge function cold-start** — N/A. No edge functions touched.

### Files the developer will touch

#### Migrations
- **New:** `supabase/migrations/20260511120000_report_run_cogs.sql`
  — creates `report_run_cogs` plus `create or replace function
  public.report_run` with the `'cogs'` arm. Header comment documents:
  POS smearing, missing-cost partial-credit-and-flag (Q4 ratified),
  hardcoded 30/35 KPI tone thresholds (Q8 ratified), depth-5
  prep-recipe cap with cycle detection.

#### TypeScript types
- `src/types/index.ts` — no runtime change.
  `ReportDefinition['params']` stays `Record<string, unknown>` for
  forward-compat. The architect recommends adding a JSDoc comment
  enumerating the COGS template's expected param keys (`range`,
  `from`, `to`, `by`) but no TypeScript change.

#### Data layer
- `src/lib/db.ts` — no signature change. `runReport` already
  forwards `params`.

#### Store
- `src/store/useStore.ts` — `runReport(definitionId)` becomes
  `runReport(definitionId, overrideParams?)`. Optimistic row uses
  `{ ...def.params, ...overrideParams }` for both `params` and the
  forwarded `db.runReport({ params })` call.

#### Frontend
- `src/screens/cmd/sections/reports/templates.ts` — flip the `cogs`
  template's `status` from `'preview'` to `'live'`. One-line diff.
- `src/components/cmd/NewReportModal.tsx` — add the date-range field
  (presets + manual edit + validation per AC) and the `by:` toggle.
  Writes `params: { range, from, to, by }` on create.
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` — convert
  the range chip from read-only `Text` to a `TouchableOpacity` that
  opens a small dropdown; add `onRangeChange` and `onByChange` props;
  render a subtle `·` indicator when in-frame range/by differs from
  the saved definition's value.
- `src/screens/cmd/sections/ReportsSection.tsx` — track
  `overrideRange` and `overrideBy` in detail-view local state; pass
  the new callbacks to `ReportDetailFrame`; pass merged params to
  `runReport`.

### Verification (recorded for reviewers)

- `npx supabase db reset` applies the new migration cleanly.
- `select report_run('cogs', '<store-uuid>', '{}'::jsonb)` returns
  the uniform envelope (not the `not_implemented` sentinel).
- `select report_run('cogs', '<store-uuid>', '{"by":"item"}'::jsonb)`
  returns `columns` with `key='item'` first.
- `select report_run('cogs', '<store-uuid>', '{"from":"2026-05-10","to":"2026-04-10"}')`
  raises `22023` with the structured message.
- `select report_run_cogs('<other-store>', '{}')` from a non-admin
  session scoped to a different store raises `42501`.
- `explain analyze` of the inner SELECT chain on the seed at default
  range — record total exec time in the developer's PR description;
  sub-500ms confirms AC line 150-153.
- Frontend verification per AC: catalog tile drops PREVIEW badge;
  modal date-range chips behave per AC; chip-override updates
  in-frame state but not the saved definition; RUN uses merged
  params; KPI tones match 30/35; row formatting matches `$X,XXX.XX`
  pattern; series renders ≥ 2 points or hides the panel.
- TypeScript: `npx tsc --noEmit` shows no new errors in
  `useStore.ts`, `templates.ts`, `NewReportModal.tsx`,
  `ReportDetailFrame.tsx`, or `ReportsSection.tsx`.
- Browser-preview verification (per CLAUDE.md feedback note): the
  developer should exercise create / open / chip-change / run flow
  in the local stack with `npm run dev:db` + `admin@local.test`.

## Handoff

next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Backend-developer
  owns the new migration `20260511120000_report_run_cogs.sql`
  (`report_run_cogs` RPC + dispatcher re-creation with the `'cogs'`
  arm). Frontend-developer owns the `cogs` template `status: 'live'`
  flip, the modal date-range field + `by:` toggle, the
  `ReportDetailFrame` chip dropdown + `·` override indicator, and
  the `ReportsSection` override-state plumbing. Both should also
  touch `src/store/useStore.ts` to extend `runReport` with the
  optional `overrideParams` arg per the design's "Store slice
  change" section — coordinate so the two slices don't conflict.
  After implementation, set `Status: READY_FOR_REVIEW` and list
  files changed under `## Files changed`.
payload_paths:
  - specs/017-reports-cogs-template/spec.md

## Files changed

### Backend
- `supabase/migrations/20260511120000_report_run_cogs.sql` (new) — creates
  `public.report_run_cogs(uuid, jsonb)` and re-creates the dispatcher
  `public.report_run(text, uuid, jsonb)` with the `when 'cogs'` arm.
  Header comment documents the POS smearing caveat, the
  partial-credit-and-flag missing-cost policy (Q4), the hardcoded 30/35
  KPI tone thresholds (Q8), and the depth-5 prep-recipe cap. Depth-cap
  enforcement diverged from the architect's design in one place — the
  architect's design SQL raised `54001` on chain > 5; per backend-dev
  instruction at implementation time the cap raises a NOTICE instead
  and the function returns the truncated partial result. Rationale:
  consistent with the Q4 "partial credit" theme and prevents a single
  deep-chained recipe from blocking the whole brand's COGS view.

### Store / data layer
- `src/store/useStore.ts` — `runReport(definitionId, overrideParams?)`
  per AC. Optimistic row uses merged `{ ...def.params, ...overrideParams }`
  for `params`; `db.runReport` is called with both `params` and
  `overrideParams` so the persisted `report_runs.params` reflects the
  active override. Saved `ReportDefinition.params` is unchanged.
- `src/lib/db.ts` — `runReport` arg shape gains optional
  `overrideParams` that is merged onto `params` before forwarding to the
  dispatcher AND persisted to `report_runs.params`. No new helpers.
- `src/types/index.ts` — `ReportDefinition['params']` documented with the
  COGS template's expected keys (`range`, `from`, `to`, `by`) via JSDoc;
  runtime type stays `Record<string, unknown>` for forward-compat.

### Frontend (Cmd UI)
- `src/screens/cmd/sections/reports/templates.ts` — `cogs` template
  flipped from `status: 'preview'` to `'live'`. One-line change.
- `src/components/cmd/NewReportModal.tsx` — adds the date-range field
  (presets `Last 30d` (default) / `This month` / `Last full month` /
  `Last 90d` plus manual edit with `YYYY-MM-DD` validation) and the
  `by:` toggle (category | item). On CREATE, `params` is now
  `{ range, from, to, by }`. Field is always visible per AC line 173-174.
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` — converts
  the read-only `range:` and adds a `by:` chip; both become interactive
  dropdowns when the parent passes `onRangeChange` / `onByChange` /
  `onResetOverrides` (gated on `template.status === 'live'`). Renders a
  subtle `·` indicator when the in-frame value differs from the saved
  definition. Adds a `reset` affordance next to the chips when any
  override is active. Preview templates keep the read-only chip strip
  unchanged.
- `src/screens/cmd/sections/ReportsSection.tsx` — adds per-definition
  override state (`Map<definitionId, { range?, by? }>`) and passes it
  through to the frame. On RUN, builds a merged override object and
  passes it as the second arg to `useStore.runReport`. Switching
  between saved reports preserves each report's override; `reset`
  clears the entry for the active definition.

### Reviews (REPORTS-1 follow-ups, not authored here)
- `specs/016-reports-runner-foundation/reviews/*` — previously landed.

### Verification done
- `npx tsc --noEmit` — no new errors in `useStore.ts`, `db.ts`,
  `templates.ts`, `NewReportModal.tsx`, `ReportDetailFrame.tsx`, or
  `ReportsSection.tsx`. Pre-existing errors in unrelated files
  (`AdminScreens.tsx`, `PrepRecipesScreen.tsx`, etc.) are unchanged.
- `EXPO_PUBLIC_NEW_UI=1 npm run web` — dev server boots, Metro bundles
  `/node_modules/expo/AppEntry.bundle?...` to a clean HTTP 200 (311k+
  lines, no `UnableToResolveError` / `SyntaxError`).
- **Browser interactive verification not performed** — the
  frontend-developer subagent does not have `preview_*` MCP tools or
  Chrome MCP available in this run. The compile-clean dev bundle is
  the strongest signal available here; full click-through verification
  is deferred to the user / reviewer / next pass.

### Round-2 fixes (FIXES_NEEDED → READY_FOR_REVIEW)

Addresses P0 and P1 items in
`specs/017-reports-cogs-template/reviews/release-proposal.md`.

#### Backend
- `supabase/migrations/20260511120000_report_run_cogs.sql` — depth-cap
  contract revised per architect's option 2:
  - The pre-walk `_walk` CTE now tracks the top-level `recipe_id` so
    we can count `count(distinct recipe_id)` of truncated chains into
    `v_truncated_recipe_count`.
  - The row-aggregation CTEs (both `by='item'` and `by='category'`)
    materialize a `truncated_recipes` CTE off the same `recursive_prep`
    walk, join it onto `sales`, and propagate a `truncated` bool flag
    through grouping via `bool_or`.
  - The row's `category`/`item` cell now suffixes with
    `' ⚠ (truncated)'` when the recipe's chain was truncated;
    truncated takes precedence over the `' ⚠'` missing-cost suffix.
  - KPI assembly is rewritten compositionally: the first two KPIs
    (`Overall COGS %`, `Gross margin`) always emit; the optional 3rd
    (`Recipes missing cost`, tone=warn) and 4th (`Recipe graph
    truncated`, tone=warn) append in order when their counts > 0.
  - The series CTE chain in section (10) is consolidated into a
    single statement with a conditional aggregation gate; the
    recursive prep walk runs once instead of twice.
  - The `daily` CTE has an inline comment explaining why the
    `recipes` join is intentionally absent (cascade-delete FK
    guarantees `pii.recipe_id is not null` rows have a matching
    recipe; the series doesn't need category/menu_item).
  - Header comment rewritten to reflect the truncated-recipe
    surfacing contract.

#### Frontend (Cmd UI)
- `src/screens/cmd/sections/ReportsSection.tsx` — closes AC-RS-4
  (override Map memory leak on delete):
  - Inline `⌫ delete` button paired with an immediate
    `setOverrides` cleanup before calling `deleteReportDefinition`.
  - Belt-and-suspenders `useEffect([myReports])` that reconciles
    the overrides Map against the current list of saved reports —
    catches realtime deletes from another tab.
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` —
  imports `react-native-toast-message`. `commitDate` now emits
  `Toast.show({ type: 'error', text1: 'Invalid date — must be
  YYYY-MM-DD' })` on invalid manual input, matching the modal's
  `commitDateEdit` pattern (`NewReportModal.tsx:162`).
- `src/screens/cmd/sections/reports/templates.ts` — stale
  forward-looking comment updated to past tense ("REPORTS-2
  flipped `cogs` to 'live'").

#### Spec text
- `specs/017-reports-cogs-template/spec.md` — Q5 prep-depth
  acceptance criterion now reads: "raises a NOTICE, returns the
  truncated partial result, adds a `Recipe graph truncated` KPI
  (tone=warn) when count > 0, and suffixes `' ⚠ (truncated)'` on
  affected rows." Architect's design SQL block now has a
  ROUND-2 NOTE pointing at the live contract.
- `specs/017-reports-cogs-template/spec.md` — `overrideRange`
  ReportsSection AC line updated to match the shipped
  per-definition `Map<definitionId, ...>` persistence behaviour
  ("opening a saved report preserves any prior chip overrides
  for that report — overrides are scoped per definition").

### Round-2 verification done
- Migration re-applied locally via
  `docker exec ... psql -U postgres -d postgres < migration.sql`
  — clean apply, 6 statements succeed.
- Smoke test for truncation surfacing (transaction with a
  6-level prep chain on `report_run_cogs`):
  - NOTICE fires: "COGS report: prep-recipe chain exceeds
    depth 5 (1 recipe(s) truncated; partial cost may be
    undercounted)".
  - KPIs contain 4 items including
    `{ label: 'Recipe graph truncated', value: 1, tone: 'warn' }`.
  - Row's `category` cell renders as
    `"CatDeep ⚠ (truncated)"`; row's `item` cell (for
    `by='item'`) renders as `"DeepRecipe ⚠ (truncated)"`.
  - Function returns successfully — no fatal raise.
- Smoke test without deep chain (simple recipe + 2-day window):
  - No NOTICE.
  - KPIs contain only `Overall COGS %` + `Gross margin`.
  - No suffix on rows.
  - 2-point series renders correctly.
- Series-consolidation regression: 1-day window returns
  `series: []`; 2-day window returns 2 points; 0-day window
  returns `series: []`.
- `from > to` still raises `22023` with the structured message.
- TypeScript: `npx tsc --noEmit` shows no new errors in the
  touched files.

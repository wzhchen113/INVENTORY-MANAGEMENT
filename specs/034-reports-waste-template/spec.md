# Spec 034: Reports — Waste template

Status: READY_FOR_REVIEW

## User story

As a store manager, I want to run a "Waste cost" report over a date range so I
can see how much money we threw out, sliced by reason (spoilage / drop / over-
prep / quality / theft / other), category, or item, so I can identify which
loss drivers actually cost us the most and where to focus reduction effort.

## Acceptance criteria

### Backend — `public.report_run_waste(uuid, jsonb) returns jsonb`

- [ ] A new migration `supabase/migrations/<timestamp>_report_run_waste.sql`
  creates the function with signature
  `(p_store_id uuid, p_params jsonb) returns jsonb`,
  `language plpgsql`, `security invoker`,
  `set search_path = public`.
- [ ] First statement raises SQLSTATE `42501` if
  `public.auth_can_see_store(p_store_id)` returns false, mirroring
  `report_run_variance` line 142-146.
- [ ] Same migration re-creates the dispatcher
  `public.report_run(text, uuid, jsonb)` with a new `when 'waste' then return
  public.report_run_waste(p_store_id, p_params)` arm, preserving the existing
  `'stub'`, `'cogs'`, `'variance'` arms and the `not_implemented` fallback
  exactly as in `20260512120000_report_run_variance.sql:628-661`. No surface
  drift to callers.
- [ ] Grants: `revoke execute on function public.report_run_waste(uuid, jsonb)
  from public, anon; grant execute on function public.report_run_waste(uuid,
  jsonb) to authenticated;` — matches the spec 016 convention and the
  `reports_anon_revoke.test.sql` lockdown.
- [ ] Parameters accepted in `p_params`:
  - `from` (string, `YYYY-MM-DD`) — defaults to `current_date - interval '30
    days'` when null/empty, matching COGS line 111-114.
  - `to` (string, `YYYY-MM-DD`) — defaults to `current_date` when null/empty,
    matching COGS line 115-118.
  - `by` (text) — one of `'reason'`, `'category'`, `'item'`. Defaults to
    `'reason'` when null/empty. Unknown values silently coerce to the default
    (forward-compat per the COGS pattern at line 119-123).
  - Unknown keys ignored. Malformed dates surface as native 22007/22008 →
    sanitized to "Run failed — check server logs" via the frontend's
    existing `runReport` toast path.
- [ ] Range validation: `from > to` raises SQLSTATE `22023` with message
  `'Waste report: from > to (% > %)'`. `from = to` is ALLOWED (single-day
  reports are meaningful for waste, unlike variance).
- [ ] Date window: `waste_log.logged_at::date >= v_from AND
  waste_log.logged_at::date <= v_to` (INCLUSIVE on both sides — single-day
  range needs both endpoints to include that day's rows). NOTE the divergence
  from variance's half-open `(v_from, v_to]` window — see Open question Q4
  resolution and the migration's design-notes comment block.
- [ ] Dollar source: `coalesce(waste_log.cost_per_unit, 0) * waste_log.quantity`
  uses the SNAPSHOT cost stored on each row at log time by `staff_log_waste`
  RPC (see `20260504000002_staff_log_waste_rpc.sql:42-65`). NO fallback to
  `inventory_items.cost_per_unit` — the snapshot is the historically-correct
  number; rows logged before any cost was set just contribute $0.
- [ ] Empty-result short-circuit: when no `waste_log` rows match the filter,
  return populated `columns` + empty `kpis`/`rows`/`series` (`[]` not null
  for the array shapes; the series stays `[]` not `null` per the COGS
  pattern at `report_run_cogs.sql:324-330`).
- [ ] Item-name resolution: `catalog_ingredients.name` via the
  `waste_log.item_id → inventory_items.id → inventory_items.catalog_id →
  catalog_ingredients.id` chain (mirrors variance line 481). Rows whose
  `inventory_items` row was deleted (orphan `waste_log.item_id`) get the
  name `'(deleted item)'` — left-join keeps the row, the dollar still
  contributes to the headline.
- [ ] Category resolution: `catalog_ingredients.category` (free-form text,
  same surface COGS reads). NULL/empty/whitespace coerce to
  `'(uncategorized)'` via `coalesce(nullif(trim(category), ''),
  '(uncategorized)')`.
- [ ] Reason resolution: `coalesce(nullif(trim(waste_log.reason), ''),
  '(no reason)')` — there is no FK / enum constraint on `reason`; the column
  is free-form text per the init schema. The migration MUST NOT add an enum
  in this spec.
- [ ] Envelope shape returned (matches the spec 016 uniform envelope):
  ```json
  {
    "kpis":    [
      { "label": "Total waste $",        "value": "$1,234.56", "tone": "danger" | "warn" | "ok" },
      { "label": "Total qty wasted",     "value": "123.456",   "tone": null },
      { "label": "Top driver",           "value": "Spoilage · $456.78", "tone": "warn" },
      { "label": "Logs in period",       "value": 42,          "tone": null }
    ],
    "columns": [ /* depends on `by:` — see column shapes below */ ],
    "rows":    [ /* one row per group key, dollar-desc sorted */ ],
    "series":  [ { "label": "<reason>", "x": "YYYY-MM-DD", "y": <number> }, ... ]
  }
  ```
- [ ] Columns by `by:` value:
  - `by='reason'`: `[reason, qty, items_affected, dollar_impact]` —
    `qty` is `sum(quantity)`, `items_affected` is
    `count(distinct item_id)`.
  - `by='category'`: `[category, qty, items_affected, dollar_impact]` —
    same shape; `items_affected` is `count(distinct item_id)` within the
    category.
  - `by='item'`: `[item, category, qty, unit, dollar_impact]` — no
    `items_affected` (the row IS the item). `unit` is
    `coalesce(catalog_ingredients.unit, '')` per the reorder-list pattern.
- [ ] Row formatting (server-side):
  - Dollar cells: `'$' || to_char(value, 'FM999,999,990.00')` for positive,
    `'-$' || to_char(abs(value), 'FM999,999,990.00')` for negative (waste
    dollar should always be positive — guard for forward-compat).
  - Qty cells: `to_char(value, 'FM999,990.000')` (three-decimal precision
    matches variance row format).
  - Rows sorted by `dollar_impact desc, group_key asc` (tiebreaker keeps
    output deterministic).
- [ ] KPI tone bands for `Total waste $`:
  - `< $50`: tone `ok`
  - `$50 – $200`: tone `warn`
  - `> $200`: tone `danger`
  Hardcoded same as COGS. Per-brand thresholds are out of scope. Document
  the bands in the migration header so reviewers don't relitigate.
- [ ] KPI `Top driver` ALWAYS uses the `reason` grouping regardless of the
  requested `by:` value — it's the cross-cutting "what's hurting us most"
  signal. Computed as `reason || ' · $' || to_char(top_reason_dollar)`. When
  no waste rows exist, the KPI is omitted (not emitted as a zero).
- [ ] `series` shape: ONE series per `reason` value, multi-line. Each point
  is `{ "label": <reason>, "x": <date>, "y": <dollar_impact_that_day> }`.
  Computed regardless of the `by:` toggle (so the chart always tells the
  reason-over-time story while the table can be sliced any way). Empty
  array (`'[]'::jsonb`) when fewer than 2 distinct dates have matched rows
  — same gate as COGS line 661-672. Series NEVER returns `null` — per the
  spec 016 contract, `null` is reserved for templates that genuinely don't
  chart.
- [ ] No recursive prep-recipe CTE needed (waste rows are already at the
  granular level — they reference `inventory_items.id` directly). Migration
  header explicitly notes the absence so future contributors don't add one
  out of pattern-mimicry.

### Frontend — `src/screens/cmd/sections/reports/templates.ts`

- [ ] Flip the `waste` template's `status: 'preview'` to `status: 'live'`.
- [ ] No other field changes on the row (name, sub, cols, icon stay).

### Frontend — `src/components/cmd/NewReportModal.tsx`

- [ ] `waste` template uses the SAME date-range + by-toggle UI that COGS
  uses (the existing non-variance branch lines 422-526). No template-
  specific UI needed.
- [ ] BUT the by-toggle for waste shows three options: `'reason'`,
  `'category'`, `'item'`. Today the toggle hardcodes `['category',
  'item']` (line 506). The fix:
  - Add a per-template `by` option list. For `waste` show all three; for
    `cogs` keep the existing two (no regression).
  - Default selected option for `waste` is `'reason'` (the catalog-tile
    text already advertises "by reason & category").
- [ ] Save-time params for `waste`:
  `{ range, from, to, by }` — same shape as COGS. `range` is informational
  (drives the chip label); `from`/`to` are authoritative.

### Frontend — `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`

- [ ] No template-specific code expected. The generic frame already reads
  `kpis / columns / rows / series` and renders. Manual-test (verification
  gate below) confirms the multi-series chart renders correctly for the
  waste series shape.
- [ ] By-chip override (the in-frame chip-strip): the `selectedSupportsBy`
  gate today is `selectedIsLive && selectedTemplate?.id !== 'variance'`
  (`ReportsSection.tsx:235`). With `waste` now `'live'`, the chip strip
  fires for it. The override needs to support the third option `'reason'`
  — same change as the modal.

### Frontend — `src/screens/cmd/sections/ReportsSection.tsx`

- [ ] Update the `setOverrideBy` signature / `OverrideState.by` type from
  `'category' | 'item'` to `'reason' | 'category' | 'item'` so the waste
  override flows through `runReport`. COGS continues to ignore `'reason'`
  if a user somehow saved that on a COGS definition (forward-compat: the
  RPC coerces unknown values to default).
- [ ] No removal of the PREVIEW badge needs explicit code change here —
  the badge already lives inside the catalog tile and is gated on
  `r.status === 'preview'` (`ReportsSection.tsx:368`). The templates.ts
  flip drops the badge automatically.

### Tests

- [ ] New pgTAP test `supabase/tests/report_run_waste.test.sql` adds at
  least the following cases. Patterns follow
  `report_run_variance_formula.test.sql`:
  1. **Fixture resolves** — Frederick store id resolves from seed; pick a
     Frederick inventory item with `cost_per_unit > 0`.
  2. **Auth gate** — manager calling waste on Charles (non-member store)
     raises SQLSTATE `42501`. Mirrors `report_run_cogs.test.sql` test (1).
  3. **Empty range** — call with `from = to = 2000-01-01` (no waste rows
     in seed), returns populated `columns` + empty `kpis`/`rows`/`series`
     arrays.
  4. **Single-item happy path** — insert one `waste_log` row (`quantity =
     2.5`, `cost_per_unit = 4.00`, `reason = 'Spoilage'`, `logged_at =
     2026-05-02`). Call with `from=to=2026-05-02`, `by='reason'`. Assert:
     - `kpis[label='Total waste $'].value = '$10.00'`
     - row count = 1, `rows[0].reason = 'Spoilage'`,
       `rows[0].qty = '2.500'`, `rows[0].dollar_impact = '$10.00'`
  5. **Missing-cost zero-out** — insert one `waste_log` row with
     `cost_per_unit = NULL`. Assert that row's `dollar_impact = '$0.00'`
     and is excluded from `Total waste $` headline. NOT flagged with a
     `⚠` suffix in v1 (out-of-scope — Open question Q5 resolution).
  6. **Multi-item ordering** — insert two rows with different dollar
     impacts, assert `rows` is ordered dollar-desc.
  7. **Envelope shape** — sorted-key list assertion matches `array
     ['columns', 'kpis', 'rows', 'series']::text[]`, same shape as
     `report_run_variance_formula.test.sql` test (6).
  8. **`by='category'` and `by='item'` smoke** — call once with each
     value, assert the column header keys differ correctly (`category`
     vs `item` present in `columns[0].key`).
- [ ] `supabase/tests/reports_anon_revoke.test.sql` adds an arm for
  `report_run_waste(uuid, jsonb)` — anon → 42501 at GRANT time. Brings
  the assertion plan from `plan(8)` to `plan(9)`.
- [ ] No new shell smoke arm. The existing `scripts/smoke-rpc.sh` smokes
  `report_run('stub', ...)` for the dispatcher contract; waste is reachable
  through the same RPC, no per-template smoke needed.
- [ ] No new jest test required (no new TS helpers extracted by this spec).

### Verification gates

- [ ] `npx tsc --noEmit` exit 0.
- [ ] `npm run typecheck:test` exit 0.
- [ ] `npm test -- --ci` PASS.
- [ ] `npm run test:db` PASS — pgTAP count goes from 15 → 16 files; the
  `reports_anon_revoke.test.sql` plan moves from 8 → 9.
- [ ] `npm run test:smoke` PASS (no new arms; only confirms existing
  smokes still green).
- [ ] Manual browser smoke after `npm run dev` against local stack:
  - Reports section, catalog tile `waste` — PREVIEW badge gone, click
    opens `NewReportModal` pre-filled with template = `waste`, name =
    `"Waste cost — May 2026"`.
  - Save the report — appears in "your reports" grid.
  - Click the saved report — detail frame opens.
  - Click RUN — `kpis` show Total waste $ + Total qty + Top driver + Logs
    count; `rows` populate with reason groups; multi-line chart renders.
  - Click `by:` chip strip — toggling between reason / category / item
    re-runs with the override; rows + columns change shape correctly.
  - Toggle the date range — re-runs against the new window.

## In scope

- New RPC `public.report_run_waste(uuid, jsonb) returns jsonb`.
- Dispatcher re-create with the `when 'waste'` arm added.
- `templates.ts` flip of `waste.status: 'preview' → 'live'`.
- `NewReportModal` + `ReportsSection` `OverrideState` extension to admit
  the `'reason'` option for the by-toggle (and only for waste).
- pgTAP test `report_run_waste.test.sql` covering auth gate + envelope
  shape + per-row formula + missing-cost zero-out + ordering + by-toggle
  smoke.
- `reports_anon_revoke.test.sql` arm added for the new RPC.
- Migration header documents the design choices the way variance / COGS
  / reorder migration headers do (date-window divergence from variance,
  cost-snapshot rationale, no recursive CTE rationale).

## Out of scope (explicitly)

- Vendor / velocity / custom templates. Each is its own spec; the
  reports-templates-backlog stubs them out.
- New surfaces for creating, editing, or deleting waste log entries.
  Logging waste is the staff app's job (already wired via
  `staff_log_waste` RPC). The admin app reads waste history; it does
  not write it.
- Per-brand or per-store tone thresholds for `Total waste $`. Hardcoded
  bands per the COGS precedent.
- Snapshot-vs-current cost toggle. Locked to the snapshot value at log
  time (see Open question Q2 resolution). Adding a "use current cost"
  param later is a follow-up if needed.
- The "should we exclude `reason='expired_in_storage'` from the headline"
  filter raised in the backlog stub. The seed has no `'expired_in_storage'`
  rows and the reason column is free-form text — there's no canonical
  string to filter. Surface to the user as a future enhancement if waste
  reports become a primary tool.
- A `⚠` suffix on rows with missing cost. Variance and COGS flag rows
  whose recipe-graph touches a null/zero cost because the entire row's
  numeric is suspect. For waste, a single row with null cost just doesn't
  contribute to the dollar number — the qty number is still good. No
  per-row diagnostic suffix; the diagnostic is the headline
  arithmetic-vs-row-count mismatch the user can eyeball.
- A `Recipe graph truncated` or `Items missing cost` KPI. Same rationale —
  no recipe graph, no per-row missing-cost flag.
- Realtime push for waste log changes into the open detail frame. The
  detail frame is run-on-demand; the existing `useRealtimeSync.ts`
  already listens on `waste_log` for the section-level reload (line 35),
  but a re-run of an open Waste report is the user's action, not a push.
- Slug or `app.json` changes. (Not relevant — see project-specific notes.)
- Edge function. RPC-only; no `supabase/functions/` work.

## Open questions resolved

- **Q1: Does `waste_log` exist? If yes, what's the schema?** →
  YES. Schema captured from
  [supabase/migrations/20260405000759_init_schema.sql:138-149](../../supabase/migrations/20260405000759_init_schema.sql):
  ```
  waste_log (
    id              uuid pk,
    store_id        uuid → stores(id),
    item_id         uuid → inventory_items(id),
    quantity        numeric(10,3),
    unit            text,
    cost_per_unit   numeric(10,2),   -- denormalized snapshot at log time
    reason          text,            -- free-form, no enum
    logged_by       uuid → profiles(id),
    notes           text,
    logged_at       timestamptz default now()
  )
  ```
  Plus `client_uuid` (idempotency key) added later by the staff-app RPC.
  Per-store scoped; RLS via `auth_can_see_store(store_id)` per
  `20260504173035_per_store_rls_hardening.sql:134-152`. Seed has ~0
  waste rows by default (the test fixture inserts its own) — the empty-
  range test case is the dominant first-run experience.

- **Q2: Where does cost-per-unit come from?** →
  SNAPSHOT from `waste_log.cost_per_unit`. The
  `staff_log_waste` RPC (`20260504000002_staff_log_waste_rpc.sql:42-65`)
  reads `inventory_items.cost_per_unit` at log time and captures it on
  the row. This is the historically-correct number — what the
  ingredient was worth WHEN it was thrown out, not what it's worth now.
  Variance is the outlier (it joins `inventory_items.cost_per_unit`
  because variance is a snapshot of THE CURRENT WORLD compared to past
  counts); waste is a historical ledger and uses the historical cost.
  Rows where `cost_per_unit IS NULL` contribute `$0` to the dollar
  number but their `quantity` still surfaces (so a row with no cost
  doesn't disappear, it just doesn't move the headline).

- **Q3: Default `group_by`?** →
  `'reason'`. The catalog-tile copy already advertises
  "by reason & category" and the backlog stub identifies reason as
  the highest-signal axis for waste reports. Toggle offers all three:
  `reason | category | item`. Surfacing as a resolved decision rather
  than an Asked Question because the trade-off is bounded and the
  catalog tile already commits us.

- **Q4: Date window — half-open like variance, or closed like COGS?** →
  CLOSED `[from, to]` on `logged_at::date`. Rationale: waste is an
  event-log report, not a between-anchors balance reconciliation. A
  manager asking "waste on 2026-05-02" expects to see that day's logs
  — half-open would require `from=2026-05-01, to=2026-05-02` which
  doesn't match the modal's "pick a date range" mental model. COGS is
  the precedent here (line 297 `between v_from and v_to`); variance's
  half-open shape exists because anchors are submission points, not
  date ranges. Migration header MUST call out the divergence so
  reviewers comparing the three runners side-by-side don't flag it as
  drift.

- **Q5: Multi-series chart shape?** →
  YES — one series per `reason`. Computed regardless of the `by:`
  toggle (the chart always tells the reason-over-time story). Same
  `< 2 distinct dates → empty array` gate as COGS. Multi-series is
  supported by `react-native-chart-kit` and the existing
  `ReportDetailFrame` chart panel — confirmed by inspecting the COGS
  output shape vs the frame renderer.

- **Q6: Should the spec add an enum / FK to `waste_log.reason`?** →
  NO. The init schema comment lists six conventional values
  ('Expired' | 'Dropped/spilled' | 'Over-prepped' | 'Quality issue' |
  'Theft' | 'Other') but the column is `text` with no constraint. Adding
  an enum would couple this spec to a separate schema decision and risks
  breaking historical rows whose `reason` was free-typed by an older
  staff-app version. The runner treats `reason` as user-supplied text;
  `coalesce(nullif(trim(reason), ''), '(no reason)')` handles
  null/empty cases. Tightening the column is a future spec.

- **Q7: Does this spec add a new table?** →
  NO. The `waste_log` table already exists and is well-populated by the
  staff-app `staff_log_waste` RPC. No schema additions.

- **Q8: Realtime?** →
  No new subscription. `waste_log` is already on the realtime publication
  via `20260514140000_realtime_publication_tighten.sql:45` and the
  `store-{id}` channel already listens (`useRealtimeSync.ts:35`). A waste
  log written by the staff app triggers a debounced reload — re-running
  the open Waste report is the user's deliberate action via the RUN
  button, not a push.

## Dependencies

- Migration applies cleanly via `npx supabase db push` (no realtime
  publication touch — `waste_log` is already published).
- No new edge function deploys.
- No new tables.
- pgTAP test count: 15 files → 16 files. Existing
  `reports_anon_revoke.test.sql` plan grows from 8 → 9.
- Reads from `waste_log`, `inventory_items`, `catalog_ingredients`
  (per-store RLS gates already in place from spec 020 hardening).
- The variance migration `20260512120000_report_run_variance.sql:619-620`
  already created `idx_waste_log_store_logged_at on waste_log (store_id,
  logged_at)` — the waste runner inherits that index for its
  store-scoped time-range scan, no new index needed.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. `src/screens/cmd/sections/
  ReportsSection.tsx` is the only Reports surface (legacy admin was
  deleted in spec 025).
- **Per-store or admin-global:** Per-store. The RPC's
  `auth_can_see_store(p_store_id)` gate enforces it; admins/masters still
  see cross-store via the same helper.
- **Realtime channels touched:** None added. The `store-{id}` channel
  already includes `waste_log` since `20260514140000_realtime_publication
  _tighten.sql`. The detail frame does NOT auto-rerun on waste-log
  inserts (re-run is the user's action via the RUN button).
- **Migrations needed:** YES — one new SQL migration creating
  `report_run_waste(uuid, jsonb)` + re-creating the dispatcher with the
  `'waste'` arm. No realtime publication change. No new index (variance
  migration already added the matching one).
- **Edge functions touched:** None.
- **Web/native scope:** Both. No web-only or native-only code. The
  Reports section is Cmd UI which runs on both surfaces via the existing
  `CmdNavigator` shell.
- **Tests track:** pgTAP (`supabase/tests/report_run_waste.test.sql` new
  file) + pgTAP edit (`reports_anon_revoke.test.sql` adds one arm). No
  new jest. No new shell smoke. Test-engineer routes accordingly per
  spec 022's three tracks.
- **app.json slug:** Not touched. Locked to `towson-inventory` per the
  CLAUDE.md DO-NOT-AUTO-FIX rule.

## Handoff

Backend-architect will: (a) decide the column-key naming for `by='reason'`
vs `by='category'` vs `by='item'` (the migration header should pin a
column-key naming policy so frontend frame renderers don't fight CSS over
shifting keys), (b) decide whether the `dispatcher` re-create needs to
preserve a `-- REPORTS-4 will add ...` comment or simply add the arm, and
(c) name the migration timestamp + filename.

## Architect design

### A1. Column-key naming policy — PER-MODE NAMED KEYS (mirror COGS)

**Decision.** Each `by:` mode uses its own dimension-specific column key
matching the row JSONB key: `'reason'` / `'category'` / `'item'`. The
shared analytic columns (`qty`, `items_affected`, `dollar_impact`,
`unit`) keep stable keys across all three modes.

**Why not a generic `dimension` key.** The variance/COGS precedent uses
named keys. COGS at
[supabase/migrations/20260511120000_report_run_cogs.sql:174-191](../../supabase/migrations/20260511120000_report_run_cogs.sql)
emits `'category'` as the column key when `by='category'` and `'item'`
when `by='item'`, with the row JSONB at lines 474 / 570 keyed
identically. Variance at
[supabase/migrations/20260512120000_report_run_variance.sql:228-234](../../supabase/migrations/20260512120000_report_run_variance.sql)
uses the `'item'` key directly. A generic `'dimension'` key would create
a third pattern; the rule is "match the established precedent unless the
spec demands divergence" and the spec does not. The frame renderer
([src/screens/cmd/sections/reports/ReportDetailFrame.tsx](../../src/screens/cmd/sections/reports/ReportDetailFrame.tsx))
reads `columns[i].key` and looks up `row[col.key]` — both shapes work
mechanically, but the per-mode named pattern is what users already debug
against in COGS / variance log output.

**Pinned column shapes (per AC line 90-99 with this naming policy):**

```
by='reason':
  columns: [
    { key: 'reason',          label: 'Reason',         align: 'left'  },
    { key: 'qty',             label: 'Qty',            align: 'right' },
    { key: 'items_affected',  label: 'Items',          align: 'right' },
    { key: 'dollar_impact',   label: '$ impact',       align: 'right' }
  ]
  rows[i]: { reason, qty, items_affected, dollar_impact }

by='category':
  columns: [
    { key: 'category',        label: 'Category',       align: 'left'  },
    { key: 'qty',             label: 'Qty',            align: 'right' },
    { key: 'items_affected',  label: 'Items',          align: 'right' },
    { key: 'dollar_impact',   label: '$ impact',       align: 'right' }
  ]
  rows[i]: { category, qty, items_affected, dollar_impact }

by='item':
  columns: [
    { key: 'item',            label: 'Item',           align: 'left'  },
    { key: 'category',        label: 'Category',       align: 'left'  },
    { key: 'qty',             label: 'Qty',            align: 'right' },
    { key: 'unit',            label: 'Unit',           align: 'left'  },
    { key: 'dollar_impact',   label: '$ impact',       align: 'right' }
  ]
  rows[i]: { item, category, qty, unit, dollar_impact }
```

The migration header MUST document this policy in the comment block so
post-impl reviewers don't relitigate. The `items_affected` key (mirrors
"distinct items in this group" from the AC) is stable across `reason` /
`category` and absent in `item` mode — same shape as COGS where COGS-%
columns differ between `item` and `category` modes.

### A2. Dispatcher arm placement

**Decision.** Append the `when 'waste' then` arm immediately after the
existing `when 'variance' then` arm at
[supabase/migrations/20260512120000_report_run_variance.sql:648-649](../../supabase/migrations/20260512120000_report_run_variance.sql),
preserving the `'stub'` / `'cogs'` / `'variance'` arms and the
`not_implemented` fallback verbatim. No `-- REPORTS-5 will add ...`
forward-reference comment — the variance dispatcher comment shipped one
for variance because variance was already in flight when COGS landed
(see line 691 in `report_run_cogs.sql`). With waste being the last of
the four "live" templates the spec calls out, a forward-reference would
need to point at vendor/velocity/custom which are still in the backlog
and may never land in the named-template style. Cleaner to add the arm
without a forward-reference; the next template's spec can decide.

**Dispatcher pattern (verbatim re-create with new arm):**

```sql
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
    when 'stub'     then return public.report_run_stub(p_store_id, p_params);
    when 'cogs'     then return public.report_run_cogs(p_store_id, p_params);
    when 'variance' then return public.report_run_variance(p_store_id, p_params);
    when 'waste'    then return public.report_run_waste(p_store_id, p_params);
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

`create or replace` preserves outstanding grants — no separate
re-grant for surface-stable callers.

### A3. Migration filename / timestamp

**Decision.**
`supabase/migrations/20260514170000_report_run_waste.sql`.

The last migration on disk is
[supabase/migrations/20260514160000_assert_not_last_of_role.sql](../../supabase/migrations/20260514160000_assert_not_last_of_role.sql)
(spec 031, 2026-05-14 16:00:00). Today is 2026-05-14. Next free hour-
slot on the same date is `170000` (17:00). Convention matches the
existing 2026-05-14 cluster: `120000`, `120010`, `120020`, `120030`,
`130000`, `140000`, `150000`, `160000`, `170000`.

### A4. Migration shape (full skeleton)

Filename: `supabase/migrations/20260514170000_report_run_waste.sql`.

```
-- ============================================================
-- Spec 034 — Reports: Waste cost template runner.
--
-- public.report_run_waste(p_store_id uuid, p_params jsonb) returns jsonb
--
-- Returns the spec 016 uniform envelope { kpis, columns, rows, series }
-- aggregating waste_log over a date window, sliced by reason / category /
-- item per p_params.by.
--
-- DESIGN NOTES (pinned by the architect; don't relitigate post-impl):
--
-- • Column-key naming. Per-mode named keys, NOT generic 'dimension'.
--   by='reason'   → rows have a 'reason'   key; columns key 'reason'.
--   by='category' → rows have a 'category' key; columns key 'category'.
--   by='item'     → rows have an 'item'    key; columns key 'item'.
--   Shared analytic keys: qty, items_affected, dollar_impact, unit.
--   This matches the variance/COGS pattern. Frame renderer reads
--   row[col.key].
--
-- • Date window divergence from variance. CLOSED [from, to] on
--   logged_at::date (`>= v_from AND <= v_to`), NOT variance's
--   half-open (v_from, v_to]. Rationale: waste is an event log,
--   not anchor-pair reconciliation; single-day windows must include
--   that day's rows. COGS line 297 is the precedent.
--
-- • Cost source. waste_log.cost_per_unit SNAPSHOT only. Captured at
--   log-time by staff_log_waste (20260504000002_staff_log_waste_rpc
--   :42-65). No fallback to inventory_items.cost_per_unit — the
--   snapshot is the historically-correct number. NULL cost → row
--   contributes $0 to dollar_impact / Total waste $; qty still
--   surfaces in the row count.
--
-- • No recursive prep-recipe CTE. waste_log references
--   inventory_items.id directly — the data is already at the
--   granular level. Future contributors: don't mimic the variance/
--   COGS recursive CTE here. It's load-bearing absence.
--
-- • from == to is ALLOWED (single-day waste reports are meaningful).
--   Diverges from variance which requires distinct anchors.
--
-- • Top driver KPI cross-cuts. Computed via reason grouping
--   regardless of the by: toggle — it's the "what's hurting us most"
--   signal. Omitted from kpis array (not zero-valued) when no rows.
--
-- • Series cross-cuts. ONE series per reason, multi-line,
--   regardless of by: toggle. Empty array ('[]'::jsonb) when < 2
--   distinct logged_at dates; never null. Mirrors COGS line 661-672.
--
-- • Tone bands hardcoded: < $50 ok / $50-$200 warn / > $200 danger.
--   Per-brand thresholds are out of scope.
--
-- • Grants/revokes mirror spec 016 convention: revoke from public,
--   anon; grant to authenticated. Closes the anon-bypass-PUBLIC
--   foot-gun the reports_anon_revoke.test.sql covers.
-- ============================================================

create or replace function public.report_run_waste(
  p_store_id uuid,
  p_params   jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_from              date;
  v_to                date;
  v_by                text;
  v_total_dollar      numeric;
  v_total_qty         numeric;
  v_row_count         bigint;
  v_top_reason        text;
  v_top_reason_dollar numeric;
  v_distinct_dates    bigint;
  v_kpis              jsonb;
  v_columns           jsonb;
  v_rows              jsonb;
  v_series            jsonb;
  v_tone              text;
begin
  -- (1) AUTH GATE — first statement; mirrors variance line 142-146.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) PARAM COERCION. Malformed dates raise 22007/22008 natively
  -- (sanitized by the frontend's runReport toast path). Unknown keys
  -- in p_params are ignored. Default window: last 7 days inclusive
  -- (today-7d → today), matching the PM's resolved default. Note:
  -- this differs from COGS which defaults to 30 days — waste is a
  -- shorter-horizon signal per the PM resolution.
  v_from := coalesce(
    nullif(p_params->>'from', '')::date,
    ((now() at time zone 'utc')::date - interval '7 days')::date
  );
  v_to := coalesce(
    nullif(p_params->>'to', '')::date,
    (now() at time zone 'utc')::date
  );
  v_by := coalesce(nullif(p_params->>'by', ''), 'reason');
  if v_by not in ('reason', 'category', 'item') then
    -- Forward-compat: silently coerce unknown values to the default.
    v_by := 'reason';
  end if;

  -- (3) RANGE VALIDATION. from > to raises 22023; from == to is
  -- allowed (single-day waste reports are meaningful).
  if v_from > v_to then
    raise exception 'Waste report: from > to (% > %)', v_from, v_to
      using errcode = '22023';
  end if;

  -- (4) COLUMN HEADER — built up-front so the empty-result branch
  -- can return it without re-deciding on by. Per-mode named keys.
  if v_by = 'reason' then
    v_columns := jsonb_build_array(
      jsonb_build_object('key','reason',         'label','Reason',   'align','left' ),
      jsonb_build_object('key','qty',            'label','Qty',      'align','right'),
      jsonb_build_object('key','items_affected', 'label','Items',    'align','right'),
      jsonb_build_object('key','dollar_impact',  'label','$ impact', 'align','right')
    );
  elsif v_by = 'category' then
    v_columns := jsonb_build_array(
      jsonb_build_object('key','category',       'label','Category', 'align','left' ),
      jsonb_build_object('key','qty',            'label','Qty',      'align','right'),
      jsonb_build_object('key','items_affected', 'label','Items',    'align','right'),
      jsonb_build_object('key','dollar_impact',  'label','$ impact', 'align','right')
    );
  else  -- v_by = 'item'
    v_columns := jsonb_build_array(
      jsonb_build_object('key','item',           'label','Item',     'align','left' ),
      jsonb_build_object('key','category',       'label','Category', 'align','left' ),
      jsonb_build_object('key','qty',            'label','Qty',      'align','right'),
      jsonb_build_object('key','unit',           'label','Unit',     'align','left' ),
      jsonb_build_object('key','dollar_impact',  'label','$ impact', 'align','right')
    );
  end if;

  -- (5) BASE CTE — flattened waste rows joined to item/catalog names.
  -- Left-joins keep orphan rows (deleted inventory_items) with
  -- '(deleted item)' fallback per AC line 64-67. Idx covers the
  -- (store_id, logged_at) range scan — added by variance migration
  -- line 619-620.
  with base as (
    select
      wl.id,
      wl.item_id,
      wl.logged_at::date                                              as biz_date,
      wl.quantity::numeric                                            as qty,
      coalesce(wl.cost_per_unit, 0)::numeric * wl.quantity::numeric   as dollar,
      coalesce(nullif(trim(wl.reason), ''), '(no reason)')            as reason,
      coalesce(ci.name, '(deleted item)')                             as item_name,
      coalesce(nullif(trim(ci.category), ''), '(uncategorized)')      as category,
      coalesce(ci.unit, '')                                           as unit
    from public.waste_log wl
    left join public.inventory_items ii      on ii.id = wl.item_id
    left join public.catalog_ingredients ci  on ci.id = ii.catalog_id
    where wl.store_id = p_store_id
      and wl.logged_at::date >= v_from
      and wl.logged_at::date <= v_to
  ),
  totals as (
    select coalesce(sum(dollar), 0)::numeric  as total_dollar,
           coalesce(sum(qty),    0)::numeric  as total_qty,
           count(*)                           as row_count,
           count(distinct biz_date)           as distinct_dates
    from base
  ),
  top_reason as (
    select reason, sum(dollar)::numeric as dollar
    from base
    group by reason
    order by sum(dollar) desc, reason asc
    limit 1
  )
  select t.total_dollar, t.total_qty, t.row_count, t.distinct_dates,
         tr.reason,      tr.dollar
    into v_total_dollar, v_total_qty, v_row_count, v_distinct_dates,
         v_top_reason,   v_top_reason_dollar
    from totals t
    left join top_reason tr on true;

  -- (6) EMPTY-RESULT SHORT-CIRCUIT — populated columns, empty
  -- kpis/rows/series. Series is '[]' NOT null (spec 016 contract:
  -- null is reserved for templates that genuinely don't chart).
  if v_row_count = 0 then
    return jsonb_build_object(
      'kpis',    '[]'::jsonb,
      'columns', v_columns,
      'rows',    '[]'::jsonb,
      'series',  '[]'::jsonb
    );
  end if;

  -- (7) KPI ASSEMBLY. Tone bands hardcoded per AC line 108-113.
  v_tone := case
              when v_total_dollar < 50  then 'ok'
              when v_total_dollar < 200 then 'warn'
              else 'danger'
            end;

  v_kpis := jsonb_build_array(
    jsonb_build_object(
      'label','Total waste $',
      'value','$' || to_char(v_total_dollar, 'FM999,999,990.00'),
      'tone', v_tone
    ),
    jsonb_build_object(
      'label','Total qty wasted',
      'value', to_char(v_total_qty, 'FM999,990.000'),
      'tone', null
    )
  );
  -- Top driver KPI: only when at least one row exists AND a reason
  -- group has positive dollar. The empty-result short-circuit at (6)
  -- already handles row_count = 0; here we just guard against the
  -- (theoretically possible) case where every row has cost=0.
  if v_top_reason is not null and coalesce(v_top_reason_dollar, 0) > 0 then
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object(
        'label','Top driver',
        'value', v_top_reason || ' · $' || to_char(v_top_reason_dollar, 'FM999,999,990.00'),
        'tone', case
                  when v_top_reason_dollar < 50  then 'ok'
                  when v_top_reason_dollar < 200 then 'warn'
                  else 'danger'
                end
      )
    );
  end if;
  v_kpis := v_kpis || jsonb_build_array(
    jsonb_build_object('label','Logs in period', 'value', v_row_count, 'tone', null)
  );

  -- (8) ROWS. Server-side formatting preserves decimal precision
  -- across JSON round-trips. Sort: dollar_impact desc, group_key
  -- asc (tiebreaker keeps output deterministic). Branched by v_by.
  if v_by = 'reason' then
    with base as ( ... same as above ... ),  -- re-walks; plpgsql limitation
    grouped as (
      select reason,
             sum(qty)::numeric                  as qty,
             sum(dollar)::numeric               as dollar,
             count(distinct item_id) filter (where item_id is not null) as items_affected
      from base
      group by reason
    )
    select coalesce(jsonb_agg(row_obj order by dollar desc, reason asc), '[]'::jsonb)
      into v_rows
      from (
        select jsonb_build_object(
          'reason',         reason,
          'qty',            to_char(qty,    'FM999,990.000'),
          'items_affected', items_affected,
          'dollar_impact',  case when dollar >= 0
                                 then '$'  || to_char(dollar,      'FM999,999,990.00')
                                 else '-$' || to_char(abs(dollar), 'FM999,999,990.00') end
        ) as row_obj, dollar, reason
        from grouped
      ) ordered;
  elsif v_by = 'category' then
    -- mirror shape, group by category, key 'category'
  else  -- by = 'item'
    -- mirror shape, group by item_name+category+unit, key 'item';
    -- no items_affected column (the row IS the item)
  end if;

  -- (9) SERIES. ONE series per reason. Each point:
  -- { label: <reason>, x: 'YYYY-MM-DD', y: <dollar> }.
  -- Computed regardless of v_by. Empty array when < 2 distinct
  -- logged_at dates have matched rows (same gate as COGS line
  -- 661-672). NEVER null.
  if v_distinct_dates < 2 then
    v_series := '[]'::jsonb;
  else
    with base as ( ... same as above ... ),
    daily_by_reason as (
      select reason, biz_date, sum(dollar)::numeric as dollar
      from base
      group by reason, biz_date
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'label', reason,
        'x',     to_char(biz_date, 'YYYY-MM-DD'),
        'y',     round(dollar, 2)
      ) order by reason asc, biz_date asc
    ), '[]'::jsonb)
      into v_series
      from daily_by_reason;
  end if;

  -- (10) FINAL ENVELOPE.
  return jsonb_build_object(
    'kpis',    v_kpis,
    'columns', v_columns,
    'rows',    v_rows,
    'series',  v_series
  );
end;
$$;

revoke execute on function public.report_run_waste(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_waste(uuid, jsonb) to authenticated;

-- ─── Dispatcher: add 'waste' arm ───────────────────────────────
-- (see A2 above — full re-create body)
create or replace function public.report_run( ... ) ...
```

**Implementation notes for the developer:**

- The base CTE is re-walked in sections (5)/(8)/(9) because plpgsql
  can't share a CTE across statements. Same pattern as
  [supabase/migrations/20260511120000_report_run_cogs.sql:373-377](../../supabase/migrations/20260511120000_report_run_cogs.sql).
  At seed scale (waste_log ~0 rows in the default seed; production
  scales to thousands per store-month) this is well under 50ms — the
  variance migration's `idx_waste_log_store_logged_at on waste_log
  (store_id, logged_at)` index already covers the filter shape.
- The skeleton above shows the `by='reason'` rows branch fully; the
  `category` and `item` branches mirror it with the appropriate
  GROUP BY and row JSONB shape from A1. The developer fills in
  verbatim — same as COGS lines 386-583.
- `items_affected` is `count(distinct item_id) filter (where
  item_id is not null)`. The `filter` guards orphan `waste_log.item_id`
  rows where the inventory_items row was hard-deleted (the left-join
  produces NULL there). `'(deleted item)'` rows still count toward
  qty and dollar; they don't count toward items_affected (which is
  meant to count *real* items in the group).
- Numeric coercion: `sum(quantity)` and `sum(dollar)` cast to
  `numeric` explicitly so the `to_char` format mask doesn't pick up
  float drift. Same pattern as variance line 462-468.

### A5. pgTAP test design — `supabase/tests/report_run_waste.test.sql`

**Filename.** `supabase/tests/report_run_waste.test.sql`.

**Plan count.** `plan(11)`. Mirrors the variance-formula test's
density and adds two arms for the per-mode column smoke (AC line 203-205).

**Test arms (one assertion per arm unless noted):**

```
plan(11)

(1) fixture: Frederick store id resolves from seed
(2) fixture: Frederick inventory item with cost > 0 resolves
(3) auth gate: manager calling waste on Charles raises 42501
(4) empty range: from = to = '2000-01-01' returns
    populated columns + empty kpis / rows / series arrays
    (assert jsonb_typeof and jsonb_array_length all = 0 for the empties)
(5) single-row happy path — Total waste $ KPI value = '$10.00'
    (qty=2.5, cost=4.00, reason='Spoilage', logged_at=2026-05-02,
     params {from='2026-05-02', to='2026-05-02', by='reason'})
(6) single-row happy path — rows[reason=Spoilage].qty = '2.500'
(7) single-row happy path — rows[reason=Spoilage].dollar_impact = '$10.00'
(8) missing-cost zero-out — second insert with cost_per_unit=NULL,
    that row's dollar_impact = '$0.00' AND total kpis dollar excludes it.
    (NO ⚠ suffix expected — AC line 195-198 / Q5 resolution)
(9) multi-row ordering — third insert (cost=20, qty=1, reason='Theft')
    dominates; rows[0].reason='Theft', rows[1] is Spoilage; dollar desc.
(10) envelope shape — sorted-key list matches array
    ['columns','kpis','rows','series']::text[]
    (mirrors variance line 248-256, COGS line 105-113)
(11) by-mode smoke — call once with by='category' AND once with by='item';
    assert (env_cat->'columns'->0->>'key') = 'category'
    AND     (env_item->'columns'->0->>'key') = 'item'
    (single is() with array_agg over both env keys to keep it one arm)
```

**Why 11 arms vs the AC's "at least 8 cases."** The AC enumerates 8
*cases*; pgTAP measures *assertions*. Cases (1)/(2) are fixture
isnt() probes (2 arms); case (4) compresses to one is() with a
4-element jsonb assertion (1 arm); cases (4) happy path needs three
arms across KPI/qty/dollar_impact (the AC AC explicitly lists those
three sub-assertions on line 192-194); case (5) missing-cost is one
arm; case (6) ordering is one arm with two row indices but emitted
as one is(); case (7) envelope shape is one is() against a sorted
array; case (8) by-mode smoke compresses to one is() comparing both
mode outputs in the same assertion. 2+1+1+3+1+1+1+1 = 11.

**Fixture pattern.** Mirror
[supabase/tests/report_run_variance_formula.test.sql:42-86](../../supabase/tests/report_run_variance_formula.test.sql).
Manager id `22222222-2222-2222-2222-222222222222`, Frederick store
named lookup, pick a Frederick inventory_item with cost > 0. Wrap
in `begin; ... rollback;` — temp fixture rows roll back.

**JWT claims.** `set local role authenticated` + `request.jwt.claims`
with `app_metadata.role = 'user'`. Same shape as variance test line
92-101.

### A6. `reports_anon_revoke.test.sql` extension — plan(8) → plan(9)

**Edit shape.** Two changes to
[supabase/tests/reports_anon_revoke.test.sql](../../supabase/tests/reports_anon_revoke.test.sql):

1. Header comment list at line 10-17: add bullet
   `• report_run_waste(uuid, jsonb) — spec 034`
   between the `report_run_variance` line and the
   `report_reorder_list` line (preserves the
   migration-order convention).

2. `plan(8)` → `plan(9)` at line 34.

3. Insert a new test arm between current arm (4)
   `report_run_variance` and current arm (5)
   `report_reorder_list`, renumbering downstream arms in their
   comment headers (the actual `throws_ok` calls have no
   numbering — just the comment markers):

```
-- ─── (5) report_run_waste: anon → 42501 ────────────────────────
select throws_ok(
  format(
    $q$select public.report_run_waste(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.frederick_id', true)
  ),
  '42501',
  null,
  'report_run_waste denied to anon (42501 at GRANT time)'
);
```

Then current arm (5) `report_reorder_list` becomes (6), (6)
`submit_inventory_count` becomes (7), (7) `staff_submit_eod`
becomes (8). Plan moves 8 → 9.

### A7. Cmd UI wiring

**Files touched (exact edits, no other diffs):**

1. [src/screens/cmd/sections/reports/templates.ts](../../src/screens/cmd/sections/reports/templates.ts)
   line 28:
   `status: 'preview'` → `status: 'live'` on the `waste` row. No
   other field changes (name, sub, cols, icon stay). Also update
   the leading `// REPORTS-N flipped X to live` comment block
   (lines 12-13) to add `// REPORTS-? flipped waste to 'live'
   (see 20260514170000_report_run_waste.sql).` consistent with
   the existing comment style. (The numbering — REPORTS-2,
   REPORTS-3, etc. — is informal; spec 034 doesn't have to
   pick a number. The developer can drop the number or write
   `// Spec 034 flipped waste to 'live'`.)

2. [src/components/cmd/NewReportModal.tsx](../../src/components/cmd/NewReportModal.tsx)
   - Line 90: extend the `by` state type from `'category' |
     'item'` to `'reason' | 'category' | 'item'`. Default value
     stays `'category'` for COGS; the per-template default
     defaults to `'reason'` for waste (added below).
   - Line 116: reset value in the `useEffect` block — when the
     picked template is `'waste'`, reset to `'reason'`;
     otherwise `'category'`. Single ternary, no flag changes.
   - Lines 504-524: replace the hardcoded
     `(['category', 'item'] as const).map(...)` with a
     per-template option array. Sketch:
     ```ts
     const BY_OPTIONS: Record<string, ReadonlyArray<'reason' | 'category' | 'item'>> = {
       cogs:  ['category', 'item'] as const,
       waste: ['reason', 'category', 'item'] as const,
     };
     const byOptions = BY_OPTIONS[picked] ?? (['category', 'item'] as const);
     ```
     Then `byOptions.map((opt) => ...)` for the chip render.
     This keeps the COGS chip strip identical (two options) and
     gives waste three — no regression on COGS.
   - Lines 232-239: the `params` object for `!isVariance` path
     stays identical (`{ range, from, to, by }`). The `by` value
     is now drawn from the extended union.

3. [src/screens/cmd/sections/ReportsSection.tsx](../../src/screens/cmd/sections/ReportsSection.tsx)
   - Line 34 (interface OverrideState):
     `by?: 'category' | 'item'` → `by?: 'reason' | 'category' | 'item'`.
   - Line 171 (setOverrideBy):
     `(by: 'category' | 'item')` → `(by: 'reason' | 'category' | 'item')`.
   - No other change. `selectedSupportsBy` at line 235 already
     gates correctly via `selectedTemplate?.id !== 'variance'`
     — once `waste.status === 'live'`, waste flows through this
     branch automatically.

4. [src/screens/cmd/sections/reports/ReportDetailFrame.tsx](../../src/screens/cmd/sections/reports/ReportDetailFrame.tsx)
   - Line 55-56: extend props type for `overrideBy` and
     `onByChange` from `'category' | 'item'` to
     `'reason' | 'category' | 'item'`.
   - Line 179: extend `savedBy` resolution — currently
     `definition.params?.['by'] === 'item' ? 'item' : 'category'`.
     Generalize to admit `'reason'`:
     ```ts
     const rawBy = definition.params?.['by'];
     const savedBy: 'reason' | 'category' | 'item' =
       rawBy === 'item' ? 'item' :
       rawBy === 'reason' ? 'reason' :
       'category';
     ```
   - Line 186, 193, 242: widen the type from `'category' |
     'item'` to `'reason' | 'category' | 'item'` in the type
     annotations and the `onPickBy` callback signature.
   - Lines 635-636, 654: in `ByPopover`, extend the prop type
     and the hardcoded option array. Like the modal, drive the
     option list off the picked template — but the frame doesn't
     have access to `picked` because the frame is a
     definition-detail view. Read it off
     `definition.templateId`:
     ```ts
     const byOpts: ReadonlyArray<'reason' | 'category' | 'item'> =
       definition.templateId === 'waste'
         ? (['reason', 'category', 'item'] as const)
         : (['category', 'item'] as const);
     ```
     Pass `byOpts` into `ByPopover` and replace the literal map.

5. [src/types/index.ts](../../src/types/index.ts)
   line 527 (the `cogs` params shape JSDoc). Add an analogous
   line for `waste`:
   ```
   *  - `waste` (Spec 034): `{ range?: ..., from?: 'YYYY-MM-DD',
   *    to?: 'YYYY-MM-DD', by?: 'reason' | 'category' | 'item' }`.
   ```
   Comment-only — no type field change because the shared
   `ReportDefinition.params` type is already `Record<string,
   unknown>` (or similar untyped JSONB stand-in).

**Note on `ReportDetailFrame.tsx`.** The spec AC at line 152-157
says "No template-specific code expected" in the detail frame
beyond the by-chip override. The strict reading is correct for
the *rendering* path (rows/columns are generic). But the
`savedBy` parser at line 179 and the `ByPopover` option list
at line 654 ARE template-aware today (they hardcode COGS's two
options). Extending them to admit `'reason'` is template-aware
in the same way. The developer should NOT factor this into a
generic template-options registry in this spec — that's a
follow-up if waste/cogs/vendor accumulate. Keep the per-template
branches inline as small ternaries.

### A8. `src/lib/db.ts` surface

**No new helpers.** The generic
[src/lib/db.ts](../../src/lib/db.ts) `runReportRpc(definitionId,
params)` (already in place) calls `public.report_run(template_id,
store_id, params)` which the dispatcher routes to the waste
runner. No new typed wrapper is needed. The envelope's
`columns/rows/kpis/series` are read by the generic frame; no
snake_case → camelCase mapping is required because the runner
emits already-formatted strings and the keys are already
camelCase-compatible (`dollar_impact`, `items_affected` are
snake_case but they're consumed as
`row[col.key]` rather than destructured, so the frame doesn't
care).

The `runReport` zustand action in
[src/store/useStore.ts](../../src/store/useStore.ts) is also
generic — it persists the run to `report_runs` and pushes the
result into the `reportRuns` slice keyed by definition id. No
slice change.

### A9. Realtime impact

**No change.** `waste_log` is already on the `supabase_realtime`
publication via
[supabase/migrations/20260514140000_realtime_publication_tighten.sql:45](../../supabase/migrations/20260514140000_realtime_publication_tighten.sql).
`useRealtimeSync.ts:35` already subscribes via the `store-{id}`
channel. A waste log written by the staff app continues to
trigger a debounced reload, but the open detail frame does NOT
auto-rerun (re-run is the user's RUN-button action — same as
COGS / variance).

**No publication-tighten migration in this spec → no docker
restart needed.** Calling this out per the architect agent's
checklist: this spec does NOT modify `supabase_realtime`
publication membership, so the standard
`docker restart supabase_realtime_imr-inventory` gotcha does
NOT apply. Plain `supabase db push` (or local `supabase db
reset`) suffices.

### A10. Frontend store impact

**No `useStore.ts` change.** All four touched UI files
(`templates.ts`, `NewReportModal.tsx`, `ReportsSection.tsx`,
`ReportDetailFrame.tsx`) read from the existing store actions
(`runReport`, `addReportDefinition`, `loadLatestRun`,
`deleteReportDefinition`). The OverrideState type lives in
`ReportsSection.tsx` (line 32-35) — not the store. Extending
it to admit `'reason'` is a pure local-state change.

**No optimistic-then-revert change.** The existing `runReport`
path already handles the optimistic pending row → RPC resolve
→ either success or `notifyBackendError` toast cycle. The
waste runner's error shapes (`22023` from > to; native
`22007`/`22008` malformed-date) are sanitized by the existing
sanitizer ("Run failed — check server logs") per AC line 42-44.

### A11. Edge function changes

**None.** RPC-only spec. No changes to
[supabase/functions/](../../supabase/functions/) or
[supabase/config.toml](../../supabase/config.toml).

### A12. `app.json`

**Not touched.** Locked to `towson-inventory` per
CLAUDE.md's DO-NOT-AUTO-FIX rule.

### A13. Risks and tradeoffs

1. **Per-mode column-key naming maintains the variance/COGS
   precedent but means the frame renderer must keep
   `row[col.key]` semantics.** Already the case
   ([ReportDetailFrame.tsx](../../src/screens/cmd/sections/reports/ReportDetailFrame.tsx)
   reads columns generically). Verified before approving the
   policy. Risk: if a future spec adds a *fourth* dimension
   key, the per-template branches in NewReportModal /
   ReportDetailFrame grow. Mitigation: the developer note at
   the end of A7 explicitly defers the generic-registry
   refactor.

2. **CTE re-walk in sections (5)/(8)/(9).** plpgsql
   limitation, not a regression. Matches COGS at line
   373-377 / variance at line 295-298. Seed-scale impact
   negligible; production scale (thousands of waste rows per
   store-month) still well within the (store_id, logged_at)
   index seek + sort budget. Risk: if waste_log grows
   pathologically (10k+ rows/day), the three-pass aggregation
   could surface as latency. Not a v1 concern.

3. **Cost-snapshot vs current-cost.** Locked to snapshot per
   Q2 resolution. A row logged before the staff app captured
   `cost_per_unit` (legacy / dev-fixture rows) contributes
   $0. Not a regression — same as COGS missing-cost rows.
   If a user complains "my Total waste $ is too low,"
   instruct them to spot-check `select count(*) filter (where
   cost_per_unit is null) from waste_log where store_id = ?`
   on the affected store and re-log via the staff app. This
   is a documentation concern, not a code one.

4. **No depth-cap pre-walk like variance/COGS.** Waste has no
   recipe graph (AC line 126-129). Risk is the opposite of a
   bug: pattern-mimicry. The migration header documents the
   absence explicitly so a future contributor doesn't add one
   "to be consistent."

5. **`'(no reason)'` and `'(deleted item)'` and
   `'(uncategorized)'` are user-facing strings.** Hardcoded
   in English in the SQL. The Cmd UI is English-only today;
   if i18n lands, these become a follow-up (same as the
   existing COGS `'(uncategorized)'` and variance
   `'(deleted item)'`).

6. **Test plan(11) is denser than COGS's plan(5) but
   matches variance-formula's plan(7) + a few more arms for
   the by-mode coverage.** Acceptable. The spec AC at line
   178-205 enumerates 8 cases; plan(11) accommodates the
   sub-assertions cleanly. If pgTAP miscounts during a
   developer's local run, the failure is loud.

7. **No CI gate.** Per CLAUDE.md "CI workflow" resolved-question.
   The `db-migrations-applied.yml` workflow is not on disk.
   Developer MUST verify locally via `npm run test:db` (15 → 16
   files, plan deltas 8 → 9 on `reports_anon_revoke`) AND `npm
   run dev:db` smoke per the spec's verification gates (line
   223-233). No automated drift check.

8. **`waste_log.reason` is free-form text.** Q6 resolution
   pinned this: no enum in this spec. Risk: production data may
   contain weird reason strings ('Wasted ', '  spoilage',
   'broken!!') that the runner groups as distinct. Mitigation:
   the `coalesce(nullif(trim(reason), ''), '(no reason)')`
   normalizer trims surrounding whitespace and coalesces
   blanks. Case-folding is NOT applied — `'Spoilage'` vs
   `'spoilage'` will surface as separate groups. If reason
   buckets fragment in production, surface as a follow-up to
   tighten the staff app's reason input (drop-down) rather
   than the runner.

### A14. Test count gates

**Per the spec verification gates (line 216-220) and PM resolved
assumption:**

- jest: **unchanged at 54** (no new TS helpers; the modal /
  frame / templates changes are inline branches, no extracted
  utility module per the dev note at the end of A7).
- pgTAP: **15 → 16 files** (new
  `supabase/tests/report_run_waste.test.sql`). The existing
  `reports_anon_revoke.test.sql` moves `plan(8)` → `plan(9)`
  (assertion count, not file count).
- shell smokes: **unchanged**. No new arms in
  `scripts/smoke-rpc.sh` — the dispatcher arm is reached
  through the existing `report_run('stub', ...)` smoke (per
  AC line 207-210).

### A15. Post-merge deploy

- `npx supabase db push` — applies the new migration. Idempotent
  via `create or replace`.
- **No edge function deploy** (`supabase functions deploy ...`
  not needed — RPC-only).
- **No realtime publication change** — `docker restart
  supabase_realtime_imr-inventory` NOT needed.
- **No app.json / EAS rebuild needed** — pure Cmd UI + DB.
  Standard Vercel re-deploy on the next merge to main picks
  up the frontend changes.
- **Local dev verification sequence:**
  ```
  npx supabase db reset      # or `db push` against running stack
  npm run test:db            # 16 files, all passing; reports_anon_revoke plan = 9
  npm run dev                # browser smoke per spec line 223-233
  ```

### A16. Cross-cutting confirmations (architect checklist)

- [x] **No realtime publication change.** Per A9 — `waste_log`
      already published, no `docker restart` required.
- [x] **No edge function changes.** Per A11 — RPC-only.
- [x] **No `src/lib/db.ts` changes.** Per A8 — generic
      `runReport` plumbing handles it; the envelope shape is
      template-agnostic at the db.ts boundary.
- [x] **No `useStore.ts` changes.** Per A10 — existing
      `runReport` / `loadLatestRun` / `addReportDefinition`
      cover it.
- [x] **No `app.json` touch.** Per A12 — locked to
      `towson-inventory` per CLAUDE.md DO-NOT-AUTO-FIX.

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec. Single agent —
  one new migration (`supabase/migrations/20260514170000_report_run_waste.sql`),
  one new pgTAP test (`supabase/tests/report_run_waste.test.sql`,
  plan(11)), one pgTAP edit (`reports_anon_revoke.test.sql` plan(8) → plan(9)
  with the new arm), and four small UI edits (`templates.ts` flag flip,
  `NewReportModal.tsx` extend by-options + per-template default,
  `ReportsSection.tsx` extend OverrideState union, `ReportDetailFrame.tsx`
  extend savedBy + ByPopover options). After implementation, set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/034-reports-waste-template/spec.md

## Files changed

### Migrations
- `supabase/migrations/20260514170000_report_run_waste.sql` (new) — creates
  `public.report_run_waste(uuid, jsonb)` runner; re-creates the dispatcher
  `public.report_run(text, uuid, jsonb)` with the new `'waste'` arm appended
  after `'variance'`. SECURITY INVOKER, `search_path=public`, revoke from
  `public, anon`, grant to `authenticated`. Closed `[from, to]` window on
  `logged_at::date`; snapshot cost from `waste_log.cost_per_unit` (no
  fallback to `inventory_items`). `by='reason' | 'category' | 'item'`
  with per-mode named row keys per architect §A1. KPIs: Total waste $
  (banded ok/warn/danger at $50/$200), Total qty wasted, Top driver
  (always reason-grouped), Logs in period. Series: one line per reason,
  empty when < 2 distinct dates.

### Tests
- `supabase/tests/report_run_waste.test.sql` (new) — `plan(11)`; mirrors
  the variance-formula test's pattern. Fixture resolves Frederick id +
  cost>0 item; auth gate raises 42501 for non-member store; empty-range
  short-circuit; per-row formula on Spoilage/Quality issue/Theft inserts;
  missing-cost zero-out (no ⚠ suffix per Q5); ordering by dollar_impact
  desc; envelope-shape sanity; by='category' / by='item' column-key smoke.
- `supabase/tests/reports_anon_revoke.test.sql` (modified) — plan(8) →
  plan(9). Inserts a new arm (5) for `report_run_waste(uuid, jsonb)`
  between current variance arm (4) and reorder-list arm (5); renumbers
  downstream comment markers; updates the header bullet list (7 → 8 RPCs).

### Frontend — templates
- `src/screens/cmd/sections/reports/templates.ts` (modified) — flips the
  `waste` row's `status: 'preview'` → `'live'`. Adds the Spec 034
  comment line alongside the existing REPORTS-2 / REPORTS-3 history.

### Frontend — modal
- `src/components/cmd/NewReportModal.tsx` (modified) — widens the local
  `by` state union to `'reason' | 'category' | 'item'`; adds the
  `BY_OPTIONS` registry (`cogs: [category, item]`,
  `waste: [reason, category, item]`) with `DEFAULT_BY_OPTIONS` fallback;
  adds `defaultByForTemplate(templateId)` helper (waste → 'reason';
  others → 'category'); calls it on modal open AND on mid-modal
  non-variance template switch so the chip strip aligns with the
  picked template; replaces the hardcoded `['category', 'item']` chip
  map with `BY_OPTIONS[picked] ?? DEFAULT_BY_OPTIONS`.

### Frontend — section
- `src/screens/cmd/sections/ReportsSection.tsx` (modified) — widens
  `OverrideState['by']` from `'category' | 'item'` to
  `'reason' | 'category' | 'item'`; widens the `setOverrideBy(by)`
  parameter type to match. The Spec 034 comment in the interface
  documents that COGS continues to ignore `'reason'` if a saved
  definition somehow carries that value (the RPC coerces unknown
  values to its default).

### Frontend — detail frame
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` (modified) —
  widens `overrideBy` / `onByChange` prop types to admit `'reason'`;
  generalises the `savedBy` parser to admit `'reason'` (otherwise
  coerces to `'category'`, preserving COGS behaviour); widens
  `effectiveBy` and `onPickBy` types; adds an inline
  `byOpts` derived from `definition.templateId` (waste → three options;
  others → COGS's two); widens `ByPopover`'s prop types and accepts an
  `options` array prop instead of the hardcoded
  `['category', 'item'] as const` literal.

### Types
- `src/types/index.ts` (modified — comment-only) — adds a `waste`
  JSDoc bullet in the `ReportDefinition.params` shape doc, mirroring
  the existing `cogs` bullet, including the additional `'reason'` value
  on the `by` axis. No type signature change (the shared
  `params?: Record<string, unknown>` type is unchanged).

### Post-merge deploy

`npx supabase db push --linked --yes` — applies the new migration
(`20260514170000_report_run_waste.sql`). No edge function deploy. No
realtime publication change. `waste_log` is already on the
`supabase_realtime` publication (per
`20260514140000_realtime_publication_tighten.sql:45`), so no
`docker restart supabase_realtime_imr-inventory` needed.

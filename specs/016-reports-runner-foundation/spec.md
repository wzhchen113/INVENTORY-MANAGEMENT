# Spec 016: Reports Runner Foundation (REPORTS-1)

Status: READY_FOR_REVIEW

> First of three sequential specs that turn the Reports section from a UI
> shell into a real report runner. **REPORTS-1 (this spec)** wires the
> persistence, RLS, RPC contract, and detail-view frame. **REPORTS-2** will
> implement the COGS template's RPC. **REPORTS-3** will implement the
> Variance template's RPC. Templates not addressed in REPORTS-2/3 (waste,
> vendor, velocity, custom) keep saving definitions and show a "Runner
> coming soon" placeholder until later specs land them.

## User story

As a 2AM PROJECT store manager, I want the Reports section to actually run
the reports I save — open a saved report, see KPIs, a table, and a chart of
my store's data — so the section stops being a hardcoded preview.

As a brand admin, I want saved reports to be store-scoped at the database
layer so a manager from one store can't read another store's report
definitions or runs through PostgREST.

## Acceptance criteria

### Database

- [ ] Migration `20260510NNNNNN_report_runs.sql` creates a
      `public.report_runs` table with columns:
      `id uuid pk default gen_random_uuid()`,
      `definition_id uuid null references report_definitions(id) on delete cascade`,
      `template_id text not null`,
      `store_id uuid not null references stores(id) on delete cascade`,
      `params jsonb not null default '{}'::jsonb`,
      `output jsonb null` (the uniform envelope; null while a run is in flight),
      `status text not null default 'pending' check (status in ('pending','ok','error'))`,
      `error_message text null`,
      `ran_at timestamptz not null default now()`,
      `ran_by uuid null references profiles(id)`.
      Indexes on `(definition_id, ran_at desc)` and `(store_id, template_id, ran_at desc)`.
- [ ] `definition_id` is nullable to allow ad-hoc runs (template + params
      with no saved definition) in REPORTS-2/3 and beyond. When
      `definition_id` is non-null, `store_id` and `template_id` MUST match
      the parent definition (enforced by the RPC, not a CHECK).
- [ ] **Retention policy: append-only history.** Every Run click writes a
      new row. Re-opening a saved report reads the most recent row matching
      `definition_id` (or `template_id` + caller hash for ad-hoc). No
      automatic pruning in REPORTS-1; a future spec will add scheduled
      cleanup if the table grows. Resolution: see Open question 1.
- [ ] Migration replaces the permissive
      `"authenticated can do anything"` policy on
      `public.report_definitions` with per-store policies built on
      `public.auth_can_see_store(store_id)` — read, insert, update, delete
      — matching the shape of
      `supabase/migrations/20260504173035_per_store_rls_hardening.sql:46-61`.
      Cross-store visibility for admins/super-admins is preserved because
      `auth_can_see_store` already delegates to `auth_is_admin()`.
- [ ] `public.report_runs` has RLS enabled with the same per-store policy
      shape as `report_definitions` (read/insert/update/delete via
      `auth_can_see_store(store_id)`). Update is included so the RPC can
      flip status from `pending` → `ok`/`error`.
- [ ] **Per-template RPC convention is documented in the migration's
      header comment** (no template implementations land in REPORTS-1).
      Required signature for every template runner that REPORTS-2/3 and
      future specs will introduce:

      ```sql
      create or replace function public.report_run_<template>(
        p_store_id uuid,
        p_params   jsonb
      ) returns jsonb
      language plpgsql
      security invoker
      set search_path = public
      as $$ ... $$;
      grant execute on function public.report_run_<template>(uuid, jsonb)
        to authenticated;
      ```

      Return shape (the uniform envelope) is exactly:

      ```json
      {
        "kpis":    [{ "label": "string", "value": "string|number", "tone": "ok|warn|danger|null" }],
        "columns": [{ "key": "string", "label": "string", "align": "left|right|null" }],
        "rows":    [{ "<col-key>": "value", ... }],
        "series":  [{ "label": "string", "x": "string", "y": "number" }] | null
      }
      ```

      `series` may be null for templates that don't chart. RPCs MUST
      validate the caller can see `p_store_id` via `auth_can_see_store`
      and raise if not. RPCs MUST NOT use `security definer`.
- [ ] **REPORTS-1 ships one stub RPC** —
      `public.report_run_stub(p_store_id uuid, p_params jsonb) returns jsonb`
      — that returns a hand-rolled envelope with one KPI, one column, two
      rows, and a 5-point series so the frontend frame can be exercised
      end-to-end. It's `security invoker`, gated by `auth_can_see_store`,
      and granted to `authenticated`. It is NOT exposed to any template
      tile — only to dev/test code paths and the placeholder branch
      described below.
- [ ] **Placeholder runner for not-yet-built templates.** A wrapper RPC
      `public.report_run(p_template_id text, p_store_id uuid, p_params jsonb) returns jsonb`
      dispatches by `template_id`. For REPORTS-1, it routes `'stub'` to
      `report_run_stub` and every other template to a "not implemented"
      error envelope:

      ```json
      { "kpis": [], "columns": [], "rows": [], "series": null,
        "_status": "not_implemented", "_message": "Runner coming soon · definition saved" }
      ```

      REPORTS-2 and REPORTS-3 will extend the dispatcher's `case`
      statement to add `'cogs'` and `'variance'`. Other templates keep
      returning the not-implemented envelope until their own specs land.

### `src/lib/db.ts`

- [ ] `db.runReport({ definitionId?, templateId, storeId, params })`
      calls `report_run` via PostgREST RPC, then inserts the result into
      `report_runs` (status `'ok'` or `'error'` per the envelope's
      `_status`). Returns the persisted `report_runs` row mapped to camelCase.
- [ ] `db.fetchLatestRun({ definitionId? , templateId? , storeId })`
      returns the most recent `report_runs` row for the given key, mapped
      to camelCase, or null if no rows exist.
- [ ] Both helpers follow the existing snake_case → camelCase
      `mapItem`-style convention used elsewhere in
      [src/lib/db.ts](src/lib/db.ts).

### `src/store/useStore.ts`

- [ ] Slice: `reportRuns: Record<string, ReportRun>` keyed by
      `definitionId` (most-recent only — full history stays in DB and is
      not denormalized into the store).
- [ ] Action `runReport(definitionId)` resolves the definition, calls
      `db.runReport`, optimistically writes a `pending` row to
      `reportRuns[definitionId]`, then replaces with the resolved row.
      On error, reverts and routes through `notifyBackendError` with the
      label `'Run report'`. Mirrors the pattern at
      [src/store/useStore.ts:1789](src/store/useStore.ts:1789).
- [ ] Action `loadLatestRun(definitionId)` calls `db.fetchLatestRun` and
      writes the row into `reportRuns[definitionId]` if present.
- [ ] No new `loadFromSupabase` wiring — runs are loaded lazily when a
      saved-report tile is opened, not eagerly on store boot. This keeps
      the per-store boot payload bounded.

### Frontend — `src/screens/cmd/sections/ReportsSection.tsx`

- [ ] **One source of truth for the template list.** Extract the
      `TEMPLATES` array from
      [src/components/cmd/NewReportModal.tsx:17-24](src/components/cmd/NewReportModal.tsx:17)
      to `src/screens/cmd/sections/reports/templates.ts` (new file) with
      the shape `{ id, name, sub, cols, icon, status: 'live'|'preview' }`
      where `status='live'` flags templates that have a real RPC wired
      (REPORTS-1 ships none `live`; REPORTS-2 flips `cogs`, REPORTS-3
      flips `variance`).
- [ ] The 8-element hardcoded `REPORTS` array at
      [src/screens/cmd/sections/ReportsSection.tsx:21-30](src/screens/cmd/sections/ReportsSection.tsx:21)
      is deleted. The template-catalog grid is derived from the new
      `templates.ts` (6 tiles). The 4 deleted ideas (top movers, recipe
      profitability, inventory aging, reorder forecast) are preserved as
      a "Future template proposals" appendix in this spec — see below.
      Resolution: see Open question 4.
- [ ] Catalog tiles render no fake numbers. A "PREVIEW" badge appears on
      every catalog tile in REPORTS-1 (none are `status='live'` yet);
      REPORTS-2/3 will remove the badge from `cogs` and `variance`.
- [ ] Catalog tile is `TouchableOpacity` (or pressable wrapper); `onPress`
      opens `NewReportModal` pre-filled with that template's `id` and a
      sensible default `name` (e.g. `"<Template> — May 2026"`). The
      modal already accepts a picked-template starting state via local
      `picked` state; REPORTS-1 lifts that to a prop
      `initialTemplateId?: ReportDefinition['templateId']` and pre-seeds
      the name based on the template + current month.
- [ ] Saved-report tile is a `TouchableOpacity`; `onPress` swaps the
      Reports section's internal view-state from `'list'` to
      `'detail'` with the selected `definitionId`. **Routing surface
      decision:** in-section state (mirroring how `InventoryDesktopLayout`
      handles drill-down via local state, not a navigation stack), NOT a
      separate Cmd sidebar section and NOT a URL hash. Resolution: see
      Open question 3.
- [ ] A back button in the detail header returns the section to `'list'`
      view. The back button keyboard shortcut is `Escape` on web,
      handled at the section level only when the detail view is open.

### Frontend — new `ReportDetailFrame` component

- [ ] New file:
      `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`. Generic
      detail frame, template-agnostic. Props:

      ```ts
      interface ReportDetailFrameProps {
        definition: ReportDefinition;
        latestRun: ReportRun | null;
        onRun: () => void;     // dispatches store.runReport(definition.id)
        onBack: () => void;
        running: boolean;      // true while runReport promise pending
      }
      ```

- [ ] Layout: header (template name · definition name · scope · last run
      timestamp · `RUN` button · back button), KPI strip
      (horizontal flex of `kpis[]`, tone color from envelope), table
      (rendered from `columns[]` × `rows[]`, tabular-nums, monospace
      header row, dashed border separator matching the section's existing
      treatment), chart panel (renders `series[]` if non-null using
      react-native-chart-kit's line chart, matching the chart treatment
      used in `DashboardSection`; if `series` is null, the panel is
      omitted, no empty placeholder).
- [ ] Empty states:
      - `latestRun === null`: panel reads "No runs yet — press RUN to
        compute" with the RUN button as the primary CTA.
      - `latestRun.output._status === 'not_implemented'`: panel reads
        "Runner coming soon · definition saved" with the message from
        the envelope; RUN button is disabled with tooltip "Not yet wired".
      - `latestRun.status === 'error'`: panel reads the
        `error_message` and offers a retry RUN.
- [ ] **Date-range UX: read-only from `params` set at create time** for
      REPORTS-1. The frame surfaces the date range as a header chip
      (e.g. `range: last 30d`) but does not include a picker. A picker
      lands in REPORTS-2 alongside the COGS template, where it's needed
      for an actual computation. The `NewReportModal` does NOT introduce
      a date-range field in REPORTS-1 either — `params` stays the empty
      object the modal currently writes; the frame defaults to "last 30d"
      semantics for display purposes only. Resolution: see Open question 5.

### Out of scope for REPORTS-1 (explicitly)

- Any actual variance / COGS / waste / vendor / velocity / custom-SQL
  computation. The only RPC that produces real numbers is
  `report_run_stub` (dev/test only). Real template RPCs land in
  REPORTS-2 (cogs) and REPORTS-3 (variance); the rest are deferred.
  *Rationale: the user explicitly asked for foundation-only in REPORTS-1.*
- Realtime subscription on `report_runs`. A second user clicking RUN
  will not push to other clients in REPORTS-1; they'll see the new run
  on their next reload. Adding realtime is a one-line change but
  requires the publication-add gotcha workflow and isn't blocking.
  *Rationale: not on the critical path for the user's stated complaint.*
- The `scheduled.tsx` and `custom.tsx` tabs in `ReportsSection`. They
  remain the existing "NOT YET WIRED" placeholders.
  *Rationale: scheduling needs `pg_cron` + recipient lists, custom-SQL
  needs a sandboxed exec edge function, both are large enough to warrant
  their own specs.*
- Custom-SQL edge function with sandboxed `EXECUTE`. Deferred until the
  `custom` template's spec.
- CSV / PDF export of a run's table. The existing PapaParse + jsPDF
  utilities make this trivial later but it's not part of the foundation
  the user asked for.
- A "Run history" list inside the detail view. The schema is append-only,
  so a future spec can list past runs; REPORTS-1 only displays the latest.
- Modifying the `addReportDefinition` action's `params` writeback. The
  modal still writes `params: {}`; date-range params come in REPORTS-2.
- Deleting / archiving past `report_runs` rows. No retention pruning.

## Open questions resolved

These are decisions the user delegated to defaults under auto-mode. Each is
called out so the architect / user can flip them with one line of feedback
before READY_FOR_BUILD.

- **Q1: `report_runs` retention — latest-only vs append-only history?**
  → **A: append-only history.** Every Run click writes a new row;
  the frontend reads the latest. Rationale: scheduled-runs UX (a later
  spec) needs a run log; throwing away history now would mean a second
  migration to add it back. Storage cost is low (one row per manual run,
  envelope is small JSON).
- **Q2: Re-run behavior on a definition with existing output?**
  → **A: append a new row, no prompt.** The detail view always
  displays the most recent. The user can press RUN as many times as they
  want; each press hits the RPC and persists. Rationale: matches Q1's
  append-only model and avoids a confirm dialog the user didn't ask for.
- **Q3: Routing surface for the detail view inside the Cmd UI?**
  → **A: in-section state.** `ReportsSection` owns a local
  `view: 'list' | 'detail'` plus `selectedDefinitionId`. Mirrors how
  `InventoryDesktopLayout` handles the items.tsv ↔ catalog.tsv ↔ EDIT
  drawer pattern via local state. Rejected alternatives: a separate Cmd
  sidebar section (clutters the sidebar with one entry per saved report),
  a URL hash route (no other section uses URL hashes today, would
  introduce a routing convention not yet in the codebase),
  React Navigation stack push (the Cmd shell uses palette-action state,
  not a stack — see [src/navigation/CmdNavigator.tsx:35-54](src/navigation/CmdNavigator.tsx)).
- **Q4: 4 deleted catalog ideas — preserve or drop?**
  → **A: preserved as future-proposal appendix in this spec.** Not
  rendered in the UI. The architect can choose to spin them off as their
  own specs later. See "Appendix A — Future template proposals" below.
- **Q5: Date-range UX in the detail frame?**
  → **A: read-only chip in REPORTS-1, no picker.** A picker is
  meaningless when no template uses the date yet. REPORTS-2 (COGS) is
  where the picker earns its keep — that spec adds it to both the modal
  (set at create time) and the detail header (override on a single run).

## Dependencies

- `public.auth_can_see_store(uuid)` from
  [supabase/migrations/20260504173035_per_store_rls_hardening.sql:31](supabase/migrations/20260504173035_per_store_rls_hardening.sql:31).
  Already live; this spec depends on it.
- `public.report_definitions` table from
  [supabase/migrations/20260503000001_report_definitions.sql](supabase/migrations/20260503000001_report_definitions.sql).
  This spec rewrites its RLS policies; the table itself stays.
- `public.profiles` and `public.stores` for FKs on `report_runs`.
- Frontend: `react-native-chart-kit` (already in package.json), the
  existing Cmd theme tokens, the existing `TabStrip` component.
- No new edge functions. No new third-party libraries.
- Subsequent specs that build on REPORTS-1:
  - **REPORTS-2** (COGS): adds `report_run_cogs` RPC, flips the `cogs`
    template's `status` to `'live'` in `templates.ts`, adds the date-range
    picker to the modal + detail header.
  - **REPORTS-3** (Variance): adds `report_run_variance` RPC, flips the
    `variance` template's `status` to `'live'`.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only — all new code in
  `src/screens/cmd/sections/`. The legacy `src/screens/AdminScreens.tsx`
  is not touched.
- **Per-store or admin-global:** per-store. RLS uses `auth_can_see_store`
  which already grants admins/super-admins cross-store visibility.
- **Realtime channels touched:** none in REPORTS-1. `report_definitions`
  and `report_runs` are not added to the realtime publication. (Future
  realtime add will require the publication-add + `docker restart
  supabase_realtime_imr-inventory` workflow per the project's realtime
  publication gotcha.)
- **Migrations needed:** yes — one new migration that (a) adds
  `report_runs`, (b) replaces permissive RLS on `report_definitions`,
  (c) adds the `report_run_stub` and `report_run` (dispatcher) functions.
- **Edge functions touched:** none. All backend logic is Postgres RPC.
  Auth is JWT-protected via PostgREST's default RPC handling (no
  service-token bearer).
- **Web/native scope:** both. Touch targets and modal sizes already
  work on phone via the responsive shell; the detail frame uses
  flex layout that degrades cleanly at narrow widths. No web-only API.
- **Tests:** there's no test framework wired up yet. Acceptance criteria
  are testable manually (RPC contract via psql, frame via the
  preview tools / browser). If the test-engineer wants a smoke script
  along the lines of `scripts/smoke-edge.sh`, that's a follow-up
  decision — REPORTS-1 doesn't introduce one.
- **`app.json` slug:** untouched. Not a build-identifier change.
- **Files explicitly NOT modified:**
  `src/store/useSupabaseStore.ts`, `src/store/useJsonServerSync.ts`,
  `db.json`, `src/screens/AdminScreens.tsx`, the `npm run db` script.

## Appendix A — Future template proposals (deferred from REPORTS-1 catalog)

The legacy hardcoded catalog had 8 tiles; the modal had 6 templates.
After dedup against the modal, 4 ideas were not in the modal and have no
RPC home. Preserved here as starting points for future template specs;
none are in scope for REPORTS-1/2/3.

| ID (proposed)        | Name                  | Description                          | Likely RPC                                   |
|----------------------|-----------------------|--------------------------------------|----------------------------------------------|
| `top_movers`         | Top movers            | Items by qty depleted (7d)           | EOD entries + waste log aggregated by item   |
| `recipe_profit`      | Recipe profitability  | Margin × volume                      | recipe cost × POS sales rollup               |
| `inventory_aging`    | Inventory aging       | Days on hand by category             | inventory_items + 7d/30d usage velocity      |
| `reorder_forecast`   | Reorder forecast      | Predicted needs (14d)                | velocity × current stock − pending POs       |

Each warrants its own spec because the underlying joins differ. They
share the same RPC contract / detail-frame contract REPORTS-1 establishes,
so adding one is "write the RPC, add the row to `templates.ts`".

## Appendix B — Uniform output envelope reference

For the architect / dev / reviewer who skims this section first: every
template RPC must return JSON in this exact shape. The detail frame
trusts the shape; the dispatcher does not deep-validate it.

```jsonc
{
  "kpis": [
    { "label": "Variance", "value": "-0.5%", "tone": "warn" }
  ],
  "columns": [
    { "key": "item",     "label": "Item",     "align": "left"  },
    { "key": "expected", "label": "Expected", "align": "right" },
    { "key": "counted",  "label": "Counted",  "align": "right" },
    { "key": "delta",    "label": "Δ",        "align": "right" }
  ],
  "rows": [
    { "item": "Salmon",  "expected": 12, "counted": 11, "delta": -1 }
  ],
  "series": [
    { "label": "Variance %", "x": "2026-04-01", "y": -0.4 }
  ]
}
```

For not-yet-implemented templates, the dispatcher returns:

```jsonc
{
  "kpis":    [],
  "columns": [],
  "rows":    [],
  "series":  null,
  "_status": "not_implemented",
  "_message": "Runner coming soon · definition saved"
}
```

The `_status` and `_message` keys are envelope metadata; the frame
checks `_status === 'not_implemented'` to render the placeholder branch.

## Backend Architecture

This design covers the foundation only. Per-template RPCs (`report_run_cogs`,
`report_run_variance`) and date-range params land in REPORTS-2 / REPORTS-3.

### Open-question resolutions — confirmed before READY_FOR_BUILD

All five PM defaults are confirmed. Notes on the load-bearing ones:

- **Q1 (append-only history) is correct.** The two indexes asked for in the
  AC line up with the read patterns:
  - `(definition_id, ran_at desc)` covers `fetchLatestRun({ definitionId })`
    via `... where definition_id = $1 order by ran_at desc limit 1`. PostgREST
    will use the index for the ORDER BY because the leading column is an
    equality match.
  - `(store_id, template_id, ran_at desc)` covers `fetchLatestRun({ templateId,
    storeId })` for the ad-hoc / no-saved-definition branch
    (`definition_id is null`). Same shape: equality on the two leading columns,
    ORDER BY on the trailing.

  No btree change needed.

- **Q-dispatcher (NEW — flagged in this design).** Spec lines 119–121 say
  `db.runReport` writes the `report_runs` row from the client *after* the RPC
  returns. **I am recommending we KEEP the spec's design (client writes the
  row) for REPORTS-1**, but flag two real failure modes so reviewers don't
  treat them as drift later:

  1. **Two-tab race.** Tab A and Tab B both press RUN at second `t=0`. Both
     RPCs succeed; both inserts succeed; the table now has two rows whose
     `ran_at` differ by milliseconds. `fetchLatestRun` picks one, the other is
     history. This is fine — append-only is the chosen model and the user
     gets *one* most-recent row from the read path.
  2. **RPC-then-insert failure window.** RPC returns ok. Network drops before
     the insert. The user paid the compute cost but no row exists. The frame
     shows the previous run (or "No runs yet"). On retry the next RPC runs
     again — idempotent for REPORTS-1 since `report_run_stub` is pure and
     REPORTS-2/3 RPCs read-only. Acceptable.

  **Trade-off vs server-side write.** A "dispatcher writes the row itself
  inside a single RPC call" design closes both gaps but requires:
    - the dispatcher to be `security definer` (so it can INSERT under the
      caller's identity without going through PostgREST RLS twice), OR
    - a `security invoker` dispatcher that performs the INSERT and trusts
      `report_runs` RLS to gate by `auth_can_see_store(store_id)`.

  The second variant is cleaner (no SD escalation) and would be my preference
  *if* we needed atomicity. We don't — the user explicitly asked for
  foundation only and the spec's two-step design is observable from the
  client. **Do not change this in REPORTS-1.** REPORTS-2 should reconsider
  if COGS RPC starts taking >1s and the failure window widens.

- **Per-template RPC contract.** Confirmed sound:
  - `security invoker`, `set search_path = public` — yes; `auth.uid()` and
    `auth.jwt()` resolve to the caller because RLS is the gate, not a
    SECURITY DEFINER bypass.
  - returning `jsonb` (not `setof record`) — yes; PostgREST returns it as a
    single JSON object to the caller. `setof record` would require column
    typing on the supabase-js side, which is friction we don't need.
  - granted to `authenticated` — yes; `anon` must NOT be granted (RPCs
    leak data via the JWT-derived `auth_can_see_store` check; an unauthed
    caller would see nothing today but we should not rely on that).
  - calling `auth_can_see_store(p_store_id)` and raising on false — yes;
    use `raise exception 'Not authorized for store %', p_store_id using errcode = '42501';`
    so the frontend gets a `403`-shaped PostgREST error that
    `notifyBackendError` can surface.
  - never `security definer` — yes. The helper `auth_can_see_store` is
    already SD; the runner stays invoker.

- **Realtime publication.** Confirmed: REPORTS-1 does NOT add `report_runs`
  to `supabase_realtime`. Second-tab-doesn't-update is acceptable per the
  spec's "Out of scope" section. **No `docker restart
  supabase_realtime_imr-inventory` step is required** for this migration —
  this is the safe outcome of intentionally skipping the publication add.

### Postgres schema — migration

**File:** `supabase/migrations/20260510120000_report_runs.sql` (additive +
RLS replace; safe to roll back by dropping the new objects and re-creating
the old permissive policy).

Migration structure (full SQL is the developer's job; this is the contract):

1. **Header comment** documents the per-template RPC convention exactly as
   in spec lines 61–92 — signature, return shape, security model. New
   per-template runners introduced in REPORTS-2 and beyond MUST match.

2. **Create `public.report_runs`** with the schema in AC line 27–38 plus a
   `created_at`-style trigger (we already have `update_updated_at()` in
   the codebase but `report_runs` is append-only so no `updated_at` trigger
   is needed; status flips are explicit `update`s from the client).

3. **Indexes** — exactly the two from AC line 39:
   - `report_runs_definition_ran_at_idx (definition_id, ran_at desc)`
   - `report_runs_store_template_ran_at_idx (store_id, template_id, ran_at desc)`

4. **Enable RLS + policies on `report_runs`** — four policies, all gating
   on `auth_can_see_store(store_id)`. Update is included so the frontend
   can flip `pending → ok|error` (per AC line 59).

5. **Drop + replace permissive policy on `public.report_definitions`.**
   Mirror `per_store_rls_hardening.sql:46-61` shape exactly. Four new
   policies. The existing `id`/`created_at`/etc. columns are unchanged —
   this is purely an RLS swap.

6. **Create `public.report_run_stub(p_store_id uuid, p_params jsonb)
   returns jsonb`** — the dev/test stub envelope. `security invoker`,
   `set search_path = public`, granted to `authenticated`, gated by
   `auth_can_see_store`.

7. **Create `public.report_run(p_template_id text, p_store_id uuid,
   p_params jsonb) returns jsonb`** — the dispatcher. `security invoker`,
   `set search_path = public`, granted to `authenticated`, gated by
   `auth_can_see_store`. `case` on `p_template_id`: `'stub'` →
   `report_run_stub(p_store_id, p_params)`, anything else → the
   not-implemented envelope.

#### `report_runs` table shape

```sql
create table public.report_runs (
  id              uuid primary key default gen_random_uuid(),
  definition_id   uuid null references public.report_definitions(id) on delete cascade,
  template_id     text not null,
  store_id        uuid not null references public.stores(id) on delete cascade,
  params          jsonb not null default '{}'::jsonb,
  output          jsonb null,
  status          text not null default 'pending'
                    check (status in ('pending','ok','error')),
  error_message   text null,
  ran_at          timestamptz not null default now(),
  ran_by          uuid null references public.profiles(id)
);

create index report_runs_definition_ran_at_idx
  on public.report_runs(definition_id, ran_at desc)
  where definition_id is not null;

create index report_runs_store_template_ran_at_idx
  on public.report_runs(store_id, template_id, ran_at desc);

alter table public.report_runs enable row level security;
```

The partial index on `(definition_id, ran_at desc) where definition_id is
not null` is a small refinement on the spec — keeps the index tight by
excluding ad-hoc rows (those use the second index). Acceptable to drop
the `where` clause if the developer prefers spec-literal; trade-off is
trivial at the seed-dataset scale.

#### Why `definition_id is nullable` + RPC-enforced consistency

AC line 40–43 says `definition_id` is nullable so REPORTS-2/3 can run
templates without a saved definition (ad-hoc). When non-null, `store_id`
and `template_id` MUST match the parent definition. This is enforced **in
the client `db.runReport` and the eventual RPC variant** — we do *not*
add a CHECK constraint or trigger because the cost is minor (the
definition is already in scope on the client) and a CHECK with a
subquery ties row visibility to RLS in subtle ways. Future hardening:
add a deferrable trigger if this becomes a recurring drift class.

### RLS policies — full SQL

#### `report_runs` (new)

```sql
create policy "store_member_read_report_runs"
  on public.report_runs for select
  using (public.auth_can_see_store(store_id));

create policy "store_member_insert_report_runs"
  on public.report_runs for insert
  with check (public.auth_can_see_store(store_id));

create policy "store_member_update_report_runs"
  on public.report_runs for update
  using (public.auth_can_see_store(store_id))
  with check (public.auth_can_see_store(store_id));

create policy "store_member_delete_report_runs"
  on public.report_runs for delete
  using (public.auth_can_see_store(store_id));
```

#### `report_definitions` (replace permissive)

```sql
drop policy if exists "authenticated can do anything"
  on public.report_definitions;

create policy "store_member_read_report_definitions"
  on public.report_definitions for select
  using (public.auth_can_see_store(store_id));

create policy "store_member_insert_report_definitions"
  on public.report_definitions for insert
  with check (public.auth_can_see_store(store_id));

create policy "store_member_update_report_definitions"
  on public.report_definitions for update
  using (public.auth_can_see_store(store_id))
  with check (public.auth_can_see_store(store_id));

create policy "store_member_delete_report_definitions"
  on public.report_definitions for delete
  using (public.auth_can_see_store(store_id));
```

These mirror `per_store_rls_hardening.sql:46-61` byte-for-byte. Cross-store
visibility for `super_admin` / `admin` / `master` is preserved because
`auth_can_see_store` already short-circuits to `auth_is_admin()`.

**Pre-flight check the developer must run** before applying the migration:
the seed has rows in `report_definitions` from earlier dev work. After the
RLS swap, those rows must remain visible to `auth_can_see_store(store_id)`
callers — e.g. an admin signed in as `admin@local.test` should still see
their saved reports. If any seed row has a `store_id` that no `user_stores`
row covers AND the caller is not admin, that row goes invisible. This is
correct behavior, but the dev should verify with a `select count(*) from
report_definitions` as both an admin and a non-admin to confirm the
hardening works.

### RPC contracts — full SQL

#### `report_run_stub` — REPORTS-1 only, dev/test

```sql
create or replace function public.report_run_stub(
  p_store_id uuid,
  p_params   jsonb
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

  return jsonb_build_object(
    'kpis', jsonb_build_array(
      jsonb_build_object('label', 'Stub KPI', 'value', '42', 'tone', 'ok')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'item',  'label', 'Item',  'align', 'left'),
      jsonb_build_object('key', 'value', 'label', 'Value', 'align', 'right')
    ),
    'rows', jsonb_build_array(
      jsonb_build_object('item', 'Alpha', 'value', 12),
      jsonb_build_object('item', 'Beta',  'value', 30)
    ),
    'series', jsonb_build_array(
      jsonb_build_object('label', 'series-1', 'x', '2026-05-06', 'y', 10),
      jsonb_build_object('label', 'series-1', 'x', '2026-05-07', 'y', 12),
      jsonb_build_object('label', 'series-1', 'x', '2026-05-08', 'y',  9),
      jsonb_build_object('label', 'series-1', 'x', '2026-05-09', 'y', 14),
      jsonb_build_object('label', 'series-1', 'x', '2026-05-10', 'y', 11)
    )
  );
end;
$$;

grant execute on function public.report_run_stub(uuid, jsonb) to authenticated;
revoke execute on function public.report_run_stub(uuid, jsonb) from anon;
```

The function ignores `p_params` in REPORTS-1 — the parameter exists on
the signature so future stub callers can experiment with shape changes
without a signature break.

#### `report_run` — dispatcher

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
    when 'stub' then
      return public.report_run_stub(p_store_id, p_params);
    -- REPORTS-2 will add: when 'cogs' then return public.report_run_cogs(p_store_id, p_params);
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

grant execute on function public.report_run(text, uuid, jsonb) to authenticated;
revoke execute on function public.report_run(text, uuid, jsonb) from anon;
```

Two layers of `auth_can_see_store` — once in the dispatcher, once in the
inner runner. Redundant but cheap (the helper is `stable`) and means the
inner runner stays callable directly without losing the gate.

### `src/lib/db.ts` surface

Two new helpers, added near the existing report block at
[src/lib/db.ts:1551-1602](src/lib/db.ts:1551). Both follow the existing
`mapItem`-style snake_case → camelCase convention.

```ts
// New type — add to src/types/index.ts
export interface ReportRunOutput {
  kpis: Array<{ label: string; value: string | number; tone?: 'ok' | 'warn' | 'danger' | null }>;
  columns: Array<{ key: string; label: string; align?: 'left' | 'right' | null }>;
  rows: Array<Record<string, unknown>>;
  series: Array<{ label: string; x: string; y: number }> | null;
  _status?: 'not_implemented';
  _message?: string;
}

export interface ReportRun {
  id: string;
  definitionId: string | null;
  templateId: string;
  storeId: string;
  params: Record<string, unknown>;
  output: ReportRunOutput | null;
  status: 'pending' | 'ok' | 'error';
  errorMessage: string | null;
  ranAt: string;
  ranBy: string | null;
}

// New helpers — db.ts
export async function runReport(args: {
  definitionId?: string | null;
  templateId: string;
  storeId: string;
  params?: Record<string, unknown>;
  ranBy?: string | null;
}): Promise<ReportRun>;

export async function fetchLatestRun(args: {
  definitionId?: string | null;
  templateId?: string;
  storeId: string;
}): Promise<ReportRun | null>;
```

#### `runReport` semantics

1. Call `supabase.rpc('report_run', { p_template_id, p_store_id, p_params })`.
2. Inspect the returned envelope:
   - If `envelope._status === 'not_implemented'`, status is `'ok'` (the
     dispatcher is reporting a known not-implemented; this is not a runner
     error — the frame branches on `_status` separately).
   - If the RPC threw, status is `'error'` and `error_message` is the
     PostgrestError's `.message`. The envelope passed to `output` is still
     well-formed (empty arrays, null series) so the frame doesn't crash.
   - Otherwise `'ok'`.
3. Insert into `report_runs` (`definition_id`, `template_id`, `store_id`,
   `params`, `output`, `status`, `error_message`, `ran_by`). `ran_at`
   defaults to `now()` server-side.
4. Return the inserted row mapped to camelCase via a local `mapReportRunRow`.

The RPC failure path is important: if the *insert* fails (e.g. RLS
mismatch, DB unavailable), the helper THROWS. The store action catches and
calls `notifyBackendError('Run report', e)` per AC line 138. We do NOT
swallow the insert failure into the returned row — that would mask
silent data loss.

#### `fetchLatestRun` semantics

`select * from report_runs where ... order by ran_at desc limit 1`. Two
filter shapes:
- `definitionId` non-null: `where definition_id = $1`.
- `definitionId` null/undefined and `templateId` non-null: `where store_id
  = $store and template_id = $tpl and definition_id is null`. (The
  `is null` clause keeps ad-hoc reads from picking up someone else's
  saved-definition run that happens to share `(store, template)`.)

Returns null when no row exists — the frame interprets that as the "No
runs yet" empty state.

### `src/store/useStore.ts` slice

Add to `AppState` (in `src/types/index.ts`):

```ts
/**
 * Spec 016 — most-recent run per saved definition. Keyed by
 * `definitionId`. Full history stays in DB; the store holds only the
 * latest for the open detail view to render. Lazy-loaded by
 * `loadLatestRun(definitionId)` when a saved-report tile is opened —
 * NOT populated by `loadFromSupabase` to keep boot payload bounded.
 */
reportRuns: Record<string, ReportRun>;
```

Add to `StoreActions`:

```ts
/** Spec 016 — append a new run for `definitionId`. Optimistic-then-revert.
 *  Writes a `pending` row to reportRuns[definitionId] immediately, swaps
 *  to the resolved row on success, deletes the pending entry on error
 *  and routes through notifyBackendError('Run report', e). */
runReport: (definitionId: string) => void;

/** Spec 016 — pull the most recent run for `definitionId` from DB and
 *  hydrate reportRuns[definitionId]. No optimistic behavior; pure load.
 *  No-op if no row exists. */
loadLatestRun: (definitionId: string) => Promise<void>;
```

Action bodies follow the pattern at
[src/store/useStore.ts:1789-1818](src/store/useStore.ts:1789):

```ts
runReport: (definitionId) => {
  const def = (get().savedReports || []).find((r) => r.id === definitionId);
  if (!def) return;
  const tempId = `run-pending-${Date.now()}`;
  const optimistic: ReportRun = {
    id: tempId,
    definitionId,
    templateId: def.templateId,
    storeId: def.storeId,
    params: def.params || {},
    output: null,
    status: 'pending',
    errorMessage: null,
    ranAt: new Date().toISOString(),
    ranBy: get().currentUser?.id || null,
  };
  set((s) => ({ reportRuns: { ...(s.reportRuns || {}), [definitionId]: optimistic } }));

  db.runReport({
    definitionId,
    templateId: def.templateId,
    storeId: def.storeId,
    params: def.params || {},
    ranBy: get().currentUser?.id || null,
  })
    .then((saved) => {
      set((s) => ({ reportRuns: { ...(s.reportRuns || {}), [definitionId]: saved } }));
    })
    .catch((e: any) => {
      set((s) => {
        const next = { ...(s.reportRuns || {}) };
        delete next[definitionId];
        return { reportRuns: next };
      });
      notifyBackendError('Run report', e);
    });
},

loadLatestRun: async (definitionId) => {
  try {
    const row = await db.fetchLatestRun({ definitionId });
    if (row) {
      set((s) => ({ reportRuns: { ...(s.reportRuns || {}), [definitionId]: row } }));
    }
  } catch (e: any) {
    console.warn('[Supabase] loadLatestRun:', e?.message || e);
  }
},
```

Initial state: `reportRuns: {}`. No mutation in `loadFromSupabase` —
the slice is lazy.

### Realtime impact

**None.** `report_runs` is intentionally NOT added to the
`supabase_realtime` publication in this migration, so:

- A user clicking RUN in Tab A will not push the new row to Tab B. Tab B
  must reload (close + reopen the detail view, or refresh the app) to
  pick up the new row.
- This is acceptable per the spec's "Out of scope" section. REPORTS-2 or
  later may add the publication membership when the use case warrants.

**No deploy/dev step required.** The realtime publication-membership
gotcha (`docker restart supabase_realtime_imr-inventory` after `npm run
dev:db`) only fires when a migration adds a table to `supabase_realtime`.
This migration does not, so a normal `supabase db reset` is sufficient
for local testing.

If a future spec adds `report_runs` to the publication, that spec's
design section should call out the docker restart step explicitly.

### Frontend store impact

- New slice `reportRuns: Record<string, ReportRun>` (described above).
- New actions `runReport`, `loadLatestRun` (described above).
- Existing `addReportDefinition` / `deleteReportDefinition` actions
  unchanged — the RLS swap on `report_definitions` is server-side only;
  the `db.createReportDefinition` / `db.deleteReportDefinition` calls
  pass the same `store_id` they already do.
- `loadFromSupabase` unchanged. `report_runs` is lazy.
- Optimistic-then-revert via `notifyBackendError` applies to `runReport`.
  `loadLatestRun` is a pure read — no optimistic, no toast (a missing
  run is the empty-state case, not an error).

### Risks and trade-offs

1. **RLS swap can hide existing seed rows from non-admin staff.**
   `report_definitions` currently has a permissive policy. After the
   swap, any row whose `store_id` is not in the caller's `user_stores`
   becomes invisible (admins still see everything). This is the *correct*
   behavior but represents a visible diff at first login post-deploy.
   Mitigation: the seed was pulled from prod with admin-owned reports;
   in practice a manager only sees their own store's saved reports today
   (the UI already filters by `currentStore.id`) so the user-facing
   change is "filter happens at DB instead of in the client". No
   regression. **Dev verification: run `select count(*) from
   report_definitions` as `admin@local.test` AND a non-admin per-store
   user; admin sees all, non-admin sees only their store's rows.**

2. **Seed cardinality on `report_runs` is initially zero.** No seed data
   for this table; it grows as users press RUN. The two indexes are
   cheap; no perf concern at the 286 KB seed scale. If usage grows past
   ~10k rows per store, the partial index choice (or lack thereof) might
   matter; revisit in REPORTS-2's review.

3. **No CHECK constraint linking `(definition_id, store_id, template_id)`.**
   A row with `definition_id` set but `store_id` mismatching the parent
   definition's `store_id` would not be caught at DB write time. Mitigated
   by the client always reading the definition before calling
   `db.runReport`, and by the RPC's own `auth_can_see_store(p_store_id)`
   gate. Acceptable for REPORTS-1; revisit if a deferrable trigger is
   warranted in REPORTS-2.

4. **RPC double-gate adds one extra `auth_can_see_store` call per run.**
   The dispatcher checks first, then the inner runner checks again. The
   helper is `stable security definer` so PostgreSQL plan-caches it; the
   cost is a single user_stores lookup repeated twice. At the seed
   dataset's row counts, this is sub-millisecond. Trade-off accepted —
   keeps inner runners independently safe.

5. **Two-tab race produces two rows with near-identical `ran_at`.** Append
   only — both rows persist. The frame reads the most recent. Acceptable;
   call out for the test-engineer in case they want a smoke step.

6. **Migration ordering.** This migration depends on:
   - `auth_can_see_store(uuid)` from `20260504173035_per_store_rls_hardening.sql` — exists.
   - `report_definitions` from `20260503000001_report_definitions.sql` — exists.
   - `stores`, `profiles` — exist from init.

   The proposed timestamp `20260510120000` is after all dependencies. The
   developer must NOT timestamp earlier — that would land out of order
   relative to the CI-pending `db-migrations-applied.yml` workflow (per
   CLAUDE.md, manual verification is the current reality; verify with
   `supabase db reset` locally).

7. **Edge-function cold start** — N/A. No edge functions touched.

8. **`security invoker` and `auth.uid()` for `ran_by`.** The client passes
   `ran_by` as the current user id. The RPC does NOT set `ran_by` itself;
   the *insert* in `db.runReport` does. This means a misbehaving client
   could lie about `ran_by`. Acceptable for an admin-only app
   (`useRole.ts` returns `'admin'` for everyone; staff use a different
   app per CLAUDE.md). Worst case: an admin attributes a run to another
   admin. Not a security boundary that matters for the foundation.

### Summary of files the developer will touch

- **New:** `supabase/migrations/20260510120000_report_runs.sql`
- **Modified:** `src/types/index.ts` (add `ReportRun`, `ReportRunOutput`, extend `AppState` with `reportRuns`)
- **Modified:** `src/lib/db.ts` (add `runReport`, `fetchLatestRun`, `mapReportRunRow`)
- **Modified:** `src/store/useStore.ts` (add `reportRuns: {}` initial state and the two actions)

Frontend-only changes (template extraction, `ReportDetailFrame`,
`ReportsSection` view-state) are scoped per the AC and not enumerated
here — that's the frontend-developer's slice.

## Files changed

### Migrations
- `supabase/migrations/20260510120000_report_runs.sql` (new) — creates
  `report_runs` (table + 2 indexes + 4 RLS policies), replaces the
  permissive `"authenticated can do anything"` policy on
  `report_definitions` with the four `auth_can_see_store(store_id)`
  policies, and creates `report_run_stub` + `report_run` (dispatcher)
  RPCs. Header comment documents the per-template RPC convention for
  REPORTS-2/3 to follow.

### TypeScript types
- `src/types/index.ts` — adds `ReportRun` and `ReportRunOutput`
  interfaces; extends `AppState` with `reportRuns: Record<string,
  ReportRun>`.

### Data layer
- `src/lib/db.ts` — adds `runReport`, `fetchLatestRun`, and the local
  `mapReportRunRow` helper in a new `REPORT RUNS` section beneath the
  existing `REPORT DEFINITIONS` block. `fetchLatestRun` makes `storeId`
  optional (only required for the ad-hoc branch); the spec's
  pseudocode at line 870 calls it with just `definitionId`.

### Store
- `src/store/useStore.ts` — imports `ReportRun`; adds `reportRuns: {}`
  initial state; adds `runReport` (optimistic-then-revert via
  `notifyBackendError`) and `loadLatestRun` (lazy load, console.warn on
  error) actions. Action signatures appended to the `StoreActions`
  interface beneath the existing `addReportDefinition` /
  `deleteReportDefinition` block. No mutation in `loadFromSupabase` —
  runs are loaded lazily.

### Frontend
- `src/screens/cmd/sections/reports/templates.ts` (new) — single
  source of truth for the 6 templates with `{id, name, sub, cols, icon,
  status}` shape plus `findTemplate(id)` and `defaultReportName(template,
  now?)` helpers. `Template` interface re-exported by
  `NewReportModal.tsx` for back-compat with existing consumers.
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` (new) —
  generic, template-agnostic detail frame. Header (BACK · template id ·
  template name · RUN button), title row, scope/range/last-run chip
  strip, then a body that branches across `latestRun === null` (No runs
  yet), `status === 'error'` (RUN FAILED + RETRY), `_status ===
  'not_implemented'` (NOT YET WIRED placeholder), `running` /
  `status === 'pending'` (Running…), and the populated case (KPI strip,
  result table, optional SVG line chart). The chart is hand-rolled with
  `react-native-svg` to match the StockHistoryChart treatment used
  elsewhere — react-native-chart-kit was avoided to stay consistent
  with the rest of the codebase. Imports `ReportRun` and
  `ReportRunOutput` from `src/types/index.ts` (canonical types from
  backend-developer's slice); the prior local TODO definitions were
  removed after byte-for-byte verification against the canonical types.
- `src/components/cmd/NewReportModal.tsx` — accepts `initialTemplateId?`
  and `initialName?` props, sources `TEMPLATES` from `templates.ts`, and
  re-seeds local state on each open so a catalog-tile click picks up a
  fresh `initialTemplateId` instead of stale state.
- `src/screens/cmd/sections/ReportsSection.tsx` — full-body rewrite.
  Deletes the 8-element hardcoded `REPORTS` array and the local
  `ReportTile` interface. Catalog grid now derives from `TEMPLATES` (6
  tiles with PREVIEW badges, no fake numbers). Saved-report tiles are
  `TouchableOpacity` whose press opens an in-section detail view via
  `view: 'list' | 'detail'` local state plus `selectedDefinitionId`.
  Catalog-tile press opens `NewReportModal` pre-filled with that
  template's id and a `defaultReportName(template)` seed; the top-right
  `+ NEW REPORT` button still defaults to Variance (the historical
  default). Inline delete button on saved-report tiles uses
  `e.stopPropagation()` to avoid bubbling to the parent. Web-only
  `Escape` keydown handler closes the detail view; the explicit BACK
  button does the same on both platforms. `loadLatestRun` runs lazily
  in a `useEffect` on detail open. The `running` flag is tracked
  locally; `runReport` is fire-and-forget on the store side. The
  `scheduled.tsx` and `custom.tsx` placeholder branches are unchanged.

### Verification (not files, but recorded for the reviewers)
- `npx supabase db reset` applies the migration cleanly. Migration is
  idempotent — uses `if not exists` on the table/indexes and `drop
  policy if exists` before each `create policy`.
- `select * from pg_policies where tablename in ('report_definitions',
  'report_runs')` shows four policies on each, all gating on
  `auth_can_see_store(store_id)`.
- `select report_run('stub', '<store-uuid>', '{}')` as an authenticated
  admin returns the hand-rolled envelope; as a no-membership user
  raises `42501`. `select report_run('cogs', ...)` as an admin returns
  the `not_implemented` envelope.
- `insert into public.report_runs (...) values (..., '<store-i-cant-
  see>', ...)` as a no-membership user is denied by RLS;
  same insert for an in-membership store succeeds.
- Anon role cannot execute either RPC (`permission denied for
  function report_run`). The `revoke from public, anon` is required
  beyond the spec's `revoke from anon` — `anon` inherits from PUBLIC,
  so a bare `revoke from anon` is a no-op (mirrors
  `20260505065303_admin_rpcs_lock_anon.sql:24`). Header comment was
  updated to document this for REPORTS-2/3.
- `npx tsc --noEmit` shows no new errors in `types/index.ts`,
  `lib/db.ts`, or `store/useStore.ts`. The remaining errors in
  `useStore.ts` (`storeLoading`, `casePrice` etc.) are pre-existing
  and unrelated to this spec.
- `npx tsc --noEmit` after the frontend wiring shows no new errors
  attributable to `ReportsSection.tsx`, `ReportDetailFrame.tsx`,
  `templates.ts`, or `NewReportModal.tsx`. Pre-existing errors in
  legacy AdminScreens, AppNavigator, and EODCountScreen are
  untouched.
- Web bundle from `expo start --web` (port 8081) compiles cleanly and
  includes the new modules (`ReportsSection`, `ReportDetailFrame`,
  `reports/templates`) — no `Unable to resolve module` errors in the
  served bundle. **Interactive browser preview tools were not available
  in this implementation environment**, so the catalog-render / tile-
  click / detail / Escape / delete-stop-propagation flows were not
  exercised end-to-end against the live page; reviewers should
  re-verify in browser via `preview_*` if their environment provides
  the tools (the user's spec calls out the same).

### FIXES_NEEDED follow-up patch (round 2)

The first round of reviews returned FIXES_NEEDED:
`specs/016-reports-runner-foundation/reviews/release-proposal.md` and the
underlying `security-auditor.md`. This patch closes the Critical and the
two High items per the architect's preferred Path A (minimal-diff).

#### New migration

- `supabase/migrations/20260510130000_report_runs_consistency.sql` (new)
  — adds the BEFORE INSERT/UPDATE trigger
  `report_runs_check_definition_consistency_trg` on `public.report_runs`
  asserting that when `definition_id` is non-null, the row's
  `(store_id, template_id)` matches the parent `report_definitions`
  row exactly. Raises `42501` with message
  `'report_runs row inconsistent with parent definition'` so the
  dispatcher and trigger speak the same SQLSTATE class. Trigger
  function `public.report_runs_check_definition_consistency()` is
  `security invoker`, `set search_path = public`. Also sets
  `default auth.uid()` on `report_runs.ran_by` so the server canonical-
  populates the column instead of trusting client input. Closes
  security-auditor's Critical and High #1 in one migration.

#### Data layer

- `src/lib/db.ts` — `runReport` no longer sends `ran_by` in the INSERT
  (the column's `default auth.uid()` populates it server-side); the
  inline arg type drops `ranBy?` to make the new contract explicit.
  Error sanitization: `rpcError.message` now passes through verbatim
  only when it starts with `'Not authorized'` (the intentional
  dispatcher raise); any other error class is replaced with the generic
  copy `'Run failed — check server logs'` and the raw `rpcError`
  object is `console.warn`-logged so devs can still debug. Closes
  security-auditor's High #2.

#### Store

- `src/store/useStore.ts` — `runReport` now snapshots `prev` before the
  optimistic write and restores it on catch (mirror of the
  `deleteReportDefinition` pattern). The `ranBy` field is dropped from
  the `db.runReport` call (only kept on the optimistic display row,
  derived from `currentUser?.id`). Closes code-reviewer Should-fix #4.

#### Frontend

- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` — RUN-button
  text color flips to `C.accentFg` (was `'#000'`); `definition.params`
  range read via the typed `Record<string, unknown>` lookup (no
  `as any` cast). Closes code-reviewer Should-fix #5 and #7.
- `src/screens/cmd/sections/ReportsSection.tsx` — `+ NEW REPORT` button
  text color flips to `C.accentFg` (was `'#000'`). Closes code-reviewer
  Should-fix #6.

#### Verification (round 2)

- `npx supabase db reset` applies the new migration cleanly.
- `select tgname from pg_trigger where tgrelid = 'public.report_runs'::regclass`
  shows `report_runs_check_definition_consistency_trg` installed.
- `column_default` on `report_runs.ran_by` is `auth.uid()`.
- Security-auditor's exact Critical reproduction (the auditor's
  transcript at `reviews/security-auditor.md:30-64`) was re-run against
  the post-fix DB:
  - Pre-fix: `INSERT 0 1` (the spoof succeeded).
  - Post-fix: `ERROR: 42501: report_runs row inconsistent with parent definition`
    raised by the trigger; the row is rejected.
- Equivalent attack via PostgREST returns HTTP 403 with the same
  SQLSTATE. UPDATE-path spoof (re-pointing an existing legit row's
  `definition_id` to a foreign definition) is also blocked by the
  trigger.
- Legit flow still works:
  - Dispatcher RPC `report_run('variance', <store>, '{}')` returns the
    `not_implemented` envelope.
  - Stub RPC `report_run('stub', <store>, '{}')` returns the
    hand-rolled envelope unchanged.
  - INSERT into `report_runs` without specifying `ran_by` returns a row
    whose `ran_by = auth.uid()` (the JWT's `sub`).
- `npx tsc --noEmit` shows no new errors in `lib/db.ts`,
  `store/useStore.ts`, `ReportDetailFrame.tsx`, or `ReportsSection.tsx`.
  The pre-existing errors elsewhere in `useStore.ts` (`storeLoading`,
  `casePrice` etc.) are unchanged.
- Expo web bundle compiles (12.2 MB, no `UnableToResolveError`); the
  bundle includes the new sanitized error string and the `accentFg`
  references. **Interactive browser-preview MCP tools were not
  available in this implementation environment**, so the visual
  contrast check (RUN button + `+ NEW REPORT` text in light/dark) was
  not exercised in-browser; reviewers should re-verify if their
  environment provides those tools.

### Round-3 carry-over fix (`ran_by` forgery via explicit body field)

Round-2 audit found that the column-level `default auth.uid()` only
fires when the client OMITS `ran_by` — a hand-crafted PostgREST request
that names `ran_by` in its body could still forge the value. Closed
by extending the existing consistency trigger function with
`new.ran_by := auth.uid()` at the top of the function body so the
override fires regardless of whether the client supplied a value.

- `supabase/migrations/20260510130000_report_runs_consistency.sql`
  (edited in place; not yet committed) — trigger function
  `public.report_runs_check_definition_consistency()` now begins
  with `new.ran_by := auth.uid()`. Header comment updated to document
  the override and its `auth.uid()` NULL semantics for future
  service-role callers.
- Verified live against the local DB: a forged `ran_by` of
  `99999999-9999-9999-9999-999999999999` is replaced with the JWT
  `sub`'s actual UUID before the row lands; the cross-store INSERT spoof
  block still fires (`42501 report_runs row inconsistent with parent
  definition`).

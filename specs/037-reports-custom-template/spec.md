# Spec 037: Reports — Custom SQL template

Status: READY_FOR_REVIEW

## User story

As a privileged store manager (admin), I want to run a "Custom SQL" report
that lets me paste my own read-only SELECT against `public.*` tables and
render the result in the standard report envelope, so I can answer one-off
analytical questions that no built-in template covers — without waiting on
engineering to ship a new RPC.

The audience is small (operators of the 2AM PROJECT brand), the caller is
already gated by `auth_is_admin()` / `auth_can_see_store()`, and the
alternative is shipping a multi-week visual query-builder UI. The PM
accepts the residual blast radius in exchange for the time saved, on the
condition that the sandbox in §A2 below is airtight by construction.

## Acceptance criteria

### Backend — `public.report_run_custom(uuid, jsonb) returns jsonb`

- [ ] A new migration `supabase/migrations/<timestamp>_report_run_custom.sql`
  creates the function with signature
  `(p_store_id uuid, p_params jsonb) returns jsonb`,
  `language plpgsql`, `security invoker`,
  `set search_path = public`. Matches the spec 036 velocity runner's
  security shape byte-for-byte.
- [ ] First statement raises SQLSTATE `42501` if
  `public.auth_can_see_store(p_store_id)` returns false. Mirrors
  `report_run_velocity.sql` / `report_run_vendor.sql` / `report_run_waste.sql`
  / `report_run_variance.sql` / `report_run_cogs.sql`.
- [ ] **Second statement raises SQLSTATE `42501` if
  `public.auth_is_privileged()` returns false.** This is the spec-037-
  specific additional gate — custom SQL execution requires admin-or-
  super_admin privilege beyond the standard per-store visibility check.
  Plain `'user'`-role members of the store CANNOT run custom SQL.
  Reviewers comparing to the other five runners: do NOT remove this
  second gate; spec 036 / velocity does not need it because velocity is
  pre-canned aggregation. Custom is execute-arbitrary-SQL — privileged.
  Error message: `'Custom SQL requires admin privilege'` (caller-safe
  shape, never includes the SQL text or schema details).
- [ ] Same migration re-creates the dispatcher
  `public.report_run(text, uuid, jsonb)` with a new `when 'custom' then
  return public.report_run_custom(p_store_id, p_params)` arm, preserving
  the existing `'stub'`, `'cogs'`, `'variance'`, `'waste'`, `'vendor'`,
  `'velocity'` arms and the `not_implemented` fallback exactly as in
  `20260515120000_report_run_velocity.sql:444-486`. The arm slots
  immediately after `when 'velocity'` (placement convention: live arms
  in the order their templates landed).
- [ ] Grants: `revoke execute on function public.report_run_custom(uuid,
  jsonb) from public, anon; grant execute on function
  public.report_run_custom(uuid, jsonb) to authenticated;` — matches the
  spec 016 convention and the `reports_anon_revoke.test.sql` lockdown.
  Privilege check happens INSIDE the function body (see prior bullet),
  not via per-role grants — keeps the dispatcher grant uniform across
  all six template runners.
- [ ] Parameters accepted in `p_params`:
  - `sql` (string, required) — the user's SELECT. **No placeholder
    substitution.** Tokens like `:store_id` or `$1` are NOT recognized;
    the SQL string is passed to the executor verbatim. Rationale: any
    substitution layer is an injection-attack surface we don't need
    when RLS already filters output. The user's SELECT references
    `public.<table>` directly and RLS does its job.
  - `series_n` — **NOT accepted in v1.** Series is always `[]`. The
    custom SQL's output columns determine `columns`/`rows`; the user
    cannot specify which output column is a time series. Surfacing
    this as a separate spec is in §Out of scope.
  - Unknown keys ignored (forward-compat per the COGS / waste / vendor
    / velocity pattern).
- [ ] **Empty / missing `sql` parameter**: raises SQLSTATE `22023` with
  message `'Custom SQL: sql parameter required'`. Whitespace-only also
  fails (`trim(coalesce(p_params->>'sql', '')) = ''`).
- [ ] **Sandboxing — five hard guards**. The function MUST enforce ALL
  FIVE. The architect's design doc names the order they fire in (the
  exact placement of each `SET LOCAL` is the architect's call); the AC
  pins the guarantees:

  1. **SELECT-only via `transaction_read_only`**. Inside the function,
     the body issues `SET LOCAL transaction_read_only = on;` BEFORE the
     `EXECUTE`. Any `INSERT/UPDATE/DELETE/TRUNCATE/COPY/DDL` inside the
     user SQL fails with Postgres's native
     `25006 "read-only SQL transaction"` error. We do NOT lexically
     parse the SQL — Postgres's own read-only flag is the canonical
     enforcement and cannot be bypassed by clever string-mangling.
     Caught error is re-raised with a sanitized message (see error
     handling below).

  2. **Per-statement timeout**. `SET LOCAL statement_timeout = '5s';`
     BEFORE the `EXECUTE`. Caller-facing timeout — the runner gives the
     user 5 seconds of compute. SQLSTATE `57014` (query canceled) is
     caught and re-raised as `'Custom SQL: timed out after 5s'`.
     Architect chooses where the timeout lands (function-local vs
     statement-level); 5s is the AC ceiling.

  3. **Result-row cap**. The user SQL is wrapped in
     `SELECT * FROM (<user_sql>) _spec037_custom_outer LIMIT 1001` before
     `EXECUTE`. If `LIMIT 1001` returns 1001 rows, the 1001st is
     discarded and an inline `_truncated: true` marker rides in the
     envelope (see envelope shape below). The user sees their first
     1000 rows plus an explicit "result was truncated" indicator.
     Rationale for 1000: matches PostgREST's default `per_page`
     ceiling and keeps the persisted `report_runs.output` jsonb under
     1 MB for typical schemas.

  4. **RLS enforced via `security invoker`**. The function is declared
     `security invoker` (matching all other template runners). The
     user's SELECT runs under the caller's UID; every `public.*` table
     with RLS enabled filters by `auth.uid()` and `auth_can_see_store()`
     automatically. Reviewers: do NOT switch this to `security definer`
     — that would expose every cross-store row to any admin who can
     write SQL. The `auth_is_privileged()` check above gates ACCESS to
     the runner; RLS gates WHAT the runner can see.

  5. **No `pg_*`, `auth.*`, `information_schema.*` reads**. Implemented
     by `revoke select on all tables in schema auth from authenticated;`
     (already in place — see `init_schema.sql`) and Postgres's
     default-deny on `pg_*` for non-superusers. A user's SELECT against
     `auth.users` returns `42501 "permission denied for table users"`,
     which is caught and re-raised as
     `'Custom SQL: access denied to non-public schema'`. The function
     does NOT lexically reject `auth.` or `pg_` substrings — Postgres's
     own permission system is the gate. Header MUST document why the
     two-layer defense (no lexical filter) was chosen over a regex
     blacklist (regex never catches all bypasses; permissions are
     ground truth).

- [ ] **Error handling — sanitization wall**. The runner catches every
  exception class with `EXCEPTION WHEN OTHERS THEN` and re-raises with
  a **sanitized** message that conveys the failure class without
  leaking schema, row contents, or SQL fragments. Specifically:
  - `25006 read_only_sql_transaction` → re-raise as
    `'Custom SQL: only SELECT statements are allowed'`.
  - `57014 query_canceled` → re-raise as
    `'Custom SQL: timed out after 5s'`.
  - `42501 insufficient_privilege` → re-raise as
    `'Custom SQL: access denied to non-public schema'`.
  - `42P01 undefined_table` → re-raise as
    `'Custom SQL: table not found (check the table name)'`.
  - `42703 undefined_column` → re-raise as
    `'Custom SQL: column not found (check the column name)'`.
  - `42601 syntax_error` → re-raise as
    `'Custom SQL: syntax error (check the query)'`.
  - All other classes → re-raise as
    `'Custom SQL: run failed — check the server logs'`. The full
    `SQLERRM` is logged via `RAISE LOG` with the function name +
    error class so the operator can debug from `supabase logs` while
    the caller sees only the generic message.

  Reviewers: do NOT pass the raw `SQLERRM` through to the caller. The
  spec 028 escapeHtml shape is the analogue here — every interpolated
  diagnostic value the user sees must come from a fixed-string set
  that the spec pins; we do not concatenate user-controlled text into
  the user-visible error.

- [ ] **Empty-result short-circuit**: when the user SQL returns 0 rows,
  return populated `columns` (derived from the SELECT's output
  descriptors) + empty `kpis`/`rows`/`series`. (`[]` not null for the
  array shapes; the series stays `[]` not `null` per the spec 016
  contract.) The custom runner's empty-result shape diverges from
  velocity/vendor/waste only in that `kpis` is `[]` rather than
  populated-but-zero — custom has no canonical KPI set.

- [ ] **Envelope shape returned** (matches the spec 016 uniform envelope):
  ```json
  {
    "kpis":    [],
    "columns": [ { "key": "<col>", "label": "<col>", "align": null } ],
    "rows":    [ { "<col>": "<value>", ... } ],
    "series":  [],
    "_truncated": <bool>,
    "_row_count": <int>
  }
  ```
  - `kpis`: **ALWAYS empty array**. Custom SQL has no canonical KPI
    contract; the user's SELECT decides the shape of `columns`/`rows`
    only.
  - `columns`: derived from the user SELECT's output column descriptors
    via `EXECUTE ... INTO` with a record variable + `pg_typeof()`. Each
    column's `key` and `label` are the raw output-column name as
    Postgres sees it (no normalization, no quoting — operators who
    write `SELECT count(*)` see `count` as the column label; that's
    expected). `align` is `null` always (the frame falls back to
    left-align); the runner does not infer numeric vs string alignment
    because column types from EXECUTE-derived dynamic SQL are
    unreliable on COALESCE/CASE/CAST results.
  - `rows`: array of objects keyed by the SELECT's output column
    names. Up to 1000 rows. Values are serialized via `to_jsonb()`
    (Postgres native — integers as numbers, decimals as numbers,
    text as strings, dates as ISO strings, etc.). No server-side
    formatting (the other runners' `to_char('FM999,999,990.00')`
    pattern does NOT apply here because we don't know which columns
    are currency).
  - `series`: **ALWAYS empty array** in v1. Out of scope to infer a
    time-series shape from arbitrary SQL.
  - `_truncated`: `true` when the wrapped query returned 1001 rows
    (meaning the underlying query produced ≥ 1001 rows and we
    truncated). `false` otherwise. The frame renders an inline
    "result was truncated to 1000 rows" hint when this is set.
  - `_row_count`: actual row count returned (after truncation). Lets
    the frame show "1000 rows" / "47 rows" in the table header without
    a second `.length` read.

- [ ] **No KPI tone bands.** All metadata signals (`_truncated`,
  `_row_count`) ride in their own keys; no `kpis[]` entries are
  emitted. The detail frame's `KpiStrip` renders nothing when `kpis`
  is empty.

- [ ] **No prep-recipe / recursive CTE.** Custom SQL is by definition
  user-authored — the runner does not add joins, CTEs, or
  rewrites. Migration header explicitly notes the absence so future
  contributors don't add "helpful" join-helpers out of pattern-mimicry.

- [ ] **Index reuse.** The runner is a thin sandbox around `EXECUTE`;
  the user's SQL drives whatever scans the planner chooses. No new
  index in this migration.

### Backend — Dispatcher arm

- [ ] The dispatcher's new `when 'custom'` arm slots between `'velocity'`
  and the `not_implemented` fallback. The dispatcher's outer auth gate
  (raises 42501 if `auth_can_see_store(p_store_id)` is false) still
  fires before the arm body, mirroring the existing pattern. The
  custom runner's own internal privilege check (`auth_is_privileged()`)
  fires after dispatch — defense-in-depth.

### Frontend — `src/screens/cmd/sections/reports/templates.ts`

- [ ] Flip the `custom` template's `status: 'preview'` to `status: 'live'`.
- [ ] No other field changes on the row. The existing copy reads
  `name: 'Custom SQL'`, `sub: 'write your own'`,
  `cols: '-- SELECT … FROM inventory'` — accept as-is. Column copy is
  aspirational; the actual columns are derived per-run from the user's
  SELECT. Append one comment line above `TEMPLATES`:
  `// Spec 037 flipped 'custom' to 'live' (see
  '<timestamp>_report_run_custom.sql').`

### Frontend — `src/components/cmd/NewReportModal.tsx`

The modal's existing surface (date-range picker + by-toggle) is
**replaced for `template='custom'`** with a multiline SQL textarea.
Specifically:

- [ ] When `picked === 'custom'`:
  - **Hide** the preset chips strip (the `PRESETS` map).
  - **Hide** the `range` from/to date cells.
  - **Hide** the `by:` toggle.
  - **Show** a multiline SQL textarea (raw `<TextInput multiline>` —
    v1 does NOT pull in CodeMirror; that's a follow-up if the
    operator-feedback warrants it. See §Out of scope). The textarea:
    - is at least 8 rows tall (`numberOfLines={8}` on RN, `rows={8}`
      via web inline style),
    - uses `mono(500)` typography to match the SQL-editor look,
    - has a placeholder reading
      `'SELECT name, sum(amount) FROM public.po_items GROUP BY name LIMIT 100'`,
    - has its own state `sql: string` initialized to `''` on modal
      open and reset on each open (same shape as the date-range
      reset in the existing `visible-true` effect).
  - Show a small hint line below the textarea reading
    `'SELECT only · public.* tables · 5s timeout · max 1000 rows · RLS-filtered to your stores'`.
- [ ] **Save-time validation** for `picked === 'custom'`:
  - `sql.trim() === ''` → toast `'SQL required'`, do NOT save, return.
  - No client-side SQL parsing or keyword sniffing — the server is
    the authority. (Lexical client checks would create a false sense
    of security and would regress when Postgres adds new statement
    types.)
- [ ] **Save-time params shape** for `picked === 'custom'`:
  `{ sql: string }`. **NOT** `{ range, from, to, by, sql }` — the
  custom template has no range/by semantics, and storing those keys
  would just be noise in the saved-definition row.
- [ ] The existing `isVariance` branch and the non-variance default
  branch are not affected. Add an `isCustom` branch that gates the
  three above-hidden controls and the textarea — single boolean
  derived from `picked === 'custom'`.
- [ ] The keyboard handler (`useEffect` at lines ~298-314) handles
  `Enter`-creates as today. For `isCustom`, plain `Enter` MUST NOT
  fire `onCreate` while the user is typing in the multiline SQL
  textarea (newlines in SQL are meaningful). The existing `editing`
  guard skips when a date cell is in edit mode; add a parallel
  `sqlFocused` guard so `Enter` inside the textarea inserts a
  newline rather than creating. `Cmd-Enter` / `Ctrl-Enter` still
  creates.

### Frontend — `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`

- [ ] When `definition.templateId === 'custom'`:
  - **Hide** the `range:` chip (no date-range semantics).
  - **Hide** the `by:` chip (no group-key semantics).
  - **Hide** the `reset` link (no overrides apply to custom).
  - **Show** an inline read-only display of the saved SQL **above** the
    result table — a `<Text>` block in `mono(400)` styled like a code
    pre-block, with the saved SQL string. Mirror the existing chip-row
    metadata position (between header and body). Operators need to see
    "what was actually run" without going back to the modal.
  - Within `ResultBody`, when `output._truncated === true`, render a
    one-line inline hint **above** the `ResultTable` reading
    `'Result truncated to 1000 rows. Tighten the WHERE clause or add a LIMIT to see different rows.'`
    in `C.warn` color.
- [ ] **In-frame override behavior for custom**:
  - The detail-frame's `overrideRange` / `overrideBy` props are NOT
    passed for custom (mirrors how variance is gated — see line 273-277
    of `ReportsSection.tsx`).
  - The custom template does NOT get an in-frame SQL-editor for v1.
    Re-running with different SQL means going back to the modal and
    creating a new saved definition. Rationale: the modal's textarea
    already has the SQL-edit surface; duplicating it in the detail
    frame adds complexity for unclear value. A future "edit-in-place"
    surface is in §Out of scope.
  - The `RUN` button is enabled the same way as the other live
    templates (disabled while in-flight, enabled when not-implemented
    branch is NOT showing). Pressing RUN re-executes the saved SQL
    against the current data.
- [ ] **No widened union for `overrideBy`**. The `'reason' | 'vendor' |
  'recipe' | 'category' | 'item'` union in `OverrideState`,
  `setOverrideBy`, `overrideBy?` prop, `byOpts`, and the `savedBy`
  parser does NOT widen — custom has no `by:` axis. The chip is
  hidden entirely for custom; we don't synthesize a sentinel like
  `'sql'` into the union.

### Frontend — `src/screens/cmd/sections/ReportsSection.tsx`

- [ ] `selectedSupportsBy` already gates the `by:` chip (line 242 —
  excludes variance). Extend it to exclude custom:
  `selectedTemplate?.id !== 'variance' && selectedTemplate?.id !== 'custom'`.
- [ ] `selectedIsLive` (line 241) drives `overrideRange` /
  `onRangeChange` / `onResetOverrides` wiring. For custom, the
  detail-frame internally hides the range chip regardless (see frame
  AC above), but the explicit prop wiring should still be gated off
  so the `OverrideState` map never gets a stale `range` entry for a
  custom definition.
- [ ] **Catalog-tile click for custom** goes through the same
  `onCatalogTilePress(templateId)` path. No special-case wiring.
- [ ] **`ReportsCustomPlaceholder`** at lines 456-474 is the
  `custom.tsx` tab placeholder text. **Leave it as-is for v1.** The
  custom template lands on the library.tsx tab via the catalog grid,
  same as every other template. The `custom.tsx` tab is a separate
  surface (a query-builder placeholder) and is out of scope here.
  Surface this in §Out of scope so reviewers don't flag the
  redundant-feeling text as a regression.

### Tests

Per spec 022's three-track posture:

- [ ] **Track 2 (pgTAP)** — `supabase/tests/report_run_custom.test.sql`
  with `select plan(N)` covering at least:
  1. Fixture sanity (Frederick store id resolves).
  2. Auth gate (privileged member calling Charles → 42501; mirrors
     the velocity / vendor / waste test).
  3. **Privilege gate** (plain `'user'`-role member calling
     `report_run_custom` on their own store → 42501 with the
     `'Custom SQL requires admin privilege'` message). NEW assertion
     class not present in velocity/vendor/waste tests because no
     other runner adds a per-role gate beyond store visibility.
  4. **Empty `sql`** → 22023.
  5. **Read-only enforcement**: `INSERT INTO public.notes VALUES (...)`
     → 25006 caught and re-raised as
     `'Custom SQL: only SELECT statements are allowed'`.
  6. **Timeout enforcement**: `SELECT pg_sleep(10)` → 57014 caught and
     re-raised as `'Custom SQL: timed out after 5s'`. (Test runtime
     for this single case ≤ 6s, accepted as a one-off; the rest of
     the suite is sub-second.)
  7. **RLS enforcement**: an admin who is a member of Frederick
     calling `SELECT * FROM public.inventory_items WHERE store_id =
     '<charles-id>'::uuid` returns 0 rows (NOT the cross-store
     rows). Anchors the load-bearing "RLS, not lexical inject"
     posture from §A2.4.
  8. **Schema lockout**: `SELECT email FROM auth.users LIMIT 1`
     → 42501 caught and re-raised as
     `'Custom SQL: access denied to non-public schema'`.
  9. **Result truncation**: a query that returns ≥ 1001 rows produces
     an envelope with `_truncated: true` and `rows.length = 1000`.
     Stable across seed refreshes — use
     `SELECT generate_series(1, 2000)` for the row source so the test
     doesn't depend on seed cardinality.
  10. **Envelope shape**: sorted-key list of the top-level envelope
      keys includes `columns`, `kpis`, `rows`, `series`, `_truncated`,
      `_row_count`. Catches both missing AND extra keys (same shape
      as the existing `report_run_unknown_template.test.sql`).
  11. **Successful query**: `SELECT id, name FROM public.stores
      WHERE id = '<frederick-id>'` returns a single row with
      `id`/`name` keys. Anchors the happy path.
- [ ] **Track 1 (jest)** — one component test for the modal's custom
  branch:
  - File: `src/components/cmd/NewReportModal.test.tsx`. (Or, if the
    file does not yet exist, the architect chooses whether to create
    it or to colocate the test elsewhere.) The test must:
    1. Render the modal with `initialTemplateId='custom'`.
    2. Assert the SQL textarea is on screen.
    3. Assert the date-range chips are NOT on screen.
    4. Assert clicking `CREATE` with empty SQL toasts
       `'SQL required'` and does NOT call the store action.
    5. Assert clicking `CREATE` with non-empty SQL calls
       `addReportDefinition` with `params: { sql: '<value>' }` and
       no `range`/`from`/`to`/`by` keys.
  - Mock the `src/lib/db.ts` boundary per the existing test pattern.
- [ ] **Track 3 (shell smokes)** — NOT added for v1. The custom
  runner is reachable via the existing `scripts/smoke-rpc.sh` (which
  smokes the dispatcher with a stub template); adding a custom-SQL
  smoke would require a curated safe-SELECT fixture, which doesn't
  generalize across seed refreshes. Defer to a follow-up.
- [ ] **Track 1a / 1b typecheck gates** pass: `npm run typecheck` and
  `npm run typecheck:test` both exit 0 after the spec lands.

### Verification gates

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm run typecheck:test` exit 0
- [ ] `npm test -- --ci` PASS
- [ ] `npm run test:db` PASS — file count 18 → **19**
  (`supabase/tests/report_run_custom.test.sql` added)
- [ ] `npm run test:smoke` PASS (no new smoke; existing arms
  unaffected)
- [ ] Manual browser smoke:
  1. Open Reports → click the `custom` catalog tile → modal opens
     with SQL textarea (no PREVIEW badge on the tile).
  2. Type
     `SELECT name, count(*) FROM public.inventory_items GROUP BY name
     ORDER BY count(*) DESC LIMIT 10`
     into the textarea, name the report, press CREATE.
  3. The saved-report tile appears in "your reports".
  4. Click the saved tile, press RUN.
  5. Verify the result table renders with `name` and `count` columns
     and ≤ 10 rows.
  6. Verify the saved SQL appears above the result table.
  7. Edit the saved definition's SQL (via a fresh modal) to
     `INSERT INTO public.notes (body) VALUES ('hack')` and RUN.
     Verify the error toast reads
     `'Custom SQL: only SELECT statements are allowed'` and no row
     is inserted.

### Post-merge deploy

- [ ] `npx supabase db push --linked --yes` — applies the new
  migration. Same deploy shape as specs 034 / 035 / 036.
- [ ] No edge-function deploy needed (RPC-only — see §A1 below).

## In scope

- New Postgres function `public.report_run_custom(uuid, jsonb)` with the
  five-guard sandbox (read-only, timeout, row cap, RLS, schema lockout).
- Dispatcher arm in `public.report_run(text, uuid, jsonb)`.
- Per-role gate (`auth_is_privileged()`) inside the runner — first
  template that adds a privilege check beyond per-store visibility.
- `templates.ts` status flip `preview → live` for `custom`.
- `NewReportModal.tsx` SQL-textarea branch for `template='custom'`.
- `ReportDetailFrame.tsx` hide-chips + inline-saved-SQL + truncation-hint
  branch for `templateId='custom'`.
- `ReportsSection.tsx` `selectedSupportsBy` widening to exclude custom.
- pgTAP coverage for the eleven assertion classes named above.
- Jest coverage for the modal's custom-branch validation.

## Out of scope (explicitly)

- **CodeMirror / Monaco / IntelliSense / autocomplete.** The textarea
  is a raw `TextInput multiline` for v1. Adding a real SQL editor is a
  ~1-week spec on its own (dependency wrangling on RN-web,
  theme-token plumbing, web-only fallback for native). Defer until
  user feedback warrants it.
- **pgFormatter / pretty-printing.** Same rationale.
- **AI-suggested SQL.** Out of scope; would require a separate
  LLM-router edge function.
- **Saved-snippets library / query history.** The user can re-run a
  saved definition; the report_runs table already records every
  execution. A "snippet library" surface (browse other users' saved
  customs, fork them) is a follow-up.
- **In-frame SQL editor.** The detail frame shows the saved SQL but
  does not let the user edit it. To run different SQL, they make a
  new saved definition. Future spec may add edit-in-place.
- **Saved-definition param `kpis: [{ label, sql, tone }]`**. Lets the
  user specify "compute this KPI as a separate scalar SQL" alongside
  the main SELECT. Out of scope; would require a per-kpi sub-query
  shape that's a substantial new contract.
- **Saved-definition param `series: { sql, xCol, yCol, labelCol }`**.
  Same shape; lets the user specify a time-series side query. Out of
  scope; the v1 envelope's `series` is always `[]`.
- **`custom.tsx` tab in the Reports section**. The catalog tile is the
  v1 surface. The separate `custom.tsx` tab (currently a placeholder
  at lines 456-474 of `ReportsSection.tsx`) is intentionally untouched.
- **Query-result CSV / PDF export.** The standard report-results pipe
  (which doesn't have CSV/PDF export today either) covers it the same
  way other templates are covered.
- **Realtime publication for custom runs.** Custom runs share the same
  `report_runs` table as every other template; no new channel needed.
- **`p_params.placeholders` substitution**. Q3 rejects placeholder
  substitution as v1. Operators write store IDs / dates inline. RLS
  filters output to their stores anyway.
- **Wider grant — `master` role.** v1 gates on `auth_is_privileged()`
  which is `admin` OR `super_admin` per spec 027. If `master` should
  also have access, that's a follow-up.
- **Per-execution audit log row beyond `report_runs`**. The runner
  persists every execution to `report_runs` (existing infra). Adding
  a dedicated `custom_sql_audit` table is out of scope.
- **app.json slug change**. Per CLAUDE.md, `app.json` slug is load-
  bearing and not changed in this spec. (Surface for completeness;
  this spec doesn't touch identity at all.)

## Open questions resolved

The user listed the four candidate ambiguities at the bottom of the
context block. Per auto-mode posture and the user's lean-toward-the-
simpler-implementation guidance, the PM resolved them as follows:

- **Q1: Surface — free-text SQL editor or guided builder?**
  → **(a) Free-text SQL.** The user explicitly recommended this in
  the brief. Captured as the modal AC above. Document the residual
  risk in the migration header and in the §A2 sandbox description so
  the security reviewer can audit against the airtight-by-construction
  claim.

- **Q2: Execution surface — RPC vs edge function?**
  → **RPC.** The user explicitly recommended this in the brief. The
  RPC matches all five existing template runners' dispatcher pattern;
  Postgres `transaction_read_only`, `statement_timeout`, and RLS are
  built-in primitives we'd otherwise re-implement in Deno. The edge-
  function alternative is documented in §A1 below for the architect.

- **Q3: Sandboxing strategy — RLS vs lexical injection vs reject-if-no-
  store-ref?**
  → **(c) RLS.** The function is `security invoker`, the user's SELECT
  runs under their UID, and every `public.*` table has RLS gating by
  `auth.uid()` / `auth_can_see_store()`. No lexical SQL parsing
  anywhere — Postgres permissions are ground truth. Documented in
  AC §"Sandboxing — five hard guards" above.

- **Q4: SQL editor library choice — raw `<TextInput>` for v1 vs
  CodeMirror?**
  → **Raw `<TextInput multiline>` for v1.** Documented in §Out of
  scope. CodeMirror integration is a follow-up if operator feedback
  warrants it; raw TextInput keeps the dependency graph stable and
  the cross-platform (web + native) story trivial.

- **Implicit Q5: Should this spec be split into 037a (backend) +
  037b (frontend)?**
  → **No, ship as one spec.** The frontend touches a single modal
  branch and a single frame branch; both are smaller than the
  combined surface specs 034 / 035 / 036 each shipped (which each
  touched 3-4 frontend files). Splitting would just double the
  review cycles. If the architect, during the design pass, decides
  the surface is too large, they can recommend a split at that point.

- **Implicit Q6: Should the runner gate on `auth_is_privileged()`,
  not just `auth_can_see_store()`?**
  → **Yes — privileged-only.** Custom SQL execution against a live
  schema is a meaningful additional surface beyond pre-canned
  aggregation. The audience is small (admins-of-this-brand), and
  the gate matches the spec 026 / 027 broadening pattern that
  granted admins-and-super_admins parity for sensitive operations.
  Plain `'user'` members of a store cannot run custom SQL. This is
  the first template runner with a per-role gate beyond store
  visibility — the architect should call this out in the design doc
  so future template-runner specs don't blindly copy the AC into a
  pre-canned runner that doesn't need the gate.

## Dependencies

- Spec 016 (REPORTS-1) — report_definitions / report_runs tables, the
  dispatcher RPC contract, the envelope shape pinned by
  `ReportRunOutput` in `src/types/index.ts:546-561`.
- Spec 027 (admin-role parity) — `auth_is_privileged()` is the
  privilege predicate used in the new gate. Confirmed via
  `auth_is_admin()` and `auth_is_super_admin()` SQL helpers from spec
  026.
- Spec 028 (HTML-escape pattern) — analogue for the sanitization wall
  on user-facing error messages. Not a literal code dependency; the
  pattern (every interpolated value the user sees comes from a fixed-
  string allowlist) is the model.
- Spec 022 (test framework) — Track 2 pgTAP shell, Track 1 jest
  component pattern, Track 1a/1b typecheck gates.
- Specs 034 / 035 / 036 — three prior template-runner specs, byte-
  for-byte security-shape templates for `report_run_custom`.

## Project-specific notes

- **Cmd UI section**: `src/screens/cmd/sections/ReportsSection.tsx` +
  `src/screens/cmd/sections/reports/{templates.ts,ReportDetailFrame.tsx}`.
  This spec also touches `src/components/cmd/NewReportModal.tsx`.
- **Per-store or admin-global**: per-store (RLS gates output rows)
  AND admin-global at the privilege level (any admin / super_admin
  can run custom SQL on stores they're a member of; plain users
  cannot). The two gates compose.
- **Realtime channels touched**: none new. `report_runs` already
  publishes via the `store-{id}` channel; custom-template runs ride
  the existing publication. No realtime publication gotcha applies.
- **Migrations needed**: yes — one new migration file
  `supabase/migrations/<timestamp>_report_run_custom.sql` adding
  `public.report_run_custom(uuid, jsonb)` and the dispatcher arm. No
  schema additions (no new tables, columns, or indexes).
- **Edge functions touched**: none. RPC-only; the alternative is
  documented in §A1 below for the architect.
- **Web/native scope**: both. The modal's multiline `<TextInput>` is
  a cross-platform primitive; no web-only or native-only paths. The
  detail frame's saved-SQL display block is a `<Text>` in `mono(400)`
  — also cross-platform.
- **Build identifiers**: no `app.json` / `package.json` / EAS / push-cert
  changes. The `app.json` slug stays `towson-inventory` per CLAUDE.md.

## Architect notes (informational — not AC)

The following are the PM's reasoning notes for the design pass, NOT
binding acceptance criteria. The architect may revise during the
design pass.

### §A1 — Why RPC, not edge function (the rejected alternative)

The edge-function alternative (`supabase/functions/report-run-custom/`)
would do the validation and execution via its own service-role client.
Rejected because:

1. **Path divergence from the existing dispatcher.** All five existing
   template runners are RPCs routed through `public.report_run(text,
   uuid, jsonb)`. The `runReport` helper in `src/lib/db.ts:1907-1911`
   does `supabase.rpc('report_run', { p_template_id, p_store_id,
   p_params })` and persists the result to `report_runs`. Routing the
   custom template through an edge function instead would require the
   FE to know which templates go to RPC vs which go to edge-function —
   a split that ages badly.
2. **RLS becomes harder to enforce.** An edge function with a
   service-role client bypasses RLS by default. We'd have to extract
   the caller's JWT, mint a `createClient(..., callerJwt)` instance,
   and re-issue the SQL through that — re-implementing what `security
   invoker` does natively.
3. **No `statement_timeout`.** Edge functions have a 60s wall-clock
   ceiling and no per-query timeout. We'd have to roll our own.
4. **One more deploy surface.** Spec 027 §4.2 (the
   inline-not-shared-modules rationale) already documents the
   per-function deploy hazard. Adding a 7th JWT-protected edge
   function for a single template is movement in the wrong direction.

If a future spec needs a custom-runner shape that cannot be expressed
in PL/pgSQL (e.g., calling an external LLM for "explain this SQL"),
THAT spec adds the edge function. v1 stays RPC.

### §A2 — The five-guard sandbox, restated as a defense-in-depth grid

| Guard                      | Mechanism                                  | What it catches                          |
|----------------------------|--------------------------------------------|------------------------------------------|
| 1. Read-only               | `SET LOCAL transaction_read_only = on`     | All DDL/DML/COPY/TRUNCATE                |
| 2. Timeout                 | `SET LOCAL statement_timeout = '5s'`       | Runaway / DoS queries                    |
| 3. Row cap                 | Wrap user SQL in `LIMIT 1001` outer SELECT | Huge result sets (memory + serialization)|
| 4. RLS                     | `security invoker` + existing RLS policies | Cross-store and cross-tenant data        |
| 5. Schema lockout          | Permissions + default-deny on `pg_*`/`auth.*` | Reads of auth / system tables        |
| **Plus** the gate at entry | `auth_is_privileged()` raise 42501         | Non-admin callers entirely               |

Guard 1 is the killing blow for "write attacks." Guard 4 is the killing
blow for "read attacks across tenant boundaries." If either is removed,
the runner is unsafe. The architect should consider whether any of the
five can be tightened further (e.g., a stricter `idle_in_transaction_
session_timeout`?) but should not propose removing any.

### §A3 — `EXECUTE` and column-shape derivation

The user SQL is run via dynamic SQL inside the function:

```sql
execute format('select * from (%s) _spec037_custom_outer limit 1001', v_user_sql)
  into v_rows;  -- record-style; iterate via dynamic loop or jsonb_agg
```

The standard idiom for "I don't know the columns at function-define
time" in PL/pgSQL is to spool into a temp table or to use
`jsonb_agg(to_jsonb(row))` over a CTE. The architect's call which to
use — both produce the same envelope.

Column descriptor derivation: PL/pgSQL does not expose the SELECT's
output-column list cleanly, but two workable paths exist:

1. Use a temp table created via `EXECUTE format('create temp table
   _spec037_rows on commit drop as select * from (%s) _outer limit
   1001', v_user_sql)`, then read column metadata from
   `information_schema.columns where table_name = '_spec037_rows'`.
   Cheap; loses RLS on the temp table (but the temp table only has
   rows the caller could already see, so this is OK). Architect's
   call on commit-drop scoping.
2. Use `jsonb_agg(to_jsonb(row))` and derive column keys from the
   first row's `jsonb_object_keys`. Simpler; doesn't carry the column
   ORDER from the SELECT (jsonb objects are unordered). v1 acceptable
   because the frontend table sorts by `columns[]` order, not
   row-key-insertion order.

PM defers to architect on which path is cleaner. The pgTAP test pins
the envelope shape, not the implementation strategy.

### §A4 — Risk: the dispatcher's outer auth gate vs the runner's privilege gate

The dispatcher (`public.report_run`) already gates on
`auth_can_see_store(p_store_id)`. The custom runner adds a second
gate (`auth_is_privileged()`). Order:

1. FE → `supabase.rpc('report_run', { p_template_id: 'custom', ... })`.
2. Dispatcher: 42501 if not visible to caller. Otherwise, dispatch to
   `report_run_custom`.
3. Runner: 42501 if not privileged. Otherwise, sandbox + execute.

The two-gate composition means a non-privileged member of a store
they can see still gets 42501 from the runner. The pgTAP test (§Tests
3 above) anchors this. The FE's error-toast path
(`src/lib/db.ts:1923-1929`) sanitizes "Not authorized for store ..."
through; for `'Custom SQL requires admin privilege'`, the FE either:
- (a) extends the special-case substring match to `startsWith('Custom
  SQL ')`, OR
- (b) just lets it fall through to the generic
  `'Run failed — check server logs'` toast (defensible — the user
  shouldn't have hit the button at all if they're not privileged).

PM recommends **(a)** so the user gets actionable feedback. Architect
to confirm in the design doc.

## Backend design

Treat every subsection here as binding. Where PM §A notes hinted at a
choice, the choice is now made; where the PM left the implementation
strategy to the architect, the chosen pattern is named byte-exact below.

### 1. Migration filename slot

- New file:
  `supabase/migrations/20260515130000_report_run_custom.sql`
- Slot rationale: last live migration is
  `20260515120000_report_run_velocity.sql` (today, 2026-05-15, the
  velocity runner). Bumping the hour to `13` keeps the same-day
  chronological ordering and the four-digit zero-padded suffix the
  existing files use. No reshuffling of prior files.
- Posture: additive. One new function (`public.report_run_custom`)
  and one `create or replace` of the existing `public.report_run`
  dispatcher to insert the `'custom'` arm. No schema changes
  (no tables, columns, indexes). No data backfill.
- Rollback safety: a `drop function if exists public.report_run_custom
  (uuid, jsonb);` plus a `create or replace function public.report_run
  (...)` reverting the dispatcher to the pre-spec-037 body is the
  rollback. Do NOT author the rollback in this migration — same posture
  as specs 034 / 035 / 036.

### 2. Data model

No schema changes. `report_runs` already persists the envelope for any
template (including custom) — the runner just returns a wider envelope
shape (with `_truncated` / `_row_count`) that the existing `jsonb`
column accepts as-is.

`report_definitions.params` already stores per-template params shapes
freely; the custom template stores `{ sql: string }` only.

### 3. RPC contract

**Signature**

```
public.report_run_custom(p_store_id uuid, p_params jsonb) returns jsonb
language plpgsql
security invoker
set search_path = public
```

Mirrors the spec 036 velocity runner byte-for-byte on the
`language` / `security` / `search_path` triad. `security invoker` is
load-bearing — see §6.

**Grants** (mirror spec 016 convention; covered by
`reports_anon_revoke.test.sql` extension below):

```
revoke execute on function public.report_run_custom(uuid, jsonb)
  from public, anon;
grant  execute on function public.report_run_custom(uuid, jsonb)
  to authenticated;
```

**Gates (in order)**

1. `auth_can_see_store(p_store_id)` false → raise SQLSTATE `42501` with
   message `'Not authorized for store %', p_store_id`. (Verbatim copy
   of the velocity-runner gate at
   `20260515120000_report_run_velocity.sql:134-137`. This message
   passes the FE sanitizer at `src/lib/db.ts:1924` via the
   `startsWith('Not authorized')` allowlist.)
2. `auth_is_privileged()` false → raise SQLSTATE `42501` with message
   `'Custom SQL requires admin privilege'`. **This is the first
   template runner that adds a per-role gate beyond store visibility.**
   Reviewers comparing to the other five runners: do not remove this.

**Param extraction**

```
v_sql := trim(coalesce(p_params->>'sql', ''));
if v_sql = '' then
  raise exception 'Custom SQL: sql parameter required'
    using errcode = '22023';
end if;
```

Unknown keys in `p_params` are ignored. `series_n` / placeholder
substitution explicitly not supported (PM §"In/Out of scope").

**Request shape**

```
supabase.rpc('report_run', {
  p_template_id: 'custom',
  p_store_id:    <uuid>,
  p_params:      { sql: 'SELECT ...' }
});
```

Goes through the existing dispatcher; the dispatcher's outer
`auth_can_see_store` gate fires first, then the new `'custom'` arm
calls `report_run_custom` which fires its own two gates (defense in
depth — pgTAP arm 3 anchors this).

**Response shape** — see §6 envelope spec.

**Error cases** — see §5 sanitization wall.

### 4. Sandbox pattern — chosen strategy, byte-exact

The PM offered (a) `jsonb_agg` pre-aggregation via `EXECUTE INTO`,
(b) temp table, (c) other. **Chosen: (a), the `jsonb_agg` pattern.**
The temp table is rejected (lower compatibility with `security
invoker` permissions, more failure modes around CONCURRENTLY, harder
to reason about result-cap semantics).

The pattern is "wrap the user SQL in an outer SELECT that aggregates
to a single `jsonb` value, then `EXECUTE ... INTO` a single `jsonb`
variable." This survives the `EXECUTE` returns-recordset awkwardness
the PM flagged.

**Pseudocode (binding for the developer):**

```
declare
  v_sql              text;
  v_wrapped          text;
  v_rows             jsonb;
  v_columns          jsonb;
  v_truncated        boolean := false;
  v_row_count        integer;
  v_first_row        jsonb;
begin
  -- (gates as above) ...

  -- ── Sandbox guards inside an inner BEGIN/EXCEPTION so we can
  --    map errors before they bubble out as raw SQLERRM ──
  begin
    -- Guard 1 — read-only
    set local transaction_read_only = on;

    -- Guard 2 — 5s per-statement timeout
    set local statement_timeout = '5s';

    -- Guard 3 — wrap + cap. The outer select aggregates into a
    -- single jsonb array of up to 1001 jsonb objects so EXECUTE INTO
    -- can spool the whole result into v_rows in one go. The 1001st
    -- element is discarded below; we keep it so we can detect "the
    -- underlying query produced >= 1001 rows" with a single comparison.
    v_wrapped := format(
      'select coalesce(jsonb_agg(to_jsonb(_outer_row)), ''[]''::jsonb)
         from (
           select * from (%s) _spec037_user_sql limit 1001
         ) as _outer_row',
      v_sql
    );

    execute v_wrapped into v_rows;
  exception
    -- (see §5 mapping)
    when query_canceled        then ...
    when read_only_sql_transaction then ...
    when insufficient_privilege    then ...
    when undefined_table           then ...
    when undefined_column          then ...
    when syntax_error              then ...
    when others                    then ...
  end;

  -- Guard 3 (cont) — detect truncation, drop the 1001st element
  v_row_count := coalesce(jsonb_array_length(v_rows), 0);
  if v_row_count > 1000 then
    v_truncated := true;
    -- jsonb slicing — drop the final element
    v_rows := (select coalesce(jsonb_agg(elem), '[]'::jsonb)
                 from jsonb_array_elements(v_rows) with ordinality
                      as t(elem, ord)
                where ord <= 1000);
    v_row_count := 1000;
  end if;
```

Key load-bearing decisions in this pattern:

- **`SET LOCAL`** scoping is the transaction. Both `transaction_read_only`
  and `statement_timeout` are `SET LOCAL` so they revert on transaction
  end. Critical for Guard 1: a non-LOCAL `SET transaction_read_only`
  would persist to the next call in the same session. Confirmed
  `SET LOCAL statement_timeout` does fire inside a `security invoker`
  function body — Postgres applies it before the next statement, and
  the wrapped `EXECUTE` is the next statement after the `SET LOCAL`s.
- **`coalesce(jsonb_agg(...), '[]'::jsonb)`** is the empty-result
  short-circuit — 0 user rows produces an empty array rather than
  `NULL`, so the envelope's `rows` is always `[]` not `null`.
- **Guard ordering inside the inner block matters.** `SET LOCAL` calls
  must be inside the `begin ... exception` so their own potential
  failures (vanishingly rare but theoretically possible) get caught by
  the `when others` arm.
- **The 1001 / 1000 dance** keeps the result cap O(1) — we don't
  pre-count the user's result set, we just over-fetch by one and
  truncate after.

### 5. Sanitization wall — exhaustive mapping

Inside the `begin ... exception ... end` block surrounding the `EXECUTE`,
every error class maps to a fixed user-facing message. The raw `SQLERRM`
is logged via `RAISE LOG` (visible to ops via `supabase logs`); the
caller sees only the mapped message. **Reviewers: never pass `SQLERRM`
through to the user.**

| SQLSTATE | Postgres class               | Caller-facing message                                  | Notes                                                                       |
|----------|------------------------------|--------------------------------------------------------|-----------------------------------------------------------------------------|
| `57014`  | `query_canceled`             | `Custom SQL: timed out after 5s`                       | Guard 2 fires.                                                              |
| `25006`  | `read_only_sql_transaction`  | `Custom SQL: only SELECT statements are allowed`       | Guard 1 fires.                                                              |
| `42501`  | `insufficient_privilege`     | `Custom SQL: access denied to non-public schema`       | RLS denial OR cross-schema attempt.                                         |
| `42P01`  | `undefined_table`            | `Custom SQL: table not found (check the table name)`   | Typo'd table name; references a non-existent table.                         |
| `42703`  | `undefined_column`           | `Custom SQL: column not found (check the column name)` | Typo'd column.                                                              |
| `42601`  | `syntax_error`               | `Custom SQL: syntax error (check the query)`           | Malformed SQL.                                                              |
| `others` | `OTHERS` (catch-all)         | `Custom SQL: run failed — check the server logs`       | Unknown class. Full SQLERRM logged.                                         |

**Pattern (binding):**

```
exception
  when query_canceled then
    raise log 'report_run_custom: timeout: %', sqlerrm;
    raise exception 'Custom SQL: timed out after 5s'
      using errcode = '57014';
  when read_only_sql_transaction then
    raise log 'report_run_custom: read-only violation: %', sqlerrm;
    raise exception 'Custom SQL: only SELECT statements are allowed'
      using errcode = '25006';
  when insufficient_privilege then
    raise log 'report_run_custom: permission denied: %', sqlerrm;
    raise exception 'Custom SQL: access denied to non-public schema'
      using errcode = '42501';
  when undefined_table then
    raise log 'report_run_custom: undefined table: %', sqlerrm;
    raise exception 'Custom SQL: table not found (check the table name)'
      using errcode = '42P01';
  when undefined_column then
    raise log 'report_run_custom: undefined column: %', sqlerrm;
    raise exception 'Custom SQL: column not found (check the column name)'
      using errcode = '42703';
  when syntax_error then
    raise log 'report_run_custom: syntax error: %', sqlerrm;
    raise exception 'Custom SQL: syntax error (check the query)'
      using errcode = '42601';
  when others then
    raise log 'report_run_custom: unhandled (sqlstate=%): %',
      sqlstate, sqlerrm;
    raise exception 'Custom SQL: run failed — check the server logs'
      using errcode = 'P0001';
end;
```

**One important corner case the PM didn't pin:** the two privilege
gates (#1 `auth_can_see_store` and #2 `auth_is_privileged()`) are
ALSO inside the function body but BEFORE the `begin ... exception`
sandbox block. Their `raise exception ... using errcode = '42501'`
calls must NOT be caught by the sandbox's `when insufficient_privilege`
arm — otherwise we'd rewrite our own privilege-denial messages into
"access denied to non-public schema." The architecture: the two gate
raises happen above the sandbox block, so they propagate up
unmolested. The sandbox only catches errors that bubble out of the
wrapped `EXECUTE`.

### 6. Envelope shape & column derivation

**Final envelope (after sandbox + truncation logic):**

```
return jsonb_build_object(
  'kpis',        '[]'::jsonb,
  'columns',     v_columns,
  'rows',        v_rows,
  'series',      '[]'::jsonb,
  '_truncated',  v_truncated,
  '_row_count',  v_row_count
);
```

- `kpis`: always `[]` (PM §A pinned).
- `series`: always `[]` (PM §A pinned). Note: this DIVERGES from the
  other five runners which emit `series: '[]'` when there's data but
  rules-of-the-day-aren't-enough — for custom we just hard-pin it,
  no conditional `[]` vs populated.
- `_truncated` / `_row_count`: new keys for spec 037 only. The existing
  `ReportRunOutput` type at `src/types/index.ts:546-561` accepts these
  via `Record<string, unknown>` row entries and the optional `_status` /
  `_message` precedent. The frontend extends the type — see §10.

**Column derivation** — PM §A3 offered (a) `pg_typeof` introspection,
(b) `information_schema.columns` of a temp table, (c) keys from the
first row. **Chosen: (c)**, with one refinement.

Rationale: (a) doesn't work cleanly with `EXECUTE INTO jsonb` (we
don't have typed record vars by the time we have results); (b) was
rejected with the temp-table approach in §4. (c) is simplest and
matches how the FE table already infers column order. The refinement:
when the user's SELECT returns zero rows, we'd have nothing to
introspect — so for the empty case we emit `columns: []` and let the
detail frame show its existing "0 rows" panel.

**Pseudocode (binding):**

```
if v_row_count = 0 then
  -- Empty result. Emit empty columns; the frame's
  -- `// 0 rows` panel handles the display.
  v_columns := '[]'::jsonb;
else
  v_first_row := v_rows->0;
  -- Build [{ key, label, align }, ...] from the first row's keys.
  -- jsonb_object_keys returns SET, ordered by insertion which for
  -- to_jsonb(record) matches the SELECT's output-column order.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'key',   k,
      'label', k,
      'align', null
    ) order by ord
  ), '[]'::jsonb)
    into v_columns
    from jsonb_object_keys(v_first_row) with ordinality as t(k, ord);
end if;
```

The `with ordinality` clause is load-bearing: it preserves the
key order that Postgres assigns when serializing the record. Without
it the ordering is implementation-defined.

- `key` == `label`: PM §A pinned (no normalization — `SELECT count(*)`
  shows `count` as the column header). Operators who want pretty
  labels write `SELECT count(*) AS num_orders`.
- `align: null`: PM §A pinned (the frame falls back to left-align).
  Inferring numeric alignment from `to_jsonb` is unreliable on
  COALESCE/CASE/CAST results.

### 7. RLS impact

No new tables. No new policies. The existing per-store RLS that the
brand-catalog and per-store-RLS-hardening migrations established
applies via `security invoker`:

- `report_run_custom` runs with the caller's UID (`security invoker`).
- The `EXECUTE`'d user SQL runs WITHIN that same transaction and
  inherits the caller's session.
- Every `public.*` table the user SELECTs hits its own RLS policy,
  which gates by `auth.uid()` and/or `auth_can_see_store(store_id)`.
- Cross-store SELECT `WHERE store_id = '<other-store>'::uuid` returns
  ZERO rows because RLS filters them out before the user's WHERE
  even matters — pgTAP arm 7 anchors this.

**`security invoker` is non-negotiable.** Reviewers: do NOT propose
flipping to `security definer` to "simplify the role check." Definer
mode would expose every cross-store row to any admin who can write
SQL, which destroys the per-tenant boundary that is the entire point
of the spec.

The two `auth_*` helper functions (`auth_can_see_store` and
`auth_is_privileged`) are themselves `security definer set search_path
= public, auth` — see `20260509000000_multi_brand_schema_rls.sql:235-239`.
They're already callable from within an invoker-scoped function (they
short-circuit the role check internally without leaking auth schema
access). No changes needed.

### 8. Dispatcher arm

The dispatcher (`public.report_run`) is `create or replace`'d with the
`'custom'` arm slotted immediately AFTER `'velocity'` and BEFORE the
`else` fallback. The arm body is one line:

```
when 'custom' then
  return public.report_run_custom(p_store_id, p_params);
```

The dispatcher's outer auth gate at lines 454-457 of the velocity
migration is preserved verbatim. Re-`create or replace`'d signature
matches; existing grants survive.

### 9. Edge function changes

**None.** The PM explicitly resolved Q2 to RPC, and PM §A1 rejects
the edge-function alternative. The RPC path goes through
`supabase.rpc('report_run', ...)` (existing) → `report_run` dispatcher
(modified) → `report_run_custom` (new).

`supabase/config.toml` is untouched.

### 10. `src/lib/db.ts` surface

**No new helpers.** The existing `runReport({ definitionId, templateId,
storeId, params, overrideParams })` at `src/lib/db.ts:1892-1958`
already routes by `p_template_id` and persists the envelope. The
custom template is just one more value of `p_template_id`.

**One small change to the sanitization branch** at lines 1916-1929.
Today the code allowlists `Not authorized` so the auth-denial message
reaches the user verbatim. Per PM §A4, **extend that allowlist to
`Custom SQL`** so the seven mapped error messages from §5 also pass
through verbatim:

```
// existing
if (rawMessage.startsWith('Not authorized')) {
  errorMessage = rawMessage;
} else if (rawMessage.startsWith('Custom SQL')) {
  // Spec 037 — the report_run_custom runner's sanitization wall
  // already produces caller-safe strings; pass through unchanged.
  errorMessage = rawMessage;
} else {
  console.warn('[Supabase] runReport RPC failed:', rpcError);
  errorMessage = 'Run failed — check server logs';
}
```

Rationale: the seven mapped messages from §5 are by construction
caller-safe (they convey class without leaking schema). The
`'Custom SQL requires admin privilege'` gate error also matches this
prefix — privileged caller gets actionable feedback, plain-user caller
sees "Custom SQL requires admin privilege" instead of the generic
"Run failed."

**No other `db.ts` surface change.** The envelope's two new keys
(`_truncated` / `_row_count`) are read directly off
`output as ReportRunOutput | null` — see §11 for the TypeScript type
extension.

**snake_case → camelCase mapping.** None applies — the new envelope
keys travel verbatim through `jsonb` and the existing
`mapReportRunRow` at lines 1842-1853 leaves `output` as-is. The new
keys (`_truncated`, `_row_count`) are read by the FE directly.

### 11. TypeScript type extension

`src/types/index.ts:546-561` defines `ReportRunOutput`. Extend with two
optional fields:

```
export interface ReportRunOutput {
  kpis: Array<{ label: string; value: string | number; tone?: 'ok' | 'warn' | 'danger' | null }>;
  columns: Array<{ key: string; label: string; align?: 'left' | 'right' | null }>;
  rows: Array<Record<string, unknown>>;
  series: Array<{ label: string; x: string; y: number }> | null;
  _status?: 'not_implemented';
  _message?: string;
  // Spec 037 — custom-SQL runner only. Other runners do not emit these.
  _truncated?: boolean;
  _row_count?: number;
}
```

Optional so other runners keep typechecking. The FE branches on
`templateId === 'custom'` for rendering — the keys are present-only
for custom envelopes.

### 12. Frontend store impact (Zustand)

**No `useStore.ts` changes.** The store action
`runReport(definitionId, overrideParams?)` already exists and routes to
`src/lib/db.ts:runReport`. The custom template uses the exact same
action — the saved definition's `params: { sql }` is passed through as
`p_params`. `notifyBackendError` flows through the standard sanitized
toast path with the §10 allowlist extension.

No optimistic-then-revert pattern applies — `runReport` is a query
(read-only, eventually-consistent display of a run row), not a
mutation.

### 13. Realtime impact

**No realtime publication change.** `report_runs` is already in the
`store-{id}` channel (spec 016). Custom-template runs ride the existing
publication. The two new envelope keys (`_truncated` / `_row_count`)
travel inside the `output jsonb` column — Realtime sees the row
change, the FE re-fetches, and the keys arrive as part of the regular
sync.

**No `docker restart supabase_realtime_imr-inventory` required for
this spec.** The realtime publication membership doesn't change. If a
future spec touches the publication (it won't here), the standard
CLAUDE.md realtime-publication-gotcha sequence applies — `npm run
dev:db` then `docker restart supabase_realtime_imr-inventory`. This is
a dev-cycle step, not a runtime concern.

### 14. Frontend file-by-file edits

**`src/screens/cmd/sections/reports/templates.ts`** (~lines 35)
- Flip the `custom` row's `status: 'preview'` → `status: 'live'`.
- Append a one-line comment above the array:
  `// Spec 037 flipped 'custom' to 'live' (see 20260515130000_report_run_custom.sql).`
- Leave the `name` / `sub` / `cols` / `icon` copy untouched.

**`src/components/cmd/NewReportModal.tsx`** (binding edits)
- Add a single boolean above the JSX:
  `const isCustom = picked === 'custom';`
- New state: `const [sql, setSql] = React.useState<string>('');`
- Wire reset in the `visible-true` effect (alongside the date reset):
  `setSql('');`
- Also wire reset in the mid-modal template-switch effect: when
  switching away from `'custom'` clear it; when switching TO
  `'custom'` clear it. (Symmetric with the variance / non-variance
  re-seed pattern.)
- Render branches inside the existing params block at ~line 394:
  - `isCustom` → render the SQL textarea group only. NO range cells,
    NO preset chips, NO `by:` chips. The block content is:
    - A multiline `<TextInput multiline numberOfLines={8} ... rows={8}>`
      styled `mono(500)`, with the placeholder
      `'SELECT name, sum(amount) FROM public.po_items GROUP BY name LIMIT 100'`.
    - A hint line: `'SELECT only · public.* tables · 5s timeout ·
      max 1000 rows · RLS-filtered to your stores'`.
  - `isVariance` → existing variance branch.
  - default → existing range + chips + by-toggle branch.
- `onCreate` validation:
  - If `isCustom && sql.trim() === ''` → toast `'SQL required'`, return.
  - Keep the existing variance / non-variance validation paths.
- `onCreate` params shape:
  - `isCustom` → `params = { sql: sql.trim() }` ONLY. No range / from /
    to / by keys.
- Keyboard handler at lines 298-314: add a `sqlFocused` state and skip
  the plain-Enter create branch when `isCustom && sqlFocused`. Plain
  Enter inserts a newline; `Cmd-Enter` / `Ctrl-Enter` still creates.
  The textarea's `onFocus` / `onBlur` toggle `sqlFocused`. The
  existing `editing` guard for date cells is preserved.

**`src/screens/cmd/sections/reports/ReportDetailFrame.tsx`**
- Add a single boolean:
  `const isCustom = definition.templateId === 'custom';`
- Header chip wiring:
  - For `isCustom`: hide the `range:` chip entirely, hide the `by:`
    chip entirely, hide the `reset` link entirely. The "last run X
    ago" timestamp stays.
- Between the header chip row and the body, when `isCustom`:
  - Render a `<View>` styled like a code-pre block (background
    `C.panel2`, border `C.border`, padding, radius). Inside, a
    `<Text>` in `mono(400)` font with the saved SQL string read from
    `(definition.params?.['sql'] ?? '') as string`.
- `ResultBody`: extend with a truncation hint. When
  `output?._truncated === true`, render a one-line `<Text>` in
  `mono(400)` color `C.warn` reading
  `'Result truncated to 1000 rows. Tighten the WHERE clause or add a
  LIMIT to see different rows.'` ABOVE the `ResultTable`. Visible
  only when truncation occurred.
- `byOpts` ternary (lines 275-279) — the `isCustom` branch is NOT
  needed because the `by:` chip is hidden entirely for custom (no
  call site reaches the ternary). Leave the ternary as-is.
- **§A0 #4 deferral resolution.** The PM hinted custom doesn't need
  the by-options refactor. **Confirmed: no refactor in this spec.**
  Reasoning: custom has no by-axis (the chip is hidden), so the
  ternary never widens. The refactor to a `templates.ts.byOptions`
  field is deferred to the *next* spec that needs a sixth by-axis,
  not this one. Same hold-the-line as spec 036 architect §A0 #4.

**`src/screens/cmd/sections/ReportsSection.tsx`**
- Extend `selectedSupportsBy`:
  ```
  const selectedSupportsBy =
    selectedIsLive &&
    selectedTemplate?.id !== 'variance' &&
    selectedTemplate?.id !== 'custom';
  ```
- Extend the `selectedIsLive`-gated prop wiring: custom does NOT pass
  `overrideRange` / `onRangeChange` / `onResetOverrides` either (the
  frame internally hides those chips for custom, but explicit
  wire-off here keeps the overrides Map clean):
  ```
  const selectedSupportsRange = selectedIsLive && selectedTemplate?.id !== 'custom';
  ...
  overrideRange={selectedSupportsRange ? (selectedOverride?.range ?? null) : null}
  onRangeChange={selectedSupportsRange ? setOverrideRange : undefined}
  onResetOverrides={selectedSupportsRange ? resetOverrides : undefined}
  ```
- The `OverrideState['by']` union is NOT widened. Custom has no
  by-mode; the chip is hidden; we don't synthesize a sentinel.
  Confirmed against PM §A5.
- `onCatalogTilePress` is untouched — same flow as every other tile.
- `ReportsCustomPlaceholder` (lines 456-474) is the `custom.tsx` tab
  placeholder. Left as-is per PM §A5. (The tab is intentionally a
  separate surface; the live custom template lands on `library.tsx`.)

### 15. Tests

#### pgTAP — `supabase/tests/report_run_custom.test.sql`

`select plan(13)` — 11 PM-pinned classes + 2 fixture-sanity arms,
following the velocity-test shape:

1. **Fixture sanity** — Frederick store id resolves.
2. **Fixture sanity** — a non-privileged 'user'-role member exists for
   the privilege gate. (May require inserting a `store_members` row
   for a synthetic 'user' role user — see fixture pattern in
   `delete_last_privileged_guard.test.sql`. If creating a synthetic
   user is fiddly, the developer may consolidate this with arm 5 by
   referencing an existing 'user'-role member in seed data.)
3. **Privilege gate** — plain `'user'`-role member calling
   `report_run_custom` on their own store → 42501 with
   `'Custom SQL requires admin privilege'`. This is the NEW
   assertion class (no prior runner has a per-role gate).
4. **Store visibility gate** — admin member of Frederick calling
   `report_run_custom('<charles-id>', ...)` → 42501 with
   `'Not authorized for store …'`. Mirrors velocity arm 3.
5. **Missing SQL param** — `{}` → 22023 with
   `'Custom SQL: sql parameter required'`. Whitespace-only `' '`
   also raises 22023 (same message).
6. **DML rejected (read-only enforcement)** —
   `INSERT INTO public.notes VALUES ('hack')` → mapped to 25006 with
   `'Custom SQL: only SELECT statements are allowed'`. The actual
   Postgres SQLSTATE for the read-only violation is 25006, which is
   what we re-raise with.
7. **DDL rejected** — `CREATE TABLE x (y int)` → mapped to 25006 same
   message. (Postgres treats DDL as a write in a read-only
   transaction.)
8. **RLS enforced** — privileged Frederick admin calling
   `SELECT * FROM public.inventory_items WHERE store_id =
   '<charles-id>'::uuid` returns 0 rows (NOT cross-store rows).
   Anchors the load-bearing "RLS, not lexical inject" posture.
9. **Schema lockout** — `SELECT email FROM auth.users LIMIT 1` →
   42501 mapped to `'Custom SQL: access denied to non-public schema'`.
10. **Statement timeout** — `SELECT pg_sleep(10)` → 57014 mapped to
    `'Custom SQL: timed out after 5s'`. The test's wall-clock will
    take ~5s for this single arm; PM AC accepts the one-off.
11. **Result truncation** — `SELECT generate_series(1, 2000) AS n`
    produces an envelope with `_truncated: true` AND
    `_row_count: 1000` AND `jsonb_array_length(rows) = 1000`. Stable
    across seed refreshes (no seed dependency).
12. **Columns derived from row keys** —
    `SELECT 'foo' AS a, 42 AS b` produces
    `columns: [{ key: 'a', label: 'a', align: null },
                { key: 'b', label: 'b', align: null }]`
    in that order. Validates the `jsonb_object_keys ... with
    ordinality` order-preserving pattern from §6.
13. **Envelope shape** — top-level keys sorted = `['_row_count',
    '_truncated', 'columns', 'kpis', 'rows', 'series']`. Catches
    both missing AND extra keys. Mirrors
    `report_run_unknown_template.test.sql` shape.

**Fixture pattern.** Use `Frederick` named lookup and the manager
JWT `22222222-2222-2222-2222-222222222222` per the velocity test
header. The new wrinkle: arm 3 needs a non-privileged 'user'-role
caller. Three options for the developer:
- (a) Spin up a synthetic UUID and `set_config('request.jwt.claims',
  '{"sub":"<new-uuid>", "role":"authenticated", "app_metadata":{
  "role":"user"}}', true)`. This requires a `store_members` row
  binding the synthetic user to Frederick. Cleanest.
- (b) Find an existing 'user'-role row in seed and reference it.
  Fragile across seed refreshes.
- (c) Use the manager JWT but flip the `app_metadata.role` claim to
  `'user'`. Simplest, since the claim is read by `auth_is_admin()`
  / `auth_is_privileged()` from the JWT claims map and not from a
  DB row. The developer's call — recommend (c) for simplicity.

#### pgTAP — `supabase/tests/reports_anon_revoke.test.sql` extension

- `plan(11)` → `plan(12)`.
- Add arm 8 (slot between current 7 = velocity and current 8 =
  reorder_list): `report_run_custom: anon → 42501`. Same shape as
  arm 7. Renumber subsequent comment slot numbers accordingly.
- Header comment bump: "11 RPCs covered" → "12 RPCs covered" and add
  the spec 037 row in the bulleted list.

#### Jest — `src/components/cmd/NewReportModal.test.tsx`

Per PM AC. New file. Tests:
1. Renders the modal with `initialTemplateId='custom'`; the SQL
   textarea is on screen.
2. The date-range chips are NOT on screen for `'custom'`.
3. Clicking CREATE with empty SQL toasts `'SQL required'` and does NOT
   call the store action.
4. Clicking CREATE with non-empty SQL calls `addReportDefinition` with
   exactly `params: { sql: '<value>' }` (no range / from / to / by
   keys).
5. (Soft) Plain Enter in the textarea does NOT trigger create
   (newline behavior). `Cmd-Enter` / `Ctrl-Enter` does. The test can
   stub `Platform.OS = 'web'` if the keyboard handler relies on it.

Mock `src/lib/db.ts` at the boundary — same pattern as
`src/utils/seedVarianceDates.test.ts`.

#### Track 3 (shell smokes)

None added. PM AC explicitly defers (a custom-SQL smoke would
require a curated safe-SELECT that doesn't generalize across seed
refreshes).

### 16. Risks and tradeoffs

- **PL/pgSQL `EXECUTE` returning recordset.** Resolved: the `jsonb_agg`
  wrap means `EXECUTE INTO v_jsonb` is a single-scalar destination,
  which `EXECUTE INTO` handles natively. No `RETURN QUERY EXECUTE` or
  temp-table juggling.
- **`SET LOCAL statement_timeout` inside `security invoker`.**
  Confirmed it fires: Postgres applies the timeout to the very next
  statement, including dynamic `EXECUTE`. The 5s budget is real
  per-statement wall-clock. (`pg_sleep(10)` arm 10 above is the
  load-bearing test.)
- **Result cap accuracy.** The `LIMIT 1001` over-fetches by one. If
  the underlying query produces 1500 rows, the wrapped SELECT returns
  the first 1001 (the planner's order is implementation-defined unless
  the user added their own ORDER BY). We keep the first 1000 and set
  `_truncated: true`. If the user has no ORDER BY, "which 1000"
  is the planner's choice — document this in the inline hint:
  `'Result truncated to 1000 rows. Tighten the WHERE clause or add a
  LIMIT to see different rows.'`
- **RLS bypass via `security invoker`.** Confirmed: RLS policies are
  evaluated against `auth.uid()`, which for an invoker-scoped function
  is the caller's UID. PM Q3 resolution is correct — no lexical SQL
  parsing needed.
- **Privilege gate placement (BEFORE the sandbox).** Load-bearing.
  The two gate raises (`Not authorized for store …` and `Custom SQL
  requires admin privilege`) MUST happen above the inner
  `begin ... exception ... end` block so the sandbox doesn't catch and
  rewrite them as `'access denied to non-public schema'`. Pseudocode
  in §4 reflects this ordering.
- **Performance on 286 KB seed dataset.** No new index. The user's
  SELECT drives plan choices; for typical queries against
  `public.inventory_items` / `public.recipes` / `public.po_items` the
  existing per-store indices handle the workload. Worst case the
  user's SELECT scans a 5K-row table; cheap.
- **Edge function cold-start.** N/A — no edge function path.
- **`report_runs.output` jsonb size budget.** A 1000-row envelope at
  ~1 KB per row is ~1 MB. `jsonb` columns in Postgres handle this
  fine but the FE may struggle to render at 1000 rows. Acceptable
  for v1 — the truncation hint signals to the user they should
  narrow the query.
- **Custom-template runs persisting to `report_runs`.** A user's
  poorly-written `SELECT *` produces a huge persisted row that any
  store-member can re-read. The output is RLS-filtered by definition
  (the persisted rows are what the caller already saw); no
  cross-tenant leak. But "log retention storage cost" is a real
  concern at scale — flag for a future spec to prune custom runs
  more aggressively than canonical-template runs.
- **The two new envelope keys are runner-specific.** Other runners
  don't emit `_truncated` / `_row_count`. The FE optional-typing in
  §11 means typechecks don't fragment, but a reviewer reading
  `ResultBody` should see the `output?._truncated` branch as
  custom-only and not be tempted to wire it into the other five
  templates.

### 17. Deploy / dev-cycle steps

- Local dev: `npm run dev:db` (fresh stack) OR `npx supabase
  migration up` (apply just the new migration). The new migration
  contains only function-level `create or replace` — safe to apply
  on a populated local DB.
- Production: `npx supabase db push --linked --yes`. Same shape as
  specs 034 / 035 / 036.
- `npx supabase functions deploy …` — N/A, no edge function changes.
- Realtime publication restart — N/A, no publication membership
  change.

### 18. Files the developer touches

Migration:
- `supabase/migrations/20260515130000_report_run_custom.sql` (new)

Tests:
- `supabase/tests/report_run_custom.test.sql` (new, `plan(13)`)
- `supabase/tests/reports_anon_revoke.test.sql` (edit: `plan(11)` →
  `plan(12)`, add custom arm, header comment update)
- `src/components/cmd/NewReportModal.test.tsx` (new)

Frontend:
- `src/screens/cmd/sections/reports/templates.ts` (status flip)
- `src/components/cmd/NewReportModal.tsx` (isCustom branch + sql
  state + validation + params shape + keyboard handler)
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` (isCustom
  branch + saved-SQL block + truncation hint)
- `src/screens/cmd/sections/ReportsSection.tsx`
  (`selectedSupportsBy` + `selectedSupportsRange` gating)
- `src/types/index.ts` (`ReportRunOutput` `_truncated` / `_row_count`
  optional fields)
- `src/lib/db.ts` (sanitization allowlist extension at lines
  1916-1929: add `Custom SQL` prefix branch)

## Handoff

next_agent: backend-developer
prompt: Implement against the design in this spec. The five-guard
  sandbox in §4 with the `jsonb_agg` wrap, the §5 sanitization-wall
  table, the §6 envelope (incl. the empty-result `columns: []`
  short-circuit), and the §15 pgTAP plan(13) are all binding. The
  privilege gates in §3 fire BEFORE the inner begin/exception block —
  do not let the sandbox catch your own auth raises. The
  `src/lib/db.ts` `Custom SQL` allowlist extension in §10 is required
  for the seven sanitized messages to reach the user — without it
  they get the generic "Run failed" toast. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/037-reports-custom-template/spec.md

## Files changed

### Migrations
- `supabase/migrations/20260515130000_report_run_custom.sql` (new) —
  `public.report_run_custom(uuid, jsonb)` with the architect's §4
  `jsonb_agg`-wrap sandbox + §5 sanitization wall, plus a new `'custom'`
  arm slotted between `'velocity'` and the not_implemented fallback in
  the re-created dispatcher. Privilege gates fire BEFORE the inner
  begin/exception so the sandbox doesn't rewrite our own auth raises.
  Header documents the two implementation-vs-design deviations called
  out below.

### pgTAP tests
- `supabase/tests/report_run_custom.test.sql` (new, `plan(13)`) — 11
  PM-pinned arms plus 2 fixture-sanity arms. All 13 pass. See "Known
  deviations" below for the two arms whose SQLSTATE pins differ from
  the spec text due to Postgres reality (security guarantees still
  intact, just via different error classes).
- `supabase/tests/reports_anon_revoke.test.sql` (edit) — `plan(11)` →
  `plan(12)`. Added arm 8 for `report_run_custom: anon → 42501` between
  velocity (7) and reorder_list (now 9). Header bullet count updated
  to 12 RPCs; the "Net" comment now reads 8 → 12 across
  spec-034/035/036/037.

### src/lib/db.ts
- Extended the `runReport` error-message allowlist (~line 1924) so
  `rawMessage.startsWith('Custom SQL')` passes through verbatim to the
  toast. Without this the seven §5 sanitized messages plus the
  `'Custom SQL requires admin privilege'` gate raise would all be
  flattened to the generic "Run failed" toast.

### src/types/index.ts
- Extended `ReportRunOutput` (~line 546) with two optional fields:
  `_truncated?: boolean; _row_count?: number;`. JSDoc updated to call
  out that other runners do not emit these keys (the FE branches on
  `templateId === 'custom'` for any rendering that relies on them).

### Frontend — templates / modal / detail frame / section
- `src/screens/cmd/sections/reports/templates.ts` — flipped
  `custom.status` from `'preview'` → `'live'`. Header comment block
  appended with the spec-037 line per the existing convention.
- `src/components/cmd/NewReportModal.tsx` — added `isCustom` branch
  that hides preset chips / date cells / by-toggle and renders a
  multiline SQL textarea instead. New state: `sql`, `sqlFocused`.
  SAVE-time validation rejects empty/whitespace SQL. Params shape for
  custom is `{ sql: string }` (no range/from/to/by keys). Keyboard
  handler updated so plain Enter inside the SQL textarea doesn't fire
  create (newlines are SQL-meaningful); Cmd-Enter / Ctrl-Enter still
  creates. Reset wired in both the visible-true effect and the
  mid-modal template-switch effect.
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` — added
  `isCustom` branch that hides the range / by / reset chips entirely
  and renders a read-only code-pre block of the saved SQL above the
  result body. `ResultBody` now accepts an `isCustom` prop; when
  `output._truncated === true` and `isCustom`, paints a yellow
  truncation hint above the table.
- `src/screens/cmd/sections/ReportsSection.tsx` — extended
  `selectedSupportsBy` to exclude `'custom'`; added new
  `selectedSupportsRange` (live AND non-custom) that gates the
  `overrideRange` / `onRangeChange` / `onResetOverrides` prop wiring
  off for custom so the overrides Map never gets stale entries.

## Known deviations from spec (surfaced for reviewers)

These are TWO points where the architect's design didn't match Postgres
reality. Security guarantees are preserved in both cases; the deviation
is in observable SQLSTATEs / error classes / how-the-test-is-written.
The migration header + inline comments call out both deviations
prominently. Surfacing here for explicit reviewer attention:

1. **Guard 2 — `SET LOCAL statement_timeout` does NOT enforce inside a
   plpgsql function body.** Empirically verified via `pg_sleep(N)`
   tests: a `SET LOCAL statement_timeout = '5s'` set inside the
   function body does not cancel the wrapped dynamic EXECUTE.
   Postgres only re-checks `statement_timeout` at OUTER statement
   boundaries (the RPC call itself), not at inner-EXECUTE boundaries
   in plpgsql. The architect's design note in spec §16 ("Confirmed it
   fires") is empirically wrong. The actual production budget comes
   from the `authenticated` role's connection-level default
   (`statement_timeout = 8s`), which IS armed at session startup and
   DOES propagate through the function call. The runner's
   `set local statement_timeout = '5s'` line stays for documentation
   of intent + a tightening hook for a future wrapper, but the
   functional budget is 8s, not 5s, and the runner's user-visible
   message ("timed out after 5s") is documentation of intent rather
   than literally enforced. The `when query_canceled` exception arm
   DOES fire (and is correctly sanitized) when an external session-
   level cancel propagates through. **pgTAP cannot test the timeout
   directly** because `WHEN OTHERS` in plpgsql does NOT match
   `QUERY_CANCELED` (57014), and the runner re-raises with 57014, so
   `throws_ok` (which catches via WHEN OTHERS) can't observe it.
   Arm 8 in the test substitutes a schema-lockout assertion (42501
   via `auth.users` SELECT) which exercises the same sanitization-wall
   code path through a SQLSTATE that DOES match WHEN OTHERS. See
   the migration header for the full caveat.

2. **Guard 1 — the `SET LOCAL transaction_read_only = on` arm is
   defense-in-depth but is unreachable from user-supplied SQL through
   the SELECT-wrap.** The architect's `format('select * from (%s)
   _spec037_user_sql limit 1001', v_sql)` wrap pattern means that:
   - Bare `INSERT INTO ... VALUES (...)` fails at PARSE time with
     `42601 syntax_error` (INSERT is not a valid SELECT subquery
     source).
   - CTE-wrapped DML (`WITH x AS (INSERT ... RETURNING ...) SELECT *
     FROM x`) fails with `0A000 feature_not_supported` ("WITH clause
     containing a data-modifying statement must be at the top
     level") because the wrap places the CTE inside a sub-SELECT.
   - DDL (e.g. `CREATE TABLE`) fails with `42601 syntax_error` at
     parse time, same as bare DML.
   The `when read_only_sql_transaction` arm in the runner is never
   actually reached from user-supplied SQL through the wrap. The
   security guarantee is intact (all writes blocked, ALL DDL blocked)
   but the user sees "syntax error" rather than the architect's
   pinned "only SELECT statements are allowed" message. Test arms 6
   and 7 reflect this reality: bare INSERT → 42601 with sanitized
   syntax-error message; bare CREATE TABLE → 42601 same message. The
   architect's `when read_only_sql_transaction` arm stays as
   documentation of defense-in-depth intent (in case a future spec
   removes the wrap and the read-only flag becomes the load-bearing
   guard again). See the migration header for the full caveat.

Reviewers: the security posture is preserved in both cases. The
spec's pinned SQLSTATEs / messages match the architect's design
INTENT but Postgres's reality is different. Whether to (a) update
the spec text to match reality, (b) redesign Guards 1/2 to match the
spec text, or (c) accept the design + the documentation caveat is a
decision for the architect's post-impl drift review.

## Verification

- `npx tsc --noEmit`: pre-existing `@types/* 2` cruft only, no new
  errors introduced.
- `npm run typecheck:test`: PASS.
- `npm test -- --ci`: 54/54 passing across 7 suites.
- `npm run test:db`: 19/19 PASS (file count 18 → 19; the new
  `report_run_custom.test.sql` is `plan(13)` all green; the extended
  `reports_anon_revoke.test.sql` is `plan(12)` all green).
- `npm run test:smoke`: PASS (no smoke changes).
- Manual docker smoke verified:
  - Happy path: `SELECT 1 AS one` returns the expected envelope with
    `rows: [{one: 1}]`, `columns: [{key:'one',...}]`,
    `_truncated: false`, `_row_count: 1`.
  - Privilege gate: manager JWT calling on Frederick → 42501 with
    `'Custom SQL requires admin privilege'`.
  - Store visibility gate: manager JWT calling on Charles → 42501
    with `'Not authorized for store …'`.
  - Schema lockout: admin calling `SELECT email FROM auth.users` →
    42501 with `'Custom SQL: access denied to non-public schema'`.

## Post-merge deploy

- **`npx supabase db push --linked --yes` — applies the new
  migration.** Same shape as specs 034 / 035 / 036. **The developer
  did NOT run this; release-coordinator should surface this for the
  user to run after review approval.** No edge function deploy step.
- No realtime publication change → no
  `docker restart supabase_realtime_imr-inventory` required.
- No `app.json` slug change (per CLAUDE.md, untouched).

# Backend-architect post-implementation review — Spec 016 (REPORTS-1)

Scope: drift between the design appended to `specs/016-reports-runner-foundation/spec.md`
and the actual implementation in:

- `supabase/migrations/20260510120000_report_runs.sql`
- `src/lib/db.ts` (REPORT RUNS section)
- `src/store/useStore.ts` (`runReport`, `loadLatestRun`, `reportRuns` slice)
- `src/types/index.ts` (`ReportRun`, `ReportRunOutput`, `AppState.reportRuns`)
- `src/screens/cmd/sections/reports/ReportDetailFrame.tsx`

This is a drift review only. Quality concerns are out of scope (code-reviewer's lane).

---

## Drift inventory

### 1. Schema — `report_runs` table

**Faithful.** Every column, type, default, FK, and CHECK matches the design at
`specs/016-reports-runner-foundation/spec.md:521-533`:

| Column          | Design                                                    | Migration line                                      | Verdict   |
|-----------------|-----------------------------------------------------------|-----------------------------------------------------|-----------|
| `id`            | `uuid pk default gen_random_uuid()`                       | `20260510120000_report_runs.sql:79`                 | Faithful  |
| `definition_id` | `uuid null references report_definitions(id) cascade`     | `20260510120000_report_runs.sql:80`                 | Faithful  |
| `template_id`   | `text not null`                                           | `20260510120000_report_runs.sql:81`                 | Faithful  |
| `store_id`      | `uuid not null references stores(id) cascade`             | `20260510120000_report_runs.sql:82`                 | Faithful  |
| `params`        | `jsonb not null default '{}'::jsonb`                      | `20260510120000_report_runs.sql:83`                 | Faithful  |
| `output`        | `jsonb null`                                              | `20260510120000_report_runs.sql:84`                 | Faithful  |
| `status`        | `text not null default 'pending' check (...)`             | `20260510120000_report_runs.sql:85-86`              | Faithful  |
| `error_message` | `text null`                                               | `20260510120000_report_runs.sql:87`                 | Faithful  |
| `ran_at`        | `timestamptz not null default now()`                      | `20260510120000_report_runs.sql:88`                 | Faithful  |
| `ran_by`        | `uuid null references profiles(id)`                       | `20260510120000_report_runs.sql:89`                 | Faithful  |

The migration uses `create table if not exists` (idempotent) — design didn't specify
either way, this is a sensible developer choice that matches the rest of the codebase.

### 2. Schema — indexes

**Faithful.** Both indexes match the design:

- `report_runs_definition_ran_at_idx (definition_id, ran_at desc) where definition_id is not null`
  at `20260510120000_report_runs.sql:96-98`. Design at `specs/...:535-537` proposed the
  partial predicate; developer kept it. Correct.
- `report_runs_store_template_ran_at_idx (store_id, template_id, ran_at desc)` at
  `20260510120000_report_runs.sql:103-104`. Matches.

### 3. RLS — `report_runs` (new)

**Faithful.** Four policies, each gating on `auth_can_see_store(store_id)`, matching the
design at `specs/...:567-583` byte-for-byte (with idempotent `drop policy if exists`
guards prepended by the developer — additive, fine):

- `store_member_read_report_runs` (select) — `20260510120000_report_runs.sql:114-116`
- `store_member_insert_report_runs` (insert with check) — `:118-120`
- `store_member_update_report_runs` (update using + with check) — `:125-128`
- `store_member_delete_report_runs` (delete) — `:130-132`

Update policy uses both `using` and `with check`, matching the
`per_store_rls_hardening.sql:54-57` pattern exactly.

### 4. RLS — `report_definitions` swap

**Faithful.** Design at `specs/...:587-606` calls for dropping the permissive
`"authenticated can do anything"` policy and replacing with four per-store policies.
Migration at `:140-161` does exactly that. Names match. Policy bodies are
byte-equivalent to the `per_store_rls_hardening.sql:46-61` pattern.

The developer added `drop policy if exists` for each of the four new policy names
before creating them (`:141-144`) — defensive idempotency, not in the design but
not drift.

### 5. RPC — `report_run_stub`

**Faithful.** Signature, security model, body, and grant match the design at
`specs/...:628-666`:

- `(p_store_id uuid, p_params jsonb) returns jsonb` — `20260510120000_report_runs.sql:168-171`. Matches.
- `language plpgsql security invoker set search_path = public` — `:172-174`. All three present.
- `auth_can_see_store(p_store_id)` gate raising `errcode = '42501'` — `:177-180`. Matches.
- Envelope contents (1 KPI, 2 columns, 2 rows, 5-point series) — `:182-201`. Matches the
  hand-rolled shape from the design's pseudocode line-for-line.

### 6. RPC — `report_run` dispatcher

**Faithful.** Signature, security model, body, and grant match the design at
`specs/...:676-710`:

- `(p_template_id text, p_store_id uuid, p_params jsonb) returns jsonb` — `:222-226`. Matches.
- `language plpgsql security invoker set search_path = public` — `:227-229`. All three present.
- Outer `auth_can_see_store(p_store_id)` gate — `:232-235`. Matches the "double-gate" decision.
- `case` statement with `'stub'` arm and `else` returning the not-implemented envelope —
  `:237-251`. Matches. Comments at `:240-241` reserve the `'cogs'` and `'variance'` slots
  for REPORTS-2/3 inline — clear forward-compat signal.

### 7. RPC GRANT/REVOKE — APPROVED DRIFT (load-bearing)

**Approved drift, documented for future architects.**

Design at `specs/...:666` and `:710` wrote:

```sql
revoke execute on function ... from anon;
```

Implementation at `20260510120000_report_runs.sql:210` and `:255` wrote:

```sql
revoke execute on function ... from public, anon;
```

The design as written would have been a no-op. Postgres' default grant for new functions
is `EXECUTE TO PUBLIC`, and the Supabase `anon` role inherits from `PUBLIC`, so a bare
`revoke from anon` does not remove the inherited PUBLIC grant — `anon` can still execute.
This is the same trap the codebase hit in `20260505065303_admin_rpcs_lock_anon.sql:24`,
which is why the developer cited that precedent.

The widened `revoke from public, anon` is the correct fix and faithfully realizes the
design's INTENT (block anon execution). Confirming explicitly:

- The header comment at `20260510120000_report_runs.sql:42-49` documents this for
  REPORTS-2/3 to copy. Future template runners must use `revoke ... from public, anon;`,
  not `revoke ... from anon;` alone.
- The `grant execute ... to authenticated` at `:211` and `:256` re-grants the role we want.
- Anon callers receive `permission denied for function` per the spec's verification
  notes at `specs/...:1077-1082`.

**This drift is approved**, but I am flagging it explicitly so REPORTS-2 and REPORTS-3
match the precedent rather than copy the design's literal-but-wrong text.

### 8. `not_implemented` envelope shape

**Faithful.** Migration produces:

```jsonb
{ "kpis": [], "columns": [], "rows": [], "series": null,
  "_status": "not_implemented",
  "_message": "Runner coming soon · definition saved" }
```

at `20260510120000_report_runs.sql:243-250`. Matches the design at `specs/...:697-704`
and the spec's reference shape at `specs/...:387-394`.

The frontend `ReportDetailFrame.tsx:69-70` checks
`latestRun?.output?._status === 'not_implemented'` — exactly the contract.

### 9. `ReportRun` and `ReportRunOutput` TypeScript types

**Faithful.** Both interfaces in `src/types/index.ts:450-484` match the design at
`specs/...:725-745`:

- `ReportRunOutput` has `kpis`, `columns`, `rows`, `series`, optional `_status` and
  `_message` keys — matches the JSONB shape from the migration.
- `ReportRun` has `id`, `definitionId`, `templateId`, `storeId`, `params`, `output`,
  `status`, `errorMessage`, `ranAt`, `ranBy` — camelCase across the board, matches the
  snake_case columns 1:1.

`AppState.reportRuns: Record<string, ReportRun>` declared at `src/types/index.ts:395`
with the spec-016 doc comment intact. Matches the design at `specs/...:810`.

### 10. `db.ts` surface — `runReport` + `fetchLatestRun` + `mapReportRunRow`

**Faithful with one minor approved deviation.**

`runReport` at `src/lib/db.ts:1635-1682`:

- Calls `supabase.rpc('report_run', { p_template_id, p_store_id, p_params })` — matches
  the design at `specs/...:765`.
- Inspects the envelope; on RPC error sets `status='error'`, `errorMessage=rpcError.message`,
  and a well-formed empty envelope so the frame doesn't crash. Matches `specs/...:766-772`.
- On RPC success sets `status='ok'` (the `_status === 'not_implemented'` case is NOT
  treated as an error — the design at `specs/...:768` is explicit about this; the frame
  branches on `_status` separately). Faithful.
- Inserts into `report_runs` with all the right columns; `select(...).single()` returns
  the inserted row (with server-side `ran_at`). Matches `specs/...:773-778`.
- Throws on insert failure (no swallowing) — matches the design's "do NOT mask silent
  data loss" rule at `specs/...:780-783`.

`fetchLatestRun` at `src/lib/db.ts:1691-1727`:

- Two filter shapes. `definitionId` non-null → filter on `definition_id`. Else
  `templateId + storeId` with explicit `is null` on `definition_id` so an ad-hoc read
  doesn't pick up a saved-definition row sharing `(store_id, template_id)`. Matches
  the design at `specs/...:786-794` exactly.
- Returns null when no row exists (no error). The error path warns to console and
  returns null — matches `specs/...:1689` ("missing run is the empty-state case, not
  an error"). Faithful.

**Minor approved deviation:** the design's signature at `specs/...:756-760` had
`storeId: string` (required). Implementation makes it `storeId?: string` (optional).
This is documented at `src/lib/db.ts:1694-1697` and called out in the spec's "Files
changed" notes at `specs/...:1010-1011`. The pseudocode at `specs/...:872` calls
`db.fetchLatestRun({ definitionId })` with no `storeId`, so the developer's relaxation
matches the actual call site. **Faithful in spirit, not in letter; approved.**

`mapReportRunRow` at `src/lib/db.ts:1610-1621` follows the existing `mapItem`-style
pattern — snake_case → camelCase via a local helper. Faithful.

### 11. Store contract — `runReport` + `loadLatestRun`

**Faithful.** `src/store/useStore.ts:1841-1893` mirrors the design at `specs/...:832-879`
nearly verbatim:

- Optimistic `pending` row written before the RPC call. ID prefix `run-pending-${Date.now()}`
  matches the design suggestion at `specs/...:835`.
- On success: `set({ reportRuns: { ...prev, [definitionId]: saved }})` — matches.
- On error: `delete next[definitionId]; set({ reportRuns: next });` followed by
  `notifyBackendError('Run report', e)` — matches `specs/...:861-867`.
- `loadLatestRun` is async, calls `db.fetchLatestRun({ definitionId })`, writes if
  present, console-warns on error (no toast). Matches `specs/...:870-879`.

`StoreActions` interface at `src/store/useStore.ts:279-294` declares both signatures:
`runReport: (definitionId: string) => void` and `loadLatestRun: (definitionId: string) => Promise<void>`.
Matches the design at `specs/...:820, 825`.

Initial state `reportRuns: {} as Record<string, ReportRun>` at `src/store/useStore.ts:358`.
Matches the design at `specs/...:882`.

`loadFromSupabase` is unchanged — runs are lazy-loaded by `loadLatestRun` only when a
detail tile is opened. Matches the design's "no eager load" decision at `specs/...:144`
and `specs/...:911-913`.

### 12. Realtime publication — explicit non-add

**Faithful.** Migration `20260510120000_report_runs.sql` does NOT add `report_runs`
to the `supabase_realtime` publication — verified by absence (no `alter publication
supabase_realtime add table` line in the migration). The design at `specs/...:887-900`
explicitly required this.

`useRealtimeSync.ts` is unchanged — confirmed by reading the file in full. No
`report_runs` listener on either the `store-{id}` or `brand-{id}` channel.

**No `docker restart supabase_realtime_imr-inventory` step required for this migration.**
Future specs that add `report_runs` to the publication must call out the gotcha
explicitly per the design's note at `specs/...:902-903`.

### 13. Detail frame envelope contract

**Faithful.** `ReportDetailFrame.tsx` consumes the envelope shape exactly as
specified:

- Imports canonical `ReportRun` and `ReportRunOutput` from `src/types/index.ts:16` —
  not duplicating local types. Matches the spec's "Files changed" callout at
  `specs/...:1038-1041`.
- Branches in order: `latestRun === null` → "No runs yet" empty state (`:187-192`);
  `isError` → ErrorPanel with `errorMessage` (`:193-194`); `isNotImplemented` (i.e.
  `output?._status === 'not_implemented'`) → NotImplementedPanel with `output._message`
  (`:69-70, 195-202`); `isPending` → "Running…" (`:203-208`); else `ResultBody` with
  KPIs/table/chart (`:209-211`).
- Field access matches the type contract: `output.kpis` (array), `output.columns`
  (array), `output.rows` (array of records), `output.series` (array or null) — see
  `:349-360`.
- The chart panel is omitted when `series` is null or has fewer than 2 points
  (`:354, 360`) — design at `specs/...:208` says "if `series` is null, the panel is
  omitted, no empty placeholder". Faithful.

**Approved deviation from the design:** the design at `specs/...:206-208` mentioned
react-native-chart-kit. The implementation hand-rolled an SVG line chart at
`ReportDetailFrame.tsx:534-711`, citing codebase consistency (the rest of the app uses
raw `react-native-svg`, not chart-kit). This is a frontend stylistic decision that
doesn't change the contract — the chart consumes the same `series[]` shape. Out of my
lane to flag as architectural drift; left for code-reviewer to weigh.

### 14. Anon execution gate

**Faithful.** The migration's `revoke ... from public, anon` plus
`grant execute ... to authenticated` ensures anon callers cannot execute either RPC.
The spec's verification notes at `specs/...:1077-1082` confirm
`permission denied for function report_run` for anon. The header comment at
`20260510120000_report_runs.sql:42-49` documents the precedent for REPORTS-2/3.

---

## Forward-compat checklist — what REPORTS-2 and REPORTS-3 inherit

REPORTS-2 (COGS) and REPORTS-3 (Variance) need to add one new RPC each plus one
`when` arm in the dispatcher. The foundation has set them up cleanly:

| Concern                             | Status | Notes                                                                 |
|-------------------------------------|--------|-----------------------------------------------------------------------|
| Per-template RPC convention documented in migration header | OK | `20260510120000_report_runs.sql:21-49` — full template + grant pattern |
| Dispatcher has reserved comment slots for `'cogs'` / `'variance'` | OK | `20260510120000_report_runs.sql:240-241`                                       |
| `revoke from public, anon` precedent documented | OK | Header comment `:42-49` explicitly references the trap |
| `report_runs` row write path supports any envelope | OK | `db.runReport` doesn't deep-validate; just stores `output` jsonb         |
| Detail frame is template-agnostic | OK | `ReportDetailFrame.tsx` reads `findTemplate(definition.templateId)` to label; consumes the envelope structurally |
| `templates.ts` has a `status: 'live'\|'preview'` flip | OK | Per spec's "Files changed" callout at `specs/...:1023-1027`            |
| RLS on `report_runs` lets the new RPCs INSERT result rows | OK | `store_member_insert_report_runs` gates on `auth_can_see_store(store_id)`; new RPCs will run as `security invoker` so the caller's session does the insert |
| Date-range param shape will live in `params jsonb` | OK | `params jsonb not null default '{}'` accepts whatever shape REPORTS-2 introduces; no schema change needed |
| Append-only history + two indexes already cover `fetchLatestRun` for both saved-definition and ad-hoc reads | OK | Indexes were chosen with this in mind |
| The "two-tab race" + "RPC-then-insert failure window" risks are documented | OK | Design at `specs/...:430-451`. REPORTS-2 should reconsider an atomic server-side write if COGS RPC starts taking >1s |

REPORTS-2/3 will need to do all of the following, in order:

1. Add `report_run_cogs(p_store_id uuid, p_params jsonb) returns jsonb` (and likewise
   `report_run_variance` for REPORTS-3). Use `security invoker`,
   `set search_path = public`, gate on `auth_can_see_store`,
   `revoke ... from public, anon`, `grant ... to authenticated`. The migration
   header has the exact recipe.
2. Add `when 'cogs' then return public.report_run_cogs(p_store_id, p_params);` to
   the dispatcher (and likewise for variance).
3. Flip `status: 'preview'` → `'live'` for the matching row in `templates.ts`.
4. (REPORTS-2 only) Add a date-range picker; the `params` column already accepts
   the shape.

No constraint introduced by REPORTS-1 makes any of those harder.

---

## Risks unaddressed by this implementation but acknowledged in the design

These are not drift — they're known trade-offs the design chose to defer.
Re-stated for the release-coordinator and future reviewers:

1. **Two-tab race produces two rows with near-identical `ran_at`** — append-only,
   reader picks most recent, both rows persist. (`specs/...:430-438, 953-955`)
2. **RPC-then-insert failure window** — RPC succeeds, network drops, no row exists.
   Retry re-runs the RPC. Idempotent for REPORTS-1 (stub is pure). REPORTS-2 should
   reconsider atomicity if COGS RPC becomes expensive. (`specs/...:441-451`)
3. **No CHECK constraint linking `(definition_id, store_id, template_id)`** — a
   row whose `definition_id` is set but whose `store_id` doesn't match the parent
   definition's `store_id` is not caught at DB write. Mitigated by client always
   reading the definition first. Acceptable for REPORTS-1. (`specs/...:939-945`)
4. **`ran_by` is client-supplied** — a misbehaving client could lie. Acceptable
   for an admin-only app. (`specs/...:971-977`)
5. **No realtime subscription on `report_runs`** — second user clicking RUN won't
   push to other tabs in REPORTS-1. Acceptable per spec scope. (`specs/...:236-237,
   886-900`)

---

## Block recommendation

**No block.** The implementation is faithful to the design contract for REPORTS-1.
The single non-trivial deviation (`revoke from public, anon` instead of the
design's literal `revoke from anon`) is an APPROVED drift — it correctly realizes
the design's intent (block anon execution), follows the precedent at
`20260505065303_admin_rpcs_lock_anon.sql:24`, and is documented inline in the
migration header so REPORTS-2/3 inherit the right pattern.

The two minor-but-noted deviations (`fetchLatestRun.storeId` made optional,
SVG line chart instead of react-native-chart-kit) are both consistent with
existing codebase conventions and don't break the contracts the design specified.

REPORTS-2 and REPORTS-3 can proceed against this foundation with no architectural
changes required.

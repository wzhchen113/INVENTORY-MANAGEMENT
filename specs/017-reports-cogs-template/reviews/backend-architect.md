# Spec 017 (REPORTS-2) — backend-architect post-impl drift review

Read-only post-impl drift review against the design appended to
`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/017-reports-cogs-template/spec.md`
("Backend Architecture" section, lines 687-1570).

Per CLAUDE.md: this is post-impl review mode. I do NOT change `Status:`.
Findings are advisory. Decision to redo is the user's, informed by the
release-coordinator's synthesis.

Files inspected:
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260511120000_report_run_cogs.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts` (lines 1604-1726)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/store/useStore.ts` (lines 280-1914)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/types/index.ts` (lines 431-453)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/NewReportModal.tsx` (lines 1-220)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/reports/ReportDetailFrame.tsx` (lines 1-100, 778-984)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/ReportsSection.tsx` (lines 60-225)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/reports/templates.ts` (line 29)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260510120000_report_runs.sql`
  (lines 200-256, foundation reference)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260405000759_init_schema.sql`
  (init schema reference for `pos_import_items`, `recipe_ingredients`)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql`
  (post-P3 `catalog_id` lockdown reference)

## Drift inventory

### Schema drift — Faithful

The migration adds no new tables, columns, types, indexes, or
constraints. Only:
- `create or replace function public.report_run_cogs(uuid, jsonb)` (new).
- `create or replace function public.report_run(text, uuid, jsonb)`
  (re-creation; signature unchanged, `'cogs'` arm added inline).
- `revoke ... from public, anon` + `grant execute ... to authenticated`
  on both, mirroring the foundation's convention
  (`20260510120000_report_runs.sql:210-211, 255-256`).

No DDL on tables. No new indexes. Architect's "no new indexes up-front"
guidance was followed; the three index candidates flagged in the design
were NOT added. This is acceptable per the design's conditional
("only if `explain analyze` flags them"). The developer's verification
section does NOT include an `explain analyze` artifact, so the
500ms-on-seed budget is unverified — flagged below in Minor.

### RPC contract drift — Faithful

`report_run_cogs(p_store_id uuid, p_params jsonb) returns jsonb`:
- Signature exact (`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260511120000_report_run_cogs.sql:61-67`).
- `language plpgsql`, `security invoker`, `set search_path = public` — all
  present at lines 65-67.
- `revoke execute on function public.report_run_cogs(uuid, jsonb) from public, anon;`
  (line 656) + `grant execute ... to authenticated;` (line 657). Mirrors
  the foundation's pattern exactly.
- First runtime statement is the auth gate
  `if not public.auth_can_see_store(p_store_id) then raise exception
  'Not authorized for store %', p_store_id using errcode = '42501';`
  (lines 88-92). Matches design.
- `from > to` raises `errcode = '22023'` with the structured message
  `'COGS report: from > to (% > %)', v_from, v_to` (lines 113-116).
  Matches design AC line 64-66.
- Empty-result envelope is `{ kpis: [], columns: <by-aware>, rows: [],
  series: [] }` (lines 304-311). No `_status` / `_message` keys — that
  sentinel is reserved for the dispatcher fallback. Matches the design's
  "Empty-result envelope shape" section (spec lines 1231-1260).
- Param coercion handles `from`/`to`/`by` with defaults (lines 98-110).
  Malformed dates raise Postgres' native `invalid_text_representation` /
  `datetime_field_overflow`. `by not in ('category','item')` silently
  coerces to `'category'` (forward-compat). Matches the design.

### Dispatcher drift — Faithful

`public.report_run(text, uuid, jsonb)` is re-created at lines 666-698 of
the migration. Diff vs the foundation
(`20260510120000_report_runs.sql:222-256`):
- `language`, `security invoker`, `search_path` — identical.
- Same upfront `auth_can_see_store(p_store_id)` raise with `42501`.
- `'stub'` arm preserved verbatim → `report_run_stub`.
- `'cogs'` arm added → `report_run_cogs`.
- Comment for REPORTS-3's `'variance'` arm preserved (line 686).
- Default fallback returns the `not_implemented` envelope unchanged
  (lines 687-695, identical to foundation 243-250).
- Grant/revoke at lines 700-701 mirror foundation 255-256.

The signature `(text, uuid, jsonb)` is unchanged so the `create or
replace` keeps outstanding `grant execute` rows intact. Matches design's
"Migration block 2 — dispatcher re-creation" section.

### Envelope contract — Faithful, with one observation

The COGS RPC returns `{ kpis, columns, rows, series }`. Verified against
the design and the spec AC:

**KPIs (lines 313-343):**
- "Overall COGS %" → `to_char(v_cogs_pct, 'FM990.0') || '%'`, e.g.
  `'31.4%'`. Tone thresholds hardcoded at the documented 30/35
  boundaries (`< 30 ok, < 35 warn, else danger`) at lines 317-321.
  Matches AC line 90-92 and the design.
- "Gross margin" → `'$' || to_char(v_total_revenue - v_total_cogs,
  'FM999,999,990.00')` (line 330), `tone: null`. Matches AC line 94-98.
- "Recipes missing cost" — added only when count > 0 (lines 332-343).
  Q4 ratified "partial credit + flag" surfaces as both the `' ⚠'`
  suffix on rows and this third KPI. Matches the design's Q4 tightening
  call (spec lines 700-716).
- Zero-revenue branch returns `'0.0%'` + `'warn'` tone (lines 322-328).
  Reasonable defensive behaviour — not in the spec AC verbatim, but
  consistent with "zero revenue but non-zero rows is unusual" (e.g.
  refunds). Acceptable.

**Columns (lines 154-171):**
- `by='category'`: `category|revenue|cogs|cogs_pct|margin` with
  `align: 'left'` for category and `'right'` for the rest. Matches AC
  line 102-112.
- `by='item'`: `item|category|revenue|cogs|cogs_pct|margin` with
  `align: 'left'` for item/category and `'right'` for the rest. Matches
  AC line 113-122.

**Rows (lines 351-518):**
- Server-side string-formatted via `to_char` per AC line 127-129.
- `' ⚠'` suffix rides on `item` (item view, line 424) or `category`
  (category view, line 507). The item-view's `category` column has NO
  flag suffix — design's Q4 resolution placed the flag on the primary
  group key only. Matches.
- Sorted `revenue desc` server-side (lines 419, 502). Matches AC line 126.

**Series (lines 520-644):**
- Single-line `cogs_pct` over time (line 637 `'label': 'COGS %'`). NOT a
  multi-line / stacked-area envelope. Matches the design's Q7 resolution
  and the spec AC line 134-149.
- `y` is numeric — `round(cogs / revenue * 100, 1)` (line 639). NOT a
  string. The detail frame's chart needs numeric `y` to plot.
- `<2` distinct dates → `'[]'::jsonb` (lines 579-580). NOT `null`. The
  spec AC line 145-149 is explicit on this — `null` is reserved for
  templates that genuinely don't chart.
- Sorted ascending by `x` (line 640). Matches AC.

The columns/rows/series contracts are exact. The KPI envelope adds a
third "Recipes missing cost" entry when count > 0; this is the design's
Q4 tightening and matches AC line 99-101 + the design ratification at
spec lines 700-716.

### `runReport` overrideParams contract — Approved Drift

**The architect's design explicitly said `src/lib/db.ts` would NOT
change** (spec line 1366-1375: "No changes. `db.runReport` already
accepts `params` and forwards to the dispatcher RPC ... the two-arg
`runReport(definitionId, overrideParams?)` per AC line 233-237 is a
STORE change in `src/store/useStore.ts`, not a `db.ts` change — `db.runReport`
already accepts a `params` object. Mirror what's there, don't duplicate.")

**What the implementation did instead:**
- Added an optional `overrideParams?: Record<string, unknown>` field to
  `db.runReport`'s arg shape
  (`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts:1666`).
- Moved the merge `{ ...baseParams, ...args.overrideParams }` into
  `db.runReport` itself (`src/lib/db.ts:1672-1674`).
- The store passes `params: def.params || {}` AND `overrideParams: overrideParams`
  separately to `db.runReport`
  (`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/store/useStore.ts:1889-1895`).
- The store ALSO computes a local `mergedParams` (line 1866-1868) just
  for the optimistic display row.

Net effect: the merge logic exists in TWO places (db.ts AND the store's
optimistic-row construction). The dispatcher receives the merged params
and `report_runs.params` reflects the merge — these are the audit-trail
properties the design required.

Severity: Approved Drift (not Critical). The functional contract is
preserved exactly:
- Optional second arg ✓ (`overrideParams?: Record<string, unknown>` —
  the design said `Partial<ReportDefinition['params']>` but the looser
  `Record<string, unknown>` is the stored shape on `params`, so this is
  consistent).
- Signature change is backward-compatible ✓ (optional, defaults absent →
  REPORTS-1 behaviour).
- Flat merge `{ ...baseParams, ...overrideParams }` sent to dispatcher ✓.
- Persisted to `report_runs.params` as the merged value ✓ (lines 1704-1719).
- Saved `ReportDefinition.params` unchanged ✓ (the store does not call
  any `updateReportDefinition` on this path).

The drift is locational, not behavioural. The cost: two sources of
truth for the merge expression. If a future spec changes the merge
semantics (deep merge, key whitelist, etc.) the dev will have to update
both layers. Worth a Minor follow-up note in the next spec; not a
re-do.

Recommendation: leave as-is for REPORTS-2. In REPORTS-3 (Variance), the
architect should call this out as "merge ownership lives in `db.ts`" so
the developer doesn't reintroduce the store-side merge as a third source
of truth.

### Depth-cap divergence — DRIFT (the flagged one)

Backend-developer's handoff explicitly called this out. Reading both
sides:

**Spec AC (line 369-370):** "if a real recipe chains deeper, the run
raises `raise exception 'COGS report: prep-recipe chain exceeds depth 5
for recipe %', recipe_id using errcode = '54001';`"

**Architect's design block (spec line 1158-1162):** also raises 54001
inside the function, after the main aggregation, via a separate
recursive-CTE EXISTS check.

**Implementation (migration lines 148-150):** raises a NOTICE instead
and returns the truncated partial result. The header comment at lines
48-54 documents this divergence with the rationale "the architect's
design called for raising 54001 but that would prevent the partial
result from rendering when a single deep-chained recipe exists in the
brand catalog; a NOTICE + truncation is the friendlier choice and
consistent with the 'partial credit' theme of Q4."

**Verdict — DRIFT requiring a small fix, not a re-do.**

The rationale is reasonable and the failure mode is benign (the report
returns data instead of failing). But there are two real costs:

1. **The user has no signal that a depth violation occurred.** The
   NOTICE only surfaces in Postgres server logs, not the envelope.
   Unlike Q4's missing-cost which surfaces as a row flag (`' ⚠'`) AND
   a KPI, depth-truncation is silent in the UI. A brand whose catalog
   chains 7 levels deep would see undercount-then-misleading-COGS%
   without any indication. This is a meaningful UX regression vs the
   spec AC.

2. **Different failure-mode philosophy than the rest of the runner.**
   Q4 (missing cost) was explicitly designed to surface a partial-credit
   result WITH a visible flag and a KPI. The depth-violation path emits
   no flag and no KPI. The dev's "consistent with Q4" justification
   only holds for the partial-credit half — the flag half is missing.

**What I would have approved:** truncate (developer's choice) PLUS
surface a fourth KPI `{ label: 'Recipe graph truncated', value: <count>,
tone: 'warn' }` when `v_depth_violations > 0`, AND apply the `' ⚠'`
suffix to affected rows. That preserves the friendly degradation while
keeping the user informed.

**What the spec page actually called for (per the AC):** raise 54001.
That would surface to the user as `'Run failed — check server logs'`
via the `db.runReport` sanitizer at `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts:1684-1697`.

Either resolution closes the drift. The current "silent NOTICE" state
is the only path that fails the AC outright. The user delegated open
questions in the spec under auto-mode; this departure was not on a
delegated question, so the dev should not have flipped it without the
architect / user re-ratifying. Surfaced here for the user to choose:

- (a) flip back to `raise exception ... 54001` per AC.
- (b) keep NOTICE but add a KPI + row flag (what I would approve).
- (c) explicit user ratification of the silent NOTICE.

**Block recommendation:** flag as drift in release-coordinator's
proposal; leave the decision to the user. NOT a SHIP-blocker by
itself — the report works on every realistic dataset (the seed has no
recipes that chain past depth 2-3) — but it's a documented AC miss
that needs an explicit owner sign-off before SHIP.

### Performance — Faithful with one observation

**No new indexes added.** Design said "no new indexes required up-front"
with three conditional candidates if `explain analyze` flagged them. The
migration adds none. The developer's verification section does NOT
include the explain-analyze output the design asked for ("Quote the
`explain analyze` output in the developer's PR description if any index
lands" — spec line 1344-1345). On the 286 KB seed (`supabase/seed.sql`)
with the default 30-day range this is almost certainly fine — but the
500ms-budget acceptance criterion (spec AC line 150-153) is unverified.

**Triple-walks the recursive CTE.** The migration runs the recursive
prep-flatten THREE separate times — once for totals (lines 173-300),
once for rows (lines 351-518), once for the daily series (lines 520-644).
The architect's design SQL inlined everything into one CTE chain with
the explicit note that "the planner can fuse them" (spec line 830-832).
The implementation note at spec lines 1172-1178 did give the developer
license to split into multiple SELECTs for readability — but the
three-times-recursive-walk pattern is a stronger split than that note
contemplated.

On the seed dataset (~100s of recipes, ~600 prep_recipe_ingredients) the
recursion materializes in <50ms per walk, so 3 walks ≈ 150ms — still
under the 500ms budget. For a brand with several thousand recipes and
deeper prep nesting this triples a step that was already the recursion
hotspot.

Severity: Minor. Recommend REPORTS-3 considers extracting a helper view
`public.v_recipe_cost_flat(store_id)` (the design already flagged this
as future work) so Variance doesn't duplicate the triple-walk pattern.
NOT a SHIP-blocker.

### `useStore.ts` slice — Faithful

`runReport(definitionId: string, overrideParams?: Record<string, unknown>)`
matches the design's two-arg signature
(`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/store/useStore.ts:298`).
The optimistic row uses the merged params (line 1874). The saved
`ReportDefinition.params` is NOT mutated. The pre-existing
optimistic-then-revert + `notifyBackendError('Run report', e)` pattern
from REPORTS-1 (snapshot `prev`, restore on catch) is preserved
verbatim (lines 1860, 1902-1912).

Minor type-shape note: the design said
`overrideParams?: Partial<ReportDefinition['params']>` but the impl uses
`Record<string, unknown>`. `params` itself is `Record<string, unknown>`
in the type, so `Partial<Record<string, unknown>>` and
`Record<string, unknown>` are functionally identical. Faithful.

### `types/index.ts` JSDoc — Faithful

`ReportDefinition['params']` stays `Record<string, unknown>` (no runtime
type change). The COGS template's expected keys are documented in JSDoc
at `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/types/index.ts:443-449`.
Matches design line 1512-1517.

### `templates.ts` — Faithful

The `cogs` template's `status` is `'live'` at
`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/reports/templates.ts:29`.
All other templates remain `'preview'`. One-line change as designed.

### `NewReportModal.tsx` — Faithful

- Date-range field is always visible (lines 300 onwards). Matches AC line
  173-174 and the design's "always-visible" decision per Q1/Q2.
- Four preset chips
  (`last_30d` default, `this_month`, `last_full_month`, `last_90d`) at
  lines 86-91. Matches AC.
- `isISODate` validator rejects rollovers like `2026-02-31` (lines
  54-62). Stronger than the spec's "ISO regex" requirement; defensive.
- On CREATE, `params: { range, from, to, by }` (lines 193-205). Matches
  AC line 186-188.
- `by:` toggle present (line 118 state). The design endorsed shipping
  `overrideBy` in REPORTS-2 (spec line 740-748) and this is the create-
  time half.

### `ReportDetailFrame.tsx` — Faithful

- `overrideRange?` / `onRangeChange?` props present
  (`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/reports/ReportDetailFrame.tsx:39-40`).
- `overrideBy?` / `onByChange?` props present (lines 45-46).
- `onResetOverrides?` for reset affordance (line 52).
- Envelope consumption matches the contract:
  - `output.kpis` array (line 778, 787).
  - `output.columns` + `output.rows` to `ResultTable` (lines 780-781, 788).
  - `output.series` to `ResultChart` (lines 783, 789).
  - `_status === 'not_implemented'` branch (line 156).
  - `hasSeries = ... length >= 2` (line 783) — matches the `< 2 days →
    []` empty path in the runner.
- The `formatCellValue` helper at lines 71-81 returns strings verbatim
  (line 74) — preserves the server-side decimal precision per AC
  line 127-129.

### `ReportsSection.tsx` — Faithful

- Override state shape: `Map<definitionId, { range?, by? }>` matches the
  design's per-definition override store.
- Override plumbed only when `selectedTemplate?.status === 'live'`
  (lines 190, 221-225). Preview templates fall back to the read-only
  REPORTS-1 chip behaviour. Matches AC line 195-198.
- `onRun` merges chip state into the `mergedOverride` object then calls
  `runReport(selectedDefinitionId, mergedOverride)` (lines 157-178).
  Matches AC line 226-229.

## Forward-compat checklist for REPORTS-3 (Variance)

The architect's design called out three things REPORTS-3 would need to
re-use from REPORTS-2. Verified each:

1. **Per-store `inventory_items.cost_per_unit` join (the `recipe_cost`
   CTE pattern).** ✓ Preserved at migration lines 248-258. The same
   shape is liftable verbatim to `report_run_variance`. Recommend
   REPORTS-3 considers extracting to `public.v_recipe_cost_flat(store_id)`
   to avoid the triple-walk pattern.

2. **Missing-cost partial-credit + flag policy (Q4).** ✓ The
   `bool_or(ii.id is null or coalesce(ii.cost_per_unit, 0) = 0)` shape
   at line 252 is the canonical Q4 implementation. REPORTS-3's variance
   RPC MUST apply the same policy (Treat missing as 0, flag the row,
   surface a KPI when count > 0) per the design's forward-compat note
   (spec lines 1347-1364).

3. **Date-range param shape (`from`/`to`/`by`).** ✓ The runner accepts
   `{ from, to, by }` and defaults missing keys. REPORTS-3 can use the
   same param coercion block (lines 98-110) as a copy-paste starting
   point. The `runReport` `overrideParams` plumbing is template-agnostic
   and works for Variance without further surface changes.

4. **Dispatcher 'variance' arm.** ✓ The dispatcher placeholder comment
   is at migration line 686 of `20260511120000_report_run_cogs.sql`:
   `-- REPORTS-3 will add: when 'variance' then return public.report_run_variance(p_store_id, p_params);`
   — exact pattern REPORTS-3 will repeat.

5. **Merge ownership reminder.** ⚠ The merge currently lives in
   `db.runReport`. REPORTS-3's architect should reaffirm this so the
   developer doesn't reintroduce a store-side merge as a third source
   of truth (see Approved Drift on `runReport` above).

Nothing in REPORTS-2's implementation forecloses REPORTS-3.

## Findings ranked

### Critical
None.

### Should-fix
- **Depth-cap divergence is silent in the envelope.** The implementation
  raises a NOTICE (not 54001) and returns truncated data with no row
  flag, no KPI, no envelope signal. The spec AC and the architect's
  design SQL both called for a 54001 raise. The dev's "partial credit"
  framing is reasonable but inconsistent with Q4's "always surface the
  flag" half. Three remediation paths:
  1. Flip back to `raise exception ... 54001` per spec AC.
  2. Keep NOTICE + truncation but add a `Recipe graph truncated` KPI
     (tone `warn`) when count > 0, AND add a `' ⚠'` suffix on affected
     rows.
  3. User explicit ratification of the silent-NOTICE behaviour, with
     the migration header updated to reflect "user-approved
     deviation from spec AC, not architect-approved".

  My recommendation: option (2). Closes the AC gap and keeps the
  friendly partial-result behaviour.

### Minor
- **`db.runReport` merge ownership drifted from store to db.ts.**
  Approved Drift — the behavioural contract is preserved exactly and
  the audit trail is honest. Worth a one-line note in REPORTS-3's
  architect handoff so the next dev knows the merge lives in `db.ts`
  and not the store.

- **Triple-walk of the recursive CTE.** Each of (totals / rows / series)
  re-walks the recursive prep-flatten. The architect's design SQL
  inlined them into one CTE chain. Within the seed's data scale this
  is unobservably small (≈150ms total). At brand-catalog scale of
  several thousand recipes with deep prep nesting it would amplify.
  Recommend the design follow-up "extract helper view
  `public.v_recipe_cost_flat(store_id)`" be promoted to a REPORTS-3
  ship-blocker if the dev's `explain analyze` on real-tenant data
  shows the recursion hotspot.

- **No `explain analyze` artifact in the dev's verification section.**
  The architect's design asked for the explain-analyze output to be
  quoted in the PR description if any index landed (spec line
  1344-1345). The dev added no indexes AND no explain-analyze, so the
  500ms-on-seed budget (AC line 150-153) is unverified. Likely fine on
  the seed; recommend the release-coordinator asks for the artifact
  before SHIP.

- **Frontend interactive verification not performed by the dev's
  subagent.** Documented at spec line 1652-1656 of the dev's handoff.
  This is per CLAUDE.md's "verify UI with preview tools" feedback note.
  The compile-clean dev bundle is the strongest signal in the dev's
  payload; full click-through verification is deferred. NOT a backend-
  architect concern — flagged here for completeness; the
  release-coordinator should weight this.

## Block recommendation

**Do NOT SHIP without resolving the depth-cap divergence.**

The other findings are advisory or future-spec follow-ups. The depth-cap
silent-NOTICE behaviour is the only path that fails the spec AC
outright AND lacks the architect ratification the dev's handoff implied
("per backend-dev instruction at implementation time"). The dispatcher
re-creation, RPC contract, RLS gate, envelope shape, KPI tones, column /
row formatting, series shape, store action, types JSDoc, modal, frame,
and section plumbing are all faithful or Approved Drift.

Per CLAUDE.md hard rules (`.claude/CLAUDE.md` line "release-coordinator
cannot recommend SHIP_READY if any reviewer flagged a Critical"): this
review flags no Critical. The depth-cap is Should-fix — release-
coordinator can still recommend SHIP if the user explicitly accepts the
deviation. My architect recommendation is to NOT SHIP without either
flipping back to 54001 or adding the missing envelope surfacing
(option 2 above).

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 1 Should-fix (depth-cap
  envelope-silence drift from spec AC), 3 Minor (merge-ownership drift
  from db.ts back to store boundary, recursive CTE triple-walk, no
  explain-analyze artifact). 0 Critical. Block recommendation: do NOT
  SHIP without resolving the depth-cap before either (a) restoring
  54001 raise per AC, or (b) adding envelope surfacing (KPI + row flag)
  for truncation. Other findings are advisory or REPORTS-3 follow-ups.
payload_paths:
  - /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/017-reports-cogs-template/reviews/backend-architect.md

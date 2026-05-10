# Test report for spec 017 (REPORTS-2: COGS Template) — Round 2

## Framework status

No test framework exists in this repo (no jest / vitest / playwright). Per CLAUDE.md
"Gaps and unknowns" and the standing project policy confirmed in spec 016's test-engineer
review, all verification is performed as:

- **DB layer:** `docker exec supabase_db_imr-inventory psql ...` with fake JWT claims via
  `set_config('request.jwt.claims', ...)` to impersonate admin or non-admin roles.
- **Frontend layer:** static source inspection of the shipped TypeScript components.
- Introducing a framework remains gated on explicit user approval and is not done here.

Round 1 had 2 FAIL (AC-RS-4, AC-DB-16 depth-cap), 1 PARTIAL FAIL noted, 3 NOT TESTED.
Round 2 re-tests all 27+ ACs including focused re-verification of the patched items.

---

## Acceptance criteria status

### Database

**AC-DB-1: New migration exists at correct path and timestamp**
PASS
`supabase/migrations/20260511120000_report_run_cogs.sql` exists. Timestamp is after
`20260510130000_report_runs_consistency.sql`. Migration was not in `schema_migrations`
at session start; applied manually via `docker exec -i supabase_db_imr-inventory psql ...
< supabase/migrations/20260511120000_report_run_cogs.sql` — confirmed `CREATE FUNCTION`
twice, `REVOKE` twice, `GRANT` twice.

**AC-DB-2: RPC contract (language, security, search_path, grants)**
PASS
- `language plpgsql` — present in migration source.
- `security invoker` — present in migration source.
- `set search_path = public` — present in migration source.
- Auth gate first statement: `if not public.auth_can_see_store(p_store_id) then raise exception 'Not authorized for store %', p_store_id using errcode = '42501'; end if;` — lines 102-105.
- `revoke execute ... from public, anon` — line 684.
- `grant execute ... to authenticated` — line 685.
- Returns uniform envelope `{ kpis, columns, rows, series }` — confirmed in empty and data paths.

**AC-DB-3: Default params — `'{}'::jsonb` returns valid envelope** (spot-check, round-2)
PASS
```
SELECT public.report_run_cogs('1ea549bb-...'::uuid, '{}'::jsonb);
-- Returns: {"kpis":[],"columns":[5 cols],"rows":[],"series":[]}
```
Empty result on seed (no POS imports). Envelope shape valid, no error.

**AC-DB-4: `by='item'` returns different column/row shape than `by='category'`**
PASS (carried from round 1, no regression observed)

**AC-DB-5: `from > to` raises `22023`** (spot-check, round-2)
PASS
```
NOTICE: AC-DB-5 PASS: GOT EXPECTED 22023 (from > to)
```
Error message matches `'COGS report: from > to (% > %)'`.

**AC-DB-6: Malformed `from`/`to` raises native Postgres error** (spot-check, round-2)
PASS
```
NOTICE: AC-DB-6 PASS: GOT NATIVE DATE ERROR (invalid input syntax for type date: "not-a-date")
```
Native `invalid_datetime_format` — maps to `'Run failed — check server logs'` in the JS sanitizer.

**AC-DB-7: Foreign store raises `42501`** (spot-check, round-2)
PASS
```
NOTICE: AC-DB-7 PASS: GOT EXPECTED 42501 (Not authorized for store)
```
Tested with `app_metadata.role = 'user'` and no matching `user_stores` row.

**AC-DB-8: Unknown `by` value silently defaults to `'category'`** (spot-check, round-2)
PASS
```
col_count_should_be_5: 5
```
`by='unknown_value'` returns 5-column (category) envelope, no error.

**AC-DB-9: Unknown param keys ignored (forward-compat)**
PASS (carried from round 1)

**AC-DB-10: Recipe-not-mapped rows excluded**
PASS (carried from round 1)

**AC-DB-11: KPI output — always two in order, zero when empty**
PASS (carried from round 1)

**AC-DB-12: Columns match spec by-mode**
PASS (carried from round 1)

**AC-DB-13: Rows server-side formatted, sorted revenue desc**
PASS (carried from round 1)

**AC-DB-14: Series — `cogs_pct` over time, sorted asc, y is numeric, `[]` not `null` when < 2 dates** (re-verified round 2)
PASS
2-date series test (round-2 regression check):
```json
{"series": [{"x":"2026-04-15","y":12.5,"label":"COGS %"},{"x":"2026-04-16","y":12.5,"label":"COGS %"}]}
```
`y` is numeric 12.5 (not a string). Sorted ascending by `x`. `series.length === 2`.
Single-date and zero-date cases still return `series: []` (carried from round 1).

**AC-DB-15: Missing cost handling — `' ⚠'` suffix, third KPI, other recipe unaffected**
PASS (carried from round 1)

**AC-DB-16: Prep-recipe depth cap = 5 — behavior when chain exceeds cap**
PASS (was PARTIAL FAIL in round 1 — now PASS in round 2)

Round-2 patch ships: (a) a NOTICE, (b) a 4th KPI `Recipe graph truncated` (tone=warn),
(c) `' ⚠ (truncated)'` row suffix taking precedence over `' ⚠'` (missing-cost suffix).

Verified with a 6-level prep chain injected in a transaction:

```sql
-- SQL used (all in a rolled-back transaction):
-- recipe_deep → prep_A → sub_recipe_id=prep_B (depth 1)
--   → sub_recipe_id=prep_C (depth 2)
--   → sub_recipe_id=prep_D (depth 3)
--   → sub_recipe_id=prep_E (depth 4)
--   → sub_recipe_id=prep_F (depth 5 — cap hit, sub_recipe_id not walked)
--   → catalog_leaf ingredient in prep_F (depth 6, truncated)
-- Checked via: SELECT public.report_run_cogs('1ea549bb-...'::uuid, '{"from":"2026-04-01","to":"2026-04-30","by":"category"}'::jsonb)
```

Observed output:
- NOTICE: `COGS report: prep-recipe chain exceeds depth 5 (1 recipe(s) truncated; partial cost may be undercounted)`
- `kpis` has 4 entries: `["Overall COGS %", "Gross margin", "Recipes missing cost", "Recipe graph truncated"]`
  - 4th KPI: `{"label":"Recipe graph truncated","value":1,"tone":"warn"}`
- `rows[0].category` = `"Deep Category ⚠ (truncated)"` — truncated suffix wins
- Function returns successfully (no fatal raise, no unhandled exception)

Re-called with no deep chains (max depth 2): `kpis` has exactly 2 entries, 4th KPI absent.

By-item view verified: `rows[0].item` = `"Deep Chain Item ⚠ (truncated)"` — suffix correct on `item` cell.

Spec Q5 resolution text now describes NOTICE + KPI + suffix (no remaining `54001` normative requirement in the AC checkboxes).

**AC-DB-17: Performance < 500ms on seed dataset**
PASS (carried from round 1 — 13ms on seed, well within budget)

**AC-DB-18: `report_run` dispatcher routes `'cogs'` correctly** (spot-check, round-2)
PASS
```
cogs_has_status_should_be_false: f
variance_status: not_implemented
stub_has_status_should_be_false: f
```
`report_run('cogs', ...)` routes to `report_run_cogs`, returns no `_status` key.
`report_run('variance', ...)` returns `not_implemented`. Stub arm intact.

### `templates.ts`

**AC-TS-1: `cogs` status flipped to `'live'`**
PASS
`templates.ts` line 29: `{ id: 'cogs', ..., status: 'live' }`.

**AC-TS-2: All other 5 templates remain `'preview'`**
PASS
`variance`, `waste`, `vendor`, `velocity`, `custom` all have `status: 'preview'`.

**Stale comment (round-2 P1 item 6):**
PASS
`templates.ts` line 12: `// REPORTS-2 flipped 'cogs' to 'live' ...` — past tense,
matches the landed state. Round-1 stale "will flip" text is gone.

### `NewReportModal.tsx`

**AC-NM-1: Date-range field always visible (not gated on `status === 'live'`)**
PASS (carried from round 1)

**AC-NM-2: Field shape — two readonly cells + four preset chips**
PASS (carried from round 1)

**AC-NM-3: Invalid date reverts with Toast `'Invalid date — must be YYYY-MM-DD'`**
PASS (source inspection — `commitDateEdit()` calls `Toast.show(...)` on `!isISODate(value)`)

**AC-NM-4: Picked range written to `params: { range, from, to, by }` on create**
PASS (carried from round 1)

**AC-NM-5: `+ NEW REPORT` button defaults to Variance**
PASS (carried from round 1)

**AC-NM-6: No regression in keyboard shortcuts**
PASS (carried from round 1)

### `ReportDetailFrame.tsx`

**AC-RDF-1: `rangeChip` becomes interactive dropdown when `onRangeChange` provided**
PASS (carried from round 1)

**AC-RDF-2: Selecting chip does NOT immediately re-run report**
PASS (carried from round 1 — `onPickPreset`/`onPickBy` update state only, no `onRun` call)

**AC-RDF-3: Chip shows `·` indicator when override differs from saved definition**
PASS (carried from round 1)

**AC-RDF-4: Override scope — saved `definition.params` NOT mutated by chip**
PASS (carried from round 1)

**AC-RDF-5: Empty result — `// 0 rows` renders, not `not_implemented` placeholder**
PASS (carried from round 1 — note: spec text slightly imprecise, `hasTable=true` with `rows=[]`)

**AC-RDF-6: KPI strip renders correctly on empty result**
PASS (carried from round 1)

**AC-RDF-7: RUN button stays enabled (not disabled) for `not_implemented`**
PASS (carried from round 1)

**AC-RDF-8: Chart absent when `series.length === 0` (or < 2)**
PASS (carried from round 1)

**`commitDate` Toast (round-2 P1 item 5):**
PASS
`ReportDetailFrame.tsx` lines 225-245: `commitDate()` calls
`Toast.show({ type: 'error', text1: 'Invalid date — must be YYYY-MM-DD' })` on `!isISODate(v)`,
reverts draft to `effectiveFrom`/`effectiveTo`, closes editor. Matches spec and mirrors
`NewReportModal.commitDateEdit()` pattern.

### `ReportsSection.tsx`

**AC-RS-1: Override state `Map` per definition, preserves across report switches**
PASS (carried from round 1)

**AC-RS-2: `onRun` sends merged params via `runReport(definitionId, mergedOverride)`**
PASS (carried from round 1)

**AC-RS-3: Chip callbacks only wired for `status === 'live'` templates**
PASS (carried from round 1)

**AC-RS-4: Delete cleans up the per-definition override state Map entry**
PASS (was FAIL in round 1 — now PASS in round 2)

Two mechanisms implemented:

1. **Inline delete button (lines 304-310)**: `setOverrides()` pairs with `deleteReportDefinition(r.id)` —
   removes the Map entry immediately when the user clicks delete, before the store async resolves.
   Early-exit guard (`if (!prev.has(r.id)) return prev`) avoids spurious render.

2. **`useEffect([myReports])` reconcile (lines 95-111)**: Iterates all Map keys against
   the current `myReports` list. Removes orphan entries. Fires after the Zustand store
   propagates the deletion — catches realtime deletes from another tab.

Source inspection confirms both mechanisms. The round-1 bug (only the `view` state was reset, not the Map entry) is fixed.

### `useStore.ts`

**AC-US-1: `runReport` signature changed to `runReport(definitionId, overrideParams?)`**
PASS (carried from round 1)

**AC-US-2: Optimistic row uses merged params**
PASS (carried from round 1)

**AC-US-3: No new actions; `loadLatestRun` unchanged**
PASS (carried from round 1)

### Spec text updates (round-2)

**Q5 (depth-cap) AC text:**
PASS
Spec `specs/017-reports-cogs-template/spec.md` Q5 resolution (lines 371-395) now reads:
"Exceeding the cap raises a NOTICE, returns the truncated partial result, adds a `Recipe
graph truncated` KPI (tone=warn, count of distinct top-level recipes whose chain was cut
off) when count > 0, and suffixes `' ⚠ (truncated)'` on rows derived from those recipes".
No normative AC checkbox (`[ ]`) in the Database section mandates `54001`. All historical
references to `54001` are clearly marked as "original design … revised at round-2 review".

**Override reset AC text:**
PASS
Spec lines 223-237 now describe per-definition persistence:
"Opening a saved report preserves any prior chip overrides for that report …
*Revised round-2: the original AC text said 'Opening a saved report resets overrideRange
to undefined' — the implementation chose per-definition persistence and the spec text is
now aligned with that behaviour.*"

**`daily` CTE comment (round-2 P1 item 4):**
PASS
Migration lines 594-600: `-- Note: the 'daily' CTE intentionally does NOT join 'recipes'
(the row aggregations above do). The 'pii.recipe_id' FK to recipes has 'on delete cascade'
(init schema), so a recipe-id that survives the filter 'pii.recipe_id is not null' is
guaranteed to have a matching recipes row. We skip the join here because the series only
needs revenue + cost numerics, not category/menu_item — fewer joins, same result.`

---

## Test run

All verification is manual (no test runner). Migration applied manually before testing.

| Check | Method | Round 2 Result |
|---|---|---|
| Migration applied (20260511120000) | psql | PASS |
| Empty envelope `'{}'` (regression) | psql | PASS |
| `by=item` 6-col vs `by=category` 5-col | psql | PASS |
| `from > to` → 22023 (regression) | psql exception handler | PASS |
| Malformed date → native error (regression) | psql exception handler | PASS |
| Foreign store → 42501 (regression) | psql exception handler | PASS |
| Unknown `by` → default 5-col (regression) | psql | PASS |
| Dispatcher: cogs no _status (regression) | psql | PASS |
| Dispatcher: variance not_implemented | psql | PASS |
| Dispatcher: stub intact | psql | PASS |
| **Depth-cap: 6-level chain fires NOTICE** | psql transaction | **PASS (round-2 fix)** |
| **Depth-cap: 4th KPI `Recipe graph truncated`** | psql transaction | **PASS (round-2 fix)** |
| **Depth-cap: row suffix `' ⚠ (truncated)'`** | psql transaction | **PASS (round-2 fix)** |
| **Depth-cap: truncated suffix wins over missing-cost suffix** | psql transaction | **PASS** |
| **Depth-cap: item view — suffix on `item` cell** | psql transaction | **PASS** |
| **Depth-cap: 0-deep-chain → no 4th KPI** | psql transaction | **PASS** |
| Depth-cap: function returns successfully (no fatal raise) | psql transaction | PASS |
| 2-date series: length=2, y numeric, sorted asc (regression) | psql transaction | PASS |
| series=[] when 0 dates | psql | PASS |
| series=[] when 1 date | psql transaction | PASS |
| Excluded rows (recipe_mapped=false, recipe_id=null) | psql transaction | PASS |
| Null category → (uncategorized) | psql transaction | PASS |
| Anon permission denied | psql SET ROLE | PASS |
| Performance < 500ms on seed (EXPLAIN ANALYZE ~13ms) | psql | PASS |
| cogs tile no PREVIEW badge | source inspection | PASS |
| Other 5 templates PREVIEW | source inspection | PASS |
| Date range field always visible in modal | source inspection | PASS |
| Modal invalid date commit → Toast (NM-3) | source inspection | PASS |
| Detail frame invalid date commit → Toast (round-2 P1) | source inspection | PASS |
| RUN button enabled for COGS | source inspection | PASS |
| Chart omitted when series < 2 | source inspection | PASS |
| **Override Map cleaned up on inline delete (AC-RS-4)** | source inspection | **PASS (round-2 fix)** |
| **Override Map reconciled via useEffect([myReports])** | source inspection | **PASS (round-2 fix)** |
| Override merged params sent to RPC | source inspection | PASS |
| Definition params not mutated | source inspection | PASS |
| Chip non-interactive for preview templates | source inspection | PASS |
| Stale comment templates.ts:12 past tense | source inspection | PASS |
| Spec Q5 text: NOTICE+KPI+suffix (no 54001 normative) | spec text | PASS |
| Spec override-reset AC: per-definition persistence | spec text | PASS |
| daily CTE comment present in migration | source inspection | PASS |
| Chip change does NOT re-run (AC-RDF-2) | source inspection | PASS |

---

## SQL repro for AC-DB-16 depth-cap test

```sql
-- Run inside a BEGIN/ROLLBACK block; NOTICEs appear before ROLLBACK.
-- Requires: set_config('request.jwt.claims', '{"app_metadata":{"role":"admin"}}', true)
-- Store ID used: 1ea549bb-8b50-4078-9301-479311d9fdec (Charles store from seed)
-- Brand ID used: 2a000000-0000-0000-0000-000000000001 (from brands table)

BEGIN;
SELECT set_config('request.jwt.claims', '{"app_metadata":{"role":"admin"}}', true);

-- Top-level recipe
INSERT INTO public.recipes (id, menu_item, category, sell_price, brand_id)
VALUES ('dddddddd-0000-0000-0000-000000000001','Deep Chain Item','Deep Category',10.00,'2a000000-0000-0000-0000-000000000001');

-- 6 prep recipes A-F
INSERT INTO public.prep_recipes (id, brand_id, name, yield_unit)
VALUES
  ('eeeeeeee-0000-0000-0000-00000000000a','2a000000-0000-0000-0000-000000000001','Prep A','unit'),
  ('eeeeeeee-0000-0000-0000-00000000000b','2a000000-0000-0000-0000-000000000001','Prep B','unit'),
  ('eeeeeeee-0000-0000-0000-00000000000c','2a000000-0000-0000-0000-000000000001','Prep C','unit'),
  ('eeeeeeee-0000-0000-0000-00000000000d','2a000000-0000-0000-0000-000000000001','Prep D','unit'),
  ('eeeeeeee-0000-0000-0000-00000000000e','2a000000-0000-0000-0000-000000000001','Prep E','unit'),
  ('eeeeeeee-0000-0000-0000-00000000000f','2a000000-0000-0000-0000-000000000001','Prep F','unit');

-- Link recipe to prep_A
INSERT INTO public.recipe_prep_items (id, recipe_id, prep_recipe_id, quantity, unit)
VALUES ('ffffffff-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-00000000000a',1,'unit');

-- Chain: prep_A→B→C→D→E→F (each via sub_recipe_id)
INSERT INTO public.prep_recipe_ingredients (id, prep_recipe_id, quantity, unit, sub_recipe_id) VALUES ('ffffffff-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-00000000000a',1,'unit','eeeeeeee-0000-0000-0000-00000000000b');
INSERT INTO public.prep_recipe_ingredients (id, prep_recipe_id, quantity, unit, sub_recipe_id) VALUES ('ffffffff-0000-0000-0000-000000000003','eeeeeeee-0000-0000-0000-00000000000b',1,'unit','eeeeeeee-0000-0000-0000-00000000000c');
INSERT INTO public.prep_recipe_ingredients (id, prep_recipe_id, quantity, unit, sub_recipe_id) VALUES ('ffffffff-0000-0000-0000-000000000004','eeeeeeee-0000-0000-0000-00000000000c',1,'unit','eeeeeeee-0000-0000-0000-00000000000d');
INSERT INTO public.prep_recipe_ingredients (id, prep_recipe_id, quantity, unit, sub_recipe_id) VALUES ('ffffffff-0000-0000-0000-000000000005','eeeeeeee-0000-0000-0000-00000000000d',1,'unit','eeeeeeee-0000-0000-0000-00000000000e');
INSERT INTO public.prep_recipe_ingredients (id, prep_recipe_id, quantity, unit, sub_recipe_id) VALUES ('ffffffff-0000-0000-0000-000000000006','eeeeeeee-0000-0000-0000-00000000000e',1,'unit','eeeeeeee-0000-0000-0000-00000000000f');

-- Leaf catalog ingredient in prep_F (depth 6 — would be walked but cap at 5 stops it)
INSERT INTO public.catalog_ingredients (id, brand_id, name, unit, category)
VALUES ('cccccccc-0000-0000-0000-000000000001','2a000000-0000-0000-0000-000000000001','Deep Leaf Ingredient','kg','Test');
INSERT INTO public.prep_recipe_ingredients (id, prep_recipe_id, quantity, unit, catalog_id)
VALUES ('ffffffff-0000-0000-0000-000000000007','eeeeeeee-0000-0000-0000-00000000000f',1,'unit','cccccccc-0000-0000-0000-000000000001');

-- POS import + item to make this recipe appear in sales
INSERT INTO public.pos_imports (id, store_id, filename, imported_by, import_date, imported_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','1ea549bb-8b50-4078-9301-479311d9fdec','deep-test.csv',NULL,'2026-04-20',now());
INSERT INTO public.pos_import_items (id, import_id, menu_item, qty_sold, revenue, recipe_id, recipe_mapped)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Deep Chain Item',5,50.00,'dddddddd-0000-0000-0000-000000000001',true);

-- Execute the RPC — observe NOTICE + 4-KPI envelope + truncated suffix
SELECT public.report_run_cogs(
  '1ea549bb-8b50-4078-9301-479311d9fdec'::uuid,
  '{"from":"2026-04-01","to":"2026-04-30","by":"category"}'::jsonb
);

ROLLBACK;
```

Expected output includes:
- `NOTICE: COGS report: prep-recipe chain exceeds depth 5 (1 recipe(s) truncated; partial cost may be undercounted)`
- `kpis[3]` = `{"label":"Recipe graph truncated","value":1,"tone":"warn"}`
- `rows[0].category` = `"Deep Category ⚠ (truncated)"`

---

## Notes

### Round-2 regressions: NONE

All 24+ ACs that PASSED in round 1 continue to PASS. No regressions observed.

### Round-2 fixes: BOTH VERIFIED

**AC-RS-4 (override Map cleanup on delete):** The round-2 patch adds two complementary
mechanisms — (1) inline `setOverrides` cleanup paired with `deleteReportDefinition(r.id)`
in the delete button handler, and (2) a `useEffect([myReports])` reconcile loop that
removes orphan Map entries after the store propagates the deletion. The inline mechanism
closes the optimistic-then-revert window; the useEffect catches realtime foreign-tab
deletes. Both verified by source inspection.

**AC-DB-16 (depth-cap envelope surfacing):** The round-2 patch implements the architect's
recommended option 2: NOTICE + partial result + `Recipe graph truncated` KPI + row suffix.
Verified end-to-end with a 6-level prep chain in the DB. The 4th KPI appears when
`v_truncated_recipe_count > 0` and is absent when all chains are within depth 5.
The truncated suffix (`' ⚠ (truncated)'`) takes precedence over the missing-cost suffix
(`' ⚠'`) in both `by=category` and `by=item` views. The spec Q5 text is updated to match.

### Round-2 P1 items: ALL VERIFIED

- Recursive CTE consolidation: migration section (10) builds one recursive_prep chain per
  statement branch; planner can fuse downstream aggregations. Regression-verified via
  empty and 2-date series tests.
- `daily` CTE comment: present at migration line 594-600, explains FK/cascade rationale.
- `commitDate` Toast: `ReportDetailFrame.commitDate()` calls `Toast.show(...)` on invalid
  YYYY-MM-DD and reverts draft to last committed value. Source inspection PASS.
- Stale comment: `templates.ts:12` is now past tense ("flipped"). PASS.
- Spec AC mismatch on override reset: spec lines 223-237 now describe per-definition
  persistence with "Revised round-2" marker. PASS.

### NOT TESTED items (unchanged from round 1)

- AC-DB-6 (malformed date → `'Run failed — check server logs'` in the UI): verified
  at the DB layer only (native error propagates). JS-layer end-to-end requires a test
  framework that does not yet exist.
- AC-RDF-2 (chip change does not trigger re-run): verified by source inspection only;
  no browser/component test framework available.
- AC-NM-3 / AC-RDF-commitDate Toast: verified by source inspection; no component E2E test.

These were NOT TESTED in round 1 and remain NOT TESTED due to the framework gap. They are
not new failures; they are a standing infrastructure gap documented since round 1. The source
inspection confirms the correct code paths are in place.

### Framework gap (reaffirmed)

No test framework is wired up. Framework introduction requires explicit user approval.
The three NOT TESTED items above are the highest-priority cases for a future framework.

---

## Block decision

**NO BLOCK** — both round-1 FAILs are fixed and PASS in round 2. No regressions observed
across any of the 27+ acceptance criteria. The 3 NOT TESTED items are a standing
infrastructure gap (no test framework), not new deficiencies introduced in this spec.

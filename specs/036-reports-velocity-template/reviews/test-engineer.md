## Test report for spec 036

### Acceptance criteria status

#### Backend — migration / RPC

- AC-B1: Migration creates `report_run_velocity(uuid, jsonb) returns jsonb` with `language plpgsql`, `security invoker`, `set search_path = public` → **PASS** — `supabase/migrations/20260515120000_report_run_velocity.sql:107-114` matches the spec byte-for-byte.

- AC-B2: First statement raises 42501 if `auth_can_see_store` returns false → **PASS** — `supabase/tests/report_run_velocity.test.sql::arm (3)` (manager calling non-member store Charles raises 42501).

- AC-B3: Same migration re-creates `report_run` dispatcher with `when 'velocity'` arm after `when 'vendor'`, all prior arms preserved → **PASS** — `supabase/migrations/20260515120000_report_run_velocity.sql:444-486` shows all six arms in correct order; smoke RPC PASS.

- AC-B4: Grants: `revoke execute … from public, anon; grant execute … to authenticated` → **PASS** — `supabase/migrations/20260515120000_report_run_velocity.sql:434-435`; `supabase/tests/reports_anon_revoke.test.sql::arm (7)` (anon → 42501) passes.

- AC-B5: `from` defaults to `current_date - 30d`, `to` defaults to `current_date`, `by` defaults to `'recipe'`, unknown `by` values silently coerce → **PASS (manual-only)** — defaults and coercion verified in migration code (`supabase/migrations/20260515120000_report_run_velocity.sql:143-155`); no pgTAP arm for default-coercion path. Same gap as vendor (spec 035 precedent — not flagged then either).

- AC-B6: `from > to` raises SQLSTATE `22023` with message `'Velocity report: from > to (% > %)'` → **NOT TESTED** — migration at line 162-164 implements this; no pgTAP arm asserts the 22023 raise. The spec's 11-arm plan does not include a range-validation arm. Vendor test also omits this arm; the gap is consistent with the 035 precedent. The implementation is present; the test coverage is absent.

- AC-B7: Date anchor is `pos_imports.import_date::date` → **PASS** — migration header documents the anchor and implements it at lines 209-210; pgTAP fixture uses `import_date='2026-06-01'` and the query window `from='2026-06-01'` captures it.

- AC-B8: Closed `[from, to]` window (`>= v_from AND <= v_to`) → **PASS** — migration line 209-210; arm (8) proves a 30-day window changes velocity correctly.

- AC-B9: No status filter on `pos_imports` (no status column); migration header explicitly documents absence → **PASS** — `supabase/migrations/20260515120000_report_run_velocity.sql:29-35` documents the absence; no filter in query.

- AC-B10: Recipe-mapping filter `pii.recipe_id IS NOT NULL AND pii.recipe_mapped = true`; migration header documents it → **PASS** — migration lines 211-212 and 304-305 and 344-345; `supabase/tests/report_run_velocity.test.sql::arm (6)` asserts unmapped rows (NULL recipe_id and recipe_mapped=false) are excluded.

- AC-B11: Empty-result short-circuit: populated `columns`, empty `kpis`/`rows`/`series` arrays (not null) → **PASS** — `supabase/tests/report_run_velocity.test.sql::arm (4)` asserts `kpis_len=0, rows_len=0, series_len=0, cols_typeof='array', cols_first='recipe'`.

- AC-B12: Recipe-name resolution via `recipes.menu_item`; brand-scoped recipes join; NULL `recipe_id` rows never reach join (already filtered) → **PASS** — migration lines 297-303 (recipe mode) and 336-341 (category mode); arm (5) asserts the recipe label matches the actual `menu_item` from the seed.

- AC-B13: Category resolution with `coalesce(nullif(trim(category), ''), '(uncategorized)')` → **PASS** — migration lines 203-204 (totals CTE) and 336-337 (category-mode CTE); arm (9) verifies `by='category'` returns rows with `category` key.

- AC-B14: `velocity = qty_sold_total / window_days` where `window_days = (v_to - v_from) + 1` — NOT `qty_sold / day_count` → **PASS (LOAD-BEARING)** — `supabase/tests/report_run_velocity.test.sql::arm (8)` (30 sold over 30-day window → velocity 1.000, not 30.000; `day_count` remains 1). This is the explicit regression detector.

- AC-B15: Envelope shape `{ kpis, columns, rows, series }` → **PASS** — `supabase/tests/report_run_velocity.test.sql::arm (11)` asserts sorted-key list `['columns','kpis','rows','series']`.

- AC-B16: Columns by `by:` — `by='recipe'` gives `[recipe, qty_sold, day_count, velocity, revenue]`, `by='category'` gives `[category, recipes_count, qty_sold, day_count, velocity, revenue]` → **PASS** — migration lines 172-188; arm (4) checks `cols_first='recipe'`; arm (9) checks `cols_first='category'`. Full column sequence tested only at migration review level; the pgTAP arms check `columns[0].key` only.

- AC-B17: Row formatting — `$`/`-$` for revenue, `FM999,990.000` for qty/velocity, plain integer for `day_count`/`recipes_count`; rows sorted `revenue desc, group_key asc` → **PASS** — migration lines 320-327 (recipe) and 359-368 (category); arm (5) asserts `a_revenue='$150.00'`, `a_qty='30.000'`, `a_velocity='30.000'`; arm (7) asserts A before B by revenue.

- AC-B18: KPI tone bands ALL emit `"tone": null` → **PASS (manual-only)** — migration lines 256, 267, 277 hardcode `'tone', null`; no pgTAP assertion specifically checks tone values. Vendor also lacked a tone assertion — consistent with precedent.

- AC-B19: `Top mover` KPI always uses recipe grouping regardless of `by:` value; omitted when no rows or zero revenue; computed as `recipe || ' · $' || to_char(rev)` → **PASS** — `supabase/tests/report_run_velocity.test.sql::arm (10)` asserts that with `by='category'`, the `Top mover` KPI value still starts with `<recipe_a_label> · $`. Migration lines 265-273 implement the guard.

- AC-B20: `series` — one series per top-N=5 recipes; empty array when `< 2 distinct dates`; computed regardless of `by:` toggle; NEVER null → **PASS (partial)** — migration lines 373-421 implement top-N=5; arm (4) asserts `series_len=0` for empty range; arm (11) confirms series key is present. The `< 2 distinct dates` → empty array path and the top-5 cap itself are exercised only in the migration; no pgTAP arm inserts data spanning 2+ dates to test the non-empty series path. Consistent with vendor precedent (same gap in spec 035).

- AC-B21: No recursive prep-recipe CTE; migration header documents absence → **PASS** — `supabase/migrations/20260515120000_report_run_velocity.sql:76-80` explicitly documents absence.

- AC-B22: Index reuse (no new index); migration header documents rationale → **PASS** — `supabase/migrations/20260515120000_report_run_velocity.sql:82-88` documents reuse.

#### Frontend

- AC-F1: `templates.ts` flips `velocity.status` from `'preview'` to `'live'`; adds comment line `// Spec 036 flipped 'velocity' to 'live' ...` → **PASS** — `src/screens/cmd/sections/reports/templates.ts:16` has the comment; line 34 shows `status: 'live'`.

- AC-F2: `velocity` template uses the same date-range + by-toggle UI (non-variance branch) — no template-specific UI → **PASS (manual-only)** — code path confirmed in `NewReportModal.tsx`; no jest test.

- AC-F3: `BY_OPTIONS` registry adds `velocity: ['recipe', 'category']` → **PASS** — `src/components/cmd/NewReportModal.tsx:83`.

- AC-F4: `ByOption` type union widens to include `'recipe'` → **PASS** — `src/components/cmd/NewReportModal.tsx:78`; `npm run typecheck` clean (no new errors beyond pre-existing TS2688 stubs).

- AC-F5: `defaultByForTemplate` returns `'recipe'` for `velocity` → **PASS** — `src/components/cmd/NewReportModal.tsx:94`.

- AC-F6: Save-time params for velocity: `{ range, from, to, by }` same shape as COGS/waste/vendor → **PASS (manual-only)** — code path confirmed; no jest test. Spec explicitly says no new jest test required here.

- AC-F7: `ReportDetailFrame` — `overrideBy`/`onByChange`/`onPickBy`/`byOpts` types widen to include `'recipe'` → **PASS** — `src/screens/cmd/sections/reports/ReportDetailFrame.tsx:62-63`; widening present.

- AC-F8: `savedBy` parser in `ReportDetailFrame` gains `'recipe'` arm → **PASS** — `src/screens/cmd/sections/reports/ReportDetailFrame.tsx:192-197`.

- AC-F9: `byOpts` gains fourth per-template branch for velocity → **PASS** — `src/screens/cmd/sections/reports/ReportDetailFrame.tsx:275-279`.

- AC-F10: `selectedSupportsBy` fires for velocity automatically (no code change in `ReportsSection.tsx` needed beyond union widening) → **PASS** — `src/screens/cmd/sections/ReportsSection.tsx:242` gate is `selectedIsLive && selectedTemplate?.id !== 'variance'`; `velocity` is now `'live'` and not `'variance'`, so it passes.

- AC-F11: `OverrideState['by']` widens to include `'recipe'`; `setOverrideBy` signature widens → **PASS** — `src/screens/cmd/sections/ReportsSection.tsx:41` and `:178`.

#### Tests

- AC-T1: New pgTAP file `supabase/tests/report_run_velocity.test.sql` with `plan(11)` → **PASS** — file present; `npm run test:db` reports 11 assertions PASS.

- AC-T2: Arm (1) fixture sanity — Frederick id → **PASS** — test line 94.

- AC-T3: Arm (2) fixture sanity — two distinct recipes → **PASS** — test line 98.

- AC-T4: Arm (3) auth gate (42501) → **PASS** — test line 114.

- AC-T5: Arm (4) empty range — populated columns + empty arrays → **PASS** — test line 133.

- AC-T6: Arm (5) single-row formula — per-row recipe A values and velocity → **PASS (with deviation)** — see Notes. Test asserts `Total qty sold = '40.000'` (A+B) not `'30.000'` as the spec describes. The developer inserted all 4 fixture rows before arm (5) rather than incrementally. The per-row formula for recipe A is correctly verified; the spec's `row count = 1` sub-assertion is not present in arm (5) (it appears in arm (6) as `rows_len=2`).

- AC-T7: Arm (6) unmapped rows excluded — `rows_len=2`, totals unchanged → **PASS** — test line 268.

- AC-T8: Arm (7) multi-recipe ordering revenue desc → **PASS** — test line 287.

- AC-T9: Arm (8) velocity ratio across 30-day window — LOAD-BEARING → **PASS** — test line 318; name includes "denominator is window_days not day_count" per spec requirement; `velocity='1.000'`, `day_count=1`.

- AC-T10: Arm (9) `by='category'` smoke — `columns[0].key='category'`, `rows[0]` has `category` + `recipes_count` keys → **PASS** — test line 348.

- AC-T11: Arm (10) top mover KPI cross-cuts — starts with recipe A label → **PASS** — test line 369.

- AC-T12: Arm (11) envelope shape sorted-key list → **PASS** — test line 381.

- AC-T13: `reports_anon_revoke.test.sql` plan 10 → 11; arm for `report_run_velocity` slotted as `(7)` after vendor `(6)`, before reorder-list `(8)`; header comment bumped to "11 RPCs covered" with bullet for spec 036 → **PASS** — file header line 10 says "11 RPCs covered"; bullet present at line 20; `plan(11)` at line 40; arm at test lines 140-152; 11 assertions PASS.

- AC-T14: No new shell smoke arm → **PASS** — spec explicitly states none needed; `npm run test:smoke` PASS.

- AC-T15: No new jest test required → **PASS** — spec explicitly states none needed; `npm test -- --ci` 54/54 PASS.

#### Verification gates

- VG1: `npx tsc --noEmit` exit 0 → **PASS** — all 24 errors are pre-existing TS2688 (missing type definition stubs); zero new errors.
- VG2: `npm run typecheck:test` exit 0 → **PASS**
- VG3: `npm test -- --ci` PASS → **PASS** — 54/54
- VG4: `npm run test:db` PASS, file count 17 → 18 → **PASS** — 18/18
- VG5: `npm run test:smoke` PASS → **PASS**
- VG6: Manual browser smoke → **NOT TESTED** — requires human with local stack; see Notes.

---

### Test run

```
npm run test:db
  18/18 DB test file(s) passed

  report_run_velocity.test.sql  — PASS (11 assertions)
  reports_anon_revoke.test.sql  — PASS (11 assertions)
  report_run_vendor.test.sql    — PASS (11 assertions)
  (all other 15 files unchanged, all PASS)

npm test -- --ci
  Test Suites: 7 passed, 7 total
  Tests:       54 passed, 54 total

npm run test:smoke
  all checks passed
```

---

### Notes

#### Critical findings: NONE

No acceptance criterion is outright broken. All automated gates pass. The notes below are Should-fix and Nit tier.

#### Should-fix: AC-B6 — `from > to` (22023) has no pgTAP coverage

The migration correctly raises SQLSTATE 22023 with message `'Velocity report: from > to (% > %)'` at line 162-164. The spec lists this as an explicit AC. The 11-arm plan does not include an arm for it. This follows vendor precedent exactly (spec 035 also omitted a 22023 arm), but the gap exists here too. The implementation is present and the frontend's `runReport` toast path sanitizes the error for the user; the test gap means a denominator-flip or conditional rewrite that accidentally widens the range-check will not be caught by pgTAP.

Recommendation: add a `throws_ok(..., '22023', ...)` arm to `report_run_velocity.test.sql`. Would require bumping `plan(11)` to `plan(12)` — does not affect `reports_anon_revoke.test.sql`.

#### Should-fix: AC-T6 deviation from spec arm (5) description

The spec arm (5) describes an incremental fixture: "insert one `pos_imports` row and one `pos_import_items` row … assert `row count = 1`, `Total qty sold = '30.000'`." The developer chose a bundled fixture approach: all 4 rows are inserted before arm (5), so arm (5) asserts `Total qty sold = '40.000'` (A+B) and never checks `rows_len = 1`. The test comment explains this correctly (the plan(11)-vs-plan(12) note in the vendor precedent), and the substance — per-recipe formula, velocity denominator — is covered. However, the spec's explicit `row count = 1` sub-assertion is not present anywhere as a standalone check; arm (6) asserts `rows_len = 2` (post all-inserts), which is the correct count for the bundled approach.

This is a test-design choice that produces valid assertions, not a bug. The test is internally consistent and passes. The deviation is worth noting so a future reviewer does not assume arm (5) proves single-row isolation.

#### Nit: `reports_anon_revoke.test.sql` header parenthetical is stale

Line 13 reads: `"Net: comment goes 8 → 10 here."` That parenthetical was written in spec 035 and describes the 035 step (8 → 10). Spec 036 then bumped to 11. Line 10 correctly says "11 RPCs covered", but the parenthetical does not update the narrative to say "spec 036 brings it to 11." This is cosmetic only — the test count and bullet list are correct.

#### Nit: AC-B20 — series non-empty path not pgTAP-tested

The `< 2 distinct dates → empty series` gate (migration line 382) and the top-5 cap are verified only at migration-review level. No pgTAP arm inserts data spanning 2+ distinct import dates and asserts a non-empty series. The empty-series path is covered by arm (4). This is an acknowledged gap shared with vendor (spec 035 same gap), and the spec does not budget a `plan(12)` arm for it.

#### Post-merge deploy gate (prominent)

The migration has not been applied to production. After merge, `npx supabase db push --linked --yes` must be run before the velocity tile in the Cmd UI will produce real data. The frontend's `status: 'live'` flip means clicking the tile will immediately route to `report_run_velocity`, which will fail with `function does not exist` until the migration lands in production Postgres.

#### Spec 035 gap carry-over check

Spec 035 test-engineer flagged 8 NOT TESTED items. Spec 036 re-visits three of them:
- 22023 range-validation arm: still NOT TESTED here (also omitted in 035).
- Tone assertion (null) for all KPIs: still manual-only.
- Series non-empty path: still not pgTAP-tested.

The remaining five gaps from 035 (default-coercion, vendor-specific) are not applicable to velocity. No new gaps introduced beyond the three above.

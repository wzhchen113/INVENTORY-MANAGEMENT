# Code review for Spec 036

## Summary

- 0 Critical
- 3 Should-fix (all RESOLVED inline by Main Claude)
- 5 Nits

## Critical

None. All project-policy checks pass: no direct Supabase calls outside `db.ts`, no legacy file edits, no `app.json` slug change, no `window.*` APIs without Platform guards, no `Alert.alert` bypass, no inline color literals, no json-server patterns, no custom `current_setting('jwt...')` SQL, no mis-named realtime channels.

## Should-fix

### S1 — Stale comment in `reports_anon_revoke.test.sql:13` (RESOLVED)

The parenthetical update history note reads "Net: comment goes 8 → 10 here" but the actual count on line 10 now says "11 RPCs covered". Spec 036 bumped the count from 10 to 11 but did not update this trailing phrase.

**Resolution applied by Main Claude before commit.**

### S2 — `report_run_velocity.test.sql:214–258` arm 5 mislabel (RESOLVED)

Arm 5 is labelled "Single-row formula" and its test-name string says "single-row formula" but the fixture inserts four rows (recipe A, recipe B, two unmapped) before arm 5 fires. Spec AC (spec.md:276–287) says "insert one `pos_imports` row and one `pos_import_items` row" with `Total qty sold = '30.000'` / `Total revenue $ = '$150.00'` / `row count = 1`. The implementation asserts `'40.000'` / `'$200.00'` and doesn't assert `row count = 1`. The bundling is explicitly permitted by the spec's per-arm budget note (spec.md:324–327), but the arm 5 test-name claim is misleading.

**Resolution applied by Main Claude before commit** — updated the test-name string and comment to acknowledge the bundled state and explicitly document the plan(11) consolidation matching the spec 035 precedent.

### S3 — `report_run_velocity.sql` velocity ratio lacks explicit numeric cast (RESOLVED)

`supabase/migrations/20260515120000_report_run_velocity.sql:322,364` — `qty / v_window_days` divides `numeric` by `integer`. Postgres produces `numeric` here, so no truncation, but vendor and waste runners use explicit `::numeric` casts on the denominator throughout for defensiveness and consistency. Velocity runner omitted them.

**Resolution applied by Main Claude before commit** — both call sites now use `qty / v_window_days::numeric`.

## Nits

### N1 — `report_run_velocity.sql:120` `v_series_n constant int := 5;` declaration

Variable declaration block layout is consistent with the vendor runner's `constant` placement. Initially flagged as a style nit but actually consistent with sibling runners. **Disregard.**

### N2 — `report_run_velocity.test.sql:6` arm 8 30-day window note

File-level comment for arm 8 reads "30 sold over 30-day window must yield velocity 1.000, NOT 30/day_count=30." Arm 8 (line 319) calls with range `2026-06-01..2026-06-30` (30 days) but fixture only inserted one import on `2026-06-01`. `v_distinct_dates` = 1 so the series CTE short-circuits to `'[]'`. The test doesn't assert anything about the series for arm 8 — only `a_velocity`, `a_days`, `a_qty`. Fine for the denominator check, but a reader might wonder why the chart is empty for a 30-day window. Minor.

### N3 — `report_run_velocity.test.sql:30` fixture-date comment is GOOD

Comment says "Fixture biz_date '2026-06-01' is AFTER the seed pull date (2026-05-02)". Correct defensive practice — calling it out positively.

### N4 — `ReportsSection.tsx:38–41` OverrideState union comment

Lists specs chronologically (034, 035, 036). Good.

### N5 — `ReportDetailFrame.tsx:274` byOpts inline deferral comment

"At five live templates this ternary is the complexity ceiling — promote to a `templates.ts` byOptions field in the next velocity-shaped template's spec (see architect §A0 #4 deferral)." Well-placed deferral note. Structural divergence between modal's `BY_OPTIONS` map and frame's ternary chain is acknowledged. Architect's §A0 #4 deferral is the correct call here.

## Coverage notes (no findings)

- Migration shape mirrors vendor verbatim (SECURITY INVOKER, search_path, GRANT/REVOKE, auth gate).
- Header documents 11 design choices including no-status-filter rationale, top-N=5 series cap divergence, velocity formula.
- Dispatcher arm placed immediately after `'vendor'`.
- pgTAP test fixture uses brand-FK lookup (not the dropped `recipes.store_id` column).
- Frontend wiring across 4 files matches architect §A11 exactly.

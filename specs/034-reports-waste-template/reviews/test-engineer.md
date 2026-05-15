## Test report for spec 034

### Acceptance criteria status

#### Backend — migration and RPC

- AC-B1: Migration creates `report_run_waste(uuid, jsonb)` with `language plpgsql`, `security invoker`, `set search_path = public` → PASS — `supabase/migrations/20260514170000_report_run_waste.sql:63-69`
- AC-B2: First statement raises SQLSTATE `42501` when `auth_can_see_store` returns false → PASS — `supabase/tests/report_run_waste.test.sql` assertion (3)
- AC-B3: Migration re-creates the dispatcher with a new `when 'waste'` arm, preserving `stub`, `cogs`, `variance`, and `not_implemented` fallback → PASS — migration lines 425-460 verified by inspection; dispatcher behavior not independently exercised by pgTAP but covered transitively through `report_run('stub', ...)` smoke and by the auth-gate arm inside `report_run_waste` itself
- AC-B4: Grants: `revoke execute ... from public, anon; grant execute ... to authenticated` → PASS — migration lines 411-412; `supabase/tests/reports_anon_revoke.test.sql` assertion (5)
- AC-B5: `from` defaults to `current_date - 30 days`, `to` defaults to `current_date`, `by` defaults to `'reason'`, unknown `by` coerces to default → NOT TESTED — the parameter coercion path (migration lines 99-111) is implemented but no pgTAP assertion exercises the default or the unknown-value coerce branch
- AC-B6: Range validation: `from > to` raises SQLSTATE `22023` with message `'Waste report: from > to (% > %)'` → NOT TESTED — migration line 116-118 implements it but no assertion calls with `from > to`; `from = to` ALLOWED path is exercised implicitly by test assertions (4)-(11) which all use `from=to=2026-05-02`
- AC-B7: Date window is CLOSED `[from, to]` on `logged_at::date` (inclusive both sides) → PASS — implemented correctly in migration; the test uses `from=to=2026-05-02` so a single-day CLOSED window, demonstrated by results appearing (implicitly confirms `>= and <=` not strict-less)
- AC-B8: Dollar source is `coalesce(waste_log.cost_per_unit, 0) * waste_log.quantity` with no fallback to `inventory_items` → PASS — migration lines 160, 256, 291, 328; missing-cost zero-out asserted in test assertion (8)
- AC-B9: Empty-result short-circuit returns populated `columns` + empty `kpis`/`rows`/`series` (`[]` not null) → PASS — `supabase/tests/report_run_waste.test.sql` assertion (4)
- AC-B10: Item-name resolution via `catalog_ingredients.name` through `waste_log → inventory_items → catalog_ingredients`; orphan `item_id` yields `'(deleted item)'` → NOT TESTED — implemented in migration lines 329-330 but no pgTAP fixture constructs an orphan row to assert the `(deleted item)` path
- AC-B11: Category resolution via `catalog_ingredients.category`; NULL/empty/whitespace coerces to `'(uncategorized)'` → NOT TESTED — implemented in migration lines 290, 330 but no assertion exercises a NULL-category row
- AC-B12: Reason coercion: `coalesce(nullif(trim(waste_log.reason), ''), '(no reason)')` — no enum added → NOT TESTED — implemented in migration line 161 but no assertion uses an empty/null reason; the `no enum` constraint is verifiable by inspection only
- AC-B13: Envelope shape `{ kpis, columns, rows, series }` returned → PASS — `supabase/tests/report_run_waste.test.sql` assertion (10)
- AC-B14: Columns by `by:` value — `by='reason'` yields `[reason, qty, items_affected, dollar_impact]`; `by='category'` same shape; `by='item'` yields `[item, category, qty, unit, dollar_impact]` with no `items_affected` → PASS (partial) — assertion (11) confirms column[0].key flips correctly for `category` and `item`; the full column list shape is not independently asserted but can be inferred from assertion (4) column[0].key for `by=reason`
- AC-B15: Row formatting — `$`/`-$` dollar mask, `FM999,990.000` qty mask, ordered `dollar_impact desc, group_key asc` tiebreaker → FAIL — assertions (5)-(9) produce incorrect results due to seed collision (see Test run section); the tiebreaker is not independently tested with actual tied-dollar rows
- AC-B16: KPI tone bands `< $50 ok`, `$50-$200 warn`, `> $200 danger` → NOT TESTED — no assertion exercises tone values on the KPI objects
- AC-B17: `Top driver` KPI always uses `reason` grouping regardless of `by:`, omitted when no rows → NOT TESTED — no assertion checks the `Top driver` KPI label, value format, or tone; no assertion confirms the KPI is absent from the empty-range envelope
- AC-B18: `series` shape — one per reason, multi-line, `< 2 distinct dates` gate yields `[]`, never `null` → NOT TESTED (partial) — assertion (4) confirms `series_len = 0` for empty range; the `< 2 distinct dates` gate on the fixture is implicitly exercised (all fixture rows share one date so series is `[]` in assertions (4)-(11)), but the `>= 2 distinct dates` path that produces actual series points is never exercised
- AC-B19: No recursive prep-recipe CTE — documented in migration header → PASS by inspection — migration header lines 32-37 document the absence

#### Tests spec

- AC-T1: `report_run_waste.test.sql` plan(11) with all required cases → FAIL — plan declares 11 assertions but 4 of them FAIL due to seed data collision (see below)
- AC-T2: `reports_anon_revoke.test.sql` extended from plan(8) to plan(9) with waste arm at position 5 → PASS — file confirms `plan(9)`, arm (5) covers `report_run_waste`

#### Frontend

- AC-F1: `templates.ts` flips `waste.status` from `'preview'` to `'live'` → PASS — `src/screens/cmd/sections/reports/templates.ts:29`
- AC-F2: `NewReportModal` waste uses same date-range + by-toggle UI as COGS; no template-specific branch needed → PASS — modal reuses the non-variance branch; verified by code inspection (`src/components/cmd/NewReportModal.tsx`)
- AC-F3: By-toggle for waste shows `['reason', 'category', 'item']`; COGS keeps `['category', 'item']` → PASS — `BY_OPTIONS` registry at `src/components/cmd/NewReportModal.tsx:71-75`; default for waste is `'reason'` at line 80
- AC-F4: Save-time params shape `{ range, from, to, by }` same as COGS → PASS by inspection — the modal save path for the non-variance branch produces this shape; no jest test covers this
- AC-F5: `ReportDetailFrame` no template-specific code needed; by-chip strip fires for live waste → PASS — `byOpts` inline at `ReportDetailFrame.tsx:263-266` handles waste three-option case; `selectedSupportsBy = selectedIsLive && selectedTemplate?.id !== 'variance'` at `ReportsSection.tsx:241` passes for waste
- AC-F6: `OverrideState.by` type widened to `'reason' | 'category' | 'item'` → PASS — `ReportsSection.tsx:40`; `setOverrideBy` signature at line 177

#### Verification gates

- AC-V1: `npx tsc --noEmit` exit 0 → PASS (pre-verified by developer; TS2688 noise pre-dates this spec)
- AC-V2: `npm run typecheck:test` exit 0 → PASS (confirmed: exits 0)
- AC-V3: `npm test -- --ci` 54/54 PASS → PASS (confirmed)
- AC-V4: `npm run test:db` 16 files PASS (waste file adds 1, anon file upgrades plan) → FAIL — `report_run_waste.test.sql` fails 4/11 assertions; suite exits non-zero `1/16 DB test file(s) failed`
- AC-V5: `npm run test:smoke` PASS → PASS (confirmed)
- AC-V6: Manual browser smoke (PREVIEW badge gone, modal pre-fill, run, KPI strip, by-chip override, date toggle) → NOT TESTED (manual gate; outside automated coverage)
- AC-V7: `npx supabase db push --linked --yes` deploys migration to prod → NOT TESTED (deploy gate, not automated)

---

### Test run

```
Command: npm run test:db
Result: FAIL — 1/16 DB test file(s) failed

report_run_waste.test.sql  4 failures of 11:
  not ok 5 - Total waste $ KPI sums to $30.00 (...)
             have: $40.00   want: $30.00
  not ok 6 - rows[reason=Spoilage].qty = '2.500' (...)
             have: 5.000    want: 2.500
  not ok 7 - rows[reason=Spoilage].dollar_impact = '$10.00' (...)
             have: $20.00   want: $10.00
  not ok 9 - rows ordered by dollar_impact DESC: Theft ($20) > Spoilage ($10) > Quality issue ($0)
             have: {Spoilage,Theft,"Quality issue"}
             want: {Theft,Spoilage,"Quality issue"}

reports_anon_revoke.test.sql  9/9 PASS
All other 14 files: PASS

jest (npm test --ci):  54/54 PASS (no jest impact from this spec)
npm run test:smoke:    PASS
typecheck:test:        EXIT 0
```

**Root cause of test failures (confirmed via direct DB query):**

The seed database (`supabase/seed.sql`) already contains one committed `waste_log` row for the Frederick store on `2026-05-02`:

```
store_id = Frederick, item_id = 2357914e-..., qty = 2.500, cost = 4.00,
reason = 'Spoilage', logged_at = '2026-05-02 12:00:00+00'
```

The test fixture (`report_run_waste.test.sql:134-144`) inserts Row A with the same store, date, and reason (`Spoilage, qty=2.5, cost=4.00`). Because `begin;...rollback;` framing means the seed row is committed data that is visible inside the transaction, `report_run_waste` sees two Spoilage rows aggregating to `qty=5.000`, `dollar=20.00` — not the expected `2.500`/`$10.00`.

Cascading effects:
- Total waste $ = `$20 (Spoilage doubled) + $0 (Quality issue) + $20 (Theft) = $40` instead of `$30`
- Ordering: Spoilage now ties Theft at `$20`; tiebreaker `reason ASC` puts `Spoilage` before `Theft`, inverting the expected `Theft, Spoilage, Quality issue` order

The fix belongs to the developer, not the test: the fixture must use a date that has no seed waste_log rows for Frederick — for example `'2025-01-15'` — or the insert must use item_id and reason values that don't collide with any seed row. Using `2026-05-02` was an unsafe choice for a spec whose seed was pulled from prod on that exact date.

---

### Notes

**Critical — blocks release**

1. `npm run test:db` FAIL: 4 of 11 assertions in `report_run_waste.test.sql` fail due to seed-collision at `2026-05-02`. The test date matches an existing committed seed row (Frederick, Spoilage, qty=2.5, cost=4.00). Developer must change the fixture date or choose a reason/item combination that does not exist in the seed on that date. Do not change the assertions — the math is correct; the fixture date is wrong.

**Should-fix (untested ACs, not currently blocking with a hard failure)**

2. SQLSTATE `22023` range validation (`from > to`) is implemented in the migration but has no pgTAP assertion. The spec explicitly lists this as a required test case (AC-B6). The test plan only exercises `from = to` (valid) and never the invalid direction.

3. KPI tone (`ok`/`warn`/`danger`) is not asserted anywhere. The tone band logic (`< $50`, `$50-$200`, `> $200`) exists in the migration but is untouched by tests. This is explicitly listed in the spec's KPI tone AC.

4. `Top driver` KPI label, value format, and omission-when-empty are not asserted. The spec calls this out as a named required case.

5. `series` content (when `>= 2 distinct dates`) is never asserted with actual data. Only the empty-array gate is exercised (all fixture rows share `2026-05-02`). A multi-date fixture producing `series` points is not tested.

6. Parameter-coercion defaults (missing `from`/`to`, missing `by`, unknown `by` value) are unasserted. The spec calls out forward-compat coercion explicitly.

7. Orphan `item_id` → `'(deleted item)'` name and NULL category → `'(uncategorized)'` and empty reason → `'(no reason)'` coercions are all unasserted despite being named ACs.

**Nits / gaps that do not block release**

8. `items_affected` column value is never asserted in any test arm. The column header key is correct (from assertion 11 partial coverage) but the actual count computation is unverified.

9. Frontend changes (`BY_OPTIONS`, `ByPopover` widening) have no jest coverage. The spec explicitly states "No new jest test required (no new TS helpers extracted by this spec)" — this is an accepted gap per spec §Tests, not a BLOCK. The COGS `ByPopover` caller still renders correctly post-widening (type is backward-compatible; `'reason'` added to the union does not break COGS which will never send `'reason'` to the server in a way the RPC can't handle).

10. The `npx supabase db push --linked --yes` prod deploy gate must be run by the operator after merge. No automation enforces it. Surface prominently: the migration will not be live in production until explicitly pushed.

11. The `npm run typecheck` (root tsconfig) exits non-zero due to pre-existing TS2688 ambient typedef noise unrelated to this spec. `npm run typecheck:test` exits 0. This is a pre-existing condition, not a spec-034 regression.

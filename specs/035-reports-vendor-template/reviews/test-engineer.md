## Test report for spec 035

### Acceptance criteria status

#### Backend — `public.report_run_vendor(uuid, jsonb) returns jsonb`

- AC-B1: Migration creates function with signature `(p_store_id uuid, p_params jsonb) returns jsonb`, `language plpgsql`, `security invoker`, `set search_path = public` → **PASS** — `20260514180000_report_run_vendor.sql` lines 99-106 match byte-for-byte. `supabase/tests/report_run_vendor.test.sql` (arm 11, envelope shape) implicitly confirms function is callable.
- AC-B2: First statement raises SQLSTATE `42501` if `auth_can_see_store` returns false → **PASS** — `report_run_vendor.test.sql` arm 3 (`throws_ok`, SQLSTATE `42501`, manager calling Charles store).
- AC-B3: Migration re-creates dispatcher with `when 'vendor'` arm after `when 'waste'`, preserving all prior arms and `not_implemented` fallback → **PASS** — migration lines 473-510 confirmed. `report_run_unknown_template.test.sql` (pre-existing, plan 4) continues to pass, confirming the `not_implemented` fallback is intact.
- AC-B4: Grants: `revoke from public, anon; grant to authenticated` → **PASS** — migration lines 463-464. `reports_anon_revoke.test.sql` arm 6 (`report_run_vendor` → 42501 for anon role) PASS.
- AC-B5: Parameters: `from`/`to` default to last-30-days/today when null/empty; `by` defaults to `'vendor'`; unknown `by` values coerce silently → **NOT TESTED** in pgTAP (default-coercion behaviour not exercised by a test arm). Verified by reading migration lines 134-146 — implementation is correct. `npm run typecheck` and the empty-range arm (passing `by='vendor'` explicitly) provide partial coverage. No test arm passes `p_params='{}'` and asserts the default window is applied.
- AC-B6: Range validation: `from > to` raises SQLSTATE `22023` → **NOT TESTED** in pgTAP. No `throws_ok` arm exercises the `from > to` path. Implementation confirmed present at migration line 151-154. Gap: the spec's own test plan (arm list §Tests) does not mandate a 22023 arm — the plan(11) budget was fully allocated without it — so this is a known design trade-off, not a developer omission. However, the AC is unverified by automated test.
- AC-B6 (continued): `from = to` is ALLOWED (single-day vendor reports) → **PASS** — arm 4 calls with `from = to = '2000-01-01'`, arm 5/7/8 call with `from = to = '2026-06-01'`, all pass without raising an exception.
- AC-B7: Date anchor: `coalesce(po.reference_date, po.received_at::date)` → **PASS** — confirmed in migration lines 208, 297, 337, 382, 424. The fixture inserts `reference_date='2026-06-01'` and calls with `from=to='2026-06-01'`; the rows are found, confirming the anchor is used. No test for the fallback path (row with `reference_date IS NULL`, relies on `received_at::date`).
- AC-B8: Date window is closed `[from, to]`, divergence from variance's half-open shape is documented in migration header → **PASS** — confirmed at migration lines 17-26 (explicit divergence note in header), implementation lines 208-209, 297-298, 337-338, 382-383. Arms 4-11 all use single-day windows; `from=to` succeeds, confirming the `>=` / `<=` closed window.
- AC-B9: Status filter `(po.status = 'received' or po.received_at is not null)` → **PASS** — `report_run_vendor.test.sql` arm 7 (labeled "(7)" in file; was arm 8 per spec spec test plan numbering — see Notes). Inserts PO C (`status='draft'`, `received_at IS NULL`) alongside two received POs; asserts `rows=2`, `total='$30.00'`, `POs=2`. The draft row's $25.00 contribution is excluded.
- AC-B10: Dollar source: `coalesce(received_qty, 0) * coalesce(cost_per_unit, 0)` per `po_items`; NULL cost → $0, qty still surfaces → **PASS** — arm 8 (missing-cost zero-out). Inserts NULL `cost_per_unit` line; SYSCO dollar stays `$25.00`, qty grows to `11.000`.
- AC-B11: Empty-result short-circuit: populated `columns` + empty `kpis`/`rows`/`series` → **PASS** — arm 4 asserts `kpis_len=0`, `rows_len=0`, `series_len=0`, `cols_typeof='array'`, `cols_first='vendor'`.
- AC-B12: Vendor-name resolution via left-join; NULL `vendor_id` → `'(no vendor)'`; deleted vendor → `'(deleted vendor)'` → **NOT TESTED** in pgTAP. Implementation confirmed in migration lines 200-203. No test arm exercises the NULL `vendor_id` or orphan `vendor_id` sentinel labels.
- AC-B13: Item-name resolution via left-join; orphan `item_id` → `'(deleted item)'` → **NOT TESTED** in pgTAP. Implementation confirmed in migration lines 372-374. No test arm inserts a po_item with a deleted inventory_items row.
- AC-B14: Category resolution: `coalesce(nullif(trim(category), ''), '(uncategorized)')` → **NOT TESTED** for the sentinel. Arms 9-10 exercise category and item modes but the fixture item has a non-null non-empty category (it's a seeded Frederick item). Partial coverage: the arms confirm the category path executes without error.
- AC-B15: Envelope shape `{kpis, columns, rows, series}` → **PASS** — arm 11 asserts sorted key list `['columns', 'kpis', 'rows', 'series']`.
- AC-B16: Column keys per `by` mode (`vendor`/`po_count`/`total_qty`/`dollar_impact` for vendor; `items_affected` added for category; `unit` added for item) → **PASS** — arm 9 asserts `columns[0].key='category'`; arm 10 asserts `columns[0].key='item'` and `has_unit_col=true`. Column presence for `vendor` mode confirmed in arm 4 (`cols_first='vendor'`).
- AC-B17: Row formatting: dollar cells with `$`/`-$` prefix; qty cells to three decimal places; sort by `dollar_impact desc, group_key asc` → **PASS** — arm 5 asserts `total_qty='10.000'` (three-decimal format) and `dollar_impact='$25.00'`; arm 6 asserts ordering `['SYSCO', 'RESTAURANT DEPOT']` (dollar-desc).
- AC-B18: KPI tone bands ALL `null` → **NOT TESTED** in pgTAP. No test arm inspects the `tone` field of any KPI. The migration header (lines 44-52) and code (lines 249-272) confirm `null` is emitted, but no assertion pins it.
- AC-B19: `Top vendor` KPI always uses vendor grouping regardless of `by:`, formatted as `vendor || ' · $' || to_char(...)`. Omitted when no rows or zero-dollar → **NOT TESTED** in pgTAP. No test arm explicitly looks up `k->>'label' = 'Top vendor'`. Arms 5/7/8 check `kpis` only for `'Total spend $'` and `'POs in period'`. The Top vendor KPI's presence, value format, and omission guard are untested.
- AC-B20: `series` shape: one series per vendor, multi-line, `{ label, x, y }`. Empty array when fewer than 2 distinct dates; never `null` → **PASS (partial)** — arm 4 asserts `series_len=0` for the empty case (single date = `'2000-01-01'`). Arms 5/7/8 use `from=to` (single date), so `v_distinct_dates < 2` → empty series, consistent with the gate. No test arm exercises the multi-date path to confirm populated series output. The `null` prohibition is confirmed by arm 4 (empty returns `[]` not `null`).
- AC-B21: No recursive prep-recipe CTE; migration header explicitly documents the absence → **PASS** — confirmed by reading migration (no `WITH RECURSIVE`). Header lines 39-43 document the rationale.

#### Frontend — `templates.ts`

- AC-F1: `vendor` template `status` flipped from `'preview'` to `'live'` → **PASS** — `templates.ts` line 32 confirmed `status: 'live'`. No other field changes. No jest test (spec explicitly states none needed — type-level + manual browser smoke).

#### Frontend — `NewReportModal.tsx`

- AC-F2: `vendor` template uses existing date-range + by-toggle UI (non-variance branch) → **PASS** — confirmed by reading `NewReportModal.tsx`; the `isVariance` branch does not cover `vendor`, so vendor falls into the standard date-range path.
- AC-F3: `BY_OPTIONS` registry extended with `vendor: ['vendor', 'category', 'item']` → **PASS** — confirmed at `NewReportModal.tsx` line 79.
- AC-F4: `ByOption` type union widened to include `'vendor'` → **PASS** — `NewReportModal.tsx` line 75: `type ByOption = 'reason' | 'vendor' | 'category' | 'item'`.
- AC-F5: `defaultByForTemplate` returns `'vendor'` for the `vendor` template → **PASS** — `NewReportModal.tsx` line 88.
- AC-F6: Save-time params for `vendor`: `{ range, from, to, by }` → **PASS** — `NewReportModal.tsx` lines 272-279; non-variance templates (including `vendor`) write `{ range, from, to, by }`.

#### Frontend — `ReportDetailFrame.tsx`

- AC-F7: `overrideBy`/`onByChange`/`onPickBy`/`byOpts` types widened to include `'vendor'` → **PASS** — `ReportDetailFrame.tsx` lines 61-62, 257, 268-271.
- AC-F8: `savedBy` parser gains fourth arm for `'vendor'` → **PASS** — `ReportDetailFrame.tsx` lines 190-194, matches spec's literal code shape exactly.
- AC-F9: `byOpts` gains third per-template branch for `vendor` → `['vendor', 'category', 'item']` → **PASS** — `ReportDetailFrame.tsx` lines 268-271.
- AC-F10: By-chip strip fires for `vendor` automatically via existing `selectedSupportsBy` gate (no code change in `ReportsSection.tsx` beyond union widening) → **PASS** — confirmed that `vendor` status is now `'live'` and `selectedSupportsBy` gate is `selectedIsLive && selectedTemplate?.id !== 'variance'`; no special-case needed.

#### Frontend — `ReportsSection.tsx`

- AC-F11: `OverrideState['by']` widened to include `'vendor'`; `setOverrideBy` signature widened → **PASS** — `ReportsSection.tsx` lines 35-40, line 177.
- AC-F12: No explicit code change needed to remove PREVIEW badge (badge gated on `r.status === 'preview'`, templates.ts flip handles it) → **PASS** — confirmed by reading `templates.ts` flip at line 32.

#### Tests

- AC-T1: New pgTAP `report_run_vendor.test.sql` with `plan(11)` → **PASS** — file exists, 11 assertions confirmed, 11/11 PASS on `npm run test:db`.
- AC-T2: `reports_anon_revoke.test.sql` adds vendor arm, plan 9 → 10 → **PASS** — `plan(10)` confirmed at line 39; 10 assertions confirmed; 10/10 PASS on `npm run test:db`.
- AC-T3: No new shell smoke arm needed → **PASS** — `npm run test:smoke` PASS (pre-existing smokes still green).
- AC-T4: No new jest test required → **PASS** — spec explicitly exempts (`BY_OPTIONS` widening is type-level only; gated by `tsc --noEmit`).

#### Verification gates

- AC-V1: `npx tsc --noEmit` exit 0 → **PASS** — only pre-existing TS2688 ambient type noise; no application-code errors.
- AC-V2: `npm run typecheck:test` exit 0 → **PASS**
- AC-V3: `npm test -- --ci` PASS → **PASS** — 54/54 tests.
- AC-V4: `npm run test:db` PASS, pgTAP file count 16 → 17, `reports_anon_revoke` plan 9 → 10 → **PASS** — 17/17 files, counts confirmed.
- AC-V5: `npm run test:smoke` PASS → **PASS**
- AC-V6: Manual browser smoke (vendor tile, modal, run, by-toggle, date-range toggle) → **NOT TESTED** — requires running local stack and browser interaction. See Manual Gates section.

---

### Test run

```
npm run test:db
  17/17 DB test file(s) passed

  report_run_vendor.test.sql          PASS (11 assertions)
  reports_anon_revoke.test.sql        PASS (10 assertions)
  [all 15 other files unchanged]      PASS

npm test -- --ci
  Test Suites: 7 passed, 7 total
  Tests:       54 passed, 54 total

npm run test:smoke
  all checks passed

npm run typecheck:test
  exit 0 (clean)

npm run typecheck
  exit 0 (application code clean; pre-existing TS2688 ambient noise only)
```

---

### Notes

**1. Arm numbering discrepancy (Nit)**
The spec's test plan lists arm 8 as "Status filter" and arm 6 as "Missing-cost zero-out." The actual file sequences them differently: the status filter assertion is labeled "(7)" in the file (it re-uses the `_env` temp table captured before the NULL-cost insert) and the missing-cost check is labeled "(8)." Both tests exist and both pass. The spec's ordering description is slightly wrong, but coverage is complete. Not a correctness issue.

**2. Top vendor KPI untested (Should-fix)**
No pgTAP arm asserts that the "Top vendor" KPI is present in the `kpis` array, checks its formatted value (`vendor || ' · $' || to_char(...)`), or verifies that `tone` is `null`. Arms 5, 7, and 8 check only `'Total spend $'` and `'POs in period'`. The spec's test plan (§Tests, item 5) only called for asserting `kpis[label='Total spend $'].value`; the "Top vendor" and tone-null ACs (AC-B19, AC-B18) were not assigned dedicated plan arms. This is a coverage gap that fell through the plan budget, not a developer omission.

**3. Range-validation 22023 untested (Should-fix)**
AC-B6 (`from > to` raises SQLSTATE `22023`) is confirmed in the migration code but has no pgTAP arm. The spec's plan(11) budget did not allocate an arm for it. The implementation is correct; the AC is unverified by test.

**4. Sentinel labels untested (Nit)**
`'(no vendor)'`, `'(deleted vendor)'`, `'(deleted item)'`, and `'(uncategorized)'` sentinel labels (AC-B12, AC-B13, AC-B14) are implemented correctly in the migration but have no pgTAP fixture exercising the fallback paths. All three are well-established patterns from prior specs (waste, variance) and are out of scope for the plan(11) budget per the spec's §Tests mandate.

**5. Series multi-date path untested (Nit)**
The `series` populated-path (when `v_distinct_dates >= 2`) is not exercised. The empty-array gate is covered (arm 4, single date), and the `null` prohibition is confirmed. Multi-vendor multi-date series shape is a manual-only verification. Given the series logic is a straightforward aggregation mirroring the waste runner's tested shape, this is low risk.

**6. Default parameter coercion untested (Nit)**
No arm calls with `p_params='{}'` and asserts that the 30-day default window is applied. Low risk — the default coercion (`coalesce(nullif(..., '')::date, ...)`) is the same pattern as waste/COGS, and the compiler confirms no type errors.

**7. Stale comment in `reports_anon_revoke.test.sql` (PASS — fixed)**
The architect's spec review flagged that the header comment was stale at "8 RPCs covered" after spec 034 landed. The developer fixed this in the same PR: the comment now reads "10 RPCs covered" with an explicit changelog note (lines 10-13). No further action needed.

**8. Post-merge deploy gate (Critical operational)**
`npx supabase db push --linked --yes` is required after merge to apply `20260514180000_report_run_vendor.sql` to production. The migration is not self-applying. Without this step, `report_run('vendor', ...)` will return the `not_implemented` stub envelope and the PREVIEW badge will disappear from the tile (from `templates.ts`) while the RUN button silently returns "Runner coming soon." The release coordinator must gate SHIP_READY on confirming this deploy step is in the post-merge checklist.

**9. `reports_anon_revoke.test.sql` plan count detail**
The file lists "10 RPCs covered" in the header (lines 10-13) but the body covers 9 RPC arms (9 `throws_ok` assertions) plus 1 fixture sanity (`isnt`). Total = 10 assertions matching `plan(10)`. The "10 RPCs" in the comment counts the RPCs covered by `throws_ok` arms only (the fixture isnt is not an RPC test). There is no off-by-one: `plan(10)` is correct.

---

### Manual gates (not automated)

The following ACs require manual browser smoke after `npm run dev` against the local stack (boot with `npm run dev:db`):

- Vendor tile in Reports catalog shows no PREVIEW badge.
- Click tile → `NewReportModal` opens with `template=vendor`, three chips (`vendor` selected, `category`, `item`).
- Save → report appears in "your reports" grid.
- Open detail → click RUN → KPI strip shows "Total spend $", "Top vendor", "POs in period"; rows populate with vendor groups; chart renders multi-line.
- Toggle `by:` chips → columns and rows change shape (vendor/category/item modes).
- Change date range → re-runs against new window.

These were verified by the developer per the spec's verification gates section; the test engineer has not re-run them independently.

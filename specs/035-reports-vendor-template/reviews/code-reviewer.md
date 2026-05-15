## Code review for spec 035

### Critical

None.

### Should-fix

- `supabase/migrations/20260514180000_report_run_vendor.sql:112,228` — `v_total_qty` is declared as a plpgsql variable, populated via the `totals` CTE SELECT INTO at line 228, and then never referenced again. The waste runner (the precedent) emits `v_total_qty` as the "Total qty wasted" KPI at waste:216; the vendor spec intentionally has only three KPIs (Total spend $, Top vendor, POs in period) with no "Total qty" KPI. The dead variable will survive copy-paste into future runners without a compile error, misleading future maintainers into thinking a "Total qty" KPI was intended or was accidentally dropped. Remove `v_total_qty` from the declare block and from the SELECT INTO target list, or add a brief comment explaining why it is kept if a future KPI is planned.

- `supabase/tests/report_run_vendor.test.sql:188-215` — Arm 5 is labeled "Single-row happy path" but the fixture inserted immediately before it includes two received POs (SYSCO + RESTAURANT DEPOT) and one draft PO (PO C). The assertion therefore tests `total_spend = '$30.00'` (two-vendor sum) rather than the spec AC's stated `'$25.00'` for a single-vendor insert with row count = 1 (spec.md lines 241-245). The test comment references "architect §A6 condensation note" to justify the consolidation, but no such note exists in `spec.md` or any review file in `specs/035-reports-vendor-template/reviews/`. The deviation from the AC is undocumented. If the consolidation was approved by the architect offline, add the justification inline (e.g. "architect pre-approved combining arms 5/6/7 into one fixture to stay within plan(11) — see <reference>"); otherwise split arm 5 into a single-vendor fixture matching the AC.

### Nits

- `src/components/cmd/NewReportModal.tsx:124` — The `by` state hook's type annotation is written as the inline literal `'reason' | 'vendor' | 'category' | 'item'` rather than the `ByOption` alias defined at line 75 of the same file. Inconsistency within the file; using `ByOption` would mean future additions to the union only need one edit.

- `supabase/migrations/20260514180000_report_run_vendor.sql:13-15` — The design-note header bullet says "Shared analytic keys: po_count, items_affected, total_qty, unit" but `items_affected` is only present in the `by='category'` column set (migration line 170) and absent from `by='vendor'` and `by='item'`. Similarly, `unit` is only in `by='item'`. Calling them "shared" is slightly misleading; the waste precedent header is more precise about which keys are per-mode. A small wording fix ("Per-mode shared keys vary by mode: ...") would match the reality.

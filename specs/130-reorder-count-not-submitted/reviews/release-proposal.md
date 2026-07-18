## Verdict
verdict: SHIP_READY
rationale: Zero Criticals across all reviewers, every Should-fix/Minor/nit resolved post-review, and full jest + typecheck + i18n parity are green on a frontend-only change with no migration.

## Findings summary
- code-reviewer: 0 Critical, 2 Should-fix, 2 Nits. Predicate correctly centralized (`isReorderCountNotSubmitted`, `eodSubmittedAt == null`), imported by both screens with no inline re-derivation; un-counted vendors filtered out of the needs/enough split + KPI + export gate; not-submitted actions genuinely unmounted (verified against the render tree). Both Should-fix items (staff group-header vendor count missing; duplicated VendorCard header markup) and both nits (vestigial "stock fallback" sub-stat; unconditional `itemTone`) addressed by main Claude after review.
- security-auditor: not invoked — deliberate, documented skip. Pure UI branching on `eodSubmittedAt`, a field already present in the `report_reorder_list` payload; no new data access, no RPC/RLS/edge-function surface, no new query. No security-relevant change to audit.
- test-engineer: 8 ACs PASS, 0 FAIL, no coverage gaps. All 4 high-risk ACs pass (no order qty for un-counted; KPIs/export exclude un-counted; counted vendors unchanged; both surfaces covered). Full jest green; predicate pinned as a pure unit test; i18n locale-parity suites pass. One non-blocking residual: no live-browser spot-check of the seeded un-counted-vendor visual state (preview tooling unavailable) — behavior is fully pinned by jest testID/text/KPI assertions.
- backend-architect: 0 Critical drift, 2 Minor. Implementation matches the design on all five confirmation points (no backend change; shared predicate; filter-before-split/KPI/export; header-kept/rows-replaced/actions-hidden on both surfaces; `computeReorderKpis` stays pure). Both Minors (always-zero "stock fallback" KPI sub-count; dead `showExport` prop on admin not-submitted card) resolved — sub-stat repurposed to show the "Count not submitted" vendor count on both strips; dead prop made optional and removed from that path.

## Recommended next steps (ordered)
1. Commit and push (frontend-only; no prod-apply, no migration).
2. On push, confirm the latest `test.yml` run on `main` is green; `db-migrations-applied.yml` is unaffected (no migration) and should stay green — verify per the CI-status rule before resuming pipeline work.
3. (Optional, non-blocking) Live/manual spot-check of the un-counted-vendor card against a store with a genuinely missing EOD for the selected date, to close the visual-treatment loop the jest suites can't cover.

## Out of scope for this review
- The `noSchedule` edge case (an un-counted no-schedule vendor stays inside the collapsed no-schedule group rather than the dedicated top group) is an explicitly accepted v1 limitation per the architect's design — not a defect, would be a separate follow-up if ever revisited.
- Any change to `report_reorder_list`, its SQL, the reorder math, or the EOD-vs-stock detection — spec-excluded; this feature branches on an existing payload signal only.

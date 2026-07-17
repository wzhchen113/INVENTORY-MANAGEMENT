# Release proposal — spec 126 (staff Settings page + report-an-issue)

## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical or High; both code Should-fixes are resolved or accepted with architect concurrence, all 11 acceptance criteria pass, and the anti-forgery boundary is confirmed server-side.

## Findings summary
- code-reviewer: 0 Critical, 2 Should-fix, 4 Nits. Should-fix #2 (missing client-side `maxLength` on the report input) RESOLVED — added `maxLength={2000}` matching the server CHECK; tsc clean, Settings jest 7/7. Should-fix #1 (`mapNotification` `?? undefined` vs `?? null`) ACCEPTED AS-IS — `?? undefined` is correct for the optional `body?`/`category?` display fields; architect independently rated the difference functionally equivalent (Minor). Nits are the documented five-way sign-out duplication, no shared staff header, an unasserted grant-posture pgTAP arm, and a hardcoded `title` string mirroring spec-121 house style — all non-blocking backlog.
- security-auditor: 0 Critical / 0 High / 0 Medium, 2 Low. The forgery surface collapses to a single server-side `auth_can_see_store` gate that fires before any write; brand/store/reporter/type are all server-derived, never client-supplied; staff (`user` role) cannot read `staff_reports`; no cross-brand notification steering; no XSS/injection sink (RN `<Text>` + `JSON.stringify`). Lows: no rate limit on `submit_staff_report` (mild notification-spam vector, human-paced, message bounded to 2000 chars) and a pre-existing non-constant-time bearer compare from spec 120 (not a regression here). Both backlog.
- test-engineer: 11 PASS / 0 FAIL. pgTAP 12/12 in the new `staff_reports_issue.test.sql` suite, full DB suite 72/72 green; jest 112 suites / 1229 tests; tsc + typecheck:test clean; i18n parity 24/24. All three highest-risk ACs (anti-forgery store gate → arm 4; staff read denial → arm 8; brand-scoped notification visibility → arms 10-12) have direct passing DB/RLS coverage. Two indirect-coverage notes (AC5 LocaleSwitcher live-update reused-as-is; AC6 Settings sign-out is a byte-identical replica of already-tested code) are low-risk, not failures. One genuine but pre-existing gap: the edge-function push-fanout recipient-set construction for the `issue` type is not end-to-end smoke-tested — inherited spec-120/121 posture, not a new regression, and the RLS bell-read proof is the strongest available proxy.
- backend-architect: 0 Critical, 0 Should-fix, 1 Minor. No contract drift — every design decision (two-column notifications, definer RPC + gate-then-write-then-best-effort-notify order, `source_id = report.id` dedup, admin-read-only RLS with no client write policy, fanout `issue` branch, `submitStaffReport` staff carve-out, kept inline switchers, no publication change) landed as specified. Minor: `AdminNotification.body`/`category` typed `string | undefined` vs the prose's `string | null` — functionally equivalent, no action required.

## Recommended next steps (ordered)
1. Commit and push (user confirms the commit; main Claude does not auto-commit).
2. Post-push prod-apply (same push window, main Claude via MCP — already flagged PENDING):
   a. Apply migration `20260720000000_staff_reports_issue_notifications.sql` to prod via MCP `execute_sql`, then insert the exact version `20260720000000` into `supabase_migrations.schema_migrations` (else `db-migrations-applied.yml` turns red).
   b. Redeploy `submission-push-fanout` (ships the `issue` branch + widened select). No realtime container restart needed.
3. Confirm BOTH CI gates are green on `main` after the push — `test.yml` AND `db-migrations-applied.yml` (per the CLAUDE.md post-push rule; the migrations gate is an independent signal). If either is red or in-progress, surface the run URL and hold before closing out.

## Out of scope for this review
- `useStaffSignOut()` extraction to collapse the now five-way sign-out duplication (documented spec decision to replicate, not refactor).
- Shared in-store staff header component so `<SettingsGear />` need not be hand-placed in four header markups.
- Rate limiting on `submit_staff_report` (security Low — revisit only if abuse is observed).
- Non-constant-time shared-bearer compare in `submission-push-fanout` (pre-existing spec-120 code; belongs in its own hardening spec).
- Re-run safety on the `create policy` statement in `20260720000000` (no `drop policy if exists` guard, unlike the table/column/index statements) — a migration-robustness note surfaced by test-engineer, not spec-126 scope.
- End-to-end smoke coverage of the push-fanout recipient-set construction for submission types (pre-existing spec-120/121 gap).
- Grant-posture / standalone CHECK-acceptance pgTAP arms called out by code-reviewer as an optional follow-up.
```

## Verdict
verdict: SHIP_READY
rationale: All Critical findings from the four reviewers were resolved inline by Main Claude pre-dispatch (new RLS-cross-store pgTAP arm 14, jest coverage extracted to `reportParams.test.ts` with 9 cases, UI hint "5s"→"8s", catch-all SQLSTATE P0001→P0501); verification baseline green (63/63 jest, 19/19 pgTAP, smoke PASS, tsc clean), and only acceptably-dispositioned design deviations (Guard 1 unreachability stronger-than-designed; Guard 2 8s role-level timeout) plus polish/follow-up items remain.

## Findings summary
- **code-reviewer**: 0 Critical, 4 Should-fix, 6 Nits. Top issues: missing jest `NewReportModal.test.tsx`, missing pgTAP RLS cross-store arm, `when others` SQLSTATE P0001 collision with `assert_not_last_of_role`, UI hint says "5s" but real budget is 8s. All four Should-fix items were addressed inline (RLS arm 14 added, jest carved out to `reportParams.test.ts` per pure-helper extraction, SQLSTATE→P0501, hint→8s).
- **security-auditor**: 0 Critical, 0 High, 3 Medium, 6 Low. Top issues (all non-blocking): `set_config` GUC mutation enables audit-log attribution forgery (bounded by PostgREST per-request reset), `pg_catalog` system-view readthrough (no row-data exposure; admin-tier audience), `report_definitions.params` SQL readable by store-member user-role (per-store RLS, not per-privilege). Auditor independently exercised every named SQL injection vector against the local stack and confirmed all blocked at parse-time.
- **test-engineer**: 3 Critical (RLS cross-store arm missing, statement-timeout arm missing, `NewReportModal.test.tsx` missing) + 2 Should-fix (unreachable `read_only_sql_transaction` arm documentation, 4/7 sanitization branches untested). **All 3 Criticals RESOLVED by Main Claude**: arm 14 in `report_run_custom.test.sql` (plan 13→14), `reportParams.test.ts` carves 9 jest cases from `NewReportModal` load-bearing branches via the `buildReportParams`/`isReportSaveDisabled` pure helpers, and the statement-timeout untestability documented in arm-14 comment block + architect-accepted deviation. Acceptance criteria for guards 1/3/4/5 and the privilege gate all PASS; guard 2 SLA documented as 8s role-level.
- **backend-architect**: 1 Critical (echo of test-engineer C1 — missing RLS arm, RESOLVED), 3 Should-fix (unused `_row_count` field, hint says "5s" but operative is 8s — RESOLVED, `when others` errcode P0001 collision — RESOLVED to P0501), 4 Nits. Both dev-surfaced deviations DISPOSITIONED-ACCEPT-WITH-AMENDMENTS — security envelope preserved (Guard 1 parse-time block is STRONGER than designed; Guard 2 role-level 8s is operative). Architecture envelope: PASS with documented caveats. No unintended file touches.

## Recommended next steps (ordered)

**SHIP_READY.**

1. **Commit the staged changes.** All inline fixes (RLS arm 14, P0501 SQLSTATE, 8s hint, `reportParams.ts` helper + tests) are in the migration and code per the verification baseline (63/63 jest, 19/19 pgTAP, smoke PASS).

2. **Post-merge deploy gate — DO NOT SKIP:**
   ```
   npx supabase db push --linked --yes
   ```
   This applies `supabase/migrations/20260515130000_report_run_custom.sql` (including the P0501 catch-all). Until this runs, the now-live `custom` template tile will fall through the dispatcher to `not_implemented` because `public.report_run_custom` doesn't yet exist in the linked database — a confusing regression even though the code is correct.

3. **Pre-deploy manual smoke (recommended; AC-V4 manual gate is unverifiable from automation):**
   - Cmd UI → Reports → custom tile no longer shows PREVIEW badge
   - "New Report" modal: SQL textarea visible (8-row mono), date-range chips absent, hint reads "8s timeout"
   - Type `SELECT name FROM public.inventory_items WHERE store_id = '<your_store>' LIMIT 5` → Save → Run → table renders, KPI/chart hidden
   - Attempt `DROP TABLE x` → error toast surfaces sanitized message
   - Attempt as a non-admin (`'user'`-role) user → 42501 "Custom SQL requires admin privilege" toast
   - Attempt a 1500-row query → truncation banner visible above table
   - Confirm saved SQL renders read-only above results in mono font

4. **Fast-follow (non-blocking; ship 037 first, then batch into a hardening spec):**
   - security-auditor Medium #1: `set_config` GUC mutation enabling audit-log attribution forgery — snapshot+restore `request.jwt.claims` around EXECUTE, OR `revoke execute on function pg_catalog.set_config(text,text,boolean) from authenticated`.
   - security-auditor Medium #2: `pg_catalog` readthrough (pg_settings, pg_roles, pg_class, pg_stat_activity) — header bullet in migration noting this as future-tightening surface if audience widens to `master`.
   - security-auditor Medium #3: `report_definitions.params` readable by store-member user-role — narrow SELECT policy to `auth_is_privileged()` for `template_id = 'custom'` rows.
   - test-engineer Should-fix items: (a) explicit migration-header note that `when read_only_sql_transaction` arm is unreachable through the SELECT-wrap (defense-in-depth only); (b) add coverage arms for sanitization branches 42P01 (undefined_table), 42703 (undefined_column), and 0A000 / `when others` catch-all.
   - code-reviewer's 6 nits and backend-architect's 4 nits (all cosmetic — comment-precision fixes in `reports_anon_revoke.test.sql` header, `ReportsSection.tsx` stale comment about templates "still returning not_implemented", `_row_count` consumer label, `when others` comment phrasing, `when read_only_sql_transaction` "trips here" comment, `report_run_custom.test.sql` header "11 PM-pinned" claim accuracy).

## Out of scope for this review
- Widening the `custom` template audience beyond admin/super_admin (e.g. to `master` role). Spec.md §"Out of scope" already calls this out; the security-auditor's pg_catalog finding becomes relevant at that point.
- Result-cap aggregate-over-truncation semantics (security-auditor Low #4) — spec §16 "Result cap accuracy" rationale could document that aggregates evaluate over the full pre-LIMIT row set; not a security issue and not pinned by any AC.
- `_row_count` field consumer label in the FE (architect Should-fix #1) — JUDGMENT-CALL drift; PM should decide whether to keep the field and add the label or drop the field from the envelope. Either resolution is defensible.
- A formal `from > to` validation sweep across date-range templates (waste/vendor/velocity/cogs/variance) — does not apply to `custom` (no date params); was a fast-follow proposal from earlier specs.
- The `2AM_Project_Menu_Ingredients.xlsx` repo-root cleanup and `app.json` slug-vs-package-name drift (per CLAUDE.md, slug is do-not-auto-fix; the xlsx is to move to `/docs/archive/` in a future cleanup pass).

## Session milestone
Spec 037 closes the FINAL Reports backlog template. All four templates (waste, vendor, velocity, custom) are now live. 13 specs shipped this session: 025-037.

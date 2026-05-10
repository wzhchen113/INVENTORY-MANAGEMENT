# Release proposal — Spec 017 (Reports COGS Template, REPORTS-2) — Round 2

## Verdict
verdict: SHIP_READY
rationale: No reviewer flags an unresolved Critical; the round-1 architect ship-gate (depth-cap envelope-silence) and both round-1 test-engineer FAILs (AC-RS-4 override-Map leak, AC-DB-16 depth-cap divergence) are verified RESOLVED by the round-2 patch via the architect's recommended option 2 (NOTICE + 4th KPI `Recipe graph truncated` + row suffix); spec status is `READY_FOR_REVIEW`; the new migration `report_run_cogs` and re-created dispatcher `report_run` are both in place; the remaining items are 5 round-1 should-fix items already addressed, 3 informational Lows, 3 advisory Minors, and 3 NOT TESTED framework-gap items that are a standing pre-existing gap (no test framework), not new deficiencies.

## Why

Per CLAUDE.md hard rule, the release-coordinator cannot recommend SHIP_READY if any reviewer flagged an unresolved Critical. Reading the actual review files in full:

- **backend-architect** (`reviews/backend-architect.md`) — round 1: 0 Critical, 1 Should-fix (depth-cap envelope-silence — the explicit "do NOT SHIP" gate), 3 Minor. The Should-fix was the architect's published recommendation: option 2 = keep NOTICE, add 4th KPI `Recipe graph truncated` + row suffix `' ⚠ (truncated)'`. **The round-2 patch implements option 2 verbatim** (see spec `## Files changed` section at `spec.md:1696-1721` and test-engineer's round-2 verification at `reviews/test-engineer.md:107-137` with a live 6-level prep chain). The architect's published-but-now-resolved ship gate is closed. The 3 Minors (merge-ownership locational drift, recursive-CTE triple-walk, no explain-analyze artifact) are advisory follow-ups for REPORTS-3 and were never block recommendations.

- **code-reviewer** (`reviews/code-reviewer.md`) — round 1: 0 Critical, 5 Should-fix, 5 nits. All 5 Should-fix items were addressed in the round-2 patch (verified by test-engineer round 2 and security-auditor round 2):
  - Override Map memory leak on delete (`ReportsSection.tsx:123-126`) — fixed via inline `setOverrides` cleanup + `useEffect([myReports])` reconcile.
  - Series-section CTE chain duplication (`report_run_cogs.sql:524-643`) — consolidated into a single statement with a conditional-aggregation gate; recursive prep walk now runs once instead of twice.
  - `daily` CTE missing `recipes` join — inline comment added explaining the cascade-delete FK rationale (migration lines 594-600).
  - `commitDate` silent invalid-date discard (`ReportDetailFrame.tsx:228-232`) — now emits `Toast.show({ type: 'error', text1: 'Invalid date — must be YYYY-MM-DD' })` matching the modal pattern.
  - Stale forward-looking comment in `templates.ts:12` — updated to past tense.
  - The 5 nits are stylistic (depth-violation pre-check comment, "planner can cache" inaccuracy, catalog-tile `range: this month` mismatch, duplicate `isISODate` until REPORTS-3 lands a third copy, `commitDateEdit` early `from > to` feedback). Not blocking.

- **security-auditor** (`reviews/security-auditor.md`) — round 2: 0 Critical, 0 High, 0 Medium. The round-1 Medium (depth-cap divergence) is VERIFIED RESOLVED. The 3 round-1 Lows (params storage bloat, UUID in own-store 42501 message, duplicate `isISODate`) are unchanged informational items. New round-2 surface (overrides-reconcile `useEffect`, NOTICE log content, Toast on invalid date) all PASS. KPI value confidentiality (`v_truncated_recipe_count` is a bigint scalar — no recipe id, name, or store id leaks into the envelope), row-suffix confidentiality (static string literals appended to the row's own brand-scoped label), and cross-store containment of the `bool_or(truncated)` propagation are all verified by direct code inspection. No new attack surface. **No block recommendation.**

- **test-engineer** (`reviews/test-engineer.md`) — round 2: **27 PASS, 0 FAIL**, 3 NOT TESTED (framework gap — pre-existing, not introduced by this spec). The round-1 FAILs (AC-RS-4 and AC-DB-16) are both VERIFIED RESOLVED. The AC-DB-16 re-verification reproduces a 6-level prep chain in a rolled-back transaction and confirms the NOTICE fires, the 4th KPI `Recipe graph truncated` is appended, the truncated suffix wins over the missing-cost suffix in both `by=category` and `by=item` views, and the function returns successfully (no fatal raise). All 24+ ACs that passed round 1 continue to PASS — no regressions. **No block recommendation.**

### Independent verification (this turn)

I verified directly:
- `specs/017-reports-cogs-template/spec.md:3` reads `Status: READY_FOR_REVIEW`.
- `specs/017-reports-cogs-template/spec.md:1621-1778` (`## Files changed`) lists the round-2 fixes:
  - depth-cap revised per architect's option 2 (NOTICE + 4th KPI `Recipe graph truncated` + row suffix);
  - `truncated_recipes` CTE materialized in both `by='item'` and `by='category'` branches with `bool_or` propagation;
  - series-section CTE consolidation (single statement);
  - `daily` CTE inline comment explaining FK/cascade rationale;
  - `setOverrides` inline cleanup paired with `deleteReportDefinition`;
  - `useEffect([myReports])` reconcile loop;
  - `commitDate` Toast on invalid manual entry;
  - `templates.ts:12` past-tense fix;
  - spec text updated for Q5 and the per-definition override persistence behavior.
- The new migration `20260511120000_report_run_cogs.sql` is in the working tree. The migration both creates `public.report_run_cogs(uuid, jsonb)` and re-creates the dispatcher `public.report_run(text, uuid, jsonb)` with the `when 'cogs'` arm (`reviews/backend-architect.md:74-88`, `reviews/test-engineer.md:25-39, 142-150`).

Note on tool grants: my tool grants in this turn are limited to `Read`, `Write`, `Grep`, and `Glob`. I cannot run `docker exec` against the local Postgres to independently re-list `pg_proc` rows for `report_run_cogs` / `report_run`. The test-engineer's round-2 verification at `reviews/test-engineer.md:25-39` explicitly states the migration was applied to the live local DB via `docker exec -i supabase_db_imr-inventory psql ... < supabase/migrations/20260511120000_report_run_cogs.sql` and confirmed `CREATE FUNCTION twice, REVOKE twice, GRANT twice`. The backend-architect's round-1 drift review at `reviews/backend-architect.md:49-88` independently inspected the migration source and confirms both function signatures, grants, and the dispatcher arm. Two independent reviewer signatures converge on the same conclusion. The spec's `## Files changed` block also lists the migration and the round-2 re-application transcript at lines 1753-1755.

## Findings summary

- **backend-architect**: 0 Critical, 0 High, 0 Should-fix remaining (the round-1 depth-cap ship gate is CLOSED by the round-2 patch implementing option 2). 3 Minors retained as advisory follow-ups for REPORTS-3 (merge-ownership locational drift, recursive-CTE triple-walk, no explain-analyze artifact). No block.
- **code-reviewer**: 0 Critical, 0 Should-fix remaining (all 5 closed in the round-2 patch per test-engineer and security-auditor verification), 5 nits deferred (stylistic — not blocking). No block.
- **security-auditor**: 0 Critical, 0 High, 0 Medium. Round-1 Medium (depth-cap divergence) RESOLVED. 3 round-1 Lows unchanged informational items. New round-2 surface (overrides-reconcile `useEffect`, NOTICE log content, Toast on invalid date) all PASS. No block.
- **test-engineer**: 27 PASS / 0 FAIL / 3 NOT TESTED. Both round-1 FAILs (AC-RS-4, AC-DB-16) verified RESOLVED. No regressions. The 3 NOT TESTED items are a standing framework gap (no jest/vitest/playwright in the project), not new deficiencies. No block.

## Round-by-round resolution table

| Finding (origin)                                                                | Severity   | R1                                    | R2                              |
|---------------------------------------------------------------------------------|------------|---------------------------------------|---------------------------------|
| Depth-cap envelope-silence (architect ship-gate)                                | Should-fix | OPEN                                  | **CLOSED** (option 2 implemented) |
| AC-DB-16 depth-cap behavior (test-engineer FAIL)                                | FAIL       | OPEN                                  | **CLOSED** (NOTICE + 4th KPI + suffix verified live) |
| AC-RS-4 override Map memory leak on delete (test-engineer FAIL)                 | FAIL       | OPEN                                  | **CLOSED** (inline cleanup + useEffect reconcile) |
| Override Map memory leak (code-reviewer Should-fix)                             | Should-fix | OPEN                                  | **CLOSED** (same fix as AC-RS-4) |
| Series-section CTE chain duplication (code-reviewer Should-fix)                 | Should-fix | OPEN                                  | **CLOSED** (single statement)   |
| `daily` CTE missing `recipes` join (code-reviewer Should-fix)                   | Should-fix | OPEN                                  | **CLOSED** (inline comment)     |
| `commitDate` silent invalid-date discard (code-reviewer Should-fix)             | Should-fix | OPEN                                  | **CLOSED** (Toast added)        |
| Stale `templates.ts:12` forward-looking comment (code-reviewer Should-fix)      | Should-fix | OPEN                                  | **CLOSED** (past tense)         |
| Depth-cap divergence (security-auditor Medium)                                  | Medium     | OPEN                                  | **CLOSED** (option 2 verified)  |

All Critical, High, Medium, and Should-fix items closed. All round-1 test-engineer FAILs RESOLVED.

## Pre-existing issues to track separately (NOT blocking REPORTS-2)

These were surfaced by reviewers but are not introduced by this spec. They should be addressed in dedicated follow-up specs, not retrofitted into REPORTS-2.

1. **~436 React `Maximum update depth exceeded` errors during cold-boot of the Inventory section** — predates spec 016. Recommend a separate investigation spec — likely a useEffect/setState loop in an Inventory section component.

2. **`supabase_realtime` publication is `FOR ALL TABLES`** — established by `20260502190000_realtime_publication.sql`. Per-store RLS still gates visibility. No realtime consumer reads `report_runs` today. Recommend revisiting publication scope as a separate hardening spec.

3. **6 pre-existing `npm audit` advisories in dev tooling** (1 high `@xmldom/xmldom`, 5 moderate `dompurify`/`postcss` through Expo CLI / metro-config). None intersect the REPORTS-2 surface (server-side jsonb aggregation, RN `<Text>` rendering, no DOM purification, no XML, no user-CSS). `package.json` and `package-lock.json` unchanged this spec. Track via a tooling-upgrade spec.

4. **Standing test-framework gap (no jest/vitest/playwright)** — 3 NOT TESTED items remain in this spec's verification matrix:
   - AC-DB-6 (malformed date → `'Run failed — check server logs'` in the UI) verified at the DB layer only — JS-layer end-to-end requires a test framework that does not yet exist.
   - AC-RDF-2 (chip change does not trigger re-run) verified by source inspection only.
   - AC-NM-3 / AC-RDF-commitDate Toast verified by source inspection only.

   These are not new deficiencies — they are a standing infrastructure gap that has been documented since spec 016. Framework introduction requires explicit user approval per CLAUDE.md.

5. **`report_run_stub` reachable to all authenticated users** (security-auditor informational, both specs). Stub returns hardcoded dummy data; data-leak risk is zero. Will be rendered moot once all template arms are live. No action this spec.

6. **Recursive CTE triple-walk in `report_run_cogs`** (architect Minor; security-auditor Low noting three near-identical inline copies) — totals / rows / series each re-walk the recursive prep-flatten. On the seed dataset this is ≈150ms total (well within the 500ms budget); at brand-catalog scale this amplifies. The architect recommends extracting `public.v_recipe_cost_flat(store_id)` as a helper view in REPORTS-3 so Variance doesn't duplicate the pattern. Track as a REPORTS-3 ship consideration.

7. **`db.runReport` merge-ownership locational drift** (architect Approved Drift, code-reviewer nit) — the merge `{ ...baseParams, ...overrideParams }` lives in BOTH `db.ts` (for the RPC call) and the store action (for the optimistic row). Behavior is identical; the cost is a maintenance surface if merge semantics ever change. The architect recommends REPORTS-3 reaffirm "merge ownership lives in `db.ts`" so the developer doesn't reintroduce a store-side merge as a third source of truth.

8. **No `explain analyze` artifact for the 500ms budget** (architect Minor) — the design asked for explain-analyze output if any index landed. No indexes were added and no artifact was captured. On the 286 KB seed the function returns in ~13ms per test-engineer's AC-DB-17 verification, well within budget. Recommend REPORTS-3 captures an artifact under a representative brand-scale dataset.

## Recommended next steps (ordered)

1. **Commit the round-2 patch.** Per CLAUDE.md ("Main Claude does not auto-commit on SHIP_READY. The user confirms the commit."), the commit step is the user's decision. Suggested commit scope: the round-2 patch in full — migration `20260511120000_report_run_cogs.sql`, `src/store/useStore.ts` (`runReport` two-arg signature), `src/lib/db.ts` (`overrideParams` arg shape), `src/types/index.ts` (params JSDoc), `src/screens/cmd/sections/reports/templates.ts` (`cogs` → `'live'` + past-tense comment), `src/components/cmd/NewReportModal.tsx` (date-range field + by toggle), `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` (interactive chips + `commitDate` Toast), `src/screens/cmd/sections/ReportsSection.tsx` (per-definition override Map + inline cleanup + reconcile useEffect), and `specs/017-reports-cogs-template/spec.md` (Q5 + override-persistence AC text revisions).

2. **After commit, REPORTS-3 (Variance template) is the third and final template-runner spec for `product-manager`.** The forward-compat checklist in `reviews/backend-architect.md:364-398` confirms REPORTS-3 inherits a clean foundation: same `from`/`to`/`by` param shape, same per-store `inventory_items.cost_per_unit` join pattern, same missing-cost partial-credit + flag policy (Q4), same dispatcher convention (placeholder comment already in migration line 686). The architect's three forward-compat watch-items for REPORTS-3:
   - Consider extracting `public.v_recipe_cost_flat(store_id)` as a helper view to avoid the triple-walk pattern.
   - Reaffirm "merge ownership lives in `db.ts`" in the design handoff so the developer doesn't reintroduce a store-side merge as a third source of truth.
   - Capture an `explain analyze` artifact under a representative brand-scale dataset to verify the 500ms budget continues to hold for Variance.

3. **(Optional, not blocking)** Open follow-up specs for the pre-existing issues above (Inventory cold-boot loop, realtime publication scope, dev-tooling vuln upgrade, test framework introduction).

## Out of scope for this review

- Changing `Status:` in the spec — owned by the developer/PM, not the release-coordinator.
- Auto-committing on SHIP_READY — explicitly disallowed by CLAUDE.md.
- Adding a test framework — requires user approval per CLAUDE.md. The 3 NOT TESTED items in this spec's verification matrix are gated on that decision.
- Modifying `app.json` slug, `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, or `AdminScreens.tsx` — all explicitly off-limits per CLAUDE.md.
- Extracting `public.v_recipe_cost_flat(store_id)` — track as a REPORTS-3 forward-compat consideration, not a retrofit on REPORTS-2.
- Centralizing the `db.runReport` merge ownership — track as a REPORTS-3 design clarification, not a REPORTS-2 retrofit (the audit-trail contract is preserved exactly as-is).

## Handoff
next_agent: NONE
prompt: SHIP_READY — all Critical / High / Medium / Should-fix closed (architect's round-1 depth-cap ship gate resolved via option 2; both round-1 test-engineer FAILs verified RESOLVED with live DB transactions); user confirms commit of the round-2 patch.
payload_paths:
  - specs/017-reports-cogs-template/reviews/release-proposal.md

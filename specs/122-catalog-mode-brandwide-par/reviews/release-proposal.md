## Verdict
verdict: SHIP_READY
rationale: All four reviewers cleared spec 122 with zero Criticals or Should-fixes; the two highest-risk ACs (current_stock never fans out, items.tsv stays single-store) are thoroughly covered on both the SQL and frontend layers.

## Findings summary
- code-reviewer: 0 Critical, 0 Should-fix, 3 Nits — (1) doc/spec §6 prose disagreement on whether fan-out targets are local (shipped code is better-than-spec; spec text to be corrected in follow-up), (2) fire-and-forget `applyScalarsToAllStores` + synchronous `onClose()` (intentional, matches spec), (3) pre-existing `#000`-on-accent literals (out of scope, already in cleanup backlog). Save routing traced end-to-end: items.tsv byte-identical to pre-spec, catalog.tsv fans exactly par/cost/case, `current_stock` excluded at every layer.
- security-auditor: 0 Critical, 0 High, 0 Medium, 1 Low (non-blocking) — no lower-bound validation on par/cost/case_price; explicitly a data-integrity nit under OVERWRITE-by-design semantics, not an authz issue, not owned by security. Verified: search_path pinned, anon/public revoked + authenticated-only grant, brand derived server-side from catalog row, three-layer auth gate (privileged → brand → per-store) fires before any write, write scope structurally bounded to three scalars, no injection, no new exposure.
- test-engineer: 11 ACs PASS, 2 NOT TESTED (both low-risk) — AC-4 (downstream EOD/reorder reflect fan-out) PASS by composition of two independently-tested unchanged paths; AC-12 (live realtime) NOT TESTED, a pre-existing project-wide harness gap mirroring spec 119, non-blocking. 0 FAIL. Full jest 106 suites / 1207 tests green, tsc + test typecheck clean, new pgTAP 18/18 including the critical current_stock-untouched-on-differing-value assertions. This spec also closes the frontend success/failure + notifyBackendError gap that spec 119 shipped with unmet.
- backend-architect: 0 Critical, 0 Should-fix, 2 Minor (both intentional/accepted) — M1: optimistic-write across fan-out targets supersedes §6 prose (an improvement, catalog slice holds all stores' rows so they are revertible); M2: dual write/revert paths on the current store leave a transient local inconsistency only in a split-failure edge, reconciled by next realtime replay/reload. Implementation matches the authored contract; no realtime or edge change.

## Recommended next steps (ordered)
1. Commit and push spec 122 (migration + db.ts + store + frontend + tests + i18n). User confirms the commit.
2. In the SAME push window, apply migration `20260717000000_apply_item_scalars_to_brand.sql` to prod via MCP `execute_sql` + insert the exact version into `supabase_migrations.schema_migrations` + verify the function with normalized-md5 (project ebwnovzzkwhsdxkpyjka). This is mandatory: if the repo migration lands without the prod apply, `db-migrations-applied.yml` hard-fails. No edge redeploy is needed this spec.
3. After push, confirm the latest run of BOTH active gates on `main` is green via `gh run list --branch main --workflow test.yml --limit 1` and `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`. If either is red or in-progress, surface the run URL and wait for user direction.

Follow-ups (not blocking ship):
- Correct the spec's Backend design §6 prose so a future reader doesn't treat the "no optimistic write" text as source of truth (code-reviewer nit 1 / architect M1).
- Optional: revisit par/cost/case_price lower-bound validation if a future CHECK-constraint hardening pass is scoped (security Low).

## Out of scope for this review
- Pre-existing `#000`-on-accent literals on the NEW/EDIT badge and SAVE button (code-reviewer nit 3) — already tracked in the project cleanup backlog, not introduced by spec 122.
- Pre-existing, unrelated pgTAP failure `item_vendors_rls.test.sql` test-12 (`have: 8302192, want: NULL`) — a long-lived local-container staleness artifact (fixture's unqualified `limit 1` picking a manually-mutated Charles row), last touched by spec 114, not reproducible in CI's fresh `supabase start`. Explicitly NOT a spec-122 regression; noted so it is not misattributed.
- Live two-client realtime integration test (AC-12) — no realtime-integration harness exists for any feature in this repo by design (CLAUDE.md three-track policy); belongs to a future test-infrastructure spec, not this one.

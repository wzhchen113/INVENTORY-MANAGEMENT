# Release proposal — Spec 100 (staff reorder screen localization completion)

## Verdict
verdict: SHIP_READY
rationale: All four reviewers returned 0 Critical, all 9 acceptance criteria are covered (694/694 jest + spec-100 pgTAP 7/7), and the latest test.yml run on main is green — the only open items are two trivial cleanups.

## Findings summary
- code-reviewer: 0 Critical, 2 Should-fix, 3 nits (1 withdrawn). Decision B1 honored — `reorderExport.ts` and `db.ts:mapReorderVendor` byte-for-byte unchanged (grep-verified). Should-fix: (1) dead `Platform` import at `Reorder.tsx:20`; (2) stale comment at `Reorder.test.tsx:161` referencing a `formatSuggested` call the staff screen no longer makes.
- security-auditor: 0 findings at any severity. Migration is additive + signature-stable so the `create or replace` preserves the existing `revoke … from public, anon` + `grant … to authenticated` ACL; `security invoker` and the `auth_can_see_store` gate intact; `i18n_names` rides an already-SELECTable column under existing RLS; render path is string-only into RN `<Text>` (no XSS/SQLi/template-injection surface).
- test-engineer: 9/9 acceptance criteria PASS. jest 694/694 green; spec-100 pgTAP `report_reorder_list_i18n_names.test.sql` 7/7 green. Noted 2 LOCAL pgTAP failures (`submit_weekly_count`, `weekly_count_status`) — these are a LOCAL-stack drift artifact (missing the spec-098 weekly-count migration: `weekly_count_due_dow` column / `submit_weekly_count` function absent locally), NOT a spec-100 defect and NOT a real CI failure. CI applies migrations from scratch; the test.yml run on main is green. Minor coverage gap: no negative regression test asserting vendor names stay English under zh-CN (low risk — no vendor i18n source exists in schema).
- backend-architect: 0 Critical, 0 Should-fix, 2 Minor (documentation-only). Stale-body trap cleanly avoided: byte-identical signature, verbatim latest body from `20260602000000`, exactly the two additive `i18n_names` hunks, spec-087/088 logic fully preserved. Contract conformance table all MET, including the intentional staff-vs-admin mapper divergence being annotated so it isn't "repaired" later.

## CI / hard-rule check
- The SHIP_READY hard rule (no SHIP when test.yml on main is not green) is SATISFIED. The latest test.yml run on main is green (spec-100 commit run completed success, confirmed via `gh run list`).
- The test-engineer's "2 pre-existing pgTAP failures means CI is red" note was a misread of LOCAL drift (local stack missing the spec-098 weekly-count migration). CI builds the schema from scratch and is green. No Critical was raised by any reviewer.

## Recommended next steps (ordered)
SHIP_READY:
1. Commit and deploy spec 100. No blocking findings.
2. (optional, recommended to fold into the ship commit since both are trivial and touch already-changed files) Apply the two Should-fix cleanups — neither changes behavior or output bytes:
   a. Remove the dead `Platform` import from the destructure at `src/screens/staff/screens/Reorder.tsx:20`.
   b. Fix the stale comment at `src/screens/staff/screens/Reorder.test.tsx:161` to describe what actually produces the string (`suggestedMainLabel` + the `reorder.unit.case/cases` catalog key) rather than the no-longer-called `formatSuggested`.
3. (optional follow-up, not blocking) Add a negative regression test asserting vendor grouping headers/chips stay English under zh-CN (closes the AC7 absence-of-change gap the test-engineer flagged).

Guidance on the two Should-fix items: both are trivial, zero-behavior-change cleanups (a dead import and a comment). They do not block ship. Folding them into the ship commit is the tidy choice — they touch files already modified by this spec and a strict linter will eventually flag the dead import — but deferring them to a follow-up is also acceptable. Treat as "fix-if-convenient," not a gate.

## Out of scope for this review
- Catalog translation data population: 0 of 143 `catalog_ingredients` rows currently have any `i18n_names` translation, so item names will keep rendering in English (the correct, intended fallback) until translations are entered via the existing admin item-editor path (spec 040 P3). This is a data-population gap, not a spec-100 plumbing defect — spec 100 correctly fixed the rendering plumbing and the silent-fallback behavior is verified by AC1.
- Live in-browser verification of line-item localization (item names, unit normalization, EOD badge) was not possible because no manager-accessible store has reorder-triggering data today. This is covered by RNTL render-tree tests (the appropriate jest track per the spec) + a live RPC payload check; the zh-CN screen chrome (summary cards 供应商/项目/预计总额/在库数据来源, "0 条 EOD", buffer banner) was confirmed in-browser by main Claude. No AC requires pixel-level verification.
- The two backend-architect Minor notes are documentation-only (header arithmetic reconciliation; the NULL→null→`{}` narration describes a mapper-side defense, not a catalog-reachable state since the column is `jsonb NOT NULL DEFAULT '{}'`). No code change required.
- The 2 local pgTAP failures belong to spec 098 (weekly count) local-stack drift, not this spec.

## Handoff
next_agent: NONE
prompt: SHIP_READY — commit and deploy spec 100. 0 Critical from all four reviewers, 9/9 ACs covered, jest 694/694 + spec-100 pgTAP 7/7, test.yml on main green. Two trivial Should-fix cleanups (dead Platform import, stale test comment) are optional fix-if-convenient, not gates.
payload_paths:
  - specs/100-staff-reorder-localization-completion/reviews/release-proposal.md

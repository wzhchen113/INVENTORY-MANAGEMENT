# Release proposal — Spec 018 (Reports Variance Template, REPORTS-3) — Round 2

## Verdict
verdict: SHIP_READY
rationale: Both round-1 Criticals are resolved; all 47 test ACs PASS; no reviewer holds any open Critical, High, or Medium; the single round-2 Should-fix (stale `eodCount` comment) was fixed inline by main Claude after the review landed.

## Why

Round 1 surfaced two Criticals: the modal disabling CREATE for variance (contradicting spec AC line 264-267) and the 0.01 noise filter polluting KPI aggregates (KPI numbers diverging from row-table semantics). Round 2 implements release-proposal **Option A** (remove the disable + the `onCreate` early-return) and **Option C** (split `joined_with_dollar` / `filtered` / `totals` so KPIs read pre-filter while rows read post-filter).

Independent verification confirms:

- `report_run` and `report_run_variance` are both registered in `public` (reviewers verified via `\df public.report_run*` and dispatcher tests; 4 dispatcher arms PASS).
- The migration's CTE topology in `supabase/migrations/20260512120000_report_run_variance.sql:489-518` is structurally correct: `joined_with_dollar` (lines 489-494) computes `dollar_impact` once on `joined` (pre-filter); `filtered` (lines 500-503) reads from `joined_with_dollar` and drops `abs(delta) < 0.01` for the rows table only; **`totals` (lines 512-518) reads from `joined_with_dollar`, NOT `filtered`** — `net_dollar`, `items_with_variance` (`count(*) filter (where abs(delta) > 0)`), and `missing_cost_count` all aggregate over the pre-filter set. KPI numbers and row-table semantics are now decoupled correctly.
- The `eodCount` state comment at `src/components/cmd/NewReportModal.tsx:110-115` was updated to past-tense and explicitly references spec AC line 265: "Per spec AC line 265 the CREATE button is NOT disabled — the user can still save the definition and discover the `P0002` error on RUN via the standard toast." Stale forward-tense behavior description is gone.

Backend-architect: APPROVE (round 1; both flagged items resolved in round 2). Security-auditor: 0 Critical/High/Medium, 2 Low advisory (acceptable trade-offs). Code-reviewer round 2: 0 Critical, 1 Should-fix (fixed inline), 2 deferrable nits. Test-engineer round 2: **47 PASS, 0 FAIL, 0 REGRESSED**.

## Round-by-round resolution table

| Round-1 finding | Severity | Resolution path | Round-2 verdict |
|---|---|---|---|
| C1 — `NewReportModal.tsx:259, 603` disables CREATE when `eodCount < 2` (contradicts spec AC line 264-267) | Critical (broken AC) | Option A — removed `disabled={varianceBlocked}` from the TouchableOpacity; removed conditional `opacity`/`cursor`/color branch; removed `if (varianceBlocked) return;` early-return from `onCreate`. Inline danger hint retained. | **PASS** — code-reviewer C1 PASS, test-engineer MODAL-AC-3 PASS (was FAIL) |
| C2 — `migration:480-486` 0.01 filter applied to BOTH rows table AND KPI aggregates (contradicts spec Q7 + KPI definition) | Critical (broken AC) | Option C — introduced `joined_with_dollar` intermediate CTE; `filtered` reads `joined_with_dollar` for rows only; `totals` reads `joined_with_dollar` (NOT `filtered`) for KPIs. Migration header documents the split contract. | **PASS** — code-reviewer C2 PASS, test-engineer DB-AC-11 PASS (was FAIL); fixture: rows=2 (Lava Cake `|delta|=0.005` excluded), `items_with_variance`=3 (Lava Cake counted), `net_dollar`=-$1,634.19 (Lava Cake -$0.19 included) |
| S1 — `seedVarianceDates` fallback returns `computePreset('last_30d')` instead of empty strings when `< 2` EODs | Should-fix | `< 2` branch and catch block now return `{ from: '', to: '', eodCount: ... }`. | **PASS** — code-reviewer S1 PASS, test-engineer MODAL-S1 PASS |
| S2 — CREATE button text color `'#000'` literal instead of `C.accentFg` | Should-fix | `NewReportModal.tsx:570` now `color: C.accentFg` unconditionally. | **PASS** — code-reviewer S2 PASS |
| S3 — Stale forward-tense comment in `ReportsSection.tsx:21` ("REPORTS-2 will flip..., REPORTS-3 will flip...") | Should-fix | Rewritten to past tense ("REPORTS-2 flipped `cogs` to `'live'`, REPORTS-3 flipped `variance`"). | **PASS** — code-reviewer S3 PASS |
| S4 — "Premature shared module" comment + duplicated local date helpers across `NewReportModal.tsx` and `ReportDetailFrame.tsx` | Should-fix | Helpers (`toISODate`, `isISODate`, `computePreset`, `PresetId`) extracted to new `src/utils/reportDates.ts`. Both consumers import from it; `ReportDetailFrame.tsx` extends `PresetIdShared` with `'custom'` via a clean local alias. | **PASS** — code-reviewer S4 PASS |
| Round-2 Should-fix — stale `eodCount` state-variable comment at `NewReportModal.tsx:110-113` still said "CREATE disabled state for variance" | Should-fix | **Fixed inline by main Claude after the round-2 review landed.** Comment now reads: "Drives the `< 2 EODs` inline danger hint for variance. Per spec AC line 265 the CREATE button is NOT disabled — the user can still save the definition and discover the `P0002` error on RUN via the standard toast." | **RESOLVED** |
| Round-1 Approved Drift — 0.01 floating-point noise filter documented in migration header | Approved Drift | Retained as documented Approved Drift, now correctly classified after the Option C split — the architect's table-readability rationale (no 50-row wall of zeros) is honored on the rows table while the spec's KPI definition is honored on the totals CTE. | **APPROVE** (test-engineer "no longer blocks given Option C correctly separates display filter from KPI semantics") |
| Round-1 Minor Drift — `varianceBlocked` CREATE-disable policy | Minor Drift | Subsumed by C1 resolution (Option A flips impl to match spec). | **RESOLVED** |

## Pre-existing tickets (carried forward, NOT blockers for spec 018)

- **Cold-boot React Native development errors** surfaced during prior spec verification. Unrelated to this spec's surface.
- **`supabase_realtime FOR ALL TABLES` publication scope** — pending product call. This spec deliberately did not add `report_runs` to the publication, upholding the REPORTS-1 decision. No `docker restart supabase_realtime_imr-inventory` needed for this migration.
- **`npm audit` dev-tooling baseline** — `5 moderate` (`postcss` chain → `@expo/metro-config` / `@expo/cli` / `expo`) + `1 high` (`@xmldom/xmldom`, transitive dev). Same six findings as Spec 016 / 017 baseline; not introduced or aggravated by REPORTS-3. Recommend a separate tooling-bump pass.
- **Standing test-framework gap** — no jest/vitest/playwright wired in repo (per CLAUDE.md "Gaps and unknowns"). Verification continues to rely on `docker exec ... psql` DO-blocks for the database surface and source-code static analysis for the frontend surface. No new framework introduced.
- **Migration tracking gap** — `20260512120000_report_run_variance.sql` (and the predecessor `20260511120000_report_run_cogs.sql`) are not yet recorded in `supabase_migrations.schema_migrations` (last tracked is `20260510130000`). Functions exist and work in the local DB — were applied outside `supabase db migrate`. Per CLAUDE.md "CI workflow" this is a known gap with no CI gate on disk; functional impact is nil.
- **Two deferred nits from round-2 code-review (out of scope for this spec):**
  - Three `color: '#000'` literals on the NEW badge text, template-tile icon when selected, and SELECTED badge text in `NewReportModal.tsx` (lines 290, 334, 341). Pre-existing from REPORTS-1/2; should migrate to `C.accentFg` or a purpose-named token in a future theming pass.
  - Stale index comment at `20260512120000_report_run_variance.sql:614-617` ("covers the receiving / waste filter shape" conflates two tables). The index itself is correct; only the body comment is the casualty.
- **Native testing gap** — Spec scope includes both web and native. `react-native-web` rendering should be identical, but no Expo native-specific test was run. Gap carried forward from prior specs.
- **Recursive prep CTE duplication** — same shape now lives in `20260511120000_report_run_cogs.sql` (lines 197-278) and `20260512120000_report_run_variance.sql` (lines 310-374). Architect recommends extraction to a shared helper (e.g. `public.recipe_cost_meta(p_store_id uuid)`) be opened explicitly as a decision in the **REPORTS-4 (Waste)** spec — when the third caller arrives, the right shared shape will be clearer.
- **`db.runReport` sanitizer trade-off (P0002 → generic `'Run failed'` toast)** — accepted v1 behavior per spec AC line 70-72. Closing the cross-store anchor-existence oracle is the security positive; modal hint is the primary UX affordance. Security-auditor Low #1 documents the trade-off; no action needed.

## Recommended next steps

1. **User reviews the round-2 patch and commits.** All four reviewers have signed off; the only outstanding round-2 Should-fix (stale `eodCount` comment) was fixed inline. No remaining blockers.
2. **Trilogy complete on commit.** REPORTS-1 (foundation) → REPORTS-2 (COGS) → REPORTS-3 (Variance) was the originally-scoped three-part plan. After this commit, the report-runner foundation is shippable end-to-end with two live templates (`cogs`, `variance`) and four `not_implemented` arms (`waste`, `vendor`, `velocity`, `custom`).
3. **Out-of-original-plan follow-ups** (each its own future spec, not in scope for this trilogy):
   - **REPORTS-4 Waste** — should open with an explicit architect decision on extracting the recursive prep CTE + recipe-meta rollup to a shared SQL helper.
   - **REPORTS-5 Vendor**, **REPORTS-6 Velocity**, **REPORTS-7 Custom** — flip each remaining `preview` template to `live` following the REPORTS-2/3 pattern (per-template RPC + dispatcher arm + `templates.ts` status flip + modal/frame customization where the shape differs from COGS).

## Handoff

next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/018-reports-variance-template/reviews/release-proposal.md

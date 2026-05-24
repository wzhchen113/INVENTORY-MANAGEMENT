## Verdict
verdict: SHIP_READY
rationale: Zero Critical findings across all four reviewers; both pgTAP coverage gaps (AC-C3 truncated flag, AC-C4 perf budget) are test-only with no production-code defect, and the architect explicitly judged all five backend-dev deviations JUSTIFIED.

## Findings summary

- **code-reviewer**: 0 Critical, 3 Should-fix, 6 Nits.
  - Should-fix: (a) perf assertion promised in test file header but never implemented (`compute_menu_capacity.test.sql:30,42`); (b) `borderColor` is a dead variable in `MenuCapacityBadge.tsx:88,138-139` (declared, never assigned, always-`undefined` style refs); (c) `truncated` column never asserted for the cycle recipe at `compute_menu_capacity.test.sql:402-421` and the explanatory comment incorrectly describes WHY `truncated` fires.
  - Nits: redundant GROUP BY keys in `recipe_lines`, missing 5-ingredient `LOW5` fixture body, defensive `hasRecipe` default lacking inline comment, defensive `=== undefined` check on `number | null` type, two dead `void` assignments in `MenuImpactSection.test.tsx`, and the `#variable_conflict use_column` pragma is repo-unique and worth a top-of-file pointer.

- **security-auditor**: 0 Critical, 0 High, 0 Medium, 2 Low (both observational/positive).
  - Low #1: cross-reference of the same missing perf assertion test-engineer raised (documentation cross-reference, not a security finding).
  - Low #2: positive confirmation that `bindingCatalogName` and all RPC-returned strings render via React Native `<Text>` (auto-escaped) — no XSS surface.
  - Full OWASP Top 10 sweep PASS. `security invoker` + `auth_can_see_store()` pre-flight + UUID-typed parameter + visited-array cycle guard + depth-5 cap + `revoke from public, anon` + `grant to authenticated` mirror the canonical `report_reorder_list` pattern verbatim. Realtime publication unchanged.

- **test-engineer**: 0 Critical, 2 Should-fix, 1 Nit. **259/259 jest pass, 33/33 pgTAP files pass** (including the new `compute_menu_capacity.test.sql` at 16/16 assertions). RLS mutation test confirms the foreign-store gate is load-bearing (without it, 41 rows leak). Visited-array mutation test confirms the guard is necessary (removing both guards causes statement timeout via infinite recursion) but proves the pgTAP assertion `(8)` cannot distinguish "visited-array guard fired" from "depth-cap fired" — root cause of the AC-C3 NOT TESTED status. **Two NOT TESTED items**: AC-C3 (`truncated` flag not asserted for cycle recipe) and AC-C4 (`< 100 ms p95` perf budget not enforced in pgTAP). Both are Should-fix and both confined to the test file — no production-code defect. All other ACs PASS.

- **backend-architect**: 0 Critical, 2 Should-fix (next-sprint follow-ups, not blocking), 2 Minor. Explicit SHIP_READY recommendation. All five backend-dev-flagged deviations judged JUSTIFIED:
  - `#variable_conflict use_column` pragma: PL/pgSQL OUT-param shadowing the architect did not anticipate; pragma is the least-invasive correct fix.
  - `has_unit_mismatch` empty-recipe-unit semantic narrowing: conservative direction, matches the spec edge-case row.
  - Fire-and-forget `loadMenuCapacity` race: no race — `tracked()` wrapper's AbortController structurally prevents stale-response overwrite.
  - Cycle test pgTAP shape: design's narrative was imprecise about WHICH mechanism (visited-array vs. depth-cap) catches WHICH case; the test correctly omits `truncated = true` for a 2-node cycle because the visited-array fires first at depth 3, BEFORE the depth-5 truncation predicate could.
  - `MenuCapacityRow` relocation to `types/index.ts`: developer correctly resolved an implicit circular import the architect's design did not catch.

## Recommended next steps (ordered)

1. **Commit and push.** Browser-verification smoke (1440x900) confirmed inline badges in RecipesSection (`~0`, `0`, "no recipe defined"), the dedicated Menu Impact section under INSIGHTS with header "Menu impact 41 total", correct subtitle, the "show impacted only" filter, sortable columns (MENU ITEM / MAKEABLE↑ / LIMITED BY / LOW INGR.), unit-mismatch `~` prefix rendering on `has_unit_mismatch=true` rows, no-BOM edge case rendering "no recipe defined" instead of "0", and brand-scoped 41 recipes for the active store with RLS pre-flight verified. Zero Critical and no production-code defect across all four reviewers.

2. **(Optional follow-up spec) pgTAP coverage hardening.** Bundle three test-only fixes into a single follow-up:
   - Add a `clock_timestamp()` delta assertion for the `< 100 ms p95` perf budget (AC-C4) and increment `plan()` by 1.
   - Add an assertion that locks `truncated = false` for the existing 2-node cycle case and a second fixture (chain of 6+ prep recipes in a line) that forces `truncated = true` to exercise the depth-5 emission path (AC-C3 + architect's Should-fix #1). Correct the misleading comment at lines 405-415.
   - Same gap exists in `report_run_variance_multivendor`'s test — close uniformly across both RPCs in the same follow-up.

3. **(Optional follow-up) Code hygiene cleanup.** Bundle the code-reviewer nits + the dead `borderColor` variable in `MenuCapacityBadge.tsx:88,138-139` and the two `void` assignments in `MenuImpactSection.test.tsx`. None are correctness defects; the badge renders identically with or without the dead variable. Architect's Minor #3 (breadcrumb comment at `types/index.ts:782` referencing the circular-import rationale) and Minor #4 (tighten `recipe_lines` GROUP BY) fit the same bundle.

4. **(Optional follow-up) Design narrative cleanup in the spec.** Update spec 060's §1 narrative (lines 301-321) and Risks paragraph (lines 854-860) to distinguish the visited-array short-circuit (`truncated=false`, capacity from reachable subgraph) from the depth-cap emission (`truncated=true`). Doc-only, no code change.

## Out of scope for this review

- **Real-time integration test coverage** for AC-D1 and AC-D2 — this is the pre-existing gap for ALL realtime features in the codebase, not a regression introduced by spec 060. Belongs in a separate cross-cutting test-infra spec.
- **Shell smoke `scripts/smoke-menu-capacity.sh`** — the spec marked it optional and the RPC is fully covered by pgTAP.
- **The same `truncated`-detection gap in `report_run_variance_multivendor`** — architect explicitly noted the inherited variance/reorder pattern has the same coverage gap. Address uniformly in the follow-up rather than re-opening spec 060.

## Process note

Spec 060 is the largest single spec since 055: Postgres recursive CTE, new SECURITY INVOKER RPC, new sidebar section under INSIGHTS, i18n parity across three locales, brand-scoped via `auth_can_see_store()`, cycle protection via visited-array + depth-5 cap, and a new Zustand slice wired into the existing `loadFromSupabase` fan-out. Single-pass to SHIP_READY with **zero Critical findings across four reviewers** is a meaningful signal. The architect's pre-build investigation (resolving five blockers before READY_FOR_BUILD) clearly paid off — the developer's five flagged deviations were all judged JUSTIFIED in post-impl review, indicating the design framework was sound enough to absorb the unforeseen issues (PL/pgSQL OUT-param shadowing, circular import, unit-mismatch edge case, fire-and-forget race, cycle-test mechanism precedence) without invalidating the contract.

**Deferred-verification gap**: real-time-driven recompute was not exercised in the browser smoke (the data was already stable at smoke time). The store-switch path and the fire-and-forget `loadMenuCapacity` chain are unit-tested but not live-realtime-tested. This is the same pre-existing gap noted above and is not a blocker.

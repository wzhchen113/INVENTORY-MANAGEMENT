## Verdict
verdict: SHIP_READY
rationale: Zero Criticals across all three reviewers, all 3 code-reviewer Should-fixes folded in and re-verified (jest 493 green, both typechecks exit 0, live browser golden-path passed), main `test.yml` is green — nothing blocks ship.

## Findings summary
- code-reviewer: 0 Critical / 3 Should-fix / 6 Nits. All 3 Should-fixes RESOLVED in the post-review fix-pass (see code-reviewer.md "## Resolution"): S1 `ReorderDatePicker` `selected`-computed-every-render + dead `if` guard → replaced with a `parseLocalDate` helper used by lazy `useState` initializers and `openModal`; S2 unguarded `boxShadow` → `Platform.OS === 'web'` guard matching the `cmd/` family convention; S3 `ReorderSection` store-switch double-fetch / stale-as-of flash → merged into one store-switch-aware effect that resets to today AND fetches as-of today directly. The 6 Nits are cosmetic and deferred (single-letter `DAY_LABELS`, `Number.isNaN(getDay())` idiom, pre-existing misnamed `todayLocalIso`, a `toHaveBeenCalledTimes` flush note, two test-comment notes).
- security-auditor: 0 Critical / 0 High / 0 Medium, 1 Low (clean PASS). The Low is cosmetic only — `ReorderDatePicker` does no defensive validation of its internally-produced `value`/`maxDate` props; not a vulnerability (the date is a bound `::date` param to the unchanged, RLS-gated `report_reorder_list`, whose `auth_can_see_store()` gate runs as the first statement before the date is resolved). Client-side order-out filter narrows-never-widens, correctly not an access boundary. No secrets, no XSS sinks (RN `<Text>` only), no new auth surface, no dependency change.
- test-engineer: 11/11 acceptance criteria PASS. `npx jest` 50 suites / 493 tests green (33 across the 3 new spec-087 suites); base + test-graph typechecks exit 0; no pgTAP needed (FRONTEND-ONLY, no migration). Both correctness traps genuinely pinned: locale-invariant weekday derivation (fixed index array, not `toLocaleString`) and ISO parse at local midnight (no UTC-rollover off-by-one). Three minor NON-BLOCKING gaps: (1) no section-level assertion that `StatCard` receives `computeReorderKpis(primary)` vs `reorderPayload.kpis` (covered by unit tests + code inspection); (2) CSV/PDF export path not exercised in jest (`Platform.OS === 'web'` false in jsdom — pre-existing limitation, no export tests existed before this spec); (3) browser golden-path deferred to main Claude — now CLOSED by the live preview pass.
- backend-architect: NOT INVOKED — correct. Spec is FRONTEND-ONLY (architect's design verdict: no migration, no RPC/RLS/edge/realtime change, no `db.ts` signature change; the FE merely passes the `as_of_date` the RPC already accepts). No backend contract exists to drift, so there is no post-impl drift review to run.

## Recommended next steps (ordered)
SHIP_READY:
  1. Commit the unstaged work. Suggested message line: `Spec 087: Reorder calendar — "what to order today" with go-back-in-time (SHIP_READY)`. The commit covers exactly:
     - `src/utils/reorderDayFilter.ts` (new, pure)
     - `src/components/cmd/ReorderDatePicker.tsx` (new, Cmd-native calendar)
     - `src/screens/cmd/sections/ReorderSection.tsx` (modified)
     - `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` (4 `section.reorder.*` keys each)
     - `src/utils/reorderDayFilter.test.ts`, `src/components/cmd/ReorderDatePicker.test.tsx`, `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx` (new tests)
     - `specs/087/`
  2. NO migration / NO `npx supabase db push` needed — this is FRONTEND-ONLY. Unlike spec 086, there is nothing to push; running a db push here is a no-op. No `db-migrations-applied` gate impact.
  3. After the push to `main`, confirm the latest `test.yml` run on `main` is green (`gh run list --branch main --limit 1`) per the post-push CI rule. (Pre-push baseline is already green: run 26791143633, head 7f75577.)
  4. (Optional, non-blocking follow-ups) The 6 code-reviewer Nits + the 1 security Low. All cosmetic. Highest-value pick if a cleanup pass happens: swap the single-letter `DAY_LABELS` for the `enum.dayOfWeek.short` labels already in the i18n catalog (resolves the S/M/T/W/T/F/S ambiguity the spec itself called out). None block ship and none need a separate spec.

## Out of scope for this review
- The deferred items above are minor follow-ups inside this same surface, not separate specs — no reviewer flagged anything that belongs in a new spec.
- The pre-existing misnamed `todayLocalIso()` (UTC-based despite "local" in the name) at `ReorderSection.tsx:385-387` is pre-spec-087 dead-fallback code the code-reviewer flagged as out-of-scope cleanup — fold into a future tidy pass, not this commit.

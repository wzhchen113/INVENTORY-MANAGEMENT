# Release proposal — spec 112 (Inventory full-width table + detail-on-demand pane)

## Verdict
verdict: SHIP_READY
rationale: All three reviewers land at zero unresolved Criticals — the two test-engineer NOT-TESTED Criticals (AC-10, AC-11) and the one code-reviewer Should-fix are each closed with real, artifact-backed Resolutions, and both post-fix gates (jest 999/999, both typechecks) are green.

## Findings summary
- code-reviewer: 0 Critical, 1 Should-fix, 4 nits. Top issue (Should-fix, RESOLVED): the `[currentStore.id]` store-switch clear fired unconditionally regardless of `viewMode`, so a store switch on the `catalog.tsv` tab silently jostled `InventoryCatalogMode`'s selection (its auto-select-first effect re-selected `filtered[0]`) — a behavior AC-8 says must stay "exactly as today." The ★ single-cost invariant is confirmed HELD: `itemMoney.ts` is the only module computing `currentStock * costPerUnit * subUnitSize` or a `$X.XX`/`$X` cost string in the changed set; both the table cells and the `DetailPane` header call the same four exports. No direct Supabase calls, no color literals, no legacy-file edits, `Platform.OS`-gated Esc listener.
- security-auditor: 0 Critical, 0 Should-fix, 2 nits (both informational). Pure client-side layout over already-RLS-scoped, already-loaded data. Verified: `db.ts` / `supabase/` / `staff/` / `package.json` / lockfile all untouched (empty `git status --porcelain`); no new `supabase`/`createClient`/`.rpc(`/`.from(`/`fetch(` in the diff; no data leakage (all 8 columns surface fields already in the detail pane pre-spec); web-only Esc listener correct and native-safe (`window`/`KeyboardEvent` never referenced outside the guarded effect); no new dependency, no dynamic code, no HTML sink; `npm audit` correctly skipped (no lockfile change).
- test-engineer: coverage gaps closed. At review time 0 FAIL but 2 NOT TESTED Criticals per the house rule (any listed AC with no test is a BLOCK): AC-10 (below-1100 narrow tier — `useIsDesktop → false` branch never exercised) and AC-11 (EDIT/DELETE/+COUNT with the pane open — never pressed; `deleteItem` a bare unasserted `jest.fn()`). Both now FIXED (see Resolution — AC-10 +2 tests, AC-11 +3 tests). All other ACs PASS, including the ★ money equality pin (AC-2: the SAME literal `$0.02`/`$120` appears in both the table cell and the `DetailPane` header, ≥2× each) and the two AC-7 post-impl-fix regression pins (pane-open 8→6, window-1500→7), which the reviewer traced as genuine (would FAIL against the pre-fix frozen-`onLayout` code), not tautological. jest 90/90 suites, 993/993 at review (999/999 post-fix). The one full-run SIGSEGV was an unrelated jest-worker infra artifact in `CountOrderDragList.nudge.test.tsx` (passes 6/6 in isolation; not spec 112).
- backend-architect: not invoked — correctly absent. Frontend-only per OQ-8 (zero migration/RPC/PostgREST/edge/RLS/realtime surface); there is no contract for the backend to drift from, so no post-impl drift pass is warranted (matches the house table for frontend-only specs).

## Blocking-item resolution ledger (all closed, artifact-backed)
- code-reviewer Should-fix (store-switch clear jostling the catalog tab) → FIXED via a `viewModeRef` read inside the AC-8b effect in `src/screens/cmd/InventoryDesktopLayout.tsx` (deps stay `[currentStore.id]` so tab flips don't re-run it), pinned by the new "does NOT clear selection when the store switches while on the catalog tab" jest test in `src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx` (select on items.tsv → flip to catalog.tsv → switch stores → flip back → selection SURVIVED). Case-5 (per-store switch closes the pane) still passes; per-store path re-verified live in the browser.
- test-engineer AC-10 (below-1100 narrow tier) → FIXED, 2 tests in `InventoryDesktopLayout.test.tsx` under the "AC-10 — below-desktop narrow tier" describe (`useIsDesktop → false`: InventoryRow list renders full-width with no table header and no detail on entry; selecting swaps to the full-width detail with ✕ present; ✕ returns to the list).
- test-engineer AC-11 (detail-header actions) → FIXED, 3 tests under the "AC-11 — detail-header actions" describe (confirm-gated DELETE → `deleteItem('i1')` → pane closes; EDIT opens the `IngredientFormDrawer` visible-gated marker; +COUNT fires the palette bridge with `{ section: 'EODCount', eodFocusItemId: 'i1' }`).
- code-reviewer nit (chromeW one-frame negative-sign edge) → FIXED via `setChromeW(Math.max(0, …))` at the outer-row `onLayout` site in `InventoryDesktopLayout.tsx`.

## Remaining nits (non-blocking, reviewers' own out-of-scope framing — no waiver needed)
- Triple comment repetition of the onLayout-doesn't-refire rationale; inline `Pick<…>` param types in `itemMoney.ts`; undocumented `COL_STYLE` fixed pixel widths in `InventoryTable.tsx`; unqueried `accessibilityRole="button"` on the ✕ (label is exercised 7+ times); `visibleColumnsForWidth` not called at the literal boundary integers 1100/1199 (both sides covered via 1150/1200/1250 and 1399/1400/1450). All left as the reviewers framed them.
- security-auditor's pre-existing duplicate `currentStock * costPerUnit * subUnitSize` in five OTHER out-of-scope files (`ReconciliationSection`, `RecipesSection`, `EODCountSection`, `store/useStore.ts`, orphaned `ItemDetailScreen`) is recorded on the CLAUDE.md cleanup backlog — none touched by this diff, all outside spec 112's ★ scope.

## Gate status (verified post-fix by main Claude)
- jest: 999/999 across 90 suites (+6 over the reviewed state: the AC-10/AC-11/catalog-tab pins).
- typechecks: `npx tsc --noEmit` exit 0; `npx tsc -p tsconfig.test.json --noEmit` exit 0.
- pgTAP + shell smokes: correctly NOT run — zero DB surface, spec-authorized skip, `git status --porcelain -- supabase/` empty.
- Browser verification (live): entry 8 columns / no pane; pane-open re-tier 8→6; ✕ restore to 8; real-resize re-tier to 7; ★ money strings byte-match cell↔header live; ✕ + Esc close live; store switch closes the pane on the items tab (re-verified live after the viewModeRef scoping).

## Recommended next steps (ordered)
1. Commit and push the (currently uncommitted) work. No prod DB step — frontend-only, no migration. Ship is user-gated per house rules; main Claude does not auto-commit on SHIP_READY.
2. Immediately after the push to `main`, confirm BOTH active gates are green on `main` via `gh run list --branch main --workflow test.yml --limit 1` and `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`. `test.yml` must be green; `db-migrations-applied.yml` should STAY green (no migration was added, so this diff cannot introduce repo↔prod migration drift). If either run is red or in-progress, surface the run URL and wait for direction before further pipeline work.
3. (optional follow-up, not blocking ship) Add the exact-boundary-integer `visibleColumnsForWidth(1100)` / `(1199)` assertions and a `getByRole('button', { name })` query on the ✕, per the test-engineer's completeness nits.

## Out of scope for this review
- Deleting the orphaned `InventoryListScreen.tsx` / `ItemDetailScreen.tsx` (confirmed dead code; a separate cleanup sweep — spec 112 leaves them untouched).
- De-duplicating the pre-existing `currentStock * costPerUnit * subUnitSize` money-math across the five out-of-scope surfaces (Reconciliation / Recipes / EODCount / useStore / orphaned ItemDetailScreen) — recorded on the cleanup backlog, belongs in its own spec.
- Sortable column headers, filter/⌘K changes, and any `catalog.tsv` / `categories` treatment — all explicitly out of scope per the spec's Out-of-scope section (OQ-4/OQ-5).
- The `app.json` slug and identity drift — CLAUDE.md DO-NOT-AUTO-FIX, untouched.

## Handoff
next_agent: NONE
prompt: SHIP_READY — spec 112 is clean (security 0/0, code-review 0 Critical, test-engineer 0 FAIL). The one Should-fix (store-switch clear jostling the catalog tab) and both NOT-TESTED Criticals (AC-10 narrow tier, AC-11 detail-header actions) are closed with artifact-backed Resolutions; jest 999/999, both typechecks exit 0, pgTAP correctly skipped (frontend-only). Work is uncommitted — recommend user-gated commit + push, then confirm test.yml and db-migrations-applied.yml are both green on main (no migration, so the db gate should stay green). No prod DB step.
payload_paths:
  - specs/112-inventory-table-layout/reviews/release-proposal.md

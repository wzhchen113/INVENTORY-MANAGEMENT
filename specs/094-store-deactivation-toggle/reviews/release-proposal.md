# Release proposal — Spec 094 (store-deactivation-toggle, renumbered from 083)

## Verdict
verdict: SHIP_READY
rationale: Both prior Criticals are closed, no reviewer flags any Critical or Should-fix, and the latest test.yml run on main is green.

## Findings summary
- code-reviewer: 0 Critical, 0 Should-fix, 4 Nits. All 3 prior Should-fix items confirmed resolved (db.ts empty-`dbUpdates` guard added at db.ts:104; pgTAP arm-3 now uses the seed master UUID; `useStore.updateStore` why-comment added). Nits are consistency-only: missing `abortSpy` assertion on the updateStore happy-path test; `updateStore` vs `updateVendor` `|| null` divergence on `eod_deadline_time`; lingering "Spec 083" references in the pgTAP file header; and a documented test-only `useCmdColors` hex stub.
- security-auditor: 0 Critical, 0 High, 2 Low. PASS. All four key claims verified: non-privileged/cross-brand callers blocked by RLS (`privileged_update_stores`, not the client gate); `brand_id` not writable; `fetchStoresIncludingInactive` leaks no cross-tenant rows; no new permissive policy (OR-widening footgun avoided). Lows are defense-in-depth notes on the RLS-denied UPDATE returning 2xx/0-rows (optimistic flip persists until re-fetch) — accepted for v1, admin-only tab.
- test-engineer: BOTH prior Criticals closed. `StoresTab.toggle.test.tsx` (4 tests) covers AC1/AC2 UI wiring; pgTAP arms 7+8 pin the eod-reminder-cron active-only gate (AC5, inactive excluded + active included to prevent false-pass). All 8 ACs PASS or covered. jest 598/598, pgTAP 44/44 (`stores_privileged_update_status` now 8 assertions), smokes pass, typecheck clean. 2 remaining Minor gaps (AC4 no explicit global-cache-untouched assertion; AC7 no no-cascade assertion) — both inherited, correct-by-construction, non-blocking.
- backend-architect: No drift. 0 Critical, 0 Should-fix, 2 Minor record-only. Confirms no new migration/RPC/RLS; existing `privileged_update_stores` reused; global `stores` cache stays active-only (top risk cleared); `brand_id` not writable; eod-reminder-cron gate unchanged. Minors are the intentional Toast/notifyBackendError split and accepted v1 realtime cross-client staleness.

## CI status
Per main Claude's direct verification: all test tracks green (jest 598/598, pgTAP 44/44, smokes pass, typecheck clean) and the latest `test.yml` run on `main` is COMPLETED/SUCCESS via `gh run list`. CI is green — not a blocker.

## Recommended next steps (ordered)
SHIP_READY:

1. **Commit and deploy.** All four reviewers are green (0 Critical, 0 Should-fix across the board), both prior Criticals are genuinely closed, all test tracks pass, and the latest test.yml run on main is green. No new migration/RPC/RLS to ship — the existing `privileged_update_stores` gate is reused.

2. **(Optional, non-blocking follow-ups — none gate ship):**
   - Add `expect(abortSpy).toHaveBeenCalled()` to the updateStore status-toggle jest arm for consistency with the spec-055 abort discipline (code-reviewer nit).
   - Align `updateStore`'s `eod_deadline_time` mapping with `updateVendor`'s `|| null` convention so an empty string clears the column (code-reviewer nit).
   - Update the lingering "Spec 083" header/inline references in `stores_privileged_update_status.test.sql` (and the security-auditor / backend-architect review headers) to "094 (renumbered from 083)" to avoid grep confusion (code-reviewer nit).
   - Optionally add explicit AC4 (global cache untouched after `fetchStoresIncludingInactive`) and AC7 (related-table counts unchanged after a status flip) assertions to convert the two inherited Minor test gaps from correct-by-construction to covered (test-engineer Minors).
   - Defense-in-depth (security Lows): `.select()` on the UPDATE and treat 0 rows as a denial toast, so an RLS-denied write does not show a silent optimistic flip.

## Out of scope for this review
- Live cross-client realtime sync of the include-inactive Stores-tab list (backend-architect M2) — explicit future enhancement, accepted v1 behavior per the spec ("reflected on next render"); belongs in a future spec.
- Full-disable behavior (hiding inactive stores from EOD/reorder/reports/staff picker) — explicitly out of scope per the spec's Decisions and Out-of-scope sections.
- Relaxing the global `fetchStores` active-only filter / global `stores` cache — explicitly forbidden by Q5; verified untouched by both security-auditor and backend-architect.

## Handoff
next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/094-store-deactivation-toggle/reviews/release-proposal.md

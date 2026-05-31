# Release proposal — spec 081

## Verdict
verdict: SHIP_READY
rationale: Zero Critical across both reviewers, both Should-fix fixed in the post-review pass, test-engineer PASS (9/10 ACs covered + load-bearing, the 10th deferred-by-design), and a live per-store visual proof confirms the data-correctness fix in the real DashboardSection.

## Summary

**The bug (real product bug).** On the admin Dashboard, every per-store "Attention Queue" card rendered the `unconfirmed_po` ("VENDOR order missed (DATE)") rows from the *currently-focal* store's order schedule and submissions — not each card's own store. `orderSchedule` in the store is weekday-keyed with no store dimension, and the focal `orderSubmissions` slice only contains the focal store's rows, so `computeAttentionQueue` literally could not filter either by `s.id`. Result: all store cards showed a near-identical (focal-store) missed-order list. The other four attention rules (`eod_missing`, `low_out_stock`, `food_cost_streak`, `expiry`) were already correct per-store; `unconfirmed_po` was the only rule that never got the cross-store treatment.

**The fix (Option B — caller-side wiring, no contract change).** Two new read-only cross-store `db.ts` helpers, mirroring the existing RLS-respecting `fetchEodSubmissionsForStores` / `fetchPosImportsForStores`:
- `fetchOrderScheduleForStores(storeIds)` → `Record<storeId, OrderSchedule>`, queries `order_schedule` with `.in('store_id', storeIds)`, `track()` + `.abortSignal()`, warn-and-return-`{}`.
- `fetchOrderSubmissionsForStores(storeIds, sinceDate)` → flat `OrderSubmission[]` carrying `storeId`/`date`/`vendorName`, queries **`purchase_orders`** (NOT the AC-mislabeled `order_submissions` — Risk 1), `track()` + `.abortSignal()`, warn-and-return-`[]`. Shares a single extracted `mapPurchaseOrderRow` mapper with `fetchRecentPurchaseOrders` (one source of truth, D5).

`DashboardSection` holds both in component-local state, fetched in the existing cross-store `useEffect` (keyed on `stores…join(',')` + `currentStore.id`, same `cancelled` guard + `console.warn` catch), then merges the focal slice over the cross-store copy (`scheduleByStore` spreads cross-store first, then overrides `[currentStore.id]: orderSchedule` so the realtime-fresh focal schedule wins — Risk 6) and passes each store its own slice into `computeAttentionQueue(s.id, …)`. **Option B kept `cmdSelectors.ts` (the contract) and both `runQueue` test helpers untouched** — the 8 `unconfirmedPoWindow` + `eodAndStreak` + `weekWindow` suites stay green by construction.

**Both Should-fix fixed (post-review pass).**
1. Source-table invariant pinned in tests — added `expect(supabase.from).toHaveBeenCalledWith('purchase_orders')` (the Risk-1 silent-failure guard: a revert to the non-existent `order_submissions` now fails loud instead of degrading to `[]`) plus a symmetric `toHaveBeenCalledWith('order_schedule')` on the schedule helper.
2. `fetchRecentPurchaseOrders` callback re-indented to 4 spaces so both callers of the extracted mapper read identically.

**Live per-store proof (the gold standard for a data-correctness fix).** Main Claude booted the preview, signed in as `admin@local.test`, opened the Dashboard. A lingering local `order_schedule` row (Frederick + Thursday + US FOOD, no submission this week) produced the discriminating condition: the "order missed" row appears EXACTLY ONCE across the whole dashboard, on Frederick's card only (`orderMissedTotal: 1`, `frederickHasMissed: true`); Charles / Reisters / Towson show none. Pre-fix (focal-only sourcing) this count would have been 4 (Frederick focal) or 0 (a no-schedule store focal); post-fix it is 1, on the store that actually owns the schedule. Confirmed in the real `DashboardSection`, no runtime error — all four cards + heatmap + KPIs render cleanly.

## Findings summary
- **code-reviewer**: 0 Critical, 2 Should-fix (both FIXED in the post-review pass), 3 Nits (deferred, all cosmetic — `clearAllMocks` comment wording, a symmetric `submittedBy` null-guard assertion, an eslint-disable doc note; none affect correctness). Both highest-priority checks PASS: Risk 1 (source table is `purchase_orders`, not the mislabeled `order_submissions`) and Risk 6 (focal-override merge order in `scheduleByStore`).
- **security-auditor**: not invoked — correct. The two helpers are read-only and mirror the existing RLS-respecting `fetchEodSubmissionsForStores` / `fetchPosImportsForStores`; `.in('store_id', storeIds)` is gated by the existing per-store `auth_can_see_store()` SELECT policies on both `purchase_orders` and `order_schedule`. No new auth/secret/RLS/write surface, no migration, no edge function. The code+test fan-out is proportionate to the change.
- **test-engineer**: PASS — 9/10 ACs covered and load-bearing. The 1 NOT-TESTED (AC5, per-store render WIRING) is deferred by design (D6) to the now-unblocked spec-080 E2E; the db-layer per-store invariant (store A's schedule never bleeds into store B) IS proven by `db.crossStoreLoaders.test.ts`. CAUGHT + FILLED a real gap: the BE's anti-bleed mapper test used disjoint weekdays (A=Mon, B=Tue), which would pass even with a day-first keying bug — added a same-weekday multi-store test. jest 41 suites / 397 tests green; `tsc -p tsconfig.json` exit 0.
- **backend-architect (post-impl)**: not invoked — correct. Option B left `cmdSelectors.ts` (the contract) and `computeAttentionQueue`'s signature unchanged; the fix is db.ts helpers + caller-side wiring only. No contract drift to review.

## Recommended next steps (ordered)

This is **SHIP_READY**.

1. **Commit and deploy** — the user authorizes the commit (main Claude does not auto-commit on SHIP_READY). This is the actual product-bug fix that the spec-080 design investigation surfaced (the dashboard showed the focal store's missed-vendor-orders on every store card). The commit ALSO sweeps in two housekeeping files already staged alongside this change:
   - `specs/078/reviews/release-proposal.md` — the orphaned spec-079 release proposal staged in a prior session (no source impact; housekeeping only).
   - `specs/080-e2e-dashboard-attention-queue-window.md` — the DEFERRED spec-080 doc, which records the deferral rationale and the 080↔081 linkage (081 is the data-plumbing prerequisite that makes 080's per-store E2E deterministic).
   Confirm these two are intended to land in the same commit before authorizing; neither touches runtime code.
2. **Deploy is web-only — NO prod migration.** The two helpers are read-only PostgREST reads against pre-existing tables (`purchase_orders`, `order_schedule`); there is no DB migration, no RPC, no RLS change, no edge function. Web → Vercel deploy only. No `db-migrations-applied.yml` drift exposure. The realtime publication gotcha is NOT in play (no publication change).
3. **(Follow-up, not blocking ship) Revive spec 080.** Landing 081 UN-BLOCKS the deferred spec-080 dashboard-window E2E — each card now shows its own store's data, so the per-store render assertion (with a dedicated non-focal-store fixture) becomes deterministic and meaningful. AC5's render-level per-store wiring proof rightly lands there. This is the intended state per D6.
4. **(Follow-up, optional) The 3 deferred Nits** — cosmetic, can ride a future housekeeping pass.
5. **(Post-push) Confirm CI green on `main`** — the latest `test.yml` run on `main` was green (spec 079); after pushing 081, re-confirm the next `test.yml` run on `main` is green per the project's post-push CI rule.

## Out of scope for this review
- The per-store render WIRING E2E assertion (AC5) — deferred by design to spec 080, now unblocked by this fix.
- The spec-074 Monday-reset window math — unchanged; pinned by the 8 deterministic `unconfirmedPoWindow` tests (Option B touched neither the selector nor its tests).
- Per-store timezone for the queue (still anchors on the brand-global `timezone`), a real `purchase_orders.confirmed/status` field, and subscribing the new loaders to all stores' realtime channels — all explicit spec "Out of scope" follow-ups.

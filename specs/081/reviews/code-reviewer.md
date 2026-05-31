# Code review for spec 081

## Critical

None.

The two highest-priority checks from the spec prompt both pass:

- **Risk 1 — source table.** `fetchOrderSubmissionsForStores` queries
  `purchase_orders` (db.ts:1179), not the non-existent `order_submissions`.
  A 42P01 regression from the mislabeled table would have silently degraded
  to the warn-and-return-empty path, making the fix invisible. Confirmed correct.

- **Risk 6 — merge order.** `scheduleByStore` spreads `crossStoreOrderSchedule`
  first, then overrides `[currentStore.id]: orderSchedule`
  (DashboardSection.tsx:231), so the realtime-fresh focal schedule wins over
  the mount-time cross-store copy. Correct.

---

## Should-fix

- `src/lib/db.crossStoreLoaders.test.ts` (fetchOrderSubmissionsForStores suite)
  — No assertion that `supabase.from` was called with `'purchase_orders'`. The
  mock stubs `from` as `jest.fn(() => mockBuilder)` (line 40) without capturing
  the argument, so a future regression that reverts to `.from('order_submissions')`
  would pass all 10 tests — the exact silent failure mode the spec called out as
  the highest-priority risk (spec 081 Risk 1 / source-table correction section).
  The four other assertions in the `filters by store_id ... returns [] on error`
  test (`.in`, `.gte`, warn) would all still pass against the wrong table name
  because the mock chain doesn't distinguish table names. Fix: add
  `expect(supabase.from).toHaveBeenCalledWith('purchase_orders')` to the
  `filters by store_id via .in()` test (or to a dedicated test) to pin the
  source-table invariant.

- `src/lib/db.ts:1143-1151` — The body of the `track()` callback in
  `fetchRecentPurchaseOrders` is indented at 2 spaces rather than 4 spaces
  inside its `track(async (signal) => {` callback. This was a pre-existing
  inconsistency, but spec 081's `mapPurchaseOrderRow` extraction (D5) left it
  in place while adding the new `fetchOrderSubmissionsForStores` immediately
  below with correct 4-space indentation (lines 1177-1190). The two callers of
  `mapPurchaseOrderRow` now read with different internal indentation, making the
  extraction's "byte-identical callers" intent harder to verify by eye. Fix:
  re-indent lines 1143-1151 to 4 spaces to match the new helper and the rest of
  the file.

---

## Nits

- `src/lib/db.crossStoreLoaders.test.ts:67` — The comment "clearAllMocks wipes
  the `mockReturnThis()` implementations" is inaccurate. `jest.clearAllMocks()`
  clears call records (`.mock.calls`, `.mock.results`, etc.) but does NOT reset
  implementations. The re-arm in `beforeEach` is harmless, but the comment
  misattributes the reason. The implementation is actually cleared only by
  `jest.resetAllMocks()`. Consider correcting to: "re-arm the chain links each
  test so `mockReturnThis()` is not accidentally lost if Jest's behaviour
  changes" — or just drop the misleading sentence.

- `src/lib/db.crossStoreLoaders.test.ts:196-208` — The `defaults vendorName to
  "" when vendor join is null` test omits a symmetric check for `submittedBy`.
  `mapPurchaseOrderRow` also null-guards `submittedBy: r.creator?.name || ''`
  (db.ts:1127); asserting `result[0].submittedBy === ''` when `creator: null`
  would be symmetric with the vendor check and would pin both null-guard paths
  in one test. Not required by spec but mirrors the "three predicate-critical
  fields" framing.

- `src/screens/cmd/sections/DashboardSection.tsx:204` — The `eslint-disable`
  comment explains `storeIds.join()` and `currentStore.id` but doesn't mention
  that `db` (the namespace import at line 13) is also intentionally omitted from
  deps. Minor documentation gap; the omission is correct because `db` is a stable
  module reference.

---

## Resolution (post-review fix-pass — main Claude)

- **Should-fix #1 (source-table not pinned in tests)** — **fixed.** Added `expect(supabase.from).toHaveBeenCalledWith('purchase_orders')` to the `fetchOrderSubmissionsForStores` store-id test (the Risk-1 guard — a revert to the non-existent `order_submissions` now fails loud instead of silently degrading to `[]`), plus a symmetric `toHaveBeenCalledWith('order_schedule')` on the schedule helper's test. Imported the mocked `supabase` to reference the spy.
- **Should-fix #2 (4-space re-indent of `fetchRecentPurchaseOrders` callback)** — **fixed.** Lines re-indented to 4 spaces so both callers of the extracted `mapPurchaseOrderRow` read identically.
- **Nits (3)** — deferred (all cosmetic: the `clearAllMocks` comment wording, a symmetric `submittedBy` null-guard assertion, an eslint-disable doc note). None affect correctness.

test-engineer separately closed a real coverage gap: the BE's anti-bleed mapper test used DISJOINT weekdays (A=Mon, B=Tue), which would pass even with a day-first keying bug; it added a same-weekday multi-store test. jest now 41 suites / 397 tests.

### Live visual proof (main Claude, post-fix-pass)

Booted the preview, signed in as `admin@local.test`, opened the Dashboard at desktop. A lingering local `order_schedule` row (Frederick + Thursday + US FOOD, no submission this week) produced exactly the discriminating condition: **`document.body` contains the "order missed" row EXACTLY ONCE, and it is on Frederick's card** (`orderMissedTotal: 1`, `frederickHasMissed: true`) — Charles / Reisters / Towson show none. Pre-fix (focal-only sourcing) this count would be 4 (if Frederick were focal) or 0 (if a no-schedule store were focal); post-fix it is 1, on the store that actually owns the schedule. The per-store fix is confirmed in the real `DashboardSection`, not just unit-proven. No runtime error — all four cards + the heatmap + KPIs render cleanly.

Re-verified: `tsc -p tsconfig.json` exit 0; jest 41 suites / 397 tests green.

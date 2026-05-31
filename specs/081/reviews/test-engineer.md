## Test report for spec 081

### Acceptance criteria status

- AC1: `db.fetchOrderScheduleForStores(storeIds)` returns a store-indexed schedule, queries `order_schedule` with `.in('store_id', storeIds)`, chains `.abortSignal(signal)` inside `track(…, { kind: 'read', label: 'fetchOrderScheduleForStores' })`, and returns `{}` when `storeIds.length === 0`. Mirrors `fetchOrderSchedule` row-object mapping (`vendorId`, `vendorName`, `deliveryDay`).
  → PASS — `src/lib/db.crossStoreLoaders.test.ts::fetchOrderScheduleForStores/*` (5+1 tests). Implementation at `src/lib/db.ts:3487`. Empty-input short-circuit at 3490, `track`+`.abortSignal` at 3491/3496, `.in('store_id', storeIds)` at 3495, vendor field mapping at 3507-3510, warn-and-return-`{}` at 3498-3499.

- AC2: `db.fetchOrderSubmissionsForStores(storeIds, sinceDate)` returns flat order submissions for all stores since `sinceDate`, queries `purchase_orders` (NOT the mislabeled `order_submissions` table — spec risk 1 correctly mitigated) with `.in('store_id', storeIds)`, chains `.abortSignal(signal)` inside `track(…, { kind: 'read', label: 'fetchOrderSubmissionsForStores' })`, returns `[]` when `storeIds.length === 0`. Each row carries `storeId`, `date`, `vendorName`.
  → PASS — `src/lib/db.crossStoreLoaders.test.ts::fetchOrderSubmissionsForStores/*` (5 tests). Implementation at `src/lib/db.ts:1172`. Empty-input short-circuit at 1176, correct table `purchase_orders` at 1179, `.in` at 1181, `.gte('created_at', sinceDate)` at 1182, `mapPurchaseOrderRow` extraction verified at 1100-1137 (storeId/date/vendorName all populated). Warn-and-return-`[]` at 1186-1188.

- AC3: `DashboardSection` holds `crossStoreOrderSchedule` / `crossStoreOrderSubmissions` in component-local state, fetched in a `useEffect` keyed on `stores.map(s => s.id).join(',')` + `currentStore.id`, with the `cancelled` guard and `console.warn` catch.
  → PASS (code review, no jest harness for DashboardSection render). Implementation at `src/screens/cmd/sections/DashboardSection.tsx:162-197`. State declared at 162-167, fetched in the existing cross-store `useEffect` at 169-205 (dep array at 205: `[stores.map(s => s.id).join(','), currentStore.id]`), `cancelled` guard at 190/194, `console.warn` catch at 192/196. Wiring-level proof deferred to spec-080 E2E per D6 design decision — rationale confirmed sound (see coverage seam section below).

- AC4: The `queueByStore` loop passes each store its own schedule and submissions — never the focal-store slices for a non-focal card.
  → PASS (code review). Implementation at `src/screens/cmd/sections/DashboardSection.tsx:325-345`. Loop at 327-343 passes `allOrderSubmissions` (focal-merged flat list, selector self-filters by `storeId`) at 336 and `scheduleByStore[s.id] ?? EMPTY_ORDER_SCHEDULE` at 337. The merge memos are correct: `allOrderSubmissions` at 222-225 filters out `currentStore.id` rows from the cross-store set then appends focal `orderSubmissions`; `scheduleByStore` at 230-233 spreads cross-store FIRST then overrides `[currentStore.id]: orderSchedule` (Risk 6 spread order correct). `queueByStore` dep array at 345 includes `allOrderSubmissions` and `scheduleByStore` (not the raw focal slices). Wiring-level proof deferred to spec-080 E2E — same rationale as AC3.

- AC5: On a dashboard with ≥2 stores that have different order schedules, each card's `unconfirmed_po` rows reflect that card's store only.
  → NOT TESTED by an automated assertion (E2E deferred to spec-080; spec-080 is DEFERRED pending the spec-080 architect's decision). The spec explicitly calls this out (D6: "The per-store WIRING assertion … is better left to the un-deferred spec-080 E2E"). The db-layer correctness (store A's schedule never bleeds into store B's bucket) IS proven by `db.crossStoreLoaders.test.ts`. The render-level per-store proof awaits spec-080. This is the intended state per D6; not a blocking gap at this layer.

- AC6: The focal store's card continues to reflect realtime updates via the focal-slice merge (spread cross-store first, then override focal id with live `orderSchedule`).
  → PASS (code review). `scheduleByStore` at `DashboardSection.tsx:230-233`: `{ ...crossStoreOrderSchedule, [currentStore.id]: orderSchedule }` — cross-store spread at position 1 (mount-time), focal override at position 2 (live from `useStore`). Risk 6 spread order confirmed correct.

- AC7: The other four attention rules (`eod_missing`, `low_out_stock`, `food_cost_streak`, `expiry`) are unchanged in behavior and output.
  → PASS — `npx jest` 41 suites / 397 tests all green. `cmdSelectors.eodAndStreak.test.ts` tests for `eod_missing` / `food_cost_streak` pass. `DashboardSection` wiring for `allEod`/`allPos` is unchanged (`heatmapRows`, `queueByStore` both use `allEod`/`allPos` as before). `computeAttentionQueue` signature is unchanged (Option B).

- AC8: Existing jest suites stay green: `cmdSelectors.unconfirmedPoWindow.test.ts` (8 tests) and `weekWindow.test.ts`.
  → PASS — both suites ran explicitly. `cmdSelectors.unconfirmedPoWindow.test.ts`: 8/8 pass. `weekWindow.test.ts`: 13/13 pass (including Mon-reset, exclude-today, DST edges). `computeAttentionQueue` signature unchanged (Option B), so zero lockstep edits were needed.

- AC9: No regression to the spec-074 Monday-reset window semantics (today excluded; only this work-week's store-tz missed orders show).
  → PASS — `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` 8 tests pass including "today is excluded" and "UTC late-night Monday still treats this week as starting on NY Monday." `src/lib/cmdSelectors.ts` was not touched by spec-081 (Option B).

---

### Test run

```
npx tsc --noEmit -p tsconfig.json
TSC EXIT: 0

npx jest
Test Suites: 41 passed, 41 total
Tests:       397 passed, 397 total   (was 396 pre-spec-081; +10 from BE dev; +1 added by test-engineer)
Snapshots:   0 total
Time: ~2.2s

Specific suite breakdown (by track relevance):
  src/lib/db.crossStoreLoaders.test.ts          11/11 PASS  (was 10; +1 same-day multi-store gap)
  src/lib/cmdSelectors.unconfirmedPoWindow.test  8/8  PASS  (unchanged — Option B)
  src/utils/weekWindow.test.ts                  13/13 PASS  (unchanged)
```

---

### Coverage seam analysis (D6 audit)

#### What the 10 (now 11) mapper units prove

The BE dev's 10 mapper units cover:

1. `fetchOrderScheduleForStores` — 5 tests:
   - Empty-input short-circuit (no Supabase call)
   - Store-keying: A's rows under A, B's rows under B (interleaved, different weekdays)
   - Multi-vendor on same store+weekday grouped into one array
   - PostgREST error returns `{}` + `console.warn` fires + `.in('store_id', storeIds)` confirmed
   - Empty-rows-from-DB returns `{}`

2. `fetchOrderSubmissionsForStores` — 5 tests:
   - Empty-input short-circuit
   - `reference_date → date` and `vendor.name → vendorName` per store (predicate-critical fields)
   - `created_at` fallback when `reference_date` is null
   - PostgREST error returns `[]` + `.in` + `.gte('created_at', since)` confirmed
   - Null vendor join defaults `vendorName` to `""`

**Gap found and filled (test-engineer addition):** The existing anti-bleed test used store A=Monday, store B=Tuesday (disjoint weekdays). In production, every store is likely scheduled on the same weekdays (all four seed stores probably share Monday/Wednesday/Friday vendor order days). A hypothetical buggy implementation that keyed by `day_of_week` FIRST and `store_id` SECOND would pass the disjoint-day test but fail the same-weekday-two-stores case: A's Monday array would also contain B's Monday vendor. Added `'two stores sharing the same weekday each get only their own vendor — same-day multi-store'` (17 lines) to close this gap. The implementation's `store_id`-first grouping (`const sid = row.store_id; if (!byStore[sid]) byStore[sid] = {}`) passes the new test correctly.

**No other vacuous tests found.** All 11 units assert non-trivial invariants; none would pass if the store-keying logic were inverted.

#### The wiring seam (confirmed correctly deferred)

The `scheduleByStore` and `allOrderSubmissions` merge memos are pure computed expressions embedded in `DashboardSection`'s render body — they are not extracted as standalone helpers. A jest render test of `DashboardSection` would require:
- A full `@testing-library/react-native` render
- Mocking `useStore` (Zustand context with `inventory`, `orderSchedule`, `orderSubmissions`, `stores`, `currentStore`, `users`, `auditLog`, `eodSubmissions`, `posImports`, `posImports`, `timezone`, `storeLoading`, `getItemStatus`)
- Mocking `db.fetchOrderScheduleForStores`, `db.fetchOrderSubmissionsForStores`, `db.fetchEodSubmissionsForStores`, `db.fetchPosImportsForStores`
- Waiting for the `useEffect` async fetch to complete before asserting `queueByStore`

`DashboardSection` has no existing jest test harness; this is well past the "≤20 line cheap gap" threshold and would be a significant new harness. The D6 call to defer the render-level per-store wiring proof to spec-080's E2E is correct.

The spec-080 design recorded RE-DEFER because, at the time of 080's architect pass, the dashboard still had the focal-contamination bug — an E2E would have been non-deterministic. **Once spec-081 lands**, spec-080's blocker is removed: the dashboard is genuinely per-store. The spec-080 file records this linkage explicitly ("landing 081 un-blocks spec 080"). This is the right state.

#### Spec-080 linkage confirmation

`specs/080-e2e-dashboard-attention-queue-window.md` status is `DEFERRED (architect RE-DEFER — Q5)`. The re-defer was made BEFORE spec-081 existed. The 080 design doc's "Surfaced for the PM" section explicitly recommends a follow-up spec adding `fetchOrderScheduleForStores`/`fetchOrderSubmissionsForStores` as the prerequisite for 080 becoming meaningful. Spec-081 IS that follow-up. The 080 doc's re-defer rationale no longer applies after 081 lands, and the per-store render proof rightly lives there. This is correctly structured.

---

### Notes

1. **Table name correction confirmed applied.** The spec's AC text mislabeled the source table as `order_submissions` (which does not exist). The implementation correctly queries `purchase_orders` (confirmed at `db.ts:1179`). Risk-1 comment is present in the code. No silent work-around — the correction is documented in the spec's design section and in code comments.

2. **`mapPurchaseOrderRow` extraction confirmed.** The D5 preferred-path (single shared row mapper called by both `fetchRecentPurchaseOrders` and `fetchOrderSubmissionsForStores`) is implemented at `db.ts:1100-1137`. Both callers invoke it (`db.ts:1151`, `db.ts:1189`). One source of truth for snake→camel mapping.

3. **No pgTAP or shell-smoke tests needed.** No migration, no RPC, no edge function — the spec correctly identifies jest as the sole relevant test track (spec 022 Track 1).

4. **No realtime publication gotcha.** Confirmed: no `supabase_realtime` publication change in this spec; `docker restart supabase_realtime_imr-inventory` is not needed.

5. **`app.json` slug untouched.** Confirmed.

6. **One gap test added by test-engineer** (same-weekday multi-store, 17 lines). Suite count stays at 41; test count moves from 396 → 397. The new test is `src/lib/db.crossStoreLoaders.test.ts::fetchOrderScheduleForStores::two stores sharing the same weekday each get only their own vendor — same-day multi-store`.

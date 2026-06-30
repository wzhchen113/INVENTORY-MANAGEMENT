## Test report for spec 103

### Acceptance criteria status

Storage + privacy (backend):

- AC-1: A per-user store exists; signed-in user can read/write ONLY their own rows; RLS denies cross-user SELECT/UPDATE/DELETE/INSERT under all four screen keys → **PASS** — `supabase/tests/user_count_orders_rls.test.sql` assertions (1)–(7): A inserts own row, reads it back, B cannot SELECT/UPDATE/DELETE A's row (0 rows each), B INSERT-as-A → 42501, super_admin → 0 rows (no bypass).
- AC-2: Four independent keys, NULL-vendor and non-NULL-vendor rows coexist; writing one key leaves another unchanged → **PASS** — assertions (8)–(11): admin-inventory (NULL) coexists with admin-eod (vendorX), vendorX + vendorY rows coexist, vendorX item_ids untouched by writing inventory/vendorY. NOTE: the pgTAP upsert uses raw SQL `ON CONFLICT ... WHERE vendor_id IS NULL`, which is the Postgres path, NOT the PostgREST delete-then-insert path the app actually calls — see Notes.
- AC-3: Saving an order and reloading renders rows in the saved order (round-trip) → **PARTIAL PASS** — SQL-layer round-trip covered by assertion (2) in pgTAP. The app-layer round-trip is covered only by mocked jest (staff EODCount spec 103 test "opens in Custom view and renders rows flat in the SAVED order"). No automated test hits the real PostgREST persist path.
- AC-4: Reset removes the caller's saved order for one screen key only; others untouched → **PASS** — assertion (12) confirms admin-eod/vendorX row gone after delete; assertion (13) confirms admin-inventory untouched. Staff WeeklyCount "Reset returns to the default category-grouped view" confirms reset → default view in jest.

Drag UX + apply (frontend):

- AC-5: Drag-to-reorder works on web (dnd-kit) and native (▲/▼ buttons) → **NOT TESTED** — native testing is not set up (per project policy for this setup). Web drag via dnd-kit is not exercised in jest (jsdom does not support pointer-drag events). The `nudge` math for native ▲/▼ is unit-tested by `CountOrderDragList.nudge.test.tsx` (6 tests). The UI affordances themselves (grip handles, ▲/▼ pressables, dnd-kit sortable context) are rendered by the admin and staff drag components but no test fires a drag event end-to-end.
- AC-6: Arrangement persists on drop; failed write surfaces via `notifyBackendError` and does not corrupt on-screen order → **NOT TESTED** — the persist path (`saveCountOrder` = delete-then-insert) is never called in any automated test. No drag/reorder is triggered in any spec 103 jest test. The optimistic-revert path on error is likewise untested. See Notes for the Critical assessment.
- AC-7: Saved order is fetched on open and applied as the initial render order → **PASS** — EODCount spec 103 test "opens in Custom view and renders rows flat in the SAVED order" (mocked fetch returns `{ item_ids: ['item-2', 'item-1'] }`, asserts custom toggle selected and both rows rendered). WeeklyCount "opens in Custom view (category headers suppressed) when a saved order exists" similarly.
- AC-8: Per-screen reset affordance returns the screen to its default order and persists the reset → **PARTIAL PASS** — Staff EODCount "Reset returns to default view" and WeeklyCount "Reset returns to the default category-grouped view" confirm the view-toggle side. The persist side of reset calls `resetCountOrder` (delete one row), which the mock handles via `then: resolve({data:null, error:null})` — the call succeeds silently in the mock; no test verifies the delete actually targeted the correct `(screen, vendor?)` key.

Coexistence with existing behavior:

- AC-9: Submission scope identical with and without a custom order → **PARTIAL PASS** — Covered by jest for staff EOD ("AC-9: the submit payload is byte-identical with and without a custom order") and staff Weekly ("AC-9: the submit payload is byte-identical…"). **NOT TESTED for admin EOD or admin Inventory.** The spec §13 explicitly requires AC-9 for admin surfaces; no test exists in `EODCountSection.countedOnce.test.tsx` or any new admin test file.
- AC-10: Search composes with custom order → **PARTIAL PASS** — Covered by WeeklyCount "AC-10: search composes with the custom order" (filters to 'Banana', asserts item-1 gone, item-2 present). **NOT TESTED for admin EOD, admin Inventory, or staff EOD.** Spec §13 requires AC-10 for admin surfaces.
- AC-11: "X of N counted" label counts the same set regardless of arrangement; red-uncounted marking unchanged → **NOT TESTED directly** — no spec 103 jest test explicitly asserts the counter math is unchanged across viewMode. Implicitly covered by the fact that the counter derives from `items` (staff) / `filteredItems` (admin), which are unchanged, and the AC-9 submission byte-identity tests prove the full item set is still iterated. Acceptable as implicit coverage given AC-11 is order-independent.
- AC-12: Gate follows custom order; "jump to first uncounted" targets topmost uncounted in the user's custom order → **PARTIAL PASS** — Covered for staff EOD ("AC-12: the gate jump targets the first uncounted in the CUSTOM order") and staff Weekly ("AC-12: the gate jump…"). Pure logic covered by `countOrder.test.ts` `firstUncounted` tests including the AC-12 regression test. **NOT TESTED for admin EOD** (the third gated screen). No admin spec 103 test exists.
- AC-13: Custom order coexists with category grouping (flat Custom view, grouped Default) → **PASS** — WeeklyCount "opens in Custom view (category headers suppressed)" asserts `queryByTestId('weekly-category-header-Produce')` is null in custom view and present in default view (reset test). OQ-2 resolution (flat Custom) is implemented and verified at the render level.
- AC-14: New/unranked items append after all ranked items and never disappear → **PASS** — `countOrder.test.ts` "new / unranked items append in the screen default order and never disappear" and "empty item set yields an empty result" directly cover OQ-3. Belt-and-braces assertion (`out.toHaveLength(items.length)`, set equality) confirms no item is ever dropped.

### Test run

**pgTAP** (`npm run test:db`):
```
✓ 57/57 DB test file(s) passed
user_count_orders_rls.test.sql: PASS (13 assertions)
permissive_policy_lint.test.sql: PASS (4 assertions)
```

**jest** (`npx jest --no-coverage`):
```
Test Suites: 69 passed, 69 total
Tests:       755 passed, 755 total
Time:        3.266 s
```
Breakdown of spec 103 new tests:
- `src/lib/countOrder.test.ts`: 16 tests (applyCountOrder: 11, firstUncounted: 5)
- `src/components/cmd/CountOrderDragList.nudge.test.tsx`: 6 tests
- `src/screens/staff/screens/EODCount.test.tsx` (spec 103 describe): +4 tests
- `src/screens/staff/screens/WeeklyCount.test.tsx` (spec 103 describe): +5 tests

**TypeScript** (`npx tsc --noEmit` and `npm run typecheck:test`):
```
exit 0 (clean)
```

Note: jest emits a non-failing `console.error "An update to EODCount inside a test was not wrapped in act(...)"` during the AC-12 test (the `setPendingFocusId(null)` fires in a `requestAnimationFrame` after the assertion completes). This is cosmetic — the test itself passes and this pattern existed before spec 103 on the same focus-reset path.

### Notes

**Critical: persist-on-drop has no automated test that would catch its regression class.**

The feature's core write path — `saveCountOrder` (delete-then-insert in both `src/lib/db.ts` and `src/screens/staff/lib/countOrder.ts`) — is never invoked in any automated test. The jest mocks for `user_count_orders` handle `delete` (via the thenable builder) and `maybeSingle` (for reads), but neither mock includes `insert`. No spec 103 test fires a drag/reorder action (all four spec 103 test cases — "opens in Custom", AC-9, AC-10/AC-12, reset — open with a pre-seeded mock result and never call `onReorder`/`onDrop`). The stack of evidence:

1. `CountOrderDragList.nudge.test.tsx` proves the reorder *math* is correct (the new `id[]` produced by ▲/▼ is right).
2. `countOrder.test.ts` proves `applyCountOrder`/`firstUncounted` are correct (the order is *applied* correctly).
3. The spec 103 jest screen tests prove the view-toggle, load, gate, and reset behaviors.
4. No test calls `saveCountOrder`, verifies the delete fires on the correct `(screen, vendor?)` key, or verifies the subsequent insert lands.

The developer's live probe (signed in as `manager@local.test`, run against the local stack) is the only evidence the delete-then-insert path works. That probe is one-time, not repeatable, and not gated in CI.

**What a regression would look like:** If `saveCountOrder` is reverted to `.upsert({ onConflict })` (the original 42P10 bug), no automated test would fail. The only symptom would be orders "snapping back" on the next screen load — a runtime behavior that CI cannot detect.

**Why the pgTAP key-independence test does not cover this:** The pgTAP test's assertions (8)/(9)/(10) use raw SQL `INSERT ... ON CONFLICT (user_id, screen) WHERE vendor_id IS NULL ... DO UPDATE`. Raw SQL CAN name the partial-index predicate; that is exactly what the app CANNOT do via PostgREST `.upsert()`. So the pgTAP test validates the partial-index uniqueness constraint itself (correct) but does not exercise the delete-then-insert code path the app calls (gap).

**Recommendation:** A pgTAP test or an integration smoke test exercising the PostgREST delete-then-insert sequence (insert → second insert replaces not duplicates → reset deletes, all via PostgREST) would durably catch a regression to `.upsert()`. This is the same class of gap that caused the original 42P10 bug to ship undetected (the pgTAP test passed because it used raw SQL, not PostgREST). Flagged as a Critical finding: the feature's primary write path has zero automated coverage that would catch re-introducing the design's original bug.

**Missing admin screen AC-9 / AC-10 / AC-12 tests (Critical):**

The spec §13 explicitly lists admin EOD and admin Inventory as surfaces requiring jest coverage for AC-9 (submission byte-identical), AC-10 (search composes), and AC-12 (gate jump follows custom order — admin EOD only, since admin Inventory has no gate). No new or extended tests exist in:
- `src/screens/cmd/sections/__tests__/EODCountSection.countedOnce.test.tsx`
- Any new admin test file

Admin EODCountSection and InventoryCountSection have the `viewMode` toggle, `applyCountOrder`, and `firstUncounted` wired in their component code (confirmed in source), but there are no spec 103 jest tests asserting their behavior. AC-9 and AC-12 for admin EOD are NOT TESTED.

**Spec 102 un-windowing preserved (no regression):**

The staff WeeklyCount default view SectionList retains `initialNumToRender={items.length * 3 + 10}`, `maxToRenderPerBatch={items.length * 3 + 10}`, `windowSize={Math.max(21, items.length)}`. The Custom view uses `CountOrderDragList` (a plain `View`-mapped column — inherently un-windowed, every row mounted). No windowing was reintroduced. The WeeklyCount "opens in Custom view" test confirms both rows render in custom view.

**AC-5 / native drag (gap, not new):**

Native drag (▲/▼ buttons) UX is not end-to-end tested — native testing is not set up per project policy. Web drag (dnd-kit) is not testable in jsdom. The `nudge` math (the only hand-rolled reorder logic) is fully unit-tested (6 cases). This is a pre-existing gap acknowledged in CLAUDE.md.

**DB prod-apply pending:**

Migration `20260630000500_user_count_orders.sql` is applied to the local stack only. It has NOT been pushed to prod. The `db-migrations-applied.yml` gate will hard-fail once this lands on `main` unless the user applies the migration to prod via the Supabase MCP. This is flagged in the spec's handoff (§12) and is the user's responsibility per project policy.

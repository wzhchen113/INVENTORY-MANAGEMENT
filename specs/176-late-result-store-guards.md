# Spec 176: Drop late results that belong to a store the user has left

Status: READY_FOR_REVIEW

Origin: the spec 175 security audit ([specs/175-reorder-survives-reload/reviews/security-auditor.md](175-reorder-survives-reload/reviews/security-auditor.md)), findings **L2** and **L3**, and step 4 of the spec 175 release proposal ([specs/175-reorder-survives-reload/reviews/release-proposal.md](175-reorder-survives-reload/reviews/release-proposal.md)). The owner approved the scope and every design decision below before this spec was written. They are recorded as requirements. No questions remain open.

**Sequencing:** builds on spec 175 (commit `8acecc4`). Line numbers are from `main` at `8acecc4`. Treat them as pointers.

## User stories

1. As a **manager who switches stores while the reorder list is loading**, I want the previous store's list to never show up under the new store, so that an export can never file a draft PO under one store that holds another store's items.
2. As a **manager who switches stores while a full reload is still in flight**, I want the new store's inventory, vendors, order schedule and brand to stay put, so that an export from the new store's reorder list is costed correctly and keeps its vendor order codes.
3. As a **manager switching stores**, I want the "switching store" overlay to clear exactly when the new store has loaded, not earlier because an older load finished, and never to get stuck.

## Current state (verified 2026-10-26, `main` at `8acecc4`)

### L2: late foreground reorder result (Medium standalone)

- `loadReorderSuggestions` ([src/store/useStore.ts:4670](../src/store/useStore.ts)) captures `storeId = currentStore.id` at call start, bumps the module-level `reorderRequestGen` (L237), sets `reorderLoading: true`, then writes the result **unconditionally**: on success `{ reorderPayload, reorderStoreId: storeId, reorderLoading: false, reorderError: null }` (L4677), on failure `{ reorderLoading: false, reorderError }` (L4681).
- **The race.** A foreground load for store A settles after the user switched to B. A's lines render under B.
- **How it reaches a write.** An export from that screen snapshots `exportedAt.storeId = currentStore.id` (B) together with the vendor object holding A's item ids. `recordExportedOrder` (L3915) checks only `get().currentStore?.id !== storeId` (L3947). That check passes because B is still current. `buildDraftOrderLines` does not filter by membership in `inventory`. The result is a draft PO under `store_id = B` carrying A's item ids.
- **The server does not reject it.** The `po_items` insert policy ([supabase/migrations/20260504173035_per_store_rls_hardening.sql:216](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)) only checks that the caller can see the **parent PO's** store. `po_items.item_id` is a plain FK to `inventory_items`, with no store check.

### L3: late full reload (Low, but spec 175 made the window exportable)

- In the single-store branch of `loadFromSupabase(sid)` (L2171-2279), `await db.fetchAllForStore(sid)` is followed by an unconditional `set` of `brand`, `catalogIngredients`, `inventory`, `recipes`, `prepRecipes`, `vendors`, `wasteLog`, `auditLog`, `eodSubmissions`, `orderSubmissions`, the category / conversion / alias / saved-report slices, `orderSchedule`, the spec 175 reorder spread, `menuCapacity` and the spec 160 `lastCounted*` keys. After that come the tails: `loadMenuCapacity(sid)` (L2284), `loadItemsLastCounted(sid)` (L2288), the spec 175 silent refresh (L2292), `cleanupOldRecords` (L2296), and the notifications fetch (L2300-2312).
- **The race.** A stale `loadFromSupabase(A)` resolves after the user switched to B and after B's own reload landed. It overwrites B's slices with A's. Spec 175's A′ rule keeps B's reorder list on screen (B owns it), so the list now sits next to A's `inventory` / `vendors` / `orderSchedule`.
- **Effect.** An export in that window costs lines wrong: the `subUnitSize` lookup in `buildDraftOrderLines` misses and falls back to 1, which skips the spec 104 bridge. It also loses vendor order codes. Every other section shows A's data under B until the next reload.
- **The `__all__` branch** (L2137-2168) has the same unconditional-write shape after its `Promise.all`.
- **Spec 111 overlay.** `finally` always runs `set({ storeLoading: false, switching: null })` (L2323). So a stale load that finishes first clears the overlay while the new store's load is still in flight.

### Facts the fix relies on

- Every production caller of `loadFromSupabase` passes the then-current store, and every store-changing path writes `currentStore` **before** calling it: `login`'s `land` (L1484-1486), both `setCurrentStore` paths (L1652-1654, L1664-1666), CmdNavigator `handleSync` (reads `currentStore.id`, [CmdNavigator.tsx:68-69](../src/navigation/CmdNavigator.tsx)), `applyVendorsToAllStores` (L2462-2463), and the no-arg call (L4311).
- No production path sets `currentStore.id` to `'__all__'`. `setCurrentStore` redirects it to a real store (L1639-1655).
- "All brands" sets the placeholder `currentStore = { id: '' }` and runs no load.
- `reorderRequestGen` is bumped by every foreground `loadReorderSuggestions` call **and** by every spec 175 silent refresh (L263).

## Definitions

- **Call-start store:** the store id a call captured when it started (`storeId` in `loadReorderSuggestions`, `sid` in `loadFromSupabase`).
- **Stale result:** a result whose call-start store is not `get().currentStore?.id` at the moment the result would be written.
- **Dropped:** the call writes none of its result keys and runs none of its follow-up work. The only exceptions are the progress resets named in the requirements.
- **Newest reorder request:** the call whose captured `reorderRequestGen` value still equals the module-level counter.
- **Newest load:** the `loadFromSupabase` call whose captured load-counter value still equals a new module-level load counter.

## Requirements (owner-approved)

- **R-1. L2 drop in `loadReorderSuggestions`.**
  - On **both** settle paths (success and failure): if `get().currentStore?.id !== storeId` (the call-start store), write none of `reorderPayload`, `reorderStoreId`, or `reorderError`.
  - On a dropped result, reset `reorderLoading` to `false` **only if** this call is still the newest reorder request. This way a dropped stale result never cancels the new store's in-flight spinner, and it never strands `reorderLoading: true` (for example, after a switch to the "All brands" placeholder, where no new load runs).
  - Do **not** drop a foreground result on generation alone. Silent refreshes also bump the counter, so a generation-only rule would make a valid current-store foreground result look stale.
  - A non-stale result is written exactly as today.
- **R-2. L2 backstop in `recordExportedOrder`.**
  - Refuse when `get().reorderStoreId !== storeId` (the snapshot store from `exportedAt`). Refusing means no `upsertVendorDraftOrder` call and a return of `null`.
  - Report it with `notifyBackendError('Record exported order', …)`, the same way as the existing "Active store changed during the export — not recorded" refusal.
  - No UI changes.
- **R-3. L3 drop in `loadFromSupabase`.**
  - **Single-store branch.** After `fetchAllForStore(sid)` resolves, if `sid !== get().currentStore?.id`, return before the `set`. That means no slice writes, no spec 060 `loadMenuCapacity` tail, no spec 160 `loadItemsLastCounted` tail, no spec 175 silent refresh, no `cleanupOldRecords`, and no notifications fetch.
  - **`__all__` branch.** Apply the same rule after its `Promise.all`: if `'__all__' !== get().currentStore?.id`, return before its `set`.
  - The `stores` write (L2129-2132), which runs before the branch, stays as it is.
- **R-4. Spec 111 overlay reset.**
  - `finally`'s `set({ storeLoading: false, switching: null })` runs only when this call is still the newest load.
  - The load counter is module-level, the same posture as `reorderRequestGen`. It is not Zustand state.
  - The newest load always resets, so the overlay can never strand.
  - The spec 152 session-probe bail path keeps its existing reset exactly as it is, including its identity-moved early return (L2104-2122).
- **R-5. Do not bring back the stale-reload clear.** Spec 175's A′ keep-or-clear rule stays as it is. Its stale-reload case simply becomes unreachable, because a stale load now writes nothing.

## Acceptance criteria

The test track is jest only. There is no pgTAP or shell smoke, because there is no DB change. Store-level ACs use the real store with `db` and `../lib/auth` stubbed (`hasActiveSession` → `true`), following the `useStore.reorderReload.spec175.test.ts` harness.

All new store-level cases go in **`src/store/useStore.lateResultGuards.spec176.test.ts`**. Every drop case must also show that the dropped call really ran (anti-vacuity), by asserting the relevant `db` fetch was called with the call-start store.

### L2: `loadReorderSuggestions` drops a late result (R-1)

Setup for AC-1 to AC-4: `currentStore = A`, start `loadReorderSuggestions('D')` against a deferred `fetchReorderSuggestions`, assert it was called with `('A', 'D')`, then switch `currentStore` away from A.

- [ ] **AC-1 (late success dropped):** switch to B, where B holds `reorderPayload = PB`, `reorderStoreId = 'B'` and `reorderError = null`. Resolve A's fetch with `FA`.
  - `reorderPayload` is still `PB` (same reference);
  - `reorderStoreId` is still `'B'`;
  - `reorderError` is still `null`.
- [ ] **AC-2 (late failure dropped):** same setup. Reject A's fetch.
  - `reorderError` is still `null`;
  - `reorderPayload` and `reorderStoreId` are unchanged;
  - `Toast.show` is not called.
- [ ] **AC-3 (loading reset when no newer request):** switch to the "All brands" placeholder `{ id: '' }` and issue no other reorder request. Settle A's fetch. Run this twice, once resolving and once rejecting.
  - `reorderLoading` ends `false`;
  - `reorderPayload`, `reorderStoreId` and `reorderError` are unchanged.
- [ ] **AC-4 (loading left alone when a newer request exists):** switch to B and start B's foreground `loadReorderSuggestions('D')` against a second deferred fetch (`reorderLoading` is `true`). Resolve A's fetch.
  - `reorderLoading` is still `true`, and the payload, owner and error are unchanged;
  - then resolve B's fetch with `FB`: `reorderPayload` is `FB`, `reorderStoreId` is `'B'`, and `reorderLoading` is `false`.
- [ ] **AC-5 (not dropped on generation alone):** on store S, with the payload owned by S, start a foreground `loadReorderSuggestions('D')` (deferred). While it is in flight, run `loadFromSupabase('S')`, which issues a spec 175 silent refresh and so bumps `reorderRequestGen`. Resolve the foreground fetch with `F`.
  - `F` lands: `reorderPayload` is `F`, `reorderStoreId` is `'S'`, `reorderLoading` is `false`, and `reorderError` is `null`.
- [ ] **AC-6 (current-store control):** with no store change, a success lands exactly as today (payload, owner, `reorderLoading: false`, `reorderError: null`). A failure sets `reorderLoading: false` and `reorderError` exactly as today.

### L2: `recordExportedOrder` backstop (R-2)

- [ ] **AC-7 (refused when the owner differs from the snapshot store):** `currentStore = B`, `reorderStoreId = 'A'`, `exportedAt.storeId = 'B'`, with a valid `referenceDate` and orderable lines.
  - It returns `null`;
  - `upsertVendorDraftOrder` is not called;
  - `notifyBackendError` fires once with the `'Record exported order'` context. Assert it through `Toast.show`, called exactly once.
  - The refusal's error message is distinct from the existing "Active store changed during the export — not recorded" message, so a test can tell which guard fired. The exact text is the architect's call.
- [ ] **AC-8 (passes when equal):** `currentStore = B`, `reorderStoreId = 'B'`, `exportedAt.storeId = 'B'`. `upsertVendorDraftOrder` is called once, exactly as today.
- [ ] **AC-9 (existing guards keep their order and behavior):**
  - a missing or `'__all__'` snapshot store still returns `null` **silently**, before the backstop runs;
  - a mid-export store switch still produces the existing "Active store changed" refusal;
  - the existing spec 156 suite (updated only per AC-21) passes.

### L3: `loadFromSupabase` drops a stale load (R-3)

- [ ] **AC-10 (stale single-store load writes nothing and runs no tails):**
  - **Setup:** `currentStore = A` and `currentUser` set, so the notifications fetch would fire. Start `loadFromSupabase('A')` with a deferred `fetchAllForStore`, and assert it was called with `'A'`. Switch `currentStore` to B and seed B-shaped values for `inventory`, `vendors`, `orderSchedule`, `brand`, `menuCapacity`, `lastCountedByItem` / `lastCountedStoreId` / `lastCountedLoaded`, and the five reorder fields. Resolve A's fetch.
  - **No slice writes:** every key the single-store `set` writes is unchanged (same reference). Assert at least `inventory`, `vendors`, `orderSchedule`, `brand`, `menuCapacity`, the `lastCounted*` keys, and the five reorder fields.
  - **No tails:** `fetchMenuCapacity`, `fetchItemsLastCounted`, `fetchReorderSuggestions`, `cleanupOldRecords` and `fetchNotifications` are not called.
- [ ] **AC-11 (stale load whose fetch fails):** same setup, but A's `fetchAllForStore` rejects. Only `console.warn` happens: no slice writes and no tails. The overlay rule (AC-14 and AC-15) applies unchanged.
- [ ] **AC-12 (stale `__all__` load writes nothing):**
  - **Setup:** `currentStore = B`, `stores = [S1, S2]`. Run `loadFromSupabase('__all__')`.
  - `fetchAllForStore` is called for `'S1'` and `'S2'` (anti-vacuity);
  - `brand`, `inventory`, `vendors`, `menuCapacity` and the `lastCounted*` keys are unchanged (same reference).
- [ ] **AC-13 (`stores` write and current-store control):**
  - a stale load still writes `stores` from a non-empty `fetchStores` result, as today;
  - a current-store `loadFromSupabase('B')` (with `currentStore = B`) still writes all its slices, runs the `loadMenuCapacity` and `loadItemsLastCounted` tails once each with `'B'`, and fetches notifications when `currentUser` is set;
  - a current-store `__all__` load (with `currentStore = { id: '__all__' }`) still writes its slices as today.

### Spec 111 overlay (R-4)

- [ ] **AC-14 (stale load that is the newest resets):** `storeLoading: true`, `switching: 'store'`. Start `loadFromSupabase('A')`, switch `currentStore` to B **without** starting another load, then settle A's fetch. Run this on both the success and the failure paths.
  - `storeLoading` ends `false` and `switching` ends `null`.
- [ ] **AC-15 (stale load skips the reset while a newer load is in flight):**
  - Start `loadFromSupabase('A')`, then switch to B and start `loadFromSupabase('B')`. Both use deferred `fetchAllForStore`, and `switching` is `'store'`.
  - Resolve A: `storeLoading` is still `true` and `switching` is still `'store'`.
  - Resolve B: B's `finally` resets both (`false` / `null`), and B's slices are written.
- [ ] **AC-16 (session-probe bail unchanged):** the spec 152 bail tests in `src/store/useStore.sessionLoss.spec152.test.ts` pass **unmodified**. That includes "clears storeLoading + switching so the spec-111 overlay cannot strand" and "a bail whose identity moved mid-probe does NOT arm the banner" (which leaves the new load's gates set).

### Spec 175 behavior kept (R-5)

- [ ] **AC-17:** in the single-store branch, the A′ keep-or-clear logic (`before`, `currentId`, `keptReorder`, `silentRefreshFrom`, the conditional reorder spread, and the silent-refresh tail) is unchanged apart from comments. No clear on a stale reload is reintroduced.
  - The spec 175 tests "race — a stale store-A reload landing after B's foreground load keeps B's payload" (`useStore.reorderReload.spec175.test.ts:511`) and "stale reload with the payload owned by the current store" (`:540`) pass **unmodified**.
  - Comments that describe the stale-reload case are updated to say it is now unreachable because stale loads are dropped (spec 176). This covers the A′ block (L2172-2196) and the reorder spread comment.

### Updates to committed tests

These edits are required by the new behavior. They are not scope changes. Each one keeps the original test's intent.

- [ ] **AC-18 (spec 175 foreign-owner test):** rewrite `useStore.reorderReload.spec175.test.ts:562` ("a payload owned by a store that is no longer current is removed, even by its owner's reload").
  - Under spec 176, a stale reload for S while B is current writes nothing: assert the reorder fields are unchanged and `fetchReorderSuggestions` is not called.
  - Clearing a foreign-owned payload now happens on the current store's own reload. AC-12 of spec 175 (the `reorderStoreId = 'A'`, `loadFromSupabase('B')` case) already pins that, so the rewritten test may cite it rather than repeat it.
- [ ] **AC-19 (spec 175 AC-2 test):** the AC-2 test at `useStore.reorderReload.spec175.test.ts:208` ("writes the store captured at call start…") switches `currentStore` A → B mid-fetch and expects A's payload to land tagged `'A'`. R-1 drops that result, so the test turns red.
  - Rewrite it as a same-store case: the owner equals the call-start store, and it is written in the same `set` as the payload.
  - The cross-store case moves to AC-1 of this spec.
  - (Found while writing this spec. It is a direct consequence of R-1.)
- [ ] **AC-20 (tests that load a store that is not current):** every committed test that calls `loadFromSupabase('<id>')` on the real store sets `currentStore.id` to `<id>` first (before each call, for sequential loads), the way production does. Assertions are otherwise unchanged. Known sites:
  - `src/store/useStore.lastCounted.spec160.test.ts`: ≈L135, L202, L249, L265 and L267 (set `store-1`, then `store-2`), and L226 (`'__all__'`, so set `currentStore = { id: '__all__' }`; its clear assertions prove the branch ran);
  - `src/store/useStore.lastOrderContext.spec151.test.ts` ≈L143 (the store-switch test: set `currentStore` to `store-2` before `loadFromSupabase('store-2')`; its "clears the context to NULL" assertion is unchanged);
  - `src/store/useStore.reorderReload.spec175.test.ts` ≈L495 (AC-15 `__all__` case: set `currentStore = { id: '__all__' }` so the branch actually runs);
  - any other site the developer finds by grepping `loadFromSupabase(` in `src/**/*.test.*`. `useStore.sessionLoss.spec152.test.ts` already seeds `currentStore = s1` and needs no change.
- [ ] **AC-21 (spec 156 store suite):** `src/store/useStore.recordExportedOrder.spec156.test.ts`'s top-level `beforeEach` (≈L133-140) seeds a payload with no owner. Without a change, R-2 refuses every happy-path call (`null !== 'store-1'`).
  - Add `reorderStoreId: 'store-1'` to that seed. This is the only edit to the file. Every assertion stays as it is.
  - (Found while writing this spec. It is a direct consequence of R-2.)
- [ ] **AC-22 (suites that stay unmodified):** these pass with no edits:
  - `useStore.switching.test.ts`;
  - `useStore.sessionLoss.spec152.test.ts`;
  - `useStore.lastOrderContextGuard.spec175.test.ts`;
  - `PhoneOrdering.reorderReload.spec175.test.tsx`;
  - `PhoneOrdering.recordExport.spec156.test.tsx` and `ReorderSection.recordExport.spec156.test.tsx` (both replace `recordExportedOrder` with a mock or mock the store);
  - every other `ReorderSection.*`, `PhoneOrdering.*` and `PhoneApproveOrder.*` test.

### Scope fences and gates

- [ ] **AC-23:** no UI file under `src/screens/` or `src/components/` is edited. `src/lib/db.ts`, `supabase/**` and `app.json` are not touched. `StoreActions` gains no new action.
- [ ] **AC-24:** full `npx jest` (not a subset), `npm run typecheck`, and `npm run typecheck:test` all pass.
- [ ] **AC-25:** browser check on the local stack (`npm run dev:db`, admin@local.test):
  - switch between two stores several times in quick succession, at both desktop and 390 px phone widths, with Reorder / Ordering open;
  - after settling, the inventory, vendors, schedule and reorder list all belong to the store shown in the switcher;
  - the switch overlay clears and never sticks;
  - a same-store realtime reload still keeps the list on screen (spec 175 regression check);
  - there are no console errors.

  Restore any rows you touched afterward.

## In scope

- `src/store/useStore.ts`:
  - the R-1 drop and conditional loading reset in `loadReorderSuggestions`;
  - the R-2 backstop in `recordExportedOrder`;
  - the R-3 drop in both branches of `loadFromSupabase`;
  - the R-4 module-level load counter and the gated `finally` reset;
  - comment updates for the A′ block, the reorder spread, `loadReorderSuggestions`, and the `recordExportedOrder` guard block.
- `src/types/index.ts`: doc-only touch-ups if `reorderStoreId` / `reorderPayload` docs mention the stale-reload or foreground-race behavior.
- The new jest suite `src/store/useStore.lateResultGuards.spec176.test.ts`.
- The committed-test edits listed in AC-18 to AC-21.

## Out of scope (explicitly)

- **Server-side rejection of cross-store `po_items.item_id`** (a migration plus a prod apply). It is a separate follow-up spec, owner-approved. Today's client guards are defense in the client only.
- **Out-of-order foreground reorder loads for the same store but different as-of dates.** R-1 only drops on a store change. Same-store ordering is unchanged.
- **`loadMenuCapacity`, `loadItemsLastCounted`, and other fire-and-forget tails that write without a current-store check when they settle.** R-3 stops a stale load from *starting* them. A tail started by a current load that settles after a later switch is not guarded here.
- **Filtering lines in `buildDraftOrderLines` by membership in the current `inventory`** (release proposal step 4(d)). Not requested. The R-2 backstop covers the reachable write path.
- **The pre-existing `reorderLoading: false` in the A′ clear spread** (spec 175 out-of-scope nit, a real store switch during a live foreground load). Not requested.
- **Stale comments inside frozen test files** that spec 175 listed. A separate comment sweep.
- **Any DB, RPC, migration, edge function, realtime publication, or `db.ts` change.**
- **The `app.json` slug.** Not touched.

## Open questions resolved

All owner-approved before this spec was written:
- Q: How should a late `loadReorderSuggestions` result be handled? → A: Drop it on both settle paths when the current store is no longer the call-start store. Reset `reorderLoading` only if no newer reorder request was issued. Never drop on generation alone (R-1).
- Q: Is a client backstop at the write wanted in addition? → A: Yes. `recordExportedOrder` refuses when `reorderStoreId` differs from the snapshot store, and reports it like the existing store-change refusal (R-2).
- Q: How should a stale `loadFromSupabase` be handled? → A: Return before the `set`, with no tails, in the single-store branch **and** the `__all__` branch. The `stores` write stays (R-3).
- Q: How should the spec 111 overlay reset work with dropped loads? → A: Only the newest load's `finally` resets it, using a module-level counter. The spec 152 bail path is unchanged (R-4).
- Q: Should A′ go back to clearing on a stale reload? → A: No. A′ stays, and its stale case becomes unreachable (R-5).
- Q: Server-side `po_items` cross-store rejection? → A: A separate follow-up spec.
- Q: Should design decision D-2 (§2.3) replace R-1's literal `reorderRequestGen` gate on the stale-path `reorderLoading` reset with the newest-*foreground*-request gate (`latestForegroundReorderGen`)? → A: Yes. The owner accepted D-2 on 2026-10-26, after the post-impl reviews and before commit. The §8 fallback is not used, and D-T2 stays (architect SF-1).

Resolved here by the PM. These are gaps found while checking the plan against the committed tests:
- **P1.** The spec 175 AC-2 test (`:208`) and the spec 156 store suite's `beforeEach` both encode behavior R-1 / R-2 change. They are added to the test-update list as AC-19 and AC-21. Reason: without these edits, full jest is red. Both edits keep the original intent.
- **P2.** R-2 compares against `reorderStoreId` literally, so a `null` owner also refuses. Reason: every rendered payload is non-null and so has an owner (spec 175 N1). An export with no owner has no payload to belong to, and refusing is the safe side.

## Notes for architect (non-blocking)

- **N1. Where the load counter bumps.** R-4 requires that the newest load always resets the overlay. So every call that bumps the counter must also reach a reset. Bump after the `if (!sid) return` guard. Decide whether the bump goes before or after the spec 152 session probe, given its identity-moved early return (L2112), which returns without resetting by design. Record the reasoning. The owner's constraint is only "the newest load always resets; the bail path stays unchanged".
- **N2. Strand-freedom of `reorderLoading`.** Under R-1, a dropped call that is not the newest reorder request leaves `reorderLoading` alone. That is safe when the newer request is a foreground load (it lands or resets itself). Confirm it is also safe when the only newer requests are spec 175 silent refreshes, which never write `reorderLoading` and drop themselves while it is `true`. If a strand is reachable, say so before the build.
- **N3. Guard placement in `recordExportedOrder`.** Put the R-2 check after the silent `!storeId || '__all__'` guard (AC-9). The existing current-store refusal runs first when both apply. All checks must stay synchronous and before the first `await`, per the D-2 property in that function.
- **N4.** The `__all__` drop is a no-op in production (no path sets `currentStore.id = '__all__'`). It is included at the owner's request, for uniformity and for direct callers.

## Risks

- **A broken overlay counter strands the spec 111 overlay.** That is a user-visible failure. AC-14, AC-15 and AC-16 are the guard. Review the counter with the bail path in mind (N1).
- **Dropping a valid result.** If the current-store comparison read the wrong store, current loads would silently stop updating. AC-5, AC-6 and AC-13 are the controls, plus AC-17's unmodified spec 175 tests.
- **Test drift.** Tests that call `loadFromSupabase` on a non-current store were passing only because the action had no store check. AC-20 lists the known sites. A missed site shows up as a red full-jest run, which AC-24 requires to be green.
- **Residual exposure until the server-side follow-up lands.** The client now refuses, but any other client path that builds `po_items` for a store is not covered. Tracked as the out-of-scope follow-up.
- **Deploy.** Client-only, with no migration, so the `db-migrations-applied` gate is unaffected. After pushing, confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` manually (per project memory).

## Dependencies

- Spec 175 (`8acecc4`): `reorderStoreId`, `reorderRequestGen`, the silent refresh, A′, and the `loadLastOrderContext` store guard (the model for R-1).
- Spec 156: `recordExportedOrder`, the export-start snapshot, and the existing store-change refusal (the model for R-2).
- Spec 111: the switch overlay (`switching`, `storeLoading`) and its single reset point.
- Spec 152: the session probe and its bail-path reset.
- Specs 060 and 160: the `loadMenuCapacity` / `loadItemsLastCounted` tails that R-3 skips on a stale load.
- Spec 104: the `subUnitSize` cost bridge whose fallback L3 triggers.
- The local stack (`npm run dev:db`) for the AC-25 browser check.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI. The logic changes are in `src/store/useStore.ts` only. No section file is edited, and there is no legacy surface.
- **Per-store or admin-global:** per-store. This adds client-side stale-result guards around store-scoped reads (`fetchAllForStore`, `report_reorder_list`) and the store-scoped draft-PO write. There is no RLS change. The `po_items` cross-store gap is recorded for the server-side follow-up.
- **Realtime channels touched:** none changed. Reloads driven by `store-{id}` / `brand-{id}` through `handleSync` always pass the current store, so they are never dropped. There is no publication change, so the realtime container-restart gotcha does not apply.
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Web/native scope:** both. This is shared Zustand store logic. The AC-25 browser check is web, at desktop and phone widths.
- **Test tracks:** jest only (one new store suite plus the committed-test edits in AC-18 to AC-21), plus `npm run typecheck` and `npm run typecheck:test`. No pgTAP and no shell smoke.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria and any project-specific notes, then produce the design doc and set Status: READY_FOR_BUILD.
payload_paths:
  - specs/176-late-result-store-guards.md

---

## Backend design

Architect pass, 2026-10-26, against `main` at `8acecc4`. Every change is in the client store. Line numbers are pointers.

### 0. Summary of decisions

| Note | Decision |
|---|---|
| N1 | The load counter is bumped **after** the spec 152 probe and the `sessionLost` retire, in the same synchronous step as `set({ storeLoading: true })`, with `try` opened right after. Bumping before the probe can strand the overlay in two ways (§3.3). |
| N2 | **A strand is reachable** if R-1's "newest reorder request" test is read literally against `reorderRequestGen`. Fix (D-2): the reset gate compares against the newest **foreground** request, tracked by one extra module-level marker. It behaves exactly like R-1 in every case R-1 describes, keeps both of R-1's stated goals, and closes the strand. **Flagged for owner awareness** (§2.3). |
| N3 | The R-2 backstop goes after the `!referenceDate` silent guard and before `createdByUserId` / `buildDraftOrderLines`. It is synchronous and runs before any `await` and before `recordingKeys.add`. Message: `'Reorder list belongs to a different store — not recorded'` (§4). |
| N4 | Confirmed defensive-only. No production path reaches the `__all__` branch at all, so the drop cannot change production behavior. Only the tests that call it directly change, per AC-20 (§3.4). |

### 1. Data model, RLS, API, edge functions, `db.ts`, realtime

- **Data model:** none. No migration file.
- **RLS:** none. The `po_items.item_id` cross-store gap ([20260504173035_per_store_rls_hardening.sql:216](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)) stays open until the out-of-scope server-side follow-up. R-2 is a client-only defense.
- **API contract:** unchanged. Same calls to `db.fetchAllForStore`, `db.fetchReorderSuggestions` (`report_reorder_list`) and `db.upsertVendorDraftOrder`, with the same arguments.
- **Edge functions:** none. No `verify_jwt` change.
- **`src/lib/db.ts`:** not touched. No new helper.
- **Realtime:** no channel or publication change. `handleSync` ([CmdNavigator.tsx:64-71](../src/navigation/CmdNavigator.tsx)) reads `currentStore.id` when the 400 ms debounce fires. A `store-{id}` / `brand-{id}` reload is dropped only if the user switches stores while it is in flight, which is the intended behavior. The `docker restart supabase_realtime_imr-inventory` step does not apply.
- **`StoreActions` / `src/types/index.ts`:** no signature change. No new action and no new state key (AC-23). Doc-only edits are listed in §6.

### 2. R-1 — `loadReorderSuggestions` (L4670-4683)

#### 2.1 New module-level marker (next to `reorderRequestGen`, L237)

```
let latestForegroundReorderGen = 0;
```

Doc comment: spec 176 D-2. Holds the `reorderRequestGen` value of the newest **foreground** call. Only `loadReorderSuggestions` writes it. `startSilentReorderRefresh` never reads or writes it. Same module-level posture as `reorderRequestGen`: it is not rendered, not reset by test isolation, and only compared for equality. Also extend the `reorderRequestGen` doc to point at it.

#### 2.2 Shape (pseudocode, not committed code)

```
loadReorderSuggestions(asOfDate):
  storeId = get().currentStore?.id
  if (!storeId) return                          // unchanged: no bump on early return
  gen = ++reorderRequestGen                      // unchanged position (spec 175 AC-10)
  latestForegroundReorderGen = gen               // D-2, same synchronous step
  set({ reorderLoading: true, reorderError: null })   // unchanged
  try:
    payload = await db.fetchReorderSuggestions(storeId, asOfDate)
    if (get().currentStore?.id !== storeId):    // R-1 stale check, success path
      if (gen === latestForegroundReorderGen) set({ reorderLoading: false })
      return
    set({ reorderPayload: payload, reorderStoreId: storeId, reorderLoading: false, reorderError: null })  // unchanged
  catch (e):
    message = e?.message || String(e)
    console.warn('[Supabase] loadReorderSuggestions:', message)    // kept on BOTH stale and non-stale
    if (get().currentStore?.id !== storeId):    // R-1 stale check, failure path
      if (gen === latestForegroundReorderGen) set({ reorderLoading: false })
      return
    set({ reorderLoading: false, reorderError: message })          // unchanged
```

- The stale check is a synchronous `get()` taken right before each write. There is no `await` between the check and the `set`. This mirrors `loadLastOrderContext`'s spec 175 store guard.
- A dropped result writes only `reorderLoading: false`, and only when the gate passes. It never writes `reorderPayload`, `reorderStoreId` or `reorderError`. The `console.warn` on a dropped failure is diagnostic, not a result key, and it never toasts (AC-2).
- **No generation-only drop** (R-1 third bullet, AC-5): the non-stale paths never read `gen`.
- The try body has two exits. A reviewer must check that the success-path `return` comes after the stale check and before the existing `set`.

#### 2.3 N2 — strand analysis and why D-2 is needed

**Writers of `reorderLoading: true`:** only the `set` at the start of each foreground call. **Writers of `false`:** the foreground settle paths, the A′ clear spread (L2251), and the initial/reset state. The silent refresh never writes it, and drops itself while it is `true` (L272).

**Strand under the literal R-1 gate (`gen === reorderRequestGen`).** This is reachable at `8acecc4` plus spec 176, using only shipped surfaces:

1. Store B is current, the payload is owned by B, and the user is on Reorder.
2. The user switches to A. The ReorderSection effect fires foreground `F_A` (gen *g*, `reorderLoading: true`) and `L_A` starts.
3. Before `L_A` lands, the user picks "All brands". `currentStore` becomes `{ id: '' }`, the shell forces Brands, and Reorder unmounts. `L_A` settles as stale, so under R-3 it is dropped and **ownership stays B**. (Before spec 176, `L_A` would have cleared it.)
4. While `F_A` is still in flight (`report_reorder_list` is the heaviest read here), the user picks B from Brands. `setCurrentStore(B)` → `L_B`. Reorder is not mounted, so no `F_B` fires. `L_B` sees the owner as B, which is current, so A′ keeps the payload and issues silent `S_B` (gen *g*+1).
5. `F_A` settles as stale. *g* ≠ *g*+1, so the literal gate skips the reset. **`reorderLoading` stays `true`.** `S_B` settles, sees `reorderLoading`, and drops itself.

**Consequences:** every later silent refresh drops itself (L272), so the list goes quietly stale on every realtime reload. PhoneApproveOrder's loader is gated on `!reorderLoading` ([PhoneApproveOrder.tsx:153](../src/screens/cmd/sections/phone/PhoneApproveOrder.tsx)), so a deep-linked approval for another business date never loads. The desktop REFRESH button is disabled (`ReorderSection.tsx:1711`). It recovers only when ReorderSection mounts (its effect fires a foreground load), or on a store switch whose A′ clear writes `false`. Step 3 is not needed in other variants: any foreground issued by a store action (`cancelPurchaseOrder` L4338, `closeShortPurchaseOrder` L4326, `receivePurchaseOrder` L4312, the fill-cart paths L3829/L3903) while Reorder is unmounted gives the same result.

**D-2 fix:** gate the reset on `gen === latestForegroundReorderGen`.

- *Proof of strand-freedom.* Each `reorderLoading: true` write happens in the same synchronous step as the marker update. So the call holding the marker is always the most recent writer of `true`. That call writes `false` on all four of its settle paths: non-stale success, non-stale failure, and stale with the gate passing (it holds the marker, so the gate passes). Silent refreshes never write `true`, so they cannot leave a `true` behind. Assuming every fetch eventually settles (true today; a hung fetch is out of scope), `reorderLoading` always ends `false` once the newest foreground settles.
- *R-1 goal "never cancel the new store's in-flight spinner".* Only a foreground call can own the spinner. Any foreground issued after F moves the marker, so F's gate fails. Same result as the literal rule (AC-4).
- *R-1 goal "never strand".* Proven above. The literal rule fails it in the sequence above.
- *Agreement with literal R-1.* If F is the newest request overall, it is also the newest foreground, and both rules reset. They differ only when every newer request is a silent refresh. In that case D-2 resets and the literal rule strands. No AC distinguishes the two except the new test D-T2 (§7.2).
- *Spec definitions.* The "Newest reorder request" definition is read as "newest **foreground** reorder request" for the R-1 reset gate only. Nothing else uses that definition. Owner sign-off was on the goals; D-2 changes how the gate is implemented, not the goals. **Main Claude should relay this to the owner before or alongside dispatch.** If the owner rejects D-2, the fallback is the literal rule, with the step 1-5 strand recorded as a known defect.

### 3. R-3 / R-4 — `loadFromSupabase` (L2070-2325)

#### 3.1 New module-level counter (next to `reorderRequestGen`)

```
let loadFromSupabaseGen = 0;
```

Doc comment: spec 176 R-4. It is bumped by every `loadFromSupabase` call that gets past the session probe. Only the call holding the current value resets the spec 111 gates in `finally`. Module-level, not Zustand, not reset by test isolation, equality-only. This is the `recordingKeys` / `reorderRequestGen` posture.

#### 3.2 Placement (N1)

```
loadFromSupabase(storeId?):
  sid = storeId || get().currentStore?.id
  if (!sid) return                                  // unchanged, before any bump
  … spec 152 probe, unchanged …
  if (!sessionOk) { … identity-moved early return … unconditional reset … return }   // unchanged byte-for-byte (R-4, AC-16)
  if (get().sessionLost) set({ sessionLost: false })   // unchanged
  const loadGen = ++loadFromSupabaseGen              // NEW — same synchronous step as the next line
  set({ storeLoading: true })                        // unchanged
  try {
    cloudStores … set({ stores }) …                  // unchanged (R-3: stores write stays)
    if (sid === '__all__') {
      allData = await Promise.all(…)                 // unchanged
      if (sid !== get().currentStore?.id) return     // NEW R-3 drop (finally still runs)
      … existing set …; return
    }
    data = await db.fetchAllForStore(sid)
    if (sid !== get().currentStore?.id) return       // NEW R-3 drop — before `before = get()`
    … A′ block, set, tails — unchanged apart from comments …
  } catch (e) { console.warn(…) }                    // unchanged
  finally {
    if (loadGen === loadFromSupabaseGen) set({ storeLoading: false, switching: null })   // R-4 gate
  }
```

- Both drops use the same expression, `sid !== get().currentStore?.id`. In the `__all__` branch `sid` is `'__all__'`, which is exactly R-3's `'__all__' !== get().currentStore?.id`.
- **Single-store drop placement:** right after `await db.fetchAllForStore(sid)`, before `const before = get()`. There is no `await` between the check and `before` / the `set`, so the A′ code runs only when `sid === currentId`. A dropped load runs none of the tails (`loadMenuCapacity`, `loadItemsLastCounted`, the silent refresh, `cleanupOldRecords`, notifications), because they all sit after the `set` (AC-10).
- **Failed fetch (AC-11):** a rejection goes to the existing `catch`, which only warns, and then to `finally`. No change needed.

#### 3.3 N1 — why the bump goes after the probe

Every exit after the bump goes through `finally`. There is no `await` and no other statement between the bump and `try`.

| Exit | Bumped? | Resets the gates? |
|---|---|---|
| `!sid` | no | n/a (writes nothing, as today) |
| probe bail, identity unchanged | no | yes, unconditionally (unchanged) |
| probe bail, identity moved (L2112) | no | no, by design (unchanged); the new identity's load owns the gates |
| `__all__` stale drop / `__all__` success | yes | via `finally`, if newest |
| single-store stale drop / success | yes | via `finally`, if newest |
| any throw inside `try` | yes | `catch` → `finally`, if newest |

**Invariant.** The bump and `set({ storeLoading: true })` happen in one synchronous step. So the holder of the current counter value is always the most recent writer of `storeLoading: true`, and every holder reaches `finally`. After the last bump, the holder's `finally` runs after every `storeLoading: true` write. `switching` is written non-null only by `setCurrentStore` / `setCurrentBrandId`, and each such write is followed synchronously by a `loadFromSupabase` call. That call either bumps (and becomes the holder, so its `finally` runs after the write) or exits before the bump through one of the first three rows. **The newest load always resets, and the bail is unchanged. R-4 holds as written.**

**Why not before the probe.** Two strands, both ruled out by the placement above:
1. *Out-of-order probes.* `L1` bumps, then `L2` bumps. `L2`'s probe resolves first; it runs, and its `finally` resets. Then `L1`'s probe resolves (a token refresh can take up to `SESSION_PROBE_TIMEOUT_MS` = 4000 ms) and writes `storeLoading: true`. Its `finally` sees it is not newest and skips the reset. **`storeLoading` stays `true`**, and the spec 055 skeletons in Dashboard, Recipes and others gate on it.
2. *Identity-moved bail shadowing a live load.* `L1` (past the probe, `storeLoading: true`) is in flight. `L2` bumps, then takes the identity-moved early return, which never resets by design. `L1`'s `finally` sees it is not newest. The gates strand unless the identity change itself reset them. `login` does not reset them, and a `storeGate: 'choosing'` login issues no load.

**Accepted residual (documented, not a defect).** A load that is still inside its session probe does not yet hold the counter. An older load that settles in that window (normally a cached `getSession`, well under a millisecond; at most 4 s when a refresh runs) still clears the overlay early. That is strictly narrower than today, where any older load's `finally` clears it. Data correctness does not depend on the counter: R-3 keys on `currentStore`. The architect-added test D-T1 (§7.2) pins the out-of-order-probe case so nobody "fixes" this residual by moving the bump earlier.

**Pre-existing, not introduced, out of scope:** `setCurrentStore({ id: '' })` with a non-empty previous store would set `switching: 'store'` and then hit `!sid`, stranding the overlay. No production caller passes an empty id.

#### 3.4 N4 — the `__all__` drop is defensive only

Every production call passes a real store id or reads `currentStore.id`: `land` (L1486), both `setCurrentStore` paths (L1654 fallback.id, L1666 store.id where `store.id !== '__all__'`), `handleSync` (CmdNavigator L69), `applyVendorsToAllStores` (L2462-2463), and the no-arg `receivePurchaseOrder` (L4311). `setCurrentStore` is the only writer that could put `'__all__'` into `currentStore`, and it redirects first. The "All brands" placeholder is `{ id: '' }` and issues no load. So **no production path enters the `__all__` branch**, and the drop cannot change production behavior. The only effect is on direct callers, which are tests: spec 160 L226 and spec 175 L495, both covered by AC-20. The `fetchStores` → `stores` write before the branch is untouched (R-3, AC-13). A dropped `__all__` load still makes N `fetchAllForStore` reads (AC-12 asserts this for anti-vacuity). That costs the same as today, on a branch production never takes.

#### 3.5 Comment updates (R-5, AC-17). Comments only; no code change in the A′ block

- **New comment above each drop:** spec 176 R-3. Say that a result for a store the user has left is dropped before any write or tail; the `stores` write above still lands; `finally` still runs (R-4); and the check is synchronous right before the `set`.
- **A′ block (L2172-2196):**
  - KEEP bullet: remove "AND a stale reload for a store the user has since left — the latter must not blank…(SF-1)". Replace it with a note that this case is now unreachable: spec 176 R-3 returns before this block whenever `sid` is not current. The keep rule stays as written per R-5.
  - CLEAR bullet: replace "A foreign-owned payload is removed even when this reload is for its owner but that store is no longer current" with: since spec 176 this block runs only for the current store, so a foreign-owned payload is removed by the current store's own reload.
  - SILENT REFRESH bullet: replace "A stale reload never issues one" with: `sid === currentId` always holds here since spec 176; the comparison is kept as defense (R-5).
  - The R1-timing paragraph and the `lastOrderContext` window note are still accurate. Leave them.
- **Reorder spread comment (L2235-2243):** add one sentence: a stale reload never reaches this spread (spec 176), so the CLEAR case is always the current store's own reload.
- **`finally` comment (L2318-2322):** keep "single reset point". Add: since spec 176, only the newest load resets. Point to `loadFromSupabaseGen`, and note the bump-after-probe invariant and the probe-window residual in one or two lines.
- **`loadReorderSuggestions` doc (L4658-4669):** add a spec 176 paragraph covering the R-1 drop on both settle paths, the D-2 foreground-marker gate, and "never dropped on generation alone".
- **`startSilentReorderRefresh` doc (L239-256):** no behavior change. Optionally add one clause saying it never touches `latestForegroundReorderGen`.

### 4. R-2 — `recordExportedOrder` backstop (L3915-4012), N3

**Guard order after the change** (every step synchronous, all before the first `await`, D-2 property 1):
1. `!storeId || storeId === '__all__'` → `return null` silently. Unchanged.
2. `get().currentStore?.id !== storeId` → existing "Active store changed during the export — not recorded" refusal. Unchanged. Runs first when both store checks would fire (AC-9).
3. `!referenceDate` → `return null` silently. Unchanged.
4. **NEW, R-2:** `get().reorderStoreId !== storeId` → `notifyBackendError('Record exported order', new Error('Reorder list belongs to a different store — not recorded'))`, then `return null`.
5. `createdByUserId`, `buildDraftOrderLines`, `lines.length === 0`, `recordingKeys`, and so on. Unchanged.

**Why after step 3, not directly after step 2:** an undated snapshot means the payload was `null` at export start. Its owner is then also `null` (spec 175 N1), so a step-4 check placed before step 3 would turn today's *silent* undated case into a toast. Placing it after step 3 keeps every existing silent path silent. It also leaves the spec 156 undated tests (L320, L339, L355) unaffected regardless of their owner seed. It still sits before `recordingKeys.add`, so a refusal never touches the in-flight key set. A `null` owner with a valid date refuses (P2).

**Message:** `'Reorder list belongs to a different store — not recorded'`. It uses the same em dash and "— not recorded" suffix as the store-change refusal, but has a different prefix, so a test can tell which guard fired by matching on the start of the message.

**Comment:** add a "Spec 176 R-2" paragraph to the header block (L3916-3935), or inline above step 4. It should cover: L2 (a late previous-store list under the current store) plus the `po_items` RLS gap (no item-store check) mean the snapshot store alone is not proof the lines belong to it. `reorderStoreId` is read live at record time (the call-site snapshot does not carry the owner, and adding it would be a UI change, out of scope per AC-23). The check is reported, not silent, for the same reasons as Medium 1. Also update the `reorderPayload` bullet's parenthetical, which still mentions the reload paths: a late previous-store foreground result is now dropped (R-1).

### 5. Frontend store impact

- **Slice:** the reorder slice (`reorderPayload` / `reorderStoreId` / `reorderLoading` / `reorderError`) and the spec 111 gates (`storeLoading` / `switching`). No new keys.
- **Optimistic-then-revert:** not applicable. These are read paths and a guard. The only new user-visible signal is the R-2 refusal toast through the existing `notifyBackendError` ([useStore.ts:23](../src/store/useStore.ts)).
- **UI:** no file under `src/screens/` or `src/components/` changes (AC-23). Every consumer already handles the existing values these paths can leave in place.

### 6. `src/types/index.ts` doc touch-ups (doc-only)

- `reorderStoreId` (L752-759): replace "compares it with the target store to tell a store switch (clear) from a same-store reload (keep plus silent refresh)" with: it is compared with the **current** store (spec 175 A′, which since spec 176 only runs for the current store). Add: `loadReorderSuggestions` never writes a result for a store that is no longer current (spec 176 R-1), and `recordExportedOrder` refuses when it differs from the export's snapshot store (spec 176 R-2).
- `reorderPayload` (L742-748): optionally add "a late result for a store the user has left is dropped (spec 176)". No other doc mentions the stale-reload behavior.

### 7. Tests

#### 7.1 Harness for `src/store/useStore.lateResultGuards.spec176.test.ts`

Copy the `useStore.reorderReload.spec175.test.ts` mocks (L23-83), including `hasActiveSession: jest.fn().mockResolvedValue(true)`, `fetchStores` → `[]` by default, the `deferred` / `flush` / `payload` / `store` helpers, and the `beforeEach` (replace-reset `INITIAL_STATE`, `currentUser: null`, `switching: null`, silenced `console.warn`). Add `upsertVendorDraftOrder` and whatever `refreshPurchaseOrders` needs (`fetchPurchaseOrders`; mirror the spec 156 suite's db mock) for AC-7/8/9.

Two harness rules the developer must follow:
- **Order matters under N1.** Wherever a test needs "a newer load is in flight" (AC-15, D-T1), `await flush()` after starting it, and assert `fetchAllForStore` was called with that load's store **before** settling the older one. Under bump-after-probe a load holds the counter only once it is past its probe. This assertion is both the anti-vacuity check and the ordering proof.
- **Settle every deferred before the test ends.** The module-level counters survive `setState(INITIAL_STATE, true)`. A load left dangling into the next test could then reset or skip a reset there.

AC-mapping notes:
- AC-1/2/4: assert `fetchReorderSuggestions` was called with `('A','D')` (anti-vacuity), and assert the reorder fields with `toBe` identity.
- AC-7: assert `Toast.show` was called once, and that its message text starts with `'Reorder list belongs to a different store'` (tells it apart from AC-9's store-change text). Use the field `notifyBackendError` maps the message into.
- AC-10: seed `currentUser` so the notifications tail would fire. Assert `fetchAllForStore('A')` ran, then assert all five tail mocks have `not.toHaveBeenCalled()`.
- AC-13 bullet 1: give `fetchStores` a non-empty `mockResolvedValueOnce` on the stale load, and assert `stores` was written.

#### 7.2 Architect-added cases (same new suite)

- **D-T1 (N1 guard: out-of-order probes never strand).** Make `hasActiveSession` return deferred probe promises. Start `L1('A')`, then switch `currentStore` to B and start `L2('B')`. Resolve L2's probe and L2's fetch, and await L2. Then resolve L1's probe and L1's fetch (L1 is stale and gets dropped), and await L1. Expect `storeLoading === false` and `switching === null`, and B's slices from L2 intact. This test fails if the bump is moved before the probe.
- **D-T2 (N2 guard: silent-only newer requests never strand `reorderLoading`).** Seed `currentStore = A` and a payload `PB` owned by `'B'` (asOfDate `'D'`). Start foreground `loadReorderSuggestions('D')` against a deferred fetch; `reorderLoading` is now `true`. Switch `currentStore` to B. Run `loadFromSupabase('B')`; A′ keeps `PB` and issues silent `('B','D')` against a second deferred fetch. Assert that silent fetch was called (anti-vacuity: it really bumped `reorderRequestGen`). Resolve A's foreground fetch: expect `reorderLoading === false`, and `reorderPayload` still `PB`, owner `'B'`, error `null`. Then resolve the silent fetch with `FS` and expect it to land (`reorderPayload === FS`, owner `'B'`), proving silent refreshes are no longer suppressed. This test fails under the literal R-1 gate.

#### 7.3 Committed-test edits (exact)

- **AC-19, `useStore.reorderReload.spec175.test.ts:208`:** keep the title. Delete the line `useStore.setState({ currentStore: store('B') });` (L215). Keep `currentStore = A`, the deferred fetch, `record()`, and every assertion (`fetchReorder` called with `('A','D')`, payload `F`, owner `'A'`, and the same-`set` pairing loop). Add one comment: the cross-store variant is now a drop (spec 176 R-1), covered by spec 176 AC-1.
- **AC-18, same file `:562`:** retitle it, for example "a reload for a store that is no longer current writes nothing, even when it owns the payload (spec 176)". Keep the setup (`seedSameStore({ currentStore: store('B') })`, `loadFromSupabase('S')`, `flush`). Capture `const before = reorderFields()` before the call. Assertions: `fetchAll` called with `'S'`; `fetchReorder` not called; `reorderFields()` equals `before`, with `reorderPayload` checked by `toBe(P)` identity. Add a comment: clearing a foreign-owned payload now happens on the current store's own reload, already pinned by the AC-12/AC-13 case at `:446`.
- **AC-20:**
  - `useStore.lastCounted.spec160.test.ts`:
    - add `useStore.setState({ currentStore: { id: 'store-1', name: 'S1' } as any })` before the calls at L135 and L202;
    - add the same key to the existing `setState` at L241-245, for the L249 call;
    - at L265 add `store-1` before the first call and `store-2` before the second (L267);
    - at L219-224 add `currentStore: { id: '__all__', name: 'All' } as any` to the existing `setState`.
  - `useStore.lastOrderContext.spec151.test.ts` L140-147: add `useStore.setState({ currentStore: { id: 'store-2', name: 'Baltimore' } as any })` before `loadFromSupabase('store-2')`.
  - `useStore.reorderReload.spec175.test.ts` L496: `seedSameStore({ reorderError: 'kept', currentStore: store('__all__') })`. The test's assertions are unchanged; with `stores` empty the branch writes no reorder key.
  - Grep sweep: in `src/**/*.test.*`, re-check every direct `loadFromSupabase(` call. The current list, all already current-store-seeded: spec 175 `'S'` cases, which use `seedSameStore` or an explicit `store('S')`; L456 `'B'` with `currentStore = B`; L518 / L552, which are intentionally stale and stay unmodified per AC-17; spec 152 `'s1'`; and `PhoneOrdering.reorderReload.spec175.test.tsx` L203/L239 with `store-1` seeded at L166. Also check any tests that pin `storeLoading` / `switching` across overlapping loads; `useStore.switching.test.ts` goes through `setCurrentStore`, which seeds first.
- **AC-21, `useStore.recordExportedOrder.spec156.test.ts` `beforeEach` (L133-140):** add `reorderStoreId: 'store-1',` to that `setState`. That is the only edit.
- **AC-16/AC-22 suites:** no edits. If one of them goes red, that is a design deviation to report, not something to patch in the test.

### 8. Risks and tradeoffs

- **D-2 changes how the R-1 reset gate is implemented.** §2.3 shows the change is needed and touches nothing outside the strand. Surface it to the owner. If D-2 is rejected, drop D-T2 and record the strand.
- **Overlay residual (§3.3).** Early clear is still possible inside a newer load's session-probe window. Accepted, because the alternative placement strands. D-T1 pins the choice.
- **Two exits per settle path** in `loadReorderSuggestions`, and two new early returns inside `loadFromSupabase`'s `try`. Both kinds are easy to misplace. Reviewers should check: (a) every new `return` in `loadFromSupabase` is inside the `try`, so `finally` runs; (b) no `await` sits between any stale check and its `set`; (c) the A′ code text is byte-identical apart from comments (AC-17).
- **Silent data freeze if the comparison reads the wrong store.** For example, comparing against `storeId` from a closure that has already been reassigned, or checking `before.currentStore` after an `await`. Controls: AC-5, AC-6, AC-13, and the unmodified spec 175 suites.
- **Test drift.** AC-20 sites, plus the counter-persistence rule in §7.1. Full `npx jest` is required (AC-24, plus project memory "run full jest before commit"), along with `npm run typecheck:test`, which jest does not cover.
- **Performance.** No new queries. Dropped loads still pay for their fetches (no cancellation), the same cost as today. Nothing changes for the 286 KB seed or the edge cold-start.
- **Out-of-order same-store loads** (two current-store reloads that resolve in reverse order) are not addressed, matching R-1's same-store out-of-scope line. Today's last-writer-wins behavior is unchanged.
- **Migration ordering / deploy.** None. Client-only. After the push, check that `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.

### 9. Files the developer will touch

- `src/store/useStore.ts`: two module-level declarations, plus `loadReorderSuggestions`, `loadFromSupabase`, `recordExportedOrder`, and comments.
- `src/types/index.ts`: doc comments only.
- `src/store/useStore.lateResultGuards.spec176.test.ts`: new.
- `src/store/useStore.reorderReload.spec175.test.ts`: the AC-18, AC-19 and AC-20 (L496) edits.
- `src/store/useStore.lastCounted.spec160.test.ts`: AC-20.
- `src/store/useStore.lastOrderContext.spec151.test.ts`: AC-20.
- `src/store/useStore.recordExportedOrder.spec156.test.ts`: AC-21, one line.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec (store-only: `src/store/useStore.ts`, doc touch-ups in `src/types/index.ts`, the new `useStore.lateResultGuards.spec176.test.ts` suite including architect cases D-T1/D-T2, and the committed-test edits in §7.3). No migration, RPC, edge function, `db.ts`, or UI file changes. Note design decision D-2 (§2.3) refines R-1's loading-reset gate to the newest foreground request; main Claude should confirm the owner accepts it before or alongside dispatch. Run full `npx jest`, `npm run typecheck`, `npm run typecheck:test`, and the AC-25 browser check. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/176-late-result-store-guards.md

## Files changed

Implementation pass, 2026-10-26, against `main` at `8acecc4`. Store-only; no migration, RPC, edge function, `db.ts`, `supabase/**`, `app.json`, or UI file touched (AC-23). D-2 implemented as designed.

**Store (`src/store/`)**
- `src/store/useStore.ts`: module-level `latestForegroundReorderGen` (D-2) and `loadFromSupabaseGen` (R-4) next to `reorderRequestGen`; R-1 stale drop on both settle paths of `loadReorderSuggestions` with the foreground-marker `reorderLoading` reset; R-2 backstop in `recordExportedOrder` after the `!referenceDate` guard (message `'Reorder list belongs to a different store — not recorded'`); R-3 drops in both `loadFromSupabase` branches; R-4 bump after the session probe and gated `finally` reset; comment updates (A′ block, reorder spread, `finally`, `loadReorderSuggestions`, `startSilentReorderRefresh`, `recordExportedOrder` header). A′ code unchanged apart from comments (AC-17).

**Types (doc-only)**
- `src/types/index.ts`: `reorderPayload` and `reorderStoreId` doc comments.

**Tests**
- `src/store/useStore.lateResultGuards.spec176.test.ts` (new): AC-1 to AC-15 plus D-T1 and D-T2 (25 tests). D-T1 fails when the bump moves before the probe, and D-T2 fails under the literal `reorderRequestGen` gate. Both were checked by temporarily applying each change, then reverting it.
- `src/store/useStore.reorderReload.spec175.test.ts`: AC-19 (`:208` made same-store), AC-18 (`:562` rewritten as a stale no-write), AC-20 (`__all__` AC-15 case seeds `currentStore = '__all__'`).
- `src/store/useStore.lastCounted.spec160.test.ts`: AC-20 (`currentStore` seeded before each `loadFromSupabase`, `'__all__'` for the `__all__` case).
- `src/store/useStore.lastOrderContext.spec151.test.ts`: AC-20 (seed `store-2` before the store-switch load).
- `src/store/useStore.recordExportedOrder.spec156.test.ts`: AC-21 (`reorderStoreId: 'store-1'` in the top-level `beforeEach`, the only edit).

**Gates (AC-24):** full `npx jest`: 266/266 suites, 3334/3334 tests passed. `npm run typecheck`: exit 0. `npm run typecheck:test`: exit 0. The AC-16/AC-22 suites were not edited. AC-25 browser check is still open; main Claude runs it.

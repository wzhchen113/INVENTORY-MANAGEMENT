## Security audit for spec 176

Scope: the uncommitted working-tree diff against HEAD `8acecc4`. That is `src/store/useStore.ts`, doc comments in `src/types/index.ts`, four committed-test edits, and the new `src/store/useStore.lateResultGuards.spec176.test.ts`. There is no migration, RPC, edge function, `db.ts`, `config.toml` or `package.json` change. I re-ran the spec 176, spec 175 reload and spec 156 store suites locally: 77/77 passed.

**Verdict: 0 Critical, 0 High, 0 Medium, 3 Low.**

- Spec 175's **L2** is closed for the reachable path it described: a late foreground result for store A landing under store B.
- Spec 175's **L3** is closed.
- What remains is a narrower window that predates spec 176. The previous store's list is still on screen right after a switch, before the new store's load clears it, and some write paths in that window are not guarded (L1, L2 below). Neither finding blocks.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- **L1: The R-2 backstop reads the list's owner live, so an export that spans the owner change can still pass.**
  - **Where:** `src/store/useStore.ts:4028`. The call-site snapshots that carry no owner are `ReorderSection.tsx:386-389` and `:510-513`, and `PhoneOrdering.tsx:619-622`.
  - **What happens:**
    - The call site snapshots `storeId` from the current store, plus a `vendor` object taken from the rendered payload. `reorderStoreId` is read only when the record call runs.
    - Suppose an export starts while the payload is still owned by store A but store B is current (the window before A′ clears it, described under L2).
    - If B's own foreground result lands during the export's await, the owner becomes B before the record runs. On phone, that await is the user-paced share sheet (`PhoneOrdering.tsx:640`).
    - `recordExportedOrder` then sees `reorderStoreId === storeId === B` and records **A's** `vendor.items` under `store_id = B`. That is the original L2 write shape.
  - **Reachability:** narrow. All of these must happen:
    1. The previous store's payload is visible under the new store. See L2 for when that window has no overlay.
    2. The export starts inside that window.
    3. The new store's list lands before the export settles.
  - **Fix (future spec, UI change):** add `ownerStoreId: reorderStoreId` to `ExportRecordingContext` at the three snapshot sites. Refuse when the snapshot owner differs from the snapshot store, or from the live owner. The server-side follow-up below also closes this.

- **L2: The other draft/approval writers have no list-owner check.**
  - **Where:**
    - `fillCartForVendor` (`src/store/useStore.ts:3915`): pairs `currentStore.id` with `vendor.items`.
    - `createPoDraft` (`:3824`): same pairing.
    - `approveAndOrder` (`:4135`): pairs `approvalContext.storeId` with `buildOrderApprovalLines(vendor, …)` at `:4309-4326`. Its `vendor` comes from the shared `reorderPayload` (`PhoneApproveOrder.tsx:164-171`).
  - **The window:**
    - Since R-1, a foreign-owned payload exists only between `setCurrentStore(B)` writing `currentStore` and the new store's load reaching its A′ clear (`:2219` onward), or B's foreground result landing first.
    - On a normal title-bar or phone switch, the spec 111 overlay (`StoreSwitchOverlay`, absolute fill, zIndex 100) covers that window.
  - **Two cases have no overlay:**
    - **(a) The accepted R-4 residual** (`:2375-2379`). An older load can settle while the newer load is still inside its session probe. It then clears `switching` early, and the newer load never sets `switching` again.
    - **(b) Switching from the "All brands" placeholder.** `setCurrentStore` skips the overlay when `prev.id === ''` (`:1685`). "All brands" (`:1744-1747`) does not clear `reorderPayload` or `reorderStoreId`.
  - **What happens:** ReorderSection keeps rendering vendor cards while a payload exists, even during loading (`ReorderSection.tsx:1650`, `:1881`). So a Fill-cart confirm in that window writes `po_items` under B with A's item ids.
  - **Server side:**
    - The `po_items` insert policy does not reject foreign item ids (spec 175 L2).
    - `create_order_approval` (`supabase/migrations/20260801000100_order_approvals.sql:299-345`) checks `auth_can_see_store(p_store_id)` and `auth_is_privileged()`. For `item_id` it only checks that the value is a UUID. It does not check that the item belongs to the store.
  - **Why Low:** the window is short and needs (a) or (b). The spec's Risks section names this class ("any other client path that builds `po_items` for a store is not covered").
  - **Fix (cheap, store-only, no UI):**
    - Copy the R-2 check into `fillCartForVendor` and `createPoDraft`: `if (get().reorderStoreId !== storeId) { notifyBackendError(<ctx>, new Error('Reorder list belongs to a different store — not recorded')); return null; }`.
    - In `approveAndOrder`, refuse when `get().reorderStoreId !== ctx.storeId`.
    - Optionally, clear `reorderPayload` / `reorderStoreId` in the "All brands" placeholder `set` (`:1744`). That removes case (b) at its source.

- **L3: A stale load still writes `stores`. This predates spec 176 and is now narrower.**
  - **Where:** `src/store/useStore.ts:2163-2166`, which runs before both R-3 drops. Spec 176 keeps this on purpose (R-3, AC-13).
  - **Why it is a security note:** the probe's `owner` identity (`:2124`) is not checked again after `fetchStores` resolves.
  - **Example:** on a shared device, user X's load gets past the probe, X logs out and Y logs in, and then X's `fetchStores`, sent with X's token, resolves. X's visible-stores list is written into Y's session. It lasts until Y's next load writes `stores`.
  - **What spec 176 changes:** before, X's whole `fetchAllForStore` payload would also have been written. R-3 now drops it unless Y's current store has the same id. So this spec reduces the exposure.
  - **Optional fix:** guard the `stores` write with `(get().currentUser?.id ?? null) === owner`, the same as the spec 152 bail.

### Verified (no finding)

- **L2 root cause (R-1) is closed.**
  - `loadReorderSuggestions` (`:4756-4777`) reads `get().currentStore?.id` synchronously right before each write, on both settle paths.
  - A dropped result writes none of `reorderPayload`, `reorderStoreId` or `reorderError`. The only thing it may write is `reorderLoading: false`, behind the D-2 marker.
  - There is no `await` between the check and the `set`.
  - The silent refresh (`:284-307`) is unchanged and still drops on a store change.
  - So a payload in state is always owned by a store that was current when it was written.
- **R-2 placement is correct.**
  - Order: silent `!storeId || '__all__'`, then the existing store-change refusal (`:4004-4010`), then silent `!referenceDate`, then R-2 (`:4028-4034`).
  - All of these run synchronously, before `buildDraftOrderLines`, before `recordingKeys.add`, and before the first `await`. A refusal therefore never touches the in-flight key set.
  - A `null` owner refuses, which is the safe side (P2).
- **L3 is closed (R-3).**
  - Both drops (`:2181`, `:2219`) are inside `try` and come before every slice write and every tail: `loadMenuCapacity`, `loadItemsLastCounted`, the silent refresh, `cleanupOldRecords`, and `fetchNotifications`.
  - There is no `await` between the drop and `before = get()` / the `set`, so the A′ block runs only when `sid` is current.
  - A stale `loadFromSupabase(A)` can no longer place A's `inventory` / `vendors` / `orderSchedule` next to B's list. The `subUnitSize` and order-code mis-costing in spec 175 L3 cannot happen any more.
- **R-4 overlay gate.**
  - The bump at `:2159` is synchronous with `storeLoading: true`, and `try` opens right after it. Every bumped exit reaches the gated `finally` (`:2380`).
  - The spec 152 bail, including its identity-moved early return, is unchanged.
  - This is availability, not authz. The accepted probe-window residual matters for security only as case (a) of L2.
- **The refusal paths leak nothing.**
  - The R-2 refusal goes through `notifyBackendError` with a static string. It contains no store id, item id, payload content or SQL text.
  - R-1 and R-3 drops are silent. A dropped R-1 failure keeps the existing `console.warn` of the caller's own error message and raises no toast (AC-2).
  - No token, key or PII is logged.
- **Committed-test edits** (AC-18 to AC-21) only seed `currentStore` / `reorderStoreId` the way production does. No security-relevant assertion was weakened. The spec 175 test that pinned "foreign owner cleared" is replaced by a stale-no-write assertion, and the current-store clear stays pinned at spec 175 AC-12.
- **`useRole()`** is not used as a boundary anywhere in the diff. No RLS, realtime publication or `verify_jwt` surface is touched.

### Out of scope (noted, not blocking)

- **Server-side cross-store `item_id` rejection.** This is an owner-approved separate follow-up spec. That spec should cover **both** writers:
  - the `po_items` insert policy (`supabase/migrations/20260504173035_per_store_rls_hardening.sql:216`);
  - `create_order_approval`'s `p_lines` validation (`supabase/migrations/20260801000100_order_approvals.sql:325-345`), which today accepts any well-formed UUID.

  Until it lands, L1 and L2 depend on client-side checks only.

### Dependencies

No `package.json` changes, so `npm audit` was skipped.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 3 Low.
payload_paths:
  - specs/176-late-result-store-guards/reviews/security-auditor.md

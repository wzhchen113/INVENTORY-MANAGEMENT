## Security audit for spec 175

Auditor: security-auditor, 2026-10-23. Scope: the uncommitted working-tree diff on `main` at `8872de2`:
- `src/store/useStore.ts`
- `src/types/index.ts`
- `src/screens/cmd/sections/ReorderSection.tsx` and `src/screens/cmd/sections/phone/PhoneOrdering.tsx` (comment-only)
- two new jest suites

The change is client-only. It touches no migration, RLS policy, RPC, edge function, realtime publication, or `db.ts` surface. The server-side boundary stays as it was: `report_reorder_list` and `report_last_order_context` are store-scoped via `auth_can_see_store()`. So the review question is about client-side integrity, not authorization. Can one store's reorder data or last-order context be rendered, or recorded, under another store?

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None introduced by this spec.

### Low

- **L1 — The keep path keeps `lastOrderContext`, but nothing records which store it belongs to.**
  - **Where:** `src/store/useStore.ts:2228-2234` (the conditional spread) and `src/store/useStore.ts:4673-4689` (`loadLastOrderContext`).
  - **The gap:**
    - On a same-store reload, the keep branch now leaves `lastOrderContext` alone. The keep predicate (`:2171-2174`) checks only that the **payload's** owner is `sid`. The context has no owner tag.
    - `loadLastOrderContext` captures `storeId` at call start, but it never checks it again when the RPC settles.
  - **Race (it predates this spec):**
    1. A context request issued while on store A is still in flight across a switch to B.
    2. It settles after B's own context request (the effect at `ReorderSection.tsx:1564-1568` re-fires on `currentStore.id`).
    3. A's per-vendor "last time" quantities then render against B's lines for any vendor the two stores share. Spec 151 called this "load-bearing, not cosmetic".
  - **What spec 175 changes:**
    - Before, the next realtime reload's unconditional clear, followed by the effect re-firing, healed this within about one reload.
    - Now the next same-store reload keeps the bad context. It survives until the vendor-id key, `asOfDate`, or the store changes.
  - **Impact:** display-only integrity. The data reaches the same user, who RLS already lets read both stores, so no confidentiality boundary is crossed. `lastOrderContext` is not read by any write path (it is used only at `ReorderSection.tsx:616-618` and `PhoneOrdering.tsx:183-185`). The window to trigger it is one RPC round-trip at the moment of a store switch.
  - **Fix (one line, mirrors AC-8):** in `loadLastOrderContext`, drop the result when `get().currentStore?.id !== storeId` before both the success `set` and the failure `set`. Alternatively, add a `lastOrderContextStoreId` tag and add `pre.lastOrderContextStoreId === sid` to the keep predicate, clearing only the context when it doesn't match. The first option is smaller and also closes the race as it existed before this spec.

- **L2 — Pre-existing foreground cross-store race, which can reach a write. This spec does not introduce it or make it wider. Recording it so the follow-up gets the right priority.**
  - **Where:** `src/store/useStore.ts:4648-4660` (`loadReorderSuggestions` has no store check on completion), the export snapshots at `ReorderSection.tsx:385-388` / `:509-512` and `PhoneOrdering.tsx:619-622`, and `recordExportedOrder` at `useStore.ts:3925-3946`.
  - **The race (spec Out of scope, "Foreground cross-store race"):**
    1. A foreground load for store A settles after a switch to B.
    2. The UI shows A's vendor cards under B.
    3. If the user exports from that card, the snapshot pairs `storeId = currentStore.id` (B) with the vendor object's A item ids and quantities.
    4. `recordExportedOrder`'s store guard passes, because B is still current. `buildDraftOrderLines` (`useStore.ts:170-187`) does not filter lines by membership in the current `inventory`.
    5. The result is a draft PO under `store_id = B` that carries A's lines. B-only members can see it. This is the same shape as the 2026-08-08 spec 156 Medium. I did not check whether the server-side upsert rejects item ids from another store.
  - **What spec 175 changes:**
    - It does **not** make this wider. `reorderStoreId` records A (R2, `:4656`), so the next same-store reload of B treats it as a switch and clears it (`:2171-2174`).
    - The new silent path cannot make it worse. A silent result is written only when `currentStore.id === storeId` (`:266`), and it tags itself with that same store (`:272`), so at worst it overwrites a foreign payload with the current store's own data.
  - **Recommended follow-up fix:** now that `reorderStoreId` exists, the fix is cheap:
    - in `loadReorderSuggestions`, drop the result if `get().currentStore?.id !== storeId` at completion (reset `reorderLoading` only); or
    - make the export snapshot refuse when `reorderStoreId !== currentStore.id`.

  Standalone, I would rate this Medium. It is listed under Low here only because it predates spec 175 and the owner scoped it out. It does not block spec 175.

### Verified (no finding)

- **Store-switch clear still fires on every real switch.**
  - The keep predicate (`useStore.ts:2170-2174`) requires all three: a non-null payload, `reorderStoreId === sid`, and `currentStore.id === sid`. Any mismatch takes the clear branch (`:2228-2234`), which nulls the payload, owner, loading, error, and `lastOrderContext` together.
  - The `pre` read and the `set` are synchronous with no `await` between them (R1), so nothing can change state between the check and the write.
  - The architect's extra `currentStore?.id === sid` term only ever adds clears. A stale reload for A that lands after a switch to B clears the slice and cannot keep it.
- **R1 switch timing.** When B's foreground load lands before `loadFromSupabase(B)`'s `set`, the keep path keeps a payload that B's own fetch produced and that is tagged B (captured at call start, `:4649`). No A data is kept. For the context side of this window, see L1.
- **Silent refresh cannot write another store's data under the current store.**
  - The four drop rules (`:265-269`) run in order: generation, store, loading, then date/payload.
  - The success write sets the payload and `reorderStoreId: storeId` in a single `set` (`:272`), so subscribers never see the new payload paired with the old owner.
  - It never writes `reorderLoading` or `lastOrderContext`.
  - `.then().catch()` contains every failure. The warning logs `e?.message` only, so no token or PII reaches the console.
- **Signed-out reset and logout on shared machines.**
  - `SIGNED_OUT_DATA_RESET` now includes `reorderStoreId: null` (`:1254`). Both `logout()` and `handleSessionLost()` spread it.
  - A silent refresh from user 1 that is still in flight cannot land after sign-out. The reset nulls `reorderPayload`, so the AC-11 rule drops it. Any later payload write by user 2 goes through `loadReorderSuggestions` or a new silent refresh, and both advance `reorderRequestGen`, so the generation rule drops user 1's result too.
  - The response was RLS-scoped to user 1's token and is discarded, not rendered.
  - The counter and `reorderStoreId` are memory-only. There is no persist middleware, so nothing reaches localStorage or AsyncStorage.
- **Spec 156 export-start snapshot.** It is unchanged: the UI hunks are comment-only (checked by filtering non-comment lines out of `git diff -- src/screens`; nothing remained). The `recordExportedOrder` store guard (`:3925-3931`) is also untouched.
  - The only new way the payload can move during an export is a silent refresh. That refresh is for the same store and the same `asOfDate` by construction, so the snapshot's `(storeId, referenceDate)` pair stays correct.
- **`__all__` branch.** It is untouched, and no reorder field is written there.
- **New test files.** No secrets, JWTs, service keys, or real-shaped PII (checked by grep).
- **`useRole()`.** The diff does not use it as a security boundary.

### Dependencies
No `package.json` or `package-lock.json` changes, so `npm audit` was skipped.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 2 Low.
payload_paths:
  - specs/175-reorder-survives-reload/reviews/security-auditor.md

## Fix round 1 re-audit

Auditor: security-auditor, 2026-10-25. Scope: the staged diff (`git diff --cached`), fix round 1 as described in the spec's `## Fix round 1`:
- Fix 1 (A′) in the single-store `loadFromSupabase` (`src/store/useStore.ts:2172-2255`, tail `:2289-2294`).
- Fix 2 in `loadLastOrderContext` (`src/store/useStore.ts:4694-4719`).
- The new suite `src/store/useStore.lastOrderContextGuard.spec175.test.ts` and the three fix-round-1 cases in `useStore.reorderReload.spec175.test.ts`.

The change is still client-only:
- `supabase/`, `src/lib/db.ts`, `package.json` and `app.json` are not in the staged set.
- The UI hunks in `ReorderSection.tsx` and `phone/PhoneOrdering.tsx` are still comment-only. A `git diff --cached -U0` filtered to non-comment `+`/`-` lines is empty.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low

- **L1 — CLOSED.**
  - **The fix:** `loadLastOrderContext` captures `storeId` at call start (`:4695`). It now returns without writing when `get().currentStore?.id !== storeId` at settle time, on both paths: success (`:4710`) and failure (`:4714`).
  - **Why the window is now bounded:**
    - A context read for store A that lands after a switch to B can no longer overwrite B's context or null it.
    - The section effect (`ReorderSection.tsx:1565-1569`) is keyed on `currentStore?.id`, and it reads `currentStore` at call time. So every request issued after the switch is a request for B, even if it uses the previous payload's vendor ids for one render.
    - On the R1 keep path, A's context therefore stays visible for at most the time it takes B's own context request to return. The guard stops a late A read from extending that window. This matches the accepted window in the comment at `useStore.ts:2186-2195`.
  - **Residual (no finding):** an A → B → A round trip lets A's old read land, but it is A's data under A, so no store boundary is crossed. Out-of-order reads for the same store predate this spec and are display-only.
  - **Tests:** the three new cases pin both guards. A late-success overwrite and a late-failure null are each tested, and a same-store control shows the guard is not over-broad. Per the spec's mutation table, removing either guard turns exactly its own test red.

- **L2 — UNCHANGED. Still the owner-declared, out-of-scope follow-up. Does not block spec 175.**
  - **What it is:** the foreground cross-store race. `loadReorderSuggestions` (`:4670-4680`) still has no store check when it completes. So the export snapshot can pair `storeId = B` with A's lines, and `recordExportedOrder` can write a draft PO for B that carries them.
  - **A′ does not make it wider.** A foreign-owned payload (owner A, current B) fails the keep test `before.reorderStoreId === currentId` (`:2198-2201`) and is cleared:
    - by the next reload of B;
    - by any stale reload, including a reload for A itself while B is current. This is the spec's "foreign owner removed" case.
  - The silent refresh is still gated on `sid === currentId` (`:2203`), and its own store-drop rule still applies (`:270`), so it cannot write A's data under B.
  - **Severity:** Medium on its own terms. The follow-up fix is unchanged: drop the foreground result when `currentStore.id !== storeId` at completion, or refuse the export snapshot when `reorderStoreId !== currentStore.id`. The follow-up should also check whether the server-side draft-PO upsert rejects item ids from another store.

- **L3 (new, introduced by A′'s stale-keep branch). The root cause predates this spec, and no cross-store data crosses.**
  - **Where:** `src/store/useStore.ts:2198-2203` together with the unconditional `set` at `:2204-2255`.
  - **The scenario:** a stale `loadFromSupabase(A)` can land after the user has switched to B, after B's reload `set` has already run. A′ correctly keeps B's own reorder payload (owner B is the current store). But the same `set` still overwrites `inventory`, `vendors`, `orderSchedule` and `brand` with store A's rows. That overwrite is the coordinator's pre-existing observation in the release proposal.
  - **What changes:**
    - Before fix round 1, and before spec 175, this ordering cleared the payload. The list went blank and nothing could be exported.
    - Now B's list stays live next to A's `inventory`.
  - **Effect on lookups:** reorder `itemId` is `inventory_items.id`, which is per-store (`supabase/migrations/20260726000000_reorder_drop_inbound_term.sql:205`). So these lookups by itemId all miss and fall back to defaults:
    - `buildDraftOrderLines` (`useStore.ts:176-186`, fed `get().inventory` at `:3966-3970`);
    - `subUnitSizeFor` (`ReorderSection.tsx:1461-1468`);
    - the order-code lookup (`ReorderSection.tsx:1172`).
  - **Impact:**
    - An export in that window records a draft PO under store B with B's own item ids and quantities. Its `cost_per_unit_counted` is under-stated, because `subUnitSize` falls back to 1, which skips the spec-104 bridge. Vendor order codes are also blank.
    - Integrity only, and only for B's own data. No row from A is written under B, and nothing is exposed across a store or user boundary.
    - It lasts until B's next reload. It needs a narrow race: A's `fetchAllForStore` has to resolve after B's whole reload, which includes the session probe, `fetchStores` and `fetchAllForStore`.
  - **Fix (follow-up, same as the coordinator's out-of-scope item):** in the single-store branch, drop a `loadFromSupabase` result when `sid !== get().currentStore?.id` at settle. That means: no `set`, no tails, and only the `finally` progress resets. That guard closes both L3 and the coordinator's non-reorder overwrite. It also removes the "stale reload" case from A′ entirely. Do not narrow A′ back to "clear on stale reload": that would bring back SF-1 (a permanent blank list).

### Verified (no finding)

- **The A′ rule keys on the current store, and `currentStore` is always written before the load starts.** Both `setCurrentStore` paths write `currentStore` before calling `loadFromSupabase` (`useStore.ts:1650-1654`, `:1664-1666`), and so does the login landing (`:1484-1486`). So on every real switch, `before.currentStore` is the store being switched TO. A payload owned by the store being left fails `reorderStoreId === currentId` and is cleared. There is no ordering in which the previous store's payload is kept under the new store.
- **The keep check and the write are still atomic.** `before = get()` (`:2197`) and the `set` (`:2204`) have no `await` between them. `keptReorder` is non-null only when the payload is truthy AND its owner tag equals the current store id.
  - The null and placeholder cases clear. With no current store, `currentId` is `undefined` and the owner is `null`. The owner can never be `''`, because `loadReorderSuggestions` bails on a falsy `storeId` at `:4671`.
- **Stale reloads.** A stale reload for A while B is current does one of three things:
  - keeps B's own payload (correct owner, no silent refresh, pinned by the "stale-kept" test);
  - clears a foreign-owned payload (pinned by the "foreign owner removed" test);
  - clears an empty slice.

  None of these renders or records A's reorder data under B. For the non-reorder keys, see L3.
- **Brand switch.** `setCurrentBrandId` either goes through `setCurrentStore`, or sets the `currentStore` placeholder `{ id: '' }` with no load. Store ids are globally unique, so a store in a new brand never matches the previous brand's owner tag, and its first load clears.
  - Under "All brands" (`currentStore.id === ''`), a held payload stays in memory. It is not loaded or refreshed: `loadReorderSuggestions` and `loadLastOrderContext` both bail on `''`, and no `loadFromSupabase` runs.
  - When a store is picked again, the payload is kept only if that store is its owner, which is correct ownership. This is the same as before fix round 1.
- **Logout and session loss.** `SIGNED_OUT_DATA_RESET` still nulls `reorderPayload`, `reorderStoreId` and `lastOrderContext`. So after `logout()` or `handleSessionLost()`, the next `loadFromSupabase` takes the clear branch and never starts a silent refresh.
  - A late `loadLastOrderContext` from user 1 is now also dropped after sign-out, because the placeholder `currentStore.id` differs from the captured store. This is strictly tighter than before.
  - The analysis of the silent refresh across sign-out in the original audit is unchanged.
- **Spec 156 export snapshot.** It is untouched: the UI diff is comment-only, and the `recordExportedOrder` store guard and `referenceDate` guard are unchanged.
  - A′ can only keep a payload owned by the store that is current when the `set` runs, so the `(currentStore.id, reorderPayload.asOfDate)` snapshot pairs a store with its own payload.
  - The only exception is the pre-existing L2 window, which A′ clears instead of keeping.
  - L3 affects the line costing (`inventory`), not the snapshot key.
- **Silent refresh.**
  - It is still fired only from the kept-and-current branch (`silentRefreshFrom`, `:2203`, `:2292-2294`).
  - All of its drop rules are intact (`:263-283`). The generation check now runs before `get()`, which changes nothing.
  - The warning logs only `e?.message`.
- **New and changed tests.** A grep for JWT, service-key, password or real email patterns finds nothing in any of the three spec 175 suites.
- **`useRole()`** is not used as a boundary anywhere in the diff.

### Dependencies
`package.json` and `package-lock.json` are not staged, so `npm audit` was skipped.

### Fix-round-1 summary
0 Critical, 0 High, 0 Medium, 2 open Low:
- **L2** is unchanged and is the owner-declared out-of-scope follow-up.
- **L3** is new and is display/record integrity for the store's own data only. It shares the same follow-up fix as the coordinator's stale-reload observation.

L1 is closed. Nothing blocks spec 175.

## Handoff (fix round 1)
next_agent: NONE
prompt: Security re-audit (fix round 1) complete. 0 Critical, 0 High, 0 Medium, 2 Low (L2 carried as the out-of-scope follow-up, L3 new and integrity-only). L1 closed.
payload_paths:
  - specs/175-reorder-survives-reload/reviews/security-auditor.md

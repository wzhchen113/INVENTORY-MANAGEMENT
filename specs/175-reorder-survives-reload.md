# Spec 175: Keep the reorder list on screen across a same-store reload

Status: READY_FOR_REVIEW

Origin: a bug report from the owner. The owner approved the fix plan below in chat on 2026-10-23, before this spec was written. Its decisions are recorded as resolved. Some minor gaps in the plan are resolved here, with reasons, under "Open questions resolved". No questions remain open.

**Sequencing:** line numbers are from `main` at `8872de2`. Treat them as pointers.

## User stories

1. As a **manager on the phone Ordering screen**, I want the vendor list to stay on screen after I export a vendor's CSV or PDF. Today the export's own realtime echo blanks the list to "No reorder suggestions" / "0 VENDORS · 0 LINES" until I leave the screen and come back.
2. As a **manager on the desktop Reorder section**, I want the list to stay put when any realtime change reloads the store, instead of going blank.
3. As a **manager approving an order on the phone**, I want the Approve Order screen to stop flashing empty when a realtime reload lands.

## Current state (verified 2026-10-23, `main` at `8872de2`)

**The bug.** `loadFromSupabase` ([src/store/useStore.ts:1999](../src/store/useStore.ts)) runs on every store switch and also on every same-store full reload. Same-store reloads include:
- the 400 ms-debounced realtime reload (CmdNavigator `handleSync`). One example is the self-echo right after a CSV/PDF export records its draft PO (spec 156 `recordExportedOrder`);
- explicit `loadFromSupabase()` calls after mutations (for example, useStore.ts ~L4191).

The single-store `set({...})` (~L2132-2144, the "Spec 021" and "Spec 151" comments) always sets `reorderPayload: null, reorderLoading: false, reorderError: null, lastOrderContext: null`. It does this on every reload, not only on a store switch.

**Why nothing re-fetches.** The only trigger for `loadReorderSuggestions` is the ReorderSection effect ([ReorderSection.tsx:1502-1522](../src/screens/cmd/sections/ReorderSection.tsx)). That effect is keyed on `currentStore?.id` and `selectedDate`, and neither changes on a same-store reload. The payload stays `null` until the section remounts.

**What each surface shows:**

| Surface | After a same-store reload |
|---|---|
| Phone Ordering ([PhoneOrdering.tsx](../src/screens/cmd/sections/phone/PhoneOrdering.tsx), `phone-order-empty` ~L835, `phone-order-kpi` ~L819) | "No reorder suggestions" and "0 VENDORS · 0 LINES", until the user navigates away and back. |
| Desktop ReorderSection | A blank list area. All three render branches (~L1821, ~L1849, ~L1879) need either a payload or `reorderLoading`. |
| PhoneApproveOrder ([PhoneApproveOrder.tsx:149-155](../src/screens/cmd/sections/phone/PhoneApproveOrder.tsx)) | It recovers on its own, because its effect fires again when `asOfDate` becomes `null`, but it flashes empty first. |

**Comments that wrongly say the reload re-fetches:**
- useStore.ts ~L1309-1313 (initial-state doc)
- useStore.ts ~L2132-2144 (the clear block)
- useStore.ts ~L3580-3585 ("the section's realtime-driven refetch reconciles any picked date")
- useStore.ts ~L3808-3813 and ~L3877-3880 (spec 156 `recordExportedOrder`)
- ReorderSection.tsx ~L1548-1556 (spec 151 honest-scope note)
- PhoneOrdering.tsx ~L611-617 (spec 156 `exportContext`)
- [src/types/index.ts:741-746](../src/types/index.ts) (`reorderPayload` doc: "Cleared (not refreshed) by `loadFromSupabase`")

**Shapes the fix relies on:**
- `loadReorderSuggestions` (~L4543) reads `currentStore.id` at call start. It sets `reorderLoading: true`, then `{ reorderPayload, reorderLoading: false, reorderError: null }` on success. On failure it sets `{ reorderLoading: false, reorderError }` and leaves the payload as it was.
- The `__all__` branch of `loadFromSupabase` (~L2066-2097) does not touch any reorder field today.
- `setCurrentStore` sets `currentStore` **before** it calls `loadFromSupabase(newId)`. So by the time the clear block runs, the section effect has already fired `loadReorderSuggestions` for the new store.
- The spec 160 `loadItemsLastCounted` tail and its `lastCountedStoreId` field are the model for the new `reorderStoreId` field.

## Definitions

- **Owning store:** the store id the current `reorderPayload` was fetched for. It is held in the new `reorderStoreId` field.
- **Same-store reload:** a single-store `loadFromSupabase(sid)` where `reorderStoreId === sid` at the moment the reorder fields would be written.
- **Store switch:** a single-store `loadFromSupabase(sid)` where `reorderStoreId !== sid` at that moment. This includes `reorderStoreId === null`.
- **Silent refresh:** a background `db.fetchReorderSuggestions(sid, reorderPayload.asOfDate)` started by a same-store reload. It never writes `reorderLoading`.
- **Foreground load:** any call to `loadReorderSuggestions`.

## Acceptance criteria

The test track is jest only. There is no pgTAP or shell smoke, because there is no DB change. Store-level ACs use the real store with `db` stubbed, following the `useStore.lastCounted.spec160.test.ts` idiom.

### New state field

- [ ] **AC-1:** The store has a new field `reorderStoreId: string | null`, typed on the store state interface in `src/types/index.ts` and documented there.
  - It is `null` in the initial state and in `SIGNED_OUT_DATA_RESET`.
  - It is `null` after `logout()`.
- [ ] **AC-2:** When `loadReorderSuggestions` succeeds, it writes `reorderStoreId` in the **same** `set` as `reorderPayload`. The value is the store id the fetch was issued for, captured at call start, not `currentStore` at completion.
  - On failure, `reorderStoreId` and `reorderPayload` are unchanged. The payload behavior is the same as today.
  - Every other write that sets `reorderPayload` to `null` also sets `reorderStoreId` to `null`.

### Same-store reload

Test setup for AC-3 to AC-7: `currentStore.id = 'S'`, `reorderStoreId = 'S'`, `reorderPayload = P` with `P.asOfDate = 'D'`, and a non-null `lastOrderContext = L`. Then run `loadFromSupabase('S')`.

- [ ] **AC-3:** A `useStore.subscribe` recorder sees `reorderPayload !== null` in **every** state, from the call until the silent refresh settles. `lastOrderContext` stays `L` (same reference) for the whole run.
- [ ] **AC-4:** The reload issues exactly **one** `db.fetchReorderSuggestions('S', 'D')` call. `loadFromSupabase` does not await it: with a fetch mock that never resolves, `loadFromSupabase('S')` still resolves.
- [ ] **AC-5:** The subscribe recorder never sees `reorderLoading === true` during the reload or the silent refresh.
- [ ] **AC-6:** On success, `reorderPayload` is the fresh payload, `reorderError` is `null`, and `reorderStoreId` is `'S'`. A `reorderError` that was set before the reload is kept until this success clears it.
- [ ] **AC-7:** On failure:
  - `reorderPayload` is still `P` (same reference);
  - `reorderError` and `reorderStoreId` are unchanged;
  - `console.warn` is called;
  - no toast is shown (neither `notifyBackendError` nor `Toast.show` is called for this failure);
  - nothing becomes an unhandled rejection.

### Silent refresh drop cases

In each case below, the silent result is dropped. A dropped result writes **none** of `reorderPayload`, `reorderError`, `reorderStoreId`, or `reorderLoading`.

- [ ] **AC-8 (store changed):** `currentStore.id` is no longer `'S'` when the silent fetch settles. The result is dropped.
- [ ] **AC-9 (foreground load in flight):** `reorderLoading` is `true` when the silent fetch settles. The result is dropped, and the foreground result is what lands.
- [ ] **AC-10 (foreground load started after it):** a foreground `loadReorderSuggestions` was **started** after the silent refresh was issued and has **already finished** when the silent fetch settles. The silent result is dropped, so the newer foreground payload is not overwritten by an older response (see resolved decision R3).
- [ ] **AC-11 (date changed or payload gone):** when the silent fetch settles, `reorderPayload` is `null`, or its `asOfDate` is no longer `'D'`. The result is dropped.

### Store switch and no-payload cases

- [ ] **AC-12:** On a store switch, the single-store `set` writes:
  - `reorderPayload: null`, `reorderLoading: false`, `reorderError: null`, `lastOrderContext: null` (today's spec 021 and spec 151 values);
  - `reorderStoreId: null`.

  Test both a payload owned by another store (`reorderStoreId = 'A'`, `loadFromSupabase('B')`) and `reorderStoreId = null` with a non-null `lastOrderContext`. The second is the existing spec 151 store-switch test's setup.
- [ ] **AC-13:** On a store switch, `loadFromSupabase` itself makes **zero** `db.fetchReorderSuggestions` calls. The ReorderSection effect stays the only fetch trigger on a switch.
- [ ] **AC-14:** With no payload loaded (`reorderStoreId = null`, `reorderPayload = null`), `loadFromSupabase('S')` makes zero `db.fetchReorderSuggestions` calls, and `reorderPayload` stays `null`. This keeps spec 021's lazy-load posture.
- [ ] **AC-15:** For `loadFromSupabase('__all__')`:
  - `reorderPayload`, `reorderLoading`, `reorderError`, `lastOrderContext`, and `reorderStoreId` are unchanged (same values or references as before the call);
  - zero `db.fetchReorderSuggestions` calls are made;
  - the `__all__` branch's code is unchanged.

### Things that must not change

- [ ] **AC-16:** `reorderEdits` is still **not** reset by `loadFromSupabase` (spec 138). `recordExportedOrder` still does not call `loadReorderSuggestions` (spec 156 AC-7). The `loadMenuCapacity` and `loadItemsLastCounted` tails still run exactly as today.
- [ ] **AC-17:** The only edits to `ReorderSection.tsx` and `PhoneOrdering.tsx` are comment changes, so any non-comment hunk fails this AC. `PhoneApproveOrder.tsx` is not edited. The spec 156 export-start snapshot (`exportContext` / `ExportRecordingContext`) stays as it is.
- [ ] **AC-18:** Every stale comment listed under "Current state" is corrected to describe the new behavior: same-store reloads keep the payload and refresh it silently, and store switches clear it. No comment in `src/` still claims a same-store `loadFromSupabase` nulls `reorderPayload` or re-fetches through the section effect.

### UI

- [ ] **AC-19:** A new phone render test follows the `PhoneOrdering.lastOrderContext.spec151.test.tsx` idiom (real store, `db` and supabase stubbed). It sets a single-store payload with at least one primary vendor and one line, owned by the current store, and renders PhoneOrdering. It then runs `loadFromSupabase(currentStore.id)` and asserts the following. Check at two points: while the silent fetch is still pending (deferred mock), and again after it resolves with a fresh payload.
  - `phone-order-card-<vendorId>` and `phone-order-line-<itemId>` render;
  - `phone-order-kpi` shows a non-zero vendor and line count;
  - `phone-order-empty` and `phone-order-loading` are absent.

### Regression and gates

- [ ] **AC-20:** These existing suites pass **unmodified**:
  - `src/store/useStore.lastOrderContext.spec151.test.ts` (its store-switch test still passes, because `reorderStoreId` is `null` there);
  - `src/store/useStore.switching.test.ts`;
  - `src/store/useStore.lastCounted.spec160.test.ts`;
  - `src/store/useStore.recordExportedOrder.spec156.test.ts`;
  - every existing `ReorderSection.*`, `PhoneOrdering.*`, and `PhoneApproveOrder.*` test.
- [ ] **AC-21:** Full `npx jest` (not a subset), `npm run typecheck`, and `npm run typecheck:test` all pass.
- [ ] **AC-22:** Browser check on the local stack (`npm run dev:db`, admin@local.test), first at 390 px phone width (Ordering) and then at desktop width (Reorder):
  - open the list for a store with suggestions;
  - trigger a same-store realtime reload by bumping `eod_submissions.submitted_at` on one row in local SQL;
  - the list stays on screen with no blank and no loading flicker;
  - export a vendor's CSV, and the list stays on screen through the draft-PO self-echo;
  - switch stores, and the list clears and reloads for the new store as today;
  - no console errors.

  Restore any rows you touched afterward.

## In scope

- `src/store/useStore.ts`:
  - the `reorderStoreId` field (initial state, `SIGNED_OUT_DATA_RESET`, `loadReorderSuggestions` success);
  - in the single-store `loadFromSupabase` `set`, branching between store switch and same-store reload;
  - the silent-refresh tail;
  - the stale comments.
- `src/types/index.ts`: the `reorderStoreId` type and doc, and the corrected `reorderPayload` doc.
- Comment-only corrections in `ReorderSection.tsx` and `PhoneOrdering.tsx`.
- New jest files: a store suite (suggested name `src/store/useStore.reorderReload.spec175.test.ts`) and a phone render suite (suggested name `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx`).

## Out of scope (explicitly)

- **Foreground cross-store race (follow-up).** This bug is older than this spec. A foreground `loadReorderSuggestions` for store A can land after a switch to store B and show A's list under B. This spec does not guard the foreground path. `reorderStoreId` will record A in that case, so the next same-store reload of B counts as a store switch and clears the list. That partly limits the damage but does not fix it.
- **Any UI behavior change**, including new loading indicators, a "refreshing" hint, or changes to the three ReorderSection render branches or the phone empty and loading states.
- **Removing the spec 156 export-start snapshot.** A store switch can still null the payload in the middle of an export, so the snapshot stays.
- **Refreshing `lastOrderContext` from the store.** It is kept as it is. The ReorderSection effect already re-fetches it when the vendor-id key or `asOfDate` changes.
- **The date mismatch after a PO lifecycle mutation.** Those mutations call `loadReorderSuggestions()` with no argument, which loads the server's today even if the user picked another date. This is older than this spec and unrelated. Only the comment at ~L3580-3585 is corrected.
- **Editing comments inside existing test files** (for example `useStore.recordExportedOrder.spec156.test.ts` ~L311). AC-20 requires those files to stay unmodified.
- **Any DB, RPC, migration, edge function, or realtime publication change.**
- **The `app.json` slug.** Not touched.

## Open questions resolved

Owner-approved, 2026-10-23:
- Q: How should the fix tell a store switch from a same-store reload? → A: Add a `reorderStoreId` field that records which store the payload belongs to. If it differs from the target store, clear the reorder fields as today. If it matches, keep them.
- Q: How should a same-store reload refresh the list? → A: Run a fire-and-forget **silent** refresh for the date already shown (`reorderPayload.asOfDate`), the same way the `loadMenuCapacity` / `loadItemsLastCounted` tails work. It never sets `reorderLoading`. It is dropped if the store changed, a foreground load is in flight, or the date changed or the payload is gone. On success it replaces the payload and clears `reorderError`. On failure it keeps the old payload, calls `console.warn`, and shows no toast and no `reorderError`.
- Q: Should UI files change? → A: Only stale comments. The spec 156 export snapshot stays.
- Q: Should this fix the foreground cross-store race? → A: No. It is a follow-up (see Out of scope).

Resolved here by the PM. Each is a minor gap in the approved plan.
- **R1. When is "same store" checked?** At the moment the reorder fields would be written, after `fetchAllForStore` resolves, not when `loadFromSupabase` starts. Reason: `setCurrentStore` fires the section's foreground load before this `set` runs. If that load lands first, `reorderStoreId` already equals the new store, and keeping its fresh payload is correct. Today that same race blanks the list on a switch, which is another case of this bug.
- **R2. Which store id does `reorderStoreId` record?** The id the fetch was issued for, captured at call start (AC-2). Reason: that is the store the payload actually belongs to. Recording `currentStore` at completion would label store A's payload as B's, and the store-switch clear would then miss it.
- **R3. "Foreground load in flight" also covers one that already finished.** The plan drops the silent result only while `reorderLoading` is true. A foreground load that starts **and** finishes while the silent fetch is pending would otherwise be overwritten by the older silent response. The owner's intent, that a foreground load wins, covers this case too, so AC-10 pins it. The mechanism, such as a generation counter bumped by each `loadReorderSuggestions`, is the architect's call.
- **R4. Two silent refreshes at once.** Back-to-back realtime reloads can each start one. This spec does not require ordering between them: both are fresher than the payload they replace, and the next reload converges. If the R3 mechanism also orders silent refreshes for free, the architect may use it.
- **R5. The silent path does not call `loadReorderSuggestions`.** It calls `db.fetchReorderSuggestions` directly, because `loadReorderSuggestions` always sets `reorderLoading: true` (which would break AC-5) and sets `reorderError` on failure (which would break AC-7). `loadReorderSuggestions` changes only to write `reorderStoreId`, plus any generation bump R3 needs.

## Notes for architect (non-blocking)

- **N1.** The field mirrors spec 160's `lastCountedStoreId`. Keep the invariant that `reorderStoreId` is non-null exactly when `reorderPayload` was set by a successful fetch.
- **N2.** Every non-test `reorderPayload` write is at L1189, L1314, L2136, and L4549. Those are the four places `reorderStoreId` must track.
- **N3.** Pass `asOfDate` through exactly as it appears in the payload. `db.fetchReorderSuggestions` echoes `envelope.as_of_date || asOfDate` (db.ts ~L4708), so a round-trip keeps the same value. AC-11's comparison is a plain string equality on `reorderPayload.asOfDate`.
- **N4.** With the payload kept, the ReorderSection spec 151 `lastOrderContext` effect no longer re-fires on every replay, because the vendor-id key no longer goes `'a,b'` → `''` → `'a,b'`. That removes one RPC per replay. The comment at ~L1548 should say so.

## Risks

- **Stale list for one round-trip.** Between the reload and the silent refresh settling, the list on screen is the pre-reload payload. This is intended and is the owner's call: before this fix, the screen showed nothing at all in that window.
- **Silent failure shows stale data.** If the silent refresh fails, the old list stays with no indicator (AC-7). The next reload or a manual refresh tries again.
- **Cross-store leak.** This is the main thing to review. The store-switch clear must still fire on every real switch. AC-12, AC-13, and R1/R2, plus the unmodified spec 151 store-switch test, cover it.
- **Deploy.** Client-only with no migration, so the `db-migrations-applied` gate is unaffected. After pushing, check that `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` manually (per project memory).

## Dependencies

- Spec 021: the reorder slice and its store-switch clear.
- Spec 087: the ReorderSection as-of fetch effect.
- Spec 138: `reorderEdits` is not reset on reload.
- Spec 151: the `lastOrderContext` clear on store switch.
- Spec 156: `recordExportedOrder` and the export-start snapshot.
- Spec 160: the `lastCountedStoreId` pattern.
- Specs 143 and 149: phone Ordering and Approve Order, which read the shared payload.
- The local stack (`npm run dev:db`) for the AC-22 browser check.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI. Logic changes are in `src/store/useStore.ts` only. `src/screens/cmd/sections/ReorderSection.tsx` and `src/screens/cmd/sections/phone/PhoneOrdering.tsx` get comment-only edits. There is no legacy surface.
- **Per-store or admin-global:** per-store. The payload is the store-scoped `report_reorder_list` result (`auth_can_see_store`). This spec adds the client-side owning-store tag. There is no RLS change.
- **Realtime channels touched:** none changed. The fix reacts to reloads already driven by `store-{id}` / `brand-{id}` through `handleSync`. There is no publication change, so the realtime container restart gotcha does not apply.
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Web/native scope:** both. This is shared Zustand store logic. The AC-22 browser check is web, at phone and desktop widths.
- **Test tracks:** jest only (a store suite and a phone render suite), plus `npm run typecheck` and `npm run typecheck:test`. No pgTAP and no shell smoke.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria and any project-specific notes, then produce the design doc and set Status: READY_FOR_BUILD.
payload_paths:
  - specs/175-reorder-survives-reload.md

## Backend design

Architect, 2026-10-23, against `main` at `8872de2`. Line numbers are pointers.

### 0. Summary

This is a client-only change in one file (`src/store/useStore.ts`), plus a type and doc in `src/types/index.ts`, comment-only edits in two section files, and two new jest suites.

The pieces:
- **`reorderStoreId`.** A new field that records which store the payload belongs to.
- **Keep or clear.** The single-store `loadFromSupabase` `set` keeps or clears the reorder fields depending on that field.
- **Silent refresh.** A fire-and-forget refresh runs in the keep case.
- **Request generation.** A module-private counter lets a foreground load (or a newer silent refresh) beat an older silent response.

The design adds no new store action and does not widen `StoreActions`.

### 1. Data model changes

None. No migration, no RPC change, no edge function, no publication change, so the realtime container-restart gotcha does not apply. The `db-migrations-applied` gate is unaffected.

### 2. RLS impact

None. The payload is still `report_reorder_list`, which is store-scoped via `auth_can_see_store()`. `reorderStoreId` is a client-side ownership tag. It is not a security boundary, so it adds nothing to RLS.

### 3. API contract

Unchanged. The silent refresh reuses `db.fetchReorderSuggestions(storeId, asOfDate)` ([src/lib/db.ts:4679](../src/lib/db.ts)) exactly as `loadReorderSuggestions` calls it:
- it goes through `useInflight.track`, so it gets the 30 s hard-abort;
- it throws on RPC error;
- it echoes `envelope.as_of_date || asOfDate` (N3).

There is no new `db.ts` helper and no direct `supabase.*` call.

### 4. Edge functions

None.

### 5. `src/lib/db.ts` surface

No change.

### 6. Store design (`src/store/useStore.ts`)

#### 6.1 New field — `reorderStoreId: string | null` (AC-1, AC-2, N1, N2)

- **Type.** Add it in [src/types/index.ts](../src/types/index.ts) directly after `reorderError` (~L749). Its doc should mirror `lastCountedStoreId` (~L794-799): "the store id the current `reorderPayload` was fetched for, captured at fetch start. Non-null only after a successful fetch, and nulled in the same write as every payload clear. `loadFromSupabase` compares it with the target store to tell a store switch (clear) from a same-store reload (keep plus silent refresh). Spec 175."
- **Initial state.** Add `reorderStoreId: null as string | null,` (~L1316) beside `reorderError`.
- **`SIGNED_OUT_DATA_RESET`.** Add `reorderStoreId: null,` (~L1191). This covers `logout()` and `handleSessionLost()`, which both spread it, and the `satisfies Partial<FullStore>` check enforces the key.
- **The four payload writes from N2:**

| Site | Write |
|---|---|
| L1189 (signed-out reset) | `reorderStoreId: null` |
| L1314 (initial) | `null` |
| L2136 (store-switch clear) | `reorderStoreId: null` (§6.3) |
| L4549 (`loadReorderSuggestions` success) | `reorderStoreId: storeId` in the **same** `set` (§6.2) |

  The silent-refresh success (§6.4) is a fifth write. It also writes `reorderStoreId` in the same `set` as the payload.

#### 6.2 `loadReorderSuggestions` (~L4543), the only edits

```
const storeId = get().currentStore?.id;        // unchanged — captured at call start (R2)
if (!storeId) return;                           // unchanged
++reorderRequestGen;                            // NEW — synchronous, BEFORE the first set/await
set({ reorderLoading: true, reorderError: null });          // unchanged
...
set({ reorderPayload: payload, reorderStoreId: storeId, reorderLoading: false, reorderError: null });  // + reorderStoreId
catch: unchanged (reorderStoreId and reorderPayload untouched — AC-2)
```

**Does the bump change observable behavior?** No.
- The counter is module-level and not Zustand state, so bumping it fires no subscriber, renders nothing, and changes none of the action's `set` sequence. `loadReorderSuggestions` never reads it.
- The only observable change is the extra `reorderStoreId` key in the existing success `set`. It is still one `set`, so the subscriber sees the same number of transitions.
- Put the bump after the `!storeId` guard. A call that returns early starts no request, so it must not invalidate a pending silent refresh.
- The bump must sit before the first `await`, because "started after" (AC-10) means call-time order.

Write `storeId` even if `payload` were falsy. Real `db` never returns null, though some existing mocks do. The keep predicate in §6.3 also requires a non-null payload, so a null-returning mock can never trip the keep path.

Update the action's JSDoc in `StoreActions` (~L1066-1075) and its implementation comment (~L4538-4542) to say two things: the success write records `reorderStoreId`, and each call advances the reorder request generation (spec 175).

#### 6.3 `loadFromSupabase` single-store `set` (~L2100-2168), keep or clear (AC-3, AC-12, AC-14, R1)

Right after `const data = await db.fetchAllForStore(sid);` and **synchronously before** the `set({...})`, so there is no `await` between the check and the write (R1), compute:

```
const pre = get();
const keepReorder =
  pre.reorderPayload !== null &&
  pre.reorderStoreId === sid &&
  pre.currentStore?.id === sid;
```

In the `set({...})`, replace the four unconditional reorder keys (L2136-2144) with a conditional spread:

```
...(keepReorder ? {} : {
  reorderPayload: null, reorderLoading: false, reorderError: null,
  reorderStoreId: null, lastOrderContext: null,
}),
```

- **Keep branch.** It writes **no** reorder key. `reorderPayload`, `reorderLoading`, `reorderError`, `reorderStoreId` and `lastOrderContext` keep their values and references. This is what AC-3, AC-5 and AC-6 rely on.
  - A foreground load can be in flight during a keep (`reorderLoading: true`). Keeping it `true` is correct. Today's clear sets it `false` under a live load, which is wrong.
- **Clear branch.** It writes today's spec 021 and spec 151 values plus `reorderStoreId: null` (AC-12).
- **Other keys.** All other keys in the `set` stay byte-identical. That includes the spec 138 `reorderEdits` non-reset comment, `menuCapacity` and the `lastCounted*` keys (AC-16).
- **The `__all__` branch (L2066-2097)** is not touched (AC-15).

**Architect addition: the `currentStore?.id === sid` term.** It is not in the spec's definition. It only makes the keep path narrower, in a case the spec does not define: a reload issued for store A that lands after the user has already switched to B.
- With the term, that stale reload clears the reorder slice instead of keeping A's payload under B until B's own load lands.
- Every current caller passes the then-current store (CmdNavigator L68-69, `setCurrentStore`, `login`'s `land`, L2345-2346, and the no-arg L4191). So the term is a no-op on the normal path and in every AC fixture.
- It cannot cause a leak. It can only clear more.

**R1 consequence (intended; document it in the block comment).** On a real switch A→B, `setCurrentStore` fires the section's foreground load for B before this `set` runs.
- **B's foreground load lands first:** `reorderStoreId` is already `'B'`, so the keep branch runs. It keeps B's fresh payload and issues one silent refresh for B. That refresh is redundant but harmless.
- **B's load lands second:** the clear branch runs, as today.

AC-13 drives `loadFromSupabase('B')` directly with `reorderStoreId = 'A'`, so it is unaffected.

**After the `set`, next to the existing tails:**

```
get().loadMenuCapacity(sid);          // unchanged
get().loadItemsLastCounted(sid);      // unchanged
if (keepReorder) startSilentReorderRefresh(get, set, sid, pre.reorderPayload!.asOfDate);   // NEW
```

- It is called, not awaited (AC-4), and it never rejects (§6.4).
- Pass `asOfDate` exactly as stored in the payload: no `slice`, no normalization (N3).
- `pre.reorderPayload` is the kept payload, the same reference that is still in state.

**Rewrite the block comment** at L2132-2144 to describe the new rule:
- a store switch (the owning store differs, or no payload) clears;
- a same-store reload keeps the payload and the context and refreshes the payload silently;
- the clear still guards cross-store vendor-keyed context (keep the spec 151 load-bearing explanation);
- the R1 timing note above.

Delete the line "The section will re-fetch via its useEffect on currentStore.id." It is the stale claim.

#### 6.4 The silent refresh is a module-private function (R3, R4, R5, AC-4 to AC-11)

**Where.** Module level, directly after the `recordingKeys` declaration (~L222). That is the existing precedent for module-level, not-in-Zustand, never-rendered bookkeeping, and its doc block should follow the `recordingKeys` style. It is **not** a store action, and `StoreActions` is not widened. Tests drive it only through `loadFromSupabase`, which is exactly what the ACs are phrased against.

```
/** Spec 175 — reorder request generation. Advanced by every request that can
 *  write `reorderPayload`: each foreground `loadReorderSuggestions` call and each
 *  silent refresh. A silent result lands only if it is still the newest request.
 *  Module-level, not Zustand state: never rendered, never reset by test isolation
 *  (only equality is ever compared, so its absolute value is irrelevant). */
let reorderRequestGen = 0;

function startSilentReorderRefresh(
  get: StoreApi<FullStore>['getState'],
  set: StoreApi<FullStore>['setState'],
  storeId: string,
  asOfDate: string,
): void {
  const gen = ++reorderRequestGen;
  db.fetchReorderSuggestions(storeId, asOfDate)
    .then((fresh) => {
      const s = get();
      if (gen !== reorderRequestGen) return;                         // AC-10 (+ R4: newer silent wins)
      if (s.currentStore?.id !== storeId) return;                    // AC-8
      if (s.reorderLoading) return;                                  // AC-9
      if (!s.reorderPayload || s.reorderPayload.asOfDate !== asOfDate) return;  // AC-11
      if (!fresh) return;                                            // defensive: never write a null payload with a non-null owner (N1)
      set({ reorderPayload: fresh, reorderStoreId: storeId, reorderError: null });  // AC-6 — ONE set; never reorderLoading
    })
    .catch((e: any) => {
      console.warn('[Supabase] silent reorder refresh:', e?.message || e);       // AC-7 — warn only
    });
}
```

`StoreApi` is `import type { StoreApi } from 'zustand'`, added to the existing L2 import. `FullStore` is declared at L1140, and TypeScript type hoisting makes it visible here. If `set`'s overloads prove awkward under strict mode, the developer may type the parameter as `(partial: Partial<FullStore>) => void`. Do not use `any`.

**Contract points:**
- **No `reorderLoading`.** It never writes `reorderLoading`, on any path (AC-5).
- **Failure writes nothing.** No `notifyBackendError`, no `Toast`, no `reorderError` (AC-7).
- **Drop writes nothing.** A dropped result writes none of the four fields (the AC-8 to AC-11 preamble).
- **Unhandled rejections.** `.then(...).catch(...)`, not `.then(ok, err)`. A throw inside the success handler is caught as well, so nothing becomes an unhandled rejection (AC-7).
- **No call to `loadReorderSuggestions`** (R5).
- **`lastOrderContext` untouched** (AC-3).

**Why a generation counter, and why each of the four drop rules is needed:**

- **The generation rule.** It covers AC-10 (a foreground load started after the silent one and already finished, with `reorderLoading` back to `false`). That is the case the plan's loading check misses. Because silent refreshes advance the counter too, R4 also comes for free: of two overlapping silent refreshes, only the later-issued one can land, so an older response never overwrites a newer one.
  - **Starvation.** Under continuous churn every silent result could be superseded. In practice each one is issued only at the end of a full reload, which is debounced 400 ms plus probe, `fetchStores` and `fetchAllForStore`. It converges as soon as the churn stops.
- **The loading rule.** It covers AC-9 when the foreground load started **before** the silent one, so the generation alone would let the silent result land on top of a load that is still in flight.
- **The store rule.** It covers AC-8.
- **The date and payload rule.** It covers AC-11. It also covers every path that nulls the payload without bumping the counter (a store-switch clear, `SIGNED_OUT_DATA_RESET`, a test `setState`).

**Bump the generation in the store-switch clear? No.** It would be redundant:
- every write that can put a **non-null** payload into state already advances the counter (foreground or silent);
- every write that **nulls** the payload is caught by the AC-11 null check.

Keeping the counter's write sites to the two payload issuers keeps the invariant easy to state: "the generation identifies the newest request that could write the payload." `SIGNED_OUT_DATA_RESET` and logout need no bump for the same reason.

**Write order inside a successful silent result.** A foreground load that failed after the silent one was issued leaves `reorderError` set and `reorderLoading` false. The silent result then lands and clears `reorderError`. That is intended: fresher successful data replaces the error (AC-6 wording).

### 7. Realtime impact

No channel or publication change. The fix only changes what the existing `store-{id}` / `brand-{id}` → `handleSync` → `loadFromSupabase` path does to the reorder slice.

N4 follows: with the payload reference kept and the silent refresh keeping the same vendor set, the ReorderSection spec 151 `lastOrderContext` effect ([ReorderSection.tsx:1563-1567](../src/screens/cmd/sections/ReorderSection.tsx)) no longer re-fires on each replay. It re-fires only if the refreshed vendor set or `asOfDate` actually changes, which is correct.

### 8. Frontend impact

The store slice is the reorder slice of `useStore.ts`. There is no optimistic-then-revert: this is a pure read, so there is nothing to revert, and the toast is deliberately suppressed (AC-7).

UI files get comment-only edits (AC-17). `PhoneApproveOrder.tsx` is not edited. Its effect (L150-155) no longer sees `asOfDate → null` on a same-store reload, so the flash disappears with no edit.

#### 8.1 Comment corrections (AC-18), the full list for non-test `src/`

| # | Location | Stale claim | Correct to |
|---|---|---|---|
| 1 | `useStore.ts` ~L193-194 (`ExportRecordingContext` doc) | "a realtime reload nulling `reorderPayload`" | the payload can be nulled by a mid-export **store switch** or replaced by a foreground load for another date. A same-store realtime reload keeps it (spec 175), but the snapshot is still required. |
| 2 | `useStore.ts` ~L1309-1313 (initial state) | cleared by `loadFromSupabase` so the section's mount-effect re-pulls | lazy-loaded by the section. A store switch clears it. A same-store reload keeps it and refreshes it silently. `reorderStoreId` is the owner tag. |
| 3 | `useStore.ts` ~L2132-2144 (clear block) | rewrite per §6.3 | |
| 4 | `useStore.ts` ~L3578-3585 (spec 107 shared note) | "realtime … re-runs the section's date-specific reorder fetch" / "the section's realtime-driven refetch reconciles any picked date" | realtime triggers a same-store reload that silently refreshes the payload for the date **currently in the payload**. The no-arg `loadReorderSuggestions()` here loads the server's today, and a previously picked date is **not** reconciled. That is a known pre-existing gap (spec 175 Out of scope). Do not change the code. |
| 5 | `useStore.ts` ~L3808-3813 (`recordExportedOrder` Medium 2 bullet) | "`loadFromSupabase` nulls it on EVERY realtime reload, including the self-echo" | it is nulled by a store switch and replaced by a foreground load for a new as-of date, and the self-echo no longer nulls it (spec 175). Keep the conclusion: `referenceDate` must still come from `exportedAt`. Keep "Do NOT simplify". |
| 6 | `useStore.ts` ~L3877-3880 (AC-7 / OQ-6) | "the realtime self-echo already nulls reorderPayload and refetches the section" | the self-echo's same-store reload keeps the list on screen and silently refreshes it (spec 175). That is why no `loadReorderSuggestions()` call is needed here. |
| 7 | `useStore.ts` ~L1066-1075 and ~L4538-4542 (`loadReorderSuggestions` docs) | (incomplete, not stale) | add the `reorderStoreId` write and the generation bump (§6.2) |
| 8 | `types/index.ts` ~L741-746 (`reorderPayload` doc) | "Cleared (not refreshed) by `loadFromSupabase`" | cleared on a store switch. Kept and silently refreshed on a same-store reload (spec 175). |
| 9 | `ReorderSection.tsx` ~L373-377 | "`reorderPayload` (nulled by every realtime reload)" | nulled by a store switch, or replaced by a reload or date change |
| 10 | `ReorderSection.tsx` ~L504-508 | "a realtime reload can null `reorderPayload`" | a store switch can null it, and a reload can replace it |
| 11 | `ReorderSection.tsx` ~L1548-1556 (spec 151 honest-scope note) | replay keys `'a,b' → '' → 'a,b'` and refetches | since spec 175 a same-store replay keeps the payload, so the key stays stable and the effect does **not** re-fire. That is one RPC fewer per replay (N4). A store switch still nulls the payload, so the key goes through `''` and the effect re-fires for the new store. Drop the stale `useStore.ts:1580/1588` line refs. |
| 12 | `ReorderSection.tsx` ~L1496-1498 | "`loadFromSupabase` already clears `reorderPayload` … for the new store on switch" | still true. Optional: append "(store switch only — same-store reloads keep it, spec 175)". |
| 13 | `PhoneOrdering.tsx` ~L611-617 (`exportContext`) | "`reorderPayload` is nulled by every realtime reload, including the self-echo" | a store switch can null it, and a foreground date load can replace it. Keep "captured before the first await". |

Out of scope per the spec: stale comments inside **existing test files** (`useStore.recordExportedOrder.spec156.test.ts` ~L311, `ReorderSection.recordExport.spec156.test.tsx` ~L441, `ReorderSection.lastOrderContext.spec151.test.tsx` ~L179-181). AC-20 freezes those files.

**Reviewer note.** Read AC-18's "No comment in `src/`" as non-test source. Otherwise it contradicts AC-20 and the Out-of-scope list. This is a reading of the spec's own text, not a scope change. A follow-up can sweep the test comments.

**Verification grep for the developer.** It should return only test-file hits:

```
rg -n "nulled by every|nulls it on EVERY|self-echo already nulls|realtime-driven refetch|Cleared \(not refreshed\)|re-fetch via its useEffect" src
```

### 9. Tests

The track is jest only. Both suites must also pass `npm run typecheck:test`.

#### 9.1 Store suite: `src/store/useStore.reorderReload.spec175.test.ts`

**Harness.** Copy `useStore.lastCounted.spec160.test.ts` (L29-119):
- mock `react-native-toast-message`;
- mock `../lib/supabase`;
- mock `../lib/auth` with `hasActiveSession: jest.fn().mockResolvedValue(true)`. **This is required.** Without it the spec 152 probe can bail, and the keep and silent paths never run.
- `INITIAL_STATE` snapshot, `setState(INITIAL_STATE, true)` in `beforeEach`;
- `currentUser: null`, so `fetchNotifications` never fires;
- `flush()` / `deferred()` helpers;
- `console.warn` spy.

The `../lib/db` mock adds:
- `fetchReorderSuggestions: jest.fn()`, set per test, usually to a `deferred().promise`;
- `fetchMenuCapacity: []`, `fetchItemsLastCounted: []`;
- the full `fetchAllForStore` shape from spec 160 (L60-77).

Fixture helper:
- `seedSameStore()` sets `currentStore: {id:'S'}`, `reorderStoreId: 'S'`, `reorderPayload: P` (`asOfDate: 'D'`), `lastOrderContext: L`, `reorderLoading: false` and `reorderError: null`.
- `P`, `F` (fresh) and `F2` are distinct object literals, so `toBe` identity checks are meaningful.

**Anti-vacuity rule.** Every same-store case must assert `db.fetchAllForStore` was called with `'S'`. Every keep case must also assert `fetchReorderSuggestions` was called with `('S','D')`. That proves the reload actually ran.

| Case | Setup / action | Assert | AC |
|---|---|---|---|
| T1 initial and logout | `INITIAL_STATE`; then seed `reorderStoreId:'S'` and call `logout()` | `reorderStoreId` is `null` both times | AC-1 |
| T2 foreground records the issuing store | `currentStore 'A'`, start `loadReorderSuggestions('D')` (deferred), `setState({currentStore:{id:'B'}})`, resolve `F` | `reorderStoreId === 'A'`, `reorderPayload === F`. A subscribe recorder never sees the new payload with the old owner (one `set`) | AC-2 |
| T3 foreground failure | seeded `'S'`/`P`; reject | `reorderStoreId 'S'`, `reorderPayload` is `P`, `reorderError` is set (today's behavior) | AC-2 |
| T4 keep, never null, no loading | `seedSameStore`; subscribe recorder; `await loadFromSupabase('S')`; resolve `F`; flush | every recorded state has payload non-null, `reorderLoading` false, `lastOrderContext` is `L` | AC-3, AC-5 |
| T5 one fetch, not awaited | `fetchReorderSuggestions` returns a never-resolving promise | `await loadFromSupabase('S')` resolves; exactly 1 call with `('S','D')` | AC-4 |
| T6 success | pre-set `reorderError:'old'`; reload; check before resolve, then resolve `F` | before resolve: `reorderError === 'old'`. After: payload is `F`, error `null`, owner `'S'` | AC-6 |
| T7 failure | reload; reject `Error('x')`; flush; `process.on('unhandledRejection', spy)` installed for the test | payload is `P`, `reorderError` and `reorderStoreId` unchanged, `console.warn` called, `Toast.show` not called, spy not called | AC-7 |
| T8 store changed | reload; `setState({currentStore:{id:'B'}})`; resolve `F` | payload is `P`, owner `'S'`, error and loading unchanged | AC-8 |
| T9 foreground in flight (loading rule) | seeded; start `loadReorderSuggestions('D')` with deferred `d2` **first**; then reload (silent `d1`, issued **after**, so the generation alone would admit it); resolve `d1` with `F`; then resolve `d2` with `F2` | after `d1`: payload still `P`. Final payload `F2` | AC-9 |
| T10 foreground started after and finished (generation rule) | reload (silent `d1`); `await loadReorderSuggestions('D')` resolving `F2` (loading back to false); resolve `d1` with `F` | payload `F2` | AC-10 |
| T11a payload gone | reload; `setState({reorderPayload:null})`; resolve `F` | payload still `null`; owner, error and loading unchanged | AC-11 |
| T11b date changed | reload; `setState({reorderPayload:{...P, asOfDate:'D2'}})`; resolve `F` | payload is the `D2` object | AC-11 |
| T12a switch, owned elsewhere | `reorderStoreId:'A'`, `currentStore:'B'`, payload `P`, context `L`; `loadFromSupabase('B')` | payload, owner and context `null`, loading `false`, error `null`; 0 fetch calls | AC-12, AC-13 |
| T12b switch, no owner | `reorderStoreId:null`, context `L` (the spec 151 setup); `loadFromSupabase('S')` | same nulls; 0 fetch calls | AC-12, AC-13 |
| T13 nothing loaded | `reorderStoreId:null`, payload `null`; `loadFromSupabase('S')` | 0 fetch calls; payload `null` | AC-14 |
| T14 `__all__` | seeded; `loadFromSupabase('__all__')` | the five fields are the same values or references; 0 fetch calls | AC-15 |
| T15 untouched neighbours | seeded plus `reorderEdits:{v:{i:3}}`; reload | `reorderEdits` unchanged (same ref); `fetchMenuCapacity` and `fetchItemsLastCounted` each called once with `'S'` | AC-16 |
| T16 (design pin, R4) | two sequential `loadFromSupabase('S')` calls → silent `d1`, `d2`; resolve `d2` with `F2`, then `d1` with `F` | payload `F2` (the older silent result is dropped) | R4 |

`recordExportedOrder` not calling `loadReorderSuggestions` (AC-16, second half) is already pinned by the unmodified `useStore.recordExportedOrder.spec156.test.ts` L402.

#### 9.2 Phone render suite: `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx` (AC-19)

**Harness.** Copy `PhoneOrdering.lastOrderContext.spec151.test.tsx` L15-56: safe-area, toast, supabase and breakpoints mocks, the real store, and the Proxy `db`. Three changes are **required**, or the test passes vacuously or crashes:

1. **The supabase `getSession` mock must return a session with a user**, for example `{ data: { session: { user: { id: 'u1' } } }, error: null }`. The spec 151 file returns `session: null`. That makes the real `hasActiveSession()` return `false`, so `loadFromSupabase` bails into `sessionLost`, the payload is never touched, and the "list stays" assertions pass for the wrong reason.
2. **The Proxy target must define explicit entries** for `fetchStores` (→ `[]`; the Proxy default of `null` throws on `.length` inside `loadFromSupabase`), `fetchAllForStore`, `fetchReorderSuggestions`, `fetchMenuCapacity` (`[]`), `fetchItemsLastCounted` (`[]`) and `cleanupOldRecords`. The `fetchAllForStore` stub must return:
   - full arrays (`recipeCategories`, `ingredientCategories` and so on; `.length` is read);
   - `orderSchedule: everyDay(['v-a'])`. **Load-bearing:** the reload replaces `orderSchedule`, and with an empty schedule the vendor partition is empty and `phone-order-empty` renders whether or not the payload survived.
   - `inventory: [{ id:'a1', subUnitSize:1 }]` and `vendors: [{ id:'v-a', orderUnit:'case' }]`.
3. **Do not override `loadReorderSuggestions`, `loadLastOrderContext` or the other actions** with no-ops the way the spec 151 `seed()` does. This suite needs the real `loadFromSupabase`. PhoneOrdering has no effects of its own, so nothing else fires. Keep `currentUser: null`.

**Seed.** `currentStore {id:'store-1'}`, `reorderStoreId:'store-1'`, payload `P` (one vendor `v-a`, one line `a1`, `suggestedUnits > 0`, `asOfDate: DATE`), `reorderLoading:false`, `reorderError:null`.

| Case | Steps | Assert |
|---|---|---|
| R1 pending | render; `await act(() => loadFromSupabase('store-1'))` with `fetchReorderSuggestions` → `d.promise` | `fetchAllForStore` called with `'store-1'` and `fetchReorderSuggestions` called with `('store-1', DATE)` (anti-vacuity); `phone-order-card-v-a` and `phone-order-line-a1` present; `phone-order-kpi` matches `/1 VENDORS · 1 LINES/`; `phone-order-empty` and `phone-order-loading` absent |
| R2 resolved | continue: `await act(async () => { d.resolve(F); await flush(); })`, where `F` has two lines (`a1`, `a2`) | card and lines present; `phone-order-kpi` matches `/1 VENDORS · 2 LINES/`, which proves the fresh payload landed; empty and loading absent |
| R3 control (optional, recommended) | same, but seed `reorderStoreId: null` | after the reload, `phone-order-empty` **is** present. This proves the harness can detect the bug and that a store switch still clears. |

### 10. Regression gates (AC-20, AC-21)

**Why the existing suites stay green unmodified.** Every one of them seeds `reorderPayload` through `setState` without `reorderStoreId`, so the owner is `null`. The keep predicate is then false and the clear branch runs, exactly as today:
- the spec 151 store-switch test (L139-145);
- `useStore.switching.test.ts`, which seeds no payload;
- the spec 160 suite, whose `fetchAllForStore` is unchanged and which never seeds a payload.

The mocked-store section suites (`ReorderSection.recordExport.spec156`) do not run the real store.

`PhoneOrdering.*` and `PhoneApproveOrder.*` get comment-only edits or none, so they are unaffected.

Run the full `npx jest`, `npm run typecheck` and `npm run typecheck:test` (per project memory: `typecheck:test` is a CI gate jest misses).

### 11. Risks and tradeoffs

1. **A background RPC on every same-store reload while any payload is held.** This is new cost. The payload lives in the store after the user leaves Reorder (for example, visits Reorder, then goes to Inventory), so each realtime reload now fires one `report_reorder_list` even with no reorder surface mounted. It matches the existing posture of the `loadMenuCapacity` and `loadItemsLastCounted` tails, which already run on every reload. It is bounded by the 400 ms debounce, and N4 offsets it with one `report_last_order_context` RPC fewer per replay while the section is mounted. On the 286 KB seed, `report_reorder_list` is a single-store aggregate and the same cost the section already pays on mount.
   - **Accepted.** Gating on "is a reorder surface mounted" would need a new mount registry, which is out of scope.
   - **Follow-up if it shows in profiles:** null the payload when the section unmounts.
2. **TopProgressBar.** The silent fetch still goes through `useInflight.track`, so the global progress bar stays lit for the extra round-trip after a reload. That is chrome, not the list, so AC-22's "no loading flicker" (which is about the list) holds. Mention it during the browser check so it isn't mistaken for a regression.
3. **The stale window** (accepted by the owner). Between the reload and the silent result, the pre-reload list is shown. If the silent refresh fails, it stays stale with no indicator until the next reload (AC-7).
4. **Cross-store leak (the main review item).** Clearing still happens on every switch. It now also happens on a stale reload for a no-longer-current store (the `currentStore` term in §6.3). The silent path drops on a store change (AC-8). `reorderStoreId` records the issuing store, not the store at completion (R2). The pre-existing foreground cross-store race stays out of scope, as the spec says.
5. **The R1 redundant silent refresh.** When B's foreground load beats `loadFromSupabase(B)`'s `set`, the switch is treated as a same-store keep and one redundant RPC goes out. The result is correct and the cost is one RPC per switch at most.
6. **Silent-refresh starvation under continuous churn.** It converges once churn stops (§6.4). It is no worse than today, where the list was simply blank.
7. **Edge cold start, migration ordering, RLS gaps:** not applicable.
8. **Deploy.** Client-only. After the push, confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` manually (per project memory).

### 12. Files to change

- `src/store/useStore.ts`:
  - L2: add the `StoreApi` type import;
  - ~L222: add the counter and `startSilentReorderRefresh`;
  - ~L193: comment;
  - ~L1066-1075: JSDoc;
  - ~L1191: reset;
  - ~L1309-1316: initial value and comment;
  - ~L2100-2177: keep predicate, conditional spread, comment, silent tail;
  - ~L3578-3585, ~L3808-3813, ~L3877-3880: comments;
  - ~L4538-4555: generation bump, `reorderStoreId` write, comment.
- `src/types/index.ts` ~L741-749: the `reorderStoreId` field and doc, and the corrected `reorderPayload` doc.
- `src/screens/cmd/sections/ReorderSection.tsx`: comments only (§8.1 #9-#12).
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx`: comment only (§8.1 #13).
- New: `src/store/useStore.reorderReload.spec175.test.ts`, `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx`.
- Not touched: `PhoneApproveOrder.tsx`, `src/lib/db.ts`, every existing test file, `supabase/**`, `app.json`.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec (§6 store changes in src/store/useStore.ts, §6.1 type in src/types/index.ts, §8.1 comment-only edits, §9 two new jest suites). No backend, migration, db.ts, or edge-function work. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/175-reorder-survives-reload.md

## Files changed

Frontend-developer, 2026-10-23. Built per the Backend design above (§6, §6.1, §8.1, §9).

- `src/store/useStore.ts`:
  - `StoreApi` type import;
  - module-level `reorderRequestGen` and private `startSilentReorderRefresh`, placed after `recordingKeys`;
  - `reorderStoreId` in `SIGNED_OUT_DATA_RESET` and in the initial state;
  - in the single-store `loadFromSupabase`: the keep-or-clear predicate, the conditional spread, and the silent-refresh tail;
  - in `loadReorderSuggestions`: the generation bump and the `reorderStoreId` write;
  - §8.1 comments #1-#7;
  - fix round 1: the A′ keep-or-clear rule and silent-refresh gate in `loadFromSupabase`, and the store-change drop guard in `loadLastOrderContext`.
- `src/types/index.ts`: the `reorderStoreId: string | null` field and its doc, plus the corrected `reorderPayload` doc (§8.1 #8).
- `src/screens/cmd/sections/ReorderSection.tsx`: comment changes only (§8.1 #9-#12).
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx`: one comment change only (§8.1 #13).
- `src/store/useStore.reorderReload.spec175.test.ts`: new store suite (§9.1, T1-T16, plus 3 fix-round-1 cases; 21 tests).
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx`: new phone suite (§9.2, 2 tests: R1 and R2 combined, plus the R3 control).
- `src/store/useStore.lastOrderContextGuard.spec175.test.ts`: new in fix round 1 (3 tests for the `loadLastOrderContext` store-change guard).

Implementation notes (none of these change the design):
- **Silent-tail guard.** The tail is guarded with `if (keepReorder && pre.reorderPayload)` rather than `pre.reorderPayload!`. Behavior is the same, and it avoids a non-null assertion.
- **T7 (AC-7) unhandled-rejection check.** I dropped the design's `process.on('unhandledRejection', spy)`. A probe showed the spy is never called in this jest setup, because jest catches the rejection first and fails the running test. So the spy assertion would have been vacuous, and jest's own fail-on-unhandled-rejection is the real guard. The `console.warn('[Supabase] silent reorder refresh:', 'x')` assertion proves the refresh's `.catch` handled the failure. "No toast" is asserted on `Toast.show`, which is what `notifyBackendError` calls.
- **Phone suite `flush()`.** It uses `setTimeout(0)` because jsdom has no `setImmediate`.
- **AC-19 fixture.** The `fetchAllForStore` stub returns an `orderSchedule` that covers `v-a`, as §9.2 requires.

## Fix round 1

Frontend-developer, 2026-10-23. Requested from `reviews/release-proposal.md` steps 1-3. Status stays READY_FOR_REVIEW.

### Fix 2 (security L1 / code-reviewer SF-2): done

- `loadLastOrderContext` now drops its result when `get().currentStore?.id !== storeId` at settle time. This applies on success **and** on failure, so a late store-A read can neither overwrite nor null store B's context.
- The R1 note in `loadFromSupabase` now states the accepted window: on the R1 keep path, the previous store's context stays visible until the new store's `currentStore.id`-keyed context load lands (about one RPC round-trip). The new guard stops a late previous-store read from extending that window.
- New tests are in `src/store/useStore.lastOrderContextGuard.spec175.test.ts`:
  - a late A success does not overwrite B's context;
  - a late A failure does not null B's context;
  - a same-store control, where both success and failure still land.
- **Mutation check:** removing the success guard turns only the first test red. Removing the failure guard turns only the second test red.
- No existing spec 151 test depends on a late context landing after a store change. All three spec 151 suites pass unmodified.

### Fix 1 (code-reviewer SF-1): done, using rule A′ (the owner's decision)

**Why the proposal's literal rule was not used.** The proposal said: when `sid` is not the current store, write no reorder keys. That rule turns the **frozen** spec 151 store-switch test red (`useStore.lastOrderContext.spec151.test.ts`, "clears the context to NULL so no cross-store quantities leak"). That test's `beforeEach` sets `currentStore` to `store-1`, then calls `loadFromSupabase('store-2')` and expects `lastOrderContext` to be `null`. AC-20 requires the test to stay unmodified, so the literal rule and AC-20 cannot both hold. An experiment confirmed it:

| Variant | Race test | Spec 151 store-switch (frozen) |
|---|---|---|
| Pre-fix-round predicate | red (the SF-1 bug) | green |
| Proposal's literal rule (clear only when `isCurrent && !kept`) | green | **red** |
| **A′ (chosen)** | green | green |

**The owner chose A′ (2026-10-23).** It meets the approved intent, "a stale reload must not blank the current store's list", and it leaves the frozen test alone. The rule keys on the **current** store, not on `sid`:
- **Keep** all five reorder fields iff `before.reorderPayload` is truthy and `before.reorderStoreId === before.currentStore?.id`.
- **Otherwise clear**, using today's spec 021 / spec 151 nulls plus `reorderStoreId: null`.
- **Silent refresh** only when the payload is kept and `sid === before.currentStore?.id`. A stale reload never issues one.

A′ differs from the proposal in one case. Suppose the current store is B but the payload belongs to S, and a reload for S (no longer current) runs. A′ **clears** that payload instead of keeping it under B. This is the safer outcome, because it removes a foreign-owned payload from under the current store.

**Code** (`src/store/useStore.ts`, single-store `loadFromSupabase`):
- `before = get()`, `currentId = before.currentStore?.id`;
- `keptReorder` = the payload if it is truthy and owned by `currentId`, otherwise `null`;
- `silentRefreshFrom` = `keptReorder` if `sid === currentId`, otherwise `null`;
- the clear spread is gated on `keptReorder`, and the tail is gated on `silentRefreshFrom`;
- the keep-or-clear comment is rewritten to state the current-store keying, the stale-reload case, the foreign-owner removal, and the R1 context window;
- `pre` is renamed to `before`, which also folds in the `!== null` versus truthy nit.

**Tests** (`src/store/useStore.reorderReload.spec175.test.ts`, describe "fix round 1"):
- **Race:**
  1. Start `loadFromSupabase('A')` with a deferred `fetchAllForStore`.
  2. Switch to B. B's foreground `loadReorderSuggestions` lands `PB`.
  3. Resolve A's fetch.
  4. Assert: `reorderPayload` is `PB` (same reference), the owner is `'B'`, `lastOrderContext` is unchanged, and there is exactly one `fetchReorderSuggestions` call (the foreground one).
- **Stale reload with the payload owned by the current store:** current B, owner B, `loadFromSupabase('A')`. All five fields are unchanged, `PB` is kept by reference, and there is **no** silent fetch. This pins the `sid === current` condition on the tail.
- **Foreign owner removed:** current B, owner `'S'`, `loadFromSupabase('S')`. The payload, owner and `lastOrderContext` become `null`, loading is `false`, the error is `null`, and there is no reorder fetch.

**Mutation check.** `useStore.ts` was restored after each run and confirmed byte-identical with `cmp`.

| Mutation | Tests that go red |
|---|---|
| Keep keyed on `sid` instead of the current store | all 3 new cases |
| Tail without `sid === current` | race, stale-kept |
| Pre-fix-round predicate | race, stale-kept |
| Proposal's literal rule | foreign-owner removal, plus the frozen spec 151 test |
| Keep forced off | 14 of 23 across both spec 175 suites |

### Optional nits: done

- The silent-refresh guards now carry short "why" comments instead of bare `// AC-n` markers. The cheap generation check now runs before `get()`.
- "Never rejects" is reworded to "never produces an unhandled rejection", and the docblock states the assumption that the fetch returns a promise.
- The redundant AC-1 assertion is removed.
- The phone-suite cases are renamed to "pending → resolved" and "control (no owner tag)".

### Gates after fix round 1 (final)

- Full `npx jest`: 265 of 265 suites and 3309 of 3309 tests passed, 17 of 17 snapshots.
- `npm run typecheck` and `npm run typecheck:test`: exit 0.
- AC-17: the `git diff -U0 HEAD` non-comment filter on `ReorderSection.tsx` and `phone/PhoneOrdering.tsx` is empty.
- `PhoneApproveOrder.tsx`, `src/lib/db.ts`, `supabase/` and `app.json` are untouched.

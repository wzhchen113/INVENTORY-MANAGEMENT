## Security audit for spec 206

Scope: frontend-only. Reviewed `src/lib/inflight.ts` (diff), `src/lib/realtimeReloadScheduler.ts` (new), `src/hooks/useRealtimeReloadScheduler.ts` (new), `src/navigation/CmdNavigator.tsx` (diff), and the three test files. For context I also read `src/hooks/useRealtimeSync.ts`, `loadFromSupabase` (`src/store/useStore.ts:2180-2473`), `SIGNED_OUT_DATA_RESET` (`useStore.ts:1340`), the `AdminStack` mount gate (`CmdNavigator.tsx:148-172`) and every `kind: 'write'` `track()` site in `src/lib/db.ts`. Unrelated uncommitted files were ignored. The three spec 206 jest suites pass (49 tests).

There are no migrations, RLS or policy changes, edge functions, RPCs or secrets. Realtime payloads are still ignored (`notify()` takes no arguments), so the change exposes no new data.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `src/lib/inflight.ts:153-190` with `src/lib/db.ts:5956` (`uploadIngredientImage`, the `supabase.storage...upload` step), `src/lib/db.ts:1781` (`createPurchaseOrderDraft` orphan-header delete) and `src/lib/db.ts:1946` (`upsertVendorDraftOrder` orphan-header delete). These are write tracks containing a request that is not wired to `signal`.
  - **Why it matters:** the 30 s hard abort only aborts the controller. `await fn(ctrl.signal)` returns only when the thunk settles. A hung unwired request therefore keeps `_writeCount > 0` past 30 s. The spec's claim that the write count "drops on the 30 s hard abort" (R1) holds only for signal-wired requests.
  - **Impact:** before spec 206 this only kept the progress bar lit. Now it holds every realtime reload for the whole admin session, so other managers' edits stop appearing until the request settles at the network layer. Nothing is exposed and the user can still refresh manually. Still, a hung request can quietly stop live updates without any visible sign.
  - **Fix (optional, follow-up):** either chain `.abortSignal(signal)` onto the two orphan-cleanup deletes and accept the storage upload as bounded by its own transfer, or add a maximum hold ceiling in the scheduler (for example, start the debounce anyway once a hold reaches about `HARD_ABORT_MS`).
- `src/lib/inflight.ts:94-100`: `useInflight` is a module singleton, and logout does not reset it. Suppose user A logs out while a write is in flight, and user B signs in within the same JS runtime. B's new scheduler sees `hasWriteInflight === true` and holds B's first realtime reloads until A's write settles. The hold is bounded by the abort for signal-wired writes. No data crosses identities: A's request carries A's token, and B's eventual reload reads B's `currentStore` through B's session. This only delays updates. No fix is required; it is noted so nobody later treats `hasWriteInflight` as per-user state.

### Areas checked with no finding

- **Stale data from another store.**
  - `reloadCurrentStore` (`src/hooks/useRealtimeReloadScheduler.ts:21-25`) reads `currentStore.id` when the reload fires, not when the event arrives. A reload held across a store switch therefore reloads the store the user is now on, never the one they left.
  - A scheduler reload that is already running when the user switches stores is dropped by spec 176 R-3 (`sid !== get().currentStore?.id` before any slice write, `useStore.ts` after `fetchAllForStore`).
  - The `loadFromSupabaseGen` overlay reset is unchanged.
  - The single-flight follow-up (`realtimeReloadScheduler.ts:132-143`) also calls the same fire-time thunk.
- **Stale data from another user.**
  - Logout sets `currentUser` to null. `AdminStack` then swaps `AuthedRoot` for Login (`CmdNavigator.tsx:158-169`), which unmounts the hook. `dispose()` (`realtimeReloadScheduler.ts:182-190`) clears the timer, drops `pending` and `dirty`, and unsubscribes.
  - A reload that is already running settles into `onSettled`, which returns early on `disposed` (L134). No follow-up starts after logout.
  - Even if a thunk did fire, `SIGNED_OUT_DATA_RESET` (`useStore.ts:1340-1341`) resets `currentStore.id` to `''`, so `reloadCurrentStore` resolves without loading.
  - A remount creates a fresh scheduler inside the effect (`useRealtimeReloadScheduler.ts:43-54`). State is never shared across mounts.
  - A load already in flight at logout is not cancelled. That matches the behaviour before this spec and is still covered by R-3.
- **Session loss (spec 152).** Held or deferred reloads still go through `loadFromSupabase`'s session probe. A dead session still bails with the banner and does not blank the slices. The scheduler adds no fetch path that bypasses the probe.
- **Event spoofing and amplification.** The scheduler ignores payloads, and coalescing can only reduce reload volume. Cross-store `item_vendors` and cross-brand `ingredient_conversions` noise still triggers at most one reload, of the caller's own store, under their own RLS. That is unchanged and now strictly cheaper.
- **Client-side authorization.** No `useRole()` value or other client state is used as a security boundary.
- **Logging.** `defaultOnReloadError` (`realtimeReloadScheduler.ts:72-75`) `console.warn`s the error object only. `loadFromSupabase` catches everything itself, so in practice this never fires. No tokens or PII are logged.
- **Unhandled rejections.** Both settle branches are attached in one expression, and a throwing reporter is swallowed (`realtimeReloadScheduler.ts:106-129`).

### Dependencies
No `package.json` / `package-lock.json` changes, so I skipped `npm audit`.

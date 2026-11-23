# Spec 206: One realtime reload per edit, never two at once

Status: READY_FOR_REVIEW

Numbering: 206 comes from the 2026-11-23 slowness plan. That plan reserves 205 for the RLS once-per-query fix ("fix 1"), which is a separate spec with no dependency in either direction. No `205-*` or `206-*` file was on disk when this was written.

Origin: the 2026-11-23 read-only slowness investigation, finding 2 ("Every write echoes back as a full reload, and reloads overlap"). The owner approved this scope on 2026-11-23, so the open questions below are resolved. Line numbers are pointers, not contracts.

## User story

As a store manager editing inventory in the admin app, I want each save to trigger one background refresh, not several overlapping ones, so the app stays responsive while I work. I still want changes made by other managers to show up live.

## The problem (verified in the tree, 2026-11-23)

- **Every realtime event schedules a full reload.**
  - `useRealtimeSync` ([src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts) L32-73) calls `onSync` for every change on the `store-{id}` channel (`inventory_items`, `item_vendors` (unfiltered), `waste_log`, `eod_submissions`, `purchase_orders`) and on the `brand-{id}` channel (`recipes`, `prep_recipes`, `catalog_ingredients`, `vendors`, `ingredient_conversions` (unfiltered)).
  - `onSync` is `handleSync` ([src/navigation/CmdNavigator.tsx](../src/navigation/CmdNavigator.tsx) L62-74). It is a trailing 400 ms debounce, and then it calls `useStore.getState().loadFromSupabase(currentStoreId)` without awaiting it.
- **A full reload is heavy.** `loadFromSupabase` ([src/store/useStore.ts](../src/store/useStore.ts) L2180-2473) runs:
  - the spec 152 session probe;
  - `fetchStores`;
  - `fetchAllForStore` ([src/lib/db.ts](../src/lib/db.ts) L6059), which is `fetchBrandForStore` and then 15 parallel reads. One of them is the unfiltered `fetchInventory()` keyset read (L297-341): a page with the `catalog:catalog_ingredients(...)` embed, then a terminating empty page;
  - fire-and-forget tails after the `set`: `loadMenuCapacity`, `loadItemsLastCounted` (`items_last_counted`, a 1-3 s RPC on prod), the spec 175 silent reorder refresh, and `fetchNotifications`.

  That is about 17 requests.
- **The acting client reloads on its own echo, several times per edit.**
  - `updateItem` (useStore.ts L2542-2594) fires `db.updateInventoryItem` (db.ts L487-651) and `addAuditEvent` (db.ts L2899-2910) concurrently. Each is one `track(..., { kind: 'write' })` call.
  - Inside that one tracked call, `updateInventoryItem` runs up to about 7 sequential requests: a catalog lookup, the catalog update, the per-store update, a vendor_id lookup, the demote, the link upsert and the link delete. Each write emits its own realtime event.
  - The sequence takes more than 400 ms, so the trailing debounce fires mid-sequence and again at the end. The result is 2-4 full reloads per edit.
- **Reloads overlap.** Nothing stops a second `loadFromSupabase` from starting while the first is still running. Spec 176's generation counter only drops a stale load's results and overlay reset. It does not cancel the requests, so the database serves every overlapping load in full.
- **Prod evidence.** Edge logs for the 2026-11-23 18:00-18:08 editing session show up to 8 inventory reads per 10 s window, p50 latency of 2-12 s and a maximum of 26 s. Part of that is the per-row RLS cost (spec 205's subject). Stacking makes it worse.
- **The signal this spec needs already exists.** Every admin-surface write in `db.ts` goes through `useInflight.getState().track(fn, { kind: 'write', ... })` ([src/lib/inflight.ts](../src/lib/inflight.ts)). That gives about 90 `kind: 'write'` call sites. `inflight.ts` counts all in-flight calls (`_activeCount` / `hasInflight`) but does not count writes separately.

## Requirements

- **R1. Write counter in `inflight.ts`.**
  - Add an in-flight count of `kind: 'write'` `track()` calls, plus a derived boolean (for example `_writeCount` / `hasWriteInflight`; the architect names them).
  - The count goes up on entry and down in the same `finally` that decrements `_activeCount`. So it drops on success, on error and on the 30 s hard abort.
  - Every existing field, selector, timer and error behaviour stays exactly as it is: `hasInflight`, `hasSlow`, `_activeCount`, `_slowCount`, `InflightTimeoutError`, `SLOW_WARNING_MS` and `HARD_ABORT_MS`.
  - `kind: 'read'` calls never touch the new counter.
- **R2. A pure reload scheduler module.**
  - It is a new module under `src/lib/` (the architect names it). It has no React, no Supabase and no `useStore` import.
  - Its inputs are:
    - a "writes in flight?" source it can read and be notified about (backed by R1);
    - a `reload(): Promise<void>` thunk;
    - the debounce delay (400 ms in production);
    - the timer functions, so jest fake timers drive it.
  - It exposes:
    - a "realtime event arrived" entry point;
    - a dispose / teardown.
  - The architect defines the exact signature.
- **R3. Write-aware.**
  - A realtime event that arrives while this client has at least one write in flight is held. No timer runs and no reload starts while writes are in flight.
  - When the write count drops to 0 and at least one event is held, the scheduler starts the debounce. When the debounce expires, it runs exactly one reload.
  - The drain must be noticed without needing another realtime event to arrive (for example by subscribing to the inflight store).
  - If a new write starts during that post-drain debounce, the reload is held again until writes drain again. This is how the separate `addAuditEvent` write and any immediate follow-up save fold into the same single reload.
  - More events during the hold or the debounce do not add reloads. Events during the debounce restart it (trailing debounce, as today).
- **R4. Single-flight.**
  - At most one scheduler-started reload runs at a time.
  - If the debounce expires, or an event is ready to fire, while a scheduler reload is running, the scheduler marks itself dirty and starts nothing.
  - When the running reload settles, on resolve **or** reject, a dirty flag triggers exactly one more reload. Any number of events while running collapse into that one follow-up.
  - The follow-up still obeys R3: if writes are in flight when the running reload settles, the follow-up is held until they drain, then debounced.
  - A rejected reload never leaves the scheduler stuck, never loses the dirty follow-up, and never produces an unhandled rejection.
- **R5. Other managers' changes: same as today.** An event that arrives while this client has no writes in flight and no reload running gives exactly one reload, 400 ms after the last event in the burst. This is today's trailing debounce.
- **R6. `handleSync` wiring.**
  - `AuthedRoot` in CmdNavigator.tsx creates one scheduler for the component's lifetime and replaces the inline `reloadTimerRef` debounce with it.
  - The reload thunk keeps today's behaviour: it reads `useStore.getState().currentStore?.id` at fire time, calls `loadFromSupabase(sid)` when it is set, and resolves without loading when it is not.
  - `handleSync` keeps a stable identity across renders (today it is `useCallback(..., [])`), so `useRealtimeSync` does not resubscribe its channels.
- **R7. Teardown.**
  - Unmounting `AuthedRoot` disposes the scheduler. That means:
    - pending debounce timers are cleared;
    - the inflight subscription is removed;
    - held events are discarded;
    - a reload already running is not cancelled, but when it settles it starts no follow-up.
  - After dispose, an event call is a no-op. This matches today's unmount `clearTimeout`, and it covers sign-out and the role-router swap.
- **R8. What counts as a reload "ending".** A reload ends when the `loadFromSupabase` promise settles. That includes its early returns: no store id, the spec 152 session-probe bail, and the spec 176 R-3 drop.
  - The fire-and-forget tails (`loadMenuCapacity`, `loadItemsLastCounted`, the silent reorder refresh and `fetchNotifications`) may still be running when the next reload starts. This spec does not change `loadFromSupabase` to await them (see Residual risk).
- **R9. Architect verification (record it in the design).**
  - **(a)** No call made by `loadFromSupabase` or its tails is tracked as `kind: 'write'`. If one were, a reload would hold its own follow-up.
  - **(b)** The admin item editor save reaches the server only through tracked writes (`updateInventoryItem`, `addAuditEvent`, and `applyItemVendorsToBrand` / `setItemPrimaryVendor` if the editor uses them). Untracked writes, such as the `auth.ts` / `webPush.ts` carve-outs and the staff subtree, are not counted. Their echoes behave as R5, which is acceptable.
  - **(c)** List the tests that call `useInflight.setState` with partial state (`LoadingBar.test.tsx`, `TitleBar.test.tsx`, `MobileTopAppBar.test.tsx`, `inflight.test.ts`) and confirm R1 needs no change to them.

## Acceptance criteria

### Unit tests (jest, fake timers)

Each AC is at least one jest case against the scheduler module, driven by fake timers, a controllable writes-in-flight source and a controllable `reload` mock that returns a deferred promise.

- [x] **AC-1 (R5, no local writes):**
  - One event with no writes in flight gives 0 reloads at 399 ms and exactly 1 at 400 ms.
  - A burst of events 100 ms apart gives exactly 1 reload, 400 ms after the last event.
- [x] **AC-2 (R3, held while writing):**
  - With writes in flight, events at t = 0, 300, 900 and 1500 ms give 0 reloads, even after advancing time well past 400 ms (for example to 5 s).
  - When writes drop to 0, there are still 0 reloads at +399 ms and exactly 1 at +400 ms.
- [x] **AC-3 (R3, re-hold):**
  - Writes drain, then a new write starts 200 ms into the post-drain debounce. Advancing 1 s more gives 0 reloads.
  - When that write drains, exactly 1 reload runs 400 ms later. The total is 1.
- [x] **AC-4 (R3, drain with nothing held):** writes going from 1 to 0 with no event held gives 0 reloads.
- [x] **AC-5 (R4, single-flight):**
  - While a reload's promise is pending, 3 more events (no writes) and advancing past 400 ms start no second reload. At most 1 call is in flight at any moment.
  - When the first reload resolves, exactly 1 follow-up reload starts. After it resolves with no further events, there are no more reloads. The total is 2.
- [x] **AC-6 (R4, failure):** the same as AC-5, but the first reload rejects.
  - The dirty follow-up still runs exactly once.
  - The scheduler accepts and handles later events normally (one more event later gives one more reload).
  - No unhandled rejection is raised. The test asserts this, for example with a `process.on('unhandledRejection')` spy or the jest equivalent.
- [x] **AC-7 (R4 + R3):** a reload is running and an event marks it dirty. A write is in flight when the reload settles. The follow-up is held until the write drains, then runs once 400 ms later.
- [x] **AC-8 (R4, no dirty):** a reload that settles with no events during its run starts no follow-up.
- [x] **AC-9 (R7, teardown):**
  - After dispose, pending timers are gone (`jest.getTimerCount()` is 0, or an equivalent check).
  - Advancing time gives 0 reloads.
  - A held event never fires after writes drain.
  - A reload running at dispose time that later settles starts no follow-up, even if it was dirty.
  - The inflight subscription is released.
- [x] **AC-10 (R1, write counter):** in `inflight.ts` tests:
  - a `kind: 'write'` track raises the write count / flag while pending and lowers it on resolve, on reject and on the 30 s hard abort;
  - a `kind: 'read'` track leaves it untouched;
  - two concurrent writes count 2, and the flag stays true until both settle;
  - the existing `hasInflight` / `hasSlow` assertions in `src/lib/inflight.test.ts` pass unchanged.
- [x] **AC-11 (R6 wiring):** one jest case, at whatever level the architect picks, that pins `handleSync`:
  - it feeds the scheduler, so the old inline `setTimeout` debounce is gone;
  - its identity is stable across re-renders;
  - unmount disposes the scheduler.

  If a render-level test of `AuthedRoot` is impractical, the architect may move the wiring into a small hook (for example `useRealtimeReloadScheduler`) and test that hook instead.

### Gates

- [x] **AC-12:** the full `npx jest` passes. Run the whole suite, not a subset.
- [x] **AC-13:** `npm run typecheck` and `npm run typecheck:test` pass.

### Browser verification (local stack)

- [x] **AC-14 (one reload per edit):**
  - **Setup:**
    - Local stack up (`npm run dev:db`), then `docker restart supabase_realtime_imr-inventory` so `item_vendors` events publish (the realtime publication gotcha).
    - Web app running under the preview config `expo-web`, signed in as `admin@local.test` / `password`.
  - **Steps:**
    1. Open the Inventory section and let the initial load finish.
    2. Clear the network log.
    3. Edit one inventory item in the desktop editor, changing one field such as par level, and save.
    4. Wait 5 s.
  - **Count reloads, not raw `inventory_items` GETs:**
    - Count the `GET /rest/v1/inventory_items` requests whose `select` contains the `catalog:catalog_ingredients(` embed and whose query has no `id=gt.` cursor. That is the first page of a full reload's inventory read, so there is one per `loadFromSupabase`. Cross-check against `GET /rest/v1/stores?...status=eq.active`, also one per reload.
    - Don't count raw `inventory_items` GETs. The save itself can issue `inventory_items` GETs (the `catalog_id` / `vendor_id` lookups), and each reload's keyset read adds an empty terminator page. A raw count would over-count.
  - **Expected:** exactly **1** reload after the save.
  - **Baseline:** record the same count on the pre-change build (expected 2-4) in the implementation notes.
  - **Item with vendor links:** repeat once with an edit that changes the item's vendor-link set (this runs the demote, upsert and delete path). Expected: exactly 1.
- [x] **AC-15 (another manager's change still arrives live):**
  - **Setup:** keep session A from AC-14 open. Open a second, independent session B: a separate browser profile or incognito context signed in to the local stack. The same local admin account is fine, because each session has its own inflight counter.
  - **Steps:** in B, edit a field on an item at the same store that A is viewing.
  - **Expected:**
    - A shows the new value without a manual refresh, within about 400 ms plus one load.
    - A performs exactly 1 reload by the AC-14 count.
- [x] **AC-16 (no overlap under rapid edits):**
  - **Steps:** in session A, save three edits to the same or different items within about 2 s.
  - **Expected:**
    - The network log never shows two reload first-page reads (the AC-14 marker) in flight at the same time.
    - The reload count is at most 2: one in flight plus one dirty follow-up.
    - The final values on screen match the server.
  - **Record:** the observed count in the implementation notes.

## In scope

- `src/lib/inflight.ts`: the R1 write counter and flag, with existing behaviour unchanged.
- One new pure scheduler module under `src/lib/` (R2-R5, R7, R8), plus its jest suite.
- The `handleSync` wiring in `src/navigation/CmdNavigator.tsx` (R6, R7). An optional thin hook is allowed if the architect wants one for testability (AC-11).
- New and extended jest tests (AC-1 to AC-11).
- The AC-14 to AC-16 browser checks, with counts recorded in the implementation notes.

## Out of scope (explicitly)

- **Any change to `loadFromSupabase`** (useStore.ts L2180-2473) or its spec 152 / 175 / 176 guards. That includes awaiting or de-duplicating its fire-and-forget tails, and narrowing `fetchInventory()` to the current store (slowness finding 3, a separate follow-up).
- **Store-switch and brand-switch loads** (`setCurrentStore`, `setBrand` and friends). They keep calling `loadFromSupabase` directly, outside the scheduler, and can still overlap a scheduler reload exactly as today. Spec 176 already makes that safe.
- **The explicit post-mutation reloads:**
  - `applyVendorsToAllStores` (useStore.ts L2611);
  - `stockStoreFromStore` (L3766);
  - `receivePurchaseOrder` (L4635).

  They stay as they are and are not routed through the scheduler. Removing or folding them in is slowness finding 5, a separate follow-up.
- **Realtime channel subscriptions** in `useRealtimeSync.ts`: same tables, filters and channel names. No publication change.
- **`useSubmissionNotifications`** and the section-local subscriptions (for example `InventoryCountSection`'s `inventory_counts` channel).
- **Patching slices from realtime payloads** instead of reloading. That is a later idea in finding 2, not approved here.
- **Ignoring self-echoes by event identity** (matching payloads to this client's writes). Not approved. R3's write-in-flight hold plus the post-drain debounce is the approved mechanism.
- **The RLS per-row cost** (spec 205), the serial `fetchStores` → `fetchBrandForStore` waterfall (finding 4) and the multi-step submits (finding 5).
- **The staff app** (`src/screens/staff/`). It doesn't use realtime in v1 (spec 062).
- **Any change to `app.json`.** It isn't touched.

## Open questions resolved

- Q: Should the fix skip this client's own echoes, collapse reloads, or both? → A: Both, using the write-aware hold (R3) plus single-flight with a dirty flag (R4). Owner, 2026-11-23.
- Q: How do other managers' changes behave? → A: As today: one reload after the 400 ms debounce (R5). Owner, 2026-11-23.
- Q: Should `loadFromSupabase`, store-switch loads, the realtime subscriptions or the explicit post-mutation reloads change? → A: No. The explicit reloads are a separate follow-up. Owner, 2026-11-23.
- Q: Is it acceptable that a long-running write delays other managers' updates on this client? → A: Yes. A write can stay in flight up to the 30 s inflight hard abort, and during that time realtime events from other managers are held on this client. They apply once the write settles. Owner, 2026-11-23.
- Q: Which test tracks? → A: Jest only (fake timers), plus the full jest and both typechecks, plus a manual browser check on the local stack. No pgTAP and no shell smoke: there is no database or edge-function change. Owner, 2026-11-23.

### PM interpretations within the approved scope (the architect may refine)

- **The browser metric is "reloads", not raw `inventory_items` GETs.** The brief said "exactly 1 inventory_items GET after the edit". In the tree, the save path itself issues `inventory_items` GETs (`updateInventoryItem`'s `catalog_id` / `vendor_id` lookups), and each reload's unfiltered keyset read issues two (a data page and an empty terminator page). AC-14 therefore counts reloads by a marker that appears once per `loadFromSupabase`. The owner's intent, one reload per edit instead of 2-4, is unchanged.
- **A write that starts during the post-drain debounce re-holds the reload (R3).** That follows from "events are held while writes are in flight". It also makes the separate `addAuditEvent` write and back-to-back saves fold into one reload.
- **"Ends" means the `loadFromSupabase` promise settles (R8).** Its fire-and-forget tails are not awaited, because `loadFromSupabase` is out of scope.

## Dependencies

- **Spec 055:** `inflight.ts` and the `track()` contract. Every admin write is tracked with a declared `kind`, which R1 relies on.
- **Spec 152 / 175 / 176:** the `loadFromSupabase` guards, which are unchanged. A spec 152 bail or a spec 176 drop still counts as the reload settling (R8).
- **Spec 102:** the `item_vendors` realtime subscription. It's needed for the vendor-link part of AC-14, and it is subject to the local realtime publication gotcha.
- No migration, edge function, new library or `package.json` change.
- Independent of spec 205; either can ship first.

## Project-specific notes

- **Cmd UI section / legacy:** no section changes. The change sits in the admin shell (`CmdNavigator.tsx` `AuthedRoot`) and `src/lib/`. It affects every Cmd UI section that reads store slices, through the reload cadence only.
- **Which app:** this repo, admin surface only. The staff stack is untouched.
- **Per-store or admin-global:** client-side and per session. The reload still targets the current store (`currentStore.id` at fire time). No change to `auth_can_see_store()` scoping or RLS.
- **Edge function or PostgREST:** neither. Client-side scheduling only.
- **Realtime channels touched:** `store-{id}` and `brand-{id}` are consumed unchanged (the same subscriptions, now feeding the scheduler). No publication change. The local realtime publication gotcha applies only to the AC-14 browser setup (`item_vendors`), not to any shipped change.
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Web/native scope:** both. `CmdNavigator` and `inflight.ts` are shared, and the scheduler is plain TypeScript with no platform APIs. Verification is on web (AC-14 to AC-16). No separate native check is required; native gets it with the next EAS build, and no build is triggered by this spec.
- **`app.json` slug:** not touched.
- **Tests:** jest track only (AC-1 to AC-11), plus the full jest and both typechecks (AC-12, AC-13).

## Residual risk

- **A long write delays other managers' updates on this client (accepted).** While any tracked write is in flight, up to the 30 s hard abort, realtime events from other clients are held. They apply in one reload after the write settles. Normal writes take well under a second.
- **Late self-echoes.** A realtime event can reach the client after the write's HTTP response, because realtime runs on its own WAL path.
  - The 400 ms post-drain debounce absorbs echoes that arrive within that window.
  - An echo that arrives after the reload has started marks it dirty and causes one extra reload. That would break AC-14 (the result would be 2 instead of 1).
  - If AC-14 shows this on the local stack, the developer stops and raises it with the owner. Don't invent a self-echo window or payload matching, which is out of scope.
- **The tails still overlap.** Single-flight covers the `loadFromSupabase` promise only. Its fire-and-forget tails (`items_last_counted` is the heaviest) from reload N can still be running when reload N+1 starts. This is less overlap than today, but not zero. A follow-up could fix it by changing `loadFromSupabase`, which is out of scope here.
- **Untracked writes aren't counted.** Writes outside `track()` (the documented carve-outs) echo as R5: one debounced reload, as today. Nothing gets worse.
- **Explicit reloads can still overlap.** The three explicit post-mutation reloads and store-switch loads bypass the scheduler, so they can still overlap a realtime reload, as today. They are the subject of the finding 5 follow-up.

## Commit (owner, later; not part of this spec's done state)

- **Commit:** stage only. Don't commit without the owner's explicit go-ahead.
- **After the push to `main`:** confirm `test.yml` and `db-migrations-applied.yml` are green, and check `e2e.yml` by hand.
- **Deploy:** web via Vercel on the push. No prod database step.

## Handoff
next_agent: backend-architect
prompt: Design the contract for spec 206 (one realtime reload per edit, single-flight).
  - Define the R1 write-counter fields in `inflight.ts`.
  - Define the scheduler module's name, signature and state machine (R2-R5, R7, R8), including how it learns that writes have drained.
  - Define the `handleSync` / `AuthedRoot` wiring (R6), with an optional hook for testability.
  - Record the R9 verifications.
  - Lay out the jest suites for AC-1 to AC-11 and the browser procedure for AC-14 to AC-16.
  - The owner's scope is fixed; don't widen it to `loadFromSupabase` or the explicit post-mutation reloads.
  - Then set Status: READY_FOR_BUILD.
payload_paths:
  - specs/206-realtime-reload-once-per-edit.md
  - src/lib/inflight.ts
  - src/navigation/CmdNavigator.tsx
  - src/hooks/useRealtimeSync.ts

## Backend design

Architect, 2026-11-23. Frontend-only. Scope is exactly the owner-approved scope above; nothing here touches `loadFromSupabase`, the explicit post-mutation reloads, store or brand switch loads, the realtime subscriptions or any server object. Line numbers are pointers, verified against the tree on 2026-11-23.

### 0. Summary of files

| File | Change |
|---|---|
| `src/lib/inflight.ts` | R1: two new state fields, one new selector, two-line additions inside the existing entry and `finally` `set` calls. |
| `src/lib/realtimeReloadScheduler.ts` | **New.** Pure scheduler (R2-R5, R7, R8). No React, Supabase, `useStore` or `inflight` import. |
| `src/hooks/useRealtimeReloadScheduler.ts` | **New.** Thin hook: builds one scheduler per mount, adapts `useInflight` to the scheduler's write source, returns the stable `handleSync`. Also exports the `reloadCurrentStore` thunk (R6). |
| `src/navigation/CmdNavigator.tsx` | `AuthedRoot` (L58-86): replace `reloadTimerRef` + inline `handleSync` + unmount effect (L62-74) with one hook call. |
| `src/lib/inflight.test.ts` | AC-10 cases appended; `resetStore()` extended with the two new keys. |
| `src/lib/realtimeReloadScheduler.test.ts` | **New.** AC-1 to AC-9. |
| `src/hooks/useRealtimeReloadScheduler.test.ts` | **New.** AC-11. |

No change to `src/hooks/useRealtimeSync.ts`, `src/store/useStore.ts`, `src/lib/db.ts` or `app.json`.

### 1. Data model changes

None. No migration. No `supabase_realtime` publication change, so the publication gotcha applies only to the AC-14 local setup (`docker restart supabase_realtime_imr-inventory` after `npm run dev:db`, so `item_vendors` events publish). It is a dev/verification step, not a shipped change.

### 2. RLS impact

None. No table, policy or helper is touched. Reloads still read through the same PostgREST calls under the same `auth_can_see_store()` / `auth_is_admin()` policies.

### 3. API contract (client-internal module contracts)

No PostgREST or RPC change. The contracts below are TypeScript module boundaries.

#### 3.1 R1: write counter in `src/lib/inflight.ts`

New fields on `InflightState` (L30-40), next to the existing ones:

```ts
/** True iff `_writeCount > 0`. Spec 206: the realtime reload scheduler's hold signal. */
hasWriteInflight: boolean;
/** Internal: number of in-flight `track()` calls declared `kind: 'write'`. */
_writeCount: number;
```

Initial values: `hasWriteInflight: false`, `_writeCount: 0`.

New selector, next to L171-172:

```ts
export const selectHasWriteInflight = (s: InflightState) => s.hasWriteInflight;
```

Behaviour inside `track()`:

- Capture `const isWrite = opts.kind === 'write';` at the top of `track`.
- **Entry** (the existing atomic `set` at L102-105): when `isWrite`, the same `set` also writes `_writeCount: s._writeCount + 1, hasWriteInflight: true`. When not `isWrite`, the patch is byte-for-byte today's (`_activeCount` / `hasInflight` only). One `set`, so the active and write counters flip in the same notification.
- **Exit** (the existing `finally` `set` at L153-162): when `isWrite`, the same returned object also carries `_writeCount: nextWrite, hasWriteInflight: nextWrite > 0` with `nextWrite = s._writeCount - 1`. When not `isWrite`, the returned object is today's.
- Because the decrement sits in the same `finally` as `_activeCount`, it fires on resolve, on a non-abort reject (L149) and on the hard-abort path (L138-147, which throws `InflightTimeoutError` from inside the `try`, so `finally` runs).
- `kind: 'read'` never includes the write keys in either patch, so it never touches them.
- Unchanged: `hasInflight`, `hasSlow`, `_activeCount`, `_slowCount`, both timers, `InflightTimeoutError`, `SLOW_WARNING_MS`, `HARD_ABORT_MS`, `selectHasInflight`, `selectHasSlow`, the abort-detection branch and the dev `console.warn`.
- Timing property the scheduler relies on: `track` is an `async` function, so its first `set` runs synchronously when called. Every `db.*` write helper calls `track` synchronously at its start (for example `updateInventoryItem` L507, after the L505 id guard), so `hasWriteInflight` is already `true` when the store action returns. There is no window where a write has been issued but is not yet counted.
- Do not clamp. Mirror the existing un-clamped `_activeCount` arithmetic.

Update the file header's "Public surface" list (L16-21) to name `selectHasWriteInflight` and the spec 206 purpose of the write counter.

#### 3.2 R2: scheduler module `src/lib/realtimeReloadScheduler.ts`

Exported surface (signatures only):

```ts
/** Production debounce. Same value as the pre-spec-206 inline debounce. */
export const REALTIME_RELOAD_DEBOUNCE_MS = 400;

/** "Writes in flight?" source. Backed by R1 in production, a fake in tests. */
export interface WriteInflightSource {
  /** Current value: true iff ≥1 tracked write is in flight. Read synchronously. */
  isWriting(): boolean;
  /**
   * Register a change callback. The callback takes no args; the scheduler
   * re-reads `isWriting()` when called. Duplicate or non-edge calls are allowed
   * and must be harmless. Returns the unsubscribe function.
   */
  subscribe(onChange: () => void): () => void;
}

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface RealtimeReloadSchedulerOptions {
  reload: () => Promise<void>;
  writes: WriteInflightSource;
  delayMs: number;
  /** Defaults to wrappers that look up the global setTimeout/clearTimeout AT CALL TIME. */
  timers?: SchedulerTimers;
  /** Called when `reload` rejects or throws synchronously. Default: console.warn. */
  onReloadError?: (e: unknown) => void;
}

export interface RealtimeReloadScheduler {
  /** A realtime event arrived. Takes no args (realtime payloads are ignored). */
  notify(): void;
  /** Teardown (R7). Idempotent. */
  dispose(): void;
}

export function createRealtimeReloadScheduler(
  opts: RealtimeReloadSchedulerOptions,
): RealtimeReloadScheduler;
```

Notes on the signature:

- The default `timers` must look the globals up lazily (`(fn, ms) => setTimeout(fn, ms)`), not capture `setTimeout` at module load. jest modern fake timers replace the globals after import, and a captured reference would be the real timer. That would break `jest.getTimerCount()` in AC-9.
- `createRealtimeReloadScheduler` calls `writes.subscribe(onWritesChanged)` once, at creation, and keeps the unsubscribe for `dispose`.
- It is a factory with closure state, not a class. That matches the repo's preference for plain functions in `src/lib/`.

**How the drain is learned: subscribe, not polling.**

The scheduler subscribes to the write source. The production adapter (section 3.3) is a `useInflight.subscribe` listener. Reasons:

1. R3 says "no timer runs while writes are in flight". A poll interval is a timer that runs while writes are in flight, which breaks R3 literally. It would also leave a live timer that AC-9's `jest.getTimerCount() === 0` would count.
2. A subscription notices the drain at once, inside the very `finally` `set` that drops the count. A poll adds up to one interval of latency on top of the 400 ms.
3. There is no idle wake-up cost. Zustand v4.5's vanilla `subscribe(listener)` (`(state, prev) => void`) is available on the `create()` hook without middleware; `subscribeWithSelector` is not needed.

#### 3.3 State machine (R3, R4, R5, R7, R8)

Closure variables:

| Var | Meaning |
|---|---|
| `pending: boolean` | ≥1 realtime event arrived that no reload has started for yet. |
| `timer: handle \| null` | The armed debounce timer. |
| `running: boolean` | A scheduler-started `reload()` promise is unsettled. |
| `dirty: boolean` | The debounce completed while `running`; a follow-up is due when it settles. |
| `disposed: boolean` | `dispose()` was called. |

Invariants (the developer should keep these true after every handler; the tests probe them):

- **I1.** `timer !== null` ⇒ `pending && !isWriting() && !dirty && !disposed`.
- **I2.** `dirty` ⇒ `running && pending && timer === null`.
- **I3.** At most one scheduler reload is unsettled (`running` guards every start).
- **I4.** `disposed` ⇒ `timer === null && !pending && !dirty` and the write subscription is released.

Handlers (pseudocode, not committed code):

```
arm():            clear(timer); timer = timers.setTimeout(onTimer, delayMs)
clear(timer):     if timer !== null: timers.clearTimeout(timer); timer = null

notify():                                   // realtime event (N)
  if disposed: return
  pending = true
  if dirty: return                          // R4: already queued; collapse
  if writes.isWriting(): clear(timer); return   // R3: hold
  arm()                                     // R5 trailing debounce; also runs while `running`

onWritesChanged():                          // W↑ / W↓ (may be spurious)
  if disposed: return
  if writes.isWriting():                    // W↑: (re)hold
    clear(timer); dirty = false; return     // pending is kept
  if pending && timer === null && !dirty:   // W↓ with something held
    arm()                                   // post-drain debounce
  // else: nothing held, or a debounce is already armed (don't restart it on
  // non-edge notifications), or a follow-up is already queued.

onTimer():                                  // T
  timer = null
  if disposed: return
  if writes.isWriting(): return             // defensive (I1); the drain re-arms
  if running: dirty = true; return          // R4 single-flight
  startReload()

startReload():
  pending = false; dirty = false; running = true   // set state BEFORE calling reload
  let p
  try { p = opts.reload() } catch (e) { p = Promise.reject(e) }
  p.then(onSettled, (e) => { safeReport(e); onSettled() })

onSettled():                                // S (resolve OR reject; R8)
  running = false
  if disposed: return                       // R7: no follow-up after dispose
  if dirty:
    if writes.isWriting(): dirty = false; return   // defensive; held, drain re-arms (pending kept)
    startReload()                           // R4 dirty follow-up, immediately

dispose():                                  // D
  if disposed: return
  disposed = true
  clear(timer); pending = false; dirty = false
  unsubscribe()
  // a running reload is not cancelled; its onSettled sees `disposed` and stops
```

`safeReport` calls `onReloadError` inside its own try/catch, so a throwing reporter can't turn into an unhandled rejection. The rejection branch is attached in the same expression that receives `p`, so no rejection is ever unobserved.

Why each handler does what it does:

- **R3 hold.** `notify` while writing sets `pending` and arms nothing. A write starting (`W↑`) clears any armed debounce and any `dirty`, so "a write starting resets debounce progress" is the single rule. It covers both the post-drain re-hold (AC-3) and AC-7.
- **R3 drain.** `W↓` arms the 400 ms debounce only when something is held. With nothing held (AC-4) nothing happens. A spurious non-edge notification while a debounce is already armed does not restart it, so unrelated inflight activity can't push the reload out.
- **R5.** With no writes and nothing running, `notify` → `arm()` → 400 ms → `startReload()`. A burst restarts the timer each time (trailing), exactly as the old inline debounce did.
- **R4 single-flight.** The debounce keeps running during a reload. When it expires while `running`, the scheduler sets `dirty` and starts nothing. On settle, `dirty` starts exactly one follow-up **immediately**, because the 400 ms quiet period has already elapsed. An event that arrives less than 400 ms before settle is not yet `dirty`. Its timer fires after settle and starts the reload normally. Either way it is one follow-up. Further events while `dirty` collapse (`notify` returns early).
- **R4 + R3 (AC-7).** If a write starts while `dirty`, `W↑` demotes it back to held (`dirty = false`, `pending` kept). Settle then starts nothing, and the drain arms a fresh 400 ms debounce.
- **R4 failure (AC-6).** `onSettled` runs on both branches, so a rejected reload clears `running` and still honours `dirty`. The error goes to `onReloadError` (default `console.warn('[realtimeReload] reload failed:', e)`). In production `loadFromSupabase` already catches internally (useStore.ts L2453-2456), so this is defense in depth.
- **R7 teardown.** `dispose` clears the timer, drops held state and unsubscribes. A running reload's `onSettled` returns at the `disposed` check, so no follow-up. `notify` and `onWritesChanged` after dispose are no-ops.
- **R8.** "Ends" means the `reload()` promise settles. `loadFromSupabase`'s early returns (no sid, the spec 152 bail at L2214-2231, the spec 176 R-3 drops at L2264 and L2305) all resolve the promise, so they settle normally. Its fire-and-forget tails (L2426, L2430, L2435, L2442) are not awaited and are not tracked as writes (R9a), so they neither extend `running` nor hold.

Transition summary (S = state before the event):

| Event | `!running` | `running` |
|---|---|---|
| N, not writing | `pending`; (re)arm debounce | `pending`; (re)arm debounce, unless `dirty` (no-op) |
| N, writing | `pending`; held, no timer | `pending`; held, no timer |
| W↑ | clear timer (held if `pending`) | clear timer; `dirty → false` (held) |
| W↓, `pending`, no timer, not `dirty` | arm debounce | arm debounce |
| W↓, otherwise | no-op | no-op |
| T | start reload | `dirty = true` |
| S (resolve/reject) | n/a | `running = false`; if `dirty` → start follow-up now |
| D | clear everything, unsubscribe | same; the running reload settles into a no-op |

#### 3.4 R6: hook `src/hooks/useRealtimeReloadScheduler.ts` and `AuthedRoot` wiring

Exports:

```ts
/** R6 thunk: reads the current store at FIRE time; no store → resolve without loading. */
export function reloadCurrentStore(): Promise<void>;

/** Adapts the R1 counter to the scheduler's WriteInflightSource. */
export const inflightWriteSource: WriteInflightSource;

/** One scheduler per mount. Returns a callback whose identity is stable for the mount's lifetime. */
export function useRealtimeReloadScheduler(): () => void;
```

- `reloadCurrentStore` is today's L68-69 behaviour, made awaitable. It reads `const sid = useStore.getState().currentStore?.id`, returns `useStore.getState().loadFromSupabase(sid)` when `sid` is truthy, and otherwise returns `Promise.resolve()`. The `{ id: '' }` placeholder is falsy, as today.
- `inflightWriteSource`:
  - `isWriting` reads `useInflight.getState().hasWriteInflight`.
  - `subscribe(cb)` returns `useInflight.subscribe((s, prev) => { if (s.hasWriteInflight !== prev.hasWriteInflight) cb(); })`.
  - The edge filter means read-track churn (every reload's 15+ reads) and 2→1 write-count changes never call the scheduler. The scheduler is robust to non-edge calls anyway (section 3.3).
- `useRealtimeReloadScheduler`:
  - `const schedulerRef = useRef<RealtimeReloadScheduler | null>(null)`.
  - One `useEffect(() => { const s = createRealtimeReloadScheduler({ reload: reloadCurrentStore, writes: inflightWriteSource, delayMs: REALTIME_RELOAD_DEBOUNCE_MS }); schedulerRef.current = s; return () => { s.dispose(); if (schedulerRef.current === s) schedulerRef.current = null; }; }, [])`.
  - It returns `useCallback(() => { schedulerRef.current?.notify(); }, [])`.
  - **Create the scheduler inside the effect, not in `useRef` / `useMemo` at render time.** The app is not under `<StrictMode>` today (no match in the tree), but a render-time instance disposed by a StrictMode double-effect would be reused dead, and every later event would be silently dropped. Creating it in the effect makes mount → unmount → mount produce a fresh live instance.
  - A realtime event that arrived before the effect ran would hit a `null` ref and be dropped. That can't happen in practice: channels subscribe in `useRealtimeSync`'s effect, which runs after this one (rule below), and events arrive asynchronously over the socket.

`AuthedRoot` (CmdNavigator.tsx L58-86) becomes:

- Delete L62-74: `reloadTimerRef`, the inline `handleSync`, and the unmount `clearTimeout` effect.
- Add `const handleSync = useRealtimeReloadScheduler();` **above** `useRealtimeSync(storeId, handleSync, brandId);`. Effects run in declaration order within a component, so the scheduler exists before the channels subscribe.
- `useRealtimeSync`'s effect deps are `[storeId, brandId, onSync]`. `handleSync` is stable, so only store or brand changes resubscribe, exactly as today.
- Drop `useRef` from the React import on L1 if it becomes unused. `useEffect` and `useCallback` are still used by `CmdPaletteHost`.
- Unmount (sign-out, the role-router swap, `storeGate` leaving `'ready'`) runs the hook's cleanup, which is `dispose()`. That replaces today's L72-74 `clearTimeout`.
- The scheduler outlives store switches by design. A held or dirty event from the old store fires `reloadCurrentStore`, which reads the new store id at fire time. Same as today's L68.

### 4. Edge function changes

None.

### 5. `src/lib/db.ts` surface

None. No new helper and no change to any existing helper. The scheduler consumes the `kind` already declared at the 91 `kind: 'write'` sites. Snake_case → camelCase mapping is untouched.

### 6. Realtime impact

- Same channels, tables and filters: `store-{id}` (inventory_items, item_vendors, waste_log, eod_submissions, purchase_orders) and `brand-{id}` (recipes, prep_recipes, catalog_ingredients, vendors, ingredient_conversions). Every event from both channels now flows `onSync` → `handleSync` → `scheduler.notify()` instead of the inline debounce.
- What changes is cadence only: self-echoes are held while this client's tracked writes are in flight, and scheduler reloads never overlap.
- No publication membership change. No `docker restart supabase_realtime_imr-inventory` is needed for the shipped change; it is needed only in the AC-14 setup for `item_vendors`.
- `useSubmissionNotifications` and section-local channels (for example `inventory_counts` in InventoryCountSection) are not routed through the scheduler.

### 7. Frontend store impact

- No `useStore.ts` slice changes. `loadFromSupabase` is called exactly as before, from a different caller.
- `useInflight` gains two fields (R1). No component subscribes to them except the hook's adapter. `LoadingBar` / `TitleBar` / `MobileTopAppBar` keep using `selectHasInflight` / `selectHasSlow`.
- The optimistic-then-revert + `notifyBackendError` pattern is unaffected. A scheduler reload failure is not user-facing (it was not before either: `loadFromSupabase` catches and `console.warn`s).

### 8. R9 verification (done by reading the tree, 2026-11-23)

**(a) Nothing on the `loadFromSupabase` path is tracked as `kind: 'write'`. Confirmed.** So a reload can never hold its own follow-up.

- Session probe: `hasActiveSession` via dynamic `import('../lib/auth')` (useStore.ts L2209-2210). It goes through `auth.ts`, not `track`, so it is not counted at all.
- `db.fetchStores` (useStore L2246): `kind: 'read'`, db.ts L86.
- `db.fetchAllForStore` (useStore L2297; db.ts L6059-6100): `fetchBrandForStore` (read, L5174), then 15 parallel reads. Each function's only `track` is `'read'`:
  - `fetchInventory` L316/L332
  - `fetchCatalogIngredients` L5871
  - `fetchRecipes` L796
  - `fetchPrepRecipes` L3825
  - `fetchVendors` L2286
  - `fetchWasteLog` L899
  - `fetchAuditLog` L2896
  - `fetchRecipeCategories` L4001
  - `fetchIngredientCategories` L4267
  - `fetchIngredientConversions` L4068
  - `fetchOrderSchedule` L6121
  - `fetchRecentEODSubmissions` L1195
  - `fetchRecentPurchaseOrders` L2204
  - `fetchPosRecipeAliases` L4330
  - `fetchSavedReports` L4463

  The `__all__` branch (L2254-2295) calls the same function per store.
- Tails:
  - `loadMenuCapacity` (L5122-5136) → `db.fetchMenuCapacity`, read, L5151.
  - `loadItemsLastCounted` (L5154-5176) → `db.fetchItemsLastCounted`, read, L1512.
  - `startSilentReorderRefresh` (L298-325) → `db.fetchReorderSuggestions`, read, L4743.
  - `db.fetchNotifications` (L2442) → read, L2348.
- No `'write'` label falls inside any of those function bodies (checked against the full `kind:` label list in db.ts).

**(b) The item editor save reaches the server only through tracked writes. Confirmed.** The desktop editor is `IngredientFormDrawer`. `handleSave`, edit mode, is IngredientFormDrawer.tsx L289-373:

- `updateItem(item.id, updates)` (L310) → useStore L2542-2594:
  - `db.updateInventoryItem` (L2576). This is one `track(..., { kind: 'write', label: 'updateInventoryItem' })` spanning db.ts L507-650. All up to 7 sequential requests run inside it: the catalog_id lookup, the catalog update, the per-store update, the vendor_id lookup, the demote, the upsert and the delete.
  - It is fired together with `get().addAuditEvent` (L2582) → useStore L4915-4917 → `db.addAuditEvent`, write, db.ts L2899-2910.
  - Both are called synchronously in the same tick, so the write count goes 0→2 before control returns to the drawer.
- Conditional, same tick:
  - `updateCatalogIngredient` (L323) → useStore L2799-2811 → `db.updateCatalogIngredient`, write, L5900.
  - `setCatalogI18nNames` (L332) → useStore L2986-3005 → `db.updateCatalogIngredientI18n`, write, L3684.
  - `applyScalarsToAllStores` (L352-353, store-scope fan-out) → useStore L2701 → `db.applyItemScalarsToBrand`, write, L735.

  All fold into the same hold.
- The editor does **not** call `applyItemVendorsToBrand` or `setItemPrimaryVendor` on Save:
  - `applyItemVendorsToBrand` (write, L695) is behind the separate "Apply vendors to all stores" button (L420-450 → useStore `applyVendorsToAllStores` L2602). That path also runs an explicit `loadFromSupabase`, which is out of scope.
  - `setItemPrimaryVendor` (write, L4858) is called only from useStore L2666, not from the editor.
  - **AC-14's vendor-link variant must use plain Save with a changed link set, not the Apply button.** The Apply button adds an explicit out-of-scope reload and would read as 2.
- Edge: `updateInventoryItem` returns before `track` for a temp id (`id.length < 10`, L505). That means no server write, no count and no echo. Harmless.

**(c) Tests that call `useInflight.setState` with partial state need no change.**

- The calls:
  - `src/components/cmd/LoadingBar.test.tsx` L46, 84, 93, 99, 107, 122
  - `src/components/cmd/MobileTopAppBar.test.tsx` L74, 91, 101
  - `src/components/cmd/TitleBar.test.tsx` L120, 137, 147
  - `src/lib/inflight.test.ts` L27 (`resetStore`) and L124
- None passes `replace = true`. Zustand v4 `setState` shallow-merges, so the new keys keep their initial `0` / `false`. None of those suites runs a `kind: 'write'` track that could leave them non-zero, and none of the components reads the new keys.
- In `inflight.test.ts`, the existing write tracks (L249-275 abort, L277-285 non-abort reject) settle, so `_writeCount` returns to 0 within each test. The new AC-10 cases still extend `resetStore()` with `_writeCount: 0, hasWriteInflight: false` so the suite does not depend on that. This is an additive edit to a helper; no existing assertion changes.
- The 20+ `db.*.test.ts` suites that `jest.mock('./inflight', …)` with a `getState: () => ({ track })` stub are unaffected. `db.ts` does not read the new fields, and those suites don't import the new hook.

### 9. Test design

All jest, all in the node `unit` project (`src/lib/**/*.test.ts`, `src/hooks/**/*.test.ts` per jest.config.js L84-88).

**Shared harness (scheduler suite):**

- `jest.useFakeTimers()` in `beforeEach` and `jest.useRealTimers()` in `afterEach`. Use the scheduler's **default** timers so `jest.getTimerCount()` sees them.
- `makeWrites()` fake source. It holds `let writing = false` and a `Set` of callbacks, and exposes `set(v)` (assign, then call every callback), `subscriberCount()` and the `source`.
- `reload = jest.fn(() => { const d = defer<void>(); calls.push(d); return d.promise; })`, using the same `defer` helper shape as inflight.test.ts L36-44.
- `flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }` for settle handlers. Fake timers don't drive microtasks.
- `onReloadError = jest.fn()` injected.

**`src/lib/realtimeReloadScheduler.test.ts`**

- AC-1 (R5):
  - (a) One `notify()`: 0 calls at 399 ms, 1 at 400 ms.
  - (b) Burst at t = 0, 100, 200, 300: 0 calls at 699 ms, 1 at 700 ms, still 1 at 5 s.
- AC-2 (R3 held): `set(true)`; `notify()` at 0, 300, 900, 1500; advance to 5 s → 0 calls, `getTimerCount() === 0`. Then `set(false)`: +399 → 0, +1 → 1.
- AC-3 (re-hold): held event → `set(false)` → +200 → `set(true)` → +1000 → 0 calls → `set(false)` → +399 → 0 → +1 → 1. Total 1.
- AC-4: `set(true)` → `set(false)` with no `notify()` → advance 5 s → 0 calls, `getTimerCount() === 0`.
- AC-5 (single-flight):
  - `notify()`, +400 → 1 call (pending).
  - `notify()` ×3, +1000 → still 1 call. Track "max concurrent" with a counter incremented on call and decremented on settle; assert ≤ 1.
  - Resolve #1, `flush()` → exactly 2 calls, with no timer advance (the immediate follow-up).
  - Resolve #2, `flush()`, +5 s → still 2.
- AC-6 (failure):
  - Same as AC-5, but reject #1 with `new Error('boom')`. After `flush()`: 2 calls and `onReloadError` called once with that error.
  - Resolve #2. Later `notify()` + 400 → 3 calls.
  - Unhandled-rejection assertion: in this case use `jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })`, register `const spy = jest.fn(); process.on('unhandledRejection', spy)`, and after the rejection `await new Promise((r) => setImmediate(r))` so Node gets a macrotask turn to emit the event. Then `expect(spy).not.toHaveBeenCalled()` and `process.off(...)` in `finally`.
  - Add a sibling case where `reload` **throws synchronously** once: same expectations (no throw out of the timer callback, `onReloadError` called, the scheduler still serves the next event).
- AC-7 (R4 + R3): `notify()` +400 → reload #1 running; `notify()` +400 (now `dirty`); `set(true)`; resolve #1, `flush()` → still 1 call; +5 s → 1; `set(false)` → +399 → 1 → +1 → 2.
- AC-8: `notify()` +400 → 1; resolve, `flush()`, +5 s → 1.
- AC-9 (teardown), four cases:
  - (a) `notify()` +200 → `dispose()` → `getTimerCount() === 0` → +5 s → 0 calls.
  - (b) `set(true)`, `notify()`, `dispose()`, `set(false)`, +5 s → 0 calls.
  - (c) Reload #1 running and `dirty` → `dispose()` → resolve, `flush()` → still 1 call, and no `onReloadError`. Also a rejecting variant → `onReloadError` may be called but there are no further calls and no unhandled rejection.
  - (d) `subscriberCount()` goes 1 → 0 on `dispose()`. `notify()` after dispose → `getTimerCount() === 0`. `dispose()` twice does not throw.
- Extra guards (cheap, pin the invariants):
  - (e) `notify()` while `dirty` does not create a timer (`getTimerCount() === 0` after the dirty mark plus another `notify()`).
  - (f) A spurious non-edge write callback (call the subscriber with `writing` still false) while a debounce is armed does not restart it: `notify()` at 0, spurious callback at 300 → reload at 400, not 700.
  - (g) Store-switch shape: the reload thunk reads state at fire time. Covered at hook level (AC-11 d).

**`src/lib/inflight.test.ts`** (append `describe('useInflight.track — write counter (spec 206)')`; AC-10)

1. A write track: `_writeCount 1`, `hasWriteInflight true` synchronously after the call. Resolve → `0` / `false`.
2. A write track rejects → `0` / `false`.
3. A write track hard-aborts (signal-honouring thunk, advance `HARD_ABORT_MS + 100`, catch `InflightTimeoutError`) → `0` / `false`. Silence `console.warn` as the existing abort describe does.
4. A read track pending: `_writeCount 0`, `hasWriteInflight false`, while `hasInflight` is true. Same after resolve.
5. Two concurrent writes → `2` / `true`. First resolves → `1` / `true`. Second → `0` / `false`.
6. Mixed: a write settles while a read is pending → `hasWriteInflight false`, `hasInflight true`.
7. `selectHasWriteInflight` mirrors the flag.

The existing cases stay byte-identical. `resetStore()` gains the two keys.

**`src/hooks/useRealtimeReloadScheduler.test.ts`** (AC-11)

- `jest.mock('../store/useStore', () => ({ useStore: { getState: () => mockStoreState } }))`, with `mockStoreState = { currentStore: { id: 's1' }, loadFromSupabase: jest.fn(() => mockDeferred.promise) }`. Use the `mock` prefix so the hoisted factory can reference it. This follows the established `jest.mock('../../store/useStore', …)` pattern (for example IngredientFormDrawer.storeScope.test.tsx).
- Use the **real** `useInflight`, reset per test with `setState` including the new keys. Use `renderHook` / `act` from `@testing-library/react-native`, as in useConnectionStatus.test.ts L138.
- Cases:
  - (a) **Identity:** `const { result, rerender } = renderHook(() => useRealtimeReloadScheduler())`; `const first = result.current; rerender({}); expect(result.current).toBe(first)`.
  - (b) **Feeds the scheduler, so the old inline debounce is gone.**
    - Set `useInflight.setState({ _writeCount: 1, hasWriteInflight: true })`, call `result.current()`, advance 5 s → `loadFromSupabase` not called. (The old inline `setTimeout` would have fired at 400 ms.)
    - Then `setState({ _writeCount: 0, hasWriteInflight: false })` → +399 → 0 → +1 → called once with `'s1'`.
  - (c) **Unmount disposes.**
    - `jest.spyOn(useInflight, 'subscribe')` before render, capturing the returned unsubscribe in a spy wrapper.
    - Render, `result.current()`, `unmount()` → the unsubscribe was called; `getTimerCount() === 0`; +5 s → no load.
    - Calling the captured `handleSync` after unmount → still no timer, no load.
  - (d) **`reloadCurrentStore` reads the store at fire time.**
    - Call `handleSync`, then change `mockStoreState.currentStore.id` to `'s2'` before 400 ms → called with `'s2'`.
    - With `currentStore: { id: '' }` → `reloadCurrentStore()` resolves, and `loadFromSupabase` is not called.
  - (e) **Adapter edge filter.** Changing only `_activeCount` / `hasInflight` via `setState` does not invoke the scheduler callback. Pin this either through `inflightWriteSource.subscribe(cb)` directly, or by observing that an armed debounce is not restarted.

`CmdNavigator.tsx` itself gets no render test. It imports the whole Cmd shell, which is impractical in jest. The wiring there is a one-line call, so AC-11 is satisfied at hook level, as the spec allows. Code review confirms L62-74 is gone and that the hook call precedes `useRealtimeSync`.

### 10. Browser procedure (AC-14 to AC-16), refined

**Setup:** as written in AC-14 (`npm run dev:db`, then `docker restart supabase_realtime_imr-inventory`, preview config `expo-web` from `.claude/launch.json`, sign in as `admin@local.test` / `password`).

**Counting reloads.** Prefer the Resource Timing API through the preview eval tool over eyeballing the network panel. It gives exact URLs with start and end times.

- Before the action:

  ```js
  performance.setResourceTimingBufferSize(5000);
  performance.clearResourceTimings();
  ```

  This replaces "clear the network log".
- After the 5 s wait, collect `performance.getEntriesByType('resource')` and decode each `name` with `decodeURIComponent`.
- **Reload marker:** path `/rest/v1/inventory_items`, a decoded query containing `catalog:catalog_ingredients(id,` (the `INVENTORY_SELECT` embed, db.ts L275-280) and `limit=`, and **not** containing `id=gt.` or `store_id=eq.`.
  - This is the first page of the unfiltered keyset read (db.ts L319-332), one per `loadFromSupabase`.
  - It excludes the save's own `select=catalog_id` / `select=vendor_id` lookups, the empty terminator page (which has `id=gt.`) and any `fetchInventory(storeId)` read.
- **Cross-check marker:** `/rest/v1/stores` with `status=eq.active` (db.ts L68-74).
- **Overlap (AC-16):** for each pair of marker entries, check `a.startTime < b.responseEnd && b.startTime < a.responseEnd`. There must be no overlapping pair. Record `startTime` / `responseEnd` for each marker.
- **Baseline:** run the same measurement on the pre-change tree first (developer, before editing) and record it (expected 2-4).

**AC-14 vendor-link variant:** change the link set in the editor (add or remove a vendor row) and press **Save**. Do not press "Apply vendors to all stores"; that path issues its own explicit reload, which is out of scope (R9b).

**AC-15:** as written. In session A, run the same marker count over the window from B's save to +5 s.

**AC-16 count bound: architect note for the owner.** The no-overlap and final-value checks are the hard pass criteria. "At most 2 reloads" holds only when each save starts before the previous save's post-drain debounce and reload have finished. Reopening the drawer between saves can take more than 1 s, and then three reloads that don't overlap, each 400 ms after its own drain, is the designed behaviour (R3/R5), not a defect. The developer records the count with the marker timings and the save timestamps. If the count is 3 and the timings show each reload started after the previous one settled and 400 ms after a drain, report that as conformant and let the owner rule. If any two markers overlap, or a reload starts while a write is in flight, that is a fail. This interprets an AC; it does not change the requirement.

### 11. Risks and tradeoffs

- **Late self-echo (spec residual risk, unchanged).** An echo that lands more than 400 ms after the last write drains starts or dirties a second reload. Local realtime latency is normally well under 400 ms. If AC-14 shows 2, the developer stops and raises it, per the spec. No echo-window or payload matching.
- **A write that never settles holds realtime reloads indefinitely.**
  - R1 drops the count in `track`'s `finally`, and that only runs when the wrapped thunk settles.
  - The 30 s abort settles the thunk only if the thunk honours the signal.
  - Nearly all write paths chain `.abortSignal(signal)` (the spec 055 discipline). The known exceptions are best-effort storage `.remove()` calls inside `uploadIngredientImage` / `removeIngredientImage` (db.ts L5971, L5982, L6022), which pass no signal.
  - A hung storage call there would keep `hasWriteInflight` true and hold this client's realtime reloads until the page reloads. It would also keep `hasInflight` (the loading bar) stuck, which is a pre-existing visible symptom.
  - The owner's "up to 30 s" acceptance assumes signal-honouring writes. This design adds no scheduler-side hold cap, because R3 forbids timers while writes are in flight. A cap, or threading the signal into those storage calls, would be a follow-up if it ever bites. Flagged, not blocking.
- **Long or frequent writes delay other managers' updates on this client (owner-accepted).** Back-to-back writes, for example rapid saves or a CSV import firing many `updateItem`s, keep re-holding, and other managers' events apply once they stop. Correct per R3; noted for support.
- **Store switch with a held event.** The scheduler is per-`AuthedRoot`, not per-store. A held or dirty event fires `reloadCurrentStore` for whatever store is current at fire time. That can duplicate the switch's own direct `loadFromSupabase` (out of scope; spec 176 makes it safe). Same as today.
- **Explicit reloads still bypass the scheduler.** `applyVendorsToAllStores`, `stockStoreFromStore` and `receivePurchaseOrder` call `loadFromSupabase` directly. They are not tracked as writes, so they neither hold nor are held. Their realtime echoes are held while their own RPC write is in flight, then produce one scheduler reload that can overlap the explicit one. Unchanged from today; this is the finding-5 follow-up.
- **Tails still overlap (spec residual).** `items_last_counted` and friends from reload N can still be running when reload N+1 starts. Fewer reloads means less of this, but not zero.
- **Performance.** The adapter listener runs on every `useInflight` `set` (2-4 per tracked call; about 40-70 per full reload). Each run is one boolean compare, so the cost is negligible. Seed size (286 KB) is irrelevant here; the win is fewer full reloads (17 requests each).
- **Native.** Plain TS plus React hooks, so no platform API. JS timers pause in the background on native. A held or debouncing reload resumes on foreground, the same as the old inline timer.
- **Migration ordering, RLS gaps, edge cold start:** not applicable (no server change).
- **`app.json`:** not touched. No identity question arises.

### 12. Implementation notes for the developer

- One new pure module, one new hook, plus the inflight and CmdNavigator edits. No `package.json` change.
- Gates: full `npx jest` (not a subset), `npm run typecheck`, `npm run typecheck:test`. `typecheck:test` is a CI gate that jest alone misses.
- Record the AC-14 baseline and the post-change counts, the AC-15 count and the AC-16 count with timings in an `## Implementation notes` section. List every changed file under `## Files changed`.
- Stage only; no commit without the owner's go-ahead.

## Handoff
next_agent: frontend-developer
prompt: Implement spec 206 against the "## Backend design" section in this spec.
  - R1: the write counter in src/lib/inflight.ts.
  - The new pure scheduler, src/lib/realtimeReloadScheduler.ts.
  - The new hook, src/hooks/useRealtimeReloadScheduler.ts.
  - The AuthedRoot wiring in src/navigation/CmdNavigator.tsx.
  - The three jest suites (AC-1 to AC-11).
  - The AC-14 to AC-16 browser checks, using the Resource Timing marker procedure in section 10. Record the baseline first.

  Run the full npx jest and both typechecks. Then set Status: READY_FOR_REVIEW and list the files changed under ## Files changed. Do not touch loadFromSupabase, useRealtimeSync.ts, db.ts or app.json. Stage only; do not commit.
payload_paths:
  - specs/206-realtime-reload-once-per-edit.md
  - src/lib/inflight.ts
  - src/navigation/CmdNavigator.tsx
  - src/hooks/useRealtimeSync.ts

## Implementation notes

Frontend developer, 2026-11-23. Implemented as designed in "## Backend design". No change to `loadFromSupabase`, `useRealtimeSync.ts`, `db.ts`, `app.json`, any `supabase/` file or spec 205. Nothing staged or committed.

### Deviations and additions

- **No design deviations.** The state machine, invariants, adapter edge filter and hook shape are as specified in §3.
- One defensive detail: `startReload` wraps the thunk's result in `Promise.resolve(p)` before attaching `then`, so a thunk that returned a non-promise could not throw a `TypeError` out of the timer callback. The types already require a `Promise`.
- Extra jest cases beyond §9, all additive:
  - scheduler: an event that arrives less than 400 ms before settle still gives one follow-up, through its own timer;
  - scheduler: a throwing `onReloadError` reporter never surfaces as an unhandled rejection;
  - scheduler: a write starting while a debounce is armed clears it;
  - hook: an R5 event with no writes in flight;
  - hook: an end-to-end hold driven by a real `useInflight.track(..., { kind: 'write' })`.
- **How AC-6's unhandled-rejection check works.** Jest installs its own process-level `unhandledRejection` handler, which fails the running test with the leaked error. The sandbox `process.on` spy in §9 does not receive the event on its own. The `setImmediate` turn is what lets Node emit the event while the test is still running. I checked this by temporarily re-throwing from the scheduler's reject branch: all four rejection cases failed. I then restored the file. The test file has a comment explaining this.

### Gates

- **AC-12:** full `npx jest` passed: 322 suites and 4131 tests.
- **AC-13:**
  - `npm run typecheck:test` exits 0.
  - `npm run typecheck` exits non-zero on this machine, for environmental reasons only. It reports 24 `TS2688 Cannot find type definition file for '<pkg> 2'` errors. They come from macOS duplicate folders such as `node_modules/@types/react 2` and `node_modules/@types/node 2`, which are git-ignored and not created by this change.
  - Re-running the base config with an explicit `types` list that leaves out the `* 2` folders exits 0, with no other errors. That ran through a temporary tsconfig, deleted afterwards.
  - CI (clean `npm ci`) does not have these folders.

### Browser verification (AC-14 to AC-16)

**Tooling.**
- The `preview_*` tools were not available in this subagent session.
- Instead, I drove headless Chromium with the repo's existing Playwright install (`node_modules/playwright`, already present for the spec 078 e2e track). The scripts lived in the session scratchpad, outside the repo; no test framework or repo file was added.
- The app was the already-running Expo web dev server on `:8081`, started from this repo's root. Each run opened a fresh browser context, so the current bundle loaded.

**Setup.**
- Local stack already up.
- I ran `docker restart supabase_realtime_imr-inventory` before measuring.
- Signed in as `admin@local.test` / `password`, Towson store, Inventory section.
- Measurement used the §10 Resource Timing marker:
  - `/rest/v1/inventory_items` with `catalog:catalog_ingredients(id,` and `limit=`, and without `id=gt.` or `store_id=eq.`;
  - cross-checked against `/rest/v1/stores?...status=eq.active`;
  - overlap tested pairwise on `startTime` / `responseEnd`.
- Each measurement used a 5 s window from the Save click.

**Latency note (important for reading the baseline).**
- On the local stack, the whole `updateInventoryItem` write chain finishes in about 30 ms, well under the 400 ms debounce. So the pre-change build already showed only 1 reload per edit locally.
- To reproduce the prod condition, I also ran every measurement with 250 ms of emulated latency on each PostgREST request. That was a Playwright `page.route('**/rest/v1/**')` delay applied to reads and writes alike. It stretches the save's write chain to about 1.6 s, the same order as prod.

**AC-14, par-level edit on "American Cheese" (Towson), 3 runs each.**

| Build | Added latency | Reloads per edit | Overlap |
|---|---|---|---|
| Baseline (pre-change) | 0 ms | 1, 1, 1 | no |
| Baseline (pre-change) | 250 ms | **3, 2, 3** | **yes, every run** |
| After | 0 ms | 1, 1, 1 | no |
| After | 250 ms | **1, 1, 1** | no |

The `stores` cross-check matched the marker count in every run.

**AC-14, vendor-link variant.**
- Steps: plain **Save** after attaching "US FOOD" to the item, then a second Save after removing it. The "Apply vendors to all stores" button was not used.
- The request log shows the demote, upsert and delete `item_vendors` calls inside the save.
- After the change: 1 and 1 reloads at 0 ms, and 1 and 1 at 250 ms, with no overlap.
- I did not run a separate pre-change baseline for this variant. The par-edit baseline above already exercises the same demote, upsert and delete chain, because `updateInventoryItem` runs it on every save.

**AC-15, another manager's change.**
- Two independent browser contexts, A and B, both signed in as the local admin. B edited American Cheese's par three times in total, across two script runs.
- Each time, A showed the new value with no manual refresh, at about 0.94 s, 1.24 s and 1.14 s after B's Save click. That includes B's own write chain, the 400 ms debounce, one load and a 50 ms polling step.
- A made exactly 1 reload per B edit (marker count 1, `stores` 1, no overlap).

**AC-16, rapid edits.** Three Saves on the same item within about 1.4 s.

| Added latency | Reloads | Overlapping markers | Reload started during a save request | Final par: DB vs UI |
|---|---|---|---|---|
| 0 ms | 1 | none | no | 11 / 11 |
| 250 ms | 1 | none | no | 8 / 8 |

- Each Save's post-drain debounce was re-held by the next Save's writes (R3), so the three saves folded into one reload.
- The architect's §10 note about a count of 3 when saves are spaced further apart did not come up.

**Console.** Across two edits on the post-change build: no console errors, no page errors and no `[realtimeReload]` warnings.

**Late self-echo (spec residual risk).** It was not seen. No run showed a second reload caused by an echo arriving after the reload started.

**Local test data touched.**
- American Cheese (Towson) par was changed during the runs and restored to 8. The DB was checked afterwards.
- A "US FOOD" link was attached and then removed; the SYSCO primary link is intact.
- The local `audit_log` gained the matching "edited item" rows.

## Files changed

- `src/lib/inflight.ts`: R1 write counter (`_writeCount`, `hasWriteInflight`, `selectHasWriteInflight`) and the header surface list.
- `src/lib/inflight.test.ts`: AC-10 suite appended; `resetStore()` gains the two new keys.
- `src/lib/realtimeReloadScheduler.ts` (new): pure scheduler (R2-R5, R7, R8).
- `src/lib/realtimeReloadScheduler.test.ts` (new): AC-1 to AC-9, plus invariant guards.
- `src/hooks/useRealtimeReloadScheduler.ts` (new): `reloadCurrentStore`, `inflightWriteSource`, `useRealtimeReloadScheduler` (R6, R7).
- `src/hooks/useRealtimeReloadScheduler.test.ts` (new): AC-11.
- `src/navigation/CmdNavigator.tsx`: `AuthedRoot` uses the hook instead of the inline debounce; the unused `useRef` import is dropped.
- `specs/206-realtime-reload-once-per-edit.md`: status, AC checkboxes, implementation notes, this list.

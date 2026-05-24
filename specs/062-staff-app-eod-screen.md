# Spec 062: Staff app — EOD count screen (first slice)

Status: READY_FOR_REVIEW
Owner: product-manager

## Problem statement

(Verbatim from spec 061's B3–B10 acceptance criteria — the imr-inventory backend contract this spec consumes.)

- **B3 — Auth gate.** Staff sign in with Supabase email+password. Only users whose `profiles.role === 'user'` AND who have at least one `user_stores` row may use the app. Admins / super-admins / users with no store assignment are signed out with an explanatory toast.
- **B4 — Store picker.** A staff member with one store skips the picker. A staff member with multiple stores picks at sign-in; the active store is persisted across launches and can be switched from the EOD screen.
- **B5 — EOD count screen.** Shows the active store, today's date, the vendor (or vendor switcher), and a scrollable list of inventory items belonging to the selected vendor with a decimal-pad input per row.
- **B6 — Submission flow.** Pressing Submit calls the `staff_submit_eod` RPC with a client-generated UUID. The screen handles three outcomes: success, idempotent replay (same UUID re-sent), and 403 access-denied (store removed from `user_stores` mid-session).
- **B7 — Offline queue.** When offline or when the RPC fails with a network error, the submission is persisted to AsyncStorage and drained on connectivity recovery. Forbidden submissions (403) are NOT retried.
- **B8 — i18n.** All user-facing strings go through an i18n channel even though v1 is English-only.
- **B9 — Telemetry.** None in v1 — out of scope.
- **B10 — Accessibility.** Tap targets ≥ 44 pt; decimal-pad inputs; readable in bright kitchen lighting (system theme).

## User stories

(i) **As a staff member at end of shift** I want to count inventory on my phone, submit, and know it saved — even if wifi is spotty — so I can clock out without waiting for an admin to confirm.

(ii) **As a staff member who lost cell signal in the back of the kitchen** I want my counts to queue and submit automatically when I'm back near the router, so I don't have to remember to retry or re-enter numbers.

(iii) **As an admin** I want staff submissions to flow into my existing EOD section in imr-inventory without any UI glue, so I see counts the same way whether the staff submitted them on their phone or I entered them on the desktop.

## Acceptance criteria

### Bucket 1 — Auth gate (B3)

- [ ] Sign-in screen accepts email + password and calls `supabase.auth.signInWithPassword`.
- [ ] After sign-in succeeds, the app fetches `profiles.role` for the authenticated user. If the role is NOT `'user'`, the app signs out via `supabase.auth.signOut()` and shows an error toast: `"This app is for staff only"`.
- [ ] After the role check passes, the app queries `user_stores` for the authenticated user. If the result has 0 rows, the app signs out and shows an error toast: `"No store assignments — contact your manager"`.
- [ ] The auth gate must execute BEFORE any other screen (EOD count, store picker) renders. A user who is not gated through is never shown an inventory item or a vendor name.
- [ ] On app launch with a persisted session, the gate re-runs (role and `user_stores` may have changed since last launch).

### Bucket 2 — Store picker (B4)

- [ ] If `user_stores` returns exactly 1 row, the picker is skipped and the user is routed directly to the EOD count screen for that store.
- [ ] If `user_stores` returns >1 rows, a picker screen is shown post-auth. The picker is a vertical list of store names (tap to select); no search, no filter.
- [ ] The active `store_id` is persisted to AsyncStorage at key `imr-staff:active-store:v1`. On next launch, after the auth gate passes, the app restores this store and skips the picker — UNLESS the persisted `store_id` is no longer in the user's `user_stores` (in which case fall back to picker for >1, or auto-select for 1).
- [ ] The EOD count screen header displays the active store name. Tapping the store name in the header navigates back to the picker (the "Switch store" affordance). For users with only 1 store the tap is a no-op (or the name is rendered non-interactive).

### Bucket 3 — EOD count screen (B5 + Q1 vendor logic)

- [ ] Header shows the active store name (tap to switch when applicable) and the selected date — today only, read-only label like `Today · Sat, May 24`.
- [ ] Vendor switcher is derived from spec 007's `vendor_day_filter` for `(active_store_id, today's weekday)`. If the filter returns exactly 1 vendor, no switcher is rendered — the screen shows that vendor's items directly. If >1 vendors are scheduled for today, render a horizontal chip-style switcher above the item list; tapping a chip swaps the item list and pre-fill banner accordingly.
- [ ] Item list renders ALL `inventory_items` belonging to the selected vendor for the active store, scrollable, one row per item. Row contents: item name (primary text), unit label (secondary), pack-size hint if defined, and a numeric input with `keyboardType="decimal-pad"` (native) / `inputMode="decimal"` (web). All tap targets — including input field and row — are ≥ 44 pt tall.
- [ ] Submit button is pinned to the bottom of the screen (above the safe-area inset) as the primary CTA. Disabled while a submission is in-flight; shows a spinner during the RPC call.
- [ ] On screen mount (and on vendor-switcher change), if a submission for `(active_store_id, today, selected_vendor_id)` already exists in the database, pre-fill the prior values into the inputs and show a banner at the top: `"Last submitted at HH:MM — your changes will overwrite"`.
- [ ] No barcode scanner, no camera, no voice input, no scale weight — text input only.

### Bucket 4 — Submission flow + 3 outcomes (B6)

- [ ] On Submit press, the client generates a fresh `client_uuid` (uuid v4) and calls:
  ```
  supabase.rpc('staff_submit_eod', {
    p_client_uuid,
    p_store_id: active_store_id,
    p_date: today_iso,
    p_submitted_by: null,           // RPC re-derives from auth.uid()
    p_status: 'submitted',
    p_entries: [{ item_id, count }, ...],
    p_vendor_id: selected_vendor_id,
  })
  ```
  with the per-user JWT (the default supabase-js authenticated session — NOT the service-token bearer used by `staff-*` edge functions).
- [ ] **Outcome A — success with `conflict: false` (HTTP 200):** show a green check + toast `"Submitted"`. Refresh the screen state so the banner reads `"Last submitted at HH:MM — your changes will overwrite"` (i.e. re-mount behavior pre-fills the just-submitted values).
- [ ] **Outcome B — success with `conflict: true` (HTTP 200):** treat as success. Show toast `"Already submitted — your counts match the existing submission"`. This is the idempotency-replay path: same `client_uuid` re-sent (e.g. from queue drain after success-then-network-blip).
- [ ] **Outcome C — 403 / Postgres SQLSTATE 42501 from `auth_can_see_store()`:** show an error banner: `"Cannot submit for this store — your access has changed. Sign out and back in."` DO NOT queue this submission for retry. DO NOT auto-sign-out (let the user choose).
- [ ] On any other error (5xx, malformed response), surface a generic toast `"Submission failed — try again"` and leave inputs intact.

### Bucket 5 — Offline queue (B7)

- [ ] **Connectivity detection** lives in a hook at `src/hooks/useConnectionStatus.ts` with signature `useConnectionStatus(): boolean` (true = online).
  - Web implementation: read `navigator.onLine` initially; subscribe to `window` `online` / `offline` events.
  - Native implementation: subscribe via `@react-native-community/netinfo` `NetInfo.addEventListener`, returning `state.isConnected && state.isInternetReachable !== false`.
- [ ] **Queue write conditions.** When Submit is pressed AND (`isConnected === false` OR the supabase call rejects with a network error — `TypeError: Network request failed`, `Failed to fetch`, abort, timeout): persist the payload to AsyncStorage at key `imr-staff:eod-queue:v1`. Value shape (array, FIFO by `queued_at`):
  ```
  {
    client_uuid: string,           // generated at submit-press time
    store_id: string,
    date: string,                  // ISO yyyy-mm-dd
    vendor_id: string,
    status: 'submitted',
    entries: [{ item_id, count }],
    queued_at: string,             // ISO timestamp
    intent_user_id: string,        // auth.uid() at queue-write time
  }
  ```
- [ ] **Queue UX.** While queued, the row in the queue UI (inline below the Submit button) shows `"Queued — will sync when online"` with a green-check icon, NOT a red error. Submit clears the inputs as if successful — the user moves on.
- [ ] **Drain trigger.** When `useConnectionStatus()` flips false → true, kick off a drain. Drain order is FIFO by `queued_at`.
- [ ] **Drain — per-item.** Each item is re-sent via `supabase.rpc('staff_submit_eod', ...)` with the SAME stored `client_uuid` so the backend dedupes (returning `conflict: true` on idempotent replay, which we treat as success).
- [ ] **Drain — outcome A (success or replay):** remove the item from the queue. When the queue is empty, show toast `"All counts synced"` (fire once per drain cycle, not per item).
- [ ] **Drain — outcome 403:** remove the item from the queue (DO NOT infinitely re-queue forbidden submissions) and show a persistent error indicator listing the item's `date` + `vendor_id` with the message `"Could not sync — your access to this store changed."` The user dismisses manually.
- [ ] **Drain — outcome network error:** leave the item in the queue, retry on the next connectivity flip.
- [ ] **Queue persistence across sign-out.** The queue persists in AsyncStorage when the user signs out. Each queued item carries `intent_user_id`. When a DIFFERENT user signs in, items with non-matching `intent_user_id` are NOT drained by the new user — they stay in storage as a security boundary. (Architect to confirm: GC policy for stale items belonging to no-longer-signed-in users — likely 30-day TTL purge on app launch.)
- [ ] **i18n.** All user-facing strings in the queue UX go through the i18n channel (B8). English-only catalog in v1.

## In scope

- Sign-in screen (email + password, Supabase auth).
- Auth gate on launch + post-sign-in.
- Store picker (when >1 store).
- EOD count screen with vendor switcher derived from spec 007.
- Submit flow calling spec 061's `staff_submit_eod` RPC.
- Offline queue with FIFO drain on reconnect.
- i18n channel scaffolding (English-only catalog).
- jest tests co-located with components (see Dependencies → Tests).

## Out of scope (explicitly)

- **Barcode scanning, camera item lookup, voice input, scale weight reading.** Future spec. Rationale: v1 ships text input only to keep scope tight; physical sensors require permission flows and per-device QA.
- **Editing prior days' submissions / back-dating.** Today only in v1. Rationale: admin can correct historical entries via the imr-inventory desktop section; staff need only the day-of flow.
- **Other staff workflows: receiving, waste log, prep make.** Future specs 063+. Rationale: separate slices, separate screens.
- **Push notifications when admin changes inventory mid-shift.** No realtime invalidation in v1. Rationale: deferred — adds Realtime subscription complexity and we don't yet know what UX the staff expects on a mid-count item-list change.
- **Multi-language support.** English only in v1, but i18n channel exists so adding a locale is a catalog-file change, not a refactor.
- **Dark mode toggle.** Use system theme via Expo defaults; no user-facing toggle. Rationale: kitchen lighting + staff phones don't need an admin-style preference panel.
- **Admin-app UI changes.** This spec is regression-only for imr-inventory. Submissions land in `eod_submissions` and the admin's existing EOD section reads them as-is per spec 061.
- **Any change to imr-inventory backend.** Spec 061 is the contract; this spec consumes it. If a backend gap surfaces during architect/build, raise it as a new imr-inventory spec, do not modify here.

## Open questions resolved

- Q: Vendor selection at sign-in? → A: Derive from spec 007's `vendor_day_filter` (today's weekday × active store). Show switcher only if multiple vendors scheduled.
- Q: Date selection? → A: Today only in v1. No back-dating UI.
- Q: Which items appear? → A: All of the selected vendor's items. The backend upsert handles re-entry / edits.
- Q: Input mode? → A: `keyboardType="decimal-pad"` native + `inputMode="decimal"` web; tap targets ≥ 44 pt; no barcode/camera.
- Q: What if a submission already exists for `(store, date, vendor)`? → A: Pre-fill prior values into inputs + show banner `"Last submitted at HH:MM — your changes will overwrite"`.
- Q: Offline queue UX? → A: Inline `"Queued — will sync when online"` per item + drain toast `"All counts synced"` when queue empties.
- Q: User has wrong role or no `user_stores`? → A: Sign out + error toast. No inter-app linking (no "open admin app" prompts).
- Q: Test track? → A: jest only — backend smoke already exists at `imr-inventory/scripts/smoke-staff-eod.sh`.

## Open questions for architect

1. **State management for the offline queue.** Should the queue live in the Zustand store (cleared on app close) + a mirror in AsyncStorage (persistent), or only in AsyncStorage with `useEffect` reads? PM recommends store-mirror so the UI updates reactively to drain events. Architect picks.
2. **Connectivity hook implementation pattern.** NetInfo on native + `navigator.onLine` on web. Single file with `Platform.OS` branching, OR two files imported via `Platform.select()`? Architect picks.
3. **Error boundary scope.** Wrap the whole stack navigator in an `ErrorBoundary`, or per-screen? Architect picks.
4. **AsyncStorage key namespace migration.** Spec mandates `imr-staff:eod-queue:v1` and `imr-staff:active-store:v1` for v1. Architect to document the migration story if the queue payload shape changes (likely: bump to `v2`, read v1 once on mount, migrate, delete v1 — standard pattern).
5. **Test mocking boundary.** supabase-js mock pattern. Mock at the hook boundary (mock `useEodSubmit`) or at the client boundary (mock `supabase.rpc`)? PM recommends hook-boundary as cleaner. Architect confirms.

## Dependencies

### imr-staff dependencies (already in `package.json` — NO new deps for v1)
- `@react-native-async-storage/async-storage@2.2.0` — queue + active-store persistence
- `@react-native-community/netinfo@^11.0.0` — native connectivity events
- `@react-navigation/native@^6.1.17` + `@react-navigation/stack@^6.3.29` — navigation
- `@supabase/supabase-js@^2.101.1` — auth + RPC
- `zustand@^4.5.4` — UI state (queue mirror, active store, auth state)
- `react-native` 0.81 + `react-native-web` 0.21 + Expo 54 (already present)

### Backend dependencies (imr-inventory — already shipped per spec 061)
- `staff_submit_eod(p_client_uuid uuid, p_store_id uuid, p_date date, p_submitted_by text, p_status text, p_entries jsonb, p_vendor_id uuid)` RPC. Returns `{ submission_id, conflict: boolean }` on success; raises SQLSTATE `42501` on `auth_can_see_store()` rejection (→ HTTP 403 via PostgREST).
- `profiles` table (read `role` for authenticated user).
- `user_stores` table (read user's store assignments).
- `vendor_day_filter` view/RPC from spec 007 (vendors scheduled for `(store_id, weekday)`).
- `inventory_items` table (read items for active store, scoped by `auth_can_see_store()`).
- Backend smoke at imr-inventory `scripts/smoke-staff-eod.sh` already covers the RPC contract — staff app does not need to re-test that surface.

### Test dependencies
- jest + jest-expo already in devDeps. Tests co-located: `src/screens/EODCount.test.tsx`, `src/screens/StorePicker.test.tsx`, `src/screens/SignIn.test.tsx`, `src/hooks/useConnectionStatus.test.ts`, `src/store/useStaffStore.test.ts` (queue logic), `src/lib/eodQueue.test.ts` (drain orchestrator). No new test framework / runner.

## Project-specific notes

- **Repo:** imr-staff (sibling repo to imr-inventory). This spec lives at `imr-staff/specs/062-staff-app-eod-screen.md`. Numbering is intentionally continuous with imr-inventory's spec series so cross-repo references read naturally.
- **Cmd UI section / legacy:** N/A — imr-staff has no admin UI surface; it is a single-purpose staff app.
- **Per-store or admin-global:** Per-store. Every read and the submit RPC are gated by `auth_can_see_store()` on the imr-inventory backend.
- **Realtime channels touched:** None in v1. (No mid-shift inventory invalidation — see "Out of scope".)
- **Migrations needed:** None in imr-staff. None in imr-inventory (spec 061 already landed the RPC + smoke).
- **Edge functions touched:** None. The submit path is a PostgREST RPC with the per-user JWT — NOT a `staff-*` edge function with the service-token bearer.
- **Web/native scope:** Both. iOS + Android via Expo Go / EAS, web via `react-native-web`. The connectivity hook MUST handle both surfaces correctly (NetInfo on native, navigator.onLine on web).
- **i18n:** English-only v1, but all strings go through an i18n channel so locale addition is catalog-only.
- **Cross-repo agent operation:** The downstream agents (backend-architect, frontend-developer, reviewers) are configured for imr-inventory paths. They must operate cross-repo for this spec: design + implementation files live under `~/Documents/GitHub/imr-staff/`, NOT under imr-inventory. The "backend-architect" role here is doing **frontend architecture** since imr-staff has no backend — the design doc covers React Native + Zustand + AsyncStorage + navigation shape, not SQL.
- **`app.json` slug:** Out of scope for this spec. If imr-staff's `app.json` needs an EAS-related identifier change during build, surface it as a separate question — do not auto-fix.

## Frontend design

This section is normative and resolves the 5 open questions to architect, then specifies the file structure, state machines, hook contracts, navigation, i18n scaffold, test plan, cross-repo workflow, preview workflow, and risks.

The "Backend design" header is intentionally avoided — there is no backend in this repo. The architect is the frontend architect for this spec; the immutable backend contract is at `~/Documents/GitHub/INVENTORY-MANAGEMENT/specs/061-staff-app-eod-count.md` and `~/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql`.

### 0. Open question resolutions

**Q1 — Offline queue state management.** Zustand store mirror + AsyncStorage as the persistence layer.

Rationale: the spec mandates "Queued — will sync when online" UX that updates reactively when the queue grows or drains (B7 — UI shows a queue indicator, drain toast fires on empty). Pure AsyncStorage + `useEffect` reads would force every consumer to re-poll storage or roll its own pub/sub. Zustand is already in deps and provides the reactive layer for free.

Contract:
- `useStore` holds `eodQueue: QueuedSubmission[]` as a slice.
- **On app mount** (single `useEffect` in `App.tsx`): read `imr-staff:eod-queue:v1` from AsyncStorage, parse, seed the store via `useStore.getState().hydrateQueueFromStorage(items)`. If parse fails see Q4 migration story.
- **On every store mutation that touches `eodQueue`**: the store action `_persistQueue()` is called synchronously after the state update and `await AsyncStorage.setItem('imr-staff:eod-queue:v1', JSON.stringify(items))` runs. Store action signatures: `enqueueEod(item)`, `dequeueEod(client_uuid)`, `bumpEodAttempts(client_uuid)`. Each is responsible for writing through.
- Writes are fire-and-forget at the action level (no awaiting in the UI callsite), but the AsyncStorage write itself happens immediately — no debounce. The queue is small (bounded — see risks Q5) so write amplification is not a concern.
- **On any AsyncStorage write failure**: log via `notifyBackendError(err)` (the staff-app equivalent of imr-inventory's pattern — `console.warn` + a toast). The in-memory store still reflects the mutation; we accept the risk that a write failure can lose a queued item across an app kill. Document this in the queue's source comment.

**Q2 — `useConnectionStatus` hook implementation.** Single file with `Platform.OS` branching inside `useEffect`.

Rationale: the implementations diverge in the SUBSCRIBE step (NetInfo on native, `window.addEventListener` on web) but the contract is identical (`useConnectionStatus(): boolean`) and both branches use the same `useState(true)`/`setConnected` machinery. `Platform.select()` for two-file separation is over-engineered for one ~40-line hook with two `if` branches.

Reference shape: mirror imr-inventory's spec 058 "platform gate stays as the FIRST statement inside `useEffect`" rule (`src/hooks/useConnectionStatus.ts:118` in imr-inventory) — the hook is called unconditionally on every render, the platform-fork lives inside the effect body so the Rules-of-Hooks invariant is preserved. The native bail in imr-inventory's hook returns early; the staff app cannot do that because native IS the primary target — the native branch SUBSCRIBES, not bails.

**Q3 — Error boundary scope.** Whole-stack ErrorBoundary at `App.tsx` level + log-only-no-UI behavior + offline queue as source of truth.

Rationale: per the prompt — phone app, kitchen environment, dirty hands. A render error that drops the user back to "something went wrong" is acceptable iff their queued counts survive. They do, because `imr-staff:eod-queue:v1` is persisted to AsyncStorage on every enqueue, independent of React state. The ErrorBoundary catches render errors below the navigator, logs them via `notifyBackendError`, and renders a minimal fallback ("Something went wrong — your counts are saved. Restart the app.").

Per-screen boundaries are NOT added in v1 because the screen failure modes are limited and the whole-stack boundary already protects against the unrecoverable "white screen" outcome. If a screen-specific failure mode surfaces in cycle-2 (e.g. EODCount crashes on a malformed inventory item), add a per-screen boundary in that spec; the whole-stack boundary stays as the floor.

**Q4 — AsyncStorage key migration.** Read-once-on-mount migration pattern; corrupt-payload backup; document the contract for future schema bumps.

Migration shape (one-time mount logic in `src/lib/eodQueue.ts`'s `hydrateQueue()`):
1. Read `imr-staff:eod-queue:v1`. If null → empty queue. Return `[]`.
2. Attempt `JSON.parse`. If throws → log, write the raw value to `imr-staff:eod-queue:v1-corrupted:<ISO timestamp>` (backup), delete `:v1`, return `[]`. (User loses the queue but the app boots clean; the corrupted blob is preserved for debugging.)
3. If parsed object is not an array → same backup + reset.
4. If parsed array has any item failing the `QueuedSubmission` shape check (Zod-light: required fields `client_uuid`, `store_id`, `date`, `vendor_id`, `entries`, `queued_at`, `intent_user_id`) → log + filter out the malformed items, keep the rest.
5. Return the validated array.

Future schema bumps (v1 → v2): the migration story is "read v1, transform, write v2, delete v1". One-time logic at the same mount path checks for `:v2` first; if absent, reads `:v1`, runs the transform, writes `:v2`, deletes `:v1`. The contract this spec sets for cycle-N+1 — if you change `QueuedSubmission` shape, bump the version suffix and add a transform branch. Comment block in `src/lib/eodQueue.ts` documents this.

**Q5 — Test mocking boundary.** Hook-boundary. Mock `useEodSubmit` (and `useConnectionStatus`) in screen tests; the hooks themselves get their own tests that mock the lower layers (`supabase.rpc`, `NetInfo`, `window` events).

Rationale: matches imr-inventory's spec 057/059 precedent — the hook IS the codified boundary. Screen tests stay short and focus on UI behavior given hook outcomes; hook tests focus on the orchestration logic. Mock surface is small and explicit per test.

Mock helper: `src/__mocks__/useEodSubmit.ts` (jest manual mock) returns `{ submit: jest.fn(), pending: 0, draining: false }` by default; per-test overrides via `jest.mocked(useEodSubmit).mockReturnValue(...)`.

### 1. File structure

New files under `~/Documents/GitHub/imr-staff/src/`:

```
src/
  App.tsx                                  # (already exists — root, will be rewritten)
  lib/
    supabase.ts                            # supabase-js client singleton + env-var loader
    eodQueue.ts                            # AsyncStorage queue helpers (push/drain/peek/hydrate)
    notifyBackendError.ts                  # console.warn + toast (mirrors imr-inventory pattern)
    confirmAction.ts                       # cross-platform window.confirm vs Alert.alert (used for sign-out + switch-store confirm)
    uuid.ts                                # uuid v4 generator (small; no new dep — use crypto.randomUUID() with native polyfill)
  hooks/
    useConnectionStatus.ts                 # Q2 single-file Platform.OS branching
    useEodSubmit.ts                        # mutation hook wrapping RPC + queue
    useI18n.ts                             # hook reading active locale from store (English-only v1)
  store/
    useStore.ts                            # Zustand store (auth, active store, queue mirror, helpers)
  screens/
    SignIn.tsx                             # email + password sign-in
    StorePicker.tsx                        # >1 stores picker
    EODCount.tsx                           # the EOD count screen
  navigation/
    RootStack.tsx                          # React Navigation 6 stack + auth gate
  components/
    Button.tsx
    Input.tsx
    ListRow.tsx                            # touch-target ≥44pt item row
    Banner.tsx                             # top-of-screen info banner ("Last submitted at...")
    ErrorBoundary.tsx                      # whole-stack boundary (Q3)
    QueueIndicator.tsx                     # "N pending" + sync state pill
  i18n/
    en.json                                # English-only v1 catalog
    index.ts                               # `t(key, vars)` lookup — mirrors imr-inventory shape (Q-1)
  __mocks__/
    useEodSubmit.ts                        # jest manual mock per Q5
```

Plus tests co-located alongside production files (per project convention):
- `src/screens/SignIn.test.tsx`
- `src/screens/StorePicker.test.tsx`
- `src/screens/EODCount.test.tsx`
- `src/hooks/useConnectionStatus.test.ts`
- `src/hooks/useEodSubmit.test.ts`
- `src/store/useStore.test.ts` (selector + queue-mirror tests)
- `src/lib/eodQueue.test.ts` (hydrate/persist/migration tests)
- `src/i18n/i18n.test.ts` (key existence + interpolation)

`src/App.tsx` is REWRITTEN to mount `NavigationContainer` → `ErrorBoundary` → `RootStack`.

### 2. Auth gate state machine

State machine lives in `useStore` as `authState`. States:

```
{kind: 'idle'}                              # initial, before mount
{kind: 'restoring'}                         # reading AsyncStorage for cached session
{kind: 'signing-in'}                        # signInWithPassword in flight
{kind: 'gating'}                            # signed in; fetching profile.role + user_stores
{kind: 'signed-out'}                        # show SignIn
{kind: 'signed-out', toast: string}         # show SignIn + flash a toast
{kind: 'signed-in', userId, stores}         # show StorePicker or EODCount
```

Sequence on app mount:
1. `RootStack` renders with `authState = {kind: 'idle'}`. Show splash (a minimal centered "I.M.R Staff" loader; not a separate screen).
2. `useEffect` in `RootStack` fires `restoreSession()`. State → `{kind: 'restoring'}`.
3. Call `supabase.auth.getSession()`. If null → state `{kind: 'signed-out'}` → show `SignIn`.
4. If session exists → fetch `profiles.role` for `auth.uid()`. If role !== `'user'` → `supabase.auth.signOut()` + state `{kind: 'signed-out', toast: t('auth.error.notStaff')}` → `SignIn` with toast.
5. Role check passes → fetch `user_stores` for `auth.uid()` (just `store_id` + `stores.name` joined). If 0 rows → signOut + `{kind: 'signed-out', toast: t('auth.error.noStores')}`.
6. ≥1 stores → state `{kind: 'signed-in', userId, stores}`. Read `imr-staff:active-store:v1` from AsyncStorage. Validate persisted store still appears in `user_stores`. If invalid OR null → if 1 store, auto-select; if >1, route to `StorePicker`. Else route to `EODCount`.

On sign-in (`SignIn` Submit press):
- `signInWithPassword`. On failure → toast `t('auth.error.invalidCreds')`.
- On success → repeat steps 4–6 above.

On sign-out (`EODCount` header button → confirm via `confirmAction`):
- `supabase.auth.signOut()`. State → `{kind: 'signed-out'}`. AsyncStorage `imr-staff:active-store:v1` is cleared. **Queue is NOT cleared** — see B7 (intent_user_id boundary).

**Auth-gate re-run rule**: every cold start re-runs steps 4–6 because `profiles.role` or `user_stores` may have changed since last launch (admin demoted a staff member, or removed their store assignment). The gate is a synchronous block — no inventory screen renders until step 6 resolves.

### 3. Offline queue state machine

Per-submission states (tracked implicitly in the queue item; the UI derives display state from `attempts` and `lastError`):

```
idle ──[submit press]──▶ submitting
submitting ──[200 conflict=false]──▶ success            (toast: "Submitted")
submitting ──[200 conflict=true]──▶ success-replay      (toast: "Already submitted")
submitting ──[403 / SQLSTATE 42501]──▶ forbidden        (banner; NOT queued)
submitting ──[network error]──▶ queued                  (persisted, attempts=0)
submitting ──[5xx / malformed]──▶ failed                (toast: "Try again"; inputs intact, NOT queued — user re-presses)
queued ──[connectivity flip → online]──▶ draining
draining ──[per-item: 200 either flavor]──▶ remove from queue (success-replay path)
draining ──[per-item: 403]──▶ remove from queue + persistent-error banner
draining ──[per-item: network error]──▶ leave in queue, bump attempts, retry next flip
draining ──[queue empty]──▶ idle + toast "All counts synced" (once per drain cycle)
queued (attempts ≥ 5) ──▶ needs-attention (UI flag; item stays queued, surfaces in QueueIndicator as warning)
```

**Drain order: FIFO by `queued_at`.** Single-threaded — drain one item, wait for response, drain next. Avoids race conditions with overlapping `client_uuid` replays.

**Drain gate**: `useConnectionStatus()` flips false → true → fires drain. Also fired once on app mount (after auth-gate resolves), in case items were left queued by a prior session that died offline.

**intent_user_id security boundary** (B7 mandate):
- Every queue item is tagged at enqueue with `intent_user_id = supabase.auth.getUser().id`.
- At drain time, before issuing `supabase.rpc`, the orchestrator reads `supabase.auth.getUser().id` and compares to the queued item's `intent_user_id`.
- If different → skip the item (do NOT drain, do NOT delete). It stays in storage as a passive record for the original user. The current user does NOT see it in their `QueueIndicator` count (filter the slice by `intent_user_id === currentUserId`).
- This is a soft boundary — see risks (a staff user with dev-tools access could edit AsyncStorage). Acceptable per the threat model (staff users already have legitimate inventory access via their JWT).
- **GC**: stale items older than 30 days (`now() - queued_at > 30 * 24 * 3600 * 1000`) are purged on mount, regardless of `intent_user_id`. Documented in `src/lib/eodQueue.ts`.

**`QueuedSubmission` shape** (canonical; mirrors spec 062 §B7):

```ts
type QueuedSubmission = {
  client_uuid: string;          // generated at submit-press time (uuid v4)
  store_id: string;
  date: string;                 // ISO yyyy-mm-dd, captured at SUBMIT time (not mount time) — see risks
  vendor_id: string;
  status: 'submitted';
  entries: { item_id: string; count: number }[];
  queued_at: string;            // ISO timestamp
  intent_user_id: string;       // auth.uid() at enqueue
  attempts: number;             // bumped on each failed drain; threshold 5 → 'needs-attention'
  lastError?: string;           // optional last-attempt error message (for debug surfacing)
};
```

### 4. `useEodSubmit` hook contract

Signature:

```ts
type SubmitPayload = {
  store_id: string;
  date: string;             // ISO yyyy-mm-dd
  vendor_id: string;
  entries: { item_id: string; count: number }[];
};

type Outcome =
  | { kind: 'success';         submission_id: string }
  | { kind: 'success-replay';  submission_id: string }
  | { kind: 'forbidden';       message: string }
  | { kind: 'queued';          client_uuid: string }
  | { kind: 'failed';          message: string };

function useEodSubmit(): {
  submit: (payload: SubmitPayload) => Promise<Outcome>;
  pending: number;              // count of queued items for the CURRENT user (filtered by intent_user_id)
  draining: boolean;            // true while the drain loop is in flight
};
```

Internals:
1. `submit()` generates `client_uuid` (uuid v4).
2. Reads `useConnectionStatus()` snapshot. If offline → `enqueueEod({...payload, client_uuid, intent_user_id, queued_at: now(), attempts: 0})` + return `{kind: 'queued', client_uuid}`.
3. Online → call `supabase.rpc('staff_submit_eod', {p_client_uuid, p_store_id, p_date, p_submitted_by: null, p_status: 'submitted', p_entries: payload.entries.map(e => ({ingredient_id: e.item_id, actual_remaining: e.count})), p_vendor_id})`.
4. Map response:
   - HTTP 200 + `conflict === false` → `{kind: 'success', submission_id}`.
   - HTTP 200 + `conflict === true` → `{kind: 'success-replay', submission_id}`.
   - Error code `42501` (PostgREST surfaces this as `error.code === '42501'` or HTTP 403 — check both because supabase-js error envelope varies by version) → `{kind: 'forbidden', message: t('eod.error.forbidden')}`.
   - Network error (`TypeError: Network request failed`, `Failed to fetch`, abort, timeout — match by `error.name`/`error.message` substring) → enqueue + return `{kind: 'queued'}`.
   - Anything else → `{kind: 'failed', message}`.

The hook subscribes to `useStore(s => s.eodQueue.filter(i => i.intent_user_id === currentUserId).length)` for `pending` and `useStore(s => s.draining)` for `draining` (a transient boolean the drain orchestrator flips).

**Note on `p_submitted_by`**: per spec 061's body rework, the parameter is ignored — body re-derives audit from `auth.uid()`. We still send `null` explicitly in the RPC call to make intent clear at the callsite.

**Note on entry shape**: the RPC's `jsonb_to_recordset` expects `ingredient_id` + `actual_remaining` (not `item_id` + `count`). The hook maps at the boundary; UI code in `EODCount.tsx` uses `item_id` + `count` for readability.

### 5. `useConnectionStatus` hook contract

Signature: `useConnectionStatus(): boolean` (true = online).

Implementation (single file, `Platform.OS` branching inside `useEffect`):
- Initial state via `useState(readInitial)` lazy initializer.
  - Web: `readInitial = () => typeof navigator !== 'undefined' ? navigator.onLine : true`.
  - Native: `readInitial = () => true` (optimistic; NetInfo's first event will correct in <500ms).
- `useEffect` body (Rules-of-Hooks: hook called unconditionally; platform fork inside effect):
  - Web branch: `window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline); return () => removeEventListener(...)`. The handlers set state to `true` / `false`.
  - Native branch: `import NetInfo from '@react-native-community/netinfo'; const unsub = NetInfo.addEventListener(state => setConnected(state.isConnected === true && state.isInternetReachable !== false)); return () => unsub();`.
- Spec 057 precedent followed for the "optimistic-true seed" rule.
- Phoenix Socket path from spec 059 is NOT used — staff app has no realtime subscriptions in v1 (per spec 061 §B7a Q3 architect ruling).

Test plan (own test): mock `@react-native-community/netinfo` and `window.addEventListener` separately; assert hook returns the seed initially, flips on event, cleans up listeners on unmount.

### 6. Navigation shape

React Navigation 6 stack at `src/navigation/RootStack.tsx`. Stack screens (no tab navigator — single linear flow):

```
RootStack
├── SignIn          (entry when authState.kind === 'signed-out')
├── StorePicker     (entry when authState.kind === 'signed-in' AND no active store yet AND stores.length > 1)
└── EODCount        (entry when authState.kind === 'signed-in' AND activeStore set)
```

**Conditional rendering**: `RootStack` renders ONE of three top-level branches based on `useStore(s => s.authState)`. When `kind === 'restoring'`, render the splash. When `kind === 'signed-out'`, render a stack with just `SignIn`. When `kind === 'signed-in'`, render a stack with `StorePicker` + `EODCount` (initialRoute decided by whether activeStore is set).

**Header**:
- `SignIn`: no header (full-screen email/password form).
- `StorePicker`: title "Select your store", no back button.
- `EODCount`: title is the active store name; left header button is "Switch store" (visible only when `stores.length > 1` — no-op text/disabled if `=== 1`); right header button is "Sign out" (with `confirmAction` confirm).

**Sign-out**: clears `activeStore` from AsyncStorage and Zustand, sets `authState = {kind: 'signed-out'}`. The stack-switch re-renders to the `SignIn`-only stack — there's no nav-stack-pop needed because we conditionally swap the stack itself.

**Switch store (from EODCount header)**: sets `activeStore = null` in Zustand, navigates to `StorePicker`. The persisted AsyncStorage `imr-staff:active-store:v1` is cleared once the picker fires (NOT before — so a screen crash mid-switch doesn't lose the prior store).

### 7. i18n scaffold

Mirror imr-inventory's `src/i18n/index.ts` shape but stripped to English-only:

```ts
// src/i18n/index.ts
import en from './en.json';

export function t(key: string, vars?: Record<string, string | number>): string {
  // walk dot-path; return key on miss + console.warn once; {var} substitution.
}
```

Key namespaces (English-only catalog `src/i18n/en.json`):

```
{
  "auth": {
    "signIn.title": "Sign in",
    "signIn.email": "Email",
    "signIn.password": "Password",
    "signIn.submit": "Sign in",
    "error.invalidCreds": "Invalid email or password",
    "error.notStaff": "This app is for staff only",
    "error.noStores": "No store assignments — contact your manager"
  },
  "store.picker": {
    "title": "Select your store",
    "subtitle": "You have access to {count} stores"
  },
  "eod": {
    "header.today": "Today · {weekday}, {monthDay}",
    "vendor.label": "Vendor",
    "submit": "Submit",
    "submit.inFlight": "Submitting...",
    "banner.lastSubmitted": "Last submitted at {time} — your changes will overwrite",
    "toast.submitted": "Submitted",
    "toast.alreadySubmitted": "Already submitted — your counts match the existing submission",
    "toast.failed": "Submission failed — try again",
    "toast.allSynced": "All counts synced",
    "error.forbidden": "Cannot submit for this store — your access has changed. Sign out and back in."
  },
  "chrome": {
    "queue.pending": "{count} pending",
    "queue.queuedRow": "Queued — will sync when online",
    "queue.draining": "Syncing...",
    "queue.needsAttention": "Sync failed — please try again",
    "switchStore": "Switch store",
    "signOut": "Sign out",
    "signOut.confirm": "Sign out? Queued counts will sync next time you sign in.",
    "errorBoundary.title": "Something went wrong",
    "errorBoundary.message": "Your counts are saved. Please restart the app."
  }
}
```

Hook surface: `useI18n()` returns `{t}`. (Trivial in v1; the wrapper exists so cycle-2 can swap in a Zustand-backed locale selector without callsite churn.) Callsites: `const {t} = useI18n();` then `<Text>{t('eod.submit')}</Text>`.

### 8. Test plan

Per Q5, mock at the hook boundary in screen tests.

**Hook tests** (mock the lower layers):
- `src/hooks/useEodSubmit.test.ts` — mocks `supabase.rpc` to return each of the 4 outcomes (200/false, 200/true, error.code='42501', TypeError network-error). Asserts the returned `Outcome` shape AND that queue persistence happens on network-error (verify with mock AsyncStorage). Also asserts `pending` reactive count reflects enqueued items.
- `src/hooks/useConnectionStatus.test.ts` — two `describe` blocks. Web block: mock `window.addEventListener` (jest fn capture handlers, fire `online`/`offline` events synchronously). Native block: mock `@react-native-community/netinfo` (mock the default export's `addEventListener` to capture handler). Assert state flips + cleanup.

**Screen tests** (mock the hooks):
- `src/screens/SignIn.test.tsx` — mocks `supabase.auth.signInWithPassword`; asserts toast on bad creds, navigate-to-picker on success.
- `src/screens/StorePicker.test.tsx` — renders with 2 mocked stores; assert tap routes to EODCount with the selected store. Single-store case: assert auto-skip (or test it at the navigation layer).
- `src/screens/EODCount.test.tsx` — mocks `useEodSubmit`, `useConnectionStatus`. Asserts:
  - decimal-pad input renders per item
  - Submit press calls `submit()` with mapped payload (item_id/count not ingredient_id/actual_remaining at the UI layer)
  - `{kind: 'success'}` → green check + toast
  - `{kind: 'success-replay'}` → "already submitted" toast
  - `{kind: 'forbidden'}` → banner; no auto-sign-out
  - `{kind: 'queued'}` → inline "Queued" indicator + inputs clear
  - Banner shows when `existingSubmission` prop set

**Store/selector tests**:
- `src/store/useStore.test.ts` — assert queue actions (`enqueueEod` / `dequeueEod` / `bumpEodAttempts`) write through to a mocked AsyncStorage. Assert `pending` selector filters by `intent_user_id`. Assert auth-state transitions.

**Queue lib tests**:
- `src/lib/eodQueue.test.ts` — `hydrateQueue()` with: empty storage, valid array, corrupted JSON (assert backup key written), partial-malformed array (assert valid items kept), v1→v2 future migration shape (write a v2 transform stub).

**i18n test**:
- `src/i18n/i18n.test.ts` — assert every key referenced in code exists in `en.json` (key-extraction via grep or a manual list); assert `t('missing.key')` warns once and returns the key.

**Out of scope for jest**: end-to-end with a real Supabase. The imr-inventory backend smoke at `scripts/smoke-staff-eod.sh` already covers the RPC contract.

### 9. Cross-repo development workflow

Operating model:
- Spec 062 lives in `~/Documents/GitHub/imr-staff/specs/062-staff-app-eod-screen.md` and references the backend contract by absolute path:
  - `~/Documents/GitHub/INVENTORY-MANAGEMENT/specs/061-staff-app-eod-count.md` (immutable contract)
  - `~/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql` (RPC signature)
- Frontend developer: `cd ~/Documents/GitHub/imr-staff` and works in that repo. Reads imr-inventory paths for reference only; never edits imr-inventory.
- Reviewers (code-reviewer, security-auditor, test-engineer, backend-architect post-impl): operate cross-repo. They READ code in imr-staff and WRITE review files at `~/Documents/GitHub/imr-staff/specs/062/reviews/<reviewer>.md`. The imr-staff repo needs `specs/062/reviews/` created as part of implementation (mkdir as needed; reviewers create the files themselves).
- release-coordinator: reads `~/Documents/GitHub/imr-staff/specs/062/reviews/*.md` and writes the proposal at `~/Documents/GitHub/imr-staff/specs/062/reviews/release-proposal.md`.

**Spec status mutation**: the Status: field at the top of `062-staff-app-eod-screen.md` is mutated by specialists (frontend-developer sets READY_FOR_REVIEW; release-coordinator does NOT mutate). Routing-layer agents (orchestrator/auditor) never write Status.

**Backend gap handling**: if the frontend developer hits a backend gap mid-build (the RPC envelope differs, an auth helper is missing, a column was renamed), they STOP and surface to the user. The backend contract is immutable for spec 062 — any backend change is a new spec in imr-inventory.

### 10. Browser / preview testing

The frontend developer verifies the staff app via:

1. **Native (primary target)**: `cd ~/Documents/GitHub/imr-staff && npm run ios` (or `android`) via Expo Go or a dev build. Requires the imr-inventory local stack running (`cd ~/Documents/GitHub/INVENTORY-MANAGEMENT && npm run dev:db`) for the shared Supabase. Sign in with `manager@local.test` / `password` per the seed.
2. **Web (developer-iteration only — not the production target)**: `cd ~/Documents/GitHub/imr-staff && npm run web` (script already in package.json). Spec 062's connectivity hook MUST work on web because the dev-iteration loop runs there.

**`.claude/launch.json` in imr-staff**: ADD a launch.json mirroring imr-inventory's pattern (`expo-web` config). Suggested shape:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "expo-web-staff",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["expo", "start", "--web", "--port", "8083"],
      "port": 8083,
      "autoPort": true
    }
  ]
}
```

Port 8083 to avoid collision with imr-inventory's 8081 / 8082 — both stacks running simultaneously is the expected dev workflow.

Reviewer note: launch.json is a `.claude/` artifact that helps the preview tooling (`preview_*` MCP). NOT load-bearing for production. Developer can skip in v1 if their dev loop doesn't need it.

### 11. Risks and tradeoffs

**(a) Cross-repo agent reliability.** The frontend-developer, reviewers, and release-coordinator agents were configured for imr-inventory paths. They may default to imr-inventory absolute paths or misread the spec location. Mitigation: the dispatching prompt MUST explicitly cite the imr-staff path (`~/Documents/GitHub/imr-staff/`) and the spec absolute path. The imr-staff CLAUDE.md is the second line of defense. If a reviewer's review file lands at `~/Documents/GitHub/INVENTORY-MANAGEMENT/specs/062/reviews/<reviewer>.md` instead of `~/Documents/GitHub/imr-staff/specs/062/reviews/<reviewer>.md`, that's a workflow defect — main Claude relocates the file before release-coordinator reads.

**(b) AsyncStorage quota (iOS 6MB).** A single `QueuedSubmission` is ~500 bytes; 6MB ≈ 12,000 queued items. v1 will never approach this — a single shift produces ≤5 submissions, and a queue that's been growing for weeks already triggers needs-attention surfacing at `attempts >= 5`. Bound documented in `src/lib/eodQueue.ts`. No active enforcement in v1.

**(c) Time zone / date capture at SUBMIT vs MOUNT.** A staff member counts at 11:55 PM; clicks Submit at 12:01 AM. Which date does the submission carry?
   - Decision: **date is captured at SUBMIT time, not mount time.** `EODCount.tsx` reads `today_iso` at the moment of the Submit press, not at screen mount.
   - The banner showing "Today · {weekday}, {monthDay}" is mount-time and may be stale by one day. Acceptable — staff are physically present and know what day it is; the date IS a fact at submit time, not a UI snapshot.
   - Same logic applies to vendor switcher derivation (vendor-day filter for today's weekday). Re-derived at submit time. If the user crosses midnight while screen is open, the submit might fail vendor-day validation server-side. Recover: refresh banner or rely on backend's vendor-day permissiveness (spec 007 doesn't enforce server-side, only filters client-side, so this is a soft constraint).
   - Documented in `src/screens/EODCount.tsx` source comment.

**(d) intent_user_id security boundary is soft.** A staff user with browser dev-tools (web preview) could edit AsyncStorage and rewrite `intent_user_id` to inherit a colleague's queue. The drain would then submit under the malicious user's JWT (not the original — `auth.uid()` wins server-side). So the security boundary protects against: (1) accidentally submitting under the wrong user when devices are shared, (2) the original user's queued counts surviving sign-out for replay by themselves on next sign-in. It does NOT protect against active tampering. Acceptable per the threat model — staff users already have legitimate inventory write access via their own JWT; tampering with the queue only changes attribution, not authorization scope.

**(e) `crypto.randomUUID()` availability on React Native.** RN 0.81 ships `Crypto` via `expo-crypto` / Hermes engine global; `crypto.randomUUID()` works on iOS/Android/web in our target versions. If it's not available in a future EAS build, drop in a small polyfill — but DO NOT add a uuid npm dep. Bound in `src/lib/uuid.ts` so the swap is one file.

**(f) Toast library not yet selected.** imr-inventory uses `react-native-toast-message`. The staff app needs a toast (success/error/queued messages). Decision: add `react-native-toast-message` to deps as part of the frontend-developer's first PR — NOT a backend-architect decision, but flagged here so it doesn't get missed. Mount the Toast root in `App.tsx`.

**(g) Vendor-day filter `vendor_day_filter` view/RPC**. Spec 062 §B5 references spec 007's vendor-day filter. Confirm at implementation time whether this is a view or an RPC, and what the calling shape looks like. The vendor list for `(active_store_id, today's weekday)` should be a single query. If spec 007's surface doesn't match cleanly to the staff-app callsite, raise as a new imr-inventory spec — do NOT modify imr-inventory in spec 062.

**(h) Toast on app foreground / drain race.** If the app is foregrounded with both a queue AND a fresh connectivity flip, the "All counts synced" toast can fire mid-screen-transition and feel jarring. Mitigation: debounce the drain-empty toast by 400ms (matches imr-inventory realtime debounce pattern, `useRealtimeSync.ts:400ms`). Drain orchestrator schedules the toast inside a `setTimeout(400)` cleared on next drain start.

**(i) Splash / mount latency.** `restoreSession` + `profiles.role` + `user_stores` fetch is 2-3 round trips. On a cold network, this is 500-2000ms of splash before any screen renders. v1 acceptance: show a minimal centered "I.M.R Staff" loader; do not block sign-in if the role fetch fails (signOut + go to SignIn). Documented in `RootStack` source comment.

### 12. Cross-references

- Backend contract (immutable): `~/Documents/GitHub/INVENTORY-MANAGEMENT/specs/061-staff-app-eod-count.md`
- RPC signature: `~/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql`
- Connectivity hook precedent (event-driven, web-only NetInfo equivalent): `~/Documents/GitHub/INVENTORY-MANAGEMENT/src/hooks/useConnectionStatus.ts`
- i18n shape precedent: `~/Documents/GitHub/INVENTORY-MANAGEMENT/src/i18n/index.ts`
- Spec 057/059 hook-boundary precedent: imr-inventory specs 057 and 059 (search by filename).
- Backend smoke (already covers RPC contract): `~/Documents/GitHub/INVENTORY-MANAGEMENT/scripts/smoke-staff-eod.sh`

## Handoff
next_agent: frontend-developer
prompt: Implement spec 062 against the design contract in this spec. Operate
  cross-repo in `~/Documents/GitHub/imr-staff/` — read backend references at
  `~/Documents/GitHub/INVENTORY-MANAGEMENT/` as cited in §12 but do NOT edit
  imr-inventory. Create `~/Documents/GitHub/imr-staff/specs/062/reviews/` as
  part of the work so reviewers have a target directory. Add
  `react-native-toast-message` to deps per risk (f). Add `.claude/launch.json`
  per §10 (port 8083). After implementation set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - ~/Documents/GitHub/imr-staff/specs/062-staff-app-eod-screen.md
  - ~/Documents/GitHub/INVENTORY-MANAGEMENT/specs/061-staff-app-eod-count.md
  - ~/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql

## Files changed

Implementation cycle 1 (frontend-developer).

**Foundational config**
- `.claude/launch.json` — expo-web preview at port 8083 (§10, avoid 8081/8082 collision)
- `.env.local.example` — local Supabase URL + publishable anon key (mirrors smoke-staff-eod.sh)
- `package.json` — added `react-native-toast-message`, `@testing-library/react-native@13.3.3`, `babel-preset-expo`, `react-test-renderer@19.1.0`, jest config (preset, transformIgnorePatterns, setupFiles)
- `jest.setup.js` — AsyncStorage/NetInfo/Toast/safe-area mocks; RN 0.81 jest-mock compat patches for Text/View/TextInput/ActivityIndicator/FlatList/Pressable (workaround for upstream RN 0.81 `mockComponent.js:42` crash on function components)
- `App.tsx` — rewritten root: SafeAreaProvider → ErrorBoundary → RootStack + Toast root; hydrates queue on mount

**Backend client + utilities**
- `src/lib/supabase.ts` — supabase-js singleton, Platform-conditional AsyncStorage
- `src/lib/eodQueue.ts` — queue hydrate / push / drain / peek / clearQueue + corrupt-payload backup + 30d GC + active-store key helpers; migration contract documented for v1→v2
- `src/lib/types.ts` — `QueuedSubmission`, `Outcome`, `SubmitPayload`, `StaffSubmitEodResponse`, `AuthState`, `ActiveStore`, `UserStore`, `EodItem`, `Vendor`, `EodEntry`, `ExistingSubmission`
- `src/lib/uuid.ts` — crypto.randomUUID with Math.random fallback for test envs
- `src/lib/notifyBackendError.ts` — console.warn + Toast.show error sink
- `src/lib/confirmAction.ts` — cross-platform confirm (window.confirm vs Alert.alert)

**Hooks**
- `src/hooks/useConnectionStatus.ts` — single-file Platform.OS branch inside useEffect; web (navigator.onLine + window events) and native (NetInfo) with optimistic-true seed
- `src/hooks/useEodSubmit.ts` — submit orchestrator + drain coordinator; 4 outcomes (success / success-replay / forbidden / queued / failed); FIFO drain on connectivity flip; intent_user_id boundary; 400ms drain-empty toast debounce

**State**
- `src/store/useStore.ts` — Zustand store with auth / activeStore / eodQueue / draining slices; write-through to AsyncStorage on queue mutations; `pendingCountForUser`, `currentUserId`, `selectStores` selectors

**Screens**
- `src/screens/SignIn.tsx` — email+password form + auth gate (role + user_stores) + active-store restore
- `src/screens/StorePicker.tsx` — vertical store list (tap to select)
- `src/screens/EODCount.tsx` — header (store + today's date) + vendor switcher (order_schedule for today's weekday) + item list (decimal-pad inputs) + submit + pre-fill banner + forbidden banner; date captured at SUBMIT time per §11 risk (c)

**Navigation**
- `src/navigation/RootStack.tsx` — React Navigation 6 stack with conditional branch on authState + activeStore; cold-start `restoreSession()` re-runs the auth gate per §2

**Components**
- `src/components/Button.tsx` — primary/secondary CTA (≥44pt)
- `src/components/Input.tsx` — text input with label + error + ≥44pt
- `src/components/ListRow.tsx` — tap-friendly row (≥60pt)
- `src/components/Banner.tsx` — info/warning/error/success banner
- `src/components/QueueIndicator.tsx` — "{count} pending" / "Syncing..." pill
- `src/components/ErrorBoundary.tsx` — whole-stack log-only fallback

**i18n**
- `src/i18n/en.json` — English catalog (auth, store.picker, eod, chrome namespaces)
- `src/i18n/index.ts` — `t(key, vars)` + `useI18n()` hook + `_resetWarnCache` test helper

**Theme**
- `src/theme.ts` — single-file colors / spacing / radius / typography / touchTarget tokens

**Tests (jest)**
- `src/__mocks__/useEodSubmit.ts` — manual mock for screen tests (§0 Q5)
- `src/lib/eodQueue.test.ts` — hydrate / push / drain / corrupt-payload / 30d GC / active store
- `src/store/useStore.test.ts` — auth transitions / queue mutations / `pendingCountForUser` / selectors
- `src/hooks/useConnectionStatus.test.ts` — web (navigator.onLine + window events) + native (NetInfo) branches
- `src/hooks/useEodSubmit.test.ts` — 4 RPC outcomes + offline-queue + reactive pending count
- `src/screens/SignIn.test.tsx` — bad creds / wrong role / no stores / happy path
- `src/screens/StorePicker.test.tsx` — render + select
- `src/screens/EODCount.test.tsx` — render + submit mapping + 4 outcome UX + vendor switcher + pre-fill banner
- `src/i18n/i18n.test.ts` — key existence + interpolation + missing-key warn

**Reviewer infrastructure**
- `specs/062/reviews/` — empty directory created (reviewers write their findings here)

**Verification**
- `npm install` — clean with new deps (react-native-toast-message, RNTL 13.3.3, react-test-renderer 19.1.0, babel-preset-expo)
- `npm run typecheck` — clean
- `npm test` — 8 suites, 54 tests, all passing
- `npm run web` — expo web dev server boots on port 8083, bundle compiles (573 modules, ~1.4s), HTTP 200 + clean JS bundle

## Files changed (pass 2)

Cycle-2 fix-pass addressing the cycle-1 reviewer findings.

**Critical (from code-reviewer): silent gate-failure redirect**

`RootStack.restoreSession()` wrote a raw i18n key into `authState.toast`,
but no consumer ever read that field — so a user whose role was demoted
since last launch got a silent SignIn redirect with zero context. Fix:
- `src/navigation/RootStack.tsx` — fire `Toast.show` directly with the
  translated `t('auth.error.notStaff')` / `t('auth.error.noStores')` at
  the gate-failure site BEFORE setting `authState: { kind: 'signed-out' }`.
  The `toast` field is no longer written.
- `src/lib/types.ts` — removed the dead `toast?: string` field from the
  `AuthState` 'signed-out' branch. The 'signed-out' shape is now plain;
  callers fire toasts directly at the transition site.
- `src/screens/SignIn.tsx` — removed the `toast: result.message` write
  (cycle-1 line 98). The Toast.show call directly above is the actual
  consumer.
- `src/screens/EODCount.tsx` — removed the `toast: t('chrome.signedOut')`
  write inside `onSignOut` (cycle-1 line 271); replaced with a direct
  `Toast.show` of the translated label before the `signed-out` transition.

**Should-fix bundled in the same pass**

- `src/lib/authGate.ts` — NEW: extracted the role + `user_stores` gate
  logic that was duplicated between `SignIn.runGate` and
  `RootStack.restoreSession`. Single source of truth. Both call sites
  updated. Signs the caller out on hard failures before returning;
  'error' branch leaves the session intact so the user can retry.
- `src/lib/eodQueue.ts` — made `migrateQueueIfNeeded` a true no-op stub
  for the v1 baseline. Previously it called `hydrateQueue()` and threw
  away the result, causing a second AsyncStorage read of the same key
  on every cold start (App.tsx then called `hydrateQueue()` again).
- `src/i18n/en.json` — added `eod.toast.noCountsEntered` key.
- `src/screens/EODCount.tsx` — replaced hardcoded English
  `text2: 'No counts entered'` with `t('eod.toast.noCountsEntered')`.
- `src/i18n/i18n.test.ts` — added `auth.error.generic` and
  `eod.toast.noCountsEntered` to the required-keys list; removed
  `chrome.queue.queuedRow` (no production callsite — the queued-outcome
  toast uses `eod.toast.queued` instead).
- `src/theme.ts` — added `primaryPressedLight` token for the
  translucent secondary-button pressed tint.
- `src/components/Button.tsx` — use `colors.primaryPressedLight`
  instead of the inline `rgba(30,136,229,0.08)` literal.
- `.claude/launch.json` — renamed config `"expo-web"` →
  `"expo-web-staff"` (avoids collision with imr-inventory's launch
  config per spec §10).

**New tests (from code-reviewer + test-engineer coverage gaps)**

- `src/navigation/RootStack.test.tsx` — NEW: cold-start gate behavior
  (AC1.5). 4 tests: non-staff → signOut + toast, no-stores → signOut +
  toast, no-session → silent (no toast spam), happy path → signed-in
  with single-store auto-select. Covers the Critical fix above.
- `src/hooks/useEodSubmit.test.ts` — added:
  - `skips items whose intent_user_id does not match the current user
    (soft boundary)` — exercises the drain-skip path that was untested
    despite being load-bearing for the spec's security boundary
    (test-engineer Should-fix #1).
  - `bumps attempts and continues to the next item on a 5xx drain
    error` — exercises the drain-loop 5xx path (the interactive
    submit's 5xx was already tested; the drain equivalent was not —
    code-reviewer Should-fix).
- `src/screens/EODCount.test.tsx` — added:
  - `captures the date at submit time, not at mount time (spec §11
    risk c)` — mocks `global.Date` to advance from day-1 to day-2
    between mount and Submit press; asserts the submit payload carries
    day-2's ISO date. Closes test-engineer Probe 3 NOT-TESTED gap.

**Skipped this round (per fix-pass scope)**

Code-reviewer Nits 1, 2, 3, 4, 5, 6, 7 (per-item replay toast
suppression during drain, `migrateQueueIfNeeded` comment cleanup,
`RootStack` if/else exhaustion cleanup, `vendor_id` dedup comment,
`eslint-disable-next-line` comment precision, `auth.signIn.title/subtitle`
naming swap, `ListRow` Wrap polymorphism). Also skipped the architect's
cycle-2 follow-ups (drain-trigger integration test, "drain stops on
first network error" doc, jest.setup.js upgrade-fragile tracking) per
spec scope.

**Verification (pass 2)**

- `npm test` — 9 suites, 61 tests passing (up from 8/54).
- `npm run typecheck` — clean.
- `npm run web` — expo web dev server boots on port 8083; bundle
  compiles (94957 lines, no errors); HTTP 200 on `/`; title resolves
  to `<title>I.M.R Staff</title>`.

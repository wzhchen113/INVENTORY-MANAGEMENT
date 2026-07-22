# Spec 136: Notification toggle state doesn't sync across mounted hook instances

Status: READY_FOR_REVIEW

## Problem

On the staff PWA (verified 2026-07-22 by the owner: iPhone, installed
standalone), enabling notifications from the Settings screen flips the Settings
pill to "Notifications · On" (green) correctly, but navigating back to the EOD
Count screen still shows the RED "Turn on notifications to get reminders" banner
and the RED dot on the Settings gear. The owner asked whether push even works.

Push DOES work: a prod `push_subscriptions` row was saved for the staff account
at the moment of enabling (Apple iOS PWA endpoint), and the `eod-reminder-cron`
edge function is already delivering nightly reminders to other subscribed users.
The bug is UI-only — stale per-instance state.

### Verified root cause

`src/lib/useNotificationToggle.ts` (spec 118, the shared toggle hook) holds
PER-INSTANCE React state. Every surface that shows notification status mounts
its OWN hook instance:

- staff Settings `NotificationSwitcher`
  (`src/screens/staff/components/NotificationSwitcher.tsx`)
- `NotificationReminderBanner`
  (`src/screens/staff/components/NotificationReminderBanner.tsx`) — mounted on
  all four in-store screens (EODCount / Reorder / WeeklyCount / Receiving)
- `SettingsGear` red/green dot (`src/screens/staff/components/SettingsGear.tsx`)
- admin `NotificationToggle` (`src/components/cmd/NotificationToggle.tsx`)

Each instance re-probes browser push state ONLY on mount and on
`document.visibilitychange` (hook lines 75-83). The staff bottom-tab navigator
lazy-mounts then KEEPS in-store screens mounted, and stack navigation
Settings → back does NOT fire `visibilitychange`. So the banner/gear-dot
instances keep their pre-enable "off" probe result until the app is backgrounded
and reopened. The `NotificationReminderBanner.tsx` header comment claiming "Only
one screen is mounted at a time via the tab navigator" is factually wrong and is
the assumption that produced this bug.

## User story

As a staff member on the PWA, when I enable notifications in Settings, I want the
red reminder banner and the red gear dot on the in-store screens to clear
immediately when I navigate back, so I can trust that notifications are on and am
not nagged by a stale warning.

## Acceptance criteria

- [ ] After one mounted `useNotificationToggle` instance completes an enable
      action, every OTHER mounted instance re-probes and updates its `view`
      WITHOUT any `document.visibilitychange` event and without the app being
      backgrounded/reopened.
- [ ] After one mounted instance completes a disable action, every other mounted
      instance re-probes and updates its `view` the same way.
- [ ] The instance that performed the action still shows its just-set transient
      `message` (e.g. an enable-failure message) — the broadcast it emits MUST
      NOT clear its own transient message. Regression guard on the spec-118
      "preserve the just-set message" fix (hook lines 85-95).
- [ ] Concretely on the staff PWA: enabling notifications from the Settings
      `NotificationSwitcher`, then navigating back to EODCount, shows NO red
      reminder banner and a GREEN (not red) `SettingsGear` dot, with no
      background/reopen and no manual refresh.
- [ ] The stale "Only one screen is mounted at a time via the tab navigator"
      comment block in `NotificationReminderBanner.tsx` is corrected to state
      that in-store screens stay mounted and cross-instance sync is handled by
      the hook's broadcast.
- [ ] jest track: a test renders TWO `useNotificationToggle` instances; instance
      A performs enable; instance B's `view` flips to `'on'` without any
      `visibilitychange` event dispatched.
- [ ] jest track: a test asserts the acting instance's transient `message` is
      preserved through its own post-action broadcast (does not get cleared by
      the broadcast it emits).

## In scope

- A module-scoped listener registry inside `src/lib/useNotificationToggle.ts`:
  each hook instance registers a re-probe callback on mount and unregisters on
  unmount; after any enable/disable action completes, the acting instance
  broadcasts to all OTHER registered instances so they re-probe immediately.
- The acting instance re-probes itself via its existing `refresh(false)` path
  (preserving its just-set message); the broadcast targets only the OTHER
  instances, which re-probe authoritatively (`refresh(true)`, clearing any stale
  transient message — they have none they need to keep).
- Correcting the stale comment in `NotificationReminderBanner.tsx`.
- jest tests per the acceptance criteria.

## Out of scope (explicitly)

- Any change to `src/lib/webPush.ts` subscribe/unsubscribe logic. Rationale: push
  works; only the cross-instance UI sync is broken.
- Any change to `eod-reminder-cron` or any edge function. Rationale: delivery
  works.
- Any change to the `notificationLevel` mapping or `notificationState.ts`
  reducer/code map. Rationale: the derivation is correct; the inputs are stale.
- Any backend / schema / migration / RPC change. Rationale: frontend-only bug.
- Any native (EAS) behavior change. Rationale: the bug and fix are web-push /
  browser-state specific (the hook already early-returns on non-web for the
  `visibilitychange` listener); the broadcast registry is platform-neutral but
  changes no native behavior.
- Coupling the shared hook to `@react-navigation` focus events. Rationale: the
  hook is also used by the admin surface which navigates through the Cmd shell,
  not the staff stack — a navigation-focus re-probe would couple the shared hook
  to one surface's navigator. Flagged below as an open question the architect may
  reconsider as a belt-and-suspenders addition if it can be done without that
  coupling.

## Open questions resolved

- Q: Broadcast to all instances including the acting one, or all-but-acting?
  → A (PM default): the acting instance re-probes ITSELF via its existing
    `refresh(false)` (message-preserving) path; the broadcast fires to all OTHER
    instances with the message-clearing `refresh(true)`. This satisfies the
    "preserve just-set message on the acting instance" AC while giving every
    other instance an authoritative fresh probe.
- Q: Also re-probe on navigation focus (belt-and-suspenders)?
  → A (PM default): NOT in this spec, to avoid coupling the shared hook to
    react-navigation (the admin surface navigates differently). Left as an
    architect-discretion open question — if a decoupled focus re-probe is cheap
    (e.g. the staff surfaces already re-probe on their own mount), the architect
    may add it, but the module-scoped broadcast is the primary fix and is
    sufficient on its own.
- Q: Does the admin `NotificationToggle` need any change?
  → A (PM default): no direct edit — it consumes the same hook, so it inherits
    the cross-instance sync for free. It is listed only so reviewers confirm the
    shared-hook change doesn't regress the admin pill.
- Q: Persist anything?
  → A (PM default): no. The registry is in-memory module scope; probe state is
    always re-derived from the live browser API. No storage, no backend field.

## Dependencies

- None beyond the existing `useNotificationToggle` hook and its four consumer
  components. No migration, no RPC, no edge function, no store change.

## Project-specific notes

- Cmd UI section / legacy: not a Cmd section — this is the staff surface
  (`src/screens/staff/components/`) plus the shared hook in `src/lib/`. The admin
  `NotificationToggle` (`src/components/cmd/`) consumes the same hook and is
  affected transitively but not edited.
- Per-store or admin-global: neither — per-DEVICE browser push state. No data
  access, no RLS interaction.
- Realtime channels touched: none. This is in-memory cross-component sync within
  a single client, NOT Supabase realtime. Do not confuse the module-scoped
  listener registry with the `store-{id}` / `brand-{id}` realtime channels.
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: the observable bug is web (PWA) only — the `visibilitychange`
  gap is browser-specific and the hook already guards `Platform.OS !== 'web'`.
  The module-scoped registry is platform-neutral and must not change native
  behavior; the fix ships to Vercel (web). No `app.json` / slug impact.
- Tests: jest track only (two-instance hook render + broadcast assertion, and the
  acting-instance message-preservation guard). No pgTAP, no shell smoke.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. It is frontend-only (no backend
  surface), so the design should pin the module-scoped listener registry shape in
  src/lib/useNotificationToggle.ts — registration/unregistration lifecycle, the
  broadcast trigger points (after enable and after disable complete), and the
  acting-vs-other-instances refresh split (acting instance keeps refresh(false)
  message-preserving; others get refresh(true)). Confirm the jest approach for
  asserting cross-instance sync without a visibilitychange event, and rule on the
  optional decoupled navigation-focus re-probe open question. Then set
  Status: READY_FOR_BUILD.
payload_paths:
  - specs/136-notification-toggle-cross-instance-sync.md

---

## Backend design

**Frontend-only. No backend surface.** This spec touches ZERO backend: no
schema, no column, no index, no migration, no RPC, no PostgREST view, no edge
function, no RLS policy, no `supabase_realtime` publication membership. The
"registry" here is an in-memory, module-scoped JS object living inside one
`src/lib/*.ts` file — it is NOT Supabase Realtime and does not touch the
`store-{id}` / `brand-{id}` channels. The following sections that would normally
carry data-model / RLS / API-contract / edge-function content are explicitly
**N/A** and recorded as such so a reviewer can confirm nothing was missed:

- **Data model changes.** N/A — no tables/columns/indexes; no migration file.
- **RLS impact.** N/A — no store-scoped or admin-only table is read or written.
  Notification state is derived per-device from live browser APIs
  (`Notification.permission`, the service-worker `PushSubscription`), never from
  a DB row. The existing `push_subscriptions` write path (`webPush.ts`) is
  explicitly out of scope and unchanged.
- **API contract.** N/A — no PostgREST/RPC decision; the fix is entirely inside
  a React hook and one component comment.
- **Edge function changes.** N/A — no function new or modified; no `verify_jwt`
  decision.
- **`src/lib/db.ts` surface.** N/A — no new `db.ts` helper. The changed hook
  (`src/lib/useNotificationToggle.ts`) already lives in `src/lib/` but performs
  NO PostgREST/RPC traffic, so the "all DB access flows through db.ts" rule does
  not engage. Nothing in this spec may add a `supabase.from/rpc` call.
- **Realtime impact.** N/A — no publication change, therefore **no**
  `docker restart supabase_realtime_imr-inventory` dev step. Cross-instance sync
  is achieved by an in-process listener registry, deliberately NOT by Realtime
  (per spec §Project-specific notes).
- **Frontend store impact.** N/A — no `useStore.ts` / `useStaffStore.ts` slice
  changes. The consumers read `currentStaffUserId(s.authState)` (staff) /
  `s.currentUser?.id` (admin) as they already do; the optimistic-then-revert +
  `notifyBackendError` pattern does not apply (there is no backend write to
  revert).

### 1. Module-scoped listener registry — `src/lib/useNotificationToggle.ts`

The whole fix is a module-scoped re-probe registry plus a broadcast on
action-completion. Design pinned below.

**Module scope (outside the hook, single shared instance per JS bundle):**

```ts
// A re-probe listener is a zero-arg trigger that authoritatively re-probes
// (refresh(true)) the instance that registered it.
type ReprobeListener = () => void;
const reprobeListeners = new Set<ReprobeListener>();

// Fire every registered listener EXCEPT the acting instance's own. The acting
// instance is excluded so its just-set transient message survives — it re-probes
// itself via the message-preserving refresh(false) path (AC (c) / spec-118 guard).
function broadcastReprobe(except: ReprobeListener): void {
  for (const listener of reprobeListeners) {
    if (listener !== except) listener();
  }
}
```

`Set` (not array) so identity-based add/delete/exclude are O(1) and a
double-register (shouldn't happen, but StrictMode double-invoke could) is
idempotent.

**Per-instance listener identity — the exclusion token.** Inside the hook,
derive one stable per-instance callback that both (a) is the registry entry and
(b) is the self-exclusion token passed to `broadcastReprobe`. Because it is the
same reference in the `Set` and in the `except` argument, self-exclusion is exact.

```ts
// Stable per instance: refresh is useCallback([]) so its identity is stable,
// making reprobe stable too. This is the registry key AND the self-token.
const reprobe = useCallback(() => {
  void refresh(true); // authoritative: clears any stale transient message
}, [refresh]);
```

**Registration / unregistration lifecycle — tied to `refresh`/`reprobe`
identity.** Fold registration into the EXISTING mount effect (hook lines 75-83),
keeping its dependency on the stable `refresh`. Critical ordering constraint:
the registry add/delete MUST sit BEFORE the web-only early-return guard, and the
cleanup MUST always delete — otherwise (i) native/SSR instances would register
but never unregister (leak), and (ii) the node-env jest unit test (§2) could not
exercise the registry at all because it early-returns on `typeof document ===
'undefined'`. The registry is platform-neutral by design; only the
`visibilitychange` listener stays web-guarded.

```ts
useEffect(() => {
  reprobeListeners.add(reprobe);            // BEFORE the web guard
  void refresh(true);                       // existing mount probe (unchanged)

  let removeVis: (() => void) | undefined;
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const onVis = () => {
      if (document.visibilityState === 'visible') void refresh(true);
    };
    document.addEventListener('visibilitychange', onVis);
    removeVis = () => document.removeEventListener('visibilitychange', onVis);
  }

  return () => {
    reprobeListeners.delete(reprobe);       // ALWAYS unregister
    removeVis?.();
  };
}, [refresh, reprobe]);
```

`refresh` is `useCallback([])`-stable and `reprobe` is `useCallback([refresh])`-
stable, so this effect runs exactly once per mount and cleans up exactly once per
unmount — no churn, no duplicate registrations.

**Broadcast trigger points — after enable completes AND after disable
completes.** Append exactly one `broadcastReprobe(reprobe)` call to each handler,
positioned AFTER the acting instance's own `await refresh(false)` and BEFORE (or
either side of) `setBusy(false)` — the ordering vs `setBusy` is immaterial since
the broadcast targets other instances only:

```ts
const enable = useCallback(async () => {
  if (!userId) return;
  setBusy(true);
  setMessage(null);
  const res = await requestPermissionAndSubscribe(userId);
  if (!res.ok) setMessage(translate(`chrome.notifications.msg.${subscribeCodeToMessageKey(res.code)}`));
  await refresh(false);        // acting instance: preserve just-set message
  broadcastReprobe(reprobe);   // OTHER instances: authoritative refresh(true)
  setBusy(false);
}, [userId, refresh, reprobe, translate]);

const disable = useCallback(async () => {
  setBusy(true);
  setMessage(null);
  await unsubscribeFromPush();
  await refresh(false);
  broadcastReprobe(reprobe);   // OTHER instances: authoritative refresh(true)
  setBusy(false);
}, [refresh, reprobe]);
```

**The acting-vs-others split (the load-bearing invariant):**

| Instance | Path | Message behavior |
|----------|------|------------------|
| Acting (performed enable/disable) | its own `await refresh(false)` | PRESERVES the just-set transient message (spec-118 fix, AC (c)) — excluded from the broadcast via the `except` token |
| All OTHER mounted instances | `broadcastReprobe` → each runs `refresh(true)` | authoritative fresh probe, CLEARS any stale transient message (they hold none they need to keep) |

Because `reprobe` is passed as `except`, the acting instance's own registry entry
is skipped, so its broadcast can never clear its own message — this is the exact
mechanism that satisfies AC (c) and the corresponding jest guard.

**New dependency-array entries.** `enable`, `disable`, and the mount `useEffect`
gain `reprobe` in their dependency arrays. `reprobe` is stable, so this does not
introduce re-subscription churn; it is required for lint-correctness
(`react-hooks/exhaustive-deps`).

### 2. jest approach (Track 1 unit, `node` env)

Colocated `src/lib/useNotificationToggle.test.ts`. This is a `src/lib/**`
unit test, so it runs in the **unit** jest project (node env) per
`tests/README.md` — and that is exactly why the registry must not be
web-guarded: the node env has no `document`, so the `visibilitychange` path is
inert and the ONLY cross-instance mechanism under test is the registry. The
"without any `visibilitychange` event" AC is satisfied structurally — the test
never dispatches one, and in node there is no `document` to dispatch on.

**Mock boundaries (hybrid-mocking: mock the module-under-test's collaborators):**

- `jest.mock('./webPush', ...)` — stub `requestPermissionAndSubscribe`
  (`jest.fn`, default `{ ok: true }`; overridable to `{ ok: false, code:
  'permission-denied' }` for the message-preservation case) and
  `unsubscribeFromPush` (`jest.fn().mockResolvedValue(undefined)`). No real push
  stack, no network.
- `jest.mock('./notificationState', ...)` via `jest.requireActual` — keep the
  PURE `deriveNotificationState` + `subscribeCodeToMessageKey` REAL (they carry
  the view derivation and are already unit-tested), and override ONLY the impure
  `probeNotificationState` with a `jest.fn` whose resolved `DeriveInput` the test
  flips between an "off" snapshot (`permission:'default'`/no subscription) and an
  "on" snapshot (`capable:true, permission:'granted', hasSubscription:true`).
  This is the `notificationState` boundary the spec's handoff names.
- `translate` passed to the hook is an identity stub `(k) => k`, so `body`
  equals the message KEY and assertions read cleanly.

**Test A — cross-instance sync (AC (a)/(b) + the jest-track AC):** render TWO
hook consumers sharing the module registry. Two `renderHook(() =>
useNotificationToggle('u1', t))` calls (A and B) suffice — the registry is module
state shared across both. Start with `probeNotificationState` returning the "off"
snapshot (both views settle `'off'`). Flip the mock to the "on" snapshot, then
drive instance A's enable inside `act`:

```ts
await act(async () => { A.result.current.onPress(); });
// onPress → enable() → requestPermissionAndSubscribe {ok:true}
//   → A.refresh(false) (A → 'on')  → broadcastReprobe(exceptA)
//   → B.reprobe → B.refresh(true) (B → 'on')
await waitFor(() => expect(B.result.current.view).toBe('on'));
```

Assert B flipped to `'on'` with **no** `visibilitychange` dispatched and no
remount. (`onPress` is fire-and-forget `() => void enable()`; wrapping the call
in `act` and then `waitFor` on B's derived view flushes the mocked async chain
without needing the hook to return the promise.) A disable variant mirrors this
for AC (b).

**Test B — acting-instance message preservation (AC (c) + its jest-track AC):**
override `requestPermissionAndSubscribe` to `{ ok: false, code:
'permission-denied' }` and keep `probeNotificationState` on the "off" snapshot.
Render A (optionally B too). Drive A's enable via `act`. After the chain settles,
assert `A.result.current.body === 'chrome.notifications.msg.denied'` — i.e. the
message A set survived A's OWN `broadcastReprobe(exceptA)` because A is excluded
from its own broadcast. If B is present, assert B carries NO transient message
(its `refresh(true)` cleared to the derived `viewMessage`), proving the split
direction both ways.

No pgTAP, no shell smoke, no E2E (per spec §Tests). The observable PWA behavior
is already covered structurally by these two unit tests; a Playwright reproduction
would require a real service-worker push subscription, which the E2E suite
explicitly excludes as native/push surface.

### 3. Navigation-focus re-probe open question — RULING: OUT

Recommend NOT adding a navigation-focus re-probe, confirming the PM default.
Rationale:

1. The module-scoped broadcast fully covers the reported bug. The in-store
   screens (EODCount / Reorder / WeeklyCount / Receiving) stay MOUNTED
   simultaneously (that is the root cause), so every banner/gear instance is a
   live registered listener and receives the broadcast the instant the Settings
   `NotificationSwitcher` completes enable/disable — no focus event needed.
2. The shared hook is also consumed by the admin `NotificationToggle` through the
   Cmd shell, which does NOT use the staff stack's navigator. Importing
   `@react-navigation` (e.g. `useFocusEffect`) into `src/lib/useNotificationToggle.ts`
   would couple the shared hook to one surface's navigator — explicitly forbidden
   by spec §Out-of-scope and the handoff. A decoupled alternative (each staff
   consumer wiring its own `useFocusEffect`) adds per-consumer surface for zero
   marginal coverage over the broadcast.
3. The one theoretical gap a focus-reprobe would close — an instance that mounts
   AFTER the action fired and thus missed the broadcast — is ALREADY closed by
   the existing mount effect, which calls `refresh(true)` on every mount. A
   late-mounting instance self-probes fresh regardless. There is no residual gap
   for a focus-reprobe to fill.

Decision: broadcast registry is the sole and sufficient fix; no navigation
coupling.

### 4. Stale comment fix — `NotificationReminderBanner.tsx`

Correct the header-comment block (lines 12-17), specifically the sentence
"Only one screen is mounted at a time via the tab navigator, so this is a single
live probe." That claim is the false assumption that produced this bug. Replace
it with language stating that the four in-store screens stay MOUNTED
simultaneously (the tab navigator lazy-mounts then keeps them), so multiple
`useNotificationToggle` instances are live at once, and cross-instance
consistency is guaranteed by the hook's module-scoped re-probe broadcast (this
spec, 136) rather than by single-instance mounting. Comment-only change; no
behavior change in this file. No edit to `SettingsGear.tsx`,
`NotificationSwitcher.tsx`, or the admin `NotificationToggle.tsx` — all three
inherit the fix transitively through the shared hook (confirmed per spec Open
Questions; listed only so reviewers verify no regression to the admin pill).

### Risks and tradeoffs

- **Module-scoped mutable state across bundles.** The registry is per-JS-bundle
  singleton state. Admin and staff surfaces are the same web bundle (RoleRouter),
  so a single registry is correct. Low risk; no SSR concern (Vercel ships a
  client SPA).
- **StrictMode / double-invoke.** React 19 StrictMode double-invokes effects in
  dev. `Set` add is idempotent and cleanup deletes by identity, so a
  double-mount/unmount cannot leak or double-fire. No production impact (StrictMode
  is dev-only).
- **Broadcast fan-out cost.** Bounded by the number of mounted toggle instances
  (≤ ~4 in practice). Each listener is a cheap `refresh(true)` (one browser probe
  + one `setState`). Negligible; unrelated to the 286 KB seed (no DB read).
- **Dependency-array correctness.** Adding `reprobe` to `enable`/`disable`/effect
  deps is required for `exhaustive-deps`; because `reprobe` is stable it does not
  cause handler-identity churn in the presentational consumers.
- **Ordering constraint is load-bearing.** If a future edit moves the registry
  `add`/`delete` back inside the web-only guard, native instances leak and the
  node-env unit test silently stops exercising the registry (green-but-vacuous).
  The §1 code sketch places them before the guard deliberately; the unit test in
  §2 is the guard against that regression.
- **No native behavior change.** Native instances register/unregister and derive
  `unsupported` exactly as before; the broadcast is a no-op-equivalent there.

## Handoff
next_agent: frontend-developer
prompt: Implement against the ## Backend design in this spec. It is
  frontend-only — the entire change is (1) the module-scoped re-probe registry +
  broadcast in src/lib/useNotificationToggle.ts (registration folded into the
  existing mount effect BEFORE the web-only guard; broadcastReprobe(reprobe)
  appended after refresh(false) in both enable and disable; acting instance
  excluded via the reprobe token so its transient message survives), (2) the
  stale comment fix in src/screens/staff/components/NotificationReminderBanner.tsx,
  and (3) the colocated jest unit test src/lib/useNotificationToggle.test.ts with
  the two cases (cross-instance sync without a visibilitychange event; acting-
  instance message preservation), mocking at the webPush + notificationState
  boundaries per tests/README.md. Do NOT add react-navigation to the shared hook,
  do NOT touch webPush/notificationState logic, and do NOT add any
  supabase.from/rpc call. After implementation set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - specs/136-notification-toggle-cross-instance-sync.md

---

## Files changed

- `src/lib/useNotificationToggle.ts` — added the module-scoped re-probe
  registry (`Set<ReprobeListener>` + `broadcastReprobe(except)`); added the
  stable per-instance `reprobe = useCallback(() => void refresh(true), [refresh])`
  used as both the registry key and the self-exclusion token; folded
  registration into the mount effect BEFORE the web-only `document` guard with a
  cleanup that always `delete`s; appended `broadcastReprobe(reprobe)` after
  `refresh(false)` in both `enable` and `disable`; added `reprobe` to the
  `enable`/`disable`/effect dependency arrays.
- `src/screens/staff/components/NotificationReminderBanner.tsx` — corrected the
  stale "Only one screen is mounted at a time" header comment to state the
  in-store screens stay mounted and cross-instance sync is handled by the hook's
  spec-136 broadcast (comment-only; no behavior change).
- `src/lib/useNotificationToggle.test.ts` — NEW. Two `renderHook` consumers
  sharing the module registry. Mocks `./webPush` and partial-mocks
  `./notificationState` (real `deriveNotificationState` + `subscribeCodeToMessageKey`,
  stubbed `probeNotificationState`), forces `Platform.OS = 'web'`. Test A:
  instance A enables → B flips to `'on'` with no `visibilitychange` dispatched
  (plus a disable mirror). Test B: the acting instance's transient
  `permission-denied` message survives its own broadcast while B carries no
  transient message.
- `jest.config.js` — added `<rootDir>/src/lib/**/*.test.tsx` to BOTH the `unit`
  (node) and `component` (jsdom) project `testMatch` arrays. Required because the
  existing `src/lib/**/*.test.ts` glob does not match a `.tsx` file, so the
  spec-named test would otherwise match no project and run vacuously. The test is
  written to pass in both environments (registry is platform-neutral; the
  `visibilitychange` path is inert when never dispatched).

## Implementation notes for reviewers

- **jest.config.js touch (beyond the three files the spec named).** A
  `.test.tsx` under `src/lib/` matches NEITHER jest project as configured (unit =
  `*.test.ts`; component = `src/components`/`src/screens` only). Verified
  empirically with a throwaway probe file. To honor the architect's `.tsx`
  filename AND have the test actually execute (AC requires a real two-instance
  render), the glob had to be added to the projects. Per the build instruction
  the suite now runs in both projects and passes in both — 6 tests (3 × 2
  projects).
- **Browser verification not performed for the cross-instance push flow.** The
  observable behavior requires a real service-worker `PushSubscription` (VAPID +
  installed PWA), which the architect explicitly excluded from browser/E2E
  coverage (§2). This session also has no `preview_*` browser-driving tools. The
  behavior is covered structurally by the two-project unit suite; the full active
  app graph type-checks (`tsc --noEmit`, exit 0) confirming the hook change
  introduces no import/runtime regression in its four consumers, and the Metro
  web dev server serves 200.

## Verification results

- `npx tsc --noEmit` → exit 0.
- `npx tsc -p tsconfig.test.json --noEmit` → exit 0.
- Full `npx jest` (real exit code, not piped through grep) → exit 0; 129 suites,
  1369 tests passed. New suite `src/lib/useNotificationToggle.test.ts` passes in
  both the `unit` and `component` projects (6 tests total).


## Post-review fast-follow (applied before commit)

Code-reviewer Should-fix, test-engineer concurring: the new test contains no
JSX, so it was renamed `useNotificationToggle.test.ts` — the pre-existing
`src/lib` unit-test glob picks it up (single project, no redundant double
execution) and the `jest.config.js` testMatch expansion was reverted. Suite
after cleanup: 128 suites / 1366 tests, green, exit 0.

# Spec 118: PWA per-device notification enable/disable

Status: READY_FOR_REVIEW

## User story
As a store manager or staff member using the PWA on my phone, I want a toggle
to enable and disable background notifications **on this specific device**, so
that I only receive EOD/vendor-order reminders on the device(s) I choose —
signing in on a second phone or tablet does NOT start pushing to it, and turning
notifications on/off on one device never affects any other device where I'm
signed in.

## Context / core gap
The per-device subscription mechanics already exist (`src/lib/webPush.ts`,
`public/sw.js`, `push_subscriptions` table, `eod-reminder-cron` +
`weekly-reminder-cron`). The gap: `requestPermissionAndSubscribe` is **never
called anywhere in the app**. `App.tsx:338` only registers the service worker;
nothing prompts OS permission or creates a subscription. Result: a fresh sign-in
on a phone gets NO push (only per-user email fallback if targeted). This spec
wires the UI on both surfaces, handles all `SubscribeResult` states, adds iOS
install guidance, and resolves the `notifications_enabled` schema drift.

The per-device model is already correct at the data layer: `push_subscriptions`
holds one row per `(user_id, endpoint)` = one row per browser/device. "Enabled
on this device" == "this browser holds an active subscription whose row exists".

## Acceptance criteria
- [ ] **(a) Enable/disable act on THIS device only.** Turning the toggle ON
      invokes `requestPermissionAndSubscribe(userId)` from a user gesture; on
      `{ ok: true }` a `push_subscriptions` row exists for this endpoint and the
      toggle shows "On". Turning the toggle OFF invokes `unsubscribeFromPush()`,
      after which `pushManager.getSubscription()` returns null, the endpoint's
      `push_subscriptions` row is deleted, and the toggle shows "Off". Neither
      action touches any other endpoint/device row.
- [ ] **(b) Displayed state derives from THIS browser's live state.** The
      toggle's On/Off state is computed from `getPushPermission()` +
      `registration.pushManager.getSubscription()`: "On" iff permission is
      `granted` AND a live `PushSubscription` exists; "Off" otherwise. The toggle
      never reads a per-user DB flag to decide its own state. Consequence
      (testable): for one `user_id` with two endpoints in `push_subscriptions`,
      enabling on device A creates exactly one row (A's endpoint) and does NOT
      create/delete any row for device B; device B's toggle continues to read
      "Off".
- [ ] Signing in does NOT auto-subscribe: after a fresh login with no prior
      subscription on this device, the toggle reads "Off" and no
      `push_subscriptions` row exists for this endpoint until the user toggles ON.
- [ ] **(c) Each `SubscribeResult` code maps to a specific user-facing message**
      (not a generic error):
      - `unsupported` → "Notifications aren't available in this browser." When the
        UA is iOS Safari in a NON-installed (tab) context, show instead the iOS
        install state: **"Add this app to your Home Screen to enable
        notifications"** with brief Share → Add to Home Screen steps.
      - `permission-denied` → "Notifications are blocked. Re-enable them in your
        device/browser settings, then try again." (toggle stays Off; retry offered).
      - `permission-default` → user dismissed the OS prompt; toggle stays Off,
        retry available.
      - `no-vapid` → "Notifications are misconfigured on the server." (logged;
        distinct copy so support can spot a config gap).
      - `sw-register-failed` / `subscribe-failed` / `subscription-incomplete` /
        `save-failed` → generic retryable "Couldn't enable notifications. Try
        again." with the code available in the console warning.
- [ ] iOS guidance detail: when running on iOS in a Safari tab (not installed —
      detectable via `navigator.standalone === false` on iOS UA), the toggle
      surfaces the "Add to Home Screen" state above instead of silently failing.
      When the PWA IS installed (standalone) on iOS 16.4+, the normal enable flow
      runs.
- [ ] **(d) Both surfaces get their own toggle + i18n keys.** A toggle component
      renders in the **staff PWA** (`src/screens/staff/`, alongside
      `LocaleSwitcher` / `ScaleSwitcher` in the screen header(s)) AND in the
      **admin Cmd UI** (`src/components/cmd/` / `ResponsiveCmdShell`). Each surface
      has its own component and its own i18n keys in its own catalog (staff i18n
      catalog; cmd chrome catalog), consistent with how the existing switchers are
      duplicated per surface.
- [ ] **Drift resolved (Option A — per-device pure).** The
      `.eq('notifications_enabled', false)` opt-out query and the `optedOutUserIds`
      filter are removed from **both** `eod-reminder-cron` and
      `weekly-reminder-cron`. After this change neither cron references
      `profiles.notifications_enabled`, so the per-run non-fatal caught error is
      gone. No new migration is required (the column is already absent in prod);
      the historical migration file `20260427023804_notifications_enabled.sql` is
      documented as inert (recorded in `schema_migrations`, column never created,
      no longer referenced by any code path).
- [ ] Email fallback behavior preserved: a *targeted* user (admin/master or store
      member) with ZERO working push subscriptions STILL receives the Resend email
      fallback. Disabling push on all of a user's devices does not suppress email.
- [ ] Tests: at least one jest test per surface (or a shared test) on the toggle's
      state-derivation logic (permission + subscription → On/Off, and the
      iOS-not-installed branch) with `Platform`/`navigator` mocked. No pgTAP is
      required since the drift fix is code-only (no SQL change). (Test tracks per
      spec 022.)

## In scope
- A per-device notification toggle component on BOTH the staff PWA and the admin
  Cmd UI, each wired to the existing `requestPermissionAndSubscribe` /
  `unsubscribeFromPush` helpers.
- Deriving each toggle's display state from live browser permission + subscription.
- Full `SubscribeResult`-code-to-message mapping and retry affordance.
- iOS "Add to Home Screen" install guidance for the tab-vs-installed case.
- Removing the `notifications_enabled` filter from both crons (drift fix, code-only).
- i18n strings for the new copy in BOTH catalogs (staff i18n + cmd chrome i18n).

## Out of scope (explicitly)
- Native (EAS) push. PWA/web-push only — no native app exists yet. Rationale:
  owner scoped this to the PWA; the expo-notifications native path is a separate spec.
- Changing the cron schedule, bucket logic, dedup, or reminder wording. Rationale:
  reminder engine works; this spec only changes the opt-in model.
- A per-user global "mute everything including email" control (Options B/C were not
  chosen). Rationale: owner chose per-device-pure (Option A); a global kill switch
  is a separate feature if ever wanted.
- Expanding the cron's target audience beyond today's `admin`/`master` + store
  members. Rationale: scope creep; staff assigned to a store are already store
  members and already targeted.
- Per-notification-type preferences (EOD on / vendor off). Rationale: owner asked
  for a single device-level on/off.
- Reworking `push_subscriptions` schema or the service worker. Rationale: already
  per-device and already delivering.
- Auto-prompting for permission on app load. Rationale: must be a user gesture, and
  owner wants sign-in to NOT auto-enable.
- Dropping the `notifications_enabled` column via a new migration. Rationale: the
  column is already absent in prod; removing the cron reference is sufficient and a
  DROP migration would be a pure no-op. The historical migration file stays as an
  inert historical record.

## Open questions resolved
- Q1 (toggle surface): **BOTH** — the staff PWA (next to LocaleSwitcher /
  ScaleSwitcher) AND the admin Cmd UI. Both audiences get a per-device toggle on
  their own device. Each surface gets its own component + i18n keys.
- Q2 (per-user kill switch + email + drift fix): **Option A — per-device pure.**
  Retire the `notifications_enabled` per-user filter entirely. A device with no
  subscription gets no push; a targeted user with zero working push subs STILL
  gets the email fallback (email stays on). Drift disposed of by removing the
  cron's filter query — no new migration required; the column is already absent in
  prod. Historical migration `20260427023804_notifications_enabled.sql` is now
  inert and documented as such.
- Q (cron audience — should STAFF receive EOD reminders?): **No change.** Staff
  assigned to a store are already `user_stores` members and already in
  `eligibleUsersForStore`. This feature does not widen the cron audience.
- Q (does logout affect this?): No change needed. `useStore` logout
  (`src/store/useStore.ts:753`) already calls `unsubscribeFromPush()`, tearing down
  this device's subscription on sign-out — consistent with the per-device model and
  "signing in does not auto-enable". After logout/login on the same device the
  toggle correctly reads "Off" until re-enabled.
- Q (prompt on load?): **No** — permission is requested only from the toggle's user
  gesture.

## Dependencies
- `src/lib/webPush.ts` — `getPushPermission`, `registerServiceWorker`,
  `requestPermissionAndSubscribe`, `unsubscribeFromPush`, `SubscribeResult` (all
  exist; consumed as-is, no signature change expected).
- `public/sw.js` — existing service worker (no change).
- `push_subscriptions` table (exists; no schema change).
- `supabase/functions/eod-reminder-cron/index.ts` and
  `supabase/functions/weekly-reminder-cron/index.ts` — remove the
  `notifications_enabled` filter query and the `optedOutUserIds` set + its
  `!optedOutUserIds.has(u)` usages.
- i18n catalogs: staff i18n catalog (`src/screens/staff/i18n/`) AND cmd chrome
  catalog — new keys for the toggle label, On/Off state, and each message above.
- `EXPO_PUBLIC_VAPID_PUBLIC_KEY` must be set for the enable flow (already used by
  the existing subscribe helper; a missing key surfaces as `no-vapid`).

## Project-specific notes
- Cmd UI section / staff: BOTH. Staff toggle in `src/screens/staff/` (peer to
  LocaleSwitcher/ScaleSwitcher); admin toggle in `src/components/cmd/` mounted via
  `ResponsiveCmdShell` (mirror the LocaleSwitcher placement).
- Per-store or admin-global: neither — the toggle is per-USER-per-DEVICE. It
  reads/writes only rows scoped to the signed-in `user_id` in `push_subscriptions`
  (that table's RLS applies). No store scoping.
- Realtime channels touched: none. Subscription state is device-local; no other
  client needs it live — no `store-{id}` / `brand-{id}` publication change and no
  realtime publication gotcha.
- Migrations needed: **no.** Drift fix is code-only (remove cron filter); the
  `notifications_enabled` column is already absent in prod and no DROP migration is
  warranted.
- Edge functions touched: `eod-reminder-cron`, `weekly-reminder-cron` (remove the
  `notifications_enabled` filter). No new edge function; no auth-model change (both
  crons keep their shared-bearer gate).
- Web/native scope: WEB ONLY (PWA). Web push is the only background path; the
  helpers already no-op on native/SSR. Ships to Vercel; no EAS change.
- `app.json` slug: not touched. VAPID keys are env vars, not `app.json`.
- Tests: jest (toggle state derivation + iOS-not-installed branch, per surface or
  shared). No pgTAP needed — no SQL change. Spec 022 tracks.

## Backend design

Author: backend-architect (design mode). This feature is overwhelmingly
frontend + a two-file edge-function edit. There is **no data model change, no
RLS change, no new PostgREST/RPC surface, no new db.ts helper, and no realtime
change.** The whole backend footprint is the two cron edits under "Edge function
changes" below. The frontend footprint is the shared pure module + two thin
per-surface components. Both are specified so the frontend dev can build and
unit-test without a browser.

### 0. Pushback / correction to the spec's task framing

The dispatch asked me to "confirm NO other code path references
`profiles.notifications_enabled`." **That claim is false** — after the two cron
edits, five references remain:

| Reference | File:line | Nature |
|---|---|---|
| `updateProfileNotifications()` — WRITES `notifications_enabled` | `src/lib/db.ts:2156-2172` | **Dead writer.** No call sites anywhere (grep-confirmed). Would 400 against prod if ever invoked (column absent). |
| defensive read `notifications_enabled !== false` | `src/lib/auth.ts:198` | Inert — column absent ⇒ field undefined ⇒ `undefined !== false` ⇒ `true`. |
| defensive read `notifications_enabled !== false` | `src/lib/auth.ts:642` | Same, inert. |
| defensive read `notifications_enabled !== false` | `src/lib/db.ts:4479` | Same, inert. |
| `User.notificationsEnabled?: boolean` type field | `src/types/index.ts:56` | Orphaned once writer/reads are gone. |

Because the column was **added** by `20260427023804_notifications_enabled.sql`
and then **dropped** by `20260502071736_remote_schema.sql:145` (the 2026-05-02
prod pull), the column is genuinely absent in prod. So the two crons are the
only ACTIVE consumer whose absent-column query produces the observable per-run
`console.warn`. The reads default to `true`; the writer is never called.

**Verdict:** I therefore **agree** with the spec's core conclusions — the change
is code-only, **no migration**, **no realtime change** — and the two cron edits
fully close the observable drift (the per-run caught warning). But the spec's
supporting assertion that nothing else references the column is wrong, and the
dead `updateProfileNotifications` + `User.notificationsEnabled` are now fully
orphaned. **Open question for the PM (do NOT auto-expand scope):** delete
`updateProfileNotifications` and the `notificationsEnabled` type field / reads as
a follow-up cleanup, or leave them inert? I recommend a follow-up spec, not
folding it into 118 — per the "ask before expanding scope" rule. The build for
118 should leave those five references untouched.

### 1. Shared vs per-surface split (spec §(d), Q1)

The two existing switcher pairs (`LocaleSwitcher`, `ScaleSwitcher`) duplicate
*presentation only* — there is no shared logic file because locale/scale are
trivial store reads. Notifications are different: they carry real branching
logic (permission × subscription × iOS-standalone → view state, plus an 8-code
result→message map) that **must be unit-testable without a browser**. That
justifies **one new shared pure module** — the only new pattern in this spec,
and it mirrors how the crons keep pure helpers (`weekWindow`, `minutesUntilCutoff`)
separate from I/O.

- **Shared (new):** `src/lib/notificationState.ts` — pure logic + a thin browser
  probe. Web-only; no-ops to `unsupported`/`off` off-web. Exports:
  - `type NotificationView = 'on' | 'off' | 'needs-install' | 'denied' | 'unsupported' | 'error'`
  - `interface DeriveInput { capable: boolean; permission: 'granted'|'denied'|'default'|'unsupported'; hasSubscription: boolean; isIos: boolean; isStandalone: boolean; probeError?: boolean }`
  - `function deriveNotificationState(i: DeriveInput): NotificationView` — **the testable core** (§2).
  - `function detectIos(): boolean` — UA test `/iPad|iPhone|iPod/` plus iPadOS-13+ masquerade (`navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1`).
  - `async function probeNotificationState(): Promise<DeriveInput>` — impure collector: reads `isWebPushCapable()` semantics, `Notification.permission`, `navigator.serviceWorker.getRegistration()?.pushManager.getSubscription()` (→ `hasSubscription`), `navigator.standalone === true || matchMedia('(display-mode: standalone)').matches` (→ `isStandalone`), `detectIos()`. Wraps the `getSubscription()` await in try/catch → `probeError: true`. NOT unit-tested directly (browser-dependent); the reducer it feeds is.
  - `function subscribeCodeToMessageKey(code): 'unsupported'|'misconfigured'|'denied'|'dismissed'|'generic'` — the §3 map, catalog-agnostic (returns the suffix; each component prefixes with its own `chrome.notifications.msg.` path).
- **Per-surface (new, presentation only):** each imports the shared module and
  differs ONLY in theme tokens + i18n prefix, exactly like the two LocaleSwitchers.
  - **Staff:** `src/screens/staff/components/NotificationSwitcher.tsx` — peer to `LocaleSwitcher`/`ScaleSwitcher`; staff theme (`useStaffColors`/`useStaffTokens`), `useI18n()`. Reads the signed-in id via the existing `currentStaffUserId(authState)` selector (`src/screens/staff/store/useStaffStore.ts:361`). Mounts in the `StorePicker` header `switcherRow` (`src/screens/staff/screens/StorePicker.tsx:55-58`), immediately after `<ScaleSwitcher />` — the canonical switcher home; other staff screen headers may reuse it but StorePicker is the required mount.
  - **Admin:** `src/components/cmd/NotificationToggle.tsx` — peer to `LocaleSwitcher`/`ThemeToggle`; cmd theme (`useCmdColors`, `CmdRadius`, `mono`), `useT()`. Reads `useStore((s) => s.currentUser?.id)`. Mounts in `ResponsiveCmdShell` `railFooter` (`src/screens/cmd/ResponsiveCmdShell.tsx:278-281`), adjacent to `<LocaleSwitcher />`.

Both components hold **local** component state only (`view: NotificationView`,
`busy: boolean`, `message: string | null`). On mount (and on web
`visibilitychange`/focus, recommended) they call `probeNotificationState()` →
`deriveNotificationState()` → `setView`. Toggle handlers:
- **ON:** guard `view !== 'busy'`; from the user gesture call
  `requestPermissionAndSubscribe(userId)` (webPush.ts). On `{ ok: true }`
  re-probe → `on`. On `{ ok:false, code }` set `message =
  t('chrome.notifications.msg.' + subscribeCodeToMessageKey(code))` and re-probe
  (view falls to `denied`/`off`/`needs-install` as appropriate).
- **OFF:** call `unsubscribeFromPush()` (webPush.ts), then re-probe → `off`.

### 2. State-derivation reducer (spec §(b),(c); the jest target)

`deriveNotificationState(i: DeriveInput): NotificationView`, precedence
**top-to-bottom** (order matters — iOS-tab must beat unsupported, because on an
iOS Safari tab `PushManager` is absent so `capable` is `false` and a naive path
would render `unsupported` instead of the install hint):

1. `i.probeError` → `'error'`
2. `i.isIos && !i.isStandalone` → `'needs-install'`  (iOS Safari tab)
3. `!i.capable` → `'unsupported'`
4. `i.permission === 'denied'` → `'denied'`
5. `i.permission === 'granted' && i.hasSubscription` → `'on'`
6. otherwise → `'off'`  (covers `default`, and granted-but-no-subscription)

This is pure and total — the frontend dev unit-tests all six branches with plain
object inputs (no `navigator` mock needed for the reducer itself; only
`probeNotificationState` would need mocks, and it is intentionally kept
un-tested-in-isolation). Minimum jest coverage per spec §Tests: the On/Off
branch (5/6) and the iOS-not-installed branch (2). Mapping each `NotificationView`
to affordance:

| View | Toggle shows | Body copy | Retry? |
|---|---|---|---|
| `on` | On (action = turn off) | — | — |
| `off` | Off (action = turn on) | — | — |
| `needs-install` | (install hint, no on/off) | `chrome.notifications.iosInstall.{title,steps}` | — |
| `denied` | Off (blocked) | `chrome.notifications.msg.denied` | yes |
| `unsupported` | (disabled) | `chrome.notifications.msg.unsupported` | — |
| `error` | Off | `chrome.notifications.msg.generic` | yes |

### 3. `SubscribeResult` code → i18n key map (both catalogs)

`subscribeCodeToMessageKey` returns the suffix; component renders
`chrome.notifications.msg.<suffix>`. Covers all 8 union codes from
`webPush.ts:47-59`:

| `SubscribeResult` code | key suffix | EN copy (identical key path in staff + cmd catalogs) |
|---|---|---|
| `unsupported` | `unsupported` | "Notifications aren't available in this browser." (but view `needs-install` on an iOS tab overrides — the iOS block is rendered from the *view*, not this code) |
| `no-vapid` | `misconfigured` | "Notifications are misconfigured on the server." |
| `no-user` | `generic` | "Couldn't enable notifications. Try again." |
| `permission-denied` | `denied` | "Notifications are blocked. Re-enable them in your device/browser settings, then try again." |
| `permission-default` | `dismissed` | "Permission was dismissed. Tap to try again." |
| `sw-register-failed` | `generic` | "Couldn't enable notifications. Try again." |
| `subscribe-failed` | `generic` | (same) |
| `subscription-incomplete` | `generic` | (same) |
| `save-failed` | `generic` | (same) |

**New i18n block** `chrome.notifications` added to BOTH catalogs — staff
(`src/screens/staff/i18n/{en,es,zh-CN}.json`) AND cmd
(`src/i18n/{en,es,zh-CN}.json`), 6 files, placed as a sibling of the existing
`chrome.localeSwitcher` block:

```
chrome.notifications: {
  label:  "Notifications",
  aria:   "Toggle notifications on this device",
  state:  { on: "On", off: "Off" },
  iosInstall: {
    title: "Add this app to your Home Screen to enable notifications",
    steps: "Tap Share, then 'Add to Home Screen'."
  },
  msg: {
    unsupported:  "Notifications aren't available in this browser.",
    misconfigured:"Notifications are misconfigured on the server.",
    denied:       "Notifications are blocked. Re-enable them in your device/browser settings, then try again.",
    dismissed:    "Permission was dismissed. Tap to try again.",
    generic:      "Couldn't enable notifications. Try again."
  },
  retry: "Try again"
}
```

es / zh-CN provide the same keys translated. The label strings are NOT
locale-invariant (unlike the switcher pill labels), so all three languages get
real translations.

### 4. Edge function changes (the entire backend footprint)

Both crons: **remove the per-user opt-out block and its two filter usages.** No
other edit — the shared-bearer gate, VAPID setup, email-fallback, dedup logs,
and `escapeHtml` all stay.

**`supabase/functions/eod-reminder-cron/index.ts`:**
- Delete the `optedOutRows`/`optedOutErr`/`optedOutUserIds` block (lines
  196-207) including its comment and non-fatal `console.warn`.
- In the two `toRemind` filters (lines 246 and 307) drop `&& !optedOutUserIds.has(u)`, leaving `.filter((u) => !alreadyPushed.has(u))`.

**`supabase/functions/weekly-reminder-cron/index.ts`:**
- Delete the equivalent block (lines 230-237).
- In the single `toRemind` filter (line 292) drop `&& !optedOutUserIds.has(u)`, leaving `.filter((u) => !alreadyReminded.has(u))`.

After these edits, grep `notifications_enabled` returns zero hits under
`supabase/functions/`, so the per-run non-fatal caught error is gone. Email
fallback (spec §"Email fallback preserved") is untouched — `deliverReminder`
still emails any targeted user with zero working push subs. **No migration**
(`20260427023804_notifications_enabled.sql` stays as an inert historical record;
`20260502071736_remote_schema.sql:145` already dropped the column in the prod
pull). The db-migrations-applied gate is unaffected (no migration file added or
removed).

### 5. Edge-function conventions that apply (CLAUDE.md)

Touching the crons must preserve their established posture:
- **`verify_jwt = false`** stays for both (`config.toml`). They are pg_cron
  cross-store readers, not user-invoked — the **shared-bearer gate**
  (`expectedBearer` via `_edge_auth`/`cron_bearer`, eod lines 99-114 / weekly
  132-147, checked at eod 122-127 / weekly 155-160) is the auth boundary and
  **must not be altered**. Do not add an `ADMIN_ROLES` gate (not user-invoked,
  no privileged role-change/deletion op — the weekly cron header already
  documents this).
- **HTML-email escaping:** weekly-reminder-cron already routes interpolated
  values through its inline `escapeHtml()` — leave it. The eod cron's
  pre-existing **un-escaped** store-name interpolation (lines 254, 315) is a
  known pre-existing gap and is **out of scope** for 118 (spec excludes reminder
  wording changes); do NOT "fix" it here — that is a separate spec so this PR
  stays a clean drift-removal diff.

### RLS impact
None. No new table. All push_subscriptions writes continue to flow through
`webPush.ts` (`requestPermissionAndSubscribe` upsert `onConflict: 'endpoint'`,
`unsubscribeFromPush` delete `.eq('endpoint', …)`), which already operates under
the existing per-user `push_subscriptions` policy. Acceptance §(b) device-A /
device-B isolation is guaranteed structurally by the endpoint-keyed upsert/delete
— one row per `(user_id, endpoint)` — with no policy change.

### API contract
No PostgREST/RPC change. No new db.ts helper — the toggle calls the existing
`webPush.ts` helpers directly. This is a **documented carve-out**: `webPush.ts`
is allowed to call `supabase.from(...)` outside `db.ts`, and it already owns the
`push_subscriptions` writes. The staff component additionally lives in the staff
subtree carve-out; but it only calls webPush helpers, so it issues no direct
Supabase traffic of its own. **Do not** add a db.ts wrapper — that would
duplicate webPush's sanctioned ownership.

### Realtime impact
None. `push_subscriptions` is device-local and not a member of the
`supabase_realtime` publication; no other client needs this state live. No
`store-{id}` / `brand-{id}` change, and **no publication-membership change → the
`docker restart supabase_realtime_imr-inventory` gotcha does not apply.**

### Frontend store impact
No new slice in `useStore.ts` or `useStaffStore.ts`. The toggle's source of
truth is the **live browser** (`probeNotificationState`), not a DB row, so the
usual optimistic-then-revert + `notifyBackendError` pattern **does not apply** —
instead the component shows a `busy` state during the async call, then re-probes
for the authoritative view. `webPush.ts` already `console.warn`s internally on
failure, so an extra `notifyBackendError` is optional (a toast may be added for
parity but is not required). Logout teardown is already wired:
`useStore.ts:753` calls `unsubscribeFromPush()` on admin logout; the staff path
tears down on sign-out consistent with the per-device model (spec Q resolved).

### Risks / tradeoffs
- **iOS UA-sniffing is brittle.** `detectIos()` relies on UA + iPadOS masquerade
  heuristics that Apple can change. Mitigation: it feeds the pure reducer and is
  swappable in one place; the reducer branch is unit-tested.
- **No cross-device live sync.** Device B's "Off" only refreshes on its own
  probe (mount / focus / visibilitychange). This is intended (device-local per
  spec §(b)); recommend wiring a `visibilitychange` re-probe so an
  expired/revoked subscription reflects without a full reload.
- **Cron behavior change is a no-op in prod.** Removing the opt-out filter would
  re-enable a user who had `notifications_enabled = false` — but the column is
  absent in prod, so no such row can exist; observable prod behavior is
  unchanged. The only real effect is deleting the per-run caught warning.
- **Orphaned dead code** (`updateProfileNotifications`, `User.notificationsEnabled`)
  remains after this spec — see §0 open question. Not a build risk (writer never
  called); a hygiene follow-up.
- **Performance:** one fewer `profiles` query per cron run — negligible-positive.
  Seed dataset (286 KB) is irrelevant here (no new query over large tables). No
  edge-function cold-start change.
- **Migration ordering:** N/A — no migration in this spec.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the ## Backend design in this spec. Backend scope is
  small and self-contained — the two cron edits in §4 only (remove the
  notifications_enabled opt-out block + the `&& !optedOutUserIds.has(u)` filter
  usages; preserve verify_jwt=false, the shared-bearer gate, escapeHtml, and the
  eod cron's out-of-scope unescaped store name). No migration, no db.ts change,
  no RLS/realtime change. Frontend scope: the shared pure module
  src/lib/notificationState.ts (§1-3), the two per-surface toggle components
  (staff NotificationSwitcher + cmd NotificationToggle) mounted per §1, the
  chrome.notifications i18n block in all 6 catalogs (§3), and jest coverage of
  deriveNotificationState (On/Off + iOS-not-installed branches). Leave the five
  orphaned notifications_enabled references (§0) untouched — cleanup is a
  separate follow-up. After implementation, set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - specs/118-pwa-notification-toggle.md

## Files changed

Frontend only (this pass). The backend cron edits (§4) are being implemented in
parallel by another agent and are NOT included below — `supabase/functions/`
was intentionally left untouched per the dispatch.

New:
- `src/lib/notificationState.ts` — shared pure module: `deriveNotificationState`
  (6-branch precedence reducer), `subscribeCodeToMessageKey` (8-code→5-suffix
  map), `detectIos`, and the impure `probeNotificationState` collector.
- `src/lib/notificationState.test.ts` — jest unit tests for the pure reducer
  (all six branches, incl. iOS-tab-before-unsupported ordering) + the code map.
- `src/lib/useNotificationToggle.ts` — shared behavior HOOK (review fix 5):
  owns view/busy/message state, the mount + visibilitychange re-probe effect,
  and the enable/disable/retry handlers. Both surface components now call it,
  so each is genuinely theme + i18n only. Embodies review fixes 2 (stale
  message cleared on authoritative re-probe via the `clearMessage` flag) and 3
  (missing `userId` folded into `interactive` → disabled control instead of a
  silent no-op) and 4 (wires the `chrome.notifications.retry` affordance for
  `denied`/`error`).
- `src/screens/staff/components/NotificationSwitcher.tsx` — staff PWA toggle
  (staff dark theme + `useI18n`), presentation-only over the shared hook.
- `src/components/cmd/NotificationToggle.tsx` — admin Cmd UI toggle (Cmd theme +
  `useT`), presentation-only over the shared hook.

Modified:
- `src/screens/staff/screens/EODCount.tsx`, `Reorder.tsx`, `Receiving.tsx`
  (review fix 1, CRITICAL — cross-user push leak): each staff sign-out call
  site now `await unsubscribeFromPush()` BEFORE `supabase.auth.signOut()` so
  this device's `push_subscriptions` row is torn down under the authenticated
  session (mirrors admin logout at `useStore.ts:753`). The three sites do NOT
  share a helper, so all three were patched. Admin logout left unchanged.
- `src/screens/staff/screens/StorePicker.tsx` — mount `<NotificationSwitcher />`
  in `switcherRow` after `<ScaleSwitcher />`; `switcherRow` gains
  `flexWrap: 'wrap'` + `rowGap` so the now-3-child row doesn't overflow on a
  narrow phone.
- `src/screens/cmd/ResponsiveCmdShell.tsx` — mount `<NotificationToggle />` in
  `railFooter` above `<LocaleSwitcher />`; refreshed the stale `railFooter`
  comment.
- `src/i18n/{en,es,zh-CN}.json` — add `chrome.notifications` block (admin catalog).
- `src/screens/staff/i18n/{en,es,zh-CN}.json` — add `chrome.notifications` block
  (staff catalog). The `retry` key is now WIRED (fix 4 resolved by wiring, not
  removal) — parity kept green.

Review fixes applied (from `reviews/release-proposal.md`, in order):
1. [CRITICAL] Staff sign-out push teardown — 3 call sites.
2. [Should-fix] Stale message cleared on authoritative re-probe.
3. [Should-fix] Missing `userId` disables the control (no silent no-op).
4. [Should-fix] Dead `retry` key wired into a visible retry affordance.
5. [Should-fix] Shared `useNotificationToggle` hook extracted (captures 2–4).
   Nits swept: railFooter comment, switcherRow wrap guard.

Verification:
- `npx tsc --noEmit` — clean.
- `npx jest notificationState i18n.test` — 33 passed (reducer branches + both
  catalog-parity suites green, retry key kept).
- `npx jest` (full) — 102 suites / 1184 tests passed.
- Browser: the `preview_*` tooling was not available in this session and both
  toggle mount points sit behind auth; the pure reducer + parity suites (the
  architect's designated primary gate) plus full tsc/jest are green. A manual
  in-browser smoke of the two rendered toggles is recommended at review.
- Left the five orphaned `notifications_enabled` references (§0) untouched per
  scope.

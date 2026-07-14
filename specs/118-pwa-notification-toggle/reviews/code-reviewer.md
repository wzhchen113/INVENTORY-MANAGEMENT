# Code review for spec 118 (PWA per-device notification toggle)

Scope reviewed: `src/lib/notificationState.ts`, `src/lib/notificationState.test.ts`,
`src/screens/staff/components/NotificationSwitcher.tsx`,
`src/components/cmd/NotificationToggle.tsx`, the two mount-point edits
(`StorePicker.tsx`, `ResponsiveCmdShell.tsx`), all six i18n catalogs, and the
two cron edits (`eod-reminder-cron`, `weekly-reminder-cron`).

The shared pure module (`deriveNotificationState`, `subscribeCodeToMessageKey`)
is clean, well-commented, correctly ordered (iOS-tab precedes unsupported, per
spec), and the exhaustiveness `never` guard on `subscribeCodeToMessageKey` is
idiomatic. The cron edits are a clean, minimal diff that matches spec §4
exactly — no leftover comments, no stray `optedOutUserIds` references, bearer
gate and `escapeHtml` untouched. i18n catalogs are structurally identical
across all 6 files.

### Critical

- Cross-user push-subscription leak on shared staff devices, caused by the
  interaction between this spec's new enable/disable UI and a pre-existing gap
  in the staff sign-out path. `src/screens/staff/screens/EODCount.tsx:536`,
  `Reorder.tsx:490`, and `Receiving.tsx:328` call `supabase.auth.signOut()`
  directly and never call `unsubscribeFromPush()` — unlike the admin path
  (`src/store/useStore.ts:753`, which the spec's own "Q (does logout affect
  this?)" section cites as proof "no change needed," incorrectly extending that
  claim to the staff surface). Before spec 118 this gap was unreachable because
  nothing on the staff surface ever called `requestPermissionAndSubscribe`; this
  spec is precisely what wires that call up for the first time, so the gap
  becomes live. Concrete failure mode on a shared device: staff member A enables
  notifications (`push_subscriptions` row: `user_id=A`, this endpoint) and signs
  out without disabling; staff member B signs in on the same device. `deriveNotificationState`'s
  "On" state is derived purely from browser permission + live `PushSubscription`
  (acceptance criterion (b), by design) — so B's `NotificationSwitcher`/`NotificationToggle`
  reads "On" even though the underlying DB row still targets A. Net effect: B
  believes push is on for them but never receives it (the row still points at
  A), and A keeps getting EOD/vendor reminders pushed to a device they no longer
  use. This is a real per-device data-integrity break, not just a UX rough edge.
  Fix: staff sign-out call sites need the same `unsubscribeFromPush()` teardown
  `useStore.ts:753` already has for admin, OR the spec's Q&A needs revisiting
  before merge (this touches files outside spec 118's declared "Files changed"
  set, so it may need a quick re-scope conversation with backend-architect/PM
  rather than a silent fix here).

### Should-fix

- `src/screens/staff/components/NotificationSwitcher.tsx:36-106` and
  `src/components/cmd/NotificationToggle.tsx:32-95` duplicate far more than
  "theme tokens + i18n prefix" as both file headers claim (NotificationSwitcher.tsx:6-8,
  NotificationToggle.tsx:5-8): the `view`/`busy`/`message` state triplet, the
  `refresh` callback, the mount + `visibilitychange` effect wiring, the
  `enable`/`disable` handlers, and the `viewMessage` view→copy ternary are all
  byte-for-byte identical logic (only `t(...)` vs `T(...)` differs). This is
  real branching logic, not presentation, and it's the kind of duplication the
  spec itself said justified pulling `notificationState.ts` out in the first
  place. Recommend extracting a shared hook (e.g. `useNotificationToggle(userId,
  translate)` in `src/lib/`) that both components call, leaving only JSX/styling
  per surface — otherwise the two message-derivation ternaries will silently
  drift the next time someone edits one and forgets the other.
- `NotificationSwitcher.tsx:45,67-74,106` / `NotificationToggle.tsx:39,60-66,95`
  — the transient `message` state is only cleared to `null` at the start of
  `enable()`/`disable()`, never inside `refresh()`. Since `body = message ??
  viewMessage` always prefers a non-null `message` over the freshly-derived
  `viewMessage`, a stale failure message (e.g. "Permission was dismissed. Tap to
  try again.") persists indefinitely across later mount/`visibilitychange`
  re-probes even after the underlying condition has changed (e.g. the user
  later grants permission through browser chrome outside the toggle). Clear
  `message` inside `refresh()` once the view resolves to something other than
  the state that produced it, or re-derive body purely from `view`.
- `NotificationSwitcher.tsx:65` / `NotificationToggle.tsx:57` — `enable()`
  silently no-ops (`if (!userId) return;`) before touching `busy`/`message`, and
  `interactive` doesn't account for a missing `userId`. Tapping the toggle while
  `userId` hasn't hydrated yet (e.g. mid auth-restore) produces zero feedback —
  no busy flash, no error copy. Fold "no user yet" into the `interactive`/disabled
  condition, or surface a message.
- `chrome.notifications.retry` is defined in all 6 catalogs (`src/i18n/{en,es,zh-CN}.json`,
  `src/screens/staff/i18n/{en,es,zh-CN}.json`) but never referenced by either
  component (grep confirms zero call sites) — dead i18n key. Either wire it into
  a visible retry affordance (acceptance criterion (c) calls for "retry
  offered" on `denied`/`error`) or drop the key from all 6 files.

### Nits

- `src/screens/cmd/ResponsiveCmdShell.tsx:276-278` — the comment above
  `railFooter` ("Rail footer: locale switcher + sign-out. Theme toggle lives
  in the TitleBar's...") wasn't updated to mention the newly-mounted
  `<NotificationToggle />`.
- (out-of-scope) `StorePicker.tsx` `switcherRow` style
  (`justifyContent: 'space-between'`, no `flexWrap`) previously laid out 2
  children; it now lays out 3, and `NotificationSwitcher`'s optional two-line
  body copy (`iosInstall.steps` + a message) has no wrap guard on the row.
  Since neither dev could browser-smoke this, a visual check on a narrow phone
  width is worth doing at review — this is exactly the kind of thing a browser
  test would catch and a read of the diff can't confirm.
- `subscribeCodeToMessageKey`'s `no-user` case maps to `generic` alongside four
  other codes, but `enable()` in both components already early-returns before
  calling `requestPermissionAndSubscribe` when `userId` is falsy — so in
  practice `webPush.ts`'s own `no-user` result can't surface through this UI
  path. Not a bug, just dead-in-practice branch worth knowing about if the map
  is ever reused elsewhere.

## Test report for spec 118

### Acceptance criteria status

- **AC (a) Enable/disable act on THIS device only.** → NOT TESTED (structurally
  argued, not verified by any test). The endpoint-keyed upsert/delete that
  guarantees device isolation lives entirely in `src/lib/webPush.ts`, which is
  unchanged by this spec and has **zero existing unit tests** (`git log` shows
  no test file for it, ever). Neither toggle component has a render test that
  exercises `enable()`/`disable()`, and no shell smoke or pgTAP hits
  `push_subscriptions`. This is a genuine cross-track gap — but it is
  **inherited risk from pre-existing, already-shipped code**, not a regression
  introduced by 118. The spec correctly scoped `webPush.ts` as "consumed as-is,
  no signature change" and out of scope for new tests.
- **AC (b) Displayed state derives from THIS browser's live state.** → PASS
  (reducer) / NOT TESTED (live wiring). `deriveNotificationState` — the
  designated primary jest gate — is fully and correctly tested:
  `src/lib/notificationState.test.ts::deriveNotificationState — six-branch
  precedence`, all 6 branches (`error`, `needs-install`, `unsupported`,
  `denied`, `on`, `off`) plus the critical precedence ordering (iOS-tab beats
  unsupported, test `(2)`; installed-iOS falls through to `on`, not
  `needs-install`, test `(2b)`). The device-A/device-B two-endpoint isolation
  consequence is NOT independently tested (would require a live browser +
  Supabase row assertion); no track in this repo can currently exercise it.
- **Signing in does NOT auto-subscribe.** → NOT TESTED directly, but verified
  by code inspection: `grep -rn requestPermissionAndSubscribe` shows the only
  call sites are the two toggles' `enable()` handlers, both gated behind
  `onPress`. No mount-time or login-flow call site exists. Low risk.
- **AC (c) Each `SubscribeResult` code maps to a specific message.** → PASS
  (mapping) / NOT TESTED (rendered copy). `subscribeCodeToMessageKey` is
  exhaustively tested for all 9 `SubscribeResult` codes (spec prose says
  "8-code" but the union — and the test — actually covers 9:
  `unsupported, no-vapid, no-user, permission-denied, permission-default,
  sw-register-failed, subscribe-failed, subscription-incomplete, save-failed`
  — a harmless off-by-one in the spec's own prose, not a test gap). The
  TypeScript exhaustiveness guard (`const _exhaustive: never = code`) means a
  10th future code fails the build, not silently falls through. i18n key
  presence/parity for `chrome.notifications.msg.*` in all 6 catalogs verified
  green via `npx jest i18n.test`. NOT independently render-tested: no test
  asserts that `NotificationToggle`/`NotificationSwitcher` actually calls `T()`
  / `t()` with the right key and displays the right string for a given failure
  code (would require mocking `requestPermissionAndSubscribe` and rendering).
- **iOS guidance detail (needs-install vs installed-standalone).** → PASS.
  Covered by reducer tests `(2)` and `(2b)` above — this is the exact
  precedence the architect flagged as most likely to regress, and it's
  directly pinned.
- **AC (d) Both surfaces get their own toggle + i18n keys.** → PASS (via code
  inspection + i18n parity jest, not render test).
  - `src/components/cmd/NotificationToggle.tsx` exists, mounted in
    `ResponsiveCmdShell.tsx` `railFooter` adjacent to `<LocaleSwitcher />`
    (grep-confirmed).
  - `src/screens/staff/components/NotificationSwitcher.tsx` exists, mounted in
    `StorePicker.tsx` `switcherRow` after `<ScaleSwitcher />` (grep-confirmed).
  - `chrome.notifications` block present with identical key shape (label,
    aria, state.{on,off}, iosInstall.{title,steps}, msg.{5 keys}, retry) and
    real (non-placeholder) translations in all 6 catalogs — verified by
    reading each file's parsed JSON directly, and by
    `npx jest i18n.test` (24/24 green, both admin + staff parity suites).
  - **Notable incidental coverage:** `src/screens/staff/screens/StorePicker.test.tsx`
    (unmodified by this diff) renders the full `<StorePicker />` tree, which
    now includes `<NotificationSwitcher />`. That test is green in the full
    suite run, which means the staff toggle at minimum **mounts and renders
    without throwing** inside a realistic host tree — a meaningful, if
    shallow, regression guard the developer didn't add on purpose.
    `ResponsiveCmdShell.tsx` (admin) has **no equivalent test at all**
    anywhere in the suite — `StoreSwitchOverlay.test.tsx` is the only test
    file that references the shell's sibling components, and it renders
    `<StoreSwitchOverlay>` directly, not the shell. So `NotificationToggle`
    (admin) has **zero test exposure**, direct or incidental — the bigger of
    the two component gaps.
- **Drift resolved (Option A — per-device pure), both crons.** → PASS (by
  inspection, no automated regression guard). `grep -n
  "notifications_enabled|optedOut"` against both
  `supabase/functions/eod-reminder-cron/index.ts` and
  `supabase/functions/weekly-reminder-cron/index.ts` returns zero hits — the
  opt-out block and both filter usages are fully removed in both files, per
  spec §4. No pgTAP required (no SQL change, correctly per spec) and no shell
  smoke exists for either cron today (`scripts/smoke-edge.sh` has no cron
  coverage — a pre-existing gap, not introduced by 118). A future accidental
  re-introduction of the `notifications_enabled` filter would not be caught by
  any automated test; only a mechanical grep (as done here) or manual review.
- **Email fallback behavior preserved.** → NOT TESTED (no track exercises
  `deliverReminder`/Resend paths at all, before or after this spec), but LOW
  RISK: the diff to both crons is purely subtractive (delete the opt-out block
  + drop one filter clause); the email-fallback code path
  (`deliverReminder`) is untouched, confirmed by reading the diff scope in the
  spec's §4 — no line in that function was touched.
- **Tests: at least one jest test per surface (or shared) on the toggle's
  state-derivation logic; no pgTAP required.** → PASS, literally satisfied.
  The shared module test (`notificationState.test.ts`) is explicitly permitted
  by the AC's own wording ("or a shared test") and it covers the reducer more
  thoroughly than the AC's stated minimum (On/Off branch + iOS-not-installed
  branch) — it covers all 6 branches plus the full code map. No pgTAP added,
  correctly, since there's no SQL change.

### Test run

```
npx jest notificationState
  PASS unit src/lib/notificationState.test.ts
  Tests: 9 passed, 9 total

npx jest i18n.test
  PASS unit src/i18n/i18n.test.ts
  PASS unit src/screens/staff/i18n/i18n.test.ts
  Tests: 24 passed, 24 total

npx jest   (full suite)
  Test Suites: 102 passed, 102 total
  Tests:       1184 passed, 1184 total
  (matches the developer's reported 102/1184; one pre-existing
  act()-wrapping console warning from src/screens/staff/screens/EODCount.tsx
  is unrelated noise, not a failure)

npx tsc --noEmit
  clean, no output
```

### Notes

**Framework:** no new framework introduced. All new tests are jest, consistent
with spec 022's three tracks. Good.

**Primary gate assessment (per dispatch instruction to weigh this
explicitly):** `deriveNotificationState` is the correct and sufficient primary
gate for the *state-derivation* logic — it is pure, total, exhaustively
branch-tested, and the one precedence rule the architect called out as
non-obvious (iOS-tab-before-unsupported) is directly pinned by test `(2)` vs
`(2b)`. The `subscribeCodeToMessageKey` map is likewise exhaustively tested
with a compile-time exhaustiveness guard backing it up. I consider this half
of the feature **solidly covered** and would not block on it.

The **impure probe** (`probeNotificationState`, `detectIos`) and the **two
components** are, by design and by project precedent, not unit-tested in
isolation — `detectIos`'s UA-sniffing and `probeNotificationState`'s
`navigator`/`ServiceWorkerRegistration` reads cannot be meaningfully asserted
without a real browser, and the project has an established practice of
leaving browser-only probes untested (mirrors, e.g., other UA-based dead
code elsewhere). That part of the "coverage gap" is expected and acceptable.

What is **not** fully excused, however: `@testing-library/react-native` is
already a project dependency and is *actively used* for render-level tests of
peer `src/components/cmd/*` components with the exact same dependency shape
(`useCmdColors` + `useT` + Zustand-store selector) — see
`src/components/cmd/StatusPill.test.tsx` (spec 039), which mocks those two
hooks at the boundary and asserts rendered text per state. That pattern was
directly reusable for `NotificationToggle` (mock `useCmdColors`, `useT`,
`useStore`, and the `notificationState`/`webPush` module functions; assert the
pill's text for `view='on'|'off'|'needs-install'|'denied'` and that `onPress`
calls `enable`/`disable`). No such test was written for either toggle. This is
a **real, avoidable gap**, not an infrastructure gap — a render test at this
level was buildable in this session without a browser or auth, and would have
directly covered §(c)'s "message per code" rendering and the on/off toggle
interaction that the spec calls out as core UI behavior.

That said: the spec's own **Tests** acceptance criterion explicitly scopes the
jest requirement to "the toggle's state-derivation logic" (i.e., the reducer),
not full component render tests, and explicitly says the browser/render
smoke was expected to happen "at review" (per the developer's own verification
note: "A manual in-browser smoke of the two rendered toggles is recommended at
review"). Judged against the AC as literally written, the jest bar is met.
Judged against "is the feature's user-facing behavior actually verified,"
there is a real hole: nobody has confirmed the buttons render correct labels,
correct retry copy, or actually flip state on press, in this session or any
automated track.

**Recommendation (not a block):** before shipping, do one of:
1. Add two lightweight `StatusPill`-style render tests (mock
   `probeNotificationState`/`requestPermissionAndSubscribe`/`unsubscribeFromPush`
   at the module boundary, assert pill text + press behavior for `on`/`off`/
   `needs-install`/`denied` views) for both `NotificationToggle` and
   `NotificationSwitcher`, or
2. Do the manual in-browser smoke the developer flagged as outstanding
   (log in as admin and as staff, toggle notifications on each surface,
   confirm the six-state copy renders, confirm a `push_subscriptions` row
   appears/disappears) before merging to `main`.

Given the reducer is thoroughly and correctly tested, the impure probe is
appropriately excluded per project convention, the crons are verified
drift-free by direct inspection, and the literal AC wording for "Tests" is
satisfied, **I am not blocking** this spec. The two component-render gaps and
the cron-smoke gap are real but not "genuinely uncovered high-risk" in the
sense of undermining confidence in the core state-derivation contract — they
are gaps in the outer (presentation/wiring) layer that the spec's own test AC
deliberately did not require, and one of them (the staff mount) already gets
an incidental no-crash smoke from an unrelated, pre-existing test.

**Cross-check:** `npx tsc --noEmit` is clean; the exhaustiveness guard in
`subscribeCodeToMessageKey` means any future 10th `SubscribeResult` code is a
compile error, not a silent gap — a durable, low-maintenance safety net for
the one area most likely to drift (webPush.ts adding a new failure code).

**No violations found:** `app.json` slug untouched; no new test framework;
no mutation of `supabase/seed.sql`; no realtime publication change (correctly
not touched, per spec); edge-function shared-bearer gate and `escapeHtml`
untouched in both crons (spot-checked via grep, not full diff review — that's
architect/code-reviewer territory).

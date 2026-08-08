# Security audit for spec 153 — Add-to-Home-Screen (PWA install) tutorial

Reviewed: staged diff (20 files, +2579/−17) against `specs/153-pwa-install-tutorial.md`.
Scope emphasis per dispatch: `public/sw.js`, `public/manifest.json`, the
`beforeinstallprompt` capture store, UA-string handling, new network calls, AC-REG4.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `public/sw.js:24-26` — the new `fetch` listener is correct today (empty body, no
  `event.respondWith`, no `caches.*`), but the only thing preventing a future PR from
  turning this worker into a full MITM over `/auth/v1` token refreshes and PostgREST
  reads is a code comment (`public/sw.js:19-23`) plus a prose rule in the spec.
  `public/` is not covered by any jest suite and `sw.js` is not linted. Suggested cheap
  durable control (not required for this deploy): a one-assertion jest pin that reads
  `public/sw.js` and fails on `/respondWith|caches\./`, so the "no interception"
  invariant survives the next person who wants offline support. Registering the
  listener does make every request dispatch through the worker (default network path
  preserved), so the blast radius of a future `respondWith` is now one line rather than
  one line plus a listener.
- `public/sw.js:51-65` (**pre-existing, not introduced by this spec**) — `notificationclick`
  passes `event.notification.data.url` straight into `client.navigate(target)` /
  `clients.openWindow(target)` with no same-origin allowlist. All three senders hard-code
  `url: '/'` (`supabase/functions/eod-reminder-cron/index.ts:286,347`,
  `supabase/functions/weekly-reminder-cron/index.ts:298`,
  `supabase/functions/submission-push-fanout/index.ts:233`) and payloads are VAPID-signed,
  so exploitation requires the private VAPID key or a compromised sender. Flagged only
  because `sw.js` is in this diff and was reviewed line by line; a
  `new URL(target, self.location.origin).origin === self.location.origin` guard would
  close it whenever `sw.js` is next touched. Out of scope for spec 153.
- `src/lib/installGuide.ts:203-208` — `_resetInstallPrompt()` is a test-only helper
  exported from a production module and therefore present in the web bundle. It matches
  the established `sessionWatch.ts` `_resetSessionWatch` precedent, is not attached to
  `window`, and only clears a browser install-prompt ref (no auth, no data, no privilege).
  Informational — no action requested.

## What was checked and cleared

**`public/sw.js` — no-op fetch listener only (the dispatch's Critical trigger).**
Character-level diff of the file: the only change is the comment block plus
`self.addEventListener('fetch', () => {});` at `public/sw.js:24-26`. Zero
`event.respondWith(`, zero `caches.open` / `caches.match` / `caches.addAll`, zero
precache list, zero `Response` construction, zero request rewriting. The existing
`install` (`:6-8`), `activate` (`:10-12`), `push` (`:28-49`) and `notificationclick`
(`:51-66`) handlers are byte-unchanged (AC-11). Supabase PostgREST, `/auth/v1` token
refresh and edge-function traffic all keep the browser's default network path — the
worker observes nothing and answers nothing. `vercel.json:9-13` still serves `/sw.js`
`no-cache, no-store, must-revalidate` with `Service-Worker-Allowed: /` (unchanged), and
`registerServiceWorker()` (`src/lib/webPush.ts:36`) still registers at the default `/`
scope — so no scope widening and no sticky-worker risk beyond what already shipped.

**`public/manifest.json` — one token.** Diff is exactly
`"purpose": "maskable"` → `"purpose": "any maskable"` on the 512 entry
(`public/manifest.json:12`). `name`, `short_name`, `description`, `start_url` (`/`,
no query string, no token), `display`, `background_color`, `theme_color`, `orientation`
and the other two icon entries are byte-identical. No `scope` widening, no
`share_target`, no `protocol_handlers`, no `related_applications` — none of the manifest
fields that carry a security surface were added. `app.json` untouched (slug intact,
CLAUDE.md hard rule respected). AC-10 satisfied.

**`beforeinstallprompt` store — no PII, no tokens, no cross-user replay.**
`src/lib/installGuide.ts:116-119` holds exactly three module-level values: the captured
event (`deferredPrompt`), a subscriber array, and a teardown ref. No user id, email,
store id, JWT, session, or any Supabase value is read or stored — the module imports
only `react`, `Platform` and `detectIos` (`src/lib/installGuide.ts:30-32`), so the
supabase client is not even reachable at module-eval.

Replay analysis: `BeforeInstallPromptEvent` is an origin-scoped browser UI object, not a
credential — it carries no user identity, and firing it can only offer to install the
already-public origin's PWA. It survives sign-out (module state is not cleared on auth
change), so a user-switch on a shared device leaves it captured; that is not a
cross-user leak because there is nothing user-specific in it and `prompt()` grants no
access to anything. The event is genuinely one-shot: `promptInstall()`
(`src/lib/installGuide.ts:186-199`) nulls the ref *before* awaiting `userChoice`, so a
second call returns `'unavailable'` without touching the stale event (avoiding
`InvalidStateError`), and `appinstalled` (`:148-151`) clears it. `notify()` (`:121-130`)
copies the subscriber list and swallows subscriber throws, so a malfunctioning consumer
cannot wedge the store. Listeners are installed only via an explicit
`startInstallPromptCapture()` call from `App.tsx:426` inside the web branch — no
import-time side effects — and the call is idempotent (`:139`) with a teardown returned
as the effect cleanup.

**UA-string handling.** `detectInstallPlatform()` (`src/lib/installGuide.ts:89-94`) reads
`navigator.userAgent` and tests it with the literal `/Android/i` — a constant, non-nested,
non-backtracking pattern, so no ReDoS; the UA value is used only to pick one of three
enum members and is never rendered, logged, stored, sent anywhere, or used to build a
selector/URL/query. `detectIos()` is reused rather than forked
(`src/lib/notificationState.ts:105-115`), so the iPadOS-masquerade heuristic keeps one
definition. Both probes are null-guarded (`Platform.OS !== 'web' || typeof navigator ===
'undefined'` → `'desktop'`) and cannot throw off-web.

**`detectStandalone()` extraction.** `src/lib/notificationState.ts:130-137` is a verbatim
move of the former inline expression (same `Platform.OS === 'web'` + `typeof window !==
'undefined'` guards, same `navigator.standalone || matchMedia('(display-mode: standalone)')`
OR); `probeNotificationState` now calls it (`:153`). Behavior-identical, no new global
reads, no security boundary involved. `installGuide.ts:100` re-exports it, keeping the
dependency one-directional (no module cycle that could leave a partially-initialized
`notificationState` at runtime).

**No new network calls (AC-REG4).** Grep over added lines: zero `fetch(`, zero
`XMLHttpRequest`, zero `supabase.from` / `supabase.rpc` / `functions.invoke`, zero
`src/lib/db.ts` import, zero store import in the new modules. The only I/O the feature
performs is DOM event listening and `navigator` / `matchMedia` reads. No
`notifyBackendError` import (there is no round-trip to fail). Staged file list contains
nothing under `supabase/`, and no `src/lib/db.ts`, `src/store/useStore.ts`,
`src/screens/staff/store/useStaffStore.ts`, `src/lib/cmdSelectors.ts`,
`src/lib/sidebarLayout.ts`, `vercel.json`, `app.json` or `package.json`. AC-REG4 holds:
no RLS surface, no policy, no RPC, no edge function, no `verify_jwt` decision,
no `auth_can_see_store` / `auth_is_admin` implication, no realtime publication change.

**Authorization.** The feature exposes no data and gates nothing on identity — the two
render gates are `Platform.OS === 'web'` and `!detectStandalone()`
(`src/screens/cmd/ResponsiveCmdShell.tsx:285`,
`src/components/cmd/InstallGuideSheet.tsx:64`,
`src/screens/staff/components/InstallGuideCard.tsx:49`), both device-capability checks,
neither used as a security boundary. No new use of the placeholder `useRole()` anywhere
in the diff.

**Injection / rendering.** Step text is resolved as
`T('chrome.installGuide.steps.' + step.key)` where `step.key` comes from the pure model's
literal table (`src/lib/installGuide.ts:50-77`) — no user-controlled catalog lookup, so
no key-traversal into unintended catalog subtrees. All rendering is React Native `<Text>`
(no `dangerouslySetInnerHTML`, no HTML string building, no `eval`, no URL construction);
this is not an edge function, so the `escapeHtml` rule does not apply. The 18 new catalog
keys across all six files carry no interpolation placeholders, no URLs, no email
addresses, no PII — only OS control-label prose and the product name "I.M.R".

**Secrets / logging / PII.** No `process.env`, no `EXPO_PUBLIC_*`, no service-role key,
no service token, no third-party key anywhere in the diff. No `console.log` /
`console.warn` added. The only `localStorage` writes in the diff are inside
`src/screens/cmd/__tests__/ResponsiveCmdShell.spec153.test.tsx` (test fixtures for the
existing tablet-collapse pref), not in shipped code.

## Dependencies

No `package.json` / `package-lock.json` changes in this diff — `npm audit` skipped per
process step 3.

## Verdict

No Critical and no High findings. Nothing here blocks the spec from advancing on
security grounds. The two Low items on `sw.js` are drift-prevention and a pre-existing
open-redirect-shaped nit, neither of which requires action before this deploy.

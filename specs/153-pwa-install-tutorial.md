# Spec 153: Add-to-Home-Screen (PWA install) tutorial in Settings

Status: READY_FOR_REVIEW

> Owner request (verbatim intent): *"create screenshots for admins and staff on
> phones how to add PWA to the home screen, have that tutorial in the setting
> page."*
>
> Managers and staff reach this app in a mobile browser tab. Nobody tells them
> the app can be installed, so they lose the icon, re-type the URL, and — on
> iOS — silently cannot receive push notifications at all (iOS Safari exposes
> `PushManager` only to installed web apps; `deriveNotificationState` already
> renders a one-line `needs-install` hint for exactly this reason,
> [src/lib/notificationState.ts:65](../src/lib/notificationState.ts)). This spec
> turns that one-liner into a real, discoverable, per-platform tutorial on both
> surfaces. Frontend-only. No migration, no RPC, no edge function.

## User story

As a store manager (admin surface) or an EOD-count staff member (staff surface)
opening this app in a phone browser, I want a short illustrated tutorial in
Settings that shows me exactly how to add the app to my Home Screen on **my**
phone, so that I get a one-tap app icon and — on iOS — can actually turn on
notifications.

## Findings from the codebase (what already exists, what does not)

Establishes the real starting point so the architect is not designing blind.

**The PWA is already installable — no new plumbing needed.**

| piece | state |
|---|---|
| [public/manifest.json](../public/manifest.json) | `name`, `short_name` `I.M.R`, `start_url` `/`, `display: standalone`, `theme_color`, 192 / 512 / 180 icons — present |
| manifest `<link>` | injected at runtime by `ensureManifestLinked()` ([src/lib/webPush.ts:156](../src/lib/webPush.ts)), called from [App.tsx:416](../App.tsx) (Expo's generated `index.html` has no manifest link) |
| `apple-touch-icon` | injected by `ensureAppleTouchIconLinked()`; `/apple-touch-icon.png` also sits at the site root |
| service worker | `/sw.js` registered at app start ([App.tsx:418](../App.tsx)); [vercel.json](../vercel.json) serves it `no-cache` with `Service-Worker-Allowed: /` |
| `public/` → `dist/` | Expo web export copies `public/` to the output root; Vercel serves `dist/` |

**Two small gaps found, both relevant to this spec:**

1. `manifest.json`'s 512 icon is `"purpose": "maskable"` **only**. Chrome's
   installability check wants an icon usable as `any`; today only the 192 entry
   qualifies. One-token fix (`"any maskable"`), no new asset. In scope.
2. `public/sw.js` registers `install` / `activate` / `push` / `notificationclick`
   but **no `fetch` listener**. Chrome has historically gated
   `beforeinstallprompt` on a service worker with a fetch handler. That makes the
   optional one-tap install button unreliable today — see Q3.

**Surfaces:**

- **Staff** has a real Settings screen —
  [src/screens/staff/screens/Settings.tsx](../src/screens/staff/screens/Settings.tsx)
  (spec 126): Notifications → Language → Text size → Report an issue → Sign out.
  A card slots straight in.
- **Admin has no Settings section at all.** `useDefaultSidebarGroups`
  ([src/lib/cmdSelectors.ts:1092](../src/lib/cmdSelectors.ts)) lists Operations /
  Planning / Insights / Admin / Tenancy — no settings entry. The chrome carries
  theme + refresh + bell only; the sidebar/drawer **footer** carries `● name` +
  sign out ([ResponsiveCmdShell.tsx:271](../src/screens/cmd/ResponsiveCmdShell.tsx)).
  Placement therefore has to be decided — see §3 and Q1.
- Reusable idioms exist and should be reused, not re-invented:
  `ResponsiveSheet` (phone fullscreen / tablet bottom-sheet / desktop right-drawer),
  `TabStrip`, `PhoneDrillScaffold`, the Cmd token set, and the staff-local card /
  token set.

**"Screenshots": rejected, deliberately.** Real OS screenshots would mean ~18
bundled PNGs (3 platforms × ~3 steps × light/dark), which cannot be localized
(the strings live inside the image), go stale on every iOS/Android release,
ignore both theme palettes, and contradict the phone design handoff's *"Assets:
None required"*. This spec ships **illustrated step cards** drawn with app
tokens: a numbered marker, a mono glyph tile carrying the platform's real
control glyph, and localized text quoting the OS's real menu labels. Same
information, zero assets, fully i18n + theme correct.

## Design

Four parts. All frontend, all additive.

### 1 — One pure model, two thin views (`src/lib/installGuide.ts`, new)

Mirrors the split that already works in `notificationState.ts`: a **pure,
catalog-agnostic** core that jest can exercise without a browser, plus impure
one-line UA/display probes that are not unit-tested in isolation.

- `type InstallPlatform = 'ios' | 'android' | 'desktop'`
- `interface InstallStep { n: number; glyph: string; key: string }` — `key` is a
  catalog-**relative** suffix (`'ios.step1'`), so each surface prefixes it with
  its own catalog root. This is what lets the admin and staff catalogs stay two
  independent trees (spec 063 contract) over one model.
- `installSteps(p): InstallStep[]` — pure, total, exhaustive `switch` with a
  `never` guard.
- `detectInstallPlatform(): InstallPlatform` — impure; reuses the existing
  `detectIos()` from `notificationState.ts` (do not fork the iPadOS-masquerade
  heuristic), `/Android/i` for android, else desktop.
- `detectStandalone(): boolean` — **extracted verbatim** from the inline
  expression inside `probeNotificationState`
  ([notificationState.ts:129-138](../src/lib/notificationState.ts)), which then
  calls the extracted helper. Behavior-identical; one source of truth for
  "already installed". Pinned by AC-REG1.
- `useInstallPrompt()` → `{ available: boolean; promptInstall: () => void }` —
  captures `beforeinstallprompt` into a module-level ref (the event can fire
  before any component mounts), `preventDefault()`s it, exposes a one-shot
  `prompt()`, and clears on `appinstalled`. Web-only; a no-op elsewhere.

Step content (English source of truth; the catalogs carry the translations):

| platform | steps |
|---|---|
| `ios` (4) | Open this page in **Safari** → tap the **Share** button `↑` in the toolbar → scroll and tap **"Add to Home Screen"** → tap **"Add"** |
| `android` (3) | Tap the **⋮** menu (top right) → tap **"Install app"** or **"Add to Home screen"** → tap **Install** to confirm |
| `desktop` (2) | Click the **install** icon `⊕` at the right of the address bar (or **⋮ → Cast, save and share → Install page as app**) → click **Install** |

### 2 — Admin view: `src/components/cmd/InstallGuideSheet.tsx` (new)

`ResponsiveSheet` (`phone: fullscreen`, `tablet/desktop: right-drawer`) with:
title + ✕ header; a 3-tab `TabStrip` (iOS / Android / Desktop) **initialized**
from `detectInstallPlatform()` and freely switchable by hand (a manager helping
a staff member on a different phone needs the other tab); the numbered step
cards; the optional install button (§1) rendered only when
`useInstallPrompt().available`; and an "already added" confirmation state when
`detectStandalone()`.

### 3 — Entry points

- **Staff** — an `InstallGuideCard` rendered inline in `Settings.tsx` between
  **Text size** and **Report an issue**, using staff-local tokens/components and
  the staff catalog. Inline (not a sheet) because staff Settings is already a
  scrolling settings page and the card is the surface's native idiom.
- **Admin (recommended default, Q1)** — one additive chip, styled like the
  existing sign-out chip, appended to the shell's shared footer slot
  (`sidebarFooterLeft`) plus `railFooter` in
  [ResponsiveCmdShell.tsx](../src/screens/cmd/ResponsiveCmdShell.tsx). That single
  insertion point already renders in **all three breakpoints** — desktop
  `Sidebar` footer, tablet `Sidebar`/`RailSidebar` footer, and the phone
  `MobileNavDrawer` footer — so the phone hamburger drawer (the admin's de-facto
  settings surface) gets it for free. Chosen over a new sidebar section id
  because a tutorial is not a data section, and a new id would drag in the spec
  008 sidebar-override machinery (`applySidebarOverride` /
  `remapLegacySidebarOverrideIds` / persisted `profiles.sidebar_layout`) for a
  help link. Hidden off-web and when already installed.

### 4 — Manifest hardening (minimal)

`public/manifest.json`: the 512 icon becomes `"purpose": "any maskable"`. Nothing
else in the manifest changes. **`app.json` is not touched at all** — in
particular the `slug` (`towson-inventory`) stays, per CLAUDE.md's hard rule.

## Acceptance criteria

- [ ] **AC-1** Staff `Settings` renders an "Add to Home Screen" card (testID
      `staff-install-guide`) between the Text-size section and the Report-an-issue
      card, showing the numbered steps for the detected platform.
- [ ] **AC-2** The admin shell renders an additive install entry (testID
      `cmd-install-guide-entry`) in the footer slot at **all three** breakpoints
      (desktop sidebar, tablet sidebar and rail, phone drawer); pressing it opens
      the sheet (testID `install-guide-sheet`).
- [ ] **AC-3** `installSteps()` is pure and total: `ios` → 4 steps, `android` → 3,
      `desktop` → 2, each with a stable `n` / `glyph` / `key`; a new
      `InstallPlatform` member fails compilation via the `never` guard.
- [ ] **AC-4** The rendered tab defaults to `detectInstallPlatform()` and the user
      can switch tabs manually; switching re-renders that platform's step list
      without remounting the sheet.
- [ ] **AC-5** Every user-visible string in both views resolves through the
      catalogs (`chrome.installGuide.*`) — no hardcoded English in either
      component; keys exist in all six catalog files (`src/i18n/{en,es,zh-CN}.json`
      **and** `src/screens/staff/i18n/{en,es,zh-CN}.json`), enforced by the two
      existing i18n parity suites.
- [ ] **AC-6** Zero new image assets: the step cards render from theme tokens plus
      text glyphs only. `git status` shows no additions under `assets/` or
      `public/*.png`.
- [ ] **AC-7** When `detectStandalone()` is true, the admin footer entry does not
      render and the staff card renders its "already added" state instead of the
      steps.
- [ ] **AC-8** Off-web (`Platform.OS !== 'web'`, i.e. the EAS native build)
      neither the admin entry nor the staff card renders, and nothing throws.
- [ ] **AC-9** The one-tap install button renders **only** when a
      `beforeinstallprompt` event was captured; pressing it calls the deferred
      `prompt()` exactly once; the button disappears after `appinstalled`. It never
      renders on the `ios` tab.
- [ ] **AC-10** `public/manifest.json`'s 512 icon carries `"purpose": "any
      maskable"`; every other manifest field is byte-unchanged; `app.json` is not
      modified (slug included).
- [ ] **AC-11** *(conditional on Q3 = yes)* `public/sw.js` gains a no-op
      pass-through `fetch` listener that installs no cache, intercepts no response,
      and leaves the existing `install` / `activate` / `push` / `notificationclick`
      handlers byte-unchanged.

### Regression group (AC-REG)

- [ ] **AC-REG1** Extracting `detectStandalone()` changes no behavior:
      `deriveNotificationState` and `probeNotificationState` keep their contracts
      and the existing `src/lib/notificationState.test.ts` passes **unmodified**.
- [ ] **AC-REG2** Staff `Settings` is otherwise unchanged: section order
      (Notifications → Language → Text size → **[new card]** → Report an issue →
      Sign out), the report-an-issue submit path, and the spec-152 sign-out
      ordering pins (`markIntentionalSignOut` before `signOut()`,
      `clearIntentionalSignOut` on rejection) all stay green.
- [ ] **AC-REG3** Admin chrome is unchanged apart from the additive entry: the
      TitleBar cluster (theme / refresh / bell / brand picker), the phone top-app-bar
      trailing trio, `SessionLostBanner` placement, and the groups returned by
      `useDefaultSidebarGroups` are untouched — **no new sidebar section id**, so no
      `profiles.sidebar_layout` override migration is implied.
- [ ] **AC-REG4** No backend surface moves: no change to `src/lib/db.ts`, the
      Zustand stores, any RPC, any edge function, or any migration; the feature
      issues no network request of its own.

## Non-goals (explicitly)

- **Real OS screenshots.** Rejected above (i18n, theming, staleness, asset
  weight). If the owner overrules, it is a separate spec with its own asset
  pipeline — see Q7.
- **Native app store distribution.** This is about the web PWA; the EAS build is
  untouched and the tutorial does not render there.
- **Service-worker / offline behavior beyond what exists.** No caching strategy,
  no precache manifest, no offline page. AC-11's listener, if taken, is a
  no-op whose only purpose is installability signaling.
- **Changing `app.json`** — slug, bundle identifiers, icons, EAS config. Hard rule.
- **Auto-prompting / nagging.** No automatic install banner, no interstitial on
  login, no "remind me later" state (see Q5).
- **Rebuilding the existing `needs-install` notification hint.** It stays exactly
  as it is unless Q2 is answered yes.
- **A general admin Settings section.** This spec adds one entry, not a settings
  home; a real admin Settings surface is its own spec.
- **Desktop-Safari / Firefox install paths.** Neither supports installable PWAs
  the way Chromium and iOS Safari do; the Desktop tab documents the Chromium path
  and the tutorial does not attempt browser-specific fallbacks.

## Open questions (non-blocking — defaults chosen, owner may overrule)

- **Q1 — Admin placement.** Footer chip in the shared sidebar/drawer footer
  (renders at all three breakpoints, no sidebar-override churn) **[default]** vs.
  a new `Settings` sidebar section vs. phone-drawer-only.
- **Q2 — Second entry point.** Should the existing `needs-install` notification
  hint ("Add this app to your Home Screen to enable notifications") gain a *"Show
  me how"* link into this tutorial, on both surfaces? **Default: no** (keeps this
  spec to one entry point per surface; trivially additive later).
- **Q3 — `sw.js` no-op `fetch` listener.** Without it Chrome may never fire
  `beforeinstallprompt`, so AC-9's one-tap button would be dead code on Android.
  **Default: yes**, add the 3-line no-op. The manual steps work either way — if
  Q3 = no, drop AC-11 and treat AC-9 as opportunistic.
- **Q4 — App name in the copy.** Steps quote the installed name; the manifest
  says `short_name: "I.M.R"` while the brand is "2AM PROJECT". **Default: quote
  the manifest `short_name` literally** ("I.M.R") so the copy matches what the
  user actually sees on the Home Screen.
- **Q5 — First-run nudge.** One-time toast/banner on first phone sign-in pointing
  at the tutorial? **Default: no** (Settings-only, as requested).
- **Q6 — Already-installed behavior.** **Default:** admin entry hides, staff card
  switches to an "already added" confirmation (staff Settings is a page where a
  disappearing row is more confusing than a confirmation).
- **Q7 — Screenshots later.** If the owner wants literal screenshots, that is a
  follow-up spec: asset pipeline, per-OS-version maintenance, and an accepted
  loss of i18n inside the images.

## Verification (test track: **jest**)

New / touched suites:

- `src/lib/installGuide.test.ts` (new) — AC-3, AC-4 (default-tab resolution given
  a stubbed UA), AC-9's prompt/`appinstalled` state machine, and the
  `detectStandalone()` truth table.
- `src/components/cmd/InstallGuideSheet.test.tsx` (new) — AC-2, AC-4, AC-7, AC-8,
  AC-9 render gates.
- `src/screens/staff/screens/Settings.test.tsx` (extend) — AC-1, AC-7, AC-REG2
  (section order + the existing spec-152 sign-out pins stay green).
- `src/lib/notificationState.test.ts` — must pass **unmodified** (AC-REG1).
- The two i18n parity suites (`src/i18n/i18n.test.ts`,
  `src/screens/staff/i18n/i18n.test.ts`) cover AC-5 for free once keys land.
- Full `npx jest`, plus `npx tsc --noEmit` and `npm run typecheck:test` (the
  test-graph typecheck is a CI gate jest alone misses).

No pgTAP track (no DB surface). No shell-smoke track (no HTTP surface).

**Manual browser check (not CI)** — UA detection and `beforeinstallprompt` are
browser-dependent: real iPhone Safari (steps match the live Share sheet), real
Android Chrome (steps match the ⋮ menu; install button appears if Q3 = yes), and
desktop Chrome at 1440×900 + 390×844.

## Dependencies

- Existing: `ResponsiveSheet`, `TabStrip`, `useT` / staff `useI18n`, Cmd + staff
  token sets, `detectIos()` from `src/lib/notificationState.ts`.
- No new libraries, no migration, no edge function, no RPC.
- Vercel already serves `public/manifest.json` and `/sw.js` correctly — nothing to
  add to `vercel.json`.

## Project-specific notes

- **Cmd UI section:** none added. The admin surface gets a chrome-footer entry in
  `ResponsiveCmdShell` plus a new component under `src/components/cmd/`; no new
  sidebar section id and therefore no spec-008 override migration.
- **Per-store or admin-global:** neither — this is per-**device** UI state with no
  server persistence. `auth_can_see_store()` is not involved.
- **Realtime channels touched:** none.
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Edge function vs PostgREST:** N/A — the feature makes no backend call.
- **Web/native scope:** web-only behavior; on native (EAS) both entry points
  render nothing (AC-8). Ships via the Vercel web build.
- **`app.json` slug:** untouched (`towson-inventory`), per CLAUDE.md.
- **Tests:** jest track only.

## Files expected to change (architect may refine)

- `specs/153-pwa-install-tutorial.md` (this file)
- `src/lib/installGuide.ts` (new) + `src/lib/installGuide.test.ts` (new)
- `src/lib/notificationState.ts` (extract `detectStandalone()`)
- `src/components/cmd/InstallGuideSheet.tsx` (new) + test (new)
- `src/screens/cmd/ResponsiveCmdShell.tsx` (footer entry)
- `src/screens/staff/components/InstallGuideCard.tsx` (new)
- `src/screens/staff/screens/Settings.tsx` + `Settings.test.tsx`
- `src/i18n/{en,es,zh-CN}.json`, `src/screens/staff/i18n/{en,es,zh-CN}.json`
- `public/manifest.json` (512 icon purpose)
- `public/sw.js` (only if Q3 = yes)

---

## Backend design

**Verdict up front: this spec is frontend-only. AC-REG4 is confirmed and binding.**
No migration, no RPC, no PostgREST call, no edge function, no `src/lib/db.ts`
change, no Zustand slice change, no realtime publication change. The sections
below that would normally carry a contract are answered "none" *with the
reasoning*, so a reviewer can tell the absence is a decision rather than an
omission.

### 0 — Backend surfaces: explicit nulls

| surface | decision |
|---|---|
| **Data model / migration** | **None.** No new table, column, index, view. Proposed migration filename: *n/a — do not author one.* The feature's entire state is per-device browser state (`navigator.userAgent`, `display-mode`, a captured `BeforeInstallPromptEvent`). There is nothing to persist and nothing store-scoped. If a future spec wants "dismissed the install nudge" persistence (Q5), that is a `profiles`-level per-user boolean and a separate design. |
| **RLS impact** | **None.** No new table, so no new policies; no existing policy changes. Neither `auth_is_admin()` nor `auth_can_see_store(store_id)` is involved — this is per-**device** UI, not per-store data. Reviewers: an `auth_can_see_store` grep on this diff should return zero hits. |
| **API contract (PostgREST vs RPC)** | **N/A.** The feature issues zero network requests of its own. The only new "I/O" is DOM event listening (`beforeinstallprompt`, `appinstalled`) and reading `navigator` / `matchMedia`. |
| **Edge functions** | **None new, none modified.** No `supabase/config.toml` change, so no `verify_jwt` decision and no service-token validation strategy to specify. |
| **`src/lib/db.ts` surface** | **Unchanged.** Do NOT add a helper here. `installGuide.ts` is a sibling `src/lib/` module with no Supabase import — same footing as `notificationState.ts` and `sessionWatch.ts`, neither of which touches `db.ts`. Because there is no PostgREST payload, there is **no snake_case → camelCase mapping** to write; `mapItem`-style helpers are not applicable. |
| **Realtime impact** | **None.** Neither `store-{id}` nor `brand-{id}` replays anything here. **Publication gotcha explicitly does not apply:** this diff changes no `supabase_realtime` publication membership, therefore `docker restart supabase_realtime_imr-inventory` after `npm run dev:db` is **not** required for this spec. (Stated so a reviewer running the local stack doesn't go looking for a missing restart step.) |
| **Frontend store impact** | **None.** No slice of `src/store/useStore.ts` and none of `src/screens/staff/store/useStaffStore.ts` changes. The **optimistic-then-revert + `notifyBackendError` pattern does not apply** — there is no server round-trip that can fail, so there is nothing to revert and nothing to toast. A `notifyBackendError` import in this diff is a design violation. |
| **Deploy steps** | Plain Vercel web deploy. `public/manifest.json` and `public/sw.js` are copied verbatim into `dist/` by `npx expo export --platform web` ([vercel.json](../vercel.json)); no `vercel.json` change. No `supabase db push`, so the `db-migrations-applied.yml` gate is unaffected by this spec. |

### 1 — Module boundary: where `detectStandalone()` actually lives (binding)

The spec's §1 lists `detectStandalone()` among `installGuide.ts`'s exports while
also requiring `installGuide.ts` to **import** `detectIos()` from
`notificationState.ts`. Taken literally that is a **module cycle**
(`notificationState → installGuide → notificationState`), which Metro and jest
both resolve to a partially-initialized module — the classic
`undefined is not a function` at first call. Ruling:

- **Canonical definition:** `detectStandalone()` is defined and exported from
  **`src/lib/notificationState.ts`**, directly above `probeNotificationState`,
  in the same "Impure UA heuristic (NOT unit-tested in isolation)" block that
  already holds `detectIos()`. `probeNotificationState` then reads
  `const isStandalone = detectStandalone();` in place of the inline expression
  at [notificationState.ts:129-138](../src/lib/notificationState.ts). The
  extracted body is **byte-identical** to the current expression, including the
  `Platform.OS === 'web'` and `typeof window !== 'undefined'` guards and the
  `navigator.standalone` / `matchMedia('(display-mode: standalone)')` OR.
- **Ergonomic re-export:** `installGuide.ts` carries
  `export { detectStandalone } from './notificationState';` so views and the
  `installGuide` test suite import it from the module the spec names, with a
  strictly one-directional dependency `installGuide → notificationState`.
- **AC-REG1 is then trivially satisfied by construction:**
  `src/lib/notificationState.test.ts` imports only `deriveNotificationState`,
  `subscribeCodeToMessageKey` and the `DeriveInput` type
  ([notificationState.test.ts:10-14](../src/lib/notificationState.test.ts)) —
  none of which change. The file must pass **unmodified**; if the developer
  finds themselves editing it, the extraction was not behavior-preserving and
  the change is wrong.
- Corollary: `detectIos()` is currently exported but has **no importer outside
  its own file** (verified). `installGuide.ts` becomes its first external
  consumer. Do not fork the iPadOS-13 masquerade heuristic.

### 2 — `src/lib/installGuide.ts` — the pure model + the capture store

Two halves, mirroring the `notificationState.ts` split the spec cites, plus a
third piece the spec under-specifies (the `beforeinstallprompt` state machine),
which is designed here as a **module-level listener store in the
[`sessionWatch.ts`](../src/lib/sessionWatch.ts) shape** rather than as
hook-internal state. Rationale below.

```ts
// ── Pure model (the jest target) ─────────────────────────────────────
export type InstallPlatform = 'ios' | 'android' | 'desktop';

/** One tutorial step. `key` is a catalog-RELATIVE suffix; each surface
 *  prefixes it with its own catalog root (spec 063 two-tree contract). */
export interface InstallStep {
  n: number;      // 1-based; stable across locales
  glyph: string;  // the OS's literal control mark — NOT translatable
  key: string;    // e.g. 'ios.step1' → `chrome.installGuide.steps.ios.step1`
}

/** Pure, total, exhaustive switch with a `never` guard (AC-3). */
export function installSteps(p: InstallPlatform): InstallStep[];

// ── Impure probes (NOT unit-tested in isolation) ─────────────────────
export function detectInstallPlatform(): InstallPlatform;
export { detectStandalone } from './notificationState';

// ── beforeinstallprompt capture — module store, sessionWatch shape ───
/** Install the window listeners. Idempotent; returns a teardown.
 *  Called ONCE from App.tsx's web branch. No-op off-web. */
export function startInstallPromptCapture(): () => void;
/** Current snapshot — a primitive, so it is a safe getSnapshot(). */
export function isInstallPromptAvailable(): boolean;
/** Subscribe to availability changes. Returns an unsubscribe. */
export function subscribeInstallPrompt(cb: () => void): () => void;
/** One-shot. Calls the deferred event's prompt(), clears the ref, notifies.
 *  Resolves 'unavailable' when nothing was captured. Never throws. */
export function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'>;
/** Test-only: drop the captured event + all subscribers. */
export function _resetInstallPrompt(): void;

// ── Thin React wrapper (tested through the component, not here) ──────
export function useInstallPrompt(): {
  available: boolean;
  promptInstall: () => void;   // fire-and-forget wrapper; swallows rejection
};
```

Binding notes on this surface:

1. **Why a module store and not `useState` inside the hook.** `src/lib/**/*.test.ts`
   runs in the **`node`** jest project ([jest.config.js:83-103](../jest.config.js)) —
   no DOM, no `renderHook`. A hook-internal state machine could only be tested
   from the jsdom component project, which would put AC-9's logic behind a
   component render. Exposing `isInstallPromptAvailable` / `promptInstall` /
   `subscribeInstallPrompt` / `_resetInstallPrompt` as plain functions makes the
   whole state machine node-testable, exactly the way `sessionWatch.ts` exposes
   `handleAuthEvent` + `_resetSessionWatch` for its pins. `useInstallPrompt` is
   then a `useSyncExternalStore(subscribeInstallPrompt, isInstallPromptAvailable,
   isInstallPromptAvailable)` one-liner. Note `getSnapshot` returns a **boolean
   primitive** — do not return a fresh object, or React 19 will loop on the
   snapshot-identity check. (This is the codebase's first `useSyncExternalStore`;
   justified because the source is a browser event, not a Zustand slice, and
   pulling it into `useStore` would violate AC-REG4.)
2. **`installGuide.ts` must import nothing from a `.tsx` file** and nothing from
   `react-native` beyond `Platform`. That is what keeps its suite in the fast
   node project (see the jest.config comment at line 112-117). `react` is fine.
3. **Listener installation point:** the web branch of the existing effect in
   [App.tsx:410-420](../App.tsx), next to `ensureManifestLinked()` /
   `registerServiceWorker()`. Chrome fires `beforeinstallprompt` only after the
   manifest is parsed *and* the service worker has activated, both of which are
   downstream of that effect, so the "event fires before any component mounts"
   race the spec worries about cannot beat this call site in practice. Keep the
   listener registration out of module top-level scope (import-time side effects
   are test-hostile and would fire in every suite that touches the module).
4. **`promptInstall()` is genuinely one-shot.** The spec's `BeforeInstallPromptEvent`
   can be `prompt()`ed exactly once; a second call throws `InvalidStateError`.
   Clear the module ref *before* awaiting `userChoice`, and notify subscribers
   immediately so the button disappears on tap rather than on resolve.
5. **`appinstalled`** clears the ref and notifies (AC-9's "button disappears").
6. **Glyphs live in the model, not the catalog.** `↑` / `⋮` / `⊕` are literal OS
   control marks, not prose — translating them would be wrong. The surrounding
   sentence (which *names* the control) is what lives in the catalog. Reviewers:
   a glyph appearing in `en.json` is a design violation.
7. `detectInstallPlatform()` order: `detectIos()` → `'ios'`; else `/Android/i`
   on `navigator.userAgent` → `'android'`; else `'desktop'`. Off-web /
   `typeof navigator === 'undefined'` → `'desktop'` (a harmless default; AC-8's
   render gate means it is never displayed off-web anyway).

### 3 — Views: one model, two surfaces

**Admin — `src/components/cmd/InstallGuideSheet.tsx` (new)**

```tsx
interface InstallGuideSheetProps { visible: boolean; onClose: () => void }
export const InstallGuideSheet: React.FC<InstallGuideSheetProps>
```

- `ResponsiveSheet` with `presentation={{ phone: 'fullscreen', tablet: 'right-drawer', desktop: 'right-drawer' }}`,
  `accessibilityLabel={T('chrome.installGuide.title')}`, `testID` on an inner
  root `View` = `install-guide-sheet` (`ResponsiveSheet` takes no `testID` prop —
  [ResponsiveSheet.tsx:29-49](../src/components/cmd/ResponsiveSheet.tsx) — so put
  it on the header or body wrapper, not by adding a prop to the shared sheet).
- Header: title + `✕` close, copying the header shape of
  [PhoneNotifications.tsx:224-263](../src/screens/cmd/sections/phone/PhoneNotifications.tsx)
  (44×44 hit target, `T('common.closeAria')` — that key already exists).
- `TabStrip` with `fillEvenly` and per-tab `testID`s
  (`install-guide-tab-ios|android|desktop`); `activeId` seeded from
  `React.useState(() => detectInstallPlatform())`. AC-4's "without remounting the
  sheet" falls out for free because the step list is `installSteps(activeId)`
  computed in render — do **not** key the body on the tab.
- Body: numbered step cards from `installSteps(activeId)`, each rendering
  `T('chrome.installGuide.steps.' + step.key)` plus the glyph tile.
- Install button rendered iff `activeId !== 'ios' && useInstallPrompt().available`
  (AC-9's two gates, both required).
- `detectStandalone()` true → render the "already added" body instead of the
  tabs (the sheet is still reachable via a direct call even though §4 hides the
  entry; a `visible` sheet with no content would be a dead end).

**Admin entry — `src/screens/cmd/ResponsiveCmdShell.tsx` (modified)**

Per Q1's default. Precise placement, because the spec's "footer slot" is two
slots, not one:

- Append the chip to the **`sidebarFooterLeft`** element
  ([ResponsiveCmdShell.tsx:271-296](../src/screens/cmd/ResponsiveCmdShell.tsx)),
  after the sign-out `TouchableOpacity`, with `flexShrink: 0`. That single
  element is consumed by the desktop `Sidebar` (line 543), the tablet `Sidebar`
  (line 492, nested one level inside the collapse-toggle row) and the phone
  `MobileNavDrawer` (line 450) — three of the four renderings.
- Add a glyph-only twin (`⊕`) to **`railFooter`**
  ([ResponsiveCmdShell.tsx:309-322](../src/screens/cmd/ResponsiveCmdShell.tsx))
  for the tablet **collapsed rail**, which does not receive `sidebarFooterLeft`
  at all. AC-2 names the rail explicitly; without this the AC fails at
  `tabletCollapsed === true`.
- **Same `testID="cmd-install-guide-entry"` on both.** The two are mutually
  exclusive at render time (`tabletCollapsed ? RailSidebar : Sidebar`, and the
  phone/tablet/desktop branches are three separate `return`s), so there is no
  duplicate-testID collision in any single tree. Confirmed by reading all three
  branches — do not "fix" this by inventing a second testID, AC-2 pins the one.
- New shell state: `const [installGuideOpen, setInstallGuideOpen] = React.useState(false);`
  — plain component state, **not** a store slice.
- **Mount the sheet as a sibling of `{switchOverlay}` in all three `return`
  branches** (lines 453, 517, 548). RN has no shared parent across the three
  returns; the existing spec-111 `switchOverlay` comment documents exactly this
  and is the pattern to copy.
- **Critical, phone only:** `MobileNavDrawer` is itself a `<Modal transparent={false}>`
  ([MobileNavDrawer.tsx:62](../src/components/cmd/MobileNavDrawer.tsx)) and
  `ResponsiveSheet` is another `Modal`. The chip's `onPress` MUST close the
  drawer *and* open the sheet in the same handler
  (`setMobileDrawerOpen(false); setInstallGuideOpen(true);`) so the two modals
  never coexist. Rendering the sheet inside the drawer's footer is a nested-Modal
  bug — do not do it.
- Both entries are gated: `Platform.OS === 'web' && !detectStandalone()`
  (AC-7, AC-8). `detectStandalone()` is called at render; that is acceptable
  (it is a cheap synchronous read and the display mode cannot change without a
  reload) and avoids adding an effect to the shell.
- **AC-REG3 guard rails:** no change to `useDefaultSidebarGroups`
  ([cmdSelectors.ts:1092](../src/lib/cmdSelectors.ts)), no new sidebar section
  id, no touch to `applySidebarOverride` / `produceOverride` /
  `remapLegacySidebarOverrideIds`, no `profiles.sidebar_layout` implication, no
  change to the `TitleBar` cluster, the phone trailing trio, or
  `SessionLostBanner` placement.

**Staff — `src/screens/staff/components/InstallGuideCard.tsx` (new)**

```tsx
export function InstallGuideCard(props?: { testID?: string }): JSX.Element | null;
```

- Rendered inline in [Settings.tsx](../src/screens/staff/screens/Settings.tsx)
  between the Text-size `View style={styles.section}` block (line 156-162) and
  the Report-an-issue card (line 165), preserving AC-REG2's section order.
- Staff-local tokens/components only (`useStaffColors` / `useStaffTokens` /
  `useStaffElevation`, the `styles.card` shape at line 310), staff catalog via
  `useI18n().t`. Consuming the shared model from `src/lib/installGuide.ts` is
  **allowed and intended** — the staff subtree already imports
  `../../../lib/useNotificationToggle`, `../../../lib/webPush` and
  `../../../lib/sessionWatch`. The spec-063 contract that must hold is "staff
  code never imports `useStore`"; `installGuide.ts` imports no store, so it is
  clean. Verify: `installGuide.ts` must not gain a store import later.
- Returns `null` when `Platform.OS !== 'web'` (AC-8). When `detectStandalone()`
  is true it renders the "already added" confirmation, not `null` (Q6 default,
  AC-7) — a disappearing row on a settings page is the confusing outcome.
- `testID` defaults to `staff-install-guide` (AC-1).
- No tabs on staff: staff sees only `detectInstallPlatform()`'s steps. The
  cross-platform tab switcher is an admin affordance (a manager helping someone
  on a different phone) — the staff surface stays a single card. If the
  developer wants tabs here too, that is scope creep; flag it, don't ship it.

### 4 — i18n keys (AC-5)

Both catalogs get the **same** subtree under their existing top-level `chrome`
object (verified present in both: [src/i18n/en.json:45](../src/i18n/en.json) and
[src/screens/staff/i18n/en.json](../src/screens/staff/i18n/en.json)):

```
chrome.installGuide.title
chrome.installGuide.chip            (admin footer chip label — keep SHORT;
                                     es/zh expansions must survive numberOfLines={1})
chrome.installGuide.chipAria
chrome.installGuide.intro
chrome.installGuide.tabs.ios | .android | .desktop
chrome.installGuide.steps.ios.step1 … step4
chrome.installGuide.steps.android.step1 … step3
chrome.installGuide.steps.desktop.step1 … step2
chrome.installGuide.installButton
chrome.installGuide.installButtonAria
chrome.installGuide.installed.title
chrome.installGuide.installed.body
```

Six files: `src/i18n/{en,es,zh-CN}.json` and
`src/screens/staff/i18n/{en,es,zh-CN}.json`. The two existing parity suites
([src/i18n/i18n.test.ts:41](../src/i18n/i18n.test.ts) and the staff twin) fail
the build on any missing key, so AC-5 needs no new assertion — but the keys must
land in **all six** files, not three. Q4 default stands: the step copy quotes the
manifest `short_name` **"I.M.R"** literally, kept verbatim in es/zh-CN (it is a
product name, not prose).

### 5 — `public/manifest.json` (AC-10) — with a factual correction

Ship the one-token change (`"purpose": "maskable"` → `"purpose": "any maskable"`
on the 512 entry, [manifest.json:12](../public/manifest.json)), everything else
byte-unchanged, `app.json` untouched including the `slug`
(`towson-inventory` — CLAUDE.md hard rule; this spec has no reason to go near it
and none of the ACs imply it).

**Correction the developer needs:** the spec's finding #1 says Chrome's
installability check "wants an icon usable as `any`; today only the 192 entry
qualifies." The 192 entry *already carries* `"purpose": "any"`, and Chrome's
threshold is a ≥144px `any`-purpose PNG — so **installability is already
satisfied today**. The AC-10 change is a real improvement (large `any`-purpose
coverage for splash/task-switcher surfaces) but it does **not** unblock
`beforeinstallprompt`. Q3's fetch listener is the item actually gating AC-9. Do
not let AC-10 be reported as the fix for a dead install button.

**Tradeoff to accept knowingly:** `icon-512.png` was authored for the maskable
safe zone (~80% inset). Advertising it as `any` means some surfaces may render it
with visible padding. Judged acceptable versus adding a second 512 asset, which
AC-6 forbids. Also: already-installed PWA instances refresh manifest-derived
icons lazily (Chrome re-reads on its own schedule; iOS not until reinstall) —
this is a new-install-only improvement, not a retroactive one.

### 6 — `public/sw.js` (AC-11, Q3 = yes) — service-worker update lifecycle

Take Q3's default. The listener is **three lines and must not call
`event.respondWith()`**:

- A `fetch` listener that registers but never responds leaves the browser's
  default network path completely intact. That is the entire point — it is an
  installability *signal*, not a network intermediary.
- **Hard prohibition:** any `event.respondWith(...)`, `caches.open`,
  `caches.match`, or precache list in this diff is a Critical. This service
  worker would otherwise sit in front of **every** request the app makes,
  including Supabase PostgREST reads, `/auth/v1` token refreshes and edge-function
  calls. A cache-first strategy there produces stale inventory data and
  authentication failures that are near-impossible to diagnose from the client.
  Offline behavior is an explicit non-goal of this spec.
- The existing `install` / `activate` / `push` / `notificationclick` handlers stay
  byte-unchanged (AC-11).

**Update lifecycle — this is a deploy-time concern, state it in the PR:**

1. [vercel.json](../vercel.json) serves `/sw.js` with `Cache-Control: no-cache`
   and `Service-Worker-Allowed: /`, so the browser revalidates the script on each
   registration and on its periodic (≤24h) update check. A byte-diff is picked up
   promptly; there is no long-lived cached copy to fight.
2. The existing `self.skipWaiting()` (install) + `self.clients.claim()` (activate)
   mean the new worker takes over **immediately** rather than waiting for all tabs
   to close. That behavior is unchanged by this spec — the same mid-session
   takeover already happens on every deploy that touches `sw.js`.
3. **Expected first-load behavior (not a bug):** a page load is only *controlled*
   by a service worker after that worker has activated and claimed. On the very
   first visit after this deploy, Chrome's installability heuristic may not see a
   controlled navigation with a fetch handler until the **next** page load — so
   the one-tap install button (AC-9) can legitimately be absent on the first load
   and appear on reload. The manual browser check should reload once before
   concluding the button is dead. The manual steps (the actual deliverable) work
   regardless.
4. Local dev: `npm run dev:db` / the Supabase stack is irrelevant here — `sw.js`
   is served by the Expo web dev server / Vercel, not by Supabase. No container
   restart of any kind is implied by this spec.

### 7 — Test plan by track

**pgTAP: none** (no DB surface). **Shell smokes: none** (no HTTP surface).
**jest only**, split across the two projects:

*node project (`src/lib/**/*.test.ts`)* — `src/lib/installGuide.test.ts` (new).
Mock `react-native` to `{ Platform: { OS: 'web' } }` and stub
`globalThis.navigator` / `globalThis.window`, following the established shape in
[src/screens/cmd/lib/sharePo.test.ts:22,59-70](../src/screens/cmd/lib/sharePo.test.ts)
(save + restore the ambient globals in `afterEach` so mutations don't leak).
Cover:
- AC-3: `installSteps('ios' | 'android' | 'desktop')` → 4 / 3 / 2 steps; `n`
  sequence `1..k`; every `key` unique and prefixed with its platform; every
  `glyph` non-empty. The `never` guard is a *compile-time* assertion — pin it
  with a `// @ts-expect-error` call on an invalid member rather than a runtime
  expect, and remember `npm run typecheck:test` is the gate that actually runs it.
- `detectInstallPlatform()` truth table: iPhone UA → `ios`; iPadOS-13 masquerade
  (`platform: 'MacIntel'`, `maxTouchPoints: 5`) → `ios`; `Android` UA → `android`;
  desktop Chrome UA → `desktop`; `Platform.OS !== 'web'` → `desktop`.
- `detectStandalone()` truth table (imported through `installGuide`, exercising
  the re-export): `navigator.standalone === true` → true; `matchMedia(
  '(display-mode: standalone)').matches` → true; neither → false; no `window` →
  false; `matchMedia` absent → false, no throw.
- AC-9 state machine, with `_resetInstallPrompt()` in `beforeEach`: no event →
  `isInstallPromptAvailable()` false and `promptInstall()` resolves
  `'unavailable'` without throwing; dispatched `beforeinstallprompt` →
  `preventDefault()` called, available true, subscribers notified;
  `promptInstall()` → deferred `prompt()` called **exactly once**, available flips
  false, a second `promptInstall()` resolves `'unavailable'` and does **not** call
  `prompt()` again; `appinstalled` → available false; `startInstallPromptCapture()`
  called twice registers one set of listeners and its teardown removes them.

*jsdom project* —
- `src/components/cmd/InstallGuideSheet.test.tsx` (new): AC-2 (sheet renders at
  `install-guide-sheet`), AC-4 (default tab from a stubbed platform; pressing
  another tab swaps the step list while the sheet root keeps its identity), AC-7
  (standalone → "already added", no tabs), AC-8 (`Platform.OS: 'ios'` → renders
  nothing, no throw), AC-9 (button absent with no captured event; present on
  android/desktop tabs once captured; **absent on the ios tab even when
  captured**; `promptInstall` called once per press).
- `src/screens/staff/screens/Settings.test.tsx` (extend): AC-1 (`staff-install-guide`
  present, and positioned between the text-size block and `staff-report-form`),
  AC-7, AC-REG2 — the existing spec-152 sign-out ordering pins
  (`markIntentionalSignOut` before `signOut()`, `clearIntentionalSignOut` on
  rejection) must stay green **unmodified**; the file's existing `jest.mock`
  header (lines 13-52) already stubs `lib/webPush` and `lib/supabase`, so the new
  card must not introduce a new unmocked boundary. If `installGuide.ts` needs
  mocking there, mock it — do not weaken the existing mocks.
- `src/lib/notificationState.test.ts`: **passes unmodified** (AC-REG1). If the
  diff touches this file, the extraction is wrong.
- Whole-shell coverage of AC-2 across all three breakpoints via
  `ResponsiveCmdShell` is expensive (it drags in the full store + navigation).
  Acceptable substitute: assert the sheet + entry in isolation and verify the
  three breakpoints by reading the three `return` branches at review time, plus
  the manual browser check at 1440×900 and 390×844. Call this out in the PR so
  the test-engineer reviewer can rule on it rather than discovering it.

Gates: full `npx jest` (not a subset), `npx tsc --noEmit`, **and**
`npm run typecheck:test` — the test-graph typecheck is a CI gate jest alone
misses (and it is what enforces AC-3's `never` guard).

### 8 — Risks and tradeoffs

1. **`beforeinstallprompt` is browser-policy, not API, surface.** Chrome gates it
   on heuristics that have changed repeatedly (engagement thresholds, the fetch
   handler requirement, related-applications). AC-9 is therefore *opportunistic
   by nature*: the button may never appear for a given user even with Q3 taken.
   The manual steps are the contract; the button is a bonus. Do not add
   engagement-forcing workarounds.
2. **Module-cycle risk** if §1's ruling is ignored — see §1. This is the single
   most likely way to break `probeNotificationState` at runtime while every test
   still passes (jest resolves cycles more forgivingly than Metro).
3. **Nested Modal on phone** — §3's `setMobileDrawerOpen(false)` ordering. Missing
   it produces an invisible or unpressable sheet on the exact surface (the phone
   drawer) that AC-2 targets.
4. **`sw.js` blast radius.** The no-op listener is safe; a `respondWith` is a
   Critical (§6). Reviewers should diff `sw.js` character by character.
5. **Footer width pressure.** `sidebarFooterLeft` already carries `● {name}` +
   sign out inside a `flex: 1, minWidth: 0` container
   ([Sidebar.tsx:240](../src/components/cmd/Sidebar.tsx)). A third chip with a
   long localized label ("instalar aplicación") can push the user name to a
   one-character ellipsis on a narrow sidebar. Keep `chrome.installGuide.chip`
   short in all three locales, give the chip `flexShrink: 0` and
   `numberOfLines={1}`, and eyeball the es/zh-CN desktop footer in the manual
   check.
6. **Seed-dataset / performance: not applicable.** The feature reads no rows;
   the 286 KB `supabase/seed.sql` is irrelevant to it. Likewise **edge-function
   cold start: not applicable** — no function is invoked. Recorded so the absence
   is deliberate rather than overlooked.
7. **Render-time `detectStandalone()`** in the shell means the entry's visibility
   is fixed for the life of the mount. Correct in practice (display mode cannot
   change without a reload) and cheaper than an effect + state; noted so it isn't
   mistaken for a missed subscription.
8. **Migration ordering: no ordering constraint exists** — this spec introduces
   no migration, so it can land before, after or interleaved with any DB spec
   without sequencing risk. There is also no manual-migration-verification step
   for this PR (CLAUDE.md's `db-migrations-applied.yml` gate has nothing to check
   here).
9. **Open questions left as-is.** Q2 (a "Show me how" link from the existing
   `chrome.notifications.iosInstall` hint) and Q5 (first-run nudge) stay at their
   defaults — **no**. Both are trivially additive later. Do not opportunistically
   implement either; AC-REG3 and the non-goals list treat them as out of scope.
   Q6/Q7 need no build action.

### 9 — Files changed (refined from the spec's list)

Additive only; nothing is deleted or renamed.

- `src/lib/installGuide.ts` (new) + `src/lib/installGuide.test.ts` (new)
- `src/lib/notificationState.ts` — extract + export `detectStandalone()`;
  `probeNotificationState` calls it. No other edit.
- `src/components/cmd/InstallGuideSheet.tsx` (new) + `.test.tsx` (new)
- `src/screens/cmd/ResponsiveCmdShell.tsx` — footer chip + rail glyph + one
  `useState` + the sheet mounted in all three return branches
- `src/screens/staff/components/InstallGuideCard.tsx` (new)
- `src/screens/staff/screens/Settings.tsx` — one inline card between Text size
  and Report an issue; `Settings.test.tsx` extended
- `App.tsx` — `startInstallPromptCapture()` in the existing web branch of the
  effect at line 410 (**added to the spec's list**; the capture needs an install
  point and this is it)
- `src/i18n/{en,es,zh-CN}.json` + `src/screens/staff/i18n/{en,es,zh-CN}.json`
- `public/manifest.json` (one token), `public/sw.js` (three lines)

Explicitly **not** in the diff: `supabase/migrations/*`, `supabase/functions/*`,
`supabase/config.toml`, `src/lib/db.ts`, `src/store/useStore.ts`,
`src/screens/staff/store/useStaffStore.ts`, `src/lib/cmdSelectors.ts`,
`src/lib/sidebarLayout.ts`, `vercel.json`, `app.json`.

---

## Implementation notes (frontend-developer, 2026-08-07)

Built to the design as written; the five binding rulings were all taken.

**Deviations / additions to flag for review:**

1. **One test file added beyond the plan.**
   `src/screens/cmd/__tests__/ResponsiveCmdShell.spec153.test.tsx` (new). §7 offered
   "read the three `return` branches at review time" as an acceptable substitute for
   whole-shell AC-2 coverage. It is now pinned by tests instead: all three breakpoint
   branches, the collapsed-rail twin, the single-node testID claim, the
   drawer-closes-before-sheet-opens ordering (§3's nested-Modal Critical), and the
   AC-7/AC-8 gates. The chrome children are mocked to pass-through renderers of the
   footer *slots*; the shell's own state and gates run for real. Additive — no
   existing suite changed.
2. **`_resetInstallPrompt()` also removes installed window listeners**, not just the
   captured event + subscribers as §2 described. Test-only and strictly wider; it is
   what keeps the node suite hermetic across `startInstallPromptCapture()` cases.
3. **`promptInstall()` maps a throwing `prompt()` to `'dismissed'`** (§2 specified
   `'unavailable'` only for the nothing-captured case and "never throws", leaving the
   mid-prompt failure unstated). A rejected prompt is a non-install, not a crash.
4. **Manual browser check NOT performed** — the implementing agent had no browser
   preview tooling available. Everything below is verified by automated gates only;
   the UA-dependent and `beforeinstallprompt`-dependent behavior still needs the
   §Verification manual pass (real iPhone Safari, real Android Chrome, desktop Chrome
   at 1440×900 + 390×844, including the es/zh-CN footer-width eyeball from §8.5).
   Per §6.3, reload once before concluding the one-tap button is dead.

**Q2 and Q5 remain unimplemented**, at their documented defaults.

**Gates:** `npx tsc --noEmit` clean · `npm run typecheck:test` clean (this is what
runs AC-3's `never` guard) · full `npx jest` 195 suites / 2033 tests green ·
`npx expo export --platform web` builds, and `dist/manifest.json` + `dist/sw.js`
carry the two changes verbatim. `src/lib/notificationState.test.ts` is untouched and
passes (AC-REG1). An AC-REG4 grep over the diff returns zero hits on
`supabase/**`, `src/lib/db.ts`, either store, `cmdSelectors.ts`, `sidebarLayout.ts`,
`vercel.json` and `app.json`.

## Files changed

- `specs/153-pwa-install-tutorial.md` (this file)
- `src/lib/installGuide.ts` (new)
- `src/lib/installGuide.test.ts` (new)
- `src/lib/notificationState.ts` — `detectStandalone()` extracted + exported; `probeNotificationState` calls it
- `src/components/cmd/InstallGuideSheet.tsx` (new)
- `src/components/cmd/InstallGuideSheet.test.tsx` (new)
- `src/screens/cmd/ResponsiveCmdShell.tsx` — footer chip + rail glyph twin + one `useState` + the sheet in all three return branches
- `src/screens/cmd/__tests__/ResponsiveCmdShell.spec153.test.tsx` (new — see deviation 1)
- `src/screens/staff/components/InstallGuideCard.tsx` (new)
- `src/screens/staff/screens/Settings.tsx` — one inline card between Text size and Report an issue
- `src/screens/staff/screens/Settings.test.tsx` — AC-1 / AC-7 / AC-REG2 ordering; spec-152 pins untouched
- `App.tsx` — `startInstallPromptCapture()` in the existing web branch
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
- `src/screens/staff/i18n/en.json`, `src/screens/staff/i18n/es.json`, `src/screens/staff/i18n/zh-CN.json`
- `public/manifest.json` — 512 icon `"purpose": "any maskable"` (one token)
- `public/sw.js` — no-op `fetch` listener, no `respondWith`, no `caches.*`

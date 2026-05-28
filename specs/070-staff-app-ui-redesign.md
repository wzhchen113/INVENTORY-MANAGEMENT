# Spec 070: Staff app UI/UX redesign — clean & modern + dark mode

Status: READY_FOR_REVIEW

## Problem statement

The staff EOD-count app (folded back into `imr-inventory` by spec 063, living at
`src/screens/staff/`) shipped intentionally minimal in v1 (specs 061/062): flat
white surfaces, one blue primary (`#1e88e5`), light mode only, no elevation, a
basic type/spacing scale. The user finds it "really basic" and wants it to feel
polished — "app-store modern."

This spec re-skins the existing staff surfaces in a **clean & modern, calm &
spacious** visual language and **adds a dark theme** (the staff app deliberately
shipped light-only; this adds the theming layer). It is a pure frontend/theme
change: no new screens, no interaction-flow rethink, no backend.

## User story

As a kitchen staff member, I want the EOD count screen and store picker to feel
polished and easy to read in varying light — including dim kitchens (dark mode)
— so that entering end-of-day counts on my phone is fast, comfortable, and
doesn't feel like a half-finished internal tool.

## Design goals

- **Clean & modern, calm & spacious:** generous whitespace, soft rounded cards,
  subtle shadows/elevation, a muted/refined palette, friendly and polished.
- **Dark mode:** a full dark theme that mirrors the light theme's token set.
- **Kitchen constraints preserved (non-negotiable):** tap targets ≥ 44pt,
  readable type, portrait phone first. "Calm & spacious" must not sacrifice
  glove-on usability — soft/muted is fine but contrast and target size stay.

## Acceptance criteria

- [ ] `src/screens/staff/theme.ts` is expanded from a single light palette into
      a **light + dark token set**. Both palettes define the full surface set
      (bg, bgAlt, surface, surfaceAlt), text set (text, textSecondary,
      textOnPrimary, textInverse), borders (border, borderStrong), brand/
      interactive (primary + pressed/disabled/translucent), and semantic
      (success/warning/error/info + their `*Bg` companions). No token that the
      existing light palette exposes is dropped (Banner's `TONE_STYLES`,
      QueueIndicator's `successBg`, Button's `primaryPressedLight`, etc. all
      still resolve in both themes).
- [ ] An **elevation/shadow token set** is added to the theme and is
      platform-correct: web emits CSS `boxShadow`, native emits
      `shadowColor`/`shadowOffset`/`shadowOpacity`/`shadowRadius` + `elevation`
      (same platform-branch shape as the admin `Shadow` token in
      `src/theme/colors.ts`). Shadow values are tuned per theme (dark mode does
      not reuse the light drop-shadow verbatim).
- [ ] A **theming mechanism** is wired so every staff screen and component
      consumes the active (light or dark) palette reactively. Default trigger is
      **system appearance** via React Native `useColorScheme()` — no settings UI
      (Open question Q1 → (a)). The chosen hook/provider shape is the
      architect's call (see Open questions for architect); it must re-render
      consumers when the OS appearance changes at runtime.
- [ ] All 6 staff components are restyled in the new language and render
      correctly in **both** themes: `Button`, `Input`, `ListRow`, `Banner`,
      `QueueIndicator`, `ErrorBoundary`.
- [ ] `StorePicker` is restyled in the new language, both themes — store rows
      read as soft cards (rounded, subtle elevation/separation) rather than flat
      hairline-divided list rows.
- [ ] `EODCount` is restyled in the new language, both themes — header, vendor
      switcher chips, item rows with number inputs, pre-fill/forbidden banners,
      footer (queue indicator + submit button) all consume the active palette.
- [ ] The `Splash` view inside `StaffStack.tsx` consumes the active palette
      (currently imports static `colors`) so the cold-start loader matches the
      theme.
- [ ] Tap targets stay ≥ 44pt everywhere they are today (Button, Input, ListRow
      min-heights, sign-out hit area, store-name pressable). The `touchTarget.min`
      token is retained and still applied.
- [ ] Body and label text meets **WCAG AA contrast (4.5:1)** against its
      background in both themes; large text (≥ 18pt bold / ≥ 24pt) meets 3:1.
      The architect's proposed palettes are chosen to satisfy this; the reviewer
      spot-checks the primary text/surface pairs.
- [ ] **Browser-verified screenshots** captured by the frontend-developer on a
      phone-tier viewport (portrait): `StorePicker` light, `StorePicker` dark,
      `EODCount` light, `EODCount` dark — 4 screenshots, attached to the build
      handoff. (Local stack: `npm run dev:db`, sign in as a `role='user'` staff
      account so RoleRouter mounts StaffStack.)
- [ ] **jest:** the existing staff test suite still passes unchanged. Any new
      theme-resolution logic (the light/dark selection hook) gets a unit test
      asserting it returns the dark palette when the scheme is `'dark'` and the
      light palette otherwise.
- [ ] **No behavioral regression:** EOD submit, offline-queue, vendor switching,
      pre-fill banner, sign-out, and store-switch all behave exactly as before.
      This is a visual change only — no data-fetch, store, or hook *logic* is
      modified beyond reading colors from a hook instead of a static import.

## In scope

- Expand `src/screens/staff/theme.ts` into light + dark token sets (colors,
  elevation/shadow), keeping `spacing`, `radius`, `typography`, `touchTarget`
  (refined as the architect proposes, but the existing token *keys* stay so the
  restyle is a re-skin, not a rename churn).
- A staff-local theming hook/mechanism (system-appearance driven) and the wiring
  to make screens + components consume it.
- Restyle all 6 staff components.
- Restyle `StorePicker` and `EODCount`.
- Restyle the `Splash` loader in `StaffStack.tsx`.
- Browser verification of light + dark on a phone viewport.

## Out of scope (explicitly)

- **Shared sign-in screen (`src/screens/LoginScreen.tsx`).** Post-spec-063,
  staff sign in via the admin login, then RoleRouter routes `role='user'` to
  StaffStack. Redesigning LoginScreen would change the admin login too. A
  staff-branded login is a separate, carefully-scoped decision — not this spec.
- **Interaction-flow rethink** (number steppers / +- buttons, a progress bar,
  a review-before-submit confirmation step). The user explicitly deferred this.
  Surfaced as a follow-up candidate below; do NOT build it here.
- **A dark-mode toggle / settings screen** for staff. Default is system-driven
  with zero UI (Q1 → (a)). A manual override is a small follow-up if wanted.
- **`profiles.dark_mode` persistence for staff.** That column drives the admin
  store's `darkMode`; the staff app following the OS does not read or write it.
  Not touched here.
- **The admin Cmd UI / `src/theme/`.** No changes to the admin palette, the
  admin `useColors()`/`useCmdColors()` hooks, or any admin screen. The admin
  theme is the *reference* for shape only; the staff theme stays its own
  proportional single-file system.
- **Any backend change** — no migrations, no RLS, no edge functions, no
  `src/lib/db.ts`, no realtime.
- **i18n copy changes.** No new strings (system-driven dark mode needs no toggle
  label). If a surface needs new copy it is out of scope and gets flagged.
- **react-native-toast-message theming.** Toasts are fired from EODCount via the
  shared Toast host; restyling the toast component itself is out of scope.

## Follow-up candidates (not this spec)

- Interaction rethink: per-item steppers, an entry-progress indicator, a
  review-before-submit summary screen.
- A staff-branded sign-in experience (requires a deliberate decision on whether
  to fork LoginScreen or theme it conditionally by role).
- A manual light/dark override toggle (needs a settings affordance / header
  control + AsyncStorage persistence).

## Open questions resolved

Direction was locked by the user before this spec; the six clarifying questions
each had an explicit recommended default in the brief and were taken as
"defaults" (auto mode, low-risk visual decisions, all reversible at review):

- Q: Visual language? → A: **Clean & modern, calm & spacious** — generous
  whitespace, soft rounded cards, subtle elevation, muted/refined palette.
  (Locked, not re-asked.)
- Q1: Dark-mode trigger? → A: **(a) Follow OS/system appearance** via
  `useColorScheme()`, no toggle UI. Simplest, no new settings surface, matches
  "calm." A manual toggle is a follow-up.
- Q2: Dark-mode persistence? → A: **N/A** under Q1(a) — system-driven needs no
  AsyncStorage persistence.
- Q3: Brand color? → A: **Refine the palette.** The architect proposes a
  cohesive muted palette + accent (may keep, shift, or replace the current
  `#1e88e5` blue). The user vetoes specific colors at review. If the user
  surfaces brand colors before/at review, use them.
- Q4: Component scope? → A: **All 6** staff components restyled.
- Q5: Visual verification? → A: **Yes** — screenshots of StorePicker + EODCount
  in both light and dark on a phone-tier viewport are an acceptance criterion.
- Q6: Reference assets? → A: **None provided** — the architect/designer proposes
  the clean-modern system from scratch; the user reacts at review.

## Dependencies

- `src/screens/staff/theme.ts` (the file being expanded).
- `src/screens/staff/screens/{StorePicker,EODCount}.tsx`.
- `src/screens/staff/components/{Button,Input,ListRow,Banner,QueueIndicator,ErrorBoundary}.tsx`.
- `src/screens/staff/navigation/StaffStack.tsx` (Splash loader).
- React Native `useColorScheme` from `react-native` — **new dependency for this
  repo**: `useColorScheme` is not currently used anywhere in the codebase. No
  new npm package (it ships with React Native); just first use of the API.
- Reference pattern (shape only, do not edit): `src/theme/colors.ts`
  (`LightColors`/`DarkColors`, `useColors()` reading `useStore.darkMode`, and the
  platform-branched `Shadow` token). The admin hook is store-driven; the staff
  hook is appearance-driven — same *shape*, different source.
- Test infra: jest track (spec 022). No pgTAP, no shell smoke needed.

## Project-specific notes

- **Cmd UI section / legacy:** Neither. This is the **staff** surface
  (`src/screens/staff/`), a peer to `src/screens/cmd/`. Not an admin Cmd section
  and not the deleted legacy admin surface.
- **Which app:** This repo, staff surface only. Not the admin Cmd UI; not the
  customer PWA (still a sibling app).
- **Per-store or admin-global:** N/A — pure presentation, no data scope. The
  EOD per-store data flow is untouched.
- **Realtime channels touched:** None. The staff stack does not use realtime
  (spec 062); unchanged.
- **Migrations needed:** No.
- **Edge functions touched:** None.
- **Web/native scope:** **Both.** Web ships to Vercel, native to EAS. The
  elevation tokens must be platform-correct (web `boxShadow` to avoid the
  react-native-web `shadow*` deprecation warning; native `shadow*` + `elevation`)
  — same gotcha the admin `Shadow` token already handles. `useColorScheme()`
  works on both web (matches `prefers-color-scheme`) and native.
- **`app.json` slug:** Not touched. (No build-identifier / push-cert work here.)
- **Tests:** jest track only — existing staff suite must stay green; new
  theme-selection logic gets one unit test.

## Open questions for architect (frontend-architecture / design-token mode)

These are design decisions delegated to the architect's design pass, not
unresolved user questions:

1. **Theming hook shape.** Propose the concrete mechanism. Likely a
   `useStaffColors()` hook mirroring the admin `useColors()` in *shape* but
   sourcing from `useColorScheme()` instead of a Zustand `darkMode` flag. Decide
   whether it returns just colors or the full token bundle (colors + elevation +
   spacing/radius/typography), and whether a thin `ThemeProvider`/context is
   warranted or the hook alone (called per-component) suffices given staff's
   small surface. Keep it proportional — do not port the admin's full machinery.
2. **StyleSheet vs dynamic styles.** All staff styles today are module-level
   `StyleSheet.create` referencing static `colors`. Theme reactivity needs
   either (a) styles computed inside the component from the hook, (b) a
   `makeStyles(colors)` factory memoized per palette, or (c) static structural
   styles + inline color overrides from the hook. Pick one pattern and apply it
   consistently across all 6 components + 2 screens so the frontend-developer
   implements one idiom, not three.
3. **Elevation/shadow token approach on RN.** Confirm the platform-branch shape
   (web `boxShadow` vs native `shadow*`+`elevation`) and define the elevation
   scale (how many steps — e.g. card vs raised) and the per-theme values (dark
   surfaces typically need lighter/larger or border-based separation rather than
   a literal black drop shadow).
4. **Navigation/`StaffStack` theming integration.** The stack sets
   `headerShown: false`, so there is no native header to theme — but the
   `<NavigationContainer>` lives in `RoleRouter` (shared with admin). Decide
   whether the staff dark background needs a NavigationContainer `theme` prop
   coordination or whether per-screen `SafeAreaView`/`View` backgrounds are
   sufficient (and confirm this does not regress the admin side that shares the
   container).
5. **Palette proposal.** Deliver concrete light + dark hex sets (the muted
   "clean-modern" palette + accent per Q3), the refined type scale, the radius/
   spacing adjustments for the "soft cards / spacious" feel, and a per-component
   restyle spec (what each of the 6 components + 2 screens looks like in the new
   language) so the frontend-developer implements a coherent system rather than
   improvising. State the WCAG AA contrast check for the primary text/surface
   pairs in both themes.

---

## Frontend design (design-token / frontend-architecture mode)

This is a pure-frontend, staff-only re-skin + theming layer. No backend: no
migrations, no RLS, no edge functions, no `src/lib/db.ts`, no realtime. The
design below is intentionally **proportional to the staff app's small surface**
(9 files import the theme) — a rich-enough token set + concrete per-component
specs, NOT a port of the admin's full machinery (no context provider, no
`useCmdColors`-style second palette, no chart/user-color tokens).

### 0. The single source of truth and the consumer map

All 9 staff files import from `src/screens/staff/theme.ts`:

- Screens: `StorePicker.tsx`, `EODCount.tsx`
- Components: `Button.tsx`, `Input.tsx`, `ListRow.tsx`, `Banner.tsx`,
  `QueueIndicator.tsx`, `ErrorBoundary.tsx`
- Nav: `StaffStack.tsx` (`Splash`)

Today every one imports the **static** `colors` object (plus `spacing`,
`radius`, `typography`, `touchTarget`). The redesign keeps `theme.ts` as the one
file, but `colors` becomes two palettes (`lightColors` / `darkColors`) selected
at runtime by a hook. `spacing`/`radius`/`typography`/`touchTarget` stay static
module exports (they don't vary by theme) — components keep importing those
directly. **Only color access moves to the hook.**

---

### 1. Theming hook — `useStaffColors()` (resolves Q1)

**Decision: a hook, no provider/context.** Given 9 consumers and a flat tree,
a context provider is over-engineering. Mirror the admin `useColors()` *shape*
(a zero-arg hook returning a palette object) but source the scheme from RN
`useColorScheme()` instead of `useStore.darkMode`.

```ts
// src/screens/staff/theme.ts
import { useColorScheme } from 'react-native';

export type StaffColors = typeof lightColors;   // both palettes share this shape

export function resolveStaffColors(
  scheme: 'light' | 'dark' | null | undefined,
): StaffColors {
  return scheme === 'dark' ? darkColors : lightColors;
}

export function useStaffColors(): StaffColors {
  const scheme = useColorScheme();        // 'light' | 'dark' | null
  return resolveStaffColors(scheme);
}
```

- **Return shape:** colors only (`StaffColors`). `spacing`/`radius`/`typography`/
  `touchTarget` are NOT bundled into the hook return — they are theme-invariant
  and stay as static imports. This keeps the hook return identical in shape to
  the admin `useColors()` (colors object) and avoids re-render churn on tokens
  that never change.
- **Light vs dark selection:** `resolveStaffColors()` is the pure, testable core
  — `'dark'` → `darkColors`, everything else (`'light'`, `null`, `undefined`) →
  `lightColors`. The `null`/`undefined` fallback to light is load-bearing: under
  jest (jest-expo) and on first web paint `useColorScheme()` can return `null`;
  defaulting to light keeps the existing screen tests rendering the light palette
  exactly as today (no test churn) and gives web a deterministic default.
- **Consumption:** components call `const c = useStaffColors()` at the top and
  read `c.surface`, `c.text`, etc. Re-render behavior: `useColorScheme()` is
  backed by RN's `Appearance` API and subscribes to OS appearance-change events;
  when the OS flips light↔dark at runtime, every component that called the hook
  re-renders with the new palette. This satisfies the "re-render consumers when
  the OS appearance changes at runtime" acceptance criterion without any manual
  subscription.
- **API availability:** `useColorScheme` ships in `react-native` 0.81 (Expo SDK
  54) and is exported from the top-level `react-native` module — no new npm
  dependency, no `Appearance` plumbing needed. This is the repo's first use of
  the API (confirmed: zero current call sites), but it is stable RN public API.
- **`Splash` in `StaffStack.tsx`** is a function component, so it calls
  `useStaffColors()` directly. `ErrorBoundary` is a **class** component and
  cannot call hooks — see §5 for the wrapper pattern.

**Unit test (acceptance criterion):** test `resolveStaffColors()` directly (pure
function, no renderer needed): `resolveStaffColors('dark') === darkColors`,
`resolveStaffColors('light') === lightColors`, and
`resolveStaffColors(null) === lightColors`. Place it at
`src/screens/staff/lib/theme.test.ts` (or co-locate as
`src/screens/staff/theme.test.ts` and add that path to the unit project's
`testMatch`). Note the **jest project routing constraint**: per `jest.config.js`,
`src/screens/staff/lib/**/*.test.ts` runs in the **unit (node)** project, while
`src/screens/**/*.test.tsx` runs in the **component (jsdom)** project. A pure
`*.test.ts` for `resolveStaffColors` belongs in the node project — put it under
`src/screens/staff/lib/` (already globbed, jest.config.js:85) to avoid touching
config. Do NOT test `useStaffColors()` via `renderHook` in the node project
(it would need the RN renderer); test the pure resolver instead, which is the
logic the criterion actually cares about.

---

### 2. Palettes — light + dark, clean-modern muted language (resolves Q3, Q5)

**Primary/accent decision:** keep blue (it reads as "calm/trustworthy" and the
user called the current blue "serviceable"), but **refine it** from the slightly
saturated material `#1e88e5` to a muted, desaturated slate-blue `#3B6FB5` in
light. This is the "refined, not loud" move the brief asks for. Dark mode lifts
it to a lighter, airier `#6EA0E0` so it reads on dark surfaces.

All token **keys from the current palette are preserved** (acceptance criterion):
`bg, bgAlt, surface, surfaceAlt, text, textSecondary, textOnPrimary,
textInverse, border, borderStrong, primary, primaryPressed, primaryPressedLight,
primaryDisabled, success, successBg, warning, warningBg, error, errorBg, info,
infoBg, overlay`. Two **additive** keys for the clean-modern feel:
`surfaceElevated` (the raised card layer, esp. for dark elevation-by-layering)
and `textTertiary` (for the de-emphasized unit/caption text). No key is dropped,
so `Banner.TONE_STYLES`, `QueueIndicator.successBg`, `Button.primaryPressedLight`
all still resolve in both themes.

#### Light palette (`lightColors`)

```
// Surfaces — soft off-white app bg, pure-white cards lifted off it
bg:              '#F7F8FA'   // app background (was #ffffff — now a calm off-white)
bgAlt:           '#EEF0F3'   // recessed / grouped background
surface:         '#FFFFFF'   // card / row / header / footer fill
surfaceAlt:      '#F2F4F7'   // pressed-row tint, input-pill fill
surfaceElevated: '#FFFFFF'   // raised card (same as surface in light; shadow does the lifting)

// Text
text:            '#1A1D21'   // primary text (near-black, slight cool)
textSecondary:   '#5A6068'   // subtitles, captions, labels
textTertiary:    '#868D96'   // de-emphasized (units, hints)
textOnPrimary:   '#FFFFFF'   // text/label on a primary fill
textInverse:     '#FFFFFF'   // text on dark/overlay surfaces

// Borders / dividers — subtle, hairline
border:          '#E4E7EC'   // default hairline (softer than current #d8dadf)
borderStrong:    '#CBD0D8'   // emphasized border / disabled outline

// Brand / interactive
primary:          '#3B6FB5'             // refined muted slate-blue
primaryPressed:   '#2F5C99'             // darker pressed fill
primaryPressedLight: 'rgba(59,111,181,0.10)'  // outline-button pressed tint
primaryDisabled:  '#A9C2E2'             // washed-out fill for disabled primary

// Semantic (calm, desaturated; tints are low-chroma)
success:  '#2E7D46'   successBg: '#E7F4EC'
warning:  '#B5710B'   warningBg: '#FBF0DC'
error:    '#C0392B'   errorBg:   '#FBEAE8'
info:     '#2D6CA8'   infoBg:    '#E7F0F8'

// Overlays
overlay:  'rgba(17,20,24,0.45)'
```

#### Dark palette (`darkColors`) — elevated greys, never pure black

```
// Surfaces — layered greys; "soft" comes from lighter surfaces, not shadow
bg:              '#16181C'   // app background (dark, not #000)
bgAlt:           '#101216'   // recessed background (darker than bg)
surface:         '#1F2228'   // card / row / header fill (lifted off bg)
surfaceAlt:      '#272B32'   // pressed-row tint, input-pill fill
surfaceElevated: '#272B32'   // raised card — one step lighter than surface (elevation by layering)

// Text
text:            '#E7E9EC'   // primary text (off-white, not #fff — softer)
textSecondary:   '#9BA1AB'   // subtitles, captions
textTertiary:    '#727884'   // de-emphasized
textOnPrimary:   '#16181C'   // dark text on the lighter dark-mode primary fill
textInverse:     '#16181C'   // dark text on light/inverse surfaces

// Borders / dividers — light-on-dark hairlines
border:          'rgba(255,255,255,0.10)'
borderStrong:    'rgba(255,255,255,0.18)'

// Brand / interactive — lighter, airier blue for dark surfaces
primary:          '#6EA0E0'
primaryPressed:   '#5A8ACB'
primaryPressedLight: 'rgba(110,160,224,0.16)'
primaryDisabled:  '#3A4A60'

// Semantic — brighter foregrounds, low-alpha tints (admin DarkColors pattern)
success:  '#5FBA6E'   successBg: 'rgba(95,186,110,0.16)'
warning:  '#E0A030'   warningBg: 'rgba(224,160,48,0.16)'
error:    '#E36A5C'   errorBg:   'rgba(227,106,92,0.16)'
info:     '#5AA8F0'   infoBg:    'rgba(90,168,240,0.16)'

// Overlays
overlay:  'rgba(0,0,0,0.60)'
```

> **Note on `textOnPrimary` flipping to dark in dark mode.** In light mode the
> primary fill `#3B6FB5` is dark enough for **white** label text. In dark mode
> the primary fill `#6EA0E0` is light, so the label text flips to **dark**
> (`#16181C`). This mirrors the admin `accentFg` flip (`#FFFFFF` light →
> `#0E1014` dark) in `src/theme/colors.ts`. Because both palettes expose
> `textOnPrimary` and `Button.tsx` reads `c.textOnPrimary`, this is automatic —
> no per-theme branching in the component.

#### WCAG AA contrast (hard acceptance criterion — math done)

Ratios computed with the WCAG 2.x relative-luminance formula
`(L1+0.05)/(L2+0.05)`. Body/label text must be ≥ 4.5:1; large text (≥ 18pt bold
/ ≥ 24pt) ≥ 3:1.

**Light:**

| Pair | Ratio | Threshold | Pass |
|---|---|---|---|
| `text #1A1D21` on `surface #FFFFFF` | 17.0:1 | 4.5 | ✓ |
| `text #1A1D21` on `bg #F7F8FA` | 15.7:1 | 4.5 | ✓ |
| `textSecondary #5A6068` on `surface #FFFFFF` | 6.3:1 | 4.5 | ✓ |
| `textSecondary #5A6068` on `bg #F7F8FA` | 5.8:1 | 4.5 | ✓ |
| `textTertiary #868D96` on `surface #FFFFFF` | 3.6:1 | 4.5 (3 if large) | body **fail** → see note |
| `textOnPrimary #FFFFFF` on `primary #3B6FB5` (button fill) | 5.1:1 | 4.5 | ✓ |
| `primary #3B6FB5` as text on `surface #FFFFFF` | 5.1:1 | 4.5 | ✓ |
| `primary #3B6FB5` as text on `bg #F7F8FA` | 4.7:1 | 4.5 | ✓ |
| `error #C0392B` on `surface #FFFFFF` (sign-out / banner fg) | 5.4:1 | 4.5 | ✓ |
| `success #2E7D46` on `successBg #E7F4EC` (QueueIndicator) | 4.6:1 | 4.5 | ✓ |

**Dark:**

| Pair | Ratio | Threshold | Pass |
|---|---|---|---|
| `text #E7E9EC` on `surface #1F2228` | 13.4:1 | 4.5 | ✓ |
| `text #E7E9EC` on `bg #16181C` | 14.6:1 | 4.5 | ✓ |
| `textSecondary #9BA1AB` on `surface #1F2228` | 6.2:1 | 4.5 | ✓ |
| `textTertiary #727884` on `surface #1F2228` | 3.5:1 | 4.5 (3 if large) | body **fail** → see note |
| `textOnPrimary #16181C` on `primary #6EA0E0` (button fill) | 6.6:1 | 4.5 | ✓ |
| `primary #6EA0E0` as text on `surface #1F2228` | 6.0:1 | 4.5 | ✓ |
| `error #E36A5C` on `surface #1F2228` | 5.0:1 | 4.5 | ✓ |
| `success #5FBA6E` on `surfaceAlt #272B32` (QueueIndicator on tint) | 5.6:1 | 4.5 | ✓ |

> **`textTertiary` usage constraint (carried into §5).** `textTertiary` is the
> only token that does NOT clear 4.5:1 for small body text in either theme
> (3.6:1 light, 3.5:1 dark — both clear the 3:1 large threshold). It is
> therefore allowed **only** for non-essential, decorative de-emphasis at large/
> bold sizes, never for body copy that must be read. The EODCount item **unit**
> label (`itemUnit`) currently uses `textSecondary` — keep it on `textSecondary`
> (which passes), do NOT downgrade it to `textTertiary`. If the developer wants a
> third text tier for a caption that must be legible, use `textSecondary`. This
> keeps the "body and label text meets 4.5:1" criterion intact. The reviewer
> spot-checks `text`/`surface` and `textSecondary`/`surface` in both themes.

The semantic-tint-on-dark pairs are the riskiest (low-alpha tints over a dark
surface composite differently than a flat hex). The dark `successBg`/`infoBg`/
etc. are alpha-16% over `surface #1F2228`; the **foreground** colors above were
chosen to clear 4.5:1 against the *composited* tint, not against pure surface.
This is the admin `DarkColors` approach (alpha tints + bright fg) and is already
shipping in the admin Cmd UI — see Risks §9.

---

### 3. Elevation / shadow scale (resolves Q3)

Reuse the **exact platform-branch pattern** from the admin `Shadow` token
(`src/theme/colors.ts:152`): on web emit CSS `boxShadow`; on native emit
`shadowColor`/`shadowOffset`/`shadowOpacity`/`shadowRadius` + `elevation`. This
avoids the react-native-web `shadow*`-prop deprecation warning. Do **not**
re-invent it or copy the admin `Shadow` import — define a staff-local
`elevation` export in `theme.ts` (the staff theme stays its own self-contained
file per the spec's "proportional single-file system" constraint).

**Three levels**, theme-aware. The function returns the right set for the active
palette — because dark shadows are near-invisible, **dark elevation is done by
surface layering + border, not by a black drop shadow.** Shape:

```ts
// theme.ts — returns the elevation set for the active scheme.
export function makeElevation(scheme: 'light' | 'dark' | null | undefined) {
  const dark = scheme === 'dark';
  if (Platform.OS === 'web') {
    return dark
      ? {
          card:   { boxShadow: '0 1px 2px rgba(0,0,0,0.40)' },
          raised: { boxShadow: '0 2px 8px rgba(0,0,0,0.50)' },
          modal:  { boxShadow: '0 8px 28px rgba(0,0,0,0.60)' },
        }
      : {
          card:   { boxShadow: '0 1px 3px rgba(17,24,39,0.06)' },
          raised: { boxShadow: '0 4px 12px rgba(17,24,39,0.10)' },
          modal:  { boxShadow: '0 12px 32px rgba(17,24,39,0.16)' },
        };
  }
  // native
  return dark
    ? {
        card:   { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.40, shadowRadius: 2,  elevation: 2 },
        raised: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.50, shadowRadius: 8,  elevation: 6 },
        modal:  { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.60, shadowRadius: 28, elevation: 16 },
      }
    : {
        card:   { shadowColor: '#111827', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3,  elevation: 1 },
        raised: { shadowColor: '#111827', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.10, shadowRadius: 12, elevation: 4 },
        modal:  { shadowColor: '#111827', shadowOffset: { width: 0, height: 12 },shadowOpacity: 0.16, shadowRadius: 32, elevation: 12 },
      };
}
```

- **`modal` is defined for completeness** but the staff app has no modal surface
  today (confirm dialogs route to `window.confirm`/`Alert` via
  `confirmAction`) — the developer uses `card` and `raised` only. Defining three
  keeps the scale coherent and matches the brief's "card / raised / modal"
  guidance; the unused key carries zero cost.
- **Dark mode pairs the (subtle) shadow WITH a `borderStrong` hairline** on
  cards so separation survives even where the shadow vanishes — the actual
  "lift" in dark mode comes from `surfaceElevated`/`surfaceAlt` being a step
  lighter than `bg`. See ListRow/StorePicker specs in §5.
- **Consumption:** because elevation is scheme-dependent, the cleanest route is
  to fold it into the hook return as a second value OR expose a sibling hook.
  **Decision:** keep `useStaffColors()` colors-only, add `useStaffElevation()`
  that calls `useColorScheme()` and returns `makeElevation(scheme)`. Two thin
  hooks read the same RN source; a component needing both calls both. (A single
  bundling hook is also acceptable — but two single-purpose hooks keep the
  colors hook shape-identical to admin `useColors()`, which the spec asked us to
  mirror.) `makeElevation` is exported standalone so it stays unit-testable like
  `resolveStaffColors`.

---

### 4. Spacing / radius / type — softer & more spacious (resolves Q5)

Keep every existing **key** (acceptance criterion: re-skin, not rename churn).
Adjust values for the "soft cards / spacious" feel:

**`radius` — larger for softer corners:**

```
sm:   8     (was 4)   — inputs, small pills
md:   12    (was 8)   — buttons, chips
lg:   16    (was 12)  — cards / rows / banners (the "soft card" radius)
xl:   20    (NEW, additive) — large hero cards if needed
pill: 999   (unchanged)
```

**`spacing` — keep the scale, it's already a clean 4-pt- based ramp.** No key
changes. The "spacious" feel comes from *applying* larger steps in the component
specs (e.g. card padding moves to `lg`/`xl`, inter-row gap to `md`), not from
re-numbering the tokens. Current ramp (`xxs:2, xs:4, sm:8, md:12, lg:16, xl:24,
xxl:32, xxxl:48`) holds.

**`typography` — one refinement, no key churn.** The size/weight keys stay. Add
two optional line-height helpers so multi-line copy (Banner, ErrorBoundary
message, item names) breathes:

```
// add to typography (additive, optional to consume):
lineHeightBody:  22   // for body (16) text blocks
lineHeightTitle: 30   // for title/headline blocks
```

Banner/ErrorBoundary already hardcode `lineHeight: 22` — replace those literals
with `typography.lineHeightBody` for consistency (optional, cosmetic).

**Tap targets unchanged:** `touchTarget.min = 44` stays and stays applied
everywhere it is today (Button `minHeight`, Input `minHeight`, ListRow
`min + 16`, sign-out `minHeight: 44`, store-name pressable). No reduction. The
larger radii do not shrink any hit area.

---

### 5. StyleSheet-vs-dynamic idiom (resolves Q2)

**Decision: static structural `StyleSheet.create` + inline color overrides from
the hook (option c).** Rationale:

- Structural styles (layout, padding, radius, min-height, flex) are
  theme-invariant — keep them in a module-level `StyleSheet.create` so RN can
  still register/optimize them and the diff stays small (the developer is mostly
  *removing* `color`/`backgroundColor`/`borderColor` lines from the existing
  StyleSheets, not rewriting structure).
- Color props move to inline arrays: `style={[styles.row, { backgroundColor:
  c.surface, borderColor: c.border }]}`. This is the **lowest-churn** path
  against the existing code (every component already uses array-style `style={[
  ... ]}` composition) and it's exactly how `Banner.tsx` already injects tone
  colors today (`{ backgroundColor: t.bg, borderLeftColor: t.border }`) — so the
  idiom is already in the codebase.
- **Rejected `makeStyles(colors)` factory:** it would force a `useMemo` per
  component and a larger rewrite (every style becomes dynamic) for a 9-file
  surface — disproportionate. The admin side doesn't use a factory either; it
  reads `useColors()` and applies inline. Match that.

**One idiom, applied to all 6 components + 2 screens + Splash:**
1. `const c = useStaffColors();` at the top of each function component.
2. Keep the existing `StyleSheet.create` block but strip the color properties out
   of it (leave layout/spacing/radius/size).
3. Apply colors inline via `style={[styles.x, { ...color props }]}`.
4. For `ActivityIndicator color=`, `placeholderTextColor=`, and other
   color-prop-not-style cases, read straight from `c` (e.g.
   `color={c.primary}`).

`ErrorBoundary` is a class → can't call the hook. **Pattern:** keep
`ErrorBoundary` as the class (its `getDerivedStateFromError`/`componentDidCatch`
logic is untouched per "no logic change"), and extract the fallback **UI** into a
small function component `ErrorFallback()` that calls `useStaffColors()` and is
rendered from `render()` when `hasError`. The class renders `<ErrorFallback />`;
the function component does the theming. Minimal, keeps the boundary logic
intact.

---

### 6. Per-component restyle spec (resolves Q5 — what each surface becomes)

Each entry: visual change, theme consumption, light/dark difference. The
frontend-developer implements from these — they should not need to invent.

**`Button.tsx`**
- Visual: bump `radius.md` (now 12) for a softer pill-ish CTA. Primary = filled
  `c.primary`, label `c.textOnPrimary`. Add `elevation.card` to the **primary**
  filled variant for a subtle lift (secondary/outline stays flat). Pressed:
  `c.primaryPressed` (primary) / `c.primaryPressedLight` (secondary). Disabled:
  `c.primaryDisabled` fill (primary) / `c.borderStrong` outline (secondary).
- Theme: `const c = useStaffColors()`; for the lifted primary also
  `const e = useStaffElevation()` and spread `e.card`. `ActivityIndicator
  color={isPrimary ? c.textOnPrimary : c.primary}`.
- Light/dark: identical structure; in dark the primary label is dark
  (`textOnPrimary` flips) and the lift is the dark shadow set + the fill itself
  reads as the "raised" element. Keep `minHeight: touchTarget.min`.

**`Input.tsx`**
- Visual: `radius.sm` (now 8). Fill `c.surfaceAlt` (a faint pill, the
  "calm/soft" input look) instead of pure `c.surface`; border `c.border`,
  focused/error border `c.error`. `placeholderTextColor={c.textTertiary}` (was
  `textSecondary` — placeholder is decorative so tertiary is allowed here, it's
  not read-critical body text). Text color `c.text`. Keep
  `minHeight: touchTarget.min` and the web `outlineWidth: 0`.
- Theme: hook at top; colors inline. Label text `c.textSecondary`, error text
  `c.error`.
- Light/dark: `surfaceAlt` is `#F2F4F7` light / `#272B32` dark — the input pill
  reads as a recessed field in both. Border alpha-hairline in dark.

**`ListRow.tsx` (the biggest visual shift — flat rows → soft cards)**
- Visual: wrap each row as a **soft card**: `radius.lg` (16), fill `c.surface`,
  `elevation.card`, padding `spacing.lg` horizontal / `spacing.md` vertical,
  `minHeight: touchTarget.min + 16` (60pt — unchanged). **Remove the
  `borderBottomWidth` hairline** — cards are separated by margin + shadow, not a
  divider. The screen supplies inter-card spacing (see StorePicker/EODCount).
  Pressed state: `backgroundColor: c.surfaceAlt`. In **dark**, also add a
  `borderWidth: 1, borderColor: c.borderStrong` so the card edge survives where
  the shadow is invisible (light mode: no border, shadow alone).
- Theme: `const c = useStaffColors(); const e = useStaffElevation();` spread
  `e.card`, inline `backgroundColor`/border, and a dark-only border via
  `scheme === 'dark'` — get scheme by reading it once
  (`const scheme = useColorScheme()`) OR expose it; simplest: ListRow calls
  `useColorScheme()` directly for the one boolean. (ListRow is the only component
  that needs the raw scheme boolean; everyone else needs only colors/elevation.)
- Light/dark: light = white card, soft grey shadow, no border. Dark =
  `surface #1F2228` card, faint shadow + `borderStrong` hairline, pressed lifts
  to `surfaceAlt #272B32`.

**`Banner.tsx`**
- Visual: `radius.lg` (16) to match cards; keep the 4pt left accent bar
  (`borderLeftWidth: 4`) as the tone signal. Background `tone.bg`, left-border
  `tone.border`, text `tone.fg`. Slightly more padding (`spacing.md` vertical).
  Replace hardcoded `lineHeight: 22` with `typography.lineHeightBody`.
- Theme: `TONE_STYLES` currently closes over the static `colors` at module load
  — it MUST move **inside** the component (or become a `makeToneStyles(c)`
  helper) so it reads the active palette. Build it from `c`:
  `{ info: { bg: c.infoBg, fg: c.info, border: c.info }, ... }`.
- Light/dark: tone tints flip (light flat tints → dark alpha tints). The fg
  colors were contrast-checked against both (§2).

**`QueueIndicator.tsx`**
- Visual: pill on `c.successBg`, dot/spinner `c.success`, label `c.success`,
  `radius.pill`. Largely unchanged structurally; just sources colors from hook.
  Consider `elevation.card` off (it sits inside the footer card already).
- Theme: hook at top; `ActivityIndicator color={c.success}`, dot
  `backgroundColor: c.success`, pill `backgroundColor: c.successBg`.
- Light/dark: `successBg` flips flat→alpha; `success` fg brightens in dark. The
  on-tint contrast pair is in §2 (5.6:1 dark).

**`ErrorBoundary.tsx`**
- Visual: fallback centered, `bg = c.bg`, title `c.text`, message
  `c.textSecondary`, `radius` n/a (full-screen). Same copy.
- Theme: extract `ErrorFallback()` function component (calls `useStaffColors()`),
  class `render()` returns `<ErrorFallback />` on error. Logic untouched.
- Light/dark: background + text follow palette; nothing tone-specific.

**`StorePicker.tsx`**
- Visual: header gets more breathing room (`paddingTop: spacing.xl`,
  `paddingBottom: spacing.lg`), title `typography.headline` bold `c.text`,
  subtitle `c.textSecondary`. The **list** background is `c.bg` (off-white
  light / dark bg); each store renders via the new **card** `ListRow` with
  inter-card spacing: set `ItemSeparatorComponent` or row `marginBottom:
  spacing.md` and list `paddingHorizontal: spacing.lg`,
  `paddingTop: spacing.sm`. Row leading text `c.text`,
  `typography.bodyLarge` semibold. Optionally add a trailing chevron (`›` Text
  in `c.textTertiary`) to signal tap-affordance — **optional**, copy-free, decor
  only.
- Theme: `const c = useStaffColors()`; container `backgroundColor: c.bg`, text
  colors inline. ListRow themes itself.
- Light/dark: off-white field with white cards (light) vs dark field with lifted
  grey cards (dark).

**`EODCount.tsx` (the dense screen — header, chips, item rows, banners, footer)**
- Container/SafeAreaView `backgroundColor: c.bg`.
- **Header:** `backgroundColor: c.surface`, bottom hairline `c.border`. Store
  name `c.primary` when switchable (large/bold → 3:1 large threshold, and it's
  5.1:1 anyway) / `c.text` when static. `todayLabel` `c.textSecondary`. Sign-out
  text `c.error`, pressed bg `c.surfaceAlt`. Keep both pressables ≥ 44pt.
- **Vendor switcher chips:** `radius.pill`, inactive chip = `c.surface` fill +
  `c.border` border + `c.text` label; active chip = `c.primary` fill +
  `c.primary` border + `c.textOnPrimary` label. Min-height 36 stays (chips are
  not primary tap targets, but bump to 40 if trivial — not required). Switcher
  strip `backgroundColor: c.surface`, bottom hairline `c.border`.
- **Item rows:** each is a card `ListRow` (per ListRow spec) with item name
  `c.text` `bodyLarge` semibold, unit `c.textSecondary` (NOT tertiary — keep
  legible), and the count `Input` right-aligned. The count input keeps
  `width: 96, textAlign: 'right'`; with the new Input pill fill it reads as a
  `surfaceAlt` field on the card. Inter-card spacing `spacing.sm`–`md`.
- **Loading/empty panes:** spinner `c.primary`; empty text `c.textSecondary`.
- **Banners:** themed via Banner (above) — forbidden=error tone, pre-fill=info
  tone.
- **Footer:** `backgroundColor: c.surface`, top hairline `c.border`. Houses
  QueueIndicator + the primary Button. Consider `elevation.raised` on the footer
  (web boxShadow upward) for a "docked bar" lift — **optional**; if it looks
  heavy, drop to a plain top-border. QueueIndicator + Button theme themselves.
- Theme: `const c = useStaffColors()` once at top; all the inline colors above.
  No data/effect/store logic changes — only the static `colors.*` references in
  the StyleSheet + the `color=` props become `c.*`.
- Light/dark: header/footer/chips/cards all follow palette; dark gives the
  layered-grey "calm dim-kitchen" look the brief wants.

**`Splash` (in `StaffStack.tsx`)**
- Visual: `bg = c.bg`, title `c.text`, spinner `c.primary`. Calls
  `useStaffColors()` directly (function component).

---

### 7. Navigation theming — shared NavigationContainer (resolves Q4)

**Confirmed approach: per-screen/per-`SafeAreaView` background, NO container
`theme` prop.** The `<NavigationContainer>` lives in `RoleRouter`
(`src/navigation/RoleRouter.tsx:61`) and is **shared with the admin stack**.
Setting a `theme={DarkTheme}` on that container would bleed into `AdminStack` and
regress the admin Cmd UI (which is store-`darkMode`-driven, not OS-driven) — a
**hard no**.

Instead:
- The staff stack already sets `headerShown: false` on every `Stack.Screen`
  (StaffStack.tsx:74/81/88), so there is **no native header to theme** — the
  header-bleed vector doesn't exist.
- The themed background comes from each staff **screen's own root**: `EODCount`'s
  `SafeAreaView` and `StorePicker`'s/`Splash`'s root `View` set
  `backgroundColor: c.bg`. That fully covers the viewport for the staff branch.
- **The one gap to close:** React Navigation's default `CardStyle`/scene
  background is white (`DefaultTheme`), which can flash behind a screen during
  transitions — visible as a white flash in dark mode. Fix **locally** on the
  StaffStack `Stack.Navigator` via
  `screenOptions={{ headerShown: false, cardStyle: { backgroundColor: c.bg } }}`
  (read `c` inside `StaffStack` via `useStaffColors()`). This scopes the scene
  background to the staff navigator **only** — it does not touch the shared
  container or the admin navigator. `StaffStack` is already a function component
  reading the store, so adding the hook is trivial.
- **Admin regression check (verification, §8):** after wiring, confirm the admin
  Cmd UI still renders with its own palette (sign in as admin) — the staff
  `cardStyle` must not be reachable from `AdminStack`. Since `cardStyle` is set
  on the *staff* `Stack.Navigator`, not the container, this is structurally
  guaranteed; the check is belt-and-suspenders.

---

### 8. Verification plan (resolves Q5 acceptance criterion)

The frontend-developer MUST browser-verify **both themes** before handoff:

1. Local stack `npm run dev:db`; sign in as a `role='user'` staff account so
   RoleRouter mounts StaffStack (per the spec's acceptance note — admin login,
   staff role routes to StaffStack).
2. Use the preview/browser tooling at a **phone-tier portrait viewport**
   (e.g. 390×844). Per MEMORY "verify UI with preview tools" — exercise in
   browser, not just typecheck.
3. **Light theme:** screenshot `StorePicker` and `EODCount`.
4. **Dark theme:** emulate `prefers-color-scheme: dark` (Chrome DevTools →
   Rendering → "Emulate CSS prefers-color-scheme: dark", or the browser-tool
   equivalent) and confirm `useColorScheme()` flips the palette **live**
   (re-render, no reload needed — validates the runtime-appearance criterion).
   Screenshot `StorePicker` dark and `EODCount` dark.
5. Attach the **4 screenshots** (StorePicker light/dark, EODCount light/dark) to
   the build handoff (acceptance criterion).
6. **Admin non-regression:** sign in as admin, confirm the Cmd UI palette is
   unchanged (the shared NavigationContainer + per-screen `cardStyle` did not
   bleed). One screenshot or a visual confirmation note suffices.
7. **jest:** run the staff suite — `StorePicker.test.tsx` / `EODCount.test.tsx`
   must stay green unchanged (they render the light palette because
   `useColorScheme()` returns `null`/`'light'` under jest-expo → `resolveStaffColors`
   falls to light). Add the `resolveStaffColors` unit test (§1).

---

### 9. Risks & tradeoffs

- **Shared NavigationContainer regression (highest-attention).** The container
  is owned by `RoleRouter` and shared admin↔staff. The mitigation (scene
  `cardStyle` on the *staff* navigator only, never a container `theme` prop) is
  structurally safe, but the developer must NOT reach for the convenient
  `NavigationContainer theme={...}` shortcut. Admin non-regression is an explicit
  verification step (§8.6). **If the developer finds any need to touch
  `RoleRouter` or the container, stop and surface it** — it's out of scope and
  high-blast-radius.
- **`useColorScheme()` on the Vercel static web export (SSR/first-paint).** Expo
  web `expo export` produces a static client bundle (no server render), so there
  is no SSR hydration mismatch in the classic Next.js sense. But on the **very
  first synchronous render** `useColorScheme()` can briefly return `null` before
  `Appearance` resolves the media query — our `resolveStaffColors(null) → light`
  default means a dark-OS web user could see a one-frame light flash before it
  settles to dark. Acceptable for v1 (it's a single frame and self-corrects);
  noted so the reviewer doesn't flag it as a bug. If it's visually jarring in
  testing, a follow-up could read `prefers-color-scheme` synchronously via
  `window.matchMedia` on web — out of scope here.
- **Semantic-tint contrast in dark mode.** The dark `*Bg` tints are low-alpha
  over `surface`, which composite differently than flat hex; the fg colors were
  chosen against the composite (§2) and this is the already-shipping admin
  `DarkColors` approach. Residual risk: if a banner/pill is placed over `bg`
  rather than `surface`, the composite shifts slightly. Verification (§8) should
  eyeball banners in dark on the actual screen background (EODCount renders them
  over `c.bg`/`c.surface`).
- **`textTertiary` misuse.** It fails 4.5:1 for small body text (passes 3:1
  large). The §2 constraint restricts it to decorative/large use only; a reviewer
  spot-check on any body copy using `textTertiary` is warranted. Conservative
  fallback: don't introduce `textTertiary` at all and use `textSecondary`
  everywhere — costs nothing visually and removes the risk. (Kept as an additive
  token for the placeholder/chevron decor only.)
- **Test suite drift.** The two screen tests render real components that now call
  `useColorScheme()`. Under jest-expo this returns `null`/`'light'` (no throw),
  so they render the light palette and assertions (text content, testIDs) are
  unaffected — they're content/behavior assertions, not snapshot/style. Confirmed
  by reading both test files: no style or color assertions exist. Low risk, but
  the developer must run the suite (§8.7) — if jest-expo's `useColorScheme` mock
  ever throws, mock it in `tests/jest.setup.ts` (global) returning `'light'`.
- **`elevation.raised` on the footer / shadow heaviness.** Optional lifts
  (footer `raised`, button `card`) can look heavy if over-applied, especially on
  web where boxShadow renders crisply. Treated as "optional, tune at
  verification" — the developer drops to a plain border if a lift looks wrong.
  Not a correctness risk.
- **Proportionality.** Two thin hooks (`useStaffColors`, `useStaffElevation`) +
  pure resolvers (`resolveStaffColors`, `makeElevation`) is the deliberate
  ceiling. No context provider, no theme bundle object, no admin-style second
  palette family. If a future spec adds a manual toggle (a follow-up candidate),
  it slots in by swapping the `useColorScheme()` source inside the two hooks for
  a store/AsyncStorage-backed value — the component-level idiom (§5) does not
  change. Designed to extend, not to over-build now.

### 10. Summary of files the developer will touch (all frontend, staff-only)

- `src/screens/staff/theme.ts` — expand: `lightColors`/`darkColors`,
  `resolveStaffColors`, `useStaffColors`, `makeElevation`, `useStaffElevation`,
  refined `radius`/`typography`; keep `spacing`/`touchTarget`. Additive keys
  `surfaceElevated`, `textTertiary`, `radius.xl`, `typography.lineHeight*`.
- `src/screens/staff/components/{Button,Input,ListRow,Banner,QueueIndicator,ErrorBoundary}.tsx`
  — hook + inline colors per §6. (ErrorBoundary: extract `ErrorFallback`.)
- `src/screens/staff/screens/{StorePicker,EODCount}.tsx` — hook + inline colors.
- `src/screens/staff/navigation/StaffStack.tsx` — `Splash` themed +
  staff-navigator `cardStyle: { backgroundColor: c.bg }`.
- `src/screens/staff/lib/theme.test.ts` (new) — `resolveStaffColors` unit test.

**Untouched (out of scope, confirmed):** `src/theme/*`, admin `useColors`/
`useCmdColors`, `src/navigation/RoleRouter.tsx` (the container), any admin
screen, `LoginScreen.tsx`, `app.json`, all backend.

## Handoff
next_agent: frontend-developer
prompt: Implement Spec 070 against the Frontend design section. This is a
  staff-only re-skin + theming layer — no backend. Build the light+dark token
  set, `useStaffColors()`/`useStaffElevation()` hooks (colors-only return,
  sourcing `useColorScheme()`), the platform-branched `makeElevation` scale, and
  restyle all 6 components + StorePicker + EODCount + the Splash loader per the
  per-component specs in §6. Use the static-StyleSheet + inline-color-override
  idiom (§5) consistently. Theme the staff navigator's scene background via
  `cardStyle` on the StaffStack `Stack.Navigator` ONLY — do NOT touch the shared
  NavigationContainer in RoleRouter (admin regression risk, §7/§9). Add the
  `resolveStaffColors` unit test under `src/screens/staff/lib/`. Browser-verify
  BOTH themes on a phone-tier portrait viewport (emulate prefers-color-scheme:
  dark for the dark pass) and attach 4 screenshots (StorePicker + EODCount, light
  + dark) plus an admin non-regression confirmation. Keep the staff jest suite
  green. After implementation, set Status: READY_FOR_REVIEW and list files
  changed under ## Files changed.
payload_paths:
  - specs/070-staff-app-ui-redesign.md

---

## Files changed

Implemented exactly per the Frontend design section (§1–§10). Staff-only,
pure-frontend re-skin + theming. No backend, no shared LoginScreen, no
`src/theme/*`, no `RoleRouter` touch.

- `src/screens/staff/theme.ts` — expanded the single light palette into
  `lightColors` + `darkColors` (full surface/text/border/brand/semantic sets;
  additive `surfaceElevated` + `textTertiary`; refined primary `#3B6FB5` light /
  `#6EA0E0` dark with `textOnPrimary` flipping per theme; dark = layered greys,
  never pure black). Added `resolveStaffColors` (pure resolver; `null`/`undefined`
  → light), `useStaffColors()` (colors-only hook sourcing `useColorScheme()`),
  `makeElevation(scheme)` (3-level platform-branched web `boxShadow` / native
  `shadow*`+`elevation`; dark elevation via surface-layering + border), and
  `useStaffElevation()`. Refined `radius` (`lg: 12→16`, additive `xl: 20`) and
  `typography` (additive `lineHeightBody`/`lineHeightTitle`); `spacing` and
  `touchTarget.min = 44` unchanged. `lightColors` is no longer `as const` so
  `darkColors: typeof lightColors` widens to `string` (matches the admin
  `LightColors`/`DarkColors` shape).
- `src/screens/staff/components/Button.tsx` — `useStaffColors()` +
  `useStaffElevation()`; primary filled variant lifted with `e.card`; `radius.md`
  (now 12); all fill/border/label colors inline; `textOnPrimary` flip automatic.
- `src/screens/staff/components/Input.tsx` — `useStaffColors()`; `surfaceAlt`
  pill fill, `radius.sm` (now 8), `border`/`error` border inline,
  `placeholderTextColor={c.textTertiary}`.
- `src/screens/staff/components/ListRow.tsx` — flat rows → soft cards: `radius.lg`,
  `surface` fill, `e.card` elevation, removed the `borderBottomWidth` divider;
  dark-only `borderStrong` hairline (reads the raw `useColorScheme()` boolean for
  the one dark branch). Pressed → `surfaceAlt`.
- `src/screens/staff/components/Banner.tsx` — `radius.lg`; moved `TONE_STYLES`
  inside the component as `makeToneStyles(c)` so it reads the active palette
  (it previously closed over the static `colors` at module load); `lineHeightBody`.
- `src/screens/staff/components/QueueIndicator.tsx` — `useStaffColors()`; pill
  `successBg`, dot/spinner/label `success`, inline.
- `src/screens/staff/components/ErrorBoundary.tsx` — class logic untouched;
  extracted `ErrorFallback()` function component that calls `useStaffColors()`;
  `render()` returns `<ErrorFallback />` on error. `lineHeightBody`.
- `src/screens/staff/screens/StorePicker.tsx` — `useStaffColors()`; off-white/
  dark `bg` field, card rows via restyled ListRow with `ItemSeparatorComponent`
  inter-card spacing, trailing `›` chevron (`textTertiary`, decorative).
- `src/screens/staff/screens/EODCount.tsx` — `useStaffColors()` once at top; all
  static `colors.*` references and `color=` props moved to inline `c.*` (header
  card, switchable store name in `primary`, sign-out in `error`, vendor chips
  active/inactive, item-row cards with `bodyLarge` name + `textSecondary` unit,
  count `Input` pill, loading/empty panes, footer card). No data/effect/store
  logic changed. `unit` stays on `textSecondary` (passes 4.5:1), not downgraded
  to `textTertiary` per §2.
- `src/screens/staff/navigation/StaffStack.tsx` — `Splash` calls `useStaffColors()`;
  added `cardStyle: { backgroundColor: c.bg }` to the staff `Stack.Navigator`'s
  `screenOptions` ONLY (scene-background scoping per §7 — the shared
  `NavigationContainer` in `RoleRouter` is NOT touched, so no admin bleed).
- `src/screens/staff/lib/theme.test.ts` (new) — unit test for the pure
  `resolveStaffColors` resolver: `'dark'`→dark, `'light'`→light, `null`/`undefined`
  →light, plus a both-palettes-share-identical-key-set assertion. Lands in the
  unit (node) project via the existing `src/screens/staff/lib/**/*.test.ts` glob
  (no jest.config.js change).

### Verification performed

- `npm test` — **339 pass / 36 suites** (334 baseline + 5 new from `theme.test.ts`);
  the staff suite (`StorePicker.test.tsx`, `EODCount.test.tsx`, et al.) stays green
  unchanged — under jest-expo `useColorScheme()` returns `null` → light palette, and
  the screen tests assert on text/testIDs, not colors.
- `npm run typecheck` and `npm run typecheck:test` — both clean.
- **Browser-verified BOTH themes** at a 390×844 phone-tier portrait viewport via
  headless Google Chrome over CDP (the `preview_*` tooling was not available in
  this session; drove the installed Chrome instead — no new dependency, used the
  existing transitive `ws`). Signed in as `manager@local.test` (`role='user'` →
  StaffStack). Captured 4 staff screenshots — StorePicker light/dark, EODCount
  light/dark — plus an admin non-regression shot (`admin@local.test` → Cmd UI
  Inventory, palette visually unchanged, confirming the staff `cardStyle` did not
  bleed through the shared container). Screenshots at `/tmp/070-storepicker-{light,
  dark}.png`, `/tmp/070-eodcount-{light,dark}.png`, `/tmp/070-admin-inventory.png`.
  Confirmed: soft rounded cards, generous spacing, muted slate-blue primary; dark
  mode reads as layered greys (not pure black) with `borderStrong` card hairlines
  and readable off-white text.

> **Note (local seed):** EODCount's item rows require ≥1 `order_schedule` row for
> today; the local DB's `order_schedule` table was empty, so two Thursday vendor
> rows (US FOOD, SYSCO) were temporarily inserted for the Frederick store to render
> the item-card + vendor-chip layout, then **deleted** after capture (local dev DB
> returned to its prior state — no migration, no prod, no committed seed change).

### Design-critique pass

Optional per the build prompt — not run. The 5 screenshots are attached for the
user/reviewer to react to the visual language directly (Q3/Q6 explicitly defer
the final palette call to the user at review).

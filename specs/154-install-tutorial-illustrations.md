# Spec 154: Phone-frame illustrations for the Add-to-Home-Screen tutorial

Status: READY_FOR_REVIEW

> Owner request (verbatim intent): *"the steps should show pictures of the phone
> — what the screen looks like at each step — instead of just symbol glyphs."*
>
> Follow-up to spec 153 (commit `63191f5`), which shipped the tutorial with a
> numbered marker + a mono glyph tile + localized prose per step. The prose is
> correct but abstract: "Tap the Share button in the toolbar" still requires the
> reader to find the toolbar. This spec adds a **drawn** picture of the phone at
> each step, with the relevant control highlighted. Frontend-only, additive.

## Scope

Small and visual. No backend surface of any kind (spec 153's AC-REG4 continues
to hold verbatim: no migration, no RPC, no edge function, no `src/lib/db.ts`, no
store slice, no realtime, no network request).

**Not bitmap screenshots.** Spec 153 §"Screenshots: rejected" and its Q7 stand:
real OS screenshots cannot be localized, cannot follow the two theme palettes,
go stale every OS release, and add ~18 binary assets. This spec ships **vector
illustrations drawn from theme tokens** — the same information, zero assets,
fully i18n- and theme-correct. AC-6 of spec 153 (zero new image assets) survives
unchanged.

**Stylized, not a UI clone.** The illustrations suggest the shape of the OS
chrome (a rounded phone body, a toolbar, a share sheet, a dropdown, a dialog)
using this app's own palette. They are not pixel reproductions of Safari or
Chrome, carry no vendor logo, wordmark or brand color, and use only
`useCmdColors()` / `useStaffColors()` tokens. The only literal text inside an
illustration is the OS's real menu label, which stays translatable.

## Design

Four parts.

### 1 — Model: one illustration key per step (`src/lib/installGuide.ts`)

`InstallStep` gains a third field alongside `n` / `glyph` / `key`:

```ts
export type InstallArt =
  | 'ios-safari' | 'ios-share' | 'ios-share-sheet' | 'ios-add-confirm'
  | 'android-toolbar' | 'android-menu' | 'android-confirm'
  | 'desktop-omnibox' | 'desktop-confirm';

export interface InstallStep { n: number; glyph: string; key: string; art: InstallArt }
```

Mapping (one art per step; every art used exactly once):

| step | art | what it draws |
|---|---|---|
| `ios.step1` | `ios-safari` | phone in Safari — bottom address pill (carrying the app name) highlighted |
| `ios.step2` | `ios-share` | same phone, the **Share** control in the bottom toolbar ringed |
| `ios.step3` | `ios-share-sheet` | share sheet raised, the **"Add to Home Screen"** row highlighted |
| `ios.step4` | `ios-add-confirm` | the Add dialog: app icon + name + the **Add** button highlighted |
| `android.step1` | `android-toolbar` | phone in Chrome — the **⋮** at top right ringed |
| `android.step2` | `android-menu` | the dropdown open, the **"Install app"** row highlighted |
| `android.step3` | `android-confirm` | the install dialog: icon + name + **Install** highlighted |
| `desktop.step1` | `desktop-omnibox` | browser window — the **install** icon at the right of the address bar ringed |
| `desktop.step2` | `desktop-confirm` | the install dialog anchored under it, **Install** highlighted |

`installSteps()` stays pure and total; the `never` guard is untouched. The
existing `glyph` field stays (spec 153 pins it in three suites, and the glyph
tile remains a compact "which control" marker in the step row — see §3).

### 2 — `src/components/illustrations/StepIllustration.tsx` (new)

One surface-neutral component. `react-native-svg@15.12.1` **is** a direct
dependency ([package.json:62](../package.json)) and already ships on
react-native-web via `Sparkline` / `StockHistoryChart`, so the shapes are real
vectors.

```tsx
export interface StepIllustrationPalette {
  frame; screen; chrome; line; border; ink; ink2; highlight; highlightBg; highlightInk;
}
export interface StepIllustrationLabels {
  appName; addToHomeScreen; add; installApp; install;   // all strings
}
export function StepIllustration(props: {
  art: InstallArt;
  width: number;
  palette: StepIllustrationPalette;
  labels: StepIllustrationLabels;
  testID?: string;
}): JSX.Element
```

Binding shape notes:

1. **Colors arrive as a `palette` prop, never from a hook.** The component must
   render in both surfaces, and the two theme hooks are incompatible:
   `useCmdColors()` reads `useStore`, which the staff subtree may never import
   (spec 063 slice isolation). Each surface maps its own tokens into the ten
   semantic slots. No inline hex anywhere — the component holds no color
   literal at all.
2. **Labels arrive as a `labels` prop, never from a catalog.** Same reason: two
   independent catalog trees (spec 063). Each surface resolves
   `chrome.installGuide.art.*` through its own `t`.
3. **Hybrid SVG + RN `Text`.** Shapes are `react-native-svg` primitives; the
   five translatable labels are absolutely-positioned RN `Text` in an overlay
   layer over the `Svg`. Rationale: `react-native-svg`'s `<Text>` does not wrap
   or ellipsize and resolves fonts differently on web vs native, and the
   Spanish/Chinese label expansions must clip gracefully
   (`numberOfLines={1}`, `ellipsizeMode="tail"`). Both layers derive from the
   same `scale = width / baseW`, so the overlay cannot drift from the drawing.
   The labels use the **system font on both surfaces** (no mono even on the Cmd
   side): they depict OS chrome, which is proportional, and the mono face is
   wide enough that "Add to Home Screen" ellipsizes inside the drawn row.
4. **Scales to the caller's width.** Every coordinate is authored in a per-art
   base viewBox (phone `124 × 176`, desktop window `176 × 112`) and multiplied
   by one `scale`. Height follows the aspect ratio. No `onLayout`, so the first
   render is already correct (and jest sees the labels).
5. **Complete by construction.** The art registry is typed
   `Record<InstallArt, ArtSpec>` — a new `InstallArt` member fails compilation
   until it is drawn.
6. Decorative: `accessibilityElementsHidden` / `importantForAccessibility="no"`
   / `accessibilityRole="image"` with no label. The step prose is the accessible
   content; the picture must not double-read it.

### 3 — Both surfaces render the same component

- **Admin** — [src/components/cmd/InstallGuideSheet.tsx](../src/components/cmd/InstallGuideSheet.tsx):
  the step card becomes `[marker] [glyph tile] [text]` **plus** the illustration
  centered beneath it, `testID="install-guide-art-<step.key>"`. Palette from
  `useCmdColors()`, labels from `useT()`, width
  `clamp(140, 280, windowWidth − 96)`.
- **Staff** — [src/screens/staff/components/InstallGuideCard.tsx](../src/screens/staff/components/InstallGuideCard.tsx):
  identical addition, `testID="staff-install-guide-art-<step.key>"`. Palette from
  `useStaffColors()`, labels from the staff catalog, width
  `clamp(120, 200, windowWidth − 64)` — smaller than the admin sheet because the
  staff scale is the half-density one (spec 070 / the 2026-07 density pass).
- The glyph tile is **retained** in both: it is pinned by spec-153 tests and
  reads as the compact control marker in the text row. Only the card *layout*
  changes (a row becomes a row + a picture) — AC-REG1.

### 4 — i18n: five new keys per catalog

Under the existing `chrome.installGuide` subtree, in **all six** files
(`src/i18n/{en,es,zh-CN}.json` and `src/screens/staff/i18n/{en,es,zh-CN}.json`):

```
chrome.installGuide.art.appName          "I.M.R"   (manifest short_name; verbatim in es/zh-CN)
chrome.installGuide.art.addToHomeScreen  "Add to Home Screen"
chrome.installGuide.art.add              "Add"
chrome.installGuide.art.installApp       "Install app"
chrome.installGuide.art.install          "Install"
```

These are the OS's real button/row labels, so they reuse the wording already in
the spec-153 step strings of each locale. The two existing i18n parity suites
fail the build on any missing key.

## Acceptance criteria

- [x] **AC-1** Every `InstallStep` carries an `art` key; the nine `InstallArt`
      members are each used exactly once across `ios` + `android` + `desktop`,
      and `installSteps()` stays pure/total with its `never` guard intact.
- [x] **AC-2** `StepIllustration` renders all nine arts without throwing, at any
      `width`, and its registry is `Record<InstallArt, ArtSpec>` so a new member
      fails `npx tsc --noEmit`.
- [x] **AC-3** The admin sheet renders one illustration per step
      (`install-guide-art-<key>`), switching tabs swaps the illustration set,
      and the "already added" state renders none.
- [x] **AC-4** The staff card renders one illustration per step
      (`staff-install-guide-art-<key>`) for the detected platform only, and none
      in the "already added" state.
- [x] **AC-5** No color literal in `StepIllustration.tsx`; every color arrives
      through the `palette` prop, mapped from `useCmdColors()` (admin) and
      `useStaffColors()` (staff) — correct in light **and** dark.
- [x] **AC-6** Every string drawn inside an illustration comes from
      `chrome.installGuide.art.*` via the surface's own catalog; the five keys
      exist in all six catalog files.
- [x] **AC-7** Zero new image assets — no addition under `assets/` or
      `public/*.png`; the illustrations are vector + tokens only.
- [x] **AC-8** Illustrations are decorative to a screen reader (hidden /
      unlabeled); the step prose remains the accessible content.

### Regression group (AC-REG)

- [x] **AC-REG1** Spec-153 behavior is unchanged except that the step card gains
      an illustration: the tabs, the default-tab probe, the install-button gates,
      the "already added" states, the glyph tile and every step string all behave
      as before. `src/lib/installGuide.test.ts`,
      `src/components/cmd/InstallGuideSheet.test.tsx`,
      `src/screens/cmd/__tests__/ResponsiveCmdShell.spec153.test.tsx` and
      `src/screens/staff/screens/Settings.test.tsx` keep every existing assertion
      (they gain new ones; none is deleted or weakened).
- [x] **AC-REG2** Both catalog trees stay at parity for the new keys (all three
      locales in each tree), enforced by the two existing parity suites.
- [x] **AC-REG3** No backend surface moves (spec 153 AC-REG4, restated): no
      `supabase/**`, no `src/lib/db.ts`, no store, no `vercel.json`, no
      `app.json` — slug included.

## Non-goals

- Bitmap/real screenshots (spec 153 Q7 — still rejected).
- Animation, video, or an interactive walkthrough.
- Vendor-accurate reproductions of Safari/Chrome UI, logos or brand colors.
- New entry points, new tabs on the staff surface, or any change to spec 153's
  Q2/Q5 defaults.

## Verification (test track: **jest**)

- `src/lib/installGuide.test.ts` (extend) — AC-1: `art` present on every step,
  nine-member coverage, one-to-one mapping, stable per-platform assignment.
- `src/components/illustrations/StepIllustration.test.tsx` (new) — AC-2, AC-6,
  AC-8: every art renders; labels come from the `labels` prop; decorative flags.
- `src/components/cmd/InstallGuideSheet.test.tsx` (extend) — AC-3.
- `src/screens/staff/screens/Settings.test.tsx` (extend) — AC-4.
- Both i18n parity suites — AC-6 / AC-REG2 for free.
- Gates: `npx tsc --noEmit`, `npm run typecheck:test`, full `npx jest`,
  `npx expo export --platform web`.

No pgTAP (no DB surface), no shell smokes (no HTTP surface).

---

## Implementation notes (frontend-developer, 2026-08-07)

Built to the design above. Three things worth a reviewer's attention:

1. **`fontFamily` prop dropped.** The first cut let the admin surface pass
   `mono(500)` into the picture. In the browser check "Add to Home Screen"
   ellipsized inside the drawn share-sheet row at every width the drawer can
   give it, so the labels now use the system font on both surfaces (§2.3). The
   surrounding chrome is unchanged and still mono.
2. **Illustration widths tuned during the browser check** — admin cap 240 → 280,
   staff cap 180 → 200 — so the OS labels fit un-truncated in English. Long
   locales (`"Instalar aplicación"` in the Android menu row) still ellipsize by
   design; the full string is in the step prose immediately above.
3. **`{ includeHiddenElements: true }` in the new assertions.** The pictures are
   `accessibilityElementsHidden` / `no-hide-descendants` (AC-8) and RNTL v12
   skips inaccessible subtrees, so every new query opts in. A query that starts
   passing without it means the a11y hiding was lost.

One additive edit to a spec-153 test file beyond new cases: the `useCmdColors`
stub in `InstallGuideSheet.test.tsx` gained `accentBg` (the illustrations map it
into their highlight fill). No existing assertion was changed or removed.

**Gates:** `npx tsc --noEmit` clean · `npm run typecheck:test` clean · full
`npx jest` 196 suites / 2067 tests green (was 195/2033 at spec 153) ·
`npx expo export --platform web` builds.

**Browser check performed** (headless Chromium against the local Expo web dev
server + local Supabase stack): admin sheet at 1440×900 in **light and dark**
across all three tabs; admin sheet fullscreen at the phone breakpoint (390×844,
opened from the hamburger drawer — the drawer closes before the sheet opens);
staff Settings card at 390×844 as `manager@local.test` (role `user`). Zero
console/page errors in every pass. Not covered by that check: real iPhone Safari
and real Android Chrome (UA-dependent), which spec 153's manual pass already
owns.

## Files changed

- `specs/154-install-tutorial-illustrations.md` (this file)
- `src/lib/installGuide.ts` — `InstallArt` union + `art` on `InstallStep`
- `src/lib/installGuide.test.ts` — AC-1 art coverage (additive)
- `src/components/illustrations/StepIllustration.tsx` (new)
- `src/components/illustrations/StepIllustration.test.tsx` (new)
- `src/components/cmd/InstallGuideSheet.tsx` — palette/label mapping + the
  illustration under each step row
- `src/components/cmd/InstallGuideSheet.test.tsx` — AC-3 (additive) + `accentBg`
  in the theme stub
- `src/screens/staff/components/InstallGuideCard.tsx` — same addition, staff
  tokens + staff catalog
- `src/screens/staff/screens/Settings.test.tsx` — AC-4 (additive)
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
- `src/screens/staff/i18n/en.json`, `src/screens/staff/i18n/es.json`,
  `src/screens/staff/i18n/zh-CN.json`

Explicitly **not** in the diff: `supabase/**`, `src/lib/db.ts`, either store,
`public/**`, `assets/**`, `vercel.json`, `app.json`.

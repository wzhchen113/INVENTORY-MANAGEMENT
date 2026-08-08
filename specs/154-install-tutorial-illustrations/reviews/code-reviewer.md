# Code review for spec 154

## Design-call verdicts (requested explicitly for this spec)

- **Palette-as-prop instead of `useCmdColors()` inside `StepIllustration`** — correct
  call, cleanly executed. `src/components/illustrations/StepIllustration.tsx`
  imports no theme hook, no catalog, no store — only `React`, RN primitives,
  `react-native-svg`, and the `InstallArt` type. This is exactly what spec 063's
  "staff subtree never imports `useStore`" contract requires, and both call
  sites (`InstallGuideSheet.tsx:74-88`, `InstallGuideCard.tsx:54-68`) map their
  own ten tokens into the same slot names correctly, including in dark mode
  (`accentBg` / `primaryPressedLight` both verified to exist in their
  respective token files).
- **Labels-as-prop from per-surface catalogs** — same verdict, same reasoning.
  Both call sites resolve `chrome.installGuide.art.*` through their own `T`/`t`
  and hand the resolved strings down; the component never touches i18n. No
  leakage either direction.
- **`fontFamily` drop (implementation note #1)** — good catch, well-reasoned,
  and honestly disclosed. Dropping mono for the drawn labels while keeping mono
  on the surrounding chrome (glyph tile, marker, install button — still `mono()`
  in `InstallGuideSheet.tsx:132/191/209/245` and the staff `makeStyles`) is the
  right scope: only the labels that have to survive es/zh-CN expansion inside a
  narrow drawn row needed the change, nothing else did.

## Critical

(none)

## Should-fix

(none)

## Nits

- `src/components/illustrations/StepIllustration.tsx:499-501` — the decorative
  a11y props (`importantForAccessibility="no-hide-descendants"`, no
  `accessibilityRole="image"`) differ from the literal shorthand in spec 154
  §2.6 (`importantForAccessibility="no"` / `accessibilityRole="image"`). The
  implementation's choice is arguably stronger — `"no-hide-descendants"`
  actually removes the child `Text` nodes from the Android accessibility tree,
  which `"no"` alone would not guarantee — but it's an undocumented deviation:
  the Implementation notes section called out two other deviations (fontFamily
  drop, width tuning) and missed this one. Not asking for a change, just
  flagging that the "notes" list wasn't quite complete.
- `src/components/illustrations/StepIllustration.tsx:356-380` vs `:429-451`
  (out-of-scope) — `ios-add-confirm` and `android-confirm` draw visually
  similar "icon + name + CTA" dialogs with independently authored geometry.
  A shared `confirmDialog()` helper (like `phoneShell`/`pageContent`) could cut
  the duplication, but the two OS dialogs genuinely differ (iOS has a title row
  the Android one doesn't), so forcing a shared helper would mostly just move
  the divergence into parameters. Not proposing this land now — noting it in
  case a tenth art with the same shape appears later.

## Verification of the spec's other explicit checks

- **`Record<InstallArt, ArtSpec>` exhaustiveness** — confirmed real:
  `ART: Record<InstallArt, ArtSpec>` at `StepIllustration.tsx:280` has all nine
  keys, one draw fn each; a tenth `InstallArt` member added to
  `src/lib/installGuide.ts` without a matching `ART` entry fails
  `npx tsc --noEmit` (object literal assigned to a `Record<K,V>` must supply
  every `K`). `StepIllustration.test.tsx:66-69` also pins this at runtime
  (`INSTALL_ART_IDS` vs the model's `art` values, sorted-equal).
- **No color literal claim (AC-5)** — verified: grepped
  `StepIllustration.tsx` for hex patterns, zero matches. Every `fill`/`stroke`
  in `phoneShell`, `pageContent`, `scrim`, `appIcon`, `safariBar`, `chromeBar`,
  `desktopWindow`, and all nine `ART` entries reads off `P.<slot>`. `opacity`
  values (unitless numbers) are the only non-token style props, which is fine.
- **RN-Text-over-Svg layering** — sound. Both layers derive from one
  `scale = width / spec.w` (`StepIllustration.tsx:489`), so a label box can't
  drift from the drawing under it at any width. `top: l.cy * scale - lineHeight
  / 2` correctly backs off half the line box since `cy` is documented as a
  vertical center, not a top. `numberOfLines={1}` + `ellipsizeMode="tail"`
  match the stated rationale (es/zh-CN expansion must clip, not wrap/overflow).
- **SVG quality / registry structure** — the nine `ArtSpec` entries are
  internally consistent: base viewBoxes match the two declared sizes (phone
  124×176, desktop 176×112) exactly per spec §2.4; every `LabelSpec`'s `x + w`
  stays inside its art's viewBox width (spot-checked all nine, none overflow);
  shared chrome (`phoneShell`, `safariBar`, `chromeBar`, `desktopWindow`,
  `homeIndicator`, `scrim`, `appIcon`) is correctly factored out and reused
  across the arts that need it, so the nine-art registry isn't nine independent
  copies of the phone body.
- **Both catalog sets' parity** — the five `chrome.installGuide.art.*` keys
  exist, with matching values, in all six files: `src/i18n/{en,es,zh-CN}.json`
  (`en.json:178-184`, `es.json:178-184`, `zh-CN.json:178-184`) and
  `src/screens/staff/i18n/{en,es,zh-CN}.json` (all at `:460-466` except
  `en.json:460-466`). Each locale's `art.addToHomeScreen` / `art.installApp` /
  `art.install` / `art.add` string is byte-identical to the quoted OS label
  already used in that same locale's `steps.*` prose, matching the spec's
  reuse claim — checked es ("Añadir a pantalla de inicio", "Instalar
  aplicación") and zh-CN ("添加到主屏幕", "安装应用") against their step strings.

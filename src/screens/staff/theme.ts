// src/screens/staff/theme.ts — single-file theme tokens for the staff app.
//
// The staff app is intentionally minimal — kitchen lighting + glove-on
// thumbs + portrait phone are the design constraints. Spec 070 adds a
// dark theme (the app shipped light-only) and a clean-modern re-skin
// (soft cards, subtle elevation, a muted/refined palette).
//
// Mirror imr-inventory's `src/theme/colors.ts` *shape* (light/dark
// palettes + a `useColors()` hook + a platform-branched shadow token)
// but ship one self-contained file instead of a directory.
//
// The staff portal is pinned to the DARK palette regardless of OS
// appearance (product decision — every staff user sees dark). The
// `useStaffColors()` / `useStaffElevation()` hooks therefore return the
// dark set unconditionally; the pure `resolveStaffColors` / `makeElevation`
// resolvers still honour an explicit scheme arg (used by unit tests and
// retained should OS-following ever be reintroduced). The light palette
// is kept intact for that reason.
//
// `spacing`/`radius`/`typography`/`touchTarget` are theme-invariant and
// stay as static module exports — only color access moves to the hook.

import { Platform } from 'react-native';

// ── Light palette ────────────────────────────────────────────────
// Soft off-white app bg with pure-white cards lifted off it. The
// primary is the brand green (matches the admin app's `accent`); the
// `info` tone is a desaturated teal so nothing in the palette reads blue.
export const lightColors = {
  // Surfaces
  bg: '#F7F8FA',
  bgAlt: '#EEF0F3',
  surface: '#FFFFFF',
  surfaceAlt: '#F2F4F7',
  surfaceElevated: '#FFFFFF', // same as surface in light; the shadow does the lifting

  // Text
  text: '#1A1D21',
  textSecondary: '#5A6068',
  textTertiary: '#868D96', // de-emphasized — decorative/large only (see §2 contrast note)
  textOnPrimary: '#FFFFFF',
  textInverse: '#FFFFFF',

  // Borders / dividers
  border: '#E4E7EC',
  borderStrong: '#CBD0D8',

  // Brand / interactive — brand green (mirrors admin `accent` #3F7C20)
  primary: '#3F7C20',
  primaryPressed: '#33651A',
  // Translucent primary tint for the secondary (outline) button's
  // pressed state — used by Button.tsx where a full primary fill
  // would over-emphasize an outline-style press.
  primaryPressedLight: 'rgba(63,124,32,0.10)',
  primaryDisabled: '#A8C99A',

  // Semantic (calm, desaturated; tints are low-chroma). `info` is a
  // teal (not blue) so the palette carries no blue; it stays distinct
  // from the green `success`.
  success: '#2E7D46',
  successBg: '#E7F4EC',
  warning: '#B5710B',
  warningBg: '#FBF0DC',
  error: '#C0392B',
  errorBg: '#FBEAE8',
  info: '#2C7A6F',
  infoBg: '#E2F1EE',

  // Overlays
  overlay: 'rgba(17,20,24,0.45)',
};

// ── Dark palette ─────────────────────────────────────────────────
// Layered greys, never pure black: "soft" comes from lighter surfaces
// (elevation by layering), not from a black drop shadow. The primary
// lifts to a lighter, airier green (mirrors admin dark `accent` #7DD668)
// so it reads on dark surfaces, and `textOnPrimary` flips to dark (the
// fill is light in dark mode) — mirrors the admin `accentFg` flip.
export const darkColors: typeof lightColors = {
  // Surfaces
  bg: '#16181C',
  bgAlt: '#101216',
  surface: '#1F2228',
  surfaceAlt: '#272B32',
  surfaceElevated: '#272B32', // one step lighter than surface — elevation by layering

  // Text
  text: '#E7E9EC',
  textSecondary: '#9BA1AB',
  textTertiary: '#727884',
  textOnPrimary: '#16181C', // dark text on the lighter dark-mode primary fill
  textInverse: '#16181C',

  // Borders / dividers — light-on-dark hairlines
  border: 'rgba(255,255,255,0.10)',
  borderStrong: 'rgba(255,255,255,0.18)',

  // Brand / interactive — lighter, airier green for dark surfaces
  primary: '#7DD668',
  primaryPressed: '#6BC257',
  primaryPressedLight: 'rgba(125,214,104,0.16)',
  primaryDisabled: '#41552F',

  // Semantic — brighter foregrounds, low-alpha tints (admin DarkColors pattern).
  // `info` is a teal (not blue), distinct from the green `success`.
  success: '#5FBA6E',
  successBg: 'rgba(95,186,110,0.16)',
  warning: '#E0A030',
  warningBg: 'rgba(224,160,48,0.16)',
  error: '#E36A5C',
  errorBg: 'rgba(227,106,92,0.16)',
  info: '#4FC4B6',
  infoBg: 'rgba(79,196,182,0.16)',

  // Overlays
  overlay: 'rgba(0,0,0,0.60)',
};

export type StaffColors = typeof lightColors; // both palettes share this shape

// ── Color resolution ─────────────────────────────────────────────
// Pure, testable core. `'dark'` → darkColors; everything else
// (`'light'`, `null`, `undefined`) → lightColors. The null/undefined
// fallback to light is load-bearing: under jest (jest-expo) and on the
// first synchronous web paint `useColorScheme()` can return `null`;
// defaulting to light keeps the existing screen tests rendering the
// light palette (no test churn) and gives web a deterministic default.
export function resolveStaffColors(
  scheme: 'light' | 'dark' | null | undefined,
): StaffColors {
  return scheme === 'dark' ? darkColors : lightColors;
}

// Colors hook — mirrors the admin `useColors()` shape (a zero-arg hook
// returning a palette object). The staff portal is now pinned to the
// DARK palette regardless of OS appearance (per the "always dark"
// product decision), so this no longer reads `useColorScheme()`. The
// pure `resolveStaffColors` resolver below is kept (and still honours
// the scheme arg) for unit tests and any future OS-following use.
export function useStaffColors(): StaffColors {
  return resolveStaffColors('dark');
}

// 2026-07 density pass: owner asked for half the original visual bulk
// ("everything divided by 2"), so the spacing/radius/type scales below
// are ~50% of the original phone scale.
export const spacing = {
  xxs: 1,
  xs: 2,
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  xxl: 16,
  xxxl: 24,
} as const;

export const radius = {
  sm: 4, // inputs, small pills
  md: 6, // buttons, chips
  lg: 8, // cards / rows / banners
  xl: 10, // large hero cards if needed
  pill: 999,
} as const;

export const typography = {
  // Sizes — ~half the original 16/18/20 phone scale.
  caption: 8,
  body: 9,
  bodyLarge: 10,
  title: 12,
  headline: 14,
  display: 16,

  // Line-height helpers (additive) so multi-line copy breathes.
  lineHeightBody: 12, // for body (9) text blocks
  lineHeightTitle: 18, // for title/headline blocks

  // Weights
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
} as const;

// Spec 062 §B5 + B10 set tap targets ≥ 44pt; lowered to 24pt in the
// 2026-07 density pass with explicit owner approval ("everything
// divided by 2").
export const touchTarget = {
  min: 24,
} as const;

// ── Elevation / shadow scale ──────────────────────────────────────
// Same platform-branch shape as the admin `Shadow` token
// (src/theme/colors.ts): on web emit CSS `boxShadow`; on native emit
// `shadowColor`/`shadowOffset`/`shadowOpacity`/`shadowRadius` +
// `elevation`. This avoids the react-native-web `shadow*`-prop
// deprecation warning. Three levels, theme-aware — dark shadows are
// near-invisible so dark elevation leans on surface layering + border
// (see ListRow), but the (subtle) shadow is still tuned per theme.
//
// `makeElevation` is exported standalone so it stays unit-testable like
// `resolveStaffColors`. Consumers use the `useStaffElevation()` hook.
export function makeElevation(scheme: 'light' | 'dark' | null | undefined) {
  const dark = scheme === 'dark';
  if (Platform.OS === 'web') {
    return dark
      ? {
          card: { boxShadow: '0 1px 2px rgba(0,0,0,0.40)' } as const,
          raised: { boxShadow: '0 2px 8px rgba(0,0,0,0.50)' } as const,
          modal: { boxShadow: '0 8px 28px rgba(0,0,0,0.60)' } as const,
        }
      : {
          // Light card shadow tuned to be visibly present at phone scale —
          // a layered ambient+key shadow (the standard "material card" look)
          // so white cards read as lifted off the bgAlt field. The earlier
          // 0.06-opacity single shadow was effectively invisible on web,
          // which made the cards look flat (spec 070 fix-pass).
          card: { boxShadow: '0 1px 2px rgba(17,24,39,0.08), 0 2px 6px rgba(17,24,39,0.10)' } as const,
          raised: { boxShadow: '0 2px 4px rgba(17,24,39,0.10), 0 6px 16px rgba(17,24,39,0.14)' } as const,
          modal: { boxShadow: '0 12px 32px rgba(17,24,39,0.20)' } as const,
        };
  }
  // native
  return dark
    ? {
        card: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.4, shadowRadius: 3, elevation: 3 } as const,
        raised: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.5, shadowRadius: 8, elevation: 6 } as const,
        modal: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.6, shadowRadius: 28, elevation: 16 } as const,
      }
    : {
        // Native: a single key shadow with enough opacity/radius to be
        // visible on the bgAlt field (raised from 0.06 → 0.12).
        card: { shadowColor: '#111827', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 6, elevation: 3 } as const,
        raised: { shadowColor: '#111827', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.16, shadowRadius: 16, elevation: 8 } as const,
        modal: { shadowColor: '#111827', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.2, shadowRadius: 32, elevation: 12 } as const,
      };
}

// Elevation hook — pinned to the dark elevation set to match the
// always-dark `useStaffColors()`. Kept a separate hook so the colors
// hook stays shape-identical to admin `useColors()`. The pure
// `makeElevation` resolver still honours its scheme arg for unit tests.
export function useStaffElevation() {
  return makeElevation('dark');
}

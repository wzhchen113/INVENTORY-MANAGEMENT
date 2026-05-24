// src/theme.ts — single-file theme tokens for imr-staff.
//
// The staff app is intentionally minimal — kitchen lighting + glove-on
// thumbs + portrait phone are the design constraints. Light mode only;
// no admin-style preference panel.
//
// Mirror imr-inventory's tokens shape (light palette) where it makes
// sense, but ship one file instead of a directory.

export const colors = {
  // Surfaces
  bg: '#ffffff',
  bgAlt: '#f5f6f8',
  surface: '#ffffff',
  surfaceAlt: '#f0f1f3',

  // Text
  text: '#1a1a1a',
  textSecondary: '#5b6168',
  textOnPrimary: '#ffffff',
  textInverse: '#ffffff',

  // Borders / dividers
  border: '#d8dadf',
  borderStrong: '#a5a9b1',

  // Brand / interactive
  primary: '#1e88e5',
  primaryPressed: '#1565c0',
  // Translucent primary tint for the secondary (outline) button's
  // pressed state — used by Button.tsx where a full primary fill
  // would over-emphasize an outline-style press.
  primaryPressedLight: 'rgba(30,136,229,0.08)',
  primaryDisabled: '#90caf9',

  // Semantic
  success: '#2e7d32',
  successBg: '#e8f5e9',
  warning: '#ed6c02',
  warningBg: '#fff4e5',
  error: '#c62828',
  errorBg: '#fdecea',
  info: '#0277bd',
  infoBg: '#e1f5fe',

  // Overlays
  overlay: 'rgba(0,0,0,0.4)',
} as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  pill: 999,
} as const;

export const typography = {
  // Sizes
  caption: 12,
  body: 16,
  bodyLarge: 18,
  title: 20,
  headline: 24,
  display: 28,

  // Weights
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
} as const;

// Per spec 062 §B5 + B10 — tap targets ≥ 44pt.
export const touchTarget = {
  min: 44,
} as const;

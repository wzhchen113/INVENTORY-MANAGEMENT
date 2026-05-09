import { Platform, useWindowDimensions } from 'react-native';

// Spec 011 §1 — three-tier responsive breakpoints.
//   - phone   < 768
//   - tablet  768–1099
//   - desktop ≥ 1100
//
// `DESKTOP_MIN_WIDTH` (= BREAKPOINTS.tabletMax + 1) stays exported for
// back-compat with existing call sites that import it directly.
//
// The pre-Spec-011 comment claimed the 1100 threshold was tuned to keep
// iPad landscape (~1180) on a "thumb-friendly" mobile layout — but the
// math was wrong: 1180 ≥ 1100 means iPad landscape has always rendered
// as desktop. The threshold itself is preserved (architect §4.A); the
// stale comment is removed.
export const BREAKPOINTS = {
  phoneMax: 767,    // < 768  → phone
  tabletMax: 1099,  // 768–1099 → tablet
  // ≥ 1100 → desktop
} as const;

export const DESKTOP_MIN_WIDTH = BREAKPOINTS.tabletMax + 1; // 1100

export type Breakpoint = 'phone' | 'tablet' | 'desktop';

export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions();
  // Native always gets the narrowest tier — there is no desktop-on-native.
  if (Platform.OS !== 'web') return 'phone';
  if (width <= BREAKPOINTS.phoneMax) return 'phone';
  if (width <= BREAKPOINTS.tabletMax) return 'tablet';
  return 'desktop';
}

// Convenience selectors so call sites don't proliferate string compares.
export function useIsPhone(): boolean {
  return useBreakpoint() === 'phone';
}

export function useIsTablet(): boolean {
  return useBreakpoint() === 'tablet';
}

export function useIsDesktop(): boolean {
  return useBreakpoint() === 'desktop';
}

/** True when the viewport is phone OR tablet (i.e. anything narrower
 *  than the desktop 3-pane layout). Useful for shell decisions and for
 *  drawer presentations that share behavior across the two narrow tiers. */
export function useIsCompact(): boolean {
  return useBreakpoint() !== 'desktop';
}

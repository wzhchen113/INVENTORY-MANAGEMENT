import { Platform, useWindowDimensions } from 'react-native';

// Web ≥ 1100 gets the desktop 3-pane layout. Below that (and on every native
// platform) the mobile screens render. Set to 1100 instead of 1024 so iPad
// landscape (~1180) still gets the thumb-friendly mobile layout.
export const DESKTOP_MIN_WIDTH = 1100;

export type Breakpoint = 'desktop' | 'mobile';

export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions();
  if (Platform.OS !== 'web') return 'mobile';
  return width >= DESKTOP_MIN_WIDTH ? 'desktop' : 'mobile';
}

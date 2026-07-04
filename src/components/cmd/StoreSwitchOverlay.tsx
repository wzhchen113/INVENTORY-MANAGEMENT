// src/components/cmd/StoreSwitchOverlay.tsx — Spec 111.
//
// Full-screen "Switching stores…/brands…" takeover painted over the ENTIRE
// Cmd UI (TitleBar/MobileTopAppBar + sidebar + section body) for the
// duration of a store/brand switch. The stale-data problem it solves:
// `setCurrentStore` swaps `currentStore` synchronously and fires an async
// refetch, but the per-section slices are deliberately kept (in-memory
// cache) — so without this gate the operator briefly sees the PREVIOUS
// store's inventory/recipes/counts under the NEW store's name. This overlay
// visually gates that window; it does NOT clear any slice (that would
// regress the cache and flash empty states — see spec Out of scope).
//
// Presentational only (peer to ListSkeleton / LoadingBar). The shell owns
// the `switching !== null` gate in ResponsiveCmdShell and passes the
// narrowed value as `mode`; this component needs no store access, which
// keeps it trivially unit-testable (mirrors the skeleton components).
//
// Cross-platform (web + native): only View / ActivityIndicator / Text +
// absolute positioning — no web-only CSS (AC-10). Renders at all three
// breakpoints from the single-per-branch mount in the shell.

import React from 'react';
import { View, ActivityIndicator, Text, StyleSheet } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { Type } from '../../theme/typography';
import { useT } from '../../hooks/useT';

interface Props {
  /** The non-null narrowing of `AppState.switching`. Drives the copy
   *  variant: 'store' → "Switching stores…", 'brand' → "Switching brands…". */
  mode: 'store' | 'brand';
}

export const StoreSwitchOverlay: React.FC<Props> = ({ mode }) => {
  const C = useCmdColors();
  const T = useT();

  // AC-7 — distinct copy per switch type, both localized (AC-9).
  const label = mode === 'brand' ? T('common.switchingBrands') : T('common.switchingStores');

  return (
    <View
      testID="store-switch-overlay"
      style={[
        StyleSheet.absoluteFillObject,
        {
          // Opaque `C.bg` fill fully hides the stale section/sidebar/title
          // bar beneath (the whole point of the gate). zIndex/elevation are
          // belt-and-suspenders — RN paints in document order and the shell
          // mounts this last inside cmd-shell-root, so it's already on top.
          backgroundColor: C.bg,
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100,
          elevation: 100,
        },
      ]}
      // AC-8 accessibility (cheap, per the ask): announce on mount. RN maps
      // accessibilityLiveRegion to aria-live on web; the alert role announces
      // on iOS. accessibilityLabel carries the resolved copy so the reader
      // speaks "Switching stores…/brands…".
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      accessibilityLabel={label}
    >
      <ActivityIndicator size="large" color={C.accent} />
      <Text
        testID="store-switch-overlay-label"
        style={[Type.body, { color: C.fg, marginTop: 16, letterSpacing: 0.2 }]}
      >
        {label}
      </Text>
    </View>
  );
};

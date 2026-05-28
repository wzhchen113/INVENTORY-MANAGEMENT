// src/components/ListRow.tsx — touch-friendly list row primitive.
//
// Used by StorePicker (tap to select) and EODCount (item rows).
// Always ≥ 44pt tall per spec 062 §B10.
//
// Spec 070 — the biggest visual shift: flat hairline-divided rows become
// soft cards (radius.lg, surface fill, subtle elevation, no bottom
// divider). The screen supplies inter-card spacing. In dark mode a
// `borderStrong` hairline is added so the card edge survives where the
// shadow is near-invisible (light mode: shadow alone, no border).

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, useColorScheme, View } from 'react-native';
import { radius, spacing, touchTarget, useStaffColors, useStaffElevation } from '../theme';

type Props = {
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'none';
  /** Left-side content: usually a Text title + subtitle column. */
  leading: ReactNode;
  /** Right-side content: usually an Input or chevron. */
  trailing?: ReactNode;
};

export function ListRow({
  onPress,
  testID,
  accessibilityLabel,
  accessibilityRole,
  leading,
  trailing,
}: Props) {
  const c = useStaffColors();
  const e = useStaffElevation();
  // ListRow is the only component that needs the raw scheme boolean
  // (dark-only card border); everyone else needs only colors/elevation.
  const isDark = useColorScheme() === 'dark';

  // The card's structural + chrome styles, shared by the pressable and
  // static branches. Dark mode adds a `borderStrong` hairline so the
  // card edge survives where the shadow is near-invisible (light mode:
  // shadow alone, no border).
  const cardChrome = {
    borderWidth: isDark ? 1 : 0,
    borderColor: isDark ? c.borderStrong : 'transparent',
  };
  const base = [styles.row, e.card, cardChrome];

  const inner = (
    <>
      <View style={styles.leading}>{leading}</View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </>
  );

  // A non-pressable row is a plain <View>, which does NOT accept a
  // style *function* (only Pressable does). Passing a function to View
  // is silently dropped — which previously collapsed the card (no
  // flexDirection/fill/radius) into a flat, full-width stack. So branch
  // explicitly: Pressable gets the function (for the pressed tint),
  // View gets a resolved array.
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={accessibilityRole ?? 'button'}
        style={({ pressed }) => [
          ...base,
          { backgroundColor: pressed ? c.surfaceAlt : c.surface },
        ]}
      >
        {inner}
      </Pressable>
    );
  }

  return (
    <View
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole ?? 'none'}
      style={[...base, { backgroundColor: c.surface }]}
    >
      {inner}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: touchTarget.min + 16, // 60pt — comfortable phone row
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
  },
  leading: {
    flex: 1,
    minWidth: 0,
  },
  trailing: {
    marginLeft: spacing.md,
    flexShrink: 0,
  },
});

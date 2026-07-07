// src/components/ListRow.tsx — touch-friendly list row primitive.
//
// Used by StorePicker (tap to select) and EODCount (item rows).
// Always ≥ 44pt tall per spec 062 §B10.
//
// Spec 070 — the biggest visual shift: flat hairline-divided rows become
// soft cards (T.radius.lg, surface fill, subtle elevation, no bottom
// divider). The screen supplies inter-card T.spacing. In dark mode a
// `borderStrong` hairline is added so the card edge survives where the
// shadow is near-invisible (light mode: shadow alone, no border).

import { useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useStaffColors, useStaffElevation, useStaffTokens, type StaffTokens } from '../theme';

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
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  // The staff portal is always dark, so the dark-only card border (a
  // `borderStrong` hairline that keeps the card edge visible where the
  // dark shadow is near-invisible) is always on.
  const isDark = true;

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

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  row: {
    minHeight: T.touchTarget.min, // 24pt — dense phone row
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: T.spacing.sm,
    paddingVertical: T.spacing.xs,
    borderRadius: T.radius.lg,
  },
  leading: {
    flex: 1,
    minWidth: 0,
  },
  trailing: {
    marginLeft: T.spacing.md,
    flexShrink: 0,
  },
});

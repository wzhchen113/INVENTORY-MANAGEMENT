// src/components/ListRow.tsx — touch-friendly list row primitive.
//
// Used by StorePicker (tap to select) and EODCount (item rows).
// Always ≥ 44pt tall per spec 062 §B10.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { colors, radius, spacing, touchTarget } from '../theme';

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
  const Wrap = onPress ? Pressable : View;
  return (
    <Wrap
      onPress={onPress}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole ?? (onPress ? 'button' : 'none')}
      style={({ pressed }: { pressed?: boolean } = {}) => [
        styles.row,
        pressed ? styles.rowPressed : null,
      ]}
    >
      <View style={styles.leading}>{leading}</View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </Wrap>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: touchTarget.min + 16, // 60pt — comfortable phone row
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    borderRadius: radius.sm,
  },
  rowPressed: {
    backgroundColor: colors.surfaceAlt,
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

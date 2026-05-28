// src/components/QueueIndicator.tsx — inline "N pending" pill.
//
// Used by EODCount above the submit button. Reads pending count via
// useEodSubmit's reactive selector. Shows nothing when count is zero.
//
// Spec 070: success-tinted pill, colors from `useStaffColors()`. Sits
// inside the footer card so it carries no elevation of its own.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, typography, useStaffColors } from '../theme';
import { t } from '../i18n';

type Props = {
  pending: number;
  draining: boolean;
  testID?: string;
};

export function QueueIndicator({ pending, draining, testID }: Props) {
  const c = useStaffColors();
  if (pending === 0 && !draining) return null;
  const label = draining
    ? t('chrome.queue.draining')
    : t('chrome.queue.pending', { count: pending });
  return (
    <View testID={testID} style={[styles.pill, { backgroundColor: c.successBg }]}>
      {draining ? (
        <ActivityIndicator color={c.success} size="small" />
      ) : (
        <View style={[styles.dot, { backgroundColor: c.success }]} />
      )}
      <Text style={[styles.label, { color: c.success }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: typography.caption,
    fontWeight: typography.semibold,
  },
});

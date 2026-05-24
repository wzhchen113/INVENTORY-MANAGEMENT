// src/components/QueueIndicator.tsx — inline "N pending" pill.
//
// Used by EODCount above the submit button. Reads pending count via
// useEodSubmit's reactive selector. Shows nothing when count is zero.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../theme';
import { t } from '../i18n';

type Props = {
  pending: number;
  draining: boolean;
  testID?: string;
};

export function QueueIndicator({ pending, draining, testID }: Props) {
  if (pending === 0 && !draining) return null;
  const label = draining
    ? t('chrome.queue.draining')
    : t('chrome.queue.pending', { count: pending });
  return (
    <View testID={testID} style={styles.pill}>
      {draining ? (
        <ActivityIndicator color={colors.success} size="small" />
      ) : (
        <View style={styles.dot} />
      )}
      <Text style={styles.label}>{label}</Text>
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
    backgroundColor: colors.successBg,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  label: {
    fontSize: typography.caption,
    color: colors.success,
    fontWeight: typography.semibold,
  },
});

// src/screens/staff/components/AppReloadButton.tsx — the ⟳ button that hard-
// reloads the app.
//
// Owner request (2026-07-22): staff phones run this app as an installed PWA
// and were closing/reopening it to pick up new deploys or fresh data. There
// is NO shared in-store header (see SettingsGear.tsx), so this small
// self-contained control is dropped into each in-store screen's header row
// next to the gear. A hard location.reload() re-fetches index.html — the
// service worker is push-only (no fetch caching), so the reload always gets
// the latest bundle and data. Queued offline EOD submissions live in
// persistent storage (eodQueue), so a reload never loses them.
// Web-only: renders nothing on native.

import { useMemo } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../theme';
import { useI18n } from '../i18n';

type Props = {
  testID?: string;
};

export function AppReloadButton({ testID }: Props) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  if (Platform.OS !== 'web') return null;

  return (
    <Pressable
      onPress={() => window.location.reload()}
      testID={testID ?? 'staff-app-reload'}
      accessibilityRole="button"
      accessibilityLabel={t('chrome.refreshApp.aria')}
      style={({ pressed }) => [
        styles.btn,
        pressed ? { backgroundColor: c.surfaceAlt } : null,
      ]}
    >
      <Ionicons name="refresh" size={22} color={c.textSecondary} />
      <Text style={[styles.label, { color: c.textSecondary }]} numberOfLines={1}>
        {t('chrome.refreshApp.label')}
      </Text>
    </Pressable>
  );
}

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  btn: {
    minHeight: T.touchTarget.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.xs,
    paddingHorizontal: T.spacing.sm,
    borderRadius: T.radius.sm,
  },
  label: {
    fontSize: T.typography.body,
    fontWeight: T.typography.medium,
  },
});

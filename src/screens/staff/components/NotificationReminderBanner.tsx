// src/screens/staff/components/NotificationReminderBanner.tsx — spec 126
// follow-up.
//
// A persistent, RED-toned "Turn on notifications to get reminders" banner
// that mounts near the top (below the header) of all four in-store screens
// (EODCount / Reorder / WeeklyCount / Receiving). The whole banner is a
// Pressable that jumps to the Settings screen where the per-device toggle
// lives. It is NON-dismissible on purpose — it disappears on its own once
// notifications flip on (or into the non-actionable `na` bucket), so there's
// nothing to dismiss.
//
// Each in-store screen mounts its own instance, so the banner owns its own
// `useNotificationToggle` probe rather than threading state down from the
// screen. The four in-store screens stay MOUNTED simultaneously (the tab
// navigator lazy-mounts then keeps them), so multiple `useNotificationToggle`
// instances are live at once — this banner is NOT a single live probe.
// Cross-instance consistency (e.g. enabling notifications in Settings clearing
// this banner without a background/reopen) is guaranteed by the hook's
// module-scoped re-probe broadcast (spec 136), not by single-instance
// mounting. It funnels the raw view through the shared `notificationLevel`
// helper so it renders IFF level === 'off' — matching the RED SettingsGear dot
// exactly.

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  useStaffColors,
  useStaffTokens,
  type StaffColors,
  type StaffTokens,
} from '../theme';
import { useI18n } from '../i18n';
import { currentStaffUserId, useStaffStore } from '../store/useStaffStore';
import { useNotificationToggle } from '../../../lib/useNotificationToggle';
import { notificationLevel } from '../lib/notificationLevel';

type Props = {
  testID?: string;
};

export function NotificationReminderBanner({ testID }: Props) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T, c), [T, c]);
  const { t } = useI18n();
  const navigation = useNavigation<{ navigate: (screen: string) => void }>();
  const userId = useStaffStore((s) => currentStaffUserId(s.authState));
  const m = useNotificationToggle(userId, t);

  // Only the RED (off-but-actionable) level shows a banner — a nudge on the
  // `na` views (`unsupported` / `error`) can't lead to a fix.
  if (notificationLevel(m.view) !== 'off') return null;

  return (
    <Pressable
      onPress={() => navigation.navigate('Settings')}
      testID={testID ?? 'staff-notif-reminder-banner'}
      accessibilityRole="button"
      accessibilityLabel={t('chrome.notifications.reminderBanner')}
      style={({ pressed }) => [styles.banner, pressed ? styles.pressed : null]}
    >
      <Text style={styles.text}>{t('chrome.notifications.reminderBanner')}</Text>
    </Pressable>
  );
}

const makeStyles = (T: StaffTokens, c: StaffColors) =>
  StyleSheet.create({
    banner: {
      backgroundColor: c.errorBg,
      borderLeftColor: c.error,
      borderLeftWidth: 4,
      borderRadius: T.radius.lg,
      paddingVertical: T.spacing.md,
      paddingHorizontal: T.spacing.lg,
      // Match the item-card gutter so the soft-card corners read instead of
      // bleeding to the screen edges (same inset the Banner component uses).
      marginHorizontal: T.spacing.lg,
      marginBottom: T.spacing.sm,
    },
    pressed: {
      opacity: 0.7,
    },
    text: {
      color: c.error,
      fontSize: T.typography.body,
      fontWeight: T.typography.medium,
      lineHeight: T.typography.lineHeightBody,
    },
  });

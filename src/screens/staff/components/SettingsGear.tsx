// src/screens/staff/components/SettingsGear.tsx — the gear (⚙) button that
// opens the consolidated staff Settings screen.
//
// Spec 126. There is NO shared in-store header, so this small self-contained
// control is dropped into each of the four in-store screens' header rows
// (EODCount / Reorder / WeeklyCount / Receiving). It owns its own
// `useNavigation` so a screen only needs to render `<SettingsGear />` — the
// `navigation.navigate('Settings')` call bubbles from the nested tab navigator
// up to the parent stack where the `Settings` Stack.Screen is registered.
//
// Spec 126 follow-up: the control now renders a "Settings" text label next to
// the gear, and a small red dot overlaps the gear when notifications are OFF
// but there's an actionable next step in Settings (`off` = supported-but-not-
// subscribed, `needs-install` = iOS-needs-PWA-install). The dot is suppressed
// for the non-actionable views (`on`, `unsupported`, `denied`, `error`) so it
// never nags with no in-app fix.

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../theme';
import { useI18n } from '../i18n';
import { currentStaffUserId, useStaffStore } from '../store/useStaffStore';
import { useNotificationToggle } from '../../../lib/useNotificationToggle';

type Props = {
  testID?: string;
};

export function SettingsGear({ testID }: Props) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  const navigation = useNavigation<{ navigate: (screen: string) => void }>();
  const userId = useStaffStore((s) => currentStaffUserId(s.authState));
  const m = useNotificationToggle(userId, t);

  // Nudge to enable notifications only when Settings has an actionable next
  // step: `off` (supported-but-not-subscribed) or `needs-install` (iOS PWA).
  const showDot = m.view === 'off' || m.view === 'needs-install';

  return (
    <Pressable
      onPress={() => navigation.navigate('Settings')}
      testID={testID ?? 'staff-settings-gear'}
      accessibilityRole="button"
      accessibilityLabel={
        showDot
          ? t('chrome.settings.gearAriaNotifOff')
          : t('chrome.settings.gearAria')
      }
      style={({ pressed }) => [
        styles.gear,
        pressed ? { backgroundColor: c.surfaceAlt } : null,
      ]}
    >
      <View style={styles.iconWrap}>
        <Ionicons name="settings-outline" size={22} color={c.textSecondary} />
        {showDot ? (
          <View
            testID="staff-settings-notif-dot"
            style={[styles.dot, { backgroundColor: c.error, borderColor: c.bg }]}
          />
        ) : null}
      </View>
      <Text style={[styles.label, { color: c.textSecondary }]} numberOfLines={1}>
        {t('chrome.settings.gearLabel')}
      </Text>
    </Pressable>
  );
}

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  gear: {
    minHeight: T.touchTarget.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.xs,
    paddingHorizontal: T.spacing.sm,
    borderRadius: T.radius.sm,
  },
  iconWrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 9,
    height: 9,
    borderRadius: 999,
    borderWidth: 1,
  },
  label: {
    fontSize: T.typography.body,
    fontWeight: T.typography.medium,
  },
});

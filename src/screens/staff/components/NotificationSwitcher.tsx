// src/screens/staff/components/NotificationSwitcher.tsx — per-device Web Push
// enable/disable pill for the staff PWA.
//
// Spec 118. Peer to LocaleSwitcher / ScaleSwitcher; mounts in the
// StorePicker header switcherRow. GENUINELY presentation-only: all the
// state/effect/handler logic lives in the shared `useNotificationToggle`
// hook (src/lib/useNotificationToggle.ts). This file differs from the admin
// NotificationToggle ONLY in theme tokens (staff dark palette) and the
// catalog the hook is bound to (`useI18n().t`), exactly like the two
// LocaleSwitchers.

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../theme';
import { currentStaffUserId, useStaffStore } from '../store/useStaffStore';
import { useI18n } from '../i18n';
import { useNotificationToggle } from '../../../lib/useNotificationToggle';
import { notificationLevel } from '../lib/notificationLevel';

type Props = {
  testID?: string;
};

export function NotificationSwitcher({ testID }: Props) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  const userId = useStaffStore((s) => currentStaffUserId(s.authState));

  const m = useNotificationToggle(userId, t);

  // Shared 3-level signal so the Settings pill matches the SettingsGear dot +
  // reminder banner: GREEN on, RED off. The `na` views keep the neutral
  // (transparent/secondary) styling — no colored state to imply an action.
  const level = notificationLevel(m.view);

  return (
    <View style={styles.wrap} testID={testID ?? 'staff-notification-switcher'}>
      <Pressable
        onPress={m.onPress}
        disabled={!m.interactive}
        accessibilityRole="switch"
        accessibilityState={{ checked: m.isOn, disabled: !m.interactive }}
        accessibilityLabel={m.aria}
        testID="staff-notification-toggle"
        style={({ pressed }) => [
          styles.pill,
          {
            borderColor: level === 'off' ? c.error : c.border,
            backgroundColor: m.isOn
              ? c.success
              : level === 'off'
                ? c.errorBg
                : pressed && m.interactive
                  ? c.surfaceAlt
                  : 'transparent',
            opacity: m.interactive ? 1 : 0.55,
          },
        ]}
      >
        <Text
          style={[
            styles.label,
            {
              color: m.isOn
                ? c.textOnPrimary
                : level === 'off'
                  ? c.error
                  : c.textSecondary,
              fontWeight: m.isOn ? T.typography.semibold : T.typography.medium,
            },
          ]}
          numberOfLines={1}
        >
          {m.label} · {m.stateText}
        </Text>
      </Pressable>
      {m.body ? (
        <Text style={[styles.body, { color: c.textSecondary }]}>{m.body}</Text>
      ) : null}
      {m.iosSteps ? (
        <Text style={[styles.body, { color: c.textTertiary }]}>{m.iosSteps}</Text>
      ) : null}
      {m.showRetry ? (
        <Pressable
          onPress={m.onRetry}
          accessibilityRole="button"
          accessibilityLabel={m.retryLabel}
          testID="staff-notification-retry"
        >
          <Text style={[styles.retry, { color: c.primary }]}>{m.retryLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (T: StaffTokens) =>
  StyleSheet.create({
    wrap: {
      alignItems: 'flex-end',
      gap: T.spacing.xs,
      maxWidth: 160,
    },
    pill: {
      minHeight: T.touchTarget.min,
      paddingHorizontal: T.spacing.md,
      borderWidth: 1,
      borderRadius: T.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    label: {
      fontSize: T.typography.caption,
    },
    body: {
      fontSize: T.typography.caption,
      textAlign: 'right',
    },
    retry: {
      fontSize: T.typography.caption,
      fontWeight: T.typography.semibold,
      textAlign: 'right',
    },
  });

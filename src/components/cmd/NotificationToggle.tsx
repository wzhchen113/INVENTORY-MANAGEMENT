// src/components/cmd/NotificationToggle.tsx
//
// Spec 118 — per-device Web Push enable/disable pill for the admin Cmd UI.
// Peer to LocaleSwitcher / ThemeToggle; mounts in ResponsiveCmdShell's
// railFooter. GENUINELY presentation-only: all the state/effect/handler
// logic lives in the shared `useNotificationToggle` hook
// (src/lib/useNotificationToggle.ts). This file differs from the staff
// NotificationSwitcher ONLY in theme tokens (Cmd palette + mono) and the
// catalog the hook is bound to (`useT()`), exactly like the two
// LocaleSwitchers.

import React from 'react';
import { TouchableOpacity, Text, View } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useT } from '../../hooks/useT';
import { useNotificationToggle } from '../../lib/useNotificationToggle';

export const NotificationToggle: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const userId = useStore((s) => s.currentUser?.id);

  const m = useNotificationToggle(userId, T);

  return (
    <View style={{ alignItems: 'center', gap: 3, maxWidth: 132 }}>
      <TouchableOpacity
        onPress={m.onPress}
        disabled={!m.interactive}
        activeOpacity={0.85}
        accessibilityRole="switch"
        accessibilityState={{ checked: m.isOn, disabled: !m.interactive }}
        accessibilityLabel={m.aria}
        style={{
          paddingHorizontal: 7,
          paddingVertical: 2,
          borderRadius: CmdRadius.xs,
          borderWidth: 1,
          borderColor: C.border,
          backgroundColor: m.isOn ? C.accent : C.panel2,
          opacity: m.interactive ? 1 : 0.55,
        }}
      >
        <Text
          style={{
            fontFamily: mono(500),
            fontSize: 9.5,
            color: m.isOn ? C.accentFg : C.fg2,
          }}
          numberOfLines={1}
        >
          {m.label} · {m.stateText}
        </Text>
      </TouchableOpacity>
      {m.body ? (
        <Text
          style={{
            fontFamily: mono(400),
            fontSize: 8.5,
            color: C.fg3,
            textAlign: 'center',
          }}
        >
          {m.body}
        </Text>
      ) : null}
      {m.iosSteps ? (
        <Text
          style={{
            fontFamily: mono(400),
            fontSize: 8.5,
            color: C.fg3,
            textAlign: 'center',
          }}
        >
          {m.iosSteps}
        </Text>
      ) : null}
      {m.showRetry ? (
        <TouchableOpacity
          onPress={m.onRetry}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={m.retryLabel}
        >
          <Text style={{ fontFamily: mono(500), fontSize: 8.5, color: C.accent }}>
            {m.retryLabel}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
};

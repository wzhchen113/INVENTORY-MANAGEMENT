// src/components/cmd/NotificationBlockedBanner.tsx
//
// Spec 142 §1b (AC-C2) — the phone relocation of the Web Push blocked / needs-
// install / retry copy. Before this spec that copy rendered inside the top app
// bar's trailing slot (a 132px multi-line pill), spilling over the fixed bar and
// its title — the exact defect the handoff's Hard Rule 5 forbids. On phone the
// bar now shows only a bell glyph (`NotificationToggle variant="bar"`) and this
// dismissible row renders BELOW the 52px bar, ABOVE the body.
//
// It consumes the SAME `useNotificationToggle(userId, T)` hook as the bell. The
// hook's cross-instance re-probe registry (useNotificationToggle.ts §26-38) is
// designed for exactly this — two concurrent mounts stay coherent after an
// enable/disable. Presentation-only, Cmd palette + PhoneType, no new tokens.

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, PhoneType } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useT } from '../../hooks/useT';
import { useNotificationToggle } from '../../lib/useNotificationToggle';

export const NotificationBlockedBanner: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const userId = useStore((s) => s.currentUser?.id);

  const m = useNotificationToggle(userId, T);

  // Identity of the current blocked message. A new/changed block re-arms the
  // banner (re-shows after a prior dismiss); a plain re-render does not.
  const dismissKey = `${m.body ?? ''}|${m.iosSteps ?? ''}|${m.showRetry ? '1' : '0'}`;
  const [dismissed, setDismissed] = React.useState(false);
  React.useEffect(() => {
    setDismissed(false);
  }, [dismissKey]);

  const hasCopy = !!(m.body || m.iosSteps || m.showRetry);
  if (!hasCopy || dismissed) return null;

  return (
    <View
      testID="notification-blocked-banner"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        backgroundColor: C.panel2,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        {m.body ? (
          <Text style={[PhoneType.body, { color: C.fg2 }]}>{m.body}</Text>
        ) : null}
        {m.iosSteps ? (
          <Text style={[PhoneType.body, { color: C.fg3 }]}>{m.iosSteps}</Text>
        ) : null}
        {m.showRetry ? (
          <TouchableOpacity
            onPress={m.onRetry}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={m.retryLabel}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.accent }}>
              {m.retryLabel}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <TouchableOpacity
        onPress={() => setDismissed(true)}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={T('common.closeAria')}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={{
          width: 44,
          height: 44,
          borderRadius: CmdRadius.sm,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>✕</Text>
      </TouchableOpacity>
    </View>
  );
};

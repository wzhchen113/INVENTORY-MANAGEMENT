// src/components/cmd/SessionLostBanner.tsx — Spec 152.
//
// The visible half of "a load found no session". `loadFromSupabase` bails
// BEFORE fetching when the probe says the session is gone (rather than
// replacing every slice with anon-empty reads), so the screen keeps showing
// real — but now frozen — data. Without this row the user has no way to tell
// stale-because-signed-out from genuinely-empty, which is precisely how the
// 2026-08-03 incident read as "all my data is gone".
//
// Mounted in all three ResponsiveCmdShell branches, below the title bar /
// top app bar and above the body — the NotificationBlockedBanner slot and
// shape (spec 142), which keeps the fixed 52px phone bar un-overlapped.
//
// Presentation only: dismissing hides the row, it does not assert the session
// came back. The next successful load clears `sessionLost` for real.

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, PhoneType } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useT } from '../../hooks/useT';

export const SessionLostBanner: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const sessionLost = useStore((s) => s.sessionLost);
  const dismissSessionLost = useStore((s) => s.dismissSessionLost);
  const handleSessionLost = useStore((s) => s.handleSessionLost);

  if (!sessionLost) return null;

  return (
    <View
      testID="session-lost-banner"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        backgroundColor: C.panel2,
        borderBottomWidth: 1,
        borderBottomColor: C.danger,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[PhoneType.body, { color: C.fg }]}>
          {T('chrome.sessionBanner.title')}
        </Text>
        <Text style={[PhoneType.body, { color: C.fg3 }]}>
          {T('chrome.sessionBanner.body')}
        </Text>
      </View>
      {/* Sign in — drops the dead in-memory session so RoleRouter renders the
          shared sign-in portal. Same action the auth watcher fires; exposed
          here for the window where no auth event ever arrives (storage cleared
          in another tab, a token that expired while the app was suspended). */}
      <TouchableOpacity
        testID="session-lost-banner-signin"
        onPress={() => handleSessionLost()}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={T('chrome.sessionBanner.action')}
        style={{
          minHeight: 44,
          justifyContent: 'center',
          paddingHorizontal: 10,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: C.borderStrong,
        }}
      >
        <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.accent }}>
          {T('chrome.sessionBanner.action')}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="session-lost-banner-dismiss"
        onPress={() => dismissSessionLost()}
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

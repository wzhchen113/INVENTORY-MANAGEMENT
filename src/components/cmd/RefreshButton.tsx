import React from 'react';
import { TouchableOpacity, Text, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useT } from '../../hooks/useT';

// Owner request (2026-07-22): one-press full app reload in the chrome so a new
// deploy (or stale data) never requires closing and reopening the website/PWA.
// A hard location.reload() re-fetches index.html from the host — the service
// worker is push-only (no fetch caching, see public/sw.js), so the reload
// always picks up the latest hashed bundle AND re-fetches all data.
// Web-only: "reload the page" has no native equivalent, so render nothing
// there (mirrors the LoadingBar web-only pattern).
export const RefreshButton: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  if (Platform.OS !== 'web') return null;
  return (
    <TouchableOpacity
      testID="chrome-refresh-app"
      onPress={() => window.location.reload()}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={T('chrome.refreshApp.aria')}
      style={{
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: CmdRadius.xs,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.panel2,
      }}
    >
      <Text style={{ fontFamily: mono(500), fontSize: 9.5, color: C.fg2 }}>
        {T('chrome.refreshApp.label')}
      </Text>
    </TouchableOpacity>
  );
};

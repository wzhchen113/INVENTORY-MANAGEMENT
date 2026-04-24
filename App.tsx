// App.tsx
import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Toast from 'react-native-toast-message';
import AppNavigator from './src/navigation/AppNavigator';
import { useColors } from './src/theme/colors';
import { useStore } from './src/store/useStore';
import { getSession } from './src/lib/auth';
import { supabase } from './src/lib/supabase';
import { registerServiceWorker, ensureManifestLinked } from './src/lib/webPush';

/**
 * DEV-only: accept `?session=<url-encoded-JSON>` on boot so an automated
 * test can hand us a minted session instead of walking through the UI
 * login. JSON must have `{ access_token, refresh_token }`. Strips the
 * param from the URL afterwards so the session isn't left in history or
 * referrer headers. Gated by __DEV__ — Metro/Expo strips this branch
 * from production bundles entirely, so there's no way to trigger it
 * against the deployed app.
 *
 * Usage:
 *   const s = await mintSession();  // service-role -> generate_link -> verify
 *   location.href = `http://localhost:8081/?session=${encodeURIComponent(JSON.stringify(s))}`;
 */
async function hydrateDevSessionFromUrl(): Promise<void> {
  if (!__DEV__ || Platform.OS !== 'web') return;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('session');
    if (!raw) return;
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (parsed?.access_token && parsed?.refresh_token) {
      await supabase.auth.setSession({
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
      });
    }
    params.delete('session');
    const remaining = params.toString();
    window.history.replaceState(
      {},
      '',
      window.location.pathname + (remaining ? `?${remaining}` : ''),
    );
  } catch (e) {
    // Best-effort — bad param should not crash the app, just log.
    console.warn('[dev] ?session= restore failed:', e);
  }
}

// Only import and configure notifications on native platforms
if (Platform.OS !== 'web') {
  const Notifications = require('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

export default function App() {
  const C = useColors();
  const login = useStore((s) => s.login);

  // Restore session on app start
  useEffect(() => {
    (async () => {
      // Must run BEFORE getSession so the injected session is what getSession sees.
      await hydrateDevSessionFromUrl();
      const result = await getSession();
      if (result.user) {
        login(result.user);
      }
    })();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      registerForPushNotifications();
    } else {
      // Web: link the PWA manifest and register the service worker.
      // Permission + subscription happen on user gesture via the EOD screen banner.
      ensureManifestLinked();
      registerServiceWorker();
    }
  }, []);

  // Set HTML body background for overscroll coverage on web
  useEffect(() => {
    if (Platform.OS === 'web') {
      document.documentElement.style.backgroundColor = C.bgTertiary;
      document.body.style.backgroundColor = C.bgTertiary;
    }
  }, [C.bgTertiary]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <AppNavigator />
        <Toast />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

async function registerForPushNotifications() {
  try {
    const Notifications = require('expo-notifications');
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      console.log('Push notification permission not granted');
    }
  } catch (e) {
    console.log('Notifications setup:', e);
  }
}

// App.tsx
import React, { useEffect, useLayoutEffect } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Toast from 'react-native-toast-message';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AppNavigator from './src/navigation/AppNavigator';
import { useColors } from './src/theme/colors';
import { useStore } from './src/store/useStore';
import { getSession } from './src/lib/auth';
import { supabase } from './src/lib/supabase';
import { registerServiceWorker, ensureManifestLinked, ensureAppleTouchIconLinked } from './src/lib/webPush';
import { NEW_UI } from './src/lib/featureFlags';
import CmdAtomsPreview from './src/screens/dev/CmdAtomsPreview';
import { useFonts } from 'expo-font';
import {
  InterTight_400Regular,
  InterTight_500Medium,
  InterTight_600SemiBold,
  InterTight_700Bold,
} from '@expo-google-fonts/inter-tight';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';

const DARK_MODE_KEY = 'darkMode';

/**
 * Read the cached dark-mode flag from local storage and apply it to the
 * Zustand store BEFORE the first paint so the user doesn't see a flash of
 * the wrong theme. Called from a useLayoutEffect with `Platform.OS === 'web'`
 * so it's a synchronous localStorage hit; native is a quick AsyncStorage
 * await tucked inside the same useEffect that runs getSession.
 */
function readCachedDarkModeSync(): boolean | null {
  if (Platform.OS !== 'web') return null;
  try {
    const v = window.localStorage.getItem(DARK_MODE_KEY);
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch { /* best-effort */ }
  return null;
}

async function readCachedDarkModeAsync(): Promise<boolean | null> {
  if (Platform.OS === 'web') return readCachedDarkModeSync();
  try {
    const v = await AsyncStorage.getItem(DARK_MODE_KEY);
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch { /* best-effort */ }
  return null;
}

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
  const setDarkMode = useStore((s) => s.setDarkMode);

  // Hold first paint until Inter Tight + JetBrains Mono are registered, so
  // numeric values don't flash in the system font then snap to mono.
  const [fontsLoaded] = useFonts({
    InterTight_400Regular,
    InterTight_500Medium,
    InterTight_600SemiBold,
    InterTight_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
    JetBrainsMono_700Bold,
  });

  // Synchronous theme restore at first paint (web only). Native falls through
  // to the async restore in the session-restore effect below.
  useLayoutEffect(() => {
    const cached = readCachedDarkModeSync();
    if (cached !== null) setDarkMode(cached);
  }, []);

  // Restore session on app start
  useEffect(() => {
    (async () => {
      // Must run BEFORE getSession so the injected session is what getSession sees.
      await hydrateDevSessionFromUrl();
      // Native — pick up the cached flag if useLayoutEffect didn't already.
      if (Platform.OS !== 'web') {
        const cached = await readCachedDarkModeAsync();
        if (cached !== null) setDarkMode(cached);
      }
      const result = await getSession();
      if (result.user) {
        login(result.user);
        // DB is the cross-device source of truth — overrides the cached value
        // if they differ. Only applies when the user is actually logged in.
        if (typeof result.darkMode === 'boolean') setDarkMode(result.darkMode);
      }
    })();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      registerForPushNotifications();
    } else {
      // Web: link the PWA manifest + apple-touch-icon and register the SW.
      // Permission + subscription happen on user gesture via the EOD screen banner.
      ensureManifestLinked();
      ensureAppleTouchIconLinked();
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

  if (!fontsLoaded) return null;

  // Phase 2 dev preview gate. Phase 5 will swap this for `<CmdNavigator />`.
  const showCmdPreview = __DEV__ && NEW_UI;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        {showCmdPreview ? <CmdAtomsPreview /> : <AppNavigator />}
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

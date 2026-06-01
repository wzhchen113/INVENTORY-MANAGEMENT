// App.tsx
import React, { useEffect, useLayoutEffect } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Toast from 'react-native-toast-message';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCmdColors } from './src/theme/colors';
import { useStore, ACTIVE_BRAND_KEY, LOCALE_KEY } from './src/store/useStore';
import { getSession } from './src/lib/auth';
import { supabase } from './src/lib/supabase';
import { registerServiceWorker, ensureManifestLinked, ensureAppleTouchIconLinked } from './src/lib/webPush';
import RoleRouter from './src/navigation/RoleRouter';
import RecoveryGate from './src/navigation/RecoveryGate';
import { useStaffStore } from './src/screens/staff/store/useStaffStore';
import { checkAuthGate } from './src/lib/authGate';
import { hydrateQueue, migrateQueueIfNeeded, readActiveStoreId, writeActiveStoreId } from './src/screens/staff/lib/eodQueue';
import { notifyBackendError as notifyStaffBackendError } from './src/screens/staff/lib/notifyBackendError';
import { t as tStaff } from './src/screens/staff/i18n';
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

async function readCachedActiveBrandAsync(): Promise<string | null> {
  try {
    if (Platform.OS === 'web') {
      const v = window.localStorage.getItem(ACTIVE_BRAND_KEY);
      return v && v.length > 0 ? v : null;
    }
    const v = await AsyncStorage.getItem(ACTIVE_BRAND_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

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

// Spec 038 — synchronous web-only locale restore. Mirrors
// readCachedDarkModeSync. Returns null when no cached value (so a
// fresh session falls through to the 'en' default).
function readCachedLocaleSync(): 'en' | 'es' | 'zh-CN' | null {
  if (Platform.OS !== 'web') return null;
  try {
    const v = window.localStorage.getItem(LOCALE_KEY);
    if (v === 'en' || v === 'es' || v === 'zh-CN') return v;
  } catch { /* best-effort */ }
  return null;
}

async function readCachedLocaleAsync(): Promise<'en' | 'es' | 'zh-CN' | null> {
  if (Platform.OS === 'web') return readCachedLocaleSync();
  try {
    const v = await AsyncStorage.getItem(LOCALE_KEY);
    if (v === 'en' || v === 'es' || v === 'zh-CN') return v;
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
  const Cmd = useCmdColors();
  // Use the Command palette's `bg` for the html/body background so
  // overscroll on web matches the Cmd UI chrome.
  const bodyBg = Cmd.bg;
  const login = useStore((s) => s.login);
  const setDarkMode = useStore((s) => s.setDarkMode);
  const hydrateSidebarLayoutOverride = useStore((s) => s.hydrateSidebarLayoutOverride);
  const hydrateLocale = useStore((s) => s.hydrateLocale);
  const hydrateBrand = useStore((s) => s.hydrateBrand);

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
    // Spec 038 — synchronous locale restore (web). Mirrors the dark-mode
    // shape so the user doesn't see a flash of English chrome on a
    // Spanish/Chinese session reload.
    const cachedLocale = readCachedLocaleSync();
    if (cachedLocale !== null) hydrateLocale(cachedLocale);
  }, []);

  // Restore session on app start.
  //
  // Spec 063 §6 / R4 — single getSession() call branches on
  // `result.user.role` so cold-start fires EITHER the admin restore
  // path OR the staff restore path, never both. The admin restore
  // hydrates dark mode + locale + sidebar layout + brand; the staff
  // restore runs `checkAuthGate` + seeds `useStaffStore`. Both paths
  // tolerate `result.user === undefined` (signed-out cold start).
  useEffect(() => {
    (async () => {
      // Spec 063 — best-effort staff queue hydration. Runs
      // unconditionally because the queue is keyed in AsyncStorage /
      // localStorage and tolerates "no signed-in user" gracefully
      // (returns [] when storage is empty). Admins simply hold an empty
      // mirror; staff get their pending counts back.
      try {
        await migrateQueueIfNeeded();
        const items = await hydrateQueue();
        useStaffStore.getState().hydrateQueueFromStorage(items);
      } catch (err) {
        notifyStaffBackendError('staff queue hydrate', err);
      }

      // Must run BEFORE getSession so the injected session is what getSession sees.
      await hydrateDevSessionFromUrl();
      // Native — pick up the cached flag if useLayoutEffect didn't already.
      if (Platform.OS !== 'web') {
        const cached = await readCachedDarkModeAsync();
        if (cached !== null) setDarkMode(cached);
        // Spec 038 — native async locale restore.
        const cachedLocale = await readCachedLocaleAsync();
        if (cachedLocale !== null) hydrateLocale(cachedLocale);
      }
      const result = await getSession();
      if (!result.user) return;

      // ─── Spec 063 §6 / R4 — staff cold-start branch ────────────
      if (result.user.role === 'user') {
        const gate = await checkAuthGate(result.user.id, {
          notStaff: tStaff('auth.error.notStaff'),
          noStores: tStaff('auth.error.noStores'),
          generic: tStaff('auth.error.generic'),
        });
        if (!gate.ok) {
          // checkAuthGate already invoked signOut for not-staff / no-stores.
          // Surface a toast on the same paths used by SignIn /
          // sessionRestore (spec 062 §B3). The 'error' branch leaves the
          // session intact so the user can retry.
          if (gate.reason === 'not-staff' || gate.reason === 'no-stores') {
            Toast.show({
              type: 'error',
              text1: gate.message,
              position: 'bottom',
            });
          }
          useStaffStore.getState().setAuthState({ kind: 'signed-out' });
          return;
        }
        // Gate passed — restore active store from persisted preference
        // (mirrors imr-staff RootStack.restoreSession behaviour).
        const persisted = await readActiveStoreId();
        const matched = persisted ? gate.stores.find((s) => s.storeId === persisted) : null;
        if (matched) {
          useStaffStore.getState().setActiveStore({ id: matched.storeId, name: matched.storeName });
        } else if (gate.stores.length === 1) {
          const only = gate.stores[0];
          useStaffStore.getState().setActiveStore({ id: only.storeId, name: only.storeName });
        } else {
          await writeActiveStoreId(null).catch(() => {});
          useStaffStore.getState().setActiveStore(null);
        }
        useStaffStore.getState().setAuthState({
          kind: 'signed-in',
          userId: result.user.id,
          stores: gate.stores,
        });
        return;
      }

      // ─── Admin cold-start branch — existing behaviour ─────────
      // Spec 012b — read the cached super-admin active-brand BEFORE
      // login() runs (login clears the key by design so a fresh
      // sign-in starts in "All brands" mode). Session-restore is the
      // tab-reload case where we DO want to keep the user where they
      // were. Re-apply after login completes.
      const cachedActiveBrand =
        result.user.role === 'super_admin' ? await readCachedActiveBrandAsync() : null;

      // Spec 044 — seed the `brand` slice BEFORE login() so the TitleBar
      // prefix renders the correct `<INITIALS>://` on first paint. Order
      // matters: login() calls setCurrentStore(userStore) which triggers
      // loadFromSupabase ~50-200 ms later; the async refresh overwrites
      // with the same row (visually a no-op), but the synchronous hydrate
      // here is what eliminates the `inv://` flash. `null` is fine for
      // super_admin (no brand_id) and for the soft-deleted-brand edge
      // case — TitleBar falls back to `inv://`.
      // result.brand: undefined when signed out; null for super_admin /
      // soft-deleted brand / RLS-denied embed; object for the happy path.
      hydrateBrand(result.brand ?? null);

      login(result.user);
      // DB is the cross-device source of truth — overrides the cached value
      // if they differ. Only applies when the user is actually logged in.
      if (typeof result.darkMode === 'boolean') setDarkMode(result.darkMode);
      // Spec 038 — DB-stored locale overrides the cached value if they
      // differ. hydrateLocale is the no-persist setter (mirrors
      // setDarkMode) so login doesn't round-trip the just-read value
      // back to the column.
      if (result.locale) hydrateLocale(result.locale);
      // Spec 008: hydrate the per-user sidebar override from
      // profiles.sidebar_layout. `null` = uncustomized; the hydrator
      // accepts null and stores it as the "use default" sentinel.
      // We use the no-persist hydrator (mirrors setDarkMode) so login
      // does NOT round-trip the just-read value back to the column.
      // The persisting setSidebarLayoutOverride is reserved for the
      // edit-mode DONE / reset paths.
      if (result.sidebarLayout !== undefined) {
        hydrateSidebarLayoutOverride(result.sidebarLayout);
      }
      // Spec 012b — re-apply the cached active brand. setCurrentBrandId
      // re-persists, so the localStorage stays in sync with the active
      // state.
      if (cachedActiveBrand) {
        useStore.getState().setCurrentBrandId(cachedActiveBrand);
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
      document.documentElement.style.backgroundColor = bodyBg;
      document.body.style.backgroundColor = bodyBg;
    }
  }, [bodyBg]);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: bodyBg }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        {/* Spec 085 — RecoveryGate inspects the launch URL on boot and renders
            the set-new-password screen INSTEAD of RoleRouter when an admin-
            initiated recovery link is opened. It is a sibling render branch
            OUTSIDE RoleRouter's single NavigationContainer (no react-navigation
            `linking` is enabled). On a non-recovery boot it renders RoleRouter
            unchanged. */}
        <RecoveryGate>
          <RoleRouter />
        </RecoveryGate>
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

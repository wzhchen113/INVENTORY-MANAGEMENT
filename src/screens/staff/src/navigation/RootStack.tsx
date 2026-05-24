// src/navigation/RootStack.tsx — React Navigation 6 stack with auth gate.
//
// Spec 062 §6 — conditional rendering of three top-level branches based
// on authState + activeStore:
//
//   authState.kind === 'restoring' / 'idle' / 'signing-in' / 'gating'
//     → minimal splash loader.
//   authState.kind === 'signed-out'
//     → SignIn screen.
//   authState.kind === 'signed-in' AND activeStore is null AND stores.length > 1
//     → StorePicker.
//   authState.kind === 'signed-in' AND activeStore is set
//     → EODCount.
//   authState.kind === 'signed-in' AND activeStore is null AND stores.length === 1
//     → auto-select sole store (handled inside SignIn / restore flow).
//
// On cold start, we read supabase.auth.getSession(); if a session
// exists, re-run the gate (profiles.role + user_stores) because either
// could have changed since last launch (per §2 auth-gate re-run rule).

import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Toast from 'react-native-toast-message';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { SignIn } from '../screens/SignIn';
import { StorePicker } from '../screens/StorePicker';
import { EODCount } from '../screens/EODCount';
import { supabase } from '../lib/supabase';
import { useStore } from '../store/useStore';
import { readActiveStoreId, writeActiveStoreId } from '../lib/eodQueue';
import { checkAuthGate } from '../lib/authGate';
import { t } from '../i18n';
import { colors, spacing, typography } from '../theme';
import type { UserStore } from '../lib/types';

const Stack = createStackNavigator();

/** Cold-start session restore.
 *
 * Reads the cached session (if any), then routes through `checkAuthGate`
 * for the shared role + user_stores check (the same logic SignIn runs
 * post-sign-in). Returns a tagged union so the caller can map each
 * outcome to the right UX (Toast.show + setAuthState transition).
 */
async function restoreSession(): Promise<
  | { ok: true; userId: string; stores: UserStore[] }
  | { ok: false; reason: 'no-session' | 'not-staff' | 'no-stores' | 'error'; message?: string }
> {
  const { data, error } = await supabase.auth.getSession();
  if (error) return { ok: false, reason: 'error', message: error.message };
  const session = data.session;
  if (!session || !session.user) return { ok: false, reason: 'no-session' };
  const userId = session.user.id;

  const gate = await checkAuthGate(userId, {
    notStaff: t('auth.error.notStaff'),
    noStores: t('auth.error.noStores'),
    generic: t('auth.error.generic'),
  });
  if (!gate.ok) {
    if (gate.reason === 'not-staff') return { ok: false, reason: 'not-staff', message: gate.message };
    if (gate.reason === 'no-stores') return { ok: false, reason: 'no-stores', message: gate.message };
    return { ok: false, reason: 'error', message: gate.message };
  }
  return { ok: true, userId, stores: gate.stores };
}

function Splash() {
  return (
    <View style={styles.splash}>
      <Text style={styles.splashTitle}>I.M.R Staff</Text>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

export function RootStack() {
  const authState = useStore((s) => s.authState);
  const activeStore = useStore((s) => s.activeStore);
  const setAuthState = useStore((s) => s.setAuthState);
  const setActiveStore = useStore((s) => s.setActiveStore);

  // ─── Cold-start restore on first mount ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    setAuthState({ kind: 'restoring' });
    restoreSession()
      .then(async (result) => {
        if (cancelled) return;
        if (!result.ok) {
          // Surface the gate-failure message via Toast.show directly —
          // the 'signed-out' state is plain; SignIn does not read any
          // toast field (spec 062 fix-pass 2). 'no-session' is the
          // expected cold-start path with no prior login and stays
          // silent.
          if (result.reason === 'not-staff') {
            Toast.show({
              type: 'error',
              text1: t('auth.error.notStaff'),
              position: 'bottom',
            });
          } else if (result.reason === 'no-stores') {
            Toast.show({
              type: 'error',
              text1: t('auth.error.noStores'),
              position: 'bottom',
            });
          }
          setAuthState({ kind: 'signed-out' });
          return;
        }
        // Restore active store from AsyncStorage
        const persistedStoreId = await readActiveStoreId();
        const matched = persistedStoreId
          ? result.stores.find((s) => s.storeId === persistedStoreId)
          : undefined;
        if (matched) {
          setActiveStore({ id: matched.storeId, name: matched.storeName });
        } else if (result.stores.length === 1) {
          const only = result.stores[0];
          setActiveStore({ id: only.storeId, name: only.storeName });
        } else {
          await writeActiveStoreId(null).catch(() => {});
          setActiveStore(null);
        }
        setAuthState({
          kind: 'signed-in',
          userId: result.userId,
          stores: result.stores,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setAuthState({ kind: 'signed-out' });
      });
    return () => {
      cancelled = true;
    };
  }, [setAuthState, setActiveStore]);

  // ─── Render branch ──────────────────────────────────────────────
  let content: React.ReactElement;
  if (
    authState.kind === 'idle' ||
    authState.kind === 'restoring' ||
    authState.kind === 'signing-in' ||
    authState.kind === 'gating'
  ) {
    content = (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Splash" component={Splash} />
      </Stack.Navigator>
    );
  } else if (authState.kind === 'signed-out') {
    content = (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="SignIn" component={SignIn} />
      </Stack.Navigator>
    );
  } else if (activeStore) {
    // signed-in with an active store — EOD screen.
    content = (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="EODCount" component={EODCount} />
      </Stack.Navigator>
    );
  } else {
    // signed-in without an active store — picker.
    content = (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="StorePicker" component={StorePicker} />
      </Stack.Navigator>
    );
  }

  return <NavigationContainer>{content}</NavigationContainer>;
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  splashTitle: {
    fontSize: typography.headline,
    fontWeight: typography.bold,
    color: colors.text,
  },
});

// src/screens/SignIn.tsx — email + password sign-in.
//
// Spec 062 §B3 / §2 — after successful supabase.auth.signInWithPassword:
//   1. Fetch profiles.role. If !== 'user' → signOut + toast.
//   2. Fetch user_stores. If 0 rows → signOut + toast.
//   3. Persist activeStore from prior session (if still in user_stores).
//   4. Transition authState to { kind: 'signed-in', userId, stores }.
//
// Gate logic is shared with RootStack.restoreSession via
// `checkAuthGate` in src/lib/authGate.ts (single source of truth).

import { useCallback, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import Toast from 'react-native-toast-message';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { supabase } from '../lib/supabase';
import { useStore } from '../store/useStore';
import { readActiveStoreId, writeActiveStoreId } from '../lib/eodQueue';
import { checkAuthGate } from '../lib/authGate';
import { t } from '../i18n';
import { colors, spacing, typography } from '../theme';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const setAuthState = useStore((s) => s.setAuthState);
  const setActiveStore = useStore((s) => s.setActiveStore);

  const onSubmit = useCallback(async () => {
    if (!email || !password || submitting) return;
    Keyboard.dismiss();
    setSubmitting(true);
    setAuthState({ kind: 'signing-in' });
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error || !data.user) {
        Toast.show({
          type: 'error',
          text1: t('auth.error.invalidCreds'),
          position: 'bottom',
        });
        setAuthState({ kind: 'signed-out' });
        return;
      }
      // Run the gate (shared with RootStack.restoreSession)
      setAuthState({ kind: 'gating' });
      const result = await checkAuthGate(data.user.id, {
        notStaff: t('auth.error.notStaff'),
        noStores: t('auth.error.noStores'),
        generic: t('auth.error.generic'),
      });
      if (!result.ok) {
        // checkAuthGate already invoked signOut for not-staff / no-stores;
        // the 'error' branch leaves the session intact so the user can
        // retry. Either way, surface the message + return to SignIn.
        Toast.show({
          type: 'error',
          text1: result.message,
          position: 'bottom',
        });
        setAuthState({ kind: 'signed-out' });
        return;
      }
      // Gate passed — restore active store from persisted preference
      const persistedStoreId = await readActiveStoreId();
      const matched = persistedStoreId
        ? result.stores.find((s) => s.storeId === persistedStoreId)
        : undefined;
      if (matched) {
        setActiveStore({ id: matched.storeId, name: matched.storeName });
      } else if (result.stores.length === 1) {
        // Auto-select sole store
        const only = result.stores[0];
        setActiveStore({ id: only.storeId, name: only.storeName });
      } else {
        // >1 stores AND no valid persisted — clear so picker fires
        await writeActiveStoreId(null);
        setActiveStore(null);
      }
      setAuthState({ kind: 'signed-in', userId: data.user.id, stores: result.stores });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('auth.error.generic');
      Toast.show({ type: 'error', text1: msg, position: 'bottom' });
      setAuthState({ kind: 'signed-out' });
    } finally {
      setSubmitting(false);
    }
  }, [email, password, submitting, setAuthState, setActiveStore]);

  return (
    <Pressable
      style={styles.container}
      onPress={Keyboard.dismiss}
      accessibilityRole="none"
    >
      <View style={styles.inner}>
        <Text style={styles.title} accessibilityRole="header">
          {t('auth.signIn.subtitle')}
        </Text>
        <Text style={styles.subtitle}>{t('auth.signIn.title')}</Text>

        <View style={styles.formField}>
          <Input
            label={t('auth.signIn.email')}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholder="staff@example.com"
            testID="sign-in-email"
            editable={!submitting}
          />
        </View>
        <View style={styles.formField}>
          <Input
            label={t('auth.signIn.password')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="password"
            textContentType="password"
            placeholder="••••••••"
            testID="sign-in-password"
            editable={!submitting}
            onSubmitEditing={onSubmit}
          />
        </View>

        <View style={styles.submitWrap}>
          <Button
            label={submitting ? t('auth.signIn.submitting') : t('auth.signIn.submit')}
            onPress={onSubmit}
            disabled={!email || !password}
            loading={submitting}
            testID="sign-in-submit"
          />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  inner: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  title: {
    fontSize: typography.display,
    fontWeight: typography.bold,
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xxl,
  },
  formField: {
    marginBottom: spacing.lg,
  },
  submitWrap: {
    marginTop: spacing.sm,
  },
});

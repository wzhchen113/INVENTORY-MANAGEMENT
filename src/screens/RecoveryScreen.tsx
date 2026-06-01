// src/screens/RecoveryScreen.tsx — Spec 085.
//
// The set-a-new-password landing screen for the admin-initiated password
// reset. A SHARED PRE-AUTH surface (peer to LoginScreen.tsx) — NOT a Cmd
// section, NOT a staff screen. Rendered by RecoveryGate OUTSIDE RoleRouter's
// single <NavigationContainer>, so it cannot use react-navigation; it routes
// back to the sign-in portal by tearing down the gate via the `onExit`
// callback (which flips the gate back to the normal shell, where AdminStack
// renders LoginScreen for a null currentUser).
//
// Self-contained: uses useColors() for theming and owns its own 4-state
// machine; does NOT touch useStore (the recovery flow is pre-auth and has no
// app-table mutation — updateUser is a one-shot GoTrue call whose result
// drives local state directly; the optimistic-then-revert pattern does not
// apply). See spec 085 §6 / §8.

import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { WebScrollView } from '../components/WebScrollView';
import { supabase } from '../lib/supabase';
import { establishRecoverySession } from '../lib/recoveryRedirect';
import type { RecoveryParse } from '../lib/recoveryUrl';
import { Colors, useColors, Spacing, Radius, FontSize, Shadow } from '../theme/colors';

// Match Supabase's recommended default minimum (the prod project should set
// minimum_password_length >= 8; the local stack defaults to 6 but accepting a
// stricter client-side floor is always safe). Surfaced as a field-level error
// BEFORE updateUser is called.
const MIN_PASSWORD_LENGTH = 8;

type ScreenState = 'exchanging' | 'form' | 'success' | 'error';

interface RecoveryScreenProps {
  parse: RecoveryParse;
  /** Tear down the recovery gate and return to the normal shell (where
   *  RoleRouter → AdminStack renders LoginScreen for a signed-out session).
   *  Called from the success + error CTAs. */
  onExit: () => void;
}

export default function RecoveryScreen({ parse, onExit }: RecoveryScreenProps) {
  const C = useColors();

  // If the URL is already an error (e.g. otp_expired), skip straight to the
  // friendly error state — there is nothing to exchange.
  const [state, setState] = useState<ScreenState>(
    parse.kind === 'error' ? 'error' : 'exchanging',
  );

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // On mount, establish the recovery session for any recovery-kind URL. The
  // token_hash verifyOtp (chosen flow) / PKCE exchange is a single awaited call.
  useEffect(() => {
    let cancelled = false;
    if (
      parse.kind === 'recovery-token-hash' ||
      parse.kind === 'recovery' ||
      parse.kind === 'recovery-implicit'
    ) {
      (async () => {
        const result = await establishRecoverySession(parse);
        if (cancelled) return;
        if (result.ok) {
          setState('form');
        } else {
          // The friendly error screen shows generic copy (security-auditor:
          // do not surface raw Supabase error text). result.error is logged
          // by neither path — intentionally dropped.
          setState('error');
        }
      })();
    }
    return () => {
      cancelled = true;
    };
    // parse is stable for the lifetime of this mount (gate re-keys on URL).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async () => {
    // Validation BEFORE updateUser (criteria: length + confirm-match).
    if (!password) {
      setFieldError('Please enter a new password');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      setFieldError('Passwords do not match');
      return;
    }
    setFieldError('');
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        // Stay on the form; show the Supabase message inline (e.g. "password
        // should be different from the old password"). Do NOT navigate.
        setFieldError(error.message);
        return;
      }
      setState('success');
    } catch (e: any) {
      setFieldError(e?.message || 'Failed to update password');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSuccessContinue = async () => {
    // Drop the recovery-grant session so the user must sign in fresh with the
    // new password — and so the recovery session does not auto-log them into
    // the admin/staff shell. Then tear down the gate to reach LoginScreen.
    try {
      await supabase.auth.signOut();
    } catch {
      // best-effort — exiting the gate still lands on LoginScreen.
    }
    onExit();
  };

  // ── exchanging ────────────────────────────────────────────────
  if (state === 'exchanging') {
    return (
      <Shell C={C}>
        <View style={[styles.card, { backgroundColor: C.bgPrimary }]} testID="recovery-exchanging">
          <ActivityIndicator size="small" color={C.textPrimary} />
          <Text style={[styles.subtleText, { color: C.textSecondary, marginTop: Spacing.md }]}>
            Verifying your reset link…
          </Text>
        </View>
      </Shell>
    );
  }

  // ── error (expired / invalid link) ────────────────────────────
  if (state === 'error') {
    return (
      <Shell C={C}>
        <View style={[styles.card, { backgroundColor: C.bgPrimary }]} testID="recovery-error">
          <Text style={[styles.formTitle, { color: C.textPrimary }]}>Reset link expired</Text>
          <View style={[styles.errorBox, { backgroundColor: C.dangerBg }]}>
            <Text style={[styles.errorText, { color: C.danger }]}>
              This reset link is invalid or has expired.
            </Text>
          </View>
          <Text style={[styles.subtleText, { color: C.textSecondary }]}>
            Password reset links can only be used once and expire after a short
            time. Please ask your administrator to send you a new reset link.
          </Text>
          <TouchableOpacity
            testID="recovery-error-back"
            style={[styles.primaryBtn, { backgroundColor: C.textPrimary }]}
            onPress={onExit}
          >
            <Text style={[styles.primaryBtnText, { color: C.bgPrimary }]}>Back to sign-in</Text>
          </TouchableOpacity>
        </View>
      </Shell>
    );
  }

  // ── success ───────────────────────────────────────────────────
  if (state === 'success') {
    return (
      <Shell C={C}>
        <View style={[styles.card, { backgroundColor: C.bgPrimary }]} testID="recovery-success">
          <Text style={[styles.formTitle, { color: C.textPrimary }]}>Password updated</Text>
          <View style={[styles.successBox, { backgroundColor: C.successBg }]}>
            <Text style={[styles.successText, { color: C.success }]}>
              Your password has been changed.
            </Text>
          </View>
          <Text style={[styles.subtleText, { color: C.textSecondary }]}>
            You can now sign in with your new password.
          </Text>
          <TouchableOpacity
            testID="recovery-success-continue"
            style={[styles.primaryBtn, { backgroundColor: C.textPrimary }]}
            onPress={handleSuccessContinue}
          >
            <Text style={[styles.primaryBtnText, { color: C.bgPrimary }]}>Continue to sign-in</Text>
          </TouchableOpacity>
        </View>
      </Shell>
    );
  }

  // ── form (set new password) ───────────────────────────────────
  return (
    <Shell C={C}>
      <View style={[styles.card, { backgroundColor: C.bgPrimary }]} testID="recovery-form">
        <Text style={[styles.formTitle, { color: C.textPrimary }]}>Set a new password</Text>

        {fieldError ? (
          <View testID="recovery-field-error" style={[styles.errorBox, { backgroundColor: C.dangerBg }]}>
            <Text style={[styles.errorText, { color: C.danger }]}>{fieldError}</Text>
          </View>
        ) : null}

        <View style={styles.field}>
          <Text style={[styles.label, { color: C.textSecondary }]}>New password</Text>
          <TextInput
            testID="recovery-password"
            style={[styles.input, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={C.textTertiary}
            secureTextEntry
            autoCapitalize="none"
          />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: C.textSecondary }]}>Confirm new password</Text>
          <TextInput
            testID="recovery-confirm"
            style={[styles.input, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
            value={confirm}
            onChangeText={setConfirm}
            placeholder="••••••••"
            placeholderTextColor={C.textTertiary}
            secureTextEntry
            autoCapitalize="none"
          />
        </View>

        <TouchableOpacity
          testID="recovery-submit"
          style={[styles.primaryBtn, { backgroundColor: C.textPrimary }]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={C.white} />
          ) : (
            <Text style={[styles.primaryBtnText, { color: C.bgPrimary }]}>Update password</Text>
          )}
        </TouchableOpacity>
      </View>
    </Shell>
  );
}

/** Shared chrome wrapper so all four states share the centered card layout
 *  (mirrors LoginScreen's logo + card shell, minus the demo accounts). */
function Shell({ C, children }: { C: ReturnType<typeof useColors>; children: React.ReactNode }) {
  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: C.bgTertiary }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <WebScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" id="recovery-scroll">
        <View style={styles.logo}>
          <View style={[styles.logoIcon, { backgroundColor: C.textPrimary }]}>
            <Text style={styles.logoIconText}>I.M.R</Text>
          </View>
          <Text style={[styles.logoSub, { color: C.textSecondary }]}>Inventory Management for Restaurant</Text>
        </View>
        {children}
      </WebScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  scroll: { padding: Spacing.xl, paddingTop: 60 },
  logo: { alignItems: 'center', marginBottom: Spacing.xxxl },
  logoIcon: { width: 64, height: 64, borderRadius: 16, backgroundColor: Colors.textPrimary, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md },
  logoIconText: { fontSize: 18, fontWeight: '700', color: Colors.white, letterSpacing: -0.5 },
  logoSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4, textAlign: 'center' },
  card: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.xl, padding: Spacing.xl, marginBottom: Spacing.lg, ...Shadow.md },
  formTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary, marginBottom: Spacing.lg },
  errorBox: { backgroundColor: Colors.dangerBg, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md },
  errorText: { fontSize: FontSize.xs, color: Colors.danger },
  successBox: { backgroundColor: Colors.successBg, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md },
  successText: { fontSize: FontSize.xs, color: Colors.success },
  subtleText: { fontSize: FontSize.sm, lineHeight: 18 },
  field: { marginBottom: Spacing.md },
  label: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 5 },
  input: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  primaryBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.md },
  primaryBtnText: { color: Colors.bgPrimary, fontSize: FontSize.base, fontWeight: '600' },
});

// src/screens/RegisterScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { WebScrollView } from '../components/WebScrollView';
import { registerInvitedUser } from '../lib/auth';
import { Colors, useColors, Spacing, Radius, FontSize, Shadow } from '../theme/colors';

export default function RegisterScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const nav = useNavigation<any>();
  const C = useColors();

  const handleRegister = async () => {
    if (!email.trim()) { setError('Email is required'); return; }
    if (!password) { setError('Password is required'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }

    setError('');
    setLoading(true);
    try {
      const result = await registerInvitedUser(email.trim(), password, '');
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(true);
      }
    } catch (e: any) {
      setError(e.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <KeyboardAvoidingView style={[styles.container, { backgroundColor: C.bgTertiary }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <WebScrollView contentContainerStyle={styles.scroll} id="register-scroll">
          <View style={styles.logo}>
            <View style={[styles.logoIcon, { backgroundColor: C.textPrimary }]}>
              <Text style={styles.logoIconText}>2AM</Text>
            </View>
          </View>

          <View style={[styles.card, { backgroundColor: C.bgPrimary }]}>
            <Text style={[styles.formTitle, { color: C.success }]}>Registration successful!</Text>
            <Text style={[styles.successText, { color: C.textSecondary }]}>
              Your account has been created. You can now sign in with your email and password.
            </Text>
            <TouchableOpacity style={[styles.btn, { backgroundColor: C.textPrimary }]} onPress={() => nav.navigate('Login')}>
              <Text style={[styles.btnText, { color: C.bgPrimary }]}>Go to Sign in</Text>
            </TouchableOpacity>
          </View>
        </WebScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: C.bgTertiary }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <WebScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" id="register-scroll">
        <View style={styles.logo}>
          <View style={[styles.logoIcon, { backgroundColor: C.textPrimary }]}>
            <Text style={styles.logoIconText}>2AM</Text>
          </View>
          <Text style={[styles.logoTitle, { color: C.textPrimary }]}>2AM Inventory</Text>
          <Text style={[styles.logoSub, { color: C.textSecondary }]}>Create your account</Text>
        </View>

        <View style={[styles.card, { backgroundColor: C.bgPrimary }]}>
          <Text style={[styles.formTitle, { color: C.textPrimary }]}>Register</Text>
          <Text style={[styles.formSub, { color: C.textTertiary }]}>
            Enter the email address your invitation was sent to.
          </Text>

          {error ? (
            <View style={[styles.errorBox, { backgroundColor: C.dangerBg }]}>
              <Text style={[styles.errorText, { color: C.danger }]}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.field}>
            <Text style={[styles.label, { color: C.textSecondary }]}>Email address</Text>
            <TextInput
              style={[styles.input, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
              value={email}
              onChangeText={setEmail}
              placeholder="your@email.com"
              placeholderTextColor={C.textTertiary}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, { color: C.textSecondary }]}>Password</Text>
            <TextInput
              style={[styles.input, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
              value={password}
              onChangeText={setPassword}
              placeholder="Min 6 characters"
              placeholderTextColor={C.textTertiary}
              secureTextEntry
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, { color: C.textSecondary }]}>Confirm password</Text>
            <TextInput
              style={[styles.input, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Re-enter password"
              placeholderTextColor={C.textTertiary}
              secureTextEntry
            />
          </View>

          <TouchableOpacity style={[styles.btn, { backgroundColor: C.textPrimary }]} onPress={handleRegister} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color={C.bgPrimary} />
            ) : (
              <Text style={[styles.btnText, { color: C.bgPrimary }]}>Create account</Text>
            )}
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.linkRow} onPress={() => nav.navigate('Login')}>
          <Text style={[styles.linkText, { color: C.textTertiary }]}>Already have an account? </Text>
          <Text style={[styles.linkTextBold, { color: C.info }]}>Sign in</Text>
        </TouchableOpacity>
      </WebScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: Spacing.xl, paddingTop: 60 },
  logo: { alignItems: 'center', marginBottom: Spacing.xxxl },
  logoIcon: { width: 64, height: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md },
  logoIconText: { fontSize: 22, fontWeight: '700', color: Colors.white, letterSpacing: -0.5 },
  logoTitle: { fontSize: 22, fontWeight: '600' },
  logoSub: { fontSize: FontSize.sm, marginTop: 4 },
  card: { borderRadius: Radius.xl, padding: Spacing.xl, marginBottom: Spacing.lg, ...Shadow.md },
  formTitle: { fontSize: FontSize.lg, fontWeight: '600', marginBottom: Spacing.xs },
  formSub: { fontSize: FontSize.xs, marginBottom: Spacing.lg },
  successText: { fontSize: FontSize.sm, marginBottom: Spacing.lg, lineHeight: 20 },
  errorBox: { borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md },
  errorText: { fontSize: FontSize.xs },
  field: { marginBottom: Spacing.md },
  label: { fontSize: FontSize.xs, marginBottom: 5 },
  input: { borderWidth: 0.5, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base },
  btn: { borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.sm },
  btnText: { fontSize: FontSize.base, fontWeight: '600' },
  linkRow: { flexDirection: 'row', justifyContent: 'center', paddingVertical: Spacing.md },
  linkText: { fontSize: FontSize.sm },
  linkTextBold: { fontSize: FontSize.sm, fontWeight: '600' },
});

// src/screens/LoginScreen.tsx
import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { WebScrollView } from '../components/WebScrollView';
import { useStore } from '../store/useStore';
import { signIn } from '../lib/auth';
import { Colors, useColors, Spacing, Radius, FontSize, Shadow } from '../theme/colors';
import { USERS, STORES } from '../data/seed';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const login = useStore((s) => s.login);
  const nav = useNavigation<any>();
  const C = useColors();

  // Auto-navigate to Register if ?register=true in URL
  useEffect(() => {
    if (Platform.OS === 'web') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('register') === 'true') {
        nav.navigate('Register');
        // Clean up the URL
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
  }, []);

  const handleLogin = async () => {
    if (!email.trim()) {
      setError('Please enter your email address');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const result = await signIn(email.trim(), password);
      if (result.error) {
        setError(result.error);
      } else if (result.user) {
        login(result.user);
      }
    } catch (e: any) {
      setError(e.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  // Demo quick-login uses seed data for offline development
  const quickLogin = (demoEmail: string) => {
    const user = USERS.find((u) => u.email === demoEmail);
    if (user) login(user);
  };

  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: C.bgTertiary }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <WebScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" id="login-scroll">
        <View style={styles.logo}>
          <View style={[styles.logoIcon, { backgroundColor: C.textPrimary }]}>
            <Text style={styles.logoIconText}>2AM</Text>
          </View>
          <Text style={[styles.logoTitle, { color: C.textPrimary }]}>2AM Inventory</Text>
          <Text style={[styles.logoSub, { color: C.textSecondary }]}>Restaurant management system</Text>
        </View>

        <View style={[styles.card, { backgroundColor: C.bgPrimary }]}>
          <Text style={[styles.formTitle, { color: C.textPrimary }]}>Sign in</Text>

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
              placeholder="••••••••"
              placeholderTextColor={C.textTertiary}
              secureTextEntry
            />
          </View>

          <TouchableOpacity style={[styles.loginBtn, { backgroundColor: C.textPrimary }]} onPress={handleLogin} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color={C.white} />
            ) : (
              <Text style={[styles.loginBtnText, { color: C.bgPrimary }]}>Sign in</Text>
            )}
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.registerRow} onPress={() => nav.navigate('Register')}>
          <Text style={[styles.registerText, { color: C.textTertiary }]}>Have an invitation? </Text>
          <Text style={[styles.registerTextBold, { color: C.info }]}>Register here</Text>
        </TouchableOpacity>

        {__DEV__ && (
          <View style={[styles.demoSection, { backgroundColor: C.bgPrimary }]}>
            <Text style={[styles.demoTitle, { color: C.textTertiary }]}>Demo accounts (dev only)</Text>
            {USERS.map((u) => {
              const storeNames = u.stores
                .map((sid) => STORES.find((s) => s.id === sid)?.name)
                .filter(Boolean);
              const roleLabel = u.role === 'admin'
                ? 'Admin · All stores'
                : `${storeNames.join(', ')} user`;
              return (
                <TouchableOpacity key={u.email} style={[styles.demoUser, { borderBottomColor: C.borderLight }]} onPress={() => quickLogin(u.email)}>
                  <View style={[styles.demoAvatar, { backgroundColor: u.color + '22' }]}>
                    <Text style={[styles.demoAvatarText, { color: u.color }]}>
                      {u.initials}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.demoName, { color: C.textPrimary }]}>{u.name}</Text>
                    <Text style={[styles.demoEmail, { color: C.textSecondary }]}>{u.email}</Text>
                  </View>
                  <View style={[styles.rolePill, { backgroundColor: u.color + '22' }]}>
                    <Text style={[styles.rolePillText, { color: u.color }]}>{roleLabel}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </WebScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  scroll: { padding: Spacing.xl, paddingTop: 60 },
  logo: { alignItems: 'center', marginBottom: Spacing.xxxl },
  logoIcon: { width: 64, height: 64, borderRadius: 16, backgroundColor: Colors.textPrimary, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md },
  logoIconText: { fontSize: 22, fontWeight: '700', color: Colors.white, letterSpacing: -0.5 },
  logoTitle: { fontSize: 22, fontWeight: '600', color: Colors.textPrimary },
  logoSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  card: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.xl, padding: Spacing.xl, marginBottom: Spacing.lg, ...Shadow.md },
  formTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary, marginBottom: Spacing.lg },
  errorBox: { backgroundColor: Colors.dangerBg, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md },
  errorText: { fontSize: FontSize.xs, color: Colors.danger },
  field: { marginBottom: Spacing.md },
  label: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 5 },
  input: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  loginBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.sm },
  loginBtnText: { color: Colors.bgPrimary, fontSize: FontSize.base, fontWeight: '600' },
  demoSection: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.xl, padding: Spacing.lg, ...Shadow.sm },
  demoTitle: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textTertiary, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: Spacing.md },
  demoUser: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  demoAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  demoAvatarText: { fontSize: FontSize.sm, fontWeight: '600' },
  demoName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  demoEmail: { fontSize: FontSize.xs, color: Colors.textSecondary },
  rolePill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.round },
  rolePillText: { fontSize: 9, fontWeight: '500' },
  registerRow: { flexDirection: 'row', justifyContent: 'center', paddingVertical: Spacing.md },
  registerText: { fontSize: FontSize.sm },
  registerTextBold: { fontSize: FontSize.sm, fontWeight: '600' },
});

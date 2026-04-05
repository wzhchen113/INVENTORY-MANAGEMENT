// src/screens/LoginScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { useStore } from '../store/useStore';
import { Colors, Spacing, Radius, FontSize, Shadow } from '../theme/colors';
import { USERS } from '../data/seed';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useStore((s) => s.login);

  const handleLogin = () => {
    const user = USERS.find((u) => u.email.toLowerCase() === email.toLowerCase().trim());
    if (!user) {
      Alert.alert('Login failed', 'No user found with that email. Try:\nadmin@towson.com\nmaria@towson.com\njames@towson.com');
      return;
    }
    login(user);
  };

  const quickLogin = (email: string) => {
    const user = USERS.find((u) => u.email === email)!;
    login(user);
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.logo}>
          <View style={styles.logoIcon}>
            <Text style={styles.logoIconText}>TI</Text>
          </View>
          <Text style={styles.logoTitle}>Towson Inventory</Text>
          <Text style={styles.logoSub}>Restaurant management system</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.formTitle}>Sign in</Text>

          <View style={styles.field}>
            <Text style={styles.label}>Email address</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="your@email.com"
              placeholderTextColor={Colors.textTertiary}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={Colors.textTertiary}
              secureTextEntry
            />
          </View>

          <TouchableOpacity style={styles.loginBtn} onPress={handleLogin}>
            <Text style={styles.loginBtnText}>Sign in</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.demoSection}>
          <Text style={styles.demoTitle}>Demo accounts</Text>
          {[
            { label: 'Admin (Owner)', email: 'admin@towson.com', role: 'Admin', color: Colors.userAdmin },
            { label: 'Maria Garcia', email: 'maria@towson.com', role: 'Store user', color: Colors.userMaria },
            { label: 'James Thompson', email: 'james@towson.com', role: 'Store user', color: Colors.userJames },
            { label: 'Ana Rivera', email: 'ana@baltimore.com', role: 'Store user', color: Colors.userAna },
          ].map((u) => (
            <TouchableOpacity key={u.email} style={styles.demoUser} onPress={() => quickLogin(u.email)}>
              <View style={[styles.demoAvatar, { backgroundColor: u.color + '22' }]}>
                <Text style={[styles.demoAvatarText, { color: u.color }]}>
                  {u.label.split(' ').map((w) => w[0]).join('').slice(0, 2)}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.demoName}>{u.label}</Text>
                <Text style={styles.demoEmail}>{u.email}</Text>
              </View>
              <View style={[styles.rolePill, { backgroundColor: u.color + '22' }]}>
                <Text style={[styles.rolePillText, { color: u.color }]}>{u.role}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
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
  field: { marginBottom: Spacing.md },
  label: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 5 },
  input: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  loginBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.sm },
  loginBtnText: { color: Colors.white, fontSize: FontSize.base, fontWeight: '600' },
  demoSection: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.xl, padding: Spacing.lg, ...Shadow.sm },
  demoTitle: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textTertiary, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: Spacing.md },
  demoUser: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  demoAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  demoAvatarText: { fontSize: FontSize.sm, fontWeight: '600' },
  demoName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  demoEmail: { fontSize: FontSize.xs, color: Colors.textSecondary },
  rolePill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.round },
  rolePillText: { fontSize: 9, fontWeight: '500' },
});

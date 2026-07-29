// src/screens/cmd/sections/phone/PhoneLogin.tsx — Spec 148.
//
// Phone-tier restyle of the shared sign-in portal (README §19). Renders the
// im.cmd▮ brand mark (mono 700 28 + an accent block cursor) + a "RESTAURANT
// COMMAND CONSOLE" caption, 48px USERNAME OR EMAIL + PASSWORD wells, a 50px
// accent SIGN IN → primary, a FORGOT PASSWORD affordance (honest toast — no
// reset flow exists yet), and a store/version footer.
//
// This is presentation ONLY: every piece of auth STATE + the submit / register
// / quick-login handlers are LIFTED from LoginScreen in a `model` bundle (the
// spec-145/146 pattern), so this file forks none of the signIn / role-branch
// orchestration. Cmd palette + PhoneType tokens; no new hex, no new fonts.
//
// DEVIATION (see spec 148): LoginScreen is the SHARED pre-auth portal for both
// admin AND staff (spec 063 RoleRouter) — the role is unknown until signIn
// resolves — so this phone restyle necessarily applies to both surfaces on a
// phone. It is gated on `isPhone`, not on role; a role gate is impossible
// before authentication.

import React from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, sans, PhoneType } from '../../../../theme/typography';
import { useT } from '../../../../hooks/useT';
import { APP_VERSION } from '../../../../utils/version';

export interface PhoneLoginDemoUser {
  email: string;
  name: string;
  initials: string;
  color: string;
  roleLabel: string;
}

export interface PhoneLoginModel {
  identifier: string;
  setIdentifier: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  loading: boolean;
  error: string;
  onSubmit: () => void;
  onRegister: () => void;
  /** Dev-only quick-login accounts (empty in production builds). */
  demoUsers: PhoneLoginDemoUser[];
  onQuickLogin: (email: string) => void;
}

export const PhoneLogin: React.FC<{ model: PhoneLoginModel }> = ({ model }) => {
  const C = useCmdColors();
  const T = useT();

  const onForgot = () =>
    Toast.show({ type: 'info', text1: T('chrome.phone.login.forgotToast') });

  const webOutline = Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {};

  return (
    <KeyboardAvoidingView
      testID="phone-login"
      style={{ flex: 1, backgroundColor: C.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Brand mark — im.cmd + accent block cursor ▮ */}
        <View style={{ alignItems: 'center', marginBottom: 28 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ fontFamily: mono(700), fontSize: 28, color: C.fg, letterSpacing: -0.5 }}>
              im.cmd
            </Text>
            <Text style={{ fontFamily: mono(700), fontSize: 28, color: C.accent }}>▮</Text>
          </View>
          <Text
            style={[PhoneType.caption, { color: C.fg3, marginTop: 8, textAlign: 'center' }]}
          >
            {T('chrome.phone.login.caption')}
          </Text>
        </View>

        {model.error ? (
          <View
            testID="phone-login-error"
            style={{
              backgroundColor: C.dangerBg,
              borderWidth: 1,
              borderColor: C.danger,
              borderRadius: CmdRadius.md,
              paddingHorizontal: 12,
              paddingVertical: 10,
              marginBottom: 16,
            }}
          >
            <Text style={[PhoneType.body, { color: C.danger }]}>{model.error}</Text>
          </View>
        ) : null}

        {/* USERNAME OR EMAIL */}
        <View style={{ marginBottom: 14 }}>
          <Text style={[PhoneType.microCaption, { color: C.fg3, marginBottom: 6 }]}>
            {T('chrome.phone.login.usernameLabel')}
          </Text>
          <TextInput
            testID="phone-login-identifier"
            value={model.identifier}
            onChangeText={model.setIdentifier}
            placeholder={T('chrome.phone.login.usernamePlaceholder')}
            placeholderTextColor={C.fg3}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              height: 48,
              paddingHorizontal: 14,
              borderRadius: CmdRadius.md,
              borderWidth: 1,
              borderColor: C.borderStrong,
              backgroundColor: C.panel2,
              color: C.fg,
              fontFamily: mono(400),
              fontSize: 13,
              ...webOutline,
            }}
          />
        </View>

        {/* PASSWORD */}
        <View style={{ marginBottom: 20 }}>
          <Text style={[PhoneType.microCaption, { color: C.fg3, marginBottom: 6 }]}>
            {T('chrome.phone.login.passwordLabel')}
          </Text>
          <TextInput
            testID="phone-login-password"
            value={model.password}
            onChangeText={model.setPassword}
            placeholder={T('chrome.phone.login.passwordPlaceholder')}
            placeholderTextColor={C.fg3}
            secureTextEntry
            style={{
              height: 48,
              paddingHorizontal: 14,
              borderRadius: CmdRadius.md,
              borderWidth: 1,
              borderColor: C.borderStrong,
              backgroundColor: C.panel2,
              color: C.fg,
              fontFamily: mono(400),
              fontSize: 13,
              ...webOutline,
            }}
          />
        </View>

        {/* SIGN IN → */}
        <TouchableOpacity
          testID="phone-login-submit"
          onPress={model.onSubmit}
          disabled={model.loading}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{
            height: 50,
            borderRadius: CmdRadius.md,
            backgroundColor: C.accent,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: model.loading ? 0.7 : 1,
          }}
        >
          {model.loading ? (
            <ActivityIndicator size="small" color={C.accentFg} />
          ) : (
            <Text style={{ fontFamily: mono(700), fontSize: 13, letterSpacing: 0.5, color: C.accentFg }}>
              {T('chrome.phone.login.signIn')}
            </Text>
          )}
        </TouchableOpacity>

        {/* FORGOT PASSWORD (honest toast) */}
        <TouchableOpacity
          testID="phone-login-forgot"
          onPress={onForgot}
          accessibilityRole="button"
          style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 }}
        >
          <Text style={[PhoneType.caption, { color: C.fg3 }]}>
            {T('chrome.phone.login.forgotPassword')}
          </Text>
        </TouchableOpacity>

        {/* Register link — real navigation, kept from the shared portal. */}
        <TouchableOpacity
          testID="phone-login-register"
          onPress={model.onRegister}
          accessibilityRole="button"
          style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={[PhoneType.body, { color: C.accent }]}>
            {T('chrome.phone.login.register')}
          </Text>
        </TouchableOpacity>

        {model.demoUsers.length > 0 ? (
          <View
            style={{
              marginTop: 24,
              borderTopWidth: 1,
              borderTopColor: C.border,
              paddingTop: 16,
            }}
          >
            <Text style={[PhoneType.microCaption, { color: C.fg3, marginBottom: 10 }]}>
              {T('chrome.phone.login.demoTitle')}
            </Text>
            {model.demoUsers.map((u) => (
              <TouchableOpacity
                key={u.email}
                testID={`phone-login-demo-${u.name.toLowerCase().replace(/\s+/g, '-')}`}
                onPress={() => model.onQuickLogin(u.email)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  minHeight: 48,
                  paddingVertical: 8,
                  borderBottomWidth: 1,
                  borderBottomColor: C.border,
                }}
              >
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: CmdRadius.sm,
                    backgroundColor: C.panel2,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 11, color: u.color }}>{u.initials}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[PhoneType.itemName, { color: C.fg }]} numberOfLines={1}>{u.name}</Text>
                  <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>{u.email}</Text>
                </View>
                <Text style={[PhoneType.caption, { color: C.fg3 }]}>{u.roleLabel}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {/* Store / version footer */}
        <View style={{ alignItems: 'center', marginTop: 28 }}>
          <Text style={{ fontFamily: sans(400), fontSize: 11, color: C.fg3 }}>
            2AM PROJECT · {APP_VERSION}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

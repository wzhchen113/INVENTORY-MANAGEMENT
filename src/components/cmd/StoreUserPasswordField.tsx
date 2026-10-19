import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextInput } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { STORE_USER_PASSWORD_MIN_LENGTH } from '../../lib/auth';

interface Props {
  /** testIDs for the input, the SHOW/HIDE toggle and the length error. */
  testID: string;
  toggleTestID: string;
  errorTestID: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Controlled by the host so its open/close reset clears it with the value. */
  showPassword: boolean;
  onToggleShow: () => void;
  /** Muted helper line shown while there is no length error. */
  hint?: string;
  autoFocus?: boolean;
  /** Return / Enter while THIS input has focus (web and native). */
  onSubmitEditing?: () => void;
}

// Spec 165 — the admin-typed password input shared by AddStoreUserDrawer and
// SetStoreUserPasswordModal: secure entry + SHOW/HIDE toggle + the
// STORE_USER_PASSWORD_MIN_LENGTH error. Stateless: the value (and the
// show/hide flag) stay in the host's useState so the host's reset-on-open /
// close / success clears them; nothing here stores, logs or toasts it.
export const StoreUserPasswordField: React.FC<Props> = ({
  testID, toggleTestID, errorTestID, label, value, onChange, showPassword, onToggleShow, hint, autoFocus, onSubmitEditing,
}) => {
  const C = useCmdColors();
  const tooShort = value.length > 0 && value.length < STORE_USER_PASSWORD_MIN_LENGTH;
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <TextInput
          testID={testID}
          value={value}
          onChangeText={onChange}
          onSubmitEditing={onSubmitEditing}
          placeholder={`at least ${STORE_USER_PASSWORD_MIN_LENGTH} characters`}
          placeholderTextColor={C.fg3}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          autoFocus={autoFocus}
          style={{
            flex: 1,
            fontFamily: sans(400),
            fontSize: 13,
            color: C.fg,
            backgroundColor: C.panel2,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: CmdRadius.sm,
            paddingHorizontal: 10,
            paddingVertical: 8,
            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as Record<string, unknown>) : {}),
          }}
        />
        <TouchableOpacity
          testID={toggleTestID}
          onPress={onToggleShow}
          accessibilityRole="button"
          accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
          style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg2 }}>{showPassword ? 'HIDE' : 'SHOW'}</Text>
        </TouchableOpacity>
      </View>
      {tooShort ? (
        <Text testID={errorTestID} style={{ fontFamily: sans(400), fontSize: 10.5, color: C.warn }}>
          Password must be at least {STORE_USER_PASSWORD_MIN_LENGTH} characters
        </Text>
      ) : hint ? (
        <Text style={{ fontFamily: sans(400), fontSize: 10.5, color: C.fg3 }}>{hint}</Text>
      ) : null}
    </View>
  );
};

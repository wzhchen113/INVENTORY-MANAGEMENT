import React from 'react';
import { View, Text, TouchableOpacity, Platform, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { ResponsiveSheet } from './ResponsiveSheet';
import { StoreUserPasswordField } from './StoreUserPasswordField';
import { useIsPhone } from '../../theme/breakpoints';
import { setStoreUserPassword, STORE_USER_PASSWORD_MIN_LENGTH } from '../../lib/auth';
import { storeUserErrorText } from '../../utils/userIdentity';
import type { User } from '../../types';

interface Props {
  /** The username-only store user whose password is being set. `null` hides
   *  the modal. Hosts only pass a target that cleared the SET PASSWORD gate
   *  (canResetPassword && isUsernameLogin); the server re-checks everything. */
  target: User | null;
  onClose: () => void;
}

// Spec 165 §G — SET PASSWORD for a username-only (placeholder-email) store
// user. Replaces the email RESET PW for those accounts. The new password lives
// ONLY in this component's useState and is reset to '' on open, close and
// success; it never reaches Zustand, storage, a log, or a toast.
export const SetStoreUserPasswordModal: React.FC<Props> = ({ target, onClose }) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const visible = !!target;
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset whenever the target changes (open, close, or a different row).
  const targetId = target?.id ?? null;
  React.useEffect(() => {
    setPassword('');
    setShowPassword(false);
    setSubmitting(false);
  }, [targetId]);

  const handle = target?.username ? `@${target.username}` : (target?.name || 'this user');
  const valid = password.length >= STORE_USER_PASSWORD_MIN_LENGTH;

  const handleSave = async () => {
    if (!target || !valid || submitting) return;
    setSubmitting(true);
    const { error } = await setStoreUserPassword(target.id, password);
    setSubmitting(false);
    if (error) {
      Toast.show({
        type: 'error',
        text1: 'Could not set password',
        text2: storeUserErrorText(error),
        visibilityTime: 5000,
      });
      return;
    }
    setPassword('');
    Toast.show({ type: 'success', text1: `Password updated for ${handle}` });
    onClose();
  };

  // Esc closes; Cmd+S / Cmd+Enter save (web only; InviteUserDrawer idiom).
  // Plain Enter is NOT handled here: it submits via the password input's
  // onSubmitEditing, so it fires only while that field has focus (Enter on a
  // focused CANCEL activates CANCEL). A document-level plain-Enter could not
  // do this anyway: react-native-web's TextInput stops keydown propagation,
  // so this listener only ever saw Enter from OUTSIDE the field.
  const handleSaveRef = React.useRef(handleSave);
  handleSaveRef.current = handleSave;
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
        handleSaveRef.current();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  if (!target) return null;

  const header = (
    <View
      style={{
        height: 44,
        paddingHorizontal: 18,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: C.panel,
      }}
    >
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.warnBg }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.warn }}>PASSWORD</Text>
      </View>
      <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }} numberOfLines={1}>
        Set password for {handle}
      </Text>
      <View style={{ flex: 1 }} />
      {isPhone ? (
        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={6}>
          <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>✕</Text>
        </TouchableOpacity>
      ) : (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
      )}
    </View>
  );

  const footer = (
    <View
      style={{
        minHeight: 54,
        paddingHorizontal: 18,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.panel,
        flexWrap: 'wrap',
      }}
    >
      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
        {valid ? 'ready to set' : `needs password (${STORE_USER_PASSWORD_MIN_LENGTH}+)`}
      </Text>
      <View style={{ flex: 1 }} />
      <TouchableOpacity
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="set-password-submit"
        onPress={handleSave}
        disabled={!valid || submitting}
        accessibilityRole="button"
        accessibilityLabel="Set password"
        accessibilityState={{ disabled: !valid || submitting }}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          backgroundColor: valid && !submitting ? C.accent : C.panel2,
          opacity: valid && !submitting ? 1 : 0.6,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: valid && !submitting ? C.accentFg : C.fg3 }}>
          {submitting ? 'SAVING…' : 'SET PASSWORD'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      desktopWidth={520}
      tabletSheetHeight={0.55}
      presentation={{ desktop: 'center-modal' }}
      header={header}
      footer={footer}
      accessibilityLabel={`Set password for ${handle}`}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 22, gap: 14 }} keyboardShouldPersistTaps="handled">
        <Text testID="set-password-target" style={{ fontFamily: sans(400), fontSize: 12.5, color: C.fg2, lineHeight: 18 }}>
          Set a new password for <Text style={{ fontFamily: mono(700), color: C.fg }}>{handle}</Text>
          {target.name && target.username ? ` (${target.name})` : ''}. Tell them the new password in person.
        </Text>

        <View
          testID="set-password-session-note"
          style={{
            backgroundColor: C.warnBg,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            borderColor: C.border,
            padding: 12,
          }}
        >
          <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2, lineHeight: 18 }}>
            Signs {handle} out on every device. A device that's open right now may keep working for up to an hour.
          </Text>
        </View>

        <StoreUserPasswordField
          testID="set-password-input"
          toggleTestID="set-password-toggle"
          errorTestID="set-password-error"
          label="New password"
          value={password}
          onChange={setPassword}
          showPassword={showPassword}
          onToggleShow={() => setShowPassword((v) => !v)}
          autoFocus
          onSubmitEditing={handleSave}
        />
      </ScrollView>
    </ResponsiveSheet>
  );
};

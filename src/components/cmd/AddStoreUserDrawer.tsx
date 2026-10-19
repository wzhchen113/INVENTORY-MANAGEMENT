import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ResponsiveSheet } from './ResponsiveSheet';
import { StoreUserPasswordField } from './StoreUserPasswordField';
import { useIsPhone } from '../../theme/breakpoints';
import { createStoreUser, STORE_USER_PASSWORD_MIN_LENGTH } from '../../lib/auth';
import { validateUsername } from '../../lib/usernameValidation';
import { storeUserErrorText } from '../../utils/userIdentity';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called after a successful create (e.g. refresh the users list). */
  onCreated?: () => void;
}

interface FormValues {
  name: string;
  username: string;
  password: string;
  storeIds: string[];
}

const blank = (): FormValues => ({ name: '', username: '', password: '', storeIds: [] });

// Spec 165 §F / §8 — "+ ADD USER": create a `role='user'` store account that
// signs in to the staff app by username + an admin-typed password. No email is
// sent. Sibling of InviteUserDrawer (same ResponsiveSheet chrome, Esc and
// Cmd+S / Cmd+Enter idiom, spec 068 brand filter + stale-selection prune).
//
// There is no role picker (role is fixed to 'user' server-side) and no email
// field. The password lives ONLY in this component's useState: it is reset to
// '' whenever the drawer opens or closes, and it never reaches Zustand,
// storage, a log, or a toast.
export const AddStoreUserDrawer: React.FC<Props> = ({ visible, onClose, onCreated }) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const stores = useStore((s) => s.stores);
  const brand = useStore((s) => s.brand);

  const [values, setValues] = React.useState<FormValues>(blank);
  const [showPassword, setShowPassword] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset on open AND on close, so the password never survives a close (the
  // component stays mounted while hidden).
  React.useEffect(() => {
    setValues(blank());
    setShowPassword(false);
    setSubmitting(false);
  }, [visible]);

  const brandId = brand?.id ?? null;

  // Spec 068 §2 — the store options are scoped to the active brand (the
  // global `stores` cache spans brands). Empty when no brand is active.
  const brandStores = React.useMemo(
    () => stores.filter((s) => s.brandId === brandId),
    [stores, brandId],
  );

  // Spec 068 §2 — prune selections that don't belong to the active brand
  // after a header brand switch (mirrors InviteUserDrawer).
  React.useEffect(() => {
    if (!visible) return;
    const allowed = new Set(brandStores.map((s) => s.id));
    setValues((p) => {
      const pruned = p.storeIds.filter((id) => allowed.has(id));
      return pruned.length === p.storeIds.length ? p : { ...p, storeIds: pruned };
    });
    // Keyed on brandId (brandStores identity only changes with it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, visible]);

  const nameTrimmed = values.name.trim();
  const usernameTrimmed = values.username.trim();
  // Username is REQUIRED here (it is the only login identity). The inline
  // error is shown only once the admin has typed something.
  const usernameCheck = validateUsername(usernameTrimmed);
  const usernameError = usernameTrimmed.length > 0 && !usernameCheck.ok ? usernameCheck.error : null;
  const passwordShort = values.password.length < STORE_USER_PASSWORD_MIN_LENGTH;
  const selectedStoreIds = values.storeIds.filter((id) => brandStores.some((s) => s.id === id));

  const missing: string[] = [];
  if (nameTrimmed.length === 0) missing.push('name');
  if (!usernameCheck.ok) missing.push('username');
  if (passwordShort) missing.push(`password (${STORE_USER_PASSWORD_MIN_LENGTH}+)`);
  if (selectedStoreIds.length === 0) missing.push('a store');

  const requiredValid = !!brandId && brandStores.length > 0 && missing.length === 0;

  const set = <K extends keyof FormValues>(k: K) => (v: FormValues[K]) =>
    setValues((p) => ({ ...p, [k]: v }));

  const toggleStore = (id: string) => {
    setValues((p) =>
      p.storeIds.includes(id)
        ? { ...p, storeIds: p.storeIds.filter((s) => s !== id) }
        : { ...p, storeIds: [...p.storeIds, id] },
    );
  };

  const handleSave = async () => {
    if (!requiredValid || submitting) return;
    setSubmitting(true);
    const result = await createStoreUser({
      name: nameTrimmed,
      username: usernameTrimmed,
      password: values.password,
      storeIds: selectedStoreIds,
    });
    setSubmitting(false);
    if (result.error || !result.data) {
      // Keep the drawer open with the input intact so the admin can fix it.
      Toast.show({
        type: 'error',
        text1: 'Could not add user',
        text2: storeUserErrorText(result.error || 'could not create account', usernameTrimmed.toLowerCase()),
        visibilityTime: 5000,
      });
      return;
    }
    // Clear the password from state before handing control back.
    setValues(blank());
    Toast.show({
      type: 'success',
      text1: 'Store user created',
      text2: `@${result.data.username}`,
    });
    onCreated?.();
    onClose();
  };

  // Cmd+S / Cmd+Enter saves, Esc closes (InviteUserDrawer idiom).
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

  if (!visible) return null;

  const footerHint = !brandId
    ? 'switch into a brand first'
    : brandStores.length === 0
      ? 'this brand has no stores'
      : requiredValid
        ? 'ready to create'
        : `needs ${missing.join(', ')}`;

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
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>ADD</Text>
      </View>
      <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }} numberOfLines={1}>
        add-store-user
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
      <Text testID="add-user-hint" style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, flexShrink: 1 }}>
        {footerHint}
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
        testID="add-user-submit"
        onPress={handleSave}
        disabled={!requiredValid || submitting}
        accessibilityRole="button"
        accessibilityLabel="Create store user"
        accessibilityState={{ disabled: !requiredValid || submitting }}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          backgroundColor: requiredValid && !submitting ? C.accent : C.panel2,
          opacity: requiredValid && !submitting ? 1 : 0.6,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: requiredValid && !submitting ? C.accentFg : C.fg3 }}>
          {submitting ? 'CREATING…' : 'CREATE  ⌘⏎'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const notice = (testID: string, title: string, body: string) => (
    <View
      testID={testID}
      style={{
        backgroundColor: C.warnBg,
        borderRadius: CmdRadius.sm,
        borderWidth: 1,
        borderColor: C.warn,
        padding: 12,
      }}
    >
      <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.warn }}>{title}</Text>
      <Text style={{ fontFamily: sans(400), fontSize: 11.5, color: C.fg2, marginTop: 4 }}>{body}</Text>
    </View>
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      desktopWidth={600}
      tabletSheetHeight={0.85}
      header={header}
      footer={footer}
      accessibilityLabel="Add store user"
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 22, gap: 14 }} keyboardShouldPersistTaps="handled">
        {/* What this creates — there is no role picker. */}
        <View
          style={{
            backgroundColor: C.panel2,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: CmdRadius.sm,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            Store user · no email
          </Text>
          <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2, marginTop: 3, lineHeight: 17 }}>
            Creates a store user who signs in to the staff app with this username and password. No email is sent — give
            them the password in person.
          </Text>
        </View>

        <Field
          testID="add-user-name"
          label="Display name"
          value={values.name}
          onChange={set('name')}
          placeholder="Marcus Lee"
          autoFocus
        />

        <View style={{ gap: 4 }}>
          <Field
            testID="add-user-username"
            label="Username"
            value={values.username}
            // Stored case-folded (spec 095) — lowercase as the admin types so
            // the displayed value matches what is saved.
            onChange={(v) => set('username')(v.toLowerCase())}
            placeholder="marcus.l"
          />
          {usernameError ? (
            <Text testID="add-user-username-error" style={{ fontFamily: sans(400), fontSize: 10.5, color: C.warn }}>
              {usernameError}
            </Text>
          ) : (
            <Text style={{ fontFamily: sans(400), fontSize: 10.5, color: C.fg3 }}>
              3–20 characters · letters, numbers, _ and . · this is how they sign in
            </Text>
          )}
        </View>

        <StoreUserPasswordField
          testID="add-user-password"
          toggleTestID="add-user-password-toggle"
          errorTestID="add-user-password-error"
          label="Password"
          value={values.password}
          onChange={set('password')}
          showPassword={showPassword}
          onToggleShow={() => setShowPassword((v) => !v)}
          hint="Use SHOW to read it back to them. They keep this password until you set a new one."
        />

        {/* Stores multi-select — active brand only, at least one required. */}
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
              Stores
            </Text>
            {brandId ? (
              <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                · {selectedStoreIds.length} of {brandStores.length} selected · at least 1
              </Text>
            ) : null}
          </View>
          {!brandId ? (
            notice(
              'add-user-no-brand',
              'Switch into a brand first to assign stores',
              'Store access is scoped to a single brand. Pick a brand from the header brand picker, then re-open this drawer to choose its stores.',
            )
          ) : brandStores.length === 0 ? (
            notice(
              'add-user-no-stores',
              'This brand has no stores yet',
              'A store user needs at least one store. Add a store to this brand first, then re-open this drawer.',
            )
          ) : (
            <View style={{ gap: 4 }}>
              {brandStores.map((s) => {
                const isSelected = values.storeIds.includes(s.id);
                return (
                  <TouchableOpacity
                    key={s.id}
                    testID={`add-user-store-${s.id}`}
                    onPress={() => toggleStore(s.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingVertical: 8,
                      paddingHorizontal: 10,
                      borderWidth: 1,
                      borderColor: isSelected ? C.accent : C.border,
                      borderRadius: CmdRadius.sm,
                      backgroundColor: isSelected ? C.accentBg : C.panel2,
                    }}
                  >
                    <View
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 3,
                        borderWidth: 1.5,
                        borderColor: isSelected ? C.accent : C.borderStrong,
                        backgroundColor: isSelected ? C.accent : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isSelected ? (
                        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>✓</Text>
                      ) : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg }}>{s.name}</Text>
                      {s.address ? (
                        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>
                          {s.address}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
    </ResponsiveSheet>
  );
};

function inputStyle(C: ReturnType<typeof useCmdColors>) {
  return {
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
  };
}

// ─── Field input — same shape as InviteUserDrawer's helper ─────────
function Field({
  label, value, onChange, placeholder, autoFocus, testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  testID?: string;
}) {
  const C = useCmdColors();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
        {label}
      </Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.fg3}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        style={inputStyle(C)}
      />
    </View>
  );
}

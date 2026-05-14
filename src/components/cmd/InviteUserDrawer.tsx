import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsPhone } from '../../theme/breakpoints';
import { inviteUser } from '../../lib/auth';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Optional callback after a successful invite (e.g. refresh users list). */
  onInvited?: () => void;
}

type RoleChoice = 'admin' | 'user';

interface FormValues {
  email: string;
  name: string;
  role: RoleChoice;
  storeIds: string[];
}

const blank = (): FormValues => ({
  email: '',
  name: '',
  role: 'user',
  storeIds: [],
});

// Spec 025 §2.H — user invitation drawer for the admin-global UsersSection.
// Modeled on InviteAdminDrawer; the differences are:
//   - Admin-global, not brand-scoped. Stores list comes from
//     useStore.stores (the inviter's visible stores), not "all brand
//     stores".
//   - Role picker visible to master/super_admin (admin/user); admin
//     invitations get brandId from useStore.brand?.id. Non-master admins
//     are hard-locked to role='user' and the picker is hidden.
//   - Default storeIds = empty (caller checks per-store; the admin needs
//     to opt in to each one).
export const InviteUserDrawer: React.FC<Props> = ({ visible, onClose, onInvited }) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const stores = useStore((s) => s.stores);
  const brand = useStore((s) => s.brand);
  const currentUser = useStore((s) => s.currentUser);

  // Spec 025 §2.G.1 — `isMaster` predicate generalized to also accept
  // super_admin so super-admins keep their implicit visibility.
  const isMaster = currentUser?.role === 'master' || currentUser?.role === 'super_admin';

  const [values, setValues] = React.useState<FormValues>(blank);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    setValues({
      email: '',
      name: '',
      // Non-master admins can only invite store users (matches legacy
      // gate at AdminScreens.tsx:1604).
      role: isMaster ? 'user' : 'user',
      storeIds: [],
    });
    setSubmitting(false);
  }, [visible, isMaster]);

  // For role='admin' invitations we need a brandId. The current brand
  // comes from useStore.brand?.id.
  const brandId = brand?.id ?? null;

  const requiredValid =
    values.email.trim().length > 0 &&
    values.name.trim().length > 0 &&
    (values.role !== 'admin' || !!brandId);

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
    const storeNames = values.storeIds
      .map((id) => stores.find((s) => s.id === id)?.name)
      .filter(Boolean)
      .join(', ');
    const result = await inviteUser({
      email: values.email.trim(),
      name: values.name.trim(),
      role: values.role,
      // Spec 025 §2.H — only attach brandId when role='admin' (the
      // profiles_role_brand_consistent CHECK rejects brand_id on
      // user-role rows). Pass null for 'user' role.
      brandId: values.role === 'admin' ? brandId : null,
      storeIds: values.storeIds,
      storeNames,
    });
    setSubmitting(false);
    if (result.error) {
      Toast.show({
        type: 'error',
        text1: 'Invite failed',
        text2: result.error,
        visibilityTime: 5000,
      });
      return;
    }
    Toast.show({
      type: 'success',
      text1: 'Invitation sent',
      text2: values.email.trim(),
    });
    onInvited?.();
    onClose();
  };

  // Cmd+S / Cmd+Enter saves, Esc closes. handleSave through a ref to
  // avoid stale closures (mirrors InviteAdminDrawer).
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
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>INVITE</Text>
      </View>
      <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }} numberOfLines={1}>
        invite-user
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
        {requiredValid ? 'ready to send' : 'fill in email + name'}
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
        onPress={handleSave}
        disabled={!requiredValid || submitting}
        accessibilityRole="button"
        accessibilityLabel="Send invitation"
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
          {submitting ? 'SENDING…' : 'SEND  ⌘⏎'}
        </Text>
      </TouchableOpacity>
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
      accessibilityLabel="Invite user"
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
        <Field
          label="Email"
          value={values.email}
          onChange={set('email')}
          placeholder="bobby@example.com"
          autoFocus
        />
        <Field
          label="Display name"
          value={values.name}
          onChange={set('name')}
          placeholder="Bobby Bobson"
        />

        {/* Role selector — master / super-admin can pick admin or user.
            Non-master admins are hard-locked to 'user' per legacy gate
            (AdminScreens.tsx:1604). */}
        {isMaster ? (
          <View style={{ gap: 6 }}>
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 9.5,
                color: C.fg3,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
            >
              Role
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['user', 'admin'] as RoleChoice[]).map((r) => {
                const isSelected = values.role === r;
                return (
                  <TouchableOpacity
                    key={r}
                    onPress={() => set('role')(r)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      paddingHorizontal: 12,
                      borderRadius: CmdRadius.sm,
                      borderWidth: 1,
                      borderColor: isSelected ? C.accent : C.border,
                      backgroundColor: isSelected ? C.accentBg : C.panel2,
                      alignItems: 'center',
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: mono(700),
                        fontSize: 11,
                        color: isSelected ? C.accent : C.fg2,
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                      }}
                    >
                      {r === 'admin' ? 'admin' : 'store user'}
                    </Text>
                    <Text style={{ fontFamily: sans(400), fontSize: 10.5, color: C.fg3, marginTop: 2 }}>
                      {r === 'admin' ? 'manages this brand' : 'staff (separate app)'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {/* Brand context for admin invitations — surfaced read-only
                so the inviter sees which brand the new admin will land
                under. */}
            {values.role === 'admin' && brand ? (
              <View
                style={{
                  backgroundColor: C.panel2,
                  borderWidth: 1,
                  borderColor: C.border,
                  borderRadius: CmdRadius.sm,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  marginTop: 4,
                }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  Brand
                </Text>
                <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, marginTop: 2 }}>{brand.name}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }} numberOfLines={1}>
                  {brand.id}
                </Text>
              </View>
            ) : null}
            {values.role === 'admin' && !brand ? (
              <View
                style={{
                  backgroundColor: C.warnBg,
                  borderRadius: CmdRadius.sm,
                  borderWidth: 1,
                  borderColor: C.warn,
                  padding: 10,
                  marginTop: 4,
                }}
              >
                <Text style={{ fontFamily: sans(500), fontSize: 11.5, color: C.warn }}>
                  Switch into a brand before inviting an admin
                </Text>
                <Text style={{ fontFamily: sans(400), fontSize: 10.5, color: C.fg2, marginTop: 3 }}>
                  Admin invitations require a brand assignment. Pick a brand from the header brand picker, then re-open this drawer.
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Stores multi-select — inviter's visible stores. */}
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 9.5,
                color: C.fg3,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
            >
              Stores
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
              · {values.storeIds.length} of {stores.length} selected
            </Text>
          </View>
          {stores.length === 0 ? (
            <View
              style={{
                backgroundColor: C.warnBg,
                borderRadius: CmdRadius.sm,
                borderWidth: 1,
                borderColor: C.warn,
                padding: 12,
              }}
            >
              <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.warn }}>
                No stores visible yet
              </Text>
              <Text style={{ fontFamily: sans(400), fontSize: 11.5, color: C.fg2, marginTop: 4 }}>
                The invitee can still be sent the invitation; they will gain access when stores are assigned.
              </Text>
            </View>
          ) : (
            <View style={{ gap: 4 }}>
              {stores.map((s) => {
                const isSelected = values.storeIds.includes(s.id);
                return (
                  <TouchableOpacity
                    key={s.id}
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

// ─── Field input — same shape as InviteAdminDrawer's helper ─────────
function Field({
  label, value, onChange, placeholder, autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const C = useCmdColors();
  return (
    <View style={{ gap: 4 }}>
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 9.5,
          color: C.fg3,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.fg3}
        autoFocus={autoFocus}
        autoCapitalize="none"
        style={{
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
    </View>
  );
}

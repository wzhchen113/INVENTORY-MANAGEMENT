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
  /** The brand the invitation is being issued for. Required. */
  brandId: string;
  brandName: string;
  onClose: () => void;
  /** Optional callback after a successful invite (e.g. refresh members list). */
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
  role: 'admin',
  storeIds: [],
});

// Spec 012b §4 — admin invitation form. Lives inside BrandsSection's
// detail-view members tab; brand is fixed by the surrounding context
// (super-admin can only issue invites for the brand they're viewing).
// Role defaults to 'admin'; 'super_admin' is not invitable per umbrella
// Q2. Stores multi-select defaults to ALL stores in the brand so legacy
// admins keep their implicit "admin sees all" parity (Q-PM-9).
export const InviteAdminDrawer: React.FC<Props> = ({ visible, brandId, brandName, onClose, onInvited }) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const allStores = useStore((s) => s.stores);

  const brandStores = React.useMemo(
    () => allStores.filter((s) => s.brandId === brandId),
    [allStores, brandId],
  );

  const [values, setValues] = React.useState<FormValues>(blank);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    setValues({
      email: '',
      name: '',
      role: 'admin',
      // Default to ALL brand stores so legacy admins are not silently
      // scoped down — see PM Risks #2.
      storeIds: brandStores.map((s) => s.id),
    });
    setSubmitting(false);
  }, [visible, brandStores]);

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
      .map((id) => brandStores.find((s) => s.id === id)?.name)
      .filter(Boolean)
      .join(', ');
    const result = await inviteUser({
      email: values.email.trim(),
      name: values.name.trim(),
      role: values.role,
      brandId,
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

  // Cmd+S / Cmd+Enter saves, Esc closes. Cleanup #7 — handleSave through
  // a ref so the handler always reads the latest closure (stale-closure
  // would otherwise fire on the form state when the keydown was bound).
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
        invite-admin
      </Text>
      <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>
        · {brandName}
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
        style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleSave}
        disabled={!requiredValid || submitting}
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
      accessibilityLabel="Invite admin"
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

        {/* Role selector — radio between admin and user */}
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
            {(['admin', 'user'] as RoleChoice[]).map((r) => {
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
                    {r}
                  </Text>
                  <Text style={{ fontFamily: sans(400), fontSize: 10.5, color: C.fg3, marginTop: 2 }}>
                    {r === 'admin' ? 'manages this brand' : 'staff (separate app)'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Brand — read-only display (super-admin can override by switching
            brands first; this mirrors the spec's "defaults to the brand whose
            detail view is open" decision). */}
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
            Brand
          </Text>
          <View
            style={{
              backgroundColor: C.panel2,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: CmdRadius.sm,
              paddingHorizontal: 10,
              paddingVertical: 9,
            }}
          >
            <Text style={{ fontFamily: sans(500), fontSize: 13, color: C.fg }}>{brandName}</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>
              {brandId}
            </Text>
          </View>
        </View>

        {/* Stores multi-select */}
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
              · {values.storeIds.length} of {brandStores.length} selected
            </Text>
          </View>
          {brandStores.length === 0 ? (
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
                No stores yet for this brand
              </Text>
              <Text style={{ fontFamily: sans(400), fontSize: 11.5, color: C.fg2, marginTop: 4 }}>
                Create a store first via the Inventory section after switching
                into this brand. The invitee can be assigned later, or invited
                with no stores (admin sees all brand stores by default).
              </Text>
            </View>
          ) : (
            <View style={{ gap: 4 }}>
              {brandStores.map((s) => {
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

// ─── Field input — same shape as VendorFormDrawer's helper ──────────
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
          ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
        }}
      />
    </View>
  );
}

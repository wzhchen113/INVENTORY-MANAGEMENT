import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsPhone } from '../../theme/breakpoints';
import { inviteUser } from '../../lib/auth';
import { useIsMaster } from '../../hooks/useRole';
import { validateUsername } from '../../lib/usernameValidation';

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
  username: string;
  role: RoleChoice;
  storeIds: string[];
}

const blank = (): FormValues => ({
  email: '',
  name: '',
  username: '',
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

  // Spec 029 — shared hook (replaces the inline `isMaster` predicate
  // previously derived from `currentUser.role`). Same gate semantics:
  // master + super_admin together unlock the admin/user role picker
  // below; non-master admins are hard-locked to role='user'.
  const isMaster = useIsMaster();

  const [values, setValues] = React.useState<FormValues>(blank);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    setValues({
      email: '',
      name: '',
      username: '',
      // Spec 029 — both master and non-master admins default new invites
      // to `role='user'`; master can switch to admin via the role picker
      // below (non-master admins do not see the picker at all).
      role: 'user',
      storeIds: [],
    });
    setSubmitting(false);
  }, [visible]);

  // For role='admin' invitations we need a brandId. The current brand
  // comes from useStore.brand?.id.
  const brandId = brand?.id ?? null;

  // Spec 068 §2 — the STORES multi-select must be scoped to the active
  // brand, not the global store cache. `useStore.stores` is a global
  // cache reused across the app (db.ts fetchStores has no brand filter),
  // so we filter at the consumer. When no brand is active (super-admin
  // "All brands" view, brandId === null) this is empty and we render the
  // brand-required notice below instead of the checkbox list.
  const brandStores = React.useMemo(
    () => stores.filter((s) => s.brandId === brandId),
    [stores, brandId],
  );

  // Spec 068 §2 — stale-selection hygiene. `storeIds` persists in form
  // state across a header brand-switch while the drawer is open. Since
  // options are now brand-filtered, a store checked under the OLD brand
  // would be invisible but still in `storeIds`, inflating the counter and
  // leaking a cross-brand store name into the handleSave email join.
  // Prune `storeIds` to the active brand's store set whenever the brand
  // changes (mirrors the visible-keyed reset effect above).
  React.useEffect(() => {
    if (!visible) return;
    const allowed = new Set(brandStores.map((s) => s.id));
    setValues((p) => {
      const pruned = p.storeIds.filter((id) => allowed.has(id));
      // Avoid a no-op state write (and the extra render) when nothing
      // was stale — keeps the effect idempotent across re-renders.
      return pruned.length === p.storeIds.length ? p : { ...p, storeIds: pruned };
    });
    // Keyed on brandId, not brandStores, so the prune fires once per
    // brand switch rather than on every `stores` cache refresh.
    // `brandStores` identity changes only when brandId changes (the
    // useMemo above), so keying on brandId here is equivalent — if that
    // useMemo's deps ever change, revisit this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, visible]);

  // Spec 095 — username is OPTIONAL on invite (existing-users-keep-email
  // posture: an invite can omit it and the user logs in by email until one is
  // assigned). But WHEN provided it must satisfy the shared validator (3–20,
  // [A-Za-z0-9_.], not reserved). The validator runs only on a non-empty
  // trimmed value so a blank field is not flagged. Server-side uniqueness
  // (the lower() UNIQUE index → 23505) is surfaced separately in handleSave.
  const usernameTrimmed = values.username.trim();
  const usernameCheck = usernameTrimmed.length > 0 ? validateUsername(usernameTrimmed) : { ok: true as const };
  const usernameError = usernameCheck.ok ? null : usernameCheck.error;

  const requiredValid =
    values.email.trim().length > 0 &&
    values.name.trim().length > 0 &&
    !usernameError &&
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
    // Spec 068 §2 — resolve names against the brand-filtered list, not
    // the global `stores`, so a stale storeId from a brand-switch can't
    // leak a cross-brand store name into the invite email. Defense in
    // depth; the prune effect + filtered options already prevent it.
    const storeNames = values.storeIds
      .map((id) => brandStores.find((s) => s.id === id)?.name)
      .filter(Boolean)
      .join(', ');
    // Spec 090 — derive the user (non-admin) invite's brand from its assigned
    // stores rather than discarding it as null. The store multi-select is
    // already brand-filtered to the single active brand (brandStores, spec
    // 068), so storeIds[0]'s brand is unambiguous — this mirrors the
    // server-side COALESCE(brand_id, brand of first store) derivation in
    // get_pending_invitation.resolved_brand_id (spec 069). The store-first
    // form (`brandStores.find(...storeIds[0]).brandId`) makes the written
    // value provably the brand of the assigned store; `?? brandId` is the
    // practical result under today's single-active-brand UI. A zero-store
    // user invite stays null (legitimate — the profile is stamped later at
    // register time once a store is assigned). Admin path is unchanged
    // (passes brandId verbatim; the missing-brand error fires in inviteUser).
    // NB: storeIds[0] is JS 0-indexed; the RPC's store_ids[1] is Postgres
    // 1-indexed — same first store, do not introduce an off-by-one.
    const derivedBrandId =
      values.role === 'admin'
        ? brandId
        : values.storeIds.length > 0
          ? (brandStores.find((s) => s.id === values.storeIds[0])?.brandId ?? brandId ?? null)
          : null;
    const result = await inviteUser({
      email: values.email.trim(),
      name: values.name.trim(),
      role: values.role,
      brandId: derivedBrandId,
      storeIds: values.storeIds,
      storeNames,
      // Spec 095 — null when blank (user logs in by email until assigned).
      username: usernameTrimmed.length > 0 ? usernameTrimmed : null,
    });
    setSubmitting(false);
    if (result.error) {
      // Spec 095 — map the PostgREST unique-violation on the username index to
      // the human-readable "username taken". Distinct from the generic login
      // oracle: this is an authenticated, brand-scoped admin action where
      // revealing the collision is intended. Discriminate on the ACTUAL index
      // name `profiles_username_lower_key` so an unrelated 23505 (e.g. a
      // duplicate-email invitation) is NOT mislabeled as a username collision
      // (code-reviewer #2 / security-auditor Low-3 / backend-architect M2).
      const isUsernameTaken =
        usernameTrimmed.length > 0 &&
        /profiles_username_lower_key/i.test(result.error);
      Toast.show({
        type: 'error',
        text1: 'Invite failed',
        text2: isUsernameTaken ? `Username "${usernameTrimmed}" is already taken` : result.error,
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
        testID="invite-submit"
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
          testID="invite-email"
          label="Email"
          value={values.email}
          onChange={set('email')}
          placeholder="bobby@example.com"
          autoFocus
        />
        <Field
          testID="invite-name"
          label="Display name"
          value={values.name}
          onChange={set('name')}
          placeholder="Bobby Bobson"
        />

        {/* Spec 095 — admin-assigned username (optional). When set, the user
            can log in with it OR their email. Validated against the shared
            usernameValidation rules; uniqueness is enforced server-side. */}
        <View style={{ gap: 4 }}>
          <Field
            testID="invite-username"
            label="Username (optional)"
            value={values.username}
            // Spec 095 — usernames are stored case-folded (auth.ts inviteUser
            // lowercases on write; the lower() UNIQUE index compares folded).
            // Lowercase as the admin types so the DISPLAYED value matches the
            // stored value — "Bobby_B" would silently persist as "bobby_b"
            // otherwise (code-reviewer #3 / release-proposal step 5).
            onChange={(v) => set('username')(v.toLowerCase())}
            placeholder="bobby_b"
          />
          {usernameError ? (
            <Text testID="invite-username-error" style={{ fontFamily: sans(400), fontSize: 10.5, color: C.warn }}>
              {usernameError}
            </Text>
          ) : (
            <Text style={{ fontFamily: sans(400), fontSize: 10.5, color: C.fg3 }}>
              3–20 characters · letters, numbers, _ and . · leave blank to use email only
            </Text>
          )}
        </View>

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
                    testID={`invite-role-${r}`}
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
            {brandId ? (
              // Counter only makes sense once a brand is active — in the
              // no-brand view there's nothing to select, so "0 of 0" would
              // be noise alongside the no-brand notice below.
              <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                · {values.storeIds.length} of {brandStores.length} selected
              </Text>
            ) : null}
          </View>
          {!brandId ? (
            // Spec 068 §2 — no-brand notice (super-admin "All brands"
            // view). Distinct from the "No stores visible yet" copy
            // below: that copy tells the operator the invite can still
            // proceed, which is wrong here — without a brand there is no
            // brand-scoped store set to pick from. Modeled on the
            // admin-role brand-required warning block above.
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
                Switch into a brand first to assign stores
              </Text>
              <Text style={{ fontFamily: sans(400), fontSize: 11.5, color: C.fg2, marginTop: 4 }}>
                Store access is scoped to a single brand. Pick a brand from the header brand picker, then re-open this drawer to choose its stores.
              </Text>
            </View>
          ) : brandStores.length === 0 ? (
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
              {brandStores.map((s) => {
                const isSelected = values.storeIds.includes(s.id);
                return (
                  <TouchableOpacity
                    key={s.id}
                    testID={`invite-store-${s.id}`}
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
        testID={testID}
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

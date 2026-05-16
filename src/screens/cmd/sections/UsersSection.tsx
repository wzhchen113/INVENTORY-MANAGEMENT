import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { TypeToConfirmModal } from '../../../components/cmd/TypeToConfirmModal';
import { InviteUserDrawer } from '../../../components/cmd/InviteUserDrawer';
import { fetchAllUsers, sendPasswordReset } from '../../../lib/auth';
import { User } from '../../../types';
import { useIsMaster } from '../../../hooks/useRole';
import { canDeleteUser, deriveLastOfRole } from '../../../utils/userPermissions';
import { useT } from '../../../hooks/useT';

// Spec 025 §2 — admin-global users surface. Replaces the legacy
// UsersScreen from AdminScreens.tsx (master role + admin role + store
// user invites + deletes + password reset). Reads server-truth via
// fetchAllUsers; mutations refetch on success. No realtime channel
// (PM Background §13 — user/invite changes are rare enough that
// on-mount + post-action fetch is sufficient).

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 6) : id;
}

function roleLabel(role: User['role']): string {
  switch (role) {
    case 'super_admin': return 'Super admin';
    case 'master':      return 'Master';
    case 'admin':       return 'Admin';
    case 'user':        return 'Store user';
    default:            return role;
  }
}

export default function UsersSection() {
  const C = useCmdColors();
  const T = useT();
  const isMaster = useIsMaster();
  const currentUser = useStore((s) => s.currentUser);
  const stores = useStore((s) => s.stores);
  const brand = useStore((s) => s.brand);
  const deleteProfile = useStore((s) => s.deleteProfile);
  const logout = useStore((s) => s.logout);

  const [users, setUsers] = React.useState<User[] | null>(null);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<User | null>(null);
  const [tabId, setTabId] = React.useState('users.tsx');

  const refresh = React.useCallback(async () => {
    // Spec 025 §2.G — fetchAllUsers({ brandId }) filters by brand_id
    // server-side. We pass currentUser.brandId when set so non-super
    // admins only see users in their brand. Super-admin (brandId=null)
    // sees every brand.
    const opts = brand?.id ? { brandId: brand.id } : undefined;
    const fetched = await fetchAllUsers(opts);
    setUsers(fetched);
  }, [brand?.id]);

  React.useEffect(() => {
    refresh().catch((e) => {
      console.warn('[UsersSection] initial fetch failed:', e?.message || e);
    });
  }, [refresh]);

  const loading = users === null;
  // Non-master admins do not see other master/super_admin rows. Master
  // sees everyone. Mirrors legacy AdminScreens.tsx:1386.
  const rawUsers = users || [];
  // Spec 031 — derive last-of-role counts from the same fetched users
  // array. The server is the authoritative gate (delete-user edge fn
  // calls public.assert_not_last_of_role); this is a UX hint that hides
  // the DELETE button when the server would refuse. Counts derive from
  // rawUsers (the full fetched set), NOT visibleUsers, so the count
  // matches what the server sees for the caller's brand scope.
  // Spec 033 — extracted to `deriveLastOfRole` for unit-test coverage.
  const lastOfRole = deriveLastOfRole(rawUsers);
  const visibleUsers = isMaster
    ? rawUsers
    : rawUsers.filter((u) => u.role !== 'master' && u.role !== 'super_admin');

  const handleSendReset = async (u: User) => {
    if (!u.email) {
      Toast.show({
        type: 'error',
        text1: 'No email on file',
        text2: 'Cannot send password reset — this user has no email address recorded.',
        visibilityTime: 4000,
      });
      return;
    }
    const result = await sendPasswordReset(u.email);
    if (result.error) {
      Toast.show({
        type: 'error',
        text1: 'Password reset failed',
        text2: result.error,
        visibilityTime: 5000,
      });
      return;
    }
    Toast.show({
      type: 'success',
      text1: 'Password reset email sent',
      text2: u.email,
      visibilityTime: 4000,
    });
  };

  const handleConfirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    const isSelf = target.id === currentUser?.id;
    const ok = await deleteProfile(target.id, isSelf ? { silent: true } : undefined);
    if (!ok) return;
    setDeleteTarget(null);
    if (isSelf) {
      Toast.show({
        type: 'success',
        text1: 'Account deleted',
        text2: 'Signing out…',
        visibilityTime: 2000,
      });
      logout();
      if (Platform.OS === 'web') {
        setTimeout(() => { window.location.href = '/'; }, 1500);
      }
    } else {
      // deleteProfile already toasts success; refresh the local list.
      refresh().catch(() => {});
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[{ id: 'users.tsx', label: 'users.tsx' }]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          <TouchableOpacity
            onPress={() => setInviteOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Invite user"
            style={{
              paddingVertical: 4,
              paddingHorizontal: 10,
              backgroundColor: C.accent,
              borderRadius: CmdRadius.sm,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>+ INVITE USER</Text>
          </TouchableOpacity>
        }
      />

      <ScrollView contentContainerStyle={{ padding: 22, gap: 14, paddingBottom: 80 }}>
        {/* Hero */}
        <View>
          <Text style={[Type.h1, { color: C.fg }]}>{T('section.users.title')}</Text>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            Invite admins and store users, manage role assignments, reset passwords, and remove accounts.
          </Text>
        </View>

        {/* Loading */}
        {loading ? (
          <View
            style={{
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              paddingVertical: 36,
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>LOADING…</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2 }}>fetching user list</Text>
          </View>
        ) : visibleUsers.length === 0 ? (
          <View
            style={{
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              paddingVertical: 36,
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>NO USERS</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 380 }}>
              Click "+ INVITE USER" to send the first invitation.
            </Text>
          </View>
        ) : (
          <View
            style={{
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              overflow: 'hidden',
            }}
          >
            {visibleUsers.map((u, i) => (
              <UserRow
                key={u.id}
                user={u}
                isFirst={i === 0}
                isMaster={isMaster}
                currentUserId={currentUser?.id || ''}
                stores={stores}
                lastOfRole={lastOfRole}
                onDelete={() => setDeleteTarget(u)}
                onResetPassword={() => handleSendReset(u)}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <InviteUserDrawer
        visible={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={() => { refresh().catch(() => {}); }}
      />

      {deleteTarget ? (
        <TypeToConfirmModal
          visible
          title={
            deleteTarget.id === currentUser?.id
              ? 'Delete your account'
              : `Delete ${deleteTarget.name || deleteTarget.email}`
          }
          description={
            deleteTarget.id === currentUser?.id
              ? `This will permanently delete your account${deleteTarget.email ? ` (${deleteTarget.email})` : ''} and sign you out. This cannot be undone.`
              : `This will permanently delete ${deleteTarget.name || 'this user'}${deleteTarget.email ? ` (${deleteTarget.email})` : ''}. Both the profile row and the auth user are removed. The human user will no longer be able to log in. This cannot be undone.`
          }
          requiredText={deleteTarget.email || deleteTarget.name || ''}
          destructiveLabel="DELETE USER"
          destructiveTone="danger"
          onConfirm={handleConfirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </View>
  );
}

// ─── User row ───────────────────────────────────────────────────────
function UserRow({
  user, isFirst, isMaster, currentUserId, stores, lastOfRole, onDelete, onResetPassword,
}: {
  user: User;
  isFirst: boolean;
  isMaster: boolean;
  currentUserId: string;
  stores: ReturnType<typeof useStore.getState>['stores'];
  lastOfRole: { super_admin: boolean; master: boolean };
  onDelete: () => void;
  onResetPassword: () => void;
}) {
  const C = useCmdColors();
  const isSelf = !!currentUserId && user.id === currentUserId;

  // Spec 025 AC24 — delete gates (updated in spec 030 to strip self-delete,
  // spec 031 to suppress last-of-role):
  //   - Master / super_admin: can delete anyone except self.
  //   - Non-master admin: can delete `user` rows. Cannot delete self
  //     (the `delete-user` edge function rejects self-delete with HTTP
  //     400 — surface no affordance) or other admins / master.
  //   - Spec 031: also suppress DELETE on the last super_admin / master
  //     (would otherwise hit a server HTTP 400 from
  //     public.assert_not_last_of_role). Server is authoritative; this
  //     is a UX hint, not security.
  // Spec 033 — extracted to `canDeleteUser` for unit-test coverage.
  const canDelete = canDeleteUser({ isMaster, isSelf, targetRole: user.role, lastOfRole });

  // Spec 025 AC25 — password-reset gates:
  //   - Master / super_admin: can reset anyone EXCEPT master/super_admin
  //     itself (would orphan the project — surface via a separate ops
  //     path if it ever becomes needed). Self-reset also blocked since
  //     the standard "forgot password" link in the login screen covers
  //     the operator's own account.
  //   - Non-master admin: can reset only `user`-role rows (not other
  //     admins or master).
  const canResetPassword = isMaster
    ? !isSelf && user.role !== 'master' && user.role !== 'super_admin'
    : user.role === 'user' && !isSelf;

  // Store-access chips: admin / master see all stores; store users see
  // only their assigned stores. Mirrors legacy AdminScreens.tsx:1566.
  const accessibleStores =
    user.role === 'master' || user.role === 'admin' || user.role === 'super_admin'
      ? stores
      : stores.filter((s) => user.stores.includes(s.id));

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: isFirst ? 0 : 1,
        borderTopColor: C.border,
        flexWrap: 'wrap',
      }}
    >
      {/* Avatar */}
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          backgroundColor: user.color || C.accent,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 12, color: C.accentFg }}>{user.initials}</Text>
      </View>

      {/* Identity */}
      <View style={{ flex: 1, minWidth: 200, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }}>
            {user.name || '—'}
          </Text>
          {isSelf ? (
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>(you)</Text>
          ) : null}
        </View>
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }} numberOfLines={1}>
          {user.email || '(email not loaded)'} · {shortId(user.id)}
        </Text>
        {/* Store chips */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
          {accessibleStores.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>no stores assigned</Text>
          ) : (
            accessibleStores.map((s) => (
              <View
                key={s.id}
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: CmdRadius.xs,
                  backgroundColor: C.panel2,
                  borderWidth: 1,
                  borderColor: C.border,
                }}
              >
                <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>{s.name}</Text>
              </View>
            ))
          )}
        </View>
      </View>

      {/* Role + Status badges */}
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: CmdRadius.xs,
            backgroundColor: C.panel2,
            borderWidth: 1,
            borderColor: C.border,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 9, color: C.fg2, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {roleLabel(user.role)}
          </Text>
        </View>
        <StatusPill
          status={user.status === 'active' ? 'ok' : 'low'}
          label={user.status === 'active' ? 'ACTIVE' : 'PENDING'}
        />
      </View>

      {/* Actions */}
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        {canResetPassword ? (
          <TouchableOpacity
            onPress={onResetPassword}
            accessibilityRole="button"
            accessibilityLabel={`Send password reset to ${user.name || user.email}`}
            style={{
              paddingVertical: 5,
              paddingHorizontal: 9,
              borderRadius: CmdRadius.sm,
              borderWidth: 1,
              borderColor: C.borderStrong,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg2 }}>RESET PW</Text>
          </TouchableOpacity>
        ) : null}
        {canDelete ? (
          <TouchableOpacity
            onPress={onDelete}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${user.name || user.email}`}
            style={{
              paddingVertical: 5,
              paddingHorizontal: 9,
              borderRadius: CmdRadius.sm,
              borderWidth: 1,
              borderColor: C.danger,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.danger }}>DELETE</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

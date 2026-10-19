// src/screens/cmd/sections/phone/PhoneUsers.tsx — Spec 146.
//
// The phone-tier "Users & access" surface (README §7–17 shared list shell +
// Hard Rule 1 full-screen detail). The desktop UsersSection (TabStrip + a
// single-column ScrollView of wrapping multi-column rows) becomes a full-width
// two-line card list → full-screen drill-in detail, plus a 48px "+ INVITE"
// primary that opens the production InviteUserDrawer (reused verbatim — no fork
// of the send/validation path) and a DELETE that reuses the desktop
// TypeToConfirmModal (same last-of-role / self-guard semantics).
//
// Data + handlers are LIFTED from UsersSection in a `model` bundle (the spec
// 145 PhoneDashboard pattern): the host still owns fetchAllUsers + refresh +
// deleteProfile + the invite/delete overlay STATE, so this file forks no
// orchestration. Role pills use semantic tokens (ADMIN/SUPER-ADMIN = info,
// MASTER = ok, STORE USER = neutral) — NEVER the accent (README §91).

import React from 'react';
import { View, Text, TouchableOpacity, FlatList, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useT } from '../../../../hooks/useT';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';
import { TwoLineRow, PropertyCard } from './PhoneWidgets';
import { StatusPill } from '../../../../components/cmd/StatusPill';
import { InviteUserDrawer } from '../../../../components/cmd/InviteUserDrawer';
import { AddStoreUserDrawer } from '../../../../components/cmd/AddStoreUserDrawer';
import { SetStoreUserPasswordModal } from '../../../../components/cmd/SetStoreUserPasswordModal';
import { TypeToConfirmModal } from '../../../../components/cmd/TypeToConfirmModal';
import { roleLabel, userStatusLabel } from '../../../../utils/enumLabels';
import { canDeleteUser, deriveAccessibleStores } from '../../../../utils/userPermissions';
import { isUsernameLogin, userConfirmText, userIdentityLine } from '../../../../utils/userIdentity';
import type { Store, User } from '../../../../types';

// ── Role-pill tone ─────────────────────────────────────────────────────────────
// Pure mapping so the "never the accent" guarantee is unit-testable. The four
// stored roles collapse onto README §7-17's three-tone scheme:
//   admin / super_admin → info    (admin tier)
//   master              → ok       (manager-equivalent)
//   user (store staff)  → neutral  (panel2/fg2 chrome, no status color)
export type RolePillTone = 'info' | 'ok' | 'neutral';

export function rolePillTone(role: User['role']): RolePillTone {
  if (role === 'admin' || role === 'super_admin') return 'info';
  if (role === 'master') return 'ok';
  return 'neutral';
}

const RolePill: React.FC<{ role: User['role'] }> = ({ role }) => {
  const C = useCmdColors();
  const T = useT();
  const tone = rolePillTone(role);
  const fg = tone === 'info' ? C.info : tone === 'ok' ? C.ok : C.fg2;
  const bg = tone === 'info' ? C.infoBg : tone === 'ok' ? C.okBg : C.panel2;
  const border = tone === 'info' ? C.info : tone === 'ok' ? C.ok : C.border;
  return (
    <View
      style={{
        paddingHorizontal: 9,
        paddingVertical: 2,
        borderRadius: CmdRadius.pill,
        borderWidth: 0.5,
        borderColor: border,
        backgroundColor: bg,
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, letterSpacing: 0.5, color: fg, textTransform: 'uppercase' }}>
        {roleLabel(role, T)}
      </Text>
    </View>
  );
};

// ── Model (lifted from UsersSection) ────────────────────────────────────────────
export interface PhoneUsersModel {
  loading: boolean;
  /** Peer-filtered user rows (non-master admins don't see master/super_admin). */
  visibleUsers: User[];
  isMaster: boolean;
  currentUserId: string;
  stores: Store[];
  lastOfRole: { super_admin: boolean; master: boolean };
  /** Invite-drawer visibility (host state, so the desktop path is unchanged). */
  inviteOpen: boolean;
  setInviteOpen: (v: boolean) => void;
  /** Delete-modal target (host state → same last-of-role/self-guard flow). */
  deleteTarget: User | null;
  setDeleteTarget: (u: User | null) => void;
  /** Host's handleConfirmDelete (self-delete → logout, else refresh). */
  onConfirmDelete: () => void;
  /** Host's handleSendReset. */
  onResetPassword: (u: User) => void;
  /** Host's refresh — re-fetches so a fresh invite lands as an INVITED row. */
  onInvited: () => void;
  /** Spec 165 — Add-store-user drawer visibility (host state). Its
   *  onCreated reuses `onInvited` (the host refresh). */
  addOpen: boolean;
  setAddOpen: (v: boolean) => void;
  /** Spec 165 — SET PASSWORD target for a username-only row (host state). */
  setPasswordTarget: User | null;
  setSetPasswordTarget: (u: User | null) => void;
}

// Spec 165 — the email-or-username identity line for a row / detail subtitle.
// Username-only accounts render `@username · username sign-in`; the data layer
// already cleared their placeholder email, so it can never appear here.
function identityLine(u: User, T: (key: string, vars?: Record<string, string | number>) => string): string {
  return userIdentityLine(u, T('section.users.usernameSignIn'), {
    emailFallback: T('section.users.phone.noEmail'),
  });
}

// ── Detail ───────────────────────────────────────────────────────────────────
function UserDetail({ user, model }: { user: User; model: PhoneUsersModel }) {
  const C = useCmdColors();
  const T = useT();

  const isSelf = !!model.currentUserId && user.id === model.currentUserId;
  const canDelete = canDeleteUser({
    isMaster: model.isMaster,
    isSelf,
    targetRole: user.role,
    lastOfRole: model.lastOfRole,
  });
  const canResetPassword = model.isMaster
    ? !isSelf && user.role !== 'master' && user.role !== 'super_admin'
    : user.role === 'user' && !isSelf;
  // Spec 165 — SET PASSWORD replaces RESET PW for username-only accounts.
  // Role 'user' only (architect M7) — the server refuses any other target.
  const usernameLogin = isUsernameLogin(user);
  const showResetPw = canResetPassword && !usernameLogin;
  const showSetPassword = canResetPassword && usernameLogin && user.role === 'user';

  const accessibleStores = deriveAccessibleStores(user, model.stores);
  const storesValue =
    accessibleStores.length === 0
      ? T('section.users.phone.noStores')
      : accessibleStores.map((s) => s.name).join(', ');

  const propRows = [
    { label: T('section.users.phone.propRole'), value: roleLabel(user.role, T) },
    { label: T('section.users.phone.propStores'), value: storesValue },
    { label: T('section.users.phone.propStatus'), value: userStatusLabel(user.status, T) },
    ...(user.username ? [{ label: T('section.users.phone.propUsername'), value: user.username }] : []),
  ];

  return (
    <View style={{ padding: 16, gap: 16 }}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <RolePill role={user.role} />
          {isSelf ? (
            <Text style={[PhoneType.microCaption, { color: C.fg3 }]}>{T('section.users.phone.you')}</Text>
          ) : null}
        </View>
        <Text style={[PhoneType.detailTitle, { color: C.fg }]}>{user.name || '—'}</Text>
        <Text testID="phone-user-identity" style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
          {identityLine(user, T)}
        </Text>
      </View>

      <PropertyCard testID="phone-user-properties" title={T('section.users.phone.properties')} rows={propRows} />

      {/* Actions — only the desktop-reusable ones (reset / delete). No fake
          edit form: there is no desktop role-edit affordance to mirror. */}
      {canResetPassword || canDelete ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {showSetPassword ? (
            <TouchableOpacity
              testID="phone-user-set-password"
              onPress={() => model.setSetPasswordTarget(user)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={T('section.users.phone.setPw')}
              style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.fg2 }}>
                {T('section.users.phone.setPw')}
              </Text>
            </TouchableOpacity>
          ) : null}
          {showResetPw ? (
            <TouchableOpacity
              testID="phone-user-reset"
              onPress={() => model.onResetPassword(user)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={T('section.users.phone.resetPw')}
              style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.fg2 }}>
                {T('section.users.phone.resetPw')}
              </Text>
            </TouchableOpacity>
          ) : null}
          {canDelete ? (
            <TouchableOpacity
              testID="phone-user-delete"
              onPress={() => model.setDeleteTarget(user)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={T('section.users.phone.deleteUser')}
              style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.danger, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.danger }}>
                {T('section.users.phone.deleteUser')}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────
export const PhoneUsers: React.FC<{ model: PhoneUsersModel }> = ({ model }) => {
  const C = useCmdColors();
  const T = useT();
  const drill = usePhoneDrill<User>();

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4 }}>
      <Text style={[PhoneType.screenTitle, { color: C.fg, flex: 1 }]} numberOfLines={1}>
        {T('section.users.title')}
      </Text>
      <Text style={[PhoneType.microCaption, { color: C.fg3 }]}>
        {T('section.users.phone.count', { n: model.visibleUsers.length })}
      </Text>
    </View>
  );

  const listBody = model.loading ? (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={[PhoneType.caption, { color: C.fg3 }]}>{T('section.users.phone.loading')}</Text>
    </View>
  ) : (
    <FlatList
      testID="phone-users-flatlist"
      style={{ flex: 1, minHeight: 0, backgroundColor: C.bg }}
      data={model.visibleUsers}
      keyExtractor={(u) => u.id}
      initialNumToRender={14}
      windowSize={7}
      removeClippedSubviews={Platform.OS !== 'web'}
      ListEmptyComponent={
        <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>
          {T('section.users.phone.empty')}
        </Text>
      }
      renderItem={({ item: u }) => {
        const storeCount = deriveAccessibleStores(u, model.stores).length;
        return (
          <TwoLineRow
            testID={`phone-user-row-${u.id}`}
            pill={<RolePill role={u.role} />}
            name={u.name || (isUsernameLogin(u) ? (u.username ? `@${u.username}` : '—') : (u.email || '—'))}
            rightValue={
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>
                {T('section.users.phone.storesTag', { n: storeCount })}
              </Text>
            }
            meta={
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
                {identityLine(u, T)}
              </Text>
            }
            line2Right={
              u.status === 'pending' ? (
                <StatusPill status="low" label={T('section.users.phone.invited')} />
              ) : null
            }
            onPress={() => drill.open(u)}
          />
        );
      }}
    />
  );

  const listNode = (
    <View style={{ flex: 1 }}>
      {header}
      {listBody}
      {/* + INVITE — 48px primary, thumb-reachable at the bottom (PhoneWasteLog
          idiom). Opens the reused InviteUserDrawer via host state. Spec 165
          adds + ADD USER (outlined, same 48px) beside it. */}
      <View style={{ padding: 14, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', gap: 10 }}>
        <TouchableOpacity
          testID="phone-users-add"
          onPress={() => model.setAddOpen(true)}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={T('section.users.addUser')}
          style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.accent, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.accent }}>
            {T('section.users.phone.add')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="phone-users-invite"
          onPress={() => model.setInviteOpen(true)}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={T('section.users.inviteUser')}
          style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.accentFg }}>
            {T('section.users.phone.invite')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <PhoneDrillScaffold
        testID="phone-users"
        parentCaption={T('section.users.phone.parentCaption')}
        onBack={drill.close}
        list={listNode}
        detail={drill.selected ? <UserDetail user={drill.selected} model={model} /> : null}
      />

      {/* Reused overlays — mounted here (not the desktop return) so the phone
          early-return still gets the real invite/delete surfaces. */}
      <InviteUserDrawer
        visible={model.inviteOpen}
        onClose={() => model.setInviteOpen(false)}
        onInvited={model.onInvited}
      />

      <AddStoreUserDrawer
        visible={model.addOpen}
        onClose={() => model.setAddOpen(false)}
        onCreated={model.onInvited}
      />

      <SetStoreUserPasswordModal
        target={model.setPasswordTarget}
        onClose={() => model.setSetPasswordTarget(null)}
      />

      {model.deleteTarget ? (
        <TypeToConfirmModal
          visible
          title={
            model.deleteTarget.id === model.currentUserId
              ? T('section.users.phone.deleteSelfTitle')
              : T('section.users.phone.deleteTitle', { name: model.deleteTarget.name || userConfirmText(model.deleteTarget) })
          }
          description={
            model.deleteTarget.id === model.currentUserId
              ? T('section.users.phone.deleteSelfBody')
              : T('section.users.phone.deleteBody', { name: model.deleteTarget.name || T('section.users.phone.thisUser') })
          }
          // Spec 165 — username accounts confirm by username, never email.
          requiredText={userConfirmText(model.deleteTarget)}
          destructiveLabel={T('section.users.phone.deleteUser')}
          destructiveTone="danger"
          onConfirm={model.onConfirmDelete}
          onClose={() => model.setDeleteTarget(null)}
        />
      ) : null}
    </View>
  );
};

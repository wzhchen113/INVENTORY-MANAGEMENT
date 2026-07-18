import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { UserRole } from '../../types';

export type Role = UserRole;

interface Props {
  /** Optional — when omitted, defaults to "ADMIN" so legacy call sites
   *  keep their existing visual. Spec 012b — pass the live currentUser
   *  role so super_admin renders distinctively. */
  role?: Role;
}

// Spec 012b — surfaces the user's actual profiles.role. Super-admin gets
// the warn-toned variant so it's visibly different from the operational
// admin badge; admin/master/user all share the accent variant since the
// app today is admin-only and the master/user labels would just confuse
// the operator (master = display alias for the seeded admin; user is
// a staff role that doesn't reach this app).
const labelFor = (role: Role): string => {
  switch (role) {
    case 'super_admin': return 'super admin';
    case 'master':      return 'master';
    case 'admin':       return 'admin';
    case 'user':        return 'user';
    default:            return 'admin';
  }
};

export const RoleBadge: React.FC<Props> = ({ role = 'admin' }) => {
  const C = useCmdColors();
  const isSuper = role === 'super_admin';
  const fg = isSuper ? C.warn : C.accent;
  const bg = isSuper ? C.warnBg : C.accentBg;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 9,
        paddingVertical: 2,
        borderRadius: CmdRadius.pill,
        borderWidth: 0.5,
        borderColor: fg,
        backgroundColor: bg,
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: fg }}>◆</Text>
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 9.5,
          letterSpacing: 0.5,
          color: fg,
          textTransform: 'uppercase',
        }}
      >
        {labelFor(role)}
      </Text>
    </View>
  );
};

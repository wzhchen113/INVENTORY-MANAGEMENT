import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';

export type Role = 'admin' | 'staff';

interface Props {
  role: Role;
}

// Filled accent for admin; ghost panel2 with fg2 text for staff. Glyph + label
// in mono 9.5/700 caps, letter-spacing 0.5 — matches the StatusPill rhythm.
export const RoleBadge: React.FC<Props> = ({ role }) => {
  const C = useCmdColors();
  const isAdmin = role === 'admin';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: CmdRadius.xs,
        borderWidth: 1,
        borderColor: isAdmin ? C.accent : C.border,
        backgroundColor: isAdmin ? C.accentBg : C.panel2,
        alignSelf: 'flex-start',
      }}
    >
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 9.5,
          color: isAdmin ? C.accent : C.fg2,
        }}
      >
        {isAdmin ? '◆' : '○'}
      </Text>
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 9.5,
          letterSpacing: 0.5,
          color: isAdmin ? C.accent : C.fg2,
          textTransform: 'uppercase',
        }}
      >
        {role}
      </Text>
    </View>
  );
};

import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';

export type Role = 'admin';

interface Props {
  /** Optional — kept for back-compat with existing call sites. Always 'admin'. */
  role?: Role;
}

// Admin-only app — the badge always renders the filled accent variant. Kept
// as a component (not inlined) so the visual rhythm matches StatusPill.
export const RoleBadge: React.FC<Props> = () => {
  const C = useCmdColors();
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
        borderColor: C.accent,
        backgroundColor: C.accentBg,
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.accent }}>◆</Text>
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 9.5,
          letterSpacing: 0.5,
          color: C.accent,
          textTransform: 'uppercase',
        }}
      >
        admin
      </Text>
    </View>
  );
};

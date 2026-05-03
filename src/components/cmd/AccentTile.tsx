import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';

type Size = 22 | 26 | 32;

interface Props {
  glyph: string;
  size?: Size;
}

// Accent-bg square with a centered mono glyph. Glyph color is always black
// (per design spec) — accent contrast works against accent bg in both themes.
export const AccentTile: React.FC<Props> = ({ glyph, size = 22 }) => {
  const C = useCmdColors();
  const fontSize = size === 32 ? 16 : size === 26 ? 14 : 12;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: CmdRadius.sm,
        backgroundColor: C.accent,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize, color: '#000' }}>{glyph}</Text>
    </View>
  );
};

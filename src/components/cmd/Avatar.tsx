import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { mono } from '../../theme/typography';

interface Props {
  initials: string;
  size?: number;
}

// 18×18 round (default) with accent text on accentBg. Initials clipped to 2.
export const Avatar: React.FC<Props> = ({ initials, size = 18 }) => {
  const C = useCmdColors();
  const trimmed = initials.slice(0, 2).toUpperCase();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: C.accentBg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 9, color: C.accent }}>{trimmed}</Text>
    </View>
  );
};

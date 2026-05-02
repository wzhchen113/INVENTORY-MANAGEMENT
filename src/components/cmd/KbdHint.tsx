import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';

interface Props {
  children: React.ReactNode;
  size?: 'sm' | 'md';
}

export const KbdHint: React.FC<Props> = ({ children, size = 'md' }) => {
  const C = useCmdColors();
  const fontSize = size === 'sm' ? 9.5 : 10;
  return (
    <View
      style={{
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: CmdRadius.xs,
        borderWidth: 1,
        borderColor: C.border,
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ fontFamily: mono(500), fontSize, color: C.fg3 }}>{children}</Text>
    </View>
  );
};

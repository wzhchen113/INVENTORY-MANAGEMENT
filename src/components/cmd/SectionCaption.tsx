import React from 'react';
import { Text, TextStyle } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { mono } from '../../theme/typography';

type Tone = 'fg2' | 'fg3';

interface Props {
  children: React.ReactNode;
  tone?: Tone;
  size?: 9.5 | 10 | 10.5;
  style?: TextStyle;
}

// mono uppercase, letter-spacing 0.6, weight 600. Used for card titles like
// `STOCK_HISTORY.DAT` and tree group labels (`OPERATIONS`).
export const SectionCaption: React.FC<Props> = ({ children, tone = 'fg3', size = 10, style }) => {
  const C = useCmdColors();
  return (
    <Text
      style={[
        {
          fontFamily: mono(600),
          fontSize: size,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: tone === 'fg2' ? C.fg2 : C.fg3,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
};

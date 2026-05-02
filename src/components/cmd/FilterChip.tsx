import React from 'react';
import { TouchableOpacity, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';

interface Props {
  label: string;
  count?: number;
  selected?: boolean;
  onPress?: () => void;
}

// Pill: padding 4/9, mono 10.5/600. Selected = accent border + accentBg fill +
// accent text. Default = border + panel2 fill + fg2 text.
export const FilterChip: React.FC<Props> = ({ label, count, selected, onPress }) => {
  const C = useCmdColors();
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: CmdRadius.md,
        borderWidth: 1,
        borderColor: selected ? C.accent : C.border,
        backgroundColor: selected ? C.accentBg : C.panel2,
      }}
    >
      <Text
        style={{
          fontFamily: mono(600),
          fontSize: 10.5,
          color: selected ? C.accent : C.fg2,
        }}
      >
        {label}
      </Text>
      {count !== undefined ? (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: selected ? C.accent : C.fg3 }}>
          {count}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
};

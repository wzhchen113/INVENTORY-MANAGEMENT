import React from 'react';
import { View, Text, TextInput, ViewStyle } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { KbdHint } from './KbdHint';

interface Props {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  showKbdHint?: boolean;
  style?: ViewStyle;
}

// panel2 bg, 1px border, radius 5, padding 5/9. Mono 11 throughout —
// "filter:" prefix in fg3, user text in fg, ⌘K hint pinned right.
export const FilterInput: React.FC<Props> = ({
  value,
  onChangeText,
  placeholder = 'status:low cat:produce',
  showKbdHint = true,
  style,
}) => {
  const C = useCmdColors();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          backgroundColor: C.panel2,
          borderRadius: CmdRadius.md,
          borderWidth: 1,
          borderColor: C.border,
          paddingVertical: 5,
          paddingHorizontal: 9,
        },
        style,
      ]}
    >
      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>filter:</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.fg3}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          flex: 1,
          fontFamily: mono(400),
          fontSize: 11,
          color: C.fg,
          // remove default web outline; the outer pill border serves as focus surface
          ...(require('react-native').Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
        }}
      />
      {showKbdHint ? <KbdHint>⌘K</KbdHint> : null}
    </View>
  );
};

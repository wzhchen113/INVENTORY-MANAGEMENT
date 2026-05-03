import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { mono } from '../../theme/typography';

export interface PropertyEntry {
  key: string;
  value: string;
}

interface Props {
  entries: PropertyEntry[];
}

// Mono 11.5 / 1.7 line-height. Each row: key in fg3, value in fg, separated by
// 1px dashed border. Last row has no bottom border.
// `value` is rendered as a JSON-style quoted string when it's not numeric.
export const PropertiesJson: React.FC<Props> = ({ entries }) => {
  const C = useCmdColors();
  return (
    <View>
      {entries.map((entry, idx) => {
        const isLast = idx === entries.length - 1;
        return (
          <View
            key={entry.key}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              paddingVertical: 4,
              borderBottomWidth: isLast ? 0 : 1,
              borderBottomColor: C.border,
              borderStyle: 'dashed',
            }}
          >
            <Text
              style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg3, flex: 1, lineHeight: 20 }}
            >
              {entry.key}
            </Text>
            <Text
              style={{
                fontFamily: mono(400),
                fontSize: 11.5,
                color: C.fg,
                lineHeight: 20,
                textAlign: 'right',
                flexShrink: 0,
              }}
            >
              {entry.value}
            </Text>
          </View>
        );
      })}
    </View>
  );
};

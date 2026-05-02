import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { sans, mono, Type } from '../../theme/typography';
import { KbdHint } from './KbdHint';

export interface TreeItem {
  id: string;
  label: string;
  /** Optional kbd hint pill on the right (e.g. "⌘I"). */
  kbd?: string;
  selected?: boolean;
  /** Strikethrough + opacity-42 — used for staff "Admin-only" restricted items. */
  restricted?: boolean;
  onPress?: () => void;
}

interface Props {
  label: string;
  items: TreeItem[];
  /** When true, just show the label (no chevron rotation). Reserved for future. */
  collapsed?: boolean;
  /** Mobile drawer uses 3px selected-state border; desktop sidebar uses 3px too. */
  selectedBorderWidth?: 3;
}

// Group label (mono caps fg3 + ▾ chevron) followed by items. Each item: 4/14
// padding (with 26px left indent for the row text), sans 12.5, color fg2.
// Selected = accentBg bg, fg color, 3px solid accent left border.
export const TreeGroup: React.FC<Props> = ({ label, items, selectedBorderWidth = 3 }) => {
  const C = useCmdColors();
  return (
    <View style={{ paddingVertical: 4 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 14,
          paddingVertical: 6,
        }}
      >
        <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5 }]}>▾ {label}</Text>
      </View>
      {items.map((item) => {
        const indent = item.selected ? 26 - selectedBorderWidth : 26;
        return (
          <TouchableOpacity
            key={item.id}
            onPress={item.onPress}
            disabled={item.restricted}
            activeOpacity={0.85}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: indent,
              paddingRight: 14,
              borderLeftWidth: item.selected ? selectedBorderWidth : 0,
              borderLeftColor: C.accent,
              backgroundColor: item.selected ? C.accentBg : 'transparent',
              opacity: item.restricted ? 0.42 : 1,
            }}
          >
            <Text
              style={{
                fontFamily: sans(item.selected ? 600 : 400),
                fontSize: 12.5,
                color: item.selected ? C.fg : C.fg2,
                flex: 1,
                textDecorationLine: item.restricted ? 'line-through' : 'none',
              }}
              numberOfLines={1}
            >
              {item.label}
            </Text>
            {item.restricted ? (
              <Text style={{ fontFamily: mono(500), fontSize: 9, color: C.fg3 }}>restricted</Text>
            ) : item.kbd ? (
              <KbdHint size="sm">{item.kbd}</KbdHint>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

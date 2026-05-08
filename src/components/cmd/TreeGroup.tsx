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
  /** Strikethrough + opacity-42 — used for staff "Admin-only" restricted items.
   *  Semantically: "you cannot click this". Different from hiddenByUser
   *  (which is "user chose to hide this in edit mode"). */
  restricted?: boolean;
  /** Spec 008 §0.4 / §8 — user toggled hide in edit mode.
   *  Visual: eye-off icon + opacity 0.55. NOT strikethrough.
   *  Outside of edit mode the item is filtered out entirely; this flag
   *  only ever appears when the row is rendered inside edit mode. */
  hiddenByUser?: boolean;
  onPress?: () => void;
}

interface Props {
  label: string;
  items: TreeItem[];
  /** When true, just show the label (no chevron rotation). Reserved for future. */
  collapsed?: boolean;
  /** Mobile drawer uses 3px selected-state border; desktop sidebar uses 3px too. */
  selectedBorderWidth?: 3;
  /** Spec 008 §6 — when true, render edit-mode affordances instead of the
   *  selectable row: drag handle (left), eye/eye-off toggle (right),
   *  suppress the kbd hint and selection chrome. The actual drag wiring
   *  lives in `SidebarEditMode.tsx` (web only) — this prop only controls
   *  the static visual treatment for the row. */
  editMode?: boolean;
  /** Spec 008 — toggle hide for an item from inside edit mode. */
  onToggleHide?: (id: string) => void;
}

// Group label (mono caps fg3 + ▾ chevron) followed by items. Each item: 4/14
// padding (with 26px left indent for the row text), sans 12.5, color fg2.
// Selected = accentBg bg, fg color, 3px solid accent left border.
export const TreeGroup: React.FC<Props> = ({
  label,
  items,
  selectedBorderWidth = 3,
  editMode = false,
  onToggleHide,
}) => {
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
        const indent = item.selected && !editMode ? 26 - selectedBorderWidth : 26;
        // In edit mode, use a static View — the parent edit-mode wrapper
        // owns drag + click semantics. The row should not behave like a
        // navigable button.
        if (editMode) {
          return (
            <View
              key={item.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingTop: 4,
                paddingBottom: 4,
                paddingLeft: 14,
                paddingRight: 10,
                opacity: item.hiddenByUser ? 0.55 : 1,
              }}
            >
              {/* Drag handle — six-dot grip icon */}
              <Text
                style={{
                  fontFamily: mono(700),
                  fontSize: 11,
                  color: C.fg3,
                  width: 12,
                  textAlign: 'center',
                  marginRight: 2,
                }}
                accessibilityElementsHidden
                importantForAccessibility="no"
              >
                ⠿
              </Text>
              <Text
                style={{
                  fontFamily: sans(item.hiddenByUser ? 400 : 500),
                  fontSize: 12.5,
                  color: item.hiddenByUser ? C.fg3 : C.fg2,
                  flex: 1,
                }}
                numberOfLines={1}
              >
                {item.label}
              </Text>
              {/* Eye / eye-off toggle */}
              <TouchableOpacity
                onPress={() => onToggleHide?.(item.id)}
                accessibilityRole="button"
                accessibilityLabel={item.hiddenByUser ? `Show ${item.label}` : `Hide ${item.label}`}
                hitSlop={6}
                style={{
                  paddingHorizontal: 4,
                  paddingVertical: 2,
                }}
              >
                <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg3 }}>
                  {item.hiddenByUser ? '⊘' : '◉'}
                </Text>
              </TouchableOpacity>
            </View>
          );
        }
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

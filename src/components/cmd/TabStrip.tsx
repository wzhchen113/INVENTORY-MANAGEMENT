import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, ViewStyle } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { mono } from '../../theme/typography';

export interface Tab {
  id: string;
  label: string;
}

interface Props {
  tabs: Tab[];
  activeId: string;
  onChange: (id: string) => void;
  /** Right-side slot for action buttons (EDIT, +COUNT) on desktop tab bar. */
  rightSlot?: React.ReactNode;
  /** Mobile tab strip uses flex:1 evenly-spaced tabs; desktop uses content-width. */
  fillEvenly?: boolean;
  style?: ViewStyle;
}

// Mono `*.tsx` tabs, padding 8/14. Active = fg color + 2px accent bottom
// border. Inactive = fg2. Bottom border on inactive area renders the panel
// border so the active underline reads cleanly.
export const TabStrip: React.FC<Props> = ({ tabs, activeId, onChange, rightSlot, fillEvenly, style }) => {
  const C = useCmdColors();

  const renderTabs = () =>
    tabs.map((t) => {
      const active = t.id === activeId;
      return (
        <TouchableOpacity
          key={t.id}
          onPress={() => onChange(t.id)}
          activeOpacity={0.85}
          style={{
            paddingVertical: 8,
            paddingHorizontal: 14,
            borderBottomWidth: 2,
            borderBottomColor: active ? C.accent : 'transparent',
            flex: fillEvenly ? 1 : undefined,
            alignItems: fillEvenly ? 'center' : 'flex-start',
          }}
        >
          <Text style={{ fontFamily: mono(500), fontSize: 12, color: active ? C.fg : C.fg2 }}>
            {t.label}
          </Text>
        </TouchableOpacity>
      );
    });

  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: C.panel,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
        },
        style,
      ]}
    >
      {fillEvenly ? (
        <View style={{ flexDirection: 'row', flex: 1 }}>{renderTabs()}</View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center' }}>
          {renderTabs()}
        </ScrollView>
      )}
      {rightSlot ? <View style={{ paddingRight: 12 }}>{rightSlot}</View> : null}
    </View>
  );
};

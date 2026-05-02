import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { AccentTile } from './AccentTile';
import { TreeGroup, TreeItem } from './TreeGroup';

export interface SidebarGroup {
  label: string;
  items: TreeItem[];
}

interface Props {
  groups: SidebarGroup[];
  selectedId: string;
  onSelect: (id: string) => void;
  onPaletteOpen?: () => void;
  /** Footer status — left and right halves (e.g. "● admin" / "EOD 18/24"). */
  footerLeft?: React.ReactNode;
  footerRight?: React.ReactNode;
  width?: number;
  version?: string;
}

// Desktop sidebar: 240px wide, panel bg, right border.
// Header (12/14 padding): 22×22 accent tile + "im.cmd" sans 13/600 + version pill.
// Command bar: full-width pill, panel2 bg, border, radius 5, padding 5/9.
// Tree: groups stacked.
// Footer: border-top, 8/14, mono 10.
export const Sidebar: React.FC<Props> = ({
  groups,
  selectedId,
  onSelect,
  onPaletteOpen,
  footerLeft,
  footerRight,
  width = 240,
  version = 'v2.4',
}) => {
  const C = useCmdColors();

  const itemsWithSelection = (items: TreeItem[]) =>
    items.map((it) => ({
      ...it,
      selected: it.id === selectedId,
      onPress: it.onPress ?? (() => onSelect(it.id)),
    }));

  return (
    <View
      style={{
        width,
        backgroundColor: C.panel,
        borderRightWidth: 1,
        borderRightColor: C.border,
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <View
        style={{
          paddingTop: 12,
          paddingBottom: 8,
          paddingHorizontal: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <AccentTile glyph="i" size={22} />
        <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg }}>im.cmd</Text>
        <View style={{ flex: 1 }} />
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: CmdRadius.xs,
            borderWidth: 1,
            borderColor: C.border,
          }}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{version}</Text>
        </View>
      </View>

      {/* Command bar */}
      <View style={{ paddingHorizontal: 12, paddingBottom: 6 }}>
        <TouchableOpacity
          onPress={onPaletteOpen}
          activeOpacity={0.85}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingVertical: 5,
            paddingHorizontal: 9,
            backgroundColor: C.panel2,
            borderRadius: CmdRadius.md,
            borderWidth: 1,
            borderColor: C.border,
          }}
        >
          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg3 }}>⌘P</Text>
          <Text style={{ fontFamily: sans(400), fontSize: 11, color: C.fg3 }}>Go to anything…</Text>
        </TouchableOpacity>
      </View>

      {/* Tree */}
      <ScrollView style={{ flex: 1 }}>
        {groups.map((g) => (
          <TreeGroup key={g.label} label={g.label} items={itemsWithSelection(g.items)} />
        ))}
      </ScrollView>

      {/* Footer */}
      {(footerLeft || footerRight) ? (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderTopWidth: 1,
            borderTopColor: C.border,
          }}
        >
          <View>{footerLeft}</View>
          <View>{footerRight}</View>
        </View>
      ) : null}
    </View>
  );
};

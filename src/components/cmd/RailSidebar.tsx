import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { AccentTile } from './AccentTile';
import { SidebarGroup } from './Sidebar';
import { TreeItem } from './TreeGroup';

interface Props {
  groups: SidebarGroup[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Click → expands the rail back to the full Sidebar. */
  onExpand: () => void;
  /** Optional footer slots (rendered as icon-row only). */
  footerSlot?: React.ReactNode;
}

// Spec 011 §2 — 56 px wide icon-only rail rendering of the same `groups`
// data the full Sidebar consumes. Tablet only. Edit-mode is intentionally
// not surfaced here (rationale: §7 risk 5 — drag-to-reorder needs labels;
// the user expands → edits → done → collapses).
//
// Glyph: a single uppercase character derived from the item label is the
// standin for an icon set the project doesn't have today. Keeps the rail
// visually scan-able without taking on a new icon-font dependency. Future
// per-section design specs may swap in real glyphs.
function glyphForItem(it: TreeItem): string {
  // Inventory → I, Dashboard → D, etc. Strip non-letters for stability.
  const label = (it.label || it.id || '?').trim();
  const ch = label.replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase();
  return ch || '·';
}

export const RailSidebar: React.FC<Props> = ({
  groups,
  selectedId,
  onSelect,
  onExpand,
  footerSlot,
}) => {
  const C = useCmdColors();
  const RAIL_WIDTH = 56;
  return (
    <View
      style={{
        width: RAIL_WIDTH,
        backgroundColor: C.panel,
        borderRightWidth: 1,
        borderRightColor: C.border,
        flexDirection: 'column',
      }}
    >
      {/* Header — accent tile (click to expand). */}
      <View
        style={{
          paddingTop: 12,
          paddingBottom: 8,
          alignItems: 'center',
        }}
      >
        <TouchableOpacity
          onPress={onExpand}
          accessibilityRole="button"
          accessibilityLabel="Expand sidebar"
          hitSlop={6}
        >
          <AccentTile glyph="i" size={26} />
        </TouchableOpacity>
      </View>

      {/* Tree — flat icon list, divider between groups */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 4 }}>
        {groups.map((g, gi) => (
          <View key={g.label}>
            {gi > 0 ? (
              <View
                style={{
                  height: 1,
                  backgroundColor: C.border,
                  marginVertical: 6,
                  marginHorizontal: 10,
                }}
              />
            ) : null}
            {g.items.map((it) => {
              const selected = it.id === selectedId;
              return (
                <TouchableOpacity
                  key={it.id}
                  onPress={it.onPress ?? (() => onSelect(it.id))}
                  accessibilityRole="button"
                  accessibilityLabel={it.label}
                  activeOpacity={0.85}
                  style={{
                    height: 40,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginHorizontal: 6,
                    marginVertical: 2,
                    borderRadius: CmdRadius.sm,
                    backgroundColor: selected ? C.accentBg : 'transparent',
                    borderLeftWidth: selected ? 3 : 0,
                    borderLeftColor: C.accent,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: mono(700),
                      fontSize: 13,
                      color: selected ? C.accent : C.fg2,
                    }}
                  >
                    {glyphForItem(it)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </ScrollView>

      {/* Footer slot — caller passes the icon row (e.g. theme toggle, sign-out). */}
      {footerSlot ? (
        <View
          style={{
            paddingVertical: 8,
            alignItems: 'center',
            borderTopWidth: 1,
            borderTopColor: C.border,
            gap: 6,
          }}
        >
          {footerSlot}
        </View>
      ) : null}
    </View>
  );
};

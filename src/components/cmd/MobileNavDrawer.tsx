import React from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, TextInput } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { AccentTile } from './AccentTile';
import { RoleBadge } from './RoleBadge';
import { TreeGroup, TreeItem } from './TreeGroup';
import { SidebarGroup } from './Sidebar';
import { KbdHint } from './KbdHint';

interface Props {
  visible: boolean;
  onClose: () => void;
  groups: SidebarGroup[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Optional palette query state — when non-empty, results panel renders. */
  paletteQuery: string;
  onPaletteChange: (q: string) => void;
  paletteResults?: React.ReactNode;
  /** "admin@towson · v2.4" style sub-line. */
  subtitle?: string;
  footerLeft?: React.ReactNode;
  footerRight?: React.ReactNode;
}

// Full-screen modal. Header (54/16/12 padding to clear iOS dynamic island) +
// ⌘P palette field + optional results section + tree + footer (10/16/28 with
// home-indicator padding).
export const MobileNavDrawer: React.FC<Props> = ({
  visible,
  onClose,
  groups,
  selectedId,
  onSelect,
  paletteQuery,
  onPaletteChange,
  paletteResults,
  subtitle,
  footerLeft,
  footerRight,
}) => {
  const C = useCmdColors();

  const itemsWithSelection = (items: TreeItem[]) =>
    items.map((it) => ({
      ...it,
      selected: it.id === selectedId,
      onPress: it.onPress ?? (() => { onSelect(it.id); onClose(); }),
    }));

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={{ flex: 1, backgroundColor: C.panel }}>
        {/* Header */}
        <View
          style={{
            paddingTop: 54,
            paddingHorizontal: 16,
            paddingBottom: 12,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <AccentTile glyph="i" size={26} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: sans(700), fontSize: 14, color: C.fg }}>im.cmd</Text>
              {subtitle ? (
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{subtitle}</Text>
              ) : null}
            </View>
            <RoleBadge />
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 18, color: C.fg2 }}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* ⌘P palette field */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              backgroundColor: C.panel2,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.borderStrong,
              paddingVertical: 9,
              paddingHorizontal: 12,
            }}
          >
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>⌘P</Text>
            <TextInput
              value={paletteQuery}
              onChangeText={onPaletteChange}
              placeholder="Go to anything…"
              placeholderTextColor={C.fg3}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                flex: 1,
                fontFamily: mono(400),
                fontSize: 12,
                color: C.fg,
                ...(require('react-native').Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
              }}
            />
            <KbdHint size="sm">esc</KbdHint>
          </View>
        </View>

        {/* Palette results (when query non-empty) */}
        {paletteQuery.length > 0 && paletteResults ? (
          <View
            style={{
              backgroundColor: C.accentBg,
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              gap: 8,
            }}
          >
            <Text style={{ fontFamily: mono(600), fontSize: 9.5, letterSpacing: 0.6, color: C.fg3, textTransform: 'uppercase' }}>
              Matches
            </Text>
            {paletteResults}
          </View>
        ) : null}

        {/* Tree */}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 8, paddingBottom: 12 }}>
          {groups.map((g) => (
            <TreeGroup
              key={g.label}
              label={g.label}
              items={itemsWithSelection(g.items)}
              selectedBorderWidth={3}
            />
          ))}
        </ScrollView>

        {/* Footer */}
        {(footerLeft || footerRight) ? (
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingTop: 10,
              paddingBottom: 28,
              paddingHorizontal: 16,
              borderTopWidth: 1,
              borderTopColor: C.border,
            }}
          >
            <View>{footerLeft}</View>
            <View>{footerRight}</View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
};

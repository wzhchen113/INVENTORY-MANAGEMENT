import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { AccentTile } from './AccentTile';
import { TreeGroup, TreeItem } from './TreeGroup';
import { LocaleSwitcher } from './LocaleSwitcher';
import { useT } from '../../hooks/useT';
import { APP_VERSION } from '../../utils/version';

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
  /** Spec 008 — when true, the sidebar renders the dnd-kit edit-mode wrapper
   *  (web only) and the gear icon flips to a DONE button. */
  editMode?: boolean;
  /** Spec 008 — toggle edit mode (gear icon click / DONE click). */
  onToggleEditMode?: () => void;
  /** Spec 008 — called when the user finishes a drag in edit mode with the
   *  new ordered group structure. Parent diffs to override + saves on DONE. */
  onGroupsChange?: (next: SidebarGroup[]) => void;
  /** Spec 008 — called when the user toggles eye/eye-off on an item. */
  onToggleHide?: (id: string) => void;
  /** Spec 008 — "Reset to default" pill click. Parent shows a confirmAction. */
  onReset?: () => void;
}

// Lazy-load the dnd-kit wrapper on web only. Native bundles never see the
// import; Metro dynamic-import shaking keeps the @dnd-kit chunks out of the
// native build entirely. Architect §5 guard.
const SidebarEditModeLazy =
  Platform.OS === 'web'
    ? React.lazy(() => import('./SidebarEditMode'))
    : null;

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
  version = APP_VERSION,
  editMode = false,
  onToggleEditMode,
  onGroupsChange,
  onToggleHide,
  onReset,
}) => {
  const T = useT();
  const C = useCmdColors();

  const itemsWithSelection = (items: TreeItem[]) =>
    items.map((it) => ({
      ...it,
      selected: it.id === selectedId,
      onPress: it.onPress ?? (() => onSelect(it.id)),
    }));

  // Edit-mode UI is web-only per architect §8 / Q8. Native users see the
  // standard sidebar without the gear icon.
  const showEditAffordances = Platform.OS === 'web';

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
        <LocaleSwitcher />
        <View style={{ flex: 1 }} />
        {showEditAffordances && onToggleEditMode ? (
          editMode ? (
            <TouchableOpacity
              onPress={onToggleEditMode}
              accessibilityRole="button"
              accessibilityLabel={T('sidebar.actions.doneEditing')}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: CmdRadius.xs,
                borderWidth: 1,
                borderColor: C.accent,
                backgroundColor: C.accentBg,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.accent }}>{T('sidebar.actions.doneButton')}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={onToggleEditMode}
              accessibilityRole="button"
              accessibilityLabel={T('sidebar.actions.customize')}
              hitSlop={4}
              style={{
                paddingHorizontal: 4,
                paddingVertical: 2,
                borderRadius: CmdRadius.xs,
              }}
            >
              <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg3 }}>⚙</Text>
            </TouchableOpacity>
          )
        ) : null}
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

      {/* Command bar — hidden in edit mode to make room for the reset pill */}
      {!editMode ? (
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
            <Text style={{ fontFamily: sans(400), fontSize: 11, color: C.fg3 }}>{T('sidebar.actions.goToAnything')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ paddingHorizontal: 12, paddingBottom: 6 }}>
          <TouchableOpacity
            onPress={onReset}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={T('sidebar.actions.resetAria')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              paddingVertical: 5,
              paddingHorizontal: 9,
              backgroundColor: 'transparent',
              borderRadius: CmdRadius.md,
              borderWidth: 1,
              borderColor: C.danger,
            }}
          >
            <Text style={{ fontFamily: mono(600), fontSize: 10, color: C.danger }}>
              {T('sidebar.actions.resetLabel')}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Tree */}
      <ScrollView style={{ flex: 1 }}>
        {editMode && SidebarEditModeLazy ? (
          <React.Suspense fallback={
            <View style={{ paddingHorizontal: 14, paddingVertical: 8 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>loading…</Text>
            </View>
          }>
            <SidebarEditModeLazy
              groups={groups}
              onChange={(next) => onGroupsChange?.(next)}
              onToggleHide={(id) => onToggleHide?.(id)}
            />
          </React.Suspense>
        ) : editMode ? (
          // Native fallback — render TreeGroup with editMode=true (no DnD,
          // but the eye-toggle still works). Spec is web-only; this branch
          // is defensive only.
          groups.map((g) => (
            <TreeGroup
              key={g.label}
              label={g.label}
              items={g.items}
              editMode
              onToggleHide={onToggleHide}
            />
          ))
        ) : (
          groups.map((g) => (
            <TreeGroup key={g.label} label={g.label} items={itemsWithSelection(g.items)} />
          ))
        )}
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
          <View style={{ flex: 1, minWidth: 0, marginRight: 8 }}>{footerLeft}</View>
          <View style={{ flexShrink: 0 }}>{footerRight}</View>
        </View>
      ) : null}
    </View>
  );
};

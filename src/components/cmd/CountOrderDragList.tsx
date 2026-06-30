// src/components/cmd/CountOrderDragList.tsx — Spec 103.
//
// Admin (Cmd UI) flat reorder list for the count-screen Custom view. ONE
// shared row body (the parent's `renderRow`), TWO reorder affordances by
// platform:
//   - WEB  → pointer/keyboard drag via @dnd-kit (CountOrderDragListWeb,
//            dynamically loaded so the native bundle never pulls @dnd-kit).
//   - NATIVE → a per-row ▲/▼ "move" control that nudges the row up/down.
//
// The save-on-drop / apply contract is identical for both affordances — only
// the gesture differs (per the spec's decided drag mechanism). The new id
// order is handed back via `onReorder` exactly the same way from either path.
//
// `react-native-draggable-flatlist` is intentionally NOT used (proven to
// silently no-op on this project's reanimated@4 web build).

import React from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useT } from '../../hooks/useT';
import { nudge } from '../../lib/countOrder';
import type { CountOrderRow } from './CountOrderDragListWeb';

// Lazy-load the @dnd-kit web implementation on web only. Native bundles never
// see the import; Metro dynamic-import shaking keeps the @dnd-kit chunks out of
// the native build entirely (same guard shape as Sidebar.tsx → SidebarEditMode).
const CountOrderDragListWebLazy =
  Platform.OS === 'web'
    ? React.lazy(() => import('./CountOrderDragListWeb'))
    : null;

interface Props<T extends CountOrderRow> {
  items: readonly T[];
  onReorder: (orderedIds: string[]) => void;
  renderRow: (item: T) => React.ReactNode;
}

function CountOrderDragList<T extends CountOrderRow>({ items, onReorder, renderRow }: Props<T>) {
  const C = useCmdColors();
  const T = useT();

  if (Platform.OS === 'web' && CountOrderDragListWebLazy) {
    // The lazy import is typed against the concrete `Props<CountOrderRow>`; the
    // generic `T` narrows that safely (T extends CountOrderRow), so retype the
    // component to this call's `Props<T>` rather than widening with `any`.
    const Web = CountOrderDragListWebLazy as unknown as React.ComponentType<Props<T>>;
    return (
      <React.Suspense fallback={<View>{items.map((it) => (
        <View key={it.id}>{renderRow(it)}</View>
      ))}</View>}>
        <Web items={items} onReorder={onReorder} renderRow={renderRow} />
      </React.Suspense>
    );
  }

  // Native — per-row ▲/▼ move buttons. The buttons write the same id order
  // `onReorder` expects from the web drag path.
  return (
    <View>
      {items.map((item, index) => (
        <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ paddingRight: 6, gap: 2 }}>
            <TouchableOpacity
              onPress={() => {
                const next = nudge(items.map((i) => i.id), index, -1);
                if (next) onReorder(next);
              }}
              disabled={index === 0}
              accessibilityRole="button"
              accessibilityLabel={T('section.countOrder.moveUp')}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderWidth: 1,
                borderColor: C.borderStrong,
                borderRadius: CmdRadius.xs,
                opacity: index === 0 ? 0.3 : 1,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>▲</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                const next = nudge(items.map((i) => i.id), index, 1);
                if (next) onReorder(next);
              }}
              disabled={index === items.length - 1}
              accessibilityRole="button"
              accessibilityLabel={T('section.countOrder.moveDown')}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderWidth: 1,
                borderColor: C.borderStrong,
                borderRadius: CmdRadius.xs,
                opacity: index === items.length - 1 ? 0.3 : 1,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>▼</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>{renderRow(item)}</View>
        </View>
      ))}
    </View>
  );
}

export default CountOrderDragList;
export { nudge };

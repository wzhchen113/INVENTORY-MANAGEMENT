// src/screens/staff/components/CountOrderDragList.tsx — Spec 103.
//
// STAFF flat reorder list for the count-screen Custom view. ONE shared row
// body (the parent's `renderRow`), TWO reorder affordances by platform:
//   - WEB  → pointer/keyboard drag via @dnd-kit (CountOrderDragListWeb,
//            dynamically loaded so the native bundle never pulls @dnd-kit).
//   - NATIVE → per-row ▲/▼ "move" buttons that nudge the row up/down.
//
// Both write the SAME id order back via `onReorder`. The list is rendered as a
// plain mapped column (NOT a virtualized FlatList), so EVERY row stays mounted
// — preserving the staff-Weekly un-windowed posture (spec 102 / OQ-6) so the
// gate jump can reach any row in Custom view.

import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
// Token variable is `tok` (not the usual `T`) — this component's generic
// type parameter already claims `T`.
import { useStaffColors, useStaffTokens } from '../theme';
import { t } from '../i18n';
import { nudge } from '../../../lib/countOrder';
// `CountOrderRow` is a type-only import (erased at compile time), so it does NOT
// pull the web-only `@dnd-kit` module into the native bundle — matching the
// admin wrapper. Single-sources the row shape with the web file.
import type { CountOrderRow } from './CountOrderDragListWeb';

const CountOrderDragListWebLazy =
  Platform.OS === 'web'
    ? React.lazy(() => import('./CountOrderDragListWeb'))
    : null;

export type { CountOrderRow };

interface Props<T extends CountOrderRow> {
  items: readonly T[];
  onReorder: (orderedIds: string[]) => void;
  renderRow: (item: T) => React.ReactNode;
  // Screen-aware a11y labels for the native ▲/▼ move buttons. EACH count screen
  // passes its OWN i18n string so the buttons announce the correct surface:
  // staff EOD passes `eod.reorder.*`, staff Weekly passes `weekly.reorder.*`.
  // (Defaults preserve the prior EOD labels for any caller that omits them.)
  moveUpLabel?: string;
  moveDownLabel?: string;
}

export function CountOrderDragList<T extends CountOrderRow>({
  items,
  onReorder,
  renderRow,
  moveUpLabel,
  moveDownLabel,
}: Props<T>) {
  const c = useStaffColors();
  const tok = useStaffTokens();

  if (Platform.OS === 'web' && CountOrderDragListWebLazy) {
    // Retype the lazy import (typed against `Props<CountOrderRow>`) to this
    // call's `Props<T>` — safe since T extends CountOrderRow — rather than
    // widening with `any`.
    const Web = CountOrderDragListWebLazy as unknown as React.ComponentType<Props<T>>;
    return (
      <React.Suspense
        fallback={
          <View>
            {items.map((it) => (
              <View key={it.id} style={{ marginBottom: tok.spacing.sm }}>
                {renderRow(it)}
              </View>
            ))}
          </View>
        }
      >
        <Web items={items} onReorder={onReorder} renderRow={renderRow} />
      </React.Suspense>
    );
  }

  // Native — per-row ▲/▼ move controls.
  return (
    <View>
      {items.map((item, index) => (
        <View
          key={item.id}
          style={{ flexDirection: 'row', alignItems: 'center', marginBottom: tok.spacing.sm }}
        >
          <View style={{ paddingRight: tok.spacing.sm, gap: 4 }}>
            <Pressable
              onPress={() => {
                const next = nudge(items.map((i) => i.id), index, -1);
                if (next) onReorder(next);
              }}
              disabled={index === 0}
              accessibilityRole="button"
              accessibilityLabel={moveUpLabel ?? t('eod.reorder.moveUp')}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: tok.radius.sm,
                borderWidth: 1,
                borderColor: c.border,
                opacity: index === 0 ? 0.3 : 1,
              }}
            >
              <Text style={{ fontSize: 16, color: c.text, textAlign: 'center' }}>▲</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                const next = nudge(items.map((i) => i.id), index, 1);
                if (next) onReorder(next);
              }}
              disabled={index === items.length - 1}
              accessibilityRole="button"
              accessibilityLabel={moveDownLabel ?? t('eod.reorder.moveDown')}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: tok.radius.sm,
                borderWidth: 1,
                borderColor: c.border,
                opacity: index === items.length - 1 ? 0.3 : 1,
              }}
            >
              <Text style={{ fontSize: 16, color: c.text, textAlign: 'center' }}>▼</Text>
            </Pressable>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>{renderRow(item)}</View>
        </View>
      ))}
    </View>
  );
}

export { nudge };

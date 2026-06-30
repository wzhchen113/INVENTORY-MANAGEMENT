// src/components/cmd/CountOrderDragListWeb.tsx — Spec 103.
//
// WEB-ONLY `@dnd-kit` flat draggable list for the admin count-screen Custom
// view. Imports `@dnd-kit/*` (React-DOM only) so it is dynamically loaded by
// CountOrderDragList.tsx behind a `Platform.OS === 'web'` guard — the native
// bundle never includes it. This reuses the blessed spec-008 pattern from
// SidebarEditMode.tsx (single DndContext + one SortableContext +
// useSortable() rows + PointerSensor/KeyboardSensor) but for a FLAT single
// list (no cross-group moves), which is exactly what the flat Custom view
// needs (OQ-2).
//
// The component owns ONLY the drag handle/affordance + the reorder. Each row's
// body comes from the parent's `renderRow(item)` so the Custom view renders
// byte-identical rows to the default view — the custom order is a render
// concern, nothing else (AC-9).
//
// `react-native-draggable-flatlist` is intentionally NOT used: a prior pass
// proved it silently no-ops on this project's reanimated@4 web build (mounts
// but the drag gesture never fires). @dnd-kit is the proven path here.

import React from 'react';
import { View, Text } from 'react-native';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  DragEndEvent,
  UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useCmdColors } from '../../theme/colors';
import { mono } from '../../theme/typography';

export interface CountOrderRow {
  id: string;
}

interface Props<T extends CountOrderRow> {
  /** Items in their CURRENT (already custom-applied + search-filtered) order. */
  items: readonly T[];
  /** Called on drop with the new full ordered id array (the visible subset). */
  onReorder: (orderedIds: string[]) => void;
  /** Renders the body of a row — the same markup the default view uses. */
  renderRow: (item: T) => React.ReactNode;
}

function CountOrderDragListWeb<T extends CountOrderRow>({ items, onReorder, renderRow }: Props<T>) {
  const sensors = useSensors(
    // Small distance threshold so a click/tap on an input inside the row
    // doesn't accidentally start a drag from the handle.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = items.map((it) => it.id);
    const fromIndex = ids.indexOf(String(active.id));
    const toIndex = ids.indexOf(String(over.id));
    if (fromIndex < 0 || toIndex < 0) return;
    onReorder(arrayMove(ids, fromIndex, toIndex));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up row ${String(active.id)}.`,
          onDragOver: ({ active, over }) =>
            over ? `Row ${String(active.id)} is over ${String(over.id)}.` : '',
          onDragEnd: ({ active, over }) =>
            over
              ? `Row ${String(active.id)} dropped over ${String(over.id)}.`
              : `Row ${String(active.id)} dropped.`,
          onDragCancel: ({ active }) => `Dragging row ${String(active.id)} cancelled.`,
        },
      }}
    >
      <SortableContext
        items={items.map((it) => it.id)}
        strategy={verticalListSortingStrategy}
      >
        {items.map((item) => (
          <SortableRow key={item.id} id={item.id}>
            {renderRow(item)}
          </SortableRow>
        ))}
      </SortableContext>
    </DndContext>
  );
}

const SortableRow: React.FC<{ id: UniqueIdentifier; children: React.ReactNode }> = ({
  id,
  children,
}) => {
  const C = useCmdColors();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  // dnd-kit attaches its drag listeners via DOM ref + spread attributes. We
  // host the wrapper on a plain <div> (this file is web-only) so RN-Web's
  // strict View typings don't fight the tabIndex/role attributes. The drag
  // HANDLE is the grip glyph (not the whole row) so the row's inputs stay
  // freely clickable/focusable.
  const wrapperStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || undefined,
    opacity: isDragging ? 0.5 : 1,
    backgroundColor: isDragging ? C.panel2 : 'transparent',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
  };

  return (
    <div ref={setNodeRef as any} style={wrapperStyle} data-count-order-row-id={String(id)}>
      {/* Drag handle — the only drag-initiating surface. `touchAction: none`
          is the dnd-kit pointer best-practice so a touch-drag on the handle
          doesn't hijack into a scroll. */}
      <div
        {...attributes}
        {...listeners}
        style={{ cursor: 'grab', touchAction: 'none', paddingLeft: 4, paddingRight: 8, alignSelf: 'center' }}
        aria-label="Drag to reorder"
      >
        <Text
          style={{ fontFamily: mono(700), fontSize: 12, color: C.fg3, width: 14, textAlign: 'center' }}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          ⠿
        </Text>
      </div>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </div>
  );
};

export default CountOrderDragListWeb;

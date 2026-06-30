// src/screens/staff/components/CountOrderDragListWeb.tsx — Spec 103.
//
// WEB-ONLY @dnd-kit flat draggable list for the STAFF count-screen Custom
// view. Same blessed pattern as the admin CountOrderDragListWeb (and spec
// 008's SidebarEditMode), but styled with the staff-local theme. Imports
// `@dnd-kit/*` (React-DOM only) so CountOrderDragList.tsx dynamically loads it
// behind a `Platform.OS === 'web'` guard — the native bundle never includes it.
//
// The staff subtree keeps its own component (CLAUDE.md staff-isolation), but
// the drag mechanism is identical: one DndContext + one SortableContext +
// useSortable() rows, a grip handle as the only drag-initiating surface so the
// row's decimal-pad inputs stay clickable/focusable.

import React from 'react';
import { Text, View } from 'react-native';
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
import { useStaffColors } from '../theme';

export interface CountOrderRow {
  id: string;
}

interface Props<T extends CountOrderRow> {
  items: readonly T[];
  onReorder: (orderedIds: string[]) => void;
  renderRow: (item: T) => React.ReactNode;
}

function CountOrderDragListWeb<T extends CountOrderRow>({ items, onReorder, renderRow }: Props<T>) {
  const sensors = useSensors(
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
      <SortableContext items={items.map((it) => it.id)} strategy={verticalListSortingStrategy}>
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
  const c = useStaffColors();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const wrapperStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || undefined,
    opacity: isDragging ? 0.6 : 1,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  };

  return (
    <div ref={setNodeRef as any} style={wrapperStyle} data-count-order-row-id={String(id)}>
      <div
        {...attributes}
        {...listeners}
        style={{ cursor: 'grab', touchAction: 'none', paddingLeft: 2, paddingRight: 10, alignSelf: 'center' }}
        aria-label="Drag to reorder"
      >
        <Text
          style={{ fontSize: 20, color: c.textTertiary, width: 16, textAlign: 'center' }}
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

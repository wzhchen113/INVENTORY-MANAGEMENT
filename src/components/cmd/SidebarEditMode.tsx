// src/components/cmd/SidebarEditMode.tsx
//
// Spec 008 §5–§9 — web-only `dnd-kit` wrapper that renders the sortable
// sidebar groups when the user is in edit mode. The default (non-edit-mode)
// render still goes through Sidebar.tsx + TreeGroup.tsx.
//
// This component:
//   - Wraps groups in a single DndContext so items can drag across groups.
//   - Each group is a SortableContext with a custom collision strategy
//     that handles cross-group moves.
//   - Each item is a useSortable() row.
//   - PointerSensor + KeyboardSensor — full pointer + keyboard a11y per
//     architect's §9 contract.
//
// IMPORTANT: this file imports `@dnd-kit/*`, which is React-DOM only.
// It is dynamically loaded by Sidebar.tsx behind a `Platform.OS === 'web'`
// guard so the native bundle never includes it. (See architect §5.)

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCenter,
  DragOverlay,
  DragEndEvent,
  DragStartEvent,
  DragOverEvent,
  KeyboardCode,
  UniqueIdentifier,
} from '@dnd-kit/core';
import type { KeyboardCoordinateGetter } from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useCmdColors } from '../../theme/colors';
import { sans, mono, Type } from '../../theme/typography';
import type { TreeItem } from './TreeGroup';
import type { SidebarGroup } from '../../lib/sidebarLayout';

interface Props {
  /** The merged groups in edit-mode form (hidden items still present, with
   *  hiddenByUser set). */
  groups: SidebarGroup[];
  /** Called whenever the user finishes a drag — receives the new ordered
   *  group structure. The parent computes the override via produceOverride. */
  onChange: (next: SidebarGroup[]) => void;
  /** Called when the user clicks the eye-off / eye toggle on an item. */
  onToggleHide: (id: string) => void;
}

// Find the group label that contains a given id. Returns null if not found
// (e.g. mid-drag on a stale snapshot — render bails out gracefully).
function findGroupLabel(groups: SidebarGroup[], id: UniqueIdentifier): string | null {
  for (const g of groups) {
    if (g.items.some((it: TreeItem) => it.id === id)) return g.label;
  }
  // The id may be a group-droppable id (prefixed with `__group__:`) used to
  // accept drops on an empty group; treat it as the group itself.
  if (typeof id === 'string' && id.startsWith('__group__:')) {
    return id.slice('__group__:'.length);
  }
  return null;
}

const SidebarEditMode: React.FC<Props> = ({ groups, onChange, onToggleHide }) => {
  const C = useCmdColors();

  // Spec 008 §9 — `H` shortcut + cross-group ←/→ both need access to the
  // current `groups` array from inside event handlers / coordinate-getters
  // that are stable across re-renders. Mirror the latest groups into a ref
  // so the closure can read fresh data without re-binding on every render.
  const groupsRef = React.useRef(groups);
  React.useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // Stable refs for the keyboard handlers below so we don't recreate the
  // KeyboardSensor on every render of `groups`. The coordinate-getter and
  // hide-toggle reach through these refs to call the latest props.
  const onToggleHideRef = React.useRef(onToggleHide);
  React.useEffect(() => {
    onToggleHideRef.current = onToggleHide;
  }, [onToggleHide]);

  // Spec 008 §9 cross-group ←/→ keyboard reorder. Default
  // `sortableKeyboardCoordinates` only handles intra-list moves — it filters
  // droppables by horizontal position which collapses to nothing in our
  // single-column sidebar. We intercept ←/→ here and return coordinates
  // pointing at the previous/next group's first/last droppable rect so the
  // existing `handleDragOver` reconciliation lands the item across groups.
  // ↑/↓ still defer to the default sortable getter.
  const customCoordinateGetter: KeyboardCoordinateGetter = React.useCallback(
    (event, args) => {
      if (event.code !== KeyboardCode.Left && event.code !== KeyboardCode.Right) {
        return sortableKeyboardCoordinates(event, args);
      }

      const { active, droppableContainers, droppableRects, collisionRect } = args.context;
      if (!active || !collisionRect) return;

      // Resolve the active item's group. Prefer the data attached at
      // useSortable() time (groupLabel); fall back to scanning groupsRef.
      const activeContainer = droppableContainers.get(active.id);
      const activeGroupFromData = (activeContainer?.data?.current as
        | { groupLabel?: string }
        | undefined)?.groupLabel;
      const activeGroup =
        activeGroupFromData ??
        groupsRef.current.find((g) =>
          g.items.some((it: TreeItem) => it.id === active.id),
        )?.label ??
        null;
      if (!activeGroup) return;

      const groupOrder = groupsRef.current.map((g) => g.label);
      const activeIdx = groupOrder.indexOf(activeGroup);
      if (activeIdx < 0) return;

      const targetIdx =
        event.code === KeyboardCode.Left ? activeIdx - 1 : activeIdx + 1;
      if (targetIdx < 0 || targetIdx >= groupOrder.length) return;
      const targetGroup = groupOrder[targetIdx];
      const targetGroupItems = groupsRef.current[targetIdx]?.items ?? [];

      // Pick a droppable id in the target group. If the group is empty,
      // aim at the empty drop-zone droppable. Otherwise aim at the first
      // item when going right (append-from-top feel) and the last item
      // when going left (append-from-bottom feel) — symmetry with how
      // `handleDragOver` inserts before the hovered item.
      let targetDroppableId: UniqueIdentifier | null = null;
      if (targetGroupItems.length === 0) {
        targetDroppableId = `__group__:${targetGroup}`;
      } else if (event.code === KeyboardCode.Right) {
        targetDroppableId = targetGroupItems[0].id;
      } else {
        targetDroppableId = targetGroupItems[targetGroupItems.length - 1].id;
      }

      const targetRect = droppableRects.get(targetDroppableId);
      if (!targetRect) return;

      event.preventDefault();
      // Return coordinates inside the target rect. dnd-kit will fire
      // `onDragOver` against this collision; our existing `handleDragOver`
      // reconciles cross-group moves.
      return {
        x: targetRect.left,
        y: targetRect.top,
      };
    },
    [],
  );

  const sensors = useSensors(
    // Small distance threshold so a click on the eye-toggle TouchableOpacity
    // doesn't accidentally start a drag on the row.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: customCoordinateGetter }),
  );

  const [activeId, setActiveId] = React.useState<UniqueIdentifier | null>(null);

  // Spec 008 §9 — `H` toggles hide/show on the focused item (no modifier;
  // single letter; admin power-user pattern). Listen on the wrapper so the
  // shortcut only fires when focus is inside the edit-mode tree, not
  // globally on the page. We identify the focused row via the
  // `data-sidebar-item-id` attribute we set on each SortableRow's <div>.
  const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.code !== 'KeyH') return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    // Don't fire while a drag is in flight — `H` would conflict with the
    // user's spatial mental model mid-lift.
    if (activeId !== null) return;
    const target = e.target as HTMLElement | null;
    const itemEl = target?.closest?.('[data-sidebar-item-id]') as HTMLElement | null;
    const id = itemEl?.dataset?.sidebarItemId;
    if (!id) return;
    e.preventDefault();
    onToggleHideRef.current(id);
  }, [activeId]);

  const handleDragStart = (e: DragStartEvent) => {
    setActiveId(e.active.id);
  };

  // Handle "drag over" so cross-group transfers happen visually as the user
  // moves over the destination group's rows. dnd-kit's SortableContext is
  // per-group, so cross-group requires manual reconciliation.
  const handleDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    if (active.id === over.id) return;

    const activeGroup = findGroupLabel(groups, active.id);
    const overGroup = findGroupLabel(groups, over.id);
    if (!activeGroup || !overGroup) return;
    if (activeGroup === overGroup) return; // intra-group handled in dragEnd

    // Move item from activeGroup to overGroup, inserted at the over position.
    const next = groups.map((g) => ({ label: g.label, items: g.items.slice() }));
    const fromIdx = next.findIndex((g) => g.label === activeGroup);
    const toIdx = next.findIndex((g) => g.label === overGroup);
    if (fromIdx < 0 || toIdx < 0) return;

    const fromItems = next[fromIdx].items;
    const toItems = next[toIdx].items;
    const itemIndex = fromItems.findIndex((it: TreeItem) => it.id === active.id);
    if (itemIndex < 0) return;
    const [moved] = fromItems.splice(itemIndex, 1);

    // If `over` is a group-droppable, append. Otherwise, insert before the
    // hovered item.
    const overIsGroup = typeof over.id === 'string' && over.id.startsWith('__group__:');
    const insertAt = overIsGroup
      ? toItems.length
      : Math.max(0, toItems.findIndex((it: TreeItem) => it.id === over.id));
    toItems.splice(insertAt, 0, moved);

    onChange(next);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    if (active.id === over.id) return;

    const activeGroup = findGroupLabel(groups, active.id);
    const overGroup = findGroupLabel(groups, over.id);
    if (!activeGroup || !overGroup) return;
    if (activeGroup !== overGroup) {
      // Cross-group move was already handled in dragOver.
      return;
    }

    // Intra-group reorder.
    const next = groups.map((g) => ({ label: g.label, items: g.items.slice() }));
    const gIdx = next.findIndex((g) => g.label === activeGroup);
    if (gIdx < 0) return;
    const items = next[gIdx].items;
    const fromIndex = items.findIndex((it: TreeItem) => it.id === active.id);
    const toIndex = items.findIndex((it: TreeItem) => it.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    next[gIdx].items = arrayMove(items, fromIndex, toIndex);
    onChange(next);
  };

  // Flatten dragOverlay candidate
  const activeItem = activeId
    ? groups.flatMap((g) => g.items).find((it: TreeItem) => it.id === activeId)
    : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ${String(active.id)}.`,
          onDragOver: ({ active, over }) =>
            over ? `${String(active.id)} is over ${String(over.id)}.` : '',
          onDragEnd: ({ active, over }) =>
            over
              ? `${String(active.id)} dropped over ${String(over.id)}.`
              : `${String(active.id)} dropped.`,
          onDragCancel: ({ active }) => `Dragging ${String(active.id)} cancelled.`,
        },
      }}
    >
      {/* The keydown listener for the `H` hide-shortcut lives on a wrapping
          div so it only fires when focus is inside the edit-mode tree. */}
      <div
        onKeyDown={handleKeyDown}
        style={{ display: 'flex', flexDirection: 'column', flex: 1 }}
      >
      <View style={{ flex: 1 }}>
        {groups.map((g) => (
          <SortableGroup
            key={g.label}
            group={g}
            onToggleHide={onToggleHide}
          />
        ))}
      </View>
      </div>
      <DragOverlay>
        {activeItem ? (
          <View
            style={{
              backgroundColor: C.panel2,
              borderWidth: 1,
              borderColor: C.borderStrong,
              paddingHorizontal: 12,
              paddingVertical: 6,
              opacity: 0.95,
            }}
          >
            <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg }}>
              {activeItem.label}
            </Text>
          </View>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};

const SortableGroup: React.FC<{
  group: SidebarGroup;
  onToggleHide: (id: string) => void;
}> = ({ group, onToggleHide }) => {
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
        <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5 }]}>▾ {group.label}</Text>
      </View>
      <SortableContext
        items={group.items.map((it: TreeItem) => it.id)}
        strategy={verticalListSortingStrategy}
      >
        {group.items.length === 0 ? (
          <EmptyGroupDropZone label={group.label} />
        ) : (
          group.items.map((item: TreeItem) => (
            <SortableRow
              key={item.id}
              item={item}
              groupLabel={group.label}
              onToggleHide={onToggleHide}
            />
          ))
        )}
      </SortableContext>
    </View>
  );
};

const SortableRow: React.FC<{
  item: TreeItem;
  groupLabel: string;
  onToggleHide: (id: string) => void;
}> = ({ item, groupLabel, onToggleHide }) => {
  const C = useCmdColors();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    // Spec 008 §9 — `data.groupLabel` lets the custom keyboard
    // coordinate-getter resolve the active item's group without
    // walking the live `groups` array on every key press.
    data: { groupLabel },
  });

  // dnd-kit attaches its drag listeners via DOM ref + spread attributes/listeners.
  // We host them on a plain <div> so RN-Web's strict View prop typings don't
  // fight (e.g. tabIndex: number vs 0 | -1 | undefined). This file is only
  // loaded under `Platform.OS === 'web'`, so a div is safe here.
  const wrapperStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || undefined,
    opacity: isDragging ? 0.4 : item.hiddenByUser ? 0.55 : 1,
    backgroundColor: isDragging ? C.panel2 : 'transparent',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 14,
    paddingRight: 10,
    cursor: 'grab',
    touchAction: 'none', // dnd-kit pointer best-practice; prevents touch scroll hijack on the row
  };

  // Stop pointerdown propagation on the eye-toggle button so its click
  // doesn't initiate a drag on the parent row.
  const stopPointer = (e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      ref={setNodeRef as any}
      style={wrapperStyle}
      // Spec 008 §9 — `H` hide-shortcut reads this attribute off the
      // currently focused row to know which item to toggle.
      data-sidebar-item-id={item.id}
      {...attributes}
      {...listeners}
    >
      {/* Drag handle indicator (non-functional — the whole row drags) */}
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
      {/* Eye / eye-off toggle. Wrapped in a div with stopPropagation to keep
          the click from starting a drag on the row. */}
      <div onPointerDown={stopPointer} onMouseDown={stopPointer}>
      <TouchableOpacity
        onPress={() => onToggleHide(item.id)}
        accessibilityRole="button"
        accessibilityLabel={item.hiddenByUser ? `Show ${item.label}` : `Hide ${item.label}`}
        hitSlop={6}
        style={{ paddingHorizontal: 4, paddingVertical: 2 }}
      >
        <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg3 }}>
          {item.hiddenByUser ? '⊘' : '◉'}
        </Text>
      </TouchableOpacity>
      </div>
    </div>
  );
};

// Drop target for an empty group. Lets the user drag the last item out of
// a group then drag a different item INTO that group later.
//
// Uses `useDroppable` (canonical primitive for "drop into here without
// participating in sort order") rather than `useSortable`. `useSortable`
// was wrong here because the empty-group placeholder is not itself a
// sortable item — it only acts as a drop target for items dragged in
// from another group. Spec 008 release-proposal item #5 / architect Nit N1.
const EmptyGroupDropZone: React.FC<{ label: string }> = ({ label }) => {
  const C = useCmdColors();
  const id = `__group__:${label}`;
  const { setNodeRef, isOver } = useDroppable({ id });
  const style: React.CSSProperties = {
    margin: '4px 14px',
    padding: '10px 0',
    border: `1px dashed ${isOver ? C.accent : C.border}`,
    borderRadius: 4,
  };
  return (
    <div ref={setNodeRef as any} style={style}>
      <Text
        style={{
          fontFamily: mono(400),
          fontSize: 10,
          color: C.fg3,
          textAlign: 'center',
        }}
      >
        drop here
      </Text>
    </div>
  );
};

export default SidebarEditMode;

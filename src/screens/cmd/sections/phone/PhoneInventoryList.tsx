// src/screens/cmd/sections/phone/PhoneInventoryList.tsx — Spec 142 (chunk b).
//
// The phone Inventory items list (AC-INV1/2/3). A single full-width virtualized
// FlatList — NO desktop table, NO detail pane, NO EDIT/DELETE/+COUNT toolbar,
// NO items.tsv/catalog.tsv tab strip (Hard Rule 4). A 44px search + an always-
// visible 46px segmented ALL/OUT/LOW/OK status filter replace the desktop chip
// cloud (AC-INV1). Rows are grouped by category (GroupCaption) and tapping one
// drills into the full-screen PhoneInventoryDetail via PhoneDrillScaffold.
//
// Self-contained per the spec-142 §3 pattern: reads the same `inventory` slice
// the desktop pane reads (no model-prop bundle, no new db.ts surface). Reuses
// the pure `applyInventoryStatusView` (counts + status filter) and the desktop
// text-filter DSL (parseFilter / matchesFilter) so phone and desktop agree.

import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { useLocale } from '../../../../hooks/useLocale';
import { getLocalizedName } from '../../../../i18n/localizedName';
import { parseFilter, matchesFilter } from '../../../../utils/filterParser';
import { StatusPill } from '../../../../components/cmd/StatusPill';
import { statusFg } from '../../../../theme/statusColors';
import { applyInventoryStatusView } from '../../lib/inventoryStatusView';
import { formatCostPerEach, costPerEachLabel } from '../../lib/itemMoney';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';
import { GroupCaption } from './PhoneWidgets';
import { PhoneInventoryDetail } from './PhoneInventoryDetail';
import type { InventoryItem, ItemStatus } from '../../../../types';

const STATUS_RANK: Record<ItemStatus, number> = { out: 0, low: 1, ok: 2 };

type Segment = { key: ItemStatus | null; label: string; count: number; color: string };

// Inventory-only 46px ALL/OUT/LOW/OK segmented control (AC-INV1). Kept local per
// spec-142 §4 (only Inventory has it). Active = panel2 fill.
function SegmentedStatusFilter({
  segments, active, onSelect,
}: { segments: Segment[]; active: ItemStatus | null; onSelect: (k: ItemStatus | null) => void }) {
  const C = useCmdColors();
  return (
    <View
      testID="phone-inv-segmented-filter"
      style={{
        flexDirection: 'row',
        height: 46,
        borderWidth: 1,
        borderColor: C.border,
        borderRadius: CmdRadius.sm,
        overflow: 'hidden',
      }}
    >
      {segments.map((s, i) => {
        const on = s.key === active;
        return (
          <TouchableOpacity
            key={s.label}
            testID={`phone-inv-segment-${s.key ?? 'all'}`}
            onPress={() => onSelect(s.key)}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1,
              backgroundColor: on ? C.panel2 : 'transparent',
              borderLeftWidth: i === 0 ? 0 : 1,
              borderLeftColor: C.border,
            }}
          >
            <Text style={{ fontFamily: mono(600), fontSize: 13, color: s.color, fontVariant: ['tabular-nums'] }}>
              {s.count}
            </Text>
            <Text style={[PhoneType.microCaption, { color: on ? C.fg2 : C.fg3 }]}>{s.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

type ListRow =
  | { kind: 'header'; key: string; category: string }
  | { kind: 'row'; key: string; item: InventoryItem };

export const PhoneInventoryList: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const getItemStatus = useStore((s) => s.getItemStatus);

  const [query, setQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<ItemStatus | null>(null);
  const drill = usePhoneDrill<InventoryItem>();

  const displayName = React.useCallback(
    (i: InventoryItem) => getLocalizedName({ name: i.name, i18nNames: i.i18nNames }, locale),
    [locale],
  );

  const storeInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore?.id),
    [inventory, currentStore?.id],
  );

  const parsed = React.useMemo(() => parseFilter(query), [query]);
  const textFiltered = React.useMemo(
    () => storeInventory.filter((i) => matchesFilter(i, parsed, getItemStatus, displayName(i))),
    [storeInventory, parsed, getItemStatus, displayName],
  );

  // Reuse the pure helper for the stable segment counts + the status-narrowed set.
  const { counts, items: filtered } = React.useMemo(
    () => applyInventoryStatusView(textFiltered, getItemStatus, statusFilter, displayName, locale),
    [textFiltered, statusFilter, getItemStatus, displayName, locale],
  );

  // Group the status-narrowed set by category; categories alphabetical, rows
  // within a category by urgency (out → low → ok) then name (AC-INV2).
  const listData = React.useMemo<ListRow[]>(() => {
    const byCat = new Map<string, InventoryItem[]>();
    for (const it of filtered) {
      const cat = it.category || 'uncategorized';
      const arr = byCat.get(cat);
      if (arr) arr.push(it);
      else byCat.set(cat, [it]);
    }
    const cats = Array.from(byCat.keys()).sort((a, b) => a.localeCompare(b, locale));
    const out: ListRow[] = [];
    for (const cat of cats) {
      out.push({ kind: 'header', key: `h:${cat}`, category: cat });
      const rows = byCat.get(cat)!.slice().sort((a, b) => {
        const ra = STATUS_RANK[getItemStatus(a)];
        const rb = STATUS_RANK[getItemStatus(b)];
        if (ra !== rb) return ra - rb;
        return displayName(a).localeCompare(displayName(b), locale);
      });
      for (const it of rows) out.push({ kind: 'row', key: it.id, item: it });
    }
    return out;
  }, [filtered, getItemStatus, displayName, locale]);

  const segments: Segment[] = [
    { key: null, label: 'ALL', count: textFiltered.length, color: C.fg2 },
    { key: 'out', label: 'OUT', count: counts.out, color: C.danger },
    { key: 'low', label: 'LOW', count: counts.low, color: C.warn },
    { key: 'ok', label: 'OK', count: counts.ok, color: C.ok },
  ];

  const renderRow = (item: InventoryItem) => {
    const status = getItemStatus(item);
    const color = statusFg(C, status);
    const fill = item.parLevel > 0 ? Math.max(0, Math.min(1, item.currentStock / item.parLevel)) : 0;
    return (
      <TouchableOpacity
        testID={`phone-inv-row-${item.id}`}
        onPress={() => drill.open(item)}
        activeOpacity={0.7}
        style={{
          minHeight: 56,
          paddingHorizontal: 14,
          paddingVertical: 9,
          gap: 5,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StatusPill status={status} />
          <Text style={[PhoneType.itemName, { flex: 1, color: C.fg }]} numberOfLines={1}>
            {displayName(item)}
          </Text>
          <Text style={[PhoneType.tableNum, { color: C.fg }]}>
            {item.currentStock}
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
              {' '}/{item.parLevel} {item.unit}
            </Text>
          </Text>
        </View>
        {/* 3px par bar — fill = status color, width = stock/par clamped. */}
        <View style={{ height: 3, borderRadius: CmdRadius.pill, backgroundColor: C.border, overflow: 'hidden' }}>
          <View style={{ height: 3, width: `${fill * 100}%`, backgroundColor: color }} />
        </View>
        <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
          {formatCostPerEach(item)}/{costPerEachLabel(item)} · {(item.vendorName || 'no vendor').toUpperCase()}
        </Text>
      </TouchableOpacity>
    );
  };

  const listNode = (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Search + segmented filter — always visible above the scrolling list. */}
      <View
        style={{
          paddingHorizontal: 14,
          paddingTop: 12,
          paddingBottom: 10,
          gap: 10,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
        }}
      >
        <TextInput
          testID="phone-inv-search"
          value={query}
          onChangeText={setQuery}
          placeholder={T('section.inventory.filterPlaceholder')}
          placeholderTextColor={C.fg3}
          style={{
            height: 44,
            paddingHorizontal: 12,
            fontFamily: mono(400),
            fontSize: 13,
            color: C.fg,
            backgroundColor: C.panel2,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: CmdRadius.sm,
            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
          }}
        />
        <SegmentedStatusFilter segments={segments} active={statusFilter} onSelect={setStatusFilter} />
      </View>

      <FlatList
        testID="phone-inv-flatlist"
        style={{ flex: 1, minHeight: 0 }}
        data={listData}
        keyExtractor={(r) => r.key}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        ListEmptyComponent={
          <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>
            {storeInventory.length === 0 ? T('section.inventory.noIngredients') : T('section.inventory.noMatches')}
          </Text>
        }
        renderItem={({ item: r }) =>
          r.kind === 'header' ? <GroupCaption>{r.category}</GroupCaption> : renderRow(r.item)
        }
      />
    </View>
  );

  return (
    <PhoneDrillScaffold
      testID="phone-inventory"
      parentCaption="INVENTORY"
      onBack={drill.close}
      list={listNode}
      detail={drill.selected ? <PhoneInventoryDetail item={drill.selected} /> : null}
    />
  );
};

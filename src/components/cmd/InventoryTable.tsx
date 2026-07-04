// src/components/cmd/InventoryTable.tsx — Spec 112.
//
// The full-width operational table for the admin Inventory `items.tsv` view on
// desktop (≥1100). Columns: name, on-hand + par bar, status, cost/each, stock
// value, vendor, category, last counted. Column collapse is keyed on the LIST
// width (not window width) so opening the detail pane — which narrows the list
// — correctly drops lower-priority columns instead of overflowing (spec 112
// AC-7 / the pane-open note).
//
// The two money columns (cost/each + stock value) consume the ★ single
// cost-definition helpers in `src/screens/cmd/lib/itemMoney.ts` — re-deriving
// cost math in a cell is FORBIDDEN (spec 112 ★ COSTING RULE).
//
// Reuses the existing `StatusDot` / `StatusPill` / `ParBar` idioms verbatim;
// it does NOT extend `InventoryRow` (that two-line card is kept for the
// <1100 narrow tier).

import React from 'react';
import { View, Text, TouchableOpacity, FlatList } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { mono, sans, Type } from '../../theme/typography';
import { InventoryItem, ItemStatus, Vendor } from '../../types';
import { StatusDot } from './StatusDot';
import { StatusPill } from './StatusPill';
import { ParBar } from './ParBar';
import { relativeTime } from '../../utils/relativeTime';
import {
  formatCostPerEach,
  costPerEachLabel,
  formatStockValue,
} from '../../screens/cmd/lib/itemMoney';

// Column ids in DISPLAY order. Priority-collapse drops the highest-numbered
// first (spec 112 AC-7): lastCounted → category → vendor → stockValue →
// costEach. name / onHand / status always survive.
type ColumnId =
  | 'name'
  | 'onHand'
  | 'status'
  | 'costEach'
  | 'stockValue'
  | 'vendor'
  | 'category'
  | 'lastCounted';

// Width-keyed tiers (spec 112 Design note "Column collapse tiers"). Keyed on
// the LIST width available to the table, not the window width.
//   ≥ 1400            → all 8
//   1200 – 1399       → drop lastCounted (7)
//   1100 – 1199       → drop category (6, the floor)
// < 1100 the table does not render (the caller shows the narrow-tier list).
export function visibleColumnsForWidth(width: number): ColumnId[] {
  const all: ColumnId[] = [
    'name', 'onHand', 'status', 'costEach', 'stockValue', 'vendor', 'category', 'lastCounted',
  ];
  if (width >= 1400) return all;
  if (width >= 1200) return all.filter((c) => c !== 'lastCounted');
  // 1100–1199 floor: drop category + lastCounted.
  return all.filter((c) => c !== 'lastCounted' && c !== 'category');
}

interface Props {
  items: InventoryItem[];
  vendors: Vendor[];
  /** Lowercased-name selection key, or null when the pane is closed. */
  selectedName: string | null;
  /** Toggle: same-row re-click closes (handled by the caller). */
  onSelect: (nameLower: string) => void;
  /** Width available to the table (drives column collapse). */
  width: number;
  getItemStatus: (item: InventoryItem) => ItemStatus;
  /** Localized display name for a row (English canonical stays the key). */
  displayName: (item: InventoryItem) => string;
  /** Column header labels — passed in so the caller owns the i18n `T`. */
  labels: Record<ColumnId, string>;
}

// Per-column flex/width so header + rows stay aligned. name flexes; the rest
// are fixed so numerics line up in a tabular grid.
const COL_STYLE: Record<ColumnId, { flex?: number; width?: number }> = {
  name:       { flex: 1 },
  onHand:     { width: 200 },
  status:     { width: 84 },
  costEach:   { width: 116 },
  stockValue: { width: 108 },
  vendor:     { width: 150 },
  category:   { width: 130 },
  lastCounted:{ width: 104 },
};

const RIGHT_ALIGNED = new Set<ColumnId>(['costEach', 'stockValue']);

export const InventoryTable: React.FC<Props> = ({
  items,
  vendors,
  selectedName,
  onSelect,
  width,
  getItemStatus,
  displayName,
  labels,
}) => {
  const C = useCmdColors();
  const columns = React.useMemo(() => visibleColumnsForWidth(width), [width]);

  const HeaderRow = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 9,
        backgroundColor: C.panel,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        gap: 12,
      }}
    >
      {columns.map((col) => (
        <View key={col} style={COL_STYLE[col]}>
          <Text
            style={[
              Type.caption,
              {
                color: C.fg3,
                textAlign: RIGHT_ALIGNED.has(col) ? 'right' : 'left',
              },
            ]}
            numberOfLines={1}
          >
            {labels[col]}
          </Text>
        </View>
      ))}
    </View>
  );

  const renderCell = (col: ColumnId, it: InventoryItem) => {
    switch (col) {
      case 'name':
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <StatusDot status={getItemStatus(it)} />
            <Text
              style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }}
              numberOfLines={1}
            >
              {displayName(it)}
            </Text>
          </View>
        );
      case 'onHand':
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={[Type.tableNum, { color: C.fg2, minWidth: 78 }]} numberOfLines={1}>
              {it.currentStock}/{it.parLevel} {it.unit}
            </Text>
            <View style={{ flex: 1 }}>
              <ParBar stock={it.currentStock} par={it.parLevel} />
            </View>
          </View>
        );
      case 'status':
        return <StatusPill status={getItemStatus(it)} />;
      case 'costEach':
        // `$X.XX` and the ` /unit` label are SEPARATE sibling Texts (not
        // nested) so the money string stays a standalone leaf — byte-identical
        // to the DetailPane header's StatCard value (spec 112 ★ / AC-2).
        return (
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'flex-end' }}>
            <Text style={[Type.tableNum, { color: C.fg }]} numberOfLines={1}>
              {formatCostPerEach(it)}
            </Text>
            <Text style={[Type.tableNum, { color: C.fg3 }]} numberOfLines={1}>
              {` /${costPerEachLabel(it)}`}
            </Text>
          </View>
        );
      case 'stockValue':
        return (
          <Text
            style={[Type.tableNumMedium, { color: C.fg, textAlign: 'right' }]}
            numberOfLines={1}
          >
            {formatStockValue(it)}
          </Text>
        );
      case 'vendor':
        return (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }} numberOfLines={1}>
            {vendors.find((v) => v.id === it.vendorId)?.name || '—'}
          </Text>
        );
      case 'category':
        return (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }} numberOfLines={1}>
            {it.category || '—'}
          </Text>
        );
      case 'lastCounted':
        return (
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>
            {relativeTime(it.lastUpdatedAt) || 'never'}
          </Text>
        );
      default:
        return null;
    }
  };

  const renderRow = ({ item: it }: { item: InventoryItem }) => {
    const selected = selectedName === it.name.toLowerCase();
    return (
      <TouchableOpacity
        onPress={() => onSelect(it.name.toLowerCase())}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 16 - (selected ? 2 : 0),
          paddingRight: 16,
          paddingVertical: 10,
          borderLeftWidth: selected ? 2 : 0,
          borderLeftColor: C.accent,
          backgroundColor: selected ? C.accentBg : 'transparent',
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          gap: 12,
        }}
      >
        {columns.map((col) => (
          <View key={col} style={COL_STYLE[col]}>
            {renderCell(col, it)}
          </View>
        ))}
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      {HeaderRow}
      <FlatList
        style={{ flex: 1, minHeight: 0 }}
        data={items}
        keyExtractor={(it) => it.id}
        renderItem={renderRow}
      />
    </View>
  );
};

// src/components/cmd/InventoryTable.tsx — Spec 112.
//
// The full-width operational table for the admin Inventory `items.tsv` view on
// desktop (≥1100). Columns (spec 160 AC-13 order): name, on-hand + par bar,
// status, last counted, cost/each, stock value, vendor, category. Column
// collapse is keyed on the LIST
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
import { countAgeTone, formatLastCounted } from '../../utils/countAge';
import {
  formatCostPerEach,
  costPerEachLabel,
  formatStockValue,
} from '../../screens/cmd/lib/itemMoney';

// Column ids in DISPLAY order (spec 160 AC-13 re-ordered this: `lastCounted`
// moved to 4th, right next to the ON HAND / STATUS numbers it qualifies).
// Priority-collapse now drops `category` first, then `vendor`; name / onHand /
// status / lastCounted / costEach / stockValue always survive.
type ColumnId =
  | 'name'
  | 'onHand'
  | 'status'
  | 'lastCounted'
  | 'costEach'
  | 'stockValue'
  | 'vendor'
  | 'category';

// Width-keyed tiers. Keyed on the LIST width available to the table, not the
// window width (spec 112 AC-7 + spec 160 §6.4 re-prioritization):
//   ≥ 1400            → all 8
//   1200 – 1399       → drop category (7; lastCounted survives)
//   < 1200 (floor)    → drop category + vendor (6; lastCounted survives)
// The floor branch is deliberately unbounded below: when the detail pane is
// open `tableWidth` can fall well under 1100 while the table still renders, and
// under this ordering the column the operator asked for survives that too.
export function visibleColumnsForWidth(width: number): ColumnId[] {
  const all: ColumnId[] = [
    'name', 'onHand', 'status', 'lastCounted', 'costEach', 'stockValue', 'vendor', 'category',
  ];
  if (width >= 1400) return all;
  if (width >= 1200) return all.filter((c) => c !== 'category');
  // Floor: drop category + vendor.
  return all.filter((c) => c !== 'category' && c !== 'vendor');
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
  /** Spec 160 — the per-(store, item) last-counted aggregate + everything the
   *  cell needs to render it. OPTIONAL: when absent (or `loaded: false`) every
   *  cell shows the neutral `—` placeholder in the muted tone — NEVER "never
   *  counted", which during a load would be a false accusation across every
   *  row (AC-9). This component stays presentational, so the host resolves the
   *  `T` strings and owns the fetch. */
  lastCounted?: {
    /** itemId → ISO timestamp, or null = never counted at this store. */
    byItem: Record<string, string | null>;
    /** false = not loaded yet OR the load failed. */
    loaded: boolean;
    timezone: string;
    locale: string;
    /** T('section.inventory.neverCounted') */
    neverLabel: string;
    /** T('section.inventory.lastCountedLoading') — a11y only; the glyph is `—`. */
    loadingLabel: string;
    /** T('section.inventory.lastCountedAria') — raw template; `{date}` is
     *  interpolated here with the long-form absolute date. */
    ariaTemplate: string;
    /** Anchor for the tone + same-year test; re-anchored on map reload. */
    now: Date;
  };
}

// Per-column flex/width so header + rows stay aligned. name flexes; the rest
// are fixed so numerics line up in a tabular grid.
// `lastCounted` is 124 (not the spec-112 104) because spec 160 renders BOTH the
// absolute date and the relative age in one cell — the es worst case
// (`sept 30, 25 · 1y`, ~101px at 6.3px/char mono 10.5) left only ~3px of slack
// at 104 and would have ellipsised the age away in production. The +20px is
// absorbed by the flex `name` column at ≥1400; the two narrower tiers gain
// headroom because `lastCounted` (124) replaces `category` (130) / `vendor` (150).
const COL_STYLE: Record<ColumnId, { flex?: number; width?: number }> = {
  name:       { flex: 1 },
  onHand:     { width: 200 },
  status:     { width: 84 },
  costEach:   { width: 116 },
  stockValue: { width: 108 },
  vendor:     { width: 150 },
  category:   { width: 130 },
  lastCounted:{ width: 124 },
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
  lastCounted,
}) => {
  const C = useCmdColors();
  const columns = React.useMemo(() => visibleColumnsForWidth(width), [width]);

  // Spec 160 — tone → colour, off the existing Cmd palette (no new tokens).
  const TONE_COLOR: Record<'fresh' | 'stale' | 'cold' | 'never', string> = {
    fresh: C.fg3,
    stale: C.warn,
    cold:  C.danger,
    never: C.danger,
  };

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
      case 'lastCounted': {
        // Spec 160 — derived from COUNT HISTORY (eod_submissions ∪
        // inventory_counts), never from `item.lastUpdatedAt` (which moves on any
        // row edit and is what made this column lie under the spec-112 wiring).
        if (!lastCounted || !lastCounted.loaded) {
          // AC-9 — loading / errored is NOT "never counted".
          return (
            <Text
              style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}
              numberOfLines={1}
              accessibilityLabel={lastCounted?.loadingLabel}
            >
              —
            </Text>
          );
        }
        const iso = lastCounted.byItem[it.id] ?? null;
        const tone = countAgeTone(iso, lastCounted.now);
        const text = formatLastCounted(iso, {
          now: lastCounted.now,
          locale: lastCounted.locale,
          timeZone: lastCounted.timezone,
          neverLabel: lastCounted.neverLabel,
          style: 'short',
        });
        // AC-10 — the terse `3d` glyph gets a non-visual long form carrying the
        // full absolute date.
        const aria = tone === 'never'
          ? lastCounted.neverLabel
          : lastCounted.ariaTemplate.replace(
            '{date}',
            formatLastCounted(iso, {
              now: lastCounted.now,
              locale: lastCounted.locale,
              timeZone: lastCounted.timezone,
              neverLabel: lastCounted.neverLabel,
              style: 'long',
            }),
          );
        // ONE Text leaf: one truncation unit, one `getByText` target.
        return (
          <Text
            style={{ fontFamily: mono(400), fontSize: 10.5, color: TONE_COLOR[tone] }}
            numberOfLines={1}
            accessibilityLabel={aria}
          >
            {text}
          </Text>
        );
      }
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

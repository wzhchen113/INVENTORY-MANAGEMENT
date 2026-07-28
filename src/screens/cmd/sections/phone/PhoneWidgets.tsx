// src/screens/cmd/sections/phone/PhoneWidgets.tsx
//
// Spec 142 §4 — the phone-tier widgets shared by ≥2 list/detail sections. All
// built on useCmdColors() + PhoneType + CmdRadius (+ StatusPill for pills) with
// NO new palette values. Per-section one-offs (Inventory's SegmentedStatusFilter,
// the Waste two-step sheet body) live next to their own phone file instead.
//
//   TwoLineRow   — the row shape for every list (line1 pill+name+value / line2 meta)
//   ChipRow      — a horizontally scrolling ≥44×44 filter chip row (never a cloud)
//   GroupCaption — a mono upper group header (category / day groups)
//   StatPanel    — a row of stat cells + optional fill bar (every detail)
//
// Hard Rules honored: names get flex:1 and ellipsize only past the full width
// (2/3), chips scroll horizontally at the ≥44 hit floor (6), status colors are
// semantic tokens and never the accent (§91).

import React from 'react';
import { View, Text, Pressable, ScrollView, TouchableOpacity, TextStyle } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { PhoneType } from '../../../../theme/typography';

// ── TwoLineRow ───────────────────────────────────────────────────────────────

interface TwoLineRowProps {
  /** Optional leading pill on line 1 (e.g. a StatusPill / capacity pill). */
  pill?: React.ReactNode;
  /** Row title — flex:1, ellipsized only past the full available width. */
  name: string;
  /** Right-aligned value on line 1 (nowrap), e.g. "44 /40 lbs" or a price. */
  rightValue?: React.ReactNode;
  /** Line-2 leading meta (e.g. "$/unit · VENDOR"). */
  meta?: React.ReactNode;
  /** Line-2 trailing slot (e.g. a par bar or a "N LOW" tag). */
  line2Right?: React.ReactNode;
  onPress?: () => void;
  testID?: string;
}

export const TwoLineRow: React.FC<TwoLineRowProps> = ({
  pill,
  name,
  rightValue,
  meta,
  line2Right,
  onPress,
  testID,
}) => {
  const C = useCmdColors();
  const hasLine2 = meta != null || line2Right != null;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 56,
        paddingHorizontal: 14,
        paddingVertical: 10,
        justifyContent: 'center',
        gap: 4,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        backgroundColor: pressed ? C.panel2 : 'transparent',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {pill}
        <Text numberOfLines={1} style={[PhoneType.itemName, { flex: 1, color: C.fg }]}>
          {name}
        </Text>
        {rightValue != null ? (
          <View style={{ flexShrink: 0, alignItems: 'flex-end' }}>{rightValue}</View>
        ) : null}
      </View>
      {hasLine2 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>{meta}</View>
          {line2Right != null ? <View style={{ flexShrink: 0 }}>{line2Right}</View> : null}
        </View>
      ) : null}
    </Pressable>
  );
};

// ── ChipRow ──────────────────────────────────────────────────────────────────

export interface Chip {
  key: string;
  label: string;
  /** Optional live count appended as "· N". */
  count?: number;
}

interface ChipRowProps {
  chips: Chip[];
  activeKey: string;
  onSelect: (key: string) => void;
  testID?: string;
}

export const ChipRow: React.FC<ChipRowProps> = ({ chips, activeKey, onSelect, testID }) => {
  const C = useCmdColors();
  return (
    // A horizontally-scrolling row of fixed-height pills (Hard Rule 6). On
    // react-native-web a horizontal ScrollView otherwise flex-grows to fill the
    // column and its `align-items: stretch` contentContainer stretches every
    // chip to the full height — the giant vertical-pill bug. `flexGrow/Shrink: 0`
    // collapses the row to its content height and `alignItems: 'center'` stops
    // the chips stretching on the cross axis.
    <ScrollView
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 0 }}
      contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8, alignItems: 'center' }}
    >
      {chips.map((chip) => {
        const active = chip.key === activeKey;
        return (
          <TouchableOpacity
            key={chip.key}
            testID={`chip-${chip.key}`}
            onPress={() => onSelect(chip.key)}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={{
              height: 44,
              minWidth: 44,
              paddingHorizontal: 14,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: CmdRadius.pill,
              borderWidth: 1,
              borderColor: active ? C.accent : C.border,
              backgroundColor: active ? C.accentBg : C.panel2,
            }}
          >
            <Text
              numberOfLines={1}
              style={[PhoneType.caption, { color: active ? C.accent : C.fg2 }]}
            >
              {chip.label}
              {chip.count != null ? ` · ${chip.count}` : ''}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
};

// ── GroupCaption ─────────────────────────────────────────────────────────────

interface GroupCaptionProps {
  children: React.ReactNode;
  style?: TextStyle;
}

// Mono upper group header (PhoneType.caption) for category / day groups. Thinly
// wraps the phone-tier styling in one place so every list groups identically.
export const GroupCaption: React.FC<GroupCaptionProps> = ({ children, style }) => {
  const C = useCmdColors();
  return (
    <View
      style={{
        paddingHorizontal: 14,
        paddingTop: 14,
        paddingBottom: 6,
        backgroundColor: C.bg,
      }}
    >
      <Text style={[PhoneType.caption, { color: C.fg3 }, style]}>{children}</Text>
    </View>
  );
};

// ── StatPanel ────────────────────────────────────────────────────────────────

// ── PropertyCard ─────────────────────────────────────────────────────────────

export interface PropertyRow {
  label: string;
  value: React.ReactNode;
  /** Optional color string for the value (e.g. a days-of-stock threshold tint). */
  tone?: string;
}

interface PropertyCardProps {
  /** Mono upper card caption — e.g. "PROPERTIES" | "CONTACT" | "SCHEDULE". */
  title: string;
  rows: PropertyRow[];
  testID?: string;
}

// A bordered `panel` card with a `GroupCaption` header and label/value rows.
// SHARED (spec §4) — the Inventory / Catalog / Vendor details all render this
// shape; keeping one component avoids the three-way drift the review flagged.
export const PropertyCard: React.FC<PropertyCardProps> = ({ title, rows, testID }) => {
  const C = useCmdColors();
  return (
    <View testID={testID} style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, overflow: 'hidden' }}>
      <GroupCaption>{title}</GroupCaption>
      {rows.map((r) => (
        <View key={r.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.border }}>
          <Text style={[PhoneType.microCaption, { color: C.fg3, flex: 1 }]}>{r.label}</Text>
          {typeof r.value === 'string' || typeof r.value === 'number' ? (
            <Text style={[PhoneType.metaMono, { color: r.tone || C.fg2, textAlign: 'right' }]} numberOfLines={1}>{r.value}</Text>
          ) : (
            r.value
          )}
        </View>
      ))}
    </View>
  );
};

// ── StatPanel ────────────────────────────────────────────────────────────────

export type StatTone = 'fg' | 'fg2' | 'ok' | 'low' | 'out' | 'accent';

export interface StatCell {
  label: string;
  value: React.ReactNode;
  /** Semantic tone for the value. Status tones map to ok/warn/danger; NEVER the
   *  accent for a status pill (§91) — `accent` here is for non-status emphasis. */
  tone?: StatTone;
}

interface StatPanelProps {
  cells: StatCell[];
  /** Optional fill bar (0..1) above the cells — e.g. on-hand / par. */
  bar?: { fill: number; color: string } | null;
  /** Optional hero row rendered above the bar (e.g. the on-hand 24 figure /
   *  par on the Inventory detail, AC-INV4). */
  hero?: React.ReactNode;
  testID?: string;
}

export const StatPanel: React.FC<StatPanelProps> = ({ cells, bar, hero, testID }) => {
  const C = useCmdColors();
  const toneColor = (tone?: StatTone): string => {
    switch (tone) {
      case 'ok': return C.ok;
      case 'low': return C.warn;
      case 'out': return C.danger;
      case 'accent': return C.accent;
      case 'fg2': return C.fg2;
      default: return C.fg;
    }
  };
  const barPct = bar ? Math.max(0, Math.min(1, bar.fill)) * 100 : 0;

  return (
    <View
      testID={testID}
      style={{
        backgroundColor: C.panel2,
        borderWidth: 1,
        borderColor: C.border,
        borderRadius: CmdRadius.md,
        padding: 12,
        gap: 12,
      }}
    >
      {hero != null ? hero : null}
      {bar ? (
        <View style={{ height: 4, borderRadius: CmdRadius.pill, backgroundColor: C.border, overflow: 'hidden' }}>
          <View style={{ height: 4, width: `${barPct}%`, backgroundColor: bar.color }} />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row' }}>
        {cells.map((cell, i) => (
          <View key={`${cell.label}-${i}`} style={{ flex: 1, gap: 3 }}>
            <Text style={[PhoneType.microCaption, { color: C.fg3 }]}>{cell.label}</Text>
            {typeof cell.value === 'string' || typeof cell.value === 'number' ? (
              <Text style={[PhoneType.kpiValue, { color: toneColor(cell.tone) }]}>{cell.value}</Text>
            ) : (
              cell.value
            )}
          </View>
        ))}
      </View>
    </View>
  );
};

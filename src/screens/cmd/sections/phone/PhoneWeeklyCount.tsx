// src/screens/cmd/sections/phone/PhoneWeeklyCount.tsx — Spec 144.
//
// The phone-tier (< 768px web + all native) weekly / inventory-count worksheet.
// Extracted as a presentational subcomponent and gated behind an early-return in
// `InventoryCountSection` (AC-REG: the desktop/tablet tree is byte-unchanged).
// Every piece of data + every handler it needs is lifted in the parent and
// passed in the `model` bundle — no new store fields, no direct DB access.
//
// It is the EOD keypad machinery (reused verbatim: PhoneKeypadSheet + eodKeypad
// advance/append helpers) applied across ALL store items grouped by category:
//   - meta line shows the system `sys` on-hand (not EOD's par-running-total);
//   - a variance line appears once counted (✓ MATCHES SYSTEM ok / −N unit VS
//     SYSTEM warn, danger past ±15% — `weeklyVariance`);
//   - an export chip row (↓ CSV · ↓ PDF · ◎ lang) reuses the spec-139 handlers
//     + the export-scoped locale cycle;
//   - its own submit gate ("SUBMIT WEEKLY COUNT") requires EVERY item counted
//     and toasts the remainder otherwise (the desktop gate only needs one entry).
//
// The weekly count uses a SEPARATE entry keyspace from EOD by construction: the
// case/unit/note maps live in `InventoryCountSection`'s own React state (distinct
// from `EODCountSection`'s), and nothing here touches the EOD maps.
//
// Circular-import note: this file imports PhoneKeypadSheet from ../eod (used only
// inside JSX at render time); the parent imports this file's default export. The
// ES-module cycle resolves fine — neither reference is touched at module-eval.

import React from 'react';
import { View, Text, FlatList, Pressable, TouchableOpacity, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useT } from '../../../../hooks/useT';
import type { Locale } from '../../../../hooks/useLocale';
import { firstUncounted } from '../../../../lib/countOrder';
import { advanceUncounted, activeFieldFor, appendKeypadDigit } from '../../../../lib/eodKeypad';
import { formatQty } from '../../../../utils/formatQty';
import type { InventoryItem } from '../../../../types';
import { PhoneKeypadSheet } from '../eod/PhoneKeypadSheet';
import { GroupCaption } from './PhoneWidgets';
import { weeklyVariance, type VarianceTone } from './weeklyVariance';

// The export-scoped locale cycle (◎ chip): EN → ES → 中文 → EN. Kept in-file +
// pure so the jest lang-chip test can assert the wrap without rendering.
const LOCALE_CYCLE: Locale[] = ['en', 'es', 'zh-CN'];
export function nextExportLocale(locale: Locale): Locale {
  const i = LOCALE_CYCLE.indexOf(locale);
  return LOCALE_CYCLE[(i + 1) % LOCALE_CYCLE.length];
}

export interface PhoneWeeklyModel {
  /** ISO week number for the "WEEKLY · WK n" badge. */
  wkNum: number;
  /** Every item in the active store (the count covers all of them). */
  storeInventory: InventoryItem[];
  // live entry maps + setters (the weekly keyspace — separate from EOD)
  caseCounts: Record<string, string>;
  unitCounts: Record<string, string>;
  itemNotes: Record<string, string>;
  setCaseCounts: (u: (p: Record<string, string>) => Record<string, string>) => void;
  setUnitCounts: (u: (p: Record<string, string>) => Record<string, string>) => void;
  setItemNotes: (u: (p: Record<string, string>) => Record<string, string>) => void;
  hasEntry: (id: string) => boolean;
  itemTotal: (i: InventoryItem) => number;
  nonBlankCount: number;
  totalItems: number;
  hasNegative: boolean;
  // gates / submit
  submitting: boolean;
  isAllOrEmpty: boolean;
  onSubmit: () => void;
  // export (spec 139 — cross-platform, reused verbatim)
  onExportCsv: () => void;
  onExportPdf: () => void;
  exportLocale: Locale;
  setExportLocale: (l: Locale) => void;
}

// ── Flat virtualization rows ──────────────────────────────────────────
// A single FlatList feed (Hard Rule 7: 143 items must virtualize) of category
// headers interleaved with item rows, built from the store's items grouped by
// category (category asc, name asc within — matches the desktop grouped order).
type WeeklyRow =
  | { kind: 'header'; key: string; cat: string; n: number }
  | { kind: 'item'; key: string; item: InventoryItem };

function buildRows(items: InventoryItem[]): { rows: WeeklyRow[]; flatItems: InventoryItem[] } {
  const byCat = new Map<string, InventoryItem[]>();
  for (const it of items) {
    const arr = byCat.get(it.category) || [];
    arr.push(it);
    byCat.set(it.category, arr);
  }
  const cats = Array.from(byCat.entries()).sort(([a], [b]) => a.localeCompare(b));
  const rows: WeeklyRow[] = [];
  const flatItems: InventoryItem[] = [];
  for (const [cat, catItems] of cats) {
    const sorted = catItems.slice().sort((a, b) => a.name.localeCompare(b.name));
    rows.push({ kind: 'header', key: `h:${cat}`, cat, n: sorted.length });
    for (const it of sorted) {
      rows.push({ kind: 'item', key: `i:${it.id}`, item: it });
      flatItems.push(it);
    }
  }
  return { rows, flatItems };
}

export default function PhoneWeeklyCount({ model }: { model: PhoneWeeklyModel }) {
  const C = useCmdColors();
  const T = useT();

  const [sheetItemId, setSheetItemId] = React.useState<string | null>(null);
  const [activeField, setActiveField] = React.useState<'cases' | 'units'>('units');

  const { rows, flatItems } = React.useMemo(
    () => buildRows(model.storeInventory),
    [model.storeInventory],
  );

  const sheetItem = React.useMemo(
    () => flatItems.find((i) => i.id === sheetItemId) ?? null,
    [flatItems, sheetItemId],
  );

  const closeSheet = React.useCallback(() => setSheetItemId(null), []);

  const openSheet = (item: InventoryItem, field: 'cases' | 'units') => {
    setSheetItemId(item.id);
    setActiveField(field);
  };

  const onKey = (key: string) => {
    if (!sheetItem) return;
    const id = sheetItem.id;
    if (activeField === 'cases') {
      model.setCaseCounts((p) => ({ ...p, [id]: appendKeypadDigit(p[id] || '', key) }));
    } else {
      model.setUnitCounts((p) => ({ ...p, [id]: appendKeypadDigit(p[id] || '', key) }));
    }
  };

  const onNote = (text: string) => {
    if (!sheetItem) return;
    const id = sheetItem.id;
    model.setItemNotes((p) => ({ ...p, [id]: text }));
  };

  const isDone = React.useMemo(
    () => firstUncounted(flatItems, (i) => model.hasEntry(i.id)) === null,
    [flatItems, model],
  );

  const advance = () => {
    if (!sheetItem) return;
    const idx = flatItems.findIndex((i) => i.id === sheetItem.id);
    const res = advanceUncounted(flatItems, idx, (i) => model.hasEntry(i.id));
    if (!res) {
      closeSheet();
      return;
    }
    setSheetItemId(res.item.id);
    setActiveField(activeFieldFor(res.item.caseQty));
  };

  const onNext = () => {
    if (isDone) {
      closeSheet();
      Toast.show({ type: 'success', text1: T('section.eod.phone.allCounted') });
      return;
    }
    advance();
  };

  const onSkip = () => advance();

  // ── Submit gate (own — all counted; toast names the remainder) ────────
  const remaining = Math.max(0, model.totalItems - model.nonBlankCount);
  const allCounted = model.totalItems > 0 && remaining === 0;
  const barReady = allCounted && !model.hasNegative;

  const onSubmitPress = () => {
    if (model.submitting) return;
    if (!allCounted) {
      Toast.show({ type: 'error', text1: T('section.inventoryCount.phone.uncountedRemain', { count: remaining }) });
      // Seat the keypad on the first uncounted item (the phone translation of
      // the desktop first-uncounted jump).
      const first = firstUncounted(flatItems, (i) => model.hasEntry(i.id));
      if (first) {
        setSheetItemId(first.id);
        setActiveField(activeFieldFor(first.caseQty));
      }
      return;
    }
    model.onSubmit();
  };

  const leftLabel = model.submitting
    ? T('section.eod.phone.sent')
    : allCounted
    ? T('section.eod.phone.ready')
    : T('section.eod.phone.left', { count: remaining });
  const leftColor = allCounted ? C.ok : C.warn;

  // ── Export chip row (spec-139 handlers + the ◎ locale cycle) ──────────
  const langLabel = T(`chrome.localeSwitcher.labels.${model.exportLocale}`);
  const exportRow = (
    <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
      <ExportChip testID="weekly-export-csv" label={`↓ ${T('section.inventoryCount.export.csv')}`} onPress={model.onExportCsv} />
      <ExportChip testID="weekly-export-pdf" label={`↓ ${T('section.inventoryCount.export.pdf')}`} onPress={model.onExportPdf} />
      <ExportChip
        testID="weekly-export-lang"
        label={`◎ ${langLabel} ▾`}
        onPress={() => model.setExportLocale(nextExportLocale(model.exportLocale))}
      />
    </View>
  );

  const progressPct = model.totalItems > 0 ? Math.round((model.nonBlankCount / model.totalItems) * 100) : 0;

  const header = (
    <View>
      {/* Title + week badge */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 10,
        }}
      >
        <Text style={[PhoneType.screenTitle, { color: C.fg }]}>{T('section.inventoryCount.title')}</Text>
        <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>
          {T('section.inventoryCount.phone.weekBadge', { num: model.wkNum })}
        </Text>
      </View>

      {/* Progress row */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
          <Text style={[PhoneType.caption, { color: C.fg2 }]}>
            {T('section.eod.phone.counted', { counted: model.nonBlankCount, total: model.totalItems })}
          </Text>
          <Text style={[PhoneType.caption, { color: leftColor }]}>{leftLabel}</Text>
        </View>
        <View style={{ height: 3, borderRadius: 99, backgroundColor: C.panel2, overflow: 'hidden' }}>
          <View style={{ height: 3, width: `${progressPct}%`, backgroundColor: C.accent }} />
        </View>
      </View>

      {exportRow}
    </View>
  );

  // ── No-store guard (the RPC is store-scoped) ──────────────────────────
  if (model.isAllOrEmpty) {
    return (
      <View testID="phone-weekly-count" style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        <View testID="phone-weekly-no-store" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[PhoneType.body, { color: C.fg2 }]}>{T('section.eod.selectStoreToCount')}</Text>
        </View>
      </View>
    );
  }

  return (
    <View testID="phone-weekly-count" style={{ flex: 1, backgroundColor: C.bg }}>
      <FlatList
        testID="phone-weekly-flatlist"
        style={{ flex: 1, minHeight: 0 }}
        data={rows}
        keyExtractor={(r) => r.key}
        initialNumToRender={14}
        windowSize={9}
        removeClippedSubviews={Platform.OS !== 'web'}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={{ padding: 24, alignItems: 'center' }}>
            <Text style={[PhoneType.body, { color: C.fg3 }]}>{T('section.eod.noVendorsAtStore')}</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item: r }) =>
          r.kind === 'header' ? (
            <GroupCaption>{`${r.cat} · ${T('section.inventoryCount.phone.groupItems', { count: r.n })}`}</GroupCaption>
          ) : (
            <WeeklyCountRow item={r.item} model={model} onOpen={openSheet} colors={C} T={T} />
          )
        }
      />

      {/* Submit bar — in-flow above the dock. Own gate: every item counted. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: 12,
          borderTopWidth: 1,
          borderTopColor: C.border,
          backgroundColor: C.panel,
        }}
      >
        <View style={{ width: 72 }}>
          <Text style={[PhoneType.caption, { color: leftColor }]}>{leftLabel}</Text>
        </View>
        <Pressable
          testID="weekly-submit"
          onPress={onSubmitPress}
          disabled={model.submitting}
          accessibilityRole="button"
          accessibilityLabel={T('section.inventoryCount.phone.submitWeekly')}
          style={{
            flex: 1,
            height: 48,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: barReady ? C.accent : C.panel2,
            borderColor: barReady ? C.accent : C.border,
            opacity: model.submitting ? 0.6 : 1,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 12.5, color: barReady ? C.accentFg : C.fg3 }}>
            {T('section.inventoryCount.phone.submitWeekly')}
          </Text>
        </Pressable>
      </View>

      {/* Keypad sheet — the same contract as EOD (NEXT wraps, SKIP, auto-select
          cases when caseQty>1, max 5 chars one dot, 0 is valid). */}
      <PhoneKeypadSheet
        visible={!!sheetItem}
        item={sheetItem}
        activeField={activeField}
        setActiveField={setActiveField}
        caseValue={sheetItem ? model.caseCounts[sheetItem.id] || '' : ''}
        unitValue={sheetItem ? model.unitCounts[sheetItem.id] || '' : ''}
        noteValue={sheetItem ? model.itemNotes[sheetItem.id] || '' : ''}
        runningTotal={sheetItem ? model.itemTotal(sheetItem) : 0}
        isDone={isDone}
        onKey={onKey}
        onNote={onNote}
        onSkip={onSkip}
        onNext={onNext}
        onClose={closeSheet}
      />
    </View>
  );
}

// ── Export chip ───────────────────────────────────────────────────────
function ExportChip({ testID, label, onPress }: { testID: string; label: string; onPress: () => void }) {
  const C = useCmdColors();
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flex: 1,
        height: 44,
        borderWidth: 1,
        borderColor: C.borderStrong,
        borderRadius: CmdRadius.sm,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 10, letterSpacing: 0.6, color: C.fg2 }} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ── Count row ─────────────────────────────────────────────────────────
// The EOD count-row shape, restyled for weekly: the meta line shows the system
// `sys` on-hand, and a variance line renders once the row is counted.
function WeeklyCountRow({
  item,
  model,
  onOpen,
  colors: C,
  T,
}: {
  item: InventoryItem;
  model: PhoneWeeklyModel;
  onOpen: (item: InventoryItem, field: 'cases' | 'units') => void;
  colors: ReturnType<typeof useCmdColors>;
  T: ReturnType<typeof useT>;
}) {
  const hasCase = (item.caseQty || 0) > 1;
  const cVal = model.caseCounts[item.id] || '';
  const uVal = model.unitCounts[item.id] || '';
  const counted = model.hasEntry(item.id);

  const varianceToneColor = (tone: VarianceTone): string =>
    tone === 'ok' ? C.ok : tone === 'danger' ? C.danger : C.warn;

  let varianceLine: { text: string; color: string } | null = null;
  if (counted) {
    const v = weeklyVariance(model.itemTotal(item), item.currentStock ?? 0);
    if (v.matches) {
      varianceLine = { text: T('section.inventoryCount.phone.matchesSystem'), color: C.ok };
    } else {
      const amount = (v.diff > 0 ? '+' : '−') + formatQty(Math.abs(v.diff));
      varianceLine = {
        text: T('section.inventoryCount.phone.vsSystem', { amount, unit: item.unit }),
        color: varianceToneColor(v.tone),
      };
    }
  }

  const Well = ({ field, label, value }: { field: 'cases' | 'units'; label: string; value: string }) => {
    const filled = value.trim() !== '';
    return (
      <Pressable
        testID={`weekly-well-${item.id}-${field}`}
        onPress={() => onOpen(item, field)}
        accessibilityRole="button"
        accessibilityLabel={`${item.name} ${label}`}
        style={{
          width: 62,
          height: 48,
          borderWidth: 1,
          borderStyle: filled ? 'solid' : 'dashed',
          borderColor: filled ? C.border : C.borderStrong,
          backgroundColor: filled ? C.panel2 : 'transparent',
          borderRadius: CmdRadius.sm,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={[PhoneType.microCaption, { color: C.fg3 }]}>{label}</Text>
        <Text style={[PhoneType.wellValue, { color: filled ? C.fg : C.fg3, marginTop: 1 }]}>{filled ? value : '—'}</Text>
      </Pressable>
    );
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        borderStyle: 'dashed',
      }}
    >
      {/* Indicator square */}
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: CmdRadius.xs,
          borderWidth: 1,
          borderStyle: counted ? 'solid' : 'dashed',
          borderColor: counted ? C.accent : C.borderStrong,
          backgroundColor: counted ? C.accentBg : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {counted ? (
          <Text testID={`weekly-counted-${item.id}`} style={{ fontFamily: mono(700), fontSize: 11, color: C.accent }}>
            ✓
          </Text>
        ) : null}
      </View>

      {/* Name + meta + variance */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[PhoneType.itemName, { color: C.fg }]} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={[PhoneType.metaMono, { color: C.fg3, marginTop: 2 }]} numberOfLines={1}>
          {item.unit}
          {hasCase ? ` · case ${item.caseQty}` : ''}
          {` · sys ${formatQty(item.currentStock ?? 0)}`}
        </Text>
        {varianceLine ? (
          <Text
            testID={`weekly-variance-${item.id}`}
            style={{ fontFamily: mono(600), fontSize: 9.5, letterSpacing: 0.5, marginTop: 3, color: varianceLine.color }}
            numberOfLines={1}
          >
            {varianceLine.text}
          </Text>
        ) : null}
      </View>

      {/* Wells */}
      {hasCase ? <Well field="cases" label={T('section.eod.phone.casesWell', { qty: item.caseQty })} value={cVal} /> : null}
      <Well field="units" label={item.unit.toUpperCase()} value={uVal} />
    </View>
  );
}

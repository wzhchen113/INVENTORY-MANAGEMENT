// src/screens/cmd/sections/eod/PhoneEodCount.tsx — Spec 140.
//
// The phone-tier (< 768px web + all native) EOD count worksheet. Extracted as a
// presentational subcomponent and gated behind an early-return in
// `EODCountSection` (AC-REG: the desktop/tablet tree is byte-unchanged). Every
// piece of data + every handler it needs is lifted in the parent and passed in
// the `model` bundle — no new store fields, no direct DB access.
//
// Circular import note: this file imports `EODHistoryTab` / `VarianceLogTab`
// from `../EODCountSection` (both used only inside JSX at render time), while
// `EODCountSection` imports this file's default export. ES-module cycles resolve
// fine here because neither reference is touched at module-eval time.

import React from 'react';
import { View, Text, ScrollView, Pressable, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useT } from '../../../../hooks/useT';
import { useLocale } from '../../../../hooks/useLocale';
import { firstUncounted } from '../../../../lib/countOrder';
import { advanceUncounted, activeFieldFor, appendKeypadDigit } from '../../../../lib/eodKeypad';
import type { DayStatus } from '../../../../lib/eodDayStatus';
import { dayOfWeekShortLabel, type DayName } from '../../../../utils/enumLabels';
import OrderScheduleSection from '../OrderScheduleSection';
import { EODHistoryTab, VarianceLogTab } from '../EODCountSection';
import type { InventoryItem, Vendor, EODSubmission } from '../../../../types';
import { PhoneKeypadSheet } from './PhoneKeypadSheet';

export interface PhoneDayCell {
  day: DayName;  // English DayName ("Saturday")
  date: string;  // "May 2"
  iso: string;   // "2026-05-02"
  status: DayStatus;
  counted: number;
  total: number;
}

export interface PhoneEodModel {
  // day strip
  week: PhoneDayCell[];
  selectedIso: string;
  setSelectedIso: (iso: string) => void;
  wkNum: number;
  // vendor tabs + per-tab progress
  vendorTabs: Array<Vendor & { count: number }>;
  selectedVendorId: string | null;
  setSelectedVendorId: (id: string) => void;
  setSelectedCategory: (c: string | 'all') => void;
  submittedVendorIds: Set<string>;
  countedItemIds: Set<string>;
  storeInventory: InventoryItem[];
  // active worksheet
  filteredItems: InventoryItem[];
  caseCounts: Record<string, string>;
  unitCounts: Record<string, string>;
  notes: Record<string, string>;
  setCaseCounts: (u: (p: Record<string, string>) => Record<string, string>) => void;
  setUnitCounts: (u: (p: Record<string, string>) => Record<string, string>) => void;
  setNotes: (u: (p: Record<string, string>) => Record<string, string>) => void;
  hasEntry: (id: string) => boolean;
  localHasEntry: (id: string) => boolean;
  itemTotal: (i: InventoryItem) => number;
  countedNum: number;
  total: number;
  // gates / locks
  isRestDay: boolean;
  isVendorLocked: boolean;
  isCurrentVendorEditing: boolean;
  currentVendorSubmission: EODSubmission | null;
  submitting: boolean;
  // handlers (reused verbatim from the parent)
  onSubmit: () => void;
  onEditCurrentVendor: () => void;
  // gate-jump / deep-link bridge
  pendingFocusItem: string | null;
  // tab routing (shared strip)
  tabId: string;
  setTabId: (id: string) => void;
}

export default function PhoneEodCount({ model }: { model: PhoneEodModel }) {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();

  // The seated keypad-sheet item + active field. `sheetItem` derives from the
  // id so a vendor switch that drops the item from `filteredItems` closes the
  // sheet automatically (visible = !!sheetItem).
  const [sheetItemId, setSheetItemId] = React.useState<string | null>(null);
  const [activeField, setActiveField] = React.useState<'cases' | 'units'>('units');

  const sheetItem = React.useMemo(
    () => model.filteredItems.find((i) => i.id === sheetItemId) ?? null,
    [model.filteredItems, sheetItemId],
  );

  // ── pendingFocusItem bridge (AC-11) ─────────────────────────────────
  // The parent sets `pendingFocusItem` on a blocked submit (or the cross-section
  // + COUNT deep-link) then clears it via an async RAF effect. This synchronous
  // effect runs first, snapshots the id into local sheet state, and opens the
  // sheet on that item — the phone translation of "seat + focus".
  React.useEffect(() => {
    const id = model.pendingFocusItem;
    if (!id) return;
    const item = model.filteredItems.find((i) => i.id === id);
    if (!item) return;
    setSheetItemId(id);
    setActiveField(activeFieldFor(item.caseQty));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.pendingFocusItem]);

  const closeSheet = React.useCallback(() => setSheetItemId(null), []);

  const openSheet = (item: InventoryItem, field: 'cases' | 'units') => {
    if (model.isRestDay || model.isVendorLocked) return;
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
    model.setNotes((p) => ({ ...p, [id]: text }));
  };

  const isDone = React.useMemo(
    () => firstUncounted(model.filteredItems, (i) => model.hasEntry(i.id)) === null,
    [model.filteredItems, model.hasEntry],
  );

  const advance = () => {
    if (!sheetItem) return;
    const ordered = model.filteredItems;
    const idx = ordered.findIndex((i) => i.id === sheetItem.id);
    const res = advanceUncounted(ordered, idx, (i) => model.hasEntry(i.id));
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

  // ── Day-strip status-dot color ──────────────────────────────────────
  const dotColorFor = (status: DayStatus): string => {
    if (status === 'today') return C.accent;
    if (status === 'submitted') return C.ok;
    if (status === 'late') return C.warn;
    if (status === 'draft') return C.info;
    if (status === 'uncounted') return C.violet;
    return C.fg3; // rest / default
  };

  // Per-tab "counted/total" — derived purely from storeInventory + the
  // counted-once-globally set (spec 102). "✓" once the vendor is submitted.
  const perVendorProgress = (vid: string): { counted: number; total: number } => {
    const items = model.storeInventory.filter((i) =>
      (i.vendorIds ?? (i.vendorId ? [i.vendorId] : [])).includes(vid),
    );
    const counted = items.filter((i) => model.countedItemIds.has(i.id)).length;
    return { counted, total: items.length };
  };

  const isCountTab = model.tabId === 'count.tsx';

  // Submit-bar status.
  const remaining = Math.max(0, model.total - model.countedNum);
  const allCounted = model.total > 0 && remaining === 0;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Header */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 10,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          backgroundColor: C.panel,
        }}
      >
        <Text style={{ ...PhoneType.screenTitle, color: C.fg }}>{T('section.eod.title')}</Text>
        <Text style={{ ...PhoneType.caption, color: C.fg3, marginTop: 3 }}>
          {`${T('section.eod.weekShort', { num: model.wkNum })} · ${new Date(model.selectedIso + 'T00:00:00').toLocaleString(locale, { month: 'short', year: 'numeric' })}`.toUpperCase()}
        </Text>
      </View>

      {/* Day strip */}
      <View style={{ borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
          {model.week.map((d) => {
            const isSel = d.iso === model.selectedIso;
            const [dom] = [d.date.split(' ')[1] ?? d.date];
            return (
              <Pressable
                key={d.iso}
                onPress={() => model.setSelectedIso(d.iso)}
                accessibilityRole="button"
                accessibilityLabel={`${d.day} ${d.date}`}
                style={{
                  minWidth: 50,
                  minHeight: 50,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: CmdRadius.md,
                  borderWidth: 1,
                  borderColor: isSel ? C.accent : C.border,
                  backgroundColor: isSel ? C.accentBg : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ ...PhoneType.microCaption, color: C.fg3 }}>{dayOfWeekShortLabel(d.day, T)}</Text>
                <Text style={{ fontFamily: mono(600), fontSize: 15, color: C.fg, fontVariant: ['tabular-nums'], marginTop: 1 }}>{dom}</Text>
                <View style={{ width: 5, height: 5, borderRadius: 99, backgroundColor: dotColorFor(d.status), marginTop: 4 }} />
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Hard Rule 4 (phone handoff): file-tab strips are desktop chrome —
          phone EOD is count-only. History/variance/order-schedule remain
          desktop/tablet surfaces; model.tabId stays 'count.tsx' on phone. */}

      {model.tabId === 'history.tsx' ? (
        <EODHistoryTab />
      ) : model.tabId === 'variance.log' ? (
        <VarianceLogTab />
      ) : model.tabId === 'order-schedule' ? (
        <OrderScheduleSection />
      ) : (
        <View style={{ flex: 1 }}>
          {/* Vendor tabs + per-tab progress */}
          <View style={{ borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }}>
              {model.vendorTabs.map((v) => {
                const active = v.id === model.selectedVendorId;
                const submitted = model.submittedVendorIds.has(v.id);
                const p = perVendorProgress(v.id);
                return (
                  <Pressable
                    key={v.id}
                    onPress={() => {
                      model.setSelectedVendorId(v.id);
                      model.setSelectedCategory('all');
                    }}
                    accessibilityRole="tab"
                    accessibilityLabel={v.name}
                    style={{
                      minHeight: 44,
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderBottomWidth: 2,
                      borderBottomColor: active ? C.accent : 'transparent',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Text style={{ fontFamily: mono(active ? 600 : 500), fontSize: 12.5, color: active ? C.fg : C.fg2 }}>
                      {v.name}
                    </Text>
                    {submitted ? (
                      <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.ok }}>✓</Text>
                    ) : (
                      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, fontVariant: ['tabular-nums'] }}>
                        {p.counted}/{p.total}
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          {/* Progress row */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingTop: 10,
              paddingBottom: 8,
              backgroundColor: C.panel,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ ...PhoneType.caption, color: C.fg2 }}>
                {T('section.eod.phone.counted', { counted: model.countedNum, total: model.total })}
              </Text>
              <Text style={{ ...PhoneType.caption, color: model.isVendorLocked ? C.ok : allCounted ? C.ok : C.warn }}>
                {model.isVendorLocked ? T('section.eod.phone.sent') : allCounted ? T('section.eod.phone.ready') : T('section.eod.phone.left', { count: remaining })}
              </Text>
            </View>
            <View style={{ height: 3, backgroundColor: C.border, borderRadius: 99, marginTop: 8, overflow: 'hidden' }}>
              <View
                style={{
                  height: 3,
                  width: `${model.total > 0 ? Math.round((model.countedNum / model.total) * 100) : 0}%`,
                  backgroundColor: C.accent,
                }}
              />
            </View>
          </View>

          {/* Worksheet body */}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            {model.isRestDay ? (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <View
                  style={{
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: C.borderStrong,
                    borderRadius: CmdRadius.md,
                    paddingVertical: 28,
                    paddingHorizontal: 20,
                    width: '100%',
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ ...PhoneType.caption, color: C.warn }}>{T('section.eod.restDayLabel')}</Text>
                </View>
              </View>
            ) : model.filteredItems.length === 0 ? (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <Text style={{ ...PhoneType.body, color: C.fg3 }}>{T('section.eod.noVendorsAtStore')}</Text>
              </View>
            ) : (
              model.filteredItems.map((it, idx) => (
                <CountRow
                  key={it.id}
                  item={it}
                  first={idx === 0}
                  model={model}
                  onOpen={openSheet}
                  colors={C}
                  T={T}
                />
              ))
            )}
          </ScrollView>

          {/* In-flow submit bar */}
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
              <Text
                style={{
                  ...PhoneType.caption,
                  color: model.isVendorLocked ? C.ok : allCounted ? C.ok : C.warn,
                }}
              >
                {model.isVendorLocked
                  ? T('section.eod.phone.sent')
                  : allCounted
                  ? T('section.eod.phone.ready')
                  : T('section.eod.phone.left', { count: remaining })}
              </Text>
            </View>
            {model.isVendorLocked ? (
              <Pressable
                onPress={model.onEditCurrentVendor}
                accessibilityRole="button"
                accessibilityLabel={T('section.eod.editAria')}
                style={{
                  flex: 1,
                  height: 48,
                  borderWidth: 1,
                  borderColor: C.fg,
                  borderRadius: CmdRadius.sm,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: C.panel,
                }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 12.5, color: C.fg }}>{T('section.eod.edit')}</Text>
              </Pressable>
            ) : (
              (() => {
                const disabled = model.submitting || model.isRestDay;
                return (
                  <Pressable
                    testID="eod-submit"
                    onPress={model.onSubmit}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={
                      model.isCurrentVendorEditing ? T('section.eod.updateCount') : T('section.eod.submitCount')
                    }
                    style={{
                      flex: 1,
                      height: 48,
                      borderRadius: CmdRadius.sm,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: disabled ? C.panel2 : C.accent,
                      ...(Platform.OS === 'web' && disabled ? ({ pointerEvents: 'none' } as any) : {}),
                    }}
                  >
                    <Text style={{ fontFamily: mono(700), fontSize: 12.5, color: disabled ? C.fg3 : C.accentFg }}>
                      {model.isCurrentVendorEditing ? T('section.eod.updateCount') : T('section.eod.submitCount')}
                    </Text>
                  </Pressable>
                );
              })()
            )}
          </View>
        </View>
      )}

      {/* Keypad sheet */}
      <PhoneKeypadSheet
        visible={isCountTab && !!sheetItem}
        item={sheetItem}
        activeField={activeField}
        setActiveField={setActiveField}
        caseValue={sheetItem ? model.caseCounts[sheetItem.id] || '' : ''}
        unitValue={sheetItem ? model.unitCounts[sheetItem.id] || '' : ''}
        noteValue={sheetItem ? model.notes[sheetItem.id] || '' : ''}
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

// ── Count row ─────────────────────────────────────────────────────────
// The indicator square carries the counted/uncounted state (replaces the phone
// red-name treatment — the name is always `C.fg`). Two wells (62×48): the CS
// well only when caseQty > 1, plus the unit-label well. Tapping a well opens the
// keypad sheet on that field.
function CountRow({
  item,
  first,
  model,
  onOpen,
  colors: C,
  T,
}: {
  item: InventoryItem;
  first: boolean;
  model: PhoneEodModel;
  onOpen: (item: InventoryItem, field: 'cases' | 'units') => void;
  colors: ReturnType<typeof useCmdColors>;
  T: ReturnType<typeof useT>;
}) {
  const hasCase = (item.caseQty || 0) > 1;
  const locked = model.isRestDay || model.isVendorLocked;

  // When locked, read the submitted values; else the live count maps.
  const submittedEntry = model.isVendorLocked
    ? model.currentVendorSubmission?.entries.find((e) => e.itemId === item.id)
    : null;
  const cVal = model.isVendorLocked
    ? submittedEntry?.actualRemainingCases != null
      ? String(submittedEntry.actualRemainingCases)
      : ''
    : model.caseCounts[item.id] || '';
  const uVal = model.isVendorLocked
    ? submittedEntry?.actualRemainingEach != null
      ? String(submittedEntry.actualRemainingEach)
      : submittedEntry?.actualRemaining != null
      ? String(submittedEntry.actualRemaining)
      : ''
    : model.unitCounts[item.id] || '';

  const counted = model.hasEntry(item.id);
  const total = model.itemTotal(item);

  const Well = ({ field, label, value }: { field: 'cases' | 'units'; label: string; value: string }) => {
    const filled = value.trim() !== '';
    return (
      <Pressable
        testID={`eod-well-${item.id}-${field}`}
        onPress={() => onOpen(item, field)}
        disabled={locked}
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
          opacity: locked ? 0.6 : 1,
        }}
      >
        <Text style={{ ...PhoneType.wellValue, color: filled ? C.fg : C.fg3 }}>{filled ? value : '—'}</Text>
        <Text style={{ ...PhoneType.microCaption, color: C.fg3, marginTop: 1 }}>{label}</Text>
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
        borderTopWidth: first ? 0 : 1,
        borderTopColor: C.border,
        borderStyle: 'dashed',
      }}
    >
      {/* Indicator square */}
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: CmdRadius.xs,
          borderWidth: counted ? 0 : 1,
          borderStyle: 'dashed',
          borderColor: C.borderStrong,
          backgroundColor: counted ? C.accentBg : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {counted ? <Text testID={`eod-counted-${item.id}`} style={{ fontFamily: mono(700), fontSize: 12, color: C.accent }}>✓</Text> : null}
      </View>

      {/* Name + meta */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ ...PhoneType.itemName, color: C.fg }} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={{ ...PhoneType.metaMono, color: C.fg3, marginTop: 2 }} numberOfLines={1}>
          {item.unit}
          {hasCase ? ` · case ${item.caseQty}` : ''}
          {item.parLevel > 0 ? ` · par ${item.parLevel}` : ''}
          {counted ? ` · ${total} ${item.unit}` : ''}
        </Text>
      </View>

      {/* Wells */}
      {hasCase ? <Well field="cases" label={T('section.eod.phone.casesWell', { qty: item.caseQty })} value={cVal} /> : null}
      <Well field="units" label={item.unit} value={uVal} />
    </View>
  );
}

// src/screens/cmd/sections/phone/PhoneWasteLog.tsx — Spec 142 (chunk c).
//
// The phone Waste-log surface (AC-WASTE1/2). A full-width event feed — no
// 340px pane, no desktop form. Header meta shows the period total ("−$X THIS
// WK", danger); a horizontally-scrolling reason chip row (all + the WasteReason
// enum) with live counts filters the feed; event rows show item + meta with the
// cost in the danger token. A 48px "+ LOG WASTE" button opens the two-step
// bottom sheet (PhoneWasteLogSheet). No new backend surface — the feed
// re-derives from the wasteLog slice after logWaste's store round-trip.

import React from 'react';
import { View, Text, FlatList, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { relativeTime } from '../../../../utils/relativeTime';
import { wasteReasonShortLabel } from '../../../../utils/enumLabels';
import { ChipRow, type Chip } from './PhoneWidgets';
import { PhoneWasteLogSheet } from './PhoneWasteLogSheet';
import type { WasteReason } from '../../../../types';

const REASONS: WasteReason[] = ['Expired', 'Dropped/spilled', 'Over-prepped', 'Quality issue', 'Theft', 'Other'];

export const PhoneWasteLog: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const wasteLog = useStore((s) => s.wasteLog);
  const currentStore = useStore((s) => s.currentStore);

  const [reasonFilter, setReasonFilter] = React.useState<'all' | WasteReason>('all');
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const storeWaste = React.useMemo(
    () => wasteLog
      .filter((w) => w.storeId === currentStore?.id)
      .slice()
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
    [wasteLog, currentStore?.id],
  );
  const filtered = React.useMemo(
    () => (reasonFilter === 'all' ? storeWaste : storeWaste.filter((w) => w.reason === reasonFilter)),
    [storeWaste, reasonFilter],
  );

  const totalWeekCost = React.useMemo(() => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    return storeWaste
      .filter((w) => new Date(w.timestamp).getTime() >= sevenDaysAgo)
      .reduce((sum, w) => sum + w.quantity * w.costPerUnit, 0);
  }, [storeWaste]);

  const reasonCounts = React.useMemo(() => {
    const out: Record<string, number> = { all: storeWaste.length };
    for (const r of REASONS) out[r] = storeWaste.filter((w) => w.reason === r).length;
    return out;
  }, [storeWaste]);

  const chips: Chip[] = [
    { key: 'all', label: 'ALL', count: reasonCounts.all },
    ...REASONS.map((r) => ({ key: r, label: wasteReasonShortLabel(r, T).toUpperCase(), count: reasonCounts[r] ?? 0 })),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Header meta */}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4 }}>
        <Text style={[PhoneType.caption, { color: C.fg3, flex: 1 }]}>WASTE LOG</Text>
        <Text style={[PhoneType.kpiValue, { color: C.danger }]}>−${totalWeekCost.toFixed(2)}</Text>
        <Text style={[PhoneType.microCaption, { color: C.fg3 }]}>THIS WK</Text>
      </View>

      <ChipRow
        chips={chips}
        activeKey={reasonFilter}
        onSelect={(k) => setReasonFilter(k as 'all' | WasteReason)}
        testID="phone-waste-chips"
      />

      <FlatList
        testID="phone-waste-flatlist"
        style={{ flex: 1, minHeight: 0 }}
        data={filtered}
        keyExtractor={(w) => w.id}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        ListEmptyComponent={
          <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>no waste recorded</Text>
        }
        renderItem={({ item: w }) => (
          <View
            testID={`phone-waste-row-${w.id}`}
            style={{ minHeight: 56, paddingHorizontal: 14, paddingVertical: 10, gap: 4, borderBottomWidth: 1, borderBottomColor: C.border }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[PhoneType.itemName, { color: C.fg, flex: 1 }]} numberOfLines={1}>{w.itemName}</Text>
              <Text style={[PhoneType.tableNum, { color: C.danger }]}>−${(w.quantity * w.costPerUnit).toFixed(2)}</Text>
            </View>
            <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
              {w.quantity} {w.unit} · {(wasteReasonShortLabel(w.reason, T) || w.reason).toUpperCase()} · {w.loggedBy}
              {relativeTime(w.timestamp) ? ` · ${relativeTime(w.timestamp)}` : ''}
            </Text>
          </View>
        )}
      />

      {/* + LOG WASTE */}
      <View style={{ padding: 14, borderTopWidth: 1, borderTopColor: C.border }}>
        <TouchableOpacity
          testID="phone-waste-open-sheet"
          onPress={() => setSheetOpen(true)}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.accent, backgroundColor: C.accentBg, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.accent }}>+ LOG WASTE</Text>
        </TouchableOpacity>
      </View>

      <PhoneWasteLogSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
    </View>
  );
};

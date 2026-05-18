import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { useT } from '../../../hooks/useT';
import { dayOfWeekShortLabel, type DayName } from '../../../utils/enumLabels';

// DB join keys for `order_schedule.day` — must stay English canonical.
// The displayed text routes through `dayOfWeekShortLabel(day, T)`.
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const satisfies ReadonlyArray<DayName>;

// Weekly grid admin UI for order_schedule. Rows = vendors (brand-scoped at
// the store load level via useStore.vendors). Cols = days. Each cell is a
// per-(vendor, day) toggle that calls addOrderScheduleEntry /
// removeOrderScheduleEntry. Reuses the existing orderSchedule slice — no
// separate fetch.
export default function OrderScheduleSection() {
  const C = useCmdColors();
  const T = useT();
  const vendors        = useStore((s) => s.vendors);
  const orderSchedule  = useStore((s) => s.orderSchedule);
  const currentStore   = useStore((s) => s.currentStore);
  const addOrderScheduleEntry    = useStore((s) => s.addOrderScheduleEntry);
  const removeOrderScheduleEntry = useStore((s) => s.removeOrderScheduleEntry);

  // Build per-day vendorId set lookup. Memoize so the row-by-cell renders
  // are O(1) on the membership check.
  const dayVendorIdSets = React.useMemo(() => {
    const out: Record<string, Set<string>> = {};
    for (const day of DAY_NAMES) {
      const arr = orderSchedule?.[day] || [];
      out[day] = new Set(arr.map((v) => v.vendorId).filter((id): id is string => !!id));
    }
    return out;
  }, [orderSchedule]);

  // Vendors sorted alphabetically. We keep the full list (not just
  // "vendors with items at this store") because the schedule is a planning
  // concept — a vendor with no items today might still be on the schedule
  // for a forecast/seasonal item.
  const sortedVendors = React.useMemo(
    () => [...vendors].sort((a, b) => a.name.localeCompare(b.name)),
    [vendors],
  );

  const totalScheduledCells = React.useMemo(
    () => Object.values(dayVendorIdSets).reduce((s, set) => s + set.size, 0),
    [dayVendorIdSets],
  );

  // Defensive __all__ guard — same pattern as EODCountSection. Bulk schedule
  // edits don't have a meaningful cross-store interpretation. Placed AFTER
  // hook calls so the hook count stays stable across renders.
  if (!currentStore?.id || currentStore.id === '__all__') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}>
        <Text style={{ fontFamily: mono(400), fontSize: 13, color: C.fg2 }}>
          {T('section.orderSchedule.selectStore')}
        </Text>
      </View>
    );
  }

  const onToggleCell = (vendorId: string, vendorName: string, day: string, isOn: boolean) => {
    if (isOn) {
      if (!removeOrderScheduleEntry) return;
      removeOrderScheduleEntry(day, vendorId);
    } else {
      if (!addOrderScheduleEntry) return;
      addOrderScheduleEntry(day, { vendorId, vendorName, deliveryDay: day });
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0, minWidth: 0 }}>
      {/* Top bar — matches CategoriesSection / VendorsSection rhythm */}
      <View
        style={{
          paddingHorizontal: 22, paddingTop: 14, paddingBottom: 10,
          borderBottomWidth: 1, borderBottomColor: C.border,
          flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
          backgroundColor: C.panel,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
          <Text style={[Type.h2, { color: C.fg }]}>{T('section.orderSchedule.title')}</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {T('section.orderSchedule.scheduledHeader', { count: totalScheduledCells, vendors: sortedVendors.length })}
          </Text>
        </View>
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
          {(currentStore.name || T('chrome.store')).toLowerCase()}
        </Text>
      </View>

      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            {T('section.orderSchedule.description')}
          </Text>
        </View>

        <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
          {/* Header row: vendor label + 7 day columns */}
          <View
            style={{
              flexDirection: 'row',
              paddingHorizontal: 14,
              paddingTop: 12,
              paddingBottom: 8,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              alignItems: 'center',
              gap: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <SectionCaption tone="fg3" size={10.5}>{T('section.orderSchedule.orderScheduleTsv')}</SectionCaption>
            </View>
            {DAY_NAMES.map((day) => (
              <View key={day} style={{ width: 60, alignItems: 'center' }}>
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                  {dayOfWeekShortLabel(day, T)}
                </Text>
              </View>
            ))}
          </View>

          {sortedVendors.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {T('section.orderSchedule.noVendorsYet')}
            </Text>
          ) : (
            sortedVendors.map((v, i) => (
              <View
                key={v.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 9,
                  paddingHorizontal: 14,
                  gap: 8,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: C.border,
                  borderStyle: 'dashed',
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg }} numberOfLines={1}>{v.name}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, marginTop: 2 }} numberOfLines={1}>
                    {v.orderCutoffTime
                      ? T('section.orderSchedule.leadWithCutoff', { leadTime: v.leadTimeDays ?? 0, cutoff: v.orderCutoffTime })
                      : T('section.orderSchedule.lead', { leadTime: v.leadTimeDays ?? 0 })}
                  </Text>
                </View>
                {DAY_NAMES.map((day) => {
                  const isOn = dayVendorIdSets[day]?.has(v.id) || false;
                  return (
                    <TouchableOpacity
                      key={day}
                      onPress={() => onToggleCell(v.id, v.name, day, isOn)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isOn }}
                      accessibilityLabel={T('section.orderSchedule.cellAria', { vendor: v.name, day, state: isOn ? T('section.orderSchedule.cellScheduled') : T('section.orderSchedule.cellNotScheduled') })}
                      style={{
                        width: 60, height: 28, alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <View
                        style={{
                          width: 22, height: 22, borderRadius: CmdRadius.sm,
                          borderWidth: 1, borderColor: isOn ? C.accent : C.border,
                          backgroundColor: isOn ? C.accent : 'transparent',
                          alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        {isOn ? (
                          <Text style={{ fontFamily: mono(700), fontSize: 12, color: '#000', lineHeight: 12 }}>✓</Text>
                        ) : null}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))
          )}
        </View>

        {/* Footer hint mirroring how the read-side consumes this data */}
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
          {T('section.orderSchedule.footerHint', { store: currentStore.id.slice(0, 6) })}
        </Text>
      </ScrollView>
    </View>
  );
}

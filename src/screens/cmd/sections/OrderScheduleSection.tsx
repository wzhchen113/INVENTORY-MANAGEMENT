import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { SectionCaption } from '../../../components/cmd/SectionCaption';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const DAY_SHORT: Record<(typeof DAY_NAMES)[number], string> = {
  Monday: 'mon', Tuesday: 'tue', Wednesday: 'wed', Thursday: 'thu',
  Friday: 'fri', Saturday: 'sat', Sunday: 'sun',
};

// Weekly grid admin UI for order_schedule. Rows = vendors (brand-scoped at
// the store load level via useStore.vendors). Cols = days. Each cell is a
// per-(vendor, day) toggle that calls addOrderScheduleEntry /
// removeOrderScheduleEntry. Reuses the existing orderSchedule slice — no
// separate fetch.
export default function OrderScheduleSection() {
  const C = useCmdColors();
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
          Select a store to manage order schedule.
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
          <Text style={[Type.h2, { color: C.fg }]}>Order schedule</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {totalScheduledCells} scheduled · {sortedVendors.length} vendors
          </Text>
        </View>
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
          {(currentStore.name || 'store').toLowerCase()}
        </Text>
      </View>

      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            Click a cell to toggle whether the vendor is scheduled for that day.
            The EOD count screen filters its vendor row by this schedule.
            Empty schedule = all vendors visible on every day (no regression).
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
              <SectionCaption tone="fg3" size={10.5}>order_schedule.tsv</SectionCaption>
            </View>
            {DAY_NAMES.map((day) => (
              <View key={day} style={{ width: 60, alignItems: 'center' }}>
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                  {DAY_SHORT[day]}
                </Text>
              </View>
            ))}
          </View>

          {sortedVendors.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              no vendors yet — create one in the Vendors section
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
                    lead {v.leadTimeDays ?? 0}d{v.orderCutoffTime ? ` · cutoff ${v.orderCutoffTime}` : ''}
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
                      accessibilityLabel={`${v.name} ${day}: ${isOn ? 'scheduled' : 'not scheduled'}`}
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
          // EOD count screen reads this at (store={currentStore.id.slice(0, 6)}, day=…).
          A "show unscheduled vendors" toggle on EOD lets a counter bypass the filter for one view.
        </Text>
      </ScrollView>
    </View>
  );
}

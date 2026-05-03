import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { relativeTime } from '../../utils/relativeTime';
import { formatAuditAction } from '../../utils/formatAuditAction';

interface Props {
  /** The ingredient name to filter audit events on. Case-insensitive. */
  itemName: string;
}

// Filtered audit feed for a single ingredient. Used as the right-pane of
// IngredientFormDrawer in EDIT mode. Mirrors how DetailPane filters by
// itemRef (InventoryDesktopLayout.tsx:367) — same case-insensitive name match.
export const AuditHistory: React.FC<Props> = ({ itemName }) => {
  const C = useCmdColors();
  const auditLog = useStore((s) => s.auditLog);
  const events = React.useMemo(() => {
    const needle = itemName.toLowerCase();
    return auditLog
      .filter((e: any) => (e.itemRef || '').toLowerCase() === needle)
      .slice(0, 20);
  }, [auditLog, itemName]);

  return (
    <View style={{ width: 280, backgroundColor: C.panel2, borderLeftWidth: 1, borderLeftColor: C.border, flexDirection: 'column' }}>
      <View style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.6 }}>history</Text>
        <View style={{ flex: 1 }} />
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg2 }}>{events.length} events</Text>
      </View>
      <ScrollView style={{ flex: 1 }}>
        {events.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            no audit events for this ingredient
          </Text>
        ) : (
          events.map((e: any) => (
            <View key={e.id} style={{ paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border, borderStyle: 'dashed', gap: 3 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg }} numberOfLines={1}>
                  {formatAuditAction(e)}
                </Text>
                <View style={{ flex: 1 }} />
                <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{relativeTime(e.timestamp)}</Text>
              </View>
              {e.value ? (
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg2 }} numberOfLines={2}>
                  {e.value}
                </Text>
              ) : null}
              <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                by {e.userName || 'system'}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
};

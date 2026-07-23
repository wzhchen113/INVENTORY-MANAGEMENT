import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { mono } from '../../../theme/typography';
import { useT } from '../../../hooks/useT';
import { useStore } from '../../../store/useStore';
import { OrderSubmission } from '../../../types';
import { formatMoney } from '../../../utils/reorderExport';
import ReorderSection from './ReorderSection';

// Spec 138 — "Ordering" collapses to the reorder list ONLY. The spec-137
// Purchase-orders tab is retired (AC-1): no TabStrip, no POsSection, no
// createPoDraft deep-link. The section is a thin wrapper that renders
// <ReorderSection /> plus a small, unobtrusive read-only past-orders History
// panel (AC-8). Selecting "Ordering" in the sidebar lands directly on the
// reorder pane; the History panel sits at the bottom, collapsed by default.

// A PO row as it lives in `orderSubmissions` (a superset of OrderSubmission —
// see db.mapPurchaseOrderRow, which populates status / totalCost / referenceDate
// alongside the declared fields). Mirrors POsSection's local `PoRow` type so we
// read the extra fields without an `any` cast.
type HistoryRow = OrderSubmission & {
  status?: string;
  referenceDate?: string;
  totalCost?: number;
};

// AC-8 — read-only past-orders History. Reads `orderSubmissions` (the recent
// purchase_orders read path), filtered to non-cancelled, showing date / vendor /
// total. Refreshes via `refreshPurchaseOrders()` when opened so a just-filled
// cart shows without a full reload. No edit / receive / re-open affordance.
function OrderHistoryPanel() {
  const C = useCmdColors();
  const T = useT();
  const orderSubmissions = useStore((s) => s.orderSubmissions) as HistoryRow[];
  const refreshPurchaseOrders = useStore((s) => s.refreshPurchaseOrders);
  const [open, setOpen] = React.useState(false);

  const rows = React.useMemo(
    () =>
      orderSubmissions.filter((o) => (o.status || '').toLowerCase() !== 'cancelled'),
    [orderSubmissions],
  );

  const onToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next) void refreshPurchaseOrders();
      return next;
    });
  };

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.panel }}>
      <TouchableOpacity
        testID="ordering-history-toggle"
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={T('section.reorder.historyToggleAria')}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingVertical: 9,
          paddingHorizontal: 16,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>{open ? '▾' : '▸'}</Text>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg2, letterSpacing: 0.4, textTransform: 'uppercase' }}>
          {T('section.reorder.historyTitle')} · {rows.length}
        </Text>
      </TouchableOpacity>

      {open ? (
        <View testID="ordering-history-panel" style={{ maxHeight: 260 }}>
          {/* Column header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 6,
              paddingHorizontal: 16,
              borderTopWidth: 1,
              borderTopColor: C.border,
              backgroundColor: C.bg,
              gap: 10,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.4, textTransform: 'uppercase', width: 110 }}>
              {T('section.reorder.historyColDate')}
            </Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.4, textTransform: 'uppercase', flex: 1 }}>
              {T('section.reorder.historyColVendor')}
            </Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.4, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>
              {T('section.reorder.historyColTotal')}
            </Text>
          </View>

          {rows.length === 0 ? (
            <Text
              testID="ordering-history-empty"
              style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}
            >
              {T('section.reorder.historyEmpty')}
            </Text>
          ) : (
            <ScrollView contentContainerStyle={{ paddingBottom: 6 }}>
              {rows.map((o, i) => (
                <View
                  key={o.id}
                  testID={`ordering-history-row-${o.id}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 8,
                    paddingHorizontal: 16,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: C.border,
                    gap: 10,
                  }}
                >
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, width: 110, fontVariant: ['tabular-nums'] }}>
                    {(o.referenceDate || o.date || '').slice(0, 10) || '—'}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, flex: 1 }} numberOfLines={1}>
                    {o.vendorName || '—'}
                  </Text>
                  <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    {formatMoney(o.totalCost || 0)}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}

export default function OrderingSection() {
  const C = useCmdColors();
  return (
    <View testID="ordering-root" style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <View style={{ flex: 1, minHeight: 0 }}>
        <ReorderSection />
      </View>
      <OrderHistoryPanel />
    </View>
  );
}

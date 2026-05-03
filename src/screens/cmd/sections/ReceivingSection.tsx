import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { OrderSubmission } from '../../../types';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Pattern A — workflow: list of POs in flight (left) + line-items checklist
// (right). Real receiving requires a po_items join + per-row qty diff
// mutation, which lives in src/lib/db.ts. For Phase 10b we read from the
// existing orderSubmissions store (the closest thing to a "PO" the legacy
// app has) and derive a synthetic line-items table.
//
// When the proper purchase_orders / po_items wiring lands, this section's
// mock rows become real lookups; the chrome stays unchanged.
export default function ReceivingSection() {
  const C = useCmdColors();
  const orderSubmissions = useStore((s) => s.orderSubmissions);
  const inventory = useStore((s) => s.inventory);
  const vendors = useStore((s) => s.vendors);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const adjustStock = useStore((s) => s.adjustStock);
  const addAuditEvent = useStore((s) => s.addAuditEvent);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('lines.tsx');
  // Lines committed to the DB this session — one-way (no undo, since
  // there's no po_items row to flip back). Used for both visual ✓ and
  // click-lock so the user can't double-receive.
  const [committed, setCommitted] = React.useState<Set<string>>(new Set());

  // Filter to current store. Treat anything in orderSubmissions that's not
  // older than 14 days as "in flight" — close enough for the receiving
  // surface until purchase_orders + status field land.
  // NB: o.submittedAt comes back as a pre-formatted time-only string
  // ("1:27 AM") from fetchRecentPurchaseOrders, so it's not Date-parseable.
  // Use o.date (YYYY-MM-DD reference_date) for the cutoff check instead.
  const incoming = React.useMemo<OrderSubmission[]>(() => {
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    return orderSubmissions
      .filter((o) => o.storeId === currentStore.id)
      .filter((o) => {
        const t = o.date ? new Date(o.date).getTime() : NaN;
        return Number.isFinite(t) && t >= cutoff;
      })
      .slice(0, 10);
  }, [orderSubmissions, currentStore.id]);

  React.useEffect(() => {
    if (selectedId && incoming.find((o) => o.id === selectedId)) return;
    setSelectedId(incoming[0]?.id || null);
  }, [incoming, selectedId]);

  const sel = incoming.find((o) => o.id === selectedId);

  // Synthetic line items — pull a few items from the matching vendor's
  // catalog so the table reads as plausible until po_items data lands.
  const lineItems = React.useMemo(() => {
    if (!sel) return [];
    const vendor = vendors.find((v) => v.name?.toLowerCase() === sel.vendorName?.toLowerCase());
    const vendorItems = vendor
      ? inventory.filter((i) => i.vendorId === vendor.id && i.storeId === currentStore.id)
      : inventory.filter((i) => i.storeId === currentStore.id).slice(0, 5);
    return vendorItems.slice(0, 7).map((i, idx) => {
      const orderedQty = Math.max(1, Math.round(i.parLevel - i.currentStock));
      // Mock state: alternating ok/short/pending so the visual reads
      const state: 'ok' | 'short' | 'pending' = idx === 3 ? 'short' : idx < 3 ? 'ok' : 'pending';
      const receivedQty = state === 'ok' ? orderedQty : state === 'short' ? Math.max(0, orderedQty - 1) : 0;
      return {
        id: i.id,
        name: i.name,
        unit: i.unit,
        ordered: orderedQty,
        received: receivedQty,
        cost: orderedQty * i.costPerUnit,
        state,
      };
    });
  }, [sel, inventory, vendors, currentStore.id]);

  // Single-click commit: bump stock by the received qty and add an audit
  // event. No undo — once committed, the line is locked. The synthetic
  // line-items table can't track a real "received" flag (no po_items
  // table yet), so the audit log is the durable trail.
  const commitReceive = (lid: string) => {
    if (committed.has(lid) || !sel) return;
    const li = lineItems.find((x) => x.id === lid);
    if (!li) return;
    const item = inventory.find((i) => i.id === li.id);
    if (!item) return;
    const qtyToReceive = li.received > 0 ? li.received : li.ordered;
    if (qtyToReceive <= 0) return;
    const newStock = item.currentStock + qtyToReceive;
    adjustStock(item.id, newStock, currentUser?.name || 'unknown');
    addAuditEvent({
      timestamp: new Date().toISOString(),
      userId: currentUser?.id || '',
      userName: currentUser?.name || 'unknown',
      userRole: 'user',
      storeId: currentStore.id,
      storeName: currentStore.name,
      action: 'Stock adjusted',
      detail: `Received from ${sel.vendorName}`,
      itemRef: item.name,
      value: `+${qtyToReceive} ${item.unit}`,
    });
    setCommitted((prev) => {
      const next = new Set(prev);
      next.add(lid);
      return next;
    });
    Toast.show({
      type: 'success',
      text1: 'Received',
      text2: `${item.name} +${qtyToReceive} ${item.unit}`,
    });
  };

  const matched = React.useMemo(() => {
    let m = 0;
    for (const li of lineItems) {
      if (committed.has(li.id) || li.state === 'ok') m++;
    }
    return m;
  }, [lineItems, committed]);
  const shorts = lineItems.filter((li) => li.state === 'short').length;
  const invoiceTotal = lineItems.reduce((s, li) => s + li.cost, 0);
  const actualTotal = lineItems
    .filter((li) => li.state === 'ok' || committed.has(li.id))
    .reduce((s, li) => s + (li.received / Math.max(1, li.ordered)) * li.cost, 0);

  return (
    <>
      {/* List pane */}
      <View
        style={{
          width: 300,
          backgroundColor: C.panel,
          borderRightWidth: 1,
          borderRightColor: C.border,
        }}
      >
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 14,
            paddingBottom: 10,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
            flexDirection: 'row',
            alignItems: 'baseline',
            justifyContent: 'space-between',
          }}
        >
          <Text style={[Type.h2, { color: C.fg }]}>Receiving</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {incoming.length} in flight
          </Text>
        </View>
        <FlatList
          data={incoming}
          keyExtractor={(o) => o.id}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              no incoming orders
            </Text>
          }
          renderItem={({ item: o }) => {
            const isSel = o.id === selectedId;
            return (
              <TouchableOpacity
                onPress={() => setSelectedId(o.id)}
                activeOpacity={0.85}
                style={{
                  paddingHorizontal: 16 - (isSel ? 2 : 0),
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: C.border,
                  borderLeftWidth: isSel ? 2 : 0,
                  borderLeftColor: C.accent,
                  backgroundColor: isSel ? C.accentBg : 'transparent',
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg }}>
                    {shortId(o.id)}
                  </Text>
                  <StatusPill status="info" label="in transit" />
                </View>
                <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg }} numberOfLines={1}>
                  {o.vendorName}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  {o.day} · {o.date.slice(0, 10)}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Detail pane */}
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {!sel ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
              {incoming.length === 0
                ? 'no incoming orders to receive'
                : 'select an order'}
            </Text>
          </View>
        ) : (
          <>
            <TabStrip
              tabs={[
                { id: 'lines.tsx', label: 'lines.tsx' },
                { id: 'docs.tsx',  label: 'docs.tsx' },
                { id: 'flag.tsx',  label: 'flag.tsx' },
              ]}
              activeId={tabId}
              onChange={setTabId}
              rightSlot={
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>SCAN BARCODE</Text>
                  </View>
                  <View style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>FINISH RECEIVING</Text>
                  </View>
                </View>
              }
            />
            <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.id)}</Text>
                  <StatusPill status="low" label="receiving" />
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                    · {sel.day} · arrived {sel.submittedAt.slice(11, 16)}
                  </Text>
                </View>
                <Text style={[Type.h1, { color: C.fg }]}>{sel.vendorName} · {lineItems.length} lines</Text>
                <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                  Match each line to invoice. Short or damaged → flag for credit.
                </Text>
              </View>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <StatCard label="Lines matched" value={`${matched} / ${lineItems.length}`} sub={`${Math.round((matched / Math.max(1, lineItems.length)) * 100)}% complete`} />
                <StatCard label="Shorts" value={String(shorts)} sub={shorts > 0 ? 'flag for credit' : '—'} />
                <StatCard label="Damaged" value="0" sub="—" />
                <StatCard label="Invoice total" value={`$${invoiceTotal.toFixed(2)}`} sub={`actual $${actualTotal.toFixed(2)}`} />
              </View>

              {/* Line items table */}
              <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
                  <SectionCaption tone="fg3" size={10.5}>line_items.tsv</SectionCaption>
                  <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>tap to commit · stock + audit only (no undo)</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
                  <View style={{ width: 18 }} />
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 60 }]}>id</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, flex: 1 }]}>name</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>ordered</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>received</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>line $</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 70, textAlign: 'right' }]}>state</Text>
                </View>
                {lineItems.length === 0 ? (
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
                    no line items found for this vendor
                  </Text>
                ) : (
                  lineItems.map((li, i) => {
                    const isCommitted = committed.has(li.id);
                    const isReceived = isCommitted || li.state === 'ok';
                    const stateForPill: 'ok' | 'low' | 'out' | 'info' =
                      li.state === 'ok' ? 'ok' : li.state === 'short' ? 'low' : 'info';
                    return (
                      <TouchableOpacity
                        key={li.id}
                        onPress={() => commitReceive(li.id)}
                        disabled={isCommitted}
                        activeOpacity={0.85}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingVertical: 10,
                          paddingHorizontal: 14,
                          gap: 10,
                          borderTopWidth: i === 0 ? 0 : 1,
                          borderTopColor: C.border,
                          backgroundColor: li.state === 'short' ? C.warnBg : 'transparent',
                        }}
                      >
                        <View
                          style={{
                            width: 14, height: 14, borderRadius: 3, borderWidth: 1,
                            borderColor: isReceived ? C.accent : C.borderStrong,
                            backgroundColor: isReceived ? C.accent : 'transparent',
                            alignItems: 'center', justifyContent: 'center',
                          }}
                        >
                          {isReceived ? <Text style={{ fontSize: 9, color: '#000', fontWeight: '700', lineHeight: 11 }}>✓</Text> : null}
                        </View>
                        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 60 }}>{shortId(li.id)}</Text>
                        <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                          {li.name}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          {li.ordered} {li.unit}
                        </Text>
                        <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: li.state === 'short' ? C.warn : (li.received > 0 ? C.fg : C.fg3), width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          {li.received > 0 ? `${li.received} ${li.unit}` : '—'}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          ${li.cost.toFixed(2)}
                        </Text>
                        <View style={{ width: 70, alignItems: 'flex-end' }}>
                          <StatusPill status={stateForPill} label={li.state.toUpperCase()} />
                        </View>
                      </TouchableOpacity>
                    );
                  })
                )}
              </View>
            </ScrollView>
          </>
        )}
      </View>
    </>
  );
}

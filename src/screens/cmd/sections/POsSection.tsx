import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { OrderSubmission } from '../../../types';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Pattern B — list+detail. Reads useStore.orderSubmissions (closest thing
// to "purchase orders" in the legacy data model). Detail pane shows a
// synthetic line-item table sourced from the matching vendor's catalog.
export default function POsSection() {
  const C = useCmdColors();
  const orderSubmissions = useStore((s) => s.orderSubmissions);
  const inventory = useStore((s) => s.inventory);
  const vendors = useStore((s) => s.vendors);
  const currentStore = useStore((s) => s.currentStore);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('order.tsx');
  const [statusFilter, setStatusFilter] = React.useState<'all' | 'draft' | 'sent' | 'rcvd'>('all');

  const allOrders = React.useMemo(
    () =>
      orderSubmissions
        .filter((o) => o.storeId === currentStore.id)
        .slice()
        .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1)),
    [orderSubmissions, currentStore.id],
  );

  // Derive a status from age — within 24h = sent, 24h–14d = rcvd, none of
  // ours are drafts since they're already submitted. This is a stand-in
  // until the real purchase_orders table lands.
  const orderStatus = (o: OrderSubmission): 'sent' | 'rcvd' => {
    const age = Date.now() - new Date(o.submittedAt).getTime();
    return age < 24 * 3600 * 1000 ? 'sent' : 'rcvd';
  };

  const filtered = React.useMemo(() => {
    if (statusFilter === 'all') return allOrders;
    if (statusFilter === 'draft') return [];
    return allOrders.filter((o) => orderStatus(o) === statusFilter);
  }, [allOrders, statusFilter]);

  React.useEffect(() => {
    if (selectedId && filtered.find((o) => o.id === selectedId)) return;
    setSelectedId(filtered[0]?.id || null);
  }, [filtered, selectedId]);

  const sel = filtered.find((o) => o.id === selectedId);
  const selStatus = sel ? orderStatus(sel) : 'sent';

  const lineItems = React.useMemo(() => {
    if (!sel) return [];
    const vendor = vendors.find((v) => v.name?.toLowerCase() === sel.vendorName?.toLowerCase());
    const vendorItems = vendor
      ? inventory.filter((i) => i.vendorId === vendor.id && i.storeId === currentStore.id)
      : [];
    return vendorItems.map((i) => {
      const qty = Math.max(1, Math.round(i.parLevel - i.currentStock || 1));
      return {
        id: i.id,
        name: i.name,
        unit: i.unit,
        qty,
        unitCost: i.costPerUnit,
        lineCost: qty * i.costPerUnit,
      };
    });
  }, [sel, vendors, inventory, currentStore.id]);

  const subtotal = lineItems.reduce((s, li) => s + li.lineCost, 0);
  const counts = {
    all:   allOrders.length,
    draft: 0,
    sent:  allOrders.filter((o) => orderStatus(o) === 'sent').length,
    rcvd:  allOrders.filter((o) => orderStatus(o) === 'rcvd').length,
  };

  return (
    <>
      {/* List pane */}
      <View
        style={{
          width: 340,
          backgroundColor: C.panel,
          borderRightWidth: 1,
          borderRightColor: C.border,
        }}
      >
        <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: C.border, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <Text style={[Type.h2, { color: C.fg }]}>Purchase orders</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {allOrders.length} total
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {(['all', 'draft', 'sent', 'rcvd'] as const).map((k) => {
              const n = counts[k];
              const sel = statusFilter === k;
              return (
                <TouchableOpacity
                  key={k}
                  onPress={() => setStatusFilter(k)}
                  style={{
                    flexDirection: 'row',
                    gap: 5,
                    alignItems: 'center',
                    paddingHorizontal: 9,
                    paddingVertical: 4,
                    borderRadius: 99,
                    borderWidth: 1,
                    borderColor: sel ? C.accent : C.border,
                    backgroundColor: sel ? C.accentBg : C.panel2,
                  }}
                >
                  <Text style={{ fontFamily: mono(600), fontSize: 10.5, color: sel ? C.fg : C.fg2 }}>{k}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{n}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
        <FlatList
          data={filtered}
          keyExtractor={(o) => o.id}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {allOrders.length === 0 ? 'no orders submitted' : 'no orders matching filter'}
            </Text>
          }
          renderItem={({ item: o }) => {
            const isSel = o.id === selectedId;
            const status = orderStatus(o);
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
                  <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg }}>{shortId(o.id)}</Text>
                  <StatusPill status={status === 'sent' ? 'low' : 'ok'} label={status} />
                </View>
                <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg }} numberOfLines={1}>
                  {o.vendorName}
                </Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    {o.day}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    {o.date.slice(0, 10)}
                  </Text>
                </View>
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
              {allOrders.length === 0
                ? 'no purchase orders submitted yet'
                : 'select an order'}
            </Text>
          </View>
        ) : (
          <>
            <TabStrip
              tabs={[
                { id: 'order.tsx',    label: 'order.tsx' },
                { id: 'docs.tsx',     label: 'docs.tsx' },
                { id: 'history.tsx',  label: 'history.tsx' },
              ]}
              activeId={tabId}
              onChange={setTabId}
              rightSlot={
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>DUPLICATE</Text>
                  </View>
                  <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>EDIT</Text>
                  </View>
                  <View style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>RESEND</Text>
                  </View>
                </View>
              }
            />
            <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.id)}</Text>
                  <StatusPill status={selStatus === 'sent' ? 'low' : 'ok'} label={selStatus} />
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                    · sent {sel.submittedAt.slice(0, 10)}
                  </Text>
                </View>
                <Text style={[Type.h1, { color: C.fg }]}>
                  {sel.vendorName} · {lineItems.length} lines
                </Text>
                <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                  {sel.day} delivery · submitted by {sel.submittedBy}
                </Text>
              </View>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <StatCard label="Lines" value={String(lineItems.length)} sub="from vendor catalog" />
                <StatCard label="Order total" value={`$${subtotal.toFixed(2)}`} sub="net 14d" />
                <StatCard label="Status" value={selStatus.toUpperCase()} sub={selStatus === 'sent' ? 'awaiting receipt' : 'received'} />
                <StatCard label="Delivery" value={sel.day.slice(0, 3)} sub={sel.date.slice(0, 10)} />
              </View>

              <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
                  <SectionCaption tone="fg3" size={10.5}>order_lines.tsv</SectionCaption>
                  <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{lineItems.length} items</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70 }}>id</Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>name</Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>qty</Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>unit $</Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>line $</Text>
                </View>
                {lineItems.length === 0 ? (
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
                    no line items derived for this vendor
                  </Text>
                ) : (
                  <>
                    {lineItems.map((li, i) => (
                      <View
                        key={li.id}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingVertical: 9,
                          paddingHorizontal: 14,
                          gap: 10,
                          borderTopWidth: i === 0 ? 0 : 1,
                          borderTopColor: C.border,
                          borderStyle: 'dashed',
                        }}
                      >
                        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 70 }}>{shortId(li.id)}</Text>
                        <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>
                          {li.name}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          {li.qty} {li.unit}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          ${li.unitCost.toFixed(2)}
                        </Text>
                        <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          ${li.lineCost.toFixed(2)}
                        </Text>
                      </View>
                    ))}
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        padding: 14,
                        gap: 10,
                        borderTopWidth: 1,
                        borderTopColor: C.borderStrong,
                        backgroundColor: C.panel2,
                      }}
                    >
                      <View style={{ width: 70 }} />
                      <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>
                        subtotal · {lineItems.length} lines
                      </Text>
                      <View style={{ width: 90 }} />
                      <View style={{ width: 90 }} />
                      <Text style={{ fontFamily: mono(700), fontSize: 13, color: C.fg, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                        ${subtotal.toFixed(2)}
                      </Text>
                    </View>
                  </>
                )}
              </View>
            </ScrollView>
          </>
        )}
      </View>
    </>
  );
}

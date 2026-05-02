import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { PropertiesJson } from '../../../components/cmd/PropertiesJson';
import { SectionCaption } from '../../../components/cmd/SectionCaption';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Pattern B — list+detail. Fork of the Inventory desktop pane, replacing
// the right-pane content with vendor profile + catalog + properties.
export default function VendorsSection() {
  const C = useCmdColors();
  const vendors = useStore((s) => s.vendors);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('profile.tsx');

  React.useEffect(() => {
    if (selectedId && vendors.find((v) => v.id === selectedId)) return;
    setSelectedId(vendors[0]?.id || null);
  }, [vendors, selectedId]);

  const sel = vendors.find((v) => v.id === selectedId);
  const catalog = React.useMemo(
    () => (sel ? inventory.filter((i) => i.vendorId === sel.id && i.storeId === currentStore.id) : []),
    [inventory, sel, currentStore.id],
  );

  return (
    <>
      {/* List pane */}
      <View
        style={{
          width: 300,
          backgroundColor: C.panel,
          borderRightWidth: 1,
          borderRightColor: C.border,
          minHeight: 0,
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
          <Text style={[Type.h2, { color: C.fg }]}>Vendors</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {vendors.length} active
          </Text>
        </View>
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={vendors}
          keyExtractor={(v) => v.id}
          renderItem={({ item: v }) => {
            const isSel = v.id === selectedId;
            return (
              <TouchableOpacity
                onPress={() => setSelectedId(v.id)}
                activeOpacity={0.85}
                style={{
                  paddingHorizontal: 16 - (isSel ? 2 : 0),
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: C.border,
                  borderLeftWidth: isSel ? 2 : 0,
                  borderLeftColor: C.accent,
                  backgroundColor: isSel ? C.accentBg : 'transparent',
                  gap: 3,
                }}
              >
                <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg }}>{v.name}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  {(v.categories || []).join(', ').toLowerCase() || 'no categories'}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  lead {v.leadTimeDays ?? 0}d{v.orderCutoffTime ? ` · cutoff ${v.orderCutoffTime}` : ''}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Detail pane */}
      <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0, minWidth: 0 }}>
        {!sel ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
              {vendors.length === 0 ? 'no vendors yet' : 'select a vendor'}
            </Text>
          </View>
        ) : (
          <>
            <TabStrip
              tabs={[
                { id: 'profile.tsx',  label: 'profile.tsx' },
                { id: 'catalog.tsx',  label: 'catalog.tsx' },
                { id: 'orders.tsx',   label: 'orders.tsx' },
                { id: 'contacts.tsx', label: 'contacts.tsx' },
              ]}
              activeId={tabId}
              onChange={setTabId}
              rightSlot={
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>EDIT</Text>
                  </View>
                  <View style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>+ NEW PO</Text>
                  </View>
                </View>
              }
            />
            <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
              {/* Hero */}
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.id)}</Text>
                  <StatusPill status="ok" label="ACTIVE" />
                </View>
                <Text style={[Type.h1, { color: C.fg }]}>{sel.name}</Text>
                <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                  {(sel.categories || []).join(' · ') || 'no categories'}
                  {sel.contactName ? ` · ${sel.contactName}` : ''}
                  {sel.phone ? ` · ${sel.phone}` : ''}
                </Text>
              </View>

              {tabId === 'profile.tsx' ? (
                <>
                  {/* 4-up stats */}
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <StatCard label="Lead time"   value={`${sel.leadTimeDays ?? 0}d`}            sub="standard" />
                    <StatCard label="Cutoff"      value={sel.orderCutoffTime || '—'}             sub={(sel.deliveryDays || []).join(' ').toLowerCase() || 'no schedule'} />
                    <StatCard label="Catalog"     value={`${catalog.length}`}                    sub="items @ this store" />
                    <StatCard label="Last order"  value={sel.lastOrderDate ? sel.lastOrderDate.slice(0, 10) : '—'} sub="trailing 90d" />
                  </View>

                  {/* Catalog + properties side-by-side */}
                  <View style={{ flexDirection: 'row', gap: 14 }}>
                    <View
                      style={{
                        flex: 1.4,
                        backgroundColor: C.panel,
                        borderRadius: CmdRadius.lg,
                        borderWidth: 1,
                        borderColor: C.border,
                        padding: 14,
                        gap: 6,
                      }}
                    >
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <SectionCaption tone="fg3" size={10.5}>catalog</SectionCaption>
                        <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{catalog.length} items</Text>
                      </View>
                      {catalog.length === 0 ? (
                        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>
                          no items at this store
                        </Text>
                      ) : (
                        catalog.map((it, i) => (
                          <View
                            key={it.id}
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 10,
                              paddingVertical: 6,
                              borderTopWidth: i === 0 ? 0 : 1,
                              borderTopColor: C.border,
                              borderStyle: 'dashed',
                            }}
                          >
                            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 60 }}>{shortId(it.id)}</Text>
                            <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>{it.name}</Text>
                            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg, width: 110, fontVariant: ['tabular-nums'] }}>
                              ${it.costPerUnit.toFixed(2)}/{it.unit}
                            </Text>
                            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 60, textAlign: 'right' }}>
                              par {it.parLevel}
                            </Text>
                          </View>
                        ))
                      )}
                    </View>

                    <View
                      style={{
                        flex: 1,
                        backgroundColor: C.panel,
                        borderRadius: CmdRadius.lg,
                        borderWidth: 1,
                        borderColor: C.border,
                        padding: 14,
                        gap: 6,
                      }}
                    >
                      <SectionCaption tone="fg3" size={10.5}>properties.json</SectionCaption>
                      <PropertiesJson
                        entries={[
                          { key: 'categories',     value: `"${(sel.categories || []).join(', ') || '—'}"` },
                          { key: 'lead_time_days', value: String(sel.leadTimeDays ?? '—') },
                          { key: 'cutoff',         value: `"${sel.orderCutoffTime || '—'}"` },
                          { key: 'delivery_days',  value: `"${(sel.deliveryDays || []).join(' ') || '—'}"` },
                          { key: 'contact',        value: `"${sel.contactName || '—'}"` },
                          { key: 'phone',          value: `"${sel.phone || '—'}"` },
                          { key: 'email',          value: `"${sel.email || '—'}"` },
                          { key: 'account_number', value: sel.accountNumber ? `"${sel.accountNumber}"` : '—' },
                        ]}
                      />
                    </View>
                  </View>
                </>
              ) : (
                <View
                  style={{
                    backgroundColor: C.panel,
                    borderRadius: CmdRadius.lg,
                    borderWidth: 1,
                    borderColor: C.border,
                    padding: 16,
                    gap: 6,
                  }}
                >
                  <SectionCaption tone="fg3">status</SectionCaption>
                  <Text style={{ fontFamily: mono(600), fontSize: 16, color: C.fg2, letterSpacing: -0.3 }}>
                    awaiting design handoff
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                    tab: {tabId}
                  </Text>
                </View>
              )}
            </ScrollView>
          </>
        )}
      </View>
    </>
  );
}

import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { POHistoryTab } from './POsSection';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { PropertiesJson } from '../../../components/cmd/PropertiesJson';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { VendorFormDrawer } from '../../../components/cmd/VendorFormDrawer';
import { confirmAction } from '../../../utils/confirmAction';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Pattern B — list+detail. Fork of the Inventory desktop pane, replacing
// the right-pane content with vendor profile + catalog + properties.
export default function VendorsSection() {
  const C = useCmdColors();
  const vendors = useStore((s) => s.vendors);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const deleteVendor = useStore((s) => s.deleteVendor);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('profile.tsx');
  const [editDrawerOpen, setEditDrawerOpen] = React.useState(false);
  const [newDrawerOpen, setNewDrawerOpen] = React.useState(false);

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
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {vendors.length} active
            </Text>
            <TouchableOpacity
              onPress={() => setNewDrawerOpen(true)}
              style={{ paddingVertical: 3, paddingHorizontal: 7, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
              accessibilityRole="button"
              accessibilityLabel="New vendor"
            >
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: '#000' }}>+ NEW</Text>
            </TouchableOpacity>
          </View>
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
                  <TouchableOpacity
                    onPress={() => setEditDrawerOpen(true)}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>EDIT</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      confirmAction(
                        `Delete vendor "${sel.name}"?`,
                        'Items still pointing at this vendor will keep the foreign-key value but show as "no vendor" until reassigned.',
                        () => {
                          deleteVendor(sel.id);
                          setSelectedId(null);
                          Toast.show({ type: 'success', text1: 'Deleted', text2: sel.name });
                        },
                      );
                    }}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.sm }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.danger }}>DELETE</Text>
                  </TouchableOpacity>
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
              ) : tabId === 'catalog.tsx' ? (
                <VendorCatalogTab vendorId={sel.id} />
              ) : tabId === 'orders.tsx' ? (
                <POHistoryTab vendorIdFilter={sel.id} />
              ) : tabId === 'contacts.tsx' ? (
                <VendorContactsPlaceholder vendorName={sel.name} contactName={sel.contactName} email={sel.email} phone={sel.phone} />
              ) : null}
            </ScrollView>
          </>
        )}
      </View>

      <VendorFormDrawer
        visible={newDrawerOpen}
        mode="new"
        onClose={() => setNewDrawerOpen(false)}
      />
      <VendorFormDrawer
        visible={editDrawerOpen}
        mode="edit"
        vendor={sel}
        onClose={() => setEditDrawerOpen(false)}
      />
    </>
  );
}

// ─── catalog.tsx — items vendor supplies, deduped at brand level ──────
function VendorCatalogTab({ vendorId }: { vendorId: string }) {
  const C = useCmdColors();
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const items = React.useMemo(() => {
    return inventory
      .filter((it) => it.vendorId === vendorId && it.storeId === currentStore.id)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [inventory, vendorId, currentStore.id]);

  const totalValue = items.reduce((s, it) => s + (it.casePrice || 0), 0);

  return (
    <View style={{ gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>vendor · catalog</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Items this vendor supplies at the current store. Each row is a per-store inventory_items row keyed to vendor_id.
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label="SKUs" value={String(items.length)} sub="at this store" />
        <StatCard label="Case sum" value={`$${totalValue.toFixed(0)}`} sub="list price total" />
        <StatCard label="Avg lead time" value="—" sub="per vendor" />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>catalog.tsv</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{items.length}</Text>
        </View>
        {items.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            no items at this store linked to this vendor
          </Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1.4 }}>item</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>category</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>case</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>cost / u</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70, textAlign: 'right' }}>par</Text>
            </View>
            {items.map((it, i) => (
              <View key={it.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1.4 }} numberOfLines={1}>{it.name}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, flex: 1 }} numberOfLines={1}>{it.category}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right' }}>
                  {it.casePrice ? `$${it.casePrice.toFixed(0)}` : '—'}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 80, textAlign: 'right' }}>
                  {it.costPerUnit ? `$${it.costPerUnit.toFixed(2)}` : '—'}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg3, width: 70, textAlign: 'right' }}>{it.parLevel}</Text>
              </View>
            ))}
          </>
        )}
      </View>
    </View>
  );
}

// ─── contacts.tsx — vendor contacts (Tier 2 — needs vendor_contacts table) ─
function VendorContactsPlaceholder({ vendorName, contactName, email, phone }: { vendorName: string; contactName?: string; email?: string; phone?: string }) {
  const C = useCmdColors();
  return (
    <View style={{ gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{vendorName} · contacts</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Recipients (orders / credits / rep) + open + resolved threads.
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>primary_contact.json</SectionCaption>
        </View>
        <View style={{ padding: 14, gap: 6 }}>
          <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg }}>name: <Text style={{ color: C.fg2 }}>{contactName || 'unset'}</Text></Text>
          <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg }}>email: <Text style={{ color: C.fg2 }}>{email || 'unset'}</Text></Text>
          <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg }}>phone: <Text style={{ color: C.fg2 }}>{phone || 'unset'}</Text></Text>
        </View>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>THREADS — NOT YET WIRED</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          Multi-recipient threads (orders / credits / rep) need a `vendor_contacts` + `vendor_threads` table — coming in a follow-up migration.
        </Text>
      </View>
    </View>
  );
}

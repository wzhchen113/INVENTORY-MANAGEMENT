import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { SectionCaption } from '../../../components/cmd/SectionCaption';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

interface SuggestedRow {
  itemId: string;
  itemName: string;
  vendorId: string | undefined;
  vendorName: string;
  category: string;
  unit: string;
  onHand: number;
  par: number;
  gap: number;        // par - onHand (only > 0)
  suggested: number;  // rounded-up gap with safety pad
  costPerUnit: number;
  estCost: number;
  status: 'low' | 'out';
}

// Pattern A — workflow: full-width auto-populated table (item · on-hand · par
// · gap · suggested · vendor · est cost) with per-row checkbox. Sticky-ish
// footer summarizes the selection and groups by vendor for one-click
// multi-PO creation. For Phase 10b this stops at a placeholder toast — real
// PO creation calls into the existing `addStore -> createPurchaseOrder`
// flow which is outside the cmd theme's surface-area.
export default function RestockSection() {
  const C = useCmdColors();
  const inventory = useStore((s) => s.inventory);
  const vendors = useStore((s) => s.vendors);
  const currentStore = useStore((s) => s.currentStore);
  const getItemStatus = useStore((s) => s.getItemStatus);

  const [tabId, setTabId] = React.useState('restock.tsx');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const rows = React.useMemo<SuggestedRow[]>(() => {
    const storeInv = inventory.filter((i) => i.storeId === currentStore.id);
    const vendorMap = new Map(vendors.map((v) => [v.id, v]));
    const out: SuggestedRow[] = [];
    for (const i of storeInv) {
      const status = getItemStatus(i);
      if (status === 'ok') continue;
      const gap = Math.max(0, i.parLevel - i.currentStock);
      // Suggest gap rounded to a whole unit, with a 20% safety margin.
      const suggested = Math.ceil(gap * 1.2);
      const v = vendorMap.get(i.vendorId);
      out.push({
        itemId: i.id,
        itemName: i.name,
        vendorId: i.vendorId,
        vendorName: v?.name || 'unset',
        category: i.category,
        unit: i.unit,
        onHand: i.currentStock,
        par: i.parLevel,
        gap,
        suggested,
        costPerUnit: i.costPerUnit,
        estCost: suggested * i.costPerUnit,
        status: status as 'low' | 'out',
      });
    }
    return out.sort((a, b) => {
      if (a.status === b.status) return a.vendorName.localeCompare(b.vendorName);
      return a.status === 'out' ? -1 : 1;
    });
  }, [inventory, vendors, currentStore.id, getItemStatus]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.itemId))));
  };

  const selectedRows = rows.filter((r) => selected.has(r.itemId));
  const selTotal = selectedRows.reduce((s, r) => s + r.estCost, 0);
  const selVendors = new Set(selectedRows.map((r) => r.vendorName)).size;

  const onCreatePOs = () => {
    if (selectedRows.length === 0) {
      Toast.show({ type: 'error', text1: 'Pick rows first' });
      return;
    }
    Toast.show({
      type: 'info',
      text1: `Create POs · ${selectedRows.length} items`,
      text2: `Splits into ${selVendors} vendor draft(s) — coming soon`,
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[
          { id: 'restock.tsx', label: 'restock.tsx' },
          { id: 'history.tsx', label: 'history.tsx' },
        ]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={toggleAll} style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
              <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>
                {selected.size === rows.length && rows.length > 0 ? 'CLEAR' : 'SELECT ALL'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onCreatePOs} style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>+ CREATE POs</Text>
            </TouchableOpacity>
          </View>
        }
      />

      <ScrollView contentContainerStyle={{ padding: 22, gap: 14, paddingBottom: 80 }}>
        {/* Hero */}
        <View>
          <Text style={[Type.h1, { color: C.fg }]}>Restock</Text>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            Items below par. Suggested qty = gap × 1.2 safety margin, rounded up.
          </Text>
        </View>

        {/* Stat strip */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatCard label="Items below par" value={String(rows.length)} sub={`${rows.filter((r) => r.status === 'out').length} out · ${rows.filter((r) => r.status === 'low').length} low`} />
          <StatCard label="Selected" value={String(selectedRows.length)} sub={selectedRows.length === 0 ? '—' : `${selVendors} vendor${selVendors === 1 ? '' : 's'}`} />
          <StatCard label="Est. total" value={`$${selTotal.toFixed(0)}`} sub="at current cost" />
          <StatCard label="Stockout risk" value={String(rows.filter((r) => r.status === 'out').length)} sub="zero on-hand" />
        </View>

        {/* Table */}
        <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
          {/* Header strip */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 8,
              paddingHorizontal: 14,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              gap: 10,
            }}
          >
            <View style={{ width: 18 }} />
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 60 }]}>id</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, flex: 1 }]}>name</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>on hand</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 60, textAlign: 'right' }]}>par</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>suggested</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 130 }]}>vendor</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>est $</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 60, textAlign: 'right' }]}>state</Text>
          </View>

          {rows.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              all stocked — no items below par
            </Text>
          ) : (
            rows.map((r, i) => {
              const sel = selected.has(r.itemId);
              return (
                <TouchableOpacity
                  key={r.itemId}
                  onPress={() => toggle(r.itemId)}
                  activeOpacity={0.85}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: C.border,
                    backgroundColor: sel ? C.accentBg : (r.status === 'out' ? C.dangerBg : 'transparent'),
                    gap: 10,
                  }}
                >
                  <View
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      borderWidth: 1,
                      borderColor: sel ? C.accent : C.borderStrong,
                      backgroundColor: sel ? C.accent : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {sel ? (
                      <Text style={{ fontSize: 9, color: '#000', fontWeight: '700', lineHeight: 11 }}>✓</Text>
                    ) : null}
                  </View>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 60 }}>{shortId(r.itemId)}</Text>
                  <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                    {r.itemName}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    {r.onHand} {r.unit}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 60, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    {r.par}
                  </Text>
                  <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    {r.suggested} {r.unit}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, width: 130 }} numberOfLines={1}>
                    {r.vendorName}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    ${r.estCost.toFixed(0)}
                  </Text>
                  <View style={{ width: 60, alignItems: 'flex-end' }}>
                    <StatusPill status={r.status} />
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* Sticky footer summary */}
      <View
        style={{
          backgroundColor: C.panel,
          borderTopWidth: 1,
          borderTopColor: C.border,
          paddingHorizontal: 22,
          paddingVertical: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <SectionCaption tone="fg2" size={10}>
          {selectedRows.length} of {rows.length} selected
        </SectionCaption>
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>
          est <Text style={{ color: C.fg, fontWeight: '600' }}>${selTotal.toFixed(2)}</Text>
        </Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>
          {selVendors} vendor{selVendors === 1 ? '' : 's'}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
          tap row to toggle · multi-vendor splits into draft POs
        </Text>
      </View>
    </View>
  );
}

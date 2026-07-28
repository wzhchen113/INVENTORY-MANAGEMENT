// src/screens/cmd/sections/phone/PhoneVendorsList.tsx — Spec 142 (chunk c).
//
// The phone Vendors surface (AC-VEN1/2). Full-width list → full-screen detail,
// no 300px pane, no tab strip. Row = delivery-days pill + name / contact · phone
// / "LEAD Nd" + "CUTOFF HH:MM · N ITEMS". Detail: LEAD TIME / CUTOFF / ITEMS
// stats; CONTACT / ORDER CODES / SCHEDULE sections; CALL VENDOR (tel: via
// Linking) + VIEW IN ORDERING actions. Reads the vendors + inventory slices.

import React from 'react';
import { View, Text, TouchableOpacity, FlatList, Linking, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { usePaletteAction } from '../../../../lib/paletteAction';
import { useT } from '../../../../hooks/useT';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';
import { StatPanel, GroupCaption, PropertyCard } from './PhoneWidgets';
import type { Vendor } from '../../../../types';

// ── Detail ───────────────────────────────────────────────────────────────────
function VendorDetail({ vendor }: { vendor: Vendor }) {
  const C = useCmdColors();
  const T = useT();
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const storeItems = inventory.filter((i) => i.storeId === currentStore?.id);
  const catalog = storeItems.filter((i) => i.vendorId === vendor.id);
  // Order codes: items linked to this vendor with their per-(item,vendor) SKU.
  const orderCodes = storeItems
    .map((i) => {
      const link = (i.vendors ?? []).find((v) => v.vendorId === vendor.id);
      if (!link && i.vendorId !== vendor.id) return null;
      return { id: i.id, name: i.name, code: (link?.orderCode ?? '').trim() };
    })
    .filter((x): x is { id: string; name: string; code: string } => x !== null);

  const call = () => {
    if (!vendor.phone) {
      Toast.show({ type: 'info', text1: T('section.vendors.unset') });
      return;
    }
    Linking.openURL(`tel:${vendor.phone.replace(/[^\d+]/g, '')}`);
  };
  const goOrdering = () => usePaletteAction.getState().request({ section: 'Ordering', selectedName: null });

  const contactRows = [
    { label: 'CONTACT', value: vendor.contactName || '—' },
    { label: 'PHONE', value: vendor.phone || '—' },
    { label: 'EMAIL', value: vendor.email || '—' },
    { label: 'ACCOUNT', value: vendor.accountNumber || '—' },
  ];
  const scheduleRows = [
    { label: 'DELIVERY DAYS', value: (vendor.deliveryDays || []).join(' ').toUpperCase() || '—' },
    { label: 'ORDER CUTOFF', value: vendor.orderCutoffTime || '—' },
    { label: 'LEAD TIME', value: `${vendor.leadTimeDays ?? 0}d` },
  ];

  return (
    <View style={{ padding: 16, gap: 16 }}>
      <View style={{ gap: 8 }}>
        <Text style={[PhoneType.microCaption, { color: C.fg3 }]} numberOfLines={1}>
          VENDOR · {(vendor.categories || []).join(' · ').toUpperCase() || '—'}
        </Text>
        <Text style={[PhoneType.detailTitle, { color: C.fg }]}>{vendor.name}</Text>
      </View>

      <StatPanel
        testID="phone-vendor-statpanel"
        cells={[
          { label: 'LEAD TIME', value: `${vendor.leadTimeDays ?? 0}d`, tone: 'fg' },
          { label: 'CUTOFF', value: vendor.orderCutoffTime || '—', tone: 'fg' },
          { label: 'ITEMS', value: `${catalog.length}`, tone: 'fg' },
        ]}
      />

      <PropertyCard title="CONTACT" rows={contactRows} />

      {/* Order codes */}
      <View style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, overflow: 'hidden' }}>
        <GroupCaption>ORDER CODES</GroupCaption>
        {orderCodes.length === 0 ? (
          <Text style={[PhoneType.metaMono, { color: C.fg3, paddingHorizontal: 14, paddingVertical: 12 }]}>{T('section.vendors.noItemsAtStore')}</Text>
        ) : (
          orderCodes.map((oc) => (
            <View key={oc.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.border }}>
              <Text style={[PhoneType.itemName, { color: C.fg, flex: 1 }]} numberOfLines={1}>{oc.name}</Text>
              <Text style={[PhoneType.metaMono, { color: oc.code ? C.fg2 : C.fg3 }]}>{oc.code || '—'}</Text>
            </View>
          ))
        )}
      </View>

      <PropertyCard title="SCHEDULE" rows={scheduleRows} />

      {/* Actions */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <TouchableOpacity
          testID="phone-vendor-call"
          onPress={call}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(600), fontSize: 12, letterSpacing: 0.5, color: C.fg2 }}>CALL VENDOR</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="phone-vendor-view-ordering"
          onPress={goOrdering}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.accentFg }}>VIEW IN ORDERING</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── List ─────────────────────────────────────────────────────────────────────
function DeliveryPill({ days }: { days: number }) {
  const C = useCmdColors();
  return (
    <View style={{ paddingHorizontal: 9, paddingVertical: 2, borderRadius: CmdRadius.pill, borderWidth: 0.5, borderColor: C.borderStrong, backgroundColor: C.panel2, alignSelf: 'flex-start' }}>
      <Text style={{ fontFamily: mono(700), fontSize: 10, letterSpacing: 0.5, color: C.fg2, fontVariant: ['tabular-nums'] }}>{days}×/WK</Text>
    </View>
  );
}

export const PhoneVendorsList: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const vendors = useStore((s) => s.vendors);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const drill = usePhoneDrill<Vendor>();

  const itemCount = React.useCallback(
    (vendorId: string) => inventory.filter((i) => i.vendorId === vendorId && i.storeId === currentStore?.id).length,
    [inventory, currentStore?.id],
  );

  const listNode = (
    <FlatList
      testID="phone-vendors-flatlist"
      style={{ flex: 1, minHeight: 0, backgroundColor: C.bg }}
      data={vendors}
      keyExtractor={(v) => v.id}
      initialNumToRender={12}
      windowSize={7}
      removeClippedSubviews={Platform.OS !== 'web'}
      ListEmptyComponent={
        <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>
          {T('section.vendors.noVendorsHint')}
        </Text>
      }
      renderItem={({ item: v }) => (
        <TouchableOpacity
          testID={`phone-vendor-row-${v.id}`}
          onPress={() => drill.open(v)}
          activeOpacity={0.7}
          style={{ minHeight: 56, paddingHorizontal: 14, paddingVertical: 10, gap: 4, borderBottomWidth: 1, borderBottomColor: C.border }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <DeliveryPill days={(v.deliveryDays || []).length} />
            <Text style={[PhoneType.itemName, { color: C.fg, flex: 1 }]} numberOfLines={1}>{v.name}</Text>
          </View>
          <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
            {v.contactName || '—'}{v.phone ? ` · ${v.phone}` : ''}
          </Text>
          <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
            LEAD {v.leadTimeDays ?? 0}d · CUTOFF {v.orderCutoffTime || '—'} · {itemCount(v.id)} ITEMS
          </Text>
        </TouchableOpacity>
      )}
    />
  );

  return (
    <PhoneDrillScaffold
      testID="phone-vendors"
      parentCaption="VENDORS"
      onBack={drill.close}
      list={listNode}
      detail={drill.selected ? <VendorDetail vendor={drill.selected} /> : null}
    />
  );
};

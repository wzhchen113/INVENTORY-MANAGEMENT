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
import { CopyToBrandDialog } from '../../../components/cmd/CopyToBrandDialog';
import { ListSkeleton } from '../../../components/cmd/ListSkeleton';
import { confirmAction } from '../../../utils/confirmAction';
import { useT } from '../../../hooks/useT';
import { useIsSuperAdmin } from '../../../hooks/useRole';
import type { Vendor } from '../../../types';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Pattern B — list+detail. Fork of the Inventory desktop pane, replacing
// the right-pane content with vendor profile + catalog + properties.
export default function VendorsSection() {
  const C = useCmdColors();
  const T = useT();
  const vendors = useStore((s) => s.vendors);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const deleteVendor = useStore((s) => s.deleteVendor);
  const brand = useStore((s) => s.brand);
  const isSuperAdmin = useIsSuperAdmin();
  // Spec 055 — first-mount-with-no-cache skeleton. `storeLoading` is the
  // global "talking to Supabase about your data" flag toggled by
  // loadFromSupabase. Pair with `vendors.length === 0` so subsequent
  // re-mounts with cached rows skip the skeleton (the top progress bar
  // handles background refreshes).
  const storeLoading = useStore((s) => s.storeLoading);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('profile.tsx');
  const [editDrawerOpen, setEditDrawerOpen] = React.useState(false);
  const [newDrawerOpen, setNewDrawerOpen] = React.useState(false);

  // Spec 049 — cross-brand copy. Selection is keyed on vendor.id (the
  // brand-level vendors row id — which is exactly what the RPC's
  // p_source_ids accepts).
  const [selectedVendorIds, setSelectedVendorIds] = React.useState<Set<string>>(() => new Set());
  const [copyDialogOpen, setCopyDialogOpen] = React.useState(false);
  const [singleRowVendor, setSingleRowVendor] = React.useState<Vendor | null>(null);

  const sourceBrandId = brand?.id || '';

  const toggleSelected = React.useCallback((id: string) => {
    setSelectedVendorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const copyTargets = React.useMemo(() => {
    const idsToUse = singleRowVendor
      ? [singleRowVendor.id]
      : Array.from(selectedVendorIds);
    const ids: string[] = [];
    const names: string[] = [];
    for (const id of idsToUse) {
      const v = vendors.find((vv) => vv.id === id);
      if (!v) continue;
      ids.push(v.id);
      names.push(v.name);
    }
    return { ids, names };
  }, [singleRowVendor, selectedVendorIds, vendors]);

  React.useEffect(() => {
    if (selectedId && vendors.find((v) => v.id === selectedId)) return;
    setSelectedId(vendors[0]?.id || null);
  }, [vendors, selectedId]);

  const sel = vendors.find((v) => v.id === selectedId);
  const catalog = React.useMemo(
    () => (sel ? inventory.filter((i) => i.vendorId === sel.id && i.storeId === currentStore.id) : []),
    [inventory, sel, currentStore.id],
  );

  // Spec 115 (W-5) — items LINKED to this vendor that lack an order code. NOTE:
  // this keys on the `item.vendors[]` LINK set (a superset that includes items
  // where this vendor is a NON-primary link), NOT the scalar `vendorId` the
  // `catalog` memo above filters on — that scalar-only count would UNDER-count
  // (miss secondary links). The two figures can legitimately differ; the
  // missing-code stat is link-scoped by AC-19's definition.
  const missingCodeCount = React.useMemo(() => {
    if (!sel) return 0;
    return inventory.filter(
      (i) =>
        i.storeId === currentStore.id &&
        (i.vendors ?? []).some((v) => v.vendorId === sel.id && !(v.orderCode ?? '').trim()),
    ).length;
  }, [inventory, sel, currentStore.id]);

  // Spec 055 first-mount skeleton — only fires on the initial load with
  // an empty slice. After the first fetch resolves (success OR empty),
  // subsequent re-mounts skip this branch.
  if (storeLoading && vendors.length === 0) {
    return <ListSkeleton rows={6} />;
  }

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
            gap: 8,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              justifyContent: 'space-between',
            }}
          >
            <Text style={[Type.h2, { color: C.fg }]}>{T('section.vendors.title')}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                {T('section.vendors.active', { count: vendors.length })}
              </Text>
              <TouchableOpacity
                onPress={() => setNewDrawerOpen(true)}
                style={{ paddingVertical: 3, paddingHorizontal: 7, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
                accessibilityRole="button"
                accessibilityLabel={T('section.vendors.newAria')}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: '#000' }}>+ NEW</Text>
              </TouchableOpacity>
            </View>
          </View>
          {/* Spec 049 — bulk-copy pill (super-admin only). Visible when
              the selection set is non-empty; hidden entirely for non-
              super-admin roles. */}
          {isSuperAdmin && selectedVendorIds.size > 0 ? (
            <TouchableOpacity
              onPress={() => {
                setSingleRowVendor(null);
                setCopyDialogOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={T('dialog.copyToBrand.bulkPillVendors', { count: selectedVendorIds.size })}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 10,
                backgroundColor: C.accent,
                borderRadius: CmdRadius.sm,
                alignSelf: 'flex-start',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>
                {T('dialog.copyToBrand.bulkPillVendors', { count: selectedVendorIds.size })}
              </Text>
              <TouchableOpacity
                onPress={(e) => {
                  e.stopPropagation?.();
                  setSelectedVendorIds(new Set());
                }}
                accessibilityRole="button"
                accessibilityLabel="Clear selection"
                hitSlop={6}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg, opacity: 0.7 }}>
                  ✕
                </Text>
              </TouchableOpacity>
            </TouchableOpacity>
          ) : null}
        </View>
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={vendors}
          keyExtractor={(v) => v.id}
          renderItem={({ item: v }) => {
            const isSel = v.id === selectedId;
            const isChecked = selectedVendorIds.has(v.id);
            const canCopy = isSuperAdmin && !!sourceBrandId;
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
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {/* Spec 049 — multi-select checkbox (super-admin only). */}
                  {isSuperAdmin ? (
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        toggleSelected(v.id);
                      }}
                      accessibilityRole="checkbox"
                      accessibilityLabel={T('dialog.copyToBrand.selectRowAria')}
                      accessibilityState={{ checked: isChecked }}
                      hitSlop={6}
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 3,
                        borderWidth: 1,
                        borderColor: isChecked ? C.accent : C.borderStrong,
                        backgroundColor: isChecked ? C.accent : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isChecked ? (
                        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg, lineHeight: 12 }}>
                          ✓
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  ) : null}
                  <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }}>
                    {v.name}
                  </Text>
                  {canCopy ? (
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        setSingleRowVendor(v);
                        setCopyDialogOpen(true);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={T('dialog.copyToBrand.rowActionLabel')}
                      hitSlop={4}
                      style={{
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 3,
                        borderWidth: 1,
                        borderColor: C.borderStrong,
                      }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 9.5, color: C.fg2, letterSpacing: 0.3 }}>
                        COPY
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  {(v.categories || []).join(', ').toLowerCase() || T('section.vendors.noCategories')}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  {v.orderCutoffTime
                    ? T('section.vendors.leadCutoffWithCutoff', { leadTime: v.leadTimeDays ?? 0, cutoff: v.orderCutoffTime })
                    : T('section.vendors.leadCutoff', { leadTime: v.leadTimeDays ?? 0 })}
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
              {vendors.length === 0 ? T('section.vendors.noVendorsHint') : T('section.vendors.selectVendor')}
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
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.vendors.edit')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      confirmAction(
                        T('section.vendors.deleteVendorConfirm', { name: sel.name }),
                        T('section.vendors.deleteVendorBody'),
                        () => {
                          deleteVendor(sel.id);
                          setSelectedId(null);
                          Toast.show({ type: 'success', text1: T('section.vendors.deletedToast'), text2: sel.name });
                        },
                        'Delete',
                      );
                    }}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.sm }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.danger }}>{T('section.vendors.delete')}</Text>
                  </TouchableOpacity>
                </View>
              }
            />
            <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
              {/* Hero */}
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.id)}</Text>
                  <StatusPill status="ok" label={T('section.vendors.active2')} />
                </View>
                <Text style={[Type.h1, { color: C.fg }]}>{sel.name}</Text>
                <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                  {(sel.categories || []).join(' · ') || T('section.vendors.noCategories')}
                  {sel.contactName ? ` · ${sel.contactName}` : ''}
                  {sel.phone ? ` · ${sel.phone}` : ''}
                </Text>
              </View>

              {tabId === 'profile.tsx' ? (
                <>
                  {/* 5-up stats. Spec 115 (W-5) — the "Missing codes" stat is
                      link-scoped (item.vendors[]), distinct from the primary-only
                      "Catalog" count beside it. */}
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <StatCard label={T('section.vendors.leadTime')}   value={`${sel.leadTimeDays ?? 0}d`}            sub={T('section.vendors.standard')} />
                    <StatCard label={T('section.vendors.cutoff')}      value={sel.orderCutoffTime || '—'}             sub={(sel.deliveryDays || []).join(' ').toLowerCase() || T('section.vendors.noSchedule')} />
                    <StatCard label={T('section.vendors.catalog')}     value={`${catalog.length}`}                    sub={T('section.vendors.itemsAtStore')} />
                    <StatCard testID="vendor-missing-codes" label={T('section.vendors.missingCodes')} value={`${missingCodeCount}`} sub={T('section.vendors.missingCodesSub')} />
                    <StatCard label={T('section.vendors.lastOrder')}  value={sel.lastOrderDate ? sel.lastOrderDate.slice(0, 10) : '—'} sub={T('section.vendors.trailing90d')} />
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
                        <SectionCaption tone="fg3" size={10.5}>{T('section.vendors.catalogCaption')}</SectionCaption>
                        <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.vendors.itemsCount', { count: catalog.length })}</Text>
                      </View>
                      {catalog.length === 0 ? (
                        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>
                          {T('section.vendors.noItemsAtStore')}
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
                              ${it.costPerUnit.toFixed(2)}/{it.subUnitUnit || 'each'}
                            </Text>
                            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 60, textAlign: 'right' }}>
                              {T('section.vendors.par', { value: it.parLevel })}
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

      {/* Spec 049 — cross-brand vendor copy dialog. Render-guarded on
          super-admin AND a non-empty source brand. */}
      {isSuperAdmin && sourceBrandId ? (
        <CopyToBrandDialog
          visible={copyDialogOpen}
          sourceBrandId={sourceBrandId}
          table="vendors"
          sourceIds={copyTargets.ids}
          sourceNames={copyTargets.names}
          onClose={() => {
            setCopyDialogOpen(false);
            setSingleRowVendor(null);
          }}
          onSuccess={() => {
            setSelectedVendorIds(new Set());
            setSingleRowVendor(null);
          }}
        />
      ) : null}
    </>
  );
}

// ─── catalog.tsx — items vendor supplies, deduped at brand level ──────
function VendorCatalogTab({ vendorId }: { vendorId: string }) {
  const C = useCmdColors();
  const T = useT();
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
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.vendors.catalogTabTitle')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.vendors.catalogTabSubtitle')}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label={T('section.vendors.skus')} value={String(items.length)} sub={T('section.vendors.atThisStore')} />
        <StatCard label={T('section.vendors.caseSum')} value={`$${totalValue.toFixed(0)}`} sub={T('section.vendors.listPriceTotal')} />
        <StatCard label={T('section.vendors.avgLeadTime')} value="—" sub={T('section.vendors.perVendor')} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>catalog.tsv</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{items.length}</Text>
        </View>
        {items.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            {T('section.vendors.noItemsForVendor')}
          </Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1.4 }}>{T('section.vendors.itemCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{T('section.vendors.categoryCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.vendors.caseCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.vendors.costPerUnitCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70, textAlign: 'right' }}>{T('section.vendors.parCol')}</Text>
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
  const T = useT();
  const unset = T('section.vendors.unset');
  return (
    <View style={{ gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.vendors.contactsTitle', { name: vendorName })}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.vendors.contactsSubtitle')}
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>{T('section.vendors.primaryContactJson')}</SectionCaption>
        </View>
        <View style={{ padding: 14, gap: 6 }}>
          <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg }}>{T('section.vendors.name')}: <Text style={{ color: C.fg2 }}>{contactName || unset}</Text></Text>
          <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg }}>{T('section.vendors.email')}: <Text style={{ color: C.fg2 }}>{email || unset}</Text></Text>
          <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg }}>{T('section.vendors.phone')}: <Text style={{ color: C.fg2 }}>{phone || unset}</Text></Text>
        </View>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>{T('section.vendors.threadsNotWired')}</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          {T('section.vendors.threadsNotWiredBody')}
        </Text>
      </View>
    </View>
  );
}

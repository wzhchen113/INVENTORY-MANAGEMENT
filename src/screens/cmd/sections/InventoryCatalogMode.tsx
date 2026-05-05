import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { StatusDot } from '../../../components/cmd/StatusDot';
import { PropertiesJson } from '../../../components/cmd/PropertiesJson';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { FilterInput } from '../../../components/cmd/FilterInput';
import { FilterChip } from '../../../components/cmd/FilterChip';
import { ComingSoonPanel } from '../../../components/cmd/ComingSoonPanel';
import { IngredientFormDrawer } from '../../../components/cmd/IngredientFormDrawer';
import { ExportCsvDrawer } from '../../../components/cmd/ExportCsvDrawer';
import { relativeTime } from '../../../utils/relativeTime';
import { confirmAction } from '../../../utils/confirmAction';
import Toast from 'react-native-toast-message';
import type { InventoryItem, ItemStatus } from '../../../types';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);
const isUnfinished = (i: InventoryItem) => !i.costPerUnit || i.costPerUnit === 0;

// Most critical status across stores wins: out > low > ok.
function aggStatus(getStatus: (i: InventoryItem) => ItemStatus, rows: InventoryItem[]): ItemStatus {
  if (rows.some((r) => getStatus(r) === 'out')) return 'out';
  if (rows.some((r) => getStatus(r) === 'low')) return 'low';
  return 'ok';
}

interface Group {
  key: string;             // lowercase name — de-facto cross-store key
  name: string;
  category: string;
  unit: string;
  rows: InventoryItem[];   // one per store
  totalStock: number;
  weightedCost: number;    // Σ stock × cost (for stock-weighted avg)
  storeCount: number;
  unfinished: boolean;
  primary: InventoryItem;  // first row — used for ID + base properties
}

interface Props {
  /** Currently selected item, keyed by lowercase name. Survives mode switches. */
  selectedName: string | null;
  /** Called when user clicks a catalog row. Always lowercase. */
  onSelectName: (name: string | null) => void;
  /** Rendered at the top of the list pane — used for the items.tsv ↔ catalog.tsv toggle. */
  topSlot?: React.ReactNode;
}

// Catalog lens on the same inventory_items table as the per-store view.
// Groups inventory rows by lowercase name (legacy convention) so admin
// can curate ingredients across stores. Selection is controlled by the
// parent (InventoryDesktopLayout) so flipping items.tsv ↔ catalog.tsv
// keeps focus on the same logical ingredient.
export default function InventoryCatalogMode({ selectedName, onSelectName, topSlot }: Props) {
  const C = useCmdColors();
  const inventory      = useStore((s) => s.inventory);
  const stores         = useStore((s) => s.stores);
  const vendors        = useStore((s) => s.vendors);
  const ingredientCats = useStore((s) => s.ingredientCategories);
  const getItemStatus  = useStore((s) => s.getItemStatus);
  const deleteItem     = useStore((s) => s.deleteItem);

  const [filterText, setFilterText]         = React.useState('');
  const [categoryFilter, setCategoryFilter] = React.useState<string | null>(null);
  const [showUnfinished, setShowUnfinished] = React.useState(false);
  const [tabId, setTabId]                   = React.useState('ingredient.tsx');
  const [newDrawerOpen, setNewDrawerOpen]   = React.useState(false);
  const [editDrawerOpen, setEditDrawerOpen] = React.useState(false);
  const [exportOpen, setExportOpen]         = React.useState(false);

  const groups = React.useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const it of inventory) {
      const k = it.name.toLowerCase();
      let g = map.get(k);
      if (!g) {
        g = {
          key: k,
          name: it.name,
          category: it.category,
          unit: it.unit,
          rows: [],
          totalStock: 0,
          weightedCost: 0,
          storeCount: 0,
          unfinished: false,
          primary: it,
        };
        map.set(k, g);
      }
      g.rows.push(it);
      g.totalStock    += it.currentStock || 0;
      g.weightedCost  += (it.currentStock || 0) * (it.costPerUnit || 0);
    }
    for (const g of map.values()) {
      g.storeCount = new Set(g.rows.map((r) => r.storeId)).size;
      g.unfinished = g.rows.some(isUnfinished);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [inventory]);

  const filtered = React.useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return groups.filter((g) => {
      if (q && !g.name.toLowerCase().includes(q) && !g.category.toLowerCase().includes(q)) return false;
      if (categoryFilter && g.category !== categoryFilter) return false;
      if (showUnfinished && !g.unfinished) return false;
      return true;
    });
  }, [groups, filterText, categoryFilter, showUnfinished]);

  // Auto-select on first render only — once the user (or items.tsv mode)
  // has a selection, keep it even when filters narrow it out of view.
  React.useEffect(() => {
    if (selectedName) return;
    if (filtered[0]) onSelectName(filtered[0].key);
  }, [filtered, selectedName, onSelectName]);

  const sel = groups.find((g) => g.key === selectedName);

  const catCounts = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of groups) m[g.category] = (m[g.category] || 0) + 1;
    return m;
  }, [groups]);
  const unfinishedCount = React.useMemo(() => groups.filter((g) => g.unfinished).length, [groups]);

  // Stock-weighted avg cost; falls back to simple mean if no stock anywhere.
  const selAvgCost = sel
    ? sel.totalStock > 0
      ? sel.weightedCost / sel.totalStock
      : sel.rows.reduce((s, r) => s + (r.costPerUnit || 0), 0) / Math.max(1, sel.rows.length)
    : 0;
  const selAvgPar = sel
    ? sel.rows.reduce((s, r) => s + (r.parLevel || 0), 0) / Math.max(1, sel.rows.length)
    : 0;
  const selStatus = sel ? aggStatus(getItemStatus, sel.rows) : 'ok';
  const selVendorName = sel
    ? sel.rows.find((r) => r.vendorName)?.vendorName || 'unset'
    : 'unset';
  const selVendor = sel
    ? vendors.find((v) => sel.rows.some((r) => r.vendorId === v.id))
    : undefined;
  const selLastCount = sel
    ? sel.rows.reduce<string | null>(
        (latest, r) => (r.lastUpdatedAt && (!latest || r.lastUpdatedAt > latest) ? r.lastUpdatedAt : latest),
        null,
      )
    : null;

  return (
    <>
      {/* List pane */}
      <View
        style={{
          width: 340,
          backgroundColor: C.panel,
          borderRightWidth: 1,
          borderRightColor: C.border,
          minHeight: 0,
        }}
      >
        {topSlot}
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 14,
            paddingBottom: 10,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <Text style={[Type.h2, { color: C.fg }]}>Inventory</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {groups.length} unique
            </Text>
          </View>
          <FilterInput
            value={filterText}
            onChangeText={setFilterText}
            placeholder="cat:protein vendor:sysco"
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6 }}
          >
            <FilterChip
              label="all"
              count={groups.length}
              selected={!categoryFilter && !showUnfinished}
              onPress={() => {
                setCategoryFilter(null);
                setShowUnfinished(false);
              }}
            />
            {ingredientCats.map((cat) => (
              <FilterChip
                key={cat}
                label={cat.toLowerCase()}
                count={catCounts[cat] || 0}
                selected={categoryFilter === cat}
                onPress={() => {
                  setShowUnfinished(false);
                  setCategoryFilter(categoryFilter === cat ? null : cat);
                }}
              />
            ))}
            {unfinishedCount > 0 ? (
              <FilterChip
                label="unfinished"
                count={unfinishedCount}
                selected={showUnfinished}
                onPress={() => {
                  setCategoryFilter(null);
                  setShowUnfinished(!showUnfinished);
                }}
              />
            ) : null}
          </ScrollView>
        </View>
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={filtered}
          keyExtractor={(g) => g.key}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {groups.length === 0 ? 'no ingredients defined yet' : 'no matches'}
            </Text>
          }
          renderItem={({ item: g }) => {
            const isSel = g.key === selectedName;
            const groupStatus = aggStatus(getItemStatus, g.rows);
            const avgCost = g.totalStock > 0
              ? g.weightedCost / g.totalStock
              : g.rows.reduce((s, r) => s + (r.costPerUnit || 0), 0) / Math.max(1, g.rows.length);
            return (
              <TouchableOpacity
                onPress={() => onSelectName(g.key)}
                activeOpacity={0.85}
                style={{
                  paddingHorizontal: 16 - (isSel ? 2 : 0),
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: C.border,
                  borderLeftWidth: isSel ? 2 : 0,
                  borderLeftColor: C.accent,
                  backgroundColor: isSel ? C.accentBg : 'transparent',
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <StatusDot status={groupStatus} />
                  <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                    {g.name}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                    {shortId(g.primary.id)}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    {g.category.toLowerCase()}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    in {g.storeCount} {g.storeCount === 1 ? 'store' : 'stores'}
                  </Text>
                  <View style={{ flex: 1 }} />
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: g.unfinished ? C.danger : C.fg, fontVariant: ['tabular-nums'] }}>
                    {avgCost > 0 ? `$${avgCost.toFixed(2)}/${g.unit}` : 'no cost'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Detail pane */}
      <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0, minWidth: 0 }}>
        {!sel ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
              {groups.length === 0 ? 'no ingredients defined' : 'select an ingredient'}
            </Text>
          </View>
        ) : (
          <>
            <TabStrip
              tabs={[
                { id: 'ingredient.tsx',  label: 'ingredient.tsx' },
                { id: 'stores.tsx',      label: 'stores.tsx' },
                { id: 'conversions.tsx', label: 'conversions.tsx' },
                { id: 'audit.tsx',       label: 'audit.tsx' },
              ]}
              activeId={tabId}
              onChange={setTabId}
              rightSlot={
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity onPress={() => setExportOpen(true)} style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>EXPORT CSV</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setEditDrawerOpen(true)} style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>EDIT</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      confirmAction(
                        `Delete "${sel.name}" everywhere?`,
                        `Removes ${sel.rows.length} per-store inventory ${sel.rows.length === 1 ? 'row' : 'rows'} across all stores. The brand catalog ingredient is left in place — re-link by counting at any store again.`,
                        () => {
                          sel.rows.forEach((r) => deleteItem(r.id));
                          onSelectName(null);
                          Toast.show({ type: 'success', text1: 'Deleted', text2: `${sel.name} (${sel.rows.length} stores)` });
                        },
                      );
                    }}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.sm }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.danger }}>DELETE</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setNewDrawerOpen(true)} style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>+ NEW INGREDIENT</Text>
                  </TouchableOpacity>
                </View>
              }
            />

            {tabId === 'ingredient.tsx' ? (
              <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
                {/* Hero */}
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.primary.id)}</Text>
                    <StatusPill status={selStatus} />
                  </View>
                  <Text style={[Type.display, { color: C.fg }]}>{sel.name}</Text>
                  <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                    {sel.category.toLowerCase()} · supplied by {selVendorName} · in {sel.storeCount} {sel.storeCount === 1 ? 'store' : 'stores'} · last edited {relativeTime(selLastCount) || 'never'} ago
                  </Text>
                </View>

                {/* 4-up stats — cross-store rollup */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <StatCard label="Stores"        value={String(sel.storeCount)}                       sub={`of ${stores.length} total`} />
                  <StatCard label="Total on hand" value={`${sel.totalStock.toFixed(1)} ${sel.unit}`}    sub="across all stores" />
                  <StatCard label="Avg cost / unit" value={selAvgCost > 0 ? `$${selAvgCost.toFixed(2)}` : '—'} sub="stock-weighted" />
                  <StatCard label="Avg par"       value={selAvgPar > 0 ? `${selAvgPar.toFixed(1)} ${sel.unit}` : '—'} sub="per store" />
                </View>

                {/* Stores breakdown + properties */}
                <View style={{ flexDirection: 'row', gap: 14 }}>
                  <View
                    style={{
                      flex: 1.4,
                      backgroundColor: C.panel,
                      borderRadius: CmdRadius.lg,
                      borderWidth: 1,
                      borderColor: C.border,
                      overflow: 'hidden',
                    }}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
                      <SectionCaption tone="fg3" size={10.5}>stores.tsv</SectionCaption>
                      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                        {sel.rows.length} {sel.rows.length === 1 ? 'row' : 'rows'}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 30 }}>id</Text>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>store</Text>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>on hand</Text>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60, textAlign: 'right' }}>par</Text>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 50, textAlign: 'right' }}>status</Text>
                    </View>
                    {sel.rows.map((row, i) => {
                      const store = stores.find((s) => s.id === row.storeId);
                      const rowStatus = getItemStatus(row);
                      return (
                        <View
                          key={row.id}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingVertical: 8,
                            paddingHorizontal: 14,
                            gap: 10,
                            borderTopWidth: i === 0 ? 0 : 1,
                            borderTopColor: C.border,
                            borderStyle: 'dashed',
                          }}
                        >
                          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 30 }}>
                            s{i + 1}
                          </Text>
                          <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>
                            {store?.name || row.storeId.slice(0, 6)}
                          </Text>
                          <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                            {row.currentStock} {row.unit}
                          </Text>
                          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 60, textAlign: 'right' }}>
                            {row.parLevel}
                          </Text>
                          <View style={{ width: 50, alignItems: 'flex-end' }}>
                            <StatusPill status={rowStatus} />
                          </View>
                        </View>
                      );
                    })}
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
                        { key: 'category',      value: `"${sel.category}"` },
                        { key: 'unit',          value: `"${sel.unit}"` },
                        { key: 'sub_unit',      value: sel.primary.subUnitUnit ? `"${sel.primary.subUnitSize} ${sel.primary.subUnitUnit}"` : '—' },
                        { key: 'case_qty',      value: String(sel.primary.caseQty || '—') },
                        { key: 'case_price',    value: sel.primary.casePrice ? `$${sel.primary.casePrice.toFixed(2)}` : '—' },
                        { key: 'cost_per_unit', value: selAvgCost > 0 ? `$${selAvgCost.toFixed(2)}` : '—' },
                        { key: 'avg_par_level', value: selAvgPar > 0 ? selAvgPar.toFixed(1) : '—' },
                        { key: 'safety_stock',  value: String(Math.max(0, ...sel.rows.map((r) => r.safetyStock || 0))) },
                        { key: 'lead_time_days', value: String(selVendor?.leadTimeDays ?? '—') },
                        { key: 'last_counted',  value: `"${relativeTime(selLastCount) || 'never'}"` },
                      ]}
                    />
                  </View>
                </View>
              </ScrollView>
            ) : tabId === 'stores.tsx' ? (
              <CatalogStoresTab sel={sel} />
            ) : tabId === 'conversions.tsx' ? (
              <CatalogConversionsTab sel={sel} />
            ) : tabId === 'audit.tsx' ? (
              <CatalogAuditTab sel={sel} />
            ) : (
              <View style={{ padding: 22 }}>
                <ComingSoonPanel tabName={tabId.replace('.tsx', '')} />
              </View>
            )}
          </>
        )}
      </View>

      <IngredientFormDrawer
        visible={newDrawerOpen}
        mode="new"
        onClose={() => setNewDrawerOpen(false)}
      />
      <IngredientFormDrawer
        visible={editDrawerOpen}
        mode="edit"
        item={sel?.primary}
        onClose={() => setEditDrawerOpen(false)}
      />
      <ExportCsvDrawer visible={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  );
}

// ─── stores.tsx — per-store overrides on the shared catalog row ────────
function CatalogStoresTab({ sel }: { sel: Group }) {
  const C = useCmdColors();
  const stores = useStore((s) => s.stores);
  const vendors = useStore((s) => s.vendors);
  const currentStore = useStore((s) => s.currentStore);
  const getItemStatus = useStore((s) => s.getItemStatus);

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{sel.name} · per-store</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Same catalog row, different per-store overrides (par, vendor, price, current stock).
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label="Stores carrying" value={`${sel.storeCount} / ${stores.length}`} sub="this catalog row" />
        <StatCard label="On hand · sum" value={`${sel.totalStock.toFixed(1)} ${sel.unit}`} sub="all stores combined" />
        <StatCard label="Par · range" value={`${Math.min(...sel.rows.map((r) => r.parLevel))}–${Math.max(...sel.rows.map((r) => r.parLevel))}`} sub={sel.unit} />
        <StatCard label="Cost · range" value={(() => {
          const costs = sel.rows.map((r) => r.costPerUnit || 0).filter((c) => c > 0);
          if (costs.length === 0) return '—';
          const lo = Math.min(...costs), hi = Math.max(...costs);
          return lo === hi ? `$${lo.toFixed(2)}` : `$${lo.toFixed(2)}–${hi.toFixed(2)}`;
        })()} sub="per store" />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>stores.tsv</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{sel.rows.length} rows</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1.4 }}>store</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1.2 }}>vendor</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>on hand</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60, textAlign: 'right' }}>par</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>cost / u</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60, textAlign: 'right' }}>status</Text>
        </View>
        {sel.rows.map((row, i) => {
          const store = stores.find((s) => s.id === row.storeId);
          const vendor = vendors.find((v) => v.id === row.vendorId);
          const isCurrent = row.storeId === currentStore.id;
          return (
            <View key={row.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, backgroundColor: isCurrent ? C.accentBg : 'transparent' }}>
              <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1.4 }} numberOfLines={1}>
                {store?.name || row.storeId.slice(0, 6)}{isCurrent ? ' ← current' : ''}
              </Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, flex: 1.2 }} numberOfLines={1}>
                {vendor?.name || '—'}
              </Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                {row.currentStock} {row.unit}
              </Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 60, textAlign: 'right' }}>{row.parLevel}</Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 80, textAlign: 'right' }}>
                {row.costPerUnit ? `$${row.costPerUnit.toFixed(2)}` : '—'}
              </Text>
              <View style={{ width: 60, alignItems: 'flex-end' }}>
                <StatusPill status={getItemStatus(row)} />
              </View>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

// ─── conversions.tsx — unit translation table ─────────────────────────
function CatalogConversionsTab({ sel }: { sel: Group }) {
  const C = useCmdColors();
  const allConversions = useStore((s) => s.ingredientConversions || []);
  // Conversions are brand-level keyed on catalog_id. The InventoryItem
  // rows here may have inventoryItemId (legacy) or catalogId — try both.
  const conversions = React.useMemo(() => {
    const ids = new Set<string>();
    for (const r of sel.rows) {
      if ((r as any).catalogId) ids.add((r as any).catalogId);
      ids.add(r.id); // legacy inventory_item_id link some seeds may have
    }
    return allConversions.filter((c: any) => ids.has(c.catalogId) || ids.has(c.inventoryItemId));
  }, [allConversions, sel.rows]);

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{sel.name} · conversions</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Unit translation table. Without these rows, recipes that use a different unit than the base can't compute cost or depletion.
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>conversions.tsv</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{conversions.length} {conversions.length === 1 ? 'row' : 'rows'} · base unit "{sel.unit}"</Text>
        </View>
        {conversions.length === 0 ? (
          <View style={{ padding: 18, gap: 6 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.warn, letterSpacing: 0.4 }}>FIX — NO CONVERSIONS</Text>
            <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2 }}>
              Recipes that consume {sel.name} in a unit other than {sel.unit} can't compute cost. Add a conversion row from any recipe edit screen.
            </Text>
          </View>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>purchase u</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60, textAlign: 'center' }}>→</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>base u</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 110, textAlign: 'right' }}>factor</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>net yield</Text>
            </View>
            {conversions.map((conv: any, i: number) => (
              <View key={conv.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg, flex: 1 }}>{conv.purchaseUnit || conv.purchase_unit}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 60, textAlign: 'center' }}>→</Text>
                <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg, flex: 1 }}>{conv.baseUnit || conv.base_unit}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg2, width: 110, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                  ×{(conv.conversionFactor || conv.conversion_factor || 0).toFixed(4)}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 80, textAlign: 'right' }}>
                  {(conv.netYieldPct ?? conv.net_yield_pct ?? 100)}%
                </Text>
              </View>
            ))}
          </>
        )}
      </View>
    </ScrollView>
  );
}

// ─── audit.tsx — audit log filtered to this catalog ingredient ─────────
function CatalogAuditTab({ sel }: { sel: Group }) {
  const C = useCmdColors();
  const auditLog = useStore((s) => s.auditLog);
  const events = React.useMemo(() => {
    const lname = sel.name.toLowerCase();
    return auditLog
      .filter((e) => (e.itemRef || '').toLowerCase() === lname)
      .slice()
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 60);
  }, [auditLog, sel.name]);

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{sel.name} · audit</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Audit log filtered to this catalog ingredient — every edit, count, waste, or stock adjust touches this list.
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>audit.log</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{events.length} event{events.length === 1 ? '' : 's'}</Text>
        </View>
        {events.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            no audit events recorded for {sel.name} yet
          </Text>
        ) : (
          events.map((e, i) => (
            <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, width: 110 }}>{new Date(e.timestamp).toISOString().slice(5, 16).replace('T', ' ')}</Text>
              <Text style={{ fontFamily: sans(600), fontSize: 12, color: C.fg, width: 130 }} numberOfLines={1}>{e.userName || '—'}</Text>
              <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg2, width: 150 }} numberOfLines={1}>{e.action}</Text>
              <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg, flex: 1 }} numberOfLines={1}>{e.value || e.detail || ''}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

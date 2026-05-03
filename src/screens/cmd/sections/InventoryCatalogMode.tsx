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

  const [filterText, setFilterText]         = React.useState('');
  const [categoryFilter, setCategoryFilter] = React.useState<string | null>(null);
  const [showUnfinished, setShowUnfinished] = React.useState(false);
  const [tabId, setTabId]                   = React.useState('ingredient.tsx');
  const [newDrawerOpen, setNewDrawerOpen]   = React.useState(false);
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
      <ExportCsvDrawer visible={exportOpen} onClose={() => setExportOpen(false)} />
    </>
  );
}

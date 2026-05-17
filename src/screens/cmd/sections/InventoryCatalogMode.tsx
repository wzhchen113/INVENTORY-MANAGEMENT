import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, TextInput, Platform } from 'react-native';
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
import { SelectField } from '../../../components/cmd/IngredientForm';
import { ExportCsvDrawer } from '../../../components/cmd/ExportCsvDrawer';
import { relativeTime } from '../../../utils/relativeTime';
import { confirmAction } from '../../../utils/confirmAction';
import { CANONICAL_UNITS } from '../../../utils/unitConversion';
import { isNumericInput } from '../../../utils/validators';
import Toast from 'react-native-toast-message';
import type { InventoryItem, ItemStatus, IngredientConversion } from '../../../types';
import { useT } from '../../../hooks/useT';
import { useLocale } from '../../../hooks/useLocale';
import { getLocalizedName } from '../../../i18n/localizedName';
import { matchesQuery } from '../../../i18n/matchesQuery';
import { unitLabel } from '../../../utils/enumLabels';

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
  /** Spec 040 P3 — passed through to getLocalizedName for display + search. */
  i18nNames?: import('../../../types').LocalizedNames;
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
  const T = useT();
  const locale         = useLocale();
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
          // Spec 040 P3 — carry the catalog-hydrated i18n names so the
          // list display + filter / sort logic can use them downstream.
          // Any row from this group has the same i18nNames (it's a catalog
          // ingredient field); first-write wins is fine.
          i18nNames: it.i18nNames,
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
    // Spec 040 P3 / Q5 — sort by current-locale display name.
    return Array.from(map.values()).sort((a, b) =>
      getLocalizedName({ name: a.name, i18nNames: a.i18nNames }, locale)
        .localeCompare(
          getLocalizedName({ name: b.name, i18nNames: b.i18nNames }, locale),
          locale,
        ),
    );
  }, [inventory, locale]);

  const filtered = React.useMemo(() => {
    return groups.filter((g) => {
      // Spec 040 P3 / Q4 — search matches BOTH the English canonical and
      // the current-locale translation (with diacritic + case folding via
      // matchesQuery). Category match also includes the localized
      // category label so a Spanish search for `proteína` finds Protein.
      if (filterText.trim()) {
        const localizedName = getLocalizedName({ name: g.name, i18nNames: g.i18nNames }, locale);
        const localizedCategory = (() => {
          const entry = ingredientCats.find((c) => c.name === g.category);
          return entry
            ? getLocalizedName({ name: entry.name, i18nNames: entry.i18nNames }, locale)
            : g.category;
        })();
        if (!matchesQuery(filterText, [localizedName, g.name, localizedCategory, g.category])) {
          return false;
        }
      }
      if (categoryFilter && g.category !== categoryFilter) return false;
      if (showUnfinished && !g.unfinished) return false;
      return true;
    });
  }, [groups, filterText, categoryFilter, showUnfinished, locale, ingredientCats]);

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
            {ingredientCats.map((cat) => {
              // Spec 040 P3 — chip label localizes; the join key
              // (categoryFilter / `cat.name`) stays English canonical.
              const label = getLocalizedName(
                { name: cat.name, i18nNames: cat.i18nNames },
                locale,
              );
              return (
                <FilterChip
                  key={cat.name}
                  label={label.toLowerCase()}
                  count={catCounts[cat.name] || 0}
                  selected={categoryFilter === cat.name}
                  onPress={() => {
                    setShowUnfinished(false);
                    setCategoryFilter(categoryFilter === cat.name ? null : cat.name);
                  }}
                />
              );
            })}
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
            // Spec 040 P3 — localized display label for the row.
            const localizedName = getLocalizedName(
              { name: g.name, i18nNames: g.i18nNames },
              locale,
            );
            const catEntry = ingredientCats.find((c) => c.name === g.category);
            const localizedCategory = catEntry
              ? getLocalizedName({ name: catEntry.name, i18nNames: catEntry.i18nNames }, locale)
              : g.category;
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
                    {localizedName}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                    {shortId(g.primary.id)}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    {localizedCategory.toLowerCase()}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    in {g.storeCount} {g.storeCount === 1 ? 'store' : 'stores'}
                  </Text>
                  <View style={{ flex: 1 }} />
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: g.unfinished ? C.danger : C.fg, fontVariant: ['tabular-nums'] }}>
                    {avgCost > 0 ? `$${avgCost.toFixed(2)}/${unitLabel(g.unit, T)}` : 'no cost'}
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
                  <Text style={[Type.display, { color: C.fg }]}>
                    {getLocalizedName({ name: sel.name, i18nNames: sel.i18nNames }, locale)}
                  </Text>
                  <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                    {sel.category.toLowerCase()} · supplied by {selVendorName} · in {sel.storeCount} {sel.storeCount === 1 ? 'store' : 'stores'} · last edited {relativeTime(selLastCount) || 'never'} ago
                  </Text>
                </View>

                {/* 4-up stats — cross-store rollup */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <StatCard label="Stores"        value={String(sel.storeCount)}                       sub={`of ${stores.length} total`} />
                  <StatCard label="Total on hand" value={`${sel.totalStock.toFixed(1)} ${unitLabel(sel.unit, T)}`}    sub="across all stores" />
                  <StatCard label="Avg cost / unit" value={selAvgCost > 0 ? `$${selAvgCost.toFixed(2)}` : '—'} sub="stock-weighted" />
                  <StatCard label="Avg par"       value={selAvgPar > 0 ? `${selAvgPar.toFixed(1)} ${unitLabel(sel.unit, T)}` : '—'} sub="per store" />
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
                            {row.currentStock} {unitLabel(row.unit, T)}
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
  const T = useT();
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
        <StatCard label="On hand · sum" value={`${sel.totalStock.toFixed(1)} ${unitLabel(sel.unit, T)}`} sub="all stores combined" />
        <StatCard label="Par · range" value={`${Math.min(...sel.rows.map((r) => r.parLevel))}–${Math.max(...sel.rows.map((r) => r.parLevel))}`} sub={unitLabel(sel.unit, T)} />
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
                {row.currentStock} {unitLabel(row.unit, T)}
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

// ─── conversions.tsx — unit translation table (CRUD per spec 004 §6) ───
// Numeric input regex shared with `IngredientForm` via
// `src/utils/validators.ts` — see import at top of file.

function NumericInput({ value, onChange, placeholder, width = 110, monoFont = true }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number; monoFont?: boolean }) {
  const C = useCmdColors();
  return (
    <TextInput
      value={value}
      onChangeText={(v) => { if (isNumericInput(v)) onChange(v); }}
      placeholder={placeholder}
      placeholderTextColor={C.fg3}
      keyboardType="decimal-pad"
      style={{
        width, height: 30, paddingHorizontal: 8,
        fontFamily: monoFont ? mono(400) : sans(500), fontSize: 12, color: C.fg,
        backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
        textAlign: 'right',
        ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
      }}
    />
  );
}

function CatalogConversionsTab({ sel }: { sel: Group }) {
  const C = useCmdColors();
  const T = useT();
  const allConversions = useStore((s) => s.ingredientConversions);
  const addIngredientConversion    = useStore((s) => s.addIngredientConversion);
  const updateIngredientConversion = useStore((s) => s.updateIngredientConversion);
  const deleteIngredientConversion = useStore((s) => s.deleteIngredientConversion);

  // Conversions are brand-level keyed on catalog_id. `IngredientConversion`
  // exposes that as `inventoryItemId` for back-compat (see types/index.ts:160).
  // Match against both the catalog id (canonical) and the per-store inventory
  // id so legacy seeds linked the old way still surface.
  const conversions = React.useMemo(() => {
    const ids = new Set<string>();
    for (const r of sel.rows) {
      if (r.catalogId) ids.add(r.catalogId);
      ids.add(r.id); // legacy inventory_item_id link some seeds may have
    }
    return allConversions.filter((c) => ids.has(c.inventoryItemId));
  }, [allConversions, sel.rows]);

  // The catalog_id we'll write new rows against — prefer the catalog id,
  // fall back to the inventory item id only if catalog isn't populated.
  const writeCatalogId = React.useMemo(() => {
    return sel.primary.catalogId || sel.primary.id;
  }, [sel.primary]);

  // Add-row form state — kept local to the tab; reset after save.
  const [addPurchaseUnit, setAddPurchaseUnit] = React.useState('');
  const [addBaseUnit, setAddBaseUnit]         = React.useState('lbs');
  const [addFactor, setAddFactor]             = React.useState('');
  const [addYield, setAddYield]               = React.useState('100');
  const [showAdvanced, setShowAdvanced]       = React.useState(false);

  // Edit state — id of row currently being edited + its in-progress values.
  const [editingId, setEditingId]   = React.useState<string | null>(null);
  const [editValues, setEditValues] = React.useState<{ purchaseUnit: string; baseUnit: string; factor: string; yield: string }>({ purchaseUnit: '', baseUnit: 'lbs', factor: '', yield: '100' });

  const baseUnitOptions = React.useMemo(
    () => CANONICAL_UNITS.map((u) => ({ value: u, label: unitLabel(u, T) })),
    [T],
  );

  // Distinct purchase units already used anywhere in the system — gives a
  // dropdown of likely picks while still allowing free-text below.
  // Many of these are non-canonical user-entered strings (`case`, `bag`,
  // etc.); `unitLabel` falls through to the raw value when no catalog
  // entry exists.
  const purchaseUnitOptions = React.useMemo(() => {
    const acc = new Set<string>();
    for (const c of allConversions) {
      const pu = c.purchaseUnit.toLowerCase().trim();
      if (pu) acc.add(pu);
    }
    return Array.from(acc).sort().map((u) => ({ value: u, label: unitLabel(u, T) }));
  }, [allConversions, T]);

  const handleAdd = () => {
    const pu = addPurchaseUnit.trim().toLowerCase();
    if (!pu) {
      Toast.show({ type: 'error', text1: 'Purchase unit is required' });
      return;
    }
    const factorN = parseFloat(addFactor);
    if (!isFinite(factorN) || factorN <= 0) {
      Toast.show({ type: 'error', text1: 'Factor must be a positive number' });
      return;
    }
    // Yield % must land in (0, 100]. Empty / blank input falls back to 100
    // (the column default). Negative or out-of-range inputs surface a toast
    // instead of silently coercing — would otherwise corrupt cost-calc step
    // 3 (security-auditor M1 / spec 004 fix-pass item 3).
    const yieldRaw = addYield.trim();
    let yieldN = 100;
    if (yieldRaw !== '') {
      const parsed = parseFloat(yieldRaw);
      if (!isFinite(parsed) || parsed <= 0 || parsed > 100) {
        Toast.show({ type: 'error', text1: 'Yield % must be between 0 and 100' });
        return;
      }
      yieldN = parsed;
    }
    const conv: Omit<IngredientConversion, 'id'> = {
      inventoryItemId: writeCatalogId, // TS-side back-compat name; semantically a catalog_id
      purchaseUnit: pu,
      baseUnit: addBaseUnit,
      conversionFactor: factorN,
      netYieldPct: yieldN,
    };
    addIngredientConversion(conv);
    Toast.show({ type: 'success', text1: 'Conversion added', text2: `1 ${pu} = ${factorN} ${addBaseUnit}` });
    setAddPurchaseUnit('');
    setAddFactor('');
    setAddYield('100');
    setShowAdvanced(false);
  };

  const startEdit = (conv: IngredientConversion) => {
    setEditingId(conv.id);
    setEditValues({
      purchaseUnit: conv.purchaseUnit,
      baseUnit: conv.baseUnit || 'lbs',
      factor: String(conv.conversionFactor ?? ''),
      yield: String(conv.netYieldPct ?? 100),
    });
  };
  const cancelEdit = () => setEditingId(null);
  const saveEdit = () => {
    if (!editingId) return;
    const pu = editValues.purchaseUnit.trim().toLowerCase();
    const factorN = parseFloat(editValues.factor);
    if (!pu) {
      Toast.show({ type: 'error', text1: 'Purchase unit is required' });
      return;
    }
    if (!isFinite(factorN) || factorN <= 0) {
      Toast.show({ type: 'error', text1: 'Factor must be a positive number' });
      return;
    }
    // Same range-check as handleAdd — security-auditor M1.
    const yieldRaw = editValues.yield.trim();
    let yieldN = 100;
    if (yieldRaw !== '') {
      const parsed = parseFloat(yieldRaw);
      if (!isFinite(parsed) || parsed <= 0 || parsed > 100) {
        Toast.show({ type: 'error', text1: 'Yield % must be between 0 and 100' });
        return;
      }
      yieldN = parsed;
    }
    updateIngredientConversion(editingId, {
      purchaseUnit: pu,
      baseUnit: editValues.baseUnit,
      conversionFactor: factorN,
      netYieldPct: yieldN,
    });
    Toast.show({ type: 'success', text1: 'Conversion updated' });
    setEditingId(null);
  };
  const handleDelete = (conv: IngredientConversion) => {
    confirmAction(
      `Delete conversion "${conv.purchaseUnit}"?`,
      'Recipes that use this purchase unit will fall back to step-2 cost-calc; if there is no sub-unit pair set, they will become unmatchable until the row is recreated.',
      () => {
        deleteIngredientConversion(conv.id);
        Toast.show({ type: 'success', text1: 'Conversion deleted' });
      },
    );
  };

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{sel.name} · conversions</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Unit translation table. Without these rows, recipes that use a different unit than the base can't compute cost or depletion.
        </Text>
      </View>

      {/* ── Add-row card ─────────────────────────────────────── */}
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <SectionCaption tone="fg3" size={10.5}>+ add conversion</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
            e.g. 1 case = 40 lbs (chicken leg)
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>purchase unit</Text>
            <TextInput
              value={addPurchaseUnit}
              onChangeText={setAddPurchaseUnit}
              placeholder="case / bag / tray"
              placeholderTextColor={C.fg3}
              autoCapitalize="none"
              style={{
                height: 30, paddingHorizontal: 8,
                fontFamily: mono(400), fontSize: 12, color: C.fg,
                backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
              }}
            />
            {purchaseUnitOptions.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {purchaseUnitOptions.slice(0, 6).map((opt) => (
                  <TouchableOpacity key={opt.value} onPress={() => setAddPurchaseUnit(opt.value)}
                    style={{ paddingVertical: 2, paddingHorizontal: 6, borderRadius: 3, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border }}>
                    <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{opt.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </View>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingBottom: 8 }}>=</Text>
          <View style={{ width: 100 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>factor</Text>
            <NumericInput value={addFactor} onChange={setAddFactor} placeholder="40" width={100} />
          </View>
          <View style={{ flex: 1 }}>
            <SelectField
              label="base unit"
              value={addBaseUnit}
              options={baseUnitOptions}
              onChange={setAddBaseUnit}
              monoFont
            />
          </View>
          <TouchableOpacity onPress={handleAdd} style={{ paddingVertical: 7, paddingHorizontal: 12, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
            <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#000' }}>ADD</Text>
          </TouchableOpacity>
        </View>
        {/* Advanced disclosure: net_yield_pct */}
        <TouchableOpacity onPress={() => setShowAdvanced((p) => !p)} activeOpacity={0.7}>
          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg3 }}>
            {showAdvanced ? '▼' : '▶'} advanced — yield % (default 100)
          </Text>
        </TouchableOpacity>
        {showAdvanced ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>net yield</Text>
            <NumericInput value={addYield} onChange={setAddYield} placeholder="92" width={80} />
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>% (waste / trim discount)</Text>
          </View>
        ) : null}
      </View>

      {/* ── Conversions list ──────────────────────────────── */}
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>conversions.tsv</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{conversions.length} {conversions.length === 1 ? 'row' : 'rows'} · base unit "{unitLabel(sel.unit, T)}"</Text>
        </View>
        {conversions.length === 0 ? (
          <View style={{ padding: 18, gap: 6 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.warn, letterSpacing: 0.4 }}>FIX — NO CONVERSIONS</Text>
            <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2 }}>
              Recipes that consume {sel.name} in a unit other than {unitLabel(sel.unit, T)} can't compute cost. Use the form above to add one — e.g. "1 case = 40 lbs".
            </Text>
          </View>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>purchase u</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 40, textAlign: 'center' }}>→</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>base u</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 110, textAlign: 'right' }}>factor</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70, textAlign: 'right' }}>net yield</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 110, textAlign: 'right' }}>actions</Text>
            </View>
            {conversions.map((conv, i) => {
              const isEditing = editingId === conv.id;
              return (
                <View key={conv.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                  {isEditing ? (
                    <>
                      <View style={{ flex: 1 }}>
                        <TextInput
                          value={editValues.purchaseUnit}
                          onChangeText={(v) => setEditValues((p) => ({ ...p, purchaseUnit: v }))}
                          placeholderTextColor={C.fg3}
                          autoCapitalize="none"
                          style={{ height: 26, paddingHorizontal: 6, fontFamily: mono(400), fontSize: 12, color: C.fg, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) }}
                        />
                      </View>
                      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 40, textAlign: 'center' }}>→</Text>
                      <View style={{ flex: 1 }}>
                        <SelectField label="" value={editValues.baseUnit} options={baseUnitOptions} onChange={(v) => setEditValues((p) => ({ ...p, baseUnit: v }))} monoFont />
                      </View>
                      <NumericInput value={editValues.factor} onChange={(v) => setEditValues((p) => ({ ...p, factor: v }))} width={110} />
                      <NumericInput value={editValues.yield} onChange={(v) => setEditValues((p) => ({ ...p, yield: v }))} width={70} />
                      <View style={{ flexDirection: 'row', gap: 6, width: 110, justifyContent: 'flex-end' }}>
                        <TouchableOpacity onPress={saveEdit} style={{ paddingVertical: 4, paddingHorizontal: 8, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
                          <Text style={{ fontFamily: mono(700), fontSize: 10, color: '#000' }}>SAVE</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={cancelEdit} style={{ paddingVertical: 4, paddingHorizontal: 8, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm }}>
                          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>CANCEL</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  ) : (
                    <>
                      <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg, flex: 1 }}>{unitLabel(conv.purchaseUnit, T)}</Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 40, textAlign: 'center' }}>→</Text>
                      <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg, flex: 1 }}>{unitLabel(conv.baseUnit, T)}</Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg2, width: 110, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                        ×{(conv.conversionFactor || 0).toFixed(4)}
                      </Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 70, textAlign: 'right' }}>
                        {conv.netYieldPct ?? 100}%
                      </Text>
                      <View style={{ flexDirection: 'row', gap: 6, width: 110, justifyContent: 'flex-end' }}>
                        <TouchableOpacity onPress={() => startEdit(conv)} style={{ paddingVertical: 4, paddingHorizontal: 8, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>EDIT</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => handleDelete(conv)} style={{ paddingVertical: 4, paddingHorizontal: 8, borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.sm }}>
                          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.danger }}>DEL</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              );
            })}
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

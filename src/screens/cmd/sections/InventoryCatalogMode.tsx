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
import { CopyToBrandDialog } from '../../../components/cmd/CopyToBrandDialog';
import { relativeTime } from '../../../utils/relativeTime';
import { confirmAction } from '../../../utils/confirmAction';
import { CANONICAL_UNITS } from '../../../utils/unitConversion';
import { perEachCost, piecesPerCase } from '../../../utils/perEachCost';
import { deriveBrandUnitPool } from '../../../utils/brandUnitPool';
import { isNumericInput } from '../../../utils/validators';
import Toast from 'react-native-toast-message';
import type { InventoryItem, ItemStatus, IngredientConversion } from '../../../types';
import { useT } from '../../../hooks/useT';
import { useLocale } from '../../../hooks/useLocale';
import { useIsSuperAdmin } from '../../../hooks/useRole';
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
  // Spec 122 — the edit drawer must seed from (and the fan-out re-center on)
  // the CURRENT store's row, not the arbitrary `primary` (first-iterated) row.
  const currentStore   = useStore((s) => s.currentStore);
  const vendors        = useStore((s) => s.vendors);
  const ingredientCats = useStore((s) => s.ingredientCategories);
  const getItemStatus  = useStore((s) => s.getItemStatus);
  const deleteItem     = useStore((s) => s.deleteItem);
  const brand          = useStore((s) => s.brand);
  const isSuperAdmin   = useIsSuperAdmin();

  const [filterText, setFilterText]         = React.useState('');
  const [categoryFilter, setCategoryFilter] = React.useState<string | null>(null);
  const [showUnfinished, setShowUnfinished] = React.useState(false);
  const [tabId, setTabId]                   = React.useState('ingredient.tsx');
  const [newDrawerOpen, setNewDrawerOpen]   = React.useState(false);
  const [editDrawerOpen, setEditDrawerOpen] = React.useState(false);
  const [exportOpen, setExportOpen]         = React.useState(false);

  // Spec 049 — cross-brand copy. Super-admin only. Selection is keyed
  // on group.key (= lowercase name) so it survives filter changes but
  // resets when the user navigates away. The dialog reads
  // `selectedCatalogIds` derived from the picked groups via the
  // primary row's catalogId.
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(() => new Set());
  const [copyDialogOpen, setCopyDialogOpen] = React.useState(false);
  // When the user clicks the per-row "Copy to brand…" overflow item we
  // need to seed the dialog with that single group, not the bulk
  // selection set. `singleRowGroup` holds that override; null = bulk.
  const [singleRowGroup, setSingleRowGroup] = React.useState<Group | null>(null);

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
      // Spec 104 — `weightedCost` is a stock-weighted-average-COST numerator,
      // NOT a stock-value dollar total: it is only ever divided by `totalStock`
      // to yield `avgCost` / `selAvgCost` (per-row cost cell, the "Avg cost /
      // unit" StatCard, and the `perEachCost` costPerUnit fallback). It must
      // therefore track the BASIS of costPerUnit (now per-EACH) and does NOT get
      // the OQ-5 `× subUnitSize` stock-value bridge. Bridging it would (a) make
      // "Avg cost / unit" read per-counted-unit ($40/case) instead of the OQ-3
      // per-each figure ($0.02), and (b) feed a per-counted-unit value into the
      // perEachCost fallback that this spec just made an identity over per-each
      // input — a double basis-mismatch. The single-price display "$avgCost/unit"
      // is only reached for pieces<=1 items (subUnitSize=1), where per-each ==
      // per-counted-unit, so it stays numerically unchanged. (The spec §7
      // consumer list names this line, but its own OQ-3 + fallback-identity
      // instructions require it stay UNBRIDGED — flagged to reviewers.)
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

  // Spec 049 — selected groups → catalog ids + names for the dialog.
  // Filter to groups that still exist in the current `groups` view
  // (the user may have applied a filter that hid some selected rows;
  // we still want to copy them, but we skip stragglers without a
  // catalogId since the RPC keys on catalog_ingredients.id, not the
  // per-store inventory_items.id).
  const groupsByKey = React.useMemo(() => {
    const m = new Map<string, Group>();
    for (const g of groups) m.set(g.key, g);
    return m;
  }, [groups]);

  const copyTargets = React.useMemo(() => {
    // Single-row override path (per-row overflow item) — use that one
    // group's catalogId. Bulk path: every key in selectedKeys.
    const keysToUse = singleRowGroup
      ? [singleRowGroup.key]
      : Array.from(selectedKeys);
    const ids: string[] = [];
    const names: string[] = [];
    for (const k of keysToUse) {
      const g = groupsByKey.get(k);
      if (!g) continue;
      const catId = g.primary.catalogId;
      if (!catId) continue;
      ids.push(catId);
      names.push(g.name);
    }
    return { ids, names };
  }, [singleRowGroup, selectedKeys, groupsByKey]);

  const toggleSelected = React.useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const sourceBrandId = brand?.id || '';

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
            <Text style={[Type.h2, { color: C.fg }]}>{T('section.inventory.title')}</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {T('section.inventory.uniqueCount', { count: groups.length })}
            </Text>
          </View>
          <FilterInput
            value={filterText}
            onChangeText={setFilterText}
            placeholder={T('section.inventory.filterPlaceholder')}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6 }}
          >
            <FilterChip
              label={T('section.inventory.filterAll')}
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
                label={T('section.inventory.filterUnfinished')}
                count={unfinishedCount}
                selected={showUnfinished}
                onPress={() => {
                  setCategoryFilter(null);
                  setShowUnfinished(!showUnfinished);
                }}
              />
            ) : null}
          </ScrollView>
          {/* Spec 049 — bulk-copy pill (super-admin only). Visible whenever
              the selection set is non-empty; hidden for non-super-admin
              roles entirely, so admin/master never see the affordance. */}
          {isSuperAdmin && selectedKeys.size > 0 ? (
            <TouchableOpacity
              onPress={() => {
                setSingleRowGroup(null);
                setCopyDialogOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={T('dialog.copyToBrand.bulkPillIngredients', { count: selectedKeys.size })}
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
                {T('dialog.copyToBrand.bulkPillIngredients', { count: selectedKeys.size })}
              </Text>
              <TouchableOpacity
                onPress={(e) => {
                  e.stopPropagation?.();
                  setSelectedKeys(new Set());
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
          data={filtered}
          keyExtractor={(g) => g.key}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {groups.length === 0 ? T('section.inventory.noIngredients') : T('section.inventory.noMatches')}
            </Text>
          }
          renderItem={({ item: g }) => {
            const isSel = g.key === selectedName;
            const isChecked = selectedKeys.has(g.key);
            const groupStatus = aggStatus(getItemStatus, g.rows);
            const avgCost = g.totalStock > 0
              ? g.weightedCost / g.totalStock
              : g.rows.reduce((s, r) => s + (r.costPerUnit || 0), 0) / Math.max(1, g.rows.length);
            // Spec 096 (Issue 2) — dual case/each price. `pieces` is the true
            // per-case smallest-unit count (caseQty × subUnitSize); the
            // per-each segment renders ONLY when there's a meaningful
            // breakdown (pieces > 1 AND a derivable per-each cost). The case
            // side uses g.primary.casePrice — the REAL case_price — so the
            // left number stops mislabeling a per-each figure as "/cases"
            // (the bug). avgCost feeds the helper's costPerUnit fallback for
            // the rare casePrice-unset row. See src/utils/perEachCost.ts.
            const pieces = piecesPerCase(g.primary.caseQty, g.primary.subUnitSize);
            const perEach = perEachCost({
              casePrice: g.primary.casePrice,
              costPerUnit: avgCost,
              caseQty: g.primary.caseQty,
              subUnitSize: g.primary.subUnitSize,
            });
            // The per-each segment shows when there's a meaningful breakdown
            // (AC6/AC8). The case segment is paired with it ONLY when the real
            // case_price is positive — so a rare casePrice-unset row (per-each
            // came from the costPerUnit fallback) shows just "$<each>/each"
            // rather than a misleading "$0.00/case".
            const showPerEach = pieces > 1 && perEach !== null;
            const hasCaseSide = showPerEach && g.primary.casePrice > 0;
            // Build the right-aligned cost cell string:
            //  - dual:        "$<case>/case · $<each>/each"   (hasCaseSide)
            //  - per-each only:"$<each>/each"                 (fallback path)
            //  - single:      "$<avgCost>/<unitLabel(g.unit)>" (AC8, unchanged)
            //  - no cost:     T('section.inventory.noCost')   (unchanged)
            // Spec 096 (Should-fix) — label the per-each segment with the item's
            // REAL smallest unit (`subUnitUnit`, e.g. "lb") instead of a hardcoded
            // "each", so Black Pepper reads "$8.40/lb" not "$8.40/each". Falls
            // back to "each" only when the item carries no sub-unit label. The
            // `perEach!` assertion is sound: `showPerEach` already gates on
            // `perEach !== null`, which TS can't narrow through the boolean.
            const eachLabel = unitLabel(g.primary.subUnitUnit || 'each', T);
            const costLabel = showPerEach
              ? hasCaseSide
                ? `$${g.primary.casePrice.toFixed(2)}/${T('section.inventory.perCase')} · $${perEach!.toFixed(2)}/${eachLabel}`
                : `$${perEach!.toFixed(2)}/${eachLabel}`
              : avgCost > 0
                ? `$${avgCost.toFixed(2)}/${unitLabel(g.unit, T)}`
                : T('section.inventory.noCost');
            // Spec 040 P3 — localized display label for the row.
            const localizedName = getLocalizedName(
              { name: g.name, i18nNames: g.i18nNames },
              locale,
            );
            const catEntry = ingredientCats.find((c) => c.name === g.category);
            const localizedCategory = catEntry
              ? getLocalizedName({ name: catEntry.name, i18nNames: catEntry.i18nNames }, locale)
              : g.category;
            // Spec 049 — Per-row "Copy to brand…" affordance only renders
            // for super-admin AND only when the group's primary row has
            // a brand-level catalog id (legacy seeds may lack it).
            const canCopy = isSuperAdmin && !!g.primary.catalogId && !!sourceBrandId;
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
                  {/* Spec 049 — multi-select checkbox (super-admin only).
                      onPress stops propagation so toggling the checkbox
                      doesn't also flip the row-selection. */}
                  {isSuperAdmin ? (
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        toggleSelected(g.key);
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
                    {g.storeCount === 1
                      ? T('section.inventory.inStore', { count: g.storeCount })
                      : T('section.inventory.inStores', { count: g.storeCount })}
                  </Text>
                  <View style={{ flex: 1 }} />
                  {canCopy ? (
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        setSingleRowGroup(g);
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
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: g.unfinished ? C.danger : C.fg, fontVariant: ['tabular-nums'] }}>
                    {costLabel}
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
              {groups.length === 0 ? T('section.inventory.noIngredientsDefined') : T('section.inventory.selectIngredient')}
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
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.inventory.exportCsv')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setEditDrawerOpen(true)} style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.inventory.edit')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      confirmAction(
                        T('section.inventory.deleteEverywhere', { name: sel.name }),
                        sel.rows.length === 1
                          ? T('section.inventory.deleteEverywhereBodyOne', { count: sel.rows.length })
                          : T('section.inventory.deleteEverywhereBody', { count: sel.rows.length }),
                        () => {
                          sel.rows.forEach((r) => deleteItem(r.id));
                          onSelectName(null);
                          Toast.show({ type: 'success', text1: T('section.inventory.deletedToast'), text2: T('section.inventory.deletedToastDetail', { name: sel.name, count: sel.rows.length }) });
                        },
                        'Delete',
                      );
                    }}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.sm }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.danger }}>{T('section.inventory.delete')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setNewDrawerOpen(true)} style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>{T('section.inventory.newIngredient')}</Text>
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
                    {sel.storeCount === 1
                      ? T('section.inventory.suppliedByOne', { category: sel.category.toLowerCase(), vendor: selVendorName, count: sel.storeCount, time: relativeTime(selLastCount) || T('section.inventory.neverEdited') })
                      : T('section.inventory.suppliedBy', { category: sel.category.toLowerCase(), vendor: selVendorName, count: sel.storeCount, time: relativeTime(selLastCount) || T('section.inventory.neverEdited') })}
                  </Text>
                </View>

                {/* 4-up stats — cross-store rollup */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <StatCard label={T('section.inventory.storesCard')}        value={String(sel.storeCount)}                       sub={T('section.inventory.ofTotal', { count: stores.length })} />
                  <StatCard label={T('section.inventory.totalOnHand')} value={`${sel.totalStock.toFixed(1)} ${unitLabel(sel.unit, T)}`}    sub={T('section.inventory.acrossStores')} />
                  <StatCard label={T('section.inventory.avgCostPerUnit')} value={selAvgCost > 0 ? `$${selAvgCost.toFixed(2)}` : '—'} sub={T('section.inventory.stockWeighted')} />
                  <StatCard label={T('section.inventory.avgPar')}       value={selAvgPar > 0 ? `${selAvgPar.toFixed(1)} ${unitLabel(sel.unit, T)}` : '—'} sub={T('section.inventory.perStore')} />
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
                      <SectionCaption tone="fg3" size={10.5}>{T('section.inventory.storesTsv')}</SectionCaption>
                      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                        {sel.rows.length === 1
                          ? T('section.inventory.rowsCountOne', { count: sel.rows.length })
                          : T('section.inventory.rowsCount', { count: sel.rows.length })}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 30 }}>id</Text>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{T('section.inventory.storeCol')}</Text>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.inventory.onHandCol')}</Text>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60, textAlign: 'right' }}>{T('section.inventory.parCol')}</Text>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 50, textAlign: 'right' }}>{T('section.inventory.statusCol')}</Text>
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
        // Spec 122 (AC-1) — seed from the CURRENT store's row for this catalog
        // ingredient when it exists; fall back to `sel.primary` (deterministic)
        // when the current store has no row. Fixes the wrong-store binding that
        // showed + saved par/cost to an arbitrary store.
        item={sel && (sel.rows.find((r) => r.storeId === currentStore.id) ?? sel.primary)}
        // Spec 122 — catalog.tsv Save fans par/cost/case_price out to every
        // store of the brand (items.tsv passes no flag → single-store).
        brandWide
        onClose={() => setEditDrawerOpen(false)}
      />
      <ExportCsvDrawer visible={exportOpen} onClose={() => setExportOpen(false)} />

      {/* Spec 049 — cross-brand copy dialog. Only mounted when the user
          has selected at least one row (bulk path) or clicked a per-row
          overflow item (single path). Render-guarded on isSuperAdmin
          AND a non-empty target list — the dialog itself shows an
          "no other brands available" empty state if the picker comes up
          short. */}
      {isSuperAdmin && sourceBrandId ? (
        <CopyToBrandDialog
          visible={copyDialogOpen}
          sourceBrandId={sourceBrandId}
          table="catalog_ingredients"
          sourceIds={copyTargets.ids}
          sourceNames={copyTargets.names}
          onClose={() => {
            setCopyDialogOpen(false);
            setSingleRowGroup(null);
          }}
          onSuccess={() => {
            // Clear the bulk selection on success so the pill goes away.
            // The single-row override is also dropped in onClose, but we
            // do it here too for the success path explicitly.
            setSelectedKeys(new Set());
            setSingleRowGroup(null);
          }}
        />
      ) : null}
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
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.inventory.perStoreTitle', { name: sel.name })}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.inventory.perStoreSubtitle')}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label={T('section.inventory.storesCarrying')} value={`${sel.storeCount} / ${stores.length}`} sub={T('section.inventory.thisCatalogRow')} />
        <StatCard label={T('section.inventory.onHandSum')} value={`${sel.totalStock.toFixed(1)} ${unitLabel(sel.unit, T)}`} sub={T('section.inventory.allStoresCombined')} />
        <StatCard label={T('section.inventory.parRange')} value={`${Math.min(...sel.rows.map((r) => r.parLevel))}–${Math.max(...sel.rows.map((r) => r.parLevel))}`} sub={unitLabel(sel.unit, T)} />
        <StatCard label={T('section.inventory.costRange')} value={(() => {
          const costs = sel.rows.map((r) => r.costPerUnit || 0).filter((c) => c > 0);
          if (costs.length === 0) return '—';
          const lo = Math.min(...costs), hi = Math.max(...costs);
          return lo === hi ? `$${lo.toFixed(2)}` : `$${lo.toFixed(2)}–${hi.toFixed(2)}`;
        })()} sub={T('section.inventory.perStore')} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>{T('section.inventory.storesTsv')}</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.inventory.rowsCount', { count: sel.rows.length })}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1.4 }}>{T('section.inventory.storeCol')}</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1.2 }}>{T('section.inventory.vendorCol')}</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.inventory.onHandCol')}</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60, textAlign: 'right' }}>{T('section.inventory.parCol')}</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.inventory.costPerUnitCol')}</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60, textAlign: 'right' }}>{T('section.inventory.statusCol')}</Text>
        </View>
        {sel.rows.map((row, i) => {
          const store = stores.find((s) => s.id === row.storeId);
          const vendor = vendors.find((v) => v.id === row.vendorId);
          const isCurrent = row.storeId === currentStore.id;
          return (
            <View key={row.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, backgroundColor: isCurrent ? C.accentBg : 'transparent' }}>
              <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1.4 }} numberOfLines={1}>
                {store?.name || row.storeId.slice(0, 6)}{isCurrent ? T('section.inventory.currentMarker') : ''}
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
  const catalogIngredients = useStore((s) => s.catalogIngredients);
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
    // Spec 096 (Q-D) — union the brand unit pool so a custom name created via
    // the IngredientForm flow (in any ingredient's `unit`/`subUnitUnit`) is
    // also offered here, keeping the three unit-pickers consistent. Additive;
    // the free-text entry below (`handleAdd`) is unchanged. Sourced from the
    // brand-scoped `catalogIngredients` (not the cross-brand `inventory` slice)
    // — see brandUnitPool.ts for the security rationale (AC3).
    const pool = deriveBrandUnitPool({ catalogIngredients, conversions: allConversions });
    for (const name of pool) {
      const n = name.toLowerCase().trim();
      if (n) acc.add(n);
    }
    return Array.from(acc).sort().map((u) => ({ value: u, label: unitLabel(u, T) }));
  }, [allConversions, catalogIngredients, T]);

  const handleAdd = () => {
    const pu = addPurchaseUnit.trim().toLowerCase();
    if (!pu) {
      Toast.show({ type: 'error', text1: T('section.inventory.purchaseUnitRequired') });
      return;
    }
    const factorN = parseFloat(addFactor);
    if (!isFinite(factorN) || factorN <= 0) {
      Toast.show({ type: 'error', text1: T('section.inventory.factorRequired') });
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
        Toast.show({ type: 'error', text1: T('section.inventory.yieldRange') });
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
    Toast.show({ type: 'success', text1: T('section.inventory.conversionAdded'), text2: T('section.inventory.conversionAddedDetail', { pu, factor: factorN, baseUnit: addBaseUnit }) });
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
      Toast.show({ type: 'error', text1: T('section.inventory.purchaseUnitRequired') });
      return;
    }
    if (!isFinite(factorN) || factorN <= 0) {
      Toast.show({ type: 'error', text1: T('section.inventory.factorRequired') });
      return;
    }
    // Same range-check as handleAdd — security-auditor M1.
    const yieldRaw = editValues.yield.trim();
    let yieldN = 100;
    if (yieldRaw !== '') {
      const parsed = parseFloat(yieldRaw);
      if (!isFinite(parsed) || parsed <= 0 || parsed > 100) {
        Toast.show({ type: 'error', text1: T('section.inventory.yieldRange') });
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
    Toast.show({ type: 'success', text1: T('section.inventory.conversionUpdated') });
    setEditingId(null);
  };
  const handleDelete = (conv: IngredientConversion) => {
    confirmAction(
      T('section.inventory.deleteConversionConfirm', { name: conv.purchaseUnit }),
      T('section.inventory.deleteConversionBody'),
      () => {
        deleteIngredientConversion(conv.id);
        Toast.show({ type: 'success', text1: T('section.inventory.conversionDeleted') });
      },
      'Delete',
    );
  };

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.inventory.conversionsTitle', { name: sel.name })}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.inventory.conversionsSubtitle')}
        </Text>
      </View>

      {/* ── Add-row card ─────────────────────────────────────── */}
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <SectionCaption tone="fg3" size={10.5}>{T('section.inventory.addConversion')}</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
            {T('section.inventory.addConversionHint')}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>{T('section.inventory.purchaseUnit')}</Text>
            <TextInput
              value={addPurchaseUnit}
              onChangeText={setAddPurchaseUnit}
              placeholder={T('section.inventory.purchaseUnitPlaceholder')}
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
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>{T('section.inventory.factor')}</Text>
            <NumericInput value={addFactor} onChange={setAddFactor} placeholder="40" width={100} />
          </View>
          <View style={{ flex: 1 }}>
            <SelectField
              label={T('section.inventory.baseUnit')}
              value={addBaseUnit}
              options={baseUnitOptions}
              onChange={setAddBaseUnit}
              monoFont
            />
          </View>
          <TouchableOpacity onPress={handleAdd} style={{ paddingVertical: 7, paddingHorizontal: 12, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
            <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#000' }}>{T('section.inventory.addBtn')}</Text>
          </TouchableOpacity>
        </View>
        {/* Advanced disclosure: net_yield_pct */}
        <TouchableOpacity onPress={() => setShowAdvanced((p) => !p)} activeOpacity={0.7}>
          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg3 }}>
            {showAdvanced ? '▼' : '▶'} {T('section.inventory.advancedHint')}
          </Text>
        </TouchableOpacity>
        {showAdvanced ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>{T('section.inventory.netYieldLabel')}</Text>
            <NumericInput value={addYield} onChange={setAddYield} placeholder="92" width={80} />
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{T('section.inventory.yieldDescription')}</Text>
          </View>
        ) : null}
      </View>

      {/* ── Conversions list ──────────────────────────────── */}
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>{T('section.inventory.conversionsTsv')}</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
            {conversions.length === 1
              ? T('section.inventory.rowsBaseUnitOne', { count: conversions.length, unit: unitLabel(sel.unit, T) })
              : T('section.inventory.rowsBaseUnit', { count: conversions.length, unit: unitLabel(sel.unit, T) })}
          </Text>
        </View>
        {conversions.length === 0 ? (
          <View style={{ padding: 18, gap: 6 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.warn, letterSpacing: 0.4 }}>{T('section.inventory.fixNoConversions')}</Text>
            <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2 }}>
              {T('section.inventory.noConversionsBody', { name: sel.name, unit: unitLabel(sel.unit, T) })}
            </Text>
          </View>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{T('section.inventory.purchaseUCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 40, textAlign: 'center' }}>→</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{T('section.inventory.baseUCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 110, textAlign: 'right' }}>{T('section.inventory.factorCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70, textAlign: 'right' }}>{T('section.inventory.netYieldCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 110, textAlign: 'right' }}>{T('section.inventory.actionsCol')}</Text>
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
                          <Text style={{ fontFamily: mono(700), fontSize: 10, color: '#000' }}>{T('section.inventory.saveBtn')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={cancelEdit} style={{ paddingVertical: 4, paddingHorizontal: 8, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm }}>
                          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>{T('section.inventory.cancelBtn')}</Text>
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
                          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>{T('section.inventory.edit')}</Text>
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

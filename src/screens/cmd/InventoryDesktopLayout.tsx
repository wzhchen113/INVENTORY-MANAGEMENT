import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, FlatList, Platform, useWindowDimensions } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono, Type } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { usePaletteAction } from '../../lib/paletteAction';
import { useStockSeries, useRecipesUsingItem } from '../../lib/cmdSelectors';
import { calculateWeeklyUsageTrend } from '../../utils/usageCalculations';
import { parseFilter, matchesFilter } from '../../utils/filterParser';
import { relativeTime } from '../../utils/relativeTime';
import { formatAuditAction } from '../../utils/formatAuditAction';
import { useT } from '../../hooks/useT';
import { useLocale } from '../../hooks/useLocale';
import { getLocalizedName } from '../../i18n/localizedName';
import { CmdStatusBar } from '../../components/cmd/StatusBar';
import { TabStrip } from '../../components/cmd/TabStrip';
import { StatCard } from '../../components/cmd/StatCard';
import { StatusPill } from '../../components/cmd/StatusPill';
import { StockHistoryChart } from '../../components/cmd/StockHistoryChart';
import { PropertiesJson } from '../../components/cmd/PropertiesJson';
import { ActivityRow } from '../../components/cmd/ActivityRow';
import { SectionCaption } from '../../components/cmd/SectionCaption';
import { StatusDot } from '../../components/cmd/StatusDot';
import { InventoryRow } from '../../components/cmd/InventoryRow';
import { InventoryTable } from '../../components/cmd/InventoryTable';
import { FilterInput } from '../../components/cmd/FilterInput';
import { ComingSoonPanel } from '../../components/cmd/ComingSoonPanel';
import { IngredientFormDrawer } from '../../components/cmd/IngredientFormDrawer';
import { ListSkeleton } from '../../components/cmd/ListSkeleton';
import { confirmAction } from '../../utils/confirmAction';
import { useIsDesktop } from '../../theme/breakpoints';
import { formatCostPerEach, costPerEachLabel, formatStockValue } from './lib/itemMoney';
import VendorsSection from './sections/VendorsSection';
import CategoriesSection from './sections/CategoriesSection';
import InventoryCatalogMode from './sections/InventoryCatalogMode';
import WasteLogSection from './sections/WasteLogSection';
import DashboardSection from './sections/DashboardSection';
import EODCountSection from './sections/EODCountSection';
import InventoryCountSection from './sections/InventoryCountSection';
import ReceivingSection from './sections/ReceivingSection';
import OrderingSection from './sections/OrderingSection';
import RecipesSection from './sections/RecipesSection';
import PrepRecipesSection from './sections/PrepRecipesSection';
import MenuImpactSection from './sections/MenuImpactSection';
import ReconciliationSection from './sections/ReconciliationSection';
import POSImportsSection from './sections/POSImportsSection';
import AuditLogSection from './sections/AuditLogSection';
import ReportsSection from './sections/ReportsSection';
import BrandsSection from './sections/BrandsSection';
import UsersSection from './sections/UsersSection';

// Spec 011 — body-only. The chrome (TitleBar / Sidebar / hamburger drawer
// / footer slots / Spec-008 edit-mode handlers) lives in
// `ResponsiveCmdShell`. This file owns:
//   - the section-dispatch tree
//   - the Inventory section's 3-pane (list + detail), EDIT drawer,
//     items.tsv/catalog.tsv mode switch, and selectedName state
//   - the bottom CmdStatusBar (section-aware "row N / total" + filter)
//   - the palette-action consume() for Inventory-specific selectedName
//     and viewMode (the shell already swapped section before we see it)
//
// `section` and `setSection` are passed in from the shell. Resetting
// `selectedName` when leaving Inventory stays local — it's an Inventory
// concern, not a chrome concern.

const slugify = (s: string) => s.toLowerCase().trim().replace(/\s+/g, '-');
const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

interface Props {
  /** Open the global ⌘K palette (CmdPaletteHost wires this). */
  onPaletteOpen?: () => void;
  /** Active section — owned by the shell post-Spec-011. */
  section: string;
  /** Section setter — used by per-section affordances inside the body
   *  (e.g. tab navigation that swaps sections). */
  setSection: (id: string) => void;
}

// Spec 112 — the on-demand detail pane's fixed width on desktop (≥1100). The
// table gets the rest via flex:1; when the pane is open the table narrows and
// its column-collapse tiers react to the reduced width (via the arithmetic
// `tableWidth` derivation below, NOT an onLayout re-measure — see the AC-7
// post-impl fix note).
const PANE_WIDTH = 620;

// Spec 112 (AC-7 fix) — approximate chrome overhead (sidebar + borders +
// section padding) subtracted from the window width to estimate the table's
// own width on the FIRST frame, before the outer-row onLayout has measured the
// real overhead. ~260px matches the current ResponsiveCmdShell chrome. Only
// used until `chromeW` is set on the first onLayout; after that the measured
// value wins. A slightly-off fallback only affects the tier for one frame.
const FALLBACK_CHROME = 260;

export default function InventoryDesktopLayout({ onPaletteOpen, section, setSection }: Props) {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const isDesktop = useIsDesktop();
  const { width: windowWidth } = useWindowDimensions();

  const inventory = useStore((s) => s.inventory);
  const vendors   = useStore((s) => s.vendors);
  const auditLog  = useStore((s) => s.auditLog);
  const currentUser = useStore((s) => s.currentUser);
  const currentStore = useStore((s) => s.currentStore);
  const getItemStatus = useStore((s) => s.getItemStatus);
  const deleteItem = useStore((s) => s.deleteItem);
  // Spec 055 — first-mount skeleton flag for the Inventory branch
  // specifically. Other sections gate on their own slices internally.
  const storeLoading = useStore((s) => s.storeLoading);

  const [filterText, setFilterText]   = React.useState('');
  const [editDrawerOpen, setEditDrawerOpen] = React.useState(false);
  // Selection is keyed on lowercase name so it survives the items.tsv ↔
  // catalog.tsv mode switch (and store switching, where ids differ but
  // names line up across rows).
  const [selectedName, setSelectedName] = React.useState<string | null>(null);
  const [tabId, setTabId]             = React.useState('detail.tsx');
  const [viewMode, setViewMode]       = React.useState<'per-store' | 'catalog' | 'categories'>('per-store');
  // Spec 112 (AC-7 fix) — we DON'T measure the table's own width with onLayout,
  // because in this react-native-web setup onLayout fires only at mount: it does
  // NOT re-fire when the element reflows via CSS flex (pane sibling mounting) or
  // on window resize, so a measured `listWidth` would be frozen at its mount
  // value and the collapse tiers would never react. Instead we measure the
  // OUTER row container's width ONCE (its width does NOT change when the pane
  // toggles, so mount-time is a valid baseline) to derive the chrome overhead,
  // then compute the table width arithmetically from the reactive `windowWidth`
  // each render (see `tableWidth` in the render body). `windowWidth` from
  // useWindowDimensions IS reliably reactive, so window resizes re-tier via the
  // subtraction and pane open/close re-tiers via the `item` term.
  const [chromeW, setChromeW]         = React.useState<number | null>(null);

  // Reset selection when the shell swaps us out of Inventory.
  React.useEffect(() => {
    if (section !== 'Inventory') setSelectedName(null);
  }, [section]);

  const storeInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );
  const parsed = React.useMemo(() => parseFilter(filterText), [filterText]);
  // Spec 040 P3 — filter consults BOTH English `name` and the
  // current-locale label (via getLocalizedName) for bare-token search.
  // Sort by current-locale label using localeCompare.
  const items = React.useMemo(
    () => storeInventory
      .filter((i) =>
        matchesFilter(
          i,
          parsed,
          getItemStatus,
          getLocalizedName({ name: i.name, i18nNames: i.i18nNames }, locale),
        ),
      )
      .slice()
      .sort((a, b) =>
        getLocalizedName({ name: a.name, i18nNames: a.i18nNames }, locale)
          .localeCompare(
            getLocalizedName({ name: b.name, i18nNames: b.i18nNames }, locale),
            locale,
          ),
      ),
    [storeInventory, parsed, getItemStatus, locale],
  );

  // Spec 112 (AC-3) — NO auto-select on entry. The detail pane is "on demand":
  // it opens only when the operator clicks a row (or a ⌘K "focus item" fires
  // the palette bridge below). `selectedName` initializes to null → the table
  // occupies the full width until a click. The old first-render auto-select of
  // items[0] was removed here.

  // Spec 112 (AC-8b) — a store switch CLOSES the pane, so the table shows the
  // new store's items full-width and the operator isn't left staring at a stale
  // detail for an item that may not exist at the new store. This intentionally
  // overrides the old name-keyed "selection survives store switch" behavior.
  //
  // Scoped to the per-store tab (code-review SF-1): catalog.tsv shares this
  // `selectedName` state but its rows are BRAND-wide — clearing it on a store
  // switch there would make InventoryCatalogMode's own auto-select-first effect
  // silently jump the open detail to a different row (an AC-8 "unchanged"
  // violation). Read via a ref so tab flips don't re-run the effect.
  const viewModeRef = React.useRef(viewMode);
  viewModeRef.current = viewMode;
  React.useEffect(() => {
    if (viewModeRef.current !== 'per-store') return;
    setSelectedName(null);
  }, [currentStore.id]);

  // Spec 112 (AC-5 / AC-14) — Esc closes the pane, web-only. Guarded by
  // `Platform.OS === 'web'` (same shape as confirmAction's web branch): on
  // native the listener is never installed and `window`/`KeyboardEvent` are
  // never touched. Only active while the pane is open.
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!selectedName) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedName(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedName]);

  // ⌘K palette → body bridge. The shell already swapped `section` for us.
  // Here we apply the Inventory-specific bits (selectedName / viewMode)
  // and consume the action — except when an EOD-focus is in flight, in
  // which case EODCountSection consumes after it picks the item up.
  const pendingPaletteAction = usePaletteAction((s) => s.pending);
  React.useEffect(() => {
    if (!pendingPaletteAction) return;
    if (pendingPaletteAction.section === 'Inventory') {
      setViewMode('per-store');
      if (pendingPaletteAction.selectedName) setSelectedName(pendingPaletteAction.selectedName);
    }
    if (!pendingPaletteAction.eodFocusItemId) {
      usePaletteAction.getState().consume();
    }
  }, [pendingPaletteAction]);

  const item = React.useMemo(
    () => storeInventory.find((i) => i.name.toLowerCase() === selectedName),
    [storeInventory, selectedName],
  );
  const status = item ? getItemStatus(item) : 'ok';
  const vendor = item ? vendors.find((v) => v.id === item.vendorId) : undefined;
  const series = useStockSeries(item?.id || '', 14);
  const recipesUsing = useRecipesUsingItem(item?.id || '');

  const inventoryTitle = 'Inventory';

  // Spec 112 (AC-7 fix) — the width available to the desktop table, derived
  // arithmetically (NOT via an onLayout re-measure, which never re-fires on
  // flex reflow / window resize here). `windowWidth` is reactive, so this
  // re-tiers on window resize; the `item ? PANE_WIDTH : 0` term re-tiers on
  // pane open/close. `chromeW` (measured once on the outer row's onLayout) is
  // the sidebar+border+padding overhead; `FALLBACK_CHROME` covers the first
  // frame before it's set. Floor at 320 so the tier stays defined at extremes.
  const tableWidth = Math.max(
    320,
    windowWidth - (chromeW ?? FALLBACK_CHROME) - (item ? PANE_WIDTH : 0),
  );

  // Spec 112 — the on-demand detail pane, shared by the desktop side-pane and
  // the narrow-tier full-width swap. Only invoked when `item` is defined (both
  // call sites are gated by `item ?`), so the non-null assertion is safe. The
  // DetailPane contents (tabs + EDIT/DELETE/+COUNT header) are UNCHANGED — this
  // spec only changes WHEN/WHERE the pane renders and its width.
  const renderDetailPane = () => {
    if (!item) return null;
    return (
      <DetailPane
        item={item}
        vendor={vendor}
        status={status}
        series={series}
        recipesUsing={recipesUsing}
        auditLog={auditLog}
        currentUserId={currentUser?.id}
        tabId={tabId}
        onTabChange={setTabId}
        onEditPress={() => setEditDrawerOpen(true)}
        onDeletePress={() => {
          confirmAction(
            `Delete "${item.name}" from ${currentStore?.name || 'this store'}?`,
            'This removes the per-store inventory row. The brand catalog entry stays — recreate by counting at this store again.',
            () => {
              deleteItem(item.id);
              setSelectedName(null);
              Toast.show({ type: 'success', text1: 'Deleted', text2: item.name });
            },
            'Delete',
          );
        }}
        onCountPress={() => {
          usePaletteAction.getState().request({
            section: 'EODCount',
            selectedName: null,
            eodFocusItemId: item.id,
          });
        }}
      />
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, overflow: 'hidden' }}>
      <View style={{ flex: 1, flexDirection: 'row', overflow: 'hidden', minHeight: 0 }}>

        {section === 'Dashboard' ? (
          <DashboardSection />
        ) : section === 'Vendors' ? (
          <VendorsSection />
        ) : section === 'WasteLog' ? (
          <WasteLogSection />
        ) : section === 'EODCount' ? (
          <EODCountSection />
        ) : section === 'InventoryCount' ? (
          <InventoryCountSection />
        ) : section === 'Receiving' ? (
          <ReceivingSection />
        ) : section === 'Ordering' ? (
          <OrderingSection />
        ) : section === 'Recipes' ? (
          <RecipesSection />
        ) : section === 'PrepRecipes' ? (
          <PrepRecipesSection />
        ) : section === 'MenuImpact' ? (
          <MenuImpactSection />
        ) : section === 'Reconciliation' ? (
          <ReconciliationSection />
        ) : section === 'POSImports' ? (
          <POSImportsSection />
        ) : section === 'AuditLog' ? (
          <AuditLogSection />
        ) : section === 'Reports' ? (
          <ReportsSection />
        ) : section === 'Users' ? (
          <UsersSection />
        ) : section === 'Brands' ? (
          <BrandsSection />
        ) : section !== 'Inventory' ? (
          // Right side collapses to ComingSoon for the remaining 9 tree
          // items per G3 — keep the chrome consistent.
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <View style={{ maxWidth: 380, width: '100%' }}>
              <ComingSoonPanel tabName={slugify(section)} />
            </View>
          </View>
        ) : viewMode === 'categories' ? (
          <View style={{ flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <TabStrip
              tabs={[
                { id: 'per-store',  label: 'items.tsv' },
                { id: 'catalog',    label: 'catalog.tsv' },
                { id: 'categories', label: T('section.inventory.tabs.categories') },
              ]}
              activeId={viewMode}
              onChange={(id) => setViewMode(id as 'per-store' | 'catalog' | 'categories')}
            />
            <View style={{ flex: 1, minHeight: 0 }}>
              <CategoriesSection />
            </View>
          </View>
        ) : viewMode === 'catalog' ? (
          <InventoryCatalogMode
            selectedName={selectedName}
            onSelectName={setSelectedName}
            topSlot={
              <TabStrip
                tabs={[
                  { id: 'per-store',  label: 'items.tsv' },
                  { id: 'catalog',    label: 'catalog.tsv' },
                  { id: 'categories', label: T('section.inventory.tabs.categories') },
                ]}
                activeId={viewMode}
                onChange={(id) => setViewMode(id as 'per-store' | 'catalog' | 'categories')}
              />
            }
          />
        ) : storeLoading && storeInventory.length === 0 ? (
          // Spec 055 first-mount skeleton — Inventory per-store branch.
          // Show on initial load with empty slice; subsequent re-mounts
          // with cached rows skip this branch.
          <ListSkeleton rows={10} />
        ) : (
          // Spec 112 — the items.tsv branch. Full-width operational table on
          // desktop (≥1100); the detail pane opens ON CLICK as a right-side
          // pane (table stays visible, narrows). Below desktop it's a
          // full-width list ↔ full-width detail swap.
          <View style={{ flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <TabStrip
              tabs={[
                { id: 'per-store',  label: 'items.tsv' },
                { id: 'catalog',    label: 'catalog.tsv' },
                { id: 'categories', label: T('section.inventory.tabs.categories') },
              ]}
              activeId={viewMode}
              onChange={(id) => setViewMode(id as 'per-store' | 'catalog' | 'categories')}
            />
            {/* Header + filter — full width above the table/list. */}
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
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <Text style={[Type.h2, { color: C.fg }]}>{inventoryTitle}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                  {storeInventory.length} items
                </Text>
              </View>
              <FilterInput value={filterText} onChangeText={setFilterText} />
            </View>

            {isDesktop ? (
              // Desktop (≥1100) — table (flex:1) + optional right-side pane.
              // onLayout on the OUTER row (whose width does NOT change when the
              // pane toggles) measures the chrome overhead ONCE, from the same
              // frame's windowWidth. The table width itself is derived
              // arithmetically (`tableWidth`) so it re-tiers reactively.
              <View
                style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}
                onLayout={(e) => setChromeW(Math.max(0, windowWidth - e.nativeEvent.layout.width))}
              >
                <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                  <InventoryTable
                    items={items}
                    vendors={vendors}
                    selectedName={selectedName}
                    onSelect={(nameLower) =>
                      setSelectedName((prev) => (prev === nameLower ? null : nameLower))
                    }
                    width={tableWidth}
                    getItemStatus={getItemStatus}
                    displayName={(it) => getLocalizedName({ name: it.name, i18nNames: it.i18nNames }, locale)}
                    labels={{
                      name:        T('section.inventory.nameCol'),
                      onHand:      T('section.inventory.onHandCol'),
                      status:      T('section.inventory.statusCol'),
                      costEach:    T('section.inventory.costPerUnitCol'),
                      stockValue:  T('section.inventory.stockValueCol'),
                      vendor:      T('section.inventory.vendorCol'),
                      category:    T('section.inventory.categoryCol'),
                      lastCounted: T('section.inventory.lastCountedCol'),
                    }}
                  />
                </View>

                {item ? (
                  <View
                    style={{
                      width: PANE_WIDTH,
                      backgroundColor: C.bg,
                      borderLeftWidth: 1,
                      borderLeftColor: C.border,
                      minHeight: 0,
                    }}
                  >
                    {/* Close bar — the ✕ that returns the table to full width. */}
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderBottomWidth: 1,
                        borderBottomColor: C.border,
                      }}
                    >
                      <TouchableOpacity
                        onPress={() => setSelectedName(null)}
                        accessibilityRole="button"
                        accessibilityLabel={T('section.inventory.closeDetailAria')}
                        style={{ paddingVertical: 2, paddingHorizontal: 8 }}
                      >
                        <Text style={{ fontFamily: mono(500), fontSize: 13, color: C.fg2 }}>✕</Text>
                      </TouchableOpacity>
                    </View>
                    {renderDetailPane()}
                  </View>
                ) : null}
              </View>
            ) : (
              // Below desktop (<1100) — full-width list ↔ full-width detail.
              <View style={{ flex: 1, minHeight: 0 }}>
                {item ? (
                  <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0 }}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderBottomWidth: 1,
                        borderBottomColor: C.border,
                      }}
                    >
                      <TouchableOpacity
                        onPress={() => setSelectedName(null)}
                        accessibilityRole="button"
                        accessibilityLabel={T('section.inventory.closeDetailAria')}
                        style={{ paddingVertical: 2, paddingHorizontal: 8 }}
                      >
                        <Text style={{ fontFamily: mono(500), fontSize: 13, color: C.fg2 }}>✕</Text>
                      </TouchableOpacity>
                    </View>
                    {renderDetailPane()}
                  </View>
                ) : (
                  <FlatList
                    style={{ flex: 1, minHeight: 0 }}
                    data={items}
                    keyExtractor={(it) => it.id}
                    renderItem={({ item: it }) => (
                      <InventoryRow
                        item={{
                          id: it.id,
                          // Spec 040 P3 — display the localized label.
                          // Selection key stays English-lowercase so survives
                          // locale switch (the join key on inventory_items
                          // is still the English canonical).
                          name: getLocalizedName({ name: it.name, i18nNames: it.i18nNames }, locale),
                          stock: it.currentStock,
                          par: it.parLevel,
                          unit: it.unit,
                          category: it.category,
                        }}
                        selected={selectedName === it.name.toLowerCase()}
                        selectedBorderWidth={3}
                        onPress={() => setSelectedName(it.name.toLowerCase())}
                      />
                    )}
                  />
                )}
              </View>
            )}
          </View>
        )}
      </View>

      <CmdStatusBar
        height={24}
        left={
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <StatusDot status="ok" />
              <Text style={[Type.statusBar, { color: C.fg3 }]}>synced</Text>
            </View>
            {section === 'Inventory' && item ? (
              <Text style={[Type.statusBar, { color: C.fg3 }]}>
                row {Math.max(1, items.findIndex((i) => i.id === item.id) + 1)} / {storeInventory.length}
              </Text>
            ) : null}
            {section === 'Inventory' && filterText ? (
              <Text style={[Type.statusBar, { color: C.fg3 }]}>filter:{filterText}</Text>
            ) : null}
          </>
        }
        right={
          <>
            <Text style={[Type.statusBar, { color: C.fg3 }]}>UTF-8</Text>
            <Text style={[Type.statusBar, { color: C.fg3 }]}>LF</Text>
            <TouchableOpacity onPress={onPaletteOpen}>
              <Text style={[Type.statusBar, { color: C.accent, fontFamily: mono(600) }]}>⌘K palette</Text>
            </TouchableOpacity>
          </>
        }
      />

      {/* EDIT drawer — mounted at body root so it overlays the chrome */}
      <IngredientFormDrawer
        visible={editDrawerOpen}
        mode="edit"
        item={item}
        onClose={() => setEditDrawerOpen(false)}
      />
    </View>
  );
}

// ── Detail pane content ─────────────────────────────────────────────
const ADMIN_TABS = [
  { id: 'detail.tsx',  label: 'detail.tsx' },
  { id: 'usage.tsx',   label: 'usage.tsx' },
  { id: 'audit.tsx',   label: 'audit.tsx' },
  { id: 'recipes.tsx', label: 'recipes.tsx' },
];

interface DetailProps {
  item: any;
  vendor: any;
  status: any;
  series: Array<number | null>;
  recipesUsing: any[];
  auditLog: any[];
  currentUserId?: string;
  tabId: string;
  onTabChange: (id: string) => void;
  onEditPress?: () => void;
  onDeletePress?: () => void;
  onCountPress?: () => void;
}

function DetailPane({
  item, vendor, status, series, recipesUsing, auditLog, tabId, onTabChange, onEditPress, onDeletePress, onCountPress,
}: DetailProps) {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();

  const itemActivity = React.useMemo(() => {
    return auditLog
      .filter((e: any) => {
        const ref = (e.itemRef || '').toLowerCase();
        return ref === item.name.toLowerCase() || ref === item.id;
      })
      .slice(-3);
  }, [auditLog, item]);

  const daysOfCover = item.averageDailyUsage > 0
    ? `${(item.currentStock / item.averageDailyUsage).toFixed(1)}d`
    : '—';

  // Spec 112 (★ COSTING RULE) — the two money values come from the ONE
  // definition in `./lib/itemMoney` (spec 104 per-each basis). The full-width
  // table cells consume the SAME helpers, so cost/each + stock value can never
  // drift between the header and the table. Re-deriving here is FORBIDDEN.
  const eachLabel = costPerEachLabel(item);
  const stats = [
    { label: 'On hand',            value: `${item.currentStock} ${item.unit}`,   sub: `par ${item.parLevel}` },
    { label: `Cost / ${eachLabel}`, value: formatCostPerEach(item),              sub: 'per-each' },
    { label: 'Stock value',        value: formatStockValue(item),               sub: 'at current cost' },
    { label: 'Days of cover',      value: daysOfCover,                          sub: 'at avg usage' },
  ];

  const props = [
    { key: 'category',         value: `"${item.category}"` },
    { key: 'unit',             value: `"${item.unit}"` },
    { key: 'vendor',           value: `"${vendor?.name || 'unset'}"` },
    { key: 'cost_per_unit',    value: formatCostPerEach(item) },
    { key: 'par_level',        value: String(item.parLevel) },
    { key: 'avg_daily_usage',  value: String(item.averageDailyUsage) },
    { key: 'safety_stock',     value: String(item.safetyStock) },
    { key: 'lead_time_days',   value: String(vendor?.leadTimeDays ?? '—') },
    { key: 'last_counted',     value: `"${relativeTime(item.lastUpdatedAt) || 'never'}"` },
  ];

  const meta = `${item.category} · ${vendor?.name || 'no vendor'} · last counted ${relativeTime(item.lastUpdatedAt) || 'never'} ago`;

  return (
    <>
      <TabStrip
        tabs={ADMIN_TABS}
        activeId={tabId}
        onChange={onTabChange}
        rightSlot={
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              onPress={onEditPress}
              style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}
            >
              <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>EDIT</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onDeletePress}
              accessibilityRole="button"
              accessibilityLabel="Delete this item"
              style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.sm }}
            >
              <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.danger }}>DELETE</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onCountPress}
              accessibilityRole="button"
              accessibilityLabel="Add count for this item"
              style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.accentFg }}>+ COUNT</Text>
            </TouchableOpacity>
          </View>
        }
      />

      {tabId === 'detail.tsx' ? (
        <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
          {/* Hero */}
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(item.id)}</Text>
              <StatusPill status={status} />
            </View>
            <Text style={[Type.display, { color: C.fg }]}>
              {getLocalizedName({ name: item.name, i18nNames: item.i18nNames }, locale)}
            </Text>
            <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>{meta}</Text>
          </View>

          {/* 4-up stat grid */}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {stats.map((s) => (
              <StatCard key={s.label} label={s.label} value={s.value} sub={s.sub} />
            ))}
          </View>

          {/* Stock history (1.4fr) + Properties (1fr) — desktop side-by-side */}
          <View style={{ flexDirection: 'row', gap: 14 }}>
            <View style={{ flex: 1.4, backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <SectionCaption tone="fg3" size={10.5}>stock_history.dat — 14d</SectionCaption>
                <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>par={item.parLevel} · safety={item.safetyStock || 0}</Text>
              </View>
              <StockHistoryChart data={series} par={item.parLevel} width={520} height={140} gridLines={4} />
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                ■ on-hand   — par level
              </Text>
            </View>
            <View style={{ flex: 1, backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <SectionCaption tone="fg3" size={10.5}>properties.json</SectionCaption>
              </View>
              <PropertiesJson entries={props} />
            </View>
          </View>

          {/* Activity log — last 3 events on detail. Full audit lives in audit.tsx tab. */}
          <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <SectionCaption tone="fg3" size={10.5}>activity_log</SectionCaption>
              <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                last {itemActivity.length} · full history in audit.tsx
              </Text>
            </View>
            {itemActivity.length === 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>
                no activity recorded
              </Text>
            ) : (
              itemActivity.map((e: any) => (
                <ActivityRow
                  key={e.id}
                  ago={relativeTime(e.timestamp)}
                  userName={e.userName}
                  action={formatAuditAction(e, T)}
                  target={e.value}
                />
              ))
            )}
          </View>
        </ScrollView>
      ) : tabId === 'usage.tsx' ? (
        <UsageTab item={item} />
      ) : tabId === 'audit.tsx' ? (
        <AuditTab itemName={item.name} />
      ) : tabId === 'recipes.tsx' ? (
        <RecipesTab recipesUsing={recipesUsing} />
      ) : (
        <View style={{ padding: 22 }}>
          <ComingSoonPanel tabName={tabId.replace('.tsx', '')} />
        </View>
      )}
    </>
  );
}

// ── Tab body components ─────────────────────────────────────────────

function UsageTab({ item }: { item: any }) {
  const C = useCmdColors();
  const posImports = useStore((s) => s.posImports);
  const recipes    = useStore((s) => s.recipes);
  const inventory  = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const NUM_WEEKS = 8;
  const weekly = React.useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const all = calculateWeeklyUsageTrend(posImports, recipes, inventory, currentStore.id, today, NUM_WEEKS);
    // calculateWeeklyUsageTrend keys by catalog id (brand-stable). Match
    // primarily by item.catalogId; fall back to item.id for any rows that
    // pre-date the catalog refactor and might still be id-keyed.
    return all.find((u) => u.itemId === item.catalogId) || all.find((u) => u.itemId === item.id);
  }, [posImports, recipes, inventory, currentStore.id, item.catalogId, item.id]);

  const series: Array<number | null> = weekly?.weeklyAmounts ?? [];
  const lastWk = series.length > 0 ? series[series.length - 1] : 0;
  // Spec 024 — coalesce nulls to 0 before reducing/maxing. The `null`
  // entries in `series` render as polyline gaps in StockHistoryChart;
  // for the aggregate stats below, an unrecorded week reads as zero
  // (matches the existing `v ?? 0` pattern at the sum28d reducer).
  const peakWk = series.length > 0 ? Math.max(...series.map((v) => v ?? 0)) : 0;
  const sum28d = series
    .slice(-4)
    .reduce<number>((s, v) => s + (v ?? 0), 0);

  // Build x-axis week labels (W-7 ... W0)
  const xAxis = React.useMemo(
    () => Array.from({ length: NUM_WEEKS }, (_, i) => ({
      atIndex: i,
      label: i === NUM_WEEKS - 1 ? 'this wk' : `-${NUM_WEEKS - 1 - i}w`,
    })).filter((_, i) => i === 0 || i === Math.floor(NUM_WEEKS / 2) || i === NUM_WEEKS - 1),
    [],
  );

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <SectionCaption tone="fg3" size={10.5}>weekly_usage.dat — last {NUM_WEEKS} weeks</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
            unit={item.unit}
          </Text>
        </View>
        {series.length === 0 || series.every((v) => v === 0) ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 18, textAlign: 'center' }}>
            no recipe usage recorded — link this item to a recipe to see usage trends
          </Text>
        ) : (
          <>
            <StockHistoryChart
              data={series}
              par={(weekly?.average ?? 0) * 1.0}
              width={520}
              height={160}
              gridLines={3}
              xAxisLabels={xAxis}
              interactive
              formatTooltip={(v) => `${v} ${item.unit}`}
            />
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              ■ usage / wk   — avg
            </Text>
          </>
        )}
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label="Avg / wk"   value={`${(weekly?.average ?? 0).toFixed(1)}`} sub={item.unit} />
        <StatCard label="Last week"  value={`${(lastWk ?? 0).toFixed(1)}`}          sub={item.unit} />
        <StatCard label="Peak week"  value={`${peakWk.toFixed(1)}`}                  sub={item.unit} />
        <StatCard label="Last 28d"   value={`${sum28d.toFixed(1)}`}                  sub={item.unit} />
      </View>
    </ScrollView>
  );
}

function AuditTab({ itemName }: { itemName: string }) {
  const C = useCmdColors();
  const T = useT();
  const auditLog = useStore((s) => s.auditLog);

  const events = React.useMemo(() => {
    const needle = itemName.toLowerCase();
    return auditLog
      .filter((e: any) => (e.itemRef || '').toLowerCase() === needle)
      .slice()
      .reverse();
  }, [auditLog, itemName]);

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 6 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <SectionCaption tone="fg3" size={10.5}>audit_history.log</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{events.length} events</Text>
        </View>
        {events.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 18, textAlign: 'center' }}>
            no audit events for this item
          </Text>
        ) : (
          events.map((e: any) => (
            <ActivityRow
              key={e.id}
              ago={relativeTime(e.timestamp)}
              userName={e.userName}
              action={formatAuditAction(e, T)}
              target={e.value}
            />
          ))
        )}
      </View>
    </ScrollView>
  );
}

function RecipesTab({ recipesUsing }: { recipesUsing: any[] }) {
  const C = useCmdColors();
  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 6 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <SectionCaption tone="fg3" size={10.5}>recipes.tsv</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
            {recipesUsing.length} {recipesUsing.length === 1 ? 'recipe' : 'recipes'}
          </Text>
        </View>
        {recipesUsing.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 18, textAlign: 'center' }}>
            not in any recipe — add this item as an ingredient in Menu items / BOM or Prep recipes
          </Text>
        ) : (
          recipesUsing.map((r: any, i: number) => (
            <View
              key={`${r.kind}:${r.id}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 8,
                gap: 12,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: C.border,
                borderStyle: 'dashed',
              }}
            >
              <View style={{ width: 44 }}>
                <Text style={{
                  fontFamily: mono(700),
                  fontSize: 9,
                  color: r.kind === 'prep' ? C.info : C.accent,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                }}>
                  {r.kind}
                </Text>
              </View>
              <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                {r.name}
              </Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, width: 130, textAlign: 'right' }}>
                {r.portion}
              </Text>
              {r.soldPerWeek != null ? (
                <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg, width: 70, textAlign: 'right' }}>
                  {r.soldPerWeek}/wk
                </Text>
              ) : (
                <View style={{ width: 70 }} />
              )}
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

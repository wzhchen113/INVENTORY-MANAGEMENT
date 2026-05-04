import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, FlatList } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono, Type } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { usePaletteAction } from '../../lib/paletteAction';
import { useStockSeries, useRecipesUsingItem } from '../../lib/cmdSelectors';
import { calculateWeeklyUsageTrend } from '../../utils/usageCalculations';
import { parseFilter, matchesFilter } from '../../utils/filterParser';
import { relativeTime } from '../../utils/relativeTime';
import { formatAuditAction } from '../../utils/formatAuditAction';
import { TitleBar } from '../../components/cmd/TitleBar';
import { CmdStatusBar } from '../../components/cmd/StatusBar';
import { Sidebar } from '../../components/cmd/Sidebar';
import { TabStrip } from '../../components/cmd/TabStrip';
import { StatCard } from '../../components/cmd/StatCard';
import { StatusPill } from '../../components/cmd/StatusPill';
import { StockHistoryChart } from '../../components/cmd/StockHistoryChart';
import { PropertiesJson } from '../../components/cmd/PropertiesJson';
import { ActivityRow } from '../../components/cmd/ActivityRow';
import { SectionCaption } from '../../components/cmd/SectionCaption';
import { StatusDot } from '../../components/cmd/StatusDot';
import { InventoryRow } from '../../components/cmd/InventoryRow';
import { FilterInput } from '../../components/cmd/FilterInput';
import { ComingSoonPanel } from '../../components/cmd/ComingSoonPanel';
import { TreeItem } from '../../components/cmd/TreeGroup';
import { ThemeToggle } from '../../components/cmd/ThemeToggle';
import { IngredientFormDrawer } from '../../components/cmd/IngredientFormDrawer';
import VendorsSection from './sections/VendorsSection';
import InventoryCatalogMode from './sections/InventoryCatalogMode';
import WasteLogSection from './sections/WasteLogSection';
import DashboardSection from './sections/DashboardSection';
import EODCountSection from './sections/EODCountSection';
import ReceivingSection from './sections/ReceivingSection';
import RestockSection from './sections/RestockSection';
import POsSection from './sections/POsSection';
import RecipesSection from './sections/RecipesSection';
import PrepRecipesSection from './sections/PrepRecipesSection';
import ReconciliationSection from './sections/ReconciliationSection';
import POSImportsSection from './sections/POSImportsSection';
import AuditLogSection from './sections/AuditLogSection';
import ReportsSection from './sections/ReportsSection';

const slugify = (s: string) => s.toLowerCase().trim().replace(/\s+/g, '-');
const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

interface Props {
  /** Open the global ⌘K palette (Phase 7 wires this). */
  onPaletteOpen?: () => void;
}

export default function InventoryDesktopLayout({ onPaletteOpen }: Props) {
  const C = useCmdColors();

  const inventory = useStore((s) => s.inventory);
  const vendors   = useStore((s) => s.vendors);
  const auditLog  = useStore((s) => s.auditLog);
  const currentUser = useStore((s) => s.currentUser);
  const logout = useStore((s) => s.logout);
  const currentStore = useStore((s) => s.currentStore);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const stores = useStore((s) => s.stores);
  const getItemStatus = useStore((s) => s.getItemStatus);

  const [section, setSection]         = React.useState('Inventory');
  const [filterText, setFilterText]   = React.useState('');
  const [editDrawerOpen, setEditDrawerOpen] = React.useState(false);
  // Selection is keyed on lowercase name so it survives the items.tsv ↔
  // catalog.tsv mode switch (and store switching, where ids differ but
  // names line up across rows).
  const [selectedName, setSelectedName] = React.useState<string | null>(null);
  const [tabId, setTabId]             = React.useState('detail.tsx');
  const [viewMode, setViewMode]       = React.useState<'per-store' | 'catalog'>('per-store');

  const storeInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );
  const parsed = React.useMemo(() => parseFilter(filterText), [filterText]);
  const items = React.useMemo(
    () => storeInventory.filter((i) => matchesFilter(i, parsed, getItemStatus)),
    [storeInventory, parsed, getItemStatus],
  );

  // Auto-select on first render only. After that the user owns the selection
  // — filter narrows and store switches no longer kick them off, which keeps
  // the items.tsv ↔ catalog.tsv toggle non-destructive.
  React.useEffect(() => {
    if (viewMode !== 'per-store') return;
    if (selectedName) return;
    setSelectedName(items[0]?.name.toLowerCase() || null);
  }, [items, selectedName, viewMode]);

  // ⌘K palette → desktop selection bridge. Palette writes a pending action
  // (paletteAction.request); we apply it once and consume.
  //
  // Special case: when `eodFocusItemId` is set, the layout switches the
  // section but does NOT consume — EODCountSection consumes after it picks
  // the item up. Otherwise the action would be cleared before EOD mounts.
  const pendingPaletteAction = usePaletteAction((s) => s.pending);
  React.useEffect(() => {
    if (!pendingPaletteAction) return;
    setSection(pendingPaletteAction.section);
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

  const todayStr = new Date().toISOString().slice(0, 10);
  const submittedToday = new Set(
    eodSubmissions.filter((s) => s.date === todayStr).map((s) => s.storeId),
  ).size;

  // Admin-only app — store users have a separate app + API.
  const groups: { label: string; items: TreeItem[] }[] = [
    {
      label: 'Operations',
      items: [
        { id: 'Inventory',       label: 'Inventory',        kbd: '⌘I' },
        { id: 'Dashboard',       label: 'Dashboard' },
        { id: 'EODCount',        label: 'EOD count' },
        { id: 'WasteLog',        label: 'Waste log' },
        { id: 'Receiving',       label: 'Receiving' },
      ],
    },
    {
      label: 'Planning',
      items: [
        { id: 'PurchaseOrders',  label: 'Purchase orders' },
        { id: 'Vendors',         label: 'Vendors' },
        { id: 'Recipes',         label: 'Menu items / BOM' },
        { id: 'PrepRecipes',     label: 'Prep recipes' },
        { id: 'Restock',         label: 'Restock' },
      ],
    },
    {
      label: 'Insights',
      items: [
        { id: 'Reconciliation',  label: 'Reconciliation' },
        { id: 'POSImports',      label: 'POS imports' },
        { id: 'AuditLog',        label: 'Audit log' },
        { id: 'Reports',         label: 'Reports' },
      ],
    },
  ];

  const inventoryTitle = 'Inventory';

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, overflow: 'hidden' }}>
      <TitleBar
        storeName={currentStore?.name || 'store'}
        section={section}
        itemSlug={section === 'Inventory' && item ? item.name : undefined}
      />
      <View style={{ flex: 1, flexDirection: 'row', overflow: 'hidden', minHeight: 0 }}>
        <Sidebar
          groups={groups}
          selectedId={section}
          onSelect={(id) => {
            setSection(id);
            // Reset selection when leaving Inventory
            if (id !== 'Inventory') setSelectedName(null);
          }}
          onPaletteOpen={onPaletteOpen}
          footerLeft={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[Type.statusBar, { color: C.fg3 }]}>
                ● {currentUser?.name || 'guest'}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
                    ? window.confirm('Sign out?')
                    : true;
                  if (ok) logout();
                }}
                accessibilityRole="button"
                accessibilityLabel="Sign out"
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  borderRadius: CmdRadius.xs,
                  borderWidth: 1,
                  borderColor: C.border,
                }}
              >
                <Text style={[Type.statusBar, { color: C.fg3 }]}>sign out</Text>
              </TouchableOpacity>
            </View>
          }
          footerRight={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ThemeToggle />
              <Text style={[Type.statusBar, { color: C.fg3 }]}>
                EOD {submittedToday}/{stores.length}
              </Text>
            </View>
          }
        />

        {section === 'Dashboard' ? (
          <DashboardSection />
        ) : section === 'Vendors' ? (
          <VendorsSection />
        ) : section === 'WasteLog' ? (
          <WasteLogSection />
        ) : section === 'EODCount' ? (
          <EODCountSection />
        ) : section === 'Receiving' ? (
          <ReceivingSection />
        ) : section === 'Restock' ? (
          <RestockSection />
        ) : section === 'PurchaseOrders' ? (
          <POsSection />
        ) : section === 'Recipes' ? (
          <RecipesSection />
        ) : section === 'PrepRecipes' ? (
          <PrepRecipesSection />
        ) : section === 'Reconciliation' ? (
          <ReconciliationSection />
        ) : section === 'POSImports' ? (
          <POSImportsSection />
        ) : section === 'AuditLog' ? (
          <AuditLogSection />
        ) : section === 'Reports' ? (
          <ReportsSection />
        ) : section !== 'Inventory' ? (
          // Right side collapses to ComingSoon for the remaining 9 tree
          // items per G3 — keep the chrome consistent.
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <View style={{ maxWidth: 380, width: '100%' }}>
              <ComingSoonPanel tabName={slugify(section)} />
            </View>
          </View>
        ) : viewMode === 'catalog' ? (
          <InventoryCatalogMode
            selectedName={selectedName}
            onSelectName={setSelectedName}
            topSlot={
              <TabStrip
                tabs={[
                  { id: 'per-store', label: 'items.tsv' },
                  { id: 'catalog',   label: 'catalog.tsv' },
                ]}
                activeId={viewMode}
                onChange={(id) => setViewMode(id as 'per-store' | 'catalog')}
              />
            }
          />
        ) : (
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
              <TabStrip
                tabs={[
                  { id: 'per-store', label: 'items.tsv' },
                  { id: 'catalog',   label: 'catalog.tsv' },
                ]}
                activeId={viewMode}
                onChange={(id) => setViewMode(id as 'per-store' | 'catalog')}
              />
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
              <FlatList
                style={{ flex: 1, minHeight: 0 }}
                data={items}
                keyExtractor={(it) => it.id}
                renderItem={({ item: it }) => (
                  <InventoryRow
                    item={{
                      id: it.id,
                      name: it.name,
                      stock: it.currentStock,
                      par: it.parLevel,
                      unit: it.unit,
                      category: it.category,
                    }}
                    selected={selectedName === it.name.toLowerCase()}
                    selectedBorderWidth={2}
                    onPress={() => setSelectedName(it.name.toLowerCase())}
                  />
                )}
              />
            </View>

            {/* Detail pane */}
            <View style={{ flex: 1, backgroundColor: C.bg }}>
              {!item ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                    {selectedName ? `not at ${currentStore?.name || 'this store'}` : 'select an item'}
                  </Text>
                </View>
              ) : (
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
                  onCountPress={() => {
                    usePaletteAction.getState().request({
                      section: 'EODCount',
                      selectedName: null,
                      eodFocusItemId: item.id,
                    });
                  }}
                />
              )}
            </View>
          </>
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

      {/* EDIT drawer — mounted at layout root so it overlays the chrome */}
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
  onCountPress?: () => void;
}

function DetailPane({
  item, vendor, status, series, recipesUsing, auditLog, tabId, onTabChange, onEditPress, onCountPress,
}: DetailProps) {
  const C = useCmdColors();

  const itemActivity = React.useMemo(() => {
    return auditLog
      .filter((e: any) => {
        const ref = (e.itemRef || '').toLowerCase();
        return ref === item.name.toLowerCase() || ref === item.id;
      })
      .slice(-3);
  }, [auditLog, item]);

  const inventoryValue = item.currentStock * (item.costPerUnit || 0);
  const daysOfCover = item.averageDailyUsage > 0
    ? `${(item.currentStock / item.averageDailyUsage).toFixed(1)}d`
    : '—';

  const stats = [
    { label: 'On hand',       value: `${item.currentStock} ${item.unit}`,                                sub: `par ${item.parLevel}` },
    { label: 'Cost / unit',   value: item.costPerUnit ? `$${item.costPerUnit.toFixed(2)}` : '—',        sub: 'avg' },
    { label: 'Stock value',   value: `$${inventoryValue.toFixed(0)}`,                                    sub: 'at current cost' },
    { label: 'Days of cover', value: daysOfCover,                                                        sub: 'at avg usage' },
  ];

  const props = [
    { key: 'category',         value: `"${item.category}"` },
    { key: 'unit',             value: `"${item.unit}"` },
    { key: 'vendor',           value: `"${vendor?.name || 'unset'}"` },
    { key: 'cost_per_unit',    value: item.costPerUnit ? `$${item.costPerUnit.toFixed(2)}` : '—' },
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
              onPress={onCountPress}
              accessibilityRole="button"
              accessibilityLabel="Add count for this item"
              style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>+ COUNT</Text>
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
            <Text style={[Type.display, { color: C.fg }]}>{item.name}</Text>
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
                  action={formatAuditAction(e)}
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
    return all.find((u) => u.itemId === item.id);
  }, [posImports, recipes, inventory, currentStore.id, item.id]);

  const series: Array<number | null> = weekly?.weeklyAmounts ?? [];
  const lastWk = series.length > 0 ? series[series.length - 1] : 0;
  const peakWk = series.length > 0 ? Math.max(...series) : 0;
  const sum28d = series.slice(-4).reduce((s, v) => s + (v ?? 0), 0);

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
              action={formatAuditAction(e)}
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

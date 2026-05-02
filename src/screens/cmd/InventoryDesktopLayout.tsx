import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, FlatList } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono, Type } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useRole } from '../../hooks/useRole';
import { useStockSeries, useRecipesUsingItem } from '../../lib/cmdSelectors';
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
import VendorsSection from './sections/VendorsSection';
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
  const role = useRole();

  const inventory = useStore((s) => s.inventory);
  const vendors   = useStore((s) => s.vendors);
  const auditLog  = useStore((s) => s.auditLog);
  const currentUser = useStore((s) => s.currentUser);
  const currentStore = useStore((s) => s.currentStore);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const stores = useStore((s) => s.stores);
  const getItemStatus = useStore((s) => s.getItemStatus);

  const [section, setSection]       = React.useState('Inventory');
  const [filterText, setFilterText] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId]           = React.useState('detail.tsx');

  const storeInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );
  const parsed = React.useMemo(() => parseFilter(filterText), [filterText]);
  const items = React.useMemo(
    () => storeInventory.filter((i) => matchesFilter(i, parsed, getItemStatus)),
    [storeInventory, parsed, getItemStatus],
  );

  // Auto-select first item on first render or after filter narrows the list.
  React.useEffect(() => {
    if (selectedId && items.find((i) => i.id === selectedId)) return;
    setSelectedId(items[0]?.id || null);
  }, [items, selectedId]);

  const item = React.useMemo(
    () => storeInventory.find((i) => i.id === selectedId),
    [storeInventory, selectedId],
  );
  const status = item ? getItemStatus(item) : 'ok';
  const vendor = item ? vendors.find((v) => v.id === item.vendorId) : undefined;
  const series = useStockSeries(item?.id || '', 14);
  const recipesUsing = useRecipesUsingItem(item?.id || '');

  const todayStr = new Date().toISOString().slice(0, 10);
  const submittedToday = new Set(
    eodSubmissions.filter((s) => s.date === todayStr).map((s) => s.storeId),
  ).size;

  const adminGroups: { label: string; items: TreeItem[] }[] = [
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
  const staffGroups: { label: string; items: TreeItem[] }[] = [
    {
      label: 'Tasks',
      items: [
        { id: 'Inventory', label: 'Count queue', kbd: '⌘I' },
        { id: 'EODCount',  label: 'EOD count' },
        { id: 'WasteLog',  label: 'Waste log' },
      ],
    },
    {
      label: 'Reference',
      items: [
        { id: 'Recipes',     label: 'Menu items / BOM' },
        { id: 'PrepRecipes', label: 'Prep recipes' },
      ],
    },
    {
      label: 'Admin-only',
      items: [
        { id: 'Vendors',         label: 'Vendors',          restricted: true },
        { id: 'Reports',         label: 'Reports',          restricted: true },
        { id: 'AuditLog',        label: 'Audit log',        restricted: true },
        { id: 'Reconciliation',  label: 'Reconciliation',   restricted: true },
      ],
    },
  ];
  const groups = role === 'admin' ? adminGroups : staffGroups;

  const inventoryTitle = role === 'admin' ? 'Inventory' : 'Count queue';

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
            if (id !== 'Inventory') setSelectedId(null);
          }}
          onPaletteOpen={onPaletteOpen}
          footerLeft={
            <Text style={[Type.statusBar, { color: C.fg3 }]}>
              ● {currentUser?.email || 'guest'}
            </Text>
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
                    selected={selectedId === it.id}
                    selectedBorderWidth={2}
                    onPress={() => setSelectedId(it.id)}
                  />
                )}
              />
            </View>

            {/* Detail pane */}
            <View style={{ flex: 1, backgroundColor: C.bg }}>
              {!item ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                    select an item
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
                  role={role}
                  tabId={tabId}
                  onTabChange={setTabId}
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
const STAFF_TABS = [
  { id: 'detail.tsx',  label: 'detail.tsx' },
  { id: 'count.tsx',   label: 'count.tsx' },
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
  role: 'admin' | 'staff';
  tabId: string;
  onTabChange: (id: string) => void;
}

function DetailPane({
  item, vendor, status, series, recipesUsing, auditLog, currentUserId, role, tabId, onTabChange,
}: DetailProps) {
  const C = useCmdColors();

  const tabs = role === 'admin' ? ADMIN_TABS : STAFF_TABS;
  const itemActivity = React.useMemo(() => {
    const filtered = auditLog.filter((e: any) => {
      const ref = (e.itemRef || '').toLowerCase();
      return ref === item.name.toLowerCase() || ref === item.id;
    });
    if (role === 'staff' && currentUserId) {
      return filtered.filter((e: any) => e.userId === currentUserId).slice(-3);
    }
    return filtered.slice(-3);
  }, [auditLog, item, role, currentUserId]);

  const inventoryValue = item.currentStock * (item.costPerUnit || 0);
  const daysOfCover = item.averageDailyUsage > 0
    ? `${(item.currentStock / item.averageDailyUsage).toFixed(1)}d`
    : '—';

  const adminStats = [
    { label: 'On hand',       value: `${item.currentStock} ${item.unit}`,                                sub: `par ${item.parLevel}` },
    { label: 'Cost / unit',   value: item.costPerUnit ? `$${item.costPerUnit.toFixed(2)}` : '—',        sub: 'avg' },
    { label: 'Stock value',   value: `$${inventoryValue.toFixed(0)}`,                                    sub: 'at current cost' },
    { label: 'Days of cover', value: daysOfCover,                                                        sub: 'at avg usage' },
  ];
  const staffStats = [
    { label: 'On hand',       value: `${item.currentStock} ${item.unit}`,           sub: `par ${item.parLevel}` },
    { label: 'Last count',    value: `${item.eodRemaining ?? item.currentStock} ${item.unit}`, sub: relativeTime(item.lastUpdatedAt) || '—' },
    { label: 'Variance',      value: item.eodRemaining != null
        ? `${(item.currentStock - item.eodRemaining > 0 ? '+' : '')}${(item.currentStock - item.eodRemaining).toFixed(1)} ${item.unit}`
        : '—', sub: 'vs expected' },
    { label: 'Days of cover', value: daysOfCover, sub: 'at avg usage' },
  ];
  const stats = role === 'admin' ? adminStats : staffStats;

  const adminProps = [
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
  const staffProps = [
    { key: 'category',     value: `"${item.category}"` },
    { key: 'unit',         value: `"${item.unit}"` },
    { key: 'par_level',    value: String(item.parLevel) },
    { key: 'storage',      value: '—' },
    { key: 'count_freq',   value: '—' },
    { key: 'allergens',    value: '—' },
    { key: 'cost_per_unit', value: '— admin only' },
  ];
  const props = role === 'admin' ? adminProps : staffProps;

  const meta = role === 'admin'
    ? `${item.category} · ${vendor?.name || 'no vendor'} · last counted ${relativeTime(item.lastUpdatedAt) || 'never'} ago`
    : `${item.category} · walk-in · ${relativeTime(item.lastUpdatedAt) || 'never'} ago`;

  return (
    <>
      <TabStrip
        tabs={tabs}
        activeId={tabId}
        onChange={onTabChange}
        rightSlot={
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {role === 'admin' ? (
              <View
                style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}
              >
                <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>EDIT</Text>
              </View>
            ) : null}
            <View style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>+ COUNT</Text>
            </View>
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
                {role === 'staff' ? (
                  <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>2 fields hidden</Text>
                ) : null}
              </View>
              <PropertiesJson entries={props} />
            </View>
          </View>

          {/* Recipes + Activity row */}
          <View style={{ flexDirection: 'row', gap: 14 }}>
            {role === 'admin' ? (
              <View style={{ flex: 1, backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 6 }}>
                <SectionCaption tone="fg3" size={10.5}>used in {recipesUsing.length} recipes</SectionCaption>
                {recipesUsing.length === 0 ? (
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>
                    not in any recipe
                  </Text>
                ) : (
                  recipesUsing.map((r) => (
                    <View key={`${r.kind}:${r.id}`} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4 }}>
                      <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>{r.name}</Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, marginRight: 8 }}>{r.portion}</Text>
                      {r.soldPerWeek != null ? (
                        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg, width: 60, textAlign: 'right' }}>{r.soldPerWeek}/wk</Text>
                      ) : null}
                    </View>
                  ))
                )}
              </View>
            ) : null}
            <View style={{ flex: 1, backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 6 }}>
              <SectionCaption tone="fg3" size={10.5}>
                {role === 'admin' ? 'activity_log' : 'your_activity'}
              </SectionCaption>
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
          </View>
        </ScrollView>
      ) : (
        <View style={{ padding: 22 }}>
          <ComingSoonPanel tabName={tabId.replace('.tsx', '')} />
        </View>
      )}
    </>
  );
}

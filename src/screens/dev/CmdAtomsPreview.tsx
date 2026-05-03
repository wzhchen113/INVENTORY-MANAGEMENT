import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { Type, sans, mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { StatusDot } from '../../components/cmd/StatusDot';
import { StatusPill } from '../../components/cmd/StatusPill';
import { KbdHint } from '../../components/cmd/KbdHint';
import { RoleBadge } from '../../components/cmd/RoleBadge';
import { ParBar } from '../../components/cmd/ParBar';
import { AccentTile } from '../../components/cmd/AccentTile';
import { Avatar } from '../../components/cmd/Avatar';
import { SectionCaption } from '../../components/cmd/SectionCaption';
import { StatCard } from '../../components/cmd/StatCard';
import { FilterInput } from '../../components/cmd/FilterInput';
import { FilterChip } from '../../components/cmd/FilterChip';
import { InventoryRow } from '../../components/cmd/InventoryRow';
import { PropertiesJson } from '../../components/cmd/PropertiesJson';
import { ActivityRow } from '../../components/cmd/ActivityRow';
import { TreeGroup } from '../../components/cmd/TreeGroup';
import { StockHistoryChart } from '../../components/cmd/StockHistoryChart';
import { TabStrip } from '../../components/cmd/TabStrip';
import { TitleBar } from '../../components/cmd/TitleBar';
import { CmdStatusBar } from '../../components/cmd/StatusBar';
import { Sidebar } from '../../components/cmd/Sidebar';
import { MobileNavDrawer } from '../../components/cmd/MobileNavDrawer';
import { CommandPalette } from '../../components/cmd/CommandPalette';
import { StatusDot as DotForBar } from '../../components/cmd/StatusDot';
import { PaletteEntry } from '../../lib/cmdSelectors';

// Phase 2 dev sandbox. Mounted from App.tsx when EXPO_PUBLIC_NEW_UI=true && __DEV__.
// Phase 5 will move this into CmdNavigator as a hidden dev route.
export default function CmdAtomsPreview() {
  const C = useCmdColors();
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const [filterText, setFilterText] = React.useState('status:low cat:produce');
  const [chipSel, setChipSel] = React.useState('all');
  const [rowSel, setRowSel] = React.useState('i03');
  const [treeSel, setTreeSel] = React.useState('inventory');
  const [tabId, setTabId] = React.useState('detail.tsx');
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [drawerQuery, setDrawerQuery] = React.useState('');

  // Mock 14-day stock series for Atlantic salmon (matches design's mock).
  const salmonSeries: Array<number | null> = [11, 10, 9, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4.5, 4.2];

  const sampleTreeGroups = [
    {
      label: 'Operations',
      items: [
        { id: 'dashboard', label: 'Dashboard' },
        { id: 'inventory', label: 'Inventory', kbd: '⌘I' },
        { id: 'eod',       label: 'EOD count' },
        { id: 'waste',     label: 'Waste log' },
      ],
    },
    {
      label: 'Planning',
      items: [
        { id: 'pos',       label: 'Purchase orders' },
        { id: 'vendors',   label: 'Vendors' },
        { id: 'recipes',   label: 'Recipes' },
      ],
    },
  ];

  const samplePaletteIndex: PaletteEntry[] = [
    { type: 'inventory', label: 'Atlantic salmon',  id: 'i03', route: { name: 'ItemDetail', params: { itemId: 'i03' } }, scope: 'inventory' },
    { type: 'inventory', label: 'Beef tenderloin',  id: 'i01', route: { name: 'ItemDetail', params: { itemId: 'i01' } }, scope: 'inventory' },
    { type: 'inventory', label: 'Heirloom tomato',  id: 'i04', route: { name: 'ItemDetail', params: { itemId: 'i04' } }, scope: 'inventory' },
    { type: 'recipe',    label: 'Crab cake sandwich', id: 'r1', route: { name: 'Recipes', params: { recipeId: 'r1' } }, scope: 'recipes' },
    { type: 'vendor',    label: 'Samuels',           id: 'v1', route: { name: 'Vendors', params: { vendorId: 'v1' } }, scope: 'vendors' },
    { type: 'screen',    label: 'EOD count',         id: 'screen:EODCount', route: { name: 'EODCount' }, scope: 'screens' },
    { type: 'screen',    label: 'Waste log',         id: 'screen:WasteLog', route: { name: 'WasteLog' }, scope: 'screens' },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Top bar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          height: 36,
          backgroundColor: C.panel,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
        }}
      >
        <SectionCaption size={10.5}>CMD atoms — phase 2 preview</SectionCaption>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={toggleDarkMode}
          testID="cmd-preview-toggle-theme"
          style={{
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            borderColor: C.borderStrong,
            backgroundColor: C.panel2,
          }}
        >
          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>
            {darkMode ? '☼ light' : '☾ dark'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 18, gap: 22 }}>
        <Group title="StatusDot">
          <Row>
            <Labeled label="ok"><StatusDot status="ok" /></Labeled>
            <Labeled label="low"><StatusDot status="low" /></Labeled>
            <Labeled label="out"><StatusDot status="out" /></Labeled>
            <Labeled label="info"><StatusDot status="info" /></Labeled>
            <Labeled label="size 7"><StatusDot status="ok" size={7} /></Labeled>
          </Row>
        </Group>

        <Group title="StatusPill">
          <Row>
            <StatusPill status="ok" />
            <StatusPill status="low" />
            <StatusPill status="out" />
            <StatusPill status="info" />
            <StatusPill status="low" label="LOW · 4.2/12" />
          </Row>
        </Group>

        <Group title="KbdHint">
          <Row>
            <KbdHint>⌘K</KbdHint>
            <KbdHint>⌘P</KbdHint>
            <KbdHint>esc</KbdHint>
            <KbdHint>⌘I</KbdHint>
            <KbdHint size="sm">⏎</KbdHint>
          </Row>
        </Group>

        <Group title="RoleBadge">
          <Row>
            <RoleBadge />
          </Row>
        </Group>

        <Group title="ParBar">
          <View style={{ gap: 8, width: 220 }}>
            <Labeled label="20 / 18 (ok)"><ParBar stock={20} par={18} /></Labeled>
            <Labeled label="12.4 / 18 (low)"><ParBar stock={12.4} par={18} /></Labeled>
            <Labeled label="4.2 / 12 (low)"><ParBar stock={4.2} par={12} /></Labeled>
            <Labeled label="0 / 8 (out)"><ParBar stock={0} par={8} /></Labeled>
            <Labeled label="par=0 (no par)"><ParBar stock={5} par={0} /></Labeled>
          </View>
        </Group>

        <Group title="AccentTile">
          <Row>
            <Labeled label="22"><AccentTile glyph="i" size={22} /></Labeled>
            <Labeled label="26"><AccentTile glyph="i" size={26} /></Labeled>
            <Labeled label="32"><AccentTile glyph="i" size={32} /></Labeled>
          </Row>
        </Group>

        <Group title="Avatar">
          <Row>
            <Labeled label="MG"><Avatar initials="MG" /></Labeled>
            <Labeled label="JT"><Avatar initials="JT" /></Labeled>
            <Labeled label="AR"><Avatar initials="AR" /></Labeled>
            <Labeled label="size 24"><Avatar initials="AD" size={24} /></Labeled>
          </Row>
        </Group>

        <Group title="SectionCaption">
          <View style={{ gap: 6 }}>
            <SectionCaption tone="fg3">stock_history.dat — 14d</SectionCaption>
            <SectionCaption tone="fg3" size={9.5}>operations</SectionCaption>
            <SectionCaption tone="fg2" size={10.5}>used in 4 recipes</SectionCaption>
          </View>
        </Group>

        <Group title="StatCard">
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <StatCard label="On hand" value="4.2 lb" sub="par 12" />
            <StatCard label="Cost / unit" value="$14.20" sub="avg 17d" />
            <StatCard label="Stock value" value="$60" sub="at current cost" />
            <StatCard label="Days of cover" value="1.8d" sub="at avg usage" />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <StatCard compact label="On hand" value="4.2 lb" sub="par 12" />
            <StatCard compact label="Last count" value="4.2 lb" sub="by you · 1h" />
          </View>
        </Group>

        <Group title="FilterInput">
          <FilterInput value={filterText} onChangeText={setFilterText} />
          <FilterInput value="" onChangeText={() => {}} placeholder="zone:line assigned:maria.g" />
        </Group>

        <Group title="FilterChip">
          <Row>
            {[
              { id: 'all',     label: 'all',     count: 12 },
              { id: 'ok',      label: 'ok',      count: 7  },
              { id: 'low',     label: 'low',     count: 3  },
              { id: 'out',     label: 'out',     count: 2  },
              { id: 'protein', label: 'protein', count: 3  },
              { id: 'produce', label: 'produce', count: 4  },
            ].map((c) => (
              <FilterChip
                key={c.id}
                label={c.label}
                count={c.count}
                selected={chipSel === c.id}
                onPress={() => setChipSel(c.id)}
              />
            ))}
          </Row>
        </Group>

        <Group title="InventoryRow">
          {[
            { id: 'i01', name: 'Beef tenderloin',  stock: 12.4, par: 18, unit: 'lb', category: 'Protein' },
            { id: 'i03', name: 'Atlantic salmon',  stock: 4.2,  par: 12, unit: 'lb', category: 'Seafood' },
            { id: 'i05', name: 'Romaine hearts',   stock: 0,    par: 24, unit: 'ea', category: 'Produce' },
            { id: 'i02', name: 'Chicken thigh',    stock: 38,   par: 30, unit: 'lb', category: 'Protein' },
          ].map((it) => (
            <InventoryRow
              key={it.id}
              item={it}
              selected={rowSel === it.id}
              onPress={() => setRowSel(it.id)}
            />
          ))}
        </Group>

        <Group title="PropertiesJson">
          <PropertiesJson
            entries={[
              { key: 'category',         value: '"Seafood"' },
              { key: 'unit',             value: '"lb"' },
              { key: 'vendor',           value: '"Samuels"' },
              { key: 'cost_per_unit',    value: '$14.20' },
              { key: 'par_level',        value: '12' },
              { key: 'avg_daily_usage',  value: '2.4' },
              { key: 'safety_stock',     value: '4.0' },
              { key: 'lead_time_days',   value: '2' },
              { key: 'last_counted',     value: '"1h ago"' },
            ]}
          />
        </Group>

        <Group title="ActivityRow">
          <ActivityRow ago="12m" userName="Maria Garcia"   action="submitted EOD count" target="24 items" />
          <ActivityRow ago="38m" userName="James Thompson" action="logged waste"        target="1.2 lb salmon" />
          <ActivityRow ago="1h"  userName="Admin"          action="received PO"         target="Sysco #4821" />
          <ActivityRow ago="2h"  userName="Ana Rivera"     action="imported POS"        target="toast_2026-04-30" />
        </Group>

        <Group title="TreeGroup">
          <TreeGroup
            label="Operations"
            items={[
              { id: 'dashboard', label: 'Dashboard', selected: treeSel === 'dashboard', onPress: () => setTreeSel('dashboard') },
              { id: 'inventory', label: 'Inventory', kbd: '⌘I', selected: treeSel === 'inventory', onPress: () => setTreeSel('inventory') },
              { id: 'eod',       label: 'EOD count', selected: treeSel === 'eod', onPress: () => setTreeSel('eod') },
              { id: 'waste',     label: 'Waste log', selected: treeSel === 'waste', onPress: () => setTreeSel('waste') },
            ]}
          />
          <TreeGroup
            label="Admin-only"
            items={[
              { id: 'vendors',   label: 'Vendors',        restricted: true },
              { id: 'audit',     label: 'Audit log',      restricted: true },
              { id: 'reports',   label: 'Reports',        restricted: true },
            ]}
          />
        </Group>

        <Group title="StockHistoryChart">
          <View style={{ alignItems: 'flex-start', gap: 14 }}>
            <View>
              <SectionCaption tone="fg3" size={10.5}>stock_history.dat — 14d</SectionCaption>
              <View style={{ marginTop: 6 }}>
                <StockHistoryChart data={salmonSeries} par={12} width={520} height={140} />
              </View>
            </View>
            <View>
              <SectionCaption tone="fg3" size={10.5}>mobile · 7d</SectionCaption>
              <View style={{ marginTop: 6 }}>
                <StockHistoryChart data={salmonSeries.slice(7)} par={12} width={340} height={100} gridLines={3} />
              </View>
            </View>
            <View>
              <SectionCaption tone="fg3" size={10.5}>sparse data (2 of 14 days)</SectionCaption>
              <View style={{ marginTop: 6 }}>
                <StockHistoryChart
                  data={[null, null, null, null, null, null, null, null, null, null, null, null, 6.5, 4.2]}
                  par={12}
                  width={340}
                  height={100}
                  gridLines={3}
                />
              </View>
            </View>
          </View>
        </Group>

        <Group title="TabStrip">
          <View style={{ borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
            <TabStrip
              tabs={[
                { id: 'detail.tsx',  label: 'detail.tsx' },
                { id: 'usage.tsx',   label: 'usage.tsx' },
                { id: 'audit.tsx',   label: 'audit.tsx' },
                { id: 'recipes.tsx', label: 'recipes.tsx' },
              ]}
              activeId={tabId}
              onChange={setTabId}
              rightSlot={
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View
                    style={{
                      paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1,
                      borderColor: C.borderStrong, borderRadius: CmdRadius.sm,
                    }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>EDIT</Text>
                  </View>
                  <View
                    style={{
                      paddingVertical: 4, paddingHorizontal: 10,
                      backgroundColor: C.accent, borderRadius: CmdRadius.sm,
                    }}
                  >
                    <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>+ COUNT</Text>
                  </View>
                </View>
              }
            />
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 14 }}>
              active tab: {tabId}
            </Text>
          </View>
          <SectionCaption tone="fg3" size={10.5}>fillEvenly (mobile)</SectionCaption>
          <View style={{ borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
            <TabStrip
              fillEvenly
              tabs={[
                { id: 'detail.tsx',  label: 'detail.tsx' },
                { id: 'count.tsx',   label: 'count.tsx' },
                { id: 'recipes.tsx', label: 'recipes.tsx' },
              ]}
              activeId={tabId}
              onChange={setTabId}
            />
          </View>
        </Group>

        <Group title="TitleBar">
          <View style={{ borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
            <TitleBar storeName="Towson" section="Inventory" itemSlug="Atlantic salmon" />
            <View style={{ height: 80, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>(window content)</Text>
            </View>
          </View>
        </Group>

        <Group title="StatusBar">
          <View style={{ borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
            <View style={{ height: 60, backgroundColor: C.bg }} />
            <CmdStatusBar
              left={
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <DotForBar status="ok" />
                    <Text style={[Type.statusBar, { color: C.fg3 }]}>synced</Text>
                  </View>
                  <Text style={[Type.statusBar, { color: C.fg3 }]}>row 3 / 142</Text>
                  <Text style={[Type.statusBar, { color: C.fg3 }]}>cat:seafood</Text>
                </>
              }
              right={
                <>
                  <Text style={[Type.statusBar, { color: C.fg3 }]}>UTF-8</Text>
                  <Text style={[Type.statusBar, { color: C.fg3 }]}>LF</Text>
                  <Text style={[Type.statusBar, { color: C.accent }]}>⌘K palette</Text>
                </>
              }
            />
          </View>
        </Group>

        <Group title="Sidebar (desktop tree-nav)">
          <View style={{ height: 360, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden', flexDirection: 'row' }}>
            <Sidebar
              groups={sampleTreeGroups}
              selectedId={treeSel}
              onSelect={setTreeSel}
              onPaletteOpen={() => setPaletteOpen(true)}
              footerLeft={<Text style={[Type.statusBar, { color: C.fg3 }]}>● admin</Text>}
              footerRight={<Text style={[Type.statusBar, { color: C.fg3 }]}>EOD 18/24</Text>}
            />
            <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                selected: {treeSel}
              </Text>
            </View>
          </View>
        </Group>

        <Group title="MobileNavDrawer + CommandPalette (modals)">
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity
              testID="open-mobile-drawer"
              onPress={() => setDrawerOpen(true)}
              style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: CmdRadius.sm, backgroundColor: C.accent }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#000' }}>open drawer</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="open-cmd-palette"
              onPress={() => setPaletteOpen(true)}
              style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.panel2 }}
            >
              <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg2 }}>open palette (⌘K)</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            Palette is web-only. ⌘K shortcut works system-wide while preview is mounted.
          </Text>
        </Group>

        <Group title="Type ramp (sanity)">
          <View style={{ gap: 6 }}>
            <Text style={[Type.display, { color: C.fg }]}>Atlantic salmon</Text>
            <Text style={[Type.h1, { color: C.fg }]}>Inventory</Text>
            <Text style={[Type.h2, { color: C.fg }]}>Inventory · 12 items</Text>
            <Text style={[Type.body, { color: C.fg }]}>Body 13/400 — Inter Tight regular.</Text>
            <Text style={[Type.bodySm, { color: C.fg2 }]}>Body small 12/400 — Inter Tight.</Text>
            <Text style={[Type.kpiValueDesktop, { color: C.fg }]}>4.2 lb</Text>
            <Text style={[Type.kpiLabelDesktop, { color: C.fg3 }]}>on hand</Text>
            <Text style={[Type.tableNum, { color: C.fg }]}>14.0 / 10  lb</Text>
            <Text style={[Type.breadcrumb, { color: C.fg3 }]}>inv://towson — inventory — atlantic-salmon</Text>
            <Text style={[Type.statusBar, { color: C.fg3 }]}>● synced  row 3 / 142  cat:seafood</Text>
          </View>
        </Group>
      </ScrollView>

      {/* Modals — mounted always; visible flag controls show/hide. */}
      <MobileNavDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        groups={sampleTreeGroups}
        selectedId={treeSel}
        onSelect={setTreeSel}
        paletteQuery={drawerQuery}
        onPaletteChange={setDrawerQuery}
        subtitle="admin@local · v2.4"
        footerLeft={<Text style={[Type.statusBar, { color: C.fg3 }]}>● admin@local</Text>}
        footerRight={<Text style={[Type.statusBar, { color: C.fg3 }]}>EOD 18/24</Text>}
      />
      <CommandPalette
        visible={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(route) => {
          if (typeof console !== 'undefined') console.log('[cmd-preview] navigate:', route);
        }}
        index={samplePaletteIndex}
        scopeHint="items, recipes, vendors, screens"
      />
    </View>
  );
}

// ── Internal layout helpers ────────────────────────────────
const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const C = useCmdColors();
  return (
    <View
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        padding: 14,
        gap: 12,
      }}
    >
      <Text style={[Type.caption, { color: C.fg3 }]}>{title}</Text>
      {children}
    </View>
  );
};

const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
    {children}
  </View>
);

const Labeled: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => {
  const C = useCmdColors();
  return (
    <View style={{ alignItems: 'center', gap: 4 }}>
      {children}
      <Text style={{ fontFamily: mono(400), fontSize: 9, color: C.fg3 }}>{label}</Text>
    </View>
  );
};

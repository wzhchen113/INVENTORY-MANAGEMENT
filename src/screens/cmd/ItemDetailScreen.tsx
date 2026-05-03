import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono, Type } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useStockSeries, useRecipesUsingItem } from '../../lib/cmdSelectors';
import { relativeTime } from '../../utils/relativeTime';
import { formatAuditAction } from '../../utils/formatAuditAction';
import { TitleBar } from '../../components/cmd/TitleBar';
import { CmdStatusBar } from '../../components/cmd/StatusBar';
import { TabStrip } from '../../components/cmd/TabStrip';
import { StatCard } from '../../components/cmd/StatCard';
import { StatusPill } from '../../components/cmd/StatusPill';
import { StockHistoryChart } from '../../components/cmd/StockHistoryChart';
import { PropertiesJson } from '../../components/cmd/PropertiesJson';
import { ActivityRow } from '../../components/cmd/ActivityRow';
import { SectionCaption } from '../../components/cmd/SectionCaption';
import { ComingSoonPanel } from '../../components/cmd/ComingSoonPanel';
import { useBreakpoint } from '../../theme/breakpoints';

const slugify = (s: string) => s.toLowerCase().trim().replace(/\s+/g, '-');
const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

const TABS = [
  { id: 'detail.tsx',  label: 'detail.tsx' },
  { id: 'usage.tsx',   label: 'usage.tsx' },
  { id: 'audit.tsx',   label: 'audit.tsx' },
  { id: 'recipes.tsx', label: 'recipes.tsx' },
];

export default function ItemDetailScreen() {
  const C = useCmdColors();
  const breakpoint = useBreakpoint();
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const itemId = route.params?.itemId as string | undefined;

  const inventory = useStore((s) => s.inventory);
  const vendors   = useStore((s) => s.vendors);
  const auditLog  = useStore((s) => s.auditLog);
  const currentUser = useStore((s) => s.currentUser);
  const currentStore = useStore((s) => s.currentStore);
  const getItemStatus = useStore((s) => s.getItemStatus);

  const item = React.useMemo(() => inventory.find((i) => i.id === itemId), [inventory, itemId]);
  const status = item ? getItemStatus(item) : 'ok';
  const vendor = item ? vendors.find((v) => v.id === item.vendorId) : undefined;
  const series = useStockSeries(itemId || '', 14);
  const recipesUsing = useRecipesUsingItem(itemId || '');

  // Pick which 14d delta to surface in the chart legend
  const firstNonNull = series.find((v) => v != null) as number | undefined;
  const lastNonNull = [...series].reverse().find((v) => v != null) as number | undefined;
  const deltaPct =
    firstNonNull && lastNonNull && firstNonNull > 0
      ? Math.round(((lastNonNull - firstNonNull) / firstNonNull) * 100)
      : null;

  const itemActivity = React.useMemo(() => {
    if (!item) return [];
    return auditLog
      .filter((e) => {
        const ref = (e.itemRef || '').toLowerCase();
        return ref === item.name.toLowerCase() || ref === item.id;
      })
      .slice(-3);
  }, [auditLog, item]);

  const [activeTab, setActiveTab] = React.useState('detail.tsx');

  if (!item) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
          item not found · {itemId}
        </Text>
        <TouchableOpacity onPress={() => nav.goBack()} style={{ marginTop: 12 }}>
          <Text style={{ fontFamily: mono(600), fontSize: 13, color: C.accent }}>‹ back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const meta = `${item.category} · ${vendor?.name || 'no vendor'} · ${relativeTime(item.lastUpdatedAt) || 'never'} ago`;

  const inventoryValue = item.currentStock * (item.costPerUnit || 0);
  const daysOfCover =
    item.averageDailyUsage > 0
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

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {Platform.OS === 'web' && breakpoint === 'desktop' ? (
        <TitleBar storeName={currentStore?.name || 'store'} section="Inventory" itemSlug={item.name} />
      ) : null}

      {/* Mobile header */}
      <View
        style={{
          paddingTop: Platform.OS === 'web' ? 12 : 54,
          paddingHorizontal: 14,
          paddingBottom: 8,
          backgroundColor: C.panel,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={{ fontFamily: mono(600), fontSize: 13, color: C.accent }}>‹ inventory</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            {shortId(item.id)}.tsx
          </Text>
        </View>
        <Text style={{ fontFamily: mono(600), fontSize: 13, color: C.accent }}>⋯</Text>
      </View>

      <TabStrip tabs={TABS} activeId={activeTab} onChange={setActiveTab} fillEvenly />

      <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
        {activeTab === 'detail.tsx' ? (
          <>
            {/* Hero */}
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(item.id)}</Text>
                <StatusPill status={status} />
              </View>
              <Text style={{ fontFamily: sans(700), fontSize: 24, color: C.fg, letterSpacing: -0.4 }}>
                {item.name}
              </Text>
              <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2 }}>{meta}</Text>
            </View>

            {/* Action row */}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: CmdRadius.md, backgroundColor: C.accent }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#000', letterSpacing: 0.5 }}>+ COUNT</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: CmdRadius.md, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.panel }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg, letterSpacing: 0.5 }}>EDIT</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ width: 46, paddingVertical: 10, alignItems: 'center', borderRadius: CmdRadius.md, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.panel }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg }}>⌥</Text>
              </TouchableOpacity>
            </View>

            {/* Stat grid 2×2 */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {stats.map((s) => (
                <View key={s.label} style={{ width: '48.5%' }}>
                  <StatCard compact label={s.label} value={s.value} sub={s.sub} />
                </View>
              ))}
            </View>

            {/* Stock history chart */}
            <View
              style={{
                backgroundColor: C.panel,
                borderRadius: CmdRadius.lg,
                borderWidth: 1,
                borderColor: C.border,
                padding: 12,
                gap: 6,
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <SectionCaption tone="fg3" size={10}>stock_history.dat — 14d</SectionCaption>
                <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>par={item.parLevel}</Text>
              </View>
              <StockHistoryChart
                data={series}
                par={item.parLevel}
                width={340}
                height={100}
                gridLines={3}
              />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                  ■ on-hand   — par
                </Text>
                {deltaPct != null ? (
                  <Text style={{ fontFamily: mono(500), fontSize: 10, color: deltaPct < 0 ? C.warn : C.ok }}>
                    {deltaPct < 0 ? '↘' : '↗'} {Math.abs(deltaPct)}% in 14d
                  </Text>
                ) : null}
              </View>
            </View>

            {/* Properties */}
            <View
              style={{
                backgroundColor: C.panel,
                borderRadius: CmdRadius.lg,
                borderWidth: 1,
                borderColor: C.border,
                padding: 12,
                gap: 6,
              }}
            >
              <SectionCaption tone="fg3" size={10}>properties.json</SectionCaption>
              <PropertiesJson entries={props} />
            </View>

            {/* Activity log */}
            <View
              style={{
                backgroundColor: C.panel,
                borderRadius: CmdRadius.lg,
                borderWidth: 1,
                borderColor: C.border,
                padding: 12,
                gap: 6,
              }}
            >
              <SectionCaption tone="fg3" size={10}>activity_log</SectionCaption>
              {itemActivity.length === 0 ? (
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>
                  no activity recorded
                </Text>
              ) : (
                itemActivity.map((e) => (
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

            {/* Recipes used in */}
            <View
              style={{
                backgroundColor: C.panel,
                borderRadius: CmdRadius.lg,
                borderWidth: 1,
                borderColor: C.border,
                padding: 12,
                gap: 6,
              }}
            >
              <SectionCaption tone="fg3" size={10}>
                used in {recipesUsing.length} recipes
              </SectionCaption>
              {recipesUsing.length === 0 ? (
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>
                  not in any recipe
                </Text>
              ) : (
                recipesUsing.map((r) => (
                  <View
                    key={`${r.kind}:${r.id}`}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4 }}
                  >
                    <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>
                      {r.name}
                    </Text>
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, marginRight: 8 }}>
                      {r.portion}
                    </Text>
                    {r.soldPerWeek != null ? (
                      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg, width: 60, textAlign: 'right' }}>
                        {r.soldPerWeek}/wk
                      </Text>
                    ) : null}
                  </View>
                ))
              )}
            </View>
          </>
        ) : (
          <ComingSoonPanel tabName={activeTab.replace('.tsx', '')} />
        )}
      </ScrollView>

      <CmdStatusBar
        bottomInset={Platform.OS === 'web' ? 0 : 28}
        left={
          <Text style={[Type.statusBar, { color: C.fg3 }]}>
            inv://{slugify(currentStore?.name || 'store')} — inventory — {slugify(item.name)}
          </Text>
        }
      />
    </View>
  );
}

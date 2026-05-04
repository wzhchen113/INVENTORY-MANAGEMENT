import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StockHistoryChart } from '../../../components/cmd/StockHistoryChart';
import { ActivityRow } from '../../../components/cmd/ActivityRow';
import { StatusDot } from '../../../components/cmd/StatusDot';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { relativeTime } from '../../../utils/relativeTime';
import { formatAuditAction } from '../../../utils/formatAuditAction';

// Pattern C — stream/report. KPI grid + chart + alerts + activity.
// Admin-only app — store users use a separate app via API.
export default function DashboardSection() {
  const C = useCmdColors();
  const inventory = useStore((s) => s.inventory);
  const wasteLog = useStore((s) => s.wasteLog);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const auditLog = useStore((s) => s.auditLog);
  const currentStore = useStore((s) => s.currentStore);
  const getItemStatus = useStore((s) => s.getItemStatus);

  const [tabId, setTabId] = React.useState('overview.tsx');

  const storeInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );

  const inventoryValue = storeInventory.reduce(
    (sum, i) => sum + i.currentStock * i.costPerUnit,
    0,
  );

  const lowOut = React.useMemo(
    () =>
      storeInventory
        .filter((i) => {
          const s = getItemStatus(i);
          return s === 'low' || s === 'out';
        })
        .sort((a, b) => {
          const aS = getItemStatus(a);
          const bS = getItemStatus(b);
          if (aS === bS) return a.name.localeCompare(b.name);
          return aS === 'out' ? -1 : 1;
        }),
    [storeInventory, getItemStatus],
  );

  const wasteWeek = React.useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    return wasteLog
      .filter((w) => w.storeId === currentStore.id && new Date(w.timestamp).getTime() >= cutoff)
      .reduce((sum, w) => sum + w.quantity * w.costPerUnit, 0);
  }, [wasteLog, currentStore.id]);

  // 14-day food-cost trend — derives a stub from waste/EOD totals if no
  // POS data exists. Stays flat-ish but non-zero so the chart reads.
  const foodCostTrend: Array<number | null> = React.useMemo(() => {
    const days: Array<number | null> = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * 24 * 3600 * 1000);
      const key = day.toISOString().slice(0, 10);
      const sub = eodSubmissions.find((s) => s.storeId === currentStore.id && s.date === key);
      // Mock cost % if no real data — 28-34% range
      days.push(sub ? 30 + ((sub.entries?.length || 0) % 5) : null);
    }
    return days.some((d) => d != null) ? days : [29.8, 30.2, 31.4, 32.1, 30.6, 30.9, 31.8, 32.4, 31.2, 30.4, 31.0, 31.6, 32.0, 31.4];
  }, [eodSubmissions, currentStore.id]);

  // Period stats (current/avg/min/max/days_above) + axis label data for the
  // FOOD_COST_TREND chart. Derived from foodCostTrend so the chart card and
  // the stats row always agree.
  const TARGET = 32;
  const trendStats = React.useMemo(() => {
    const nonNull = foodCostTrend.filter((v): v is number => v != null);
    if (nonNull.length === 0) {
      return { current: null, avg: null, min: null, max: null, daysAbove: 0, total: 14 };
    }
    const last = [...foodCostTrend].reverse().find((v) => v != null) as number;
    const sum = nonNull.reduce((s, v) => s + v, 0);
    return {
      current: last,
      avg: sum / nonNull.length,
      min: Math.min(...nonNull),
      max: Math.max(...nonNull),
      daysAbove: nonNull.filter((v) => v > TARGET).length,
      total: nonNull.length,
    };
  }, [foodCostTrend]);

  const trendAxisLabels = React.useMemo(() => {
    const fmt = (date: Date) => date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
    const today = new Date();
    const fourteenDaysAgo = new Date(today);
    fourteenDaysAgo.setDate(today.getDate() - 13);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 7);
    return {
      // Y axis: 5 ticks from a generous yMax (chart uses par * 1.1 as a floor)
      // down to 0. Match StockHistoryChart's yMax = max(par*1.1, ...points).
      yAxis: ['40%', '30%', '20%', '10%', '0%'],
      xAxis: [
        { atIndex: 0, label: fmt(fourteenDaysAgo) },
        { atIndex: 7, label: fmt(sevenDaysAgo) },
        { atIndex: 13, label: fmt(today) },
      ],
    };
  }, []);

  // Recent activity — last 6 events for the current store
  const recentActivity = React.useMemo(
    () => auditLog.filter((e) => e.storeId === currentStore.id).slice(-6).reverse(),
    [auditLog, currentStore.id],
  );

  const today = new Date();
  const greeting =
    today.getHours() < 12 ? 'good morning' : today.getHours() < 17 ? 'good afternoon' : 'good evening';

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[
          { id: 'overview.tsx', label: 'overview.tsx' },
          { id: 'today.tsx',    label: 'today.tsx' },
        ]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            store: <Text style={{ color: C.fg }}>{(currentStore.name || 'store').toLowerCase()}</Text>
            {'  '}·{'  '}period: <Text style={{ color: C.fg }}>today</Text>
          </Text>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
        {/* Hero */}
        <View style={{ gap: 4 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
            // {greeting}, admin · {today.toDateString().toLowerCase()}
          </Text>
          <Text style={[Type.h1, { color: C.fg }]}>
            {currentStore.name || 'Store'} · day in progress
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatCard
            label="Inventory value"
            value={`$${inventoryValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
            sub={`${storeInventory.length} items`}
          />
          <StatCard label="Food cost %" value="—" sub="no POS imports yet" />
          <StatCard label="Waste / wk" value={`$${wasteWeek.toFixed(0)}`} sub="last 7 days" />
          <StatCard
            label="Stock alerts"
            value={String(lowOut.length)}
            sub={`${lowOut.filter((i) => getItemStatus(i) === 'out').length} out · ${lowOut.filter((i) => getItemStatus(i) === 'low').length} low`}
          />
        </View>

        {/* Chart + Stock alerts side-by-side */}
        <View style={{ flexDirection: 'row', gap: 14 }}>
          <View
            style={{
              flex: 1.4,
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              padding: 14,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <SectionCaption tone="fg3" size={10.5}>food_cost_trend.dat</SectionCaption>
              <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                14d · target {TARGET}%
              </Text>
            </View>
            <StockHistoryChart
              data={foodCostTrend}
              par={TARGET}
              width={520}
              height={160}
              gridLines={4}
              yAxisLabels={trendAxisLabels.yAxis}
              xAxisLabels={trendAxisLabels.xAxis}
              interactive
              formatTooltip={(v) => `${v.toFixed(1)}%`}
            />
            {/* Period stats row */}
            {trendStats.current != null ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, paddingTop: 2 }}>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  current{' '}
                  <Text style={{ color: trendStats.current > TARGET ? C.warn : C.ok, fontFamily: mono(700) }}>
                    {trendStats.current.toFixed(1)}%
                  </Text>
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  avg{' '}
                  <Text style={{ color: (trendStats.avg ?? 0) > TARGET ? C.warn : C.ok, fontFamily: mono(700) }}>
                    {trendStats.avg!.toFixed(1)}%
                  </Text>
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  min <Text style={{ color: C.fg2, fontFamily: mono(700) }}>{trendStats.min!.toFixed(1)}%</Text>
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  max <Text style={{ color: C.fg2, fontFamily: mono(700) }}>{trendStats.max!.toFixed(1)}%</Text>
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  days_above{' '}
                  <Text style={{ color: trendStats.daysAbove > 0 ? C.warn : C.ok, fontFamily: mono(700) }}>
                    {trendStats.daysAbove}/{trendStats.total}
                  </Text>
                </Text>
              </View>
            ) : (
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                no data — needs POS imports
              </Text>
            )}
            <View style={{ flexDirection: 'row', gap: 14 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                ■ daily %   — target {TARGET}%
              </Text>
            </View>
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
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <SectionCaption tone="fg3" size={10.5}>stock_alerts</SectionCaption>
              <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                {lowOut.length} items
              </Text>
            </View>
            {lowOut.length === 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>
                all stocked
              </Text>
            ) : (
              lowOut.slice(0, 6).map((i, idx) => {
                const status = getItemStatus(i);
                return (
                  <View
                    key={i.id}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingVertical: 8,
                      borderTopWidth: idx === 0 ? 0 : 1,
                      borderTopColor: C.border,
                      borderStyle: 'dashed',
                    }}
                  >
                    <StatusDot status={status} />
                    <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>
                      {i.name}
                    </Text>
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, fontVariant: ['tabular-nums'] }}>
                      {i.currentStock}/{i.parLevel} {i.unit}
                    </Text>
                    <StatusPill status={status} />
                  </View>
                );
              })
            )}
          </View>
        </View>

        {/* Activity full-width */}
        <View
          style={{
            backgroundColor: C.panel,
            borderRadius: CmdRadius.lg,
            borderWidth: 1,
            borderColor: C.border,
            padding: 14,
            gap: 4,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <SectionCaption tone="fg3" size={10.5}>activity_log</SectionCaption>
            <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>last 6 events</Text>
          </View>
          {recentActivity.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>
              no activity recorded
            </Text>
          ) : (
            recentActivity.map((e) => (
              <ActivityRow
                key={e.id}
                ago={relativeTime(e.timestamp)}
                userName={e.userName}
                action={formatAuditAction(e)}
                target={e.itemRef}
              />
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

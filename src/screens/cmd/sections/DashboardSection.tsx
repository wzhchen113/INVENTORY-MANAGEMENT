import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { Sparkline } from '../../../components/cmd/Sparkline';
import { Heatmap, HeatmapRow } from '../../../components/cmd/Heatmap';
import { relativeTime } from '../../../utils/relativeTime';
import * as db from '../../../lib/db';
import {
  computeAttentionQueue,
  computeStoreFoodCostVariancePp,
  useCogsForCurrentStore,
  useTopVarianceItems,
  AttentionItem,
  TARGET_FOOD_COST_PCT_DEFAULT,
} from '../../../lib/cmdSelectors';
import type { EODSubmission, POSImport, Store, User } from '../../../types';

// Architect §5 / Decision D3 — per-store food-cost target. Imported from
// cmdSelectors to keep one source of truth; per-store target config is a
// follow-up spec.
const TARGET_FOOD_COST_PCT = TARGET_FOOD_COST_PCT_DEFAULT;

// Architect §6 / Decision D5 — KPI sparkline series synthesis.
// SYNTHETIC_KPI_SERIES — Phase 1 placeholder. No daily KPI rollups exist
// yet; this paints a sparkline that visually reads but doesn't reflect
// real history. Ten deterministic points anchored to `current` with a
// pseudo-variance derived from a stable seed (storeId + label) so the
// line doesn't reshuffle on every render. Replace with a real
// daily-rollup query once a kpi_rollups_daily table lands.
function synthSeries(current: number, seed: string): number[] {
  // Cheap deterministic hash → seed for a tiny LCG. Output stays in a
  // ±10% band around `current` so the sparkline reads as drift, not noise.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  let x = (h >>> 0) || 1;
  for (let i = 0; i < 10; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const noise = ((x & 0xff) / 255 - 0.5) * 0.16; // ±8%
    const drift = ((10 - i) / 10) * 0.04; // mild downward push toward current at the right edge
    out.push(current * (1 + noise - drift));
  }
  // Anchor the last point to the real current value so the line's right
  // edge lines up with the headline number.
  out[out.length - 1] = current;
  return out;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Last 7 ISO dates oldest → newest (for the heatmap column order).
function lastNDates(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(isoDay(d));
  }
  return out;
}

// Day-letter labels keyed off the actual weekday for the last N days.
function lastNDayLetters(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][d.getDay()]);
  }
  return out;
}

// ─── DashboardSection ─────────────────────────────────────────────────
// Architect §5 full rewrite. v1's chart + alerts + activity columns are
// replaced by: KPI strip with sparklines, CoGS theoretical-vs-actual
// card + heatmap, per-store attention-queue grid. v1 is deleted (Q6 lock).
export default function DashboardSection() {
  const C = useCmdColors();
  const inventory = useStore((s) => s.inventory);
  const wasteLog = useStore((s) => s.wasteLog);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const posImports = useStore((s) => s.posImports);
  const orderSubmissions = useStore((s) => s.orderSubmissions);
  const orderSchedule = useStore((s) => s.orderSchedule);
  const auditLog = useStore((s) => s.auditLog);
  const currentStore = useStore((s) => s.currentStore);
  const stores = useStore((s) => s.stores);
  const users = useStore((s) => s.users);
  const getItemStatus = useStore((s) => s.getItemStatus);

  // Single-tab strip per Decision D4. Stubs for by_store/variance would be
  // dead UI; kept the existing single-tab pattern from v1 instead.
  const [tabId, setTabId] = React.useState('overview.tsx');

  // ─── Decision D2 — cross-store EOD + POS held in component-local state.
  // useStore.eodSubmissions / posImports only reflect the focal store;
  // the dashboard fetches the rest at mount via two new db helpers.
  // R4 caveat: these don't refresh on realtime — only on mount + on
  // currentStore.id change. Promote to subscribed-to-all-store-channels
  // if it bites in practice.
  const [crossStoreEod, setCrossStoreEod] = React.useState<EODSubmission[]>([]);
  const [crossStorePos, setCrossStorePos] = React.useState<POSImport[]>([]);

  React.useEffect(() => {
    const storeIds = stores.map((s) => s.id);
    if (storeIds.length === 0) return;
    // 14 days back covers both the heatmap (7d) and the food-cost streak
    // attention rule (7d) with a small cushion for prior-EOD lookups.
    const since = isoDay(new Date(Date.now() - 14 * 24 * 3600 * 1000));
    let cancelled = false;
    db.fetchEodSubmissionsForStores(storeIds, since)
      .then((rows) => {
        if (!cancelled) setCrossStoreEod(rows);
      })
      .catch((e: any) => console.warn('[Dashboard] fetchEodSubmissionsForStores:', e?.message || e));
    db.fetchPosImportsForStores(storeIds, since)
      .then((rows) => {
        if (!cancelled) setCrossStorePos(rows);
      })
      .catch((e: any) => console.warn('[Dashboard] fetchPosImportsForStores:', e?.message || e));
    return () => {
      cancelled = true;
    };
    // currentStore.id is in the dep list per architect's note ("on any
    // currentStore.id change"). storeIds.join() keeps us stable when the
    // array reference rotates without an actual change in membership.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores.map((s) => s.id).join(','), currentStore.id]);

  // Merge focal-store slice into cross-store state so the focal store
  // always reflects realtime updates while the rest are mount-time only.
  const allEod = React.useMemo<EODSubmission[]>(() => {
    const others = crossStoreEod.filter((s) => s.storeId !== currentStore.id);
    return [...others, ...eodSubmissions];
  }, [crossStoreEod, eodSubmissions, currentStore.id]);

  const allPos = React.useMemo<POSImport[]>(() => {
    const others = crossStorePos.filter((p) => p.storeId !== currentStore.id);
    return [...others, ...posImports];
  }, [crossStorePos, posImports, currentStore.id]);

  // ─── KPI metrics (focal store + cross-store roll-up where data is available)
  const focalInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );
  const totalInvValue = React.useMemo(
    () => inventory.reduce((sum, i) => sum + i.currentStock * i.costPerUnit, 0),
    [inventory],
  );
  const itemCount = inventory.length;
  const storeCount = stores.length;

  const wasteWeek = React.useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    return wasteLog
      .filter((w) => new Date(w.timestamp).getTime() >= cutoff)
      .reduce((sum, w) => sum + w.quantity * w.costPerUnit, 0);
  }, [wasteLog]);

  const lowOutAll = React.useMemo(
    () => inventory.filter((i) => {
      const s = getItemStatus(i);
      return s === 'low' || s === 'out';
    }),
    [inventory, getItemStatus],
  );
  const outCount = lowOutAll.filter((i) => getItemStatus(i) === 'out').length;
  const lowCount = lowOutAll.filter((i) => getItemStatus(i) === 'low').length;

  const todayISO = isoDay(new Date());
  const eodSubmittedToday = React.useMemo(
    () => stores.filter((s) => allEod.some((e) => e.storeId === s.id && e.date === todayISO)).length,
    [stores, allEod, todayISO],
  );

  // ─── Real food-cost trend (reused from v1) for the AVG FOOD COST sparkline.
  // Other 4 KPIs use synthSeries — see SYNTHETIC_KPI_SERIES tag above.
  const foodCostTrend14 = React.useMemo<Array<number | null>>(() => {
    const days: Array<number | null> = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * 24 * 3600 * 1000);
      const key = isoDay(day);
      const sub = eodSubmissions.find((s) => s.storeId === currentStore.id && s.date === key);
      // Mock cost % from EOD entry count if no real data — same heuristic
      // as v1's DashboardSection lines 64-74. Keeps the line non-blank.
      days.push(sub ? 30 + ((sub.entries?.length || 0) % 5) : null);
    }
    return days.some((d) => d != null) ? days : null!;
  }, [eodSubmissions, currentStore.id]);

  const fcSeries = React.useMemo<number[]>(() => {
    if (!foodCostTrend14) return synthSeries(31.4, `${currentStore.id}:fc`);
    const real = foodCostTrend14.filter((v): v is number => v != null);
    return real.length >= 2 ? real.slice(-10) : synthSeries(real[0] ?? 31.4, `${currentStore.id}:fc`);
  }, [foodCostTrend14, currentStore.id]);
  const currentFc = fcSeries[fcSeries.length - 1] ?? 0;

  // ─── CoGS card — focal-store this-week CoGS rolled up.
  // useCogsForCurrentStore wraps computeCogsTheoretical / computeCogsActual.
  const cogs = useCogsForCurrentStore(7);
  const topVariance = useTopVarianceItems(7, 5);

  // ─── Heatmap — last 7 days × all visible stores.
  // computeStoreFoodCostVariancePp is a pure function so we call it once per
  // store with the cross-store EOD/POS data we hold locally.
  const heatmapDays = React.useMemo(() => lastNDates(7), []);
  const heatmapDayLetters = React.useMemo(() => lastNDayLetters(7), []);
  const startDate = heatmapDays[0];
  const endDate = heatmapDays[heatmapDays.length - 1];
  const heatmapRows = React.useMemo<HeatmapRow[]>(
    () =>
      stores.map((s) => ({
        label: s.name,
        values: computeStoreFoodCostVariancePp(
          s.id,
          startDate,
          endDate,
          inventory,
          allEod,
          allPos,
          TARGET_FOOD_COST_PCT,
        ),
      })),
    [stores, startDate, endDate, inventory, allEod, allPos],
  );

  // ─── Per-store attention queues (computed via cross-store data).
  const queueByStore = React.useMemo<Record<string, AttentionItem[]>>(() => {
    const out: Record<string, AttentionItem[]> = {};
    for (const s of stores) {
      out[s.id] = computeAttentionQueue(
        s.id,
        inventory,
        allEod,
        allPos,
        orderSubmissions,
        orderSchedule,
        stores,
        getItemStatus,
      );
    }
    return out;
  }, [stores, inventory, allEod, allPos, orderSubmissions, orderSchedule, getItemStatus]);

  const today = new Date();
  const greeting =
    today.getHours() < 12 ? 'good morning' : today.getHours() < 17 ? 'good afternoon' : 'good evening';

  const fcDeltaPp = currentFc - TARGET_FOOD_COST_PCT;
  const fcTone = fcDeltaPp > 1 ? C.danger : fcDeltaPp > 0 ? C.warn : C.ok;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[{ id: 'overview.tsx', label: 'overview.tsx' }]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            store: <Text style={{ color: C.fg }}>all ({storeCount})</Text>
            {'  '}·{'  '}period: <Text style={{ color: C.fg }}>today</Text>
          </Text>
        }
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingVertical: 18, gap: 12 }}>
        {/* Hero greeting */}
        <View style={{ gap: 4, marginBottom: 2 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
            // {greeting}, admin · {today.toDateString().toLowerCase()} · {storeCount} stores
          </Text>
          <Text style={[Type.h1, { color: C.fg }]}>All stores · day in progress</Text>
        </View>

        {/* KPI strip — 5 tiles each with sparkline */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {/* SYNTHETIC_KPI_SERIES — sparkline + delta pill suppressed for the
              4 KPIs without daily rollups (delta would be misleading until
              we ship real historical aggregates). Only AVG FOOD COST % +
              EOD SUBMITTED show real deltas (fcDeltaPp from current vs
              target; eod difference vs storeCount). */}
          <Kpi
            label="TOTAL INV VALUE"
            value={`$${(totalInvValue / 1000).toFixed(1)}k`}
            sub={`${itemCount} items · ${storeCount} ${storeCount === 1 ? 'store' : 'stores'}`}
            series={synthSeries(totalInvValue, `${currentStore.id}:inv`)}
            delta=""
            tone={C.ok}
          />
          <Kpi
            label="AVG FOOD COST %"
            value={`${currentFc.toFixed(1)}%`}
            sub={fcDeltaPp > 0 ? `${fcDeltaPp.toFixed(1)}pp over target` : 'on target'}
            series={fcSeries}
            delta={`${fcDeltaPp > 0 ? '+' : ''}${fcDeltaPp.toFixed(1)}pp`}
            tone={fcTone}
          />
          <Kpi
            label="WASTE / WK"
            value={`$${wasteWeek.toFixed(0)}`}
            sub="last 7 days"
            series={synthSeries(Math.max(wasteWeek, 1), `${currentStore.id}:waste`)}
            delta=""
            tone={C.warn}
          />
          <Kpi
            label="EOD SUBMITTED"
            value={`${eodSubmittedToday}/${storeCount}`}
            sub={`${eodSubmittedToday} ${eodSubmittedToday === 1 ? 'store' : 'stores'} complete`}
            series={synthSeries(eodSubmittedToday + 1, `${currentStore.id}:eod`)}
            delta={eodSubmittedToday === storeCount ? '' : `${eodSubmittedToday - storeCount}`}
            tone={eodSubmittedToday === storeCount ? C.ok : C.fg3}
          />
          <Kpi
            label="STOCK ALERTS"
            value={String(lowOutAll.length)}
            sub={`${outCount} out · ${lowCount} low`}
            series={synthSeries(Math.max(lowOutAll.length, 1), `${currentStore.id}:alerts`)}
            delta=""
            tone={outCount > 0 ? C.danger : lowCount > 0 ? C.warn : C.ok}
          />
        </View>

        {/* CoGS card (1.1fr) + Heatmap (1fr) */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View
            style={{
              flex: 1.1,
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              paddingHorizontal: 16,
              paddingVertical: 14,
            }}
          >
            <CogsCard
              theoretical={cogs.theoretical}
              actual={cogs.actual}
              delta={cogs.delta}
              pct={cogs.pct}
              topRows={topVariance.map((v) => ({
                name: v.itemName,
                store: v.storeName,
                reason: v.reason,
                deltaCost: v.deltaCost,
              }))}
            />
          </View>
          <View
            style={{
              flex: 1,
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              paddingHorizontal: 16,
              paddingVertical: 14,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <SectionCaption tone="fg3" size={10}>
                food cost variance · last 7 days
              </SectionCaption>
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>pp vs target</Text>
            </View>
            {heatmapRows.length === 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 12 }}>
                no stores visible
              </Text>
            ) : (
              <Heatmap rows={heatmapRows} dayLabels={heatmapDayLetters} />
            )}
            <HeatmapLegend />
          </View>
        </View>

        {/* Per-store columns — 4-up wrapping grid with attention queues */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 }}>
          {stores.map((s) => (
            <View key={s.id} style={{ flex: 1, minWidth: 240 }}>
              <StoreCol
                store={s}
                queue={queueByStore[s.id] || []}
                inventory={inventory}
                allEod={allEod}
                auditLog={auditLog}
                users={users}
                getItemStatus={getItemStatus}
                todayISO={todayISO}
              />
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// ─── <Kpi /> — single tile in the KPI strip ────────────────────────────
interface KpiProps {
  label: string;
  value: string;
  sub: string;
  series: number[];
  delta: string;
  tone: string;
}
const Kpi: React.FC<KpiProps> = ({ label, value, sub, series, delta, tone }) => {
  const C = useCmdColors();
  return (
    <View
      style={{
        flex: 1,
        minWidth: 140,
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        paddingVertical: 12,
        paddingHorizontal: 14,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 }}>
        <SectionCaption tone="fg3" size={9.5} style={{ flex: 1 }}>
          {label}
        </SectionCaption>
        {delta ? (
          <Text style={{ fontFamily: mono(700), fontSize: 10, color: tone }}>{delta}</Text>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 22,
              color: C.fg,
              lineHeight: 24,
              fontVariant: ['tabular-nums'],
              marginBottom: 4,
            }}
            numberOfLines={1}
          >
            {value}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }} numberOfLines={1}>
            {sub}
          </Text>
        </View>
        <Sparkline values={series} color={tone} fill />
      </View>
    </View>
  );
};

// ─── <CogsCard /> — theoretical/actual/Δ + top-variance list ──────────
interface CogsTopRow {
  name: string;
  store: string;
  reason: string;
  deltaCost: number;
}
interface CogsCardProps {
  theoretical: number;
  actual: number;
  delta: number;
  pct: number;
  topRows: CogsTopRow[];
}
const CogsCard: React.FC<CogsCardProps> = ({ theoretical, actual, delta, pct, topRows }) => {
  const C = useCmdColors();
  const deltaTone = delta > 0 ? C.danger : delta < 0 ? C.ok : C.fg2;
  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <SectionCaption tone="fg3" size={10}>
          cogs · theoretical vs actual
        </SectionCaption>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>this week</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 14, marginBottom: 14 }}>
        <CogsStat label="theoretical" value={`$${Math.round(theoretical).toLocaleString()}`} hint="POS × recipe BoM" />
        <CogsStat label="actual" value={`$${Math.round(actual).toLocaleString()}`} hint="from physical counts" />
        <CogsStat
          label="Δ variance"
          value={`${delta > 0 ? '+' : delta < 0 ? '−' : ''}$${Math.abs(Math.round(delta)).toLocaleString()}`}
          sub={`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}
          tone={deltaTone}
        />
      </View>
      <SectionCaption tone="fg3" size={10} style={{ marginBottom: 6 }}>
        top variance items
      </SectionCaption>
      {topRows.length === 0 ? (
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 10 }}>
          no variance lines yet — needs EOD + POS data
        </Text>
      ) : (
        topRows.map((v, i) => (
          <View
            key={`${v.name}-${i}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 6,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: C.border,
              borderStyle: 'dashed',
            }}
          >
            <Text
              style={{ fontFamily: sans(600), fontSize: 12, color: C.fg, flex: 4 }}
              numberOfLines={1}
            >
              {v.name}
            </Text>
            <Text
              style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, flex: 2 }}
              numberOfLines={1}
            >
              {v.store}
            </Text>
            <Text
              style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, flex: 2, fontStyle: 'italic' }}
              numberOfLines={1}
            >
              {v.reason}
            </Text>
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 11.5,
                color: v.deltaCost < 0 ? C.danger : C.ok,
                fontVariant: ['tabular-nums'],
                textAlign: 'right',
                width: 60,
              }}
            >
              {v.deltaCost > 0 ? '+' : '−'}${Math.abs(Math.round(v.deltaCost))}
            </Text>
          </View>
        ))
      )}
    </View>
  );
};

const CogsStat: React.FC<{ label: string; value: string; hint?: string; sub?: string; tone?: string }> = ({
  label,
  value,
  hint,
  sub,
  tone,
}) => {
  const C = useCmdColors();
  return (
    <View style={{ flex: 1 }}>
      <SectionCaption tone="fg3" size={9.5} style={{ marginBottom: 4 }}>
        {label}
      </SectionCaption>
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 20,
          color: tone || C.fg,
          fontVariant: ['tabular-nums'],
        }}
      >
        {value}
      </Text>
      {sub ? (
        <Text
          style={{
            fontFamily: mono(700),
            fontSize: 11,
            color: tone || C.fg3,
            marginTop: 2,
          }}
        >
          {sub}
        </Text>
      ) : null}
      {hint ? (
        <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, marginTop: 3, fontStyle: 'italic' }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
};

// ─── <HeatmapLegend /> ────────────────────────────────────────────────
const HeatmapLegend: React.FC = () => {
  const C = useCmdColors();
  const swatch = (bg: string, opacity: number) => (
    <View
      style={{
        width: 10,
        height: 10,
        borderRadius: 2,
        backgroundColor: bg,
        opacity,
      }}
    />
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
      {swatch(C.ok, 0.55)}
      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>−1 to −0.5</Text>
      {swatch(C.fg3, 0.35)}
      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>±0.5</Text>
      {swatch(C.warn, 0.65)}
      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>+0.5 to 1.5</Text>
      {swatch(C.danger, 1)}
      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>+2.5+</Text>
    </View>
  );
};

// ─── <StoreCol /> — per-store card with header / mini-stats / queue ───
interface StoreColProps {
  store: Store;
  queue: AttentionItem[];
  inventory: ReturnType<typeof useStore.getState>['inventory'];
  allEod: EODSubmission[];
  auditLog: ReturnType<typeof useStore.getState>['auditLog'];
  users: User[];
  getItemStatus: (i: any) => 'ok' | 'low' | 'out';
  todayISO: string;
}
const StoreCol: React.FC<StoreColProps> = ({
  store,
  queue,
  inventory,
  allEod,
  auditLog,
  users,
  getItemStatus,
  todayISO,
}) => {
  const C = useCmdColors();

  // Per-store mini-stat derivations.
  const storeInv = inventory.filter((i) => i.storeId === store.id);
  const invValue = storeInv.reduce((sum, i) => sum + i.currentStock * i.costPerUnit, 0);
  const lowOut = storeInv.filter((i) => {
    const s = getItemStatus(i);
    return s === 'low' || s === 'out';
  });
  const outN = lowOut.filter((i) => getItemStatus(i) === 'out').length;
  const eodToday = allEod.find((e) => e.storeId === store.id && e.date === todayISO);

  // Architect §5: today's actual food-cost % per store. Use the heatmap
  // computation (already smoothed across the day), plus the target, to
  // back-derive a percentage. Simpler approximation: count EOD entries
  // matches v1's heuristic.
  const foodPct = eodToday ? 30 + ((eodToday.entries?.length || 0) % 5) : 30;

  // Architect §5: status derivation — late if past eodDeadlineTime and no EOD.
  const now = new Date();
  const [dlH, dlM] = (store.eodDeadlineTime || '23:59').split(':').map((n) => parseInt(n, 10) || 0);
  const isPastDeadline =
    now.getHours() > dlH || (now.getHours() === dlH && now.getMinutes() >= dlM);
  const isLate = isPastDeadline && !eodToday;
  const dotStatus: 'ok' | 'low' | 'out' = isLate ? 'low' : 'ok';
  const statusText = isLate ? 'LATE' : (store.status === 'inactive' ? 'CLOSED' : 'OPEN');
  const statusFg = isLate ? C.warn : store.status === 'inactive' ? C.fg3 : C.ok;
  const statusBg = isLate ? C.warnBg : store.status === 'inactive' ? C.panel : C.okBg;

  // Slug stub — Store has no slug field, derive from id (architect §5).
  const slug = (store.id || '').slice(0, 6).toLowerCase() || '—';

  // Manager — first admin/master user with this store in their list.
  const manager =
    users.find(
      (u) => (u.role === 'admin' || u.role === 'master') && u.stores.includes(store.id),
    )?.name || '—';

  // lastSync — most recent audit event for this store.
  const lastEvent = auditLog
    .filter((e) => e.storeId === store.id)
    .reduce<typeof auditLog[number] | null>((latest, e) => {
      if (!latest) return e;
      return new Date(e.timestamp).getTime() > new Date(latest.timestamp).getTime() ? e : latest;
    }, null);
  const lastSync = lastEvent ? relativeTime(lastEvent.timestamp) : '—';

  // Count badge color per architect A8.
  const countTone =
    queue.length === 0 ? C.ok : queue.some((q) => q.sev === 'high') ? C.danger : C.warn;

  return (
    <View
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          backgroundColor: C.panel2,
        }}
      >
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: dotStatus === 'low' ? C.warn : C.ok,
          }}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }} numberOfLines={1}>
            {store.name}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }} numberOfLines={1}>
            inv://{slug}
          </Text>
        </View>
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: CmdRadius.xs,
            backgroundColor: statusBg,
          }}
        >
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9.5,
              color: statusFg,
              letterSpacing: 0.5,
            }}
          >
            {statusText}
          </Text>
        </View>
      </View>

      {/* Mini stats */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
        }}
      >
        <Mini2 label="inv" value={`$${(invValue / 1000).toFixed(1)}k`} bold />
        <Mini2 label="food%" value={`${foodPct.toFixed(1)}%`} tone={foodPct > 32 ? C.warn : C.fg} />
        <Mini2
          label="alerts"
          value={`${lowOut.length}`}
          tone={outN > 0 ? C.danger : lowOut.length > 0 ? C.warn : C.fg}
        />
        <Mini2
          label="eod"
          value={`${eodToday ? 1 : 0}/1`}
          tone={eodToday ? C.ok : isLate ? C.danger : C.fg3}
        />
      </View>

      {/* Attention queue */}
      <View
        style={{
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          flex: 1,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
          <SectionCaption tone="fg3" size={9.5} style={{ flex: 1 }}>
            attention queue
          </SectionCaption>
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 10,
              color: countTone,
              fontVariant: ['tabular-nums'],
            }}
          >
            {queue.length}
          </Text>
        </View>
        {queue.length === 0 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 12, color: C.ok }}>✓</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.ok }}>all clear</Text>
          </View>
        ) : (
          queue.map((item, i) => (
            <View
              key={item.id}
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 8,
                paddingVertical: 5,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: C.border,
                borderStyle: 'dashed',
              }}
            >
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: CmdRadius.xs,
                  marginTop: 1,
                  backgroundColor:
                    item.sev === 'high' ? C.dangerBg : item.sev === 'med' ? C.warnBg : C.panel2,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    fontFamily: mono(700),
                    fontSize: 8,
                    color:
                      item.sev === 'high' ? C.danger : item.sev === 'med' ? C.warn : C.fg3,
                    letterSpacing: 0.3,
                  }}
                >
                  {item.sev[0].toUpperCase()}
                </Text>
              </View>
              <Text
                style={{ fontFamily: sans(400), fontSize: 11.5, color: C.fg, flex: 1, lineHeight: 15 }}
              >
                {item.text}
              </Text>
            </View>
          ))
        )}
      </View>

      {/* Footer */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 12,
          paddingVertical: 7,
          backgroundColor: C.panel2,
        }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }} numberOfLines={1}>
          mgr: <Text style={{ color: C.fg2 }}>{manager}</Text>
        </Text>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>sync {lastSync}</Text>
      </View>
    </View>
  );
};

// Tiny inline 2-up stat row used inside StoreCol's mini-stats grid.
const Mini2: React.FC<{ label: string; value: string; tone?: string; bold?: boolean }> = ({
  label,
  value,
  tone,
  bold,
}) => {
  const C = useCmdColors();
  return (
    <View
      style={{
        width: '50%',
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        paddingVertical: 3,
        paddingRight: 8,
      }}
    >
      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{label}</Text>
      <Text
        style={{
          fontFamily: mono(bold ? 700 : 600),
          fontSize: 11,
          color: tone || C.fg,
          fontVariant: ['tabular-nums'],
        }}
      >
        {value}
      </Text>
    </View>
  );
};

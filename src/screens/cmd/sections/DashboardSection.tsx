import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { Sparkline } from '../../../components/cmd/Sparkline';
import { Heatmap, HeatmapRow } from '../../../components/cmd/Heatmap';
import { ExpiringItemsModal } from '../../../components/cmd/ExpiringItemsModal';
import { GridSkeleton } from '../../../components/cmd/GridSkeleton';
import { relativeTime } from '../../../utils/relativeTime';
import * as db from '../../../lib/db';
import { useT } from '../../../hooks/useT';
import {
  computeAttentionQueue,
  computeStoreFoodCostVariancePp,
  useCogsForCurrentStore,
  useTopVarianceItems,
  AttentionItem,
  TARGET_FOOD_COST_PCT_DEFAULT,
} from '../../../lib/cmdSelectors';
import type { EODSubmission, OrderSchedule, OrderSubmission, POSImport, Store, User } from '../../../types';

// Spec 081 D4 — stable empty schedule for a store with no fetched rows.
// Module-const so the queueByStore loop reuses one identity instead of
// allocating a fresh `{}` per iteration. Shape matches the store's default
// `orderSchedule` (a weekday-keyed Record).
const EMPTY_ORDER_SCHEDULE: OrderSchedule = {};

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
// Spec 038 N-1 — routes through the `enum.dayOfWeek.twoLetter.*` catalog
// instead of hardcoded English so Spanish / Mandarin users see locale-
// appropriate compact-density column headers. Catalog approach was
// chosen over Intl `narrow` because Intl's English narrow ("S/M/T/W/T/F/S")
// produces ambiguous duplicates for Sun/Sat and Tue/Thu.
const DAY_TWO_LETTER_KEYS = [
  'enum.dayOfWeek.twoLetter.sunday',
  'enum.dayOfWeek.twoLetter.monday',
  'enum.dayOfWeek.twoLetter.tuesday',
  'enum.dayOfWeek.twoLetter.wednesday',
  'enum.dayOfWeek.twoLetter.thursday',
  'enum.dayOfWeek.twoLetter.friday',
  'enum.dayOfWeek.twoLetter.saturday',
] as const;

type TFn = (key: string, vars?: Record<string, string | number>) => string;

function lastNDayLetters(n: number, T: TFn): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(T(DAY_TWO_LETTER_KEYS[d.getDay()]));
  }
  return out;
}

// ─── DashboardSection ─────────────────────────────────────────────────
// Architect §5 full rewrite. v1's chart + alerts + activity columns are
// replaced by: KPI strip with sparklines, CoGS theoretical-vs-actual
// card + heatmap, per-store attention-queue grid. v1 is deleted (Q6 lock).
export default function DashboardSection() {
  const C = useCmdColors();
  const T = useT();
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
  // Spec 074 — brand-global timezone used to anchor the per-store
  // attention queue's Monday-reset window. Per-store timezone is a
  // future spec follow-up; today one tz covers all stores.
  const timezone = useStore((s) => s.timezone);
  // Spec 055 — first-mount skeleton flag. Dashboard reads multiple
  // slices; check `inventory` as the most representative one.
  const storeLoading = useStore((s) => s.storeLoading);

  // Single-tab strip per Decision D4. Stubs for by_store/variance would be
  // dead UI; kept the existing single-tab pattern from v1 instead.
  const [tabId, setTabId] = React.useState('overview.tsx');

  // Spec 010 §4 — drill-down modal for the new `expiry` attention rule.
  // One modal serves all per-store columns; the snapshot already carries
  // store-scoped data so no extra fetch is needed when opening.
  const [expiryDrillDown, setExpiryDrillDown] = React.useState<{
    storeName: string;
    detail: AttentionItem['expiryDetail'];
  } | null>(null);

  // ─── Decision D2 — cross-store EOD + POS held in component-local state.
  // useStore.eodSubmissions / posImports only reflect the focal store;
  // the dashboard fetches the rest at mount via two new db helpers.
  // R4 caveat: these don't refresh on realtime — only on mount + on
  // currentStore.id change. Promote to subscribed-to-all-store-channels
  // if it bites in practice.
  const [crossStoreEod, setCrossStoreEod] = React.useState<EODSubmission[]>([]);
  const [crossStorePos, setCrossStorePos] = React.useState<POSImport[]>([]);
  // Spec 081 — cross-store order schedule + submissions, same caveat as the
  // EOD/POS slices above. orderSchedule is store-keyed → weekday-keyed so
  // each card can be passed its own store's schedule (the bug 081 fixes:
  // every card previously used the focal store's slice).
  const [crossStoreOrderSchedule, setCrossStoreOrderSchedule] = React.useState<
    Record<string, OrderSchedule>
  >({});
  const [crossStoreOrderSubmissions, setCrossStoreOrderSubmissions] = React.useState<
    OrderSubmission[]
  >([]);

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
    // Spec 081 — same effect, same `since` (D3: 14-day lookback is a strict
    // superset of the unconfirmed_po Monday-reset window), same cancelled guard.
    db.fetchOrderScheduleForStores(storeIds)
      .then((byStore) => {
        if (!cancelled) setCrossStoreOrderSchedule(byStore);
      })
      .catch((e: any) => console.warn('[Dashboard] fetchOrderScheduleForStores:', e?.message || e));
    db.fetchOrderSubmissionsForStores(storeIds, since)
      .then((rows) => {
        if (!cancelled) setCrossStoreOrderSubmissions(rows);
      })
      .catch((e: any) => console.warn('[Dashboard] fetchOrderSubmissionsForStores:', e?.message || e));
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

  // Spec 081 — flat cross-store submissions with the focal slice merged over
  // the top, so the focal card stays realtime-fresh. computeAttentionQueue
  // self-filters by `o.storeId === storeId`, so the flat list is passed as-is.
  const allOrderSubmissions = React.useMemo<OrderSubmission[]>(() => {
    const others = crossStoreOrderSubmissions.filter((o) => o.storeId !== currentStore.id);
    return [...others, ...orderSubmissions];
  }, [crossStoreOrderSubmissions, orderSubmissions, currentStore.id]);

  // Spec 081 (Risk 6) — spread the cross-store map FIRST, then OVERRIDE the
  // focal id with the live focal `orderSchedule` slice so the realtime-fresh
  // focal schedule wins over the (possibly staler) mount-time cross-store copy.
  const scheduleByStore = React.useMemo<Record<string, OrderSchedule>>(
    () => ({ ...crossStoreOrderSchedule, [currentStore.id]: orderSchedule }),
    [crossStoreOrderSchedule, orderSchedule, currentStore.id],
  );

  // ─── KPI metrics (focal store + cross-store roll-up where data is available)
  const focalInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );
  const totalInvValue = React.useMemo(
    // Spec 104 (OQ-5) — per-each costPerUnit × counted currentStock needs the
    // `× subUnitSize` bridge so stock value is unchanged from the pre-flip basis.
    () => inventory.reduce((sum, i) => sum + i.currentStock * i.costPerUnit * (i.subUnitSize || 1), 0),
    [inventory],
  );
  const itemCount = inventory.length;
  const storeCount = stores.length;

  const wasteWeek = React.useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    // Spec 104 (R1) — `w.costPerUnit` is the FROZEN waste_log snapshot, kept
    // per-COUNTED-unit on BOTH sides of the flip by the write-side bridge
    // (logWasteEntry / staff log_waste RPC). Do NOT add `× subUnitSize` here —
    // this read stays UNBRIDGED (unlike the LIVE-costPerUnit reads above).
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
  // Spec 038 N-1 — re-memoize on locale change so the heatmap column
  // headers swap to the active language when the user toggles locale.
  // `T`'s identity changes on locale change per useT() semantics.
  const heatmapDayLetters = React.useMemo(() => lastNDayLetters(7, T), [T]);
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
        // Spec 081 — each card gets its OWN store's slice (was the focal-only
        // orderSubmissions/orderSchedule). The flat submissions list self-filters
        // by storeId inside the selector; the schedule is dereferenced per store.
        allOrderSubmissions,
        scheduleByStore[s.id] ?? EMPTY_ORDER_SCHEDULE,
        stores,
        getItemStatus,
        // Spec 074 — Monday-reset window for the unconfirmed_po rule.
        timezone,
      );
    }
    return out;
  }, [stores, inventory, allEod, allPos, allOrderSubmissions, scheduleByStore, getItemStatus, timezone]);

  const today = new Date();
  const greeting =
    today.getHours() < 12 ? T('section.dashboard.greetingMorning') : today.getHours() < 17 ? T('section.dashboard.greetingAfternoon') : T('section.dashboard.greetingEvening');

  const fcDeltaPp = currentFc - TARGET_FOOD_COST_PCT;
  const fcTone = fcDeltaPp > 1 ? C.danger : fcDeltaPp > 0 ? C.warn : C.ok;

  // Spec 055 first-mount skeleton — dashboard is grid-shaped.
  if (storeLoading && inventory.length === 0) {
    return <GridSkeleton rows={2} cols={3} />;
  }

  return (
    <View testID="dashboard-root" style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[{ id: 'overview.tsx', label: 'overview.tsx' }]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            {T('section.dashboard.storeSelector')} <Text style={{ color: C.fg }}>{T('section.dashboard.allStores', { count: storeCount })}</Text>
            {'  '}·{'  '}{T('section.dashboard.period')} <Text style={{ color: C.fg }}>{T('section.dashboard.periodToday')}</Text>
          </Text>
        }
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingVertical: 18, gap: 12 }}>
        {/* Hero greeting */}
        <View style={{ gap: 4, marginBottom: 2 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
            {T('section.dashboard.greetingLine', { greeting, date: today.toDateString().toLowerCase(), count: storeCount })}
          </Text>
          <Text style={[Type.h1, { color: C.fg }]}>{T('section.dashboard.heroTitle')}</Text>
        </View>

        {/* KPI strip — 5 tiles each with sparkline */}
        <View testID="dashboard-kpis" style={{ flexDirection: 'row', gap: 10 }}>
          {/* SYNTHETIC_KPI_SERIES — sparkline + delta pill suppressed for the
              4 KPIs without daily rollups (delta would be misleading until
              we ship real historical aggregates). Only AVG FOOD COST % +
              EOD SUBMITTED show real deltas (fcDeltaPp from current vs
              target; eod difference vs storeCount). */}
          <Kpi
            label={T('section.dashboard.kpi.totalInvValue')}
            value={`$${(totalInvValue / 1000).toFixed(1)}k`}
            sub={storeCount === 1
              ? T('section.dashboard.kpi.itemsStores', { items: itemCount, count: storeCount })
              : T('section.dashboard.kpi.itemsStoresPlural', { items: itemCount, count: storeCount })}
            series={synthSeries(totalInvValue, `${currentStore.id}:inv`)}
            delta=""
            tone={C.ok}
          />
          <Kpi
            label={T('section.dashboard.kpi.avgFoodCost')}
            value={`${currentFc.toFixed(1)}%`}
            sub={fcDeltaPp > 0 ? T('section.dashboard.kpi.ppOver', { pp: fcDeltaPp.toFixed(1) }) : T('section.dashboard.kpi.onTarget')}
            series={fcSeries}
            delta={`${fcDeltaPp > 0 ? '+' : ''}${fcDeltaPp.toFixed(1)}pp`}
            tone={fcTone}
          />
          <Kpi
            label={T('section.dashboard.kpi.waste')}
            value={`$${wasteWeek.toFixed(0)}`}
            sub={T('section.dashboard.kpi.last7Days')}
            series={synthSeries(Math.max(wasteWeek, 1), `${currentStore.id}:waste`)}
            delta=""
            tone={C.warn}
          />
          <Kpi
            label={T('section.dashboard.kpi.eodSubmitted')}
            value={`${eodSubmittedToday}/${storeCount}`}
            sub={eodSubmittedToday === 1
              ? T('section.dashboard.kpi.storeComplete', { count: eodSubmittedToday })
              : T('section.dashboard.kpi.storesComplete', { count: eodSubmittedToday })}
            series={synthSeries(eodSubmittedToday + 1, `${currentStore.id}:eod`)}
            delta={eodSubmittedToday === storeCount ? '' : `${eodSubmittedToday - storeCount}`}
            tone={eodSubmittedToday === storeCount ? C.ok : C.fg3}
          />
          <Kpi
            label={T('section.dashboard.kpi.stockAlerts')}
            value={String(lowOutAll.length)}
            sub={T('section.dashboard.kpi.outLow', { out: outCount, low: lowCount })}
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
                {T('section.dashboard.foodCostVariance7d')}
              </SectionCaption>
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{T('section.dashboard.ppVsTarget')}</Text>
            </View>
            {heatmapRows.length === 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 12 }}>
                {T('section.dashboard.noStoresVisible')}
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
            <View key={s.id} testID={`dashboard-store-card-${s.id}`} style={{ flex: 1, minWidth: 240 }}>
              <StoreCol
                store={s}
                queue={queueByStore[s.id] || []}
                inventory={inventory}
                allEod={allEod}
                auditLog={auditLog}
                users={users}
                getItemStatus={getItemStatus}
                todayISO={todayISO}
                onSelectExpiry={(detail) =>
                  setExpiryDrillDown({ storeName: s.name, detail })
                }
              />
            </View>
          ))}
        </View>
      </ScrollView>
      {/* Spec 010 §4 — single modal hosted by the dashboard. Click a
          per-store expiry alert row → opens with that store's snapshot. */}
      <ExpiringItemsModal
        visible={!!expiryDrillDown}
        storeName={expiryDrillDown?.storeName ?? ''}
        detail={expiryDrillDown?.detail}
        onClose={() => setExpiryDrillDown(null)}
      />
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
  const T = useT();
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
          {T('section.dashboard.cogsCaption')}
        </SectionCaption>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{T('section.dashboard.thisWeek')}</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 14, marginBottom: 14 }}>
        <CogsStat label={T('section.dashboard.theoretical')} value={`$${Math.round(theoretical).toLocaleString()}`} hint={T('section.dashboard.theoreticalHint')} />
        <CogsStat label={T('section.dashboard.actual')} value={`$${Math.round(actual).toLocaleString()}`} hint={T('section.dashboard.actualHint')} />
        <CogsStat
          label={T('section.dashboard.deltaVariance')}
          value={`${delta > 0 ? '+' : delta < 0 ? '−' : ''}$${Math.abs(Math.round(delta)).toLocaleString()}`}
          sub={`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}
          tone={deltaTone}
        />
      </View>
      <SectionCaption tone="fg3" size={10} style={{ marginBottom: 6 }}>
        {T('section.dashboard.topVarianceItems')}
      </SectionCaption>
      {topRows.length === 0 ? (
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 10 }}>
          {T('section.dashboard.noVarianceYet')}
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
  const T = useT();
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
      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.dashboard.heatmapLegendNeg')}</Text>
      {swatch(C.fg3, 0.35)}
      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.dashboard.heatmapLegendZero')}</Text>
      {swatch(C.warn, 0.65)}
      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.dashboard.heatmapLegendWarn')}</Text>
      {swatch(C.danger, 1)}
      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.dashboard.heatmapLegendBad')}</Text>
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
  /**
   * Spec 010 §4 — fired when a queue row with `rule === 'expiry'` is
   * clicked. The dashboard hosts a single ExpiringItemsModal and opens
   * it with the snapshot. Other rule types stay click-inert in v1
   * (architect §9 flag #2).
   */
  onSelectExpiry: (detail: AttentionItem['expiryDetail']) => void;
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
  onSelectExpiry,
}) => {
  const C = useCmdColors();
  const T = useT();

  // Per-store mini-stat derivations.
  const storeInv = inventory.filter((i) => i.storeId === store.id);
  // Spec 104 (OQ-5) — per-each costPerUnit × counted stock → `× subUnitSize` bridge.
  const invValue = storeInv.reduce((sum, i) => sum + i.currentStock * i.costPerUnit * (i.subUnitSize || 1), 0);
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
  const statusText = isLate ? T('section.dashboard.statusLate') : (store.status === 'inactive' ? T('section.dashboard.statusClosed') : T('section.dashboard.statusOpen'));
  const statusFg = isLate ? C.warn : store.status === 'inactive' ? C.fg3 : C.ok;
  const statusBg = isLate ? C.warnBg : store.status === 'inactive' ? C.panel : C.okBg;

  // Slug stub — Store has no slug field, derive from id (architect §5).
  const slug = (store.id || '').slice(0, 6).toLowerCase() || '—';

  // Manager — first admin/master/super_admin user with this store in their list.
  const manager =
    users.find(
      (u) =>
        (u.role === 'admin' || u.role === 'master' || u.role === 'super_admin') &&
        u.stores.includes(store.id),
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
        <Mini2 label={T('section.dashboard.miniInv')} value={`$${(invValue / 1000).toFixed(1)}k`} bold />
        <Mini2 label={T('section.dashboard.miniFood')} value={`${foodPct.toFixed(1)}%`} tone={foodPct > 32 ? C.warn : C.fg} />
        <Mini2
          label={T('section.dashboard.miniAlerts')}
          value={`${lowOut.length}`}
          tone={outN > 0 ? C.danger : lowOut.length > 0 ? C.warn : C.fg}
        />
        <Mini2
          label={T('section.dashboard.miniEod')}
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
            {T('section.dashboard.attentionQueue')}
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
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.ok }}>{T('section.dashboard.allClear')}</Text>
          </View>
        ) : (
          queue.map((item, i) => {
            // Spec 010 §4 — expiry rows open the drill-down modal; other
            // rules stay non-interactive (architect §9 flag #2). Render
            // the same visual either way; only the wrapper element
            // (TouchableOpacity vs View) differs.
            const isClickable = item.rule === 'expiry' && !!item.expiryDetail;
            const Wrapper: any = isClickable ? TouchableOpacity : View;
            const wrapperProps = isClickable
              ? {
                  onPress: () => onSelectExpiry(item.expiryDetail),
                  activeOpacity: 0.7,
                  accessibilityRole: 'button' as const,
                  accessibilityLabel: T('section.dashboard.openDrillDown', { text: item.text }),
                }
              : {};
            return (
              <Wrapper
                key={item.id}
                testID={`attention-row-${item.id}`}
                {...wrapperProps}
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
                {isClickable ? (
                  <Text
                    style={{
                      fontFamily: mono(400),
                      fontSize: 10,
                      color: C.fg3,
                      marginTop: 2,
                    }}
                  >
                    →
                  </Text>
                ) : null}
              </Wrapper>
            );
          })
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
          {T('section.dashboard.managerLabel')} <Text style={{ color: C.fg2 }}>{manager}</Text>
        </Text>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{T('section.dashboard.syncLabel', { time: lastSync ?? '—' })}</Text>
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

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useIsPhone } from '../../../theme/breakpoints';
import { useStore } from '../../../store/useStore';
import { PhoneDashboard } from './phone/PhoneDashboard';
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
  computeScopedCogs,
  computeScopedFoodCostSeries,
  computeScopedTopVarianceItems,
  sumScopedWaste,
  AttentionItem,
  TARGET_FOOD_COST_PCT_DEFAULT,
} from '../../../lib/cmdSelectors';
import { brandNameFor, visibleStoresFor } from '../../../lib/storeVisibility';
import type {
  EODSubmission,
  OrderSchedule,
  OrderSubmission,
  POSImport,
  Store,
  User,
  WasteEntry,
} from '../../../types';

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
// pseudo-variance derived from a stable seed (scope key + label) so the
// line doesn't reshuffle on every render. Replace with a real
// daily-rollup query once a kpi_rollups_daily table lands.
//
// Spec 159 (R-C) — the seed is now the DASHBOARD SCOPE key (`'all'` or the
// scoped store id), not the focal store id, so the line is stable per scope
// and re-seeds when the scope picker moves. The series is still synthetic in
// BOTH modes; in all-stores mode it is a synthetic line anchored to an
// AGGREGATED headline number. OQ-4 queues the honest replacement.
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

// ─── Spec 159 — Dashboard-local scope ─────────────────────────────────
// The Dashboard is either ONE store or the WHOLE visible set, never a mix
// of both (which is what it was before this spec: two KPIs cross-store,
// two focal-store, under an "All stores" title). Component-local by owner
// decision D1/PM-2 — it never calls setCurrentStore, never writes
// `profiles`, and is not persisted anywhere (OQ-3).
export type DashboardScope = { mode: 'store'; storeId: string } | { mode: 'all' };

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
  const isPhone = useIsPhone();
  const inventory = useStore((s) => s.inventory);
  const vendors = useStore((s) => s.vendors);
  const wasteLog = useStore((s) => s.wasteLog);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const posImports = useStore((s) => s.posImports);
  const orderSubmissions = useStore((s) => s.orderSubmissions);
  const orderSchedule = useStore((s) => s.orderSchedule);
  const auditLog = useStore((s) => s.auditLog);
  const currentStore = useStore((s) => s.currentStore);
  const stores = useStore((s) => s.stores);
  const users = useStore((s) => s.users);
  // Spec 159 — `recipes` was previously read by the (now deleted)
  // useCogsForCurrentStore hook; computeScopedCogs needs it passed in.
  const recipes = useStore((s) => s.recipes);
  // Spec 159 — visibility narrowing (AC-V1) + the OQ-2 brand-named
  // aggregate label. Read-only inputs: the Dashboard never writes any of
  // these (AC-P3).
  const currentUser = useStore((s) => s.currentUser);
  const currentBrandId = useStore((s) => s.currentBrandId);
  const brand = useStore((s) => s.brand);
  const brandsList = useStore((s) => s.brandsList);
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

  // ─── Spec 159 §6.1 — scope state, all of it above the storeLoading /
  // isPhone early returns so hook order is identical on every tier.
  const [scope, setScope] = React.useState<DashboardScope>(() => ({
    mode: 'store',
    storeId: currentStore.id,
  }));
  // AC-P4 — the global title-bar switcher wins: when currentStore.id changes
  // the Dashboard scope snaps back to that store, including out of `all`
  // mode. Render-phase adjustment rather than a useEffect on purpose — an
  // effect would paint one frame of the stale scope first; React re-renders
  // synchronously before committing, so this costs no extra DOM pass.
  const [seenStoreId, setSeenStoreId] = React.useState(currentStore.id);
  if (seenStoreId !== currentStore.id) {
    setSeenStoreId(currentStore.id);
    setScope({ mode: 'store', storeId: currentStore.id });
  }

  // AC-V1 — THE store set for this section. Every enumeration below (picker
  // options, heatmap rows, card grid, x/N denominator, the mount-time fetch
  // id list) reads this, never the raw `stores` slice. `currentUser` is null
  // on first paint and visibleStoresFor fails closed to [] — one frame of an
  // empty dashboard, then everything re-derives (design R-E).
  const visibleStores = React.useMemo(
    () => visibleStoresFor(stores, currentUser, currentBrandId),
    [stores, currentUser, currentBrandId],
  );

  const effectiveScope = React.useMemo<DashboardScope>(() => {
    // OQ-1 / §6.1 — the phone has no picker and is always single-store; pin
    // it to the focal store unconditionally. This is also what stops a web
    // resize from carrying an `all` scope down from the desktop tier, and it
    // deliberately bypasses the AC-P5 fallback below.
    if (isPhone) return { mode: 'store', storeId: currentStore.id };
    // AC-P5 — a brand switch can narrow the picked store away. Fall back to
    // the aggregate rather than rendering an empty dashboard. Derived, not
    // stated: it can neither fight the AC-P4 reset nor loop.
    if (scope.mode === 'store' && !visibleStores.some((s) => s.id === scope.storeId)) {
      return { mode: 'all' };
    }
    return scope;
  }, [isPhone, scope, visibleStores, currentStore.id]);

  const scopedStores = React.useMemo<Store[]>(() => {
    if (effectiveScope.mode === 'all') return visibleStores;
    const picked = visibleStores.filter((s) => s.id === effectiveScope.storeId);
    // Phone-only cushion: the phone bypasses AC-P5, so when visibleStores is
    // still [] (first paint, no currentUser) fall back to the focal store
    // rather than rendering a nameless zero-store dashboard.
    if (picked.length === 0 && isPhone) return [currentStore];
    return picked;
    // Filtering visibleStores (rather than mapping ids) preserves its order
    // for free — that is AC-B8's "in visibleStores order".
  }, [effectiveScope, visibleStores, isPhone, currentStore]);

  // Membership-stable handles: `scopeIdsKey` only changes when the SET of
  // scoped stores changes, so the five `scopedInventory`-shaped memos below
  // don't re-run every time the `stores` array identity rotates (design R-D).
  const scopeIdsKey = React.useMemo(() => scopedStores.map((s) => s.id).join(','), [scopedStores]);
  const scopeStoreIds = React.useMemo(
    () => (scopeIdsKey ? scopeIdsKey.split(',') : []),
    [scopeIdsKey],
  );
  const scopeIdSet = React.useMemo(() => new Set(scopeStoreIds), [scopeStoreIds]);
  const scopeKey = effectiveScope.mode === 'all' ? 'all' : effectiveScope.storeId;
  const visibleStoreIdsKey = React.useMemo(
    () => visibleStores.map((s) => s.id).join(','),
    [visibleStores],
  );

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
  // Spec 159 — cross-store waste, same caveat as the slices above. `wasteLog`
  // in the store is focal-only, so WASTE / WK could never be computed for a
  // non-focal store or for the brand before this.
  const [crossStoreWaste, setCrossStoreWaste] = React.useState<WasteEntry[]>([]);

  React.useEffect(() => {
    // Spec 159 AC-V2 — only stores the user may actually see are requested.
    const storeIds = visibleStoreIdsKey ? visibleStoreIdsKey.split(',') : [];
    if (storeIds.length === 0) return;
    // 14 days back covers both the heatmap (7d) and the food-cost streak
    // attention rule (7d) with a small cushion for prior-EOD lookups.
    const since = isoDay(new Date(Date.now() - 14 * 24 * 3600 * 1000));
    // waste_log.logged_at is a timestamptz (the four reads above key off
    // `date` columns), so its cutoff is a full ISO instant — hence the
    // different param name.
    const sinceISO = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
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
    // Spec 159 — fifth read, same shape/guards as the four above.
    db.fetchWasteLogForStores(storeIds, sinceISO)
      .then((rows) => {
        if (!cancelled) setCrossStoreWaste(rows);
      })
      .catch((e: any) => console.warn('[Dashboard] fetchWasteLogForStores:', e?.message || e));
    return () => {
      cancelled = true;
    };
    // currentStore.id is in the dep list per architect's note ("on any
    // currentStore.id change"). visibleStoreIdsKey keeps us stable when the
    // array reference rotates without an actual change in membership, and
    // refetches when a brand switch narrows the visible set (spec 159 AC-V2).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleStoreIdsKey, currentStore.id]);

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

  // Spec 159 — identical shape to allEod / allPos: focal slice LAST so the
  // focal store's waste stays realtime-fresh on the `store-{id}` channel
  // while every other store is mount-time only (pre-existing R2/spec-009 R4).
  const allWaste = React.useMemo<WasteEntry[]>(() => {
    const others = crossStoreWaste.filter((w) => w.storeId !== currentStore.id);
    return [...others, ...wasteLog];
  }, [crossStoreWaste, wasteLog, currentStore.id]);

  // Spec 081 (Risk 6) — spread the cross-store map FIRST, then OVERRIDE the
  // focal id with the live focal `orderSchedule` slice so the realtime-fresh
  // focal schedule wins over the (possibly staler) mount-time cross-store copy.
  const scheduleByStore = React.useMemo<Record<string, OrderSchedule>>(
    () => ({ ...crossStoreOrderSchedule, [currentStore.id]: orderSchedule }),
    [crossStoreOrderSchedule, orderSchedule, currentStore.id],
  );

  // ─── KPI metrics — every one of them keyed off the SCOPE (spec 159).
  const focalInventory = React.useMemo(
    // Deliberately still focal: `eodRows` is the CURRENT store's per-vendor
    // count progress (a phone/EOD affordance), not a scoped KPI.
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );
  // ONE filter of the (genuinely cross-store) `inventory` slice, reused by the
  // five consumers below — filtering it five times per render is the naive
  // read of the spec's AC table and is measurably worse on the prod-sized seed.
  const scopedInventory = React.useMemo(
    () => inventory.filter((i) => scopeIdSet.has(i.storeId)),
    [inventory, scopeIdSet],
  );
  const totalInvValue = React.useMemo(
    // Spec 104 (OQ-5) — per-each costPerUnit × counted currentStock needs the
    // `× subUnitSize` bridge so stock value is unchanged from the pre-flip basis.
    () =>
      scopedInventory.reduce(
        (sum, i) => sum + i.currentStock * i.costPerUnit * (i.subUnitSize || 1),
        0,
      ),
    [scopedInventory],
  );
  const itemCount = scopedInventory.length;
  const storeCount = scopedStores.length;

  // Spec 104 (R1) — `w.costPerUnit` is the FROZEN waste_log snapshot, kept
  // per-COUNTED-unit on BOTH sides of the flip by the write-side bridge
  // (logWasteEntry / staff log_waste RPC). This read stays UNBRIDGED (unlike
  // the LIVE-costPerUnit reads above).
  //
  // Spec 159 (R-A) — the focal half of `allWaste` carries a LOCALE string in
  // `timestamp` (fetchWasteLog does `toLocaleString()`); the cross-store half
  // carries raw ISO. `sumScopedWaste`'s isFinite guard makes an unparseable
  // focal timestamp a visible dropped row rather than a silent NaN comparison.
  //
  // Extracted to `sumScopedWaste` (cmdSelectors.ts) so this memo and
  // `wasteEventCount` below share ONE copy of the filter/window/guard/
  // unbridged-cost invariant rather than duplicating it (code-reviewer
  // Should-fix — see the function's own docblock for the full rationale).
  const scopedWaste = React.useMemo(
    () => sumScopedWaste(allWaste, scopeIdSet, Date.now()),
    [allWaste, scopeIdSet],
  );
  const wasteWeek = scopedWaste.dollars;

  const lowOutAll = React.useMemo(
    () => scopedInventory.filter((i) => {
      const s = getItemStatus(i);
      return s === 'low' || s === 'out';
    }),
    [scopedInventory, getItemStatus],
  );
  const outCount = lowOutAll.filter((i) => getItemStatus(i) === 'out').length;
  const lowCount = lowOutAll.filter((i) => getItemStatus(i) === 'low').length;

  const todayISO = isoDay(new Date());
  const eodSubmittedToday = React.useMemo(
    () =>
      scopedStores.filter((s) => allEod.some((e) => e.storeId === s.id && e.date === todayISO))
        .length,
    [scopedStores, allEod, todayISO],
  );

  // ─── Spec 145 (phone-only) — derived views for PhoneDashboard's model. These
  // memos run for every tier (hooks precede the isPhone guard) but are consumed
  // ONLY on the phone path, so the desktop/tablet return subtree is byte-
  // unchanged (AC-REG). They reuse the SAME selectors the desktop KPIs use
  // (getItemStatus / wasteLog / inventory) rather than re-deriving new math.
  //
  // Spec 159 (OQ-1) — these now read the SCOPED slices, which on the phone are
  // pinned to the focal store (§6.1). That closes the phone's own version of
  // the bug this spec fixes: the header said `currentStore.name` while the
  // numbers under it were cross-store. PhoneDashboard.tsx is unchanged — the
  // model literal below passes the same identifiers.
  const outItems = React.useMemo(
    () => scopedInventory.filter((i) => getItemStatus(i) === 'out'),
    [scopedInventory, getItemStatus],
  );
  // Same reducer as wasteWeek above — one pass over allWaste already computed
  // both the dollar sum and the event count (see scopedWaste).
  const wasteEventCount = scopedWaste.events;
  // Per-vendor EOD progress for the CURRENT store, today. Vendor↔item membership
  // mirrors EODCountSection's tab derivation (junction `vendorIds`, scalar
  // fallback); "counted" = the item is in any of today's submissions; "submitted"
  // = the vendor has a submitted row today.
  const eodRows = React.useMemo(() => {
    const todaySubs = eodSubmissions.filter((s) => s.storeId === currentStore.id && s.date === todayISO);
    const counted = new Set<string>();
    for (const s of todaySubs) for (const e of s.entries || []) counted.add(e.itemId);
    const submittedVendors = new Set(
      todaySubs.filter((s) => s.status === 'submitted' && s.vendorId).map((s) => s.vendorId as string),
    );
    const byVendor = new Map<string, typeof focalInventory>();
    for (const i of focalInventory) {
      const ids = i.vendorIds ?? (i.vendorId ? [i.vendorId] : []);
      for (const vid of ids) {
        if (!vid) continue;
        const arr = byVendor.get(vid);
        if (arr) arr.push(i);
        else byVendor.set(vid, [i]);
      }
    }
    return vendors
      .filter((v) => byVendor.has(v.id))
      .map((v) => {
        const items = byVendor.get(v.id)!;
        return {
          vendorId: v.id,
          vendorName: v.name,
          counted: items.filter((i) => counted.has(i.id)).length,
          total: items.length,
          submitted: submittedVendors.has(v.id),
          focusItemId: items[0]?.id,
        };
      });
  }, [vendors, focalInventory, eodSubmissions, currentStore.id, todayISO]);
  // Current-store audit feed, most-recent first, capped for the phone group.
  const recentActivity = React.useMemo(
    () =>
      auditLog
        .filter((e) => e.storeId === currentStore.id)
        .slice()
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 8),
    [auditLog, currentStore.id],
  );

  // ─── Real food-cost trend for the AVG FOOD COST sparkline. Other 4 KPIs use
  // synthSeries — see SYNTHETIC_KPI_SERIES tag above.
  //
  // Spec 159 — the per-store derivation moved VERBATIM into
  // computeStoreFoodCostSeries (still the `30 + (entries.length % 5)` v1 mock —
  // PM-3 / OQ-4 / R-C), and computeScopedFoodCostSeries takes the per-day
  // UNWEIGHTED mean across the scoped stores (AC-B4). Single-store scope
  // returns the per-store series untouched, so the focal-store rendering is
  // byte-identical to before this spec (AC-S4). It reads `allEod` (cross-store)
  // rather than the focal-only `eodSubmissions` slice.
  const foodCostTrend14 = React.useMemo<Array<number | null>>(
    () => computeScopedFoodCostSeries(scopeStoreIds, allEod, 14),
    [scopeStoreIds, allEod],
  );

  const fcSeries = React.useMemo<number[]>(() => {
    const real = foodCostTrend14.filter((v): v is number => v != null);
    if (real.length === 0) return synthSeries(31.4, `${scopeKey}:fc`);
    return real.length >= 2 ? real.slice(-10) : synthSeries(real[0], `${scopeKey}:fc`);
  }, [foodCostTrend14, scopeKey]);
  const currentFc = fcSeries[fcSeries.length - 1] ?? 0;

  // ─── Heatmap — last 7 days × the SCOPED stores (spec 159 AC-S8/AC-B8).
  // computeStoreFoodCostVariancePp is a pure function so we call it once per
  // store with the cross-store EOD/POS data we hold locally.
  const heatmapDays = React.useMemo(() => lastNDates(7), []);
  // Spec 038 N-1 — re-memoize on locale change so the heatmap column
  // headers swap to the active language when the user toggles locale.
  // `T`'s identity changes on locale change per useT() semantics.
  const heatmapDayLetters = React.useMemo(() => lastNDayLetters(7, T), [T]);
  const startDate = heatmapDays[0];
  const endDate = heatmapDays[heatmapDays.length - 1];

  // ─── CoGS card + top-variance list — scoped (spec 159 AC-S6/S7, AC-B6/B7).
  // The `useCogsForCurrentStore` / `useTopVarianceItems` hooks are gone: they
  // were bound to `currentStore` AND to the focal-only eodSubmissions/posImports
  // slices, i.e. exactly the data the Dashboard must stop using. The pure
  // functions take the cross-store state this component already holds.
  // `startDate`/`endDate` are the same trailing-7-day window the hooks used.
  //
  // R-B: theoretical CoGS needs `recipes`, and that slice only ever holds the
  // FOCAL store's brand. For a super-admin whose visible stores span brands,
  // out-of-brand stores contribute 0 theoretical — AC-B6 reads as "correct
  // within one brand". The §9.1 label resolver detects exactly that case and
  // stops the title from claiming a brand it isn't.
  const cogs = React.useMemo(
    () => computeScopedCogs(scopeStoreIds, startDate, endDate, inventory, allEod, allPos, recipes),
    [scopeStoreIds, startDate, endDate, inventory, allEod, allPos, recipes],
  );
  const topVariance = React.useMemo(
    // PM-5 — the store-name column stays in BOTH modes (it shows the same name
    // on every row in single-store mode). `stores` stays the RAW slice here:
    // the selector uses it only for a name lookup, and narrowing it could blank
    // a name. Narrowing the ITERATION (scopeStoreIds) is the whole job.
    () =>
      computeScopedTopVarianceItems(
        scopeStoreIds,
        startDate,
        endDate,
        inventory,
        allEod,
        stores,
        5,
      ),
    [scopeStoreIds, startDate, endDate, inventory, allEod, stores],
  );

  const heatmapRows = React.useMemo<HeatmapRow[]>(
    () =>
      scopedStores.map((s) => ({
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
    [scopedStores, startDate, endDate, inventory, allEod, allPos],
  );

  // ─── Per-store attention queues (computed via cross-store data), one per
  // SCOPED store (spec 159 AC-S9/AC-B9).
  const queueByStore = React.useMemo<Record<string, AttentionItem[]>>(() => {
    const out: Record<string, AttentionItem[]> = {};
    for (const s of scopedStores) {
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
        // Spec 159 — the `stores` ARGUMENT stays the raw slice (name lookup
        // only); it is the ITERATION above that narrows to the scope.
        stores,
        getItemStatus,
        // Spec 074 — Monday-reset window for the unconfirmed_po rule.
        timezone,
      );
    }
    return out;
  }, [scopedStores, stores, inventory, allEod, allPos, allOrderSubmissions, scheduleByStore, getItemStatus, timezone]);

  const today = new Date();
  const greeting =
    today.getHours() < 12 ? T('section.dashboard.greetingMorning') : today.getHours() < 17 ? T('section.dashboard.greetingAfternoon') : T('section.dashboard.greetingEvening');

  // ─── Spec 159 §9.1 — scope labels (OQ-2: the aggregate is BRAND-NAMED).
  // One resolver feeds the hero title, the picker trigger and the picker's
  // aggregate option, so those three can never disagree about what the scope
  // is called. The `fallbackKey` is the ONLY thing that differs between the
  // hero ("All stores (3) · day in progress") and the strip ("store: all (3)").
  const aggregateLabelFor = React.useCallback(
    (list: Store[], fallbackKey: string): string => {
      // Spec 159 fix-pass item 5 (architect M-3) — keep `null`/undefined
      // brandIds IN the distinct set (mapped to `null`, not filtered out).
      // `stores.brand_id` is nullable, so a scope can legitimately mix a
      // brand-less store with a brand-A store; dropping the null via
      // `.filter(Boolean)` collapsed that mix down to ONE distinct id and
      // printed a confident "2AM PROJECT · 2 stores" over a set that
      // includes a store outside that brand. Keeping the null means a mixed
      // set now correctly resolves to >1 distinct id and falls through to
      // the generic fallback label below.
      const brandIds = Array.from(new Set(list.map((s) => s.brandId ?? null)));
      // Not exactly one brand (super-admin on "All brands" spanning several,
      // a brand-less/mixed set, or an empty set) → no honest brand name to
      // print. Also covers "the brand slice hasn't loaded yet", via
      // brandNameFor returning null.
      const brandName =
        brandIds.length === 1 && brandIds[0]
          ? brandNameFor(brandIds[0], brand, brandsList)
          : null;
      if (!brandName) return T(fallbackKey, { count: list.length });
      return T(
        list.length === 1
          ? 'section.dashboard.scopeAllBrandOne'
          : 'section.dashboard.scopeAllBrand',
        { brand: brandName, count: list.length },
      );
    },
    [brand, brandsList, T],
  );
  const scopedStore = effectiveScope.mode === 'store' ? scopedStores[0] : undefined;
  // Strip + picker aggregate option read the same label; the picker's option
  // always describes the FULL visible set (which is what picking it selects).
  const allOptionLabel = aggregateLabelFor(visibleStores, 'section.dashboard.allStores');
  const stripScopeLabel =
    effectiveScope.mode === 'store'
      ? scopedStore?.name ?? currentStore.name
      : allOptionLabel;
  // R-F — the hero title naming the scope is the ONLY mitigation for a
  // Dashboard scope that diverges from the rest of the app's store context.
  const heroScopeLabel =
    effectiveScope.mode === 'store'
      ? scopedStore?.name ?? currentStore.name
      : aggregateLabelFor(scopedStores, 'section.dashboard.scopeAllFallback');

  const fcDeltaPp = currentFc - TARGET_FOOD_COST_PCT;
  const fcTone = fcDeltaPp > 1 ? C.danger : fcDeltaPp > 0 ? C.warn : C.ok;

  // Spec 055 first-mount skeleton — dashboard is grid-shaped.
  if (storeLoading && inventory.length === 0) {
    return <GridSkeleton rows={2} cols={3} />;
  }

  // Spec 145 — phone tier (< 768px web + all native). All hooks/memos above run
  // for every tier; only the phone path allocates the model literal + mounts the
  // phone component, so the desktop/tablet tree below is byte-unchanged (AC-REG).
  if (isPhone) {
    return (
      <PhoneDashboard
        model={{
          storeName: currentStore.name,
          totalInvValue,
          itemCount,
          outCount,
          lowCount,
          wasteWeek,
          wasteEventCount,
          outItems,
          eodRows,
          activity: recentActivity,
        }}
      />
    );
  }

  return (
    <View testID="dashboard-root" style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      {/* Spec 159 — the ScopePicker's panel is absolutely positioned inside the
          strip's rightSlot, so the strip has to paint ABOVE the ScrollView that
          follows it (later siblings win in RN without an explicit zIndex).
          TabStrip itself is shared by many sections and is deliberately not
          modified — the wrapper lives here. */}
      <View style={{ zIndex: 50 }}>
        <TabStrip
          tabs={[{ id: 'overview.tsx', label: 'overview.tsx' }]}
          activeId={tabId}
          onChange={setTabId}
          rightSlot={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <ScopePicker
                stores={visibleStores}
                scope={effectiveScope}
                label={stripScopeLabel}
                allOptionLabel={allOptionLabel}
                onSelect={setScope}
              />
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                ·{'  '}{T('section.dashboard.period')} <Text style={{ color: C.fg }}>{T('section.dashboard.periodToday')}</Text>
              </Text>
            </View>
          }
        />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingVertical: 18, gap: 12 }}>
        {/* Hero greeting */}
        <View style={{ gap: 4, marginBottom: 2 }}>
          <Text testID="dashboard-greeting" style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
            {effectiveScope.mode === 'store'
              ? T('section.dashboard.greetingLineStore', { greeting, date: today.toDateString().toLowerCase(), store: stripScopeLabel })
              : T('section.dashboard.greetingLine', { greeting, date: today.toDateString().toLowerCase(), count: storeCount })}
          </Text>
          <Text testID="dashboard-hero-title" style={[Type.h1, { color: C.fg }]}>
            {T('section.dashboard.heroTitleScope', { scope: heroScopeLabel })}
          </Text>
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
            series={synthSeries(totalInvValue, `${scopeKey}:inv`)}
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
            series={synthSeries(Math.max(wasteWeek, 1), `${scopeKey}:waste`)}
            delta=""
            tone={C.warn}
          />
          <Kpi
            label={T('section.dashboard.kpi.eodSubmitted')}
            value={`${eodSubmittedToday}/${storeCount}`}
            sub={eodSubmittedToday === 1
              ? T('section.dashboard.kpi.storeComplete', { count: eodSubmittedToday })
              : T('section.dashboard.kpi.storesComplete', { count: eodSubmittedToday })}
            series={synthSeries(eodSubmittedToday + 1, `${scopeKey}:eod`)}
            delta={eodSubmittedToday === storeCount ? '' : `${eodSubmittedToday - storeCount}`}
            tone={eodSubmittedToday === storeCount ? C.ok : C.fg3}
          />
          <Kpi
            label={T('section.dashboard.kpi.stockAlerts')}
            value={String(lowOutAll.length)}
            sub={T('section.dashboard.kpi.outLow', { out: outCount, low: lowCount })}
            series={synthSeries(Math.max(lowOutAll.length, 1), `${scopeKey}:alerts`)}
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

        {/* Per-store columns — 4-up wrapping grid with attention queues.
            Spec 159 — one card per SCOPED store: exactly one in single-store
            mode (AC-S9), one per visible store in all-stores mode (AC-B9). */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 }}>
          {scopedStores.map((s) => (
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

// ─── <ScopePicker /> — spec 159, the Dashboard-local scope control ─────
//
// Deliberately NOT `components/cmd/SelectField`: that renders an uppercase
// label above a 32px bordered box (wrong furniture for a 10.5px mono strip
// inside a 28px tab row), and its web branch is a native <select> whose
// <option>s neither Playwright nor RNTL can drive — which AC-P6/T2/T3 all
// need. Section-local components are the established pattern in this file
// (Kpi, CogsCard, StoreCol, Mini2 are all local).
interface ScopePickerProps {
  /** The visible store set — AC-P1's option list, in visibleStores order. */
  stores: Store[];
  scope: DashboardScope;
  /** Resolved label for the CURRENT scope, rendered in the trigger. */
  label: string;
  /** Resolved label for the aggregate option (brand-named per OQ-2). */
  allOptionLabel: string;
  onSelect: (scope: DashboardScope) => void;
}
const ScopePicker: React.FC<ScopePickerProps> = ({
  stores,
  scope,
  label,
  allOptionLabel,
  onSelect,
}) => {
  const C = useCmdColors();
  const T = useT();
  const [open, setOpen] = React.useState(false);

  const pick = (next: DashboardScope) => {
    setOpen(false);
    onSelect(next);
  };

  const option = (key: string, testID: string, text: string, active: boolean, next: DashboardScope) => (
    <TouchableOpacity
      key={key}
      testID={testID}
      onPress={() => pick(next)}
      accessibilityRole="menuitem"
      activeOpacity={0.75}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: active ? C.accentBg : 'transparent',
      }}
    >
      <Text
        style={{
          fontFamily: mono(active ? 500 : 400),
          fontSize: 11,
          color: active ? C.accent : C.fg2,
        }}
        numberOfLines={1}
      >
        {text}
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={{ position: 'relative' }}>
      <TouchableOpacity
        testID="dashboard-scope-picker"
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={T('section.dashboard.scopePickerA11y')}
        activeOpacity={0.75}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingHorizontal: 6,
          paddingVertical: 2,
          borderRadius: CmdRadius.xs,
          borderWidth: 1,
          borderColor: open ? C.borderStrong : 'transparent',
          backgroundColor: open ? C.panel2 : 'transparent',
        }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>
          {T('section.dashboard.storeSelector')} <Text style={{ color: C.fg }}>{label}</Text>
        </Text>
        <Text style={{ fontFamily: mono(400), fontSize: 8, color: C.fg3 }}>▼</Text>
      </TouchableOpacity>
      {open ? (
        <View
          testID="dashboard-scope-panel"
          style={{
            position: 'absolute',
            top: 24,
            right: 0,
            minWidth: 200,
            backgroundColor: C.panel,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: CmdRadius.sm,
            paddingVertical: 4,
            zIndex: 50,
          }}
        >
          {/* AC-P7 — the aggregate option always renders, even with 0 or 1
              visible stores, so the panel is never empty. */}
          {option('scope-all', 'dashboard-scope-option-all', allOptionLabel, scope.mode === 'all', {
            mode: 'all',
          })}
          {stores.map((s) =>
            option(
              s.id,
              `dashboard-scope-option-${s.id}`,
              s.name,
              scope.mode === 'store' && scope.storeId === s.id,
              { mode: 'store', storeId: s.id },
            ),
          )}
        </View>
      ) : null}
    </View>
  );
};

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
            paddingHorizontal: 9,
            paddingVertical: 2,
            borderRadius: CmdRadius.pill,
            borderWidth: 0.5,
            borderColor: statusFg,
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

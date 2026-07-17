// src/screens/staff/screens/EODCount.tsx — the EOD count screen.
//
// Spec 062 §B5 + §B6 + §B7. Header (store + today's date), vendor
// switcher (only if today's order_schedule lists >1 vendor),
// scrollable item list with decimal-pad inputs, submit button,
// pre-fill banner from any existing submission for
// (active_store_id, today, selected_vendor_id).
//
// Vendor logic: spec 062's "vendor_day_filter" is the order_schedule
// table from spec 007 — rows at (store_id, day_of_week, vendor_id) for
// today's weekday. We query directly.
//
// Date is captured at SUBMIT time, not mount time (§11 risk (c)):
// EODCount reads the today_iso string in onSubmit, not at first
// render.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { ListRow } from '../components/ListRow';
import { IngredientThumb } from '../components/IngredientThumb';
import { SettingsGear } from '../components/SettingsGear';
import { NotificationReminderBanner } from '../components/NotificationReminderBanner';
import { QueueIndicator } from '../components/QueueIndicator';
import { CountOrderDragList } from '../components/CountOrderDragList';
import { supabase } from '../../../lib/supabase';
import { notifyBackendError } from '../lib/notifyBackendError';
import {
  applyCountOrder,
  firstUncounted,
  fetchCountOrder,
  saveCountOrder,
  resetCountOrder,
} from '../lib/countOrder';
import { todayIso } from '../lib/date';
import { fetchYesterdayIncomplete } from '../lib/yesterdayStatus';
import { currentStaffUserId, useStaffStore } from '../store/useStaffStore';
import { useEodSubmit } from '../hooks/useEodSubmit';
import { t, useI18n } from '../i18n';
import { getLocalizedName } from '../../../i18n/localizedName';
import { matchesQuery } from '../../../i18n/matchesQuery';
import type { LocalizedNames } from '../../../types';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../theme';
import type { EodEntry, EodItem, ExistingSubmission, Vendor } from '../lib/types';

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function todayWeekday(d = new Date()): string {
  return WEEKDAYS[d.getDay()];
}

// Takes a `t` so the caller can pass the reactive `useI18n()` t (spec
// 099) — the header label must re-translate when the locale changes. The
// `key` selects the Today vs Yesterday prefix (a late/back-dated count
// shows "Yesterday · …" rather than "Today · …").
function todayHeaderLabel(
  tt: typeof t,
  d = new Date(),
  key: string = 'eod.header.today',
): string {
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return tt(key, { weekday, monthDay });
}

function submittedAtHHMM(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

// ── data fetch helpers ───────────────────────────────────────────

async function fetchVendorsForToday(
  storeId: string,
  dayOfWeek: string,
): Promise<Vendor[]> {
  // order_schedule has (store_id, day_of_week, vendor_id, vendor_name).
  // Read schedule rows; join the vendors table to get the canonical
  // name (vendor_name on order_schedule is a denormalized snapshot).
  const { data, error } = await supabase
    .from('order_schedule')
    .select('vendor_id, vendor_name, vendor:vendors(id, name)')
    .eq('store_id', storeId)
    .eq('day_of_week', dayOfWeek);
  if (error) throw error;
  type Row = {
    vendor_id: string | null;
    vendor_name: string | null;
    vendor: { id: string; name: string } | { id: string; name: string }[] | null;
  };
  const rows = (data ?? []) as Row[];
  const out: Vendor[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const v = Array.isArray(r.vendor) ? r.vendor[0] : r.vendor;
    const id = v?.id ?? r.vendor_id;
    const name = v?.name ?? r.vendor_name ?? '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

async function fetchItemsForVendor(
  storeId: string,
  vendorId: string,
): Promise<EodItem[]> {
  // Spec 102 (§6d) — items the vendor can be counted under are now defined
  // by the `item_vendors` junction (a shared item links to N vendors), NOT
  // the single `inventory_items.vendor_id` scalar. Query item_vendors for
  // this vendor, embedding the inventory item (inner-joined so only this
  // store's items come back) + its catalog row for the canonical display
  // name + unit + units-per-case (`case_qty`) the Cases input converts with
  // (spec 086). A shared item assigned to this scheduled vendor now returns
  // here (AC-E); the shared on-hand is reconciled server-side by
  // staff_submit_eod's junction-membership write (§5b).
  const { data, error } = await supabase
    .from('item_vendors')
    .select(
      'vendor_id, item:inventory_items!inner(id, store_id, catalog:catalog_ingredients(name, unit, case_qty, i18n_names, image_path))',
    )
    .eq('vendor_id', vendorId)
    .eq('item.store_id', storeId)
    .order('item_id', { ascending: true });
  if (error) throw error;
  type CatalogRow = {
    name: string | null;
    unit: string | null;
    case_qty: number | string | null;
    i18n_names: LocalizedNames | null;
    // Spec 127 — brand-level photo object path (nullable).
    image_path: string | null;
  };
  type ItemRow = {
    id: string;
    store_id: string | null;
    catalog: CatalogRow | CatalogRow[] | null;
  };
  type Row = {
    vendor_id: string | null;
    item: ItemRow | ItemRow[] | null;
  };
  const rows = (data ?? []) as Row[];
  return rows.flatMap((r) => {
    const item = Array.isArray(r.item) ? r.item[0] : r.item;
    if (!item) return [];
    const c = Array.isArray(item.catalog) ? item.catalog[0] : item.catalog;
    return [
      {
        // `id` is the inventory item id (unchanged shape); `vendorId` is the
        // selected (scheduled) vendor from the junction row.
        id: item.id,
        vendorId: r.vendor_id,
        name: c?.name ?? '',
        unit: c?.unit ?? '',
        // Preserve null (the admin collapses to 1 at hydration; we keep
        // the distinction and apply `|| 1` at the conversion site).
        caseQty: c?.case_qty == null ? null : Number(c.case_qty),
        // Per-locale name overrides — null/missing → undefined so
        // getLocalizedName falls back to the English `name`.
        i18nNames: c?.i18n_names ?? undefined,
        // Spec 127 — brand-level photo path; null → placeholder thumbnail.
        imagePath: c?.image_path ?? null,
      },
    ];
  });
}

async function fetchExistingSubmission(
  storeId: string,
  dateIso: string,
  vendorId: string,
): Promise<ExistingSubmission | null> {
  const { data, error } = await supabase
    .from('eod_submissions')
    .select(
      'id, submitted_at, eod_entries(item_id, actual_remaining, actual_remaining_cases, actual_remaining_each)',
    )
    .eq('store_id', storeId)
    .eq('date', dateIso)
    .eq('vendor_id', vendorId)
    .maybeSingle();
  if (error) {
    // maybeSingle returns 406 if >1 rows match — log and treat as
    // no-existing.
    if ((error as { code?: string }).code === 'PGRST116') return null;
    throw error;
  }
  if (!data) return null;
  type EntryRow = {
    item_id: string;
    actual_remaining: number | string | null;
    actual_remaining_cases: number | string | null;
    actual_remaining_each: number | string | null;
  };
  type Row = {
    id: string;
    submitted_at: string;
    eod_entries: EntryRow[];
  };
  const row = data as Row;
  // Map straight to the new 3-field shape. The legacy-row fallback
  // (units ← actual_remaining when actual_remaining_each is NULL) is
  // applied at the SCREEN seed step (per OQ-4), not here, so this stays
  // a faithful read of what the DB holds.
  const entries: EodEntry[] = (row.eod_entries ?? []).map((e) => ({
    item_id: e.item_id,
    actual_remaining: e.actual_remaining == null ? 0 : Number(e.actual_remaining),
    actual_remaining_cases:
      e.actual_remaining_cases == null ? null : Number(e.actual_remaining_cases),
    actual_remaining_each:
      e.actual_remaining_each == null ? null : Number(e.actual_remaining_each),
  }));
  return {
    submission_id: row.id,
    submitted_at: row.submitted_at,
    entries,
  };
}

// ── screen ───────────────────────────────────────────────────────

export function EODCount() {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  // 2026-07 — jump to the Reorder tab after a successful submit so staff both
  // see the count landed AND land on the list it feeds.
  const navigation = useNavigation<any>();
  // Reactive `t` (spec 099) — every render-path string below uses this so
  // the screen re-renders and re-translates on a locale change.
  const { t } = useI18n();
  // Reactive locale slice — item names are resolved via
  // getLocalizedName(item, locale), so reading the slice directly re-renders
  // the list labels on a locale switch.
  const locale = useStaffStore((s) => s.locale);
  const activeStore = useStaffStore((s) => s.activeStore);
  const stores = useStaffStore((s) =>
    s.authState.kind === 'signed-in' ? s.authState.stores : [],
  );
  const userId = useStaffStore((s) => currentStaffUserId(s.authState));
  const setActiveStore = useStaffStore((s) => s.setActiveStore);

  const { submit, pending, draining } = useEodSubmit();

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  const [items, setItems] = useState<EodItem[]>([]);
  // Ingredient-name search — view-only. Narrows the rendered rows; the full
  // `items` array still drives submission (onSubmit iterates `items`).
  const [search, setSearch] = useState('');
  // Spec 103 — per-user custom order. `viewMode` toggles the default
  // (vendor-scoped flat list, current behavior) vs a flat Custom view ordered
  // by the user's saved drag arrangement. `savedIds` is the saved id array for
  // the CURRENT vendor (the order is per-(surface, vendor), OQ-1) — refetched
  // on vendor change. Render-only: submission + the gate still iterate the
  // full `items` (AC-9).
  const [viewMode, setViewMode] = useState<'default' | 'custom'>('default');
  const [savedIds, setSavedIds] = useState<string[] | null>(null);
  // The order to render in Custom view: the saved ranking applied to the full
  // item set (unranked appended, deleted ignored), THEN narrowed by the search
  // — search composes with the custom order (AC-10).
  const orderedItems = useMemo(
    () => applyCountOrder(items, savedIds, (i) => i.id),
    [items, savedIds],
  );
  const visibleItems = useMemo(() => {
    // In Custom view the base list is the custom order; in default view it is
    // the items' default (fetch) order. Search narrows whichever is active.
    const base = viewMode === 'custom' ? orderedItems : items;
    if (!search.trim()) return base;
    // Match the localized label the staffer sees AND the English canonical,
    // so search works in any locale (diacritic-folded via matchesQuery).
    return base.filter((i) =>
      matchesQuery(search, [
        getLocalizedName({ name: i.name, i18nNames: i.i18nNames }, locale),
        i.name,
      ]),
    );
  }, [items, orderedItems, viewMode, search, locale]);
  const [existing, setExisting] = useState<ExistingSubmission | null>(null);
  // Spec 086 — two per-item maps mirroring the admin worksheet's
  // case/unit split (un-keyed-by-vendor: the staff screen already scopes
  // to one selected vendor at a time).
  const [caseCounts, setCaseCounts] = useState<Record<string, string>>({});
  const [unitCounts, setUnitCounts] = useState<Record<string, string>>({});
  // Spec: every item must be counted (even "0") before submit. On a blocked
  // submit we jump to the first uncounted row — `listRef` scrolls it into
  // view, `caseInputRefs` focuses its Cases box, and `pendingFocusId` drives
  // the effect that does both (re-running once a searched-out target appears).
  const listRef = useRef<FlatList<EodItem>>(null);
  const caseInputRefs = useRef<Record<string, TextInput | null>>({});
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [forbidden, setForbidden] = useState<boolean>(false);

  // Live progress for the "X of N counted" label — a row counts once EITHER
  // box has a value (the same predicate the red marking + gate use).
  const countedNum = useMemo(
    () =>
      items.filter(
        (it) =>
          (caseCounts[it.id] ?? '').trim() !== '' || (unitCounts[it.id] ?? '').trim() !== '',
      ).length,
    [items, caseCounts, unitCounts],
  );

  // ─── count date: today (default) or yesterday for a missed/late count ──
  // Owner request (2026-07): if staff missed a vendor's count date they can
  // step back ONE day and count it, flagged as a late submission. "Late" is
  // purely derived (dayOffset > 0) — it needs no storage because the DB
  // already records it implicitly: eod_submissions.date (the count date) is
  // earlier than submitted_at::date (the wall-clock write). Overloading
  // `status` was rejected — admin's fetchRecentEodDates filters
  // status = 'submitted', so a 'late' status would hide the count.
  const [dayOffset, setDayOffset] = useState(0); // 0 = today, 1 = yesterday
  const countDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - dayOffset);
    return d;
  }, [dayOffset]);
  // Local YYYY-MM-DD for the selected count date — the submission date key.
  const countIso = useMemo(() => todayIso(countDate), [countDate]);
  const isLate = dayOffset > 0;

  // Recompute when `t` or the selected count date changes so the header date
  // label re-translates (spec 099) and reflects Today vs Yesterday.
  const todayLabel = useMemo(
    () =>
      todayHeaderLabel(t, countDate, isLate ? 'eod.header.yesterday' : 'eod.header.today'),
    [t, countDate, isLate],
  );
  const canSwitchStore = stores.length > 1;

  // ─── yesterday-incomplete nudge ──────────────────────────────────
  // True when ≥1 vendor scheduled YESTERDAY has no submission for
  // yesterday's date yet — drives the red "Yesterday" toggle label + the
  // Today reminder banner. Best-effort: any fetch error leaves it false (no
  // false alarms). `submitTick` bumps on a successful submit so completing
  // yesterday's count clears the nudge without a manual refresh.
  const [yesterdayIncomplete, setYesterdayIncomplete] = useState(false);
  const [submitTick, setSubmitTick] = useState(0);
  useEffect(() => {
    if (!activeStore) {
      setYesterdayIncomplete(false);
      return;
    }
    let cancelled = false;
    fetchYesterdayIncomplete(activeStore.id)
      .then((inc) => {
        if (!cancelled) setYesterdayIncomplete(inc);
      })
      .catch(() => {
        if (!cancelled) setYesterdayIncomplete(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeStore, submitTick]);

  // ─── load vendors for today on mount / when active store changes ──
  useEffect(() => {
    if (!activeStore) return;
    setLoading(true);
    setForbidden(false);
    // Vendors are scheduled per weekday, so a yesterday count loads
    // YESTERDAY's scheduled vendors (the ones that may have been missed).
    fetchVendorsForToday(activeStore.id, todayWeekday(countDate))
      .then((vs) => {
        setVendors(vs);
        setSelectedVendorId(vs[0]?.id ?? null);
      })
      .catch((err) => {
        notifyBackendError('fetchVendorsForToday', err);
        setVendors([]);
        setSelectedVendorId(null);
      })
      .finally(() => setLoading(false));
  }, [activeStore, countDate]);

  // ─── load items + existing submission when vendor changes ─────────
  useEffect(() => {
    if (!activeStore || !selectedVendorId) {
      setItems([]);
      setExisting(null);
      setCaseCounts({});
      setUnitCounts({});
      return;
    }
    setLoading(true);
    Promise.all([
      fetchItemsForVendor(activeStore.id, selectedVendorId),
      fetchExistingSubmission(activeStore.id, countIso, selectedVendorId),
    ])
      .then(([nextItems, nextExisting]) => {
        setItems(nextItems);
        setExisting(nextExisting);
        // Pre-fill BOTH boxes from any existing submission. Cases seeds from
        // actual_remaining_cases (blank when null).
        //
        // Units seed: prefer the explicit `each` split. The legacy-row
        // fallback to the stored TOTAL (`actual_remaining`) applies ONLY to a
        // TRUE legacy row — one with NO split columns at all (cases AND each
        // both null), per spec 086 OQ-4. It must NOT fire for a new
        // cases-only submission (cases set, each null): the total there is
        // cases×caseQty, so seeding units from it re-adds the case amount and
        // DOUBLES the count on reload (a manager entering 14 cases of a
        // case-of-6 item saw loose auto-fill to 84 → total 168). Discriminator
        // is `actual_remaining_cases == null` — a new split row always has it.
        const caseSeed: Record<string, string> = {};
        const unitSeed: Record<string, string> = {};
        if (nextExisting) {
          for (const e of nextExisting.entries) {
            if (e.actual_remaining_cases != null) {
              caseSeed[e.item_id] = String(e.actual_remaining_cases);
            }
            const units =
              e.actual_remaining_each != null
                ? e.actual_remaining_each
                : e.actual_remaining_cases == null
                  ? e.actual_remaining
                  : null;
            if (units != null) {
              unitSeed[e.item_id] = String(units);
            }
          }
        }
        setCaseCounts(caseSeed);
        setUnitCounts(unitSeed);
      })
      .catch((err) => {
        notifyBackendError('fetchItemsForVendor', err);
        setItems([]);
        setExisting(null);
        setCaseCounts({});
        setUnitCounts({});
      })
      .finally(() => setLoading(false));
  }, [activeStore, selectedVendorId, countIso]);

  // ─── Spec 103: load the saved custom order for (this vendor) on change ──
  // The order is per-(staff-eod, vendor). On open, if a saved order exists for
  // the active vendor, start in Custom view (AC-7); else default. A genuine
  // fetch error falls back to default (the screen still renders; the order
  // just isn't applied) and surfaces via notifyBackendError.
  useEffect(() => {
    if (!userId || !selectedVendorId) {
      setSavedIds(null);
      setViewMode('default');
      return;
    }
    let cancelled = false;
    fetchCountOrder(userId, 'staff-eod', selectedVendorId)
      .then((ids) => {
        if (cancelled) return;
        setSavedIds(ids);
        setViewMode(ids && ids.length > 0 ? 'custom' : 'default');
      })
      .catch((err) => {
        if (cancelled) return;
        notifyBackendError('fetchCountOrder', err);
        setSavedIds(null);
        setViewMode('default');
      });
    return () => {
      cancelled = true;
    };
  }, [userId, selectedVendorId]);

  // Persist-on-drop. Optimistically set the new order, write it, and revert +
  // notify on failure (AC-6). The id array passed is the FULL custom order for
  // this vendor (the drag list hands back the visible subset's ids — but in
  // Custom view with no search the visible subset IS the full ordered set; a
  // reorder while a search is active is disabled below so this is always the
  // full set).
  const onReorder = useCallback(
    (orderedIds: string[]) => {
      if (!userId || !selectedVendorId) return;
      const prev = savedIds;
      setSavedIds(orderedIds);
      setViewMode('custom');
      saveCountOrder(userId, 'staff-eod', selectedVendorId, orderedIds).catch((err) => {
        setSavedIds(prev);
        notifyBackendError('saveCountOrder', err);
      });
    },
    [userId, selectedVendorId, savedIds],
  );

  // Reset — clear this vendor's saved order, return to default view. Optimistic
  // + revert-on-failure.
  const onResetOrder = useCallback(() => {
    if (!userId || !selectedVendorId) return;
    const prev = savedIds;
    setSavedIds(null);
    setViewMode('default');
    resetCountOrder(userId, 'staff-eod', selectedVendorId).catch((err) => {
      setSavedIds(prev);
      notifyBackendError('resetCountOrder', err);
    });
  }, [userId, selectedVendorId, savedIds]);

  // ─── header actions ───────────────────────────────────────────────
  const onSwitchStore = useCallback(() => {
    if (!canSwitchStore) return;
    setActiveStore(null);
  }, [canSwitchStore, setActiveStore]);

  // ─── submit ───────────────────────────────────────────────────────
  // Jump to the first uncounted row after a blocked submit. Re-runs when
  // `visibleItems` changes so a target hidden behind the search resolves once
  // the search-clear lands. Scrolls the row in, then focuses its Cases box —
  // on web the DOM focus also pulls a partially-clipped input fully into view.
  useEffect(() => {
    if (!pendingFocusId) return;
    const idx = visibleItems.findIndex((it) => it.id === pendingFocusId);
    if (idx < 0) return; // not rendered yet — wait for the search-clear re-render
    let cancelled = false;
    try {
      listRef.current?.scrollToIndex({ index: idx, viewPosition: 0.3, animated: true });
    } catch {
      // scrollToIndex can throw before layout settles; onScrollToIndexFailed recovers
    }
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (cancelled) return;
        caseInputRefs.current[pendingFocusId]?.focus?.();
        setPendingFocusId(null);
      }),
    );
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [pendingFocusId, visibleItems]);

  const onSubmit = useCallback(async () => {
    if (!activeStore || !selectedVendorId || submitting) return;
    if (items.length === 0) return;
    // Completeness gate — every item for this vendor must be counted (even a
    // typed "0") before submitting. A row is "counted" once EITHER its Cases
    // OR its Units box holds a value; a fully-blank row is left uncounted. If
    // any remain, block the submit and jump to the first one (clearing the
    // search first so a searched-out target can render). Checks the full
    // `items` list, never the search-narrowed `visibleItems`.
    const isBlank = (it: EodItem) =>
      (caseCounts[it.id] ?? '').trim() === '' && (unitCounts[it.id] ?? '').trim() === '';
    // Completeness COUNT is against the FULL item set, order-independent (AC-9).
    const uncounted = items.filter(isBlank);
    if (uncounted.length > 0) {
      if (search.trim()) setSearch('');
      // Spec 103 (AC-12) — the JUMP target follows the on-screen order: in
      // Custom view, the topmost uncounted in the user's saved order; in
      // default view, the first uncounted in the items' default order. Resolve
      // against the FULL item set (not the search-narrowed view), matching the
      // clear-search-then-jump behavior.
      const ordered =
        viewMode === 'custom' ? applyCountOrder(items, savedIds, (i) => i.id) : items;
      const target = firstUncounted(ordered, (it) => !isBlank(it));
      setPendingFocusId((target ?? uncounted[0]).id);
      Toast.show({
        type: 'error',
        text1: t('eod.toast.countAllTitle'),
        text2: t('eod.toast.countAllRemaining', { count: uncounted.length }),
        position: 'bottom',
      });
      return;
    }
    // Build entries — include a row when EITHER its Cases OR its Units
    // box is non-empty (the admin `hasEntry` rule,
    // EODCountSection.tsx:397-398). Fully-blank rows are skipped so the
    // RPC isn't bloated. Each entry carries the converted total
    // (`cases × (caseQty || 1) + units`, byte-identical to the admin at
    // EODCountSection.tsx:395,429, with isNaN→0 per input) plus the raw
    // splits (null when the box is blank).
    const entries: EodEntry[] = items
      .map((it) => {
        const caseRaw = caseCounts[it.id] ?? '';
        const unitRaw = unitCounts[it.id] ?? '';
        if (caseRaw.trim() === '' && unitRaw.trim() === '') return null;
        const casesParsed = parseFloat(caseRaw);
        const unitsParsed = parseFloat(unitRaw);
        const cases = Number.isNaN(casesParsed) ? 0 : casesParsed;
        const units = Number.isNaN(unitsParsed) ? 0 : unitsParsed;
        const total = cases * (it.caseQty || 1) + units;
        return {
          item_id: it.id,
          actual_remaining: total,
          actual_remaining_cases: Number.isNaN(casesParsed) ? null : casesParsed,
          actual_remaining_each: Number.isNaN(unitsParsed) ? null : unitsParsed,
        };
      })
      .filter((x): x is EodEntry => x !== null);
    if (entries.length === 0) {
      Toast.show({
        type: 'error',
        text1: t('eod.toast.failed'),
        text2: t('eod.toast.noCountsEntered'),
        position: 'bottom',
      });
      return;
    }
    // Count date captured at SUBMIT time (spec §11 risk c) — wall-clock now
    // minus the selected day offset, so a session left open across midnight
    // still keys to the correct day (the `countIso` memo used for the
    // existing-submission FETCH is mount-time, matching the pre-change
    // fetch behaviour; only the write must be submit-time-fresh).
    // submitted_at stays now(), so a yesterday count is durably
    // distinguishable as late (date < submitted_at::date).
    const submitDate = new Date();
    submitDate.setDate(submitDate.getDate() - dayOffset);
    const dateIso = todayIso(submitDate);

    setSubmitting(true);
    try {
      const outcome = await submit({
        store_id: activeStore.id,
        date: dateIso,
        vendor_id: selectedVendorId,
        entries,
      });
      if (outcome.kind === 'success') {
        Toast.show({
          type: 'success',
          text1: t('eod.toast.submitted'),
          position: 'bottom',
        });
        // Refresh existing to show the "Last submitted at HH:MM" banner.
        try {
          const fresh = await fetchExistingSubmission(
            activeStore.id,
            dateIso,
            selectedVendorId,
          );
          setExisting(fresh);
        } catch {
          // ignore — primary action succeeded
        }
        // Re-check the yesterday-incomplete nudge (a yesterday submit clears it).
        setSubmitTick((n) => n + 1);
        navigation.navigate('Reorder');
      } else if (outcome.kind === 'success-replay') {
        Toast.show({
          type: 'success',
          text1: t('eod.toast.alreadySubmitted'),
          position: 'bottom',
        });
        setSubmitTick((n) => n + 1);
        navigation.navigate('Reorder');
      } else if (outcome.kind === 'forbidden') {
        setForbidden(true);
      } else if (outcome.kind === 'queued') {
        Toast.show({
          type: 'success',
          text1: t('eod.toast.queued'),
          position: 'bottom',
        });
        // Clear inputs so the user moves on — spec §B7.
        setCaseCounts({});
        setUnitCounts({});
      } else {
        Toast.show({
          type: 'error',
          text1: outcome.message,
          position: 'bottom',
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [activeStore, selectedVendorId, items, caseCounts, unitCounts, submit, submitting, search, viewMode, savedIds, t]);

  // Spec 103 — one shared row body, rendered by BOTH the default FlatList and
  // the Custom drag list, so the Custom view shows byte-identical rows (the
  // custom order is render-only). Factored out of the FlatList renderItem.
  const renderEodRow = useCallback(
    (item: EodItem) => {
      const caseRaw = caseCounts[item.id] ?? '';
      const unitRaw = unitCounts[item.id] ?? '';
      const hasPack = (item.caseQty ?? 0) > 1;
      const entered = caseRaw.trim() !== '' || unitRaw.trim() !== '';
      const casesParsed = parseFloat(caseRaw);
      const unitsParsed = parseFloat(unitRaw);
      const total =
        (Number.isNaN(casesParsed) ? 0 : casesParsed) * (item.caseQty || 1) +
        (Number.isNaN(unitsParsed) ? 0 : unitsParsed);
      const displayName = getLocalizedName(
        { name: item.name, i18nNames: item.i18nNames },
        locale,
      );
      return (
        <ListRow
          testID={`eod-item-row-${item.id}`}
          leading={
            <View style={styles.leadingRow}>
              {/* Spec 127 — ingredient photo (or placeholder) so staff can
                  visually identify the physical item. View-only. */}
              <IngredientThumb path={item.imagePath} testID={`eod-item-thumb-${item.id}`} />
              <View style={styles.leadingText}>
              <Text
                style={[styles.itemName, { color: entered ? c.text : c.error }]}
                numberOfLines={2}
              >
                {displayName}
              </Text>
              {item.unit || hasPack ? (
                <Text style={[styles.itemUnit, { color: c.textSecondary }]}>
                  {item.unit}
                  {hasPack ? ` · ${t('eod.row.caseOf', { qty: item.caseQty as number })}` : ''}
                </Text>
              ) : null}
              {hasPack && entered ? (
                <Text
                  style={[styles.itemTotal, { color: c.textSecondary }]}
                  testID={`eod-item-total-${item.id}`}
                >
                  {t('eod.row.total', { total, unit: item.unit })}
                </Text>
              ) : null}
              </View>
            </View>
          }
          trailing={
            <View style={styles.countInputs}>
              <View style={styles.countCol}>
                <Text style={[styles.countColLabel, { color: c.textSecondary }]}>
                  {t('eod.col.cases')}
                </Text>
                <Input
                  ref={(r) => {
                    caseInputRefs.current[item.id] = r;
                  }}
                  value={caseRaw}
                  onChangeText={(txt) =>
                    setCaseCounts((prev) => ({ ...prev, [item.id]: txt }))
                  }
                  keyboardType="decimal-pad"
                  {...(Platform.OS === 'web' ? { inputMode: 'decimal' as const } : {})}
                  placeholder="0"
                  testID={`eod-item-cases-${item.id}`}
                  style={[styles.countInput, !entered && { borderColor: c.error }]}
                  accessibilityLabel={t('eod.col.casesAria', { item: displayName })}
                />
              </View>
              <View style={styles.countCol}>
                <Text style={[styles.countColLabel, { color: c.textSecondary }]}>
                  {t('eod.col.units')}
                </Text>
                <Input
                  value={unitRaw}
                  onChangeText={(txt) =>
                    setUnitCounts((prev) => ({ ...prev, [item.id]: txt }))
                  }
                  keyboardType="decimal-pad"
                  {...(Platform.OS === 'web' ? { inputMode: 'decimal' as const } : {})}
                  placeholder="0"
                  testID={`eod-item-units-${item.id}`}
                  style={[styles.countInput, !entered && { borderColor: c.error }]}
                  accessibilityLabel={t('eod.col.unitsAria', { item: displayName })}
                />
              </View>
            </View>
          }
        />
      );
    },
    [caseCounts, unitCounts, locale, c, t],
  );

  if (!activeStore) {
    // Shouldn't render — RootStack swaps to picker when activeStore
    // is null. Defensive empty state.
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: c.bgAlt }]}
        edges={['top', 'bottom']}
      >
        <View style={styles.empty}>
          <ActivityIndicator color={c.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const submittedTime = existing ? submittedAtHHMM(existing.submitted_at) : null;

  return (
    // Root is the recessed `bgAlt` field — the surface header/footer bars
    // and the white item cards stand off it. (spec 070 fix-pass: the
    // earlier `bg`≈`surface` pairing made the cards invisible.)
    <SafeAreaView
      style={[styles.container, { backgroundColor: c.bgAlt }]}
      edges={['top', 'bottom']}
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: c.surface, borderBottomColor: c.border },
        ]}
      >
        <View style={styles.headerRow}>
          <Pressable
            onPress={onSwitchStore}
            disabled={!canSwitchStore}
            accessibilityRole={canSwitchStore ? 'button' : 'none'}
            accessibilityLabel={canSwitchStore ? t('chrome.switchStore') : undefined}
            testID="eod-store-name"
            style={({ pressed }) => [
              styles.storePressable,
              pressed && canSwitchStore ? { backgroundColor: c.surfaceAlt } : null,
            ]}
          >
            <Text
              style={[styles.storeName, { color: canSwitchStore ? c.primary : c.text }]}
              numberOfLines={1}
            >
              {activeStore.name}
            </Text>
            <Text style={[styles.todayLabel, { color: c.textSecondary }]}>
              {todayLabel}
            </Text>
          </Pressable>
          <SettingsGear />
        </View>
        {/* Today / Yesterday count-date toggle. Yesterday lets staff catch a
            vendor whose count date was missed; the submission is flagged late
            (see the banner below + the derived-lateness note above). */}
        <View
          style={styles.dateToggle}
          accessibilityRole="radiogroup"
          accessibilityLabel={t('eod.date.aria')}
        >
          {[1, 0].map((off) => {
            const active = dayOffset === off;
            // Alert styling: yesterday's label goes red+bold when its counts
            // aren't finished and it isn't the active (selected) segment.
            const alert = off === 1 && yesterdayIncomplete && !active;
            return (
              <Pressable
                key={off}
                onPress={() => setDayOffset(off)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                testID={`eod-date-${off === 0 ? 'today' : 'yesterday'}`}
                style={[
                  styles.dateSegment,
                  { borderColor: c.border, backgroundColor: active ? c.primary : 'transparent' },
                ]}
              >
                <Text
                  style={[
                    styles.dateSegmentText,
                    {
                      color: active ? c.textOnPrimary : alert ? c.error : c.textSecondary,
                      fontWeight:
                        active || alert ? T.typography.semibold : T.typography.medium,
                    },
                  ]}
                >
                  {t(off === 0 ? 'eod.date.today' : 'eod.date.yesterday')}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Persistent "turn on notifications" nudge — RED, non-dismissible,
          disappears once notifications are on. */}
      <NotificationReminderBanner />

      {/* Late-submission banner — shown whenever a past (yesterday) date is
          selected so staff know this count is recorded as late. */}
      {isLate ? (
        <Banner
          tone="warning"
          text={todayHeaderLabel(t, countDate, 'eod.late.banner')}
          testID="eod-late-banner"
        />
      ) : null}

      {/* Today-view reminder — nudge to finish yesterday's outstanding counts.
          Red (error tone) to match the red "Yesterday" toggle label. */}
      {!isLate && yesterdayIncomplete ? (
        <Banner
          tone="error"
          text={t('eod.yesterday.reminder')}
          testID="eod-yesterday-reminder"
        />
      ) : null}

      {/* Forbidden banner */}
      {forbidden ? <Banner tone="error" text={t('eod.error.forbidden')} /> : null}

      {/* Pre-fill banner */}
      {existing && submittedTime ? (
        <Banner
          tone="info"
          text={t('eod.banner.lastSubmitted', { time: submittedTime })}
          testID="eod-prefill-banner"
        />
      ) : null}

      {/* Vendor indicator. >1 vendor → interactive chip switcher. Exactly 1
          vendor → a static "Vendor: <name>" label so staff always see which
          vendor they're counting for (a lone vendor is not switchable, but it
          still needs to be named). 0 vendors → nothing here; the empty pane
          below renders eod.vendor.noneToday. */}
      {vendors.length > 1 ? (
        <View
          style={[
            styles.vendorSwitcher,
            { backgroundColor: c.surface, borderBottomColor: c.border },
          ]}
        >
          <FlatList
            horizontal
            data={vendors}
            keyExtractor={(v) => v.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.vendorChipRow}
            renderItem={({ item }) => {
              const active = item.id === selectedVendorId;
              return (
                <Pressable
                  onPress={() => setSelectedVendorId(item.id)}
                  testID={`vendor-chip-${item.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[
                    styles.vendorChip,
                    {
                      backgroundColor: active ? c.primary : c.surface,
                      borderColor: active ? c.primary : c.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.vendorChipText,
                      {
                        color: active ? c.textOnPrimary : c.text,
                        fontWeight: active ? T.typography.semibold : T.typography.medium,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {item.name}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
      ) : vendors.length === 1 ? (
        <View
          style={[
            styles.vendorSwitcher,
            { backgroundColor: c.surface, borderBottomColor: c.border },
          ]}
        >
          <Text
            testID="eod-vendor-single"
            style={[styles.vendorLabel, { color: c.text }]}
            numberOfLines={1}
          >
            {t('eod.vendor.single', { name: vendors[0].name })}
          </Text>
        </View>
      ) : null}

      {/* Live "X of N counted" progress for the selected vendor — turns green
          once every item is counted (ties into the count-everything gate). */}
      {!loading && items.length > 0 ? (
        <View style={{ paddingHorizontal: T.spacing.lg, paddingTop: T.spacing.sm }}>
          <Text
            testID="eod-counted-label"
            style={{
              fontSize: T.typography.caption,
              fontWeight: T.typography.semibold,
              color: countedNum === items.length ? c.primary : c.textSecondary,
            }}
          >
            {t('eod.countedOfTotal', { counted: countedNum, total: items.length })}
          </Text>
        </View>
      ) : null}

      {/* Ingredient-name search — view-only; shown once this vendor's items
          have loaded. */}
      {!loading && items.length > 0 ? (
        <View style={{ paddingHorizontal: T.spacing.lg, paddingTop: T.spacing.sm, flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Input
              testID="eod-search"
              placeholder={t('eod.list.searchPlaceholder')}
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          {search ? (
            <Pressable
              testID="eod-search-clear"
              onPress={() => setSearch('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('chrome.clear')}
            >
              <Text style={{ color: c.textSecondary, fontSize: 22, paddingHorizontal: T.spacing.xs }}>✕</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Spec 103 — Default ⇄ Custom view toggle + per-vendor reset. Custom
          view flattens the list into the user's saved drag order; default is
          the current vendor-scoped flat list. The order is per-vendor. */}
      {!loading && items.length > 0 ? (
        <View style={{ paddingHorizontal: T.spacing.lg, paddingTop: T.spacing.sm, flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm }}>
          <Pressable
            testID="eod-view-default"
            onPress={() => setViewMode('default')}
            accessibilityRole="button"
            accessibilityState={{ selected: viewMode === 'default' }}
            style={{
              paddingHorizontal: T.spacing.md,
              paddingVertical: T.spacing.xs,
              borderRadius: T.radius.md,
              borderWidth: 1,
              borderColor: viewMode === 'default' ? c.primary : c.border,
              backgroundColor: viewMode === 'default' ? c.primary : 'transparent',
            }}
          >
            <Text
              style={{
                fontSize: T.typography.caption,
                fontWeight: T.typography.semibold,
                color: viewMode === 'default' ? c.textOnPrimary : c.textSecondary,
              }}
            >
              {t('eod.view.default')}
            </Text>
          </Pressable>
          <Pressable
            testID="eod-view-custom"
            onPress={() => setViewMode('custom')}
            accessibilityRole="button"
            accessibilityState={{ selected: viewMode === 'custom' }}
            style={{
              paddingHorizontal: T.spacing.md,
              paddingVertical: T.spacing.xs,
              borderRadius: T.radius.md,
              borderWidth: 1,
              borderColor: viewMode === 'custom' ? c.primary : c.border,
              backgroundColor: viewMode === 'custom' ? c.primary : 'transparent',
            }}
          >
            <Text
              style={{
                fontSize: T.typography.caption,
                fontWeight: T.typography.semibold,
                color: viewMode === 'custom' ? c.textOnPrimary : c.textSecondary,
              }}
            >
              {t('eod.view.custom')}
            </Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          {savedIds && savedIds.length > 0 ? (
            <Pressable
              testID="eod-reset-order"
              onPress={onResetOrder}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('eod.view.reset')}
            >
              <Text style={{ fontSize: T.typography.caption, fontWeight: T.typography.semibold, color: c.primary }}>
                {t('eod.view.reset')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {/* Items list */}
      {loading ? (
        <View style={styles.loadingPane}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      ) : vendors.length === 0 ? (
        <View style={styles.emptyPane}>
          <Text style={[styles.emptyText, { color: c.textSecondary }]}>
            {t(isLate ? 'eod.vendor.noneYesterday' : 'eod.vendor.noneToday')}
          </Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyPane}>
          <Text style={[styles.emptyText, { color: c.textSecondary }]}>
            {t('eod.list.empty')}
          </Text>
        </View>
      ) : viewMode === 'custom' ? (
        // Spec 103 — flat Custom view in the user's saved drag order. The
        // drag list keeps EVERY row mounted (un-windowed) inside a ScrollView
        // so the gate jump (DOM focus → scroll-into-view on web) can reach any
        // row. Drag/▲▼ reorder is disabled while a search is active (the
        // visible subset isn't the full order — re-dragging a filtered list
        // would drop the hidden ids). The shared `renderEodRow` body is
        // byte-identical to the default view.
        <ScrollView
          testID="eod-item-list"
          style={styles.itemListBody}
          contentContainerStyle={styles.itemList}
        >
          {visibleItems.length === 0 ? (
            <View style={styles.emptyPane}>
              <Text style={[styles.emptyText, { color: c.textSecondary }]}>
                {t('eod.list.noMatch')}
              </Text>
            </View>
          ) : search.trim() ? (
            // Search active → render the matching rows in custom relative
            // order, but WITHOUT the reorder affordance (reorder needs the
            // full set). Clearing the search restores drag.
            visibleItems.map((item) => (
              <View key={item.id} style={{ marginBottom: T.spacing.sm }}>
                {renderEodRow(item)}
              </View>
            ))
          ) : (
            <CountOrderDragList
              items={visibleItems}
              onReorder={onReorder}
              renderRow={renderEodRow}
              moveUpLabel={t('eod.reorder.moveUp')}
              moveDownLabel={t('eod.reorder.moveDown')}
            />
          )}
        </ScrollView>
      ) : (
        <FlatList
          ref={listRef}
          testID="eod-item-list"
          data={visibleItems}
          keyExtractor={(i) => i.id}
          // Count-everything gate: render the WHOLE list un-windowed so the
          // "jump to first uncounted row" scroll (pendingFocusId effect) can
          // reach ANY row — a windowed row that isn't mounted can't be scrolled
          // to or focused — and so every row is countable in a single pass.
          // Mirrors WeeklyCount; the per-vendor list is small (tens of rows).
          initialNumToRender={visibleItems.length + 10}
          maxToRenderPerBatch={visibleItems.length + 10}
          windowSize={Math.max(21, visibleItems.length)}
          // Rows are variable-height, so scrollToIndex can miss before the
          // target is measured — approximate the offset, then the focus effect
          // pulls it the rest of the way in.
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({
              offset: info.averageItemLength * Math.max(0, info.index - 1),
              animated: true,
            });
          }}
          ListEmptyComponent={
            <View style={styles.emptyPane}>
              <Text style={[styles.emptyText, { color: c.textSecondary }]}>
                {t('eod.list.noMatch')}
              </Text>
            </View>
          }
          // flex: 1 claims the leftover vertical space between the pinned
          // header (+ banners + vendor switcher) and the pinned footer
          // (queue indicator + Submit) so the list scrolls *inside* that
          // strip instead of pushing the footer below the viewport. Web
          // without this falls back to body-scroll and hides Submit;
          // native overflows the SafeAreaView. The empty/loading panes
          // above already use `flex: 1` — this restores symmetry on the
          // populated branch.
          style={styles.itemListBody}
          contentContainerStyle={styles.itemList}
          ItemSeparatorComponent={() => <View style={styles.itemSeparator} />}
          renderItem={({ item }) => renderEodRow(item)}
        />
      )}

      {/* Footer — queue indicator + submit */}
      <View
        style={[
          styles.footer,
          { backgroundColor: c.surface, borderTopColor: c.border },
        ]}
      >
        <QueueIndicator pending={pending} draining={draining} testID="eod-queue-indicator" />
        <View style={styles.submitWrap}>
          <Button
            label={submitting ? t('eod.submitting') : t('eod.submit')}
            onPress={onSubmit}
            disabled={items.length === 0 || forbidden}
            loading={submitting}
            testID="eod-submit"
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  container: {
    // Absolute-fill the React Navigation card (the nearest positioned
    // ancestor) instead of relying on `flex: 1` in the flow. On
    // react-native-web, RN-Navigation's screen-wrapper sets
    // `min-height: 100%` + `flex: 0 0 auto`, which lets it GROW with
    // content past the viewport — that pushes the pinned footer
    // (Submit) below the fold and turns the page into body-scroll. The
    // absoluteFillObject sizes us to the Card (≈100vh), so the inner
    // FlatList (also flex: 1) becomes the scroll container and the
    // header/footer stay pinned. Native Yoga treats the same shape
    // identically; SafeAreaView's `edges` padding still applies.
    ...StyleSheet.absoluteFillObject,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.md,
    borderBottomWidth: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: T.spacing.md,
  },
  // Today / Yesterday segmented toggle — mirrors the LocaleSwitcher pill shape.
  dateToggle: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    marginTop: T.spacing.sm,
    borderRadius: T.radius.md,
    overflow: 'hidden',
  },
  dateSegment: {
    minHeight: T.touchTarget.min,
    paddingHorizontal: T.spacing.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateSegmentText: {
    fontSize: T.typography.caption,
  },
  storePressable: {
    flex: 1,
    minWidth: 0,
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.sm,
    borderRadius: T.radius.sm,
  },
  storeName: {
    fontSize: T.typography.title,
    fontWeight: T.typography.bold,
  },
  todayLabel: {
    fontSize: T.typography.caption,
    marginTop: 2,
  },
  vendorSwitcher: {
    paddingTop: T.spacing.sm,
    paddingBottom: T.spacing.sm,
    borderBottomWidth: 1,
  },
  vendorChipRow: {
    paddingHorizontal: T.spacing.lg,
    gap: T.spacing.sm,
  },
  vendorChip: {
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.pill,
    borderWidth: 1,
    minHeight: 36,
    justifyContent: 'center',
  },
  vendorChipText: {
    fontSize: T.typography.body,
  },
  vendorLabel: {
    paddingHorizontal: T.spacing.lg,
    fontSize: T.typography.body,
    fontWeight: T.typography.semibold,
  },
  loadingPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: T.spacing.xl,
  },
  emptyText: {
    fontSize: T.typography.body,
    textAlign: 'center',
  },
  itemListBody: {
    flex: 1,
  },
  itemList: {
    paddingHorizontal: T.spacing.lg,
    paddingTop: T.spacing.sm,
    paddingBottom: T.spacing.lg,
  },
  itemSeparator: {
    height: T.spacing.sm,
  },
  // Spec 127 — leading cell is now [thumbnail | name/unit column].
  leadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
  },
  leadingText: {
    flex: 1,
    minWidth: 0,
  },
  itemName: {
    fontSize: T.typography.bodyLarge,
    fontWeight: T.typography.semibold,
  },
  itemUnit: {
    fontSize: T.typography.caption,
    marginTop: 2,
  },
  itemTotal: {
    fontSize: T.typography.caption,
    marginTop: 2,
    fontWeight: T.typography.semibold,
  },
  // Two compact inputs side-by-side in the trailing slot. Each column
  // stacks a caption (Cases / Units) over the input. ~44pt each + gap
  // keeps the pair inside the row's trailing cell on a phone viewport
  // (the leading column is flex:1, minWidth:0 so it yields).
  countInputs: {
    flexDirection: 'row',
    // Tight gap so the columns can be wide enough for "Loose Units"
    // to fit on one line.
    gap: T.spacing.xs,
    alignItems: 'flex-end',
  },
  countCol: {
    width: 52,
  },
  countColLabel: {
    fontSize: T.typography.caption,
    marginBottom: T.spacing.xs,
    textAlign: 'center',
    fontWeight: T.typography.medium,
  },
  countInput: {
    width: 52,
    textAlign: 'center',
  },
  footer: {
    paddingHorizontal: T.spacing.lg,
    paddingTop: T.spacing.md,
    paddingBottom: T.spacing.md,
    borderTopWidth: 1,
    gap: T.spacing.sm,
  },
  submitWrap: {
    width: '100%',
  },
});

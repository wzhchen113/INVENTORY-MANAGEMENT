import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, TextInput, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useIsPhone } from '../../../theme/breakpoints';
import { useStore } from '../../../store/useStore';
import { submitEODCount, fetchCountOrder, saveCountOrder, resetCountOrder } from '../../../lib/db';
import { applyCountOrder, firstUncounted } from '../../../lib/countOrder';
import { deriveDayStatus, isRestWeekday, type DayStatus } from '../../../lib/eodDayStatus';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { FilterInput } from '../../../components/cmd/FilterInput';
import CountOrderDragList from '../../../components/cmd/CountOrderDragList';
import { matchesQuery } from '../../../i18n/matchesQuery';
import { usePaletteAction } from '../../../lib/paletteAction';
import { useT } from '../../../hooks/useT';
import { dayOfWeekShortLabel, dayOfWeekLongLabel, type DayName } from '../../../utils/enumLabels';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { StatusDot } from '../../../components/cmd/StatusDot';
import { StatCard } from '../../../components/cmd/StatCard';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { ComingSoonPanel } from '../../../components/cmd/ComingSoonPanel';
import { AddCountModal } from '../../../components/cmd/AddCountModal';
import { AddVendorScheduleModal } from '../../../components/cmd/AddVendorScheduleModal';
import { ListSkeleton } from '../../../components/cmd/ListSkeleton';
import { EODEntry, EODSubmission } from '../../../types';
import OrderScheduleSection from './OrderScheduleSection';

interface DayCell {
  day: DayName;      // "Saturday"
  date: string;      // "May 2"
  iso: string;       // "2026-05-02"
  status: DayStatus;
  counted: number;
  total: number;
  vendors: string;
}

// DB join keys + lookup keys for `order_schedule[day]`. Must stay English
// canonical; rendered text routes through `dayOfWeek{Long,Short}Label`.
const DAY_NAMES: ReadonlyArray<DayName> = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

// Spec 102 (§6c) — COUNTED-ONCE-GLOBALLY derivation for the admin EOD gate.
//
// A shared item (linked to ≥2 vendors) appears under each vendor tab but has a
// SINGLE shared on-hand, so counting it once is the physical truth. The
// count-everything gate + "X of N counted" label must therefore treat the item
// as counted in EVERY tab it appears in once it's been counted anywhere for
// this (store, date) — re-counting it per tab would be the "count it twice" the
// spec forbids.
//
// This returns the set of item ids that are counted SOMEWHERE for the current
// (store, date): an item with a non-blank case/unit entry in ANY vendor tab's
// local input map, OR an item present in an already-submitted submission for
// any vendor at this (store, date). The gate's `hasEntry` predicate ORs this
// set with the current tab's local entry so a shared item counted under tab V1
// is not a blocking gap (nor painted red, nor jumped-to) under tab V2.
//
// Pure — exported for jest (AC-I).
export function deriveCountedItemIds(args: {
  caseCountsByVendor: Record<string, Record<string, string>>;
  unitCountsByVendor: Record<string, Record<string, string>>;
  submissions: ReadonlyArray<{ storeId: string; date: string; status: string; entries: ReadonlyArray<{ itemId: string }> }>;
  storeId: string;
  dateIso: string;
}): Set<string> {
  const counted = new Set<string>();
  // (a) Any non-blank local entry in ANY vendor tab's input map.
  for (const byItem of Object.values(args.caseCountsByVendor)) {
    for (const [itemId, v] of Object.entries(byItem)) {
      if ((v ?? '').trim() !== '') counted.add(itemId);
    }
  }
  for (const byItem of Object.values(args.unitCountsByVendor)) {
    for (const [itemId, v] of Object.entries(byItem)) {
      if ((v ?? '').trim() !== '') counted.add(itemId);
    }
  }
  // (b) Any item already in a submitted submission for this (store, date),
  // under any vendor. Drafts also count — a draft entry is a recorded count of
  // the shared on-hand, so it shouldn't read as an outstanding gap elsewhere.
  for (const s of args.submissions) {
    if (s.storeId !== args.storeId) continue;
    if (s.date !== args.dateIso) continue;
    for (const e of s.entries) counted.add(e.itemId);
  }
  return counted;
}

// Local-day ISO string ("YYYY-MM-DD" in the user's timezone). Avoids the
// `new Date().toISOString().slice(0,10)` trap, which returns the UTC date —
// at e.g. 22:04 EDT (UTC-4) on Thursday, that returns Friday's UTC date and
// breaks day-of-week filters / submission-date comparisons. Must be derived
// from the local Date components, not from a UTC iso string.
function localDayIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Pattern A — workflow: 240px week sidebar (date list with status pills)
// + worksheet (vendor tabs, category chips, status line, grouped item
// rows with qty input, sticky footer with submit). Wires to the existing
// submitEOD store action.
//
// Simplifications vs the design:
// - Single qty input per item (no dual cases/each)
// - Ingredient-name search box filters the worksheet rows in-place (view-
//   only — submission still covers every counted item)
// - SAVE DRAFT button currently just toasts (draft persistence is out
//   of scope for Phase 10b — submitEOD itself supports draft status if
//   needed later)
// - No per-row variance pill (kept simple; we surface a footer-level total)
export default function EODCountSection() {
  const C = useCmdColors();
  const T = useT();
  const isPhone = useIsPhone();
  // Phone: drop the 240px week rail (worksheet would otherwise get ~150px on a
  // ~390px viewport, clipping inputs and wrapping item names letter-by-letter).
  // The week is rendered as a horizontal day-strip above the TabStrip instead.
  const cellW = isPhone ? 56 : 80;
  const inputW = isPhone ? 48 : 70;
  const rowGap = isPhone ? 8 : 14;
  const rowPadH = isPhone ? 12 : 22;
  const inventory = useStore((s) => s.inventory);
  const vendors = useStore((s) => s.vendors);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const submitEOD = useStore((s) => s.submitEOD);
  const orderSchedule = useStore((s) => s.orderSchedule);
  // Spec 055 — first-mount skeleton flag.
  const storeLoading = useStore((s) => s.storeLoading);
  // Backend-developer adds these store actions in spec 007's backend slice.
  // Same optimistic-then-revert pattern as setOrderSchedule.
  const addOrderScheduleEntry = useStore((s) => s.addOrderScheduleEntry);
  const removeOrderScheduleEntry = useStore((s) => s.removeOrderScheduleEntry);

  const [selectedIso, setSelectedIso] = React.useState<string>(() => localDayIso(new Date()));
  const [selectedVendorId, setSelectedVendorId] = React.useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = React.useState<string | 'all'>('all');
  // Ingredient-name search — view-only, composes with vendor + category.
  const [search, setSearch] = React.useState('');
  // Spec 020 Q4 — per-vendor draft state. Switching vendor tabs preserves
  // typed-but-unsubmitted values for the session. Keyed by vendorId →
  // itemId → text. Refresh discards (no autosave).
  const [caseCountsByVendor, setCaseCountsByVendor] = React.useState<Record<string, Record<string, string>>>({});
  const [unitCountsByVendor, setUnitCountsByVendor] = React.useState<Record<string, Record<string, string>>>({});
  const [notesByVendor, setNotesByVendor] = React.useState<Record<string, Record<string, string>>>({});
  // Vendors the user has tapped EDIT on. Once in this set the inputs unlock
  // even though the server has a submitted row for the vendor; submitting
  // overwrites and removes the vendor from this set.
  const [editingVendorIds, setEditingVendorIds] = React.useState<Set<string>>(() => new Set());
  const [submitting, setSubmitting] = React.useState(false);
  // Spec 103 — per-user custom order. The order is per-(admin-eod, vendor)
  // (OQ-1), so hold a per-vendor saved-id map mirroring `caseCountsByVendor`.
  // `viewMode` toggles the default category-grouped worksheet vs a flat Custom
  // view in the user's saved drag order. Render-only: submission + the gate
  // still iterate `filteredItems` (AC-9).
  const [viewMode, setViewMode] = React.useState<'default' | 'custom'>('default');
  const [savedIdsByVendor, setSavedIdsByVendor] = React.useState<Record<string, string[] | null>>({});

  // Per-vendor accessors so the rest of the section can read/write a single
  // "current vendor's" map without re-typing the spread dance everywhere.
  const caseCounts = selectedVendorId ? (caseCountsByVendor[selectedVendorId] || {}) : {};
  const unitCounts = selectedVendorId ? (unitCountsByVendor[selectedVendorId] || {}) : {};
  const notes      = selectedVendorId ? (notesByVendor[selectedVendorId]      || {}) : {};
  const setCaseCounts = React.useCallback((updater: (prev: Record<string, string>) => Record<string, string>) => {
    if (!selectedVendorId) return;
    setCaseCountsByVendor((p) => ({ ...p, [selectedVendorId]: updater(p[selectedVendorId] || {}) }));
  }, [selectedVendorId]);
  const setUnitCounts = React.useCallback((updater: (prev: Record<string, string>) => Record<string, string>) => {
    if (!selectedVendorId) return;
    setUnitCountsByVendor((p) => ({ ...p, [selectedVendorId]: updater(p[selectedVendorId] || {}) }));
  }, [selectedVendorId]);
  const setNotes = React.useCallback((updater: (prev: Record<string, string>) => Record<string, string>) => {
    if (!selectedVendorId) return;
    setNotesByVendor((p) => ({ ...p, [selectedVendorId]: updater(p[selectedVendorId] || {}) }));
  }, [selectedVendorId]);
  const [tabId, setTabId] = React.useState('count.tsx');
  const [addCountOpen, setAddCountOpen] = React.useState(false);
  const [addVendorOpen, setAddVendorOpen] = React.useState(false);
  // Toggle: when ON, bypass the day-of-week schedule filter for the current
  // view. Default OFF — the filter is the whole point of this screen. The
  // toggle never mutates the schedule itself; it's a per-session view escape
  // hatch (Q4=(d)).
  const [showUnscheduled, setShowUnscheduled] = React.useState(false);
  // Items added via + COUNT — unioned into the worksheet regardless of
  // current vendor/category filter so the user sees their addition.
  const [additionalItems, setAdditionalItems] = React.useState<Set<string>>(new Set());
  const [pendingFocusItem, setPendingFocusItem] = React.useState<string | null>(null);
  // Refs to per-row case-count inputs, keyed by itemId. Used by both the
  // AddCountModal jump and the inventory-detail "+ COUNT" button to focus
  // the right cell after the row mounts.
  const caseInputRefs = React.useRef<Record<string, TextInput | null>>({});

  // Consume cross-section "+ COUNT" navigation from item-detail. The layout
  // sets section to 'EODCount' but leaves the action in place specifically so
  // we can read eodFocusItemId here and act on it after mount.
  const pendingPaletteAction = usePaletteAction((s) => s.pending);
  React.useEffect(() => {
    const id = pendingPaletteAction?.eodFocusItemId;
    if (!id) return;
    setAdditionalItems((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setPendingFocusItem(id);
    usePaletteAction.getState().consume();
  }, [pendingPaletteAction]);

  // After the focused row mounts, focus its input + clear the pending flag.
  React.useEffect(() => {
    if (!pendingFocusItem) return;
    // Two RAFs so the row's TextInput has actually mounted and registered its
    // ref before we try to focus.
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const ref = caseInputRefs.current[pendingFocusItem];
        if (ref && typeof ref.focus === 'function') {
          ref.focus();
        }
        setPendingFocusItem(null);
      });
    });
    return () => cancelAnimationFrame(id);
  }, [pendingFocusItem]);

  // ── Week sidebar data ───────────────────────────────────────
  // Spec 020: a single day can now have N submissions (one per vendor).
  // Aggregate counted across vendor submissions and pick the "worst" status
  // — draft beats submitted, late beats nothing — so the day-cell glyph
  // surfaces the issue rather than the optimistic latest.
  const week: DayCell[] = React.useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = localDayIso(today);
    const out: DayCell[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const iso = localDayIso(d);
      const monthDay = `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
      const dayName = DAY_NAMES[d.getDay()];
      const daySubs = eodSubmissions.filter((s) => s.storeId === currentStore.id && s.date === iso);
      const counted = daySubs.reduce((acc, s) => acc + (s.entries?.length || 0), 0);
      const total = inventory.filter((it) => it.storeId === currentStore.id).length;
      // Day-level status (spec 133): derived by the pure `deriveDayStatus`
      // reducer. `'rest'` now comes from the schedule weekday (`isRestWeekday`)
      // — NOT submission absence — so a past uncounted non-rest day resolves to
      // `'uncounted'` (editable) instead of being wrongly locked. today/draft/
      // late/submitted branches are unchanged.
      const anyDraft = daySubs.some((s) => s.status === 'draft');
      const anySubmitted = daySubs.some((s) => s.status === 'submitted');
      const status: DayStatus = deriveDayStatus({
        isToday: iso === todayIso,
        isRestWeekday: isRestWeekday(orderSchedule, dayName),
        anyDraft,
        anySubmitted,
        counted,
        total,
      });
      out.push({ day: dayName, date: monthDay, iso, status, counted, total, vendors: 'all vendors' });
    }
    return out;
  }, [eodSubmissions, currentStore.id, inventory, orderSchedule]);

  // ── Worksheet data ──────────────────────────────────────────
  const storeInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );

  // Day-of-week derived from the selected day cell. TitleCase to match the
  // store's order_schedule slice keys ("Monday".."Sunday"). The +'T00:00:00'
  // anchors to local midnight so day-of-week math doesn't wobble across
  // timezones.
  const selectedDayName = React.useMemo(() => {
    return DAY_NAMES[new Date(selectedIso + 'T00:00:00').getDay()];
  }, [selectedIso]);

  // "Schedule configured" = any day of the week has at least one row for
  // this store. Until that's true we fall back to "all vendors on all days"
  // (Q3=(b)) — no regression for stores that haven't opened the schedule
  // admin yet.
  const scheduleConfigured = React.useMemo(() => {
    return Object.values(orderSchedule || {}).some((arr) => Array.isArray(arr) && arr.length > 0);
  }, [orderSchedule]);

  // Vendor IDs scheduled for the selected weekday. Filter out null/undefined
  // ids defensively (legacy rows pre-vendor_id can show up here).
  const dayScheduledVendorIds = React.useMemo(() => {
    const arr = orderSchedule?.[selectedDayName] || [];
    return new Set(arr.map((v) => v.vendorId).filter((id): id is string => !!id));
  }, [orderSchedule, selectedDayName]);

  // Vendor tabs — only vendors that have items at this store, then filtered
  // by the day's schedule (unless toggle is on, or schedule isn't configured
  // yet for this store).
  const allVendorTabs = React.useMemo(() => {
    // Spec 102 (§6b) — tab membership is derived from the item↔vendor link set
    // (`vendorIds`), not the scalar `vendorId`. A shared item linked to two
    // vendors counts toward BOTH vendors' tab counts and appears under each
    // tab. Back-compat: fall back to the scalar's singleton for legacy
    // in-memory rows that predate the item_vendors embed.
    const counts = new Map<string, number>();
    for (const i of storeInventory) {
      const ids = i.vendorIds ?? (i.vendorId ? [i.vendorId] : []);
      for (const vid of ids) {
        if (vid) counts.set(vid, (counts.get(vid) || 0) + 1);
      }
    }
    return vendors
      .filter((v) => counts.has(v.id))
      .map((v) => ({ ...v, count: counts.get(v.id) || 0 }));
  }, [storeInventory, vendors]);

  const vendorTabs = React.useMemo(() => {
    if (showUnscheduled) return allVendorTabs;       // toggle override
    if (!scheduleConfigured) return allVendorTabs;   // store has no schedule rows at all → fallback
    return allVendorTabs.filter((v) => dayScheduledVendorIds.has(v.id));
  }, [allVendorTabs, showUnscheduled, scheduleConfigured, dayScheduledVendorIds]);

  React.useEffect(() => {
    if (selectedVendorId && vendorTabs.find((v) => v.id === selectedVendorId)) return;
    setSelectedVendorId(vendorTabs[0]?.id || null);
  }, [vendorTabs, selectedVendorId]);

  const vendorItems = React.useMemo(() => {
    if (!selectedVendorId) return [];
    // Spec 102 (§6b) — items in the selected tab are those LINKED to the
    // vendor (junction membership), so a shared item appears under each of its
    // vendor tabs (AC-D / US-2). Back-compat falls back to the scalar.
    return storeInventory.filter((i) =>
      (i.vendorIds ?? (i.vendorId ? [i.vendorId] : [])).includes(selectedVendorId),
    );
  }, [storeInventory, selectedVendorId]);

  // Spec 103 — saved custom order for the CURRENT vendor (per-vendor, OQ-1).
  const savedIds = selectedVendorId ? (savedIdsByVendor[selectedVendorId] ?? null) : null;

  // ─── Spec 103: load the saved order on vendor change ───────────────
  // Order is per-(admin-eod, vendor). On change, fetch this vendor's order; if
  // one exists, open in Custom view (AC-7), else default. A genuine fetch error
  // falls back to default and surfaces via the toast (notifyBackendError).
  React.useEffect(() => {
    const uid = currentUser?.id;
    if (!uid || !selectedVendorId) {
      setViewMode('default');
      return;
    }
    const vid = selectedVendorId;
    let cancelled = false;
    fetchCountOrder(uid, 'admin-eod', vid)
      .then((ids) => {
        if (cancelled) return;
        setSavedIdsByVendor((p) => ({ ...p, [vid]: ids }));
        setViewMode(ids && ids.length > 0 ? 'custom' : 'default');
      })
      .catch((e: any) => {
        if (cancelled) return;
        console.warn('[EOD] fetchCountOrder failed:', e?.message || e);
        setViewMode('default');
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser?.id, selectedVendorId]);

  // Persist-on-drop — optimistic, revert + toast on failure (AC-6).
  const onReorder = React.useCallback(
    (orderedIds: string[]) => {
      const uid = currentUser?.id;
      if (!uid || !selectedVendorId) return;
      const vid = selectedVendorId;
      const prev = savedIdsByVendor[vid] ?? null;
      setSavedIdsByVendor((p) => ({ ...p, [vid]: orderedIds }));
      setViewMode('custom');
      saveCountOrder(uid, 'admin-eod', vid, orderedIds).catch((e: any) => {
        setSavedIdsByVendor((p) => ({ ...p, [vid]: prev }));
        console.warn('[EOD] saveCountOrder failed:', e?.message || e);
        Toast.show({ type: 'error', text1: T('section.eod.savedLocally'), text2: T('section.eod.cloudFailed') });
      });
    },
    [currentUser?.id, selectedVendorId, savedIdsByVendor, T],
  );

  // Reset — clear this vendor's saved order, return to default view.
  const onResetOrder = React.useCallback(() => {
    const uid = currentUser?.id;
    if (!uid || !selectedVendorId) return;
    const vid = selectedVendorId;
    const prev = savedIdsByVendor[vid] ?? null;
    setSavedIdsByVendor((p) => ({ ...p, [vid]: null }));
    setViewMode('default');
    resetCountOrder(uid, 'admin-eod', vid).catch((e: any) => {
      setSavedIdsByVendor((p) => ({ ...p, [vid]: prev }));
      console.warn('[EOD] resetCountOrder failed:', e?.message || e);
      Toast.show({ type: 'error', text1: T('section.eod.savedLocally'), text2: T('section.eod.cloudFailed') });
    });
  }, [currentUser?.id, selectedVendorId, savedIdsByVendor, T]);

  // Spec 020 — vendors already submitted for the selected date at the
  // current store. Drives the per-tab "✓ SUBMITTED" indicator + the lock /
  // EDIT affordance below. Filters out any submission row whose vendorId
  // is falsy defensively (impossible after migration's NOT NULL enforcement,
  // but covers stale local seed data and the unlikely realtime race).
  const submittedVendorIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const s of eodSubmissions) {
      if (!s.vendorId) continue;
      if (s.storeId !== currentStore.id) continue;
      if (s.date !== selectedIso) continue;
      if (s.status !== 'submitted') continue;
      ids.add(s.vendorId);
    }
    return ids;
  }, [eodSubmissions, currentStore.id, selectedIso]);

  // Convenience flags for the currently-active vendor.
  const isCurrentVendorSubmitted = !!selectedVendorId && submittedVendorIds.has(selectedVendorId);
  const isCurrentVendorEditing   = !!selectedVendorId && editingVendorIds.has(selectedVendorId);
  // Inputs read-only when vendor is submitted AND not in EDIT mode. The
  // existing isRestDay gate composes with this (added in render below).
  const isVendorLocked = isCurrentVendorSubmitted && !isCurrentVendorEditing;

  // Submission for the currently-selected (vendor, date) — used both for the
  // EDIT pre-fill and as a fallback to render counts read-only while locked.
  const currentVendorSubmission = React.useMemo(() => {
    if (!selectedVendorId) return null;
    return eodSubmissions.find(
      (s) =>
        s.storeId === currentStore.id &&
        s.date === selectedIso &&
        s.vendorId === selectedVendorId,
    ) || null;
  }, [eodSubmissions, currentStore.id, selectedIso, selectedVendorId]);

  // Spec 020 §9.4 — enter EDIT mode. Inputs unlock, pre-fill from the
  // existing submission's entries. Spread order: user-typed values WIN over
  // server-loaded pre-fills (Q4 — typed-but-unsubmitted survives tab
  // switches, even when re-entering EDIT). If the test-engineer reviewer
  // prefers server-wins it's a spread flip.
  const onEditCurrentVendor = React.useCallback(() => {
    if (!selectedVendorId || !currentVendorSubmission) return;
    const vid = selectedVendorId;
    const sub = currentVendorSubmission;
    setEditingVendorIds((prev) => {
      if (prev.has(vid)) return prev;
      const next = new Set(prev);
      next.add(vid);
      return next;
    });
    setCaseCountsByVendor((p) => ({
      ...p,
      [vid]: {
        ...Object.fromEntries(
          (sub.entries || []).map((e) => [
            e.itemId,
            e.actualRemainingCases != null ? String(e.actualRemainingCases) : '',
          ]),
        ),
        ...(p[vid] || {}),
      },
    }));
    setUnitCountsByVendor((p) => ({
      ...p,
      [vid]: {
        ...Object.fromEntries(
          (sub.entries || []).map((e) => [
            e.itemId,
            e.actualRemainingEach != null
              ? String(e.actualRemainingEach)
              : e.actualRemaining != null
              ? String(e.actualRemaining)
              : '',
          ]),
        ),
        ...(p[vid] || {}),
      },
    }));
    setNotesByVendor((p) => ({
      ...p,
      [vid]: {
        ...Object.fromEntries((sub.entries || []).map((e) => [e.itemId, e.notes || ''])),
        ...(p[vid] || {}),
      },
    }));
  }, [selectedVendorId, currentVendorSubmission]);

  // Category chips — derived from this vendor's items
  const categories = React.useMemo(() => {
    const cats = new Map<string, number>();
    for (const i of vendorItems) cats.set(i.category, (cats.get(i.category) || 0) + 1);
    return [
      { id: 'all', label: `All (${vendorItems.length})` },
      ...Array.from(cats.entries()).map(([cat, n]) => ({ id: cat, label: `${cat} (${n})` })),
    ];
  }, [vendorItems]);

  // NOTE: `filteredItems` drives submission (enteredItems), counters, and
  // totals — it must NOT be narrowed by the name search, or entered counts
  // for searched-out items would be dropped on submit. The search is applied
  // in `grouped` (render only) below.
  const filteredItems = React.useMemo(() => {
    const base = selectedCategory === 'all' ? vendorItems : vendorItems.filter((i) => i.category === selectedCategory);
    if (additionalItems.size === 0) return base;
    const baseIds = new Set(base.map((i) => i.id));
    const extras = storeInventory.filter((i) => additionalItems.has(i.id) && !baseIds.has(i.id));
    return [...base, ...extras];
  }, [vendorItems, selectedCategory, additionalItems, storeInventory]);

  const grouped = React.useMemo(() => {
    // Admin worksheet rows render the raw English `name`, so the search
    // matches that (diacritic-folded via matchesQuery).
    const visible = search.trim()
      ? filteredItems.filter((i) => matchesQuery(search, [i.name]))
      : filteredItems;
    const map = new Map<string, typeof filteredItems>();
    for (const it of visible) {
      const arr = map.get(it.category) || [];
      arr.push(it);
      map.set(it.category, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredItems, search]);

  // Spec 103 — flat Custom view list: the saved ranking applied to the full
  // `filteredItems` (unranked appended, deleted ignored), THEN narrowed by the
  // search (search composes with the custom order — AC-10). Category headers
  // are suppressed in Custom view (OQ-2).
  const customVisibleItems = React.useMemo(() => {
    const ordered = applyCountOrder(filteredItems, savedIds, (i) => i.id);
    if (!search.trim()) return ordered;
    return ordered.filter((i) => matchesQuery(search, [i.name]));
  }, [filteredItems, savedIds, search]);

  // ── Counts/totals ───────────────────────────────────────────
  // total per item = cases × caseQty + loose units. caseQty defaults to 1
  // for items sold individually (BOX/CASE input is hidden/disabled there).
  const itemTotal = (i: typeof filteredItems[0]) => {
    const c = parseFloat(caseCounts[i.id] || '');
    const u = parseFloat(unitCounts[i.id] || '');
    const cases = isNaN(c) ? 0 : c;
    const units = isNaN(u) ? 0 : u;
    return cases * (i.caseQty || 1) + units;
  };
  // Spec 102 (§6c) — counted-once-globally. `localHasEntry` is the CURRENT
  // tab's typed entry (used by buildSubmission — we only ship what was entered
  // under this vendor). `countedItemIds` is the cross-tab + submitted set for
  // this (store, date). `hasEntry` (the gate/counter/styling predicate) ORs
  // them, so a shared item counted under another tab is NOT an outstanding gap
  // here.
  const countedItemIds = React.useMemo(
    () =>
      deriveCountedItemIds({
        caseCountsByVendor,
        unitCountsByVendor,
        submissions: eodSubmissions,
        storeId: currentStore.id,
        dateIso: selectedIso,
      }),
    [caseCountsByVendor, unitCountsByVendor, eodSubmissions, currentStore.id, selectedIso],
  );
  const localHasEntry = (id: string) =>
    (caseCounts[id] ?? '').trim() !== '' || (unitCounts[id] ?? '').trim() !== '';
  const hasEntry = (id: string) => localHasEntry(id) || countedItemIds.has(id);
  const countedNum = filteredItems.filter((i) => hasEntry(i.id)).length;
  const total = filteredItems.length;
  // Est. value / variance read the CURRENT tab's typed totals (itemTotal reads
  // this tab's inputs), so they sum only locally-entered rows — a shared item
  // counted under another tab is blank here and must not skew the footer with a
  // 0-total row (which would otherwise subtract its full currentStock from
  // variance). It still counts toward `countedNum` (counted-once-globally).
  const estValue = filteredItems.reduce((s, i) => {
    if (!localHasEntry(i.id)) return s;
    // Spec 104 (OQ-5) — itemTotal is in COUNTED units, costPerUnit is per-each
    // → `× subUnitSize` bridge so the count-screen dollar total is unchanged.
    return s + itemTotal(i) * i.costPerUnit * (i.subUnitSize || 1);
  }, 0);
  const variance = filteredItems.reduce((s, i) => {
    if (!localHasEntry(i.id)) return s;
    return s + (itemTotal(i) - i.currentStock);
  }, 0);

  // Build the submission payload from current entered items. Returns null if
  // no qty was entered (avoids empty-submit DB writes).
  // Spec 020: includes vendorId + vendorName so the per-vendor RPC and the
  // store's merge lookup partition correctly. The TODO call out below tracks
  // the type widening backend-dev is shipping in src/types/index.ts.
  const buildSubmission = (status: 'draft' | 'submitted') => {
    // Spec 102 (§6c) — ship only items entered IN THIS TAB (localHasEntry), not
    // items counted under another vendor's tab. The shared item's on-hand is
    // reconciled server-side (§5) when it IS entered under this vendor; if it
    // was only counted elsewhere it simply isn't part of this submission.
    const enteredItems = filteredItems.filter((i) => localHasEntry(i.id));
    if (enteredItems.length === 0) return null;
    if (!selectedVendorId) return null;
    const vendorName =
      vendorTabs.find((v) => v.id === selectedVendorId)?.name ||
      vendors.find((v) => v.id === selectedVendorId)?.name ||
      '';
    const now = new Date().toISOString();
    const entries: Omit<EODEntry, 'id'>[] = enteredItems.map((i) => {
      const cRaw = parseFloat(caseCounts[i.id] || '');
      const uRaw = parseFloat(unitCounts[i.id] || '');
      const cases = isNaN(cRaw) ? undefined : cRaw;
      const units = isNaN(uRaw) ? undefined : uRaw;
      const total = (cases ?? 0) * (i.caseQty || 1) + (units ?? 0);
      return {
        itemId: i.id,
        itemName: i.name,
        actualRemaining: total,
        actualRemainingCases: cases,
        actualRemainingEach: units,
        unit: i.unit,
        submittedBy: currentUser?.name || 'unknown',
        submittedByUserId: currentUser?.id || '',
        timestamp: now,
        date: selectedIso,
        storeId: currentStore.id,
        notes: notes[i.id] || '',
      };
    });
    // Spec 020: vendorId is required on EODSubmission; vendorName is hydrated
    // client-side for display. submitEOD's local merge + submitEODCount's
    // PostgREST upsert both partition on (storeId, date, vendorId).
    const submission: Omit<EODSubmission, 'id'> = {
      date: selectedIso,
      storeId: currentStore.id,
      storeName: currentStore.name,
      vendorId: selectedVendorId,
      vendorName,
      submittedBy: currentUser?.name || 'unknown',
      submittedByUserId: currentUser?.id || '',
      timestamp: now,
      itemCount: entries.length,
      status,
      entries: entries as EODEntry[],
    };
    return submission;
  };

  const onSaveDraft = async () => {
    const submission = buildSubmission('draft');
    if (!submission) {
      Toast.show({ type: 'error', text1: T('section.eod.enterAtLeastOne') });
      return;
    }
    setSubmitting(true);
    submitEOD(submission);
    try {
      await submitEODCount(submission);
      const submitterShort = (currentUser?.name || 'me').toLowerCase().split(' ')[0];
      const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      Toast.show({
        type: 'info',
        text1: T('section.eod.draftSavedToast'),
        text2: T('section.eod.draftSavedDetail', {
          itemCount: submission.itemCount,
          totalItems: filteredItems.length,
          time,
          user: submitterShort,
        }),
      });
    } catch (e: any) {
      console.warn('[EOD] draft save failed:', e?.message || e);
      Toast.show({ type: 'error', text1: T('section.eod.savedLocally'), text2: T('section.eod.cloudFailed') });
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = async () => {
    // Completeness gate (spec) — every item in the current worksheet scope
    // (`filteredItems`, the same set buildSubmission ships) must be counted,
    // even "0", before a final submit; partial work goes through Save Draft.
    // A row counts once EITHER box has a value (hasEntry). Block on the first
    // blank, clear the search so a searched-out row can render, and reuse the
    // palette-action focus path to jump to it.
    // Completeness COUNT is against the full `filteredItems`, order-independent
    // (AC-9). The JUMP target (AC-12) follows the on-screen order: in Custom
    // view, the topmost uncounted in the user's saved order; in default view,
    // `filteredItems` order. Resolve against the FULL set (not the
    // search-narrowed view), matching the clear-search-then-jump behavior.
    const missing = filteredItems.filter((i) => !hasEntry(i.id));
    if (missing.length > 0) {
      if (search.trim()) setSearch('');
      const ordered =
        viewMode === 'custom'
          ? applyCountOrder(filteredItems, savedIds, (i) => i.id)
          : filteredItems;
      const target = firstUncounted(ordered, (i) => hasEntry(i.id));
      setPendingFocusItem((target ?? missing[0]).id);
      Toast.show({
        type: 'error',
        text1: T('section.eod.countAllTitle'),
        text2: T('section.eod.countAllRemaining', { count: missing.length }),
      });
      return;
    }
    const submission = buildSubmission('submitted');
    if (!submission) {
      Toast.show({ type: 'error', text1: T('section.eod.enterAtLeastOne') });
      return;
    }
    if (!selectedVendorId) {
      // Defensive — vendorTabs effect should always seat a vendor; bail to
      // avoid sending a vendor-less submission to the per-vendor RPC.
      Toast.show({ type: 'error', text1: T('section.eod.pickVendor') });
      return;
    }
    setSubmitting(true);
    submitEOD(submission);
    try {
      await submitEODCount(submission);
      // Spec 020: clear only THIS vendor's draft after submit; other vendors'
      // typed-but-unsaved drafts survive (Q4). Also drop EDIT mode for the
      // vendor so it relocks to the read-only view. Moved inside the try
      // (post-await) per code-reviewer S1 — clearing before the cloud write
      // dropped the user's typed values on cloud failure, which is the worst
      // possible UX for the escape-hatch path where the items aren't on the
      // server-rendered list yet.
      setCaseCountsByVendor((p) => ({ ...p, [selectedVendorId]: {} }));
      setUnitCountsByVendor((p) => ({ ...p, [selectedVendorId]: {} }));
      setNotesByVendor((p) => ({ ...p, [selectedVendorId]: {} }));
      setEditingVendorIds((prev) => {
        if (!prev.has(selectedVendorId)) return prev;
        const next = new Set(prev);
        next.delete(selectedVendorId);
        return next;
      });
      Toast.show({
        type: 'success',
        text1: T('section.eod.countSubmitted'),
        text2: T('section.eod.countSubmittedDetail', {
          itemCount: submission.itemCount,
          date: selectedIso,
        }),
      });
      // 2026-07 — on a successful submit, jump to the Reorder section so the
      // manager both sees the count landed AND lands on the list it feeds.
      usePaletteAction.getState().request({ section: 'Reorder', selectedName: null });
    } catch (e: any) {
      console.warn('[EOD] cloud save failed:', e?.message || e);
      Toast.show({ type: 'error', text1: T('section.eod.savedLocally'), text2: T('section.eod.cloudFailed') });
    } finally {
      setSubmitting(false);
    }
  };

  // Spec 103 — one shared worksheet row, rendered by BOTH the default
  // category-grouped view and the flat Custom drag view, so Custom shows
  // byte-identical rows (the custom order is render-only). `showTopBorder`
  // draws the dashed inter-row rule (grouped view suppresses it on the first
  // row of each group; the flat Custom list suppresses it only on the very
  // first row). Factored out of the grouped `items.map`.
  const renderEodRow = (it: typeof filteredItems[0], showTopBorder: boolean) => {
    const submittedEntry = isVendorLocked
      ? currentVendorSubmission?.entries.find((e) => e.itemId === it.id)
      : null;
    const cVal = isVendorLocked
      ? submittedEntry?.actualRemainingCases != null
        ? String(submittedEntry.actualRemainingCases)
        : ''
      : caseCounts[it.id] || '';
    const uVal = isVendorLocked
      ? submittedEntry?.actualRemainingEach != null
        ? String(submittedEntry.actualRemainingEach)
        : submittedEntry?.actualRemaining != null
        ? String(submittedEntry.actualRemaining)
        : ''
      : unitCounts[it.id] || '';
    const nVal = isVendorLocked ? submittedEntry?.notes || '' : notes[it.id] || '';
    const cFocused = cVal.trim() !== '';
    const uFocused = uVal.trim() !== '';
    const hasCase = (it.caseQty || 0) > 1;
    const total = itemTotal(it);
    const inputsDisabled = isRestDay || isVendorLocked;
    const rowUncounted = !inputsDisabled && !cFocused && !uFocused && !hasEntry(it.id);
    return (
      <View
        key={it.id}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 10,
          gap: rowGap,
          borderTopWidth: showTopBorder ? 1 : 0,
          borderTopColor: C.border,
          borderStyle: 'dashed',
        }}
      >
        <View style={{ flex: isPhone ? 2 : 1, minWidth: 0 }}>
          <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: rowUncounted ? C.danger : C.fg, letterSpacing: -0.1 }}>
            {it.name}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, marginTop: 2 }}>
            {it.unit}{hasCase ? ` · case ${it.caseQty}` : ''}{it.parLevel > 0 ? ` · par ${it.parLevel}` : ''}
            {hasCase && (cFocused || uFocused) ? ` · total ${total} ${it.unit}` : ''}
          </Text>
        </View>
        <View style={{ width: cellW, alignItems: 'center' }}>
          <TextInput
            ref={(r) => {
              if (hasCase) caseInputRefs.current[it.id] = r;
            }}
            value={hasCase ? cVal : ''}
            editable={hasCase && !inputsDisabled}
            onChangeText={(text) => setCaseCounts((p) => ({ ...p, [it.id]: text }))}
            placeholder={hasCase ? '0' : '—'}
            placeholderTextColor={C.fg3}
            keyboardType="numeric"
            style={{
              width: inputW,
              height: 30,
              textAlign: 'center',
              fontFamily: mono(600),
              fontSize: 13,
              color: hasCase ? (cFocused ? C.fg : C.fg2) : C.fg3,
              backgroundColor: hasCase ? (cFocused ? C.panel2 : C.panel) : C.panel,
              borderWidth: 1,
              borderColor: cFocused ? C.accent : (hasCase && rowUncounted ? C.danger : C.border),
              borderRadius: CmdRadius.sm,
              opacity: !hasCase || inputsDisabled ? 0.5 : 1,
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
            }}
          />
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, marginTop: 3 }}>
            {hasCase ? `× ${it.caseQty}` : '—'}
          </Text>
        </View>
        <View style={{ width: cellW, alignItems: 'center' }}>
          <TextInput
            ref={(r) => {
              if (!hasCase) caseInputRefs.current[it.id] = r;
            }}
            value={uVal}
            editable={!inputsDisabled}
            onChangeText={(text) => setUnitCounts((p) => ({ ...p, [it.id]: text }))}
            placeholder="0"
            placeholderTextColor={C.fg3}
            keyboardType="numeric"
            style={{
              width: inputW,
              height: 30,
              textAlign: 'center',
              fontFamily: mono(600),
              fontSize: 13,
              color: uFocused ? C.fg : C.fg2,
              backgroundColor: uFocused ? C.panel2 : C.panel,
              borderWidth: 1,
              borderColor: uFocused ? C.accent : (rowUncounted ? C.danger : C.border),
              borderRadius: CmdRadius.sm,
              opacity: inputsDisabled ? 0.5 : 1,
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
            }}
          />
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, marginTop: 3 }}>
            {it.unit}
          </Text>
        </View>
        <TextInput
          value={nVal}
          editable={!inputsDisabled}
          onChangeText={(text) => setNotes((p) => ({ ...p, [it.id]: text }))}
          placeholder={T('section.eod.notePlaceholder')}
          placeholderTextColor={C.fg3}
          style={{
            ...(isPhone ? { flex: 1, minWidth: 0 } : { width: 180 }),
            height: 30,
            paddingHorizontal: 10,
            fontFamily: mono(400),
            fontSize: 11.5,
            color: C.fg2,
            backgroundColor: C.panel,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: CmdRadius.sm,
            opacity: inputsDisabled ? 0.5 : 1,
            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
          }}
        />
      </View>
    );
  };

  const wkNum = (() => {
    const d = new Date();
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + yearStart.getDay() + 1) / 7);
  })();

  const dayPillFor = (status: DayStatus): { fg: string; bg: string; label: string } => {
    if (status === 'today')     return { fg: C.accent, bg: C.accentBg, label: T('section.eod.today') };
    if (status === 'submitted') return { fg: C.ok,     bg: C.okBg,     label: T('section.eod.submitted') };
    if (status === 'draft')     return { fg: C.info,   bg: C.infoBg,   label: T('section.eod.draft') };
    if (status === 'late')      return { fg: C.warn,   bg: C.warnBg,   label: T('section.eod.late') };
    // Spec 133 — a past, non-rest, uncounted day. Violet = "count not
    // submitted / needs a count", same token as spec 130's reorder gate, so
    // the concept reads identically across the EOD and Reorder sections.
    if (status === 'uncounted') return { fg: C.violet, bg: C.violetBg, label: T('section.eod.uncounted') };
    return { fg: C.fg3, bg: C.panel2, label: T('section.eod.rest') };
  };

  // REST day flag — drives input/action disable below. Only the SELECTED
  // day's status matters here; the week sidebar still reduces opacity per
  // day cell as before.
  const selectedDayCell = week.find((d) => d.iso === selectedIso);
  const isRestDay = selectedDayCell?.status === 'rest';

  // __all__ defensive guard. setCurrentStore redirects __all__ to a real
  // store before currentStore.id ever reaches that value in normal flow,
  // but cover the brief pre-load window + any future call-site that bypasses
  // setCurrentStore (e.g. direct set state).
  if (!currentStore?.id || currentStore.id === '__all__') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}>
        <Text style={{ fontFamily: mono(400), fontSize: 13, color: C.fg2 }}>
          {T('section.eod.selectStoreToCount')}
        </Text>
      </View>
    );
  }

  // Spec 055 first-mount skeleton — eodSubmissions slice loads in the
  // store's loadFromSupabase fan-out; show a list skeleton until the
  // first fetch resolves (success OR empty).
  if (storeLoading && eodSubmissions.length === 0) {
    return <ListSkeleton rows={4} />;
  }

  return (
    <>
      {/* Week sidebar — hidden on phone; replaced by horizontal day-strip
          rendered above the TabStrip inside the worksheet below. */}
      {!isPhone && (
      <View
        style={{
          width: 240,
          backgroundColor: C.panel,
          borderRightWidth: 1,
          borderRightColor: C.border,
        }}
      >
        <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: C.border, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <Text style={[Type.h2, { color: C.fg }]}>{T('common.thisWeek')}</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{T('section.eod.weekShort', { num: wkNum })}</Text>
          </View>
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            {(currentStore.name || T('chrome.store')).toLowerCase()}
          </Text>
        </View>
        <FlatList
          data={week}
          keyExtractor={(d) => d.iso}
          renderItem={({ item: d, index: i }) => {
            const isSel = d.iso === selectedIso;
            const dotColor =
              d.status === 'today' ? C.accent
              : d.status === 'submitted' ? C.ok
              : d.status === 'late' ? C.warn
              : C.fg3;
            const pill = dayPillFor(d.status);
            const isRest = d.status === 'rest';
            return (
              <TouchableOpacity
                onPress={() => setSelectedIso(d.iso)}
                activeOpacity={0.85}
                style={{
                  paddingHorizontal: 16 - (isSel ? 2 : 0),
                  paddingVertical: 10,
                  borderBottomWidth: i === 6 ? 0 : 1,
                  borderBottomColor: C.border,
                  borderLeftWidth: isSel ? 2 : 0,
                  borderLeftColor: C.accent,
                  backgroundColor: isSel ? C.accentBg : 'transparent',
                  opacity: isRest ? 0.55 : 1,
                  gap: 5,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 99, backgroundColor: dotColor }} />
                  <Text style={{ fontFamily: sans(d.status === 'today' ? 700 : 600), fontSize: 13, color: C.fg, flex: 1 }}>
                    {dayOfWeekLongLabel(d.day, T)}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, fontVariant: ['tabular-nums'] }}>
                    {d.date}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 15 }}>
                  <View style={{ paddingHorizontal: 9, paddingVertical: 2, borderRadius: CmdRadius.pill, borderWidth: 0.5, borderColor: d.status === 'rest' ? C.border : pill.fg, backgroundColor: pill.bg }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 9, color: pill.fg, letterSpacing: 0.5 }}>
                      {pill.label.toUpperCase()}
                    </Text>
                  </View>
                  {!isRest ? (
                    <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg2, fontVariant: ['tabular-nums'] }}>
                      {d.counted}/{d.total}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          }}
        />
        <View style={{ paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{T('section.eod.weekTotal')}</Text>
          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg }}>
            {week.reduce((s, d) => s + d.counted, 0)}/{week.reduce((s, d) => s + d.total, 0)}
          </Text>
        </View>
      </View>
      )}

      {/* Worksheet */}
      <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
        {isPhone && (
          <View style={{ borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel }}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}
            >
              {week.map((d) => {
                const isSel = d.iso === selectedIso;
                const dotColor =
                  d.status === 'today' ? C.accent
                  : d.status === 'submitted' ? C.ok
                  : d.status === 'late' ? C.warn
                  : C.fg3;
                const isRest = d.status === 'rest';
                return (
                  <TouchableOpacity
                    key={d.iso}
                    onPress={() => setSelectedIso(d.iso)}
                    activeOpacity={0.85}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: CmdRadius.sm,
                      borderWidth: 1,
                      borderColor: isSel ? C.accent : C.border,
                      backgroundColor: isSel ? C.accentBg : 'transparent',
                      opacity: isRest ? 0.55 : 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 7,
                    }}
                  >
                    <View style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: dotColor }} />
                    <View>
                      <Text style={{ fontFamily: sans(isSel ? 700 : 600), fontSize: 11, color: C.fg }}>
                        {dayOfWeekShortLabel(d.day, T)}
                      </Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, fontVariant: ['tabular-nums'] }}>
                        {d.date}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}
        <TabStrip
          tabs={[
            // Filename-style literals stay verbatim per spec instructions —
            // they look like file paths (count.tsx / history.tsx /
            // variance.log) and read as commands rather than English text.
            { id: 'count.tsx',      label: 'count.tsx' },
            { id: 'history.tsx',    label: 'history.tsx' },
            { id: 'variance.log',   label: 'variance.log' },
            { id: 'order-schedule', label: T('section.purchaseOrders.scheduleTitle') },
          ]}
          activeId={tabId}
          onChange={setTabId}
          rightSlot={tabId === 'order-schedule' ? undefined : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                {new Date().toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' })}
              </Text>
              <View style={{ width: 1, height: 16, backgroundColor: C.border }} />
              {isRestDay ? (
                // REST DAY pill — Q7=(a) with read-only enforcement. Echoes
                // the per-day-cell pill in the week sidebar so the user sees
                // a matching signal at the worksheet head.
                <View style={{ paddingHorizontal: 9, paddingVertical: 3, borderRadius: CmdRadius.pill, backgroundColor: C.warnBg, borderWidth: 0.5, borderColor: C.warn }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.warn, letterSpacing: 0.5 }}>
                    {T('section.eod.restDayLabel')}
                  </Text>
                </View>
              ) : null}
              {/* Spec 020 — when the selected vendor is submitted-and-locked,
                  hide + COUNT / SAVE DRAFT / SUBMIT and show EDIT instead.
                  The locked-vendor SUBMITTED chip echoes the per-tab indicator
                  so the user sees a matching signal at the worksheet head. */}
              {isVendorLocked ? (
                <>
                  <View style={{ paddingHorizontal: 9, paddingVertical: 3, borderRadius: CmdRadius.pill, backgroundColor: C.okBg, borderWidth: 0.5, borderColor: C.ok }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.ok, letterSpacing: 0.5 }}>
                      {T('section.eod.submittedLocked')}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={onEditCurrentVendor}
                    accessibilityRole="button"
                    accessibilityLabel={T('section.eod.editAria')}
                    style={{
                      paddingVertical: 4, paddingHorizontal: 12,
                      borderWidth: 1, borderColor: C.fg, borderRadius: CmdRadius.sm,
                      backgroundColor: C.panel,
                    }}
                  >
                    <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg, letterSpacing: 0.5 }}>
                      {T('section.eod.edit')}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity
                    onPress={() => setAddCountOpen(true)}
                    disabled={isRestDay}
                    style={{
                      paddingVertical: 4, paddingHorizontal: 10,
                      borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm,
                      opacity: isRestDay ? 0.4 : 1,
                      ...(Platform.OS === 'web' && isRestDay ? ({ pointerEvents: 'none' } as any) : {}),
                    }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.eod.addCount')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={onSaveDraft}
                    disabled={submitting || isRestDay}
                    style={{
                      paddingVertical: 4, paddingHorizontal: 10,
                      borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm,
                      opacity: (submitting || isRestDay) ? (isRestDay ? 0.4 : 0.6) : 1,
                      ...(Platform.OS === 'web' && isRestDay ? ({ pointerEvents: 'none' } as any) : {}),
                    }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.eod.saveDraft')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={onSubmit}
                    disabled={submitting || isRestDay}
                    accessibilityRole="button"
                    accessibilityLabel={isCurrentVendorEditing ? T('section.eod.updateCount') : T('section.eod.submitCount')}
                    style={{
                      paddingVertical: 4, paddingHorizontal: 10,
                      backgroundColor: C.accent, borderRadius: CmdRadius.sm,
                      opacity: (submitting || isRestDay) ? (isRestDay ? 0.4 : 0.6) : 1,
                      ...(Platform.OS === 'web' && isRestDay ? ({ pointerEvents: 'none' } as any) : {}),
                    }}
                  >
                    <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.accentFg }}>
                      {isCurrentVendorEditing ? T('section.eod.updateCount') : T('section.eod.submitCount')}
                    </Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}
        />

        {tabId === 'history.tsx' ? (
          <EODHistoryTab />
        ) : tabId === 'variance.log' ? (
          <VarianceLogTab />
        ) : tabId === 'order-schedule' ? (
          <OrderScheduleSection />
        ) : (<>
        {/* Sticky filter chrome */}
        <View style={{ backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border, paddingHorizontal: rowPadH, paddingTop: 12, paddingBottom: 10, gap: 10 }}>
          {/* Vendor tabs — phone: horizontal scroll (10 vendors otherwise wrap
              into 10 rows of pills, eating ~350px of vertical space before any
              item is visible). Desktop keeps wrap behavior. */}
          {(() => {
          const vendorPillsChildren = (
            <>
            {vendorTabs.map((v) => {
              const sel = v.id === selectedVendorId;
              // A vendor pill counts as "scheduled for today" only when the
              // schedule is configured AND the vendor id is in the day's set.
              // When the toggle is on or schedule isn't configured, no
              // vendors are "scheduled" in the per-day sense — the × remove
              // affordance only shows when the vendor is actually in the
              // day's schedule, since otherwise removeOrderScheduleEntry is
              // a no-op for the user's view.
              const isScheduledToday = scheduleConfigured && dayScheduledVendorIds.has(v.id);
              // Spec 020 — submitted indicator on the vendor chip. Server
              // state, computed once per (date, store). Editing a previously-
              // submitted vendor still shows the ✓ since the submission
              // exists; only successful unsubmit (not supported in this spec)
              // would drop it.
              const isSubmittedHere = submittedVendorIds.has(v.id);
              return (
                <View
                  key={v.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderRadius: CmdRadius.md,
                    borderWidth: 1,
                    borderColor: sel ? C.fg : (isSubmittedHere ? C.ok : C.border),
                    backgroundColor: sel ? C.fg : C.panel,
                  }}
                >
                  <TouchableOpacity
                    onPress={() => { setSelectedVendorId(v.id); setSelectedCategory('all'); }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    {isSubmittedHere ? (
                      <Text
                        accessibilityLabel={T('section.eod.submittedAria')}
                        style={{
                          fontFamily: mono(700),
                          fontSize: 11,
                          color: sel ? C.bg : C.ok,
                        }}
                      >
                        ✓
                      </Text>
                    ) : (
                      // Mirror of the staff chip's spec-129 status badge: red
                      // dot while this vendor's count is outstanding for the
                      // selected (store, date). C.danger stays legible on the
                      // selected chip's light C.fg background.
                      <Text
                        accessibilityLabel={T('section.eod.notSubmittedAria')}
                        style={{
                          fontFamily: mono(700),
                          fontSize: 11,
                          color: C.danger,
                        }}
                      >
                        ●
                      </Text>
                    )}
                    <Text style={{ fontFamily: mono(sel ? 700 : 500), fontSize: 11, color: sel ? C.bg : C.fg2 }}>
                      {v.name.toUpperCase()} ({v.count})
                    </Text>
                    {!isPhone && v.orderCutoffTime ? (
                      <Text style={{ fontFamily: mono(400), fontSize: 10, color: sel ? C.bg : C.fg3, opacity: 0.7 }}>
                        {T('section.eod.cutoffSuffix', { time: v.orderCutoffTime })}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                  {isScheduledToday ? (
                    // Subtle "×" remove affordance. Architect §6: keep it
                    // inline so add+remove are symmetric, but small enough
                    // that it doesn't look like a primary count action.
                    <TouchableOpacity
                      onPress={() => {
                        if (!removeOrderScheduleEntry) return;
                        removeOrderScheduleEntry(selectedDayName, v.id);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={T('section.eod.removeVendorAria', { vendor: v.name, day: selectedDayName })}
                      style={{
                        paddingHorizontal: 7,
                        paddingVertical: 6,
                        borderLeftWidth: 1,
                        borderLeftColor: sel ? C.bg : C.border,
                      }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 11, color: sel ? C.bg : C.fg3, opacity: 0.7 }}>×</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })}
            {vendorTabs.length === 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                {scheduleConfigured && !showUnscheduled
                  ? T('section.eod.noVendorsScheduled', { day: selectedDayName.toLowerCase() })
                  : T('section.eod.noVendorsAtStore')}
              </Text>
            ) : null}
            {/* + vendor button — opens the vendor picker modal scoped to
                vendors not already on this day's schedule. Disabled when
                we're showing unscheduled vendors (the schedule is the wrong
                surface to mutate from there) or in __all__ (defensive). */}
            <TouchableOpacity
              onPress={() => setAddVendorOpen(true)}
              disabled={showUnscheduled}
              accessibilityRole="button"
              accessibilityLabel={T('section.eod.addVendorAria', { day: selectedDayName })}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: CmdRadius.md,
                borderWidth: 1,
                borderColor: C.borderStrong,
                borderStyle: 'dashed',
                backgroundColor: C.panel,
                opacity: showUnscheduled ? 0.4 : 1,
              }}
            >
              <Text style={{ fontFamily: mono(600), fontSize: 11, color: C.fg2 }}>{T('section.eod.addVendorButton')}</Text>
            </TouchableOpacity>
            {/* Show-unscheduled toggle. Q4=(d): bypass filter for this view
                only; never mutates the schedule. Hidden when the store has
                no schedule rows at all (the toggle would be a no-op). */}
            {scheduleConfigured ? (
              <TouchableOpacity
                onPress={() => setShowUnscheduled((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ selected: showUnscheduled }}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: CmdRadius.md,
                  borderWidth: 1,
                  borderColor: showUnscheduled ? C.accent : C.border,
                  backgroundColor: showUnscheduled ? C.accentBg : 'transparent',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <View
                  style={{
                    width: 9, height: 9, borderRadius: 2,
                    borderWidth: 1, borderColor: showUnscheduled ? C.accent : C.borderStrong,
                    backgroundColor: showUnscheduled ? C.accent : 'transparent',
                  }}
                />
                <Text style={{ fontFamily: mono(showUnscheduled ? 700 : 500), fontSize: 10.5, color: showUnscheduled ? C.accent : C.fg3 }}>
                  {T('section.eod.showUnscheduled')}
                </Text>
              </TouchableOpacity>
            ) : null}
            </>
          );
          return isPhone ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ flexDirection: 'row', gap: 6, alignItems: 'center', paddingRight: 12 }}
            >
              {vendorPillsChildren}
            </ScrollView>
          ) : (
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {vendorPillsChildren}
            </View>
          );
          })()}
          {/* Divider between vendor pills and category chips */}
          <View style={{ height: 1, backgroundColor: C.border, borderStyle: 'dashed', borderTopWidth: 1, borderTopColor: C.border, opacity: 0.7 }} />
          {/* Ingredient-name search — narrows the worksheet rows within the
              current vendor/category view (view-only). */}
          <FilterInput
            value={search}
            onChangeText={setSearch}
            placeholder={T('section.eod.searchPlaceholder')}
            showKbdHint={false}
          />
          {/* Spec 103 — Default ⇄ Custom view toggle + per-vendor reset. Custom
              flattens the worksheet into the user's saved drag order. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <TouchableOpacity
              testID="eod-view-default"
              onPress={() => setViewMode('default')}
              accessibilityRole="button"
              accessibilityState={{ selected: viewMode === 'default' }}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: CmdRadius.md,
                borderWidth: 1,
                borderColor: viewMode === 'default' ? C.accent : C.border,
                backgroundColor: viewMode === 'default' ? C.accentBg : C.panel,
              }}
            >
              <Text style={{ fontFamily: mono(viewMode === 'default' ? 700 : 500), fontSize: 10.5, color: viewMode === 'default' ? C.accent : C.fg2 }}>
                {T('section.countOrder.viewDefault')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="eod-view-custom"
              onPress={() => setViewMode('custom')}
              accessibilityRole="button"
              accessibilityState={{ selected: viewMode === 'custom' }}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: CmdRadius.md,
                borderWidth: 1,
                borderColor: viewMode === 'custom' ? C.accent : C.border,
                backgroundColor: viewMode === 'custom' ? C.accentBg : C.panel,
              }}
            >
              <Text style={{ fontFamily: mono(viewMode === 'custom' ? 700 : 500), fontSize: 10.5, color: viewMode === 'custom' ? C.accent : C.fg2 }}>
                {T('section.countOrder.viewCustom')}
              </Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            {savedIds && savedIds.length > 0 ? (
              <TouchableOpacity
                testID="eod-reset-order"
                onPress={onResetOrder}
                accessibilityRole="button"
                accessibilityLabel={T('section.countOrder.reset')}
                style={{ paddingHorizontal: 8, paddingVertical: 5 }}
              >
                <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.accent }}>
                  {T('section.countOrder.reset')}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {/* Category chips — phone: horizontal scroll (same rationale as
              vendor pills above). */}
          {(() => {
          const categoryChipsChildren = categories.map((c) => {
            const sel = c.id === selectedCategory;
            return (
              <TouchableOpacity
                key={c.id}
                onPress={() => setSelectedCategory(c.id)}
                style={{
                  paddingHorizontal: 11,
                  paddingVertical: 5,
                  borderRadius: 99,
                  borderWidth: 1,
                  borderColor: sel ? C.accent : C.border,
                  backgroundColor: sel ? C.accentBg : C.panel,
                }}
              >
                <Text style={{ fontFamily: mono(sel ? 700 : 500), fontSize: 11, color: sel ? C.accent : C.fg2 }}>
                  {c.label}
                </Text>
              </TouchableOpacity>
            );
          });
          return isPhone ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ flexDirection: 'row', gap: 6, alignItems: 'center', paddingRight: 12 }}
            >
              {categoryChipsChildren}
            </ScrollView>
          ) : (
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {categoryChipsChildren}
            </View>
          );
          })()}
          {/* Status line */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: isPhone ? 6 : 10, flexWrap: isPhone ? 'wrap' : 'nowrap' }}>
            <StatusDot status={countedNum === total ? 'ok' : countedNum > 0 ? 'low' : 'info'} />
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              {T('section.eod.countedOfTotal', { counted: countedNum, total })}
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg2 }}>
              {T('section.eod.vendorLabel')} {vendorTabs.find((v) => v.id === selectedVendorId)?.name?.toUpperCase() || '—'}
            </Text>
            {!isPhone && <View style={{ flex: 1 }} />}
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              {T('section.eod.counterLabel')} <Text style={{ color: C.fg }}>{currentUser?.name?.toLowerCase().replace(/\s+/g, '.') || T('section.eod.guest')}</Text>
            </Text>
          </View>
        </View>

        {/* Item list */}
        <ScrollView contentContainerStyle={{ paddingHorizontal: rowPadH, paddingTop: 8, paddingBottom: 80 }}>
          {/* Spec 020 — inline lock banner. Sits between the filter chrome
              and the table to explain why inputs are read-only. Echoes the
              SUBMITTED · LOCKED chip in the rightSlot. */}
          {isVendorLocked ? (
            <View
              style={{
                marginTop: 8,
                paddingVertical: 8,
                paddingHorizontal: 12,
                backgroundColor: C.okBg,
                borderWidth: 1,
                borderColor: C.ok,
                borderRadius: CmdRadius.sm,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.ok, letterSpacing: 0.5 }}>
                {T('section.eod.submittedBanner')}
              </Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, flex: 1 }}>
                {T('section.eod.submittedBannerBody', { date: selectedIso })}
              </Text>
            </View>
          ) : null}
          {isCurrentVendorEditing ? (
            <View
              style={{
                marginTop: 8,
                paddingVertical: 8,
                paddingHorizontal: 12,
                backgroundColor: C.accentBg,
                borderWidth: 1,
                borderColor: C.accent,
                borderRadius: CmdRadius.sm,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.accent, letterSpacing: 0.5 }}>
                {T('section.eod.editingBanner')}
              </Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, flex: 1 }}>
                {T('section.eod.editingBannerBody')}
              </Text>
            </View>
          ) : null}
          {/* Column header */}
          <View style={{ flexDirection: 'row', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, borderStyle: 'dashed', gap: rowGap }}>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, flex: isPhone ? 2 : 1 }]}>{T('section.eod.itemPackCol')}</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: cellW, textAlign: 'center' }]}>{T('section.eod.boxCaseCol')}</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: cellW, textAlign: 'center' }]}>{T('section.eod.countCol')}</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, ...(isPhone ? { flex: 1, minWidth: 0 } : { width: 180 }) }]}>{T('section.eod.noteCol')}</Text>
          </View>
          {viewMode === 'custom' ? (
            // Spec 103 — flat Custom view in the user's saved drag order,
            // category headers suppressed (OQ-2). Drag/▲▼ reorder is disabled
            // while a search is active (the visible subset isn't the full
            // order). Rows are byte-identical to the grouped view (renderEodRow).
            customVisibleItems.length === 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 32, textAlign: 'center' }}>
                {T('section.eod.noItemsInFilter')}
              </Text>
            ) : (
              <View style={{ marginTop: 14 }}>
                {search.trim()
                  ? customVisibleItems.map((it, i) => renderEodRow(it, i !== 0))
                  : (
                    <CountOrderDragList
                      items={customVisibleItems}
                      onReorder={onReorder}
                      renderRow={(it) => renderEodRow(it, false)}
                    />
                  )}
              </View>
            )
          ) : grouped.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 32, textAlign: 'center' }}>
              {T('section.eod.noItemsInFilter')}
            </Text>
          ) : (
            grouped.map(([cat, items], gi) => (
              <View key={cat} style={{ marginTop: gi === 0 ? 14 : 22 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.7, textTransform: 'uppercase' }}>
                    // {cat.toLowerCase()}
                  </Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: C.border }} />
                  <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg3 }}>
                    {T('section.eod.itemsCount', { count: items.length })}
                  </Text>
                </View>
                {items.map((it, i) => renderEodRow(it, i !== 0))}
              </View>
            ))
          )}
        </ScrollView>

        {/* Sticky footer summary */}
        <View
          style={{
            backgroundColor: C.panel,
            borderTopWidth: 1,
            borderTopColor: C.border,
            paddingHorizontal: rowPadH,
            paddingVertical: 10,
            flexDirection: 'row',
            alignItems: isPhone ? 'flex-start' : 'center',
            flexWrap: isPhone ? 'wrap' : 'nowrap',
            gap: isPhone ? 8 : 14,
          }}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: countedNum === total && total > 0 ? C.ok : C.warn }}>
            {T('section.eod.countedSlash', { counted: countedNum, total })}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>
            {T('section.eod.estValueLabel')} <Text style={{ color: C.fg, fontWeight: '600' }}>${estValue.toFixed(2)}</Text>
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>
            {T('section.eod.varianceLabel')} <Text style={{ color: variance < 0 ? C.warn : C.fg }}>{countedNum > 0 ? `${variance >= 0 ? '+' : ''}${variance.toFixed(1)}` : '—'}</Text>
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            {T('section.eod.tabHint')}
          </Text>
        </View>
        </>)}
      </View>

      <AddCountModal
        visible={addCountOpen}
        onClose={() => setAddCountOpen(false)}
        excludedItemIds={new Set(filteredItems.map((i) => i.id))}
        onAdd={(itemId, jump) => {
          setAdditionalItems((prev) => {
            const next = new Set(prev);
            next.add(itemId);
            return next;
          });
          if (jump) setPendingFocusItem(itemId);
        }}
      />

      <AddVendorScheduleModal
        visible={addVendorOpen}
        day={selectedDayName}
        excludedVendorIds={dayScheduledVendorIds}
        onClose={() => setAddVendorOpen(false)}
        onAdd={(vendor) => {
          if (!addOrderScheduleEntry) return;
          addOrderScheduleEntry(selectedDayName, {
            vendorId: vendor.id,
            vendorName: vendor.name,
            deliveryDay: selectedDayName,
          });
          // Auto-select the just-added vendor so the user immediately sees
          // its items appear in the worksheet.
          setSelectedVendorId(vendor.id);
          setSelectedCategory('all');
        }}
      />
    </>
  );
}

// ─── history.tsx — submitted counts (90d) ──────────────────────────────
// Spec 020: history now renders one row per (date, vendor) submission, not
// per date. The VENDOR column is hydrated client-side from useStore.vendors
// keyed on each submission's vendorId. Sort: date DESC, then vendor ASC by
// hydrated name. Legacy rows pre-migration that arrive without a vendorId
// still render — their VENDOR cell shows "—".
function EODHistoryTab() {
  const C = useCmdColors();
  const T = useT();
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const vendors = useStore((s) => s.vendors);
  const currentStore = useStore((s) => s.currentStore);

  const ninetyDaysAgo = React.useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return localDayIso(d);
  }, []);

  // Pre-hydrate vendor lookup so the sort comparator has names available
  // without re-scanning the vendors array per pair-compare. Map is keyed
  // by vendorId, value is the display name (or '' if no vendor row found).
  const vendorNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const v of vendors) m.set(v.id, v.name);
    return m;
  }, [vendors]);

  // Build the row set + sort.
  const submissions = React.useMemo(() => {
    const rows = eodSubmissions
      .filter((s) => s.storeId === currentStore.id && s.date >= ninetyDaysAgo)
      .map((s) => {
        const vid = s.vendorId;
        const vname = vid ? (vendorNameById.get(vid) || s.vendorName || '') : (s.vendorName || '');
        return { sub: s, vendorId: vid || '', vendorName: vname };
      });
    rows.sort((a, b) => {
      // Date DESC first
      if (a.sub.date !== b.sub.date) return a.sub.date < b.sub.date ? 1 : -1;
      // Then vendor name ASC (case-insensitive); empty vendor name sorts last
      const an = (a.vendorName || '~').toLowerCase();
      const bn = (b.vendorName || '~').toLowerCase();
      if (an !== bn) return an < bn ? -1 : 1;
      // Stable tiebreaker on submission id
      return a.sub.id < b.sub.id ? -1 : 1;
    });
    return rows;
  }, [eodSubmissions, currentStore.id, ninetyDaysAgo, vendorNameById]);

  const onTimeCount = submissions.filter((r) => r.sub.status === 'submitted').length;
  const onTimePct = submissions.length === 0 ? 100 : Math.round((onTimeCount * 100) / submissions.length);

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.eod.historyTitle')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.eod.historyDescription')}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label={T('section.eod.submissionsCount')} value={String(submissions.length)} sub={T('section.eod.last90Days')} />
        <StatCard label={T('section.eod.onTimePct')} value={`${onTimePct}%`} sub={T('section.eod.vsDeadline')} />
        <StatCard label={T('section.eod.itemsPerCount')} value={submissions.length === 0 ? '—' : String(Math.round(submissions.reduce((s, c) => s + (c.sub.itemCount || c.sub.entries?.length || 0), 0) / submissions.length))} sub={T('section.eod.avg')} />
        <StatCard label={T('section.eod.lastSubmitted')} value={submissions[0] ? submissions[0].sub.date.slice(5) : '—'} sub={submissions[0] ? new Date(submissions[0].sub.timestamp).toTimeString().slice(0, 5) : '—'} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>{T('section.eod.historyTsv')}</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{submissions.length} {submissions.length === 1 ? T('section.eod.countWord') : T('section.eod.countsWord')}</Text>
        </View>
        {submissions.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            {T('section.eod.noSubmittedCounts')}
          </Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 100 }}>{T('section.eod.dateCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70 }}>{T('section.eod.timeCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 160 }}>{T('section.eod.vendorCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{T('section.eod.submittedByCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.eod.itemsCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.eod.statusCol')}</Text>
            </View>
            {submissions.map((row, i) => {
              const sub = row.sub;
              const tone = sub.status === 'draft' ? 'warn' : 'ok';
              return (
                <View key={sub.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border }}>
                  <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 100 }}>{sub.date}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 70 }}>
                    {new Date(sub.timestamp).toTimeString().slice(0, 5)}
                  </Text>
                  <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg, width: 160 }} numberOfLines={1}>
                    {row.vendorName || '—'}
                  </Text>
                  <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg2, flex: 1 }} numberOfLines={1}>{sub.submittedBy || '—'}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right' }}>{sub.itemCount || sub.entries?.length || 0}</Text>
                  <View style={{ width: 90, alignItems: 'flex-end' }}>
                    <View style={{ borderWidth: 0.5, borderColor: tone === 'warn' ? C.warn : C.ok, borderRadius: CmdRadius.pill, paddingHorizontal: 9, paddingVertical: 2, backgroundColor: tone === 'warn' ? C.warnBg : C.okBg }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: tone === 'warn' ? C.warn : C.ok, letterSpacing: 0.4 }}>
                        {sub.status === 'draft' ? T('section.eod.statusDraftPill') : T('section.eod.statusSubmittedPill')}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </>
        )}
      </View>
    </ScrollView>
  );
}

// ─── variance.log — counted vs expected diff per item ──────────────────
// Spec 020 §9.6: today's count is now N submissions (one per submitted
// vendor). Aggregate by SUMming actual_remaining per itemId across all of
// today's submissions, matching the server-side variance template's anchor
// math (architect §4 / Q3). This client view is advisory; the variance
// report (REPORTS-3) is authoritative.
function VarianceLogTab() {
  const C = useCmdColors();
  const T = useT();
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const todayStr = localDayIso(new Date());
  // Replace single-row find() with filter() — post-spec-020 there can be
  // multiple submissions for the same (store, date).
  const todaySubs = React.useMemo(
    () =>
      eodSubmissions.filter(
        (s) => s.storeId === currentStore.id && s.date === todayStr && s.status === 'submitted',
      ),
    [eodSubmissions, currentStore.id, todayStr],
  );

  const variances = React.useMemo(() => {
    if (todaySubs.length === 0) return [];
    // SUM-aggregate per itemId across all of today's vendor submissions.
    // Same item appearing under two vendors on one date adds. Matches the
    // server-side report_run_variance refactor.
    const byItem = new Map<string, number>();
    for (const sub of todaySubs) {
      for (const e of sub.entries || []) {
        if (e.actualRemaining == null) continue;
        byItem.set(e.itemId, (byItem.get(e.itemId) || 0) + Number(e.actualRemaining));
      }
    }
    return Array.from(byItem.entries())
      .map(([itemId, counted]) => {
        const item = inventory.find((i) => i.id === itemId);
        if (!item) return null;
        const expected = item.parLevel || 0; // par as proxy when no expected stock signal
        const delta = counted - expected;
        // Spec 104 (OQ-5) — per-each costPerUnit × counted delta → `× subUnitSize` bridge.
        const cost = (item.costPerUnit || 0) * (item.subUnitSize || 1);
        const deltaCost = delta * cost;
        let tag: 'SHRINK' | 'MINOR' | 'OK' | 'FAVORABLE';
        if (deltaCost <= -25) tag = 'SHRINK';
        else if (Math.abs(delta) >= expected * 0.05 && expected > 0) tag = 'MINOR';
        else if (delta > 0) tag = 'FAVORABLE';
        else tag = 'OK';
        return { itemName: item.name, unit: item.unit, expected, counted, delta, deltaCost, tag };
      })
      .filter(Boolean) as Array<{ itemName: string; unit: string; expected: number; counted: number; delta: number; deltaCost: number; tag: 'SHRINK' | 'MINOR' | 'OK' | 'FAVORABLE' }>;
  }, [todaySubs, inventory]);

  const sorted = React.useMemo(
    () => variances.slice().sort((a, b) => Math.abs(b.deltaCost) - Math.abs(a.deltaCost)),
    [variances],
  );

  const sumDelta = sorted.reduce((s, v) => s + v.deltaCost, 0);
  const shrinkCount = sorted.filter((v) => v.tag === 'SHRINK').length;
  const minorCount = sorted.filter((v) => v.tag === 'MINOR').length;

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.eod.varianceTitle')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.eod.varianceSubtitle')}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label={T('section.eod.itemsCounted')} value={String(sorted.length)} sub={
          todaySubs.length > 0
            ? (todaySubs.length === 1
                ? T('section.eod.todaysCount', { count: todaySubs.length })
                : T('section.eod.todaysCountPlural', { count: todaySubs.length }))
            : T('section.eod.noCountSubmitted')
        } />
        <StatCard label={T('section.eod.netDelta')} value={`${sumDelta >= 0 ? '+' : '−'}$${Math.abs(sumDelta).toFixed(0)}`} sub={T('section.eod.vsParCost')} />
        <StatCard label={T('section.eod.shrinkLabel')} value={String(shrinkCount)} sub={T('section.eod.shrinkSub')} />
        <StatCard label={T('section.eod.minorLabel')} value={String(minorCount)} sub={T('section.eod.minorSub')} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>{T('section.eod.varianceLog')}</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.eod.sortedByDeltaDollar')}</Text>
        </View>
        {sorted.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            {T('section.eod.noCountToday')}
          </Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1.4 }}>{T('section.eod.vItemCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.eod.vExpectedCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.eod.vCountedCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.eod.vDeltaCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.eod.vDeltaDollarCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.eod.vTagCol')}</Text>
            </View>
            {sorted.map((v, i) => {
              const tone = v.tag === 'SHRINK' ? C.danger : v.tag === 'MINOR' ? C.warn : v.tag === 'FAVORABLE' ? C.ok : C.fg3;
              const bg   = v.tag === 'SHRINK' ? C.dangerBg : v.tag === 'MINOR' ? C.warnBg : v.tag === 'FAVORABLE' ? C.okBg : 'transparent';
              return (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                  <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1.4 }} numberOfLines={1}>{v.itemName}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 80, textAlign: 'right' }}>{v.expected} {v.unit}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right' }}>{v.counted} {v.unit}</Text>
                  <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: tone, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    {v.delta >= 0 ? '+' : ''}{v.delta.toFixed(1)}
                  </Text>
                  <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: tone, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    {v.deltaCost >= 0 ? '+' : '−'}${Math.abs(v.deltaCost).toFixed(0)}
                  </Text>
                  <View style={{ width: 80, alignItems: 'flex-end' }}>
                    <View style={{ borderWidth: 0.5, borderColor: tone, borderRadius: CmdRadius.pill, paddingHorizontal: 9, paddingVertical: 2, backgroundColor: bg }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: tone, letterSpacing: 0.4 }}>{v.tag}</Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </>
        )}
      </View>
    </ScrollView>
  );
}

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useIsPhone } from '../../../theme/breakpoints';
import { useStore } from '../../../store/useStore';
import {
  fetchRecentInventoryCounts,
  fetchInventoryCount,
  fetchReorderForCountedOnHand,
  fetchCountDraft,
  saveCountDraft,
  deleteCountDraft,
} from '../../../lib/db';
import type { StoreCountLayout } from '../../../lib/db';
import type { CountedReorderItem } from '../../../types';
import {
  parStateFor,
  buildCountedOnHandMap,
  formatCountedReorderSuggestion,
  type ParInventoryRow,
} from './countHistoryPar';
import { applyCountOrder, firstUncounted } from '../../../lib/countOrder';
// Spec 106 — save-draft + resume. The pure (de)serialize + reconcile + stale-id
// helpers live in the dependency-free src/lib/countDrafts module (shared with
// the staff carve-out); the admin device-local offline copy lives in
// src/lib/countDraftLocal (localStorage web / best-effort AsyncStorage native).
import {
  reconcileDrafts,
  applyDraftStaleFilter,
  serializeAdminInventoryDraft,
  deserializeAdminInventoryDraft,
} from '../../../lib/countDrafts';
import {
  readLocalCountDraft,
  writeLocalCountDraft,
  clearLocalCountDraft,
} from '../../../lib/countDraftLocal';
// Admin-side connection signal (realtime socket state; web-only, native →
// optimistic-true). Drives the Save online/offline branch + the reconnect
// draft-sync (design §9). Deliberately the ADMIN top-level hook, NOT the staff
// subtree copy — no cross-surface import.
import { useConnectionStatus } from '../../../hooks/useConnectionStatus';
import { confirmAction } from '../../../utils/confirmAction';
import { supabase } from '../../../lib/supabase';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { FilterInput } from '../../../components/cmd/FilterInput';
import CountOrderDragList from '../../../components/cmd/CountOrderDragList';
import { CountLayoutNameModal } from '../../../components/cmd/CountLayoutNameModal';
import { matchesQuery } from '../../../i18n/matchesQuery';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { relativeTime } from '../../../utils/relativeTime';
import type {
  InventoryCount,
  InventoryCountKind,
  InventoryCountSummary,
  Store,
  WeeklyCountStatus,
} from '../../../types';
import { useT } from '../../../hooks/useT';
import {
  inventoryCountKindLabel,
  inventoryCountKindSubLabel,
} from '../../../utils/enumLabels';

// Spec 019 — Any-time inventory count
//
// Sibling of EOD count, NOT a replacement. Counts here are advisory
// historical snapshots only — they do NOT update inventory_items.
// current_stock (Q2 default). EOD remains the authoritative re-measurement.
//
// Pattern mirrors EODCountSection.tsx where useful:
//   - per-category grouped item rows with case/each split inputs
//   - sticky footer with non-blank counter + submit
//   - TabStrip for count.tsx (form) / history.tsx (recent)
//
// Differences from EOD:
//   - No week sidebar — counts happen any time, not bound to a day.
//   - No vendor / schedule filter — all items in scope by default.
//   - Header strip carries `kind` segmented control + counted_at picker
//     + optional notes field.
//   - History tab drills into a read-only detail view (view: 'list' |
//     'detail') instead of a separate screen — mirrors REPORTS-1 pattern
//     (see ReportsSection.tsx).

// Spec 039 — kind labels + sub-captions route through enumLabels.ts.
// The id list stays a fixed array so the segmented control's render
// order is deterministic; display strings come from the active locale.
const KIND_IDS: ReadonlyArray<InventoryCountKind> = ['spot', 'open', 'mid_shift', 'close'];

// Pad an HTML-input <input type="datetime-local"> value the user has typed.
// The control returns "YYYY-MM-DDTHH:MM" (no seconds, no timezone). Server
// accepts ISO; we normalize on submit.
function localNowForInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Spec 098 — caller's local YYYY-MM-DD (same convention the staff app + the
// weekly_count_status RPC's week-window math anchor on, avoiding the UTC
// off-by-one).
function todayIso(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 0=Sun..6=Sat day-of-week options for the per-store cadence <select>.
const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// "2026-05-10T14:23" → ISO 8601 with local timezone offset. Server-side
// `coalesce(p_counted_at, now())` accepts ISO strings; we send the user's
// local wall-clock time as ISO so the audit trail matches what they saw
// on screen.
function localInputToIso(local: string): string {
  if (!local) return '';
  // Append :00 seconds if missing so Date can parse it consistently.
  const hasSeconds = /T\d{2}:\d{2}:\d{2}$/.test(local);
  const padded = hasSeconds ? local : `${local}:00`;
  const parsed = new Date(padded);
  if (isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
}

export default function InventoryCountSection() {
  const C = useCmdColors();
  const T = useT();
  const isPhone = useIsPhone();
  const cellW = isPhone ? 56 : 80;
  const inputW = isPhone ? 48 : 70;
  const rowGap = isPhone ? 8 : 14;
  const rowPadH = isPhone ? 12 : 22;

  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const submitInventoryCount = useStore((s) => s.submitInventoryCount);
  // Spec 098 — weekly tab state + cadence write.
  const stores = useStore((s) => s.stores);
  const weeklyCountStatus = useStore((s) => s.weeklyCountStatus);
  const weeklyCountStatusLoading = useStore((s) => s.weeklyCountStatusLoading);
  const loadWeeklyCountStatus = useStore((s) => s.loadWeeklyCountStatus);
  const setStoreWeeklyDueDow = useStore((s) => s.setStoreWeeklyDueDow);
  // Spec 110 — store-shared named weekly-count layout actions (thin I/O
  // wrappers; the list + selection live in section-local state below, design §8).
  const fetchStoreCountLayouts = useStore((s) => s.fetchStoreCountLayouts);
  const saveStoreCountLayout = useStore((s) => s.saveStoreCountLayout);
  const renameStoreCountLayout = useStore((s) => s.renameStoreCountLayout);
  const deleteStoreCountLayout = useStore((s) => s.deleteStoreCountLayout);

  const [tabId, setTabId] = React.useState('count.tsx');
  const [view, setView] = React.useState<'list' | 'detail'>('list');
  const [selectedCountId, setSelectedCountId] = React.useState<string | null>(null);

  // Form state — mirrors EOD's case/each/notes shape so the dual-input
  // rendering can reuse the same `hasCase` logic.
  const [kind, setKind] = React.useState<InventoryCountKind>('spot');
  const [countedAtLocal, setCountedAtLocal] = React.useState<string>(() => localNowForInput());
  const [notes, setNotes] = React.useState<string>('');
  const [caseCounts, setCaseCounts] = React.useState<Record<string, string>>({});
  const [unitCounts, setUnitCounts] = React.useState<Record<string, string>>({});
  const [itemNotes, setItemNotes] = React.useState<Record<string, string>>({});
  const [selectedCategory, setSelectedCategory] = React.useState<string | 'all'>('all');
  // Ingredient-name search — view-only, composes with the category chip.
  const [search, setSearch] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  // Spec 106 — save-draft + resume. `draftSavedAt` (ISO of the restored draft's
  // client-stamped saved_at) drives the restored-draft banner; null = no banner.
  // `savingDraft` guards the Save button while a save is in flight. The draft
  // form state itself reuses the existing kind/countedAtLocal/notes/case/unit/
  // itemNotes useState above — no separate mirror (design §14: draft state stays
  // in the section's local React state).
  const [draftSavedAt, setDraftSavedAt] = React.useState<string | null>(null);
  const [savingDraft, setSavingDraft] = React.useState(false);
  // Spec 106 (AC-6) — first-uncounted jump on draft restore. `firstInputRefs`
  // holds the primary TextInput per row (Cases when packed, else Units) and
  // `pendingFocusId` names the row to focus after a restore. The list is a plain
  // ScrollView with every row mounted (no windowing), so a DOM focus() on web
  // pulls the target into view. Admin has NO submit gate, so this is a
  // scroll/focus affordance (not a submit-blocker), mirroring the staff jump
  // (design §14).
  const [pendingFocusId, setPendingFocusId] = React.useState<string | null>(null);
  const firstInputRefs = React.useRef<Record<string, TextInput | null>>({});
  // Spec 110 — store-SHARED named layouts (this is the AUTHORING surface).
  // `viewMode`/`savedIds` are the SAME spec-103 render/apply levers (reused
  // verbatim, design §9): Default → savedIds=null (category-grouped); a picked
  // layout → savedIds=<its item_ids> + viewMode='custom' (flat, headers
  // suppressed). Render-only: counters/guards/submission still derive from
  // `storeInventory` (AC-9/AC-11; the C-FE-1 guard stays). NO count gate here.
  //
  // What spec 110 CHANGES vs spec 103 on this surface: the ordered id array
  // comes from a picked `store_count_layouts.item_ids` (not the per-user
  // `user_count_orders` row), and it persists only on an explicit Save (not
  // auto-save-on-drag). `layouts` is the store's shared set (0–3);
  // `selectedLayoutId` is which pill is active (null = Default). `dragIds` is
  // the WORKING order the drag list edits — it diverges from the saved layout
  // until Save, and is what a create/overwrite persists.
  const [viewMode, setViewMode] = React.useState<'default' | 'custom'>('default');
  const [savedIds, setSavedIds] = React.useState<string[] | null>(null);
  const [layouts, setLayouts] = React.useState<StoreCountLayout[]>([]);
  const [selectedLayoutId, setSelectedLayoutId] = React.useState<string | null>(null);
  // The name-entry modal: 'create' prompts for a new layout name; 'rename'
  // targets an existing layout id. null = closed.
  const [nameModal, setNameModal] = React.useState<
    { mode: 'create' } | { mode: 'rename'; layoutId: string; initial: string } | null
  >(null);
  const [savingLayout, setSavingLayout] = React.useState(false);
  const MAX_LAYOUTS = 3;

  // Recent counts — fetched on mount + on a realtime nudge. `tick` is the
  // counter we bump from the realtime subscription to force a refetch.
  const [recent, setRecent] = React.useState<InventoryCountSummary[]>([]);
  const [recentLoading, setRecentLoading] = React.useState(false);
  const [refreshTick, setRefreshTick] = React.useState(0);
  const [detail, setDetail] = React.useState<InventoryCount | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  // Spec 105 — companion reorder-suggestion fetch for the detail view, keyed by
  // itemId. Read-only, component-local (NOT Zustand). Populated only for the
  // below-par entries the FE sends; an item present in the request but absent
  // here means "nothing to reorder" (the suggested_qty < 0.001 collapse). On
  // RPC failure this stays `{}` and the par ✓/red dots still render (they need
  // no backend) — the below-par rows simply omit the suggestion text.
  const [reorderByItem, setReorderByItem] = React.useState<Record<string, CountedReorderItem>>({});

  // Spec 106 — connection signal for the reconnect draft-sync ONLY. The Save
  // path is server-first/error-fallback and does NOT read this (see onSaveDraft);
  // this hook stays purely the reconnect-sync TRIGGER. `wasOnlineRef` mirrors the
  // useEodSubmit Effect-1 shape (fire a reconcile-and-push on a false→true flip).
  const isOnline = useConnectionStatus();
  const wasOnlineRef = React.useRef<boolean>(isOnline);
  // Restore-once guard (architect SF-1). The draft-load effect re-keys on
  // `isOnline`, so a mid-count realtime socket blip (false→true) re-runs it — but
  // the form RESTORE must fire at most once per (user, store) slot so a reconnect
  // never clobbers keystrokes the counter typed since the last Save. This ref
  // holds the slot key we have already done the first-pass restore for; the
  // reconnect effect owns all post-first-restore sync (it touches only storage +
  // the banner, never the form). A slot change re-arms the restore for the new
  // store's draft; an `isOnline` re-run does not.
  const restoredSlotRef = React.useRef<string | null>(null);

  const storeId = currentStore?.id;
  const isAllOrEmpty = !storeId || storeId === '__all__';

  // Per-store items, alphabetized inside each category. Same shape as
  // EODCountSection's `storeInventory` / `grouped` derivations.
  const storeInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === storeId),
    [inventory, storeId],
  );

  const categories = React.useMemo(() => {
    const cats = new Map<string, number>();
    for (const i of storeInventory) cats.set(i.category, (cats.get(i.category) || 0) + 1);
    return [
      { id: 'all' as const, label: `All (${storeInventory.length})` },
      ...Array.from(cats.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cat, n]) => ({ id: cat, label: `${cat} (${n})` })),
    ];
  }, [storeInventory]);

  const filteredItems = React.useMemo(() => {
    const byCat = selectedCategory === 'all'
      ? storeInventory
      : storeInventory.filter((i) => i.category === selectedCategory);
    // Rows render the raw English `name`; match that (diacritic-folded).
    const base = search.trim() ? byCat.filter((i) => matchesQuery(search, [i.name])) : byCat;
    return base.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [storeInventory, selectedCategory, search]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, typeof filteredItems>();
    for (const it of filteredItems) {
      const arr = map.get(it.category) || [];
      arr.push(it);
      map.set(it.category, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredItems]);

  // Spec 103 — flat Custom view list: the saved ranking applied to the already
  // category-chip + search filtered `filteredItems` (unranked appended,
  // deleted ignored). Category headers are suppressed in Custom view (OQ-2).
  // `filteredItems` already includes the search narrowing, so search composes
  // with the custom order (AC-10).
  const customVisibleItems = React.useMemo(
    () => applyCountOrder(filteredItems, savedIds, (i) => i.id),
    [filteredItems, savedIds],
  );

  // Per-row "is non-blank" check: any of case-count, unit-count are
  // non-empty / valid numbers. Aligns with the architect's blank-skip
  // rule (Q6) — frontend strips, RPC defense-in-depth strips again.
  const hasEntry = (id: string) =>
    (caseCounts[id] ?? '').trim() !== '' || (unitCounts[id] ?? '').trim() !== '';

  const itemTotal = (i: typeof filteredItems[0]) => {
    const c = parseFloat(caseCounts[i.id] || '');
    const u = parseFloat(unitCounts[i.id] || '');
    const cases = isNaN(c) ? 0 : c;
    const units = isNaN(u) ? 0 : u;
    return cases * (i.caseQty || 1) + units;
  };

  // IMPORTANT: counters + guards derive from `storeInventory` (every item
  // in the active store), NOT `filteredItems`. The category chip is a
  // VIEW-only filter. A user can fill in dairy items, switch to proteins,
  // and SUBMIT — every non-blank entry across all categories goes through
  // to the RPC. Submitting based on `filteredItems` would silently drop
  // the hidden dairy entries (release-proposal C-FE-1).
  const nonBlankCount = storeInventory.filter((i) => hasEntry(i.id)).length;
  const totalItems = storeInventory.length;

  // Reject negative inputs at the entry level. The RPC enforces ≥ 0 too;
  // catching client-side avoids the round trip + lets the row visually
  // signal the bad value. Scans `storeInventory` (all items) so a negative
  // value in a hidden category still blocks submit.
  const hasNegative = React.useMemo(() => {
    for (const it of storeInventory) {
      const c = parseFloat(caseCounts[it.id] || '');
      const u = parseFloat(unitCounts[it.id] || '');
      if (!isNaN(c) && c < 0) return true;
      if (!isNaN(u) && u < 0) return true;
    }
    return false;
  }, [storeInventory, caseCounts, unitCounts]);

  // ─── Realtime subscription for this section ────────────────────────
  // Architect §7 Option A: own the inventory_counts subscription in the
  // section rather than in `useRealtimeSync.ts`. The global hook bumps
  // `loadFromSupabase` which doesn't touch counts. Here we just bump
  // `refreshTick` so the recent-counts fetch re-runs.
  React.useEffect(() => {
    if (!storeId || storeId === '__all__') return;
    const channel = supabase
      .channel(`store-${storeId}-inv-counts`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inventory_counts', filter: `store_id=eq.${storeId}` },
        () => setRefreshTick((t) => t + 1),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [storeId]);

  // ─── Fetch recent counts on mount + on tick changes ────────────────
  React.useEffect(() => {
    if (!storeId || storeId === '__all__') {
      setRecent([]);
      return;
    }
    let cancelled = false;
    setRecentLoading(true);
    fetchRecentInventoryCounts(storeId, 10)
      .then((rows) => {
        if (!cancelled) setRecent(rows);
      })
      .catch((e: any) => {
        console.warn('[InventoryCount] fetchRecent failed:', e?.message || e);
        if (!cancelled) setRecent([]);
      })
      .finally(() => {
        if (!cancelled) setRecentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [storeId, refreshTick]);

  // ─── Spec 098: load weekly status when the weekly tab opens ────────
  React.useEffect(() => {
    if (tabId !== 'weekly.tsx') return;
    void loadWeeklyCountStatus(todayIso());
  }, [tabId, loadWeeklyCountStatus]);

  // ─── Spec 110: load the store's shared named layouts on mount/store change ──
  // Fresh fetch, no client cache (AC-4). Start on Default (no pill selected);
  // the admin opts into a layout by picking a pill. A load error degrades to
  // Default-only (the toast fires inside the store action). Re-runs on store
  // change so switching stores shows that store's shared set.
  React.useEffect(() => {
    if (!storeId || storeId === '__all__') {
      setLayouts([]);
      setSelectedLayoutId(null);
      setSavedIds(null);
      setViewMode('default');
      return;
    }
    let cancelled = false;
    fetchStoreCountLayouts(storeId).then((rows) => {
      if (cancelled) return;
      setLayouts(rows ?? []);
      // Reset selection on a (re)load — the picked layout may no longer exist
      // (deleted by another admin); the admin re-picks. Default view until then.
      setSelectedLayoutId(null);
      setSavedIds(null);
      setViewMode('default');
    });
    return () => {
      cancelled = true;
    };
  }, [storeId, fetchStoreCountLayouts]);

  // Pick a pill. Default → category-grouped (savedIds=null). A named layout →
  // flat Custom view in its saved order (design §9, the spec-103 apply path).
  // This is available to any counter; the authoring affordances below are the
  // admin-only extras. Selecting a layout seeds the working drag order from it.
  const onPickDefault = React.useCallback(() => {
    setSelectedLayoutId(null);
    setSavedIds(null);
    setViewMode('default');
  }, []);

  const onPickLayout = React.useCallback(
    (layout: StoreCountLayout) => {
      setSelectedLayoutId(layout.id);
      setSavedIds(layout.itemIds);
      setViewMode('custom');
    },
    [],
  );

  // The layout the pill row currently has selected (or null for Default).
  const selectedLayout = React.useMemo(
    () => layouts.find((l) => l.id === selectedLayoutId) ?? null,
    [layouts, selectedLayoutId],
  );

  // Drag reorder — ON-SCREEN ONLY. Unlike spec 103 (auto-save-on-drop), spec
  // 110 defers persistence to an explicit Save (AC-9): dragging updates
  // `savedIds` (the rendered order) but writes nothing. Save reads `savedIds`
  // back as the item_ids to persist.
  const onReorder = React.useCallback((orderedIds: string[]) => {
    setSavedIds(orderedIds);
    setViewMode('custom');
  }, []);

  // Persist the current on-screen order to a layout. `layoutId` set → overwrite
  // that layout keeping its name (AC-5); null → this is a create, so the caller
  // has already collected a name via the modal. Optimistic-then-revert on the
  // local `layouts` list; the store action toasts on failure and returns null.
  const persistLayout = React.useCallback(
    async (name: string, layoutId: string | null) => {
      if (!storeId || storeId === '__all__') return;
      // The order to persist is the on-screen order. In Custom view that is
      // `savedIds` (the picked/dragged order). In Default view `savedIds` is
      // null, so capture the default category-grouped order (category asc, then
      // name — the same order `grouped` renders) so "arrange in Default → Save
      // as new" stores a meaningful starting layout rather than an empty array.
      const ids =
        savedIds ??
        [...storeInventory]
          .sort(
            (a, b) =>
              (a.category || '').localeCompare(b.category || '') ||
              a.name.localeCompare(b.name),
          )
          .map((i) => i.id);
      setSavingLayout(true);
      const savedId = await saveStoreCountLayout(storeId, name, ids, layoutId);
      setSavingLayout(false);
      if (!savedId) {
        // The store action already toasted. Nothing to revert: `layouts` is
        // never optimistically mutated on this path — the authoritative row
        // shape comes back from the refetch below on success.
        return;
      }
      // Re-fetch the authoritative list so the new/overwritten row (with its
      // server-assigned slot + updated_at) is reflected on the pill row (AC-4).
      const rows = await fetchStoreCountLayouts(storeId);
      if (rows) setLayouts(rows);
      setSelectedLayoutId(savedId);
      // Keep the just-saved order on screen (savedIds already holds it).
      setViewMode('custom');
      Toast.show({ type: 'success', text1: T('section.countLayout.saved') });
    },
    [storeId, savedIds, storeInventory, saveStoreCountLayout, fetchStoreCountLayouts, T],
  );

  // Shared client-side cap pre-block for the two create paths (AC-9). Returns
  // true when the cap toast fired and the caller should bail. UX only — the
  // save RPC backstops the cap server-side (AC-2).
  const blockIfAtCap = React.useCallback(() => {
    if (layouts.length >= MAX_LAYOUTS) {
      Toast.show({ type: 'error', text1: T('section.countLayout.limitReached') });
      return true;
    }
    return false;
  }, [layouts.length, T]);

  // Save button. A layout is selected → overwrite it (AC-5, no name prompt).
  // No layout selected → this is a NEW layout: block client-side at the cap
  // then open the name modal.
  const onSaveLayout = React.useCallback(() => {
    if (!storeId || storeId === '__all__') return;
    if (selectedLayout) {
      void persistLayout(selectedLayout.name, selectedLayout.id);
      return;
    }
    if (blockIfAtCap()) return;
    setNameModal({ mode: 'create' });
  }, [storeId, selectedLayout, blockIfAtCap, persistLayout]);

  // "Save as new" — always creates a fresh layout (even when one is selected),
  // subject to the client-side cap. Distinct from Save's overwrite path.
  const onSaveAsNew = React.useCallback(() => {
    if (!storeId || storeId === '__all__') return;
    if (blockIfAtCap()) return;
    setNameModal({ mode: 'create' });
  }, [storeId, blockIfAtCap]);

  // Modal submit — resolves create vs rename from the modal mode.
  const onNameSubmit = React.useCallback(
    (name: string) => {
      const modal = nameModal;
      setNameModal(null);
      if (!modal) return;
      if (modal.mode === 'create') {
        void persistLayout(name, null);
        return;
      }
      // Rename — optimistic on the local list, revert on failure.
      const prevLayouts = layouts;
      setLayouts((ls) => ls.map((l) => (l.id === modal.layoutId ? { ...l, name } : l)));
      renameStoreCountLayout(modal.layoutId, name).then((ok) => {
        if (!ok) {
          setLayouts(prevLayouts);
          return;
        }
        Toast.show({ type: 'success', text1: T('section.countLayout.renamed') });
      });
    },
    [nameModal, layouts, persistLayout, renameStoreCountLayout, T],
  );

  // Rename the selected layout — opens the modal prefilled with its name.
  const onRenameSelected = React.useCallback(() => {
    if (!selectedLayout) return;
    setNameModal({ mode: 'rename', layoutId: selectedLayout.id, initial: selectedLayout.name });
  }, [selectedLayout]);

  // Delete the selected layout — confirm-gated (cross-platform). On success the
  // pill disappears and the screen returns to Default (AC-6). Optimistic remove
  // from the local list, revert on failure.
  const onDeleteSelected = React.useCallback(() => {
    const layout = selectedLayout;
    if (!layout) return;
    confirmAction(
      T('section.countLayout.deleteConfirmTitle'),
      T('section.countLayout.deleteConfirmBody', { name: layout.name }),
      () => {
        const prevLayouts = layouts;
        setLayouts((ls) => ls.filter((l) => l.id !== layout.id));
        // Deleting the currently-selected layout returns to Default (AC-6).
        setSelectedLayoutId(null);
        setSavedIds(null);
        setViewMode('default');
        deleteStoreCountLayout(layout.id).then((ok) => {
          if (!ok) {
            setLayouts(prevLayouts);
            return;
          }
          Toast.show({ type: 'success', text1: T('section.countLayout.deleted') });
        });
      },
      T('section.countLayout.delete'),
    );
  }, [selectedLayout, layouts, deleteStoreCountLayout, T]);

  // ─── Spec 106: save-draft + resume ─────────────────────────────────
  // The live item-id set for the active store — drives applyDraftStaleFilter on
  // restore (an id deleted since the draft was saved is dropped, AC-11).
  const liveItemIds = React.useMemo(
    () => new Set(storeInventory.map((i) => i.id)),
    [storeInventory],
  );

  // Jump to the first uncounted row after a restore (AC-6). Order follows the
  // on-screen order: the saved custom order in Custom view, else category asc +
  // name (the same order `grouped` renders). Reuses the shared `firstUncounted`
  // helper (spec 103). Admin has no submit gate — this is a scroll/focus
  // affordance only.
  const jumpToFirstUncounted = React.useCallback(
    (nextCase: Record<string, string>, nextUnit: Record<string, string>) => {
      const isBlank = (it: typeof storeInventory[0]) =>
        (nextCase[it.id] ?? '').trim() === '' && (nextUnit[it.id] ?? '').trim() === '';
      const ordered =
        viewMode === 'custom'
          ? applyCountOrder(storeInventory, savedIds, (i) => i.id)
          : [...storeInventory].sort(
              (a, b) =>
                (a.category || '').localeCompare(b.category || '') ||
                a.name.localeCompare(b.name),
            );
      const target = firstUncounted(ordered, (it) => !isBlank(it));
      if (target) setPendingFocusId(target.id);
    },
    [storeInventory, viewMode, savedIds],
  );

  // Restore a reconciled draft payload into the form. Stale-filters against the
  // current live items (AC-11), deserializes (verbatim strings, AC-5), sets the
  // form state, shows the restored banner, and jumps to the first uncounted row
  // (AC-6; admin has NO submit gate, so the jump is a scroll/focus affordance).
  const restoreDraftToForm = React.useCallback(
    (payload: Record<string, unknown>, savedAt: string) => {
      const filtered = applyDraftStaleFilter(payload, liveItemIds);
      const form = deserializeAdminInventoryDraft(filtered);
      setKind(form.kind);
      // Keep the restored counted-at only when present; else leave the current
      // "now" seed so a draft saved before the datetime was touched still shows
      // a sensible value.
      if (form.countedAtLocal) setCountedAtLocal(form.countedAtLocal);
      setNotes(form.notes);
      setCaseCounts(form.caseCounts);
      setUnitCounts(form.unitCounts);
      setItemNotes(form.itemNotes);
      setDraftSavedAt(savedAt);
      jumpToFirstUncounted(form.caseCounts, form.unitCounts);
    },
    [liveItemIds, jumpToFirstUncounted],
  );

  // Draft-load effect — parallel to the spec-103 fetchCountOrder effect (a
  // separate table + a distinct failure degrade, so NOT folded in). On open:
  // read the device-local copy, fetch the server copy when online, reconcile
  // (whole-draft last-write-wins), run the resulting sync action, and restore
  // from the winner. A failed server fetch degrades to "no draft" (best-effort;
  // a fetch error must not block the count — AC-5).
  React.useEffect(() => {
    const uid = currentUser?.id;
    if (!uid || !storeId || storeId === '__all__') {
      setDraftSavedAt(null);
      return;
    }
    // Restore-once guard (SF-1): the form RESTORE may fire exactly once per
    // (user, store) slot. `mayRestore` is true only when this slot hasn't been
    // restored yet; a slot change re-arms it, an `isOnline` re-run (socket blip)
    // does not — so a reconnect can't clobber keystrokes typed since the last
    // Save. We consume the once-restore (set the ref) after the first pass's
    // restore decision, whether or not a draft was found.
    const slot = `${uid}:${storeId}`;
    const mayRestore = restoredSlotRef.current !== slot;
    let cancelled = false;
    (async () => {
      const local = readLocalCountDraft(uid, 'admin-inventory', storeId);
      let server = null as { payload: Record<string, unknown>; savedAt: string } | null;
      if (isOnline) {
        try {
          server = await fetchCountDraft(uid, 'admin-inventory', storeId);
        } catch (e: any) {
          console.warn('[InventoryCount] fetchCountDraft failed:', e?.message || e);
          server = null;
        }
      }
      if (cancelled) return;
      const { winner, restoreFrom, action } = reconcileDrafts(local, server);
      // Run the reconcile sync action (best-effort; failures are non-fatal — the
      // local copy simply stays until the next reconcile retries). This always
      // runs (it only touches storage) — only the form RESTORE below is guarded.
      if (action === 'push' && winner) {
        saveCountDraft(uid, 'admin-inventory', storeId, winner.payload, winner.savedAt)
          .then(() => {
            writeLocalCountDraft(uid, 'admin-inventory', storeId, {
              payload: winner.payload,
              savedAt: winner.savedAt,
              unsynced: false,
            });
          })
          .catch((e: any) => {
            console.warn('[InventoryCount] draft push failed:', e?.message || e);
          });
      } else if (action === 'adopt-clear-local') {
        clearLocalCountDraft(uid, 'admin-inventory', storeId);
      } else if (action === 'clear-local-flag' && winner) {
        writeLocalCountDraft(uid, 'admin-inventory', storeId, {
          payload: winner.payload,
          savedAt: winner.savedAt,
          unsynced: false,
        });
      }
      // Only APPLY the winner to the form on the first pass for this slot — a
      // later `isOnline` flip re-runs the effect but must not re-restore over
      // in-progress typing (SF-1). The reconnect effect keeps the storage synced.
      if (mayRestore) {
        restoredSlotRef.current = slot; // consume the once-restore for this slot
        if (winner && restoreFrom !== 'none') {
          restoreDraftToForm(winner.payload, winner.savedAt);
        } else {
          setDraftSavedAt(null); // fresh form — no draft for this slot
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // restoreDraftToForm depends on liveItemIds; intentionally omitted so a live
    // inventory nudge doesn't re-run the whole reconcile (it would re-apply and
    // clobber in-progress edits). The initial restore captures the item set at
    // open; a stale id that only appears later is a non-issue for a fresh open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, storeId, isOnline]);

  // Reconnect draft-sync — on a connectivity false→true flip, reconcile the
  // local+server copies and push a newer unsynced local up WITHOUT clobbering
  // in-progress edits (only the storage + the banner's saved-at are touched;
  // the form is left as the user has it — design §9). Admin native stays
  // optimistic-online so this is effectively web-only.
  React.useEffect(() => {
    const was = wasOnlineRef.current;
    wasOnlineRef.current = isOnline;
    if (was || !isOnline) return; // only act on a false→true flip
    const uid = currentUser?.id;
    if (!uid || !storeId || storeId === '__all__') return;
    const local = readLocalCountDraft(uid, 'admin-inventory', storeId);
    if (!local) return;
    let cancelled = false;
    (async () => {
      let server = null as { payload: Record<string, unknown>; savedAt: string } | null;
      try {
        server = await fetchCountDraft(uid, 'admin-inventory', storeId);
      } catch (e: any) {
        console.warn('[InventoryCount] reconnect fetchCountDraft failed:', e?.message || e);
        return;
      }
      if (cancelled) return;
      const { winner, action } = reconcileDrafts(local, server);
      if (action === 'push' && winner) {
        try {
          await saveCountDraft(uid, 'admin-inventory', storeId, winner.payload, winner.savedAt);
          if (cancelled) return;
          writeLocalCountDraft(uid, 'admin-inventory', storeId, {
            payload: winner.payload,
            savedAt: winner.savedAt,
            unsynced: false,
          });
          setDraftSavedAt((prev) => prev ?? winner.savedAt);
        } catch (e: any) {
          console.warn('[InventoryCount] reconnect draft push failed:', e?.message || e);
        }
      } else if (action === 'adopt-clear-local') {
        clearLocalCountDraft(uid, 'admin-inventory', storeId);
      } else if (action === 'clear-local-flag' && winner) {
        writeLocalCountDraft(uid, 'admin-inventory', storeId, {
          payload: winner.payload,
          savedAt: winner.savedAt,
          unsynced: false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOnline, currentUser?.id, storeId]);

  // First-uncounted focus effect (AC-6). When a restore sets `pendingFocusId`,
  // focus that row's primary input once it is in the rendered list. The admin
  // list is a plain ScrollView with every row mounted (no windowing), so a DOM
  // focus() on web scrolls the target into view; on native focus() is a
  // best-effort no-op. Re-runs when the visible order changes so a target hidden
  // behind a search resolves once the filter clears.
  React.useEffect(() => {
    if (!pendingFocusId) return;
    // Only act once the target is actually rendered (a searched-out target waits
    // for the search-clear re-render).
    const isVisible =
      viewMode === 'custom'
        ? customVisibleItems.some((it) => it.id === pendingFocusId)
        : filteredItems.some((it) => it.id === pendingFocusId);
    if (!isVisible) return;
    let cancelled = false;
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (cancelled) return;
        firstInputRefs.current[pendingFocusId]?.focus?.();
        setPendingFocusId(null);
      }),
    );
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [pendingFocusId, filteredItems, customVisibleItems, viewMode]);

  // Save the current form as a draft. UNGATED — a draft may be partial (AC-1);
  // the count-everything gate applies only to Submit. Mints `savedAt` ONCE at
  // press so the same stamp lands on both the server row and the local copy
  // (design §9).
  //
  // SERVER-FIRST with LOCAL-FALLBACK-ON-ERROR — the Save path does NOT consult a
  // connectivity oracle (the admin `useConnectionStatus` tracks the realtime
  // SOCKET, which false-flips on websocket blips while genuinely online, and is
  // hardcoded true on admin native — either way the wrong gate for a write).
  // Instead: always ATTEMPT the server write; on a network-type failure, write
  // the device-local unsynced copy + show the offline toast (this IS the AC-14
  // observable). Success → mirror local synced + "Draft saved" (AC-13). The
  // socket hook remains only the reconnect-sync TRIGGER (below), where the
  // screen-open reconcile + push-on-reconnect make the eventual sync idempotent.
  const onSaveDraft = React.useCallback(async () => {
    const uid = currentUser?.id;
    if (!uid || !storeId || storeId === '__all__') {
      Toast.show({ type: 'error', text1: 'Select a store first' });
      return;
    }
    const savedAt = new Date().toISOString();
    const payload = serializeAdminInventoryDraft({
      kind,
      countedAtLocal,
      notes,
      caseCounts,
      unitCounts,
      itemNotes,
    });
    setSavingDraft(true);
    try {
      // Server-first: attempt the source-of-truth write, then mirror the local
      // copy as synced so the two do not diverge.
      await saveCountDraft(uid, 'admin-inventory', storeId, payload, savedAt);
      writeLocalCountDraft(uid, 'admin-inventory', storeId, {
        payload,
        savedAt,
        unsynced: false,
      });
      setDraftSavedAt(savedAt);
      Toast.show({ type: 'success', text1: T('section.countDraft.saved') });
    } catch (e: any) {
      // The server write failed (offline / network error) — fall back to a
      // device-local unsynced copy so the work is NOT lost, and surface the
      // offline toast (AC-14). No error toast: the save succeeded locally and
      // the reconnect-sync / next screen-open reconcile pushes it up (idempotent
      // by the shared savedAt stamp, design §11).
      console.warn('[InventoryCount] saveCountDraft failed; local fallback:', e?.message || e);
      writeLocalCountDraft(uid, 'admin-inventory', storeId, {
        payload,
        savedAt,
        unsynced: true,
      });
      setDraftSavedAt(savedAt);
      Toast.show({ type: 'info', text1: T('section.countDraft.savedLocal') });
    } finally {
      setSavingDraft(false);
    }
  }, [currentUser?.id, storeId, kind, countedAtLocal, notes, caseCounts, unitCounts, itemNotes, T]);

  // Discard the restored draft (AC-7) — delete BOTH the server row and the
  // device-local copy, then clear the form back to a fresh state. Confirmed via
  // the cross-platform confirm util.
  const onDiscardDraft = React.useCallback(() => {
    const uid = currentUser?.id;
    if (!uid || !storeId || storeId === '__all__') return;
    confirmAction(
      T('section.countDraft.discardConfirmTitle'),
      T('section.countDraft.discardConfirmBody'),
      () => {
        // Server-first: attempt the server-row delete and only proceed if it
        // succeeds. A silent proceed-on-failure would drop the local copy + the
        // banner while the server row survives — the next screen-open reconcile
        // would then RESURRECT the "discarded" draft (code-reviewer). On failure
        // we keep the banner + values and toast so the discard isn't a silent
        // no-op the user can't see.
        (async () => {
          try {
            await deleteCountDraft(uid, 'admin-inventory', storeId);
          } catch (e: any) {
            console.warn('[InventoryCount] deleteCountDraft failed:', e?.message || e);
            Toast.show({
              type: 'error',
              text1: T('section.countDraft.discardFailed'),
            });
            return; // keep the draft (banner + values) — nothing was deleted
          }
          // Server delete succeeded → clear the device-local copy + the form
          // back to fresh (mirrors the successful-submit clear).
          clearLocalCountDraft(uid, 'admin-inventory', storeId);
          setCaseCounts({});
          setUnitCounts({});
          setItemNotes({});
          setNotes('');
          setCountedAtLocal(localNowForInput());
          setKind('spot');
          setDraftSavedAt(null);
        })();
      },
      T('section.countDraft.discard'),
    );
  }, [currentUser?.id, storeId, T]);

  // Spec 105 — the store's CURRENT inventory rows the par join reads, keyed by
  // item id (OQ-1: current par, client-side, no fetch). Reused by DetailFrame
  // for the ✓/red comparison AND here to build the below-par on-hand map for
  // the companion reorder fetch.
  const inventoryById = React.useMemo(() => {
    const m = new Map<string, ParInventoryRow>();
    for (const i of inventory) {
      if (i.storeId !== storeId) continue;
      m.set(i.id, { id: i.id, parLevel: i.parLevel, caseQty: i.caseQty, unit: i.unit });
    }
    return m;
  }, [inventory, storeId]);

  // ─── Lazy-fetch detail when a row is clicked ───────────────────────
  React.useEffect(() => {
    if (view !== 'detail' || !selectedCountId) {
      setDetail(null);
      setReorderByItem({});
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setReorderByItem({});
    fetchInventoryCount(selectedCountId)
      .then((row) => {
        if (cancelled) return;
        setDetail(row);
        // Spec 105 companion fetch — after the detail resolves, build the
        // { itemId → countedTotal } map from ONLY the below-par, resolvable,
        // non-null entries and ask the reorder RPC for the suggestion. This is
        // a READ; on failure it degrades to just the par badges (no toast,
        // matching the fetchDetail .catch below). Empty map → skip the call.
        if (!row) return;
        const onHandMap = buildCountedOnHandMap(row.entries, inventoryById);
        if (Object.keys(onHandMap).length === 0) return;
        fetchReorderForCountedOnHand(row.storeId, onHandMap, todayIso())
          .then((byItem) => {
            if (!cancelled) setReorderByItem(byItem);
          })
          .catch((e: any) => {
            // Read-only degradation — the par ✓/red dots need no backend, so a
            // failed suggestion fetch MUST NOT toast-spam or block them.
            console.warn('[InventoryCount] fetchReorderForCountedOnHand failed:', e?.message || e);
            if (!cancelled) setReorderByItem({});
          });
      })
      .catch((e: any) => {
        console.warn('[InventoryCount] fetchDetail failed:', e?.message || e);
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // inventoryById intentionally omitted: the detail-open reorder snapshot is
    // taken once against the inventory present when the row is opened (the view
    // is a point-in-time historical read; par-join re-color as inventory drifts
    // is the accepted OQ-1 caveat, surfaced by the caption). Re-running on every
    // inventory realtime nudge would re-fire the RPC needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedCountId]);

  // Web-only Escape closes detail.
  React.useEffect(() => {
    if (Platform.OS !== 'web' || view !== 'detail') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setView('list');
        setSelectedCountId(null);
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [view]);

  // ─── Submit handler ────────────────────────────────────────────────
  const onSubmit = async () => {
    if (!storeId || storeId === '__all__') {
      Toast.show({ type: 'error', text1: 'Select a store first' });
      return;
    }
    if (nonBlankCount === 0) {
      Toast.show({ type: 'error', text1: 'Enter at least one count' });
      return;
    }
    if (hasNegative) {
      Toast.show({ type: 'error', text1: 'Counts must be ≥ 0' });
      return;
    }
    const countedAtIso = localInputToIso(countedAtLocal) || new Date().toISOString();
    // Map kept rows to the RPC contract. Iterate `storeInventory` (every
    // item in the active store), NOT `filteredItems`. The category chip
    // is purely a VIEW filter — SUBMIT always sends every non-blank
    // entry across all categories (release-proposal C-FE-1).
    const entries = storeInventory
      .filter((i) => hasEntry(i.id))
      .map((i) => {
        const cRaw = parseFloat(caseCounts[i.id] || '');
        const uRaw = parseFloat(unitCounts[i.id] || '');
        const cases = isNaN(cRaw) ? null : cRaw;
        const units = isNaN(uRaw) ? null : uRaw;
        const total = (cases ?? 0) * (i.caseQty || 1) + (units ?? 0);
        return {
          itemId: i.id,
          actualRemaining: total,
          actualRemainingCases: cases,
          actualRemainingEach: units,
          unit: i.unit,
          notes: itemNotes[i.id] || null,
        };
      });
    // Mint the idempotency key ONCE per submit-press. If the network
    // drops mid-flight and the user retries (e.g. button re-enable +
    // re-click), the same UUID flows back to the RPC and the second
    // call returns `conflict: true` instead of inserting a duplicate.
    // Architect §6 + §10. The store action's signature accepts this
    // parameter so the boundary lives at the section level where the
    // submit-press event originates.
    const clientUuid =
      (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `cu-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setSubmitting(true);
    try {
      const result = await submitInventoryCount({
        storeId,
        kind,
        countedAt: countedAtIso,
        status: 'submitted',
        entries,
        notes: notes.trim() || null,
        clientUuid,
      });
      if (!result) return; // notifyBackendError already toasted
      if (result.conflict) {
        Toast.show({
          type: 'info',
          text1: 'Already submitted',
          text2: 'A count with this ID was previously recorded',
        });
      } else {
        Toast.show({
          type: 'success',
          text1: 'Count submitted',
          text2: `${entries.length} items · ${inventoryCountKindLabel(kind, T)}`,
        });
      }
      // Clear the form — same UX as a successful EOD submit. Reset
      // `countedAtLocal` to "now" so the next count starts at the
      // current wall-clock instead of the previous timestamp.
      setCaseCounts({});
      setUnitCounts({});
      setItemNotes({});
      setNotes('');
      setCountedAtLocal(localNowForInput());
      // Spec 106 (AC-8) — a completed count deletes its resumable draft (server
      // row + device-local copy) so reopening the screen shows a fresh form with
      // no stale banner. Best-effort: a delete failure only leaves a dangling
      // draft the next reconcile can still clear; it must not block the submit
      // success UX. The `conflict` replay path also lands here — the count is
      // recorded, so its draft is equally done.
      const uid = currentUser?.id;
      if (uid) {
        clearLocalCountDraft(uid, 'admin-inventory', storeId);
        deleteCountDraft(uid, 'admin-inventory', storeId).catch((e: any) => {
          console.warn('[InventoryCount] delete-on-submit failed:', e?.message || e);
        });
      }
      setDraftSavedAt(null);
      // Bump tick so the recent-counts list refreshes immediately even
      // before the realtime nudge arrives.
      setRefreshTick((t) => t + 1);
    } finally {
      setSubmitting(false);
    }
  };

  // Spec 103 — one shared row, rendered by BOTH the default category-grouped
  // view and the flat Custom drag view, so Custom shows byte-identical rows
  // (the custom order is render-only). `showTopBorder` draws the dashed
  // inter-row rule (grouped view suppresses it on the first row of each group;
  // the flat Custom list suppresses it only on the very first row).
  const renderInventoryRow = (it: typeof filteredItems[0], showTopBorder: boolean) => {
    const cVal = caseCounts[it.id] || '';
    const uVal = unitCounts[it.id] || '';
    const cFocused = cVal.trim() !== '';
    const uFocused = uVal.trim() !== '';
    const hasCase = (it.caseQty || 0) > 1;
    const total = itemTotal(it);
    const cNum = parseFloat(cVal);
    const uNum = parseFloat(uVal);
    const cBad = !isNaN(cNum) && cNum < 0;
    const uBad = !isNaN(uNum) && uNum < 0;
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
          <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg, letterSpacing: -0.1 }}>
            {it.name}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, marginTop: 2 }}>
            {it.unit}
            {hasCase ? ` · case ${it.caseQty}` : ''}
            {it.parLevel > 0 ? ` · par ${it.parLevel}` : ''}
            {hasCase && (cFocused || uFocused) ? ` · total ${total} ${it.unit}` : ''}
          </Text>
        </View>
        <View style={{ width: cellW, alignItems: 'center' }}>
          <TextInput
            ref={hasCase ? (r) => { firstInputRefs.current[it.id] = r; } : undefined}
            value={hasCase ? cVal : ''}
            editable={hasCase}
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
              color: cBad ? C.danger : hasCase ? (cFocused ? C.fg : C.fg2) : C.fg3,
              backgroundColor: hasCase ? (cFocused ? C.panel2 : C.panel) : C.panel,
              borderWidth: 1,
              borderColor: cBad ? C.danger : cFocused ? C.accent : C.border,
              borderRadius: CmdRadius.sm,
              opacity: !hasCase ? 0.5 : 1,
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
            }}
          />
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, marginTop: 3 }}>
            {hasCase ? `× ${it.caseQty}` : '—'}
          </Text>
        </View>
        <View style={{ width: cellW, alignItems: 'center' }}>
          <TextInput
            ref={!hasCase ? (r) => { firstInputRefs.current[it.id] = r; } : undefined}
            value={uVal}
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
              color: uBad ? C.danger : uFocused ? C.fg : C.fg2,
              backgroundColor: uFocused ? C.panel2 : C.panel,
              borderWidth: 1,
              borderColor: uBad ? C.danger : uFocused ? C.accent : C.border,
              borderRadius: CmdRadius.sm,
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
            }}
          />
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, marginTop: 3 }}>
            {it.unit}
          </Text>
        </View>
        <TextInput
          value={itemNotes[it.id] || ''}
          onChangeText={(text) => setItemNotes((p) => ({ ...p, [it.id]: text }))}
          placeholder="Note…"
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
            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
          }}
        />
      </View>
    );
  };

  // ─── No-store guard ────────────────────────────────────────────────
  // Spec 098: the weekly.tsx tab is all-stores, so it stays reachable even
  // when no single store is selected — only the count/history bodies need
  // an active store. Keep the TabStrip mounted; gate the per-store bodies.
  if (isAllOrEmpty && tabId !== 'weekly.tsx') {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
        <TabStrip
          tabs={[
            { id: 'count.tsx',   label: 'count.tsx' },
            { id: 'history.tsx', label: 'history.tsx' },
            { id: 'weekly.tsx',  label: 'weekly.tsx' },
          ]}
          activeId={tabId}
          onChange={(id) => {
            setTabId(id);
            if (id !== 'history.tsx') {
              setView('list');
              setSelectedCountId(null);
            }
          }}
        />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontFamily: mono(400), fontSize: 13, color: C.fg2 }}>
            {T('section.eod.selectStoreToCount')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[
          { id: 'count.tsx',   label: 'count.tsx' },
          { id: 'history.tsx', label: 'history.tsx' },
          { id: 'weekly.tsx',  label: 'weekly.tsx' },
        ]}
        activeId={tabId}
        onChange={(id) => {
          setTabId(id);
          if (id !== 'history.tsx') {
            setView('list');
            setSelectedCountId(null);
          }
        }}
        rightSlot={
          tabId === 'count.tsx' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                {nonBlankCount}/{totalItems} entered
              </Text>
              {/* Spec 106 — Save draft. UNGATED by the non-blank count (a draft
                  may be partial, AC-1); guarded only by the store selection +
                  an in-flight save. Ghost/outlined style to distinguish it from
                  the filled accent Submit. */}
              <TouchableOpacity
                testID="inv-save-draft"
                onPress={onSaveDraft}
                disabled={savingDraft || isAllOrEmpty}
                accessibilityRole="button"
                accessibilityLabel={T('section.countDraft.save')}
                style={{
                  paddingVertical: 4,
                  paddingHorizontal: 10,
                  borderWidth: 1,
                  borderColor: C.borderStrong,
                  borderRadius: CmdRadius.sm,
                  opacity: savingDraft || isAllOrEmpty ? 0.5 : 1,
                  ...(Platform.OS === 'web' && (savingDraft || isAllOrEmpty)
                    ? ({ pointerEvents: 'none' } as any)
                    : {}),
                }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg2 }}>
                  {savingDraft
                    ? T('section.countDraft.saving').toUpperCase()
                    : T('section.countDraft.save').toUpperCase()}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onSubmit}
                disabled={submitting || nonBlankCount === 0 || hasNegative}
                accessibilityRole="button"
                accessibilityLabel={T('section.eod.submitCount')}
                style={{
                  paddingVertical: 4,
                  paddingHorizontal: 10,
                  backgroundColor: C.accent,
                  borderRadius: CmdRadius.sm,
                  opacity: submitting || nonBlankCount === 0 || hasNegative ? 0.5 : 1,
                  ...(Platform.OS === 'web' && (submitting || nonBlankCount === 0 || hasNegative)
                    ? ({ pointerEvents: 'none' } as any)
                    : {}),
                }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.accentFg }}>
                  SUBMIT COUNT
                </Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
      />

      {tabId === 'weekly.tsx' ? (
        <WeeklyTab
          stores={stores}
          status={weeklyCountStatus}
          loading={weeklyCountStatusLoading}
          onSetDueDow={setStoreWeeklyDueDow}
          onRefresh={() => loadWeeklyCountStatus(todayIso())}
        />
      ) : tabId === 'history.tsx' ? (
        view === 'detail' && selectedCountId ? (
          <DetailFrame
            countId={selectedCountId}
            detail={detail}
            loading={detailLoading}
            inventoryById={inventoryById}
            reorderByItem={reorderByItem}
            onBack={() => {
              setView('list');
              setSelectedCountId(null);
            }}
          />
        ) : (
          <HistoryTab
            counts={recent}
            loading={recentLoading}
            onSelect={(id) => {
              setSelectedCountId(id);
              setView('detail');
            }}
          />
        )
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: rowPadH, paddingTop: 0, paddingBottom: 80 }}>
          {/* Header strip — kind selector + counted_at + notes */}
          <View
            style={{
              backgroundColor: C.panel,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              paddingTop: 14,
              paddingBottom: 12,
              marginHorizontal: -rowPadH,
              paddingHorizontal: rowPadH,
              gap: 12,
            }}
          >
            <View>
              <Text style={[Type.h2, { color: C.fg }]}>{T('section.inventoryCount.title')}</Text>
              <Text style={{ fontFamily: sans(400), fontSize: 12.5, color: C.fg2, marginTop: 2 }}>
                Advisory snapshot — this count does NOT affect live stock until the next EOD.
              </Text>
            </View>
            {/* Spec 106 — restored-draft banner + Discard. Non-blocking; shown
                only when a draft was auto-restored on open. relativeTime gives
                the saved-at staleness signal (AC-6). Discard deletes the server
                row + the device-local copy and clears the form (AC-7). */}
            {draftSavedAt ? (
              <View
                testID="inv-draft-banner"
                accessibilityRole="alert"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingVertical: 8,
                  paddingHorizontal: 12,
                  borderRadius: CmdRadius.md,
                  borderWidth: 1,
                  borderColor: C.accent,
                  backgroundColor: C.accentBg,
                }}
              >
                <Text style={{ flex: 1, fontFamily: mono(500), fontSize: 11.5, color: C.accent }}>
                  {T('section.countDraft.restored', { time: relativeTime(draftSavedAt) })}
                </Text>
                <TouchableOpacity
                  testID="inv-draft-discard"
                  onPress={onDiscardDraft}
                  accessibilityRole="button"
                  accessibilityLabel={T('section.countDraft.discard')}
                  style={{
                    paddingVertical: 3,
                    paddingHorizontal: 8,
                    borderWidth: 1,
                    borderColor: C.accent,
                    borderRadius: CmdRadius.sm,
                  }}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accent }}>
                    {T('section.countDraft.discard').toUpperCase()}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {/* Kind segmented control */}
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 6,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg3, marginRight: 4 }}>
                kind:
              </Text>
              {KIND_IDS.map((id) => {
                const sel = kind === id;
                const label = inventoryCountKindLabel(id, T);
                const sub = inventoryCountKindSubLabel(id, T);
                return (
                  <TouchableOpacity
                    key={id}
                    onPress={() => setKind(id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: sel }}
                    accessibilityLabel={`Set kind to ${label}`}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: CmdRadius.md,
                      borderWidth: 1,
                      borderColor: sel ? C.accent : C.border,
                      backgroundColor: sel ? C.accentBg : C.panel,
                    }}
                  >
                    <Text style={{ fontFamily: mono(sel ? 700 : 500), fontSize: 11, color: sel ? C.accent : C.fg2 }}>
                      {label.toUpperCase()}
                    </Text>
                    <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: sel ? C.accent : C.fg3, marginTop: 1 }}>
                      {sub}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {/* Counted-at + Notes row */}
            <View
              style={{
                flexDirection: isPhone ? 'column' : 'row',
                gap: 10,
                alignItems: isPhone ? 'stretch' : 'flex-end',
              }}
            >
              <View style={{ flexDirection: 'column', gap: 4 }}>
                <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg3, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                  counted at
                </Text>
                {/* Web-only: leverage the native datetime-local input. RN
                    doesn't ship a cross-platform datetime picker; the
                    architect noted we should not pull a new library, so
                    on native we fall back to a static "now" label. */}
                {Platform.OS === 'web' ? (
                  // @ts-ignore — react-native-web passes web-specific props through.
                  <input
                    type="datetime-local"
                    value={countedAtLocal}
                    onChange={(e: any) => setCountedAtLocal(e.target.value)}
                    style={{
                      height: 30,
                      paddingLeft: 8,
                      paddingRight: 8,
                      fontFamily: 'monospace',
                      fontSize: 12,
                      color: C.fg,
                      backgroundColor: C.panel,
                      borderWidth: 1,
                      borderColor: C.border,
                      borderRadius: CmdRadius.sm,
                      outlineStyle: 'none',
                      minWidth: 200,
                    }}
                  />
                ) : (
                  <View
                    style={{
                      paddingVertical: 6,
                      paddingHorizontal: 10,
                      borderRadius: CmdRadius.sm,
                      borderWidth: 1,
                      borderColor: C.border,
                      backgroundColor: C.panel,
                    }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>
                      now ({new Date().toLocaleString()})
                    </Text>
                  </View>
                )}
              </View>
              <View style={{ flex: 1, flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg3, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                  notes (optional)
                </Text>
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="why this count? e.g. post-delivery recheck"
                  placeholderTextColor={C.fg3}
                  style={{
                    height: 30,
                    paddingHorizontal: 10,
                    fontFamily: mono(400),
                    fontSize: 11.5,
                    color: C.fg,
                    backgroundColor: C.panel,
                    borderWidth: 1,
                    borderColor: C.border,
                    borderRadius: CmdRadius.sm,
                    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                  }}
                />
              </View>
            </View>
            {/* Ingredient-name search — view-only; narrows the rows shown but
                submission still covers every item with an entry. */}
            <FilterInput
              value={search}
              onChangeText={setSearch}
              placeholder={T('section.inventoryCount.searchPlaceholder')}
              showKbdHint={false}
              style={{ marginBottom: 8 }}
            />
            {/* Category chips — same idea as EOD's chip row, but no vendor
                filter (counts cover every item by default per Q6). */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {categories.map((c) => {
                const sel = c.id === selectedCategory;
                return (
                  <TouchableOpacity
                    key={c.id}
                    onPress={() => setSelectedCategory(c.id)}
                    accessibilityRole="button"
                    accessibilityLabel={c.label}
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
              })}
            </View>
            {/* Spec 110 — layout pill row (Default + up to 3 named layouts) +
                the admin-only authoring controls. Picking a pill applies its
                saved order as a flat Custom view (headers suppressed); Default
                renders the category-grouped built-in order. The drag list below
                edits the selected layout's order and persists ONLY on "Save
                layout" (explicit, replacing spec-103 auto-save-on-drag). The
                "Save layout" control is textually + visually distinct from the
                spec-106 "Save draft" button (which lives in the tab strip) so
                the two are not confused. */}
            <View style={{ gap: 8 }}>
              {/* Pills — Default + one per named layout. */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                <TouchableOpacity
                  testID="inv-layout-default"
                  onPress={onPickDefault}
                  accessibilityRole="button"
                  accessibilityState={{ selected: selectedLayoutId === null }}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: CmdRadius.md,
                    borderWidth: 1,
                    borderColor: selectedLayoutId === null ? C.accent : C.border,
                    backgroundColor: selectedLayoutId === null ? C.accentBg : C.panel,
                  }}
                >
                  <Text style={{ fontFamily: mono(selectedLayoutId === null ? 700 : 500), fontSize: 10.5, color: selectedLayoutId === null ? C.accent : C.fg2 }}>
                    {T('section.countLayout.default')}
                  </Text>
                </TouchableOpacity>
                {layouts.map((l) => {
                  const sel = l.id === selectedLayoutId;
                  return (
                    <TouchableOpacity
                      key={l.id}
                      testID={`inv-layout-pill-${l.id}`}
                      onPress={() => onPickLayout(l)}
                      accessibilityRole="button"
                      accessibilityLabel={l.name}
                      accessibilityState={{ selected: sel }}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderRadius: CmdRadius.md,
                        borderWidth: 1,
                        borderColor: sel ? C.accent : C.border,
                        backgroundColor: sel ? C.accentBg : C.panel,
                      }}
                    >
                      <Text style={{ fontFamily: mono(sel ? 700 : 500), fontSize: 10.5, color: sel ? C.accent : C.fg2 }} numberOfLines={1}>
                        {l.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {/* Authoring controls (admin-only surface). Save overwrites the
                  selected layout or, with none selected, prompts to name a new
                  one (blocked client-side at 3). Rename/Delete act on the
                  selected pill. */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                <TouchableOpacity
                  testID="inv-layout-save"
                  onPress={onSaveLayout}
                  disabled={savingLayout}
                  accessibilityRole="button"
                  accessibilityLabel={
                    selectedLayout
                      ? T('section.countLayout.overwrite', { name: selectedLayout.name })
                      : T('section.countLayout.saveLayout')
                  }
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: CmdRadius.sm,
                    borderWidth: 1,
                    borderColor: C.accent,
                    backgroundColor: C.accentBg,
                    opacity: savingLayout ? 0.5 : 1,
                    ...(Platform.OS === 'web' && savingLayout ? ({ pointerEvents: 'none' } as any) : {}),
                  }}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.accent }}>
                    {selectedLayout
                      ? T('section.countLayout.overwrite', { name: selectedLayout.name })
                      : T('section.countLayout.saveLayout')}
                  </Text>
                </TouchableOpacity>
                {selectedLayout ? (
                  <TouchableOpacity
                    testID="inv-layout-save-as-new"
                    onPress={onSaveAsNew}
                    disabled={savingLayout}
                    accessibilityRole="button"
                    accessibilityLabel={T('section.countLayout.saveAsNew')}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: CmdRadius.sm,
                      borderWidth: 1,
                      borderColor: C.border,
                      opacity: savingLayout ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>
                      {T('section.countLayout.saveAsNew')}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {selectedLayout ? (
                  <>
                    <TouchableOpacity
                      testID="inv-layout-rename"
                      onPress={onRenameSelected}
                      accessibilityRole="button"
                      accessibilityLabel={T('section.countLayout.rename')}
                      style={{ paddingHorizontal: 8, paddingVertical: 5 }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.accent }}>
                        {T('section.countLayout.rename')}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID="inv-layout-delete"
                      onPress={onDeleteSelected}
                      accessibilityRole="button"
                      accessibilityLabel={T('section.countLayout.delete')}
                      style={{ paddingHorizontal: 8, paddingVertical: 5 }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.danger }}>
                        {T('section.countLayout.delete')}
                      </Text>
                    </TouchableOpacity>
                  </>
                ) : null}
              </View>
            </View>
          </View>

          {/* Item list — same per-category grouping as EOD */}
          <View style={{ paddingTop: 8 }}>
            <View
              style={{
                flexDirection: 'row',
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: C.border,
                borderStyle: 'dashed',
                gap: rowGap,
              }}
            >
              <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, flex: isPhone ? 2 : 1 }]}>
                item · pack
              </Text>
              <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: cellW, textAlign: 'center' }]}>
                cases
              </Text>
              <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: cellW, textAlign: 'center' }]}>
                loose units
              </Text>
              <Text
                style={[
                  Type.captionLg,
                  { color: C.fg3, fontSize: 9.5, ...(isPhone ? { flex: 1, minWidth: 0 } : { width: 180 }) },
                ]}
              >
                note
              </Text>
            </View>
            {viewMode === 'custom' ? (
              // Spec 103 — flat Custom view in the user's saved drag order,
              // category headers suppressed (OQ-2). Drag/▲▼ reorder is disabled
              // while a search OR a category chip narrows the list: onReorder
              // replaces the ranking wholesale with the VISIBLE ids, so a
              // filtered drag would silently shrink what Save persists to the
              // store-shared layout (spec 110 code-review SF-1). Rows are
              // byte-identical to grouped view (renderInventoryRow).
              customVisibleItems.length === 0 ? (
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 32, textAlign: 'center' }}>
                  no items in this filter
                </Text>
              ) : (
                <View style={{ marginTop: 14 }}>
                  {search.trim() || selectedCategory !== 'all'
                    ? customVisibleItems.map((it, i) => renderInventoryRow(it, i !== 0))
                    : (
                      <CountOrderDragList
                        items={customVisibleItems}
                        onReorder={onReorder}
                        renderRow={(it) => renderInventoryRow(it, false)}
                      />
                    )}
                </View>
              )
            ) : grouped.length === 0 ? (
              <Text
                style={{
                  fontFamily: mono(400),
                  fontSize: 11,
                  color: C.fg3,
                  padding: 32,
                  textAlign: 'center',
                }}
              >
                no items in this filter
              </Text>
            ) : (
              grouped.map(([cat, items], gi) => (
                <View key={cat} style={{ marginTop: gi === 0 ? 14 : 22 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <Text
                      style={{
                        fontFamily: mono(700),
                        fontSize: 10.5,
                        color: C.fg3,
                        letterSpacing: 0.7,
                        textTransform: 'uppercase',
                      }}
                    >
                      // {cat.toLowerCase()}
                    </Text>
                    <View style={{ flex: 1, height: 1, backgroundColor: C.border }} />
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg3 }}>
                      {items.length} items
                    </Text>
                  </View>
                  {items.map((it, i) => renderInventoryRow(it, i !== 0))}
                </View>
              ))
            )}
          </View>
        </ScrollView>
      )}

      {/* Sticky footer summary — count.tsx only */}
      {tabId === 'count.tsx' ? (
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
          <Text
            style={{
              fontFamily: mono(400),
              fontSize: 11,
              color: nonBlankCount > 0 && !hasNegative ? C.ok : C.warn,
            }}
          >
            {nonBlankCount}/{totalItems} counted
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>
            kind <Text style={{ color: C.fg, fontWeight: '600' }}>{inventoryCountKindLabel(kind, T)}</Text>
          </Text>
          {hasNegative ? (
            <>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.danger }}>
                negative values not allowed
              </Text>
            </>
          ) : null}
          <View style={{ flex: 1 }} />
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            counter:{' '}
            <Text style={{ color: C.fg }}>
              {currentUser?.name?.toLowerCase().replace(/\s+/g, '.') || 'guest'}
            </Text>
          </Text>
        </View>
      ) : null}

      {/* Spec 110 — layout name-entry modal (create + rename). Self-gates on
          `visible`; the caller resolves the create-vs-rename copy + initial. */}
      <CountLayoutNameModal
        visible={nameModal !== null}
        title={
          nameModal?.mode === 'rename'
            ? T('section.countLayout.renameTitle')
            : T('section.countLayout.nameNewTitle')
        }
        initialValue={nameModal?.mode === 'rename' ? nameModal.initial : ''}
        placeholder={T('section.countLayout.nameNewPlaceholder')}
        onSubmit={onNameSubmit}
        onClose={() => setNameModal(null)}
      />
    </View>
  );
}

// ─── history.tsx — last 10 counts ───────────────────────────────────
function HistoryTab({
  counts,
  loading,
  onSelect,
}: {
  counts: InventoryCountSummary[];
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  const C = useCmdColors();
  const T = useT();
  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.inventoryCount.recentTitle')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Last 10 inventory counts for this store. Click a row to view the read-only entry list.
        </Text>
      </View>
      <View
        style={{
          backgroundColor: C.panel,
          borderRadius: CmdRadius.lg,
          borderWidth: 1,
          borderColor: C.border,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 8,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
          }}
        >
          <SectionCaption tone="fg3" size={10.5}>
            recent_counts.tsv
          </SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
            {loading ? 'loading…' : `${counts.length} ${counts.length === 1 ? 'count' : 'counts'}`}
          </Text>
        </View>
        {!loading && counts.length === 0 ? (
          <Text
            style={{
              fontFamily: mono(400),
              fontSize: 11,
              color: C.fg3,
              padding: 22,
              textAlign: 'center',
            }}
          >
            no inventory counts recorded yet — submit one in the count.tsx tab
          </Text>
        ) : (
          <>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 6,
                paddingHorizontal: 14,
                gap: 10,
                borderBottomWidth: 1,
                borderBottomColor: C.border,
              }}
            >
              <Text
                style={{
                  fontFamily: mono(700),
                  fontSize: 9.5,
                  color: C.fg3,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  width: 110,
                }}
              >
                kind
              </Text>
              <Text
                style={{
                  fontFamily: mono(700),
                  fontSize: 9.5,
                  color: C.fg3,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  width: 120,
                }}
              >
                counted at
              </Text>
              <Text
                style={{
                  fontFamily: mono(700),
                  fontSize: 9.5,
                  color: C.fg3,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  flex: 1,
                }}
              >
                submitter
              </Text>
              <Text
                style={{
                  fontFamily: mono(700),
                  fontSize: 9.5,
                  color: C.fg3,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  width: 70,
                  textAlign: 'right',
                }}
              >
                items
              </Text>
              <Text
                style={{
                  fontFamily: mono(700),
                  fontSize: 9.5,
                  color: C.fg3,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  width: 70,
                  textAlign: 'right',
                }}
              >
                view
              </Text>
            </View>
            {counts.map((c, i) => {
              const rel = relativeTime(c.countedAt) || '';
              return (
                <TouchableOpacity
                  key={c.id}
                  onPress={() => onSelect(c.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`View inventory count from ${rel}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 9,
                    paddingHorizontal: 14,
                    gap: 10,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: C.border,
                  }}
                >
                  <View
                    style={{
                      width: 110,
                      flexDirection: 'row',
                      alignItems: 'center',
                    }}
                  >
                    <View
                      style={{
                        paddingHorizontal: 9,
                        paddingVertical: 2,
                        borderRadius: CmdRadius.pill,
                        backgroundColor: C.accentBg,
                        borderWidth: 0.5,
                        borderColor: C.accent,
                      }}
                    >
                      <Text
                        style={{
                          fontFamily: mono(700),
                          fontSize: 9.5,
                          color: C.accent,
                          letterSpacing: 0.4,
                          textTransform: 'uppercase',
                        }}
                      >
                        {inventoryCountKindLabel(c.kind, T)}
                      </Text>
                    </View>
                  </View>
                  <View style={{ width: 120 }}>
                    <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>
                      {rel || '—'}
                    </Text>
                    <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, marginTop: 1 }}>
                      {c.countedAt ? new Date(c.countedAt).toLocaleString() : ''}
                    </Text>
                  </View>
                  <Text
                    style={{ fontFamily: sans(500), fontSize: 12, color: C.fg2, flex: 1 }}
                    numberOfLines={1}
                  >
                    {c.submitterName || '—'}
                  </Text>
                  <Text
                    style={{
                      fontFamily: mono(400),
                      fontSize: 11.5,
                      color: C.fg,
                      width: 70,
                      textAlign: 'right',
                    }}
                  >
                    {c.itemCount}
                  </Text>
                  <Text
                    style={{
                      fontFamily: mono(700),
                      fontSize: 10.5,
                      color: C.accent,
                      width: 70,
                      textAlign: 'right',
                    }}
                  >
                    OPEN →
                  </Text>
                </TouchableOpacity>
              );
            })}
          </>
        )}
      </View>
    </ScrollView>
  );
}

// ─── Detail view (read-only) ────────────────────────────────────────
function DetailFrame({
  countId,
  detail,
  loading,
  inventoryById,
  reorderByItem,
  onBack,
}: {
  countId: string;
  detail: InventoryCount | null;
  loading: boolean;
  // Spec 105 — the store's CURRENT inventory rows keyed by item id (the par
  // join source, OQ-1) + the companion reorder suggestion keyed by item id.
  inventoryById: ReadonlyMap<string, ParInventoryRow>;
  reorderByItem: Record<string, CountedReorderItem>;
  onBack: () => void;
}) {
  const C = useCmdColors();
  const T = useT();
  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      {/* Back-button header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <TouchableOpacity
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to recent counts list"
          style={{
            paddingVertical: 4,
            paddingHorizontal: 10,
            borderWidth: 1,
            borderColor: C.borderStrong,
            borderRadius: CmdRadius.sm,
          }}
        >
          <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>← BACK</Text>
        </TouchableOpacity>
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
          inventory_count · {countId.slice(0, 8)}
        </Text>
      </View>
      {loading || !detail ? (
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 32, textAlign: 'center' }}>
          {loading ? 'loading detail…' : 'count not found'}
        </Text>
      ) : (
        <>
          <View>
            <Text style={[Type.h1, { color: C.fg }]}>
              {inventoryCountKindLabel(detail.kind, T)} count · {new Date(detail.countedAt).toLocaleString()}
            </Text>
            <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
              {detail.submitterName ? `by ${detail.submitterName}` : 'submitter unavailable'}
              {' · '}
              {detail.entries.length} {detail.entries.length === 1 ? 'entry' : 'entries'}
            </Text>
            {detail.notes ? (
              <Text style={{ fontFamily: sans(400), fontSize: 12.5, color: C.fg2, marginTop: 6 }}>
                <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  notes ·{' '}
                </Text>
                {detail.notes}
              </Text>
            ) : null}
          </View>
          <View
            style={{
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingTop: 12,
                paddingBottom: 8,
                borderBottomWidth: 1,
                borderBottomColor: C.border,
              }}
            >
              <SectionCaption tone="fg3" size={10.5}>
                entries.tsv
              </SectionCaption>
              <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>read-only</Text>
            </View>
            {/* Spec 105 — dual-basis honesty caption (AC line 93). The ✓/red
                check is vs CURRENT par (re-colors as par drifts, OQ-1), and the
                below-par reorder suggestion mixes THIS count's on-hand with LIVE
                usage-forecast + delivery timing — i.e. "what you'd order right
                now given this count", not a pure point-in-time value. */}
            <Text
              style={{
                fontFamily: mono(400),
                fontSize: 9.5,
                color: C.fg3,
                paddingHorizontal: 14,
                paddingBottom: 8,
                lineHeight: 14,
              }}
            >
              ✓ / ● checked vs current par · reorder suggestion mixes this count's on-hand with live forecast + delivery timing
            </Text>
            {detail.entries.length === 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
                no entries recorded
              </Text>
            ) : (
              <>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 6,
                    paddingHorizontal: 14,
                    gap: 10,
                    borderBottomWidth: 1,
                    borderBottomColor: C.border,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: mono(700),
                      fontSize: 9.5,
                      color: C.fg3,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      flex: 1,
                    }}
                  >
                    item
                  </Text>
                  <Text
                    style={{
                      fontFamily: mono(700),
                      fontSize: 9.5,
                      color: C.fg3,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      width: 80,
                      textAlign: 'right',
                    }}
                  >
                    cases
                  </Text>
                  <Text
                    style={{
                      fontFamily: mono(700),
                      fontSize: 9.5,
                      color: C.fg3,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      width: 80,
                      textAlign: 'right',
                    }}
                  >
                    loose units
                  </Text>
                  <Text
                    style={{
                      fontFamily: mono(700),
                      fontSize: 9.5,
                      color: C.fg3,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      width: 110,
                      textAlign: 'right',
                    }}
                  >
                    total
                  </Text>
                  <Text
                    style={{
                      fontFamily: mono(700),
                      fontSize: 9.5,
                      color: C.fg3,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      flex: 1.2,
                    }}
                  >
                    note
                  </Text>
                </View>
                {detail.entries.map((e, i) => {
                  // Spec 105 — par join off the store's CURRENT inventory (OQ-1):
                  // above → green ✓, below → red dot + inline suggestion, none →
                  // NO marker (item unresolvable, par <= 0, or null total; OQ-4).
                  const parItem = inventoryById.get(e.itemId);
                  const parState = parStateFor(e.actualRemaining, parItem?.parLevel ?? 0);
                  // Below-par suggestion (may be absent when suggested_qty <
                  // 0.001 collapsed the item out of the response → bare red dot).
                  const suggestion = parState === 'below' ? reorderByItem[e.itemId] : undefined;
                  const suggestionText = suggestion
                    ? formatCountedReorderSuggestion(suggestion, e.unit ?? parItem?.unit)
                    : '';
                  return (
                    <View
                      key={e.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 9,
                        paddingHorizontal: 14,
                        gap: 10,
                        borderTopWidth: i === 0 ? 0 : 1,
                        borderTopColor: C.border,
                        borderStyle: 'dashed',
                      }}
                    >
                      {/* item cell — par indicator (✓ / ●) inline before the
                          name; no marker at all for the 'none' state (OQ-4). */}
                      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        {parState === 'above' ? (
                          <Text
                            accessibilityLabel="at or above par"
                            style={{ fontFamily: mono(700), fontSize: 12, color: C.ok, width: 12, textAlign: 'center' }}
                          >
                            ✓
                          </Text>
                        ) : parState === 'below' ? (
                          <Text
                            accessibilityLabel="below par"
                            style={{ fontFamily: mono(700), fontSize: 13, color: C.danger, width: 12, textAlign: 'center' }}
                          >
                            ●
                          </Text>
                        ) : (
                          <View style={{ width: 12 }} />
                        )}
                        <Text
                          style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1, minWidth: 0 }}
                          numberOfLines={1}
                        >
                          {e.itemName || '(unknown item)'}
                        </Text>
                      </View>
                      <Text
                        style={{
                          fontFamily: mono(400),
                          fontSize: 11.5,
                          color: C.fg2,
                          width: 80,
                          textAlign: 'right',
                        }}
                      >
                        {e.actualRemainingCases != null ? e.actualRemainingCases : '—'}
                      </Text>
                      <Text
                        style={{
                          fontFamily: mono(400),
                          fontSize: 11.5,
                          color: C.fg2,
                          width: 80,
                          textAlign: 'right',
                        }}
                      >
                        {e.actualRemainingEach != null ? e.actualRemainingEach : '—'}
                      </Text>
                      <Text
                        style={{
                          fontFamily: mono(600),
                          fontSize: 11.5,
                          color: C.fg,
                          width: 110,
                          textAlign: 'right',
                        }}
                      >
                        {e.actualRemaining != null ? e.actualRemaining : '—'} {e.unit || ''}
                      </Text>
                      {/* note cell — persisted entry note, and BELOW it the
                          inline reorder suggestion for below-par rows (no 6th
                          column; OQ-5). Quantity/timing only, NO cost. */}
                      <View style={{ flex: 1.2, minWidth: 0 }}>
                        {e.notes ? (
                          <Text
                            style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}
                            numberOfLines={1}
                          >
                            {e.notes}
                          </Text>
                        ) : null}
                        {suggestionText ? (
                          <Text
                            style={{
                              fontFamily: mono(500),
                              fontSize: 10,
                              color: C.danger,
                              marginTop: e.notes ? 3 : 0,
                              lineHeight: 13,
                            }}
                          >
                            {suggestionText}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

// ─── weekly.tsx — per-store weekly cadence + completed/overdue status ──
// Spec 098 §7 (admin side). One row per visible store: a completed/overdue
// chip (mapping the RPC's open|overdue → overdue for display, completed →
// completed, not_scheduled → a muted "no cadence" pill) plus a per-store
// due-day <select> (0=Sun..6=Sat) wired to setStoreWeeklyDueDow.
function WeeklyTab({
  stores,
  status,
  loading,
  onSetDueDow,
  onRefresh,
}: {
  stores: Store[];
  status: WeeklyCountStatus[];
  loading: boolean;
  onSetDueDow: (id: string, dow: number | null) => void;
  onRefresh: () => void;
}) {
  const C = useCmdColors();
  // Index the RPC rows by store for O(1) lookup.
  const byStore = React.useMemo(() => {
    const m = new Map<string, WeeklyCountStatus>();
    for (const r of status) m.set(r.storeId, r);
    return m;
  }, [status]);

  // Only active stores get a cadence row (matches the RPC's active-store
  // scope); alphabetized for a stable scan order.
  const rows = React.useMemo(
    () =>
      stores
        .filter((s) => s.status === 'active' && s.id && s.id !== '__all__')
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [stores],
  );

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>Weekly counts</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Per-store weekly full-count cadence + completed/overdue status for the current week.
          Set a due day to schedule the count; any store member can complete it.
        </Text>
      </View>
      <View
        style={{
          backgroundColor: C.panel,
          borderRadius: CmdRadius.lg,
          borderWidth: 1,
          borderColor: C.border,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 8,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
          }}
        >
          <SectionCaption tone="fg3" size={10.5}>
            weekly_status.tsv
          </SectionCaption>
          <TouchableOpacity onPress={onRefresh} accessibilityRole="button" accessibilityLabel="Refresh weekly status">
            <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: loading ? C.fg3 : C.accent }}>
              {loading ? 'loading…' : 'refresh'}
            </Text>
          </TouchableOpacity>
        </View>
        {/* Column header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 6,
            paddingHorizontal: 14,
            gap: 10,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>
            store
          </Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 130 }}>
            due day
          </Text>
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 120, textAlign: 'right' }}>
            status
          </Text>
        </View>
        {rows.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            no active stores
          </Text>
        ) : (
          rows.map((s, i) => {
            const st = byStore.get(s.id);
            // Prefer the live RPC due_dow; fall back to the local store row
            // (the optimistic write updates the store slice immediately).
            const dueDow =
              st?.dueDow != null ? st.dueDow : s.weeklyCountDueDow ?? null;
            // Display status: collapse open|overdue → OVERDUE on/after the
            // due day; completed → COMPLETED; not_scheduled / no cadence →
            // NOT SCHEDULED.
            let label: string;
            let tone: { bg: string; fg: string; border: string };
            if (dueDow == null || st?.status === 'not_scheduled') {
              label = 'NOT SCHEDULED';
              tone = { bg: C.panel2, fg: C.fg3, border: C.border };
            } else if (st?.status === 'completed') {
              label = 'COMPLETED';
              tone = { bg: C.okBg, fg: C.ok, border: C.ok };
            } else {
              label = 'OVERDUE';
              tone = { bg: C.dangerBg, fg: C.danger, border: C.danger };
            }
            return (
              <View
                key={s.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 9,
                  paddingHorizontal: 14,
                  gap: 10,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: C.border,
                }}
              >
                <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                  {s.name}
                </Text>
                <View style={{ width: 130 }}>
                  {Platform.OS === 'web' ? (
                    // @ts-ignore — react-native-web passes web <select> through.
                    <select
                      value={dueDow == null ? '' : String(dueDow)}
                      onChange={(e: any) => {
                        const v = e.target.value;
                        onSetDueDow(s.id, v === '' ? null : Number(v));
                      }}
                      aria-label={`Weekly due day for ${s.name}`}
                      style={{
                        height: 28,
                        paddingLeft: 6,
                        paddingRight: 6,
                        fontFamily: 'monospace',
                        fontSize: 11.5,
                        color: C.fg,
                        backgroundColor: C.panel,
                        borderWidth: 1,
                        borderColor: C.border,
                        borderRadius: CmdRadius.sm,
                        outlineStyle: 'none',
                      }}
                    >
                      <option value="">— none —</option>
                      {DOW_LABELS.map((d, idx) => (
                        <option key={d} value={String(idx)}>
                          {d}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg2 }}>
                      {dueDow == null ? '— none —' : DOW_LABELS[dueDow]}
                    </Text>
                  )}
                </View>
                <View style={{ width: 120, alignItems: 'flex-end' }}>
                  <View
                    style={{
                      paddingHorizontal: 9,
                      paddingVertical: 3,
                      borderRadius: CmdRadius.pill,
                      backgroundColor: tone.bg,
                      borderWidth: 0.5,
                      borderColor: tone.border,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: mono(700),
                        fontSize: 9.5,
                        color: tone.fg,
                        letterSpacing: 0.4,
                      }}
                    >
                      {label}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

// src/screens/staff/screens/WeeklyCount.tsx — the weekly full-store count.
//
// Spec 098 §7. A staff-facing equivalent of the admin Inventory count
// page, used on a weekly cadence:
//   - NOT vendor-scoped — lists EVERY item at the active store.
//   - Dual case/each inputs where case_qty > 1 (spec 086 pattern); single
//     input otherwise.
//   - Submit gated on ≥1 non-blank entry; client-minted client_uuid for
//     idempotency (handled in useStaffStore.submitWeeklyCount).
//   - Date captured at SUBMIT time via the local todayIso() convention.
//   - Advisory snapshot — the RPC does NOT write current_stock.
//
// The persistent WeeklyDueBanner (the "reliable floor" reminder) reads
// the staff store's `weeklyStatus`, which this screen refreshes on focus
// (staff v1 has no realtime). On a successful submit the status flips to
// 'completed' (optimistically in the store) and the banner clears.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { ListRow } from '../components/ListRow';
import { LocaleSwitcher } from '../components/LocaleSwitcher';
import { WeeklyDueBanner } from '../components/WeeklyDueBanner';
import { supabase } from '../../../lib/supabase';
import { notifyBackendError } from '../lib/notifyBackendError';
// Spec 110 — the staff Weekly screen is PICK-ONLY: it reads the store's shared
// named layouts (read-only carve-out) and applies a picked one via the same pure
// applyCountOrder/firstUncounted the spec-103 render used. No drag, no save, no
// reset here (OQ-1: authoring is admin-only; OQ-2 removed the per-user order) —
// so the spec-103 write helpers + the drag component are intentionally gone.
import {
  applyCountOrder,
  firstUncounted,
  fetchStoreCountLayouts,
  type StoreCountLayout,
} from '../lib/countLayouts';
// Spec 106 — save-draft + resume (staff carve-out). Server I/O authored against
// supabase.from('user_count_drafts') directly + an AsyncStorage device-local
// trio; the pure reconcile/(de)serialize/stale-filter helpers are re-exported
// from the shared src/lib/countDrafts module (single-sourced with the admin path).
import {
  fetchCountDraft,
  saveCountDraft,
  deleteCountDraft,
  readLocalStaffDraft,
  writeLocalStaffDraft,
  clearLocalStaffDraft,
  reconcileDrafts,
  applyDraftStaleFilter,
  serializeWeeklyDraft,
  deserializeWeeklyDraft,
} from '../lib/countDrafts';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { todayIso } from '../lib/date';
import { confirmAction } from '../../../utils/confirmAction';
import { relativeTime } from '../../../utils/relativeTime';
import { currentStaffUserId, useStaffStore } from '../store/useStaffStore';
import { t, useI18n } from '../i18n';
import { getLocalizedName } from '../../../i18n/localizedName';
import { matchesQuery } from '../../../i18n/matchesQuery';
import type { LocalizedNames, WeeklyLowStockItem } from '../../../types';
import { radius, spacing, typography, useStaffColors } from '../theme';
import type { WeeklyEntry, WeeklyItem } from '../lib/types';

// Takes a `t` so the caller can pass the reactive `useI18n()` t (spec
// 099) — the header label must re-translate on a locale change.
function todayHeaderLabel(tt: typeof t, d = new Date()): string {
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return tt('weekly.header.today', { weekday, monthDay });
}

// ── data fetch ────────────────────────────────────────────────────
async function fetchAllItemsForStore(storeId: string): Promise<WeeklyItem[]> {
  // Every inventory item at the store (NOT vendor-scoped) joined to the
  // catalog for the canonical name + unit + units-per-case. Same source
  // the EOD screen reads (catalog_ingredients.case_qty, spec 086).
  const { data, error } = await supabase
    .from('inventory_items')
    .select('id, catalog:catalog_ingredients(name, unit, category, case_qty, i18n_names)')
    .eq('store_id', storeId)
    .order('id', { ascending: true });
  if (error) throw error;
  type CatalogRow = {
    name: string | null;
    unit: string | null;
    category: string | null;
    case_qty: number | string | null;
    i18n_names: LocalizedNames | null;
  };
  type Row = {
    id: string;
    catalog: CatalogRow | CatalogRow[] | null;
  };
  const rows = (data ?? []) as Row[];
  return rows
    .map((r) => {
      const c = Array.isArray(r.catalog) ? r.catalog[0] : r.catalog;
      return {
        id: r.id,
        name: c?.name ?? '',
        unit: c?.unit ?? '',
        // Collapse null/missing category to '' (same convention as the
        // admin inventory mapper, db.ts:3498); the render groups the ''
        // bucket under an "Uncategorized" header.
        category: c?.category ?? '',
        caseQty: c?.case_qty == null ? null : Number(c.case_qty),
        // Per-locale name overrides — null/missing → undefined so
        // getLocalizedName falls back to the English `name`.
        i18nNames: c?.i18n_names ?? undefined,
      };
    })
    // Stable alphabetical order so the long full-store list is scannable.
    // Sort on the canonical English name — locale-independent so the list
    // order stays stable across a locale switch (the displayed labels are
    // localized at render via getLocalizedName).
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Spec 102 (US-5 / AC-H) — advisory low-stock warning. Calls the read-only
// `report_weekly_lowstock` RPC for the store and returns a map keyed by item
// id, so each row can show a "LOW" badge when on-hand won't cover usage until
// the NEAREST next delivery (OQ-4). Staff carve-out: direct `supabase.rpc`
// (same posture as the staff reorder fetch). Advisory ONLY — no ordering. The
// fetch is best-effort: a failure leaves the map empty (no badges) and never
// blocks the count list. Items with no vendor link are simply absent from the
// payload (no next-delivery date to compare against) → no badge, which is the
// correct degrade.
async function fetchLowStock(storeId: string): Promise<Map<string, WeeklyLowStockItem>> {
  const { data, error } = await supabase.rpc('report_weekly_lowstock', {
    p_store_id: storeId,
    p_params: {},
  });
  if (error) throw error;
  const envelope = (data || {}) as { items?: any[] };
  const map = new Map<string, WeeklyLowStockItem>();
  for (const it of Array.isArray(envelope.items) ? envelope.items : []) {
    const itemId = String(it?.item_id ?? '');
    if (!itemId) continue;
    map.set(itemId, {
      itemId,
      itemName: String(it?.item_name ?? ''),
      unit: String(it?.unit ?? ''),
      onHand: Number(it?.on_hand ?? 0),
      nextDeliveryDate: String(it?.next_delivery_date ?? ''),
      daysUntil: Number(it?.days_until ?? 0),
      usagePerDay: Number(it?.usage_per_day ?? 0),
      projectedOnHand: Number(it?.projected_on_hand ?? 0),
      lowStock: Boolean(it?.low_stock ?? false),
    });
  }
  return map;
}

// Fetch the store's ingredient categories with their per-locale name
// overrides, keyed by the canonical category NAME (the same string the
// catalog rows store in `category`). Staff carve-out: direct
// `supabase.from('ingredient_categories')`. Errors are swallowed to a
// best-effort empty map — category localization is display-only and must
// never block the count list (the header falls back to the raw English
// category text). RLS scopes the rows the manager can see.
async function fetchCategoryI18n(): Promise<Map<string, LocalizedNames>> {
  const { data, error } = await supabase
    .from('ingredient_categories')
    .select('name, i18n_names');
  if (error) throw error;
  type Row = { name: string | null; i18n_names: LocalizedNames | null };
  const rows = (data ?? []) as Row[];
  const map = new Map<string, LocalizedNames>();
  for (const r of rows) {
    if (!r.name) continue;
    map.set(r.name, r.i18n_names ?? {});
  }
  return map;
}

// ── screen ────────────────────────────────────────────────────────
export function WeeklyCount() {
  const c = useStaffColors();
  // Reactive `t` (spec 099) — render-path strings re-translate on locale change.
  const { t } = useI18n();
  // Reactive locale slice — item names + category headers are resolved via
  // getLocalizedName(row, locale), so reading the slice directly re-renders
  // them on a locale switch (same reactivity contract as useI18n's `t`).
  const locale = useStaffStore((s) => s.locale);
  const activeStore = useStaffStore((s) => s.activeStore);
  const userId = useStaffStore((s) => currentStaffUserId(s.authState));
  const fetchWeeklyStatus = useStaffStore((s) => s.fetchWeeklyStatus);
  const submitWeeklyCount = useStaffStore((s) => s.submitWeeklyCount);

  const [items, setItems] = useState<WeeklyItem[]>([]);
  // Ingredient-name search — view-only; filters the grouped sections while the
  // full `items` array still drives submission.
  const [search, setSearch] = useState('');
  // Spec 110 — PICK-ONLY shared named layouts. `viewMode`/`savedIds` are the
  // SAME spec-103 render levers (reused verbatim, design §9): Default →
  // savedIds=null (category-grouped SectionList); a picked layout →
  // savedIds=<its item_ids> + viewMode='custom' (flat list, headers
  // suppressed). Render-only: submission + the count-everything gate still
  // iterate the full `items` (AC-11). `layouts` is the store's shared set
  // (0–3, READ-ONLY here); `selectedLayoutId` is which pill is active (null =
  // Default) and persists per-device in component state (like viewMode did) —
  // the selection itself is NOT server state. Staff have NO save/drag/reset.
  const [viewMode, setViewMode] = useState<'default' | 'custom'>('default');
  const [savedIds, setSavedIds] = useState<string[] | null>(null);
  const [layouts, setLayouts] = useState<StoreCountLayout[]>([]);
  const [selectedLayoutId, setSelectedLayoutId] = useState<string | null>(null);
  // name → per-locale category overrides (keyed by canonical English
  // category name; same string the catalog rows store in `category`).
  const [categoryI18n, setCategoryI18n] = useState<Map<string, LocalizedNames>>(
    () => new Map(),
  );
  // Spec 102 (US-5) — advisory low-stock map, keyed by item id. Drives the
  // per-row "LOW" badge. Best-effort: empty when the RPC fails (no badges).
  const [lowStockByItem, setLowStockByItem] = useState<Map<string, WeeklyLowStockItem>>(
    () => new Map(),
  );
  const [caseCounts, setCaseCounts] = useState<Record<string, string>>({});
  const [unitCounts, setUnitCounts] = useState<Record<string, string>>({});
  // Spec: every item must be counted (even "0") before submit. On a blocked
  // submit we jump to the first uncounted row — `listRef` scrolls its section
  // into view, `firstInputRefs` focuses its primary box (Cases when packed,
  // else Units), and `pendingFocusId` drives the effect that does both.
  const listRef = useRef<SectionList<WeeklyItem, { category: string; title: string }>>(null);
  const firstInputRefs = useRef<Record<string, TextInput | null>>({});
  const pendingLocationRef = useRef<{ sectionIndex: number; itemIndex: number } | null>(null);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [forbidden, setForbidden] = useState<boolean>(false);
  const [completedFor, setCompletedFor] = useState<string | null>(null);
  // Spec 106 — save-draft + resume. `draftSavedAt` (ISO of the restored draft's
  // client-stamped saved_at) drives the restored-draft banner; null = no banner.
  // `savingDraft` guards the Save button while a save is in flight. The draft
  // form state itself reuses the existing caseCounts/unitCounts maps (design
  // §14: draft state stays in the screen's local state).
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState<boolean>(false);
  // Connection signal for the Save online/offline branch + the sync-on-reconnect
  // effect (design §7/§9). The staff hook listens to the window 'online'/'offline'
  // event (a genuine connectivity signal), so the offline-gated Save is correct
  // here. `wasOnlineRef` mirrors the useEodSubmit Effect-1 shape (push a newer
  // unsynced local draft on a false→true flip).
  const isOnline = useConnectionStatus();
  const wasOnlineRef = useRef<boolean>(isOnline);
  // Restore-once guard (architect SF-1). The draft-load effect re-keys on
  // `isOnline`, so a connectivity flip re-runs it — but the form RESTORE must
  // fire at most once per (user, store) slot so a reconnect never clobbers
  // keystrokes typed since the last Save. This ref holds the slot key already
  // restored; the reconnect effect owns all post-first-restore sync (storage +
  // banner only, never the form). A slot change re-arms the restore.
  const restoredSlotRef = useRef<string | null>(null);

  // Recompute when `t` (locale) changes so the header date re-translates.
  const todayLabel = useMemo(() => todayHeaderLabel(t), [t]);

  // ─── load every item for the active store on mount / store change ──
  useEffect(() => {
    if (!activeStore) return;
    setLoading(true);
    setForbidden(false);
    setCompletedFor(null);
    fetchAllItemsForStore(activeStore.id)
      .then((next) => {
        setItems(next);
        setCaseCounts({});
        setUnitCounts({});
      })
      .catch((err) => {
        notifyBackendError('fetchAllItemsForStore', err);
        setItems([]);
      })
      .finally(() => setLoading(false));
    // Spec 102 (US-5) — advisory low-stock warnings in parallel. Best-effort:
    // a failure leaves the map empty (no badges) and does NOT gate `loading`
    // (the item list is the primary content). Clears any prior store's map up
    // front so stale badges never leak across a store switch.
    setLowStockByItem(new Map());
    fetchLowStock(activeStore.id)
      .then(setLowStockByItem)
      .catch((err) => {
        notifyBackendError('fetchLowStock', err);
        setLowStockByItem(new Map());
      });
    // Category translations load in parallel — best-effort; a failure
    // leaves the map empty and headers fall back to the raw category text.
    // Does NOT gate `loading` (the item list is the primary content).
    fetchCategoryI18n()
      .then(setCategoryI18n)
      .catch((err) => {
        notifyBackendError('fetchCategoryI18n', err);
        setCategoryI18n(new Map());
      });
  }, [activeStore]);

  // ─── Spec 110: load the store's shared named layouts on mount/store change ──
  // Pick-only (OQ-1): staff READ the store's 0–3 layouts and pick one. On open,
  // start on Default (no pill selected); the counter opts into a layout by
  // picking a pill. A load error degrades to Default-only (best-effort, no
  // blocking). Re-runs on active-store change.
  useEffect(() => {
    if (!activeStore) {
      setLayouts([]);
      setSelectedLayoutId(null);
      setSavedIds(null);
      setViewMode('default');
      return;
    }
    let cancelled = false;
    fetchStoreCountLayouts(activeStore.id)
      .then((rows) => {
        if (cancelled) return;
        setLayouts(rows);
        // Reset selection on a (re)load — the picked layout may have been
        // deleted by an admin; fall back to Default until the counter re-picks.
        setSelectedLayoutId(null);
        setSavedIds(null);
        setViewMode('default');
      })
      .catch((err) => {
        if (cancelled) return;
        notifyBackendError('fetchStoreCountLayouts', err);
        setLayouts([]);
        setSelectedLayoutId(null);
        setSavedIds(null);
        setViewMode('default');
      });
    return () => {
      cancelled = true;
    };
  }, [activeStore]);

  // Pick a pill. Default → category-grouped SectionList (savedIds=null). A named
  // layout → flat Custom view in its saved order (design §9, the spec-103 apply
  // path). Pure render switch — no write (staff are pick-only).
  const onPickDefault = useCallback(() => {
    setSelectedLayoutId(null);
    setSavedIds(null);
    setViewMode('default');
  }, []);

  const onPickLayout = useCallback((layout: StoreCountLayout) => {
    setSelectedLayoutId(layout.id);
    setSavedIds(layout.itemIds);
    setViewMode('custom');
  }, []);

  // ─── Spec 106: save-draft + resume ─────────────────────────────────
  // The live item-id set for the active store — drives applyDraftStaleFilter on
  // restore (an id deleted since the draft was saved is dropped, AC-11).
  const liveItemIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);

  // Jump to the first uncounted row after a restore (reuses the gate's jump
  // machinery). Order follows the on-screen order: custom order in Custom view,
  // category+name in default view (matching onSubmitPress).
  const jumpToFirstUncounted = useCallback(
    (nextCase: Record<string, string>, nextUnit: Record<string, string>) => {
      const isBlank = (it: WeeklyItem) =>
        (nextCase[it.id] ?? '').trim() === '' && (nextUnit[it.id] ?? '').trim() === '';
      const ordered =
        viewMode === 'custom'
          ? applyCountOrder(items, savedIds, (i) => i.id)
          : [...items].sort(
              (a, b) =>
                (a.category || '').localeCompare(b.category || '') ||
                a.name.localeCompare(b.name),
            );
      const target = firstUncounted(ordered, (it) => !isBlank(it));
      if (target) setPendingFocusId(target.id);
    },
    [items, viewMode, savedIds],
  );

  // Restore a reconciled draft payload into the form. Stale-filters against the
  // current live items (AC-11), deserializes (verbatim strings, AC-5), sets the
  // case/unit maps, shows the restored banner, and jumps to the first uncounted
  // row (reuse firstUncounted).
  const restoreDraftToForm = useCallback(
    (payload: Record<string, unknown>, savedAt: string) => {
      const filtered = applyDraftStaleFilter(payload, liveItemIds);
      const form = deserializeWeeklyDraft(filtered);
      setCaseCounts(form.caseCounts);
      setUnitCounts(form.unitCounts);
      setDraftSavedAt(savedAt);
      jumpToFirstUncounted(form.caseCounts, form.unitCounts);
    },
    [liveItemIds, jumpToFirstUncounted],
  );

  // Draft-load effect — parallel to the spec-103 fetchCountOrder effect (a
  // separate table + distinct failure degrade, so NOT folded in). Runs once the
  // items have loaded (so the stale-filter has the live id set). On open: read
  // the AsyncStorage copy, fetch the server copy when online, reconcile
  // (whole-draft last-write-wins), run the sync action, restore from the winner.
  // A failed server fetch degrades to "no draft" (best-effort; AC-5).
  useEffect(() => {
    if (!userId || !activeStore || loading) return;
    const storeId = activeStore.id;
    // Restore-once guard (SF-1): the form RESTORE may fire exactly once per
    // (user, store) slot. `mayRestore` is true only when this slot hasn't been
    // restored yet; a slot change re-arms it, an `isOnline`/`loading` re-run does
    // not — so a reconnect can't clobber keystrokes typed since the last Save.
    // The reconcile sync action below always runs (it only touches storage).
    const slot = `${userId}:${storeId}`;
    const mayRestore = restoredSlotRef.current !== slot;
    let cancelled = false;
    (async () => {
      const local = await readLocalStaffDraft(userId, 'staff-weekly', storeId);
      let server = null as { payload: Record<string, unknown>; savedAt: string } | null;
      if (isOnline) {
        try {
          server = await fetchCountDraft(userId, 'staff-weekly', storeId);
        } catch (err) {
          notifyBackendError('fetchCountDraft', err);
          server = null;
        }
      }
      if (cancelled) return;
      const { winner, restoreFrom, action } = reconcileDrafts(local, server);
      // Run the reconcile sync action (best-effort — a failure leaves the local
      // copy until the next reconcile retries).
      if (action === 'push' && winner) {
        try {
          await saveCountDraft(userId, 'staff-weekly', storeId, winner.payload, winner.savedAt);
          if (!cancelled) {
            await writeLocalStaffDraft(userId, 'staff-weekly', storeId, {
              payload: winner.payload,
              savedAt: winner.savedAt,
              unsynced: false,
            });
          }
        } catch (err) {
          notifyBackendError('saveCountDraft', err);
        }
      } else if (action === 'adopt-clear-local') {
        await clearLocalStaffDraft(userId, 'staff-weekly', storeId);
      } else if (action === 'clear-local-flag' && winner) {
        await writeLocalStaffDraft(userId, 'staff-weekly', storeId, {
          payload: winner.payload,
          savedAt: winner.savedAt,
          unsynced: false,
        });
      }
      if (cancelled) return;
      // Only APPLY the winner to the form on the first pass for this slot — a
      // later re-run (connectivity flip) must not re-restore over in-progress
      // typing (SF-1). The reconnect effect keeps the storage synced.
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
    // restoreDraftToForm depends on liveItemIds/jumpToFirstUncounted; omitted so
    // an unrelated re-render doesn't re-run the reconcile and clobber in-progress
    // edits. The restore captures the item set at load; keyed on user/store/
    // online/loading only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, activeStore, isOnline, loading]);

  // Sync-on-reconnect — on a connectivity false→true flip, reconcile the local+
  // server copies and push a newer unsynced local up WITHOUT clobbering
  // in-progress edits (only the storage + the banner's saved-at are touched;
  // the form is left as the user has it — design §7/§9).
  useEffect(() => {
    const was = wasOnlineRef.current;
    wasOnlineRef.current = isOnline;
    if (was || !isOnline) return; // only act on a false→true flip
    if (!userId || !activeStore) return;
    const storeId = activeStore.id;
    let cancelled = false;
    (async () => {
      const local = await readLocalStaffDraft(userId, 'staff-weekly', storeId);
      if (cancelled || !local) return;
      let server = null as { payload: Record<string, unknown>; savedAt: string } | null;
      try {
        server = await fetchCountDraft(userId, 'staff-weekly', storeId);
      } catch (err) {
        notifyBackendError('fetchCountDraft', err);
        return;
      }
      if (cancelled) return;
      const { winner, action } = reconcileDrafts(local, server);
      if (action === 'push' && winner) {
        try {
          await saveCountDraft(userId, 'staff-weekly', storeId, winner.payload, winner.savedAt);
          if (cancelled) return;
          await writeLocalStaffDraft(userId, 'staff-weekly', storeId, {
            payload: winner.payload,
            savedAt: winner.savedAt,
            unsynced: false,
          });
          setDraftSavedAt((prev) => prev ?? winner.savedAt);
        } catch (err) {
          notifyBackendError('saveCountDraft', err);
        }
      } else if (action === 'adopt-clear-local') {
        await clearLocalStaffDraft(userId, 'staff-weekly', storeId);
      } else if (action === 'clear-local-flag' && winner) {
        await writeLocalStaffDraft(userId, 'staff-weekly', storeId, {
          payload: winner.payload,
          savedAt: winner.savedAt,
          unsynced: false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOnline, userId, activeStore]);

  // Save the current form as a draft. UNGATED — a draft may be partial (AC-2).
  // Mints `savedAt` ONCE at press so the same stamp lands on both the server row
  // and the AsyncStorage copy (design §9). Online → write server, refresh local
  // as synced, "Draft saved". Offline → write local unsynced, "Saved on this
  // device — will sync when online" (AC-13/14). A server error reverts to an
  // unsynced-local copy + a failure toast (optimistic-then-revert).
  const onSaveDraft = useCallback(async () => {
    if (!userId || !activeStore || savingDraft) return;
    const storeId = activeStore.id;
    const savedAt = new Date().toISOString();
    const payload = serializeWeeklyDraft({ caseCounts, unitCounts });
    setSavingDraft(true);
    try {
      if (!isOnline) {
        await writeLocalStaffDraft(userId, 'staff-weekly', storeId, {
          payload,
          savedAt,
          unsynced: true,
        });
        setDraftSavedAt(savedAt);
        Toast.show({
          type: 'success',
          text1: t('weekly.draft.savedLocal'),
          position: 'bottom',
        });
        return;
      }
      try {
        await saveCountDraft(userId, 'staff-weekly', storeId, payload, savedAt);
        await writeLocalStaffDraft(userId, 'staff-weekly', storeId, {
          payload,
          savedAt,
          unsynced: false,
        });
        setDraftSavedAt(savedAt);
        Toast.show({
          type: 'success',
          text1: t('weekly.draft.saved'),
          position: 'bottom',
        });
      } catch (err) {
        // Server write failed — keep a device-local unsynced copy so the work is
        // not lost, and surface the failure. The next reconnect/open pushes it.
        notifyBackendError('saveCountDraft', err);
        await writeLocalStaffDraft(userId, 'staff-weekly', storeId, {
          payload,
          savedAt,
          unsynced: true,
        });
        setDraftSavedAt(savedAt);
        Toast.show({
          type: 'error',
          text1: t('weekly.draft.saveFailed'),
          text2: t('weekly.draft.savedLocal'),
          position: 'bottom',
        });
      }
    } finally {
      setSavingDraft(false);
    }
  }, [userId, activeStore, isOnline, caseCounts, unitCounts, savingDraft, t]);

  // Discard the restored draft (AC-7) — delete BOTH the server row and the
  // AsyncStorage copy, then clear the form back to fresh. Confirmed via the
  // cross-platform confirm util.
  const onDiscardDraft = useCallback(() => {
    if (!userId || !activeStore) return;
    const storeId = activeStore.id;
    confirmAction(
      t('weekly.draft.discardConfirmTitle'),
      t('weekly.draft.discardConfirmBody'),
      () => {
        // Server-first: attempt the server-row delete and only proceed if it
        // succeeds. A silent proceed-on-failure would drop the local copy + the
        // banner while the server row survives, so the next screen-open reconcile
        // would RESURRECT the "discarded" draft (code-reviewer). On failure we
        // keep the banner + values and toast so the discard isn't a silent no-op.
        (async () => {
          try {
            await deleteCountDraft(userId, 'staff-weekly', storeId);
          } catch (err) {
            notifyBackendError('deleteCountDraft', err);
            Toast.show({
              type: 'error',
              text1: t('weekly.draft.discardFailed'),
              position: 'bottom',
            });
            return; // keep the draft (banner + values) — nothing was deleted
          }
          // Server delete succeeded → clear the local copy + the form.
          await clearLocalStaffDraft(userId, 'staff-weekly', storeId);
          setCaseCounts({});
          setUnitCounts({});
          setDraftSavedAt(null);
        })();
      },
      t('weekly.draft.discard'),
    );
  }, [userId, activeStore, t]);

  // ─── refresh the weekly status on focus (banner floor, no realtime) ──
  useFocusEffect(
    useCallback(() => {
      if (!activeStore) return;
      void fetchWeeklyStatus(activeStore.id, todayIso());
    }, [activeStore, fetchWeeklyStatus]),
  );

  // Live progress for the "X of N counted" label — a row counts once EITHER
  // box has a value (same predicate as the red marking + completeness gate).
  const countedNum = useMemo(
    () =>
      items.filter(
        (it) =>
          (caseCounts[it.id] ?? '').trim() !== '' || (unitCounts[it.id] ?? '').trim() !== '',
      ).length,
    [items, caseCounts, unitCounts],
  );

  // ─── group items by category for display-only section headers ──────
  // Mirrors the admin `grouped` idiom (InventoryCountSection.tsx): a Map
  // keyed by category, items alphabetized within each group (the source
  // list is already name-sorted), groups sorted alphabetically. The empty
  // '' bucket maps to an "Uncategorized" title. Grouping is VIEW-only — it
  // never changes what gets submitted (onSubmit iterates `items`, never
  // the grouped sections), per spec.
  const sections = useMemo(() => {
    const visible = search.trim()
      ? items.filter((it) =>
          matchesQuery(search, [
            getLocalizedName({ name: it.name, i18nNames: it.i18nNames }, locale),
            it.name,
          ]),
        )
      : items;
    const map = new Map<string, WeeklyItem[]>();
    for (const it of visible) {
      const arr = map.get(it.category) || [];
      arr.push(it);
      map.set(it.category, arr);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, data]) => ({
        // `category` is the canonical English key — kept stable for the
        // section testID + grouping. `title` is the LOCALIZED header:
        // map the raw category name → its ingredient_categories row →
        // getLocalizedName(override-or-canonical, locale). No matching row
        // or no override → the raw English category text (silent fallback,
        // same rule as item names). The empty bucket localizes the
        // "Uncategorized" label via i18n.
        category,
        title: category
          ? getLocalizedName(
              { name: category, i18nNames: categoryI18n.get(category) },
              locale,
            )
          : t('weekly.category.uncategorized'),
        data,
      }));
  }, [items, t, locale, categoryI18n, search]);

  // Spec 103 — flat Custom view list: the saved ranking applied to the full
  // item set (unranked appended, deleted ignored), THEN narrowed by the search
  // (search composes with the custom order — AC-10). Category headers are
  // suppressed in Custom view (OQ-2).
  const customVisibleItems = useMemo(() => {
    const ordered = applyCountOrder(items, savedIds, (i) => i.id);
    if (!search.trim()) return ordered;
    return ordered.filter((it) =>
      matchesQuery(search, [
        getLocalizedName({ name: it.name, i18nNames: it.i18nNames }, locale),
        it.name,
      ]),
    );
  }, [items, savedIds, search, locale]);

  // Jump to the first uncounted row after a blocked submit. Re-runs when
  // `sections` changes so a target hidden behind the search resolves once the
  // search-clear lands. Scrolls its section/item into view, then focuses its
  // primary box — on web the DOM focus also pulls a clipped input fully in.
  //
  // Spec 103 — in Custom view there is no SectionList; the flat drag list keeps
  // every row mounted (un-windowed), so we skip the scrollToLocation machinery
  // and just focus the target's box (DOM focus scrolls it into view on web).
  useEffect(() => {
    if (!pendingFocusId) return;
    if (viewMode === 'custom') {
      // Only act once the target is actually in the rendered (custom) list — a
      // searched-out target waits for the search-clear re-render.
      const inList = customVisibleItems.some((it) => it.id === pendingFocusId);
      if (!inList) return;
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
    }
    let sectionIndex = -1;
    let itemIndex = -1;
    for (let s = 0; s < sections.length; s++) {
      const i = sections[s].data.findIndex((it) => it.id === pendingFocusId);
      if (i >= 0) {
        sectionIndex = s;
        itemIndex = i;
        break;
      }
    }
    if (sectionIndex < 0) return; // not rendered yet — wait for the re-render
    pendingLocationRef.current = { sectionIndex, itemIndex };
    let cancelled = false;
    try {
      listRef.current?.scrollToLocation({ sectionIndex, itemIndex, viewPosition: 0.3, animated: true });
    } catch {
      // scrollToLocation can throw before layout settles; onScrollToIndexFailed recovers
    }
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
  }, [pendingFocusId, sections, viewMode, customVisibleItems]);

  const onSubmit = useCallback(async () => {
    if (!activeStore || submitting) return;
    if (items.length === 0) return;
    // Build entries — include a row when EITHER its Cases OR Units box is
    // non-empty (mirrors the EOD `hasEntry` rule). Total =
    // cases × (caseQty || 1) + units; raw splits null when blank.
    const entries: WeeklyEntry[] = items
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
          unit: it.unit || null,
        };
      })
      .filter((x): x is WeeklyEntry => x !== null);
    if (entries.length === 0) {
      Toast.show({
        type: 'error',
        text1: t('weekly.toast.failed'),
        text2: t('weekly.toast.noCountsEntered'),
        position: 'bottom',
      });
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitWeeklyCount({
        storeId: activeStore.id,
        countedAt: new Date().toISOString(),
        entries,
        notes: null,
      });
      if (!result) {
        // notifyBackendError already toasted. A 42501 (access changed)
        // surfaces the forbidden banner like EOD does.
        setForbidden(true);
        return;
      }
      if (result.conflict) {
        Toast.show({
          type: 'success',
          text1: t('weekly.toast.alreadySubmitted'),
          position: 'bottom',
        });
      } else {
        Toast.show({
          type: 'success',
          text1: t('weekly.toast.submitted'),
          position: 'bottom',
        });
      }
      // Clear the form and show the "completed for the week of <date>"
      // confirmation. submitWeeklyCount has already optimistically flipped
      // weeklyStatus.status → 'completed' (so the banner clears now);
      // `windowStart` is preserved from the pre-submit status. Re-fetch in
      // the background so the next focus reflects the server truth.
      setCaseCounts({});
      setUnitCounts({});
      // Spec 106 (AC-8) — a completed count deletes its resumable draft (server
      // row + AsyncStorage copy) so reopening shows a fresh form with no stale
      // banner. Best-effort: a delete failure only leaves a dangling draft the
      // next reconcile can clear; it must not block the submit success UX. The
      // `conflict` replay path also lands here — the count is recorded.
      void clearLocalStaffDraft(userId ?? '', 'staff-weekly', activeStore.id);
      if (userId) {
        deleteCountDraft(userId, 'staff-weekly', activeStore.id).catch((err) => {
          notifyBackendError('deleteCountDraft', err);
        });
      }
      setDraftSavedAt(null);
      const ws = useStaffStore.getState().weeklyStatus;
      setCompletedFor(ws?.windowStart ?? todayIso());
      void fetchWeeklyStatus(activeStore.id, todayIso());
    } finally {
      setSubmitting(false);
    }
  }, [activeStore, items, caseCounts, unitCounts, submitWeeklyCount, fetchWeeklyStatus, submitting, userId, t]);

  // ─── gate: every item must be counted before a full-store submit ───
  const onSubmitPress = useCallback(() => {
    // Completeness gate — every store item must be counted (even a typed "0")
    // before submitting. A row counts once EITHER box has a value; the first
    // fully-blank one blocks the submit and we jump to it (clearing the search
    // so a searched-out target can render). Checks the full `items` list, not
    // the search-narrowed sections.
    const isBlank = (it: WeeklyItem) =>
      (caseCounts[it.id] ?? '').trim() === '' && (unitCounts[it.id] ?? '').trim() === '';
    // Completeness COUNT is against the FULL item set, order-independent (AC-9).
    const uncountedCount = items.filter(isBlank).length;
    if (uncountedCount > 0) {
      if (search.trim()) setSearch('');
      // Spec 103 (AC-12) — the JUMP target follows the on-screen order. In
      // Custom view, walk the user's saved order; in default view, walk the
      // category-grouped order (category asc, then name — same sort as
      // `sections`) so the jump lands on the TOPMOST uncounted row.
      const ordered =
        viewMode === 'custom'
          ? applyCountOrder(items, savedIds, (i) => i.id)
          : [...items].sort(
              (a, b) =>
                (a.category || '').localeCompare(b.category || '') ||
                a.name.localeCompare(b.name),
            );
      const target = firstUncounted(ordered, (it) => !isBlank(it));
      if (target) setPendingFocusId(target.id);
      Toast.show({
        type: 'error',
        text1: t('weekly.toast.countAllTitle'),
        text2: t('weekly.toast.countAllRemaining', { count: uncountedCount }),
        position: 'bottom',
      });
      return;
    }
    void onSubmit();
  }, [items, caseCounts, unitCounts, search, viewMode, savedIds, onSubmit, t]);

  // Spec 103 — one shared row body, rendered by BOTH the default SectionList
  // and the flat Custom drag list, so the Custom view shows byte-identical
  // rows (the custom order is render-only). Factored out of the SectionList
  // renderItem.
  const renderWeeklyRow = useCallback(
    (item: WeeklyItem) => {
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
      const low = lowStockByItem.get(item.id);
      const isLow = low?.lowStock === true;
      return (
        <ListRow
          testID={`weekly-item-row-${item.id}`}
          leading={
            <View>
              <View style={styles.itemNameRow}>
                <Text
                  style={[styles.itemName, { color: entered ? c.text : c.error }]}
                  numberOfLines={2}
                >
                  {displayName}
                </Text>
                {isLow ? (
                  <View
                    style={[styles.lowBadge, { backgroundColor: c.warningBg, borderColor: c.warning }]}
                    testID={`weekly-low-badge-${item.id}`}
                  >
                    <Text style={[styles.lowBadgeText, { color: c.warning }]}>
                      {t('weekly.lowStock.badge')}
                    </Text>
                  </View>
                ) : null}
              </View>
              {item.unit || hasPack ? (
                <Text style={[styles.itemUnit, { color: c.textSecondary }]}>
                  {item.unit}
                  {hasPack ? ` · ${t('weekly.row.caseOf', { qty: item.caseQty as number })}` : ''}
                </Text>
              ) : null}
              {hasPack && entered ? (
                <Text
                  style={[styles.itemTotal, { color: c.textSecondary }]}
                  testID={`weekly-item-total-${item.id}`}
                >
                  {t('weekly.row.total', { total, unit: item.unit })}
                </Text>
              ) : null}
            </View>
          }
          trailing={
            hasPack ? (
              <View style={styles.countInputs}>
                <View style={styles.countCol}>
                  <Text style={[styles.countColLabel, { color: c.textSecondary }]}>
                    {t('weekly.col.cases')}
                  </Text>
                  <Input
                    ref={(r) => {
                      firstInputRefs.current[item.id] = r;
                    }}
                    value={caseRaw}
                    onChangeText={(txt) =>
                      setCaseCounts((prev) => ({ ...prev, [item.id]: txt }))
                    }
                    keyboardType="decimal-pad"
                    {...(Platform.OS === 'web' ? { inputMode: 'decimal' as const } : {})}
                    placeholder="0"
                    testID={`weekly-item-cases-${item.id}`}
                    style={[styles.countInput, !entered && { borderColor: c.error }]}
                    accessibilityLabel={t('weekly.col.casesAria', { item: displayName })}
                  />
                </View>
                <View style={styles.countCol}>
                  <Text style={[styles.countColLabel, { color: c.textSecondary }]}>
                    {t('weekly.col.units')}
                  </Text>
                  <Input
                    value={unitRaw}
                    onChangeText={(txt) =>
                      setUnitCounts((prev) => ({ ...prev, [item.id]: txt }))
                    }
                    keyboardType="decimal-pad"
                    {...(Platform.OS === 'web' ? { inputMode: 'decimal' as const } : {})}
                    placeholder="0"
                    testID={`weekly-item-units-${item.id}`}
                    style={[styles.countInput, !entered && { borderColor: c.error }]}
                    accessibilityLabel={t('weekly.col.unitsAria', { item: displayName })}
                  />
                </View>
              </View>
            ) : (
              <View style={styles.countCol}>
                <Text style={[styles.countColLabel, { color: c.textSecondary }]}>
                  {t('weekly.col.units')}
                </Text>
                <Input
                  ref={(r) => {
                    firstInputRefs.current[item.id] = r;
                  }}
                  value={unitRaw}
                  onChangeText={(txt) =>
                    setUnitCounts((prev) => ({ ...prev, [item.id]: txt }))
                  }
                  keyboardType="decimal-pad"
                  {...(Platform.OS === 'web' ? { inputMode: 'decimal' as const } : {})}
                  placeholder="0"
                  testID={`weekly-item-units-${item.id}`}
                  style={[styles.countInput, !entered && { borderColor: c.error }]}
                  accessibilityLabel={t('weekly.col.unitsAria', { item: displayName })}
                />
              </View>
            )
          }
        />
      );
    },
    [caseCounts, unitCounts, locale, lowStockByItem, c, t],
  );

  if (!activeStore) {
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

  return (
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
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          {t('weekly.title')}
        </Text>
        <Text style={[styles.subtitle, { color: c.textSecondary }]} numberOfLines={2}>
          {activeStore.name} · {todayLabel}
        </Text>
        <Text style={[styles.subtitle, { color: c.textTertiary }]} numberOfLines={2}>
          {t('weekly.subtitle')}
        </Text>
        <View style={styles.headerSwitcherRow}>
          <LocaleSwitcher />
        </View>
      </View>

      {/* Persistent due/overdue banner — the reliable floor. */}
      <WeeklyDueBanner />

      {/* Forbidden banner */}
      {forbidden ? <Banner tone="error" text={t('weekly.error.forbidden')} /> : null}

      {/* Completed confirmation */}
      {completedFor ? (
        <Banner
          tone="success"
          text={t('weekly.banner.completed', { date: completedFor })}
          testID="weekly-completed-banner"
        />
      ) : null}

      {/* Spec 106 — restored-draft banner + Discard. Non-blocking; shown only
          when a draft was auto-restored on open. relativeTime gives the saved-at
          staleness signal (AC-6). Discard deletes the server row + the
          AsyncStorage copy and clears the form (AC-7). The Discard control sits
          under the Banner (which is text-only) as a staff-styled link, matching
          the reset-order affordance. */}
      {draftSavedAt ? (
        <View>
          <Banner
            tone="info"
            text={t('weekly.draft.restored', { time: relativeTime(draftSavedAt) })}
            testID="weekly-draft-banner"
          />
          <View style={{ paddingHorizontal: spacing.lg, marginTop: -spacing.xs, marginBottom: spacing.sm, flexDirection: 'row' }}>
            <Pressable
              testID="weekly-draft-discard"
              onPress={onDiscardDraft}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('weekly.draft.discard')}
            >
              <Text style={{ fontSize: typography.caption, fontWeight: typography.semibold, color: c.error }}>
                {t('weekly.draft.discard')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Live "X of N counted" progress for the full store — turns green once
          every item is counted (ties into the count-everything gate). */}
      {!loading && items.length > 0 ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm }}>
          <Text
            testID="weekly-counted-label"
            style={{
              fontSize: typography.caption,
              fontWeight: typography.semibold,
              color: countedNum === items.length ? c.primary : c.textSecondary,
            }}
          >
            {t('weekly.countedOfTotal', { counted: countedNum, total: items.length })}
          </Text>
        </View>
      ) : null}

      {/* Ingredient-name search — view-only; shown once the store's items
          have loaded. */}
      {!loading && items.length > 0 ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Input
              testID="weekly-search"
              placeholder={t('weekly.list.searchPlaceholder')}
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          {search ? (
            <Pressable
              testID="weekly-search-clear"
              onPress={() => setSearch('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('chrome.clear')}
            >
              <Text style={{ color: c.textSecondary, fontSize: 22, paddingHorizontal: spacing.xs }}>✕</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Spec 110 — PICK-ONLY layout pill row (Default + up to 3 named layouts).
          Picking a named pill applies its saved order as a flat Custom view
          (headers suppressed); Default renders the category-grouped list. NO
          Save button, NO drag, NO reset — staff cannot author layouts (OQ-1);
          the spec-103 customize/drag affordances are removed from THIS screen
          only (the spec-106 Save-DRAFT button in the footer is untouched). */}
      {!loading && items.length > 0 ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm }}>
          <Pressable
            testID="weekly-layout-default"
            onPress={onPickDefault}
            accessibilityRole="button"
            accessibilityState={{ selected: selectedLayoutId === null }}
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.xs,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: selectedLayoutId === null ? c.primary : c.border,
              backgroundColor: selectedLayoutId === null ? c.primary : 'transparent',
            }}
          >
            <Text
              style={{
                fontSize: typography.caption,
                fontWeight: typography.semibold,
                color: selectedLayoutId === null ? c.textOnPrimary : c.textSecondary,
              }}
            >
              {t('weekly.layout.default')}
            </Text>
          </Pressable>
          {layouts.map((layout) => {
            const sel = layout.id === selectedLayoutId;
            return (
              <Pressable
                key={layout.id}
                testID={`weekly-layout-pill-${layout.id}`}
                onPress={() => onPickLayout(layout)}
                accessibilityRole="button"
                accessibilityLabel={layout.name}
                accessibilityState={{ selected: sel }}
                style={{
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.xs,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: sel ? c.primary : c.border,
                  backgroundColor: sel ? c.primary : 'transparent',
                }}
              >
                <Text
                  style={{
                    fontSize: typography.caption,
                    fontWeight: typography.semibold,
                    color: sel ? c.textOnPrimary : c.textSecondary,
                  }}
                  numberOfLines={1}
                >
                  {layout.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {/* Items list */}
      {loading ? (
        <View style={styles.loadingPane}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyPane}>
          <Text style={[styles.emptyText, { color: c.textSecondary }]}>
            {t('weekly.list.empty')}
          </Text>
        </View>
      ) : viewMode === 'custom' ? (
        // Spec 110 — flat Custom view in the PICKED layout's saved order,
        // category headers suppressed (OQ-2). PICK-ONLY: no drag list here
        // (staff cannot reorder — OQ-1). Every row stays mounted inside a
        // ScrollView (UN-WINDOWED, spec 102) so the gate jump (DOM focus →
        // scroll-into-view on web) reaches any row. Search composes with the
        // layout order (AC-10). Rows are byte-identical to default view
        // (renderWeeklyRow).
        <ScrollView
          testID="weekly-item-list"
          style={styles.itemListBody}
          contentContainerStyle={styles.itemList}
        >
          {customVisibleItems.length === 0 ? (
            <View style={styles.emptyPane}>
              <Text style={[styles.emptyText, { color: c.textSecondary }]}>
                {t('weekly.list.noMatch')}
              </Text>
            </View>
          ) : (
            customVisibleItems.map((item) => (
              <View key={item.id} style={{ marginBottom: spacing.sm }}>
                {renderWeeklyRow(item)}
              </View>
            ))
          )}
        </ScrollView>
      ) : (
        <SectionList
          ref={listRef}
          testID="weekly-item-list"
          sections={sections}
          keyExtractor={(i) => i.id}
          // Render the whole list (no windowing) — same posture as the admin
          // inventory count's ScrollView. A virtualized SectionList unmounts
          // far rows, so the "jump to the first uncounted row" redirect can't
          // focus a target below the fold; keeping every row mounted lets the
          // input's DOM focus scroll it into view on web. The full-store count
          // is a deliberate scroll-through-everything screen, so the up-front
          // render cost is acceptable (matches InventoryCountSection).
          //
          // initialNumToRender is in CELLS (rows + section headers + item
          // separators ≈ 3× items), not rows — undersizing it leaves trailing
          // rows unrendered where there's no layout pass to fill them in (e.g.
          // react-test-renderer). windowSize (viewport units) keeps the fully
          // rendered list mounted so a far target stays focusable.
          initialNumToRender={items.length * 3 + 10}
          maxToRenderPerBatch={items.length * 3 + 10}
          windowSize={Math.max(21, items.length)}
          // Variable row heights mean scrollToLocation can miss before the
          // target is measured — retry the stored location, then the focus
          // effect pulls it the rest of the way in (DOM focus on web).
          onScrollToIndexFailed={() => {
            const loc = pendingLocationRef.current;
            if (!loc) return;
            requestAnimationFrame(() => {
              try {
                listRef.current?.scrollToLocation({ ...loc, viewPosition: 0.3, animated: true });
              } catch {
                // give up quietly — the row still focuses once it mounts
              }
            });
          }}
          ListEmptyComponent={
            <View style={styles.emptyPane}>
              <Text style={[styles.emptyText, { color: c.textSecondary }]}>
                {t('weekly.list.noMatch')}
              </Text>
            </View>
          }
          style={styles.itemListBody}
          contentContainerStyle={styles.itemList}
          stickySectionHeadersEnabled={false}
          ItemSeparatorComponent={() => <View style={styles.itemSeparator} />}
          renderSectionHeader={({ section }) => (
            <View
              style={[styles.sectionHeader, { backgroundColor: c.bgAlt }]}
              testID={`weekly-category-header-${section.category || 'uncategorized'}`}
            >
              <Text style={[styles.sectionHeaderTitle, { color: c.textSecondary }]}>
                {section.title}
              </Text>
              <View style={[styles.sectionHeaderRule, { backgroundColor: c.border }]} />
              <Text style={[styles.sectionHeaderCount, { color: c.textTertiary }]}>
                {t('weekly.category.count', { count: section.data.length })}
              </Text>
            </View>
          )}
          renderItem={({ item }) => renderWeeklyRow(item)}
        />
      )}

      {/* Footer — save draft (secondary) + submit (primary) */}
      <View
        style={[
          styles.footer,
          { backgroundColor: c.surface, borderTopColor: c.border },
        ]}
      >
        {/* Spec 106 — Save draft. UNGATED by the count-everything rule (a draft
            may be partial, AC-2); disabled only while a save is in flight or the
            store's items are still loading. Secondary (outlined) variant so it
            reads below the primary Submit. */}
        <View style={styles.saveWrap}>
          <Button
            label={t('weekly.draft.save')}
            onPress={onSaveDraft}
            variant="secondary"
            disabled={savingDraft || loading}
            loading={savingDraft}
            testID="weekly-save-draft"
          />
        </View>
        <View style={styles.submitWrap}>
          <Button
            label={submitting ? t('weekly.submitting') : t('weekly.submit')}
            onPress={onSubmitPress}
            disabled={items.length === 0 || forbidden}
            loading={submitting}
            testID="weekly-submit"
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    gap: 2,
  },
  title: {
    fontSize: typography.title,
    fontWeight: typography.bold,
  },
  subtitle: {
    fontSize: typography.caption,
  },
  // Mirrors EODCount.headerSwitcherRow — left-aligned LocaleSwitcher under the
  // title/subtitle stack. marginTop here because the header's `gap` is a tight
  // 2px (tuned for the title/subtitle lines), too tight to space the switcher.
  headerSwitcherRow: {
    flexDirection: 'row',
    marginTop: spacing.sm,
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
    padding: spacing.xl,
  },
  emptyText: {
    fontSize: typography.body,
    textAlign: 'center',
  },
  itemListBody: {
    flex: 1,
  },
  itemList: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  itemSeparator: {
    height: spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  sectionHeaderTitle: {
    fontSize: typography.caption,
    fontWeight: typography.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionHeaderRule: {
    flex: 1,
    height: 1,
  },
  sectionHeaderCount: {
    fontSize: typography.caption,
    fontWeight: typography.medium,
  },
  // Spec 102 — name + low-stock badge share a row so the badge sits inline
  // with the (possibly 2-line) ingredient name. `flex: 1` on the name lets it
  // wrap while the badge keeps its intrinsic width.
  itemNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  itemName: {
    flexShrink: 1,
    fontSize: typography.bodyLarge,
    fontWeight: typography.semibold,
  },
  lowBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
  },
  lowBadgeText: {
    fontSize: typography.caption,
    fontWeight: typography.bold,
    letterSpacing: 0.5,
  },
  itemUnit: {
    fontSize: typography.caption,
    marginTop: 2,
  },
  itemTotal: {
    fontSize: typography.caption,
    marginTop: 2,
    fontWeight: typography.semibold,
  },
  countInputs: {
    flexDirection: 'row',
    // Tight gap so the columns can be wide enough for "Loose Units"
    // to fit on one line.
    gap: spacing.xs,
    alignItems: 'flex-end',
  },
  countCol: {
    width: 52,
  },
  countColLabel: {
    fontSize: typography.caption,
    marginBottom: spacing.xs,
    textAlign: 'center',
    fontWeight: typography.medium,
  },
  countInput: {
    width: 52,
    textAlign: 'center',
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  // Spec 106 — the Save-draft row sits above the Submit; both full-width.
  saveWrap: {
    width: '100%',
  },
  submitWrap: {
    width: '100%',
  },
});

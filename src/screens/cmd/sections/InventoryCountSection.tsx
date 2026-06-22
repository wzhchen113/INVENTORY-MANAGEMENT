import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useIsPhone } from '../../../theme/breakpoints';
import { useStore } from '../../../store/useStore';
import { fetchRecentInventoryCounts, fetchInventoryCount } from '../../../lib/db';
import { supabase } from '../../../lib/supabase';
import { TabStrip } from '../../../components/cmd/TabStrip';
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
  const [submitting, setSubmitting] = React.useState(false);

  // Recent counts — fetched on mount + on a realtime nudge. `tick` is the
  // counter we bump from the realtime subscription to force a refetch.
  const [recent, setRecent] = React.useState<InventoryCountSummary[]>([]);
  const [recentLoading, setRecentLoading] = React.useState(false);
  const [refreshTick, setRefreshTick] = React.useState(0);
  const [detail, setDetail] = React.useState<InventoryCount | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);

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
    const base = selectedCategory === 'all'
      ? storeInventory
      : storeInventory.filter((i) => i.category === selectedCategory);
    return base.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [storeInventory, selectedCategory]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, typeof filteredItems>();
    for (const it of filteredItems) {
      const arr = map.get(it.category) || [];
      arr.push(it);
      map.set(it.category, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredItems]);

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

  // ─── Lazy-fetch detail when a row is clicked ───────────────────────
  React.useEffect(() => {
    if (view !== 'detail' || !selectedCountId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetchInventoryCount(selectedCountId)
      .then((row) => {
        if (!cancelled) setDetail(row);
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
      // Bump tick so the recent-counts list refreshes immediately even
      // before the realtime nudge arrives.
      setRefreshTick((t) => t + 1);
    } finally {
      setSubmitting(false);
    }
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
            Select a store to count inventory.
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
              <TouchableOpacity
                onPress={onSubmit}
                disabled={submitting || nonBlankCount === 0 || hasNegative}
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
              <Text style={[Type.h2, { color: C.fg }]}>Inventory count</Text>
              <Text style={{ fontFamily: sans(400), fontSize: 12.5, color: C.fg2, marginTop: 2 }}>
                Advisory snapshot — this count does NOT affect live stock until the next EOD.
              </Text>
            </View>
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
            {/* Category chips — same idea as EOD's chip row, but no vendor
                filter (counts cover every item by default per Q6). */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {categories.map((c) => {
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
              })}
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
                box/case
              </Text>
              <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: cellW, textAlign: 'center' }]}>
                count
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
            {grouped.length === 0 ? (
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
                  {items.map((it, i) => {
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
                          borderTopWidth: i === 0 ? 0 : 1,
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
                  })}
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
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: CmdRadius.xs,
                        backgroundColor: C.accentBg,
                        borderWidth: 1,
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
  onBack,
}: {
  countId: string;
  detail: InventoryCount | null;
  loading: boolean;
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
                    each
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
                {detail.entries.map((e, i) => (
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
                    <Text
                      style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }}
                      numberOfLines={1}
                    >
                      {e.itemName || '(unknown item)'}
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
                    <Text
                      style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, flex: 1.2 }}
                      numberOfLines={1}
                    >
                      {e.notes || ''}
                    </Text>
                  </View>
                ))}
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
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: CmdRadius.xs,
                      backgroundColor: tone.bg,
                      borderWidth: 1,
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

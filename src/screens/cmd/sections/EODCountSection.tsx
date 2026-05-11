import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, TextInput, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useIsPhone } from '../../../theme/breakpoints';
import { useStore } from '../../../store/useStore';
import { submitEODCount } from '../../../lib/db';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { usePaletteAction } from '../../../lib/paletteAction';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { StatusDot } from '../../../components/cmd/StatusDot';
import { StatCard } from '../../../components/cmd/StatCard';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { ComingSoonPanel } from '../../../components/cmd/ComingSoonPanel';
import { AddCountModal } from '../../../components/cmd/AddCountModal';
import { AddVendorScheduleModal } from '../../../components/cmd/AddVendorScheduleModal';
import { EODEntry } from '../../../types';

type DayStatus = 'today' | 'submitted' | 'draft' | 'late' | 'rest';

interface DayCell {
  day: string;       // "Saturday"
  date: string;      // "May 2"
  iso: string;       // "2026-05-02"
  status: DayStatus;
  counted: number;
  total: number;
  vendors: string;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
// - No search bar inside the worksheet (the global ⌘K palette covers it)
// - SAVE DRAFT button currently just toasts (draft persistence is out
//   of scope for Phase 10b — submitEOD itself supports draft status if
//   needed later)
// - No per-row variance pill (kept simple; we surface a footer-level total)
export default function EODCountSection() {
  const C = useCmdColors();
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
  // Backend-developer adds these store actions in spec 007's backend slice.
  // Same optimistic-then-revert pattern as setOrderSchedule.
  const addOrderScheduleEntry = useStore((s) => s.addOrderScheduleEntry);
  const removeOrderScheduleEntry = useStore((s) => s.removeOrderScheduleEntry);

  const [selectedIso, setSelectedIso] = React.useState<string>(() => localDayIso(new Date()));
  const [selectedVendorId, setSelectedVendorId] = React.useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = React.useState<string | 'all'>('all');
  const [caseCounts, setCaseCounts] = React.useState<Record<string, string>>({});
  const [unitCounts, setUnitCounts] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);
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
      const sub = eodSubmissions.find((s) => s.storeId === currentStore.id && s.date === iso);
      const counted = sub?.entries?.length ?? 0;
      const total = inventory.filter((it) => it.storeId === currentStore.id).length;
      let status: DayStatus = 'rest';
      if (iso === todayIso) {
        status = sub?.status === 'draft' ? 'draft' : 'today';
      } else if (sub) {
        status = sub.status === 'draft' ? 'draft' : (counted >= total ? 'submitted' : 'late');
      }
      out.push({ day: dayName, date: monthDay, iso, status, counted, total, vendors: 'all vendors' });
    }
    return out;
  }, [eodSubmissions, currentStore.id, inventory]);

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
    const counts = new Map<string, number>();
    for (const i of storeInventory) {
      if (i.vendorId) counts.set(i.vendorId, (counts.get(i.vendorId) || 0) + 1);
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
    return storeInventory.filter((i) => i.vendorId === selectedVendorId);
  }, [storeInventory, selectedVendorId]);

  // Category chips — derived from this vendor's items
  const categories = React.useMemo(() => {
    const cats = new Map<string, number>();
    for (const i of vendorItems) cats.set(i.category, (cats.get(i.category) || 0) + 1);
    return [
      { id: 'all', label: `All (${vendorItems.length})` },
      ...Array.from(cats.entries()).map(([cat, n]) => ({ id: cat, label: `${cat} (${n})` })),
    ];
  }, [vendorItems]);

  const filteredItems = React.useMemo(() => {
    const base = selectedCategory === 'all' ? vendorItems : vendorItems.filter((i) => i.category === selectedCategory);
    if (additionalItems.size === 0) return base;
    const baseIds = new Set(base.map((i) => i.id));
    const extras = storeInventory.filter((i) => additionalItems.has(i.id) && !baseIds.has(i.id));
    return [...base, ...extras];
  }, [vendorItems, selectedCategory, additionalItems, storeInventory]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, typeof filteredItems>();
    for (const it of filteredItems) {
      const arr = map.get(it.category) || [];
      arr.push(it);
      map.set(it.category, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredItems]);

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
  const hasEntry = (id: string) =>
    (caseCounts[id] ?? '').trim() !== '' || (unitCounts[id] ?? '').trim() !== '';
  const countedNum = filteredItems.filter((i) => hasEntry(i.id)).length;
  const total = filteredItems.length;
  const estValue = filteredItems.reduce((s, i) => {
    if (!hasEntry(i.id)) return s;
    return s + itemTotal(i) * i.costPerUnit;
  }, 0);
  const variance = filteredItems.reduce((s, i) => {
    if (!hasEntry(i.id)) return s;
    return s + (itemTotal(i) - i.currentStock);
  }, 0);

  // Build the submission payload from current entered items. Returns null if
  // no qty was entered (avoids empty-submit DB writes).
  const buildSubmission = (status: 'draft' | 'submitted') => {
    const enteredItems = filteredItems.filter((i) => hasEntry(i.id));
    if (enteredItems.length === 0) return null;
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
    return {
      date: selectedIso,
      storeId: currentStore.id,
      storeName: currentStore.name,
      submittedBy: currentUser?.name || 'unknown',
      submittedByUserId: currentUser?.id || '',
      timestamp: now,
      itemCount: entries.length,
      status,
      entries: entries as EODEntry[],
    };
  };

  const onSaveDraft = async () => {
    const submission = buildSubmission('draft');
    if (!submission) {
      Toast.show({ type: 'error', text1: 'Enter at least one count' });
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
        text1: 'DRAFT SAVED',
        text2: `${submission.itemCount} of ${filteredItems.length} items · ${time} · ${submitterShort}`,
      });
    } catch (e: any) {
      console.warn('[EOD] draft save failed:', e?.message || e);
      Toast.show({ type: 'error', text1: 'Saved locally only', text2: 'Cloud save failed — check connection' });
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = async () => {
    const submission = buildSubmission('submitted');
    if (!submission) {
      Toast.show({ type: 'error', text1: 'Enter at least one count' });
      return;
    }
    setSubmitting(true);
    submitEOD(submission);
    setCaseCounts({});
    setUnitCounts({});
    setNotes({});
    try {
      await submitEODCount(submission);
      Toast.show({ type: 'success', text1: 'Count submitted', text2: `${submission.itemCount} items · ${selectedIso}` });
    } catch (e: any) {
      console.warn('[EOD] cloud save failed:', e?.message || e);
      Toast.show({ type: 'error', text1: 'Saved locally only', text2: 'Cloud save failed — check connection' });
    } finally {
      setSubmitting(false);
    }
  };

  const wkNum = (() => {
    const d = new Date();
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + yearStart.getDay() + 1) / 7);
  })();

  const dayPillFor = (status: DayStatus): { fg: string; bg: string; label: string } => {
    if (status === 'today')     return { fg: C.accent, bg: C.accentBg, label: 'today' };
    if (status === 'submitted') return { fg: C.ok,     bg: C.okBg,     label: 'submitted' };
    if (status === 'draft')     return { fg: C.info,   bg: C.infoBg,   label: 'draft' };
    if (status === 'late')      return { fg: C.warn,   bg: C.warnBg,   label: 'late' };
    return { fg: C.fg3, bg: C.panel2, label: 'rest' };
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
          Select a store to count inventory.
        </Text>
      </View>
    );
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
            <Text style={[Type.h2, { color: C.fg }]}>This week</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>wk {wkNum}</Text>
          </View>
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            {(currentStore.name || 'store').toLowerCase()}
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
                    {d.day}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, fontVariant: ['tabular-nums'] }}>
                    {d.date}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 15 }}>
                  <View style={{ paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 3, backgroundColor: pill.bg }}>
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
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>week total</Text>
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
                        {d.day.slice(0, 3)}
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
            { id: 'count.tsx',    label: 'count.tsx' },
            { id: 'history.tsx',  label: 'history.tsx' },
            { id: 'variance.log', label: 'variance.log' },
          ]}
          activeId={tabId}
          onChange={setTabId}
          rightSlot={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                {new Date().toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' })}
              </Text>
              <View style={{ width: 1, height: 16, backgroundColor: C.border }} />
              {isRestDay ? (
                // REST DAY pill — Q7=(a) with read-only enforcement. Echoes
                // the per-day-cell pill in the week sidebar so the user sees
                // a matching signal at the worksheet head.
                <View style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: CmdRadius.xs, backgroundColor: C.warnBg, borderWidth: 1, borderColor: C.warn }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.warn, letterSpacing: 0.5 }}>
                    REST DAY — NO INPUT
                  </Text>
                </View>
              ) : null}
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
                <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>+ COUNT</Text>
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
                <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>SAVE DRAFT</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onSubmit}
                disabled={submitting || isRestDay}
                style={{
                  paddingVertical: 4, paddingHorizontal: 10,
                  backgroundColor: C.accent, borderRadius: CmdRadius.sm,
                  opacity: (submitting || isRestDay) ? (isRestDay ? 0.4 : 0.6) : 1,
                  ...(Platform.OS === 'web' && isRestDay ? ({ pointerEvents: 'none' } as any) : {}),
                }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>SUBMIT COUNT</Text>
              </TouchableOpacity>
            </View>
          }
        />

        {tabId === 'history.tsx' ? (
          <EODHistoryTab />
        ) : tabId === 'variance.log' ? (
          <VarianceLogTab />
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
              return (
                <View
                  key={v.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderRadius: CmdRadius.md,
                    borderWidth: 1,
                    borderColor: sel ? C.fg : C.border,
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
                    <Text style={{ fontFamily: mono(sel ? 700 : 500), fontSize: 11, color: sel ? C.bg : C.fg2 }}>
                      {v.name.toUpperCase()} ({v.count})
                    </Text>
                    {!isPhone && v.orderCutoffTime ? (
                      <Text style={{ fontFamily: mono(400), fontSize: 10, color: sel ? C.bg : C.fg3, opacity: 0.7 }}>
                        · cutoff {v.orderCutoffTime}
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
                      accessibilityLabel={`Remove ${v.name} from ${selectedDayName} schedule`}
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
                  ? `no vendors scheduled for ${selectedDayName.toLowerCase()}`
                  : 'no vendors with items at this store'}
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
              accessibilityLabel={`Add a vendor to ${selectedDayName} schedule`}
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
              <Text style={{ fontFamily: mono(600), fontSize: 11, color: C.fg2 }}>+ vendor</Text>
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
                  show unscheduled vendors
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
              {countedNum} of {total} items counted
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg2 }}>
              vendor: {vendorTabs.find((v) => v.id === selectedVendorId)?.name?.toUpperCase() || '—'}
            </Text>
            {!isPhone && <View style={{ flex: 1 }} />}
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              counter: <Text style={{ color: C.fg }}>{currentUser?.name?.toLowerCase().replace(/\s+/g, '.') || 'guest'}</Text>
            </Text>
          </View>
        </View>

        {/* Item list */}
        <ScrollView contentContainerStyle={{ paddingHorizontal: rowPadH, paddingTop: 8, paddingBottom: 80 }}>
          {/* Column header */}
          <View style={{ flexDirection: 'row', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, borderStyle: 'dashed', gap: rowGap }}>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, flex: isPhone ? 2 : 1 }]}>item · pack</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: cellW, textAlign: 'center' }]}>box/case</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: cellW, textAlign: 'center' }]}>count</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, ...(isPhone ? { flex: 1, minWidth: 0 } : { width: 180 }) }]}>note</Text>
          </View>
          {grouped.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 32, textAlign: 'center' }}>
              no items in this filter
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
                          {it.unit}{hasCase ? ` · case ${it.caseQty}` : ''}{it.parLevel > 0 ? ` · par ${it.parLevel}` : ''}
                          {hasCase && (cFocused || uFocused) ? ` · total ${total} ${it.unit}` : ''}
                        </Text>
                      </View>
                      {/* BOX/CASE input — disabled when item has no case info, or
                          on REST days. Both cases collapse to "show the cell
                          but don't accept input"; rest gets a 0.5 opacity
                          consistent with the no-case-info treatment. */}
                      <View style={{ width: cellW, alignItems: 'center' }}>
                        <TextInput
                          ref={(r) => {
                            if (hasCase) caseInputRefs.current[it.id] = r;
                          }}
                          value={hasCase ? cVal : ''}
                          editable={hasCase && !isRestDay}
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
                            borderColor: cFocused ? C.accent : C.border,
                            borderRadius: CmdRadius.sm,
                            opacity: !hasCase || isRestDay ? 0.5 : 1,
                            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                          }}
                        />
                        <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, marginTop: 3 }}>
                          {hasCase ? `× ${it.caseQty}` : '—'}
                        </Text>
                      </View>
                      {/* Loose units input */}
                      <View style={{ width: cellW, alignItems: 'center' }}>
                        <TextInput
                          ref={(r) => {
                            if (!hasCase) caseInputRefs.current[it.id] = r;
                          }}
                          value={uVal}
                          editable={!isRestDay}
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
                            borderColor: uFocused ? C.accent : C.border,
                            borderRadius: CmdRadius.sm,
                            opacity: isRestDay ? 0.5 : 1,
                            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                          }}
                        />
                        <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, marginTop: 3 }}>
                          {it.unit}
                        </Text>
                      </View>
                      <TextInput
                        value={notes[it.id] || ''}
                        editable={!isRestDay}
                        onChangeText={(text) => setNotes((p) => ({ ...p, [it.id]: text }))}
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
                          opacity: isRestDay ? 0.5 : 1,
                          ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                        }}
                      />
                    </View>
                  );
                })}
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
            {countedNum}/{total} counted
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>
            est. value <Text style={{ color: C.fg, fontWeight: '600' }}>${estValue.toFixed(2)}</Text>
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>
            variance <Text style={{ color: variance < 0 ? C.warn : C.fg }}>{countedNum > 0 ? `${variance >= 0 ? '+' : ''}${variance.toFixed(1)}` : '—'}</Text>
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            tab moves cell · ⏎ next item
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
function EODHistoryTab() {
  const C = useCmdColors();
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const currentStore = useStore((s) => s.currentStore);

  const ninetyDaysAgo = React.useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return localDayIso(d);
  }, []);

  const submissions = React.useMemo(
    () =>
      eodSubmissions
        .filter((s) => s.storeId === currentStore.id && s.date >= ninetyDaysAgo)
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    [eodSubmissions, currentStore.id, ninetyDaysAgo],
  );

  const onTimeCount = submissions.filter((s) => s.status === 'submitted').length;
  const onTimePct = submissions.length === 0 ? 100 : Math.round((onTimeCount * 100) / submissions.length);

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>EOD count · history</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          90-day rolling history. Click a row to view the frozen snapshot read-only.
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label="Submissions" value={String(submissions.length)} sub="last 90 days" />
        <StatCard label="On-time %" value={`${onTimePct}%`} sub="vs deadline" />
        <StatCard label="Items / count" value={submissions.length === 0 ? '—' : String(Math.round(submissions.reduce((s, c) => s + (c.itemCount || c.entries?.length || 0), 0) / submissions.length))} sub="avg" />
        <StatCard label="Last submitted" value={submissions[0] ? submissions[0].date.slice(5) : '—'} sub={submissions[0] ? new Date(submissions[0].timestamp).toTimeString().slice(0, 5) : '—'} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>history.tsv</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{submissions.length} {submissions.length === 1 ? 'count' : 'counts'}</Text>
        </View>
        {submissions.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            no submitted counts in the last 90 days
          </Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 100 }}>date</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70 }}>time</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>submitted by</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>items</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>status</Text>
            </View>
            {submissions.map((sub, i) => {
              const tone = sub.status === 'draft' ? 'warn' : 'ok';
              return (
                <View key={sub.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border }}>
                  <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 100 }}>{sub.date}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 70 }}>
                    {new Date(sub.timestamp).toTimeString().slice(0, 5)}
                  </Text>
                  <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg2, flex: 1 }} numberOfLines={1}>{sub.submittedBy || '—'}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right' }}>{sub.itemCount || sub.entries?.length || 0}</Text>
                  <View style={{ width: 90, alignItems: 'flex-end' }}>
                    <View style={{ borderWidth: 1, borderColor: tone === 'warn' ? C.warn : C.ok, borderRadius: CmdRadius.xs, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: tone === 'warn' ? C.warnBg : C.okBg }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: tone === 'warn' ? C.warn : C.ok, letterSpacing: 0.4 }}>
                        {sub.status === 'draft' ? 'DRAFT' : 'SUBMITTED'}
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
function VarianceLogTab() {
  const C = useCmdColors();
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const todayStr = localDayIso(new Date());
  const todaySub = React.useMemo(
    () => eodSubmissions.find((s) => s.storeId === currentStore.id && s.date === todayStr),
    [eodSubmissions, currentStore.id, todayStr],
  );

  const variances = React.useMemo(() => {
    if (!todaySub?.entries) return [];
    return todaySub.entries
      .map((entry) => {
        const item = inventory.find((i) => i.id === entry.itemId);
        if (!item) return null;
        const expected = item.parLevel || 0; // par as proxy when no expected stock signal
        const counted = entry.actualRemaining;
        const delta = counted - expected;
        const cost = item.costPerUnit || 0;
        const deltaCost = delta * cost;
        let tag: 'SHRINK' | 'MINOR' | 'OK' | 'FAVORABLE';
        if (deltaCost <= -25) tag = 'SHRINK';
        else if (Math.abs(delta) >= expected * 0.05 && expected > 0) tag = 'MINOR';
        else if (delta > 0) tag = 'FAVORABLE';
        else tag = 'OK';
        return { itemName: item.name, unit: item.unit, expected, counted, delta, deltaCost, tag };
      })
      .filter(Boolean) as Array<{ itemName: string; unit: string; expected: number; counted: number; delta: number; deltaCost: number; tag: 'SHRINK' | 'MINOR' | 'OK' | 'FAVORABLE' }>;
  }, [todaySub, inventory]);

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
        <Text style={[Type.h1, { color: C.fg }]}>variance · live</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Counted vs expected per item. Posts to reconciliation at day-close.
          Rules: SHRINK ≥ $25 · MINOR ≥ 5% · FAVORABLE +Δ · OK.
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label="Items counted" value={String(sorted.length)} sub={todaySub ? `today's count` : 'no count submitted'} />
        <StatCard label="Net Δ$" value={`${sumDelta >= 0 ? '+' : '−'}$${Math.abs(sumDelta).toFixed(0)}`} sub="vs par × cost" />
        <StatCard label="SHRINK" value={String(shrinkCount)} sub="≥ $25 loss" />
        <StatCard label="MINOR" value={String(minorCount)} sub="≥ 5% off" />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>variance.log</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>sorted by |Δ$|</Text>
        </View>
        {sorted.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            no count submitted today — submit a count to see variance
          </Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1.4 }}>item</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>expected</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>counted</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>Δ</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>Δ$</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>tag</Text>
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
                    <View style={{ borderWidth: 1, borderColor: tone, borderRadius: CmdRadius.xs, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: bg }}>
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

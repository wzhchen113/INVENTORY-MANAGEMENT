import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, TextInput, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { submitEODCount } from '../../../lib/db';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { StatusDot } from '../../../components/cmd/StatusDot';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { ComingSoonPanel } from '../../../components/cmd/ComingSoonPanel';
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
  const inventory = useStore((s) => s.inventory);
  const vendors = useStore((s) => s.vendors);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const submitEOD = useStore((s) => s.submitEOD);

  const [selectedIso, setSelectedIso] = React.useState<string>(() => new Date().toISOString().slice(0, 10));
  const [selectedVendorId, setSelectedVendorId] = React.useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = React.useState<string | 'all'>('all');
  const [counts, setCounts] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [tabId, setTabId] = React.useState('count.tsx');

  // ── Week sidebar data ───────────────────────────────────────
  const week: DayCell[] = React.useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString().slice(0, 10);
    const out: DayCell[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
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

  // Vendor tabs — only vendors that have items at this store
  const vendorTabs = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of storeInventory) {
      if (i.vendorId) counts.set(i.vendorId, (counts.get(i.vendorId) || 0) + 1);
    }
    return vendors
      .filter((v) => counts.has(v.id))
      .map((v) => ({ ...v, count: counts.get(v.id) || 0 }));
  }, [storeInventory, vendors]);

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

  const filteredItems = React.useMemo(
    () => (selectedCategory === 'all' ? vendorItems : vendorItems.filter((i) => i.category === selectedCategory)),
    [vendorItems, selectedCategory],
  );

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
  const countedNum = filteredItems.filter((i) => (counts[i.id] ?? '').trim() !== '').length;
  const total = filteredItems.length;
  const estValue = filteredItems.reduce((s, i) => {
    const v = parseFloat(counts[i.id] || '');
    if (isNaN(v)) return s;
    return s + v * i.costPerUnit;
  }, 0);
  const variance = filteredItems.reduce((s, i) => {
    const v = parseFloat(counts[i.id] || '');
    if (isNaN(v)) return s;
    return s + (v - i.currentStock);
  }, 0);

  // Build the submission payload from current entered items. Returns null if
  // no qty was entered (avoids empty-submit DB writes).
  const buildSubmission = (status: 'draft' | 'submitted') => {
    const enteredItems = filteredItems.filter((i) => (counts[i.id] ?? '').trim() !== '');
    if (enteredItems.length === 0) return null;
    const now = new Date().toISOString();
    const entries: Omit<EODEntry, 'id'>[] = enteredItems.map((i) => ({
      itemId: i.id,
      itemName: i.name,
      actualRemaining: parseFloat(counts[i.id]) || 0,
      unit: i.unit,
      submittedBy: currentUser?.name || 'unknown',
      submittedByUserId: currentUser?.id || '',
      timestamp: now,
      date: selectedIso,
      storeId: currentStore.id,
      notes: notes[i.id] || '',
    }));
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
    setCounts({});
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

  return (
    <>
      {/* Week sidebar */}
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

      {/* Worksheet */}
      <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
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
              <TouchableOpacity onPress={onSaveDraft} disabled={submitting} style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm, opacity: submitting ? 0.6 : 1 }}>
                <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>SAVE DRAFT</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onSubmit} disabled={submitting} style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm, opacity: submitting ? 0.6 : 1 }}>
                <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>SUBMIT COUNT</Text>
              </TouchableOpacity>
            </View>
          }
        />

        {tabId !== 'count.tsx' ? (
          <View style={{ flex: 1, padding: 22 }}>
            <ComingSoonPanel tabName={tabId.replace('.tsx', '').replace('.log', '')} />
          </View>
        ) : (<>
        {/* Sticky filter chrome */}
        <View style={{ backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 10, gap: 10 }}>
          {/* Vendor tabs */}
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {vendorTabs.map((v) => {
              const sel = v.id === selectedVendorId;
              return (
                <TouchableOpacity
                  key={v.id}
                  onPress={() => { setSelectedVendorId(v.id); setSelectedCategory('all'); }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: CmdRadius.md,
                    borderWidth: 1,
                    borderColor: sel ? C.fg : C.border,
                    backgroundColor: sel ? C.fg : C.panel,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <Text style={{ fontFamily: mono(sel ? 700 : 500), fontSize: 11, color: sel ? C.bg : C.fg2 }}>
                    {v.name.toUpperCase()} ({v.count})
                  </Text>
                  {v.orderCutoffTime ? (
                    <Text style={{ fontFamily: mono(400), fontSize: 10, color: sel ? C.bg : C.fg3, opacity: 0.7 }}>
                      · cutoff {v.orderCutoffTime}
                    </Text>
                  ) : null}
                </TouchableOpacity>
              );
            })}
            {vendorTabs.length === 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                no vendors with items at this store
              </Text>
            ) : null}
          </View>
          {/* Category chips */}
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
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
          {/* Status line */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <StatusDot status={countedNum === total ? 'ok' : countedNum > 0 ? 'low' : 'info'} />
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              {countedNum} of {total} items counted
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg2 }}>
              vendor: {vendorTabs.find((v) => v.id === selectedVendorId)?.name?.toUpperCase() || '—'}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              counter: <Text style={{ color: C.fg }}>{currentUser?.name?.toLowerCase().replace(/\s+/g, '.') || 'guest'}</Text>
            </Text>
          </View>
        </View>

        {/* Item list */}
        <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingTop: 8, paddingBottom: 80 }}>
          {/* Column header */}
          <View style={{ flexDirection: 'row', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, borderStyle: 'dashed', gap: 14 }}>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, flex: 1 }]}>item · pack</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 90, textAlign: 'center' }]}>count</Text>
            <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 220 }]}>note</Text>
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
                  const v = counts[it.id] || '';
                  const focused = (counts[it.id] ?? '').trim() !== '';
                  return (
                    <View
                      key={it.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 10,
                        gap: 14,
                        borderTopWidth: i === 0 ? 0 : 1,
                        borderTopColor: C.border,
                        borderStyle: 'dashed',
                      }}
                    >
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg, letterSpacing: -0.1 }}>
                          {it.name}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, marginTop: 2 }}>
                          {it.unit}{it.parLevel > 0 ? ` · par ${it.parLevel}` : ''}
                          {it.currentStock > 0 ? ` · expected ${it.currentStock} ${it.unit}` : ''}
                        </Text>
                      </View>
                      <View style={{ width: 90, alignItems: 'center' }}>
                        <TextInput
                          value={v}
                          onChangeText={(text) => setCounts((p) => ({ ...p, [it.id]: text }))}
                          placeholder="0"
                          placeholderTextColor={C.fg3}
                          keyboardType="numeric"
                          style={{
                            width: 70,
                            height: 30,
                            textAlign: 'center',
                            fontFamily: mono(600),
                            fontSize: 13,
                            color: focused ? C.fg : C.fg2,
                            backgroundColor: focused ? C.panel2 : C.panel,
                            borderWidth: 1,
                            borderColor: focused ? C.accent : C.border,
                            borderRadius: CmdRadius.sm,
                            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                          }}
                        />
                        <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, marginTop: 3 }}>
                          {it.unit}
                        </Text>
                      </View>
                      <TextInput
                        value={notes[it.id] || ''}
                        onChangeText={(text) => setNotes((p) => ({ ...p, [it.id]: text }))}
                        placeholder="Note…"
                        placeholderTextColor={C.fg3}
                        style={{
                          width: 220,
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
        </ScrollView>

        {/* Sticky footer summary */}
        <View
          style={{
            backgroundColor: C.panel,
            borderTopWidth: 1,
            borderTopColor: C.border,
            paddingHorizontal: 22,
            paddingVertical: 10,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
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
    </>
  );
}

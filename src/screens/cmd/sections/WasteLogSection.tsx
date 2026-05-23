import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, TextInput, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { Avatar } from '../../../components/cmd/Avatar';
import { ListSkeleton } from '../../../components/cmd/ListSkeleton';
import { relativeTime } from '../../../utils/relativeTime';
import { WasteReason } from '../../../types';
import { useT } from '../../../hooks/useT';
import { wasteReasonLabel, wasteReasonShortLabel } from '../../../utils/enumLabels';

const REASONS: WasteReason[] = ['Expired', 'Dropped/spilled', 'Over-prepped', 'Quality issue', 'Theft', 'Other'];

const inferInitials = (name: string): string =>
  name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

// Pattern A — workflow: list pane (recent waste events with filter chips)
// + form pane (item picker + qty + reason chips + note + submit). Wires to
// the existing `logWaste` store action; matches the live data model.
export default function WasteLogSection() {
  const C = useCmdColors();
  const T = useT();
  const wasteLog = useStore((s) => s.wasteLog);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const logWaste = useStore((s) => s.logWaste);
  // Spec 055 — first-mount skeleton flag.
  const storeLoading = useStore((s) => s.storeLoading);

  const [tabId, setTabId] = React.useState('log.tsx');
  const [reasonFilter, setReasonFilter] = React.useState<WasteReason | 'all'>('all');
  const [pickItemId, setPickItemId] = React.useState<string | null>(null);
  const [qty, setQty] = React.useState('');
  const [reason, setReason] = React.useState<WasteReason>('Expired');
  const [note, setNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const storeWaste = React.useMemo(
    () => wasteLog.filter((w) => w.storeId === currentStore.id),
    [wasteLog, currentStore.id],
  );
  const filteredWaste = React.useMemo(
    () => (reasonFilter === 'all' ? storeWaste : storeWaste.filter((w) => w.reason === reasonFilter)),
    [storeWaste, reasonFilter],
  );

  const storeInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );

  // Default-pick the first inventory item once data loads
  React.useEffect(() => {
    if (pickItemId && storeInventory.find((i) => i.id === pickItemId)) return;
    setPickItemId(storeInventory[0]?.id || null);
  }, [storeInventory, pickItemId]);

  const pickedItem = storeInventory.find((i) => i.id === pickItemId);

  const totalWeekCost = React.useMemo(() => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    return storeWaste
      .filter((w) => new Date(w.timestamp).getTime() >= sevenDaysAgo)
      .reduce((sum, w) => sum + w.quantity * w.costPerUnit, 0);
  }, [storeWaste]);

  const reasonCounts = React.useMemo(() => {
    const out: Record<string, number> = { all: storeWaste.length };
    for (const r of REASONS) {
      out[r] = storeWaste.filter((w) => w.reason === r).length;
    }
    return out;
  }, [storeWaste]);

  const qtyNum = parseFloat(qty) || 0;
  const previewCost = pickedItem ? qtyNum * pickedItem.costPerUnit : 0;
  const onHandPct =
    pickedItem && pickedItem.currentStock > 0 ? Math.round((qtyNum / pickedItem.currentStock) * 100) : 0;

  const submit = () => {
    if (!pickedItem || qtyNum <= 0) {
      Toast.show({ type: 'error', text1: 'Pick item + qty first' });
      return;
    }
    setSubmitting(true);
    logWaste({
      itemId: pickedItem.id,
      itemName: pickedItem.name,
      quantity: qtyNum,
      unit: pickedItem.unit,
      costPerUnit: pickedItem.costPerUnit,
      reason,
      loggedBy: currentUser?.name || 'unknown',
      loggedByUserId: currentUser?.id || '',
      timestamp: new Date().toISOString(),
      notes: note.trim(),
      storeId: currentStore.id,
    });
    Toast.show({ type: 'success', text1: 'Waste logged', text2: `${qtyNum} ${pickedItem.unit} ${pickedItem.name}` });
    setQty('');
    setNote('');
    setSubmitting(false);
  };

  // Spec 055 first-mount skeleton — wasteLog slice loads as part of the
  // store's loadFromSupabase fan-out; check the global flag + slice
  // emptiness so background refreshes don't re-show the skeleton.
  if (storeLoading && wasteLog.length === 0) {
    return <ListSkeleton rows={6} />;
  }

  return (
    <>
      {/* List pane */}
      <View
        style={{
          width: 340,
          backgroundColor: C.panel,
          borderRightWidth: 1,
          borderRightColor: C.border,
        }}
      >
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 14,
            paddingBottom: 10,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <Text style={[Type.h2, { color: C.fg }]}>Waste log</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              ${totalWeekCost.toFixed(0)} wk
            </Text>
          </View>
          <FlatList
            data={['all', ...REASONS] as Array<'all' | WasteReason>}
            keyExtractor={(r) => r}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6 }}
            renderItem={({ item: r }) => {
              const sel = reasonFilter === r;
              const label = r === 'all' ? 'all' : wasteReasonShortLabel(r, T);
              const count = reasonCounts[r] ?? 0;
              return (
                <TouchableOpacity
                  onPress={() => setReasonFilter(r)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                    paddingHorizontal: 9,
                    paddingVertical: 4,
                    borderRadius: CmdRadius.md,
                    borderWidth: 1,
                    borderColor: sel ? C.accent : C.border,
                    backgroundColor: sel ? C.accentBg : C.panel2,
                  }}
                >
                  <Text style={{ fontFamily: mono(600), fontSize: 10.5, color: sel ? C.accent : C.fg2 }}>
                    {label}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: sel ? C.accent : C.fg3 }}>
                    {count}
                  </Text>
                </TouchableOpacity>
              );
            }}
          />
        </View>
        <FlatList
          data={filteredWaste}
          keyExtractor={(w) => w.id}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 24, textAlign: 'center' }}>
              no waste recorded
            </Text>
          }
          renderItem={({ item: w }) => (
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: C.border,
                gap: 4,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, width: 32 }}>
                  {relativeTime(w.timestamp)}
                </Text>
                <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                  {w.itemName}
                </Text>
                <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.warn, fontVariant: ['tabular-nums'] }}>
                  −${(w.quantity * w.costPerUnit).toFixed(2)}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 40 }}>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg2 }}>
                  {w.quantity} {w.unit}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                  · {wasteReasonShortLabel(w.reason, T) || w.reason.toLowerCase()}
                </Text>
                <View style={{ flex: 1 }} />
                <Avatar initials={inferInitials(w.loggedBy)} />
              </View>
            </View>
          )}
        />
      </View>

      {/* Form pane */}
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <TabStrip
          tabs={[
            { id: 'log.tsx',    label: 'log.tsx' },
            { id: 'recent.tsx', label: 'recent.tsx' },
            { id: 'report.tsx', label: 'report.tsx' },
          ]}
          activeId={tabId}
          onChange={setTabId}
          rightSlot={
            <TouchableOpacity
              onPress={submit}
              disabled={submitting}
              style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm, opacity: submitting ? 0.6 : 1 }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>+ LOG WASTE</Text>
            </TouchableOpacity>
          }
        />
        <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
          {tabId === 'log.tsx' ? (
            <>
              <View>
                <Text style={[Type.h1, { color: C.fg }]}>{T('section.wasteLog.addEntry')}</Text>
                <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                  Records cost & reduces on-hand stock. Required nightly per BOH SOP.
                </Text>
              </View>

              {/* Item + qty side-by-side */}
              <View style={{ flexDirection: 'row', gap: 14 }}>
                {/* Item picker — simple list-based picker */}
                <View
                  style={{
                    flex: 1,
                    backgroundColor: C.panel,
                    borderRadius: CmdRadius.lg,
                    borderWidth: 1,
                    borderColor: C.border,
                    padding: 14,
                    gap: 8,
                  }}
                >
                  <SectionCaption tone="fg3">item</SectionCaption>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      paddingVertical: 8,
                      paddingHorizontal: 10,
                      backgroundColor: C.panel2,
                      borderRadius: CmdRadius.md,
                      borderWidth: 1,
                      borderColor: C.borderStrong,
                    }}
                  >
                    {pickedItem ? (
                      <>
                        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                          {pickedItem.id.slice(0, 6)}
                        </Text>
                        <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                          {pickedItem.name}
                        </Text>
                      </>
                    ) : (
                      <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
                        no items in store
                      </Text>
                    )}
                  </View>
                  {pickedItem ? (
                    <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                      on-hand {pickedItem.currentStock} {pickedItem.unit} · cost ${pickedItem.costPerUnit.toFixed(2)}/{pickedItem.unit}
                    </Text>
                  ) : null}
                  {/* Mini-list of items as quick-pick */}
                  <ScrollView style={{ maxHeight: 160 }}>
                    {storeInventory.slice(0, 12).map((it) => {
                      const sel = it.id === pickItemId;
                      return (
                        <TouchableOpacity
                          key={it.id}
                          onPress={() => setPickItemId(it.id)}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingVertical: 5,
                            paddingHorizontal: 6,
                            borderRadius: CmdRadius.xs,
                            backgroundColor: sel ? C.accentBg : 'transparent',
                          }}
                        >
                          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, width: 60 }}>
                            {it.id.slice(0, 6)}
                          </Text>
                          <Text style={{ fontFamily: sans(sel ? 600 : 500), fontSize: 12, color: sel ? C.fg : C.fg2, flex: 1 }} numberOfLines={1}>
                            {it.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>

                {/* Qty */}
                <View
                  style={{
                    flex: 1,
                    backgroundColor: C.panel,
                    borderRadius: CmdRadius.lg,
                    borderWidth: 1,
                    borderColor: C.border,
                    padding: 14,
                    gap: 6,
                  }}
                >
                  <SectionCaption tone="fg3">quantity</SectionCaption>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                    <TextInput
                      value={qty}
                      onChangeText={setQty}
                      placeholder="0"
                      placeholderTextColor={C.fg3}
                      keyboardType="numeric"
                      style={{
                        flex: 1,
                        fontFamily: mono(600),
                        fontSize: 28,
                        color: C.fg,
                        ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                      }}
                    />
                    <Text style={{ fontFamily: mono(400), fontSize: 14, color: C.fg3 }}>
                      {pickedItem?.unit ?? ''}
                    </Text>
                  </View>
                  <View style={{ height: 1, backgroundColor: C.accent, marginTop: 4 }} />
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: qtyNum > 0 ? C.warn : C.fg3, marginTop: 4 }}>
                    = −${previewCost.toFixed(2)} cost{onHandPct > 0 ? ` · ${onHandPct}% of on-hand` : ''}
                  </Text>
                </View>
              </View>

              {/* Reason chips */}
              <View
                style={{
                  backgroundColor: C.panel,
                  borderRadius: CmdRadius.lg,
                  borderWidth: 1,
                  borderColor: C.border,
                  padding: 14,
                  gap: 8,
                }}
              >
                <SectionCaption tone="fg3">reason</SectionCaption>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {REASONS.map((r) => {
                    const sel = r === reason;
                    return (
                      <TouchableOpacity
                        key={r}
                        onPress={() => setReason(r)}
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 6,
                          borderRadius: CmdRadius.md,
                          borderWidth: 1,
                          borderColor: sel ? C.accent : C.border,
                          backgroundColor: sel ? C.accentBg : C.panel2,
                        }}
                      >
                        <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: sel ? C.fg : C.fg2 }}>
                          {wasteReasonLabel(r, T)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Note */}
              <View
                style={{
                  backgroundColor: C.panel,
                  borderRadius: CmdRadius.lg,
                  borderWidth: 1,
                  borderColor: C.border,
                  padding: 14,
                  gap: 6,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <SectionCaption tone="fg3">note</SectionCaption>
                  <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>optional</Text>
                </View>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Where in walk-in? Likely cause? Flag for QC?"
                  placeholderTextColor={C.fg3}
                  multiline
                  numberOfLines={3}
                  style={{
                    fontFamily: mono(400),
                    fontSize: 12,
                    color: C.fg,
                    backgroundColor: C.panel2,
                    borderRadius: CmdRadius.md,
                    borderWidth: 1,
                    borderColor: C.border,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    minHeight: 60,
                    textAlignVertical: 'top',
                    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                  }}
                />
              </View>

              {/* Sticky-ish footer hint */}
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, textAlign: 'right' }}>
                ⏎ submit · esc cancel
              </Text>
            </>
          ) : tabId === 'recent.tsx' ? (
            <WasteRecentTab />
          ) : tabId === 'report.tsx' ? (
            <WasteReportTab />
          ) : null}
        </ScrollView>
      </View>
    </>
  );
}

// ─── recent.tsx — feed of waste rows (7d) ────────────────────────────
function WasteRecentTab() {
  const C = useCmdColors();
  const wasteLog = useStore((s) => s.wasteLog);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const sevenDaysAgo = React.useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString();
  }, []);

  const rows = React.useMemo(() => {
    return wasteLog
      .filter((w) => {
        const item = inventory.find((i) => i.id === w.itemId);
        return item?.storeId === currentStore.id && w.timestamp >= sevenDaysAgo;
      })
      .slice()
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  }, [wasteLog, inventory, currentStore.id, sevenDaysAgo]);

  const totalCost = rows.reduce((s, r) => s + (r.quantity * (r.costPerUnit || 0)), 0);

  return (
    <>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>waste · recent</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          last 7 days · undo within 24h of logging
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label="Events · 7d" value={String(rows.length)} sub="logged" />
        <StatCard label="Cost · 7d" value={`$${totalCost.toFixed(0)}`} sub="vs $400/wk target" />
        <StatCard label="Top reason" value={(() => {
          const m = new Map<string, number>();
          for (const r of rows) m.set(r.reason || 'other', (m.get(r.reason || 'other') || 0) + 1);
          const sorted = Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
          return sorted[0] ? sorted[0][0] : '—';
        })()} sub={rows.length === 0 ? '—' : 'most frequent'} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>recent.log</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{rows.length} {rows.length === 1 ? 'entry' : 'entries'}</Text>
        </View>
        {rows.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            no waste logged in the last 7 days
          </Text>
        ) : (
          rows.map((r, i) => {
            const item = inventory.find((it) => it.id === r.itemId);
            return (
              <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 110 }}>
                  {new Date(r.timestamp).toISOString().slice(5, 16).replace('T', ' ')}
                </Text>
                <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>{r.itemName || item?.name || '—'}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 90 }}>{r.quantity} {r.unit || item?.unit}</Text>
                <View style={{ borderWidth: 1, borderColor: C.warn, borderRadius: CmdRadius.xs, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: C.warnBg }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.warn, letterSpacing: 0.4 }}>
                    {(r.reason || 'OTHER').toUpperCase()}
                  </Text>
                </View>
                <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 60, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                  ${(r.quantity * (r.costPerUnit || 0)).toFixed(0)}
                </Text>
              </View>
            );
          })
        )}
      </View>
    </>
  );
}

// ─── report.tsx — category × reason $ matrix + 13-week trend ─────────
function WasteReportTab() {
  const C = useCmdColors();
  const wasteLog = useStore((s) => s.wasteLog);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const storeWaste = React.useMemo(() => {
    return wasteLog.filter((w) => {
      const item = inventory.find((i) => i.id === w.itemId);
      return item?.storeId === currentStore.id;
    });
  }, [wasteLog, inventory, currentStore.id]);

  // Build category × reason matrix.
  const matrix = React.useMemo(() => {
    const cats = new Map<string, Map<string, number>>();
    const allReasons = new Set<string>();
    for (const w of storeWaste) {
      const item = inventory.find((i) => i.id === w.itemId);
      const cat = item?.category || 'uncategorized';
      const reason = (w.reason || 'other').toLowerCase();
      const inner = cats.get(cat) || new Map();
      inner.set(reason, (inner.get(reason) || 0) + (w.quantity * (w.costPerUnit || 0)));
      cats.set(cat, inner);
      allReasons.add(reason);
    }
    const reasons = Array.from(allReasons).sort();
    const catRows = Array.from(cats.entries()).map(([cat, inner]) => ({
      cat,
      reasonValues: reasons.map((r) => inner.get(r) || 0),
      total: Array.from(inner.values()).reduce((s, v) => s + v, 0),
    })).sort((a, b) => b.total - a.total);
    return { reasons, catRows };
  }, [storeWaste, inventory]);

  // 13-week trend: bucket by ISO week key.
  const trend = React.useMemo(() => {
    const map = new Map<string, number>();
    const now = new Date();
    for (let i = 12; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      map.set(d.toISOString().slice(0, 10).slice(0, 7) + '-W' + String(Math.floor(d.getDate() / 7)), 0);
    }
    for (const w of storeWaste) {
      const d = new Date(w.timestamp);
      if ((now.getTime() - d.getTime()) / 86400000 > 13 * 7) continue;
      const key = d.toISOString().slice(0, 10).slice(0, 7) + '-W' + String(Math.floor(d.getDate() / 7));
      map.set(key, (map.get(key) || 0) + (w.quantity * (w.costPerUnit || 0)));
    }
    return Array.from(map.values());
  }, [storeWaste]);

  const TARGET = 400;
  const max = Math.max(TARGET, ...trend);
  const last4Avg = trend.slice(-4).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(4, trend.length));
  const grandTotal = matrix.catRows.reduce((s, r) => s + r.total, 0);

  return (
    <>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>waste · report</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          category × reason $ matrix · 13-week trend vs $400/wk target
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label="Total · YTD" value={`$${grandTotal.toFixed(0)}`} sub={`${storeWaste.length} events`} />
        <StatCard label="Last 4w avg" value={`$${last4Avg.toFixed(0)}/wk`} sub={`vs target $${TARGET}`} />
        <StatCard label="Categories" value={String(matrix.catRows.length)} sub="affected" />
        <StatCard label="Reasons" value={String(matrix.reasons.length)} sub="distinct" />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>matrix.tsv</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>$ by category × reason</Text>
        </View>
        {matrix.catRows.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>no waste data yet</Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1.2 }}>category</Text>
              {matrix.reasons.map((r) => (
                <Text key={r} style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1, textAlign: 'right' }}>{r}</Text>
              ))}
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70, textAlign: 'right' }}>total</Text>
            </View>
            {matrix.catRows.map((row, i) => (
              <View key={row.cat} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14, gap: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg, flex: 1.2 }} numberOfLines={1}>{row.cat}</Text>
                {row.reasonValues.map((v, j) => (
                  <Text key={j} style={{ fontFamily: mono(400), fontSize: 11.5, color: v > 0 ? C.fg2 : C.fg3, flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    {v > 0 ? `$${v.toFixed(0)}` : '·'}
                  </Text>
                ))}
                <Text style={{ fontFamily: mono(700), fontSize: 11.5, color: C.fg, width: 70, textAlign: 'right', fontVariant: ['tabular-nums'] }}>${row.total.toFixed(0)}</Text>
              </View>
            ))}
          </>
        )}
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>13_WEEK_TREND.dat</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>target ${TARGET}/wk · dashed</Text>
        </View>
        <View style={{ paddingHorizontal: 14, paddingVertical: 14, flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 110 }}>
          {trend.map((v, i) => {
            const h = max === 0 ? 0 : (v / max) * 80;
            const overTarget = v > TARGET;
            return (
              <View key={i} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
                <View style={{ width: '100%', height: h, backgroundColor: overTarget ? C.warn : C.accent, borderRadius: 2 }} />
                <Text style={{ fontFamily: mono(400), fontSize: 8.5, color: C.fg3 }}>w-{12 - i}</Text>
              </View>
            );
          })}
        </View>
      </View>
    </>
  );
}

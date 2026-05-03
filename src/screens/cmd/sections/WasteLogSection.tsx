import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, TextInput, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { Avatar } from '../../../components/cmd/Avatar';
import { relativeTime } from '../../../utils/relativeTime';
import { WasteReason } from '../../../types';

const REASONS: WasteReason[] = ['Expired', 'Dropped/spilled', 'Over-prepped', 'Quality issue', 'Theft', 'Other'];
// Lowercase chip labels per the design's tone (mono caps via the chip's
// own textTransform handling). We display them uppercase via the chip.
const REASON_LABEL: Record<WasteReason, string> = {
  'Expired': 'expired',
  'Dropped/spilled': 'dropped',
  'Over-prepped': 'overproduction',
  'Quality issue': 'quality',
  'Theft': 'theft',
  'Other': 'other',
};

const inferInitials = (name: string): string =>
  name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

// Pattern A — workflow: list pane (recent waste events with filter chips)
// + form pane (item picker + qty + reason chips + note + submit). Wires to
// the existing `logWaste` store action; matches the live data model.
export default function WasteLogSection() {
  const C = useCmdColors();
  const wasteLog = useStore((s) => s.wasteLog);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const logWaste = useStore((s) => s.logWaste);

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
              const label = r === 'all' ? 'all' : REASON_LABEL[r];
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
                  · {REASON_LABEL[w.reason] || w.reason.toLowerCase()}
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
                <Text style={[Type.h1, { color: C.fg }]}>Log new waste</Text>
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
                          {REASON_LABEL[r]}
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
          ) : (
            <View
              style={{
                backgroundColor: C.panel,
                borderRadius: CmdRadius.lg,
                borderWidth: 1,
                borderColor: C.border,
                padding: 16,
                gap: 6,
              }}
            >
              <SectionCaption tone="fg3">status</SectionCaption>
              <Text style={{ fontFamily: mono(600), fontSize: 16, color: C.fg2, letterSpacing: -0.3 }}>
                awaiting design handoff
              </Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>tab: {tabId}</Text>
            </View>
          )}
        </ScrollView>
      </View>
    </>
  );
}

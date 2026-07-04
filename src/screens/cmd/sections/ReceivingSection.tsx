import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, TextInput } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { OrderSubmission } from '../../../types';
import { computeExpiryFromShelfLife } from '../../../lib/db';
import { confirmAction } from '../../../utils/confirmAction';
import { useT } from '../../../hooks/useT';
import { expectedCasePrice, isPriceGuardTripped } from '../lib/priceGuard';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// A PO row as it lives in orderSubmissions (superset of OrderSubmission — see
// db.mapPurchaseOrderRow, which populates status/vendorId/totalCost/timestamp).
type PoRow = OrderSubmission & {
  status?: string;
  vendorId?: string;
  totalCost?: number;
  timestamp?: string;
};

// Spec 010 §5 — short-date label for the "expires" column. Renders a
// compact "May 11" form for any 'YYYY-MM-DD'; "—" for missing/invalid.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortExpiry(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Spec 107 §8 — Receiving has TWO modes:
//   • PO-driven (default): pick a real OPEN PO (sent/partial), the lines are
//     its actual `po_items` with the "received now" input prefilled to the
//     OUTSTANDING remainder (ordered − received; deltas are ADDITIVE per §3),
//     and Commit calls receive_purchase_order — status flips partial/received,
//     stock increments.
//   • Freeform (fallback, RETAINED per AC): the original synthetic path for
//     receiving stock not tied to a PO (adjustStock + audit; no po_items row).
export default function ReceivingSection() {
  const [mode, setMode] = React.useState<'po' | 'freeform'>('po');
  const C = useCmdColors();
  const T = useT();

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: C.bg }}>
      {/* Mode toggle rail (thin, left of the mode's own list pane). */}
      <View style={{ flexDirection: 'row' }}>
        {mode === 'po' ? <PoReceivingMode /> : <FreeformReceivingMode />}
      </View>
      {/* The mode toggle floats top-right via each mode's TabStrip rightSlot;
          expose a compact switch here as well for discoverability. */}
      <ModeSwitch mode={mode} onChange={setMode} />
    </View>
  );
}

// Small floating mode switch rendered on top of the detail pane header.
function ModeSwitch({ mode, onChange }: { mode: 'po' | 'freeform'; onChange: (m: 'po' | 'freeform') => void }) {
  const C = useCmdColors();
  const T = useT();
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', top: 8, right: 16, flexDirection: 'row', gap: 6, zIndex: 10 }}
    >
      {(['po', 'freeform'] as const).map((m) => {
        const isSel = mode === m;
        return (
          <TouchableOpacity
            key={m}
            testID={`receiving-mode-${m}`}
            onPress={() => onChange(m)}
            style={{
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderRadius: CmdRadius.sm,
              borderWidth: 1,
              borderColor: isSel ? C.accent : C.border,
              backgroundColor: isSel ? C.accentBg : C.panel,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 10, letterSpacing: 0.4, color: isSel ? C.accent : C.fg3 }}>
              {m === 'po' ? T('section.receiving.modePo') : T('section.receiving.modeFreeform')}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── PO-DRIVEN MODE (spec 107) ────────────────────────────────────────
function PoReceivingMode() {
  const C = useCmdColors();
  const T = useT();
  const orderSubmissions = useStore((s) => s.orderSubmissions) as PoRow[];
  const currentStore = useStore((s) => s.currentStore);
  const poLinesById = useStore((s) => s.poLinesById);
  const loadPurchaseOrderLines = useStore((s) => s.loadPurchaseOrderLines);
  const receivePurchaseOrder = useStore((s) => s.receivePurchaseOrder);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  // Per-line "received this time" inputs, keyed by poItemId. Seeded to the
  // outstanding remainder on load; the operator overrides as needed.
  const [entries, setEntries] = React.useState<Record<string, string>>({});
  // Spec 109 — per-line "case price this delivery" inputs, keyed by poItemId.
  // Seeded (ghosted) with the expected case price = costPerUnit × caseQty on
  // load. A value EQUAL to the ghost (or empty) is a pure stock receive; a
  // DIFFERENT value sends the new case price and updates cost server-side.
  const [prices, setPrices] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  // Only OPEN POs (sent | partial) can be received against.
  const openPos = React.useMemo<PoRow[]>(
    () =>
      orderSubmissions
        .filter((o) => o.storeId === currentStore.id)
        .filter((o) => o.status === 'sent' || o.status === 'partial')
        .slice()
        .sort((a, b) => ((a.timestamp || a.date) < (b.timestamp || b.date) ? 1 : -1)),
    [orderSubmissions, currentStore.id],
  );

  React.useEffect(() => {
    if (selectedId && openPos.find((o) => o.id === selectedId)) return;
    setSelectedId(openPos[0]?.id || null);
  }, [openPos, selectedId]);

  const sel = openPos.find((o) => o.id === selectedId);
  const lines = (sel && poLinesById[sel.id]) || [];

  // Load lines + seed the inputs to the outstanding remainder when a PO opens.
  // Guard the async state update against unmount / PO-switch so a late resolve
  // for a no-longer-selected PO doesn't clobber the current inputs.
  React.useEffect(() => {
    if (!sel?.id) return;
    let cancelled = false;
    void loadPurchaseOrderLines(sel.id).then((loaded) => {
      if (cancelled) return;
      const seed: Record<string, string> = {};
      const priceSeed: Record<string, string> = {};
      for (const ln of loaded) {
        const outstanding = Math.max(0, ln.orderedQty - ln.receivedQty);
        seed[ln.poItemId] = String(outstanding);
        // Ghost the case-price input with the expected price the PO was created
        // at (costPerUnit is per-COUNTED-unit; × caseQty reconstructs the case).
        // 0 (no meaningful baseline) ghosts empty so the operator can enter one.
        const expected = expectedCasePrice(ln.costPerUnit, ln.caseQty);
        priceSeed[ln.poItemId] = expected > 0 ? expected.toFixed(2) : '';
      }
      setEntries(seed);
      setPrices(priceSeed);
    });
    return () => { cancelled = true; };
  }, [sel?.id, loadPurchaseOrderLines]);

  const outstandingTotal = lines.reduce((s, ln) => s + Math.max(0, ln.orderedQty - ln.receivedQty), 0);
  const enteredTotal = lines.reduce((s, ln) => s + (Number(entries[ln.poItemId]) || 0), 0);

  const onCommit = () => {
    if (!sel || busy) return;
    // Build the this-receive deltas (skip zero rows). ADDITIVE semantics — this
    // is how much arrived THIS receive, NOT the ordered total (§3).
    //
    // Spec 109 — attach `newCasePrice` ONLY when the operator entered a finite
    // case price that DIFFERS numerically from the ghosted expected price. An
    // empty or ghost-equal value stays a pure stock receive (no key → server
    // no-op). The comparison rounds both sides to 2dp so the 2-decimal ghost
    // string ("40.00") doesn't read as "changed" against a 40 expected.
    const deltas = lines
      .map((ln) => {
        const receivedQty = Number(entries[ln.poItemId]) || 0;
        const expected = expectedCasePrice(ln.costPerUnit, ln.caseQty);
        const raw = (prices[ln.poItemId] ?? '').trim();
        const entered = raw === '' ? NaN : Number(raw);
        const changed =
          Number.isFinite(entered) &&
          entered > 0 &&
          Number(entered.toFixed(2)) !== Number(expected.toFixed(2));
        return changed
          ? { poItemId: ln.poItemId, receivedQty, newCasePrice: entered }
          : { poItemId: ln.poItemId, receivedQty };
      })
      .filter((d) => d.receivedQty > 0);
    if (deltas.length === 0) {
      Toast.show({ type: 'error', text1: T('section.receiving.nothingToReceive') });
      return;
    }

    // Spec 109 — collect the changed-price lines that trip the >30% fat-finger
    // guard (OQ-4), bridged case-to-case (see lib/priceGuard). Used to build the
    // SECOND confirm listing each flagged line as `item: $old → $new`.
    const flagged = deltas
      .filter((d) => typeof (d as { newCasePrice?: number }).newCasePrice === 'number')
      .map((d) => {
        const ln = lines.find((l) => l.poItemId === d.poItemId)!;
        return { ln, entered: (d as { newCasePrice: number }).newCasePrice };
      })
      .filter(({ ln, entered }) => isPriceGuardTripped({ costPerUnit: ln.costPerUnit, caseQty: ln.caseQty, enteredCasePrice: entered }));

    // Spec 109 code-review fix — `busy` goes true HERE, before the first
    // confirm, not inside runReceive. On native, Alert.alert is async and
    // non-blocking, so the commit button would otherwise stay live through the
    // entire window both dialogs are open (double-tap → stacked dialog chains).
    // Every decline path releases it via confirmAction's onCancel.
    setBusy(true);
    const releaseBusy = () => setBusy(false);

    // The actual RPC call, shared by the guarded and unguarded paths.
    const runReceive = () => {
      void receivePurchaseOrder(sel.id, deltas)
        .then((result) => {
          if (result) {
            Toast.show({
              type: 'success',
              text1: T('section.receiving.receivedToast'),
              text2: T(`section.purchaseOrders.status.${result.status === 'received' ? 'received' : 'partial'}`),
            });
            // Spec 109 — a second toast naming the count of applied price updates.
            if (result.priceChanges.length > 0) {
              Toast.show({
                type: 'success',
                text1: T('section.receiving.pricesUpdatedToast', { count: result.priceChanges.length }),
              });
            }
          }
        })
        .finally(() => setBusy(false));
    };

    // Spec 107 code-review fix — commit mutates stock, so it is confirm-gated
    // like its four lifecycle siblings (send / mark-sent / cancel / close-short).
    // This existing confirm STAYS; the 30% price guard is an ADDITIONAL, nested
    // confirm that only appears when a large delta is present (spec 109 §12).
    confirmAction(
      T('section.receiving.commitConfirmTitle'),
      T('section.receiving.commitConfirmBody', { count: deltas.length, total: enteredTotal }),
      () => {
        if (flagged.length === 0) {
          runReceive();
          return;
        }
        // Spec 109 (OQ-4) — a >30% price delta requires an explicit second
        // confirm listing old→new per flagged line. Declining aborts the WHOLE
        // commit (nothing is received — client-side gate is the pinned
        // mechanism). Confirming proceeds to the RPC.
        const list = flagged
          .map(({ ln, entered }) =>
            T('section.receiving.priceGuardLine', {
              item: ln.itemName,
              old: expectedCasePrice(ln.costPerUnit, ln.caseQty).toFixed(2),
              new: entered.toFixed(2),
            }),
          )
          .join('\n');
        confirmAction(
          T('section.receiving.priceGuardTitle'),
          T('section.receiving.priceGuardBody', { lines: list }),
          runReceive,
          T('section.receiving.priceGuardCta'),
          releaseBusy,
        );
      },
      T('section.receiving.commitConfirmCta'),
      releaseBusy,
    );
  };

  return (
    <>
      {/* List pane — open POs */}
      <View style={{ width: 300, backgroundColor: C.panel, borderRightWidth: 1, borderRightColor: C.border }}>
        <View
          style={{
            paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10,
            borderBottomWidth: 1, borderBottomColor: C.border,
            flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
          }}
        >
          <Text style={[Type.h2, { color: C.fg }]}>{T('section.receiving.title')}</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {T('section.receiving.openCount', { count: openPos.length })}
          </Text>
        </View>
        <FlatList
          data={openPos}
          keyExtractor={(o) => o.id}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {T('section.receiving.noOpenPos')}
            </Text>
          }
          renderItem={({ item: o }) => {
            const isSel = o.id === selectedId;
            return (
              <TouchableOpacity
                onPress={() => setSelectedId(o.id)}
                activeOpacity={0.85}
                style={{
                  paddingHorizontal: 16 - (isSel ? 2 : 0), paddingVertical: 12,
                  borderBottomWidth: 1, borderBottomColor: C.border,
                  borderLeftWidth: isSel ? 2 : 0, borderLeftColor: C.accent,
                  backgroundColor: isSel ? C.accentBg : 'transparent', gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg }}>{shortId(o.id)}</Text>
                  <StatusPill status={o.status === 'partial' ? 'low' : 'info'} label={T(`section.purchaseOrders.status.${o.status === 'partial' ? 'partial' : 'sent'}`)} />
                </View>
                <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg }} numberOfLines={1}>{o.vendorName}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  {o.day} · {(o.date || '').slice(0, 10)}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Detail pane — real po_items with outstanding-prefilled receive inputs */}
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {!sel ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
              {openPos.length === 0 ? T('section.receiving.noOpenPosToReceive') : T('section.receiving.selectPo')}
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 22, paddingTop: 44, gap: 14 }}>
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.id)}</Text>
                <StatusPill status={sel.status === 'partial' ? 'low' : 'info'} label={T(`section.purchaseOrders.status.${sel.status === 'partial' ? 'partial' : 'sent'}`)} />
              </View>
              <Text style={[Type.h1, { color: C.fg }]}>{T('section.receiving.vendorLines', { vendor: sel.vendorName, count: lines.length })}</Text>
              <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                {T('section.receiving.poSubtitle')}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <StatCard label={T('section.receiving.linesCard')} value={String(lines.length)} sub={T('section.receiving.fromPoItems')} />
              <StatCard label={T('section.receiving.outstandingCard')} value={String(outstandingTotal)} sub={T('section.receiving.outstandingSub')} />
              <StatCard label={T('section.receiving.receivingNowCard')} value={String(enteredTotal)} sub={T('section.receiving.receivingNowSub')} />
            </View>

            {/* Line items table with per-line receive inputs */}
            <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
                <SectionCaption tone="fg3" size={10.5}>{T('section.receiving.lineItemsCaption')}</SectionCaption>
                <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.receiving.poReceiveHint')}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
                <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, flex: 1 }]}>{T('section.receiving.nameCol')}</Text>
                <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>{T('section.receiving.orderedCol')}</Text>
                <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>{T('section.receiving.alreadyCol')}</Text>
                <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>{T('section.receiving.outstandingCol')}</Text>
                <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 96, textAlign: 'right' }]}>{T('section.receiving.receiveNowCol')}</Text>
                <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 110, textAlign: 'right' }]}>{T('section.receiving.caseThisDeliveryCol')}</Text>
              </View>
              {lines.length === 0 ? (
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
                  {T('section.receiving.noLineItems')}
                </Text>
              ) : (
                lines.map((ln, i) => {
                  const outstanding = Math.max(0, ln.orderedQty - ln.receivedQty);
                  // Spec 109 — the ghosted expected case price + whether the
                  // entered value differs (drives the visually-distinct border).
                  const expected = expectedCasePrice(ln.costPerUnit, ln.caseQty);
                  const rawPrice = (prices[ln.poItemId] ?? '').trim();
                  const enteredPrice = rawPrice === '' ? NaN : Number(rawPrice);
                  const priceChanged =
                    Number.isFinite(enteredPrice) &&
                    enteredPrice > 0 &&
                    Number(enteredPrice.toFixed(2)) !== Number(expected.toFixed(2));
                  return (
                    <View
                      key={ln.poItemId}
                      style={{
                        flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, gap: 10,
                        borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border,
                      }}
                    >
                      <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>{ln.itemName}</Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                        {ln.orderedQty} {ln.unit}
                      </Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg3, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                        {ln.receivedQty > 0 ? ln.receivedQty : '—'}
                      </Text>
                      <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: outstanding > 0 ? C.fg : C.fg3, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                        {outstanding}
                      </Text>
                      <TextInput
                        testID={`receiving-line-${ln.poItemId}`}
                        value={entries[ln.poItemId] ?? ''}
                        keyboardType="numeric"
                        onChangeText={(text) => setEntries((prev) => ({ ...prev, [ln.poItemId]: text.replace(/[^0-9.]/g, '') }))}
                        style={{
                          fontFamily: mono(600), fontSize: 12, color: C.fg, width: 96, textAlign: 'right',
                          borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.xs,
                          paddingVertical: 4, paddingHorizontal: 6,
                        }}
                      />
                      {/* Spec 109 — "case price this delivery": ghosted with the
                          expected case price; a changed value marks the line
                          (accent border + tint) and sends the new case price. */}
                      <TextInput
                        testID={`receiving-price-${ln.poItemId}`}
                        value={prices[ln.poItemId] ?? ''}
                        keyboardType="numeric"
                        placeholder={expected > 0 ? expected.toFixed(2) : T('section.receiving.caseThisDeliveryPlaceholder')}
                        placeholderTextColor={C.fg3}
                        onChangeText={(text) => setPrices((prev) => ({ ...prev, [ln.poItemId]: text.replace(/[^0-9.]/g, '') }))}
                        style={{
                          fontFamily: mono(600), fontSize: 12, color: priceChanged ? C.accent : C.fg, width: 110, textAlign: 'right',
                          borderWidth: 1, borderColor: priceChanged ? C.accent : C.borderStrong, borderRadius: CmdRadius.xs,
                          backgroundColor: priceChanged ? C.accentBg : 'transparent',
                          paddingVertical: 4, paddingHorizontal: 6,
                        }}
                      />
                    </View>
                  );
                })
              )}
            </View>

            <TouchableOpacity
              testID="receiving-commit"
              onPress={onCommit}
              disabled={busy || enteredTotal <= 0}
              style={{
                alignSelf: 'flex-start',
                paddingVertical: 8, paddingHorizontal: 16,
                borderRadius: CmdRadius.sm,
                backgroundColor: C.accent,
                opacity: busy || enteredTotal <= 0 ? 0.5 : 1,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11.5, color: '#000', letterSpacing: 0.3 }}>
                {busy ? T('section.receiving.committing') : T('section.receiving.commitReceive')}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </View>
    </>
  );
}

// ─── FREEFORM MODE (retained fallback — original synthetic path) ──────
// Receives stock NOT tied to a PO via adjustStock + audit. No po_items row
// backs any line (spec 107 keeps this as the non-PO fallback, per AC).
function FreeformReceivingMode() {
  const C = useCmdColors();
  const T = useT();
  const orderSubmissions = useStore((s) => s.orderSubmissions);
  const inventory = useStore((s) => s.inventory);
  const vendors = useStore((s) => s.vendors);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const adjustStock = useStore((s) => s.adjustStock);
  const addAuditEvent = useStore((s) => s.addAuditEvent);
  const catalogIngredients = useStore((s) => s.catalogIngredients);
  const updateItem = useStore((s) => s.updateItem);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('lines.tsx');
  const [committed, setCommitted] = React.useState<Set<string>>(new Set());

  const incoming = React.useMemo<OrderSubmission[]>(() => {
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    return orderSubmissions
      .filter((o) => o.storeId === currentStore.id)
      .filter((o) => {
        const t = o.date ? new Date(o.date).getTime() : NaN;
        return Number.isFinite(t) && t >= cutoff;
      })
      .slice(0, 10);
  }, [orderSubmissions, currentStore.id]);

  React.useEffect(() => {
    if (selectedId && incoming.find((o) => o.id === selectedId)) return;
    setSelectedId(incoming[0]?.id || null);
  }, [incoming, selectedId]);

  const sel = incoming.find((o) => o.id === selectedId);

  const lineItems = React.useMemo(() => {
    if (!sel) return [];
    const vendor = vendors.find((v) => v.name?.toLowerCase() === sel.vendorName?.toLowerCase());
    const vendorItems = vendor
      ? inventory.filter((i) => i.vendorId === vendor.id && i.storeId === currentStore.id)
      : inventory.filter((i) => i.storeId === currentStore.id).slice(0, 5);
    return vendorItems.slice(0, 7).map((i, idx) => {
      const orderedQty = Math.max(1, Math.round(i.parLevel - i.currentStock));
      const state: 'ok' | 'short' | 'pending' = idx === 3 ? 'short' : idx < 3 ? 'ok' : 'pending';
      const receivedQty = state === 'ok' ? orderedQty : state === 'short' ? Math.max(0, orderedQty - 1) : 0;
      return {
        id: i.id,
        name: i.name,
        unit: i.unit,
        ordered: orderedQty,
        received: receivedQty,
        // Spec 104 (OQ-5) — `orderedQty` is in COUNTED units, `costPerUnit` is
        // per-each → `× subUnitSize` bridge so the received-line cost is unchanged.
        cost: orderedQty * i.costPerUnit * (i.subUnitSize || 1),
        state,
        expiryDate: i.expiryDate,
      };
    });
  }, [sel, inventory, vendors, currentStore.id]);

  const commitReceive = (lid: string) => {
    if (committed.has(lid) || !sel) return;
    const li = lineItems.find((x) => x.id === lid);
    if (!li) return;
    const item = inventory.find((i) => i.id === li.id);
    if (!item) return;
    const qtyToReceive = li.received > 0 ? li.received : li.ordered;
    if (qtyToReceive <= 0) return;
    const newStock = item.currentStock + qtyToReceive;
    adjustStock(item.id, newStock, currentUser?.name || 'unknown');
    if (!item.expiryDate) {
      const catalog = catalogIngredients.find((c) => c.id === item.catalogId);
      const shelfLife = catalog?.defaultShelfLifeDays ?? null;
      const now = new Date();
      const todayLocal =
        `${now.getFullYear()}-` +
        `${String(now.getMonth() + 1).padStart(2, '0')}-` +
        `${String(now.getDate()).padStart(2, '0')}`;
      const computed = computeExpiryFromShelfLife(todayLocal, shelfLife);
      if (computed) {
        updateItem(item.id, { expiryDate: computed });
      }
    }
    addAuditEvent({
      timestamp: new Date().toISOString(),
      userId: currentUser?.id || '',
      userName: currentUser?.name || 'unknown',
      userRole: 'user',
      storeId: currentStore.id,
      storeName: currentStore.name,
      action: 'Stock adjusted',
      detail: `Received from ${sel.vendorName}`,
      itemRef: item.name,
      value: `+${qtyToReceive} ${item.unit}`,
    });
    setCommitted((prev) => {
      const next = new Set(prev);
      next.add(lid);
      return next;
    });
    Toast.show({
      type: 'success',
      text1: T('section.receiving.receivedToast'),
      text2: `${item.name} +${qtyToReceive} ${item.unit}`,
    });
  };

  const matched = React.useMemo(() => {
    let m = 0;
    for (const li of lineItems) {
      if (committed.has(li.id) || li.state === 'ok') m++;
    }
    return m;
  }, [lineItems, committed]);
  const shorts = lineItems.filter((li) => li.state === 'short').length;
  const invoiceTotal = lineItems.reduce((s, li) => s + li.cost, 0);
  const actualTotal = lineItems
    .filter((li) => li.state === 'ok' || committed.has(li.id))
    .reduce((s, li) => s + (li.received / Math.max(1, li.ordered)) * li.cost, 0);

  return (
    <>
      {/* List pane */}
      <View style={{ width: 300, backgroundColor: C.panel, borderRightWidth: 1, borderRightColor: C.border }}>
        <View
          style={{
            paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10,
            borderBottomWidth: 1, borderBottomColor: C.border,
            flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
          }}
        >
          <Text style={[Type.h2, { color: C.fg }]}>{T('section.receiving.title')}</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {T('section.receiving.inFlight', { count: incoming.length })}
          </Text>
        </View>
        <FlatList
          data={incoming}
          keyExtractor={(o) => o.id}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {T('section.receiving.noIncomingOrders')}
            </Text>
          }
          renderItem={({ item: o }) => {
            const isSel = o.id === selectedId;
            return (
              <TouchableOpacity
                onPress={() => setSelectedId(o.id)}
                activeOpacity={0.85}
                style={{
                  paddingHorizontal: 16 - (isSel ? 2 : 0), paddingVertical: 12,
                  borderBottomWidth: 1, borderBottomColor: C.border,
                  borderLeftWidth: isSel ? 2 : 0, borderLeftColor: C.accent,
                  backgroundColor: isSel ? C.accentBg : 'transparent', gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg }}>{shortId(o.id)}</Text>
                  <StatusPill status="info" label={T('section.receiving.inTransit')} />
                </View>
                <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg }} numberOfLines={1}>{o.vendorName}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  {o.day} · {o.date.slice(0, 10)}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Detail pane */}
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {!sel ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
              {incoming.length === 0
                ? T('section.receiving.noIncomingToReceive')
                : T('section.receiving.selectOrder')}
            </Text>
          </View>
        ) : (
          <>
            <TabStrip
              tabs={[
                { id: 'lines.tsx', label: 'lines.tsx' },
                { id: 'docs.tsx',  label: 'docs.tsx' },
                { id: 'flag.tsx',  label: 'flag.tsx' },
              ]}
              activeId={tabId}
              onChange={setTabId}
              rightSlot={
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.receiving.scanBarcode')}</Text>
                  </View>
                  <View style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>{T('section.receiving.finishReceiving')}</Text>
                  </View>
                </View>
              }
            />
            {tabId === 'docs.tsx' || tabId === 'flag.tsx' ? (
              <ReceivingPlaceholder kind={tabId === 'docs.tsx' ? 'docs' : 'flag'} />
            ) : (
            <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.id)}</Text>
                  <StatusPill status="low" label={T('section.receiving.receivingPill')} />
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                    · {sel.day}{T('section.receiving.arrivedAt', { time: sel.submittedAt.slice(11, 16) })}
                  </Text>
                </View>
                <Text style={[Type.h1, { color: C.fg }]}>{T('section.receiving.vendorLines', { vendor: sel.vendorName, count: lineItems.length })}</Text>
                <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                  {T('section.receiving.lineSubtitle')}
                </Text>
              </View>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <StatCard label={T('section.receiving.linesMatched')} value={`${matched} / ${lineItems.length}`} sub={T('section.receiving.percentComplete', { pct: Math.round((matched / Math.max(1, lineItems.length)) * 100) })} />
                <StatCard label={T('section.receiving.shorts')} value={String(shorts)} sub={shorts > 0 ? T('section.receiving.flagForCredit') : '—'} />
                <StatCard label={T('section.receiving.damaged')} value="0" sub="—" />
                <StatCard label={T('section.receiving.invoiceTotal')} value={`$${invoiceTotal.toFixed(2)}`} sub={T('section.receiving.actualTotal', { value: actualTotal.toFixed(2) })} />
              </View>

              {/* Line items table */}
              <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
                  <SectionCaption tone="fg3" size={10.5}>{T('section.receiving.lineItemsCaption')}</SectionCaption>
                  <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.receiving.lineItemsHint')}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
                  <View style={{ width: 18 }} />
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 60 }]}>{T('section.receiving.idCol')}</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, flex: 1 }]}>{T('section.receiving.nameCol')}</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>{T('section.receiving.orderedCol')}</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>{T('section.receiving.receivedCol')}</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>{T('section.receiving.expiresCol')}</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>{T('section.receiving.lineDollarCol')}</Text>
                  <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 70, textAlign: 'right' }]}>{T('section.receiving.stateCol')}</Text>
                </View>
                {lineItems.length === 0 ? (
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
                    {T('section.receiving.noLineItems')}
                  </Text>
                ) : (
                  lineItems.map((li, i) => {
                    const isCommitted = committed.has(li.id);
                    const isReceived = isCommitted || li.state === 'ok';
                    const stateForPill: 'ok' | 'low' | 'out' | 'info' =
                      li.state === 'ok' ? 'ok' : li.state === 'short' ? 'low' : 'info';
                    return (
                      <TouchableOpacity
                        key={li.id}
                        onPress={() => commitReceive(li.id)}
                        disabled={isCommitted}
                        activeOpacity={0.85}
                        style={{
                          flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, gap: 10,
                          borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border,
                          backgroundColor: li.state === 'short' ? C.warnBg : 'transparent',
                        }}
                      >
                        <View
                          style={{
                            width: 14, height: 14, borderRadius: 3, borderWidth: 1,
                            borderColor: isReceived ? C.accent : C.borderStrong,
                            backgroundColor: isReceived ? C.accent : 'transparent',
                            alignItems: 'center', justifyContent: 'center',
                          }}
                        >
                          {isReceived ? <Text style={{ fontSize: 9, color: '#000', fontWeight: '700', lineHeight: 11 }}>✓</Text> : null}
                        </View>
                        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 60 }}>{shortId(li.id)}</Text>
                        <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>{li.name}</Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          {li.ordered} {li.unit}
                        </Text>
                        <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: li.state === 'short' ? C.warn : (li.received > 0 ? C.fg : C.fg3), width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          {li.received > 0 ? `${li.received} ${li.unit}` : '—'}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: li.expiryDate ? C.fg2 : C.fg3, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          {shortExpiry(li.expiryDate)}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          ${li.cost.toFixed(2)}
                        </Text>
                        <View style={{ width: 70, alignItems: 'flex-end' }}>
                          <StatusPill status={stateForPill} label={li.state.toUpperCase()} />
                        </View>
                      </TouchableOpacity>
                    );
                  })
                )}
              </View>
            </ScrollView>
            )}
          </>
        )}
      </View>
    </>
  );
}

// ─── docs.tsx + flag.tsx (Tier 2 — needs new tables + storage) ────────
function ReceivingPlaceholder({ kind }: { kind: 'docs' | 'flag' }) {
  const C = useCmdColors();
  const T = useT();
  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{kind === 'docs' ? T('section.receiving.docsTitle') : T('section.receiving.flagTitle')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {kind === 'docs'
            ? T('section.receiving.docsSubtitle')
            : T('section.receiving.flagSubtitle')}
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>{T('section.receiving.notYetWired')}</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          {kind === 'docs'
            ? T('section.receiving.docsNotWiredBody')
            : T('section.receiving.flagNotWiredBody')}
        </Text>
      </View>
    </ScrollView>
  );
}

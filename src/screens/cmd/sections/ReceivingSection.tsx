import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity } from 'react-native';
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
import { useT } from '../../../hooks/useT';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Spec 010 §5 — short-date label for the "expires" column. Renders a
// compact "May 11" form for any 'YYYY-MM-DD'; "—" for missing/invalid.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortExpiry(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Pattern A — workflow: list of POs in flight (left) + line-items checklist
// (right). Real receiving requires a po_items join + per-row qty diff
// mutation, which lives in src/lib/db.ts. For Phase 10b we read from the
// existing orderSubmissions store (the closest thing to a "PO" the legacy
// app has) and derive a synthetic line-items table.
//
// When the proper purchase_orders / po_items wiring lands, this section's
// mock rows become real lookups; the chrome stays unchanged.
export default function ReceivingSection() {
  const C = useCmdColors();
  const T = useT();
  const orderSubmissions = useStore((s) => s.orderSubmissions);
  const inventory = useStore((s) => s.inventory);
  const vendors = useStore((s) => s.vendors);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const adjustStock = useStore((s) => s.adjustStock);
  const addAuditEvent = useStore((s) => s.addAuditEvent);
  // Spec 010 §5 — auto-stamp on receive needs the catalog row's
  // defaultShelfLifeDays + an inventory_items writer to set expiry_date.
  const catalogIngredients = useStore((s) => s.catalogIngredients);
  const updateItem = useStore((s) => s.updateItem);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('lines.tsx');
  // Lines committed to the DB this session — one-way (no undo, since
  // there's no po_items row to flip back). Used for both visual ✓ and
  // click-lock so the user can't double-receive.
  const [committed, setCommitted] = React.useState<Set<string>>(new Set());

  // Filter to current store. Treat anything in orderSubmissions that's not
  // older than 14 days as "in flight" — close enough for the receiving
  // surface until purchase_orders + status field land.
  // NB: o.submittedAt comes back as a pre-formatted time-only string
  // ("1:27 AM") from fetchRecentPurchaseOrders, so it's not Date-parseable.
  // Use o.date (YYYY-MM-DD reference_date) for the cutoff check instead.
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

  // Synthetic line items — pull a few items from the matching vendor's
  // catalog so the table reads as plausible until po_items data lands.
  const lineItems = React.useMemo(() => {
    if (!sel) return [];
    const vendor = vendors.find((v) => v.name?.toLowerCase() === sel.vendorName?.toLowerCase());
    const vendorItems = vendor
      ? inventory.filter((i) => i.vendorId === vendor.id && i.storeId === currentStore.id)
      : inventory.filter((i) => i.storeId === currentStore.id).slice(0, 5);
    return vendorItems.slice(0, 7).map((i, idx) => {
      const orderedQty = Math.max(1, Math.round(i.parLevel - i.currentStock));
      // Mock state: alternating ok/short/pending so the visual reads
      const state: 'ok' | 'short' | 'pending' = idx === 3 ? 'short' : idx < 3 ? 'ok' : 'pending';
      const receivedQty = state === 'ok' ? orderedQty : state === 'short' ? Math.max(0, orderedQty - 1) : 0;
      return {
        id: i.id,
        name: i.name,
        unit: i.unit,
        ordered: orderedQty,
        received: receivedQty,
        cost: orderedQty * i.costPerUnit,
        state,
        // Spec 010 §5 — display-only expiry per line. Reads from the
        // underlying inventory_items.expiry_date so the auto-stamp side
        // effect surfaces here on the next render after commitReceive.
        expiryDate: i.expiryDate,
      };
    });
  }, [sel, inventory, vendors, currentStore.id]);

  // Single-click commit: bump stock by the received qty and add an audit
  // event. No undo — once committed, the line is locked. The synthetic
  // line-items table can't track a real "received" flag (no po_items
  // table yet), so the audit log is the durable trail.
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
    // Spec 010 §5 — auto-stamp expiry from the catalog row's
    // defaultShelfLifeDays when (a) the row has no current expiry and
    // (b) the catalog row carries a non-null shelf-life. This is the
    // only persistence path for expiry on receipt today (Tier-1 mock —
    // there is no po_items row to attach a per-line override to per
    // architect §0/§9 flag #1). Operator wanting to override goes to
    // the IngredientFormDrawer.
    if (!item.expiryDate) {
      const catalog = catalogIngredients.find((c) => c.id === item.catalogId);
      const shelfLife = catalog?.defaultShelfLifeDays ?? null;
      // Local-date YYYY-MM-DD (NOT toISOString.slice(0,10) — that yields
      // UTC-today and stamps tomorrow's date when local time is past the
      // UTC boundary; mirrors the canonical TZ-correct construction in
      // src/lib/cmdSelectors.ts:886-888 — same Spec 007 TZ class).
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
      <View
        style={{
          width: 300,
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
            flexDirection: 'row',
            alignItems: 'baseline',
            justifyContent: 'space-between',
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
                  paddingHorizontal: 16 - (isSel ? 2 : 0),
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: C.border,
                  borderLeftWidth: isSel ? 2 : 0,
                  borderLeftColor: C.accent,
                  backgroundColor: isSel ? C.accentBg : 'transparent',
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg }}>
                    {shortId(o.id)}
                  </Text>
                  <StatusPill status="info" label={T('section.receiving.inTransit')} />
                </View>
                <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg }} numberOfLines={1}>
                  {o.vendorName}
                </Text>
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
                  {/* Spec 010 §5 — display-only expires column. The
                      auto-stamp branch in commitReceive sets this on
                      first receive when the catalog row has a
                      defaultShelfLifeDays. */}
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
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingVertical: 10,
                          paddingHorizontal: 14,
                          gap: 10,
                          borderTopWidth: i === 0 ? 0 : 1,
                          borderTopColor: C.border,
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
                        <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                          {li.name}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          {li.ordered} {li.unit}
                        </Text>
                        <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: li.state === 'short' ? C.warn : (li.received > 0 ? C.fg : C.fg3), width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          {li.received > 0 ? `${li.received} ${li.unit}` : '—'}
                        </Text>
                        {/* Spec 010 §5 — expires column. After
                            commitReceive auto-stamps from the catalog's
                            default shelf life, the row re-renders with
                            the new date. "—" means no expiry set + no
                            catalog default to apply. */}
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

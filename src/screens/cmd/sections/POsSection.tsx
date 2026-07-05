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
import { useT } from '../../../hooks/useT';
import { useLocale } from '../../../hooks/useLocale';
import { confirmAction } from '../../../utils/confirmAction';
import { getLocalizedName } from '../../../i18n/localizedName';
import { buildPoShareText, type NameResolver } from '../../../utils/poShareText';
import { buildPoQuickOrderText } from '../../../utils/poQuickOrderText';
import { sharePurchaseOrder } from '../lib/sharePo';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Spec 107 — the real PO status vocabulary. POs ride the `orderSubmissions`
// array (a superset of OrderSubmission carrying `status`/`vendorId`/etc. — see
// db.mapPurchaseOrderRow). `status` is the reconciled 5-token set.
type PoStatus = 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';
const PO_STATUSES: PoStatus[] = ['draft', 'sent', 'partial', 'received', 'cancelled'];

// A PO row as it lives in orderSubmissions (superset of OrderSubmission — see
// db.mapPurchaseOrderRow, which populates status/vendorId/totalCost/timestamp).
type PoRow = OrderSubmission & {
  status?: string;
  vendorId?: string;
  totalCost?: number;
  timestamp?: string;
};

function normalizeStatus(s: string | undefined): PoStatus {
  return (PO_STATUSES as string[]).includes(s || '') ? (s as PoStatus) : 'draft';
}

// StatusPill tone per PO status. draft → info, sent → low (awaiting), partial →
// low, received → ok, cancelled → out.
function pillTone(status: PoStatus): 'ok' | 'low' | 'out' | 'info' {
  switch (status) {
    case 'received': return 'ok';
    case 'cancelled': return 'out';
    case 'sent':
    case 'partial': return 'low';
    default: return 'info';
  }
}

// Spec 107 §5/§8 — list + detail with real lifecycle. Reads real POs from
// useStore.orderSubmissions (which carry `status`), loads real `po_items` lines
// for the detail via loadPurchaseOrderLines, and offers the state transitions:
// send to vendor (confirm → edge fn) / mark as sent manually (fallback) /
// cancel / close short (only from partial). Draft lines are editable.
export default function POsSection() {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const orderSubmissions = useStore((s) => s.orderSubmissions) as PoRow[];
  const vendors = useStore((s) => s.vendors);
  const currentStore = useStore((s) => s.currentStore);
  const inventory = useStore((s) => s.inventory);
  const poLinesById = useStore((s) => s.poLinesById);
  const loadPurchaseOrderLines = useStore((s) => s.loadPurchaseOrderLines);
  const updatePoLineQty = useStore((s) => s.updatePoLineQty);
  const removePoLine = useStore((s) => s.removePoLine);
  const sendPurchaseOrderEmail = useStore((s) => s.sendPurchaseOrderEmail);
  const markPurchaseOrderSentManually = useStore((s) => s.markPurchaseOrderSentManually);
  const cancelPurchaseOrder = useStore((s) => s.cancelPurchaseOrder);
  const closeShortPurchaseOrder = useStore((s) => s.closeShortPurchaseOrder);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('order.tsx');
  const [statusFilter, setStatusFilter] = React.useState<'all' | PoStatus>('all');
  const [busy, setBusy] = React.useState(false);
  // Spec 108 (D-3) — desktop-web share preview. Cleared on PO switch (below) so
  // a stale preview from PO A never lingers when switching to PO B.
  const [sharePreview, setSharePreview] = React.useState<string | null>(null);
  React.useEffect(() => setSharePreview(null), [selectedId]);

  const allOrders = React.useMemo<PoRow[]>(
    () =>
      orderSubmissions
        .filter((o) => o.storeId === currentStore.id)
        .slice()
        .sort((a, b) => ((a.timestamp || a.date) < (b.timestamp || b.date) ? 1 : -1)),
    [orderSubmissions, currentStore.id],
  );

  const filtered = React.useMemo(() => {
    if (statusFilter === 'all') return allOrders;
    return allOrders.filter((o) => normalizeStatus(o.status) === statusFilter);
  }, [allOrders, statusFilter]);

  React.useEffect(() => {
    if (selectedId && filtered.find((o) => o.id === selectedId)) return;
    setSelectedId(filtered[0]?.id || null);
  }, [filtered, selectedId]);

  const sel = filtered.find((o) => o.id === selectedId);
  const selStatus = normalizeStatus(sel?.status);
  const selVendor = sel ? vendors.find((v) => v.id === sel.vendorId) : undefined;
  const vendorEmail = selVendor?.email || '';

  // Load the real po_items lines whenever a PO is selected.
  React.useEffect(() => {
    if (sel?.id) void loadPurchaseOrderLines(sel.id);
  }, [sel?.id, loadPurchaseOrderLines]);

  const lines = (sel && poLinesById[sel.id]) || [];
  const subtotal = lines.reduce((s, li) => s + li.orderedQty * li.costPerUnit, 0);

  const counts: Record<'all' | PoStatus, number> = {
    all: allOrders.length,
    draft: allOrders.filter((o) => normalizeStatus(o.status) === 'draft').length,
    sent: allOrders.filter((o) => normalizeStatus(o.status) === 'sent').length,
    partial: allOrders.filter((o) => normalizeStatus(o.status) === 'partial').length,
    received: allOrders.filter((o) => normalizeStatus(o.status) === 'received').length,
    cancelled: allOrders.filter((o) => normalizeStatus(o.status) === 'cancelled').length,
  };

  const statusLabelFor = (status: PoStatus): string =>
    T(`section.purchaseOrders.status.${status}`);

  // ─── Lifecycle action handlers (confirm-gated per spec 107) ────────────
  const onSendEmail = () => {
    if (!sel || busy) return;
    confirmAction(
      T('section.purchaseOrders.sendConfirmTitle'),
      T('section.purchaseOrders.sendConfirmBody', { vendor: sel.vendorName, email: vendorEmail }),
      () => {
        setBusy(true);
        void sendPurchaseOrderEmail(sel.id)
          .then((ok) => {
            if (ok) Toast.show({ type: 'success', text1: T('section.purchaseOrders.sentToast') });
          })
          .finally(() => setBusy(false));
      },
      T('section.purchaseOrders.sendConfirmCta'),
    );
  };

  // Shared by onMarkSent + onShare's did-you-send prompt (code-review dedup):
  // the busy-guarded mark-sent write + success toast.
  const runMarkSent = (poId: string) => {
    setBusy(true);
    void markPurchaseOrderSentManually(poId)
      .then((ok) => {
        if (ok) Toast.show({ type: 'success', text1: T('section.purchaseOrders.markedSentToast') });
      })
      .finally(() => setBusy(false));
  };

  const onMarkSent = () => {
    if (!sel || busy) return;
    confirmAction(
      T('section.purchaseOrders.markSentConfirmTitle'),
      T('section.purchaseOrders.markSentConfirmBody', { vendor: sel.vendorName }),
      () => runMarkSent(sel.id),
      T('section.purchaseOrders.markSentConfirmCta'),
    );
  };

  const onCancel = () => {
    if (!sel || busy) return;
    confirmAction(
      T('section.purchaseOrders.cancelConfirmTitle'),
      T('section.purchaseOrders.cancelConfirmBody', { vendor: sel.vendorName }),
      () => {
        setBusy(true);
        void cancelPurchaseOrder(sel.id)
          .then((status) => {
            if (status) Toast.show({ type: 'success', text1: T('section.purchaseOrders.cancelledToast') });
          })
          .finally(() => setBusy(false));
      },
      T('section.purchaseOrders.cancelConfirmCta'),
    );
  };

  const onCloseShort = () => {
    if (!sel || busy) return;
    confirmAction(
      T('section.purchaseOrders.closeShortConfirmTitle'),
      T('section.purchaseOrders.closeShortConfirmBody', { vendor: sel.vendorName }),
      () => {
        setBusy(true);
        void closeShortPurchaseOrder(sel.id)
          .then((status) => {
            if (status) Toast.show({ type: 'success', text1: T('section.purchaseOrders.closedShortToast') });
          })
          .finally(() => setBusy(false));
      },
      T('section.purchaseOrders.closeShortConfirmCta'),
    );
  };

  // ─── Spec 108 — Share PO (text message / WeChat) ──────────────────────
  const onShare = async () => {
    if (!sel || busy) return;
    const poLines = poLinesById[sel.id] || [];
    // Resolve each line's name in the CURRENT app locale against the inventory
    // row's i18nNames (OQ-2). The PoLine only carries a plain-English itemName,
    // so we re-resolve against `inventory`; the itemName is the last-resort
    // fallback when no inventory row is found.
    const resolveName: NameResolver = (itemId, fallbackName) => {
      const row = inventory.find((i) => i.id === itemId);
      return row ? getLocalizedName({ name: row.name, i18nNames: row.i18nNames }, locale) : fallbackName;
    };
    const text = buildPoShareText(
      {
        storeName: currentStore.name,
        referenceDate: (sel.date || '').slice(0, 10),
        lines: poLines.map((l) => ({ itemId: l.itemId, itemName: l.itemName, orderedQty: l.orderedQty, unit: l.unit })),
      },
      {
        header: T('section.purchaseOrders.shareBodyHeader'),
        storeLabel: T('section.purchaseOrders.shareBodyStoreLabel'),
        dateLabel: T('section.purchaseOrders.shareBodyDateLabel'),
        itemsCount: T('section.purchaseOrders.shareBodyItemsCount', { count: poLines.length }),
        noItems: T('section.purchaseOrders.shareBodyNoItems'),
      },
      resolveName,
    );
    const { previewText, shared } = await sharePurchaseOrder(text, {
      dialogTitle: T('section.purchaseOrders.shareDialogTitle'),
      onCopyToast: () => Toast.show({ type: 'success', text1: T('section.purchaseOrders.copiedToast') }),
    });
    setSharePreview(previewText);
    // Auto-prompt ONLY on a draft, ONLY after a completed share/copy. Sent/
    // partial re-share is a reminder with no status change and no prompt.
    if (shared && selStatus === 'draft') {
      confirmAction(
        T('section.purchaseOrders.didYouSendTitle'),
        T('section.purchaseOrders.didYouSendBody', { vendor: sel.vendorName }),
        () => runMarkSent(sel.id),
        T('section.purchaseOrders.didYouSendCta'),
      );
    }
  };

  // ─── Spec 114 — Quick-order list (paste-ready <code>\t<qty> block) ─────
  // A SECOND, distinct Share artifact next to spec 108's human-readable Share.
  // Resolves each PO line's order code for the PO's vendor (sel.vendorId) from
  // the hydrated `inventory` rows — the SAME source onShare reads for names —
  // then hands the bare code+qty block to the EXISTING sharePurchaseOrder
  // orchestrator (verbatim: native sheet / navigator.share / desktop clipboard
  // + preview). DELIBERATE DIVERGENCE from onShare (D-8): this path does NOT
  // fire the draft "did you send it?" mark-sent prompt — it is a copy-the-codes
  // aid, not a send, so flipping status off a paste-to-clipboard would be a
  // surprise. Unmapped lines are surfaced (warning toast + the `???` lines in
  // the preview), never silently dropped (AC-9).
  const onShareQuickOrder = async () => {
    if (!sel || busy) return;
    const poLines = poLinesById[sel.id] || [];
    // Order code for (this line's item, the PO's vendor). null/'' → unmapped.
    const resolveCode = (itemId: string): string | null | undefined => {
      const row = inventory.find((i) => i.id === itemId);
      return row?.vendors?.find((v) => v.vendorId === sel.vendorId)?.orderCode;
    };
    // Same current-locale name resolver onShare uses — only reached on the
    // `??? <name>` placeholder path (OQ-8).
    const resolveName: NameResolver = (itemId, fallbackName) => {
      const row = inventory.find((i) => i.id === itemId);
      return row ? getLocalizedName({ name: row.name, i18nNames: row.i18nNames }, locale) : fallbackName;
    };
    const { text, unmappedCount } = buildPoQuickOrderText(
      poLines.map((l) => ({ itemId: l.itemId, itemName: l.itemName, orderedQty: l.orderedQty })),
      resolveCode,
      resolveName,
    );
    const { previewText } = await sharePurchaseOrder(text, {
      dialogTitle: T('section.purchaseOrders.quickOrderDialogTitle'),
      onCopyToast: () => Toast.show({ type: 'success', text1: T('section.purchaseOrders.quickOrderCopiedToast') }),
    });
    setSharePreview(previewText);
    // Surface the gap count (toast) in addition to the inline `???` lines in
    // the preview. No mark-sent prompt on this path (see the divergence note).
    if (unmappedCount > 0) {
      Toast.show({
        type: 'error',
        text1: T('section.purchaseOrders.quickOrderUnmappedWarning', { count: unmappedCount }),
        position: 'bottom',
      });
    }
  };

  // Which actions are available given the current status (spec 107 §3 guards).
  const canSend = selStatus === 'draft';           // draft → sent (email or manual)
  const canCancel = ['draft', 'sent', 'partial'].includes(selStatus);
  const canCloseShort = selStatus === 'partial';
  const isDraft = selStatus === 'draft';
  // Spec 108 — Share on draft + sent + partial; received/cancelled show none.
  const canShare = ['draft', 'sent', 'partial'].includes(selStatus);

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
        <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: C.border, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <Text style={[Type.h2, { color: C.fg }]}>{T('section.purchaseOrders.title')}</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {T('section.purchaseOrders.totalCount', { count: allOrders.length })}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {(['all', ...PO_STATUSES] as const).map((k) => {
              const n = counts[k];
              const isSel = statusFilter === k;
              const label = k === 'all' ? T('section.purchaseOrders.filterAll') : statusLabelFor(k);
              return (
                <TouchableOpacity
                  key={k}
                  testID={`po-filter-${k}`}
                  onPress={() => setStatusFilter(k)}
                  style={{
                    flexDirection: 'row',
                    gap: 5,
                    alignItems: 'center',
                    paddingHorizontal: 9,
                    paddingVertical: 4,
                    borderRadius: 99,
                    borderWidth: 1,
                    borderColor: isSel ? C.accent : C.border,
                    backgroundColor: isSel ? C.accentBg : C.panel2,
                  }}
                >
                  <Text style={{ fontFamily: mono(600), fontSize: 10.5, color: isSel ? C.fg : C.fg2 }}>{label}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{n}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
        <FlatList
          data={filtered}
          keyExtractor={(o) => o.id}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {allOrders.length === 0 ? T('section.purchaseOrders.noOrdersSubmitted') : T('section.purchaseOrders.noOrdersMatching')}
            </Text>
          }
          renderItem={({ item: o }) => {
            const isSel = o.id === selectedId;
            const status = normalizeStatus(o.status);
            return (
              <TouchableOpacity
                testID={`po-list-${o.id}`}
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
                  <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg }}>{shortId(o.id)}</Text>
                  <StatusPill status={pillTone(status)} label={statusLabelFor(status)} />
                </View>
                <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg }} numberOfLines={1}>
                  {o.vendorName}
                </Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    {o.day}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    {(o.date || '').slice(0, 10)}
                  </Text>
                </View>
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
              {allOrders.length === 0
                ? T('section.purchaseOrders.noSubmitted')
                : T('section.purchaseOrders.selectOrder')}
            </Text>
          </View>
        ) : (
          <>
            <TabStrip
              tabs={[
                { id: 'order.tsx',    label: 'order.tsx' },
                { id: 'docs.tsx',     label: 'docs.tsx' },
                { id: 'history.tsx',  label: 'history.tsx' },
              ]}
              activeId={tabId}
              onChange={setTabId}
              rightSlot={
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  {/* Spec 108 — Share is the PRIMARY (accent) action, first in the row. */}
                  {canShare ? (
                    <TouchableOpacity
                      testID="po-action-share"
                      onPress={onShare}
                      disabled={busy}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm, opacity: busy ? 0.5 : 1 }}
                    >
                      <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.accentFg }}>{T('section.purchaseOrders.shareAction')}</Text>
                    </TouchableOpacity>
                  ) : null}
                  {/* Spec 114 — Quick-order list: a SECOND, distinct artifact
                      (bare code+qty paste block). Outlined secondary treatment
                      so it's visually + textually distinct from the accent
                      human-readable Share it sits beside. Same status gate. */}
                  {canShare ? (
                    <TouchableOpacity
                      testID="po-action-quick-order"
                      onPress={onShareQuickOrder}
                      disabled={busy}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm, opacity: busy ? 0.5 : 1 }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.purchaseOrders.quickOrderAction')}</Text>
                    </TouchableOpacity>
                  ) : null}
                  {/* Spec 108 — email SEND demoted from accent to outlined secondary. */}
                  {canSend && vendorEmail ? (
                    <TouchableOpacity
                      testID="po-action-send"
                      onPress={onSendEmail}
                      disabled={busy}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm, opacity: busy ? 0.5 : 1 }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.purchaseOrders.sendAction')}</Text>
                    </TouchableOpacity>
                  ) : null}
                  {canSend ? (
                    <TouchableOpacity
                      testID="po-action-mark-sent"
                      onPress={onMarkSent}
                      disabled={busy}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm, opacity: busy ? 0.5 : 1 }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.purchaseOrders.markSentAction')}</Text>
                    </TouchableOpacity>
                  ) : null}
                  {canCloseShort ? (
                    <TouchableOpacity
                      testID="po-action-close-short"
                      onPress={onCloseShort}
                      disabled={busy}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm, opacity: busy ? 0.5 : 1 }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.purchaseOrders.closeShortAction')}</Text>
                    </TouchableOpacity>
                  ) : null}
                  {canCancel ? (
                    <TouchableOpacity
                      testID="po-action-cancel"
                      onPress={onCancel}
                      disabled={busy}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.sm, opacity: busy ? 0.5 : 1 }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.danger }}>{T('section.purchaseOrders.cancelAction')}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              }
            />
            {tabId === 'history.tsx' ? (
              <POHistoryTab />
            ) : tabId === 'docs.tsx' ? (
              <PODocsPlaceholder />
            ) : (
            <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.id)}</Text>
                  <StatusPill status={pillTone(selStatus)} label={statusLabelFor(selStatus)} />
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                    {T('section.purchaseOrders.datePrefix', { date: (sel.date || '').slice(0, 10) })}
                  </Text>
                </View>
                <Text style={[Type.h1, { color: C.fg }]}>
                  {T('section.purchaseOrders.vendorLines', { vendor: sel.vendorName, count: lines.length })}
                </Text>
                {/* Spec 108 — no vendor email: nudge toward Share (the primary path). */}
                {canSend && !vendorEmail ? (
                  <Text testID="po-no-email-hint" style={{ fontFamily: sans(400), fontSize: 12.5, color: C.warn }}>
                    {T('section.purchaseOrders.noEmailShareHint')}
                  </Text>
                ) : null}
              </View>

              {/* Spec 108 (D-3) — desktop-web share preview (clipboard fallback). */}
              {sharePreview != null ? (
                <View
                  testID="po-share-preview"
                  style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 8 }}
                >
                  <SectionCaption tone="fg3" size={10.5}>{T('section.purchaseOrders.sharePreviewLabel')}</SectionCaption>
                  <Text selectable style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, lineHeight: 17 }}>
                    {sharePreview}
                  </Text>
                </View>
              ) : null}

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <StatCard label={T('section.purchaseOrders.linesCard')} value={String(lines.length)} sub={T('section.purchaseOrders.fromPoItems')} />
                <StatCard label={T('section.purchaseOrders.orderTotal')} value={`$${subtotal.toFixed(2)}`} sub={T('section.purchaseOrders.snapshotCost')} />
                <StatCard label={T('section.purchaseOrders.statusCard')} value={statusLabelFor(selStatus).toUpperCase()} sub={T(`section.purchaseOrders.statusSub.${selStatus}`)} />
                <StatCard label={T('section.purchaseOrders.delivery')} value={(sel.day || '').slice(0, 3) || '—'} sub={(sel.date || '').slice(0, 10) || '—'} />
              </View>

              <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
                  <SectionCaption tone="fg3" size={10.5}>{T('section.purchaseOrders.orderLinesTsv')}</SectionCaption>
                  <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                    {isDraft ? T('section.purchaseOrders.editableHint') : T('section.purchaseOrders.itemsCount', { count: lines.length })}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{T('section.purchaseOrders.nameCol')}</Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 100, textAlign: 'right' }}>{T('section.purchaseOrders.orderedCol')}</Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.purchaseOrders.receivedCol')}</Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.purchaseOrders.unitCol')}</Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.purchaseOrders.lineCol')}</Text>
                  {isDraft ? <View style={{ width: 28 }} /> : null}
                </View>
                {lines.length === 0 ? (
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
                    {T('section.purchaseOrders.noLineItems')}
                  </Text>
                ) : (
                  <>
                    {lines.map((li, i) => (
                      <View
                        key={li.poItemId}
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
                        <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>
                          {li.itemName}
                        </Text>
                        {isDraft ? (
                          <TextInput
                            testID={`po-line-qty-${li.poItemId}`}
                            defaultValue={String(li.orderedQty)}
                            keyboardType="numeric"
                            onEndEditing={(e) => {
                              const raw = e.nativeEvent.text.trim();
                              const n = Number(raw);
                              if (!Number.isFinite(n) || n < 0 || n === li.orderedQty) return;
                              void updatePoLineQty(sel.id, li.poItemId, n);
                            }}
                            style={{
                              fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 100, textAlign: 'right',
                              borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.xs,
                              paddingVertical: 3, paddingHorizontal: 6,
                            }}
                          />
                        ) : (
                          <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 100, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                            {li.orderedQty} {li.unit}
                          </Text>
                        )}
                        <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: li.receivedQty > 0 ? C.fg : C.fg3, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          {li.receivedQty > 0 ? `${li.receivedQty} ${li.unit}` : '—'}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          ${li.costPerUnit.toFixed(2)}
                        </Text>
                        <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          ${(li.orderedQty * li.costPerUnit).toFixed(2)}
                        </Text>
                        {isDraft ? (
                          <TouchableOpacity
                            testID={`po-line-delete-${li.poItemId}`}
                            onPress={() => removePoLine(sel.id, li.poItemId)}
                            style={{ width: 28, alignItems: 'center' }}
                            accessibilityLabel={T('section.purchaseOrders.removeLineAria', { item: li.itemName })}
                          >
                            <Text style={{ fontFamily: mono(700), fontSize: 13, color: C.danger }}>×</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    ))}
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        padding: 14,
                        gap: 10,
                        borderTopWidth: 1,
                        borderTopColor: C.borderStrong,
                        backgroundColor: C.panel2,
                      }}
                    >
                      <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>
                        {T('section.purchaseOrders.subtotalRow', { count: lines.length })}
                      </Text>
                      <View style={{ width: 100 }} />
                      <View style={{ width: 90 }} />
                      <View style={{ width: 80 }} />
                      <Text style={{ fontFamily: mono(700), fontSize: 13, color: C.fg, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                        ${subtotal.toFixed(2)}
                      </Text>
                      {isDraft ? <View style={{ width: 28 }} /> : null}
                    </View>
                  </>
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

// ─── history.tsx — vendor PO lifecycle log ────────────────────────────
export function POHistoryTab({ vendorIdFilter }: { vendorIdFilter?: string } = {}) {
  const C = useCmdColors();
  const T = useT();
  const orderSubmissions = useStore((s) => s.orderSubmissions) as PoRow[];
  const vendors = useStore((s) => s.vendors);
  const currentStore = useStore((s) => s.currentStore);

  const orders = React.useMemo(() => {
    return orderSubmissions
      .filter((o) => o.storeId === currentStore.id)
      .filter((o) => !vendorIdFilter || o.vendorId === vendorIdFilter)
      .slice()
      .sort((a, b) => ((a.timestamp || a.date) < (b.timestamp || b.date) ? 1 : -1));
  }, [orderSubmissions, currentStore.id, vendorIdFilter]);

  const totalSent = orders.length;
  const received = orders.filter((o) => normalizeStatus(o.status) === 'received').length;
  const fillPct = totalSent === 0 ? 0 : Math.round((received * 100) / totalSent);
  const totalSpend = orders.reduce((s, o) => s + (o.totalCost || 0), 0);
  const vendorName = vendorIdFilter ? vendors.find((v) => v.id === vendorIdFilter)?.name : null;

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{vendorName ? T('section.purchaseOrders.vendorOrders', { vendor: vendorName }) : T('section.purchaseOrders.historyTitle')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.purchaseOrders.historySubtitle')}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label={T('section.purchaseOrders.ordersCard')} value={String(totalSent)} sub={vendorName ? T('section.purchaseOrders.thisVendor') : T('section.purchaseOrders.allVendors')} />
        <StatCard label={T('section.purchaseOrders.receivedCard')} value={String(received)} sub={T('section.purchaseOrders.fillPct', { pct: fillPct })} />
        <StatCard label={T('section.purchaseOrders.spend')} value={`$${totalSpend.toFixed(0)}`} sub={T('section.purchaseOrders.acrossOrders')} />
        <StatCard label={T('section.purchaseOrders.lastSent')} value={(orders[0]?.timestamp || orders[0]?.date || '').slice(5, 10) || '—'} sub={orders[0]?.day || '—'} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>{T('section.purchaseOrders.historyLog')}</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{orders.length}</Text>
        </View>
        {orders.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            {vendorName ? T('section.purchaseOrders.noOrdersForVendor', { vendor: vendorName }) : T('section.purchaseOrders.noOrdersYet')}
          </Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 110 }}>{T('section.purchaseOrders.sentCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{T('section.purchaseOrders.vendorCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90 }}>{T('section.purchaseOrders.dayCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.purchaseOrders.totalCol')}</Text>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.purchaseOrders.stateCol')}</Text>
            </View>
            {orders.map((o, i) => {
              const status = normalizeStatus(o.status);
              const tone = status === 'received' ? C.ok : status === 'cancelled' ? C.danger : status === 'partial' ? C.warn : C.info;
              const bg   = status === 'received' ? C.okBg : status === 'cancelled' ? C.dangerBg : status === 'partial' ? C.warnBg : C.infoBg;
              return (
                <View key={o.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border }}>
                  <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 110 }}>
                    {(o.timestamp || o.date || '').slice(0, 10)}
                  </Text>
                  <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg, flex: 1 }} numberOfLines={1}>{o.vendorName}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, width: 90 }}>{o.day}</Text>
                  <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    ${(o.totalCost || 0).toFixed(0)}
                  </Text>
                  <View style={{ width: 90, alignItems: 'flex-end' }}>
                    <View style={{ borderWidth: 1, borderColor: tone, borderRadius: CmdRadius.xs, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: bg }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: tone, letterSpacing: 0.4 }}>{status.toUpperCase()}</Text>
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

// ─── docs.tsx — Tier 2 placeholder ────────────────────────────────────
function PODocsPlaceholder() {
  const C = useCmdColors();
  const T = useT();
  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.purchaseOrders.docsTitle')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.purchaseOrders.docsSubtitle')}
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>{T('section.purchaseOrders.notYetWired')}</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          {T('section.purchaseOrders.docsNotWiredBody')}
        </Text>
      </View>
    </ScrollView>
  );
}

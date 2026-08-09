// src/screens/cmd/sections/phone/PhoneApproveOrder.tsx — Spec 149 (§B / §7.4).
//
// The phone Approve Order review screen. Reached ONLY by tapping an
// `order_ready` notification row in the phone sheet, which writes an
// `orderApproval: { submissionId, storeId }` payload into the usePaletteAction
// bridge; ReorderSection's phone fork (guard placed AFTER all hooks) swaps this
// screen in for `PhoneOrdering` while that payload is pending. Desktop and
// tablet never set the payload, so their render output is byte-unchanged
// (AC-REG-2) — there is NO desktop Approve Order surface in this spec.
//
// Everything on screen is SERVER-computed: the suggested lines come from the
// already-loaded `report_reorder_list` payload (AC-8 — no forked reorder math,
// no client re-derivation of suggestions), the vendor's channel is resolved
// server-side by `create_order_approval`, and the approval row is the audit
// trail. The screen only overlays the per-session `reorderEdits` buffer.
//
// Component reuse (AC-9 / AC-REG-1 / §9): `VendorOrderCard` + `LineStepper` are
// IMPORTED from PhoneOrdering (exported there, not forked), rendered with the
// additive `footer='none'` prop because AC-11 allows exactly ONE primary button
// here. `applyReorderEdits` comes from ReorderSection; `formatMoney`/`formatQty`
// from reorderExport; the case⇄base conversions from the spec-134 helpers.
//
// Hard Rules honored (AC-12): full vendor + item names (flex:1, ellipsize only
// past the full width), no horizontal scroll, every tappable ≥44×44 (the
// primary is 48), both themes via `useCmdColors()` tokens only.

import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore, notifyBackendError } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { usePaletteAction } from '../../../../lib/paletteAction';
import { formatMoney, formatQty } from '../../../../utils/reorderExport';
import { isCaseRow, poOrderedToCases } from '../../../../utils/poCaseDisplay';
import { applyReorderEdits } from '../ReorderSection';
import { VendorOrderCard } from './PhoneOrdering';
import { resolveOrderChannel, type OrderChannel } from '../../../../utils/orderChannel';
import { openExternalUrl } from '../../../../utils/openExternalUrl';
import type { OrderApprovalStatus } from '../../../../lib/db';
import type { ReorderVendor } from '../../../../types';

// ── Screen state (AC-13) ─────────────────────────────────────────────────────
// PURE + total, exported for jest. Each value maps to distinct copy and a
// disabled-or-relabeled primary button — the screen NEVER silently approves a
// stale set of lines.
//
// Precedence, most-terminal first:
//   ordered      — already actioned end-to-end (R-6 / AC-20). Nothing to do.
//   approved     — the row exists at `approved`; re-approval is REFUSED
//                  server-side, so the screen offers RE-OPEN LINK / MARK ORDERED.
//   empty        — the vendor carries no orderable line (absent from the
//                  reorder payload, or every suggestion netted to zero).
//   countChanged — the EOD count was re-submitted AFTER the notification fired,
//                  so these lines may no longer be what the count implies.
//   ready        — approve away.
export type ApproveOrderState = 'ordered' | 'approved' | 'empty' | 'countChanged' | 'ready';

export function approveOrderState(args: {
  hasOrderableLines: boolean;
  approvalStatus: OrderApprovalStatus | null;
  eodSubmittedAt: string | null;
  notificationCreatedAt: string | null;
}): ApproveOrderState {
  if (args.approvalStatus === 'ordered') return 'ordered';
  if (args.approvalStatus === 'approved') return 'approved';
  if (!args.hasOrderableLines) return 'empty';
  if (args.eodSubmittedAt && args.notificationCreatedAt) {
    const submitted = new Date(args.eodSubmittedAt).getTime();
    const notified = new Date(args.notificationCreatedAt).getTime();
    if (Number.isFinite(submitted) && Number.isFinite(notified) && submitted > notified) {
      return 'countChanged';
    }
  }
  return 'ready';
}

/** Spec 149 AC-10 / spec 155 AC-11 — the disclosure is honest PER CHANNEL and is
 *  a first-class block, not a tooltip.
 *
 *  Instacart yields TWO lines, in this order and no other:
 *    1. the markup + fees warning that labels the on-screen number as catalog
 *       cost (spec 149);
 *    2. the store-picker line (spec 155 DG-1) — the minted IDP link has no
 *       retailer-pinning parameter, so it opens Instacart's shopping-list page
 *       and the admin picks the store there. Without this line the screen
 *       promises a pre-selected retailer it cannot deliver.
 *
 *  Every other channel yields exactly the catalog-cost line — byte-unchanged
 *  from spec 149. ORDER IS PART OF THE CONTRACT.
 *
 *  Spec 155 REPLACED the single-string `disclosureKeyForChannel`; there is
 *  deliberately no sibling helper, because two sources of truth for the same
 *  disclosure is exactly the drift this project keeps paying for. */
export function disclosureKeysForChannel(channel: OrderChannel): string[] {
  return channel === 'instacart'
    ? ['section.approveOrder.disclosureInstacart', 'section.approveOrder.instacartPicker']
    : ['section.approveOrder.disclosureCatalog'];
}

// ── Screen ───────────────────────────────────────────────────────────────────
export const PhoneApproveOrder: React.FC<{
  request: { submissionId: string; storeId: string };
}> = ({ request }) => {
  const C = useCmdColors();
  const T = useT();

  const currentStore = useStore((s) => s.currentStore);
  const stores = useStore((s) => s.stores);
  const setCurrentStore = useStore((s) => s.setCurrentStore);
  const reorderPayload = useStore((s) => s.reorderPayload);
  const reorderLoading = useStore((s) => s.reorderLoading);
  const reorderEdits = useStore((s) => s.reorderEdits);
  const inventory = useStore((s) => s.inventory);
  const vendorsSlice = useStore((s) => s.vendors);
  const loadReorderSuggestions = useStore((s) => s.loadReorderSuggestions);
  const notifications = useStore((s) => s.submissionNotifications);

  const approvalContext = useStore((s) => s.approvalContext);
  const approval = useStore((s) => s.approval);
  const approvalLoading = useStore((s) => s.approvalLoading);
  const approvalError = useStore((s) => s.approvalError);
  const approvalBusy = useStore((s) => s.approvalBusy);
  const loadOrderApproval = useStore((s) => s.loadOrderApproval);
  const approveAndOrder = useStore((s) => s.approveAndOrder);
  const markOrderApprovalOrdered = useStore((s) => s.markOrderApprovalOrdered);
  const clearOrderApproval = useStore((s) => s.clearOrderApproval);

  // Local: whether the LAST approve attempt failed, so the screen can render
  // the honest "nothing was ordered" line beside the toast the store fired.
  const [lastAttemptFailed, setLastAttemptFailed] = React.useState(false);

  // Resolve the deep link (submission → store/vendor/date → any existing
  // approval). Re-runs only when the notification changes.
  React.useEffect(() => {
    void loadOrderApproval(request);
  }, [request.submissionId, request.storeId, loadOrderApproval]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop the slice when the screen unmounts so a later deep link starts clean.
  React.useEffect(() => () => clearOrderApproval(), [clearOrderApproval]);

  const sameStore = !!approvalContext && approvalContext.storeId === currentStore?.id;

  // §8 store/date alignment. The screen reads the SHARED `reorderPayload`, so a
  // cross-store tap must switch stores explicitly (a super_admin can see
  // another brand's `order_ready`) rather than silently mixing two stores'
  // data through the vendor-keyed edit buffer. Same store, different as-of
  // date ⇒ re-run the existing loader for the business date.
  const asOfDate = reorderPayload?.asOfDate ? reorderPayload.asOfDate.slice(0, 10) : null;
  React.useEffect(() => {
    if (!approvalContext || !sameStore) return;
    if (asOfDate && asOfDate === approvalContext.businessDate) return;
    if (reorderLoading) return;
    void loadReorderSuggestions(approvalContext.businessDate);
  }, [approvalContext, sameStore, asOfDate, reorderLoading, loadReorderSuggestions]);

  const subUnitSizeFor = React.useCallback(
    (itemId: string) => inventory.find((i) => i.id === itemId)?.subUnitSize ?? 1,
    [inventory],
  );

  // The ONE vendor this screen is scoped to, with the per-session edit buffer
  // overlaid exactly as PhoneOrdering / desktop do.
  const vendor: ReorderVendor | null = React.useMemo(() => {
    if (!approvalContext) return null;
    const raw = (reorderPayload?.vendors || []).find(
      (v) => v.vendorId === approvalContext.vendorId,
    );
    if (!raw) return null;
    return applyReorderEdits(raw, reorderEdits[raw.vendorId], subUnitSizeFor);
  }, [approvalContext, reorderPayload?.vendors, reorderEdits, subUnitSizeFor]);

  // Displayed lines mirror VendorOrderCard's filter (below-par OR edited) so
  // the totals line and the card agree.
  const lines = React.useMemo(() => {
    if (!vendor) return [];
    const vEdits = reorderEdits[vendor.vendorId];
    return vendor.items.filter(
      (it) => it.suggestedUnits > 0 || (vEdits ? it.itemId in vEdits : false),
    );
  }, [vendor, reorderEdits]);

  const totals = React.useMemo(() => {
    let cases = 0;
    let est = 0;
    for (const it of lines) {
      cases += isCaseRow(it.caseQty)
        ? Math.round(poOrderedToCases(it.suggestedUnits, it.caseQty))
        : it.suggestedUnits;
      est += it.estimatedCost;
    }
    return { lineCount: lines.length, cases, est };
  }, [lines]);

  // The notification that opened this screen — its createdAt is the "was the
  // count re-submitted after the ping?" reference (AC-13).
  const notificationCreatedAt = React.useMemo(
    () =>
      notifications.find(
        (n) => n.type === 'order_ready' && n.sourceId === request.submissionId,
      )?.createdAt ?? null,
    [notifications, request.submissionId],
  );

  const orderableCount = React.useMemo(
    () => lines.filter((it) => it.suggestedUnits > 0).length,
    [lines],
  );

  const state = approveOrderState({
    hasOrderableLines: orderableCount > 0,
    approvalStatus: approval?.status ?? null,
    eodSubmittedAt: vendor?.eodSubmittedAt ?? null,
    notificationCreatedAt,
  });

  // Channel shown in the disclosure + the "orders via" chip: the persisted
  // approval's channel once one exists (the server is authoritative, including
  // after an OQ-2 fallback re-route), else the client mirror of the same
  // precedence so the disclosure is honest BEFORE the first approve.
  const vendorRow = approvalContext
    ? vendorsSlice.find((v) => v.id === approvalContext.vendorId)
    : undefined;
  const channel: OrderChannel =
    approval?.channel ??
    resolveChannelForDisplay(vendorRow);

  const targetStore = approvalContext
    ? stores.find((s) => s.id === approvalContext.storeId)
    : undefined;

  const dismiss = React.useCallback(() => {
    usePaletteAction.getState().consume();
  }, []);

  const onApprove = React.useCallback(() => {
    if (!vendor || approvalBusy) return;
    setLastAttemptFailed(false);
    void approveAndOrder(vendor).then((res) => setLastAttemptFailed(res === null));
  }, [vendor, approvalBusy, approveAndOrder]);

  const onReopenLink = React.useCallback(() => {
    const url = approval?.externalRef;
    if (url) openInNewContext(url);
  }, [approval?.externalRef]);

  // ── Chrome ────────────────────────────────────────────────────────────────
  const header = (
    <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10, gap: 4 }}>
      <Text style={[PhoneType.screenTitle, { color: C.fg }]}>
        {T('section.approveOrder.title')}
      </Text>
      <Text
        testID="phone-approve-subtitle"
        style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}
        numberOfLines={2}
      >
        {T('section.approveOrder.subtitle', {
          vendor: vendor?.vendorName || approvalContext?.vendorId || '—',
          date: approvalContext?.businessDate || '—',
        })}
      </Text>
      <Text
        testID="phone-approve-totals"
        style={{ fontFamily: mono(600), fontSize: 10.5, letterSpacing: 0.4, color: C.fg3 }}
        numberOfLines={1}
      >
        {T('section.approveOrder.totals', {
          lines: totals.lineCount,
          cases: formatQty(totals.cases),
          est: formatMoney(totals.est),
        })}
        {'  ·  '}
        {T('section.approveOrder.channelLabel')}{' '}
        {T(`section.approveOrder.channel.${channel}`)}
      </Text>
    </View>
  );

  const banner = (tone: 'warn' | 'ok' | 'violet', testID: string, text: string) => {
    const fg = tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : C.violet;
    const bg = tone === 'ok' ? C.okBg : tone === 'warn' ? C.warnBg : C.violetBg;
    return (
      <View
        testID={testID}
        style={{
          marginHorizontal: 16,
          marginBottom: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: CmdRadius.lg,
          borderWidth: 0.5,
          borderColor: fg,
          backgroundColor: bg,
        }}
      >
        <Text style={[PhoneType.body, { color: C.fg2 }]}>{text}</Text>
      </View>
    );
  };

  // ── Cross-store interstitial (§8 / risk 9) ────────────────────────────────
  // Do NOT "simplify" this away: without it a super_admin tapping another
  // brand's alert would read this store's reorder payload under that store's
  // vendor id.
  if (approvalContext && !sameStore) {
    return (
      <View testID="phone-approve-order" style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        {banner(
          'violet',
          'phone-approve-switch-store',
          T('section.approveOrder.switchStoreBody', {
            store: targetStore?.name || approvalContext.storeId,
          }),
        )}
        <View style={{ paddingHorizontal: 16, gap: 8 }}>
          <TouchableOpacity
            testID="phone-approve-switch-store-cta"
            onPress={() => {
              if (targetStore) setCurrentStore(targetStore);
            }}
            disabled={!targetStore}
            accessibilityRole="button"
            style={{
              height: 48,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: CmdRadius.sm,
              backgroundColor: C.accent,
              opacity: targetStore ? 1 : 0.5,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 11.5, letterSpacing: 0.8, color: C.accentFg }}>
              {T('section.approveOrder.switchStore', {
                store: targetStore?.name || '—',
              })}
            </Text>
          </TouchableOpacity>
          <DismissButton onPress={dismiss} label={T('section.approveOrder.dismissCta')} />
        </View>
      </View>
    );
  }

  // ── Load / error panes (in-screen, not a toast) ───────────────────────────
  if (approvalLoading || (!approvalContext && !approvalError)) {
    return (
      <View
        testID="phone-approve-loading"
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, letterSpacing: 0.4, color: C.fg3 }}>
          {T('section.approveOrder.loading')}
        </Text>
      </View>
    );
  }

  if (approvalError || !approvalContext) {
    return (
      <View testID="phone-approve-order" style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        <View testID="phone-approve-error" style={{ paddingHorizontal: 16, gap: 6 }}>
          <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.danger }}>
            {T('section.approveOrder.errorTitle')}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.danger }}>
            {approvalError || T('section.approveOrder.notFound')}
          </Text>
        </View>
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <DismissButton onPress={dismiss} label={T('section.approveOrder.dismissCta')} />
        </View>
      </View>
    );
  }

  // ── Primary action (AC-11 — exactly ONE) ──────────────────────────────────
  // ordered  → no primary at all (nothing left to do), dismiss only.
  // approved → MARK ORDERED is the primary; RE-OPEN LINK rides as a secondary
  //            only when a link actually exists (OQ-6).
  // empty / countChanged → APPROVE & ORDER is rendered DISABLED, never armed.
  const primaryDisabled = approvalBusy || state === 'empty' || state === 'countChanged';
  const primaryLabel =
    state === 'approved'
      ? T('section.approveOrder.markOrderedCta')
      : approvalBusy
        ? T('section.approveOrder.approveBusy')
        : T('section.approveOrder.approveCta');

  return (
    <View testID="phone-approve-order" style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView
        testID="phone-approve-scroll"
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {header}

        {state === 'ordered'
          ? banner('ok', 'phone-approve-already-ordered', T('section.approveOrder.alreadyOrdered'))
          : null}
        {state === 'approved'
          ? banner('ok', 'phone-approve-already-approved', T('section.approveOrder.alreadyApproved'))
          : null}
        {state === 'empty'
          ? banner('warn', 'phone-approve-empty', T('section.approveOrder.emptyOrder'))
          : null}
        {state === 'countChanged'
          ? banner('warn', 'phone-approve-count-changed', T('section.approveOrder.countChanged'))
          : null}
        {lastAttemptFailed
          ? banner('warn', 'phone-approve-link-failed', T('section.approveOrder.linkFailed'))
          : null}

        {vendor ? (
          <View style={{ paddingHorizontal: 16 }}>
            <VendorOrderCard
              vendor={vendor}
              vendorEdits={reorderEdits[vendor.vendorId]}
              subUnitSizeFor={subUnitSizeFor}
              collapsed={false}
              onToggle={() => { /* single-vendor screen — always expanded */ }}
              footer="none"
            />
          </View>
        ) : null}
      </ScrollView>

      {/* Footer — the fee/markup disclosure is a FIRST-CLASS block directly
          above the one primary button (AC-10), never a tooltip or a
          one-line caption. */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 16,
          gap: 10,
          borderTopWidth: 1,
          borderTopColor: C.border,
          backgroundColor: C.panel,
        }}
      >
        <View
          testID="phone-approve-disclosure"
          style={{
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            borderColor: C.border,
            backgroundColor: C.panel2,
            // Spec 155 — visually inert for the single-child (non-instacart)
            // case; separates the two instacart lines. No per-line testIDs:
            // they would mutate the non-instacart render tree AC-10 freezes.
            gap: 6,
          }}
        >
          {disclosureKeysForChannel(channel).map((k) => (
            <Text key={k} style={[PhoneType.body, { color: C.fg2 }]}>{T(k)}</Text>
          ))}
        </View>

        {state !== 'ordered' ? (
          <TouchableOpacity
            testID="phone-approve-primary"
            onPress={state === 'approved' ? () => void markOrderApprovalOrdered() : onApprove}
            disabled={primaryDisabled}
            accessibilityRole="button"
            accessibilityState={{ disabled: primaryDisabled, busy: approvalBusy }}
            accessibilityLabel={primaryLabel}
            style={{
              height: 48,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: CmdRadius.sm,
              backgroundColor: C.accent,
              opacity: primaryDisabled ? 0.5 : 1,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 11.5, letterSpacing: 0.8, color: C.accentFg }}>
              {primaryLabel}
            </Text>
          </TouchableOpacity>
        ) : null}

        {state === 'approved' && approval?.externalRef ? (
          <TouchableOpacity
            testID="phone-approve-reopen-link"
            onPress={onReopenLink}
            accessibilityRole="button"
            style={{
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: CmdRadius.sm,
              borderWidth: 1,
              borderColor: C.borderStrong,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 11, letterSpacing: 0.7, color: C.fg2 }}>
              {T('section.approveOrder.reopenLinkCta')}
            </Text>
          </TouchableOpacity>
        ) : null}

        <DismissButton onPress={dismiss} label={T('section.approveOrder.dismissCta')} />
      </View>
    </View>
  );
};

// ── Local bits ───────────────────────────────────────────────────────────────

// The single dismiss/back affordance (AC-11 allows at most one secondary).
// Consuming the palette action returns the phone to PhoneOrdering.
function DismissButton({ onPress, label }: { onPress: () => void; label: string }) {
  const C = useCmdColors();
  return (
    <TouchableOpacity
      testID="phone-approve-dismiss"
      onPress={onPress}
      accessibilityRole="button"
      style={{
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: CmdRadius.sm,
        borderWidth: 1,
        borderColor: C.border,
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 11, letterSpacing: 0.7, color: C.fg2 }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// Display-only channel resolution BEFORE an approval row exists, so the
// disclosure is honest on first paint. `create_order_approval` is still the
// authority once the row is written — this is the same eight-row precedence,
// mirrored in the pure util (spec 149 §7.2).
function resolveChannelForDisplay(
  v:
    | {
        orderChannel?: string | null;
        instacartRetailerKey?: string | null;
        extensionOrdering?: boolean;
      }
    | undefined,
): OrderChannel {
  return resolveOrderChannel({
    orderChannel: v?.orderChannel ?? null,
    instacartRetailerKey: v?.instacartRetailerKey ?? null,
    extensionOrdering: v?.extensionOrdering ?? false,
  });
}

// Open a stored cart link (OQ-6 re-open).
//
// Spec 149 review round — this used to be a near-duplicate of the store's
// `openExternalOrderUrl` that had drifted: no `.catch` on the native
// `Linking.openURL` promise (silent unhandled rejection) and no scheme check on
// `order_approvals.external_ref`, which is an operator-writable column. Both
// call sites now share `openExternalUrl` (http(s) allowlist + `noopener` on
// web + `.catch` → the store's `notifyBackendError` toast on native).
function openInNewContext(url: string) {
  openExternalUrl(url, 'Open order page', notifyBackendError);
}

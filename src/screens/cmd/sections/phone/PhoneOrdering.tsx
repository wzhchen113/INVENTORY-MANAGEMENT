// src/screens/cmd/sections/phone/PhoneOrdering.tsx — Spec (2026-07) phone Ordering.
//
// The phone tier of the Reorder / Ordering screen (design handoff README §3).
// A FLAT, full-width list of collapsible vendor cards — NOT the desktop
// needs/enough split, NOT the fixed-column vendor cards. Every desktop behavior
// is preserved by REUSING the same store slices + pure helpers:
//   - server-computed `reorderPayload` (report_reorder_list RPC), hydrated by the
//     parent ReorderSection's load effects (which still run before the isPhone
//     guard) — this component never re-fetches;
//   - the per-session inline order-qty buffer (`reorderEdits` / `setReorderEditQty`),
//     overlaid via `applyReorderEdits` exactly as desktop;
//   - `partitionReorderVendors` (day filter) + `isReorderCountNotSubmitted`
//     (spec 130 gating) + the spec-134 `poCaseDisplay` case⇄base conversions;
//   - the shared quick-order builder (`buildPoQuickOrderText` — NOT forked) and
//     the desktop CSV/PDF orchestrators (`handleCsvExport` / `handlePdfExport` /
//     `handleImportExport`, re-exported from ReorderSection);
//   - `fillCartForVendor` for the extension-vendor cart handoff.
//
// Hard Rules honored: full vendor + item names (flex:1, ellipsize only past the
// full width), no horizontal scroll, every tappable ≥44×44 (steppers 44 tall /
// ± ≥40 wide, ··· 48×48, primary 48), both themes via `useCmdColors()` tokens.

import React from 'react';
import { View, Text, TouchableOpacity, FlatList, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, sans, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { useLocale } from '../../../../hooks/useLocale';
import { usePaletteAction } from '../../../../lib/paletteAction';
import { confirmAction } from '../../../../utils/confirmAction';
import { formatMoney, formatQty } from '../../../../utils/reorderExport';
import {
  weekdayName,
  partitionReorderVendors,
  isReorderCountNotSubmitted,
} from '../../../../utils/reorderDayFilter';
import { isCaseRow, poOrderedToCases, poCasesToBase } from '../../../../utils/poCaseDisplay';
import { buildPoQuickOrderText, type NameResolver } from '../../../../utils/poQuickOrderText';
import { getLocalizedName } from '../../../../i18n/localizedName';
import { pickImportVendor } from '../../../../utils/vendorImportShared';
import { sharePurchaseOrder } from '../../lib/sharePo';
import { ResponsiveSheet } from '../../../../components/cmd/ResponsiveSheet';
import {
  applyReorderEdits,
  narrowReorderToVendor,
  handleCsvExport,
  handlePdfExport,
  handleImportExport,
} from '../ReorderSection';
import type { ReorderVendor, ReorderItem } from '../../../../types';

// ── Date formatting ──────────────────────────────────────────────────────────
// Parse a YYYY-MM-DD as a LOCAL date (avoid the `new Date('2026-07-27')`
// UTC-midnight day shift), then render "MON JUL 27" for the header chip.
function parseLocalIso(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}
function formatDateChip(iso: string): string {
  const d = parseLocalIso(iso);
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const mo = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  return `${wd} ${mo} ${d.getDate()}`;
}
function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type BadgeTone = 'ok' | 'warn' | 'violet';
interface StatusBadge { label: string; tone: BadgeTone; }

// ── Stepper ──────────────────────────────────────────────────────────────────
// 44px-tall group, ± ≥40px wide, center well 46px. Writes BASE units through
// `setReorderEditQty` (clamped ≥0) so cost/qty recompute exactly like desktop.
function LineStepper({
  qty,
  unitLabel,
  onDec,
  onInc,
  testIDPrefix,
}: {
  qty: number;
  unitLabel: string;
  onDec: () => void;
  onInc: () => void;
  testIDPrefix: string;
}) {
  const C = useCmdColors();
  return (
    <View
      style={{
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'stretch',
        height: 44,
        borderWidth: 1,
        borderColor: C.borderStrong,
        borderRadius: CmdRadius.sm,
        overflow: 'hidden',
      }}
    >
      <TouchableOpacity
        testID={`${testIDPrefix}-dec`}
        onPress={onDec}
        accessibilityRole="button"
        accessibilityLabel="Decrease"
        style={{ width: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: C.panel2 }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>−</Text>
      </TouchableOpacity>
      <View style={{ width: 46, alignItems: 'center', justifyContent: 'center', backgroundColor: C.panel }}>
        <Text style={[PhoneType.wellValue, { color: qty > 0 ? C.fg : C.fg3 }]}>{qty}</Text>
        <Text style={{ fontFamily: mono(600), fontSize: 8.5, letterSpacing: 0.6, color: C.fg3 }} numberOfLines={1}>
          {unitLabel}
        </Text>
      </View>
      <TouchableOpacity
        testID={`${testIDPrefix}-inc`}
        onPress={onInc}
        accessibilityRole="button"
        accessibilityLabel="Increase"
        style={{ width: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: C.panel2 }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Vendor card ──────────────────────────────────────────────────────────────
function VendorOrderCard({
  vendor,
  vendorEdits,
  subUnitSizeFor,
  collapsed,
  onToggle,
  onMore,
}: {
  vendor: ReorderVendor;
  vendorEdits: Record<string, number> | undefined;
  subUnitSizeFor: (itemId: string) => number;
  collapsed: boolean;
  onToggle: () => void;
  onMore: () => void;
}) {
  const C = useCmdColors();
  const T = useT();
  const setReorderEditQty = useStore((s) => s.setReorderEditQty);
  const fillCartForVendor = useStore((s) => s.fillCartForVendor);
  const vendorsSlice = useStore((s) => s.vendors);
  const [filled, setFilled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const notSubmitted = isReorderCountNotSubmitted(vendor);
  const extensionOrdering =
    vendorsSlice.find((v) => v.id === vendor.vendorId)?.extensionOrdering ?? false;

  // Displayed lines: below-par (or edited) items, mirroring the desktop filter
  // `suggested>0 || edited`. Untouched at-par rows (suggestedUnits 0, no edit)
  // are not shown — a manager orders what needs ordering.
  const lines = vendor.items.filter(
    (it) => it.suggestedUnits > 0 || (vendorEdits ? it.itemId in vendorEdits : false),
  );
  const totalCases = lines.reduce((acc, it) => acc + qtyOf(it), 0);
  const est = lines.reduce((acc, it) => acc + it.estimatedCost, 0);

  const badge = statusBadgeFor(vendor);
  const badgeColor = badge.tone === 'ok' ? C.ok : badge.tone === 'warn' ? C.warn : C.violet;
  const badgeBg = badge.tone === 'ok' ? C.okBg : badge.tone === 'warn' ? C.warnBg : C.violetBg;

  const daysLabel =
    vendor.daysUntilNextDelivery === 0
      ? 'today'
      : vendor.daysUntilNextDelivery === 1
        ? 'tomorrow'
        : `in ${vendor.daysUntilNextDelivery} days`;

  function qtyOf(item: ReorderItem): number {
    return isCaseRow(item.caseQty)
      ? Math.round(poOrderedToCases(item.suggestedUnits, item.caseQty))
      : item.suggestedUnits;
  }

  const goCount = () => {
    usePaletteAction.getState().request({
      section: 'EODCount',
      selectedName: null,
      eodFocusItemId: vendor.items[0]?.itemId,
    });
  };

  const onFillCart = () => {
    if (busy || filled) return;
    const vendorName = vendor.vendorName || 'this vendor';
    confirmAction(
      T('section.reorder.fillCartConfirmTitle'),
      T('section.reorder.fillCartConfirmBody', { vendor: vendorName, count: vendor.items.length }),
      () => {
        setBusy(true);
        void fillCartForVendor(vendor)
          .then((poId) => {
            if (poId) {
              setFilled(true);
              Toast.show({
                type: 'success',
                text1: T('section.reorder.fillCartToastTitle'),
                text2: T('section.reorder.fillCartToastBody', { vendor: vendorName }),
                visibilityTime: 4000,
              });
            }
          })
          .finally(() => setBusy(false));
      },
      T('section.reorder.fillCartConfirmCta'),
    );
  };

  return (
    <View
      testID={`phone-order-card-${vendor.vendorId}`}
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: notSubmitted ? C.violet : C.border,
        overflow: 'hidden',
      }}
    >
      {/* Header — chevron + name + status badge, next-delivery, stats. */}
      <View style={{ padding: 12, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TouchableOpacity
            testID={`phone-order-toggle-${vendor.vendorId}`}
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityState={{ expanded: !collapsed }}
            disabled={notSubmitted}
            style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 }}
          >
            {!notSubmitted ? (
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>{collapsed ? '▸' : '▾'}</Text>
            ) : null}
            <Text style={[PhoneType.itemName, { flex: 1, color: C.fg }]} numberOfLines={1}>
              {vendor.vendorName || 'unnamed vendor'}
            </Text>
          </TouchableOpacity>
          <View
            style={{
              flexShrink: 0,
              paddingHorizontal: 8,
              paddingVertical: 2.5,
              borderRadius: CmdRadius.pill,
              borderWidth: 0.5,
              borderColor: badgeColor,
              backgroundColor: badgeBg,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 9, letterSpacing: 0.5, color: badgeColor }} numberOfLines={1}>
              {badge.label}
            </Text>
          </View>
        </View>
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }} numberOfLines={1}>
          <Text style={{ color: C.fg3 }}>next delivery:</Text>{' '}
          <Text style={{ color: C.fg, fontWeight: '600' }}>{vendor.nextDeliveryDate || '—'}</Text>{' '}
          <Text style={{ color: C.fg3 }}>({daysLabel})</Text>
        </Text>
        <Text style={{ fontFamily: mono(600), fontSize: 10.5, letterSpacing: 0.4, color: C.fg3 }} numberOfLines={1}>
          {notSubmitted
            ? T('section.reorder.phoneItemsAffected', { count: vendor.items.length })
            : T('section.reorder.phoneCardStats', {
                lines: lines.length,
                cases: formatQty(totalCases),
                est: formatMoney(est),
              })}
        </Text>
      </View>

      {/* Count-not-submitted (spec 130) — violet block replaces body + footer. */}
      {notSubmitted ? (
        <View
          testID={`phone-order-not-submitted-${vendor.vendorId}`}
          style={{
            margin: 12,
            marginTop: 0,
            paddingHorizontal: 14,
            paddingVertical: 20,
            alignItems: 'center',
            gap: 8,
            borderRadius: CmdRadius.lg,
            borderWidth: 0.5,
            borderColor: C.violet,
            backgroundColor: C.violetBg,
          }}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 20, color: C.violet }}>⊘</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 10.5, letterSpacing: 0.6, color: C.violet }}>
            {T('section.reorder.countNotSubmittedTitle').toUpperCase()}
          </Text>
          <Text style={[PhoneType.body, { color: C.fg2, textAlign: 'center' }]}>
            {T('section.reorder.countNotSubmittedBody')}
          </Text>
          <TouchableOpacity
            testID={`phone-order-go-count-${vendor.vendorId}`}
            onPress={goCount}
            accessibilityRole="button"
            style={{
              marginTop: 4,
              height: 44,
              paddingHorizontal: 18,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: CmdRadius.sm,
              borderWidth: 1,
              borderColor: C.violet,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 11, letterSpacing: 0.7, color: C.violet }}>
              {T('section.reorder.phoneGoToEodCount')} →
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Body — line rows with steppers, hidden while collapsed. */}
          {!collapsed ? (
            <View style={{ borderTopWidth: 1, borderTopColor: C.border }}>
              {lines.map((item) => {
                const caseRow = isCaseRow(item.caseQty);
                const qty = qtyOf(item);
                const subUnitSize = subUnitSizeFor(item.itemId) || 1;
                const perUnit = item.costPerUnit * subUnitSize;
                const sub = caseRow
                  ? `case of ${formatQty(item.caseQty)} ${item.unit} · ${formatMoney(perUnit)}/${item.unit}`
                  : `${formatMoney(perUnit)}/${item.unit}`;
                return (
                  <View
                    key={item.itemId}
                    testID={`phone-order-line-${item.itemId}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingHorizontal: 14,
                      paddingVertical: 10,
                      borderBottomWidth: 1,
                      borderStyle: 'dashed',
                      borderBottomColor: C.border,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontFamily: sans(600), fontSize: 14.5, color: C.fg }} numberOfLines={1}>
                        {item.itemName}
                      </Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, marginTop: 2 }} numberOfLines={1}>
                        {sub}
                      </Text>
                    </View>
                    <LineStepper
                      testIDPrefix={`phone-order-step-${item.itemId}`}
                      qty={qty}
                      unitLabel={caseRow ? 'CS' : item.unit}
                      onDec={() => setReorderEditQty(vendor.vendorId, item.itemId, poCasesToBase(Math.max(0, qty - 1), item.caseQty))}
                      onInc={() => setReorderEditQty(vendor.vendorId, item.itemId, poCasesToBase(qty + 1, item.caseQty))}
                    />
                    <Text
                      testID={`phone-order-line-cost-${item.itemId}`}
                      style={{ flexShrink: 0, width: 62, textAlign: 'right', fontFamily: mono(400), fontSize: 11.5, color: qty > 0 ? C.fg2 : C.fg3, fontVariant: ['tabular-nums'] }}
                    >
                      {qty > 0 ? formatMoney(item.estimatedCost) : '—'}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* Footer — ··· overflow + one primary button. */}
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12 }}>
            <TouchableOpacity
              testID={`phone-order-more-${vendor.vendorId}`}
              onPress={onMore}
              accessibilityRole="button"
              accessibilityLabel={T('section.reorder.phoneSheetTitle', { vendor: vendor.vendorName || '' })}
              style={{
                flexShrink: 0,
                width: 48,
                height: 48,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: C.borderStrong,
                borderRadius: CmdRadius.sm,
              }}
            >
              <Text style={{ fontFamily: mono(400), fontSize: 16, letterSpacing: 1, color: C.fg2 }}>···</Text>
            </TouchableOpacity>
            {extensionOrdering ? (
              <TouchableOpacity
                testID={`phone-order-fill-cart-${vendor.vendorId}`}
                onPress={onFillCart}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={T('section.reorder.fillCartAria', { vendor: vendor.vendorName || '' })}
                style={{
                  flex: 1,
                  height: 48,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: CmdRadius.sm,
                  borderWidth: 1,
                  borderColor: filled ? C.ok : C.accent,
                  backgroundColor: filled ? C.okBg : C.accent,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 11.5, letterSpacing: 0.8, color: filled ? C.ok : C.accentFg }}>
                  {filled ? `${T('section.reorder.phoneCartFilled')} ✓` : `${T('section.reorder.fillCartLabel')} →`}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                testID={`phone-order-quick-primary-${vendor.vendorId}`}
                onPress={onMore}
                accessibilityRole="button"
                accessibilityLabel={T('section.reorder.quickOrderAria', { vendor: vendor.vendorName || '' })}
                style={{
                  flex: 1,
                  height: 48,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: CmdRadius.sm,
                  borderWidth: 1,
                  borderColor: C.accent,
                }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 11.5, letterSpacing: 0.8, color: C.accent }}>
                  {T('section.purchaseOrders.quickOrderAction')} ⧉
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </>
      )}
    </View>
  );
}

// Status badge (design §3): counted-today (ok) / EOD <date> (ok) / stock
// fallback (warn) / no count (violet).
function statusBadgeFor(vendor: ReorderVendor): StatusBadge {
  if (isReorderCountNotSubmitted(vendor)) return { label: 'NO COUNT', tone: 'violet' };
  if (vendor.onHandSource !== 'eod') return { label: 'STOCK FALLBACK', tone: 'warn' };
  const at = vendor.eodSubmittedAt ? new Date(vendor.eodSubmittedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return { label: 'COUNTED', tone: 'ok' };
  const p = (n: number) => String(n).padStart(2, '0');
  const iso = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  if (iso === todayIso()) return { label: 'COUNTED TODAY', tone: 'ok' };
  const mo = at.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  return { label: `EOD ${mo} ${at.getDate()}`, tone: 'ok' };
}

// ── Overflow action sheet ─────────────────────────────────────────────────────
function OverflowSheet({
  vendor,
  onClose,
}: {
  vendor: ReorderVendor;
  onClose: () => void;
}) {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const currentStore = useStore((s) => s.currentStore);
  const reorderPayload = useStore((s) => s.reorderPayload);
  const inventory = useStore((s) => s.inventory);
  const vendorsSlice = useStore((s) => s.vendors);
  const clearReorderEditsForVendor = useStore((s) => s.clearReorderEditsForVendor);

  const runQuickOrder = async () => {
    onClose();
    const orderUnit = vendorsSlice.find((v) => v.id === vendor.vendorId)?.orderUnit ?? 'case';
    const resolveCode = (itemId: string): string | null | undefined =>
      inventory.find((i) => i.id === itemId)?.vendors?.find((v) => v.vendorId === vendor.vendorId)?.orderCode;
    const resolveName: NameResolver = (itemId, fallbackName) => {
      const row = inventory.find((i) => i.id === itemId);
      return row ? getLocalizedName({ name: row.name, i18nNames: row.i18nNames }, locale) : fallbackName;
    };
    const { text, unmappedCount, roundedCount } = buildPoQuickOrderText(
      vendor.items.map((it) => ({ itemId: it.itemId, itemName: it.itemName, orderedQty: it.suggestedUnits, caseQty: it.caseQty })),
      resolveCode,
      resolveName,
      orderUnit,
    );
    const { shared } = await sharePurchaseOrder(text, {
      dialogTitle: T('section.purchaseOrders.quickOrderDialogTitle'),
      onCopyToast: () => Toast.show({ type: 'success', text1: T('section.purchaseOrders.quickOrderCopiedToast') }),
    });
    if (shared) clearReorderEditsForVendor(vendor.vendorId);
    if (unmappedCount > 0) {
      Toast.show({ type: 'error', text1: T('section.purchaseOrders.quickOrderUnmappedWarning', { count: unmappedCount }), position: 'bottom' });
    }
    if (roundedCount > 0) {
      Toast.show({ type: 'error', text1: T('section.purchaseOrders.quickOrderRoundedWarning', { count: roundedCount }), position: 'bottom' });
    }
  };

  const runCsv = async () => {
    onClose();
    if (Platform.OS !== 'web') {
      Toast.show({ type: 'info', text1: T('common.availableOnDesktop') });
      return;
    }
    if (!reorderPayload || !currentStore) return;
    const narrowed = narrowReorderToVendor(reorderPayload, vendor);
    const importCfg = pickImportVendor(narrowed, vendorsSlice);
    const ok = importCfg
      ? handleImportExport(narrowed, currentStore, importCfg, inventory)
      : await handleCsvExport(narrowed, currentStore, locale);
    if (ok) clearReorderEditsForVendor(vendor.vendorId);
  };

  const runPdf = async () => {
    onClose();
    if (Platform.OS !== 'web') {
      Toast.show({ type: 'info', text1: T('common.availableOnDesktop') });
      return;
    }
    if (!reorderPayload || !currentStore) return;
    const ok = await handlePdfExport(narrowReorderToVendor(reorderPayload, vendor), currentStore, locale);
    if (ok) clearReorderEditsForVendor(vendor.vendorId);
  };

  const runOrderSchedule = () => {
    onClose();
    Toast.show({ type: 'info', text1: T('section.reorder.phoneOrderScheduleToast') });
  };

  const actions: Array<{ glyph: string; label: string; onPress: () => void; testID: string }> = [
    { glyph: '⧉', label: T('section.purchaseOrders.quickOrderAction'), onPress: runQuickOrder, testID: 'phone-order-sheet-quick' },
    { glyph: '↓', label: T('section.reorder.phoneExportCsv'), onPress: runCsv, testID: 'phone-order-sheet-csv' },
    { glyph: '↓', label: T('section.reorder.phoneExportPdf'), onPress: runPdf, testID: 'phone-order-sheet-pdf' },
    { glyph: '☷', label: T('section.reorder.phoneOrderSchedule'), onPress: runOrderSchedule, testID: 'phone-order-sheet-schedule' },
  ];

  return (
    <ResponsiveSheet
      visible
      onClose={onClose}
      presentation={{ phone: 'bottom-sheet' }}
      accessibilityLabel={T('section.reorder.phoneSheetTitle', { vendor: vendor.vendorName || '' })}
    >
      <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, gap: 4 }}>
        <Text style={{ fontFamily: mono(600), fontSize: 10.5, letterSpacing: 0.9, color: C.fg3, paddingBottom: 8 }} numberOfLines={1}>
          {T('section.reorder.phoneSheetTitle', { vendor: vendor.vendorName || '' })}
        </Text>
        {actions.map((a) => (
          <TouchableOpacity
            key={a.testID}
            testID={a.testID}
            onPress={a.onPress}
            accessibilityRole="button"
            style={{ height: 52, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderStyle: 'dashed', borderBottomColor: C.border }}
          >
            <Text style={{ width: 20, textAlign: 'center', fontFamily: mono(400), fontSize: 14, color: C.fg2 }}>{a.glyph}</Text>
            <Text style={{ flex: 1, fontFamily: mono(600), fontSize: 12, letterSpacing: 0.5, color: C.fg }}>{a.label}</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 13, color: C.fg3 }}>›</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          testID="phone-order-sheet-cancel"
          onPress={onClose}
          accessibilityRole="button"
          style={{ marginTop: 8, height: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 11, letterSpacing: 0.7, color: C.fg2 }}>{T('common.cancel').toUpperCase()}</Text>
        </TouchableOpacity>
      </View>
    </ResponsiveSheet>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────
export const PhoneOrdering: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const currentStore = useStore((s) => s.currentStore);
  const orderSchedule = useStore((s) => s.orderSchedule);
  const reorderPayload = useStore((s) => s.reorderPayload);
  const reorderLoading = useStore((s) => s.reorderLoading);
  const reorderError = useStore((s) => s.reorderError);
  const reorderEdits = useStore((s) => s.reorderEdits);
  const inventory = useStore((s) => s.inventory);

  // Cards default EXPANDED on phone (the steppers are the primary action);
  // `collapsed` is the set of collapsed vendorIds. Per-session only.
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
  const toggle = React.useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [sheetVendorId, setSheetVendorId] = React.useState<string | null>(null);

  const subUnitSizeFor = React.useCallback(
    (itemId: string) => inventory.find((i) => i.id === itemId)?.subUnitSize ?? 1,
    [inventory],
  );

  // As-of date: prefer the loaded payload's date so the weekday partition agrees
  // with whatever the parent fetched; else today.
  const asOf = reorderPayload?.asOfDate ? reorderPayload.asOfDate.slice(0, 10) : todayIso();
  const selectedWeekday = React.useMemo(() => weekdayName(asOf), [asOf]);

  // Primary (ordered-out-today) vendors, edit-buffer overlaid — the flat list.
  const vendors = React.useMemo(() => {
    if (!selectedWeekday) return [] as ReorderVendor[];
    const { primary } = partitionReorderVendors(reorderPayload?.vendors, orderSchedule, selectedWeekday);
    return primary.map((v) => applyReorderEdits(v, reorderEdits[v.vendorId], subUnitSizeFor));
  }, [reorderPayload?.vendors, orderSchedule, selectedWeekday, reorderEdits, subUnitSizeFor]);

  // KPI line — active (counted) vendors + their displayed lines + est total.
  const kpi = React.useMemo(() => {
    const active = vendors.filter((v) => !isReorderCountNotSubmitted(v));
    let lines = 0;
    let est = 0;
    for (const v of active) {
      const vEdits = reorderEdits[v.vendorId];
      const shown = v.items.filter((it) => it.suggestedUnits > 0 || (vEdits ? it.itemId in vEdits : false));
      lines += shown.length;
      est += shown.reduce((a, it) => a + it.estimatedCost, 0);
    }
    return { vendorCount: active.length, lineCount: lines, est };
  }, [vendors, reorderEdits]);

  const sheetVendor = vendors.find((v) => v.vendorId === sheetVendorId) ?? null;

  const dateChip = (
    <TouchableOpacity
      testID="phone-order-date-chip"
      onPress={() => Toast.show({ type: 'info', text1: T('section.reorder.phoneDateHint') })}
      accessibilityRole="button"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 5, paddingHorizontal: 9, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}
    >
      <Text style={{ fontFamily: mono(600), fontSize: 9.5, letterSpacing: 0.7, color: C.fg2 }}>
        {T('section.reorder.phoneDateFor', { date: formatDateChip(asOf) })}
      </Text>
      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>▾</Text>
    </TouchableOpacity>
  );

  const header = (
    <View style={{ paddingTop: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 6 }}>
        <Text style={[PhoneType.screenTitle, { color: C.fg }]}>{T('section.reorder.title')}</Text>
        {dateChip}
      </View>
      <Text testID="phone-order-kpi" style={{ paddingHorizontal: 16, paddingBottom: 12, fontFamily: mono(400), fontSize: 11, color: C.fg3 }} numberOfLines={1}>
        {T('section.reorder.phoneKpiVendors', { count: kpi.vendorCount })} · {T('section.reorder.phoneKpiLines', { count: kpi.lineCount })} · {T('section.reorder.phoneKpiEst')}{' '}
        <Text style={{ color: C.fg, fontWeight: '600' }}>{formatMoney(kpi.est)}</Text>
      </Text>
    </View>
  );

  // No-store guard (mirrors the desktop section — the RPC is store-scoped).
  if (!currentStore?.id || currentStore.id === '__all__') {
    return (
      <View testID="phone-order-no-store" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}>
        <Text style={[PhoneType.body, { color: C.fg2 }]}>{T('section.reorder.selectStore')}</Text>
      </View>
    );
  }

  const empty =
    !reorderLoading && !reorderError && vendors.length === 0 ? (
      <View testID="phone-order-empty" style={{ padding: 24, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, letterSpacing: 0.4, color: C.fg3 }}>
          {reorderPayload && reorderPayload.vendors.length > 0
            ? T('section.reorder.noVendorsForDay', { day: selectedWeekday ?? '—' })
            : T('section.reorder.noSuggestions')}
        </Text>
      </View>
    ) : null;

  return (
    <View testID="phone-ordering" style={{ flex: 1, backgroundColor: C.bg }}>
      <FlatList
        testID="phone-order-flatlist"
        style={{ flex: 1, minHeight: 0 }}
        data={vendors}
        keyExtractor={(v) => v.vendorId}
        initialNumToRender={8}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        ListHeaderComponent={header}
        ListEmptyComponent={
          reorderError ? (
            <View testID="phone-order-error" style={{ padding: 24, gap: 6 }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.danger }}>{T('section.reorder.errorTitle')}</Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.danger }}>{reorderError}</Text>
            </View>
          ) : reorderLoading ? (
            <View testID="phone-order-loading" style={{ padding: 24, alignItems: 'center' }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, letterSpacing: 0.4, color: C.fg3 }}>{T('section.reorder.loading')}</Text>
            </View>
          ) : (
            empty
          )
        }
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 12 }}
        renderItem={({ item: v }) => (
          <VendorOrderCard
            vendor={v}
            vendorEdits={reorderEdits[v.vendorId]}
            subUnitSizeFor={subUnitSizeFor}
            collapsed={collapsed.has(v.vendorId)}
            onToggle={() => toggle(v.vendorId)}
            onMore={() => setSheetVendorId(v.vendorId)}
          />
        )}
      />
      {sheetVendor ? <OverflowSheet vendor={sheetVendor} onClose={() => setSheetVendorId(null)} /> : null}
    </View>
  );
};

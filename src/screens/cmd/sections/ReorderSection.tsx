import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { ReorderVendor, ReorderItem, ReorderPayload, Store, Vendor, InventoryItem } from '../../../types';
import { useT } from '../../../hooks/useT';
import { useLocale } from '../../../hooks/useLocale';
import { confirmAction } from '../../../utils/confirmAction';
import { getLocalizedName } from '../../../i18n/localizedName';
import { buildPoQuickOrderText, type NameResolver } from '../../../utils/poQuickOrderText';
import { sharePurchaseOrder } from '../lib/sharePo';
import ReorderDatePicker from '../../../components/cmd/ReorderDatePicker';
import { toISODate } from '../../../utils/reportDates';
import {
  weekdayName,
  activeWeekdaysFromSchedule,
  partitionReorderVendors,
  computeReorderKpis,
  splitReorderVendorsByNeed,
  isReorderCountNotSubmitted,
} from '../../../utils/reorderDayFilter';
// Spec 089 (A) — the pure export formatters (formatQty / formatMoney /
// formatSuggested / formatSuggestedPdf / slugifyStore / todayLocalIso /
// buildReorderCsv) were extracted to the shared `reorderExport` util so the
// staff Reorder screen can import the SAME byte-for-byte logic without
// pulling in this Cmd-themed module. The DOM-coupled web orchestrators
// (triggerDownload / handleCsvExport / handlePdfExport) stay below — they
// are admin-web-only and not pure. Re-exported here for the existing admin
// jest (ReorderSectionCases.test.tsx) which imports them from this module.
import {
  formatQty,
  formatMoney,
  formatSuggested,
  formatSuggestedParts,
  formatSuggestedPdf,
  formatSuggestedPdfParts,
  localizeUnit,
  slugifyStore,
  todayLocalIso,
  buildReorderCsv,
} from '../../../utils/reorderExport';
import { dayOfWeekLongLabel } from '../../../utils/enumLabels';
import { t, type Locale } from '../../../i18n';
import { planUsFoodsExport } from '../../../utils/usFoodsImport';
import { planSyscoExport } from '../../../utils/syscoImport';
import { pickImportVendor, type ImportOrderPlan } from '../../../utils/vendorImportShared';
// Spec 138 — reuse the spec-134 PURE case⇄units helpers for the inline order-qty
// edit (no forked conversion logic; AC-5).
import { isCaseRow, poOrderedDisplay, poResolveEdit } from '../../../utils/poCaseDisplay';

// Spec 088 — re-export the pure helpers from the shared util so the admin
// reorder jest (which imports `formatSuggested` / `formatSuggestedPdf` /
// `buildReorderCsv` from THIS module) stays green after the extraction.
export { formatSuggested, formatSuggestedPdf, buildReorderCsv };

// Spec 021 — vendor-grouped reorder list. This screen groups by vendor with
// a per-vendor "next delivery" header and an inline `on hand | inbound
// | par → order` breakdown per item, sourced from a server-side RPC
// (`report_reorder_list`). (It superseded the former store-wide-by-category
// Restock prototype, retired in cleanup.)
//
// v2 contract notes (spec 138 made Reorder the single ordering surface):
//   - `pending_po_qty` inbound netting was RETIRED with receiving (spec 138 §2 —
//     the RPC now emits 0). The "inbound" segment renders that constant 0.
//   - Each line's ORDER quantity is editable inline (spec 138 §5, cases via the
//     spec-134 `poCaseDisplay` helpers) into a per-session `reorderEdits` buffer;
//     the edited qty flows to every export + the Fill-cart handoff (AC-6).
//   - "Fill cart" (spec 138) REPLACES "+ CREATE PO" on `extension_ordering`
//     vendors only: it materialises the hidden draft the browser extension reads
//     via `fillCartForVendor` → `db.upsertVendorDraftOrder`. Non-extension
//     vendors get CSV / PDF / quick-order exports only (AC-9/AC-11/AC-12).
//   - Vendors with zero suggested items are filtered out server-side;
//     a true empty state means either no EOD has been done, every
//     active item is at par, or the store has no active vendors at all.

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Spec 138 — apply the per-session inline order-qty edit overlay to one vendor
// for DISPLAY / est-cost / KPI / exports / Fill cart (AC-6). For every item that
// carries an edit, the buffer's base (COUNTED units) replaces the server
// suggestion and the derived fields are recomputed:
//   - suggestedUnits / suggestedQty = the edited base;
//   - suggestedCases = base / caseQty for a case row (base is a whole-case
//     product via poCasesToBase), else the untouched null;
//   - estimatedCost = base × costPerUnit × subUnitSize — the load-bearing
//     spec-104 per-EACH → per-COUNTED-unit bridge (§5). Do NOT drop subUnitSize.
// Untouched items pass through verbatim (server estimated_cost preserved), so a
// vendor with no edits returns unchanged — zero behavior change when unused.
// `subUnitSizeFor` resolves subUnitSize from the hydrated `inventory` rows.
export function applyReorderEdits(
  vendor: ReorderVendor,
  vendorEdits: Record<string, number> | undefined,
  subUnitSizeFor: (itemId: string) => number,
): ReorderVendor {
  if (!vendorEdits || Object.keys(vendorEdits).length === 0) return vendor;
  let changed = false;
  const items = vendor.items.map((item) => {
    if (!(item.itemId in vendorEdits)) return item;
    changed = true;
    const base = vendorEdits[item.itemId];
    const caseRow = isCaseRow(item.caseQty);
    const subUnitSize = subUnitSizeFor(item.itemId) || 1;
    return {
      ...item,
      suggestedQty: base,
      suggestedUnits: base,
      suggestedCases: caseRow ? base / item.caseQty : item.suggestedCases,
      estimatedCost: base * item.costPerUnit * subUnitSize,
    };
  });
  if (!changed) return vendor;
  const vendorTotalCost = items.reduce((acc, i) => acc + i.estimatedCost, 0);
  return { ...vendor, items, vendorTotalCost };
}

// Spec 123 — narrow the full reorder payload to a SINGLE vendor for the
// per-vendor CSV/PDF export. The KPIs are recomputed from just that vendor so
// the export footer totals match the one card. Shape matches what the existing
// builders (`buildReorderCsv`, inline `handlePdfExport`) already loop over —
// no builder signature change.
export function narrowReorderToVendor(payload: ReorderPayload, vendor: ReorderVendor): ReorderPayload {
  return { ...payload, vendors: [vendor], kpis: computeReorderKpis([vendor]) };
}

// Inline per-item breakdown: `on hand: 0 each | inbound: 0 each | par: 40 each
// → order: 40 each`. This is the primary per-item display (2026-07 — the
// aligned numeric columns were removed as redundant). `tone` colors the
// `order:` figure red (needs) / green (enough) to match the section.
function BreakdownLine({ item, tone }: { item: ReorderItem; tone: string }) {
  const C = useCmdColors();
  const suggested = formatSuggestedParts(item);
  const seg = (label: string, value: string) => (
    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, fontVariant: ['tabular-nums'] }}>
      <Text style={{ color: C.fg3 }}>{label}:</Text> {value}
    </Text>
  );
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      {seg('on hand', `${formatQty(item.onHand)} ${item.unit}`.trim())}
      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>|</Text>
      {seg('inbound', `${formatQty(item.pendingPoQty)} ${item.unit}`.trim())}
      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>|</Text>
      {seg('par', `${formatQty(item.parLevel)} ${item.unit}`.trim())}
      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>→</Text>
      <Text style={{ fontFamily: mono(700), fontSize: 11.5, color: tone, fontVariant: ['tabular-nums'] }}>
        order: {suggested.main}
        {suggested.sub ? (
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {' · '}
            {suggested.sub}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

// Per-vendor source / schedule badge. Three shapes:
//   - `EOD` (accent green)         — fresh count today
//   - `STOCK FALLBACK` (warn)      — using current_stock, no EOD today
//   - `SCHEDULE UNKNOWN` (warn)    — 7-day default delivery cadence
function Badge({
  label,
  tone,
}: {
  label: string;
  tone: 'accent' | 'warn' | 'fg3';
}) {
  const C = useCmdColors();
  const bg = tone === 'accent' ? C.accentBg : tone === 'warn' ? C.warnBg : 'transparent';
  const fg = tone === 'accent' ? C.accent : tone === 'warn' ? C.warn : C.fg3;
  // Hairline tone border completes the pill treatment: tone-colored for the
  // filled accent/warn variants, muted `border` for the transparent fg3 one.
  const border = tone === 'fg3' ? C.border : fg;
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: CmdRadius.pill,
        backgroundColor: bg,
        borderWidth: 0.5,
        borderColor: border,
      }}
    >
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 9.5,
          letterSpacing: 0.5,
          color: fg,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// Per-item flag chip — renders the lowercase tokens from the RPC's
// `flags` array as compact one-letter mono pills. Same precedence as
// the variance runner's truncated marker.
function FlagChip({ token }: { token: string }) {
  const C = useCmdColors();
  const map: Record<string, { label: string; tone: 'warn' | 'fg3' }> = {
    no_par: { label: 'NO PAR', tone: 'warn' },
    no_usage_rate: { label: 'NO USAGE', tone: 'fg3' },
    eod_missing_for_item: { label: 'EOD MISS', tone: 'warn' },
    truncated: { label: 'TRUNC', tone: 'fg3' },
  };
  const entry = map[token];
  if (!entry) {
    // Forward-compat — render unknown tokens raw rather than dropping
    // them. Lets backend v2 add flags without churning the section.
    return (
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: CmdRadius.pill, borderWidth: 0.5, borderColor: C.border }}>
        <Text style={{ fontFamily: mono(600), fontSize: 9, color: C.fg3 }}>{token}</Text>
      </View>
    );
  }
  const bg = entry.tone === 'warn' ? C.warnBg : 'transparent';
  const fg = entry.tone === 'warn' ? C.warn : C.fg3;
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: CmdRadius.pill,
        backgroundColor: bg,
        borderWidth: 0.5,
        borderColor: entry.tone === 'warn' ? C.warn : C.border,
      }}
    >
      <Text style={{ fontFamily: mono(600), fontSize: 9, color: fg, letterSpacing: 0.3 }}>{entry.label}</Text>
    </View>
  );
}

// Spec 138 (AC-9/AC-10/AC-11) — the cart-filler handoff button. Rendered ONLY on
// vendors with `vendors.extension_ordering = true` (resolved from the hydrated
// `vendors` slice by id); non-extension vendors render NOTHING here (exports
// only, AC-11). Pressing it hands the vendor's current (edited) order to the
// browser extension via `fillCartForVendor` → `db.upsertVendorDraftOrder`, which
// materialises the hidden draft the unchanged extension RPCs already read. It
// REPLACES the retired "+ CREATE PO" button / "PO CREATED" chip (AC-12).
// Confirm-gated (a draft is benign, but a confirm avoids an accidental push).
function FillCartButton({ vendor }: { vendor: ReorderVendor }) {
  const C = useCmdColors();
  const T = useT();
  const vendors = useStore((s) => s.vendors);
  const fillCartForVendor = useStore((s) => s.fillCartForVendor);
  const [busy, setBusy] = React.useState(false);

  // AC-11 — no cart-filler button unless the vendor is extension-ordering.
  const extensionOrdering =
    vendors.find((v) => v.id === vendor.vendorId)?.extensionOrdering ?? false;
  if (!extensionOrdering) return null;

  const onPress = () => {
    if (busy) return;
    const vendorName = vendor.vendorName || 'this vendor';
    confirmAction(
      T('section.reorder.fillCartConfirmTitle'),
      T('section.reorder.fillCartConfirmBody', { vendor: vendorName, count: vendor.items.length }),
      () => {
        setBusy(true);
        void fillCartForVendor(vendor)
          .then((poId) => {
            if (poId) {
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
    <TouchableOpacity
      testID={`reorder-fill-cart-${vendor.vendorId}`}
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={T('section.reorder.fillCartAria', { vendor: vendor.vendorName || '' })}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: CmdRadius.sm,
        borderWidth: 1,
        borderColor: C.accent,
        backgroundColor: C.accentBg,
        opacity: busy ? 0.55 : 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.accent, letterSpacing: 0.3 }}>
        {busy ? T('section.reorder.fillCartBusy') : T('section.reorder.fillCartLabel')}
      </Text>
    </TouchableOpacity>
  );
}

// Spec 115 (W-3) — the Reorder-card "Quick-order list" export handler + button.
// Reuses the SAME (W-2-extended) `buildPoQuickOrderText` builder + the spec-108
// `sharePurchaseOrder` orchestrator, sourced from the card's (spec-138 buffer-
// overridden) order (`ReorderItem.suggestedUnits` + `caseQty`). AC-17 posture:
// NO PO exists, so NO
// mark-sent prompt / no status change — purely a copy/paste aid. Same `???`
// unmapped + unmapped-count + rounded-count surfacing as the PO path. The
// desktop-web preview is lifted to `VendorCard` (rendered as a normal in-card
// block, not an overlay) via the `onPreview` callback.
function ReorderQuickOrderButton({
  vendor,
  onPreview,
}: {
  vendor: ReorderVendor;
  onPreview: (p: { text: string | null; unitNote: string | null }) => void;
}) {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const inventory = useStore((s) => s.inventory);
  const vendors = useStore((s) => s.vendors);
  // Spec 138 (AC-7): a successful share/copy resets this vendor's inline edits.
  const clearReorderEditsForVendor = useStore((s) => s.clearReorderEditsForVendor);
  const [busy, setBusy] = React.useState(false);

  const onShareQuickOrder = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // The card's vendor's counting unit ('case' by default) — the SAME
      // conversion the PO path applies, via the shared builder.
      const orderUnit = vendors.find((v) => v.id === vendor.vendorId)?.orderUnit ?? 'case';
      // Order code for (item, THIS vendor card's vendorId) from the hydrated
      // inventory rows (ReorderItem carries no code) — identical to the PO path.
      const resolveCode = (itemId: string): string | null | undefined => {
        const row = inventory.find((i) => i.id === itemId);
        return row?.vendors?.find((v) => v.vendorId === vendor.vendorId)?.orderCode;
      };
      const resolveName: NameResolver = (itemId, fallbackName) => {
        const row = inventory.find((i) => i.id === itemId);
        return row ? getLocalizedName({ name: row.name, i18nNames: row.i18nNames }, locale) : fallbackName;
      };
      const { text, unmappedCount, roundedCount } = buildPoQuickOrderText(
        vendor.items.map((it) => ({
          itemId: it.itemId,
          itemName: it.itemName,
          orderedQty: it.suggestedUnits, // AC-16 — server-authoritative ordered base-unit total
          caseQty: it.caseQty,           // AC-16 — same conversion as PO
        })),
        resolveCode,
        resolveName,
        orderUnit,
      );
      const { shared, previewText } = await sharePurchaseOrder(text, {
        dialogTitle: T('section.purchaseOrders.quickOrderDialogTitle'),
        onCopyToast: () => Toast.show({ type: 'success', text1: T('section.purchaseOrders.quickOrderCopiedToast') }),
      });
      // AC-7: only a genuine share/copy (not a user-dismiss / failure) closes the
      // edit cycle for this vendor. `shared` is false on cancel or hard failure.
      if (shared) clearReorderEditsForVendor(vendor.vendorId);
      onPreview({
        text: previewText,
        unitNote:
          previewText != null
            ? orderUnit === 'case'
              ? T('section.purchaseOrders.quickOrderCountingInCases')
              : T('section.purchaseOrders.quickOrderCountingInUnits')
            : null,
      });
      // NO mark-sent (pre-PO). Same unmapped + rounded warnings as the PO path.
      if (unmappedCount > 0) {
        Toast.show({ type: 'error', text1: T('section.purchaseOrders.quickOrderUnmappedWarning', { count: unmappedCount }), position: 'bottom' });
      }
      if (roundedCount > 0) {
        Toast.show({ type: 'error', text1: T('section.purchaseOrders.quickOrderRoundedWarning', { count: roundedCount }), position: 'bottom' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <TouchableOpacity
      testID={`reorder-quick-order-${vendor.vendorId}`}
      onPress={onShareQuickOrder}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={T('section.reorder.quickOrderAria', { vendor: vendor.vendorName || '' })}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: CmdRadius.sm,
        borderWidth: 1,
        borderColor: C.borderStrong,
        opacity: busy ? 0.55 : 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg2, letterSpacing: 0.3 }}>
        {T('section.purchaseOrders.quickOrderAction')}
      </Text>
    </TouchableOpacity>
  );
}

// Spec 123 — per-vendor CSV + PDF export, in the vendor card footer (replaces
// the former global top-of-screen CSV/PDF buttons). Each button narrows the
// full reorder payload to THIS vendor and hands it to the SAME builders the
// global buttons used. Web-only — the parent gates rendering on `showExport`.
// The US Foods / SYSCO import-format path is preserved: `pickImportVendor` runs
// against the narrowed single-vendor payload, so a card whose vendor is
// configured for an import format emits that order file; otherwise the generic
// reorder CSV.
function ReorderVendorExportButtons({ vendor }: { vendor: ReorderVendor }) {
  const C = useCmdColors();
  const locale = useLocale();
  const currentStore = useStore((s) => s.currentStore);
  const reorderPayload = useStore((s) => s.reorderPayload);
  const vendorsList = useStore((s) => s.vendors);
  const inventory = useStore((s) => s.inventory);
  // Spec 138 (AC-7): a successful export closes this vendor's edit cycle — reset
  // its inline-edit buffer so the next reorder cycle starts fresh from the
  // computed suggestions. A failed/cancelled export must NOT wipe the edits.
  const clearReorderEditsForVendor = useStore((s) => s.clearReorderEditsForVendor);

  const onCsv = async () => {
    if (!reorderPayload || !currentStore) return;
    const narrowed = narrowReorderToVendor(reorderPayload, vendor);
    const importCfg = pickImportVendor(narrowed, vendorsList);
    const ok = importCfg
      ? handleImportExport(narrowed, currentStore, importCfg, inventory)
      : await handleCsvExport(narrowed, currentStore, locale);
    if (ok) clearReorderEditsForVendor(vendor.vendorId);
  };

  const onPdf = async () => {
    if (!reorderPayload || !currentStore) return;
    const ok = await handlePdfExport(narrowReorderToVendor(reorderPayload, vendor), currentStore, locale);
    if (ok) clearReorderEditsForVendor(vendor.vendorId);
  };

  const btnStyle = {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: CmdRadius.sm,
    borderWidth: 1,
    borderColor: C.borderStrong,
  } as const;

  return (
    <>
      <TouchableOpacity
        testID={`reorder-export-csv-${vendor.vendorId}`}
        onPress={onCsv}
        accessibilityRole="button"
        accessibilityLabel="Export CSV"
        style={btnStyle}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg2, letterSpacing: 0.3 }}>CSV</Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID={`reorder-export-pdf-${vendor.vendorId}`}
        onPress={onPdf}
        accessibilityRole="button"
        accessibilityLabel="Export PDF"
        style={btnStyle}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg2, letterSpacing: 0.3 }}>PDF</Text>
      </TouchableOpacity>
    </>
  );
}

// Renders a single vendor's reorder card.
// `needsOrder` selects the section tone: true → below-par items (red name +
// suggested), false → at/above-par items (green — the "have enough stock"
// section). Mirrors the staff Reorder card.
// `showExport` (spec 123) gates the per-vendor CSV/PDF footer buttons — web-only,
// threaded from the parent so it matches the former global-button gating.
// `collapsible` / `collapseKey` / `collapsed` / `onToggleCollapse` (spec 135)
// thread the section-level per-card collapse state in. They default to
// non-collapsible so the not-submitted early-return branch and any future
// caller stay unaffected. When `collapsible` is true and `collapsed` is set,
// the card body (column strip + item rows + footer caption) is hidden, leaving
// the header block (name/badges + actions + next-delivery + stats) and, when
// open, the quick-order preview — the actions live in the header (2026-07-21)
// so they stay clickable while collapsed.
function VendorCard({
  vendor,
  needsOrder,
  showExport,
  collapsible,
  collapseKey,
  collapsed,
  onToggleCollapse,
}: {
  vendor: ReorderVendor;
  needsOrder: boolean;
  showExport?: boolean;
  collapsible?: boolean;
  collapseKey?: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const C = useCmdColors();
  const T = useT();
  const itemTone = needsOrder ? C.danger : C.ok;
  // Spec 138 — write the per-item inline order-qty edit into the store buffer.
  // The `vendor` passed to this card is ALREADY buffer-overridden at the section
  // (applyReorderEdits), so `item.suggestedUnits` is the current base — used to
  // seed the input AND as the no-op reference in poResolveEdit.
  const setReorderEditQty = useStore((s) => s.setReorderEditQty);
  // Spec 115 (W-3) — desktop-web quick-order preview, lifted here so it renders
  // as a normal in-card block below the footer (the card has overflow:hidden, so
  // an overlay wouldn't work). Cleared via the × in the preview header.
  const [quickPreview, setQuickPreview] = React.useState<{ text: string | null; unitNote: string | null }>({ text: null, unitNote: null });

  // Source vs schedule badges are ORTHOGONAL — render both side-by-side.
  // Earlier the `SCHEDULE UNKNOWN` badge masked the EOD/STOCK source
  // badge entirely; a vendor with a fresh EOD count but no order_schedule
  // row would show only `SCHEDULE UNKNOWN`, hiding that its on-hand
  // numbers are authoritative. The on-hand-source badge is always
  // emitted; the schedule badge is only emitted when scheduleKnown is
  // false. The `7-DAY DEFAULT` badge a few lines down stays as its own
  // chip too (same pattern).
  const sourceBadgeEl =
    vendor.onHandSource === 'eod'
      ? <Badge label="EOD" tone="accent" />
      : <Badge label="STOCK FALLBACK" tone="warn" />;
  const scheduleBadgeEl = vendor.scheduleKnown
    ? null
    : <Badge label="SCHEDULE UNKNOWN" tone="warn" />;

  // Days-until label. 0 = today, 1 = tomorrow, else "in N days".
  const daysLabel =
    vendor.daysUntilNextDelivery === 0
      ? 'today'
      : vendor.daysUntilNextDelivery === 1
        ? 'tomorrow'
        : `in ${vendor.daysUntilNextDelivery} days`;

  // Spec 130 — shared header sub-blocks. The name/badges row and the
  // next-delivery line are byte-identical between the counted branch and the
  // not-submitted branch, so they're factored out here and rendered by BOTH
  // (the counted branch wraps `nextDeliveryLine` in a stats row with items/qty/
  // est-cost; the not-submitted branch renders it bare). No visual change to
  // the counted card — same markup, just deduped.
  const headerNameRow = (
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
      <Text style={[Type.h2, { color: C.fg }]}>{vendor.vendorName || 'unnamed vendor'}</Text>
      {/* On-hand-source badge — always rendered (orthogonal to schedule). */}
      {sourceBadgeEl}
      {/* Schedule badge — only when scheduleKnown=false. */}
      {scheduleBadgeEl}
      {vendor.scheduleKnown ? null : <Badge label="7-DAY DEFAULT" tone="fg3" />}
      <View style={{ flex: 1 }} />
      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
        {shortId(vendor.vendorId)}
      </Text>
    </View>
  );
  const nextDeliveryLine = (
    <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2 }}>
      <Text style={{ color: C.fg3 }}>next delivery:</Text>{' '}
      <Text style={{ color: C.fg, fontWeight: '600' }}>{vendor.nextDeliveryDate || '—'}</Text>{' '}
      <Text style={{ color: C.fg3 }}>({daysLabel})</Text>
    </Text>
  );

  // Spec 135 — the counted-branch name row, with the collapse chevron + vendor
  // name wrapped in the ONLY touchable in the header. Badges / short id / stats
  // stay OUTSIDE this touchable so tapping them never toggles. The chevron
  // glyphs / style byte-match the "NO ORDER SCHEDULE" group toggle: `▾` when
  // expanded, `▸` when collapsed. Only rendered when `collapsible` is true (the
  // not-submitted branch returns before this and keeps the chevron-free
  // `headerNameRow`).
  const headerNameRowCollapsible = (
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
      <TouchableOpacity
        testID={`reorder-vendor-toggle-${collapseKey}`}
        onPress={onToggleCollapse}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        accessibilityLabel={T('section.reorder.collapseVendorAria', { vendor: vendor.vendorName || '' })}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>
          {collapsed ? '▸' : '▾'}
        </Text>
        <Text style={[Type.h2, { color: C.fg }]}>{vendor.vendorName || 'unnamed vendor'}</Text>
      </TouchableOpacity>
      {/* On-hand-source badge — always rendered (orthogonal to schedule). */}
      {sourceBadgeEl}
      {/* Schedule badge — only when scheduleKnown=false. */}
      {scheduleBadgeEl}
      {vendor.scheduleKnown ? null : <Badge label="7-DAY DEFAULT" tone="fg3" />}
      <View style={{ flex: 1 }} />
      {/* Owner follow-up (2026-07-21): the per-vendor actions (CSV / PDF /
          quick-order / Fill cart) moved up here from the footer so they stay
          clickable while the card is collapsed (cards default-collapsed). Fill
          cart (spec 138) renders only on extension_ordering vendors. */}
      {showExport ? <ReorderVendorExportButtons vendor={vendor} /> : null}
      <ReorderQuickOrderButton vendor={vendor} onPreview={setQuickPreview} />
      <FillCartButton vendor={vendor} />
      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
        {shortId(vendor.vendorId)}
      </Text>
    </View>
  );

  // Spec 130 — a vendor whose EOD count was NOT submitted for the reorder date.
  // Its per-item order quantities are computed off a stale current_stock
  // fallback, so we render the header (name + next-delivery + badges) but
  // REPLACE the column strip / item rows / footer actions with a
  // "Count not submitted yet" state block. This branch renders no
  // BreakdownLine rows and none of the per-vendor actions (Fill cart /
  // Quick-order / CSV / PDF) — they all live in the header this branch omits.
  if (isReorderCountNotSubmitted(vendor)) {
    return (
      <View
        style={{
          backgroundColor: C.panel,
          borderRadius: CmdRadius.lg,
          borderWidth: 1,
          borderColor: C.violet,
          overflow: 'hidden',
        }}
      >
        {/* Vendor header — name + badges + next-delivery line (shared markup). */}
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
            gap: 8,
          }}
        >
          {headerNameRow}
          {nextDeliveryLine}
        </View>

        {/* Count-not-submitted state block — replaces columns/items/footer. */}
        <View
          testID={`reorder-count-not-submitted-${vendor.vendorId}`}
          style={{
            margin: 12,
            paddingHorizontal: 16,
            paddingVertical: 24,
            alignItems: 'center',
            gap: 8,
            borderRadius: CmdRadius.lg,
            borderWidth: 0.5,
            borderColor: C.violet,
            backgroundColor: C.violetBg,
          }}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 22, color: C.violet }}>⊘</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.violet, letterSpacing: 0.4, textTransform: 'uppercase' }}>
            {T('section.reorder.countNotSubmittedTitle')}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 480 }}>
            {T('section.reorder.countNotSubmittedBody')}
          </Text>
        </View>
      </View>
    );
  }

  // Spec 091 D1 — BASE-UNIT sum, intentionally NOT a "cases" total. This adds
  // `suggestedQty` (base units) across the vendor's items, which for case
  // items reads differently from the per-item "N cases · M units" Suggested
  // column. That's by design: a per-vendor qty total spans items with
  // DIFFERENT units (each / gal / lbs / bags) AND different case sizes, so it
  // cannot be cleanly expressed "in cases." The meaningful per-vendor
  // aggregate is the Est $ total (`vendor.vendorTotalCost`, shown to the
  // right). The header below is labeled "qty (base):" to signal this. NO math
  // change (spec 088 scoped the cases-total out for exactly this reason).
  const itemTotal = vendor.items.reduce((acc, i) => acc + i.suggestedQty, 0);

  return (
    <View
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        overflow: 'hidden',
      }}
    >
      {/* Vendor header — name/badges row + next-delivery line shared with the
          not-submitted branch (spec 130); the stats row (items/qty/est-cost) is
          counted-branch-only. */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          gap: 8,
        }}
      >
        {collapsible ? headerNameRowCollapsible : headerNameRow}
        <View
          testID={collapseKey ? `reorder-vendor-stats-${collapseKey}` : undefined}
          style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}
        >
          {nextDeliveryLine}
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2 }}>
            <Text style={{ color: C.fg3 }}>items:</Text>{' '}
            <Text style={{ color: C.fg, fontWeight: '600' }}>{vendor.items.length}</Text>
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2 }}>
            <Text style={{ color: C.fg3 }}>qty (base):</Text>{' '}
            <Text style={{ color: C.fg, fontWeight: '600' }}>{formatQty(itemTotal)}</Text>
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2 }}>
            <Text style={{ color: C.fg3 }}>est cost:</Text>{' '}
            <Text style={{ color: C.fg, fontWeight: '600' }}>{formatMoney(vendor.vendorTotalCost)}</Text>
          </Text>
        </View>
      </View>

      {/* Spec 135 — the card body (column strip + item rows + footer caption)
          is hidden while collapsed; the header block above (which carries the
          action buttons since 2026-07-21) and the quick-order preview below
          stay. `!collapsed` is always true for non-collapsible cards
          (`collapsed` is undefined). */}
      {!collapsed ? (
      <>
      {/* Column header strip */}
      <View
        testID={collapseKey ? `reorder-vendor-columns-${collapseKey}` : undefined}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 8,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          gap: 10,
          backgroundColor: C.bg,
        }}
      >
        {/* on-hand / inbound / par / suggested now live inline in the per-item
            breakdown line below (2026-07); only item + est $ stay as columns. */}
        <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, flex: 1 }]}>item</Text>
        <Text style={[Type.captionLg, { color: C.fg3, fontSize: 9.5, width: 80, textAlign: 'right' }]}>est $</Text>
      </View>

      {/* Items */}
      {vendor.items.map((item, i) => (
        <View
          key={item.itemId}
          testID={`reorder-vendor-item-${item.itemId}`}
          style={{
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: C.border,
            gap: 6,
          }}
        >
          {/* Top row: name (+ flags) and the est-$ column. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {/* Red name for needs-order rows, green for enough-stock rows. */}
              <Text style={{ fontFamily: sans(600), fontSize: 13, color: itemTone }} numberOfLines={1}>
                {item.itemName}
              </Text>
              {item.flags.map((f) => (
                <FlagChip key={f} token={f} />
              ))}
            </View>
            <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
              {formatMoney(item.estimatedCost)}
            </Text>
          </View>
          {/* Inline breakdown: on hand | inbound | par → order (2026-07 — the
              single per-item numeric display; order figure in the section tone). */}
          <View style={{ paddingLeft: 2 }}>
            <BreakdownLine item={item} tone={itemTone} />
          </View>
          {/* Spec 138 (AC-5) — inline editable ORDER quantity, using the spec-134
              case conventions: a `caseQty > 1` line edits in CASES with the
              `× N / case` sub-caption; a `caseQty <= 1` line edits in units. The
              seed + no-op reference is `item.suggestedUnits`, already
              buffer-overridden at the section (so it shows the persisted edit).
              `key` includes the current base so a wholesale/per-vendor reset
              (store switch / date change / after Fill cart) re-seeds the field.
              Lives in the card BODY (below the collapse guard) — expand to edit. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 2 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.4, textTransform: 'uppercase' }}>
              {T('section.reorder.orderedLabel')}
            </Text>
            <TextInput
              key={`reorder-ordered-${item.itemId}-${item.suggestedUnits}`}
              testID={`reorder-ordered-${item.itemId}`}
              defaultValue={poOrderedDisplay(item.suggestedUnits, item.caseQty)}
              keyboardType="numeric"
              accessibilityLabel={T('section.reorder.orderedEditAria', { item: item.itemName })}
              onEndEditing={(e) => {
                const { write, base } = poResolveEdit(e.nativeEvent.text, item.suggestedUnits, item.caseQty);
                if (write) setReorderEditQty(vendor.vendorId, item.itemId, base);
              }}
              style={{
                fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 88, textAlign: 'right',
                borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.xs,
                paddingVertical: 3, paddingHorizontal: 6,
              }}
            />
            <Text style={{ fontFamily: mono(400), fontSize: 9, color: C.fg3 }}>
              {isCaseRow(item.caseQty)
                ? T('section.reorder.perCaseCaption', { count: item.caseQty })
                : item.unit}
            </Text>
          </View>
          {/* Spec 102 (OQ-1) — coincident-schedule hint. When this shared item
              is also scheduled under other vendors today it appears under each
              of their cards; surface "also available from N" so the manager
              orders it from ONE vendor, not several. Advisory only — does not
              change which card the item is on. Renders nothing for a
              single-vendor item (otherVendorCount 0). Admin surface is English
              (matches the rest of this section + the byte-for-byte exports). */}
          {(item.otherVendorCount ?? 0) > 0 && (item.alsoFromVendors?.length ?? 0) > 0 ? (
            <View style={{ paddingLeft: 2 }}>
              <Text
                style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, fontStyle: 'italic' }}
                testID={`reorder-also-from-${item.itemId}`}
              >
                {`also available from ${item.otherVendorCount === 1
                  ? (item.alsoFromVendors ?? []).map((v) => v.vendorName).join(', ')
                  : `${item.otherVendorCount} other vendors (${(item.alsoFromVendors ?? []).map((v) => v.vendorName).join(', ')})`} — order from one`}
              </Text>
            </View>
          ) : null}
        </View>
      ))}

      {/* Footer */}
      <View
        style={{
          paddingVertical: 10,
          paddingHorizontal: 16,
          borderTopWidth: 1,
          borderTopColor: C.border,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: C.bg,
        }}
      >
        <SectionCaption tone="fg2" size={10}>
          {vendor.items.length} item{vendor.items.length === 1 ? '' : 's'} · {formatMoney(vendor.vendorTotalCost)}
        </SectionCaption>
        {vendor.eodSubmittedAt ? (
          <>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              eod counted: {new Date(vendor.eodSubmittedAt).toLocaleString()}
            </Text>
          </>
        ) : null}
        <View style={{ flex: 1 }} />
        {/* The per-vendor action buttons (spec 123 CSV/PDF, spec 115 quick-order,
            spec 138 Fill cart) moved to the header name row (2026-07-21) so they
            stay reachable while the card is collapsed. */}
      </View>
      </>
      ) : null}

      {/* Spec 115 (W-3) — desktop-web quick-order preview (clipboard fallback).
          Rendered OUTSIDE the collapse guard (2026-07-21): the quick-order
          button now lives in the always-visible header, so its preview must
          show even while the card body is collapsed. */}
      {quickPreview.text != null ? (
        <View
          testID={`reorder-quick-order-preview-${vendor.vendorId}`}
          style={{ borderTopWidth: 1, borderTopColor: C.borderStrong, backgroundColor: C.panel, padding: 14, gap: 8 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <SectionCaption tone="fg3" size={10.5}>{T('section.purchaseOrders.sharePreviewLabel')}</SectionCaption>
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              testID={`reorder-quick-order-preview-close-${vendor.vendorId}`}
              onPress={() => setQuickPreview({ text: null, unitNote: null })}
              hitSlop={6}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 12, color: C.fg3 }}>×</Text>
            </TouchableOpacity>
          </View>
          {quickPreview.unitNote ? (
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.accent, letterSpacing: 0.3 }}>{quickPreview.unitNote}</Text>
          ) : null}
          <Text selectable style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, lineHeight: 17 }}>
            {quickPreview.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ─── Spec 025 §3 — CSV/PDF export ───────────────────────────────────
// Web-only export per spec 025 AC4/AC5. The pure builders (buildReorderCsv,
// formatSuggestedPdf, slugifyStore, todayLocalIso) moved to the shared
// `reorderExport` util in spec 089 (A); the DOM-coupled orchestrators below
// stay here (admin-web-only). The staff Reorder screen uses a cross-platform
// orchestrator in `src/screens/staff/lib/shareReorder.ts` instead.

function triggerDownload(blob: Blob, filename: string): void {
  if (Platform.OS !== 'web') return;
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has a chance to commit the download.
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

// Spec 138 (AC-7): returns `true` only when the download actually fired, so the
// caller can reset that vendor's inline-edit buffer ON SUCCESS ONLY (a failed
// export must preserve the operator's edits so they can retry).
async function handleCsvExport(payload: ReorderPayload, store: Store, locale: Locale): Promise<boolean> {
  try {
    const csv = buildReorderCsv(payload, locale);
    const date = (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso();
    // Per-vendor exports (spec 123) narrow to a single vendor — include the
    // vendor name so two vendor cards for the same store+date don't collide on
    // one filename. Whole-list exports (>1 vendor) keep the store-only name.
    const vendorSuffix =
      payload.vendors.length === 1 ? `_${slugifyStore(payload.vendors[0].vendorName)}` : '';
    const filename = `IMR_Reorder_${slugifyStore(store.name)}${vendorSuffix}_${date}.csv`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    triggerDownload(blob, filename);
    Toast.show({
      type: 'success',
      text1: 'CSV exported',
      text2: filename,
      visibilityTime: 3000,
    });
    return true;
  } catch (e: any) {
    console.warn('[ReorderSection] CSV export failed:', e?.message || e);
    Toast.show({
      type: 'error',
      text1: 'CSV export failed',
      text2: e?.message || 'Unable to build the CSV file',
      visibilityTime: 4000,
    });
    return false;
  }
}

// 2026-07 — vendor-specific "Import Order" files. When the reorder list's vendor
// is configured `order_import_format` ('us_foods' | 'sysco'), the CSV button
// emits THAT vendor's order file (that vendor's items only, in the vendor's own
// layout) instead of the generic reorder CSV. Each item's product number is its
// per-vendor order_code, resolved from the hydrated inventory rows the same way
// the quick-order path does; items without a code are skipped and surfaced in
// the toast. `planUsFoodsExport` / `planSyscoExport` do the pure work; this pair
// of thin handlers share the download + toast emitter below.
function emitImportPlan(plan: ImportOrderPlan, label: string): void {
  const blob = new Blob([plan.csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, plan.filename);
  // Compose the toast: skipped-no-code, other-vendors-omitted (Risk 1), and
  // missing-customer-# cues, so a multi-vendor day never silently drops the
  // other vendors' rows and a store with no ship-to number is flagged.
  const notes: string[] = [];
  if (plan.skippedNoCode > 0) notes.push(`${plan.skippedNoCode} skipped — no order code`);
  if (plan.otherVendorCount > 0)
    notes.push(`${plan.otherVendorCount} other vendor${plan.otherVendorCount === 1 ? '' : 's'} not in this file`);
  if (plan.customerNumberMissing) notes.push('no customer # set for this store');
  Toast.show({
    type: notes.length > 0 ? 'info' : 'success',
    text1: `${label}: ${plan.included} item${plan.included === 1 ? '' : 's'}`,
    text2: notes.length > 0 ? `${notes.join(' · ')}. ${plan.filename}` : plan.filename,
    visibilityTime: notes.length > 0 ? 5000 : 3000,
  });
}

// Spec 138 (AC-7): returns `true` only when the import file was emitted, so the
// caller resets the vendor's inline-edit buffer on success only.
function handleImportExport(
  payload: ReorderPayload,
  store: Store,
  cfg: Vendor,
  inventory: InventoryItem[],
): boolean {
  const label = cfg.orderImportFormat === 'sysco' ? 'SYSCO order' : 'US Foods import';
  try {
    const resolveCode = (item: ReorderItem): string | null | undefined =>
      inventory.find((i) => i.id === item.itemId)?.vendors?.find((v) => v.vendorId === cfg.id)?.orderCode;
    const plan =
      cfg.orderImportFormat === 'sysco'
        ? planSyscoExport(payload, store.id, store.name, cfg, resolveCode)
        : planUsFoodsExport(payload, store.id, store.name, cfg, resolveCode);
    emitImportPlan(plan, label);
    return true;
  } catch (e: any) {
    console.warn(`[ReorderSection] ${label} export failed:`, e?.message || e);
    Toast.show({
      type: 'error',
      text1: `${label} export failed`,
      text2: e?.message || 'Unable to build the import file',
      visibilityTime: 4000,
    });
    return false;
  }
}

// Spec 025 AC5 — jsPDF + jspdf-autotable dynamic-imported per legacy
// pattern so the bundle stays lean for users who never click "PDF".
// Spec 138 (AC-7): returns `true` only when the PDF actually saved, so the
// caller resets the vendor's inline-edit buffer on success only.
async function handlePdfExport(payload: ReorderPayload, store: Store, localeIn: Locale): Promise<boolean> {
  try {
    const { default: jsPDF } = await import('jspdf');
    const autoTableMod: any = await import('jspdf-autotable');
    const autoTable = autoTableMod.default || autoTableMod;

    // jsPDF's built-in Helvetica has NO CJK glyphs, so a zh-CN PDF renders as
    // garbage. Owner decision (2026-07): ship the admin PDF localized for
    // en/es only and FALL BACK TO ENGLISH for the PDF when the active locale is
    // Chinese (the CSV / Text downloads and the staff HTML→print PDF stay fully
    // localized). A follow-up will move this PDF onto a CJK-capable engine.
    const locale: Locale = localeIn === 'zh-CN' ? 'en' : localeIn;

    // Localized label shorthand — English path returns the prior literals.
    const L = (key: string, en: string, vars?: Record<string, string | number>) =>
      locale === 'en' ? en : t(locale, key, vars);
    const unitOf = (u: string) => (locale === 'en' ? u : localizeUnit(u, locale));
    const nameOf = (item: ReorderItem) =>
      getLocalizedName({ name: item.itemName, i18nNames: item.i18nNames }, locale);

    const doc = new jsPDF({ unit: 'pt' });
    const margin = 40;
    const date = (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso();

    // Header section (manual draw).
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('I.M.R', margin, margin);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    doc.text(L('reorderExport.title', 'Per-Vendor Reorder Suggestions'), margin, margin + 18);
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text(
      `${L('reorderExport.store', 'Store')}: ${store.name}  |  ${L('reorderExport.asOf', 'As of')}: ${date}`,
      margin,
      margin + 34,
    );
    doc.setTextColor(0);

    let cursorY = margin + 56;

    // 2026-07 — two colour-coded sections mirroring the screen: "NEEDS TO
    // ORDER" (red) then "HAVE ENOUGH STOCK" (green). Each renders one autoTable
    // per vendor (only that section's items); the section replaces the per-row
    // Needs Order column. RED/GREEN RGB match the danger/ok palette tokens.
    const RED: [number, number, number] = [121, 31, 31];
    const GREEN: [number, number, number] = [59, 109, 17];
    const pageHeight = doc.internal.pageSize.getHeight();

    const renderSection = (
      title: string,
      rgb: [number, number, number],
      vendors: ReorderVendor[],
      isNeeds: boolean,
    ) => {
      if (vendors.length === 0) return;
      if (cursorY > pageHeight - 90) {
        doc.addPage();
        cursorY = margin;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(rgb[0], rgb[1], rgb[2]);
      doc.text(title, margin, cursorY);
      doc.setTextColor(0);
      cursorY += 12;

      for (const vendor of vendors) {
        const sourceLabel =
          vendor.onHandSource === 'eod'
            ? L('reorderExport.sourceEod', 'EOD')
            : L('reorderExport.sourceStock', 'STOCK FALLBACK');
        const daysLabel =
          vendor.daysUntilNextDelivery === 0
            ? L('reorderExport.deliveryToday', 'today')
            : vendor.daysUntilNextDelivery === 1
              ? L('reorderExport.deliveryTomorrow', 'tomorrow')
              : L('reorderExport.deliveryInDays', `in ${vendor.daysUntilNextDelivery} days`, {
                  days: vendor.daysUntilNextDelivery,
                });
        const vendorName = vendor.vendorName || L('reorderExport.unnamedVendor', 'unnamed vendor');
        const subHeader = `${vendorName}  ·  ${L('reorderExport.source', 'Source')}: ${sourceLabel}  ·  ${L('reorderExport.nextDelivery', 'Next delivery')}: ${vendor.nextDeliveryDate || '—'} (${daysLabel})`;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(rgb[0], rgb[1], rgb[2]);
        doc.text(subHeader, margin, cursorY);
        doc.setTextColor(0);
        cursorY += 6;

        // NEEDS section (2026-07): drop the redundant Unit column — the unit
        // already lives inside the Suggested string ("4 cs · 16 bags"), so a
        // separate Unit column read "16 bags bags". The compact per-item cases
        // parts feed a custom didDrawCell that paints ONLY the "N cs" case
        // count red. HAVE ENOUGH keeps the Unit column (there it labels the
        // On-Hand figure and Suggested is 0).
        const SUGGESTED_COL = 4;
        const parts = vendor.items.map((item) => ({
          ...formatSuggestedPdfParts(item, locale),
          isCases: item.suggestedCases != null,
        }));
        const head = isNeeds
          ? [
              [
                L('reorderExport.colItem', 'Item'),
                L('reorderExport.colOnHand', 'On Hand'),
                L('reorderExport.colPending', 'Pending'),
                L('reorderExport.colPar', 'Par'),
                L('reorderExport.colSuggested', 'Suggested'),
                L('reorderExport.colEstCost', 'Est. Cost'),
              ],
            ]
          : [
              [
                L('reorderExport.colItem', 'Item'),
                L('reorderExport.colOnHand', 'On Hand'),
                L('reorderExport.colPending', 'Pending'),
                L('reorderExport.colPar', 'Par'),
                L('reorderExport.colSuggested', 'Suggested'),
                L('reorderExport.colUnit', 'Unit'),
                L('reorderExport.colEstCost', 'Est. Cost'),
              ],
            ];
        const body = vendor.items.map((item) =>
          isNeeds
            ? [
                nameOf(item),
                formatQty(item.onHand),
                formatQty(item.pendingPoQty),
                formatQty(item.parLevel),
                formatSuggestedPdf(item, locale),
                `$${item.estimatedCost.toFixed(2)}`,
              ]
            : [
                nameOf(item),
                formatQty(item.onHand),
                formatQty(item.pendingPoQty),
                formatQty(item.parLevel),
                formatSuggestedPdf(item, locale),
                unitOf(item.unit),
                `$${item.estimatedCost.toFixed(2)}`,
              ],
        );

        autoTable(doc, {
          startY: cursorY + 8,
          head,
          body,
          styles: { fontSize: 9, cellPadding: 3 },
          // Section-tinted header (red / green) so the two boxes read at a glance.
          headStyles: { fillColor: rgb, textColor: 255, fontStyle: 'bold' },
          columnStyles: isNeeds
            ? { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 5: { halign: 'right' } }
            : { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 6: { halign: 'right' } },
          // NEEDS only: blank autotable's own Suggested text so the custom
          // partial-red draw below owns the cell.
          didParseCell: isNeeds
            ? (data: any) => {
                if (data.section === 'body' && data.column.index === SUGGESTED_COL) {
                  data.cell.text = [];
                }
              }
            : undefined,
          // NEEDS only: paint "N cs" red (the case count the manager acts on),
          // then " · M unit" in muted grey. Non-case rows draw their whole
          // order figure in the default colour (nothing to highlight).
          didDrawCell: isNeeds
            ? (data: any) => {
                if (data.section !== 'body' || data.column.index !== SUGGESTED_COL) return;
                const p = parts[data.row.index];
                if (!p) return;
                const px = data.cell.x + (data.cell.padding('left') as number);
                const py = data.cell.y + data.cell.height / 2 + 3;
                doc.setFontSize(9);
                if (p.isCases) {
                  doc.setFont('helvetica', 'bold');
                  doc.setTextColor(RED[0], RED[1], RED[2]);
                } else {
                  doc.setFont('helvetica', 'normal');
                  doc.setTextColor(30);
                }
                doc.text(p.main, px, py);
                if (p.sub) {
                  const mainW = doc.getTextWidth(p.main);
                  doc.setFont('helvetica', 'normal');
                  doc.setTextColor(90);
                  doc.text(` · ${p.sub}`, px + mainW, py);
                }
                doc.setTextColor(0);
                doc.setFont('helvetica', 'normal');
              }
            : undefined,
          margin: { left: margin, right: margin },
        });

        const finalY = ((doc as unknown) as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY;
        cursorY = (typeof finalY === 'number' ? finalY : cursorY) + 20;
      }
      cursorY += 12;
    };

    renderSection(L('reorderExport.needsToOrder', 'NEEDS TO ORDER').toUpperCase(), RED, splitReorderVendorsByNeed(payload.vendors, true), true);
    renderSection(L('reorderExport.haveEnough', 'HAVE ENOUGH STOCK').toUpperCase(), GREEN, splitReorderVendorsByNeed(payload.vendors, false), false);

    // Footer (last page).
    const totalItems = payload.kpis.itemCount;
    const totalCost = payload.kpis.totalEstimatedCost;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(
      `${L('reorderExport.totalItems', 'Total items')}: ${totalItems}  |  ${L('reorderExport.estTotal', 'Est. total')}: $${totalCost.toFixed(2)}`,
      margin,
      cursorY,
    );

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(
      L('reorderExport.generatedBy', 'Generated by I.M.R — Inventory Management for Restaurant'),
      margin,
      pageHeight - 24,
    );

    // Per-vendor exports (spec 123) narrow to one vendor — include its name so
    // multiple vendor-card downloads for the same store+date stay distinct.
    const vendorSuffix =
      payload.vendors.length === 1 ? `_${slugifyStore(payload.vendors[0].vendorName)}` : '';
    const filename = `IMR_Reorder_${slugifyStore(store.name)}${vendorSuffix}_${date}.pdf`;
    doc.save(filename);
    Toast.show({
      type: 'success',
      text1: 'PDF exported',
      text2: filename,
      visibilityTime: 3000,
    });
    return true;
  } catch (e: any) {
    console.warn('[ReorderSection] PDF export failed:', e?.message || e);
    Toast.show({
      type: 'error',
      text1: 'PDF export failed',
      text2: e?.message || 'Unable to build the PDF file',
      visibilityTime: 4000,
    });
    return false;
  }
}

export default function ReorderSection() {
  const C = useCmdColors();
  const T = useT();
  const currentStore = useStore((s) => s.currentStore);
  const orderSchedule = useStore((s) => s.orderSchedule);
  const reorderPayload = useStore((s) => s.reorderPayload);
  const reorderLoading = useStore((s) => s.reorderLoading);
  const reorderError = useStore((s) => s.reorderError);
  const loadReorderSuggestions = useStore((s) => s.loadReorderSuggestions);
  // Spec 138 — the per-session inline order-qty edit buffer + the inventory
  // rows (for the subUnitSize bridge). `applyReorderEdits` overlays the buffer
  // onto the rendered vendors (display / est-cost / KPI / exports / Fill cart).
  const inventory = useStore((s) => s.inventory);
  const reorderEdits = useStore((s) => s.reorderEdits);
  const clearReorderEdits = useStore((s) => s.clearReorderEdits);
  // `applyReorderEdits` already coerces a falsy result to 1, so no `|| 1` here
  // (spec 138 code-review nit — a single fallback in the pure helper).
  const subUnitSizeFor = React.useCallback(
    (itemId: string) => inventory.find((i) => i.id === itemId)?.subUnitSize ?? 1,
    [inventory],
  );
  const applyEdits = React.useCallback(
    (vendors: ReorderVendor[]) =>
      vendors.map((v) => applyReorderEdits(v, reorderEdits[v.vendorId], subUnitSizeFor)),
    [reorderEdits, subUnitSizeFor],
  );

  const [tabId, setTabId] = React.useState('reorder.tsx');

  // Spec 087 — calendar selected date. Defaults to store-local today;
  // this is the exact ISO `YYYY-MM-DD` we pass as `as_of_date`. `maxDate`
  // (latest selectable) is today.
  const maxDate = toISODate(new Date());
  const [selectedDate, setSelectedDate] = React.useState<string>(() => toISODate(new Date()));

  // Spec 087 — single as-of fetch effect, store-switch aware (code-review #3:
  // the prior two-effect split caused a transient stale-as-of fetch on store
  // switch). On a STORE switch we reset the calendar to today AND fetch as-of
  // today DIRECTLY (not the `selectedDate` carried from the previous store),
  // so the new store is never fetched as-of a date picked for the old one.
  // On mount or a calendar date change for the SAME store, fetch as-of
  // `selectedDate`. `loadFromSupabase` already clears `reorderPayload` +
  // re-hydrates `orderSchedule` for the new store on switch. Mirrors
  // REPORTS-1's `loadLatestRun` lazy-load pattern (the section is the entry
  // point; the global boot doesn't pre-populate this payload).
  const prevStoreIdRef = React.useRef(currentStore?.id);
  React.useEffect(() => {
    if (!currentStore?.id) return;
    const storeChanged = prevStoreIdRef.current !== currentStore.id;
    prevStoreIdRef.current = currentStore.id;
    if (storeChanged) {
      const today = toISODate(new Date());
      if (selectedDate !== today) setSelectedDate(today);
      // Spec 135 — reset per-card collapse on store switch (keys are vendor-
      // scoped to the previous store). NOT reset on a same-store date change.
      // Empty set = all collapsed (the owner's default-hidden follow-up).
      setExpandedKeys(new Set());
      // Spec 138 (AC-7) — reset the inline edit buffer wholesale on store switch.
      clearReorderEdits();
      loadReorderSuggestions(today);
      return;
    }
    // Spec 138 (AC-7) — reset the inline edit buffer on a same-store as-of-date
    // change (the suggestions are for a different day). Harmless no-op on mount.
    clearReorderEdits();
    loadReorderSuggestions(selectedDate);
  }, [currentStore?.id, selectedDate, loadReorderSuggestions, clearReorderEdits]);

  const refresh = React.useCallback(() => {
    loadReorderSuggestions(selectedDate);
  }, [loadReorderSuggestions, selectedDate]);

  // Spec 087 — derive the order-out filter + active-days highlight + the
  // client-recomputed KPIs from the pure util. The `orderSchedule` slice is
  // hydrated per focal store by `loadFromSupabase`, so it's already the
  // focal store's schedule by the time this section is interactable.
  const activeWeekdays = React.useMemo(
    () => activeWeekdaysFromSchedule(orderSchedule),
    [orderSchedule],
  );
  const selectedWeekday = React.useMemo(() => weekdayName(selectedDate), [selectedDate]);
  const { primary, noSchedule } = React.useMemo(
    () =>
      selectedWeekday
        ? partitionReorderVendors(reorderPayload?.vendors, orderSchedule, selectedWeekday)
        : { primary: [], noSchedule: [] },
    [reorderPayload?.vendors, orderSchedule, selectedWeekday],
  );
  // Spec 130 — pull vendors with no submitted EOD count OUT of the needs/enough
  // split BEFORE it runs, so their stale (on_hand=0 → order N) lines can't
  // inflate the KPIs / est-cost totals and can't double-render across the
  // needs+enough sections. They render in a dedicated "Count not submitted"
  // group at the TOP of the list (below).
  const countedPrimary = React.useMemo(
    () => primary.filter((v) => !isReorderCountNotSubmitted(v)),
    [primary],
  );
  const notSubmittedPrimary = React.useMemo(
    () => primary.filter((v) => isReorderCountNotSubmitted(v)),
    [primary],
  );
  // Spec (2026-07) — split the counted vendors into the two sections. Needs-
  // order (below par) items drive the KPIs + export EXACTLY as before; enough-
  // stock items (surfaced by include_stocked) render in the green section only.
  // Spec 138 (AC-6) — overlay the inline edit buffer AFTER the needs/enough
  // split (editing an order qty never changes the below-par classification),
  // so the cards, est-cost, exports, and the KPI strip all reflect edited qty.
  const needsOrderVendors = React.useMemo(
    () => applyEdits(splitReorderVendorsByNeed(countedPrimary, true)),
    [countedPrimary, applyEdits],
  );
  const enoughStockVendors = React.useMemo(
    () => applyEdits(splitReorderVendorsByNeed(countedPrimary, false)),
    [countedPrimary, applyEdits],
  );
  const kpis = React.useMemo(() => computeReorderKpis(needsOrderVendors), [needsOrderVendors]);

  // Spec 087 — secondary "no schedule" group is collapsed by default.
  const [noScheduleOpen, setNoScheduleOpen] = React.useState(false);

  // Spec 135 — per-card collapse state, section-level so it survives the
  // debounced realtime payload reloads (a re-render doesn't remount
  // ReorderSection). Keyed on the SAME group-qualified render key used below
  // (`need-` / `ok-` / `nosched-`), NOT the bare vendorId — a vendor can appear
  // in both the needs and enough groups and each card collapses independently.
  // Per-session only: no localStorage / backend persistence; resets on store
  // switch (below) and on unmount/remount for free.
  // OWNER FOLLOW-UP (2026-07-21): cards start COLLAPSED — the page opens as a
  // scannable vendor summary. Tracked as EXPANDED keys so the empty default
  // set means all-collapsed (and the store-switch reset re-collapses).
  const [expandedKeys, setExpandedKeys] = React.useState<Set<string>>(() => new Set());
  const toggleCollapsed = React.useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Spec 025 §3.B — Export CSV / PDF buttons. Web-only. Hidden when there is
  // no usable data. Gate on the FILTERED primary length so the buttons hide
  // when the day-filtered list is empty. (Spec 123 removed the global export
  // memo — exports are now per-vendor, narrowed at the card via
  // narrowReorderToVendor; this flag only decides whether the per-vendor
  // buttons render.)
  const showExport =
    Platform.OS === 'web' &&
    !!reorderPayload &&
    countedPrimary.length > 0 &&
    !reorderError &&
    !(reorderLoading && !reorderPayload);

  // Spec 087 (E) — no-focal-store guard. Placed AFTER all hooks so the
  // hook count stays stable across renders. Mirrors OrderScheduleSection /
  // EODCountSection: the reorder RPC is `p_store_id`-scoped and can't run
  // for the "All brands" placeholder (`currentStore.id === ''`).
  if (!currentStore?.id || currentStore.id === '__all__') {
    return (
      <View
        testID="reorder-no-store"
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 13, color: C.fg2 }}>
          {T('section.reorder.selectStore')}
        </Text>
      </View>
    );
  }

  return (
    <View testID="reorder-root" style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[
          { id: 'reorder.tsx', label: 'reorder.tsx' },
        ]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            {/* Spec 087 — calendar control, left of CSV/PDF/REFRESH. */}
            <ReorderDatePicker
              value={selectedDate}
              onChange={setSelectedDate}
              maxDate={maxDate}
              activeWeekdays={activeWeekdays}
            />
            {/* Spec 123 — the global CSV/PDF export buttons moved into each
                vendor card footer (per-vendor export). The date picker + REFRESH
                remain here. */}
            <TouchableOpacity
              testID="reorder-refresh"
              onPress={refresh}
              disabled={reorderLoading}
              accessibilityRole="button"
              accessibilityLabel="Refresh reorder list"
              style={{
                paddingVertical: 4,
                paddingHorizontal: 10,
                borderWidth: 1,
                borderColor: C.borderStrong,
                borderRadius: CmdRadius.sm,
                opacity: reorderLoading ? 0.5 : 1,
              }}
            >
              <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>
                {reorderLoading ? 'LOADING…' : 'REFRESH'}
              </Text>
            </TouchableOpacity>
          </View>
        }
      />

      <ScrollView contentContainerStyle={{ padding: 22, gap: 14, paddingBottom: 80 }}>
        {/* Hero */}
        <View>
          <Text style={[Type.h1, { color: C.fg }]}>{T('section.reorder.title')}</Text>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            Per-vendor delivery list. On-hand uses today's EOD count when available
            (fallback: last-known stock). Suggested qty = max(par_replacement,
            usage_forecasted), accounting for inbound POs.
          </Text>
          {reorderPayload?.asOfDate ? (
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, marginTop: 4 }}>
              as of {reorderPayload.asOfDate}
            </Text>
          ) : null}
        </View>

        {/* Stat strip */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatCard label="Vendors" value={String(kpis.vendorCount)} sub="suggesting today" />
          <StatCard label="Items" value={String(kpis.itemCount)} sub="below par or forecast" />
          <StatCard label="Est. total" value={formatMoney(kpis.totalEstimatedCost)} sub="at current cost" />
          {/* Spec 130 — the "stock fallback" sub-stat is now structurally ~0
              (un-counted vendors are pulled into the "Count not submitted"
              group), so surface the count of not-submitted vendors instead —
              a meaningful "N EOD-sourced / M count not submitted". */}
          <StatCard
            label="On-hand source"
            value={`${kpis.eodSourcedVendorCount} EOD`}
            sub={`${notSubmittedPrimary.length} ${T('section.reorder.countNotSubmittedKpiSub')}`}
          />
        </View>

        {/* Warnings (vendor-without-schedule etc.) */}
        {reorderPayload?.warnings && reorderPayload.warnings.length > 0 ? (
          <View
            style={{
              backgroundColor: C.warnBg,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.warn,
              paddingVertical: 10,
              paddingHorizontal: 14,
              gap: 4,
            }}
          >
            <SectionCaption tone="fg2" size={10}>
              warnings · {reorderPayload.warnings.length}
            </SectionCaption>
            {reorderPayload.warnings.map((w, idx) => (
              <Text key={`${w.code}-${idx}`} style={{ fontFamily: mono(400), fontSize: 11, color: C.warn }}>
                · {w.message || w.code}
              </Text>
            ))}
          </View>
        ) : null}

        {/* Error pane */}
        {reorderError ? (
          <View
            style={{
              backgroundColor: C.dangerBg,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.danger,
              paddingVertical: 12,
              paddingHorizontal: 14,
              gap: 4,
            }}
          >
            <SectionCaption tone="fg2" size={10}>
              load failed
            </SectionCaption>
            <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.danger }}>{reorderError}</Text>
            <TouchableOpacity
              onPress={refresh}
              style={{
                marginTop: 6,
                alignSelf: 'flex-start',
                paddingVertical: 4,
                paddingHorizontal: 10,
                borderWidth: 1,
                borderColor: C.danger,
                borderRadius: CmdRadius.sm,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.danger }}>RETRY</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Empty state — the payload itself has no suggestions at all for
            the selected date (no EOD, all at par, or no active vendors). */}
        {!reorderLoading && !reorderError && !!reorderPayload && reorderPayload.vendors.length === 0 ? (
          <View
            style={{
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              paddingVertical: 36,
              paddingHorizontal: 22,
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>
              NO REORDER SUGGESTIONS
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 480 }}>
              No reorder suggestions for this store on this date. Could be: no EOD counts done yet,
              all items at par, or no active vendors.
            </Text>
          </View>
        ) : null}

        {/* Spec 087 — day-filter empty state: the payload HAS suggestions
            but none of them are ordered out on the selected weekday. Distinct
            from "NO REORDER SUGGESTIONS" so the user understands the list is
            empty because of the day filter, not missing EOD / all-at-par. The
            secondary "no schedule" group below still renders when non-empty. */}
        {!reorderLoading &&
        !reorderError &&
        !!reorderPayload &&
        reorderPayload.vendors.length > 0 &&
        primary.length === 0 ? (
          <View
            testID="reorder-empty-day"
            style={{
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              paddingVertical: 36,
              paddingHorizontal: 22,
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>
              NOTHING TO ORDER
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 480 }}>
              {selectedWeekday
                ? T('section.reorder.noVendorsForDay', { day: dayOfWeekLongLabel(selectedWeekday, T) })
                : T('section.reorder.noVendorsForDay', { day: '' })}
            </Text>
          </View>
        ) : null}

        {/* Initial loading state — no payload yet */}
        {reorderLoading && !reorderPayload ? (
          <View
            style={{
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              paddingVertical: 36,
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>LOADING…</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2 }}>
              fetching reorder suggestions
            </Text>
          </View>
        ) : null}

        {/* Spec 130 — "Count not submitted" group, at the TOP of the list. A
            vendor with no submitted EOD count for the date renders here (its
            header + a "Count not submitted yet" block); its stale suppressed
            lines never reach the KPIs or the needs/enough split. No dollar
            total on the group. */}
        {notSubmittedPrimary.length > 0 ? (
          <>
            <Text
              testID="reorder-section-count-not-submitted"
              style={{ fontFamily: mono(700), fontSize: 11, color: C.violet, letterSpacing: 0.5, textTransform: 'uppercase' }}
            >
              {T('section.reorder.countNotSubmittedGroupTitle')} · {notSubmittedPrimary.length}
            </Text>
            {notSubmittedPrimary.map((v) => (
              <VendorCard key={`nosub-${v.vendorId}`} vendor={v} needsOrder />
            ))}
          </>
        ) : null}

        {/* "Needs to Order" section — below-par items, red. */}
        {needsOrderVendors.length > 0 ? (
          <>
            <Text
              testID="reorder-section-needs"
              style={{ fontFamily: mono(700), fontSize: 11, color: C.danger, letterSpacing: 0.5, textTransform: 'uppercase' }}
            >
              {T('section.reorder.needsToOrder')}
            </Text>
            {needsOrderVendors.map((v) => {
              const k = `need-${v.vendorId}`;
              return (
                <VendorCard
                  key={k}
                  vendor={v}
                  needsOrder
                  showExport={showExport}
                  collapsible
                  collapseKey={k}
                  collapsed={!expandedKeys.has(k)}
                  onToggleCollapse={() => toggleCollapsed(k)}
                />
              );
            })}
          </>
        ) : null}

        {/* "Have enough stock" section — at/above-par items, green. */}
        {enoughStockVendors.length > 0 ? (
          <>
            <Text
              testID="reorder-section-enough"
              style={{ fontFamily: mono(700), fontSize: 11, color: C.ok, letterSpacing: 0.5, textTransform: 'uppercase' }}
            >
              {T('section.reorder.haveEnough')}
            </Text>
            {enoughStockVendors.map((v) => {
              const k = `ok-${v.vendorId}`;
              return (
                <VendorCard
                  key={k}
                  vendor={v}
                  needsOrder={false}
                  showExport={showExport}
                  collapsible
                  collapseKey={k}
                  collapsed={!expandedKeys.has(k)}
                  onToggleCollapse={() => toggleCollapsed(k)}
                />
              );
            })}
          </>
        ) : null}

        {/* Spec 087 (A) — secondary "no schedule" group. Vendors with no
            `order_schedule` row (the report's 7-day fallback) have no
            order-out weekday, so they can't satisfy "I order today" — but
            they don't silently vanish. Collapsed by default; independent of
            the selected weekday. */}
        {noSchedule.length > 0 ? (
          <View style={{ gap: 14 }}>
            <TouchableOpacity
              testID="reorder-no-schedule-toggle"
              onPress={() => setNoScheduleOpen((o) => !o)}
              accessibilityRole="button"
              accessibilityState={{ expanded: noScheduleOpen }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingVertical: 10,
                paddingHorizontal: 14,
                backgroundColor: C.panel,
                borderRadius: CmdRadius.lg,
                borderWidth: 1,
                borderColor: C.border,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>
                {noScheduleOpen ? '▾' : '▸'}
              </Text>
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg2, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                {T('section.reorder.noScheduleGroupTitle')} · {noSchedule.length}
              </Text>
              <View style={{ flex: 1 }} />
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                {T('section.reorder.noScheduleGroupHint')}
              </Text>
            </TouchableOpacity>
            {noScheduleOpen
              ? applyEdits(splitReorderVendorsByNeed(noSchedule, true)).map((v) => {
                  const k = `nosched-${v.vendorId}`;
                  return (
                    <VendorCard
                      key={k}
                      vendor={v}
                      needsOrder
                      showExport={showExport}
                      collapsible
                      collapseKey={k}
                      collapsed={!expandedKeys.has(k)}
                      onToggleCollapse={() => toggleCollapsed(k)}
                    />
                  );
                })
              : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

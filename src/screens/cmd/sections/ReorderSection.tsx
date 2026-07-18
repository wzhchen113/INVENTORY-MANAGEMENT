import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Platform } from 'react-native';
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
// v2 contract notes (spec 107 landed the loop):
//   - `pending_po_qty` is now a REAL open-PO aggregate server-side (both
//     reorder engines) — an open (sent/partial) PO reduces the suggestion
//     for its items. The "inbound" segment renders the live value.
//   - "Create PO" is ENABLED: it creates an editable DRAFT PO from the
//     vendor card (lines prefilled from the suggested cases, per-counted-unit
//     cost snapshot) via `createPoDraft`, behind a confirm. The operator then
//     edits/sends it in the Purchase Orders section (spec 107 §5/§8).
//   - Vendors with zero suggested items are filtered out server-side;
//     a true empty state means either no EOD has been done, every
//     active item is at par, or the store has no active vendors at all.

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Spec 123 — the reorder RPC emits a per-vendor `has_po` flag (mapped to `hasPo`
// on `ReorderVendor` in src/lib/db.ts), true when a non-cancelled purchase_orders
// row exists for (store, vendor, reorder date). Drives the persistent, disabled
// "PO CREATED" state. Read via `?? false` so an older envelope (no field) is
// treated as "no PO" → shows "+ CREATE PO".
const vendorHasPo = (v: ReorderVendor): boolean => v.hasPo ?? false;

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
  const border = tone === 'fg3' ? C.border : 'transparent';
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: CmdRadius.sm,
        backgroundColor: bg,
        borderWidth: border === 'transparent' ? 0 : 1,
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
      <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, borderWidth: 1, borderColor: C.border }}>
        <Text style={{ fontFamily: mono(600), fontSize: 9, color: C.fg3 }}>{token}</Text>
      </View>
    );
  }
  const bg = entry.tone === 'warn' ? C.warnBg : 'transparent';
  const fg = entry.tone === 'warn' ? C.warn : C.fg3;
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 3,
        backgroundColor: bg,
        borderWidth: entry.tone === 'fg3' ? 1 : 0,
        borderColor: C.border,
      }}
    >
      <Text style={{ fontFamily: mono(600), fontSize: 9, color: fg, letterSpacing: 0.3 }}>{entry.label}</Text>
    </View>
  );
}

// Spec 107 §5/§8 — "+ Create PO" creates an editable DRAFT PO from the vendor
// card behind a confirm dialog (a draft is benign, but a confirm avoids
// accidental double-drafts). On success it toasts and points the user to the
// Purchase Orders section to edit/send. Disabled while the create is in flight.
function CreatePoButton({ vendor }: { vendor: ReorderVendor }) {
  const C = useCmdColors();
  const T = useT();
  const createPoDraft = useStore((s) => s.createPoDraft);
  const [busy, setBusy] = React.useState(false);

  // Spec 123 — a PO already exists for (store, this vendor, the reorder date).
  // Render a disabled, muted "PO CREATED" chip (hard duplicate-prevention) with
  // no press handler so a second draft can't be created for the same key. The
  // flag is server-derived + date-keyed, so it persists across REFRESH/reload
  // and flips back to "+ CREATE PO" when the date picker points at a date with
  // no PO for this vendor.
  if (vendorHasPo(vendor)) {
    return (
      <View
        testID={`reorder-create-po-${vendor.vendorId}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: true }}
        accessibilityLabel={T('section.reorder.poCreatedAria', { vendor: vendor.vendorName || '' })}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: C.border,
          backgroundColor: C.panel2,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.3 }}>
          {T('section.reorder.poCreatedLabel')}
        </Text>
      </View>
    );
  }

  const onPress = () => {
    if (busy) return;
    const vendorName = vendor.vendorName || 'this vendor';
    confirmAction(
      T('section.reorder.createPoConfirmTitle'),
      T('section.reorder.createPoConfirmBody', { vendor: vendorName, count: vendor.items.length }),
      () => {
        setBusy(true);
        void createPoDraft(vendor)
          .then((poId) => {
            if (poId) {
              Toast.show({
                type: 'success',
                text1: T('section.reorder.createPoToastTitle'),
                text2: T('section.reorder.createPoToastBody', { vendor: vendorName }),
                visibilityTime: 4000,
              });
            }
          })
          .finally(() => setBusy(false));
      },
      T('section.reorder.createPoConfirmCta'),
    );
  };

  return (
    <TouchableOpacity
      testID={`reorder-create-po-${vendor.vendorId}`}
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={T('section.reorder.createPoAria', { vendor: vendor.vendorName || '' })}
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
        {busy ? T('section.reorder.createPoBusy') : T('section.reorder.createPoLabel')}
      </Text>
    </TouchableOpacity>
  );
}

// Spec 115 (W-3) — the Reorder-card "Quick-order list" export handler + button.
// Pre-PO sibling to `CreatePoButton`: reuses the SAME (W-2-extended)
// `buildPoQuickOrderText` builder + the spec-108 `sharePurchaseOrder`
// orchestrator, sourced from the card's suggested order
// (`ReorderItem.suggestedUnits` + `caseQty`). AC-17 posture: NO PO exists, so NO
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
      const { previewText } = await sharePurchaseOrder(text, {
        dialogTitle: T('section.purchaseOrders.quickOrderDialogTitle'),
        onCopyToast: () => Toast.show({ type: 'success', text1: T('section.purchaseOrders.quickOrderCopiedToast') }),
      });
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

  const onCsv = () => {
    if (!reorderPayload || !currentStore) return;
    const narrowed = narrowReorderToVendor(reorderPayload, vendor);
    const importCfg = pickImportVendor(narrowed, vendorsList);
    if (importCfg) {
      handleImportExport(narrowed, currentStore, importCfg, inventory);
      return;
    }
    void handleCsvExport(narrowed, currentStore, locale);
  };

  const onPdf = () => {
    if (!reorderPayload || !currentStore) return;
    void handlePdfExport(narrowReorderToVendor(reorderPayload, vendor), currentStore, locale);
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
function VendorCard({ vendor, needsOrder, showExport }: { vendor: ReorderVendor; needsOrder: boolean; showExport?: boolean }) {
  const C = useCmdColors();
  const T = useT();
  const itemTone = needsOrder ? C.danger : C.ok;
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

  // Spec 130 — a vendor whose EOD count was NOT submitted for the reorder date.
  // Its per-item order quantities are computed off a stale current_stock
  // fallback, so we render the header (name + next-delivery + badges) but
  // REPLACE the column strip / item rows / footer actions with a
  // "Count not submitted yet" state block. This branch renders no
  // BreakdownLine rows and none of the four per-vendor actions (Create PO /
  // Quick-order / CSV / PDF) — they all live in the footer this branch omits.
  if (isReorderCountNotSubmitted(vendor)) {
    return (
      <View
        style={{
          backgroundColor: C.panel,
          borderRadius: CmdRadius.lg,
          borderWidth: 1,
          borderColor: C.warn,
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
          style={{ paddingHorizontal: 16, paddingVertical: 28, alignItems: 'center', gap: 8 }}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 22, color: C.warn }}>⊘</Text>
          <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.warn, letterSpacing: 0.4, textTransform: 'uppercase' }}>
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
        {headerNameRow}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
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

      {/* Column header strip */}
      <View
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
        {/* Spec 123 — per-vendor CSV/PDF export (web-only, showExport-gated). */}
        {showExport ? <ReorderVendorExportButtons vendor={vendor} /> : null}
        {/* Spec 115 (W-3) — Quick-order list export, next to Create PO. */}
        <ReorderQuickOrderButton vendor={vendor} onPreview={setQuickPreview} />
        <CreatePoButton vendor={vendor} />
      </View>

      {/* Spec 115 (W-3) — desktop-web quick-order preview (clipboard fallback),
          rendered as a normal in-card block below the footer. */}
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

async function handleCsvExport(payload: ReorderPayload, store: Store, locale: Locale): Promise<void> {
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
  } catch (e: any) {
    console.warn('[ReorderSection] CSV export failed:', e?.message || e);
    Toast.show({
      type: 'error',
      text1: 'CSV export failed',
      text2: e?.message || 'Unable to build the CSV file',
      visibilityTime: 4000,
    });
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

function handleImportExport(
  payload: ReorderPayload,
  store: Store,
  cfg: Vendor,
  inventory: InventoryItem[],
): void {
  const label = cfg.orderImportFormat === 'sysco' ? 'SYSCO order' : 'US Foods import';
  try {
    const resolveCode = (item: ReorderItem): string | null | undefined =>
      inventory.find((i) => i.id === item.itemId)?.vendors?.find((v) => v.vendorId === cfg.id)?.orderCode;
    const plan =
      cfg.orderImportFormat === 'sysco'
        ? planSyscoExport(payload, store.id, store.name, cfg, resolveCode)
        : planUsFoodsExport(payload, store.id, store.name, cfg, resolveCode);
    emitImportPlan(plan, label);
  } catch (e: any) {
    console.warn(`[ReorderSection] ${label} export failed:`, e?.message || e);
    Toast.show({
      type: 'error',
      text1: `${label} export failed`,
      text2: e?.message || 'Unable to build the import file',
      visibilityTime: 4000,
    });
  }
}

// Spec 025 AC5 — jsPDF + jspdf-autotable dynamic-imported per legacy
// pattern so the bundle stays lean for users who never click "PDF".
async function handlePdfExport(payload: ReorderPayload, store: Store, localeIn: Locale): Promise<void> {
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
  } catch (e: any) {
    console.warn('[ReorderSection] PDF export failed:', e?.message || e);
    Toast.show({
      type: 'error',
      text1: 'PDF export failed',
      text2: e?.message || 'Unable to build the PDF file',
      visibilityTime: 4000,
    });
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
      loadReorderSuggestions(today);
      return;
    }
    loadReorderSuggestions(selectedDate);
  }, [currentStore?.id, selectedDate, loadReorderSuggestions]);

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
  const needsOrderVendors = React.useMemo(
    () => splitReorderVendorsByNeed(countedPrimary, true),
    [countedPrimary],
  );
  const enoughStockVendors = React.useMemo(
    () => splitReorderVendorsByNeed(countedPrimary, false),
    [countedPrimary],
  );
  const kpis = React.useMemo(() => computeReorderKpis(needsOrderVendors), [needsOrderVendors]);

  // Spec 087 — secondary "no schedule" group is collapsed by default.
  const [noScheduleOpen, setNoScheduleOpen] = React.useState(false);

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
              style={{ fontFamily: mono(700), fontSize: 11, color: C.warn, letterSpacing: 0.5, textTransform: 'uppercase' }}
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
            {needsOrderVendors.map((v) => (
              <VendorCard key={`need-${v.vendorId}`} vendor={v} needsOrder showExport={showExport} />
            ))}
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
            {enoughStockVendors.map((v) => (
              <VendorCard key={`ok-${v.vendorId}`} vendor={v} needsOrder={false} showExport={showExport} />
            ))}
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
              ? splitReorderVendorsByNeed(noSchedule, true).map((v) => (
                  <VendorCard key={v.vendorId} vendor={v} needsOrder showExport={showExport} />
                ))
              : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

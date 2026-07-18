// src/screens/staff/screens/Reorder.tsx — the staff Reorder screen.
//
// Spec 089 (B)(D)(F). Full parity with the admin Reorder section, reflowed
// for a portrait phone in the staff OS-light/dark theme:
//   - per-vendor cards with the by-the-case Suggested display (spec 088)
//   - the order-out calendar look-back + filter (spec 087)
//   - KPI cards (client-recomputed from the filtered PRIMARY set)
//   - the four states (loading / empty / nothing-to-order / error)
//   - cross-platform CSV + text + PDF export/share (spec 089 (C) Option 2)
//
// Scope: the manager's `activeStore` (shared with EOD — decision F). Gated
// on an active store; re-fetches on store switch + date change + manual
// Refresh. Data via the staff carve-out (`fetchReorder.ts`), screen-local
// `useState` (no useStaffStore slice — decision B). Read-only for data +
// export; no PO write-path.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner } from '../components/Banner';
import { SettingsGear } from '../components/SettingsGear';
import { NotificationReminderBanner } from '../components/NotificationReminderBanner';
import { ReorderDatePicker } from '../components/ReorderDatePicker';
import { notifyBackendError } from '../lib/notifyBackendError';
import { fetchStaffOrderSchedule, fetchStaffReorder } from '../lib/fetchReorder';
import {
  shareReorderCsv,
  shareReorderPdf,
  shareReorderText,
} from '../lib/shareReorder';
import { useStaffStore } from '../store/useStaffStore';
import { todayIso } from '../lib/date';
import { getLocalizedName } from '../../../i18n/localizedName';
import type { Locale } from '../../../i18n';
import { t, useI18n } from '../i18n';
import {
  useStaffColors,
  useStaffElevation,
  useStaffTokens,
  type StaffTokens,
} from '../theme';
import { formatQty } from '../../../utils/reorderExport';
import {
  activeWeekdaysFromSchedule,
  computeReorderKpis,
  isReorderCountNotSubmitted,
  partitionReorderVendors,
  splitReorderVendorsByNeed,
  weekdayName,
} from '../../../utils/reorderDayFilter';
import type { DayName } from '../../../utils/enumLabels';
import type { OrderSchedule, ReorderItem, ReorderPayload, ReorderVendor } from '../../../types';

// Localized long weekday name via the staff catalog (`reorder.weekday.*`),
// keyed off the canonical English DayName. Self-contained — does NOT reuse
// the admin `dayOfWeekLongLabel`, which expects admin-only `enum.dayOfWeek.*`
// keys absent from the staff catalog. Takes a `t` so the caller can pass
// the reactive `useI18n()` t (spec 099).
function weekdayLabel(tt: typeof t, day: DayName): string {
  return tt(`reorder.weekday.${day.toLowerCase()}`);
}

// ── Staff-render-only unit localization (spec 100, Q-A=A2 / Q-B=B1) ──
// `reorderExport.ts` (the shared admin + byte-for-byte export builder) is
// NOT touched. The staff screen composes its OWN suggested-order strings
// from the same server-authoritative numeric fields the util reads, so the
// case noun can be localized and the raw `unit` token casing-normalized
// WITHOUT regressing the admin desktop UI or the CSV/text/PDF exports.

// Display-only lowercase normalization of the free-text `catalog_ingredients.unit`
// token (e.g. "CASE" → "case", "LB" → "lb"). Render-path only — never written
// back to the DB. Not applied inside the shared util / export builders.
function normalizeUnit(u: string): string {
  return u.trim().toLowerCase();
}

// Localized + casing-normalized "main" suggested-order figure. For case items
// the NOUN is keyed (`reorder.unit.case` / `.cases`, branched on count===1 —
// the staff t() has no ICU plural selection, mirroring the util's own
// `cases === 1 ? 'case' : 'cases'` test). Non-case items render the raw qty +
// the casing-normalized unit token.
function suggestedMainLabel(item: ReorderItem, tt: typeof t): string {
  if (item.suggestedCases != null) {
    const key = item.suggestedCases === 1 ? 'reorder.unit.case' : 'reorder.unit.cases';
    return tt(key, { count: formatQty(item.suggestedCases) });
  }
  return `${formatQty(item.suggestedQty)} ${normalizeUnit(item.unit)}`.trim();
}

// The secondary base-unit total shown beside the case figure (`null` for
// non-case items — nothing to subordinate). Casing-normalized unit token.
// Suppressed when the base unit is itself "case"/"cases" (2026-07): the figure
// would read "N cases · M cases", repeating the noun — show just "N cases".
function suggestedSubLabel(item: ReorderItem): string | null {
  if (item.suggestedCases == null) return null;
  const unit = normalizeUnit(item.unit);
  if (unit === 'case' || unit === 'cases') return null;
  return `${formatQty(item.suggestedUnits)} ${unit}`.trim();
}

// "Have enough stock" section — the on-hand figure shown in CASES for case-size
// items (owner request 2026-07: show how many cases are in stock), else the
// base-unit on-hand. Mirrors suggestedMainLabel's case-noun localization.
function inStockLabel(item: ReorderItem, tt: typeof t): string {
  if (item.caseQty > 1) {
    const cases = item.onHand / item.caseQty;
    const key = cases === 1 ? 'reorder.unit.case' : 'reorder.unit.cases';
    return tt(key, { count: formatQty(cases) });
  }
  return `${formatQty(item.onHand)} ${normalizeUnit(item.unit)}`.trim();
}

// ── KPI card ──────────────────────────────────────────────────────
function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  const c = useStaffColors();
  const e = useStaffElevation();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  return (
    <View style={[styles.kpiCard, { backgroundColor: c.surface, borderColor: c.border }, e.card]}>
      <Text style={[styles.kpiLabel, { color: c.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.kpiValue, { color: c.text }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.kpiSub, { color: c.textTertiary }]} numberOfLines={1}>
        {sub}
      </Text>
    </View>
  );
}

// ── per-vendor card (mobile reflow of the admin VendorCard) ─────────
// `needsOrder` selects the section tone: true → below-par items (red name +
// "Order: N" line); false → at/above-par items (green name + "Enough stock").
function VendorCard({ vendor, needsOrder }: { vendor: ReorderVendor; needsOrder: boolean }) {
  const c = useStaffColors();
  const e = useStaffElevation();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  const itemTone = needsOrder ? c.error : c.success;
  // Reactive locale slice — item names resolve via getLocalizedName(item,
  // locale), so reading it directly re-renders the list labels on a locale
  // switch (the spec-099 pattern, identical to EODCount).
  const locale = useStaffStore((s) => s.locale);

  // Spec 100 (Q-C=C2) — the "EOD" badge routes through the catalog, mirroring
  // its already-keyed `stockFallback` sibling. Vendor names stay English.
  const sourceLabel =
    vendor.onHandSource === 'eod' ? t('reorder.source.eod') : t('reorder.source.stockFallback');
  const sourceTone = vendor.onHandSource === 'eod' ? c.success : c.warning;
  const sourceBg = vendor.onHandSource === 'eod' ? c.successBg : c.warningBg;

  const daysLabel =
    vendor.daysUntilNextDelivery === 0
      ? t('reorder.delivery.today')
      : vendor.daysUntilNextDelivery === 1
        ? t('reorder.delivery.tomorrow')
        : t('reorder.delivery.inDays', { days: vendor.daysUntilNextDelivery });

  // Spec 130 — shared vendor header (name + source badge + next-delivery line).
  // Byte-identical between the counted branch and the not-submitted branch, so
  // it's factored out here and rendered by BOTH. No visual change to the
  // counted card — same markup, just deduped.
  const header = (
    <View style={styles.vendorHeader}>
      <View style={styles.vendorTitleRow}>
        <Text style={[styles.vendorName, { color: c.text }]} numberOfLines={2}>
          {vendor.vendorName || t('reorder.vendor.unnamed')}
        </Text>
        <View style={[styles.badge, { backgroundColor: sourceBg }]}>
          <Text style={[styles.badgeText, { color: sourceTone }]}>{sourceLabel}</Text>
        </View>
      </View>
      <Text style={[styles.vendorMeta, { color: c.textSecondary }]}>
        {t('reorder.vendor.nextDelivery', {
          date: vendor.nextDeliveryDate || '—',
          days: daysLabel,
        })}
      </Text>
    </View>
  );

  // Spec 130 — a vendor whose EOD count was NOT submitted for the reorder date.
  // Its per-item order quantities are computed off a stale current_stock
  // fallback, so we keep the header (name + badge + next-delivery) but REPLACE
  // the item rows + the item-count footer with a "Count not submitted yet"
  // state block. No order/enough rows render for such a vendor.
  if (isReorderCountNotSubmitted(vendor)) {
    return (
      <View
        testID={`staff-reorder-vendor-${vendor.vendorId}`}
        style={[styles.vendorCard, { backgroundColor: c.surface, borderColor: c.warning }, e.card]}
      >
        {header}
        <View
          testID={`staff-reorder-count-not-submitted-${vendor.vendorId}`}
          style={styles.notSubmittedBlock}
        >
          <Text style={[styles.notSubmittedGlyph, { color: c.warning }]}>⊘</Text>
          <Text style={[styles.notSubmittedTitle, { color: c.warning }]}>
            {t('reorder.countNotSubmitted.title')}
          </Text>
          <Text style={[styles.notSubmittedBody, { color: c.textTertiary }]}>
            {t('reorder.countNotSubmitted.body')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      testID={`staff-reorder-vendor-${vendor.vendorId}`}
      style={[styles.vendorCard, { backgroundColor: c.surface, borderColor: c.border }, e.card]}
    >
      {/* Vendor header — shared with the not-submitted branch (spec 130). */}
      {header}

      {/* Items — stacked rows (mobile analog of the desktop BreakdownLine) */}
      {vendor.items.map((item: ReorderItem, i: number) => {
        // Main case unit reads first; the base-unit subunit is rendered
        // smaller + non-bold + muted so order-placers aren't confused. Spec
        // 100: the case noun is localized + the raw unit token casing-
        // normalized via the staff-local helpers (NOT the shared util).
        const suggestedMain = suggestedMainLabel(item, t);
        const suggestedSub = suggestedSubLabel(item);
        return (
          <View
            key={item.itemId}
            style={[
              styles.itemRow,
              i === 0 ? null : { borderTopWidth: 1, borderTopColor: c.border },
            ]}
          >
            {/* Left column: name + on-hand/par + coincident-schedule hint.
                Right column: the suggested-order figure, aligned to the screen
                edge so order-placers can scan quantities down the right side. */}
            <View style={styles.itemMain}>
              {/* Owner decision (2026-07): staff see order quantities only — no
                  per-item cost. Spec 100 — resolve the display name in the
                  active locale (silent English fallback). Adapter:
                  ReorderItem.itemName ≠ the helper's `name` field, so shape it
                  the way EOD/Weekly do. */}
              {/* Red name for needs-order rows, green for enough-stock rows. */}
              <Text style={[styles.itemName, { color: itemTone }]} numberOfLines={2}>
                {getLocalizedName({ name: item.itemName, i18nNames: item.i18nNames }, locale)}
              </Text>
              <Text style={[styles.itemBreakdown, { color: c.textSecondary }]}>
                {t('reorder.item.breakdown', {
                  onHand: `${formatQty(item.onHand)} ${normalizeUnit(item.unit)}`.trim(),
                  par: `${formatQty(item.parLevel)} ${normalizeUnit(item.unit)}`.trim(),
                })}
              </Text>
              {/* Spec 102 (OQ-1) — coincident-schedule hint. When this shared
                  item is also scheduled under other vendors today it appears
                  under each of their cards; surface "also available from N" so
                  the manager orders it from ONE vendor, not several. Advisory
                  only — does not change which card the item is on. Renders
                  nothing for a single-vendor item (otherVendorCount 0). */}
              {(item.otherVendorCount ?? 0) > 0 && (item.alsoFromVendors?.length ?? 0) > 0 ? (
                <Text
                  style={[styles.itemAlsoFrom, { color: c.textTertiary }]}
                  testID={`reorder-also-from-${item.itemId}`}
                >
                  {item.otherVendorCount === 1
                    ? t('reorder.item.alsoFromOne', {
                        vendors: (item.alsoFromVendors ?? []).map((v) => v.vendorName).join(', '),
                      })
                    : t('reorder.item.alsoFromMany', {
                        count: item.otherVendorCount ?? 0,
                        vendors: (item.alsoFromVendors ?? []).map((v) => v.vendorName).join(', '),
                      })}
                </Text>
              ) : null}
            </View>
            {needsOrder ? (
              <Text style={[styles.itemOrder, { color: itemTone }]}>
                {t('reorder.item.order', { suggested: suggestedMain })}
                {suggestedSub ? (
                  <Text style={[styles.itemOrderSub, { color: c.textSecondary }]}>
                    {' · '}
                    {suggestedSub}
                  </Text>
                ) : null}
              </Text>
            ) : (
              <Text style={[styles.itemOrder, { color: itemTone }]}>
                {t('reorder.item.inStock', { qty: inStockLabel(item, t) })}
              </Text>
            )}
          </View>
        );
      })}

      {/* Footer — item count only (no cost, per the staff quantities-only rule). */}
      <View style={[styles.vendorFooter, { borderTopColor: c.border }]}>
        <Text style={[styles.vendorFooterText, { color: c.textSecondary }]}>
          {t('reorder.vendor.subtotal', { count: vendor.items.length })}
        </Text>
      </View>
    </View>
  );
}

// ── empty/loading state card ────────────────────────────────────────
function StateCard({ title, body, testID }: { title: string; body: string; testID?: string }) {
  const c = useStaffColors();
  const e = useStaffElevation();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  return (
    <View
      testID={testID}
      style={[styles.stateCard, { backgroundColor: c.surface, borderColor: c.border }, e.card]}
    >
      <Text style={[styles.stateTitle, { color: c.textSecondary }]}>{title}</Text>
      <Text style={[styles.stateBody, { color: c.textTertiary }]}>{body}</Text>
    </View>
  );
}

// ── vendor filter chip ──────────────────────────────────────────────
function VendorChip({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.vendorChip,
        {
          backgroundColor: active ? c.primary : c.surface,
          borderColor: active ? c.primary : c.borderStrong,
        },
        pressed && !active ? { backgroundColor: c.surfaceAlt } : null,
      ]}
    >
      <Text
        style={[styles.vendorChipText, { color: active ? c.textOnPrimary : c.text }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Reorder() {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  // Reactive `t` (spec 099) — render-path strings re-translate on locale change.
  const { t } = useI18n();
  const activeStore = useStaffStore((s) => s.activeStore);
  const stores = useStaffStore((s) =>
    s.authState.kind === 'signed-in' ? s.authState.stores : [],
  );
  const setActiveStore = useStaffStore((s) => s.setActiveStore);
  // Active language — downloads follow it (2026-07).
  const locale = useStaffStore((s) => s.locale);

  // Latest selectable date = today. Computed on EVERY render (cheap string
  // build) rather than memoized once — a mount-only useMemo goes one day stale
  // if the tab is left open past midnight. Matches the admin ReorderSection
  // (`toISODate(new Date())` outside any memo).
  const maxDate = todayIso();
  const [selectedDate, setSelectedDate] = useState<string>(() => todayIso());
  const [payload, setPayload] = useState<ReorderPayload | null>(null);
  const [orderSchedule, setOrderSchedule] = useState<OrderSchedule>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [noScheduleOpen, setNoScheduleOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Vendor filter — `null` = "All" (the default grouped view). A non-null
  // id narrows the screen, the KPI strip, AND the exports to that one vendor.
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);

  const canSwitchStore = stores.length > 1;

  // ─── fetch effect — store-switch aware (mirrors ReorderSection's single
  //     as-of effect). On a STORE switch reset the calendar to today AND
  //     fetch as-of today directly (avoid the stale-as-of-on-switch bug). On
  //     mount or a calendar change for the SAME store, fetch as-of
  //     selectedDate. Order schedule + reorder fetched together (Promise.all).
  const prevStoreIdRef = useRef(activeStore?.id);
  const load = useCallback(
    (storeId: string, asOf: string) => {
      setLoading(true);
      setError(null);
      Promise.all([fetchStaffReorder(storeId, asOf), fetchStaffOrderSchedule(storeId)])
        .then(([nextPayload, nextSchedule]) => {
          setPayload(nextPayload);
          setOrderSchedule(nextSchedule);
        })
        .catch((err) => {
          notifyBackendError('fetchStaffReorder', err);
          setPayload(null);
          setOrderSchedule({});
          setError(err instanceof Error ? err.message : String(err ?? t('reorder.error.generic')));
        })
        .finally(() => setLoading(false));
    },
    [t],
  );

  useEffect(() => {
    if (!activeStore?.id) return;
    const storeChanged = prevStoreIdRef.current !== activeStore.id;
    prevStoreIdRef.current = activeStore.id;
    if (storeChanged) {
      const today = todayIso();
      if (selectedDate !== today) setSelectedDate(today);
      load(activeStore.id, today);
      return;
    }
    load(activeStore.id, selectedDate);
  }, [activeStore?.id, selectedDate, load]);

  const refresh = useCallback(() => {
    if (!activeStore?.id) return;
    load(activeStore.id, selectedDate);
  }, [activeStore?.id, selectedDate, load]);

  // ─── derived: order-out filter + active-days + client KPIs (pure utils) ──
  const activeWeekdays = useMemo(
    () => activeWeekdaysFromSchedule(orderSchedule),
    [orderSchedule],
  );
  const selectedWeekday = useMemo(() => weekdayName(selectedDate), [selectedDate]);
  const { primary, noSchedule } = useMemo(
    () =>
      selectedWeekday
        ? partitionReorderVendors(payload?.vendors, orderSchedule, selectedWeekday)
        : { primary: [], noSchedule: [] },
    [payload?.vendors, orderSchedule, selectedWeekday],
  );
  // ─── vendor filter ──────────────────────────────────────────────────
  // Chip universe = every vendor in today's view, order-today (`primary`)
  // first then the no-schedule group, so picking a chip can surface a vendor
  // from either group as a single card.
  const allVendors = useMemo(() => [...primary, ...noSchedule], [primary, noSchedule]);
  const selectedVendor = useMemo(
    () =>
      selectedVendorId
        ? allVendors.find((v) => v.vendorId === selectedVendorId) ?? null
        : null,
    [allVendors, selectedVendorId],
  );
  // A date/store change can drop the chosen vendor out of the set — fall back
  // to "All" so the highlight + filtered view stay coherent.
  useEffect(() => {
    if (selectedVendorId && !allVendors.some((v) => v.vendorId === selectedVendorId)) {
      setSelectedVendorId(null);
    }
  }, [allVendors, selectedVendorId]);

  // When a vendor is picked it becomes the WHOLE view (one card, no group);
  // "All" falls back to the order-today `primary` set, exactly as before.
  const displayVendors = useMemo(
    () => (selectedVendor ? [selectedVendor] : primary),
    [selectedVendor, primary],
  );
  // Spec 130 — pull vendors with no submitted EOD count OUT of the needs/enough
  // split + KPI + export inputs BEFORE they run, so their stale (on_hand=0 →
  // order N) lines can't inflate the KPIs or double-render. They render in a
  // dedicated "Count not submitted" group at the TOP of the list (below).
  const countedDisplay = useMemo(
    () => displayVendors.filter((v) => !isReorderCountNotSubmitted(v)),
    [displayVendors],
  );
  const notSubmittedDisplay = useMemo(
    () => displayVendors.filter((v) => isReorderCountNotSubmitted(v)),
    [displayVendors],
  );
  // Split the counted vendors into the two sections. Needs-order (below par)
  // items drive the KPIs + export EXACTLY as before; enough-stock items
  // (surfaced by include_stocked) render only in the green section.
  const needsOrderVendors = useMemo(
    () => splitReorderVendorsByNeed(countedDisplay, true),
    [countedDisplay],
  );
  const enoughStockVendors = useMemo(
    () => splitReorderVendorsByNeed(countedDisplay, false),
    [countedDisplay],
  );
  const kpis = useMemo(() => computeReorderKpis(needsOrderVendors), [needsOrderVendors]);

  // Export reflects the on-screen FILTERED + as-of view with ALL items — both
  // the "needs to order" AND "have enough stock" data (2026-07), each carrying
  // its `needsOrder` flag so the exported files match the two on-screen
  // sections and vendor/item counts. KPIs stay the needs-order figures (the
  // actionable "to order" totals).
  // Spec 130 — export reflects the COUNTED display set only; an un-counted
  // vendor's suppressed lines must not ride into the CSV/text/PDF share.
  const exportPayload = useMemo<ReorderPayload | null>(
    () => (payload ? { ...payload, vendors: countedDisplay, kpis } : null),
    [payload, countedDisplay, kpis],
  );

  // showExport gate mirrors the admin (minus the web-only clause — staff
  // export is cross-platform): enabled iff there's a non-empty COUNTED set,
  // no error, and not the initial load.
  const showExport =
    !!exportPayload && countedDisplay.length > 0 && !error && !(loading && !payload);

  // ─── header actions (mirror EODCount) ──────────────────────────────
  const onSwitchStore = useCallback(() => {
    if (!canSwitchStore) return;
    setActiveStore(null);
  }, [canSwitchStore, setActiveStore]);

  // ─── export menu (CSV / text / PDF) ─────────────────────────────────
  const runExport = useCallback(
    async (fn: (p: ReorderPayload, name: string, loc: Locale) => Promise<void>) => {
      if (!exportPayload || !activeStore || exporting) return;
      setExporting(true);
      try {
        // Downloads follow the user's active language (2026-07).
        await fn(exportPayload, activeStore.name, locale);
      } finally {
        setExporting(false);
      }
    },
    [exportPayload, activeStore, exporting, locale],
  );

  // Defensive guard — placed AFTER all hooks so the hook count stays stable
  // across renders (same discipline as ReorderSection / EODCount). The tab
  // bar only mounts with an active store, so this is defense-in-depth.
  if (!activeStore) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: c.bgAlt }]} edges={['top', 'bottom']}>
        <View style={styles.centerPane}>
          <ActivityIndicator color={c.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: c.bgAlt }]}
      edges={['top', 'bottom']}
      testID="staff-reorder-root"
    >
      {/* Header — store name (tap to switch) + sign out */}
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={onSwitchStore}
            disabled={!canSwitchStore}
            accessibilityRole={canSwitchStore ? 'button' : 'none'}
            accessibilityLabel={canSwitchStore ? t('chrome.switchStore') : undefined}
            testID="staff-reorder-store-name"
            style={({ pressed }) => [
              styles.storePressable,
              pressed && canSwitchStore ? { backgroundColor: c.surfaceAlt } : null,
            ]}
          >
            <Text
              style={[styles.storeName, { color: canSwitchStore ? c.primary : c.text }]}
              numberOfLines={1}
            >
              {activeStore.name}
            </Text>
            <Text style={[styles.headerSub, { color: c.textSecondary }]}>{t('reorder.title')}</Text>
          </Pressable>
          <SettingsGear />
        </View>

        {/* Controls — date picker + refresh */}
        <View style={styles.controlsRow}>
          <ReorderDatePicker
            value={selectedDate}
            onChange={setSelectedDate}
            maxDate={maxDate}
            activeWeekdays={activeWeekdays}
          />
          <Pressable
            testID="staff-reorder-refresh"
            onPress={refresh}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={t('reorder.refresh')}
            style={({ pressed }) => [
              styles.refreshBtn,
              { borderColor: c.borderStrong, backgroundColor: pressed ? c.surfaceAlt : c.surface },
              loading ? { opacity: 0.5 } : null,
            ]}
          >
            <Text style={[styles.refreshText, { color: c.text }]}>
              {loading ? t('reorder.loading') : t('reorder.refresh')}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Persistent "turn on notifications" nudge — RED, non-dismissible,
          disappears once notifications are on. */}
      <NotificationReminderBanner />

      <ScrollView contentContainerStyle={styles.scrollBody}>
        {/* KPI strip — 2×2 grid, values from computeReorderKpis(displayVendors) */}
        <View style={styles.kpiGrid}>
          <KpiCard
            label={t('reorder.kpi.vendors')}
            value={String(kpis.vendorCount)}
            sub={t('reorder.kpi.vendorsSub')}
          />
          <KpiCard
            label={t('reorder.kpi.items')}
            value={String(kpis.itemCount)}
            sub={t('reorder.kpi.itemsSub')}
          />
          {/* Est. total KPI removed — staff see quantities only, no cost. */}
          {/* Spec 130 — the "stock fallback" sub-stat is now structurally ~0
              (un-counted vendors move to the "Count not submitted" group), so
              show the not-submitted vendor count instead. */}
          <KpiCard
            label={t('reorder.kpi.source')}
            value={t('reorder.kpi.sourceValue', { count: kpis.eodSourcedVendorCount })}
            sub={t('reorder.countNotSubmitted.kpiSub', { count: notSubmittedDisplay.length })}
          />
        </View>

        {/* Export menu */}
        {showExport ? (
          <View style={styles.exportRow}>
            <Text style={[styles.exportLabel, { color: c.textSecondary }]}>{t('reorder.export.label')}</Text>
            <View style={styles.exportButtons}>
              <Pressable
                testID="staff-reorder-export-csv"
                onPress={() => void runExport(shareReorderCsv)}
                disabled={exporting}
                accessibilityRole="button"
                accessibilityLabel={t('reorder.export.csvAria')}
                style={({ pressed }) => [
                  styles.exportBtn,
                  { borderColor: c.borderStrong, backgroundColor: pressed ? c.surfaceAlt : c.surface },
                  exporting ? { opacity: 0.5 } : null,
                ]}
              >
                <Text style={[styles.exportBtnText, { color: c.text }]}>{t('reorder.export.csv')}</Text>
              </Pressable>
              <Pressable
                testID="staff-reorder-export-text"
                onPress={() => void runExport(shareReorderText)}
                disabled={exporting}
                accessibilityRole="button"
                accessibilityLabel={t('reorder.export.textAria')}
                style={({ pressed }) => [
                  styles.exportBtn,
                  { borderColor: c.borderStrong, backgroundColor: pressed ? c.surfaceAlt : c.surface },
                  exporting ? { opacity: 0.5 } : null,
                ]}
              >
                <Text style={[styles.exportBtnText, { color: c.text }]}>{t('reorder.export.text')}</Text>
              </Pressable>
              <Pressable
                testID="staff-reorder-export-pdf"
                onPress={() => void runExport(shareReorderPdf)}
                disabled={exporting}
                accessibilityRole="button"
                accessibilityLabel={t('reorder.export.pdfAria')}
                style={({ pressed }) => [
                  styles.exportBtn,
                  { borderColor: c.borderStrong, backgroundColor: pressed ? c.surfaceAlt : c.surface },
                  exporting ? { opacity: 0.5 } : null,
                ]}
              >
                <Text style={[styles.exportBtnText, { color: c.text }]}>{t('reorder.export.pdf')}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* Vendor filter — horizontal chips ("All" + one per vendor), sits
            just below the export buttons and above the vendor list. Only
            shown when there's more than one vendor to choose between. */}
        {allVendors.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.vendorChips}
            accessibilityLabel={t('reorder.vendorFilter.aria')}
            testID="staff-reorder-vendor-filter"
          >
            <VendorChip
              label={t('reorder.vendorFilter.all')}
              active={!selectedVendor}
              onPress={() => setSelectedVendorId(null)}
              testID="staff-reorder-vendor-chip-all"
            />
            {allVendors.map((v) => (
              <VendorChip
                key={v.vendorId}
                label={v.vendorName || t('reorder.vendor.unnamed')}
                active={selectedVendor?.vendorId === v.vendorId}
                onPress={() => setSelectedVendorId(v.vendorId)}
                testID={`staff-reorder-vendor-chip-${v.vendorId}`}
              />
            ))}
          </ScrollView>
        ) : null}

        {/* Warnings pane */}
        {payload?.warnings && payload.warnings.length > 0 ? (
          <Banner
            tone="warning"
            testID="staff-reorder-warnings"
            text={payload.warnings
              .map((w) =>
                w.code === 'schedule_unknown'
                  ? t('reorder.warning.scheduleUnknown', { vendor: w.vendor ?? '' })
                  : w.message || w.code,
              )
              .join('\n')}
          />
        ) : null}

        {/* Error pane (retry-able) */}
        {error ? (
          <View
            testID="staff-reorder-error"
            style={[styles.errorPane, { backgroundColor: c.errorBg, borderColor: c.error }]}
          >
            <Text style={[styles.errorText, { color: c.error }]}>{t('reorder.error.title')}</Text>
            <Text style={[styles.errorDetail, { color: c.error }]}>{error}</Text>
            <Pressable
              testID="staff-reorder-retry"
              onPress={refresh}
              accessibilityRole="button"
              accessibilityLabel={t('reorder.error.retry')}
              style={[styles.retryBtn, { borderColor: c.error }]}
            >
              <Text style={[styles.retryText, { color: c.error }]}>{t('reorder.error.retry')}</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Initial loading state — no payload yet */}
        {loading && !payload ? (
          <View style={styles.centerPane} testID="staff-reorder-loading">
            <ActivityIndicator size="large" color={c.primary} />
            <Text style={[styles.loadingText, { color: c.textSecondary }]}>{t('reorder.loadingBody')}</Text>
          </View>
        ) : null}

        {/* Empty — the payload itself has no suggestions at all */}
        {!loading && !error && !!payload && payload.vendors.length === 0 ? (
          <StateCard
            testID="staff-reorder-empty"
            title={t('reorder.empty.title')}
            body={t('reorder.empty.body')}
          />
        ) : null}

        {/* Nothing-to-order — payload HAS suggestions but none order out on
            the selected weekday (distinct from the empty state). */}
        {!loading &&
        !error &&
        !!payload &&
        payload.vendors.length > 0 &&
        displayVendors.length === 0 ? (
          <StateCard
            testID="staff-reorder-nothing-today"
            title={t('reorder.nothingToday.title')}
            body={
              selectedWeekday
                ? t('reorder.nothingToday.body', { day: weekdayLabel(t, selectedWeekday) })
                : t('reorder.nothingToday.body', { day: '' })
            }
          />
        ) : null}

        {/* Spec 130 — "Count not submitted" group, at the TOP of the list. A
            vendor with no submitted EOD count for the date renders here (header
            + a "Count not submitted yet" block); its stale suppressed lines
            never reach the KPIs, the export, or the needs/enough split. */}
        {notSubmittedDisplay.length > 0 ? (
          <>
            <Text
              style={[styles.sectionHeader, { color: c.warning }]}
              testID="staff-reorder-section-count-not-submitted"
            >
              {t('reorder.countNotSubmitted.groupTitle')} · {notSubmittedDisplay.length}
            </Text>
            {notSubmittedDisplay.map((v) => (
              <VendorCard key={`nosub-${v.vendorId}`} vendor={v} needsOrder />
            ))}
          </>
        ) : null}

        {/* "Needs to Order" section — below-par items, red. */}
        {needsOrderVendors.length > 0 ? (
          <>
            <Text style={[styles.sectionHeader, { color: c.error }]} testID="reorder-section-needs">
              {t('reorder.section.needsToOrder')}
            </Text>
            {needsOrderVendors.map((v) => (
              <VendorCard key={`need-${v.vendorId}`} vendor={v} needsOrder />
            ))}
          </>
        ) : null}

        {/* "Have enough stock" section — at/above-par items, green. */}
        {enoughStockVendors.length > 0 ? (
          <>
            <Text style={[styles.sectionHeader, { color: c.success }]} testID="reorder-section-enough">
              {t('reorder.section.enough')}
            </Text>
            {enoughStockVendors.map((v) => (
              <VendorCard key={`ok-${v.vendorId}`} vendor={v} needsOrder={false} />
            ))}
          </>
        ) : null}

        {/* Secondary "no schedule" collapsible group — only under "All"; a
            single-vendor selection shows that vendor directly above instead. */}
        {!selectedVendor && noSchedule.length > 0 ? (
          <View style={styles.noScheduleGroup}>
            <Pressable
              testID="staff-reorder-no-schedule-toggle"
              onPress={() => setNoScheduleOpen((o) => !o)}
              accessibilityRole="button"
              accessibilityState={{ expanded: noScheduleOpen }}
              style={({ pressed }) => [
                styles.noScheduleToggle,
                { backgroundColor: pressed ? c.surfaceAlt : c.surface, borderColor: c.border },
              ]}
            >
              <Text style={[styles.noScheduleGlyph, { color: c.textSecondary }]}>
                {noScheduleOpen ? '▾' : '▸'}
              </Text>
              <Text style={[styles.noScheduleTitle, { color: c.text }]} numberOfLines={1}>
                {t('reorder.noSchedule.title', { count: noSchedule.length })}
              </Text>
            </Pressable>
            {noScheduleOpen ? (
              <>
                <Text style={[styles.noScheduleHint, { color: c.textTertiary }]}>
                  {t('reorder.noSchedule.hint')}
                </Text>
                {splitReorderVendorsByNeed(noSchedule, true).map((v) => (
                  <VendorCard key={v.vendorId} vendor={v} needsOrder />
                ))}
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  centerPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: T.spacing.md,
    paddingVertical: T.spacing.xxl,
  },
  loadingText: {
    fontSize: T.typography.body,
  },
  header: {
    paddingHorizontal: T.spacing.lg,
    paddingTop: T.spacing.md,
    paddingBottom: T.spacing.md,
    borderBottomWidth: 1,
    gap: T.spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: T.spacing.md,
  },
  storePressable: {
    flex: 1,
    minWidth: 0,
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.sm,
    borderRadius: T.radius.sm,
  },
  storeName: {
    fontSize: T.typography.title,
    fontWeight: T.typography.bold,
  },
  headerSub: {
    fontSize: T.typography.caption,
    marginTop: 2,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  refreshBtn: {
    minHeight: T.touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: T.spacing.md,
    borderWidth: 1,
    borderRadius: T.radius.md,
  },
  refreshText: {
    fontSize: T.typography.body,
    fontWeight: T.typography.medium,
  },
  scrollBody: {
    padding: T.spacing.lg,
    paddingBottom: T.spacing.xxxl,
    gap: T.spacing.md,
  },
  // Section header ("Needs to Order" / "Have enough stock") — coloured to
  // match the section's row tone (red / green).
  sectionHeader: {
    fontSize: T.typography.bodyLarge,
    fontWeight: T.typography.bold,
    marginTop: T.spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  // Vendor filter — horizontal row of pills.
  vendorChips: {
    flexDirection: 'row',
    gap: T.spacing.sm,
    paddingVertical: T.spacing.xxs,
  },
  vendorChip: {
    minHeight: T.touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: T.spacing.lg,
    borderWidth: 1,
    borderRadius: T.radius.pill,
  },
  vendorChipText: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.semibold,
    maxWidth: 180,
  },
  // KPI 2×2 grid: cards flex to ~half-width with the row gap.
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: T.spacing.sm,
  },
  kpiCard: {
    flexGrow: 1,
    flexBasis: '47%',
    minWidth: 140,
    borderWidth: 1,
    borderRadius: T.radius.lg,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.md,
    gap: 2,
  },
  kpiLabel: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.medium,
  },
  kpiValue: {
    fontSize: T.typography.headline,
    fontWeight: T.typography.bold,
  },
  kpiSub: {
    fontSize: T.typography.caption,
  },
  exportRow: {
    gap: T.spacing.sm,
  },
  exportLabel: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  exportButtons: {
    flexDirection: 'row',
    gap: T.spacing.sm,
  },
  exportBtn: {
    flexGrow: 1,
    minHeight: T.touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: T.spacing.md,
    borderWidth: 1,
    borderRadius: T.radius.md,
  },
  exportBtnText: {
    fontSize: T.typography.body,
    fontWeight: T.typography.semibold,
  },
  // Vendor card
  vendorCard: {
    borderWidth: 1,
    borderRadius: T.radius.lg,
    overflow: 'hidden',
  },
  vendorHeader: {
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.md,
    gap: T.spacing.xs,
  },
  vendorTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  vendorName: {
    flex: 1,
    fontSize: T.typography.bodyLarge,
    fontWeight: T.typography.bold,
  },
  badge: {
    paddingHorizontal: T.spacing.sm,
    paddingVertical: 3,
    borderRadius: T.radius.sm,
  },
  badgeText: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.bold,
    letterSpacing: 0.3,
  },
  vendorMeta: {
    fontSize: T.typography.caption,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: T.spacing.md,
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.md,
  },
  itemMain: {
    flex: 1,
    gap: T.spacing.xs,
  },
  itemName: {
    fontSize: T.typography.body,
    fontWeight: T.typography.semibold,
  },
  itemBreakdown: {
    fontSize: T.typography.caption,
  },
  itemOrder: {
    flexShrink: 0,
    fontSize: T.typography.body,
    fontWeight: T.typography.bold,
    textAlign: 'right',
  },
  itemOrderSub: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.regular,
  },
  // Spec 102 (OQ-1) — the "also available from N" coincident-schedule hint.
  itemAlsoFrom: {
    fontSize: T.typography.caption,
    fontStyle: 'italic',
    marginTop: 2,
  },
  vendorFooter: {
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.sm,
    borderTopWidth: 1,
  },
  vendorFooterText: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.medium,
  },
  // Spec 130 — "Count not submitted yet" state block (replaces the item rows +
  // footer for an un-counted vendor).
  notSubmittedBlock: {
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.xl,
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  notSubmittedGlyph: {
    fontSize: T.typography.headline,
  },
  notSubmittedTitle: {
    fontSize: T.typography.body,
    fontWeight: T.typography.bold,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  notSubmittedBody: {
    fontSize: T.typography.caption,
    textAlign: 'center',
    lineHeight: T.typography.lineHeightBody,
  },
  // State cards
  stateCard: {
    borderWidth: 1,
    borderRadius: T.radius.lg,
    paddingVertical: T.spacing.xl,
    paddingHorizontal: T.spacing.lg,
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  stateTitle: {
    fontSize: T.typography.body,
    fontWeight: T.typography.bold,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  stateBody: {
    fontSize: T.typography.caption,
    textAlign: 'center',
    lineHeight: T.typography.lineHeightBody,
  },
  // Error pane
  errorPane: {
    borderWidth: 1,
    borderRadius: T.radius.lg,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.lg,
    gap: T.spacing.xs,
  },
  errorText: {
    fontSize: T.typography.body,
    fontWeight: T.typography.bold,
  },
  errorDetail: {
    fontSize: T.typography.caption,
  },
  retryBtn: {
    marginTop: T.spacing.sm,
    alignSelf: 'flex-start',
    minHeight: T.touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: T.spacing.lg,
    borderWidth: 1,
    borderRadius: T.radius.md,
  },
  retryText: {
    fontSize: T.typography.body,
    fontWeight: T.typography.bold,
  },
  // No-schedule group
  noScheduleGroup: {
    gap: T.spacing.md,
  },
  noScheduleToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    minHeight: T.touchTarget.min,
    paddingHorizontal: T.spacing.lg,
    borderWidth: 1,
    borderRadius: T.radius.lg,
  },
  noScheduleGlyph: {
    fontSize: T.typography.body,
    fontWeight: T.typography.bold,
  },
  noScheduleTitle: {
    flex: 1,
    fontSize: T.typography.body,
    fontWeight: T.typography.semibold,
  },
  noScheduleHint: {
    fontSize: T.typography.caption,
    paddingHorizontal: T.spacing.xs,
  },
});

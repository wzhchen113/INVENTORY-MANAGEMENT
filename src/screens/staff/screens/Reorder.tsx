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
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { Banner } from '../components/Banner';
import { ReorderDatePicker } from '../components/ReorderDatePicker';
import { confirmAction } from '../../../utils/confirmAction';
import { supabase } from '../../../lib/supabase';
import { notifyBackendError } from '../lib/notifyBackendError';
import { fetchStaffOrderSchedule, fetchStaffReorder } from '../lib/fetchReorder';
import {
  shareReorderCsv,
  shareReorderPdf,
  shareReorderText,
} from '../lib/shareReorder';
import { useStaffStore } from '../store/useStaffStore';
import { t } from '../i18n';
import {
  radius,
  spacing,
  touchTarget,
  typography,
  useStaffColors,
  useStaffElevation,
} from '../theme';
import { formatMoney, formatQty, formatSuggested } from '../../../utils/reorderExport';
import {
  activeWeekdaysFromSchedule,
  computeReorderKpis,
  partitionReorderVendors,
  weekdayName,
} from '../../../utils/reorderDayFilter';
import type { DayName } from '../../../utils/enumLabels';
import type { OrderSchedule, ReorderItem, ReorderPayload, ReorderVendor } from '../../../types';

function todayIso(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Localized long weekday name via the staff catalog (`reorder.weekday.*`),
// keyed off the canonical English DayName. Self-contained — does NOT reuse
// the admin `dayOfWeekLongLabel`, which expects admin-only `enum.dayOfWeek.*`
// keys absent from the staff catalog.
function weekdayLabel(day: DayName): string {
  return t(`reorder.weekday.${day.toLowerCase()}`);
}

// ── KPI card ──────────────────────────────────────────────────────
function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  const c = useStaffColors();
  const e = useStaffElevation();
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
function VendorCard({ vendor }: { vendor: ReorderVendor }) {
  const c = useStaffColors();
  const e = useStaffElevation();

  const sourceLabel = vendor.onHandSource === 'eod' ? 'EOD' : t('reorder.source.stockFallback');
  const sourceTone = vendor.onHandSource === 'eod' ? c.success : c.warning;
  const sourceBg = vendor.onHandSource === 'eod' ? c.successBg : c.warningBg;

  const daysLabel =
    vendor.daysUntilNextDelivery === 0
      ? t('reorder.delivery.today')
      : vendor.daysUntilNextDelivery === 1
        ? t('reorder.delivery.tomorrow')
        : t('reorder.delivery.inDays', { days: vendor.daysUntilNextDelivery });

  return (
    <View
      testID={`staff-reorder-vendor-${vendor.vendorId}`}
      style={[styles.vendorCard, { backgroundColor: c.surface, borderColor: c.border }, e.card]}
    >
      {/* Vendor header */}
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

      {/* Items — stacked rows (mobile analog of the desktop BreakdownLine) */}
      {vendor.items.map((item: ReorderItem, i: number) => (
        <View
          key={item.itemId}
          style={[
            styles.itemRow,
            i === 0 ? null : { borderTopWidth: 1, borderTopColor: c.border },
          ]}
        >
          <View style={styles.itemTop}>
            <Text style={[styles.itemName, { color: c.text }]} numberOfLines={2}>
              {item.itemName}
            </Text>
            <Text style={[styles.itemCost, { color: c.text }]}>{formatMoney(item.estimatedCost)}</Text>
          </View>
          <Text style={[styles.itemBreakdown, { color: c.textSecondary }]}>
            {t('reorder.item.breakdown', {
              onHand: `${formatQty(item.onHand)} ${item.unit}`.trim(),
              par: `${formatQty(item.parLevel)} ${item.unit}`.trim(),
            })}
          </Text>
          <Text style={[styles.itemOrder, { color: c.primary }]}>
            {t('reorder.item.order', { suggested: formatSuggested(item) })}
          </Text>
        </View>
      ))}

      {/* Footer subtotal */}
      <View style={[styles.vendorFooter, { borderTopColor: c.border }]}>
        <Text style={[styles.vendorFooterText, { color: c.textSecondary }]}>
          {t('reorder.vendor.subtotal', {
            count: vendor.items.length,
            cost: formatMoney(vendor.vendorTotalCost),
          })}
        </Text>
      </View>
    </View>
  );
}

// ── empty/loading state card ────────────────────────────────────────
function StateCard({ title, body, testID }: { title: string; body: string; testID?: string }) {
  const c = useStaffColors();
  const e = useStaffElevation();
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

export function Reorder() {
  const c = useStaffColors();
  const activeStore = useStaffStore((s) => s.activeStore);
  const stores = useStaffStore((s) =>
    s.authState.kind === 'signed-in' ? s.authState.stores : [],
  );
  const setAuthState = useStaffStore((s) => s.setAuthState);
  const setActiveStore = useStaffStore((s) => s.setActiveStore);

  const maxDate = useMemo(() => todayIso(), []);
  const [selectedDate, setSelectedDate] = useState<string>(() => todayIso());
  const [payload, setPayload] = useState<ReorderPayload | null>(null);
  const [orderSchedule, setOrderSchedule] = useState<OrderSchedule>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [noScheduleOpen, setNoScheduleOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

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
    [],
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
  const kpis = useMemo(() => computeReorderKpis(primary), [primary]);

  // Export must reflect the on-screen FILTERED + as-of view — derived payload
  // = primary vendors + client-recomputed KPIs (same invariant as admin).
  const exportPayload = useMemo<ReorderPayload | null>(
    () => (payload ? { ...payload, vendors: primary, kpis } : null),
    [payload, primary, kpis],
  );

  // showExport gate mirrors the admin (minus the web-only clause — staff
  // export is cross-platform): enabled iff there's a non-empty filtered set,
  // no error, and not the initial load.
  const showExport =
    !!exportPayload && primary.length > 0 && !error && !(loading && !payload);

  // ─── header actions (mirror EODCount) ──────────────────────────────
  const onSignOut = useCallback(() => {
    confirmAction(
      t('chrome.signOut.confirmTitle'),
      t('chrome.signOut.confirmMessage'),
      async () => {
        try {
          await supabase.auth.signOut();
        } catch (err) {
          notifyBackendError('signOut', err);
        }
        setActiveStore(null);
        Toast.show({ type: 'success', text1: t('chrome.signedOut'), position: 'bottom' });
        setAuthState({ kind: 'signed-out' });
      },
      t('chrome.signOut.label'),
    );
  }, [setAuthState, setActiveStore]);

  const onSwitchStore = useCallback(() => {
    if (!canSwitchStore) return;
    setActiveStore(null);
  }, [canSwitchStore, setActiveStore]);

  // ─── export menu (CSV / text / PDF) ─────────────────────────────────
  const runExport = useCallback(
    async (fn: (p: ReorderPayload, name: string) => Promise<void>) => {
      if (!exportPayload || !activeStore || exporting) return;
      setExporting(true);
      try {
        await fn(exportPayload, activeStore.name);
      } finally {
        setExporting(false);
      }
    },
    [exportPayload, activeStore, exporting],
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
          <Pressable
            onPress={onSignOut}
            style={({ pressed }) => [styles.signOutBtn, pressed ? { backgroundColor: c.surfaceAlt } : null]}
            accessibilityRole="button"
            accessibilityLabel={t('chrome.signOut.label')}
            testID="staff-reorder-sign-out"
          >
            <Text style={[styles.signOutText, { color: c.error }]}>{t('chrome.signOut.label')}</Text>
          </Pressable>
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

      <ScrollView contentContainerStyle={styles.scrollBody}>
        {/* KPI strip — 2×2 grid, values from computeReorderKpis(primary) */}
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
          <KpiCard
            label={t('reorder.kpi.estTotal')}
            value={formatMoney(kpis.totalEstimatedCost)}
            sub={t('reorder.kpi.estTotalSub')}
          />
          <KpiCard
            label={t('reorder.kpi.source')}
            value={t('reorder.kpi.sourceValue', { count: kpis.eodSourcedVendorCount })}
            sub={t('reorder.kpi.sourceSub', { count: kpis.stockFallbackVendorCount })}
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

        {/* Warnings pane */}
        {payload?.warnings && payload.warnings.length > 0 ? (
          <Banner
            tone="warning"
            testID="staff-reorder-warnings"
            text={payload.warnings.map((w) => w.message || w.code).join('\n')}
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
        primary.length === 0 ? (
          <StateCard
            testID="staff-reorder-nothing-today"
            title={t('reorder.nothingToday.title')}
            body={
              selectedWeekday
                ? t('reorder.nothingToday.body', { day: weekdayLabel(selectedWeekday) })
                : t('reorder.nothingToday.body', { day: '' })
            }
          />
        ) : null}

        {/* Primary "order today" vendor cards */}
        {primary.map((v) => (
          <VendorCard key={v.vendorId} vendor={v} />
        ))}

        {/* Secondary "no schedule" collapsible group */}
        {noSchedule.length > 0 ? (
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
                {noSchedule.map((v) => (
                  <VendorCard key={v.vendorId} vendor={v} />
                ))}
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  centerPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
  },
  loadingText: {
    fontSize: typography.body,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    gap: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  storePressable: {
    flex: 1,
    minWidth: 0,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  storeName: {
    fontSize: typography.title,
    fontWeight: typography.bold,
  },
  headerSub: {
    fontSize: typography.caption,
    marginTop: 2,
  },
  signOutBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  signOutText: {
    fontSize: typography.body,
    fontWeight: typography.semibold,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  refreshBtn: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  refreshText: {
    fontSize: typography.body,
    fontWeight: typography.medium,
  },
  scrollBody: {
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
    gap: spacing.md,
  },
  // KPI 2×2 grid: cards flex to ~half-width with the row gap.
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  kpiCard: {
    flexGrow: 1,
    flexBasis: '47%',
    minWidth: 140,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  kpiLabel: {
    fontSize: typography.caption,
    fontWeight: typography.medium,
  },
  kpiValue: {
    fontSize: typography.headline,
    fontWeight: typography.bold,
  },
  kpiSub: {
    fontSize: typography.caption,
  },
  exportRow: {
    gap: spacing.sm,
  },
  exportLabel: {
    fontSize: typography.caption,
    fontWeight: typography.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  exportButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  exportBtn: {
    flexGrow: 1,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  exportBtnText: {
    fontSize: typography.body,
    fontWeight: typography.semibold,
  },
  // Vendor card
  vendorCard: {
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  vendorHeader: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  vendorTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  vendorName: {
    flex: 1,
    fontSize: typography.bodyLarge,
    fontWeight: typography.bold,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },
  badgeText: {
    fontSize: typography.caption,
    fontWeight: typography.bold,
    letterSpacing: 0.3,
  },
  vendorMeta: {
    fontSize: typography.caption,
  },
  itemRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  itemTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  itemName: {
    flex: 1,
    fontSize: typography.body,
    fontWeight: typography.semibold,
  },
  itemCost: {
    fontSize: typography.body,
    fontWeight: typography.semibold,
  },
  itemBreakdown: {
    fontSize: typography.caption,
  },
  itemOrder: {
    fontSize: typography.body,
    fontWeight: typography.bold,
  },
  vendorFooter: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
  },
  vendorFooterText: {
    fontSize: typography.caption,
    fontWeight: typography.medium,
  },
  // State cards
  stateCard: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  stateTitle: {
    fontSize: typography.body,
    fontWeight: typography.bold,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  stateBody: {
    fontSize: typography.caption,
    textAlign: 'center',
    lineHeight: typography.lineHeightBody,
  },
  // Error pane
  errorPane: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.xs,
  },
  errorText: {
    fontSize: typography.body,
    fontWeight: typography.bold,
  },
  errorDetail: {
    fontSize: typography.caption,
  },
  retryBtn: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    minHeight: touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  retryText: {
    fontSize: typography.body,
    fontWeight: typography.bold,
  },
  // No-schedule group
  noScheduleGroup: {
    gap: spacing.md,
  },
  noScheduleToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.lg,
  },
  noScheduleGlyph: {
    fontSize: typography.body,
    fontWeight: typography.bold,
  },
  noScheduleTitle: {
    flex: 1,
    fontSize: typography.body,
    fontWeight: typography.semibold,
  },
  noScheduleHint: {
    fontSize: typography.caption,
    paddingHorizontal: spacing.xs,
  },
});

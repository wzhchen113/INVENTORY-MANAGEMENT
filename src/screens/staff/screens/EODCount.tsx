// src/screens/staff/screens/EODCount.tsx — the EOD count screen.
//
// Spec 062 §B5 + §B6 + §B7. Header (store + today's date), vendor
// switcher (only if today's order_schedule lists >1 vendor),
// scrollable item list with decimal-pad inputs, submit button,
// pre-fill banner from any existing submission for
// (active_store_id, today, selected_vendor_id).
//
// Vendor logic: spec 062's "vendor_day_filter" is the order_schedule
// table from spec 007 — rows at (store_id, day_of_week, vendor_id) for
// today's weekday. We query directly.
//
// Date is captured at SUBMIT time, not mount time (§11 risk (c)):
// EODCount reads the today_iso string in onSubmit, not at first
// render.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { ListRow } from '../components/ListRow';
import { QueueIndicator } from '../components/QueueIndicator';
import { confirmAction } from '../../../utils/confirmAction';
import { supabase } from '../../../lib/supabase';
import { notifyBackendError } from '../lib/notifyBackendError';
import { currentStaffUserId, useStaffStore } from '../store/useStaffStore';
import { useEodSubmit } from '../hooks/useEodSubmit';
import { t } from '../i18n';
import { radius, spacing, touchTarget, typography, useStaffColors } from '../theme';
import type { EodEntry, EodItem, ExistingSubmission, Vendor } from '../lib/types';

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function todayWeekday(d = new Date()): string {
  return WEEKDAYS[d.getDay()];
}

function todayIso(d = new Date()): string {
  // yyyy-mm-dd in local time.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function todayHeaderLabel(d = new Date()): string {
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return t('eod.header.today', { weekday, monthDay });
}

function submittedAtHHMM(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

// ── data fetch helpers ───────────────────────────────────────────

async function fetchVendorsForToday(
  storeId: string,
  dayOfWeek: string,
): Promise<Vendor[]> {
  // order_schedule has (store_id, day_of_week, vendor_id, vendor_name).
  // Read schedule rows; join the vendors table to get the canonical
  // name (vendor_name on order_schedule is a denormalized snapshot).
  const { data, error } = await supabase
    .from('order_schedule')
    .select('vendor_id, vendor_name, vendor:vendors(id, name)')
    .eq('store_id', storeId)
    .eq('day_of_week', dayOfWeek);
  if (error) throw error;
  type Row = {
    vendor_id: string | null;
    vendor_name: string | null;
    vendor: { id: string; name: string } | { id: string; name: string }[] | null;
  };
  const rows = (data ?? []) as Row[];
  const out: Vendor[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const v = Array.isArray(r.vendor) ? r.vendor[0] : r.vendor;
    const id = v?.id ?? r.vendor_id;
    const name = v?.name ?? r.vendor_name ?? '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

async function fetchItemsForVendor(
  storeId: string,
  vendorId: string,
): Promise<EodItem[]> {
  // inventory_items at the store filtered by vendor_id, joined to
  // catalog_ingredients for the canonical display name + unit.
  const { data, error } = await supabase
    .from('inventory_items')
    .select('id, vendor_id, catalog:catalog_ingredients(name, unit)')
    .eq('store_id', storeId)
    .eq('vendor_id', vendorId)
    .order('id', { ascending: true });
  if (error) throw error;
  type Row = {
    id: string;
    vendor_id: string | null;
    catalog: { name: string | null; unit: string | null } | { name: string | null; unit: string | null }[] | null;
  };
  const rows = (data ?? []) as Row[];
  return rows.map((r) => {
    const c = Array.isArray(r.catalog) ? r.catalog[0] : r.catalog;
    return {
      id: r.id,
      vendorId: r.vendor_id,
      name: c?.name ?? '',
      unit: c?.unit ?? '',
    };
  });
}

async function fetchExistingSubmission(
  storeId: string,
  dateIso: string,
  vendorId: string,
): Promise<ExistingSubmission | null> {
  const { data, error } = await supabase
    .from('eod_submissions')
    .select('id, submitted_at, eod_entries(item_id, actual_remaining)')
    .eq('store_id', storeId)
    .eq('date', dateIso)
    .eq('vendor_id', vendorId)
    .maybeSingle();
  if (error) {
    // maybeSingle returns 406 if >1 rows match — log and treat as
    // no-existing.
    if ((error as { code?: string }).code === 'PGRST116') return null;
    throw error;
  }
  if (!data) return null;
  type Row = {
    id: string;
    submitted_at: string;
    eod_entries: Array<{ item_id: string; actual_remaining: number | string | null }>;
  };
  const row = data as Row;
  const entries: EodEntry[] = (row.eod_entries ?? []).map((e) => ({
    item_id: e.item_id,
    count: e.actual_remaining == null ? 0 : Number(e.actual_remaining),
  }));
  return {
    submission_id: row.id,
    submitted_at: row.submitted_at,
    entries,
  };
}

// ── screen ───────────────────────────────────────────────────────

export function EODCount() {
  const c = useStaffColors();
  const activeStore = useStaffStore((s) => s.activeStore);
  const stores = useStaffStore((s) =>
    s.authState.kind === 'signed-in' ? s.authState.stores : [],
  );
  const userId = useStaffStore((s) => currentStaffUserId(s.authState));
  const setAuthState = useStaffStore((s) => s.setAuthState);
  const setActiveStore = useStaffStore((s) => s.setActiveStore);

  const { submit, pending, draining } = useEodSubmit();

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  const [items, setItems] = useState<EodItem[]>([]);
  const [existing, setExisting] = useState<ExistingSubmission | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [forbidden, setForbidden] = useState<boolean>(false);

  const todayLabel = useMemo(() => todayHeaderLabel(), []);
  const canSwitchStore = stores.length > 1;

  // ─── load vendors for today on mount / when active store changes ──
  useEffect(() => {
    if (!activeStore) return;
    setLoading(true);
    setForbidden(false);
    fetchVendorsForToday(activeStore.id, todayWeekday())
      .then((vs) => {
        setVendors(vs);
        setSelectedVendorId(vs[0]?.id ?? null);
      })
      .catch((err) => {
        notifyBackendError('fetchVendorsForToday', err);
        setVendors([]);
        setSelectedVendorId(null);
      })
      .finally(() => setLoading(false));
  }, [activeStore]);

  // ─── load items + existing submission when vendor changes ─────────
  useEffect(() => {
    if (!activeStore || !selectedVendorId) {
      setItems([]);
      setExisting(null);
      setCounts({});
      return;
    }
    setLoading(true);
    Promise.all([
      fetchItemsForVendor(activeStore.id, selectedVendorId),
      fetchExistingSubmission(activeStore.id, todayIso(), selectedVendorId),
    ])
      .then(([nextItems, nextExisting]) => {
        setItems(nextItems);
        setExisting(nextExisting);
        // Pre-fill counts from existing submission if any
        const seed: Record<string, string> = {};
        if (nextExisting) {
          for (const e of nextExisting.entries) {
            seed[e.item_id] = String(e.count);
          }
        }
        setCounts(seed);
      })
      .catch((err) => {
        notifyBackendError('fetchItemsForVendor', err);
        setItems([]);
        setExisting(null);
        setCounts({});
      })
      .finally(() => setLoading(false));
  }, [activeStore, selectedVendorId]);

  // ─── header actions ───────────────────────────────────────────────
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
        // Queue is NOT cleared per spec — intent_user_id boundary
        // preserves items across sign-out.
        setActiveStore(null);
        // Surface the "signed out" toast directly — the AuthState
        // 'signed-out' branch is plain, callers fire toasts at the
        // failure / transition site.
        Toast.show({
          type: 'success',
          text1: t('chrome.signedOut'),
          position: 'bottom',
        });
        setAuthState({ kind: 'signed-out' });
      },
      t('chrome.signOut.label'),
    );
  }, [setAuthState, setActiveStore]);

  const onSwitchStore = useCallback(() => {
    if (!canSwitchStore) return;
    setActiveStore(null);
  }, [canSwitchStore, setActiveStore]);

  // ─── submit ───────────────────────────────────────────────────────
  const onSubmit = useCallback(async () => {
    if (!activeStore || !selectedVendorId || submitting) return;
    if (items.length === 0) return;
    // Build entries — only include rows the user entered or rows that
    // were pre-filled from existing submission. Skip blank rows so the
    // RPC isn't bloated; the spec doesn't require backfill of zeros.
    const entries: EodEntry[] = items
      .map((it) => {
        const raw = counts[it.id];
        if (raw == null || raw === '') return null;
        const parsed = Number(raw);
        if (Number.isNaN(parsed)) return null;
        return { item_id: it.id, count: parsed };
      })
      .filter((x): x is EodEntry => x !== null);
    if (entries.length === 0) {
      Toast.show({
        type: 'error',
        text1: t('eod.toast.failed'),
        text2: t('eod.toast.noCountsEntered'),
        position: 'bottom',
      });
      return;
    }
    // Date captured at SUBMIT time (§11 risk (c)).
    const dateIso = todayIso();

    setSubmitting(true);
    try {
      const outcome = await submit({
        store_id: activeStore.id,
        date: dateIso,
        vendor_id: selectedVendorId,
        entries,
      });
      if (outcome.kind === 'success') {
        Toast.show({
          type: 'success',
          text1: t('eod.toast.submitted'),
          position: 'bottom',
        });
        // Refresh existing to show the "Last submitted at HH:MM" banner.
        try {
          const fresh = await fetchExistingSubmission(
            activeStore.id,
            dateIso,
            selectedVendorId,
          );
          setExisting(fresh);
        } catch {
          // ignore — primary action succeeded
        }
      } else if (outcome.kind === 'success-replay') {
        Toast.show({
          type: 'success',
          text1: t('eod.toast.alreadySubmitted'),
          position: 'bottom',
        });
      } else if (outcome.kind === 'forbidden') {
        setForbidden(true);
      } else if (outcome.kind === 'queued') {
        Toast.show({
          type: 'success',
          text1: t('eod.toast.queued'),
          position: 'bottom',
        });
        // Clear inputs so the user moves on — spec §B7.
        setCounts({});
      } else {
        Toast.show({
          type: 'error',
          text1: outcome.message,
          position: 'bottom',
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [activeStore, selectedVendorId, items, counts, submit, submitting]);

  if (!activeStore) {
    // Shouldn't render — RootStack swaps to picker when activeStore
    // is null. Defensive empty state.
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: c.bgAlt }]}>
        <View style={styles.empty}>
          <ActivityIndicator color={c.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const submittedTime = existing ? submittedAtHHMM(existing.submitted_at) : null;

  return (
    // Root is the recessed `bgAlt` field — the surface header/footer bars
    // and the white item cards stand off it. (spec 070 fix-pass: the
    // earlier `bg`≈`surface` pairing made the cards invisible.)
    <SafeAreaView
      style={[styles.container, { backgroundColor: c.bgAlt }]}
      edges={['top', 'bottom']}
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: c.surface, borderBottomColor: c.border },
        ]}
      >
        <View style={styles.headerRow}>
          <Pressable
            onPress={onSwitchStore}
            disabled={!canSwitchStore}
            accessibilityRole={canSwitchStore ? 'button' : 'none'}
            accessibilityLabel={canSwitchStore ? t('chrome.switchStore') : undefined}
            testID="eod-store-name"
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
            <Text style={[styles.todayLabel, { color: c.textSecondary }]}>
              {todayLabel}
            </Text>
          </Pressable>
          <Pressable
            onPress={onSignOut}
            style={({ pressed }) => [
              styles.signOutBtn,
              pressed ? { backgroundColor: c.surfaceAlt } : null,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t('chrome.signOut.label')}
            testID="eod-sign-out"
          >
            <Text style={[styles.signOutText, { color: c.error }]}>
              {t('chrome.signOut.label')}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Forbidden banner */}
      {forbidden ? <Banner tone="error" text={t('eod.error.forbidden')} /> : null}

      {/* Pre-fill banner */}
      {existing && submittedTime ? (
        <Banner
          tone="info"
          text={t('eod.banner.lastSubmitted', { time: submittedTime })}
          testID="eod-prefill-banner"
        />
      ) : null}

      {/* Vendor switcher — only shown if >1 vendor scheduled today */}
      {vendors.length > 1 ? (
        <View
          style={[
            styles.vendorSwitcher,
            { backgroundColor: c.surface, borderBottomColor: c.border },
          ]}
        >
          <FlatList
            horizontal
            data={vendors}
            keyExtractor={(v) => v.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.vendorChipRow}
            renderItem={({ item }) => {
              const active = item.id === selectedVendorId;
              return (
                <Pressable
                  onPress={() => setSelectedVendorId(item.id)}
                  testID={`vendor-chip-${item.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[
                    styles.vendorChip,
                    {
                      backgroundColor: active ? c.primary : c.surface,
                      borderColor: active ? c.primary : c.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.vendorChipText,
                      {
                        color: active ? c.textOnPrimary : c.text,
                        fontWeight: active ? typography.semibold : typography.medium,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {item.name}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
      ) : null}

      {/* Items list */}
      {loading ? (
        <View style={styles.loadingPane}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      ) : vendors.length === 0 ? (
        <View style={styles.emptyPane}>
          <Text style={[styles.emptyText, { color: c.textSecondary }]}>
            {t('eod.vendor.noneToday')}
          </Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyPane}>
          <Text style={[styles.emptyText, { color: c.textSecondary }]}>
            {t('eod.list.empty')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          // flex: 1 claims the leftover vertical space between the pinned
          // header (+ banners + vendor switcher) and the pinned footer
          // (queue indicator + Submit) so the list scrolls *inside* that
          // strip instead of pushing the footer below the viewport. Web
          // without this falls back to body-scroll and hides Submit;
          // native overflows the SafeAreaView. The empty/loading panes
          // above already use `flex: 1` — this restores symmetry on the
          // populated branch.
          style={styles.itemListBody}
          contentContainerStyle={styles.itemList}
          ItemSeparatorComponent={() => <View style={styles.itemSeparator} />}
          renderItem={({ item }) => (
            <ListRow
              testID={`eod-item-row-${item.id}`}
              leading={
                <View>
                  <Text style={[styles.itemName, { color: c.text }]} numberOfLines={2}>
                    {item.name}
                  </Text>
                  {item.unit ? (
                    <Text style={[styles.itemUnit, { color: c.textSecondary }]}>
                      {item.unit}
                    </Text>
                  ) : null}
                </View>
              }
              trailing={
                <Input
                  value={counts[item.id] ?? ''}
                  onChangeText={(txt) =>
                    setCounts((prev) => ({ ...prev, [item.id]: txt }))
                  }
                  keyboardType="decimal-pad"
                  // react-native-web maps inputMode to the underlying
                  // <input>; native ignores it. Both belt-and-suspenders.
                  {...(Platform.OS === 'web' ? { inputMode: 'decimal' as const } : {})}
                  placeholder="0"
                  testID={`eod-item-input-${item.id}`}
                  style={styles.countInput}
                  accessibilityLabel={`Count for ${item.name}`}
                />
              }
            />
          )}
        />
      )}

      {/* Footer — queue indicator + submit */}
      <View
        style={[
          styles.footer,
          { backgroundColor: c.surface, borderTopColor: c.border },
        ]}
      >
        <QueueIndicator pending={pending} draining={draining} testID="eod-queue-indicator" />
        <View style={styles.submitWrap}>
          <Button
            label={submitting ? t('eod.submitting') : t('eod.submit')}
            onPress={onSubmit}
            disabled={items.length === 0 || forbidden}
            loading={submitting}
            testID="eod-submit"
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    // Absolute-fill the React Navigation card (the nearest positioned
    // ancestor) instead of relying on `flex: 1` in the flow. On
    // react-native-web, RN-Navigation's screen-wrapper sets
    // `min-height: 100%` + `flex: 0 0 auto`, which lets it GROW with
    // content past the viewport — that pushes the pinned footer
    // (Submit) below the fold and turns the page into body-scroll. The
    // absoluteFillObject sizes us to the Card (≈100vh), so the inner
    // FlatList (also flex: 1) becomes the scroll container and the
    // header/footer stay pinned. Native Yoga treats the same shape
    // identically; SafeAreaView's `edges` padding still applies.
    ...StyleSheet.absoluteFillObject,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
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
  todayLabel: {
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
  vendorSwitcher: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
  },
  vendorChipRow: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  vendorChip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    minHeight: 36,
    justifyContent: 'center',
  },
  vendorChipText: {
    fontSize: typography.body,
  },
  loadingPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyText: {
    fontSize: typography.body,
    textAlign: 'center',
  },
  itemListBody: {
    flex: 1,
  },
  itemList: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  itemSeparator: {
    height: spacing.sm,
  },
  itemName: {
    fontSize: typography.bodyLarge,
    fontWeight: typography.semibold,
  },
  itemUnit: {
    fontSize: typography.caption,
    marginTop: 2,
  },
  countInput: {
    width: 96,
    textAlign: 'right',
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  submitWrap: {
    width: '100%',
  },
});

// src/screens/staff/screens/WeeklyCount.tsx — the weekly full-store count.
//
// Spec 098 §7. A staff-facing equivalent of the admin Inventory count
// page, used on a weekly cadence:
//   - NOT vendor-scoped — lists EVERY item at the active store.
//   - Dual case/each inputs where case_qty > 1 (spec 086 pattern); single
//     input otherwise.
//   - Submit gated on ≥1 non-blank entry; client-minted client_uuid for
//     idempotency (handled in useStaffStore.submitWeeklyCount).
//   - Date captured at SUBMIT time via the local todayIso() convention.
//   - Advisory snapshot — the RPC does NOT write current_stock.
//
// The persistent WeeklyDueBanner (the "reliable floor" reminder) reads
// the staff store's `weeklyStatus`, which this screen refreshes on focus
// (staff v1 has no realtime). On a successful submit the status flips to
// 'completed' (optimistically in the store) and the banner clears.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { ListRow } from '../components/ListRow';
import { LocaleSwitcher } from '../components/LocaleSwitcher';
import { WeeklyDueBanner } from '../components/WeeklyDueBanner';
import { supabase } from '../../../lib/supabase';
import { notifyBackendError } from '../lib/notifyBackendError';
import { useStaffStore } from '../store/useStaffStore';
import { t, useI18n } from '../i18n';
import { spacing, typography, useStaffColors } from '../theme';
import type { WeeklyEntry, WeeklyItem } from '../lib/types';

function todayIso(d = new Date()): string {
  // yyyy-mm-dd in local time (matches EODCount.todayIso — avoids the UTC
  // off-by-one the spec's week-window math depends on).
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Takes a `t` so the caller can pass the reactive `useI18n()` t (spec
// 099) — the header label must re-translate on a locale change.
function todayHeaderLabel(tt: typeof t, d = new Date()): string {
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return tt('weekly.header.today', { weekday, monthDay });
}

// ── data fetch ────────────────────────────────────────────────────
async function fetchAllItemsForStore(storeId: string): Promise<WeeklyItem[]> {
  // Every inventory item at the store (NOT vendor-scoped) joined to the
  // catalog for the canonical name + unit + units-per-case. Same source
  // the EOD screen reads (catalog_ingredients.case_qty, spec 086).
  const { data, error } = await supabase
    .from('inventory_items')
    .select('id, catalog:catalog_ingredients(name, unit, category, case_qty)')
    .eq('store_id', storeId)
    .order('id', { ascending: true });
  if (error) throw error;
  type CatalogRow = {
    name: string | null;
    unit: string | null;
    category: string | null;
    case_qty: number | string | null;
  };
  type Row = {
    id: string;
    catalog: CatalogRow | CatalogRow[] | null;
  };
  const rows = (data ?? []) as Row[];
  return rows
    .map((r) => {
      const c = Array.isArray(r.catalog) ? r.catalog[0] : r.catalog;
      return {
        id: r.id,
        name: c?.name ?? '',
        unit: c?.unit ?? '',
        // Collapse null/missing category to '' (same convention as the
        // admin inventory mapper, db.ts:3498); the render groups the ''
        // bucket under an "Uncategorized" header.
        category: c?.category ?? '',
        caseQty: c?.case_qty == null ? null : Number(c.case_qty),
      };
    })
    // Stable alphabetical order so the long full-store list is scannable.
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── screen ────────────────────────────────────────────────────────
export function WeeklyCount() {
  const c = useStaffColors();
  // Reactive `t` (spec 099) — render-path strings re-translate on locale change.
  const { t } = useI18n();
  const activeStore = useStaffStore((s) => s.activeStore);
  const fetchWeeklyStatus = useStaffStore((s) => s.fetchWeeklyStatus);
  const submitWeeklyCount = useStaffStore((s) => s.submitWeeklyCount);

  const [items, setItems] = useState<WeeklyItem[]>([]);
  const [caseCounts, setCaseCounts] = useState<Record<string, string>>({});
  const [unitCounts, setUnitCounts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [forbidden, setForbidden] = useState<boolean>(false);
  const [completedFor, setCompletedFor] = useState<string | null>(null);

  // Recompute when `t` (locale) changes so the header date re-translates.
  const todayLabel = useMemo(() => todayHeaderLabel(t), [t]);

  // ─── load every item for the active store on mount / store change ──
  useEffect(() => {
    if (!activeStore) return;
    setLoading(true);
    setForbidden(false);
    setCompletedFor(null);
    fetchAllItemsForStore(activeStore.id)
      .then((next) => {
        setItems(next);
        setCaseCounts({});
        setUnitCounts({});
      })
      .catch((err) => {
        notifyBackendError('fetchAllItemsForStore', err);
        setItems([]);
      })
      .finally(() => setLoading(false));
  }, [activeStore]);

  // ─── refresh the weekly status on focus (banner floor, no realtime) ──
  useFocusEffect(
    useCallback(() => {
      if (!activeStore) return;
      void fetchWeeklyStatus(activeStore.id, todayIso());
    }, [activeStore, fetchWeeklyStatus]),
  );

  // ─── submit ───────────────────────────────────────────────────────
  const nonBlankCount = useMemo(
    () =>
      items.filter(
        (it) =>
          (caseCounts[it.id] ?? '').trim() !== '' ||
          (unitCounts[it.id] ?? '').trim() !== '',
      ).length,
    [items, caseCounts, unitCounts],
  );

  // ─── group items by category for display-only section headers ──────
  // Mirrors the admin `grouped` idiom (InventoryCountSection.tsx): a Map
  // keyed by category, items alphabetized within each group (the source
  // list is already name-sorted), groups sorted alphabetically. The empty
  // '' bucket maps to an "Uncategorized" title. Grouping is VIEW-only — it
  // never changes what gets submitted (onSubmit iterates `items`, never
  // the grouped sections), per spec.
  const sections = useMemo(() => {
    const map = new Map<string, WeeklyItem[]>();
    for (const it of items) {
      const arr = map.get(it.category) || [];
      arr.push(it);
      map.set(it.category, arr);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, data]) => ({
        category,
        title: category || t('weekly.category.uncategorized'),
        data,
      }));
  }, [items, t]);

  const onSubmit = useCallback(async () => {
    if (!activeStore || submitting) return;
    if (items.length === 0) return;
    // Build entries — include a row when EITHER its Cases OR Units box is
    // non-empty (mirrors the EOD `hasEntry` rule). Total =
    // cases × (caseQty || 1) + units; raw splits null when blank.
    const entries: WeeklyEntry[] = items
      .map((it) => {
        const caseRaw = caseCounts[it.id] ?? '';
        const unitRaw = unitCounts[it.id] ?? '';
        if (caseRaw.trim() === '' && unitRaw.trim() === '') return null;
        const casesParsed = parseFloat(caseRaw);
        const unitsParsed = parseFloat(unitRaw);
        const cases = Number.isNaN(casesParsed) ? 0 : casesParsed;
        const units = Number.isNaN(unitsParsed) ? 0 : unitsParsed;
        const total = cases * (it.caseQty || 1) + units;
        return {
          item_id: it.id,
          actual_remaining: total,
          actual_remaining_cases: Number.isNaN(casesParsed) ? null : casesParsed,
          actual_remaining_each: Number.isNaN(unitsParsed) ? null : unitsParsed,
          unit: it.unit || null,
        };
      })
      .filter((x): x is WeeklyEntry => x !== null);
    if (entries.length === 0) {
      Toast.show({
        type: 'error',
        text1: t('weekly.toast.failed'),
        text2: t('weekly.toast.noCountsEntered'),
        position: 'bottom',
      });
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitWeeklyCount({
        storeId: activeStore.id,
        countedAt: new Date().toISOString(),
        entries,
        notes: null,
      });
      if (!result) {
        // notifyBackendError already toasted. A 42501 (access changed)
        // surfaces the forbidden banner like EOD does.
        setForbidden(true);
        return;
      }
      if (result.conflict) {
        Toast.show({
          type: 'success',
          text1: t('weekly.toast.alreadySubmitted'),
          position: 'bottom',
        });
      } else {
        Toast.show({
          type: 'success',
          text1: t('weekly.toast.submitted'),
          position: 'bottom',
        });
      }
      // Clear the form and show the "completed for the week of <date>"
      // confirmation. submitWeeklyCount has already optimistically flipped
      // weeklyStatus.status → 'completed' (so the banner clears now);
      // `windowStart` is preserved from the pre-submit status. Re-fetch in
      // the background so the next focus reflects the server truth.
      setCaseCounts({});
      setUnitCounts({});
      const ws = useStaffStore.getState().weeklyStatus;
      setCompletedFor(ws?.windowStart ?? todayIso());
      void fetchWeeklyStatus(activeStore.id, todayIso());
    } finally {
      setSubmitting(false);
    }
  }, [activeStore, items, caseCounts, unitCounts, submitWeeklyCount, fetchWeeklyStatus, submitting, t]);

  // ─── confirm before submitting a full-store count ─────────────────
  const onSubmitPress = useCallback(() => {
    if (nonBlankCount === 0) {
      Toast.show({
        type: 'error',
        text1: t('weekly.toast.failed'),
        text2: t('weekly.toast.noCountsEntered'),
        position: 'bottom',
      });
      return;
    }
    void onSubmit();
  }, [nonBlankCount, onSubmit, t]);

  if (!activeStore) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: c.bgAlt }]}
        edges={['top', 'bottom']}
      >
        <View style={styles.empty}>
          <ActivityIndicator color={c.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
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
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          {t('weekly.title')}
        </Text>
        <Text style={[styles.subtitle, { color: c.textSecondary }]} numberOfLines={2}>
          {activeStore.name} · {todayLabel}
        </Text>
        <Text style={[styles.subtitle, { color: c.textTertiary }]} numberOfLines={2}>
          {t('weekly.subtitle')}
        </Text>
        <View style={styles.headerSwitcherRow}>
          <LocaleSwitcher />
        </View>
      </View>

      {/* Persistent due/overdue banner — the reliable floor. */}
      <WeeklyDueBanner />

      {/* Forbidden banner */}
      {forbidden ? <Banner tone="error" text={t('weekly.error.forbidden')} /> : null}

      {/* Completed confirmation */}
      {completedFor ? (
        <Banner
          tone="success"
          text={t('weekly.banner.completed', { date: completedFor })}
          testID="weekly-completed-banner"
        />
      ) : null}

      {/* Items list */}
      {loading ? (
        <View style={styles.loadingPane}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyPane}>
          <Text style={[styles.emptyText, { color: c.textSecondary }]}>
            {t('weekly.list.empty')}
          </Text>
        </View>
      ) : (
        <SectionList
          testID="weekly-item-list"
          sections={sections}
          keyExtractor={(i) => i.id}
          style={styles.itemListBody}
          contentContainerStyle={styles.itemList}
          stickySectionHeadersEnabled={false}
          ItemSeparatorComponent={() => <View style={styles.itemSeparator} />}
          renderSectionHeader={({ section }) => (
            <View
              style={[styles.sectionHeader, { backgroundColor: c.bgAlt }]}
              testID={`weekly-category-header-${section.category || 'uncategorized'}`}
            >
              <Text style={[styles.sectionHeaderTitle, { color: c.textSecondary }]}>
                {section.title}
              </Text>
              <View style={[styles.sectionHeaderRule, { backgroundColor: c.border }]} />
              <Text style={[styles.sectionHeaderCount, { color: c.textTertiary }]}>
                {t('weekly.category.count', { count: section.data.length })}
              </Text>
            </View>
          )}
          renderItem={({ item }) => {
            const caseRaw = caseCounts[item.id] ?? '';
            const unitRaw = unitCounts[item.id] ?? '';
            // case_qty > 1 → the Cases box meaningfully multiplies → render
            // the dual case/each inputs. Otherwise a single Units input.
            const hasPack = (item.caseQty ?? 0) > 1;
            const entered = caseRaw.trim() !== '' || unitRaw.trim() !== '';
            const casesParsed = parseFloat(caseRaw);
            const unitsParsed = parseFloat(unitRaw);
            const total =
              (Number.isNaN(casesParsed) ? 0 : casesParsed) * (item.caseQty || 1) +
              (Number.isNaN(unitsParsed) ? 0 : unitsParsed);
            return (
              <ListRow
                testID={`weekly-item-row-${item.id}`}
                leading={
                  <View>
                    <Text style={[styles.itemName, { color: c.text }]} numberOfLines={2}>
                      {item.name}
                    </Text>
                    {item.unit || hasPack ? (
                      <Text style={[styles.itemUnit, { color: c.textSecondary }]}>
                        {item.unit}
                        {hasPack ? ` · ${t('weekly.row.caseOf', { qty: item.caseQty as number })}` : ''}
                      </Text>
                    ) : null}
                    {hasPack && entered ? (
                      <Text
                        style={[styles.itemTotal, { color: c.textSecondary }]}
                        testID={`weekly-item-total-${item.id}`}
                      >
                        {t('weekly.row.total', { total, unit: item.unit })}
                      </Text>
                    ) : null}
                  </View>
                }
                trailing={
                  hasPack ? (
                    <View style={styles.countInputs}>
                      <View style={styles.countCol}>
                        <Text style={[styles.countColLabel, { color: c.textSecondary }]}>
                          {t('weekly.col.cases')}
                        </Text>
                        <Input
                          value={caseRaw}
                          onChangeText={(txt) =>
                            setCaseCounts((prev) => ({ ...prev, [item.id]: txt }))
                          }
                          keyboardType="decimal-pad"
                          {...(Platform.OS === 'web' ? { inputMode: 'decimal' as const } : {})}
                          placeholder="0"
                          testID={`weekly-item-cases-${item.id}`}
                          style={styles.countInput}
                          accessibilityLabel={t('weekly.col.casesAria', { item: item.name })}
                        />
                      </View>
                      <View style={styles.countCol}>
                        <Text style={[styles.countColLabel, { color: c.textSecondary }]}>
                          {t('weekly.col.units')}
                        </Text>
                        <Input
                          value={unitRaw}
                          onChangeText={(txt) =>
                            setUnitCounts((prev) => ({ ...prev, [item.id]: txt }))
                          }
                          keyboardType="decimal-pad"
                          {...(Platform.OS === 'web' ? { inputMode: 'decimal' as const } : {})}
                          placeholder="0"
                          testID={`weekly-item-units-${item.id}`}
                          style={styles.countInput}
                          accessibilityLabel={t('weekly.col.unitsAria', { item: item.name })}
                        />
                      </View>
                    </View>
                  ) : (
                    <View style={styles.countCol}>
                      <Text style={[styles.countColLabel, { color: c.textSecondary }]}>
                        {t('weekly.col.units')}
                      </Text>
                      <Input
                        value={unitRaw}
                        onChangeText={(txt) =>
                          setUnitCounts((prev) => ({ ...prev, [item.id]: txt }))
                        }
                        keyboardType="decimal-pad"
                        {...(Platform.OS === 'web' ? { inputMode: 'decimal' as const } : {})}
                        placeholder="0"
                        testID={`weekly-item-units-${item.id}`}
                        style={styles.countInput}
                        accessibilityLabel={t('weekly.col.unitsAria', { item: item.name })}
                      />
                    </View>
                  )
                }
              />
            );
          }}
        />
      )}

      {/* Footer — submit */}
      <View
        style={[
          styles.footer,
          { backgroundColor: c.surface, borderTopColor: c.border },
        ]}
      >
        <View style={styles.submitWrap}>
          <Button
            label={submitting ? t('weekly.submitting') : t('weekly.submit')}
            onPress={onSubmitPress}
            disabled={items.length === 0 || forbidden || nonBlankCount === 0}
            loading={submitting}
            testID="weekly-submit"
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
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
    gap: 2,
  },
  title: {
    fontSize: typography.title,
    fontWeight: typography.bold,
  },
  subtitle: {
    fontSize: typography.caption,
  },
  // Mirrors EODCount.headerSwitcherRow — left-aligned LocaleSwitcher under the
  // title/subtitle stack. marginTop here because the header's `gap` is a tight
  // 2px (tuned for the title/subtitle lines), too tight to space the switcher.
  headerSwitcherRow: {
    flexDirection: 'row',
    marginTop: spacing.sm,
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
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  sectionHeaderTitle: {
    fontSize: typography.caption,
    fontWeight: typography.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionHeaderRule: {
    flex: 1,
    height: 1,
  },
  sectionHeaderCount: {
    fontSize: typography.caption,
    fontWeight: typography.medium,
  },
  itemName: {
    fontSize: typography.bodyLarge,
    fontWeight: typography.semibold,
  },
  itemUnit: {
    fontSize: typography.caption,
    marginTop: 2,
  },
  itemTotal: {
    fontSize: typography.caption,
    marginTop: 2,
    fontWeight: typography.semibold,
  },
  countInputs: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  countCol: {
    width: 76,
  },
  countColLabel: {
    fontSize: typography.caption,
    marginBottom: spacing.xs,
    textAlign: 'center',
    fontWeight: typography.medium,
  },
  countInput: {
    width: 76,
    textAlign: 'center',
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

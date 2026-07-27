// src/screens/staff/screens/eod/StaffEodCountRow.tsx — Spec 141 §7 (AC-1/AC-2).
//
// Presentational EOD count row. Keeps the existing staff `<ListRow>` card
// wrapper (so card chrome / spacing / elevation are unchanged); only the
// leading counted/uncounted indicator and the two trailing count "wells" are
// new. The wells are `Pressable`/`Text` — NEVER a `TextInput` — so tapping one
// opens the keypad sheet instead of the OS keyboard (spec 141 OQ-STAFF-1 = A).
//
// The item name renders in `c.text` ALWAYS (AC-1 — this deletes the old
// `entered ? c.text : c.error` red-name treatment); the indicator now carries
// the counted state. Every write flows back to the orchestrator
// (`EODCount.tsx`) via `onOpenWell`, so the count maps stay the single source
// of truth.

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ListRow } from '../../components/ListRow';
import { IngredientThumb } from '../../components/IngredientThumb';
import { UpdatedBadge } from '../../components/UpdatedBadge';
import { useI18n } from '../../i18n';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../../theme';
import type { EodItem } from '../../lib/types';

export interface StaffEodCountRowProps {
  item: EodItem;
  /** getLocalizedName(...) computed by the orchestrator. */
  displayName: string;
  /** isCounted(item) — cases OR units non-blank (spec 102). */
  counted: boolean;
  caseValue: string;
  unitValue: string;
  /** cases*(caseQty||1)+units (existing math). */
  total: number;
  /** (caseQty ?? 0) > 1 — show the CS well. */
  hasPack: boolean;
  /** inputsLocked (spec 129) — read-only wells, no keypad on tap. */
  locked: boolean;
  onOpenWell: (item: EodItem, field: 'cases' | 'units') => void;
}

export function StaffEodCountRow({
  item,
  displayName,
  counted,
  caseValue,
  unitValue,
  total,
  hasPack,
  locked,
  onOpenWell,
}: StaffEodCountRowProps) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(T), [T]);

  const Well = ({ field, label, value }: { field: 'cases' | 'units'; label: string; value: string }) => {
    const filled = value.trim() !== '';
    return (
      <Pressable
        testID={`eod-well-${item.id}-${field}`}
        onPress={() => onOpenWell(item, field)}
        disabled={locked}
        accessibilityRole="button"
        accessibilityState={{ disabled: locked }}
        accessibilityLabel={
          field === 'cases'
            ? t('eod.col.casesAria', { item: displayName })
            : t('eod.col.unitsAria', { item: displayName })
        }
        style={[
          styles.well,
          {
            borderColor: filled ? c.border : c.borderStrong,
            borderStyle: filled ? 'solid' : 'dashed',
            backgroundColor: filled ? c.surfaceAlt : 'transparent',
          },
          locked && styles.wellLocked,
        ]}
      >
        <Text style={[styles.wellLabel, { color: c.textSecondary }]} numberOfLines={1}>
          {label}
        </Text>
        {/* Keep the old `eod-item-cases/units-<id>` testID on the value text so
            existing tests that target those ids still resolve (mapped onto the
            well value). */}
        <Text
          testID={`eod-item-${field}-${item.id}`}
          style={[styles.wellValue, { color: filled ? c.text : c.textSecondary }]}
          numberOfLines={1}
        >
          {filled ? value : '—'}
        </Text>
      </Pressable>
    );
  };

  return (
    <ListRow
      testID={`eod-item-row-${item.id}`}
      leading={
        <View style={styles.leadingRow}>
          {/* Counted/uncounted indicator (AC-1) — replaces the red-name. */}
          <View
            accessibilityRole="image"
            accessibilityLabel={counted ? t('eod.row.counted') : t('eod.row.uncounted')}
            style={[
              styles.indicator,
              counted
                ? { backgroundColor: c.primaryPressedLight, borderColor: c.primary, borderStyle: 'solid' }
                : { backgroundColor: 'transparent', borderColor: c.borderStrong, borderStyle: 'dashed' },
            ]}
          >
            {counted ? (
              <Text testID={`eod-counted-${item.id}`} style={[styles.indicatorCheck, { color: c.primary }]}>
                ✓
              </Text>
            ) : null}
          </View>
          {/* Spec 127 — ingredient photo (or placeholder). View-only. */}
          <IngredientThumb path={item.imagePath} testID={`eod-item-thumb-${item.id}`} />
          <View style={styles.leadingText}>
            <View style={styles.itemNameRow}>
              <Text style={[styles.itemName, { color: c.text }]} numberOfLines={2}>
                {displayName}
              </Text>
              {/* Spec 128 — "Updated" pill. */}
              {item.updated ? <UpdatedBadge testID={`eod-updated-badge-${item.id}`} /> : null}
            </View>
            {item.unit || hasPack ? (
              <Text style={[styles.itemUnit, { color: c.textSecondary }]}>
                {item.unit}
                {hasPack ? ` · ${t('eod.row.caseOf', { qty: item.caseQty as number })}` : ''}
              </Text>
            ) : null}
            {hasPack && counted ? (
              <Text
                style={[styles.itemTotal, { color: c.textSecondary }]}
                testID={`eod-item-total-${item.id}`}
              >
                {t('eod.row.total', { total, unit: item.unit })}
              </Text>
            ) : null}
          </View>
        </View>
      }
      trailing={
        <View style={styles.wells}>
          {hasPack ? (
            <Well
              field="cases"
              label={t('eod.sheet.casesWell', { qty: item.caseQty as number })}
              value={caseValue}
            />
          ) : null}
          <Well field="units" label={item.unit || t('eod.col.units')} value={unitValue} />
        </View>
      }
    />
  );
}

const makeStyles = (T: StaffTokens) =>
  StyleSheet.create({
    leadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: T.spacing.md,
    },
    // 20×20 counted/uncounted indicator (density-scaled off the base).
    indicator: {
      width: Math.round((20 / 9) * T.typography.bodyLarge),
      height: Math.round((20 / 9) * T.typography.bodyLarge),
      borderRadius: T.radius.sm,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    indicatorCheck: {
      fontSize: T.typography.body,
      fontWeight: T.typography.bold,
    },
    leadingText: {
      flex: 1,
      minWidth: 0,
    },
    itemNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: T.spacing.sm,
    },
    itemName: {
      flexShrink: 1,
      fontSize: T.typography.bodyLarge,
      fontWeight: T.typography.semibold,
    },
    itemUnit: {
      fontSize: T.typography.caption,
      marginTop: 2,
    },
    itemTotal: {
      fontSize: T.typography.caption,
      marginTop: 2,
      fontWeight: T.typography.semibold,
    },
    // Two large tap-target wells in the trailing slot.
    wells: {
      flexDirection: 'row',
      gap: T.spacing.sm,
      alignItems: 'stretch',
    },
    well: {
      minWidth: Math.round((56 / 9) * T.typography.bodyLarge),
      minHeight: T.touchTarget.min,
      borderWidth: 1,
      borderRadius: T.radius.md,
      paddingHorizontal: T.spacing.sm,
      paddingVertical: T.spacing.xs,
      justifyContent: 'center',
    },
    wellLocked: {
      opacity: 0.6,
    },
    wellLabel: {
      fontSize: T.typography.caption,
      textAlign: 'center',
    },
    wellValue: {
      fontSize: T.typography.bodyLarge,
      fontWeight: T.typography.semibold,
      textAlign: 'center',
      marginTop: 1,
    },
  });

export default StaffEodCountRow;

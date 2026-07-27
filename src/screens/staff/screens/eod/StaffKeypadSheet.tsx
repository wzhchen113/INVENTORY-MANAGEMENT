// src/screens/staff/screens/eod/StaffKeypadSheet.tsx — Spec 141 §7 (AC-4..AC-7).
//
// The staff EOD keypad-entry sheet, built on the staff-local `BottomSheet`
// (§6). Presentational: every write goes back through the orchestrator
// (`EODCount.tsx`) via `onKey`, so the existing `caseCounts`/`unitCounts` maps
// stay the single source of truth. The field wells are `Pressable`/`Text`
// (never `TextInput`), so the OS keyboard never opens for the custom digit pad.
//
// NOTE: there is deliberately NO note `TextInput` here (spec 141 OQ-A). The
// staff EOD submit path has never carried a per-item note, and wiring one would
// require a store field + RPC change barred by the HARD NON-GOAL. The sheet is
// AC-4 "minus the note row".

import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BottomSheet } from '../../components/BottomSheet';
import { useI18n } from '../../i18n';
import { KEYPAD_BACKSPACE } from '../../lib/eodKeypad';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../../theme';
import type { EodItem } from '../../lib/types';

export interface StaffKeypadSheetProps {
  visible: boolean;
  item: EodItem | null;
  displayName: string;
  activeField: 'cases' | 'units';
  setActiveField: (f: 'cases' | 'units') => void;
  caseValue: string;
  unitValue: string;
  runningTotal: number;
  /** True when nothing uncounted remains → NEXT ITEM relabels to DONE ✓. */
  isDone: boolean;
  onKey: (key: string) => void;
  onSkip: () => void;
  onNext: () => void;
  onClose: () => void;
}

const DIGIT_KEYS: string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', KEYPAD_BACKSPACE];

function keyTestId(k: string): string {
  if (k === KEYPAD_BACKSPACE) return 'eod-key-back';
  if (k === '.') return 'eod-key-dot';
  return `eod-key-${k}`;
}

export function StaffKeypadSheet({
  visible,
  item,
  displayName,
  activeField,
  setActiveField,
  caseValue,
  unitValue,
  runningTotal,
  isDone,
  onKey,
  onSkip,
  onNext,
  onClose,
}: StaffKeypadSheetProps) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(T), [T]);

  if (!item) return null;

  const hasPack = (item.caseQty ?? 0) > 1;

  const Well = ({ field, label, value }: { field: 'cases' | 'units'; label: string; value: string }) => {
    const active = activeField === field;
    const filled = value.trim() !== '';
    return (
      <Pressable
        testID={`eod-sheet-well-${field}`}
        onPress={() => setActiveField(field)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
        style={[
          styles.well,
          {
            borderWidth: active ? 2 : 1,
            borderColor: active ? c.primary : c.borderStrong,
            backgroundColor: active ? c.primaryPressedLight : c.surfaceAlt,
          },
        ]}
      >
        <Text style={[styles.wellLabel, { color: c.textSecondary }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.wellValue, { color: filled ? c.text : c.textSecondary }]} numberOfLines={1}>
          {filled ? value : '—'}
        </Text>
      </Pressable>
    );
  };

  const header = (
    <View style={[styles.header, { borderBottomColor: c.border }]}>
      <View style={styles.headerText}>
        <Text testID="eod-sheet-title" style={[styles.title, { color: c.text }]} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={[styles.meta, { color: c.textSecondary }]} numberOfLines={1}>
          {item.unit}
          {hasPack ? ` · ${t('eod.row.caseOf', { qty: item.caseQty as number })}` : ''}
        </Text>
      </View>
      <Pressable
        testID="eod-sheet-close"
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('eod.sheet.close')}
        style={styles.closeBtn}
      >
        <Text style={[styles.closeGlyph, { color: c.textSecondary }]}>✕</Text>
      </Pressable>
    </View>
  );

  const footer = (
    <View style={[styles.footer, { borderTopColor: c.border }]}>
      <Pressable
        testID="eod-sheet-skip"
        onPress={onSkip}
        accessibilityRole="button"
        accessibilityLabel={t('eod.sheet.skip')}
        style={[styles.footerBtn, styles.skipBtn, { borderColor: c.borderStrong }]}
      >
        <Text style={[styles.skipText, { color: c.textSecondary }]}>{t('eod.sheet.skip')}</Text>
      </Pressable>
      <Pressable
        testID="eod-sheet-next"
        onPress={onNext}
        accessibilityRole="button"
        accessibilityLabel={isDone ? t('eod.sheet.done') : t('eod.sheet.nextItem')}
        style={[styles.footerBtn, styles.nextBtn, { backgroundColor: c.primary }]}
      >
        <Text style={[styles.nextText, { color: c.textOnPrimary }]}>
          {isDone ? t('eod.sheet.done') : t('eod.sheet.nextItem')}
        </Text>
      </Pressable>
    </View>
  );

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      header={header}
      footer={footer}
      accessibilityLabel={t('eod.sheet.title', { item: displayName })}
    >
      <ScrollView contentContainerStyle={styles.body}>
        {/* Field wells — the active field takes the pad's digits (AC-6). */}
        <View style={styles.wellRow}>
          {hasPack ? (
            <Well field="cases" label={t('eod.sheet.casesWell', { qty: item.caseQty as number })} value={caseValue} />
          ) : null}
          <Well field="units" label={item.unit || t('eod.col.units')} value={unitValue} />
        </View>

        {/* Running total. */}
        <Text testID="eod-sheet-total" style={[styles.total, { color: c.text }]}>
          {t('eod.sheet.runningTotal', { total: runningTotal, unit: item.unit })}
        </Text>

        {/* 3-column digit pad (flex-wrap rows, no CSS grid). */}
        <View style={styles.pad}>
          {DIGIT_KEYS.map((k) => (
            <View key={k} style={styles.padCell}>
              <Pressable
                testID={keyTestId(k)}
                onPress={() => onKey(k)}
                accessibilityRole="button"
                accessibilityLabel={k === KEYPAD_BACKSPACE ? t('eod.sheet.backspace') : k}
                style={[styles.key, { borderColor: c.border, backgroundColor: c.surfaceAlt }]}
              >
                <Text style={[styles.keyText, { color: c.text }]}>{k}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

const makeStyles = (T: StaffTokens) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: T.spacing.lg,
      paddingTop: T.spacing.md,
      paddingBottom: T.spacing.sm,
      borderBottomWidth: 1,
      gap: T.spacing.md,
    },
    headerText: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      fontSize: T.typography.title,
      fontWeight: T.typography.bold,
    },
    meta: {
      fontSize: T.typography.caption,
      marginTop: 2,
    },
    closeBtn: {
      minWidth: T.touchTarget.min,
      minHeight: T.touchTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    closeGlyph: {
      fontSize: T.typography.headline,
      fontWeight: T.typography.medium,
    },
    body: {
      paddingHorizontal: T.spacing.lg,
      paddingTop: T.spacing.md,
      gap: T.spacing.md,
    },
    wellRow: {
      flexDirection: 'row',
      gap: T.spacing.sm,
    },
    well: {
      flex: 1,
      minHeight: T.touchTarget.min * 2,
      borderRadius: T.radius.md,
      paddingHorizontal: T.spacing.md,
      justifyContent: 'center',
    },
    wellLabel: {
      fontSize: T.typography.caption,
    },
    wellValue: {
      fontSize: T.typography.headline,
      fontWeight: T.typography.bold,
      marginTop: 2,
    },
    total: {
      fontSize: T.typography.body,
      fontWeight: T.typography.semibold,
    },
    pad: {
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    padCell: {
      width: '33.3333%',
      padding: T.spacing.xs,
    },
    key: {
      minHeight: T.touchTarget.min * 2,
      borderWidth: 1,
      borderRadius: T.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    keyText: {
      fontSize: T.typography.headline,
      fontWeight: T.typography.semibold,
    },
    footer: {
      flexDirection: 'row',
      gap: T.spacing.sm,
      paddingHorizontal: T.spacing.lg,
      paddingTop: T.spacing.sm,
      paddingBottom: T.spacing.sm,
      borderTopWidth: 1,
    },
    footerBtn: {
      minHeight: T.touchTarget.min * 1.5,
      borderRadius: T.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    skipBtn: {
      flex: 1,
      borderWidth: 1,
    },
    skipText: {
      fontSize: T.typography.body,
      fontWeight: T.typography.semibold,
    },
    nextBtn: {
      flex: 2,
    },
    nextText: {
      fontSize: T.typography.body,
      fontWeight: T.typography.bold,
    },
  });

export default StaffKeypadSheet;

// src/components/DateScopeBar.tsx
// Shared "Single date / Date range" toggle + DatePicker(s) used by screens
// that scope their data to a date or window. Controlled component — parent
// owns the state.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import DatePicker from './DatePicker';
import { useColors, Spacing, Radius, FontSize } from '../theme/colors';

export type DateScopeMode = 'single' | 'range';

interface Props {
  mode: DateScopeMode;
  startDate: string;
  endDate: string;
  onModeChange: (mode: DateScopeMode) => void;
  onStartChange: (d: string) => void;
  onEndChange: (d: string) => void;
  /** When clearing a picker, fall back to this date instead of empty. */
  defaultDate?: string;
  /** Test id prefix for stable selectors. */
  testIdPrefix?: string;
  /** Label for the single-mode picker. */
  singleLabel?: string;
  rangeStartLabel?: string;
  rangeEndLabel?: string;
  /** When toggling single → range and start === end, jump start back this many
   *  days so the user gets a useful default window. */
  singleToRangeGapDays?: number;
}

function shiftIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function DateScopeBar({
  mode,
  startDate,
  endDate,
  onModeChange,
  onStartChange,
  onEndChange,
  defaultDate = '',
  testIdPrefix = 'datescope',
  singleLabel = 'Date',
  rangeStartLabel = 'Start date',
  rangeEndLabel = 'End date',
  singleToRangeGapDays = 6,
}: Props) {
  const C = useColors();

  const handleRangeMode = () => {
    if (mode === 'range') return;
    if (endDate && startDate === endDate) {
      onStartChange(shiftIso(endDate, -singleToRangeGapDays));
    }
    onModeChange('range');
  };

  return (
    <>
      <View style={[styles.modeRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
        <TouchableOpacity
          testID={`${testIdPrefix}-mode-single`}
          style={[styles.modeBtn, mode === 'single' && { backgroundColor: C.bgPrimary, borderColor: C.borderMedium }]}
          onPress={() => onModeChange('single')}
        >
          <Text style={[styles.modeText, { color: mode === 'single' ? C.textPrimary : C.textSecondary }]}>Single date</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`${testIdPrefix}-mode-range`}
          style={[styles.modeBtn, mode === 'range' && { backgroundColor: C.bgPrimary, borderColor: C.borderMedium }]}
          onPress={handleRangeMode}
        >
          <Text style={[styles.modeText, { color: mode === 'range' ? C.textPrimary : C.textSecondary }]}>Date range</Text>
        </TouchableOpacity>
      </View>

      {mode === 'single' ? (
        <DatePicker
          testIdPrefix={`${testIdPrefix}-single`}
          value={endDate}
          onChange={(d) => {
            const next = d || defaultDate;
            onEndChange(next);
            onStartChange(next);
          }}
          label={singleLabel}
          placeholder="Select a date"
        />
      ) : (
        <View style={styles.rangeRow}>
          <View style={{ flex: 1 }}>
            <DatePicker
              testIdPrefix={`${testIdPrefix}-start`}
              value={startDate}
              onChange={(d) => onStartChange(d || defaultDate)}
              label={rangeStartLabel}
              placeholder="Start"
            />
          </View>
          <View style={{ flex: 1 }}>
            <DatePicker
              testIdPrefix={`${testIdPrefix}-end`}
              value={endDate}
              onChange={(d) => onEndChange(d || defaultDate)}
              label={rangeEndLabel}
              placeholder="End"
            />
          </View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  modeRow: { flexDirection: 'row', borderRadius: Radius.md, borderWidth: 0.5, padding: 2, marginBottom: Spacing.sm },
  modeBtn: { flex: 1, paddingVertical: 8, paddingHorizontal: Spacing.md, alignItems: 'center', borderRadius: Radius.sm, borderWidth: 0.5, borderColor: 'transparent' },
  modeText: { fontSize: FontSize.sm, fontWeight: '500' },
  rangeRow: { flexDirection: 'row', gap: Spacing.sm },
});

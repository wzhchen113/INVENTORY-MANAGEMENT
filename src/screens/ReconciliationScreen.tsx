// src/screens/ReconciliationScreen.tsx
import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { Card, CardHeader, Badge, WhoChip, EmptyState } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import DatePicker from '../components/DatePicker';
import { TimezoneBar } from '../components/TimezoneBar';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { buildReconciliationLines } from '../utils/usageCalculations';

const USER_COLORS: Record<string, string> = {
  'Maria Garcia': '#1D9E75',
  'James Thompson': '#D85A30',
  'Ana Rivera': '#D4537E',
  'Admin (Owner)': '#378ADD',
};

export default function ReconciliationScreen() {
  const {
    posImports, recipes, eodSubmissions, inventory, currentStore,
  } = useStore();
  const C = useColors();
  const [adminNote, setAdminNote] = useState('');

  // Default to the most recent EOD date (closing-count day) for this store,
  // falling back to the most recent POS date, then to "" if no data at all.
  const defaultDate = useMemo(() => {
    const eodDates = eodSubmissions
      .filter((e) => e.storeId === currentStore.id).map((e) => e.date).sort().reverse();
    if (eodDates[0]) return eodDates[0];
    const posDates = posImports
      .filter((p) => p.storeId === currentStore.id).map((p) => p.date).sort().reverse();
    return posDates[0] || '';
  }, [posImports, eodSubmissions, currentStore.id]);

  // True when the store has any POS or EOD data at all — used for the
  // "nothing to reconcile yet" empty state.
  const hasAnyData = useMemo(
    () => posImports.some((p) => p.storeId === currentStore.id)
       || eodSubmissions.some((e) => e.storeId === currentStore.id),
    [posImports, eodSubmissions, currentStore.id],
  );

  const [mode, setMode] = useState<'single' | 'range'>('single');
  const [startDate, setStartDate] = useState(defaultDate);
  const [endDate, setEndDate] = useState(defaultDate);

  // Effective range: in single mode start === end.
  const effectiveStart = mode === 'single' ? endDate : startDate;
  const effectiveEnd = endDate;
  const rangeValid = effectiveStart !== '' && effectiveEnd !== '' && effectiveStart <= effectiveEnd;

  const eodOnEnd = useMemo(
    () => eodSubmissions.find((s) => s.storeId === currentStore.id && s.date === effectiveEnd),
    [eodSubmissions, currentStore.id, effectiveEnd],
  );

  const lines = useMemo(
    () => rangeValid
      ? buildReconciliationLines(effectiveStart, effectiveEnd, currentStore.id, posImports, recipes, eodSubmissions, inventory)
      : [],
    [rangeValid, effectiveStart, effectiveEnd, currentStore.id, posImports, recipes, eodSubmissions, inventory]
  );

  const matched = lines.filter((l) => l.result === 'match').length;
  const mismatched = lines.filter((l) => l.result === 'mismatch').length;
  const review = lines.filter((l) => l.result === 'review').length;
  const mismatchLines = lines.filter((l) => l.result === 'mismatch');

  const varianceColor = (v: number) => {
    if (v === 0) return C.success;
    if (Math.abs(v) < 1) return C.warning;
    return C.danger;
  };

  const formatDisplayDate = (iso: string) => {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (!hasAnyData) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
        <TimezoneBar />
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <EmptyState message="No POS or EOD data yet for this store. Import POS sales and submit EOD counts to start reconciling." />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
    <TimezoneBar />
    <WebScrollView id="recon-scroll" contentContainerStyle={[styles.content, { backgroundColor: C.bgTertiary }] as any}>
      {/* Mode toggle */}
      <View style={[styles.modeRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
        <TouchableOpacity
          testID="recon-mode-single"
          style={[styles.modeBtn, mode === 'single' && { backgroundColor: C.bgPrimary, borderColor: C.borderMedium }]}
          onPress={() => setMode('single')}
        >
          <Text style={[styles.modeText, { color: mode === 'single' ? C.textPrimary : C.textSecondary }]}>Single date</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="recon-mode-range"
          style={[styles.modeBtn, mode === 'range' && { backgroundColor: C.bgPrimary, borderColor: C.borderMedium }]}
          onPress={() => {
            setMode('range');
            // Default the start to a week before end so the user has something sensible.
            if (endDate && startDate === endDate) {
              const d = new Date(endDate + 'T00:00:00');
              d.setDate(d.getDate() - 6);
              setStartDate(d.toISOString().split('T')[0]);
            }
          }}
        >
          <Text style={[styles.modeText, { color: mode === 'range' ? C.textPrimary : C.textSecondary }]}>Date range</Text>
        </TouchableOpacity>
      </View>

      {/* Date pickers */}
      {mode === 'single' ? (
        <DatePicker
          value={endDate}
          onChange={(d) => { setEndDate(d || defaultDate || ''); setStartDate(d || defaultDate || ''); }}
          label="Reconciliation date"
          placeholder="Select a date"
        />
      ) : (
        <View style={styles.rangeRow}>
          <View style={{ flex: 1 }}>
            <DatePicker
              testIdPrefix="recon-start"
              value={startDate}
              onChange={(d) => setStartDate(d || defaultDate || '')}
              label="Start date"
              placeholder="Start"
            />
          </View>
          <View style={{ flex: 1 }}>
            <DatePicker
              testIdPrefix="recon-end"
              value={endDate}
              onChange={(d) => setEndDate(d || defaultDate || '')}
              label="End date (EOD count)"
              placeholder="End"
            />
          </View>
        </View>
      )}

      {/* Range validation / EOD warnings */}
      {mode === 'range' && !rangeValid && effectiveStart && effectiveEnd && (
        <View style={[styles.warnBox, { backgroundColor: C.warningBg ?? '#fff3e0', borderColor: C.warning }]}>
          <Text style={[styles.warnText, { color: C.warning }]}>Start date must be on or before end date.</Text>
        </View>
      )}
      {rangeValid && !eodOnEnd && (
        <View style={[styles.warnBox, { backgroundColor: C.warningBg ?? '#fff3e0', borderColor: C.warning }]}>
          <Text style={[styles.warnText, { color: C.warning }]}>
            No EOD submission on {mode === 'range' ? 'end date' : 'this date'}. Submit an EOD count to reconcile.
          </Text>
        </View>
      )}

      {/* Summary bar */}
      <View style={[styles.summaryBar, { backgroundColor: C.bgPrimary, borderColor: C.borderLight, marginTop: Spacing.sm }]}>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryVal, { color: C.success }]}>{matched}</Text>
          <Text style={[styles.summaryLabel, { color: C.textTertiary }]}>Matched</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryVal, { color: C.danger }]}>{mismatched}</Text>
          <Text style={[styles.summaryLabel, { color: C.textTertiary }]}>Mismatch</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryVal, { color: C.warning }]}>{review}</Text>
          <Text style={[styles.summaryLabel, { color: C.textTertiary }]}>Review</Text>
        </View>
      </View>

      {/* Line items */}
      {lines.length === 0 ? (
        <EmptyState message="No EOD entries found for this date." />
      ) : (
        lines.map((line) => (
          <View key={line.itemId} style={[styles.lineCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, line.result === 'mismatch' && [styles.lineCardMismatch, { borderColor: C.danger + '44' }]]}>
            <View style={styles.lineTop}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.lineName, { color: C.textPrimary }]}>{line.itemName}</Text>
                <Text style={[styles.lineRecipe, { color: C.textSecondary }]}>{line.recipeUsed}</Text>
              </View>
              <Badge
                label={line.result === 'match' ? 'Match' : line.result === 'mismatch' ? 'Mismatch' : 'Review'}
                variant={line.result as any}
              />
            </View>

            <View style={[styles.lineStats, { borderBottomColor: C.borderLight }]}>
              <View style={styles.lineStat}>
                <Text style={[styles.lineStatLabel, { color: C.textTertiary }]}>POS qty</Text>
                <Text style={[styles.lineStatVal, { color: C.textPrimary }]}>{line.posQtySold}</Text>
              </View>
              <View style={styles.lineStat}>
                <Text style={[styles.lineStatLabel, { color: C.textTertiary }]}>Expected deduction</Text>
                <Text style={[styles.lineStatVal, { color: C.textPrimary }]}>{line.expectedDeduction} {line.unit}</Text>
              </View>
              <View style={styles.lineStat}>
                <Text style={[styles.lineStatLabel, { color: C.textTertiary }]}>Opening stock</Text>
                <Text style={[styles.lineStatVal, { color: C.textPrimary }]}>{line.openingStock} {line.unit}</Text>
              </View>
              <View style={styles.lineStat}>
                <Text style={[styles.lineStatLabel, { color: C.textTertiary }]}>Expected rem.</Text>
                <Text style={[styles.lineStatVal, { color: C.textPrimary }]}>{line.expectedRemaining} {line.unit}</Text>
              </View>
            </View>

            <View style={styles.eodRow}>
              <View style={styles.eodLeft}>
                <Text style={[styles.lineStatLabel, { color: C.textTertiary }]}>EOD entered by</Text>
                <WhoChip
                  name={line.eodBy}
                  color={USER_COLORS[line.eodBy] || C.userAdmin}
                  time={line.eodTime}
                />
              </View>
              <View style={styles.eodRight}>
                <Text style={[styles.lineStatLabel, { color: C.textTertiary }]}>EOD remaining</Text>
                <Text style={[styles.lineStatVal, { color: C.textPrimary }]}>{line.eodRemaining} {line.unit}</Text>
              </View>
              <View style={styles.eodRight}>
                <Text style={[styles.lineStatLabel, { color: C.textTertiary }]}>Variance</Text>
                <Text style={[styles.varianceVal, { color: varianceColor(line.variance) }]}>
                  {line.variance === 0 ? '0' : `${line.variance > 0 ? '+' : ''}${line.variance} ${line.unit}`}
                </Text>
              </View>
            </View>
          </View>
        ))
      )}

      {/* Mismatch analysis — dynamic */}
      {mismatchLines.length > 0 && (
        <Card>
          <CardHeader title="Mismatch analysis" />
          {mismatchLines.map((line) => {
            const item = inventory.find((i) => i.id === line.itemId);
            const cost = item ? Math.abs(line.variance) * item.costPerUnit : 0;
            return (
              <View key={line.itemId} style={[styles.misBox, { backgroundColor: C.dangerBg }]}>
                <Text style={[styles.misTitle, { color: C.danger }]}>
                  {line.itemName} — {Math.abs(line.variance)} {line.unit} {line.variance < 0 ? 'unaccounted' : 'surplus'}
                </Text>
                <Text style={[styles.misSub, { color: C.danger }]}>
                  EOD count entered by <Text style={{ fontWeight: '600' }}>{line.eodBy}</Text> at {line.eodTime}.{'\n'}
                  {Math.abs(line.variance)} {line.unit} × ${item?.costPerUnit.toFixed(2) || '?'}/{line.unit} = <Text style={{ color: C.danger, fontWeight: '600' }}>${cost.toFixed(2)} {line.variance < 0 ? 'unaccounted' : 'surplus'}</Text>{'\n\n'}
                  {line.variance < 0
                    ? 'Possible causes: waste not logged, over-portioning, spillage, or theft.'
                    : 'Possible causes: under-portioning, unrecorded delivery, or count error.'}
                </Text>
              </View>
            );
          })}
          <Text style={[styles.noteLabel, { color: C.textSecondary }]}>Admin notes</Text>
          <TextInput
            style={[styles.noteInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
            multiline
            placeholder="Add investigation notes..."
            placeholderTextColor={C.textTertiary}
            value={adminNote}
            onChangeText={setAdminNote}
          />
          <TouchableOpacity style={[styles.saveNoteBtn, { backgroundColor: C.textPrimary }]}>
            <Text style={[styles.saveNoteBtnText, { color: C.bgPrimary }]}>Save notes</Text>
          </TouchableOpacity>
        </Card>
      )}

      <View style={{ height: 32 }} />
    </WebScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg },
  summaryBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: Colors.borderLight, gap: Spacing.sm },
  summaryItem: { alignItems: 'center', flex: 1 },
  summaryVal: { fontSize: 22, fontWeight: '600' },
  summaryLabel: { fontSize: 9, color: Colors.textTertiary, marginTop: 2 },
  datePill: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 10, paddingVertical: 4 },
  dateText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  lineCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  lineCardMismatch: { borderColor: Colors.danger + '44', borderWidth: 1 },
  lineTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: Spacing.sm },
  lineName: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  lineRecipe: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  lineStats: { flexDirection: 'row', marginBottom: Spacing.sm, paddingBottom: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  lineStat: { flex: 1, alignItems: 'center' },
  lineStatLabel: { fontSize: 9, color: Colors.textTertiary, marginBottom: 2 },
  lineStatVal: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  eodRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  eodLeft: { flex: 2 },
  eodRight: { flex: 1, alignItems: 'center' },
  varianceVal: { fontSize: FontSize.sm, fontWeight: '600' },
  misBox: { backgroundColor: Colors.dangerBg, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md },
  misTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.danger, marginBottom: 6 },
  misSub: { fontSize: FontSize.xs, color: Colors.danger, lineHeight: 18 },
  noteLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 5 },
  noteInput: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.sm, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary, height: 80, textAlignVertical: 'top', marginBottom: Spacing.sm },
  saveNoteBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: 9, alignItems: 'center' },
  saveNoteBtnText: { color: Colors.bgPrimary, fontSize: FontSize.sm, fontWeight: '500' },
  modeRow: { flexDirection: 'row', borderRadius: Radius.md, borderWidth: 0.5, padding: 2, marginBottom: Spacing.sm },
  modeBtn: { flex: 1, paddingVertical: 8, paddingHorizontal: Spacing.md, alignItems: 'center', borderRadius: Radius.sm, borderWidth: 0.5, borderColor: 'transparent' },
  modeText: { fontSize: FontSize.sm, fontWeight: '500' },
  rangeRow: { flexDirection: 'row', gap: Spacing.sm },
  warnBox: { borderWidth: 0.5, borderRadius: Radius.md, padding: Spacing.sm, marginTop: Spacing.sm, marginBottom: Spacing.sm },
  warnText: { fontSize: FontSize.xs, fontWeight: '500' },
});

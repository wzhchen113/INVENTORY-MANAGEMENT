// src/screens/ReconciliationScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput,
} from 'react-native';
import { useStore } from '../store/useStore';
import { Card, CardHeader, Badge, WhoChip } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';

const MOCK_LINES = [
  { itemId: 'i1', itemName: 'Chicken breast', posQtySold: 36, recipeUsed: '0.5 lbs/plate', expectedDeduction: 18, openingStock: 40, eodRemaining: 22, eodBy: 'Maria G.', eodByColor: '#1D9E75', eodTime: '4:12 PM', expectedRemaining: 22, variance: 0, unit: 'lbs', result: 'match' as const },
  { itemId: 'i2', itemName: 'Ground beef', posQtySold: 16, recipeUsed: '0.75 lbs/burger', expectedDeduction: 12, openingStock: 30, eodRemaining: 14, eodBy: 'James T.', eodByColor: '#D85A30', eodTime: '4:31 PM', expectedRemaining: 18, variance: -4, unit: 'lbs', result: 'mismatch' as const },
  { itemId: 'i5', itemName: 'Romaine lettuce', posQtySold: 14, recipeUsed: '0.25 case/salad', expectedDeduction: 3.5, openingStock: 6, eodRemaining: 2, eodBy: 'Maria G.', eodByColor: '#1D9E75', eodTime: '4:14 PM', expectedRemaining: 2.5, variance: -0.5, unit: 'cases', result: 'review' as const },
  { itemId: 'i11', itemName: 'Pasta (penne)', posQtySold: 22, recipeUsed: '0.3 lbs/plate', expectedDeduction: 6.6, openingStock: 20, eodRemaining: 13.4, eodBy: 'Maria G.', eodByColor: '#1D9E75', eodTime: '4:13 PM', expectedRemaining: 13.4, variance: 0, unit: 'lbs', result: 'match' as const },
  { itemId: 'i3', itemName: 'Salmon fillet', posQtySold: 10, recipeUsed: 'Est. 0.4 lbs', expectedDeduction: 4, openingStock: 4, eodRemaining: 0, eodBy: 'James T.', eodByColor: '#D85A30', eodTime: '4:32 PM', expectedRemaining: 0, variance: 0, unit: 'lbs', result: 'match' as const },
];

export default function ReconciliationScreen() {
  const [adminNote, setAdminNote] = useState('');
  const [selectedDate, setSelectedDate] = useState('Jun 14, 2025');

  const matched = MOCK_LINES.filter((l) => l.result === 'match').length;
  const mismatched = MOCK_LINES.filter((l) => l.result === 'mismatch').length;
  const review = MOCK_LINES.filter((l) => l.result === 'review').length;

  const resultVariant = (r: string) =>
    r === 'match' ? 'match' : r === 'mismatch' ? 'mismatch' : 'review';

  const varianceColor = (v: number) => {
    if (v === 0) return Colors.success;
    if (Math.abs(v) < 1) return Colors.warning;
    return Colors.danger;
  };

  return (
    <WebScrollView id="recon-scroll" contentContainerStyle={styles.content}>
      {/* Summary bar */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryVal, { color: Colors.success }]}>{matched}</Text>
          <Text style={styles.summaryLabel}>Matched</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryVal, { color: Colors.danger }]}>{mismatched}</Text>
          <Text style={styles.summaryLabel}>Mismatch</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryVal, { color: Colors.warning }]}>{review}</Text>
          <Text style={styles.summaryLabel}>Review</Text>
        </View>
        <View style={styles.datePill}>
          <Text style={styles.dateText}>{selectedDate} · Towson</Text>
        </View>
      </View>

      {/* Line items */}
      {MOCK_LINES.map((line) => (
        <View key={line.itemId} style={[styles.lineCard, line.result === 'mismatch' && styles.lineCardMismatch]}>
          <View style={styles.lineTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.lineName}>{line.itemName}</Text>
              <Text style={styles.lineRecipe}>{line.recipeUsed}</Text>
            </View>
            <Badge label={line.result === 'match' ? 'Match' : line.result === 'mismatch' ? 'Mismatch' : 'Review'} variant={resultVariant(line.result) as any} />
          </View>

          <View style={styles.lineStats}>
            <View style={styles.lineStat}>
              <Text style={styles.lineStatLabel}>POS qty</Text>
              <Text style={styles.lineStatVal}>{line.posQtySold}</Text>
            </View>
            <View style={styles.lineStat}>
              <Text style={styles.lineStatLabel}>Expected deduction</Text>
              <Text style={styles.lineStatVal}>{line.expectedDeduction} {line.unit}</Text>
            </View>
            <View style={styles.lineStat}>
              <Text style={styles.lineStatLabel}>Opening stock</Text>
              <Text style={styles.lineStatVal}>{line.openingStock} {line.unit}</Text>
            </View>
            <View style={styles.lineStat}>
              <Text style={styles.lineStatLabel}>Expected rem.</Text>
              <Text style={styles.lineStatVal}>{line.expectedRemaining} {line.unit}</Text>
            </View>
          </View>

          <View style={styles.eodRow}>
            <View style={styles.eodLeft}>
              <Text style={styles.lineStatLabel}>EOD entered by</Text>
              <WhoChip name={line.eodBy} color={line.eodByColor} time={line.eodTime} />
            </View>
            <View style={styles.eodRight}>
              <Text style={styles.lineStatLabel}>EOD remaining</Text>
              <Text style={styles.lineStatVal}>{line.eodRemaining} {line.unit}</Text>
            </View>
            <View style={styles.eodRight}>
              <Text style={styles.lineStatLabel}>Variance</Text>
              <Text style={[styles.varianceVal, { color: varianceColor(line.variance) }]}>
                {line.variance === 0 ? '0' : `${line.variance > 0 ? '+' : ''}${line.variance} ${line.unit}`}
              </Text>
            </View>
          </View>
        </View>
      ))}

      {/* Mismatch analysis */}
      <Card>
        <CardHeader title="Mismatch analysis" />
        <View style={styles.misBox}>
          <Text style={styles.misTitle}>Ground beef — 4 lbs unaccounted</Text>
          <Text style={styles.misSub}>
            EOD count entered by <Text style={{ fontWeight: '600' }}>James T.</Text> at 4:31 PM.{'\n'}
            4 lbs × $6.20/lb = <Text style={{ color: Colors.danger, fontWeight: '600' }}>$24.80 unaccounted.</Text>{'\n\n'}
            Possible causes: waste not logged, over-portioning, spillage, or inventory theft. Check waste log and prep records.
          </Text>
        </View>
        <Text style={styles.noteLabel}>Admin notes</Text>
        <TextInput
          style={styles.noteInput}
          multiline
          placeholder="Add investigation notes..."
          placeholderTextColor={Colors.textTertiary}
          value={adminNote}
          onChangeText={setAdminNote}
        />
        <TouchableOpacity style={styles.saveNoteBtn}>
          <Text style={styles.saveNoteBtnText}>Save notes</Text>
        </TouchableOpacity>
      </Card>

      <View style={{ height: 32 }} />
    </WebScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
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
  saveNoteBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '500' },
});

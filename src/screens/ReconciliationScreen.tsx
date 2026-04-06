// src/screens/ReconciliationScreen.tsx
import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { Card, CardHeader, Badge, WhoChip, EmptyState } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';
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
  const [adminNote, setAdminNote] = useState('');

  // Available dates that have BOTH POS + EOD data for current store
  const availableDates = useMemo(() => {
    const posDates = new Set(
      posImports.filter((p) => p.storeId === currentStore.id).map((p) => p.date)
    );
    const eodDates = new Set(
      eodSubmissions.filter((e) => e.storeId === currentStore.id).map((e) => e.date)
    );
    return [...posDates].filter((d) => eodDates.has(d)).sort().reverse();
  }, [posImports, eodSubmissions, currentStore.id]);

  const [selectedDate, setSelectedDate] = useState(availableDates[0] || '');

  const dateIdx = availableDates.indexOf(selectedDate);
  const canPrev = dateIdx < availableDates.length - 1;
  const canNext = dateIdx > 0;

  const lines = useMemo(
    () => selectedDate
      ? buildReconciliationLines(selectedDate, currentStore.id, posImports, recipes, eodSubmissions, inventory)
      : [],
    [selectedDate, currentStore.id, posImports, recipes, eodSubmissions, inventory]
  );

  const matched = lines.filter((l) => l.result === 'match').length;
  const mismatched = lines.filter((l) => l.result === 'mismatch').length;
  const review = lines.filter((l) => l.result === 'review').length;
  const mismatchLines = lines.filter((l) => l.result === 'mismatch');

  const varianceColor = (v: number) => {
    if (v === 0) return Colors.success;
    if (Math.abs(v) < 1) return Colors.warning;
    return Colors.danger;
  };

  const formatDisplayDate = (iso: string) => {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (availableDates.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.bgTertiary, justifyContent: 'center' }}>
        <EmptyState message="No matching POS + EOD data available for reconciliation. Import POS sales and submit EOD counts for the same date." />
      </View>
    );
  }

  return (
    <WebScrollView id="recon-scroll" contentContainerStyle={styles.content}>
      {/* Date nav + Summary bar */}
      <View style={styles.summaryBar}>
        <TouchableOpacity
          disabled={!canPrev}
          onPress={() => setSelectedDate(availableDates[dateIdx + 1])}
          style={{ opacity: canPrev ? 1 : 0.3 }}
        >
          <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
        </TouchableOpacity>

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
          <Text style={styles.dateText}>{formatDisplayDate(selectedDate)} · {currentStore.name}</Text>
        </View>

        <TouchableOpacity
          disabled={!canNext}
          onPress={() => setSelectedDate(availableDates[dateIdx - 1])}
          style={{ opacity: canNext ? 1 : 0.3 }}
        >
          <Ionicons name="chevron-forward" size={20} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Line items */}
      {lines.length === 0 ? (
        <EmptyState message="No EOD entries found for this date." />
      ) : (
        lines.map((line) => (
          <View key={line.itemId} style={[styles.lineCard, line.result === 'mismatch' && styles.lineCardMismatch]}>
            <View style={styles.lineTop}>
              <View style={{ flex: 1 }}>
                <Text style={styles.lineName}>{line.itemName}</Text>
                <Text style={styles.lineRecipe}>{line.recipeUsed}</Text>
              </View>
              <Badge
                label={line.result === 'match' ? 'Match' : line.result === 'mismatch' ? 'Mismatch' : 'Review'}
                variant={line.result as any}
              />
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
                <WhoChip
                  name={line.eodBy}
                  color={USER_COLORS[line.eodBy] || Colors.userAdmin}
                  time={line.eodTime}
                />
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
              <View key={line.itemId} style={styles.misBox}>
                <Text style={styles.misTitle}>
                  {line.itemName} — {Math.abs(line.variance)} {line.unit} {line.variance < 0 ? 'unaccounted' : 'surplus'}
                </Text>
                <Text style={styles.misSub}>
                  EOD count entered by <Text style={{ fontWeight: '600' }}>{line.eodBy}</Text> at {line.eodTime}.{'\n'}
                  {Math.abs(line.variance)} {line.unit} × ${item?.costPerUnit.toFixed(2) || '?'}/{line.unit} = <Text style={{ color: Colors.danger, fontWeight: '600' }}>${cost.toFixed(2)} {line.variance < 0 ? 'unaccounted' : 'surplus'}</Text>{'\n\n'}
                  {line.variance < 0
                    ? 'Possible causes: waste not logged, over-portioning, spillage, or theft.'
                    : 'Possible causes: under-portioning, unrecorded delivery, or count error.'}
                </Text>
              </View>
            );
          })}
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
      )}

      <View style={{ height: 32 }} />
    </WebScrollView>
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
  saveNoteBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '500' },
});

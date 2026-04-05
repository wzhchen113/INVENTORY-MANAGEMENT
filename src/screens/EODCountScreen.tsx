// src/screens/EODCountScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TextInput,
  TouchableOpacity, Alert,
} from 'react-native';
import { useStore } from '../store/useSupabaseStore';
import { Card, CardHeader, Button } from '../components';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';
import { EODEntry } from '../types';

export default function EODCountScreen() {
  const { currentUser, currentStore, inventory, submitEOD } = useStore();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  const updateCount = (id: string, value: string) => {
    setCounts((prev) => ({ ...prev, [id]: value }));
  };

  const handleSubmit = () => {
    const entries: EODEntry[] = inventory
      .filter((item) => counts[item.id] !== undefined && counts[item.id] !== '')
      .map((item) => ({
        id: `eod-${item.id}-${Date.now()}`,
        itemId: item.id,
        itemName: item.name,
        actualRemaining: parseFloat(counts[item.id]) || 0,
        unit: item.unit,
        submittedBy: currentUser?.name || '',
        submittedByUserId: currentUser?.id || '',
        timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        date: today,
        storeId: currentStore.id,
        notes: notes[item.id] || '',
      }));

    if (entries.length === 0) {
      Alert.alert('No counts entered', 'Please enter at least one remaining quantity before submitting.');
      return;
    }

    submitEOD({
      date: today,
      storeId: currentStore.id,
      storeName: currentStore.name,
      submittedBy: currentUser?.name || '',
      submittedByUserId: currentUser?.id || '',
      timestamp: new Date().toLocaleTimeString(),
      itemCount: entries.length,
      status: 'submitted',
      entries,
    });

    setSubmitted(true);
  };

  if (submitted) {
    return (
      <View style={styles.doneContainer}>
        <View style={styles.doneCard}>
          <View style={styles.doneIcon}>
            <Text style={styles.doneIconText}>✓</Text>
          </View>
          <Text style={styles.doneTitle}>Count submitted</Text>
          <Text style={styles.doneSub}>
            Your end-of-day count has been recorded under{' '}
            <Text style={{ fontWeight: '600' }}>{currentUser?.name}</Text>{' '}
            and is ready for admin reconciliation.
          </Text>
          <TouchableOpacity style={styles.doneBtn} onPress={() => setSubmitted(false)}>
            <Text style={styles.doneBtnText}>Submit another count</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const categories = [...new Set(inventory.map((i) => i.category))].sort();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Attribution notice */}
      <View style={styles.notice}>
        <View style={styles.noticeAvatar}>
          <Text style={styles.noticeAvatarText}>{currentUser?.initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.noticeTitle}>Submitting as {currentUser?.name}</Text>
          <Text style={styles.noticeSub}>All entries are timestamped and visible to admins · {today}</Text>
        </View>
      </View>

      {categories.map((cat) => {
        const catItems = inventory.filter((i) => i.category === cat);
        return (
          <Card key={cat} style={{ marginBottom: Spacing.md }}>
            <CardHeader title={cat} />
            {catItems.map((item) => (
              <View key={item.id} style={styles.itemRow}>
                <View style={styles.itemInfo}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.itemUnit}>Expected: {item.currentStock} {item.unit}</Text>
                </View>
                <View style={styles.inputGroup}>
                  <TextInput
                    style={styles.countInput}
                    placeholder="0"
                    placeholderTextColor={Colors.textTertiary}
                    keyboardType="decimal-pad"
                    value={counts[item.id] || ''}
                    onChangeText={(v) => updateCount(item.id, v)}
                  />
                  <Text style={styles.unitLabel}>{item.unit}</Text>
                </View>
                <TextInput
                  style={styles.noteInput}
                  placeholder="Note..."
                  placeholderTextColor={Colors.textTertiary}
                  value={notes[item.id] || ''}
                  onChangeText={(v) => setNotes((prev) => ({ ...prev, [item.id]: v }))}
                />
              </View>
            ))}
          </Card>
        );
      })}

      <View style={styles.submitRow}>
        <TouchableOpacity style={styles.draftBtn}>
          <Text style={styles.draftBtnText}>Save draft</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit}>
          <Text style={styles.submitBtnText}>Submit count</Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  content: { padding: Spacing.lg },
  notice: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, backgroundColor: Colors.infoBg, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.lg },
  noticeAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.info + '33', alignItems: 'center', justifyContent: 'center' },
  noticeAvatarText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.info },
  noticeTitle: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.info },
  noticeSub: { fontSize: FontSize.xs, color: Colors.info, opacity: 0.75, marginTop: 2 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  itemInfo: { flex: 1.5 },
  itemName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  itemUnit: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  inputGroup: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  countInput: { width: 64, borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, paddingHorizontal: 8, paddingVertical: 5, fontSize: FontSize.sm, color: Colors.textPrimary, textAlign: 'center', backgroundColor: Colors.bgSecondary },
  unitLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, width: 36 },
  noteInput: { flex: 1, borderWidth: 0.5, borderColor: Colors.borderLight, borderRadius: Radius.md, paddingHorizontal: 8, paddingVertical: 5, fontSize: 10, color: Colors.textSecondary, backgroundColor: Colors.bgSecondary },
  submitRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  draftBtn: { flex: 1, borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center' },
  draftBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  submitBtn: { flex: 2, backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center' },
  submitBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '600' },
  doneContainer: { flex: 1, backgroundColor: Colors.bgTertiary, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  doneCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.xl, padding: Spacing.xxxl, alignItems: 'center', borderWidth: 0.5, borderColor: Colors.borderLight, width: '100%' },
  doneIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.successBg, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg },
  doneIconText: { fontSize: 24, color: Colors.success },
  doneTitle: { fontSize: FontSize.xl, fontWeight: '600', color: Colors.textPrimary, marginBottom: Spacing.sm },
  doneSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: Spacing.xl },
  doneBtn: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: 20, borderWidth: 0.5, borderColor: Colors.borderLight },
  doneBtnText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: '500' },
});

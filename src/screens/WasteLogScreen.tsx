// src/screens/WasteLogScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Modal, TextInput, FlatList, Alert,
} from 'react-native';
import { useStore } from '../store/useSupabaseStore';
import { Card, CardHeader, Badge, WhoChip } from '../components';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';
import { WasteReason } from '../types';

const REASONS: WasteReason[] = ['Expired', 'Dropped/spilled', 'Over-prepped', 'Quality issue', 'Theft', 'Other'];

export default function WasteLogScreen() {
  const { currentUser, inventory, wasteLog, logWaste } = useStore();
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ itemId: '', qty: '', reason: 'Expired' as WasteReason, notes: '' });
  const [reasonFilter, setReasonFilter] = useState('');

  const totalValue = wasteLog.reduce((s, e) => s + e.quantity * e.costPerUnit, 0);
  const filtered = wasteLog.filter((e) => !reasonFilter || e.reason === reasonFilter);

  const userColors: Record<string, string> = {
    'Maria G.': Colors.userMaria, 'James T.': Colors.userJames,
    'Admin': Colors.userAdmin, 'Ana R.': Colors.userAna,
  };

  const handleLog = () => {
    const item = inventory.find((i) => i.id === form.itemId);
    if (!item) { Alert.alert('Error', 'Please select an item'); return; }
    const qty = parseFloat(form.qty);
    if (!qty || qty <= 0) { Alert.alert('Error', 'Enter a valid quantity'); return; }

    logWaste({
      itemId: item.id, itemName: item.name, quantity: qty, unit: item.unit,
      costPerUnit: item.costPerUnit, reason: form.reason,
      loggedBy: currentUser?.name || '', loggedByUserId: currentUser?.id || '',
      timestamp: `Today · ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
      notes: form.notes, storeId: 's1',
    });
    setShowModal(false);
    setForm({ itemId: '', qty: '', reason: 'Expired', notes: '' });
  };

  const reasonBadgeVariant = (r: WasteReason) =>
    r === 'Expired' ? 'expired' : r === 'Theft' ? 'mismatch' : 'low';

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bgTertiary }}>
      {/* Summary bar */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>${totalValue.toFixed(2)}</Text>
          <Text style={styles.summaryLabel}>Total waste value</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>{wasteLog.length}</Text>
          <Text style={styles.summaryLabel}>Entries</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>1.6%</Text>
          <Text style={styles.summaryLabel}>% of revenue</Text>
        </View>
        <TouchableOpacity style={styles.logBtn} onPress={() => setShowModal(true)}>
          <Text style={styles.logBtnText}>+ Log waste</Text>
        </TouchableOpacity>
      </View>

      {/* Reason filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll}>
        {['', ...REASONS].map((r) => (
          <TouchableOpacity
            key={r || 'all'}
            style={[styles.filterChip, reasonFilter === r && styles.filterChipActive]}
            onPress={() => setReasonFilter(r)}
          >
            <Text style={[styles.filterText, reasonFilter === r && styles.filterTextActive]}>
              {r || 'All reasons'}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={filtered}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{ padding: Spacing.lg }}
        renderItem={({ item: entry }) => {
          const color = userColors[entry.loggedBy] || Colors.userAdmin;
          const cost = (entry.quantity * entry.costPerUnit).toFixed(2);
          return (
            <View style={styles.entryCard}>
              <View style={styles.entryTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.entryName}>{entry.itemName}</Text>
                  <Text style={styles.entryQty}>{entry.quantity} {entry.unit} · ${cost}</Text>
                </View>
                <Badge label={entry.reason} variant={reasonBadgeVariant(entry.reason) as any} />
              </View>
              {entry.notes ? <Text style={styles.entryNotes}>{entry.notes}</Text> : null}
              <View style={styles.entryFooter}>
                <WhoChip name={entry.loggedBy} color={color} />
                <Text style={styles.entryTime}>{entry.timestamp}</Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No waste entries yet</Text>}
      />

      {/* Log waste modal */}
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Log waste / spoilage</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}>
              <Text style={styles.modalClose}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            {/* Item picker */}
            <Text style={styles.formLabel}>Item *</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: Spacing.md }}>
              {inventory.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.itemChip, form.itemId === item.id && styles.itemChipActive]}
                  onPress={() => setForm((p) => ({ ...p, itemId: item.id }))}
                >
                  <Text style={[styles.itemChipText, form.itemId === item.id && { color: Colors.white }]}>{item.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={styles.formLabel}>Quantity</Text>
            <TextInput
              style={styles.formInput}
              keyboardType="decimal-pad"
              placeholder="e.g. 1.5"
              placeholderTextColor={Colors.textTertiary}
              value={form.qty}
              onChangeText={(v) => setForm((p) => ({ ...p, qty: v }))}
            />

            <Text style={styles.formLabel}>Reason</Text>
            <View style={styles.reasonGrid}>
              {REASONS.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.reasonBtn, form.reason === r && styles.reasonBtnActive]}
                  onPress={() => setForm((p) => ({ ...p, reason: r }))}
                >
                  <Text style={[styles.reasonText, form.reason === r && styles.reasonTextActive]}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.formLabel}>Notes (optional)</Text>
            <TextInput
              style={[styles.formInput, { height: 72, textAlignVertical: 'top' }]}
              multiline
              placeholder="What happened?"
              placeholderTextColor={Colors.textTertiary}
              value={form.notes}
              onChangeText={(v) => setForm((p) => ({ ...p, notes: v }))}
            />

            <View style={styles.submitterRow}>
              <View style={[styles.submitterAvatar, { backgroundColor: currentUser?.color + '22' }]}>
                <Text style={[styles.submitterInitials, { color: currentUser?.color }]}>{currentUser?.initials}</Text>
              </View>
              <Text style={styles.submitterText}>Will be logged as <Text style={{ fontWeight: '600' }}>{currentUser?.name}</Text></Text>
            </View>

            <TouchableOpacity style={styles.saveBtn} onPress={handleLog}>
              <Text style={styles.saveBtnText}>Log waste entry</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.bgPrimary, padding: Spacing.md, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight, gap: Spacing.md },
  summaryItem: { alignItems: 'center', flex: 1 },
  summaryValue: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.warning },
  summaryLabel: { fontSize: 9, color: Colors.textTertiary, marginTop: 2 },
  logBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, paddingVertical: 7, paddingHorizontal: 14 },
  logBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '500' },
  filterScroll: { backgroundColor: Colors.bgPrimary, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  filterChip: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 5, marginRight: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  filterChipActive: { backgroundColor: Colors.textPrimary },
  filterText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  filterTextActive: { color: Colors.white, fontWeight: '500' },
  entryCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  entryTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  entryName: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  entryQty: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  entryNotes: { fontSize: FontSize.xs, color: Colors.textSecondary, fontStyle: 'italic', marginBottom: 6 },
  entryFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  entryTime: { fontSize: FontSize.xs, color: Colors.textTertiary },
  empty: { textAlign: 'center', color: Colors.textTertiary, padding: Spacing.xxxl },
  modal: { flex: 1, backgroundColor: Colors.bgPrimary },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600' },
  modalClose: { color: Colors.info, fontSize: FontSize.base },
  modalBody: { padding: Spacing.lg },
  formLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 5, marginTop: Spacing.sm },
  formInput: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  itemChip: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, paddingHorizontal: 10, paddingVertical: 6, marginRight: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  itemChipActive: { backgroundColor: Colors.textPrimary },
  itemChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  reasonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: Spacing.md },
  reasonBtn: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: Colors.bgSecondary },
  reasonBtnActive: { backgroundColor: Colors.textPrimary, borderColor: Colors.textPrimary },
  reasonText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  reasonTextActive: { color: Colors.white, fontWeight: '500' },
  submitterRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.infoBg, borderRadius: Radius.md, padding: Spacing.md, marginVertical: Spacing.md },
  submitterAvatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  submitterInitials: { fontSize: 10, fontWeight: '600' },
  submitterText: { fontSize: FontSize.xs, color: Colors.info, flex: 1 },
  saveBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center' },
  saveBtnText: { color: Colors.white, fontSize: FontSize.base, fontWeight: '600' },
});

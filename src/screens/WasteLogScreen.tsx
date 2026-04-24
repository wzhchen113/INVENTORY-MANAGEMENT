// src/screens/WasteLogScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Modal, TextInput, FlatList, Alert,
} from 'react-native';
import { useStore } from '../store/useStore';
import { numericFilter } from '../utils';
import { Card, CardHeader, Badge, WhoChip } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import DatePicker from '../components/DatePicker';
import { TimezoneBar } from '../components/TimezoneBar';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { WasteReason } from '../types';

const REASONS: WasteReason[] = ['Expired', 'Dropped/spilled', 'Over-prepped', 'Quality issue', 'Theft', 'Other'];

export default function WasteLogScreen() {
  const { currentUser, currentStore, inventory, wasteLog, logWaste } = useStore();
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ itemId: '', qty: '', reason: 'Expired' as WasteReason, notes: '' });
  const [reasonFilter, setReasonFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const C = useColors();

  const storeInventory = inventory.filter((i) => i.storeId === currentStore.id);
  const storeWaste = wasteLog.filter((w) => w.storeId === currentStore.id);
  const totalValue = storeWaste.reduce((s, e) => s + e.quantity * e.costPerUnit, 0);
  const filtered = storeWaste.filter((e) => {
    if (reasonFilter && e.reason !== reasonFilter) return false;
    if (dateFilter && !e.timestamp.startsWith(dateFilter)) return false;
    return true;
  });

  const userColors: Record<string, string> = {
    'Maria G.': C.userMaria, 'James T.': C.userJames,
    'Admin': C.userAdmin, 'Ana R.': C.userAna,
  };

  const handleLog = () => {
    const item = storeInventory.find((i) => i.id === form.itemId);
    if (!item) { Alert.alert('Error', 'Please select an item'); return; }
    const qty = parseFloat(form.qty);
    if (!qty || qty <= 0) { Alert.alert('Error', 'Enter a valid quantity'); return; }

    logWaste({
      itemId: item.id, itemName: item.name, quantity: qty, unit: item.unit,
      costPerUnit: item.costPerUnit, reason: form.reason,
      loggedBy: currentUser?.name || '', loggedByUserId: currentUser?.id || '',
      timestamp: `Today · ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
      notes: form.notes, storeId: currentStore.id,
    });
    setShowModal(false);
    setForm({ itemId: '', qty: '', reason: 'Expired', notes: '' });
  };

  const reasonBadgeVariant = (r: WasteReason) =>
    r === 'Expired' ? 'expired' : r === 'Theft' ? 'mismatch' : 'low';

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <TimezoneBar />
      {/* Summary bar */}
      <View style={[styles.summaryBar, { backgroundColor: C.bgPrimary, borderBottomColor: C.borderLight }]}>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryValue, { color: C.warning }]}>${totalValue.toFixed(2)}</Text>
          <Text style={[styles.summaryLabel, { color: C.textTertiary }]}>Total waste value</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryValue, { color: C.warning }]}>{wasteLog.length}</Text>
          <Text style={[styles.summaryLabel, { color: C.textTertiary }]}>Entries</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryValue, { color: C.warning }]}>1.6%</Text>
          <Text style={[styles.summaryLabel, { color: C.textTertiary }]}>% of revenue</Text>
        </View>
        <TouchableOpacity style={[styles.logBtn, { backgroundColor: C.textPrimary }]} onPress={() => setShowModal(true)}>
          <Text style={[styles.logBtnText, { color: C.bgPrimary }]}>+ Log waste</Text>
        </TouchableOpacity>
      </View>

      {/* Date filter */}
      <View style={{ paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm }}>
        <DatePicker value={dateFilter} onChange={setDateFilter} label="Filter by date" placeholder="All dates" />
      </View>

      {/* Reason filter */}
      <View style={[styles.filterWrapper, { backgroundColor: C.bgPrimary, borderBottomColor: C.borderLight }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          {['', ...REASONS].map((r) => (
            <TouchableOpacity
              key={r || 'all'}
              style={[styles.filterChip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, reasonFilter === r && [styles.filterChipActive, { backgroundColor: C.textPrimary }]]}
              onPress={() => setReasonFilter(r)}
            >
              <Text style={[styles.filterText, { color: C.textSecondary }, reasonFilter === r && { color: C.bgPrimary, fontWeight: '500' }]}>
                {r || 'All reasons'}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <WebScrollView id="waste-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        {filtered.length === 0 ? (
          <Text style={[styles.empty, { color: C.textTertiary }]}>No waste entries yet</Text>
        ) : (
          filtered.map((entry) => {
            const color = userColors[entry.loggedBy] || C.userAdmin;
            const cost = (entry.quantity * entry.costPerUnit).toFixed(2);
            return (
              <View key={entry.id} style={[styles.entryCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
                <View style={styles.entryTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.entryName, { color: C.textPrimary }]}>{entry.itemName}</Text>
                    <Text style={[styles.entryQty, { color: C.textSecondary }]}>{entry.quantity} {entry.unit} · ${cost}</Text>
                  </View>
                  <Badge label={entry.reason} variant={reasonBadgeVariant(entry.reason) as any} />
                </View>
                {entry.notes ? <Text style={[styles.entryNotes, { color: C.textSecondary }]}>{entry.notes}</Text> : null}
                <View style={styles.entryFooter}>
                  <WhoChip name={entry.loggedBy} color={color} />
                  <Text style={[styles.entryTime, { color: C.textTertiary }]}>{entry.timestamp}</Text>
                </View>
              </View>
            );
          })
        )}
      </WebScrollView>

      {/* Log waste modal */}
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Log waste / spoilage</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}>
              <Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            {/* Item picker */}
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Item *</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: Spacing.md }}>
              {storeInventory.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.itemChip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, form.itemId === item.id && [styles.itemChipActive, { backgroundColor: C.textPrimary }]]}
                  onPress={() => setForm((p) => ({ ...p, itemId: item.id }))}
                >
                  <Text style={[styles.itemChipText, { color: C.textSecondary }, form.itemId === item.id && { color: C.bgPrimary }]}>{item.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Quantity</Text>
            <TextInput
              style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
              keyboardType="decimal-pad"
              placeholder="e.g. 1.5"
              placeholderTextColor={C.textTertiary}
              value={form.qty}
              onChangeText={(v) => setForm((p) => ({ ...p, qty: numericFilter(v) }))}
            />

            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Reason</Text>
            <View style={styles.reasonGrid}>
              {REASONS.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.reasonBtn, { backgroundColor: C.bgSecondary, borderColor: C.borderMedium }, form.reason === r && [styles.reasonBtnActive, { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]]}
                  onPress={() => setForm((p) => ({ ...p, reason: r }))}
                >
                  <Text style={[styles.reasonText, { color: C.textSecondary }, form.reason === r && { color: C.bgPrimary, fontWeight: '500' }]}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Notes (optional)</Text>
            <TextInput
              style={[styles.formInput, { height: 72, textAlignVertical: 'top', color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
              multiline
              placeholder="What happened?"
              placeholderTextColor={C.textTertiary}
              value={form.notes}
              onChangeText={(v) => setForm((p) => ({ ...p, notes: v }))}
            />

            <View style={[styles.submitterRow, { backgroundColor: C.infoBg }]}>
              <View style={[styles.submitterAvatar, { backgroundColor: currentUser?.color + '22' }]}>
                <Text style={[styles.submitterInitials, { color: currentUser?.color }]}>{currentUser?.initials}</Text>
              </View>
              <Text style={[styles.submitterText, { color: C.info }]}>Will be logged as <Text style={{ fontWeight: '600' }}>{currentUser?.name}</Text></Text>
            </View>

            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleLog}>
              <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>Log waste entry</Text>
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
  logBtnText: { color: Colors.bgPrimary, fontSize: FontSize.sm, fontWeight: '500' },
  filterWrapper: { backgroundColor: Colors.bgPrimary, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  filterRow: { flexDirection: 'row', alignItems: 'center' },
  filterChip: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 5, marginRight: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  filterChipActive: { backgroundColor: Colors.textPrimary },
  filterText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  filterTextActive: { color: Colors.bgPrimary, fontWeight: '500' },
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
  reasonTextActive: { color: Colors.bgPrimary, fontWeight: '500' },
  submitterRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.infoBg, borderRadius: Radius.md, padding: Spacing.md, marginVertical: Spacing.md },
  submitterAvatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  submitterInitials: { fontSize: 10, fontWeight: '600' },
  submitterText: { fontSize: FontSize.xs, color: Colors.info, flex: 1 },
  saveBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center' },
  saveBtnText: { color: Colors.bgPrimary, fontSize: FontSize.base, fontWeight: '600' },
});

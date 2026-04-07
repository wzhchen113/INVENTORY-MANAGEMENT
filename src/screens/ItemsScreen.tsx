// src/screens/ItemsScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TextInput,
  TouchableOpacity, Modal, Alert, FlatList, Platform,
} from 'react-native';
import { useStore } from '../store/useStore';
import { Card, Badge, WhoChip, ProgressBar, Button, StatusBadge } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { InventoryItem } from '../types';

const CATEGORIES = ['Protein', 'Seafood', 'Produce', 'Dairy', 'Dry goods', 'Bakery', 'Condiments', 'Drinks', 'Desserts'];

export default function ItemsScreen() {
  const { currentUser, currentStore, inventory, getItemStatus, addItem, updateItem } = useStore();
  const C = useColors();
  const isAdmin = currentUser?.role === 'admin';

  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);

  // Form state
  const [form, setForm] = useState({
    name: '', category: 'Protein', unit: 'lbs', costPerUnit: '',
    currentStock: '', parLevel: '', vendorName: 'Sysco', usagePerPortion: '',
  });

  const storeInventory = inventory.filter((i) => i.storeId === currentStore.id);

  const filtered = storeInventory.filter((item) => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (catFilter && item.category !== catFilter) return false;
    return true;
  });

  const userColors: Record<string, string> = {
    'Maria G.': C.userMaria, 'James T.': C.userJames,
    'Admin': C.userAdmin, 'Ana R.': C.userAna,
  };

  const openAdd = () => {
    setEditItem(null);
    setForm({ name: '', category: 'Protein', unit: 'lbs', costPerUnit: '', currentStock: '', parLevel: '', vendorName: 'Sysco', usagePerPortion: '' });
    setShowModal(true);
  };

  const openEdit = (item: InventoryItem) => {
    setEditItem(item);
    setForm({
      name: item.name, category: item.category, unit: item.unit,
      costPerUnit: String(item.costPerUnit), currentStock: String(item.currentStock),
      parLevel: String(item.parLevel), vendorName: item.vendorName,
      usagePerPortion: String(item.usagePerPortion),
    });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!form.name.trim()) { Alert.alert('Error', 'Item name is required'); return; }

    const doSave = () => {
      const data = {
        name: form.name.trim(), category: form.category, unit: form.unit,
        costPerUnit: parseFloat(form.costPerUnit) || 0,
        currentStock: parseFloat(form.currentStock) || 0,
        parLevel: parseFloat(form.parLevel) || 0,
        vendorId: 'v1', vendorName: form.vendorName,
        usagePerPortion: parseFloat(form.usagePerPortion) || 0,
        lastUpdatedBy: currentUser?.name || 'Admin',
        lastUpdatedAt: new Date().toLocaleTimeString(),
        eodRemaining: parseFloat(form.currentStock) || 0,
        averageDailyUsage: 0, safetyStock: 0,
        storeId: 's1', expiryDate: '',
      };
      if (editItem) {
        updateItem(editItem.id, data);
      } else {
        addItem(data);
      }
      setShowModal(false);
    };

    const trimmedName = form.name.trim().toLowerCase();
    const duplicate = storeInventory.some(
      (i) => i.name.toLowerCase() === trimmedName && (!editItem || i.id !== editItem.id)
    );

    if (duplicate) {
      const msg = `An item named "${form.name.trim()}" already exists. Save anyway?`;
      if (Platform.OS === 'web') {
        if (confirm(msg)) doSave();
      } else {
        Alert.alert('Duplicate Name', msg, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save Anyway', onPress: doSave },
        ]);
      }
    } else {
      doSave();
    }
  };

  const renderItem = ({ item }: { item: InventoryItem }) => {
    const status = getItemStatus(item);
    const pct = item.parLevel > 0 ? Math.min(100, (item.currentStock / item.parLevel) * 100) : 100;
    const color = userColors[item.lastUpdatedBy] || C.userAdmin;
    const stockValue = (item.currentStock * item.costPerUnit).toFixed(2);

    return (
      <View style={[styles.itemCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
        <View style={styles.itemTop}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.itemName, { color: C.textPrimary }]}>{item.name}</Text>
            <Text style={[styles.itemCat, { color: C.textSecondary }]}>{item.category} · {item.vendorName}</Text>
          </View>
          <StatusBadge status={status} />
        </View>

        <ProgressBar value={pct} status={status} />

        <View style={styles.itemStats}>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: C.textTertiary }]}>Stock</Text>
            <Text style={[styles.statValue, { color: C.textPrimary }]}>{item.currentStock} {item.unit}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: C.textTertiary }]}>Par</Text>
            <Text style={[styles.statValue, { color: C.textPrimary }]}>{item.parLevel} {item.unit}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: C.textTertiary }]}>Cost/unit</Text>
            <Text style={[styles.statValue, { color: C.textPrimary }]}>${item.costPerUnit.toFixed(2)}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: C.textTertiary }]}>Value</Text>
            <Text style={[styles.statValue, { color: C.textPrimary }]}>${stockValue}</Text>
          </View>
        </View>

        {item.expiryDate ? (
          <Badge label={`Expires ${item.expiryDate}`} variant="expired" />
        ) : null}

        <View style={[styles.itemFooter, { borderTopColor: C.borderLight }]}>
          <WhoChip name={item.lastUpdatedBy} color={color} time={item.lastUpdatedAt} />
          {isAdmin && (
            <TouchableOpacity style={[styles.editBtn, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => openEdit(item)}>
              <Text style={[styles.editBtnText, { color: C.textPrimary }]}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: C.bgTertiary }]}>
      {/* Search bar */}
      <View style={styles.searchRow}>
        <TextInput
          style={[styles.search, { backgroundColor: C.bgPrimary, borderColor: C.borderLight, color: C.textPrimary }]}
          placeholder="Search items..."
          placeholderTextColor={C.textTertiary}
          value={search}
          onChangeText={setSearch}
        />
        {isAdmin && (
          <TouchableOpacity style={[styles.addBtn, { backgroundColor: C.textPrimary }]} onPress={openAdd}>
            <Text style={[styles.addBtnText, { color: C.white }]}>+ Add item</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Category filter */}
      <View style={styles.catWrapper}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.catRow}>
          {['', ...CATEGORIES].map((cat) => (
            <TouchableOpacity
              key={cat || 'all'}
              style={[styles.catChip, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, catFilter === cat && [styles.catChipActive, { backgroundColor: C.textPrimary }]]}
              onPress={() => setCatFilter(cat)}
            >
              <Text style={[styles.catChipText, { color: C.textSecondary }, catFilter === cat && [styles.catChipTextActive, { color: C.white }]]}>
                {cat || 'All'}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <WebScrollView id="items-scroll" contentContainerStyle={styles.list}>
        {filtered.length === 0 ? (
          <Text style={[styles.empty, { color: C.textTertiary }]}>No items found</Text>
        ) : (
          filtered.map((item) => (
            <View key={item.id}>{renderItem({ item })}</View>
          ))
        )}
      </WebScrollView>

      {/* Add/Edit Modal */}
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>{editItem ? 'Edit item' : 'Add item'}</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}>
              <Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            {[
              { label: 'Item name *', key: 'name', placeholder: 'e.g. Chicken breast' },
              { label: 'Unit', key: 'unit', placeholder: 'lbs, oz, cases, each' },
              { label: 'Cost per unit ($)', key: 'costPerUnit', placeholder: '0.00', keyboard: 'decimal-pad' },
              { label: 'Current stock', key: 'currentStock', placeholder: '0', keyboard: 'decimal-pad' },
              { label: 'Par level (min)', key: 'parLevel', placeholder: '0', keyboard: 'decimal-pad' },
              { label: 'Usage per portion sold', key: 'usagePerPortion', placeholder: '0.5', keyboard: 'decimal-pad' },
            ].map((f) => (
              <View key={f.key} style={styles.formField}>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>{f.label}</Text>
                <TextInput
                  style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                  value={(form as any)[f.key]}
                  onChangeText={(v) => setForm((prev) => ({ ...prev, [f.key]: v }))}
                  placeholder={f.placeholder}
                  placeholderTextColor={C.textTertiary}
                  keyboardType={(f.keyboard as any) || 'default'}
                />
              </View>
            ))}

            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {CATEGORIES.map((cat) => (
                  <TouchableOpacity
                    key={cat}
                    style={[styles.catChip, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, form.category === cat && [styles.catChipActive, { backgroundColor: C.textPrimary }], { marginRight: 6 }]}
                    onPress={() => setForm((p) => ({ ...p, category: cat }))}
                  >
                    <Text style={[styles.catChipText, { color: C.textSecondary }, form.category === cat && [styles.catChipTextActive, { color: C.white }]]}>{cat}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleSave}>
              <Text style={[styles.saveBtnText, { color: C.white }]}>Save item</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  searchRow: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.lg, paddingBottom: 0 },
  search: { flex: 1, backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 8, fontSize: FontSize.base, borderWidth: 0.5, borderColor: Colors.borderLight, color: Colors.textPrimary },
  addBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center' },
  addBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '500' },
  catWrapper: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
  catRow: { flexDirection: 'row', alignItems: 'center' },
  catChip: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 5, marginRight: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  catChipActive: { backgroundColor: Colors.textPrimary },
  catChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  catChipTextActive: { color: Colors.white, fontWeight: '500' },
  list: { padding: Spacing.lg, paddingTop: Spacing.sm },
  itemCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  itemTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  itemName: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  itemCat: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  itemStats: { flexDirection: 'row', marginTop: Spacing.sm, gap: 0 },
  stat: { flex: 1, alignItems: 'center' },
  statLabel: { fontSize: 9, color: Colors.textTertiary },
  statValue: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  itemFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 0.5, borderTopColor: Colors.borderLight },
  editBtn: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.sm, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 0.5, borderColor: Colors.borderLight },
  editBtnText: { fontSize: FontSize.xs, color: Colors.textPrimary },
  empty: { textAlign: 'center', color: Colors.textTertiary, padding: Spacing.xxxl },
  modal: { flex: 1, backgroundColor: Colors.bgPrimary },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary },
  modalClose: { fontSize: FontSize.base, color: Colors.info },
  modalBody: { padding: Spacing.lg },
  formField: { marginBottom: Spacing.md },
  formLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 5 },
  formInput: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  saveBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.md },
  saveBtnText: { color: Colors.white, fontSize: FontSize.base, fontWeight: '600' },
});

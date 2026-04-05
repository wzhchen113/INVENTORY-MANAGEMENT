// src/screens/ItemsScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TextInput,
  TouchableOpacity, Modal, Alert, FlatList,
} from 'react-native';
import { useStore } from '../store/useStore';
import { Card, Badge, WhoChip, ProgressBar, Button, StatusBadge } from '../components';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';
import { InventoryItem } from '../types';

const CATEGORIES = ['Protein', 'Produce', 'Dairy', 'Dry goods', 'Seafood', 'Bakery', 'Spices'];

export default function ItemsScreen() {
  const { currentUser, inventory, getItemStatus, addItem, updateItem } = useStore();
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

  const filtered = inventory.filter((item) => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (catFilter && item.category !== catFilter) return false;
    return true;
  });

  const userColors: Record<string, string> = {
    'Maria G.': Colors.userMaria, 'James T.': Colors.userJames,
    'Admin': Colors.userAdmin, 'Ana R.': Colors.userAna,
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
      storeId: 's1', expiryDate: '',
    };
    if (editItem) {
      updateItem(editItem.id, data);
    } else {
      addItem(data);
    }
    setShowModal(false);
  };

  const renderItem = ({ item }: { item: InventoryItem }) => {
    const status = getItemStatus(item);
    const pct = item.parLevel > 0 ? Math.min(100, (item.currentStock / item.parLevel) * 100) : 100;
    const color = userColors[item.lastUpdatedBy] || Colors.userAdmin;
    const stockValue = (item.currentStock * item.costPerUnit).toFixed(2);

    return (
      <View style={styles.itemCard}>
        <View style={styles.itemTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.itemName}>{item.name}</Text>
            <Text style={styles.itemCat}>{item.category} · {item.vendorName}</Text>
          </View>
          <StatusBadge status={status} />
        </View>

        <ProgressBar value={pct} status={status} />

        <View style={styles.itemStats}>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Stock</Text>
            <Text style={styles.statValue}>{item.currentStock} {item.unit}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Par</Text>
            <Text style={styles.statValue}>{item.parLevel} {item.unit}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Cost/unit</Text>
            <Text style={styles.statValue}>${item.costPerUnit.toFixed(2)}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Value</Text>
            <Text style={styles.statValue}>${stockValue}</Text>
          </View>
        </View>

        {item.expiryDate ? (
          <Badge label={`Expires ${item.expiryDate}`} variant="expired" />
        ) : null}

        <View style={styles.itemFooter}>
          <WhoChip name={item.lastUpdatedBy} color={color} time={item.lastUpdatedAt} />
          {isAdmin && (
            <TouchableOpacity style={styles.editBtn} onPress={() => openEdit(item)}>
              <Text style={styles.editBtnText}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Search bar */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.search}
          placeholder="Search items..."
          placeholderTextColor={Colors.textTertiary}
          value={search}
          onChangeText={setSearch}
        />
        {isAdmin && (
          <TouchableOpacity style={styles.addBtn} onPress={openAdd}>
            <Text style={styles.addBtnText}>+ Add item</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Category filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll}>
        {['', ...CATEGORIES].map((cat) => (
          <TouchableOpacity
            key={cat || 'all'}
            style={[styles.catChip, catFilter === cat && styles.catChipActive]}
            onPress={() => setCatFilter(cat)}
          >
            <Text style={[styles.catChipText, catFilter === cat && styles.catChipTextActive]}>
              {cat || 'All'}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>No items found</Text>}
      />

      {/* Add/Edit Modal */}
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{editItem ? 'Edit item' : 'Add item'}</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}>
              <Text style={styles.modalClose}>Cancel</Text>
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
                <Text style={styles.formLabel}>{f.label}</Text>
                <TextInput
                  style={styles.formInput}
                  value={(form as any)[f.key]}
                  onChangeText={(v) => setForm((prev) => ({ ...prev, [f.key]: v }))}
                  placeholder={f.placeholder}
                  placeholderTextColor={Colors.textTertiary}
                  keyboardType={(f.keyboard as any) || 'default'}
                />
              </View>
            ))}

            <View style={styles.formField}>
              <Text style={styles.formLabel}>Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {CATEGORIES.map((cat) => (
                  <TouchableOpacity
                    key={cat}
                    style={[styles.catChip, form.category === cat && styles.catChipActive, { marginRight: 6 }]}
                    onPress={() => setForm((p) => ({ ...p, category: cat }))}
                  >
                    <Text style={[styles.catChipText, form.category === cat && styles.catChipTextActive]}>{cat}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
              <Text style={styles.saveBtnText}>Save item</Text>
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
  catScroll: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
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

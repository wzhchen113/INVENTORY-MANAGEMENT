// src/screens/ItemsScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TextInput,
  TouchableOpacity, Modal, Alert, Platform,
} from 'react-native';
import { useStore } from '../store/useStore';
import { numericFilter } from '../utils';
import { Badge, WhoChip, ProgressBar, StatusBadge } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { TimezoneBar } from '../components/TimezoneBar';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { InventoryItem } from '../types';

type StatusFilter = '' | 'low' | 'out';

export default function ItemsScreen() {
  // This screen is the stock-status / quick-adjustment view. Item creation
  // and editing live on IngredientsScreen, which has the canonical Add/Edit
  // form (categories, vendor, par level, cost, units, usage per portion).
  // Both screens read the same `inventory` slice, so anything added there
  // shows up here automatically.
  const {
    currentUser, currentStore, inventory, getItemStatus,
    adjustStock, addAuditEvent, ingredientCategories,
  } = useStore();
  const C = useColors();

  // Categories come from the same store-managed list as IngredientsScreen so
  // the chips here stay in sync with whatever admins added via Manage
  // categories. Falls back to a reasonable default before the store hydrates
  // from Supabase.
  const CATEGORIES = ingredientCategories.length > 0
    ? ingredientCategories
    : ['Protein', 'Seafood', 'Dry goods', 'Condiments', 'Drinks', 'Desserts'];

  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');

  // Adjust-stock modal: per-item one-off correction (delivery received,
  // found a case in the back, breakage). Goes through `adjustStock` so
  // it persists to Supabase, and writes a 'Stock adjusted' audit event.
  // This is the only mutation this screen offers.
  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);
  const [adjustValue, setAdjustValue] = useState('');
  const [adjustReason, setAdjustReason] = useState('');

  const storeInventory = inventory.filter((i) => i.storeId === currentStore.id);

  // Chip counts: derived from the full store inventory, NOT the post-filter
  // list. The chips are a navigation tool — "Protein (8)" should mean "8
  // proteins exist", not "8 proteins matching your current search". Mirrors
  // the IngredientsScreen pattern.
  const allCount = storeInventory.length;
  const lowCount = storeInventory.filter((i) => getItemStatus(i) === 'low').length;
  const outCount = storeInventory.filter((i) => getItemStatus(i) === 'out').length;
  const categoryCounts: Record<string, number> = {};
  storeInventory.forEach((i) => {
    categoryCounts[i.category] = (categoryCounts[i.category] || 0) + 1;
  });

  const filtered = storeInventory.filter((item) => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (catFilter && item.category !== catFilter) return false;
    if (statusFilter) {
      const s = getItemStatus(item);
      if (statusFilter === 'out' && s !== 'out') return false;
      if (statusFilter === 'low' && s !== 'low') return false;
    }
    return true;
  });

  // Sort: digit-prefixed names first (Unicode order puts digits before
  // letters), then A→Z. `numeric: true` gives natural ordering within the
  // digit group ("1/8" < "2/8" < "10/8"). `sensitivity: 'base'` makes the
  // alphabetical run case-insensitive.
  const sorted = [...filtered].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );

  const userColors: Record<string, string> = {
    'Maria G.': C.userMaria, 'James T.': C.userJames,
    'Admin': C.userAdmin, 'Ana R.': C.userAna,
  };

  const openAdjust = (item: InventoryItem) => {
    setAdjustItem(item);
    setAdjustValue(String(item.currentStock));
    setAdjustReason('');
  };

  const handleAdjustSave = () => {
    if (!adjustItem) return;
    const newStock = parseFloat(adjustValue);
    if (Number.isNaN(newStock) || newStock < 0) {
      if (Platform.OS === 'web') alert('Enter a valid stock number');
      else Alert.alert('Error', 'Enter a valid stock number');
      return;
    }
    const oldStock = adjustItem.currentStock;
    if (newStock === oldStock) {
      // No change — close without writing an audit row.
      setAdjustItem(null);
      return;
    }
    adjustStock(adjustItem.id, newStock, currentUser?.name || 'Unknown');
    addAuditEvent({
      timestamp: new Date().toISOString(),
      userId: currentUser?.id || '',
      userName: currentUser?.name || 'Unknown',
      userRole: currentUser?.role || 'user',
      storeId: currentStore.id,
      storeName: currentStore.name,
      action: 'Stock adjusted',
      detail: adjustReason.trim() || 'Manual adjustment',
      itemRef: adjustItem.name,
      value: `${oldStock} → ${newStock} ${adjustItem.unit}`,
    });
    setAdjustItem(null);
  };

  // Status chips: a second tap on the active chip clears it. Sit between
  // 'All' and the category list so triage filters are reachable without
  // scrolling past the categories.
  const statusChips: { key: Exclude<StatusFilter, ''>; label: string }[] = [
    { key: 'low', label: 'Low stock' },
    { key: 'out', label: 'Out of stock' },
  ];

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
          <TouchableOpacity
            style={[styles.editBtn, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}
            onPress={() => openAdjust(item)}
          >
            <Text style={[styles.editBtnText, { color: C.textPrimary }]}>Adjust stock</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: C.bgTertiary }]}>
      <TimezoneBar />
      {/* Search bar — full width, no Add button (Add lives on Ingredients) */}
      <View style={styles.searchRow}>
        <TextInput
          style={[styles.search, { backgroundColor: C.bgPrimary, borderColor: C.borderLight, color: C.textPrimary }]}
          placeholder="Search items..."
          placeholderTextColor={C.textTertiary}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {/* Filter row: All → status chips (low/out) → store-managed categories */}
      <View style={styles.catWrapper}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.catRow}>
          <TouchableOpacity
            key="all"
            style={[styles.catChip, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, catFilter === '' && statusFilter === '' && [styles.catChipActive, { backgroundColor: C.textPrimary }]]}
            onPress={() => { setCatFilter(''); setStatusFilter(''); }}
          >
            <Text style={[styles.catChipText, { color: C.textSecondary }, catFilter === '' && statusFilter === '' && [styles.catChipTextActive, { color: C.bgPrimary }]]}>
              All ({allCount})
            </Text>
          </TouchableOpacity>
          {statusChips.map((chip) => {
            const active = statusFilter === chip.key;
            const count = chip.key === 'low' ? lowCount : outCount;
            return (
              <TouchableOpacity
                key={chip.key}
                style={[styles.catChip, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, active && [styles.catChipActive, { backgroundColor: C.textPrimary }]]}
                onPress={() => setStatusFilter(active ? '' : chip.key)}
              >
                <Text style={[styles.catChipText, { color: C.textSecondary }, active && [styles.catChipTextActive, { color: C.bgPrimary }]]}>
                  {chip.label} ({count})
                </Text>
              </TouchableOpacity>
            );
          })}
          {CATEGORIES.map((cat) => (
            <TouchableOpacity
              key={cat}
              style={[styles.catChip, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, catFilter === cat && [styles.catChipActive, { backgroundColor: C.textPrimary }]]}
              onPress={() => setCatFilter(catFilter === cat ? '' : cat)}
            >
              <Text style={[styles.catChipText, { color: C.textSecondary }, catFilter === cat && [styles.catChipTextActive, { color: C.bgPrimary }]]}>
                {cat} ({categoryCounts[cat] || 0})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <WebScrollView id="items-scroll" contentContainerStyle={styles.list}>
        {sorted.length === 0 ? (
          <Text style={[styles.empty, { color: C.textTertiary }]}>No items found</Text>
        ) : (
          sorted.map((item) => (
            <View key={item.id}>{renderItem({ item })}</View>
          ))
        )}
      </WebScrollView>

      {/* Adjust-stock modal */}
      <Modal visible={!!adjustItem} animationType="slide" presentationStyle="pageSheet">
        {adjustItem && (
          <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
            <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
              <View>
                <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Adjust stock</Text>
                <Text style={[styles.itemCat, { color: C.textTertiary, marginTop: 2 }]}>
                  {adjustItem.name}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setAdjustItem(null)}>
                <Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody}>
              <View style={[styles.adjustCurrentRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                <Text style={[styles.formLabel, { color: C.textTertiary }]}>Current stock</Text>
                <Text style={[styles.statValue, { color: C.textPrimary }]}>
                  {adjustItem.currentStock} {adjustItem.unit}
                </Text>
              </View>

              <View style={styles.formField}>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>New stock ({adjustItem.unit})</Text>
                <TextInput
                  style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                  value={adjustValue}
                  onChangeText={(v) => setAdjustValue(numericFilter(v))}
                  placeholder="0"
                  placeholderTextColor={C.textTertiary}
                  keyboardType="decimal-pad"
                />
              </View>

              <View style={styles.formField}>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>Reason (optional)</Text>
                <TextInput
                  style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                  value={adjustReason}
                  onChangeText={setAdjustReason}
                  placeholder="e.g. delivery received, found in back, breakage"
                  placeholderTextColor={C.textTertiary}
                />
              </View>

              <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleAdjustSave}>
                <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>Save adjustment</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  searchRow: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.lg, paddingBottom: 0 },
  search: { flex: 1, backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 8, fontSize: FontSize.base, borderWidth: 0.5, borderColor: Colors.borderLight, color: Colors.textPrimary },
  catWrapper: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
  catRow: { flexDirection: 'row', alignItems: 'center' },
  catChip: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 5, marginRight: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  catChipActive: { backgroundColor: Colors.textPrimary },
  catChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  catChipTextActive: { color: Colors.bgPrimary, fontWeight: '500' },
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
  adjustCurrentRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: Colors.bgSecondary, borderWidth: 0.5, borderColor: Colors.borderLight,
    borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md,
  },
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
  saveBtnText: { color: Colors.bgPrimary, fontSize: FontSize.base, fontWeight: '600' },
});

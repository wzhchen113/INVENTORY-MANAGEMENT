// src/screens/IngredientsScreen.tsx
import React, { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TextInput,
  TouchableOpacity, Modal, Alert, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { numericFilter } from '../utils';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { InventoryItem } from '../types';
import { WebScrollView } from '../components/WebScrollView';

const CATEGORIES = [
  'Protein', 'Seafood', 'Produce', 'Dairy',
  'Dry goods', 'Bakery', 'Condiments', 'Drinks', 'Desserts',
];

const UNITS = ['lbs', 'oz', 'cases', 'each', 'gal', 'qt', 'loaves', 'bags'];

export default function IngredientsScreen() {
  const { currentUser, currentStore, stores, inventory, vendors, addItem, updateItem, deleteItem } = useStore();
  const C = useColors();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';

  const storeInventory = useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id]
  );

  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);

  // Bulk mode state
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkModal, setBulkModal] = useState<'stores' | 'category' | 'vendor' | null>(null);
  const [bulkStoreIds, setBulkStoreIds] = useState<string[]>([]);
  const [bulkCategory, setBulkCategory] = useState('');
  const [bulkVendorId, setBulkVendorId] = useState('');
  const [bulkVendorName, setBulkVendorName] = useState('');
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; onConfirm: () => void; destructive?: boolean } | null>(null);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((i) => i.id)));
    }
  };

  const exitBulkMode = () => {
    setBulkMode(false);
    setSelectedIds(new Set());
  };

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    setConfirmAction({
      title: 'Delete ingredients',
      message: `Delete ${selectedIds.size} ingredient(s) from all stores? This cannot be undone.`,
      destructive: true,
      onConfirm: () => {
        selectedIds.forEach((id) => {
          const item = inventory.find((i) => i.id === id);
          if (item) {
            const copies = inventory.filter((i) => i.name.toLowerCase() === item.name.toLowerCase());
            copies.forEach((c) => deleteItem(c.id));
          }
        });
        exitBulkMode();
      },
    });
  };

  const applyBulkStores = () => {
    if (bulkStoreIds.length === 0) return;
    const storeNames = bulkStoreIds.map((sid) => stores.find((s) => s.id === sid)?.name).filter(Boolean).join(', ');
    setConfirmAction({
      title: 'Change stores',
      message: `Assign ${selectedIds.size} ingredient(s) to: ${storeNames}?`,
      onConfirm: () => {
        selectedIds.forEach((id) => {
          const item = inventory.find((i) => i.id === id);
          if (!item) return;
          const existingCopies = inventory.filter((i) => i.name.toLowerCase() === item.name.toLowerCase());
          const existingStoreIds = existingCopies.map((c) => c.storeId);
          for (const storeId of bulkStoreIds) {
            if (!existingStoreIds.includes(storeId)) {
              addItem({ ...item, id: undefined as any, storeId, currentStock: 0, eodRemaining: 0 });
            }
          }
          existingCopies.forEach((c) => {
            if (!bulkStoreIds.includes(c.storeId)) deleteItem(c.id);
          });
        });
        setBulkModal(null);
        exitBulkMode();
      },
    });
  };

  const applyBulkCategory = () => {
    if (!bulkCategory) return;
    setConfirmAction({
      title: 'Change category',
      message: `Change category to "${bulkCategory}" for ${selectedIds.size} ingredient(s)?`,
      onConfirm: () => {
        selectedIds.forEach((id) => {
          const item = inventory.find((i) => i.id === id);
          if (!item) return;
          const copies = inventory.filter((i) => i.name.toLowerCase() === item.name.toLowerCase());
          copies.forEach((c) => updateItem(c.id, { category: bulkCategory }));
        });
        setBulkModal(null);
        exitBulkMode();
      },
    });
  };

  const applyBulkVendor = () => {
    const vendorLabel = bulkVendorName || 'None';
    setConfirmAction({
      title: 'Change vendor',
      message: `Change vendor to "${vendorLabel}" for ${selectedIds.size} ingredient(s)?`,
      onConfirm: () => {
        selectedIds.forEach((id) => {
          const item = inventory.find((i) => i.id === id);
          if (!item) return;
          const copies = inventory.filter((i) => i.name.toLowerCase() === item.name.toLowerCase());
          copies.forEach((c) => updateItem(c.id, { vendorId: bulkVendorId, vendorName: bulkVendorName }));
        });
        setBulkModal(null);
        exitBulkMode();
      },
    });
  };

  const [form, setForm] = useState({
    name: '',
    category: 'Protein',
    unit: 'lbs',
    costPerUnit: '',
    currentStock: '',
    parLevel: '',
    vendorId: '',
    vendorName: '',
    casePrice: '',
    caseQty: '1',
    subUnitSize: '1',
    subUnitUnit: '',
  });
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);

  const filtered = useMemo(() => {
    return storeInventory.filter((item) => {
      if (search) {
        const q = search.toLowerCase();
        if (!item.name.toLowerCase().includes(q) && !item.category.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (catFilter && item.category !== catFilter) return false;
      if (vendorFilter && item.vendorName !== vendorFilter) return false;
      return true;
    });
  }, [storeInventory, search, catFilter, vendorFilter]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    storeInventory.forEach((i) => {
      counts[i.category] = (counts[i.category] || 0) + 1;
    });
    return counts;
  }, [storeInventory]);

  const vendorCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    storeInventory.forEach((i) => {
      if (i.vendorName) {
        counts[i.vendorName] = (counts[i.vendorName] || 0) + 1;
      }
    });
    return counts;
  }, [storeInventory]);

  const vendorNames = useMemo(
    () => Object.keys(vendorCounts).sort(),
    [vendorCounts]
  );

  const toggleStore = (id: string) => {
    setSelectedStoreIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  };

  const selectAllStores = () => {
    if (selectedStoreIds.length === stores.length) {
      setSelectedStoreIds([]);
    } else {
      setSelectedStoreIds(stores.map((s) => s.id));
    }
  };

  const openAdd = () => {
    setEditItem(null);
    setDupWarning('');
    setForm({ name: '', category: 'Protein', unit: 'lbs', costPerUnit: '', currentStock: '', parLevel: '', vendorId: '', vendorName: '', casePrice: '', caseQty: '1', subUnitSize: '1', subUnitUnit: '' });
    setSelectedStoreIds(stores.map((s) => s.id)); // default: all stores selected
    setShowModal(true);
  };

  const openEdit = (item: InventoryItem) => {
    setEditItem(item);
    setDupWarning('');
    setForm({
      name: item.name,
      category: item.category,
      unit: item.unit,
      costPerUnit: String(item.costPerUnit),
      currentStock: String(item.currentStock),
      parLevel: String(item.parLevel),
      vendorId: item.vendorId,
      vendorName: item.vendorName,
      casePrice: String(item.casePrice || ''),
      caseQty: String(item.caseQty || 1),
      subUnitSize: String(item.subUnitSize || 1),
      subUnitUnit: item.subUnitUnit || '',
    });
    // Find all stores that already have this ingredient (by name)
    const storesWithItem = inventory
      .filter((i) => i.name.toLowerCase() === item.name.toLowerCase())
      .map((i) => i.storeId);
    setSelectedStoreIds([...new Set(storesWithItem)]);
    setShowModal(true);
  };

  const [dupWarning, setDupWarning] = useState('');

  const handleSave = () => {
    if (!form.name.trim()) {
      if (Platform.OS === 'web') alert('Ingredient name is required');
      else Alert.alert('Error', 'Ingredient name is required');
      return;
    }
    if (!form.costPerUnit || parseFloat(form.costPerUnit) <= 0) {
      if (Platform.OS === 'web') alert('Cost per unit is required');
      else Alert.alert('Error', 'Cost per unit is required');
      return;
    }

    if (selectedStoreIds.length === 0) {
      if (Platform.OS === 'web') alert('Select at least one store');
      else Alert.alert('Error', 'Select at least one store');
      return;
    }

    // Check for duplicate names within ingredients only, per selected store
    const trimmedName = form.name.trim().toLowerCase();
    const duplicateStoreNames: string[] = [];
    for (const storeId of selectedStoreIds) {
      const exists = inventory.some(
        (i) =>
          i.storeId === storeId &&
          i.name.toLowerCase() === trimmedName &&
          (!editItem || i.name.toLowerCase() !== editItem.name.toLowerCase())
      );
      if (exists) {
        const store = stores.find((s) => s.id === storeId);
        if (store) duplicateStoreNames.push(store.name);
      }
    }

    if (duplicateStoreNames.length > 0) {
      setDupWarning(`An ingredient named "${form.name.trim()}" already exists in: ${duplicateStoreNames.join(', ')}.`);
      return;
    }
    setDupWarning('');

    if (editItem) {
      // Find all existing copies of this ingredient across stores
      const existingItems = inventory.filter(
        (i) => i.name.toLowerCase() === editItem.name.toLowerCase()
      );
      const existingStoreIds = existingItems.map((i) => i.storeId);

      // Update properties on all existing copies that are still selected
      existingItems.forEach((item) => {
        if (selectedStoreIds.includes(item.storeId)) {
          updateItem(item.id, {
            name: form.name.trim(),
            category: form.category,
            unit: form.unit,
            costPerUnit: parseFloat(form.costPerUnit) || 0,
            parLevel: parseFloat(form.parLevel) || 0,
            vendorId: form.vendorId,
            vendorName: form.vendorName,
            casePrice: parseFloat(form.casePrice) || 0,
            caseQty: parseFloat(form.caseQty) || 1,
            subUnitSize: parseFloat(form.subUnitSize) || 1,
            subUnitUnit: form.subUnitUnit,
            lastUpdatedBy: currentUser?.name || '',
            lastUpdatedAt: new Date().toISOString(),
          });
        }
      });

      // Delete from stores that were deselected
      existingItems.forEach((item) => {
        if (!selectedStoreIds.includes(item.storeId)) {
          deleteItem(item.id);
        }
      });

      // Add to newly selected stores
      const newStoreIds = selectedStoreIds.filter((sid) => !existingStoreIds.includes(sid));
      for (const storeId of newStoreIds) {
        addItem({
          name: form.name.trim(),
          category: form.category,
          unit: form.unit,
          costPerUnit: parseFloat(form.costPerUnit) || 0,
          currentStock: 0,
          parLevel: parseFloat(form.parLevel) || 0,
          averageDailyUsage: 0,
          safetyStock: 0,
          vendorId: form.vendorId,
          vendorName: form.vendorName,
          usagePerPortion: editItem.usagePerPortion,
          casePrice: parseFloat(form.casePrice) || 0,
          caseQty: parseFloat(form.caseQty) || 1,
          subUnitSize: parseFloat(form.subUnitSize) || 1,
          subUnitUnit: form.subUnitUnit,
          lastUpdatedBy: currentUser?.name || '',
          lastUpdatedAt: new Date().toISOString(),
          eodRemaining: 0,
          storeId,
          expiryDate: '',
        });
      }
    } else {
      // Add: create in all selected stores
      for (const storeId of selectedStoreIds) {
        addItem({
          name: form.name.trim(),
          category: form.category,
          unit: form.unit,
          costPerUnit: parseFloat(form.costPerUnit) || 0,
          currentStock: parseFloat(form.currentStock) || 0,
          parLevel: parseFloat(form.parLevel) || 0,
          averageDailyUsage: 0,
          safetyStock: 0,
          vendorId: form.vendorId,
          vendorName: form.vendorName,
          usagePerPortion: 0,
          casePrice: parseFloat(form.casePrice) || 0,
          caseQty: parseFloat(form.caseQty) || 1,
          subUnitSize: parseFloat(form.subUnitSize) || 1,
          subUnitUnit: form.subUnitUnit,
          lastUpdatedBy: currentUser?.name || '',
          lastUpdatedAt: new Date().toISOString(),
          eodRemaining: parseFloat(form.currentStock) || 0,
          storeId,
          expiryDate: '',
        });
      }
    }
    setShowModal(false);
  };

  const handleDeleteEntirely = () => {
    if (!editItem) return;
    const allCopies = inventory.filter(
      (i) => i.name.toLowerCase() === editItem.name.toLowerCase()
    );
    const doDelete = () => {
      allCopies.forEach((item) => deleteItem(item.id));
      setShowModal(false);
    };
    if (Platform.OS === 'web') {
      if (confirm(`Delete "${editItem.name}" from all ${allCopies.length} store(s)? This cannot be undone.`)) {
        doDelete();
      }
    } else {
      Alert.alert(
        'Delete ingredient',
        `Delete "${editItem.name}" from all ${allCopies.length} store(s)? This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: doDelete },
        ]
      );
    }
  };

  const renderItem = ({ item }: { item: InventoryItem }) => {
    const isSelected = selectedIds.has(item.id);
    return (
      <TouchableOpacity
        activeOpacity={bulkMode ? 0.7 : 1}
        onPress={bulkMode ? () => toggleSelect(item.id) : undefined}
        style={[styles.row, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, isSelected && { borderColor: C.info, backgroundColor: C.infoBg }]}
      >
        {bulkMode && (
          <View style={[styles.bulkCheck, { borderColor: C.borderMedium }, isSelected && { backgroundColor: C.info, borderColor: C.info }]}>
            {isSelected && <Ionicons name="checkmark" size={12} color={C.bgPrimary} />}
          </View>
        )}
        <View style={styles.rowLeft}>
          <Text style={[styles.rowName, { color: C.textPrimary }]}>{item.name}</Text>
          <Text style={[styles.rowMeta, { color: C.textTertiary }]}>
            {item.category} · {item.currentStock} {item.unit}
            {item.parLevel > 0 ? ` · Par: ${item.parLevel}` : ''}
            {item.vendorName ? ` · ${item.vendorName}` : ''}
          </Text>
        </View>
        <View style={styles.rowRight}>
          <Text style={[styles.rowCost, { color: C.textPrimary }]}>${item.costPerUnit.toFixed(2)}</Text>
          <Text style={[styles.rowCostLabel, { color: C.textTertiary }]}>per {item.subUnitUnit || item.unit}</Text>
        </View>
        {isAdmin && !bulkMode && (
          <TouchableOpacity style={[styles.rowEditBtn, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => openEdit(item)}>
            <Ionicons name="create-outline" size={14} color={C.textSecondary} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: C.bgTertiary }]}>
      {/* Header row */}
      <View style={styles.headerRow}>
        <View style={[styles.searchBar, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
          <Ionicons name="search-outline" size={16} color={C.textTertiary} />
          <TextInput
            style={[styles.searchInput, { color: C.textPrimary }]}
            placeholder="Search ingredients..."
            placeholderTextColor={C.textTertiary}
            value={search}
            onChangeText={setSearch}
          />
          {search ? (
            <TouchableOpacity onPress={() => setSearch('')}>
              <Ionicons name="close-circle" size={16} color={C.textTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
        {isAdmin && (
          <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
            <TouchableOpacity
              style={[styles.gearBtn, { backgroundColor: bulkMode ? C.textPrimary : C.bgSecondary, borderColor: C.borderLight }]}
              onPress={() => bulkMode ? exitBulkMode() : setBulkMode(true)}
            >
              <Ionicons name={bulkMode ? 'close' : 'settings-outline'} size={18} color={bulkMode ? C.bgPrimary : C.textSecondary} />
            </TouchableOpacity>
            {!bulkMode && (
              <TouchableOpacity style={[styles.addBtn, { backgroundColor: C.textPrimary }]} onPress={openAdd}>
                <Ionicons name="add" size={18} color={C.bgPrimary} />
                <Text style={[styles.addBtnText, { color: C.bgPrimary }]}>Add</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {/* Category pills */}
      <View style={styles.pillWrapper}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
          <TouchableOpacity
            style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, !catFilter && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
            onPress={() => setCatFilter('')}
          >
            <Text style={[styles.pillText, { color: C.textSecondary }, !catFilter && { color: C.bgPrimary }]}>
              All ({storeInventory.length})
            </Text>
          </TouchableOpacity>
          {CATEGORIES.filter((c) => categoryCounts[c]).map((cat) => {
            const isActive = catFilter === cat;
            return (
              <TouchableOpacity
                key={cat}
                style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, isActive && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                onPress={() => setCatFilter(isActive ? '' : cat)}
              >
                <Text style={[styles.pillText, { color: C.textSecondary }, isActive && { color: C.bgPrimary }]}>
                  {cat} ({categoryCounts[cat] || 0})
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Vendor pills */}
      {vendorNames.length > 0 && (
        <View style={[styles.pillWrapper, { paddingTop: 0 }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
            <TouchableOpacity
              style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, !vendorFilter && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
              onPress={() => setVendorFilter('')}
            >
              <Text style={[styles.pillText, { color: C.textSecondary }, !vendorFilter && { color: C.bgPrimary }]}>
                All vendors
              </Text>
            </TouchableOpacity>
            {vendorNames.map((v) => {
              const isActive = vendorFilter === v;
              return (
                <TouchableOpacity
                  key={v}
                  style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, isActive && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                  onPress={() => setVendorFilter(isActive ? '' : v)}
                >
                  <Text style={[styles.pillText, { color: C.textSecondary }, isActive && { color: C.bgPrimary }]}>
                    {v} ({vendorCounts[v]})
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Summary bar */}
      <View style={styles.summaryBar}>
        <Text style={[styles.summaryText, { color: C.textTertiary }]}>
          {bulkMode ? `${selectedIds.size} of ${filtered.length} selected` : `${filtered.length} ingredient${filtered.length !== 1 ? 's' : ''}`}
        </Text>
        {bulkMode ? (
          <TouchableOpacity onPress={selectAll}>
            <Text style={{ fontSize: FontSize.xs, color: C.info, fontWeight: '500' }}>
              {selectedIds.size === filtered.length ? 'Deselect all' : 'Select all'}
            </Text>
          </TouchableOpacity>
        ) : !isAdmin ? (
          <View style={[styles.readOnlyBadge, { backgroundColor: C.bgSecondary }]}>
            <Ionicons name="lock-closed-outline" size={10} color={C.textTertiary} />
            <Text style={[styles.readOnlyText, { color: C.textTertiary }]}>View only</Text>
          </View>
        ) : null}
      </View>

      {/* Bulk action toolbar */}
      {bulkMode && selectedIds.size > 0 && (
        <View style={[styles.bulkToolbar, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
          <TouchableOpacity style={[styles.bulkBtn, { backgroundColor: C.bgSecondary }]} onPress={() => { setBulkStoreIds(stores.map((s) => s.id)); setBulkModal('stores'); }}>
            <Ionicons name="storefront-outline" size={14} color={C.textPrimary} />
            <Text style={[styles.bulkBtnText, { color: C.textPrimary }]}>Stores</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.bulkBtn, { backgroundColor: C.bgSecondary }]} onPress={() => { setBulkCategory(''); setBulkModal('category'); }}>
            <Ionicons name="pricetag-outline" size={14} color={C.textPrimary} />
            <Text style={[styles.bulkBtnText, { color: C.textPrimary }]}>Category</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.bulkBtn, { backgroundColor: C.bgSecondary }]} onPress={() => { setBulkVendorId(''); setBulkVendorName(''); setBulkModal('vendor'); }}>
            <Ionicons name="business-outline" size={14} color={C.textPrimary} />
            <Text style={[styles.bulkBtnText, { color: C.textPrimary }]}>Vendor</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.bulkBtn, { backgroundColor: C.dangerBg }]} onPress={handleBulkDelete}>
            <Ionicons name="trash-outline" size={14} color={C.danger} />
            <Text style={[styles.bulkBtnText, { color: C.danger }]}>Delete</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* List */}
      <WebScrollView id="ingredients-scroll" contentContainerStyle={styles.list}>
        {filtered.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="restaurant-outline" size={32} color={C.textTertiary} />
            <Text style={[styles.emptyText, { color: C.textTertiary }]}>No ingredients found</Text>
            {isAdmin && (
              <TouchableOpacity style={[styles.emptyBtn, { backgroundColor: C.textPrimary }]} onPress={openAdd}>
                <Text style={[styles.emptyBtnText, { color: C.bgPrimary }]}>Add your first ingredient</Text>
              </TouchableOpacity>
            )}
          </View>
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
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>
              {editItem ? 'Edit ingredient' : 'Add ingredient'}
            </Text>
            <TouchableOpacity onPress={() => setShowModal(false)}>
              <Text style={[styles.modalCancel, { color: C.info }]}>Cancel</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.modalBody}>
            {/* Store selection */}
            <View style={styles.formField}>
              <View style={styles.storeLabelRow}>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>
                  {editItem ? 'Stores *' : 'Add to stores *'}
                </Text>
                <TouchableOpacity onPress={selectAllStores}>
                  <Text style={[styles.selectAllText, { color: C.info }]}>
                    {selectedStoreIds.length === stores.length ? 'Deselect all' : 'Select all'}
                  </Text>
                </TouchableOpacity>
              </View>
              <View style={styles.storeGrid}>
                {stores.map((store) => {
                  const isSelected = selectedStoreIds.includes(store.id);
                  return (
                    <TouchableOpacity
                      key={store.id}
                      style={[styles.storeChip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, isSelected && { backgroundColor: C.successBg, borderColor: C.success }]}
                      onPress={() => toggleStore(store.id)}
                    >
                      <View style={[styles.storeChipCheck, { borderColor: C.borderMedium }, isSelected && { backgroundColor: C.success, borderColor: C.success }]}>
                        {isSelected && <Ionicons name="checkmark" size={10} color={C.white} />}
                      </View>
                      <Text style={[styles.storeChipText, { color: C.textSecondary }, isSelected && { color: C.textPrimary }]}>
                        {store.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={[styles.storeHint, { color: C.textTertiary }]}>
                {selectedStoreIds.length} of {stores.length} store{stores.length !== 1 ? 's' : ''} selected
              </Text>
            </View>

            {/* Name */}
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Ingredient name *</Text>
              <TextInput
                style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                value={form.name}
                onChangeText={(v) => setForm((p) => ({ ...p, name: v }))}
                placeholder="e.g. Chicken breast"
                placeholderTextColor={C.textTertiary}
              />
            </View>

            {/* Category */}
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.chipRow}>
                  {CATEGORIES.map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[styles.chip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, form.category === cat && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                      onPress={() => setForm((p) => ({ ...p, category: cat }))}
                    >
                      <Text style={[styles.chipText, { color: C.textSecondary }, form.category === cat && { color: C.bgPrimary }]}>
                        {cat}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            </View>

            {/* Unit */}
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Unit</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.chipRow}>
                  {UNITS.map((u) => (
                    <TouchableOpacity
                      key={u}
                      style={[styles.chip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, form.unit === u && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                      onPress={() => setForm((p) => ({ ...p, unit: u }))}
                    >
                      <Text style={[styles.chipText, { color: C.textSecondary }, form.unit === u && { color: C.bgPrimary }]}>
                        {u}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            </View>

            {/* Vendor */}
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Vendor</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.chipRow}>
                  <TouchableOpacity
                    style={[styles.chip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, !form.vendorId && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                    onPress={() => setForm((p) => ({ ...p, vendorId: '', vendorName: '' }))}
                  >
                    <Text style={[styles.chipText, { color: C.textSecondary }, !form.vendorId && { color: C.bgPrimary }]}>None</Text>
                  </TouchableOpacity>
                  {vendors.map((v) => (
                    <TouchableOpacity
                      key={v.id}
                      style={[styles.chip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, form.vendorId === v.id && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                      onPress={() => setForm((p) => ({ ...p, vendorId: v.id, vendorName: v.name }))}
                    >
                      <Text style={[styles.chipText, { color: C.textSecondary }, form.vendorId === v.id && { color: C.bgPrimary }]}>
                        {v.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            </View>

            {/* Packaging & Pricing */}
            <Text style={[styles.formLabel, { color: C.textTertiary, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: Spacing.md }]}>Packaging & pricing</Text>

            <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
              <View style={[styles.formField, { flex: 1 }]}>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>Case price ($)</Text>
                <TextInput
                  style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                  value={form.casePrice}
                  onChangeText={(v) => {
                    const val = numericFilter(v);
                    const cp = parseFloat(val) || 0;
                    const qty = parseFloat(form.caseQty) || 1;
                    const size = parseFloat(form.subUnitSize) || 1;
                    const total = qty * size;
                    const unitCost = total > 0 ? (cp / total).toFixed(2) : '0';
                    setForm((p) => ({ ...p, casePrice: val, costPerUnit: unitCost }));
                  }}
                  placeholder="240.00"
                  placeholderTextColor={C.textTertiary}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={[styles.formField, { flex: 1 }]}>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>Units per case</Text>
                <TextInput
                  style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                  value={form.caseQty}
                  onChangeText={(v) => {
                    const val = numericFilter(v);
                    const qty = parseFloat(val) || 1;
                    const size = parseFloat(form.subUnitSize) || 1;
                    const cp = parseFloat(form.casePrice) || 0;
                    const total = qty * size;
                    const unitCost = total > 0 ? (cp / total).toFixed(2) : '0';
                    setForm((p) => ({ ...p, caseQty: val, costPerUnit: unitCost }));
                  }}
                  placeholder="6"
                  placeholderTextColor={C.textTertiary}
                  keyboardType="decimal-pad"
                />
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
              <View style={[styles.formField, { flex: 1 }]}>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>Size per unit</Text>
                <TextInput
                  style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                  value={form.subUnitSize}
                  onChangeText={(v) => {
                    const val = numericFilter(v);
                    const size = parseFloat(val) || 1;
                    const qty = parseFloat(form.caseQty) || 1;
                    const cp = parseFloat(form.casePrice) || 0;
                    const total = qty * size;
                    const unitCost = total > 0 ? (cp / total).toFixed(2) : '0';
                    setForm((p) => ({ ...p, subUnitSize: val, costPerUnit: unitCost }));
                  }}
                  placeholder="10"
                  placeholderTextColor={C.textTertiary}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={[styles.formField, { flex: 1 }]}>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>Unit type</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
                  {UNITS.map((u) => (
                    <TouchableOpacity key={u} style={[styles.miniChip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, form.subUnitUnit === u && { backgroundColor: C.textPrimary }]} onPress={() => setForm((p) => ({ ...p, subUnitUnit: u }))}>
                      <Text style={[styles.miniChipText, { color: C.textSecondary }, form.subUnitUnit === u && { color: C.bgPrimary }]}>{u}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>

            {/* Breakdown summary */}
            {parseFloat(form.casePrice) > 0 && (
              <View style={[styles.priceSummary, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                <Text style={[styles.priceSummaryText, { color: C.textSecondary }]}>
                  1 case = {form.caseQty} × {form.subUnitSize} {form.subUnitUnit || form.unit} = {((parseFloat(form.caseQty) || 1) * (parseFloat(form.subUnitSize) || 1)).toFixed(0)} {form.subUnitUnit || form.unit}
                </Text>
                <Text style={[styles.priceSummaryBold, { color: C.textPrimary }]}>
                  ${parseFloat(form.casePrice).toFixed(2)}/case → ${form.costPerUnit}/{form.subUnitUnit || form.unit}
                </Text>
              </View>
            )}

            {/* Unit cost (auto-calculated or manual) */}
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Cost per {form.subUnitUnit || form.unit} ($) *</Text>
              <TextInput
                style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                value={form.costPerUnit}
                onChangeText={(v) => {
                  const val = numericFilter(v);
                  const unitCost = parseFloat(val) || 0;
                  const qty = parseFloat(form.caseQty) || 1;
                  const size = parseFloat(form.subUnitSize) || 1;
                  const total = qty * size;
                  const cp = (unitCost * total).toFixed(2);
                  setForm((p) => ({ ...p, costPerUnit: val, casePrice: cp }));
                }}
                placeholder="0.00"
                placeholderTextColor={C.textTertiary}
                keyboardType="decimal-pad"
              />
            </View>

            {/* Current stock */}
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Current stock</Text>
              <TextInput
                style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                value={form.currentStock}
                onChangeText={(v) => setForm((p) => ({ ...p, currentStock: numericFilter(v) }))}
                placeholder="0"
                placeholderTextColor={C.textTertiary}
                keyboardType="decimal-pad"
              />
            </View>

            {/* Par level */}
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Par level (minimum stock)</Text>
              <TextInput
                style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                value={form.parLevel}
                onChangeText={(v) => setForm((p) => ({ ...p, parLevel: numericFilter(v) }))}
                placeholder="0"
                placeholderTextColor={C.textTertiary}
                keyboardType="decimal-pad"
              />
            </View>

            {/* Save button */}
            {dupWarning ? (
              <View style={[styles.dupWarning, { backgroundColor: C.warningBg, borderColor: C.warning }]}>
                <Text style={[styles.dupWarningText, { color: C.warning }]}>{dupWarning}</Text>
              </View>
            ) : null}

            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleSave}>
              <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>
                {editItem
                  ? `Save to ${selectedStoreIds.length} store${selectedStoreIds.length !== 1 ? 's' : ''}`
                  : selectedStoreIds.length > 1
                    ? `Add to ${selectedStoreIds.length} stores`
                    : 'Add ingredient'}
              </Text>
            </TouchableOpacity>

            {/* Delete button — admin only, edit mode only */}
            {editItem && isAdmin && (
              <TouchableOpacity style={[styles.deleteBtn, { borderColor: C.danger }]} onPress={handleDeleteEntirely}>
                <Ionicons name="trash-outline" size={16} color={C.danger} />
                <Text style={[styles.deleteBtnText, { color: C.danger }]}>Delete from all stores</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Bulk Edit Stores Modal */}
      <Modal visible={bulkModal === 'stores'} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Change stores for {selectedIds.size} item(s)</Text>
            <TouchableOpacity onPress={() => setBulkModal(null)}><Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            <View style={styles.storeGrid}>
              {stores.map((store) => {
                const sel = bulkStoreIds.includes(store.id);
                return (
                  <TouchableOpacity key={store.id} style={[styles.storeChip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, sel && { backgroundColor: C.successBg, borderColor: C.success }]}
                    onPress={() => setBulkStoreIds((prev) => sel ? prev.filter((s) => s !== store.id) : [...prev, store.id])}>
                    <View style={[styles.storeChipCheck, { borderColor: C.borderMedium }, sel && { backgroundColor: C.success, borderColor: C.success }]}>
                      {sel && <Ionicons name="checkmark" size={10} color={C.white} />}
                    </View>
                    <Text style={[styles.storeChipText, { color: C.textSecondary }, sel && { color: C.textPrimary }]}>{store.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity style={[styles.saveBtn, { marginTop: Spacing.xl, backgroundColor: C.textPrimary }]} onPress={applyBulkStores}>
              <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>Apply to {selectedIds.size} item(s)</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Bulk Edit Category Modal */}
      <Modal visible={bulkModal === 'category'} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Change category for {selectedIds.size} item(s)</Text>
            <TouchableOpacity onPress={() => setBulkModal(null)}><Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            {CATEGORIES.map((cat) => (
              <TouchableOpacity key={cat} style={[styles.chipRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, bulkCategory === cat && { backgroundColor: C.textPrimary }]}
                onPress={() => setBulkCategory(cat)}>
                <Text style={[styles.chipText, { color: C.textSecondary }, bulkCategory === cat && { color: C.bgPrimary }]}>{cat}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[styles.saveBtn, { marginTop: Spacing.xl, backgroundColor: C.textPrimary }, !bulkCategory && { opacity: 0.4 }]} onPress={applyBulkCategory} disabled={!bulkCategory}>
              <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>Apply to {selectedIds.size} item(s)</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Bulk Edit Vendor Modal */}
      <Modal visible={bulkModal === 'vendor'} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Change vendor for {selectedIds.size} item(s)</Text>
            <TouchableOpacity onPress={() => setBulkModal(null)}><Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            <TouchableOpacity style={[styles.chipRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, !bulkVendorId && bulkVendorName === '' && { backgroundColor: C.textPrimary }]}
              onPress={() => { setBulkVendorId(''); setBulkVendorName(''); }}>
              <Text style={[styles.chipText, { color: C.textSecondary }, !bulkVendorId && bulkVendorName === '' && { color: C.bgPrimary }]}>None</Text>
            </TouchableOpacity>
            {vendors.map((v) => (
              <TouchableOpacity key={v.id} style={[styles.chipRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, bulkVendorId === v.id && { backgroundColor: C.textPrimary }]}
                onPress={() => { setBulkVendorId(v.id); setBulkVendorName(v.name); }}>
                <Text style={[styles.chipText, { color: C.textSecondary }, bulkVendorId === v.id && { color: C.bgPrimary }]}>{v.name}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[styles.saveBtn, { marginTop: Spacing.xl, backgroundColor: C.textPrimary }]} onPress={applyBulkVendor}>
              <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>Apply to {selectedIds.size} item(s)</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* In-app Confirmation Modal */}
      <Modal visible={!!confirmAction} transparent animationType="fade">
        <View style={styles.confirmOverlay}>
          <View style={[styles.confirmBox, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            <Text style={[styles.confirmTitle, { color: C.textPrimary }]}>{confirmAction?.title}</Text>
            <Text style={[styles.confirmMessage, { color: C.textSecondary }]}>{confirmAction?.message}</Text>
            <View style={styles.confirmBtnRow}>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: C.bgSecondary }]} onPress={() => setConfirmAction(null)}>
                <Text style={[styles.confirmBtnText, { color: C.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, { backgroundColor: confirmAction?.destructive ? C.danger : C.textPrimary }]}
                onPress={() => { confirmAction?.onConfirm(); setConfirmAction(null); }}
              >
                <Text style={[styles.confirmBtnText, { color: C.bgPrimary }]}>{confirmAction?.destructive ? 'Delete' : 'Confirm'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },

  // Header
  headerRow: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.lg, paddingBottom: 0 },
  searchBar: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 8, borderWidth: 0.5, borderColor: Colors.borderLight },
  searchInput: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary, padding: 0 },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.textPrimary, borderRadius: Radius.md, paddingHorizontal: 14, paddingVertical: 8 },
  addBtnText: { color: Colors.bgPrimary, fontSize: FontSize.sm, fontWeight: '500' },
  gearBtn: { width: 36, height: 36, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 0.5 },

  // Pills
  pillWrapper: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.round, backgroundColor: Colors.bgPrimary, borderWidth: 0.5, borderColor: Colors.borderLight },
  pillActive: { backgroundColor: Colors.textPrimary, borderColor: Colors.textPrimary },
  pillText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500' },
  pillTextActive: { color: Colors.bgPrimary },

  // Summary
  summaryBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  summaryText: { fontSize: FontSize.xs, color: Colors.textTertiary },
  readOnlyBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.bgSecondary, paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.round },
  readOnlyText: { fontSize: 9, color: Colors.textTertiary, fontWeight: '500' },

  // List
  list: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xxxl },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  rowLeft: { flex: 1 },
  rowName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  rowMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  rowRight: { alignItems: 'flex-end', marginRight: Spacing.sm },
  rowCost: { fontSize: FontSize.base, fontWeight: '600', color: Colors.textPrimary },
  rowCostLabel: { fontSize: 9, color: Colors.textTertiary },
  rowEditBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.bgSecondary, alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: Colors.borderLight },

  // Empty
  emptyBox: { alignItems: 'center', paddingVertical: Spacing.xxxl * 2 },
  emptyText: { fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.md },
  emptyBtn: { marginTop: Spacing.md, backgroundColor: Colors.textPrimary, borderRadius: Radius.md, paddingHorizontal: 16, paddingVertical: 8 },
  emptyBtnText: { color: Colors.bgPrimary, fontSize: FontSize.sm, fontWeight: '500' },

  // Modal
  modal: { flex: 1, backgroundColor: Colors.bgPrimary },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary },
  modalCancel: { fontSize: FontSize.base, color: Colors.info },
  modalBody: { padding: Spacing.lg },

  // Form
  formField: { marginBottom: Spacing.lg },
  formLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 6 },
  formInput: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  chipRow: { flexDirection: 'row', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.round, backgroundColor: Colors.bgSecondary, borderWidth: 0.5, borderColor: Colors.borderLight },
  chipActive: { backgroundColor: Colors.textPrimary, borderColor: Colors.textPrimary },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  chipTextActive: { color: Colors.bgPrimary, fontWeight: '500' },
  saveBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.sm },
  saveBtnText: { color: Colors.bgPrimary, fontSize: FontSize.base, fontWeight: '600' },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: Colors.danger, borderRadius: Radius.md, padding: Spacing.md, marginTop: Spacing.md },
  deleteBtnText: { color: Colors.danger, fontSize: FontSize.base, fontWeight: '500' },

  // Store selection
  storeLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  selectAllText: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '500' },
  storeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  storeChip: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: Radius.md, backgroundColor: Colors.bgSecondary,
    borderWidth: 1, borderColor: Colors.borderLight,
    minWidth: 120,
  },
  storeChipActive: { backgroundColor: Colors.successBg, borderColor: Colors.success },
  storeChipCheck: {
    width: 18, height: 18, borderRadius: 4,
    borderWidth: 1.5, borderColor: Colors.borderMedium,
    alignItems: 'center', justifyContent: 'center',
  },
  storeChipCheckActive: { backgroundColor: Colors.success, borderColor: Colors.success },
  storeChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  storeChipTextActive: { color: Colors.textPrimary },
  storeHint: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 6 },
  dupWarning: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.sm },
  dupWarningText: { fontSize: FontSize.sm, fontWeight: '500' },

  // Bulk mode
  bulkCheck: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.sm },
  bulkToolbar: { flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderBottomWidth: 0.5 },
  bulkBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, borderRadius: Radius.md },
  bulkBtnText: { fontSize: FontSize.xs, fontWeight: '500' },
  chipRow: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: Radius.md, marginBottom: 6, borderWidth: 0.5 },
  miniChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: Radius.round, borderWidth: 0.5 },
  miniChipText: { fontSize: 10, fontWeight: '500' },
  priceSummary: { borderWidth: 0.5, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md },
  priceSummaryText: { fontSize: FontSize.xs },
  priceSummaryBold: { fontSize: FontSize.sm, fontWeight: '600', marginTop: 2 },

  // Confirmation modal
  confirmOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: Spacing.xl },
  confirmBox: { width: '100%', maxWidth: 360, borderRadius: Radius.xl, padding: Spacing.xl, borderWidth: 0.5 },
  confirmTitle: { fontSize: FontSize.lg, fontWeight: '600', marginBottom: Spacing.sm },
  confirmMessage: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.xl },
  confirmBtnRow: { flexDirection: 'row', gap: Spacing.sm },
  confirmBtn: { flex: 1, paddingVertical: Spacing.md, borderRadius: Radius.md, alignItems: 'center' },
  confirmBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
});

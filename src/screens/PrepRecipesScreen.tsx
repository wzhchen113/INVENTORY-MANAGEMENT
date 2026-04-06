// src/screens/PrepRecipesScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Modal, ScrollView,
  TextInput, StyleSheet, Alert,
} from 'react-native';
import { useStore } from '../store/useStore';
import { Colors, Spacing, Radius, FontSize, Shadow } from '../theme/colors';
import { PrepRecipe, PrepRecipeIngredient } from '../types';
import IngredientEditor from '../components/IngredientEditor';
import { WebScrollView } from '../components/WebScrollView';

const PREP_CATEGORIES = ['Marinades', 'Sauces', 'Bases', 'Seasonings', 'Prep'];

export default function PrepRecipesScreen() {
  const {
    prepRecipes, inventory, currentUser,
    addPrepRecipe, updatePrepRecipe, deletePrepRecipe,
    getPrepRecipeCost, getPrepRecipeCostPerUnit,
  } = useStore();
  const isAdmin = currentUser?.role === 'admin';

  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Marinades');
  const [yieldQty, setYieldQty] = useState('');
  const [yieldUnit, setYieldUnit] = useState('');
  const [notes, setNotes] = useState('');
  const [formIngredients, setFormIngredients] = useState<PrepRecipeIngredient[]>([]);

  const filtered = prepRecipes.filter((pr) => {
    const matchCat = !filter || pr.category === filter;
    const matchSearch = !search || pr.name.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const openNew = () => {
    setEditingId(null);
    setName('');
    setCategory('Marinades');
    setYieldQty('');
    setYieldUnit('');
    setNotes('');
    setFormIngredients([]);
    setShowModal(true);
  };

  const openEdit = (pr: PrepRecipe) => {
    setEditingId(pr.id);
    setName(pr.name);
    setCategory(pr.category);
    setYieldQty(pr.yieldQuantity.toString());
    setYieldUnit(pr.yieldUnit);
    setNotes(pr.notes);
    setFormIngredients([...pr.ingredients]);
    setShowModal(true);
  };

  const handleSave = () => {
    if (!name.trim()) { Alert.alert('Error', 'Name required'); return; }
    if (!yieldQty || parseFloat(yieldQty) <= 0) { Alert.alert('Error', 'Yield quantity required'); return; }
    if (!yieldUnit.trim()) { Alert.alert('Error', 'Yield unit required'); return; }

    const data = {
      name: name.trim(),
      category,
      yieldQuantity: parseFloat(yieldQty),
      yieldUnit: yieldUnit.trim(),
      notes: notes.trim(),
      ingredients: formIngredients,
      storeId: 's1',
      createdBy: currentUser?.name || 'Admin',
      createdAt: new Date().toLocaleDateString(),
    };

    if (editingId) {
      updatePrepRecipe(editingId, data);
    } else {
      addPrepRecipe(data);
    }
    setShowModal(false);
  };

  const handleDelete = (pr: PrepRecipe) => {
    Alert.alert('Delete prep recipe', `Delete "${pr.name}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deletePrepRecipe(pr.id) },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bgTertiary }}>
      {/* Info bar */}
      <View style={styles.infoBar}>
        <Text style={styles.infoText}>
          Prep recipes define intermediate preparations (marinades, sauces, bases) with ingredient portions and costs. These can be referenced in menu item recipes.
        </Text>
      </View>

      {/* Search + filter */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search prep recipes..."
          placeholderTextColor={Colors.textTertiary}
          value={search}
          onChangeText={setSearch}
        />
      </View>
      <View style={styles.filterWrapper}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          <TouchableOpacity
            style={[styles.filterChip, !filter && styles.filterChipActive]}
            onPress={() => setFilter('')}
          >
            <Text style={[styles.filterText, !filter && styles.filterTextActive]}>All</Text>
          </TouchableOpacity>
          {PREP_CATEGORIES.map((c) => (
            <TouchableOpacity
              key={c}
              style={[styles.filterChip, filter === c && styles.filterChipActive]}
              onPress={() => setFilter(filter === c ? '' : c)}
            >
              <Text style={[styles.filterText, filter === c && styles.filterTextActive]}>{c}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* List */}
      <WebScrollView id="prep-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        {isAdmin && (
          <TouchableOpacity style={styles.addRow} onPress={openNew}>
            <Text style={styles.addRowText}>+ New prep recipe</Text>
          </TouchableOpacity>
        )}
        {filtered.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No prep recipes yet</Text>
          </View>
        ) : (
          filtered.map((pr) => {
            const batchCost = getPrepRecipeCost(pr.id);
            const costPerUnit = getPrepRecipeCostPerUnit(pr.id);
            return (
              <View key={pr.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardName}>{pr.name}</Text>
                    <Text style={styles.cardCategory}>{pr.category}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <View style={styles.yieldBadge}>
                      <Text style={styles.yieldBadgeText}>
                        Yields {pr.yieldQuantity} {pr.yieldUnit}
                      </Text>
                    </View>
                  </View>
                </View>
                <View style={styles.ingList}>
                  {pr.ingredients.map((ing, idx) => (
                    <View key={idx} style={styles.ingRow}>
                      <Text style={styles.ingName}>{ing.itemName}</Text>
                      <Text style={styles.ingQty}>{ing.quantity} {ing.unit}</Text>
                    </View>
                  ))}
                  {pr.ingredients.length === 0 && (
                    <Text style={styles.noIng}>No ingredients added yet</Text>
                  )}
                </View>
                <View style={styles.costRow}>
                  <View style={styles.costItem}>
                    <Text style={styles.costLabel}>Batch cost</Text>
                    <Text style={styles.costValue}>${batchCost.toFixed(2)}</Text>
                  </View>
                  <View style={styles.costItem}>
                    <Text style={styles.costLabel}>Cost per {pr.yieldUnit}</Text>
                    <Text style={styles.costValue}>${costPerUnit.toFixed(2)}</Text>
                  </View>
                </View>
                {pr.notes ? <Text style={styles.notes}>{pr.notes}</Text> : null}
                {isAdmin && (
                  <View style={styles.actions}>
                    <TouchableOpacity style={styles.editBtn} onPress={() => openEdit(pr)}>
                      <Text style={styles.editBtnText}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(pr)}>
                      <Text style={styles.deleteBtnText}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })
        )}
      </WebScrollView>

      {/* Add/Edit Modal */}
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{editingId ? 'Edit prep recipe' : 'New prep recipe'}</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}>
              <Text style={styles.modalClose}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            <Text style={styles.formLabel}>Recipe name</Text>
            <TextInput
              style={styles.formInput}
              value={name}
              onChangeText={setName}
              placeholder="e.g. 40lb Marinated Chicken"
              placeholderTextColor={Colors.textTertiary}
            />

            <Text style={styles.formLabel}>Category</Text>
            <View style={styles.catRow}>
              {PREP_CATEGORIES.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[styles.catPill, category === c && styles.catPillActive]}
                  onPress={() => setCategory(c)}
                >
                  <Text style={[styles.catPillText, category === c && { color: Colors.white }]}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.yieldRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.formLabel}>Yield quantity</Text>
                <TextInput
                  style={styles.formInput}
                  value={yieldQty}
                  onChangeText={setYieldQty}
                  keyboardType="decimal-pad"
                  placeholder="40"
                  placeholderTextColor={Colors.textTertiary}
                />
              </View>
              <View style={{ width: Spacing.sm }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.formLabel}>Yield unit</Text>
                <TextInput
                  style={styles.formInput}
                  value={yieldUnit}
                  onChangeText={setYieldUnit}
                  placeholder="lb"
                  placeholderTextColor={Colors.textTertiary}
                />
              </View>
            </View>

            <Text style={styles.formLabel}>Notes</Text>
            <TextInput
              style={[styles.formInput, { height: 60, textAlignVertical: 'top' }]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Optional notes..."
              placeholderTextColor={Colors.textTertiary}
              multiline
            />

            <Text style={[styles.formLabel, { marginTop: Spacing.lg }]}>Ingredients</Text>
            <IngredientEditor
              ingredients={formIngredients}
              onIngredientsChange={setFormIngredients}
              availableItems={inventory}
            />

            <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
              <Text style={styles.saveBtnText}>{editingId ? 'Update prep recipe' : 'Save prep recipe'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  infoBar: { backgroundColor: Colors.infoBg, margin: Spacing.lg, marginBottom: 0, borderRadius: Radius.md, padding: Spacing.md },
  infoText: { fontSize: FontSize.xs, color: Colors.info, lineHeight: 17 },
  searchRow: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md },
  searchInput: {
    backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, padding: Spacing.md,
    fontSize: FontSize.base, color: Colors.textPrimary, borderWidth: 0.5, borderColor: Colors.borderLight,
  },
  filterWrapper: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
  filterRow: { flexDirection: 'row', alignItems: 'center' },
  filterChip: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 5, marginRight: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  filterChipActive: { backgroundColor: Colors.textPrimary },
  filterText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  filterTextActive: { color: Colors.white, fontWeight: '500' },
  addRow: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: Colors.borderLight, alignItems: 'center', borderStyle: 'dashed' },
  addRowText: { fontSize: FontSize.sm, color: Colors.info, fontWeight: '500' },
  emptyState: { alignItems: 'center', paddingVertical: Spacing.xxxl },
  emptyText: { fontSize: FontSize.sm, color: Colors.textTertiary },
  card: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight, ...Shadow.sm },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: Spacing.sm },
  cardName: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  cardCategory: { fontSize: FontSize.xs, color: Colors.textSecondary },
  yieldBadge: { backgroundColor: Colors.successBg, borderRadius: Radius.round, paddingHorizontal: 8, paddingVertical: 3 },
  yieldBadgeText: { fontSize: 9, fontWeight: '500', color: Colors.success },
  ingList: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, padding: Spacing.sm, marginBottom: Spacing.sm },
  ingRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  ingName: { fontSize: FontSize.xs, color: Colors.textPrimary },
  ingQty: { fontSize: FontSize.xs, color: Colors.textSecondary },
  noIng: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', paddingVertical: Spacing.sm },
  costRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.sm },
  costItem: { flex: 1, backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, padding: Spacing.sm },
  costLabel: { fontSize: 9, color: Colors.textTertiary },
  costValue: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textPrimary },
  notes: { fontSize: FontSize.xs, color: Colors.textSecondary, fontStyle: 'italic', marginBottom: Spacing.sm },
  actions: { flexDirection: 'row', gap: Spacing.sm },
  editBtn: { flex: 1, borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: 6, alignItems: 'center' },
  editBtnText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  deleteBtn: { borderWidth: 0.5, borderColor: Colors.dangerBg, borderRadius: Radius.md, padding: 6, paddingHorizontal: Spacing.md, alignItems: 'center', backgroundColor: Colors.dangerBg },
  deleteBtnText: { fontSize: FontSize.xs, color: Colors.danger },
  // Modal
  modal: { flex: 1, backgroundColor: Colors.bgPrimary },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600' },
  modalClose: { color: Colors.info, fontSize: FontSize.base },
  formLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 5, marginTop: Spacing.sm },
  formInput: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  catRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  catPill: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  catPillActive: { backgroundColor: Colors.textPrimary },
  catPillText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  yieldRow: { flexDirection: 'row' },
  saveBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.xl, marginBottom: Spacing.xxxl },
  saveBtnText: { color: Colors.white, fontSize: FontSize.base, fontWeight: '600' },
});

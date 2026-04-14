// src/screens/AdminScreens.tsx
// Contains: RecipesScreen, VendorsScreen,
//           RestockScreen, AuditLogScreen, ReportsScreen, UsersScreen

import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  FlatList, TextInput, Modal, Alert, Platform,
} from 'react-native';
import { useStore } from '../store/useStore';
import { numericFilter, toCSV, downloadCSV, numFirstSort } from '../utils';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { Card, CardHeader, Badge, WhoChip, KpiCard, EmptyState } from '../components';
import IngredientEditor from '../components/IngredientEditor';
import DatePicker from '../components/DatePicker';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { Recipe, Vendor, RecipeIngredient, RecipePrepItem } from '../types';
import { calculateWeeklyUsageTrend } from '../utils/usageCalculations';

// ─── RECIPES ────────────────────────────────────────────────────────────────
export function RecipesScreen() {
  const C = useColors();
  const {
    currentUser, currentStore, stores,
    recipes, recipeCategories, inventory, prepRecipes,
    getRecipeCost, getRecipeFoodCostPct, getIngredientLineCost,
    addRecipe, updateRecipe, deleteRecipe,
    addRecipeCategory, updateRecipeCategory, deleteRecipeCategory,
  } = useStore();
  const isAdmin = currentUser?.role === 'admin';

  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState<Recipe | null>(null);
  const [menuItem, setMenuItem] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [category, setCategory] = useState(recipeCategories[0] || 'Mains');
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);

  // Ingredient editing state (unified in main modal)
  const [editIngredients, setEditIngredients] = useState<RecipeIngredient[]>([]);
  const [editPrepItems, setEditPrepItems] = useState<RecipePrepItem[]>([]);

  const [dupWarning, setDupWarning] = useState('');
  const [catFilter, setCatFilter] = useState('');

  // Category management modal state
  const [showCatModal, setShowCatModal] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [editingCat, setEditingCat] = useState<string | null>(null);
  const [editingCatName, setEditingCatName] = useState('');
  const [catWarning, setCatWarning] = useState('');

  // Show recipes for the currently selected store, filtered by category
  const storeRecipes = currentStore.id === '__all__' ? recipes : recipes.filter((r) => r.storeId === currentStore.id);
  const filteredRecipes = (catFilter ? storeRecipes.filter((r) => r.category === catFilter) : storeRecipes)
    .sort((a, b) => numFirstSort(a.menuItem, b.menuItem));

  // Map menu item names → store IDs for multi-store labels
  const recipeStoreMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const r of recipes) {
      const key = r.menuItem.toLowerCase();
      if (!map[key]) map[key] = [];
      if (!map[key].includes(r.storeId)) map[key].push(r.storeId);
    }
    return map;
  }, [recipes]);

  // Deduplicate for "All Stores" view
  const displayRecipes = useMemo(() => {
    if (currentStore.id !== '__all__') return filteredRecipes;
    const seen = new Set<string>();
    return filteredRecipes.filter((r) => {
      const key = r.menuItem.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [filteredRecipes, currentStore.id]);

  // Compute category counts for filter chips
  const categoryCounts = recipeCategories.map((cat) => ({
    cat,
    count: storeRecipes.filter((r) => r.category === cat).length,
  })).filter((c) => c.count > 0);

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
    setMenuItem('');
    setSellPrice('');
    setCategory(recipeCategories[0] || 'Mains');
    setSelectedStoreIds(stores.map((s) => s.id));
    setEditIngredients([]);
    setEditPrepItems([]);
    setShowModal(true);
  };

  const openEdit = (recipe: Recipe) => {
    setEditItem(recipe);
    setDupWarning('');
    setMenuItem(recipe.menuItem);
    setSellPrice(String(recipe.sellPrice));
    setCategory(recipe.category);
    setEditIngredients([...recipe.ingredients]);
    setEditPrepItems([...(recipe.prepItems || [])]);
    const storesWithRecipe = recipes
      .filter((r) => r.menuItem.toLowerCase() === recipe.menuItem.toLowerCase())
      .map((r) => r.storeId);
    setSelectedStoreIds([...new Set(storesWithRecipe)]);
    setShowModal(true);
  };

  const handleSave = () => {
    if (!menuItem.trim()) { Alert.alert('Error', 'Recipe name required'); return; }
    if (selectedStoreIds.length === 0) {
      if (Platform.OS === 'web') alert('Select at least one store');
      else Alert.alert('Error', 'Select at least one store');
      return;
    }

    // Check for duplicate names per selected store
    const trimmedName = menuItem.trim().toLowerCase();
    const duplicateStoreNames: string[] = [];
    for (const storeId of selectedStoreIds) {
      const exists = recipes.some(
        (r) =>
          r.storeId === storeId &&
          r.menuItem.toLowerCase() === trimmedName &&
          (!editItem || r.menuItem.toLowerCase() !== editItem.menuItem.toLowerCase())
      );
      if (exists) {
        const store = stores.find((s) => s.id === storeId);
        if (store) duplicateStoreNames.push(store.name);
      }
    }

    if (duplicateStoreNames.length > 0) {
      setDupWarning(`A recipe named "${menuItem.trim()}" already exists in: ${duplicateStoreNames.join(', ')}.`);
      return;
    }
    setDupWarning('');

    const price = parseFloat(sellPrice) || 0;

    if (editItem) {
      // Find all existing copies across stores
      const existingRecipes = recipes.filter(
        (r) => r.menuItem.toLowerCase() === editItem.menuItem.toLowerCase()
      );
      const existingStoreIds = existingRecipes.map((r) => r.storeId);

      // Update existing copies in selected stores (metadata + translated ingredients)
      existingRecipes.forEach((r) => {
        if (selectedStoreIds.includes(r.storeId)) {
          const { ingredients, prepItems } = translateForStore(editIngredients, editPrepItems, r.storeId);
          updateRecipe(r.id, {
            menuItem: menuItem.trim(), category, sellPrice: price,
            ingredients, prepItems,
          });
        }
      });

      // Delete from deselected stores
      existingRecipes.forEach((r) => {
        if (!selectedStoreIds.includes(r.storeId)) deleteRecipe(r.id);
      });

      // Add to newly selected stores
      const newStoreIds = selectedStoreIds.filter((sid) => !existingStoreIds.includes(sid));
      for (const storeId of newStoreIds) {
        const { ingredients, prepItems } = translateForStore(editIngredients, editPrepItems, storeId);
        addRecipe({ menuItem: menuItem.trim(), category, sellPrice: price, ingredients, prepItems, storeId });
      }
    } else {
      // Create: add to all selected stores with translated ingredients
      for (const storeId of selectedStoreIds) {
        const { ingredients, prepItems } = translateForStore(editIngredients, editPrepItems, storeId);
        addRecipe({ menuItem: menuItem.trim(), category, sellPrice: price, ingredients, prepItems, storeId });
      }
    }
    setShowModal(false);
  };

  const handleDeleteEntirely = () => {
    if (!editItem) return;
    const allCopies = recipes.filter(
      (r) => r.menuItem.toLowerCase() === editItem.menuItem.toLowerCase()
    );
    const doDelete = () => {
      allCopies.forEach((r) => deleteRecipe(r.id));
      setShowModal(false);
    };
    if (Platform.OS === 'web') {
      if (confirm(`Delete "${editItem.menuItem}" from all stores? This cannot be undone.`)) doDelete();
    } else {
      Alert.alert('Delete recipe', `Delete "${editItem.menuItem}" from all stores? This cannot be undone.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  // Translate ingredient/prep IDs from source store to target store (match by name)
  const translateForStore = (ings: RecipeIngredient[], preps: RecipePrepItem[], targetStoreId: string) => {
    const translatedIngs = ings.map((ing) => {
      const targetItem = inventory.find(
        (i) => i.storeId === targetStoreId && i.name.toLowerCase() === (ing.itemName || '').toLowerCase()
      );
      return targetItem ? { ...ing, itemId: targetItem.id } : ing;
    }).filter((ing) => {
      // Only include if the ingredient exists in target store
      return inventory.some(
        (i) => i.storeId === targetStoreId && i.name.toLowerCase() === (ing.itemName || '').toLowerCase()
      );
    });
    const translatedPreps = preps.map((p) => {
      const targetPrep = prepRecipes.find(
        (pr) => pr.storeId === targetStoreId && pr.name.toLowerCase() === p.prepRecipeName.toLowerCase()
      );
      return targetPrep ? { ...p, prepRecipeId: targetPrep.id } : p;
    }).filter((p) => {
      return prepRecipes.some(
        (pr) => pr.storeId === targetStoreId && pr.name.toLowerCase() === p.prepRecipeName.toLowerCase()
      );
    });
    return { ingredients: translatedIngs, prepItems: translatedPreps };
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <View style={[styles.infoBar, { backgroundColor: C.infoBg }]}>
        <Text style={[styles.infoText, { color: C.info }]}>Map each menu item to exact ingredient quantities. POS sales will auto-deduct inventory using these ratios.</Text>
      </View>
      {/* Category filter */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.sm }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} style={{ flex: 1 }}>
          <TouchableOpacity
            style={[styles.filterChip, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, !catFilter && { backgroundColor: C.textPrimary }]}
            onPress={() => setCatFilter('')}
          >
            <Text style={[styles.filterChipText, { color: C.textSecondary }, !catFilter && { color: C.bgPrimary, fontWeight: '500' }]}>
              All ({storeRecipes.length})
            </Text>
          </TouchableOpacity>
          {categoryCounts.map(({ cat, count }) => (
            <TouchableOpacity
              key={cat}
              style={[styles.filterChip, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, catFilter === cat && { backgroundColor: C.textPrimary }]}
              onPress={() => setCatFilter(catFilter === cat ? '' : cat)}
            >
              <Text style={[styles.filterChipText, { color: C.textSecondary }, catFilter === cat && { color: C.bgPrimary, fontWeight: '500' }]}>
                {cat} ({count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        {isAdmin && (
          <TouchableOpacity onPress={() => { setNewCatName(''); setEditingCat(null); setCatWarning(''); setShowCatModal(true); }}>
            <Ionicons name="settings-outline" size={18} color={C.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      <WebScrollView id="recipes-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        <View style={{ flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md }}>
          <TouchableOpacity style={[styles.addRow, { backgroundColor: C.bgPrimary, borderColor: C.borderLight, flex: 1, marginBottom: 0 }]} onPress={openAdd}>
            <Text style={[styles.addRowText, { color: C.info }]}>+ New recipe / menu item</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ backgroundColor: C.bgPrimary, borderRadius: Radius.md, borderWidth: 0.5, borderColor: C.borderLight, width: 40, alignItems: 'center', justifyContent: 'center' }}
            onPress={() => {
              const rows = storeRecipes.map((r) => ({
                'Menu Item': r.menuItem, Category: r.category, 'Sell Price': r.sellPrice.toFixed(2),
                'Food Cost': getRecipeCost(r.id).toFixed(2),
                'Food Cost %': getRecipeFoodCostPct(r.id).toFixed(1) + '%',
                Ingredients: r.ingredients.map((i) => `${i.itemName} (${i.quantity} ${i.unit})`).join('; '),
              }));
              const csv = toCSV(rows, ['Menu Item','Category','Sell Price','Food Cost','Food Cost %','Ingredients']);
              downloadCSV(`recipes_${currentStore.name}_${new Date().toISOString().split('T')[0]}.csv`, csv);
            }}
          >
            <Ionicons name="download-outline" size={18} color={C.textSecondary} />
          </TouchableOpacity>
        </View>
        {displayRecipes.map((recipe) => {
          const cost = getRecipeCost(recipe.id);
          const fcPct = getRecipeFoodCostPct(recipe.id);
          const fcOk = fcPct < 35;
          const preps = recipe.prepItems || [];
          const rStoreIds = recipeStoreMap[recipe.menuItem.toLowerCase()] || [recipe.storeId];
          const storeLabel = rStoreIds.length >= stores.length
            ? 'All Stores'
            : rStoreIds.map((sid) => stores.find((s) => s.id === sid)?.name).filter(Boolean).join(', ');
          return (
            <View key={recipe.id} style={[styles.recipeCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
              <View style={styles.recipeTop}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.recipeName, { color: C.textPrimary }]}>{recipe.menuItem}</Text>
                  <Text style={[styles.recipeCat, { color: C.textSecondary }]}>{recipe.category} · {storeLabel}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[styles.fcPct, { color: fcOk ? C.success : C.danger }]}>
                    {fcPct.toFixed(1)}% food cost
                  </Text>
                  <Text style={[styles.recipePrices, { color: C.textSecondary }]}>
                    ${cost.toFixed(2)} cost · ${recipe.sellPrice.toFixed(2)} sell
                  </Text>
                </View>
              </View>
              <View style={[styles.ingList, { backgroundColor: C.bgSecondary }]}>
                {recipe.ingredients.map((ing, idx) => {
                  const ingCost = getIngredientLineCost(ing);
                  return (
                    <View key={idx} style={styles.ingRow}>
                      <Text style={[styles.ingName, { color: C.textPrimary, flex: 1 }]} numberOfLines={1}>{ing.itemName}</Text>
                      <View style={{ alignItems: 'flex-end', marginLeft: 8 }}>
                        <Text style={[styles.ingQty, { color: C.textSecondary }]}>{ing.quantity} {ing.unit}</Text>
                        {ingCost > 0 && <Text style={{ fontSize: 10, color: C.textTertiary }}>${ingCost.toFixed(2)}</Text>}
                      </View>
                    </View>
                  );
                })}
                {preps.map((prep, idx) => {
                  const { getConversionFactor, getPrepRecipeCostPerUnit: _ } = require('../utils/unitConversion');
                  const subRecipe = prepRecipes.find((p) => p.id === prep.prepRecipeId);
                  const cpu = useStore.getState().getPrepRecipeCostPerUnit(prep.prepRecipeId);
                  let prepCost = 0;
                  if (subRecipe && cpu > 0) {
                    const f = getConversionFactor(prep.unit, subRecipe.yieldUnit);
                    prepCost = cpu * (f !== null ? prep.quantity * f : prep.quantity);
                  }
                  return (
                    <View key={`prep-${idx}`} style={styles.ingRow}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
                        <View style={[styles.prepTag, { backgroundColor: C.infoBg }]}><Text style={[styles.prepTagText, { color: C.info }]}>Prep</Text></View>
                        <Text style={[styles.ingName, { color: C.textPrimary, flex: 1 }]} numberOfLines={1}>{prep.prepRecipeName}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end', marginLeft: 8 }}>
                        <Text style={[styles.ingQty, { color: C.textSecondary }]}>{prep.quantity} {prep.unit}</Text>
                        {prepCost > 0 && <Text style={{ fontSize: 10, color: C.textTertiary }}>${prepCost.toFixed(2)}</Text>}
                      </View>
                    </View>
                  );
                })}
                {recipe.ingredients.length === 0 && preps.length === 0 && (
                  <Text style={[styles.noIng, { color: C.textTertiary }]}>No ingredients mapped yet — tap Edit to add</Text>
                )}
              </View>
              <TouchableOpacity style={[styles.editRecipeBtn, { borderColor: C.borderMedium }]} onPress={() => openEdit(recipe)}>
                <Text style={[styles.editRecipeBtnText, { color: C.textSecondary }]}>Edit</Text>
              </TouchableOpacity>
            </View>
          );
        })}
        {displayRecipes.length === 0 && (
          <Card>
            <EmptyState message={`No recipes for ${currentStore.name} yet. Tap + to add one.`} />
          </Card>
        )}
      </WebScrollView>

      {/* New / Edit recipe modal */}
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>{editItem ? 'Edit recipe' : 'New recipe'}</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}><Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            {/* Store selection */}
            <View style={styles.formField}>
              <View style={styles.storeLabelRow}>
                <Text style={[styles.formLabel, { color: C.textSecondary, marginBottom: 0 }]}>
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

            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Menu item name</Text>
            <TextInput style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]} value={menuItem} onChangeText={setMenuItem} placeholder="e.g. Grilled Chicken Plate" placeholderTextColor={C.textTertiary} />
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Sell price ($)</Text>
            <TextInput style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]} value={sellPrice} onChangeText={(v) => setSellPrice(numericFilter(v))} keyboardType="decimal-pad" placeholder="14.00" placeholderTextColor={C.textTertiary} />
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Category</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: Spacing.md }}>
              {recipeCategories.map((c) => (
                <TouchableOpacity key={c} style={[styles.catPill, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, category === c && { backgroundColor: C.textPrimary }]} onPress={() => setCategory(c)}>
                  <Text style={[styles.catPillText, { color: C.textSecondary }, category === c && { color: C.bgPrimary }]}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Ingredients & Prep Recipes */}
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Ingredients & Prep Recipes</Text>
            <IngredientEditor
              ingredients={editIngredients}
              onIngredientsChange={setEditIngredients}
              availableItems={inventory}
              prepItems={editPrepItems}
              onPrepItemsChange={setEditPrepItems}
              availablePrepRecipes={prepRecipes}
              showPrepRecipes={true}
            />

            {dupWarning ? (
              <View style={[styles.dupWarning, { backgroundColor: C.warningBg, borderColor: C.warning }]}>
                <Text style={[styles.dupWarningText, { color: C.warning }]}>{dupWarning}</Text>
              </View>
            ) : null}
            <View style={styles.mfRow}>
              <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleSave}>
                <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>
                  {editItem
                    ? `Save to ${selectedStoreIds.length} store${selectedStoreIds.length !== 1 ? 's' : ''}`
                    : selectedStoreIds.length > 1
                      ? `Add to ${selectedStoreIds.length} stores`
                      : 'Save recipe'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Delete button — edit mode only */}
            {editItem && isAdmin && (
              <TouchableOpacity style={[styles.deleteRecipeBtn, { borderColor: C.danger }]} onPress={handleDeleteEntirely}>
                <Ionicons name="trash-outline" size={16} color={C.danger} />
                <Text style={[styles.deleteRecipeBtnText, { color: C.danger }]}>Delete from all stores</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Manage categories modal */}
      <Modal visible={showCatModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Manage categories</Text>
            <TouchableOpacity onPress={() => setShowCatModal(false)}>
              <Text style={[styles.modalClose, { color: C.info }]}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            {/* Add new category */}
            <View style={styles.catAddRow}>
              <TextInput
                style={[styles.formInput, { flex: 1, color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                value={newCatName}
                onChangeText={setNewCatName}
                placeholder="New category name"
                placeholderTextColor={C.textTertiary}
              />
              <TouchableOpacity
                style={[styles.catAddBtn, { backgroundColor: C.textPrimary, opacity: newCatName.trim() ? 1 : 0.4 }]}
                onPress={() => {
                  const name = newCatName.trim();
                  if (!name) return;
                  if (recipeCategories.some((c) => c.toLowerCase() === name.toLowerCase())) {
                    setCatWarning(`Category "${name}" already exists.`);
                    return;
                  }
                  setCatWarning('');
                  addRecipeCategory(name);
                  setNewCatName('');
                }}
                disabled={!newCatName.trim()}
              >
                <Text style={{ color: C.bgPrimary, fontSize: FontSize.sm, fontWeight: '600' }}>Add</Text>
              </TouchableOpacity>
            </View>

            {catWarning ? (
              <View style={[styles.dupWarning, { backgroundColor: C.warningBg, borderColor: C.warning }]}>
                <Text style={[styles.dupWarningText, { color: C.warning }]}>{catWarning}</Text>
              </View>
            ) : null}

            {/* Category list */}
            {recipeCategories.map((cat) => {
              const inUse = recipes.some((r) => r.category === cat);
              const isEditing = editingCat === cat;
              return (
                <View key={cat} style={[styles.catManageRow, { borderBottomColor: C.borderLight }]}>
                  {isEditing ? (
                    <TextInput
                      style={[styles.formInput, { flex: 1, color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                      value={editingCatName}
                      onChangeText={setEditingCatName}
                      autoFocus
                    />
                  ) : (
                    <Text style={[styles.catManageName, { color: C.textPrimary }]}>{cat}</Text>
                  )}
                  {inUse && !isEditing && (
                    <Text style={[styles.catManageCount, { color: C.textTertiary }]}>
                      {recipes.filter((r) => r.category === cat).length} recipe{recipes.filter((r) => r.category === cat).length !== 1 ? 's' : ''}
                    </Text>
                  )}
                  <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
                    {isEditing ? (
                      <>
                        <TouchableOpacity onPress={() => {
                          const name = editingCatName.trim();
                          if (!name) return;
                          if (name !== cat && recipeCategories.some((c) => c.toLowerCase() === name.toLowerCase())) {
                            setCatWarning(`Category "${name}" already exists.`);
                            return;
                          }
                          setCatWarning('');
                          updateRecipeCategory(cat, name);
                          if (catFilter === cat) setCatFilter(name);
                          setEditingCat(null);
                        }}>
                          <Ionicons name="checkmark-circle" size={22} color={C.success} />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => setEditingCat(null)}>
                          <Ionicons name="close-circle" size={22} color={C.textTertiary} />
                        </TouchableOpacity>
                      </>
                    ) : (
                      <>
                        <TouchableOpacity onPress={() => { setEditingCat(cat); setEditingCatName(cat); }}>
                          <Ionicons name="pencil-outline" size={18} color={C.textSecondary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => {
                            if (inUse) {
                              setCatWarning(`Cannot delete "${cat}" — it's used by ${recipes.filter((r) => r.category === cat).length} recipe(s). Reassign them first.`);
                              return;
                            }
                            setCatWarning('');
                            deleteRecipeCategory(cat);
                            if (catFilter === cat) setCatFilter('');
                          }}
                          style={{ opacity: inUse ? 0.3 : 1 }}
                        >
                          <Ionicons name="trash-outline" size={18} color={C.danger} />
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// ─── VENDORS ────────────────────────────────────────────────────────────────
export function VendorsScreen() {
  const C = useColors();
  const { vendors, addVendor, updateVendor, deleteVendor } = useStore();
  const [showModal, setShowModal] = useState(false);
  const [editVendor, setEditVendor] = useState<typeof vendors[0] | null>(null);
  const [dupWarning, setDupWarning] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<typeof vendors[0] | null>(null);
  const [form, setForm] = useState({ name: '', contactName: '', phone: '', email: '', accountNumber: '', leadTimeDays: '2' });

  const openAdd = () => {
    setEditVendor(null);
    setDupWarning('');
    setForm({ name: '', contactName: '', phone: '', email: '', accountNumber: '', leadTimeDays: '2' });
    setShowModal(true);
  };

  const openEdit = (vendor: typeof vendors[0]) => {
    setEditVendor(vendor);
    setDupWarning('');
    setForm({
      name: vendor.name,
      contactName: vendor.contactName || '',
      phone: vendor.phone || '',
      email: vendor.email || '',
      accountNumber: vendor.accountNumber || '',
      leadTimeDays: String(vendor.leadTimeDays || 2),
    });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!form.name.trim()) {
      if (Platform.OS === 'web') alert('Vendor name is required');
      else Alert.alert('Error', 'Vendor name is required');
      return;
    }

    const trimmedName = form.name.trim().toLowerCase();
    const duplicate = vendors.some((v) => v.name.toLowerCase() === trimmedName && (!editVendor || v.id !== editVendor.id));

    if (duplicate) {
      setDupWarning(`A vendor named "${form.name.trim()}" already exists.`);
      return;
    }
    setDupWarning('');

    if (editVendor) {
      updateVendor(editVendor.id, { ...form, leadTimeDays: parseInt(form.leadTimeDays) || 2 });
    } else {
      addVendor({ ...form, leadTimeDays: parseInt(form.leadTimeDays) || 2, deliveryDays: [], categories: [] });
    }
    setShowModal(false);
  };

  const handleDelete = (vendor: typeof vendors[0]) => {
    setConfirmDelete(vendor);
  };

  const doDelete = () => {
    if (confirmDelete) {
      deleteVendor(confirmDelete.id);
      setConfirmDelete(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <WebScrollView id="vendors-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        <TouchableOpacity style={[styles.addRow, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]} onPress={openAdd}>
          <Text style={[styles.addRowText, { color: C.info }]}>+ Add vendor</Text>
        </TouchableOpacity>
        {[...vendors].sort((a, b) => numFirstSort(a.name, b.name)).map((vendor) => (
          <View key={vendor.id} style={[styles.vendorCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            <View style={styles.vendorTop}>
              <View style={[styles.vendorLogo, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                <Text style={[styles.vendorLogoText, { color: C.textSecondary }]}>{vendor.name.slice(0, 2).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.vendorName, { color: C.textPrimary }]}>{vendor.name}</Text>
                <Text style={[styles.vendorContact, { color: C.textSecondary }]}>{vendor.contactName} · {vendor.phone}</Text>
              </View>
              <View style={[styles.leadBadge, { backgroundColor: C.infoBg }]}>
                <Text style={[styles.leadText, { color: C.info }]}>{vendor.leadTimeDays}d lead</Text>
              </View>
            </View>
            <View style={styles.vendorMeta}>
              <Text style={[styles.metaLabel, { color: C.textTertiary }]}>Account</Text>
              <Text style={[styles.metaValue, { color: C.textPrimary }]}>{vendor.accountNumber}</Text>
              <Text style={[styles.metaLabel, { color: C.textTertiary }]}>Categories</Text>
              <Text style={[styles.metaValue, { color: C.textPrimary }]}>{vendor.categories.join(', ') || '—'}</Text>
              <Text style={[styles.metaLabel, { color: C.textTertiary }]}>Last order</Text>
              <Text style={[styles.metaValue, { color: C.textPrimary }]}>{vendor.lastOrderDate || '—'}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm }}>
              <TouchableOpacity style={[styles.editRecipeBtn, { borderColor: C.borderMedium, flex: 1 }]} onPress={() => openEdit(vendor)}>
                <Text style={[styles.editRecipeBtnText, { color: C.textSecondary }]}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.editRecipeBtn, { borderColor: C.danger, flex: 1 }]} onPress={() => handleDelete(vendor)}>
                <Text style={[styles.editRecipeBtnText, { color: C.danger }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </WebScrollView>

      {/* Add/Edit Modal */}
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>{editVendor ? 'Edit vendor' : 'Add vendor'}</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}><Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            {[
              { label: 'Company name', key: 'name' },
              { label: 'Contact name', key: 'contactName' },
              { label: 'Phone', key: 'phone' },
              { label: 'Email', key: 'email' },
              { label: 'Account number', key: 'accountNumber' },
              { label: 'Lead time (days)', key: 'leadTimeDays', keyboard: 'numeric' },
            ].map((f) => (
              <View key={f.key}>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>{f.label}</Text>
                <TextInput style={[styles.formInput, { marginBottom: Spacing.md, color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]} value={(form as any)[f.key]} onChangeText={(v) => setForm((p) => ({ ...p, [f.key]: f.keyboard ? numericFilter(v) : v }))} keyboardType={(f.keyboard as any) || 'default'} placeholderTextColor={C.textTertiary} />
              </View>
            ))}
            {dupWarning ? (
              <View style={[styles.dupWarning, { backgroundColor: C.warningBg, borderColor: C.warning }]}>
                <Text style={[styles.dupWarningText, { color: C.warning }]}>{dupWarning}</Text>
              </View>
            ) : null}
            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleSave}>
              <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>{editVendor ? 'Save changes' : 'Save vendor'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal visible={!!confirmDelete} transparent animationType="fade">
        <View style={styles.confirmOverlay}>
          <View style={[styles.confirmBox, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            <Text style={[styles.confirmTitle, { color: C.textPrimary }]}>Delete vendor</Text>
            <Text style={[styles.confirmMessage, { color: C.textSecondary }]}>
              Delete "{confirmDelete?.name}"? This cannot be undone.
            </Text>
            <View style={styles.confirmBtnRow}>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: C.bgSecondary }]} onPress={() => setConfirmDelete(null)}>
                <Text style={[styles.confirmBtnText, { color: C.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: C.danger }]} onPress={doDelete}>
                <Text style={[styles.confirmBtnText, { color: C.bgPrimary }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── RESTOCK REPORT ─────────────────────────────────────────────────────────
// ─── AUDIT LOG ──────────────────────────────────────────────────────────────
export function AuditLogScreen() {
  const C = useColors();
  const { auditLog } = useStore();
  const [filter, setFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');

  const userColors: Record<string, string> = {
    Admin: C.userAdmin, 'Maria G.': C.userMaria,
    'James T.': C.userJames, 'Ana R.': C.userAna,
  };

  const filtered = auditLog.filter((e) => {
    if (filter && !e.action.includes(filter) && !e.userName.includes(filter)) return false;
    if (dateFilter && !e.timestamp.includes(dateFilter.replace(/-/g, '/'))) return false;
    return true;
  });

  const actionColor = (action: string) => {
    if (action === 'EOD entry') return C.success;
    if (action === 'Waste log') return C.warning;
    if (action === 'POS import' || action === 'PO sent') return C.info;
    if (action === 'Item edit' || action === 'Item added') return '#7F77DD';
    return C.textSecondary;
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm }}>
        <DatePicker value={dateFilter} onChange={setDateFilter} label="Filter by date" placeholder="All dates" />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.filterScroll, { backgroundColor: C.bgPrimary, borderBottomColor: C.borderLight }]}>
        {['', 'EOD entry', 'Waste log', 'Item edit', 'POS import', 'Stock adjusted'].map((f) => (
          <TouchableOpacity key={f || 'all'} style={[styles.filterChip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, filter === f && { backgroundColor: C.textPrimary }]} onPress={() => setFilter(f)}>
            <Text style={[styles.filterText, { color: C.textSecondary }, filter === f && { color: C.bgPrimary }]}>{f || 'All'}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <WebScrollView id="audit-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        {filtered.length === 0 ? (
          <EmptyState message="No audit events" />
        ) : (
          filtered.map((event) => {
            const color = userColors[event.userName] || C.userAdmin;
            return (
              <View key={event.id} style={[styles.auditRow, { borderBottomColor: C.borderLight }]}>
                <View style={[styles.auditDot, { backgroundColor: actionColor(event.action) }]} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <WhoChip name={event.userName} color={color} />
                    <View style={[styles.actionTag, { backgroundColor: actionColor(event.action) + '22' }]}>
                      <Text style={[styles.actionTagText, { color: actionColor(event.action) }]}>{event.action}</Text>
                    </View>
                    <Text style={[styles.auditStore, { color: C.textTertiary }]}>{event.storeName}</Text>
                  </View>
                  <Text style={[styles.auditDetail, { color: C.textPrimary }]}>{event.detail} · {event.itemRef}</Text>
                  <Text style={[styles.auditMeta, { color: C.textTertiary }]}>{event.value} · {event.timestamp}</Text>
                </View>
              </View>
            );
          })
        )}
      </WebScrollView>
    </View>
  );
}

// ─── REPORTS ─────────────────────────────────────────────────────────────────
export function ReportsScreen() {
  const C = useColors();
  const [tab, setTab] = useState<'foodcost' | 'usage' | 'waste'>('foodcost');
  const { recipes, getRecipeCost, getRecipeFoodCostPct, wasteLog, posImports, currentStore } = useStore();

  const totalWaste = wasteLog.reduce((s, e) => s + e.quantity * e.costPerUnit, 0);
  const usageTrend = React.useMemo(
    () => calculateWeeklyUsageTrend(posImports, recipes, currentStore.id, 4),
    [posImports, recipes, currentStore.id]
  );

  return (
    <WebScrollView id="reports-scroll" contentContainerStyle={{ padding: Spacing.lg, backgroundColor: C.bgTertiary }}>
      {/* Tabs */}
      <View style={[styles.tabBar, { backgroundColor: C.bgPrimary, borderBottomColor: C.borderLight }]}>
        {(['foodcost', 'usage', 'waste'] as const).map((t) => (
          <TouchableOpacity key={t} style={[styles.tabItem, tab === t && { borderBottomColor: C.textPrimary }]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, { color: C.textSecondary }, tab === t && { color: C.textPrimary }]}>
              {t === 'foodcost' ? 'Food cost' : t === 'usage' ? 'Usage' : 'Waste'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'foodcost' && (
        <>
          <View style={styles.kpiRow}>
            <KpiCard label="Overall food cost %" value="31.4%" sub="Target 28–35% ✓" variant="success" />
            <View style={{ width: Spacing.sm }} />
            <KpiCard label="COGS this week" value="$2,840" sub="vs $9,040 revenue" />
          </View>
          <Card>
            <CardHeader title="Food cost % by recipe" />
            {recipes.map((r) => {
              const cost = getRecipeCost(r.id);
              const pct = getRecipeFoodCostPct(r.id);
              const ok = pct < 35;
              return (
                <View key={r.id} style={[styles.reportRow, { borderBottomColor: C.borderLight }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.reportName, { color: C.textPrimary }]}>{r.menuItem}</Text>
                    <Text style={[styles.reportSub, { color: C.textSecondary }]}>${cost.toFixed(2)} cost · ${r.sellPrice.toFixed(2)} sell</Text>
                  </View>
                  <Text style={[styles.reportPct, { color: ok ? C.success : C.danger }]}>{pct.toFixed(1)}%</Text>
                </View>
              );
            })}
          </Card>
          <Card>
            <CardHeader title="By category" />
            {[
              { cat: 'Protein', pct: 32.9, ok: true },
              { cat: 'Seafood', pct: 38.0, ok: false },
              { cat: 'Produce', pct: 25.0, ok: true },
              { cat: 'Dairy', pct: 28.0, ok: true },
              { cat: 'Dry goods', pct: 29.7, ok: true },
            ].map((c) => (
              <View key={c.cat} style={styles.catFcRow}>
                <Text style={[styles.catFcName, { color: C.textPrimary }]}>{c.cat}</Text>
                <View style={[styles.fcBar, { backgroundColor: C.borderLight }]}>
                  <View style={[styles.fcFill, { width: `${Math.min(100, c.pct / 50 * 100)}%`, backgroundColor: c.ok ? C.success : C.danger }]} />
                </View>
                <Text style={[styles.fcPctVal, { color: c.ok ? C.success : C.danger }]}>{c.pct}%</Text>
              </View>
            ))}
          </Card>
        </>
      )}

      {tab === 'usage' && (
        <Card>
          <CardHeader title={`Weekly ingredient usage — ${currentStore.name}`} />
          {usageTrend.length === 0 ? (
            <EmptyState message="No POS data imported yet. Import sales from the POS screen to see usage trends." />
          ) : (
            usageTrend.map((u) => {
              const maxVal = Math.max(...u.weeklyAmounts, 1);
              return (
                <View key={u.itemId} style={[styles.usageRow, { borderBottomColor: C.borderLight }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.usageName, { color: C.textPrimary }]}>{u.itemName}</Text>
                    <Text style={[styles.usageSub, { color: C.textSecondary }]}>Avg: {u.average} {u.unit}/week</Text>
                  </View>
                  <View style={styles.usageWeeks}>
                    {u.weeklyAmounts.map((v, i) => (
                      <View key={i} style={styles.weekCol}>
                        <View style={[styles.weekBar, { height: Math.max(4, (v / maxVal) * 50), backgroundColor: i === u.weeklyAmounts.length - 1 ? C.info : C.borderMedium }]} />
                        <Text style={[styles.weekLabel, { color: C.textTertiary }]}>W{i + 1}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              );
            })
          )}
        </Card>
      )}

      {tab === 'waste' && (
        <>
          <View style={styles.kpiRow}>
            <KpiCard label="Total waste" value={`$${totalWaste.toFixed(0)}`} sub="This week" variant="warning" />
            <View style={{ width: Spacing.sm }} />
            <KpiCard label="As % of revenue" value="1.6%" sub="Industry avg 2–4%" variant="success" />
          </View>
          <Card>
            <CardHeader title="Waste entries" />
            {wasteLog.map((e) => (
              <View key={e.id} style={[styles.wasteReportRow, { borderBottomColor: C.borderLight }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.reportName, { color: C.textPrimary }]}>{e.itemName}</Text>
                  <Text style={[styles.reportSub, { color: C.textSecondary }]}>{e.reason} · {e.quantity} {e.unit}</Text>
                </View>
                <Text style={[styles.reportPct, { color: C.warning }]}>${(e.quantity * e.costPerUnit).toFixed(2)}</Text>
              </View>
            ))}
          </Card>
        </>
      )}
    </WebScrollView>
  );
}

// ─── USERS ──────────────────────────────────────────────────────────────────
export function UsersScreen() {
  const C = useColors();
  const { users, stores, inventory, currentUser, inviteUser, removeUser, addStore, updateStore, addNotification, logout } = useStore();
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [inviteWarning, setInviteWarning] = useState('');
  const [form, setForm] = useState({ name: '', email: '', role: 'user' as 'admin' | 'user', storeIds: ['s1'] });
  const [cloudUsers, setCloudUsers] = useState<typeof users | null>(null);

  // Store management (master only)
  const [showStoreModal, setShowStoreModal] = useState(false);
  const [editStoreTarget, setEditStoreTarget] = useState<typeof stores[0] | null>(null);
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreAddress, setNewStoreAddress] = useState('');
  const [deleteStoreTarget, setDeleteStoreTarget] = useState<typeof stores[0] | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');

  const openAddStore = () => {
    setEditStoreTarget(null);
    setNewStoreName('');
    setNewStoreAddress('');
    setShowStoreModal(true);
  };

  const openEditStore = (store: typeof stores[0]) => {
    setEditStoreTarget(store);
    setNewStoreName(store.name);
    setNewStoreAddress(store.address || '');
    setShowStoreModal(true);
  };

  const handleSaveStore = () => {
    if (!newStoreName.trim()) return;
    if (editStoreTarget) {
      updateStore(editStoreTarget.id, { name: newStoreName.trim(), address: newStoreAddress.trim() });
      Toast.show({ type: 'success', text1: 'Store updated', text2: `${newStoreName.trim()} has been saved.`, visibilityTime: 3000 });
    } else {
      addStore({ name: newStoreName.trim(), address: newStoreAddress.trim(), status: 'active' });
      Toast.show({ type: 'success', text1: 'Store added', text2: `${newStoreName.trim()} has been created.`, visibilityTime: 3000 });
    }
    setShowStoreModal(false);
  };

  const handleDeleteStore = async () => {
    if (!deleteStoreTarget || deleteConfirmName !== deleteStoreTarget.name) return;
    try {
      const dbModule = await import('../lib/db');
      await dbModule.deleteStore(deleteStoreTarget.id);
    } catch {}
    const { useStore: getStoreRef } = require('../store/useStore');
    const state = getStoreRef.getState();
    getStoreRef.setState({
      stores: state.stores.filter((s: any) => s.id !== deleteStoreTarget.id),
      inventory: state.inventory.filter((i: any) => i.storeId !== deleteStoreTarget.id),
      recipes: state.recipes.filter((r: any) => r.storeId !== deleteStoreTarget.id),
    });
    const remaining = stores.filter((s) => s.id !== deleteStoreTarget.id);
    if (remaining.length > 0) state.setCurrentStore(remaining[0]);
    setDeleteStoreTarget(null);
    setDeleteConfirmName('');
    Toast.show({ type: 'success', text1: 'Store deleted', text2: `${deleteStoreTarget.name} has been removed.`, visibilityTime: 3000 });
  };

  // Fetch users from Supabase on mount
  useEffect(() => {
    (async () => {
      const { fetchAllUsers } = await import('../lib/auth');
      const fetched = await fetchAllUsers();
      setCloudUsers(fetched);
    })();
  }, []);

  // Re-fetch after inviting
  const refreshCloudUsers = async () => {
    const { fetchAllUsers } = await import('../lib/auth');
    const fetched = await fetchAllUsers();
    setCloudUsers(fetched);
  };

  // Cloud data is the source of truth. Show nothing until loaded (no seed flash).
  const isMaster = currentUser?.role === 'master';
  const loadingUsers = cloudUsers === null;
  const rawUsers = cloudUsers || [];
  const allUsers = isMaster ? rawUsers : rawUsers.filter((u) => u.role !== 'master');

  const handleInvite = async () => {
    if (!form.name || !form.email) { Alert.alert('Error', 'Name and email required'); return; }
    if (form.storeIds.length === 0) { Alert.alert('Error', 'Select at least one store'); return; }

    setLoading(true);
    setInviteWarning('');

    // Save to local state
    inviteUser({ ...form, stores: form.storeIds, status: 'pending', initials: form.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(), color: C.userAdmin });

    // Save to Supabase
    const storeNames = form.storeIds.map((sid) => stores.find((s) => s.id === sid)?.name).filter(Boolean).join(', ');
    const { inviteUser: supabaseInvite } = await import('../lib/auth');
    const result = await supabaseInvite(form.email.trim(), form.name.trim(), form.role, form.storeIds, storeNames);

    setLoading(false);

    if (result.error) {
      setInviteWarning(`Invitation saved locally. Cloud: ${result.error}`);
    } else {
      setShowModal(false);
      setForm({ name: '', email: '', role: 'user', storeIds: ['s1'] });
      addNotification(`Invited ${form.name.trim()} (${form.email.trim()}) to ${storeNames}`);
      Toast.show({
        type: 'success',
        text1: 'Invitation sent!',
        text2: `${form.name.trim()} will receive an email to register.`,
        visibilityTime: 4000,
      });
      refreshCloudUsers();
    }
  };

  const handleDeleteUser = (user: typeof users[0]) => {
    const isSelf = user.id === currentUser?.id;
    const isMaster = currentUser?.role === 'master';

    // Master cannot self-delete
    if (isMaster && isSelf) {
      if (Platform.OS === 'web') alert('Master account cannot be deleted.');
      else Alert.alert('Cannot delete', 'Master account cannot be deleted.');
      return;
    }

    // Admin cannot delete other admins (but master can)
    if (!isMaster && user.role === 'admin' && !isSelf) {
      if (Platform.OS === 'web') alert('You cannot delete other admin accounts.');
      else Alert.alert('Cannot delete', 'You cannot delete other admin accounts.');
      return;
    }

    const title = isSelf ? 'Delete your account?' : `Delete ${user.name}?`;
    const message = isSelf
      ? 'This will permanently delete your account and sign you out. This cannot be undone.'
      : `This will permanently remove ${user.name} from the system. This cannot be undone.`;

    const doDelete = async () => {
      removeUser(user.id);
      const { deleteUser: supabaseDelete } = await import('../lib/auth');
      await supabaseDelete(user.id);

      addNotification(`${user.name} account has been deleted.`);

      if (isSelf) {
        Toast.show({ type: 'success', text1: 'Account deleted', text2: 'Your account has been removed. Signing out...', visibilityTime: 2000 });
        logout();
        // Force reload to login page after a brief delay
        if (Platform.OS === 'web') {
          setTimeout(() => { window.location.href = '/'; }, 1500);
        }
      } else {
        Toast.show({ type: 'success', text1: 'User deleted', text2: `${user.name} has been successfully removed.`, visibilityTime: 3000 });
        refreshCloudUsers();
      }
    };

    if (Platform.OS === 'web') {
      if (confirm(title + '\n' + message)) doDelete();
    } else {
      Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  const userColors: Record<string, string> = { '#378ADD': C.userAdmin, '#1D9E75': C.userMaria, '#D85A30': C.userJames, '#D4537E': C.userAna };

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <WebScrollView id="users-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        {/* Store management section (master only) */}
        {isMaster && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.md }}>
              <Text style={{ fontSize: FontSize.lg, fontWeight: '600', color: C.textPrimary }}>Stores ({stores.length})</Text>
              <TouchableOpacity style={[styles.addBtn, { backgroundColor: C.textPrimary, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.md }]} onPress={openAddStore}>
                <Ionicons name="add" size={14} color={C.bgPrimary} />
                <Text style={{ color: C.bgPrimary, fontSize: FontSize.xs, fontWeight: '500' }}>Add store</Text>
              </TouchableOpacity>
            </View>
            {stores.map((store) => {
              const itemCount = inventory.filter((i) => i.storeId === store.id).length;
              return (
                <View key={store.id} style={[styles.vendorCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight, marginBottom: Spacing.sm }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: FontSize.base, fontWeight: '500', color: C.textPrimary }}>{store.name}</Text>
                      <Text style={{ fontSize: FontSize.xs, color: C.textTertiary }}>{store.address || 'No address'} · {itemCount} items</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
                      <TouchableOpacity onPress={() => openEditStore(store)}>
                        <Ionicons name="create-outline" size={16} color={C.textSecondary} />
                      </TouchableOpacity>
                      {stores.length > 1 && (
                        <TouchableOpacity onPress={() => { setDeleteStoreTarget(store); setDeleteConfirmName(''); }}>
                          <Ionicons name="trash-outline" size={16} color={C.danger} />
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                </View>
              );
            })}
            <View style={{ height: Spacing.lg }} />
          </>
        )}

        {/* Users section */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Text style={{ fontSize: FontSize.lg, fontWeight: '600', color: C.textPrimary }}>Users</Text>
        </View>
        <TouchableOpacity style={[styles.addRow, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]} onPress={() => setShowModal(true)}>
          <Text style={[styles.addRowText, { color: C.info }]}>+ Invite user</Text>
        </TouchableOpacity>
        {loadingUsers ? (
          <View style={{ padding: Spacing.xl, alignItems: 'center' }}>
            <Text style={{ color: C.textTertiary, fontSize: FontSize.sm }}>Loading users...</Text>
          </View>
        ) : allUsers.length === 0 ? (
          <View style={{ padding: Spacing.xl, alignItems: 'center' }}>
            <Text style={{ color: C.textTertiary, fontSize: FontSize.sm }}>No users yet. Invite someone to get started.</Text>
          </View>
        ) : null}
        {allUsers.map((user) => (
          <View key={user.id} style={[styles.userCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            <View style={styles.userTop}>
              <View style={[styles.userAvatar, { backgroundColor: user.color + '22' }]}>
                <Text style={[styles.userInitials, { color: user.color }]}>{user.initials}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.userName, { color: C.textPrimary }]}>{user.name}</Text>
                {user.nickname ? <Text style={[styles.userEmail, { color: C.textSecondary }]}>"{user.nickname}"</Text> : null}
                {isMaster || currentUser?.role === 'admin' ? (
                  <Text style={[styles.userEmail, { color: C.textTertiary }]}>{user.email}</Text>
                ) : null}
              </View>
              <Badge label={user.role === 'master' ? 'Master' : user.role === 'admin' ? 'Admin' : 'Store user'} variant={user.role === 'admin' || user.role === 'master' ? 'admin' : 'user'} />
            </View>
            <View style={styles.userMeta}>
              <Text style={[styles.userMetaLabel, { color: C.textTertiary }]}>Store access</Text>
              <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
                {user.stores.map((sid) => {
                  const store = stores.find((s) => s.id === sid);
                  return store ? (
                    <View key={sid} style={[styles.storeTag, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                      <Text style={[styles.storeTagText, { color: C.textSecondary }]}>{store.name}</Text>
                    </View>
                  ) : null;
                })}
              </View>
            </View>
            <View style={[styles.userFooter, { borderTopColor: C.borderLight }]}>
              <Badge label={user.status === 'active' ? 'Active' : 'Pending invite'} variant={user.status === 'active' ? 'ok' : 'pending'} />
              {/* Delete rules: master can delete anyone except self, admin can delete users + self */}
              {(() => {
                const isMaster = currentUser?.role === 'master';
                const isSelf = user.id === currentUser?.id;
                const canDelete = isMaster
                  ? !isSelf // master can delete everyone except self
                  : (user.role !== 'admin' && user.role !== 'master') || isSelf; // admin can delete users + self
                return canDelete ? (
                  <TouchableOpacity onPress={() => handleDeleteUser(user)} style={{ marginLeft: 'auto' }}>
                    <Ionicons name="trash-outline" size={18} color={C.danger} />
                  </TouchableOpacity>
                ) : null;
              })()}
            </View>
          </View>
        ))}
      </WebScrollView>
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Invite user</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}><Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Full name</Text>
            <TextInput style={[styles.formInput, { marginBottom: Spacing.md, color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]} value={form.name} onChangeText={(v) => setForm((p) => ({ ...p, name: v }))} placeholderTextColor={C.textTertiary} placeholder="e.g. Maria Garcia" />
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Email address</Text>
            <TextInput style={[styles.formInput, { marginBottom: Spacing.md, color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]} value={form.email} onChangeText={(v) => setForm((p) => ({ ...p, email: v }))} keyboardType="email-address" autoCapitalize="none" placeholderTextColor={C.textTertiary} placeholder="maria@restaurant.com" />
            {/* Master can assign any role, admin can only invite store users */}
            {isMaster ? (
              <>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>Role</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: Spacing.md }}>
                  {(['user', 'admin'] as const).map((r) => (
                    <TouchableOpacity key={r} style={[styles.roleBtn, { backgroundColor: C.bgSecondary, borderColor: C.borderMedium }, form.role === r && { backgroundColor: C.textPrimary }]} onPress={() => setForm((p) => ({ ...p, role: r }))}>
                      <Text style={[styles.roleBtnText, { color: C.textSecondary }, form.role === r && { color: C.bgPrimary }]}>{r === 'admin' ? 'Admin' : 'Store user'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Store access</Text>
            {stores.map((store) => {
              const selected = form.storeIds.includes(store.id);
              return (
                <TouchableOpacity key={store.id} style={[styles.storeSelector, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, selected && { borderColor: C.textPrimary, backgroundColor: C.textPrimary + '11' }]}
                  onPress={() => setForm((p) => ({ ...p, storeIds: selected ? p.storeIds.filter((s) => s !== store.id) : [...p.storeIds, store.id] }))}>
                  <View style={[styles.checkbox, { borderColor: C.borderMedium }, selected && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}>
                    {selected && <Text style={{ color: C.bgPrimary, fontSize: 10 }}>✓</Text>}
                  </View>
                  <Text style={[styles.storeName, { color: C.textPrimary }]}>{store.name}</Text>
                </TouchableOpacity>
              );
            })}
            {inviteWarning ? (
              <View style={[styles.dupWarning, { backgroundColor: C.warningBg, borderColor: C.warning }]}>
                <Text style={[styles.dupWarningText, { color: C.warning }]}>{inviteWarning}</Text>
              </View>
            ) : null}
            <TouchableOpacity style={[styles.saveBtn, { marginTop: Spacing.xl, backgroundColor: C.textPrimary }, loading && { opacity: 0.5 }]} onPress={handleInvite} disabled={loading}>
              <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>{loading ? 'Sending...' : 'Send invite'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Add/Edit Store Modal (master only) */}
      <Modal visible={showStoreModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>{editStoreTarget ? 'Edit store' : 'Add store'}</Text>
            <TouchableOpacity onPress={() => setShowStoreModal(false)}><Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text></TouchableOpacity>
          </View>
          <View style={{ padding: Spacing.lg }}>
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Store name *</Text>
              <TextInput
                style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                value={newStoreName}
                onChangeText={setNewStoreName}
                placeholder="e.g. Downtown, Bel Air"
                placeholderTextColor={C.textTertiary}
              />
            </View>
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Address</Text>
              <TextInput
                style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                value={newStoreAddress}
                onChangeText={setNewStoreAddress}
                placeholder="123 Main St, City MD 21000"
                placeholderTextColor={C.textTertiary}
              />
            </View>
            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleSaveStore}>
              <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>{editStoreTarget ? 'Save changes' : 'Add store'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Delete Store Confirmation Modal */}
      <Modal visible={!!deleteStoreTarget} transparent animationType="fade">
        <View style={styles.confirmOverlay}>
          <View style={[styles.confirmBox, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            <Text style={[styles.confirmTitle, { color: C.danger }]}>Delete store</Text>
            <Text style={[styles.confirmMessage, { color: C.textSecondary }]}>
              This will permanently delete <Text style={{ fontWeight: '700', color: C.textPrimary }}>"{deleteStoreTarget?.name}"</Text> and all its inventory, recipes, and history.
            </Text>
            <Text style={[styles.confirmMessage, { color: C.textSecondary, marginTop: Spacing.sm }]}>
              Type the store name to confirm:
            </Text>
            <TextInput
              style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium, marginTop: Spacing.sm }]}
              value={deleteConfirmName}
              onChangeText={setDeleteConfirmName}
              placeholder={deleteStoreTarget?.name || ''}
              placeholderTextColor={C.textTertiary}
              autoFocus
            />
            <View style={styles.confirmBtnRow}>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: C.bgSecondary }]} onPress={() => { setDeleteStoreTarget(null); setDeleteConfirmName(''); }}>
                <Text style={[styles.confirmBtnText, { color: C.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, { backgroundColor: C.danger }, deleteConfirmName !== deleteStoreTarget?.name && { opacity: 0.3 }]}
                onPress={handleDeleteStore}
                disabled={deleteConfirmName !== deleteStoreTarget?.name}
              >
                <Text style={[styles.confirmBtnText, { color: C.bgPrimary }]}>Delete store</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  infoBar: { backgroundColor: Colors.infoBg, margin: Spacing.lg, marginBottom: 0, borderRadius: Radius.md, padding: Spacing.md },
  infoText: { fontSize: FontSize.xs, color: Colors.info, lineHeight: 17 },
  addRow: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: Colors.borderLight, alignItems: 'center', borderStyle: 'dashed' },
  addRowText: { fontSize: FontSize.sm, color: Colors.info, fontWeight: '500' },
  recipeCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  recipeTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: Spacing.sm },
  recipeName: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  recipeCat: { fontSize: FontSize.xs, color: Colors.textSecondary },
  fcPct: { fontSize: FontSize.sm, fontWeight: '600' },
  recipePrices: { fontSize: 10, color: Colors.textSecondary, marginTop: 2 },
  ingList: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, padding: Spacing.sm, marginBottom: Spacing.sm },
  ingRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  ingName: { fontSize: FontSize.xs, color: Colors.textPrimary },
  ingQty: { fontSize: FontSize.xs, color: Colors.textSecondary },
  noIng: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', paddingVertical: Spacing.sm },
  editRecipeBtn: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: 6, alignItems: 'center' },
  editRecipeBtnText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  prepTag: { backgroundColor: Colors.infoBg, borderRadius: Radius.round, paddingHorizontal: 5, paddingVertical: 1 },
  prepTagText: { fontSize: 8, fontWeight: '600', color: Colors.info },
  vendorCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  vendorTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm },
  vendorLogo: { width: 40, height: 40, borderRadius: Radius.md, backgroundColor: Colors.bgSecondary, alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: Colors.borderLight },
  vendorLogoText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary },
  vendorName: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  vendorContact: { fontSize: FontSize.xs, color: Colors.textSecondary },
  leadBadge: { backgroundColor: Colors.infoBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.round },
  leadText: { fontSize: 9, color: Colors.info, fontWeight: '500' },
  vendorMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metaLabel: { fontSize: 9, color: Colors.textTertiary, marginRight: 4 },
  metaValue: { fontSize: FontSize.xs, color: Colors.textPrimary },
  tabBar: { flexDirection: 'row', backgroundColor: Colors.bgPrimary, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  tabItem: { flex: 1, paddingVertical: Spacing.md, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabItemActive: { borderBottomColor: Colors.textPrimary },
  tabText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  tabTextActive: { color: Colors.textPrimary, fontWeight: '500' },
  filterScroll: { backgroundColor: Colors.bgPrimary, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight, flexGrow: 0 },
  filterChip: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 5, marginRight: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  filterChipActive: { backgroundColor: Colors.textPrimary },
  filterText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  filterTextActive: { color: Colors.bgPrimary, fontWeight: '500' },
  auditRow: { flexDirection: 'row', gap: Spacing.sm, paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  auditDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, flexShrink: 0 },
  actionTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.round },
  actionTagText: { fontSize: 9, fontWeight: '500' },
  auditStore: { fontSize: 9, color: Colors.textTertiary },
  auditDetail: { fontSize: FontSize.xs, color: Colors.textPrimary, marginTop: 3 },
  auditMeta: { fontSize: 9, color: Colors.textTertiary, marginTop: 2 },
  kpiRow: { flexDirection: 'row', marginBottom: Spacing.sm },
  reportRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  reportName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  reportSub: { fontSize: 10, color: Colors.textSecondary },
  reportPct: { fontSize: FontSize.base, fontWeight: '600' },
  catFcRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 6 },
  catFcName: { width: 80, fontSize: FontSize.xs, color: Colors.textPrimary },
  fcBar: { flex: 1, height: 6, backgroundColor: Colors.borderLight, borderRadius: 3, overflow: 'hidden' },
  fcFill: { height: 6, borderRadius: 3 },
  fcPctVal: { width: 36, fontSize: FontSize.xs, fontWeight: '500', textAlign: 'right' },
  usageRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  usageName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  usageSub: { fontSize: 10, color: Colors.textSecondary },
  usageWeeks: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 40 },
  weekCol: { alignItems: 'center', gap: 2 },
  weekBar: { width: 14, borderRadius: 2 },
  weekLabel: { fontSize: 8, color: Colors.textTertiary },
  wasteReportRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  userCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  userTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm },
  userAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  userInitials: { fontSize: FontSize.sm, fontWeight: '600' },
  userName: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  userEmail: { fontSize: FontSize.xs, color: Colors.textSecondary },
  userMeta: { marginBottom: Spacing.sm },
  userMetaLabel: { fontSize: 9, color: Colors.textTertiary, marginBottom: 4 },
  userFooter: { flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: Colors.borderLight, paddingTop: Spacing.sm },
  storeTag: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 0.5, borderColor: Colors.borderLight },
  storeTagText: { fontSize: 9, color: Colors.textSecondary },
  modal: { flex: 1, backgroundColor: Colors.bgPrimary },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600' },
  modalClose: { color: Colors.info, fontSize: FontSize.base },
  formLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 5, marginTop: Spacing.sm },
  formInput: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  catPill: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  catPillActive: { backgroundColor: Colors.textPrimary },
  catPillText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  mfRow: { marginTop: Spacing.xl },
  saveBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center' },
  saveBtnText: { color: Colors.bgPrimary, fontSize: FontSize.base, fontWeight: '600' },
  roleBtn: { flex: 1, borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: 8, alignItems: 'center', backgroundColor: Colors.bgSecondary },
  roleBtnActive: { backgroundColor: Colors.textPrimary },
  roleBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  storeSelector: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, padding: Spacing.md, borderRadius: Radius.md, borderWidth: 0.5, borderColor: Colors.borderLight, marginBottom: 6, backgroundColor: Colors.bgSecondary },
  storeSelectorActive: { borderColor: Colors.textPrimary, backgroundColor: Colors.textPrimary + '11' },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: Colors.borderMedium, alignItems: 'center', justifyContent: 'center' },
  checkboxActive: { backgroundColor: Colors.textPrimary, borderColor: Colors.textPrimary },
  storeName: { fontSize: FontSize.sm, color: Colors.textPrimary },
  dupWarning: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.sm },
  dupWarningText: { fontSize: FontSize.sm, fontWeight: '500' },
  formField: { marginBottom: Spacing.md },
  storeLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  selectAllText: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '500' },
  storeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  storeChip: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, borderRadius: Radius.md, borderWidth: 1, backgroundColor: Colors.bgSecondary, borderColor: Colors.borderLight },
  storeChipCheck: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: Colors.borderMedium, alignItems: 'center', justifyContent: 'center' },
  storeChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  storeHint: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 6 },
  deleteRecipeBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: Colors.danger, borderRadius: Radius.md, padding: Spacing.md, marginTop: Spacing.md },
  deleteRecipeBtnText: { color: Colors.danger, fontSize: FontSize.base, fontWeight: '500' },
  filterChip: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 0.5, borderColor: Colors.borderLight },
  filterChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  catAddRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.lg },
  catAddBtn: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, justifyContent: 'center', alignItems: 'center' },
  catManageRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.md, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  catManageName: { flex: 1, fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  catManageCount: { fontSize: FontSize.xs, color: Colors.textTertiary },
  confirmOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: Spacing.xl },
  confirmBox: { width: '100%', maxWidth: 360, borderRadius: Radius.xl, padding: Spacing.xl, borderWidth: 0.5 },
  confirmTitle: { fontSize: FontSize.lg, fontWeight: '600', marginBottom: Spacing.sm },
  confirmMessage: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.xl },
  confirmBtnRow: { flexDirection: 'row', gap: Spacing.sm },
  confirmBtn: { flex: 1, paddingVertical: Spacing.md, borderRadius: Radius.md, alignItems: 'center' },
  confirmBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
});

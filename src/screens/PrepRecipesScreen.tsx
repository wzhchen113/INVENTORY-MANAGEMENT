// src/screens/PrepRecipesScreen.tsx
import React, { useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Modal, ScrollView,
  TextInput, StyleSheet, Alert, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { numericFilter, toCSV, downloadCSV } from '../utils';
import { Colors, useColors, Spacing, Radius, FontSize, Shadow } from '../theme/colors';
import { PrepRecipe, PrepRecipeIngredient } from '../types';
import IngredientEditor from '../components/IngredientEditor';
import { WebScrollView } from '../components/WebScrollView';

const PREP_CATEGORIES = ['Marinades', 'Sauces', 'Bases', 'Seasonings', 'Prep'];

export default function PrepRecipesScreen() {
  const {
    prepRecipes, inventory, stores, currentUser, currentStore,
    addPrepRecipe, updatePrepRecipe, deletePrepRecipe,
    getPrepRecipeCost, getPrepRecipeCostPerUnit,
  } = useStore();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';
  const C = useColors();

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
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);

  // Auto-calculate yield from ingredients (bottom-up)
  const calculatedYield = useMemo(() => {
    if (formIngredients.length === 0) return { quantity: 0, unit: 'fl_oz' as string };
    const { smartToBase } = require('../utils/unitConversion');

    // Sum all ingredient base quantities, grouped by type (weight vs volume)
    // Always recalculate from quantity+unit (stored baseQuantity can be corrupt)
    let totalGrams = 0;
    let totalFlOz = 0;
    for (const ing of formIngredients) {
      const base = smartToBase(ing.quantity, ing.unit);
      if (base.unit === 'fl_oz') totalFlOz += base.quantity;
      else totalGrams += base.quantity;
    }

    // Determine dominant unit type
    if (totalFlOz > 0 && totalGrams === 0) {
      // All volume — show in best display unit
      if (totalFlOz >= 128) return { quantity: parseFloat((totalFlOz / 128).toFixed(3)), unit: 'gal' };
      if (totalFlOz >= 32) return { quantity: parseFloat((totalFlOz / 32).toFixed(3)), unit: 'qt' };
      return { quantity: parseFloat(totalFlOz.toFixed(3)), unit: 'fl_oz' };
    }
    if (totalGrams > 0 && totalFlOz === 0) {
      // All weight — show in best display unit
      if (totalGrams >= 453.592) return { quantity: parseFloat((totalGrams / 453.592).toFixed(3)), unit: 'lbs' };
      if (totalGrams >= 28.35) return { quantity: parseFloat((totalGrams / 28.3495).toFixed(3)), unit: 'oz' };
      return { quantity: parseFloat(totalGrams.toFixed(3)), unit: 'g' };
    }
    // Mixed — show weight (more common for prep)
    const total = totalGrams + totalFlOz * 29.5735; // rough fl_oz to grams
    if (total >= 453.592) return { quantity: parseFloat((total / 453.592).toFixed(3)), unit: 'lbs' };
    return { quantity: parseFloat(total.toFixed(3)), unit: 'g' };
  }, [formIngredients]);

  // Build ingredient-name → Set<storeId> map (O(1) lookup)
  const ingredientStoreMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const item of inventory) {
      const key = item.name.toLowerCase();
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(item.storeId);
    }
    return map;
  }, [inventory]);

  // For each store, determine if it has ALL current recipe ingredients
  const storeValidity = useMemo(() => {
    const result: Record<string, { valid: boolean; missing: string[] }> = {};
    for (const store of stores) {
      const missing: string[] = [];
      for (const ing of formIngredients) {
        const storeSet = ingredientStoreMap.get(ing.itemName.toLowerCase());
        if (!storeSet || !storeSet.has(store.id)) {
          missing.push(ing.itemName);
        }
      }
      result[store.id] = { valid: missing.length === 0, missing };
    }
    return result;
  }, [stores, formIngredients, ingredientStoreMap]);

  const filtered = prepRecipes.filter((pr) => {
    const matchCat = !filter || pr.category === filter;
    const matchSearch = !search || pr.name.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  // Map recipe names → store IDs for multi-store labels
  const recipeStoreMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const pr of prepRecipes) {
      const key = pr.name.toLowerCase();
      if (!map[key]) map[key] = [];
      if (!map[key].includes(pr.storeId)) map[key].push(pr.storeId);
    }
    return map;
  }, [prepRecipes]);

  // Deduplicate for "All Stores" view (one card per recipe name)
  const displayRecipes = useMemo(() => {
    if (currentStore.id !== '__all__') return filtered;
    const seen = new Set<string>();
    return filtered.filter((pr) => {
      const key = pr.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [filtered, currentStore.id]);

  const openNew = () => {
    setEditingId(null);
    setDupWarning('');
    setName('');
    setCategory('Marinades');
    setYieldQty('');
    setYieldUnit('');
    setNotes('');
    setFormIngredients([]);
    setSelectedStoreIds(stores.map((s) => s.id));
    setShowModal(true);
  };

  const openEdit = (pr: PrepRecipe) => {
    setEditingId(pr.id);
    setDupWarning('');
    setName(pr.name);
    setCategory(pr.category);
    setYieldQty(pr.yieldQuantity.toString());
    setYieldUnit(pr.yieldUnit);
    setNotes(pr.notes);
    setFormIngredients([...pr.ingredients]);
    // Find all stores that have this prep recipe
    const storesWithRecipe = prepRecipes
      .filter((p) => p.name.toLowerCase() === pr.name.toLowerCase())
      .map((p) => p.storeId);
    setSelectedStoreIds([...new Set(storesWithRecipe)]);
    setShowModal(true);
  };

  const [dupWarning, setDupWarning] = useState('');

  const handleSave = async () => {
    if (!name.trim()) { Alert.alert('Error', 'Name required'); return; }
    if (formIngredients.length === 0) { Alert.alert('Error', 'Add at least one ingredient'); return; }

    const trimmedName = name.trim().toLowerCase();
    // When editing, exclude all copies of the same recipe (across stores) from duplicate check
    const editedRecipe = editingId ? prepRecipes.find((r) => r.id === editingId) : null;
    const editedOriginalName = editedRecipe?.name?.toLowerCase() || '';
    const duplicate = prepRecipes.some(
      (pr) => pr.name.toLowerCase() === trimmedName &&
        (!editingId || (pr.id !== editingId && pr.name.toLowerCase() !== editedOriginalName))
    );

    if (duplicate) {
      setDupWarning(`A prep recipe named "${name.trim()}" already exists.`);
      return;
    }
    setDupWarning('');

    // Only save to valid stores
    const validStores = selectedStoreIds.filter((sid) => storeValidity[sid]?.valid);
    if (validStores.length === 0) {
      setDupWarning('No valid stores selected. All selected stores are missing required ingredients.');
      return;
    }

    const recipeData = {
      name: name.trim(), category,
      yieldQuantity: calculatedYield.quantity, yieldUnit: calculatedYield.unit,
      notes: notes.trim(), ingredients: formIngredients,
    };

    if (editingId) {
      // Fetch ALL copies of this recipe across ALL stores from the database
      // (local state only has recipes for the current store)
      const editedRecipe = prepRecipes.find((r) => r.id === editingId);
      const originalName = editedRecipe?.name || '';
      let allCopies: { id: string; storeId: string }[] = [];
      try {
        const { fetchPrepRecipesByName } = require('../lib/db');
        allCopies = await fetchPrepRecipesByName(originalName);
      } catch (e) {
        console.warn('[PrepRecipes] Failed to fetch cross-store copies:', e);
        // Fallback to local state only
        allCopies = prepRecipes
          .filter((r) => r.name.toLowerCase() === originalName.toLowerCase())
          .map((r) => ({ id: r.id, storeId: r.storeId }));
      }
      const existingStoreIds = allCopies.map((r) => r.storeId);

      // Update the current store's copy via local state
      updatePrepRecipe(editingId, recipeData);

      // Update other stores' copies directly in the database
      for (const copy of allCopies) {
        if (copy.id !== editingId && selectedStoreIds.includes(copy.storeId)) {
          updatePrepRecipe(copy.id, recipeData);
        }
      }

      // Delete from deselected stores
      for (const copy of allCopies) {
        if (!selectedStoreIds.includes(copy.storeId)) {
          deletePrepRecipe(copy.id);
        }
      }

      // Add to newly selected stores
      const newStoreIds = validStores.filter((sid) => !existingStoreIds.includes(sid));
      for (const storeId of newStoreIds) {
        addPrepRecipe({
          ...recipeData, storeId,
          createdBy: currentUser?.name || 'Admin',
          createdAt: new Date().toLocaleDateString(),
        });
      }
    } else {
      for (const storeId of validStores) {
        addPrepRecipe({
          ...recipeData, storeId,
          createdBy: currentUser?.name || 'Admin',
          createdAt: new Date().toLocaleDateString(),
        });
      }
    }
    setShowModal(false);
  };

  const handleDelete = (pr: PrepRecipe) => {
    if (Platform.OS === 'web') {
      if (confirm(`Delete "${pr.name}"? This cannot be undone.`)) {
        deletePrepRecipe(pr.id);
      }
    } else {
      Alert.alert('Delete prep recipe', `Delete "${pr.name}"? This cannot be undone.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deletePrepRecipe(pr.id) },
      ]);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      {/* Info bar */}
      <View style={[styles.infoBar, { backgroundColor: C.infoBg }]}>
        <Text style={[styles.infoText, { color: C.info }]}>
          Prep recipes define intermediate preparations (marinades, sauces, bases) with ingredient portions and costs. These can be referenced in menu item recipes.
        </Text>
      </View>

      {/* Search + filter */}
      <View style={styles.searchRow}>
        <TextInput
          style={[styles.searchInput, { color: C.textPrimary, backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}
          placeholder="Search prep recipes..."
          placeholderTextColor={C.textTertiary}
          value={search}
          onChangeText={setSearch}
        />
      </View>
      <View style={styles.filterWrapper}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          <TouchableOpacity
            style={[styles.filterChip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, !filter && [styles.filterChipActive, { backgroundColor: C.textPrimary }]]}
            onPress={() => setFilter('')}
          >
            <Text style={[styles.filterText, { color: C.textSecondary }, !filter && { color: C.bgPrimary, fontWeight: '500' }]}>All</Text>
          </TouchableOpacity>
          {PREP_CATEGORIES.map((c) => (
            <TouchableOpacity
              key={c}
              style={[styles.filterChip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, filter === c && [styles.filterChipActive, { backgroundColor: C.textPrimary }]]}
              onPress={() => setFilter(filter === c ? '' : c)}
            >
              <Text style={[styles.filterText, { color: C.textSecondary }, filter === c && { color: C.bgPrimary, fontWeight: '500' }]}>{c}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* List */}
      <WebScrollView id="prep-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        {isAdmin && (
          <View style={{ flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md }}>
            <TouchableOpacity style={[styles.addRow, { backgroundColor: C.bgPrimary, borderColor: C.borderLight, flex: 1, marginBottom: 0 }]} onPress={openNew}>
              <Text style={[styles.addRowText, { color: C.info }]}>+ New prep recipe</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ backgroundColor: C.bgPrimary, borderRadius: Radius.md, borderWidth: 0.5, borderColor: C.borderLight, width: 40, alignItems: 'center', justifyContent: 'center' }}
              onPress={() => {
                const { smartToBase: _stb } = require('../utils/unitConversion');
                const rows: Record<string, any>[] = [];
                const cols = ['Recipe','Category','Store(s)','Ingredient','Qty','Unit','Cost','','Batch Cost','Yield','Yield Unit','Cost/Unit','Notes'];
                displayRecipes.forEach((pr) => {
                  const bCost = getPrepRecipeCost(pr.id);
                  const cpu = getPrepRecipeCostPerUnit(pr.id);
                  // Live yield
                  let _yG = 0, _yF = 0;
                  for (const ing of pr.ingredients) { const b = _stb(ing.quantity, ing.unit); if (b.unit === 'fl_oz') _yF += b.quantity; else _yG += b.quantity; }
                  let yQ = 0, yU = '';
                  if (_yF > 0 && _yG === 0) { yQ = _yF >= 128 ? _yF / 128 : _yF >= 32 ? _yF / 32 : _yF; yU = _yF >= 128 ? 'gal' : _yF >= 32 ? 'qt' : 'fl_oz'; }
                  else if (_yG > 0 && _yF === 0) { yQ = _yG >= 453.592 ? _yG / 453.592 : _yG >= 28.35 ? _yG / 28.3495 : _yG; yU = _yG >= 453.592 ? 'lbs' : _yG >= 28.35 ? 'oz' : 'g'; }
                  else { const t = _yG + _yF * 29.5735; yQ = t >= 453.592 ? t / 453.592 : t; yU = t >= 453.592 ? 'lbs' : 'g'; }
                  const sids = recipeStoreMap[pr.name.toLowerCase()] || [pr.storeId];
                  const sLabel = sids.length >= stores.length ? 'All Stores' : sids.map((sid) => stores.find((s) => s.id === sid)?.name).filter(Boolean).join(', ');
                  // First ingredient row includes recipe-level data
                  pr.ingredients.forEach((ing, idx) => {
                    const item = inventory.find((i) => i.id === ing.itemId) || inventory.find((i) => i.name.toLowerCase() === ing.itemName.toLowerCase());
                    let ingCost = 0;
                    if (item) { const { getConversionFactor: gcf } = require('../utils/unitConversion'); const f = gcf(ing.unit, item.subUnitUnit || item.unit); ingCost = item.costPerUnit * (f !== null ? ing.quantity * f : ing.quantity); }
                    rows.push({
                      'Recipe': idx === 0 ? pr.name : '',
                      'Category': idx === 0 ? pr.category : '',
                      'Store(s)': idx === 0 ? sLabel : '',
                      'Ingredient': ing.itemName,
                      'Qty': ing.quantity,
                      'Unit': ing.unit,
                      'Cost': ingCost > 0 ? `$${ingCost.toFixed(2)}` : '',
                      '': '',
                      'Batch Cost': idx === 0 ? `$${bCost.toFixed(2)}` : '',
                      'Yield': idx === 0 ? parseFloat(yQ.toFixed(3)) : '',
                      'Yield Unit': idx === 0 ? yU : '',
                      'Cost/Unit': idx === 0 ? `$${cpu.toFixed(2)}` : '',
                      'Notes': idx === 0 ? (pr.notes || '') : '',
                    });
                  });
                  // Blank separator row between recipes
                  rows.push(cols.reduce((o, c) => ({ ...o, [c]: '' }), {}));
                });
                const csv = toCSV(rows, cols);
                downloadCSV(`prep_recipes_${new Date().toISOString().split('T')[0]}.csv`, csv);
              }}
            >
              <Ionicons name="download-outline" size={18} color={C.textSecondary} />
            </TouchableOpacity>
          </View>
        )}
        {displayRecipes.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: C.textTertiary }]}>No prep recipes yet</Text>
          </View>
        ) : (
          displayRecipes.map((pr) => {
            const batchCost = getPrepRecipeCost(pr.id);
            const costPerUnit = getPrepRecipeCostPerUnit(pr.id);
            const prStoreIds = recipeStoreMap[pr.name.toLowerCase()] || [pr.storeId];
            const storeLabel = prStoreIds.length >= stores.length
              ? 'All Stores'
              : prStoreIds.map((sid) => stores.find((s) => s.id === sid)?.name).filter(Boolean).join(', ');
            // Live yield calculation (don't trust stored yieldQuantity — may have corrupt baseQuantity)
            const { smartToBase: stb } = require('../utils/unitConversion');
            let yG = 0, yF = 0;
            for (const ing of pr.ingredients) {
              const b = stb(ing.quantity, ing.unit);
              if (b.unit === 'fl_oz') yF += b.quantity; else yG += b.quantity;
            }
            let liveYield = { quantity: pr.yieldQuantity, unit: pr.yieldUnit };
            if (pr.ingredients.length > 0) {
              if (yF > 0 && yG === 0) {
                liveYield = yF >= 128 ? { quantity: parseFloat((yF / 128).toFixed(3)), unit: 'gal' }
                  : yF >= 32 ? { quantity: parseFloat((yF / 32).toFixed(3)), unit: 'qt' }
                  : { quantity: parseFloat(yF.toFixed(3)), unit: 'fl_oz' };
              } else if (yG > 0 && yF === 0) {
                liveYield = yG >= 453.592 ? { quantity: parseFloat((yG / 453.592).toFixed(3)), unit: 'lbs' }
                  : yG >= 28.35 ? { quantity: parseFloat((yG / 28.3495).toFixed(3)), unit: 'oz' }
                  : { quantity: parseFloat(yG.toFixed(3)), unit: 'g' };
              } else {
                const t = yG + yF * 29.5735;
                liveYield = t >= 453.592 ? { quantity: parseFloat((t / 453.592).toFixed(3)), unit: 'lbs' }
                  : { quantity: parseFloat(t.toFixed(3)), unit: 'g' };
              }
            }
            return (
              <View key={pr.id} style={[styles.card, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
                <View style={styles.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.cardName, { color: C.textPrimary }]}>{pr.name}</Text>
                    <Text style={[styles.cardCategory, { color: C.textSecondary }]}>{pr.category} · {storeLabel}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <View style={[styles.yieldBadge, { backgroundColor: C.successBg }]}>
                      <Text style={[styles.yieldBadgeText, { color: C.success }]}>
                        Yields {liveYield.quantity} {liveYield.unit}
                      </Text>
                    </View>
                  </View>
                </View>
                <View style={[styles.ingList, { backgroundColor: C.bgSecondary }]}>
                  {pr.ingredients.map((ing, idx) => {
                    const item = inventory.find((i) => i.id === ing.itemId) ||
                      inventory.find((i) => i.name.toLowerCase() === ing.itemName.toLowerCase());
                    let ingCost = 0;
                    if (item) {
                      const { getConversionFactor } = require('../utils/unitConversion');
                      const factor = getConversionFactor(ing.unit, item.subUnitUnit || item.unit);
                      const convertedQty = factor !== null ? ing.quantity * factor : ing.quantity;
                      ingCost = item.costPerUnit * convertedQty;
                    }
                    return (
                      <View key={idx} style={styles.ingRow}>
                        <Text style={[styles.ingName, { color: C.textPrimary }]}>{ing.itemName}</Text>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={[styles.ingQty, { color: C.textSecondary }]}>{ing.quantity} {ing.unit}</Text>
                          {ingCost > 0 && (
                            <Text style={{ fontSize: 10, color: C.textTertiary }}>${ingCost.toFixed(2)}</Text>
                          )}
                        </View>
                      </View>
                    );
                  })}
                  {pr.ingredients.length === 0 && (
                    <Text style={[styles.noIng, { color: C.textTertiary }]}>No ingredients added yet</Text>
                  )}
                </View>
                <View style={styles.costRow}>
                  <View style={[styles.costItem, { backgroundColor: C.bgSecondary }]}>
                    <Text style={[styles.costLabel, { color: C.textTertiary }]}>Batch cost</Text>
                    <Text style={[styles.costValue, { color: C.textPrimary }]}>${batchCost.toFixed(2)}</Text>
                  </View>
                  <View style={[styles.costItem, { backgroundColor: C.bgSecondary }]}>
                    <Text style={[styles.costLabel, { color: C.textTertiary }]}>Cost per {pr.yieldUnit}</Text>
                    <Text style={[styles.costValue, { color: C.textPrimary }]}>${costPerUnit.toFixed(2)}</Text>
                  </View>
                </View>
                {pr.notes ? <Text style={[styles.notes, { color: C.textSecondary }]}>{pr.notes}</Text> : null}
                {isAdmin && (
                  <View style={styles.actions}>
                    <TouchableOpacity style={[styles.editBtn, { borderColor: C.borderMedium }]} onPress={() => openEdit(pr)}>
                      <Text style={[styles.editBtnText, { color: C.textSecondary }]}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.deleteBtn, { borderColor: C.dangerBg, backgroundColor: C.dangerBg }]} onPress={() => handleDelete(pr)}>
                      <Text style={[styles.deleteBtnText, { color: C.danger }]}>Delete</Text>
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
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>{editingId ? 'Edit prep recipe' : 'New prep recipe'}</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}>
              <Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            {/* Store selection */}
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>{editingId ? 'Stores' : 'Add to stores'}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: Spacing.md }}>
              {stores.map((store) => {
                const isSelected = selectedStoreIds.includes(store.id);
                const validity = storeValidity[store.id];
                const isValid = !formIngredients.length || validity?.valid;
                return (
                  <TouchableOpacity
                    key={store.id}
                    style={[
                      { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, borderRadius: Radius.md, borderWidth: 1, backgroundColor: C.bgSecondary, borderColor: C.borderLight },
                      isSelected && isValid && { backgroundColor: C.successBg, borderColor: C.success },
                      isSelected && !isValid && { backgroundColor: C.dangerBg, borderColor: C.danger },
                      !isValid && { opacity: 0.6 },
                    ]}
                    onPress={() => {
                      if (!isValid && !isSelected) return;
                      setSelectedStoreIds((prev) => isSelected ? prev.filter((s) => s !== store.id) : [...prev, store.id]);
                    }}
                  >
                    <View style={[
                      { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: C.borderMedium, alignItems: 'center', justifyContent: 'center' },
                      isSelected && isValid && { backgroundColor: C.success, borderColor: C.success },
                      isSelected && !isValid && { backgroundColor: C.danger, borderColor: C.danger },
                    ]}>
                      {isSelected && <Ionicons name="checkmark" size={10} color={C.white} />}
                    </View>
                    <View>
                      <Text style={{ fontSize: FontSize.sm, fontWeight: '500', color: C.textPrimary }}>{store.name}</Text>
                      {!isValid && validity?.missing.length > 0 && (
                        <Text style={{ fontSize: 9, color: C.danger }}>Missing: {validity.missing.slice(0, 2).join(', ')}{validity.missing.length > 2 ? ` +${validity.missing.length - 2}` : ''}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Recipe name</Text>
            <TextInput
              style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
              value={name}
              onChangeText={setName}
              placeholder="e.g. 40lb Marinated Chicken"
              placeholderTextColor={C.textTertiary}
            />

            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Category</Text>
            <View style={styles.catRow}>
              {PREP_CATEGORIES.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[styles.catPill, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, category === c && [styles.catPillActive, { backgroundColor: C.textPrimary }]]}
                  onPress={() => setCategory(c)}
                >
                  <Text style={[styles.catPillText, { color: C.textSecondary }, category === c && { color: C.bgPrimary }]}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Auto-calculated yield (read-only) */}
            <View style={[styles.yieldRow, { backgroundColor: C.bgSecondary, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.formLabel, { color: C.textTertiary, marginBottom: 2 }]}>Total yield (auto-calculated)</Text>
                <Text style={{ fontSize: FontSize.lg, fontWeight: '700', color: C.textPrimary }}>
                  {calculatedYield.quantity > 0 ? `${calculatedYield.quantity} ${calculatedYield.unit}` : 'Add ingredients to calculate'}
                </Text>
              </View>
              <Ionicons name="calculator-outline" size={20} color={C.textTertiary} />
            </View>

            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Notes</Text>
            <TextInput
              style={[styles.formInput, { height: 60, textAlignVertical: 'top', color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Optional notes..."
              placeholderTextColor={C.textTertiary}
              multiline
            />

            <Text style={[styles.formLabel, { marginTop: Spacing.lg, color: C.textSecondary }]}>Ingredients</Text>
            <IngredientEditor
              ingredients={formIngredients}
              onIngredientsChange={setFormIngredients}
              availableItems={inventory}
            />

            {dupWarning ? (
              <View style={[styles.dupWarning, { backgroundColor: C.warningBg, borderColor: C.warning }]}>
                <Text style={[styles.dupWarningText, { color: C.warning }]}>{dupWarning}</Text>
              </View>
            ) : null}

            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleSave}>
              <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>{editingId ? 'Update prep recipe' : 'Save prep recipe'}</Text>
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
  filterTextActive: { color: Colors.bgPrimary, fontWeight: '500' },
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
  saveBtnText: { color: Colors.bgPrimary, fontSize: FontSize.base, fontWeight: '600' },
  dupWarning: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.sm },
  dupWarningText: { fontSize: FontSize.sm, fontWeight: '500' },
});

// src/components/IngredientEditor.tsx
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  Modal, ScrollView, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';
import { InventoryItem, PrepRecipe, RecipeIngredient, RecipePrepItem } from '../types';

interface IngredientEditorProps {
  ingredients: RecipeIngredient[];
  onIngredientsChange: (ingredients: RecipeIngredient[]) => void;
  availableItems: InventoryItem[];
  // Prep recipe support (for menu recipes only)
  prepItems?: RecipePrepItem[];
  onPrepItemsChange?: (prepItems: RecipePrepItem[]) => void;
  availablePrepRecipes?: PrepRecipe[];
  showPrepRecipes?: boolean;
}

export default function IngredientEditor({
  ingredients,
  onIngredientsChange,
  availableItems,
  prepItems = [],
  onPrepItemsChange,
  availablePrepRecipes = [],
  showPrepRecipes = false,
}: IngredientEditorProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTab, setPickerTab] = useState<'items' | 'preps'>('items');
  const [search, setSearch] = useState('');

  // Group items by category
  const categories = [...new Set(availableItems.map((i) => i.category))].sort();

  const filteredItems = search
    ? availableItems.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
    : availableItems;

  const filteredPreps = search
    ? availablePrepRecipes.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : availablePrepRecipes;

  const addIngredient = (item: InventoryItem) => {
    if (ingredients.some((i) => i.itemId === item.id)) return;
    onIngredientsChange([
      ...ingredients,
      { itemId: item.id, itemName: item.name, quantity: 1, unit: item.unit },
    ]);
    setShowPicker(false);
    setSearch('');
  };

  const addPrepItem = (prep: PrepRecipe) => {
    if (prepItems.some((p) => p.prepRecipeId === prep.id)) return;
    onPrepItemsChange?.([
      ...prepItems,
      { prepRecipeId: prep.id, prepRecipeName: prep.name, quantity: 1, unit: prep.yieldUnit },
    ]);
    setShowPicker(false);
    setSearch('');
  };

  const updateIngredientQty = (index: number, qty: string) => {
    const updated = [...ingredients];
    updated[index] = { ...updated[index], quantity: parseFloat(qty) || 0 };
    onIngredientsChange(updated);
  };

  const updateIngredientUnit = (index: number, unit: string) => {
    const updated = [...ingredients];
    updated[index] = { ...updated[index], unit };
    onIngredientsChange(updated);
  };

  const removeIngredient = (index: number) => {
    onIngredientsChange(ingredients.filter((_, i) => i !== index));
  };

  const updatePrepQty = (index: number, qty: string) => {
    const updated = [...prepItems];
    updated[index] = { ...updated[index], quantity: parseFloat(qty) || 0 };
    onPrepItemsChange?.(updated);
  };

  const updatePrepUnit = (index: number, unit: string) => {
    const updated = [...prepItems];
    updated[index] = { ...updated[index], unit };
    onPrepItemsChange?.(updated);
  };

  const removePrepItem = (index: number) => {
    onPrepItemsChange?.(prepItems.filter((_, i) => i !== index));
  };

  return (
    <View>
      {/* Raw ingredients list */}
      {ingredients.length > 0 && (
        <Text style={styles.sectionLabel}>INGREDIENTS</Text>
      )}
      {ingredients.map((ing, idx) => (
        <View key={`ing-${idx}`} style={styles.row}>
          <Text style={styles.itemName} numberOfLines={1}>{ing.itemName}</Text>
          <TextInput
            style={styles.qtyInput}
            value={ing.quantity.toString()}
            onChangeText={(v) => updateIngredientQty(idx, v)}
            keyboardType="decimal-pad"
          />
          <TextInput
            style={styles.unitInput}
            value={ing.unit}
            onChangeText={(v) => updateIngredientUnit(idx, v)}
          />
          <TouchableOpacity onPress={() => removeIngredient(idx)} style={styles.removeBtn}>
            <Ionicons name="close-circle" size={20} color={Colors.danger} />
          </TouchableOpacity>
        </View>
      ))}

      {/* Prep recipe items */}
      {showPrepRecipes && prepItems.length > 0 && (
        <Text style={[styles.sectionLabel, { marginTop: Spacing.md }]}>PREP RECIPES</Text>
      )}
      {showPrepRecipes && prepItems.map((prep, idx) => (
        <View key={`prep-${idx}`} style={[styles.row, { backgroundColor: Colors.infoBg }]}>
          <View style={styles.prepBadge}>
            <Text style={styles.prepBadgeText}>Prep</Text>
          </View>
          <Text style={[styles.itemName, { flex: 1 }]} numberOfLines={1}>{prep.prepRecipeName}</Text>
          <TextInput
            style={styles.qtyInput}
            value={prep.quantity.toString()}
            onChangeText={(v) => updatePrepQty(idx, v)}
            keyboardType="decimal-pad"
          />
          <TextInput
            style={styles.unitInput}
            value={prep.unit}
            onChangeText={(v) => updatePrepUnit(idx, v)}
          />
          <TouchableOpacity onPress={() => removePrepItem(idx)} style={styles.removeBtn}>
            <Ionicons name="close-circle" size={20} color={Colors.danger} />
          </TouchableOpacity>
        </View>
      ))}

      {/* Add button */}
      <TouchableOpacity style={styles.addBtn} onPress={() => setShowPicker(true)}>
        <Ionicons name="add-circle-outline" size={16} color={Colors.info} />
        <Text style={styles.addBtnText}>Add ingredient</Text>
      </TouchableOpacity>

      {/* Picker Modal */}
      <Modal visible={showPicker} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.pickerContainer}>
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerTitle}>Select ingredient</Text>
            <TouchableOpacity onPress={() => { setShowPicker(false); setSearch(''); }}>
              <Text style={styles.pickerClose}>Done</Text>
            </TouchableOpacity>
          </View>

          {/* Tabs for items vs preps */}
          {showPrepRecipes && (
            <View style={styles.tabBar}>
              <TouchableOpacity
                style={[styles.tab, pickerTab === 'items' && styles.tabActive]}
                onPress={() => setPickerTab('items')}
              >
                <Text style={[styles.tabText, pickerTab === 'items' && styles.tabTextActive]}>
                  Inventory items
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tab, pickerTab === 'preps' && styles.tabActive]}
                onPress={() => setPickerTab('preps')}
              >
                <Text style={[styles.tabText, pickerTab === 'preps' && styles.tabTextActive]}>
                  Prep recipes
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Search */}
          <View style={styles.searchBox}>
            <Ionicons name="search-outline" size={16} color={Colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search..."
              placeholderTextColor={Colors.textTertiary}
              value={search}
              onChangeText={setSearch}
            />
          </View>

          {/* Inventory items list */}
          {pickerTab === 'items' && (
            <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingTop: 0 }}>
              {(search ? [{ cat: 'Results', items: filteredItems }] : categories.map((cat) => ({
                cat,
                items: availableItems.filter((i) => i.category === cat),
              }))).map(({ cat, items }) => (
                <View key={cat}>
                  <Text style={styles.catHeader}>{cat.toUpperCase()}</Text>
                  {items.map((item) => {
                    const alreadyAdded = ingredients.some((i) => i.itemId === item.id);
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.pickerItem, alreadyAdded && { opacity: 0.4 }]}
                        onPress={() => addIngredient(item)}
                        disabled={alreadyAdded}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.pickerItemName}>{item.name}</Text>
                          <Text style={styles.pickerItemSub}>{item.unit} · ${item.costPerUnit.toFixed(2)}/{item.unit}</Text>
                        </View>
                        {alreadyAdded ? (
                          <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
                        ) : (
                          <Ionicons name="add-circle-outline" size={18} color={Colors.info} />
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          )}

          {/* Prep recipes list */}
          {pickerTab === 'preps' && (
            <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingTop: 0 }}>
              {filteredPreps.length === 0 && (
                <Text style={styles.emptyText}>No prep recipes available</Text>
              )}
              {filteredPreps.map((prep) => {
                const alreadyAdded = prepItems.some((p) => p.prepRecipeId === prep.id);
                return (
                  <TouchableOpacity
                    key={prep.id}
                    style={[styles.pickerItem, alreadyAdded && { opacity: 0.4 }]}
                    onPress={() => addPrepItem(prep)}
                    disabled={alreadyAdded}
                  >
                    <View style={styles.prepBadge}>
                      <Text style={styles.prepBadgeText}>Prep</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pickerItemName}>{prep.name}</Text>
                      <Text style={styles.pickerItemSub}>
                        Yields {prep.yieldQuantity} {prep.yieldUnit} · {prep.ingredients.length} ingredients
                      </Text>
                    </View>
                    {alreadyAdded ? (
                      <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
                    ) : (
                      <Ionicons name="add-circle-outline" size={18} color={Colors.info} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    fontSize: 9,
    fontWeight: '600',
    color: Colors.textTertiary,
    letterSpacing: 0.6,
    marginBottom: Spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xs,
    paddingHorizontal: Spacing.sm,
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    marginBottom: 4,
  },
  itemName: {
    flex: 2,
    fontSize: FontSize.xs,
    color: Colors.textPrimary,
    fontWeight: '500',
  },
  qtyInput: {
    width: 56,
    fontSize: FontSize.xs,
    color: Colors.textPrimary,
    backgroundColor: Colors.bgPrimary,
    borderWidth: 0.5,
    borderColor: Colors.borderMedium,
    borderRadius: Radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 4,
    textAlign: 'center',
  },
  unitInput: {
    width: 50,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    backgroundColor: Colors.bgPrimary,
    borderWidth: 0.5,
    borderColor: Colors.borderLight,
    borderRadius: Radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 4,
    textAlign: 'center',
  },
  removeBtn: {
    padding: 2,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    marginTop: Spacing.xs,
    borderWidth: 0.5,
    borderColor: Colors.borderLight,
    borderStyle: 'dashed',
    borderRadius: Radius.md,
    justifyContent: 'center',
  },
  addBtnText: {
    fontSize: FontSize.xs,
    color: Colors.info,
    fontWeight: '500',
  },
  prepBadge: {
    backgroundColor: Colors.infoBg,
    borderRadius: Radius.round,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  prepBadgeText: {
    fontSize: 8,
    fontWeight: '600',
    color: Colors.info,
  },
  // Picker Modal
  pickerContainer: {
    flex: 1,
    backgroundColor: Colors.bgPrimary,
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: Spacing.lg,
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.borderLight,
  },
  pickerTitle: {
    fontSize: FontSize.lg,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  pickerClose: {
    fontSize: FontSize.base,
    color: Colors.info,
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.borderLight,
  },
  tab: {
    flex: 1,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: Colors.textPrimary,
  },
  tabText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  tabTextActive: {
    color: Colors.textPrimary,
    fontWeight: '500',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    margin: Spacing.lg,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    borderWidth: 0.5,
    borderColor: Colors.borderLight,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  catHeader: {
    fontSize: 9,
    fontWeight: '600',
    color: Colors.textTertiary,
    letterSpacing: 0.6,
    paddingVertical: Spacing.sm,
    marginTop: Spacing.sm,
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.borderLight,
  },
  pickerItemName: {
    fontSize: FontSize.sm,
    fontWeight: '500',
    color: Colors.textPrimary,
  },
  pickerItemSub: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  emptyText: {
    fontSize: FontSize.sm,
    color: Colors.textTertiary,
    textAlign: 'center',
    paddingVertical: Spacing.xxxl,
  },
});

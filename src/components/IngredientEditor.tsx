// src/components/IngredientEditor.tsx
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  Modal, ScrollView, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { numericFilter } from '../utils';
import { getCompatibleUnits, convertQuantity } from '../utils/unitConversion';
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
  const C = useColors();
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
        <Text style={[styles.sectionLabel, { color: C.textTertiary }]}>INGREDIENTS</Text>
      )}
      {ingredients.map((ing, idx) => {
        const invItem = availableItems.find((i) => i.id === ing.itemId);
        const baseUnit = invItem?.unit || ing.unit;
        const compatUnits = getCompatibleUnits(baseUnit);
        const converted = ing.unit !== baseUnit ? convertQuantity(ing.quantity, ing.unit, baseUnit) : null;
        return (
          <View key={`ing-${idx}`}>
            <View style={[styles.row, { backgroundColor: C.bgSecondary }]}>
              <Text style={[styles.itemName, { color: C.textPrimary }]} numberOfLines={1}>{ing.itemName}</Text>
              <TextInput
                style={[styles.qtyInput, { color: C.textPrimary, backgroundColor: C.bgPrimary, borderColor: C.borderMedium }]}
                value={ing.quantity.toString()}
                onChangeText={(v) => updateIngredientQty(idx, numericFilter(v))}
                keyboardType="decimal-pad"
                placeholderTextColor={C.textTertiary}
              />
              {compatUnits.length > 1 ? (
                <View style={styles.unitChips}>
                  {compatUnits.map((u) => (
                    <TouchableOpacity
                      key={u}
                      style={[styles.unitChip, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, ing.unit === u && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                      onPress={() => updateIngredientUnit(idx, u)}
                    >
                      <Text style={[styles.unitChipText, { color: C.textSecondary }, ing.unit === u && { color: C.bgPrimary }]}>{u}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <View style={[styles.unitLabel, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
                  <Text style={[styles.unitLabelText, { color: C.textSecondary }]}>{ing.unit}</Text>
                </View>
              )}
              <TouchableOpacity onPress={() => removeIngredient(idx)} style={styles.removeBtn}>
                <Ionicons name="close-circle" size={20} color={C.danger} />
              </TouchableOpacity>
            </View>
            {converted !== null && (
              <Text style={[styles.conversionHint, { color: C.textTertiary }]}>
                = {converted.toFixed(2)} {baseUnit} (inventory unit)
              </Text>
            )}
          </View>
        );
      })}

      {/* Prep recipe items */}
      {showPrepRecipes && prepItems.length > 0 && (
        <Text style={[styles.sectionLabel, { marginTop: Spacing.md, color: C.textTertiary }]}>PREP RECIPES</Text>
      )}
      {showPrepRecipes && prepItems.map((prep, idx) => {
        const prepRecipe = availablePrepRecipes.find((p) => p.id === prep.prepRecipeId);
        const baseUnit = prepRecipe?.yieldUnit || prep.unit;
        const compatUnits = getCompatibleUnits(baseUnit);
        const converted = prep.unit !== baseUnit ? convertQuantity(prep.quantity, prep.unit, baseUnit) : null;
        return (
          <View key={`prep-${idx}`}>
            <View style={[styles.row, { backgroundColor: C.infoBg }]}>
              <View style={[styles.prepBadge, { backgroundColor: C.infoBg }]}>
                <Text style={[styles.prepBadgeText, { color: C.info }]}>Prep</Text>
              </View>
              <Text style={[styles.itemName, { flex: 1, color: C.textPrimary }]} numberOfLines={1}>{prep.prepRecipeName}</Text>
              <TextInput
                style={[styles.qtyInput, { color: C.textPrimary, backgroundColor: C.bgPrimary, borderColor: C.borderMedium }]}
                value={prep.quantity.toString()}
                onChangeText={(v) => updatePrepQty(idx, numericFilter(v))}
                keyboardType="decimal-pad"
                placeholderTextColor={C.textTertiary}
              />
              {compatUnits.length > 1 ? (
                <View style={styles.unitChips}>
                  {compatUnits.map((u) => (
                    <TouchableOpacity
                      key={u}
                      style={[styles.unitChip, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, prep.unit === u && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                      onPress={() => updatePrepUnit(idx, u)}
                    >
                      <Text style={[styles.unitChipText, { color: C.textSecondary }, prep.unit === u && { color: C.bgPrimary }]}>{u}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <View style={[styles.unitLabel, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
                  <Text style={[styles.unitLabelText, { color: C.textSecondary }]}>{prep.unit}</Text>
                </View>
              )}
              <TouchableOpacity onPress={() => removePrepItem(idx)} style={styles.removeBtn}>
                <Ionicons name="close-circle" size={20} color={C.danger} />
              </TouchableOpacity>
            </View>
            {converted !== null && (
              <Text style={[styles.conversionHint, { color: C.textTertiary }]}>
                = {converted.toFixed(2)} {baseUnit} (yield unit)
              </Text>
            )}
          </View>
        );
      })}

      {/* Add button */}
      <TouchableOpacity style={[styles.addBtn, { borderColor: C.borderLight }]} onPress={() => setShowPicker(true)}>
        <Ionicons name="add-circle-outline" size={16} color={C.info} />
        <Text style={[styles.addBtnText, { color: C.info }]}>Add ingredient</Text>
      </TouchableOpacity>

      {/* Picker Modal */}
      <Modal visible={showPicker} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.pickerContainer, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.pickerHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.pickerTitle, { color: C.textPrimary }]}>Select ingredient</Text>
            <TouchableOpacity onPress={() => { setShowPicker(false); setSearch(''); }}>
              <Text style={[styles.pickerClose, { color: C.info }]}>Done</Text>
            </TouchableOpacity>
          </View>

          {/* Tabs for items vs preps */}
          {showPrepRecipes && (
            <View style={[styles.tabBar, { borderBottomColor: C.borderLight }]}>
              <TouchableOpacity
                style={[styles.tab, pickerTab === 'items' && [styles.tabActive, { borderBottomColor: C.textPrimary }]]}
                onPress={() => setPickerTab('items')}
              >
                <Text style={[styles.tabText, { color: C.textSecondary }, pickerTab === 'items' && { color: C.textPrimary, fontWeight: '500' }]}>
                  Inventory items
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tab, pickerTab === 'preps' && [styles.tabActive, { borderBottomColor: C.textPrimary }]]}
                onPress={() => setPickerTab('preps')}
              >
                <Text style={[styles.tabText, { color: C.textSecondary }, pickerTab === 'preps' && { color: C.textPrimary, fontWeight: '500' }]}>
                  Prep recipes
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Search */}
          <View style={[styles.searchBox, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
            <Ionicons name="search-outline" size={16} color={C.textTertiary} />
            <TextInput
              style={[styles.searchInput, { color: C.textPrimary }]}
              placeholder="Search..."
              placeholderTextColor={C.textTertiary}
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
                  <Text style={[styles.catHeader, { color: C.textTertiary }]}>{cat.toUpperCase()}</Text>
                  {items.map((item) => {
                    const alreadyAdded = ingredients.some((i) => i.itemId === item.id);
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.pickerItem, { borderBottomColor: C.borderLight }, alreadyAdded && { opacity: 0.4 }]}
                        onPress={() => addIngredient(item)}
                        disabled={alreadyAdded}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.pickerItemName, { color: C.textPrimary }]}>{item.name}</Text>
                          <Text style={[styles.pickerItemSub, { color: C.textSecondary }]}>{item.unit} · ${item.costPerUnit.toFixed(2)}/{item.unit}</Text>
                        </View>
                        {alreadyAdded ? (
                          <Ionicons name="checkmark-circle" size={18} color={C.success} />
                        ) : (
                          <Ionicons name="add-circle-outline" size={18} color={C.info} />
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
                <Text style={[styles.emptyText, { color: C.textTertiary }]}>No prep recipes available</Text>
              )}
              {filteredPreps.map((prep) => {
                const alreadyAdded = prepItems.some((p) => p.prepRecipeId === prep.id);
                return (
                  <TouchableOpacity
                    key={prep.id}
                    style={[styles.pickerItem, { borderBottomColor: C.borderLight }, alreadyAdded && { opacity: 0.4 }]}
                    onPress={() => addPrepItem(prep)}
                    disabled={alreadyAdded}
                  >
                    <View style={[styles.prepBadge, { backgroundColor: C.infoBg }]}>
                      <Text style={[styles.prepBadgeText, { color: C.info }]}>Prep</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.pickerItemName, { color: C.textPrimary }]}>{prep.name}</Text>
                      <Text style={[styles.pickerItemSub, { color: C.textSecondary }]}>
                        Yields {prep.yieldQuantity} {prep.yieldUnit} · {prep.ingredients.length} ingredients
                      </Text>
                    </View>
                    {alreadyAdded ? (
                      <Ionicons name="checkmark-circle" size={18} color={C.success} />
                    ) : (
                      <Ionicons name="add-circle-outline" size={18} color={C.info} />
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
  unitChips: {
    flexDirection: 'row',
    gap: 3,
  },
  unitChip: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: Radius.round,
    borderWidth: 0.5,
  },
  unitChipText: {
    fontSize: 9,
    fontWeight: '500',
  },
  unitLabel: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: Radius.sm,
    borderWidth: 0.5,
  },
  unitLabelText: {
    fontSize: FontSize.xs,
    fontWeight: '500',
  },
  conversionHint: {
    fontSize: 9,
    paddingLeft: Spacing.sm,
    paddingBottom: 4,
    fontStyle: 'italic',
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

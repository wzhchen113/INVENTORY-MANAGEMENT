// src/components/IngredientEditor.tsx
import React, { useState, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  Modal, ScrollView, StyleSheet, Platform,
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
  // Prep recipe support
  prepItems?: RecipePrepItem[];
  onPrepItemsChange?: (prepItems: RecipePrepItem[]) => void;
  availablePrepRecipes?: PrepRecipe[];
  showPrepRecipes?: boolean;
  // Sub-recipe mode: 'menu' uses separate prepItems array, 'prep' adds to main ingredients
  mode?: 'menu' | 'prep';
  editingRecipeId?: string; // filter self-references in prep mode
}

export default function IngredientEditor({
  ingredients,
  onIngredientsChange,
  availableItems,
  prepItems = [],
  onPrepItemsChange,
  availablePrepRecipes = [],
  showPrepRecipes = false,
  mode = 'menu',
  editingRecipeId,
}: IngredientEditorProps) {
  const C = useColors();
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTab, setPickerTab] = useState<'items' | 'preps'>('items');
  const [search, setSearch] = useState('');
  const [unitDropdown, setUnitDropdown] = useState<{ idx: number; type: 'ing' | 'prep'; units: string[] } | null>(null);

  // Deduplicate items by name — show each ingredient once, track which stores have it
  const { uniqueItems, itemStoreMap } = useMemo(() => {
    const nameMap = new Map<string, InventoryItem>();
    const storeMap = new Map<string, Set<string>>(); // name -> Set of storeIds
    for (const item of availableItems) {
      const key = item.name.toLowerCase();
      if (!nameMap.has(key)) nameMap.set(key, item);
      if (!storeMap.has(key)) storeMap.set(key, new Set());
      storeMap.get(key)!.add(item.storeId);
    }
    return { uniqueItems: [...nameMap.values()].sort((a, b) => a.name.localeCompare(b.name)), itemStoreMap: storeMap };
  }, [availableItems]);

  const categories = useMemo(() => [...new Set(uniqueItems.map((i) => i.category))].sort(), [uniqueItems]);

  const filteredItems = useMemo(() => {
    if (!search) return uniqueItems;
    const q = search.toLowerCase();
    return uniqueItems.filter((i) => i.name.toLowerCase().includes(q));
  }, [uniqueItems, search]);

  const filteredPreps = useMemo(() => {
    // Deduplicate prep recipes by name (they exist as separate rows per store)
    const seen = new Set<string>();
    let preps = availablePrepRecipes.filter((p) => {
      const key = p.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // In prep mode, filter out self-reference and already-added sub-recipes
    if (mode === 'prep') {
      preps = preps.filter((p) => {
        if (editingRecipeId && p.id === editingRecipeId) return false;
        if (ingredients.some((i) => (i as any).type === 'prep' && i.itemId === p.id)) return false;
        return true;
      });
    }
    if (!search) return preps;
    const q = search.toLowerCase();
    return preps.filter((p) => p.name.toLowerCase().includes(q));
  }, [availablePrepRecipes, search, mode, editingRecipeId, ingredients]);

  const addIngredient = (item: InventoryItem) => {
    if (ingredients.some((i) => i.itemName.toLowerCase() === item.name.toLowerCase())) return;
    // Calculate base quantity using smart conversion
    const { smartToBase } = require('../utils/unitConversion');
    const base = smartToBase(1, item.unit);
    onIngredientsChange([
      ...ingredients,
      { itemId: item.id, itemName: item.name, quantity: 1, unit: item.unit, baseQuantity: base.quantity, baseUnit: base.unit },
    ]);
    setShowPicker(false);
    setSearch('');
  };

  const addPrepItem = (prep: PrepRecipe) => {
    if (mode === 'prep') {
      // In prep mode, add sub-recipe as a regular ingredient with type='prep'
      if (ingredients.some((i) => (i as any).type === 'prep' && i.itemId === prep.id)) return;
      const { smartToBase } = require('../utils/unitConversion');
      const base = smartToBase(1, prep.yieldUnit);
      onIngredientsChange([
        ...ingredients,
        { itemId: prep.id, itemName: prep.name, quantity: 1, unit: prep.yieldUnit, baseQuantity: base.quantity, baseUnit: base.unit, type: 'prep' } as any,
      ]);
    } else {
      // In menu mode, add to separate prepItems array
      if (prepItems.some((p) => p.prepRecipeId === prep.id)) return;
      onPrepItemsChange?.([
        ...prepItems,
        { prepRecipeId: prep.id, prepRecipeName: prep.name, quantity: 1, unit: prep.yieldUnit },
      ]);
    }
    setShowPicker(false);
    setSearch('');
  };

  const updateIngredientQty = (index: number, qty: string) => {
    const updated = [...ingredients];
    const newQty = parseFloat(qty) || 0;
    const { smartToBase } = require('../utils/unitConversion');
    const base = smartToBase(newQty, updated[index].unit);
    updated[index] = { ...updated[index], quantity: newQty, baseQuantity: base.quantity, baseUnit: base.unit };
    onIngredientsChange(updated);
  };

  const updateIngredientUnit = (index: number, unit: string) => {
    const updated = [...ingredients];
    const { smartToBase, smartFromBase } = require('../utils/unitConversion');
    // Convert current quantity to the new unit
    const currentBase = smartToBase(updated[index].quantity, updated[index].unit);
    const newQty = smartFromBase(currentBase.quantity, currentBase.unit, unit);
    updated[index] = { ...updated[index], unit, quantity: parseFloat(newQty.toFixed(3)), baseQuantity: currentBase.quantity, baseUnit: currentBase.unit };
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
        const isSubRecipe = (ing as any).type === 'prep';
        const invItem = isSubRecipe ? null : (availableItems.find((i) => i.id === ing.itemId) ||
          availableItems.find((i) => i.name.toLowerCase() === ing.itemName.toLowerCase()));
        const subRecipe = isSubRecipe ? availablePrepRecipes.find((p) => p.id === ing.itemId) : null;
        const baseUnit = isSubRecipe ? (subRecipe?.yieldUnit || ing.unit) : (invItem?.unit || ing.unit);

        // Build unit options: purchase unit + matching weight OR volume group
        const abstractUnits = ['each', 'cases', 'bags', 'loaves'];
        const isAbstract = abstractUnits.includes(baseUnit.toLowerCase());
        const weightUnits = ['lbs', 'oz', 'g', 'kg'];
        const volumeUnits = ['gal', 'qt', 'fl_oz'];

        let allUnits: string[];
        if (isSubRecipe) {
          // Sub-recipe: use compatible units from yield unit
          allUnits = getCompatibleUnits(baseUnit);
          if (allUnits.length <= 1) allUnits = [baseUnit];
        } else if (isAbstract) {
          // Check if any unit in the ingredient name or subUnitUnit hints at volume
          const subUnit = (invItem?.subUnitUnit || '').toLowerCase();
          const ingName = ing.itemName.toLowerCase();
          const isVolume = volumeUnits.includes(subUnit) ||
            ingName.includes('sauce') || ingName.includes('oil') || ingName.includes('mustard') ||
            ingName.includes('mayo') || ingName.includes('vinegar') || ingName.includes('juice') ||
            volumeUnits.includes(ing.unit.toLowerCase());
          const standardGroup = isVolume ? volumeUnits : weightUnits;
          allUnits = [baseUnit, ...standardGroup];
        } else if (weightUnits.includes(baseUnit.toLowerCase())) {
          allUnits = weightUnits;
        } else if (volumeUnits.includes(baseUnit.toLowerCase())) {
          allUnits = volumeUnits;
        } else {
          allUnits = [baseUnit];
        }
        // Deduplicate
        allUnits = [...new Set(allUnits)];

        const converted = ing.unit !== baseUnit ? convertQuantity(ing.quantity, ing.unit, baseUnit) : null;
        const showBaseHint = ing.baseQuantity > 0 && ing.unit !== (ing.baseUnit || 'g');

        return (
          <View key={`ing-${idx}`}>
            <View style={[styles.row, { backgroundColor: C.bgSecondary }]}>
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
                {isSubRecipe && (
                  <View style={{ backgroundColor: C.infoBg, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, flexShrink: 0 }}>
                    <Text style={{ fontSize: 8, fontWeight: '600', color: C.info }}>SUB</Text>
                  </View>
                )}
                <Text style={[styles.itemName, { color: C.textPrimary, flex: 1 }]} numberOfLines={1}>{ing.itemName}</Text>
              </View>
              <TextInput
                style={[styles.qtyInput, { color: C.textPrimary, backgroundColor: C.bgPrimary, borderColor: C.borderMedium }]}
                value={ing.quantity.toString()}
                onChangeText={(v) => updateIngredientQty(idx, numericFilter(v))}
                keyboardType="decimal-pad"
                placeholderTextColor={C.textTertiary}
              />
              <TouchableOpacity
                style={[styles.unitDropdownBtn, { backgroundColor: C.bgPrimary, borderColor: C.borderMedium }]}
                onPress={() => setUnitDropdown({ idx, type: 'ing', units: allUnits })}
              >
                <Text style={[styles.unitDropdownText, { color: C.textPrimary }]}>{ing.unit}</Text>
                <Ionicons name="chevron-down" size={12} color={C.textTertiary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => removeIngredient(idx)} style={styles.removeBtn}>
                <Ionicons name="close-circle" size={20} color={C.danger} />
              </TouchableOpacity>
            </View>
            {converted !== null && (
              <Text style={[styles.conversionHint, { color: C.textTertiary }]}>
                = {converted.toFixed(3)} {baseUnit} (inventory unit)
              </Text>
            )}
            {showBaseHint && !converted && (
              <Text style={[styles.conversionHint, { color: C.textTertiary }]}>
                = {(ing.baseUnit === 'g' ? (ing.baseQuantity / 453.592).toFixed(3) + ' lbs' : (ing.baseQuantity / 128).toFixed(3) + ' gal')} (base)
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
        const allPrepUnits = compatUnits.length > 1 ? compatUnits : [prep.unit];
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
              <TouchableOpacity
                style={[styles.unitDropdownBtn, { backgroundColor: C.bgPrimary, borderColor: C.borderMedium }]}
                onPress={() => setUnitDropdown({ idx, type: 'prep', units: allPrepUnits })}
              >
                <Text style={[styles.unitDropdownText, { color: C.textPrimary }]}>{prep.unit}</Text>
                <Ionicons name="chevron-down" size={12} color={C.textTertiary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => removePrepItem(idx)} style={styles.removeBtn}>
                <Ionicons name="close-circle" size={20} color={C.danger} />
              </TouchableOpacity>
            </View>
            {converted !== null && (
              <Text style={[styles.conversionHint, { color: C.textTertiary }]}>
                = {converted.toFixed(3)} {baseUnit} (yield unit)
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
                items: uniqueItems.filter((i) => i.category === cat),
              }))).map(({ cat, items }) => (
                <View key={cat}>
                  <Text style={[styles.catHeader, { color: C.textTertiary }]}>{cat.toUpperCase()}</Text>
                  {items.map((item) => {
                    const alreadyAdded = ingredients.some((i) => i.itemName.toLowerCase() === item.name.toLowerCase());
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.pickerItem, { borderBottomColor: C.borderLight }, alreadyAdded && { opacity: 0.4 }]}
                        onPress={() => addIngredient(item)}
                        disabled={alreadyAdded}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.pickerItemName, { color: C.textPrimary }]}>{item.name}</Text>
                          <Text style={[styles.pickerItemSub, { color: C.textSecondary }]}>
                            {(() => {
                              // When the item is counted by `unit` (e.g. bags) but contains
                              // a smaller `subUnitUnit` (e.g. 10 each per bag), recipes
                              // typically consume the smaller unit — show its price too so
                              // users picking the ingredient see what each piece costs.
                              const subSize = item.subUnitSize || 0;
                              const showSub = subSize > 1 && !!item.subUnitUnit && item.subUnitUnit !== item.unit;
                              const head = `${item.unit} · $${item.costPerUnit.toFixed(2)}/${item.unit}`;
                              if (!showSub) return head;
                              const cps = item.costPerUnit / subSize;
                              const cpsLabel = cps >= 0.01 ? cps.toFixed(2) : cps.toFixed(4);
                              return `${head} ($${cpsLabel}/${item.subUnitUnit})`;
                            })()}
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
                const alreadyAdded = mode === 'prep'
                  ? ingredients.some((i) => (i as any).type === 'prep' && i.itemId === prep.id)
                  : prepItems.some((p) => p.prepRecipeId === prep.id);
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

      {/* Unit Dropdown Modal */}
      <Modal visible={!!unitDropdown} transparent animationType="fade">
        <TouchableOpacity style={styles.dropdownOverlay} activeOpacity={1} onPress={() => setUnitDropdown(null)}>
          <View style={[styles.dropdownBox, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            <Text style={[styles.dropdownTitle, { color: C.textPrimary }]}>Select unit</Text>
            {unitDropdown?.units.map((u) => {
              const isActive = unitDropdown.type === 'ing'
                ? ingredients[unitDropdown.idx]?.unit === u
                : prepItems[unitDropdown.idx]?.unit === u;
              return (
                <TouchableOpacity
                  key={u}
                  style={[styles.dropdownItem, { borderBottomColor: C.borderLight }, isActive && { backgroundColor: C.successBg }]}
                  onPress={() => {
                    if (unitDropdown.type === 'ing') {
                      updateIngredientUnit(unitDropdown.idx, u);
                    } else {
                      updatePrepUnit(unitDropdown.idx, u);
                    }
                    setUnitDropdown(null);
                  }}
                >
                  <Text style={[styles.dropdownItemText, { color: C.textPrimary }, isActive && { fontWeight: '600' }]}>{u}</Text>
                  {isActive && <Ionicons name="checkmark" size={16} color={C.success} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
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
  unitDropdownBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: Radius.md,
    borderWidth: 0.5,
  },
  unitDropdownText: {
    fontSize: FontSize.xs,
    fontWeight: '500',
  },
  dropdownOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  dropdownBox: {
    width: '100%',
    maxWidth: 280,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    overflow: 'hidden',
  },
  dropdownTitle: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    padding: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderBottomWidth: 0.5,
  },
  dropdownItemText: {
    fontSize: FontSize.base,
  },
});

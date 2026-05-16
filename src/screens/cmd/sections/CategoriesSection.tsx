import React from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { confirmAction } from '../../../utils/confirmAction';
import { useT } from '../../../hooks/useT';

// Cmd-styled admin section for `ingredient_categories` (global, no
// brand-scoping today). Modeled on the legacy `IngredientsScreen.tsx`
// `showCatModal` flow but adapted to the Cmd UI list/form rhythm of the
// existing `VendorsSection`. Reuses the existing store actions
// (`addIngredientCategory` / `updateIngredientCategory` /
// `deleteIngredientCategory`) — no duplicated CRUD.
export default function CategoriesSection() {
  const C = useCmdColors();
  const T = useT();
  const ingredientCategories  = useStore((s) => s.ingredientCategories);
  const inventory             = useStore((s) => s.inventory);
  const addIngredientCategory    = useStore((s) => s.addIngredientCategory);
  const updateIngredientCategory = useStore((s) => s.updateIngredientCategory);
  const deleteIngredientCategory = useStore((s) => s.deleteIngredientCategory);

  const [newName, setNewName]         = React.useState('');
  const [editingName, setEditingName] = React.useState<string | null>(null);
  const [editValue, setEditValue]     = React.useState('');
  const [warning, setWarning]         = React.useState('');

  // Sorted alphabetically with a count of unique catalog ingredients
  // (deduped by lowercase name) per category. inventory is per-store, so
  // a raw row-count would multiply by store count; the user-visible
  // expectation is the same "N unique" total InventoryCatalogMode shows.
  const sorted = React.useMemo(() => {
    const list = [...ingredientCategories].sort((a, b) => a.localeCompare(b));
    const seenCategoryByName = new Map<string, string>();
    for (const it of inventory) {
      const k = it.name.toLowerCase();
      if (!seenCategoryByName.has(k) && it.category) seenCategoryByName.set(k, it.category);
    }
    const counts = new Map<string, number>();
    for (const c of seenCategoryByName.values()) {
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    return list.map((name) => ({ name, count: counts.get(name) || 0 }));
  }, [ingredientCategories, inventory]);

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) return;
    if (ingredientCategories.some((c) => c.toLowerCase() === name.toLowerCase())) {
      setWarning(T('section.categories.alreadyExists', { name }));
      return;
    }
    setWarning('');
    addIngredientCategory(name);
    Toast.show({ type: 'success', text1: T('section.categories.added'), text2: name });
    setNewName('');
  };

  const startEdit = (name: string) => {
    setEditingName(name);
    setEditValue(name);
    setWarning('');
  };

  const cancelEdit = () => {
    setEditingName(null);
    setEditValue('');
  };

  const saveEdit = (oldName: string) => {
    const next = editValue.trim();
    if (!next) return;
    if (next !== oldName && ingredientCategories.some((c) => c.toLowerCase() === next.toLowerCase())) {
      setWarning(T('section.categories.alreadyExists', { name: next }));
      return;
    }
    setWarning('');
    if (next !== oldName) {
      updateIngredientCategory(oldName, next);
      Toast.show({ type: 'success', text1: T('section.categories.renamed'), text2: `${oldName} → ${next}` });
    }
    setEditingName(null);
    setEditValue('');
  };

  const handleDelete = (name: string) => {
    // Dedupe by lowercase name to match the per-row count semantics — see
    // the sorted-counts memo above for rationale.
    const inUseCount = new Set(
      inventory.filter((i) => i.category === name).map((i) => i.name.toLowerCase()),
    ).size;
    if (inUseCount > 0) {
      setWarning(T('section.categories.cannotDeleteInUse', { name, count: inUseCount }));
      Toast.show({
        type: 'error',
        text1: T('section.categories.inUseToast'),
        text2: T('section.categories.inUseToastBody', { name, count: inUseCount }),
      });
      return;
    }
    confirmAction(
      T('section.categories.deleteConfirmTitle', { name }),
      T('section.categories.deleteConfirmBody'),
      () => {
        deleteIngredientCategory(name);
        Toast.show({ type: 'success', text1: T('section.categories.deleted'), text2: name });
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0, minWidth: 0 }}>
      {/* Top bar */}
      <View
        style={{
          paddingHorizontal: 22, paddingTop: 14, paddingBottom: 10,
          borderBottomWidth: 1, borderBottomColor: C.border,
          flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
          backgroundColor: C.panel,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
          <Text style={[Type.h2, { color: C.fg }]}>{T('section.categories.ingredientCategories')}</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {T('section.categories.active', { count: sorted.length })}
          </Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            {T('section.categories.description')}
          </Text>
        </View>

        {/* Add new category card */}
        <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 10 }}>
          <SectionCaption tone="fg3" size={10.5}>{T('section.categories.newCategoryCaption')}</SectionCaption>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder={T('section.categories.namePlaceholder')}
              placeholderTextColor={C.fg3}
              onSubmitEditing={handleAdd}
              style={{
                flex: 1, height: 32, paddingHorizontal: 10,
                fontFamily: sans(500), fontSize: 13, color: C.fg,
                backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
              }}
            />
            <TouchableOpacity
              onPress={handleAdd}
              disabled={!newName.trim()}
              style={{
                paddingVertical: 7, paddingHorizontal: 14,
                backgroundColor: newName.trim() ? C.accent : C.panel2,
                borderRadius: CmdRadius.sm,
                opacity: newName.trim() ? 1 : 0.55,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: newName.trim() ? '#000' : C.fg3 }}>{T('section.categories.newCategoryButton')}</Text>
            </TouchableOpacity>
          </View>
          {warning ? (
            <View style={{ paddingVertical: 6, paddingHorizontal: 10, backgroundColor: C.warnBg, borderWidth: 1, borderColor: C.warn, borderRadius: CmdRadius.sm }}>
              <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.warn }}>{warning}</Text>
            </View>
          ) : null}
        </View>

        {/* Categories list */}
        <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <SectionCaption tone="fg3" size={10.5}>categories.tsv</SectionCaption>
            <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.categories.rowsCount', { count: sorted.length })}</Text>
          </View>
          {sorted.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {T('section.categories.emptyState')}
            </Text>
          ) : (
            sorted.map(({ name, count }, i) => {
              const isEditing = editingName === name;
              return (
                <View
                  key={name}
                  style={{
                    flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10,
                    borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed',
                  }}
                >
                  {isEditing ? (
                    <TextInput
                      value={editValue}
                      onChangeText={setEditValue}
                      onSubmitEditing={() => saveEdit(name)}
                      autoFocus
                      style={{
                        flex: 1, height: 28, paddingHorizontal: 8,
                        fontFamily: sans(500), fontSize: 13, color: C.fg,
                        backgroundColor: C.panel2, borderWidth: 1, borderColor: C.accent, borderRadius: CmdRadius.sm,
                        ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                      }}
                    />
                  ) : (
                    <Text style={{ flex: 1, fontFamily: sans(600), fontSize: 13, color: C.fg }}>{name}</Text>
                  )}
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, width: 100, textAlign: 'right' }}>
                    {T('section.categories.items', { count })}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, width: 130, justifyContent: 'flex-end' }}>
                    {isEditing ? (
                      <>
                        <TouchableOpacity onPress={() => saveEdit(name)} style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
                          <Text style={{ fontFamily: mono(700), fontSize: 10, color: '#000' }}>{T('section.categories.saveButton')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={cancelEdit} style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm }}>
                          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>{T('section.categories.cancelButton')}</Text>
                        </TouchableOpacity>
                      </>
                    ) : (
                      <>
                        <TouchableOpacity onPress={() => startEdit(name)} style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>{T('section.categories.editButton')}</Text>
                        </TouchableOpacity>
                        {/* DELETE is always enabled; the in-use check happens
                            inside `handleDelete` and surfaces a Toast +
                            inline warning if blocked. Keeping the button
                            clickable preserves the "why can't I delete?"
                            affordance — spec 004 fix-pass item 2. */}
                        <TouchableOpacity
                          onPress={() => handleDelete(name)}
                          style={{
                            paddingVertical: 4, paddingHorizontal: 10,
                            borderWidth: 1, borderColor: C.danger,
                            borderRadius: CmdRadius.sm,
                          }}
                        >
                          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.danger }}>{T('section.categories.deleteButton')}</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

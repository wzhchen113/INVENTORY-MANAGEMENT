import React from 'react';
import { View, Text, TouchableOpacity, Modal, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { Recipe, RecipeIngredient, RecipePrepItem, LocalizedNames } from '../../types';
import { SelectField } from './SelectField';
import { CANONICAL_UNITS } from '../../utils/unitConversion';
import { useT } from '../../hooks/useT';
import { unitLabel } from '../../utils/enumLabels';
import { translateOnSave } from '../../lib/translate';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// Unit dropdown options for a recipe ingredient row.
// Always includes all canonical mass/volume units. When the row has a
// picked item, also includes the item's tracked unit (so abstract units
// like 'cases', 'bags', 'each' remain selectable for items packed that
// way). Surfacing the current value as well — even if non-canonical and
// not on any item — protects legacy data from getting silently nulled
// out by the dropdown's value filter.
function buildUnitOptions(itemUnit: string | undefined, currentValue: string, T: TFn) {
  const acc = new Set<string>(CANONICAL_UNITS);
  if (itemUnit) acc.add(itemUnit);
  if (currentValue) acc.add(currentValue);
  return Array.from(acc).map((u) => ({ value: u, label: unitLabel(u, T) }));
}

type Mode = 'edit' | 'new' | 'duplicate';

interface Props {
  visible: boolean;
  mode: Mode;
  recipe?: Recipe;
  onClose: () => void;
}

interface Row {
  itemId: string;
  itemName: string;
  quantity: string;
  unit: string;
}

interface FormValues {
  menuItem: string;
  category: string;
  sellPrice: string;
  ingredients: Row[];
  prepItems: Row[];
  // Spec 040 P3 — translation override fields. Mirrors IngredientForm's
  // nameEs / nameZh shape.
  menuItemEs: string;
  menuItemZh: string;
}

const blank = (): FormValues => ({
  menuItem: '',
  category: '',
  sellPrice: '',
  ingredients: [],
  prepItems: [],
  menuItemEs: '',
  menuItemZh: '',
});

const fromRecipe = (r: Recipe, suffix = ''): FormValues => ({
  menuItem: r.menuItem + suffix,
  category: r.category || '',
  sellPrice: String(r.sellPrice ?? 0),
  ingredients: (r.ingredients || []).map((i) => ({
    itemId: i.itemId, itemName: i.itemName, quantity: String(i.quantity), unit: i.unit,
  })),
  prepItems: (r.prepItems || []).map((p) => ({
    itemId: p.prepRecipeId, itemName: p.prepRecipeName, quantity: String(p.quantity), unit: p.unit,
  })),
  menuItemEs: r.i18nNames?.es ?? '',
  menuItemZh: r.i18nNames?.['zh-CN'] ?? '',
});

// Lightweight typeahead: TextInput + dropdown of up to 6 matching options.
// Hidden when empty / no focus / no text.
function PickerField({
  label, hint, value, onChange, onPick, options,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  onPick: (id: string, name: string, defaultUnit?: string) => void;
  options: { id: string; name: string; unit?: string }[];
}) {
  const C = useCmdColors();
  const [focused, setFocused] = React.useState(false);
  const matches = React.useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    return options.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 6);
  }, [value, options]);
  const open = focused && matches.length > 0;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</Text>
        {hint ? <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>· {hint}</Text> : null}
      </View>
      <TextInput
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        placeholder="search…"
        placeholderTextColor={C.fg3}
        style={{
          fontFamily: sans(400), fontSize: 13, color: C.fg, backgroundColor: C.panel2,
          borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
          paddingHorizontal: 10, paddingVertical: 7, marginTop: 4,
          ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
        }}
      />
      {open ? (
        <View style={{ position: 'absolute', top: 56, left: 0, right: 0, zIndex: 5, backgroundColor: C.panel, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm, ...(Platform.OS === 'web' ? ({ boxShadow: '0 6px 20px rgba(0,0,0,0.18)' } as any) : {}) }}>
          {matches.map((m) => (
            <TouchableOpacity key={m.id} onPress={() => onPick(m.id, m.name, m.unit)} style={{ paddingHorizontal: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg }}>{m.name}</Text>
              {m.unit ? <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>per {m.unit}</Text> : null}
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function NumField({ value, onChange, placeholder, width = 70 }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number }) {
  const C = useCmdColors();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={C.fg3}
      keyboardType="decimal-pad"
      style={{ width, fontFamily: mono(400), fontSize: 13, color: C.fg, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm, paddingHorizontal: 8, paddingVertical: 7, textAlign: 'right', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) }}
    />
  );
}

function TextField({ value, onChange, placeholder, width }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number }) {
  const C = useCmdColors();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={C.fg3}
      style={{ width, flex: width ? undefined : 1, fontFamily: sans(400), fontSize: 13, color: C.fg, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm, paddingHorizontal: 10, paddingVertical: 7, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) }}
    />
  );
}

// ─── RecipeFormDrawer ──────────────────────────────────────────
// 760w right-anchored drawer. Header (NEW/EDIT pill + name + status) +
// body (header fields + ingredients editor + prep items editor) +
// footer (DISCARD / SAVE).
export const RecipeFormDrawer: React.FC<Props> = ({ visible, mode, recipe, onClose }) => {
  const C = useCmdColors();
  const T = useT();
  const addRecipe = useStore((s) => s.addRecipe);
  const updateRecipe = useStore((s) => s.updateRecipe);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const prepRecipes = useStore((s) => s.prepRecipes);
  const recipeCategories = useStore((s) => s.recipeCategories || []);
  // Spec 040 P3 — no `setRecipeI18nNames` here. `updateRecipe` already
  // includes i18nNames in its payload; a side-channel PATCH would be
  // redundant. See handleSave below.

  // Spec 040 P3 — debounced translate-on-save trigger for menu_item.
  const abortRef = React.useRef<AbortController | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [translating, setTranslating] = React.useState(false);

  // Catalog options come from current store's inventory (catalog id is the FK).
  const catalogOptions = React.useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; name: string; unit: string }[] = [];
    for (const it of inventory) {
      if (it.storeId !== currentStore.id) continue;
      const cid = (it as any).catalogId || it.id;
      if (seen.has(cid)) continue;
      seen.add(cid);
      out.push({ id: cid, name: it.name, unit: it.unit });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [inventory, currentStore.id]);

  const prepOptions = React.useMemo(
    () => prepRecipes.filter((p) => p.isCurrent !== false).map((p) => ({ id: p.id, name: p.name, unit: p.yieldUnit })),
    [prepRecipes],
  );

  const initial = React.useMemo<FormValues>(() => {
    if (mode === 'edit' && recipe) return fromRecipe(recipe);
    if (mode === 'duplicate' && recipe) return fromRecipe(recipe, ' (copy)');
    return blank();
  }, [mode, recipe]);
  const [values, setValues] = React.useState<FormValues>(initial);

  React.useEffect(() => {
    if (visible) setValues(initial);
  }, [visible, initial]);

  // Spec 040 P3 — auto-fill helpers. Refs to avoid stale closures inside
  // the debounce callback; abort in-flight requests on unmount or new
  // keystroke.
  const valuesRef = React.useRef(values);
  React.useEffect(() => { valuesRef.current = values; }, [values]);
  React.useEffect(() => () => {
    abortRef.current?.abort();
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const runTranslate = React.useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setTranslating(true);
    try {
      // Pass ctrl.signal so a fresh keystroke aborts the in-flight fetch
      // instead of just discarding its result (saves DeepL quota).
      const { data, error } = await translateOnSave(trimmed, ['es', 'zh-CN'], ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (error || !data) return;
      setValues((p) => {
        const next = { ...p };
        const es = data.translations?.es;
        const zh = data.translations?.['zh-CN'];
        if (typeof es === 'string' && es.trim().length > 0) next.menuItemEs = es;
        if (typeof zh === 'string' && zh.trim().length > 0) next.menuItemZh = zh;
        return next;
      });
    } finally {
      if (!ctrl.signal.aborted) setTranslating(false);
    }
  }, []);

  const scheduleTranslate = (text: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { runTranslate(text); }, 600);
  };
  const handleMenuItemBlur = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    runTranslate(valuesRef.current.menuItem);
  };

  const dirty = React.useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  const requiredValid = values.menuItem.trim().length > 0;

  const setVal = (k: keyof FormValues) => (v: any) => setValues((p) => ({ ...p, [k]: v }));

  const updateRow = (k: 'ingredients' | 'prepItems', idx: number, patch: Partial<Row>) => {
    setValues((p) => ({ ...p, [k]: p[k].map((r, i) => (i === idx ? { ...r, ...patch } : r)) }));
  };
  const removeRow = (k: 'ingredients' | 'prepItems', idx: number) => {
    setValues((p) => ({ ...p, [k]: p[k].filter((_, i) => i !== idx) }));
  };
  const addRow = (k: 'ingredients' | 'prepItems') => {
    setValues((p) => ({ ...p, [k]: [...p[k], { itemId: '', itemName: '', quantity: '', unit: '' }] }));
  };

  const handleSave = () => {
    if (!requiredValid) {
      Toast.show({ type: 'error', text1: 'Menu item name is required' });
      return;
    }
    const ingredients: RecipeIngredient[] = values.ingredients
      .filter((r) => r.itemId && r.itemName)
      .map((r) => ({ itemId: r.itemId, itemName: r.itemName, quantity: parseFloat(r.quantity) || 0, unit: r.unit || '' }));
    const prepItems: RecipePrepItem[] = values.prepItems
      .filter((r) => r.itemId && r.itemName)
      .map((r) => ({ prepRecipeId: r.itemId, prepRecipeName: r.itemName, quantity: parseFloat(r.quantity) || 0, unit: r.unit || '' }));
    // Spec 040 P3 — build the i18n payload. Empty overrides drop out so
    // silent-English fallback applies.
    const i18n: LocalizedNames = {};
    const es = values.menuItemEs.trim();
    const zh = values.menuItemZh.trim();
    if (es) i18n.es = es;
    if (zh) i18n['zh-CN'] = zh;
    const payload = {
      menuItem: values.menuItem.trim(),
      category: values.category.trim(),
      sellPrice: parseFloat(values.sellPrice) || 0,
      ingredients,
      prepItems,
      i18nNames: i18n,
    };
    if (mode === 'edit' && recipe) {
      // `updateRecipe` already includes `i18nNames` in its payload, which the
      // recipe-update path threads into the `recipes` row. A side-channel
      // `setRecipeI18nNames` PATCH would be a redundant DB round-trip + a
      // second optimistic-update pass over the same column.
      updateRecipe(recipe.id, payload);
      Toast.show({ type: 'success', text1: 'Saved', text2: payload.menuItem });
    } else {
      addRecipe({ ...payload, brandId: '', storeId: '' } as Omit<Recipe, 'id'>);
      Toast.show({ type: 'success', text1: 'Created', text2: payload.menuItem });
    }
    onClose();
  };

  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
        handleSave();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, values, mode, recipe]);

  if (!visible) return null;

  const isNew = mode !== 'edit';
  const headerLabel = mode === 'duplicate' ? 'COPY' : mode === 'new' ? 'NEW' : 'EDIT';
  const title = isNew ? values.menuItem || 'untitled-recipe' : (recipe?.menuItem || 'recipe');
  const statusPill = isNew
    ? { label: '● unsaved', fg: C.warn, bg: C.warnBg }
    : dirty ? { label: '● modified', fg: C.warn, bg: C.warnBg } : { label: '● saved', fg: C.fg3, bg: C.panel2 };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.32)', flexDirection: 'row', justifyContent: 'flex-end' }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: 760, height: '100%', backgroundColor: C.bg, borderLeftWidth: 1, borderLeftColor: C.borderStrong, ...(Platform.OS === 'web' ? ({ boxShadow: '-12px 0 40px rgba(0,0,0,0.18)' } as any) : {}) }}>
          {/* Header */}
          <View style={{ height: 44, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel }}>
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: '#000' }}>{headerLabel}</Text>
            </View>
            <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg }}>{title}</Text>
            <View style={{ flex: 1 }} />
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: statusPill.bg }}>
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: statusPill.fg }}>{statusPill.label}</Text>
            </View>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 22, gap: 18 }}>
            {/* Header fields */}
            <View style={{ gap: 4 }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>Menu item</Text>
              <TextInput
                value={values.menuItem}
                onChangeText={(v) => { setVal('menuItem')(v); scheduleTranslate(v); }}
                onBlur={handleMenuItemBlur}
                placeholder="2AM Cheeseburger"
                placeholderTextColor={C.fg3}
                style={{
                  flex: 1, fontFamily: sans(400), fontSize: 13, color: C.fg,
                  backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border,
                  borderRadius: CmdRadius.sm, paddingHorizontal: 10, paddingVertical: 7,
                  ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                }}
              />
            </View>
            {/* Spec 040 P3 — translation override fields. */}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  Menu item · Español {translating ? '· translating…' : ''}
                </Text>
                <TextField value={values.menuItemEs} onChange={setVal('menuItemEs')} placeholder={translating ? 'translating…' : '—'} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  Menu item · 中文 {translating ? '· translating…' : ''}
                </Text>
                <TextField value={values.menuItemZh} onChange={setVal('menuItemZh')} placeholder={translating ? 'translating…' : '—'} />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 2, gap: 4 }}>
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>Category</Text>
                <TextField value={values.category} onChange={setVal('category')} placeholder={recipeCategories[0]?.name || 'Sandwiches'} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>Sell price</Text>
                <NumField value={values.sellPrice} onChange={setVal('sellPrice')} placeholder="0.00" width={120} />
              </View>
            </View>

            {/* Ingredients editor */}
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>raw ingredients</Text>
                <TouchableOpacity onPress={() => addRow('ingredients')} style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg2 }}>+ ADD</Text>
                </TouchableOpacity>
              </View>
              {values.ingredients.length === 0 ? (
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>no ingredients — click + ADD</Text>
              ) : null}
              {values.ingredients.map((r, i) => {
                const itemUnit = catalogOptions.find((o) => o.id === r.itemId)?.unit;
                return (
                  <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end', zIndex: values.ingredients.length - i }}>
                    <PickerField
                      label="Ingredient"
                      value={r.itemName}
                      onChange={(v) => updateRow('ingredients', i, { itemName: v, itemId: '' })}
                      onPick={(id, name, unit) => updateRow('ingredients', i, { itemId: id, itemName: name, unit: r.unit || unit || '' })}
                      options={catalogOptions}
                    />
                    <View>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>Qty</Text>
                      <View style={{ marginTop: 4 }}><NumField value={r.quantity} onChange={(v) => updateRow('ingredients', i, { quantity: v })} placeholder="1" /></View>
                    </View>
                    <SelectField
                      label="Unit"
                      width={80}
                      monoFont
                      value={r.unit}
                      options={buildUnitOptions(itemUnit, r.unit, T)}
                      onChange={(v) => updateRow('ingredients', i, { unit: v })}
                    />
                    <TouchableOpacity onPress={() => removeRow('ingredients', i)} style={{ paddingVertical: 7, paddingHorizontal: 10, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.danger }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.danger }}>×</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>

            {/* Prep items editor */}
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>sub-recipes / preps</Text>
                <TouchableOpacity onPress={() => addRow('prepItems')} style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg2 }}>+ ADD</Text>
                </TouchableOpacity>
              </View>
              {values.prepItems.length === 0 ? (
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>no preps — click + ADD</Text>
              ) : null}
              {values.prepItems.map((r, i) => {
                const prepYieldUnit = prepOptions.find((o) => o.id === r.itemId)?.unit;
                return (
                  <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end', zIndex: values.prepItems.length - i }}>
                    <PickerField
                      label="Prep recipe"
                      value={r.itemName}
                      onChange={(v) => updateRow('prepItems', i, { itemName: v, itemId: '' })}
                      onPick={(id, name, unit) => updateRow('prepItems', i, { itemId: id, itemName: name, unit: r.unit || unit || '' })}
                      options={prepOptions}
                    />
                    <View>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>Qty</Text>
                      <View style={{ marginTop: 4 }}><NumField value={r.quantity} onChange={(v) => updateRow('prepItems', i, { quantity: v })} placeholder="1" /></View>
                    </View>
                    <SelectField
                      label="Unit"
                      width={80}
                      monoFont
                      value={r.unit}
                      options={buildUnitOptions(prepYieldUnit, r.unit, T)}
                      onChange={(v) => updateRow('prepItems', i, { unit: v })}
                    />
                    <TouchableOpacity onPress={() => removeRow('prepItems', i)} style={{ paddingVertical: 7, paddingHorizontal: 10, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.danger }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.danger }}>×</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          </ScrollView>

          {/* Footer */}
          <View style={{ height: 54, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.panel }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {values.ingredients.length} ingredient{values.ingredients.length === 1 ? '' : 's'} · {values.prepItems.length} prep{values.prepItems.length === 1 ? '' : 's'}
            </Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={onClose} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>{isNew ? 'CANCEL' : 'DISCARD'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleSave} disabled={!requiredValid} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, backgroundColor: requiredValid ? C.accent : C.panel2, opacity: requiredValid ? 1 : 0.6 }}>
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: requiredValid ? '#000' : C.fg3 }}>
                {mode === 'edit' ? 'SAVE  ⌘S' : 'CREATE  ⌘⏎'}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

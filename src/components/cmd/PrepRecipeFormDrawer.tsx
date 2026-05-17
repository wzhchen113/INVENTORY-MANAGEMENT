import React from 'react';
import { View, Text, TouchableOpacity, Modal, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { PrepRecipe, PrepRecipeIngredient, LocalizedNames } from '../../types';
import { SelectField } from './SelectField';
import { CANONICAL_UNITS } from '../../utils/unitConversion';
import { useT } from '../../hooks/useT';
import { unitLabel } from '../../utils/enumLabels';
import { translateOnSave } from '../../lib/translate';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// Unit options for an ingredient row inside a prep recipe. Mirrors the
// recipe drawer helper — canonical units always present, plus the picked
// item / sub-recipe unit so abstract pack units (cases, bags, each) and
// non-canonical legacy values stay selectable.
function buildUnitOptions(itemUnit: string | undefined, currentValue: string, T: TFn) {
  const acc = new Set<string>(CANONICAL_UNITS);
  if (itemUnit) acc.add(itemUnit);
  if (currentValue) acc.add(currentValue);
  return Array.from(acc).map((u) => ({ value: u, label: unitLabel(u, T) }));
}

// Yield-unit options for the prep recipe itself. Restricted to canonical
// mass / volume — preps yield in g/kg/oz/lbs or fl_oz/cups/qt/gal. If the
// existing record holds a non-canonical legacy yield_unit, surface it as
// a disabled option so the user sees what's there but can't pick more.
function buildYieldUnitOptions(currentValue: string, T: TFn) {
  const opts: Array<{ value: string; label: string; disabled?: boolean }> = CANONICAL_UNITS.map((u) => ({ value: u, label: unitLabel(u, T) }));
  const cur = (currentValue || '').toLowerCase().trim();
  if (cur && !CANONICAL_UNITS.includes(cur)) {
    opts.push({ value: currentValue, label: `${unitLabel(currentValue, T)} · non-canonical`, disabled: true });
  }
  return opts;
}

type Mode = 'edit' | 'new' | 'duplicate';

interface Props {
  visible: boolean;
  mode: Mode;
  prep?: PrepRecipe;
  onClose: () => void;
}

interface Row {
  itemId: string;
  itemName: string;
  quantity: string;
  unit: string;
  type: 'raw' | 'prep';
  baseQuantity: string;
  baseUnit: string;
}

interface FormValues {
  name: string;
  category: string;
  yieldQuantity: string;
  yieldUnit: string;
  notes: string;
  ingredients: Row[];
  // Spec 040 P3 — translation overrides for `name`.
  nameEs: string;
  nameZh: string;
}

const blank = (): FormValues => ({
  name: '',
  category: '',
  yieldQuantity: '1',
  yieldUnit: 'lb',
  notes: '',
  ingredients: [],
  nameEs: '',
  nameZh: '',
});

const fromPrep = (p: PrepRecipe, suffix = ''): FormValues => ({
  name: p.name + suffix,
  category: p.category || '',
  yieldQuantity: String(p.yieldQuantity ?? 1),
  yieldUnit: p.yieldUnit || '',
  notes: p.notes || '',
  ingredients: (p.ingredients || []).map((i) => ({
    itemId: i.itemId,
    itemName: i.itemName,
    quantity: String(i.quantity),
    unit: i.unit,
    type: i.type === 'prep' ? 'prep' : 'raw',
    baseQuantity: String(i.baseQuantity ?? 0),
    baseUnit: i.baseUnit || 'g',
  })),
  nameEs: p.i18nNames?.es ?? '',
  nameZh: p.i18nNames?.['zh-CN'] ?? '',
});

function PickerField({
  label, value, onChange, onPick, options,
}: {
  label: string;
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
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        placeholder="search…"
        placeholderTextColor={C.fg3}
        style={{ fontFamily: sans(400), fontSize: 13, color: C.fg, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm, paddingHorizontal: 10, paddingVertical: 7, marginTop: 4, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) }}
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
    <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.fg3} keyboardType="decimal-pad"
      style={{ width, fontFamily: mono(400), fontSize: 13, color: C.fg, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm, paddingHorizontal: 8, paddingVertical: 7, textAlign: 'right', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) }} />
  );
}

function TextField({ value, onChange, placeholder, width }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number }) {
  const C = useCmdColors();
  return (
    <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.fg3}
      style={{ width, flex: width ? undefined : 1, fontFamily: sans(400), fontSize: 13, color: C.fg, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm, paddingHorizontal: 10, paddingVertical: 7, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) }} />
  );
}

// ─── PrepRecipeFormDrawer ──────────────────────────────────────
// 760w right-anchored drawer. Same shape as RecipeFormDrawer but with
// raw/prep-type ingredient rows and yield fields instead of sell price.
export const PrepRecipeFormDrawer: React.FC<Props> = ({ visible, mode, prep, onClose }) => {
  const C = useCmdColors();
  const T = useT();
  const addPrepRecipe = useStore((s) => s.addPrepRecipe);
  const updatePrepRecipe = useStore((s) => s.updatePrepRecipe);
  // Spec 040 P3 — no `setPrepRecipeI18nNames` here. `updatePrepRecipe` ships
  // i18nNames in its payload via the versioned-write path; a side-channel
  // PATCH would target the archived stale row id. See handleSave below.
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const prepRecipes = useStore((s) => s.prepRecipes);

  // Spec 040 P3 — debounced translate-on-save trigger for `name`.
  const abortRef = React.useRef<AbortController | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [translating, setTranslating] = React.useState(false);

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

  // For sub-recipes: exclude the prep being edited so it can't reference itself.
  const prepOptions = React.useMemo(
    () => prepRecipes
      .filter((p) => p.isCurrent !== false && p.id !== prep?.id)
      .map((p) => ({ id: p.id, name: p.name, unit: p.yieldUnit })),
    [prepRecipes, prep?.id],
  );

  const initial = React.useMemo<FormValues>(() => {
    if (mode === 'edit' && prep) return fromPrep(prep);
    if (mode === 'duplicate' && prep) return fromPrep(prep, ' (copy)');
    return blank();
  }, [mode, prep]);
  const [values, setValues] = React.useState<FormValues>(initial);

  React.useEffect(() => {
    if (visible) setValues(initial);
  }, [visible, initial]);

  // Spec 040 P3 — auto-fill helpers.
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
        if (typeof es === 'string' && es.trim().length > 0) next.nameEs = es;
        if (typeof zh === 'string' && zh.trim().length > 0) next.nameZh = zh;
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
  const handleNameBlur = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    runTranslate(valuesRef.current.name);
  };

  const dirty = React.useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  const requiredValid = values.name.trim().length > 0 && values.yieldUnit.trim().length > 0;

  const setVal = (k: keyof FormValues) => (v: any) => setValues((p) => ({ ...p, [k]: v }));

  const updateRow = (idx: number, patch: Partial<Row>) =>
    setValues((p) => ({ ...p, ingredients: p.ingredients.map((r, i) => (i === idx ? { ...r, ...patch } : r)) }));
  const removeRow = (idx: number) =>
    setValues((p) => ({ ...p, ingredients: p.ingredients.filter((_, i) => i !== idx) }));
  const addRow = (type: 'raw' | 'prep') =>
    setValues((p) => ({
      ...p,
      ingredients: [...p.ingredients, { itemId: '', itemName: '', quantity: '', unit: '', type, baseQuantity: '0', baseUnit: 'g' }],
    }));

  const handleSave = () => {
    if (!requiredValid) {
      Toast.show({ type: 'error', text1: 'Name and yield unit are required' });
      return;
    }
    const ingredients: PrepRecipeIngredient[] = values.ingredients
      .filter((r) => r.itemId && r.itemName)
      .map((r) => ({
        itemId: r.itemId,
        itemName: r.itemName,
        quantity: parseFloat(r.quantity) || 0,
        unit: r.unit || '',
        baseQuantity: parseFloat(r.baseQuantity) || 0,
        baseUnit: r.baseUnit || 'g',
        type: r.type,
      }));
    // Spec 040 P3 — i18n payload.
    const i18n: LocalizedNames = {};
    const es = values.nameEs.trim();
    const zh = values.nameZh.trim();
    if (es) i18n.es = es;
    if (zh) i18n['zh-CN'] = zh;
    const payload = {
      name: values.name.trim(),
      category: values.category.trim(),
      yieldQuantity: parseFloat(values.yieldQuantity) || 1,
      yieldUnit: values.yieldUnit.trim(),
      notes: values.notes.trim(),
      ingredients,
      i18nNames: i18n,
    };
    if (mode === 'edit' && prep) {
      // `updatePrepRecipe` routes through `db.updatePrepRecipeVersioned`, which
      // creates a NEW version row carrying the entire payload (including
      // `i18nNames`). The old `setPrepRecipeI18nNames(prep.id, i18n)` follow-up
      // would target the now-archived stale row id — ghost write. The new
      // version already has the translations from `payload.i18nNames`, so no
      // side-channel PATCH is needed.
      updatePrepRecipe(prep.id, payload);
      Toast.show({ type: 'success', text1: 'Saved', text2: payload.name });
    } else {
      addPrepRecipe({
        ...payload,
        brandId: '',
        storeId: '',
        createdBy: '',
        createdAt: new Date().toISOString(),
        version: 1,
        isCurrent: true,
      } as Omit<PrepRecipe, 'id'>);
      Toast.show({ type: 'success', text1: 'Created', text2: payload.name });
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
  }, [visible, values, mode, prep]);

  if (!visible) return null;

  const isNew = mode !== 'edit';
  const headerLabel = mode === 'duplicate' ? 'COPY' : mode === 'new' ? 'NEW' : 'EDIT';
  const title = isNew ? values.name || 'untitled-prep' : (prep?.name || 'prep');
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
            <View style={{ gap: 4 }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>Name</Text>
              <TextInput
                value={values.name}
                onChangeText={(v) => { setVal('name')(v); scheduleTranslate(v); }}
                onBlur={handleNameBlur}
                placeholder="2AM Sauce"
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
                  Name · Español {translating ? '· translating…' : ''}
                </Text>
                <TextField value={values.nameEs} onChange={setVal('nameEs')} placeholder={translating ? 'translating…' : '—'} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  Name · 中文 {translating ? '· translating…' : ''}
                </Text>
                <TextField value={values.nameZh} onChange={setVal('nameZh')} placeholder={translating ? 'translating…' : '—'} />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 2, gap: 4 }}>
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>Category</Text>
                <TextField value={values.category} onChange={setVal('category')} placeholder="Sauces" />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>Yield qty</Text>
                <NumField width={120} value={values.yieldQuantity} onChange={setVal('yieldQuantity')} placeholder="1" />
              </View>
              <View style={{ flex: 1 }}>
                <SelectField
                  label="Yield unit"
                  monoFont
                  value={values.yieldUnit}
                  options={buildYieldUnitOptions(values.yieldUnit, T)}
                  onChange={setVal('yieldUnit')}
                />
              </View>
            </View>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, marginTop: -10 }}>
              Cooked / drained net yield. Cost-per-unit divides total batch cost by this. e.g. 2kg meat + 500g marinade → enter 1.5 kg cooked.
            </Text>
            <View style={{ gap: 4 }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>Notes</Text>
              <TextField value={values.notes} onChange={setVal('notes')} placeholder="optional" />
            </View>

            {/* Ingredients editor */}
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>ingredients</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TouchableOpacity onPress={() => addRow('raw')} style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg2 }}>+ RAW</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => addRow('prep')} style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg2 }}>+ PREP</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {values.ingredients.length === 0 ? (
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>no ingredients — click + RAW or + PREP</Text>
              ) : null}
              {values.ingredients.map((r, i) => {
                const sourceList = r.type === 'prep' ? prepOptions : catalogOptions;
                const itemUnit = sourceList.find((o) => o.id === r.itemId)?.unit;
                return (
                  <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end', zIndex: values.ingredients.length - i }}>
                    <View style={{ width: 44, paddingTop: 18 }}>
                      <View style={{ paddingVertical: 5, paddingHorizontal: 6, backgroundColor: r.type === 'prep' ? C.accentBg : C.panel2, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: r.type === 'prep' ? C.accent : C.border, alignItems: 'center' }}>
                        <Text style={{ fontFamily: mono(700), fontSize: 9, color: r.type === 'prep' ? C.accent : C.fg3 }}>{r.type === 'prep' ? 'PREP' : 'RAW'}</Text>
                      </View>
                    </View>
                    <PickerField
                      label="Item"
                      value={r.itemName}
                      onChange={(v) => updateRow(i, { itemName: v, itemId: '' })}
                      onPick={(id, name, unit) => updateRow(i, { itemId: id, itemName: name, unit: r.unit || unit || '' })}
                      options={sourceList}
                    />
                    <View>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>Qty</Text>
                      <View style={{ marginTop: 4 }}><NumField value={r.quantity} onChange={(v) => updateRow(i, { quantity: v })} placeholder="1" /></View>
                    </View>
                    <SelectField
                      label="Unit"
                      width={80}
                      monoFont
                      value={r.unit}
                      options={buildUnitOptions(itemUnit, r.unit, T)}
                      onChange={(v) => updateRow(i, { unit: v })}
                    />
                    <TouchableOpacity onPress={() => removeRow(i)} style={{ paddingVertical: 7, paddingHorizontal: 10, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.danger }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.danger }}>×</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          </ScrollView>

          <View style={{ height: 54, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.panel }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {values.ingredients.length} ingredient{values.ingredients.length === 1 ? '' : 's'}
              {mode === 'edit' && prep ? ` · v${prep.version || 1}` : ''}
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

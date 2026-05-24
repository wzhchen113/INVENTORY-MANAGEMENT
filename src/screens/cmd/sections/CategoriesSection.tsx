import React from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { confirmAction } from '../../../utils/confirmAction';
import { useT } from '../../../hooks/useT';
import { useLocale } from '../../../hooks/useLocale';
import { getLocalizedName } from '../../../i18n/localizedName';
import { translateOnSave } from '../../../lib/translate';
import type { LocalizedNames } from '../../../types';

// Cmd-styled admin section for `ingredient_categories` (global, no
// brand-scoping today). Modeled on the legacy `IngredientsScreen.tsx`
// `showCatModal` flow but adapted to the Cmd UI list/form rhythm of the
// existing `VendorsSection`. Reuses the existing store actions
// (`addIngredientCategory` / `updateIngredientCategory` /
// `deleteIngredientCategory`) — no duplicated CRUD.
export default function CategoriesSection() {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const ingredientCategories  = useStore((s) => s.ingredientCategories);
  const inventory             = useStore((s) => s.inventory);
  const addIngredientCategory    = useStore((s) => s.addIngredientCategory);
  const updateIngredientCategory = useStore((s) => s.updateIngredientCategory);
  const deleteIngredientCategory = useStore((s) => s.deleteIngredientCategory);

  const [newName, setNewName]         = React.useState('');
  // Spec 040 P3 — translation override inputs for + ADD flow.
  const [newEs, setNewEs]             = React.useState('');
  const [newZh, setNewZh]             = React.useState('');
  const [newTranslating, setNewTranslating] = React.useState(false);
  // editingName is the English canonical (still the join key). editI18n
  // tracks per-locale overrides while editing; reset on cancel/save.
  const [editingName, setEditingName] = React.useState<string | null>(null);
  const [editValue, setEditValue]     = React.useState('');
  const [editI18n, setEditI18n]       = React.useState<LocalizedNames>({});
  const [editTranslating, setEditTranslating] = React.useState(false);
  const [warning, setWarning]         = React.useState('');

  // Sorted by current-locale name with a count of unique catalog
  // ingredients (deduped by lowercase name) per category. inventory is
  // per-store, so a raw row-count would multiply by store count; the
  // user-visible expectation is the same "N unique" total
  // InventoryCatalogMode shows.
  const sorted = React.useMemo(() => {
    const seenCategoryByName = new Map<string, string>();
    for (const it of inventory) {
      const k = it.name.toLowerCase();
      if (!seenCategoryByName.has(k) && it.category) seenCategoryByName.set(k, it.category);
    }
    const counts = new Map<string, number>();
    for (const c of seenCategoryByName.values()) {
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    return [...ingredientCategories]
      .map((c) => ({
        ...c,
        count: counts.get(c.name) || 0,
        label: getLocalizedName({ name: c.name, i18nNames: c.i18nNames }, locale),
      }))
      // Spec 040 P3 / Q5 — sort by current-locale label using
      // localeCompare. zh-CN falls back to codepoint order without ICU
      // (documented Known Limitation in spec §Risks).
      .sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [ingredientCategories, inventory, locale]);

  // Spec 040 P3 — hybrid debounce / blur trigger for the + ADD form's
  // auto-fill. Fires on blur OR 600ms idle, whichever comes first; uses
  // AbortController so a keystroke during fetch cancels the in-flight
  // request and re-issues with the latest text.
  const newAbortRef = React.useRef<AbortController | null>(null);
  const newTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const editAbortRef = React.useRef<AbortController | null>(null);
  const editTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    newAbortRef.current?.abort();
    editAbortRef.current?.abort();
    if (newTimerRef.current) clearTimeout(newTimerRef.current);
    if (editTimerRef.current) clearTimeout(editTimerRef.current);
  }, []);

  const fetchTranslations = React.useCallback(
    async (
      text: string,
      ref: React.MutableRefObject<AbortController | null>,
      setEs: (v: string) => void,
      setZh: (v: string) => void,
      setBusy: (v: boolean) => void,
    ) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      ref.current?.abort();
      const ctrl = new AbortController();
      ref.current = ctrl;
      setBusy(true);
      try {
        // Pass ctrl.signal so a fresh keystroke aborts the in-flight fetch
        // instead of just discarding its result (saves DeepL quota).
        const { data, error } = await translateOnSave(trimmed, ['es', 'zh-CN'], ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (error || !data) {
          // Graceful degrade — leave override fields blank/editable so the
          // user can fill them in manually. notifyBackendError is too noisy
          // for an auto-fill best-effort.
          return;
        }
        const es = data.translations?.es;
        const zh = data.translations?.['zh-CN'];
        if (typeof es === 'string' && es.trim().length > 0) setEs(es);
        if (typeof zh === 'string' && zh.trim().length > 0) setZh(zh);
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    },
    [],
  );

  const scheduleNewTranslate = (text: string) => {
    if (newTimerRef.current) clearTimeout(newTimerRef.current);
    newTimerRef.current = setTimeout(() => {
      fetchTranslations(text, newAbortRef, setNewEs, setNewZh, setNewTranslating);
    }, 600);
  };

  const handleNewBlur = () => {
    if (newTimerRef.current) clearTimeout(newTimerRef.current);
    fetchTranslations(newName, newAbortRef, setNewEs, setNewZh, setNewTranslating);
  };

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) return;
    if (ingredientCategories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      setWarning(T('section.categories.alreadyExists', { name }));
      return;
    }
    setWarning('');
    const i18n: LocalizedNames = {};
    if (newEs.trim()) i18n.es = newEs.trim();
    if (newZh.trim()) i18n['zh-CN'] = newZh.trim();
    addIngredientCategory(name, i18n);
    Toast.show({ type: 'success', text1: T('section.categories.added'), text2: name });
    setNewName('');
    setNewEs('');
    setNewZh('');
  };

  const startEdit = (cat: { name: string; i18nNames: LocalizedNames }) => {
    setEditingName(cat.name);
    setEditValue(cat.name);
    setEditI18n({ ...cat.i18nNames });
    setWarning('');
  };

  const cancelEdit = () => {
    setEditingName(null);
    setEditValue('');
    setEditI18n({});
  };

  const scheduleEditTranslate = (text: string) => {
    if (editTimerRef.current) clearTimeout(editTimerRef.current);
    editTimerRef.current = setTimeout(() => {
      fetchTranslations(
        text,
        editAbortRef,
        (v) => setEditI18n((p) => ({ ...p, es: v })),
        (v) => setEditI18n((p) => ({ ...p, 'zh-CN': v })),
        setEditTranslating,
      );
    }, 600);
  };

  const handleEditBlur = () => {
    if (editTimerRef.current) clearTimeout(editTimerRef.current);
    fetchTranslations(
      editValue,
      editAbortRef,
      (v) => setEditI18n((p) => ({ ...p, es: v })),
      (v) => setEditI18n((p) => ({ ...p, 'zh-CN': v })),
      setEditTranslating,
    );
  };

  const saveEdit = (oldName: string) => {
    const next = editValue.trim();
    if (!next) return;
    if (
      next !== oldName &&
      ingredientCategories.some((c) => c.name.toLowerCase() === next.toLowerCase())
    ) {
      setWarning(T('section.categories.alreadyExists', { name: next }));
      return;
    }
    setWarning('');
    const i18n: LocalizedNames = {};
    const es = (editI18n.es ?? '').trim();
    const zh = (editI18n['zh-CN'] ?? '').trim();
    if (es) i18n.es = es;
    if (zh) i18n['zh-CN'] = zh;
    if (next !== oldName) {
      updateIngredientCategory(oldName, next, i18n);
      Toast.show({ type: 'success', text1: T('section.categories.renamed'), text2: `${oldName} → ${next}` });
    } else {
      // Same name, just update translations.
      useStore.getState().setIngredientCategoryI18nNames(oldName, i18n);
      Toast.show({ type: 'success', text1: T('section.categories.renamed'), text2: oldName });
    }
    setEditingName(null);
    setEditValue('');
    setEditI18n({});
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
      'Delete',
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
              onChangeText={(v) => { setNewName(v); scheduleNewTranslate(v); }}
              onBlur={handleNewBlur}
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
          {/* Spec 040 P3 — auto-fill / manual override fields for ES + zh-CN.
              Shown whenever the English name has any content so the user
              can preview / correct the suggestion before clicking ADD. */}
          {newName.trim() ? (
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ width: 90, fontFamily: mono(500), fontSize: 10.5, color: C.fg3 }}>Español</Text>
                <TextInput
                  value={newEs}
                  onChangeText={setNewEs}
                  placeholder={newTranslating ? 'translating…' : '—'}
                  placeholderTextColor={C.fg3}
                  style={{
                    flex: 1, height: 28, paddingHorizontal: 8,
                    fontFamily: sans(500), fontSize: 12, color: C.fg,
                    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                  }}
                />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ width: 90, fontFamily: mono(500), fontSize: 10.5, color: C.fg3 }}>中文 (简体)</Text>
                <TextInput
                  value={newZh}
                  onChangeText={setNewZh}
                  placeholder={newTranslating ? 'translating…' : '—'}
                  placeholderTextColor={C.fg3}
                  style={{
                    flex: 1, height: 28, paddingHorizontal: 8,
                    fontFamily: sans(500), fontSize: 12, color: C.fg,
                    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                  }}
                />
              </View>
            </View>
          ) : null}
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
            sorted.map(({ name, count, label }, i) => {
              const isEditing = editingName === name;
              return (
                <View
                  key={name}
                  style={{
                    flexDirection: 'column', paddingVertical: 9, paddingHorizontal: 14, gap: 6,
                    borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed',
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    {isEditing ? (
                      <TextInput
                        value={editValue}
                        onChangeText={(v) => { setEditValue(v); scheduleEditTranslate(v); }}
                        onBlur={handleEditBlur}
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
                      <Text style={{ flex: 1, fontFamily: sans(600), fontSize: 13, color: C.fg }}>{label}</Text>
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
                          <TouchableOpacity onPress={() => startEdit({ name, i18nNames: ingredientCategories.find((c) => c.name === name)?.i18nNames || {} })} style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
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
                  {/* Spec 040 P3 — translation override fields shown only
                      while editing. The English row above is the canonical;
                      these two fields are pure display overrides. */}
                  {isEditing ? (
                    <View style={{ gap: 4, paddingLeft: 10 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Text style={{ width: 90, fontFamily: mono(500), fontSize: 10.5, color: C.fg3 }}>Español</Text>
                        <TextInput
                          value={editI18n.es ?? ''}
                          onChangeText={(v) => setEditI18n((p) => ({ ...p, es: v }))}
                          placeholder={editTranslating ? 'translating…' : '—'}
                          placeholderTextColor={C.fg3}
                          style={{
                            flex: 1, height: 26, paddingHorizontal: 8,
                            fontFamily: sans(500), fontSize: 12, color: C.fg,
                            backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                          }}
                        />
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Text style={{ width: 90, fontFamily: mono(500), fontSize: 10.5, color: C.fg3 }}>中文 (简体)</Text>
                        <TextInput
                          value={editI18n['zh-CN'] ?? ''}
                          onChangeText={(v) => setEditI18n((p) => ({ ...p, 'zh-CN': v }))}
                          placeholder={editTranslating ? 'translating…' : '—'}
                          placeholderTextColor={C.fg3}
                          style={{
                            flex: 1, height: 26, paddingHorizontal: 8,
                            fontFamily: sans(500), fontSize: 12, color: C.fg,
                            backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                          }}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}
